#!/usr/bin/env node
/**
 * scripts/smoke-hot-payload.mjs — 打包态载荷热更端到端演练（docs/HOT-UPDATE-IMPL-DESIGN.md §6.2 阶段 2）
 *
 * 与 smoke-hot-pointer（指针四态）互补，聚焦载荷生效后的运行期事实：
 *   A 载荷启动：载荷 main 生效（标记写出）+ sidecar-server 自载荷目录拉起（子进程命令行含 hot-app 路径）
 *   B second boot：杀进程重启 → 对账正常（标记重写、无 crash 留证、进程稳定存活）
 *   C 回退：指针移除 → 重启走内置版（无新标记 = 主进程不再来自载荷）
 *
 * 隔离与安全同 smoke-hot-pointer：AGENTDECK_USER_DATA_DIR 显式覆盖（Windows 上 env APPDATA
 * 对 Electron 无效）+ APPDATA/USERPROFILE 临时目录 + AGENTDECK_HOT_TRUST_HEX 临时密钥。
 * 坏载荷自愈（截断 require 抛错 → relaunch 回退）由 smoke-hot-pointer 场景④覆盖，此处不重复。
 */
import { spawn, spawnSync } from 'node:child_process'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import crypto from 'node:crypto'

const root = path.resolve(import.meta.dirname, '..')
const EXE = process.env.SMOKE_HOT_EXE
  ? path.resolve(process.env.SMOKE_HOT_EXE)
  : path.join(root, 'release', 'win-unpacked', 'AgentDeck.exe')
const SCENARIO_TIMEOUT_MS = 30000
const POLL_INTERVAL_MS = 500

let failed = 0
const spawnedPids = new Set()
const tmpDirs = []
function ok(cond, msg) {
  console.log(`  ${cond ? '[ok]' : '[FAIL]'} ${msg}`)
  if (!cond) failed++
}
function fatal(msg) {
  console.error(`[FATAL] ${msg}`)
  process.exit(1)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(desc, fn, deadline) {
  while (Date.now() < deadline) {
    let v = false
    try {
      v = await fn()
    } catch {
      v = false
    }
    if (v) {
      console.log(`  [ok] ${desc}`)
      return true
    }
    await sleep(POLL_INTERVAL_MS)
  }
  console.log(`  [FAIL] ${desc}（超时）`)
  failed++
  return false
}

function killTree(pid) {
  if (!pid) return false
  const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  return r.status === 0
}

function listAgentDeckProcs() {
  const exeName = path.basename(EXE)
  const r = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='${exeName}'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`],
    { encoding: 'utf8', windowsHide: true }
  )
  if (r.status !== 0 || !r.stdout || !r.stdout.trim()) return []
  let obj
  try {
    obj = JSON.parse(r.stdout)
  } catch {
    return []
  }
  const arr = Array.isArray(obj) ? obj : [obj]
  return arr.filter((p) => p && p.ProcessId).map((p) => ({ pid: p.ProcessId, cmdline: String(p.CommandLine || '') }))
}

function spawnApp(appDataDir, trustHex, extraEnv) {
  const env = { ...process.env }
  delete env.ELECTRON_RENDERER_URL
  delete env.ELECTRON_RUN_AS_NODE
  delete env.AGENTDECK_DISABLE_HOT
  env.APPDATA = appDataDir
  env.LOCALAPPDATA = appDataDir
  env.USERPROFILE = appDataDir
  env.HOME = appDataDir
  env.AGENTDECK_HOT_TRUST_HEX = trustHex
  env.AGENTDECK_USER_DATA_DIR = path.join(appDataDir, 'agentdeck')
  Object.assign(env, extraEnv || {})
  const child = spawn(EXE, [], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false })
  child.exited = false
  child.on('exit', (code) => {
    child.exited = true
    child.exitCodeSaved = code
  })
  child.stdout.pipe(fs.createWriteStream(path.join(appDataDir, 'app-stdout.log')))
  child.stderr.pipe(fs.createWriteStream(path.join(appDataDir, 'app-stderr.log')))
  spawnedPids.add(child.pid)
  return child
}

const isAlive = (child) => !child.exited && child.exitCode === null

// ---------- 前置 ----------
function preflight() {
  if (process.platform !== 'win32') fatal(`本 smoke 只支持 Windows；当前平台: ${process.platform}`)
  if (!fs.existsSync(EXE)) {
    fatal(`${EXE} 不存在 — 先产出打包物（npm run pack，或 electron-builder --dir --config.directories.output=<目录> 后设 SMOKE_HOT_EXE）`)
  }
  if (!fs.existsSync(path.join(root, 'out', 'main', 'index.js'))) {
    fatal('out/main/index.js 缺失 — 先 npm run build（自相似载荷来源）')
  }
}

// ---------- 载荷与 manifest ----------
const pkgVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const VERSION = `${pkgVersion}-hot.1`
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')

function buildPayload(appDataDir, { keyId, privKey, canonicalJson }) {
  const userData = path.join(appDataDir, 'agentdeck')
  const versionDir = path.join(userData, 'hot-app', VERSION)
  fs.mkdirSync(versionDir, { recursive: true })
  fs.cpSync(path.join(root, 'out'), path.join(versionDir, 'out'), { recursive: true })
  fs.copyFileSync(path.join(root, 'package.json'), path.join(versionDir, 'package.json'))
  fs.mkdirSync(path.join(versionDir, 'build'), { recursive: true })
  fs.copyFileSync(path.join(root, 'build', 'icon.png'), path.join(versionDir, 'build', 'icon.png'))
  // 载荷生效标记：只有载荷 main 被 require 才写出
  const indexJs = path.join(versionDir, 'out', 'main', 'index.js')
  const code = fs.readFileSync(indexJs, 'utf8')
  fs.writeFileSync(indexJs, `;try{if(process.env.AGENTDECK_SMOKE_MARKER){require('fs').writeFileSync(process.env.AGENTDECK_SMOKE_MARKER,'payload-active\\n')}}catch(e){}\n${code}`)
  // manifest：files 覆盖载荷目录全部文件（排除 manifest 自身）
  const files = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile() && e.name !== 'manifest.json') {
        const buf = fs.readFileSync(p)
        files.push({ path: path.relative(versionDir, p).split(path.sep).join('/'), sha256: sha256(buf), size: buf.length })
      }
    }
  }
  walk(versionDir)
  files.sort((a, b) => (a.path < b.path ? -1 : 1))
  const payload = {
    schemaVersion: 1, channel: 'payload', version: VERSION,
    minMainVersion: '0.0.0', minShellVersion: '0.0.0',
    releaseDate: new Date().toISOString(), keyId,
    artifact: { name: `payload-${VERSION}.zip`, sha256: '0'.repeat(64), size: 0 }, // 本演练不走下载链路，占位
    files
  }
  const manifestJson = JSON.stringify({ payload, signature: crypto.sign(null, Buffer.from(canonicalJson(payload), 'utf8'), privKey).toString('base64') }, null, 2)
  fs.writeFileSync(path.join(versionDir, 'manifest.json'), manifestJson)
  const pointer = { schemaVersion: 1, channel: 'payload', version: VERSION, dir: `hot-app/${VERSION}`, manifestSha256: sha256(Buffer.from(manifestJson)), appliedAt: Date.now(), appliedByShell: pkgVersion }
  const pointerFile = path.join(userData, 'hot-app', 'current.json')
  const tmp = `${pointerFile}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(pointer, null, 2))
  fs.renameSync(tmp, pointerFile)
  return { userData, versionDir }
}

const evidence = (userData, prefix) => {
  try {
    return fs.readdirSync(path.join(userData, 'hot-app')).filter((n) => n.startsWith(prefix))
  } catch {
    return []
  }
}

// ---------- main ----------
async function main() {
  preflight()
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const pubHex = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex')
  const keyId = `ad-payload-${Date.now().toString(36)}`
  const trustHex = `${keyId}:${pubHex}`

  const outfile = path.join(root, 'out', 'smoke-hot-payload-canonical.cjs')
  await build({ entryPoints: [path.join(root, 'src/main/hot/canonical.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18', logLevel: 'silent' })
  const { canonicalJson } = await import(pathToFileURL(outfile).href)

  // —— A 载荷启动 + sidecar 自载荷目录
  const appDataA = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-hot-payload-'))
  tmpDirs.push(appDataA)
  const { userData } = buildPayload(appDataA, { keyId, privKey: privateKey, canonicalJson })
  const marker = path.join(appDataA, 'payload-marker.txt')
  const childA = spawnApp(appDataA, trustHex, { AGENTDECK_SMOKE_MARKER: marker })
  const deadlineA = Date.now() + SCENARIO_TIMEOUT_MS
  console.log('\n[scenario] A 载荷启动 + sidecar 自载荷目录拉起')
  await waitFor('A 载荷生效标记写出（载荷 main 已加载）', () => fs.existsSync(marker), deadlineA)
  await waitFor('A sidecar 子进程命令行含载荷目录（sidecar-server.js 随载荷 __dirname 拉起）', () => {
    return listAgentDeckProcs().some((p) => p.cmdline.includes('sidecar-server.js') && p.cmdline.includes('hot-app'))
  }, deadlineA)
  await sleep(2000)
  ok(isAlive(childA), 'A 进程稳定存活')

  // —— B second boot 对账
  console.log('\n[scenario] B second boot（杀进程重启 → 对账正常）')
  killTree(childA.pid)
  await sleep(1000)
  fs.rmSync(marker, { force: true })
  const childB = spawnApp(appDataA, trustHex, { AGENTDECK_SMOKE_MARKER: marker })
  const deadlineB = Date.now() + SCENARIO_TIMEOUT_MS
  await waitFor('B 重启后载荷标记再次写出（second boot 载荷链稳定）', () => fs.existsSync(marker), deadlineB)
  await sleep(2000)
  ok(isAlive(childB), 'B 进程稳定存活')
  ok(evidence(userData, 'current.json.crash-').length === 0, 'B 无 crash 留证（载荷未抛错）')
  killTree(childB.pid)
  await sleep(500)

  // —— C 指针移除 → 内置版
  console.log('\n[scenario] C 指针移除（rollback 语义）→ 重启走内置版')
  fs.rmSync(marker, { force: true })
  const pointerFile = path.join(userData, 'hot-app', 'current.json')
  fs.renameSync(pointerFile, `${pointerFile}.rollback-${Date.now()}`)
  const childC = spawnApp(appDataA, trustHex, { AGENTDECK_SMOKE_MARKER: marker })
  const deadlineC = Date.now() + SCENARIO_TIMEOUT_MS
  await sleep(5000)
  ok(isAlive(childC), 'C 内置版进程存活')
  ok(!fs.existsSync(marker), 'C 载荷未加载（无标记 = 主进程已回内置）')
  ok(evidence(userData, 'current.json.crash-').length === 0, 'C 无 crash 留证（正常回退非崩溃路径）')
  if (isAlive(childC)) killTree(childC.pid)

  for (const pid of spawnedPids) killTree(pid)
  await sleep(500)
  if (failed > 0) {
    console.error(`\n[FAIL] SMOKE HOT PAYLOAD FAILED（${failed} 项）。现场保留:`)
    for (const d of tmpDirs) console.error(`  ${d}`)
    process.exit(1)
  }
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
  console.log('\n[ok] SMOKE HOT PAYLOAD: A/B/C 全绿（载荷启动/sidecar 随载荷/second boot/回退）')
}

main().catch((e) => {
  console.error(`[FATAL] ${e && e.stack ? e.stack : e}`)
  process.exit(1)
})
