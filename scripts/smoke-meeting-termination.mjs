import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { EventEmitter } from 'node:events'
import childProcess from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-term-bundles-'))
const bundle = async (source, name) => {
  const outfile = path.join(bundleDir, name)
  await build({ entryPoints: [path.join(root, source)], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['electron'] })
  return import(pathToFileURL(outfile).href)
}
const [{ TaskRunner }, { TaskStore }, { TaskService }, { MeetingController }, { MeetingStore }, { AgentSessionRegistry }, { Executor }, { killProcessTree }] = await Promise.all([
  bundle('src/main/runner.ts', 'runner.cjs'),
  bundle('src/main/store.ts', 'store.cjs'),
  bundle('src/main/task-service.ts', 'task-service.cjs'),
  bundle('src/main/meeting-controller.ts', 'meeting-controller.cjs'),
  bundle('src/main/meeting-store.ts', 'meeting-store.cjs'),
  bundle('src/main/agent-sessions.ts', 'agent-sessions.cjs'),
  bundle('src/main/executor.ts', 'executor.cjs'),
  bundle('src/main/backends/cli-common.ts', 'cli-common.cjs')
])

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const check = (condition, label) => {
  console.log(`  ${condition ? 'OK' : 'FAIL'} ${label}`)
  if (!condition) process.exitCode = 1
}
const waitFor = async (predicate, label, timeoutMs = 4_000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() > deadline) throw new Error(`waitFor timeout: ${label}`)
    await sleep(5)
  }
}
const defer = () => {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}
const observeTimerCancellation = async (observed, action) => {
  const original = globalThis.clearTimeout
  let cleared = false
  globalThis.clearTimeout = (timer) => {
    if (observed && timer === observed) cleared = true
    original(timer)
  }
  try { return { result: await action(), cleared } }
  finally { globalThis.clearTimeout = original }
}

function makeBackend(cfg, log) {
  let seq = 0
  const stopMemos = new Map()
  const closeMemos = new Map()
  const respond = (agent, content) => {
    const agree = (grounds = 'verified') => `<stance verdict="agree" grounds="${grounds}"/>`
    if (agent === 'gamma') return `${content && content.includes('综合轮') ? '{"decisions":["ship"],"objections":[],"actionItems":[],"openQuestions":[]}' : '{"decisions":["hold"],"objections":[],"actionItems":[],"openQuestions":[]}'}\n${agree('accepted')}`
    return agree()
  }
  return {
    id: 'fake-term',
    label: 'Fake term',
    supportsResume: true,
    async probe() { return { ok: true, detail: 'fake' } },
    async start({ prompt, events, turn }) {
      const id = `s${++seq}`
      const agent = prompt.includes('Beta') ? 'beta' : prompt.includes('Gamma') ? 'gamma' : prompt.includes('Alpha') ? 'alpha' : 'worker'
      log.launches.push({ id, agent })
      events.onLaunch?.({ stop: async () => { log.launchStops.push(id) } })
      if (cfg.holdStart) await cfg.startGate.promise
      const emitTurn = async (content, stamp) => {
        const gate = cfg.turnGates?.[agent]
        if (gate) await gate.promise
        if (cfg.failFirst && seq === 1) {
          events.onTurnEnd({ ok: false, response: '', error: cfg.failError ?? 'HTTP 429 too many requests' }, stamp)
          return
        }
        const text = content === undefined ? `${agent} first turn done` : respond(agent, content)
        events.onEvent({ ts: Date.now(), kind: 'final', text }, stamp)
        events.onTurnEnd({ ok: true, response: text }, stamp)
      }
      setTimeout(() => { void emitTurn(undefined, turn).catch(() => {}) }, 5)
      const session = {
        sessionId: id,
        turnScoped: true,
        async send(content, stamp) {
          await emitTurn(content, stamp)
        },
        stop() {
          if (!stopMemos.has(id)) {
            stopMemos.set(id, (async () => { log.stops.push(id); if (cfg.stopDelay) await sleep(cfg.stopDelay); if (cfg.stopGate) await cfg.stopGate.promise })())
          }
          return stopMemos.get(id)
        },
        close() {
          if (!closeMemos.has(id)) {
            closeMemos.set(id, (async () => { log.closes.push(id); if (cfg.closeGate) await cfg.closeGate.promise; if (cfg.closeFails) throw new Error('close rejected') })())
          }
          return closeMemos.get(id)
        }
      }
      return session
    }
  }
}

function makeHarness(backendCfg = {}, runnerOpts = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-term-data-'))
  const store = new TaskStore(data)
  const service = new TaskService({ store })
  const log = { launches: [], launchStops: [], stops: [], closes: [] }
  const cfg = { holdStart: false, startGate: null, stopGate: null, stopDelay: 0, closeGate: null, closeFails: false, failFirst: false, failError: null, turnGates: {}, ...backendCfg }
  const backend = makeBackend(cfg, log)
  const runner = new TaskRunner(store, new Map([[backend.id, backend]]), () => ({
    concurrency: 4, workerConcurrency: 4, mode: 'yolo', notify: false,
    maxRetryAttempts: 2, retryBackoffMs: 400, ...runnerOpts
  }))
  const createTask = (patch = {}) => service.createTask({ title: patch.title ?? 'task', prompt: patch.prompt ?? 'do things', backend: backend.id, ...patch })
  return { data, store, service, runner, log, cfg, backend, createTask, backendId: backend.id }
}

console.log('--- terminal task idle-session barrier ---')
{
  const h = makeHarness({ closeGate: defer() })
  const task = h.createTask()
  h.runner.enqueue(h.store.get(task.id))
  await waitFor(() => h.store.get(task.id)?.status === 'done', 'task done')
  const resultText = h.store.get(task.id).result
  let settled = false
  const closing = h.runner.terminateTask(task.id).then((r) => { settled = true; return r })
  await sleep(40)
  check(!settled, 'termination waits for the idle session close before resolving')
  h.cfg.closeGate.resolve()
  const result = await closing
  check(result.ok === true, 'terminal task termination reports success')
  check(h.log.closes.length === 1, 'idle session closed exactly once')
  check(h.runner.sessionCount() === 0, 'no session remains after termination')
  check(h.store.get(task.id).status === 'done' && h.store.get(task.id).result === resultText, 'completed result is untouched by the sweep')
  const again = await h.runner.terminateTask(task.id)
  check(again.ok === true && h.log.closes.length === 1, 'repeated termination neither re-closes nor fails')
  await h.runner.shutdown()
}

console.log('--- running task strict stop/close barrier ---')
{
  const h = makeHarness({ stopGate: defer(), closeGate: defer() })
  h.cfg.turnGates.worker = defer()
  const task = h.createTask()
  h.runner.enqueue(h.store.get(task.id))
  await waitFor(() => h.runner.sessionCount() === 1, 'session installed')
  const [first, second] = [h.runner.terminateTask(task.id), h.runner.terminateTask(task.id)]
  let settled = false
  const watching = Promise.all([first, second]).then((rs) => { settled = true; return rs })
  await sleep(40)
  check(!settled, 'termination waits for provider stop and close to finish')
  check(h.store.get(task.id).status === 'cancelled', 'running task is cancelled while termination is in flight')
  h.cfg.stopGate.resolve()
  await sleep(20)
  check(!settled, 'termination still waits for session close after stop settles')
  h.cfg.closeGate.resolve()
  const results = await watching
  check(results.every((r) => r.ok === true), 'concurrent duplicate terminations both confirm exit')
  check(h.log.stops.length === 1 && h.log.closes.length === 1, 'stop and close each run exactly once across duplicate calls')
  check(h.runner.sessionCount() === 0, 'session map is empty after termination')
  await h.runner.shutdown()
}

console.log('--- start race: initializing launch and late session ---')
{
  const h = makeHarness({ holdStart: true })
  h.cfg.startGate = defer()
  const task = h.createTask()
  h.runner.enqueue(h.store.get(task.id))
  await waitFor(() => h.log.launches.length === 1, 'backend start entered')
  await sleep(10)
  const stopping = observeTimerCancellation(h.runner.turnWatchdogs.get(task.id)?.timer, () => h.runner.terminateTask(task.id))
  await sleep(30)
  check(h.log.launchStops.length >= 1, 'initializing launch handle is stopped')
  check(h.store.get(task.id).status === 'cancelled', 'task cancelled while its start is still initializing')
  h.cfg.startGate.resolve()
  const { result, cleared } = await stopping
  check(cleared, 'forced watchdog expiry clears its timer before retiring the record')
  check(result.ok === true, 'termination absorbs the late backend start')
  check(h.log.closes.length === 1, 'late session is closed instead of being installed')
  check(h.runner.sessionCount() === 0, 'late session never enters the session map')
  check(h.store.get(task.id).status === 'cancelled', 'late start cannot revive the cancelled task')
  await h.runner.shutdown()
}

console.log('--- failed task pending retry barrier ---')
{
  const h = makeHarness({ failFirst: true })
  const task = h.createTask()
  h.runner.enqueue(h.store.get(task.id))
  await waitFor(() => h.store.get(task.id)?.status === 'failed', 'task failed')
  check(h.store.get(task.id)?.failure?.retryable === true, 'failure is retryable and a retry is pending')
  const result = await h.runner.terminateTask(task.id)
  check(result.ok === true, 'failed task with pending retry terminates')
  check(h.store.get(task.id).status === 'cancelled', 'failed task flips to cancelled')
  await sleep(600)
  check(h.store.get(task.id).status === 'cancelled', 'retry backoff never fires after termination')
  check(h.log.launches.length === 1, 'no retry session was started')
  await h.runner.shutdown()
}

console.log('--- descendants: queued, retry-pending and running children ---')
{
  const h = makeHarness({ failFirst: true })
  const parent = h.createTask({ title: 'parent', parked: true })
  const childA = h.createTask({ title: 'childA', parentTaskId: parent.id, parked: true })
  const childB = h.createTask({ title: 'childB', parentTaskId: parent.id })
  h.runner.enqueue(h.store.get(childB.id))
  await waitFor(() => h.store.get(childB.id)?.status === 'failed', 'childB failed with retry pending')
  const result = await h.runner.terminateTask(parent.id)
  check(result.ok === true, 'parent termination covers queued and retry-pending descendants')
  await sleep(600)
  check(h.store.get(parent.id).status === 'cancelled', 'queued parent cancelled')
  check(h.store.get(childA.id).status === 'cancelled', 'queued descendant cancelled')
  check(h.store.get(childB.id).status === 'cancelled', 'retry-pending descendant cancelled without retrying')
  check(h.log.launches.length === 1, 'descendant retry never launched')
  await h.runner.shutdown()
}
{
  const h = makeHarness({})
  h.cfg.turnGates.worker = defer()
  const parent = h.createTask({ title: 'parent' })
  const child = h.createTask({ title: 'child', parentTaskId: parent.id })
  h.runner.enqueue(h.store.get(parent.id))
  h.runner.enqueue(h.store.get(child.id))
  await waitFor(() => h.runner.sessionCount() === 2, 'both sessions running')
  const result = await h.runner.terminateTask(parent.id)
  check(result.ok === true, 'running parent termination waits for running descendant')
  check(h.store.get(parent.id).status === 'cancelled' && h.store.get(child.id).status === 'cancelled', 'parent and running descendant both cancelled')
  check(h.log.stops.length === 2 && h.log.closes.length === 2, 'every descendant session stopped and closed')
  check(h.runner.sessionCount() === 0, 'no descendant session leaks')
  await h.runner.shutdown()
}

console.log('--- replaced run is never killed ---')
{
  const h = makeHarness({})
  h.cfg.turnGates.worker = defer()
  const task = h.createTask()
  h.runner.enqueue(h.store.get(task.id))
  await waitFor(() => h.runner.sessionCount() === 1, 'session running')
  h.store.updateIf(task.id, {}, { executionOwner: { pid: process.pid, instance: 'foreign-host', token: 'foreign-token' } })
  const result = await h.runner.terminateTask(task.id)
  check(result.ok === false && /执行归属/.test(result.error ?? ''), 'termination refuses a run this runner no longer owns')
  check(h.store.get(task.id).status === 'running', 'replaced run keeps its running state')
  check(h.log.stops.length === 0 && h.log.closes.length === 0, 'replaced run session is not stopped or closed')
  h.cfg.turnGates.worker.resolve()
  await h.runner.shutdown()
}

console.log('--- meeting guard regression: stop, delete-intent, revival and natural end ---')
{
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-term-meeting-'))
  const store = new TaskStore(data)
  const service = new TaskService({ store })
  const log = { launches: [], launchStops: [], stops: [], closes: [] }
  const cfg = { holdStart: false, startGate: null, stopGate: null, stopDelay: 0, closeGate: null, closeFails: false, failFirst: false, turnGates: {} }
  const backend = makeBackend(cfg, log)
  const runner = new TaskRunner(store, new Map([[backend.id, backend]]), () => ({ concurrency: 4, workerConcurrency: 4, mode: 'yolo', notify: false }))
  const agents = [
    { id: 'alpha', name: 'Alpha', backend: backend.id, role: '队长' },
    { id: 'beta', name: 'Beta', backend: backend.id, role: '队长' },
    { id: 'gamma', name: 'Gamma', backend: backend.id, role: '队长' }
  ]
  runner.attachTeam(() => agents)
  const offices = new AgentSessionRegistry({ store, taskService: service, runner, getAgents: () => agents, waitPollMs: 5, waitTimeoutMs: 5_000 })
  const meetingStore = new MeetingStore(data)
  const controller = new MeetingController({
    store: meetingStore, offices, getAgents: () => agents, taskService: service,
    issueExists: () => true, taskStore: store,
    cancelTask: (taskId) => runner.terminateTask(taskId),
    addIssueComment: () => {}
  })
  runner.attachMeetingGuard((task) => controller.canRunTask(task))

  const meeting = controller.create({
    issueId: 'iss_stop', topic: 'stop barrier', maxRounds: 2,
    participants: [
      { agentId: 'alpha', role: 'reporter' }, { agentId: 'beta', role: 'critic' }, { agentId: 'gamma', role: 'designer' }
    ]
  })
  cfg.turnGates.alpha = defer()
  const started = controller.start(meeting.id)
  await waitFor(() => store.list().some((t) => t.meetingId === meeting.id && t.status === 'running'), 'member execution in flight')
  const stopped = await controller.cancel(meeting.id)
  check(stopped.ok === true, 'meeting stop confirms every member execution exit via terminateTask')
  const membersAfterStop = store.list().filter((t) => t.meetingId === meeting.id)
  check(membersAfterStop.length >= 1 && membersAfterStop.every((t) => t.status === 'cancelled'), 'in-flight member is cancelled')
  check(runner.sessionCount() === 0, 'member session is stopped and closed after stop')

  const revival = await runner.followUp(membersAfterStop[0].id, 'continue anyway')
  check(revival.ok === false, 'stopped meeting member session cannot be revived by follow-up')
  let registryRefused = false
  try { registryRefused = (await offices.followUp('beta', 'hello', { meetingId: meeting.id })).ok !== true } catch { registryRefused = true }
  check(registryRefused, 'registry follow-up on a stopped meeting is refused')
  const zombie = service.createTask({
    title: 'Beta·会议成员', prompt: 'session bootstrap', backend: backend.id, agentId: 'beta',
    trigger: 'meeting', suppressIssue: true, titleAuto: false, officeAgentId: 'beta',
    meetingId: meeting.id, meetingTaskRole: 'member'
  })
  runner.enqueue(store.get(zombie.id))
  await sleep(20)
  check(store.get(zombie.id)?.status === 'cancelled', 'guard cancels freshly enqueued member tasks of the stopped meeting')
  const investigation = await runner.spawnInvestigateChild(membersAfterStop[0].id, { to: 'Gamma', prompt: 'look into it' })
  check(investigation === null, 'stopped meeting cannot spawn new investigations')
  const container = service.createTask({ title: 'container', prompt: 'c', backend: backend.id, meetingId: meeting.id, meetingTaskRole: 'container' })
  runner.enqueue(store.get(container.id))
  await sleep(20)
  const containerAfter = store.get(container.id)
  check(containerAfter.status === 'queued' && containerAfter.parked === true, 'meeting container is re-parked instead of executed or cancelled')
  const after = await started
  check(after.meeting?.status === 'cancelled' && controller.get(meeting.id)?.stopState === undefined, 'meeting run settles into cancelled without a stuck stop state')
  delete cfg.turnGates.alpha

  const meeting2 = controller.create({
    issueId: 'iss_end', topic: 'natural end', maxRounds: 1,
    participants: [
      { agentId: 'alpha', role: 'reporter' }, { agentId: 'beta', role: 'critic' }, { agentId: 'gamma', role: 'designer' }
    ]
  })
  const concluded = await controller.start(meeting2.id)
  check(concluded.ok === true && concluded.meeting?.status === 'concluded', 'natural conclusion gathers internal execution through terminateTask')
  const members2 = store.list().filter((t) => t.meetingId === meeting2.id)
  check(members2.length === 3 && members2.every((t) => t.status === 'done' && !!t.result), 'concluded member results are preserved verbatim')
  check(runner.sessionCount() === 0, 'idle member sessions are closed after natural conclusion')
  await runner.shutdown()
}

if (process.exitCode) process.exit(1)
console.log('--- parent exit can depend on descendant termination ---')
{
  const h = makeHarness({ turnGates: { worker: defer() } }, { terminationTimeoutMs: 50 })
  const parent = h.createTask({ title: 'delegating parent', parked: true })
  const child = h.createTask({ title: 'dependent child', parentTaskId: parent.id })
  h.runner.enqueue(h.store.get(child.id))
  await waitFor(() => h.runner.sessions.has(child.id), 'dependent child session ready')
  const waiting = defer()
  h.runner.activeRuns.set(parent.id, waiting.promise)
  const session = h.runner.sessions.get(child.id)
  const originalClose = session.close.bind(session)
  session.close = async () => { await originalClose(); waiting.resolve() }
  const result = await h.runner.terminateTask(parent.id)
  check(result.ok && h.store.get(child.id).status === 'cancelled', 'children stop before the parent exit barrier waits on their completion')
  check(h.log.closes.length === 1, 'dependent child closes exactly once')
  await h.runner.shutdown()
}
console.log('--- rejected close is retained and retried ---')
{
  const h = makeHarness({}, { terminationTimeoutMs: 40 })
  const task = h.createTask()
  h.runner.enqueue(h.store.get(task.id))
  await waitFor(() => h.store.get(task.id)?.status === 'done', 'idle task done')
  const session = h.runner.sessions.get(task.id)
  let attempts = 0
  session.close = async () => { attempts++; return attempts > 1 ? undefined : false }
  const rejected = await h.runner.terminateTask(task.id)
  check(!rejected.ok && /退出未确认/.test(rejected.error), 'primitive false close cannot become successful termination')
  check(!h.runner.isIdle(), 'failed termination keeps an observable cleanup target')
  const retried = await h.runner.terminateTask(task.id)
  check(retried.ok && attempts === 2, 'retry closes the retained session instead of ignoring a missing session map')
  check(h.store.get(task.id).terminatedRunId === h.store.get(task.id).runId, 'verified exit is durably tied to its run')
  await h.runner.shutdown()
}

console.log('--- completed board is idle for hot-update apply ---')
{
  const h = makeHarness()
  // 历史修复点一（e02dc0a）：done 任务常驻活会话不算忙
  const plain = h.createTask()
  h.runner.enqueue(h.store.get(plain.id))
  await waitFor(() => h.store.get(plain.id)?.status === 'done', 'plain task done')
  check(h.runner.sessionCount() === 1, 'done task keeps its live session for follow-ups')
  // 历史修复点二（retired 台账）：会议成员换基线续聊重建后留下的 detach 台账不算忙
  const member = h.createTask({ meetingId: 'ledger-scope', meetingTaskRole: 'member', suppressIssue: true, workdir: path.join(h.data, 'round-1') })
  h.runner.enqueue(h.store.get(member.id))
  await waitFor(() => h.store.get(member.id)?.status === 'done', 'member task done')
  check(!h.store.get(member.id).issueId, 'meeting member runs on the meeting-owned issue without creating its own')
  const live = h.runner.sessions.get(member.id)
  check(!!live, 'done member task keeps its live session for follow-ups')
  let detached = 0
  live.detach = async () => { detached++ }
  h.store.update(member.id, { workdir: path.join(h.data, 'round-2') })
  const followUp = await h.runner.followUp(member.id, '第二轮发言')
  check(followUp.ok && h.store.get(member.id)?.status === 'done', 'rebased member follow-up rebuilds the session and completes the round')
  check(detached === 1 && h.log.closes.length === 0, 'rebuild detaches the provider session instead of closing it')
  check(h.runner.sessions.get(member.id) !== live, 'the second round runs on a fresh resumed session')
  const ledger = [...h.runner.retiredProviderSessions.values()].filter((entry) => entry.taskId === member.id)
  check(ledger.length === 1, 'retired ledger records the detached provider session')
  check(h.store.list().every((t) => t.status === 'done') && h.runner.isIdle(), 'all-done board with live sessions and a retired ledger is idle')
  await h.runner.forget(member.id)
  check(h.runner.retiredProviderSessions.size === 0, 'forget drops ledger entries nothing can consume anymore')
  check(h.runner.isIdle(), 'idle verdict survives the ledger purge')
  await h.runner.shutdown()
}

console.log('--- pending close is not forgotten after timeout ---')
{
  const h = makeHarness({ closeGate: defer() }, { terminationTimeoutMs: 30 })
  const task = h.createTask({ meetingId: 'timeout-scope', meetingTaskRole: 'member', suppressIssue: true })
  h.runner.enqueue(h.store.get(task.id))
  await waitFor(() => h.store.get(task.id)?.status === 'done', 'timeout task done')
  check(!(await h.runner.terminateTask(task.id)).ok, 'hung close reports a timeout')
  check(!(await h.runner.terminateTask(task.id)).ok, 'a second stop cannot claim success while the same close is pending')
  check(h.log.closes.length === 1, 'pending close is not issued twice')
  const restored = new TaskRunner(new TaskStore(h.data), new Map([[h.backend.id, h.backend]]), () => ({ concurrency: 1, mode: 'yolo', notify: false }))
  const unknown = await restored.terminateTask(task.id)
  check(!unknown.ok && /历史会议执行退出未确认/.test(unknown.error), 'restart without exit proof retains unconfirmed historical execution')
  await restored.shutdown()
  h.cfg.closeGate.resolve()
  await sleep(10)
  check((await h.runner.terminateTask(task.id)).ok, 'stop succeeds only after the pending close actually finishes')
  const confirmed = new TaskRunner(new TaskStore(h.data), new Map([[h.backend.id, h.backend]]), () => ({ concurrency: 1, mode: 'yolo', notify: false }))
  check((await confirmed.terminateTask(task.id)).ok, 'persisted exit proof permits idempotent cleanup after restart')
  await confirmed.shutdown()
  await h.runner.shutdown()
}

console.log('--- naturally failed run durably proves its own exit ---')
{
  // 实战事故（meeting_muvfy1ar）：claude 成员任务 spawn ENAMETOOLONG 落败后，
  // 会议停止被「历史会议执行退出未确认」永久拒停——失败由本运行器亲眼观察，
  // 必须随失败落盘退出证明，停止才收得了口。
  const h = makeHarness({ failFirst: true, failError: 'spawn ENAMETOOLONG' })
  const task = h.createTask({ meetingId: 'fail-proof', meetingTaskRole: 'member', suppressIssue: true })
  h.runner.enqueue(h.store.get(task.id))
  await waitFor(() => h.store.get(task.id)?.status === 'failed', 'member task failed at spawn')
  const record = h.store.get(task.id)
  check(record.runId && record.terminatedRunId === record.runId, 'failure writes the durable exit proof for its own run')
  const stopped = await h.runner.terminateTask(task.id)
  check(stopped.ok, 'naturally failed member task stops without the historical-execution refusal')
  check(h.store.get(task.id).status === 'failed', 'stop of a failed task keeps the recorded failure')
  await h.runner.shutdown()
}

console.log('--- dead execution owner cannot deadlock the meeting stop ---')
{
  // owner 进程已死时没有谁能补上退出确认：拒停是永久死锁（会议停不掉也删不掉），
  // 必须放行收尾；owner 存活且无凭据的拒停由上一节的 'unknown' 检查继续守住。
  const h = makeHarness()
  const task = h.createTask({ meetingId: 'dead-owner', meetingTaskRole: 'member', suppressIssue: true })
  h.runner.enqueue(h.store.get(task.id))
  await waitFor(() => h.store.get(task.id)?.status === 'done', 'member task done')
  const done = h.store.get(task.id)
  // 伪造前一进程的 owner：真实已退出的子进程 pid——探活必判 dead（ESRCH）
  const dead = childProcess.spawnSync(process.execPath, ['-e', 'process.exit(0)'])
  h.store.update(task.id, { executionOwner: { pid: dead.pid, instance: '10995116277761234', token: 'foreign', leaseExpiresAt: Date.now() + 30_000 } })
  check(h.store.get(task.id).runId === done.runId, 'forged owner keeps the run identity intact')
  const foreign = new TaskRunner(h.store, new Map([[h.backend.id, h.backend]]), () => ({ concurrency: 1, mode: 'yolo', notify: false }))
  const stopped = await foreign.terminateTask(task.id)
  check(stopped.ok, 'dead owner without exit proof no longer blocks the stop')
  check(h.store.get(task.id).terminatedRunId === done.runId, 'the stop records the exit proof it was waiting for')
  await foreign.shutdown()
  await h.runner.shutdown()
}

console.log('--- failed epoch commit must not strand the run registration ---')
{
  // 审码判官 P1：start() 先登记 runs 再提交 epoch，提交抛错时登记无人清理——
  // 停止永远等不到 done，「会议调度尚未退出」永久拒停拒删。修复后 finally 兜底撤销。
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-term-epoch-'))
  const store = new TaskStore(data)
  const service = new TaskService({ store })
  const log = { launches: [], launchStops: [], stops: [], closes: [] }
  const cfg = { holdStart: false, startGate: null, stopGate: null, stopDelay: 0, closeGate: null, closeFails: false, failFirst: false, turnGates: {} }
  const backend = makeBackend(cfg, log)
  const runner = new TaskRunner(store, new Map([[backend.id, backend]]), () => ({ concurrency: 4, workerConcurrency: 4, mode: 'yolo', notify: false }))
  const agents = [
    { id: 'alpha', name: 'Alpha', backend: backend.id, role: '队长' },
    { id: 'beta', name: 'Beta', backend: backend.id, role: '队长' },
    { id: 'gamma', name: 'Gamma', backend: backend.id, role: '队长' }
  ]
  runner.attachTeam(() => agents)
  class FlakyEpochStore extends MeetingStore {
    constructor(dir) { super(dir); this.failEpochOnce = false }
    update(id, patch) {
      if (this.failEpochOnce && patch?.executionEpoch !== undefined && patch.status === undefined) {
        this.failEpochOnce = false
        throw new Error('transient meeting index write failure')
      }
      return super.update(id, patch)
    }
  }
  const offices = new AgentSessionRegistry({ store, taskService: service, runner, getAgents: () => agents, waitPollMs: 5, waitTimeoutMs: 5_000 })
  const meetingStore = new FlakyEpochStore(data)
  const controller = new MeetingController({
    store: meetingStore, offices, getAgents: () => agents, taskService: service,
    issueExists: () => true, taskStore: store,
    cancelTask: (taskId) => runner.terminateTask(taskId),
    addIssueComment: () => {}
  })
  const meeting = controller.create({
    issueId: 'iss_epoch', topic: 'epoch commit failure', maxRounds: 1,
    participants: [
      { agentId: 'alpha', role: 'reporter' }, { agentId: 'beta', role: 'critic' }, { agentId: 'gamma', role: 'designer' }
    ]
  })
  meetingStore.failEpochOnce = true
  let startError = ''
  await controller.start(meeting.id).catch((error) => { startError = String(error?.message ?? error) })
  check(startError.includes('transient meeting index write failure'), 'start surfaces the transient epoch commit failure')
  check(controller.get(meeting.id)?.status === 'waiting_user', 'epoch commit failure rolls back to a resumable status instead of an active orphan')
  const stopped = await controller.cancel(meeting.id)
  check(stopped.ok === true, 'meeting is still stoppable after a failed start (no stranded run registration)')
  check(controller.get(meeting.id).stopState === undefined, 'stop completes and clears stopState instead of waiting forever')
  await runner.shutdown()
}

console.log('--- resume settles a failed stop instead of bouncing the user ---')
{
  // 实战（meeting_muvpfggz）：预算暂停后终止余波 taskkill 128 → stopState=failed，
  // resume 一律拒绝「请先完成会议停止或删除」——继续按钮看得见按不动。
  // 修复：resume 对 failed 确认先自动收口；recover 不把暂停态翻成取消。
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-term-resume-'))
  const store = new TaskStore(data)
  const service = new TaskService({ store })
  const log = { launches: [], launchStops: [], stops: [], closes: [] }
  const cfg = { holdStart: false, startGate: null, stopGate: null, stopDelay: 0, closeGate: null, closeFails: false, failFirst: false, turnGates: {} }
  const backend = makeBackend(cfg, log)
  const runner = new TaskRunner(store, new Map([[backend.id, backend]]), () => ({ concurrency: 4, workerConcurrency: 4, mode: 'yolo', notify: false }))
  const agents = [
    { id: 'alpha', name: 'Alpha', backend: backend.id, role: '队长' },
    { id: 'beta', name: 'Beta', backend: backend.id, role: '队长' },
    { id: 'gamma', name: 'Gamma', backend: backend.id, role: '队长' }
  ]
  runner.attachTeam(() => agents)
  const offices = new AgentSessionRegistry({ store, taskService: service, runner, getAgents: () => agents, waitPollMs: 5, waitTimeoutMs: 5_000 })
  const meetingStore = new MeetingStore(data)
  const controller = new MeetingController({
    store: meetingStore, offices, getAgents: () => agents, taskService: service,
    issueExists: () => true, taskStore: store,
    cancelTask: (taskId) => runner.terminateTask(taskId),
    addIssueComment: () => {}
  })
  runner.attachMeetingGuard((task) => controller.canRunTask(task))
  const participants = [
    { agentId: 'alpha', role: 'reporter' }, { agentId: 'beta', role: 'critic' }, { agentId: 'gamma', role: 'designer' }
  ]

  // 恢复路径：waiting_user + failed 确认 → 只收口停止账，不得翻成取消
  const paused = controller.create({ issueId: 'iss_rec', topic: 'recover keeps the pause', maxRounds: 1, maxDurationMs: 8_000, participants })
  meetingStore.update(paused.id, { status: 'waiting_user', stopState: 'failed', stopReason: 'budget', blockedReason: '终止余波失败' })
  controller.recover()
  await waitFor(() => controller.get(paused.id)?.stopState === undefined, 'recovery settles the failed stop')
  check(controller.get(paused.id)?.status === 'waiting_user', 'recovery never cancels a paused meeting to finish its stop')

  // 继续路径：resume 自动收口 failed 确认后照常续跑
  const stuck = controller.create({ issueId: 'iss_res', topic: 'resume settles the stop', maxRounds: 1, maxDurationMs: 8_000, participants })
  meetingStore.update(stuck.id, { status: 'waiting_user', stopState: 'failed', stopReason: 'budget', blockedReason: '终止余波失败' })
  const resumed = await controller.resume(stuck.id)
  check(resumed.ok === true, 'resume auto-settles the failed stop instead of refusing')
  const afterResume = controller.get(stuck.id)
  check(!!afterResume && afterResume.stopState === undefined && ['concluded', 'waiting_user', 'failed', 'cancelled'].includes(afterResume.status), 'resumed meeting runs to a settled state with no lingering stop')
  // stopState=stopping（真正在途的停止）仍然拒绝——那不是自动收口能替的
  const inFlightStop = controller.create({ issueId: 'iss_stp', topic: 'stopping is respected', maxRounds: 1, maxDurationMs: 8_000, participants })
  meetingStore.update(inFlightStop.id, { status: 'waiting_user', stopState: 'stopping' })
  const refused = await controller.resume(inFlightStop.id)
  check(!refused.ok && refused.error === '请先完成会议停止或删除', 'an in-flight stop (stopping) still refuses resume')
  await runner.shutdown()
}

console.log('--- container projection failure cannot skip member termination ---')
{
  // 审码判官扫雷 P0：cancel 的停止意图落盘后，syncContainer 投影抛错会让 cancel
  // 整个中断——成员执行没收到终止，落盘却是无人在途的 stopState=stopping。
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-term-proj-'))
  const store = new TaskStore(data)
  const service = new TaskService({ store })
  const log = { launches: [], launchStops: [], stops: [], closes: [] }
  const cfg = { holdStart: false, startGate: null, stopGate: null, stopDelay: 0, closeGate: null, closeFails: false, failFirst: false, turnGates: {} }
  const backend = makeBackend(cfg, log)
  const runner = new TaskRunner(store, new Map([[backend.id, backend]]), () => ({ concurrency: 4, workerConcurrency: 4, mode: 'yolo', notify: false }))
  const agents = [
    { id: 'alpha', name: 'Alpha', backend: backend.id, role: '队长' },
    { id: 'beta', name: 'Beta', backend: backend.id, role: '队长' },
    { id: 'gamma', name: 'Gamma', backend: backend.id, role: '队长' }
  ]
  runner.attachTeam(() => agents)
  const offices = new AgentSessionRegistry({ store, taskService: service, runner, getAgents: () => agents, waitPollMs: 5, waitTimeoutMs: 5_000 })
  const meetingStore = new MeetingStore(data)
  const container = service.createTask({ title: 'container', prompt: 'x', backend: backend.id })
  // 容器投影每次写都炸：投影是权威提交的下游，绝不能阻断停止流程
  const throwingTaskStore = {
    get: (id) => store.get(id),
    list: () => store.list(),
    update: (id, patch) => {
      throw new Error('container projection write failed')
    }
  }
  const controller = new MeetingController({
    store: meetingStore, offices, getAgents: () => agents, taskService: service,
    issueExists: () => true, taskStore: throwingTaskStore,
    cancelTask: (taskId) => taskId === container.id ? Promise.resolve({ ok: true }) : runner.terminateTask(taskId),
    addIssueComment: () => {}
  })
  const meeting = controller.create({
    issueId: 'iss_proj', topic: 'projection isolation', maxRounds: 1, maxDurationMs: 8_000,
    participants: [
      { agentId: 'alpha', role: 'reporter' }, { agentId: 'beta', role: 'critic' }, { agentId: 'gamma', role: 'designer' }
    ]
  })
  meetingStore.update(meeting.id, { ownsIssue: true, containerTaskId: container.id })
  store.update(container.id, { meetingId: meeting.id, meetingTaskRole: 'container' })
  cfg.turnGates.alpha = defer()
  const started = controller.start(meeting.id)
  await waitFor(() => store.list().some((t) => t.meetingId === meeting.id && t.status === 'running'), 'member execution in flight')
  const stopped = await controller.cancel(meeting.id)
  check(stopped.ok === true, 'cancel survives a throwing container projection')
  check(store.list().every((t) => t.meetingId !== meeting.id || t.status !== 'running'), 'member executions were still terminated')
  check(controller.get(meeting.id)?.stopState === undefined, 'stop settles cleanly despite projection errors')
  cfg.turnGates.alpha.resolve()
  await started
  await runner.shutdown()
}

console.log('--- failed delete re-enables the retry buttons ---')
{
  // 审码判官扫雷 P0：deleting=true 落盘后删除失败，UI 停止/删除全被禁用，
  // 本会话无重试入口，只能重启 recover。
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-term-del-'))
  const store = new TaskStore(data)
  const service = new TaskService({ store })
  const log = { launches: [], launchStops: [], stops: [], closes: [] }
  const cfg = { holdStart: false, startGate: null, stopGate: null, stopDelay: 0, closeGate: null, closeFails: false, failFirst: false, turnGates: {} }
  const backend = makeBackend(cfg, log)
  const runner = new TaskRunner(store, new Map([[backend.id, backend]]), () => ({ concurrency: 4, workerConcurrency: 4, mode: 'yolo', notify: false }))
  const agents = [{ id: 'alpha', name: 'Alpha', backend: backend.id, role: '队长' }, { id: 'gamma', name: 'Gamma', backend: backend.id, role: '队长' }]
  runner.attachTeam(() => agents)
  const offices = new AgentSessionRegistry({ store, taskService: service, runner, getAgents: () => agents, waitPollMs: 5, waitTimeoutMs: 5_000 })
  const meetingStore = new MeetingStore(data)
  const controller = new MeetingController({
    store: meetingStore, offices, getAgents: () => agents, taskService: service,
    issueExists: () => true, taskStore: store,
    cancelTask: (taskId) => runner.terminateTask(taskId),
    addIssueComment: () => {},
    deleteTaskData: async () => ({ ok: false, error: 'worktree cleanup failed' })
  })
  const meeting = controller.create({ issueId: 'iss_del', topic: 'delete retry', maxRounds: 1, maxDurationMs: 8_000, participants: [{ agentId: 'alpha', role: 'reporter' }, { agentId: 'gamma', role: 'designer' }] })
  meetingStore.update(meeting.id, { status: 'waiting_user' })
  const failed = await controller.delete(meeting.id)
  check(failed.ok === false, 'delete surfaces the cleanup failure')
  // deleting 保留（重启恢复续删依据），失败改标 deleteFailed 供 UI 放开重试按钮
  check(controller.get(meeting.id)?.deleting === true && controller.get(meeting.id)?.deleteFailed === true, 'a failed delete keeps the durable deleting marker and flags deleteFailed for UI retry')
  const retried = await controller.delete(meeting.id)
  check(retried.ok === false && controller.get(meeting.id)?.deleteFailed === true, 'delete can be retried in-session (flag re-armed on the new failure)')
  await runner.shutdown()
}

console.log('--- a concurrent stop wins over an in-flight resume settle ---')
{
  // 审码判官扫雷 P1：resume 的自动收口 await 期间用户点了停止——旧 resume 不复核，
  // 会把已取消的会议复活成 active 并跑起新调度器。
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-term-race-'))
  const store = new TaskStore(data)
  const service = new TaskService({ store })
  const log = { launches: [], launchStops: [], stops: [], closes: [] }
  const cfg = { holdStart: false, startGate: null, stopGate: null, stopDelay: 0, closeGate: null, closeFails: false, failFirst: false, turnGates: {} }
  const backend = makeBackend(cfg, log)
  const runner = new TaskRunner(store, new Map([[backend.id, backend]]), () => ({ concurrency: 4, workerConcurrency: 4, mode: 'yolo', notify: false }))
  const agents = [{ id: 'alpha', name: 'Alpha', backend: backend.id, role: '队长' }, { id: 'gamma', name: 'Gamma', backend: backend.id, role: '队长' }]
  runner.attachTeam(() => agents)
  const offices = new AgentSessionRegistry({ store, taskService: service, runner, getAgents: () => agents, waitPollMs: 5, waitTimeoutMs: 5_000 })
  const meetingStore = new MeetingStore(data)
  const settleGate = defer()
  let gateOnce = true
  const controller = new MeetingController({
    store: meetingStore, offices, getAgents: () => agents, taskService: service,
    issueExists: () => true, taskStore: store,
    cancelTask: (taskId) => (gateOnce ? (gateOnce = false, settleGate.promise.then(() => runner.terminateTask(taskId))) : runner.terminateTask(taskId)),
    addIssueComment: () => {}
  })
  const meeting = controller.create({ issueId: 'iss_race', topic: 'stop beats resume', maxRounds: 1, maxDurationMs: 8_000, participants: [{ agentId: 'alpha', role: 'reporter' }, { agentId: 'gamma', role: 'designer' }] })
  const member = service.createTask({ title: 'member', prompt: 'x', backend: backend.id, meetingId: meeting.id, meetingTaskRole: 'member', suppressIssue: true })
  store.update(member.id, { status: 'done', sessionId: 's-done' })
  meetingStore.update(meeting.id, { status: 'waiting_user', stopState: 'failed', stopReason: 'budget', blockedReason: '终止余波失败' })
  const resuming = controller.resume(meeting.id)
  await sleep(30)
  const cancelling = controller.cancel(meeting.id)
  settleGate.resolve()
  const [resumed, cancelled] = await Promise.all([resuming, cancelling])
  check(cancelled.ok === true, 'the concurrent stop completes')
  check(resumed.ok === false, 'the stale resume yields instead of resurrecting the meeting')
  check(controller.get(meeting.id)?.status === 'cancelled' && !controller.running.has(meeting.id), 'meeting stays cancelled with no resurrected scheduler')
  await runner.shutdown()
}

console.log('--- scoped late-start cleanup never drops failure ---')
{
  const executor = new Executor()
  const start = defer()
  const timeout = defer()
  const unrelated = defer()
  let accepted = true
  let rejectClose = true
  let closeCalls = 0
  const opening = executor.start(() => start.promise, timeout.promise, () => accepted, 'meeting-a')
  accepted = false
  timeout.resolve({ ok: false, response: '', error: 'cancelled start' })
  await opening.catch(() => {})
  executor.registerCleanup('meeting-b', () => unrelated.promise)
  let settled = false
  const draining = executor.drain('meeting-a').then(() => { settled = true; return true }, () => { settled = true; return false })
  await sleep(2_050)
  check(!settled, 'late session remains pending beyond the old two-second cleanup window')
  start.resolve({ async close() { closeCalls++; if (rejectClose) throw new Error('late close rejected') } })
  check(!await draining, 'late session close rejection propagates through the strict drain')
  check(closeCalls === 1 && !executor.isIdle(), 'failed late cleanup remains registered for retry')
  rejectClose = false
  await executor.drain('meeting-a')
  check(closeCalls === 2, 'late close failure can retry without restarting the backend')
  check(!executor.isIdle(), 'scoped drain does not consume another meeting cleanup')
  unrelated.resolve()
  await executor.drain('meeting-b')
  check(executor.isIdle(), 'all cleanup records disappear only after verified completion')
  await executor.shutdown()
}

if (process.platform === 'win32') {
  console.log('--- process tree kill: root verifiably gone beats kill failure ---')
  const child = Object.assign(new EventEmitter(), { pid: 123456, exitCode: null, signalCode: null })
  const killer = new EventEmitter()
  const originalSpawn = childProcess.spawn
  childProcess.spawn = () => killer
  try {
    // 语义演进（原「closed root 不能掩盖失败树杀」）：杀失败但根进程已可验证退出
    // （exitCode 已落）= 无可杀即已杀灭。一次性 CLI 的回合结果先于进程退出到达，
    // 紧接的终止会让 taskkill 撞上「进程刚死」窗口（实战 128/255 均见，曾以
    // 「初始化中止: taskkill exited 128」卡死预算暂停后的继续按钮）。
    const killing = killProcessTree(child)
    child.exitCode = 0
    child.emit('close', 0)
    killer.emit('close', 1)
    check((await killing).ok, 'a kill failure on a verifiably-exited root counts as killed')
    check((await killProcessTree(child)).ok, 'a failed kill result is retryable after verified process exit')
    // 根进程未见退出（可能还活着）时杀失败仍是失败——那里才存在真杀不掉的风险
    const aliveChild = Object.assign(new EventEmitter(), { pid: 123457, exitCode: null, signalCode: null })
    const aliveKiller = new EventEmitter()
    childProcess.spawn = () => aliveKiller
    const killingAlive = killProcessTree(aliveChild)
    aliveChild.emit('close', null)
    aliveKiller.emit('close', 1)
    check(!(await killingAlive).ok, 'a kill failure without exit proof on the root is still a failure')
  } finally { childProcess.spawn = originalSpawn }
}

if (process.exitCode) throw new Error('meeting termination regression failed')
console.log('\n✅ MEETING TERMINATION SMOKE PASSED')
