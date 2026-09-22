// PetController：小助理（桌宠）域组装——配置存储 + 透明窗 + 独立设置窗 + AI 脑 + 养成/事件联动 + 素材包生成。
// initMain 幂等闸内挂载（照其他 controller 惯例）；IPC 域在 ipc/pet.ts 只做解析转发。
// 养成数值公式全在 shared/pet-life（纯函数）：这里只做读取-套公式-落盘的编排。
import { BrowserWindow, screen } from 'electron'
import type { ApiPreset } from '../presets'
import { PetStore } from './pet-store'
import { PetWindowController } from './pet-window'
import { PetSettingsWindowController } from './pet-settings-window'
import { PetGenController } from './pet-gen'
import { PetBrainLoop, resolveActivePreset, timeOfDay, type PetSay, type PetTaskHint } from './pet-brain'
import { PetEventBatchWindow, timeoutScheduler, type PetHost } from './host'
import { inferPresetProtocol } from './pet-llm'
import { listPacks, readUserPackAssets } from './packs'
import { normalizePetZoom, petWindowSize, type PackAssets, type PetHostEvent, type PetLifeSnapshot, type PetSayPayload, type PetStateSnapshot, type PetWindowEvent } from '../../shared/pet'
import { addAffection, addMood, affectionTier, boardReactionFor, decayAffection, feedEffect, firstSeenToday, interactionEffect, moodLabel, todayKey, type PetBoardReaction } from '../../shared/pet-life'

export interface PetControllerDeps {
  userDataDir: string
  getPresets: () => ApiPreset[]
  getMainWindow: () => BrowserWindow | null
  /** 契约宿主（阶段 1 改道）：事件流订阅 + {board_summary} 快照通道 + deck.* 工具 */
  host: PetHost
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

/** 合并窗批次（去重后的待反应事件） */
interface PetBatchedEvent {
  task: PetTaskHint
  reaction: PetBoardReaction
}

/** 批量终态的聚合文案（{recent_event} 宏同源）：按种类计数，不逐条铺标题 */
function batchEventText(items: PetBatchedEvent[]): string {
  const count = (kind: PetBoardReaction['kind']) => items.filter((item) => item.reaction.kind === kind).length
  const parts: string[] = []
  const starts = count('start')
  const done = count('done')
  const failed = count('failed')
  if (starts) parts.push(`${starts} 个任务开工`)
  if (done) parts.push(`${done} 个任务完成`)
  if (failed) parts.push(`${failed} 个任务失败`)
  return `看板刚热闹起来：${parts.join('、')}`
}

export class PetController {
  readonly store: PetStore
  readonly windows: PetWindowController
  readonly brain: PetBrainLoop
  /** 独立小助理设置窗（#/pet-settings 路由） */
  readonly settingsWindow: PetSettingsWindowController
  /** 应用内素材包生成（pet:gen-* IPC 背后） */
  readonly gen: PetGenController
  /** 契约宿主（事件流/开关位/deck.* 工具）：notifyTaskChanged 经 host.emitTaskChanged 进来 */
  readonly host: PetHost
  private pendingBounds: { x: number; y: number } | null = null
  private boundsFlushTimer: NodeJS.Timeout | undefined
  private lifeFlushTimer: NodeJS.Timeout | undefined
  /** 任务状态迁移追踪：同一任务只在状态变化时反应（runner 会高频重复上报） */
  private taskStatuses = new Map<string, string>()
  /** 事件合并窗：批量终态合成一次聚合反应（好感/心情合计一次 + 一次 brain 调用） */
  private batchWindow: PetEventBatchWindow<PetBatchedEvent>
  private recentEvent = ''
  private disposed = false

  constructor(private readonly deps: PetControllerDeps) {
    this.store = new PetStore(deps.userDataDir)
    this.host = deps.host
    // 契约事件流驱动：task.* 事件 → 去重 + 合并窗；board.snapshot → 看板状态对账（补契约外状态）
    deps.host.addListener((event) => this.onHostEvent(event))
    this.batchWindow = new PetEventBatchWindow<PetBatchedEvent>({
      onFlush: (items) => this.flushBatch(items),
      scheduler: timeoutScheduler()
    })
    this.windows = new PetWindowController({
      getWindow: () => deps.getMainWindow(),
      getZoom: () => this.store.get().zoom,
      // 拖拽跨屏：宠物窗所在显示器变化 → 推新快照（workArea 换跟随所在屏，渲染层物理边界跟着换）
      onDisplayChanged: () => this.notifyState()
    })
    this.settingsWindow = new PetSettingsWindowController(() => deps.getMainWindow())
    this.gen = new PetGenController({
      userDataDir: deps.userDataDir,
      getPresets: deps.getPresets,
      notify: (channel, payload) => {
        this.broadcastAll(channel, payload)
        if (channel === 'pet:gen-done') {
          // 素材包下拉即见：推新快照（listPacks→scanUserPack 扫到新包）；正展示该包则顺手重载帧资源
          const packId = (payload as { packId?: string } | null)?.packId
          if (packId && this.store.get().packId === packId) this.windows.handlePetReload()
          this.notifyState()
        }
      }
    })
    this.brain = new PetBrainLoop({
      store: this.store,
      getPresets: deps.getPresets,
      getWindow: () => this.windows.getWindow(),
      // {board_summary} 宏改走快照通道：host 缓存最近一次 board.snapshot 捕获的摘要（宏注入行为保持）
      getBoardSummary: () => this.host.getBoardSummary(),
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
      // 物理边界跟随宠物窗所在显示器（跨屏拖动后拖拽跟随会推新快照）
      screen: { workArea: this.currentWorkArea() },
      life: this.lifeSnapshot(config.affection, config.mood, fedToday),
      zoom: config.zoom,
      recentEvent: this.recentEvent
    }
  }

  /** 宠物窗当前所在显示器的工作区（窗未开回退主屏） */
  private currentWorkArea(): { x: number; y: number; width: number; height: number } {
    const win = this.windows.getWindow()
    if (win) return screen.getDisplayMatching(win.getBounds()).workArea
    return screen.getPrimaryDisplay().workArea
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

  /** 契约事件流入口（index.ts notifyTaskChanged → host.emitTaskChanged 改道后由此驱动反应） */
  private onHostEvent(event: PetHostEvent): void {
    if (this.disposed) return
    if (event.kind === 'board.snapshot') {
      // 快照不带状态：借 deck.queryBoard 对账补齐契约外状态（cancelled/queued/parked），
      // 否则取消后同 id 重跑的 start 反应会被去重吞掉
      this.syncTaskStatusFromBoard(event.taskId)
      return
    }
    if (event.kind !== 'task.running' && event.kind !== 'task.done' && event.kind !== 'task.failed') return
    const status = event.kind === 'task.running' ? 'running' : event.kind === 'task.done' ? 'done' : 'failed'
    this.onTaskChanged({ id: event.taskId, status, title: event.title })
  }

  /** 看板对账：把契约事件面之外的状态变化同步进去重表（终态顺手排期清理） */
  private syncTaskStatusFromBoard(taskId: string): void {
    if (!taskId) return
    const row = this.host.queryBoard().find((item) => item.id === taskId)
    if (!row || this.taskStatuses.get(taskId) === row.status) return
    this.taskStatuses.set(taskId, row.status)
    if (row.status === 'done' || row.status === 'failed' || row.status === 'cancelled') {
      setTimeout(() => {
        if (this.taskStatuses.get(taskId) === row.status) this.taskStatuses.delete(taskId)
      }, 60_000)
    }
  }

  /**
   * 看板任务状态迁移入口（契约事件流驱动）：taskStatuses 去重后进合并窗——
   * 批量终态在冲刷时合成一次聚合反应（好感/心情合计一次落盘 + 一次 brain 调用）。
   */
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
    this.batchWindow.push({ task, reaction })
  }

  /** 合并窗冲刷：好感/心情按批次合计一次写盘 + 一次 brain 调用（brain 的 10s 冷却保留作兜底） */
  private flushBatch(items: PetBatchedEvent[]): void {
    if (this.disposed || !items.length) return
    let affection = 0
    let mood = 0
    for (const item of items) {
      affection += item.reaction.affection
      mood += item.reaction.mood
    }
    // 台词取批次最后一棒（时间线最新）；批量走聚合文案，单发保持原有逐事件文案
    const last = items[items.length - 1]
    this.recentEvent = items.length > 1 ? batchEventText(items) : eventText(last.reaction.kind, last.task.title)
    const config = this.store.get()
    this.store.setLife({
      affection: addAffection(config.affection, affection),
      mood: addMood(config.mood, mood),
      lastInteractAt: config.lastInteractAt || Date.now()
    })
    void this.brain.reactToBoardEvent(last.task, last.reaction).then((say) => {
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

  /** 渲染层 → 主进程的窗体事件（移动/拖拽/聊天开合/菜单开合/悬停/交互上报） */
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
    // 拖拽/聊天进行中扣住合并窗（松开/关闭时若有到点批次立即冲出）
    if (event.type === 'drag-start') this.batchWindow.hold()
    if (event.type === 'drag-end') this.batchWindow.release()
    if (event.type === 'chat') (event.open ? this.batchWindow.hold() : this.batchWindow.release())
    if (event.type === 'interact') this.bumpLife(event.kind, false)
    if (event.type === 'open-settings') {
      // 右键菜单「设置」：打开/聚焦独立小助理设置窗（主窗可能在托盘里也不影响）
      this.openSettingsWindow()
      return
    }
    this.windows.handleEvent(event)
  }

  /** 打开或聚焦独立设置窗（右键菜单与主程序设置页按钮共用） */
  openSettingsWindow(): void {
    this.settingsWindow.open()
  }

  private flushBounds(): void {
    if (this.boundsFlushTimer) clearTimeout(this.boundsFlushTimer)
    this.boundsFlushTimer = undefined
    if (!this.pendingBounds) return
    this.store.setBounds(this.pendingBounds)
    this.pendingBounds = null
  }

  /** 快照广播：主窗设置卡片、宠物窗与独立设置窗同步（照 settings:updated 惯例） */
  notifyState(): PetStateSnapshot {
    const snapshot = this.getState()
    this.deps.getMainWindow()?.webContents.send('pet:state', snapshot)
    this.windows.broadcast('pet:state', snapshot)
    this.settingsWindow.getWindow()?.webContents.send('pet:state', snapshot)
    return snapshot
  }

  /** 广播到所有相关窗（主窗 + 宠物窗 + 设置窗）：生成进度/完成/失败用 */
  private broadcastAll(channel: string, payload: unknown): void {
    this.deps.getMainWindow()?.webContents.send(channel, payload)
    this.windows.broadcast(channel, payload)
    this.settingsWindow.getWindow()?.webContents.send(channel, payload)
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
    this.batchWindow.clear()
    if (this.lifeFlushTimer) clearTimeout(this.lifeFlushTimer)
    this.lifeFlushTimer = undefined
    this.store.flush()
    this.flushBounds()
    this.windows.close()
    this.settingsWindow.close()
  }
}
