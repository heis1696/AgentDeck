// UI 焦点回归（真实 React DOM + jsdom）：不再只测 trapTargetIndex 这类纯函数。
//
// 覆盖线上真实结构（scripts/fixtures/ui-focus-harness.tsx 里的场景逐个挂载）：
//   1. Agent 页「新建 Agent」模态：输入框 autoFocus，Escape 关闭后焦点必须回到触发按钮（不是 body）；
//   2. 同一场景在 StrictMode 下同样成立（开发态双渲染/双执行 effect）；
//   3. 嵌套模态：Escape 只关最上层，逐层归还焦点；
//   4. 模态内下拉菜单（autoFocus:false 的 popover）：Escape 只关菜单，焦点留在菜单触发器；
//   5. 卸载：浮层宿主卸载 → 焦点归还；触发元素与浮层一起卸载 → 不抢焦点、不报错；
//   6. 真实确认框宿主 FIFO 接棒：焦点跟着接棒的确认按钮走，最后一问关闭后回触发按钮；
//   7. 真实命令面板（trap + initialFocusRef）；
//   8. 真实 SideDock 页签条：←/→ 切换后焦点必须落在新激活页签上；
//   9. 层栈一致性（本轮修复）：浮窗 z=38 / 信息弹层 z=40 与模态 overlay 同屏时，
//      视觉 z 跟随层序，模态开着时指针与焦点都到不了它下面，模态自身与「浮在模态之上」的嵌套菜单照常可用；
//  10. 真实 IME 组合（compositionstart/update/end + isComposing / keyCode 229）：
//      Palette、Menu、TaskDetail 的重命名与追问框/技能菜单都不在组合中抢 Enter/Escape/↑↓。
//  11. 审查项 1~6：跨任务校正不可用页签（+ 焦点接回）、流式自动滚动受「贴底跟随」控制、
//      顶部页签关闭后焦点跟随实际 activeId、CodeViewer 在 diff 中按新旧文件绝对行号跳转、
//      追问框 combobox ↔ listbox 的 aria 关系与选项 Tab 序列、显式平滑滚动尊重 prefers-reduced-motion。
//  12. 真实 TaskDetail 视图页签（含「动态 / 结果」两个次级页签）：←/→ 环绕、Home/End 跳首末、
//      Ctrl+1..4 直达；激活项 / 面板指向 / roving tabindex / 焦点四者同源，IME 组合中方向键归输入法。
//
// 依赖：npm install 安装的开发依赖 jsdom。运行：npm run smoke:ui。
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')

/* ------------------------------------------------------------- jsdom 环境 */

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
const { window } = dom

// React DOM 在模块初始化时探测 window/document，必须先铺全局再 import 产物
globalThis.window = window
globalThis.document = window.document
globalThis.HTMLElement = window.HTMLElement
globalThis.HTMLInputElement = window.HTMLInputElement
globalThis.HTMLTextAreaElement = window.HTMLTextAreaElement
globalThis.HTMLButtonElement = window.HTMLButtonElement
globalThis.Node = window.Node
globalThis.Element = window.Element
globalThis.Event = window.Event
globalThis.MouseEvent = window.MouseEvent
globalThis.KeyboardEvent = window.KeyboardEvent
globalThis.FocusEvent = window.FocusEvent
globalThis.getComputedStyle = window.getComputedStyle.bind(window)
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window)
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window)
globalThis.localStorage = window.localStorage
try { Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true }) } catch { /* Node 自带 navigator 只读时忽略 */ }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// jsdom 没有排版：getClientRects 恒为空会让「层内第一个可聚焦元素」判定为不可见。
// 打桩成「有一个矩形」，等价于浏览器里的可见元素（生产代码的可见性判据本身不改）。
window.Element.prototype.getClientRects = function () { return [{ x: 0, y: 0, width: 120, height: 20, top: 0, left: 0, right: 120, bottom: 20 }] }
// jsdom 也没实现 scrollIntoView（真实菜单高亮滚动用）：桩成空操作，生产代码不改
window.Element.prototype.scrollIntoView = function () {}
// jsdom 没有 ResizeObserver（回合索引用它量轨道高度）：桩成空观察者，生产代码不改
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
window.ResizeObserver = ResizeObserverStub
globalThis.ResizeObserver = ResizeObserverStub
/**
 * jsdom 没有 Element.scrollTo：桩成「记录 + 落到 scrollTop」，用于断言显式滚动用的 behavior
 * （审查项 6：prefers-reduced-motion: reduce 时必须从 'smooth' 降级为 'auto'）。
 */
const scrollCalls = []
const lastScroll = () => scrollCalls[scrollCalls.length - 1]
window.Element.prototype.scrollTo = function (options) {
  scrollCalls.push({ target: this, top: options?.top, behavior: options?.behavior })
  if (typeof options?.top === 'number') this.scrollTop = options.top
}
/**
 * matchMedia 桩（jsdom 未实现）：App/主题代码与 motion.ts 都读它。
 * 只有 prefers-reduced-motion 查询受 reducedMotion 开关影响，其余恒 false。
 */
let reducedMotion = false
window.matchMedia = (query) => ({
  matches: query.includes('prefers-reduced-motion') ? reducedMotion : false,
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => false
})

/* ------------------------------------------------- 渲染层 bridge 桩（真实 TaskDetail） */

/**
 * api.ts 在**模块初始化**时读 window.agentdeck，所以必须在 import 产物之前铺好。
 * 未知路径按名字给形状：on* → 退订函数（浮层不看返回值）、*.list/events/comments/runs/checkpoints → 空数组、
 * *.followUp/rename/... → { ok: true }、其余 → null；同时记录调用供断言（重命名/追问是否真的发出去）。
 */
function installBridgeStub() {
  const calls = []
  const resolveValue = (callPath) => {
    if (callPath === 'skills.list') return { skills: [] }
    if (/\.(list|events|comments|runs|checkpoints|pendingPermissions)$/.test(callPath)) return []
    if (/\.(followUp|rename|start|cancel|retry|delete|rewind|create|update)$/.test(callPath)) return { ok: true }
    return null
  }
  const make = (callPath) => new Proxy(function () {}, {
    get: (_target, prop) => (prop === 'then' ? undefined : make(callPath ? `${callPath}.${String(prop)}` : String(prop))),
    apply: (_target, _this, args) => {
      calls.push({ path: callPath, args })
      if (/\.on[A-Z]/.test(callPath)) return () => {}
      return Promise.resolve(resolveValue(callPath))
    }
  })
  window.agentdeck = make('')
  return { calls, count: (suffix) => calls.filter((call) => call.path.endsWith(suffix)).length }
}
const bridgeCalls = installBridgeStub()

/* ----------------------------------------------------------------- 打包夹具 */

const outfile = path.join(root, 'out', 'smoke-ui-focus.cjs')
const shikiStub = path.join(root, 'scripts', 'fixtures', 'shiki-stub.ts')
await build({
  entryPoints: [path.join(root, 'scripts', 'fixtures', 'ui-focus-harness.tsx')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
  plugins: [{ name: 'stub-shiki', setup(build) { build.onResolve({ filter: /^shiki(\/|$)/ }, () => ({ path: shikiStub })) } }]
})

const {
  act, createElement, StrictMode, createRoot,
  NewAgentScenario, NestedModalScenario, MenuInModalScenario, UnmountScenario, ConfirmScenario, PaletteScenario, InlineEditScenario, SideDockScenario,
  OverlapStackScenario, TaskDetailScenario, TaskDetail, TabBarScenario, makeTask, CodeViewer, parseUnifiedDiff, findDiffRowIndex,
  prefersReducedMotion, scrollBehavior,
  stackHits, resetStackHits, paletteRuns, interactionLayers,
  ui, resetOutsideFocusHistory
} = await import(pathToFileURL(outfile).href)

/* ------------------------------------------------------------------ 断言器 */

let failures = 0
const ok = (condition, label) => {
  console.log(`  ${condition ? '✓' : '✗'} ${label}`)
  if (!condition) { failures++; process.exitCode = 1 }
}
const section = (title) => console.log(`\n── ${title}`)

const container = window.document.getElementById('app')
const active = () => window.document.activeElement
const nameOf = (node) => !node ? 'null' : (node.getAttribute?.('data-testid') || node.id || node.tagName?.toLowerCase() || String(node))
const byTestId = (id) => container.querySelector(`[data-testid="${id}"]`)

let reactRoot = null
async function render(element) {
  await act(async () => { reactRoot = createRoot(container); reactRoot.render(element) })
}
async function rerender(element) { await act(async () => { reactRoot.render(element) }) }
async function unmount() {
  await act(async () => { reactRoot.unmount(); reactRoot = null })
  ui.reset()
  resetOutsideFocusHistory()
}
const focus = (element) => act(async () => { element.focus() })
const click = (element) => act(async () => { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })) })
const key = (keyName, target) => act(async () => {
  const node = target ?? active() ?? window.document.body
  node.dispatchEvent(new window.KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true }))
})
const escape = () => key('Escape')

/* ------------------------------- 真实指针事件 / 组合事件（层栈一致性与 IME 用） */

/** 派发真实指针事件并返回它（断言 defaultPrevented：被模态屏障截断的信号） */
async function fire(element, type) {
  const event = new window.MouseEvent(type, { bubbles: true, cancelable: true })
  await act(async () => { element.dispatchEvent(event) })
  return event
}
/** 派发真实 keydown；isComposing 走 KeyboardEventInit，keyCode 229 只能自己补（浏览器旧路径） */
async function keyOn(element, keyName, init = {}) {
  const event = new window.KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true, isComposing: init.isComposing === true })
  if (init.keyCode) Object.defineProperty(event, 'keyCode', { value: init.keyCode })
  await act(async () => { element.dispatchEvent(event) })
  return event
}
/** 真实组合事件（compositionstart / compositionupdate / compositionend） */
const compose = (element, type, data = '') => act(async () => {
  element.dispatchEvent(new window.CompositionEvent(type, { bubbles: true, cancelable: true, data }))
})
/** 像用户输入那样改值（绕过 React 的 value 追踪，触发 onChange） */
const setValue = (element, value) => act(async () => {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set
  setter.call(element, value)
  element.dispatchEvent(new window.Event('input', { bubbles: true }))
})
/** 下拉选择：React 的 select onChange 走 change 事件 */
const setSelect = (element, value) => act(async () => {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set
  setter.call(element, value)
  element.dispatchEvent(new window.Event('change', { bubbles: true }))
})
/** 表单提交（跳转行号走 onSubmit） */
const submit = (form) => act(async () => { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })) })
/** 等定时器/requestAnimationFrame 结算（生产代码里滚动高亮按帧节流、跳转在 rAF 里滚动） */
const settle = (ms = 32) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)) })
/** 模拟用户滚动：改 scrollTop 后派发真实 scroll（React 的 onScroll 挂在元素自身） */
const scrollTo = (element, top) => act(async () => {
  element.scrollTop = top
  element.dispatchEvent(new window.Event('scroll'))
})
/** 给无排版环境造几何：让被测元素表现为「可滚动的长内容」 */
const setGeometry = (element, { scrollHeight, clientHeight }) => {
  Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => scrollHeight })
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => clientHeight })
}
/** 从 bridge 桩里取出最近一次 tasks.onEvent 订阅回调，像主进程那样推事件（流式回归用） */
const emitTaskEvent = (taskId, event) => act(async () => {
  const subscription = bridgeCalls.calls.filter((call) => call.path === 'tasks.onEvent').at(-1)
  subscription?.args[0]?.(taskId, event)
})

/* ------------------------------------------------- 1. 关键缺陷：模态 autoFocus */

async function modalScenario(label, wrapper) {
  section(label)
  await render(wrapper ? wrapper(createElement(NewAgentScenario)) : createElement(NewAgentScenario))
  const trigger = byTestId('trigger')
  await focus(trigger)
  ok(active() === trigger, '打开前焦点在「新建 Agent」按钮上')
  await click(trigger)
  const input = byTestId('name-input')
  ok(!!byTestId('modal'), '模态已打开')
  ok(active() === input, 'autoFocus 输入框拿到焦点（React 在 commitMount 阶段抢焦点）')
  // 真实 DOM 的 Tab 循环（不是纯函数断言）
  await focus(byTestId('cancel'))
  await key('Tab')
  ok(active() === input, 'Tab 在模态内环绕：末尾元素 → 首个元素')
  await escape()
  ok(!byTestId('modal'), 'Escape 关闭模态（最上层消费）')
  ok(active() === trigger, `关闭后焦点回到触发按钮，不是 body（实测 ${nameOf(active())}）`)
  await unmount()
}

await modalScenario('真实 React DOM：Escape 关闭后焦点归位（Agent 页新建 Agent 复现路径）', null)
await modalScenario('StrictMode：双渲染 / 双执行 effect 下同样归位', (child) => createElement(StrictMode, null, child))

/* ------------------------------------------------------------ 2. 嵌套浮层 */

section('嵌套模态：Escape 只关最上层，逐层归还焦点')
{
  await render(createElement(NestedModalScenario))
  const trigger = byTestId('trigger')
  await focus(trigger)
  await click(trigger)
  const outerInput = byTestId('outer-input')
  ok(active() === outerInput, '外层模态打开，autoFocus 输入框拿焦点')
  await focus(byTestId('open-inner'))
  await click(byTestId('open-inner'))
  const innerOk = byTestId('inner-ok')
  ok(!!byTestId('inner-modal') && active() === innerOk, '内层模态打开并拿到首焦点')
  await key('Tab')
  ok(active() === innerOk, '内层（最上层 trap）自己循环 Tab，外层不插手')
  await escape()
  ok(!byTestId('inner-modal') && !!byTestId('outer-modal'), 'Escape 只关最上层：内层关闭、外层仍在')
  ok(active() === byTestId('open-inner'), `内层关闭后焦点回到外层模态里的触发按钮（实测 ${nameOf(active())}）`)
  await escape()
  ok(!byTestId('outer-modal'), '再按 Escape 关闭外层模态')
  ok(active() === trigger, `外层关闭后焦点回到页面触发按钮（实测 ${nameOf(active())}）`)
  await unmount()
}

section('模态内下拉菜单（autoFocus:false 的 popover 浮在模态之上）')
{
  await render(createElement(MenuInModalScenario))
  const trigger = byTestId('trigger')
  await focus(trigger)
  await click(trigger)
  const menuTrigger = byTestId('menu-trigger')
  await focus(menuTrigger)
  await click(menuTrigger)
  ok(!!container.querySelector('.menu-panel'), '菜单打开')
  ok(active() === menuTrigger, 'popover 不搬焦点（autoFocus:false），焦点留在菜单触发器')
  await escape()
  ok(!container.querySelector('.menu-panel') && !!byTestId('modal'), 'Escape 只关菜单，模态不受影响')
  ok(active() === menuTrigger, '菜单关闭后焦点仍在菜单触发器上')
  await escape()
  ok(!byTestId('modal'), 'Escape 关闭模态')
  ok(active() === trigger, `模态关闭后焦点回到页面触发按钮（实测 ${nameOf(active())}）`)
  await unmount()
}

/* ---------------------------------------------------------------- 3. 卸载 */

section('卸载：浮层宿主卸载 / 触发元素一起卸载')
{
  await render(createElement(UnmountScenario, { showLayer: false, showTrigger: true }))
  const trigger = byTestId('trigger')
  await focus(trigger)
  await rerender(createElement(UnmountScenario, { showLayer: true, showTrigger: true }))
  ok(active() === byTestId('child-input'), '浮层随挂载打开并 autoFocus')
  await rerender(createElement(UnmountScenario, { showLayer: false, showTrigger: true }))
  ok(!byTestId('modal') && active() === trigger, `浮层宿主卸载后焦点归还触发按钮（实测 ${nameOf(active())}）`)
  await unmount()

  await render(createElement(UnmountScenario, { showLayer: false, showTrigger: true }))
  await focus(byTestId('trigger'))
  await rerender(createElement(UnmountScenario, { showLayer: true, showTrigger: true }))
  await rerender(createElement(UnmountScenario, { showLayer: false, showTrigger: false }))
  ok(!byTestId('modal') && active() === window.document.body, '触发元素与浮层一起卸载：不抢焦点、不报错（焦点落回 body）')
  await unmount()
}

/* ------------------------------------------------------- 4. 确认框 FIFO 队列 */

section('真实确认框宿主：FIFO 接棒与最终归还')
{
  await render(createElement(ConfirmScenario))
  const trigger = byTestId('trigger')
  await focus(trigger)
  await click(trigger)
  const dialog = () => container.querySelector('.confirm-dialog')
  const confirmBtn = () => dialog()?.querySelectorAll('.dialog-footer button')[1] ?? null
  ok(!!dialog() && dialog().textContent.includes('第 1 问'), '并发请求按 FIFO 只展示队首')
  ok(active() === confirmBtn(), `确认按钮拿到首焦点（实测 ${nameOf(active())}）`)
  await click(confirmBtn())
  ok(dialog().textContent.includes('第 2 问'), '队首结算后第二问接棒')
  ok(active() === confirmBtn(), '接棒时焦点跟到新的确认按钮')
  await click(confirmBtn())
  ok(!dialog(), '最后一问结算后确认框关闭')
  ok(active() === trigger, `全部结算后焦点回到触发按钮（实测 ${nameOf(active())}）`)
  await unmount()
}

/* ------------------------------------------------------------ 5. 命令面板 */

section('真实命令面板：initialFocusRef 与关闭归还')
{
  await render(createElement(PaletteScenario))
  const trigger = byTestId('trigger')
  await focus(trigger)
  await click(trigger)
  const input = container.querySelector('.palette input')
  ok(!!input && active() === input, '面板打开后焦点在输入框（initialFocusRef）')
  await escape()
  ok(!container.querySelector('.palette'), 'Escape 关闭面板')
  ok(active() === trigger, `面板关闭后焦点回到触发按钮（实测 ${nameOf(active())}）`)
  await unmount()
}

section('就地编辑（触发按钮被编辑框替换）：Escape 后焦点回到重新挂载的按钮')
{
  await render(createElement(InlineEditScenario))
  const editBtn = byTestId('title-edit')
  await focus(editBtn)
  await click(editBtn)
  const input = byTestId('title-input')
  ok(!!input && active() === input, '编辑框打开并拿到焦点（autoFocus）')
  await escape()
  ok(!byTestId('title-input') && !!byTestId('title-edit'), 'Escape 退出编辑（触发按钮重新挂载）')
  ok(active() === byTestId('title-edit'), `焦点回到重新挂载的触发按钮（实测 ${nameOf(active())}）`)
  await unmount()
}

/* ------------------------------------------------------ 6. SideDock 页签焦点 */
section('SideDock 页签条：←/→ 切换把焦点带到新激活页签')
{
  ui.setTasks([{ id: 'rootA', title: '领队A' }, { id: 'kid', title: '队员', parentTaskId: 'rootA' }])
  ui.dock.open({ id: 'file:1', kind: 'file', title: 'a.ts', payload: { taskId: 'kid', file: 'a.ts', content: 'const a = 1\n' } })
  ui.dock.open({ id: 'file:2', kind: 'file', title: 'b.ts', payload: { taskId: 'kid', file: 'b.ts', content: 'const b = 2\n' } })
  await render(createElement(SideDockScenario, { taskId: 'rootA' }))
  const tabs = () => [...container.querySelectorAll('[role="tab"]')]
  ok(tabs().length === 2, '两条分页都渲染出来')
  ok(tabs()[1].getAttribute('aria-selected') === 'true' && tabs()[1].tabIndex === 0, '第二条为激活页签（roving tabindex）')
  await focus(tabs()[1])
  await key('ArrowLeft', tabs()[1])
  ok(tabs()[0].getAttribute('aria-selected') === 'true' && tabs()[0].tabIndex === 0, 'ArrowLeft 把激活项切到第一条')
  ok(active() === tabs()[0], `焦点跟着切到新激活页签（实测 ${nameOf(active())}）`)
  await key('ArrowRight', tabs()[0])
  ok(tabs()[1].getAttribute('aria-selected') === 'true' && active() === tabs()[1], 'ArrowRight 切回并同样带走焦点')
  await key('Home', tabs()[1])
  ok(tabs()[0].getAttribute('aria-selected') === 'true' && active() === tabs()[0], 'Home 跳到首条并带走焦点')
  await key('End', tabs()[0])
  ok(tabs()[1].getAttribute('aria-selected') === 'true' && active() === tabs()[1], 'End 跳到末条并带走焦点')
  await key('Delete', tabs()[1])
  ok(tabs().length === 1 && tabs()[0].getAttribute('aria-selected') === 'true', 'Delete 关掉当前页签，剩下的成为激活项')
  ok(active() === tabs()[0], `关页签后焦点落到新的激活页签（实测 ${nameOf(active())}）`)
  await unmount()
}

/* ------------------------------------- 7. 层栈一致性（视觉 / 指针 / 焦点同序） */

section('层栈一致性：浮窗 + 信息弹层 + 模态同屏（视觉 z 跟随层序）')
{
  resetStackHits()
  await render(createElement(OverlapStackScenario))
  const floatRoot = () => container.querySelector('.float-window')
  const infoRoot = () => byTestId('info-wrap')
  const modalRoot = () => byTestId('modal-root')
  const menuRoot = () => container.querySelector('.menu-root')
  const z = (node) => Number(node?.style?.zIndex ?? 0)
  ok(!!floatRoot() && z(floatRoot()) > 0, `非模态浮窗入栈并拿到层栈内联 z（实测 ${z(floatRoot())}）`)
  await click(byTestId('toggle-info'))
  ok(!!byTestId('info-pop'), '信息弹层打开')
  ok(z(infoRoot()) > z(floatRoot()), `视觉层序：后开的信息弹层 z(${z(infoRoot())}) 在浮窗 z(${z(floatRoot())}) 之上`)
  await click(byTestId('open-modal'))
  ok(!!modalRoot(), '模态打开（创建/确认路径）')
  ok(z(modalRoot()) > z(infoRoot()), `视觉层序：模态 z(${z(modalRoot())}) 压住信息弹层 z(${z(infoRoot())}) 与浮窗 z(${z(floatRoot())})`)
  ok(interactionLayers.topModal()?.name === 'confirm', 'topModal() 仍返回最上层模态（共享契约保留）')

  /* 指针：模态开着时，落在模态之下的浮层收不到任何指针事件 */
  const down = await fire(byTestId('float-btn'), 'mousedown')
  ok(down.defaultPrevented, '背景浮窗的 mousedown 在捕获阶段被模态屏障截断（defaultPrevented）')
  await fire(byTestId('float-btn'), 'pointerdown')
  await fire(byTestId('float-btn'), 'click')
  await fire(byTestId('float-btn'), 'contextmenu')
  await fire(byTestId('info-btn'), 'click')
  ok(stackHits.float === 0 && stackHits.info === 0, `模态下方的浮窗/信息弹层一次点击都没收到（计数 ${stackHits.float}/${stackHits.info}）`)

  /* 焦点：背景元素在模态开着时拿不到焦点 */
  const infoBtn = byTestId('info-btn')
  await focus(infoBtn)
  ok(active() !== infoBtn && !!active()?.closest?.('[data-testid="modal-root"]'), `背景信息弹层抢不到焦点，焦点被拉回模态内（实测 ${nameOf(active())}）`)

  /* 模态自身 + 浮在模态之上的嵌套菜单照常可用 */
  const previousModalZ = z(modalRoot())
  await rerender(createElement(OverlapStackScenario, { hideInfo: true }))
  ok(z(modalRoot()) === previousModalZ - 1, '中间信息层卸载后，存活模态同步更新视觉层序')
  await click(byTestId('modal-ok'))
  ok(stackHits.modal === 1, '模态自己的按钮照常可点')
  await click(byTestId('modal-menu-trigger'))
  ok(!!container.querySelector('.menu-panel'), '模态内嵌套菜单打开')
  ok(z(menuRoot()) > z(modalRoot()), `嵌套菜单 z(${z(menuRoot())}) 在模态 z(${z(modalRoot())}) 之上（层序更晚）`)
  await click(container.querySelector('.menu-panel .menu-item'))
  ok(stackHits.menu === 1 && stackHits.menuPick === 'yes', `模态之上的嵌套菜单照常选中（pick=${stackHits.menuPick}）`)

  /* 外点关闭仍只归最上层；模态关掉后背景恢复可点 */
  await click(modalRoot())
  ok(!modalRoot(), '点击遮罩本身关闭模态（外点语义只作用于最上层）')
  await click(byTestId('float-btn'))
  ok(stackHits.float === 1, '模态关闭后背景浮窗恢复可点（计数 1）')
  ok(z(floatRoot()) > 0 && interactionLayers.size() === 1, '仅存活浮窗保留在层栈中，已关闭信息层不会复活')
  await unmount()
}

/* --------------------------------------------- 8. 真实 IME 组合（不抢本地按键） */

section('IME：真实组合事件下 Palette / Menu / 重命名 / 追问技能菜单都不抢 Enter/Escape/↑↓')
{
  /* 命令面板 */
  paletteRuns.count = 0
  await render(createElement(PaletteScenario))
  await click(byTestId('trigger'))
  const paletteInput = container.querySelector('.palette input')
  ok(!!paletteInput, '命令面板打开')
  const paletteItems = () => [...container.querySelectorAll('.palette-item')]
  const activePalette = () => container.querySelector('.palette-item.active')
  await compose(paletteInput, 'compositionstart')
  await compose(paletteInput, 'compositionupdate', 'ji')
  await keyOn(paletteInput, 'Enter', { isComposing: true })
  ok(paletteRuns.count === 0 && !!container.querySelector('.palette'), '组合中 Enter 不执行命令、面板不关')
  await keyOn(paletteInput, 'ArrowDown', { isComposing: true })
  ok(activePalette() === paletteItems()[0], '组合中 ↑↓ 不移动高亮（还是第一条）')
  await keyOn(paletteInput, 'Enter', { keyCode: 229 })
  ok(paletteRuns.count === 0, 'keyCode 229 走同一条保护（仍不执行）')
  await compose(paletteInput, 'compositionend', 'ji')
  await keyOn(paletteInput, 'ArrowDown')
  ok(activePalette() === paletteItems()[1], '组合结束后 ↑↓ 恢复正常（移到第二条）')
  await keyOn(paletteInput, 'Enter')
  ok(paletteRuns.count === 1 && paletteRuns.last === 'go-board', `组合结束后 Enter 正常执行选中项（${paletteRuns.last}）`)
  await unmount()

  /* 真实 Menu（模态内下拉） */
  await render(createElement(MenuInModalScenario))
  await click(byTestId('trigger'))
  const menuTrigger = byTestId('menu-trigger')
  await focus(menuTrigger)
  await click(menuTrigger)
  ok(!!container.querySelector('.menu-panel'), '模态内下拉菜单打开')
  const activeMenuLabel = () => container.querySelector('.menu-item.active .menu-label')?.textContent
  await compose(menuTrigger, 'compositionstart')
  await keyOn(menuTrigger, 'ArrowDown', { isComposing: true })
  ok(activeMenuLabel() === 'codex', `组合中 ↑↓ 不改菜单高亮（实测 ${activeMenuLabel()}）`)
  await keyOn(menuTrigger, 'Enter', { isComposing: true })
  ok(!!container.querySelector('.menu-panel'), '组合中 Enter 不选中项、菜单不关')
  await keyOn(menuTrigger, 'Enter', { keyCode: 229 })
  ok(!!container.querySelector('.menu-panel'), 'keyCode 229 同样不选中')
  await compose(menuTrigger, 'compositionend')
  await keyOn(menuTrigger, 'Enter')
  ok(!container.querySelector('.menu-panel') && menuTrigger.textContent.includes('codex'), `组合结束后 Enter 正常选中（实测「${menuTrigger.textContent}」）`)
  await escape()
  ok(!byTestId('modal'), '清理：关闭场景模态')
  await unmount()

  /* 真实 TaskDetail：重命名输入框 + 追问框 / 斜杠技能菜单 */
  const renameCalls = () => bridgeCalls.count('tasks.rename')
  const followUpCalls = () => bridgeCalls.count('tasks.followUp')
  await render(createElement(TaskDetailScenario))
  const editBtn = container.querySelector('.title-edit')
  ok(!!editBtn, '真实 TaskDetail 渲染出重命名按钮')
  await focus(editBtn)
  await click(editBtn)
  const titleInput = container.querySelector('.title-edit-input')
  ok(!!titleInput && active() === titleInput, '重命名输入框打开并拿到焦点（autoFocus）')
  await setValue(titleInput, '新的标题')
  await compose(titleInput, 'compositionstart')
  await compose(titleInput, 'compositionupdate', 'xin')
  await keyOn(titleInput, 'Enter', { isComposing: true })
  ok(!!container.querySelector('.title-edit-input') && renameCalls() === 0, '组合中 Enter 不提交重命名')
  await keyOn(titleInput, 'Escape', { isComposing: true })
  ok(!!container.querySelector('.title-edit-input'), '组合中 Escape 不关重命名层（层栈同样守 IME）')
  await keyOn(titleInput, 'Enter', { keyCode: 229 })
  ok(renameCalls() === 0, 'keyCode 229 同样不提交重命名')
  await compose(titleInput, 'compositionend', 'xin')
  await keyOn(titleInput, 'Enter')
  ok(!container.querySelector('.title-edit-input') && renameCalls() === 1, '组合结束后 Enter 提交重命名（桥调用 1 次）')
  ok(active() === container.querySelector('.title-edit'), `提交后焦点回到重新挂载的重命名按钮（实测 ${nameOf(active())}）`)

  const composer = container.querySelector('.followup textarea')
  ok(!!composer, '追问框渲染出来')
  await setValue(composer, '/')
  ok(!!container.querySelector('.skill-menu'), '输入 / 后「命令与技能」菜单打开')
  const activeSkill = () => container.querySelector('.skill-menu-item.active .skill-menu-name')?.textContent
  const firstSkill = activeSkill()
  await compose(composer, 'compositionstart')
  await keyOn(composer, 'ArrowDown', { isComposing: true })
  ok(activeSkill() === firstSkill, `组合中 ↑↓ 不移动技能菜单高亮（实测 ${activeSkill()}）`)
  await keyOn(composer, 'Enter', { isComposing: true })
  ok(!!container.querySelector('.skill-menu') && followUpCalls() === 0, '组合中 Enter 不选中命令、也不发送')
  await keyOn(composer, 'Escape', { isComposing: true })
  ok(!!container.querySelector('.skill-menu'), '组合中 Escape 不关技能菜单')
  await keyOn(composer, 'Enter', { keyCode: 229 })
  ok(followUpCalls() === 0, 'keyCode 229 同样不发送')
  await compose(composer, 'compositionend')
  await keyOn(composer, 'ArrowDown')
  ok(activeSkill() !== firstSkill, `组合结束后 ↓ 正常移动高亮（${activeSkill()}）`)
  await keyOn(composer, 'Escape')
  ok(!container.querySelector('.skill-menu'), '组合结束后 Escape 正常关闭技能菜单')
  await setValue(composer, '继续修一下')
  await keyOn(composer, 'Enter')
  ok(followUpCalls() === 1, '非组合 Enter 正常发送追问（followUp 桥调用 1 次）')
  await unmount()
}

/* ------------------------------------------- 9. 审查项 1：跨任务校正不可用页签 */

section('Git access and focus persist when switching to a task without a snapshot')
{
  const withGit = makeTask({ id: 'with-git', title: '有改动', status: 'done', gitStat: 'src/app.ts | 3 +++', gitDiff: 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,1 +1,2 @@\n ctx\n+added' })
  const noGit = makeTask({ id: 'no-git', title: '无改动', status: 'done' })
  const tab = (key) => container.querySelector(`#detail-tab-${key}`)
  const panel = () => container.querySelector('#detail-tabpanel')

  await render(createElement(TaskDetail, { task: withGit, tasks: [withGit, noGit], onSelect: () => {} }))
  ok(!tab('git').disabled, '任务有 Git 改动：Git 页签可用')
  await focus(tab('git'))
  await click(tab('git'))
  ok(tab('git').getAttribute('aria-selected') === 'true' && panel().getAttribute('aria-labelledby') === 'detail-tab-git', '切到 Git 页签（面板指向它）')

  await rerender(createElement(TaskDetail, { task: noGit, tasks: [withGit, noGit], onSelect: () => {} }))
  ok(!tab('git').disabled, 'Git remains available without a stored snapshot')
  ok(tab('git').getAttribute('aria-selected') === 'true' && panel().getAttribute('aria-labelledby') === 'detail-tab-git', 'Switching tasks keeps the selected Git view')
  ok(tab('git').tabIndex === 0 && active() === tab('git'), 'The selected Git tab retains keyboard focus')
  ok(panel().querySelector('[data-snapshot-state="unavailable"]'), 'Missing snapshots render an explicit unavailable state')
  await unmount()
}

/* ------------------------------------- 10. 审查项 2 / 6：贴底跟随 + 动效偏好 */

section('审查项 2 / 6：流式自动滚动受「贴底跟随」控制，显式滚动尊重 prefers-reduced-motion')
{
  const task = makeTask({ id: 'stream', title: '流式任务', status: 'done', prompt: '跑起来', sessionId: 'sess-stream' })
  await render(createElement(TaskDetail, { task, tasks: [task], onSelect: () => {} }))
  await click(container.querySelector('#detail-tab-log'))
  const log = container.querySelector('.log.chat')
  ok(!!log, '执行记录时间线挂载')
  // jsdom 没有排版：显式造出「可滚动的长日志」几何（scroller = .log 自身）
  setGeometry(log, { scrollHeight: 1000, clientHeight: 400 })
  const latest = () => container.querySelector('.chat-latest')

  await emitTaskEvent('stream', { seq: 1, ts: Date.now(), kind: 'text', text: '第一段流式内容' })
  await scrollTo(log, 600) // 贴底（600 = 1000 - 400）
  ok(!latest(), '在底部时不显示「回到最新」')

  await emitTaskEvent('stream', { seq: 2, ts: Date.now(), kind: 'text', text: '更多内容' })
  ok(log.scrollTop === 1000, `贴底时新事件自动跟随到末尾（scrollTop=${log.scrollTop}）`)

  await scrollTo(log, 100) // 用户滚上去读旧内容
  ok(!!latest(), '离开底部后浮出「回到最新」')
  await emitTaskEvent('stream', { seq: 3, ts: Date.now(), kind: 'text', text: '还在流式' })
  ok(log.scrollTop === 100, `读旧内容时流式新事件不抢滚动位置（scrollTop=${log.scrollTop}）`)
  ok(!!latest(), '不跟随状态保持（按钮仍在）')

  // 审查项 6：同一个「回到最新」，减弱动效时必须是即时跳转
  reducedMotion = true
  ok(prefersReducedMotion() === true && scrollBehavior() === 'auto', 'motion 助手读到系统「减弱动态效果」')
  await click(latest())
  await settle()
  ok(lastScroll().behavior === 'auto' && log.scrollTop === 1000, `reduce 时「回到最新」即时跳转（behavior=${lastScroll().behavior}）`)
  ok(!latest(), '回到末尾后跟随状态恢复、按钮收起')

  reducedMotion = false
  ok(prefersReducedMotion() === false && scrollBehavior() === 'smooth', '未开启减弱动效时回到 smooth')
  await scrollTo(log, 100)
  await click(latest())
  await settle()
  ok(lastScroll().behavior === 'smooth' && log.scrollTop === 1000, `默认「回到最新」平滑滚动（behavior=${lastScroll().behavior}）`)
  await unmount()
}

/* ------------------------------------------- 11. 审查项 3：顶部页签关闭后的焦点 */

section('审查项 3：关闭顶部页签后焦点跟随宿主结算的实际 activeId')
{
  ui.reset()
  ui.setTasks([
    { id: 't1', title: '任务一', status: 'done' },
    { id: 't2', title: '任务二', status: 'done' },
    { id: 't3', title: '任务三', status: 'done' }
  ])
  ui.openTask('t1')
  ui.openTask('t2')
  ui.openTask('t3')
  await render(createElement(TabBarScenario))
  const tabEl = (id) => container.querySelector(`[data-tab-id="${id}"]`)
  const closeBtn = (id) => tabEl(id)?.querySelector('.tab-close')
  ok(ui.getState().tabs.join() === 't1,t2,t3' && ui.getState().activeId === 't3', '三个页签都打开，激活的是第三个')

  // 关闭**非激活**的首个页签：activeId 不变（旧实现按「右邻」把焦点丢给 t2）
  await focus(closeBtn('t1'))
  await click(closeBtn('t1'))
  ok(ui.getState().tabs.join() === 't2,t3' && ui.getState().activeId === 't3', '关掉非激活页签：宿主 activeId 仍是 t3')
  ok(active() === tabEl('t3'), `焦点跟随实际 activeId=t3，而不是被关项的邻位（实测 ${nameOf(active())}）`)

  // 关闭**激活**页签：宿主把激活项落到最后一个剩余页签
  await focus(closeBtn('t3'))
  await click(closeBtn('t3'))
  ok(ui.getState().tabs.join() === 't2' && ui.getState().activeId === 't2', '关掉激活页签：activeId 落到仅剩的 t2')
  ok(active() === tabEl('t2'), `焦点同样跟随结算后的 activeId（实测 ${nameOf(active())}）`)

  // Delete 键路径（焦点在页签上）
  await act(async () => { ui.openTask('t1') })
  await focus(tabEl('t2'))
  await key('Delete', tabEl('t2'))
  ok(!tabEl('t2') && ui.getState().activeId === 't1', 'Delete 关页签：宿主激活项落到 t1')
  ok(active() === tabEl('t1'), `Delete 关页签后焦点跟随实际 activeId（实测 ${nameOf(active())}）`)
  await unmount()
  ui.reset()
}

/* --------------------------------- 12. 审查项 4 / 6：diff 按新旧文件绝对行号跳转 */

section('审查项 4 / 6：CodeViewer 在 diff 中按新旧文件绝对行号跳转（滚动同样守动效偏好）')
{
  const diff = [
    'diff --git a/src/app.ts b/src/app.ts',
    'index 1111111..2222222 100644',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -10,4 +10,5 @@',
    ' ctx10',
    '-old11',
    '+new11',
    '+new12',
    ' ctx12',
    '@@ -41,2 +41,2 @@',
    ' ctx41',
    '-old42',
    '+new42'
  ].join('\n')
  const rows = parseUnifiedDiff(diff)
  ok(rows.length === 10 && rows[0].kind === 'hunk', `diff 行模型：10 行（实测 ${rows.length}）`)
  ok(findDiffRowIndex(rows, 42, 'new') === 9 && findDiffRowIndex(rows, 42, 'old') === 8, '同一行号在新/旧两侧落到不同行（删除行的 number 是旧文件行号）')
  ok(findDiffRowIndex(rows, 41, 'new') === 7 && findDiffRowIndex(rows, 41, 'old') === 7, 'hunk 头不参与行号命中（第 41 行落在真实内容行上）')
  ok(findDiffRowIndex(rows, 100, 'new') === -1, '不在 diff 范围内的绝对行号无命中')

  await render(createElement(CodeViewer, { file: 'src/app.ts', diff }))
  await settle()
  const input = () => container.querySelector('.code-goto input')
  const side = () => container.querySelector('.code-goto-side')
  const jumped = () => container.querySelector('.code-line.is-jump')
  const jumpText = () => jumped()?.querySelector('code')?.textContent
  const jump = async (line) => { await setValue(input(), String(line)); await submit(container.querySelector('.code-goto')); await settle() }

  ok(!!side(), 'diff 模式出现「新文件 / 旧文件」行号侧选择器')
  await jump(100)
  ok(!jumped(), 'diff 外的绝对行号不误跳（旧实现会拿行下标当行号乱跳）')

  reducedMotion = true
  await jump(42)
  ok(jumped()?.getAttribute('data-code-line') === '9' && jumpText() === 'new42', `新文件第 42 行 → 行下标 9（实测 ${jumped()?.getAttribute('data-code-line')} / ${jumpText()}）`)
  ok(lastScroll().behavior === 'auto', `reduce 时跳转滚动即时（behavior=${lastScroll().behavior}）`)

  reducedMotion = false
  await setSelect(side(), 'old')
  ok(input().getAttribute('aria-label') === '跳转到旧文件行', '切到旧文件侧：跳转输入的 aria-label 同步')
  await jump(42)
  ok(jumped()?.getAttribute('data-code-line') === '8' && jumpText() === 'old42', `旧文件第 42 行 → 行下标 8（实测 ${jumped()?.getAttribute('data-code-line')} / ${jumpText()}）`)
  ok(lastScroll().behavior === 'smooth', `默认跳转滚动仍是平滑（behavior=${lastScroll().behavior}）`)

  await setSelect(side(), 'new')
  await jump(41)
  ok(jumped()?.getAttribute('data-code-line') === '7' && jumpText() === 'ctx41', `新文件第 41 行 → 跨 hunk 断号仍命中上下文行（实测 ${jumped()?.getAttribute('data-code-line')} / ${jumpText()}）`)
  // 非 diff 模式：不出现侧选择器，跳转仍是「行号 = 行下标 + 1」的老语义
  await rerender(createElement(CodeViewer, { file: 'a.txt', content: 'one\ntwo\nthree\nfour\n' }))
  await settle()
  ok(!side(), '非 diff 模式不渲染行号侧选择器')
  await jump(3)
  ok(jumped()?.getAttribute('data-code-line') === '2' && jumpText() === 'three', 'content 模式跳第 3 行 → 行下标 2')
  await unmount()
}

/* ------------------------------- 13. 审查项 5：textarea/listbox 的 aria 与 Tab 序列 */

section('审查项 5：追问框（combobox）↔ 技能 listbox 的 aria 关系与选项 Tab 序列')
{
  await render(createElement(TaskDetailScenario))
  const composer = container.querySelector('.followup textarea')
  const listbox = () => container.querySelector('#skill-menu-listbox')
  const options = () => [...container.querySelectorAll('.skill-menu [role="option"]')]
  const selectedOption = () => container.querySelector('.skill-menu [role="option"][aria-selected="true"]')
  ok(!!composer, '追问框渲染出来')
  ok(composer.getAttribute('role') === 'combobox' && composer.getAttribute('aria-haspopup') === 'listbox' && composer.getAttribute('aria-autocomplete') === 'list',
    '追问框是 combobox（aria-haspopup=listbox / aria-autocomplete=list）')
  ok(composer.getAttribute('aria-expanded') === 'false' && !composer.hasAttribute('aria-controls') && !composer.hasAttribute('aria-activedescendant'),
    '菜单未开：aria-expanded=false，且不留下悬空的 aria-controls / aria-activedescendant')

  await focus(composer)
  await setValue(composer, '/')
  ok(composer.getAttribute('aria-expanded') === 'true', '输入 / 后 aria-expanded=true')
  ok(composer.getAttribute('aria-controls') === 'skill-menu-listbox' && listbox()?.getAttribute('role') === 'listbox', 'aria-controls 指向真实存在的 listbox')
  ok(composer.getAttribute('aria-activedescendant') === 'skill-menu-opt-0' && !!container.querySelector('#skill-menu-opt-0'), 'aria-activedescendant 指向真实存在的当前项')
  ok(selectedOption()?.id === 'skill-menu-opt-0', '当前项同时带 aria-selected=true（视觉高亮与 aria 同源）')
  ok(options().length >= 2 && options().every((option) => option.tabIndex === -1), `选项都不在 Tab 序列里（${options().length} 项 tabIndex=-1）`)

  await keyOn(composer, 'ArrowDown')
  ok(composer.getAttribute('aria-activedescendant') === 'skill-menu-opt-1' && selectedOption()?.id === 'skill-menu-opt-1', '↓ 后 aria-activedescendant 与 aria-selected 同步移动')
  ok(active() === composer, `焦点始终留在输入框（选项只是被指认，不被聚焦，实测 ${nameOf(active())}）`)

  await keyOn(composer, 'Escape')
  ok(composer.getAttribute('aria-expanded') === 'false' && !composer.hasAttribute('aria-controls') && !composer.hasAttribute('aria-activedescendant') && !listbox(),
    'Escape 关闭后 aria 关系收回（没有指向已卸载 listbox 的悬空引用）')
  await unmount()
}

/* ---------------------- 14. 真实 TaskDetail 视图页签：←/→/Home/End 与 Ctrl+1..4 */

section('真实 TaskDetail 视图页签：次级页签（动态 / 结果）参与 ←/→ 环绕与 Home/End，Ctrl+1..4 直达且焦点跟随')
{
  const task = makeTask({ id: 'tab-nav', title: '页签导航', status: 'done', result: '## 结果正文' })
  await render(createElement(TaskDetail, { task, tasks: [task], onSelect: () => {} }))
  const order = ['log', 'git', 'activity', 'result']
  const tabEl = (key) => container.querySelector(`#detail-tab-${key}`)
  const selected = () => order.find((key) => tabEl(key)?.getAttribute('aria-selected') === 'true') ?? null
  const panel = () => container.querySelector('#detail-tabpanel')
  /** 一次导航的四条同源判据：激活项、面板指向、roving tabindex、真实焦点 */
  const at = (key) => selected() === key
    && panel().getAttribute('aria-labelledby') === `detail-tab-${key}`
    && tabEl(key).tabIndex === 0
    && active() === tabEl(key)
  /** Ctrl+数字：事件从当前焦点冒泡到 .detail（真实页面里就是这么按的） */
  const ctrl = (digit) => act(async () => {
    const node = active() ?? container.querySelector('.tabs')
    node.dispatchEvent(new window.KeyboardEvent('keydown', { key: digit, ctrlKey: true, bubbles: true, cancelable: true }))
  })

  ok(order.every((key) => !!tabEl(key)), '真实 TaskDetail 渲染出四个视图页签')
  ok(tabEl('activity').classList.contains('tab-secondary') && tabEl('result').classList.contains('tab-secondary'),
    '「动态 / 结果」是次级页签（tab-secondary），与两个主视图同处一条 ←/→ 路径')
  ok(selected() === 'log' && tabEl('log').tabIndex === 0 && order.slice(1).every((key) => tabEl(key).tabIndex === -1),
    'roving tabindex：只有激活页签在 Tab 序列里')

  await focus(tabEl('log'))
  await key('ArrowLeft', tabEl('log'))
  ok(at('result'), `← 从首条环绕到末条「结果」（次级页签是环绕路径的一部分，实测焦点 ${nameOf(active())}）`)
  await key('ArrowRight', tabEl('result'))
  ok(at('log'), '→ 从末条环绕回首条「执行记录」')
  await key('End', tabEl('log'))
  ok(at('result'), 'End 直达末条次级页签')
  await key('Home', tabEl('result'))
  ok(at('log'), 'Home 回到首条')
  await key('ArrowRight', tabEl('log'))
  ok(at('git'), '→ 逐格右移')
  await key('ArrowRight', tabEl('git'))
  ok(at('activity'), '→ 进入次级页签「动态」')
  await key('ArrowRight', tabEl('activity'))
  ok(at('result'), '→ 再一格到「结果」')
  await key('ArrowLeft', tabEl('result'))
  ok(at('activity'), '← 从「结果」退回「动态」（次级页签之间也能反向走）')

  await ctrl('4')
  ok(at('result'), 'Ctrl+4 直达第四个页签「结果」，焦点一并带过去')
  await ctrl('3')
  ok(at('activity'), 'Ctrl+3 直达次级页签「动态」')
  await ctrl('2')
  ok(at('git'), 'Ctrl+2 直达「Git 改动」')
  await ctrl('1')
  ok(at('log'), 'Ctrl+1 直达首条「执行记录」')
  await ctrl('9')
  ok(at('log'), 'Ctrl+9 越界不生效（没有第 9 个页签，停在原处且不报错）')

  await keyOn(tabEl('log'), 'ArrowRight', { isComposing: true })
  ok(at('log'), 'IME 组合中 → 归输入法，页签不切换')
  await keyOn(tabEl('log'), 'End', { keyCode: 229 })
  ok(at('log'), 'keyCode 229 的 End 同样不抢')
  await keyOn(tabEl('log'), 'ArrowRight')
  ok(at('git'), '组合结束后 → 恢复正常')
  await unmount()
}

console.log(`\n${failures === 0 ? '✅ UI FOCUS (REAL DOM) SMOKE PASSED' : `❌ ${failures} 项断言失败`}`)
