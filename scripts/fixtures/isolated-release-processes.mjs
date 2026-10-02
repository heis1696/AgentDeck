import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const within = (root, target) => {
  const relative = path.relative(root, target)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
}
const resolved = (target) => {
  let existing = path.resolve(target)
  const missing = []
  while (!fs.existsSync(existing)) {
    missing.unshift(path.basename(existing))
    const parent = path.dirname(existing)
    assert.notEqual(parent, existing, 'no existing path ancestor')
    existing = parent
  }
  return path.join(fs.realpathSync(existing), ...missing)
}
export function assertIsolatedPath(root, target) {
  assert.ok(typeof target === 'string' && path.isAbsolute(target), 'isolation requires absolute paths')
  assert.ok(within(resolved(root), resolved(target)), 'path escapes isolated root: ' + target)
}
export function assertTemporaryRoot(root) {
  const temporary = resolved(os.tmpdir())
  assert.ok(within(temporary, resolved(root)) && resolved(root) !== temporary, 'requires a dedicated temporary root')
}
export function isolatedEnvironment(root, base = process.env, data = path.join(root, 'userdata')) {
  assertTemporaryRoot(root)
  const env = { ...base, HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), APPDATA: path.join(root, 'roaming'), LOCALAPPDATA: path.join(root, 'local'), TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp'), AGENTDECK_USER_DATA_DIR: data, AGENTDECK_HOT_DEBUG_LOG: path.join(root, 'hot-debug.log') }
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'AGENTDECK_USER_DATA_DIR']) {
    assertIsolatedPath(root, env[key])
    fs.mkdirSync(env[key], { recursive: true })
  }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AGENTDECK_DISABLE_HOT', 'AGENTDECK_SMOKE_MARKER', 'AGENTDECK_HOT_AUTO_APPLY_SHELL', 'AGENTDECK_HOT_TRUST_HEX']) delete env[key]
  return env
}
export function assertStartupIsolation(root, executable, env) {
  assertTemporaryRoot(root)
  assertIsolatedPath(root, executable)
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'AGENTDECK_USER_DATA_DIR', 'AGENTDECK_HOT_DEBUG_LOG']) assertIsolatedPath(root, env[key])
  if (env.AGENTDECK_SMOKE_MARKER) assertIsolatedPath(root, env.AGENTDECK_SMOKE_MARKER)
  const settings = JSON.parse(fs.readFileSync(path.join(env.AGENTDECK_USER_DATA_DIR, 'settings.json'), 'utf8'))
  for (const key of ['workspaceDir', 'sharedDir']) assertIsolatedPath(root, settings[key])
  return { executable, userData: env.AGENTDECK_USER_DATA_DIR, workspaceDir: settings.workspaceDir, sharedDir: settings.sharedDir, home: env.HOME, appData: env.APPDATA, localAppData: env.LOCALAPPDATA, temp: env.TEMP }
}
export function readWindowsProcesses() {
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID } | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,@{Name='Created';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}}) | ConvertTo-Json -Compress"], { windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 16 * 1024 * 1024 })
  assert.equal(result.error, undefined, 'process observation failed')
  assert.equal(result.status, 0, 'process observation failed: ' + result.stderr)
  const value = JSON.parse(result.stdout.trim() || '[]')
  return Array.isArray(value) ? value : [value]
}
export class IsolatedProcessFence {
  constructor(root, { observe = readWindowsProcesses, timeoutMs = 20000 } = {}) {
    assertTemporaryRoot(root)
    this.root = resolved(root)
    this.observe = observe
    this.timeoutMs = timeoutMs
    this.blocked = false
    this.job = null
    this.uncontainedSeen = false
  }
  capture() {
    const marker = this.root.toLowerCase() + path.sep
    const entries = this.observe().filter((entry) => entry.ProcessId !== process.pid && ((entry.ExecutablePath && within(this.root, path.resolve(entry.ExecutablePath))) || String(entry.CommandLine || '').toLowerCase().includes(marker)))
    if (!this.job && entries.length) this.uncontainedSeen = true
    return entries
  }
  assertClean() {
    assert.equal(this.blocked, false, 'prior cleanup unconfirmed; further launch prohibited')
    assert.equal(this.uncontainedSeen, false, 'uncontained process previously observed; further launch prohibited')
    if (this.job) assert.equal(this.job.proof?.confirmed, true, 'contained job exit not confirmed; further launch prohibited')
    assert.deepEqual(this.capture(), [], 'isolated processes remain; further launch prohibited')
  }
  async launch(executable, args, { env, cwd, stdout, stderr, creationPause }) {
    this.assertClean()
    const prefix = path.join(this.root, 'job-' + crypto.randomUUID())
    for (const file of [stdout, stderr, cwd]) assertIsolatedPath(this.root, file)
    assert.ok(within(this.root, resolved(executable)) || resolved(executable) === resolved(process.execPath), 'only isolated executable or fixture Node may launch')
    const configuration = { executable, commandLine: [executable, ...args].map(quoteWindowsArgument).join(' '), cwd, stdout, stderr, state: prefix + '.state.json', control: prefix + '.stop', add: prefix + '.add.json', jobName: 'Local\\AgentDeckStage4-' + crypto.randomUUID() }
    if (creationPause) {
      for (const file of [creationPause.ready, creationPause.release]) assertIsolatedPath(this.root, file)
      assert.notEqual(resolved(creationPause.ready), resolved(creationPause.release))
      assert.ok(!fs.existsSync(creationPause.ready) && !fs.existsSync(creationPause.release), 'creation fault markers must be fresh')
      Object.assign(configuration, { creationReady: creationPause.ready, creationRelease: creationPause.release })
    }
    const file = prefix + '.config.json'
    fs.writeFileSync(file, JSON.stringify(configuration))
    const controller = spawn('powershell', ['-NoProfile', '-NonInteractive', '-File', path.join(import.meta.dirname, 'isolated-job.ps1'), '-Configuration', file], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    controller.stdin.on('error', () => {})
    controller.stdout.pipe(fs.createWriteStream(prefix + '.controller.stdout.log'))
    controller.stderr.pipe(fs.createWriteStream(prefix + '.controller.stderr.log'))
    const child = new EventEmitter()
    Object.assign(child, { pid: undefined, exitCode: null, signalCode: null, controller, proof: null })
    let emittedExit = false
    const refresh = () => {
      try {
        const packet = JSON.parse(fs.readFileSync(configuration.state, 'utf8'))
        child.packet = packet
        if (packet.state) {
          child.pid = packet.state.Pid
          if (packet.state.RootExited && !emittedExit) {
            emittedExit = true
            child.exitCode = packet.state.RootExitCode
            child.emit('exit', child.exitCode, null)
          }
        }
      } catch (error) { if (error.code !== 'ENOENT') child.readError = error.message }
    }
    child.refresh = refresh
    child.configuration = configuration
    child.launchEnv = env
    child.timer = setInterval(refresh, 100)
    this.job = child
    try {
      const deadline = Date.now() + this.timeoutMs
      while (!child.pid) {
        refresh()
        if (child.packet?.error) throw new Error(child.packet.error)
        if (controller.exitCode !== null || controller.signalCode !== null || Date.now() > deadline) throw new Error('suspended job launch not confirmed: ' + prefix)
        await sleep(25)
      }
      assert.equal(child.packet.state.AssignedAtCreation, true)
      assert.equal(child.packet.state.AssignedBeforeResume, true)
      assert.equal(child.packet.state.NoBreakaway, true)
      return child
    } catch (error) {
      this.blocked = true
      clearInterval(child.timer)
      controller.stdin.destroy()
      throw error
    }
  }
  async attachRoot(executable, args, { env, cwd, stdout, stderr }) {
    assert.equal(this.blocked, false, 'prior cleanup unconfirmed; further launch prohibited')
    const child = this.job
    assert.ok(child && !child.proof?.confirmed && child.exitCode === null, 'requires live launch-bound job')
    assert.deepEqual(env, child.launchEnv, 'additional root must inherit the isolated environment')
    for (const file of [stdout, stderr, cwd, executable]) assertIsolatedPath(this.root, file)
    const priorPid = child.pid
    const request = { executable, commandLine: [executable, ...args].map(quoteWindowsArgument).join(' '), cwd, stdout, stderr }
    fs.writeFileSync(child.configuration.add + '.tmp', JSON.stringify(request))
    fs.renameSync(child.configuration.add + '.tmp', child.configuration.add)
    const deadline = Date.now() + this.timeoutMs
    try {
      while (child.pid === priorPid) {
        child.refresh()
        if (child.packet?.error) throw new Error(child.packet.error)
        if (child.controller.exitCode !== null || Date.now() > deadline) throw new Error('additional suspended root assignment not confirmed')
        await sleep(25)
      }
      assert.equal(child.packet.state.AssignedAtCreation, true)
      assert.equal(child.packet.state.AssignedBeforeResume, true)
      assert.equal(child.packet.state.NoBreakaway, true)
      return child
    } catch (error) {
      this.blocked = true
      child.controller.stdin.destroy()
      throw error
    }
  }
  async cleanup(child = this.job) {
    const evidence = { confirmed: false, remaining: [], commands: [] }
    try {
      assert.ok(child && child === this.job && child.configuration, 'no launch-bound job containment proof; further launch prohibited')
      fs.writeFileSync(child.configuration.control, 'terminate owned job')
      const deadline = Date.now() + this.timeoutMs
      while (true) {
        child.refresh()
        const packet = child.packet
        Object.assign(evidence, { state: packet?.state, commands: packet?.commands ?? [], remaining: packet?.state?.Members ?? [], controllerPid: child.controller.pid })
        if (packet?.error || child.readError) throw new Error(packet?.error || child.readError)
        if (packet?.confirmed) {
          assert.equal(packet.state.Active, 0, 'job still has active members')
          assert.deepEqual(packet.state.Members, [], 'job member identities remain')
          assert.equal(packet.state.RootExited, true)
          assert.equal(packet.state.AssignedAtCreation, true)
          assert.equal(packet.state.AssignedBeforeResume, true)
          assert.equal(packet.state.NoBreakaway, true)
          assert.ok(packet.commands.length && packet.commands.every((command) => command.status === 0), 'job termination command failed')
          if (child.controller.exitCode === 0) {
            clearInterval(child.timer)
            if (!this.capture().length) {
              evidence.confirmed = true
              child.proof = evidence
              return evidence
            }
          }
        }
        if ((child.controller.exitCode !== null && child.controller.exitCode !== 0) || child.controller.signalCode) throw new Error('job controller exit was not successful')
        if (child.controller.exitCode !== null && !packet?.confirmed) throw new Error('job controller exited without proof')
        if (Date.now() > deadline) throw new Error('contained process tree exit not confirmed')
        await sleep(100)
      }
    } catch (error) {
      this.blocked = true
      if (child?.timer) clearInterval(child.timer)
      evidence.error = error.message
      error.cleanupEvidence = evidence
      throw error
    }
  }
}
function quoteWindowsArgument(argument) {
  const text = String(argument)
  return '"' + text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"'
}
