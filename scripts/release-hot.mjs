#!/usr/bin/env node
/**
 * scripts/release-hot.mjs — 热更发布产物生成器（docs/HOT-UPDATE-IMPL-DESIGN.md §6.2）
 *
 * 步骤：npm run build → 按 §6.1 组装 → store-only zip → 逐文件 sha256 →
 *       组 manifest payload 块 → canonicalJson → Ed25519 签名 → 写 manifest.json →
 *       自检（esbuild 打包 src/main/hot/verifier.ts 回读验签 + files[] 复核 + zip 解包复核）→
 *       输出 dist/feed/{stable,versions}/<channel>/… 树（含 shell/ 占位空目录）+ RELEASE-NOTES.md
 *
 * 依赖的 src/main/hot 契约（HOT-UPDATE-IMPL-DESIGN.md §5.1；如签名不符，脚本以明确诊断退出）：
 *   - src/main/hot/zip.ts:      createZipStore(entries: Array<{ path: string; data: Uint8Array | Buffer }>): Uint8Array | Buffer
 *       path = zip 内相对路径（含 out/ 前缀）；store-only 不压缩。§5.1 staging 反向解包使用同一模块族。
 *   - src/main/hot/canonical.ts: canonicalJson(value: unknown): string
 *       = 递归按键名 UTF-8 字节序排序、剔除 undefined、JSON.stringify（§2.3）
 *   - src/main/hot/verifier.ts:  sha256File(path: string): string
 *       verifyManifest(manifestPath, channel, gate: { mainVersion: string; shellVersion: string })
 *         → { ok: true, manifest } | { ok: false, reason }   （§2.3 验签 API）
 *   - src/main/hot/trust.ts:     信任锚支持 env AGENTDECK_HOT_TRUST_HEX="<keyId>:<pubHex>[,<keyId>:<pubHex>…]" 注入（自检用）
 *
 * 用法：
 *   node scripts/release-hot.mjs [--channel renderer|payload|both] [--seq N] [--key-id ID] [--skip-build]
 *   默认 --channel both --seq 1 --key-id ad-<YYYY-MM>（§9.5 keyId 历法）
 *   私钥二选一（都没有 → 明确报错并给出 node:crypto 生成方式）：
 *     env HOT_SIGNING_KEY      = PKCS#8 PEM 私钥全文（CI secret）
 *     env HOT_SIGNING_KEY_PATH = PEM 私钥文件路径
 *
 * 产物（§6.2）：
 *   dist/feed/stable/<channel>/{manifest.json, <channel>-<ver>.zip}          # 定点入口（服务器回滚=旧版 manifest 覆盖）
 *   dist/feed/versions/<channel>/<ver>/{manifest.json, <channel>-<ver>.zip}  # 全量历史（不可变，审计）
 *   dist/feed/stable/shell/ + dist/feed/versions/shell/                       # L0 阶段 4 占位空目录
 *   dist/feed/RELEASE-NOTES.md
 */
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'

const root = path.resolve(import.meta.dirname, '..')
const FEED_ROOT = path.join(root, 'dist', 'feed')

function fail(msg) {
  throw new Error(msg)
}

// ---------- 参数 ----------
function parseArgs(argv) {
  const args = { channel: 'both', seq: 1, keyId: null, skipBuild: false }
  const take = (name, i) => {
    if (argv[i].startsWith(`${name}=`)) return [argv[i].slice(name.length + 1), i]
    const v = argv[i + 1]
    if (v === undefined) fail(`--${name} 缺参数值（--help 查看用法）`)
    return [v, i + 1]
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') {
      console.log(`release-hot.mjs — 热更发布产物生成器（docs/HOT-UPDATE-IMPL-DESIGN.md §6.2）

用法: node scripts/release-hot.mjs [选项]
  --channel <renderer|payload|both>   通道（默认 both；renderer 只取 out/renderer/**，payload 取 §6.1 全清单）
  --seq <N>                           热更序号 n → version = <package.json 版本>-hot.<n>（默认 1）
  --key-id <ID>                       manifest keyId（默认 ad-<YYYY-MM>，§9.5）
  --skip-build                        跳过 npm run build（out/ 已是最新时）

私钥来源（二选一，均无 → 报错并给出 node:crypto generateKeyPairSync('ed25519') 生成方式）：
  env HOT_SIGNING_KEY      = PKCS#8 PEM 私钥全文（CI secret）
  env HOT_SIGNING_KEY_PATH = PEM 私钥文件路径`)
      process.exit(0)
    } else if (a === '--channel') { const [v, j] = take('channel', i); args.channel = v; i = j }
    else if (a.startsWith('--channel=')) args.channel = a.slice('--channel='.length)
    else if (a === '--seq') { const [v, j] = take('seq', i); args.seq = v; i = j }
    else if (a.startsWith('--seq=')) args.seq = a.slice('--seq='.length)
    else if (a === '--key-id') { const [v, j] = take('key-id', i); args.keyId = v; i = j }
    else if (a.startsWith('--key-id=')) args.keyId = a.slice('--key-id='.length)
    else if (a === '--skip-build') args.skipBuild = true
    else fail(`未知参数: ${a}（--help 查看用法）`)
  }
  if (!['renderer', 'payload', 'shell', 'both'].includes(args.channel)) {
    fail(`--channel 只能是 renderer|payload|shell|both，收到: ${args.channel}`)
  }
  const seq = Number(args.seq)
  if (!Number.isInteger(seq) || seq < 1) fail(`--seq 必须是 ≥1 的整数，收到: ${args.seq}`)
  args.seq = seq
  if (args.keyId !== null && !String(args.keyId).trim()) fail('--key-id 不能为空')
  return args
}

// ---------- 构建 ----------
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

function npmRunBuild() {
  console.log('[step] npm run build …')
  const status = runNpm(['run', 'build'])
  if (status !== 0) fail(`npm run build 失败（退出码 ${status}）— 修复构建问题后重试`)
}

// ---------- 私钥 ----------
function loadSigningKey() {
  const fromEnv = process.env.HOT_SIGNING_KEY
  const fromPath = process.env.HOT_SIGNING_KEY_PATH
  let pem = null
  let source = null
  if (fromEnv && fromEnv.trim()) {
    pem = fromEnv.trim()
    source = 'env HOT_SIGNING_KEY'
  } else if (fromPath) {
    try {
      pem = fs.readFileSync(fromPath, 'utf8').trim()
    } catch (e) {
      fail(`读取 HOT_SIGNING_KEY_PATH=${fromPath} 失败: ${e.message}`)
    }
    source = `env HOT_SIGNING_KEY_PATH (${fromPath})`
  } else {
    fail(`未提供签名私钥。请二选一：
  env HOT_SIGNING_KEY="<PKCS#8 PEM 全文>"   （CI secret）
  env HOT_SIGNING_KEY_PATH="<PEM 文件路径>"  （本地文件）

生成方式（node:crypto，离线执行；公钥 raw hex 进 src/main/hot/trust.ts，私钥绝不进仓库 — §9.5）：
  node -e "const {generateKeyPairSync}=require('node:crypto');const {publicKey,privateKey}=generateKeyPairSync('ed25519');console.log('---private PKCS#8 PEM---');console.log(privateKey.export({type:'pkcs8',format:'pem'}));console.log('---public raw hex---');console.log(Buffer.from(publicKey.export({format:'jwk'}).x,'base64url').toString('hex'))"`)
  }
  let key
  try {
    key = crypto.createPrivateKey(pem)
  } catch (e) {
    fail(`解析私钥失败（${source}）: ${e.message} — 期望 PKCS#8 PEM 全文`)
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    fail(`私钥类型必须是 ed25519，实际: ${key.asymmetricKeyType}（Ed25519 是 manifest 验签的唯一算法，§2.3）`)
  }
  return { key, source }
}

/** Ed25519 公钥 raw 32 字节 hex（jwk.x = base64url 公钥） */
function pubKeyHex(privateKey) {
  const jwk = privateKey.export({ format: 'jwk' })
  return Buffer.from(jwk.x, 'base64url').toString('hex')
}

// ---------- esbuild 打包依赖模块（模式照 scripts/smoke-migration.mjs） ----------
async function bundleTs(entryRel, outRel) {
  const entry = path.join(root, entryRel)
  if (!fs.existsSync(entry)) {
    fail(`依赖模块缺失: ${entryRel} — hot 模块族（HOT-UPDATE-IMPL-DESIGN.md §5.1）尚未落地或路径已改，本脚本无法运行`)
  }
  const outfile = path.join(root, outRel)
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['electron'],
    logLevel: 'silent'
  })
  return await import(pathToFileURL(outfile).href)
}

// ---------- 组装（§6.1） ----------
function walkFiles(dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walkFiles(p))
    else if (e.isFile()) out.push(p)
  }
  return out
}

/** 壳通道打包：electron-builder --dir 到 dist/.shell-pack（旁路输出，避免占用 release/win-unpacked） */
function packShellDir() {
  const packRoot = path.join(root, 'dist', '.shell-pack')
  const packDir = path.join(packRoot, 'win-unpacked')
  if (process.env.RELEASE_HOT_SKIP_PACK === '1' && fs.existsSync(path.join(packDir, 'AgentDeck.exe'))) {
    console.log(`[step] shell: RELEASE_HOT_SKIP_PACK=1 且 ${path.relative(root, packDir)} 存在，跳过打包`)
    return packDir
  }
  console.log('[step] shell: electron-builder --dir（产出 dist/.shell-pack/win-unpacked）…')
  const r = spawnSync('npx', ['electron-builder', '--dir', `--config.directories.output=${path.join('dist', '.shell-pack')}`], { cwd: root, stdio: 'inherit', shell: true })
  if (r.status !== 0 || !fs.existsSync(path.join(packDir, 'AgentDeck.exe'))) {
    fail('electron-builder --dir 失败或产物缺失（dist/.shell-pack/win-unpacked/AgentDeck.exe）— 见上方输出')
  }
  return packDir
}

/** 载荷 zip 文件集合 ≡ electron-builder 打进 asar 的文件集合（§6.1 对齐规则） */
function collectChannelFiles(channel) {
  const files = [] // { src, zipPath }
  const addDir = (sub, zipPrefix) => {
    const dir = path.join(root, 'out', sub)
    if (!fs.existsSync(dir)) fail(`构建产物缺失: out/${sub}/ — npm run build 未产出`)
    const found = walkFiles(dir)
    if (found.length === 0) fail(`构建产物为空: out/${sub}/ — npm run build 未产出`)
    for (const p of found) {
      files.push({ src: p, zipPath: zipPrefix + path.relative(dir, p).split(path.sep).join('/') })
    }
  }
  if (channel === 'payload') {
    addDir('main', 'out/main/')
    addDir('preload', 'out/preload/')
    addDir('renderer', 'out/renderer/')
    files.push({ src: path.join(root, 'package.json'), zipPath: 'package.json' })
    const icon = path.join(root, 'build', 'icon.png')
    if (!fs.existsSync(icon)) fail('build/icon.png 缺失 — §6.1 载荷清单要求（src/main/index.ts:80 窗口图标相对路径依赖）')
    files.push({ src: icon, zipPath: 'build/icon.png' })
    if (!files.some((f) => f.zipPath === 'out/main/bootstrap.js')) {
      console.warn('[warn] out/main/bootstrap.js 缺失 — bootstrap 入口（阶段 0.4/0.5）尚未落地；载荷 zip 将不含它（与当前 asar 内容一致），热更引导不随载荷分发')
    }
  } else if (channel === 'shell') {
    // 壳 zip = 便携分发物：解压即应用目录（exe 在 zip 根），与 staging rename dance 布局一致（§5）
    const packDir = packShellDir()
    for (const p of walkFiles(packDir)) {
      files.push({ src: p, zipPath: path.relative(packDir, p).split(path.sep).join('/') })
    }
    if (!files.some((f) => f.zipPath === 'AgentDeck.exe')) fail('壳打包产物缺 AgentDeck.exe — zip 布局要求 exe 在根')
  } else {
    // renderer 通道只取 out/renderer/**（§6.1：zip 内同样带 out/ 前缀，版本目录路径与载荷布局同构）
    addDir('renderer', 'out/renderer/')
  }
  files.sort((a, b) => (a.zipPath < b.zipPath ? -1 : a.zipPath > b.zipPath ? 1 : 0))
  return files
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/** store-only zip 自检：按本地文件头顺序解出全部条目并与源文件逐字节比对（纯 node 内置，零依赖） */
function verifyStoreZip(buf, files) {
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) return 'zip 无本地文件头（PK\\x03\\x04）'
  const seen = new Map()
  let off = 0
  while (off + 30 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
    const method = buf.readUInt16LE(off + 8)
    const compLen = buf.readUInt32LE(off + 18)
    const nameLen = buf.readUInt16LE(off + 26)
    const extraLen = buf.readUInt16LE(off + 28)
    const name = buf.slice(off + 30, off + 30 + nameLen).toString('utf8')
    const dataStart = off + 30 + nameLen + extraLen
    if (dataStart + compLen > buf.length) return `条目 ${name} 数据越界`
    if (method !== 0) return `条目 ${name} 使用了压缩（method=${method}），要求 store-only`
    seen.set(name, buf.slice(dataStart, dataStart + compLen))
    off = dataStart + compLen
  }
  for (const f of files) {
    const got = seen.get(f.path)
    if (!got) return `zip 缺条目: ${f.path}`
    if (!got.equals(Buffer.from(f.data))) return `zip 条目内容与源文件不一致: ${f.path}`
  }
  return null
}

// ---------- 单通道流水线 ----------
async function buildChannel(channel, ctx) {
  const { pkg, keyId, privKey, pubHex, seq } = ctx
  // 壳通道版本 = 基座版本（不带 -hot 后缀）：壳更新就是新基座；带 -hot 会造成「内容相同但
  // 版本串不同」的假更新（客户端与 feed 各执一词，反复诱导 314MB 空下载）。发壳前必须 bump package.json。
  const version = channel === 'shell' ? pkg.version : `${pkg.version}-hot.${seq}`
  const files = collectChannelFiles(channel)
  console.log(`[step] ${channel}: 组装 ${files.length} 个文件（§6.1 清单）`)
  const entries = files.map((f) => ({ path: f.zipPath, data: fs.readFileSync(f.src) }))
  const filesMeta = entries.map((e) => ({ path: e.path, sha256: sha256Hex(e.data), size: e.data.length }))

  let zipBuf
  try {
    zipBuf = ctx.zip.createZipStore(entries)
  } catch (e) {
    fail(`调用 createZipStore(entries) 失败: ${e.message}\n本脚本假定的契约（见文件头注释）: createZipStore(entries: Array<{ path: string; data: Uint8Array | Buffer }>) → Uint8Array | Buffer。若 src/main/hot/zip.ts 签名不同，请对齐任一侧。`)
  }
  if (!(zipBuf instanceof Uint8Array)) fail(`createZipStore 返回类型异常（${zipBuf === null ? 'null' : typeof zipBuf}）— 期望 Uint8Array/Buffer`)
  zipBuf = Buffer.from(zipBuf)
  const zipErr = verifyStoreZip(zipBuf, entries)
  if (zipErr) fail(`zip 产物自检不过: ${zipErr}（src/main/hot/zip.ts 需产出 store-only zip）`)

  const artifact = { name: `${channel}-${version}.zip`, sha256: sha256Hex(zipBuf), size: zipBuf.length }
  const payloadBlock = {
    schemaVersion: 1,
    channel,
    version,
    // 底线 = 首个具备热更链能力的壳（0.18.2，bootstrap 指针加载链诞生版）。
    // 不能写 pkg.version：旧比较器把 0.21.0-hot.4 判低于 0.21.0，会把已装 -hot 载荷的客户端困死。
    minMainVersion: '0.18.2',
    minShellVersion: '0.18.2',
    releaseDate: new Date().toISOString(),
    keyId,
    artifact,
    files: filesMeta
  }
  let canonical
  try {
    canonical = ctx.canonical.canonicalJson(payloadBlock)
  } catch (e) {
    fail(`canonicalJson(payload) 失败: ${e.message} — 检查 src/main/hot/canonical.ts（§2.3 规范化规则）`)
  }
  const signature = crypto.sign(null, Buffer.from(canonical, 'utf8'), privKey).toString('base64')
  const manifest = { payload: payloadBlock, signature }
  const manifestJson = JSON.stringify(manifest, null, 2) + '\n'

  // ---- 自检（先落 staging，全过才进 feed 树，坏产物不进 stable/versions）----
  const staging = path.join(root, 'dist', `.hot-staging-${Date.now()}-${channel}`)
  fs.mkdirSync(staging, { recursive: true })
  try {
    const stagingManifest = path.join(staging, 'manifest.json')
    fs.writeFileSync(stagingManifest, manifestJson)
    fs.writeFileSync(path.join(staging, artifact.name), zipBuf)

    // ① verifier 回读验签（AGENTDECK_HOT_TRUST_HEX 注入临时信任锚，防"签出来就是坏的"）
    let vr
    try {
      vr = ctx.verifier.verifyManifest(stagingManifest, channel, { mainVersion: pkg.version, shellVersion: pkg.version })
    } catch (e) {
      fail(`自检 verifyManifest 抛错: ${e.message} — 期望签名 verifyManifest(manifestPath, channel, gate: { mainVersion, shellVersion }): { ok: true, manifest } | { ok: false, reason }（§5.1）`)
    }
    if (!vr || vr.ok !== true) {
      fail(`自检验签未过: ${vr && vr.reason ? vr.reason : JSON.stringify(vr)} — 签出的 manifest 无法被 verifier 回读验证（keyId=${keyId}，公钥 ${pubHex.slice(0, 16)}…）。检查 keyId/公钥是否与 src/main/hot/trust.ts 一致、canonicalJson 双方是否同一实现`)
    }
    // ② files[] 逐文件复核（从源文件重算，防"清单与内容不符"出库）
    for (const f of filesMeta) {
      const src = files.find((x) => x.zipPath === f.path)
      if (!src) fail(`自检: manifest.files 含未组装路径 ${f.path}`)
      const data = fs.readFileSync(src.src)
      if (sha256Hex(data) !== f.sha256 || data.length !== f.size) fail(`自检: files[] 与源文件不符 ${f.path}`)
    }
    // ③ artifact 整体 sha256 复核
    if (sha256Hex(zipBuf) !== artifact.sha256) fail('自检: artifact.sha256 与 zip 字节不符')
    console.log(`[ok] ${channel} 自检通过：verifier 验签 ✓ / files[] ${filesMeta.length} 项复核 ✓ / store-zip 解包复核 ✓`)

    // ---- 发布到 feed 树（§6.2）----
    const stableDir = path.join(FEED_ROOT, 'stable', channel)
    const verDir = path.join(FEED_ROOT, 'versions', channel, version)
    fs.mkdirSync(stableDir, { recursive: true })
    fs.mkdirSync(verDir, { recursive: true })
    const verManifestPath = path.join(verDir, 'manifest.json')
    if (fs.existsSync(verManifestPath)) {
      // 版本历史不可变（§6.3 审计）：version → 产物字节 的绑定不得改写（releaseDate/签名允许随密钥与时间漂移，字节绑定是硬约束）
      let sameArtifact = false
      try {
        const old = JSON.parse(fs.readFileSync(verManifestPath, 'utf8'))
        sameArtifact =
          old?.payload?.artifact?.sha256 === artifact.sha256 &&
          old?.payload?.channel === channel &&
          old?.payload?.version === version &&
          old?.payload?.keyId === keyId
      } catch {
        sameArtifact = false
      }
      if (!sameArtifact) fail(`versions/${channel}/${version} 已存在且绑定不同产物 — 版本历史不可变（§6.3 审计）；请用 --seq 递增版本号`)
      console.log(`[note] versions/${channel}/${version} 已存在且产物一致（幂等重跑）`)
    }
    for (const [dst, content] of [
      [path.join(stableDir, 'manifest.json'), manifestJson],
      [path.join(stableDir, artifact.name), zipBuf],
      [verManifestPath, manifestJson],
      [path.join(verDir, artifact.name), zipBuf]
    ]) {
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      const tmp = `${dst}.tmp`
      fs.writeFileSync(tmp, content)
      fs.renameSync(tmp, dst)
    }
    console.log(`[ok] ${channel} ${version} → dist/feed/stable/${channel}/ + dist/feed/versions/${channel}/${version}/`)
    return {
      channel,
      version,
      keyId,
      artifact,
      filesMeta,
      releaseDate: payloadBlock.releaseDate,
      fileCountByTop: countByTop(files)
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

function countByTop(files) {
  const m = new Map()
  for (const f of files) {
    const segs = f.zipPath.split('/')
    const top = segs.length > 1 ? segs[0] + '/' : segs[0]
    m.set(top, (m.get(top) || 0) + 1)
  }
  return Object.fromEntries([...m.entries()].sort())
}

// ---------- RELEASE-NOTES ----------
function writeReleaseNotes(results) {
  const lines = []
  lines.push('# AgentDeck 热更发布摘要（RELEASE-NOTES）')
  lines.push('')
  lines.push(`- 生成: ${new Date().toISOString()}（scripts/release-hot.mjs，docs/HOT-UPDATE-IMPL-DESIGN.md §6.2）`)
  lines.push('- 客户端定点入口: `stable/<channel>/manifest.json`；服务端回滚 = 用 `versions/<channel>/<ver>/manifest.json` 覆盖定点文件（§6.3）')
  lines.push('')
  for (const r of results) {
    lines.push(`## ${r.channel} ${r.version}`)
    lines.push('')
    lines.push(`- channel: \`${r.channel}\``)
    lines.push(`- artifact: \`${r.artifact.name}\`（${r.artifact.size} 字节，sha256 \`${r.artifact.sha256}\`）`)
    lines.push(`- files: ${r.filesMeta.length} 个（manifest 签名块含逐文件 sha256/size，§2.3；分布 ${JSON.stringify(r.fileCountByTop)}）`)
    lines.push(`- keyId: \`${r.keyId}\`（Ed25519；公钥在 src/main/hot/trust.ts，私钥仅 CI secret — §9.5）`)
    lines.push(`- releaseDate: ${r.releaseDate}`)
    lines.push('- 自检: 发布前已回读验签 + files[] 复核 + zip 解包复核（全过才写树）')
    lines.push(`- 路径: \`stable/${r.channel}/manifest.json\`、\`versions/${r.channel}/${r.version}/\``)
    lines.push('')
  }
  lines.push('## shell')
  lines.push('')
  lines.push('`stable/shell/` 与 `versions/shell/` 为 L0 壳更新占位空目录（阶段 4 前产物为空，§9.3）。')
  lines.push('')
  fs.writeFileSync(path.join(FEED_ROOT, 'RELEASE-NOTES.md'), lines.join('\n'))
}

// ---------- main ----------
async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.skipBuild) npmRunBuild()
  const { key: privKey, source } = loadSigningKey()
  const pubHex = pubKeyHex(privKey)
  const keyId = args.keyId || `ad-${new Date().toISOString().slice(0, 7)}`
  console.log(`[step] 签名密钥: ${source}（ed25519，公钥 ${pubHex.slice(0, 16)}…，keyId=${keyId}）`)

  const [zipMod, canonicalMod] = await Promise.all([
    bundleTs('src/main/hot/zip.ts', 'out/.release-hot-zip.cjs'),
    bundleTs('src/main/hot/canonical.ts', 'out/.release-hot-canonical.cjs')
  ])
  for (const [name, mod, key] of [
    ['src/main/hot/zip.ts', zipMod, 'createZipStore'],
    ['src/main/hot/canonical.ts', canonicalMod, 'canonicalJson']
  ]) {
    if (typeof mod[key] !== 'function') fail(`${name} 缺导出 ${key} — 与本脚本契约不符（见文件头注释）`)
  }
  // verifier 需先注入信任锚再加载（trust.ts 在模块装载时读取 env）
  process.env.AGENTDECK_HOT_TRUST_HEX = `${keyId}:${pubHex}`
  const verifierMod = await bundleTs('src/main/hot/verifier.ts', 'out/.release-hot-verifier.cjs')
  if (typeof verifierMod.verifyManifest !== 'function') fail('src/main/hot/verifier.ts 缺导出 verifyManifest — 与本脚本契约不符（见文件头注释）')

  const ctx = {
    pkg: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')),
    keyId,
    privKey,
    pubHex,
    seq: args.seq,
    zip: zipMod,
    canonical: canonicalMod,
    verifier: verifierMod
  }
  const channels = args.channel === 'both' ? ['renderer', 'payload', 'shell'] : [args.channel]
  const results = []
  for (const ch of channels) results.push(await buildChannel(ch, ctx))
  // 壳 zip 同时是免安装分发渠道产物（§9.2 zip 渠道）：复制一份独立命名到 dist/ 根
  const shellResult = results.find((r) => r.channel === 'shell')
  if (shellResult) {
    const portable = path.join(root, 'dist', 'agentdeck-' + ctx.pkg.version.replace(/^v/, '') + '-portable-win-x64.zip')
    fs.copyFileSync(path.join(FEED_ROOT, 'stable', 'shell', shellResult.artifact.name), portable)
    console.log(`[ok] 便携分发包: ${path.relative(root, portable)}（zip 渠道 GA 产物，解压即用）`)
  }

  // shell 占位空目录（§6.2 / §9.3：L0 阶段 4 前产物为空）
  fs.mkdirSync(path.join(FEED_ROOT, 'stable', 'shell'), { recursive: true })
  fs.mkdirSync(path.join(FEED_ROOT, 'versions', 'shell'), { recursive: true })
  writeReleaseNotes(results)

  console.log('\n[ok] RELEASE DONE')
  for (const r of results) {
    console.log(`  ${r.channel}: ${r.version}  keyId=${r.keyId}  ${r.artifact.name} (${r.artifact.size} B, ${r.filesMeta.length} files)`)
  }
  console.log(`  feed 树: ${path.relative(root, FEED_ROOT)}（stable/ + versions/ + shell/ 占位 + RELEASE-NOTES.md）`)
}

main().catch((e) => {
  console.error(`[FAIL] ${e && e.stack ? e.stack : e}`)
  process.exit(1)
})
