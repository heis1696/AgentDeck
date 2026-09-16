// 界面文案集中定义：任务/Issue 状态、通知类型等中英枚举的中文标签
import type { GoalStatus, IssueStatus, Task, Notification } from '../../shared/types'

export const TASK_STATUS_LABELS: Record<Task['status'], string> = {
  queued: '排队中', running: '执行中', done: '完成', failed: '失败', cancelled: '已取消'
}

/** queued 且 parked：停放在队列外、等用户手动启动（如硬切后继），区别于系统自动调度的普通排队 */
export const isParkedQueued = (task: Pick<Task, 'status' | 'parked'>): boolean => task.status === 'queued' && task.parked === true

/** parked 任务统一口径文案（主进程侧新指引/评论同口径，勿用「待启动」） */
export const PARKED_QUEUED_LABEL = '⏸ 等你启动'

export const ISSUE_STATUS_LABELS: Record<IssueStatus, string> = {
  backlog: '待梳理', todo: '待办', in_progress: '进行中', in_review: '审查中', done: '已完成', blocked: '受阻', cancelled: '已取消'
}

export const NOTIFICATION_KIND_LABELS: Record<Notification['kind'], string> = {
  reported: 'Agent 汇报', assigned: '指派', status: '状态变更', mentioned: '提及'
}

export const GOAL_STATUS_LABELS: Record<GoalStatus, string> = {
  draft: '草稿', active: '进行中', waiting_user: '等待用户', completed: '已完成', blocked: '受阻', cancelled: '已取消', failed: '失败'
}

/** 目标状态配色（GoalPanel / GoalsView 共用）：进行中蓝、等待琥珀、完成绿、其余灰/红（与旧目标页一致） */
export const GOAL_STATUS_COLORS: Record<GoalStatus, string> = {
  draft: '#8b95a5', active: '#4f8cff', waiting_user: '#e8a13c',
  completed: '#3cb96e', blocked: '#e8a13c', cancelled: '#8b95a5', failed: '#e05252'
}
