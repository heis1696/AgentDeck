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
const taskEvent = store.appendEvent(task.id, { ts: 10, kind: 'status', text: 'idempotent', eventId: 'task-idem' })
const taskDuplicate = store.appendEvent(task.id, { ts: 10, kind: 'status', text: 'idempotent', eventId: 'task-idem' })
const duplicateTask = store.get(task.id)
if (!taskEvent || !taskDuplicate || taskDuplicate.seq !== taskEvent.seq || duplicateTask?.eventCount !== 3) throw new Error(`duplicate event inflated task eventCount: ${duplicateTask?.eventCount}`)
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
const batch = new EventLog(path.join(tmp, 'batch-events.jsonl'))
const batched = batch.appendBatch([
  { ts: 1, kind: 'status', text: 'batch-1', eventId: 'batch-1', durable: { aggregate: 'task', seq: 99, version: 1 } },
  { ts: 2, kind: 'status', text: 'batch-2', eventId: 'batch-2' }
])
if (batched.length !== 2 || batched[0].seq !== 1 || batched[0].durable?.seq !== 1 || batched[1].seq !== 2 || batched[1].durable?.seq !== 2) throw new Error('appendBatch durable sequence metadata diverged')
const migratedUnknown = migrateTaskEvent({ seq: 1, ts: 1, kind: 'future.provider.event', text: 'kept' })
if (!migratedUnknown || migratedUnknown.kind !== 'raw' || migratedUnknown.rawKind !== 'future.provider.event') throw new Error('unknown event kind was not compatibility-normalized')

const noNewlineFile = path.join(tmp, 'legacy-no-newline.jsonl')
fs.writeFileSync(noNewlineFile, JSON.stringify({ seq: 1, ts: 1, kind: 'status', text: 'complete line' }))
const noNewlineLog = new EventLog(noNewlineFile)
if (noNewlineLog.read().length !== 1 || noNewlineLog.append({ ts: 2, kind: 'status', text: 'next' })?.seq !== 2) throw new Error('valid no-newline legacy event was discarded')

// Memory-resident reads: the index caches parsed durable events, so a second
// read must serve from memory instead of re-reading the whole file per event
// (the pathology that made a 1.86MB log take 5s per events.read). Structural
// evidence: count file-open syscalls, never wall-clock timing.
{
  const bigFile = path.join(tmp, 'big-events.jsonl')
  fs.writeFileSync(bigFile, Array.from({ length: 3000 }, (_, i) => JSON.stringify({ seq: i + 1, ts: 1, kind: 'status', text: `event-${i}` })).join('\n') + '\n')
  const realReadFileSync = fs.readFileSync
  const realOpenSync = fs.openSync
  let fileOpens = 0
  fs.readFileSync = (...args) => { fileOpens++; return realReadFileSync(...args) }
  fs.openSync = (...args) => { fileOpens++; return realOpenSync(...args) }
  try {
    const big = new EventLog(bigFile)
    const first = big.read()
    const opensAfterFirstRead = fileOpens
    if (first.length !== 3000 || first[2999].seq !== 3000) throw new Error(`large log first read incomplete: ${first.length}`)
    const secondPage = big.read(1500, 500)
    if (secondPage.length !== 500 || secondPage[0].seq !== 1501 || secondPage[499].seq !== 2000) throw new Error('large log second page returned wrong slice')
    if (big.read().length !== 3000) throw new Error('large log full second read incomplete')
    if (fileOpens !== opensAfterFirstRead) throw new Error(`subsequent reads re-opened the file ${fileOpens - opensAfterFirstRead} times instead of serving memory`)
  } finally {
    fs.readFileSync = realReadFileSync
    fs.openSync = realOpenSync
  }
}

// Freshness: an external writer appending behind a live instance's back must
// be folded in by the watermark check, so the next append continues after the
// external seq instead of reallocating it (the duplicate-3611/3613 mode).
{
  const extFile = path.join(tmp, 'freshness-events.jsonl')
  const mine = new EventLog(extFile)
  if (mine.append({ ts: 1, kind: 'status', text: 'mine-1', eventId: 'fresh-1' })?.seq !== 1) throw new Error('freshness setup append failed')
  const other = new EventLog(extFile)
  if (other.append({ ts: 2, kind: 'status', text: 'external', eventId: 'fresh-2' })?.seq !== 2) throw new Error('external writer did not observe seq 1')
  const seen = mine.read()
  if (seen.length !== 2 || seen[1].eventId !== 'fresh-2') throw new Error('stale instance missed externally appended events on read')
  const next = mine.append({ ts: 3, kind: 'status', text: 'mine-2', eventId: 'fresh-3' })
  if (!next || next.seq !== 3) throw new Error(`stale instance reallocated a seq after external append: ${next?.seq}`)
  const disk = fs.readFileSync(extFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const seqs = disk.map((event) => event.seq)
  if (seqs.join(',') !== '1,2,3' || new Set(seqs).size !== 3) throw new Error(`duplicate or lost seq on disk after external append: ${seqs.join(',')}`)
  if (new EventLog(extFile).read().map((event) => event.seq).join(',') !== '1,2,3') throw new Error('fresh instance replay diverged after external append')
}

// Trailing partial line: a torn fragment without its newline must not leak
// into reads, and a later append must reconcile it instead of concatenating.
{
  const tailFile = path.join(tmp, 'torn-tail-events.jsonl')
  const tail = new EventLog(tailFile)
  if (tail.append({ ts: 1, kind: 'status', text: 'kept', eventId: 'tail-1' })?.seq !== 1) throw new Error('torn-tail setup append failed')
  fs.appendFileSync(tailFile, '{"seq":999,"kind":"status"')
  if (tail.read().map((event) => event.seq).join(',') !== '1') throw new Error('torn tail fragment leaked into reads')
  const after = tail.append({ ts: 2, kind: 'status', text: 'after fragment', eventId: 'tail-2' })
  if (!after || after.seq !== 2) throw new Error(`append after torn fragment got a dirty seq: ${after?.seq}`)
  const lines = fs.readFileSync(tailFile, 'utf8').trim().split('\n')
  if (lines.length !== 2 || lines.some((line) => { try { return !JSON.parse(line) } catch { return true } })) throw new Error('torn fragment survived on disk after append')
  if (new EventLog(tailFile).read().map((event) => event.seq).join(',') !== '1,2') throw new Error('replay diverged after torn-tail append')
  // A complete event that merely lacks its trailing newline is folded in at
  // append time (with a separator) instead of being concatenated onto.
  const legFile = path.join(tmp, 'legacy-tail-events.jsonl')
  const leg = new EventLog(legFile)
  if (leg.append({ ts: 1, kind: 'status', text: 'first', eventId: 'leg-1' })?.seq !== 1) throw new Error('legacy-tail setup append failed')
  fs.appendFileSync(legFile, JSON.stringify({ seq: 2, ts: 2, kind: 'status', text: 'no-newline', eventId: 'leg-2' }))
  const legNext = leg.append({ ts: 3, kind: 'status', text: 'after legacy tail', eventId: 'leg-3' })
  if (!legNext || legNext.seq !== 3) throw new Error(`append after valid no-newline tail got a dirty seq: ${legNext?.seq}`)
  const legLines = fs.readFileSync(legFile, 'utf8').trim().split('\n')
  if (legLines.length !== 3) throw new Error('valid no-newline tail was concatenated or dropped on append')
  if (new EventLog(legFile).read().map((event) => event.seq).join(',') !== '1,2,3') throw new Error('replay diverged after valid no-newline tail append')
}

console.log('✓ append, recovery, flush and incremental read')
console.log('✓ versioning, live/durable boundary, idempotency, replay and torn-tail recovery')
console.log('✓ memory-resident reads, external-append freshness, torn-tail reconciliation')
console.log('✅ EVENT LOG SMOKE PASSED')
