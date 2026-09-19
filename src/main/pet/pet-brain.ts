// 桌宠 AI 脑：自主发言循环 + 一问一答。
// 循环节拍：autonomySec（下限 20s）到期 → 宏替换 system 人设 + 最近历史 → pet-llm（3s 超时）
// → parsePetSayPayload → 成功经 onSay 推宠物窗播放；无预设/超时/解析失败走 pet-lines 兜底。
// 护栏：连续 3 次失败静默 10 分钟；防重入（上轮未完跳过）；宠物窗关闭即停表。
import type { BrowserWindow } from 'electron'
import type { ApiPreset } from '../presets'
import type { PetSayAction } from '../../shared/pet'
import { DEFAULT_PERSONA_TEMPLATE, parsePetSayPayload, pickFallbackSay } from '../../shared/pet-lines'
import { chatCompletion, type PetChatMessage } from './pet-llm'
import { PET_AUTONOMY_SEC_MIN, type PetStore } from './pet-store'

export interface PersonaMacros {
  board_summary: string
  pack_name: string
  time_of_day: string
  model: string
}

export interface PetSay {
  say: string
  action: PetSayAction
}

export interface PetBrainDeps {
  store: PetStore
  getPresets: () => ApiPreset[]
  /** 宠物窗（不是主窗）：关闭即停表 */
  getWindow: () => BrowserWindow | null
  getBoardSummary: () => string
  /** 自主发言出口（推窗 + 落历史由 controller 收口） */
  onSay?: (say: PetSay) => void
}

const LLM_TIMEOUT_MS = 3000
const FAIL_SILENCE_THRESHOLD = 3
const FAIL_SILENCE_MS = 10 * 60 * 1000
/** 聊天上下文携带的最近消息条数 */
const HISTORY_CONTEXT_MAX = 6

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

/** 宏替换：{board_summary}/{pack_name}/{time_of_day}/{model}；缺失/空白统一降级为「暂无」 */
export function applyPersonaMacros(template: string, vars: Partial<PersonaMacros>): string {
  return template.replace(/\{(board_summary|pack_name|time_of_day|model)\}/g, (_all, key: string) => {
    const value = (vars as Record<string, string | undefined>)[key]
    return value && value.trim() ? value : '暂无'
  })
}

export class PetBrainLoop {
  private timer: NodeJS.Timeout | undefined
  private inFlight = false
  private failCount = 0
  private silentUntil = 0

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

  /** 单次自主发言尝试；返回 null 表示被防重入/静默窗/无窗拦下 */
  async tick(): Promise<PetSay | null> {
    if (this.inFlight) return null
    if (!this.deps.getWindow()) return null
    if (Date.now() < this.silentUntil) return null
    this.inFlight = true
    try {
      const outcome = await this.speakAutonomous()
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

  /** 聊天一问一答：历史由 store 收口（user 在调用前、pet 在回复后追加） */
  async chat(text: string): Promise<PetSay> {
    this.deps.store.appendChat({ role: 'user', text })
    const config = this.deps.store.get()
    const preset = this.deps.getPresets().find((item) => item.id === config.presetId)
    const fallback = pickFallbackSay()
    if (!preset) {
      this.deps.store.appendChat({ role: 'pet', text: fallback.say })
      return fallback
    }
    // 历史 = 刚追加的 user 之前的部分（最后一条就是本次提问，不再重复携带）
    const history = config.chatHistory.slice(0, -1).slice(-HISTORY_CONTEXT_MAX)
    const messages: PetChatMessage[] = [
      { role: 'system', content: this.systemPrompt(config.packId, config.personaPrompt, config.model, preset) },
      ...history.map((item): PetChatMessage => ({ role: item.role === 'user' ? 'user' : 'assistant', content: item.text })),
      { role: 'user', content: text }
    ]
    try {
      const raw = await chatCompletion(preset, messages, { timeoutMs: LLM_TIMEOUT_MS, model: config.model || undefined })
      const parsed = parsePetSayPayload(raw)
      if (parsed) {
        this.failCount = 0
        this.deps.store.appendChat({ role: 'pet', text: parsed.say })
        return parsed
      }
    } catch { /* 超时/网络/HTTP 错 → 兜底 */ }
    this.deps.store.appendChat({ role: 'pet', text: fallback.say })
    return fallback
  }

  private async speakAutonomous(): Promise<{ source: 'llm' | 'fallback'; say: PetSay }> {
    const config = this.deps.store.get()
    const preset = this.deps.getPresets().find((item) => item.id === config.presetId)
    const fallback = pickFallbackSay()
    if (!preset) return { source: 'fallback', say: fallback }
    const history = config.chatHistory.slice(-HISTORY_CONTEXT_MAX)
    const messages: PetChatMessage[] = [
      { role: 'system', content: this.systemPrompt(config.packId, config.personaPrompt, config.model, preset) },
      ...history.map((item): PetChatMessage => ({ role: item.role === 'user' ? 'user' : 'assistant', content: item.text })),
      { role: 'user', content: '（自主发言请求）按输出契约给一句此刻的台词。' }
    ]
    try {
      const raw = await chatCompletion(preset, messages, { timeoutMs: LLM_TIMEOUT_MS, model: config.model || undefined })
      const parsed = parsePetSayPayload(raw)
      if (parsed) return { source: 'llm', say: parsed }
    } catch { /* 超时/网络错 → 兜底 */ }
    return { source: 'fallback', say: fallback }
  }

  /** system 提示词：人设模板 + 宏替换（看板摘要取不到时由宏层降级为「暂无」） */
  private systemPrompt(packId: string, personaPrompt: string, model: string, preset: ApiPreset): string {
    return applyPersonaMacros(resolvePersona(personaPrompt), {
      board_summary: this.deps.getBoardSummary(),
      pack_name: packId,
      time_of_day: timeOfDay(),
      model: model || preset.name
    })
  }
}
