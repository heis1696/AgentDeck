// 小助理设置窗：独立 BrowserWindow，复用 renderer 入口 + #/pet-settings hash 路由（照 #/pet 先例）。
// 置顶 + 跳过任务栏（toolbar 型不进 Alt-Tab，与宠物窗同惯例）；已开则聚焦而非再开。
import { BrowserWindow, screen } from 'electron'
import path from 'node:path'
import { loadPetRenderer } from './pet-window'

const SETTINGS_WINDOW_SIZE = { width: 400, height: 540 }

export class PetSettingsWindowController {
  private window: BrowserWindow | null = null

  constructor(private readonly getMainWindow: () => BrowserWindow | null) {}

  isOpen(): boolean {
    return this.window !== null && !this.window.isDestroyed()
  }

  getWindow(): BrowserWindow | null {
    return this.isOpen() ? this.window : null
  }

  /** 打开或聚焦设置窗（右键菜单「设置」/主程序设置页按钮共用） */
  open(): void {
    if (this.isOpen()) {
      this.window!.show()
      this.window!.focus()
      return
    }
    const main = this.getMainWindow()
    const win = new BrowserWindow({
      width: SETTINGS_WINDOW_SIZE.width,
      height: SETTINGS_WINDOW_SIZE.height,
      minWidth: 340,
      minHeight: 420,
      title: '小助理设置',
      resizable: true,
      // 置顶但不占任务栏：跟随宠物窗的 toolbar 型惯例（win32 不进 Alt-Tab）
      alwaysOnTop: true,
      skipTaskbar: true,
      type: 'toolbar',
      autoHideMenuBar: true,
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
    })
    // 设置窗跟随主窗主题（渲染层 #/pet-settings 页自行读 settings）；位置贴主窗右侧
    if (main && !main.isDestroyed()) {
      const [mw, mh] = main.getSize()
      const [mx, my] = main.getPosition()
      const area = screen.getDisplayMatching(main.getBounds()).workArea
      const x = Math.min(Math.max(mx + mw + 12, area.x), area.x + area.width - SETTINGS_WINDOW_SIZE.width)
      const y = Math.min(Math.max(my, area.y), area.y + area.height - SETTINGS_WINDOW_SIZE.height)
      win.setPosition(x, y)
    }
    loadPetRenderer(win, '/pet-settings')
    win.show()
    this.window = win
  }

  close(): void {
    if (this.isOpen()) this.window!.destroy()
    this.window = null
  }
}
