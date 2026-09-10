import { build } from 'esbuild'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const outfile = path.join(root, 'out', 'smoke-opencode-server.cjs')
await build({ entryPoints: [path.join(root, 'src/main/backends/opencode-server.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
const { createOpencodeServerBackend } = await import(pathToFileURL(outfile).href)

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
  calls.push({ method: init.method ?? 'GET', path: url.pathname })
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
await session.close()
if (!calls.some((call) => call.method === 'POST' && call.path.endsWith('/abort'))) throw new Error('interrupt endpoint was not called')
if (!calls.some((call) => call.method === 'DELETE' && call.path === '/session/ses-smoke')) throw new Error('close endpoint was not called')
if (!calls.some((call) => call.method === 'POST' && call.path.endsWith('/reply'))) throw new Error('permission reply endpoint was not called')
if (!seenAfter.length || seenAfter.some((value) => value === null)) throw new Error('SSE after cursor was not supplied')
console.log('✓ OpenCode server session, permission, event mapping, interrupt/close and SSE cursor')
