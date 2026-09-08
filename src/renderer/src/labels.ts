// 界面文案集中定义：任务/Issue 状态、通知类型等中英枚举的中文标签
import type { GoalStatus, IssueStatus, Task, Notification } from '../../shared/types'

export const TASK_STATUS_LABELS: Record<Task['status'], string> = {
  queued: '排队中', running: '执行中', done: '完成', failed: '失败', cancelled: '已取消'
}

export const ISSUE_STATUS_LABELS: Record<IssueStatus, string> = {
  backlog: '待梳理', todo: '待办', in_progress: '进行中', in_review: '审查中', done: '已完成', blocked: '受阻', cancelled: '已取消'
}

export const NOTIFICATION_KIND_LABELS: Record<Notification['kind'], string> = {
  reported: 'Agent 汇报', assigned: '指派', status: '状态变更', mentioned: '提及'
}

export const GOAL_STATUS_LABELS: Record<GoalStatus, string> = {
  draft: '草稿', active: '进行中', waiting_user: '等待用户', completed: '已完成', blocked: '受阻', cancelled: '已取消', failed: '失败'
}
