// PetController：桌宠域组装——配置存储 + 透明窗 + AI 脑 + 养成/事件联动。
// initMain 幂等闸内挂载（照其他 controller 惯例）；IPC 域在 ipc/pet.ts 只做解析转发。
// 养成数值公式全在 shared/pet-life（纯函数）：这里只做读取-套公式-落盘的编排。
import { BrowserWindow, screen } from 'electron'
import type { ApiPreset } from '../presets'
import { PetStore } from './pet-store'
import { PetWindowController } from './pet-window'
import { PetBrainLoop, resolveActivePreset, timeOfDay, type PetSay, type PetTaskHint } from './pet-brain'
import { inferPresetProtocol } from './pet-llm'
import { listPacks, readUserPackAssets } from './packs'
import { normalizePetZoom, petWindowSize, type PackAssets, type PetLifeSnapshot, type PetSayPayload, type PetStateSnapshot, type PetWindowEvent } from '../../shared/pet'
import { addAffection, addMood, affectionTier, boardReactionFor, decayAffection, feedEffect, firstSeenToday, interactionEffect, moodLabel, todayKey } from '../../shared/pet-life'

export interface PetControllerDeps {
  userDataDir: string
  getPresets: () => ApiPreset[]
  getMainWindow: () => BrowserWindow | null
  /** 看板摘要宏来源（{board_summary}；取不到返回「暂无任务摘要」由宏层兜底） */
  getBoardSummary: () => string
}

const BOUNDS_FLUSH_MS = 3000
/** 高频交互（单击）的好感/心情落盘节流：内存累积，2s 一次写盘 */
const LIFE_FLUSH_MS = 2000

/** 看板事件文案（{recent_event} 宏 + 设置卡片同源） */
function eventText(kind: 'start' | 'done' | 'failed', title: string): string {
  if (kind === 'done') return `任务「${title}」刚完成`
  if (kind === 'failed') return `任务「${title}」刚失败`
  return `任务「${title}」开始执行`
}

export class PetController {
  readonly store: PetStore
  readonly windows: PetWindowController
  readonly brain: PetBrainLoop
  private pendingBounds: { x: number; y: number } | null = null
  private boundsFlushTimer: NodeJS.Timeout | undefined
  private lifeFlushTimer: NodeJS.Timeout | undefined
  /** 任务状态迁移追踪：同一任务只在状态变化时反应（runner 会高频重复上报） */
  private taskStatuses = new Map<string, string>()
  private recentEvent = ''
  private disposed = false

  constructor(private readonly deps: PetControllerDeps) {
    this.store = new PetStore(deps.userDataDir)
    this.windows = new PetWindowController({
      getWindow: () => deps.getMainWindow(),
      getZoom: () => this.store.get().zoom
    })
    this.brain = new PetBrainLoop({
      store: this.store,
      getPresets: deps.getPresets,
      getWindow: () => this.windows.getWindow(),
      getBoardSummary: deps.getBoardSummary,
      getRecentEvent: () => this.recentEvent,
      onSay: (say: PetSay) => {
        // 自主发言：宠物窗播报（PetSayPayload 契约 {text,action}，渲染层按此解包）+ 落聊天历史
        this.windows.broadcast('pet:say', { text: say.say, action: say.action })
        this.store.appendChat({ role: 'pet', text: say.say })
      }
    })
  }

  /** 启动入口（initMain 末尾调用）：配置开启则亮窗 + 起脑 + 每日问候 */
  start(): void {
    if (this.store.get().enabled && !this.disposed) {
      this.showWindow()
      this.brain.start()
      void this.greetIfFirstToday()
    }
  }

  private showWindow(): void {
    this.windows.show(this.store.get().bounds ?? undefined)
  }

  /** 供 pet-brain 取宠物窗 webContents（B 期推台词） */
  getPetWindow(): BrowserWindow | null {
    return this.windows.getWindow()
  }

  getState(): PetStateSnapshot {
    this.applyDailyDecay()
    const config = this.store.get()
    const presets = this.deps.getPresets()
    const active = resolveActivePreset(config.presetId, presets)
    const fedToday = config.fedDate === todayKey() ? config.fedCount : 0
    return {
      enabled: config.enabled,
      packId: config.packId,
      personaPrompt: config.personaPrompt,
      autonomySec: config.autonomySec,
      presetId: config.presetId,
      activePresetId: active?.id ?? '',
      model: config.model,
      presets: presets.map((preset) => ({
        id: preset.id,
        name: preset.name,
        protocol: inferPresetProtocol(preset),
        baseURL: preset.baseURL
      })),
      brainStatus: this.brain.status(),
      chatHistory: config.chatHistory,
      packs: listPacks(this.deps.userDataDir),
      screen: { workArea: screen.getPrimaryDisplay().workArea },
      life: this.lifeSnapshot(config.affection, config.mood, fedToday),
      zoom: config.zoom,
      recentEvent: this.recentEvent
    }
  }

  private lifeSnapshot(affection: number, mood: number, fedToday: number): PetLifeSnapshot {
    return { affection, mood, tier: affectionTier(affection), moodLabel: moodLabel(mood), fedToday }
  }

  /** 好感按自然日衰减（读时惰性结算）：变化才写盘，稳态零写入 */
  private applyDailyDecay(): void {
    const config = this.store.get()
    const decayed = decayAffection(config.affection, config.lastInteractAt, Date.now())
    if (decayed !== config.affection) this.store.setLife({ affection: decayed, mood: config.mood, lastInteractAt: config.lastInteractAt })
  }

  /**
   * 交互累积好感/心情：click 高频走内存合并（2s 落盘一次），其余即时落盘。
   * lastInteractAt 是好感按日衰减的基准，任何交互都会刷新。
   */
  private bumpLife(kind: 'click' | 'throw' | 'chat', immediate: boolean): void {
    const config = this.store.get()
    const effect = interactionEffect(kind)
    const next = {
      affection: addAffection(config.affection, effect.affection),
      mood: addMood(config.mood, effect.mood),
      lastInteractAt: Date.now()
    }
    if (immediate) {
      this.store.setLife(next)
      return
    }
    this.store.mergeInMemory(next)
    if (!this.lifeFlushTimer) {
      this.lifeFlushTimer = setTimeout(() => {
        this.lifeFlushTimer = undefined
        if (!this.disposed) this.store.flush()
      }, LIFE_FLUSH_MS)
    }
  }

  /** 播报一条宠物台词（事件反应/问候共用）：推窗 + 落聊天历史 */
  private announce(say: PetSay): void {
    this.windows.broadcast('pet:say', { text: say.say, action: say.action })
    this.store.appendChat({ role: 'pet', text: say.say })
  }

  /** 每日首次亮窗按时段问候（LLM 优先，失败走本地分时段台词）；打过卡当天不再重复 */
  private async greetIfFirstToday(): Promise<void> {
    const config = this.store.get()
    if (!firstSeenToday(config.greetedDate) || !this.windows.getWindow()) return
    this.store.setGreeted(todayKey())
    try {
      this.announce(await this.brain.greet())
    } catch { /* 问候失败静默：不打断启动 */ }
  }

  /** 看板任务状态迁移入口（index.ts notifyTaskChanged 转发）：事件反应 + 好感/心情联动 */
  onTaskChanged(task: PetTaskHint): void {
    if (this.disposed || !this.store.get().enabled) return
    const prev = this.taskStatuses.get(task.id)
    if (prev === task.status) return
    this.taskStatuses.set(task.id, task.status)
    // 终态清理：Map 只保留活跃任务，防长会话无限增长
    if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') {
      setTimeout(() => {
        if (this.taskStatuses.get(task.id) === task.status) this.taskStatuses.delete(task.id)
      }, 60_000)
    }
    const reaction = boardReactionFor(prev, task.status)
    if (!reaction) return
    this.recentEvent = eventText(reaction.kind, task.title)
    const config = this.store.get()
    this.store.setLife({
      affection: addAffection(config.affection, reaction.affection),
      mood: addMood(config.mood, reaction.mood),
      lastInteractAt: config.lastInteractAt || Date.now()
    })
    void this.brain.reactToBoardEvent(task, reaction).then((say) => {
      if (!this.disposed) this.announce(say)
    }).catch(() => { /* 反应失败静默 */ })
  }

  setEnabled(enabled: boolean): PetStateSnapshot {
    this.store.setEnabled(enabled)
    if (enabled && !this.disposed) {
      this.showWindow()
      this.brain.start()
      void this.greetIfFirstToday()
    } else {
      this.brain.stop()
      this.windows.close()
    }
    return this.notifyState()
  }

  setPack(packId: string): PetStateSnapshot {
    this.store.setPack(packId)
    // 宠物窗收到后重载素材（渲染层自行决定内置包走 vite glob / 用户包走 IPC data URL）
    this.windows.handlePetReload()
    return this.notifyState()
  }

  /** 用户素材包帧内容（data URL）；内置包渲染层走 vite 管线，不进这里 */
  getPackAssets(packId: string): PackAssets | null {
    try {
      return readUserPackAssets(this.deps.userDataDir, packId)
    } catch {
      return null
    }
  }

  setPersona(text: string): PetStateSnapshot {
    this.store.setPersona(text)
    return this.notifyState()
  }

  setAutonomy(sec: number): PetStateSnapshot {
    this.store.setAutonomy(sec)
    this.brain.restart()
    return this.notifyState()
  }

  setPreset(presetId: string, model?: string): PetStateSnapshot {
    this.store.setPreset(presetId, model)
    return this.notifyState()
  }

  /** 缩放档切换：持久化 + 窗体保底心锚缩放（渲染层按快照同步精灵与物理边界） */
  setZoom(zoom: number): PetStateSnapshot {
    const normalized = normalizePetZoom(zoom)
    this.store.setZoom(normalized)
    this.windows.applyZoom(normalized)
    return this.notifyState()
  }

  /**
   * 投喂：好感 +4 / 心情 +8（每日前 5 次全额，之后只加一半心情）。
   * 吃动画由渲染层自播（eat 态，缺失退回 happy）；这里只收口数值与快照。
   */
  feed(foodId: string): PetStateSnapshot {
    const config = this.store.get()
    const today = todayKey()
    const fedToday = config.fedDate === today ? config.fedCount : 0
    const effect = feedEffect(fedToday)
    this.store.setLife({
      affection: addAffection(config.affection, effect.affection),
      mood: addMood(config.mood, effect.mood),
      lastInteractAt: Date.now(),
      fedDate: today,
      fedCount: fedToday + 1
    })
    this.recentEvent = `主人投喂了${foodId || '小零食'}`
    return this.notifyState()
  }

  /** 聊天一问一答（B 期接线：A 期的本地占位在渲染层已替换为这一路） */
  async sendChat(text: string): Promise<PetSayPayload> {
    this.bumpLife('chat', true)
    const reply = await this.brain.chat(text)
    return { text: reply.say, action: reply.action }
  }

  /** 渲染层 → 主进程的窗体事件（移动/拖拽/聊天开合/交互上报） */
  onWindowEvent(event: PetWindowEvent): void {
    if (event.type === 'move') {
      // 位置落盘节流：移动高频，写文件低频（退出/隐藏时补一次）
      this.pendingBounds = { x: event.x, y: event.y }
      if (!this.boundsFlushTimer) {
        this.boundsFlushTimer = setTimeout(() => this.flushBounds(), BOUNDS_FLUSH_MS)
      }
      return
    }
    if (event.type === 'drag-end') this.flushBounds()
    if (event.type === 'interact') this.bumpLife(event.kind, false)
    this.windows.handleEvent(event)
  }

  private flushBounds(): void {
    if (this.boundsFlushTimer) clearTimeout(this.boundsFlushTimer)
    this.boundsFlushTimer = undefined
    if (!this.pendingBounds) return
    this.store.setBounds(this.pendingBounds)
    this.pendingBounds = null
  }

  /** 快照广播：主窗设置卡片与宠物窗同步（照 settings:updated 惯例） */
  notifyState(): PetStateSnapshot {
    const snapshot = this.getState()
    this.deps.getMainWindow()?.webContents.send('pet:state', snapshot)
    this.windows.broadcast('pet:state', snapshot)
    return snapshot
  }

  /** 默认窗位置（渲染层 fallback 用）：主窗右下工作区内 */
  defaultPosition(): { x: number; y: number } {
    const workArea = screen.getPrimaryDisplay().workArea
    const size = petWindowSize(this.store.get().zoom)
    return { x: workArea.x + workArea.width - size.width - 40, y: workArea.y + workArea.height - size.height }
  }

  /** 时段（导出给测试/未来 UI 用；问候语按此分桶） */
  currentBucket(): string {
    return timeOfDay()
  }

  dispose(): void {
    this.disposed = true
    this.brain.stop()
    if (this.lifeFlushTimer) clearTimeout(this.lifeFlushTimer)
    this.lifeFlushTimer = undefined
    this.store.flush()
    this.flushBounds()
    this.windows.close()
  }
}
