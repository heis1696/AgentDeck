import { BrowserWindow, dialog, ipcMain, Notification } from 'electron'
import fs from 'node:fs'
import { buildAnalytics } from '../analytics'
import { parseAnalyticsRange, parseContent, parseNotification, parseSettingsPatch } from '../ipc-validation'
import { probeRuntimes } from '../runtime'
import { zcodeDefaultPaths } from '../backends/zcode-config'
import { listWorktreeMetadata, pruneWorktrees, sameWorktreePath, shouldKeepTaskWorktree, uniquePathsByKey } from '../git'
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
    // 手动清扫目录集合与启动清扫同源折叠去重（uniquePathsByKey）：同一仓库的别名写法
    // 只扫一次，不并发重扫同一现场；保留首个写法做真实文件系统调用
    const dirs = uniquePathsByKey(ctx.store.list().map((task) => task.worktree?.repoDir || task.workdir))
    const maxAgeMs = ctx.settings.worktreeMaxAgeDays * 24 * 60 * 60 * 1000
    const results = []
    for (const repoDir of dirs) {
      const report = await pruneWorktrees(repoDir, (owner, worktree) => shouldKeepTaskWorktree(ctx.store.list(), repoDir, owner, worktree), {
        maxAgeMs,
        claimWorktree: (owner, merge) => {
          const claim = ctx.store.claimWorktreeCleanup(repoDir, owner, merge)
          return claim ? { release: () => { try { ctx.store.releaseGitOperation(claim) } catch {} } } : undefined
        }
      })
      results.push(report)
      // 清扫失败不再静默：owner 任务在册 → 时间线事件（目录名+原因），连续多轮失败可见
      for (const failure of report.failed) ctx.store.noteWorktreeCleanupFailure(repoDir, failure)
      for (const metadata of listWorktreeMetadata(repoDir)) {
        // 任务-元数据配对按别名折叠判定（与 git.ts 路径键同源）：任务登记与 sidecar
        // 落盘写法不同（大小写/盘符别名）时，字面量 === 配不上对，清扫状态同步漏更新
        const task = ctx.store.list().find((item) => !!item.worktree && sameWorktreePath(item.worktree.path, metadata.path))
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
