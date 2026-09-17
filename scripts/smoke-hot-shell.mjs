#!/usr/bin/env node
/**
 * scripts/smoke-hot-shell.mjs — L0 壳自替换真机演练（docs/INSTALLER-FREE-HOT-UPDATE.md §5）
 *
 * 流程：把打包产物**复制**到临时目录（绝不触碰 release/win-unpacked*）→ 本地 http feed 提供
 * "新壳 zip"（= 复制版自身 + 根部注入 MARKER-SHELL-NEW.txt 变体）→ 以
 * AGENTDECK_HOT_AUTO_APPLY_SHELL=1 启动复制版（check → 自动两段 apply：staging → 确认执行
 * rename dance）→ 断言：原进程退出+重启存活、原路径已是新壳（MARKER 存在）、.old-<ts> 留证、
 * L1 指针被清（§6 全量>增量）、启动清扫后 staging 残留消失。
 *
 * 隔离：AGENTDECK_USER_DATA_DIR（Windows env APPDATA 对 Electron 无效）+ APPDATA/USERPROFILE
 * 临时目录 + AGENTDECK_HOT_TRUST_HEX 临时密钥。SMOKE_HOT_EXE 指定打包产物目录（默认
 * release/win-unpacked，被占用时用 release/win-unpacked-hot/win-unpacked）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'

const root = path.resolve(import.meta.dirname, '..')
const MARKER = 'MARKER-SHELL-NEW.txt'
const SCENARIO_TIMEOUT_MS = 120000
const POLL_INTERVAL_MS = 1000

let failed = 0
const ok = (cond, msg) => { console.log(`  ${cond ? '[ok]' : '[FAIL]'} ${msg}`); if (!cond) failed++ }
const fatal = (msg) => { console.error(`[FATAL] ${msg}`); process.exit(1) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(desc, fn, deadline) {
  while (Date.now() < deadline) {
    let v = false
    try { v = await fn() } catch { v = false }
    if (v) { console.log(`  [ok] ${desc}`); return true }
    await sleep(POLL_INTERVAL_MS)
  }
  console.log(`  [FAIL] ${desc}（超时）`); failed++
  return false
}

const pkgVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')

if (process.platform !== 'win32') fatal('本 smoke 只支持 Windows')
const srcExe = process.env.SMOKE_HOT_EXE
  ? path.resolve(process.env.SMOKE_HOT_EXE)
  : path.join(root, 'release', 'win-unpacked', 'AgentDeck.exe')
if (!fs.existsSync(srcExe)) fatal(`${srcExe} 不存在 — 先 npm run pack（或 electron-builder --dir 到旁路目录后设 SMOKE_HOT_EXE）`)

// —— 密钥与 canonical（与运行时同一实现） ——
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
const pubHex = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex')
const keyId = `ad-shell-${Date.now().toString(36)}`
process.env.AGENTDECK_HOT_TRUST_HEX = `${keyId}:${pubHex}`
const canonicalOut = path.join(root, 'out', 'smoke-hot-shell-canonical.cjs')
await build({ entryPoints: [path.join(root, 'src/main/hot/canonical.ts')], outfile: canonicalOut, bundle: true, platform: 'node', format: 'cjs', target: 'node18', logLevel: 'silent' })
const { canonicalJson } = await import(pathToFileURL(canonicalOut).href)
const zipOut = path.join(root, 'out', 'smoke-hot-shell-zip.cjs')
await build({ entryPoints: [path.join(root, 'src/main/hot/zip.ts')], outfile: zipOut, bundle: true, platform: 'node', format: 'cjs', target: 'node18', logLevel: 'silent' })
const { createZipStore } = await import(pathToFileURL(zipOut).href)

// —— 复制应用目录到临时区（同卷：临时区也在 D 盘时 rename 才原子；直接放 repo 同盘） ——
const tmpBase = fs.mkdtempSync(path.join(root, '.smoke-hot-shell-'))
const appDir = path.join(tmpBase, 'app')
console.log(`[step] 复制打包产物 → ${appDir}（较大，稍候）`)
fs.cpSync(path.dirname(srcExe), appDir, { recursive: true })

// —— 组新壳 zip（= 复制内容 + MARKER 注入；version 抬高保证不等于当前） ——
const SHELL_VERSION = `${pkgVersion}-hot.1`
const entries = []
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (e.isFile()) entries.push({ path: path.relative(appDir, p).split(path.sep).join('/'), data: fs.readFileSync(p) })
  }
}
walk(appDir)
entries.push({ path: MARKER, data: Buffer.from('new-shell\n') })
entries.sort((a, b) => (a.path < b.path ? -1 : 1))
const zipBuf = Buffer.from(createZipStore(entries))
const files = entries.map((e) => ({ path: e.path, sha256: sha256(e.data), size: e.data.length }))
const payload = {
  schemaVersion: 1, channel: 'shell', version: SHELL_VERSION,
  minMainVersion: '0.0.0', minShellVersion: '0.0.0',
  releaseDate: new Date().toISOString(), keyId,
  artifact: { name: `shell-${SHELL_VERSION}.zip`, sha256: sha256(zipBuf), size: zipBuf.length },
  files
}
const manifestJson = JSON.stringify({ payload, signature: crypto.sign(null, Buffer.from(canonicalJson(payload), 'utf8'), privateKey).toString('base64') })

const feedDir = path.join(tmpBase, 'feed', 'shell')
fs.mkdirSync(feedDir, { recursive: true })
fs.writeFileSync(path.join(feedDir, 'manifest.json'), manifestJson)
fs.writeFileSync(path.join(feedDir, `shell-${SHELL_VERSION}.zip`), zipBuf)
// feed 服务器跑在独立子进程（feeder）：本运行环境的跨进程入站对"直接宿主进程"不可达，
// 孙进程互连正常（实测矩阵 A/B/C）。feeder 脚本落盘成真实文件（避免 -e 多层转义）。
const feederFile = path.join(tmpBase, 'feeder.cjs')
fs.writeFileSync(feederFile, `const http = require('node:http'), fs = require('node:fs'), path = require('node:path')
const root = process.argv[2]
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\\/+/, '')
  const file = path.normalize(path.join(root, rel))
  if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return }
  const buf = fs.readFileSync(file)
  res.writeHead(200, { 'content-length': buf.length })
  res.end(buf)
})
server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port)))
`)
const feeder = spawn(process.execPath, [feederFile, path.join(tmpBase, 'feed')], { stdio: ['ignore', 'pipe', 'inherit'] })
let feederPort = ''
feeder.stdout.on('data', (d) => { feederPort += d })
for (let i = 0; i < 50 && !feederPort.trim(); i++) await sleep(100)
if (!feederPort.trim()) fatal('feed 服务子进程未就绪')
await sleep(200)
const base = `http://127.0.0.1:${feederPort.trim()}`

// —— userData：预置 L1 指针（验证 §6 清指针）+ 指向本地 feed 的设置 ——
const userData = path.join(tmpBase, 'userdata')
fs.mkdirSync(path.join(userData, 'hot-app'), { recursive: true })
fs.writeFileSync(path.join(userData, 'hot-app', 'current.json'), JSON.stringify({ schemaVersion: 1, channel: 'payload', version: 'stale', dir: 'hot-app/stale', manifestSha256: '0'.repeat(64), appliedAt: 1, appliedByShell: pkgVersion }))
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ updateFeedUrl: base }))

const exe = path.join(appDir, 'AgentDeck.exe')
const env = {
  ...process.env,
  APPDATA: tmpBase, LOCALAPPDATA: tmpBase, USERPROFILE: tmpBase, HOME: tmpBase,
  AGENTDECK_USER_DATA_DIR: userData,
  AGENTDECK_HOT_TRUST_HEX: process.env.AGENTDECK_HOT_TRUST_HEX,
  AGENTDECK_HOT_AUTO_APPLY_SHELL: '1',
  AGENTDECK_HOT_DEBUG_LOG: path.join(tmpBase, 'hot-debug.log')
}
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
delete env.AGENTDECK_DISABLE_HOT
console.log('[step] 启动复制版（check 后将自动两段 apply：staging → rename dance → relaunch）…')
const child = spawn(exe, [], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let exited = false
let exitCode = null
child.on('exit', (code) => { exited = true; exitCode = code })
child.stdout.pipe(fs.createWriteStream(path.join(tmpBase, 'app-stdout.log')))
child.stderr.pipe(fs.createWriteStream(path.join(tmpBase, 'app-stderr.log')))

const deadline = Date.now() + SCENARIO_TIMEOUT_MS
await waitFor('原进程退出（dance 后 relaunch + quit）', () => exited, deadline)
// 断链防循环：smoke 的新壳 exe 与旧壳同版本（asar 未改），relaunched 实例若还能拉到同一
// manifest 会再次 apply——真发版时壳版本必递增故无此问题；此处退出即撤下 feed。
fs.rmSync(path.join(feedDir, 'manifest.json'), { force: true })
const olds = () => fs.readdirSync(tmpBase).filter((n) => n.startsWith('app.old-'))
await waitFor('新实例存活（relaunch 拉起；须带 --agentdeck-hot-applied 参数，排除 swap helper 自身）', async () => {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='AgentDeck.exe'" | Where-Object { $_.ExecutablePath -like '${appBaseEscape()}*' -and $_.CommandLine -like '*agentdeck-hot-applied*' } | Select-Object -First 1 ProcessId | ConvertTo-Json -Compress`], { encoding: 'utf8', windowsHide: true })
  return r.status === 0 && r.stdout && r.stdout.trim() !== ''
}, deadline)
ok(exited, `原进程已退出（码 ${exitCode}）`)
ok(fs.existsSync(path.join(appDir, MARKER)), '原路径已是新壳（MARKER-SHELL-NEW.txt 存在）')
ok(fs.existsSync(path.join(appDir, 'resources', 'app.asar')), '新壳结构完整（app.asar 在位）')
const agedEvidence = () => {
  // 文件级 dance 的让位留证：appDir 内任意 .old-<ts> 文件（exe/dll/asar 被占用腾挪的痕迹）
  const found = []
  const visit = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) visit(p)
      else if (/\.old-\d+$/.test(e.name)) found.push(e.name)
    }
  }
  visit(appDir)
  return found
}
const aged = agedEvidence()
ok(aged.length >= 1, `.old-<ts> 让位文件留证存在（${aged.slice(0, 3).join(', ') || '无'}）`)
ok(!fs.existsSync(path.join(userData, 'hot-app', 'current.json')), '§6：L1 指针被清（壳自带最新载荷）')
await sleep(6000)
// staging 断言：干净环境应收尾器清空；受限环境（杀软/沙箱拦截 finisher）允许仅剩两个已知
// 被占用数据文件的文档化降级（exe/asar 等关键件必须已就位，上面已断言）
const stagingLeft = (() => {
  try {
    const dir = fs.readdirSync(tmpBase).find((n) => n.startsWith('app.staging-'))
    if (!dir) return []
    const found = []
    const visit = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) visit(p)
        else found.push(e.name)
      }
    }
    visit(path.join(tmpBase, dir))
    return found
  } catch {
    return []
  }
})()
const tolerated = ['icudtl.dat', 'v8_context_snapshot.bin']
const intolerable = stagingLeft.filter((n) => !tolerated.includes(n))
ok(stagingLeft.length === 0 || intolerable.length === 0, `staging 收尾（剩 ${stagingLeft.join(',') || '无'}${intolerable.length ? '，含不可容忍项' : '（已知降级：被占用数据文件）'}）`)

// —— 清理 ——
spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='AgentDeck.exe'" | Where-Object { $_.ExecutablePath -like '${appBaseEscape()}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('powershell.exe','wscript.exe') -and $_.CommandLine -like '*finish-swap*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { stdio: 'ignore', windowsHide: true })
feeder.kill()
await sleep(1000)
if (failed > 0) {
  console.error(`\n[FAIL] SMOKE HOT SHELL FAILED（${failed} 项）。现场保留: ${tmpBase}`)
  try {
    console.error('  hot-debug.log 尾部:', fs.readFileSync(path.join(tmpBase, 'hot-debug.log'), 'utf8').split(/\r?\n/).slice(-10).join('\n'))
  } catch { console.error('  （无 hot-debug.log）') }
  console.error('  stdout 尾部:', fs.readFileSync(path.join(tmpBase, 'app-stdout.log'), 'utf8').split(/\r?\n/).slice(-8).join('\n'))
  console.error('  stderr 尾部:', fs.readFileSync(path.join(tmpBase, 'app-stderr.log'), 'utf8').split(/\r?\n/).slice(-8).join('\n'))
  process.exit(1)
}
fs.rmSync(tmpBase, { recursive: true, force: true })
console.log('\n[ok] SMOKE HOT SHELL: 全绿（staging→dance→relaunch→新壳就位→指针重置→残留清扫）')

function appBaseEscape() {
  // PowerShell -like 单引号串：反斜杠是字面量，只需转义单引号
  return appDir.replaceAll("'", "''")
}
