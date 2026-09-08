import { BrowserWindow, dialog, ipcMain, Notification } from 'electron'
import fs from 'node:fs'
import { buildAnalytics } from '../analytics'
import { parseAnalyticsRange, parseContent, parseNotification, parseSettingsPatch } from '../ipc-validation'
import { probeRuntimes } from '../runtime'
import { zcodeDefaultPaths } from '../backends/zcode-config'
import type { IpcContext } from './context'

export function registerSystemIpc(ctx: IpcContext) {
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
