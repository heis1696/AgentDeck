// PetGenController：应用内素材包生成——走 API 预设的 images 通道（OpenAI 形状）。
// per-frame 模式逐帧生成（首帧作后续参考图，400/422 自动降级为无参考重试，逻辑照 pet-pack.mjs）；
// sheet 模式单图生成后按网格切帧、行主序依序映射到 states 帧表。
// apiKey 只在请求头里出现，任何进度/错误/落盘内容不得携带（错误只报 HTTP 状态）；
// 图像管线复用 pack-image 纯函数；落盘 userData/pets/<packId>/（临时目录 + rename 原子换入），
// 完成后素材包下拉经 scanUserPack 即见。
import fs from 'node:fs'
import path from 'node:path'
import type { ApiPreset } from '../presets'
import { PET_STATE_IDS, type PetGenProgress, type PetGenStartInput } from '../../shared/pet'
import { PNG_SIGNATURE, buildManifest, chromaKeyFlood, decodePng, encodePng, fitFramesToCanvas, resolveFrameCounts, splitSheet, type DecodedPng } from './pack-image'
import { USER_PETS_DIR } from './packs'

/** 帧尺寸固定 64×64（渲染层 petSpriteRect 按 64 基准换算） */
export const PET_GEN_FRAME_SIZE: [number, number] = [64, 64]
const GEN_TIMEOUT_MS = 180_000
/** 色度键容差（与 pet-pack.mjs 默认一致） */
const CHROMA_TOLERANCE = 0.15

// 各态画面提示词（与 scripts/pet-pack.mjs 的 STATE_PROMPTS 同表镜像：CLI 独立运行，两处语义一致）
const STATE_PROMPTS: Record<string, string> = {
  idle: 'standing still and relaxed, gentle idle breathing',
  walk: 'mid-step walking pose, side view',
  fall: 'falling through the air, arms up, surprised face',
  dragged: 'held up from above, dangling, wide eyes',
  sleep: 'sleeping peacefully, eyes closed, tiny zzz',
  happy: 'jumping with joy, big open smile',
  think: 'pondering, looking to the side, thoughtful pose',
  eat: 'happily eating a small snack, holding a tiny cookie'
}

export interface PetGenDeps {
  userDataDir: string
  getPresets: () => ApiPreset[]
  /** 进度/完成/失败广播出口（主窗 + 宠物窗 + 设置窗由 controller 收口） */
  notify: (channel: string, payload: unknown) => void
  /** 可注入 fetch（smoke 断言请求形状与 key 不泄漏） */
  fetchImpl?: typeof fetch
}

/** 端点候选：baseURL 归一化后网关直挂 /images/generations 优先，/v1 形态兜底（照 buildChatRequest 惯例） */
export function genEndpointCandidates(baseURL: string): string[] {
  const trimmed = baseURL.replace(/\/+$/, '')
  if (trimmed.endsWith('/images/generations')) return [trimmed]
  const base = trimmed.replace(/\/v1$/, '')
  return [`${base}/images/generations`, `${base}/v1/images/generations`]
}

/** images 请求体（OpenAI 形状子集；smoke 断言形状——绝不携带 apiKey） */
export function buildGenBody(model: string, prompt: string, params: PetGenStartInput['params']): Record<string, unknown> {
  return {
    model,
    prompt,
    n: params.n,
    size: params.size,
    background: params.background === 'opaque' ? 'opaque' : 'transparent',
    output_format: 'png',
    ...(params.quality ? { quality: params.quality } : {})
  }
}

interface GenJob {
  stateId: string
  frameIndex: number
  count: number
}

class PetGenCancelled extends Error {
  constructor() {
    super('已取消')
  }
}

export class PetGenController {
  private busy = false
  private cancelRequested = false
  private readonly fetchImpl: typeof fetch

  constructor(private readonly deps: PetGenDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch.bind(globalThis)
  }

  isBusy(): boolean {
    return this.busy
  }

  /** 请求取消：当前帧完成后停下（落盘是原子的，取消不留半包） */
  cancel(): void {
    if (this.busy) this.cancelRequested = true
  }

  /** 启动生成：入参已过 IPC 校验；立即返回，进度经 notify 推送（pet:gen-progress/done/error） */
  async start(input: PetGenStartInput): Promise<{ ok: boolean; error?: string }> {
    if (this.busy) return { ok: false, error: '已有生成任务进行中，请等它完成或取消' }
    const preset = this.deps.getPresets().find((item) => item.id === input.presetId)
    if (!preset) return { ok: false, error: '找不到所选模型预设（可能已被删除）' }
    if (!preset.apiKey) return { ok: false, error: '所选预设未配置 apiKey，请先在 API 预设里补齐' }
    this.busy = true
    this.cancelRequested = false
    void this.run(input, preset).finally(() => {
      this.busy = false
      this.cancelRequested = false
    })
    return { ok: true }
  }

  private async run(input: PetGenStartInput, preset: ApiPreset): Promise<void> {
    try {
      const frameCount = await this.generateAndWrite(input, preset)
      this.deps.notify('pet:gen-done', { packId: input.packId, frameCount })
    } catch (err) {
      const reason = err instanceof PetGenCancelled ? '已取消' : err instanceof Error ? err.message : String(err)
      this.deps.notify('pet:gen-error', { packId: input.packId, reason })
    }
  }

  private throwIfCancelled(): void {
    if (this.cancelRequested) throw new PetGenCancelled()
  }

  private progress(p: PetGenProgress): void {
    this.deps.notify('pet:gen-progress', p)
  }

  /** 全管线：帧任务 → images 请求 → 去背/落位 → pet.json + 帧 PNG 原子落盘；返回总帧数 */
  private async generateAndWrite(input: PetGenStartInput, preset: ApiPreset): Promise<number> {
    const counts = resolveFrameCounts(input.states) // 七态必需补齐（validatePetManifest 契约），eat 只在显式给出时进包
    const jobs: GenJob[] = []
    for (const stateId of PET_STATE_IDS) {
      const count = counts[stateId]
      if (count === undefined) continue
      for (let i = 0; i < count; i++) jobs.push({ stateId, frameIndex: i, count })
    }
    let decoded: DecodedPng[]
    if (input.mode === 'sheet') {
      decoded = await this.generateSheet(input, preset, jobs)
    } else {
      decoded = await this.generatePerFrame(input, preset, jobs)
    }
    this.throwIfCancelled()
    this.progress({ done: decoded.length, total: decoded.length, stage: '统一缩放落位' })
    const [frameW, frameH] = PET_GEN_FRAME_SIZE
    const canvases = fitFramesToCanvas(decoded, frameW, frameH, 'bottom-center')
    const manifest = buildManifest(counts, PET_GEN_FRAME_SIZE, {
      stylePrompt: input.stylePrompt,
      backend: 'gptimage',
      mode: input.mode,
      generatedAt: new Date().toISOString()
    })
    // 帧文件与 canvases 对齐：manifest.states 迭代序 = PET_STATE_IDS 过滤序 = jobs 序
    const files = new Map<string, Buffer>()
    let index = 0
    for (const def of Object.values(manifest.states)) {
      for (let f = 0; f < def.frames.length; f++) {
        files.set(def.frames[f], encodePng(frameW, frameH, canvases[index]))
        index++
      }
    }
    files.set('pet.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'))
    const finalDir = path.join(this.deps.userDataDir, USER_PETS_DIR, input.packId)
    atomicWriteDir(finalDir, files)
    return jobs.length
  }

  /** per-frame：逐帧生成；首帧留作后续帧参考图（服务端拒则整体降级为无参考） */
  private async generatePerFrame(input: PetGenStartInput, preset: ApiPreset, jobs: GenJob[]): Promise<DecodedPng[]> {
    const decoded: DecodedPng[] = []
    let refBytes: Buffer | null = null
    let refRejected = false
    for (const job of jobs) {
      this.throwIfCancelled()
      this.progress({ done: decoded.length, total: jobs.length, stage: `生成 ${job.stateId}-${job.frameIndex}` })
      const prompt = framePrompt(input.stylePrompt, job)
      const bytes = await this.requestImage(preset, input, prompt, !refRejected ? refBytes : null)
      if (!refBytes) refBytes = bytes
      if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error(`${job.stateId}-${job.frameIndex}: 后端返回的不是 PNG`)
      decoded.push(this.processImage(bytes, input.params.background === 'transparent'))
    }
    return decoded
  }

  /** sheet：单图生成 → 全图去背 → 网格切帧（行主序）依序映射帧任务表 */
  private async generateSheet(input: PetGenStartInput, preset: ApiPreset, jobs: GenJob[]): Promise<DecodedPng[]> {
    const cols = input.sheet?.cols ?? 4
    const rows = input.sheet?.rows ?? Math.ceil(jobs.length / cols)
    this.progress({ done: 0, total: 1, stage: '生成 sheet 图' })
    const prompt = sheetPrompt(input.stylePrompt, cols, rows, jobs)
    const bytes = await this.requestImage(preset, input, prompt, null)
    this.throwIfCancelled()
    this.progress({ done: 1, total: 1, stage: `切帧 ${cols}×${rows}` })
    if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('后端返回的不是 PNG')
    const image = this.processImage(bytes, input.params.background === 'transparent')
    const cells = splitSheet(image, cols, rows)
    if (cells.length < jobs.length) throw new Error(`sheet 切出 ${cells.length} 格，少于需要的 ${jobs.length} 帧`)
    return cells.slice(0, jobs.length)
  }

  /** 去背（透明背景时四角 flood-fill）——返回处理后的图 */
  private processImage(bytes: Buffer, removeBackground: boolean): DecodedPng {
    const image = decodePng(bytes)
    if (!removeBackground) return image
    const keyed = chromaKeyFlood(image.rgba, image.width, image.height, CHROMA_TOLERANCE)
    return keyed.keyed ? { ...image, rgba: keyed.rgba } : image
  }

  /**
   * images 单次请求：候选端点按序尝试；带参考图走 multipart（编辑形状），
   * 400/422 判定为服务端不支持参考图 → 记住拒绝并降级为无参考纯生成。
   * 错误信息只带 HTTP 状态与主机名，绝不携带 apiKey。
   */
  private async requestImage(preset: ApiPreset, input: PetGenStartInput, prompt: string, refBytes: Buffer | null): Promise<Buffer> {
    const errors: string[] = []
    let refRejected = refBytes === null
    for (const url of genEndpointCandidates(preset.baseURL)) {
      this.throwIfCancelled()
      try {
        if (!refRejected && refBytes) {
          const form = new FormData()
          for (const [key, value] of Object.entries(buildGenBody(input.model, prompt, input.params))) form.append(key, String(value))
          form.append('image', new Blob([Uint8Array.from(refBytes)], { type: 'image/png' }), 'ref.png')
          const res = await this.fetchImpl(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${preset.apiKey}` },
            body: form,
            signal: AbortSignal.timeout(GEN_TIMEOUT_MS)
          })
          if (res.ok) return await readImageBody(res, this.fetchImpl)
          if (res.status === 400 || res.status === 422) {
            refRejected = true // 参考图被拒：后续候选直接走无参考
          } else {
            errors.push(`HTTP ${res.status} @ ${hostOf(url)}`)
            continue
          }
        }
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${preset.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(buildGenBody(input.model, prompt, input.params)),
          signal: AbortSignal.timeout(GEN_TIMEOUT_MS)
        })
        if (res.ok) return await readImageBody(res, this.fetchImpl)
        errors.push(`HTTP ${res.status} @ ${hostOf(url)}`)
      } catch (err) {
        if (err instanceof PetGenCancelled) throw err
        errors.push(err instanceof Error ? err.message : String(err))
      }
    }
    throw new Error(`images 请求失败：${errors.join('；') || '无可用端点'}`)
  }
}

/** 响应取图：b64_json 优先，url 回退下载（下载同样走注入的 fetch，便于 smoke） */
async function readImageBody(res: Response, fetchImpl: typeof fetch): Promise<Buffer> {
  let payload: unknown
  try {
    payload = await res.json()
  } catch {
    throw new Error(`images 响应不是 JSON（HTTP ${res.status}）`)
  }
  const item = (payload as { data?: Array<{ b64_json?: unknown; url?: unknown }> })?.data?.[0]
  if (typeof item?.b64_json === 'string' && item.b64_json) return Buffer.from(item.b64_json, 'base64')
  if (typeof item?.url === 'string' && item.url) {
    const img = await fetchImpl(item.url, { signal: AbortSignal.timeout(GEN_TIMEOUT_MS) })
    if (!img.ok) throw new Error(`下载生成图失败：HTTP ${img.status}`)
    return Buffer.from(await img.arrayBuffer())
  }
  throw new Error('响应缺 data[0].b64_json/url')
}

function framePrompt(stylePrompt: string, job: GenJob): string {
  const pose = STATE_PROMPTS[job.stateId] ?? 'neutral pose'
  return `${stylePrompt}. Character: ${pose}. Sprite animation frame ${job.frameIndex + 1} of ${job.count} for the "${job.stateId}" state. Single character, centered, full body visible.`
}

function sheetPrompt(stylePrompt: string, cols: number, rows: number, jobs: GenJob[]): string {
  const cells = jobs.map((job, index) => `cell ${index + 1} (${job.stateId} frame ${job.frameIndex + 1}/${job.count}: ${STATE_PROMPTS[job.stateId] ?? 'neutral pose'})`)
  return `${stylePrompt}. Sprite sheet layout: a grid of exactly ${cols} columns x ${rows} rows, equal cell sizes, cells in row-major order (left to right, top to bottom), no borders, no gaps, no labels, no text. ${cells.join('; ')}. Uniform plain solid light gray background across the whole sheet. Single character design, full body visible in every cell.`
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** 临时目录 + rename 原子落盘（同盘 shuffle：旧目录先挪走再换入，Windows 上 rename 不覆盖目录） */
function atomicWriteDir(finalDir: string, files: Map<string, Buffer>): void {
  const parent = path.dirname(finalDir)
  fs.mkdirSync(parent, { recursive: true })
  const tmp = path.join(parent, `.pet-pack-tmp-${path.basename(finalDir)}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(tmp)
  try {
    for (const [name, data] of files) fs.writeFileSync(path.join(tmp, name), data)
    let old: string | undefined
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
