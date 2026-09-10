// 文件存储：userData/tasks.json（索引）+ userData/tasks/<id>/events.jsonl（日志流）
import fs from 'node:fs'
import path from 'node:path'
import { isTaskEventDurable, isTaskStatus, type Task, type TaskEvent, type IntegrationInfo } from '../shared/types'
import { EventLog } from './event-log'

/** Version of the task index envelope, independent from per-task snapshots. */
export const TASK_INDEX_SCHEMA_VERSION = 1 as const

export interface TaskIndexDocument {
  schemaVersion: typeof TASK_INDEX_SCHEMA_VERSION
  tasks: Task[]
}

type LegacyTask = Partial<Task> & {
  mode?: string
  squad?: { integrationBranch?: string; integrationNote?: string }
}

/** Current on-disk Task shape. Unknown keys must not become implicit schema. */
const TASK_INDEX_FIELDS = [
  'id', 'title', 'prompt', 'workdir', 'backend', 'agentId', 'trigger', 'issueId',
  'suppressIssue', 'runId', 'goalId', 'phaseIndex', 'parentTaskId', 'workerIndex', 'integration', 'status',
  'createdAt', 'startedAt', 'endedAt', 'result', 'error', 'failure', 'attempt',
  'roundsUsed', 'handoff', 'continuesFrom', 'parked', 'backgroundRunning', 'titleAuto', 'sessionId',
  'gitDiff', 'gitStat', 'usage', 'eventCount', 'unavailableReason', 'worktree', 'workVersion'
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Migrate one index entry. `sourceVersion` is explicit: legacy fields are
 * only interpreted for version 0, so future schema additions do not grow an
 * implicit compatibility branch.
 */
export function migrateTaskRecord(raw: unknown, sourceVersion = 0, now = Date.now()): Task | null {
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

  // A running task cannot survive an application restart. This recovery is
  // deliberately idempotent: the persisted result is terminal on next load.
  if (out.status === 'running') {
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
export function migrateTaskIndex(raw: unknown, now = Date.now()): TaskIndexDocument {
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
    tasks: entries
      .map((entry) => migrateTaskRecord(entry, sourceVersion, now))
      .filter((task): task is Task => task !== null)
  }
}

function sameTaskEntries(raw: unknown, document: TaskIndexDocument): boolean {
  if (!isRecord(raw) || raw.schemaVersion !== TASK_INDEX_SCHEMA_VERSION || !Array.isArray(raw.tasks)) return false
  return JSON.stringify(raw.tasks) === JSON.stringify(document.tasks)
}

export class TaskStore {
  private dir: string
  private tasks = new Map<string, Task>()
  private logs = new Map<string, EventLog>()
  private pendingSnapshots = new Set<string>()
  private indexTimer: NodeJS.Timeout | undefined
  private indexDirty = false
  /** Ids flipped running→failed by this process's load migration. The startup
   * reconciliation owns the narration and the final-event rescue; without it a
   * restart-interrupted turn (e.g. one waiting on an auto-retry) would leave a
   * timeline that dead-ends at its last live event with no explanation. */
  private restartInterrupted = new Set<string>()

  constructor(userDataDir: string) {
    this.dir = path.join(userDataDir, 'tasks')
    fs.mkdirSync(this.dir, { recursive: true })
    this.loadIndex()
  }

  private indexFile() {
    return path.join(this.dir, 'tasks.json')
  }

  private taskDir(id: string) {
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

  private loadIndex() {
    let raw: string
    try {
      raw = fs.readFileSync(this.indexFile(), 'utf8')
    } catch (error) {
      // A missing index is the normal first-launch state. Other filesystem
      // errors must remain visible instead of silently dropping all tasks.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }

    const parsed = JSON.parse(raw) as unknown
    const document = migrateTaskIndex(parsed)
    // Record zombie-running flips while the raw status is still visible. The
    // flip itself stays silent and idempotent; startup reconciliation reads
    // this ledger once and appends the visible "interrupted" trace.
    const rawEntries = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.tasks) ? parsed.tasks : []
    for (const entry of rawEntries) {
      if (isRecord(entry) && entry.status === 'running' && typeof entry.id === 'string' && entry.id.trim()) {
        this.restartInterrupted.add(entry.id)
      }
    }
    let needsSave = !sameTaskEntries(parsed, document)
    for (const migrated of document.tasks) {
      // Reconcile counters with the append-only log after an interrupted write.
      // EventLog owns JSONL recovery and live-only filtering. Counting raw
      // lines here would resurrect torn/unknown records in tasks.json. Future
      // event schema versions intentionally propagate as a fail-closed error.
      const eventCount = this.eventLog(migrated.id).count()
      if (migrated.eventCount !== eventCount) {
        migrated.eventCount = eventCount
        needsSave = true
      }
      this.tasks.set(migrated.id, migrated)
    }
    if (needsSave) this.saveIndex()
  }

  private saveIndex() {
    const tasks = [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt)
    const document: TaskIndexDocument = { schemaVersion: TASK_INDEX_SCHEMA_VERSION, tasks }
    const tmp = this.indexFile() + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(document, null, 2))
    fs.renameSync(tmp, this.indexFile())
  }

  private scheduleFlush() {
    this.indexDirty = true
    if (this.indexTimer) return
    this.indexTimer = setTimeout(() => {
      this.indexTimer = undefined
      this.flush()
    }, 25)
  }

  /** Persist event-driven snapshots and the task index as one bounded batch. */
  flush() {
    if (this.indexTimer) {
      clearTimeout(this.indexTimer)
      this.indexTimer = undefined
    }
    for (const id of this.pendingSnapshots) {
      const task = this.tasks.get(id)
      if (!task) continue
      try {
        fs.writeFileSync(path.join(this.taskDir(id), 'task.json'), JSON.stringify(task, null, 2))
      } catch {}
    }
    this.pendingSnapshots.clear()
    if (this.indexDirty) {
      this.indexDirty = false
      this.saveIndex()
    }
  }

  create(input: Pick<Task, 'title' | 'prompt' | 'workdir' | 'backend'> & Partial<Pick<Task, 'parentTaskId' | 'workerIndex' | 'integration' | 'agentId' | 'handoff' | 'continuesFrom' | 'parked' | 'backgroundRunning' | 'suppressIssue' | 'trigger' | 'issueId' | 'goalId' | 'phaseIndex' | 'titleAuto' | 'unavailableReason' | 'worktree' | 'workVersion'>>): Task {
    const task: Task = {
      id: `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      title: input.title,
      prompt: input.prompt,
      workdir: input.workdir,
      backend: input.backend,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.trigger ? { trigger: input.trigger } : {}),
      ...(input.issueId ? { issueId: input.issueId } : {}),
      ...(input.goalId ? { goalId: input.goalId } : {}),
      ...(input.phaseIndex !== undefined ? { phaseIndex: input.phaseIndex } : {}),
      ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      ...(input.workerIndex !== undefined ? { workerIndex: input.workerIndex } : {}),
      ...(input.unavailableReason ? { unavailableReason: input.unavailableReason } : {}),
      ...(input.worktree ? { worktree: input.worktree } : {}),
      ...(input.integration ? { integration: input.integration } : {}),
      ...(input.handoff ? { handoff: input.handoff } : {}),
      ...(input.continuesFrom ? { continuesFrom: input.continuesFrom } : {}),
      ...(input.parked ? { parked: true } : {}),
      ...(input.backgroundRunning ? { backgroundRunning: true } : {}),
      ...(input.suppressIssue ? { suppressIssue: true } : {}),
      ...(input.titleAuto ? { titleAuto: true } : {}),
      ...(input.workVersion ? { workVersion: input.workVersion } : {}),
      status: 'queued',
      createdAt: Date.now(),
      eventCount: 0
    }
    this.tasks.set(task.id, task)
    fs.mkdirSync(this.taskDir(task.id), { recursive: true })
    fs.writeFileSync(path.join(this.taskDir(task.id), 'task.json'), JSON.stringify(task, null, 2))
    this.saveIndex()
    return task
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id)
  }

  /** Tasks flipped running→failed by the load migration (drain-once). */
  drainRestartInterrupted(): Task[] {
    const drained: Task[] = []
    for (const id of this.restartInterrupted) {
      const task = this.tasks.get(id)
      if (task) drained.push(task)
    }
    this.restartInterrupted.clear()
    return drained
  }

  list(): Task[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  update(id: string, patch: Partial<Task>) {
    const t = this.tasks.get(id)
    if (!t) return
    // Permission approvals are scoped to the task content. A caller may set a
    // version explicitly (for deterministic migrations/tests); otherwise bump
    // it whenever an execution-relevant field changes.
    const contentFields: Array<keyof Task> = ['title', 'prompt', 'workdir', 'backend', 'agentId', 'handoff']
    const changed = contentFields.some((field) => Object.prototype.hasOwnProperty.call(patch, field) && patch[field] !== t[field])
    if (changed && !Object.prototype.hasOwnProperty.call(patch, 'workVersion')) {
      const current = Number.parseInt(t.workVersion ?? '0', 10)
      patch = { ...patch, workVersion: Number.isFinite(current) ? String(current + 1) : '1' }
    }
    Object.assign(t, patch)
    try {
      fs.writeFileSync(path.join(this.taskDir(id), 'task.json'), JSON.stringify(t, null, 2))
    } catch {}
    this.saveIndex()
  }

  delete(id: string) {
    const t = this.tasks.get(id)
    if (!t) return
    this.logs.delete(id)
    this.tasks.delete(id)
    fs.rmSync(this.taskDir(id), { recursive: true, force: true })
    this.saveIndex()
  }

  appendEvent(id: string, e: Omit<TaskEvent, 'seq'>): TaskEvent | null {
    const t = this.tasks.get(id)
    if (!t) return null
    fs.mkdirSync(this.taskDir(id), { recursive: true })
    // Synchronous append keeps readEvents/finalization and crash recovery consistent.
    const full = this.eventLog(id).append(e)
    if (!full) return null
    if (isTaskEventDurable(full)) {
      t.eventCount = (t.eventCount ?? 0) + 1
      this.pendingSnapshots.add(id)
      this.scheduleFlush()
    }
    return full
  }

  flushEvents(id: string) {
    void id
    this.flush()
  }

  /** 消息回退：只保留 seq <= keepThroughSeq 的事件并重写 events.jsonl（tmp+rename）；
   * 同步重置 seq 计数器与 eventCount，task.json 和索引落盘。任务不存在返回 false。 */
  truncateEvents(id: string, keepThroughSeq: number): boolean {
    const t = this.tasks.get(id)
    if (!t) return false
    this.flush()
    fs.mkdirSync(this.taskDir(id), { recursive: true })
    const kept = this.eventLog(id).truncate(keepThroughSeq)
    if (!kept) return false
    t.eventCount = kept.length
    try {
      fs.writeFileSync(path.join(this.taskDir(id), 'task.json'), JSON.stringify(t, null, 2))
    } catch {}
    this.saveIndex()
    return true
  }

  readEvents(id: string, afterSeq = 0, limit = 5000): TaskEvent[] {
    return this.eventLog(id).read(afterSeq, limit)
  }
}
