import fs from 'node:fs'
import path from 'node:path'
import type { Comment, Issue, IssuePriority, IssueStatus, Notification, Run, Task } from '../shared/types'

type Persisted = { issues: Issue[]; runs: Run[]; comments: Comment[]; notifications: Notification[]; nextIdentifier: number }

/** Durable issue/run projection over the existing task execution store. */
export class IssueStore {
  private readonly file: string
  private data: Persisted = { issues: [], runs: [], comments: [], notifications: [], nextIdentifier: 1 }

  constructor(userDataDir: string) {
    const dir = path.join(userDataDir, 'issues')
    fs.mkdirSync(dir, { recursive: true })
    this.file = path.join(dir, 'index.json')
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<Persisted>
      this.data = {
        issues: Array.isArray(parsed.issues) ? parsed.issues : [],
        runs: Array.isArray(parsed.runs) ? parsed.runs : [],
        comments: Array.isArray(parsed.comments) ? parsed.comments : [],
        notifications: Array.isArray(parsed.notifications) ? parsed.notifications : [],
        nextIdentifier: typeof parsed.nextIdentifier === 'number' ? parsed.nextIdentifier : 1
      }
    } catch { /* first launch */ }
  }

  private save() {
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2))
    fs.renameSync(tmp, this.file)
  }

  private id(prefix: string) { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}` }

  /** Rebuild the projection from task snapshots. Safe to call before every read. */
  sync(tasks: Task[]) {
    let changed = false
    // One Issue can have many execution records (retries, follow-ups, or
    // comment mentions). Only the newest task owns the current Issue status;
    // every task still contributes a Run history entry below.
    const latestByIssue = new Map<string, Task>()
    for (const task of tasks) {
      if (task.suppressIssue) continue
      const key = task.issueId ?? `iss_${task.id}`
      const current = latestByIssue.get(key)
      if (!current || task.createdAt > current.createdAt) latestByIssue.set(key, task)
    }
    for (const task of tasks) {
      if (task.suppressIssue) continue
      const existing = this.data.issues.find((issue) => issue.taskId === task.id || (!!task.issueId && issue.id === task.issueId))
      const derivedStatus = issueStatus(task.status)
      const status = existingStatus(this.data.issues, task.id, task.status, derivedStatus, task.issueId)
      const isLatest = latestByIssue.get(task.issueId ?? `iss_${task.id}`)?.id === task.id
      if (!existing) {
        const issue: Issue = {
          id: task.issueId ?? `iss_${task.id}`,
          identifier: `YOU-${this.data.nextIdentifier++}`,
          title: task.title,
          description: task.prompt,
          status,
          priority: 'none',
          labels: [],
          position: task.createdAt,
          createdBy: 'user',
          createdAt: task.createdAt,
          updatedAt: task.endedAt ?? task.createdAt,
          taskId: task.id
        }
        if (task.agentId) issue.assignee = { type: 'agent', id: task.agentId }
        this.data.issues.push(issue)
        changed = true
      } else {
        const patch: Partial<Issue> = {}
        if (isLatest && existing.taskId !== task.id) patch.taskId = task.id
        if (isLatest && existing.title !== task.title) patch.title = task.title
        if (isLatest && existing.description !== task.prompt) patch.description = task.prompt
        if (isLatest && existing.status !== status) {
          patch.status = status
          if (!existing.statusOverride && existing.updatedAt !== task.createdAt) {
            this.data.notifications.push({ id: this.id('ntf'), userId: 'user', issueId: existing.id, kind: 'status', read: false, createdAt: Date.now() })
          }
        }
        if (isLatest && task.agentId && existing.assignee?.id !== task.agentId) patch.assignee = { type: 'agent', id: task.agentId }
        if (Object.keys(patch).length) { Object.assign(existing, patch, { updatedAt: Date.now() }); changed = true }
      }
      const issue = this.data.issues.find((item) => item.taskId === task.id)
        ?? this.data.issues.find((item) => item.id === task.issueId)
      if (!issue) continue
      // Parked tasks have an Issue but no execution yet. Legacy tasks use a stable fallback.
      if (task.status === 'queued' && !task.runId) continue
      const runId = task.runId ?? `legacy_${task.id}_${task.attempt ?? 1}`
      const runStatus = task.status === 'running' || task.status === 'queued' ? 'running' : task.status === 'cancelled' ? 'cancelled' : task.status === 'done' ? 'completed' : 'error'
      const current = this.data.runs.find((run) => run.id === runId)
      const run: Run = {
        id: runId,
        issueId: issue.id,
        taskId: task.id,
        agentId: task.agentId,
        trigger: task.trigger ?? 'assignment',
        prompt: task.prompt,
        status: runStatus,
        startedAt: task.startedAt,
        finishedAt: task.endedAt,
        durationMs: task.usage?.durationMs,
        usage: task.usage,
        transcriptEventCount: task.eventCount
      }
      if (!current || JSON.stringify(current) !== JSON.stringify(run)) {
        if (current) Object.assign(current, run)
        else this.data.runs.push(run)
        changed = true
      }
      // Every terminal run leaves one report in the issue timeline. Associate
      // it with runId so identical retry output is still a distinct report.
      const reportText = task.status === 'done' ? task.result?.trim() : task.error?.trim()
      const reportContent = task.status === 'done'
        ? reportText
        : reportText ? `Agent execution error: ${reportText}` : 'Agent execution error'
      const hasReport = reportContent && this.data.comments.some((item) => item.issueId === issue.id && item.author.type === 'agent' && (item.runId === runId || (!item.runId && item.content === reportContent)))
      if ((task.status === 'done' || task.status === 'failed') && reportContent && !hasReport) {
        const comment: Comment = { id: this.id('com'), issueId: issue.id, author: { type: 'agent', id: task.agentId ?? task.backend }, content: reportContent, reactions: [], runId, createdAt: task.endedAt ?? Date.now() }
        this.data.comments.push(comment)
        this.data.notifications.push({ id: this.id('ntf'), userId: 'user', issueId: issue.id, kind: 'reported', runId, read: false, createdAt: comment.createdAt })
        changed = true
      }
    }
    // Keep parent/child structure in the product model even though execution
    // records still use parentTaskId for scheduling.
    for (const task of tasks) {
      if (task.suppressIssue || !task.parentTaskId) continue
      const child = this.data.issues.find((item) => item.taskId === task.id || item.id === task.issueId)
      const parent = tasks.find((item) => item.id === task.parentTaskId)
      const parentIssue = parent && this.data.issues.find((item) => item.taskId === parent.id || item.id === parent.issueId)
      if (child && parentIssue && child.parentIssueId !== parentIssue.id) {
        child.parentIssueId = parentIssue.id
        child.updatedAt = Date.now()
        changed = true
      }
    }
    if (changed) this.save()
  }

  list() { return [...this.data.issues].sort((a, b) => b.updatedAt - a.updatedAt) }
  get(id: string) { return this.data.issues.find((issue) => issue.id === id || issue.identifier === id) }
  runs(issueId: string) { return this.data.runs.filter((run) => run.issueId === issueId).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0)) }
  /** Return the most recent projected run for a compatibility task. */
  runForTask(taskId: string) {
    return this.data.runs
      .filter((run) => run.taskId === taskId)
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0]
  }
  comments(issueId: string) { return this.data.comments.filter((comment) => comment.issueId === issueId).sort((a, b) => a.createdAt - b.createdAt) }
  notifications(unreadOnly = false) { return this.data.notifications.filter((item) => !unreadOnly || !item.read).sort((a, b) => b.createdAt - a.createdAt) }

  addComment(issueId: string, content: string, author: { type: 'agent' | 'user'; id: string } = { type: 'user', id: 'user' }): Comment | null {
    if (!this.get(issueId) || !content.trim()) return null
    const comment: Comment = { id: this.id('com'), issueId, author, content: content.trim(), reactions: [], createdAt: Date.now() }
    this.data.comments.push(comment)
    this.data.notifications.push({ id: this.id('ntf'), userId: 'user', issueId, kind: author.type === 'agent' ? 'reported' : 'mentioned', read: false, createdAt: comment.createdAt })
    this.save()
    return comment
  }

  markNotificationRead(id: string) {
    const notification = this.data.notifications.find((item) => item.id === id)
    if (!notification) return false
    notification.read = true
    this.save()
    return true
  }

  notificationIssueId(id: string) {
    return this.data.notifications.find((item) => item.id === id)?.issueId
  }

  updateMetadata(id: string, patch: { priority?: IssuePriority; labels?: string[]; dueDate?: number }) {
    const issue = this.get(id)
    if (!issue) return null
    if (patch.priority) issue.priority = priorityForIssue(patch.priority)
    if (patch.labels) issue.labels = [...new Set(patch.labels.map((label) => label.trim()).filter(Boolean))].slice(0, 20)
    if (patch.dueDate !== undefined) issue.dueDate = patch.dueDate > 0 ? patch.dueDate : undefined
    issue.updatedAt = Date.now()
    this.save()
    return issue
  }

  updateWorkflow(id: string, status: IssueStatus) {
    const issue = this.get(id)
    if (!issue) return null
    issue.status = status
    issue.statusOverride = status
    issue.updatedAt = Date.now()
    this.save()
    return issue
  }
}

function existingStatus(issues: Issue[], taskId: string, taskStatus: Task['status'], derived: IssueStatus, issueId?: string): IssueStatus {
  const issue = issues.find((item) => item.taskId === taskId || (!!issueId && item.id === issueId))
  // A human workflow choice is durable. An active execution is the only
  // transient state allowed to surface over it; terminal runs return to the
  // chosen review/done/blocked state instead of silently rewriting the board.
  if (issue?.statusOverride && taskStatus !== 'running') return issue.statusOverride
  return derived
}

function issueStatus(status: Task['status']): IssueStatus {
  if (status === 'queued') return 'todo'
  if (status === 'running') return 'in_progress'
  if (status === 'done') return 'in_review'
  if (status === 'cancelled') return 'cancelled'
  return 'blocked'
}

export function priorityForIssue(value: unknown): IssuePriority {
  return value === 'urgent' || value === 'high' || value === 'medium' || value === 'low' ? value : 'none'
}
