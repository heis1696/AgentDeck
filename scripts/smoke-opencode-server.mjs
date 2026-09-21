import { build } from 'esbuild'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { EventEmitter } from 'node:events'

const root = path.resolve(import.meta.dirname, '..')
const outfile = path.join(root, 'out', 'smoke-opencode-server.cjs')
await build({ entryPoints: [path.join(root, 'src/main/backends/opencode-server.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
const { createOpencodeServerBackend } = await import(pathToFileURL(outfile).href)
const wrapperOutfile = path.join(root, 'out', 'smoke-opencode-wrapper.cjs')
await build({ entryPoints: [path.join(root, 'src/main/backends/opencode.ts')], outfile: wrapperOutfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
const { createOpencodeBackend } = await import(pathToFileURL(wrapperOutfile).href)

const calls = []
const seenAfter = []
let eventCount = 0
const wireEvents = [
  { id: 'permission-1', type: 'permission.asked', properties: { sessionID: 'ses-smoke', id: 'per-smoke', permission: 'file.read', patterns: ['*'], metadata: {} } },
  { id: 'reasoning-1', type: 'message.part.updated', properties: { sessionID: 'ses-smoke', part: { id: 'r1', type: 'reasoning', text: 'thinking' } } },
  { id: 'text-1', type: 'message.part.delta', properties: { sessionID: 'ses-smoke', field: 'text', delta: 'server-ok' } },
  { id: 'usage-1', type: 'message.part.updated', properties: { sessionID: 'ses-smoke', part: { id: 's1', type: 'step-finish', cost: 0.25, tokens: { total: 9, input: 4, output: 3, reasoning: 2 } } } },
  { id: 'compact-1', type: 'session.compacted', properties: { sessionID: 'ses-smoke' } },
  { id: 'fork-1', type: 'session.fork', properties: { sessionID: 'ses-smoke', childID: 'ses-child' } },
  { id: 'idle-1', type: 'session.idle', properties: { sessionID: 'ses-smoke' } }
]

const fakeFetch = async (input, init = {}) => {
  const url = new URL(input)
  calls.push({ method: init.method ?? 'GET', path: url.pathname, body: init.body ? JSON.parse(init.body) : undefined })
  if (url.pathname === '/global/health') return new Response(JSON.stringify({ healthy: true, version: '1.14.46' }))
  if (url.pathname === '/session' && init.method === 'POST') return new Response(JSON.stringify({ id: 'ses-smoke' }))
  if (url.pathname === '/session/ses-smoke/prompt_async') {
    return new Response(null, { status: 204 })
  }
  if (url.pathname === '/event') {
    const body = wireEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
    seenAfter.push(url.searchParams.get('after'))
    await new Promise((resolve) => setTimeout(resolve, 25))
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  }
  if (url.pathname === '/session/ses-smoke/message') return new Response('[]')
  if (url.pathname === '/permission/per-smoke/reply') return new Response('true')
  if (url.pathname === '/session/ses-smoke' && init.method === 'DELETE') return new Response('true')
  if (url.pathname === '/session/ses-smoke/abort') return new Response('true')
  throw new Error(`unexpected ${init.method ?? 'GET'} ${url.pathname}`)
}

const backend = createOpencodeServerBackend({ baseUrl: 'http://fake', fetch: fakeFetch })
let versionRejected = false
try {
  await createOpencodeServerBackend({ baseUrl: 'http://fake', fetch: async () => new Response(JSON.stringify({ version: '2.0.0' })) }).start({ prompt: 'x', workdir: 'D:/smoke', mode: 'build', events: { onEvent: () => {}, onTurnEnd: () => {} } })
} catch (error) { versionRejected = /Unsupported OpenCode server version/.test(String(error)) }
if (!versionRejected) throw new Error('incompatible server version did not fail loudly')
const events = []
let ended
const session = await backend.start({
  prompt: 'hello', workdir: 'D:/smoke', mode: 'build',
  events: {
    onEvent: (event) => events.push(event),
    onPermission: async () => ({ decision: 'allow' }),
    onTurnEnd: (result) => { ended = result }
  }
})
if (session.sessionId !== 'ses-smoke' || !ended?.ok || ended.response !== 'server-ok') throw new Error('server turn did not complete')
if (!events.some((event) => event.type === 'reasoning.delta' && event.durability === 'live')) throw new Error('reasoning event mapping failed')
if (!events.some((event) => event.kind === 'usage' && event.data?.totalTokens === 9 && event.data?.costUsd === 0.25)) throw new Error('usage event mapping failed')
if (!events.some((event) => event.type === 'session.compacted')) throw new Error('compaction event mapping failed')
if (!events.some((event) => event.type === 'session.fork')) throw new Error('fork event mapping failed')
if (!events.some((event) => event.kind === 'final' && event.text === 'server-ok')) throw new Error('final event mapping failed')
await session.stop()
const deletesBeforeDetach = calls.filter((call) => call.method === 'DELETE').length
await session.detach()
if (calls.filter((call) => call.method === 'DELETE').length !== deletesBeforeDetach) throw new Error('detach deleted the resumable server session')
let resumedEnded
const resumed = await backend.start({
  prompt: 'resume safely', workdir: 'D:/smoke', mode: 'build', resumeSessionId: session.sessionId,
  events: { onEvent() {}, onTurnEnd: (result) => { resumedEnded = result } }
})
if (!resumedEnded?.ok || resumed.sessionId !== session.sessionId) throw new Error('detached server session could not resume')
if (calls.filter((call) => call.path === '/session' && call.method === 'POST').length !== 1) throw new Error('resume created a replacement session instead of reusing the durable id')
await resumed.close()
if (!calls.some((call) => call.method === 'POST' && call.path.endsWith('/abort'))) throw new Error('interrupt endpoint was not called')
if (!calls.some((call) => call.method === 'DELETE' && call.path === '/session/ses-smoke')) throw new Error('close endpoint was not called')
if (!calls.some((call) => call.method === 'POST' && call.path.endsWith('/reply'))) throw new Error('permission reply endpoint was not called')
if (!seenAfter.length || seenAfter.some((value) => value === null)) throw new Error('SSE after cursor was not supplied')
console.log('✓ OpenCode server session, permission, event mapping, detach/resume, interrupt/close and SSE cursor')

wireEvents[0].properties.options = [
  { optionId: 'once', response: { decision: 'allow' } },
  { optionId: 'always', response: { decision: 'always' } },
  { optionId: 'deny', response: { decision: 'deny' } },
  { optionId: 'reject', response: { decision: 'reject' } }
]
for (const [choice, expected] of [
  [{ optionId: 'always', decision: 'deny' }, 'reject'],
  [{ optionId: 'deny', decision: 'allow' }, 'reject'],
  [{ optionId: 'reject', decision: 'allow' }, 'reject'],
  [{ optionId: 'missing', decision: 'allow' }, 'reject'],
  [{ decision: 'allow' }, 'once'],
  [{ optionId: 'always', decision: 'allow' }, 'always'],
  [{ optionId: 'once', decision: 'allow' }, 'once']
]) {
  const before = calls.length
  const permissionSession = await createOpencodeServerBackend({ baseUrl: 'http://fake', fetch: fakeFetch }).start({
    prompt: 'permission regression', workdir: 'D:/smoke', mode: 'build',
    events: { onEvent() {}, onTurnEnd() {}, onPermission: async () => choice }
  })
  try {
    const response = calls.slice(before).find((call) => call.path.endsWith('/reply'))
    if (response?.body.reply !== expected) throw new Error(`permission ${JSON.stringify(choice)} returned ${response?.body.reply}, expected ${expected}`)
  } finally { await permissionSession.close() }
}
console.log('PASS OpenCode denial overrides conflicting ids; explicit once/always options retain scope')

let serverStarts = 0
let serverStops = 0
const fakeChild = new EventEmitter()
const wrapped = createOpencodeBackend({
  required: true,
  skipVersionProbe: true,
  fetch: fakeFetch,
  startServer: async () => { serverStarts++; return { url: 'http://fake', child: fakeChild } },
  stopServer: async () => { serverStops++ }
})
const wrappedFirst = await wrapped.start({ prompt: 'wrapped first', workdir: 'D:/smoke', mode: 'build', events: { onEvent() {}, onTurnEnd() {} } })
await wrappedFirst.detach()
if (serverStarts !== 1 || serverStops !== 0) throw new Error(`detach leaked or stopped the production server lease (${serverStarts}/${serverStops})`)
const wrappedSecond = await wrapped.start({ prompt: 'wrapped resume', workdir: 'D:/smoke', mode: 'build', resumeSessionId: wrappedFirst.sessionId, events: { onEvent() {}, onTurnEnd() {} } })
if (serverStarts !== 1 || serverStops !== 0) throw new Error(`resume acquired a duplicate production server lease (${serverStarts}/${serverStops})`)
await wrappedSecond.close()
if (serverStops !== 1) throw new Error(`final close did not release exactly one production server lease (${serverStops})`)
console.log('PASS production OpenCode wrapper transfers one local-server lease across detach/resume')
