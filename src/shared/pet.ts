// 桌宠共享契约与纯函数：manifest 校验、行为状态机（stepBrain）、一帧推进（advancePet）。
// 主进程与渲染层共用，禁止 import electron / node API——smoke 直连打包即公共 API。

export type PetStateId = 'idle' | 'walk' | 'fall' | 'dragged' | 'sleep' | 'happy' | 'think'
export const PET_STATE_IDS: readonly PetStateId[] = ['idle', 'walk', 'fall', 'dragged', 'sleep', 'happy', 'think']

/** 状态转移项：weight 参与加权随机（land / afterSec 到期 / 非循环动画播完共用） */
export interface PetTransition {
  to: PetStateId
  weight: number
}

export interface PetStateDef {
  frames: string[]
  fps: number
  loop: boolean
  /** 时间到/播完后的加权出口；dragged/fall 的出口只认事件（throw/land），留空数组 */
  next: PetTransition[]
  /** loop 态自主转移秒数（tick 到期走加权 next）；非 loop 态由动画播完驱动，可省略 */
  afterSec?: number
}

/** 素材包清单（pet.json 的稳定 schema，字段名不得偏离——用户文档按此契约撰写） */
export interface PetManifest {
  frameSize: [number, number]
  states: Record<PetStateId, PetStateDef>
  movement: {
    walkSpeedPx: number
    gravity: number
    edgeBehavior: 'turn'
  }
  /** 气泡锚点相对精灵左上角的窗口像素偏移（y 负值 = 向上） */
  bubble: { offset: [number, number] }
}

/** 校验 manifest：全字段强约束，任一不合法返回 null（坏素材包跳过的依据） */
export function validatePetManifest(value: unknown): PetManifest | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<PetManifest>
  const frameSize = raw.frameSize
  if (!Array.isArray(frameSize) || frameSize.length !== 2 || frameSize.some((n) => !Number.isFinite(n) || n <= 0)) return null
  if (!raw.states || typeof raw.states !== 'object') return null
  const states = {} as Record<PetStateId, PetStateDef>
  for (const id of PET_STATE_IDS) {
    const def = (raw.states as Record<string, Partial<PetStateDef>>)[id]
    if (!def || typeof def !== 'object') return null
    if (!Array.isArray(def.frames) || def.frames.length === 0 || def.frames.some((f) => typeof f !== 'string' || !f.trim())) return null
    if (!Number.isFinite(def.fps) || (def.fps as number) <= 0) return null
    if (typeof def.loop !== 'boolean') return null
    if (!Array.isArray(def.next)) return null
    const next: PetTransition[] = []
    for (const item of def.next) {
      if (!item || typeof item !== 'object') return null
      if (!PET_STATE_IDS.includes((item as PetTransition).to)) return null
      if (!Number.isFinite((item as PetTransition).weight) || (item as PetTransition).weight <= 0) return null
      next.push({ to: (item as PetTransition).to, weight: (item as PetTransition).weight })
    }
    const stateDef: PetStateDef = { frames: [...def.frames], fps: def.fps as number, loop: def.loop, next }
    if (def.afterSec !== undefined) {
      if (!Number.isFinite(def.afterSec) || (def.afterSec as number) <= 0) return null
      stateDef.afterSec = def.afterSec
    }
    states[id] = stateDef
  }
  const movement = raw.movement
  if (!movement || typeof movement !== 'object') return null
  if (!Number.isFinite(movement.walkSpeedPx) || (movement.walkSpeedPx as number) <= 0) return null
  if (!Number.isFinite(movement.gravity) || (movement.gravity as number) <= 0) return null
  if (movement.edgeBehavior !== 'turn') return null
  const bubble = raw.bubble
  if (!bubble || typeof bubble !== 'object' || !Array.isArray(bubble.offset) || bubble.offset.length !== 2 || bubble.offset.some((n) => !Number.isFinite(n))) return null
  return {
    frameSize: [frameSize[0], frameSize[1]],
    states,
    movement: { walkSpeedPx: movement.walkSpeedPx as number, gravity: movement.gravity as number, edgeBehavior: 'turn' },
    bubble: { offset: [bubble.offset[0], bubble.offset[1]] }
  }
}

// —— 透明窗体布局常量：渲染层绘制与主进程鼠标命中必须共用同一份数值 ——
/** 桌宠透明窗尺寸（px） */
export const PET_WINDOW_SIZE = { width: 220, height: 220 }
/** 精灵显示倍率与底部留白：精灵显示尺寸 = frameSize * scale，贴窗底居中 */
export const PET_SPRITE_SCALE = 2
export const PET_SPRITE_BOTTOM_PAD = 10

/** 精灵在窗体内的显示矩形（鼠标命中区的基础，主进程按此 + 8px 余量判定穿透） */
export function petSpriteRect(windowWidth = PET_WINDOW_SIZE.width, windowHeight = PET_WINDOW_SIZE.height): { left: number; top: number; width: number; height: number } {
  const width = 64 * PET_SPRITE_SCALE
  const height = 64 * PET_SPRITE_SCALE
  return { left: Math.round((windowWidth - width) / 2), top: windowHeight - PET_SPRITE_BOTTOM_PAD - height, width, height }
}

// —— 行为状态机（纯函数）——

export interface PetBrain {
  state: PetStateId
  /** 当前帧下标（非 loop 态钳在最后一帧） */
  frame: number
  /** 帧内计时（秒），与 fps 共同驱动翻帧 */
  frameTime: number
  /** 本状态累计时长（秒），afterSec 到期判断用 */
  stateTime: number
  /** 非 loop 动画已播完（转移只触发一次的闸） */
  finished: boolean
}

/** 精灵世界坐标 = 透明窗左上角的屏幕坐标；速度 px/s */
export interface PetPhysics {
  x: number
  y: number
  vx: number
  vy: number
  facing: 1 | -1
}

/** 运动边界（屏幕工作区换算后的窗坐标范围）：floorY = 落底 y */
export interface PetBounds {
  minX: number
  maxX: number
  floorY: number
}

export type PetEventName = 'click' | 'doubleClick' | 'dragStart' | 'throw' | 'land' | 'wake' | 'tick'

export function createPetBrain(state: PetStateId = 'idle'): PetBrain {
  return { state, frame: 0, frameTime: 0, stateTime: 0, finished: false }
}

export function createPetPhysics(x: number, y: number): PetPhysics {
  return { x, y, vx: 0, vy: 0, facing: 1 }
}

/** 加权随机：rand 注入便于 smoke 断言分布；权重和为 0 时回退最后一项 */
export function weightedPick<T extends { weight: number }>(items: T[], rand: () => number = Math.random): T {
  const total = items.reduce((sum, item) => sum + item.weight, 0)
  if (total <= 0) return items[items.length - 1]
  let cursor = rand() * total
  for (const item of items) {
    cursor -= item.weight
    if (cursor < 0) return item
  }
  return items[items.length - 1]
}

function toNext(brain: PetBrain, manifest: PetManifest, rand: () => number): PetBrain {
  const exits = manifest.states[brain.state].next
  if (!exits.length) return brain
  const target = weightedPick(exits, rand).to
  return { state: target, frame: 0, frameTime: 0, stateTime: 0, finished: false }
}

/**
 * 离散事件转移。约定：
 * - fall 只认 land（click/doubleClick/tick 一律忽略）；dragged 只认 throw/land 前的 dragStart 进入。
 * - click 在 sleep 里等价 wake（睡着的团子被摸醒，不蹦迪）。
 */
export function stepBrain(brain: PetBrain, manifest: PetManifest, event: PetEventName, rand: () => number = Math.random): PetBrain {
  const { state } = brain
  switch (event) {
    case 'click':
      if (state === 'fall' || state === 'dragged') return brain
      if (state === 'sleep') return { state: 'idle', frame: 0, frameTime: 0, stateTime: 0, finished: false }
      return { state: 'happy', frame: 0, frameTime: 0, stateTime: 0, finished: false }
    case 'doubleClick':
      if (state === 'fall' || state === 'dragged') return brain
      return { state: 'think', frame: 0, frameTime: 0, stateTime: 0, finished: false }
    case 'dragStart':
      if (state === 'fall') return brain
      return { state: 'dragged', frame: 0, frameTime: 0, stateTime: 0, finished: false }
    case 'throw':
      if (state !== 'dragged') return brain
      return { state: 'fall', frame: 0, frameTime: 0, stateTime: 0, finished: false }
    case 'land':
      if (state !== 'fall') return brain
      return toNext(brain, manifest, rand)
    case 'wake':
      if (state !== 'sleep') return brain
      return { state: 'idle', frame: 0, frameTime: 0, stateTime: 0, finished: false }
    case 'tick':
      return brain // tick 的自主转移由 advancePet 按 afterSec 驱动（需要 stateTime）
  }
}

export interface PetAdvanceResult {
  brain: PetBrain
  physics: PetPhysics
  /** 本帧窗坐标有位移（渲染层据此决定是否通知主进程移动窗体） */
  moved: boolean
}

/**
 * 一帧推进：翻帧（非 loop 钳末帧 + 播完一次性转移）、afterSec 到期自主转移、
 * 行走/重力/抛掷水平滑行/落底转下一步、屏幕边界折返。dt 为秒（钳到 0.1 防大跳）。
 */
export function advancePet(brain: PetBrain, physics: PetPhysics, manifest: PetManifest, dt: number, bounds: PetBounds, rand: () => number = Math.random): PetAdvanceResult {
  const step = Math.min(Math.max(dt, 0), 0.1)
  let nextBrain: PetBrain = { ...brain, stateTime: brain.stateTime + step }
  let nextPhysics: PetPhysics = { ...physics }
  let moved = false
  const def = manifest.states[nextBrain.state]

  // 翻帧：非 loop 态钳在末帧，播完触发一次性加权转移
  const frameDur = 1 / def.fps
  nextBrain.frameTime += step
  while (nextBrain.frameTime >= frameDur) {
    nextBrain.frameTime -= frameDur
    if (nextBrain.frame + 1 <= def.frames.length - 1) {
      nextBrain.frame += 1
    } else if (def.loop) {
      nextBrain.frame = 0
    } else {
      nextBrain.frame = def.frames.length - 1
      nextBrain.frameTime = 0
      if (!nextBrain.finished) {
        nextBrain.finished = true
        const afterFinish = toNext(nextBrain, manifest, rand)
        if (afterFinish !== nextBrain) nextBrain = afterFinish
      }
      break
    }
  }

  // afterSec 到期：loop 态自主转移（fall 只认 land；dragged 只认 throw）
  const current = manifest.states[nextBrain.state]
  if (current.loop && current.afterSec !== undefined && current.next.length > 0 && nextBrain.stateTime >= current.afterSec) {
    nextBrain = toNext(nextBrain, manifest, rand)
  }

  // 物理：dragged 由主进程拖窗跟随，这里不动；fall 走重力 + 水平滑行；walk 走地面步进
  if (nextBrain.state === 'walk') {
    const before = nextPhysics.x
    nextPhysics.x += nextPhysics.facing * manifest.movement.walkSpeedPx * step
    if (nextPhysics.x <= bounds.minX) {
      nextPhysics.x = bounds.minX
      nextPhysics.facing = 1
    } else if (nextPhysics.x >= bounds.maxX) {
      nextPhysics.x = bounds.maxX
      nextPhysics.facing = -1
    }
    moved = nextPhysics.x !== before
  } else if (nextBrain.state === 'fall') {
    const before = { x: nextPhysics.x, y: nextPhysics.y }
    nextPhysics.vy = Math.min(nextPhysics.vy + manifest.movement.gravity * step, 4000)
    nextPhysics.y += nextPhysics.vy * step
    nextPhysics.x += nextPhysics.vx * step
    // 侧壁折返：翻转水平速度（保留 60% 动量，避免贴墙抖动）
    if (nextPhysics.x <= bounds.minX) {
      nextPhysics.x = bounds.minX
      nextPhysics.vx = Math.abs(nextPhysics.vx) * 0.6
    } else if (nextPhysics.x >= bounds.maxX) {
      nextPhysics.x = bounds.maxX
      nextPhysics.vx = -Math.abs(nextPhysics.vx) * 0.6
    }
    // 落底：位置钉死 + land 转移（walk/idle 加权）
    if (nextPhysics.y >= bounds.floorY) {
      nextPhysics.y = bounds.floorY
      nextPhysics.vy = 0
      nextPhysics.vx = 0
      nextBrain = stepBrain(nextBrain, manifest, 'land', rand)
    }
    moved = nextPhysics.x !== before.x || nextPhysics.y !== before.y
  }
  // idle/sleep/happy/think/dragged：原地不动（dragged 的位置由主进程拖拽推送）

  return { brain: nextBrain, physics: nextPhysics, moved }
}

// —— 渲染层 ↔ 主进程的窗体事件（IPC payload，弱校验）——

export type PetWindowEvent =
  | { type: 'move'; x: number; y: number }
  | { type: 'drag-start'; offsetX: number; offsetY: number }
  | { type: 'drag-end' }
  | { type: 'chat'; open: boolean }
  /** 右键菜单「打开设置」：聚焦主窗并跳设置页（C 期） */
  | { type: 'open-settings' }

/** 主进程 → 渲染层：拖拽中的窗体权威位置（拖拽期间渲染层物理挂起） */
export interface PetDragPosition {
  x: number
  y: number
}

/** 主进程 → 渲染层：松手抛掷初速（主进程差分光标末速） */
export interface PetThrowVelocity {
  vx: number
  vy: number
}

/** 聊天消息（pet-store 环形历史与渲染层共用） */
export interface PetChatMessage {
  role: 'user' | 'pet'
  text: string
  at: number
}

/** 台词播报（自主发言与聊天回复共用；action 驱动宠物播放对应状态动画） */
export type PetSayAction = 'idle' | 'walk' | 'happy' | 'think' | 'sleep'
export interface PetSayPayload {
  text: string
  action: PetSayAction
}

/** 用户素材包帧内容（packId + manifest + 帧 data URL 表；内置包不走 IPC） */
export interface PackAssets {
  packId: string
  manifest: PetManifest
  /** state id → 帧 data URL 列表（与 manifest.states[id].frames 一一对应） */
  frames: Record<string, string[]>
}

/** 素材包元信息（内置包 + 用户包统一形态；坏包 ok=false 带原因） */
export interface PetPackInfo {
  id: string
  builtin: boolean
  ok: boolean
  frameCount: number
  reason?: string
}

/** 模型预设摘要（供设置面板下拉；apiKey 绝不出主进程） */
export interface PetPresetSummary {
  id: string
  name: string
  protocol: string
  baseURL: string
}

/** pet:get-state 快照（A 期基础字段 + B 期脑字段 + C 期包列表） */
/** 模型预设显式关闭哨兵：桌宠「不接 AI（用本地台词）」；'' = 未配置（自动用第一个预设） */
export const PET_PRESET_NONE = '__none__'

export interface PetStateSnapshot {
  enabled: boolean
  packId: string
  personaPrompt: string
  autonomySec: number
  presetId: string
  /** 实际生效的预设 id（presetId 未配置时自动落到第一个；'' = 没有任何可用预设） */
  activePresetId: string
  model: string
  presets: PetPresetSummary[]
  /** AI 脑最近一次结果（source=none 尚未跑过；fallback 的 lastError 说明兜底原因） */
  brainStatus: { source: 'llm' | 'fallback' | 'none'; lastError: string; silenced: boolean }
  chatHistory: PetChatMessage[]
  packs: PetPackInfo[]
  /** 渲染层物理换算工作区（主进程 screen.getPrimaryDisplay().workArea） */
  screen?: { workArea: { x: number; y: number; width: number; height: number } }
}
