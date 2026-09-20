// 小助理（桌宠）透明窗：无边框/透明/置顶/跳过任务栏，加载现有 renderer 入口 URL 带 #/pet。
// 透明区鼠标穿透：渲染层权威——精灵 pointerenter/pointerleave 上报 hover 事件，主进程收到即收/放
// 鼠标（聊天/右键菜单打开期间整窗收鼠标）；拖拽由主进程按「光标起点差分」增量 setPosition 跟随
// （同坐标系相减，免疫混 DPI 多屏下绝对坐标错位），并差分光标末速作为抛掷初速（pet:thrown 推回渲染层）。
import { BrowserWindow, app, screen } from 'electron'
import path from 'node:path'
import { resolveHotState } from '../hot/resolve'
import { normalizePetZoom, petWindowSize, type PetDragPosition, type PetThrowVelocity, type PetWindowEvent } from '../../shared/pet'

const DRAG_POLL_MS = 16
/** 拖拽速度差分窗口：取最近 ~80ms 的光标位移（太快抖、太慢迟钝） */
const VELOCITY_WINDOW_MS = 80

export interface PetWindowDeps {
  getWindow: () => BrowserWindow | null
  /** 当前缩放档（窗体尺寸同步来源） */
  getZoom: () => number
  /** 拖拽跨屏时回调（宠物窗所在显示器变化 → controller 推新快照，渲染层边界跟随） */
  onDisplayChanged?: () => void
}

/** 渲染层加载策略（宠物窗与设置窗共用）：dev 用 ELECTRON_RENDERER_URL，生产优先热更渲染层 */
export function loadPetRenderer(win: BrowserWindow, hash: string): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${hash}`)
    return
  }
  const hot = app.isPackaged
    ? resolveHotState(app.getPath('userData'), app.getVersion())
    : resolveHotState(app.getPath('userData'), app.getVersion(), { skipPayload: true })
  // hash 选项原样拼在 # 后：'/pet' → index.html#/pet，与 dev 的 `${URL}#/pet` 同构（'pet' 会生成 #pet，主 UI 会误入宠物窗）
  void win.loadFile(hot.rendererIndexHtml ?? path.join(__dirname, '../renderer/index.html'), { hash })
}

export class PetWindowController {
  private window: BrowserWindow | null = null
  private dragTimer: NodeJS.Timeout | undefined
  /** 当前是否收鼠标；初始取反值让 show() 里的首次 setCapture(false) 必然生效（开穿透） */
  private mouseCaptured = true
  private chatOpen = false
  private menuOpen = false
  /** 渲染层上报的精灵悬停态（穿透开关的输入之一） */
  private hoverInside = false
  /** 拖拽状态：光标/窗体起点 + 差分末速采样（位置 = 起点 + 光标增量，同坐标系免漂移） */
  private drag: { cursorStart: { x: number; y: number }; winStart: { x: number; y: number }; history: Array<{ t: number; x: number; y: number }> } | null = null
  /** 拖拽期间宠物窗所在显示器 id（变化即跨屏，推新 workArea） */
  private lastDisplayId: number | null = null

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

  /** 创建并显示窗体；恢复位置 clamp 进「所在显示器」工作区（store 里可能残留多屏外坐标） */
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
      // toolbar 型窗口不进 Alt-Tab 列表（win32），小助理不该抢应用切换
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
      this.stopDrag()
      // 窗体销毁后渲染层状态清零，主进程交互态同步归零（防新窗被旧态顶成整窗收鼠标）
      this.chatOpen = false
      this.menuOpen = false
      this.hoverInside = false
    })
    // 菜单关闭路径之一：window blur（点击窗外/Alt-Tab）→ 通知渲染层收菜单
    win.on('blur', () => {
      if (!this.menuOpen) return
      this.menuOpen = false
      this.updateCapture()
      this.broadcast('pet:menu-closed', null)
    })
    const workArea = position
      ? screen.getDisplayMatching({ x: Math.round(position.x), y: Math.round(position.y), width: size.width, height: size.height }).workArea
      : screen.getPrimaryDisplay().workArea
    if (position) {
      win.setPosition(
        Math.min(Math.max(Math.round(position.x), workArea.x), workArea.x + workArea.width - size.width),
        Math.min(Math.max(Math.round(position.y), workArea.y), workArea.y + workArea.height - size.height)
      )
    } else {
      win.setPosition(workArea.x + workArea.width - size.width - 40, workArea.y + workArea.height - size.height)
    }
    loadPetRenderer(win, '/pet')
    win.showInactive()
    this.window = win
    // 初始全窗穿透（forward:true 让渲染层照收 mousemove，精灵 enter/leave 可靠触发）
    win.setIgnoreMouseEvents(true, { forward: true })
    this.mouseCaptured = false
  }

  /** 缩放档切换：窗体尺寸随档位变化，保「底边中点」锚（精灵脚不移位），再 clamp 进所在屏工作区 */
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
    const workArea = screen.getDisplayMatching(win.getBounds()).workArea
    const [newX, newY] = win.getPosition()
    win.setPosition(
      Math.min(Math.max(newX, workArea.x), workArea.x + workArea.width - size.width),
      Math.min(Math.max(newY, workArea.y), workArea.y + workArea.height - size.height)
    )
  }

  hide(): void {
    this.stopDrag()
    this.window?.hide()
  }

  close(): void {
    this.stopDrag()
    this.window?.destroy()
    this.window = null
  }

  /** 渲染层物理推进后的窗体移动请求（拖拽期间以主进程跟随为准，忽略） */
  moveTo(x: number, y: number): void {
    if (!this.isOpen() || this.drag) return
    this.window?.setPosition(Math.round(x), Math.round(y))
  }

  /** 渲染层鼠标/触摸事件的入口（pet:window-event IPC 转发到这里） */
  handleEvent(event: PetWindowEvent): void {
    switch (event.type) {
      case 'move':
        this.moveTo(event.x, event.y)
        break
      case 'drag-start':
        this.startDrag()
        break
      case 'drag-end':
        this.stopDrag(true)
        break
      case 'chat':
        this.chatOpen = event.open
        this.updateCapture()
        break
      case 'menu':
        this.menuOpen = event.open
        // 菜单打开即持焦：窗外点击夺焦触发 blur 关闭，Escape 也能送达渲染层
        if (event.open && this.isOpen() && !this.window!.isFocused()) this.window!.focus()
        this.updateCapture()
        break
      case 'hover':
        this.hoverInside = event.inside
        this.updateCapture()
        break
    }
  }

  /** 穿透开关：精灵悬停 / 聊天 / 菜单 / 拖拽任一命中就整窗收鼠标 */
  private updateCapture(): void {
    this.setCapture(this.hoverInside || this.chatOpen || this.menuOpen || !!this.drag)
  }

  private setCapture(capture: boolean): void {
    if (!this.isOpen() || capture === this.mouseCaptured) return
    this.mouseCaptured = capture
    // forward:true 让穿透态下渲染层仍收到 mousemove（Windows），enter/leave 与光标样式可反馈
    this.window!.setIgnoreMouseEvents(!capture, { forward: true })
  }

  // —— 主进程拖拽跟随：光标差分增量 setPosition，差分末速作抛掷初速 ——
  private startDrag(): void {
    if (!this.isOpen()) return
    const cursorStart = screen.getCursorScreenPoint()
    const [wx, wy] = this.window!.getPosition()
    this.drag = { cursorStart, winStart: { x: wx, y: wy }, history: [] }
    this.lastDisplayId = screen.getDisplayMatching(this.window!.getBounds()).id
    this.setCapture(true)
    const follow = () => {
      if (!this.drag || !this.isOpen()) return
      const cursor = screen.getCursorScreenPoint()
      // delta 同坐标系相减：混 DPI 多屏下绝对值可能错位，差分永远正确
      const x = this.drag.winStart.x + (cursor.x - this.drag.cursorStart.x)
      const y = this.drag.winStart.y + (cursor.y - this.drag.cursorStart.y)
      this.drag.history.push({ t: Date.now(), x, y })
      const cutoff = Date.now() - VELOCITY_WINDOW_MS * 3
      this.drag.history = this.drag.history.filter((item) => item.t >= cutoff)
      // setPosition 只收整数：不取整直接抛 conversion failure（hot.23 教训）
      this.window!.setPosition(Math.round(x), Math.round(y))
      this.push('pet:drag', { x, y } satisfies PetDragPosition)
      // 跨屏检测：所在显示器变化 → 推新快照（渲染层按新 workArea 换物理边界）
      const displayId = screen.getDisplayMatching(this.window!.getBounds()).id
      if (displayId !== this.lastDisplayId) {
        this.lastDisplayId = displayId
        this.deps.onDisplayChanged?.()
      }
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
    this.updateCapture()
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
}
