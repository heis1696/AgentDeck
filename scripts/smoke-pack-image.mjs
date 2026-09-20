// pack-image 纯函数冒烟：esbuild 直连 src/main/pet/pet-pack 图像管线（主进程与 CLI 同源实现）——
// PNG 往返、alpha 加权重采样、四角 flood-fill 去背连通性、全帧公共 scale contain 落位、
// sheet 网格切帧、manifest 构建过 validatePetManifest 反校验。
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')

async function bundle(entry, name) {
  const outfile = path.join(root, 'out', name)
  await build({ entryPoints: [path.join(root, entry)], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
  return import(pathToFileURL(outfile).href)
}
const img = await bundle('src/main/pet/pack-image.ts', 'smoke-pack-image.cjs')
const pet = await bundle('src/shared/pet.ts', 'smoke-pack-image-pet.cjs')

let failed = 0
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) failed++ }

console.log('—— PNG 编解码往返 ——')
{
  const rgba = Buffer.alloc(16 * 16 * 4)
  for (let i = 0; i < 16 * 16; i++) { rgba[i * 4] = 200; rgba[i * 4 + 1] = 30; rgba[i * 4 + 2] = i % 256; rgba[i * 4 + 3] = i % 3 === 0 ? 0 : 255 }
  const back = img.decodePng(img.encodePng(16, 16, rgba))
  ok(back.width === 16 && back.height === 16 && back.rgba.equals(rgba), 'encodePng → decodePng 无损往返')
  let threw = false
  try { img.decodePng(Buffer.from('not a png')) } catch { threw = true }
  ok(threw, '非 PNG 输入抛错')
}

console.log('—— resizeRGBA：alpha 加权盒式重采样 ——')
{
  // 2×1：左像素不透明红、右像素全透明 → 缩成 1×1 应得纯红且不透明（透明侧不晕染色与 alpha）
  const src = Buffer.alloc(2 * 1 * 4)
  src[0] = 255; src[2] = 0; src[3] = 255
  src[4] = 255; src[5] = 0; src[6] = 0; src[7] = 0
  const out = img.resizeRGBA(src, 2, 1, 1, 1)
  ok(out[0] === 255 && out[1] === 0 && out[2] === 0 && out[3] === 128, `alpha 加权（半透明红 r=${out[0]} a=${out[3]}）`)
}

console.log('—— chromaKeyFlood：四角连通去背，内部同色不受牵连 ——')
{
  // 32×32 浅灰背景 + 中央绿色方块 + 方块中央一枚与背景同色的像素（被绿色包住，不得被清）
  const S = 32
  const rgba = Buffer.alloc(S * S * 4)
  for (let i = 0; i < S * S; i++) { rgba[i * 4] = 210; rgba[i * 4 + 1] = 210; rgba[i * 4 + 2] = 214; rgba[i * 4 + 3] = 255 }
  for (let y = 10; y < 22; y++) for (let x = 10; x < 22; x++) {
    const at = (y * S + x) * 4
    rgba[at] = 60; rgba[at + 1] = 200; rgba[at + 2] = 120
  }
  const hole = (16 * S + 16) * 4
  rgba[hole] = 210; rgba[hole + 1] = 210; rgba[hole + 2] = 214
  const result = img.chromaKeyFlood(rgba, S, S, 0.15)
  ok(result.keyed && result.removed > 0, `去背生效（清了 ${result.removed}px：${result.reason}）`)
  ok(rgba[3] === 0 && rgba[(S * S - 1) * 4 + 3] === 0, '四角被清透明')
  ok(rgba[(11 * S + 11) * 4 + 3] === 255, '绿色方块保留')
  ok(rgba[hole + 3] === 255, '方块内部与背景同色的像素不被牵连（连通性）')
}

console.log('—— fitFramesToCanvas：全帧公共 scale + bottom-center 落位 ——')
{
  const mk = (size, content) => {
    const rgba = Buffer.alloc(size * size * 4)
    const at = ((size - content) / 2) | 0
    for (let y = at; y < at + content; y++) for (let x = at; x < at + content; x++) {
      const o = (y * size + x) * 4
      rgba[o] = 10; rgba[o + 1] = 200; rgba[o + 2] = 90; rgba[o + 3] = 255
    }
    return { width: size, height: size, rgba }
  }
  const big = mk(64, 60)   // 内容 60px → contain scale 64/60 ≈ 1.07 → 封顶 1
  const small = mk(64, 30) // 内容 30px → 保持原大（公共 scale 取最小且 ≤1）
  const [a, b] = img.fitFramesToCanvas([big, small], 64, 64, 'bottom-center')
  const bottomRow = (canvas) => {
    let count = 0
    for (let x = 0; x < 64; x++) if (canvas[(61 * 64 + x) * 4 + 3] > 0) count++ // 内容末行 = 64 - 2(BOTTOM_PAD) - 1
    return count
  }
  ok(bottomRow(a) > 0 && bottomRow(b) > 0, '两帧都 bottom-center 落到同一脚底线')
  let emptyTail = true
  for (let y = 62; y < 64 && emptyTail; y++) for (let x = 0; x < 64; x++) if (a[(y * 64 + x) * 4 + 3] > 0) { emptyTail = false; break }
  ok(emptyTail, '脚底留白 2px')
  const widthAt = (canvas) => {
    let minX = 64, maxX = -1
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if (canvas[(y * 64 + x) * 4 + 3] > 0) { if (x < minX) minX = x; if (x > maxX) maxX = x }
    return maxX - minX + 1
  }
  ok(widthAt(a) === 60 && widthAt(b) === 30, `公共 scale=1 时内容尺寸保持（60/30 got ${widthAt(a)}/${widthAt(b)}）`)
  // 缩放情形：128px 图塞 64 画布 → 公共 scale = 64/120 ≈ 0.533，内容 120/60 → 64/32（同比例缩放）
  const huge = mk(128, 120)
  const hugeSmall = mk(128, 60)
  const [c, d] = img.fitFramesToCanvas([huge, hugeSmall], 64, 64, 'bottom-center')
  ok(Math.abs(widthAt(c) - 64) <= 2 && Math.abs(widthAt(d) - 32) <= 2, `公共 scale 0.533 统一缩放（got ${widthAt(c)}/${widthAt(d)}）`)
}

console.log('—— splitSheet：网格切帧行主序 ——')
{
  // 128×128 四象限各一色 → 2×2 切帧应按 左上/右上/左下/右下 返回
  const S = 128
  const rgba = Buffer.alloc(S * S * 4)
  const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]]
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const at = (y * S + x) * 4
    const c = colors[(y >= 64 ? 2 : 0) + (x >= 64 ? 1 : 0)]
    rgba[at] = c[0]; rgba[at + 1] = c[1]; rgba[at + 2] = c[2]; rgba[at + 3] = 255
  }
  const cells = img.splitSheet({ width: S, height: S, rgba }, 2, 2)
  ok(cells.length === 4, `切出 4 格（got ${cells.length}）`)
  const center = (cell) => {
    const o = (32 * 64 + 32) * 4
    return [cell.rgba[o], cell.rgba[o + 1], cell.rgba[o + 2]]
  }
  const [tl, tr, bl, br] = cells
  const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
  ok(same(center(tl), [255, 0, 0]) && same(center(tr), [0, 255, 0]), '行主序：第一行 = cell1 左上 / cell2 右上')
  ok(same(center(bl), [0, 0, 255]) && same(center(br), [255, 255, 0]), '行主序：第二行 = cell3 左下 / cell4 右下')
  let threw = false
  try { img.splitSheet({ width: 10, height: 10, rgba }, 16, 16) } catch { threw = true }
  ok(threw, '图小于网格抛错')
}

console.log('—— resolveFrameCounts / buildManifest → validatePetManifest 反校验 ——')
{
  const counts = img.resolveFrameCounts({ happy: 3 })
  ok(counts.idle === 3 && counts.walk === 4 && counts.dragged === 1 && counts.happy === 3, '七态缺省补齐 + 显式覆盖')
  ok(counts.eat === undefined, 'eat 缺省不补')
  const withEat = img.resolveFrameCounts({ eat: 2 })
  ok(withEat.eat === 2, 'eat 显式给出即进包')
  const manifest = img.buildManifest(counts, [64, 64], { seed: 1, stylePrompt: 'x', backend: 'gptimage' })
  const validated = pet.validatePetManifest(manifest)
  ok(validated !== null, 'manifest 过 validatePetManifest')
  ok(validated && validated.frameSize[0] === 64 && validated.states.happy.frames.length === 3, 'frameSize/帧文件名与帧数表一致')
  ok(manifest._meta && manifest._meta.stylePrompt === 'x', '_meta 顶层扩展字段保留')
  const manifestEat = pet.validatePetManifest(img.buildManifest(withEat, [64, 64], {}))
  ok(manifestEat !== null && manifestEat.states.eat.frames.length === 2, '含 eat 的 manifest 同样过校验')
}

if (failed) { console.error(`\n❌ PACK IMAGE SMOKE FAILED (${failed})`); process.exit(1) }
console.log('\n✅ PACK IMAGE SMOKE PASSED')
