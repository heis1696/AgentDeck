#!/usr/bin/env node
/**
 * scripts/smoke-ui-extensions.mjs — 扩展 / 技能读状态冒烟（Batch B follow-up，docs/UX-WORKFLOW-OPTIMIZATION.md）
 *
 * 只驱动真实组件（jsdom + 假桥 scripts/fixtures/ui-visual-bridge），不改写组件内部判定：
 *   技能 / MCP / Hooks / 插件四个 tab 的读状态必须互斥可辨：
 *     首次加载 → 加载态；首次失败 → 整块错误态 + 重试（不得伪装成「还没有…」的空态）；
 *     成功但为空 → 空态；刷新失败但有旧数据 → 陈旧横幅 + 数据保留 + 重试。
 *   共享目录未知（设置没到 / 首次读没成功）时停用写操作：写盘需要一个确定的目录。
 *   选中的扩展 tab 跨普通导航保留（离开扩展页再回来仍是同一个 tab）。
 *
 * 运行：node scripts/smoke-ui-extensions.mjs
 * （本文件不接入 package.json：package scripts 属共享文件，由领队集成时统一登记。）
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const root = path.resolve(import.meta.dirname, '..')
const dom = new JSDOM('<!doctype html><div id="app"></div><div id="confirm"></div>', { url: 'http://localhost', pretendToBeVisual: true })
const { window } = dom
for (const key of ['document', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'Node', 'Element', 'Event', 'MouseEvent', 'KeyboardEvent', 'FocusEvent', 'localStorage']) globalThis[key] = window[key]
globalThis.window = window
globalThis.getComputedStyle = window.getComputedStyle.bind(window)
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window)
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window)
globalThis.IS_REACT_ACT_ENVIRONMENT = true
window.matchMedia = (media) => ({ matches: false, media, addEventListener() {}, removeEventListener() {} })
window.HTMLElement.prototype.getClientRects = function () { return [{ width: 100, height: 24 }] }

const outfile = path.join(root, 'out/smoke-ui-extensions.cjs')
await build({
  stdin: {
    contents: [
      "import './scripts/fixtures/ui-visual-bridge'",
      "export { act, createElement } from 'react'",
      "export { createRoot } from 'react-dom/client'",
      "export { ui } from './src/renderer/src/ui/interaction-center'",
      "export { ConfirmHost } from './src/renderer/src/ui/Confirm'",
      "export { ExtensionsView } from './src/renderer/src/components/ExtensionsView'"
    ].join('\n'),
    resolveDir: root,
    loader: 'tsx'
  },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', 'lucide-react'],
  logLevel: 'silent'
})

const { act, createElement, createRoot, ui, ConfirmHost, ExtensionsView } = await import(pathToFileURL(outfile).href)

/* ------------------------------------------------------------------ 工具 */

const api = window.agentdeck
const restore = {}
for (const key of Object.keys(api)) restore[key] = { ...api[key] }
const snapshotApi = () => { for (const key of Object.keys(restore)) Object.assign(api[key], restore[key]) }
const setSettings = (patch) => api.settings.set(patch)

const host = document.getElementById('app')
const confirmHost = document.getElementById('confirm')
let reactRoot
let confirmRoot
await act(async () => {
  reactRoot = createRoot(host)
  confirmRoot = createRoot(confirmHost)
  confirmRoot.render(createElement(ConfirmHost))
})

const mount = async () => { await act(async () => { reactRoot.render(createElement(ExtensionsView)) }) }
const unmount = async () => {
  await act(async () => { reactRoot.render(null) })
  snapshotApi()
}
const settle = async (rounds = 3) => {
  await act(async () => { for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0)) })
}
const click = (node, label) => act(async () => {
  assert(node, `click target exists${label ? `: ${label}` : ''}`)
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
})
const button = (text, scope = host) => [...scope.querySelectorAll('button')].find((node) => node.textContent.trim().startsWith(text))
const tabButton = (label) => [...host.querySelectorAll('.ext-tab')].find((node) => node.textContent.trim() === label)
const activeTab = () => host.querySelector('.ext-tab.active')?.textContent.trim()
const items = () => [...host.querySelectorAll('.skills-item')]
/** 共享目录变更会触发各 tab 重载：用它制造「有旧数据时的刷新失败」 */
const reloadByDirChange = async (dir) => {
  await act(async () => { await setSettings({ sharedDir: dir }) })
  await settle()
}

const unhandled = []
const onUnhandled = (error) => unhandled.push(String(error))
process.on('unhandledRejection', onUnhandled)

const skills = [
  { name: 'alpha', description: '第一个技能', dir: 'C:\\Shared\\skills\\alpha', files: ['SKILL.md'], updatedAt: Date.now(), bodyBytes: 12 },
  { name: 'beta', description: '第二个技能', dir: 'C:\\Shared\\skills\\beta', files: ['SKILL.md'], updatedAt: Date.now(), bodyBytes: 20 }
]
const skillTargets = [
  { id: 'claude', label: 'Claude Code', dir: 'C:\\Users\\u\\.claude\\skills', hint: '用户级技能目录' },
  { id: 'zcode', label: 'ZCode', dir: 'C:\\Users\\u\\.zcode\\skills', hint: '用户级技能目录' }
]
const mcpServers = [{ name: 'filesystem', description: '文件系统 MCP', file: 'C:\\Shared\\mcp\\filesystem.mcp.json', transport: { type: 'stdio', command: 'npx', args: ['-y', 'server-filesystem'] }, updatedAt: Date.now() }]
const hookMetas = [{ name: 'format-on-write', description: '写入后格式化', dir: 'C:\\Shared\\hooks\\format-on-write', events: { PreToolUse: [{ hooks: [{ type: 'command', command: 'npx prettier' }] }] }, updatedAt: Date.now() }]

try {
  /* ------------------------------------------ 1. 技能 tab 四态 + 阻断写入 */
  console.log('[1] 技能：首次失败 / 重试成功 / 陈旧保留 / 目录未知禁用写入')
  api.skills.list = async () => { throw new Error('shared dir unavailable') }
  api.skills.targets = async () => { throw new Error('targets unavailable') }
  await mount()
  assert.equal(activeTab(), '技能', '默认停在技能 tab')
  assert(host.textContent.includes('技能库读取失败'), '首次失败是整块错误态，不伪装成空态')
  assert(host.textContent.includes('共享目录位置未知'), '首次失败说明写入为何不可用')
  assert(button('重试'), '首次失败带重试入口')
  assert.equal(host.textContent.includes('还没有技能'), false, '首次失败不得渲染「还没有技能」')

  api.skills.list = async () => ({ root: 'C:\\Workspace\\Shared', skills })
  api.skills.targets = async () => ({ targets: skillTargets, states: { alpha: { claude: 'in-sync' }, beta: { claude: 'outdated' } } })
  await click(button('重试'), '重试读取技能库')
  await settle()
  assert.equal(items().length, 2, '重试成功后列出技能')
  assert(host.textContent.includes('C:\\Workspace\\Shared'), '共享目录路径可见')
  assert.equal(host.querySelector('[data-skills-writes-blocked]'), null, '目录已知后不再阻断写入')

  // 打开技能：目标 chip 反映同步态
  api.skills.get = async (name) => ({ name, description: `${name} 说明`, body: '正文', files: ['SKILL.md'] })
  await click(items()[0], '打开第一个技能')
  assert(host.querySelector('.skill-target.st-in-sync'), '目标 chip 显示已同步态')

  // 刷新失败：保留旧数据 + 陈旧横幅 + 重试
  api.skills.list = async () => { throw new Error('skills refresh failed') }
  await reloadByDirChange('C:\\Workspace\\Shared2')
  assert(host.querySelector('[data-stale="skills"]'), '技能刷新失败给陈旧横幅')
  assert(host.querySelector('[data-stale="skills"]').textContent.includes('skills refresh failed'), '陈旧横幅说明原因')
  assert.equal(items().length, 2, '刷新失败保留上次成功的技能列表')

  api.skills.list = async () => ({ root: 'C:\\Workspace\\Shared2', skills: skills.slice(0, 1) })
  await click(button('重试', host.querySelector('[data-stale="skills"]')), '横幅重试')
  await settle()
  assert.equal(host.querySelector('[data-stale="skills"]'), null, '重试成功后陈旧横幅消失')
  assert.equal(items().length, 1, '重试后列表刷新')

  // 发现技能区：读失败不能伪装成静默空
  api.sources.listSkills = async () => { throw new Error('sources unavailable') }
  api.sources.list = async () => { throw new Error('sources unavailable') }
  await reloadByDirChange('C:\\Workspace\\Shared-discovery')
  await click(button('发现技能'), '展开发现技能')
  await settle()
  assert(host.textContent.includes('发现技能读取失败'), '发现技能读失败有独立错误态')
  assert(button('重试', host.querySelector('.ext-skill-discover')), '发现技能读失败带重试')
  console.log('PASS 技能：首次失败 / 成功列表 / 陈旧保留 / 重试恢复 / 发现区读状态')

  /* ------------------------------------------------ 2. MCP tab 读状态 */
  console.log('[2] MCP：首次失败 / 重试成功 / 刷新失败保留数据')
  await unmount()
  api.mcp.list = async () => { throw new Error('mcp dir unavailable') }
  api.mcp.targets = async () => ({ targets: [], states: {} })
  await mount()
  await click(tabButton('MCP'), '切到 MCP')
  await settle()
  assert(host.textContent.includes('MCP 服务器读取失败'), 'MCP 首次失败是错误态')
  assert(host.textContent.includes('共享目录位置未知'), 'MCP 首次失败说明写入为何不可用')
  assert.equal(host.textContent.includes('还没有 MCP 服务器'), false, '首次失败不得渲染空态')

  api.mcp.list = async () => ({ servers: mcpServers })
  api.mcp.targets = async () => ({ targets: [{ id: 'claude', label: 'Claude Code', hint: '用户级配置' }], states: { filesystem: { claude: 'in-sync' } } })
  await click(button('重试'), '重试读取 MCP')
  await settle()
  assert.equal(items().length, 1, 'MCP 列表已渲染')
  assert.equal(host.querySelector('[data-mcp-writes-blocked]'), null, '目录已知后 MCP 写操作开放')

  api.mcp.list = async () => { throw new Error('mcp refresh failed') }
  await reloadByDirChange('C:\\Workspace\\Shared3')
  assert(host.querySelector('[data-stale="mcp"]'), 'MCP 刷新失败给陈旧横幅')
  assert.equal(items().length, 1, 'MCP 刷新失败保留上次成功的列表')
  console.log('PASS MCP：首次失败 / 成功列表 / 刷新失败保留')

  /* ----------------------------------------------- 3. Hooks tab 读状态 */
  console.log('[3] Hooks：首次失败 / 重试成功 / 刷新失败保留数据')
  await unmount()
  api.hooks.list = async () => { throw new Error('hooks dir unavailable') }
  api.hooks.targets = async () => ({ targets: [], states: {} })
  await mount()
  await click(tabButton('Hooks'), '切到 Hooks')
  await settle()
  assert(host.textContent.includes('Hook 资产读取失败'), 'Hooks 首次失败是错误态')
  assert.equal(host.textContent.includes('还没有 Hook 资产'), false, '首次失败不得渲染空态')

  api.hooks.list = async () => ({ hooks: hookMetas })
  api.hooks.targets = async () => ({ targets: [{ id: 'claude', label: 'Claude Code', hint: '用户级配置' }], states: { 'format-on-write': { claude: 'outdated' } } })
  await click(button('重试'), '重试读取 Hooks')
  await settle()
  assert.equal(items().length, 1, 'Hooks 列表已渲染')

  api.hooks.list = async () => { throw new Error('hooks refresh failed') }
  await reloadByDirChange('C:\\Workspace\\Shared4')
  assert(host.querySelector('[data-stale="hooks"]'), 'Hooks 刷新失败给陈旧横幅')
  assert.equal(items().length, 1, 'Hooks 刷新失败保留上次成功的列表')
  console.log('PASS Hooks：首次失败 / 成功列表 / 刷新失败保留')

  /* ---------------------------- 4. 插件 tab + 市场浏览 + tab 跨导航保留 */
  console.log('[4] 插件：首次失败 / 盘点成功 / 刷新失败保留 / 市场清单 / tab 记忆')
  await unmount()
  api.plugins.inventory = async () => { throw new Error('inventory unavailable') }
  await mount()
  await click(tabButton('插件'), '切到插件')
  await settle()
  assert(host.textContent.includes('插件清单读取失败'), '插件首次失败是错误态')
  assert(host.textContent.includes('已装状态未知'), '插件首次失败说明装卸为何不可用')
  assert.equal(activeTab(), '插件')

  api.plugins.inventory = async () => ({
    items: [
      { cli: 'claude', kind: 'plugin', name: 'demo', marketplace: 'demo-market', enabled: true, installed: true, version: '1.0.0' },
      { cli: 'codex', kind: 'plugin', name: 'codex-pack' }
    ]
  })
  await click(button('重试'), '重试盘点')
  await settle()
  assert(host.textContent.includes('demo@demo-market'), '插件清单已渲染')
  assert.equal(host.querySelector('.ext-plugin-remove').disabled, false, '盘点成功后装卸可用')
  assert.equal(host.querySelector('[data-plugins-writes-blocked]'), null, '盘点成功后不再阻断装卸')

  // 启停会顺带刷新盘点：刷新失败时保留旧清单 + 陈旧横幅
  api.plugins.setEnabled = async () => ({ ok: true })
  api.plugins.inventory = async () => { throw new Error('inventory refresh failed') }
  await click(host.querySelector('.toggle-control'), '切换启用（随后刷新）')
  await settle()
  assert(host.querySelector('[data-stale="plugins"]'), '插件刷新失败给陈旧横幅')
  assert(host.textContent.includes('demo@demo-market'), '插件刷新失败保留上次成功的清单')

  // 市场浏览：首次失败 → 错误态 + 重试 → 清单渲染
  api.marketplaces.listRegistered = async () => { throw new Error('marketplace cache unavailable') }
  await click(button('浏览已注册市场'), '展开市场浏览')
  await settle()
  assert(host.textContent.includes('市场清单读取失败'), '市场清单首次失败是错误态')
  api.marketplaces.listRegistered = async () => ({ marketplaces: [{ name: 'demo-market', clis: ['claude'], plugins: [{ name: 'demo', description: '示例插件' }] }] })
  await click(button('重试', host.querySelector('.ext-market-browse')), '重试市场清单')
  await settle()
  assert(host.textContent.includes('demo-market'), '市场清单已渲染')

  // 普通导航：离开扩展页再回来，选中的 tab 不变
  assert.equal(window.localStorage.getItem('agentdeck:extensions-tab'), 'plugins', '选中的 tab 写入 localStorage')
  await unmount()
  api.plugins.inventory = async () => ({ items: [] })
  api.marketplaces.listRegistered = async () => ({ marketplaces: [] })
  await mount()
  await settle()
  assert.equal(activeTab(), '插件', '重新挂载后仍是上次选中的插件 tab')
  console.log('PASS 插件：首次失败 / 成功盘点 / 刷新失败保留 / 市场清单读状态 / tab 记忆')

  /* --------------------------- 5. 共享目录未知（设置读不到）时写入被阻断 */
  console.log('[5] 目录未知：设置读不到时技能写操作停用')
  await unmount()
  api.settings.get = async () => { throw new Error('settings unavailable') }
  api.settings.onUpdated = () => () => {}
  api.skills.list = async () => ({ root: 'C:\\Workspace\\Shared', skills })
  api.skills.targets = async () => ({ targets: skillTargets, states: {} })
  await mount()
  await click(tabButton('技能'), '切回技能 tab')
  await settle()
  assert.equal(items().length, 2, '技能列表仍可读')
  assert(host.querySelector('[data-skills-writes-blocked]'), '目录未知时给出写入停用的说明')
  assert.equal(button('新建技能').disabled, true, '目录未知时新建被禁用')
  assert.equal(button('导入…').disabled, true, '目录未知时导入被禁用')
  assert.equal(button('全部同步').disabled, true, '目录未知时同步被禁用')
  console.log('PASS 目录未知：读仍可用、写被阻断且有说明')
} finally {
  if (host.hasChildNodes()) await act(async () => reactRoot.render(null))
  process.off('unhandledRejection', onUnhandled)
  dom.window.close()
}

assert.deepEqual(unhandled, [], '没有任何未处理的 Promise rejection')
console.log('UI EXTENSIONS SMOKE PASSED')
