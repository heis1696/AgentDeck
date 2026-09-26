// Business-brain sidecar smoke: loopback auth, protocol handshake, sticky
// state, authoritative sync, ownership-checked takeover, deletion protection,
// a real two-entry takeover race, and the three manual start entries.
//
// Everything runs against temporary data directories. The sidecar child is a
// real process (SidecarManager) and the execution-owner fixtures are real
// process identities: the dead one is a stopped child, the live one is this
// process with an already expired lease.
import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-sidecar-'))
const serverOut = path.join(tmp, 'sidecar-server.cjs')
const managerOut = path.join(tmp, 'sidecar-manager.cjs')
const runnerOut = path.join(tmp, 'sidecar-runner.cjs')
const storeOut = path.join(tmp, 'sidecar-store.cjs')
const persistenceOut = path.join(tmp, 'sidecar-persistence.cjs')
const ipcOut = path.join(tmp, 'sidecar-ipc-tasks.cjs')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const assert = (condition, message) => { if (!condition) { console.error('❌', message); process.exit(1) } }
async function until(predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return true
    if (Date.now() > deadline) return false
    await sleep(25)
  }
}

// The real sidecar entry point with only its provider replaced: the standalone
// server keeps every other dependency, including its own TaskStore/TaskRunner.
const fakeZcodePlugin = {
  name: 'smoke-fake-zcode',
  setup(build) {
    build.onResolve({ filter: /backends\/zcode$/ }, () => ({ path: 'zcode', namespace: 'smoke-zcode' }))
    build.onLoad({ filter: /.*/, namespace: 'smoke-zcode' }, () => ({
      loader: 'js',
      contents: `
        const state = (globalThis.__smokeZcode ??= { starts: 0 })
        export const createZcodeBackend = () => ({
          id: 'zcode',
          label: 'smoke zcode',
          async probe() { return { ok: true, detail: 'smoke' } },
          async start({ events }) {
            state.starts++
            setTimeout(() => {
              events.onEvent({ ts: Date.now(), kind: 'final', text: 'smoke zcode done' })
              events.onTurnEnd({ ok: true, response: 'smoke zcode done' })
            }, 30)
            return { sessionId: 'smoke_' + state.starts, async send() {}, async stop() {}, async close() {} }
          }
        })
      `
    }))
  }
}

// The desktop IPC entry point with only electron replaced, so the real handler
// bodies (start / move / delete) run against the real stores and runner.
const electronStub = {
  name: 'smoke-electron-stub',
  setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'smoke-electron' }))
    build.onLoad({ filter: /.*/, namespace: 'smoke-electron' }, () => ({
      loader: 'js',
      contents: `
        globalThis.__smokeHandlers = new Map()
        export const ipcMain = { handle: (name, fn) => globalThis.__smokeHandlers.set(name, fn) }
        export const BrowserWindow = { getAllWindows: () => [] }
      `
    }))
  }
}

await build({ entryPoints: [path.join(root, 'src/main/sidecar-server.ts')], outfile: serverOut, bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['electron'], plugins: [fakeZcodePlugin] })
await build({ entryPoints: [path.join(root, 'src/main/sidecar.ts')], outfile: managerOut, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
await build({ entryPoints: [path.join(root, 'src/main/runner.ts')], outfile: runnerOut, bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['electron'] })
await build({ entryPoints: [path.join(root, 'src/main/store.ts')], outfile: storeOut, bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['electron'] })
await build({ entryPoints: [path.join(root, 'src/main/persistence.ts')], outfile: persistenceOut, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
await build({ entryPoints: [path.join(root, 'src/main/ipc/tasks.ts')], outfile: ipcOut, bundle: true, platform: 'node', format: 'cjs', target: 'node18', plugins: [electronStub] })

const { SidecarManager, SIDECAR_DIAGNOSTIC_FILE, SIDECAR_DIAGNOSTIC_LIMIT, SIDECAR_DIAGNOSTIC_LINE_LIMIT, SIDECAR_STDERR_TAIL_LINES } = await import(pathToFileURL(managerOut).href)
const { startSidecarServer } = await import(pathToFileURL(serverOut).href)
const { TaskRunner } = await import(pathToFileURL(runnerOut).href)
const { TaskStore } = await import(pathToFileURL(storeOut).href)
const { registerTaskIpc } = await import(pathToFileURL(ipcOut).href)
const { probeProcess, processOwnerState, currentProcessIdentity } = await import(pathToFileURL(persistenceOut).href)

/** A real, provably dead execution identity: observe a live child, then stop it. */
async function deadExecutionOwner() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true })
  let observed
  for (let i = 0; i < 120; i++) {
    observed = probeProcess(child.pid)
    if (observed.state === 'alive' && observed.instance) break
    await sleep(50)
  }
  if (observed?.state !== 'alive' || !observed.instance) {
    child.kill()
    throw new Error(`cannot observe a strong child process identity on ${process.platform}: ${JSON.stringify(observed)}`)
  }
  child.kill()
  await new Promise((resolve) => child.on('exit', resolve))
  const owner = { pid: child.pid, instance: observed.instance, token: 'dead-sidecar-owner', leaseExpiresAt: Date.now() - 60_000 }
  if (processOwnerState(owner) !== 'dead') throw new Error('the stopped child is not proven dead; refusing to build the fixture')
  return owner
}

function taskDir(userDataDir, id) { return path.join(userDataDir, 'tasks', id) }

// Three running records with different ownership evidence, plus a queued task.
const deadOwner = await deadExecutionOwner()
// An expired lease is not death evidence: this process is still genuinely alive.
const liveOwner = { ...currentProcessIdentity(), token: 'live-sidecar-owner', leaseExpiresAt: Date.now() - 60_000 }
const fixture = new TaskStore(tmp)
const unknownRun = fixture.create({ title: 'orphan', prompt: 'resume', workdir: '', backend: 'fake' })
fixture.update(unknownRun.id, { status: 'running', runId: 'run-orphan', startedAt: Date.now() })
const deadRun = fixture.create({ title: 'dead', prompt: 'resume', workdir: '', backend: 'fake' })
fixture.update(deadRun.id, { status: 'running', runId: 'run-dead', startedAt: Date.now(), executionOwner: deadOwner })
const liveRun = fixture.create({ title: 'live', prompt: 'resume', workdir: '', backend: 'fake' })
fixture.update(liveRun.id, { status: 'running', runId: 'run-live', startedAt: Date.now(), executionOwner: liveOwner })

const manager = new SidecarManager({ userDataDir: tmp, entrypoint: serverOut, preferredPort: 0 })
const first = await manager.start()
if (first.status !== 'ready' || !first.port || !first.instanceId) throw new Error('sidecar did not complete startup handshake')
const live = await fetch(`${first.url}/health`)
if (live.status !== 200 || !(await live.json()).ok) throw new Error('unauthenticated loopback health probe failed')
const bad = await fetch(`${first.url}/handshake`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agentdeck-token': 'wrong' }, body: JSON.stringify({ protocolVersion: 1, instanceToken: 'wrong' }) })
if (bad.status !== 401) throw new Error(`invalid token was accepted (${bad.status})`)
const mismatch = await fetch(`${first.url}/handshake`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agentdeck-token': first.token }, body: JSON.stringify({ protocolVersion: 99, instanceToken: first.token }) })
if (mismatch.status !== 409) throw new Error(`protocol mismatch was not rejected (${mismatch.status})`)
const unauthorizedRpc = await fetch(`${first.url}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agentdeck-token': 'wrong' }, body: JSON.stringify({ protocol: 'agentdeck.business-brain', version: 1, id: 'bad', method: 'state.sync' }) })
if (unauthorizedRpc.status !== 401) throw new Error(`unauthorized RPC was accepted (${unauthorizedRpc.status})`)
const sync = await manager.sync()
if (sync.protocolVersion !== 1 || !Array.isArray(sync.tasks) || !Array.isArray(sync.issues) || !Array.isArray(sync.specSnapshots) || !Array.isArray(sync.specDecisions) || !Array.isArray(sync.specApprovals) || !Array.isArray(sync.goalEvents)) throw new Error('sidecar state sync contract failed')
// Event appends must carry the run identity the caller captured: the server
// never authorizes an append with whatever run happens to be latest.
const unknownRunIdentity = { runId: 'run-orphan', executionOwner: undefined }
const appended = await manager.appendEvent(unknownRun.id, { id: 'evt-1', kind: 'text', text: 'hello' }, unknownRunIdentity)
if (appended.seq !== 1 || appended.durability !== 'durable') throw new Error('sidecar event append contract failed')
const replay = await manager.readEvents(unknownRun.id, 0)
if (replay.length !== 1 || replay[0].id !== 'evt-1') throw new Error('sidecar event replay contract failed')
const liveEvent = await manager.appendEvent(unknownRun.id, { id: 'evt-live', kind: 'text', text: 'delta', durable: false }, unknownRunIdentity)
if (liveEvent.durability !== 'live') throw new Error('sidecar live event boundary failed')
if ((await manager.readEvents(unknownRun.id, 0)).some((event) => event.id === 'evt-live')) throw new Error('live event was persisted')

// --------------------------------------------------- ownership-checked takeover
// Only the run whose execution owner is proven dead may be adopted; an unknown
// identity and a live owner with an expired lease stay exactly as they are.
const takeover = await manager.recoverOrphans()
assert(Array.isArray(takeover.adopted) && takeover.adopted.length === 1 && takeover.adopted[0] === 'run-dead', `takeover adopts only the provably dead run (got ${JSON.stringify(takeover.adopted)})`)
const adoptedState = await manager.sync()
const deadSaved = adoptedState.tasks.find((task) => task.id === deadRun.id)
assert(deadSaved?.status === 'queued' && !deadSaved.runId && !deadSaved.executionOwner, 'the dead run is queued for recovery and its identity is released')
const unknownSaved = adoptedState.tasks.find((task) => task.id === unknownRun.id)
assert(unknownSaved?.status === 'running' && unknownSaved.runId === 'run-orphan', 'an unknown execution identity is never adopted')
const liveSaved = adoptedState.tasks.find((task) => task.id === liveRun.id)
assert(liveSaved?.status === 'running' && liveSaved.runId === 'run-live', 'a live owner with an expired lease is never adopted')
assert(processOwnerState(liveOwner) === 'live', 'the live fixture owner is genuinely alive')
if (manager.snapshot?.orphanRuns.includes('run-dead')) throw new Error('orphan takeover left stale manager orphan state')
if (manager.snapshot?.orphanRuns.length !== 2) throw new Error(`remaining orphan runs were not reported (${JSON.stringify(manager.snapshot?.orphanRuns)})`)
const secondTakeover = await manager.recoverOrphans()
if (secondTakeover.adopted.length !== 0) throw new Error('the dead run was claimed more than once')
const recoveryEvents = (await manager.readEvents(deadRun.id, 0)).filter((event) => event.kind === 'status' && String(event.text ?? '').includes('Confirmed dead execution owner'))
if (recoveryEvents.length !== 1) throw new Error(`expected exactly one recovery event (got ${recoveryEvents.length})`)

const sidecarTask = await manager.rpc('tasks.create', { input: { title: 'sidecar task', prompt: 'queued by business brain', workdir: tmp, backend: 'fake', suppressIssue: true }, trigger: 'assignment' })
if (!sidecarTask || sidecarTask.status !== 'queued') throw new Error('sidecar task creation RPC failed')
if (!(await manager.rpc('tasks.list')).some((task) => task.id === sidecarTask.id)) throw new Error('sidecar task projection was not authoritative')

const originalFetch = globalThis.fetch
let responseLost = false
let creationKey = ''
globalThis.fetch = async (resource, init) => {
  if (!responseLost && String(resource).endsWith('/rpc') && init?.body) {
    const request = JSON.parse(String(init.body))
    if (request.method === 'tasks.create' && request.params?.input?.title === 'lost-response') {
      creationKey = request.params.input.requestId
      const response = await originalFetch(resource, init)
      assert(response.ok, 'lost-response creation did not commit')
      responseLost = true
      throw new Error('connection reset after commit')
    }
  }
  return originalFetch(resource, init)
}
let replayedTask
try {
  replayedTask = await manager.rpc('tasks.create', { input: { title: 'lost-response', prompt: 'dedupe retry', workdir: tmp, backend: 'fake', suppressIssue: true } })
} finally {
  globalThis.fetch = originalFetch
}
assert(responseLost && typeof creationKey === 'string' && creationKey.startsWith('sidecar:'), 'creation request lacked a stable retry key')
assert((await manager.rpc('tasks.list')).filter((task) => task.dedupeKey === creationKey).length === 1 && replayedTask.dedupeKey === creationKey, 'a lost creation response duplicated the Task')

const stateFile = path.join(tmp, 'sidecar-state.json')
const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
if (persisted.port !== first.port || persisted.token !== first.token) throw new Error('sticky sidecar state was not persisted')

{
  const failDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-sidecar-fail-'))
  const bomb = path.join(failDir, 'bomb.cjs')
  fs.writeFileSync(bomb, [
    "console.log('SECRET-TASK-BODY-STDOUT')",
    "const token = process.env.AGENTDECK_SIDECAR_TOKEN || ''",
    "for (let i = 0; i < 64; i++) console.error((i === 63 ? `FATAL token=${token} ` : 'noise-') + i + '-' + 'x'.repeat(400))",
    'process.exit(7)'
  ].join('\n'))
  const failManager = new SidecarManager({ userDataDir: failDir, entrypoint: bomb, preferredPort: 0 })
  const bootStartedAt = Date.now()
  let bootFailure = null
  try { await failManager.start() } catch (error) { bootFailure = error }
  assert(bootFailure instanceof Error, `a child that exits during boot must fail manager.start() (${bootFailure})`)
  assert(String(bootFailure.message).includes('exited with code 7'), `the startup failure carries the exit evidence (${bootFailure.message})`)
  assert(Date.now() - bootStartedAt < 8000, 'a dead child must fail the start fast instead of exhausting the full retry budget')
  await sleep(150)
  const degraded = failManager.snapshot
  assert(degraded?.status === 'degraded', `the failed start lands in degraded (got ${degraded?.status})`)
  const diags = degraded?.diagnostics ?? []
  const exitNote = diags.find((d) => d.source === 'exit')
  assert(exitNote?.code === 'code:7', `the abnormal exit is recorded verbatim (${JSON.stringify(exitNote)})`)
  const stderrTail = diags.filter((d) => d.source === 'stderr')
  assert(stderrTail.length > 0 && stderrTail.length <= SIDECAR_STDERR_TAIL_LINES, `only a bounded stderr tail survives (${stderrTail.length})`)
  const failToken = JSON.parse(fs.readFileSync(path.join(failDir, 'sidecar-state.json'), 'utf8')).token
  assert(stderrTail.some((d) => d.message?.includes('FATAL token=[redacted] 63-')), `the stderr line nearest the exit is retained with its token redacted (${JSON.stringify(stderrTail)})`)
  assert(stderrTail.every((d) => !d.message?.includes(failToken)), 'the raw session token never appears in diagnostics')
  assert(stderrTail.every((d) => !d.message?.includes('noise-0-')), 'stderr lines beyond the tail are evicted, not accumulated')
  for (const d of diags) {
    assert(!d.message || d.message.length <= SIDECAR_DIAGNOSTIC_LINE_LIMIT, `diagnostic lines are clamped (got ${d.message?.length})`)
    assert(!d.message?.includes('SECRET-TASK-BODY-STDOUT'), 'stdout (task bodies) is never retained as diagnostics')
  }
  const diagnosticFile = path.join(failDir, SIDECAR_DIAGNOSTIC_FILE)
  const savedDiagnostics = JSON.parse(fs.readFileSync(diagnosticFile, 'utf8'))
  assert(savedDiagnostics.some((entry) => entry.source === 'exit' && entry.code === 'code:7'), 'exit code survives to bounded metadata file')
  assert(savedDiagnostics.every((entry) => !('message' in entry) && !('token' in entry)), 'metadata file never stores stderr or credentials')
  const reopened = new SidecarManager({ userDataDir: failDir, entrypoint: bomb, preferredPort: 0 })
  try { await reopened.start() } catch {}
  assert(reopened.snapshot?.diagnostics.some((entry) => entry.at === exitNote.at && entry.code === 'code:7'), 'a new manager replays prior exit metadata')
  await reopened.stop()

  const spawnDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-sidecar-spawn-'))
  const spawnManager = new SidecarManager({ userDataDir: spawnDir, entrypoint: path.join(spawnDir, 'unreachable.cjs'), nodePath: path.join(spawnDir, 'no-such-node'), preferredPort: 0 })
  let spawnFailure = null
  const spawnStartedAt = Date.now()
  try { await spawnManager.start() } catch (error) { spawnFailure = error }
  assert(spawnFailure instanceof Error, `a missing child binary must fail manager.start() (${spawnFailure})`)
  assert(Date.now() - spawnStartedAt < 8000, 'a spawn failure must fail the start fast')
  assert((spawnManager.snapshot?.diagnostics ?? []).some((d) => d.source === 'spawn' && d.message?.includes('ENOENT')), `the spawn error is recorded (${JSON.stringify(spawnManager.snapshot?.diagnostics)})`)
  await spawnManager.stop()

  for (let cycle = 0; cycle < 6; cycle++) {
    let again = null
    try { await failManager.start() } catch (error) { again = error }
    assert(again instanceof Error, `repeated failed starts keep failing with evidence (${again})`)
    await sleep(120)
  }
  const bounded = failManager.snapshot?.diagnostics ?? []
  assert(bounded.length === SIDECAR_DIAGNOSTIC_LIMIT, `the diagnostics ring stays capped at the limit (got ${bounded.length})`)
  assert(bounded.some((d) => d.source === 'exit' && d.code === 'code:7'), 'the newest crash evidence survives eviction')
  assert(JSON.parse(fs.readFileSync(diagnosticFile, 'utf8')).length <= SIDECAR_DIAGNOSTIC_LIMIT, 'metadata history is bounded across crashes')
  const failStateRaw = fs.readFileSync(path.join(failDir, 'sidecar-state.json'), 'utf8')
  assert(!failStateRaw.includes('noise-') && !failStateRaw.includes('FATAL') && !failStateRaw.includes('SECRET-TASK-BODY'), 'no child output is persisted into the sticky state file')
  assert(!('diagnostics' in JSON.parse(failStateRaw)), 'diagnostics are never persisted')
  await failManager.stop()
}

// ------------------------------- real two-entry race for the same dead run
// A real sidecar child process and a second, independent sidecar server race
// the same durable run over the real HTTP entry point. Exactly one of them may
// adopt it; the loser must observe committed state rather than double-claim.
{
  const raceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-sidecar-race-'))
  const raceStore = new TaskStore(raceDir)
  const raceTask = raceStore.create({ title: 'race', prompt: 'resume', workdir: '', backend: 'fake' })
  raceStore.update(raceTask.id, { status: 'running', runId: 'run-race', startedAt: Date.now(), executionOwner: deadOwner })
  // The same race must leave an unknown identity and a live owner alone.
  const raceUnknown = raceStore.create({ title: 'race-unknown', prompt: 'resume', workdir: '', backend: 'fake' })
  raceStore.update(raceUnknown.id, { status: 'running', runId: 'run-race-unknown', startedAt: Date.now() })
  const raceLive = raceStore.create({ title: 'race-live', prompt: 'resume', workdir: '', backend: 'fake' })
  raceStore.update(raceLive.id, { status: 'running', runId: 'run-race-live', startedAt: Date.now(), executionOwner: liveOwner })
  const raceManager = new SidecarManager({ userDataDir: raceDir, entrypoint: serverOut, preferredPort: 0 })
  const inProcess = startSidecarServer({ port: 0, token: 'race-token', userDataDir: raceDir, instanceId: 'in-process-race' })
  try {
    const raceFirst = await raceManager.start()
    const inProcessPort = await inProcess.ready
    const inProcessTakeover = async () => {
      const response = await fetch(`http://127.0.0.1:${inProcessPort}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agentdeck-token': 'race-token' },
        body: JSON.stringify({ version: 1, method: 'runs.takeover', params: {} })
      })
      const body = await response.json()
      if (!body.ok) throw new Error(JSON.stringify(body.error))
      return body.result
    }
    const [fromChild, fromInProcess] = await Promise.all([raceManager.recoverOrphans(), inProcessTakeover()])
    const adopted = [...fromChild.adopted, ...fromInProcess.adopted]
    if (adopted.length !== 1 || adopted[0] !== 'run-race') throw new Error(`the takeover race did not settle on exactly one claim (got ${JSON.stringify(adopted)})`)
    const claimed = raceStore.get(raceTask.id)
    if (claimed.status !== 'queued' || claimed.runId !== undefined) throw new Error(`the raced run was not requeued once (${claimed.status}/${claimed.runId})`)
    if (raceStore.readEvents(raceTask.id).filter((event) => String(event.text ?? '').includes('Confirmed dead execution owner')).length !== 1) throw new Error('the raced run wrote more than one recovery event')
    const racedUnknown = raceStore.get(raceUnknown.id)
    if (racedUnknown.status !== 'running' || racedUnknown.runId !== 'run-race-unknown') throw new Error('the takeover race adopted a run with unknown ownership')
    const racedLive = raceStore.get(raceLive.id)
    if (racedLive.status !== 'running' || racedLive.runId !== 'run-race-live') throw new Error('the takeover race adopted a live run past its lease')
    // A second pass through both entries must find nothing left to claim.
    const [againChild, againInProcess] = await Promise.all([raceManager.recoverOrphans(), inProcessTakeover()])
    if (againChild.adopted.length !== 0 || againInProcess.adopted.length !== 0) throw new Error('the raced run was claimed twice')
    if (!raceFirst.instanceId) throw new Error('the racing sidecar child did not complete its handshake')
  } finally {
    await inProcess.close()
    await raceManager.stop()
  }
}

// -------------------------------- deletion protection and the manual entries
{
  const startDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-sidecar-start-'))
  const store = new TaskStore(startDir)
  const source = store.create({ title: 'source', prompt: 'done already', workdir: '', backend: 'fake' })
  store.update(source.id, { status: 'done', endedAt: Date.now(), result: 'done' })
  const parked = (title, backend = 'fake') => store.create({ title, prompt: title, workdir: '', backend, continuesFrom: source.id, issueId: 'iss_' + title.replace(/\W+/g, ''), trigger: 'handoff', parked: true })

  const backend = { id: 'fake', label: 'fake', starts: 0 }
  backend.probe = async () => ({ ok: true, detail: 'fake' })
  backend.start = async ({ events }) => {
    backend.starts++
    setTimeout(() => {
      events.onEvent({ ts: Date.now(), kind: 'final', text: 'ipc done' })
      events.onTurnEnd({ ok: true, response: 'ipc done' })
    }, 30)
    return { sessionId: 'ipc_' + backend.starts, async send() {}, async stop() {}, async close() {} }
  }
  const runner = new TaskRunner(store, new Map([[backend.id, backend], ['zcode', backend]]), () => ({ concurrency: 2, mode: 'yolo', notify: false }))
  const taskBroadcasts = []
  registerTaskIpc({
    store,
    runner,
    issueStore: { sync() {}, syncEventually() { throw new Error('injected task IPC projection failure') } },
    publishIssueUpdate() {},
    getWindow: () => ({ webContents: { send: (channel, payload) => taskBroadcasts.push({ channel, payload }) } })
  })
  const handler = (name) => globalThis.__smokeHandlers.get(name)

  const server = startSidecarServer({ port: 0, token: 'start-token', userDataDir: startDir, instanceId: 'start-in-process' })
  try {
    const port = await server.ready
    const rpc = async (method, params) => {
      const response = await fetch(`http://127.0.0.1:${port}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agentdeck-token': 'start-token' }, body: JSON.stringify({ version: 1, method, params }) })
      return response.json()
    }

    // A real sidecar RPC creation must return its Issue-shaped contract even
    // when the Issue rename fails. The committed Task is retried by the
    // runtime without creating another Task.
    const issueFile = path.join(startDir, 'issues', 'index.json')
    const originalIssueRename = fs.renameSync
    let issueProjectionFault = true
    fs.renameSync = (source, destination, ...args) => {
      if (issueProjectionFault && destination === issueFile) throw new Error('injected sidecar projection rename failure')
      return originalIssueRename(source, destination, ...args)
    }
    const sidecarIssue = await rpc('issues.create', { input: { title: 'sidecar projection fault', description: 'committed before projection', workdir: '', backend: 'fake', startNow: false, requestId: 'sidecar-issue-once' } })
    fs.renameSync = originalIssueRename
    issueProjectionFault = false
    assert(sidecarIssue.ok && sidecarIssue.result?.id?.startsWith('iss_'), `sidecar issues.create did not return a stable Issue (${JSON.stringify(sidecarIssue)})`)
    const createdSidecarTasks = store.list().filter((task) => task.dedupeKey === 'sidecar-issue-once')
    assert(createdSidecarTasks.length === 1 && sidecarIssue.result.taskId === createdSidecarTasks[0].id, 'sidecar projection fault created exactly one committed Task')
    assert(await until(() => JSON.parse(fs.readFileSync(issueFile, 'utf8')).issues?.some((issue) => issue.id === sidecarIssue.result.id)), 'sidecar projection retry did not restore the Issue')
    const sidecarIssueAgain = await rpc('issues.create', { input: { title: 'sidecar projection fault', description: 'committed before projection', workdir: '', backend: 'fake', startNow: false, requestId: 'sidecar-issue-once' } })
    assert(sidecarIssueAgain.ok && sidecarIssueAgain.result.id === sidecarIssue.result.id && store.list().filter((task) => task.dedupeKey === 'sidecar-issue-once').length === 1, 'sidecar issues.create replay duplicated the Task or Issue')

    // ① desktop 启动按钮 ② desktop 拖到「运行中」 ③ sidecar RPC 启动
    const byStart = parked('manual-start')
    const byMove = parked('manual-move')
    const byRpc = parked('manual-rpc', 'zcode')
    if (!handler('tasks:start')(null, byStart.id).ok) throw new Error('tasks:start refused a parked handoff')
    if (!await until(() => store.get(byStart.id)?.status === 'done')) throw new Error('tasks:start did not run the task')
    if (!handler('tasks:move')(null, byMove.id, 'running').ok) throw new Error('tasks:move refused a parked handoff')
    if (!await until(() => store.get(byMove.id)?.status === 'done')) throw new Error('tasks:move did not run the task')

    const rpcStarted = await rpc('tasks.start', { id: byRpc.id })
    if (!rpcStarted.ok) throw new Error(`sidecar tasks.start failed: ${JSON.stringify(rpcStarted.error)}`)
    if (!await until(() => store.get(byRpc.id)?.status === 'done')) throw new Error('sidecar tasks.start did not run the task')

    for (const [label, task] of [['tasks:start', byStart], ['tasks:move', byMove], ['sidecar tasks.start', byRpc]]) {
      const saved = store.get(task.id)
      if (!saved || saved.status !== 'done') throw new Error(`${label} did not finish the task (${saved?.status})`)
      if (saved.parked !== undefined) throw new Error(`${label} left the task parked`)
      if (!(saved.manualStartConfirmedAt > 0)) throw new Error(`${label} did not persist the manual start confirmation`)
      const events = store.readEvents(task.id)
      if (events.filter((event) => event.kind === 'final').length !== 1) throw new Error(`${label} wrote a duplicate final event`)
      if (events.filter((event) => event.kind === 'user').length !== 1) throw new Error(`${label} launched more than one turn`)
    }
    if (backend.starts !== 2) throw new Error(`the two desktop entries launched exactly one run each (got ${backend.starts})`)
    if (globalThis.__smokeZcode?.starts !== 1) throw new Error(`the sidecar entry launched exactly one run (got ${globalThis.__smokeZcode?.starts})`)

    // All three entries share the same captured-identity guard: a task that is
    // no longer queued is refused instead of being restarted.
    if (handler('tasks:start')(null, byStart.id).ok) throw new Error('tasks:start restarted a finished task')
    const repeated = await rpc('tasks.start', { id: byStart.id })
    if (repeated.ok || !String(repeated.error?.message ?? '').includes('not queued')) throw new Error(`sidecar tasks.start restarted a finished task (${JSON.stringify(repeated.error)})`)

    // 同任务只启动一次：桌面 IPC 入口与 sidecar RPC 入口同时启动同一个 queued 任务。
    // 两个入口都能拿到「准备启动」，但只有一次条件认领可以提交，因此只允许一次真实启动。
    const launchesBefore = backend.starts + (globalThis.__smokeZcode?.starts ?? 0)
    const raced = parked('manual-race', 'zcode')
    const [fromIpc, fromRpc] = await Promise.all([
      Promise.resolve(handler('tasks:start')(null, raced.id)),
      rpc('tasks.start', { id: raced.id })
    ])
    if (!fromIpc.ok && !fromRpc.ok) throw new Error(`both start entries refused the raced task (${JSON.stringify([fromIpc, fromRpc.error])})`)
    if (!await until(() => store.get(raced.id)?.status === 'done')) throw new Error('the raced start never completed')
    const launches = backend.starts + (globalThis.__smokeZcode?.starts ?? 0) - launchesBefore
    if (launches !== 1) throw new Error(`the raced start entries launched ${launches} runs`)
    const racedEvents = store.readEvents(raced.id)
    if (racedEvents.filter((event) => event.kind === 'user').length !== 1) throw new Error('the raced start opened more than one turn')
    if (racedEvents.filter((event) => event.kind === 'final').length !== 1) throw new Error('the raced start wrote more than one final event')

    // 删除后事件不复活：真实删除入口提交后再清理，随后任何入口都改不动它的日志。
    const victim = parked('victim')
    store.appendEvent(victim.id, { ts: Date.now(), kind: 'status', text: 'before delete' })
    const deleted = await handler('tasks:delete')(null, victim.id)
    if (!deleted.ok) throw new Error(`tasks:delete failed: ${JSON.stringify(deleted)}`)
    if (!taskBroadcasts.some((item) => item.channel === 'task:deleted' && item.payload === victim.id)) throw new Error('tasks:delete suppressed the deletion broadcast after projection failure')
    if (store.get(victim.id)) throw new Error('the deleted task is still in the index')
    if (!await until(() => !fs.existsSync(taskDir(startDir, victim.id)))) throw new Error('the deleted task directory survived the deletion')
    const revived = await rpc('events.append', { taskId: victim.id, event: { eventId: 'revive', kind: 'status', text: 'revive' } })
    if (revived.ok) throw new Error('sidecar events.append revived a deleted task')
    if (fs.existsSync(taskDir(startDir, victim.id)) || fs.existsSync(path.join(taskDir(startDir, victim.id), 'events.jsonl'))) throw new Error('a deleted task log was recreated')
    if ((await rpc('events.read', { taskId: victim.id, afterSeq: 0 })).result?.length) throw new Error('a deleted task still replays events')
    if (store.list().some((task) => task.id === victim.id)) throw new Error('the deleted task came back through the sidecar')
  } finally {
    await server.close()
    await runner.shutdown()
  }
}

// Kill the child and wait for the manager's automatic re-handshake. The
// persisted port/token must remain stable across this recovery.
if (first.pid) process.kill(first.pid)
const queuedSync = manager.rpc('state.sync')
const queuedResult = await queuedSync
if (!queuedResult || queuedResult.protocolVersion !== 1) throw new Error('queued RPC was not flushed after reconnect')
let recovered = false
for (let i = 0; i < 80; i++) {
  await new Promise((resolve) => setTimeout(resolve, 50))
  try {
    const snapshot = await manager.start()
    if (snapshot.status === 'ready' && snapshot.port === first.port) { recovered = true; break }
  } catch {}
}
if (!recovered) throw new Error('sidecar did not recover after child restart')
const crashDiags = manager.snapshot?.diagnostics ?? []
if (!crashDiags.some((d) => d.source === 'exit')) throw new Error(`the crashed sidecar left no exit evidence (${JSON.stringify(crashDiags)})`)
if (crashDiags.length > SIDECAR_DIAGNOSTIC_LIMIT) throw new Error(`diagnostics exceed the ring cap (${crashDiags.length})`)
const stillRunning = await manager.sync()
if (stillRunning.tasks.find((task) => task.id === unknownRun.id)?.status !== 'running') throw new Error('reconnect adopted a run with unknown ownership')
if (stillRunning.tasks.find((task) => task.id === liveRun.id)?.status !== 'running') throw new Error('reconnect adopted a live run past its lease')
const adopter = new SidecarManager({ userDataDir: tmp, entrypoint: serverOut })
const adopted = await adopter.start()
if (adopted.port !== first.port || adopted.token !== first.token) throw new Error('sticky sidecar adoption failed')
await adopter.stop()
if (!(await manager.health()).ok) throw new Error('adopter stopped an owned sidecar')
await manager.stop()
console.log('smoke-sidecar: ok')
