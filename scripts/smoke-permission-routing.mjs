import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const outfile = path.join(root, 'out', 'smoke-permission-routing.cjs')
await build({ entryPoints: [path.join(root, 'src/main/backends/zcode.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
const { createZcodeBackend } = await import(pathToFileURL(outfile).href)
const option = (optionId, decision, scope = 'once') => ({ optionId, name: optionId, response: { decision, scope } })
const cases = [
  { label: 'Timeout denial with only allow options', options: [option('allow', 'allow')], choice: { decision: 'deny' }, expected: { decision: 'deny' } },
  { label: 'Deny cannot authorize a mismatched allow id', options: [option('allow', 'allow')], choice: { optionId: 'allow', decision: 'deny' }, expected: { decision: 'deny' } },
  { label: 'Allow cannot select an unknown or mismatched id', options: [option('allow', 'allow'), option('deny', 'deny')], choice: { optionId: 'missing', decision: 'allow' }, expected: { decision: 'deny' } },
  { label: 'Explicit allow scope is preserved', options: [option('once', 'allow'), option('always', 'allow', 'always'), option('deny', 'deny')], choice: { optionId: 'always', decision: 'allow' }, expected: { decision: 'allow', scope: 'always' } },
  { label: 'A provider denial option is preserved', options: [option('reject', 'deny')], choice: { optionId: 'reject', decision: 'deny' }, expected: { decision: 'deny', scope: 'once' } },
  { label: 'Empty options remain denied', options: [], choice: { decision: 'deny' }, expected: { decision: 'deny' } }
]
process.env.FAKE_SCENARIO = 'permission-choice'
for (const item of cases) {
  process.env.FAKE_PERMISSION_OPTIONS = JSON.stringify(item.options)
  const backend = createZcodeBackend(() => ({ nodePath: process.execPath, zcodePath: path.join(root, 'scripts/fixtures/fake-zcode-app-server.mjs') }))
  const events = []
  let session
  let startPromise
  let timer
  try {
    const result = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${item.label}: fixture timed out`)), 5000)
      startPromise = backend.start({ prompt: 'permission fixture', workdir: root, mode: 'build', events: {
        onEvent: (event) => events.push(event),
        onPermission: async () => item.choice,
        onTurnEnd: resolve
      } })
      void startPromise.then((value) => { session = value }, reject)
    })
    session = await startPromise
    assert.equal(result.ok, true, item.label)
    assert.deepEqual(JSON.parse(result.response), item.expected, item.label)
    assert(events.some((event) => event.kind === 'status' && event.text.includes(item.expected.decision === 'deny' ? '拒绝' : '放行')), `${item.label}: status reflects actual response`)
    console.log(`PASS ${item.label}`)
  } finally {
    clearTimeout(timer)
    await session?.close()
  }
}
delete process.env.FAKE_SCENARIO
delete process.env.FAKE_PERMISSION_OPTIONS
console.log('PERMISSION ROUTING SMOKE PASSED')
