// Focused Stage 3 contract smoke for EventGate/TurnLifecycle.
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const outfile = path.join(root, 'out', 'smoke-turn-lifecycle.cjs')
await build({
  entryPoints: [path.join(root, 'src/main/turn-lifecycle.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18'
})
const mod = await import(pathToFileURL(outfile).href)
const { EventGate, TurnLifecycle } = mod.default ?? mod

let failed = 0
const check = (name, condition, detail = '') => {
  console.log(`  ${condition ? 'OK' : 'FAIL'} ${name}${condition || !detail ? '' : ` (got ${detail})`}`)
  if (!condition) failed++
}

console.log('[1] EventGate generation, owner, status and title mode')
const gate = new EventGate({ status: 'queued' })
const queued = gate.token()
check('queued callbacks are rejected', !gate.accept(queued))
const first = gate.begin()
gate.setStatus('running')
check('current ownerless turn is accepted', gate.accept(first))
gate.setSessionOwner('session-a')
check('ownerless callbacks stay accepted after owner claim', gate.accept(first))
const ownerA = Object.freeze({ generation: first.generation, sessionOwner: 'session-a' })
check('current session owner is accepted', gate.accept(ownerA))
gate.setTitleMode(true)
check('title mode drops text events', !gate.accept(ownerA, { kind: 'text' }))
check('title mode keeps errors', gate.accept(ownerA, { kind: 'error' }))
gate.setTitleMode(false)
gate.setStatus('done')
check('terminal task rejects old terminal event', !gate.accept(ownerA, { terminal: true }))

console.log('[2] TurnLifecycle cancellation and late session cleanup')
const lifecycle = new TurnLifecycle({ taskId: 'task-lifecycle' })
const turn = lifecycle.begin()
let launchStopped = false
lifecycle.registerLaunch(() => { launchStopped = true })
let stopped = false
let closed = false
const session = {
  sessionId: 'late-session',
  async send() {},
  async stop() { stopped = true },
  async close() { closed = true }
}
await lifecycle.cancel()
check('cancel invalidates the turn', !lifecycle.accept(turn))
check('cancel runs the launch stop hook', launchStopped)
const admitted = await lifecycle.attachSession(turn, session)
check('late session is rejected', !admitted)
check('late session is closed', closed && !stopped)

console.log('[3] pending resume is single-use')
const resumed = new TurnLifecycle({ taskId: 'task-resume' })
const resumeTurn = resumed.begin({ pendingResume: true })
let resumeValue
const clear = resumed.registerResume(resumeTurn, (value) => { resumeValue = value })
check('pending resume is visible', resumed.pendingResume)
check('resume resolves once', resumed.resolveResume(resumeTurn, 'done') && resumeValue === 'done')
check('duplicate terminal cannot resolve again', !resumed.resolveResume(resumeTurn, 'late'))
clear()

if (failed) {
  console.error(`\nTURN LIFECYCLE SMOKE FAILED (${failed})`)
  process.exit(1)
}
console.log('\nTURN LIFECYCLE SMOKE PASSED')
