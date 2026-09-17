// 解析单源（设计 §4.1 / P3）：bootstrap（L1 载荷级）与 index.ts（L2 渲染层级）共用。
// 执行 §2.2 规则 4-6 全链校验（规则 1-3 在 pointer.readPointer 内）；本模块只读不写——
// 改名留证 / 隔离等状态处置由调用方（bootstrap §3.3）执行。
import fs from 'node:fs'
import path from 'node:path'
import { PayloadRejected, PointerInvalid, readPointer, type HotChannel, type HotPointer } from './pointer'
import { sha256File, verifyManifest, type HotManifestPayload, type ManifestGate } from './verifier'

export interface HotPayloadInfo {
  /** 生效载荷版本目录绝对路径 */
  dir: string
  version: string
  /** 载荷主进程入口绝对路径（bootstrap require 目标） */
  entry: string
}

export interface HotResolution {
  /** 实际可用的渲染层入口绝对路径；null = 用 asar 内置路径 */
  rendererIndexHtml: string | null
  /** 生效载荷信息；null = 无载荷（主进程就是 asar 内置） */
  payload: HotPayloadInfo | null
  /**
   * 诊断（§4.1 枚举回退原因）：'no-pointer' | 'pointer-invalid:…' | 'payload-rejected:…' | 'dev' | 'disabled'；
   * 热更生效时为 'payload' / 'renderer'。
   */
  reason: string
}

export interface ResolveHotOptions {
  /** dev / 逃生开关直通：跳过两层解析，回退内置 */
  skipPayload?: boolean
}

export function resolveHotState(userDataDir: string, shellVersion: string, opts?: ResolveHotOptions): HotResolution {
  if (opts?.skipPayload) return { rendererIndexHtml: null, payload: null, reason: 'dev' }
  if (process.env.AGENTDECK_DISABLE_HOT === '1') return { rendererIndexHtml: null, payload: null, reason: 'disabled' }

  const gate: ManifestGate = { mainVersion: shellVersion, shellVersion }
  let fallbackReason: string | null = null

  // 第 1 层：L1 载荷指针（§4.1 顺序 2）。载荷自带渲染层接管，L2 指针按 P6 此时不应存在，忽略不读。
  try {
    const found = resolveChannel(userDataDir, 'payload', gate)
    if (found) {
      const entry = path.join(found.versionDir, 'out', 'main', 'index.js')
      if (!fs.existsSync(entry)) throw new PayloadRejected('entry-missing')
      const rendererIndexHtml = path.join(found.versionDir, 'out', 'renderer', 'index.html')
      return {
        rendererIndexHtml: fs.existsSync(rendererIndexHtml) ? rendererIndexHtml : null,
        payload: { dir: found.versionDir, version: found.manifest.version, entry },
        reason: 'payload'
      }
    }
  } catch (error) {
    fallbackReason = rejection(error).reason
  }

  // 第 2 层：L2 渲染层指针（§4.1 顺序 3）。此分支下主进程为内置（或未生效载荷），门禁主版本 = 壳版本。
  try {
    const found = resolveChannel(userDataDir, 'renderer', gate)
    if (found) {
      const rendererIndexHtml = path.join(found.versionDir, 'out', 'renderer', 'index.html')
      if (!fs.existsSync(rendererIndexHtml)) throw new PayloadRejected('renderer-entry-missing')
      return { rendererIndexHtml, payload: null, reason: 'renderer' }
    }
  } catch (error) {
    // L1 已失败时保留 L1 的诊断（更接近根因），否则记录 L2 的
    if (!fallbackReason) fallbackReason = rejection(error).reason
  }

  return { rendererIndexHtml: null, payload: null, reason: fallbackReason ?? 'no-pointer' }
}

/** 单通道完整校验：规则 1-3（readPointer）→ 目录存在 → 规则 4（sha256）→ 规则 5（验签）→ 规则 6（门禁）。 */
function resolveChannel(
  userDataDir: string,
  channel: HotChannel,
  gate: ManifestGate
): { pointer: HotPointer; versionDir: string; manifest: HotManifestPayload } | null {
  const pointer = readPointer(userDataDir, channel)
  if (!pointer) return null
  const versionDir = path.join(userDataDir, pointer.dir)
  if (!fs.existsSync(versionDir)) throw new PointerInvalid('version-dir-missing')
  const manifestPath = path.join(versionDir, 'manifest.json')
  if (!fs.existsSync(manifestPath)) throw new PayloadRejected('manifest-missing')
  if (sha256File(manifestPath) !== pointer.manifestSha256) throw new PayloadRejected('manifest-sha-mismatch')
  const verdict = verifyManifest(manifestPath, channel, gate)
  if (!verdict.ok) throw new PayloadRejected(verdict.reason)
  return { pointer, versionDir, manifest: verdict.manifest }
}

function rejection(error: unknown): HotResolution {
  if (error instanceof PointerInvalid) {
    return { rendererIndexHtml: null, payload: null, reason: `pointer-invalid:${error.detail}` }
  }
  if (error instanceof PayloadRejected) {
    return { rendererIndexHtml: null, payload: null, reason: `payload-rejected:${error.rejectReason}` }
  }
  throw error
}
