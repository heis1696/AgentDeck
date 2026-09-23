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
window.matchMedia = () => ({ matches: false, media: '', onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false } })
window.Element.prototype.getClientRects = function () { return [{ x: 0, y: 0, width: 240, height: 28, top: 0, left: 0, right: 240, bottom: 28 }] }
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
window.ResizeObserver = ResizeObserverStub
globalThis.ResizeObserver = ResizeObserverStub

const outfile = path.join(root, 'out', 'smoke-ui-workflow-batch-a.cjs')
const shikiStub = path.join(root, 'scripts', 'fixtures', 'shiki-stub.ts')
const petStub = path.join(root, 'scripts', 'fixtures', 'pet-stub.tsx')
await build({
  entryPoints: [path.join(root, 'scripts', 'fixtures', 'ui-batch-a-harness.tsx')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
  plugins: [
    { name: 'stub-shiki', setup(build) { build.onResolve({ filter: /^shiki(\/|$)/ }, () => ({ path: shikiStub })) } },
    { name: 'stub-pet', setup(build) { build.onResolve({ filter: /pet\/Pet(Stage|SettingsPage)$/ }, () => ({ path: petStub })) } }
  ],
  logLevel: 'silent'
})

const { act, createElement, createRoot, App, ui, getDraftBridge } = await import(pathToFileURL(outfile).href)
const bridge = getDraftBridge()
const container = document.getElementById('app')
const DAY = 86_400_000
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const active = () => document.activeElement
const query = (selector) => container.querySelector(selector)
const all = (selector) => [...container.querySelectorAll(selector)]
const click = (node) => act(async () => { node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })); await sleep(20) })
const input = async (node, value) => act(async () => {
  const setter = Object.getOwnPropertyDescriptor(node instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype, 'value').set
  setter.call(node, value)
  node.dispatchEvent(new window.Event('input', { bubbles: true }))
  await sleep(20)
})
const key = (node, value, options = {}) => act(async () => { node.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options })); await sleep(20) })
bridge.reset()
const now = Date.now()
for (let i = 0; i < 25; i++) {
  const task = bridge.seedTask({ id: `task-${i}`, title: `Catalog task ${i}`, prompt: `prompt-${i}`, workdir: `C:/workspace/${i}`, status: i === 24 ? 'queued' : i % 3 === 0 ? 'done' : 'queued' })
  const stamp = now - i * DAY
  task.createdAt = stamp
  task.startedAt = i % 3 === 0 ? stamp : undefined
  task.endedAt = i % 3 === 0 ? stamp + 1_000 : undefined
  const issue = bridge.store.issues.find((candidate) => candidate.taskId === task.id)
  if (issue) { issue.createdAt = stamp; issue.updatedAt = stamp; issue.identifier = `ISS-CATALOG-${i}` }
}
const historical = bridge.seedTask({ id: 'task-history', title: 'Historical execution', prompt: 'same issue, later execution', workdir: 'C:/workspace/history', status: 'done' })
historical.issueId = 'iss_task-0'
Object.assign(historical, { createdAt: now - 500, startedAt: now - 400, endedAt: now - 100 })
bridge.store.issues = bridge.store.issues.filter((issue) => issue.taskId !== historical.id)
bridge.store.agents = [
  { id: 'ag_forge', name: 'Forge Agent', backend: 'zcode', color: '#999' },
  ...Array.from({ length: 20 }, (_, i) => ({ id: `agent-${i}`, name: `Long named execution Agent ${i}`, role: i === 0 ? '领队' : '执行者', backend: i % 2 ? 'codex' : 'zcode', model: `model-${i}`, color: '#3aa99f', ...(i === 0 ? { presetId: 'preset-1' } : {}) }))
]
bridge.store.presets = [{ id: 'preset-1', name: 'Smoke preset', baseURL: 'https://example.test', apiKey: 'smoke-key-1234', createdAt: now }]

let appRoot = null
ui.reset()
ui.focusComposer()
await act(async () => { appRoot = createRoot(container); appRoot.render(createElement(App)); await sleep(100) })
assert.equal(all('.issue-recent-task').length, 6, 'Issue home keeps recent history compact')
assert.equal(new Set(all('.issue-recent-task').map((row) => row.querySelector('.issue-recent-title')?.textContent)).size, 6, 'Issue home shows one row per Issue')
assert.ok(!all('.issue-recent-title').some((title) => title.textContent === 'Historical execution'), 'historical execution does not create a duplicate Issue row')
assert.ok(query('.issue-recent-all'), 'Issue home exposes all-task recovery')
assert.equal(all('.agent-pick').length, 0, 'Agent roster is no longer an unbounded button grid')
assert.ok(query('.agent-picker-trigger'), 'Issue composer has a compact Agent value')

await act(async () => { ui.palette.open(); await sleep(30) })
const paletteInput = query('.palette-input')
assert.ok(paletteInput, 'command search opens')
await input(paletteInput, 'ISS-CATALOG-24')
assert.equal(all('.palette-item').length, 1, 'search scans the full task catalog and matches Issue identifiers')
assert.match(all('.palette-item')[0].textContent, /Catalog task 24/)
await key(paletteInput, 'Enter')
assert.equal(ui.getState().activeId, 'task-24', 'selecting a parked task opens its detail')
assert.equal(bridge.calls.start, 0, 'opening a parked task never starts execution')

await act(async () => { ui.navigate('issues'); await sleep(40) })
const pickerTrigger = query('.agent-picker-trigger')
pickerTrigger.focus()
await click(pickerTrigger)
assert.equal(all('.agent-picker-option').length, 20, 'Forge Agent is excluded from picker options')
const pickerSearch = query('.agent-picker-search input')
await input(pickerSearch, 'Long named execution Agent 19')
assert.equal(all('.agent-picker-option').length, 1, 'Agent picker filters long rosters')
await key(pickerSearch, 'Enter')
assert.equal(active(), pickerTrigger, 'Agent picker returns focus to its trigger')
assert.match(pickerTrigger.textContent, /Long named execution Agent 19/)

await act(async () => { ui.navigate('board'); await sleep(80) })
assert.match(query('.board-day-head-date').textContent, /全部日期/)
assert.equal(query('.board-day-nav-select').value, 'all', 'board starts with all retained dates')
assert.equal(all('.board-day-nav-select option').length, 26, 'date choices cover the retained catalog')
const boardSearch = query('.issues-search input')
await input(boardSearch, 'does-not-exist')
assert.ok(query('.board-filter-reset'), 'filtered empty state exposes one-action recovery')
await click(query('.board-filter-reset'))
assert.equal(query('.issues-search input').value, '', 'reset clears search scope')
assert.equal(all('.board-card').length, 25, 'reset restores the complete board catalog without duplicate Issue executions')

await act(async () => { ui.navigate('agents'); await sleep(60) })
const agentFilter = query('.tm-filter input')
assert.ok(agentFilter, 'Agent management exposes a roster filter')
await input(agentFilter, 'backend-that-does-not-exist')
assert.ok(query('.tm-empty-filtered'), 'Agent filter distinguishes no matches from an empty roster')
await input(agentFilter, 'codex')
assert.ok(all('.tm-section:first-of-type .tm-card').every((card) => card.textContent.includes('codex')), 'Agent filter searches backend metadata')
await input(agentFilter, '')
const agentCard = all('.tm-section:first-of-type .tm-card').find((card) => card.textContent.includes('Long named execution Agent 1'))
assert.ok(agentCard, 'long-named Agent remains reachable after clearing the filter')
await click(agentCard.querySelector('.tm-act-danger'))
assert.ok(query('.confirm-dialog'), 'Agent deletion requires confirmation')
await click(query('.confirm-dialog .btn:not(.danger)'))
assert.equal(bridge.calls.agentSave, 0, 'cancelling Agent deletion does not write')
await click(agentCard.querySelector('.tm-act-danger'))
await click(query('.confirm-dialog .btn.danger'))
assert.equal(bridge.calls.agentSave, 1, 'confirmed Agent deletion writes once')

const presetCard = all('.tm-section')[1].querySelector('.tm-card')
assert.ok(presetCard, 'preset fixture is visible')
await click(presetCard.querySelector('.tm-act-danger'))
assert.match(query('.confirm-dialog').textContent, /1 个 Agent/, 'preset deletion names affected Agent count')
await click(query('.confirm-dialog .btn:not(.danger)'))
assert.equal(bridge.calls.presetSave, 0, 'cancelling preset deletion does not write')
await click(presetCard.querySelector('.tm-act-danger'))
await click(query('.confirm-dialog .btn.danger'))
assert.equal(bridge.calls.presetSave, 1, 'confirmed preset deletion writes once')
assert.equal(bridge.store.presets.length, 0, 'confirmed preset deletion removes the preset')

console.log('WORKFLOW BATCH A SMOKE PASSED: full catalog search, parked-task open, deduped recents, Agent picker, all-date board, Agent filtering and deletion confirmations')
await act(async () => appRoot.unmount())
dom.window.close()
