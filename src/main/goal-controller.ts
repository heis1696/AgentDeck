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
  /** 续轮首选：同会话续聊（v2） */
  continueTask?: (taskId: string, content: string) => Promise<{ ok: boolean; error?: string }> | { ok: boolean; error?: string }
  /** 完成时调用：Issue 归档 done（v2） */
  finalizeIssue?: (issueId: string) => void
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
  /** 在飞续轮标记：防止重复派发（goalId+taskId 去重） */
  private readonly inflightContinues = new Set<string>()

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
    const issueId = input.issueId.trim()
    if (!text) throw new Error('Goal text cannot be empty')
    if (!issueId) throw new Error('issueId is required')
    if (!completionConditions.length) throw new Error('At least one completion condition is required')
    if (!Number.isInteger(input.maxRuns) || input.maxRuns < 1 || input.maxRuns > 10000) throw new Error('maxRuns must be an integer between 1 and 10000')
    if (!Number.isFinite(input.maxDurationMs) || input.maxDurationMs <= 0) throw new Error('maxDurationMs must be positive')
    if (typeof input.workdir !== 'string') throw new Error('workdir is required')
    const id = `goal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const record: GoalCreateRecord = {
      issueId,
      text,
      completionConditions,
      stopConditions: cleanLines(input.stopConditions),
      maxRuns: input.maxRuns,
      maxDurationMs: input.maxDurationMs,
      workdir: input.workdir,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.backend ? { backend: input.backend } : {})
    }
    const goal = this.goals.create(record)
    // v2：收养该 Issue 现有最新 Task（无则建首个；有则登记为当前阶段任务）
    const knownTasks = this.options.listTasks?.() ?? []
    const existing = knownTasks.filter((t) => t.issueId === issueId).sort((a, b) => b.createdAt - a.createdAt)[0]
    if (existing) {
      // 有现有任务：登记为当前阶段（不新建）
      this.taskByGoal.set(goal.id, existing.id)
      const currentRunId = existing.runId ?? existing.id
      const updated = this.goals.update(goal.id, { currentRunId, status: 'active' })!
      this.emit(updated)
      // startNow 时按状态启动：queued→enqueue；done/failed→续聊回灌；running→等终态
      if (input.startNow !== false) {
        if (existing.status === 'queued') {
          const started = this.options.startTask?.(existing) ?? existing
          this.options.enqueueTask?.(started)
        } else if (existing.status === 'done' || existing.status === 'failed') {
          // 立即触发首轮续聊
          void this.triggerContinue(goal.id, existing.id, undefined)
        }
        // running 不需要操作，onTaskChanged 会在终态时自动续轮
      }
    } else {
      // 无任务：建首个
      const launched = this.launchNext(goal, input.startNow !== false)
      if (!launched.ok) throw new Error(launched.error)
      if (input.startNow === false) {
        const parked = this.goals.update(goal.id, { status: 'draft' })!
        this.emit(parked)
      }
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
    // v2：优先对最新 Task 触发续轮（首选 followUp，无则 launchNext）
    const taskId = this.taskByGoal.get(id)
    if (taskId) {
      void this.triggerContinue(id, taskId, undefined)
      return { ok: true as const }
    }
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

  /** Feed every TaskChanged notification to the goal state machine (v2：只认 task.issueId === goal.issueId 的任务）。 */
  onTaskChanged(task: Task): GoalDecision | null {
    if (!task.goalId) return null
    const goal = this.goals.get(task.goalId)
    if (!goal) return null
    // v2：只处理该 Issue 的任务（天然收养 <continue> 接力任务——循环跟随 Issue 最新任务）
    if (task.issueId !== goal.issueId) return null
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
    // v2：完成时调用 finalizeIssue（归档 Issue）；非重试失败自动续轮（failures 上限 2）
    if (decision.complete && decision.status === 'completed') {
      this.options.finalizeIssue?.(goal.issueId)
    }
    if (decision.status !== goal.status) {
      const next = this.goals.update(goal.id, { status: decision.status, blockedReason: decision.reason })!
      this.emit(next)
    } else {
      this.emit(this.goals.get(goal.id))
    }
    // v2：续轮引擎（首选同会话续聊 continueTask，兜底 launchNext 新任务）
    if (decision.shouldContinue && decision.status === 'active') {
      const next = this.goals.get(goal.id)
      if (next) void this.triggerContinue(next.id, task.id, parsed)
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
    // v2：非重试失败自动续轮（failures 上限 2；续轮成功后清零）
    if (task.status === 'failed') {
      const failures = (goal.failures ?? 0) + 1
      this.goals.update(goal.id, { failures })
      if (failures < 2) {
        return { status: 'active', complete: false, shouldContinue: true, reason: `Auto-retry after failure ${failures}/2: ${task.error || 'Run failed'}` }
      }
      return { status: 'failed', complete: false, shouldContinue: false, reason: `Failure limit reached (${failures}): ${task.error || 'Run failed'}` }
    }
    // 成功续轮时清零 failures
    if (task.status === 'done' && goal.failures) {
      this.goals.update(goal.id, { failures: 0 })
    }
    const completed = checkpoint?.completedConditions ?? []
    const complete = goal.completionConditions.every((condition) => completed.some((item) => normalize(item) === normalize(condition) || mentions(completed.join(' '), condition)))
    if (complete) return { status: 'completed', complete: true, shouldContinue: false }
    const stop = goal.stopConditions.find((condition) => mentions(`${checkpoint?.summary ?? ''} ${checkpoint?.blockers.join(' ') ?? ''}`, condition))
    if (stop) return { status: 'waiting_user', complete: false, shouldContinue: false, reason: `Stop condition: ${stop}` }
    if (goal.runCount >= goal.maxRuns) return { status: 'blocked', complete: false, shouldContinue: false, reason: 'Run budget exhausted' }
    if (goal.totalDurationMs >= goal.maxDurationMs) return { status: 'blocked', complete: false, shouldContinue: false, reason: 'Duration budget exhausted' }
    return { status: 'active', complete: false, shouldContinue: true }
  }

  private launchNext(goal: Goal, enqueue = true): { ok: boolean; error?: string; task?: Task } {
    if (goal.runCount >= goal.maxRuns) return { ok: false, error: 'Goal run budget exhausted' }
    if (goal.totalDurationMs >= goal.maxDurationMs) return { ok: false, error: 'Goal duration budget exhausted' }
    const phaseIndex = goal.runCount
    const previous = this.goals.checkpoints(goal.id).at(-1)
    // v2：首个 Task（phaseIndex=0）注入目标模式块（§4.1）
    const GOAL_BLOCK = `【目标模式（自动推进协议）】
本任务在目标模式下运行：每轮回合结束后系统会检查进度并自动让你继续，直到完成条件全部达成。
- 每轮收尾时，在回复末尾输出一个 checkpoint JSON 代码块（\`\`\`json 包裹）：
  {"summary":"本轮摘要","completedConditions":["已达成的完成条件原文"],"incompleteConditions":["未达成的完成条件原文"],"nextPlan":"下一轮计划","blockers":["阻塞项，没有则空数组"]}
- completedConditions/incompleteConditions 必须逐条对照目标完成条件原文填写，不要改写、不要合并。
- 全部完成条件达成的那一轮：completedConditions 填全所有条件，nextPlan 留空，停止派发，直接收尾。
- 需要并行或专长的工作用 <delegate> 派发队员；队员结果回灌后由你按回灌指令给出审核结论。
- 确需换新会话的阶段边界才用 <continue>（简报自包含）；一般推进不要硬切会话。
- 遇到必须人工决策或命中停止条件的事，写进 blockers，不要自行猜测执行。`
    const prompt = phaseIndex === 0
      ? `${goal.text}\n\n完成条件：\n${goal.completionConditions.map((condition) => `- ${condition}`).join('\n')}${goal.stopConditions.length ? `\n\n停止条件：\n${goal.stopConditions.map((condition) => `- ${condition}`).join('\n')}` : ''}\n\n${GOAL_BLOCK}`
      : previous?.nextPlan
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

  /** 续轮引擎（v2）：首选同会话续聊 continueTask（runner.followUp），无 continueTask 或无 sessionId 时走 launchNext 兜底 */
  private async triggerContinue(goalId: string, taskId: string, checkpoint: ParsedCheckpoint | null | undefined) {
    const key = `${goalId}:${taskId}`
    if (this.inflightContinues.has(key)) return
    this.inflightContinues.add(key)
    try {
      const goal = this.goals.get(goalId)
      const task = this.options.listTasks?.().find((t) => t.id === taskId)
      if (!goal || !task) return
      const previous = checkpoint ?? this.goals.checkpoints(goalId).at(-1)
      const n = goal.runCount + 1
      const failures = goal.failures ?? 0
      let content = `【系统·目标模式】第 ${goal.runCount} 轮已结束并记录 checkpoint。\n`
      content += `- 摘要：${previous?.summary ?? '（无 checkpoint）'}\n`
      content += `- 未完成条件：${(previous?.incompleteConditions ?? goal.completionConditions).map((c) => `${c}`).join('、')}\n`
      if (previous?.nextPlan) content += `- 上一轮下一步计划：${previous.nextPlan}\n`
      if (previous?.blockers?.length) content += `- 阻塞：${previous.blockers.join('、')}\n`
      if (failures > 0) content += `- 上一轮失败原因：${task.error || '（未知）'}（自动续轮 ${failures}/2）\n`
      content += `请继续推进目标：先输出一行 <round outcome="..." reason="..."/> 自评，再继续执行或派发；完成条件全部达成时按【目标模式】协议输出 checkpoint 收尾。`

      // 首选 continueTask（同会话续聊）
      if (this.options.continueTask && task.sessionId) {
        const result = await Promise.resolve(this.options.continueTask(taskId, content))
        if (result.ok) return
        // continueTask 失败时走 launchNext 兜底（会话可能已死）
      }
      // 兜底：launchNext 新任务
      this.launchNext(goal, true)
    } finally {
      this.inflightContinues.delete(key)
    }
  }
}

export { parseCheckpoint }
