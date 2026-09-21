// Execution-ownership smoke: claim-gated launches, stale callbacks, dual
// instance/process races, and a genuinely live Run whose lease has expired.
//
// Everything runs against temporary data directories with fake backends. Real
// child processes are used for contention, death recovery and the >30s liveness
// check. No production data is read or mutated.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const worker = path.join(root, 'scripts', 'fixtures', 'run-ownership-worker.mjs')
const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-ownership-bundles-'))
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-ownership-'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Section timing keeps the cost of the >30s liveness check visible.
let sectionStarted = Date.now()
const section = (label) => {
  console.log(`\n${label} (+${((Date.now() - sectionStarted) / 1000).toFixed(1)}s)`)
  sectionStarted = Date.now()
}

// Rate-limit retries wait this long, so the backoff window is observable.
process.env.AGENTDECK_RETRY_DELAY_MS = '400'

let failed = 0
const check = (condition, label) => {
  console.log(`  ${condition ? 'OK  ' : 'FAIL'} ${label}`)
  if (!condition) failed++
}

async function loadBundles() {
  const files = [
    ['src/main/store.ts', 'store.cjs'],
    ['src/main/runner.ts', 'runner.cjs'],
    ['src/main/persistence.ts', 'persistence.cjs'],
    ['src/main/task-finalizer.ts', 'task-finalizer.cjs'],
    ['src/main/task-service.ts', 'task-service.cjs']
  ]
  for (const [source, output] of files) {
    await build({
      entryPoints: [path.join(root, source)],
      outfile: path.join(bundleDir, output),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node18',
      external: ['electron']
    })
  }
  const load = (name) => import(pathToFileURL(path.join(bundleDir, name)).href)
  const [{ TaskStore }, { TaskRunner }, persistence, { TaskFinalizer }, { TaskService }] = await Promise.all([
    load('store.cjs'), load('runner.cjs'), load('persistence.cjs'), load('task-finalizer.cjs'), load('task-service.cjs')
  ])
  return { TaskStore, TaskRunner, persistence, TaskFinalizer, TaskService }
}

function makeDir(name) {
  const dir = path.join(dataRoot, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

async function until(predicate, timeoutMs = 15000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return true
    if (Date.now() > deadline) return false
    await sleep(stepMs)
  }
}

function startWorker(args, env = {}) {
  const child = spawn(process.execPath, [worker, ...args], {
    cwd: root,
    env: { ...process.env, AGENTDECK_RUN_OWNERSHIP_BUNDLE_DIR: bundleDir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  const messages = []
  let buffer = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      try { messages.push(JSON.parse(line)) } catch { messages.push({ raw: line }) }
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  return { child, messages, exited, stderr: () => stderr }
}

async function waitForMessage(handle, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = handle.messages.find(predicate)
    if (found) return found
    if (Date.now() > deadline) {
      throw new Error(`${label}: worker message timed out (stderr: ${handle.stderr().slice(-500) || '<empty>'})`)
    }
    await sleep(50)
  }
}

/** A fake backend that records how many times a provider was started. */
function countingBackend(id, { result = 'ownership done', delayMs = 40, failWith } = {}) {
  const state = { starts: 0 }
  const backend = {
    id,
    label: id,
    state,
    async probe() { return { ok: true, detail: id } },
    async start({ events }) {
      state.starts++
      if (failWith) throw new Error(failWith)
      setTimeout(() => {
        events.onEvent({ ts: Date.now(), kind: 'final', text: result })
        events.onTurnEnd({ ok: true, response: result })
      }, delayMs)
      const session = {
        sessionId: `${id}_sess_${state.starts}`,
        async send() {},
        async stop() {},
        async close() {}
      }
      state.session = session
      return session
    }
  }
  return backend
}

async function main() {
  const { TaskStore, TaskRunner, persistence, TaskFinalizer, TaskService } = await loadBundles()
  const ownerOptions = () => ({ concurrency: 3, mode: 'yolo', notify: false, workerConcurrency: 3 })

  // ---------------------------------------------------------------- 1. baseline
  section('[1] claim commits before the backend starts')
  {
    const dir = makeDir('baseline')
    const store = new TaskStore(dir, { recoverRunning: false })
    const backend = countingBackend('own-base')
    const runner = new TaskRunner(store, new Map([[backend.id, backend]]), ownerOptions)
    const task = store.create({ title: 'baseline', prompt: 'go', workdir: '', backend: backend.id })
    runner.enqueue(task)
    const done = await until(() => store.get(task.id)?.status === 'done')
    const saved = store.get(task.id)
    check(done, 'queued task reaches done with a committed claim')
    check(backend.state.starts === 1, `backend started exactly once (got ${backend.state.starts})`)
    check(saved.executionOwner?.pid === process.pid && !!saved.executionOwner?.token, 'the committed run records a real execution owner')
    check(saved.runId?.startsWith('run_'), 'the committed run records its run id')
    check(store.readEvents(task.id).filter((event) => event.kind === 'final').length === 1, 'exactly one final event is persisted')
    await runner.shutdown()
  }

  // ------------------------------------------------- 2. two live in-process instances
  section('[2] two live instances launch a queued task only once')
  {
    const dir = makeDir('dual-instance')
    const first = new TaskStore(dir, { recoverRunning: false })
    const second = new TaskStore(dir, { recoverRunning: false })
    const backendA = countingBackend('own-a')
    const backendB = countingBackend('own-b')
    const runnerA = new TaskRunner(first, new Map([[backendA.id, backendA]]), ownerOptions)
    const runnerB = new TaskRunner(second, new Map([[backendB.id, backendB]]), ownerOptions)
    const task = first.create({ title: 'dual', prompt: 'go', workdir: '', backend: backendA.id })
    // Both instances observe the same queued record and dispatch in the same tick.
    runnerA.enqueue(task)
    runnerB.enqueue({ ...task, backend: backendA.id })
    await until(() => first.get(task.id)?.status === 'done')
    const starts = backendA.state.starts + backendB.state.starts
    check(starts === 1, `only one instance started a backend (got ${starts})`)
    check(first.get(task.id)?.status === 'done', 'the winning run finished normally')
    const events = first.readEvents(task.id)
    check(events.filter((event) => event.kind === 'user').length === 1, 'the task transcript has one user event')
    check(events.filter((event) => event.kind === 'final').length === 1, 'the task transcript has one final event')
    await runnerA.shutdown()
    await runnerB.shutdown()
  }

  // ------------------------------------------------- 3. real two-process launch race
  section('[3] two real processes launch the same queued task only once')
  {
    const dir = makeDir('dual-process')
    const store = new TaskStore(dir, { recoverRunning: false })
    const task = store.create({ title: 'dual-process', prompt: 'go', workdir: '', backend: 'ownership-fake' })
    const barrier = Date.now() + 2500
    const first = startWorker(['runner', dir, task.id, String(barrier)])
    const second = startWorker(['runner', dir, task.id, String(barrier)])
    const [one, two] = await Promise.all([
      waitForMessage(first, (message) => typeof message.starts === 'number', 40000, 'runner#1'),
      waitForMessage(second, (message) => typeof message.starts === 'number', 40000, 'runner#2')
    ])
    await Promise.all([first.exited, second.exited])
    const starts = one.starts + two.starts
    check(starts === 1, `exactly one real process started the backend (got ${starts})`)
    const saved = store.get(task.id)
    check(saved.status === 'done', `the task completed through one process (got ${saved.status})`)
    const winner = one.starts === 1 ? one : two
    check(saved.executionOwner?.pid === winner.owner?.pid, 'the durable owner is the process that actually started the run')
    check(store.readEvents(task.id).filter((event) => event.kind === 'final').length === 1, 'the losing process wrote no duplicate final event')
  }

  // --------------------------------------- 4. foreign / unknown running is not adopted
  section('[4] foreign or unknown running records are never adopted')
  {
    const dir = makeDir('foreign-running')
    const store = new TaskStore(dir, { recoverRunning: false })
    const backend = countingBackend('own-foreign')
    const runner = new TaskRunner(store, new Map([[backend.id, backend]]), ownerOptions)
    const identity = persistence.currentProcessIdentity()

    const foreign = store.create({ title: 'foreign', prompt: 'go', workdir: '', backend: backend.id })
    store.update(foreign.id, {
      status: 'running',
      runId: 'run_someone_else',
      executionOwner: { ...identity, token: 'token-someone-else', leaseExpiresAt: Date.now() - 60000 }
    })
    runner.enqueue(store.get(foreign.id))
    await sleep(300)
    const foreignSaved = store.get(foreign.id)
    check(backend.state.starts === 0, 'a foreign live running record is not adopted')
    check(foreignSaved.status === 'running' && foreignSaved.runId === 'run_someone_else', 'the foreign run identity is untouched')
    check(store.claimRun(foreign.id, { status: 'queued' }, 'run_intruder', persistence.createExecutionOwner()) === undefined, 'claimRun refuses a running record')

    const unknown = store.create({ title: 'unknown', prompt: 'go', workdir: '', backend: backend.id })
    store.update(unknown.id, { status: 'running', runId: 'run_unknown_identity' })
    runner.enqueue(store.get(unknown.id))
    await sleep(200)
    check(backend.state.starts === 0, 'a running record with unknown identity is not adopted')
    check(store.get(unknown.id).status === 'running' && store.get(unknown.id).runId === 'run_unknown_identity', 'the unknown running record is untouched')
    check(store.recoverDeadRuns('failed', [unknown.id]).length === 0, 'unknown identity is not death evidence for recovery')

    const parked = store.create({ title: 'parked', prompt: 'go', workdir: '', backend: backend.id, parked: true })
    runner.enqueue(store.get(parked.id))
    await sleep(200)
    check(backend.state.starts === 0 && store.get(parked.id).status === 'queued', 'a parked queued task is never dispatched')

    let rejected = 0
    try { store.claimRun(parked.id, { status: 'queued' }, 'run_foreign_pid', { ...identity, pid: identity.pid + 100000, token: 'x' }) } catch { rejected++ }
    const impersonated = process.platform === 'win32' ? '1'.repeat(17) : process.platform === 'linux' ? `${'0'.repeat(8)}-0000-0000-0000-000000000000:1` : undefined
    if (impersonated) {
      try { store.claimRun(parked.id, { status: 'queued' }, 'run_reused_pid', { ...identity, instance: impersonated, token: 'x' }) } catch { rejected++ }
    }
    check(rejected === (impersonated ? 2 : 1), 'a foreign pid or a reused-pid identity cannot claim a run')
    check(store.get(parked.id).status === 'queued', 'rejected claims leave the queued record intact')
    await runner.shutdown()
  }

  // ------------------------------------- 5. stale callbacks cannot touch a newer run
  section('[5] a stale run cannot modify the run that replaced it')
  {
    const dir = makeDir('stale-callbacks')
    const storeA = new TaskStore(dir, { recoverRunning: false })
    const storeB = new TaskStore(dir, { recoverRunning: false })
    const held = { events: undefined }
    // Both runners register the same backend id; instance A holds its turn,
    // instance B finishes normally. That models two live app instances.
    const holdingBackend = {
      id: 'own-shared',
      label: 'hold',
      async probe() { return { ok: true, detail: 'hold' } },
      async start({ events }) {
        held.events = events
        return { sessionId: 'sess_hold', async send() {}, async stop() {}, async close() {} }
      }
    }
    const runnerA = new TaskRunner(storeA, new Map([[holdingBackend.id, holdingBackend]]), ownerOptions)
    const replacer = countingBackend('own-shared', { result: 'new run result' })
    const runnerB = new TaskRunner(storeB, new Map([[replacer.id, replacer]]), ownerOptions)

    const task = storeA.create({ title: 'stale', prompt: 'go', workdir: '', backend: holdingBackend.id })
    runnerA.enqueue(task)
    check(await until(() => !!storeA.get(task.id)?.executionOwner && !!held.events), 'the first run is claimed and holding')
    const runOne = storeA.get(task.id)
    const ownerOne = runOne.executionOwner

    // Another instance ends run #1 (crash/explicit cancel) and starts run #2.
    const ended = storeB.updateIf(task.id, { status: 'running', runId: runOne.runId, executionOwner: ownerOne }, { status: 'cancelled', endedAt: Date.now() })
    check(!!ended, 'a second instance can end the observed run')
    const requeued = storeB.updateIf(task.id, { status: 'cancelled', runId: runOne.runId, executionOwner: ownerOne }, { status: 'queued', runId: undefined, executionOwner: undefined, sessionId: undefined })
    check(!!requeued, 'the task can be queued again for a new run')
    runnerB.enqueue(storeB.get(task.id))
    const runTwoId = await (async () => {
      await until(() => storeB.get(task.id)?.runId && storeB.get(task.id).runId !== runOne.runId)
      return storeB.get(task.id)?.runId
    })()
    const ownerTwo = storeB.get(task.id)?.executionOwner
    check(!!runTwoId && runTwoId !== runOne.runId, 'the replacement run claimed the task')
    check(await until(() => storeB.get(task.id)?.status === 'done'), 'the replacement run finished')

    // Release every late callback the abandoned session can still emit.
    held.events.onEvent({ ts: Date.now(), kind: 'text', text: 'stale old turn text' })
    held.events.onSessionId?.('sess_stale_old')
    held.events.onTurnEnd({ ok: true, response: 'stale old result' })
    held.events.onEvent({ ts: Date.now(), kind: 'final', text: 'stale old final' })
    await sleep(200)

    const final = storeB.get(task.id)
    const events = storeB.readEvents(task.id)
    check(final.status === 'done' && final.runId === runTwoId, 'the stale callback did not re-open or replace the new run')
    check(final.result === 'new run result', `the new run result survived (got ${final.result})`)
    check(!events.some((event) => (event.text ?? '').includes('stale old')), 'no event from the stale turn was persisted')
    check(final.sessionId !== 'sess_stale_old', 'the stale session id did not overwrite the new run binding')
    check(storeB.appendEvent(task.id, { ts: Date.now(), kind: 'status', text: 'stale write' }, { status: 'running', runId: runOne.runId, executionOwner: ownerOne }) === null, 'the old run identity is rejected by the store')
    check(!!ownerTwo && storeB.matches(task.id, { runId: runTwoId, executionOwner: ownerTwo }), 'the new run identity still owns the record')

    // A stale cancel (issued against the old claim) must not kill the new run.
    const target = storeA.create({ title: 'cancel-target', prompt: 'go', workdir: '', backend: holdingBackend.id })
    runnerA.enqueue(target)
    await until(() => !!storeA.get(target.id)?.executionOwner)
    const staleRun = storeA.get(target.id)
    const staleOwner = staleRun.executionOwner
    storeB.updateIf(target.id, { status: 'running', runId: staleRun.runId, executionOwner: staleOwner }, { status: 'cancelled', endedAt: Date.now() })
    storeB.updateIf(target.id, { status: 'cancelled', runId: staleRun.runId, executionOwner: staleOwner }, { status: 'queued', runId: undefined, executionOwner: undefined })
    runnerB.enqueue(storeB.get(target.id))
    await until(() => !!storeB.get(target.id)?.runId && storeB.get(target.id).runId !== staleRun.runId)
    const staleCancel = await runnerA.cancel(target.id)
    const afterCancel = storeB.get(target.id)
    check(staleCancel.ok === false, 'a cancel issued against the old claim is refused')
    check(afterCancel.status === 'running' && afterCancel.runId !== staleRun.runId, 'the newer run keeps running')
    check(await until(() => storeB.get(target.id)?.status === 'done'), 'the newer run still completes')

    await runnerA.shutdown()
    await runnerB.shutdown()
  }

  section('[5b] stale retention cannot stop a replacement session')
  {
    const dir = makeDir('retention-session')
    const store = new TaskStore(dir)
    const service = new TaskService({ store })
    let starts = 0
    let stops = 0
    let events
    const backend = {
      id: 'retention-session', label: 'retention',
      async probe() { return { ok: true, detail: 'fake' } },
      async start(options) {
        starts++
        events = options.events
        return { sessionId: 'retention-session', async send() {}, async stop() { stops++ }, async close() {} }
      }
    }
    const runner = new TaskRunner(store, new Map([[backend.id, backend]]), ownerOptions)
    try {
      const task = store.create({ title: 'retention', prompt: 'go', workdir: '', backend: backend.id })
      const old = store.update(task.id, { status: 'done', runId: 'old-terminal', endedAt: 1 })
      store.update(task.id, { status: 'queued', runId: undefined, endedAt: undefined })
      runner.enqueue(store.get(task.id))
      check(await until(() => starts === 1 && runner.sessionCount() === 1), 'the replacement has a real runner session')
      const replacement = store.get(task.id)
      service.taskCascade = () => [old]
      const deleted = await service.deleteTerminalCascade([task.id], (id) => runner.forget(id), () => true)
      check(deleted === null && stops === 0 && runner.sessionCount() === 1, 'failed deletion validation leaves the new session running')
      await runner.closeSession(task.id, { runId: old.runId, executionOwner: old.executionOwner })
      check(stops === 0 && runner.sessionCount() === 1, 'old cleanup identity cannot close the new session')
      events.onEvent({ ts: Date.now(), kind: 'final', text: 'replacement survived retention' })
      events.onTurnEnd({ ok: true, response: 'replacement survived retention' })
      check(await until(() => store.get(task.id)?.status === 'done'), 'the replacement still completes after rejected cleanup')
      check(store.get(task.id).runId === replacement.runId, 'retention preserved the replacement identity')
    } finally { await runner.shutdown(); store.flush() }
  }

  // ------------------------------------------- 6. finalizer uses the captured identity
  section('[6] a delayed finalizer cannot finish a newer run')
  {
    const dir = makeDir('finalizer')
    const store = new TaskStore(dir, { recoverRunning: false })
    const task = store.create({ title: 'finalizer', prompt: 'go', workdir: '', backend: 'own-none' })
    const ownerOne = persistence.createExecutionOwner()
    check(!!store.claimRun(task.id, { status: 'queued' }, 'run_finalize_1', ownerOne), 'the first run is claimed')
    let release
    const pending = new Promise((resolve) => { release = resolve })
    const finalizer = new TaskFinalizer(store, () => {}, async () => pending)
    const finishing = finalizer.finalizeDone(task.id, 'old run result', { status: 'running', runId: 'run_finalize_1', executionOwner: ownerOne })
    await sleep(20)
    const ownerTwo = persistence.createExecutionOwner()
    store.updateIf(task.id, { status: 'running', runId: 'run_finalize_1', executionOwner: ownerOne }, { status: 'cancelled', endedAt: Date.now() })
    check(!!store.claimRun(task.id, { status: 'cancelled', runId: 'run_finalize_1', executionOwner: ownerOne }, 'run_finalize_2', ownerTwo), 'a replacement run can claim the task')
    release({ diff: 'old diff', stat: 'old stat' })
    await finishing
    const saved = store.get(task.id)
    check(saved.status === 'running' && saved.runId === 'run_finalize_2', 'the delayed finalizer left the newer run running')
    check(!saved.result && !saved.gitDiff, 'the delayed finalizer wrote no result or snapshot to the newer run')
  }

  // ------------------------------------------------------- 7. auto retry ownership
  section('[7] auto retry is bound to the run that failed')
  {
    const dir = makeDir('retry-ok')
    const store = new TaskStore(dir, { recoverRunning: false })
    let attempts = 0
    const flaky = {
      id: 'own-flaky',
      label: 'flaky',
      async probe() { return { ok: true, detail: 'flaky' } },
      async start({ events }) {
        attempts++
        if (attempts === 1) throw new Error('429 rate limit exceeded')
        setTimeout(() => {
          events.onEvent({ ts: Date.now(), kind: 'final', text: 'retried' })
          events.onTurnEnd({ ok: true, response: 'retried' })
        }, 30)
        return { sessionId: 'sess_flaky', async send() {}, async stop() {}, async close() {} }
      }
    }
    const runner = new TaskRunner(store, new Map([[flaky.id, flaky]]), ownerOptions)
    const task = store.create({ title: 'retry', prompt: 'go', workdir: '', backend: flaky.id })
    runner.enqueue(task)
    check(await until(() => store.get(task.id)?.status === 'done', 20000), 'a retryable failure is retried and completes')
    check(attempts === 2, `the provider was retried exactly once (starts ${attempts})`)
    check(store.get(task.id).attempt === 1, 'the retry attempt counter advanced once')
    check(store.readEvents(task.id).some((event) => (event.text ?? '').includes('自动重试 1/2')), 'the retry is visible in the transcript')
    await runner.shutdown()

    const dir2 = makeDir('retry-cancel')
    const storeA = new TaskStore(dir2, { recoverRunning: false })
    const storeB = new TaskStore(dir2, { recoverRunning: false })
    let starts = 0
    const alwaysRateLimited = {
      id: 'own-429',
      label: '429',
      async probe() { return { ok: true, detail: '429' } },
      async start() { starts++; throw new Error('429 rate limit exceeded') }
    }
    const runnerA = new TaskRunner(storeA, new Map([[alwaysRateLimited.id, alwaysRateLimited]]), ownerOptions)
    const task2 = storeA.create({ title: 'retry-cancel', prompt: 'go', workdir: '', backend: alwaysRateLimited.id })
    runnerA.enqueue(task2)
    check(await until(() => storeA.get(task2.id)?.status === 'failed'), 'the rate-limited run reached failed')
    const failedRun = storeA.get(task2.id)
    const cancelled = storeB.updateIf(task2.id, { status: 'failed', runId: failedRun.runId, executionOwner: failedRun.executionOwner }, { status: 'cancelled', endedAt: Date.now() })
    check(!!cancelled, 'another instance cancels during the retry backoff')
    await sleep(900)
    check(storeA.get(task2.id).status === 'cancelled', 'the pending retry did not requeue a cancelled task')
    check(starts === 1, `the pending retry started no provider (starts ${starts})`)
    check(!storeA.readEvents(task2.id).some((event) => (event.text ?? '').startsWith('⟳ 自动重试')), 'no retry launch event was written after the cancel')
    await runnerA.shutdown()
  }

  // ------------------------------------- 8. terminal write failure still fails safely
  // smoke-continue injects this failure through store.update; the ownership
  // contract moved the terminal write onto updateIf, so the same fault is
  // injected at the new decision point.
  section('[8] a failing terminal write leaves a failed run and wakes its successor')
  {
    const dir = makeDir('terminal-fault')
    const store = new TaskStore(dir, { recoverRunning: false })
    const backend = countingBackend('own-fault', { result: 'fault result' })
    const runner = new TaskRunner(store, new Map([[backend.id, backend]]), ownerOptions)
    const source = store.create({ title: 'fault source', prompt: 'go', workdir: '', backend: backend.id })
    const successor = store.create({ title: 'fault successor', prompt: 'next', workdir: '', backend: backend.id, continuesFrom: source.id })
    const original = store.updateIf.bind(store)
    let injected = false
    store.updateIf = (id, expected, patch) => {
      if (!injected && id === source.id && patch?.status === 'done') {
        injected = true
        throw new Error('injected terminal write failure')
      }
      return original(id, expected, patch)
    }
    runner.enqueue(source)
    check(await until(() => store.get(source.id)?.status === 'failed', 20000), 'the run ends failed when its terminal write fails')
    check(injected, 'the terminal write failure was actually injected')
    check(store.get(source.id).error?.includes('injected terminal write failure'), 'the failure reason is recorded')
    if (!await until(() => store.get(successor.id)?.status === 'done')) {
      console.log('    successor state:', JSON.stringify(store.get(successor.id)))
      console.log('    successor events:', JSON.stringify(store.readEvents(successor.id)))
    }
    check(store.get(successor.id)?.status === 'done', 'the queued successor was woken after the failure')
    await runner.shutdown()
  }

  // ------------------------------------------- 9. genuinely live run past its lease
  section('[9] a genuinely live run is not taken over after its 30s lease expires')
  {
    const dir = makeDir('live-lease')
    const store = new TaskStore(dir, { recoverRunning: false })
    const task = store.create({ title: 'live', prompt: 'go', workdir: '', backend: 'ownership-live' })
    const stopFile = path.join(dir, 'stop.signal')
    const live = startWorker(['live', dir, task.id, stopFile], { AGENTDECK_TURN_IDLE_MS: '60000' })
    const ready = await waitForMessage(live, (message) => message.ready === true, 40000, 'live')
    const owner = ready.owner
    const runId = ready.runId
    check(ready.starts === 1, 'the live worker started one backend')
    check(owner?.pid === live.child.pid, 'the live owner is the real child process')
    check(typeof owner?.leaseExpiresAt === 'number' && owner.leaseExpiresAt - Date.now() <= 30000, 'the lease is bounded by the 30s claim window')

    // Wait until the lease is demonstrably expired while the owner is still alive.
    const expiredAt = owner.leaseExpiresAt + 1500
    while (Date.now() < expiredAt) await sleep(500)
    const probe = persistence.processOwnerState(owner)
    const stillLive = store.get(task.id)
    const beats = store.readEvents(task.id).filter((event) => event.kind === 'text')
    const lastBeat = beats[beats.length - 1]
    const liveForMs = Date.now() - stillLive.startedAt
    check(Date.now() > owner.leaseExpiresAt, 'the stored lease has expired')
    check(probe === 'live', `the owner process is still alive with a matching start identity (got ${probe})`)
    check(!!lastBeat && Date.now() - lastBeat.ts < 5000, 'the live run kept appending durable events while its lease was expired')
    check(liveForMs >= 30000, `the execution has been alive for more than 30 seconds (${liveForMs}ms)`)
    check(stillLive.status === 'running' && stillLive.runId === runId, 'the live run still owns the task')
    check(store.recoverDeadRuns('queued', [task.id]).length === 0, 'recovery finds no death evidence for the live run')
    check(store.recoverDeadRuns('failed', [task.id]).length === 0, 'a second recovery pass also leaves the live run alone')
    const parentRunner = new TaskRunner(store, new Map(), ownerOptions)
    parentRunner.enqueue(store.get(task.id))
    await sleep(300)
    check(parentRunner.sessionCount() === 0, 'a second instance starts no session for the live run')
    check(store.claimRun(task.id, { status: 'queued' }, 'run_intruder', persistence.createExecutionOwner()) === undefined, 'a new claim cannot take the live run')
    check(store.appendEvent(task.id, { ts: Date.now(), kind: 'status', text: 'intruder' }, { status: 'running', runId: 'run_intruder' }) === null, 'an intruder run identity cannot append events')
    check(store.get(task.id).runId === runId, 'the live run identity survived every takeover attempt')
    await parentRunner.shutdown()

    fs.writeFileSync(stopFile, 'stop')
    const stopped = await waitForMessage(live, (message) => message.stopped === true, 30000, 'live-stop')
    const exit = await live.exited
    check(stopped.cancelled === true && stopped.status === 'cancelled', 'the live owner cancelled its own run after the check')
    check(exit.code === 0, `the live worker exited cleanly (code ${exit.code})`)
  }

  // ------------------------------------- 10. a dead run is recovered exactly once
  section('[10] a dead execution is recovered exactly once')
  {
    const dir = makeDir('dead-run')
    const store = new TaskStore(dir, { recoverRunning: false })
    const task = store.create({ title: 'dead', prompt: 'go', workdir: '', backend: 'ownership-hang' })
    const dead = startWorker(['die', dir, task.id])
    const claimed = await waitForMessage(dead, (message) => message.won === true, 40000, 'die')
    const exit = await dead.exited
    check(exit.code === 0, `the owning process exited without finishing (code ${exit.code})`)
    check(persistence.processOwnerState(claimed.owner) === 'dead', 'the dead owner is proven dead, not merely expired')

    const first = store.recoverDeadRuns('failed', [task.id])
    const second = store.recoverDeadRuns('failed', [task.id])
    const recovered = store.get(task.id)
    check(first.length === 1 && first[0].id === task.id, 'the dead run is recovered once')
    check(second.length === 0, 'a second recovery pass finds nothing')
    check(recovered.status === 'failed' && recovered.runId === claimed.runId, 'the recovered run keeps its identity for audit')
    check(store.readEvents(task.id).filter((event) => event.text === 'Confirmed dead execution owner; marked interrupted').length === 1, 'exactly one recovery event was written')

    const storeB = new TaskStore(dir, { recoverRunning: false })
    const requeuedTask = storeB.create({ title: 'dead-requeue', prompt: 'go', workdir: '', backend: 'ownership-hang' })
    const deadB = startWorker(['die', dir, requeuedTask.id])
    const claimedB = await waitForMessage(deadB, (message) => message.won === true, 40000, 'die-requeue')
    await deadB.exited
    const requeued = storeB.recoverDeadRuns('queued', [requeuedTask.id])
    const record = storeB.get(requeuedTask.id)
    check(requeued.length === 1, 'a dead run can be recovered back to queued')
    check(record.status === 'queued' && record.runId === undefined && record.executionOwner === undefined, 'requeue clears the dead run identity')
    check(storeB.recoverDeadRuns('queued', [requeuedTask.id]).length === 0, 'the requeued task is not recovered twice')
    const owner = persistence.createExecutionOwner()
    const firstClaim = storeB.claimRun(requeuedTask.id, { status: 'queued', runId: undefined, executionOwner: undefined }, 'run_after_recovery', owner)
    const secondClaim = storeB.claimRun(requeuedTask.id, { status: 'queued', runId: undefined, executionOwner: undefined }, 'run_after_recovery_2', owner)
    check(!!firstClaim && secondClaim === undefined, 'the recovered task can be claimed exactly once')
    check(claimedB.owner.token !== record.executionOwner?.token, 'the dead owner token is not reused')
  }

  // ----------------------------------------------- 11. one dedupe key, one launch
  section('[11] one dedupe key produces one task and one launch')
  {
    const dir = makeDir('dedupe')
    const storeA = new TaskStore(dir, { recoverRunning: false })
    const storeB = new TaskStore(dir, { recoverRunning: false })
    const backend = countingBackend('own-dedupe')
    const runnerA = new TaskRunner(storeA, new Map([[backend.id, backend]]), ownerOptions)
    const runnerB = new TaskRunner(storeB, new Map([[backend.id, backend]]), ownerOptions)
    const input = { title: 'dedupe', prompt: 'go', workdir: '', backend: backend.id, dedupeKey: 'same-key' }
    const created = [storeA.transaction((tx) => tx.create(input)), storeB.transaction((tx) => tx.create(input))]
    check(created[0].id === created[1].id && storeA.list().length === 1, 'concurrent creation with one key yields one task')
    runnerA.enqueue(created[0])
    runnerB.enqueue(created[1])
    await until(() => storeA.get(created[0].id)?.status === 'done')
    check(backend.state.starts === 1, `the deduped task launched once (starts ${backend.state.starts})`)
    await runnerA.shutdown()
    await runnerB.shutdown()
  }

  if (failed) {
    console.error(`\n❌ RUN OWNERSHIP SMOKE FAILED: ${failed} check(s)`)
    return 1
  }
  console.log('\n✅ RUN OWNERSHIP SMOKE PASSED: claim gate, stale callbacks, dual instance/process, live lease, dead-run recovery')
  return 0
}

let exitCode = 1
try {
  exitCode = await main()
} catch (error) {
  console.error('❌ RUN OWNERSHIP SMOKE ERROR:', error instanceof Error ? error.stack : error)
  exitCode = 1
} finally {
  const relative = path.relative(os.tmpdir(), dataRoot)
  if (relative.startsWith('agentdeck-ownership-') && !relative.includes(path.sep)) {
    fs.rmSync(dataRoot, { recursive: true, force: true })
    fs.rmSync(bundleDir, { recursive: true, force: true })
  }
}
// esbuild keeps a service child alive; exit explicitly once cleanup is done.
process.exit(exitCode)
