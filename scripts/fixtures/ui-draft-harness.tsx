/**
 * 草稿/目录集成回归夹具：渲染**真实 <App/>**（完整导航链路：useTasks → 交互中心 → 视图），
 * 断言全部在 scripts/smoke-ui-draft-catalog.mjs。
 *
 * import 顺序即执行顺序：ui-draft-bridge 必须最先执行——api.ts 的 bridge 常量在模块
 * 初始化时读 window.agentdeck，晚一步就是 undefined。
 */
import './ui-draft-bridge'

export { act, createElement } from 'react'
export { createRoot } from 'react-dom/client'
export { App } from '../../src/renderer/src/App'
export { ui } from '../../src/renderer/src/ui/interaction-center'
export { getDraftBridge } from './ui-draft-bridge'
