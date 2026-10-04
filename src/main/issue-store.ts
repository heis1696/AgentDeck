import fs from 'node:fs'
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
  /** 指纹与投影文档的磁盘身份绑定：身份未变即文档未变，免重算 13MB 排序键指纹 */
  private fingerprintIdentity: string | undefined
  /** 投影文档缓存：任务索引文件身份未变时复用已解析文档，免 13MB 重读重解析 */
  private projectionCache: { identity: string; document: TaskIndexDocument } | undefined
  /** issues/index.json 磁盘身份：与 this.data 配对，他进程写盘（或本进程落盘）即失效 */
  private dataIdentity: string | undefined
  private latestTasks = new Map<string, Task>()
  private pendingProjection = new Map<string, Task>()
  private projectionTimer: NodeJS.Timeout | undefined
  private projectionRetryMs = 250
  private closed = false
  private readonly taskDocumentProvider: (() => { identity: string; document: TaskIndexDocument }) | undefined
  private readonly taskIndexWrittenNotifier: (() => void) | undefined

  /** taskDocument 提供方（主/sidecar 进程内接线 TaskStore 权威文档口）：命中即免读盘；
   *  缺省回退到自身按文件身份的解析缓存，独立构造（smoke/独立实例）行为不变。
   *  noteTaskIndexWritten 配套回执通道：provider 模式下回执写盘后由 TaskStore 重配对
   *  缓存身份（内容即其共享文档），双方都免去一次全量重载。 */
  constructor(userDataDir: string, options: { taskDocument?: () => { identity: string; document: TaskIndexDocument }; noteTaskIndexWritten?: () => void } = {}) {
    this.userDataDir = userDataDir
    this.file = path.join(userDataDir, 'issues', 'index.json')
    this.taskIndexFile = path.join(userDataDir, 'tasks', 'tasks.json')
    this.taskDocumentProvider = options.taskDocument
    this.taskIndexWrittenNotifier = options.noteTaskIndexWritten
    this.data = withStorageTransaction(this.userDataDir, () => {
      const current = this.readDataLocked()
      if (this.backfillIssueIds(current)) this.writeDataLocked(current)
      return current
    })
  }

  /** 与 TaskStore 同构的复合磁盘身份（dev:ino:size:mtimeMs）；不可读视为已变。 */
  private fileIdentity(file: string): string | undefined {
    try {
      const stat = fs.statSync(file, { bigint: true })
      return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`
    } catch {
      return undefined
    }
  }

  private readDataLocked(): Persisted {
    const identity = this.fileIdentity(this.file)
    if (this.dataIdentity !== undefined && identity === this.dataIdentity) return this.data
    const current = persistedFrom(readJsonFile<unknown>(this.file, undefined))
    this.data = current
    this.dataIdentity = identity
    return current
  }

  /** 统一落盘口：写后同步换新身份，紧随其后的读取不再重读 6.4MB。 */
  private writeDataLocked(next: Persisted): void {
    atomicWriteJson(this.file, next)
    this.data = next
    this.dataIdentity = this.fileIdentity(this.file)
  }

  /** 投影输入读取：优先进程内 TaskStore 权威文档（零读盘），否则按文件身份复用
   *  已解析文档；身份变化（本进程事务落盘或 sidecar 写盘）才真正重读重解析。
   *  tasks.json 缺失时投影输入只能是调用方传入的 fallback 数组——没有磁盘身份可锚定，
   *  identity 返回 undefined，指纹门对其失效（每次现算，等同旧行为）。 */
  private readProjectionTasksLocked(fallback: Task[]): { tasks: Task[]; document?: TaskIndexDocument; identity?: string; fromProvider: boolean } {
    const provided = this.taskDocumentProvider?.()
    if (provided && provided.identity) {
      const document = provided.document
      const currentIds = new Set(document.tasks.map((task) => task.id))
      const tasks = [...(document.pendingIssueProjections ?? []).filter((task) => currentIds.has(task.id)), ...document.tasks]
      return { tasks, document, identity: provided.identity, fromProvider: true }
    }
    const identity = this.fileIdentity(this.taskIndexFile)
    if (identity && this.projectionCache?.identity === identity) {
      const document = this.projectionCache.document
      const currentIds = new Set(document.tasks.map((task) => task.id))
      const tasks = [...(document.pendingIssueProjections ?? []).filter((task) => currentIds.has(task.id)), ...document.tasks]
      return { tasks, document, identity, fromProvider: false }
    }
    const raw = readJsonFile<unknown>(this.taskIndexFile, undefined)
    if (raw === undefined) return { tasks: fallback, fromProvider: false }
    const document = migrateTaskIndex(raw, Date.now(), { recoverRunning: false })
    const currentIds = new Set(document.tasks.map((task) => task.id))
    if (identity) this.projectionCache = { identity, document }
    return { document, tasks: [...(document.pendingIssueProjections ?? []).filter((task) => currentIds.has(task.id)), ...document.tasks], identity, fromProvider: false }
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
      const { tasks: committedTasks, document, identity, fromProvider } = this.readProjectionTasksLocked(tasks)
      const fingerprint = identity !== undefined && this.fingerprintIdentity === identity ? this.lastTaskFingerprint : taskFingerprint(committedTasks)
      const current = this.readDataLocked()

      // Reads still refresh local state. A different IssueStore instance may
      // have committed comments or metadata since the previous projection.
      if (fingerprint === this.lastTaskFingerprint && !document?.pendingIssueProjections?.length) {
        this.data = current
        // 内容等价的索引改写（如 TaskStore 同内容落盘）也要认领新身份：
        // 否则身份门永远判「变过」，每次 sync 都重算一遍 13MB 指纹
        this.fingerprintIdentity = identity
        this.rebuildLatestTasks(committedTasks)
        return
      }

      const next = clonePersisted(current)
      this.projectTasks(next, committedTasks)
      if (JSON.stringify(next) !== JSON.stringify(current)) this.writeDataLocked(next)
      // Acknowledgement follows the Issue commit. Replaying after an ack write
      // failure finds the same run/report identities and cannot duplicate them.
      if (document?.pendingIssueProjections?.length) {
        const acknowledged = document.pendingIssueProjections
        delete document.pendingIssueProjections
        try {
          atomicWriteJson(this.taskIndexFile, document)
        } catch (error) {
          // 回执写失败回滚内存字段：provider 路径下 document 是 TaskStore 的共享缓存
          // 文档，提前删除会让下一次 sync 误判「无待回执」而永久丢失回执队列
          document.pendingIssueProjections = acknowledged
          throw error
        }
        if (fromProvider) {
          // provider 模式：写盘内容即 TaskStore 共享文档，通知其重配对缓存身份，
          // 双方都免去一次全量重载；自身无需维护 projectionCache（永不走该分支读）
          this.taskIndexWrittenNotifier?.()
        } else {
          this.projectionCache = { identity: this.fileIdentity(this.taskIndexFile) ?? '', document }
        }
      }

      // A failed write leaves both the old fingerprint and the old in-memory
      // snapshot intact, so the next sync retries the same projection.
      this.data = next
      this.lastTaskFingerprint = fingerprint
      this.fingerprintIdentity = identity
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
    type IndexedIssue = { issue: Issue; order: number }
    const issuesById = new Map<string, IndexedIssue>()
    const taskIdHeaps = new Map<string, IndexedIssue[]>()
    const pushTaskIdCandidate = (entry: IndexedIssue) => {
      const key = entry.issue.taskId
      if (key === undefined) return
      const heap = taskIdHeaps.get(key) ?? []
      let index = heap.length
      heap.push(entry)
      while (index > 0) {
        const parent = Math.floor((index - 1) / 2)
        if (heap[parent].order <= entry.order) break
        heap[index] = heap[parent]
        index = parent
      }
      heap[index] = entry
      taskIdHeaps.set(key, heap)
    }
    const firstIssueByTaskId = (taskId: string) => {
      const heap = taskIdHeaps.get(taskId)
      while (heap?.length && heap[0].issue.taskId !== taskId) {
        const tail = heap.pop()!
        if (!heap.length) break
        let index = 0
        while (true) {
          const left = index * 2 + 1
          const right = left + 1
          if (left >= heap.length) break
          const child = right < heap.length && heap[right].order < heap[left].order ? right : left
          if (heap[child].order >= tail.order) break
          heap[index] = heap[child]
          index = child
        }
        heap[index] = tail
      }
      return heap?.[0]
    }
    const findProjectionIssue = (taskId: string, issueId?: string, includeEmptyIssueId = false) => {
      const byTask = firstIssueByTaskId(taskId)
      const byId = issueId !== undefined && (includeEmptyIssueId || !!issueId) ? issuesById.get(issueId) : undefined
      return byTask && byId ? (byTask.order <= byId.order ? byTask : byId) : byTask ?? byId
    }
    const addIssueIndex = (issue: Issue, order: number) => {
      const entry = { issue, order }
      if (!issuesById.has(issue.id)) issuesById.set(issue.id, entry)
      pushTaskIdCandidate(entry)
      return entry
    }
    for (let index = 0; index < data.issues.length; index++) addIssueIndex(data.issues[index], index)

    const runsById = new Map<string, Run>()
    for (const run of data.runs) if (!runsById.has(run.id)) runsById.set(run.id, run)
    const taskById = new Map<string, Task>()
    for (const task of tasks) if (!taskById.has(task.id)) taskById.set(task.id, task)

    const reportKey = (issueId: string, runId: string) => JSON.stringify([issueId, runId])
    const legacyReportKey = (issueId: string, authorId: string, content: string, createdAt: number) => JSON.stringify([issueId, authorId, content, String(createdAt)])
    const reportsByRun = new Map<string, Comment>()
    const legacyReportsByMatch = new Map<string, Comment[]>()
    for (const comment of data.comments) {
      if (comment.author.type !== 'agent') continue
      if (comment.runId !== undefined) {
        const key = reportKey(comment.issueId, comment.runId)
        if (!reportsByRun.has(key)) reportsByRun.set(key, comment)
      }
      if (!comment.runId) {
        const key = legacyReportKey(comment.issueId, comment.author.id, comment.content, comment.createdAt)
        const matching = legacyReportsByMatch.get(key) ?? []
        matching.push(comment)
        legacyReportsByMatch.set(key, matching)
      }
    }

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

      const existingEntry = findProjectionIssue(task.id, task.issueId)
      const existing = existingEntry?.issue
      const isDelegated = !!task.parentTaskId
      const derivedStatus = taskStatusToIssueStatus(task.status)
      const status = existingStatus(existing, task.status, derivedStatus)
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
        addIssueIndex(issue, data.issues.length)
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
        if (Object.keys(patch).length) {
          const previousTaskId = existing.taskId
          Object.assign(existing, patch, { updatedAt: Date.now() })
          if (previousTaskId !== existing.taskId && existingEntry) pushTaskIdCandidate(existingEntry)
        }
      }

      const issue = firstIssueByTaskId(task.id)?.issue ?? issuesById.get(issueId)?.issue
      if (!issue || (task.status === 'queued' && !task.runId)) continue

      const execution = executionRecordFromTask(task)
      const run: Run = { ...execution, issueId: issue.id }
      const currentRun = runsById.get(run.id)
      if (currentRun) Object.assign(currentRun, run)
      else {
        data.runs.push(run)
        runsById.set(run.id, run)
      }

      if (task.status !== 'done' && task.status !== 'failed') continue
      const reportText = task.status === 'done' ? task.result?.trim() : task.error?.trim()
      const reportContent = task.status === 'done'
        ? reportText
        : reportText ? `Agent execution error: ${reportText}` : 'Agent execution error'
      const runReportKey = reportKey(issue.id, run.id)
      const report = reportsByRun.get(runReportKey)
      const expectedAuthorId = task.agentId ?? task.backend
      // Legacy comments have no runId. Claim one only when the producing
      // agent and the terminal timestamp both prove that it belongs to this
      // execution. Multiple matching comments are ambiguous and remain
      // untouched; this run receives its own report instead.
      const legacyKey = !report && reportContent && typeof task.endedAt === 'number'
        ? legacyReportKey(issue.id, expectedAuthorId, reportContent, task.endedAt)
        : undefined
      const legacyReports = legacyKey ? legacyReportsByMatch.get(legacyKey) ?? [] : []
      const legacyReport = legacyReports.length === 1 ? legacyReports[0] : undefined
      if (report) {
        if (reportContent !== report.content) report.content = reportContent ?? ''
      } else if (legacyReport) {
        // A legacy report can only be claimed by this one execution. Once it
        // has a runId, an identical later run receives its own report.
        legacyReport.runId = run.id
        legacyReportsByMatch.delete(legacyKey!)
        reportsByRun.set(runReportKey, legacyReport)
      } else if ((task.status === 'done' || task.status === 'failed') && reportContent) {
        const comment: Comment = {
          id: this.id('com'),
          issueId: issue.id,
          author: { type: 'agent', id: task.agentId ?? task.backend },
          content: reportContent,
          reactions: [],
          runId: run.id,
          createdAt: task.endedAt ?? Date.now()
        }
        data.comments.push(comment)
        reportsByRun.set(runReportKey, comment)
      }
    }

    // Parent links are part of the Issue projection, while Task remains the
    // scheduling source of truth.
    for (const task of tasks) {
      if (task.suppressIssue || !task.parentTaskId) continue
      const child = findProjectionIssue(task.id, task.issueId)?.issue
      const parent = taskById.get(task.parentTaskId)
      const parentIssue = parent && findProjectionIssue(parent.id, parent.issueId, true)?.issue
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
      this.writeDataLocked(next)
      this.latestTasks.delete(id)
      this.lastTaskFingerprint = ''
      this.fingerprintIdentity = undefined
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

  addComment(issueId: string, content: string, author: { type: 'agent' | 'user'; id: string } = { type: 'user', id: 'user' }, source?: { meetingId?: string; sourceTurnId?: string }): Comment | null {
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
      const duplicate = source?.meetingId && source.sourceTurnId ? current.comments.find((comment) => comment.issueId === issue.id && comment.meetingId === source.meetingId && comment.sourceTurnId === source.sourceTurnId) : undefined
      if (duplicate) { this.data = current; return duplicate }
      const next = clonePersisted(current)
      const nextIssue = this.findIssue(next, issue.id)!
      const comment: Comment = { id: this.id('com'), issueId: nextIssue.id, author, content: content.trim(), reactions: [], createdAt: Date.now(), ...(source?.meetingId ? { meetingId: source.meetingId, sourceTurnId: source.sourceTurnId } : {}) }
      next.comments.push(comment)
      nextIssue.updatedAt = comment.createdAt
      this.writeDataLocked(next)
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
      this.writeDataLocked(next)
      return nextIssue
    })
  }

  private applyMetadata(issue: Issue, patch: { priority?: IssuePriority; labels?: string[]; dueDate?: number }) {
    if (patch.priority) issue.priority = priorityForIssue(patch.priority)
    if (patch.labels) issue.labels = [...new Set(patch.labels.map((label) => label.trim()).filter(Boolean))].slice(0, 20)
    if (patch.dueDate !== undefined) issue.dueDate = patch.dueDate > 0 ? patch.dueDate : undefined
  }

  deleteMeetingComments(meetingId: string): void {
    withStorageTransaction(this.userDataDir, () => {
      const current = this.readDataLocked()
      const next = clonePersisted(current)
      next.comments = next.comments.filter((comment) => comment.meetingId !== meetingId)
      this.writeDataLocked(next)
    })
  }
}

function existingStatus(issue: Issue | undefined, taskStatus: Task['status'], derived: IssueStatus): IssueStatus {
  // A human workflow choice is durable. An active execution is the only
  // transient state allowed to surface over it.
  if (issue?.statusOverride && taskStatus !== 'running') return issue.statusOverride
  return derived
}

export function priorityForIssue(value: unknown): IssuePriority {
  return value === 'urgent' || value === 'high' || value === 'medium' || value === 'low' ? value : 'none'
}
