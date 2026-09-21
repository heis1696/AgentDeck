import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import ts from 'typescript'

const root = path.resolve(import.meta.dirname, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-lock-'))
const bundle = path.join(tmp, 'persistence.cjs')
const children = []
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function occupant(lock, identity) {
  fs.mkdirSync(lock)
  const nonce = randomUUID()
  const file = `owner-${nonce}.json`
  fs.writeFileSync(path.join(lock, file), JSON.stringify({ ...identity, nonce }))
  return file
}

const childCode = String.raw`
  const fs = require('node:fs')
  const path = require('node:path')
  const [bundle, lock, role, release, oldOwner] = process.argv.slice(1)
  const { withFileLock } = require(bundle)
  const wait = (file) => {
    const end = Date.now() + 10000
    while (!fs.existsSync(file)) {
      if (Date.now() >= end) throw new Error('fixture release timeout')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
    }
  }
  if (role === 'reaper') {
    const unlink = fs.unlinkSync
    let paused = false
    fs.unlinkSync = (file, ...args) => {
      if (!paused && file === path.join(lock, oldOwner)) {
        paused = true
        process.send({ kind: 'observed' })
        wait(release)
      }
      return unlink(file, ...args)
    }
  }
  try {
    withFileLock(lock, () => {
      process.send({ kind: 'entered' })
      if (role === 'reaper') throw new Error('stale reaper acquired a live lock')
      wait(release)
    }, { timeoutMs: role === 'reaper' ? 500 : 2000 })
    process.send({ kind: 'released' })
  } catch (error) {
    if (role !== 'reaper' || !String(error).includes('Timed out acquiring')) throw error
    process.send({ kind: 'blocked' })
  }
  process.disconnect()
`

function child(lock, role, release, oldOwner = '') {
  const proc = spawn(process.execPath, ['-e', childCode, bundle, lock, role, release, oldOwner], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true })
  const messages = []
  let stderr = ''
  proc.stderr.on('data', (chunk) => { stderr += chunk })
  proc.on('message', (message) => messages.push(message))
  const exited = new Promise((resolve) => proc.once('exit', (code) => resolve(code)))
  const result = { proc, exited, messages, async wait(kind) {
    const deadline = Date.now() + 12000
    while (!messages.some((message) => message.kind === kind)) {
      if (proc.exitCode !== null || proc.signalCode !== null || Date.now() > deadline) throw new Error(`${role} did not send ${kind}: ${stderr}`)
      await sleep(5)
    }
  } }
  children.push(result)
  return result
}

try {
  const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
  const program = ts.createProgram([path.join(root, 'scripts/fixtures/persistence-sync-types.ts')], { ...parsed.options, noEmit: true })
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n')), [])
  await build({ entryPoints: [path.join(root, 'src/main/persistence.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
  const { withFileLock, withStorageTransaction, atomicWriteJson, currentProcessIdentity, processOwnerState } = await import(pathToFileURL(bundle).href)
  const own = currentProcessIdentity()
  const oldInstance = own.instance.slice(0, -1) + (own.instance.endsWith('0') ? '1' : '0')
  assert.equal(processOwnerState(own), 'live')
  assert.equal(processOwnerState({ ...own, instance: oldInstance }), 'dead')
  assert.equal(processOwnerState({ ...own, instance: 'corrupt-process-identity' }), 'unknown')
  assert.equal(processOwnerState({ pid: own.pid }), 'unknown')
  assert.equal(processOwnerState(own, () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) }), 'unknown')
  assert.equal(processOwnerState(own, () => ({ state: 'alive' })), 'unknown')

  const storage = path.join(tmp, 'data')
  withStorageTransaction(storage, (token) => {
    assert.equal(withStorageTransaction(storage, () => 42, token), 42)
    assert.throws(() => withStorageTransaction(storage, () => {}), /transaction token/)
    withFileLock(path.join(storage, 'events.lock'), () => {
      assert.throws(() => withStorageTransaction(storage, () => {}, token), /Lock order violation/)
    }, { kind: 'event' })
  })
  assert.throws(() => withStorageTransaction(storage, () => Promise.resolve()), /synchronous/)
  let asyncEntered = false
  let asyncEffect = false
  assert.throws(() => withStorageTransaction(storage, async () => {
    asyncEntered = true
    await Promise.resolve()
    asyncEffect = true
  }), /synchronous/)
  await Promise.resolve()
  assert.equal(asyncEntered, false)
  assert.equal(asyncEffect, false)
  console.log('PASS identity, explicit transaction reentry and lock order')

  const lock = path.join(tmp, 'unknown.lock')
  for (const state of ['malformed', 'missing', 'unknown', 'denied', 'live']) {
    const file = occupant(lock, state === 'missing' ? { pid: own.pid } : { ...own, leaseExpiresAt: 0 })
    if (state === 'malformed') fs.writeFileSync(path.join(lock, file), '{invalid')
    const before = fs.readFileSync(path.join(lock, file))
    const probe = state === 'unknown' ? () => ({ state: 'unknown' }) : state === 'denied' ? () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) } : () => ({ state: 'alive', instance: own.instance })
    assert.throws(() => withFileLock(lock, () => assert.fail('must not enter'), { timeoutMs: 30, probe }), /Timed out acquiring/)
    assert.deepEqual(fs.readFileSync(path.join(lock, file)), before)
    fs.unlinkSync(path.join(lock, file))
    fs.rmdirSync(lock)
  }
  occupant(lock, { ...own, instance: oldInstance })
  assert.equal(withFileLock(lock, () => 'recovered'), 'recovered')
  fs.writeFileSync(lock, 'legacy file lock')
  assert.throws(() => withFileLock(lock, () => {}, { timeoutMs: 30 }), /Timed out acquiring/)
  assert.equal(fs.readFileSync(lock, 'utf8'), 'legacy file lock')
  fs.unlinkSync(lock)
  console.log('PASS live/unknown owners are preserved; confirmed PID reuse recovers')

  const json = path.join(tmp, 'durable.json')
  atomicWriteJson(json, { value: 'before' })
  for (const method of ['writeFileSync', 'fsyncSync', 'renameSync']) {
    const original = fs[method]
    fs[method] = () => { throw new Error(`injected ${method}`) }
    try { assert.throws(() => atomicWriteJson(json, { value: 'after' }), /injected/) }
    finally { fs[method] = original }
    assert.deepEqual(JSON.parse(fs.readFileSync(json, 'utf8')), { value: 'before' })
    assert.equal(fs.readdirSync(tmp).filter((name) => name.startsWith('durable.json.') && name.endsWith('.tmp')).length, 0)
  }
  atomicWriteJson(json, { value: 'after' })
  assert.deepEqual(JSON.parse(fs.readFileSync(json, 'utf8')), { value: 'after' })
  console.log('PASS write/fsync/rename failures preserve previous JSON; retry succeeds')

  const crashLock = path.join(tmp, 'crash.lock')
  const killed = child(crashLock, 'holder', path.join(tmp, 'never-release'))
  await killed.wait('entered')
  const deadOwnerFile = fs.readdirSync(crashLock)[0]
  const deadIdentity = JSON.parse(fs.readFileSync(path.join(crashLock, deadOwnerFile), 'utf8'))
  killed.proc.kill()
  await killed.exited
  assert.equal(withFileLock(crashLock, () => 'after death'), 'after death')
  console.log('PASS real crashed holder recovery')

  const abaLock = path.join(tmp, 'aba.lock')
  const oldOwner = occupant(abaLock, deadIdentity)
  const resumeReaper = path.join(tmp, 'resume-reaper')
  const releaseHolder = path.join(tmp, 'release-holder')
  const c1 = child(abaLock, 'reaper', resumeReaper, oldOwner)
  await c1.wait('observed')
  const c2 = child(abaLock, 'holder', releaseHolder)
  await c2.wait('entered')
  const newOwner = fs.readdirSync(abaLock)[0]
  const liveBytes = fs.readFileSync(path.join(abaLock, newOwner))
  fs.writeFileSync(resumeReaper, '')
  await c1.wait('blocked')
  assert.equal(await c1.exited, 0)
  assert.deepEqual(fs.readFileSync(path.join(abaLock, newOwner)), liveBytes)
  fs.writeFileSync(releaseHolder, '')
  assert.equal(await c2.exited, 0)
  assert.equal(fs.existsSync(abaLock), false)
  console.log('PASS paused stale reaper cannot remove a successor owner (real processes)')
  console.log('PERSISTENCE LOCK SMOKE PASSED')
} finally {
  for (const { proc } of children) if (proc.exitCode === null && proc.signalCode === null) proc.kill()
  await Promise.all(children.map((item) => item.exited))
  assert.equal(path.dirname(tmp), path.resolve(os.tmpdir()))
  fs.rmSync(tmp, { recursive: true, force: true })
}
