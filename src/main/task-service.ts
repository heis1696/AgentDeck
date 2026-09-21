import type { Task, RunTrigger, WorktreeInfo } from '../shared/types'
import { sameExecutionOwner, type TaskStore } from './store'
import type { IssueStore } from './issue-store'
import { findHandoffSuccessor, repeatsHandoffPhase } from './handoff'

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
  /** Durable idempotency key for replayed creation requests. */
  dedupeKey?: string
  /** Public request id accepted by the Task IPC boundary. */
  requestId?: string
  /** Alias used by integrations that call this an idempotency key. */
  idempotencyKey?: string
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
  suppressIssue?: boolean
  trigger?: RunTrigger
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

  taskCascade(taskIds: string[]): Task[] {
    const ids = new Set(taskIds)
    const tasks = this.store.list()
    let changed = true
    while (changed) {
      changed = false
      for (const task of tasks) {
        if (task.parentTaskId && ids.has(task.parentTaskId) && !ids.has(task.id)) {
          ids.add(task.id)
          changed = true
        }
      }
    }
    return tasks.filter((task) => ids.has(task.id))
  }

  /** Retention deletes data only: never remove a branch or worktree. */
  async deleteTerminalCascade(taskIds: string[], forget: (id: string) => unknown, validate: (tasks: Task[]) => boolean): Promise<string[] | null> {
    const tasks = this.taskCascade(taskIds)
    const terminal = (items: Task[]) => items.every((task) => ['done', 'failed', 'cancelled'].includes(task.status))
    if (!terminal(tasks) || !validate(tasks)) return null
    const deleted = this.store.transaction((tx) => {
      const ids = new Set(taskIds)
      const all = tx.list()
      let grew = true
      while (grew) {
        grew = false
        for (const task of all) if (task.parentTaskId && ids.has(task.parentTaskId) && !ids.has(task.id)) { ids.add(task.id); grew = true }
      }
      const current = all.filter((task) => ids.has(task.id))
      if (current.some((task) => task.gitOperation !== undefined)) return null
      if (current.length !== tasks.length || !terminal(current) || !current.every((task) => tasks.some((prior) => prior.id === task.id && prior.runId === task.runId && sameExecutionOwner(prior.executionOwner, task.executionOwner))) || !validate(current)) return null
      for (const task of current) tx.delete(task.id)
      return current.map((task) => task.id)
    })
    // Deletion wins the claim race before cleanup can stop any local session.
    // Failed validation must have no effects on a replacement execution.
    if (!deleted) return null
    for (const id of deleted) await forget(id)
    this.store.flush()
    return deleted
  }

  /** Return the task registered for a durable idempotency key. */
  deduped(key: string): Task | null {
    key = key.trim()
    if (!key) return null
    const cached = this.dedupe.get(key)
    if (cached) {
      const task = this.store.get(cached)
      if (task) return task
      this.dedupe.delete(key)
    }
    const persisted = this.store.list().find((task) => task.dedupeKey === key)
    if (persisted) this.dedupe.set(key, persisted.id)
    return persisted ?? null
  }

  private normalizeDedupeKey(input: TaskCreateInput): string | undefined {
    const aliases = [input.dedupeKey, input.requestId, input.idempotencyKey]
      .map((candidate) => typeof candidate === 'string' ? candidate.trim() : '')
      .filter(Boolean)
    if (new Set(aliases).size > 1) throw new Error('Conflicting task idempotency keys')
    return aliases[0]
  }

  /** Alias used by internal callers that model this as a request service. */
  create(input: TaskCreateInput, trigger: RunTrigger = input.trigger ?? 'assignment'): Task {
    return this.createTask(input, trigger)
  }

  createTask(input: TaskCreateInput, trigger: RunTrigger = input.trigger ?? 'assignment'): Task {
    const dedupeKey = this.normalizeDedupeKey(input)
    const agent = input.agentId ? this.getAgent?.(input.agentId) : undefined
    const backend = agent?.backend ?? input.backend ?? this.defaultBackend
    const title = input.title.trim() || '未命名任务'
    const prompt = input.prompt.trim()
    const task = this.store.transaction((tx) => {
      const existing = dedupeKey ? tx.list().find((item) => item.dedupeKey === dedupeKey) : undefined
      const created = existing ?? tx.create({
        title, prompt, workdir: input.workdir ?? '', backend, trigger,
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
        ...(input.titleAuto ? { titleAuto: true } : {}),
        ...(dedupeKey ? { dedupeKey } : {})
      })
      if (!created.suppressIssue && !created.issueId) tx.update(created.id, { issueId: 'iss_' + created.id })
      return tx.get(created.id)!
    })
    this.issueStore?.syncEventually(this.store.list())
    if (dedupeKey) this.dedupe.set(dedupeKey, task.id)
    return task
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
      suppressIssue: input.suppressIssue,
      titleAuto: true
    }, input.trigger ?? 'assignment')
  }

  /**
   * Create the next phase on the same Issue. Handoffs are idempotent for a
   * source so reworded stream/replay callbacks cannot add parallel successors.
   */
  createHandoffTask(input: HandoffTaskCreateInput): Task | null {
    return this.resolveHandoffTask(input)?.task ?? null
  }

  resolveHandoffTask(input: HandoffTaskCreateInput): { task: Task; created: boolean } | null {
    const resolved = this.store.transaction((tx) => {
      const source = tx.get(input.sourceTaskId)
      if (!source) return null
      const brief = input.brief.trim()
      if (!brief) return null
      const issueId = source.issueId ?? input.issueId.trim()
      if (!issueId) return null
      const existing = findHandoffSuccessor(tx.list(), { id: source.id, issueId })
      const phaseIndex = source.goalId === undefined ? undefined : (source.phaseIndex ?? 0) + 1
      if (existing) {
        if (source.goalId && (existing.goalId !== source.goalId || existing.phaseIndex !== phaseIndex)) {
          tx.update(existing.id, { goalId: source.goalId, phaseIndex })
        }
        return { task: tx.get(existing.id)!, created: false }
      }
      if (repeatsHandoffPhase(source, brief)) return null
      const firstLine = brief.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
      const task = tx.create({
        title: '▶ ' + (firstLine?.slice(0, 40) ?? source.title + ' (next phase)'),
        prompt: brief, workdir: source.workdir, agentId: source.agentId, backend: source.backend,
        issueId, continuesFrom: source.id, trigger: 'handoff',
        ...(source.goalId ? { goalId: source.goalId } : {}),
        ...(phaseIndex !== undefined ? { phaseIndex } : {}),
        ...(input.start === 'parked' ? { parked: true } : {})
      })
      return { task, created: true }
    })
    if (resolved) this.issueStore?.syncEventually(this.store.list())
    return resolved
  }
}
