// 任务运行器：队列 + 生命周期 + 事件管道
// 状态机：queued → running → done | failed | cancelled
import type { Task, TaskEvent } from '../shared/types'
import type { TaskStore } from './store'
import type { AgentBackend, BackendSession, PermissionRequest } from './backends/types'
import { snapshotGitAfter } from './git'
import { buildAgentPrompt, buildDelegationBlock, runDelegationLoop, type AgentLike } from './delegate'
import { classifyFailure } from './failure'
import { aggregateUsage } from './usage'

function getWindows(): { send: (ch: string, v: unknown) => void }[] {
  try {
    const { BrowserWindow } = require('electron') as typeof import('electron')
    return BrowserWindow.getAllWindows() as unknown as { send: (ch: string, v: unknown) => void }[]
  } catch {
    return [] // 无 GUI 环境（测试）
  }
}

export class TaskRunner {
  private store: TaskStore
  private backends: Map<string, AgentBackend>
  private opts: () => { concurrency: number; mode: string; notify: boolean; workerConcurrency?: number }
  private sessions = new Map<string, BackendSession>()
  /** 启动即注册的中止句柄（一次性 CLI 在 session 返回前就要能取消） */
  private launchHandles = new Map<string, { stop: () => void }>()
  private pendingResume = new Map<string, (v: { ok: boolean; response: string; error?: string }) => void>()
  private pendingPermissions = new Map<string, { taskId: string; resolve: (v: { optionId?: string; decision: 'allow' | 'deny' }) => void; timer: NodeJS.Timeout }>()
  private runningNormal = 0
  private runningWorkers = 0
  private getTeam: (() => AgentLike[]) | null = null
  private pumping = false

  constructor(
    store: TaskStore,
    backends: Map<string, AgentBackend>,
    opts: () => { concurrency: number; mode: string; notify: boolean; workerConcurrency?: number }
  ) {
    this.store = store
    this.backends = backends
    this.opts = opts
  }

  private win(): { send: (ch: string, v: unknown) => void } | null {
    return getWindows()[0] ?? null
  }

  pushTask(taskId: string) {
    this.win()?.send('task:updated', this.store.get(taskId))
  }
  /** 记录用户输入（首条 prompt / 追问），对话视图按 user 事件分气泡 */
  private recordUser(taskId: string, text: string) {
    const full = this.store.appendEvent(taskId, { ts: Date.now(), kind: 'user', text })
    if (full) this.pushEvent(taskId, full)
  }
  pushEvent(taskId: string, e: TaskEvent) {
    this.win()?.send('task:event', { taskId, event: e })
  }

  /** 事件管道：落盘 + 推 UI；onTurnEnd 可挂回调 */
  private makeEvents(taskId: string, onTurnEnd?: (r: { ok: boolean; response: string; error?: string }) => void) {
    return {
      onEvent: (e: Omit<TaskEvent, 'seq'>) => {
        const full = this.store.appendEvent(taskId, e)
        if (full) this.pushEvent(taskId, full)
      },
      onTurnEnd: (r: { ok: boolean; response: string; error?: string }) => {
        onTurnEnd?.(r)
        const waiter = this.pendingResume.get(taskId)
        if (waiter) {
          this.pendingResume.delete(taskId)
          waiter(r)
        }
      },
      onLaunch: (handle: { stop: () => void }) => {
        this.launchHandles.set(taskId, handle)
      },
      onPermission: (req: PermissionRequest) => this.askPermission(taskId, req)
    }
  }

  /** 权限确认：推给 UI，5 分钟无响应自动拒绝（领队/worker 共用） */
  askPermission(taskId: string, req: PermissionRequest): Promise<{ optionId?: string; decision: 'allow' | 'deny' }> {
    return new Promise((resolve) => {
      const key = String(req.requestId)
      const timer = setTimeout(() => {
        this.pendingPermissions.delete(key)
        resolve({ decision: 'deny' })
      }, 5 * 60 * 1000)
      this.pendingPermissions.set(key, { taskId, resolve, timer })
      this.win()?.send('task:permission', { taskId, request: req })
    })
  }

  /** UI 应答权限请求 */
  resolvePermission(requestId: string, optionId: string, decision: 'allow' | 'deny') {
    const key = String(requestId)
    const p = this.pendingPermissions.get(key)
    if (!p) return { ok: false, error: '请求不存在或已超时' }
    clearTimeout(p.timer)
    this.pendingPermissions.delete(key)
    p.resolve({ optionId, decision })
    return { ok: true }
  }

  /** 回合成功后的收尾：取最终结果 + git 快照 + 用量聚合 + 状态落盘 */
  private async finalizeDone(taskId: string, directResult?: string) {
    const task = this.store.get(taskId)
    if (!task) return
    let result = directResult
    const events = this.store.readEvents(taskId)
    if (result === undefined) {
      const finals = events.filter((e) => e.kind === 'final')
      result = finals[finals.length - 1]?.text ?? ''
    }
    const { diff, stat } = await snapshotGitAfter(task.workdir)
    this.store.update(taskId, {
      status: 'done',
      endedAt: Date.now(),
      result,
      gitDiff: diff || task.gitDiff,
      gitStat: stat || task.gitStat,
      usage: aggregateUsage(events)
    })
    this.pushTask(taskId)
  }

  /** 失败落库：原始错误 + 分类解读（P1） */
  private failTask(taskId: string, error: string) {
    this.store.update(taskId, { status: 'failed', endedAt: Date.now(), error, failure: classifyFailure({ error }) })
  }

  enqueue(task: Task) {
    this.pushTask(task.id)
    this.pump()
  }

  /** 双通道：普通任务受 concurrency 限制；委派子任务受 workerConcurrency 限制（否则领队会占槽死锁） */
  private pump() {
    if (this.pumping) return
    this.pumping = true
    try {
      const { concurrency, workerConcurrency } = this.opts()
      const queued = this.store
        .list()
        .filter((t) => t.status === 'queued')
        .sort((a, b) => a.createdAt - b.createdAt)
      const normal = queued.filter((t) => !t.parentTaskId)
      const workers = queued.filter((t) => t.parentTaskId)
      while (this.runningNormal < Math.max(1, concurrency) && normal.length) {
        const next = normal.shift()!
        void this.run(next.id)
      }
      while (this.runningWorkers < Math.max(1, workerConcurrency ?? concurrency) && workers.length) {
        const next = workers.shift()!
        void this.run(next.id)
      }
    } finally {
      this.pumping = false
    }
  }

  /** 队伍提供者（agent 身份与委派名单） */
  attachTeam(getTeam: () => AgentLike[]) {
    this.getTeam = getTeam
  }

  /** 执行一个任务（首回合） */
  private async run(taskId: string) {
    const task = this.store.get(taskId)
    if (!task || task.status !== 'queued') return
    const backend = this.backends.get(task.backend)
    if (!backend) {
      this.failTask(taskId, `未知后端: ${task.backend}`)
      this.pushTask(taskId)
      return
    }
    const isWorker = !!task.parentTaskId
    if (isWorker) this.runningWorkers++
    else this.runningNormal++
    this.store.update(taskId, { status: 'running', startedAt: Date.now(), error: undefined, failure: undefined })
    this.pushTask(taskId)
    this.recordUser(taskId, task.prompt)

    // 首回合完成信号
    let firstTurnDone: ((v: { ok: boolean; response: string; error?: string }) => void) | null = null
    const firstTurnPromise = new Promise<{ ok: boolean; response: string; error?: string }>((resolve) => {
      firstTurnDone = resolve
    })

    // agent 身份注入：人设 + （领队时）委派协议
    const team = this.getTeam?.() ?? []
    const me = team.find((a) => a.id === task.agentId)
    let prompt = buildAgentPrompt(me, task.prompt, team)
    if (me?.subordinates?.length && task.backend !== 'dsh') {
      const block = buildDelegationBlock(me, team)
      if (block) prompt = `${prompt}\n\n${block}`
    }

    try {
      const session = await backend.start({
        prompt,
        workdir: task.workdir,
        mode: this.opts().mode,
        events: this.makeEvents(taskId, (r) => firstTurnDone?.(r))
      })
      this.sessions.set(taskId, session)
      this.store.update(taskId, { sessionId: session.sessionId })
      this.pushTask(taskId)

      const r = await firstTurnPromise
      if (r.ok) {
        // 领队：进入委派循环（截获 <delegate> 标记 → 并行子任务 → 回灌 → 继续）
        let finalText = r.response
        if (me?.subordinates?.length && task.backend !== 'dsh' && !isWorker) {
          const outcome = await runDelegationLoop(taskId, session, r.response, {
            store: this.store,
            runner: this,
            getTeam: () => this.getTeam?.() ?? [],
            opts: () => ({ mode: this.opts().mode, notify: this.opts().notify, maxParallel: Math.max(1, this.opts().workerConcurrency ?? this.opts().concurrency) }),
            pushTask: (id) => this.pushTask(id),
            pushEvent: (id, e) => this.pushEvent(id, e)
          })
          finalText = outcome.finalText || r.response
        }
        await this.finalizeDone(taskId, finalText)
        if (this.opts().notify) this.notify(task, '完成', finalText)
      } else {
        this.failTask(taskId, r.error || '回合失败')
        this.maybeAutoRetry(taskId)
        if (this.opts().notify) this.notify(task, '失败', r.error || '')
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.failTask(taskId, msg)
      this.maybeAutoRetry(taskId)
      if (this.opts().notify) this.notify(task, '失败', msg)
    } finally {
      this.store.flushEvents(taskId)
      this.launchHandles.delete(taskId)
      this.pushTask(taskId)
      if (isWorker) this.runningWorkers--
      else this.runningNormal--
      this.pump()
    }
  }

  /**
   * 自动重试（P4）：仅 retryable 的瞬态失败（限流/超时/进程崩溃/沙箱），上限 2 次。
   * 第 1 次优先带会话续跑（同后端可 resume）；第 2 次强制新会话（会话可能已被污染）。
   * 手动"重新运行"不受此影响（恒新会话、attempt 清零）。
   */
  private maybeAutoRetry(taskId: string) {
    const task = this.store.get(taskId)
    if (!task || task.status !== 'failed') return
    const attempt = task.attempt ?? 0
    if (attempt >= 2) return
    const failure = task.failure
    if (!failure?.retryable) return
    const next = attempt + 1
    const fresh = next >= 2 || !task.sessionId || task.backend === 'dsh'
    this.store.update(taskId, {
      status: 'queued',
      endedAt: undefined,
      attempt: next,
      ...(fresh ? { sessionId: undefined } : {})
    })
    const full = this.store.appendEvent(taskId, {
      ts: Date.now(),
      kind: 'status',
      text: `⟳ 自动重试 ${next}/2（${failure.title}）${fresh ? '· 新会话' : '· 续会话'}`
    })
    if (full) this.pushEvent(taskId, full)
    this.pushTask(taskId)
    this.enqueue(this.store.get(taskId)!)
  }

  private notify(task: Task, what: string, body: string) {
    if (!this.opts().notify) return
    try {
      const { Notification, BrowserWindow } = require('electron') as typeof import('electron')
      if (Notification.isSupported()) {
        const n = new Notification({
          title: `任务${what}: ${task.title}`,
          body: (body || '').slice(0, 180)
        })
        n.on('click', () => {
          // 后台时点击系统通知：先唤起窗口再聚焦任务
          const w = BrowserWindow.getAllWindows()[0]
          if (w) {
            w.show()
            w.focus()
          }
          this.win()?.send('task:focus', task.id)
        })
        n.show()
      }
    } catch {}
  }

  /** 续聊：在已完成任务的会话上追加消息，任务回到 running */
  async followUp(taskId: string, content: string): Promise<{ ok: boolean; error?: string }> {
    const task = this.store.get(taskId)
    if (!task) return { ok: false, error: '任务不存在' }
    let session = this.sessions.get(taskId)
    const backend = this.backends.get(task.backend)
    if (!backend) return { ok: false, error: '后端不可用' }
    this.recordUser(taskId, content)

    if (!session) {
      // 应用重启后 session 丢失：用 zcode 的 session/resume 恢复
      if (!task.sessionId) return { ok: false, error: '无会话可恢复' }
      this.store.update(taskId, { status: 'running', endedAt: undefined, error: undefined, failure: undefined })
      this.pushTask(taskId)
      try {
        const firstTurn = new Promise<{ ok: boolean; response: string; error?: string }>((resolve) => {
          this.pendingResume.set(taskId, resolve)
        })
        session = await backend.start({
          prompt: content,
          workdir: task.workdir,
          mode: this.opts().mode,
          resumeSessionId: task.sessionId,
          events: this.makeEvents(taskId)
        })
        this.sessions.set(taskId, session)
        this.store.update(taskId, { sessionId: session.sessionId })
        this.pushTask(taskId)
        const r = await Promise.race([
          firstTurn,
          new Promise<{ ok: boolean; response: string; error: string }>((res) =>
            setTimeout(() => res({ ok: false, response: '', error: 'resume 超时（120s）' }), 120000)
          )
        ])
        if (!r.ok) throw new Error(r.error || '续聊回合失败')
        await this.finalizeDone(taskId)
        return { ok: true }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        this.failTask(taskId, msg)
        this.pushTask(taskId)
        return { ok: false, error: msg }
      }
    }
    this.store.update(taskId, { status: 'running', endedAt: undefined, error: undefined, failure: undefined })
    this.pushTask(taskId)
    try {
      await session.send(content)
      // send resolve 即回合成功；结果已通过事件流记录
      await this.finalizeDone(taskId)
      return { ok: true }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.failTask(taskId, msg)
      this.pushTask(taskId)
      return { ok: false, error: msg }
    }
  }

  async cancel(taskId: string): Promise<{ ok: boolean; error?: string }> {
    const task = this.store.get(taskId)
    if (!task) return { ok: false, error: '任务不存在' }
    if (task.status === 'queued') {
      this.store.update(taskId, { status: 'cancelled', endedAt: Date.now() })
      this.pushTask(taskId)
      return { ok: true }
    }
    if (task.status !== 'running') return { ok: false, error: '任务不在运行中' }
    const session = this.sessions.get(taskId)
    this.store.update(taskId, { status: 'cancelled', endedAt: Date.now() })
    this.pushTask(taskId)
    // 级联取消子任务（领队被取消时，运行中/排队的子任务一并停）
    for (const child of this.store.list().filter((t) => t.parentTaskId === taskId && (t.status === 'running' || t.status === 'queued'))) {
      void this.cancel(child.id)
    }
    // 先用启动句柄硬停（一次性 CLI 的 session 可能还没返回）
    this.launchHandles.get(taskId)?.stop()
    this.launchHandles.delete(taskId)
    try {
      await session?.stop()
    } catch {}
    try {
      await session?.close()
    } catch {}
    this.sessions.delete(taskId)
    this.store.flushEvents(taskId)
    return { ok: true }
  }

  async shutdown() {
    for (const [, s] of this.sessions) {
      try {
        await s.close()
      } catch {}
    }
    this.sessions.clear()
  }

  sessionCount() {
    return this.sessions.size
  }
}
