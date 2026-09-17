// 热更指针（设计 §2.2）：读侧只执行校验规则 1-3（规则 4-6 由 resolve/verifier 编排）；
// 写侧 tmp+rename 原子（先例 src/main/store.ts:213-215）；清除 = 改名留证，处置失败不阻断回退。
import fs from 'node:fs'
import path from 'node:path'

export type HotChannel = 'renderer' | 'payload'

/** 指针校验规则 1-3 失败（§3.3 路径①：损坏）。 */
export class PointerInvalid extends Error {
  constructor(readonly detail: string) {
    super(`pointer-invalid: ${detail}`)
  }
}

/** 规则 4-6 / 载荷内容失败（§3.3 路径②：拒绝）。 */
export class PayloadRejected extends Error {
  constructor(readonly rejectReason: string) {
    super(`payload-rejected: ${rejectReason}`)
  }
}

export interface HotPointer {
  schemaVersion: 1
  channel: HotChannel
  version: string
  /** 相对 userData 的版本目录路径，如 `hot-app/0.18.3-hot.7` */
  dir: string
  manifestSha256: string
  appliedAt: number
  appliedByShell: string
}

// L1 载荷通道目录名是历史既定的 hot-app（§2.1）
const CHANNEL_DIR_NAMES: Record<HotChannel, string> = { renderer: 'hot-renderer', payload: 'hot-app' }

export function channelDirName(channel: HotChannel): string {
  return CHANNEL_DIR_NAMES[channel]
}

export function channelRoot(userDataDir: string, channel: HotChannel): string {
  return path.join(userDataDir, CHANNEL_DIR_NAMES[channel])
}

export function pointerFilePath(userDataDir: string, channel: HotChannel): string {
  return path.join(channelRoot(userDataDir, channel), 'current.json')
}

/** 规则 1：JSON 可解析 + schemaVersion === 1；规则 2：channel 匹配；规则 3：dir 相对且严格落在通道根下。 */
export function readPointer(userDataDir: string, channel: HotChannel): HotPointer | null {
  const file = pointerFilePath(userDataDir, channel)
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null // 删除即回退：合法状态
    throw new PointerInvalid('unreadable')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new PointerInvalid('json')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new PointerInvalid('shape')
  const p = parsed as Record<string, unknown>
  if (p.schemaVersion !== 1) throw new PointerInvalid('schema-version')
  if (p.channel !== channel) throw new PointerInvalid('channel')
  if (typeof p.dir !== 'string' || p.dir.length === 0 || path.isAbsolute(p.dir) || p.dir.includes('..')) {
    throw new PointerInvalid('dir')
  }
  const resolved = path.resolve(userDataDir, p.dir)
  const rel = path.relative(channelRoot(userDataDir, channel), resolved)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) throw new PointerInvalid('dir')
  if (
    typeof p.version !== 'string' || p.version.length === 0 ||
    typeof p.manifestSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(p.manifestSha256) ||
    typeof p.appliedAt !== 'number' ||
    typeof p.appliedByShell !== 'string'
  ) {
    throw new PointerInvalid('shape')
  }
  return parsed as unknown as HotPointer
}

export function writePointerAtomic(file: string, pointer: HotPointer): void {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(pointer, null, 2))
  fs.renameSync(tmp, file)
}

/** 指针改名留证为 `current.json.<evidence>-<ts>`；改名失败静默——处置不阻断回退（§3.3 补充语义）。 */
export function clearPointer(userDataDir: string, channel: HotChannel, evidence: string): void {
  try {
    const file = pointerFilePath(userDataDir, channel)
    if (!fs.existsSync(file)) return
    fs.renameSync(file, `${file}.${evidence}-${Date.now()}`)
  } catch {
    /* 留证失败不阻断回退 */
  }
}
