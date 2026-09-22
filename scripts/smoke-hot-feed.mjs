#!/usr/bin/env node
/**
 * scripts/smoke-hot-feed.mjs — feed 下载面冒烟：断点续传 / 无 Range 兜底 / 416 重置 / 流错误不炸主进程
 *
 * 现场回归（本 smoke 固化的缺陷，2026-09-22 v0.23.0 壳包 446MB 拉不动 + "A JavaScript error
 * occurred in the main process" 弹窗，客户端 pid 15380 弹窗原文 EPERM open …\.download-*.zip.part）：
 *   ① 30min 总时长帽把慢链路大包反复腰斩，且每次失败删 .part 从零重下 → 数学上永远下不完
 *      （实测服务器 ~200KB/s，446MB ≈ 37min；hot-shell 目录积了 19 个半截 .part ≈ 480MB）。
 *      修复后：无总帽（只留 30s 停滞中止）+ Range 断点续传，残件即进度，跨尝试/跨 apply 复用。
 *   ② downloadOnce 的 WriteStream 无 error 监听、abort 路径句柄不关 → 重试 open/unlink 撞
 *      Windows 文件锁 EPERM，错误以未处理 'error' 事件冒泡成 uncaughtException 主进程弹窗。
 *      修复后：流全程挂监听 + finally destroy 等 close，任何失败都可重试不弹窗。
 *
 * 断言（直连 src/main/hot/feed.ts 的 downloadArtifact，本地 http 服务器注入故障）：
 *   A Range 续传：第一连接发 1MB 后被服务端掐断 → 重试带 Range: bytes=1MB- 续传到完成，sha 对
 *   B 无 Range 服务端：无视 Range 回 200 全量 → 客户端必须弃残件重下（append 全量=必坏包），sha 对
 *   C 416 重置：残件比产物还长 → 服务端 416 → 客户端重置残件从头下，sha 对
 *   D 连续掐断：三次尝试每次发 512KB 被掐 → downloadArtifact 拒绝但进程存活（无 uncaughtException），
 *     .part 保留且恰为 3×512KB（每次尝试都从上次的字节继续 = 残件即进度）
 *
 * 隔离铁律：os.tmpdir 临时目录 + 127.0.0.1 本地服务器；不写 src/、不碰真实 userData 与线上 feed。
 */
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')

let failed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? '[ok]' : '[FAIL]'} ${msg}`)
  if (!cond) failed++
}
const note = (msg) => console.log(`  [info] ${msg}`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')

// 进程级哨兵：修复前流错误走 uncaughtException（本 smoke 直接崩）；挂监听兜住改为显式断言
let uncaught = null
process.on('uncaughtException', (error) => {
  uncaught = error
})

// ---------- 临时工作区（失败保留现场） ----------
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-smoke-hot-feed-'))
let keepScene = false
let server = null
process.on('exit', () => {
  try {
    server?.close()
    server?.closeAllConnections?.()
  } catch { /* 关闭失败不影响结论 */ }
  if (!keepScene) {
    try {
      fs.rmSync(work, { recursive: true, force: true })
    } catch { /* 占用中：留给系统临时目录清理 */ }
  }
})

// ---------- 直连 src（esbuild 同 smoke-hot-updater.mjs 手法；不在 src 内新增任何导出） ----------
const outfile = path.join(work, 'feed.cjs')
await build({
  entryPoints: [path.join(root, 'src/main/hot/feed.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  logLevel: 'silent'
})
const { downloadArtifact } = await import(pathToFileURL(outfile).href)

// ---------- 可注入故障的本地 Range 服务器 ----------
/**
 * artifact: 全量字节；supportRange: 是否实现 206；killAfterBytes: 每个连接发送这么多字节后掐断
 * （null = 不掐）；rangeFirstRequestOnly 留作扩展。返回 { server, url, requests }。
 * requests 记录每个连接的 range 头，供续传断言回看。
 */
async function startServer(artifact, { supportRange = true, killAfterBytes = null } = {}) {
  const requests = []
  const srv = http.createServer((req, res) => {
    const rangeHeader = req.headers.range ?? null
    requests.push(rangeHeader)
    let start = 0
    if (supportRange && rangeHeader) {
      const m = /^bytes=(\d+)-$/.exec(rangeHeader)
      if (!m) {
        res.writeHead(400)
        res.end()
        return
      }
      start = Number(m[1])
      if (start >= artifact.length) {
        res.writeHead(416, { 'content-range': `bytes */${artifact.length}` })
        res.end()
        return
      }
      res.writeHead(206, {
        'content-length': String(artifact.length - start),
        'content-range': `bytes ${start}-${artifact.length - 1}/${artifact.length}`
      })
    } else {
      res.writeHead(200, { 'content-length': String(artifact.length) })
    }
    let sent = 0
    const pump = () => {
      if (res.destroyed) return
      if (killAfterBytes !== null && sent >= killAfterBytes) {
        res.destroy() // 模拟链路中断：不 fin 直接 RST
        return
      }
      const chunk = artifact.subarray(start + sent, start + sent + 64 * 1024)
      if (chunk.length === 0) {
        res.end()
        return
      }
      sent += chunk.length
      res.write(chunk)
      setImmediate(pump)
    }
    pump()
  })
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  server = srv
  return { srv, url: `http://127.0.0.1:${srv.address().port}`, requests }
}

const closeServer = () => {
  try {
    server?.close()
    server?.closeAllConnections?.()
  } catch { /* 幂等 */ }
  server = null
}

const dest = path.join(work, 'artifact', 'big.bin')
const partOf = (n) => dest + '.part'

// ---------- A Range 续传 ----------
{
  console.log('[scenario] A Range 续传：1MB 掐断 → Range 续传到完成')
  const artifact = crypto.randomBytes(3 * 1024 * 1024)
  const { url, requests } = await startServer(artifact, { supportRange: true, killAfterBytes: 1024 * 1024 })
  await downloadArtifact(url, 'shell', 'big.bin', dest)
  ok(requests.length >= 2, `掐断后续传：服务端收到 ${requests.length} 个连接（≥2）`)
  ok(requests[0] === null, '首连接不带 Range（从零下）')
  ok(requests[1] === 'bytes=1048576-', `重连带精确 Range（实际 ${JSON.stringify(requests[1])}）`)
  ok(!fs.existsSync(dest + '.part'), '完成后 .part 已 rename 为 dest')
  ok(sha256(fs.readFileSync(dest)) === sha256(artifact), '拼接后的完整产物 sha256 与原件一致')
  closeServer()
}

// ---------- B 无 Range 服务端 ----------
{
  console.log('[scenario] B 无 Range 服务端：200 全量 → 弃残件重下（不 append）')
  const artifact = crypto.randomBytes(2 * 1024 * 1024)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest + '.part', crypto.randomBytes(1024 * 1024)) // 假残件：内容与产物无关
  const { url, requests } = await startServer(artifact, { supportRange: false })
  await downloadArtifact(url, 'shell', 'big.bin', dest)
  ok(requests.length === 1 && requests[0] === 'bytes=1048576-', '残件在：客户端先试 Range，服务端回 200 无视（单连接完成）')
  ok(sha256(fs.readFileSync(dest)) === sha256(artifact), '200 全量重写而非 append：sha256 与原件一致')
  closeServer()
}

// ---------- C 416 重置 ----------
{
  console.log('[scenario] C 416 重置：残件超长 → 重置后从头下')
  const artifact = crypto.randomBytes(128 * 1024)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest + '.part', crypto.randomBytes(256 * 1024)) // 超出产物大小
  const { url, requests } = await startServer(artifact, { supportRange: true })
  await downloadArtifact(url, 'shell', 'big.bin', dest)
  ok(requests.some((r) => r !== null), '先尝试了 Range（触发 416）')
  ok(sha256(fs.readFileSync(dest)) === sha256(artifact), '重置重下后 sha256 与原件一致')
  closeServer()
}

// ---------- D 连续掐断：拒绝但进程存活、残件即进度 ----------
{
  console.log('[scenario] D 三连掐断：downloadArtifact 拒绝、无 uncaughtException、.part 保留续传')
  const artifact = crypto.randomBytes(4 * 1024 * 1024)
  const { url } = await startServer(artifact, { supportRange: true, killAfterBytes: 512 * 1024 })
  let rejected = null
  await downloadArtifact(url, 'shell', 'big.bin', dest).catch((error) => {
    rejected = error
  })
  ok(rejected instanceof Error, `downloadArtifact 以 Error 拒绝（${rejected?.message ?? 'null'}）`)
  ok(uncaught === null, `无 uncaughtException 冒泡${uncaught ? `（收到：${uncaught.message}）` : ''}`)
  const part = dest + '.part'
  ok(fs.existsSync(part), '.part 保留（残件即进度，不删）')
  const partSize = fs.existsSync(part) ? fs.statSync(part).size : 0
  ok(partSize === 3 * 512 * 1024, `三次尝试各续 512KB → .part 恰为 1.5MB（实际 ${partSize}）`)
  // 残件确实可续：换一台不掐的服务器接着同一 dest 下，应只补剩余字节
  closeServer()
  const artifact2 = artifact
  const { url: url2, requests } = await startServer(artifact2, { supportRange: true })
  await downloadArtifact(url2, 'shell', 'big.bin', dest)
  ok(requests.length === 1 && requests[0] === 'bytes=1572864-', '换服务器后单连接从 1.5MB 精确续传')
  ok(sha256(fs.readFileSync(dest)) === sha256(artifact), '续传完成后 sha256 与原件一致')
  closeServer()
}

// ---------- 收尾 ----------
console.log('')
if (failed > 0 || uncaught !== null) {
  keepScene = true
  console.error(`[FAIL] SMOKE HOT FEED: ${failed} 项断言失败 — 现场保留：${work}`)
  process.exit(1)
}
console.log('[ok] SMOKE HOT FEED: 续传/兜底/重置/流加固 全部通过')
