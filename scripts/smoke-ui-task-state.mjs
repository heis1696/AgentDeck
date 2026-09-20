// 任务状态隔离回归（真实 React DOM + jsdom + 假桥，渲染真实 <App/>）：
// 覆盖 docs/UI-RELIABILITY.md 的「A 任务的追问草稿与历史在切到 B 后仍然可见」以及同源的串味面：
//   1. 草稿/历史：A→B→A 各自取回自己的草稿与历史（不是靠重挂载丢草稿）；
//   2. 忙态：A 的追问还在途时切到 B，B 不被禁用；回到 A 仍在途；A 的响应在 B 的界面上结算也不改 B；
//   3. 重命名：在 A 上编辑标题时切走，编辑框被取消、不落库、也不改到 B 的标题上；B 自己的重命名照常生效；
//   4. 浮层：ℹ 弹层 / 命令菜单 / 目标浮窗与目标芯片都不跟到 B；回到 A 不自行重开，但草稿与芯片各自回来；
//   5. 旧异步响应：A 的 events 快照晚于切任务落地，不得渲染成 B 的回合；切任务当帧也不显示上一个任务的回合。
// 运行：node scripts/smoke-ui-task-state.mjs（jsdom 为既有 devDependency）。
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
// jsdom 没实现 scrollIntoView / scrollTo（回合导航与菜单高亮用）：桩成空操作，生产代码不改
window.Element.prototype.scrollIntoView = function () {}
window.Element.prototype.scrollTo = function () {}
// jsdom 没有 ResizeObserver（ℹ 弹层几何与回合索引用它量尺寸）：桩成空观察者，生产代码不改
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
window.ResizeObserver = ResizeObserverStub
globalThis.ResizeObserver = ResizeObserverStub

/* ----------------------------------------------------------------- 打包夹具 */

const outfile = path.join(root, 'out', 'smoke-ui-task-state.cjs')
const shikiStub = path.join(root, 'scripts', 'fixtures', 'shiki-stub.ts')
const petStub = path.join(root, 'scripts', 'fixtures', 'pet-stub.tsx')
await build({
  entryPoints: [path.join(root, 'scripts', 'fixtures', 'ui-task-state-harness.tsx')],
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

const { act, createElement, createRoot, App, ui, getTaskStateBridge, resetTaskDrafts, taskDraftSlot, ScopedStateProbe, scopedProbe } = await import(pathToFileURL(outfile).href)

/* ------------------------------------------------------------------ 断言器 */

let failures = 0
const ok = (condition, label) => {
  console.log(`  ${condition ? '✓' : '✗'} ${label}`)
  if (!condition) { failures++; process.exitCode = 1 }
}
const section = (title) => console.log(`\n── ${title}`)

const bridge = getTaskStateBridge()
const container = window.document.getElementById('app')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const byQuery = (selector) => container.querySelector(selector)

/** A 有真实回合；B 故意留空 prompt——buildTurns 在无事件且无 prompt 时才是 0 回合，泄漏判据因此是硬的 */
const A_EVENTS = [
  { seq: 1, ts: 1_700_000_000_000, kind: 'user', text: 'A-用户问题' },
  { seq: 2, ts: 1_700_000_000_001, kind: 'text', text: 'A-回答文本' }
]

let reactRoot = null
async function mount(status = 'done', workers = []) {
  bridge.reset()
  resetTaskDrafts()
  window.localStorage.clear()
  bridge.seedTask({ id: 'taskA', title: '任务A', prompt: 'A 的原始指令', status })
  bridge.seedTask({ id: 'taskB', title: '任务B', prompt: '' })
  workers.forEach((status, index) => {
    const worker = bridge.seedTask({ id: `worker-${index}`, title: `Worker ${index}`, status })
    worker.parentTaskId = 'taskA'
    worker.workerIndex = index
    worker.parked = status === 'queued' && index === 0
  })
  bridge.setEvents('taskA', A_EVENTS)
  await act(async () => { reactRoot = createRoot(container); reactRoot.render(createElement(App)) })
  await act(async () => { await sleep(30) })
}
async function unmount() {
  await act(async () => { reactRoot.unmount(); reactRoot = null })
  ui.reset()
}
async function openTask(id) {
  await act(async () => { ui.openTask(id); await sleep(20) })
}
const followBox = () => byQuery('.followup textarea')
const sendButton = () => [...container.querySelectorAll('.followup-row button')].find((node) => node.textContent.trim() === '发送')
const sendingHint = () => byQuery('.followup-hint .is-live')
const logTabCount = () => byQuery('#detail-tab-log .tab-count')?.textContent ?? null
const panel = () => byQuery('#detail-tabpanel')
const titleText = () => byQuery('.task-title-text')?.textContent ?? null
const infoPop = () => byQuery('.meta-info-pop')
const skillMenu = () => byQuery('.skill-menu')
const floatWindow = () => byQuery('.float-window')
const goalChip = () => byQuery('.float-chip.is-goal')
const renameInput = () => byQuery('.title-edit-input')
const workflowSelect = () => byQuery('.meta-workflow')

const typeInto = (node, value) => act(async () => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(node, value)
  node.dispatchEvent(new window.Event('input', { bubbles: true }))
  await sleep(10)
})
const typeIntoInput = (node, value) => act(async () => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(node, value)
  node.dispatchEvent(new window.Event('input', { bubbles: true }))
  await sleep(10)
})
const changeValue = (node, value) => act(async () => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
  setter.call(node, value)
  node.dispatchEvent(new window.Event('change', { bubbles: true }))
  await sleep(10)
})
const click = (node) => act(async () => {
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
  await sleep(10)
})
const keyOn = (node, key, init = {}) => act(async () => {
  node.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
  await sleep(10)
})
/** 断言存在再点：回归重现时后续用例不会被 null.dispatchEvent 打断，整份报告能跑完 */
const clickIfPresent = async (node, label) => {
  ok(!!node, label)
  if (node) await click(node)
  return !!node
}

/* ---------------------------------------- 1. 草稿与历史：A→B→A 各自取回自己的 */

section('追问草稿按任务隔离：A→B→A 各自取回（不是靠重挂载丢草稿）')
{
  await mount()
  await openTask('taskA')
  await typeInto(followBox(), 'A 的草稿')
  ok(followBox().value === 'A 的草稿', 'A 的追问框留下草稿')

  await openTask('taskB')
  ok(followBox().value === '', '切到 B：A 的草稿不再可见（修复前会原样留着）')
  await typeInto(followBox(), 'B 的草稿')

  await openTask('taskA')
  ok(followBox().value === 'A 的草稿', '回到 A：取回 A 自己的草稿')
  await openTask('taskB')
  ok(followBox().value === 'B 的草稿', '再回 B：取回 B 自己的草稿')
  ok(taskDraftSlot('taskA').prompt === 'A 的草稿' && taskDraftSlot('taskB').prompt === 'B 的草稿', '两个任务各存一份草稿（会话内存，未做持久化）')
  await unmount()
}

section('追问历史按任务隔离：B 的 ↑ 翻不出 A 的历史，A 的 ↑ 取回自己的')
{
  await mount()
  await openTask('taskA')
  await typeInto(followBox(), 'A 的历史条目')
  await keyOn(followBox(), 'Enter')
  ok(bridge.calls.followUp.length === 1 && bridge.calls.followUp[0].taskId === 'taskA', 'A 的追问发给了 A')
  ok((window.localStorage.getItem('agentdeck:followup-history:taskA') ?? '').includes('A 的历史条目'), '发送成功入栈到 A 自己的历史（localStorage 键未变）')
  ok(followBox().value === '', '发送后清空输入框')

  await openTask('taskB')
  await keyOn(followBox(), 'ArrowUp')
  ok(followBox().value === '', 'B 的空框按 ↑ 不会翻出 A 的历史（修复前会翻出来）')
  ok((window.localStorage.getItem('agentdeck:followup-history:taskB') ?? '') === '', 'B 没有自己的历史记录')

  await openTask('taskA')
  await keyOn(followBox(), 'ArrowUp')
  ok(followBox().value === 'A 的历史条目', '回到 A：↑ 取回 A 自己的历史')
  await unmount()
}

/* ------------------------------------------------ 2. busy：在途状态不串任务 */

section('忙碌状态按任务隔离：A 在途时切到 B，B 不跟着禁用')
{
  await mount()
  bridge.holdFollowUps = true
  await openTask('taskA')
  await typeInto(followBox(), '在途消息')
  await keyOn(followBox(), 'Enter')
  ok(bridge.calls.followUp.length === 1, 'A 的追问已发出（响应挂起，仍在途）')
  ok(sendButton()?.disabled === true && !!sendingHint(), 'A 在途：发送按钮禁用 + 显示「正在发送…」')
  ok(taskDraftSlot('taskA').busy === true, 'A 的槽位记为在途')

  await openTask('taskB')
  await typeInto(followBox(), 'B 的草稿')
  ok(sendButton()?.disabled === false, 'B 不受 A 在途影响：有自己的草稿就能发送（修复前被 A 的 busy 禁用）')
  ok(!sendingHint(), 'B 不显示「正在发送…」')
  ok(taskDraftSlot('taskB').busy === false, 'B 的槽位不在途')

  await openTask('taskA')
  ok(sendButton()?.disabled === true && !!sendingHint(), '回到 A：A 自己的在途状态仍在（per-task busy，不是一刀切清零）')

  await openTask('taskB')
  await act(async () => { bridge.settleFollowUps({ ok: true }); await sleep(20) })
  ok(taskDraftSlot('taskA').busy === false, 'A 的响应结算：A 的 busy 清掉')
  ok(sendButton()?.disabled === false && !sendingHint(), 'A 的响应落在 B 的界面上，不改 B 的忙碌状态')
  ok(followBox().value === 'B 的草稿', 'B 的草稿也没被 A 的响应清掉')

  // 失败响应同样只作用于出发任务
  bridge.holdFollowUps = true
  await openTask('taskA')
  await typeInto(followBox(), '会失败的消息')
  await keyOn(followBox(), 'Enter')
  await openTask('taskB')
  await act(async () => { bridge.settleFollowUps({ ok: false, error: '追问失败（烟测）' }); await sleep(20) })
  ok(sendButton()?.disabled === false && followBox().value === 'B 的草稿', 'A 的失败响应不影响 B（B 的输入与按钮状态都不变）')
  ok(!container.textContent.includes('追问失败（烟测）') || !!byQuery('.toast'), '失败提示走全局 toast，不写进 B 的追问区')
  await openTask('taskA')
  ok(followBox().value === '会失败的消息', '拒绝追问后原任务仍保留完整草稿')
  ok(!taskDraftSlot('taskA').history.includes('会失败的消息'), '未受理的追问不写入已发送历史')
  await keyOn(followBox(), 'Enter')
  await typeInto(followBox(), '发送期间的新草稿')
  await act(async () => { bridge.settleFollowUps({ ok: true }); await sleep(20) })
  ok(followBox().value === '发送期间的新草稿', '成功响应不会擦除在途期间的新编辑')
  await keyOn(followBox(), 'Enter')
  await typeInto(followBox(), '中间编辑')
  await typeInto(followBox(), '发送期间的新草稿')
  await act(async () => { bridge.settleFollowUps({ ok: true }); await sleep(20) })
  ok(followBox().value === '发送期间的新草稿', '编辑后回到相同文本仍是新草稿，不被旧响应清空')
  await unmount()
}

section('Follow-up guards and complete worker-result access')
{
  await mount('running', ['queued', 'queued', 'running'])
  await openTask('taskA')
  await typeInto(followBox(), '等待本轮结束后的追问')
  ok(sendButton()?.disabled === true, 'Running task disables sending while keeping its draft editable')
  await keyOn(followBox(), 'Enter')
  ok(bridge.calls.followUp.length === 0 && followBox().value === '等待本轮结束后的追问', 'Enter cannot submit or discard a running-task draft')
  const states = byQuery('.workers-live')?.textContent ?? ''
  ok(states.includes('1 执行中') && states.includes('1 排队') && states.includes('1 等待启动'), 'Worker summary distinguishes running, queued and parked')
  await unmount()
  await mount('done', ['done', 'done', 'failed', 'cancelled', 'done'])
  await openTask('taskA')
  ok(container.querySelectorAll('.workers-pane > .workers-list .worker-card').length === 3, 'Finished worker preview stays compact')
  ok(container.querySelectorAll('.workers-more .worker-card').length === 2, 'Every additional finished worker remains available in the disclosure')
  await click(byQuery('.workers-more summary'))
  ok(byQuery('.workers-more').open, 'Finished-worker disclosure can be expanded')
  await click(byQuery('.workers-more .worker-card:last-child'))
  ok(byQuery('.worker-pane')?.textContent.includes('Worker 4'), 'Opening a hidden finished worker reaches its result pane')
  await unmount()
}

section('Activity read failures remain distinct from empty history')
{
  const readComments = window.agentdeck.issues.comments
  try {
    window.agentdeck.issues.comments = async () => { throw new Error('activity unavailable') }
    await mount()
    await openTask('taskA')
    ok(byQuery('.issue-timeline [role=alert]')?.textContent.includes('activity unavailable'), 'Activity failure is visible and recoverable')
    ok(!byQuery('.issue-timeline')?.textContent.includes('暂无动态'), 'Read failure does not look like empty history')
    window.agentdeck.issues.comments = async () => [
      { id: 'old-comment', author: { type: 'agent', id: 'fixture' }, content: 'older update', createdAt: 1000 },
      { id: 'new-comment', author: { type: 'agent', id: 'fixture' }, content: 'newest update', createdAt: 2000 }
    ]
    await click(byQuery('.issue-timeline [role=alert] button'))
    ok(!byQuery('.issue-timeline [role=alert]'), 'Successful retry clears the activity error')
    ok(byQuery('.timeline-comment')?.textContent.includes('newest update'), 'Activity opens on the newest update')
    await unmount()
  } finally { window.agentdeck.issues.comments = readComments }
}

/* ------------------------------------------------- 3. 重命名：编辑会话不串任务 */

section('重命名会话不串任务：A 的编辑草稿不落库、也不改到 B 的标题上')
{
  await mount()
  await openTask('taskA')
  await clickIfPresent(byQuery('.title-edit'), 'A 的重命名按钮可用')
  ok(!!renameInput() && renameInput().value === '任务A', 'A 的重命名输入框打开并带出 A 的标题')
  await typeIntoInput(renameInput(), 'A 改到一半的标题')

  await openTask('taskB')
  ok(!renameInput(), '切到 B：A 的编辑框被取消（不会挂在 B 的标题上）')
  ok(titleText() === '任务B', 'B 的标题不受 A 编辑草稿影响')
  ok(bridge.calls.rename.length === 0, '切换任务不提交重命名（A 的草稿不落库）')
  ok(bridge.store.tasks.find((task) => task.id === 'taskA').title === '任务A', 'A 的标题也没有被切换时的失焦改名')

  if (await clickIfPresent(byQuery('.title-edit'), 'B 自己的重命名按钮可用')) {
    ok(renameInput()?.value === '任务B', 'B 自己的重命名照常可用')
    await typeIntoInput(renameInput(), 'B 改名')
    await keyOn(renameInput(), 'Enter')
    await act(async () => { await sleep(20) })
    ok(bridge.calls.rename.length === 1 && bridge.calls.rename[0].taskId === 'taskB' && bridge.calls.rename[0].title === 'B 改名', 'B 的重命名只提交到 B')
    ok(titleText() === 'B 改名', 'B 的标题已更新')
  }
  await unmount()
}

/* ------------------------------------------- 4. 浮层与目标芯片：不跟到别的任务 */

section('浮层/芯片不串任务：ℹ 弹层、命令菜单、目标浮窗都留在原任务')
{
  await mount()
  bridge.seedGoal('iss_taskA', '把 A 的目标做完')
  await openTask('taskA')
  await act(async () => { await sleep(20) })
  ok(!!goalChip(), 'A 头部显示 A 的目标芯片（GoalPanel 上报）')
  await clickIfPresent(byQuery('.meta-info-btn'), 'A 的 ℹ 按钮可用')
  ok(!!infoPop(), 'A 的 ℹ 弹层打开')
  await typeInto(followBox(), '/')
  ok(!!skillMenu(), 'A 的命令菜单打开')
  await clickIfPresent(goalChip(), 'A 的目标芯片可点开浮窗')
  ok(!!floatWindow(), 'A 的目标浮窗打开')

  await openTask('taskB')
  ok(!infoPop(), '切到 B：ℹ 弹层不跟过来')
  ok(!skillMenu(), '切到 B：命令菜单不跟过来')
  ok(!floatWindow(), '切到 B：目标浮窗不跟过来')
  ok(!goalChip(), '切到 B：不显示 A 的目标芯片（目标属于 A 的 Issue）')
  ok(followBox().value === '', 'B 的追问框不带着 A 的 / 输入')

  await openTask('taskA')
  await act(async () => { await sleep(20) })
  ok(followBox().value === '/', '回到 A：草稿取回')
  ok(!skillMenu(), '回到 A：命令菜单不自行重开（瞬态会话作废，不是恢复）')
  ok(!floatWindow(), '回到 A：目标浮窗不自行重开')
  ok(!!goalChip(), '回到 A：目标芯片由面板重新上报后回来（清空没有把芯片打死）')
  await unmount()
}

/* ------------------------------------- 5. 旧异步响应：不渲染成新任务的回合 */

section('旧 events 响应不串任务：A 的多回合不渲染成 B 的执行记录')
{
  await mount()
  bridge.eventsDelay.set('taskB', 300) // B 自己的快照慢，留出「切过去的当帧」观察窗
  await openTask('taskA')
  await clickIfPresent(byQuery('#detail-tab-log'), '执行记录页签可用')
  ok(Number(logTabCount()) >= 1, `A 的执行记录有真实回合（页签计数 ${logTabCount()}）`)
  ok((panel()?.textContent ?? '').includes('A-回答文本'), 'A 的回合正文渲染在执行记录里')

  await act(async () => { ui.openTask('taskB'); await sleep(10) }) // 10ms < B 的 300ms
  ok(logTabCount() === null, '切到 B 的当帧：不显示 A 的回合数（渲染期结算，不等 B 的快照）')
  ok(!(panel()?.textContent ?? '').includes('A-回答文本'), 'B 的执行记录里没有 A 的正文')
  await act(async () => { await sleep(360) })
  ok(logTabCount() === null && !(panel()?.textContent ?? '').includes('A-回答文本'), 'B 自己的空快照落地后依然没有 A 的回合')

  // A 的快照比切任务更晚回来：迟到的响应不得落到 B 上
  bridge.eventsDelay.set('taskB', 0)
  bridge.eventsDelay.set('taskA', 300)
  await act(async () => { ui.openTask('taskA'); await sleep(10) })
  await openTask('taskB')
  await act(async () => { await sleep(360) }) // A 的旧快照此刻才回来
  ok(logTabCount() === null, 'A 的旧快照晚于切任务落地：不渲染成 B 的回合')

  await act(async () => { ui.openTask('taskA'); await sleep(360) })
  ok(Number(logTabCount()) >= 1, '回到 A：A 自己的快照照常渲染')
  await unmount()
}

/* --------------------------- 6. 异步上报的面板数据：不把 A 的目标挂到 B 头上 */

section('异步上报的面板数据不串任务：B 的目标读取还很慢时，头部不显示 A 的芯片')
{
  await mount()
  bridge.seedGoal('iss_taskA', '把 A 的目标做完')
  await openTask('taskA')
  await act(async () => { await sleep(20) })
  ok(!!goalChip(), 'A 的目标芯片就绪')
  bridge.goalsDelayMs = 200 // B 的 goals.list 慢：面板还拿着 A 的目标，且 onGoal 每次换引用 → 会上报陈旧值
  await act(async () => { ui.openTask('taskB'); await sleep(30) })
  ok(!goalChip(), '切到 B：面板的陈旧回报不会挂成 B 的目标芯片')
  await act(async () => { await sleep(260) })
  ok(!goalChip(), 'B 自己的目标读取回来后依然没有芯片（B 没有目标）')
  await unmount()
}

section('旧工作流响应不覆盖新任务：A 的 Issue 更新晚于切换时仍保持 B 的状态')
{
  await mount()
  bridge.issueUpdateDelay.set('iss_taskA', 300)
  await openTask('taskA')
  await changeValue(workflowSelect(), 'done')
  await openTask('taskB')
  ok(workflowSelect().value === 'todo', '切到 B 后显示 B 自己的工作流状态')
  await act(async () => { await sleep(360) })
  ok(workflowSelect().value === 'todo', 'A 的延迟工作流响应落地后仍不覆盖 B')
  await unmount()
}

section('会议创建失败可重试：失败后不把创建按钮永久置为忙碌')
{
  await mount()
  bridge.meetingCreateError = '会议创建失败（烟测）'
  await openTask('taskA')
  await typeInto(followBox(), '/meeting')
  await keyOn(followBox(), 'Enter')
  await act(async () => { await sleep(20) })
  const meetingTopic = () => byQuery('.meeting-create input')
  const meetingButton = () => byQuery('.meeting-create-btn')
  await typeIntoInput(meetingTopic(), '失败后重试')
  await click(meetingButton())
  ok(meetingButton().disabled === false, '会议创建失败后按钮恢复可用，可再次提交')
  await unmount()
}

section('Retired transient callbacks cannot clear another task or a newer session')
{
  const root = createRoot(container)
  const renderScope = (taskId) => act(async () => { root.render(createElement(ScopedStateProbe, { taskId })) })
  await renderScope('scope-A')
  const staleA = scopedProbe.set
  await renderScope('scope-B')
  await act(async () => scopedProbe.set('B editing'))
  await act(async () => staleA('late A result'))
  ok(scopedProbe.value === 'B editing', 'A callback does not reset B transient state')
  await renderScope('scope-A')
  await act(async () => scopedProbe.set('new A session'))
  await act(async () => staleA('retired A result'))
  ok(scopedProbe.value === 'new A session', 'A/B/A rejects the previous A session callback')
  await act(async () => root.unmount())
}

console.log(`\n${failures === 0 ? '✅ UI TASK STATE (REAL APP) SMOKE PASSED' : `❌ ${failures} 项断言失败`}`)
