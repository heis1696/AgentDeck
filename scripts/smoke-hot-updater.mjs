#!/usr/bin/env node
/**
 * scripts/smoke-hot-updater.mjs — L1×L2 双通道可用性账本冒烟（真实 HotUpdater + 本地 feed + 临时密钥）
 *
 * 现场回归（本 smoke 复现的缺陷）：L1 载荷 hot.28 生效（已应用并重启）期间，feed 上的 L2 渲染层 hot.30
 * 被「开始更新」应用后，设置页更新面板仍持续显示「可更新」（`UpdatePanel.tsx:119` 只看 available 非空），
 * 重启也不消失。两处根因（逐条固化成断言）：
 *   ① 解析单源在 L1 生效时无条件取载荷自带渲染层（修复前 `resolveHotState` 载荷分支直接 return，
 *      §4.1 顺序 2），L2 指针翻了也"看不见"——更新的渲染层实际没生效（→ 断言「有效 L2 路径被选中」）。
 *   ② 可用性账本在 L1 生效时拿载荷版本当"生效渲染层版本"（修复前 `activeVersionFor('renderer')`），
 *      于是 feed 里的同版 L2 永远"高于自己"→ 提示不消失；feed 回退到旧版 L2 时还会诱导降级
 *      （→ 断言「同版/旧版 L2 不提示」）。
 *
 * 覆盖（全部经真实 HotUpdater 公共方法：check / apply / applyAll / getState / onState；
 * 解析面用与 bootstrap/index.ts 同一实现的 resolveHotState 观察，不重写任何判定逻辑）：
 *   A 冷启动检查：L1 hot.28 + L2 hot.30 均提示；壳通道 feed 缺失（404）静默按无更新
 *   B applyAll：L1 指针翻转 + 一次 relaunch（stub 记录）；L2 指针翻转；两通道无 staging 残留
 *   C 重新实例化（模拟 L1 应用后的重启）：L1 保持生效（payload = hot.28，入口在位）
 *     + 有效 L2 路径被选中（rendererIndexHtml = hot-renderer/hot.30/out/renderer/index.html）
 *   D 重新实例化后 check：available 归零（同版不再提示）；无可用项时 applyAll 不改写指针
 *   E 同版/旧版 L2：feed 停在 hot.30 / 回退 hot.29（仍高于 L1 hot.28）→ 不提示、不降级、零触碰
 *   F 真新版：feed 抬到 hot.31 → 仍提示；应用后指针翻转、L1 不受影响；再实例化 check 归零（闭环）
 *   G 不兼容 L2：minMainVersion / minShellVersion 门禁不过 → check 按该通道无更新；apply 失败且零触碰
 *   H 损坏 L2：产物 sha 不符（传输损坏）/ zip CRC 坏（如实签名的坏产物）/ manifest 被篡改（验签不过）
 *     → apply（或 check）拦下，指针与生效面零触碰、无 staging 残留
 *   I L1 升级会清掉已是最新的 L2 指针：applyAll 后 L2 重新收敛，不留重复提示
 *   J L1/L2 feed 同版：L1 应用后同版 L2 不再重复下载（不产生 failed 状态）
 *   K 有效 L2 的 minMainVersion 高于壳但被生效 L1 满足（门禁基准 = 生效主进程版本）→ 提示、应用、生效
 *   L 真实落盘坏 L2 指针（manifest 为目录 / 不可读 / 缺失 / 坏签名 / 门禁不兼容 / 版本目录缺失）：
 *     resolveHotState 与 getState 不抛错，有效 L1 与其自带界面保持生效，坏指针只读不被改写
 *
 * 隔离铁律：临时目录（os.tmpdir）+ 临时 ed25519 密钥（AGENTDECK_HOT_TRUST_HEX）+ 本地 127.0.0.1 feed。
 * 不写 src/、不碰真实 userData（deps.getUserDataDir 指向临时目录）、不碰线上 feed（settings().updateFeedUrl
 * 指向本地端口）、不写仓库内文件（esbuild 产物落临时目录）。断言失败保留现场目录供排障。
 *
 * 修复前实测（HEAD src，9 项失败 / exit 1）：C 有效 L2 路径；D+E1 同版 L2 提示不消失；E2 旧版 L2 提示与
 * 生效面；F 新 L2 路径与归零；Z 收尾生效面——全部落在根因①②。修复后应全绿，A/B/G/H 修复前后都必须绿。
 * K/L 针对落盘坏状态：修复前 L 的「为目录 / 不可读 / 版本目录缺失」会让 resolveHotState 抛裸 fs 错误
 * （getState 连带抛错、L1 被拖垮），归一出错通道后必须全绿。
 *
 * smoke:hot-updater 已串接事务冒烟 scripts/smoke-hot-transaction.mjs（急先锋）并纳入 smoke:all。
 */
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import crypto from 'node:crypto'

const root = path.resolve(import.meta.dirname, '..')
const SHELL = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const L1 = `${SHELL}-hot.28` // L1 载荷（主进程 + 自带渲染层）
const L2 = `${SHELL}-hot.30` // L2 渲染层（现场回归里"应用了却一直提示"的版本）
const L2_OLD = `${SHELL}-hot.29` // 旧版 L2：高于 L1 hot.28 但低于已生效 hot.30
const L2_NEW = `${SHELL}-hot.31` // 真新版 L2
const L2_BAD_MAIN = `${SHELL}-hot.32` // 不兼容：minMainVersion 高于生效主进程
const L2_BAD_SHELL = `${SHELL}-hot.33` // 不兼容：minShellVersion 高于壳版本
const L2_CORRUPT_SHA = `${SHELL}-hot.34` // 损坏：feed 字节与 manifest 声明的 sha256 不符
const L2_CORRUPT_CRC = `${SHELL}-hot.35` // 损坏：manifest 如实描述坏产物（sha 门过、解压 CRC 门拦）
const L2_TAMPERED = `${SHELL}-hot.36` // 损坏：签名后篡改 manifest（验签不过）
const L2_BY_L1_GATE = `${SHELL}-hot.41` // 有效 L2：minMainVersion 高于壳、但被生效 L1 主进程满足

let failed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? '[ok]' : '[FAIL]'} ${msg}`)
  if (!cond) failed++
}
const show = (v) => (v === undefined ? 'undefined' : JSON.stringify(v))
const eq = (actual, expected, msg) => {
  const same = actual === expected
  ok(same, same ? msg : `${msg} — 实际 ${show(actual)} / 期望 ${show(expected)}`)
}
const note = (msg) => console.log(`  [info] ${msg}`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------- 临时工作区（失败保留现场） ----------
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-smoke-hot-updater-'))
const userData = path.join(work, 'userdata')
const feedDir = path.join(work, 'feed')
const treesDir = path.join(work, 'trees')
fs.mkdirSync(userData, { recursive: true })
fs.mkdirSync(feedDir, { recursive: true })
let keepScene = false
let server = null
/** 显式收掉本地 feed：监听句柄会拖住事件循环（成功路径必须主动关，不能只靠 exit 钩子）。 */
function shutdownFeed() {
  try {
    server?.close()
    server?.closeAllConnections?.()
  } catch {
    /* 关闭失败不影响结论 */
  }
}
const prevTrust = process.env.AGENTDECK_HOT_TRUST_HEX
process.on('exit', () => {
  shutdownFeed()
  if (prevTrust === undefined) delete process.env.AGENTDECK_HOT_TRUST_HEX
  else process.env.AGENTDECK_HOT_TRUST_HEX = prevTrust
  if (!keepScene) {
    try {
      fs.rmSync(work, { recursive: true, force: true })
    } catch {
      /* 占用中：留给系统临时目录清理 */
    }
  }
})
const fatal = (msg) => {
  console.error(`[FATAL] ${msg}`)
  process.exit(1)
}

// ---------- 临时签名密钥（与运行时同一信任锚入口） ----------
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
const keyId = `ad-smoke-updater-${Date.now().toString(36)}`
process.env.AGENTDECK_HOT_TRUST_HEX = `${keyId}:${Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex')}`
if (process.env.AGENTDECK_DISABLE_HOT === '1') {
  note('忽略 AGENTDECK_DISABLE_HOT=1（本 smoke 必须走真实热更解析链）')
  delete process.env.AGENTDECK_DISABLE_HOT
}

// ---------- 直连 src（esbuild 同 release-hot.mjs 手法；不在 src 内新增任何导出） ----------
async function loadTs(entry) {
  const outfile = path.join(work, `${path.basename(entry, '.ts')}.cjs`)
  await build({
    entryPoints: [path.join(root, entry)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    logLevel: 'silent'
  })
  return import(pathToFileURL(outfile).href)
}
const { HotUpdater } = await loadTs('src/main/hot/updater.ts')
const { resolveHotState } = await loadTs('src/main/hot/resolve.ts')
const { channelRoot, clearPointer, pointerFilePath, readPointer, writePointerAtomic } = await loadTs('src/main/hot/pointer.ts')
const { compareSemver } = await loadTs('src/main/hot/verifier.ts')
const { createZipStore } = await loadTs('src/main/hot/zip.ts')
const { canonicalJson } = await loadTs('src/main/hot/canonical.ts')

// ---------- 本地 feed 组装 ----------
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')

const walkTree = (dir, base = dir) => {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walkTree(abs, base))
    else if (e.isFile()) out.push({ rel: path.relative(base, abs).split(path.sep).join('/'), abs })
  }
  return out
}

const writeTree = (dir, files) => {
  fs.rmSync(dir, { recursive: true, force: true })
  for (const [rel, data] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, data)
  }
  return dir
}

/** 版本目录内容：L1 要含 out/main/index.js（payload.entry）+ 自带渲染层；L2 只含渲染层（§6.1）。 */
const versionFiles = (channel, version) =>
  channel === 'payload'
    ? {
        'out/main/index.js': `// payload main ${version}\nmodule.exports = { version: '${version}' }\n`,
        'out/renderer/index.html': `<!doctype html><html><body>payload-bundled-renderer ${version}</body></html>\n`,
        'package.json': `${JSON.stringify({ name: 'agentdeck', version, main: 'out/main/index.js' }, null, 2)}\n`
      }
    : {
        'out/renderer/index.html': `<!doctype html><html><body>l2-renderer ${version}</body></html>\n`,
        'out/renderer/assets/app.js': `console.log('l2 renderer ${version}')\n`
      }

/** 破坏 zip 首个条目的数据区（保持目录结构完好：sha 门可过，解压 CRC 门必拦）。 */
function flipFirstEntryByte(zip) {
  const out = Buffer.from(zip)
  const nameLen = out.readUInt16LE(26)
  const dataLen = out.readUInt32LE(18)
  const offset = 30 + nameLen + Math.floor(dataLen / 2)
  out[offset] ^= 0xff
  return out
}

/** manifest 文档 = payload + Ed25519 签名（与 verifier 同一 canonicalJson 手法；临时密钥仅本进程有效）。 */
const signManifest = (payload) =>
  JSON.stringify(
    { payload, signature: crypto.sign(null, Buffer.from(canonicalJson(payload), 'utf8'), privateKey).toString('base64') },
    null,
    2
  )

/**
 * 发布一个通道版本到本地 feed（版本目录树 → store-only zip → 同 canonicalJson 签名 manifest）。
 * corrupt：'sha' = feed 字节被改而 manifest 仍声明原始 sha（传输损坏）；
 *          'crc' = manifest 如实声明坏字节（sha 门过，解压 CRC 门拦）；
 * tamper：签名之后改 manifest.version（伪造/被改 → 验签必不过）。
 */
function publish(channel, version, opts = {}) {
  const { minMainVersion = SHELL, minShellVersion = SHELL, corrupt = null, tamper = false } = opts
  const treeDir = writeTree(path.join(treesDir, channel, version), versionFiles(channel, version))
  const entries = walkTree(treeDir).map(({ rel, abs }) => ({ path: rel, data: fs.readFileSync(abs) }))
  const zip = Buffer.from(createZipStore(entries))
  const files = entries.map((e) => ({ path: e.path, sha256: sha256(e.data), size: e.data.length }))
  let served = zip
  let declared = zip
  if (corrupt === 'sha') served = flipFirstEntryByte(zip)
  else if (corrupt === 'crc') declared = served = flipFirstEntryByte(zip)
  const payload = {
    schemaVersion: 1,
    channel,
    version,
    minMainVersion,
    minShellVersion,
    releaseDate: new Date().toISOString(),
    keyId,
    artifact: { name: `${channel}-${version}.zip`, sha256: sha256(declared), size: declared.length },
    files
  }
  let manifestJson = signManifest(payload)
  if (tamper) {
    const doc = JSON.parse(manifestJson)
    doc.payload.version = `${version}.tampered`
    manifestJson = JSON.stringify(doc, null, 2)
  }
  const channelDir = path.join(feedDir, channel)
  fs.rmSync(channelDir, { recursive: true, force: true })
  fs.mkdirSync(channelDir, { recursive: true })
  fs.writeFileSync(path.join(channelDir, 'manifest.json'), manifestJson)
  fs.writeFileSync(path.join(channelDir, payload.artifact.name), served)
  return { version, artifact: payload.artifact.name, bytes: served.length }
}

// ---------- 本地 feed 服务（只监听 127.0.0.1，绝不触达线上 feed） ----------
server = http.createServer((req, res) => {
  const rel = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '')
  const file = path.resolve(feedDir, rel)
  if (!file.startsWith(feedDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  const buf = fs.readFileSync(file)
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': buf.length })
  res.end(buf)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const feedBase = `http://127.0.0.1:${server.address().port}`

// ---------- 真实 HotUpdater 驱动器 ----------
let restarts = 0

function makeUpdater({ idle = true, dataDir = userData } = {}) {
  const calls = { relaunch: [], quit: [] }
  const states = []
  const updater = new HotUpdater({
    getWindow: () => null,
    isMainIdle: () => idle,
    relaunchForUpdate: (v) => calls.relaunch.push(v),
    quitForShellUpdate: () => calls.quit.push('quit'),
    settings: () => ({ updateFeedUrl: feedBase }),
    getUserDataDir: () => dataDir,
    getShellVersion: () => SHELL,
    getAppDir: () => null
  })
  updater.onState((snapshot) => states.push(snapshot))
  return { updater, calls, states }
}
/** 重新实例化 = 模拟「L1 应用后 relaunch 起来的新进程」（进程内状态/缓存全清，只共享 userData 与 feed）。 */
const restart = () => {
  restarts++
  return makeUpdater()
}

const rel = (p) => (p ? path.relative(userData, p).split(path.sep).join('/') : null)
const l1Html = (v) => `hot-app/${v}/out/renderer/index.html`
const l2Html = (v) => `hot-renderer/${v}/out/renderer/index.html`
const pointerVersion = (channel) => {
  try {
    return readPointer(userData, channel)?.version ?? null
  } catch (error) {
    return `<invalid:${error instanceof Error ? error.message : String(error)}>`
  }
}
/** 生效面（与 index.ts:206 / bootstrap 同一解析单源）：L1 载荷 + 实际会 loadFile 的渲染层入口。 */
const effective = () => {
  try {
    const res = resolveHotState(userData, SHELL)
    return {
      payloadVersion: res.payload?.version ?? null,
      payloadEntry: rel(res.payload?.entry ?? null),
      rendererHtml: rel(res.rendererIndexHtml),
      reason: res.reason,
      threw: null
    }
  } catch (error) {
    // 解析单源抛错本身就是缺陷（调用方无兜底）：转成可断言观测值，冒烟不因此崩掉。
    return {
      payloadVersion: null,
      payloadEntry: null,
      rendererHtml: null,
      reason: 'threw',
      threw: String(error instanceof Error ? error.message : error)
    }
  }
}
const channelEntries = (channel) => {
  try {
    return fs.readdirSync(channelRoot(userData, channel))
  } catch {
    return []
  }
}
const stagingResidue = (channel) => channelEntries(channel).filter((n) => n.startsWith('.staging-') || n.startsWith('.latest-'))
const availableKeys = (snapshot) => Object.keys(snapshot?.available ?? {})

async function scenarioPeriodicStopCancelsInitialCheck() {
  console.log('\n[scenario] periodic check stop cancels the delayed initial check')
  const context = makeUpdater({ dataDir: path.join(work, 'periodic-stop') })
  context.updater.startPeriodicCheck(25, 1000)
  context.updater.stop()
  await sleep(75)
  eq(context.states.length, 0, 'stop cancels the delayed initial check and emits no state')
}

/** 失败路径公共断言：现网零触碰（生效面不变、指针不变、未落版本目录、无 staging/.latest 残留）。 */
function assertUntouched(tag, { effBefore, pointers, notInstalled }) {
  const effAfter = effective()
  const same = JSON.stringify(effAfter) === JSON.stringify(effBefore)
  ok(same, `${tag} 生效面零触碰（${JSON.stringify(effAfter)}${same ? '' : ` ≠ ${JSON.stringify(effBefore)}`}）`)
  for (const [channel, version] of Object.entries(pointers)) {
    eq(pointerVersion(channel), version, `${tag} ${channel} 指针未被失败路径改写`)
  }
  if (notInstalled) {
    eq(
      channelEntries(notInstalled.channel).includes(notInstalled.name),
      false,
      `${tag} 未落 ${notInstalled.channel}/${notInstalled.name}`
    )
  }
  eq(stagingResidue('renderer').length, 0, `${tag} 渲染层通道无 staging/.latest 残留`)
  eq(stagingResidue('payload').length, 0, `${tag} 载荷通道无 staging/.latest 残留`)
}

/** 把"抛错"也变成可断言观测值：坏指针现场不得让冒烟脚本以 FATAL 收场。 */
const attempt = async (fn) => {
  try {
    return { value: await fn(), threw: null }
  } catch (error) {
    return { value: null, threw: String(error instanceof Error ? error.message : error) }
  }
}

/** 只给"落盘坏状态"场景造 manifest：产物字段不参与解析校验，填占位即可。 */
const rawManifest = (channel, version, opts = {}) =>
  signManifest({
    schemaVersion: 1,
    channel,
    version,
    minMainVersion: opts.minMainVersion ?? SHELL,
    minShellVersion: opts.minShellVersion ?? SHELL,
    releaseDate: new Date().toISOString(),
    keyId,
    artifact: { name: `${channel}-${version}.zip`, sha256: sha256(Buffer.from(`raw:${channel}:${version}`)), size: 1 },
    files: []
  })

/**
 * 让已落盘的 manifest.json 真读不出来：POSIX chmod 0o000；Windows 上 chmod 只改只读位，
 * 改用 ACL 拒绝 Everyone 读取。返回生效手段，返回 null = 本平台/权限造不出该状态（调用方跳过）。
 */
function makeUnreadable(file) {
  const unreadable = () => {
    try {
      fs.readFileSync(file)
      return false
    } catch {
      return true
    }
  }
  try {
    fs.chmodSync(file, 0o000)
  } catch {
    /* 平台不支持则看下一步 */
  }
  if (unreadable()) return 'chmod'
  if (process.platform === 'win32') {
    try {
      execFileSync('icacls', [file, '/deny', '*S-1-1-0:(R)'], { stdio: 'ignore' })
    } catch {
      /* 无权限改 ACL 则放弃 */
    }
    if (unreadable()) return 'icacls'
  }
  return null
}

/** 撤销 makeUnreadable 的处置（放开 ACL + 只读位）：删除前先还原，避免拒绝项/只读位挡住清理。 */
function restoreReadable(file) {
  try {
    fs.chmodSync(file, 0o666)
  } catch {
    /* 文件可能已不存在 */
  }
  if (process.platform !== 'win32') return
  try {
    execFileSync('icacls', [file, '/remove:d', '*S-1-1-0'], { stdio: 'ignore' })
  } catch {
    /* 还原失败不影响断言 */
  }
}

/**
 * 真实落盘一套坏 L2（绕过 updater：直击解析单源面对磁盘坏状态的行为），并写下真实 current.json。
 * kind：'manifest-dir' 清单是目录（EISDIR）；'unreadable' 读不出（chmod/ACL）；
 *       'missing' 清单缺失；'bad-signature' 签名被改；'gate' 签名有效但 minMainVersion 高于 L1；
 *       'dir-missing' 版本目录不存在。返回 null = 本平台造不出（'unreadable'）。
 */
function installRawL2(rootDir, version, kind) {
  const dir = path.join(channelRoot(rootDir, 'renderer'), version)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(channelRoot(rootDir, 'renderer'), { recursive: true }) // 'dir-missing' 也要能落下指针
  const manifestPath = path.join(dir, 'manifest.json')
  let manifestSha = null
  if (kind === 'dir-missing') {
    // 只写指针，版本目录整个不存在
  } else {
    fs.mkdirSync(path.join(dir, 'out', 'renderer'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'out', 'renderer', 'index.html'), `<!doctype html><html><body>raw-l2 ${version}</body></html>\n`)
    if (kind === 'manifest-dir') {
      fs.mkdirSync(manifestPath)
    } else if (kind === 'missing') {
      /* 不写 manifest.json */
    } else if (kind === 'unreadable') {
      const bytes = Buffer.from(rawManifest('renderer', version))
      fs.writeFileSync(manifestPath, bytes)
      manifestSha = sha256(bytes) // 必须在加锁/拒读之前算好
      if (!makeUnreadable(manifestPath)) {
        fs.rmSync(dir, { recursive: true, force: true })
        return null
      }
    } else if (kind === 'bad-signature') {
      const doc = JSON.parse(rawManifest('renderer', version))
      const sig = Buffer.from(doc.signature, 'base64')
      sig[0] ^= 0xff
      doc.signature = sig.toString('base64')
      const bytes = Buffer.from(JSON.stringify(doc, null, 2))
      fs.writeFileSync(manifestPath, bytes)
      manifestSha = sha256(bytes)
    } else if (kind === 'gate') {
      const bytes = Buffer.from(rawManifest('renderer', version, { minMainVersion: `${SHELL}-hot.99` }))
      fs.writeFileSync(manifestPath, bytes)
      manifestSha = sha256(bytes)
    } else {
      throw new Error(`未知的坏指针场景：${kind}`)
    }
  }
  // 读不到/没有清单：sha 门到不了，形状合法即可（readPointer 只校验 64 位十六进制）
  const sha = manifestSha ?? sha256(Buffer.from(`placeholder:${version}`))
  writePointerAtomic(pointerFilePath(rootDir, 'renderer'), {
    schemaVersion: 1,
    channel: 'renderer',
    version,
    dir: `hot-renderer/${version}`,
    manifestSha256: sha,
    appliedAt: Date.now(),
    appliedByShell: SHELL
  })
  return dir
}

// ---------- 场景 ----------
async function main() {
  console.log(`[setup] 工作区 ${work}`)
  note(`shell=${SHELL} ${L1}=L1 载荷 / ${L2}=L2 渲染层；feed ${feedBase}；keyId=${keyId}（临时，进程外无效）`)

  // —— A 冷启动检查
  await scenarioPeriodicStopCancelsInitialCheck()

  console.log('\n[scenario] A 冷启动检查（feed: L1 hot.28 + L2 hot.30）')
  publish('payload', L1)
  publish('renderer', L2)
  const a = restart()
  const stateA = await a.updater.check()
  eq(stateA.available?.payload, L1, 'A 提示 L1 可更新')
  eq(stateA.available?.renderer, L2, 'A 提示 L2 可更新')
  eq(stateA.available?.shell, undefined, 'A 壳通道 feed 缺失（404）→ 静默按无更新')
  eq(stateA.currentVersion, SHELL, 'A 当前版本 = 壳版本（尚未应用）')

  // —— B 一键应用（L1 + L2）
  console.log('\n[scenario] B applyAll（UI「开始更新」：L1 指针翻转 + relaunch；L2 指针翻转）')
  const appliedB = await a.updater.applyAll()
  eq(appliedB.ok, true, `B applyAll 成功（error=${show(appliedB.error)}）`)
  eq(a.calls.relaunch.join(','), L1, 'B L1 应用触发一次 relaunch（记录 hot.28）')
  eq(a.calls.quit.length, 0, 'B 非壳通道不触发壳退出')
  eq(pointerVersion('payload'), L1, 'B L1 指针 = hot.28')
  eq(pointerVersion('renderer'), L2, 'B L2 指针 = hot.30（有效 L2 被应用，而不是被丢弃）')
  eq(stagingResidue('payload').length, 0, 'B 载荷通道无 staging/.latest 残留')
  eq(stagingResidue('renderer').length, 0, 'B 渲染层通道无 staging/.latest 残留')

  // —— C 重新实例化：生效面
  console.log('\n[scenario] C 重新实例化（模拟 L1 应用后的重启）→ 生效面')
  const c = restart()
  const effC = effective()
  eq(effC.payloadVersion, L1, 'C L1 保持生效：载荷解析 = hot.28')
  ok(
    !!effC.payloadEntry && fs.existsSync(path.join(userData, effC.payloadEntry)),
    `C L1 载荷入口在位（${effC.payloadEntry}）`
  )
  eq(effC.rendererHtml, l2Html(L2), 'C 有效 L2 路径被选中：rendererIndexHtml 指向 hot-renderer/hot.30')
  ok(
    !!effC.rendererHtml && fs.existsSync(path.join(userData, effC.rendererHtml)),
    `C 选中的渲染层入口文件真实存在（${effC.rendererHtml}）`
  )
  eq(c.updater.getState().currentVersion, L1, 'C 更新面板当前版本 = hot.28（L1）')

  // —— D 重新实例化后检查：同版不再提示
  console.log('\n[scenario] D 重新实例化后检查（同版不再提示）')
  const stateD = await c.updater.check()
  eq(stateD.available?.renderer, undefined, 'D L2 hot.30 不再提示（已生效的同版）')
  eq(stateD.available?.payload, undefined, 'D L1 hot.28 不再提示（已生效的同版）')
  eq(availableKeys(stateD).join(','), '', `D available 归零（实际 ${JSON.stringify(stateD.available)}）`)
  const pointerBeforeD = { payload: pointerVersion('payload'), renderer: pointerVersion('renderer') }
  const appliedD = await c.updater.applyAll()
  eq(appliedD.ok, true, `D 无可用项时 applyAll 不报错（error=${show(appliedD.error)}）`)
  eq(pointerVersion('renderer'), pointerBeforeD.renderer, 'D 无可用项时 applyAll 不改写渲染层指针')
  eq(pointerVersion('payload'), pointerBeforeD.payload, 'D 无可用项时 applyAll 不改写载荷指针')

  // —— E 同版/旧版 L2 不诱导
  console.log('\n[scenario] E 同版/旧版 L2 回退（严格升级门控：不提示、不降级）')
  const e1 = restart()
  const stateE1 = await e1.updater.check()
  eq(stateE1.available?.renderer, undefined, 'E1 feed 仍是同版 hot.30 → 不提示')
  publish('renderer', L2_OLD)
  const e2 = restart()
  const stateE2 = await e2.updater.check()
  eq(stateE2.available?.renderer, undefined, 'E2 feed 回退旧版 hot.29（低于已生效 hot.30）→ 不提示、不诱导降级')
  eq(effective().rendererHtml, l2Html(L2), 'E2 生效渲染层未被改动（仍 hot.30）')
  eq(pointerVersion('renderer'), L2, 'E2 渲染层指针未回退（仍 hot.30）')
  eq(
    channelEntries('renderer').includes(L2_OLD),
    false,
    `E2 旧版未被安装（无 hot-renderer/${L2_OLD}）`
  )
  eq(stagingResidue('renderer').length, 0, 'E2 渲染层通道无 staging/.latest 残留')

  // —— F 真新版仍提示 + 应用后归零
  console.log('\n[scenario] F 真正新版本仍提示（hot.31）→ 应用后归零')
  publish('renderer', L2_NEW)
  const f = restart()
  const stateF = await f.updater.check()
  eq(stateF.available?.renderer, L2_NEW, 'F feed 抬到 hot.31 → 仍提示可更新')
  eq(stateF.available?.payload, undefined, 'F L1 hot.28 已生效 → 不提示')
  const appliedF = await f.updater.applyAll()
  eq(appliedF.ok, true, `F applyAll 成功（error=${show(appliedF.error)}）`)
  eq(f.calls.relaunch.length, 0, 'F 纯 L2 应用不重启主进程（§4.3：L2 = loadFile 热切换）')
  eq(pointerVersion('renderer'), L2_NEW, 'F 渲染层指针 = hot.31')
  eq(pointerVersion('payload'), L1, 'F 载荷指针未被改动（仍 hot.28）')
  const effF = effective()
  eq(effF.payloadVersion, L1, 'F L1 保持生效')
  eq(effF.rendererHtml, l2Html(L2_NEW), 'F 新 L2 路径被选中')
  const g = restart()
  const stateG = await g.updater.check()
  eq(availableKeys(stateG).join(','), '', `F 应用新 L2 后重新实例化 available 归零（实际 ${JSON.stringify(stateG.available)}）`)

  // —— G 不兼容 L2 回退
  console.log('\n[scenario] G 不兼容 L2 回退（minMainVersion / minShellVersion 门禁不过）')
  const effBeforeG = effective()
  const pointersG = { payload: L1, renderer: L2_NEW }
  publish('renderer', L2_BAD_MAIN, { minMainVersion: `${SHELL}-hot.99` })
  const g1 = restart()
  const stateG1 = await g1.updater.check()
  eq(stateG1.available?.renderer, undefined, 'G1 minMainVersion 高于生效主进程 → check 按该通道无更新')
  const appliedG1 = await g1.updater.apply('renderer')
  eq(appliedG1.ok, false, `G1 apply 拒绝安装（error=${show(appliedG1.error)}）`)
  ok(typeof appliedG1.error === 'string' && appliedG1.error.length > 0, 'G1 失败带可读原因')
  assertUntouched('G1', { effBefore: effBeforeG, pointers: pointersG, notInstalled: { channel: 'renderer', name: L2_BAD_MAIN } })

  publish('renderer', L2_BAD_SHELL, { minShellVersion: `${SHELL}-hot.99` })
  const g2 = restart()
  const stateG2 = await g2.updater.check()
  eq(stateG2.available?.renderer, undefined, 'G2 minShellVersion 高于壳版本 → check 按该通道无更新')
  const appliedG2 = await g2.updater.apply('renderer')
  eq(appliedG2.ok, false, `G2 apply 拒绝安装（error=${show(appliedG2.error)}）`)
  assertUntouched('G2', { effBefore: effBeforeG, pointers: pointersG, notInstalled: { channel: 'renderer', name: L2_BAD_SHELL } })

  // —— H 损坏 L2 回退
  console.log('\n[scenario] H 损坏 L2 回退（产物 sha 不符 / zip CRC 坏 / manifest 验签不过）')
  const effBeforeH = effective()
  const pointersH = { payload: L1, renderer: L2_NEW }
  publish('renderer', L2_CORRUPT_SHA, { corrupt: 'sha' })
  const h1 = restart()
  const stateH1 = await h1.updater.check()
  eq(stateH1.available?.renderer, L2_CORRUPT_SHA, 'H1 manifest 本身合法 → check 仍提示（产物完整性只能到 apply 才验）')
  const appliedH1 = await h1.updater.apply('renderer')
  eq(appliedH1.ok, false, `H1 apply 拦下 sha 不符的产物（error=${show(appliedH1.error)}）`)
  assertUntouched('H1', { effBefore: effBeforeH, pointers: pointersH, notInstalled: { channel: 'renderer', name: L2_CORRUPT_SHA } })

  publish('renderer', L2_CORRUPT_CRC, { corrupt: 'crc' })
  const h2 = restart()
  const stateH2 = await h2.updater.check()
  eq(stateH2.available?.renderer, L2_CORRUPT_CRC, 'H2 manifest 如实描述坏产物 → check 仍提示（sha 门可过）')
  const appliedH2 = await h2.updater.apply('renderer')
  eq(appliedH2.ok, false, `H2 apply 拦下解压 CRC 失败的产物（error=${show(appliedH2.error)}）`)
  assertUntouched('H2', { effBefore: effBeforeH, pointers: pointersH, notInstalled: { channel: 'renderer', name: L2_CORRUPT_CRC } })

  publish('renderer', L2_TAMPERED, { tamper: true })
  const h3 = restart()
  const stateH3 = await h3.updater.check()
  eq(stateH3.available?.renderer, undefined, 'H3 manifest 验签不过 → check 按该通道无更新')
  const appliedH3 = await h3.updater.apply('renderer')
  eq(appliedH3.ok, false, `H3 apply 拦下验签不过的 manifest（error=${show(appliedH3.error)}）`)
  assertUntouched('H3', { effBefore: effBeforeH, pointers: pointersH })

  // —— 收尾：整场结束后 L1 仍生效
  console.log('\n[scenario] Z 收尾对账（L1 全程保持生效）')
  const effEnd = effective()
  eq(effEnd.payloadVersion, L1, 'Z 载荷指针/解析仍是 hot.28（失败路径零触碰）')
  eq(effEnd.rendererHtml, l2Html(L2_NEW), 'Z 生效渲染层仍是最后成功应用的 hot.31')
  eq(pointerVersion('payload'), L1, 'Z 载荷指针 = hot.28')
  eq(pointerVersion('renderer'), L2_NEW, 'Z 渲染层指针 = hot.31')

  console.log('\n[scenario] I L1 upgrade clears an already-current L2 pointer')
  publish('payload', L2_OLD)
  publish('renderer', L2_NEW)
  const i = restart()
  const stateI = await i.updater.check()
  eq(stateI.available?.payload, L2_OLD, 'I newer L1 is available')
  eq(stateI.available?.renderer, undefined, 'I existing L2 is already current before L1 changes')
  eq((await i.updater.applyAll()).ok, true, 'I applyAll succeeds')
  eq(effective().payloadVersion, L2_OLD, 'I upgraded L1 remains active')
  eq(effective().rendererHtml, l2Html(L2_NEW), 'I L2 is restored after the L1 pointer switch')
  eq(availableKeys(i.updater.getState()).length, 0, 'I completed update leaves no repeated update prompt')

  console.log('\n[scenario] J L1 and L2 feeds contain the same newer version')
  const sameVersion = `${SHELL}-hot.40`
  publish('payload', sameVersion)
  publish('renderer', sameVersion)
  const j = restart()
  await j.updater.check()
  eq((await j.updater.applyAll()).ok, true, 'J same-version channel update succeeds')
  eq(effective().rendererHtml, l1Html(sameVersion), 'J L1 already supplies the requested renderer')
  eq(j.updater.getState().error, undefined, 'J superseded L2 is skipped without a failed update state')
  eq(j.states.some((s) => s.phase === 'downloading' && s.channel === 'renderer'), false, 'J no redundant L2 download after applying the same L1 version')

  // —— K L2 门禁基准 = 生效 L1 主进程（minMainVersion 高于壳、但 L1 满足）
  console.log('\n[scenario] K 有效 L2 的 minMainVersion 高于壳但被生效 L1 满足（门禁基准 = 生效主进程）')
  const l1K = pointerVersion('payload') // J 应用后的 L1
  publish('renderer', L2_BY_L1_GATE, { minMainVersion: l1K })
  eq(compareSemver(l1K, SHELL), 1, `K 前提：生效 L1 ${l1K} 高于壳 ${SHELL}`)
  eq(compareSemver(L2_BY_L1_GATE, l1K), 1, `K 前提：待装 L2 ${L2_BY_L1_GATE} 严格高于 L1`)
  const k = restart()
  const stateK = await k.updater.check()
  eq(stateK.available?.renderer, L2_BY_L1_GATE, 'K minMainVersion 高于壳但 L1 满足 → check 提示 L2 可更新')
  const appliedK = await k.updater.apply('renderer')
  eq(appliedK.ok, true, `K apply 成功（error=${show(appliedK.error)}）`)
  eq(pointerVersion('renderer'), L2_BY_L1_GATE, 'K L2 指针翻转')
  const effK = effective()
  eq(effK.threw, null, `K resolveHotState 不抛错（实际 ${show(effK.threw)}）`)
  eq(effK.payloadVersion, l1K, 'K L1 主进程保持生效')
  eq(effK.rendererHtml, l2Html(L2_BY_L1_GATE), 'K 有效 L2 界面被选中')
  eq(effK.reason, 'renderer', 'K reason = renderer')
  const stateK2 = k.updater.getState()
  eq(stateK2.currentVersion, l1K, 'K getState 当前版本 = L1')
  eq(stateK2.activeRendererVersion, L2_BY_L1_GATE, 'K getState 生效渲染层 = L2')
  eq(availableKeys(stateK2).join(','), '', `K 应用后 available 归零（实际 ${JSON.stringify(stateK2.available)}）`)
  const k2 = restart()
  const stateK3 = await k2.updater.check()
  eq(stateK3.available?.renderer, undefined, 'K 重新实例化后同版 L2 不再提示')

  // —— L 真实落盘坏 L2 指针：解析单源不得抛错，有效 L1 与其自带界面必须保留
  console.log('\n[scenario] L 已安装 L2 坏状态（manifest 目录/不可读/缺失/坏签名/门禁不兼容/目录缺失）')
  const l1L = pointerVersion('payload') // hot.40
  const l2L = L2_BY_L1_GATE // feed 上仍有效的 L2（K 已应用）
  const rawCases = [
    ['manifest 是目录（EISDIR）', `${SHELL}-hot.50`, 'manifest-dir', 'payload-rejected:manifest-unreadable'],
    ['manifest 不可读（chmod/ACL）', `${SHELL}-hot.51`, 'unreadable', 'payload-rejected:manifest-unreadable'],
    ['manifest 缺失', `${SHELL}-hot.52`, 'missing', 'payload-rejected:manifest-missing'],
    ['manifest 坏签名', `${SHELL}-hot.53`, 'bad-signature', 'payload-rejected:signature-invalid'],
    ['manifest 门禁不兼容（minMainVersion 高于 L1）', `${SHELL}-hot.54`, 'gate', 'payload-rejected:min-main-version'],
    ['版本目录缺失', `${SHELL}-hot.55`, 'dir-missing', 'pointer-invalid:version-dir-missing']
  ]
  for (const [label, version, kind, expectReason] of rawCases) {
    if (!installRawL2(userData, version, kind)) {
      note(`L ${label}：本平台无法制造该磁盘状态（chmod/ACL 均不生效），跳过`)
      continue
    }
    const eff = effective()
    eq(eff.threw, null, `L ${label} → resolveHotState 不抛错（实际 ${show(eff.threw)}）`)
    eq(eff.payloadVersion, l1L, `L ${label} → 有效 L1 保持生效`)
    eq(eff.rendererHtml, l1Html(l1L), `L ${label} → 界面用 L1 自带渲染层`)
    eq(eff.reason, 'payload', `L ${label} → reason = payload（热更仍生效）`)
    ok(
      !!eff.rendererHtml && fs.existsSync(path.join(userData, eff.rendererHtml)),
      `L ${label} → L1 自带界面入口真实存在（${eff.rendererHtml}）`
    )
    eq(pointerVersion('renderer'), version, `L ${label} → 解析只读：坏指针原样在盘`)

    const u = restart()
    const ck = await attempt(() => u.updater.check())
    eq(ck.threw, null, `L ${label} → check 不抛错（实际 ${show(ck.threw)}）`)
    let gs
    try {
      gs = { snap: u.updater.getState(), threw: null }
    } catch (error) {
      gs = { snap: null, threw: String(error instanceof Error ? error.message : error) }
    }
    eq(gs.threw, null, `L ${label} → getState 不抛错（实际 ${show(gs.threw)}）`)
    eq(gs.snap?.currentVersion, l1L, `L ${label} → getState 当前版本 = L1`)
    eq(gs.snap?.activeRendererVersion, undefined, `L ${label} → getState 无生效 L2`)
    eq(gs.snap?.available?.renderer, l2L, `L ${label} → 账本仍提示 feed 上的有效 L2（面板不卡死）`)
    eq(gs.snap?.available?.payload, undefined, `L ${label} → 已生效的 L1 不重复提示`)

    // 无 L1 的隔离目录：坏 L2 的失败必须被归一成诊断（不外抛裸 fs 错误）并回退内置
    const iso = fs.mkdtempSync(path.join(work, 'iso-'))
    if (installRawL2(iso, version, kind)) {
      let isoRes
      try {
        const r = resolveHotState(iso, SHELL)
        isoRes = { reason: r.reason, payload: r.payload, html: r.rendererIndexHtml, threw: null }
      } catch (error) {
        isoRes = { reason: 'threw', payload: 'unknown', html: 'unknown', threw: String(error instanceof Error ? error.message : error) }
      }
      eq(isoRes.threw, null, `L ${label} → 无 L1 时 resolveHotState 不抛错`)
      eq(isoRes.reason, expectReason, `L ${label} → 诊断归一为 ${expectReason}`)
      eq(isoRes.payload, null, `L ${label} → 无 L1 时不冒认载荷`)
      eq(isoRes.html, null, `L ${label} → 无 L1 时回退内置界面`)
      const isoState = await attempt(() => makeUpdater({ dataDir: iso }).updater.getState())
      eq(isoState.threw, null, `L ${label} → 无 L1 时更新状态可读取`)
      eq(isoState.value?.activeRendererVersion, undefined, `L ${label} → 坏 L2 指针不能冒充生效版本`)
      restoreReadable(path.join(iso, 'hot-renderer', version, 'manifest.json'))
    } else {
      note(`L ${label}：隔离目录造不出该状态，跳过诊断断言`)
    }
    fs.rmSync(iso, { recursive: true, force: true })
  }

  // —— Z2 收尾：按 bootstrap 自愈路径清掉坏 L2 指针 → 回到 L1 自带界面
  console.log('\n[scenario] Z2 收尾对账（坏 L2 指针清除后 L1 与自带界面仍生效）')
  for (const [, version] of rawCases) restoreReadable(path.join(channelRoot(userData, 'renderer'), version, 'manifest.json'))
  clearPointer(userData, 'renderer', 'corrupt')
  eq(pointerVersion('renderer'), null, 'Z2 坏 L2 指针清除后无渲染层指针')
  const effL = effective()
  eq(effL.threw, null, `Z2 resolveHotState 不抛错（实际 ${show(effL.threw)}）`)
  eq(effL.payloadVersion, l1L, 'Z2 L1 仍生效')
  eq(effL.rendererHtml, l1Html(l1L), 'Z2 界面回到 L1 自带渲染层')
  for (const [, version] of rawCases) {
    fs.rmSync(path.join(channelRoot(userData, 'renderer'), version), { recursive: true, force: true })
  }
  const z2 = await attempt(() => restart().updater.check())
  eq(z2.threw, null, `Z2 check 不抛错（实际 ${show(z2.threw)}）`)

  console.log(`\n[info] 重新实例化次数（模拟重启）：${restarts}`)
  if (failed > 0) {
    keepScene = true
    console.error(`\n[FAIL] SMOKE HOT UPDATER FAILED（${failed} 项）。现场保留: ${work}`)
    console.error('  修复前预期失败面（9 项，全部落在两处根因）：')
    console.error('    ① 解析单源没选中 L2：C / E2 / F / Z 的「有效 L2 路径被选中」断言')
    console.error('    ② 账本拿载荷版本当生效渲染层：D / E1 / E2 / F 的「同版/旧版/新 L2 归零」断言')
    console.error('  A/B/G/H 是回退回归面，修复前后都必须通过。')
    console.error('  K/L 是新增面：K = L2 门禁基准取生效 L1；L = 落盘坏 L2 状态归一（resolveHotState/getState 不得抛错）。')
    process.exit(1)
  }
  console.log('\n[ok] SMOKE HOT UPDATER: 全绿（L1×L2 生效面 + 可用性账本 + 同版/旧版 + 门禁/损坏回退 + 落盘坏指针归一）')
  shutdownFeed() // 收掉监听句柄，进程才能自然退出（清理交给 exit 钩子）
}

main().catch((error) => {
  keepScene = true
  console.error(`[FATAL] ${error && error.stack ? error.stack : error}\n现场保留: ${work}`)
  process.exit(1)
})
