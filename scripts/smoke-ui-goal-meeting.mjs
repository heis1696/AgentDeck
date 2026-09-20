#!/usr/bin/env node
/**
 * Batch C component behavior smoke: real GoalPanel/MeetingPanel/MeetingCard
 * mounted in React DOM with an isolated bridge fixture.
 *
 * Run directly with: node scripts/smoke-ui-goal-meeting.mjs
 * This is intentionally not registered in package.json; package scripts are
 * shared integration-owned files.
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const root = path.resolve(import.meta.dirname, '..')
const dom = new JSDOM('<!doctype html><html><body><div id="app"></div><div id="confirm"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
const { window } = dom
for (const key of ['document', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLButtonElement', 'Node', 'Element', 'Event', 'MouseEvent', 'KeyboardEvent', 'FocusEvent', 'localStorage']) globalThis[key] = window[key]
globalThis.window = window
globalThis.getComputedStyle = window.getComputedStyle.bind(window)
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window)
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window)
globalThis.IS_REACT_ACT_ENVIRONMENT = true
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
window.Element.prototype.getClientRects = function () { return [{ width: 120, height: 20 }] }

const outfile = path.join(root, 'out/smoke-ui-goal-meeting.cjs')
await build({
  stdin: {
    contents: [
      "import './scripts/fixtures/ui-draft-bridge'",
      "export { act, createElement, Fragment } from 'react'",
      "export { createRoot } from 'react-dom/client'",
      "export { ui } from './src/renderer/src/ui/interaction-center'",
      "export { ConfirmHost } from './src/renderer/src/ui/Confirm'",
      "export { GoalPanel } from './src/renderer/src/components/goal/GoalPanel'",
      "export { MeetingPanel } from './src/renderer/src/components/meeting/MeetingPanel'",
      "export { MeetingCard } from './src/renderer/src/components/meeting/MeetingCard'"
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

const { act, createElement, createRoot, ui, ConfirmHost, GoalPanel, MeetingPanel, MeetingCard } = await import(pathToFileURL(outfile).href)
const api = window.agentdeck
const host = document.getElementById('app')
const confirmHost = document.getElementById('confirm')
let appRoot
let confirmRoot

const sleep = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))
const settle = async (rounds = 3) => act(async () => { for (let i = 0; i < rounds; i++) await sleep() })
const mount = async (Component, props) => act(async () => {
  appRoot ??= createRoot(host)
  appRoot.render(createElement(Component, props))
  await sleep()
})
const unmount = async () => act(async () => { appRoot?.render(null); await sleep() })
const click = (node) => act(async () => { assert(node, 'click target exists'); node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })); await sleep() })
const fill = (node, value) => act(async () => {
  assert(node, 'fill target exists')
  const prototype = node.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, value)
  node.dispatchEvent(new window.Event('input', { bubbles: true }))
})
const pressEnter = (node) => act(async () => { node.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await sleep() })

const goalListeners = new Set()
const goalDeletedListeners = new Set()
const meetingListeners = new Set()
const original = {
  goals: { ...api.goals },
  meetings: { ...api.meetings },
  agents: { ...api.agents }
}
let goalRows = []
let meetingRows = []
let goalListError = null
let meetingListError = null
const goalCalls = { list: 0, cancel: 0 }
const meetingCalls = { list: 0, interject: 0, cancel: 0, approve: [] }

api.goals.list = async () => {
  goalCalls.list++
  if (goalListError) throw new Error(goalListError)
  return goalRows.map((goal) => ({ ...goal }))
}
api.goals.onUpdated = (listener) => { goalListeners.add(listener); return () => goalListeners.delete(listener) }
api.goals.onDeleted = (listener) => { goalDeletedListeners.add(listener); return () => goalDeletedListeners.delete(listener) }
api.goals.cancel = async (id) => {
  goalCalls.cancel++
  const goal = goalRows.find((item) => item.id === id)
  if (goal) { goal.status = 'cancelled'; goal.stopReason = 'user_cancel'; goal.blockedReason = 'Cancelled by user'; for (const listener of goalListeners) listener({ ...goal }) }
  return { ok: true }
}
api.meetings.list = async () => {
  meetingCalls.list++
  if (meetingListError) throw new Error(meetingListError)
  return meetingRows.map((meeting) => ({ ...meeting, participants: meeting.participants.map((participant) => ({ ...participant })), minutes: meeting.minutes.map((minute) => ({ ...minute, actionItems: minute.actionItems.map((item) => ({ ...item })) })) }))
}
api.meetings.onUpdated = (listener) => { meetingListeners.add(listener); return () => meetingListeners.delete(listener) }
api.meetings.interject = async () => { meetingCalls.interject++; return { ok: false, error: '主席意见暂不可发送' } }
api.meetings.cancel = async () => { meetingCalls.cancel++; return { ok: true } }
api.meetings.approveAction = async (_id, index, verdict) => { meetingCalls.approve.push({ index, verdict }); return { ok: true } }

const now = Date.now()
const task = { id: 'task-batch-c', title: 'Batch C fixture', workdir: 'C:\\fixture', backend: 'zcode', status: 'queued', eventCount: 0 }
const makeGoal = (patch = {}) => ({ id: 'goal-c', issueId: 'issue-c', text: '验证目标流程', completionConditions: ['smoke passes'], stopConditions: [], maxRuns: 3, maxDurationMs: 60_000, status: 'active', runCount: 1, totalDurationMs: 1_000, currentRunId: 'run-c', createdAt: now, updatedAt: now, ...patch })
const makeMeeting = (patch = {}) => ({ id: 'meeting-c', issueId: 'issue-c', topic: '验证会议流程', participants: [{ agentId: 'agent_c1', role: 'reporter' }, { agentId: 'agent_c2', role: 'critic' }, { agentId: 'agent_c3', role: 'designer' }], status: 'active', round: 1, maxRounds: 2, maxInnerTurns: 3, maxDurationMs: 60_000, minutes: [], noProgress: 0, noProgressCap: 2, failures: 0, pendingChairNotes: [], createdAt: now, updatedAt: now, ...patch })

const check = (condition, label) => {
  console.log(`  ${condition ? 'OK' : 'FAIL'} ${label}`)
  if (!condition) process.exitCode = 1
}

try {
  confirmRoot = createRoot(confirmHost)
  await act(async () => confirmRoot.render(createElement(ConfirmHost)))

  goalRows = []
  goalListError = 'goal store unavailable'
  await mount(GoalPanel, { task, issueId: 'issue-c', open: true, onToggle() {}, onGoal() {} })
  await settle()
  check(host.querySelector('[data-goal-state="error"]'), 'goal read failure is distinct and does not open creation')
  check(!host.querySelector('.dialog'), 'goal creation stays disabled after initial read failure')

  goalListError = null
  await click(host.querySelector('[data-goal-state="error"] button'))
  await settle()
  check(host.querySelector('[data-goal-state="empty"]'), 'goal retry recovers to known empty state')
  check(host.querySelector('.dialog'), 'creation opens only after a successful empty read')
  await unmount()
  ui.reset()

  goalRows = [makeGoal({ runCount: 3, maxRuns: 3, currentRunId: undefined, stopReason: 'run_budget', blockedReason: 'Goal run budget exhausted (3/3)' })]
  await mount(GoalPanel, { task, issueId: 'issue-c', open: true, onToggle() {}, onGoal() {} })
  await settle()
  check(host.textContent.includes('已达到最大轮数'), 'goal stop reason is readable')
  check(![...host.querySelectorAll('button')].some((button) => button.textContent.includes('重试')), 'exhausted goal has no retry action')
  await click(host.querySelector('[title^="取消目标"]'))
  check(document.querySelector('.confirm-dialog')?.textContent.includes('保留'), 'goal cancellation explains retained records')
  check(goalCalls.cancel === 0, 'cancel is not called before confirmation')
  await click(document.querySelector('.confirm-dialog .btn.danger'))
  await settle()
  check(goalCalls.cancel === 1, 'confirmed goal cancellation calls bridge once')
  await unmount()
  ui.reset()

  meetingRows = []
  meetingListError = 'meeting store unavailable'
  await mount(MeetingPanel, { issueId: 'issue-c', open: true, onToggle() {}, onMeeting() {} })
  await settle()
  check(host.querySelector('[data-meeting-state="error"]'), 'meeting read failure is distinct')
  check(!host.querySelector('.meeting-create'), 'meeting creation stays disabled after initial read failure')
  meetingListError = null
  await click(host.querySelector('[data-meeting-state="error"] button'))
  await settle()
  check(host.querySelector('[data-meeting-state="empty"]'), 'meeting retry recovers to known empty state')
  check(host.querySelector('.meeting-create-btn')?.textContent.includes('创建并开始'), 'meeting creation names its start consequence')
  await unmount()
  ui.reset()

  const activeMeeting = makeMeeting()
  let resolveInterject
  api.meetings.interject = () => {
    meetingCalls.interject++
    return new Promise((resolve) => { resolveInterject = resolve })
  }
  await mount(MeetingCard, { meeting: activeMeeting, agents: original.agents.list ? await original.agents.list() : [], run: (action) => action() })
  const noteInput = host.querySelector('input[aria-label="主席插话"]')
  await fill(noteInput, '第一条意见')
  await click(host.querySelector('[title="发送插话"]'))
  await fill(noteInput, '用户后来改写的意见')
  await click(host.querySelector('.meeting-interject button'))
  check(meetingCalls.interject === 1, 'duplicate interjection is rejected while the first request is pending')
  check(host.querySelector('[data-interject-state="pending"]'), 'interjection exposes pending state')
  resolveInterject({ ok: true })
  await settle()
  check(noteInput.value === '用户后来改写的意见', 'successful interjection does not erase newer draft edits')
  check(meetingCalls.interject === 1, 'duplicate interjection click is guarded')
  await unmount()

  api.meetings.interject = async () => { meetingCalls.interject++; return { ok: false, error: '主席意见被会议状态拒绝' } }
  await mount(MeetingCard, { meeting: activeMeeting, agents: await original.agents.list(), run: (action) => action() })
  const failedNote = host.querySelector('input[aria-label="主席插话"]')
  await fill(failedNote, '失败后仍需修改的意见')
  await click(host.querySelector('[title="发送插话"]'))
  await settle()
  check(failedNote.value === '失败后仍需修改的意见' && host.querySelector('[data-interject-state="error"]'), 'rejected interjection keeps its draft and reports failure')
  await unmount()

  const waitingMeeting = makeMeeting({ status: 'waiting_user' })
  const interjectBeforeWaiting = meetingCalls.interject
  api.meetings.interject = async () => { meetingCalls.interject++; return { ok: true } }
  await mount(MeetingCard, { meeting: waitingMeeting, agents: await original.agents.list(), run: (action) => action() })
  await fill(host.querySelector('input[aria-label="主席插话"]'), '等待中的意见')
  await pressEnter(host.querySelector('input[aria-label="主席插话"]'))
  check(meetingCalls.interject === interjectBeforeWaiting, 'waiting meeting Enter does not send interjection')
  await unmount()

  await mount(MeetingCard, { meeting: activeMeeting, agents: await original.agents.list(), run: (action) => action() })
  await click(host.querySelector('[title^="取消会议"]'))
  check(document.querySelector('.confirm-dialog')?.textContent.includes('停止当前会议'), 'meeting cancellation explains active task consequence')
  check(meetingCalls.cancel === 0, 'meeting cancel waits for confirmation')
  await click(document.querySelector('.confirm-dialog .btn'))
  check(meetingCalls.cancel === 0, 'cancelled confirmation does not call bridge')
  await unmount()
  ui.reset()

  const actionItem = { title: '执行发布检查', ownerAgentId: 'agent_c1', acceptance: ['npm run typecheck passes', '发布清单已核对'], approval: 'pending', taskId: 'parked-c' }
  const concludedMeeting = makeMeeting({ status: 'concluded', stopReason: 'converged', minutes: [{ round: 1, summary: '已达成共识', decisions: [], objections: [], actionItems: [actionItem], openQuestions: [], provenance: 'consensus:advisory' }] })
  await mount(MeetingCard, { meeting: concludedMeeting, agents: await original.agents.list(), run: (action) => action() })
  check(host.textContent.includes('负责人：甲队长') && host.textContent.includes('验收条件：npm run typecheck passes；发布清单已核对'), 'action item shows assignee and acceptance criteria')
  const approve = [...host.querySelectorAll('button')].find((button) => button.textContent.includes('批准并开始执行'))
  await click(approve)
  check(document.querySelector('.confirm-dialog')?.textContent.includes('释放已停放的任务并立即开始执行'), 'approval confirmation states start consequence')
  check(meetingCalls.approve.length === 0, 'approval waits for confirmation')
  await click(document.querySelector('.confirm-dialog .btn.primary'))
  await settle()
  check(meetingCalls.approve.some((call) => call.verdict === 'approved'), 'confirmed approval uses approved verdict')
  await unmount()
  ui.reset()

  const rejectMeeting = makeMeeting({ id: 'meeting-reject', status: 'concluded', minutes: [{ round: 1, summary: '待复核', decisions: [], objections: [], actionItems: [{ ...actionItem, approval: 'pending' }], openQuestions: [], provenance: 'consensus:advisory' }] })
  await mount(MeetingCard, { meeting: rejectMeeting, agents: await original.agents.list(), run: (action) => action() })
  await click([...host.querySelectorAll('button')].find((button) => button.textContent.trim() === '拒绝'))
  await settle()
  check(meetingCalls.approve.some((call) => call.verdict === 'rejected'), 'rejecting an action item never uses the start approval verdict')
  await unmount()
} finally {
  Object.assign(api.goals, original.goals)
  Object.assign(api.meetings, original.meetings)
  Object.assign(api.agents, original.agents)
  await act(async () => { appRoot?.render(null); confirmRoot?.unmount() })
  ui.reset()
  dom.window.close()
}

if (process.exitCode) process.exit(1)
console.log('\nUI GOAL/MEETING SMOKE PASSED')
