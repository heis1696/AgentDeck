// 文件存储：userData/tasks.json（索引）+ userData/tasks/<id>/events.jsonl（日志流）
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { isTaskEventDurable, isTaskStatus, type Task, type TaskEvent, type IntegrationInfo, type ExecutionOwner, type TaskStatus, type TaskGitOperation } from '../shared/types'
import { executionRecordFromTask } from '../shared/taskflow'
import { EventLog } from './event-log'
import { atomicWriteJson, readJsonFile, withStorageTransaction, assertSynchronousAction, assertTransactionToken, processOwnerState, createExecutionOwner, type SynchronousAction, type TransactionToken } from './persistence'

/** Version of the task index envelope, independent from per-task snapshots. */
export const TASK_INDEX_SCHEMA_VERSION = 1 as const

export interface TaskIndexDocument {
  schemaVersion: typeof TASK_INDEX_SCHEMA_VERSION
  tasks: Task[]
  deletedDedupeKeys?: string[]
  /** Terminal runs awaiting an idempotent Issue projection acknowledgement. */
  pendingIssueProjections?: Task[]
  pendingTaskSnapshots?: string[]
  pendingTaskDeletes?: string[]
}

type LegacyTask = Partial<Task> & {
  mode?: string
  squad?: { integrationBranch?: string; integrationNote?: string }
}

/** Current on-disk Task shape. Unknown keys must not become implicit schema. */
const TASK_INDEX_FIELDS = [
  'id', 'title', 'prompt', 'workdir', 'backend', 'agentId', 'trigger', 'issueId',
  'suppressIssue', 'runId', 'executionOwner', 'gitOperation', 'goalId', 'phaseIndex', 'parentTaskId', 'workerIndex', 'integration', 'status',
  'createdAt', 'startedAt', 'endedAt', 'result', 'error', 'failure', 'attempt',
  'roundsUsed', 'handoff', 'continuesFrom', 'parked', 'manualStartConfirmedAt', 'backgroundRunning', 'titleAuto', 'sessionId',
  'gitDiff', 'gitStat', 'gitSnapshot', 'usage', 'eventCount', 'unavailableReason', 'worktree', 'workVersion', 'dedupeKey'
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Migrate one index entry. `sourceVersion` is explicit: legacy fields are
 * only interpreted for version 0, so future schema additions do not grow an
 * implicit compatibility branch.
 */
export function migrateTaskRecord(raw: unknown, sourceVersion = 0, now = Date.now(), options: { recoverRunning?: boolean } = {}): Task | null {
  if (!isRecord(raw)) return null
  const old = raw as LegacyTask
  const out: Record<string, unknown> = {}
  for (const field of TASK_INDEX_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(raw, field)) out[field] = raw[field]
  }
  if (typeof out.id !== 'string' || !out.id.trim()) return null

  // Fields introduced before the first explicit schema version.
  if (sourceVersion < TASK_INDEX_SCHEMA_VERSION) {
    delete out.mode
    const squad = isRecord(old.squad) ? old.squad : undefined
    if (squad) {
      const integration: IntegrationInfo = {}
      if (typeof squad.integrationBranch === 'string' && squad.integrationBranch) integration.branch = squad.integrationBranch
      if (typeof squad.integrationNote === 'string' && squad.integrationNote) integration.note = squad.integrationNote
      if (integration.branch || integration.note) out.integration = integration
    }
    // Always remove the legacy container, including malformed values. The
    // versioned shape must never retain an implicit compatibility field.
    delete out.squad
  } else {
    // These fields are not part of the versioned shape. Drop them even when a
    // hand-edited/current index still contains them, without interpreting
    // their values as another compatibility format.
    delete out.mode
    delete out.squad
  }

  // Older indexes may omit fields introduced after the initial schema.
  if (typeof out.eventCount !== 'number' || !Number.isFinite(out.eventCount) || out.eventCount < 0) out.eventCount = 0
  if (typeof out.workdir !== 'string') out.workdir = ''
  if (typeof out.backend !== 'string' || !out.backend) out.backend = 'zcode'
  if (!isTaskStatus(out.status)) out.status = 'queued'
  if (typeof out.manualStartConfirmedAt !== 'number' || !Number.isFinite(out.manualStartConfirmedAt) || out.manualStartConfirmedAt <= 0) delete out.manualStartConfirmedAt

  // A running task cannot survive an application restart. This recovery is
  // deliberately idempotent: the persisted result is terminal on next load.
  if (out.status === 'running' && options.recoverRunning !== false) {
    const hadLegacySquad = sourceVersion < TASK_INDEX_SCHEMA_VERSION && isRecord(old.squad)
    out.status = 'failed'
    if (typeof out.error !== 'string' || !out.error) {
      out.error = hadLegacySquad ? '旧版协同任务在升级后中断，请重新运行' : '应用重启导致任务中断，请重新运行'
    }
    if (typeof out.endedAt !== 'number' || !Number.isFinite(out.endedAt)) out.endedAt = now
  }

  // Rebuild in a deterministic key order so the first migration and every
  // subsequent load produce byte-identical JSON.
  const canonical: Record<string, unknown> = {}
  for (const field of TASK_INDEX_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(out, field)) canonical[field] = out[field]
  }
  return canonical as unknown as Task
}

/**
 * Parse both the pre-versioned array and the current envelope. The returned
 * document always uses the current shape; callers can compare it with the
 * source to decide whether an atomic rewrite is needed.
 */
export function migrateTaskIndex(raw: unknown, now = Date.now(), options: { recoverRunning?: boolean } = {}): TaskIndexDocument {
  let sourceVersion = 0
  let entries: unknown[] = []
  if (Array.isArray(raw)) {
    entries = raw
  } else if (isRecord(raw)) {
    if (!Array.isArray(raw.tasks)) throw new Error('Invalid task index: expected tasks array')
    if (!Object.prototype.hasOwnProperty.call(raw, 'schemaVersion')) {
      throw new Error('Invalid task index: missing schema version')
    }
    const value = raw.schemaVersion
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new Error('Invalid task index schema version')
    }
    sourceVersion = value
    entries = raw.tasks
  } else {
    throw new Error('Invalid task index: expected array or versioned document')
  }
  if (sourceVersion > TASK_INDEX_SCHEMA_VERSION) {
    throw new Error(`Unsupported task index schema version: ${sourceVersion}`)
  }
  return {
    schemaVersion: TASK_INDEX_SCHEMA_VERSION,
    ...(isRecord(raw) && Array.isArray(raw.deletedDedupeKeys) ? { deletedDedupeKeys: raw.deletedDedupeKeys.filter((key): key is string => typeof key === 'string') } : {}),
    ...(isRecord(raw) && Array.isArray(raw.pendingIssueProjections) ? { pendingIssueProjections: raw.pendingIssueProjections.map((entry) => migrateTaskRecord(entry, sourceVersion, now, { recoverRunning: false })).filter((task): task is Task => task !== null) } : {}),
    ...(isRecord(raw) && Array.isArray(raw.pendingTaskSnapshots) ? { pendingTaskSnapshots: raw.pendingTaskSnapshots.filter((id): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(id)) } : {}),
    ...(isRecord(raw) && Array.isArray(raw.pendingTaskDeletes) ? { pendingTaskDeletes: raw.pendingTaskDeletes.filter((id): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(id)) } : {}),
    tasks: entries
      .map((entry) => migrateTaskRecord(entry, sourceVersion, now, options))
      .filter((task): task is Task => task !== null)
  }
}

export type TaskCreateRecord = Pick<Task, 'title' | 'prompt' | 'workdir' | 'backend'> & Partial<Pick<Task,
  'parentTaskId' | 'workerIndex' | 'integration' | 'agentId' | 'handoff' | 'continuesFrom' | 'parked' |
  'backgroundRunning' | 'suppressIssue' | 'trigger' | 'issueId' | 'goalId' | 'phaseIndex' | 'titleAuto' |
  'unavailableReason' | 'worktree' | 'workVersion' | 'dedupeKey'>>

export interface TaskExpectation {
  status?: TaskStatus | readonly TaskStatus[]
  runId?: string
  executionOwner?: ExecutionOwner
  parked?: boolean
  attempt?: number
  phaseIndex?: number
  startedAt?: number
  gitOperationToken?: string
  workdir?: string
  workVersion?: string
}

export interface GitOperationClaim extends TaskGitOperation { taskIds: string[] }

export function sameExecutionOwner(a: ExecutionOwner | undefined, b: ExecutionOwner | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  if (!isRecord(a) || !isRecord(b) || typeof a.pid !== 'number' || a.pid <= 0 || typeof a.instance !== 'string' || !a.instance || typeof a.token !== 'string' || !a.token) return false
  return a.pid === b.pid && a.instance === b.instance && a.token === b.token
}

function matchesTask(task: Task, expected: TaskExpectation): boolean {
  for (const key of Object.keys(expected) as Array<keyof TaskExpectation>) {
    if (key === 'status') {
      const statuses = expected.status
      if (Array.isArray(statuses) ? !statuses.includes(task.status) : task.status !== statuses) return false
    } else if (key === 'executionOwner') {
      if (!sameExecutionOwner(task.executionOwner, expected.executionOwner)) return false
    } else if (key === 'gitOperationToken') {
      if (task.gitOperation?.token !== expected.gitOperationToken) return false
    } else if (task[key] !== expected[key]) return false
  }
  return true
}

export interface TaskTransaction {
  get(id: string): Task | undefined
  list(): Task[]
  create(input: TaskCreateRecord): Task
  update(id: string, patch: Partial<Task>, expected?: TaskExpectation): Task | undefined
  delete(id: string, expected?: TaskExpectation): boolean
  appendEvent(id: string, event: Omit<TaskEvent, 'seq'>, expected?: TaskExpectation): TaskEvent | null
  appendEvents(id: string, events: readonly Omit<TaskEvent, 'seq'>[], expected?: TaskExpectation): TaskEvent[]
}

export class TaskStore {
  private readonly dir: string
  private readonly userDataDir: string
  private logs = new Map<string, EventLog>()
  private pendingSnapshots = new Set<string>()
  private pendingDeletes = new Set<string>()
  private pendingGitReleases = new Map<string, GitOperationClaim>()
  private indexTimer: NodeJS.Timeout | undefined
  private indexDirty = false
  private flushRetryDelayMs = 250
  private restartInterrupted: Task[] = []

  constructor(userDataDir: string, options: { recoverRunning?: boolean } = {}) {
    this.userDataDir = userDataDir
    this.dir = path.join(userDataDir, 'tasks')
    const document = this.readDocument()
    if (document.pendingTaskSnapshots?.length || document.pendingTaskDeletes?.length) this.scheduleFlush()
    if (options.recoverRunning === true) this.restartInterrupted = this.recoverDeadRuns('failed')
  }

  private indexFile() { return path.join(this.dir, 'tasks.json') }

  private taskDir(id: string) {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw new Error('Invalid task id')
    return path.join(this.dir, id)
  }

  private eventLog(id: string) {
    let log = this.logs.get(id)
    if (!log) {
      log = new EventLog(path.join(this.taskDir(id), 'events.jsonl'))
      this.logs.set(id, log)
    }
    return log
  }

  private readDocument(deriveCounts = true): TaskIndexDocument {
    const raw = readJsonFile<unknown>(this.indexFile(), undefined)
    const document = raw === undefined ? { schemaVersion: TASK_INDEX_SCHEMA_VERSION, tasks: [] } : migrateTaskIndex(raw, Date.now(), { recoverRunning: false })
    if (deriveCounts) for (const task of document.tasks) {
      const count = this.eventLog(task.id).count()
      if (task.eventCount !== count) {
        task.eventCount = count
        this.pendingSnapshots.add(task.id)
        this.indexDirty = true
        // JSONL is authoritative for events, including an append followed by
        // process exit before the delayed index/snapshot flush could run.
        this.scheduleFlush()
      }
    }
    return document
  }

  private saveIndex(document: TaskIndexDocument) {
    document.tasks.sort((a, b) => b.createdAt - a.createdAt)
    atomicWriteJson(this.indexFile(), document)
  }

  private scheduleFlush(delayMs = 25) {
    if (this.indexTimer) return
    this.indexTimer = setTimeout(() => {
      this.indexTimer = undefined
      try {
        this.flush()
      } catch (error) {
        console.error('[TaskStore] Background flush failed; pending writes retained', error)
      }
    }, delayMs)
    if (delayMs > 25) this.indexTimer.unref()
  }

  private retainSnapshotWork(document: TaskIndexDocument) {
    for (const id of document.pendingTaskSnapshots ?? []) this.pendingSnapshots.add(id)
    for (const id of document.pendingTaskDeletes ?? []) this.pendingDeletes.add(id)
    const currentIds = new Set(document.tasks.map((task) => task.id))
    document.pendingTaskSnapshots = [...this.pendingSnapshots].filter((id) => currentIds.has(id))
    document.pendingTaskDeletes = [...this.pendingDeletes].filter((id) => !currentIds.has(id))
    if (!document.pendingTaskSnapshots.length) delete document.pendingTaskSnapshots
    if (!document.pendingTaskDeletes.length) delete document.pendingTaskDeletes
  }

  private flushSnapshotsLocked(document: TaskIndexDocument) {
    this.retainSnapshotWork(document)
    const needsAcknowledgement = !!(document.pendingTaskSnapshots?.length || document.pendingTaskDeletes?.length)
    const tasks = new Map(document.tasks.map((task) => [task.id, task]))
    for (const id of this.pendingDeletes) {
      if (!tasks.has(id)) fs.rmSync(this.taskDir(id), { recursive: true, force: true })
      this.pendingDeletes.delete(id)
    }
    for (const id of this.pendingSnapshots) {
      const task = tasks.get(id)
      if (task) atomicWriteJson(path.join(this.taskDir(id), 'task.json'), task)
      this.pendingSnapshots.delete(id)
    }
    if (needsAcknowledgement) {
      delete document.pendingTaskSnapshots
      delete document.pendingTaskDeletes
      this.saveIndex(document)
    }
  }

  /** Every mutation starts with committed state; the view expires on return. */
  transaction<T>(action: SynchronousAction<T, TaskTransaction>): T {
    assertSynchronousAction(action)
    const work = ((token: TransactionToken) => {
      const document = this.readDocument()
      const tasks = new Map(document.tasks.map((task) => [task.id, task]))
      const touched = new Set<string>()
      const removed = new Set<string>()
      const deletedKeys = new Set(document.deletedDedupeKeys ?? [])
      const projectionKey = (task: Task) => JSON.stringify([task.id, executionRecordFromTask(task).id])
      const projections = new Map((document.pendingIssueProjections ?? []).map((task) => [projectionKey(task), task]))
      let changed = false
      const active = () => assertTransactionToken(token)
      const view: TaskTransaction = {
        get: (id) => { active(); return tasks.get(id) },
        list: () => { active(); return [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt) },
        create: (input) => {
          active()
          if (input.dedupeKey) {
            const existing = [...tasks.values()].find((task) => task.dedupeKey === input.dedupeKey)
            if (existing) return existing
            if (deletedKeys.has(input.dedupeKey)) throw new Error('Task request was explicitly deleted')
          }
          const task: Task = {
            id: 't_' + Date.now().toString(36) + '_' + randomUUID().replace(/-/g, '').slice(0, 12),
            title: input.title, prompt: input.prompt, workdir: input.workdir, backend: input.backend,
            status: 'queued', createdAt: Date.now(), eventCount: 0
          }
          const fields = ['parentTaskId', 'workerIndex', 'integration', 'agentId', 'handoff', 'continuesFrom', 'parked',
            'backgroundRunning', 'suppressIssue', 'trigger', 'issueId', 'goalId', 'phaseIndex', 'titleAuto',
            'unavailableReason', 'worktree', 'workVersion', 'dedupeKey'] as const
          for (const field of fields) {
            const value = input[field]
            if (value || typeof value === 'number') Object.assign(task, { [field]: value })
          }
          tasks.set(task.id, task)
          touched.add(task.id)
          changed = true
          return task
        },
        update: (id, patch, expected = {}) => {
          active()
          const task = tasks.get(id)
          if (!task || !matchesTask(task, expected)) return undefined
          if (patch.id !== undefined && patch.id !== id) throw new Error('Task identity is immutable')
          const contentFields: Array<keyof Task> = ['title', 'prompt', 'workdir', 'backend', 'agentId', 'handoff']
          const contentChanged = contentFields.some((field) => Object.prototype.hasOwnProperty.call(patch, field) && patch[field] !== task[field])
          if (contentChanged && !Object.prototype.hasOwnProperty.call(patch, 'workVersion')) {
            const current = Number.parseInt(task.workVersion ?? '0', 10)
            patch = { ...patch, workVersion: Number.isFinite(current) ? String(current + 1) : '1' }
          }
          if (task.gitOperation !== undefined) {
            const ownsOperation = typeof expected.gitOperationToken === 'string' && expected.gitOperationToken === task.gitOperation?.token
            const has = (key: keyof Task) => Object.prototype.hasOwnProperty.call(patch, key)
            if (has('gitOperation') && !ownsOperation) return undefined
            if (contentChanged && !ownsOperation) return undefined
            if ((has('workdir') || has('worktree')) && !ownsOperation) return undefined
            if (['runId', 'attempt', 'startedAt', 'phaseIndex', 'workVersion'].some((key) => has(key as keyof Task) && patch[key as keyof Task] !== task[key as keyof Task])) return undefined
            if (has('executionOwner') && !sameExecutionOwner(task.executionOwner, patch.executionOwner)) return undefined
            if (has('status') && patch.status !== task.status
              && !(task.status === 'running' && (patch.status === 'cancelled' || patch.status === 'failed'))) return undefined
          }
          Object.assign(task, patch)
          if (['done', 'failed', 'cancelled'].includes(task.status)) projections.set(projectionKey(task), structuredClone(task))
          touched.add(id)
          changed = true
          return task
        },
        delete: (id, expected = {}) => {
          active()
          const task = tasks.get(id)
          if (!task || !matchesTask(task, expected)) return false
          if (task.gitOperation !== undefined) return false
          if (task.dedupeKey) deletedKeys.add(task.dedupeKey)
          tasks.delete(id)
          touched.delete(id)
          removed.add(id)
          changed = true
          return true
        },
        appendEvent: (id, event, expected = {}) => {
          active()
          const task = tasks.get(id)
          if (!task || !matchesTask(task, expected)) return null
          const log = this.eventLog(id)
          const full = log.append(event)
          if (full && isTaskEventDurable(full)) {
            task.eventCount = log.count()
            this.pendingSnapshots.add(id)
            this.indexDirty = true
            this.scheduleFlush()
          }
          return full
        },
        appendEvents: (id, events, expected = {}) => {
          active()
          const task = tasks.get(id)
          if (!task || !matchesTask(task, expected) || events.length === 0) return []
          const log = this.eventLog(id)
          const full = log.appendBatch(events)
          if (full.some(isTaskEventDurable)) {
            task.eventCount = log.count()
            this.pendingSnapshots.add(id)
            this.indexDirty = true
            this.scheduleFlush()
          }
          return full
        }
      }
      const result = action(view)
      if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('Task transactions must be synchronous')
      if (changed) {
        document.tasks = [...tasks.values()]
        if (deletedKeys.size) document.deletedDedupeKeys = [...deletedKeys]
        for (const [key, task] of projections) if (!tasks.has(task.id)) projections.delete(key)
        if (projections.size) document.pendingIssueProjections = [...projections.values()]
        else delete document.pendingIssueProjections
        for (const id of touched) this.pendingSnapshots.add(id)
        for (const id of removed) {
          this.logs.delete(id)
          this.pendingSnapshots.delete(id)
          this.pendingDeletes.add(id)
        }
        // Commit derived-file work with the authoritative mutation so a crash
        // cannot lose a failed snapshot write or directory deletion.
        this.retainSnapshotWork(document)
        this.saveIndex(document)
        // Snapshots are derived data. A failed snapshot cannot roll back an
        // already committed index, but remains queued for explicit/background retry.
        try { this.flushSnapshotsLocked(document) }
        catch (error) { console.error('[TaskStore] Snapshot flush pending', error); this.scheduleFlush() }
      }
      return result
    }) as SynchronousAction<T>
    return withStorageTransaction<T>(this.userDataDir, work)
  }

  create(input: TaskCreateRecord): Task { return this.transaction((tx) => tx.create(input)) }

  get(id: string): Task | undefined { return this.readDocument().tasks.find((task) => task.id === id) }

  list(): Task[] { return this.readDocument().tasks.sort((a, b) => b.createdAt - a.createdAt) }

  update(id: string, patch: Partial<Task>) { return this.updateIf(id, {}, patch) }

  updateIf(id: string, expected: TaskExpectation, patch: Partial<Task>): Task | undefined {
    return this.transaction((tx) => tx.update(id, patch, expected))
  }

  matches(id: string, expected: TaskExpectation): boolean {
    const task = this.get(id)
    return !!task && matchesTask(task, expected)
  }

  /** Reserve every affected task before any asynchronous Git side effect. */
  claimGitOperation(records: readonly { id: string; expected: TaskExpectation }[]): GitOperationClaim | undefined {
    if (!records.length || new Set(records.map((entry) => entry.id)).size !== records.length) return undefined
    const operation: TaskGitOperation = { token: randomUUID(), owner: createExecutionOwner(), createdAt: Date.now() }
    return this.transaction((tx) => {
      for (const entry of records) {
        const task = tx.get(entry.id)
        if (!task || task.status === 'queued' || task.gitOperation !== undefined || !matchesTask(task, entry.expected)) return undefined
      }
      for (const entry of records) tx.update(entry.id, { gitOperation: operation }, entry.expected)
      return { ...operation, taskIds: records.map((entry) => entry.id) }
    })
  }

  /** Reserve terminal tasks before reclaiming their worktree or a repo merge worktree. */
  claimWorktreeCleanup(repoDir: string, ownerTaskId: string, mergeWorktree = false): GitOperationClaim | undefined {
    const root = path.resolve(repoDir)
    const belongsToRepo = (task: Task) => [task.worktree?.repoDir, task.workdir].some((candidate) => {
      if (!candidate) return false
      const resolved = path.resolve(candidate)
      return resolved === root || resolved.startsWith(root + path.sep)
    })
    const operation: TaskGitOperation = { token: randomUUID(), owner: createExecutionOwner(), createdAt: Date.now() }
    return this.transaction((tx) => {
      const all = tx.list()
      const byId = new Map(all.map((task) => [task.id, task]))
      const targets: Task[] = []
      if (mergeWorktree) {
        targets.push(...all.filter(belongsToRepo))
      } else {
        let task = byId.get(ownerTaskId)
        const seen = new Set<string>()
        while (task && !seen.has(task.id)) {
          seen.add(task.id)
          targets.push(task)
          task = task.parentTaskId ? byId.get(task.parentTaskId) : undefined
        }
      }
      if (!targets.length || targets.some((task) => !['done', 'failed', 'cancelled'].includes(task.status) || task.gitOperation !== undefined)) return undefined
      for (const task of targets) tx.update(task.id, { gitOperation: operation }, {
        status: task.status, runId: task.runId, executionOwner: task.executionOwner,
        attempt: task.attempt, phaseIndex: task.phaseIndex, startedAt: task.startedAt,
        workdir: task.workdir, workVersion: task.workVersion
      })
      return { ...operation, taskIds: targets.map((task) => task.id) }
    })
  }

  releaseGitOperation(claim: GitOperationClaim): void {
    if (claim.owner.pid !== process.pid || processOwnerState(claim.owner) !== 'live') throw new Error('Git operation belongs to another process')
    this.pendingGitReleases.set(claim.token, claim)
    try {
      this.transaction((tx) => {
        for (const id of claim.taskIds) tx.update(id, { gitOperation: undefined }, { gitOperationToken: claim.token })
      })
      this.pendingGitReleases.delete(claim.token)
    } catch (error) {
      this.scheduleFlush(this.flushRetryDelayMs)
      this.flushRetryDelayMs = Math.min(this.flushRetryDelayMs * 2, 5000)
      throw error
    }
  }

  /** Clear only operations whose exact process identity is proven dead. */
  recoverDeadGitOperations(): Task[] {
    const candidates = this.list().filter((task) => task.gitOperation && processOwnerState(task.gitOperation.owner) === 'dead')
    if (!candidates.length) return []
    return this.transaction((tx) => {
      const recovered: Task[] = []
      for (const stale of candidates) {
        const operation = stale.gitOperation!
        const current = tx.get(stale.id)
        if (!current?.gitOperation || current.gitOperation.token !== operation.token
          || !sameExecutionOwner(current.gitOperation.owner, operation.owner)) continue
        tx.appendEvent(stale.id, {
          eventId: `git-operation-recovery:${operation.token}:${stale.id}`,
          ts: Date.now(), kind: 'status',
          text: 'Confirmed dead Git operation owner; released persisted reservation',
          data: { gitOperationRecovery: operation.token }
        }, { gitOperationToken: operation.token })
        const cleared = tx.update(stale.id, { gitOperation: undefined }, { gitOperationToken: operation.token })
        if (cleared) recovered.push(stale)
      }
      return recovered
    })
  }

  claimRun(id: string, expected: TaskExpectation, runId: string, owner: ExecutionOwner, patch: Partial<Task> = {}): Task | undefined {
    if (!owner.token || owner.pid !== process.pid || processOwnerState(owner) !== 'live') throw new Error('Invalid execution owner')
    return this.transaction((tx) => {
      const task = tx.get(id)
      if (!task || task.gitOperation !== undefined || task.status === 'running' || (task.status === 'queued' && task.parked) || !matchesTask(task, expected)) return undefined
      return tx.update(id, { ...patch, status: 'running', runId, executionOwner: { ...owner, leaseExpiresAt: Date.now() + 30000 } }, expected)
    })
  }

  delete(id: string) { this.transaction((tx) => tx.delete(id)) }

  deleteIf(id: string, expected: TaskExpectation): boolean { return this.transaction((tx) => tx.delete(id, expected)) }

  appendEvent(id: string, event: Omit<TaskEvent, 'seq'>, expected: TaskExpectation = {}): TaskEvent | null {
    return this.transaction((tx) => tx.appendEvent(id, event, expected))
  }

  appendEvents(id: string, events: readonly Omit<TaskEvent, 'seq'>[], expected: TaskExpectation = {}): TaskEvent[] {
    return this.transaction((tx) => tx.appendEvents(id, events, expected))
  }

  flush() {
    if (this.indexTimer) { clearTimeout(this.indexTimer); this.indexTimer = undefined }
    try {
      for (const claim of [...this.pendingGitReleases.values()]) this.releaseGitOperation(claim)
      withStorageTransaction(this.userDataDir, () => {
        const document = this.readDocument(false)
        let dirty = this.indexDirty
        for (const task of document.tasks) {
          const count = this.eventLog(task.id).count()
          if (count !== task.eventCount) {
            task.eventCount = count
            this.pendingSnapshots.add(task.id)
            dirty = true
          }
        }
        this.retainSnapshotWork(document)
        if (dirty || document.pendingTaskSnapshots?.length || document.pendingTaskDeletes?.length) this.saveIndex(document)
        this.indexDirty = false
        this.flushSnapshotsLocked(document)
        this.flushRetryDelayMs = 250
      })
    } catch (error) {
      if (!this.indexTimer) {
        this.scheduleFlush(this.flushRetryDelayMs)
        this.flushRetryDelayMs = Math.min(this.flushRetryDelayMs * 2, 5000)
      }
      throw error
    }
  }

  flushEvents(id: string) { void id; this.flush() }

  reload() {
    this.logs.clear()
    this.readDocument()
  }

  /** Probe outside the lock, then conditionally commit the exact observed run. */
  recoverDeadRuns(status: 'queued' | 'failed', ids?: readonly string[]): Task[] {
    const candidates = this.list().filter((task) => task.status === 'running'
      && (!ids || ids.includes(task.id) || (!!task.runId && ids.includes(task.runId)))
      && processOwnerState(task.executionOwner) === 'dead')
    if (!candidates.length) return []
    return this.transaction((tx) => {
      const recovered: Task[] = []
      for (const stale of candidates) {
        const expected: TaskExpectation = { status: 'running', runId: stale.runId, executionOwner: stale.executionOwner }
        if (status === 'queued' && !tx.update(stale.id, { status: 'failed', endedAt: Date.now(), error: 'Execution owner process exited; run interrupted' }, expected)) continue
        const patch: Partial<Task> = status === 'queued'
          ? { status, runId: undefined, executionOwner: undefined, startedAt: undefined, endedAt: undefined, error: undefined }
          : { status, endedAt: Date.now(), error: 'Execution owner process exited; run interrupted' }
        const task = tx.update(stale.id, patch, status === 'queued' ? { ...expected, status: 'failed' } : expected)
        if (!task) continue
        tx.appendEvent(stale.id, { eventId: 'owner-recovery-' + stale.id + '-' + stale.runId + '-' + stale.executionOwner?.token,
          ts: Date.now(), kind: 'status', text: status === 'queued' ? 'Confirmed dead execution owner; queued for recovery' : 'Confirmed dead execution owner; marked interrupted' })
        recovered.push(stale)
      }
      return recovered
    })
  }

  drainRestartInterrupted(): Task[] {
    const drained = this.restartInterrupted
    this.restartInterrupted = []
    return drained
  }

  truncateEvents(id: string, keepThroughSeq: number, expected: TaskExpectation = {}): boolean {
    return withStorageTransaction(this.userDataDir, () => {
      const document = this.readDocument()
      const task = document.tasks.find((item) => item.id === id)
      if (!task || !matchesTask(task, expected)) return false
      const kept = this.eventLog(id).truncate(keepThroughSeq)
      if (!kept) return false
      task.eventCount = kept.length
      this.pendingSnapshots.add(id)
      this.indexDirty = true
      this.scheduleFlush()
      this.retainSnapshotWork(document)
      this.saveIndex(document)
      this.flushSnapshotsLocked(document)
      return true
    })
  }

  readEvents(id: string, afterSeq = 0, limit = 5000): TaskEvent[] {
    if (!this.readDocument(false).tasks.some((task) => task.id === id)) return []
    return this.eventLog(id).read(afterSeq, limit)
  }
}
