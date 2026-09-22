// feed 拉取（设计 §5.1）：manifest 定点入口 + artifact 下载；超时 + 3 次退避重试。
// 无第三方依赖：Electron 33（Node 20+）自带全局 fetch。
import fs from 'node:fs'
import path from 'node:path'
import type { HotManifestPayload } from './verifier'

const RETRY_DELAYS_MS = [1_000, 2_000, 4_000]
const REQUEST_TIMEOUT_MS = 20_000

export interface FetchedManifest {
  /** manifest.json 拉取时的字节原文（staging 落盘用，保证指针 manifestSha256 与验签对象一致） */
  manifestBytes: Buffer
  payload: HotManifestPayload
}

export interface DownloadProgress {
  receivedBytes: number
  totalBytes: number
}

const trimBase = (baseUrl: string) => baseUrl.replace(/\/+$/, '')

async function fetchWithRetry(url: string, attempts = 3): Promise<Response> {
  let lastError: unknown = null
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: 'follow' })
      if (response.ok) return response
      // 4xx（除 429）不重试：服务端明确拒绝，重试无意义
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        throw new FeedError(`HTTP ${response.status} for ${url}`)
      }
      lastError = new FeedError(`HTTP ${response.status} for ${url}`)
    } catch (error) {
      if (error instanceof FeedError && !/HTTP 5|429/.test(error.message)) throw error
      lastError = error
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[i] ?? 4_000))
  }
  throw lastError instanceof Error ? lastError : new FeedError(`fetch failed: ${url}`)
}

export class FeedError extends Error {}

/** 拉取 `<base>/<channel>/manifest.json`（§6.2 定点入口；服务端回滚 = 覆盖此文件）。 */
export async function fetchManifest(baseUrl: string, channel: string): Promise<FetchedManifest> {
  const url = `${trimBase(baseUrl)}/${channel}/manifest.json`
  const response = await fetchWithRetry(url)
  const manifestBytes = Buffer.from(await response.arrayBuffer())
  let root: unknown
  try {
    root = JSON.parse(manifestBytes.toString('utf8'))
  } catch {
    throw new FeedError(`manifest not JSON: ${url}`)
  }
  const payload = (root as { payload?: HotManifestPayload })?.payload
  if (!payload || typeof payload !== 'object' || typeof (root as { signature?: unknown }).signature !== 'string') {
    throw new FeedError(`manifest shape invalid: ${url}`)
  }
  return { manifestBytes, payload }
}

/** 下载 artifact 到 dest（整体 sha256 由调用方核对）。断点续传语义（2026-09-22 现场回归重写）：
 *  - .part 固定为 `<dest>.part` 且失败不删：重试与下一次 apply 都按 Range 从已收字节续传；
 *    服务端不支持 Range（200 全量）时自动弃残件从头下（append 全量会拼出必过不了 sha256 的坏包）。
 *  - 停滞 30s 才中止（按块重置）；不设总时长帽——慢链路大包（实测 446MB 壳包 @ ~200KB/s ≈ 37min）
 *    会被 30min 总帽反复腰斩且残件即进度，删了等于每次归零（0.23.0 壳包 19 个半截 .part 的根因）。
 *  - WriteStream 全程挂 error 监听，finally destroy 并等 close：abort/异常路径句柄若泄漏，
 *    重试的 open/unlink 在 Windows 上 EPERM → 未处理 error 事件以 uncaughtException 冒泡
 *    → 主进程弹 "A JavaScript error occurred"（现场实测弹窗根因，见 .part 残留 + pid 15380）。 */
export async function downloadArtifact(
  baseUrl: string,
  channel: string,
  artifactName: string,
  dest: string,
  onProgress?: (progress: DownloadProgress) => void
): Promise<void> {
  const url = `${trimBase(baseUrl)}/${channel}/${encodeURIComponent(artifactName)}`
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const tmp = `${dest}.part`
  let lastError: unknown = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await downloadOnce(url, tmp, onProgress)
      fs.renameSync(tmp, dest)
      return
    } catch (error) {
      lastError = error
      // .part 保留即进度：续传交给下一次尝试 / 下一次 apply
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt] ?? 4_000))
  }
  throw lastError instanceof Error ? lastError : new FeedError(`download failed: ${url}`)
}

const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000

async function downloadOnce(url: string, tmp: string, onProgress?: (progress: DownloadProgress) => void): Promise<void> {
  const controller = new AbortController()
  const armIdle = () => setTimeout(() => controller.abort(new FeedError('下载停滞超时（30 秒无数据）')), DOWNLOAD_IDLE_TIMEOUT_MS)
  let idle = armIdle()
  try {
    let offset = 0
    try {
      offset = fs.statSync(tmp).size
    } catch { /* 无残件，从头下 */ }
    const headers: Record<string, string> = {}
    if (offset > 0) headers.range = `bytes=${offset}-`
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow', headers })
    // 残件比服务端产物还长（产物换血/残件损坏）：416 说明 Range 越界，重置残件重下
    if (response.status === 416 && offset > 0) {
      try { fs.rmSync(tmp, { force: true }) } catch { /* 删不掉留给重试 */ }
      throw new FeedError('残件超出产物大小，已重置重下')
    }
    if (!response.ok) throw new FeedError(`HTTP ${response.status} for ${url}`)
    const resume = offset > 0 && response.status === 206
    if (!resume) offset = 0
    const totalBytes = offset + (Number(response.headers.get('content-length')) || 0)
    if (!response.body) {
      const buf = Buffer.from(await response.arrayBuffer())
      fs.writeFileSync(tmp, buf)
      onProgress?.({ receivedBytes: buf.length, totalBytes: totalBytes || buf.length })
      return
    }
    const file = fs.createWriteStream(tmp, { flags: resume ? 'a' : 'w' })
    // 不挂 error 监听 = 写盘失败以 uncaughtException 冒泡（主进程弹窗），必须接管
    let streamError: Error | null = null
    file.on('error', (error) => { streamError = error })
    let received = offset
    try {
      const reader = response.body.getReader()
      for (;;) {
        if (streamError) throw streamError
        const { done, value } = await reader.read()
        if (done) break
        clearTimeout(idle)
        idle = armIdle()
        received += value.byteLength
        file.write(value)
        onProgress?.({ receivedBytes: received, totalBytes })
      }
      if (streamError) throw streamError
      await new Promise<void>((resolve, reject) =>
        file.end((error?: Error | null) => {
          if (streamError) reject(streamError)
          else if (error) reject(error)
          else resolve()
        })
      )
    } finally {
      // 句柄彻底关闭再返回：rename/unlink/重开才不会撞 Windows 文件锁
      file.destroy()
      await new Promise<void>((resolve) => {
        if (file.closed) resolve()
        else file.once('close', () => resolve())
      })
      controller.abort() // 成功路径是 no-op；异常路径释放连接，不留半开 socket
    }
  } finally {
    clearTimeout(idle)
  }
}
