import { BrowserWindow, dialog, ipcMain, Notification, screen } from 'electron'
import fs from 'node:fs'
import { buildAnalytics } from '../analytics'
import { parseAnalyticsRange, parseContent, parseNotification, parseSettingsPatch } from '../ipc-validation'
import { probeRuntimes } from '../runtime'
import { zcodeDefaultPaths } from '../backends/zcode-config'
import { listWorktreeMetadata, pruneWorktrees } from '../git'
import type { IpcContext } from './context'

export function registerSystemIpc(ctx: IpcContext) {
  // SideDock 延展窗口用：dx>0 向右加宽（顶左锚定），dx<0 收回；屏宽不足自动夹住。
  // 渲染层约定见 ui/SideDock.tsx —— 打开分页延展、全关收回、拖分割线同步增减。
  ipcMain.handle('window:resizeBy', (_e, input: unknown) => {
    const dx = typeof input === 'number' && Number.isFinite(input) ? Math.round(input) : 0
    if (!dx) return { ok: true }
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    if (!win) return { ok: false }
    try {
      if (win.isMaximized() || win.isFullScreen()) return { ok: false, reason: 'maximized' }
      const bounds = win.getBounds()
      const workArea = screen.getDisplayMatching(bounds).workArea
      const maxWidth = Math.max(540, workArea.x + workArea.width - bounds.x)
      const nextWidth = Math.min(maxWidth, Math.max(480, bounds.width + dx))
      win.setBounds({ x: bounds.x, y: bounds.y, width: nextWidth, height: bounds.height })
      return { ok: true, width: nextWidth }
    } catch {
      return { ok: false }
    }
  })
  ipcMain.handle('sidecar:status', () => {
    const snapshot = ctx.sidecar?.snapshot
    if (!snapshot) return null
    // The renderer needs lifecycle state, never the bearer token.
    const { token: _token, ...publicSnapshot } = snapshot
    return publicSnapshot
  })
  ipcMain.handle('sidecar:sync', async () => {
    if (ctx.sidecar) return ctx.sidecar.sync()
    return { tasks: ctx.store.list(), issues: ctx.issueStore.list(), goals: ctx.goalController.list(), generatedAt: Date.now() }
  })
  ipcMain.handle('sidecar:reconnect', async () => {
    if (!ctx.sidecar) return null
    const snapshot = await ctx.sidecar.reconnect()
    try { await ctx.sidecar.recoverOrphans() } catch {}
    const { token: _token, ...publicSnapshot } = snapshot
    return publicSnapshot
  })
  ipcMain.handle('worktrees:prune', async () => {
    const dirs = new Set(ctx.store.list().map((task) => task.worktree?.repoDir || task.workdir).filter(Boolean))
    const maxAgeMs = ctx.settings.worktreeMaxAgeDays * 24 * 60 * 60 * 1000
    const results = []
    for (const repoDir of dirs) {
      results.push(await pruneWorktrees(repoDir, (owner) => {
        const task = ctx.store.get(owner)
        return task?.status === 'queued' || task?.status === 'running'
      }, { maxAgeMs }))
      for (const metadata of listWorktreeMetadata(repoDir)) {
        const task = ctx.store.list().find((item) => item.worktree?.path === metadata.path)
        if (task && task.worktree && task.worktree.cleanupStatus !== metadata.cleanupStatus) {
          ctx.store.update(task.id, { worktree: metadata })
        }
      }
    }
    return {
      scanned: results.reduce((sum, item) => sum + item.scanned, 0),
      removed: results.flatMap((item) => item.removed),
      retained: results.flatMap((item) => item.retained),
      failed: results.flatMap((item) => item.failed)
    }
  })
  ipcMain.handle('runtime:snapshot', async () => probeRuntimes(ctx.backends.values(), ctx.store.list()))
  ipcMain.handle('analytics:summary', (_e, input: unknown) => {
    const range = parseAnalyticsRange(input)
    return buildAnalytics(ctx.store.list(), ctx.agents, range.since, range.until)
  })
  ipcMain.handle('settings:get', () => ctx.settings)
  ipcMain.handle('settings:set', (_e, patch: unknown) => {
    const saved = { ...ctx.settings, ...parseSettingsPatch(patch) }
    ctx.setSettings(saved)
    BrowserWindow.getAllWindows().forEach((window) => window.webContents.send('settings:updated', saved))
    return saved
  })
  ipcMain.handle('settings:probe', async () => ({ ...(await ctx.zcode.probe()), searched: zcodeDefaultPaths() }))
  ipcMain.handle('dialog:pick-dir', async () => {
    const window = ctx.getWindow()
    if (!window) return ''
    const result = await dialog.showOpenDialog(window, { properties: ['openDirectory'] })
    return result.canceled ? '' : result.filePaths[0] ?? ''
  })
  ipcMain.handle('shell:open', async (_e, target: unknown) => {
    const value = parseContent(target, 'target')
    const { shell } = await import('electron')
    if (/^https?:\/\//i.test(value)) return shell.openExternal(value)
    if (fs.existsSync(value)) return shell.openPath(value)
    throw new Error('不允许的目标')
  })
  ipcMain.on('notify', (_e, value: unknown) => {
    const { title, body } = parseNotification(value)
    if (Notification.isSupported()) new Notification({ title, body }).show()
  })
}
