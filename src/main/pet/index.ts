// PetController：桌宠域组装——配置存储 + 透明窗 + （B 期）AI 脑。
// initMain 幂等闸内挂载（照其他 controller 惯例）；IPC 域在 ipc/pet.ts 只做解析转发。
import { BrowserWindow, screen } from 'electron'
import type { ApiPreset } from '../presets'
import { PetStore } from './pet-store'
import { PetWindowController } from './pet-window'
import { PetBrainLoop, type PetSay } from './pet-brain'
import { listPacks, readUserPackAssets } from './packs'
import { PET_WINDOW_SIZE, type PackAssets, type PetSayPayload, type PetStateSnapshot, type PetWindowEvent } from '../../shared/pet'

export interface PetControllerDeps {
  userDataDir: string
  getPresets: () => ApiPreset[]
  getMainWindow: () => BrowserWindow | null
  /** 看板摘要宏来源（{board_summary}；取不到返回「暂无任务摘要」由宏层兜底） */
  getBoardSummary: () => string
}

const BOUNDS_FLUSH_MS = 3000

export class PetController {
  readonly store: PetStore
  readonly windows: PetWindowController
  readonly brain: PetBrainLoop
  private pendingBounds: { x: number; y: number } | null = null
  private boundsFlushTimer: NodeJS.Timeout | undefined
  private disposed = false

  constructor(private readonly deps: PetControllerDeps) {
    this.store = new PetStore(deps.userDataDir)
    this.windows = new PetWindowController({ getWindow: () => deps.getMainWindow() })
    this.brain = new PetBrainLoop({
      store: this.store,
      getPresets: deps.getPresets,
      getWindow: () => this.windows.getWindow(),
      getBoardSummary: deps.getBoardSummary,
      onSay: (say: PetSay) => {
        // 自主发言：宠物窗播报 + 落聊天历史（聊天回复的落盘在 brain.chat 内做）
        this.windows.broadcast('pet:say', say)
        this.store.appendChat({ role: 'pet', text: say.say })
      }
    })
  }

  /** 启动入口（initMain 末尾调用）：配置开启则亮窗 + 起脑 */
  start(): void {
    if (this.store.get().enabled && !this.disposed) {
      this.showWindow()
      this.brain.start()
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
    const config = this.store.get()
    return {
      enabled: config.enabled,
      packId: config.packId,
      personaPrompt: config.personaPrompt,
      autonomySec: config.autonomySec,
      presetId: config.presetId,
      model: config.model,
      presets: this.deps.getPresets().map((preset) => ({
        id: preset.id,
        name: preset.name,
        protocol: preset.protocol ?? (/(\/v1$|openrouter)/.test(preset.baseURL) ? 'openai' : 'anthropic'),
        baseURL: preset.baseURL
      })),
      chatHistory: config.chatHistory,
      packs: listPacks(this.deps.userDataDir),
      screen: { workArea: screen.getPrimaryDisplay().workArea }
    }
  }

  setEnabled(enabled: boolean): PetStateSnapshot {
    this.store.setEnabled(enabled)
    if (enabled && !this.disposed) {
      this.showWindow()
      this.brain.start()
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

  /** 聊天一问一答（B 期接线：A 期的本地占位在渲染层已替换为这一路） */
  async sendChat(text: string): Promise<PetSayPayload> {
    const reply = await this.brain.chat(text)
    return { text: reply.say, action: reply.action }
  }

  /** 渲染层 → 主进程的窗体事件（移动/拖拽/聊天开合） */
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
    return { x: workArea.x + workArea.width - PET_WINDOW_SIZE.width - 40, y: workArea.y + workArea.height - PET_WINDOW_SIZE.height }
  }

  dispose(): void {
    this.disposed = true
    this.brain.stop()
    this.flushBounds()
    this.windows.close()
  }
}
