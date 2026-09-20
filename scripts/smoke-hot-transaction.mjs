#!/usr/bin/env node
/**
 * Transaction smoke for the L1/L2 updater boundary.
 *
 * The feed is local and signed with a temporary key. The Electron check at the
 * end uses the repository's installed electron.exe and creates no BrowserWindow.
 */
import { build } from 'esbuild'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const root = path.resolve(import.meta.dirname, '..')
const shell = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-hot-transaction-'))
const feedDir = path.join(work, 'feed')
const userRoot = path.join(work, 'user-data')
fs.mkdirSync(feedDir, { recursive: true })
fs.mkdirSync(userRoot, { recursive: true })

let server
let failed = 0
let rendererDelayMs = 0
let onArtifact
const artifactRequests = new Map()
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
const keyId = `agentdeck-hot-transaction-${Date.now().toString(36)}`
process.env.AGENTDECK_HOT_TRUST_HEX = `${keyId}:${Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex')}`
delete process.env.AGENTDECK_DISABLE_HOT

const ok = (condition, message) => {
  console.log(`  ${condition ? '[ok]' : '[FAIL]'} ${message}`)
  if (!condition) failed++
}
const equal = (actual, expected, message) => ok(actual === expected, actual === expected ? message : `${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`)
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex')
const version = (n) => `${shell}-hot.${n}`

async function loadTs(entry) {
  const outfile = path.join(work, `${path.basename(entry, '.ts')}-${Math.random().toString(36).slice(2)}.cjs`)
  await build({ entryPoints: [path.join(root, entry)], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18', logLevel: 'silent' })
  return import(pathToFileURL(outfile).href)
}

const { HotUpdater } = await loadTs('src/main/hot/updater.ts')
const { resolveHotState } = await loadTs('src/main/hot/resolve.ts')
const { readPointer } = await loadTs('src/main/hot/pointer.ts')
const { createZipStore } = await loadTs('src/main/hot/zip.ts')
const { canonicalJson } = await loadTs('src/main/hot/canonical.ts')

function writeTree(channel, release, payload) {
  const tree = path.join(work, 'trees', channel, release)
  fs.rmSync(tree, { recursive: true, force: true })
  for (const [relative, data] of Object.entries(payload)) {
    const target = path.join(tree, ...relative.split('/'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, data)
  }
  return tree
}

function treeEntries(tree) {
  const entries = []
  const walk = (dir, base = dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(absolute, base)
      else entries.push({ path: path.relative(base, absolute).split(path.sep).join('/'), data: fs.readFileSync(absolute) })
    }
  }
  walk(tree)
  return entries
}

function publish(channel, release, options = {}) {
  const files = channel === 'payload'
    ? {
        'out/main/index.js': Buffer.from(`module.exports = { version: ${JSON.stringify(release)} }\n`),
        'out/renderer/index.html': Buffer.from(`<!doctype html><body>payload ${release}</body>\n`)
      }
    : {
        'out/renderer/index.html': Buffer.from(`<!doctype html><body>renderer ${release}</body>\n`),
        'out/renderer/app.js': Buffer.from(`console.log(${JSON.stringify(release)})\n`)
      }
  const tree = writeTree(channel, release, files)
  const entries = treeEntries(tree)
  const zip = Buffer.from(createZipStore(entries))
  const manifestFiles = entries.map((entry) => ({ path: entry.path, sha256: sha256(entry.data), size: entry.data.length }))
  const payload = {
    schemaVersion: 1,
    channel,
    version: release,
    minMainVersion: options.minMainVersion ?? shell,
    minShellVersion: options.minShellVersion ?? shell,
    releaseDate: new Date().toISOString(),
    keyId,
    artifact: { name: `${channel}-${release}.zip`, sha256: sha256(zip), size: zip.length },
    files: manifestFiles
  }
  const manifest = JSON.stringify({
    payload,
    signature: crypto.sign(null, Buffer.from(canonicalJson(payload), 'utf8'), privateKey).toString('base64')
  })
  const channelDir = path.join(feedDir, channel)
  fs.rmSync(channelDir, { recursive: true, force: true })
  fs.mkdirSync(channelDir, { recursive: true })
  fs.writeFileSync(path.join(channelDir, 'manifest.json'), manifest)
  fs.writeFileSync(path.join(channelDir, payload.artifact.name), zip)
}

function setUserData(name) {
  const userData = path.join(userRoot, name)
  fs.rmSync(userData, { recursive: true, force: true })
  fs.mkdirSync(userData, { recursive: true })
  return userData
}

function countArtifacts(channel) {
  return artifactRequests.get(channel) ?? 0
}

function makeUpdater(userData, idle = true) {
  let currentIdle = idle
  const calls = { relaunch: [], loadFile: [] }
  const updater = new HotUpdater({
    getWindow: () => ({ loadFile: (file) => calls.loadFile.push(file), webContents: { send: () => {} } }),
    isMainIdle: () => currentIdle,
    relaunchForUpdate: (release) => calls.relaunch.push(release),
    settings: () => ({ updateFeedUrl: feedBase }),
    getUserDataDir: () => userData,
    getShellVersion: () => shell,
    getAppDir: () => null
  })
  return { updater, calls, setIdle: (value) => { currentIdle = value } }
}

function pointerVersion(userData, channel) {
  try { return readPointer(userData, channel)?.version ?? null } catch { return '<invalid>' }
}

function effective(userData) {
  const resolved = resolveHotState(userData, shell)
  return {
    payload: resolved.payload?.version ?? null,
    renderer: resolved.rendererVersion ?? null,
    html: resolved.rendererIndexHtml ? path.relative(userData, resolved.rendererIndexHtml).split(path.sep).join('/') : null
  }
}

server = http.createServer((request, response) => {
  const relative = decodeURIComponent((request.url ?? '/').split('?')[0]).replace(/^\/+/, '')
  const file = path.resolve(feedDir, relative)
  const inside = file === feedDir || file.startsWith(`${feedDir}${path.sep}`)
  if (!inside || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    response.writeHead(404)
    response.end('not found')
    return
  }
  if (!relative.endsWith('/manifest.json')) {
    const channel = relative.split('/')[0]
    artifactRequests.set(channel, countArtifacts(channel) + 1)
    onArtifact?.(channel)
  }
  const bytes = fs.readFileSync(file)
  response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length })
  if (relative.startsWith('renderer/') && relative.endsWith('.zip') && rendererDelayMs) {
    setTimeout(() => response.end(bytes), rendererDelayMs)
  } else {
    response.end(bytes)
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const feedBase = `http://127.0.0.1:${server.address().port}`

async function scenarioSameRoundUnlocksL2() {
  console.log('\n[scenario] same round L1 unlocks L2 and restarts once')
  const userData = setUserData('same-round')
  const l1 = version(2)
  const l2 = version(3)
  publish('payload', l1)
  publish('renderer', l2, { minMainVersion: l1 })
  const context = makeUpdater(userData)
  const beforeL2Artifacts = countArtifacts('renderer')
  const checked = await context.updater.check()
  equal(checked.available?.payload, l1, 'check exposes L1')
  equal(checked.available?.renderer, undefined, 'old L1 gate rejects dependent L2 during initial check')
  const applied = await context.updater.applyAll()
  equal(applied.ok, true, 'applyAll succeeds after re-fetching L2')
  equal(context.calls.relaunch.length, 1, 'applyAll relaunches exactly once')
  equal(context.calls.relaunch[0], l1, 'relaunch is for the effective L1')
  equal(context.calls.loadFile.length, 0, 'batch L2 is not loaded into the old main process')
  equal(pointerVersion(userData, 'payload'), l1, 'L1 pointer is committed')
  equal(pointerVersion(userData, 'renderer'), l2, 'L2 pointer is committed')
  ok(countArtifacts('renderer') > beforeL2Artifacts, 'L2 download is performed after L1 becomes effective')
  const resolved = effective(userData)
  equal(resolved.payload, l1, 'new process resolves the L1 payload')
  equal(resolved.renderer, l2, 'new process resolves the dependent L2')
}

async function scenarioDelayedL2() {
  console.log('\n[scenario] busy L1 stages and delays L2 download')
  const userData = setUserData('staged')
  const l1 = version(4)
  const l2 = version(5)
  publish('payload', l1)
  publish('renderer', l2, { minMainVersion: l1 })
  const context = makeUpdater(userData, false)
  const rendererArtifacts = countArtifacts('renderer')
  await context.updater.check()
  const applied = await context.updater.applyAll()
  equal(applied.ok, true, 'busy applyAll leaves a staged L1')
  equal(context.updater.hasStagedPayload(), true, 'L1 keeps staged semantics while busy')
  equal(pointerVersion(userData, 'payload'), null, 'busy L1 does not flip its pointer')
  equal(pointerVersion(userData, 'renderer'), null, 'dependent L2 pointer stays untouched')
  equal(countArtifacts('renderer'), rendererArtifacts, 'dependent L2 is not downloaded early')
  equal(context.calls.relaunch.length, 0, 'staging does not relaunch')
  context.setIdle(true)
  await context.updater.applyStagedOnQuit()
  equal(pointerVersion(userData, 'payload'), l1, 'staged L1 flips during quit')
  equal(context.calls.relaunch.length, 1, 'quit completion schedules exactly one relaunch')
  await context.updater.applyStagedOnQuit()
  equal(context.calls.relaunch.length, 1, 'repeated quit completion does not relaunch again')

  const next = makeUpdater(userData)
  const checked = await next.updater.check()
  equal(checked.available?.renderer, l2, 'L2 becomes available after the new L1 is active')
  equal((await next.updater.apply('renderer')).ok, true, 'delayed L2 can be applied in the next process')
  equal(pointerVersion(userData, 'renderer'), l2, 'delayed L2 pointer is committed')
}

async function scenarioFeedRollbackAfterCheck() {
  console.log('\n[scenario] feed rollback after check never downgrades')
  const userData = setUserData('feed-rollback')
  const active = version(6)
  const newer = version(7)
  publish('payload', active)
  const context = makeUpdater(userData)
  equal((await context.updater.apply('payload')).ok, true, 'seed active L1')
  const beforeRelaunches = context.calls.relaunch.length
  publish('payload', newer)
  await context.updater.check()
  publish('payload', active)
  equal((await context.updater.applyAll()).ok, true, 'rollback between check and apply is treated as a no-op')
  equal(pointerVersion(userData, 'payload'), active, 'feed rollback cannot move the L1 pointer backward')
  equal(context.calls.relaunch.length, beforeRelaunches, 'feed rollback does not relaunch')
}

async function scenarioDirectOldVersion() {
  console.log('\n[scenario] direct same/old version applications are guarded')
  const userData = setUserData('direct-old')
  const activeL1 = version(8)
  const activeL2 = version(10)
  const oldL1 = version(7)
  const oldL2 = version(9)
  const context = makeUpdater(userData)
  publish('payload', activeL1)
  equal((await context.updater.apply('payload')).ok, true, 'seed direct L1')
  publish('payload', oldL1)
  equal((await context.updater.apply('payload')).ok, false, 'direct old L1 is rejected')
  equal(pointerVersion(userData, 'payload'), activeL1, 'old L1 cannot move its pointer')

  publish('renderer', activeL1)
  equal((await context.updater.apply('renderer')).ok, true, 'renderer already bundled in L1 is idempotent')
  equal(pointerVersion(userData, 'renderer'), null, 'bundled renderer needs no standalone pointer')

  publish('renderer', activeL2)
  equal((await context.updater.apply('renderer')).ok, true, 'seed direct L2')
  const loads = context.calls.loadFile.length
  publish('renderer', activeL2)
  equal((await context.updater.apply('renderer')).ok, true, 'same L2 is idempotent')
  equal(context.calls.loadFile.length, loads, 'same L2 does not reload the renderer')
  publish('renderer', oldL2)
  equal((await context.updater.apply('renderer')).ok, false, 'direct old L2 is rejected')
  equal(pointerVersion(userData, 'renderer'), activeL2, 'old L2 cannot move its pointer')

  for (const channel of ['payload', 'renderer']) {
    publish(channel, version(12))
    await context.updater.check()
    publish(channel, channel === 'payload' ? oldL1 : oldL2)
    equal((await context.updater.applyAll()).ok, true, `${channel} stale check is reconciled without downgrading`)
    equal(pointerVersion(userData, channel), channel === 'payload' ? activeL1 : activeL2, `${channel} pointer survives feed rollback after check`)
    equal(context.updater.getState().available?.[channel], undefined, `${channel} obsolete feed version no longer appears available`)
  }
}

async function scenarioElectronRestart() {
  console.log('\n[scenario] real HotUpdater waits for delayed L2 before Electron restarts')
  const electron = createRequire(import.meta.url)('electron')
  ok(fs.existsSync(electron), 'repository Electron binary is available')
  if (!fs.existsSync(electron)) return
  const electronDir = path.join(work, 'electron')
  fs.mkdirSync(electronDir, { recursive: true })
  const logFile = path.join(electronDir, 'lifecycle.log')
  const dataDir = path.join(electronDir, 'user-data')
  fs.mkdirSync(dataDir, { recursive: true })
  const l1 = version(20)
  const l2 = version(21)
  publish('payload', l1)
  publish('renderer', l2, { minMainVersion: l1 })
  rendererDelayMs = 800
  await build({
    entryPoints: [path.join(root, 'src/main/hot/updater.ts'), path.join(root, 'src/main/hot/resolve.ts')],
    outdir: electronDir, outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node',
    format: 'cjs', target: 'node18', logLevel: 'silent'
  })
  const harness = path.join(electronDir, 'main.cjs')
  fs.writeFileSync(harness, `
const { app } = require('electron')
const fs = require('node:fs')
const { HotUpdater } = require('./updater.cjs')
const { resolveHotState } = require('./resolve.cjs')
const dataDir = process.env.AGENTDECK_TRANSACTION_USER_DATA
const shell = process.env.AGENTDECK_TRANSACTION_SHELL
const restarted = process.argv.includes('--hot-transaction-restarted')
const log = (event, fields = {}) => fs.appendFileSync(process.env.AGENTDECK_TRANSACTION_LOG,
  JSON.stringify({ event, pid: process.pid, restarted, ...fields }) + '\\n')
app.disableHardwareAcceleration()
app.setPath('userData', dataDir)
const timeout = setTimeout(() => { log('timeout'); app.exit(1) }, 15000)
app.on('will-quit', () => { clearTimeout(timeout); log('quit') })
app.whenReady().then(async () => {
  log('boot')
  const updater = new HotUpdater({
    getWindow: () => ({ loadFile: () => log('load-renderer'), webContents: { send: () => {} } }),
    isMainIdle: () => true,
    relaunchForUpdate: (version) => {
      const hot = resolveHotState(dataDir, shell)
      log('relaunch-requested', { version, payload: hot.payload?.version, renderer: hot.rendererVersion })
      app.relaunch({ args: ['--no-sandbox', '--disable-gpu', __filename, '--hot-transaction-restarted'] })
      app.quit()
    },
    settings: () => ({ updateFeedUrl: process.env.AGENTDECK_TRANSACTION_FEED }),
    getUserDataDir: () => dataDir,
    getShellVersion: () => shell,
    getAppDir: () => null
  })
  const state = await updater.check()
  log('checked', { state })
  if (restarted) { app.quit(); return }
  const result = await updater.applyAll()
  log('applied', { result })
  if (!result.ok) app.exit(1)
}).catch((error) => { log('error', { message: String(error.stack || error) }); app.exit(1) })
`)
  const env = { ...process.env, AGENTDECK_TRANSACTION_USER_DATA: dataDir, AGENTDECK_TRANSACTION_LOG: logFile,
    AGENTDECK_TRANSACTION_SHELL: shell, AGENTDECK_TRANSACTION_FEED: feedBase }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.AGENTDECK_HOT_AUTO_APPLY_SHELL
  const child = spawn(electron, ['--no-sandbox', '--disable-gpu', harness], {
    cwd: root,
    windowsHide: true,
    stdio: 'ignore',
    env
  })
  const guard = setTimeout(() => child.kill(), 20_000)
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', resolve)
    })
    equal(code, 0, 'initial Electron process exits normally after the update')
  } finally {
    clearTimeout(guard)
  }
  const readEvents = () => fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)) : []
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline && !readEvents().some((event) => event.restarted && event.event === 'quit')) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const events = readEvents()
  const boots = events.filter((event) => event.event === 'boot')
  const launches = events.filter((event) => event.event === 'relaunch-requested')
  const after = events.find((event) => event.restarted && event.event === 'checked')?.state
  equal(launches.length, 1, 'real updater requests exactly one relaunch')
  equal(launches[0]?.payload, l1, 'L1 is committed before requesting relaunch')
  equal(launches[0]?.renderer, l2, 'delayed L2 is committed before requesting relaunch')
  equal(events.some((event) => event.event === 'load-renderer'), false, 'old main never loads the dependent L2')
  equal(boots.length, 2, 'Electron produces exactly two headless boots')
  ok(boots[0]?.pid !== boots[1]?.pid, 'relaunch uses a new process')
  equal(after?.currentVersion, l1, 'restarted updater resolves the new L1')
  equal(after?.activeRendererVersion, l2, 'restarted updater resolves the new L2')
  equal(after && Object.keys(after.available ?? {}).length, 0, 'restarted updater does not repeat the update prompt')
  equal(events.filter((event) => event.event === 'quit').length, 2, 'both isolated Electron processes finish')
  equal(events.some((event) => event.event === 'error' || event.event === 'timeout'), false, 'real lifecycle has no error or timeout')
  rendererDelayMs = 0
}

async function scenarioPointerChangesDuringDownload() {
  console.log('\n[scenario] pointer advances while an older artifact is downloading')
  for (const channel of ['payload', 'renderer']) {
    const userData = setUserData(`download-${channel}`)
    const newerData = setUserData(`advanced-${channel}`)
    const context = makeUpdater(userData)
    publish(channel, version(27))
    equal((await context.updater.apply(channel)).ok, true, `${channel} seeds the current version`)
    publish(channel, version(30))
    equal((await makeUpdater(newerData).updater.apply(channel)).ok, true, `${channel} prepares a verified newer installation`)
    publish(channel, version(29))
    const directory = channel === 'payload' ? 'hot-app' : 'hot-renderer'
    onArtifact = (requestedChannel) => {
      if (requestedChannel !== channel) return
      onArtifact = undefined
      fs.cpSync(path.join(newerData, directory), path.join(userData, directory), { recursive: true })
    }
    equal((await context.updater.apply(channel)).ok, false, `${channel} rechecks the version before flipping its pointer`)
    equal(pointerVersion(userData, channel), version(30), `${channel} preserves the newer pointer installed during download`)
    onArtifact = undefined
  }
}

try {
  await scenarioSameRoundUnlocksL2()
  await scenarioDelayedL2()
  await scenarioFeedRollbackAfterCheck()
  await scenarioDirectOldVersion()
  await scenarioPointerChangesDuringDownload()
  await scenarioElectronRestart()
} finally {
  await new Promise((resolve) => server?.close(resolve))
  try { fs.rmSync(work, { recursive: true, force: true }) } catch { /* keep diagnostics if Windows still holds a file */ }
}

if (failed) {
  console.error(`\n[FAIL] SMOKE HOT TRANSACTION: ${failed} assertion(s) failed`)
  process.exitCode = 1
} else {
  console.log('\n[ok] SMOKE HOT TRANSACTION: all transaction and isolated Electron checks passed')
}
