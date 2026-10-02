import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isolatedEnvironment, assertStartupIsolation, assertIsolatedPath, IsolatedProcessFence, readWindowsProcesses } from './fixtures/isolated-release-processes.mjs'

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-release-isolation-'))
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
let completed = false
try {
  const env = isolatedEnvironment(temporary)
  const executable = path.join(temporary, 'app', 'AgentDeck.exe')
  const settingsFile = path.join(env.AGENTDECK_USER_DATA_DIR, 'settings.json')
  const settings = { workspaceDir: path.join(temporary, 'workspace'), sharedDir: path.join(temporary, 'shared') }
  fs.writeFileSync(settingsFile, JSON.stringify(settings))
  assert.equal(assertStartupIsolation(temporary, executable, env).sharedDir, settings.sharedDir)
  fs.writeFileSync(settingsFile, JSON.stringify({ workspaceDir: settings.workspaceDir }))
  assert.throws(() => assertStartupIsolation(temporary, executable, env), /absolute paths/)
  fs.writeFileSync(settingsFile, JSON.stringify({ ...settings, sharedDir: os.homedir() }))
  assert.throws(() => assertStartupIsolation(temporary, executable, env), /escapes isolated root/)
  fs.writeFileSync(settingsFile, JSON.stringify(settings))
  assert.throws(() => assertStartupIsolation(temporary, process.execPath, env), /escapes isolated root/)
  assert.throws(() => assertStartupIsolation(temporary, executable, { ...env, HOME: os.homedir() }), /escapes isolated root/)
  const junction = path.join(temporary, 'escaping-junction')
  fs.symlinkSync(os.homedir(), junction, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => assertIsolatedPath(temporary, path.join(junction, 'missing-file')), /escapes isolated root/)
  fs.unlinkSync(junction)
  console.log('PASS startup rejects absent/external sharedDir, home, executable and reparse escapes before launch')

  const parent = { ProcessId: 900001, ParentProcessId: 1, Created: '2026-10-02T09:00:00Z', ExecutablePath: executable }
  const external = { ProcessId: 900002, ParentProcessId: parent.ProcessId, Created: '2026-10-02T08:00:00Z', ExecutablePath: process.execPath }
  let observed = [parent, external]
  let kills = 0
  const staleParent = new IsolatedProcessFence(temporary, { observe: () => observed, kill: () => { kills++; return { status: 0 } } })
  assert.deepEqual(staleParent.capture().map((entry) => entry.ProcessId), [parent.ProcessId])
  observed = [external]
  await assert.rejects(staleParent.cleanup(), /no launch-bound job containment proof/)
  assert.equal(kills, 0)
  assert.throws(() => staleParent.assertClean(), /further launch prohibited/)
  console.log('PASS reused parent PID never establishes ownership or triggers any PID kill')

  observed = [parent]
  const missed = new IsolatedProcessFence(temporary, { observe: () => observed })
  missed.capture()
  observed = [{ ...external, ProcessId: 900003, Created: '2026-10-02T09:01:00Z' }]
  assert.throws(() => missed.assertClean(), /uncontained process previously observed/)
  await assert.rejects(missed.cleanup({ exitCode: 0 }), /no launch-bound job containment proof/)
  assert.throws(() => missed.assertClean(), /further launch prohibited/)
  console.log('PASS unseen detached descendant cannot be certified from empty path filtering or vanished parent')

  const mockJob = (fence, packet) => {
    const child = { configuration: { control: path.join(temporary, 'mock-stop') }, controller: { pid: 900004, exitCode: 0 }, packet, refresh: () => {}, timer: null }
    fence.job = child
    return child
  }
  const state = { AssignedAtCreation: true, AssignedBeforeResume: true, NoBreakaway: true, RootExited: true, Active: 0, Members: [] }
  for (const packet of [{ confirmed: true, state, commands: [{ status: 1 }] }, { error: 'native termination refused', confirmed: false }]) {
    const fence = new IsolatedProcessFence(temporary, { observe: () => [] })
    mockJob(fence, packet)
    await assert.rejects(fence.cleanup(), /command failed|termination refused/)
    assert.throws(() => fence.assertClean(), /further launch prohibited/)
  }
  console.log('PASS termination nonzero/error still fails when root already exited')
  const lingering = new IsolatedProcessFence(temporary, { observe: () => [], timeoutMs: 120 })
  mockJob(lingering, { confirmed: false, state: { ...state, Active: 1, Members: [900003] }, commands: [{ status: 0 }] }).controller.exitCode = null
  await assert.rejects(lingering.cleanup(), /tree exit not confirmed/)
  assert.throws(() => lingering.assertClean(), /further launch prohibited/)
  console.log('PASS native job active count overrides empty path observation and prevents later launch')
  for (const malformed of [{ ...state, AssignedAtCreation: false }, { ...state, AssignedAtCreation: undefined }, { ...state, AssignedBeforeResume: false }, { ...state, NoBreakaway: false }, { ...state, Active: 1 }, { ...state, Members: [900003] }]) {
    const fence = new IsolatedProcessFence(temporary, { observe: () => [] })
    mockJob(fence, { confirmed: true, state: malformed, commands: [{ status: 0 }] })
    await assert.rejects(fence.cleanup())
    assert.equal(fence.blocked, true)
  }
  console.log('PASS incomplete suspension/containment/exit proof is rejected')

  if (process.platform === 'win32') {
    for (const mode of ['guardian-crash-before-membership', 'owner-closed-before-membership']) {
      const scene = path.join(temporary, mode)
      fs.mkdirSync(scene)
      const ready = path.join(scene, 'creation-ready')
      const release = path.join(scene, 'creation-release')
      const executed = path.join(scene, 'root-executed')
      const fence = new IsolatedProcessFence(scene)
      const pending = fence.launch(process.execPath, ['-e', "require('node:fs').writeFileSync(process.argv[1],'executed');setInterval(()=>{},1000)", executed], { env: isolatedEnvironment(scene), cwd: scene, stdout: path.join(scene, 'stdout.log'), stderr: path.join(scene, 'stderr.log'), creationPause: { ready, release } }).then(() => ({ launched: true }), (error) => ({ error: error.message }))
      try {
        const deadline = Date.now() + 15000
        while (!fs.existsSync(ready)) { assert.ok(Date.now() < deadline, 'atomic creation fault marker ready'); await sleep(25) }
        const rootPid = Number(fs.readFileSync(ready, 'utf8'))
        const identity = readWindowsProcesses().find((entry) => entry.ProcessId === rootPid)
        assert.ok(identity?.Created, 'suspended root identity observed before guardian interruption')
        assert.equal(fs.existsSync(executed), false)
        assert.equal(fs.existsSync(fence.job.configuration.state), false, 'interrupt before membership verification and state publication')
        if (mode === 'guardian-crash-before-membership') assert.equal(fence.job.controller.kill(), true, 'terminate only the owned guardian handle')
        else fence.job.controller.stdin.end()
        const result = await pending
        assert.ok(result.error, 'interrupted launch must fail')
        assert.equal(fence.blocked, true)
        assert.throws(() => fence.assertClean(), /further launch prohibited/)
        const exitDeadline = Date.now() + 15000
        let remaining
        do {
          remaining = readWindowsProcesses().filter((entry) => entry.ProcessId === identity.ProcessId && entry.Created === identity.Created)
          if (!remaining.length) break
          assert.ok(Date.now() < exitDeadline, 'atomically contained suspended root exited after guardian interruption')
          await sleep(100)
        } while (true)
        while (fence.job.controller.exitCode === null && fence.job.controller.signalCode === null) {
          assert.ok(Date.now() < exitDeadline, 'interrupted guardian exit confirmed')
          await sleep(25)
        }
        if (mode === 'guardian-crash-before-membership') assert.equal(fence.job.controller.signalCode, 'SIGTERM')
        else assert.equal(fence.job.controller.exitCode, 1)
        assert.equal(fs.existsSync(executed), false, 'suspended root never resumed')
        fs.writeFileSync(path.join(scene, 'proof.json'), JSON.stringify({ mode, identity, launchError: result.error, blocked: fence.blocked, remaining, rootExecuted: false, guardianExitCode: fence.job.controller.exitCode, guardianSignal: fence.job.controller.signalCode }, null, 2))
        console.log('PASS native atomic Job creation reclaims suspended root before membership publication: ' + mode)
      } finally {
        fence.job?.controller.stdin.end()
        await pending
      }
    }
    for (const mode of ['live-root', 'root-exits-before-observation', 'owner-closed']) {
      const earlyExit = mode === 'root-exits-before-observation'
      const scene = path.join(temporary, mode)
      fs.mkdirSync(scene)
      const parentFile = path.join(scene, 'parent.cjs')
      const ready = path.join(scene, 'ready.json')
      fs.writeFileSync(parentFile, "const cp=require('node:child_process'),fs=require('node:fs');const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true,windowsHide:true});fs.writeFileSync(process.argv[2],JSON.stringify({parent:process.pid,child:child.pid}));" + (earlyExit ? 'process.exit(0)' : 'setInterval(()=>{},1000)'))
      const fence = new IsolatedProcessFence(scene)
      const child = await fence.launch(process.execPath, [parentFile, ready], { env: isolatedEnvironment(scene), cwd: scene, stdout: path.join(scene, 'stdout.log'), stderr: path.join(scene, 'stderr.log') })
      try {
        const deadline = Date.now() + 5000
        while (!fs.existsSync(ready) || (earlyExit && child.exitCode === null)) { assert.ok(Date.now() < deadline, 'native fixture ready'); await sleep(25) }
        const ids = JSON.parse(fs.readFileSync(ready, 'utf8'))
        while (!child.packet.state.Members.includes(ids.child)) {
          assert.ok(Date.now() < deadline, 'native job child membership published')
          await sleep(25)
          child.refresh()
        }
        assert.ok(child.packet.state.Members.includes(ids.child))
        assert.ok(child.packet.state.Active >= 1)
        if (earlyExit) assert.equal(child.packet.state.RootExited, true)
        if (mode === 'owner-closed') {
          child.controller.stdin.end()
          while (!child.packet.confirmed) {
            assert.ok(Date.now() < deadline, 'owner closure triggers contained termination')
            await sleep(25)
            child.refresh()
          }
          assert.equal(child.packet.commands[0].reason, 'owner-closed')
        }
        const proof = await fence.cleanup(child)
        assert.equal(proof.confirmed, true)
        assert.equal(proof.state.Active, 0)
        assert.deepEqual(proof.remaining, [])
        assert.ok(proof.commands.every((command) => command.status === 0))
        fs.writeFileSync(path.join(scene, 'proof.json'), JSON.stringify(proof, null, 2))
        fence.assertClean()
        assert.equal(proof.state.AssignedAtCreation, true)
        console.log('PASS native Windows atomic Job creation contains detached child: ' + mode)
      } finally { if (!child.proof?.confirmed) await fence.cleanup(child) }
    }
  }
  completed = true
  console.log('RELEASE ISOLATION SMOKE PASSED')
} finally {
  if (completed && process.env.SMOKE_HOT_KEEP_SCENE !== '1') { assertIsolatedPath(os.tmpdir(), temporary); fs.rmSync(temporary, { recursive: true, force: true }) }
  else console.log('Isolation evidence retained: ' + temporary)
}
