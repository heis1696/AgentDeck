// Event log persistence smoke: append durability, batched snapshots, recovery.
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const root = path.resolve(import.meta.dirname, '..')
const outfile = path.join(root, 'out', 'smoke-event-log-store.cjs')
await build({
  entryPoints: [path.join(root, 'src/main/store.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['electron']
})
const { TaskStore } = await import(pathToFileURL(outfile).href)

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

console.log('✓ append, recovery, flush and incremental read')
console.log('✅ EVENT LOG SMOKE PASSED')
