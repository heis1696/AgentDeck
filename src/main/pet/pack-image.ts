// 素材包图像管线纯函数库：PNG 编解码、alpha 加权盒式重采样、全帧公共 scale 的 contain 落位、
// 四角 flood-fill 色度键去背、sheet 网格切帧、manifest 构建。
// 零 electron 依赖（仅 node Buffer/zlib + shared/pet 的状态白名单常量），主进程与
// scripts/pet-pack.mjs（esbuild 现场打包成 CLI）共用同一份实现——smoke 直连打包即公共 API。
import zlib from 'node:zlib'
import { PET_CORE_STATE_IDS, PET_EXTRA_STATE_IDS, type PetStateId, type PetManifest } from '../../shared/pet'

// —— 状态帧数默认（取内置包 proven 值）：配置未提的七态补齐用；eat 只在显式给出时进包 ——
export const CORE_DEFAULT_FRAMES: Record<string, number> = { idle: 3, walk: 4, fall: 2, dragged: 1, sleep: 2, happy: 2, think: 2 }
export const EXTRA_DEFAULT_FRAMES: Record<string, number> = { eat: 3 }

// 各态动画默认参数（状态机语义见 src/shared/pet.ts stepBrain/advancePet）
export const STATE_ANIM_DEFAULTS: Record<string, { fps: number; loop: boolean; afterSec?: number; next: Array<[PetStateId, number]> }> = {
  idle: { fps: 4, loop: true, afterSec: 6, next: [['walk', 5], ['think', 2], ['sleep', 1]] },
  walk: { fps: 6, loop: true, afterSec: 5, next: [['idle', 5], ['happy', 1], ['think', 1]] },
  fall: { fps: 8, loop: true, next: [['walk', 3], ['idle', 1]] },
  dragged: { fps: 8, loop: true, next: [] },
  sleep: { fps: 2, loop: true, afterSec: 45, next: [['idle', 1]] },
  happy: { fps: 6, loop: false, next: [['idle', 1]] },
  think: { fps: 3, loop: false, next: [['idle', 1]] },
  eat: { fps: 6, loop: false, next: [['idle', 1]] }
}

const BOTTOM_PAD = 2 // contain 落位时精灵脚底距帧底留白（px）

// ============================== PNG 编解码 ==============================

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** RGBA8 → PNG（RGBA8 + deflate + filter none） */
export function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  if (rgba.length !== width * height * 4) throw new Error(`encodePng: rgba 长度 ${rgba.length} ≠ ${width}×${height}×4`)
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8  // bit depth
  ihdr[9] = 6  // color type: RGBA
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))])
}

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export interface DecodedPng {
  width: number
  height: number
  rgba: Buffer
}

/** PNG → RGBA8（支持颜色类型 0/2/3/4/6、位深 1/2/4/8/16、tRNS；隔行 Adam7 不支持） */
export function decodePng(bytes: Buffer): DecodedPng {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('不是 PNG（签名不符）')
  let off = 8
  let ihdr: { width: number; height: number; depth: number; colorType: number; interlace: number } | null = null
  let plte: Buffer | null = null
  let trns: Buffer | null = null
  const idats: Buffer[] = []
  while (off + 8 <= bytes.length) {
    const len = bytes.readUInt32BE(off)
    const type = bytes.toString('ascii', off + 4, off + 8)
    const data = bytes.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], colorType: data[9], interlace: data[12] }
    } else if (type === 'PLTE') {
      plte = data
    } else if (type === 'tRNS') {
      trns = data
    } else if (type === 'IDAT') {
      idats.push(data)
    } else if (type === 'IEND') {
      break
    }
    off += 12 + len
  }
  if (!ihdr) throw new Error('PNG 缺 IHDR')
  if (ihdr.interlace !== 0) throw new Error('不支持的隔行 PNG（Adam7）')
  const { width, height, depth, colorType } = ihdr
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType]
  if (!channels) throw new Error(`不支持的 PNG 颜色类型 ${colorType}`)
  if (colorType === 3 && !plte) throw new Error('调色板 PNG 缺 PLTE')
  if (![1, 2, 4, 8, 16].includes(depth)) throw new Error(`不支持的 PNG 位深 ${depth}`)
  const raw = zlib.inflateSync(Buffer.concat(idats))
  const stride = Math.ceil((width * channels * depth) / 8)
  const bpp = Math.max(1, Math.ceil((channels * depth) / 8))
  // 还原滤波（0 none / 1 sub / 2 up / 3 average / 4 paeth）
  const recon = Buffer.alloc(stride * height)
  let pos = 0
  for (let y = 0; y < height; y++) {
    if (pos + 1 + stride > raw.length) throw new Error('PNG IDAT 数据不足')
    const filter = raw[pos++]
    const out = y * stride
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? recon[out + x - bpp] : 0
      const b = y > 0 ? recon[out - stride + x] : 0
      const c = x >= bpp && y > 0 ? recon[out - stride + x - bpp] : 0
      let v = raw[pos + x]
      if (filter === 1) v = (v + a) & 0xff
      else if (filter === 2) v = (v + b) & 0xff
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
      } else if (filter !== 0) throw new Error(`未知 PNG 行滤波 ${filter}`)
      recon[out + x] = v
    }
    pos += stride
  }
  // 展开成 RGBA8
  const rgba = Buffer.alloc(width * height * 4)
  const sample = (rowBase: number, x: number, ch: number): number => {
    if (depth === 8) return recon[rowBase + x * channels + ch]
    if (depth === 16) return recon[rowBase + (x * channels + ch) * 2] // 高字节
    const bitPos = (x * channels + ch) * depth
    const byte = recon[rowBase + (bitPos >> 3)]
    const shift = 8 - depth - (bitPos & 7)
    return (byte >> shift) & ((1 << depth) - 1)
  }
  const grayScale = depth === 1 ? 255 : depth === 2 ? 85 : depth === 4 ? 17 : 1
  for (let y = 0; y < height; y++) {
    const rowBase = y * stride
    for (let x = 0; x < width; x++) {
      const to = (y * width + x) * 4
      if (colorType === 0) {
        const g = sample(rowBase, x, 0) * grayScale
        rgba[to] = rgba[to + 1] = rgba[to + 2] = g
        rgba[to + 3] = 255
        if (trns && trns.length >= 2) {
          const key = depth === 16 ? trns.readUInt16BE(0) : trns[0]
          if ((depth === 16 ? sample(rowBase, x, 0) * grayScale : rgba[to]) === key * grayScale) rgba[to + 3] = 0
        }
      } else if (colorType === 2) {
        rgba[to] = sample(rowBase, x, 0) * grayScale
        rgba[to + 1] = sample(rowBase, x, 1) * grayScale
        rgba[to + 2] = sample(rowBase, x, 2) * grayScale
        rgba[to + 3] = 255
        if (trns && trns.length >= 6) {
          const kr = depth === 16 ? trns.readUInt16BE(0) : trns[0]
          const kg = depth === 16 ? trns.readUInt16BE(2) : trns[2]
          const kb = depth === 16 ? trns.readUInt16BE(4) : trns[4]
          if (rgba[to] === kr * grayScale && rgba[to + 1] === kg * grayScale && rgba[to + 2] === kb * grayScale) rgba[to + 3] = 0
        }
      } else if (colorType === 3) {
        const idx = sample(rowBase, x, 0)
        rgba[to] = plte![idx * 3]
        rgba[to + 1] = plte![idx * 3 + 1]
        rgba[to + 2] = plte![idx * 3 + 2]
        rgba[to + 3] = trns && idx < trns.length ? trns[idx] : 255
      } else if (colorType === 4) {
        const g = sample(rowBase, x, 0) * (depth === 16 ? 1 : grayScale)
        rgba[to] = rgba[to + 1] = rgba[to + 2] = g
        rgba[to + 3] = sample(rowBase, x, 1) * (depth === 16 ? 1 : grayScale)
      } else {
        rgba[to] = sample(rowBase, x, 0) * (depth === 16 ? 1 : grayScale)
        rgba[to + 1] = sample(rowBase, x, 1) * (depth === 16 ? 1 : grayScale)
        rgba[to + 2] = sample(rowBase, x, 2) * (depth === 16 ? 1 : grayScale)
        rgba[to + 3] = sample(rowBase, x, 3) * (depth === 16 ? 1 : grayScale)
      }
    }
  }
  return { width, height, rgba }
}

// ============================== 图像处理 ==============================

/** 盒式重采样（area average；RGB 按 alpha 加权避免透明边晕染） */
export function resizeRGBA(src: Buffer, sw: number, sh: number, dw: number, dh: number): Buffer {
  const out = Buffer.alloc(dw * dh * 4)
  for (let dy = 0; dy < dh; dy++) {
    const sy0 = Math.floor((dy * sh) / dh)
    const sy1 = Math.min(sh, Math.max(sy0 + 1, Math.ceil(((dy + 1) * sh) / dh)))
    for (let dx = 0; dx < dw; dx++) {
      const sx0 = Math.floor((dx * sw) / dw)
      const sx1 = Math.min(sw, Math.max(sx0 + 1, Math.ceil(((dx + 1) * sw) / dw)))
      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const at = (sy * sw + sx) * 4
          const av = src[at + 3]
          r += src[at] * av
          g += src[at + 1] * av
          b += src[at + 2] * av
          a += av
          n++
        }
      }
      const to = (dy * dw + dx) * 4
      if (a > 0) {
        out[to] = Math.round(r / a)
        out[to + 1] = Math.round(g / a)
        out[to + 2] = Math.round(b / a)
      }
      out[to + 3] = Math.round(a / n)
    }
  }
  return out
}

export interface ContentBox {
  x: number
  y: number
  w: number
  h: number
}

/** 不透明内容包围盒；全空返回 null */
export function contentBBox(rgba: Buffer, w: number, h: number, alphaThreshold = 8): ContentBox | null {
  let minX = w, minY = h, maxX = -1, maxY = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (rgba[(y * w + x) * 4 + 3] > alphaThreshold) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

export interface ChromaKeyResult {
  rgba: Buffer
  keyed: boolean
  removed: number
  reason: string
}

/**
 * 四角 flood-fill 色度键去背：以四角不透明像素均值为背景色，BFS 只清
 * 与边角连通的相近色区域（精灵内部同色不受牵连）。角上全透明 = 已带 alpha，直通跳过。
 */
export function chromaKeyFlood(rgba: Buffer, w: number, h: number, tolerance: number): ChromaKeyResult {
  const corners = [0, (w - 1) * 4, (h - 1) * w * 4, (w * h - 1) * 4]
  let r = 0, g = 0, b = 0, n = 0
  for (const at of corners) {
    if (rgba[at + 3] < 8) return { rgba, keyed: false, removed: 0, reason: '角点透明（alpha 直通）' }
    if (rgba[at + 3] > 200) {
      r += rgba[at]
      g += rgba[at + 1]
      b += rgba[at + 2]
      n++
    }
  }
  if (n === 0) return { rgba, keyed: false, removed: 0, reason: '角点半透明' }
  const bg = [r / n, g / n, b / n]
  const maxDist = Math.sqrt(3) * 255
  const thr = tolerance * maxDist
  const seen = new Uint8Array(w * h)
  const queue = corners.map((at) => at / 4)
  let removed = 0
  while (queue.length) {
    const pi = queue.pop()!
    if (seen[pi]) continue
    seen[pi] = 1
    const at = pi * 4
    const isSeed = corners.includes(at)
    const d = isSeed ? 0 : Math.sqrt((rgba[at] - bg[0]) ** 2 + (rgba[at + 1] - bg[1]) ** 2 + (rgba[at + 2] - bg[2]) ** 2)
    if (d > thr) continue
    if (rgba[at + 3] !== 0) {
      rgba[at + 3] = 0
      removed++
    }
    const x = pi % w
    const y = (pi - x) / w
    if (x > 0) queue.push(pi - 1)
    if (x < w - 1) queue.push(pi + 1)
    if (y > 0) queue.push(pi - w)
    if (y < h - 1) queue.push(pi + w)
  }
  return { rgba, keyed: true, removed, reason: `背景色 rgb(${bg.map((v) => Math.round(v)).join(',')})` }
}

/**
 * 全帧公共 scale 的 contain 落位：每帧先算各自 contain scale，取全帧最小值作统一缩放
 * （动画间精灵大小一致），缩放后按 align 落进 frameW×frameH 画布（bottom-center 脚底贴地防抖）。
 */
export function fitFramesToCanvas(frames: DecodedPng[], frameW: number, frameH: number, align: 'bottom-center' | 'center'): Buffer[] {
  const boxes = frames.map((f) => contentBBox(f.rgba, f.width, f.height))
  let common = Infinity
  for (let i = 0; i < frames.length; i++) {
    const box = boxes[i]
    if (!box) continue
    common = Math.min(common, frameW / box.w, frameH / box.h)
  }
  if (!Number.isFinite(common)) common = 1
  common = Math.min(common, 1)
  return frames.map((frame, i) => {
    const canvas = Buffer.alloc(frameW * frameH * 4)
    const box = boxes[i]
    if (!box || common <= 0) return canvas
    const rw = Math.max(1, Math.round(frame.width * common))
    const rh = Math.max(1, Math.round(frame.height * common))
    const resized = rw === frame.width && rh === frame.height ? frame.rgba : resizeRGBA(frame.rgba, frame.width, frame.height, rw, rh)
    const scaledBox = { x: Math.round(box.x * common), y: Math.round(box.y * common), w: Math.max(1, Math.round(box.w * common)), h: Math.max(1, Math.round(box.h * common)) }
    const bx = contentBBox(resized, rw, rh) ?? scaledBox
    const dx = Math.round((frameW - bx.w) / 2) - bx.x
    const dy = align === 'bottom-center' ? frameH - BOTTOM_PAD - bx.h - bx.y : Math.round((frameH - bx.h) / 2) - bx.y
    for (let y = 0; y < rh; y++) {
      const ty = y + dy
      if (ty < 0 || ty >= frameH) continue
      for (let x = 0; x < rw; x++) {
        const tx = x + dx
        if (tx < 0 || tx >= frameW) continue
        const from = (y * rw + x) * 4
        if (resized[from + 3] === 0) continue
        resized.copy(canvas, (ty * frameW + tx) * 4, from, from + 4)
      }
    }
    return canvas
  })
}

/**
 * sheet 网格切帧：cols×rows 等分切图，行主序（先左到右、后上到下）返回各格。
 * 生成图宽高须能被网格整除（有余数像素丢弃最后一行/列的部分格）。
 */
export function splitSheet(image: DecodedPng, cols: number, rows: number): DecodedPng[] {
  if (cols < 1 || rows < 1) throw new Error(`splitSheet: 网格非法 ${cols}×${rows}`)
  const cellW = Math.floor(image.width / cols)
  const cellH = Math.floor(image.height / rows)
  if (cellW < 1 || cellH < 1) throw new Error(`splitSheet: 图 ${image.width}×${image.height} 装不下 ${cols}×${rows} 网格`)
  const cells: DecodedPng[] = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cell = Buffer.alloc(cellW * cellH * 4)
      for (let y = 0; y < cellH; y++) {
        const from = ((row * cellH + y) * image.width + col * cellW) * 4
        image.rgba.copy(cell, y * cellW * 4, from, from + cellW * 4)
      }
      cells.push({ width: cellW, height: cellH, rgba: cell })
    }
  }
  return cells
}

// ============================== manifest 构建 ==============================

/** 状态帧数表：七态补齐（配置缺省用默认帧数），eat 只在配置显式给出时进包 */
export function resolveFrameCounts(states: Record<string, number | undefined>): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const id of PET_CORE_STATE_IDS) counts[id] = states[id] ?? CORE_DEFAULT_FRAMES[id]
  for (const id of PET_EXTRA_STATE_IDS) if (states[id] !== undefined) counts[id] = states[id] ?? EXTRA_DEFAULT_FRAMES[id]
  return counts
}

/** 构建 manifest（pet.json 对象）：eat 缺省不补、七态必需补齐；_meta 记录生成来源信息 */
export function buildManifest(frameCounts: Record<string, number>, frameSize: [number, number], meta: Record<string, unknown>): PetManifest & { _meta: Record<string, unknown> } {
  const states: Record<string, unknown> = {}
  for (const id of [...PET_CORE_STATE_IDS, ...PET_EXTRA_STATE_IDS]) {
    const count = frameCounts[id]
    if (count === undefined) continue // eat 等扩展态缺省不补
    const anim = STATE_ANIM_DEFAULTS[id]
    states[id] = {
      frames: Array.from({ length: count }, (_, i) => `${id}-${i}.png`),
      fps: anim.fps,
      loop: anim.loop,
      next: anim.next.map(([to, weight]) => ({ to, weight })),
      ...(anim.afterSec !== undefined ? { afterSec: anim.afterSec } : {})
    }
  }
  return {
    frameSize: [frameSize[0], frameSize[1]],
    states,
    movement: { walkSpeedPx: 60, gravity: 1800, edgeBehavior: 'turn' },
    bubble: { offset: [8, -56] },
    // AI 生成帧是高清软风格下采样，平滑缩放观感优于像素最近邻
    rendering: 'smooth',
    _meta: meta
  } as PetManifest & { _meta: Record<string, unknown> }
}
