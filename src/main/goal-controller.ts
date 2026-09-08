import type { Goal, GoalRun, GoalStatus, Task } from '../shared/types'
import type { GoalCheckpointInput, GoalCreateInput } from '../shared/contracts'
import { isTerminalGoalStatus, validateGoalTransition } from '../shared/taskflow'
import { GoalStore, type GoalCreateRecord } from './goal-store'

export interface GoalTaskInput {
  title: string
  prompt: string
  workdir: string
  backend?: string
  agentId?: string
  issueId: string
  goalId: string
  phaseIndex: number
  trigger: 'autopilot' | 'manual'
  startNow: boolean
}

export interface GoalControllerOptions {
  /** Creates a compatibility Task and, when requested, enqueues it. */
  createTask: (input: GoalTaskInput) => Task
  enqueueTask?: (task: Task) => void
  /** Clears a parked task before a user explicitly starts it. */
  startTask?: (task: Task) => Task
  cancelTask?: (taskId: string) => Promise<{ ok: boolean; error?: string }> | { ok: boolean; error?: string }
  /** Optional source of persisted tasks used by restart recovery. */
  listTasks?: () => Task[]
  onUpdated?: (goal: Goal) => void
}

export interface GoalDecision {
  status: GoalStatus
  complete: boolean
  shouldContinue: boolean
  reason?: string
}

type ParsedCheckpoint = GoalCheckpointInput

function cleanLines(values: unknown): string[] {
  return Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean) : []
}

function normalize(value: string) {
  return value.toLocaleLowerCase().replace(/\s+/g, ' ').trim()
}

function mentions(text: string, condition: string) {
  const wanted = normalize(condition)
  return !!wanted && normalize(text).includes(wanted)
}

/** Parse the small, optional checkpoint envelope an agent can return. */
function parseCheckpoint(result: string, conditions: string[]): ParsedCheckpoint | null {
  const candidates = [result.trim()]
  const fenced = result.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  if (fenced) candidates.unshift(fenced.trim())
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate) as Record<string, unknown>
      if (!value || typeof value !== 'object' || typeof value.summary !== 'string') continue
      return {
        summary: value.summary.trim(),
        completedConditions: cleanLines(value.completedConditions),
        incompleteConditions: cleanLines(value.incompleteConditions),
        nextPlan: typeof value.nextPlan === 'string' ? value.nextPlan.trim() : '',
        blockers: cleanLines(value.blockers)
      }
    } catch {
      // A normal prose result is handled below.
    }
  }
  if (!result.trim()) return null
  const completedConditions = conditions.filter((condition) => mentions(result, condition))
  return {
    summary: result.trim(),
    completedConditions,
    incompleteConditions: conditions.filter((condition) => !completedConditions.includes(condition)),
    nextPlan: '',
    blockers: []
  }
}

/**
 * Coordinates a Goal's durable state and its compatibility Tasks. The
 * controller owns goal transitions; GoalStore remains a deliberately dumb
 * persistence boundary.
 */
export class GoalController {
  private readonly goals: GoalStore
  private readonly options: GoalControllerOptions
  private readonly taskByGoal = new Map<string, string>()
  private readonly updateListeners = new Set<(goal: Goal) => void>()

  constructor(goals: GoalStore, options: GoalControllerOptions) {
    this.goals = goals
    this.options = options
    if (options.onUpdated) this.updateListeners.add(options.onUpdated)
  }

  subscribe(listener: (goal: Goal) => void) {
    this.updateListeners.add(listener)
    return () => this.updateListeners.delete(listener)
  }

  list() { return this.goals.list() }
  get(id: string) { return this.goals.get(id) }
  runs(id: string) { return this.goals.runs(id) }
  checkpoints(id: string) { return this.goals.checkpoints(id) }

  private emit(goal: Goal | null) {
    if (!goal) return null
    for (const listener of this.updateListeners) listener(goal)
    return goal
  }

  private transition(id: string, status: GoalStatus, actor: 'controller' | 'user') {
    const goal = this.goals.get(id)
    if (!goal) return { ok: false as const, error: 'Goal does not exist' }
    const result = validateGoalTransition(goal.status, status, actor)
    if (!result.ok) return result
    return { ok: true as const, goal: this.goals.update(id, { status })! }
  }

  create(input: GoalCreateInput): Goal {
    const text = input.text.trim()
    const completionConditions = cleanLines(input.completionConditions)
    if (!text) throw new Error('Goal text cannot be empty')
    if (!completionConditions.length) throw new Error('At least one completion condition is required')
    if (!Number.isInteger(input.maxRuns) || input.maxRuns < 1 || input.maxRuns > 10000) throw new Error('maxRuns must be an integer between 1 and 10000')
    if (!Number.isFinite(input.maxDurationMs) || input.maxDurationMs <= 0) throw new Error('maxDurationMs must be positive')
    if (typeof input.workdir !== 'string') throw new Error('workdir is required')
    const id = `goal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const record: GoalCreateRecord = {
      issueId: `iss_${id}`,
      text,
      completionConditions,
      stopConditions: cleanLines(input.stopConditions),
      maxRuns: input.maxRuns,
      maxDurationMs: input.maxDurationMs,
      workdir: input.workdir,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.backend ? { backend: input.backend } : {})
    }
    // GoalStore generates its own durable id; preserve the generated issue
    // relation and let the store's id be the public id.
    const goal = this.goals.create(record)
    // Create the first parked compatibility Task even for a draft goal so
    // the Goal's Issue relation exists before a user starts execution.
    const launched = this.launchNext(goal, input.startNow !== false)
    if (!launched.ok) throw new Error(launched.error)
    if (input.startNow === false) {
      const parked = this.goals.update(goal.id, { status: 'draft' })!
      this.emit(parked)
    }
    return this.goals.get(goal.id)!
  }

  start(id: string) {
    const goal = this.goals.get(id)
    if (!goal) return { ok: false as const, error: 'Goal does not exist' }
    if (goal.status !== 'draft') return { ok: false as const, error: `Goal cannot start from ${goal.status}` }
    const transitioned = this.transition(id, 'active', 'user')
    if (!transitioned.ok) return transitioned
    this.emit(transitioned.goal)
    const existingId = this.taskByGoal.get(id)
    const knownTasks = this.options.listTasks?.() ?? []
    const existing = (existingId ? knownTasks.find((task) => task.id === existingId) : undefined)
      ?? knownTasks.filter((task) => task.goalId === id && task.status === 'queued').sort((a, b) => b.createdAt - a.createdAt)[0]
    if (existing && existing.status === 'queued') {
      const updated = this.goals.update(id, { currentRunId: existing.runId ?? existing.id })!
      this.emit(updated)
      const started = this.options.startTask?.(existing) ?? existing
      this.options.enqueueTask?.(started)
      return { ok: true as const, task: started }
    }
    return this.launchNext(transitioned.goal)
  }

  pause(id: string) {
    const goal = this.goals.get(id)
    if (!goal) return { ok: false as const, error: 'Goal does not exist' }
    const transitioned = this.transition(id, 'waiting_user', 'user')
    if (!transitioned.ok) return transitioned
    const taskId = this.taskByGoal.get(id)
    if (taskId && this.options.cancelTask) void Promise.resolve(this.options.cancelTask(taskId)).catch(() => {})
    const updated = this.goals.update(id, { blockedReason: 'Paused by user' })!
    this.emit(updated)
    return { ok: true as const }
  }

  resume(id: string) {
    return this.continue(id)
  }

  continue(id: string) {
    const goal = this.goals.get(id)
    if (!goal) return { ok: false as const, error: 'Goal does not exist' }
    if (!['waiting_user', 'blocked', 'failed'].includes(goal.status)) return { ok: false as const, error: `Goal cannot continue from ${goal.status}` }
    if (goal.runCount >= goal.maxRuns) return { ok: false as const, error: 'Goal run budget exhausted' }
    if (goal.totalDurationMs >= goal.maxDurationMs) return { ok: false as const, error: 'Goal duration budget exhausted' }
    const transitioned = this.transition(id, 'active', 'user')
    if (!transitioned.ok) return transitioned
    const updated = this.goals.update(id, { blockedReason: undefined })!
    this.emit(updated)
    return this.launchNext(updated)
  }

  cancel(id: string) {
    const goal = this.goals.get(id)
    if (!goal) return { ok: false as const, error: 'Goal does not exist' }
    if (isTerminalGoalStatus(goal.status)) return { ok: false as const, error: 'Goal is already terminal' }
    const transitioned = this.transition(id, 'cancelled', 'user')
    if (!transitioned.ok) return transitioned
    const taskId = this.taskByGoal.get(id)
    if (taskId && this.options.cancelTask) void Promise.resolve(this.options.cancelTask(taskId)).catch(() => {})
    this.emit(transitioned.goal)
    return { ok: true as const }
  }

  /** Persist a user/agent-provided checkpoint without changing lifecycle. */
  checkpoint(id: string, input: GoalCheckpointInput) {
    const goal = this.goals.get(id)
    if (!goal) return null
    const taskId = this.taskByGoal.get(id)
    const run = taskId ? this.goals.runs(id).find((item) => item.taskId === taskId) : undefined
    if (!run) return null
    return this.goals.addCheckpoint({
      goalId: id,
      runId: run.id,
      phaseIndex: run.phaseIndex,
      summary: input.summary.trim(),
      completedConditions: cleanLines(input.completedConditions),
      incompleteConditions: cleanLines(input.incompleteConditions),
      nextPlan: input.nextPlan.trim(),
      blockers: cleanLines(input.blockers),
      durationMs: run.durationMs,
      usage: run.usage
    })
  }

  /** Mark active goals as waiting after application restart. */
  recover(tasks = this.options.listTasks?.() ?? []): Goal[] {
    const changed: Goal[] = []
    for (const goal of this.goals.list()) {
      if (goal.status !== 'active') continue
      const candidates = tasks.filter((task) => task.goalId === goal.id).sort((a, b) => b.createdAt - a.createdAt)
      const current = candidates.find((task) => task.status === 'queued' || task.status === 'running') ?? candidates[0]
      if (current) this.taskByGoal.set(goal.id, current.id)
      const updated = this.goals.update(goal.id, { status: 'waiting_user', blockedReason: 'Application restarted; confirm continuation' })
      if (updated) { changed.push(updated); this.emit(updated) }
    }
    return changed
  }

  /** Feed every TaskChanged notification to the goal state machine. */
  onTaskChanged(task: Task): GoalDecision | null {
    if (!task.goalId) return null
    const goal = this.goals.get(task.goalId)
    if (!goal) return null
    this.taskByGoal.set(goal.id, task.id)
    if (task.status === 'queued' || task.status === 'running') {
      // A queued task does not have an execution id yet. Persist the GoalRun
      // once the runner assigns runId, so one phase cannot produce a phantom
      // legacy run followed by a second concrete run after dispatch.
      const run = task.status === 'running' ? this.goals.upsertRunFromTask(task) : null
      const currentRunId = run?.id ?? task.runId
      if (goal.status === 'draft') this.emit(this.goals.update(goal.id, { status: 'active', ...(currentRunId ? { currentRunId } : {}) }))
      else if (currentRunId) this.emit(this.goals.update(goal.id, { currentRunId }))
      return { status: 'active', complete: false, shouldContinue: false }
    }
    if (!['done', 'failed', 'cancelled'].includes(task.status)) return null
    const projected = this.goals.upsertRunFromTask(task)
    if (!projected) return null
    const retrying = task.status === 'failed' && task.failure?.retryable && (task.attempt ?? 0) < 2
    if (retrying) {
      const updated = this.goals.update(goal.id, { currentRunId: projected.id, status: 'active', blockedReason: task.error || 'Transient run failure; retrying' })
      this.emit(updated)
      return { status: 'active', complete: false, shouldContinue: false, reason: task.error || 'Transient run failure; retrying' }
    }
    // Runner may publish the same terminal snapshot more than once. A
    // checkpoint is the durable idempotency marker for a completed phase.
    const alreadyHandled = this.goals.checkpointForRun(projected.id)
    if (alreadyHandled) {
      const current = this.goals.get(goal.id)
      return current ? {
        status: current.status,
        complete: current.status === 'completed',
        shouldContinue: false,
        reason: current.blockedReason
      } : null
    }
    const duration = task.usage?.durationMs ?? ((task.endedAt ?? Date.now()) - (task.startedAt ?? task.createdAt))
    const runCount = Math.max(goal.runCount, (task.phaseIndex ?? goal.runCount) + 1)
    const totalDurationMs = Math.max(goal.totalDurationMs, goal.totalDurationMs + Math.max(0, duration))
    const update = { runCount, totalDurationMs, currentRunId: projected.id }
    this.goals.update(goal.id, update)
    const resultText = task.result ?? task.error ?? ''
    const parsed = parseCheckpoint(resultText, goal.completionConditions) ?? {
      summary: resultText.trim() || (task.status === 'cancelled' ? 'Run cancelled' : 'Run ended without a checkpoint'),
      completedConditions: [],
      incompleteConditions: [...goal.completionConditions],
      nextPlan: '',
      blockers: task.status === 'cancelled' ? ['Run cancelled'] : task.status === 'failed' ? [task.error || 'Run failed'] : []
    }
    this.goals.addCheckpoint({
      goalId: goal.id,
      runId: projected.id,
      phaseIndex: projected.phaseIndex,
      ...parsed,
      durationMs: projected.durationMs ?? duration,
      usage: projected.usage
    })
    const decision = this.decide(goal, task, parsed)
    if (decision.status !== goal.status) {
      const next = this.goals.update(goal.id, { status: decision.status, blockedReason: decision.reason })!
      this.emit(next)
    } else {
      this.emit(this.goals.get(goal.id))
    }
    if (decision.shouldContinue && decision.status === 'active') {
      const next = this.goals.get(goal.id)
      if (next) this.launchNext(next)
    }
    return decision
  }

  private decide(goal: Goal, task: Task, checkpoint: ParsedCheckpoint | null): GoalDecision {
    // A user cancellation wins over the compatibility Task's eventual
    // cancellation callback. Do not resurrect a terminal Goal to waiting_user.
    if (goal.status === 'cancelled') return { status: 'cancelled', complete: false, shouldContinue: false, reason: goal.blockedReason }
    if (goal.status === 'completed') return { status: 'completed', complete: true, shouldContinue: false }
    if (task.status === 'cancelled') return { status: 'waiting_user', complete: false, shouldContinue: false, reason: 'Run cancelled; waiting for user' }
    // TaskRunner may perform a bounded automatic retry for transient failures.
    // Keep the Goal active while that same phase is being re-queued; only a
    // non-retryable or exhausted failure becomes a user-visible failed Goal.
    if (task.status === 'failed' && task.failure?.retryable && (task.attempt ?? 0) < 2) {
      return { status: 'active', complete: false, shouldContinue: false, reason: task.error || 'Transient run failure; retrying' }
    }
    if (task.status === 'failed') return { status: 'failed', complete: false, shouldContinue: false, reason: task.error || 'Run failed' }
    const completed = checkpoint?.completedConditions ?? []
    const complete = goal.completionConditions.every((condition) => completed.some((item) => normalize(item) === normalize(condition) || mentions(completed.join(' '), condition)))
    if (complete) return { status: 'completed', complete: true, shouldContinue: false }
    const stop = goal.stopConditions.find((condition) => mentions(`${checkpoint?.summary ?? ''} ${checkpoint?.blockers.join(' ') ?? ''}`, condition))
    if (stop) return { status: 'blocked', complete: false, shouldContinue: false, reason: `Stop condition: ${stop}` }
    if (goal.runCount >= goal.maxRuns) return { status: 'blocked', complete: false, shouldContinue: false, reason: 'Run budget exhausted' }
    if (goal.totalDurationMs >= goal.maxDurationMs) return { status: 'blocked', complete: false, shouldContinue: false, reason: 'Duration budget exhausted' }
    return { status: 'active', complete: false, shouldContinue: true }
  }

  private launchNext(goal: Goal, enqueue = true): { ok: boolean; error?: string; task?: Task } {
    if (goal.runCount >= goal.maxRuns) return { ok: false, error: 'Goal run budget exhausted' }
    if (goal.totalDurationMs >= goal.maxDurationMs) return { ok: false, error: 'Goal duration budget exhausted' }
    const phaseIndex = goal.runCount
    const previous = this.goals.checkpoints(goal.id).at(-1)
    const prompt = previous?.nextPlan
      ? `${goal.text}\n\nCheckpoint summary:\n${previous.summary}\n\nNext plan:\n${previous.nextPlan}`
      : `${goal.text}\n\nCompletion conditions:\n${goal.completionConditions.map((condition) => `- ${condition}`).join('\n')}${goal.stopConditions.length ? `\n\nStop conditions:\n${goal.stopConditions.map((condition) => `- ${condition}`).join('\n')}` : ''}`
    try {
      const task = this.options.createTask({
        title: goal.text.slice(0, 120),
        prompt,
        workdir: goal.workdir ?? '',
        backend: goal.backend,
        agentId: goal.agentId,
        issueId: goal.issueId,
        goalId: goal.id,
        phaseIndex,
        trigger: phaseIndex === 0 ? 'manual' : 'autopilot',
        startNow: enqueue
      })
      this.taskByGoal.set(goal.id, task.id)
      const updated = this.goals.update(goal.id, { currentRunId: task.runId ?? task.id, status: 'active' })!
      this.emit(updated)
      if (enqueue) this.options.enqueueTask?.(task)
      return { ok: true, task }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const updated = this.goals.update(goal.id, { status: 'failed', blockedReason: reason })
      this.emit(updated)
      return { ok: false, error: reason }
    }
  }
}

export { parseCheckpoint }
