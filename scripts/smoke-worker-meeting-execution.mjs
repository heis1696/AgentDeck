#!/usr/bin/env node
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const root = path.resolve(import.meta.dirname, '..')
const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
const { window } = dom
for (const key of ['document', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLButtonElement', 'Node', 'Element', 'Event', 'MouseEvent', 'KeyboardEvent', 'FocusEvent', 'localStorage']) globalThis[key] = window[key]
globalThis.window = window
globalThis.getComputedStyle = window.getComputedStyle.bind(window)
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window)
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window)
globalThis.IS_REACT_ACT_ENVIRONMENT = true
window.matchMedia = (media) => ({ matches: false, media, addEventListener() {}, removeEventListener() {} })
window.HTMLElement.prototype.getClientRects = function () { return [{ width: 100, height: 24 }] }
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
window.ResizeObserver = ResizeObserverStub
globalThis.ResizeObserver = ResizeObserverStub
try { Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true }) } catch {}

const bridgeState = {
  events: [],
  permissions: [{
    requestId: 'permission-1',
    requestToken: 'permission-token',
    toolName: 'Shell',
    reason: 'Allow the command?',
    riskLevel: 'medium',
    options: [{ optionId: 'allow-once', name: '允许一次', response: { decision: 'allow' } }]
  }],
  eventListeners: new Set(),
  permissionListeners: new Set(),
  cancelCalls: [],
  permissionCalls: [],
  fileDiffCalls: [],
  resolveFileDiff: null
}
window.agentdeck = {
  tasks: {
    events: async () => bridgeState.events,
    onEvent: (listener) => { bridgeState.eventListeners.add(listener); return () => bridgeState.eventListeners.delete(listener) },
    onEventsInvalidated: () => () => {},
    onPermission: (listener) => { bridgeState.permissionListeners.add(listener); return () => bridgeState.permissionListeners.delete(listener) },
    pendingPermissions: async () => bridgeState.permissions,
    respondPermission: async (...args) => { bridgeState.permissionCalls.push(args); return { ok: true } },
    cancel: async (...args) => { bridgeState.cancelCalls.push(args); return { ok: true } },
    fileDiff: (...args) => {
      bridgeState.fileDiffCalls.push(args)
      return new Promise((resolve) => { bridgeState.resolveFileDiff = resolve })
    }
  },
  sidecar: { onStatus: () => () => {} }
}

const outfile = path.join(root, 'out/smoke-worker-meeting-execution.cjs')
await build({
  stdin: {
    contents: [
      "export { act, createElement } from 'react'",
      "export { createRoot } from 'react-dom/client'",
      "export { WorkerPane } from './src/renderer/src/components/task/WorkerPane'",
      "export { filterWorkerExecutionEvents, resolveWorkerExecution } from './src/renderer/src/components/task/workerExecution'",
      "export { ui } from './src/renderer/src/ui/interaction-center'"
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

const { act, createElement, createRoot, WorkerPane, filterWorkerExecutionEvents, resolveWorkerExecution, ui } = await import(pathToFileURL(outfile).href)
const event = (seq, kind, text, execution, extra = {}) => ({
  seq,
  ts: 1_700_000_000_000 + seq * 1_000,
  kind,
  text,
  ...(execution === undefined ? {} : { execution }),
  ...extra
})

const scopedEvents = [
  event(1, 'user', 'TURN A QUESTION', { runId: 'run-a', turnId: 'turn-a' }),
  event(2, 'tool', 'Edit', { runId: 'run-a', turnId: 'turn-a' }, { data: { phase: 'result', ok: true, edit: { file: 'meeting-file.ts', additions: 2, deletions: 1, content: 'snapshot source' } } }),
  event(3, 'final', 'TURN A ANSWER', { runId: 'run-a', turnId: 'turn-a' }),
  event(4, 'status', 'LEGACY TURN A EVENT', undefined, { eventId: 'agentdeck:batch:turn-a:4' }),
  event(5, 'user', 'SAME RUN OTHER TURN', { runId: 'run-a', turnId: 'turn-b' }),
  event(6, 'final', 'SAME RUN OTHER TURN ANSWER', { runId: 'run-a', turnId: 'turn-b' }),
  event(7, 'user', 'RUN B TURN A', { runId: 'run-b', turnId: 'turn-a' }),
  event(8, 'final', 'RUN B ANSWER', { runId: 'run-b', turnId: 'turn-a' }),
  event(9, 'status', 'UNSCOPED EVENT SECRET'),
  event(10, 'status', 'INVALID STAMP SECRET', { runId: 'run-a' }, { eventId: 'agentdeck:batch:turn-a:10' }),
  { ...event(11, 'status', 'ID FIELD IS NOT HOST PROOF'), id: 'agentdeck:batch:turn-a:11' }
]

const exactTurn = filterWorkerExecutionEvents(scopedEvents, { runId: 'run-a', turnId: 'turn-a' })
assert.deepEqual(exactTurn.map((item) => item.seq), [1, 2, 3, 4], 'exact Run/Turn includes its stamped events and exact legacy host identity only')
assert.deepEqual(filterWorkerExecutionEvents(scopedEvents, { runId: 'run-a' }).map((item) => item.seq), [1, 2, 3, 5, 6], 'Run-only scope includes only stamped events from that Run')
assert.deepEqual(filterWorkerExecutionEvents(scopedEvents, undefined), [], 'missing execution selector never falls back to session events')
assert.equal(resolveWorkerExecution(scopedEvents, undefined).locatable, false)
assert.equal(resolveWorkerExecution(scopedEvents, { runId: 'run-a', turnId: '' }).locatable, false, 'an explicitly empty Turn selector is not a complete execution identity')
assert.equal(resolveWorkerExecution(scopedEvents, { runId: 'run-a', turnId: 'turn-a' }).missingAssociationCount, 3, 'unknown and incomplete identities are reported without rendering their content')
assert.equal(resolveWorkerExecution(scopedEvents, { runId: 'run-a' }).missingAssociationCount, 4, 'legacy Turn-only identities are reported as incomplete for Run-only scopes')
const multiTurnRun = [...scopedEvents, event(12, 'tool', 'STILL WORKING', { runId: 'run-a', turnId: 'turn-c' })]
const unconfirmedRun = resolveWorkerExecution(multiTurnRun, { runId: 'run-a' })
assert.equal(unconfirmedRun.status, undefined, 'a Turn final cannot prove the whole Run is done')
assert.equal(unconfirmedRun.endedAt, undefined, 'a later tool event cannot become the Run end time')
assert.equal(unconfirmedRun.startedAt, undefined, 'Run start time stays unconfirmed without an authoritative snapshot')
const cancelledRun = resolveWorkerExecution(multiTurnRun, { runId: 'run-a', status: 'cancelled', startedAt: 100, endedAt: 500, error: 'HOST CANCELLED' })
assert.equal(cancelledRun.status, 'cancelled')
assert.equal(cancelledRun.endedAt, 500)
assert.equal(cancelledRun.error, 'HOST CANCELLED')
assert.deepEqual(filterWorkerExecutionEvents([event(12, 'text', 'PREFIX TURN SECRET', undefined, { eventId: 'agentdeck:batch:turn-a:shadow:12' })], { runId: 'run-a', turnId: 'turn-a' }), [], 'legacy host identity must match the exact Turn rather than its prefix')
console.log('✓ pure execution filtering keeps Run/Turn events isolated and refuses fallback')

const host = document.getElementById('app')
let reactRoot
const mount = async (props) => {
  await act(async () => {
    reactRoot = createRoot(host)
    reactRoot.render(createElement(WorkerPane, props))
    await new Promise((resolve) => setTimeout(resolve, 25))
  })
}
const unmount = async () => {
  await act(async () => { reactRoot.unmount(); reactRoot = null })
}
const click = async (node, label) => {
  assert.ok(node, `button exists: ${label}`)
  await act(async () => {
    node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
  })
}
const buttonByText = (text) => [...host.querySelectorAll('button')].find((button) => button.textContent.includes(text))
const task = {
  id: 'member-task',
  title: 'Meeting worker',
  prompt: 'CURRENT TASK PROMPT SECRET',
  workdir: 'C:/workspace',
  backend: 'codex',
  status: 'running',
  createdAt: 1_700_000_000_000,
  startedAt: 1_600_000_000_000,
  endedAt: 1_600_000_010_000,
  result: 'CURRENT TASK RESULT SECRET',
  error: 'CURRENT TASK ERROR SECRET',
  usage: { inputTokens: 123456, outputTokens: 654321 },
  eventCount: scopedEvents.length
}
const onOpenCalls = []
const props = (extra = {}) => ({ taskId: task.id, tasks: [task], onOpen: (id) => onOpenCalls.push(id), ...extra })

bridgeState.events = scopedEvents
await mount(props({ readOnly: true, dockRootId: 'meeting-root', execution: { runId: 'run-a', turnId: 'turn-a', status: 'failed', startedAt: 1_710_000_000_000, endedAt: 1_710_000_005_000, error: 'HISTORICAL EXECUTION ERROR' } }))
let text = host.textContent
assert.match(text, /TURN A QUESTION/)
assert.match(text, /TURN A ANSWER/)
assert.match(text, /LEGACY TURN A EVENT/)
assert.match(text, /HISTORICAL EXECUTION ERROR/)
assert.doesNotMatch(text, /SAME RUN OTHER TURN|RUN B TURN A|RUN B ANSWER|UNSCOPED EVENT SECRET|INVALID STAMP SECRET|CURRENT TASK PROMPT SECRET|CURRENT TASK RESULT SECRET|CURRENT TASK ERROR SECRET|123,456 tokens/)
assert.equal(host.querySelector('.worker-pane-stop'), null, 'read-only mode hides stop')
assert.equal(buttonByText('完整详情'), undefined, 'read-only mode hides task navigation')
assert.equal(host.querySelector('.permission-banner'), null, 'read-only mode hides live permission controls')
assert.equal(host.querySelector('.turn-rewind-inline'), null, 'historical timeline hides rewind operations')
assert.match(host.textContent, /缺少可验证的执行关联/)
assert.deepEqual(onOpenCalls, [], 'meeting mode never navigates to an ordinary task page')
const meetingEdit = host.querySelector('[aria-label^="查看 meeting-file.ts"]')
await click(meetingEdit, 'meeting snapshot tool')
const meetingDock = ui.dock.state('meeting-root')
assert.equal(meetingDock.items.length, 1)
assert.equal(meetingDock.items[0].payload.diffNote, '历史执行：仅显示工具参数快照，未读取当前工作区改动')
assert.equal(bridgeState.fileDiffCalls.length, 0, 'historical tool snapshot never reads the current worktree diff')
console.log('✓ real WorkerPane DOM renders only the selected Turn and snapshot metadata')
await unmount()

await mount(props({ readOnly: true, dockRootId: 'meeting-root', execution: { runId: 'run-a' } }))
text = host.textContent
assert.match(text, /状态未记录/)
assert.match(text, /TURN A QUESTION/)
assert.match(text, /SAME RUN OTHER TURN/)
assert.doesNotMatch(text, /RUN B TURN A|RUN B ANSWER/)
assert.equal(host.querySelector('.turn-rewind-inline'), null, 'Run-only historical mode remains read-only across multiple turns')
console.log('✓ real WorkerPane DOM keeps Run-only history separate from another Run')
await unmount()

await mount(props({ readOnly: true }))
text = host.textContent
assert.match(text, /无法安全定位会议执行记录/)
assert.doesNotMatch(text, /TURN A QUESTION|SAME RUN OTHER TURN|RUN B TURN A|CURRENT TASK PROMPT SECRET/)
assert.equal(host.querySelector('.log.chat'), null, 'unlocatable meeting execution does not mount a session timeline')
assert.equal(host.querySelector('.permission-banner'), null)
console.log('✓ real WorkerPane DOM refuses unlocated session logs and live controls')
await unmount()

bridgeState.events = [event(20, 'tool', 'Edit', { runId: 'normal-run', turnId: 'normal-turn' }, { data: { phase: 'result', ok: true, edit: { file: 'ordinary-file.ts', additions: 3, deletions: 1, content: 'ordinary snapshot' } } })]
bridgeState.resolveFileDiff = null
await mount(props())
text = host.textContent
assert.match(text, /CURRENT TASK PROMPT SECRET/, 'default mode keeps the task prompt fallback')
assert.ok(host.querySelector('.worker-pane-stop'), 'default mode keeps the stop action')
assert.ok(buttonByText('完整详情'), 'default mode keeps full task navigation')
assert.ok(host.querySelector('.permission-banner'), 'default mode keeps permission UI')
await click(buttonByText('允许一次'), 'permission approval')
assert.equal(bridgeState.permissionCalls.length, 1, 'default permission approval still reaches the task bridge')
await click(buttonByText('完整详情'), 'full task navigation')
assert.deepEqual(onOpenCalls, [task.id])

const ordinaryEdit = host.querySelector('[aria-label^="查看 ordinary-file.ts"]')
await click(ordinaryEdit, 'ordinary tool diff')
assert.deepEqual(bridgeState.fileDiffCalls.at(-1), [task.id, 'ordinary-file.ts'])
const ordinaryDockId = `file:${task.id}:20:ordinary-file.ts`
assert.equal(ui.dock.state(task.id).items.some((item) => item.id === ordinaryDockId), true, 'ordinary tool file opens in the task dock')
assert.equal(ui.dock.close(ordinaryDockId, { rootId: task.id }), true)
await act(async () => {
  bridgeState.resolveFileDiff({ ok: true, diff: 'late result', additions: 9, deletions: 0 })
  await new Promise((resolve) => setTimeout(resolve, 5))
})
assert.equal(ui.dock.state(task.id).items.some((item) => item.id === ordinaryDockId), false, 'late diff response cannot reopen a closed dock tab')

await click(buttonByText('停止'), 'ordinary stop')
assert.ok(host.querySelector('[role="dialog"]'), 'default stop opens its confirmation dialog')
await click(host.querySelector('.dialog-footer .danger'), 'confirm ordinary stop')
assert.deepEqual(bridgeState.cancelCalls, [[task.id, '']], 'default stop preserves empty-receipt cancellation behavior')
console.log('✓ ordinary WorkerPane retains task prompt, navigation, stop, permissions, and safe tool diffs')
await unmount()

console.log('Worker meeting execution smoke passed')
