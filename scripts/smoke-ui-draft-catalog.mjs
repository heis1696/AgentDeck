// 草稿/目录集成回归（真实 React DOM + jsdom + 假桥）：渲染真实 <App/>，覆盖 Review Follow-up 的
// 「目录/导航」条目在**真实桥接事件 + 真实导航链路**下的行为：
//   1. 普通/目标/会议三种「稍后」创建：任务目录刷到可见后才进详情（修复：创建后列表缺新任务、详情弹回列表）；
//   2. 刷新响应乱序：挂载时发出的旧列表快照延迟落地，不得把新任务从目录里抹掉（useTasks 单调序号）；
//   3. task:focus 桥接事件先于目录到达：乐观页签兜底 → 目录到达后重路由到根详情 + dock 桶迁移（React 层可见）；
//   4. 目录始终缺失的任务：乐观页签被下一份快照收掉，不留僵尸页签；
//   5. 非模态浮窗（popover）不封锁页面快捷键，模态（命令面板）仍正确避让。
// 运行：node scripts/smoke-ui-draft-catalog.mjs（jsdom 为既有 devDependency）。
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')

/* ------------------------------------------------------------- jsdom 环境 */

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
const { window } = dom

globalThis.window = window
globalThis.document = window.document
globalThis.HTMLElement = window.HTMLElement
globalThis.HTMLTextAreaElement = window.HTMLTextAreaElement
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

// App 主题跟随用（jsdom 没有 matchMedia）
window.matchMedia = (query) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false } })
// jsdom 没有排版：浮层首焦点可见性判据打桩为「有一个矩形」
window.Element.prototype.getClientRects = function () { return [{ x: 0, y: 0, width: 120, height: 20, top: 0, left: 0, right: 120, bottom: 20 }] }
// The default execution view uses ResizeObserver; jsdom does not implement it.
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
window.ResizeObserver = ResizeObserverStub
globalThis.ResizeObserver = ResizeObserverStub

/* ----------------------------------------------------------------- 打包夹具 */

const outfile = path.join(root, 'out', 'smoke-ui-draft-catalog.cjs')
const shikiStub = path.join(root, 'scripts', 'fixtures', 'shiki-stub.ts')
const petStub = path.join(root, 'scripts', 'fixtures', 'pet-stub.tsx')
await build({
  entryPoints: [path.join(root, 'scripts', 'fixtures', 'ui-draft-harness.tsx')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
  plugins: [
    { name: 'stub-shiki', setup(build) { build.onResolve({ filter: /^shiki(\/|$)/ }, () => ({ path: shikiStub })) } },
    // PetStage 依赖 vite 的 import.meta.glob：jsdom 环境用空组件桩替身
    { name: 'stub-pet', setup(build) { build.onResolve({ filter: /pet\/Pet(Stage|SettingsPage)$/ }, () => ({ path: petStub })) } }
  ]
})

const { act, createElement, createRoot, App, ui, getDraftBridge } = await import(pathToFileURL(outfile).href)

/* ------------------------------------------------------------------ 断言器 */

let failures = 0
const ok = (condition, label) => {
  console.log(`  ${condition ? '✓' : '✗'} ${label}`)
  if (!condition) { failures++; process.exitCode = 1 }
}
const section = (title) => console.log(`\n── ${title}`)

const bridge = getDraftBridge()
const container = window.document.getElementById('app')
const active = () => window.document.activeElement
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const byQuery = (selector) => container.querySelector(selector)

let reactRoot = null
async function mount() {
  bridge.reset()
  await act(async () => { reactRoot = createRoot(container); reactRoot.render(createElement(App)) })
  await act(async () => { await sleep(30) })
}
async function unmount() {
  await act(async () => { reactRoot.unmount(); reactRoot = null })
  ui.reset()
}
const typeInto = (node, value) => act(async () => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(node, value)
  node.dispatchEvent(new window.Event('input', { bubbles: true }))
  await sleep(10)
})
const click = (node) => act(async () => {
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
  await sleep(10)
})
const pressKey = (key, modifiers = {}) => act(async () => {
  window.document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers }))
  await sleep(10)
})
/** 打开新建表单（Issue 主页）并提交「稍后」创建 */
async function composeLater(prompt, kind = 'task') {
  await act(async () => { ui.focusComposer(); await sleep(30) })
  if (kind !== 'task') {
    const tab = [...container.querySelectorAll('[role="tab"]')].find((node) => node.textContent.includes(kind === 'goal' ? '目标模式' : '团队会议'))
    await click(tab)
  }
  await typeInto(byQuery('.workspace-prompt'), prompt)
  if (kind === 'goal') await typeInto(byQuery('.workspace-mode-fields textarea'), '完成条件甲\n完成条件乙')
  const later = [...container.querySelectorAll('.workspace-row button')].find((node) => node.textContent.includes('稍后'))
  await click(later)
  await act(async () => { await sleep(60) })
}

/* ------------------------------------- 1. 三种类型「稍后」创建 → 目录可见 → 进详情 */

section('普通任务「稍后」创建：目录刷到可见后再进详情（创建不广播 task:updated 也能进）')
{
  await mount()
  await composeLater('审查当前仓库的代码结构')
  const state = ui.getState()
  const created = bridge.store.tasks[0]
  ok(!!created, 'Issue/任务已在主进程侧注册')
  ok(state.view === 'detail' && state.activeId === created.id && state.tabs.includes(created.id), '「稍后」创建后自动进入该任务详情（不再弹回列表）')
  ok(bridge.calls.list >= 3, `创建后主动刷新过任务目录（list 调用 ${bridge.calls.list} 次 ≥ 3：挂载+等可见+主动刷）`)
  ok(!!byQuery('.detail-page') && byQuery('.detail-page').textContent.includes(created.title), '详情页渲染出新任务标题')
  ok((byQuery('.workspace-prompt')?.value ?? '') === '', '创建成功后草稿输入框已清空')
  await unmount()
}

section('新建后刷新尚在途时等待目录，首次刷新失败不清空待决导航')
{
  await mount()
  bridge.listScript.push({}, { delayMs: 240 })
  await composeLater('等待目录后打开')
  ok(ui.getState().view === 'issues', '目录刷新在途时保持创建页，不提前进入空详情')
  await act(async () => { await sleep(280) })
  ok(ui.getState().view === 'detail' && !!byQuery('.detail-page'), '收到目录快照后再打开真实详情')
  await unmount()

  bridge.reset()
  bridge.seedTask({ id: 'root', title: 'Root' })
  bridge.seedTask({ id: 'kid', title: 'Kid', parentTaskId: 'root' })
  bridge.listScript.push({ error: '临时目录读取失败' })
  await act(async () => { reactRoot = createRoot(container); reactRoot.render(createElement(App)); await sleep(30) })
  await act(async () => { bridge.fireTaskFocus('kid'); await sleep(30) })
  ok(!ui.isCatalogReady() && ui.getState().tabs.includes('kid'), '读取失败仍是目录未就绪，保留待决任务')
  await act(async () => { bridge.fireTaskUpdated('root'); await sleep(60) })
  ok(ui.isCatalogReady() && ui.getState().activeId === 'root', '目录恢复后解析到正确的根任务')
  await unmount()
}

section('刷新响应乱序：挂载时发出的旧列表快照延迟落地，不抹掉新任务')
{
  bridge.reset()
  bridge.listScript.push({ snapshot: [], delayMs: 200 }) // 挂载那一次 list：创建前的空快照，慢 200ms 才回来
  await act(async () => { reactRoot = createRoot(container); reactRoot.render(createElement(App)) })
  await act(async () => { await sleep(30) })
  await composeLater('给这个项目补一份 README')
  const created = bridge.store.tasks[0]
  ok(ui.getState().view === 'detail' && ui.getState().activeId === created.id, '新任务详情已打开')
  await act(async () => { await sleep(350) }) // 等那份「创建前的旧快照」落地
  ok(ui.getState().view === 'detail' && ui.getState().activeId === created.id, '旧快照落地后被序号判废：详情不弹回、页签不被剪')
  ok(!!byQuery('.detail-page') && byQuery('.detail-page').textContent.includes(created.title), '详情页仍然渲染新任务')
  await unmount()
}

section('目标模式 / 团队会议「稍后」创建：同样先见目录再进详情')
{
  await mount()
  await composeLater('把 docs/ 下的 API 文档全部对齐当前代码', 'goal')
  const goalTask = bridge.store.tasks[0]
  ok(ui.getState().view === 'detail' && ui.getState().activeId === goalTask.id && byQuery('.detail-page')?.textContent.includes(goalTask.title), '目标模式「稍后」创建后进入详情')
  await unmount()

  await mount()
  await composeLater('评审本迭代的技术方案取舍', 'meeting')
  const meetingTask = bridge.store.tasks[0]
  ok(ui.getState().view === 'detail' && ui.getState().activeId === meetingTask.id && byQuery('.detail-page')?.textContent.includes(meetingTask.title), '团队会议「稍后」创建后进入详情')
  await unmount()
}

/* --------------------------------------- 2. task:focus 先于目录到达 → 重路由 + 桶迁移 */

section('task:focus 先于目录到达：乐观页签 → 目录到达后重路由到根详情 + dock 桶迁移')
{
  bridge.reset()
  bridge.seedTask({ id: 'root', title: '领队任务甲' })
  bridge.seedTask({ id: 'kid', title: '队员任务乙', parentTaskId: 'root' })
  bridge.listScript.push({ delayMs: 250 }) // 目录在途（挂载那次 list 慢 250ms）
  await act(async () => { reactRoot = createRoot(container); reactRoot.render(createElement(App)) })
  await act(async () => { await sleep(50) })
  await act(async () => { bridge.fireTaskFocus('kid'); await sleep(10) }) // 主进程在列表还没回到渲染层时就派发聚焦
  ok(ui.getState().view === 'detail' && ui.getState().tabs.join() === 'kid', '目录未加载：focus 请求乐观按普通页签兜底（不丢）')
  await act(async () => { await sleep(400) }) // 目录到达
  const state = ui.getState()
  ok(state.tabs.join() === 'root' && state.activeId === 'root', '目录到达：待决子任务重路由——页签换成根任务并激活')
  ok(state.docks.root?.items.some((item) => item.id === 'task:kid') && !state.docks.kid, '子任务落在根任务的 dock 桶里（自键兜底桶已迁移走）')
  ok(!!byQuery('.detail-page') && byQuery('.detail-page').textContent.includes('领队任务甲'), '详情页渲染根任务')
  const dockTabs = [...container.querySelectorAll('.dock-tabs [role="tab"]')]
  ok(dockTabs.some((node) => node.textContent.includes('队员任务乙')), 'dock 页签条渲染出子任务分页（React 层可见桶迁移）')
  await unmount()
}

section('目录始终缺失的任务：乐观页签被下一份目录收掉，不留僵尸页签')
{
  await mount()
  bridge.seedTask({ id: 'plain', title: '普通任务' }) // mount 会 reset 假桥，种子放在挂载后
  await act(async () => { bridge.fireTaskFocus('ghost'); await sleep(10) }) // 主进程派发了一个渲染层目录里不存在的 id（竞态/已清理）
  await act(async () => { await sleep(30) })
  ok(ui.getState().view === 'detail' && ui.getState().tabs.join() === 'ghost', '先按普通页签兜底打开')
  await act(async () => { bridge.fireTaskUpdated('plain'); await sleep(10) }) // 任意一次任务事件 → 目录刷新，ghost 仍不在
  await act(async () => { await sleep(120) })
  ok(!ui.getState().tabs.includes('ghost') && ui.getState().view === 'issues', '下一份目录仍没有它：乐观页签收掉并回到 Issue 主页')
  await unmount()
}

/* ------------------------------------------------- 3. 快捷键：非模态不封锁，模态避让 */

section('快捷键：菜单（popover）不封锁 Ctrl+N，命令面板（模态）打开时避让')
{
  await mount()
  await act(async () => { ui.focusComposer(); await sleep(30) })
  const prompt = byQuery('.workspace-prompt')
  await click(byQuery('.workspace-switcher')) // 打开工作区切换菜单（popover 层）
  await act(async () => { await sleep(20) })
  ok(!!byQuery('.ws-menu'), '工作区菜单已打开（非模态浮层）')
  const tickBefore = ui.getState().composerTick
  await pressKey('n', { ctrlKey: true })
  ok(ui.getState().composerTick === tickBefore + 1, '菜单打开：Ctrl+N 照常触发（不被浮层封锁）')
  ok(active() === prompt, '聚焦请求落到输入框')
  await pressKey('Escape')
  await act(async () => { await sleep(20) })
  ok(!byQuery('.ws-menu'), 'Escape 关闭菜单')
  await act(async () => { ui.palette.open(); await sleep(30) })
  ok(!!byQuery('.palette'), '命令面板已打开（模态层）')
  const tickInPalette = ui.getState().composerTick
  await pressKey('n', { ctrlKey: true })
  ok(ui.getState().composerTick === tickInPalette, '模态打开：Ctrl+N 让路（composerTick 不动）')
  ok(active() !== prompt && !!byQuery('.palette input') && active() === byQuery('.palette input'), '焦点仍在面板输入框')
  await act(async () => { ui.palette.close(); await sleep(20) })
  await pressKey('n', { ctrlKey: true })
  ok(ui.getState().composerTick === tickInPalette + 1, '面板关闭后 Ctrl+N 恢复')
  await unmount()
}

console.log(`\n${failures === 0 ? '✅ UI DRAFT/CATALOG (REAL APP) SMOKE PASSED' : `❌ ${failures} 项断言失败`}`)
