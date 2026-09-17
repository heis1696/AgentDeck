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

/** 下载 `<base>/<channel>/<artifact.name>` 到 dest（整体 sha256 由调用方核对）。 */
export async function downloadArtifact(
  baseUrl: string,
  channel: string,
  artifactName: string,
  dest: string,
  onProgress?: (progress: DownloadProgress) => void
): Promise<void> {
  const url = `${trimBase(baseUrl)}/${channel}/${encodeURIComponent(artifactName)}`
  const response = await fetchWithRetry(url)
  const totalBytes = Number(response.headers.get('content-length')) || 0
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const tmp = `${dest}.part`
  if (response.body) {
    const file = fs.createWriteStream(tmp)
    let received = 0
    const reader = response.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        file.write(value)
        onProgress?.({ receivedBytes: received, totalBytes })
      }
      await new Promise<void>((resolve, reject) => file.end((error?: Error | null) => (error ? reject(error) : resolve())))
    } finally {
      await reader.cancel().catch(() => {})
    }
  } else {
    const buf = Buffer.from(await response.arrayBuffer())
    fs.writeFileSync(tmp, buf)
    onProgress?.({ receivedBytes: buf.length, totalBytes: totalBytes || buf.length })
  }
  fs.renameSync(tmp, dest)
}
