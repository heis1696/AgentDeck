import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { verifyInstalledMeeting } from './fixtures/meeting-release-cdp.mjs'

const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-meeting-stage4-release-'))
const snapshot = path.join(temporary, 'snapshot')
const evidence = { date: new Date().toISOString(), isolatedRoot: temporary, checks: [], launches: [] }
const evidenceFile = path.join(temporary, 'evidence.json')
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const checked = (name, details = {}) => {
  evidence.checks.push({ name, ...details })
  fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2))
  console.log('PASS ' + name)
}
const run = (name, command, args, cwd, env = process.env) => {
  const result = spawnSync(command, args, { cwd, env, windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300000 })
  fs.writeFileSync(path.join(temporary, name + '.log'), (result.stdout ?? '') + (result.stderr ?? ''))
  assert.equal(result.error, undefined, name)
  assert.equal(result.status, 0, name + ': see isolated log')
  return result.stdout
}
const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const file = path.join(directory, entry.name)
  return entry.isDirectory() ? walk(file) : [file]
})
const loadTs = async (relative) => {
  const outfile = path.join(temporary, path.basename(relative, '.ts') + '.cjs')
  await build({ entryPoints: [path.join(root, relative)], outfile, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
  return import(pathToFileURL(outfile).href)
}
let feed
async function verifyRelease(installed, packageVersion, cleanEnv) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const keyId = 'meeting-stage4-isolated'
  const trust = keyId + ':' + Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex')
  const releaseEnv = { ...cleanEnv, HOT_SIGNING_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }), RELEASE_HOT_SKIP_PACK: '1' }
  delete releaseEnv.HOT_SIGNING_KEY_PATH
  run('release-hot-both', process.execPath, ['scripts/release-hot.mjs', '--skip-build', '--channel', 'both', '--seq', '400', '--key-id', keyId], snapshot, releaseEnv)
  run('release-hot-renderer', process.execPath, ['scripts/release-hot.mjs', '--skip-build', '--channel', 'renderer', '--seq', '401', '--key-id', keyId], snapshot, releaseEnv)
  process.env.AGENTDECK_HOT_TRUST_HEX = trust
  const { verifyManifest } = await loadTs('src/main/hot/verifier.ts')
  const feedRoot = path.join(snapshot, 'dist/feed')
  for (const channel of ['payload', 'renderer', 'shell']) {
    const manifestFile = path.join(feedRoot, 'stable', channel, 'manifest.json')
    const verdict = verifyManifest(manifestFile, channel, { mainVersion: packageVersion, shellVersion: packageVersion })
    assert.equal(verdict.ok, true, channel + ' manifest verification')
    const manifest = verdict.manifest
    const zip = fs.readFileSync(path.join(path.dirname(manifestFile), manifest.artifact.name))
    assert.equal(sha(zip), manifest.artifact.sha256)
    assert.equal(zip.length, manifest.artifact.size)
    checked('signed ' + channel + ' feed artifact verified', { version: manifest.version, files: manifest.files.length, bytes: zip.length })
  }
  feed = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname)
    const file = path.resolve(feedRoot, '.' + pathname)
    if (!file.startsWith(feedRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404).end(); return }
    response.setHeader('content-length', fs.statSync(file).size)
    fs.createReadStream(file).pipe(response)
  })
  await new Promise((resolve) => feed.listen(0, '127.0.0.1', resolve))
  const feedBase = 'http://127.0.0.1:' + feed.address().port + '/stable'
  const data = path.join(temporary, 'userdata')
  fs.mkdirSync(path.join(data, 'meetings'), { recursive: true })
  fs.mkdirSync(path.join(data, 'issues'), { recursive: true })
  const meetingId = 'meeting_stage4_you384'
  const issueId = 'iss_stage4_you384'
  const title = 'Stage4 isolated YOU-384 meeting'
  const meeting = { id: meetingId, issueId, topic: title, participants: [{ agentId: 'codex', role: 'reporter', officeTaskId: 'legacy_shared_office' }], status: 'cancelled', round: 1, maxRounds: 6, maxInnerTurns: 3, maxDurationMs: 3600000, minutes: [], noProgress: 0, noProgressCap: 2, failures: 0, pendingChairNotes: [], createdAt: 1, updatedAt: 2 }
  const legacy = JSON.stringify({ schemaVersion: 1, meetings: [meeting], turns: [{ id: 'turn_legacy_missing', meetingId, agentId: 'codex', officeTaskId: 'legacy_shared_office', round: 1, phase: 'report', status: 'done', summary: 'Explicit summary, not authoritative body', speaker: { name: 'Fixture reporter', role: 'reporter', platform: 'fixture' } }] })
  fs.writeFileSync(path.join(data, 'meetings/index.json'), legacy)
  fs.writeFileSync(path.join(data, 'issues/index.json'), JSON.stringify({ issues: [{ id: issueId, identifier: 'YOU-384', title, description: title, status: 'cancelled', priority: 'normal', labels: [], position: 1, createdBy: 'user', createdAt: 1, updatedAt: 2, taskId: 'missing_legacy_container' }], comments: [], runs: [], nextIdentifier: 385 }))
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ updateFeedUrl: feedBase, workspaceDir: path.join(temporary, 'workspace'), sharedDir: path.join(temporary, 'shared') }))
  const fixtureIssues = JSON.parse(fs.readFileSync(path.join(data, 'issues/index.json'), 'utf8'))
  fixtureIssues.issues[0].createdAt = Date.now()
  fixtureIssues.issues[0].updatedAt = Date.now()
  fs.writeFileSync(path.join(data, 'issues/index.json'), JSON.stringify(fixtureIssues))
  const boot = async (phase, currentVersion, rendererVersion) => {
    const result = await verifyInstalledMeeting({ installed, data, trust, cleanEnv, phase, currentVersion, rendererVersion, meetingId, title, temporary })
    evidence.launches.push(result)
    checked(phase + ' real installer-copy IPC, meeting page and versions', result)
  }
  await boot('builtin', packageVersion, undefined)
  const migrated = JSON.parse(fs.readFileSync(path.join(data, 'meetings/index.json'), 'utf8'))
  assert.equal(migrated.meetings[0].publicVersion, 0)
  assert.equal(migrated.meetings[0].turnVersion, 0)
  assert.equal(fs.readFileSync(path.join(data, 'meetings/index.pre-migration.json'), 'utf8'), legacy)
  const { HotUpdater } = await loadTs('src/main/hot/updater.ts')
  const relaunches = []
  const updater = new HotUpdater({ getWindow: () => null, isMainIdle: () => true, relaunchForUpdate: (version) => relaunches.push(version), settings: () => ({ updateFeedUrl: feedBase }), getUserDataDir: () => data, getShellVersion: () => packageVersion, getAppDir: () => null })
  await updater.check()
  const payloadResult = await updater.apply('payload')
  assert.equal(payloadResult.ok, true, payloadResult.error)
  await boot('payload', packageVersion + '-hot.400', undefined)
  await updater.check()
  const rendererResult = await updater.apply('renderer')
  assert.equal(rendererResult.ok, true, rendererResult.error)
  await boot('renderer', packageVersion + '-hot.400', packageVersion + '-hot.401')
  assert.equal(fs.readFileSync(path.join(data, 'meetings/index.pre-migration.json'), 'utf8'), legacy)
  checked('payload/renderer pointers survive separate restarts and preserve migration backup', { relaunches })
}

try {
  assert.equal(process.platform, 'win32', 'installer-copy verification requires Windows')
  fs.mkdirSync(snapshot)
  for (const relative of ['src', 'build', 'package.json', 'package-lock.json', 'electron-builder.yml']) fs.cpSync(path.join(root, relative), path.join(snapshot, relative), { recursive: true })
  fs.mkdirSync(path.join(snapshot, 'scripts'))
  fs.copyFileSync(path.join(root, 'scripts/release-hot.mjs'), path.join(snapshot, 'scripts/release-hot.mjs'))
  for (const entry of ['main', 'preload', 'renderer']) fs.cpSync(path.join(root, 'out', entry), path.join(snapshot, 'out', entry), { recursive: true })
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(snapshot, 'node_modules'), 'junction')
  const packageVersion = JSON.parse(fs.readFileSync(path.join(snapshot, 'package.json'), 'utf8')).version
  const builder = path.join(root, 'node_modules/electron-builder/cli.js')
  const cleanEnv = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
  for (const name of ['CSC_LINK', 'WIN_CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_KEY_PASSWORD']) delete cleanEnv[name]
  const packedRoot = path.join(snapshot, 'dist/.shell-pack')
  run('pack', process.execPath, [builder, '--dir', '--publish', 'never', '--config.npmRebuild=false', '--config.directories.output=' + packedRoot], snapshot, cleanEnv)
  const packed = path.join(packedRoot, 'win-unpacked')
  const asar = require('@electron/asar')
  const archive = path.join(packed, 'resources/app.asar')
  for (const entry of ['main/index.js', 'main/bootstrap.js', 'main/sidecar-server.js', 'preload/index.js', 'renderer/index.html']) assert.equal(sha(asar.extractFile(archive, path.join('out', ...entry.split('/')))), sha(fs.readFileSync(path.join(snapshot, 'out', entry))))
  assert.equal(asar.listPackage(archive).some((name) => /stage[234].*\.log|smoke-.*\.cjs/.test(name)), false)
  checked('clean isolated pack matches five executable entry artifacts', { packageVersion, asarSha256: sha(fs.readFileSync(archive)) })
  const installers = path.join(temporary, 'installers')
  run('installer-build', process.execPath, [builder, '--win', 'nsis', '--x64', '--publish', 'never', '--config.npmRebuild=false', '--config.directories.output=' + installers], snapshot, cleanEnv)
  const installer = walk(installers).find((file) => file.endsWith('.exe') && !file.includes('win-unpacked'))
  assert.ok(installer)
  const unpackedInstaller = path.join(temporary, 'installer-extracted')
  const sevenZip = require('7zip-bin').path7za
  run('installer-extract', sevenZip, ['x', installer, '-o' + unpackedInstaller, '-y'], temporary)
  const appArchive = walk(unpackedInstaller).find((file) => /app-64\.7z$/.test(file))
  const installed = appArchive ? path.join(temporary, 'installed-copy') : unpackedInstaller
  if (appArchive) run('installer-payload-extract', sevenZip, ['x', appArchive, '-o' + installed, '-y'], temporary)
  assert.ok(fs.existsSync(path.join(installed, 'AgentDeck.exe')))
  const installedAsar = path.join(installed, 'resources/app.asar')
  assert.equal(sha(asar.extractFile(installedAsar, path.join('out', 'main', 'index.js'))), sha(fs.readFileSync(path.join(snapshot, 'out/main/index.js'))))
  checked('actual NSIS payload extracted without running installer', { installerSha256: sha(fs.readFileSync(installer)), installedAsarSha256: sha(fs.readFileSync(installedAsar)) })
  await verifyRelease(installed, packageVersion, cleanEnv)
  evidence.completed = true
  console.log('ISOLATED MEETING RELEASE SMOKE PASSED; evidence: ' + evidenceFile)
} finally {
  if (feed) await new Promise((resolve) => feed.close(resolve))
  fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2))
  console.log('Isolated artifacts retained: ' + temporary)
}
