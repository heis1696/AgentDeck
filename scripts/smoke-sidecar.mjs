// Business-brain sidecar smoke: loopback auth, protocol handshake, sticky
// state, authoritative sync, orphan takeover, and crash/reconnect recovery.
import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-sidecar-'))
const serverOut = path.join(tmp, 'sidecar-server.cjs')
const managerOut = path.join(tmp, 'sidecar-manager.cjs')
await build({ entryPoints: [path.join(root, 'src/main/sidecar-server.ts')], outfile: serverOut, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
await build({ entryPoints: [path.join(root, 'src/main/sidecar.ts')], outfile: managerOut, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
const { SidecarManager } = await import(pathToFileURL(managerOut).href)

fs.mkdirSync(path.join(tmp, 'tasks'), { recursive: true })
fs.writeFileSync(path.join(tmp, 'tasks', 'tasks.json'), JSON.stringify({ schemaVersion: 1, tasks: [{ id: 't-orphan', status: 'running', runId: 'run-orphan', title: 'orphan', prompt: 'resume', workdir: '', backend: 'fake' }] }))

const manager = new SidecarManager({ userDataDir: tmp, entrypoint: serverOut, preferredPort: 0 })
const first = await manager.start()
if (first.status !== 'ready' || !first.port || !first.instanceId) throw new Error('sidecar did not complete startup handshake')
const live = await fetch(`${first.url}/health`)
if (live.status !== 200 || !(await live.json()).ok) throw new Error('unauthenticated loopback health probe failed')
const bad = await fetch(`${first.url}/handshake`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agentdeck-token': 'wrong' }, body: JSON.stringify({ protocolVersion: 1, instanceToken: 'wrong' }) })
if (bad.status !== 401) throw new Error(`invalid token was accepted (${bad.status})`)
const mismatch = await fetch(`${first.url}/handshake`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agentdeck-token': first.token }, body: JSON.stringify({ protocolVersion: 99, instanceToken: first.token }) })
if (mismatch.status !== 409) throw new Error(`protocol mismatch was not rejected (${mismatch.status})`)
const unauthorizedRpc = await fetch(`${first.url}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agentdeck-token': 'wrong' }, body: JSON.stringify({ protocol: 'agentdeck.business-brain', version: 1, id: 'bad', method: 'state.sync' }) })
if (unauthorizedRpc.status !== 401) throw new Error(`unauthorized RPC was accepted (${unauthorizedRpc.status})`)
const sync = await manager.sync()
if (sync.protocolVersion !== 1 || !Array.isArray(sync.tasks) || !Array.isArray(sync.issues)) throw new Error('sidecar state sync contract failed')
const appended = await manager.appendEvent('t-orphan', { id: 'evt-1', kind: 'text', text: 'hello' })
if (appended.seq !== 1 || appended.durability !== 'durable') throw new Error('sidecar event append contract failed')
const replay = await manager.readEvents('t-orphan', 0)
if (replay.length !== 1 || replay[0].id !== 'evt-1') throw new Error('sidecar event replay contract failed')
const liveEvent = await manager.appendEvent('t-orphan', { id: 'evt-live', kind: 'text', text: 'delta', durable: false })
if (liveEvent.durability !== 'live') throw new Error('sidecar live event boundary failed')
if ((await manager.readEvents('t-orphan', 0)).some((event) => event.id === 'evt-live')) throw new Error('live event was persisted')
const takeover = await manager.recoverOrphans()
if (!Array.isArray(takeover.adopted) || !takeover.adopted.includes('run-orphan')) throw new Error('orphan takeover contract failed')

const stateFile = path.join(tmp, 'sidecar-state.json')
const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
if (persisted.port !== first.port || persisted.token !== first.token) throw new Error('sticky sidecar state was not persisted')

// Kill the child and wait for the manager's automatic re-handshake. The
// persisted port/token must remain stable across this recovery.
if (first.pid) process.kill(first.pid)
const queuedSync = manager.rpc('state.sync')
const queuedResult = await queuedSync
if (!queuedResult || queuedResult.protocolVersion !== 1) throw new Error('queued RPC was not flushed after reconnect')
let recovered = false
for (let i = 0; i < 80; i++) {
  await new Promise((resolve) => setTimeout(resolve, 50))
  try {
    const snapshot = await manager.start()
    if (snapshot.status === 'ready' && snapshot.port === first.port) { recovered = true; break }
  } catch {}
}
if (!recovered) throw new Error('sidecar did not recover after child restart')
const adopter = new SidecarManager({ userDataDir: tmp, entrypoint: serverOut })
const adopted = await adopter.start()
if (adopted.port !== first.port || adopted.token !== first.token) throw new Error('sticky sidecar adoption failed')
await adopter.stop()
if (!(await manager.health()).ok) throw new Error('adopter stopped an owned sidecar')
await manager.stop()
console.log('smoke-sidecar: ok')
