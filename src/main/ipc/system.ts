import { BrowserWindow, dialog, ipcMain, Notification } from 'electron'
import fs from 'node:fs'
import { buildAnalytics } from '../analytics'
import { parseAnalyticsRange, parseContent, parseNotification, parseSettingsPatch } from '../ipc-validation'
import { probeRuntimes } from '../runtime'
import { zcodeDefaultPaths } from '../backends/zcode-config'
import { listWorktreeMetadata, pruneWorktrees } from '../git'
import type { IpcContext } from './context'

export function registerSystemIpc(ctx: IpcContext) {
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
    const results = []
    for (const repoDir of dirs) {
      results.push(await pruneWorktrees(repoDir, (owner) => {
        const task = ctx.store.get(owner)
        return task?.status === 'queued' || task?.status === 'running'
      }))
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
