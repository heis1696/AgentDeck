// 桌宠 AI 脑：自主发言循环 + 一问一答 + 看板事件即时反应 + 每日问候 + 长期记忆。
// 循环节拍：autonomySec（下限 20s）到期 → 宏替换 system 人设 + 最近历史 → pet-llm（15s 超时）
// → parsePetSayPayload → 成功经 onSay 推宠物窗播放；无预设/超时/解析失败走 pet-lines 兜底。
// 护栏：连续 3 次失败静默 10 分钟；防重入（上轮未完跳过）；宠物窗关闭即停表；
// 事件反应/问候走独立 one-shot 通道，忙时节流直接降级本地台词。
import type { BrowserWindow } from 'electron'
import type { ApiPreset } from '../presets'
import type { PetStore } from './pet-store'
import { PET_AUTONOMY_SEC_MIN } from './pet-store'
import type { PetSayAction } from '../../shared/pet'
import { PET_PRESET_NONE } from '../../shared/pet'
import { PET_MEMORY_QUEUE_TRIGGER, PET_MEMORY_SUMMARY_CAP, buildMemoryPrompt, composeMemorySection, mergeMemory, type PetBoardReaction } from '../../shared/pet-life'
import { DEFAULT_PERSONA_TEMPLATE, parsePetSayPayload, pickFallbackSay, pickGreetLine, pickPetLine } from '../../shared/pet-lines'
import { chatCompletion, type PetChatMessage } from './pet-llm'

export interface PersonaMacros {
  board_summary: string
  pack_name: string
  time_of_day: string
  model: string
  recent_event: string
}

export interface PetSay {
  say: string
  action: PetSayAction
}

/** 触发事件反应的任务信息（窄接口，避免把 Task 类型引进 pet 域） */
export interface PetTaskHint {
  id: string
  status: string
  title: string
}

export interface PetBrainDeps {
  store: PetStore
  getPresets: () => ApiPreset[]
  /** 宠物窗（不是主窗）：关闭即停表 */
  getWindow: () => BrowserWindow | null
  getBoardSummary: () => string
  /** 最近看板事件文案（{recent_event} 宏来源；空串 = 尚无事件） */
  getRecentEvent?: () => string
  /** 自主发言出口（推窗 + 落历史由 controller 收口） */
  onSay?: (say: PetSay) => void
}

const LLM_TIMEOUT_MS = 15_000
const FAIL_SILENCE_THRESHOLD = 3
const FAIL_SILENCE_MS = 10 * 60 * 1000
/** 聊天上下文携带的最近消息条数 */
const HISTORY_CONTEXT_MAX = 6
/** 看板事件反应的 LLM 通道最小间隔：批量任务完成时只有第一条走模型，其余降级本地台词 */
const EVENT_REACTION_COOLDOWN_MS = 10_000

/** 实际生效的预设：精确匹配优先；未配置自动用第一个（防「配了预设但桌宠静默走台词库」）；显式 __none__ / 无预设 = 不接 AI */
export function resolveActivePreset(presetId: string, presets: ApiPreset[]): ApiPreset | null {
  if (presetId === PET_PRESET_NONE) return null
  return presets.find((item) => item.id === presetId) ?? presets[0] ?? null
}

/** AI 脑最近一次结果（设置卡片展示：source=none 尚未跑过；fallback 带 lastError 说明原因） */
export interface PetBrainStatus {
  source: 'llm' | 'fallback' | 'none'
  lastError: string
  silenced: boolean
}

/** 人设解析：配置为空回填内置「活泼」模板 */
export function resolvePersona(personaPrompt: string): string {
  const trimmed = personaPrompt.trim()
  return trimmed || DEFAULT_PERSONA_TEMPLATE
}

export function timeOfDay(now = new Date()): string {
  const hour = now.getHours()
  if (hour < 5) return '凌晨'
  if (hour < 11) return '早上'
  if (hour < 14) return '中午'
  if (hour < 18) return '下午'
  return '晚上'
}

/** 宏替换：{board_summary}/{pack_name}/{time_of_day}/{model}/{recent_event}；缺失/空白统一降级为「暂无」 */
export function applyPersonaMacros(template: string, vars: Partial<PersonaMacros>): string {
  return template.replace(/\{(board_summary|pack_name|time_of_day|model|recent_event)\}/g, (_all, key: string) => {
    const value = (vars as Record<string, string | undefined>)[key]
    return value && value.trim() ? value : '暂无'
  })
}

export class PetBrainLoop {
  private timer: NodeJS.Timeout | undefined
  private inFlight = false
  private failCount = 0
  private silentUntil = 0
  private lastSource: PetBrainStatus['source'] = 'none'
  private lastError = ''
  /** 上次事件反应走 LLM 的时间（本地台词不受限） */
  private lastEventReactAt = 0

  status(): PetBrainStatus {
    return { source: this.lastSource, lastError: this.lastError, silenced: this.isSilenced() }
  }

  private record(source: PetBrainStatus['source'], lastError = ''): void {
    this.lastSource = source
    this.lastError = lastError
  }

  constructor(private readonly deps: PetBrainDeps) {}

  /** 配置变化（间隔/预设/人设）后重新读表：外部先 stop 再 start，或直接 restart */
  restart(): void {
    this.stop()
    this.start()
  }

  start(): void {
    if (this.timer) return
    this.scheduleNext()
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  private scheduleNext(): void {
    if (this.timer) return
    const autonomySec = Math.max(PET_AUTONOMY_SEC_MIN, this.deps.store.get().autonomySec)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.tick().finally(() => {
        // 宠物窗开着才续表；窗关了自然停（再 show 时 controller 会 restart）
        if (this.deps.getWindow()) this.scheduleNext()
      })
    }, autonomySec * 1000)
  }

  /** 兜底台词（带好感/心情偏置）：模型不可用时的最终防线 */
  private fallbackSay(): PetSay {
    const config = this.deps.store.get()
    return pickFallbackSay(Math.random, { affection: config.affection, mood: config.mood })
  }

  /** 单次自主发言尝试；返回 null 表示被防重入/静默窗/无窗拦下 */
  async tick(): Promise<PetSay | null> {
    if (this.inFlight) return null
    if (!this.deps.getWindow()) return null
    if (Date.now() < this.silentUntil) return null
    this.inFlight = true
    try {
      const outcome = await this.speakAutonomous()
      this.record(outcome.source, outcome.error ?? '')
      if (outcome.source === 'llm') {
        this.failCount = 0
      } else {
        this.failCount += 1
        if (this.failCount >= FAIL_SILENCE_THRESHOLD) {
          this.silentUntil = Date.now() + FAIL_SILENCE_MS
          this.failCount = 0
        }
      }
      this.deps.onSay?.(outcome.say)
      return outcome.say
    } finally {
      this.inFlight = false
    }
  }

  isSilenced(now = Date.now()): boolean {
    return now < this.silentUntil
  }

  /** 聊天一问一答：历史由 store 收口（user 在调用前、pet 在回复后追加）；回复后顺手驱动记忆摘要 */
  async chat(text: string): Promise<PetSay> {
    this.deps.store.appendChat({ role: 'user', text })
    const config = this.deps.store.get()
    const preset = resolveActivePreset(config.presetId, this.deps.getPresets())
    const fallback = this.fallbackSay()
    if (!preset) {
      this.record('fallback', '没有可用的 API 预设（设置 → API 预设先添加，或在小助理设置选择）')
      this.deps.store.appendChat({ role: 'pet', text: fallback.say })
      return fallback
    }
    // 历史 = 刚追加的 user 之前的部分（最后一条就是本次提问，不再重复携带）
    const history = config.chatHistory.slice(0, -1).slice(-HISTORY_CONTEXT_MAX)
    const messages: PetChatMessage[] = [
      { role: 'system', content: this.systemPrompt() },
      ...history.map((item): PetChatMessage => ({ role: item.role === 'user' ? 'user' : 'assistant', content: item.text })),
      { role: 'user', content: text }
    ]
    let reply = fallback
    try {
      const raw = await chatCompletion(preset, messages, { timeoutMs: LLM_TIMEOUT_MS, model: config.model || undefined })
      const parsed = parsePetSayPayload(raw)
      if (parsed) {
        this.failCount = 0
        this.record('llm')
        reply = parsed
      } else {
        this.record('fallback', '模型回复无法解析为 {"say","action"} 契约')
      }
    } catch (err) {
      this.record('fallback', err instanceof Error ? err.message : String(err))
    }
    this.deps.store.appendChat({ role: 'pet', text: reply.say })
    void this.maybeSummarizeMemory()
    return reply
  }

  /**
   * 看板事件即时反应：任务开始/完成/失败时给一句台词 + 动作。
   * LLM 通道有 10s 节流与忙时降级——批量完成时只有第一条走模型，其余本地台词兜底（事件驱动的 AgentDeck 版）。
   */
  async reactToBoardEvent(task: PetTaskHint, reaction: PetBoardReaction): Promise<PetSay> {
    const local: PetSay = { say: pickPetLine(reaction.lineGroup), action: reaction.action }
    const now = Date.now()
    const preset = resolveActivePreset(this.deps.store.get().presetId, this.deps.getPresets())
    if (this.inFlight || now - this.lastEventReactAt < EVENT_REACTION_COOLDOWN_MS || !preset || !this.deps.getWindow() || now < this.silentUntil) {
      return local
    }
    this.lastEventReactAt = now
    const config = this.deps.store.get()
    try {
      const raw = await chatCompletion(preset, [
        { role: 'system', content: this.systemPrompt() },
        { role: 'user', content: `看板事件：任务「${task.title}」刚刚${reaction.kind === 'start' ? '开始执行' : reaction.kind === 'done' ? '完成了' : '失败了'}。按输出契约给一句此刻的即时反应台词。` }
      ], { timeoutMs: LLM_TIMEOUT_MS, model: config.model || undefined })
      const parsed = parsePetSayPayload(raw)
      if (parsed) {
        this.record('llm')
        return parsed
      }
      this.record('fallback', '事件反应无法解析为 {"say","action"} 契约')
    } catch (err) {
      this.record('fallback', err instanceof Error ? err.message : String(err))
    }
    return local
  }

  /** 每日首次亮窗的时段问候：LLM 优先，失败走分时段本地台词 */
  async greet(): Promise<PetSay> {
    const bucket = timeOfDay()
    const local: PetSay = { say: pickGreetLine(bucket), action: 'happy' }
    const preset = resolveActivePreset(this.deps.store.get().presetId, this.deps.getPresets())
    if (!preset || !this.deps.getWindow() || Date.now() < this.silentUntil) return local
    const config = this.deps.store.get()
    try {
      const raw = await chatCompletion(preset, [
        { role: 'system', content: this.systemPrompt() },
        { role: 'user', content: `今天第一次见面（现在是${bucket}）。按输出契约给一句主动打招呼的台词。` }
      ], { timeoutMs: LLM_TIMEOUT_MS, model: config.model || undefined })
      const parsed = parsePetSayPayload(raw)
      if (parsed) {
        this.record('llm')
        return parsed
      }
      this.record('fallback', '问候语无法解析为 {"say","action"} 契约')
    } catch (err) {
      this.record('fallback', err instanceof Error ? err.message : String(err))
    }
    return local
  }

  /** 聊天溢出消息攒够后 LLM 摘要进长期记忆；无预设/失败/空回复一律静默保留队列 */
  async maybeSummarizeMemory(): Promise<void> {
    const config = this.deps.store.get()
    if (config.memoryQueue.length < PET_MEMORY_QUEUE_TRIGGER) return
    const preset = resolveActivePreset(config.presetId, this.deps.getPresets())
    if (!preset) return
    const queue = config.memoryQueue
    try {
      const raw = await chatCompletion(preset, [
        { role: 'system', content: '你是记忆压缩器，只输出压缩后的记忆文本本身。' },
        { role: 'user', content: buildMemoryPrompt(config.memory, queue) }
      ], { timeoutMs: LLM_TIMEOUT_MS, model: config.model || undefined })
      const summary = [...raw.trim()].slice(0, PET_MEMORY_SUMMARY_CAP).join('')
      if (!summary) return
      this.deps.store.setMemory(mergeMemory(config.memory, summary))
      this.deps.store.drainMemoryQueue(queue.length)
    } catch { /* 摘要失败静默跳过：队列保留（上限内），下次聊天后再试 */ }
  }

  private async speakAutonomous(): Promise<{ source: 'llm' | 'fallback'; say: PetSay; error?: string }> {
    const config = this.deps.store.get()
    const preset = resolveActivePreset(config.presetId, this.deps.getPresets())
    const fallback = this.fallbackSay()
    if (!preset) return { source: 'fallback', say: fallback, error: '没有可用的 API 预设（设置 → API 预设先添加，或在小助理设置选择）' }
    const history = config.chatHistory.slice(-HISTORY_CONTEXT_MAX)
    const messages: PetChatMessage[] = [
      { role: 'system', content: this.systemPrompt() },
      ...history.map((item): PetChatMessage => ({ role: item.role === 'user' ? 'user' : 'assistant', content: item.text })),
      { role: 'user', content: '（自主发言请求）按输出契约给一句此刻的台词。' }
    ]
    try {
      const raw = await chatCompletion(preset, messages, { timeoutMs: LLM_TIMEOUT_MS, model: config.model || undefined })
      const parsed = parsePetSayPayload(raw)
      if (parsed) return { source: 'llm', say: parsed }
    } catch (err) {
      return { source: 'fallback', say: fallback, error: err instanceof Error ? err.message : String(err) }
    }
    return { source: 'fallback', say: fallback, error: '模型回复无法解析为 {"say","action"} 契约' }
  }

  /** system 提示词：人设模板 + 宏替换（含 {recent_event}）+ 长期记忆段（取不到的宏由宏层降级为「暂无」） */
  private systemPrompt(): string {
    const config = this.deps.store.get()
    const preset = resolveActivePreset(config.presetId, this.deps.getPresets())
    return applyPersonaMacros(resolvePersona(config.personaPrompt), {
      board_summary: this.deps.getBoardSummary(),
      pack_name: config.packId,
      time_of_day: timeOfDay(),
      model: config.model || preset?.name || '',
      recent_event: this.deps.getRecentEvent?.() ?? ''
    }) + composeMemorySection(config.memory)
  }
}
