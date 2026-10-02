#!/usr/bin/env node
/**
 * 会议详情页真实 React DOM 冒烟：真实 MeetingDetail / MeetingMemberPane / SideDock
 * 挂在 jsdom + 独立 meetings 夹具桥（只伪造 readTurns/getTurn/memberExecutions 与
 * meetings 控制结果，不解析兼容评论标题）上，覆盖：
 *  - 初次全量分页（增量不带旧序号下界）、实名时间线、完整 Markdown 正文与缺正文明确缺失；
 *  - 固定所选成员不随他人发言切走；显式跟随只跟正式发言，手动选择退出跟随；
 *  - 旧发言按 getTurn 的 Task/Run/Turn 确切定位，缺关联不回退成员最新 Run；
 *  - 关闭侧栏后事件不能重开；重开/跨挂载恢复本会议选择，不串其他会议；
 *  - memberExecutions 乱序与卸载防护；
 *  - 真实停止/删除/插话控制错误、start/resume 长等待不禁用停止、迟到响应不清新草稿；
 *  - 纪要同版本真实票数与行动项显式审批；调查就地只读分栏，全程不挂未限定日志的 WorkerPane。
 *
 * Run directly with: node scripts/smoke-ui-meeting-detail.mjs
 * 已由集成侧注册到 package.json 的 smoke:ui。
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const root = path.resolve(import.meta.dirname, '..')
const dom = new JSDOM('<!doctype html><html><body><div id="app"></div><div id="confirm"></div><div id="toasts"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
const { window } = dom
for (const key of ['document', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLButtonElement', 'Node', 'Element', 'Event', 'MouseEvent', 'KeyboardEvent', 'FocusEvent']) globalThis[key] = window[key]
globalThis.window = window
globalThis.getComputedStyle = window.getComputedStyle.bind(window)
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window)
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window)
globalThis.localStorage = window.localStorage
globalThis.IS_REACT_ACT_ENVIRONMENT = true
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
window.ResizeObserver = ResizeObserverStub
globalThis.ResizeObserver = ResizeObserverStub
window.Element.prototype.getClientRects = function () { return [{ width: 120, height: 20 }] }
window.Element.prototype.scrollIntoView = function () {}

const outfile = path.join(root, 'out/smoke-ui-meeting-detail.cjs')
await build({
  stdin: {
    contents: [
      "import './scripts/fixtures/ui-draft-bridge'",
      "import { useEffect, useState } from 'react'",
      "import { MeetingDetail } from './src/renderer/src/components/meeting/MeetingDetail'",
      "import { bridge } from './src/renderer/src/api'",
      "function MeetingDetailHost({ meetingId, tasks, onDeleted }) {",
      "  const [meeting, setMeeting] = useState(() => JSON.parse(JSON.stringify(bridge.meetings.listSync ? bridge.meetings.listSync() : null)))",
      "  useEffect(() => {",
      "    let alive = true",
      "    void bridge.meetings.get(meetingId).then((next) => { if (alive && next) setMeeting(next) })",
      "    const off = bridge.meetings.onUpdated((next) => { if (alive && next.id === meetingId) setMeeting(JSON.parse(JSON.stringify(next))) })",
      "    return () => { alive = false; off() }",
      "  }, [meetingId])",
      "  if (!meeting) return null",
      "  return <MeetingDetail meeting={meeting} tasks={tasks} onDeleted={onDeleted} />",
      "}",
      "export { act, createElement } from 'react'",
      "export { createRoot } from 'react-dom/client'",
      "export { ui } from './src/renderer/src/ui/interaction-center'",
      "export { ConfirmHost } from './src/renderer/src/ui/Confirm'",
      "export { ToastHost } from './src/renderer/src/ui/Toasts'",
      "export { MeetingDetailHost }",
      "export { getDraftBridge } from './scripts/fixtures/ui-draft-bridge'",
      "export { meetingRootId } from './src/renderer/src/components/meeting/meetingViewState'",
      "export { readMeetingSelection, writeMeetingSelection } from './src/renderer/src/components/meeting/meetingSelection'"
    ].join('\n'),
    resolveDir: root,
    loader: 'tsx'
  },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', 'lucide-react'],
  logLevel: 'silent'
})

const { act, createElement, createRoot, ui, ConfirmHost, ToastHost, MeetingDetailHost, getDraftBridge, meetingRootId, readMeetingSelection, writeMeetingSelection } = await import(pathToFileURL(outfile).href)
const api = window.agentdeck
const fixtureBridge = getDraftBridge()
const host = document.getElementById('app')
let appRoot
let confirmRoot
let toastRoot

const sleep = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))
const settle = async (rounds = 6) => act(async () => { for (let i = 0; i < rounds; i++) await sleep() })
const mount = async (meetingId, tasks, onDeleted = () => {}) => act(async () => {
  appRoot ??= createRoot(host)
  appRoot.render(createElement(MeetingDetailHost, { meetingId, tasks, onDeleted }))
  await sleep()
})
const unmount = async () => act(async () => { appRoot?.render(null); await sleep() })
const click = (node) => act(async () => {
  assert.ok(node, 'click target exists')
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
  await sleep()
})
const fill = (node, value) => act(async () => {
  assert.ok(node, 'fill target exists')
  const prototype = node.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : node.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, value)
  node.dispatchEvent(node.tagName === 'SELECT' ? new window.Event('change', { bubbles: true }) : new window.Event('input', { bubbles: true }))
  await sleep()
})
const toggleCheckbox = (node) => act(async () => {
  assert.ok(node, 'checkbox target exists')
  node.click()
  node.dispatchEvent(new window.Event('change', { bubbles: true }))
  await sleep()
})

/* ------------------------------------------------------------ 夹具数据 */

const AGENT_A = 'agent_a'
const AGENT_B = 'agent_b'
const AGENT_C = 'agent_c'
const AGENT_X = 'agent_x'
const SPEAKER = {
  [AGENT_A]: { name: '报告队长', role: 'reporter', platform: 'zcode' },
  [AGENT_B]: { name: '质疑队长', role: 'critic', platform: 'claude' },
  [AGENT_C]: { name: '综合队长', role: 'designer', platform: 'codex' },
  [AGENT_X]: { name: '孤例队长', role: 'reporter', platform: 'codex' },
  user: { name: '用户', role: '主席', platform: 'user' }
}
const participantsOf = (ids) => ids.map((agentId) => ({
  agentId,
  role: agentId === AGENT_B ? 'critic' : agentId === AGENT_C ? 'designer' : 'reporter',
  officeTaskId: `office_${agentId}`,
  sessionTaskId: `task_member_${agentId.slice(-1)}`
}))

const meetingStore = new Map()
const turnStore = new Map()
const investigationStore = new Map()
const callLog = { readTurns: [], getTurn: [], memberExecutions: [], interject: [], cancel: [], remove: [], approve: [] }
let readTurnsPageLimit = 0
const hangingExecutions = []
const hangingInterjects = []
let executionsScript = []
let interjectScript = []
let cancelScript = []
let deleteScript = []
let startScript = []
let resumeScript = []

const makeTurn = (meetingId, patch) => ({
  id: `sp_${Math.random().toString(36).slice(2, 8)}`,
  meetingId, round: 1, phase: 'report', purpose: 'speech', status: 'done', officeTaskId: '',
  startedAt: Date.now(), ...patch
})
const makeMeeting = (id, patch) => ({
  id, issueId: `iss_${id}`, topic: `会议 ${id}`, participants: participantsOf([AGENT_A, AGENT_B, AGENT_C]),
  status: 'active', round: 1, maxRounds: 6, maxInnerTurns: 3, maxDurationMs: 3_600_000,
  minutes: [], noProgress: 0, noProgressCap: 2, failures: 0, pendingChairNotes: [],
  createdAt: Date.now(), updatedAt: Date.now(), turnVersion: 0, ...patch
})
const turnsOf = (id) => turnStore.get(id) ?? []
const latestVersionOf = (id) => turnsOf(id).reduce((max, turn) => Math.max(max, turn.version ?? 0), 0)
const seedMeeting = (meeting, turns) => {
  turnStore.set(meeting.id, turns)
  const stored = { ...meeting, turnVersion: latestVersionOf(meeting.id) }
  meetingStore.set(meeting.id, stored)
  return stored
}
const broadcast = async (id, patch = {}) => {
  const current = meetingStore.get(id)
  const next = { ...current, ...patch, turnVersion: patch.turnVersion ?? latestVersionOf(id), updatedAt: Date.now() }
  meetingStore.set(id, next)
  await act(async () => { for (const listener of meetingListeners) listener(JSON.parse(JSON.stringify(next))) })
  await settle()
}
const memberExecutionsOf = (id, agentId) => ({
  agentId,
  sessionTaskId: `task_member_${agentId.slice(-1)}`,
  turns: turnsOf(id).filter((turn) => turn.agentId === agentId).map(({ body, ...turn }) => turn),
  investigations: investigationStore.get(`${id}:${agentId}`) ?? []
})

/* ------------------------------------------------------ 夹具桥：meetings 权威面 */

const meetingListeners = new Set()
const originalMeetings = { ...api.meetings }
api.meetings = {
  list: async () => [...meetingStore.values()].map((meeting) => JSON.parse(JSON.stringify(meeting))),
  get: async (id) => { const meeting = meetingStore.get(id); return meeting ? JSON.parse(JSON.stringify(meeting)) : null },
  onUpdated: (listener) => { meetingListeners.add(listener); return () => meetingListeners.delete(listener) },
  onDeleted: () => () => {},
  readTurns: async (id, query = {}) => {
    callLog.readTurns.push({ id, query: { ...query } })
    const afterVersion = query.afterVersion
    const pool = turnsOf(id).filter((turn) => afterVersion === undefined || (turn.version ?? 0) > afterVersion)
    const offset = query.cursor ? Number(query.cursor) : 0
    if (query.cursor && !Number.isFinite(offset)) throw new Error('无效游标')
    const limit = readTurnsPageLimit || query.limit || 64
    const turns = pool.slice(offset, offset + limit).map((turn) => JSON.parse(JSON.stringify(turn)))
    const hasMore = offset + limit < pool.length
    return { meetingId: id, turns, latestVersion: latestVersionOf(id), hasMore, ...(hasMore ? { nextCursor: String(offset + limit) } : {}) }
  },
  getTurn: async (id, turnId) => {
    callLog.getTurn.push({ id, turnId })
    const turn = turnsOf(id).find((item) => item.id === turnId)
    return turn ? JSON.parse(JSON.stringify(turn)) : null
  },
  memberExecutions: async (id, agentId) => {
    callLog.memberExecutions.push({ id, agentId })
    if (executionsScript.length) {
      const script = executionsScript.shift()
      if (script === 'hang') return new Promise((resolve) => hangingExecutions.push({ id, agentId, resolve }))
    }
    return JSON.parse(JSON.stringify(memberExecutionsOf(id, agentId)))
  },
  interject: async (id, note) => {
    callLog.interject.push({ id, note })
    if (interjectScript.length) {
      const script = interjectScript.shift()
      if (script === 'hang') return new Promise((resolve) => hangingInterjects.push({ id, resolve }))
      return script
    }
    return { ok: true }
  },
  cancel: async (id) => {
    callLog.cancel.push(id)
    if (cancelScript.length) {
      const script = cancelScript.shift()
      if (script === 'hang') return new Promise(() => {})
      return script
    }
    return { ok: true }
  },
  delete: async (id) => {
    callLog.remove.push(id)
    if (deleteScript.length) {
      const script = deleteScript.shift()
      if (script === 'hang') return new Promise(() => {})
      return script
    }
    return { ok: true }
  },
  start: async () => {
    if (startScript.length) {
      const script = startScript.shift()
      if (script === 'hang') return new Promise(() => {})
      return script
    }
    return { ok: true }
  },
  pause: async () => ({ ok: true }),
  resume: async () => {
    if (resumeScript.length) {
      const script = resumeScript.shift()
      if (script === 'hang') return new Promise(() => {})
      return script
    }
    return { ok: true }
  },
  approveAction: async (id, index, verdict) => { callLog.approve.push({ id, index, verdict }); return { ok: true } },
  retryMirrors: async () => ({ ok: true }),
  create: originalMeetings.create
}

/* 成员会话任务进任务目录（tasks.get / 目录查找用）；task_vanished 故意不种——
   测「关联的任务缺失时明确标缺失，不伪造」。 */
const seededTaskIds = ['task_member_a', 'task_member_b', 'task_member_c', 'task_member_x', 'task_inv']
for (const taskId of seededTaskIds) {
  fixtureBridge.store.tasks = fixtureBridge.store.tasks.filter((task) => task.id !== taskId)
  fixtureBridge.seedTask({ id: taskId, title: `会议成员会话 ${taskId}`, status: 'running' })
}
const taskList = () => fixtureBridge.store.tasks.filter((task) => seededTaskIds.includes(task.id)).map((task) => ({ ...task }))
api.tasks.events = async (taskId) => taskId === 'task_member_b' ? [
  { taskId, seq: 1, ts: 1001, kind: 'text', text: 'EXACT_OLD_SPEECH_LOG', execution: { runId: 'run_b_2', turnId: 'et_3' } },
  { taskId, seq: 2, ts: 1002, kind: 'text', text: 'WRONG_LATEST_RUN_LOG', execution: { runId: 'run_b_new', turnId: 'et_new' } }
] : taskId === 'task_inv' ? [
  { taskId, seq: 1, ts: 1001, kind: 'text', text: 'EXACT_INVESTIGATION_LOG', execution: { runId: 'run_inv_1', turnId: 'et_inv' } },
  { taskId, seq: 2, ts: 1002, kind: 'text', text: 'WRONG_INVESTIGATION_RUN', execution: { runId: 'run_inv_2', turnId: 'et_inv_2' } }
] : []
const seedCatalog = () => ui.setTasks([
  { id: 'meeting:meeting_a', title: '会议 A' },
  { id: 'meeting:meeting_b', title: '会议 B' },
  ...seededTaskIds.map((id) => ({ id, title: id }))
])

/* ------------------------------------------------------------ 断言器 */

let passed = 0
const check = (condition, label) => {
  console.log(`  ${condition ? 'OK' : 'FAIL'} ${label}`)
  if (!condition) process.exitCode = 1
  else passed++
}
const section = (title) => console.log(`\n── ${title}`)
const text = () => host.textContent
const turnArticles = () => host.querySelectorAll('[data-turn-id]')
const banner = () => host.querySelector('[data-meeting-banner]')?.getAttribute('data-meeting-banner') ?? ''
const pane = () => host.querySelector('[data-member-pane]')?.getAttribute('data-member-pane') ?? null
const execText = (attr) => host.querySelector(`[data-execution-${attr}]`)?.textContent ?? ''

try {
  confirmRoot = createRoot(document.getElementById('confirm'))
  toastRoot = createRoot(document.getElementById('toasts'))
  await act(async () => {
    confirmRoot.render(createElement(ConfirmHost))
    toastRoot.render(createElement(ToastHost))
  })
  seedCatalog()

  const baseMeeting = makeMeeting('meeting_a', { currentTurn: { agentId: AGENT_C, role: 'designer', phase: 'synthesis', startedAt: Date.now() } })
  investigationStore.set(`meeting_a:${AGENT_C}`, [{ taskId: 'task_inv', runId: 'run_inv_1', status: 'running' }])
  seedMeeting(baseMeeting, [
    makeTurn('meeting_a', { id: 'sp_1', sequence: 1, version: 1, agentId: AGENT_A, status: 'done', startedAt: Date.now(),
      body: '保留普通 Issue 的骨架。\n\n```js\nconst keep = true\n```\n\n' + '超长正式正文'.repeat(1000) + '\n\n完整长文尾段可读', sessionTaskId: 'task_member_a', runId: 'run_a_1', executionTurnId: 'et_1',
      speaker: SPEAKER[AGENT_A], delivery: { publicVersion: 0 } }),
    makeTurn('meeting_a', { id: 'ch_1', sequence: 2, version: 2, agentId: 'user', purpose: 'chair', phase: 'challenge', status: 'done', startedAt: Date.now(),
      body: '默认固定我选择的成员。', speaker: SPEAKER.user }),
    makeTurn('meeting_a', { id: 'sp_2', sequence: 3, version: 3, agentId: AGENT_B, phase: 'challenge', status: 'failed', startedAt: Date.now(),
      error: '示例：平台连接中断，未发布正式发言。', sessionTaskId: 'task_member_b', runId: 'run_b_1', executionTurnId: 'et_2', speaker: SPEAKER[AGENT_B] }),
    makeTurn('meeting_a', { id: 'sp_3', sequence: 4, version: 4, agentId: AGENT_B, phase: 'defense', status: 'done', startedAt: Date.now(),
      body: '质疑答复：点击旧发言要定位这条发言的确切执行。', sessionTaskId: 'task_member_b', runId: 'run_b_2', executionTurnId: 'et_3',
      speaker: SPEAKER[AGENT_B], delivery: { publicVersion: 3, chairTurnIds: ['ch_1'] } }),
    makeTurn('meeting_a', { id: 'sp_4', sequence: 5, version: 5, agentId: AGENT_C, phase: 'synthesis', status: 'speaking', startedAt: Date.now(),
      sessionTaskId: 'task_member_c', runId: 'run_c_1', executionTurnId: 'et_4', speaker: SPEAKER[AGENT_C] }),
    makeTurn('meeting_a', { id: 'sp_5', sequence: 6, version: 6, agentId: AGENT_A, round: 2, status: 'pending', startedAt: Date.now(), speaker: SPEAKER[AGENT_A] }),
    makeTurn('meeting_a', { id: 'sp_6', sequence: 7, version: 7, agentId: AGENT_B, phase: 'challenge', status: 'done', startedAt: Date.now(),
      body: '旧记录只有摘要。', speaker: SPEAKER[AGENT_B] }),
    makeTurn('meeting_a', { id: 'sp_7', sequence: 8, version: 8, agentId: AGENT_B, phase: 'defense', status: 'done', startedAt: Date.now(),
      body: '关联任务已被清理的旧发言。', sessionTaskId: 'task_vanished', runId: 'run_b_9', executionTurnId: 'et_9', speaker: SPEAKER[AGENT_B] })
  ])
  readTurnsPageLimit = 3

  section('初次全量分页与实名时间线')
  await mount('meeting_a', taskList())
  await settle(10)
  check(turnArticles().length === 8, `初次全量分页（每页 3 条）读全 8 条记录（实际 ${turnArticles().length}）`)
  check(host.querySelector('[data-meeting-round]')?.getAttribute('data-meeting-round') === '2', '会议概要暂落后时，轮次仍以权威第二轮发言对账，不停留第一轮')
  check(callLog.readTurns.every(({ query }) => query.afterVersion === undefined && !Object.hasOwn(query, 'afterSequence')),
    '初次分页不带版本或序号下界')
  check(text().includes('报告队长') && text().includes('质疑队长') && text().includes('综合队长'), '实名快照显示发言人姓名')
  check(text().includes('用户插话') && text().includes('默认固定我选择的成员。'), '用户插话按用途标注并保留原文')
  check(!!host.querySelector('[data-turn-id="sp_1"] .md-code'), '完整正文按 Markdown 渲染（含代码卡片）')
  check(host.querySelector('[data-turn-id="sp_1"]')?.textContent.length > 4000 && text().includes('完整长文尾段可读'), '超过旧截断上限的正式正文和尾段完整渲染')
  check(host.querySelector('[data-turn-id="sp_2"]')?.getAttribute('data-status') === 'failed' && text().includes('示例：平台连接中断'), '失败气泡显示真实失败原因')
  check(host.querySelector('[data-turn-id="sp_4"]')?.getAttribute('data-status') === 'speaking' && text().includes('正在生成正式发言'), '执行中气泡显示在途说明')
  check(host.querySelector('[data-turn-id="sp_5"]')?.getAttribute('data-status') === 'pending' && text().includes('准备公开上下文'), '准备中气泡显示占位说明')
  check(host.querySelector('[data-turn-id="sp_6"] .mtd-body')?.getAttribute('data-body') === 'markdown', '旧记录有正文时按正文渲染')
  check(banner() === '讨论中' && text().includes('发言水位 v8'), '活跃会议横幅与发言水位如实显示')
  check(!host.querySelector('aside.side-dock'), '默认不抢开侧栏')

  section('固定所选成员：他人开始发言不切走')
  await click(host.querySelector('[data-member="agent_a"]'))
  await settle()
  check(!!host.querySelector('aside.side-dock') && pane() === 'agent_a', '点击成员后侧栏打开并固定该成员')
  check(host.querySelector('[data-member="agent_a"]')?.getAttribute('aria-pressed') === 'true', '成员按钮呈选中态')
  await broadcast('meeting_a', { currentTurn: { agentId: AGENT_B, role: 'critic', phase: 'challenge', startedAt: Date.now() } })
  await act(async () => {
    const turns = turnStore.get('meeting_a')
    const synthesis = turns.find((turn) => turn.id === 'sp_4')
    synthesis.status = 'done'
    synthesis.body = '综合：固定成员侧栏。'
    synthesis.version = 9
    turns.push(makeTurn('meeting_a', { id: 'sp_8', sequence: 9, version: 10, agentId: AGENT_B, phase: 'challenge', status: 'speaking', startedAt: Date.now(), sessionTaskId: 'task_member_b', runId: 'run_b_3', executionTurnId: 'et_5', speaker: SPEAKER[AGENT_B] }))
  })
  await broadcast('meeting_a', { currentTurn: { agentId: AGENT_B, role: 'critic', phase: 'challenge', startedAt: Date.now() } })
  check(pane() === 'agent_a', 'B/C 开始新发言后侧栏仍固定 A')
  const incremental = callLog.readTurns.filter(({ query }) => query.afterVersion !== undefined)
  check(incremental.length >= 1 && incremental.every(({ query }) => !Object.hasOwn(query, 'afterSequence')),
    '增量查询只带版本下界，不附旧序号下界')
  check(turnArticles().length === 9 && text().includes('综合：固定成员侧栏。'), '旧序号发言的更新按稳定 ID 合并进时间线')

  section('跟随只跟正式发言，手动选择退出跟随')
  const followToggle = () => host.querySelector('input[aria-label="跟随当前发言者"]')
  await toggleCheckbox(followToggle())
  await settle()
  check(host.querySelector('[data-mode-label]')?.getAttribute('data-mode-label') === 'follow' && pane() === AGENT_B,
    '开启跟随后对齐当前正式发言者（质疑队长）')
  await click(host.querySelector('[data-member="agent_a"]'))
  await settle()
  check(host.querySelector('[data-mode-label]')?.getAttribute('data-mode-label') === 'fixed' && pane() === 'agent_a',
    '手动选择成员立即退出跟随并固定')
  await broadcast('meeting_a', { currentTurn: { agentId: AGENT_C, role: 'designer', phase: 'synthesis', startedAt: Date.now() } })
  check(pane() === 'agent_a', '退出跟随后新发言不再切走侧栏')

  section('旧发言的确切执行关联（不回退最新 Run）')
  await click(host.querySelector('[data-execution-link="sp_3"]'))
  await settle()
  check(callLog.getTurn.at(-1)?.turnId === 'sp_3' && pane() === AGENT_B, '点击旧发言按该发言定位成员与执行')
  check(execText('task') === 'task_member_b' && execText('run') === 'run_b_2' && execText('turn') === 'et_3', '显示该发言确切的 Task / Run / Turn')
  check(host.querySelector('[data-execution-audit]')?.getAttribute('data-exact') === 'true', '关联完整时标记按确切关联读取')
  check(!host.querySelector('.mtd-execution-metadata')?.open, '默认折叠关联审计，执行正文优先占用阅读空间')
  check(text().includes('EXACT_OLD_SPEECH_LOG') && !text().includes('WRONG_LATEST_RUN_LOG'), '真实 WorkerPane 仅显示旧发言确切 Run/Turn 日志')
  check(!host.querySelector('.worker-pane-stop, .worker-pane-open-text, .permission-prompt'), '成员执行只读隐藏普通任务和权限操作')
  await click(host.querySelector('[data-execution-link="sp_6"]'))
  await settle()
  check(execText('run') === '尚未建立 / 关联缺失' && execText('run') !== 'run_b_3', '旧发言缺 Run 时明确缺失，不回退成员最新 Run')
  check(!!host.querySelector('.mtd-execution-metadata')?.open, '执行关联缺失时自动展开诊断，不因正常折叠策略隐藏失败信息')
  check(host.querySelector('[data-execution-audit]')?.getAttribute('data-exact') === 'false'
    && text().includes('不替换为最新一次'), '关联不完整时审计说明不替换')
  await click(host.querySelector('[data-execution-link="sp_7"]'))
  await settle(8)
  check(execText('task') === 'task_vanished' && text().includes('不回退最新 Run'), '关联任务缺失时按缺失显示（tasks.get 兜底读不到不伪造）')

  section('关闭侧栏：事件不能重开，重开恢复选择')
  await click(host.querySelector('.dock-tab-close'))
  await settle()
  check(!host.querySelector('aside.side-dock'), '用户关闭后侧栏关闭')
  await broadcast('meeting_a', { currentTurn: { agentId: AGENT_C, role: 'designer', phase: 'synthesis', startedAt: Date.now() } })
  check(!host.querySelector('aside.side-dock'), '新发言事件不能重开已关闭的侧栏')
  check(!!host.querySelector('[data-reopen-dock]'), '有关选记录时提供显式重开入口')
  await click(host.querySelector('[data-reopen-dock]'))
  await settle()
  check(!!host.querySelector('aside.side-dock') && pane() === AGENT_B, '重开侧栏恢复本会议所选成员')
  check(host.querySelector('[data-execution-select]')?.value === 'sp_7', '重开恢复选定的旧发言')
  check(readMeetingSelection('meeting_a')?.turnId === 'sp_7', '选择缓存保存选中成员与旧发言')

  section('跨会议/跨挂载不串状态')
  investigationStore.set('meeting_a:agent_c', investigationStore.get('meeting_a:agent_c') ?? [])
  seedMeeting(makeMeeting('meeting_b', { participants: participantsOf([AGENT_X]) }), [
    makeTurn('meeting_b', { id: 'bx_1', sequence: 1, version: 1, agentId: AGENT_X, status: 'done', body: '孤例会议的唯一发言。', speaker: SPEAKER[AGENT_X] })
  ])
  await unmount()
  await mount('meeting_b', taskList())
  await settle()
  check(!host.querySelector('aside.side-dock') && pane() === null, '另一场会议默认不开侧栏，无选择面板')
  check(text().includes('孤例队长') && turnArticles().length === 1, '另一场会议显示自己的时间线')
  await click(host.querySelector('[data-member="agent_x"]'))
  await settle()
  check(pane() === AGENT_X, 'B 会议选择自己的成员')
  await unmount()
  await mount('meeting_a', taskList())
  await settle()
  check(pane() === AGENT_B && host.querySelector('[data-execution-select]')?.value === 'sp_7',
    '跨挂载恢复 A 会议自己的成员与旧发言（不串到 X）')
  check(host.querySelector('[data-member="agent_x"]') === null, 'A 页面不渲染其他会议的成员')

  section('成员执行读取：乱序与卸载防护')
  executionsScript = ['hang']
  await click(host.querySelector('[data-member="agent_a"]'))
  await settle(3)
  await click(host.querySelector('[data-member="agent_c"]'))
  await settle()
  check(pane() === AGENT_C && callLog.memberExecutions.at(-1)?.agentId === AGENT_C, '切换成员立即发起新读取')
  const stale = hangingExecutions.shift()
  await act(async () => { stale.resolve(JSON.parse(JSON.stringify(memberExecutionsOf('meeting_a', AGENT_A)))); await sleep() })
  await settle()
  check(pane() === AGENT_C && execText('task') !== 'task_member_a', '乱序到达的旧成员响应被丢弃')
  executionsScript = ['hang']
  await click(host.querySelector('[data-member="agent_b"]'))
  await act(async () => { await sleep() })
  await unmount()
  const hanging = hangingExecutions.shift()
  await act(async () => { hanging.resolve(JSON.parse(JSON.stringify(memberExecutionsOf('meeting_a', AGENT_B)))); await sleep() })
  check(true, '卸载后的迟到成员响应不致崩溃')
  await mount('meeting_a', taskList())
  await settle()
  check(pane() === AGENT_B && !!host.querySelector('[data-execution-select]'), '重挂后按恢复的选择正常读取')

  section('内部调查就地只读分栏（不跳普通任务页）')
  const tabsBefore = [...ui.getState().tabs]
  const viewBefore = ui.getState().view
  investigationStore.set('meeting_a:agent_c', [{ taskId: 'task_inv', runId: 'run_inv_1', status: 'running' }])
  await click(host.querySelector('[data-member="agent_c"]'))
  await settle()
  await click(host.querySelector('[data-investigation="task_inv"]'))
  await settle()
  check(ui.dock.state(meetingRootId('meeting_a')).items.length === 2, '调查作为第二个分页开在会议 root 桶下')
  check(!!host.querySelector('[data-investigation-pane="task_inv"]') && host.querySelector('[data-investigation-pane="task_inv"]')?.getAttribute('data-investigation-state') === 'directory',
    '调查分栏只读展示目录中的调查任务')
  check(!!host.querySelector('.worker-pane') && text().includes('EXACT_INVESTIGATION_LOG') && !text().includes('WRONG_INVESTIGATION_RUN'), '调查就地复用 WorkerPane 且只显示权威所选 Run')
  check([...ui.getState().tabs].length === tabsBefore.length && ui.getState().view === viewBefore,
    '调查与成员执行不触发普通任务页导航')
  const investigationTask = fixtureBridge.store.tasks.find((task) => task.id === 'task_inv')
  Object.assign(investigationTask, { runId: 'run_inv_1', status: 'cancelled', startedAt: 1001, endedAt: 1005, error: '权威调查取消原因' })
  await mount('meeting_a', taskList())
  await settle()
  check(!!host.querySelector('.worker-pane .status-cancelled') && host.querySelector('.worker-pane')?.textContent.includes('权威调查取消原因'), '调查所选 Run 与任务完全匹配时沿用权威取消状态和错误')
  Object.assign(investigationTask, { runId: 'run_inv_new', status: 'running', error: 'LATEST_RUN_ERROR_SECRET' })
  await mount('meeting_a', taskList())
  await settle()
  check(host.querySelector('.worker-pane')?.textContent.includes('状态未记录') && !text().includes('LATEST_RUN_ERROR_SECRET'), '调查旧 Run 不兜底新 Run 状态或错误')

  section('真实停止状态：stopState 优先于普通终态')
  writeMeetingSelection('meeting_c', null)
  seedMeeting(makeMeeting('meeting_c', { status: 'cancelled', stopState: 'stopping' }), [])
  await unmount()
  await mount('meeting_c', taskList())
  await settle()
  check(banner() === '正在停止' && text().includes('退出确认'), '停止中即使记录已取消也不显示停止成功')
  check(host.querySelector('[data-control="stop"]') === null, '停止中不重复提供停止按钮')
  check(host.querySelector('[data-control="delete"]')?.disabled === true, '未取得退出确认时删除被禁用')
  await unmount()
  writeMeetingSelection('meeting_c', null)
  seedMeeting(makeMeeting('meeting_c', { status: 'cancelled', stopState: 'failed', blockedReason: '仍有执行未取得退出证明' }), [])
  await mount('meeting_c', taskList())
  await settle()
  check(banner() === '停止受阻' && host.querySelector('[data-control="stop"]')?.textContent.includes('重试停止'), '停止受阻显示受阻原因并允许重试停止')
  check(host.querySelector('[data-control="delete"]')?.disabled === true, '停止受阻时不可删除')
  await unmount()
  writeMeetingSelection('meeting_c', null)
  seedMeeting(makeMeeting('meeting_c', { deleting: true }), [])
  await mount('meeting_c', taskList())
  await settle()
  check(banner() === '正在删除' && host.querySelector('[data-control="delete"]')?.disabled === true, '删除进行中显示删除横幅并禁用按钮')

  section('停止失败如实报错，确认前不调用')
  writeMeetingSelection('meeting_d', null)
  const deletedIds = []
  seedMeeting(makeMeeting('meeting_d', { currentTurn: { agentId: AGENT_A, role: 'reporter', phase: 'report', startedAt: Date.now() } }), [
    makeTurn('meeting_d', { id: 'dx_1', sequence: 1, version: 1, agentId: AGENT_A, status: 'done', body: 'D 会议发言。', speaker: SPEAKER[AGENT_A] })
  ])
  await mount('meeting_d', taskList(), (id) => deletedIds.push(id))
  await settle()
  await click(host.querySelector('[data-control="stop"]'))
  const stopDialog = () => document.querySelector('.confirm-dialog')
  check(!!stopDialog() && stopDialog().textContent.includes('停止整场会议') && stopDialog().textContent.includes('独立咨询办公室'), '停止确认说明整场范围且不含咨询办公室')
  check(callLog.cancel.length === 0, '确认前不调用停止')
  await click([...stopDialog().querySelectorAll('.dialog-footer .btn')][0])
  await settle()
  check(callLog.cancel.length === 0, '取消确认不调用停止')
  cancelScript = [{ ok: false, error: '仍有执行未取得退出证明' }]
  await click(host.querySelector('[data-control="stop"]'))
  await click([...stopDialog().querySelectorAll('.dialog-footer .btn')][1])
  await settle()
  check(callLog.cancel.length === 1 && [...document.querySelectorAll('.toast-error')].some((node) => node.textContent.includes('退出证明')),
    '停止失败如实报错（不显示停止成功）')
  check(banner() === '讨论中', '停止失败后横幅仍是讨论中')

  section('start/resume 长等待不禁用停止/删除')
  resumeScript = ['hang']
  writeMeetingSelection('meeting_d', null)
  seedMeeting(makeMeeting('meeting_d', { status: 'waiting_user' }), turnsOf('meeting_d'))
  await unmount()
  await mount('meeting_d', taskList())
  await settle()
  await click(host.querySelector('[data-control="resume"]'))
  await settle(3)
  check(host.querySelector('[data-control="resume"]')?.disabled === true, '继续点击后自身禁用（IPC 等整场结束）')
  check(host.querySelector('[data-control="stop"]')?.disabled === false, 'resume 等待期间停止仍可用')
  check(host.querySelector('[data-control="delete"]')?.disabled === false, 'resume 等待期间删除仍可用')
  await broadcast('meeting_d', { status: 'active' })
  check(host.querySelector('[data-control="resume"]') === null && host.querySelector('[data-control="pause"]') !== null,
    '转入 active 后释放继续占用（不等 IPC 返回）')
  check(host.querySelector('[data-control="stop"]')?.disabled === false, 'active 后停止仍可用')
  startScript = ['hang']
  writeMeetingSelection('meeting_e', null)
  seedMeeting(makeMeeting('meeting_e', { status: 'draft' }), [])
  await unmount()
  await mount('meeting_e', taskList())
  await settle()
  await click(host.querySelector('[data-control="start"]'))
  await settle(3)
  check(host.querySelector('[data-control="start"]')?.disabled === true && host.querySelector('[data-control="delete"]')?.disabled === false,
    '启动等待期间开始禁用而删除不受影响')

  section('删除成功清缓存，失败不假删')
  writeMeetingSelection('meeting_d', null)
  seedMeeting(makeMeeting('meeting_d', { currentTurn: { agentId: AGENT_A, role: 'reporter', phase: 'report', startedAt: Date.now() } }), turnsOf('meeting_d'))
  await unmount()
  await mount('meeting_d', taskList(), (id) => deletedIds.push(id))
  await settle()
  await click(host.querySelector('[data-member="agent_a"]'))
  await settle()
  await click(host.querySelector('[data-control="delete"]'))
  check(!!stopDialog() && stopDialog().textContent.includes('已批准的独立行动项'), '删除确认说明保留范围')
  deleteScript = [{ ok: false, error: '删除受阻：仍有执行未退出' }]
  await click([...stopDialog().querySelectorAll('.dialog-footer .btn')][1])
  await settle()
  check([...document.querySelectorAll('.toast-error')].some((node) => node.textContent.includes('删除受阻')) && deletedIds.length === 0, '删除失败报错且不回调 onDeleted')
  deleteScript = [{ ok: true }]
  await click(host.querySelector('[data-control="delete"]'))
  await click([...stopDialog().querySelectorAll('.dialog-footer .btn')][1])
  await settle()
  check(deletedIds.length === 1 && deletedIds[0] === 'meeting_d', '删除成功后回调宿主 onDeleted')
  check(ui.dock.state(meetingRootId('meeting_d')).items.length === 0 && readMeetingSelection('meeting_d') === null,
    '删除成功后清空本会议侧栏缓存与选择')

  section('插话：迟到响应不清空期间编辑，草稿跨会议隔离')
  writeMeetingSelection('meeting_f', null)
  seedMeeting(makeMeeting('meeting_f'), [
    makeTurn('meeting_f', { id: 'fx_1', sequence: 1, version: 1, agentId: AGENT_A, status: 'done', body: 'F 会议发言。', speaker: SPEAKER[AGENT_A] })
  ])
  await unmount()
  await mount('meeting_f', taskList())
  await settle()
  const note = () => host.querySelector('textarea')
  interjectScript = ['hang']
  await fill(note(), '第一条意见')
  await click(host.querySelector('[data-interject-send]'))
  await settle(3)
  check(host.querySelector('[data-interject-state]')?.getAttribute('data-interject-state') === 'pending', '插话发送中显示在途状态')
  await fill(note(), '发送期间改写的第二条')
  hangingInterjects[0].resolve({ ok: true })
  await settle()
  check(note().value === '发送期间改写的第二条', '迟到的成功响应不清空期间编辑的新插话')
  interjectScript = [{ ok: false, error: '会议已进入停止流程' }]
  await click(host.querySelector('[data-interject-send]'))
  await settle()
  check(host.querySelector('[data-interject-state]')?.getAttribute('data-interject-state') === 'error' && note().value === '发送期间改写的第二条',
    '发送失败显示原因并保留草稿')
  interjectScript = ['hang']
  await click(host.querySelector('[data-interject-send]'))
  await settle(3)
  assert.equal(hangingInterjects.length, 2, '第二条插话在途')
  await unmount()
  writeMeetingSelection('meeting_g', null)
  seedMeeting(makeMeeting('meeting_g', { currentTurn: { agentId: AGENT_A, role: 'reporter', phase: 'report', startedAt: Date.now() } }), [
    makeTurn('meeting_g', { id: 'gx_1', sequence: 1, version: 1, agentId: AGENT_A, status: 'done', body: 'G 会议发言。', speaker: SPEAKER[AGENT_A] })
  ])
  await mount('meeting_g', taskList())
  await settle()
  await fill(note(), '新会议里编辑的草稿')
  hangingInterjects[1].resolve({ ok: true })
  await settle()
  check(note().value === '新会议里编辑的草稿', '上一场会议迟到的插话响应不影响新会议草稿')

  section('纪要同版本真实票数与行动项显式审批')
  writeMeetingSelection('meeting_h', null)
  seedMeeting(makeMeeting('meeting_h', {
    status: 'concluded', stopReason: 'converged',
    minutes: [{
      round: 2, summary: '固定成员侧栏，按确切发言关联定位执行。', decisions: [], objections: [], openQuestions: [],
      provenance: 'consensus:advisory', version: 'min_2',
      confirmations: [
        { agentId: AGENT_A, turnId: 'ca', minutesVersion: 'min_2', contextVersion: 7, chairTurnIds: [], verdict: 'agree' },
        { agentId: AGENT_B, turnId: 'cb', minutesVersion: 'min_2', contextVersion: 7, chairTurnIds: [], verdict: 'agree' },
        { agentId: AGENT_C, turnId: 'cc', minutesVersion: 'min_1', contextVersion: 5, chairTurnIds: [], verdict: 'agree' }
      ],
      actionItems: [{ title: '回归旧会议夹具', ownerAgentId: AGENT_A, acceptance: ['smoke 通过'], approval: 'pending' }]
    }]
  }), [])
  await mount('meeting_h', taskList())
  await settle()
  const confirmChip = () => host.querySelector('[data-minutes-confirm]')?.textContent ?? ''
  check(confirmChip().includes('2 / 3') && confirmChip().includes('min_2'), '纪要只统计绑定当前版本的真实同意票')
  check(!confirmChip().startsWith('3'), '旧版本同意票不计入当前版本')
  await click(host.querySelector('[data-action-reject="0"]'))
  await settle()
  check(callLog.approve.some(({ id, verdict }) => id === 'meeting_h' && verdict === 'rejected'), '拒绝直接以 rejected 提交（不启动任务）')
  await click(host.querySelector('[data-action-approve="0"]'))
  const approveDialog = () => document.querySelector('.confirm-dialog')
  check(!!approveDialog() && approveDialog().textContent.includes('释放已停放的任务并立即开始执行'), '批准前显式确认启动后果')
  check(!callLog.approve.some(({ verdict }) => verdict === 'approved'), '确认前不调用批准')
  await click([...approveDialog().querySelectorAll('.dialog-footer .btn')][1])
  await settle()
  check(callLog.approve.some(({ id, verdict }) => id === 'meeting_h' && verdict === 'approved'), '确认后以 approved 提交')
  section('会议插话键盘：Enter 发送，Shift/IME 不误发')
  seedMeeting(makeMeeting('meeting_keyboard', { status: 'active' }), [])
  await mount('meeting_keyboard', taskList())
  await settle()
  const composer = host.querySelector('textarea')
  await fill(composer, '键盘发送的主席要求')
  const interjectBefore = callLog.interject.length
  await act(async () => {
    composer.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))
    composer.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }))
    await sleep()
  })
  check(callLog.interject.length === interjectBefore, 'Shift+Enter 与 IME 组合 Enter 不误发插话')
  await act(async () => { composer.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep() })
  check(callLog.interject.at(-1)?.id === 'meeting_keyboard' && callLog.interject.at(-1)?.note === '键盘发送的主席要求', 'Enter 按当前会议范围发送插话')
  check(composer.value === '', '未编辑的新草稿仅在发送成功后清空')
} finally {
  for (const id of ['meeting_a', 'meeting_b', 'meeting_c', 'meeting_d', 'meeting_e', 'meeting_f', 'meeting_g', 'meeting_h', 'meeting_keyboard']) writeMeetingSelection(id, null)
  Object.assign(api.meetings, originalMeetings)
  await act(async () => {
    appRoot?.render(null)
    confirmRoot?.unmount()
    toastRoot?.unmount()
  })
  ui.reset()
  dom.window.close()
}

if (process.exitCode) process.exit(1)
console.log(`\nUI MEETING DETAIL SMOKE PASSED: ${passed} checks`)
