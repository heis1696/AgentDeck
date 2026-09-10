import type { Task, RunTrigger, WorktreeInfo } from '../shared/types'
import type { TaskStore } from './store'
import type { IssueStore } from './issue-store'

/** The small agent shape needed to resolve a task's execution backend. */
export interface TaskAgentRef {
  id: string
  backend: string
}

export interface TaskCreateInput {
  title: string
  prompt: string
  workdir?: string
  backend?: string
  agentId?: string
  trigger?: RunTrigger
  handoff?: string
  startNow?: boolean
  parked?: boolean
  backgroundRunning?: boolean
  suppressIssue?: boolean
  issueId?: string
  titleAuto?: boolean
  continuesFrom?: string
  goalId?: string
  phaseIndex?: number
  parentTaskId?: string
  workerIndex?: number
  unavailableReason?: string
  worktree?: WorktreeInfo
  /** Process-local idempotency key for replayed internal creation requests. */
  dedupeKey?: string
}

/** Compatibility name used by IPC context and callers from the first stage. */
export type CreateTaskInput = TaskCreateInput

export interface ChildTaskCreateInput {
  parentTaskId: string
  title: string
  prompt: string
  workdir?: string
  backend: string
  agentId?: string
  workerIndex?: number
  unavailableReason?: string
  worktree?: WorktreeInfo
}

export interface HandoffTaskCreateInput {
  sourceTaskId: string
  issueId: string
  brief: string
  start: 'auto' | 'parked'
}

export interface TaskServiceOptions {
  store: TaskStore
  issueStore?: IssueStore | null
  getAgent?: (agentId: string) => TaskAgentRef | undefined
  resolveAgent?: (agentId: string) => TaskAgentRef | undefined
  defaultBackend?: string
}

/**
 * Application boundary for all compatibility Task creation.
 *
 * TaskStore remains the durable compatibility store; this service owns the
 * invariants that used to be repeated by IPC, Goal and handoff callers.
 */
export class TaskService {
  private readonly store: TaskStore
  private readonly issueStore: IssueStore | null
  private readonly getAgent?: (agentId: string) => TaskAgentRef | undefined
  private readonly defaultBackend: string
  private readonly dedupe = new Map<string, string>()

  constructor(options: TaskServiceOptions)
  constructor(store: TaskStore, issueStore: IssueStore | null, getAgent?: (agentId: string) => TaskAgentRef | undefined)
  constructor(
    optionsOrStore: TaskServiceOptions | TaskStore,
    legacyIssueStore?: IssueStore | null,
    legacyGetAgent?: (agentId: string) => TaskAgentRef | undefined
  ) {
    if (legacyIssueStore !== undefined) {
      this.store = optionsOrStore as TaskStore
      this.issueStore = legacyIssueStore
      this.getAgent = legacyGetAgent
      this.defaultBackend = 'zcode'
      return
    }
    const options = optionsOrStore as TaskServiceOptions
    this.store = options.store
    this.issueStore = options.issueStore ?? null
    this.getAgent = options.getAgent ?? options.resolveAgent
    this.defaultBackend = options.defaultBackend ?? 'zcode'
  }

  /** Return the task registered for a process-local idempotency key. */
  deduped(key: string): Task | null {
    const id = this.dedupe.get(key)
    return id ? this.store.get(id) ?? null : null
  }

  /** Alias used by internal callers that model this as a request service. */
  create(input: TaskCreateInput, trigger: RunTrigger = input.trigger ?? 'assignment'): Task {
    return this.createTask(input, trigger)
  }

  createTask(input: TaskCreateInput, trigger: RunTrigger = input.trigger ?? 'assignment'): Task {
    if (input.dedupeKey) {
      const existing = this.deduped(input.dedupeKey)
      if (existing) {
        if (existing.status === 'queued' && existing.parked && input.startNow !== false && !input.parked) {
          this.store.update(existing.id, { parked: undefined })
        }
        return this.store.get(existing.id) ?? existing
      }
    }
    const agent = input.agentId ? this.getAgent?.(input.agentId) : undefined
    const backend = agent?.backend ?? input.backend ?? this.defaultBackend
    const title = input.title.trim() || '未命名任务'
    const prompt = input.prompt.trim()
    const task = this.store.create({
      title,
      prompt,
      workdir: input.workdir ?? '',
      backend,
      trigger,
      ...(agent ? { agentId: agent.id } : (!this.getAgent && input.agentId) ? { agentId: input.agentId } : {}),
      ...(input.handoff?.trim() ? { handoff: input.handoff.trim() } : {}),
      ...(input.startNow === false || input.parked ? { parked: true } : {}),
      ...(input.backgroundRunning ? { backgroundRunning: true } : {}),
      ...(input.suppressIssue ? { suppressIssue: true } : {}),
      ...(input.issueId?.trim() ? { issueId: input.issueId.trim() } : {}),
      ...(input.continuesFrom ? { continuesFrom: input.continuesFrom } : {}),
      ...(input.goalId ? { goalId: input.goalId } : {}),
      ...(input.phaseIndex !== undefined ? { phaseIndex: input.phaseIndex } : {}),
      ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      ...(input.workerIndex !== undefined ? { workerIndex: input.workerIndex } : {}),
      ...(input.unavailableReason ? { unavailableReason: input.unavailableReason } : {}),
      ...(input.worktree ? { worktree: input.worktree } : {}),
      ...(input.titleAuto ? { titleAuto: true } : {})
    })
    // A caller may explicitly own an Issue. Otherwise every visible Task gets
    // one stable Issue id before projection; run-only automation is explicit.
    if (!task.suppressIssue && !task.issueId) {
      this.store.update(task.id, { issueId: `iss_${task.id}` })
    }
    const projected = this.store.get(task.id)!
    this.issueStore?.sync(this.store.list())
    if (input.dedupeKey) this.dedupe.set(input.dedupeKey, projected.id)
    return projected
  }

  createChildTask(input: ChildTaskCreateInput): Task {
    return this.createTask({
      title: input.title,
      prompt: input.prompt,
      workdir: input.workdir ?? '',
      backend: input.backend,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      parentTaskId: input.parentTaskId,
      workerIndex: input.workerIndex,
      unavailableReason: input.unavailableReason,
      worktree: input.worktree,
      titleAuto: true
    }, 'assignment')
  }

  /**
   * Create the next phase on the same Issue. Handoffs are idempotent for a
   * source/brief pair so duplicate stream/replay callbacks cannot add runs.
   */
  createHandoffTask(input: HandoffTaskCreateInput): Task | null {
    const source = this.store.get(input.sourceTaskId)
    if (!source) return null
    const brief = input.brief.trim()
    if (!brief) return null
    // The source Task is authoritative for Issue ownership. The explicit
    // argument is retained for legacy callers but cannot redirect a handoff
    // to another Issue (or accidentally create a fresh one when omitted).
    const issueId = source.issueId ?? input.issueId.trim()
    if (!issueId) return null
    const existing = this.store.list().find((task) =>
      task.issueId === issueId
      && task.continuesFrom === source.id
      && task.prompt === brief
    )
    const phaseIndex = source.goalId === undefined
      ? undefined
      : (source.phaseIndex ?? 0) + 1
    if (existing) {
      // Repair a handoff persisted by the pre-stage-2 path. Reusing the task
      // preserves its Issue/Run history while making the Goal projection
      // complete after restart or replay.
      if (source.goalId && (existing.goalId !== source.goalId || existing.phaseIndex !== phaseIndex)) {
        this.store.update(existing.id, { goalId: source.goalId, phaseIndex })
        this.issueStore?.sync(this.store.list())
      }
      if (input.start === 'auto' && existing.status === 'queued' && existing.parked) {
        this.store.update(existing.id, { parked: undefined })
      }
      return this.store.get(existing.id) ?? existing
    }
    const firstLine = brief.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
    return this.createTask({
      title: `▶ ${firstLine?.slice(0, 40) ?? `${source.title} (next phase)`}`,
      prompt: brief,
      workdir: source.workdir,
      agentId: source.agentId,
      backend: source.backend,
      issueId,
      continuesFrom: source.id,
      ...(source.goalId ? { goalId: source.goalId } : {}),
      ...(phaseIndex !== undefined ? { phaseIndex } : {}),
      startNow: input.start !== 'parked'
    }, 'handoff')
  }
}

/** Descriptive alias for integrations that call this boundary a creation service. */
export const TaskCreationService = TaskService
