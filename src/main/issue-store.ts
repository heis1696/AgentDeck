import path from 'node:path'
import type { Comment, Issue, IssuePriority, IssueStatus, Run, Task } from '../shared/types'
import { executionRecordFromTask, taskStatusToIssueStatus } from '../shared/taskflow'
import { atomicWriteJson, readJsonFile, withStorageTransaction } from './persistence'
import { migrateTaskIndex, type TaskIndexDocument } from './store'

type Persisted = {
  issues: Issue[]
  runs: Run[]
  comments: Comment[]
  nextIdentifier: number
  /** Explicit retention deletes must survive a later task projection. */
  deletedIssueIds?: string[]
  deletedTaskIds?: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function persistedFrom(raw: unknown): Persisted {
  if (raw !== undefined && !isRecord(raw)) throw new Error('Invalid Issue index')
  const value = isRecord(raw) ? raw : {}
  for (const field of ['issues', 'runs', 'comments']) {
    if (value[field] !== undefined && !Array.isArray(value[field])) throw new Error(`Invalid Issue index: ${field}`)
  }
  const deletedIssueIds = Array.isArray(value.deletedIssueIds)
    ? [...new Set(value.deletedIssueIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
    : undefined
  const deletedTaskIds = Array.isArray(value.deletedTaskIds)
    ? [...new Set(value.deletedTaskIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
    : undefined
  return {
    issues: Array.isArray(value.issues) ? value.issues as Issue[] : [],
    runs: Array.isArray(value.runs) ? value.runs as Run[] : [],
    comments: Array.isArray(value.comments) ? value.comments as Comment[] : [],
    nextIdentifier: typeof value.nextIdentifier === 'number' && Number.isFinite(value.nextIdentifier) && value.nextIdentifier > 0
      ? value.nextIdentifier
      : 1,
    ...(deletedIssueIds?.length ? { deletedIssueIds } : {}),
    ...(deletedTaskIds?.length ? { deletedTaskIds } : {})
  }
}

function clonePersisted(value: Persisted): Persisted {
  return JSON.parse(JSON.stringify(value)) as Persisted
}

function taskFingerprint(tasks: Task[]): string {
  return JSON.stringify(tasks, (_key, value: unknown) => isRecord(value)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]))
    : value)
}

/** Durable issue/run projection over the existing task execution store. */
export class IssueStore {
  private readonly userDataDir: string
  private readonly file: string
  private readonly taskIndexFile: string
  private data: Persisted = { issues: [], runs: [], comments: [], nextIdentifier: 1 }
  private lastTaskFingerprint = ''
  private latestTasks = new Map<string, Task>()
  private pendingProjection = new Map<string, Task>()
  private projectionTimer: NodeJS.Timeout | undefined
  private projectionRetryMs = 250
  private closed = false

  constructor(userDataDir: string) {
    this.userDataDir = userDataDir
    this.file = path.join(userDataDir, 'issues', 'index.json')
    this.taskIndexFile = path.join(userDataDir, 'tasks', 'tasks.json')
    this.data = withStorageTransaction(this.userDataDir, () => {
      const current = this.readDataLocked()
      if (this.backfillIssueIds(current)) atomicWriteJson(this.file, current)
      return current
    })
  }

  private readDataLocked(): Persisted {
    return persistedFrom(readJsonFile<unknown>(this.file, undefined))
  }

  private readProjectionTasksLocked(fallback: Task[]): { tasks: Task[]; document?: TaskIndexDocument } {
    const raw = readJsonFile<unknown>(this.taskIndexFile, undefined)
    if (raw === undefined) return { tasks: fallback }
    const document = migrateTaskIndex(raw, Date.now(), { recoverRunning: false })
    const currentIds = new Set(document.tasks.map((task) => task.id))
    return { document, tasks: [...(document.pendingIssueProjections ?? []).filter((task) => currentIds.has(task.id)), ...document.tasks] }
  }

  private backfillIssueIds(data: Persisted): boolean {
    const used = new Set(data.issues.map((issue) => issue.id).filter(Boolean))
    let patched = false
    for (const issue of data.issues) {
      if (issue.id) continue
      issue.id = issue.taskId && !used.has(`iss_${issue.taskId}`) ? `iss_${issue.taskId}` : this.id('iss')
      used.add(issue.id)
      patched = true
    }
    return patched
  }

  private id(prefix: string) { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}` }

  private findIssue(data: Persisted, id: string) {
    return data.issues.find((issue) => issue.id === id || issue.identifier === id)
  }

  private rebuildLatestTasks(tasks: Task[]) {
    this.latestTasks.clear()
    for (const task of tasks) {
      if (task.suppressIssue) continue
      const key = task.issueId ?? `iss_${task.id}`
      const current = this.latestTasks.get(key)
      if (!current || task.createdAt >= current.createdAt) this.latestTasks.set(key, task)
    }
  }

  /** Rebuild the projection from committed task snapshots. */
  sync(tasks: Task[]) {
    withStorageTransaction(this.userDataDir, () => {
      const { tasks: committedTasks, document } = this.readProjectionTasksLocked(tasks)
      const fingerprint = taskFingerprint(committedTasks)
      const current = this.readDataLocked()

      // Reads still refresh local state. A different IssueStore instance may
      // have committed comments or metadata since the previous projection.
      if (fingerprint === this.lastTaskFingerprint && !document?.pendingIssueProjections?.length) {
        this.data = current
        this.rebuildLatestTasks(committedTasks)
        return
      }

      const next = clonePersisted(current)
      this.projectTasks(next, committedTasks)
      if (JSON.stringify(next) !== JSON.stringify(current)) atomicWriteJson(this.file, next)
      // Acknowledgement follows the Issue commit. Replaying after an ack write
      // failure finds the same run/report identities and cannot duplicate them.
      if (document?.pendingIssueProjections?.length) {
        delete document.pendingIssueProjections
        atomicWriteJson(this.taskIndexFile, document)
      }

      // A failed write leaves both the old fingerprint and the old in-memory
      // snapshot intact, so the next sync retries the same projection.
      this.data = next
      this.lastTaskFingerprint = fingerprint
      this.rebuildLatestTasks(committedTasks)
    })
  }

  /** Projection failure must not fail an already committed execution or creation. */
  syncEventually(tasks: Task[]) {
    if (this.closed) return
    try {
      this.sync(tasks)
      this.pendingProjection.clear()
      clearTimeout(this.projectionTimer)
      this.projectionTimer = undefined
      this.projectionRetryMs = 250
    } catch (error) {
      for (const task of tasks) this.pendingProjection.set(task.id + ':' + executionRecordFromTask(task).id, structuredClone(task))
      console.error('[IssueStore] Projection pending; committed tasks retained', error)
      if (!this.projectionTimer) {
        this.projectionTimer = setTimeout(() => {
          this.projectionTimer = undefined
          this.syncEventually([...this.pendingProjection.values()])
        }, this.projectionRetryMs)
        this.projectionTimer.unref()
        this.projectionRetryMs = Math.min(this.projectionRetryMs * 2, 5000)
      }
    }
  }

  syncTaskEventually(task: Task, parent?: Task) {
    const latest = this.latestTasks.get(task.issueId ?? 'iss_' + task.id)
    this.lastTaskFingerprint = ''
    this.syncEventually([...(latest && latest.id !== task.id ? [latest] : []), task, ...(parent ? [parent] : [])])
  }

  /**
   * Return the durable Issue when it is available, otherwise expose the same
   * stable task-derived identity that the next projection will persist.
   *
   * This is deliberately read-only. A failed projection must not make an IPC
   * creation request create a second Task just to manufacture an Issue.
   */
  issueForTask(task: Task): Issue {
    const issueId = task.issueId ?? `iss_${task.id}`
    try {
      const issue = this.get(issueId)
      if (issue) return issue
    } catch {
      // The committed Task is still the source of truth while the projection
      // is unavailable. Return the deterministic view below and let the retry
      // timer repair durable Issue state.
    }
    const delegated = !!task.parentTaskId
    return {
      id: issueId,
      identifier: `YOU-PENDING-${issueId}`,
      title: task.title,
      description: task.prompt,
      status: taskStatusToIssueStatus(task.status),
      priority: 'none',
      labels: delegated ? ['委派'] : [],
      position: task.createdAt,
      createdBy: delegated ? 'agent' : 'user',
      createdAt: task.createdAt,
      updatedAt: task.endedAt ?? task.createdAt,
      taskId: task.id,
      ...(task.agentId ? { assignee: { type: 'agent' as const, id: task.agentId } } : {})
    }
  }

  close() {
    this.closed = true
    clearTimeout(this.projectionTimer)
    this.projectionTimer = undefined
  }

  private projectTasks(data: Persisted, tasks: Task[]) {
    const deleted = new Set(data.deletedIssueIds ?? [])
    const deletedTasks = new Set(data.deletedTaskIds ?? [])
    const latestByIssue = new Map<string, Task>()
    for (const task of tasks) {
      if (task.suppressIssue) continue
      const key = task.issueId ?? `iss_${task.id}`
      const current = latestByIssue.get(key)
      if (!current || task.createdAt >= current.createdAt) latestByIssue.set(key, task)
    }

    for (const task of tasks) {
      if (task.suppressIssue) continue
      const issueId = task.issueId ?? `iss_${task.id}`
      if (deleted.has(issueId) || deletedTasks.has(task.id)) continue

      const existing = data.issues.find((issue) => issue.taskId === task.id || (!!task.issueId && issue.id === task.issueId))
      const isDelegated = !!task.parentTaskId
      const derivedStatus = taskStatusToIssueStatus(task.status)
      const status = existingStatus(data.issues, task.id, task.status, derivedStatus, task.issueId)
      const isLatest = latestByIssue.get(issueId)?.id === task.id

      if (!existing) {
        const issue: Issue = {
          id: issueId,
          identifier: `YOU-${data.nextIdentifier++}`,
          title: task.title,
          description: task.prompt,
          status,
          priority: 'none',
          labels: isDelegated ? ['委派'] : [],
          position: task.createdAt,
          createdBy: isDelegated ? 'agent' : 'user',
          createdAt: task.createdAt,
          updatedAt: task.endedAt ?? task.createdAt,
          taskId: task.id
        }
        if (task.agentId) issue.assignee = { type: 'agent', id: task.agentId }
        data.issues.push(issue)
      } else {
        const patch: Partial<Issue> = {}
        if (isLatest && existing.taskId !== task.id) patch.taskId = task.id
        if (isLatest && existing.title !== task.title) patch.title = task.title
        if (isLatest && existing.description !== task.prompt) patch.description = task.prompt
        if (isLatest && existing.status !== status) patch.status = status
        if (isLatest && task.agentId && existing.assignee?.id !== task.agentId) patch.assignee = { type: 'agent', id: task.agentId }
        if (isDelegated && existing.createdBy !== 'agent') patch.createdBy = 'agent'
        if (isDelegated && !existing.labels.includes('委派')) patch.labels = [...existing.labels, '委派']
        if (Object.keys(patch).length) Object.assign(existing, patch, { updatedAt: Date.now() })
      }

      const issue = data.issues.find((item) => item.taskId === task.id) ?? data.issues.find((item) => item.id === issueId)
      if (!issue || (task.status === 'queued' && !task.runId)) continue

      const execution = executionRecordFromTask(task)
      const run: Run = { ...execution, issueId: issue.id }
      const currentRun = data.runs.find((item) => item.id === run.id)
      if (currentRun) Object.assign(currentRun, run)
      else data.runs.push(run)

      if (task.status !== 'done' && task.status !== 'failed') continue
      const reportText = task.status === 'done' ? task.result?.trim() : task.error?.trim()
      const reportContent = task.status === 'done'
        ? reportText
        : reportText ? `Agent execution error: ${reportText}` : 'Agent execution error'
      const report = data.comments.find((item) => item.issueId === issue.id && item.author.type === 'agent' && item.runId === run.id)
      const expectedAuthorId = task.agentId ?? task.backend
      // Legacy comments have no runId. Claim one only when the producing
      // agent and the terminal timestamp both prove that it belongs to this
      // execution. Multiple matching comments are ambiguous and remain
      // untouched; this run receives its own report instead.
      const legacyReports = !report && reportContent && typeof task.endedAt === 'number'
        ? data.comments.filter((item) => item.issueId === issue.id
          && item.author.type === 'agent'
          && item.author.id === expectedAuthorId
          && !item.runId
          && item.content === reportContent
          && item.createdAt === task.endedAt)
        : []
      const legacyReport = legacyReports.length === 1 ? legacyReports[0] : undefined
      if (report) {
        if (reportContent !== report.content) report.content = reportContent ?? ''
      } else if (legacyReport) {
        // A legacy report can only be claimed by this one execution. Once it
        // has a runId, an identical later run receives its own report.
        legacyReport.runId = run.id
      } else if ((task.status === 'done' || task.status === 'failed') && reportContent) {
        data.comments.push({
          id: this.id('com'),
          issueId: issue.id,
          author: { type: 'agent', id: task.agentId ?? task.backend },
          content: reportContent,
          reactions: [],
          runId: run.id,
          createdAt: task.endedAt ?? Date.now()
        })
      }
    }

    // Parent links are part of the Issue projection, while Task remains the
    // scheduling source of truth.
    for (const task of tasks) {
      if (task.suppressIssue || !task.parentTaskId) continue
      const child = data.issues.find((item) => item.taskId === task.id || item.id === task.issueId)
      const parent = tasks.find((item) => item.id === task.parentTaskId)
      const parentIssue = parent && data.issues.find((item) => item.taskId === parent.id || item.id === parent.issueId)
      if (child && parentIssue && child.parentIssueId !== parentIssue.id) {
        child.parentIssueId = parentIssue.id
        child.updatedAt = Date.now()
      }
    }
  }

  /** Apply one task change without rebuilding unrelated Issues. */
  syncTask(task: Task, parent?: Task) {
    if (task.suppressIssue) return
    const key = task.issueId ?? `iss_${task.id}`
    const latest = this.latestTasks.get(key)
    const candidates = [
      ...(latest && latest.id !== task.id ? [latest] : []),
      task,
      ...(parent ? [parent] : [])
    ]
    this.lastTaskFingerprint = ''
    this.sync(candidates)
  }

  deleteIssue(id: string): boolean {
    return withStorageTransaction(this.userDataDir, () => {
      const current = this.readDataLocked()
      const issue = current.issues.find((item) => item.id === id)
      if (!issue) {
        this.data = current
        return false
      }
      const next = clonePersisted(current)
      next.issues = next.issues.filter((item) => item.id !== id)
      next.runs = next.runs.filter((run) => run.issueId !== id)
      next.comments = next.comments.filter((comment) => comment.issueId !== id)
      next.deletedIssueIds = [...new Set([...(next.deletedIssueIds ?? []), id])]
      next.deletedTaskIds = [...new Set([...(next.deletedTaskIds ?? []), issue.taskId])]
      atomicWriteJson(this.file, next)
      this.data = next
      this.latestTasks.delete(id)
      this.lastTaskFingerprint = ''
      return true
    })
  }

  list() {
    this.data = this.readDataLocked()
    return [...this.data.issues].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get(id: string) {
    this.data = this.readDataLocked()
    return this.findIssue(this.data, id)
  }

  runs(issueId: string) {
    this.data = this.readDataLocked()
    return this.data.runs.filter((run) => run.issueId === issueId).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
  }

  /** Return the most recent projected run for a compatibility task. */
  runForTask(taskId: string) {
    this.data = this.readDataLocked()
    return this.data.runs
      .filter((run) => run.taskId === taskId)
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0]
  }

  comments(issueId: string) {
    this.data = this.readDataLocked()
    return this.data.comments.filter((comment) => comment.issueId === issueId).sort((a, b) => a.createdAt - b.createdAt)
  }

  addComment(issueId: string, content: string, author: { type: 'agent' | 'user'; id: string } = { type: 'user', id: 'user' }): Comment | null {
    if (!content.trim()) return null
    return withStorageTransaction(this.userDataDir, () => {
      const current = this.readDataLocked()
      const issue = this.findIssue(current, issueId)
      if (!issue) {
        // 暗坑补灯：返回 null 是"未送达"而非"已送达但没人看"——必须留下可查的痕迹，
        // 调用方据此降级到任务证据/事件通道
        console.warn(`[issue-store] addComment dropped: issue ${issueId} not found (${content.length} chars discarded)`)
        this.data = current
        return null
      }
      const next = clonePersisted(current)
      const nextIssue = this.findIssue(next, issue.id)!
      const comment: Comment = { id: this.id('com'), issueId: nextIssue.id, author, content: content.trim(), reactions: [], createdAt: Date.now() }
      next.comments.push(comment)
      nextIssue.updatedAt = comment.createdAt
      atomicWriteJson(this.file, next)
      this.data = next
      return comment
    })
  }

  updateMetadata(id: string, patch: { priority?: IssuePriority; labels?: string[]; dueDate?: number }) {
    return this.updateIssue(id, patch)
  }

  updateWorkflow(id: string, status: IssueStatus) {
    return this.updateIssue(id, { status })
  }

  /** Combined IPC update retained for callers that change workflow and metadata together. */
  update(id: string, patch: { priority?: IssuePriority; labels?: string[]; dueDate?: number; status?: IssueStatus }) {
    return this.updateIssue(id, patch)
  }

  private updateIssue(id: string, patch: { priority?: IssuePriority; labels?: string[]; dueDate?: number; status?: IssueStatus }) {
    return withStorageTransaction(this.userDataDir, () => {
      const current = this.readDataLocked()
      const issue = this.findIssue(current, id)
      if (!issue) {
        this.data = current
        return null
      }
      const next = clonePersisted(current)
      const nextIssue = this.findIssue(next, issue.id)!
      this.applyMetadata(nextIssue, patch)
      if (patch.status) {
        nextIssue.status = patch.status
        nextIssue.statusOverride = patch.status
      }
      nextIssue.updatedAt = Date.now()
      atomicWriteJson(this.file, next)
      this.data = next
      return nextIssue
    })
  }

  private applyMetadata(issue: Issue, patch: { priority?: IssuePriority; labels?: string[]; dueDate?: number }) {
    if (patch.priority) issue.priority = priorityForIssue(patch.priority)
    if (patch.labels) issue.labels = [...new Set(patch.labels.map((label) => label.trim()).filter(Boolean))].slice(0, 20)
    if (patch.dueDate !== undefined) issue.dueDate = patch.dueDate > 0 ? patch.dueDate : undefined
  }
}

function existingStatus(issues: Issue[], taskId: string, taskStatus: Task['status'], derived: IssueStatus, issueId?: string): IssueStatus {
  const issue = issues.find((item) => item.taskId === taskId || (!!issueId && item.id === issueId))
  // A human workflow choice is durable. An active execution is the only
  // transient state allowed to surface over it.
  if (issue?.statusOverride && taskStatus !== 'running') return issue.statusOverride
  return derived
}

export function priorityForIssue(value: unknown): IssuePriority {
  return value === 'urgent' || value === 'high' || value === 'medium' || value === 'low' ? value : 'none'
}
