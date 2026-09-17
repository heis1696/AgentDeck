// manifest 完整性与签名校验（设计 §2.3）：sha256 + Ed25519 + 通道门禁（规则 5、6）。
// 验签对象 = canonicalJson(payload) 的 UTF-8 字节；公钥由 raw 32 字节 hex 拼 SPKI 前缀构造。
import crypto from 'node:crypto'
import fs from 'node:fs'
import { canonicalJson } from './canonical'
import { resolveTrustedKeys } from './trust'

export interface HotManifestArtifact {
  name: string
  sha256: string
  size: number
}

export interface HotManifestFile {
  path: string
  sha256: string
  size: number
}

/** manifest.json 的被签名块（§2.3 payload 字段）。 */
export interface HotManifestPayload {
  schemaVersion: number
  channel: string
  version: string
  minMainVersion: string
  minShellVersion: string
  releaseDate?: string
  keyId: string
  artifact?: HotManifestArtifact
  files?: HotManifestFile[]
}

export interface ManifestGate {
  mainVersion: string
  shellVersion: string
}

export type ManifestVerdict =
  | { ok: true; manifest: HotManifestPayload }
  | { ok: false; reason: string }

// Ed25519 SPKI DER 前缀：raw 32 字节公钥拼上它即为合法 SPKI DER
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

export function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

export function ed25519PublicKeyFromRawHex(rawHex: string): crypto.KeyObject {
  return crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(rawHex, 'hex')]),
    format: 'der',
    type: 'spki'
  })
}

/**
 * 3 段 semver 比较（§2.2 规则 6，不引依赖）：a>b → 1，a<b → -1，a==b → 0，
 * 任一侧不可解析 → null（调用方按拒绝处理）。支持 `-pre` 预发布段，忽略 `+build`。
 */
export function compareSemver(a: string, b: string): number | null {
  const parse = (v: string): { core: [number, number, number]; pre: string[] | null } | null => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim())
    if (!m) return null
    const pre = m[4] ? m[4].split('.') : null
    return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre }
  }
  const left = parse(a)
  const right = parse(b)
  if (!left || !right) return null
  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return left.core[i] < right.core[i] ? -1 : 1
  }
  if (!left.pre && !right.pre) return 0
  // 本产品版本语义（§6.3）：<基座>-hot.<n> 是"基座之上叠加的热更版"，高于无后缀基座
  // （与标准 semver 的 prerelease 排序相反）：否则载荷 0.21.0-hot.4 生效后，渲染层
  // manifest 的 minMainVersion=0.21.0 会被误判为"高于当前主进程"而遭门禁拒绝。
  if (!left.pre) return -1
  if (!right.pre) return 1
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i]
    const y = right.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNum = /^\d+$/.test(x)
    const yNum = /^\d+$/.test(y)
    if (xNum && yNum) {
      const delta = Number(x) - Number(y)
      if (delta !== 0) return delta < 0 ? -1 : 1
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/**
 * 校验 manifest.json（§2.3）：未知 keyId / 验签不过 / 通道不符 / 门禁不过均拒绝。
 * 注意 manifest 本体的传输完整性（规则 4）由指针的 manifestSha256 把关，不在本函数。
 */
export function verifyManifest(manifestPath: string, channel: string, gate: ManifestGate): ManifestVerdict {
  let root: unknown
  try {
    root = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch {
    return { ok: false, reason: 'manifest-unreadable' }
  }
  if (!root || typeof root !== 'object') return { ok: false, reason: 'manifest-shape' }
  const { payload, signature } = root as Record<string, unknown>
  if (!payload || typeof payload !== 'object' || typeof signature !== 'string') {
    return { ok: false, reason: 'manifest-shape' }
  }
  const manifest = payload as HotManifestPayload
  if (manifest.schemaVersion !== 1) return { ok: false, reason: 'manifest-schema' }
  if (manifest.channel !== channel) return { ok: false, reason: 'channel-mismatch' }
  const keyHex = resolveTrustedKeys()[manifest.keyId]
  if (!keyHex) return { ok: false, reason: 'unknown-key-id' }
  let signatureOk = false
  try {
    const key = ed25519PublicKeyFromRawHex(keyHex)
    const data = Buffer.from(canonicalJson(manifest), 'utf8')
    signatureOk = crypto.verify(null, data, key, Buffer.from(signature, 'base64'))
  } catch {
    signatureOk = false
  }
  if (!signatureOk) return { ok: false, reason: 'signature-invalid' }
  // 规则 6 通道门禁：缺失或不可解析的版本一律按拒绝处理（发布脚本必写这两个字段）
  if (typeof manifest.minMainVersion !== 'string' || compareSemver(manifest.minMainVersion, gate.mainVersion) === null) {
    return { ok: false, reason: 'manifest-shape' }
  }
  if (compareSemver(manifest.minMainVersion, gate.mainVersion)! > 0) return { ok: false, reason: 'min-main-version' }
  if (typeof manifest.minShellVersion !== 'string' || compareSemver(manifest.minShellVersion, gate.shellVersion) === null) {
    return { ok: false, reason: 'manifest-shape' }
  }
  if (compareSemver(manifest.minShellVersion, gate.shellVersion)! > 0) return { ok: false, reason: 'min-shell-version' }
  return { ok: true, manifest }
}
