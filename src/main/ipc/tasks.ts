import { BrowserWindow, ipcMain } from 'electron'
import { validateMove } from '../../shared/taskflow'
import { aggregateUsage } from '../usage'
import { deleteReportCopies, fileDiff, fileDiffFailure, removeWorktree, resolveRepositoryRoot } from '../git'
import { parseContent, parseFollowUpOptions, parseId, parseNonNegativeInteger, parsePermissionDecision, parseRepoRelativePath, parseTaskCreate, parseTaskStatus } from '../ipc-validation'
import type { IpcContext } from './context'
import type { Task } from '../../shared/types'
import { sameExecutionOwner } from '../store'
import { prepareManualTaskStart, taskIdentity } from '../handoff'

export function registerTaskIpc(ctx: IpcContext) {
  const send = (channel: string, payload: unknown) => ctx.getWindow()?.webContents.send(channel, payload)
  const projectTasks = () => {
    try {
      // Projection is an outbox-like side effect of the committed Task. Keep
      // the compatibility fallback for lightweight IPC fixtures, but never
      // let a projection failure change the IPC result or suppress broadcasts.
      const issueStore = ctx.issueStore as typeof ctx.issueStore & { syncEventually?: (tasks: Task[]) => void }
      if (typeof issueStore.syncEventually === 'function') issueStore.syncEventually(ctx.store.list())
      else issueStore.sync(ctx.store.list())
    } catch (error) {
      console.error('[Task IPC] Issue projection pending; committed Task retained', error)
    }
  }
  const syncTask = (taskId: string) => {
    const task = ctx.store.get(taskId)
    if (!task) return
    ctx.publishIssueUpdate(task)
    send('task:updated', task)
  }

  ipcMain.handle('tasks:list', () => ctx.store.list())
  ipcMain.handle('tasks:get', (_e, id: unknown) => ctx.store.get(parseId(id)) ?? null)
  ipcMain.handle('tasks:events', async (_e, id: unknown, afterSeq: unknown) => {
    const taskId = parseId(id)
    const cursor = afterSeq === undefined ? 0 : parseNonNegativeInteger(afterSeq, 'afterSeq')
    if (ctx.sidecar?.currentStatus === 'ready') {
      try { return await ctx.sidecar.readEvents(taskId, cursor) } catch { /* compatibility fallback below */ }
    }
    return ctx.store.readEvents(taskId, cursor)
  })
  ipcMain.handle('tasks:create', (_e, input: unknown) => {
    const parsed = parseTaskCreate(input)
    const task = ctx.createTask(parsed, parsed.trigger ?? 'assignment')
    if (parsed.startNow === false) syncTask(task.id)
    else ctx.runner.enqueue(task)
    return task
  })
  ipcMain.handle('tasks:start', (_e, id: unknown) => {
    const taskId = parseId(id)
    const task = ctx.store.get(taskId)
    if (!task) return { ok: false, error: '任务不存在' }
    // parked 与非 parked 的 queued 都放行：非 parked 排队（如硬切后继）若因故滞留，
    // 这是用户唯一的手动解卡入口
    if (task.status !== 'queued') return { ok: false, error: '任务不在排队中' }
    // 捕获身份后再条件改状态：并发改到别的状态（如已被接管/已启动）时不覆盖新运行
    const started = prepareManualTaskStart(ctx.store, taskId)
    if (!started) return { ok: false, error: '任务不在排队中' }
    ctx.runner.enqueue(started)
    projectTasks()
    return { ok: true }
  })
  ipcMain.handle('tasks:cancel', async (_e, id: unknown) => {
    const result = await ctx.runner.cancel(parseId(id))
    projectTasks()
    return result
  })
  ipcMain.handle('tasks:followup', (_e, id: unknown, content: unknown, options: unknown) => ctx.runner.followUp(parseId(id), parseContent(content, '追问'), parseFollowUpOptions(options)))
  ipcMain.handle('tasks:permission-respond', (_e, requestId: unknown, optionId: unknown, decision: unknown, requestToken: unknown) => ctx.runner.resolvePermission(parseId(requestId, 'requestId'), parseContent(optionId, 'optionId'), parsePermissionDecision(decision), requestToken === undefined ? undefined : parseId(requestToken, 'requestToken')))
  ipcMain.handle('tasks:permission-pending', (_e, taskId: unknown) => ctx.runner.pendingPermissions(parseId(taskId)))
  ipcMain.handle('tasks:delete', async (_e, id: unknown) => {
    const taskId = parseId(id)
    const task = ctx.store.get(taskId)
    if (!task) return { ok: false, error: '任务不存在' }
    if (task.status === 'running') return { ok: false, error: '请先取消运行中的任务' }
    const children = ctx.store.list().filter((item) => item.parentTaskId === taskId)
    if (children.some((item) => item.status === 'running')) return { ok: false, error: '请先取消运行中的子任务' }
    const observed = [task, ...children]
    // 删除前先取 workdir（索引里没了任务对象就取不到了）
    const worktrees = [...new Map(observed.flatMap((item) => {
      const worktreePath = item.worktree?.path || item.workdir
      return worktreePath ? [[worktreePath, item.worktree?.ownerTaskId || item.id] as const] : []
    })).entries()].map(([worktreePath, ownerTaskId]) => ({ worktreePath, ownerTaskId }))
    const workdirs = worktrees.map((item) => item.worktreePath)
    // 先按捕获身份校验并提交删除，再清理内存会话：校验失败不留任何副作用，
    // 也不可能让清理先于删除去伤及替换执行（新运行仍持有该任务身份）。
    const deleted = ctx.store.transaction((tx) => {
      for (const item of observed) {
        const current = tx.get(item.id)
        if (!current || current.status === 'running' || current.gitOperation !== undefined) return null
        if (current.status !== item.status || current.runId !== item.runId) return null
        if (!sameExecutionOwner(current.executionOwner, item.executionOwner)) return null
      }
      for (const item of observed) tx.delete(item.id, taskIdentity(item))
      return observed.map((item) => item.id)
    })
    if (!deleted) return { ok: false, error: '任务状态已变化，请重试' }
    for (const childId of deleted) await Promise.resolve(ctx.runner.forget?.(childId))
    // 回收该任务（含子任务）的委派 worktree，防累积；失败不阻塞删除，留待启动清扫兜底
    for (const item of worktrees) void removeWorktree(item.worktreePath, item.ownerTaskId).catch(() => {})
    // 报告副本 GC 挂线一（tasks:delete 显式回收）：任务与子单在主仓库根的全文副本一并清掉；
    // 副本经 git-common-dir 归位主仓库根，worktree 目录先删也不影响这一步
    {
      const copyRoots = new Set<string>()
      for (const item of observed) if (item.worktree?.repoDir) copyRoots.add(item.worktree.repoDir)
      for (const wd of workdirs) {
        try {
          const root = await resolveRepositoryRoot(wd)
          if (root) copyRoots.add(root)
        } catch { /* 非仓库目录无副本可清 */ }
      }
      deleteReportCopies([...copyRoots], deleted)
    }
    projectTasks()
    for (const childId of deleted) send('task:deleted', childId)
    return { ok: true }
  })
  ipcMain.handle('tasks:retry', async (_e, id: unknown) => {
    const taskId = parseId(id)
    const task = ctx.store.get(taskId)
    if (!task) return { ok: false, error: '任务不存在' }
    if (task.status === 'running') return { ok: false, error: '任务正在运行，如长时间无输出可先「停止」再重新运行' }
    if (task.status === 'queued') return { ok: false, error: '任务已在队列中等待并发槽位' }
    const captured = taskIdentity(task)
    // Validate first, clean up second: the conditional requeue proves the
    // observed run still owns the record, so a rejected retry leaves the
    // replacement run and its session untouched.
    const requeued = ctx.store.updateIf(taskId, captured, { status: 'queued', error: undefined, failure: undefined, result: undefined, sessionId: undefined, attempt: undefined, runId: undefined, executionOwner: undefined })
    if (!requeued) return { ok: false, error: '任务状态已变化，请重试' }
    // 只关闭属于这次捕获运行的内存会话，陈旧清理不会碰到替换执行
    await ctx.runner.closeSession(taskId, { runId: task.runId, executionOwner: task.executionOwner })
    ctx.runner.enqueue(requeued)
    projectTasks()
    return { ok: true }
  })
  ipcMain.handle('tasks:rewind', (_e, id: unknown, toSeq: unknown) => {
    const taskId = parseId(id)
    const task = ctx.store.get(taskId)
    if (!task) return { ok: false, error: '任务不存在' }
    if (task.status === 'running' || task.status === 'queued') return { ok: false, error: '任务运行中，不能回退' }
    const captured = taskIdentity(task)
    // 截断与结果回写都按捕获身份条件提交：期间被替换成新运行就不再回退
    if (!ctx.store.truncateEvents(taskId, parseNonNegativeInteger(toSeq, 'toSeq'), captured)) return { ok: false, error: '回退失败' }
    const events = ctx.store.readEvents(taskId)
    const finalEvent = [...events].reverse().find((event) => event.kind === 'final' && event.text)
    if (!ctx.store.updateIf(taskId, captured, { result: finalEvent?.text, usage: aggregateUsage(events) })) return { ok: false, error: '回退失败' }
    ctx.runner.pushTask(taskId)
    BrowserWindow.getAllWindows().forEach((window) => window.webContents.send('task:events-invalidated', { taskId }))
    return { ok: true }
  })
  ipcMain.handle('tasks:rename', (_e, id: unknown, title: unknown) => {
    const taskId = parseId(id)
    const current = ctx.store.get(taskId)
    if (!current) return null
    const task = ctx.store.updateIf(taskId, taskIdentity(current), { title: parseContent(title, '标题').slice(0, 120), titleAuto: false })
    if (task) ctx.runner.pushTask(taskId)
    return task ?? null
  })
  // 渲染契约：tasks:fileDiff(taskId, file) —— 编辑详情「看某个文件改了什么」的 git 权威数据通道
  //   入参：taskId（任务 id）、file（仓库相对路径；正/反斜杠均可，拒绝绝对路径与 .. 逃逸）
  //   出参：{ ok, file, additions, deletions, diff, binary, truncated, note? }
  //     · workdir 定位：优先 task.worktree.path（WorktreeInfo 是元数据对象，真实目录在 .path），
  //       否则 task.workdir —— 委派子任务两者本就是同一隔离工作树
  //     · diff：`git diff --unified=3 -- <file>`（索引→工作区）在前，
  //       `git diff --cached --unified=3 -- <file>`（HEAD→索引）在后，两段按序拼接；
  //       未跟踪新文件用 `git diff --no-index -- /dev/null <file>` 生成「新增整文件」diff；
  //       文本保留 git 原样的结尾换行
  //     · additions/deletions：两段 numstat 之和（截断只影响文本，不影响计数；二进制不可数 → 0）
  //     · binary=true（git 判为二进制）时 diff 为空串，渲染层只显示「二进制文件」占位
  //     · 文件存在但无未提交改动 → note:'clean'，渲染层回退事件里的 +/- 参数快照
  //     · diff 超 256KB → 按行截断并置 truncated:true
  //   失败一律不 reject：{ ok:false, code:'bad-request'|'no-task'|'no-workdir'|'not-a-repo'|'file-missing'|'git-failed', error }
  ipcMain.handle('tasks:fileDiff', async (_e, id: unknown, file: unknown) => {
    const taskId = typeof id === 'string' ? id.trim() : ''
    if (!taskId) return fileDiffFailure('', 'bad-request', 'taskId 不能为空')
    const task: Task | undefined = ctx.store.get(taskId)
    if (!task) return fileDiffFailure('', 'no-task', '任务不存在')
    // Task.worktree 是 durable 元数据（ownerTaskId/repoDir/path/branch/...），不是路径字符串
    const workdir = task.worktree?.path?.trim() || task.workdir
    if (!workdir) return fileDiffFailure('', 'no-workdir', '任务没有绑定工作目录')
    let relative: string
    try {
      relative = parseRepoRelativePath(file)
    } catch (error) {
      return fileDiffFailure(String(file ?? ''), 'bad-request', error instanceof Error ? error.message : String(error))
    }
    return fileDiff(workdir, relative)
  })
  ipcMain.handle('tasks:move', (_e, id: unknown, status: unknown) => {
    const taskId = parseId(id)
    const parsedStatus = parseTaskStatus(status)
    const task = ctx.store.get(taskId)
    if (!task) return { ok: false, error: '任务不存在' }
    const transition = validateMove(task.status, parsedStatus)
    if (!transition.ok) return transition
    if (task.status === parsedStatus) return { ok: true }
    if (task.status === 'running') return { ok: false, error: '请先取消运行中的任务' }
    const captured = taskIdentity(task)
    if (parsedStatus === 'running') {
      if (task.status !== 'queued') return { ok: false, error: '只有排队中的任务可以启动' }
      const started = prepareManualTaskStart(ctx.store, taskId)
      if (!started) return { ok: false, error: '任务不在排队中' }
      ctx.runner.enqueue(started)
    } else if (parsedStatus === 'queued') {
      if (!ctx.store.updateIf(taskId, captured, { status: 'queued', parked: true, error: undefined, failure: undefined, result: undefined, endedAt: undefined })) return { ok: false, error: '任务状态已变化，请重试' }
      syncTask(taskId)
    } else {
      if (!ctx.store.updateIf(taskId, captured, { status: parsedStatus, parked: undefined, endedAt: Date.now() })) return { ok: false, error: '任务状态已变化，请重试' }
      syncTask(taskId)
    }
    projectTasks()
    return { ok: true }
  })
}
