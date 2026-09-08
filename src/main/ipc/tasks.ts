import { BrowserWindow, ipcMain } from 'electron'
import { validateMove } from '../../shared/taskflow'
import { aggregateUsage } from '../usage'
import { parseContent, parseFollowUpOptions, parseId, parseNonNegativeInteger, parsePermissionDecision, parseTaskCreate, parseTaskStatus } from '../ipc-validation'
import type { IpcContext } from './context'

export function registerTaskIpc(ctx: IpcContext) {
  const send = (channel: string, payload: unknown) => ctx.getWindow()?.webContents.send(channel, payload)
  const syncTask = (taskId: string) => {
    const task = ctx.store.get(taskId)
    if (!task) return
    ctx.publishIssueUpdate(task)
    send('task:updated', task)
  }

  ipcMain.handle('tasks:list', () => ctx.store.list())
  ipcMain.handle('tasks:get', (_e, id: unknown) => ctx.store.get(parseId(id)) ?? null)
  ipcMain.handle('tasks:events', (_e, id: unknown, afterSeq: unknown) => ctx.store.readEvents(parseId(id), afterSeq === undefined ? 0 : parseNonNegativeInteger(afterSeq, 'afterSeq')))
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
    if (task.status !== 'queued' || !task.parked) return { ok: false, error: '任务不在待启动状态' }
    ctx.store.update(taskId, { parked: undefined })
    ctx.runner.enqueue(ctx.store.get(taskId)!)
    ctx.issueStore.sync(ctx.store.list())
    return { ok: true }
  })
  ipcMain.handle('tasks:cancel', async (_e, id: unknown) => {
    const result = await ctx.runner.cancel(parseId(id))
    ctx.issueStore.sync(ctx.store.list())
    return result
  })
  ipcMain.handle('tasks:followup', (_e, id: unknown, content: unknown, options: unknown) => ctx.runner.followUp(parseId(id), parseContent(content, '追问'), parseFollowUpOptions(options)))
  ipcMain.handle('tasks:permission-respond', (_e, requestId: unknown, optionId: unknown, decision: unknown) => ctx.runner.resolvePermission(parseId(requestId, 'requestId'), parseContent(optionId, 'optionId'), parsePermissionDecision(decision)))
  ipcMain.handle('tasks:delete', (_e, id: unknown) => {
    const taskId = parseId(id)
    const task = ctx.store.get(taskId)
    if (!task) return { ok: false, error: '任务不存在' }
    if (task.status === 'running') return { ok: false, error: '请先取消运行中的任务' }
    const children = ctx.store.list().filter((item) => item.parentTaskId === taskId)
    if (children.some((item) => item.status === 'running')) return { ok: false, error: '请先取消运行中的子任务' }
    const deleted = [taskId, ...children.map((item) => item.id)]
    for (const childId of deleted) ctx.store.delete(childId)
    ctx.issueStore.sync(ctx.store.list())
    for (const childId of deleted) send('task:deleted', childId)
    return { ok: true }
  })
  ipcMain.handle('tasks:retry', (_e, id: unknown) => {
    const taskId = parseId(id)
    const task = ctx.store.get(taskId)
    if (!task) return { ok: false, error: '任务不存在' }
    if (task.status === 'running' || task.status === 'queued') return { ok: false, error: '任务已在队列/运行中' }
    ctx.runner.closeSession(taskId)
    ctx.store.update(taskId, { status: 'queued', error: undefined, failure: undefined, result: undefined, sessionId: undefined, attempt: undefined, runId: undefined })
    ctx.runner.enqueue(ctx.store.get(taskId)!)
    ctx.issueStore.sync(ctx.store.list())
    return { ok: true }
  })
  ipcMain.handle('tasks:rewind', (_e, id: unknown, toSeq: unknown) => {
    const taskId = parseId(id)
    const task = ctx.store.get(taskId)
    if (!task) return { ok: false, error: '任务不存在' }
    if (task.status === 'running' || task.status === 'queued') return { ok: false, error: '任务运行中，不能回退' }
    if (!ctx.store.truncateEvents(taskId, parseNonNegativeInteger(toSeq, 'toSeq'))) return { ok: false, error: '回退失败' }
    const events = ctx.store.readEvents(taskId)
    const finalEvent = [...events].reverse().find((event) => event.kind === 'final' && event.text)
    ctx.store.update(taskId, { result: finalEvent?.text, usage: aggregateUsage(events) })
    ctx.runner.pushTask(taskId)
    BrowserWindow.getAllWindows().forEach((window) => window.webContents.send('task:events-invalidated', { taskId }))
    return { ok: true }
  })
  ipcMain.handle('tasks:rename', (_e, id: unknown, title: unknown) => {
    const taskId = parseId(id)
    ctx.store.update(taskId, { title: parseContent(title, '标题').slice(0, 120), titleAuto: false })
    const task = ctx.store.get(taskId)
    if (task) ctx.runner.pushTask(taskId)
    return task ?? null
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
    if (parsedStatus === 'running') {
      if (task.status !== 'queued') return { ok: false, error: '只有排队中的任务可以启动' }
      ctx.store.update(taskId, { parked: undefined })
      ctx.runner.enqueue(ctx.store.get(taskId)!)
    } else if (parsedStatus === 'queued') {
      ctx.store.update(taskId, { status: 'queued', parked: true, error: undefined, failure: undefined, result: undefined, endedAt: undefined })
      syncTask(taskId)
    } else {
      ctx.store.update(taskId, { status: parsedStatus, parked: undefined, endedAt: Date.now() })
      syncTask(taskId)
    }
    ctx.issueStore.sync(ctx.store.list())
    return { ok: true }
  })
}
