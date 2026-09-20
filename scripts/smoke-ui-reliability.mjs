import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const root = path.resolve(import.meta.dirname, '..')
const dom = new JSDOM('<!doctype html><div id="app"></div>', { url: 'http://localhost', pretendToBeVisual: true })
const { window } = dom
for (const key of ['document', 'HTMLElement', 'HTMLInputElement', 'Node', 'Element', 'Event', 'MouseEvent', 'KeyboardEvent', 'localStorage']) globalThis[key] = window[key]
globalThis.window = window
globalThis.getComputedStyle = window.getComputedStyle.bind(window)
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window)
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window)
globalThis.IS_REACT_ACT_ENVIRONMENT = true
window.matchMedia = (media) => ({ matches: false, media, addEventListener() {}, removeEventListener() {} })
window.HTMLElement.prototype.getClientRects = function () { return [{ width: 100, height: 24 }] }

const emptyApi = {
  agents: { list: async () => [], save: async (list) => list },
  presets: { list: async () => [], save: async (list) => list, newId: async () => 'preset-test', models: async () => ({ backend: 'zcode', source: 'catalog', models: [] }) },
  settings: { get: async () => ({}), set: async (patch) => patch, onUpdated: () => () => {} }
}
window.agentdeck = emptyApi

const outfile = path.join(root, 'out/smoke-ui-reliability.cjs')
await build({
  stdin: {
    contents: "import './scripts/fixtures/ui-visual-bridge'; export { act, createElement } from 'react'; export { createRoot } from 'react-dom/client'; export { AgentsView, canPersistList } from './src/renderer/src/components/AgentsView'; export { SettingsView, validateTuningValue } from './src/renderer/src/components/SettingsView'; export { UsageView } from './src/renderer/src/components/UsageView'; export { WorkspaceView } from './src/renderer/src/components/WorkspaceView';",
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

const { act, createElement, createRoot, AgentsView, SettingsView, UsageView, WorkspaceView, canPersistList, validateTuningValue } = await import(pathToFileURL(outfile).href)
assert.equal(canPersistList('loading', [], false), false)
assert.equal(canPersistList('error', [{ id: 'existing' }], false), false)
assert.equal(canPersistList('ready', null, false), false)
assert.equal(canPersistList('ready', [], true), false)
assert.equal(canPersistList('ready', [], false), true)

assert.match(validateTuningValue('', 1, 10), /请输入数值/)
assert.match(validateTuningValue('1.5', 1, 10), /整数/)
assert.match(validateTuningValue('11', 1, 10), /1 到 10/)
assert.equal(validateTuningValue('10', 1, 10), null)
assert.equal(validateTuningValue('0', 0, 10), null)

const api = window.agentdeck
const original = Object.fromEntries(['agents', 'presets', 'settings', 'analytics'].map((key) => [key, { ...api[key] }]))
const unhandled = []
const onUnhandled = (error) => unhandled.push(String(error))
process.on('unhandledRejection', onUnhandled)
const host = document.getElementById('app')
let reactRoot
const mount = async (Component, props = {}) => {
  await act(async () => { reactRoot = createRoot(host); reactRoot.render(createElement(Component, props)) })
}
const unmount = async () => {
  await act(async () => { reactRoot.unmount() })
  for (const key of Object.keys(original)) Object.assign(api[key], original[key])
}
const click = (node) => act(async () => {
  assert(node, 'click target exists')
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
})
const fill = (node, value) => act(async () => {
  const prototype = node.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, value)
  node.dispatchEvent(new window.Event('input', { bubbles: true }))
})
const blur = (node) => act(async () => { node.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true })) })
const retry = () => [...host.querySelectorAll('button')].find((node) => node.textContent.trim() === '重试')

try {
  // Real page: unread lists cannot be saved; successful retry preserves existing entries.
  const existing = (await original.agents.list()).map((agent, i) => ({ ...agent, presetId: i === 0 ? 'p1' : i === 1 ? 'p2' : undefined }))
  const presets = ['p1', 'p2'].map((id) => ({ id, name: id, backend: 'zcode', baseURL: 'https://example.test', apiKey: 'fixture-only', createdAt: 1 }))
  const saves = []
  const presetSaves = []
  let finishSave
  api.agents.list = async () => { throw new Error('agents unavailable') }
  api.presets.list = async () => { throw new Error('presets unavailable') }
  api.agents.save = (list) => { saves.push(list); return new Promise((resolve) => { finishSave = resolve }) }
  api.presets.save = async (list) => { presetSaves.push(list); return list }
  await mount(AgentsView)
  assert(host.textContent.includes('Agent 加载失败'))
  assert(host.textContent.includes('预设加载失败'))
  assert.equal(host.querySelector('.view-header-count'), null)
  assert([...host.querySelectorAll('.view-header-actions button')].every((button) => button.disabled))
  assert.equal(saves.length, 0)
  api.agents.list = async () => existing
  api.presets.list = async () => presets
  await click(retry())
  await click(retry())
  assert.equal(host.querySelector('.view-header-count').textContent, String(existing.length))
  await click(host.querySelector('.view-header-actions .primary'))
  await fill(host.querySelector('.dialog input'), 'New fixture agent')
  const saveButton = host.querySelector('.dialog-footer .primary')
  await act(async () => {
    saveButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    saveButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
  assert.equal(saves.length, 1, 'duplicate submits are excluded while a save is pending')
  assert(saveButton.disabled)
  assert.equal(saves[0].length, existing.length + 1)
  assert.deepEqual(saves[0].slice(0, existing.length), existing)
  await act(async () => finishSave(saves[0]))
  assert.equal(host.querySelector('.dialog'), null)
  api.agents.save = async (list) => { saves.push(list); return list }
  const presetCard = [...host.querySelectorAll('.tm-card')].find((node) => node.querySelector('.tm-name')?.textContent === 'p1')
  await click(presetCard.querySelector('.tm-act-danger'))
  assert.equal(saves.at(-1).length, existing.length + 1, 'removing a preset must not delete agents')
  assert.equal(saves.at(-1)[0].presetId, undefined)
  assert.equal(saves.at(-1)[1].presetId, 'p2', 'unrelated preset bindings survive')
  assert.deepEqual(presetSaves.at(-1).map((item) => item.id), ['p2'])
  await unmount()
  console.log('PASS real Agent page: failed reads, retry, write gating, complete snapshots and preset references')

  // Usage: first failure is not zero usage; late range responses never win.
  const report = await original.analytics.summary()
  api.analytics.summary = async () => { throw new Error('usage unavailable') }
  await mount(UsageView)
  assert(host.textContent.includes('统计加载失败'))
  assert.equal(host.querySelector('.us-stat-figure'), null)
  api.analytics.summary = original.analytics.summary
  await click(retry())
  assert(host.querySelector('.us-stat-figure'))
  const requests = []
  api.analytics.summary = () => new Promise((resolve) => requests.push(resolve))
  await click(host.querySelectorAll('.us-seg button')[1])
  await click(host.querySelectorAll('.us-seg button')[2])
  assert.equal(requests.length, 2)
  await act(async () => requests[1]({ ...report, totals: { ...report.totals, runs: 37 } }))
  await act(async () => requests[0]({ ...report, totals: { ...report.totals, runs: 5 } }))
  assert.equal(host.querySelectorAll('.us-stat-figure')[2].textContent, '37')
  api.analytics.summary = async () => { throw new Error('refresh unavailable') }
  await click(host.querySelector('.us-controls > button'))
  assert(host.querySelector('.data-state-stale'))
  assert.equal(host.querySelectorAll('.us-stat-figure')[2].textContent, '37')
  await unmount()
  console.log('PASS real Usage page: first error, retry, out-of-order ranges and stale snapshot')

  // Settings: invalid drafts stay visible; correcting them commits once.
  const settings = await original.settings.get()
  const settingsWrites = []
  api.settings.get = async () => { throw new Error('settings unavailable') }
  api.settings.set = async (patch) => { settingsWrites.push(patch); return { ...settings, ...patch } }
  await mount(SettingsView, { section: 'advanced', onSection() {} })
  assert(host.textContent.includes('设置加载失败'))
  api.settings.get = async () => settings
  await click(retry())
  const number = host.querySelector('input[type=number]')
  await fill(number, '0')
  await blur(number)
  assert.equal(number.value, '0')
  assert.equal(number.getAttribute('aria-invalid'), 'true')
  assert(document.getElementById(number.getAttribute('aria-describedby')).textContent.includes('1 到 1440'))
  assert.equal(settingsWrites.length, 0)
  await fill(number, '12')
  await blur(number)
  await blur(number)
  assert.equal(number.getAttribute('aria-invalid'), null)
  assert.deepEqual(settingsWrites, [{ turnIdleTimeoutMs: 720000 }])
  await fill(number, '')
  await blur(number)
  assert.equal(number.value, '')
  assert.equal(number.getAttribute('aria-invalid'), 'true')
  assert.equal(settingsWrites.length, 1)
  await unmount()
  console.log('PASS real Settings page: read retry, invalid drafts, ARIA feedback and valid single commit')

  // A settings broadcast is newer than an in-flight initial read.
  let finishRead
  api.settings.get = () => new Promise((resolve) => { finishRead = resolve })
  await mount(SettingsView, { section: 'general', onSection() {} })
  await act(async () => { await original.settings.set({ concurrency: 3 }) })
  assert.equal(host.querySelector('input[type=range]').value, '3')
  await act(async () => finishRead({ ...settings, concurrency: 1 }))
  assert.equal(host.querySelector('input[type=range]').value, '3', 'old read must not overwrite a settings broadcast')
  await unmount()
  console.log('PASS settings broadcast supersedes a pending read')

  // Workspace: unavailable directory data is recoverable and invalid modes explain why.
  api.agents.list = async () => { throw new Error('directory unavailable') }
  await mount(WorkspaceView, { onCreated() {}, workspaceDir: 'C:\\fixture', onPickWorkspace() {} })
  await fill(host.querySelector('.workspace-prompt'), 'Fixture task')
  assert(host.querySelector('.workspace-agent-error'))
  assert(host.querySelector('.workspace-actions .primary').disabled)
  api.agents.list = original.agents.list
  await click(retry())
  assert.equal(host.querySelector('.workspace-agent-error'), null)
  assert.equal(host.querySelector('.workspace-actions .primary').disabled, false)
  await click(host.querySelectorAll('.workspace-types button')[1])
  const completion = host.querySelector('.workspace-mode-fields textarea')
  assert.equal(completion.getAttribute('aria-invalid'), 'true')
  assert(document.getElementById(completion.getAttribute('aria-describedby')))
  assert(host.querySelector('.workspace-actions .primary').disabled)
  await fill(completion, 'The regression suite passes')
  assert.equal(completion.getAttribute('aria-invalid'), null)
  assert.equal(host.querySelector('.workspace-actions .primary').disabled, false)
  await click(host.querySelectorAll('.workspace-types button')[2])
  assert(host.querySelector('#meeting-captains-error'))
  assert([...host.querySelectorAll('.meeting-selects select')].every((select) => select.getAttribute('aria-invalid') === 'true'))
  assert(host.querySelector('.workspace-actions .primary').disabled)
  await unmount()
  console.log('PASS real Workspace: directory retry, completion requirements and captain validation')
} finally {
  if (host.hasChildNodes()) await act(async () => reactRoot?.unmount())
  process.off('unhandledRejection', onUnhandled)
  dom.window.close()
}
assert.deepEqual(unhandled, [], 'no unhandled read/save rejections')
console.log('UI RELIABILITY SMOKE PASSED')
