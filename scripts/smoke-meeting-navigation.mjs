import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const root = path.resolve(import.meta.dirname, '..')
const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
const { window } = dom
for (const key of ['document', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLButtonElement', 'Node', 'Element', 'Event', 'MouseEvent', 'KeyboardEvent', 'FocusEvent', 'localStorage']) globalThis[key] = window[key]
globalThis.window = window
globalThis.getComputedStyle = window.getComputedStyle.bind(window)
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window)
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window)
globalThis.IS_REACT_ACT_ENVIRONMENT = true
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
window.Element.prototype.getClientRects = () => [{ width: 120, height: 20 }]
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
window.ResizeObserver = ResizeObserverStub
globalThis.ResizeObserver = ResizeObserverStub

const outfile = path.join(root, 'out/smoke-meeting-navigation.cjs')
await build({
  stdin: { contents: [
    "export * from './scripts/fixtures/ui-draft-harness'",
    "export { createInteractionCenter, rootTabsOf } from './src/renderer/src/ui/interaction-center'",
    "export { meetingNavigationCatalog, meetingNavigationEntries } from './src/renderer/src/components/meeting/meetingViewState'",
    "export { buildMeetingBoardTree } from './src/renderer/src/components/BoardView'"
  ].join('\n'), resolveDir: root, loader: 'tsx' },
  outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
  plugins: [
    { name: 'stub-shiki', setup(builder) { builder.onResolve({ filter: /^shiki(\/|$)/ }, () => ({ path: path.join(root, 'scripts/fixtures/shiki-stub.ts') })) } },
    { name: 'stub-pet', setup(builder) { builder.onResolve({ filter: /pet\/Pet(Stage|SettingsPage)$/ }, () => ({ path: path.join(root, 'scripts/fixtures/pet-stub.tsx') })) } }
  ], logLevel: 'silent'
})
const { act, createElement, createRoot, App, ui, getDraftBridge, createInteractionCenter, rootTabsOf, meetingNavigationCatalog, meetingNavigationEntries, buildMeetingBoardTree } = await import(pathToFileURL(outfile).href)
const fixture = getDraftBridge()
const api = window.agentdeck
const host = document.getElementById('app')
const sleep = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))
const settle = () => act(async () => { await sleep(30) })
const click = (element) => act(async () => { assert(element, 'click target exists'); element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await sleep(20) })
let checks = 0
const check = (condition, label) => { assert(condition, label); checks++; console.log(`PASS ${label}`) }
const updatedListeners = new Set()
const deletedListeners = new Set()
let meetings = []
let listDelay = 0
let listError = null
api.meetings.list = async () => { if (listError) throw new Error(listError); const snapshot = structuredClone(meetings); await sleep(listDelay); return snapshot }
api.meetings.get = async (id) => structuredClone(meetings.find((meeting) => meeting.id === id) ?? null)
api.meetings.onUpdated = (callback) => { updatedListeners.add(callback); return () => updatedListeners.delete(callback) }
api.meetings.onDeleted = (callback) => { deletedListeners.add(callback); return () => deletedListeners.delete(callback) }
api.meetings.readTurns = async (id) => ({ meetingId: id, turns: [], latestVersion: 0, hasMore: false })
api.meetings.memberExecutions = async () => null
const meeting = (id, issueId, patch = {}) => ({
  id, issueId, topic: `会议 ${id}`, ownsIssue: true, status: 'draft', participants: [],
  rounds: [], turns: [], minutes: [], pendingChairNotes: [], round: 0, maxRounds: 3,
  maxInnerTurns: 10, createdAt: Date.now(), updatedAt: Date.now(), turnVersion: 0, ...patch
})
const container = fixture.seedTask({ id: 'container', title: '公开会议 Issue' })
Object.assign(container, { meetingId: 'owned', meetingTaskRole: 'container' })
const internal = fixture.seedTask({ id: 'member', title: '不可公开的成员执行', parentTaskId: container.id })
Object.assign(internal, { meetingId: 'owned', meetingTaskRole: 'member', suppressIssue: true })
const investigation = fixture.seedTask({ id: 'investigation', title: '不可公开的调查', parentTaskId: internal.id })
Object.assign(investigation, { meetingId: 'owned', meetingTaskRole: 'investigation', suppressIssue: true })
const office = fixture.seedTask({ id: 'office', title: '独立咨询办公室' })
const plain = fixture.seedTask({ id: 'plain', title: '普通 Issue 保持原页' })
fixture.store.issues = fixture.store.issues.filter((issue) => !['member', 'investigation'].includes(issue.taskId))
fixture.store.issues.push({ ...fixture.store.issues[0], id: 'iss_history', taskId: 'removed_container', title: '容器已删除的历史会议' })
meetings = [meeting('owned', container.issueId, { containerTaskId: container.id }), meeting('history', 'iss_history', { containerTaskId: 'removed_container', status: 'concluded' }), meeting('attached', plain.issueId, { ownsIssue: false })]
const catalog = meetingNavigationCatalog(fixture.store.tasks, meetings, fixture.store.issues)
const center = createInteractionCenter()
center.openTask('container')
const handle = center.dock.open({ id: 'file-old', kind: 'file', title: '历史文件', payload: { taskId: 'container', file: 'old.ts', additions: 1, deletions: 0 } })
center.setTasks(catalog)
check(center.getState().tabs.join() === 'meeting:owned' && center.getState().activeId === 'meeting:owned', '目录到达后容器别名收敛到稳定会议页签')
check(center.getState().docks['meeting:owned']?.items[0]?.token === handle.token && !center.getState().docks.container, '旧容器 dock 迁入会议根并保留打开 token')
center.dock.close('file-old', { rootId: 'meeting:owned' })
center.setTasks(catalog)
check(!center.getState().docks['meeting:owned']?.items.length, '关闭的文件不会因目录刷新复活')
center.openTask('iss_history')
check(center.getState().activeId === 'meeting:history', '无容器历史通过稳定 Issue 别名打开')
const beforeInternal = center.getState()
check(center.openTask('member') === 'ignored' && center.openTask('investigation') === 'ignored' && center.getState() === beforeInternal, '内部成员与调查 focus 不导航也不打开侧栏')
center.openTask('plain')
check(center.getState().activeId === 'plain', '非专属附加会议不劫持普通 Issue')
center.openTask('office')
check(center.getState().activeId === 'office', '独立咨询办公室保持普通页签')
center.openTask('meeting:attached')
check(center.getState().activeId === 'meeting:attached', '附加会议可通过显式会议入口查看')
check(rootTabsOf(catalog, ['container', 'member', 'meeting:owned', 'office']).join() === 'meeting:owned,office', '页签仅保留会议根与普通咨询')
const entries = meetingNavigationEntries(fixture.store.tasks, meetings, fixture.store.issues)
check(entries.some((task) => task.id === 'meeting:history') && !entries.some((task) => ['container', 'member', 'investigation'].includes(task.id)), '搜索与 Issue 列表统一公开会议目录，无内部任务泄漏')
const tree = buildMeetingBoardTree(fixture.store.tasks, fixture.store.issues, meetings)
check(tree.roots.filter((node) => node.task.id.startsWith('meeting:')).length === 3 && tree.roots.some((node) => node.task.id === 'plain'), '看板包含无容器会议并保留普通 Issue')
center.reset()
ui.navigate('issues')
let appRoot = createRoot(host)
try {
  await act(async () => { appRoot.render(createElement(App)); await sleep(60) })
  await settle()
  await settle()
  check(host.textContent.includes('容器已删除的历史会议'), '真实 App 的最近列表显示无容器历史会议')
  const recentHistory = [...host.querySelectorAll('.issue-recent-task')].find((element) => element.textContent.includes('容器已删除的历史会议'))
  assert(recentHistory, JSON.stringify({ state: ui.getState(), rows: [...host.querySelectorAll('.issue-recent-task')].map((element) => element.textContent) }))
  await click(recentHistory?.querySelector('button'))
  check(ui.getState().activeId === 'meeting:history' && host.querySelector('[data-meeting-detail="history"]'), '最近入口进入独立会议页而非普通任务详情')
  await act(async () => { ui.navigate('issues'); await sleep(20) })
  await click(host.querySelector('.issue-pill-main'))
  check(ui.getState().activeId === 'meeting:history' && host.querySelector('.meeting-detail'), '已打开胶囊恢复同一会议根')
  await act(async () => { ui.navigate('board'); await sleep(40) })
  const historyCard = host.querySelector('[data-task-id="meeting:history"]')
  check(historyCard && historyCard.draggable === false && !historyCard.querySelector('.board-card-start'), '历史会议卡只导航，不允许拖拽或普通任务启动')
  await click(historyCard?.querySelector('.board-card-open'))
  check(ui.getState().activeId === 'meeting:history' && host.querySelector('.meeting-detail'), '看板历史入口进入同一独立会议')
  await act(async () => { ui.palette.open(); await sleep(20) })
  await act(async () => {
    const input = host.querySelector('.palette input')
    assert(input)
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, '容器已删除')
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    await sleep(20)
  })
  const historyCommand = [...host.querySelectorAll('[role="option"]')].find((element) => element.textContent.includes('容器已删除的历史会议'))
  check(historyCommand && !host.querySelector('.palette')?.textContent.includes('不可公开的成员执行'), '命令搜索包含历史会议且隐藏内部执行')
  await click(historyCommand)
  check(ui.getState().activeId === 'meeting:history' && host.querySelector('.meeting-detail'), '搜索入口进入同一独立会议')
  await act(async () => { fixture.fireTaskFocus('container'); await sleep(20) })
  check(ui.getState().activeId === 'meeting:owned' && host.querySelector('[data-meeting-detail="owned"]'), '主进程容器 focus 正确转入独立会议')
  await act(async () => { fixture.fireTaskFocus('member'); fixture.fireTaskFocus('investigation'); await sleep(20) })
  check(ui.getState().activeId === 'meeting:owned' && !host.querySelector('.side-dock'), '内部执行 focus 不抢页签或侧栏')
  await act(async () => { fixture.fireTaskFocus('plain'); await sleep(20) })
  check(ui.getState().activeId === 'plain' && !host.querySelector('.meeting-detail') && host.querySelector('.detail'), '普通 Issue 仍使用真实 TaskDetail')
  await act(async () => { ui.openTask('meeting:attached'); await sleep(20) })
  check(host.querySelector('[data-meeting-detail="attached"]'), '非专属会议显式入口不依赖容器')
  await act(async () => { for (const callback of deletedListeners) callback('attached'); await sleep(20) })
  check(!ui.getState().tabs.includes('meeting:attached'), '删除广播只移除所属会议根')
  await act(async () => { appRoot.unmount(); await sleep() })
  appRoot = null
  ui.reset()
  listDelay = 100
  fixture.listScript.push({ delayMs: 100 })
  appRoot = createRoot(host)
  await act(async () => { appRoot.render(createElement(App)); await sleep(15); fixture.fireTaskFocus('member'); await sleep(15) })
  check(!host.querySelector('.worker-pane'), '目录未就绪时不展示内部任务的无范围日志')
  await act(async () => { await sleep(150) })
  check(!ui.getState().tabs.includes('member') && !host.querySelector('.worker-pane'), '目录到达后清除待决内部 focus，不变成普通任务页')
  await act(async () => { appRoot.unmount(); await sleep() })
  appRoot = null
  ui.reset()
  listDelay = 0
  listError = '会议目录首次失败夹具'
  fixture.seedTask({ id: 'ordinary_child', title: '普通委派仍路由到领队', parentTaskId: 'plain' })
  const legacy = fixture.seedTask({ id: 'legacy_investigation', title: '旧调查不能导航', parentTaskId: 'missing_legacy_parent' })
  Object.assign(legacy, { suppressIssue: true, trigger: 'meeting' })
  Object.assign(office, { officeAgentId: 'independent_agent', suppressIssue: true, trigger: 'meeting' })
  appRoot = createRoot(host)
  await act(async () => { appRoot.render(createElement(App)); await sleep(30) })
  await settle()
  await act(async () => { fixture.fireTaskFocus('ordinary_child'); await sleep(20) })
  check(ui.getState().activeId === 'plain' && ui.dock.state('plain').items.some((item) => item.payload.taskId === 'ordinary_child'), '会议目录首次失败不冻结普通任务拓扑，子任务仍进领队侧栏')
  const focused = ui.getState().activeId
  await act(async () => { fixture.fireTaskFocus('member'); fixture.fireTaskFocus('legacy_investigation'); await sleep(20) })
  check(ui.getState().activeId === focused && !ui.getState().tabs.includes('legacy_investigation') && !ui.getState().tabs.includes('member'), '目录失败时新旧内部执行 focus 都不抢导航')
  await act(async () => { fixture.fireTaskFocus('office'); await sleep(20) })
  check(ui.getState().activeId === 'office', '旧调查隐藏规则不一刀切拦截独立咨询办公室')
  await act(async () => { ui.openTask('meeting:history'); await sleep(20); fixture.fireTaskUpdated('plain'); await sleep(20) })
  check(ui.getState().activeId === 'meeting:history' && ui.getState().tabs.includes('meeting:history') && !host.querySelector('.meeting-detail'), '尚未解析的历史会议入口保留且不回退普通任务页')
  check(host.querySelector('[data-meetings-retry]') && host.textContent.includes(listError), '会议目录错误提供宿主级显式重试')
  listError = null
  await click(host.querySelector('[data-meetings-retry]'))
  await settle()
  check(host.querySelector('[data-meeting-detail="history"]') && !host.querySelector('[data-meetings-retry]'), '宿主重试恢复权威目录和先前会议入口')
  check(fixture.calls.start === 0, '导航全程不调用普通任务启动')
  console.log(`MEETING NAVIGATION SMOKE PASSED: ${checks} checks`)
} finally {
  await act(async () => { appRoot?.unmount(); await sleep() })
  ui.reset()
  dom.window.close()
}
