// 生成应用图标：纯 Node 画 256x256 PNG（锚形标志），打包成 .ico（PNG 内嵌）
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'

const SIZE = 256

// ---- 画布：深色圆角底 + 蓝色圆环 + 白色锚身 ----
const px = new Uint8Array(SIZE * SIZE * 4)

function set(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return
  const i = (y * SIZE + x) * 4
  const na = a / 255
  const oa = px[i + 3] / 255
  const outA = na + oa * (1 - na)
  if (outA <= 0) return
  px[i] = Math.round((r * na + px[i] * oa * (1 - na)) / outA)
  px[i + 1] = Math.round((g * na + px[i + 1] * oa * (1 - na)) / outA)
  px[i + 2] = Math.round((b * na + px[i + 2] * oa * (1 - na)) / outA)
  px[i + 3] = Math.round(outA * 255)
}

const BG = [15, 17, 21] // #0f1115
const ACCENT = [79, 140, 255] // #4f8cff
const WHITE = [230, 233, 239]

// 圆角矩形底
const radius = 56
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const dx = Math.max(radius - x, x - (SIZE - 1 - radius), 0)
    const dy = Math.max(radius - y, y - (SIZE - 1 - radius), 0)
    const d = Math.hypot(dx, dy)
    if (d <= radius) set(x, y, ...BG, d > radius - 1.5 ? Math.max(0, (radius - d) / 1.5) * 255 : 255)
  }
}

// 蓝色渐变圆环（锚环）
const cx = 128, cy = 118, ringR = 34, ringW = 13
for (let y = cy - ringR - ringW; y <= cy + ringR + ringW; y++) {
  for (let x = cx - ringR - ringW; x <= cx + ringR + ringW; x++) {
    const d = Math.hypot(x - cx, y - cy)
    if (Math.abs(d - ringR) <= ringW / 2) {
      const t = (y - (cy - ringR)) / (2 * ringR)
      const c = [ACCENT[0] + (255 - ACCENT[0]) * 0.25 * t, ACCENT[1] + (255 - ACCENT[1]) * 0.25 * t, 255]
      set(Math.round(x), Math.round(y), ...c.map(Math.round))
    }
  }
}

// 锚杆 + 两侧锚臂 + 底部横杆
const bar = (x0, y0, x1, y1, w, color) => {
  const len = Math.hypot(x1 - x0, y1 - y0)
  for (let i = 0; i <= len; i++) {
    const t = i / len
    const bx = x0 + (x1 - x0) * t
    const by = y0 + (y1 - y0) * t
    for (let oy = -w / 2; oy <= w / 2; oy++) {
      for (let ox = -w / 2; ox <= w / 2; ox++) {
        set(Math.round(bx + ox), Math.round(by + oy), ...color)
      }
    }
  }
}
bar(128, 152, 128, 210, 14, WHITE) // 主杆
bar(128, 160, 86, 196, 10, WHITE) // 左臂
bar(128, 160, 170, 196, 10, WHITE) // 右臂
bar(88, 214, 168, 214, 10, WHITE) // 底横
// 环内小点
for (let y = cy - 8; y <= cy + 8; y++)
  for (let x = cx - 8; x <= cx + 8; x++) if (Math.hypot(x - cx, y - cy) <= 8) set(x, y, ...WHITE)

// ---- PNG 编码 ----
function crc32(buf) {
  let c, table = crc32.table
  if (!table) {
    table = crc32.table = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c
    }
  }
  c = 0 ^ -1
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ table[(c ^ buf[i]) & 0xff]
  return (c ^ -1) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0
  Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1)
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

const outDir = path.resolve(import.meta.dirname, '..', 'build')
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'icon.png'), png)

// ---- ICO（内嵌 PNG）----
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4) // 0,1个图
const entry = Buffer.alloc(16)
entry[0] = 0; entry[1] = 0 // 256
entry[2] = 0; entry[3] = 0
entry[4] = 1; entry[5] = 32 // 32bpp
entry.writeUInt32LE(png.length, 8)
entry.writeUInt32LE(6 + 16, 12)
fs.writeFileSync(path.join(outDir, 'icon.ico'), Buffer.concat([header, entry, png]))
console.log('icon.png + icon.ico written to build/ (' + png.length + ' bytes png)')
