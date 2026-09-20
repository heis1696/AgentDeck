import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' })
const { window } = dom
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, localStorage: window.localStorage, IS_REACT_ACT_ENVIRONMENT: true })
const listeners = new Set()
const pending = new Map()
const calls = []
let response = async () => ({ ok: true })
let read = async (id) => pending.get(id) ?? []
window.agentdeck = {
  tasks: {
    pendingPermissions: (id) => read(id),
    onPermission: (callback) => { listeners.add(callback); return () => listeners.delete(callback) },
    respondPermission: (...args) => { calls.push(args); return response(...args) }
  },
  sidecar: { onStatus: () => () => {} }
}
const outfile = path.join(root, 'out', 'smoke-ui-permissions.cjs')
await build({ entryPoints: [path.join(root, 'scripts/fixtures/ui-permission-harness.tsx')], outfile, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'] })
const { PermissionHarness } = await import(pathToFileURL(outfile).href)
const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const host = document.getElementById('root')
const app = createRoot(host)
const render = async (id) => act(async () => { app.render(createElement(PermissionHarness, { taskId: id })) })
const option = (id, decision) => ({ optionId: id, name: id, response: { decision } })
const request = (id, options) => ({ requestId: id, requestToken: `token-${id}`, requestedAt: Date.now() - 10_000, expiresAt: Date.now() + 30_000, toolName: 'Fixture tool', reason: 'Pending permission', riskLevel: 'low', options })
const click = async (label, twice = false) => act(async () => {
  const button = [...host.querySelectorAll('button')].find((item) => item.textContent === label)
  assert(button, `Missing permission choice ${label}`)
  button.click()
  if (twice) button.click()
})
const fire = async (taskId, value) => act(async () => { for (const listener of listeners) listener(taskId, value) })
try {
  const first = request(42, [option('Allow once', 'allow'), option('Allow always', 'always'), option('Reject', 'reject')])
  pending.set('A', [first])
  await render('A')
  assert.equal(host.querySelectorAll('button').length, 3)
  assert(host.querySelector('.permission-wait').textContent.includes('10'), 'Wait starts at broker timestamp')
  let settle
  response = () => new Promise((resolve) => { settle = resolve })
  await click('Allow always', true)
  assert.equal(calls.length, 1, 'Double click submits once')
  assert.deepEqual(calls[0], [42, 'Allow always', 'allow', 'token-42'])
  assert([...host.querySelectorAll('button')].every((button) => button.disabled), 'Pending answers disable options')
  await act(async () => { settle({ ok: false, error: 'Approval not accepted' }) })
  assert(host.querySelector('[data-error]').textContent.includes('Approval not accepted'))
  assert.equal(host.querySelectorAll('button').length, 3, 'Failed answer retains choices')
  response = async () => { throw new Error('Connection lost') }
  await click('Reject')
  assert(host.querySelector('[data-error]').textContent.includes('Connection lost'))
  assert.equal(host.querySelectorAll('button').length, 3)

  response = () => new Promise((resolve) => { settle = resolve })
  await click('Allow once')
  const second = request('second', [])
  pending.set('B', [second])
  await render('B')
  await act(async () => { settle({ ok: true }) })
  assert(host.querySelector('.permission-id').textContent === 'second', 'Late A response cannot erase B')
  assert.equal(host.querySelectorAll('button').length, 1, 'Empty provider options offer rejection only')
  response = async () => ({ ok: true })
  await click('拒绝')
  assert.deepEqual(calls.at(-1), ['second', '__agentdeck_deny__', 'deny', 'token-second'])

  await render('A')
  assert(host.querySelector('.permission-id').textContent === '42', 'Reentry restores authoritative pending request')
  pending.set('A', [])
  await fire('A', { ...first, resolution: 'expired' })
  assert.equal(host.querySelector('.permission-banner'), null)
  assert(host.querySelector('[data-notice]').textContent.includes('超时'), 'Expiration is reported')

  let oldSnapshot
  read = (id) => id === 'slow' ? new Promise((resolve) => { oldSnapshot = resolve }) : Promise.resolve(pending.get(id) ?? [])
  await render('slow')
  pending.set('B', [second])
  await render('B')
  await act(async () => { oldSnapshot([first]) })
  assert(host.querySelector('.permission-id').textContent === 'second', 'Late snapshot cannot cross task scope')
  const expired = { ...request('expired', [option('Allow', 'allow')]), expiresAt: Date.now() - 1 }
  pending.set('expired-task', [expired])
  await render('expired-task')
  assert([...host.querySelectorAll('button')].every((button) => button.disabled), 'Expired snapshot cannot authorize')
  read = async () => null
  await render('invalid-snapshot')
  assert(host.querySelector('[data-error]')?.textContent.includes('格式无效'), 'Malformed snapshots report an error without crashing')
  console.log('UI PERMISSIONS SMOKE PASSED: exact choices, timestamps, pending/error/retry, denial fallback, expiration, reentry and response/snapshot isolation')
} finally {
  await act(async () => app.unmount())
  dom.window.close()
}
