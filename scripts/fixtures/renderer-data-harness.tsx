/**
 * 渲染层数据增量回归夹具：渲染**真实 useTasks/useIssues hook 探针**（React 18 + jsdom + 假桥），
 * 断言全部在 scripts/smoke-renderer-data.mjs。
 *
 * import 顺序即执行顺序：renderer-data-bridge 必须最先执行——api.ts 的 bridge 常量在模块
 * 初始化时读 window.agentdeck，晚一步就是 undefined。
 */
import './renderer-data-bridge'
import { StrictMode } from 'react'
import { useIssues, useTasks } from '../../src/renderer/src/api'
import { BoardView } from '../../src/renderer/src/components/BoardView'
import { controls, issuesProbeState, tasksProbeState } from './renderer-data-bridge'

export { act, createElement } from 'react'
export { createRoot } from 'react-dom/client'
export { useTasks, useIssues } from '../../src/renderer/src/api'
export {
  calls,
  controls,
  tasksProbeState,
  issuesProbeState,
  makeTask,
  makeIssue,
  setTaskSnapshot,
  setIssueSnapshot,
  scriptTaskList,
  scriptIssueList,
  emitTaskUpdated,
  emitTaskDeleted,
  emitIssueUpdated,
  resetBridge
} from './renderer-data-bridge'

/* ------------------------------------------------------------------ 探针 */

export function TasksProbe() {
  const { tasks, refresh, ready, error } = useTasks()
  controls.refresh = refresh
  tasksProbeState.ids = tasks.map((task) => task.id)
  tasksProbeState.ready = ready
  tasksProbeState.error = error
  return null
}

export function IssuesProbe() {
  const { issues } = useIssues()
  issuesProbeState.ids = issues.map((issue) => issue.id)
  return null
}

export function StrictTasksProbe() {
  return <StrictMode><TasksProbe /></StrictMode>
}

export function BoardProbe() {
  return <BoardView tasks={[]} onOpen={() => {}} />
}
