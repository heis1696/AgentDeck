#!/usr/bin/env node
/**
 * scripts/smoke-ui-batch-d.mjs — 用量 + 小助理设置行为冒烟（Batch D，docs/UX-WORKFLOW-OPTIMIZATION.md）
 *
 * 只驱动真实组件（jsdom + 假桥 scripts/fixtures/ui-batch-d-bridge），不改写组件内部判定：
 *   UsageView      —— 首读失败不得渲染 0 用量；切范围期间旧快照按「它自己的范围」展示与分桶；
 *                     切范围失败保留上次成功快照并标明它的真实范围；先发后至的响应不得落地；
 *                     零运行 / 取消 / 进行中 / 部分成功都有各自诚实的文案，不承诺失败待办队列；
 *                     趋势桶的右边界取快照的 until（陈旧快照不被补成「这些天没有消耗」）。
 *   PetSettingsPage—— 读快照区分加载/失败/重试/陈旧；enabled=false 是有效已加载状态；
 *                     在途读取不得覆盖更新的广播；人设「确认后才算保存」，失败与同文本 ABA 保留草稿，
 *                     连点只提交一次；模型名是受控草稿（跟预设/外部写入走，迟到回显不吞新草稿），
 *                     保存失败保留草稿；写入失败不得变成未处理 rejection；
 *                     生成启动被拒/返回 ok:false 都释放 busy 且保留全部配置，取消失败被捕获。
 *
 * 全部模型与生成调用都走夹具桩：不联网（fetch 被拦截即失败）、不生成或替换任何位图资源。
 *
 * 运行：node scripts/smoke-ui-batch-d.mjs
 * （本文件不接入 package.json：package scripts 属共享文件，由领队集成时统一登记。）
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const root = path.resolve(import.meta.dirname, '..')
const dom = new JSDOM('<!doctype html><div id="app"></div>', { url: 'http://localhost', pretendToBeVisual: true })
const { window } = dom
for (const key of ['document', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Node', 'Element', 'Event', 'MouseEvent', 'KeyboardEvent', 'FocusEvent', 'localStorage']) globalThis[key] = window[key]
globalThis.window = window
globalThis.getComputedStyle = window.getComputedStyle.bind(window)
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window)
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window)
globalThis.IS_REACT_ACT_ENVIRONMENT = true
window.matchMedia = (media) => ({ matches: false, media, addEventListener() {}, removeEventListener() {} })
window.HTMLElement.prototype.getClientRects = function () { return [{ width: 100, height: 24 }] }

// 离线护栏：Batch D 的模型/生成调用必须全部走夹具桩，任何真实网络访问都是用例缺陷
const networkCalls = []
const refuseNetwork = (...args) => { networkCalls.push(args); throw new Error('Batch D smoke must stay offline') }
globalThis.fetch = refuseNetwork
window.fetch = refuseNetwork

const outfile = path.join(root, 'out/smoke-ui-batch-d.cjs')
await build({
  stdin: {
    contents: [
      "import './scripts/fixtures/ui-batch-d-bridge'",
      "export { act, createElement } from 'react'",
      "export { createRoot } from 'react-dom/client'",
      "export { ui } from './src/renderer/src/ui/interaction-center'",
      "export { UsageView } from './src/renderer/src/components/UsageView'",
      "export { PetSettingsPage } from './src/renderer/src/pet/PetSettingsPage'",
      "export { getBatchDBridge, usageSummary } from './scripts/fixtures/ui-batch-d-bridge'"
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

const { act, createElement, createRoot, ui, UsageView, PetSettingsPage, getBatchDBridge, usageSummary } = await import(pathToFileURL(outfile).href)

/* ------------------------------------------------------------------ 工具 */

const api = window.agentdeck
const bridge = getBatchDBridge()
const defaults = { pet: { ...api.pet }, analytics: { ...api.analytics } }
const resetApi = () => { Object.assign(api.pet, defaults.pet); Object.assign(api.analytics, defaults.analytics) }

const host = document.getElementById('app')
let reactRoot
const mount = async (Component) => {
  await act(async () => {
    reactRoot = createRoot(host)
    reactRoot.render(createElement(Component))
  })
}
const unmount = async () => {
  await act(async () => { reactRoot.render(null); reactRoot.unmount() })
  resetApi()
}
const click = (node, label) => act(async () => {
  assert.ok(Boolean(node), `click target exists${label ? `: ${label}` : ''}`)
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
})
const clickTwice = (node, label) => act(async () => {
  assert.ok(Boolean(node), `click target exists${label ? `: ${label}` : ''}`)
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
})
const fill = (node, value) => act(async () => {
  assert.ok(Boolean(node), 'fill target exists')
  const prototype = node.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, value)
  node.dispatchEvent(new window.Event('input', { bubbles: true }))
})
const blur = (node, label) => act(async () => {
  assert.ok(Boolean(node), `blur target exists${label ? `: ${label}` : ''}`)
  node.focus()
  node.blur()
})
const settle = async (rounds = 3) => {
  await act(async () => { for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0)) })
}
const button = (text, scope = host) => [...scope.querySelectorAll('button')].find((node) => node.textContent.trim().startsWith(text))
const cardByTitle = (title) => [...host.querySelectorAll('.settings-card')].find((node) => node.querySelector('h3')?.textContent.trim() === title)
const field = (label, scope = host) => [...scope.querySelectorAll('label.field')].find((node) => node.querySelector('span')?.textContent.trim().startsWith(label))
const figures = () => [...host.querySelectorAll('.us-stat-figure')].map((node) => node.textContent)
const usageScope = () => host.querySelector('.us-foot')?.getAttribute('data-usage-scope')
const usageTab = (label) => [...host.querySelectorAll('.us-seg button')].find((node) => node.textContent.trim() === label)

// toast 断言：不改交互中心实现，只记录它实际收到的调用（ui/toast 转发到中心，PetSettingsPage 走同一处）
const toasts = []
for (const kind of ['info', 'success', 'error']) {
  const original = ui.toast[kind].bind(ui.toast)
  ui.toast[kind] = (text) => { toasts.push({ kind, text }); return original(text) }
}
const lastToast = (kind) => [...toasts].reverse().find((item) => item.kind === kind)
const errorToasts = () => toasts.filter((item) => item.kind === 'error')
const toastText = () => toasts.map((item) => `${item.kind}:${item.text}`).join('\n')

const unhandled = []
const onUnhandled = (error) => unhandled.push(String(error))
process.on('unhandledRejection', onUnhandled)

const now = Date.now()
const sevenDay = usageSummary({ runs: 12, completed: 11, failed: 1, days: 7, until: now, costUsd: 2.5 })
const thirtyDay = usageSummary({ runs: 42, completed: 42, days: 30, until: now })
const allTime = usageSummary({ runs: 99, completed: 99, days: 90, until: now })

try {
  /* ---------------------------------------- 1. UsageView：读数四态与诚实计数 */
  console.log('[1] UsageView：首读失败 / 重试 / 零运行 / 取消与进行中的文案')
  resetApi()
  bridge.setDefaultSummary(sevenDay)
  bridge.scriptSummary({ error: 'usage store unavailable' })
  await mount(UsageView)
  assert(host.textContent.includes('统计加载失败'), '首读失败进入错误态')
  assert(host.textContent.includes('usage store unavailable'), '失败原因可见')
  assert.ok(!host.querySelector('.us-stat-figure'), '没有成功快照时不得渲染 0 用量')
  assert.ok(Boolean(button('重试')), '错误态给出重试入口')

  bridge.scriptSummary({ summary: sevenDay })
  await click(button('重试'), '首读重试')
  assert.equal(figures()[2], '12', '重试成功后渲染真实计数')
  assert.equal(host.querySelector('.us-ring').className.includes('is-bad'), true, '有失败时为 bad 环')

  // 零运行：不冒充「运行全部成功」，失败率不适用
  bridge.setDefaultSummary(usageSummary({ runs: 0, completed: 0, days: 0, until: now }))
  await click(button('刷新'), '零运行快照')
  assert(host.textContent.includes('「近 7 天」没有用量记录'), '零用量给范围明确的空态横幅')
  assert(host.textContent.includes('该时段没有运行'))
  assert(host.textContent.includes('没有运行，失败率不适用'), '零运行不得说「运行全部成功」')
  assert.ok(Boolean(host.querySelector('.us-ring.is-idle')), '零运行圆环保持中性')
  assert.ok(!host.querySelector('.us-ring.is-ok'), '零运行不显示成功环')
  assert.equal(host.textContent.includes('运行全部成功'), false)
  assert.ok(Boolean(host.querySelector('.us-trend-empty')), '零消耗走趋势空态而不是空图')
  assert(host.textContent.includes('没有运行记录'), '失败构成面板说明没有运行记录')

  // 取消 + 进行中：不得用「成功/失败」二值掩盖
  bridge.setDefaultSummary(usageSummary({ runs: 5, completed: 2, cancelled: 2, days: 5, until: now }))
  await click(button('刷新'), '取消与进行中')
  assert(host.textContent.includes('取消 2'), '取消数可见')
  assert(host.textContent.includes('进行中 1'), '未结算的运行单独计数')
  assert(host.textContent.includes('暂无失败 · 1 次进行中'), '失败率旁给出进行中说明')
  assert.equal(host.textContent.includes('运行全部成功'), false, '有在途运行时不得宣称全部成功')

  // 有失败：只报事实，不承诺「待办队列」
  bridge.setDefaultSummary(usageSummary({
    runs: 4, completed: 2, failed: 2, days: 4, until: now,
    errors: [{ code: 'timeout', title: '执行超时', count: 2, retryable: true }]
  }))
  await click(button('刷新'), '失败构成')
  assert(host.textContent.includes('2 次失败'), '失败数可见')
  assert.equal(host.textContent.includes('待处理'), false, '移除失败待办队列的承诺')
  assert(host.textContent.includes('1 类错误'), '错误分类计数可见')
  await unmount()
  console.log('PASS UsageView：加载/失败/零运行/取消/进行中文案与错误构成')

  /* ------------------------------------ 2. UsageView：范围口径与请求乱序 */
  console.log('[2] UsageView：切范围不重贴标签、失败保留真实范围、最新请求胜出')
  resetApi()
  bridge.setDefaultSummary(sevenDay)
  await mount(UsageView)
  assert.equal(figures()[2], '12')
  assert.equal(host.querySelectorAll('.us-chart-col').length, 7, '近 7 天 = 7 个日桶')
  assert.equal(usageScope(), '7d')
  assert.ok(!host.querySelector('[data-usage-scope-switch]'), '范围一致时没有切换提示')

  // 切到近 30 天：读取挂起期间，页面仍是 7 天快照，且必须明说
  let pending = []
  api.analytics.summary = () => new Promise((resolve, reject) => pending.push({ resolve, reject }))
  await click(usageTab('近 30 天'), '切到 30 天')
  assert.equal(pending.length, 1, '切范围发起一次读取')
  assert.equal(usageTab('近 30 天').className.includes('active'), true, '选中态切到新范围')
  assert.equal(usageScope(), '7d', '旧快照仍按它自己的范围展示')
  assert.equal(figures()[2], '12', '旧快照的计数不被新范围改写')
  assert.equal(host.querySelectorAll('.us-chart-col').length, 7, '旧快照不被新范围重新分桶')
  const switching = host.querySelector('[data-usage-scope-switch]')
  assert.ok(Boolean(switching), '挂起期间给出范围切换提示')
  assert(switching.textContent.includes('近 30 天') && switching.textContent.includes('近 7 天'), '提示同时点名目标范围与当前快照范围')

  // 30 天读取失败：保留 7 天快照并标明真实范围，可重试
  await act(async () => pending[0].reject(new Error('30d unavailable')))
  await settle()
  const stale = host.querySelector('[data-usage-stale]')
  assert.ok(Boolean(stale), '切范围失败给出陈旧横幅')
  assert(stale.textContent.includes('近 30 天') && stale.textContent.includes('近 7 天'), '陈旧横幅点名失败范围与快照范围')
  assert.equal(usageScope(), '7d')
  assert.equal(figures()[2], '12', '陈旧快照的计数保留')
  assert.equal(host.querySelectorAll('.us-chart-col').length, 7, '陈旧快照的分桶保留')

  api.analytics.summary = async () => thirtyDay
  await click(host.querySelector('[data-usage-stale] button'), '重试 30 天')
  assert.equal(usageScope(), '30d', '成功后范围口径切到 30 天')
  assert.equal(figures()[2], '42')
  assert.equal(host.querySelectorAll('.us-chart-col').length, 30, '30 天 = 30 个日桶')
  assert.ok(!host.querySelector('[data-usage-stale]'), '成功后陈旧横幅消失')

  // 两个在途请求乱序返回：只有最新一次落地，范围随之锁定
  pending = []
  api.analytics.summary = () => new Promise((resolve, reject) => pending.push({ resolve, reject }))
  await click(usageTab('全部'), '切到全部')
  await click(usageTab('近 7 天'), '再切回 7 天')
  assert.equal(pending.length, 2, '两次切范围各发一次读取')
  await act(async () => pending[1].resolve(sevenDay))
  await act(async () => pending[0].resolve(allTime))
  await settle()
  assert.equal(figures()[2], '12', '先发后至的旧响应不得覆盖新结果')
  assert.equal(usageScope(), '7d', '范围跟随最新一次请求')
  assert.equal(host.querySelectorAll('.us-chart-col').length, 7)
  await unmount()
  console.log('PASS UsageView：范围与快照绑定、失败保留真实范围、乱序响应不落地')

  /* --------------------------------- 3. PetSettingsPage：读状态与广播优先级 */
  console.log('[3] PetSettingsPage：加载/失败/重试/陈旧、未启用是有效已加载状态')
  resetApi()
  bridge.commit({ enabled: true, packId: 'default', personaPrompt: '原始人设', model: 'claude-3-5-haiku-latest', presetId: 'preset-a', activePresetId: 'preset-a' })
  const readState = () => host.querySelector('[data-pet-read]')?.getAttribute('data-pet-read')
  let rejectRead = null
  api.pet.getState = () => new Promise((_resolve, reject) => { rejectRead = reject })
  await mount(PetSettingsPage)
  assert.equal(readState(), 'loading', '首读挂起 = 加载态')
  assert(host.textContent.includes('正在读取小助理状态'), '加载文案可见')
  assert.equal(host.querySelectorAll('.settings-card').length, 1, '没有快照时不渲染设置卡片')

  await act(async () => rejectRead(new Error('pet store unavailable')))
  await settle()
  assert.equal(readState(), 'error', '首读失败 = 错误态（不是「未启用」）')
  assert(host.textContent.includes('pet store unavailable'), '失败原因可见')
  api.pet.getState = defaults.pet.getState
  await click(button('重试'), '读失败重试')
  assert.ok(!host.querySelector('[data-pet-read]'), '重试成功后读状态卡片消失')
  assert.equal(host.querySelectorAll('.settings-card').length, 5, '五张设置卡片渲染')

  // 在途读取 vs 广播：广播是权威，迟到的读取不得把状态打回旧值
  const beforeBroadcast = bridge.snapshot()
  let resolveStaleRead = null
  api.pet.getState = () => new Promise((resolve) => { resolveStaleRead = resolve })
  await click(host.querySelector('input[type=checkbox]'), '切换启用（写成功后刷新）')
  assert.ok(Boolean(resolveStaleRead), '写入成功后发起一次刷新读取')
  await act(async () => { bridge.commit({ personaPrompt: '广播后的新文案' }) })
  assert.equal(cardByTitle('人设').querySelector('textarea').value, '广播后的新文案', '广播立即生效')
  await act(async () => resolveStaleRead(beforeBroadcast))
  await settle()
  assert.equal(cardByTitle('人设').querySelector('textarea').value, '广播后的新文案', '在途读取不得覆盖更新的广播')

  // 刷新失败：保留上次成功快照 + 陈旧横幅 + 重试
  api.pet.getState = async () => { throw new Error('pet refresh broken') }
  await click(host.querySelector('input[type=checkbox]'), '刷新失败的写入')
  await settle()
  assert(host.querySelector('[data-pet-stale]').textContent.includes('pet refresh broken'), '刷新失败给出陈旧横幅')
  assert.equal(host.querySelectorAll('.settings-card').length, 5, '陈旧时设置卡片保留')
  api.pet.getState = defaults.pet.getState
  await click(host.querySelector('[data-pet-stale] button'), '陈旧重试')
  assert.ok(!host.querySelector('[data-pet-stale]'), '重试成功后陈旧横幅消失')

  // enabled=false 是有效已加载状态：卡片照常渲染并说明当前未启用
  await act(async () => { bridge.commit({ enabled: false }) })
  assert.equal(readState(), undefined, '未启用不是读失败')
  assert.equal(host.querySelectorAll('.settings-card').length, 5)
  assert.ok(Boolean(host.querySelector('[data-pet-disabled]')), '未启用有明确说明')
  assert.equal(host.querySelector('input[type=checkbox]').checked, false)
  await act(async () => { bridge.commit({ enabled: true }) })
  await unmount()
  console.log('PASS PetSettingsPage：加载/失败/重试/陈旧分离，未启用是有效状态，广播压过在途读取')

  /* --------------------------------------- 4. PetSettingsPage：人设保存 */
  console.log('[4] PetSettingsPage：人设确认后才算保存、失败与同文本 ABA 保留草稿、连点一次')
  resetApi()
  bridge.commit({ personaPrompt: '原始人设' })
  await mount(PetSettingsPage)
  const personaCard = () => cardByTitle('人设')
  const personaText = () => personaCard().querySelector('textarea')
  const savePersona = () => button('保存人设', personaCard())
  const personas = []
  const realSetPersona = defaults.pet.setPersona
  assert.equal(personaText().value, '原始人设')
  assert.equal(savePersona().disabled, true, '干净状态不可保存')

  let finishPersona = null
  api.pet.setPersona = (text) => { personas.push(text); return new Promise((resolve) => { finishPersona = () => resolve(realSetPersona(text)) }) }
  await fill(personaText(), '人设草稿 A')
  assert.equal(savePersona().disabled, false, '有草稿后可保存')
  assert.ok(Boolean(personaCard().querySelector('[data-persona-dirty]')), '脏草稿有提示')
  await clickTwice(savePersona(), '连点保存人设')
  assert.equal(personas.length, 1, '连点只提交一次')
  assert.ok(Boolean(button('保存中…', personaCard())), '确认前显示保存中')
  assert.equal(toasts.filter((item) => item.kind === 'success' && item.text.includes('人设已保存')).length, 0, '确认前不得报成功')
  assert.equal(personaText().value, '人设草稿 A', '确认前草稿保持可见')
  await act(async () => finishPersona())
  await settle()
  assert.equal(personas[0], '人设草稿 A', '提交的是当前草稿')
  assert(lastToast('success').text.includes('人设已保存'), '确认后才报成功')
  assert.equal(savePersona().disabled, true, '确认后收起草稿')
  assert.equal(personaText().value, '人设草稿 A', '确认后文本域显示已保存的值')
  assert.equal(bridge.snapshot().personaPrompt, '人设草稿 A')

  // 失败：保留草稿 + 就地报错 + 错误提示
  api.pet.setPersona = async (text) => { personas.push(text); throw new Error('persona write blocked') }
  await fill(personaText(), '保存会失败的人设')
  await click(savePersona(), '保存失败')
  await settle()
  assert(personaCard().querySelector('[data-persona-error]').textContent.includes('persona write blocked'), '失败原因就地可见')
  assert.equal(personaText().value, '保存会失败的人设', '失败保留草稿')
  assert.equal(savePersona().disabled, false, '失败后可重试')
  assert(lastToast('error').text.includes('人设保存失败'), '失败有错误提示')
  assert.equal(bridge.snapshot().personaPrompt, '人设草稿 A', '失败不落盘')

  // 同文本 ABA：保存期间改成别的又改回来，仍算更新的一份草稿
  let finishAba = null
  api.pet.setPersona = (text) => { personas.push(text); return new Promise((resolve) => { finishAba = () => resolve(realSetPersona(text)) }) }
  await fill(personaText(), 'A')
  await click(savePersona(), '提交 A')
  await fill(personaText(), 'B')
  await fill(personaText(), 'A')
  await act(async () => finishAba())
  await settle()
  assert.equal(personaText().value, 'A')
  assert.equal(savePersona().disabled, false, '同文本 ABA：更新的草稿不被迟到的成功收起')
  assert.ok(Boolean(personaCard().querySelector('[data-persona-dirty]')), '仍标记未保存')
  await click(savePersona(), '再保存一次')
  await act(async () => finishAba())
  await settle()
  assert.equal(savePersona().disabled, true, '再次确认后收口')

  // 放弃修改回到已保存文本，且被放弃的草稿从不写入
  await fill(personaText(), '不要的草稿')
  await click(button('放弃修改', personaCard()), '放弃修改')
  assert.equal(personaText().value, bridge.snapshot().personaPrompt)
  assert.equal(savePersona().disabled, true)
  assert.equal(personas.includes('不要的草稿'), false, '放弃的草稿不写盘')
  await unmount()
  console.log('PASS 人设：确认前不改本地、失败与 ABA 保草稿、连点去重、放弃可回退')

  /* --------------------------------------- 5. PetSettingsPage：模型草稿 */
  console.log('[5] PetSettingsPage：模型名受控草稿跟随外部写入、失败保留、迟到回显不吞新草稿')
  resetApi()
  bridge.commit({ presetId: 'preset-a', activePresetId: 'preset-a', model: 'claude-3-5-haiku-latest', personaPrompt: '模型用例基线' })
  await mount(PetSettingsPage)
  const modelCard = () => cardByTitle('模型')
  const modelInput = () => modelCard().querySelector('input[type=text]')
  assert.equal(modelInput().value, 'claude-3-5-haiku-latest')

  // 预设/外部写入带来的模型名必须反映到输入框（受控，不是一次性 defaultValue）
  await act(async () => { bridge.commit({ presetId: 'preset-b', activePresetId: 'preset-b', model: 'deepseek-chat' }) })
  assert.equal(modelInput().value, 'deepseek-chat', '模型名跟随广播/预设')

  // 保存失败：保留草稿 + 就地报错 + 不落盘
  api.pet.setPreset = async () => { throw new Error('preset write blocked') }
  await fill(modelInput(), 'my-custom-model')
  await blur(modelInput(), '失败保存')
  await settle()
  assert.equal(modelInput().value, 'my-custom-model', '失败保留草稿')
  assert(modelCard().querySelector('[data-pet-model-error]').textContent.includes('preset write blocked'), '失败原因就地可见')
  assert.equal(bridge.snapshot().model, 'deepseek-chat', '失败不落盘')
  assert(lastToast('error').text.includes('模型名保存失败'), '失败有错误提示')

  // 迟到的成功回显不得吞掉保存期间输入的新草稿
  let finishModel = null
  const realSetPreset = defaults.pet.setPreset
  api.pet.setPreset = (presetId, model) => new Promise((resolve) => { finishModel = () => resolve(realSetPreset(presetId, model)) })
  await fill(modelInput(), 'first-model')
  await blur(modelInput(), '在途保存')
  assert.ok(Boolean(finishModel), '失焦发起保存')
  assert.ok(Boolean(modelCard().querySelector('[data-pet-model-pending]')), '保存中可见')
  await fill(modelInput(), 'second-model')
  await act(async () => finishModel())
  await settle()
  assert.equal(modelInput().value, 'second-model', '保存期间的新草稿保留')

  // 预设切换带上输入框里看得见的值，而不是被取代的旧 state.model
  api.pet.setPreset = realSetPreset
  await click(modelCard().querySelector('.menu-trigger'), '打开预设菜单')
  await click([...host.querySelectorAll('.menu-item')].find((node) => node.textContent.includes('预设甲')), '选择预设甲')
  await settle()
  assert.equal(bridge.calls.setPreset.at(-1).presetId, 'preset-a')
  assert.equal(bridge.calls.setPreset.at(-1).model, 'second-model', '预设切换携带当前可见的模型名')

  // 自主发言间隔：写入失败可见且不产生未处理 rejection
  api.pet.setAutonomy = async () => { throw new Error('autonomy write blocked') }
  await fill(cardByTitle('人设').querySelector('input[type=range]'), '120')
  await settle()
  assert(cardByTitle('人设').querySelector('[data-pet-autonomy-error]').textContent.includes('autonomy write blocked'), '间隔写入失败可见')
  assert(lastToast('error').text.includes('自主发言间隔保存失败'), '间隔写入失败有提示')
  // 滑杆按本地区间设置模式：连续变更都提交（末次生效），不因在途而丢改动
  api.pet.setAutonomy = defaults.pet.setAutonomy
  const autonomyBefore = bridge.calls.setAutonomy.length
  await fill(cardByTitle('人设').querySelector('input[type=range]'), '140')
  await fill(cardByTitle('人设').querySelector('input[type=range]'), '180')
  await settle()
  assert.equal(bridge.calls.setAutonomy.length, autonomyBefore + 2, '连续变更都提交（不丢改动）')
  assert.equal(bridge.calls.setAutonomy.at(-1), 180, '末次生效')
  assert.ok(!cardByTitle('人设').querySelector('[data-pet-autonomy-error]'), '写入恢复后错误提示消失')
  await unmount()
  console.log('PASS 模型：受控草稿跟随外部写入、失败保留、迟到回显不吞新草稿、写入失败可见')

  /* ------------------------------------ 6. PetSettingsPage：生成启动与取消 */
  console.log('[6] PetSettingsPage：生成启动被拒释放 busy 并保留配置、连点一次、取消失败被捕获')
  resetApi()
  await mount(PetSettingsPage)
  const genCard = () => cardByTitle('生成素材包')
  const packField = () => field('包 id', genCard()).querySelector('input')
  const descField = () => field('角色描述', genCard()).querySelector('textarea')
  const idleFrames = () => field('待机', genCard()).querySelector('input')
  const genButton = () => button('开始生成', genCard())
  assert.ok(Boolean(genButton()), '有预设与帧数时可开始生成')
  const beforeConfig = { packId: packField().value, description: descField().value, idle: idleFrames().value }

  let rejectGen = null
  api.pet.genStart = (input) => { bridge.calls.genStart.push(input); return new Promise((_resolve, reject) => { rejectGen = reject }) }
  await click(genButton(), '开始生成（将被拒）')
  assert.ok(Boolean(button('生成中…', genCard())), '提交后进入生成中')
  assert.ok(Boolean(genCard().querySelector('.pet-gen-bar')), '进度条可见')
  assert.equal(bridge.calls.genStart.at(-1).packId, beforeConfig.packId, '提交的是当前配置')
  await act(async () => rejectGen(new Error('images channel rejected')))
  await settle()
  assert.ok(Boolean(genButton()), '启动被拒后释放 busy')
  assert.equal(genCard().querySelector('.pet-gen-bar'), null, '失败后进度条收起')
  assert(genCard().querySelector('[data-gen-result]').textContent.includes('images channel rejected'), '失败原因可见')
  assert(lastToast('error').text.includes('无法启动生成'), '启动失败有错误提示')
  assert.equal(packField().value, beforeConfig.packId, '启动失败保留包 id')
  assert.equal(descField().value, beforeConfig.description, '启动失败保留角色描述')
  assert.equal(idleFrames().value, beforeConfig.idle, '启动失败保留帧数表')

  // 主进程返回 ok:false：同样释放 busy 并说明原因
  api.pet.genStart = async (input) => { bridge.calls.genStart.push(input); return { ok: false, error: '缺少 apiKey' } }
  await click(genButton(), '开始生成（ok:false）')
  await settle()
  assert(genCard().querySelector('[data-gen-result]').textContent.includes('缺少 apiKey'), 'ok:false 的原因可见')
  assert.ok(Boolean(genButton()), 'ok:false 也释放 busy')

  // 连点只提交一次
  api.pet.genStart = (input) => { bridge.calls.genStart.push(input); return new Promise(() => {}) }
  const genCallsBefore = bridge.calls.genStart.length
  await clickTwice(genButton(), '连点开始生成')
  assert.equal(bridge.calls.genStart.length, genCallsBefore + 1, '连点只提交一次生成')
  // 收尾：主进程事件释放 busy
  await act(async () => { bridge.emitGenError({ packId: 'my-pet', reason: '用例收尾' }) })
  assert.ok(Boolean(genButton()), '失败事件释放 busy')

  // 取消失败被捕获，不产生未处理 rejection
  api.pet.genStart = (input) => { bridge.calls.genStart.push(input); return new Promise(() => {}) }
  await click(genButton(), '开始生成（准备取消）')
  api.pet.genCancel = async () => { throw new Error('cancel rpc failed') }
  await click(button('取消', genCard()), '取消失败')
  await settle()
  assert(genCard().querySelector('[data-gen-result]').textContent.includes('取消失败'), '取消失败就地可见')
  assert(lastToast('error').text.includes('取消生成失败'), '取消失败有错误提示')
  api.pet.genCancel = async () => { bridge.calls.genCancel++; return { ok: true } }
  await click(button('取消', genCard()), '取消成功')
  await settle()
  assert(genCard().querySelector('[data-gen-result]').textContent.includes('当前帧完成后停下'), '取消给出真实语义')
  await act(async () => { bridge.emitGenDone({ packId: 'my-pet', frameCount: 16, warnings: [], elapsedMs: 1_000 }) })
  assert.ok(Boolean(genButton()), '完成事件释放 busy')
  assert(genCard().querySelector('[data-gen-result]').textContent.includes('已生成 16 帧'), '完成结果可见')
  await unmount()
  console.log('PASS 生成：启动被拒/ok:false 释放 busy 且保留配置、连点一次、取消失败与成功都有明确结果')
} finally {
  if (host.hasChildNodes()) await act(async () => reactRoot.render(null))
  process.off('unhandledRejection', onUnhandled)
  dom.window.close()
}

assert.deepEqual(networkCalls, [], '用例不得触发任何真实网络调用')
assert.deepEqual(unhandled, [], '没有任何未处理的 Promise rejection')
assert.equal(toastText().includes('undefined'), false, '提示文案里不出现 undefined')
console.log('UI BATCH D SMOKE PASSED')
