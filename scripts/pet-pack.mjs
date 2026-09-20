// AI 素材包生成 CLI（零运行时依赖：node 内置 + 原生 fetch/WebSocket；esbuild 是 devDependency，
// 只在启动时把 src/main/pet/pack-image.ts 现场打包成 CJS 加载——照 smoke 的 entryPoints 模式，
// 不违反主进程零运行时 npm 依赖铁律：图像管线与主进程 PetGenController 同源一份实现）。
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
//
// 用法：
//   node scripts/pet-pack.mjs init [--config pet-pack.config.json] [--force]
//   node scripts/pet-pack.mjs validate [--config ...]
//   node scripts/pet-pack.mjs run [--config ...] [--mock]
//   node scripts/pet-pack.mjs preview [--config ...]
import fs from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')

// —— 图像管线：src/main/pet/pack-image.ts 现场打包加载（PNG 编解码/重采样/contain/去背/切帧/manifest）——
const PACK_IMAGE_OUTFILE = path.join(root, 'out', 'pet-pack-image.cli.cjs')
await build({ entryPoints: [path.join(root, 'src/main/pet/pack-image.ts')], outfile: PACK_IMAGE_OUTFILE, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
const packImage = await import(pathToFileURL(PACK_IMAGE_OUTFILE).href)
const { contentBBox, chromaKeyFlood, decodePng, encodePng, fitFramesToCanvas, resizeRGBA, resolveFrameCounts, buildManifest, splitSheet, PNG_SIGNATURE } = packImage

// —— 状态契约镜像（源头：src/shared/pet.ts PET_CORE_STATE_IDS + PET_EXTRA_STATE_IDS）——
const CORE_STATE_IDS = ['idle', 'walk', 'fall', 'dragged', 'sleep', 'happy', 'think']
const EXTRA_STATE_IDS = ['eat']
const STATE_IDS = [...CORE_STATE_IDS, ...EXTRA_STATE_IDS]

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
  console.log(`  拷到小助理 userData/pets/${config.packId}/（或直接在小助理设置里换包）即可使用`)
}

function logBackend(config, backend, mock) {
  if (mock) console.log('backend=mock（假后端演示全管线，不联网）')
  else if (backend.kind === 'comfyui') console.log(`backend=comfyui @ ${config.backend.address}`)
  else console.log(`backend=gptimage @ ${config.backend.endpoint}（model=${config.backend.model}，apiKey 从 env:${config.backend.apiKeyEnv} 读，不打印）`)
}

// ============================== 入口 ==============================

function usage() {
  console.log(`AI 素材包生成 CLI

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

// 图像管线与 manifest 构建再导出（与 src/main/pet/pack-image.ts 同源；smoke 直连这些导出做反校验）
export { CORE_STATE_IDS, EXTRA_STATE_IDS, STATE_IDS, ConfigError, UsageError, buildManifest, chromaKeyFlood, configErrors, contentBBox, decodePng, encodePng, fillWorkflow, fitFramesToCanvas, loadConfig, mockGenerate, mulberry32, resizeRGBA, resolveFrameCounts, runPack, splitSheet }
