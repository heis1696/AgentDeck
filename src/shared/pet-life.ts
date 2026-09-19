// 桌宠养成纯逻辑：好感/心情公式、看板事件→反应映射、长期记忆拼接、行为权重偏置。
// 零依赖（只 import shared/pet 的类型），主进程与渲染层共用，smoke 直连即公共 API。
import type { PetLineGroup } from './pet-lines'
import type { PetManifest, PetSayAction } from './pet'

// —— 数值域：好感/心情均为 0-100 的整数 ——
export const PET_AFFECTION_MAX = 100
export const PET_MOOD_MAX = 100

/** 好感等级（阈值下闭上开）；等级影响行为权重与台词倾向 */
export const PET_AFFECTION_TIERS: ReadonlyArray<{ min: number; label: string }> = [
  { min: 80, label: '挚友' },
  { min: 60, label: '亲近' },
  { min: 40, label: '熟悉' },
  { min: 20, label: '点头之交' },
  { min: 0, label: '陌生' }
]

export function affectionTier(affection: number): string {
  return (PET_AFFECTION_TIERS.find((tier) => affection >= tier.min) ?? PET_AFFECTION_TIERS[PET_AFFECTION_TIERS.length - 1]).label
}

export function moodLabel(mood: number): string {
  if (mood >= 70) return '开心'
  if (mood >= 30) return '平静'
  return '低落'
}

export function clampStat(value: number): number {
  return Math.max(0, Math.min(PET_AFFECTION_MAX, Math.round(value)))
}

/** 加好感/心情（好感只按日缓慢衰减，交互永不扣好感；心情可正可负） */
export function addAffection(affection: number, delta: number): number {
  return clampStat(affection + delta)
}

export function addMood(mood: number, delta: number): number {
  return clampStat(mood + delta)
}

/** 按自然日衰减好感：每满 1 天 -2，地板 0（VPet/DyberPet 的数值衰减思路，弱化到不惩罚轻度闲置） */
export const PET_AFFECTION_DAILY_DECAY = 2

export function decayAffection(affection: number, lastActiveAt: number, now: number): number {
  if (!(lastActiveAt > 0) || now <= lastActiveAt) return affection
  const days = Math.floor((now - lastActiveAt) / 86_400_000)
  if (days <= 0) return affection
  return clampStat(affection - days * PET_AFFECTION_DAILY_DECAY)
}

// —— 交互 → 数值增量（单击/抛掷由渲染层上报；聊天在 brain 落历史时累积） ——
export type PetInteractionDelta = { affection: number; mood: number }

export const PET_INTERACTION_DELTAS: Record<'click' | 'throw' | 'chat', PetInteractionDelta> = {
  click: { affection: 1, mood: 2 },
  throw: { affection: 0, mood: -3 }, // 抛它好玩，但它会委屈（只扣心情不扣好感）
  chat: { affection: 2, mood: 4 }
}

export function interactionEffect(kind: 'click' | 'throw' | 'chat'): PetInteractionDelta {
  return PET_INTERACTION_DELTAS[kind] ?? { affection: 0, mood: 0 }
}

// —— 投喂：好感 +4 / 心情 +8；每日前 5 次全额，之后只长心情不长好感（吃撑了） ——
export const FEED_AFFECTION_DELTA = 4
export const FEED_MOOD_DELTA = 8
export const PET_FEED_DAILY_FULL = 5

export function feedEffect(fedToday: number): PetInteractionDelta & { full: boolean } {
  const full = fedToday >= PET_FEED_DAILY_FULL
  return { affection: full ? 0 : FEED_AFFECTION_DELTA, mood: full ? Math.round(FEED_MOOD_DELTA / 2) : FEED_MOOD_DELTA, full }
}

// —— 看板事件 → 桌宠反应（AgentDeck 特色：任务流直连桌宠表现） ——
export type PetBoardEventKind = 'start' | 'done' | 'failed'

export interface PetBoardReaction {
  kind: PetBoardEventKind
  affection: number
  mood: number
  /** 台词兜底组（LLM 不可用时从该组取） */
  lineGroup: PetLineGroup
  /** 即时反应动画（走 PetSayAction 五值，与台词契约同枚举） */
  action: PetSayAction
}

export const PET_BOARD_REACTIONS: Record<PetBoardEventKind, PetBoardReaction> = {
  start: { kind: 'start', affection: 0, mood: 2, lineGroup: 'event_start', action: 'think' },
  done: { kind: 'done', affection: 3, mood: 10, lineGroup: 'event_done', action: 'happy' },
  failed: { kind: 'failed', affection: 0, mood: -6, lineGroup: 'event_failed', action: 'think' }
}

/** 任务状态迁移 → 反应映射；非以下迁移返回 null（不反应：排队/取消/状态重复上报） */
export function boardReactionFor(prev: string | undefined, next: string): PetBoardReaction | null {
  if (prev === next) return null
  if (next === 'running') return PET_BOARD_REACTIONS.start
  if (next === 'done' && (prev === 'running' || prev === 'queued' || prev === undefined)) return PET_BOARD_REACTIONS.done
  if (next === 'failed' && prev !== 'failed') return PET_BOARD_REACTIONS.failed
  return null
}

// —— 长期记忆：溢出聊天 → 摘要拼接（airi 上下文快照思路的简化版） ——
/** 未摘要消息攒够这个条数才触发一次 LLM 摘要（省请求） */
export const PET_MEMORY_QUEUE_TRIGGER = 4
/** 记忆文本上限（字符，按码点）：超过丢弃最旧的段 */
export const PET_MEMORY_CAP = 800
/** 单次摘要的输出上限（提示词约束 + 硬截断） */
export const PET_MEMORY_SUMMARY_CAP = 300

/** 摘要请求的 user 提示词：拼已有记忆 + 待摘要对话（纯函数，smoke 断言形状） */
export function buildMemoryPrompt(existing: string, dropped: ReadonlyArray<{ role: string; text: string }>): string {
  const transcript = dropped.map((item) => `${item.role === 'user' ? '主人' : '团子'}：${item.text}`).join('\n')
  return [
    existing ? `已有的长期记忆：\n${existing}\n` : '',
    `以下是更新的对话片段，把它们压缩成一段不超过 ${PET_MEMORY_SUMMARY_CAP} 字的第三人称记忆，`,
    '只保留事实与约定（主人的偏好、项目名、称呼、承诺过的事），丢弃寒暄。',
    '直接输出记忆文本，不要解释、不要标题、不要引号。\n\n',
    transcript
  ].join('\n')
}

/** 记忆入库拼接：新段在前，总长按码点截到 PET_MEMORY_CAP（新记忆比旧记忆重要） */
export function mergeMemory(existing: string, summary: string): string {
  const clean = summary.trim().replace(/\s+/g, ' ')
  if (!clean) return existing
  const merged = existing.trim() ? `${clean}\n${existing.trim()}` : clean
  return [...merged].slice(0, PET_MEMORY_CAP).join('')
}

/** 长期记忆注入 system 提示词的段落（空记忆返回空串，不产生空标题） */
export function composeMemorySection(memory: string): string {
  const clean = memory.trim()
  return clean ? `\n\n关于主人的长期记忆（团子自己记下的事，自然引用即可，不要逐条复述）：\n${clean}` : ''
}

// —— 行为权重偏置：好感/心情调制 pet.json 的 next 权重（不改素材包文件本身） ——
export interface PetLifeVars {
  affection: number
  mood: number
}

/** 心情低落更想睡、心情好更爱开心跳、挚友更黏人（多走动）；全部乘法调制，权重 0 项保持 0 */
export function tuneTransitions(manifest: PetManifest, vars: PetLifeVars): PetManifest {
  const moodSleep = vars.mood <= 30 ? 3 : 1
  const moodHappy = vars.mood >= 70 ? 2 : 1
  const affectionWalk = vars.affection >= 80 ? 1.5 : 1
  const scale = (weight: number, to: string): number => {
    const factor = to === 'sleep' ? moodSleep : to === 'happy' ? moodHappy : to === 'walk' ? affectionWalk : 1
    return Math.max(1, Math.round(weight * factor))
  }
  const states = Object.fromEntries(
    Object.entries(manifest.states).map(([id, def]) => [
      id,
      def.next.length ? { ...def, next: def.next.map((item) => ({ ...item, weight: scale(item.weight, item.to) })) } : def
    ])
  ) as PetManifest['states']
  return { ...manifest, states }
}

/** 兜底台词的动作权重偏置：低心情偏睡、高好感偏撒娇（可选参数，缺省回到 idle70/walk20/sleep10 基线） */
export function fallbackActionWeights(vars?: Partial<PetLifeVars>): Array<{ action: PetSayAction; weight: number }> {
  if (!vars || (vars.mood === undefined && vars.affection === undefined)) {
    return [
      { action: 'idle', weight: 70 },
      { action: 'walk', weight: 20 },
      { action: 'sleep', weight: 10 }
    ]
  }
  const low = (vars.mood ?? 50) <= 30
  const close = (vars.affection ?? 0) >= 60
  if (low) {
    return [
      { action: 'idle', weight: 40 },
      { action: 'walk', weight: 10 },
      { action: 'sleep', weight: 40 },
      { action: 'think', weight: 10 }
    ]
  }
  if (close) {
    return [
      { action: 'idle', weight: 45 },
      { action: 'walk', weight: 20 },
      { action: 'sleep', weight: 10 },
      { action: 'happy', weight: 25 }
    ]
  }
  return [
    { action: 'idle', weight: 70 },
    { action: 'walk', weight: 20 },
    { action: 'sleep', weight: 10 }
  ]
}

// —— 时间感知：自然日 key 与「今天第一次见面」判定 ——
/** 本地时区的 YYYY-MM-DD（问候每日一次的持久化 key） */
export function todayKey(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = `${now.getMonth() + 1}`.padStart(2, '0')
  const d = `${now.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function firstSeenToday(greetedDate: string, now: Date = new Date()): boolean {
  return greetedDate !== todayKey(now)
}
