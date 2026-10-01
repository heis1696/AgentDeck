/**
 * 渲染层数据增量回归用假桥（window.agentdeck）：真实 useTasks/useIssues hook 探针的驱动面，
 * 断言全部在 scripts/smoke-renderer-data.mjs。
 *
 * 本模块必须先于渲染层模块执行（renderer-data-harness.tsx 里排第一个 import）：
 * api.ts 的 bridge 常量在模块初始化时读 window.agentdeck，晚一步就是 undefined。
 * 因此本文件不得 import 任何渲染层代码。
 *
 * 行为对齐主进程：tasks.list 按 createdAt 降序、issues.list 按 updatedAt 降序返回；
 * tasks.list 延迟/快照/失败可按调用次序脚本化（制造首载读在途、失败恢复等时序），
 * 事件用监听器表广播。calls.taskList/issueList 是「全量拉取次数」的证据计数。
 */
import type { AgentDeckApi } from '../../src/shared/contracts'
import type { Issue, Task } from '../../src/shared/types'


interface TaskListener { (task: Task): void }
interface IdListener { (id: string): void }
interface IssueListener { (payload: { taskId: string; issueId: string; issue: Issue | null; run: null }): void }

const listeners = {
  taskUpdated: new Set<TaskListener>(),
  taskDeleted: new Set<IdListener>(),
  issuesUpdated: new Set<IssueListener>()
}

export interface ListScriptEntry { snapshot?: Task[]; delayMs?: number; error?: string }
export interface IssueListScriptEntry { snapshot?: Issue[]; delayMs?: number; error?: string }

const taskScript: ListScriptEntry[] = []
const issueScript: IssueListScriptEntry[] = []
const taskSnapshot: Task[] = []
const issueSnapshot: Issue[] = []
export const calls = { taskList: 0, issueList: 0 }

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const api = {
  tasks: {
    list: async (): Promise<Task[]> => {
      calls.taskList++
      const entry = taskScript.shift()
      await wait(entry?.delayMs ?? 0)
      if (entry?.error) throw new Error(entry.error)
      // 无脚本条目时返回实时快照，对齐主进程 tasks.list 的 createdAt 降序契约
      const live = [...taskSnapshot].sort((left, right) => right.createdAt - left.createdAt)
      return entry?.snapshot ? [...entry.snapshot] : live
    },
    get: async (id: string): Promise<Task | null> => taskSnapshot.find((task) => task.id === id) ?? null,
    onUpdated: (cb: TaskListener) => { listeners.taskUpdated.add(cb); return () => { listeners.taskUpdated.delete(cb) } },
    onDeleted: (cb: IdListener) => { listeners.taskDeleted.add(cb); return () => { listeners.taskDeleted.delete(cb) } }
  },
  goals: {
    list: async () => [],
    onUpdated: () => () => {},
    onDeleted: () => () => {}
  },
  meetings: {
    list: async () => [],
    onUpdated: () => () => {},
    onDeleted: () => () => {}
  },
  issues: {
    list: async (): Promise<Issue[]> => {
      calls.issueList++
      const entry = issueScript.shift()
      await wait(entry?.delayMs ?? 0)
      if (entry?.error) throw new Error(entry.error)
      const live = [...issueSnapshot].sort((left, right) => right.updatedAt - left.updatedAt)
      return entry?.snapshot ? [...entry.snapshot] : live
    },
    onUpdated: (cb: IssueListener) => { listeners.issuesUpdated.add(cb); return () => { listeners.issuesUpdated.delete(cb) } }
  }
} as unknown as AgentDeckApi
;(window as unknown as { agentdeck: AgentDeckApi }).agentdeck = api


/* ------------------------------------------------------------------ 探针状态与驱动面 */

export interface TasksProbeState { ids: string[]; ready: boolean; error: string | null }
export interface IssuesProbeState { ids: string[] }
export const tasksProbeState: TasksProbeState = { ids: [], ready: false, error: null }
export const issuesProbeState: IssuesProbeState = { ids: [] }
/** 探针把 useTasks().refresh 暴露给脚本：显式刷新/卸载在途读用例直接驱动 */
export const controls: { refresh?: () => Promise<Task[] | null> } = {}

export function makeTask(id: string, createdAt: number): Task {
  return { id, title: id, prompt: id, backend: 'zcode', status: 'queued', createdAt, eventCount: 0, workdir: '' } as unknown as Task
}
export function makeIssue(id: string, taskId: string, updatedAt: number): Issue {
  return { id, taskId, title: id, status: 'queued', createdAt: updatedAt, updatedAt } as unknown as Issue
}
export function setTaskSnapshot(tasks: Task[]) { taskSnapshot.splice(0, taskSnapshot.length, ...tasks) }
export function setIssueSnapshot(issues: Issue[]) { issueSnapshot.splice(0, issueSnapshot.length, ...issues) }
export function scriptTaskList(entries: ListScriptEntry[]) { taskScript.push(...entries) }
export function scriptIssueList(entries: IssueListScriptEntry[]) { issueScript.push(...entries) }
/** 广播同步维护实时快照（对齐主进程：list 之后的广播都能被下一次 list 看到） */
export function emitTaskUpdated(task: Task) {
  const index = taskSnapshot.findIndex((candidate) => candidate.id === task.id)
  if (index >= 0) taskSnapshot[index] = task
  else taskSnapshot.push(task)
  for (const cb of listeners.taskUpdated) cb(task)
}
export function emitTaskDeleted(id: string) {
  const index = taskSnapshot.findIndex((candidate) => candidate.id === id)
  if (index >= 0) taskSnapshot.splice(index, 1)
  for (const cb of listeners.taskDeleted) cb(id)
}
export function emitIssueUpdated(issue: Issue | null, id = issue?.id ?? '') {
  if (issue) {
    const index = issueSnapshot.findIndex((candidate) => candidate.id === issue.id)
    if (index >= 0) issueSnapshot[index] = issue
    else issueSnapshot.push(issue)
  } else {
    const index = issueSnapshot.findIndex((candidate) => candidate.id === id)
    if (index >= 0) issueSnapshot.splice(index, 1)
  }
  const payload = { taskId: issue?.taskId ?? '', issueId: id, issue, run: null }
  for (const cb of listeners.issuesUpdated) cb(payload)
}
export function resetBridge() {
  taskScript.length = 0
  issueScript.length = 0
  taskSnapshot.length = 0
  issueSnapshot.length = 0
  calls.taskList = 0
  calls.issueList = 0
  controls.refresh = undefined
}
