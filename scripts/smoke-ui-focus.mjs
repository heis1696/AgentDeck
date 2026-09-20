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
//   8. 真实 SideDock 页签条：←/→ 切换后焦点必须落在新激活页签上。
//
// 依赖：jsdom 装在临时目录（不写仓库依赖、不进 package.json）：
//   mkdir %TEMP%\agentdeck-ui-dom-deps && cd %TEMP%\agentdeck-ui-dom-deps
//   npm init -y && npm i jsdom@24
// 也可用 AGENTDECK_UI_TEST_DEPS 指向别处。运行：node scripts/smoke-ui-focus.mjs
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const root = path.resolve(import.meta.dirname, '..')
const depsDir = process.env.AGENTDECK_UI_TEST_DEPS || path.join(os.tmpdir(), 'agentdeck-ui-dom-deps')

/* ------------------------------------------------------------- jsdom 环境 */

function loadJsdom() {
  for (const dir of [depsDir, path.join(root, 'node_modules')]) {
    try { return createRequire(path.join(dir, '__agentdeck_test_probe__.cjs'))('jsdom') } catch { /* 换下一个候选目录 */ }
  }
  console.error(`缺少 jsdom（真实 DOM 回归需要它，但不写进仓库依赖）。请先安装到临时目录：\n` +
    `  mkdir "${depsDir}" && cd "${depsDir}" && npm init -y && npm i jsdom@24\n` +
    `或设置 AGENTDECK_UI_TEST_DEPS 指向已装好 jsdom 的目录。`)
  process.exit(2)
}

const { JSDOM } = loadJsdom()
const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
const { window } = dom

// React DOM 在模块初始化时探测 window/document，必须先铺全局再 import 产物
globalThis.window = window
globalThis.document = window.document
globalThis.HTMLElement = window.HTMLElement
globalThis.HTMLInputElement = window.HTMLInputElement
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
const nameOf = (node) => !node ? 'null' : (node.getAttribute?.('data-testid') ?? node.id ?? node.tagName?.toLowerCase() ?? String(node))
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

console.log(`\n${failures === 0 ? '✅ UI FOCUS (REAL DOM) SMOKE PASSED' : `❌ ${failures} 项断言失败`}`)
