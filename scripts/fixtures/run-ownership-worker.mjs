// Dedicated child-process worker for scripts/smoke-run-ownership.mjs.
//
// Every mode drives only public exports (TaskStore / TaskRunner / persistence)
// from the esbuild bundles the parent produced, against a temporary data
// directory. Nothing here touches production data.
//
// Usage: node scripts/fixtures/run-ownership-worker.mjs <mode> <dataDir> <taskId> [startAtEpochMs|stopFile]
//   claim  : wait for the barrier, then attempt the store-level claimRun race
//   runner : wait for the barrier, then enqueue through a real TaskRunner
//   live   : claim a Run and stay genuinely alive (heartbeats) until <stopFile>
//   die    : claim a Run and exit immediately without finishing it
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const [mode, dataDir, taskId, extra] = process.argv.slice(2)
const bundleDir = process.env.AGENTDECK_RUN_OWNERSHIP_BUNDLE_DIR
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function emit(message) {
  return new Promise((resolve) => process.stdout.write(JSON.stringify(message) + '\n', resolve))
}

async function emitAndExit(message, code) {
  await emit(message)
  process.exit(code)
}

async function load() {
  if (!bundleDir) throw new Error('AGENTDECK_RUN_OWNERSHIP_BUNDLE_DIR is required')
  const bundle = (name) => import(pathToFileURL(path.join(bundleDir, name)).href)
  const [{ TaskStore }, { TaskRunner }, persistence] = await Promise.all([
    bundle('store.cjs'),
    bundle('runner.cjs'),
    bundle('persistence.cjs')
  ])
  return { TaskStore, TaskRunner, persistence }
}

async function waitForBarrier(startAt) {
  const target = Number(startAt)
  if (!Number.isFinite(target)) return
  // Busy spin keeps both processes inside the same few milliseconds so the
  // claim race is real rather than scheduler-ordered.
  while (Date.now() < target) { /* spin */ }
}

function makeFinishingBackend(counter) {
  return {
    id: 'ownership-fake',
    label: 'Ownership fake',
    async probe() { return { ok: true, detail: 'fake' } },
    async start({ events }) {
      counter.starts++
      setTimeout(() => {
        events.onEvent({ ts: Date.now(), kind: 'final', text: 'ownership done' })
        events.onTurnEnd({ ok: true, response: 'ownership done' })
      }, 60)
      return { sessionId: 'sess_ownership_' + process.pid, async send() {}, async stop() {}, async close() {} }
    }
  }
}

async function main() {
  const { TaskStore, TaskRunner, persistence } = await load()
  const store = new TaskStore(dataDir)

  if (mode === 'claim') {
    // Warm the shared process-identity cache before the barrier so the claim
    // itself does not spend a probe inside the critical section.
    persistence.createExecutionOwner()
    await waitForBarrier(extra)
    const observed = store.get(taskId)
    const owner = persistence.createExecutionOwner()
    let won = false
    let runId
    try {
      runId = 'run_claim_' + process.pid
      won = !!store.claimRun(taskId, {
        status: 'queued',
        runId: observed?.runId,
        executionOwner: observed?.executionOwner
      }, runId, owner)
    } catch (error) {
      await emitAndExit({ error: error instanceof Error ? error.message : String(error) }, 1)
      return
    }
    await emit({ won, runId, owner })
    return
  }

  if (mode === 'runner') {
    const counter = { starts: 0 }
    const backend = makeFinishingBackend(counter)
    const runner = new TaskRunner(store, new Map([[backend.id, backend]]), () => ({ concurrency: 4, mode: 'yolo', notify: false }))
    persistence.createExecutionOwner()
    await waitForBarrier(extra)
    const task = store.get(taskId)
    if (task) runner.enqueue(task)
    // Give the losing instance time to attempt (and reject) its own claim.
    await sleep(1200)
    const current = store.get(taskId)
    await emit({ starts: counter.starts, status: current?.status, runId: current?.runId, owner: current?.executionOwner })
    await runner.shutdown()
    return
  }

  if (mode === 'die') {
    const counter = { starts: 0 }
    const backend = {
      id: 'ownership-hang',
      label: 'Ownership hang',
      async probe() { return { ok: true, detail: 'hang' } },
      async start() { counter.starts++; return new Promise(() => {}) }
    }
    const runner = new TaskRunner(store, new Map([[backend.id, backend]]), () => ({ concurrency: 4, mode: 'yolo', notify: false }))
    const task = store.get(taskId)
    if (!task) throw new Error('task missing')
    runner.enqueue(task)
    let current
    for (let i = 0; i < 400; i++) {
      current = store.get(taskId)
      if (current?.status === 'running' && current.executionOwner?.pid === process.pid) break
      await sleep(25)
    }
    if (current?.status !== 'running') throw new Error('die worker never claimed the run: ' + current?.status)
    // Exit without any terminal write: this is a genuinely dead owner.
    await emitAndExit({ won: true, runId: current.runId, owner: current.executionOwner }, 0)
    return
  }

  if (mode === 'live') {
    const stopFile = extra
    const counter = { starts: 0 }
    let clearBeats = () => {}
    const backend = {
      id: 'ownership-live',
      label: 'Ownership live',
      async probe() { return { ok: true, detail: 'live' } },
      async start({ events }) {
        counter.starts++
        const beats = setInterval(() => {
          events.onEvent({ ts: Date.now(), kind: 'text', text: 'ownership heartbeat' })
        }, 1000)
        clearBeats = () => clearInterval(beats)
        return {
          sessionId: 'sess_live_' + process.pid,
          async send() {},
          async stop() { clearBeats() },
          async close() { clearBeats() }
        }
      }
    }
    const runner = new TaskRunner(store, new Map([[backend.id, backend]]), () => ({ concurrency: 4, mode: 'yolo', notify: false }))
    const task = store.get(taskId)
    if (!task) throw new Error('task missing')
    runner.enqueue(task)
    let current
    for (let i = 0; i < 600; i++) {
      current = store.get(taskId)
      if (current?.status === 'running' && current.executionOwner?.pid === process.pid) break
      await sleep(25)
    }
    if (current?.status !== 'running') throw new Error('live worker never claimed the run: ' + current?.status)
    await emit({ ready: true, runId: current.runId, owner: current.executionOwner, starts: counter.starts })
    // Stay genuinely busy: wait for the parent's stop signal while the backend
    // keeps appending durable heartbeat events.
    const deadline = Date.now() + 180_000
    while (!fs.existsSync(stopFile) && Date.now() < deadline) await sleep(200)
    const cancelled = await runner.cancel(taskId)
    clearBeats()
    const stopped = { stopped: true, cancelled: cancelled.ok, status: store.get(taskId)?.status }
    await runner.shutdown()
    // Exit deterministically: a watchdog timer may still be armed, and this
    // worker has nothing left to do once its run is stopped and reported.
    await emitAndExit(stopped, 0)
    return
  }

  throw new Error('unknown mode: ' + mode)
}

main().catch(async (error) => {
  await emit({ error: error instanceof Error ? error.message : String(error) })
  process.exit(1)
})
