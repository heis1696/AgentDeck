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
 *     .part 保留且累计在 1MB–1.5MB（每次尝试都从上次磁盘实况继续 = 残件即进度；abort 路径
 *     destroy 丢弃写流缓冲尾块属残件语义允许，预言机取区间防 RST/destroy 竞态抖动）
 *   E 挂起 read 兜底：mock fetch 提供确定性永挂起的 read()（abort 传播失灵的极端竞态模拟），
 *     经 setReadStallGuardForTest 缩短读守卫时限后直证 45s 兜底路径——三重试全部由守卫拒绝
 *    （签名文案 abort 传播失灵兜底，而非 30s 空闲 abort）、每次守卫都 cancel 响应流、
 *     总耗时被守卫钉死（不挂到 undici bodyTimeout 300s）、.part 保留、无 uncaughtException
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
const { downloadArtifact, FeedError, setReadStallGuardForTest } = await import(pathToFileURL(outfile).href)

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
  // 三次尝试每次都从上次残件实况续 512KB；写流缓冲里未落盘的尾块（至多一两个 64KB 块）
  // 会随 abort 路径的 destroy 丢弃——残件语义允许（续传从磁盘实况出发），预言机取区间
  // 而非精确字节（精确预言机在 RST 掐断与 destroy 的竞态下时序抖动）
  ok(partSize >= 2 * 512 * 1024 && partSize <= 3 * 512 * 1024,
    `三次尝试残件累计在 1MB–1.5MB（实际 ${partSize}；每次尝试都从上次磁盘实况继续 = 残件即进度）`)
  // 残件确实可续：换一台不掐的服务器接着同一 dest 下，应从磁盘实况精确续传补齐剩余字节
  closeServer()
  const artifact2 = artifact
  const { url: url2, requests } = await startServer(artifact2, { supportRange: true })
  await downloadArtifact(url2, 'shell', 'big.bin', dest)
  ok(requests.length === 1 && requests[0] === `bytes=${partSize}-`, `换服务器后单连接从残件实况 ${partSize} 精确续传`)
  ok(sha256(fs.readFileSync(dest)) === sha256(artifact), '续传完成后 sha256 与原件一致')
  closeServer()
}

// ---------- E 挂起 read 兜底：45s 读守卫直证（缩短钩子 + 确定性永挂起流） ----------
{
  console.log('[scenario] E 挂起 read 兜底：三重试由读守卫拒绝并 cancel（abort 传播失灵模拟）')
  // 确定性「abort 后 read 永不返回」：底层源 pull 永不 enqueue/关闭，read() 无限挂起——
  // 真实现场里这是 undici 未把 abort 信号传播进挂起 read() 的极端竞态（挂到 bodyTimeout 300s）；
  // mock 流把该竞态变成必现，30s 空闲 abort 也不会先到（fetch 被整体 mock，无连接可断）
  const GUARD_MS = 250
  setReadStallGuardForTest(GUARD_MS)
  const cancelCalls = []
  const fetchCalls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => {
    fetchCalls.push(1)
    return new Response(new ReadableStream({
      pull() { /* 永挂起：绝不 enqueue、绝不 close */ },
      cancel(reason) { cancelCalls.push(String(reason?.message ?? '')) }
    }))
  }
  const destE = path.join(work, 'artifact', 'never.bin')
  const t0 = Date.now()
  let rejected = null
  try {
    await downloadArtifact('http://mock.invalid/shell/never.bin', 'shell', 'never.bin', destE)
  } catch (error) {
    rejected = error
  } finally {
    globalThis.fetch = realFetch
    setReadStallGuardForTest(undefined) // 复位默认 45s，不留测试态
  }
  const elapsed = Date.now() - t0
  ok(rejected instanceof FeedError && rejected.message.includes('abort 传播失灵兜底'),
    `拒绝为读守卫签名（实际 ${rejected?.constructor?.name ?? 'null'}: ${rejected?.message ?? 'null'}）`)
  ok(!rejected.message.includes('30 秒无数据'), '拒绝不来自 30s 空闲 abort（守卫路径而非空闲路径）')
  ok(fetchCalls.length === 3, `三重试各自发起 fetch（实际 ${fetchCalls.length} 次）`)
  ok(cancelCalls.length === 3, `守卫每次拒绝都 cancel 响应流（实际 ${cancelCalls.length} 次）`)
  ok(elapsed >= GUARD_MS * 3, `守卫确有等待才拒绝（总耗时 ${elapsed}ms ≥ 3×${GUARD_MS}ms）`)
  ok(elapsed < 15_000, `守卫钉死等待上界：总耗时 ${elapsed}ms（默认守卫三重试 ≥138s、undici bodyTimeout 300s——挂起即超标）`)
  ok(fs.existsSync(destE + '.part') && fs.statSync(destE + '.part').size === 0, '.part 保留且 0 字节（失败不删 = 残件即进度，从未收到字节）')
  ok(!fs.existsSync(destE), 'dest 未落盘（没有任何字节可 rename）')
  ok(uncaught === null, `无 uncaughtException（race 落选 read 的迟到决议被消化）${uncaught ? `（收到：${uncaught.message}）` : ''}`)
}

// ---------- 收尾 ----------
console.log('')
if (failed > 0 || uncaught !== null) {
  keepScene = true
  console.error(`[FAIL] SMOKE HOT FEED: ${failed} 项断言失败 — 现场保留：${work}`)
  process.exit(1)
}
console.log('[ok] SMOKE HOT FEED: 续传/兜底/重置/流加固 全部通过')
