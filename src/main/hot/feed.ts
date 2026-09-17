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

/** 下载 artifact 到 dest（整体 sha256 由调用方核对）。超时语义：停滞 30s 才中止（按块重置），
 *  总时长上限 30 分钟——不能用固定总超时：慢带宽下 314MB 壳包会被"20 秒到点"腰斩
 *  （实测 4Mbps 带宽 20s ≈ 8.6MB，每次都死在同一位置）。失败自动清 .part 并重试 3 次。 */
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
      try { fs.unlinkSync(tmp) } catch { /* 无残留 */ }
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt] ?? 4_000))
  }
  throw lastError instanceof Error ? lastError : new FeedError(`download failed: ${url}`)
}

const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000
const DOWNLOAD_TOTAL_CAP_MS = 30 * 60_000

async function downloadOnce(url: string, tmp: string, onProgress?: (progress: DownloadProgress) => void): Promise<void> {
  const controller = new AbortController()
  const armIdle = () => setTimeout(() => controller.abort(new FeedError('下载停滞超时（30 秒无数据）')), DOWNLOAD_IDLE_TIMEOUT_MS)
  let idle = armIdle()
  const cap = setTimeout(() => controller.abort(new FeedError('下载总时长超限（30 分钟）')), DOWNLOAD_TOTAL_CAP_MS)
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    if (!response.ok) throw new FeedError(`HTTP ${response.status} for ${url}`)
    const totalBytes = Number(response.headers.get('content-length')) || 0
    if (!response.body) {
      const buf = Buffer.from(await response.arrayBuffer())
      fs.writeFileSync(tmp, buf)
      onProgress?.({ receivedBytes: buf.length, totalBytes: totalBytes || buf.length })
      return
    }
    const file = fs.createWriteStream(tmp)
    let received = 0
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      clearTimeout(idle)
      idle = armIdle()
      received += value.byteLength
      file.write(value)
      onProgress?.({ receivedBytes: received, totalBytes })
    }
    await new Promise<void>((resolve, reject) => file.end((error?: Error | null) => (error ? reject(error) : resolve())))
  } finally {
    clearTimeout(idle)
    clearTimeout(cap)
  }
}
