// 桌宠内置素材包生成器（零依赖，node:zlib 手写最小 PNG 编码器）。
// 原创薄荷青 blob 生物「薄荷团子」：脚本内 ASCII 像素块 + 程序合成 16 帧，
// 输出到 src/renderer/src/pet/assets/default/（走 vite 资产管线；顶层 assets/ 不在
// 热更 zip 与 electron-builder files 里，故不放那里）。生成物入库，脚本不进构建链。
//
// 用法：
//   node scripts/gen-pet-assets.mjs            # 生成 16 帧 PNG
//   node scripts/gen-pet-assets.mjs --preview  # 额外输出 out/pet-preview.png 放大棋盘拼图供目检
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'

const GRID = 16          // ASCII 网格边长（格）
const CELL = 4           // 每格像素（px）
const FRAME = GRID * CELL // 64px 帧边长
const OUT_DIR = path.resolve(import.meta.dirname, '../src/renderer/src/pet/assets/default')
const PREVIEW_PATH = path.resolve(import.meta.dirname, '../out/pet-preview.png')

// ---- 调色板（原创配色：薄荷青本体 + 深青描边）----
const PALETTE = {
  '.': [0, 0, 0, 0],            // 透明
  o: [23, 96, 92, 255],         // 描边：深青
  b: [127, 216, 196, 255],      // 本体：薄荷青
  d: [88, 184, 164, 255],       // 本体暗部
  h: [214, 247, 238, 255],      // 高光
  e: [20, 52, 59, 255],         // 眼睛/瞳孔
  w: [244, 255, 251, 255],      // 眼白
  m: [29, 75, 79, 255],         // 嘴
  p: [244, 169, 184, 255],      // 腮红
  z: [191, 241, 228, 255]       // 睡眠 zzz
}

// ---- 最小 PNG 编码器：RGBA8 + deflate + CRC32 ----
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

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 6   // color type: RGBA
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))])
}

// ---- ASCII 像素块 → RGBA 帧 ----
// 每行必须恰好 16 字符；非法立即报帧名与行号，避免静默画歪。
function asciiToRgba(rows, name) {
  if (rows.length !== GRID) throw new Error(`${name}: 需要 ${GRID} 行，实得 ${rows.length}`)
  const buf = Buffer.alloc(FRAME * FRAME * 4)
  rows.forEach((row, gy) => {
    if (row.length !== GRID) throw new Error(`${name} 第 ${gy} 行宽度 ${row.length} ≠ ${GRID}：${row}`)
    for (let gx = 0; gx < GRID; gx++) {
      const color = PALETTE[row[gx]]
      if (!color) throw new Error(`${name} 第 ${gy} 行非法字符 '${row[gx]}'：${row}`)
      for (let dy = 0; dy < CELL; dy++) {
        for (let dx = 0; dx < CELL; dx++) {
          const x = gx * CELL + dx
          const y = gy * CELL + dy
          const at = (y * FRAME + x) * 4
          buf[at] = color[0]; buf[at + 1] = color[1]; buf[at + 2] = color[2]; buf[at + 3] = color[3]
        }
      }
    }
  })
  return buf
}

// 在帧上盖章单个 ASCII 字符（睡眠 zzz 等程序化叠加用）
function put(rows, x, y, ch) {
  const next = [...rows]
  next[y] = next[y].slice(0, x) + ch + next[y].slice(x + 1)
  return next
}

// ---- 行片段库（全部 16 字符宽）----
const E = '................'
const HEAD = '.....oooooo.....'   // 头顶描边 / 底部收口
const UPPER = '...ohhbbbbbbo...'   // 肩线（带高光）
const WIDE = '..obbbbbbbbbbo..'   // 最宽体侧
const LOWER = '...obbbbbbbbo...'   // 收腰
const BASE = '....obbbbbbo....'   // 底盘
const EYES_OPEN_T = '..obbwebbwebbo..' // 睁眼上行（眼白+瞳）
const EYES_OPEN_B = '..obbeebbeebbo..' // 睁眼下行
const EYES_SHUT = '..obbddbbddbbo..'   // 眨眼（暗部线）
const EYES_HAPPY = '..obbeebbeebbo..'   // 眯眼笑
const EYES_WIDE = '..obbwwbbwwbbo..'   // 大眼（惊）
const EYES_LEFT = '..obbewbbewbbo..'   // 瞳孔看左（思考）
const CHEEKS = '..obpbbbbbbpbo..'    // 腮红
const MOUTH_CALM = '..obbbbmmbbbbo..'   // 平静小嘴
const MOUTH_O = '..obbbboobbbbo..'     // 惊讶 o 嘴
const MOUTH_TINY = '..obbbbmbbbbbo..'   // 单点小嘴（睡/思考）
const MOUTH_GRIN_T = '..obbbmwwmbbbo..'  // 开口笑上行（露牙）
const MOUTH_GRIN_B = '..obbbmmmmbbbo..'  // 开口笑下行
const MOUTH_LOWER = '...obmmbbbbbo...'    // 收腰行的抿嘴
const FEET_STRIDE_R = '...oo.......oo..'  // 迈步（右）
const FEET_STRIDE_L = '..oo.......oo...'   // 迈步（左）
const FEET_TOGETHER = '....oo....oo....'   // 并脚

// 常规站姿体段（行 3-13）：头3 肩4 宽5-10 收11 底12 脚线13
function bodyStanding(eyes) {
  return {
    3: HEAD, 4: UPPER, 5: WIDE, 6: eyes[0], 7: eyes[1], 8: CHEEKS, 9: MOUTH_CALM, 10: WIDE,
    11: LOWER, 12: BASE, 13: HEAD
  }
}

function assemble(parts) {
  const rows = Array(GRID).fill(E)
  for (const [row, value] of Object.entries(parts)) rows[Number(row)] = value
  return rows
}

// ---- 16 帧定义（idle3 / walk4 / fall2 / dragged1 / sleep2 / happy2 / think2）----
const FRAMES = [
  // —— idle：呼吸（常规 → 压缩 1 格 → 常规眨眼）——
  ['idle-0', assemble(bodyStanding([EYES_OPEN_T, EYES_OPEN_B]))],
  ['idle-1', assemble({
    4: HEAD, 5: UPPER, 6: EYES_OPEN_T, 7: EYES_OPEN_B, 8: MOUTH_CALM, 9: WIDE,
    10: LOWER, 11: BASE, 12: HEAD
  })],
  ['idle-2', assemble({ ...bodyStanding([WIDE, EYES_SHUT]) })],

  // —— walk：抬脚 + 身体起伏四拍 ——
  ['walk-0', assemble(bodyWalking(FEET_STRIDE_R, 13))],
  ['walk-1', assemble(bodyWalking(FEET_TOGETHER, 11, true))],
  ['walk-2', assemble(bodyWalking(FEET_STRIDE_L, 13))],
  ['walk-3', assemble(bodyWalking(FEET_TOGETHER, 11, true))],

  // —— fall：拉长身体 + 侧臂上扬，睁大眼 → 紧闭眼 ——
  ['fall-0', assembleWithArms({
    2: HEAD, 3: UPPER, 4: WIDE, 5: EYES_WIDE, 6: EYES_OPEN_B, 7: WIDE, 8: MOUTH_O, 9: CHEEKS, 10: WIDE,
    11: LOWER, 12: BASE, 13: HEAD
  }, 4)],
  ['fall-1', assembleWithArms({
    2: HEAD, 3: UPPER, 4: WIDE, 5: EYES_SHUT, 6: WIDE, 7: WIDE, 8: MOUTH_O, 9: CHEEKS, 10: WIDE,
    11: LOWER, 12: BASE, 13: HEAD
  }, 4)],

  // —— dragged：被拎起（离地悬空 + 大眼睛）——
  ['dragged-0', assemble({
    5: HEAD, 6: UPPER, 7: EYES_WIDE, 8: EYES_OPEN_B, 9: MOUTH_O, 10: LOWER, 11: BASE, 12: HEAD
  })],

  // —— sleep：闭眼小嘴 + 漂浮 zzz（程序化盖章两档）——
  ['sleep-0', putZ(assemble({
    3: HEAD, 4: UPPER, 5: WIDE, 6: WIDE, 7: EYES_SHUT, 8: WIDE, 9: MOUTH_TINY, 10: WIDE,
    11: LOWER, 12: BASE, 13: HEAD
  }), 12, 1)],
  ['sleep-1', putZ(assemble({
    3: HEAD, 4: UPPER, 5: WIDE, 6: WIDE, 7: EYES_SHUT, 8: WIDE, 9: MOUTH_TINY, 10: WIDE,
    11: LOWER, 12: BASE, 13: HEAD
  }), 13, 2)],

  // —— happy：眯眼笑 + 开口 + 侧臂上扬，常规 / 跳起 ——
  ['happy-0', assembleWithArms({
    3: HEAD, 4: UPPER, 5: WIDE, 6: EYES_HAPPY, 7: WIDE, 8: CHEEKS, 9: MOUTH_GRIN_T, 10: MOUTH_GRIN_B,
    11: LOWER, 12: BASE, 13: HEAD
  }, 4)],
  ['happy-1', assembleWithArms({
    2: HEAD, 3: UPPER, 4: WIDE, 5: EYES_HAPPY, 6: WIDE, 7: MOUTH_GRIN_T, 8: MOUTH_GRIN_B,
    9: LOWER, 10: BASE, 11: HEAD
  }, 3)],

  // —— think：瞳孔看左 / 看右 + 抿嘴 ——
  ['think-0', assemble({
    3: HEAD, 4: UPPER, 5: WIDE, 6: EYES_LEFT, 7: EYES_LEFT, 8: CHEEKS, 9: MOUTH_TINY, 10: WIDE,
    11: LOWER, 12: BASE, 13: HEAD
  })],
  ['think-1', assemble({
    3: HEAD, 4: UPPER, 5: WIDE, 6: EYES_OPEN_T, 7: EYES_OPEN_B, 8: CHEEKS, 9: MOUTH_TINY, 10: WIDE,
    11: LOWER, 12: BASE, 13: HEAD
  })]
]

// walk 体段：抬步帧（脚在 13 行）与并脚压缩帧（脚在 11 行，身体上收制造起伏）
function bodyWalking(feet, feetRow, compressed = false) {
  if (!compressed) {
    return {
      2: HEAD, 3: UPPER, 4: WIDE, 5: EYES_OPEN_T, 6: EYES_OPEN_B, 7: CHEEKS, 8: MOUTH_CALM, 9: WIDE,
      10: LOWER, 11: BASE, 12: HEAD, [feetRow]: feet
    }
  }
  return {
    3: HEAD, 4: UPPER, 5: EYES_OPEN_T, 6: EYES_OPEN_B, 7: MOUTH_CALM, 8: LOWER, 9: BASE, 10: HEAD,
    [feetRow]: feet
  }
}

// 侧臂上扬：肩线与体侧各叠 1 格描边（(1,r)/(14,r) 与 (1,r+1)/(14,r+1) 两段竖臂）
function assembleWithArms(parts, armRow) {
  let rows = assemble(parts)
  for (const [x, y] of [[1, armRow], [14, armRow], [1, armRow + 1], [14, armRow + 1]]) rows = put(rows, x, y, 'o')
  return rows
}

// 3 行 Z 字形 glyphs（zzz / .z. / zzz）盖章在头部右上
function putZ(rows, x, y) {
  let next = rows
  next = put(next, x, y, 'z'); next = put(next, x + 1, y, 'z'); next = put(next, x + 2, y, 'z')
  next = put(next, x + 1, y + 1, 'z')
  next = put(next, x, y + 2, 'z'); next = put(next, x + 1, y + 2, 'z'); next = put(next, x + 2, y + 2, 'z')
  return next
}

// ---- 输出 ----
const preview = process.argv.includes('--preview')
fs.mkdirSync(OUT_DIR, { recursive: true })
for (const [name, rows] of FRAMES) {
  const png = encodePng(FRAME, FRAME, asciiToRgba(rows, name))
  fs.writeFileSync(path.join(OUT_DIR, `${name}.png`), png)
  console.log(`  ✓ ${name}.png (${png.length} bytes)`)
}
console.log(`\n${FRAMES.length} 帧 → ${path.relative(process.cwd(), OUT_DIR)}`)

// --preview：4×4 拼图，每帧 3 倍放大 + 棋盘底（透明确认用）
if (preview) {
  const SCALE = 3
  const PAD = 8
  const CHECK = 8
  const cell = FRAME * SCALE + PAD * 2
  const width = cell * 4
  const height = cell * 4
  const buf = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const checker = (Math.floor(x / CHECK) + Math.floor(y / CHECK)) % 2 === 0
      const at = (y * width + x) * 4
      const gray = checker ? 210 : 170
      buf[at] = gray; buf[at + 1] = gray; buf[at + 2] = gray; buf[at + 3] = 255
    }
  }
  FRAMES.forEach(([name], index) => {
    const col = index % 4
    const row = Math.floor(index / 4)
    const originX = col * cell + PAD
    const originY = row * cell + PAD
    // 手工解 IDAT 太绕：直接从 ASCII 行再渲一份（同一来源，必然一致）
    const rgba = asciiToRgba(FRAMES[index][1], name)
    for (let y = 0; y < FRAME; y++) {
      for (let x = 0; x < FRAME; x++) {
        const src = (y * FRAME + x) * 4
        if (rgba[src + 3] === 0) continue
        for (let dy = 0; dy < SCALE; dy++) {
          for (let dx = 0; dx < SCALE; dx++) {
            const at = ((originY + y * SCALE + dy) * width + (originX + x * SCALE + dx)) * 4
            buf[at] = rgba[src]; buf[at + 1] = rgba[src + 1]; buf[at + 2] = rgba[src + 2]; buf[at + 3] = 255
          }
        }
      }
    }
  })
  fs.mkdirSync(path.dirname(PREVIEW_PATH), { recursive: true })
  fs.writeFileSync(PREVIEW_PATH, encodePng(width, height, buf))
  console.log(`preview → ${path.relative(process.cwd(), PREVIEW_PATH)}`)
}
