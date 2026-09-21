// 桌宠配置存储：userData/pet.json，tmp+rename 原子写（照 automation-store 惯例）。
// apiKey 永不落在这里——presetId 只存引用，密钥仍在 api-presets.json。
// D 期起兼存养成数值（好感/心情）、长期记忆与问候日期；数值公式在 shared/pet-life。
import fs from 'node:fs'
import path from 'node:path'
import type { PetChatMessage, PetHostSwitches } from '../../shared/pet'
import { normalizePetHostSwitches, normalizePetZoom } from '../../shared/pet'

export interface PetConfig {
  enabled: boolean
  packId: string
  /** 人设提示词；空串 = 使用内置「活泼」预设（pet-brain 解析时回填） */
  personaPrompt: string
  /** 自主发言间隔秒数（下限 20，写入时钳制） */
  autonomySec: number
  presetId: string
  /** OpenAI 兼容协议必需的模型名；空 = 让网关用默认模型（anthropic 协议必须有） */
  model: string
  chatHistory: PetChatMessage[]
  /** 上次窗位置（恢复用；clamp 在工作区里进行）；null = 从未拖放过，亮窗走默认右下位 */
  bounds: { x: number; y: number } | null
  /** 好感（0-100）：交互累积、按自然日衰减，公式在 shared/pet-life */
  affection: number
  /** 心情（0-100）：事件驱动涨落 */
  mood: number
  /** 最近一次交互时间戳（好感按日衰减的基准）；0 = 从未交互 */
  lastInteractAt: number
  /** 今日投喂次数的归属日期（YYYY-MM-DD）；换日即清零 */
  fedDate: string
  fedCount: number
  /** 长期记忆（溢出聊天的 LLM 摘要，注入 persona 上下文；≤800 字） */
  memory: string
  /** 待摘要的溢出消息队列（攒够才调一次 LLM；失败回队静默重试） */
  memoryQueue: PetChatMessage[]
  /** 最近一次打招呼的自然日（YYYY-MM-DD）；不同天才再次问候 */
  greetedDate: string
  /** 缩放档（1/1.5/2）：窗体与精灵同缩放 */
  zoom: number
  /** 契约事件开关位（PetHostContract）：默认全开，关 = host 边界丢弃事件 */
  hostSwitches: PetHostSwitches
}

export const PET_CHAT_HISTORY_CAP = 20
export const PET_AUTONOMY_SEC_MIN = 20

export function defaultPetConfig(): PetConfig {
  return {
    enabled: false,
    packId: 'default',
    personaPrompt: '',
    autonomySec: 90,
    presetId: '',
    model: '',
    chatHistory: [],
    bounds: null,
    affection: 0,
    mood: 50,
    lastInteractAt: 0,
    fedDate: '',
    fedCount: 0,
    memory: '',
    memoryQueue: [],
    greetedDate: '',
    zoom: 1,
    hostSwitches: normalizePetHostSwitches(undefined)
  }
}

function isChatMessage(value: unknown): value is PetChatMessage {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<PetChatMessage>
  return (item.role === 'user' || item.role === 'pet') && typeof item.text === 'string' && typeof item.at === 'number'
}

/** (0,0) 视为未设置：真实位置总被 clamp 进工作区（Windows 工作区原点 ≥ 8,8），精确 (0,0) 只可能来自 hot.21 首次开开关时落盘的旧默认值 */
function normalizeBounds(value: unknown): PetConfig['bounds'] {
  if (!value || typeof value !== 'object') return null
  const raw = value as { x?: unknown; y?: unknown }
  if (!Number.isFinite(raw.x) || !Number.isFinite(raw.y)) return null
  const x = raw.x as number
  const y = raw.y as number
  return x === 0 && y === 0 ? null : { x, y }
}

function normalizeConfig(value: unknown): PetConfig {
  const base = defaultPetConfig()
  if (!value || typeof value !== 'object') return base
  const raw = value as Partial<PetConfig>
  return {
    enabled: raw.enabled === true,
    packId: typeof raw.packId === 'string' && raw.packId.trim() ? raw.packId.trim() : base.packId,
    personaPrompt: typeof raw.personaPrompt === 'string' ? raw.personaPrompt : base.personaPrompt,
    autonomySec: Number.isFinite(raw.autonomySec) ? Math.max(PET_AUTONOMY_SEC_MIN, Math.round(raw.autonomySec as number)) : base.autonomySec,
    presetId: typeof raw.presetId === 'string' ? raw.presetId : base.presetId,
    model: typeof raw.model === 'string' ? raw.model : base.model,
    chatHistory: Array.isArray(raw.chatHistory) ? raw.chatHistory.filter(isChatMessage).slice(-PET_CHAT_HISTORY_CAP) : base.chatHistory,
    bounds: normalizeBounds(raw.bounds),
    affection: Number.isFinite(raw.affection) ? Math.max(0, Math.min(100, Math.round(raw.affection as number))) : base.affection,
    mood: Number.isFinite(raw.mood) ? Math.max(0, Math.min(100, Math.round(raw.mood as number))) : base.mood,
    lastInteractAt: Number.isFinite(raw.lastInteractAt) && (raw.lastInteractAt as number) > 0 ? (raw.lastInteractAt as number) : base.lastInteractAt,
    fedDate: typeof raw.fedDate === 'string' ? raw.fedDate : base.fedDate,
    fedCount: Number.isFinite(raw.fedCount) && (raw.fedCount as number) > 0 ? Math.floor(raw.fedCount as number) : base.fedCount,
    memory: typeof raw.memory === 'string' ? raw.memory : base.memory,
    memoryQueue: Array.isArray(raw.memoryQueue) ? raw.memoryQueue.filter(isChatMessage) : base.memoryQueue,
    greetedDate: typeof raw.greetedDate === 'string' ? raw.greetedDate : base.greetedDate,
    zoom: normalizePetZoom(raw.zoom),
    hostSwitches: normalizePetHostSwitches(raw.hostSwitches)
  }
}

export class PetStore {
  private readonly file: string
  private config: PetConfig
  constructor(userDataDir: string) {
    this.file = path.join(userDataDir, 'pet.json')
    this.config = defaultPetConfig()
    try {
      this.config = normalizeConfig(JSON.parse(fs.readFileSync(this.file, 'utf8')))
    } catch { /* first launch / corrupt → defaults */ }
  }
  private save() {
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.config, null, 2))
    fs.renameSync(tmp, this.file)
  }
  get(): PetConfig {
    return {
      ...this.config,
      chatHistory: [...this.config.chatHistory],
      memoryQueue: [...this.config.memoryQueue],
      bounds: this.config.bounds ? { ...this.config.bounds } : null,
      hostSwitches: { ...this.config.hostSwitches }
    }
  }
  patch(partial: Partial<PetConfig>): PetConfig {
    this.config = normalizeConfig({ ...this.config, ...partial })
    this.save()
    return this.get()
  }
  /** 内存态合并（不落盘）：高频交互走 bump 累积，flush 时一次写盘 */
  mergeInMemory(partial: Partial<PetConfig>): PetConfig {
    this.config = normalizeConfig({ ...this.config, ...partial })
    return this.get()
  }
  flush(): void {
    this.save()
  }
  setEnabled(enabled: boolean) { return this.patch({ enabled }) }
  setPack(packId: string) { return this.patch({ packId }) }
  setPersona(personaPrompt: string) { return this.patch({ personaPrompt }) }
  setAutonomy(autonomySec: number) { return this.patch({ autonomySec: Math.max(PET_AUTONOMY_SEC_MIN, Math.round(autonomySec)) }) }
  setPreset(presetId: string, model?: string) { return this.patch({ presetId, ...(model !== undefined ? { model } : {}) }) }
  setBounds(bounds: { x: number; y: number }) { return this.patch({ bounds }) }
  setZoom(zoom: number) { return this.patch({ zoom: normalizePetZoom(zoom) }) }
  /** 养成数值写入（交互/事件/喂食共用）：clamp 在 normalizeConfig 里完成 */
  setLife(life: { affection: number; mood: number; lastInteractAt: number; fedDate?: string; fedCount?: number }) {
    return this.patch(life)
  }
  setGreeted(date: string) { return this.patch({ greetedDate: date }) }
  setMemory(memory: string) { return this.patch({ memory }) }
  /** 契约事件开关位写入（阶段 2 开关 UI 接这里；非法位归一为默认开） */
  setHostSwitches(hostSwitches: PetHostSwitches) { return this.patch({ hostSwitches: normalizePetHostSwitches(hostSwitches) }) }
  /** 追加一条聊天并环形截断到上限；返回截断后的历史。滚出窗口的溢出消息进 memoryQueue（攒够触发摘要） */
  appendChat(message: Omit<PetChatMessage, 'at'> & { at?: number }): PetChatMessage[] {
    const entry: PetChatMessage = { role: message.role, text: message.text.slice(0, 500), at: message.at ?? Date.now() }
    const merged = [...this.config.chatHistory, entry]
    const overflow = merged.length > PET_CHAT_HISTORY_CAP ? merged.slice(0, merged.length - PET_CHAT_HISTORY_CAP) : []
    this.config.chatHistory = merged.slice(-PET_CHAT_HISTORY_CAP)
    if (overflow.length) {
      // 队列上限 20 条：摘要一直失败的极端情况下防无限膨胀（最旧的放弃）
      this.config.memoryQueue = [...this.config.memoryQueue, ...overflow].slice(-PET_CHAT_HISTORY_CAP)
    }
    this.save()
    return [...this.config.chatHistory]
  }
  /** 摘要成功后取走队列前 count 条（摘要期间新入队的消息保留到下一轮） */
  drainMemoryQueue(count?: number): PetChatMessage[] {
    const take = Math.max(0, Math.min(count ?? this.config.memoryQueue.length, this.config.memoryQueue.length))
    if (!take) return []
    const drained = this.config.memoryQueue.slice(0, take)
    this.config.memoryQueue = this.config.memoryQueue.slice(take)
    this.save()
    return drained
  }
  clearChat() { return this.patch({ chatHistory: [] }) }
}
