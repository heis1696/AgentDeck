// AI 素材包生成 CLI（零依赖：node 内置 + 原生 fetch/WebSocket）。
// 四子命令：init（写配置模板）/ validate（静态校验配置，不联网）/ run（全管线生成素材包）/
// preview（把已生成的包拼成放大棋盘 contact sheet 供目检）；--mock 用内置假后端演示全管线。
//
// 产物契约 = src/main/pet/packs.ts 的磁盘约定：outDir/<packId>/pet.json + <state>-<n>.png，
// pet.json 过 src/shared/pet.ts 的 validatePetManifest（白名单态 = 七态必需 + eat 可选，
// 见 PET_CORE_STATE_IDS / PET_EXTRA_STATE_IDS——本文件的状态名单是它的镜像，smoke 会比对两边一致）。
// _meta 记录 seed 与 stylePrompt（validatePetManifest 只拒 states 内的白名单外键，顶层扩展字段放行）。
//
// 后端二选一：
//   comfyui  — 读 workflow 模板（{{PROMPT}}/{{SEED}}/{{WIDTH}}/{{HEIGHT}} 必需、{{REF_IMAGE}} 可选，
//              占位符须是完整的字符串值）→ POST /prompt → WebSocket 等 executing(data.node=null)
//              （连不上/异常退化轮询 /history）→ /view 取图；首帧上传 /upload/image 作后续帧垫图。
//   gptimage — OpenAI images 形状：background=transparent + output_format=png，b64_json 取图；
//              首帧作参考图走 multipart（编辑形状），服务端回 400/422 自动降级为无参考重试；
//              apiKey 只从 env 读，绝不打印。
// 图像链路手写零依赖：PNG 解码/编码、盒式重采样、全帧公共 scale 的 contain、alpha 直通、
// 四角 flood-fill 色度键去背、临时目录+rename 原子落盘。
//
// 用法：
//   node scripts/pet-pack.mjs init [--config pet-pack.config.json] [--force]
//   node scripts/pet-pack.mjs validate [--config ...]
//   node scripts/pet-pack.mjs run [--config ...] [--mock]
//   node scripts/pet-pack.mjs preview [--config ...]
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { pathToFileURL } from 'node:url'

// —— 状态契约镜像（源头：src/shared/pet.ts PET_CORE_STATE_IDS + PET_EXTRA_STATE_IDS）——
const CORE_STATE_IDS = ['idle', 'walk', 'fall', 'dragged', 'sleep', 'happy', 'think']
const EXTRA_STATE_IDS = ['eat']
const STATE_IDS = [...CORE_STATE_IDS, ...EXTRA_STATE_IDS]

// 帧数默认：配置 states 未提的七态补齐用；eat 只在配置显式给出时进包（缺省不补）
const CORE_DEFAULT_FRAMES = { idle: 3, walk: 4, fall: 2, dragged: 1, sleep: 2, happy: 2, think: 2 }
const EXTRA_DEFAULT_FRAMES = { eat: 3 }

// 各态动画默认参数（取内置包 proven 值，状态机语义见 src/shared/pet.ts stepBrain/advancePet）
const STATE_ANIM_DEFAULTS = {
  idle: { fps: 4, loop: true, afterSec: 6, next: [['walk', 5], ['think', 2], ['sleep', 1]] },
  walk: { fps: 6, loop: true, afterSec: 5, next: [['idle', 5], ['happy', 1], ['think', 1]] },
  fall: { fps: 8, loop: true, next: [['walk', 3], ['idle', 1]] },
  dragged: { fps: 8, loop: true, next: [] },
  sleep: { fps: 2, loop: true, afterSec: 45, next: [['idle', 1]] },
  happy: { fps: 6, loop: false, next: [['idle', 1]] },
  think: { fps: 3, loop: false, next: [['idle', 1]] },
  eat: { fps: 6, loop: false, next: [['idle', 1]] }
}

// 各态画面提示词（拼进每帧 prompt）
const STATE_PROMPTS = {
  idle: 'standing still and relaxed, gentle idle breathing',
  walk: 'mid-step walking pose, side view',
  fall: 'falling through the air, arms up, surprised face',
  dragged: 'held up from above, dangling, wide eyes',
  sleep: 'sleeping peacefully, eyes closed, tiny zzz',
  happy: 'jumping with joy, big open smile',
  think: 'pondering, looking to the side, thoughtful pose',
  eat: 'happily eating a small snack, holding a tiny cookie'
}

const DEFAULT_CONFIG_NAME = 'pet-pack.config.json'
const GEN_SIZE_DEFAULT = 512
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

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** RGBA8 → PNG（RGBA8 + deflate + filter none） */
function encodePng(width, height, rgba) {
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

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** PNG → RGBA8（支持颜色类型 0/2/3/4/6、位深 1/2/4/8/16、tRNS；隔行 Adam7 不支持） */
function decodePng(bytes) {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('不是 PNG（签名不符）')
  let off = 8
  let ihdr = null
  let plte = null
  let trns = null
  const idats = []
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
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
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
  const sample = (rowBase, x, ch) => {
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
        rgba[to] = plte[idx * 3]
        rgba[to + 1] = plte[idx * 3 + 1]
        rgba[to + 2] = plte[idx * 3 + 2]
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
function resizeRGBA(src, sw, sh, dw, dh) {
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

/** 不透明内容包围盒；全空返回 null */
function contentBBox(rgba, w, h, alphaThreshold = 8) {
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

/**
 * 四角 flood-fill 色度键去背：以四角不透明像素均值为背景色，BFS 只清
 * 与边角连通的相近色区域（精灵内部同色不受牵连）。角上全透明 = 已带 alpha，直通跳过。
 */
function chromaKeyFlood(rgba, w, h, tolerance) {
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
    const pi = queue.pop()
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
function fitFramesToCanvas(frames, frameW, frameH, align) {
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

// ============================== 配置 ==============================

function configErrors(cfg) {
  const errors = []
  const isInt = (v) => Number.isInteger(v)
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return ['配置根必须是对象']
  if (typeof cfg.packId !== 'string' || !/^[\w-]+$/.test(cfg.packId)) errors.push('packId 必须是 [\\w-]+ 字符串')
  else if (cfg.packId === 'default') errors.push("packId 不能为 'default'（内置包保留名）")
  if (typeof cfg.outDir !== 'string' || !cfg.outDir.trim()) errors.push('outDir 必须是非空字符串（相对路径按配置文件所在目录解析）')
  if (!Array.isArray(cfg.frameSize) || cfg.frameSize.length !== 2 || cfg.frameSize[0] !== 64 || cfg.frameSize[1] !== 64) errors.push('frameSize 固定为 [64, 64]')
  if (cfg.genSize !== undefined && (!isInt(cfg.genSize) || cfg.genSize < 64 || cfg.genSize > 2048)) errors.push('genSize 必须是 64–2048 的整数（默认 512）')
  if (typeof cfg.stylePrompt !== 'string' || !cfg.stylePrompt.trim()) errors.push('stylePrompt 必须是非空字符串')
  if (!isInt(cfg.seed) || cfg.seed < 0) errors.push('seed 必须是 ≥0 的整数')
  if (cfg.states !== undefined) {
    if (!cfg.states || typeof cfg.states !== 'object' || Array.isArray(cfg.states)) {
      errors.push('states 必须是「状态名 → 帧数」对象')
    } else {
      for (const [key, count] of Object.entries(cfg.states)) {
        if (!STATE_IDS.includes(key)) {
          errors.push(`states.${key} 不是白名单状态名（允许：${CORE_STATE_IDS.join('/')} 七态必需 + ${EXTRA_STATE_IDS.join('/')} 可选）`)
        } else if (!isInt(count) || count < 1 || count > 32) {
          errors.push(`states.${key} 帧数必须是 1–32 的整数`)
        }
      }
    }
  }
  if (cfg.removeBackground !== undefined) {
    const rb = cfg.removeBackground
    if (!rb || typeof rb !== 'object' || Array.isArray(rb)) errors.push('removeBackground 必须是对象 { enabled, tolerance }')
    else {
      if (rb.enabled !== undefined && typeof rb.enabled !== 'boolean') errors.push('removeBackground.enabled 必须是布尔值')
      if (rb.tolerance !== undefined && (typeof rb.tolerance !== 'number' || !(rb.tolerance > 0) || rb.tolerance >= 1)) errors.push('removeBackground.tolerance 必须是 0–1 开区间内的数（默认 0.15）')
    }
  }
  if (cfg.align !== undefined && cfg.align !== 'bottom-center' && cfg.align !== 'center') errors.push("align 只允许 'bottom-center' | 'center'")
  const backend = cfg.backend
  if (!backend || typeof backend !== 'object' || Array.isArray(backend)) {
    errors.push('backend 必须是对象，且 comfyui / gptimage 二选一')
  } else {
    const kinds = ['comfyui', 'gptimage'].filter((k) => backend[k] !== undefined)
    if (kinds.length === 0) errors.push('backend 缺少 comfyui 或 gptimage 配置（二选一）')
    if (kinds.length === 2) errors.push('backend 的 comfyui 与 gptimage 只能二选一')
    if (Object.keys(backend).some((k) => !['comfyui', 'gptimage'].includes(k))) errors.push('backend 只允许 comfyui / gptimage 键')
    if (kinds.includes('comfyui')) {
      const c = backend.comfyui
      if (!c || typeof c !== 'object') errors.push('backend.comfyui 必须是对象')
      else {
        if (typeof c.address !== 'string' || !/^https?:\/\//.test(c.address)) errors.push('backend.comfyui.address 必须是 http(s) 地址')
        if (typeof c.workflowFile !== 'string' || !c.workflowFile.trim()) errors.push('backend.comfyui.workflowFile 必须是非空字符串')
        if (typeof c.outputNode !== 'string' || !c.outputNode.trim()) errors.push('backend.comfyui.outputNode 必须是非空字符串（取图节点 id）')
      }
    }
    if (kinds.includes('gptimage')) {
      const g = backend.gptimage
      if (!g || typeof g !== 'object') errors.push('backend.gptimage 必须是对象')
      else {
        if (typeof g.endpoint !== 'string' || !/^https?:\/\//.test(g.endpoint)) errors.push('backend.gptimage.endpoint 必须是 http(s) 地址')
        if (typeof g.apiKeyEnv !== 'string' || !g.apiKeyEnv.trim()) errors.push('backend.gptimage.apiKeyEnv 必须是非空字符串（apiKey 只从环境变量读）')
        if (typeof g.model !== 'string' || !g.model.trim()) errors.push('backend.gptimage.model 必须是非空字符串')
        if (g.size !== undefined && (typeof g.size !== 'string' || !/^\d+x\d+$/.test(g.size))) errors.push("backend.gptimage.size 形如 '1024x1024'")
      }
    }
  }
  return errors
}

/** 读 + 静态校验配置（含 comfyui workflowFile 的存在性与占位符检查）；返回归一化配置 */
function loadConfig(configPath) {
  let raw
  try {
    raw = fs.readFileSync(configPath, 'utf8')
  } catch (err) {
    throw new Error(`读配置失败 ${configPath}：${err.message}`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`配置不是合法 JSON：${err.message}`)
  }
  const errors = configErrors(parsed)
  const configDir = path.dirname(path.resolve(configPath))
  let workflow = null
  let workflowText = null
  const backendKind = parsed?.backend ? (parsed.backend.comfyui !== undefined ? 'comfyui' : parsed.backend.gptimage !== undefined ? 'gptimage' : null) : null
  if (errors.length === 0 && backendKind === 'comfyui') {
    const wfPath = path.resolve(configDir, parsed.backend.comfyui.workflowFile)
    let wfRaw
    try {
      wfRaw = fs.readFileSync(wfPath, 'utf8')
    } catch (err) {
      errors.push(`workflow 文件读不到 ${wfPath}：${err.message}`)
    }
    if (wfRaw !== undefined) {
      workflowText = wfRaw
      try {
        workflow = JSON.parse(wfRaw)
      } catch (err) {
        errors.push(`workflow 文件不是合法 JSON：${err.message}`)
      }
      if (workflow) {
        for (const token of ['{{PROMPT}}', '{{SEED}}', '{{WIDTH}}', '{{HEIGHT}}']) {
          if (!wfRaw.includes(token)) errors.push(`workflow 缺必需占位符 ${token}`)
        }
      }
    }
  }
  if (errors.length) {
    throw new ConfigError(errors.map((e) => `  ✗ ${e}`).join('\n'))
  }
  return {
    packId: parsed.packId,
    outDir: path.resolve(configDir, parsed.outDir),
    frameSize: [64, 64],
    genSize: parsed.genSize ?? GEN_SIZE_DEFAULT,
    stylePrompt: parsed.stylePrompt,
    seed: parsed.seed,
    states: parsed.states ?? {},
    removeBackground: { enabled: parsed.removeBackground?.enabled ?? true, tolerance: parsed.removeBackground?.tolerance ?? 0.15 },
    align: parsed.align ?? 'bottom-center',
    backendKind,
    backend: parsed.backend[backendKind],
    workflow,
    workflowText
  }
}

class ConfigError extends Error {}

/** 状态帧数表：七态补齐（配置缺省用默认帧数），eat 只在配置显式给出时进包 */
function resolveFrameCounts(states) {
  const counts = {}
  for (const id of CORE_STATE_IDS) counts[id] = states[id] ?? CORE_DEFAULT_FRAMES[id]
  for (const id of EXTRA_STATE_IDS) if (states[id] !== undefined) counts[id] = states[id] ?? EXTRA_DEFAULT_FRAMES[id]
  return counts
}

/** 构建 manifest（pet.json 对象）：eat 缺省不补、七态必需补齐；_meta 记录 seed 与 stylePrompt */
function buildManifest(frameCounts, frameSize, meta) {
  const states = {}
  for (const id of STATE_IDS) {
    if (frameCounts[id] === undefined) continue // eat 等扩展态缺省不补
    const anim = STATE_ANIM_DEFAULTS[id]
    states[id] = {
      frames: Array.from({ length: frameCounts[id] }, (_, i) => `${id}-${i}.png`),
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
    _meta: meta
  }
}

// ============================== 后端 ==============================

/** 确定性 PRNG（mulberry32）：mock 帧与 clientId 都从 seed 派生 */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 占位符填充：workflow 深遍历，完整字符串值的 SEED/WIDTH/HEIGHT 转数值，其余文本拼接 */
function fillWorkflow(workflow, { prompt, seed, width, height, refImage }) {
  const numeric = { '{{SEED}}': seed, '{{WIDTH}}': width, '{{HEIGHT}}': height }
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk)
    if (node && typeof node === 'object') {
      const out = {}
      for (const [k, v] of Object.entries(node)) out[k] = walk(v)
      return out
    }
    if (typeof node !== 'string') return node
    if (node === '{{PROMPT}}') return prompt
    if (node === '{{REF_IMAGE}}') return refImage ?? ''
    if (numeric[node] !== undefined) return numeric[node]
    let text = node.replaceAll('{{PROMPT}}', prompt).replaceAll('{{REF_IMAGE}}', refImage ?? '')
    for (const [token, value] of Object.entries(numeric)) text = text.replaceAll(token, String(value))
    return text
  }
  return walk(workflow)
}

/** mock 假后端：程序化画一只薄荷团子（首帧透明背景走 alpha 直通，其余实底走色度键），全管线真实跑 */
function mockGenerate(job) {
  const { size, stateId, frameIndex, count, seed } = job
  const rand = mulberry32(seed)
  const rgba = Buffer.alloc(size * size * 4)
  const transparentBg = stateId === 'idle' && frameIndex === 0
  if (!transparentBg) {
    const bg = 226 + Math.floor(rand() * 12)
    for (let i = 0; i < size * size; i++) {
      rgba[i * 4] = bg
      rgba[i * 4 + 1] = bg
      rgba[i * 4 + 2] = bg + 6
      rgba[i * 4 + 3] = 255
    }
  }
  // 团子身体：随帧序做挤压呼吸的椭圆
  const squash = Math.sin((frameIndex / Math.max(1, count - 1 || 1)) * Math.PI * 2) * 0.1
  const cx = size / 2
  const cy = size * 0.62
  const rx = size * 0.3 * (1 + squash)
  const ry = size * 0.36 * (1 - squash * 0.6)
  const bodyFill = [127, 216, 196]
  const outline = [23, 96, 92]
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x - cx) / rx
      const ny = (y - cy) / ry
      const d = nx * nx + ny * ny
      if (d <= 1.15) {
        const at = (y * size + x) * 4
        const c = d > 0.82 ? outline : bodyFill
        rgba[at] = c[0]
        rgba[at + 1] = c[1]
        rgba[at + 2] = c[2]
        rgba[at + 3] = 255
      }
    }
  }
  // 表情：眼睛随帧开闭，嘴一个点
  const eyeY = Math.round(cy - ry * 0.25)
  const eyeClosed = frameIndex % 2 === 1
  for (const ex of [cx - rx * 0.35, cx + rx * 0.35]) {
    const r = eyeClosed ? 1 : Math.max(2, size * 0.03)
    for (let y = -r; y <= r; y++) {
      for (let x = -r; x <= r; x++) {
        if (x * x + y * y > r * r) continue
        const px = Math.round(ex + x)
        const py = eyeY + Math.round(y)
        if (px < 0 || px >= size || py < 0 || py >= size) continue
        const at = (py * size + px) * 4
        rgba[at] = 20
        rgba[at + 1] = 52
        rgba[at + 2] = 59
        rgba[at + 3] = 255
      }
    }
  }
  return encodePng(size, size, rgba)
}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
  const text = await res.text()
  return { status: res.status, text }
}

/** ComfyUI 通道：/prompt → WS executing(node=null)（异常退化轮询 /history）→ /view 取图；首帧垫图走 /upload/image */
function comfyBackend(config, log) {
  const { address } = config.backend
  const base = address.replace(/\/+$/, '')
  const clientId = `petpack-${config.seed}-${Math.random().toString(36).slice(2, 10)}`
  const timeoutMs = 300_000
  let refImageName = null // 首帧垫图：第一次生成后上传，后续帧复用

  async function waitViaWebSocket(promptId) {
    if (typeof WebSocket === 'undefined') throw new Error('运行时无原生 WebSocket')
    const wsUrl = base.replace(/^http/, 'ws') + `/ws?clientId=${encodeURIComponent(clientId)}`
    const ws = new WebSocket(wsUrl)
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WS 连接超时')), 15_000)
        ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
        ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WS 连接失败')) }, { once: true })
      })
    } catch (err) {
      try { ws.close() } catch { /* ignore */ }
      throw err
    }
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WS 等待 executing 超时')), timeoutMs)
        ws.addEventListener('message', (event) => {
          if (typeof event.data !== 'string') return // 二进制预览帧忽略
          let msg
          try {
            msg = JSON.parse(event.data)
          } catch {
            return
          }
          if (msg.type === 'executing' && msg.data?.node === null && (msg.data?.prompt_id === undefined || msg.data.prompt_id === promptId)) {
            clearTimeout(timer)
            resolve()
          }
        })
        ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WS 中途异常')) })
        ws.addEventListener('close', () => { clearTimeout(timer); reject(new Error('WS 提前关闭')) })
      })
    } finally {
      try { ws.close() } catch { /* ignore */ }
    }
  }

  async function waitViaPolling(promptId, log) {
    const deadline = Date.now() + timeoutMs
    let tries = 0
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000))
      tries++
      const res = await fetch(`${base}/history/${promptId}`)
      if (!res.ok) continue
      const history = await res.json()
      const entry = history?.[promptId]
      if (entry?.outputs && Object.keys(entry.outputs).length > 0) {
        log(`  轮询 /history 命中（第 ${tries} 次）`)
        return
      }
    }
    throw new Error(`轮询 /history 超时（${timeoutMs / 1000}s）`)
  }

  async function generate(job, log) {
    const { prompt, seed, size } = job
    let refImage = null
    if (refImageName === null && job.refBytes) {
      const form = new FormData()
      form.append('image', new Blob([job.refBytes], { type: 'image/png' }), `petpack-ref-${config.seed}.png`)
      form.append('overwrite', 'true')
      form.append('type', 'input')
      const res = await fetch(`${base}/upload/image`, { method: 'POST', body: form })
      if (!res.ok) throw new Error(`/upload/image 失败：HTTP ${res.status}`)
      const uploaded = await res.json()
      refImageName = uploaded.subfolder ? `${uploaded.name} [${uploaded.subfolder}]` : uploaded.name
      log(`  垫图已上传：${refImageName}`)
    }
    if (refImageName !== null) refImage = refImageName
    const filled = fillWorkflow(config.workflow, { prompt, seed, width: size, height: size, refImage })
    const res = await postJson(`${base}/prompt`, { prompt: filled, client_id: clientId })
    if (res.status !== 200) throw new Error(`/prompt 失败：HTTP ${res.status} ${res.text.slice(0, 300)}`)
    const { prompt_id: promptId } = JSON.parse(res.text)
    if (!promptId) throw new Error('/prompt 响应缺 prompt_id')
    let viaWs = true
    try {
      await waitViaWebSocket(promptId)
    } catch (err) {
      log(`  WS 退化轮询（${err.message}）`)
      viaWs = false
      await waitViaPolling(promptId, log)
    }
    const historyRes = await fetch(`${base}/history/${promptId}`)
    if (!historyRes.ok) throw new Error(`/history 取结果失败：HTTP ${historyRes.status}`)
    const history = await historyRes.json()
    const outputs = history?.[promptId]?.outputs ?? {}
    let imageRef = outputs[config.backend.outputNode]?.images?.[0]
    if (!imageRef) {
      for (const nodeOut of Object.values(outputs)) {
        if (nodeOut?.images?.length) {
          imageRef = nodeOut.images[0]
          log(`  outputNode ${config.backend.outputNode} 无图，回退节点首图`)
          break
        }
      }
    }
    if (!imageRef) throw new Error('history outputs 里没有任何图片')
    const viewUrl = `${base}/view?filename=${encodeURIComponent(imageRef.filename)}&subfolder=${encodeURIComponent(imageRef.subfolder ?? '')}&type=${encodeURIComponent(imageRef.type ?? 'output')}`
    const viewRes = await fetch(viewUrl)
    if (!viewRes.ok) throw new Error(`/view 取图失败：HTTP ${viewRes.status}`)
    return Buffer.from(await viewRes.arrayBuffer())
  }

  return { kind: 'comfyui', generate }
}

/** gptimage 通道：OpenAI images 形状（transparent + png + b64_json）；带首帧参考图 400/422 自动降级重试 */
function gptImageBackend(config) {
  const { endpoint, apiKeyEnv, model } = config.backend
  const size = config.backend.size ?? '1024x1024'

  function apiKey() {
    const key = process.env[apiKeyEnv]
    if (!key) throw new Error(`环境变量 ${apiKeyEnv} 未设置（apiKey 只从 env 读，不落盘不打印）`)
    return key
  }

  async function readImage(res) {
    const payload = await res.json()
    const item = payload?.data?.[0]
    if (item?.b64_json) return Buffer.from(item.b64_json, 'base64')
    if (item?.url) {
      const img = await fetch(item.url)
      if (!img.ok) throw new Error(`下载生成图失败：HTTP ${img.status}`)
      return Buffer.from(await img.arrayBuffer())
    }
    throw new Error(`响应缺 data[0].b64_json/url：${JSON.stringify(payload).slice(0, 300)}`)
  }

  async function generate(job, log) {
    const key = apiKey()
    const auth = { Authorization: `Bearer ${key}` }
    const common = { model, prompt: job.prompt, n: 1, size, background: 'transparent', output_format: 'png' }
    if (job.refBytes) {
      // 带首帧参考图（编辑形状 multipart）；400/422 降级为无参考纯生成
      const form = new FormData()
      for (const [k, v] of Object.entries(common)) form.append(k, String(v))
      form.append('image', new Blob([job.refBytes], { type: 'image/png' }), 'ref.png')
      const res = await fetch(endpoint, { method: 'POST', headers: auth, body: form })
      if (res.status === 400 || res.status === 422) {
        log(`  参考图被拒（HTTP ${res.status}），降级为无参考重试`)
      } else {
        if (!res.ok) throw new Error(`images 请求失败：HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
        return readImage(res)
      }
    }
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(common)
    })
    if (!res.ok) throw new Error(`images 请求失败：HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
    return readImage(res)
  }

  return { kind: 'gptimage', generate }
}

// ============================== 管线 ==============================

function frameJobs(config) {
  const counts = resolveFrameCounts(config.states)
  const jobs = []
  for (const stateId of STATE_IDS) {
    const count = counts[stateId]
    if (count === undefined) continue
    for (let i = 0; i < count; i++) jobs.push({ stateId, frameIndex: i, count })
  }
  return jobs
}

function framePrompt(config, job) {
  return `${config.stylePrompt}. Character: ${STATE_PROMPTS[job.stateId]}. Sprite animation frame ${job.frameIndex + 1} of ${job.count} for the "${job.stateId}" state. Single character, centered, full body visible.`
}

/** 全管线：配置 + 后端适配器 → outDir/<packId>/{pet.json, <state>-<n>.png}（临时目录 + rename 原子落盘） */
async function runPack(config, backend, log = console.log) {
  const [frameW, frameH] = config.frameSize
  const jobs = frameJobs(config)
  log(`生成 ${jobs.length} 帧（backend=${backend.kind}，genSize ${config.genSize}）→ ${path.join(config.outDir, config.packId)}`)
  const decoded = []
  let firstBytes = null
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i]
    const seed = config.seed + i // 帧种子确定性派生
    const name = `${job.stateId}-${job.frameIndex}`
    const bytes = await backend.generate({ ...job, seed, size: config.genSize, prompt: framePrompt(config, job), refBytes: firstBytes }, log)
    if (!firstBytes) firstBytes = bytes // 首帧留作后续帧垫图/参考图
    if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error(`${name}: 后端返回的不是 PNG`)
    const image = decodePng(bytes)
    log(`  ✓ ${name}.png ← ${image.width}×${image.height}`)
    let keyed = null
    if (config.removeBackground.enabled) {
      keyed = chromaKeyFlood(image.rgba, image.width, image.height, config.removeBackground.tolerance)
      log(`    去背：${keyed.reason}${keyed.keyed ? `，清了 ${keyed.removed}px` : ''}`)
    }
    decoded.push({ ...image, rgba: keyed ? keyed.rgba : image.rgba })
  }
  log(`统一缩放落位 ${frameW}×${frameH}（align=${config.align}）`)
  const canvases = fitFramesToCanvas(decoded, frameW, frameH, config.align)
  const manifest = buildManifest(resolveFrameCounts(config.states), config.frameSize, {
    seed: config.seed,
    stylePrompt: config.stylePrompt,
    backend: config.backendKind,
    generatedAt: new Date().toISOString()
  })
  const files = new Map()
  let index = 0
  for (const def of Object.values(manifest.states)) {
    for (let f = 0; f < def.frames.length; f++) {
      files.set(def.frames[f], encodePng(frameW, frameH, canvases[index]))
      index++
    }
  }
  files.set('pet.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'))
  const finalDir = path.join(config.outDir, config.packId)
  atomicWriteDir(finalDir, files)
  log(`落盘 ${files.size} 个文件 → ${finalDir}`)
  return { manifest, dir: finalDir }
}

/** 临时目录 + rename 原子落盘（同盘 shuffle：旧目录先挪走再换入，Windows 上 rename 不覆盖目录） */
function atomicWriteDir(finalDir, files) {
  const parent = path.dirname(finalDir)
  fs.mkdirSync(parent, { recursive: true })
  const tmp = path.join(parent, `.pet-pack-tmp-${path.basename(finalDir)}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(tmp)
  try {
    for (const [name, data] of files) fs.writeFileSync(path.join(tmp, name), data)
    let old
    if (fs.existsSync(finalDir)) {
      old = path.join(parent, `.pet-pack-old-${path.basename(finalDir)}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
      fs.renameSync(finalDir, old)
    }
    try {
      fs.renameSync(tmp, finalDir)
    } catch (err) {
      if (old) fs.renameSync(old, finalDir) // 换入失败把旧目录还回去
      throw err
    }
    if (old) fs.rmSync(old, { recursive: true, force: true })
  } finally {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// ============================== preview ==============================

/** 已生成的包 → 放大 4× 棋盘 contact sheet（outDir/<packId>-preview.png） */
function cmdPreview(config) {
  const dir = path.join(config.outDir, config.packId)
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, 'pet.json'), 'utf8'))
  } catch (err) {
    throw new Error(`读 ${dir}/pet.json 失败（先 run 生成包）：${err.message}`)
  }
  const frameNames = []
  for (const [stateId, def] of Object.entries(raw.states ?? {})) {
    for (const frame of def.frames ?? []) frameNames.push({ stateId, frame })
  }
  if (!frameNames.length) throw new Error('pet.json 里没有任何帧')
  const SCALE = 4
  const PAD = 12
  const CHECK = 8
  const cell = 64 * SCALE + PAD * 2
  const cols = Math.min(4, frameNames.length)
  const rows = Math.ceil(frameNames.length / cols)
  const width = cell * cols
  const height = cell * rows
  const buf = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4
      const gray = (Math.floor(x / CHECK) + Math.floor(y / CHECK)) % 2 === 0 ? 210 : 170
      buf[at] = buf[at + 1] = buf[at + 2] = gray
      buf[at + 3] = 255
    }
  }
  frameNames.forEach(({ stateId, frame }, index) => {
    const image = decodePng(fs.readFileSync(path.join(dir, frame)))
    const originX = (index % cols) * cell + PAD
    const originY = Math.floor(index / cols) * cell + PAD
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        if (image.rgba[(y * image.width + x) * 4 + 3] === 0) continue
        for (let dy = 0; dy < SCALE; dy++) {
          for (let dx = 0; dx < SCALE; dx++) {
            const at = ((originY + y * SCALE + dy) * width + (originX + x * SCALE + dx)) * 4
            const from = (y * image.width + x) * 4
            buf[at] = image.rgba[from]
            buf[at + 1] = image.rgba[from + 1]
            buf[at + 2] = image.rgba[from + 2]
            buf[at + 3] = 255
          }
        }
      }
    }
    console.log(`  ✓ ${stateId}/${frame}`)
  })
  const outPath = path.join(config.outDir, `${config.packId}-preview.png`)
  fs.mkdirSync(config.outDir, { recursive: true })
  fs.writeFileSync(outPath, encodePng(width, height, buf))
  console.log(`preview → ${outPath}`)
}

// ============================== 子命令 ==============================

const CONFIG_TEMPLATE = {
  packId: 'my-pet',
  outDir: 'out/pet-packs',
  frameSize: [64, 64],
  genSize: GEN_SIZE_DEFAULT,
  stylePrompt: 'cute round jelly blob mascot, mint green body, thick soft outline, flat shading, chibi, full body centered, plain solid light gray background, single character, game sprite frame',
  seed: 20260919,
  states: { idle: 3, walk: 4, fall: 2, dragged: 1, sleep: 2, happy: 2, think: 2, eat: 3 },
  removeBackground: { enabled: true, tolerance: 0.15 },
  align: 'bottom-center',
  backend: {
    gptimage: {
      endpoint: 'https://api.openai.com/v1/images/generations',
      apiKeyEnv: 'OPENAI_API_KEY',
      model: 'gpt-image-1',
      size: '1024x1024'
    }
  }
}

function cmdInit(configPath, force) {
  if (fs.existsSync(configPath) && !force) {
    throw new Error(`${configPath} 已存在（--force 覆盖）`)
  }
  fs.mkdirSync(path.dirname(path.resolve(configPath)), { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify(CONFIG_TEMPLATE, null, 2) + '\n', 'utf8')
  console.log(`✓ 配置模板 → ${configPath}`)
  console.log('  · backend 二选一：模板默认 gptimage；换 ComfyUI 把 backend 换成：')
  console.log('    "backend": { "comfyui": { "address": "http://127.0.0.1:8188", "workflowFile": "workflow-api.json", "outputNode": "9" } }')
  console.log('  · workflow 是 API 格式 JSON，占位符须为完整字符串值："{{PROMPT}}" "{{SEED}}" "{{WIDTH}}" "{{HEIGHT}}"，可选 "{{REF_IMAGE}}"（首帧垫图）')
  console.log('  · 下一步：node scripts/pet-pack.mjs validate，然后 run（加 --mock 可不联网跑全管线）')
}

function cmdValidate(configPath) {
  const config = loadConfig(configPath)
  const counts = resolveFrameCounts(config.states)
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log('✓ 配置合法')
  console.log(`  packId=${config.packId}  outDir=${config.outDir}`)
  console.log(`  状态帧数：${Object.entries(counts).map(([k, v]) => `${k}:${v}`).join('  ')}（共 ${total} 帧）`)
  console.log(`  去背=${config.removeBackground.enabled ? `on(tolerance=${config.removeBackground.tolerance})` : 'off'}  align=${config.align}  seed=${config.seed}`)
  console.log(`  backend=${config.backendKind}${config.backendKind === 'comfyui' ? ` @ ${config.backend.address}（workflow 占位符齐全）` : ` @ ${config.backend.endpoint}（apiKeyEnv=${config.backend.apiKeyEnv}）`}`)
}

async function cmdRun(configPath, mock) {
  const config = loadConfig(configPath)
  const backend = mock ? { kind: 'mock', generate: mockGenerate } : config.backendKind === 'comfyui' ? comfyBackend(config, console.log) : gptImageBackend(config)
  logBackend(config, backend, mock)
  const { dir } = await runPack(config, backend)
  console.log(`✓ 素材包完成：${dir}`)
  console.log(`  拷到桌宠 userData/pets/${config.packId}/（或直接在设置里换包）即可使用`)
}

function logBackend(config, backend, mock) {
  if (mock) console.log('backend=mock（假后端演示全管线，不联网）')
  else if (backend.kind === 'comfyui') console.log(`backend=comfyui @ ${config.backend.address}`)
  else console.log(`backend=gptimage @ ${config.backend.endpoint}（model=${config.backend.model}，apiKey 从 env:${config.backend.apiKeyEnv} 读，不打印）`)
}

// ============================== 入口 ==============================

function usage() {
  console.log(`AI 素材包生成 CLI（零依赖）

用法: node scripts/pet-pack.mjs <command> [options]

命令:
  init     写配置模板 pet-pack.config.json（--force 覆盖已有）
  validate 静态校验配置（不联网）
  run      全管线生成素材包 outDir/<packId>/（--mock 用假后端演示，不联网）
  preview  把已生成的包拼成放大棋盘 contact sheet 供目检

选项:
  --config <path>  配置文件路径（默认 ./pet-pack.config.json；outDir 相对配置文件目录解析）
  --mock           run 用内置假后端
  --force          init 覆盖已有配置`)
}

async function main(argv) {
  const args = argv.slice(2)
  const configIdx = args.indexOf('--config')
  const configPath = configIdx >= 0 ? path.resolve(args[configIdx + 1]) : path.resolve(DEFAULT_CONFIG_NAME)
  // 子命令不能是 --config 的取值（configIdx 缺省为 -1，此时不排除任何位置）
  const command = args.find((a, i) => !a.startsWith('--') && (configIdx === -1 || i !== configIdx + 1))
  const flags = args.filter((a) => a.startsWith('--'))
  if (!command || flags.includes('--help') || flags.includes('-h')) {
    usage()
    return
  }
  switch (command) {
    case 'init':
      return cmdInit(configPath, flags.includes('--force'))
    case 'validate':
      return cmdValidate(configPath)
    case 'run':
      return cmdRun(configPath, flags.includes('--mock'))
    case 'preview':
      return cmdPreview(loadConfig(configPath))
    default:
      throw new UsageError(`未知命令 '${command}'（init / validate / run / preview）`)
  }
}

class UsageError extends Error {}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) {
  main(process.argv).catch((err) => {
    console.error(err instanceof ConfigError ? `配置校验失败：\n${err.message}` : `✗ ${err.message}`)
    process.exit(err instanceof UsageError ? 2 : 1)
  })
}

export { CORE_STATE_IDS, EXTRA_STATE_IDS, STATE_IDS, ConfigError, UsageError, buildManifest, chromaKeyFlood, configErrors, contentBBox, decodePng, encodePng, fillWorkflow, fitFramesToCanvas, loadConfig, mockGenerate, mulberry32, resizeRGBA, resolveFrameCounts, runPack }
