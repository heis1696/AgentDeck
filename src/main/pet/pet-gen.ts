// PetGenController：应用内素材包生成——走 API 预设的 images 通道（OpenAI 形状）。
// 默认 sheets 模式（按态八表，规格出自 docs/plan/pet-pack-ai-generation.md §4 配方与 §6 踩坑）：
// 每个状态生成一张洋红 sheet——首张 idle 走 /v1/images/generations，其余各态走 /v1/images/edits
// multipart 且携带 idle sheet 字节作锚点（跨表一致性靠锚点链；锚点字节内存传递不落盘）；
// prompt 照 §4.2 手写模板（洋红铁律 + N 等分 + 无框线无文字），切帧前 QC（四角洋红 + 空帧检测，
// §6.4），传输层 3 次退避重试（§6.3 中转站 ~100s 网关上限 → 单请求 180s 超时）。
// per-frame 模式保留为可选：逐帧生成，首帧作后续参考图，400/422 自动降级为无参考重试（照 pet-pack.mjs）。
// 原单张 sheet 模式已删除（多态挤一张时布局纪律不可靠）。
// apiKey 只在请求头里出现，任何进度/错误/落盘内容不得携带（错误只报 HTTP 状态）；
// 图像管线复用 pack-image 纯函数；落盘 userData/pets/<packId>/（临时目录 + rename 原子换入），
// 完成后素材包下拉经 scanUserPack 即见。
import fs from 'node:fs'
import path from 'node:path'
import type { ApiPreset } from '../presets'
import { PET_STATE_IDS, petSheetGridFor, petSheetSizeForGrid, type PetGenDone, type PetGenProgress, type PetGenStartInput } from '../../shared/pet'
import { PNG_SIGNATURE, buildManifest, chromaKeyFlood, decodePng, encodePng, fitFramesToCanvas, resolveFrameCounts, splitSheet, type DecodedPng } from './pack-image'
import { USER_PETS_DIR } from './packs'

/** 帧尺寸固定 256×256（显示端最大档 1:1，其余下采样；§5 清晰度教训的根因修复） */
export const PET_GEN_FRAME_SIZE: [number, number] = [256, 256]
/** 单请求超时 180s：中转站 Cloudflare ~100s 上限之上留余量（§6.3） */
export const GEN_TIMEOUT_MS = 180_000
/** 每张 sheet 的退避重试次数（5s × 第 n 次重试；§6.3 偶发 504） */
export const SHEET_RETRIES = 3
export const SHEET_RETRY_BACKOFF_MS = 5_000
/** 空帧判定：切帧后单格非透明覆盖率低于该阈值视为空帧（§4.4） */
export const SHEET_EMPTY_CELL_RATIO = 0.05
/** 色度键容差（与 pet-pack.mjs 默认一致） */
const CHROMA_TOLERANCE = 0.15

// 各态画面提示词（per-frame 模式用；与 scripts/pet-pack.mjs 的 STATE_PROMPTS 同表镜像：CLI 独立运行，两处语义一致）
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

/**
 * 按态分表的逐格动作默认表（§4.1：idle 站立呼吸三段、walk 侧视循环四段、
 * fall 惊慌→压扁、dragged 拎起哭脸、sleep 蜷睡两段、happy 跳起→压扁、think 歪头→沉思、eat 吃饼干三段）。
 * 帧数超出默认表时由 sheetCellActions 用同动作延续句补齐。
 */
export const SHEET_STATE_CELL_ACTIONS: Record<string, string[]> = {
  idle: ['standing still, neutral relaxed pose', 'breathing in, body slightly squashed down', 'breathing out, body gently stretched tall'],
  walk: ['side-view walk, front foot touching the ground', 'body compressed down, weight passing over', 'pushing off the ground, rebounding upward', 'highest stretch, mid-air stride'],
  fall: ['falling through the air, arms flailing, panicked face', 'landed impact, squashed flat, dizzy face'],
  dragged: ['picked up from above and hanging in mid-air, body stretched downward, crying face'],
  sleep: ['curled up asleep with a soft smile, eyes closed', 'sleeping deeper, curled even tighter, eyes closed'],
  happy: ['jumping up with both arms raised, big open-mouth laugh', 'landed and squashed, eyes squeezed shut with joy'],
  think: ['head tilted, looking up and to the side, pouting', 'chin tucked down, deep in thought with a small sweat drop'],
  eat: ['holding a small cookie, mouth open about to bite', 'chewing with puffed cheeks, crumbs flying', 'licking lips, satisfied']
}

/** 第 n 格动作描述：默认表内取前 n 项，超出用同动作延续句补齐（帧数表改动时逐格描述同步换算） */
export function sheetCellActions(stateId: string, frames: number): string[] {
  const base = SHEET_STATE_CELL_ACTIONS[stateId] ?? ['neutral pose']
  return Array.from({ length: frames }, (_, i) => (i < base.length ? base[i] : `continuation of the same ${stateId} motion, phase ${i + 1}`))
}

/**
 * 按态分表 prompt（§4.2 手写模板，只借 agent-sprite-forge 的规则不借它的 build-prompt——
 * 后者会硬编码风格标签污染自定义人设，§6.5）。anchored=true 时加锚点句（edits 图生图用）。
 */
export function buildSheetPrompt(opts: { description: string; styleTags?: string; cols: number; rows: number; actions: string[]; anchored: boolean }): string {
  const n = opts.cols * opts.rows
  const cells = opts.actions.map((action, i) => `Cell ${i + 1}: ${action}.`).join(' ')
  const stylePart = opts.styleTags ? ` ${opts.styleTags}.` : ''
  const body = [
    `A ${opts.rows}x${opts.cols} 2D game sprite animation sheet of the same ${opts.description}.`,
    `Layout: ${opts.cols} columns x ${opts.rows} rows, reading order left-to-right then top-to-bottom.`,
    cells,
    `SAME character, SAME size, SAME facing direction, SAME palette in all ${n} cells.${stylePart}`,
    'Background is 100% solid flat magenta (#FF00FF) everywhere, no gradients.',
    'NO text, NO labels, NO words, NO letters anywhere.',
    `ABSOLUTE RULES: 1. EXACTLY ${n} equal cells. 2. NO borders/dividing lines/frames between cells. 3. NO text. 4. Character fills 80%+ of each cell, SAME size/bounding box/pixel scale, nothing crossing a cell edge. 5. Cells connected by magenta background only.`
  ].join('\n')
  if (!opts.anchored) return body
  return `Recreate the EXACT same character from the reference image (identical identity, colors, proportions, outline and style), arranged as a new sheet: ${body} Use the reference image only for the character identity, not its poses or layout.`
}

/** 端点候选：baseURL 归一化后网关直挂 /images/generations 优先，/v1 形态兜底（照 buildChatRequest 惯例） */
export function genEndpointCandidates(baseURL: string): string[] {
  const trimmed = baseURL.replace(/\/+$/, '')
  if (trimmed.endsWith('/images/generations')) return [trimmed]
  const base = trimmed.replace(/\/v1$/, '')
  return [`${base}/images/generations`, `${base}/v1/images/generations`]
}

/** edits 端点候选（按态分表的图生图；归一化规则同上） */
export function editEndpointCandidates(baseURL: string): string[] {
  const trimmed = baseURL.replace(/\/+$/, '')
  if (trimmed.endsWith('/images/edits')) return [trimmed]
  if (trimmed.endsWith('/images/generations')) return [trimmed.replace(/generations$/, 'edits')]
  const base = trimmed.replace(/\/v1$/, '')
  return [`${base}/images/edits`, `${base}/v1/images/edits`]
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

/**
 * 按态分表请求体：洋红铁律靠 prompt、去背靠色度键，因此不下发 background 透传
 * （要了 transparent 反而可能让模型直接丢掉洋红底，QC 四角校验必炸）。
 */
export function buildSheetBody(model: string, prompt: string, size: string, quality: string): Record<string, unknown> {
  return { model, prompt, n: 1, size, output_format: 'png', ...(quality ? { quality } : {}) }
}

export interface PetGenDeps {
  userDataDir: string
  getPresets: () => ApiPreset[]
  /** 进度/完成/失败广播出口（主窗 + 宠物窗 + 设置窗由 controller 收口） */
  notify: (channel: string, payload: unknown) => void
  /** 可注入 fetch（smoke 断言请求形状与 key 不泄漏） */
  fetchImpl?: typeof fetch
  /** 退避重试基数 ms（缺省 SHEET_RETRY_BACKOFF_MS=5000；smoke 注入小值加速） */
  retryDelayMs?: number
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
  private readonly retryDelayMs: number

  constructor(private readonly deps: PetGenDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch.bind(globalThis)
    this.retryDelayMs = deps.retryDelayMs ?? SHEET_RETRY_BACKOFF_MS
  }

  isBusy(): boolean {
    return this.busy
  }

  /** 请求取消：当前请求完成后停下（落盘是原子的，取消不留半包） */
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
    const startedAt = Date.now()
    try {
      const result = await this.generateAndWrite(input, preset)
      const done: PetGenDone = { packId: input.packId, frameCount: result.frameCount, warnings: result.warnings, elapsedMs: Date.now() - startedAt }
      this.deps.notify('pet:gen-done', done)
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

  /** 全管线：生成 → QC/切帧 → 去背/落位 → pet.json + 帧 PNG 原子落盘；返回总帧数与 QC 警告 */
  private async generateAndWrite(input: PetGenStartInput, preset: ApiPreset): Promise<{ frameCount: number; warnings: string[] }> {
    const counts = resolveFrameCounts(input.states) // 七态必需补齐（validatePetManifest 契约），eat 只在显式给出时进包
    let decoded: DecodedPng[]
    let warnings: string[] = []
    if (input.mode === 'sheets') {
      const sheets = await this.generateSheets(input, preset, counts)
      decoded = sheets.frames
      warnings = sheets.warnings
    } else {
      const jobs: GenJob[] = []
      for (const stateId of PET_STATE_IDS) {
        const count = counts[stateId]
        if (count === undefined) continue
        for (let i = 0; i < count; i++) jobs.push({ stateId, frameIndex: i, count })
      }
      decoded = await this.generatePerFrame(input, preset, jobs)
    }
    this.throwIfCancelled()
    this.progress({ done: decoded.length, total: decoded.length, stage: '统一缩放落位' })
    const [frameW, frameH] = PET_GEN_FRAME_SIZE
    const canvases = fitFramesToCanvas(decoded, frameW, frameH, 'bottom-center')
    const manifest = buildManifest(counts, PET_GEN_FRAME_SIZE, {
      stylePrompt: input.stylePrompt,
      ...(input.styleTags ? { styleTags: input.styleTags } : {}),
      backend: 'gptimage',
      mode: input.mode,
      generatedAt: new Date().toISOString()
    })
    // 帧文件与 canvases 对齐：manifest.states 迭代序 = PET_STATE_IDS 过滤序 = 生成序
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
    return { frameCount: decoded.length, warnings }
  }

  /**
   * 按态分表（§4 配方）：idle 先文生图出首张洋红 sheet 并定格为锚点字节（内存传递，不落盘），
   * 其余各态携锚点走 edits 图生图；每张 sheet 传输层 3 次退避重试 + QC（四角洋红/空帧）
   * 失败自动重试一次，仍失败标注 warning 继续整包（§6.4，不中断）。
   */
  private async generateSheets(input: PetGenStartInput, preset: ApiPreset, counts: Record<string, number>): Promise<{ frames: DecodedPng[]; warnings: string[] }> {
    const states = PET_STATE_IDS.filter((id) => counts[id] !== undefined)
    const quality = input.params.quality || 'medium' // §4.3：1k + medium 控制单张时长在网关上限内
    const warnings: string[] = []
    const frames: DecodedPng[] = []
    let anchorBytes: Buffer | null = null
    for (let s = 0; s < states.length; s++) {
      this.throwIfCancelled() // 取消令牌每张之间检查
      const stateId = states[s]
      const count = counts[stateId]
      const grid = petSheetGridFor(count)
      const size = petSheetSizeForGrid(grid)
      const actions = sheetCellActions(stateId, count)
      const label = `生成 ${stateId} sheet ${s + 1}/${states.length}`
      this.progress({ done: s, total: states.length, stage: label })
      const promptOf = (anchored: boolean) => buildSheetPrompt({ description: input.stylePrompt, styleTags: input.styleTags, cols: grid.cols, rows: grid.rows, actions, anchored })
      let attempt = await this.generateSheetOnce(input, preset, promptOf, size, quality, anchorBytes, count, grid, (attemptNo) => {
        this.progress({ done: s, total: states.length, stage: `${label}（第 ${attemptNo} 次重试）` })
      })
      if (!attempt.qc.ok) {
        // QC 未过：该 sheet 自动重试一次（§6.4）
        this.progress({ done: s, total: states.length, stage: `${label}（质检未过，重试）` })
        attempt = await this.generateSheetOnce(input, preset, promptOf, size, quality, anchorBytes, count, grid, (attemptNo) => {
          this.progress({ done: s, total: states.length, stage: `${label}（质检重试第 ${attemptNo} 次）` })
        })
      }
      if (!attempt.qc.ok) warnings.push(`${stateId} sheet：${attempt.qc.reason}（重试后仍不达标，按现状入包）`)
      if (attempt.cells.length < count) throw new Error(`${stateId} sheet 切帧不足：需要 ${count} 格，只得到 ${attempt.cells.length} 格`)
      if (!anchorBytes) anchorBytes = attempt.bytes // 首张 idle 定格为锚点（QC 重试也取最新成功字节）
      frames.push(...attempt.cells.slice(0, count))
    }
    return { frames, warnings }
  }

  /** 单张 sheet：请求（传输层重试内聚）→ QC → 网格切帧；QC 结果与切出的格一并返回（失败时也尽力切，供降级入包） */
  private async generateSheetOnce(
    input: PetGenStartInput,
    preset: ApiPreset,
    promptOf: (anchored: boolean) => string,
    size: string,
    quality: string,
    anchorBytes: Buffer | null,
    count: number,
    grid: { cols: number; rows: number },
    onRetry?: (attempt: number) => void
  ): Promise<{ bytes: Buffer; qc: { ok: boolean; reason: string }; cells: DecodedPng[] }> {
    const anchored = anchorBytes !== null
    const bytes = await this.requestSheetBytes(input, preset, promptOf(anchored), size, quality, anchorBytes, onRetry)
    const qc = this.qcSheet(bytes, count, grid)
    return { bytes, qc, cells: qc.cells }
  }

  /** QC（§6.4）：切帧前先验四角洋红（防上游风格漂移），切帧后逐格非透明覆盖率 <5% 判空帧 */
  private qcSheet(bytes: Buffer, frames: number, grid: { cols: number; rows: number }): { ok: boolean; reason: string; cells: DecodedPng[] } {
    let image: DecodedPng
    try {
      image = decodePng(bytes)
    } catch {
      return { ok: false, reason: '返回内容不是 PNG', cells: [] }
    }
    const cornersOk = cornersAreMagenta(image)
    // 洋红底四角色度键去背（角色均值为键色，BFS 只清连通区，精灵内部同色不受牵连）
    const keyed = chromaKeyFlood(image.rgba, image.width, image.height, CHROMA_TOLERANCE)
    const processed: DecodedPng = keyed.keyed ? { ...image, rgba: keyed.rgba } : image
    let cells: DecodedPng[] = []
    try {
      cells = splitSheet(processed, grid.cols, grid.rows)
    } catch {
      cells = []
    }
    if (!cornersOk) return { ok: false, reason: '四角不是洋红背景（疑似上游风格漂移）', cells }
    if (cells.length < grid.cols * grid.rows) return { ok: false, reason: `图装不下 ${grid.cols}×${grid.rows} 网格`, cells }
    const empty: number[] = []
    for (let i = 0; i < frames; i++) {
      if (nonTransparentRatio(cells[i]) < SHEET_EMPTY_CELL_RATIO) empty.push(i + 1)
    }
    if (empty.length) return { ok: false, reason: `第 ${empty.join(',')} 格近空帧（非透明覆盖 <5%）`, cells }
    return { ok: true, reason: '', cells }
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

  /** 去背（透明背景时四角 flood-fill）——返回处理后的图 */
  private processImage(bytes: Buffer, removeBackground: boolean): DecodedPng {
    const image = decodePng(bytes)
    if (!removeBackground) return image
    const keyed = chromaKeyFlood(image.rgba, image.width, image.height, CHROMA_TOLERANCE)
    return keyed.keyed ? { ...image, rgba: keyed.rgba } : image
  }

  /**
   * 单张 sheet 请求：3 次退避重试（5s×第 n 次重试，§6.3），每次重试内按候选端点逐个尝试。
   * 锚点在 → multipart edits；否则 JSON generations。错误信息只带 HTTP 状态与主机名，绝不携带 apiKey。
   */
  private async requestSheetBytes(
    input: PetGenStartInput,
    preset: ApiPreset,
    prompt: string,
    size: string,
    quality: string,
    anchorBytes: Buffer | null,
    onRetry?: (attempt: number) => void
  ): Promise<Buffer> {
    const errors: string[] = []
    for (let attempt = 0; attempt <= SHEET_RETRIES; attempt++) {
      this.throwIfCancelled()
      try {
        return await this.requestSheetOnce(input, preset, prompt, size, quality, anchorBytes)
      } catch (err) {
        if (err instanceof PetGenCancelled) throw err
        errors.push(err instanceof Error ? err.message : String(err))
      }
      if (attempt < SHEET_RETRIES) {
        onRetry?.(attempt + 1)
        await this.retryBackoff(attempt + 1)
      }
    }
    throw new Error(`images 请求失败（已退避重试 ${SHEET_RETRIES} 次）：${errors.join('；')}`)
  }

  /** 退避等待（5s×第 n 次重试；smoke 可注入短延时），醒后再查取消令牌 */
  private async retryBackoff(retryNo: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * retryNo))
    this.throwIfCancelled()
  }

  private async requestSheetOnce(input: PetGenStartInput, preset: ApiPreset, prompt: string, size: string, quality: string, anchorBytes: Buffer | null): Promise<Buffer> {
    const errors: string[] = []
    if (anchorBytes) {
      for (const url of editEndpointCandidates(preset.baseURL)) {
        this.throwIfCancelled()
        const form = new FormData()
        for (const [key, value] of Object.entries(buildSheetBody(input.model, prompt, size, quality))) form.append(key, String(value))
        form.append('image', new Blob([Uint8Array.from(anchorBytes)], { type: 'image/png' }), 'anchor.png')
        try {
          const res = await this.fetchImpl(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${preset.apiKey}` },
            body: form,
            signal: AbortSignal.timeout(GEN_TIMEOUT_MS)
          })
          if (res.ok) return await readImageBody(res, this.fetchImpl)
          errors.push(`HTTP ${res.status} @ ${hostOf(url)}`)
        } catch (err) {
          if (err instanceof PetGenCancelled) throw err
          errors.push(err instanceof Error ? err.message : String(err))
        }
      }
      throw new Error(`edits 请求失败：${errors.join('；')}`)
    }
    for (const url of genEndpointCandidates(preset.baseURL)) {
      this.throwIfCancelled()
      try {
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${preset.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(buildSheetBody(input.model, prompt, size, quality)),
          signal: AbortSignal.timeout(GEN_TIMEOUT_MS)
        })
        if (res.ok) return await readImageBody(res, this.fetchImpl)
        errors.push(`HTTP ${res.status} @ ${hostOf(url)}`)
      } catch (err) {
        if (err instanceof PetGenCancelled) throw err
        errors.push(err instanceof Error ? err.message : String(err))
      }
    }
    throw new Error(`images 请求失败：${errors.join('；')}`)
  }

  /**
   * images 单次请求（per-frame 模式）：候选端点按序尝试；带参考图走 multipart（编辑形状），
   * 400/422 判定为服务端不支持参考图 → 记住拒绝并降级为无参考纯生成。
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

// —— 供 smoke 直连断言的纯函数（四角洋红校验 / 空帧覆盖率）——

/** 四角洋红校验：任一角不是 #FF00FF 容差内的不透明洋红即失败（§6.4 防上游风格漂移/残留混包） */
export function cornersAreMagenta(image: DecodedPng): boolean {
  const { width: w, height: h, rgba } = image
  const corners = [0, (w - 1) * 4, (h - 1) * w * 4, (w * h - 1) * 4]
  return corners.every((at) => rgba[at + 3] > 200 && rgba[at] >= 180 && rgba[at + 2] >= 180 && rgba[at + 1] <= 120)
}

/** 非透明像素覆盖率（alpha > 8 计入） */
export function nonTransparentRatio(cell: DecodedPng): number {
  let visible = 0
  const total = cell.width * cell.height
  for (let i = 0; i < total; i++) if (cell.rgba[i * 4 + 3] > 8) visible++
  return total > 0 ? visible / total : 0
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
