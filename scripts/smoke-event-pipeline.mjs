import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(import.meta.dirname, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-event-pipeline-'))

async function bundle(entry, name, external = ['electron']) {
  const outfile = path.join(root, 'out', name)
  await build({
    entryPoints: [path.join(root, entry)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external
  })
  return import(`${pathToFileURL(outfile).href}?v=${Date.now()}-${name}`)
}

async function waitFor(check, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${message}`)
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

const { BoundedEventBatcher } = await bundle('src/main/event-batcher.ts', 'smoke-event-batcher.cjs')
const { EventLog } = await bundle('src/main/event-log.ts', 'smoke-event-pipeline-log.cjs')
const { TaskStore } = await bundle('src/main/store.ts', 'smoke-event-pipeline-store.cjs')
const { TaskRunner } = await bundle('src/main/runner.ts', 'smoke-event-pipeline-runner.cjs')
const { mergeTaskEvents } = await bundle('src/renderer/src/hooks/eventMerge.ts', 'smoke-event-pipeline-merge.cjs')
const { buildTurns } = await bundle('src/renderer/src/hooks/turnModel.ts', 'smoke-event-pipeline-turns.cjs', ['electron', 'react'])

const eventBytes = (event) => Buffer.byteLength(JSON.stringify(event), 'utf8') + 1
const mergeText = (previous, next) => ({ ...previous, text: `${previous.text ?? ''}${next.text ?? ''}` })
const mergeAnonymousText = (previous, next) => previous.kind === 'text' && next.kind === 'text'
  && !previous.eventId && !previous.id && !next.eventId && !next.id

// Raw input count and serialized UTF-8 bytes both bound batches even when
// adjacent anonymous deltas coalesce to one persisted/IPC event.
{
  const batches = []
  const batcher = new BoundedEventBatcher({
    maxDelayMs: 50,
    maxItems: 4,
    maxBytes: 1024 * 1024,
    sizeOf: eventBytes,
    canMerge: mergeAnonymousText,
    merge: mergeText,
    onFlush: (events) => { batches.push(events.map((event) => ({ ...event }))); return true }
  })
  for (let i = 0; i < 5; i++) batcher.add({ ts: i, kind: 'text', text: String(i) })
  await batcher.close()
  assert.deepEqual(batches.map((batch) => batch.map((event) => event.text)), [['0123'], ['4']])

  const utf8Batches = []
  const chinese = { ts: 1, kind: 'text', text: '测'.repeat(32) }
  const utf8Batcher = new BoundedEventBatcher({
    maxDelayMs: 50,
    maxItems: 100,
    maxBytes: eventBytes(chinese) + 1,
    sizeOf: eventBytes,
    canMerge: mergeAnonymousText,
    merge: mergeText,
    onFlush: (events) => { utf8Batches.push(events.map((event) => ({ ...event }))); return true }
  })
  utf8Batcher.add(chinese)
  utf8Batcher.add({ ...chinese, ts: 2 })
  await utf8Batcher.close()
  assert.equal(utf8Batches.length, 2, 'UTF-8 byte threshold flushes before the second multibyte event')
}

// Persistence retries back off exponentially, cap, and reset after success.
{
  const retryDelays = []
  let failures = 3
  const batcher = new BoundedEventBatcher({
    maxDelayMs: 5,
    maxRetryDelayMs: 20,
    maxItems: 1,
    maxBytes: 1024,
    sizeOf: eventBytes,
    onRetry: (_attempt, delayMs) => retryDelays.push(delayMs),
    onFlush: () => failures-- <= 0
  })
  batcher.add({ ts: 1, kind: 'text', text: 'first' })
  await waitFor(() => !batcher.hasPending, 'first retry sequence')
  assert.deepEqual(retryDelays, [5, 10, 20])

  failures = 1
  batcher.add({ ts: 2, kind: 'text', text: 'second' })
  await waitFor(() => !batcher.hasPending, 'retry reset sequence')
  assert.deepEqual(retryDelays.slice(3), [5], 'successful commit resets retry backoff')
  assert.equal(await batcher.close(), true)
}

{
  const committed = []
  let failed = true
  const batcher = new BoundedEventBatcher({
    maxDelayMs: 50,
    maxItems: 1,
    maxBytes: 1024,
    sizeOf: eventBytes,
    onPending: () => false,
    onFlush: (events) => {
      if (failed) return false
      committed.push(...events)
      return true
    }
  })
  assert.equal(batcher.add({ ts: 1, kind: 'text', text: 'retained' }), true)
  assert.equal(batcher.add({ ts: 2, kind: 'text', text: 'rejected' }), false)
  assert.equal(batcher.hasPending, true)
  failed = false
  assert.equal(await batcher.close(), true)
  assert.deepEqual(committed.map((event) => event.text), ['retained'])
}

// A write that reached disk before an uncertain fsync error is idempotent on
// retry because the batch retains stable event identities.
{
  const file = path.join(tmp, 'uncertain-fsync.jsonl')
  const log = new EventLog(file)
  const events = [
    { eventId: 'uncertain-a', ts: 1, kind: 'text', text: 'A' },
    { eventId: 'uncertain-b', ts: 2, kind: 'text', text: 'B' }
  ]
  const realFsync = fs.fsyncSync
  let injected = false
  fs.fsyncSync = (fd) => {
    realFsync(fd)
    if (!injected) {
      injected = true
      throw new Error('injected error after fsync')
    }
  }
  try {
    assert.equal(log.appendBatch(events).length, 0)
  } finally {
    fs.fsyncSync = realFsync
  }
  assert.equal(log.appendBatch(events).length, 2)
  assert.deepEqual(log.read().map((event) => event.eventId), ['uncertain-a', 'uncertain-b'])
}

// A complete first line plus a torn second line is reconciled without
// duplicating the first event when the stable batch is retried.
{
  const file = path.join(tmp, 'partial-write.jsonl')
  const log = new EventLog(file)
  const events = [
    { eventId: 'partial-a', ts: 1, kind: 'text', text: 'A' },
    { eventId: 'partial-b', ts: 2, kind: 'text', text: 'B' }
  ]
  const realOpen = fs.openSync
  const realWrite = fs.writeSync
  let eventFd
  let writeStep = 0
  fs.openSync = (target, flags, ...args) => {
    const fd = realOpen(target, flags, ...args)
    if (path.resolve(String(target)) === path.resolve(file) && flags === 'a') eventFd = fd
    return fd
  }
  fs.writeSync = (fd, buffer, offset, length, position) => {
    if (fd !== eventFd) return realWrite(fd, buffer, offset, length, position)
    if (!Buffer.isBuffer(buffer)) return realWrite(fd, buffer, offset, length, position)
    if (writeStep === 0) {
      writeStep++
      const newline = buffer.indexOf(0x0a, offset)
      return realWrite(fd, buffer, offset, newline - offset + 1, position)
    }
    if (writeStep === 1) {
      writeStep++
      return realWrite(fd, buffer, offset, Math.min(7, length), position)
    }
    throw new Error('injected partial write')
  }
  try {
    assert.equal(log.appendBatch(events).length, 0)
  } finally {
    fs.openSync = realOpen
    fs.writeSync = realWrite
  }
  assert.equal(log.appendBatch(events).length, 2)
  assert.deepEqual(log.read().map((event) => event.eventId), ['partial-a', 'partial-b'])
}

const store = new TaskStore(path.join(tmp, 'runner'))
const ipcEvents = []
const appendCalls = new Map()
let hotPathOwnershipReads = 0
let storeOwnershipReads = 0
let blockedTaskId
let blockWrites = true
const realGet = store.get.bind(store)
const realMatches = store.matches.bind(store)
const realAppendEvents = store.appendEvents.bind(store)
store.get = (...args) => { storeOwnershipReads++; return realGet(...args) }
store.matches = (...args) => { storeOwnershipReads++; return realMatches(...args) }
store.appendEvents = (taskId, events, expected) => {
  appendCalls.set(taskId, (appendCalls.get(taskId) ?? 0) + 1)
  if (taskId === blockedTaskId && blockWrites) return []
  return realAppendEvents(taskId, events, expected)
}

function turnScopedSession(sessionId) {
  return { sessionId, turnScoped: true, async send() {}, async stop() {}, async close() {} }
}

function terminalBackend(id, emitTurn) {
  return {
    id,
    label: id,
    async probe() { return { ok: true, detail: 'fixture' } },
    async start({ events, turn }) {
      setTimeout(() => emitTurn(events, turn), 0)
      return turnScopedSession(`${id}-session`)
    }
  }
}

const streamText = Array.from({ length: 65 }, (_, i) => `delta-${i}|`).join('')
const backends = new Map([
  ['stream', terminalBackend('stream', (events, turn) => {
    const readsBeforeStream = storeOwnershipReads
    for (let i = 0; i < 65; i++) {
      events.onHeartbeat?.(turn)
      events.onEvent({ ts: Date.now(), kind: 'text', text: `delta-${i}|` }, turn)
    }
    hotPathOwnershipReads = storeOwnershipReads - readsBeforeStream
    events.onEvent({ ts: Date.now(), kind: 'final', text: streamText }, turn)
    events.onTurnEnd({ ok: true, response: streamText }, turn)
  })],
  ['stable', terminalBackend('stable', (events, turn) => {
    events.onEvent({ eventId: 'stable-a', ts: Date.now(), kind: 'text', text: 'A' }, turn)
    events.onEvent({ eventId: 'stable-b', ts: Date.now(), kind: 'text', text: 'B' }, turn)
    events.onEvent({ ts: Date.now(), kind: 'final', text: 'AB' }, turn)
    events.onTurnEnd({ ok: true, response: 'AB' }, turn)
  })],
  ['blocked', terminalBackend('blocked', (events, turn) => {
    events.onEvent({ ts: Date.now(), kind: 'text', text: 'pending' }, turn)
    events.onEvent({ ts: Date.now(), kind: 'final', text: 'pending' }, turn)
    events.onTurnEnd({ ok: true, response: 'pending' }, turn)
  })],
  ['hang', {
    id: 'hang',
    label: 'hang',
    async probe() { return { ok: true, detail: 'fixture' } },
    async start({ events, turn }) {
      setTimeout(() => events.onEvent({ ts: Date.now(), kind: 'text', text: 'hanging' }, turn), 0)
      return turnScopedSession('hang-session')
    }
  }]
])

const runner = new TaskRunner(
  store,
  backends,
  () => ({ concurrency: 4, workerConcurrency: 4, mode: 'yolo', notify: false }),
  undefined,
  { send: (channel, payload) => { if (channel === 'task:event') ipcEvents.push(payload) } }
)

const launchFault = store.create({ title: 'launch fault', prompt: 'launch fault', workdir: '', backend: 'stream' })
const realAppendEvent = store.appendEvent.bind(store)
store.appendEvent = (taskId, event, expected) => {
  if (taskId === launchFault.id && event.kind === 'user') throw new Error('injected event write failure')
  return realAppendEvent(taskId, event, expected)
}
runner.enqueue(launchFault)
await waitFor(() => store.get(launchFault.id)?.status === 'failed', 'claimed launch with a failed user-event append')
assert.match(store.get(launchFault.id).error, /injected event write failure/)
store.appendEvent = realAppendEvent

const streamTask = store.create({ title: 'stream', prompt: 'stream', workdir: '', backend: 'stream' })
const stableTask = store.create({ title: 'stable', prompt: 'stable', workdir: '', backend: 'stable' })
runner.enqueue(streamTask)
runner.enqueue(stableTask)
await waitFor(() => store.get(streamTask.id)?.status === 'done' && store.get(stableTask.id)?.status === 'done', 'normal batched turns')

assert.equal(appendCalls.get(streamTask.id), 2, '65 deltas plus final obey the 64-input batch boundary')
assert.ok(hotPathOwnershipReads <= 2, `stream hot path performs one throttled ownership check (got ${hotPathOwnershipReads} store calls)`)
const streamPackets = ipcEvents.filter((packet) => packet.taskId === streamTask.id && packet.event.kind === 'text')
assert.equal(streamPackets.length, 2)
assert.equal(streamPackets.map((packet) => packet.event.text).join(''), streamText)

const stableHistory = store.readEvents(stableTask.id)
assert.deepEqual(stableHistory.filter((event) => event.kind === 'text').map((event) => [event.eventId, event.text]), [
  ['stable-a', 'A'],
  ['stable-b', 'B']
])
const stableCount = stableHistory.length
assert.equal(store.appendEvent(stableTask.id, { eventId: 'stable-b', ts: Date.now(), kind: 'text', text: 'B' })?.eventId, 'stable-b')
assert.equal(store.readEvents(stableTask.id).length, stableCount, 'producer event identity remains idempotent')
store.appendEvent = (taskId, event, expected) => {
  if (taskId === stableTask.id && event.kind === 'user') throw new Error('injected follow-up event failure')
  return realAppendEvent(taskId, event, expected)
}
const failedFollowUp = await runner.followUp(stableTask.id, 'follow up')
assert.equal(failedFollowUp.ok, false)
assert.equal(store.get(stableTask.id)?.status, 'failed')
assert.equal(runner.sessions.has(stableTask.id), false)
store.appendEvent = realAppendEvent

let merged = []
const recoveredStream = store.readEvents(streamTask.id)
for (const event of recoveredStream) merged = mergeTaskEvents(merged, [event])
const turns = buildTurns(merged, 'stream')
assert.equal(turns.at(-1)?.done, true)
assert.equal(turns.at(-1)?.items.some((item) => item.type === 'final' && item.text === streamText), true)

// A terminal callback cannot advance the task to done while its accepted
// provider events are still waiting for durable persistence.
const blockedTask = store.create({ title: 'blocked', prompt: 'blocked', workdir: '', backend: 'blocked' })
blockedTaskId = blockedTask.id
runner.enqueue(blockedTask)
await waitFor(() => (appendCalls.get(blockedTask.id) ?? 0) >= 1, 'injected persistence failure')
assert.equal(store.get(blockedTask.id)?.status, 'running')
assert.equal(store.readEvents(blockedTask.id).some((event) => event.kind === 'final'), false)
blockWrites = false
await waitFor(() => store.get(blockedTask.id)?.status === 'done', 'terminal drain recovery')
assert.equal(store.readEvents(blockedTask.id).some((event) => event.kind === 'final'), true)

const cancellingTerminal = store.create({ title: 'cancel terminal', prompt: 'cancel terminal', workdir: '', backend: 'blocked' })
blockedTaskId = cancellingTerminal.id
blockWrites = true
runner.enqueue(cancellingTerminal)
await waitFor(() => (appendCalls.get(cancellingTerminal.id) ?? 0) >= 1, 'terminal drain before cancellation')
const cancellation = await runner.cancel(cancellingTerminal.id)
assert.equal(cancellation.ok, true)
assert.match(cancellation.warning, /恢复副本/)
assert.equal(store.get(cancellingTerminal.id)?.status, 'cancelled')
blockWrites = false

await waitFor(() => runner.eventBatchers.size === 0, 'completed batcher disposal')
const cancelledTask = store.create({ title: 'cancel', prompt: 'cancel', workdir: '', backend: 'hang' })
runner.enqueue(cancelledTask)
await waitFor(() => store.get(cancelledTask.id)?.status === 'running'
  && ipcEvents.some((packet) => packet.taskId === cancelledTask.id && packet.event.kind === 'text'), 'cancellable stream')
assert.equal((await runner.cancel(cancelledTask.id)).ok, true)
assert.equal(runner.eventBatchers.size, 0, 'cancel releases its batcher')
await runner.forget(cancelledTask.id)
assert.equal(runner.eventBatchers.size, 0, 'forget leaves no batcher behind')

const shutdownTask = store.create({ title: 'shutdown', prompt: 'shutdown', workdir: '', backend: 'hang' })
runner.enqueue(shutdownTask)
await waitFor(() => store.get(shutdownTask.id)?.status === 'running'
  && [...runner.eventBatchers].some(([batcher, owner]) => owner === shutdownTask.id && batcher.hasPending), 'shutdown stream event')
await runner.shutdown()
assert.equal(runner.eventBatchers.size, 0, 'shutdown releases every batcher')
assert.equal(store.readEvents(shutdownTask.id).some((event) => event.text === 'hanging'), true, 'shutdown drains accepted events')

store.flush()
const recovered = new TaskStore(path.join(tmp, 'runner'))
assert.equal(recovered.get(streamTask.id)?.status, 'done')
assert.equal(recovered.readEvents(streamTask.id).filter((event) => event.kind === 'text').map((event) => event.text).join(''), streamText)

const backupDir = path.join(tmp, 'failed-backup')
const backupStore = new TaskStore(backupDir)
let failingTaskId = ''
const appendToBackupStore = backupStore.appendEvents.bind(backupStore)
backupStore.appendEvents = (id, events, expected) => id === failingTaskId ? [] : appendToBackupStore(id, events, expected)
const backupBackend = terminalBackend('backup', (events, turn) => {
  events.onEvent({ ts: Date.now(), kind: 'text', text: 'recover me' }, turn)
  events.onEvent({ ts: Date.now(), kind: 'final', text: 'recover me' }, turn)
  events.onTurnEnd({ ok: true, response: 'recover me' }, turn)
})
const backupRunner = new TaskRunner(backupStore, new Map([['backup', backupBackend]]), () => ({ concurrency: 1, mode: 'yolo', notify: false }))
const failedBackup = backupStore.create({ title: 'failed backup', prompt: 'run', workdir: '', backend: 'backup' })
failingTaskId = failedBackup.id
backupRunner.enqueue(failedBackup)
await waitFor(() => backupStore.get(failedBackup.id)?.status === 'failed', 'failed event flush terminates instead of hanging', 10_000)
assert.ok((backupStore.get(failedBackup.id)?.error ?? '').length > 0)
const recoveryPath = path.join(backupDir, 'tasks', failedBackup.id, 'pending-events')
assert.equal(fs.readdirSync(recoveryPath).filter((entry) => entry.endsWith('.json')).length, 1)
await backupRunner.shutdown()
const replayed = new TaskStore(backupDir)
assert.equal(replayed.readEvents(failedBackup.id).filter((event) => event.kind === 'text').map((event) => event.text).join(''), 'recover me')
assert.equal(replayed.readEvents(failedBackup.id).filter((event) => event.kind === 'final').length, 1)
assert.equal(new TaskStore(backupDir).readEvents(failedBackup.id).filter((event) => event.kind === 'text').length, 1)
assert.equal(fs.readdirSync(recoveryPath).filter((entry) => entry.endsWith('.json')).length, 0)

const orderedTask = replayed.create({ title: 'ordered backup', prompt: 'run', workdir: '', backend: 'backup' })
const orderedEvents = [
  { ts: 1000, kind: 'text', text: 'first', eventId: 'ordered-first' },
  { ts: 2000, kind: 'text', text: 'second', eventId: 'ordered-second' }
]
assert.equal(replayed.stagePendingEvents(orderedTask.id, 'ordered-later', 'ordered-run', [orderedEvents[1]], { status: 'queued' }, 2000), true)
assert.equal(replayed.stagePendingEvents(orderedTask.id, 'ordered-earlier', 'ordered-run', [orderedEvents[0]], { status: 'queued' }, 1000), true)
const restoredOrder = new TaskStore(backupDir)
assert.deepEqual(restoredOrder.readEvents(orderedTask.id).filter((event) => event.kind === 'text').map((event) => event.text), ['first', 'second'])

// —— 接受即恢复边界（崩溃窗收口）：批次定时器到期前硬崩溃，已接受事件可恢复 ——
// 原先 onPending 保护只在 flush 失败后（retryAttempt > 0）生效，正常路径上接受与
// 首次落盘之间存在最长 maxDelayMs 的纯内存崩溃窗。本例定时器 1 小时永不到期：
// 任何恢复都只能来自接受时同步写入的恢复副本。
{
  const crashDir = path.join(tmp, 'crash-window')
  const crashStore = new TaskStore(crashDir)
  const crashTask = crashStore.create({ title: 'crash window', prompt: 'run', workdir: '', backend: 'hang' })
  let stageSeq = 0
  const stage = (events) => {
    for (const event of events) {
      if (!(event.eventId || event.id)) event.eventId = `agentdeck:batch:crash-stamp:${++stageSeq}`
    }
    return crashStore.stagePendingEvents(crashTask.id, 'crash-turn', 'crash-run', events, { status: 'queued' })
  }
  // 与 runner 同规：暂存批身份不算稳定身份，合并链照常延续
  const stagedBatchId = (event) => typeof event.eventId === 'string' && event.eventId.startsWith('agentdeck:batch:')
  const crashMergeable = (previous, next) => previous.kind === 'text' && next.kind === 'text'
    && ((!previous.eventId && !previous.id) || stagedBatchId(previous))
    && !next.eventId && !next.id
  const crashBatcher = new BoundedEventBatcher({
    maxDelayMs: 3_600_000,
    maxItems: 64,
    maxBytes: 1024 * 1024,
    sizeOf: eventBytes,
    canMerge: crashMergeable,
    merge: mergeText,
    onPending: stage,
    onFlush: () => { throw new Error('crash-window repro must never flush') }
  })
  crashBatcher.add({ eventId: 'crash-tool', ts: 1, kind: 'tool', data: { name: 'probe' } })
  crashBatcher.add({ eventId: 'crash-text', ts: 2, kind: 'text', text: 'accepted before crash' })
  crashBatcher.add({ ts: 3, kind: 'text', text: 'delta one|' })
  crashBatcher.add({ ts: 4, kind: 'text', text: 'delta two|' })
  crashBatcher.add({ eventId: 'crash-final', ts: 5, kind: 'final', text: 'authoritative text' })
  // 崩溃：不 flush 不 close，内存态直接抛弃；恢复副本必须已在盘上
  crashBatcher.dispose()
  assert.equal(crashStore.readEvents(crashTask.id).length, 0, '崩溃窗复现前提：定时器未到，事件日志零写入')
  crashStore.flush()
  const restarted = new TaskStore(crashDir)
  const replayedCrash = restarted.readEvents(crashTask.id)
  assert.ok(replayedCrash.some((e) => e.eventId === 'crash-tool'), '崩溃窗内接受的 tool 事件重启后可恢复')
  assert.ok(replayedCrash.some((e) => e.eventId === 'crash-text' && e.text === 'accepted before crash'), '崩溃窗内接受的文本事件重启后可恢复')
  assert.ok(replayedCrash.some((e) => e.eventId === 'crash-final' && e.text === 'authoritative text'), 'final 事件接受即保护，权威文本完整')
  assert.ok(replayedCrash.some((e) => (e.text ?? '').includes('delta one|delta two|')), '合并组文本随后续非合并接受一并刷新进恢复副本')
}

// —— 管线级：真实 runner 里接受即落恢复副本——副本先于 events.jsonl 出现 ——
{
  const boundaryDir = path.join(tmp, 'accept-boundary')
  const boundaryStore = new TaskStore(boundaryDir)
  const boundaryRunner = new TaskRunner(boundaryStore, new Map([['hang', backends.get('hang')]]), () => ({ concurrency: 1, mode: 'yolo', notify: false }))
  const boundaryTask = boundaryStore.create({ title: 'accept boundary', prompt: 'run', workdir: '', backend: 'hang' })
  boundaryRunner.enqueue(boundaryTask)
  const boundaryPendingDir = path.join(boundaryDir, 'tasks', boundaryTask.id, 'pending-events')
  await waitFor(() => fs.existsSync(boundaryPendingDir)
    && fs.readdirSync(boundaryPendingDir).some((entry) => entry.endsWith('.json'))
    && boundaryStore.readEvents(boundaryTask.id).every((event) => event.kind !== 'text'),
  'accept-time recovery copy appears before any batch commit')
  const boundaryReplay = new TaskStore(boundaryDir)
  assert.ok(boundaryReplay.readEvents(boundaryTask.id).some((event) => event.text === 'hanging'), '重启侧从恢复副本回放接受时事件')
  await boundaryRunner.shutdown()
  assert.equal(boundaryStore.readEvents(boundaryTask.id).filter((event) => event.text === 'hanging').length, 1,
    '接受时已带稳定身份：原进程恢复后补投与重启回放按身份幂等，不双写')
}

const noBackupDir = path.join(tmp, 'unwritable-backup')
const noBackupStore = new TaskStore(noBackupDir)
const noBackupTask = noBackupStore.create({ title: 'both writes fail', prompt: 'run', workdir: '', backend: 'backup' })
noBackupStore.stagePendingEvents = () => false
noBackupStore.appendEvents = () => []
const noBackupRunner = new TaskRunner(noBackupStore, new Map([['backup', backupBackend]]), () => ({ concurrency: 1, mode: 'yolo', notify: false }))
noBackupRunner.enqueue(noBackupTask)
await waitFor(() => noBackupStore.get(noBackupTask.id)?.status === 'failed', 'unrecoverable event writes fail explicitly', 10_000)
assert.match(noBackupStore.get(noBackupTask.id)?.error, /恢复副本均写入失败/)
await noBackupRunner.shutdown()

const deletedBackup = replayed.create({ title: 'delete backup', prompt: 'run', workdir: '', backend: 'backup' })
const deletedEvent = { ts: Date.now(), kind: 'text', text: 'delete me', eventId: 'pending-delete' }
assert.equal(replayed.stagePendingEvents(deletedBackup.id, 'deleted-turn', 'deleted-run', [deletedEvent], { status: 'queued' }), true)
assert.equal(fs.readdirSync(path.join(backupDir, 'tasks', deletedBackup.id, 'pending-events')).length, 1)
replayed.delete(deletedBackup.id)
assert.equal(fs.existsSync(path.join(backupDir, 'tasks', deletedBackup.id)), false)
assert.equal(new TaskStore(backupDir).get(deletedBackup.id), undefined)

for (const action of ['cancel', 'shutdown']) {
  const directory = path.join(tmp, `recovery-${action}`)
  const faultStore = new TaskStore(directory)
  const faultTask = faultStore.create({ title: action, prompt: 'run', workdir: '', backend: 'hang' })
  const normalAppend = faultStore.appendEvents.bind(faultStore)
  faultStore.appendEvents = (id, events, expected) => id === faultTask.id ? [] : normalAppend(id, events, expected)
  const faultRunner = new TaskRunner(faultStore, new Map([['hang', backends.get('hang')]]), () => ({ concurrency: 1, mode: 'yolo', notify: false }))
  faultRunner.enqueue(faultTask)
  const pendingDirectory = path.join(directory, 'tasks', faultTask.id, 'pending-events')
  await waitFor(() => fs.existsSync(pendingDirectory) && fs.readdirSync(pendingDirectory).some((entry) => entry.endsWith('.json')), `${action} backup staged`)
  const start = Date.now()
  if (action === 'cancel') {
    const stopped = await faultRunner.cancel(faultTask.id)
    assert.equal(stopped.ok, true)
    assert.match(stopped.warning, /恢复副本/)
    assert.equal(faultStore.get(faultTask.id)?.status, 'cancelled')
    assert.ok(faultStore.get(faultTask.id)?.error)
    await faultRunner.shutdown()
  } else await faultRunner.shutdown()
  assert.ok(Date.now() - start < 8_000, `${action} does not wait forever for the event log`)
  const replay = new TaskStore(directory, { recoverRunning: true })
  assert.equal(replay.readEvents(faultTask.id).filter((event) => event.kind === 'text').map((event) => event.text).join(''), 'hanging')
  assert.equal(replay.get(faultTask.id)?.status, action === 'cancel' ? 'cancelled' : 'running')
}

console.log('EVENT PIPELINE SMOKE PASSED')
process.exit(0)
