/** Batch A 行为夹具：使用真实 App、命令面板、Issue 主页和看板，桥接层由 smoke 脚本注入。 */
import './ui-draft-bridge'

export { act, createElement } from 'react'
export { createRoot } from 'react-dom/client'
export { App } from '../../src/renderer/src/App'
export { ui } from '../../src/renderer/src/ui/interaction-center'
export { getDraftBridge } from './ui-draft-bridge'
