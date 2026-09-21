// Execution-ownership repair smoke: the cases the review called out after the
// first ownership pass.
//
//   1. two stores: A's initial backend.start resolves only after B replaced the
//      run -> the session is closed, never installed, and A's scheduler slot is
//      released without waiting for the turn timeout
//   2. the same race on the resume path (no live session, task.sessionId set)
//   3. a delegation loop whose run was replaced before its response is
//      processed writes no event, no round count and spawns no child
//   4. a doom-loop permission answered after a replacement must not clear the
//      replacement run's guard window
//   5. sidecar events.append authorizes the caller-captured run/owner, not the
//      latest record
//   6. startup reconciliation does not use a log tail captured before the run
//      was replaced
//
// Everything runs against temporary data directories with fake backends. The
// only real child process is the provably dead execution owner.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

// Read at module init by the runner bundle: keep the idle sentinel far away so
// every release below is the runner's own doing, not a timeout verdict.
process.env.AGENTDECK_TURN_IDLE_MS = '60000'

const root = path.resolve(import.meta.dirname, '..')
const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-ownership-repair-'))
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-ownership-repair-data-'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let failed = 0
const check = (condition, label) => {
  console.log(`  ${condition ? 'OK  ' : 'FAIL'} ${label}`)
  if (!condition) failed++
}
const section = (label) => console.log(`\n${label}`)

async function until(predicate, timeoutMs = 15000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return true
    if (Date.now() > deadline) return false
    await sleep(stepMs)
  }
}

async function loadBundles() {
  const files = [
    ['src/main/store.ts', 'store.cjs'],
    ['src/main/runner.ts', 'runner.cjs'],
    ['src/main/persistence.ts', 'persistence.cjs'],
    ['src/main/delegate.ts', 'delegate.cjs'],
    ['src/main/handoff.ts', 'handoff.cjs'],
    ['src/main/sidecar-server.ts', 'sidecar-server.cjs']
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
  const [store, runner, persistence, delegate, handoff, sidecar] = await Promise.all([
    load('store.cjs'), load('runner.cjs'), load('persistence.cjs'), load('delegate.cjs'), load('handoff.cjs'), load('sidecar-server.cjs')
  ])
  return {
    TaskStore: store.TaskStore,
    TaskRunner: runner.TaskRunner,
    persistence,
    runDelegationLoop: delegate.runDelegationLoop,
    reconcileStartupTasks: handoff.reconcileStartupTasks,
    startSidecarServer: sidecar.startSidecarServer
  }
}

function makeDir(name) {
  const dir = path.join(dataRoot, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Replace the observed running run with a fresh one owned by another store. */
function replaceRun(store, taskId, runId, owner) {
  const current = store.get(taskId)
  const observed = { status: 'running', runId: current.runId, executionOwner: current.executionOwner }
  store.updateIf(taskId, observed, { status: 'cancelled', endedAt: Date.now() })
  store.updateIf(taskId, { status: 'cancelled', runId: current.runId, executionOwner: current.executionOwner }, { status: 'queued', runId: undefined, executionOwner: undefined, sessionId: undefined })
  return store.claimRun(taskId, { status: 'queued' }, runId, owner)
}

/** End the observed run and requeue the task, leaving the next claim to the runner. */
function releaseRun(store, taskId) {
  const current = store.get(taskId)
  store.updateIf(taskId, { status: 'running', runId: current.runId, executionOwner: current.executionOwner }, { status: 'cancelled', endedAt: Date.now() })
  return store.updateIf(taskId, { status: 'cancelled', runId: current.runId, executionOwner: current.executionOwner }, { status: 'queued', runId: undefined, executionOwner: undefined, sessionId: undefined })
}

/** A real, provably dead execution identity: observe a live child, then stop it. */
async function deadExecutionOwner(persistence) {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', windowsHide: true })
  let observed
  for (let i = 0; i < 200; i++) {
    observed = persistence.probeProcess(child.pid)
    if (observed.state === 'alive' && observed.instance) break
    await sleep(50)
  }
  if (observed?.state !== 'alive' || !observed.instance) {
    child.kill()
    throw new Error(`cannot observe a strong child process identity on ${process.platform}`)
  }
  child.kill()
  await new Promise((resolve) => child.on('exit', resolve))
  const owner = { pid: child.pid, instance: observed.instance, token: 'dead-repair-owner', leaseExpiresAt: Date.now() - 60_000 }
  if (persistence.processOwnerState(owner) !== 'dead') throw new Error('the stopped child is not proven dead; refusing to build the fixture')
  return owner
}

async function main() {
  const { TaskStore, TaskRunner, persistence, runDelegationLoop, reconcileStartupTasks, startSidecarServer } = await loadBundles()
  const opts = (extra = {}) => () => ({ concurrency: 1, mode: 'yolo', notify: false, workerConcurrency: 1, ...extra })

  // ------------------------------------------------ 1. delayed initial start
  section('[1] a delayed initial start that lost its run is closed, not installed')
  {
    const dir = makeDir('delayed-start')
    const storeA = new TaskStore(dir, { recoverRunning: false })
    const storeB = new TaskStore(dir, { recoverRunning: false })
    let releaseStart
    const startGate = new Promise((resolve) => { releaseStart = resolve })
    const closed = []
    const delayed = {
      id: 'delayed',
      label: 'delayed',
      async probe() { return { ok: true, detail: 'delayed' } },
      async start() {
        await startGate
        return { sessionId: 'sess_delayed', async send() {}, async stop() { closed.push('stop') }, async close() { closed.push('close') } }
      }
    }
    // concurrency 1: the second queued task can only start once the abandoned
    // run's scheduler slot is actually released.
    const runnerA = new TaskRunner(storeA, new Map([[delayed.id, delayed]]), opts())
    const first = storeA.create({ title: 'delayed first', prompt: 'go', workdir: '', backend: delayed.id })
    runnerA.enqueue(first)
    check(await until(() => { const t = storeB.get(first.id); return !!t?.executionOwner && !!t.runId }), 'the first run committed its claim before start resolved')
    const owner2 = persistence.createExecutionOwner()
    check(!!replaceRun(storeB, first.id, 'run_replacement_start', owner2), 'another instance replaces the run while the start is pending')

    releaseStart()
    check(await until(() => closed.includes('close')), 'the late session is closed as-is')
    check(runnerA.sessionCount() === 0, 'the late session is never installed in memory')
    const replaced = storeB.get(first.id)
    check(replaced.status === 'running' && replaced.runId === 'run_replacement_start', 'the replacement run keeps ownership')
    check(replaced.sessionId === undefined, 'the abandoned start did not bind its session id to the replacement run')
    // concurrency 1: the abandoned run held the only slot until it returned, so
    // a queued task can only start once that slot was actually released.
    const second = storeB.create({ title: 'delayed second', prompt: 'go', workdir: '', backend: delayed.id })
    runnerA.enqueue(storeB.get(second.id))
    check(await until(() => { const s = storeB.get(second.id)?.status; return s === 'running' || s === 'done' }), 'the scheduler slot was released without waiting for the turn timeout')
    await runnerA.shutdown()
  }

  // ------------------------------------------------------- 2. delayed resume
  section('[2] a delayed resume start that lost its run is closed, not installed')
  {
    const dir = makeDir('delayed-resume')
    const storeA = new TaskStore(dir, { recoverRunning: false })
    const storeB = new TaskStore(dir, { recoverRunning: false })
    let releaseResume
    const resumeGate = new Promise((resolve) => { releaseResume = resolve })
    let resumePending = false
    const closed = []
    const resumeBackend = {
      id: 'resume',
      label: 'resume',
      async probe() { return { ok: true, detail: 'resume' } },
      async start({ resumeSessionId }) {
        if (resumeSessionId) {
          resumePending = true
          await resumeGate
        }
        return { sessionId: 'sess_resumed', async send() {}, async stop() { closed.push('stop') }, async close() { closed.push('close') } }
      }
    }
    const runnerA = new TaskRunner(storeA, new Map([[resumeBackend.id, resumeBackend]]), opts())
    const task = storeA.create({ title: 'resume', prompt: 'go', workdir: '', backend: resumeBackend.id })
    storeA.update(task.id, { status: 'done', endedAt: Date.now(), result: 'first pass', sessionId: 'sess_previous', runId: 'run_previous' })
    const pending = runnerA.followUp(task.id, 'continue please')
    check(await until(() => resumePending), 'the resume start is pending')
    const owner2 = persistence.createExecutionOwner()
    check(!!replaceRun(storeB, task.id, 'run_replacement_resume', owner2), 'another instance replaces the run while the resume is pending')
    releaseResume()
    const outcome = await pending
    check(outcome.ok === false, `the abandoned resume reports failure (got ${JSON.stringify(outcome)})`)
    check(await until(() => runnerA.sessionCount() === 0), 'the resumed session is never installed in memory')
    check(closed.includes('close'), 'the late resume session is closed')
    const replaced = storeB.get(task.id)
    check(replaced.runId === 'run_replacement_resume', 'the replacement run keeps ownership after the delayed resume')
    check(replaced.sessionId === undefined, 'the abandoned resume did not rebind the session id')
    await runnerA.shutdown()
  }

  // ---------------------------------------- 3. delegation waiting for a child
  section('[3] a delegation loop from a replaced run writes nothing')
  {
    const dir = makeDir('delegate-replaced')
    const storeA = new TaskStore(dir, { recoverRunning: false })
    const storeB = new TaskStore(dir, { recoverRunning: false })
    const leader = storeA.create({ title: 'leader', prompt: 'plan', workdir: '', backend: 'fake', agentId: 'ag_lead' })
    const owner1 = persistence.createExecutionOwner()
    check(!!storeA.claimRun(leader.id, { status: 'queued' }, 'run_leader_1', owner1), 'the leader run is claimed')
    const expected = { status: 'running', runId: 'run_leader_1', executionOwner: owner1 }
    const owner2 = persistence.createExecutionOwner()
    check(!!replaceRun(storeB, leader.id, 'run_leader_2', owner2), 'the run is replaced before its response is processed')

    let spawned = 0
    const pushed = []
    const ctx = {
      store: storeA,
      runner: {
        async takeEarlySpawns() { return { entries: [], seenKeys: new Set() } },
        takeDelegateRejections() { return [] },
        async spawnDelegateChild() { spawned++; return null },
        async sendTurn() { return { ok: true, response: '' } }
      },
      getTeam: () => [
        { id: 'ag_lead', name: 'Lead', backend: 'fake', subordinates: ['ag_worker'] },
        { id: 'ag_worker', name: 'Worker', backend: 'fake' }
      ],
      opts: () => ({ mode: 'auto', notify: false, maxParallel: 1, maxRounds: 2 }),
      pushTask: () => {},
      pushEvent: (_taskId, event) => pushed.push(event)
    }
    const session = { sessionId: 'sess_leader', async send() {}, async stop() {}, async close() {} }
    const first = { ok: true, response: '<delegate to="Worker" prompt="do the work" reason="split">body</delegate>', delegationText: '' }
    const outcome = await runDelegationLoop(leader.id, session, first, expected, ctx)

    const after = storeB.get(leader.id)
    const events = storeA.readEvents(leader.id)
    check(outcome.rounds === 0 && spawned === 0, `a stale loop does not dispatch from the replaced run (rounds ${outcome.rounds}, spawns ${spawned})`)
    check(pushed.length === 0, 'a stale loop emits no host-side events')
    check(after.status === 'running' && after.runId === 'run_leader_2', 'the replacement run keeps ownership')
    check(after.roundsUsed === undefined, 'no round count is written to the replacement run')
    check(!events.some((event) => (event.text ?? '').includes('第 1 轮')), 'no delegation event is written to the replacement run')
  }

  // ------------------------------------ 4. permission answered after a swap
  section('[4] a stale doom-loop approval cannot clear the replacement guard')
  {
    const dir = makeDir('permission-swap')
    const storeA = new TaskStore(dir, { recoverRunning: false })
    const storeB = new TaskStore(dir, { recoverRunning: false })
    const prompts = []
    let starts = 0
    let latestEvents = null
    const signature = { text: 'Bash', args: '{"cmd":"ls"}' }
    const toolEvent = () => ({ ts: Date.now(), kind: 'tool', text: signature.text, data: { phase: 'started', args: signature.args } })
    const backend = {
      id: 'perm',
      label: 'perm',
      async probe() { return { ok: true, detail: 'perm' } },
      async start({ events }) {
        starts++
        latestEvents = events
        // Run 1 trips the guard immediately; run 2 needs the stale answer to
        // arrive between its second and third identical call.
        const count = starts === 1 ? 3 : 2
        for (let i = 0; i < count; i++) events.onEvent(toolEvent())
        return { sessionId: `sess_perm_${starts}`, async send() {}, async stop() {}, async close() {} }
      }
    }
    const runnerA = new TaskRunner(
      storeA,
      new Map([[backend.id, backend]]),
      opts({ concurrency: 2, doomLoopThreshold: 3 }),
      undefined,
      // Only fresh requests matter; the broker republishes settled ones with a
      // resolution through the same channel.
      { send: (channel, payload) => { if (channel === 'task:permission' && !payload.request?.resolution) prompts.push(payload.request) } }
    )
    const task = storeA.create({ title: 'perm', prompt: 'go', workdir: '', backend: backend.id, goalId: 'goal_perm' })
    runnerA.enqueue(task)
    check(await until(() => prompts.length === 1), 'run 1 trips the doom-loop guard')
    // End the observed run and let the same runner claim the replacement, so the
    // stale answer and the replacement guard window live in one runner instance.
    check(!!releaseRun(storeB, task.id), 'the run is replaced while the approval is pending')
    runnerA.enqueue(storeB.get(task.id))
    check(await until(() => starts === 2), 'the replacement run starts in the same runner')

    const stale = prompts[0]
    const resolved = runnerA.resolvePermission(stale.requestId, 'allow', 'allow', stale.requestToken)
    check(resolved.ok === true, `the stale approval is still answerable (got ${JSON.stringify(resolved)})`)
    await sleep(150)
    latestEvents.onEvent(toolEvent())
    check(await until(() => prompts.length === 2), `the replacement run still trips the guard (prompts ${prompts.length})`)
    check(!storeA.readEvents(task.id).some((event) => (event.text ?? '').includes('人工审批通过')), 'the stale approval wrote no event into the replacement run')
    await runnerA.shutdown()
  }

  // -------------------------------------------------- 5. sidecar event append
  section('[5] events.append authorizes the captured run, not the latest record')
  {
    const dir = makeDir('sidecar-append')
    const store = new TaskStore(dir, { recoverRunning: false })
    const task = store.create({ title: 'rpc', prompt: 'go', workdir: '', backend: 'none' })
    const owner1 = persistence.createExecutionOwner()
    check(!!store.claimRun(task.id, { status: 'queued' }, 'run_rpc_1', owner1), 'the first rpc run is claimed')
    const server = startSidecarServer({ port: 0, token: 'repair-token', userDataDir: dir, instanceId: 'repair-in-process' })
    const port = await server.ready
    const rpc = async (method, params) => {
      const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agentdeck-token': 'repair-token' },
        body: JSON.stringify({ version: 1, method, params })
      })
      return response.json()
    }
    try {
      const current = await rpc('events.append', { taskId: task.id, event: { kind: 'status', text: 'captured run event' }, expected: { runId: 'run_rpc_1', executionOwner: owner1 } })
      check(current.ok === true, `an append with the captured current identity succeeds (${JSON.stringify(current.error ?? '')})`)

      const owner2 = persistence.createExecutionOwner()
      check(!!replaceRun(store, task.id, 'run_rpc_2', owner2), 'the rpc run is replaced')

      const stale = await rpc('events.append', { taskId: task.id, event: { kind: 'status', text: 'stale rpc event' }, expected: { runId: 'run_rpc_1', executionOwner: owner1 } })
      check(stale.ok !== true, 'an append carrying the old run identity is refused')
      const anonymous = await rpc('events.append', { taskId: task.id, event: { kind: 'status', text: 'anonymous rpc event' } })
      check(anonymous.ok !== true, 'an append without a captured identity is not authorized by the latest run')
      const fresh = await rpc('events.append', { taskId: task.id, event: { kind: 'status', text: 'fresh rpc event' }, expected: { runId: 'run_rpc_2', executionOwner: owner2 } })
      check(fresh.ok === true, 'an append with the captured replacement identity succeeds')

      const texts = store.readEvents(task.id).map((event) => event.text ?? '')
      check(texts.includes('captured run event') && texts.includes('fresh rpc event'), 'only authorized appends reached the log')
      check(!texts.includes('stale rpc event') && !texts.includes('anonymous rpc event'), 'refused appends left no event in the log')
    } finally {
      await server.close()
    }
  }

  section('[5b] a session binding write failure closes the uninstalled provider')
  for (const resume of [false, true]) {
    const store = new TaskStore(makeDir('binding-write-' + resume))
    let stops = 0
    let closes = 0
    let starts = 0
    const backend = {
      id: 'binding-write', label: 'binding-write',
      async probe() { return { ok: true, detail: 'fake' } },
      async start({ events }) {
        const first = ++starts === 1
        if (!first) setTimeout(() => events.onTurnEnd({ ok: true, response: 'next completed' }), 20)
        return { sessionId: first ? 'binding-fault' : 'binding-next', async send() {}, async stop() { if (first) stops++ }, async close() { if (first) closes++ } }
      }
    }
    const runner = new TaskRunner(store, new Map([[backend.id, backend]]), opts())
    try {
      const item = store.create({ title: 'binding fault', prompt: 'go', workdir: '', backend: backend.id })
      if (resume) store.update(item.id, { status: 'done', sessionId: 'previous-session', runId: 'previous-run' })
      const update = store.updateIf.bind(store)
      let injected = false
      store.updateIf = (id, expected, patch) => {
        if (!injected && patch.sessionId === 'binding-fault') { injected = true; throw new Error('injected binding write failure') }
        return update(id, expected, patch)
      }
      if (resume) await runner.followUp(item.id, 'resume')
      else runner.enqueue(item)
      check(await until(() => store.get(item.id)?.status === 'failed'), 'binding fault reaches failed: ' + resume)
      check(injected && stops === 1 && closes === 1 && runner.sessionCount() === 0, 'failed binding closes the exact uninstalled session: ' + resume)
      const next = store.create({ title: 'next', prompt: 'go', workdir: '', backend: backend.id })
      runner.enqueue(next)
      check(await until(() => store.get(next.id)?.status === 'done'), 'binding fault releases the queue: ' + resume)
    } finally { await runner.shutdown(); store.flush() }
  }

  // ------------------------------------------------ 6. startup reconciliation
  section('[6] startup reconciliation ignores a tail from before the run swap')
  {
    const dir = makeDir('startup-reconcile')
    const store = new TaskStore(dir, { recoverRunning: false })
    const deadOwner = await deadExecutionOwner(persistence)

    // A run that was replaced before recovery: the cached tail (and its final)
    // belongs to the run that no longer owns the record.
    const replaced = store.create({ title: 'replaced', prompt: 'go', workdir: '', backend: 'none' })
    store.update(replaced.id, { status: 'running', startedAt: Date.now() - 1000, runId: 'run_before_replacement', executionOwner: deadOwner })
    store.appendEvent(replaced.id, { ts: Date.now(), kind: 'final', text: '上一次运行的结果' })

    // A run that is not replaced keeps the existing salvage behavior.
    const kept = store.create({ title: 'kept', prompt: 'go', workdir: '', backend: 'none' })
    store.update(kept.id, { status: 'running', startedAt: Date.now() - 1000, runId: 'run_kept', executionOwner: deadOwner })
    store.appendEvent(kept.id, { ts: Date.now(), kind: 'final', text: '输出其实完成了' })

    const advanced = store.create({ title: 'advanced', prompt: 'go', workdir: '', backend: 'none' })
    store.update(advanced.id, { status: 'running', runId: 'run_advanced', executionOwner: deadOwner })
    store.appendEvent(advanced.id, { ts: Date.now(), kind: 'final', text: 'intermediate output' })

    const queuedNormal = store.create({ title: 'queued normal', prompt: 'go', workdir: '', backend: 'none' })
    const queuedGoal = store.create({ title: 'queued goal', prompt: 'go', workdir: '', backend: 'none', goalId: 'goal_reconcile' })

    // The replacement happens between the pre-recovery snapshot and recovery.
    const realRecover = store.recoverDeadRuns.bind(store)
    let swapped = false
    store.recoverDeadRuns = (status, ids) => {
      if (!swapped) {
        swapped = true
        store.update(replaced.id, { status: 'running', startedAt: Date.now() - 500, runId: 'run_after_replacement', executionOwner: deadOwner })
        store.appendEvent(advanced.id, { ts: Date.now(), kind: 'user', text: 'another turn before recovery' })
      }
      return realRecover(status, ids)
    }

    const enqueued = []
    const result = reconcileStartupTasks({
      store,
      pushEvent: () => {},
      enqueue: (task) => enqueued.push(task.id),
      notifyTaskChanged: () => {}
    })

    const replacedAfter = store.get(replaced.id)
    const keptAfter = store.get(kept.id)
    const replacedEvents = store.readEvents(replaced.id).map((event) => event.text ?? '')
    check(swapped, 'the run swap happened before recovery')
    check(result.recovered.length === 3, `all dead runs were recovered (got ${result.recovered.length})`)
    check(store.get(advanced.id).status === 'failed' && !store.get(advanced.id).result, 'a log that advanced during recovery cannot be completed from its earlier final')
    check(replacedAfter.status === 'failed' && replacedAfter.result === undefined, 'the replaced run is not marked done from the earlier run log')
    check(!replacedEvents.includes('启动对账：检测到本任务在上次退出前已完成输出，自动标记为完成'), 'no completion note was written from the pre-swap tail')
    check(replacedEvents.includes('启动对账：应用重启导致执行中断，自动标记为失败（可「重新运行」或继续追问）'), 'the interrupted run keeps its failure note')
    check(keptAfter.status === 'done' && keptAfter.result === '输出其实完成了', 'a run that was not replaced still salvages its final event')
    check(enqueued.includes(queuedNormal.id), 'a legacy queued task is enqueued for recovery')
    check(store.get(queuedGoal.id).parked === true, 'a goal-bound queued task is parked instead')
  }

  if (failed) {
    console.error(`\n❌ RUN OWNERSHIP REPAIR SMOKE FAILED: ${failed} check(s)`)
    return 1
  }
  console.log('\n✅ RUN OWNERSHIP REPAIR SMOKE PASSED: delayed start/resume, stale delegation/permission, sidecar append identity, startup tail binding')
  return 0
}

let exitCode = 1
try {
  exitCode = await main()
} catch (error) {
  console.error('❌ RUN OWNERSHIP REPAIR SMOKE ERROR:', error instanceof Error ? error.stack : error)
  exitCode = 1
} finally {
  const relative = path.relative(os.tmpdir(), dataRoot)
  if (relative.startsWith('agentdeck-ownership-repair-data-') && !relative.includes(path.sep)) {
    fs.rmSync(dataRoot, { recursive: true, force: true })
    fs.rmSync(bundleDir, { recursive: true, force: true })
  }
}
// esbuild keeps a service child alive; exit explicitly once cleanup is done.
process.exit(exitCode)
