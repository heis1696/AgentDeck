#!/usr/bin/env node
/**
 * scripts/smoke-hot-pointer.mjs — 打包态热更指针四态演练（docs/HOT-UPDATE-IMPL-DESIGN.md §6.2 / §3.3）
 *
 * 前置：npm run pack 产出 release/win-unpacked/AgentDeck.exe；已存在且 env SMOKE_HOT_SKIP_PACK=1 时跳过 pack。
 * 安全铁则：启动 exe 时 env 重定向 APPDATA/LOCALAPPDATA 到临时目录（防污染真实用户数据 + 单实例锁隔离），
 *           并注入 AGENTDECK_HOT_TRUST_HEX（每次运行临时生成 ed25519 密钥对，<keyId>:<pubHex>）。
 *
 * 四场景（对应 §3.3 三失败路径 + 正常路径；GUI 窗口短暂出现属预期）：
 *   ① 正常载荷指针：临时密钥签名 manifest；载荷目录 = 复制仓库 out/ 三目录 + package.json + build/icon.png 的自相似载荷（§6.1）。
 *      断言：载荷生效标记写出（AGENTDECK_SMOKE_MARKER，由注入载荷 index.js 头部的片段写出）+ 进程存活 + 无 crash 留证。
 *   ② 指针 JSON 损坏 → current.json.corrupt-<ts> 留证 + 进程存活（内置回退）+ 载荷未加载（无标记）。
 *   ③ 验签失败（错密钥签名）→ current.json.rejected-<ts> + <version>.quarantine-<ts> 留证 + 原版本目录消失 + 进程存活 + 载荷未加载。
 *   ④ 载荷 require 抛错（截断载荷 index.js，尾部追加 throw 兜底保证抛错）→ current.json.crash-<ts> 留证
 *      + 原进程退出 + 带 --agentdeck-hot-fallback 的新实例存活（§3.3 路径③：relaunch 干净重启）。
 *
 * 轮询断言：每 500ms，单场景总预算 ≤30s；结束统一杀进程（taskkill /T /F）。
 * 任何前置缺失（非 Windows / exe 缺失 / asar 内无 bootstrap / asar main 未指向 bootstrap / out 产物缺失 /
 * src/main/hot/canonical.ts 缺失）都给出明确诊断退出，绝不静默跳过。
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

/** 稳健的 npm 调用：node+npm-cli.js → npm.cmd/npm → shell 兜底（规避受限环境下 spawn .cmd 的 EINVAL） */
function runNpm(args) {
  const trySpawn = (cmd, spawnArgs, shell) =>
    spawnSync(cmd, spawnArgs, { cwd: root, stdio: 'inherit', shell })
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (fs.existsSync(cli)) {
    const r = trySpawn(process.execPath, [cli, ...args], false)
    if (r.status !== null) return r.status
  }
  let r = trySpawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, false)
  if (r.status !== null) return r.status
  r = trySpawn('npm', args, true)
  if (r.status !== null) return r.status
  return null
}

// ---------- 前置检查（全部给出明确诊断，不静默跳过） ----------
/** userData 目录名 = 打包态 package.json 的 name（Electron app.getPath('userData') 依据；productName 只影响 exe/安装器） */
function readUserDataDirName() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    if (pkg?.name) return pkg.name
  } catch {}
  return 'agentdeck'
}

/** 最小 asar 头解析（8 字节尺寸头 + JSON 文件树）→ { files, dataOffset }；解析失败返回 null */
function parseAsarHeader(buf) {
  try {
    if (buf.length < 8) return null
    const pickleSize = buf.readUInt32LE(0)
    const jsonLen = buf.readUInt32LE(4)
    if (8 + jsonLen > buf.length) return null
    const header = JSON.parse(buf.slice(8, 8 + jsonLen).toString('utf8'))
    return { files: header.files || {}, dataOffset: 8 + pickleSize }
  } catch {
    return null
  }
}

function readAsarFile(asarPath, relPath) {
  const buf = fs.readFileSync(asarPath)
  const parsed = parseAsarHeader(buf)
  if (!parsed) return null
  const segs = relPath.split('/')
  let node = parsed.files
  for (const s of segs) {
    node = node && node[s]
    if (!node) return null
  }
  if (typeof node.size !== 'string' || typeof node.offset !== 'string') return null
  const off = parsed.dataOffset + Number(node.offset)
  const size = Number(node.size)
  if (off + size > buf.length) return null
  return buf.slice(off, off + size)
}

function preflight() {
  if (process.platform !== 'win32') {
    fatal(`本 smoke 只支持 Windows（打包态 exe 演练）；当前平台: ${process.platform}`)
  }
  if (!fs.existsSync(EXE)) {
    if (process.env.SMOKE_HOT_SKIP_PACK === '1' || process.env.SMOKE_HOT_EXE) {
      fatal(`${EXE} 不存在 — 无法演练。请先产出该目录的打包物（例如 electron-builder --dir --config.directories.output=<该目录>），或去掉 SMOKE_HOT_EXE 让本脚本走默认 release/win-unpacked 并自行打包`)
    }
    console.log('[step] 未找到打包产物，执行 npm run pack（electron-vite build + electron-builder --dir）…')
    const status = runNpm(['run', 'pack'])
    if (status !== 0) fatal(`npm run pack 失败（退出码 ${status}）— 见上方输出；无 exe 无法演练`)
  } else {
    console.log(`[ok] 打包产物存在: ${path.relative(root, EXE)}`)
  }
  const asarPath = path.join(path.dirname(EXE), 'resources', 'app.asar')
  if (!fs.existsSync(asarPath)) {
    fatal(`${path.relative(root, asarPath)} 不存在 — 打包结构异常（非 electron-builder --dir 产物？）`)
  }
  const asarBuf = fs.readFileSync(asarPath)
  if (!asarBuf.includes(Buffer.from('bootstrap.js'))) {
    fatal(`asar 内未找到 bootstrap.js — 打包物不含热更引导（阶段 0.4/0.5 未落地）。指针四态逻辑不会生效，无法演练。请先实现 src/main/bootstrap.ts（§3.2）+ electron.vite.config.ts main.input 增 bootstrap 条目后重新 npm run pack。`)
  }
  const pkgJson = readAsarFile(asarPath, 'package.json')
  if (pkgJson !== null) {
    try {
      const pkg = JSON.parse(pkgJson.toString('utf8'))
      if (pkg.main && !String(pkg.main).includes('bootstrap')) {
        fatal(`asar 内 package.json main=${JSON.stringify(pkg.main)} 未指向 bootstrap — 阶段 0.4 未落地，Electron 不会走指针加载链，四场景无法演练。请改 package.json main 为 ./out/main/bootstrap.js 后重新 pack。`)
      }
      console.log(`[ok] asar 含 bootstrap（main=${pkg.main}）`)
    } catch {
      console.warn('[warn] 无法解析 asar 内 package.json，跳过 main 字段检查（按 bootstrap.js 存在继续）')
    }
  } else {
    console.warn('[warn] 无法结构化解析 asar 头，跳过 main 字段检查（按 bootstrap.js 存在继续）')
  }
  if (!fs.existsSync(path.join(root, 'out', 'main', 'index.js'))) {
    console.log('[step] out/ 缺失，执行 npm run build 生成自相似载荷来源 …')
    const status = runNpm(['run', 'build'])
    if (status !== 0) fatal(`npm run build 失败（退出码 ${status}）— 无载荷来源`)
  }
  if (!fs.existsSync(path.join(root, 'src', 'main', 'hot', 'canonical.ts'))) {
    fatal('src/main/hot/canonical.ts 不存在 — 本 smoke 需用与运行时同一实现的 canonicalJson 签 manifest（§2.3/阶段 0.3）。hot 模块族未落地前无法演练，请对齐 §5.1 契约后重跑。')
  }
  const productName = readUserDataDirName()
  console.log(`[ok] userData 目录名 = ${productName}（package.json name，app.getPath('userData') 依据；APPDATA 将重定向到临时目录）`)
  return { productName }
}

// ---------- 通用工具 ----------
function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

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
  console.log(`  [FAIL] ${desc}（${SCENARIO_TIMEOUT_MS / 1000}s 超时）`)
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
  // 连带隔离 home：应用启动期 ensureSharedDir 会写 ~/.agentdeck（app.getPath('home') ← USERPROFILE），一并圈进临时目录
  env.USERPROFILE = appDataDir
  env.HOME = appDataDir
  env.AGENTDECK_HOT_TRUST_HEX = trustHex
  // Windows 上 Electron 经系统 API 解析 appData，env APPDATA 重定向无效：
  // 靠 bootstrap 的显式 userData 覆盖真正隔离（单实例锁也随之按 userData 隔离）
  env.AGENTDECK_USER_DATA_DIR = path.join(appDataDir, 'agentdeck')
  Object.assign(env, extraEnv || {})
  const child = spawn(EXE, [], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false })
  child.exited = false
  child.exitCodeSaved = null
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

function mkAppData() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-hot-smoke-'))
  tmpDirs.push(d)
  return d
}

function hotAppDir(appDataDir, productName) {
  return path.join(appDataDir, productName, 'hot-app')
}

function evidenceNames(appDataDir, productName, prefix) {
  const dir = hotAppDir(appDataDir, productName)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((n) => n.startsWith(prefix))
}

function tailOf(file, lines = 30) {
  try {
    const txt = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    return txt.slice(-lines).join('\n')
  } catch {
    return '(无日志)'
  }
}

// ---------- 载荷副本（自相似：仓库 out/ 三目录 + package.json + build/icon.png，§6.1） ----------
const pkgVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const VERSION = `${pkgVersion}-hot.1`

/** 注入载荷生效标记片段：只有载荷 main 进程被 require 时才写标记（内置回退不会触发） */
function injectMarker(indexJs) {
  const code = fs.readFileSync(indexJs, 'utf8')
  const isEsm = /^\s*(import\s|export\s)/m.test(code.slice(0, 4000))
  const snippet = isEsm
    ? "import { writeFileSync as __smokeWrite } from 'node:fs';\n;try{if(process.env.AGENTDECK_SMOKE_MARKER){__smokeWrite(process.env.AGENTDECK_SMOKE_MARKER,'payload-active\\n')}}catch(e){}\n"
    : ";try{if(process.env.AGENTDECK_SMOKE_MARKER){require('fs').writeFileSync(process.env.AGENTDECK_SMOKE_MARKER,'payload-active\\n')}}catch(e){}\n"
  fs.writeFileSync(indexJs, snippet + code)
}

/** 截断载荷 index.js 制造 require 抛错；尾部追加 throw 兜底（即使截断点恰好合法也必然抛错） */
function truncateIndex(indexJs, ratio = 0.4) {
  const buf = fs.readFileSync(indexJs)
  const cut = Math.max(128, Math.floor(buf.length * ratio))
  const out = Buffer.concat([buf.subarray(0, cut), Buffer.from("\nthrow new Error('smoke-hot-pointer: truncated payload index.js')\n")])
  fs.writeFileSync(indexJs, out)
}

function buildPayloadDir(appDataDir, productName, opts = {}) {
  const versionDir = path.join(hotAppDir(appDataDir, productName), VERSION)
  fs.mkdirSync(versionDir, { recursive: true })
  fs.cpSync(path.join(root, 'out'), path.join(versionDir, 'out'), { recursive: true })
  fs.copyFileSync(path.join(root, 'package.json'), path.join(versionDir, 'package.json'))
  fs.mkdirSync(path.join(versionDir, 'build'), { recursive: true })
  fs.copyFileSync(path.join(root, 'build', 'icon.png'), path.join(versionDir, 'build', 'icon.png'))
  injectMarker(path.join(versionDir, 'out', 'main', 'index.js'))
  if (opts.truncateIndex) truncateIndex(path.join(versionDir, 'out', 'main', 'index.js'))
  return versionDir
}

function fileMetaList(versionDir) {
  const out = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile() && e.name !== 'manifest.json') {
        const buf = fs.readFileSync(p)
        out.push({ path: path.relative(versionDir, p).split(path.sep).join('/'), sha256: sha256Hex(buf), size: buf.length })
      }
    }
  }
  walk(versionDir)
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return out
}

// ---------- manifest 组装与签名（§2.3，与运行时同一 canonicalJson） ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
/** store-only zip（本 smoke 只为 manifest.artifact 提供真实字节，不被任何解包方消费） */
function zipStore(entries) {
  const chunks = []
  const central = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.path, 'utf8')
    const data = Buffer.from(e.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(crc32(data), 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    chunks.push(local, name, data)
    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(0, 8)
    cen.writeUInt32LE(crc32(data), 16)
    cen.writeUInt32LE(data.length, 20)
    cen.writeUInt32LE(data.length, 24)
    cen.writeUInt16LE(name.length, 28)
    cen.writeUInt32LE(offset, 42)
    central.push(cen, name)
    offset += 30 + name.length + data.length
  }
  const cenBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cenBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, cenBuf, eocd])
}

function buildManifest({ versionDir, filesMeta, keyId, privKey, canonicalJson }) {
  const artifactName = `payload-${VERSION}.zip`
  const zipBuf = zipStore(filesMeta.map((f) => ({ path: f.path, data: fs.readFileSync(path.join(versionDir, f.path)) })))
  const payload = {
    schemaVersion: 1,
    channel: 'payload',
    version: VERSION,
    // min* 门禁取 '0.0.0'：本 smoke 只演练指针/验签/加载链，不演练门禁（exe 打包版本与仓库版本可能不同步，'0.0.0' 恒通过）
    minMainVersion: '0.0.0',
    minShellVersion: '0.0.0',
    releaseDate: new Date().toISOString(),
    keyId,
    artifact: { name: artifactName, sha256: sha256Hex(zipBuf), size: zipBuf.length },
    files: filesMeta
  }
  const canonical = canonicalJson(payload)
  const signature = crypto.sign(null, Buffer.from(canonical, 'utf8'), privKey).toString('base64')
  const manifestJson = JSON.stringify({ payload, signature }, null, 2)
  fs.writeFileSync(path.join(versionDir, 'manifest.json'), manifestJson)
  return { manifestSha256: sha256Hex(Buffer.from(manifestJson)) }
}

/** 指针原子写（tmp + rename，§2.2） */
function writePointer(appDataDir, productName, content) {
  const dir = hotAppDir(appDataDir, productName)
  fs.mkdirSync(dir, { recursive: true })
  const dst = path.join(dir, 'current.json')
  const tmp = `${dst}.tmp`
  fs.writeFileSync(tmp, typeof content === 'string' ? content : JSON.stringify(content, null, 2))
  fs.renameSync(tmp, dst)
}

// ---------- 四场景 ----------
function scenarioSetup(appDataDir, productName, opts = {}) {
  const versionDir = buildPayloadDir(appDataDir, productName, { truncateIndex: opts.truncateIndex })
  const filesMeta = fileMetaList(versionDir)
  const manifest = buildManifest({
    versionDir,
    filesMeta,
    keyId: opts.keyId,
    privKey: opts.privKey,
    canonicalJson: opts.canonicalJson
  })
  if (opts.pointerJson !== undefined) {
    writePointer(appDataDir, productName, opts.pointerJson)
  } else {
    writePointer(appDataDir, productName, {
      schemaVersion: 1,
      channel: 'payload',
      version: VERSION,
      dir: `hot-app/${VERSION}`,
      manifestSha256: manifest.manifestSha256,
      appliedAt: Date.now(),
      appliedByShell: pkgVersion
    })
  }
  return { versionDir, marker: path.join(appDataDir, 'payload-marker.txt') }
}

async function scenarioNormal(ctx) {
  const appData = mkAppData()
  const { marker } = scenarioSetup(appData, ctx.productName, { keyId: ctx.keyId, privKey: ctx.privKey, canonicalJson: ctx.canonicalJson })
  const deadline = Date.now() + SCENARIO_TIMEOUT_MS
  const child = spawnApp(appData, ctx.trustHex, { AGENTDECK_SMOKE_MARKER: marker })
  await waitFor('① 载荷生效标记写出（载荷 main 已加载）', () => fs.existsSync(marker), deadline)
  await sleep(2000)
  ok(isAlive(child), '① 进程存活（载荷生效且未回退退出）')
  ok(evidenceNames(appData, ctx.productName, 'current.json.crash-').length === 0, '① 无 crash 留证（载荷未抛错重启）')
  if (!fs.existsSync(marker) || !isAlive(child)) {
    console.error(`  [诊断] ① 进程${isAlive(child) ? '存活' : `已退出(码 ${child.exitCodeSaved})`}，标记${fs.existsSync(marker) ? '已写' : '未写'}；hot-app 目录: ${(() => { try { return fs.readdirSync(hotAppDir(appData, ctx.productName)).join(', ') || '(空)' } catch { return '(不存在)' } })()}\n  stderr 尾部:\n${tailOf(path.join(appData, 'app-stderr.log'))}`)
  }
  killTree(child.pid)
  await sleep(500)
  return { appData, child }
}

async function scenarioCorrupt(ctx) {
  const appData = mkAppData()
  const { marker } = scenarioSetup(appData, ctx.productName, { keyId: ctx.keyId, privKey: ctx.privKey, canonicalJson: ctx.canonicalJson, pointerJson: '{"schemaVersion":1,' })
  const deadline = Date.now() + SCENARIO_TIMEOUT_MS
  const child = spawnApp(appData, ctx.trustHex, { AGENTDECK_SMOKE_MARKER: marker })
  await waitFor('② current.json.corrupt-* 留证存在', () => evidenceNames(appData, ctx.productName, 'current.json.corrupt-').length > 0, deadline)
  await sleep(2000)
  ok(isAlive(child), '② 进程存活（内置回退）')
  ok(!fs.existsSync(marker), '② 载荷未加载（无标记 — 走的回退而非载荷）')
  if (evidenceNames(appData, ctx.productName, 'current.json.corrupt-').length === 0) {
    console.error(`  [诊断] ② 未见 corrupt 留证。hot-app 目录内容: ${(() => { try { return fs.readdirSync(hotAppDir(appData, ctx.productName)).join(', ') || '(空)' } catch { return '(不存在)' } })()}\n  stderr 尾部:\n${tailOf(path.join(appData, 'app-stderr.log'))}`)
  }
  killTree(child.pid)
  await sleep(500)
  return { appData, child }
}

async function scenarioRejected(ctx) {
  const appData = mkAppData()
  const { marker, versionDir } = scenarioSetup(appData, ctx.productName, { keyId: ctx.keyId, privKey: ctx.wrongPrivKey, canonicalJson: ctx.canonicalJson })
  const deadline = Date.now() + SCENARIO_TIMEOUT_MS
  const child = spawnApp(appData, ctx.trustHex, { AGENTDECK_SMOKE_MARKER: marker })
  await waitFor('③ current.json.rejected-* 留证存在', () => evidenceNames(appData, ctx.productName, 'current.json.rejected-').length > 0, deadline)
  await sleep(2000)
  ok(isAlive(child), '③ 进程存活（内置回退）')
  const qd = () => evidenceNames(appData, ctx.productName, `${VERSION}.quarantine-`).filter((n) => {
    try { return fs.statSync(path.join(hotAppDir(appData, ctx.productName), n)).isDirectory() } catch { return false }
  })
  ok(qd().length > 0, '③ <version>.quarantine-* 版本目录留证存在（坏载荷隔离）')
  ok(!fs.existsSync(versionDir), '③ 原版本目录已改名隔离')
  ok(!fs.existsSync(marker), '③ 载荷未加载（无标记 — 验签失败走回退）')
  if (evidenceNames(appData, ctx.productName, 'current.json.rejected-').length === 0) {
    console.error(`  [诊断] ③ 未见 rejected 留证（若为"未知 keyId"类拒绝，检查 src/main/hot/trust.ts 是否支持 AGENTDECK_HOT_TRUST_HEX 注入 — 本 smoke 依赖该机制；若为 minShellVersion 拒绝，检查 exe 打包版本与 manifest）\n  stderr 尾部:\n${tailOf(path.join(appData, 'app-stderr.log'))}`)
  }
  killTree(child.pid)
  await sleep(500)
  return { appData, child }
}

async function scenarioCrash(ctx) {
  const appData = mkAppData()
  scenarioSetup(appData, ctx.productName, { truncateIndex: true, keyId: ctx.keyId, privKey: ctx.privKey, canonicalJson: ctx.canonicalJson })
  const deadline = Date.now() + SCENARIO_TIMEOUT_MS
  const child = spawnApp(appData, ctx.trustHex, {})
  await waitFor('④ 原进程退出（relaunch 干净重启）', () => child.exited, deadline)
  ok(evidenceNames(appData, ctx.productName, 'current.json.crash-').length > 0, '④ current.json.crash-* 留证存在')
  let foundFbPid = null
  const findFallback = () => {
    const p = listAgentDeckProcs().find((x) => x.cmdline.includes('--agentdeck-hot-fallback'))
    if (p) foundFbPid = p.pid
    return p ? p.pid : null
  }
  await waitFor('④ 带 --agentdeck-hot-fallback 的新实例存活', () => findFallback() !== null, deadline)
  if (child.exited && !foundFbPid) {
    console.error(`  [诊断] ④ 原进程已退出但未见 fallback 实例（bootstrap 应 app.relaunch({args:['--agentdeck-hot-fallback']}) + app.exit(1)，§3.3 路径③）\n  stderr 尾部:\n${tailOf(path.join(appData, 'app-stderr.log'))}`)
  }
  if (!child.exited) {
    console.error(`  [诊断] ④ 原进程未退出（截断载荷未触发 require 抛错？检查截断点与 bootstrap try/catch，§3.2 步骤 2）\n  stderr 尾部:\n${tailOf(path.join(appData, 'app-stderr.log'))}`)
  }
  if (foundFbPid) killTree(foundFbPid)
  if (!child.exited) killTree(child.pid)
  await sleep(500)
  return { appData, child }
}

// ---------- main ----------
async function main() {
  const { productName } = preflight()

  // 临时密钥对（每次运行新生成；错密钥场景用第二把）
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const pubHex = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex')
  const wrongPrivKey = crypto.generateKeyPairSync('ed25519').privateKey
  const keyId = `ad-smoke-${Date.now().toString(36)}`
  const trustHex = `${keyId}:${pubHex}`
  console.log(`[ok] 临时密钥 keyId=${keyId} 公钥 ${pubHex.slice(0, 16)}…（经 AGENTDECK_HOT_TRUST_HEX 注入）`)

  const outfile = path.join(root, 'out', 'smoke-hot-canonical.cjs')
  await build({
    entryPoints: [path.join(root, 'src/main/hot/canonical.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['electron'],
    logLevel: 'silent'
  })
  const canonicalMod = await import(pathToFileURL(outfile).href)
  if (typeof canonicalMod.canonicalJson !== 'function') {
    fatal('src/main/hot/canonical.ts 缺导出 canonicalJson（§5.1）— 契约不符，无法签名')
  }
  const ctx = { productName, keyId, pubHex, privKey: privateKey, wrongPrivKey, trustHex, canonicalJson: canonicalMod.canonicalJson }

  const scenarios = [
    { name: '① 正常载荷指针', run: scenarioNormal },
    { name: '② 指针 JSON 损坏', run: scenarioCorrupt },
    { name: '③ 验签失败（错密钥）', run: scenarioRejected },
    { name: '④ 载荷 require 抛错', run: scenarioCrash }
  ]
  for (const s of scenarios) {
    console.log(`\n[scenario] ${s.name}`)
    try {
      await s.run(ctx)
    } catch (e) {
      console.error(`  [FAIL] ${s.name} 抛错: ${e && e.stack ? e.stack : e}`)
      failed++
    }
  }

  // 结束统一杀进程（含 ④ 遗留 fallback 实例兜底清扫）
  for (const pid of spawnedPids) killTree(pid)
  for (const p of listAgentDeckProcs()) {
    if (p.cmdline.includes('--agentdeck-hot-fallback')) killTree(p.pid)
  }
  await sleep(500)

  if (failed > 0) {
    console.error(`\n[FAIL] SMOKE HOT POINTER FAILED (${failed} 项断言失败)。现场（APPDATA 临时目录/日志）保留于:`)
    for (const d of tmpDirs) console.error(`  ${d}`)
    process.exit(1)
  }
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
  console.log('\n[ok] SMOKE HOT POINTER: 4/4 场景全绿（§3.3 三失败路径 + 正常路径）')
}

main().catch((e) => {
  console.error(`[FATAL] ${e && e.stack ? e.stack : e}`)
  process.exit(1)
})
