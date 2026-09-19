// 桌宠透明窗：无边框/透明/置顶/跳过任务栏，加载现有 renderer 入口 URL 带 #/pet。
// 透明区鼠标穿透：主进程 ~150ms 轮询光标，落在精灵命中区或聊天打开才收鼠标；
// 拖拽由主进程按光标 setPosition 跟随，并差分光标末速作为抛掷初速（pet:thrown 推回渲染层）。
import { BrowserWindow, app, screen } from 'electron'
import path from 'node:path'
import { resolveHotState } from '../hot/resolve'
import { normalizePetZoom, petSpriteRect, petSpriteScale, petWindowSize, type PetDragPosition, type PetThrowVelocity, type PetWindowEvent } from '../../shared/pet'

const PASS_THROUGH_POLL_MS = 150
const DRAG_POLL_MS = 16
/** 拖拽速度差分窗口：取最近 ~80ms 的光标位移（太快抖、太慢迟钝） */
const VELOCITY_WINDOW_MS = 80

export interface PetWindowDeps {
  getWindow: () => BrowserWindow | null
  /** 当前缩放档（穿透命中区与窗体尺寸的同步来源） */
  getZoom: () => number
}

export class PetWindowController {
  private window: BrowserWindow | null = null
  private pollTimer: NodeJS.Timeout | undefined
  private dragTimer: NodeJS.Timeout | undefined
  private mouseCaptured = false
  private chatOpen = false
  /** 拖拽状态：offset = 光标在窗体内的偏移；history = 差分末速采样 */
  private drag: { offsetX: number; offsetY: number; history: Array<{ t: number; x: number; y: number }> } | null = null

  constructor(private readonly deps: PetWindowDeps) {}

  isOpen(): boolean {
    return this.window !== null && !this.window.isDestroyed()
  }

  /** 宠物窗本体（B 期脑循环推台词用）；未开返回 null */
  getWindow(): BrowserWindow | null {
    return this.isOpen() ? this.window : null
  }

  /** 通知渲染层重载素材包（setPack 后） */
  handlePetReload(): void {
    this.broadcast('pet:pack-changed', null)
  }

  broadcast(channel: string, payload: unknown): void {
    if (!this.isOpen()) return
    this.window!.webContents.send(channel, payload)
  }

  /** 创建并显示窗体；恢复位置 clamp 进工作区（store 里可能残留多屏外坐标） */
  show(position?: { x: number; y: number }): void {
    if (this.isOpen()) {
      this.window?.show()
      return
    }
    const zoom = normalizePetZoom(this.deps.getZoom())
    const size = petWindowSize(zoom)
    const win = new BrowserWindow({
      width: size.width,
      height: size.height,
      // 透明窗三件套：transparent + frame:false + 不设 backgroundColor（设了就不透明）
      transparent: true,
      frame: false,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      // toolbar 型窗口不进 Alt-Tab 列表（win32），桌宠不该抢应用切换
      type: 'toolbar',
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })
    win.setMenu(null)
    win.on('closed', () => {
      this.window = null
      this.stopPolling()
      this.stopDrag()
    })
    const workArea = screen.getPrimaryDisplay().workArea
    if (position) {
      win.setPosition(
        Math.min(Math.max(Math.round(position.x), workArea.x), workArea.x + workArea.width - size.width),
        Math.min(Math.max(Math.round(position.y), workArea.y), workArea.y + workArea.height - size.height)
      )
    } else {
      win.setPosition(workArea.x + workArea.width - size.width - 40, workArea.y + workArea.height - size.height)
    }
    this.loadRenderer(win)
    win.showInactive()
    this.window = win
    this.startPolling()
  }

  /** 缩放档切换：窗体尺寸随档位变化，保「底边中点」锚（精灵脚不移位），再 clamp 进工作区 */
  applyZoom(zoom: number): void {
    const normalized = normalizePetZoom(zoom)
    if (!this.isOpen()) return
    const win = this.window!
    const [oldX, oldY] = win.getPosition()
    const [oldW, oldH] = win.getSize()
    const size = petWindowSize(normalized)
    if (oldW === size.width && oldH === size.height) return
    const x = Math.round(oldX + (oldW - size.width) / 2)
    const y = Math.round(oldY + oldH - size.height)
    win.setBounds({ x, y, width: size.width, height: size.height })
    const workArea = screen.getPrimaryDisplay().workArea
    const [newX, newY] = win.getPosition()
    win.setPosition(
      Math.min(Math.max(newX, workArea.x), workArea.x + workArea.width - size.width),
      Math.min(Math.max(newY, workArea.y), workArea.y + workArea.height - size.height)
    )
  }

  hide(): void {
    this.stopPolling()
    this.stopDrag()
    this.window?.hide()
  }

  close(): void {
    this.stopPolling()
    this.stopDrag()
    this.window?.destroy()
    this.window = null
  }

  /** 渲染层物理推进后的窗体移动请求（拖拽期间以主进程跟随为准，忽略） */
  moveTo(x: number, y: number): void {
    if (!this.isOpen() || this.drag) return
    this.window?.setPosition(Math.round(x), Math.round(y))
  }

  /** 渲染层上报聊天面板开合：开着时整窗收鼠标 */
  setChatOpen(open: boolean): void {
    this.chatOpen = open
  }

  /** 渲染层鼠标/触摸事件的入口（pet:window-event IPC 转发到这里） */
  handleEvent(event: PetWindowEvent): void {
    switch (event.type) {
      case 'move':
        this.moveTo(event.x, event.y)
        break
      case 'drag-start':
        this.startDrag(event.offsetX, event.offsetY)
        break
      case 'drag-end':
        this.stopDrag(true)
        break
      case 'chat':
        this.setChatOpen(event.open)
        break
      case 'open-settings':
        // 右键菜单「打开设置」：主窗可能在托盘里，先 show 再派发跳页
        this.focusMainWindow('pet:open-settings')
        break
    }
  }

  /** 复用主窗的渲染层加载策略：dev 用 ELECTRON_RENDERER_URL，生产优先热更渲染层 */
  private loadRenderer(win: BrowserWindow): void {
    if (process.env.ELECTRON_RENDERER_URL) {
      void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#/pet`)
      return
    }
    const hot = app.isPackaged
      ? resolveHotState(app.getPath('userData'), app.getVersion())
      : resolveHotState(app.getPath('userData'), app.getVersion(), { skipPayload: true })
    // hash 选项原样拼在 # 后：'/pet' → index.html#/pet，与 dev 的 `${URL}#/pet` 同构（'pet' 会生成 #pet，主 UI 会误入宠物窗）
    void win.loadFile(hot.rendererIndexHtml ?? path.join(__dirname, '../renderer/index.html'), { hash: '/pet' })
  }

  // —— 鼠标穿透轮询：光标在精灵命中区（+8px 余量）或聊天打开才收鼠标 ——
  private startPolling(): void {
    if (this.pollTimer) return
    const poll = () => {
      if (!this.isOpen() || this.drag) return
      const win = this.window!
      const cursor = screen.getCursorScreenPoint()
      const [wx, wy] = win.getPosition()
      const [ww, wh] = win.getSize()
      // 命中区与窗体/精灵同缩放：尺寸取窗体实际大小，倍率取当前档位
      const sprite = petSpriteRect(ww, wh, petSpriteScale(normalizePetZoom(this.deps.getZoom())))
      const margin = 8
      const inside =
        cursor.x >= wx + sprite.left - margin && cursor.x <= wx + sprite.left + sprite.width + margin &&
        cursor.y >= wy + sprite.top - margin && cursor.y <= wy + sprite.top + sprite.height + margin
      this.setCapture(inside || this.chatOpen)
    }
    poll()
    this.pollTimer = setInterval(poll, PASS_THROUGH_POLL_MS)
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = undefined
  }

  private setCapture(capture: boolean): void {
    if (!this.isOpen() || capture === this.mouseCaptured) return
    this.mouseCaptured = capture
    // forward:true 让穿透态下渲染层仍收到 mousemove（Windows），光标样式可反馈
    this.window!.setIgnoreMouseEvents(!capture, { forward: true })
  }

  // —— 主进程拖拽跟随：光标 setPosition，差分末速作抛掷初速 ——
  private startDrag(offsetX: number, offsetY: number): void {
    if (!this.isOpen()) return
    this.drag = { offsetX, offsetY, history: [] }
    this.setCapture(true)
    const follow = () => {
      if (!this.drag || !this.isOpen()) return
      const cursor = screen.getCursorScreenPoint()
      const x = cursor.x - this.drag.offsetX
      const y = cursor.y - this.drag.offsetY
      this.drag.history.push({ t: Date.now(), x, y })
      const cutoff = Date.now() - VELOCITY_WINDOW_MS * 3
      this.drag.history = this.drag.history.filter((item) => item.t >= cutoff)
      // setPosition 只收整数：显示缩放非 100% 时 clientY 带小数，不取整直接抛 conversion failure
      this.window!.setPosition(Math.round(x), Math.round(y))
      this.push('pet:drag', { x, y } satisfies PetDragPosition)
    }
    follow()
    this.dragTimer = setInterval(follow, DRAG_POLL_MS)
  }

  private stopDrag(throwIt = false): void {
    const drag = this.drag
    if (!drag) return
    if (this.dragTimer) clearInterval(this.dragTimer)
    this.dragTimer = undefined
    this.drag = null
    if (!throwIt || !this.isOpen()) return
    // 差分末速：窗口内最近采样首尾位移 / 时间差（px/s），窗口内采样不足则视为松手原地下落
    const recent = drag.history.filter((item) => item.t >= Date.now() - VELOCITY_WINDOW_MS)
    let vx = 0
    let vy = 0
    if (recent.length >= 2) {
      const first = recent[0]
      const last = recent[recent.length - 1]
      const dt = Math.max(last.t - first.t, 1) / 1000
      vx = (last.x - first.x) / dt
      vy = (last.y - first.y) / dt
    }
    this.push('pet:thrown', { vx, vy } satisfies PetThrowVelocity)
  }

  private push(channel: string, payload: unknown): void {
    if (!this.isOpen()) return
    this.window!.webContents.send(channel, payload)
  }

  /** 渲染层跳转主窗的入口：show + focus + 频道通知（设置页监听 pet:open-settings） */
  focusMainWindow(channel?: string): void {
    const main = this.deps.getWindow()
    if (!main) return
    main.show()
    main.focus()
    if (channel) main.webContents.send(channel, null)
  }
}
