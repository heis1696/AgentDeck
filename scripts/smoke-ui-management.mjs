#!/usr/bin/env node
/**
 * scripts/smoke-ui-management.mjs — 管理区行为冒烟（Batch B，docs/UX-WORKFLOW-OPTIMIZATION.md）
 *
 * 只驱动真实组件（jsdom + 假桥 scripts/fixtures/ui-visual-bridge），不改写组件内部判定：
 *   RuntimeView   —— 首探失败不得渲染「0 健康 / 0 关注」假健康；刷新失败保留上次成功快照并给重试；
 *                    Agent 目录单独结算（失败只降级那一格计数，不拖垮后端健康）；成功但空列表走空态。
 *   SettingsView  —— 运行时路径显式保存（脏 / 保存中 / 保存失败三态），失败保留草稿；
 *                    「检测路径可用性」必须先等保存落盘（事件顺序 save → probe），保存失败就不探测；
 *                    连点保存只写一次；主题/并发/权限/小助理等设置写入失败必须被捕获并提示。
 *   UpdatePanel   —— 「检查更新」先落盘 feed 草稿（事件顺序 save → check）；保存失败不发检查；
 *                    仅当快照报了可更新通道时「开始更新」才可用；连点只发起一次 IPC；
 *                    检查成功且无可用更新给出明确结论（不能静默、也不能假装已开始）。
 *   AutomationView—— 新建失败保留输入且只收敛一次；空表单显式复位配置；启停连点只发一次；
 *                    删除先确认（取消不触碰 IPC）。
 *
 * 运行：node scripts/smoke-ui-management.mjs
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

const outfile = path.join(root, 'out/smoke-ui-management.cjs')
await build({
  stdin: {
    contents: [
      "import './scripts/fixtures/ui-visual-bridge'",
      "export { act, createElement } from 'react'",
      "export { createRoot } from 'react-dom/client'",
      "export { ui } from './src/renderer/src/ui/interaction-center'",
      "export { ConfirmHost } from './src/renderer/src/ui/Confirm'",
      "export { RuntimeView } from './src/renderer/src/components/RuntimeView'",
      "export { SettingsView } from './src/renderer/src/components/SettingsView'",
      "export { UpdatePanel } from './src/renderer/src/components/UpdatePanel'",
      "export { AutomationView } from './src/renderer/src/components/AutomationView'"
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

const { act, createElement, createRoot, ui, ConfirmHost, RuntimeView, SettingsView, UpdatePanel, AutomationView } = await import(pathToFileURL(outfile).href)

/* ------------------------------------------------------------------ 工具 */

const api = window.agentdeck
const restore = {}
for (const key of Object.keys(api)) restore[key] = { ...api[key] }
const snapshotApi = () => { for (const key of Object.keys(restore)) Object.assign(api[key], restore[key]) }

const host = document.getElementById('app')
const confirmHost = document.getElementById('confirm')
let reactRoot
let confirmRoot
await act(async () => {
  reactRoot = createRoot(host)
  confirmRoot = createRoot(confirmHost)
  confirmRoot.render(createElement(ConfirmHost))
})

const mount = async (Component, props = {}) => {
  await act(async () => { reactRoot.render(createElement(Component, props)) })
}
const unmount = async () => {
  await act(async () => { reactRoot.render(null) })
  snapshotApi()
}
const click = (node, label) => act(async () => {
  assert(node, `click target exists${label ? `: ${label}` : ''}`)
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
})
const clickTwice = (node, label) => act(async () => {
  assert(node, `click target exists${label ? `: ${label}` : ''}`)
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
})
const fill = (node, value) => act(async () => {
  assert(node, 'fill target exists')
  const prototype = node.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, value)
  node.dispatchEvent(new window.Event('input', { bubbles: true }))
})
const button = (text, scope = host) => [...scope.querySelectorAll('button')].find((node) => node.textContent.trim().startsWith(text))
const card = (index) => host.querySelectorAll('.settings-card')[index]
const field = (label, scope = host) => [...scope.querySelectorAll('label.field')].find((node) => node.querySelector('span')?.textContent.trim().startsWith(label))

/** 推进定时器与微任务：让 deferred promise 解析后的链路跑完 */
const settle = async (rounds = 3) => {
  await act(async () => { for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0)) })
}
/** 真实失焦（focus → blur，React 的 onBlur 由 focusout 触发），不是直接调处理器 */
const blur = (node, label) => act(async () => {
  assert(node, `blur target exists${label ? `: ${label}` : ''}`)
  node.focus()
  node.blur()
})
const pressEscape = () => act(async () => {
  const node = document.activeElement ?? document.body
  node.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
})

// toast 断言：不改交互中心实现，只记录它实际收到的调用
const toasts = []
for (const kind of ['info', 'success', 'error']) {
  const original = ui.toast[kind].bind(ui.toast)
  ui.toast[kind] = (text) => { toasts.push({ kind, text }); return original(text) }
}
const lastToast = (kind) => [...toasts].reverse().find((item) => item.kind === kind)
const toastText = () => toasts.map((item) => `${item.kind}:${item.text}`).join('\n')

const unhandled = []
const onUnhandled = (error) => unhandled.push(String(error))
process.on('unhandledRejection', onUnhandled)

const runtimeSnapshot = (health, backend, activeTaskCount = 0, checkedAt = Date.now()) => ({
  id: `${backend}-local`, label: backend, backend, kind: 'local', health, detail: `${backend} 探测结果`, activeTaskCount, checkedAt
})

try {
  /* ------------------------------------------------- 1. RuntimeView 四态 */
  console.log('[1] RuntimeView：loading / error / empty / known + 陈旧快照')
  const agents = await api.agents.list()
  assert(agents.length > 0, 'fixture 提供了 Agent 目录')

  api.runtimes.snapshot = async () => { throw new Error('probe unavailable') }
  api.agents.list = async () => { throw new Error('roster unavailable') }
  await mount(RuntimeView)
  assert(host.textContent.includes('运行时检测失败'), '首探失败显示错误态')
  assert(host.textContent.includes('probe unavailable'), '错误原因可见')
  assert.equal(host.querySelector('.runtime-kpi'), null, '没有成功快照时不得出现 0 计数')
  assert(button('检测可用性') || button('重试'), '错误态带重试入口')

  // 后端探测成功、Agent 目录仍失败：两者各自结算，未知计数显示 — 而不是 0
  const okSnapshot = [runtimeSnapshot('online', 'zcode', 0, Date.UTC(2026, 0, 2, 3, 4, 5)), runtimeSnapshot('offline', 'codex', 2)]
  api.runtimes.snapshot = async () => okSnapshot
  await click(host.querySelector('.empty-state-action button'), '错误态重试')
  const kpis = [...host.querySelectorAll('.runtime-kpi')].map((node) => node.textContent)
  assert.deepEqual(kpis, ['1', '1', '—'], `Agent 目录失败时该格显示未知（实际 ${JSON.stringify(kpis)}）`)
  assert(host.textContent.includes('Agent 目录读取失败'), 'Agent 目录失败单独提示')
  assert.equal(host.querySelectorAll('.runtime-card').length, 2, '后端卡片仍完整渲染')
  assert(host.querySelector('[data-runtime-probed-at]'), '展示上次成功检测时间')
  assert.equal(host.querySelector('[data-runtime-probed-at]').textContent.includes('（其后一次检测失败'), false, '快照新鲜时不标注陈旧')

  api.agents.list = async () => agents
  await click(button('检测可用性'), '刷新')
  assert.deepEqual([...host.querySelectorAll('.runtime-kpi')].map((node) => node.textContent), ['1', '1', String(agents.length)])
  assert.equal(host.querySelector('.probe-fail'), null, 'Agent 目录恢复后不再提示')

  // 刷新失败：保留上次成功快照，不归零
  api.runtimes.snapshot = async () => { throw new Error('probe flaked') }
  await click(button('检测可用性'), '刷新失败')
  assert(host.querySelector('[data-runtime-stale]'), '刷新失败显示陈旧横幅')
  assert.deepEqual([...host.querySelectorAll('.runtime-kpi')].map((node) => node.textContent), ['1', '1', String(agents.length)], '陈旧快照的计数不被清零')
  assert.equal(host.querySelectorAll('.runtime-card').length, 2, '陈旧快照的后端卡片保留')
  assert(host.textContent.includes('probe flaked'), '陈旧原因可见')

  // 探测成功但没有后端：空态，而不是「0 健康」
  api.runtimes.snapshot = async () => []
  await click(button('检测可用性'), '空列表')
  assert(host.textContent.includes('没有可检测的后端'), '探测成功但无后端走空态')
  assert.equal(host.querySelector('.runtime-kpi'), null, '空态不渲染 KPI')
  await unmount()
  console.log('PASS RuntimeView：首探失败/部分失败/陈旧保留/空态四态分离')

  /* ------------------------------------- 2. SettingsView：显式保存 + 检测 */
  console.log('[2] SettingsView：运行时路径显式保存，检测先保存再探测')
  const settingsEvents = []
  const realSettingsSet = api.settings.set
const realSettingsGet = api.settings.get
  api.settings.set = async (patch) => { settingsEvents.push({ kind: 'save', patch }); return realSettingsSet(patch) }
  api.settings.probe = async () => { settingsEvents.push({ kind: 'probe' }); return { ok: true, detail: 'zcode.cjs 可用', searched: [] } }
  api.runtimes.snapshot = async () => [runtimeSnapshot('online', 'zcode')]
  await mount(SettingsView, { section: 'runtime', onSection() {} })

  const pathsCard = card(0)
  const [zcode, nodePath, dsh] = pathsCard.querySelectorAll('input')
  const saveBtn = button('保存路径', pathsCard)
  const probeBtn = button('检测路径可用性', pathsCard)
  assert.equal(saveBtn.disabled, true, '干净状态下保存按钮不可点')

  await fill(zcode, 'D:\\ZCode\\zcode.cjs')
  assert(pathsCard.querySelector('[data-paths-dirty]'), '脏值提示可见')
  assert.equal(saveBtn.disabled, false, '有改动后保存按钮可用')
  assert.equal(probeBtn.disabled, false)

  await click(probeBtn, '检测（应先保存）')
  assert.deepEqual(settingsEvents.map((event) => event.kind), ['save', 'probe'], '检测必须先保存再探测')
  assert.equal(settingsEvents[0].patch.zcodePath, 'D:\\ZCode\\zcode.cjs', '保存的是当前草稿')
  assert(pathsCard.querySelector('[data-paths-probe]').textContent.includes('可用'), '探测结果可见')
  assert.equal(pathsCard.querySelector('[data-paths-dirty]'), null, '保存成功后脏值提示消失')
  assert(pathsCard.querySelector('[data-paths-saved]'), '保存成功有确认反馈')

  // 保存失败：草稿保留、错误可见、检测被拦下
  api.settings.set = async (patch) => { settingsEvents.push({ kind: 'save', patch }); throw new Error('settings store blocked') }
  await fill(zcode, 'D:\\Broken\\zcode.cjs')
  await click(saveBtn, '保存失败')
  assert(pathsCard.querySelector('[data-paths-error]').textContent.includes('settings store blocked'), '保存失败就地回显')
  assert.equal(zcode.value, 'D:\\Broken\\zcode.cjs', '失败后草稿保留')
  assert(pathsCard.querySelector('[data-paths-dirty]'), '失败后仍是脏值')
  const eventsBeforeProbe = settingsEvents.length
  await click(probeBtn, '保存失败时检测')
  assert.deepEqual(settingsEvents.slice(eventsBeforeProbe).map((event) => event.kind), ['save'], '保存失败不得继续探测')
  assert(toasts.some((item) => item.kind === 'error' && item.text.includes('运行时路径保存失败')), '失败有错误提示')

  // 连点保存：同一份草稿只写一次
  api.settings.set = async (patch) => { settingsEvents.push({ kind: 'save', patch }); return realSettingsSet(patch) }
  await fill(zcode, 'D:\\Good\\zcode.cjs')
  const before = settingsEvents.filter((event) => event.kind === 'save').length
  await clickTwice(saveBtn, '连点保存')
  assert.equal(settingsEvents.filter((event) => event.kind === 'save').length, before + 1, '连点保存只写一次')
  assert.equal(pathsCard.querySelector('[data-paths-error]'), null, '重试成功后错误消失')

  // 其它设置写入失败必须被捕获：不能出现未处理 rejection
  api.settings.set = async () => { throw new Error('settings store blocked') }
  await mount(SettingsView, { section: 'general', onSection() {} })
  await fill(host.querySelector('input[type=range]'), '3')
  assert(toasts.some((item) => item.kind === 'error' && item.text.includes('设置保存失败')), '常规分区写入失败有提示')
  await unmount()
  console.log('PASS SettingsView：脏/保存中/失败三态、检测前保存、连点去重、写入失败可见')

  /* ------------------------------------------ 3. UpdatePanel：检查/应用 */
  console.log('[3] UpdatePanel：检查先保存草稿，应用只在有可用更新时开放')
  const baseState = { phase: 'idle', channel: null, currentVersion: '0.22.0', activeRendererVersion: '0.22.0' }
  const updateEvents = []
  let checkedSnapshot = { ...baseState, available: {} }
  api.updates.getState = async () => baseState
  api.updates.check = async () => { updateEvents.push({ kind: 'check' }); return checkedSnapshot }
  api.settings.set = async (patch) => { updateEvents.push({ kind: 'save', patch }); return realSettingsSet(patch) }
  await mount(UpdatePanel)

  const feedInput = card(1).querySelector('input')
  const checkBtn = button('检查更新')
  const applyBtn = button('开始更新')
  assert(applyBtn, '存在「开始更新」按钮')
  assert.equal(applyBtn.disabled, true, '未检查前不可应用')
  const applies = []
  api.updates.applyAll = async () => { applies.push(Date.now()); return { ok: true } }
  await click(applyBtn, '未检查就点应用')
  assert.equal(applies.length, 0, '没有可用更新时点不动应用')
  assert.equal(toasts.some((item) => item.kind === 'success' && item.text.includes('已开始更新')), false, '不产生「已开始更新」假提示')

  await fill(feedInput, 'https://feed.example/new')
  assert(card(1).querySelector('[data-feed-dirty]'), 'feed 草稿是脏值')
  await click(checkBtn, '检查更新（应先保存）')
  assert.deepEqual(updateEvents.map((event) => event.kind), ['save', 'check'], '检查更新必须先落盘 feed 草稿')
  assert.equal(updateEvents[0].patch.updateFeedUrl, 'https://feed.example/new', '保存的是输入框里的地址')
  assert.equal(lastToast('info')?.text.includes('未发现可应用的更新'), true, `检查后无更新要有明确结论（实际 ${lastToast('info')?.text ?? '无'}）`)
  assert.equal(host.textContent.includes('已是最新'), false, '不声称「已是最新」：逐通道检查失败会被 updater 静默吞掉')
  assert.equal(applyBtn.disabled, true, '无可用更新时应用仍不可用')
  assert(host.querySelector('[data-update-none]'), '面板内给出「本次未发现可应用的更新」结论')

  checkedSnapshot = { ...baseState, available: { renderer: '0.23.0' } }
  await click(checkBtn, '检查更新（有新版）')
  assert(host.querySelector('[data-update-available]').textContent.includes('0.23.0'), '可更新通道可见')
  assert.equal(applyBtn.disabled, false, '有可用更新后应用开放')
  await clickTwice(applyBtn, '连点应用')
  assert.equal(applies.length, 1, '连点只发起一次更新')

  // feed 保存失败：不发检查，草稿保留
  api.settings.set = async (patch) => { updateEvents.push({ kind: 'save', patch }); throw new Error('feed store blocked') }
  await fill(feedInput, 'https://feed.example/broken')
  const checksBefore = updateEvents.filter((event) => event.kind === 'check').length
  await click(checkBtn, '保存失败时检查')
  assert.equal(updateEvents.filter((event) => event.kind === 'check').length, checksBefore, '草稿保存失败不得发起检查')
  assert(card(1).querySelector('[data-feed-error]').textContent.includes('feed store blocked'), 'feed 保存失败就地回显')
  assert.equal(feedInput.value, 'https://feed.example/broken', 'feed 草稿保留')
  await unmount()
  console.log('PASS UpdatePanel：检查前保存、应用门控、连点去重、无更新结论、失败保留草稿')

  /* ------------------------------------- 4. AutomationView：增删启停反馈 */
  console.log('[4] AutomationView：新建/启停/删除的 pending 闸门与确认')
  let automationList = [{ id: 'auto-1', name: '每日摘要', prompt: '整理最近提交', workdir: '', scheduleMinutes: 1440, enabled: false, output: 'issue', createdAt: 1, updatedAt: 1 }]
  const created = []
  const updated = []
  const removed = []
  api.automations.list = async () => automationList.map((item) => ({ ...item }))
  api.automations.update = async (id, patch) => { updated.push({ id, patch }); automationList = automationList.map((item) => (item.id === id ? { ...item, ...patch } : item)); return automationList.find((item) => item.id === id) }
  api.automations.delete = async (id) => { removed.push(id); automationList = automationList.filter((item) => item.id !== id); return { ok: true } }
  api.automations.create = async (input) => { created.push(input); const item = { ...input, id: `auto-${created.length + 1}`, createdAt: 1, updatedAt: 1 }; automationList = [...automationList, item]; return item }
  await mount(AutomationView)
  assert.equal(host.querySelectorAll('.automation-row').length, 1, '列表已加载')

  // 空表单必须显式复位：上一次的配置不能残留
  await click(button('新建自动化'), '打开新建表单')
  const dialog = () => host.querySelector('.automation-dialog')
  assert(dialog(), '表单已打开')
  await fill(field('工作目录', dialog()).querySelector('input'), 'C:\\tmp\\scratch')
  await fill(field('间隔（分钟）', dialog()).querySelector('input'), '5')
  await click(button('取消', dialog()), '取消')
  assert.equal(dialog(), null, '取消后表单关闭')
  await click(button('新建自动化'), '再次打开')
  assert.equal(field('工作目录', dialog()).querySelector('input').value, '', '空表单复位工作目录')
  assert.equal(field('间隔（分钟）', dialog()).querySelector('input').value, '60', '空表单复位间隔')
  assert.equal(field('产出', dialog()).querySelector('select').value, 'issue', '空表单复位产出')
  await click(button('取消', dialog()), '取消')

  // 模板也走同一套复位
  await click(button('使用模板'), '使用模板')
  assert.equal(field('名称', dialog()).querySelector('input').value, 'Git 站会摘要', '模板填名称')
  assert.equal(field('工作目录', dialog()).querySelector('input').value, '', '模板不继承旧工作目录')
  await click(button('取消', dialog()), '取消')

  // 新建失败：保留输入、只收敛一次、错误可见
  const failing = async (input) => { created.push(input); throw new Error('create rejected') }
  api.automations.create = failing
  await click(button('新建自动化'), '打开新建表单')
  await fill(field('名称', dialog()).querySelector('input'), '夜间回归')
  await fill(field('提示词', dialog()).querySelector('textarea'), '跑一遍冒烟并汇总')
  await clickTwice(button('创建', dialog()), '连点创建（失败）')
  assert.equal(created.length, 1, '创建失败路径的连点只发一次 IPC')
  assert(dialog(), '创建失败后表单保持打开')
  assert.equal(field('名称', dialog()).querySelector('input').value, '夜间回归', '失败保留名称输入')
  assert.equal(field('提示词', dialog()).querySelector('textarea').value, '跑一遍冒烟并汇总', '失败保留提示词输入')
  assert(dialog().querySelector('[data-automation-create-error]').textContent.includes('create rejected'), '创建失败就地回显')

  // 修好后重试：成功只关闭一次并刷新列表
  api.automations.create = async (input) => { created.push(input); const item = { ...input, id: 'auto-ok', createdAt: 1, updatedAt: 1 }; automationList = [...automationList, item]; return item }
  await click(button('创建', dialog()), '重试创建')
  assert.equal(dialog(), null, '创建成功后关闭表单')
  assert.equal(host.querySelectorAll('.automation-row').length, 2, '创建后列表已刷新')
  assert.equal(lastToast('success').text.includes('自动化已创建'), true, '创建成功有确认')

  // 启停连点：只发一次
  const toggleBtn = host.querySelector('.automation-row .toggle-control')
  await clickTwice(toggleBtn, '连点启停')
  assert.equal(updated.length, 1, '启停连点只发一次 IPC')

  // 删除：先确认，取消不触碰 IPC
  const deleteBtn = host.querySelector('.automation-row .danger-icon')
  await click(deleteBtn, '删除')
  const confirmDialog = confirmHost.querySelector('.confirm-dialog')
  assert(confirmDialog, '删除确认框已打开')
  assert(confirmDialog.textContent.includes('每日摘要'), '确认框指名要删除的对象')
  await click(button('取消', confirmDialog), '取消删除')
  assert.equal(removed.length, 0, '取消删除不发起 IPC')
  assert.equal(confirmHost.querySelector('.confirm-dialog'), null, '取消后确认框关闭')

  await click(deleteBtn, '再次删除')
  await click(confirmHost.querySelector('.confirm-dialog .btn.danger'), '确认删除')
  assert.deepEqual(removed, ['auto-1'], '确认后删除一次')
  assert.equal(host.querySelectorAll('.automation-row').length, 1, '删除后列表已刷新')
  await unmount()
  console.log('PASS AutomationView：空表单复位、失败保留草稿、创建只收敛一次、启停去重、删除需确认')

  /* ---------------- 5. UpdatePanel：失焦保存 / 检查竞态（deferred） ---------------- */
  console.log('[5] UpdatePanel：失焦保存与检查串行、精确草稿、结论失效、错误快照')
  const raceState = { ...baseState, available: {} }
  const feedWrites = []
  const checks = []
  let persistedFeed = ''
  let commitFeedSave = null
  api.settings.set = (patch) => {
    feedWrites.push(patch.updateFeedUrl)
    return new Promise((resolve) => {
      commitFeedSave = async () => {
        const next = await realSettingsSet(patch)
        persistedFeed = next.updateFeedUrl ?? ''
        resolve(next)
      }
    })
  }
  api.settings.get = async () => ({ ...await realSettingsGet(), updateFeedUrl: persistedFeed })
  api.updates.check = async () => { checks.push({ feed: persistedFeed }); return raceState }
  await mount(UpdatePanel)

  const raceCard = card(1)
  const raceInput = raceCard.querySelector('input')
  const raceCheck = button('检查更新')
  const raceApply = button('开始更新')

  await fill(raceInput, 'https://feed.example/race-a')
  await blur(raceInput, '真实失焦触发保存')
  assert.equal(feedWrites.length, 1, '失焦保存已发起（deferred，尚未落盘）')
  assert.equal(feedWrites[0], 'https://feed.example/race-a', '失焦保存的是输入框里的地址')

  // 关键复现：失焦紧接检查——两次写入必须串行，检查要等这次保存落盘
  await click(raceCheck, '失焦后立刻检查')
  assert.equal(feedWrites.length, 1, '检查前的保存并入同一次写入，不重复 IPC')
  assert.equal(checks.length, 0, '保存没落盘前不发起检查')

  // 保存期间继续编辑：新输入不能被设置广播回写清掉
  await fill(raceInput, 'https://feed.example/race-b')
  await act(async () => { commitFeedSave() })
  await Promise.resolve()
  await settle()
  assert.equal(checks.length, 1, '保存落盘后才发起检查')
  assert.equal(checks[0].feed, 'https://feed.example/race-a', '检查用的是点击那一刻提交的确切草稿')
  assert.equal(raceInput.value, 'https://feed.example/race-b', '保存期间的新输入保留')
  assert(host.querySelector('[data-update-stale]'), '显示地址与已查地址不一致时结论失效')
  assert.equal(raceApply.disabled, true, '地址改动后旧的「开始更新」失效')
  assert.equal(host.textContent.includes('已是最新'), false, '任何路径都不声称「已是最新」')

  // 显式失败快照：是错误，不是「没有可用更新」
  api.settings.set = (patch) => { feedWrites.push(patch.updateFeedUrl); return realSettingsSet(patch) }
  api.updates.check = async () => { checks.push({ feed: persistedFeed }); return { ...baseState, phase: 'failed', error: 'manifest 验签失败' } }
  await fill(raceInput, 'https://feed.example/error')
  const toastMark = toasts.length
  await click(raceCheck, '检查返回失败快照')
  assert(host.querySelector('[data-update-check-error]').textContent.includes('manifest 验签失败'), '失败快照按错误处理并说明原因')
  assert(host.querySelector('[data-update-error]'), '状态区也标注失败')
  assert.equal(host.querySelector('[data-update-none]'), null, '失败快照不得渲染成「没有更新」')
  assert.equal(lastToast('error').text.includes('检查更新失败'), true, '失败快照产生错误提示')
  assert.equal(toasts.slice(toastMark).some((item) => item.kind === 'success' && item.text.includes('已开始更新')), false, '失败检查不产生假「已开始更新」')
  await unmount()
  console.log('PASS UpdatePanel：失焦/检查串行、精确草稿、结论与操作失效、失败快照按错误处理')

  /* -------------- 6. SettingsView：保存期间编辑 / 探测归属 / 重复探测 -------------- */
  console.log('[6] SettingsView：保存期间的新输入、探测结果归属已保存路径、干净路径连点')
  const pathWrites = []
  const probes = []
  let commitPathSave = null
  api.settings.set = (patch) => {
    pathWrites.push(patch)
    return new Promise((resolve) => { commitPathSave = async () => resolve(await realSettingsSet(patch)) })
  }
  api.settings.probe = async () => { probes.push(Date.now()); return { ok: true, detail: 'zcode.cjs 可用', searched: [] } }
  api.runtimes.snapshot = async () => [runtimeSnapshot('online', 'zcode')]
  await mount(SettingsView, { section: 'runtime', onSection() {} })

  const racePathsCard = card(0)
  const raceZcode = racePathsCard.querySelectorAll('input')[0]
  const raceSave = button('保存路径', racePathsCard)
  const raceProbe = button('检测路径可用性', racePathsCard)

  await fill(raceZcode, 'D:\\Late\\zcode.cjs')
  await click(raceSave, '保存（deferred）')
  await fill(raceZcode, 'D:\\Late\\zcode-newer.cjs')
  await act(async () => { commitPathSave() })
  await Promise.resolve()
  await settle()
  assert.equal(raceZcode.value, 'D:\\Late\\zcode-newer.cjs', '保存期间的新输入不被设置广播回写清掉')
  assert(racePathsCard.querySelector('[data-paths-dirty]'), '新输入仍是待保存状态')

  // 探测结果绑定到这次真正落盘的路径
  api.settings.set = (patch) => { pathWrites.push(patch); return realSettingsSet(patch) }
  await click(raceProbe, '检测（先保存最新草稿）')
  assert.equal(pathWrites[pathWrites.length - 1].zcodePath, 'D:\\Late\\zcode-newer.cjs', '探测前保存的是当前草稿')
  assert.equal(racePathsCard.querySelector('[data-paths-probe]').getAttribute('data-paths-probe-stale'), null, '刚探测的结果对应当前已保存路径')
  await fill(raceZcode, 'D:\\Other\\zcode.cjs')
  const staleProbe = racePathsCard.querySelector('[data-paths-probe]')
  assert.notEqual(staleProbe.getAttribute('data-paths-probe-stale'), null, '输入改动后结果标注为对应旧路径')
  assert(staleProbe.textContent.includes('上次保存的路径'), '陈旧结果有文字说明')

  // 干净路径下连点检测：只发一次探测
  await click(raceSave, '保存到干净状态')
  await settle()
  assert.equal(racePathsCard.querySelector('[data-paths-dirty]'), null, '保存后回到干净状态')
  const probesBefore = probes.length
  await clickTwice(raceProbe, '干净路径连点检测')
  await settle()
  assert.equal(probes.length, probesBefore + 1, '干净路径连点只发一次探测')
  await unmount()
  console.log('PASS SettingsView：保存期间编辑保留、探测结果归属、重复探测去重')

  /* ------------- 7. AutomationView：创建在途时关闭 / 重开表单（deferred） ------------- */
  console.log('[7] AutomationView：创建在途时关闭表单并重开，迟到结果不越界')
  let lateRows = [{ id: 'late-1', name: '既有自动化', prompt: '保持列表非空', workdir: '', scheduleMinutes: 60, enabled: false, output: 'issue', createdAt: 1, updatedAt: 1 }]
  const lateCreated = []
  let commitCreate = null
  api.automations.list = async () => lateRows.map((item) => ({ ...item }))
  api.automations.create = (input) => new Promise((resolve) => {
    lateCreated.push(input)
    commitCreate = async () => {
      const item = { ...input, id: `late-${lateCreated.length + 1}`, createdAt: 1, updatedAt: 1 }
      lateRows = [...lateRows, item]
      resolve(item)
    }
  })
  await mount(AutomationView)
  const lateDialog = () => host.querySelector('.automation-dialog')
  assert.equal(host.querySelectorAll('.automation-row').length, 1, '列表已加载')

  await click(button('新建自动化'), '打开表单')
  await fill(field('名称', lateDialog()).querySelector('input'), '在途创建')
  await fill(field('提示词', lateDialog()).querySelector('textarea'), '第一次表单的草稿')
  await click(button('创建', lateDialog()), '创建（deferred）')
  assert.equal(lateCreated.length, 1, '创建已发起')
  assert(button('创建中', lateDialog()), '当前表单显示「创建中…」')

  // 在途时关闭表单（Escape 与遮罩都是真实路径），再开一张新表单并输入新草稿
  await pressEscape()

  assert.equal(lateDialog(), null, 'Escape 可关闭在途表单')
  await click(button('新建自动化'), '重新打开表单')
  await fill(field('名称', lateDialog()).querySelector('input'), '新草稿')
  await fill(field('提示词', lateDialog()).querySelector('textarea'), '不应该被迟到的成功清掉')
  assert(host.querySelector('[data-automation-create-pending]'), '提示上一次创建仍在进行中')

  await act(async () => { commitCreate() })
  await Promise.resolve()
  await settle()
  assert(lateDialog(), '迟到的创建成功不得关闭新表单')
  assert.equal(field('名称', lateDialog()).querySelector('input').value, '新草稿', '新草稿名称保留')
  assert.equal(field('提示词', lateDialog()).querySelector('textarea').value, '不应该被迟到的成功清掉', '新草稿提示词保留')
  assert.equal(host.querySelectorAll('.automation-row').length, 2, '创建确实生效：列表仍刷新')
  assert.equal(lastToast('success').text.includes('自动化已创建'), true, '成功提示照常给出')
  await click(button('取消', lateDialog()), '关闭表单')

  // 迟到的失败同样只提示，不写进换过会话的新表单
  let commitFail = null
  api.automations.create = (input) => new Promise((resolve, reject) => {
    lateCreated.push(input)
    commitFail = () => reject(new Error('late create rejected'))
  })
  await click(button('新建自动化'), '打开表单')
  await fill(field('名称', lateDialog()).querySelector('input'), '会失败的在途创建')
  await fill(field('提示词', lateDialog()).querySelector('textarea'), '失败草稿')
  await click(button('创建', lateDialog()), '创建（将迟到失败）')
  await click(lateDialog().parentElement, '点遮罩关闭在途表单')
  await click(button('新建自动化'), '再次打开表单')
  await act(async () => { commitFail() })
  await Promise.resolve()
  await settle()
  assert.equal(lateDialog().querySelector('[data-automation-create-error]') === null, true, '迟到的失败不写进新表单')
  assert.equal(lastToast('error').text.includes('late create rejected'), true, '迟到失败仍有错误提示')
  assert.equal(field('名称', lateDialog()).querySelector('input').value, '', '新表单保持空表单复位')
  await unmount()
  console.log('PASS AutomationView：在途创建时关闭/重开表单，迟到的成功与失败都不越界')
} finally {
  if (host.hasChildNodes()) await act(async () => reactRoot.render(null))
  process.off('unhandledRejection', onUnhandled)
  dom.window.close()
}

assert.deepEqual(unhandled, [], '没有任何未处理的 Promise rejection')
assert.equal(toastText().includes('undefined'), false, '提示文案里不出现 undefined')
console.log('UI MANAGEMENT SMOKE PASSED')
