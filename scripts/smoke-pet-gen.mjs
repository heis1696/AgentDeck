// 素材包生成 PetGenController 冒烟：esbuild 直连 src/main/pet/pet-gen.ts，注入 fetch mock——
// 断言 images 请求形状（OpenAI 形状 + Authorization）、参考图 400/422 降级、进度/完成/失败事件、
// 落盘 pet.json 过 validatePetManifest、sheet 网格切帧、取消，以及 apiKey 绝不出现在任何事件/落盘内容里。
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
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// —— 造图：size×size 浅灰实底 + 中央绿色方块（去背后剩方块；markCols 给 sheet 帧序校验用）——
function testRgba(size = 64, bg = [210, 210, 214]) {
  const rgba = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i++) { rgba[i * 4] = bg[0]; rgba[i * 4 + 1] = bg[1]; rgba[i * 4 + 2] = bg[2]; rgba[i * 4 + 3] = 255 }
  for (let y = Math.floor(size * 0.3); y < Math.floor(size * 0.7); y++) for (let x = Math.floor(size * 0.3); x < Math.floor(size * 0.7); x++) {
    const at = (y * size + x) * 4
    rgba[at] = 60; rgba[at + 1] = 200; rgba[at + 2] = 120
  }
  return rgba
}
const testPng = (size = 64) => img.encodePng(size, size, testRgba(size))
const toB64 = (buffer) => buffer.toString('base64')

console.log('—— genEndpointCandidates：端点候选归一 ——')
ok(JSON.stringify(genmod.genEndpointCandidates('http://x.test/v1/')) === JSON.stringify(['http://x.test/images/generations', 'http://x.test/v1/images/generations']), '裸 /v1 → 双候选')
ok(JSON.stringify(genmod.genEndpointCandidates('http://x.test/v1/images/generations')) === JSON.stringify(['http://x.test/v1/images/generations']), '完整端点直用')

console.log('—— buildGenBody：请求体形状（不含 apiKey）——')
{
  const body = genmod.buildGenBody('gpt-image-1', 'prompt text', { size: '512x512', quality: 'high', n: 2, background: 'transparent' })
  ok(body.model === 'gpt-image-1' && body.prompt === 'prompt text' && body.n === 2, 'model/prompt/n 透传')
  ok(body.size === '512x512' && body.background === 'transparent' && body.output_format === 'png', 'size/background/output_format 形状')
  ok(body.quality === 'high' && !JSON.stringify(body).includes('apiKey'), 'quality 透传且无 key 字段')
  const minimal = genmod.buildGenBody('m', 'p', { size: 's', quality: '', n: 1, background: 'opaque' })
  ok(minimal.quality === undefined && minimal.background === 'opaque', '空 quality 不下发；opaque 透传')
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
const imageResponse = (buffer) => new Response(JSON.stringify({ data: [{ b64_json: toB64(buffer) }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
function makeDeps(fetchImpl, presets = [PRESET]) {
  const events = []
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-pet-gen-'))
  const gen = new genmod.PetGenController({
    userDataDir: userData,
    getPresets: () => presets,
    notify: (channel, payload) => events.push({ channel, payload }),
    fetchImpl
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
  params: { size: '1024x1024', quality: 'high', n: 1, background: 'transparent' },
  stylePrompt: 'cute mascot',
  states: SEVEN_STATES,
  mode: 'per-frame',
  ...extra
})

console.log('—— per-frame 全管线：参考图 400 降级 + 进度 + 原子落盘 + key 不泄漏 ——')
{
  const png = testPng()
  const { calls, fetchImpl } = makeMock((url, init) => {
    if (init.body instanceof FormData) {
      return new Response(JSON.stringify({ error: { message: 'image input not supported' } }), { status: 400 })
    }
    return imageResponse(png)
  })
  const { gen, events, userData } = makeDeps(fetchImpl)
  const started = await gen.start(genInput('gen-smoke-1'))
  ok(started.ok === true, 'gen-start 受理')
  const done = (await waitForEvent(events, 'pet:gen-done')).payload
  ok(done.packId === 'gen-smoke-1' && done.frameCount === 7, `pet:gen-done {packId, frameCount=7}（got ${JSON.stringify(done)}）`)
  ok(calls.length === 13, `首帧纯生成 + 后续 6 帧各「multipart 被拒 + 无参考重试」= 13 次请求（got ${calls.length}）`)
  ok(!(calls[0].init.body instanceof FormData), '首帧无参考图（纯 JSON 生成）')
  ok(calls[1].init.body instanceof FormData, '次帧先走 multipart 编辑形状（带参考图）')
  const firstBody = JSON.parse(calls[0].init.body)
  ok(firstBody.model === 'gpt-image-1' && firstBody.background === 'transparent' && firstBody.output_format === 'png' && typeof firstBody.prompt === 'string' && firstBody.prompt.includes('idle'), '请求体：OpenAI images 形状 + 帧提示词含状态名')
  ok(calls.every((c) => c.init.headers?.Authorization === `Bearer ${SECRET}`), '每个请求都带 Bearer 鉴权头')
  ok(!calls[0].url.includes(SECRET), 'URL 不含 key')
  const progress = events.filter((e) => e.channel === 'pet:gen-progress')
  ok(progress.length >= 7 && progress[progress.length - 1].payload.done === 7 && progress[progress.length - 1].payload.total === 7, `进度推进到 7/7（${progress.length} 条进度）`)
  const manifestRaw = JSON.parse(fs.readFileSync(path.join(packDir(userData, 'gen-smoke-1'), 'pet.json'), 'utf8'))
  const manifest = pet.validatePetManifest(manifestRaw)
  ok(manifest !== null, '落盘 pet.json 过 validatePetManifest')
  ok(manifest && Object.values(manifest.states).reduce((s, st) => s + st.frames.length, 0) === 7, '帧文件数与帧数表一致')
  const frameBytes = fs.readFileSync(path.join(packDir(userData, 'gen-smoke-1'), 'idle-0.png'))
  ok(frameBytes.subarray(0, 8).equals(PNG_SIGNATURE), '帧文件是 PNG')
  const frame = img.decodePng(frameBytes)
  ok(frame.width === 64 && frame.height === 64 && frame.rgba[3] === 0, '帧 64×64 且去背生效（角 alpha=0）')
  const leftovers = fs.readdirSync(path.join(userData, 'pets')).filter((n) => n.startsWith('.pet-pack-'))
  ok(leftovers.length === 0, '原子落盘无临时目录残留')
  ok(noLeak(events, userData, 'gen-smoke-1'), '进度/完成事件与 pet.json 均不含 apiKey 明文')
  fs.rmSync(userData, { recursive: true, force: true })
}

console.log('—— sheet 模式：单图 4×2 网格切帧，行主序依序映射帧表 ——')
{
  // 256×128 sheet：8 格 64×64，第 i 格画居中的深色标记块（宽 (i+1)*4，去背后剩标记）。
  // 标记必须居中：整图四角保持背景色，corner-flood 去背才成立（真实生成图的精灵也不贴角）。
  const W = 256, H = 128
  const rgba = Buffer.alloc(W * H * 4)
  for (let i = 0; i < W * H; i++) { rgba[i * 4] = 210; rgba[i * 4 + 1] = 210; rgba[i * 4 + 2] = 214; rgba[i * 4 + 3] = 255 }
  for (let cell = 0; cell < 8; cell++) {
    const ox = (cell % 4) * 64
    const oy = Math.floor(cell / 4) * 64
    const w = (cell + 1) * 4
    for (let y = 16; y < 48; y++) for (let x = 32 - Math.floor(w / 2); x < 32 - Math.floor(w / 2) + w; x++) {
      const at = ((oy + y) * W + ox + x) * 4
      rgba[at] = 30; rgba[at + 1] = 210; rgba[at + 2] = 30
    }
  }
  const sheetPng = img.encodePng(W, H, rgba)
  const { calls, fetchImpl } = makeMock(() => imageResponse(sheetPng))
  const { gen, events, userData } = makeDeps(fetchImpl)
  const started = await gen.start(genInput('gen-sheet', { mode: 'sheet', sheet: { cols: 4, rows: 2 } }))
  ok(started.ok === true, 'sheet gen-start 受理')
  const done = (await waitForEvent(events, 'pet:gen-done')).payload
  ok(done.frameCount === 7, `sheet 完成 7 帧（got ${done.frameCount}）`)
  ok(calls.length === 1, `sheet 只发一次请求（got ${calls.length}）`)
  const body = JSON.parse(calls[0].init.body)
  ok(body.prompt.includes('4 columns') && body.prompt.includes('2 rows'), 'sheet 提示词描述网格')
  const dir = packDir(userData, 'gen-sheet')
  const manifest = pet.validatePetManifest(JSON.parse(fs.readFileSync(path.join(dir, 'pet.json'), 'utf8')))
  ok(manifest !== null, 'sheet pet.json 过 validatePetManifest')
  // 帧序断言：idle-0 ← cell0（4px 标记），walk-0 ← cell1（8px），fall-0 ← cell2（12px）
  const markedCols = (file) => {
    const frame = img.decodePng(fs.readFileSync(path.join(dir, file)))
    let count = 0
    for (let x = 0; x < 64; x++) if (frame.rgba[(40 * 64 + x) * 4 + 3] > 0) count++
    return Math.round(count / 4)
  }
  ok(markedCols('idle-0.png') === 1 && markedCols('walk-0.png') === 2 && markedCols('fall-0.png') === 3, '行主序切帧映射：idle←cell0 / walk←cell1 / fall←cell2')
  ok(noLeak(events, userData, 'gen-sheet'), 'sheet 事件与 pet.json 不含 apiKey')
  fs.rmSync(userData, { recursive: true, force: true })
}

console.log('—— 失败出口：全 500 → gen-error（不带 key）；未落盘 ——')
{
  const { fetchImpl } = makeMock(() => new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 }))
  const { gen, events, userData } = makeDeps(fetchImpl)
  await gen.start(genInput('gen-fail'))
  const err = (await waitForEvent(events, 'pet:gen-error')).payload
  ok(err.packId === 'gen-fail' && err.reason.includes('HTTP 500'), `失败原因带状态码（${err.reason.slice(0, 60)}…）`)
  ok(!fs.existsSync(packDir(userData, 'gen-fail')), '失败不落盘')
  ok(noLeak(events, userData, 'gen-fail'), '错误事件不含 apiKey')
  fs.rmSync(userData, { recursive: true, force: true })
}

console.log('—— 取消与忙时闸 ——')
{
  const { fetchImpl } = makeMock(() => imageResponse(testPng()), { delayMs: 25 })
  const { gen, events, userData } = makeDeps(fetchImpl)
  const started = await gen.start(genInput('gen-cancel', { states: { idle: 3, walk: 4, fall: 2, dragged: 1, sleep: 2, happy: 2, think: 2 } }))
  ok(started.ok === true, '慢速任务受理')
  const second = await gen.start(genInput('gen-x', { states: { idle: 1 } }))
  ok(second.ok === false && second.error.includes('进行中'), '忙时第二个 start 被闸')
  gen.cancel()
  const err = (await waitForEvent(events, 'pet:gen-error')).payload
  ok(err.reason === '已取消', `取消 → gen-error 已取消（got ${err.reason}）`)
  await new Promise((r) => setTimeout(r, 80))
  ok(!events.some((e) => e.channel === 'pet:gen-done'), '取消后无 done')
  ok(!fs.existsSync(packDir(userData, 'gen-cancel')), '取消不落盘（无半包）')
  fs.rmSync(userData, { recursive: true, force: true })
}

console.log('—— 预设缺失 / apiKey 缺失 ——')
{
  const { calls, fetchImpl } = makeMock(() => imageResponse(testPng()))
  const noPreset = makeDeps(fetchImpl, [])
  const r = await noPreset.gen.start(genInput('gen-nopreset', { presetId: 'ghost' }))
  ok(r.ok === false && r.error.includes('预设'), '未知预设直接拒收')
  ok(calls.length === 0, '拒收不发网络请求')
  const noKey = makeDeps(fetchImpl, [{ ...PRESET, apiKey: '' }])
  const r2 = await noKey.gen.start(genInput('gen-nokey'))
  ok(r2.ok === false && r2.error.includes('apiKey'), '空 apiKey 拒收')
  ok(calls.length === 0, '空 apiKey 不发请求')
  fs.rmSync(noPreset.userData, { recursive: true, force: true })
  fs.rmSync(noKey.userData, { recursive: true, force: true })
}

if (failed) { console.error(`\n❌ PET GEN SMOKE FAILED (${failed})`); process.exit(1) }
console.log('\n✅ PET GEN SMOKE PASSED')
