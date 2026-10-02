import type { Task } from './types'

export type TaskVisibilityMetadata = Pick<Task, 'suppressIssue' | 'officeAgentId' | 'meetingTaskRole'>

export function isPublicTask(task: TaskVisibilityMetadata): boolean {
  if (task.meetingTaskRole === 'container') return true
  return !task.suppressIssue && !task.officeAgentId && task.meetingTaskRole !== 'member' && task.meetingTaskRole !== 'investigation'
}

export function publicTasksOf<T extends TaskVisibilityMetadata>(tasks: readonly T[]): T[] {
  return tasks.filter(isPublicTask)
}
