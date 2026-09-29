import type { Task } from '../../shared/types'
import { bridge } from './api'

/** Renderer task commands. Components pass domain values, not IPC payloads. */
export const taskService = {
  start: (taskId: string) => bridge.tasks.start(taskId),
  /** 取消任务：reason 契约见 shared/contracts.ts —— undefined = 系统取消不打标；
   *  string（含空串）= 用户主动打断，回执落时间线并随委派报告回灌领队 */
  cancel: (taskId: string, reason?: string) => bridge.tasks.cancel(taskId, reason),
  retry: (taskId: string) => bridge.tasks.retry(taskId),
  delete: (taskId: string) => bridge.tasks.delete(taskId),
  followUp: (taskId: string, content: string, opts?: { relay?: boolean; wait?: boolean }) => bridge.tasks.followUp(taskId, content, opts),
  rewind: (taskId: string, toSeq: number) => bridge.tasks.rewind(taskId, toSeq),
  rename: (taskId: string, title: string) => bridge.tasks.rename(taskId, title),
  duplicate: (task: Task) => bridge.tasks.create({
    title: `${task.title} (副本)`,
    prompt: task.prompt,
    workdir: task.workdir,
    backend: task.backend
  })
}
