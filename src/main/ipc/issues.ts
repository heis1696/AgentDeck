import { ipcMain } from 'electron'
import type { Task } from '../../shared/types'
import { parseContent, parseId, parseIssueCreate, parseIssuePatch } from '../ipc-validation'
import type { IpcContext } from './context'

export function registerIssueIpc(ctx: IpcContext) {
  const sendUpdate = (taskId: string, issueId: string, issue: unknown, run: unknown) => ctx.getWindow()?.webContents.send('issues:updated', { taskId, issueId, issue, run })

  ipcMain.handle('issues:list', () => ctx.issueStore.list())
  ipcMain.handle('issues:get', (_e, id: unknown) => ctx.issueStore.get(parseId(id, 'issueId')) ?? null)
  ipcMain.handle('issues:create', (_e, input: unknown) => {
    const parsed = parseIssueCreate(input)
    const task = ctx.createTask({ title: parsed.title, prompt: parsed.description, workdir: parsed.workdir, agentId: parsed.agentId, backend: parsed.backend, handoff: parsed.handoff, startNow: parsed.startNow, titleAuto: parsed.titleAuto }, parsed.trigger ?? 'assignment')
    if (parsed.startNow === false) ctx.publishIssueUpdate(task)
    else ctx.runner.enqueue(task)
    const issue = ctx.issueStore.get(task.issueId ?? `iss_${task.id}`)
    if (!issue) throw new Error('Issue projection failed')
    return issue
  })
  ipcMain.handle('issues:runs', (_e, id: unknown) => { const issue = ctx.issueStore.get(parseId(id, 'issueId')); return issue ? ctx.issueStore.runs(issue.id) : [] })
  ipcMain.handle('issues:comments', (_e, id: unknown) => { const issue = ctx.issueStore.get(parseId(id, 'issueId')); return issue ? ctx.issueStore.comments(issue.id) : [] })
  ipcMain.handle('issues:update', (_e, id: unknown, patch: unknown) => {
    const issueId = parseId(id, 'issueId')
    const parsed = parseIssuePatch(patch)
    const issue = parsed.status ? ctx.issueStore.updateWorkflow(issueId, parsed.status) : ctx.issueStore.updateMetadata(issueId, parsed)
    if (issue) sendUpdate(issue.taskId, issue.id, issue, ctx.issueStore.runForTask(issue.taskId) ?? null)
    return issue
  })
  ipcMain.handle('issues:add-comment', (_e, id: unknown, content: unknown) => {
    const issue = ctx.issueStore.get(parseId(id, 'issueId'))
    const text = parseContent(content, '评论')
    const comment = issue ? ctx.issueStore.addComment(issue.id, text) : null
    let executionTask: Task | undefined
    if (issue && comment) {
      const mention = text.match(/@([^\s@]+)/)?.[1]?.replace(/[),.;:!?]+$/, '').toLowerCase()
      const agent = mention ? ctx.agents.find((item) => item.name.toLowerCase() === mention || item.id.toLowerCase() === mention) : undefined
      if (agent) {
        executionTask = ctx.createTask({ title: issue.title, prompt: text, workdir: ctx.store.get(issue.taskId)?.workdir ?? '', agentId: agent.id, backend: agent.backend, startNow: true, issueId: issue.id }, 'mention')
        ctx.publishIssueUpdate(executionTask)
        ctx.runner.enqueue(executionTask)
      }
    }
    if (issue && comment) sendUpdate(executionTask?.id ?? issue.taskId, issue.id, issue, executionTask ? ctx.issueStore.runForTask(executionTask.id) ?? null : ctx.issueStore.runForTask(issue.taskId) ?? null)
    return comment
  })
  ipcMain.handle('issues:notifications', (_e, unreadOnly: unknown = false) => ctx.issueStore.notifications(unreadOnly === true))
  ipcMain.handle('issues:notification-read', (_e, id: unknown) => {
    const notificationId = parseId(id, 'notificationId')
    const issueId = ctx.issueStore.notificationIssueId(notificationId)
    const ok = ctx.issueStore.markNotificationRead(notificationId)
    const issue = issueId ? ctx.issueStore.get(issueId) : undefined
    if (ok && issue) sendUpdate(issue.taskId, issue.id, issue, ctx.issueStore.runForTask(issue.taskId) ?? null)
    return { ok }
  })
}
