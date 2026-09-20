// 素材包生成 PetGenController 冒烟（按态八表版，规格 docs/plan/pet-pack-ai-generation.md §4/§6）：
// esbuild 直连 src/main/pet/pet-gen.ts，注入 fetch mock——
// 断言洋红模板铁律逐条进请求体、调用序列恰为 1×generations + 7×edits 且 edits 携带 idle 锚点字节、
// 帧源 256px、180s 超时与 3 次退避重试（mock 504）、QC 四角洋红/空帧校验与自动重试、取消中途生效、
// 落盘 pet.json 过 validatePetManifest，以及 apiKey 绝不出现在任何事件/落盘内容里。
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const root = path.resolve(import.meta.dirname, '..')

async function bundle(entry, name) {
  const outfile = path.join(root, 'out', name)
  await build({ entryPoints: [path.join(root, entry)], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
  return import(pathToFileURL(outfile).href)
}
const genmod = await bundle('src/main/pet/pet-gen.ts', 'smoke-pet-gen.cjs')
const pet = await bundle('src/shared/pet.ts', 'smoke-pet-gen-pet.cjs')
const img = await bundle('src/main/pet/pack-image.ts', 'smoke-pet-gen-img.cjs')

let failed = 0
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) failed++ }

const SECRET = 'sk-gen-smoke-secret-xyz'
const PRESET = { id: 'p1', name: 'Gen Smoke', backend: 'zcode', baseURL: 'http://gen.test/v1', apiKey: SECRET, createdAt: 0 }
const SEVEN_STATES = { idle: 1, walk: 1, fall: 1, dragged: 1, sleep: 1, happy: 1, think: 1 }
const EIGHT_STATES = { idle: 3, walk: 4, fall: 2, dragged: 1, sleep: 2, happy: 2, think: 2, eat: 3 }
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

console.log('—— 常量契约：帧源 256 / 180s 超时 / 3 次重试 / 空帧阈值 ——')
ok(JSON.stringify(genmod.PET_GEN_FRAME_SIZE) === '[256,256]', `PET_GEN_FRAME_SIZE = [256,256]（got ${JSON.stringify(genmod.PET_GEN_FRAME_SIZE)}）`)
ok(genmod.GEN_TIMEOUT_MS === 180_000, `单请求超时 180s（got ${genmod.GEN_TIMEOUT_MS}）`)
ok(genmod.SHEET_RETRIES === 3, `每张 sheet 重试 3 次（got ${genmod.SHEET_RETRIES}）`)
ok(genmod.SHEET_RETRY_BACKOFF_MS === 5_000, `退避基数 5s×attempt（got ${genmod.SHEET_RETRY_BACKOFF_MS}）`)
ok(genmod.SHEET_EMPTY_CELL_RATIO === 0.05, `空帧判定阈值 5%（got ${genmod.SHEET_EMPTY_CELL_RATIO}）`)

console.log('—— 端点候选：generations / edits 归一 ——')
ok(JSON.stringify(genmod.genEndpointCandidates('http://x.test/v1/')) === JSON.stringify(['http://x.test/images/generations', 'http://x.test/v1/images/generations']), '裸 /v1 → 双候选')
ok(JSON.stringify(genmod.genEndpointCandidates('http://x.test/v1/images/generations')) === JSON.stringify(['http://x.test/v1/images/generations']), '完整端点直用')
ok(JSON.stringify(genmod.editEndpointCandidates('http://x.test/v1')) === JSON.stringify(['http://x.test/images/edits', 'http://x.test/v1/images/edits']), 'edits 裸 /v1 → 双候选')
ok(JSON.stringify(genmod.editEndpointCandidates('http://x.test/v1/images/generations')) === JSON.stringify(['http://x.test/v1/images/edits']), 'generations 端点换出 edits')
ok(JSON.stringify(genmod.editEndpointCandidates('http://x.test/v1/images/edits')) === JSON.stringify(['http://x.test/v1/images/edits']), 'edits 完整端点直用')

console.log('—— buildGenBody / buildSheetBody：请求体形状（不含 apiKey）——')
{
  const body = genmod.buildGenBody('gpt-image-1', 'prompt text', { size: '512x512', quality: 'high', n: 2, background: 'transparent' })
  ok(body.model === 'gpt-image-1' && body.prompt === 'prompt text' && body.n === 2, 'model/prompt/n 透传')
  ok(body.size === '512x512' && body.background === 'transparent' && body.output_format === 'png', 'size/background/output_format 形状')
  ok(body.quality === 'high' && !JSON.stringify(body).includes('apiKey'), 'quality 透传且无 key 字段')
  const minimal = genmod.buildGenBody('m', 'p', { size: 's', quality: '', n: 1, background: 'opaque' })
  ok(minimal.quality === undefined && minimal.background === 'opaque', '空 quality 不下发；opaque 透传')
  const sheetBody = genmod.buildSheetBody('gpt-image-1', 'sheet prompt', '1536x1024', 'medium')
  ok(sheetBody.model === 'gpt-image-1' && sheetBody.prompt === 'sheet prompt' && sheetBody.n === 1 && sheetBody.size === '1536x1024', 'sheet 请求体：n=1 + 网格比例 size')
  ok(sheetBody.quality === 'medium' && sheetBody.output_format === 'png', 'sheet 请求体：quality/output_format')
  ok(!('background' in sheetBody), 'sheet 请求体不下发 background（洋红底靠 prompt，透明了 QC 四角必炸）')
  ok(genmod.buildSheetBody('m', 'p', '1024x1024', '').quality === undefined, 'sheet 空 quality 不下发')
}

console.log('—— 网格换算：§4.1 默认表 + 帧数联动 + size 比例映射 ——')
{
  const GRID41 = { idle: [3, 1], walk: [2, 2], fall: [2, 1], dragged: [1, 1], sleep: [2, 1], happy: [2, 1], think: [2, 1], eat: [3, 1] }
  const defaultFrames = { idle: 3, walk: 4, fall: 2, dragged: 1, sleep: 2, happy: 2, think: 2, eat: 3 }
  for (const [id, [cols, rows]] of Object.entries(GRID41)) {
    const grid = pet.petSheetGridFor(defaultFrames[id])
    ok(grid.cols === cols && grid.rows === rows, `${id} ${defaultFrames[id]} 帧 → ${rows}×${cols} 网格（§4.1 默认表）`)
    ok(grid.cols * grid.rows >= defaultFrames[id], `${id} 网格容量 ≥ 帧数（帧数=rows×cols 换算契约）`)
  }
  ok(pet.petSheetGridFor(5).cols * pet.petSheetGridFor(5).rows >= 5 && pet.petSheetGridFor(32).cols * pet.petSheetGridFor(32).rows >= 32, '非默认帧数（5/32）网格容量仍覆盖')
  ok(pet.petSheetGridFor(1).cols === 1 && pet.petSheetGridFor(1).rows === 1, '1 帧 → 1×1')
  ok(pet.petSheetGridFor(99).cols <= 8 && pet.petSheetGridFor(99).rows <= 8, '越界帧数钳制后网格 ≤ 8')
  ok(pet.petSheetSizeForGrid({ cols: 3, rows: 1 }) === '1536x1024', '3:2 横 → 1536x1024')
  ok(pet.petSheetSizeForGrid({ cols: 2, rows: 2 }) === '1024x1024', '1:1 → 1024x1024')
  ok(pet.petSheetSizeForGrid({ cols: 2, rows: 3 }) === '1024x1536', '2:3 竖 → 1024x1536')
}

console.log('—— 洋红 prompt 模板（§4.2 手写版）：铁律逐条 + 锚点句 ——')
{
  const actions = genmod.sheetCellActions('idle', 3)
  ok(actions.length === 3 && actions[0].includes('standing still') && actions[1].includes('breathing in') && actions[2].includes('breathing out'), 'idle 逐格动作：中立→压扁吸气→伸展呼气')
  ok(genmod.sheetCellActions('walk', 4).length === 4 && genmod.sheetCellActions('walk', 4)[3].includes('mid-air stride'), 'walk 四格走路循环')
  ok(genmod.sheetCellActions('idle', 5)[4].includes('phase 5'), '帧数超出默认表 → 同动作延续句补齐')
  ok(genmod.sheetCellActions('unknown-state', 1)[0] === 'neutral pose', '未知态兜底动作')
  const p = genmod.buildSheetPrompt({ description: 'mint jelly blob', styleTags: 'kawaii chibi', cols: 3, rows: 1, actions, anchored: false })
  ok(p.includes('A 1x3 2D game sprite animation sheet of the same mint jelly blob.'), '首行：rows x cols + 角色描述嵌入')
  ok(p.includes('Layout: 3 columns x 1 rows, reading order left-to-right then top-to-bottom.'), 'Layout 行：列×行 + 行主序阅读顺序')
  ok(p.includes('Cell 1: standing still') && p.includes('Cell 3:'), 'Cell 逐格动作描述')
  ok(p.includes('SAME character, SAME size, SAME facing direction, SAME palette in all 3 cells. kawaii chibi.'), 'SAME 系列一致性约束 + 风格标签')
  ok(p.includes('Background is 100% solid flat magenta (#FF00FF) everywhere, no gradients.'), '洋红背景铁律')
  ok(p.includes('NO text, NO labels, NO words, NO letters anywhere.'), '无文字铁律')
  ok(p.includes('1. EXACTLY 3 equal cells.'), '铁律 1：N 等分')
  ok(p.includes('2. NO borders/dividing lines/frames between cells.'), '铁律 2：无框线')
  ok(p.includes('3. NO text.'), '铁律 3：无文字')
  ok(p.includes('4. Character fills 80%+ of each cell'), '铁律 4：占格 80%+')
  ok(p.includes('5. Cells connected by magenta background only.'), '铁律 5：洋红连接')
  const anchored = genmod.buildSheetPrompt({ description: 'mint jelly blob', cols: 2, rows: 2, actions: genmod.sheetCellActions('walk', 4), anchored: true })
  ok(anchored.startsWith('Recreate the EXACT same character from the reference image (identical identity, colors, proportions, outline and style), arranged as a new sheet:'), '锚点句前缀（身份/配色/比例/轮廓/风格全同）')
  ok(anchored.includes('Use the reference image only for the character identity, not its poses or layout.'), '锚点句后缀：参考图只管角色不管布局')
}

// —— 造洋红 sheet：CELL px 方格，每格中央绿色标记块（宽 12+cell*4），可注入四角污染/空格缺陷 ——
const CELL = 64
function magentaSheetPng({ cols, rows, badCorner = false, emptyCells = [] } = {}) {
  const W = cols * CELL
  const H = rows * CELL
  const rgba = Buffer.alloc(W * H * 4)
  for (let i = 0; i < W * H; i++) { rgba[i * 4] = 255; rgba[i * 4 + 1] = 0; rgba[i * 4 + 2] = 255; rgba[i * 4 + 3] = 255 }
  for (let cell = 0; cell < cols * rows; cell++) {
    if (emptyCells.includes(cell)) continue
    const ox = (cell % cols) * CELL
    const oy = Math.floor(cell / cols) * CELL
    const w = 12 + cell * 4
    for (let y = 16; y < 48; y++) for (let x = 24; x < 24 + w; x++) {
      const at = ((oy + y) * W + ox + x) * 4
      rgba[at] = 40; rgba[at + 1] = 190; rgba[at + 2] = 90
    }
  }
  if (badCorner) for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) {
    const at = (y * W + x) * 4
    rgba[at] = 120; rgba[at + 1] = 120; rgba[at + 2] = 128
  }
  return img.encodePng(W, H, rgba)
}

console.log('—— QC 纯函数：四角洋红校验 + 空帧覆盖率 ——')
{
  const good = img.decodePng(magentaSheetPng({ cols: 2, rows: 1 }))
  ok(genmod.cornersAreMagenta(good) === true, '标准洋红 sheet 四角通过')
  ok(genmod.cornersAreMagenta(img.decodePng(magentaSheetPng({ cols: 2, rows: 1, badCorner: true }))) === false, '角被污染（风格漂移/残留）判失败')
  const keyed = img.chromaKeyFlood(good.rgba, good.width, good.height, 0.15)
  const keyedGood = keyed.keyed ? { ...good, rgba: keyed.rgba } : good
  const cells = img.splitSheet(keyedGood, 2, 1)
  ok(genmod.nonTransparentRatio(cells[0]) > 0.05, '有内容的格（键控后）覆盖率 >5%')
  const emptySrc = img.decodePng(magentaSheetPng({ cols: 2, rows: 1, emptyCells: [1] }))
  const emptyKeyed = img.chromaKeyFlood(emptySrc.rgba, emptySrc.width, emptySrc.height, 0.15)
  const emptyCells = img.splitSheet(emptyKeyed.keyed ? { ...emptySrc, rgba: emptyKeyed.rgba } : emptySrc, 2, 1)
  ok(genmod.nonTransparentRatio(emptyCells[1]) === 0, '纯底空格（键控后）覆盖率为 0')
}

// —— fetch mock 基建 ——
function makeMock(responder, { delayMs = 0 } = {}) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
    return responder(url, init)
  }
  return { calls, fetchImpl }
}
const imageResponse = (buffer) => new Response(JSON.stringify({ data: [{ b64_json: buffer.toString('base64') }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
const failResponse = (status) => new Response(JSON.stringify({ error: { message: 'boom' } }), { status })

// sheets mock：按请求 prompt 里的网格描述回洋红 sheet；defects 按调用序注入缺陷，failGenerationTimes 让前 N 次 generations 504
function makeSheetsMock({ defects = {}, failGenerationTimes = 0, failAll = false, delayMs = 0 } = {}) {
  const calls = []
  const sent = []
  let genFails = failGenerationTimes
  const fetchImpl = async (url, init = {}) => {
    const index = calls.length
    const call = { url: String(url), init, isEdits: String(url).includes('/images/edits') }
    calls.push(call)
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
    const prompt = init.body instanceof FormData ? String(init.body.get('prompt')) : JSON.parse(String(init.body)).prompt
    const m = /(\d+) columns x (\d+) rows/.exec(prompt)
    call.prompt = prompt
    call.cols = Number(m?.[1] ?? 1)
    call.rows = Number(m?.[2] ?? 1)
    if (failAll || (!call.isEdits && genFails > 0)) {
      if (!call.isEdits && genFails > 0) genFails--
      return failResponse(504)
    }
    const png = magentaSheetPng({ cols: call.cols, rows: call.rows, ...(defects[index] ?? {}) })
    sent[index] = png
    return imageResponse(png)
  }
  return { calls, sent, fetchImpl }
}

function makeDeps(fetchImpl, presets = [PRESET]) {
  const events = []
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-pet-gen-'))
  const gen = new genmod.PetGenController({
    userDataDir: userData,
    getPresets: () => presets,
    notify: (channel, payload) => events.push({ channel, payload }),
    fetchImpl,
    retryDelayMs: 2 // 退避 2ms×attempt，smoke 加速；生产为 5s×attempt（SHEET_RETRY_BACKOFF_MS）
  })
  return { gen, events, userData }
}
const waitForEvent = (events, channel, timeoutMs = 8000) => new Promise((resolve, reject) => {
  const started = Date.now()
  const poll = () => {
    const hit = events.find((e) => e.channel === channel)
    if (hit) return resolve(hit)
    if (Date.now() - started > timeoutMs) return reject(new Error(`等待 ${channel} 超时；已收到：${events.map((e) => e.channel).join(', ') || '无'}`))
    setTimeout(poll, 5)
  }
  poll()
})
const packDir = (userData, packId) => path.join(userData, 'pets', packId)
const noLeak = (events, userData, packId) => {
  const eventText = JSON.stringify(events)
  let petJson = ''
  try { petJson = fs.readFileSync(path.join(packDir(userData, packId), 'pet.json'), 'utf8') } catch { /* 未落盘也算不泄漏 */ }
  return !eventText.includes(SECRET) && !petJson.includes(SECRET)
}
const genInput = (packId, extra = {}) => ({
  packId,
  presetId: 'p1',
  model: 'gpt-image-1',
  params: { size: '1024x1024', quality: '', n: 1, background: 'transparent' },
  stylePrompt: 'mint jelly blob mascot',
  states: EIGHT_STATES,
  mode: 'sheets',
  ...extra
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log('—— sheets 全管线：1×generations + 7×edits 锚点 + 洋红模板 + 256px 落盘 ——')
{
  const { calls, sent, fetchImpl } = makeSheetsMock()
  const { gen, events, userData } = makeDeps(fetchImpl)
  const started = await gen.start(genInput('gen-sheets'))
  ok(started.ok === true, 'sheets gen-start 受理')
  const done = (await waitForEvent(events, 'pet:gen-done')).payload
  const expectedFrames = Object.values(EIGHT_STATES).reduce((a, b) => a + b, 0)
  ok(done.packId === 'gen-sheets' && done.frameCount === expectedFrames, `pet:gen-done {packId, frameCount=${expectedFrames}}（got ${JSON.stringify(done.packId + ' / ' + done.frameCount)}）`)
  ok(Array.isArray(done.warnings) && done.warnings.length === 0, '全绿时 warnings 为空数组')
  ok(typeof done.elapsedMs === 'number' && done.elapsedMs >= 0, 'elapsedMs 带耗时')

  ok(calls.length === 8, `调用序列恰为 8 次 = 1×generations + 7×edits（got ${calls.length}）`)
  ok(!calls[0].isEdits && calls.slice(1).every((c) => c.isEdits), 'idle 走 generations，其余 7 态全走 edits')
  const idleBody = JSON.parse(calls[0].init.body)
  ok(idleBody.model === 'gpt-image-1' && idleBody.n === 1 && idleBody.output_format === 'png', 'idle 请求体：OpenAI images 形状')
  ok(idleBody.quality === 'medium', '空 quality 落 medium（1k 单张控制在网关超时内，§6.3）')
  ok(idleBody.size === '1536x1024', 'idle 1×3 网格 → 3:2 横 1536x1024')
  ok(!('background' in idleBody), 'idle 请求体不带 background（洋红底靠模板）')
  ok(calls[0].cols === 3 && calls[0].rows === 1, 'idle 按帧数 3 换算 1×3 网格')
  const expectedGrids = [[3, 1], [2, 2], [2, 1], [1, 1], [2, 1], [2, 1], [2, 1], [3, 1]]
  ok(expectedGrids.every(([c, r], i) => calls[i].cols === c && calls[i].rows === r), '八态网格序照 §4.1 默认表换算')
  const idlePrompt = calls[0].prompt
  ok(idlePrompt.includes('A 1x3 2D game sprite animation sheet of the same mint jelly blob mascot.'), 'idle prompt：rows x cols + 角色描述')
  ok(idlePrompt.includes('100% solid flat magenta (#FF00FF)'), '请求体模板：洋红背景铁律')
  ok(idlePrompt.includes('NO text, NO labels, NO words, NO letters anywhere.'), '请求体模板：无文字铁律')
  ok(idlePrompt.includes('1. EXACTLY 3 equal cells.') && idlePrompt.includes('2. NO borders/dividing lines/frames between cells.') && idlePrompt.includes('3. NO text.') && idlePrompt.includes('4. Character fills 80%+ of each cell') && idlePrompt.includes('5. Cells connected by magenta background only.'), '请求体模板：ABSOLUTE RULES 五条逐条在列')
  ok(idlePrompt.includes('Cell 1: standing still') && idlePrompt.includes('Cell 3: breathing out'), '请求体模板：逐格动作（§4.1）')

  const anchorBytes = sent[0]
  let anchorOk = true
  let promptOk = true
  for (const call of calls.slice(1)) {
    const form = call.init.body
    if (!(form instanceof FormData)) { anchorOk = false; break }
    const image = form.get('image')
    const bytes = Buffer.from(await image.arrayBuffer())
    if (!bytes.equals(anchorBytes)) anchorOk = false
    if (!call.prompt.includes('Recreate the EXACT same character from the reference image') || !call.prompt.includes('not its poses or layout.')) promptOk = false
  }
  ok(anchorOk, '7 次 edits 全部携带 idle sheet 字节作锚点（内存传递不落盘）')
  ok(promptOk, 'edits prompt 全带锚点句（身份全同 + 参考图只管角色）')
  const walkForm = calls[1].init.body
  ok(walkForm.get('size') === '1024x1024' && walkForm.get('quality') === 'medium', 'walk 2×2 → 1:1 1024x1024 + medium')
  ok(calls[2].init.body.get('size') === '1536x1024' && calls[7].init.body.get('size') === '1536x1024', '横版态 edits size 走 1536x1024')
  ok(calls.every((c) => c.init.headers?.Authorization === `Bearer ${SECRET}`), '每个请求都带 Bearer 鉴权头')
  ok(!calls[0].url.includes(SECRET), 'URL 不含 key')

  const progressEvents = events.filter((e) => e.channel === 'pet:gen-progress')
  ok(progressEvents.some((e) => e.payload.stage === '生成 idle sheet 1/8' && e.payload.total === 8), '进度按 sheet 计：生成 idle sheet 1/8')
  ok(progressEvents.some((e) => e.payload.stage === '生成 eat sheet 8/8'), '进度按 sheet 计：直到 8/8')

  const dir = packDir(userData, 'gen-sheets')
  const manifest = pet.validatePetManifest(JSON.parse(fs.readFileSync(path.join(dir, 'pet.json'), 'utf8')))
  ok(manifest !== null, '落盘 pet.json 过 validatePetManifest')
  ok(manifest && manifest.rendering === 'smooth', 'manifest rendering=smooth（§5）')
  ok(manifest && manifest.frameSize[0] === 256 && manifest.frameSize[1] === 256, 'manifest frameSize 256×256')
  ok(manifest && [3, 4, 2, 1, 2, 2, 2, 3].every((n, i) => Object.values(manifest.states)[i].frames.length === n), '八态帧数与入参表一致')
  const frameBytes = fs.readFileSync(path.join(dir, 'idle-0.png'))
  ok(frameBytes.subarray(0, 8).equals(PNG_SIGNATURE), '帧文件是 PNG')
  const frame = img.decodePng(frameBytes)
  ok(frame.width === 256 && frame.height === 256, '帧源 256×256（§5 清晰度根因修复）')
  ok(frame.rgba[3] === 0, '洋红底色度键去背生效（角 alpha=0）')
  // 行主序切帧映射：标记块宽 12+cell*4；idle-0←idle格0(12px)，idle-2←格2(20px)，walk-3←walk格3(24px)
  const markWidth = (file) => {
    const f = img.decodePng(fs.readFileSync(path.join(dir, file)))
    let count = 0
    for (let x = 0; x < 256; x++) if (f.rgba[(232 * 256 + x) * 4 + 3] > 0) count++
    return count
  }
  ok(markWidth('idle-0.png') === 12 && markWidth('idle-2.png') === 20 && markWidth('walk-3.png') === 24 && markWidth('eat-0.png') === 12, '行主序切帧映射逐格对位')
  const leftovers = fs.readdirSync(path.join(userData, 'pets')).filter((n) => n.startsWith('.pet-pack-'))
  ok(leftovers.length === 0, '原子落盘无临时目录残留')
  ok(noLeak(events, userData, 'gen-sheets'), '进度/完成事件与 pet.json 均不含 apiKey 明文')
  fs.rmSync(userData, { recursive: true, force: true })
}

console.log('—— QC 四角非洋红：自动重试一次 → 过 ——')
{
  const frames = { idle: 3, walk: 4, fall: 2, dragged: 1, sleep: 2, happy: 2, think: 2 }
  const { calls, fetchImpl } = makeSheetsMock({ defects: { 1: { badCorner: true } } }) // walk 首次四角被污染
  const { gen, events, userData } = makeDeps(fetchImpl)
  await gen.start(genInput('gen-qc-recover', { states: frames }))
  const done = (await waitForEvent(events, 'pet:gen-done')).payload
  ok(done.warnings.length === 0, '重试通过后无 warning')
  ok(calls.length === 8, `7 张 sheet + 1 次 QC 自动重试 = 8 次调用（got ${calls.length}）`)
  ok(calls[2].isEdits && calls[2].cols === 2 && calls[2].rows === 2, '第 3 次调用是 walk（2×2）的 QC 重试 edits')
  ok(calls[2].prompt.includes('Recreate the EXACT same character'), 'QC 重试仍是锚点图生图')
  fs.rmSync(userData, { recursive: true, force: true })
}

console.log('—— QC 空帧：自动重试一次 → 过 ——')
{
  const { calls, fetchImpl } = makeSheetsMock({ defects: { 4: { emptyCells: [0] } } }) // sleep 首次出空格
  const { gen, events, userData } = makeDeps(fetchImpl)
  await gen.start(genInput('gen-qc-empty', { states: SEVEN_STATES }))
  const done = (await waitForEvent(events, 'pet:gen-done')).payload
  ok(done.warnings.length === 0, '空帧重试通过后无 warning')
  ok(calls.length === 8, `含 1 次空帧 QC 重试共 8 次调用（got ${calls.length}）`)
  fs.rmSync(userData, { recursive: true, force: true })
}

console.log('—— QC 重试仍失败：warning 入结果但不中断整包 ——')
{
  const { calls, fetchImpl } = makeSheetsMock({ defects: { 1: { badCorner: true }, 2: { badCorner: true } } }) // walk 两次都污染
  const { gen, events, userData } = makeDeps(fetchImpl)
  await gen.start(genInput('gen-qc-stubborn', { states: SEVEN_STATES }))
  const done = (await waitForEvent(events, 'pet:gen-done')).payload
  ok(done.warnings.length === 1 && done.warnings[0].includes('walk') && done.warnings[0].includes('洋红'), `warning 标注到态与原因（${done.warnings[0].slice(0, 40)}…）`)
  ok(done.frameCount === 7, 'QC 失败不中断整包：7 帧照常入包')
  ok(calls.length === 8, `含 1 次重试共 8 次调用（got ${calls.length}）`)
  const manifest = pet.validatePetManifest(JSON.parse(fs.readFileSync(path.join(packDir(userData, 'gen-qc-stubborn'), 'pet.json'), 'utf8')))
  ok(manifest !== null, '带 warning 的包照样落盘且过校验')
  ok(noLeak(events, userData, 'gen-qc-stubborn'), 'warning 文案不含 apiKey')
  fs.rmSync(userData, { recursive: true, force: true })
}

console.log('—— 传输层重试：前 2 次 504 → 第 3 次过（5s×attempt 退避路径，smoke 注入短延时）——')
{
  const { calls, fetchImpl } = makeSheetsMock({ failGenerationTimes: 2 })
  const { gen, events, userData } = makeDeps(fetchImpl)
  await gen.start(genInput('gen-504'))
  const done = (await waitForEvent(events, 'pet:gen-done')).payload
  ok(done.frameCount === 19, '504 重试后整包完成')
  const genCalls = calls.filter((c) => !c.isEdits)
  ok(genCalls.length === 3, `idle 重试后 generations 共 3 次调用（got ${genCalls.length}）`)
  ok(calls[2].url === calls[0].url && calls[1].url !== calls[0].url, '每次尝试从头轮询候选端点（重试落回首候选）')
  ok(genCalls.every((c) => c.prompt.includes('A 1x3')), '重试请求与首请求同模板')
  fs.rmSync(userData, { recursive: true, force: true })
}

console.log('—— 传输层重试耗尽：整包失败 + 无落盘 ——')
{
  const { calls, fetchImpl } = makeSheetsMock({ failAll: true })
  const { gen, events, userData } = makeDeps(fetchImpl)
  await gen.start(genInput('gen-dead'))
  const err = (await waitForEvent(events, 'pet:gen-error')).payload
  ok(err.packId === 'gen-dead' && err.reason.includes('HTTP 504'), `失败原因带状态码（${err.reason.slice(0, 60)}…）`)
  ok(err.reason.includes('已退避重试 3 次'), '错误明示重试次数')
  ok(calls.length === 8, `4 次尝试（首+3 重试）× 2 候选端点 = 8 次调用（got ${calls.length}）`)
  ok(!fs.existsSync(packDir(userData, 'gen-dead')), '失败不落盘')
  ok(noLeak(events, userData, 'gen-dead'), '错误事件不含 apiKey')
  fs.rmSync(userData, { recursive: true, force: true })
}

console.log('—— 取消与忙时闸 ——')
{
  const { fetchImpl } = makeSheetsMock({ delayMs: 30 })
  const { gen, events, userData } = makeDeps(fetchImpl)
  const started = await gen.start(genInput('gen-cancel'))
  ok(started.ok === true, '慢速任务受理')
  const second = await gen.start(genInput('gen-x'))
  ok(second.ok === false && second.error.includes('进行中'), '忙时第二个 start 被闸')
  gen.cancel()
  const err = (await waitForEvent(events, 'pet:gen-error')).payload
  ok(err.reason === '已取消', `取消 → gen-error 已取消（got ${err.reason}）`)
  await sleep(80)
  ok(!events.some((e) => e.channel === 'pet:gen-done'), '取消后无 done')
  ok(!fs.existsSync(packDir(userData, 'gen-cancel')), '取消不落盘（无半包）')
  fs.rmSync(userData, { recursive: true, force: true })
}

console.log('—— per-frame 保留模式回归：参考图 400 降级 + 256px 落盘 ——')
{
  // 64×64 浅灰底 + 中央绿色方块（去背后剩方块）
  const testRgba = (size = 64) => {
    const rgba = Buffer.alloc(size * size * 4)
    for (let i = 0; i < size * size; i++) { rgba[i * 4] = 210; rgba[i * 4 + 1] = 210; rgba[i * 4 + 2] = 214; rgba[i * 4 + 3] = 255 }
    for (let y = Math.floor(size * 0.3); y < Math.floor(size * 0.7); y++) for (let x = Math.floor(size * 0.3); x < Math.floor(size * 0.7); x++) {
      const at = (y * size + x) * 4
      rgba[at] = 60; rgba[at + 1] = 200; rgba[at + 2] = 120
    }
    return rgba
  }
  const png = img.encodePng(64, 64, testRgba())
  const { calls, fetchImpl } = makeMock((url, init) => {
    if (init.body instanceof FormData) return new Response(JSON.stringify({ error: { message: 'image input not supported' } }), { status: 400 })
    return imageResponse(png)
  })
  const { gen, events, userData } = makeDeps(fetchImpl)
  const started = await gen.start(genInput('gen-perframe', { states: SEVEN_STATES, mode: 'per-frame', params: { size: '1024x1024', quality: 'high', n: 1, background: 'transparent' } }))
  ok(started.ok === true, 'per-frame gen-start 受理')
  const done = (await waitForEvent(events, 'pet:gen-done')).payload
  ok(done.packId === 'gen-perframe' && done.frameCount === 7, `per-frame 完成 7 帧（got ${done.frameCount}）`)
  ok(calls.length === 13, `首帧纯生成 + 后续 6 帧各「multipart 被拒 + 无参考重试」= 13 次请求（got ${calls.length}）`)
  ok(!(calls[0].init.body instanceof FormData), '首帧无参考图（纯 JSON 生成）')
  const firstBody = JSON.parse(calls[0].init.body)
  ok(firstBody.size === '1024x1024' && firstBody.quality === 'high' && firstBody.background === 'transparent', 'per-frame 参数照旧透传（不受 sheets 默认影响）')
  const frameBytes = fs.readFileSync(path.join(packDir(userData, 'gen-perframe'), 'idle-0.png'))
  const frame = img.decodePng(frameBytes)
  ok(frame.width === 256 && frame.height === 256 && frame.rgba[3] === 0, 'per-frame 帧同样落 256×256 画布且去背')
  ok(noLeak(events, userData, 'gen-perframe'), '事件与 pet.json 不含 apiKey')
  fs.rmSync(userData, { recursive: true, force: true })
}

console.log('—— per-frame 失败出口：全 500 → gen-error ——')
{
  const { calls, fetchImpl } = makeMock(() => failResponse(500))
  const { gen, events, userData } = makeDeps(fetchImpl)
  await gen.start(genInput('gen-pf-fail', { states: SEVEN_STATES, mode: 'per-frame' }))
  const err = (await waitForEvent(events, 'pet:gen-error')).payload
  ok(err.packId === 'gen-pf-fail' && err.reason.includes('HTTP 500'), `失败原因带状态码（${err.reason.slice(0, 60)}…）`)
  ok(!fs.existsSync(packDir(userData, 'gen-pf-fail')), '失败不落盘')
  fs.rmSync(userData, { recursive: true, force: true })
}

console.log('—— 预设缺失 / apiKey 缺失 ——')
{
  const { calls, fetchImpl } = makeSheetsMock()
  const noPreset = makeDeps(fetchImpl, [])
  const r = await noPreset.gen.start(genInput('gen-nopreset', { presetId: 'ghost' }))
  ok(r.ok === false && r.error.includes('预设'), '未知预设直接拒收')
  const noKey = makeDeps(fetchImpl, [{ ...PRESET, apiKey: '' }])
  const r2 = await noKey.gen.start(genInput('gen-nokey'))
  ok(r2.ok === false && r2.error.includes('apiKey'), '空 apiKey 拒收')
  ok(calls.length === 0, '拒收不发网络请求')
  fs.rmSync(noPreset.userData, { recursive: true, force: true })
  fs.rmSync(noKey.userData, { recursive: true, force: true })
}

if (failed) { console.error(`\n❌ PET GEN SMOKE FAILED (${failed})`); process.exit(1) }
console.log('\n✅ PET GEN SMOKE PASSED')
