// store-only zip 读写（设计 §5.1 零新 npm 依赖约束）：发布脚本（写）与 updater（解）共用同一实现。
// 只支持 method 0（不压缩）+ UTF-8 文件名；解压侧带 zip-slip 防护与 CRC 校验。
import nodeFs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

// Electron 主进程的 fs 带 asar 拦截：任何 .asar 后缀路径段（含壳包内的 resources/app.asar）
// 的读写会被当"归档操作"（writeFileSync/readFileSync 抛 Invalid package）。解壳包必须按原始
// 字节访问 → 用 Electron 的 original-fs（未打补丁）；纯 node 环境（发布脚本/smoke）无此模块，回落 node:fs。
const rawFs: typeof nodeFs = (() => {
  try {
    return createRequire(__filename)('original-fs') as typeof nodeFs
  } catch {
    return nodeFs
  }
})()

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

export interface ZipEntryInput {
  /** zip 内相对路径（正斜杠） */
  path: string
  data: Buffer
}

/** 生成 store-only zip（目录条目不落盘，只写文件条目）。 */
export function createZipStore(entries: ZipEntryInput[]): Buffer {
  const now = new Date()
  // DOS 时间：秒粒度 /2；DOS 日期自 1980 起
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.path, 'utf8')
    const crc = crc32(entry.data)
    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(0x0800, 6) // UTF-8 文件名
    local.writeUInt16LE(0, 8) // method 0 = store
    local.writeUInt16LE(dosTime, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(entry.data.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    nameBuf.copy(local, 30)
    const central = Buffer.alloc(46 + nameBuf.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x0014, 4) // 版本需要 2.0
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(dosTime, 12)
    central.writeUInt16LE(dosDate, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(entry.data.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42)
    nameBuf.copy(central, 46)
    locals.push(local, entry.data)
    centrals.push(central)
    offset += local.length + entry.data.length
  }
  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4) // 当前磁盘
  eocd.writeUInt16LE(0, 6) // central dir 所在磁盘
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, eocd])
}

export interface ExtractedEntry {
  path: string
  size: number
}

/**
 * 解压 store-only zip 到 destDir（逐条 CRC 校验；拒绝绝对路径/.. 逃逸/非 store 条目）。
 * 返回解出的条目清单（相对路径），调用方再做 manifest 的逐文件 sha256/size 核对（§5.1 staging 流程）。
 */
export function extractZipStore(zipPath: string, destDir: string): ExtractedEntry[] {
  const zip = rawFs.readFileSync(zipPath)
  // 从尾部找 EOCD（22 字节固定长，无 comment）
  if (zip.length < 22) throw new Error('zip: too short')
  const eocdPos = zip.length - 22
  if (zip.readUInt32LE(eocdPos) !== 0x06054b50) throw new Error('zip: eocd not found (comment tail unsupported)')
  const count = zip.readUInt16LE(eocdPos + 10)
  let ptr = zip.readUInt32LE(eocdPos + 16)
  const extracted: ExtractedEntry[] = []
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(ptr) !== 0x02014b50) throw new Error(`zip: central dir broken at ${i}`)
    const method = zip.readUInt16LE(ptr + 10)
    if (method !== 0) throw new Error(`zip: entry not stored (method ${method})`)
    const crc = zip.readUInt32LE(ptr + 16)
    const size = zip.readUInt32LE(ptr + 20)
    const nameLen = zip.readUInt16LE(ptr + 28)
    const extraLen = zip.readUInt16LE(ptr + 30)
    const commentLen = zip.readUInt16LE(ptr + 32)
    const localOff = zip.readUInt32LE(ptr + 42)
    const name = zip.toString('utf8', ptr + 46, ptr + 46 + nameLen)
    // zip-slip：拒绝绝对路径与 .. 段
    if (name.startsWith('/') || /^[a-zA-Z]:/.test(name) || name.split('/').includes('..')) {
      throw new Error(`zip: unsafe entry path ${name}`)
    }
    // 本地头：跳过其 extra 字段
    if (zip.readUInt32LE(localOff) !== 0x04034b50) throw new Error(`zip: local header broken for ${name}`)
    const localNameLen = zip.readUInt16LE(localOff + 26)
    const localExtraLen = zip.readUInt16LE(localOff + 28)
    const dataStart = localOff + 30 + localNameLen + localExtraLen
    const data = zip.subarray(dataStart, dataStart + size)
    if (data.length !== size || crc32(data) !== crc) throw new Error(`zip: crc mismatch for ${name}`)
    const target = path.join(destDir, ...name.split('/'))
    rawFs.mkdirSync(path.dirname(target), { recursive: true })
    rawFs.writeFileSync(target, data)
    extracted.push({ path: name, size })
    ptr += 46 + nameLen + extraLen + commentLen
  }
  return extracted
}
