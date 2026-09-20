/**
 * 任务状态隔离回归夹具：渲染**真实 <App/>**（完整导航链路：useTasks → 交互中心 → 视图 → TaskDetail），
 * 断言全部在 scripts/smoke-ui-task-state.mjs。
 *
 * import 顺序即执行顺序：ui-task-state-bridge 必须最先执行——api.ts 的 bridge 常量在模块
 * 初始化时读 window.agentdeck，晚一步就是 undefined。
 */
import './ui-task-state-bridge'
import { useTaskScopedState } from '../../src/renderer/src/hooks/taskDrafts'

export const scopedProbe = { value: '', set: (_value: string) => {} }
export function ScopedStateProbe({ taskId }: { taskId: string }) {
  const [value, set] = useTaskScopedState(taskId, 'initial')
  scopedProbe.value = value
  scopedProbe.set = set
  return <output>{value}</output>
}

export { act, createElement } from 'react'
export { createRoot } from 'react-dom/client'
export { App } from '../../src/renderer/src/App'
export { ui } from '../../src/renderer/src/ui/interaction-center'
export { getTaskStateBridge } from './ui-task-state-bridge'
/** 追问槽位：让用例能直接核对「每个任务各存了什么」 */
export { resetTaskDrafts, taskDraftSlot } from '../../src/renderer/src/hooks/taskDrafts'
