import type { ExecutionRecord, GoalStatus, IssueStatus, RunStatus, Task, TaskStatus } from './types'
import type { MeetingActor, MeetingStatus } from './meeting'
import { canTransitionMeeting as canTransitionMeetingState, isTerminalMeetingStatus, validateMeetingTransition as validateMeetingTransitionState } from './meeting'

export { canTransitionMeetingState as canTransitionMeeting, isTerminalMeetingStatus, validateMeetingTransitionState as validateMeetingTransition }
export type { MeetingActor, MeetingStatus }

/**
 * The task lifecycle is shared by the runner, IPC handlers, and projections.
 * Keep the matrix data-only so adding a transition cannot silently diverge in
 * one of those consumers.
 */
const TRANSITIONS: Record<'runner' | 'ui', Record<TaskStatus, readonly TaskStatus[]>> = {
  runner: {
    queued: ['running'],
    running: ['done', 'failed', 'cancelled'],
    done: [],
    failed: [],
    cancelled: []
  },
  ui: {
    queued: ['running', 'cancelled'],
    running: ['cancelled'],
    done: ['queued'],
    failed: ['queued'],
    cancelled: ['queued']
  }
}

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['done', 'failed', 'cancelled']

const GOAL_TRANSITIONS: Record<'controller' | 'user', Record<GoalStatus, readonly GoalStatus[]>> = {
  controller: {
    draft: ['active', 'cancelled'],
    active: ['waiting_user', 'completed', 'blocked', 'failed', 'cancelled'],
    waiting_user: ['active', 'cancelled'],
    completed: [],
    blocked: ['active', 'cancelled'],
    cancelled: [],
    failed: ['active', 'cancelled']
  },
  user: {
    draft: ['active', 'cancelled'],
    active: ['waiting_user', 'cancelled'],
    waiting_user: ['active', 'cancelled'],
    completed: [],
    blocked: ['active', 'cancelled'],
    failed: ['active', 'cancelled'],
    cancelled: []
  }
}

export const TERMINAL_GOAL_STATUSES: readonly GoalStatus[] = ['completed', 'blocked', 'cancelled', 'failed']

export function canTransitionGoal(from: GoalStatus, to: GoalStatus, actor: 'controller' | 'user' = 'controller'): boolean {
  if (from === to) return true
  return GOAL_TRANSITIONS[actor][from].includes(to)
}

export function isTerminalGoalStatus(status: GoalStatus): boolean {
  return TERMINAL_GOAL_STATUSES.includes(status)
}

export function validateGoalTransition(from: GoalStatus, to: GoalStatus, actor: 'controller' | 'user' = 'controller'):
  { ok: true } | { ok: false; error: string } {
  if (!canTransitionGoal(from, to, actor)) return { ok: false, error: `Invalid goal transition: ${from} -> ${to}` }
  return { ok: true }
}

export function canTransition(from: TaskStatus, to: TaskStatus, actor: 'runner' | 'ui'): boolean {
  if (from === to) return true
  return TRANSITIONS[actor][from].includes(to)
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(status)
}

/** Retrying is a UI transition and always starts a fresh execution record. */
export function canRetry(status: TaskStatus): boolean {
  return isTerminalTaskStatus(status) && canTransition(status, 'queued', 'ui')
}

/** Human-facing workflow status derived from an execution task. */
export function taskStatusToIssueStatus(status: TaskStatus): IssueStatus {
  if (status === 'queued') return 'todo'
  if (status === 'running') return 'in_progress'
  if (status === 'done') return 'in_review'
  if (status === 'cancelled') return 'cancelled'
  return 'blocked'
}

/** Run projection status derived from an execution task. */
export function taskStatusToRunStatus(status: TaskStatus): RunStatus {
  if (status === 'running' || status === 'queued') return 'running'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'done') return 'completed'
  return 'error'
}

/** Project a compatibility Task into one concrete execution record. */
export function executionRecordFromTask(task: Task): ExecutionRecord {
  return {
    id: task.runId ?? `legacy_${task.id}_${task.attempt ?? 1}`,
    issueId: task.issueId ?? `iss_${task.id}`,
    taskId: task.id,
    ...(task.agentId ? { agentId: task.agentId } : {}),
    trigger: task.trigger ?? 'assignment',
    prompt: task.prompt,
    status: taskStatusToRunStatus(task.status),
    startedAt: task.startedAt,
    finishedAt: task.endedAt,
    durationMs: task.usage?.durationMs,
    usage: task.usage,
    transcriptEventCount: task.eventCount,
    ...(task.goalId ? { goalId: task.goalId } : {}),
    ...(task.phaseIndex !== undefined ? { phaseIndex: task.phaseIndex } : {})
  }
}

export function validateMove(from: TaskStatus, to: TaskStatus): { ok: true } | { ok: false; error: string } {
  if (!canTransition(from, to, 'ui')) {
    if (from === 'running') return { ok: false, error: '请先取消运行中的任务' }
    if (to === 'running' && from !== 'queued') return { ok: false, error: '只有排队中的任务可以启动' }
    return { ok: false, error: '无效的任务状态转换' }
  }
  return { ok: true }
}

/**
 * Issue 人工工作流矩阵：与任务/目标同款 data-only 矩阵（加一条流转只改这里）。
 * 语义边界：
 * - 这是**人工**维度——执行投影（taskStatusToIssueStatus）不受此约束，运行期以执行态为准；
 * - 终态可重开（done→in_review、cancelled→todo），重开是显式的人工动作；
 * - blocked 是旁路：开工前（todo）与执行/审查中都可能受阻，解除后回待办或直接继续。
 */
const ISSUE_TRANSITIONS: Record<IssueStatus, readonly IssueStatus[]> = {
  backlog: ['todo', 'cancelled'],
  todo: ['in_progress', 'backlog', 'blocked', 'cancelled'],
  in_progress: ['in_review', 'blocked', 'cancelled'],
  in_review: ['done', 'in_progress', 'blocked', 'cancelled'],
  done: ['in_review'],
  blocked: ['todo', 'in_progress', 'cancelled'],
  cancelled: ['todo']
}

export function canTransitionIssue(from: IssueStatus, to: IssueStatus): boolean {
  if (from === to) return true
  return ISSUE_TRANSITIONS[from].includes(to)
}

export function issueTransitionTargets(from: IssueStatus): readonly IssueStatus[] {
  return ISSUE_TRANSITIONS[from]
}

export function validateIssueMove(from: IssueStatus, to: IssueStatus): { ok: true } | { ok: false; error: string } {
  if (!canTransitionIssue(from, to)) {
    if (from === 'done') return { ok: false, error: '已完成的 Issue 只能重开为「审查中」，不能直接流转' }
    if (from === 'cancelled') return { ok: false, error: '已取消的 Issue 只能重开为「待办」' }
    if (from === 'in_progress') return { ok: false, error: '进行中的 Issue 先进入「审查中」或标记「受阻」' }
    return { ok: false, error: `无效的 Issue 状态流转：${from} -> ${to}` }
  }
  return { ok: true }
}
