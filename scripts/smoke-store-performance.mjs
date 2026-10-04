import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(import.meta.dirname, '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-store-performance-'))
const outfile = path.join(temporary, 'store.cjs')
await build({
  stdin: {
    contents: "export { TaskStore } from './src/main/store'; export { EventLog } from './src/main/event-log'",
    resolveDir: root,
    loader: 'ts'
  },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['electron']
})
const { TaskStore, EventLog } = await import(pathToFileURL(outfile).href)
const dataDir = path.join(temporary, 'data')
const store = new TaskStore(dataDir)
const originalCount = EventLog.prototype.count
const stores = [store]
let countCalls = 0
EventLog.prototype.count = function (...args) {
  countCalls++
  return originalCount.apply(this, args)
}

try {
  const taskCount = 128
  const tasks = store.transaction((transaction) => Array.from({ length: taskCount }, (_unused, index) => {
    const task = transaction.create({ title: `Task ${index}`, prompt: 'test', workdir: temporary, backend: 'codex' })
    transaction.appendEvent(task.id, { ts: Date.now(), kind: 'text', text: 'seed' })
    return task
  }))
  const target = tasks[0]
  countCalls = 0
  assert.equal(store.get(target.id).eventCount, 1)
  assert.equal(countCalls, 1, 'single-task reads reconcile only the requested log')

  countCalls = 0
  const stagedTask = tasks[2]
  assert.equal(store.stagePendingEvents(stagedTask.id, 'performance-turn', 'performance-run', [
    { eventId: 'staged-event', ts: Date.now(), kind: 'text', text: 'staged' }
  ], {}), true)
  assert.equal(countCalls, 0, 'recovery staging keeps durability without unrelated log scans')
  const pendingDirectory = path.join(dataDir, 'tasks', stagedTask.id, 'pending-events')
  const pendingFiles = fs.readdirSync(pendingDirectory)
  assert.equal(pendingFiles.length, 1)
  const pending = JSON.parse(fs.readFileSync(path.join(pendingDirectory, pendingFiles[0]), 'utf8'))
  assert.equal(pending.events[0].eventId, 'staged-event')
  const recovered = new TaskStore(dataDir)
  stores.push(recovered)
  assert.equal(recovered.get(stagedTask.id).eventCount, 2)
  assert.deepEqual(fs.readdirSync(pendingDirectory), [])
  const recoveredAgain = new TaskStore(dataDir)
  stores.push(recoveredAgain)
  assert.equal(recoveredAgain.get(stagedTask.id).eventCount, 2, 'recovery replays staged events once')

  countCalls = 0
  const started = performance.now()
  for (let index = 0; index < 64; index++) {
    assert.ok(store.appendEvent(target.id, {
      eventId: `delta-${index}`, ts: Date.now(), kind: 'text', text: String(index)
    }))
  }
  const elapsed = performance.now() - started
  const appendCounts = countCalls
  assert.equal(appendCounts, 128, '64 appends count the target twice, never all 128 tasks')

  countCalls = 0
  store.transaction((transaction) => assert.equal(transaction.get(target.id).eventCount, 65))
  assert.equal(countCalls, 0, 'cached transactions skip the full count sweep (counts maintained incrementally)')

  const peer = new TaskStore(dataDir)
  stores.push(peer)
  const other = tasks[taskCount - 1]
  peer.update(other.id, { title: 'peer update' })
  peer.appendEvent(other.id, { ts: Date.now(), kind: 'text', text: 'peer append' })
  assert.equal(store.get(other.id).title, 'peer update')
  assert.equal(store.get(other.id).eventCount, 2)
  const batchTask = tasks[3]
  store.update(batchTask.id, { status: 'running', runId: 'old-run' })
  peer.update(batchTask.id, { status: 'running', runId: 'new-run' })
  const batchFile = path.join(dataDir, 'tasks', batchTask.id, 'events.jsonl')
  const beforeRejected = fs.readFileSync(batchFile)
  const batch = [
    { eventId: 'batch-one', ts: Date.now(), kind: 'text', text: 'first' },
    { eventId: 'batch-two', ts: Date.now(), kind: 'text', text: 'second' }
  ]
  const staleExpectation = { status: 'running', runId: 'old-run' }
  assert.equal(store.stagePendingEvents(batchTask.id, 'stale-turn', 'old-run', batch, staleExpectation), false)
  assert.deepEqual(store.appendEvents(batchTask.id, batch, staleExpectation), [])
  assert.deepEqual(fs.readFileSync(batchFile), beforeRejected)
  assert.equal(fs.existsSync(path.join(dataDir, 'tasks', batchTask.id, 'pending-events')), false)
  countCalls = 0
  assert.equal(store.appendEvents(batchTask.id, batch, { status: 'running', runId: 'new-run' }).length, 2)
  assert.equal(countCalls, 2, 'batch append reconciles only the requested log')
  countCalls = 0
  assert.equal(store.list().find((task) => task.id === target.id).eventCount, 65)
  assert.equal(countCalls, 0, 'cached lists skip the full count sweep (single-task reads still reconcile on demand)')
  const restarted = new TaskStore(dataDir)
  stores.push(restarted)
  assert.equal(restarted.get(other.id).eventCount, 2)
  assert.equal(restarted.get(target.id).eventCount, 65)
  // 跨实例延迟索引窗口守护：对端纯 append（索引写延迟到 flush）期间，本进程 get()
  // 的单任务对账必须立即看到 JSONL 新值；对端 flush 落索引后，身份失效让 list() 也新鲜
  const peerDeferred = new TaskStore(dataDir)
  stores.push(peerDeferred)
  peerDeferred.appendEvent(other.id, { ts: Date.now(), kind: 'text', text: 'deferred append' })
  assert.equal(store.get(other.id).eventCount, 3, 'cross-instance deferred append reconciles on single-task read')
  peerDeferred.flush()
  assert.equal(store.list().find((task) => task.id === other.id).eventCount, 3, 'peer flush propagates through identity invalidation')
  console.log(`PASS store-performance: ${taskCount} tasks; 64 appends use ${appendCounts} count calls instead of ${64 * (taskCount + 1)}; ${elapsed.toFixed(1)}ms; staging 0 scans; peer updates and restart counts preserved`)
} finally {
  EventLog.prototype.count = originalCount
  for (const current of stores) current.flush()
  fs.rmSync(temporary, { recursive: true, force: true })
}
