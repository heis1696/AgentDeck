// Event log persistence smoke: append durability, batched snapshots, recovery.
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const root = path.resolve(import.meta.dirname, '..')
const outfile = path.join(root, 'out', 'smoke-event-log-store.cjs')
const logOutfile = path.join(root, 'out', 'smoke-event-log.cjs')
await build({
  entryPoints: [path.join(root, 'src/main/store.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['electron']
})
await build({
  entryPoints: [path.join(root, 'src/main/event-log.ts')],
  outfile: logOutfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18'
})
const { TaskStore } = await import(pathToFileURL(outfile).href)
const { EventLog, UnsupportedTaskEventVersionError, migrateTaskEvent } = await import(pathToFileURL(logOutfile).href)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-event-log-'))
const store = new TaskStore(tmp)
const task = store.create({ title: 'event log', prompt: 'test', workdir: '', backend: 'fake' })

for (let i = 0; i < 3; i++) store.appendEvent(task.id, { ts: Date.now(), kind: 'text', text: `chunk-${i}` })

const eventFile = path.join(tmp, 'tasks', task.id, 'events.jsonl')
const taskFile = path.join(tmp, 'tasks', task.id, 'task.json')
const events = fs.readFileSync(eventFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
if (events.length !== 3 || events.map((event) => event.seq).join(',') !== '1,2,3') throw new Error('events are not appended with monotonic seq')

// A fresh store must recover eventCount from the durable JSONL even before the
// original process has flushed its delayed task snapshot.
const recovered = new TaskStore(tmp).get(task.id)
if (recovered?.eventCount !== 3) throw new Error(`eventCount recovery failed: ${recovered?.eventCount}`)

store.flush()
const saved = JSON.parse(fs.readFileSync(taskFile, 'utf8'))
if (saved.eventCount !== 3) throw new Error(`batched snapshot flush failed: ${saved.eventCount}`)
if (store.readEvents(task.id, 1).length !== 2) throw new Error('incremental event read failed')
if (!store.truncateEvents(task.id, 1)) throw new Error('event truncation failed')
store.appendEvent(task.id, { ts: Date.now(), kind: 'text', text: 'after-truncate' })
const afterTruncate = store.readEvents(task.id, 1)
if (afterTruncate.length !== 1 || afterTruncate[0].seq !== 2) throw new Error('offset index was not rebuilt after truncation')

// A future event schema must fail closed through TaskStore as well, rather than
// being swallowed while reconciling the task snapshot on restart.
fs.appendFileSync(eventFile, JSON.stringify({ seq: 99, ts: 1, v: 99, kind: 'final', text: 'future' }) + '\n')
let taskStoreFutureRejected = false
try {
  new TaskStore(tmp)
} catch (error) {
  taskStoreFutureRejected = /Unsupported task event schema version/.test(String(error))
}
if (!taskStoreFutureRejected) throw new Error('TaskStore silently accepted a future event version')
fs.writeFileSync(eventFile, fs.readFileSync(eventFile, 'utf8').split('\n').filter((line) => !line.includes('"v":99')).filter(Boolean).join('\n') + '\n')

// Stage 6 contract: version normalization, live-only classification,
// idempotent at-least-once append, and torn-tail recovery.
const directFile = path.join(tmp, 'direct-events.jsonl')
const direct = new EventLog(directFile)
const first = direct.append({ ts: 1, kind: 'status', text: 'one', eventId: 'evt-1' })
if (!first || first.seq !== 1 || first.v !== 1 || first.durability !== 'durable') throw new Error('new events were not normalized to durable v1')
const duplicate = direct.append({ ts: 1, kind: 'status', text: 'one', eventId: 'evt-1' })
if (!duplicate || duplicate.seq !== first.seq || direct.count() !== 1) throw new Error('duplicate eventId was not idempotent')
const directLive = direct.append({ ts: 2, kind: 'text', type: 'text.delta', text: 'fragment', eventId: 'live-1' })
if (!directLive || directLive.durability !== 'live' || Number.isInteger(directLive.seq) || direct.count() !== 1 || direct.read().length !== 1) throw new Error('live-only event crossed durable replay boundary')
const final = direct.append({ ts: 3, kind: 'final', type: 'text.ended', text: 'done', eventId: 'evt-final' })
if (!final || final.seq !== 2 || direct.count() !== 2) throw new Error('durable sequence was consumed by live event')
fs.appendFileSync(directFile, '{"seq":999,"kind":"status"')
const recoveredDirect = new EventLog(directFile)
const afterTornTail = recoveredDirect.append({ ts: 4, kind: 'status', text: 'after crash' })
if (!afterTornTail || afterTornTail.seq !== 3) throw new Error('torn tail was not truncated before append')
if (recoveredDirect.read().map((event) => event.seq).join(',') !== '1,2,3') throw new Error('recovered durable sequence diverged')
const directReplay = recoveredDirect.verifyReplay(recoveredDirect.read().map((event) => ({ seq: event.seq, ts: event.ts, kind: event.kind, text: event.text, eventId: event.eventId, type: event.type })))
if (!directReplay.ok) throw new Error('legacy replay candidate did not normalize to current event schema')
const migratedUnknown = migrateTaskEvent({ seq: 1, ts: 1, kind: 'future.provider.event', text: 'kept' })
if (!migratedUnknown || migratedUnknown.kind !== 'raw' || migratedUnknown.rawKind !== 'future.provider.event') throw new Error('unknown event kind was not compatibility-normalized')

const noNewlineFile = path.join(tmp, 'legacy-no-newline.jsonl')
fs.writeFileSync(noNewlineFile, JSON.stringify({ seq: 1, ts: 1, kind: 'status', text: 'complete line' }))
const noNewlineLog = new EventLog(noNewlineFile)
if (noNewlineLog.read().length !== 1 || noNewlineLog.append({ ts: 2, kind: 'status', text: 'next' })?.seq !== 2) throw new Error('valid no-newline legacy event was discarded')

console.log('✓ append, recovery, flush and incremental read')
console.log('✓ versioning, live/durable boundary, idempotency, replay and torn-tail recovery')
console.log('✅ EVENT LOG SMOKE PASSED')
