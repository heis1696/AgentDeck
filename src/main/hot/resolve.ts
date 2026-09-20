// 解析单源（设计 §4.1 / P3）：bootstrap（L1 载荷级）与 index.ts（L2 渲染层级）共用。
// 执行 §2.2 规则 4-6 全链校验（规则 1-3 在 pointer.readPointer 内）；本模块只读不写——
// 改名留证 / 隔离等状态处置由调用方（bootstrap §3.3）执行。
// 文件系统异常（版本目录/清单缺失、清单是目录、权限不足读不出）一律归一为通道级拒绝并只标诊断，
// 绝不向调用方抛裸错误：调用方（index.ts:207 / bootstrap.ts:80）没有兜底，一层的坏状态不能拖垮另一层。
import fs from 'node:fs'
import path from 'node:path'
import { PayloadRejected, PointerInvalid, readPointer, type HotChannel, type HotPointer } from './pointer'
import { compareSemver, sha256File, verifyManifest, type HotManifestPayload, type ManifestGate } from './verifier'

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
  /** Active standalone L2 renderer version; absent when the payload renderer is active. */
  rendererVersion?: string
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
  let payload: { version: string; dir: string; entry: string; rendererIndexHtml: string | null } | null = null

  // 第 1 层：L1 决定主进程和自带界面；后续独立发布的新版 L2 可在此基础上覆盖界面。
  try {
    const found = resolveChannel(userDataDir, 'payload', gate)
    if (found) {
      const entry = path.join(found.versionDir, 'out', 'main', 'index.js')
      if (!fs.existsSync(entry)) throw new PayloadRejected('entry-missing')
      const rendererIndexHtml = path.join(found.versionDir, 'out', 'renderer', 'index.html')
      payload = {
        dir: found.versionDir,
        version: found.manifest.version,
        entry,
        rendererIndexHtml: fs.existsSync(rendererIndexHtml) ? rendererIndexHtml : null
      }
    }
  } catch (error) {
    fallbackReason = rejectionReason(error)
  }

  // 第 2 层：L2 只覆盖渲染层；有效 L1 主进程继续保留，门禁基准为生效主进程版本。
  const effectiveMainVersion = payload?.version ?? shellVersion
  const rendererGate: ManifestGate = { mainVersion: effectiveMainVersion, shellVersion }
  try {
    const found = resolveChannel(userDataDir, 'renderer', rendererGate)
    if (found) {
      if (typeof found.manifest.version !== 'string' || compareSemver(found.manifest.version, effectiveMainVersion) !== 1) {
        throw new PayloadRejected('renderer-version-not-newer')
      }
      const rendererIndexHtml = path.join(found.versionDir, 'out', 'renderer', 'index.html')
      if (!fs.existsSync(rendererIndexHtml)) throw new PayloadRejected('renderer-entry-missing')
      return {
        rendererIndexHtml,
        rendererVersion: found.manifest.version,
        payload: payload ? { dir: payload.dir, version: payload.version, entry: payload.entry } : null,
        reason: 'renderer'
      }
    }
  } catch (error) {
    // L2 失败不能影响有效 L1；L1 失败时保留更接近根因的诊断。
    if (!fallbackReason) fallbackReason = rejectionReason(error)
  }

  if (payload) {
    return {
      rendererIndexHtml: payload.rendererIndexHtml,
      payload: { dir: payload.dir, version: payload.version, entry: payload.entry },
      reason: 'payload'
    }
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
  const dirState = statVersionDir(versionDir)
  if (dirState !== 'dir') throw new PointerInvalid(`version-dir-${dirState}`)
  const manifestPath = path.join(versionDir, 'manifest.json')
  if (readManifestSha256(manifestPath) !== pointer.manifestSha256) throw new PayloadRejected('manifest-sha-mismatch')
  const verdict = verifyManifest(manifestPath, channel, gate)
  if (!verdict.ok) throw new PayloadRejected(verdict.reason)
  return { pointer, versionDir, manifest: verdict.manifest }
}

/** 版本目录可用性：缺失 / 路径不是目录 / 读不到（EACCES 等）都只让本通道回退，不外抛 fs 异常。 */
function statVersionDir(versionDir: string): 'dir' | 'missing' | 'unreadable' {
  try {
    return fs.statSync(versionDir).isDirectory() ? 'dir' : 'missing'
  } catch (error) {
    return fsErrorCode(error) === 'ENOENT' ? 'missing' : 'unreadable'
  }
}

/** 规则 4 读盘：缺失 → manifest-missing；是目录 / 不可读 → manifest-unreadable（EISDIR/EACCES/ELOOP 等同归一）。 */
function readManifestSha256(manifestPath: string): string {
  try {
    return sha256File(manifestPath)
  } catch (error) {
    throw new PayloadRejected(fsErrorCode(error) === 'ENOENT' ? 'manifest-missing' : 'manifest-unreadable')
  }
}

function fsErrorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' ? code : ''
}

/** 归一失败诊断：只归类不外抛（未知异常也给可排障的 code）——任一层失败都不得成为解析单源的出口。 */
function rejectionReason(error: unknown): string {
  if (error instanceof PointerInvalid) return `pointer-invalid:${error.detail}`
  if (error instanceof PayloadRejected) return `payload-rejected:${error.rejectReason}`
  const code = fsErrorCode(error)
  return `payload-rejected:${code ? code.toLowerCase() : 'unexpected'}`
}
