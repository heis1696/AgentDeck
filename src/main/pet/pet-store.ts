// 桌宠配置存储：userData/pet.json，tmp+rename 原子写（照 automation-store 惯例）。
// apiKey 永不落在这里——presetId 只存引用，密钥仍在 api-presets.json。
import fs from 'node:fs'
import path from 'node:path'
import type { PetChatMessage } from '../../shared/pet'

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
  /** 上次窗位置（恢复用；clamp 在工作区里进行） */
  bounds: { x: number; y: number }
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
    bounds: { x: 0, y: 0 }
  }
}

function isChatMessage(value: unknown): value is PetChatMessage {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<PetChatMessage>
  return (item.role === 'user' || item.role === 'pet') && typeof item.text === 'string' && typeof item.at === 'number'
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
    bounds: raw.bounds && typeof raw.bounds === 'object' && Number.isFinite((raw.bounds as PetConfig['bounds']).x) && Number.isFinite((raw.bounds as PetConfig['bounds']).y)
      ? { x: (raw.bounds as PetConfig['bounds']).x, y: (raw.bounds as PetConfig['bounds']).y }
      : base.bounds
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
    return { ...this.config, chatHistory: [...this.config.chatHistory], bounds: { ...this.config.bounds } }
  }
  patch(partial: Partial<PetConfig>): PetConfig {
    this.config = normalizeConfig({ ...this.config, ...partial })
    this.save()
    return this.get()
  }
  setEnabled(enabled: boolean) { return this.patch({ enabled }) }
  setPack(packId: string) { return this.patch({ packId }) }
  setPersona(personaPrompt: string) { return this.patch({ personaPrompt }) }
  setAutonomy(autonomySec: number) { return this.patch({ autonomySec: Math.max(PET_AUTONOMY_SEC_MIN, Math.round(autonomySec)) }) }
  setPreset(presetId: string, model?: string) { return this.patch({ presetId, ...(model !== undefined ? { model } : {}) }) }
  setBounds(bounds: { x: number; y: number }) { return this.patch({ bounds }) }
  /** 追加一条聊天并环形截断到上限；返回截断后的历史 */
  appendChat(message: Omit<PetChatMessage, 'at'> & { at?: number }): PetChatMessage[] {
    const entry: PetChatMessage = { role: message.role, text: message.text.slice(0, 500), at: message.at ?? Date.now() }
    this.config.chatHistory = [...this.config.chatHistory, entry].slice(-PET_CHAT_HISTORY_CAP)
    this.save()
    return [...this.config.chatHistory]
  }
  clearChat() { return this.patch({ chatHistory: [] }) }
}
