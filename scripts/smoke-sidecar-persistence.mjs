import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(import.meta.dirname, '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-sidecar-persistence-'))
const children = []
let manager
let holder
const modeFile = path.join(temporary, 'server-mode')
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const exitOf = (child) => child.exitCode !== null || child.signalCode !== null
const waitExit = async (child) => {
  const deadline = Date.now() + 5000
  while (!exitOf(child)) {
    if (Date.now() > deadline) throw new Error('isolated child exit not confirmed: ' + child.pid)
    await sleep(20)
  }
}
const fixtureServer = [
  "const http=require('node:http'),fs=require('node:fs');",
  "const server=http.createServer((request,response)=>{",
  "response.setHeader('content-type','application/json');",
  "if(request.headers['x-agentdeck-token']!==process.env.AGENTDECK_SIDECAR_TOKEN){response.writeHead(401).end('{}');return}",
  "if(fs.existsSync(process.env.SIDECAR_MODE_FILE)){if(request.url==='/handshake')return;if(request.url==='/rpc'){response.writeHead(503).end('{}');return}}",
  "if(request.url==='/handshake'){response.end(JSON.stringify({protocolVersion:1,instanceId:process.env.AGENTDECK_SIDECAR_INSTANCE,pid:process.pid,startedAt:Date.now(),orphanRuns:[]}));return}",
  "if(request.url==='/rpc'){response.end(JSON.stringify({ok:true,result:{orphanRuns:[]}}));return}",
  "response.end('{}'); if(request.url==='/shutdown')setTimeout(()=>server.close(()=>process.exit(0)),10)",
  "}); server.listen(Number(process.env.AGENTDECK_SIDECAR_PORT),'127.0.0.1');"
].join('\n')

try {
  const outfile = path.join(temporary, 'sidecar.cjs')
  await build({ entryPoints: [path.join(root, 'src/main/sidecar.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
  const { SidecarManager } = await import(pathToFileURL(outfile).href)
  const data = path.join(temporary, 'data')
  fs.mkdirSync(data)
  const stateFile = path.join(data, 'sidecar-state.json')
  const before = JSON.stringify({ schemaVersion: 1, sentinel: 'preserve-existing-bytes' })
  fs.writeFileSync(stateFile, before)
  const launcher = (_node, _args, options) => {
    const child = spawn(process.execPath, ['-e', fixtureServer], { ...options, env: { ...options.env, SIDECAR_MODE_FILE: modeFile }, windowsHide: true })
    children.push(child)
    return child
  }
  manager = new SidecarManager({ userDataDir: data, spawn: launcher, requestTimeoutMs: 200 })
  let observedCode
  const originalRename = fs.renameSync
  if (process.platform === 'win32') {
    const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
    const command = "$stream=[IO.File]::Open($env:SIDECAR_LOCK_FILE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite); [Console]::WriteLine('READY'); try { Start-Sleep -Seconds 60 } finally { $stream.Dispose() }"
    holder = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], { env: { ...process.env, SIDECAR_LOCK_FILE: stateFile }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    holder.stdout.on('data', (chunk) => { output += chunk })
    const deadline = Date.now() + 10000
    while (!output.includes('READY')) {
      if (exitOf(holder) || Date.now() > deadline) throw new Error('Windows rename-blocking handle was not ready')
      await sleep(20)
    }
    fs.renameSync = (source, target) => {
      try { return originalRename(source, target) }
      catch (error) { if (target === stateFile) observedCode = error.code; throw error }
    }
  } else {
    fs.renameSync = (source, target) => {
      if (target === stateFile) { observedCode = 'EPERM'; throw Object.assign(new Error('injected rename refusal'), { code: observedCode }) }
      return originalRename(source, target)
    }
  }
  try { await assert.rejects(manager.start(), /Sidecar failed to start/) }
  finally { fs.renameSync = originalRename }
  assert.equal(observedCode, 'EPERM')
  assert.equal(fs.readFileSync(stateFile, 'utf8'), before)
  assert.equal(manager.currentStatus, 'degraded')
  assert.equal(children.length, 1)
  await waitExit(children[0])
  assert.equal(manager.child, null)
  assert.equal(fs.readdirSync(data).some((name) => name.endsWith('.tmp')), false)
  console.log('PASS ' + (process.platform === 'win32' ? 'real Windows handle reproduces EPERM' : 'synthetic rename refusal') + ': prior state preserved, temporary file removed, child exit confirmed')
  if (holder) { holder.kill(); await waitExit(holder); holder = null }
  const ready = await manager.start()
  assert.equal(ready.status, 'ready')
  assert.equal(children.length, 2)
  const retained = manager.child
  const retainedConnection = manager.snapshot
  fs.writeFileSync(modeFile, 'unreachable')
  await assert.rejects(manager.rpc('state.sync'), /exit was not confirmed/)
  assert.equal(children.length, 2)
  assert.equal(manager.child, retained)
  assert.equal(exitOf(retained), false)
  assert.equal(manager.ownsSidecar, true)
  assert.equal(manager.currentStatus, 'degraded')
  assert.equal(manager.snapshot.port, retainedConnection.port)
  assert.equal(manager.snapshot.instanceId, retainedConnection.instanceId)
  fs.rmSync(modeFile)
  await manager.reconnect()
  assert.equal(manager.child, retained)
  assert.equal(manager.ownsSidecar, true)
  assert.equal(children.length, 2)
  assert.equal(manager.currentStatus, 'ready')
  console.log('PASS RPC 503 plus live-child handshake timeout retains identity and ownership without duplicate spawn; healthy reconnect reuses the same process')
  await manager.stop()
  await waitExit(children[1])
  assert.equal(manager.currentStatus, 'stopped')
  console.log('PASS released-handle retry persists state and stops the new isolated sidecar')

  const fake = new EventEmitter()
  Object.assign(fake, { stdout: new PassThrough(), stderr: new PassThrough(), pid: process.pid, exitCode: null, signalCode: null, kill: () => false })
  let launches = 0
  const blockedData = path.join(temporary, 'unconfirmed')
  const blocked = new SidecarManager({ userDataDir: blockedData, requestTimeoutMs: 50, spawn: () => { launches++; return fake } })
  const blockedState = path.join(blockedData, 'sidecar-state.json')
  fs.renameSync = (source, target) => {
    if (target === blockedState) throw Object.assign(new Error('injected persistence refusal'), { code: 'EPERM' })
    return originalRename(source, target)
  }
  try { await assert.rejects(blocked.start(), /Sidecar failed to start/) }
  finally { fs.renameSync = originalRename }
  assert.equal(blocked.child, fake)
  assert.equal(blocked.currentStatus, 'degraded')
  await assert.rejects(blocked.stop(), /exit was not confirmed/)
  await assert.rejects(blocked.start(), /exit was not confirmed/)
  assert.equal(launches, 1)
  assert.equal(blocked.child, fake)
  fake.exitCode = 0
  fake.emit('exit', 0, null)
  await blocked.stop()
  assert.equal(blocked.currentStatus, 'stopped')
  console.log('PASS missing exit evidence retains the handle, blocks duplicate launch, and permits confirmed cleanup')
  fs.rmSync(temporary, { recursive: true, force: true })
  console.log('SIDECAR PERSISTENCE SMOKE PASSED')
} catch (error) {
  console.error('Evidence retained at ' + temporary)
  throw error
} finally {
  if (holder && !exitOf(holder)) { holder.kill(); await waitExit(holder) }
  if (manager) await manager.stop()
  for (const child of children) if (!exitOf(child)) { child.kill(); await waitExit(child) }
}
