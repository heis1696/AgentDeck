// 桌宠 AI 素材包生成 CLI 冒烟：esbuild 直连 src/shared/pet.ts + src/main/pet/packs.ts 反向校验产物，
// CLI 子进程实跑 init/validate/run --mock/preview；本地 http mock 服务器打通 comfyui（WS 失败退化轮询 +
// 垫图复用）与 gptimage（参考图 400 降级 + b64_json + apiKey 不泄露）两条真通道。
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { spawn, spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const CLI = path.join(root, 'scripts', 'pet-pack.mjs')

async function bundle(entry, name) {
  const outfile = path.join(root, 'out', name)
  await build({ entryPoints: [path.join(root, entry)], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
  return import(pathToFileURL(outfile).href)
}
const pet = await bundle('src/shared/pet.ts', 'smoke-pet-pack-pet.cjs')
const packs = await bundle('src/main/pet/packs.ts', 'smoke-pet-pack-packs.cjs')
const cli = await import(pathToFileURL(CLI).href)

let failed = 0
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) failed++ }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-pet-pack-'))
const runSync = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd: tmp, encoding: 'utf8', env: { ...process.env, ...env } })
// 网络通道测试必须用异步 spawn：spawnSync 会阻塞本进程事件循环，本进程里的 mock 服务器就没法应答子进程了
const runAsync = (args, env = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, [CLI, ...args], { cwd: tmp, env: { ...process.env, ...env } })
  let out = ''
  let err = ''
  const timer = setTimeout(() => child.kill(), 120_000)
  child.stdout.on('data', (c) => (out += c))
  child.stderr.on('data', (c) => (err += c))
  child.on('close', (code) => { clearTimeout(timer); resolve({ status: code, stdout: out, stderr: err }) })
})

/** 画一张 48×48 测试图：实底浅灰背景 + 中央绿色方块（去背后剩方块） */
function testPng() {
  const S = 48
  const rgba = Buffer.alloc(S * S * 4)
  for (let i = 0; i < S * S; i++) {
    rgba[i * 4] = 210; rgba[i * 4 + 1] = 210; rgba[i * 4 + 2] = 214; rgba[i * 4 + 3] = 255
  }
  for (let y = 14; y < 34; y++) {
    for (let x = 14; x < 34; x++) {
      const at = (y * S + x) * 4
      rgba[at] = 60; rgba[at + 1] = 200; rgba[at + 2] = 120; rgba[at + 3] = 255
    }
  }
  return cli.encodePng(S, S, rgba)
}

/** 本地 mock 后端服务器（记录命中，支持按路径应答） */
function makeServer(handlers) {
  const hits = []
  const bodies = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      hits.push(`${req.method} ${req.url}`)
      bodies.push(body)
      handlers(req, res, body)
    })
  })
  server.on('upgrade', (req, socket) => socket.destroy()) // 不支持 WS → 客户端必须退化轮询
  server.start = () => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  server.stop = () => { server.closeAllConnections?.(); return new Promise((resolve) => server.close(resolve)) }
  return { server, hits, bodies }
}

console.log('—— 状态契约镜像（scripts/pet-pack.mjs ↔ src/shared/pet.ts）——')
ok(JSON.stringify(cli.CORE_STATE_IDS) === JSON.stringify([...pet.PET_CORE_STATE_IDS]), 'CORE_STATE_IDS 与 src 一致')
ok(JSON.stringify(cli.EXTRA_STATE_IDS) === JSON.stringify([...pet.PET_EXTRA_STATE_IDS]), `EXTRA_STATE_IDS 与 src 一致（${cli.EXTRA_STATE_IDS.join('/')}）`)
ok(JSON.stringify(cli.STATE_IDS) === JSON.stringify([...pet.PET_STATE_IDS]), 'STATE_IDS 并集一致')

console.log('—— PNG 往返 ——')
{
  const rgba = Buffer.alloc(16 * 16 * 4)
  for (let i = 0; i < 16 * 16; i++) { rgba[i * 4] = 200; rgba[i * 4 + 1] = 30; rgba[i * 4 + 2] = i % 256; rgba[i * 4 + 3] = i % 3 === 0 ? 0 : 255 }
  const back = cli.decodePng(cli.encodePng(16, 16, rgba))
  ok(back.width === 16 && back.height === 16 && back.rgba.equals(rgba), 'encodePng → decodePng 无损往返')
}

console.log('—— init / validate ——')
const cfgPath = path.join(tmp, 'pet-pack.config.json')
{
  const r1 = runSync(['init', '--config', cfgPath])
  ok(r1.status === 0 && fs.existsSync(cfgPath), `init 写出配置模板（exit=${r1.status}）`)
  ok(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).packId === 'my-pet', '模板 JSON 可解析')
  const r2 = runSync(['init', '--config', cfgPath])
  ok(r2.status !== 0, 'init 拒绝覆盖已有配置（未加 --force）')
  const r3 = runSync(['validate', '--config', cfgPath])
  ok(r3.status === 0, `validate 模板通过（exit=${r3.status}）${r3.status !== 0 ? ' stderr=' + r3.stderr : ''}`)
}
function writeCfg(mutate) {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
  mutate(cfg)
  const p = path.join(tmp, `cfg-${Math.random().toString(36).slice(2, 8)}.json`)
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2))
  return p
}
{
  const cases = [
    ['frameSize 非 64×64', (c) => { c.frameSize = [128, 128] }, 'frameSize'],
    ['自定义态名被拒', (c) => { c.states = { dance: 3 } }, '白名单'],
    ['backend 双选一', (c) => { c.backend.comfyui = { address: 'http://127.0.0.1:8188', workflowFile: 'wf.json', outputNode: '9' } }, '二选一'],
    ['backend 缺失', (c) => { delete c.backend }, '二选一'],
    ['tolerance 越界', (c) => { c.removeBackground.tolerance = 1.5 }, 'tolerance'],
    ["packId 保留名 default", (c) => { c.packId = 'default' }, 'default'],
    ['gptimage size 形状错', (c) => { c.backend.gptimage.size = 'big' }, 'size']
  ]
  for (const [name, mutate, needle] of cases) {
    const r = runSync(['validate', '--config', writeCfg(mutate)])
    ok(r.status === 1 && r.stderr.includes(needle), `validate 拒绝：${name}（exit=${r.status}）`)
  }
  // comfyui workflow 静态检查
  const wfPath = path.join(tmp, 'wf.json')
  fs.writeFileSync(wfPath, JSON.stringify({ '9': { inputs: {}, class_type: 'SaveImage' } }))
  const noPlaceholder = writeCfg((c) => { delete c.backend.gptimage; c.backend.comfyui = { address: 'http://127.0.0.1:8188', workflowFile: 'wf.json', outputNode: '9' } })
  ok(runSync(['validate', '--config', noPlaceholder]).status === 1, 'validate 拒绝缺占位符的 workflow')
  fs.writeFileSync(wfPath, JSON.stringify({ '3': { inputs: { prompt: '{{PROMPT}}', seed: '{{SEED}}', width: '{{WIDTH}}', height: '{{HEIGHT}}' } }, '9': { inputs: {}, class_type: 'SaveImage' } }))
  ok(runSync(['validate', '--config', noPlaceholder]).status === 0, 'validate 接受占位符齐全的 workflow（{{REF_IMAGE}} 可选）')
  fs.writeFileSync(wfPath, 'not json')
  ok(runSync(['validate', '--config', noPlaceholder]).status === 1, 'validate 拒绝非 JSON workflow')
}

console.log('—— run --mock（无 eat：七态补齐、eat 缺省不补）——')
const packNoEat = writeCfg((c) => { c.packId = 'mockpet'; c.states = { idle: 2 } }) // 其余七态默认帧数
{
  const r = runSync(['run', '--mock', '--config', packNoEat])
  ok(r.status === 0, `run --mock 全管线通过（exit=${r.status}）${r.status !== 0 ? ' stderr=' + r.stderr : ''}`)
  const dir = path.join(tmp, 'out', 'pet-packs', 'mockpet')
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'pet.json'), 'utf8'))
  const validated = pet.validatePetManifest(manifest)
  ok(validated !== null, 'pet.json 过 validatePetManifest 直连反校验')
  if (validated) {
    ok(Object.keys(manifest.states).every((k) => pet.PET_STATE_IDS.includes(k)) && manifest.states.eat === undefined, 'eat 缺省不补，无白名单外键')
    ok(JSON.stringify(manifest.states.idle.frames) === JSON.stringify(['idle-0.png', 'idle-1.png']), '配置 states.idle:2 覆盖默认帧数')
    ok(manifest.states.walk.frames.length === 4 && manifest.states.dragged.frames.length === 1, '七态缺省帧数补齐（walk4/dragged1）')
    ok(manifest._meta && manifest._meta.seed === 20260919 && manifest._meta.stylePrompt.length > 0, '_meta 记录 seed 与 stylePrompt')
    const frameCount = Object.values(manifest.states).reduce((s, st) => s + st.frames.length, 0)
    ok(frameCount === 15, `总帧数 ${frameCount}（idle2+walk4+fall2+dragged1+sleep2+happy2+think2）`)
  }
  // 帧文件：64×64、去背生效（角落透明、中间有内容）、PNG 签名
  const frame = cli.decodePng(fs.readFileSync(path.join(dir, 'walk-0.png')))
  let opaque = 0
  for (let i = 0; i < 64 * 64; i++) if (frame.rgba[i * 4 + 3] > 200) opaque++
  ok(frame.width === 64 && frame.height === 64, '帧尺寸固定 64×64')
  ok(frame.rgba[3] === 0 && opaque > 100, `去背生效（角 alpha=0，不透明 ${opaque}px）`)
  // rename 原子落盘：重跑覆盖，无 tmp/old 残留
  const r2 = runSync(['run', '--mock', '--config', packNoEat])
  ok(r2.status === 0, '重复 run 覆盖成功（临时目录 + rename 原子换入）')
  const leftovers = fs.readdirSync(path.join(tmp, 'out', 'pet-packs')).filter((n) => n.startsWith('.pet-pack-'))
  ok(leftovers.length === 0, '无 .pet-pack-tmp-*/old-* 残留')
}

console.log('—— run --mock（含 eat：白名单可选态进包）+ packs.scanUserPack 反校验 ——')
const packEat = writeCfg((c) => { c.packId = 'eatpet'; c.states = { eat: 3 } })
{
  const r = runSync(['run', '--mock', '--config', packEat])
  ok(r.status === 0, `run --mock（eat:3）通过（exit=${r.status}）${r.status !== 0 ? ' stderr=' + r.stderr : ''}`)
  const dir = path.join(tmp, 'out', 'pet-packs', 'eatpet')
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'pet.json'), 'utf8'))
  const validated = pet.validatePetManifest(manifest)
  ok(validated !== null && validated.states.eat && validated.states.eat.frames.length === 3, 'eat 进 manifest 且 3 帧（validatePetManifest 反校验）')
  ok(validated && Object.keys(validated.states).length === 8, '七态 + eat = 8 态齐全')
  // 磁盘级反校验：用户包扫描（帧文件名 + 存在性 + manifest）
  const userData = path.join(tmp, 'userdata')
  fs.cpSync(dir, path.join(userData, 'pets', 'eatpet'), { recursive: true })
  const scan = packs.scanUserPack(userData, 'eatpet')
  ok(scan.info.ok === true && scan.info.frameCount === 19, `scanUserPack 收包（frameCount=${scan.info.frameCount}，19 = 16+eat3）`)
  ok(scan.manifest !== null && scan.manifest.states.eat.frames.every((f) => f.startsWith('eat-')), 'scanUserPack 读回 eat 帧')
}

console.log('—— preview ——')
{
  const r = runSync(['preview', '--config', packEat])
  const previewPath = path.join(tmp, 'out', 'pet-packs', 'eatpet-preview.png')
  ok(r.status === 0 && fs.existsSync(previewPath), `preview 出 contact sheet（exit=${r.status}）`)
  if (fs.existsSync(previewPath)) {
    const img = cli.decodePng(fs.readFileSync(previewPath))
    ok(img.width > 64 * 4 && img.height > 64 * 4 && img.rgba[3] === 255, `preview 尺寸 ${img.width}×${img.height}、棋盘底不透明`)
  }
}

console.log('—— comfyui 真通道（WS 被拒 → 退化轮询 /history → /view；首帧垫图复用）——')
{
  const png = testPng()
  let historyHits = 0
  const promptBodies = []
  const { server, hits } = makeServer((req, res, body) => {
    if (req.method === 'POST' && req.url === '/prompt') {
      promptBodies.push(JSON.parse(body.toString('utf8')).prompt)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ prompt_id: 'pid-1' }))
    } else if (req.method === 'GET' && req.url.startsWith('/history/')) {
      historyHits++
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ 'pid-1': { outputs: { '9': { images: [{ filename: 'out-0.png', subfolder: '', type: 'output' }] } } } }))
    } else if (req.method === 'GET' && req.url.startsWith('/view')) {
      res.setHeader('Content-Type', 'image/png')
      res.end(png)
    } else if (req.method === 'POST' && req.url === '/upload/image') {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ name: 'ref-0.png', subfolder: '', type: 'input' }))
    } else {
      res.statusCode = 404
      res.end('{}')
    }
  })
  await server.start()
  const port = server.address().port
  const wfPath = path.join(tmp, 'wf-comfy.json')
  fs.writeFileSync(wfPath, JSON.stringify({
    '3': { inputs: { prompt: '{{PROMPT}}', seed: '{{SEED}}', width: '{{WIDTH}}', height: '{{HEIGHT}}', ref_image: '{{REF_IMAGE}}' }, class_type: 'KSampler' },
    '9': { inputs: { filename_prefix: 'petpack' }, class_type: 'SaveImage' }
  }))
  const cfg = writeCfg((c) => {
    c.packId = 'comfypet'
    c.states = { idle: 1, walk: 1, fall: 1, dragged: 1, sleep: 1, happy: 1, think: 1 } // 7 帧：首帧生成 → 垫图复用
    c.backend = { comfyui: { address: `http://127.0.0.1:${port}`, workflowFile: 'wf-comfy.json', outputNode: '9' } }
  })
  const r = await runAsync(['run', '--config', cfg])
  ok(r.status === 0, `comfyui 通道 run 通过（exit=${r.status}）${r.status !== 0 ? ' stderr=' + r.stderr : ''}`)
  ok(r.stdout.includes('WS') && r.stdout.includes('轮询'), 'WS 连接失败 → 退化轮询 /history 命中')
  ok(hits.filter((h) => h === 'POST /upload/image').length === 1, '首帧垫图上传恰好一次')
  ok(promptBodies.length === 7, `七帧七次 /prompt（got ${promptBodies.length}）`)
  if (promptBodies.length === 7) {
    ok(typeof promptBodies[0] === 'object' && promptBodies[0] !== null, '/prompt 的 prompt 字段是 workflow 对象（ComfyUI 契约，非字符串）')
    const wf0 = promptBodies[0]
    const wf1 = promptBodies[1]
    const wf6 = promptBodies[6]
    ok(wf0['3'].inputs.ref_image === '' && wf1['3'].inputs.ref_image === 'ref-0.png', '首帧无垫图、次帧起垫图名进 workflow')
    ok(wf0['3'].inputs.seed === 20260919 && wf6['3'].inputs.seed === 20260925, `{{SEED}} 逐帧派生为数值（got ${wf0['3'].inputs.seed}/${wf6['3'].inputs.seed}）`)
    ok(wf6['3'].inputs.width === 512 && wf6['3'].inputs.height === 512, '{{WIDTH}}/{{HEIGHT}}=genSize 512')
    ok(wf0['3'].inputs.prompt.includes('idle') && wf6['3'].inputs.prompt.includes('think'), '{{PROMPT}} 含状态提示词')
  }
  const dir = path.join(tmp, 'out', 'pet-packs', 'comfypet')
  if (!fs.existsSync(path.join(dir, 'pet.json'))) {
    ok(false, 'comfyui 产物缺失（见上）')
  } else {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'pet.json'), 'utf8'))
    ok(pet.validatePetManifest(manifest) !== null, 'comfyui 产物过 validatePetManifest')
    const frame = cli.decodePng(fs.readFileSync(path.join(dir, 'happy-0.png')))
    ok(frame.rgba[3] === 0, 'comfyui 通道产物同样去了背（/view 图角 alpha=0）')
  }
  await server.stop()
}

console.log('—— gptimage 真通道（参考图 400 → 无参考降级重试；b64_json；apiKey 不泄露）——')
{
  const SECRET = 'sk-test-secret-abc'
  const png = testPng()
  let sawMultipart = false
  let sawJson = false
  let jsonShapeOk = false
  const { server } = makeServer((req, res, body) => {
    const isMultipart = (req.headers['content-type'] || '').startsWith('multipart/form-data')
    if (req.method === 'POST') {
      if (isMultipart) {
        sawMultipart = true
        res.statusCode = 400
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: { message: 'image input not supported' } }))
      } else {
        sawJson = true
        const parsed = JSON.parse(body.toString('utf8'))
        jsonShapeOk = parsed.background === 'transparent' && parsed.output_format === 'png' && parsed.n === 1 && typeof parsed.prompt === 'string'
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
      }
    } else {
      res.statusCode = 404
      res.end('{}')
    }
  })
  await server.start()
  const port = server.address().port
  const cfg = writeCfg((c) => {
    c.packId = 'gptpet'
    c.states = { dragged: 1, happy: 1 }
    c.backend = { gptimage: { endpoint: `http://127.0.0.1:${port}/v1/images/generations`, apiKeyEnv: 'SMOKE_PET_PACK_FAKE_KEY', model: 'gpt-image-1' } }
  })
  const r = await runAsync(['run', '--config', cfg], { SMOKE_PET_PACK_FAKE_KEY: SECRET })
  ok(r.status === 0, `gptimage 通道 run 通过（exit=${r.status}）${r.status !== 0 ? ' stderr=' + r.stderr : ''}`)
  ok(sawMultipart && sawJson, '带参考图请求被 400 拒 → 无参考降级重试')
  ok(jsonShapeOk, '请求形状：background=transparent + output_format=png + n=1')
  ok(!(r.stdout.includes(SECRET) || r.stderr.includes(SECRET)), 'stdout/stderr 不含 apiKey 明文')
  const dir = path.join(tmp, 'out', 'pet-packs', 'gptpet')
  if (!fs.existsSync(path.join(dir, 'pet.json'))) {
    ok(false, 'gptimage 产物缺失（见上）')
  } else {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'pet.json'), 'utf8'))
    ok(pet.validatePetManifest(manifest) !== null, 'gptimage 产物过 validatePetManifest')
  }
  // 缺 apiKey：启动即失败，且没打任何网络请求
  const r2 = await runAsync(['run', '--config', cfg])
  ok(r2.status === 1 && r2.stderr.includes('SMOKE_PET_PACK_FAKE_KEY'), `缺 apiKey 报 env 变量名（exit=${r2.status}）`)
  await server.stop()
}

console.log('—— 错误出口 ——')
{
  const r = runSync(['frobnicate'])
  ok(r.status === 2, `未知命令 exit=2（got ${r.status}）`)
  const r2 = runSync(['run', '--config', path.join(tmp, 'nope.json')])
  ok(r2.status === 1 && r2.stderr.includes('读配置失败'), `配置不存在报读失败（exit=${r2.status}）`)
}

fs.rmSync(tmp, { recursive: true, force: true })
if (failed) { console.error(`\n❌ PET PACK SMOKE FAILED (${failed})`); process.exit(1) }
console.log('\n✅ PET PACK SMOKE PASSED')
