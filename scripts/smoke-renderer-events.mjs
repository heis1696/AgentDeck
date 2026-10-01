import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(import.meta.dirname, '..')
const outfile = path.join(root, 'out', 'smoke-renderer-events.cjs')
await build({
  entryPoints: [path.join(root, 'src/renderer/src/hooks/taskEventsController.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18'
})
const { TaskEventsController, TASK_EVENT_BATCH_MAX_ITEMS } = await import(pathToFileURL(outfile).href)
const markdownOutfile = path.join(root, 'out', 'smoke-renderer-markdown.cjs')
await build({
  entryPoints: [path.join(root, 'src/renderer/src/components/Markdown.tsx')],
  outfile: markdownOutfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  jsx: 'automatic',
  external: ['react', 'react-dom']
})
const { Markdown } = await import(pathToFileURL(markdownOutfile).href)

class FakeScheduler {
  nextId = 0
  timers = new Map()

  schedule(callback) {
    const id = ++this.nextId
    this.timers.set(id, callback)
    return id
  }

  cancel(id) {
    this.timers.delete(id)
  }

  flush() {
    const callbacks = [...this.timers.values()]
    this.timers.clear()
    for (const callback of callbacks) callback()
  }
}

function createSource(readSnapshot = async () => []) {
  const eventListeners = new Set()
  const invalidationListeners = new Set()
  const sidecarListeners = new Set()
  return {
    source: {
      readSnapshot,
      onEvent(callback) { eventListeners.add(callback); return () => eventListeners.delete(callback) },
      onEventsInvalidated(callback) { invalidationListeners.add(callback); return () => invalidationListeners.delete(callback) },
      onSidecarStatus(callback) { sidecarListeners.add(callback); return () => sidecarListeners.delete(callback) }
    },
    emitEvent(taskId, event) { for (const callback of eventListeners) callback(taskId, event) },
    invalidate(taskId) { for (const callback of invalidationListeners) callback(taskId) },
    sidecar(status) { for (const callback of sidecarListeners) callback(status) },
    get listenerCount() { return eventListeners.size + invalidationListeners.size + sidecarListeners.size }
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const event = (seq, text = String(seq)) => ({ seq, ts: seq, kind: 'text', text })
const tick = () => new Promise((resolve) => setImmediate(resolve))

assert.equal(Markdown.compare({ text: 'unchanged' }, { text: 'unchanged' }), true, 'unchanged markdown skips rerender')
assert.equal(Markdown.compare({ text: 'before' }, { text: 'after' }), false, 'changed markdown rerenders')
console.log('  ✓ unchanged Markdown text skips parsing')

{
  const scheduler = new FakeScheduler()
  const bus = createSource()
  let merges = 0
  let latest = []
  const controller = new TaskEventsController('bulk', bus.source, (events) => { merges++; latest = events }, { scheduler })
  for (let seq = 1; seq <= 1000; seq++) bus.emitEvent('bulk', event(seq))
  scheduler.flush()
  assert.equal(latest.length, 1000, 'batching retains the complete log')
  assert.ok(merges < 1000, 'multiple events share each state merge')
  assert.ok(merges <= Math.ceil(1000 / TASK_EVENT_BATCH_MAX_ITEMS), 'batch size is capped')
  console.log(`  ✓ 1000 broadcasts retained in ${merges} batch merges (max ${TASK_EVENT_BATCH_MAX_ITEMS})`)
  controller.dispose()
}

{
  const firstRead = deferred()
  const oldBus = createSource(() => firstRead.promise)
  const nextBus = createSource()
  const nextScheduler = new FakeScheduler()
  const oldChanges = []
  const nextChanges = []
  const oldController = new TaskEventsController('task-a', oldBus.source, (events) => oldChanges.push(events))
  const staleRefresh = oldController.refresh()
  oldBus.emitEvent('task-a', event(1, 'old'))
  oldController.dispose()
  const nextController = new TaskEventsController('task-b', nextBus.source, (events) => nextChanges.push(events), { scheduler: nextScheduler })
  oldBus.emitEvent('task-a', event(2, 'stale'))
  nextBus.emitEvent('task-b', event(1, 'new'))
  nextScheduler.flush()
  firstRead.resolve([event(1, 'old-snapshot')])
  await staleRefresh
  assert.equal(oldBus.listenerCount, 0, 'task switch unsubscribes the old task')
  assert.equal(oldChanges.length, 0, 'late events and snapshots cannot update the new task')
  assert.equal(nextChanges.at(-1)[0].text, 'new')
  nextController.dispose()
}

{
  const snapshot = deferred()
  const scheduler = new FakeScheduler()
  const bus = createSource(() => snapshot.promise)
  let latest = []
  const controller = new TaskEventsController('snapshot', bus.source, (events) => { latest = events }, { scheduler })
  const refresh = controller.refresh()
  bus.emitEvent('snapshot', event(1, 'arrived-during-read'))
  scheduler.flush()
  snapshot.resolve([])
  await refresh
  assert.deepEqual(latest.map((item) => item.text), ['arrived-during-read'], 'snapshot merge retains broadcasts during the read')
  controller.dispose()
}

{
  let durable = [event(1, 'kept'), event(2, 'rewound')]
  let reads = 0
  const bus = createSource(async () => { reads++; return durable })
  const scheduler = new FakeScheduler()
  let latest = []
  const controller = new TaskEventsController('rewind', bus.source, (events) => { latest = events }, { scheduler })
  await controller.refresh()
  durable = [event(1, 'kept')]
  bus.invalidate('other-task')
  await tick()
  assert.equal(reads, 1, 'other task invalidation is ignored')
  bus.invalidate('rewind')
  await tick()
  assert.deepEqual(latest.map((item) => item.seq), [1], 'rewind invalidation applies the authoritative snapshot')

  durable = [event(1, 'reconnected')]
  bus.sidecar('ready')
  await tick()
  assert.equal(reads, 3, 'sidecar ready reconnect reloads the snapshot')
  assert.equal(latest[0].text, 'reconnected')
  controller.dispose()
}

{
  const scheduler = new FakeScheduler()
  let fail = true
  const bus = createSource(async () => {
    if (fail) { fail = false; throw new Error('snapshot failed') }
    return []
  })
  let latest = []
  const controller = new TaskEventsController('retry', bus.source, (events) => { latest = events }, { scheduler })
  await assert.rejects(controller.refresh(), /snapshot failed/)
  bus.emitEvent('retry', event(1, 'after-failure'))
  scheduler.flush()
  assert.equal(latest[0].text, 'after-failure', 'live updates continue after refresh failure')
  bus.emitEvent('retry', event(2, 'timer-cleanup'))
  assert.equal(scheduler.timers.size, 1)
  controller.dispose()
  assert.equal(scheduler.timers.size, 0, 'dispose cancels the batching timer')
  assert.equal(bus.listenerCount, 0, 'dispose removes all event subscriptions')
}

if (!process.exitCode) console.log('\n✅ RENDERER EVENTS SMOKE PASSED')
