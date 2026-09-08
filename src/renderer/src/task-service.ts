import type { Task } from '../../shared/types'
import { bridge } from './api'

/** Renderer task commands. Components pass domain values, not IPC payloads. */
export const taskService = {
  start: (taskId: string) => bridge.tasks.start(taskId),
  cancel: (taskId: string) => bridge.tasks.cancel(taskId),
  retry: (taskId: string) => bridge.tasks.retry(taskId),
  delete: (taskId: string) => bridge.tasks.delete(taskId),
  followUp: (taskId: string, content: string, opts?: { relay?: boolean }) => bridge.tasks.followUp(taskId, content, opts),
  rewind: (taskId: string, toSeq: number) => bridge.tasks.rewind(taskId, toSeq),
  rename: (taskId: string, title: string) => bridge.tasks.rename(taskId, title),
  duplicate: (task: Task) => bridge.tasks.create({
    title: `${task.title} (副本)`,
    prompt: task.prompt,
    workdir: task.workdir,
    backend: task.backend
  })
}
