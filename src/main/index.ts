// AgentDeck 主进程入口
import { app, BrowserWindow, ipcMain, dialog, Notification } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { TaskStore } from './store'
import { TaskRunner } from './runner'
import { loadSettings, saveSettings } from './settings'
import { loadAgents, saveAgents, newAgentId, type Agent } from './agents'
import { createZcodeBackend, findZcodeBundle, ensureZcodeCliConfig, zcodeDefaultPaths } from './backends/zcode'
import { createClaudeBackend } from './backends/claude'
import { createCodexBackend } from './backends/codex'
import { createOpencodeBackend } from './backends/opencode'
import { createDshBackend } from './backends/dsh'
import { probeCli } from './backends/cli-locator'
import type { AgentBackend } from './backends/types'
import type { AppSettings } from '../shared/types'

let mainWindow: BrowserWindow | null = null
let settings: AppSettings
let store: TaskStore
let runner: TaskRunner
let agents: Agent[]
const backends = new Map<string, AgentBackend>()

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 860,
    minHeight: 560,
    autoHideMenuBar: true,
    backgroundColor: '#0f1115',
    icon: path.join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  mainWindow.on('closed', () => (mainWindow = null))
  // 开发环境由 electron-vite 注入 ELECTRON_RENDERER_URL
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  settings = loadSettings()
  store = new TaskStore(app.getPath('userData'))

  const zcode = createZcodeBackend(() => ({ nodePath: settings.nodePath, zcodePath: settings.zcodePath }))
  backends.set(zcode.id, zcode)
  backends.set('claude', createClaudeBackend())
  backends.set('codex', createCodexBackend())
  backends.set('opencode', createOpencodeBackend())
  backends.set('dsh', createDshBackend(() => ({ dshPath: settings.dshPath })))
  agents = loadAgents()

  runner = new TaskRunner(store, backends, () => ({
    concurrency: settings.concurrency,
    mode: settings.mode,
    notify: settings.notifyOnDone,
    workerConcurrency: settings.workerConcurrency
  }))
  runner.attachTeam(() => agents)

  // ---- IPC ----
  ipcMain.handle('tasks:list', () => store.list())
  ipcMain.handle('tasks:get', (_e, id) => store.get(id) ?? null)
  ipcMain.handle('tasks:events', (_e, id: string, afterSeq: number) => store.readEvents(id, afterSeq))
  ipcMain.handle('tasks:create', (_e, input: { title: string; prompt: string; workdir: string; backend?: string; agentId?: string; handoff?: string; startNow?: boolean }) => {
    // agentId 优先；backend 兜底为 zcode
    const agent = agents.find((a) => a.id === input.agentId)
    const backend = agent?.backend ?? input.backend ?? 'zcode'
    const task = store.create({
      title: input.title.trim() || '未命名任务',
      prompt: input.prompt,
      workdir: input.workdir || '',
      backend,
      ...(agent ? { agentId: agent.id } : {}),
      ...(input.handoff?.trim() ? { handoff: input.handoff.trim() } : {}),
      ...(input.startNow === false ? { parked: true } : {})
    })
    if (input.startNow === false) {
      mainWindow?.webContents.send('task:updated', store.get(task.id))
      return task
    }
    runner.enqueue(task)
    return task
  })
  // 暂不启动的任务：手动开始
  ipcMain.handle('tasks:start', (_e, id: string) => {
    const t = store.get(id)
    if (!t) return { ok: false, error: '任务不存在' }
    if (t.status !== 'queued' || !t.parked) return { ok: false, error: '任务不在待启动状态' }
    store.update(id, { parked: undefined })
    runner.enqueue(store.get(id)!)
    return { ok: true }
  })

  // ---- Agent 队伍 ----
  ipcMain.handle('agents:list', () => agents)
  ipcMain.handle('agents:save', (_e, list: Agent[]) => {
    agents = list.filter((a) => a?.name && backends.has(a.backend))
    return saveAgents(agents)
  })
  ipcMain.handle('agents:new-id', () => newAgentId())
  ipcMain.handle('agents:probe', async () => {
    const out: Record<string, { ok: boolean; detail: string }> = {}
    // 并行探测，单个完成后立刻推送 UI（避免慢后端拖住整体反馈）
    await Promise.all(
      [...backends].map(async ([id, b]) => {
        let r: { ok: boolean; detail: string }
        try {
          r = await Promise.race([
            b.probe(),
            new Promise<{ ok: boolean; detail: string }>((res) =>
              setTimeout(() => res({ ok: false, detail: '探测超时（20s）' }), 20000)
            )
          ])
        } catch (e) {
          r = { ok: false, detail: `探测失败: ${e instanceof Error ? e.message : String(e)}` }
        }
        out[id] = r
        mainWindow?.webContents.send('agents:probe-result', { id, result: r })
      })
    )
    return out
  })
  ipcMain.handle('tasks:cancel', (_e, id) => runner.cancel(id))
  ipcMain.handle('tasks:followup', (_e, id, content) => runner.followUp(id, content))
  ipcMain.handle('tasks:permission-respond', (_e, requestId: string, optionId: string, decision: string) =>
    runner.resolvePermission(requestId, optionId, decision === 'deny' ? 'deny' : 'allow')
  )
  ipcMain.handle('tasks:delete', (_e, id) => {
    const t = store.get(id)
    if (!t) return { ok: false, error: '任务不存在' }
    if (t.status === 'running') return { ok: false, error: '请先取消运行中的任务' }
    // 级联删除委派子任务（父任务不在运行中时子任务不应仍在跑，若有则拒绝）
    const kids = store.list().filter((x) => x.parentTaskId === id)
    if (kids.some((k) => k.status === 'running')) {
      return { ok: false, error: '请先取消运行中的子任务' }
    }
    const deleted = [id, ...kids.map((k) => k.id)]
    for (const d of deleted) store.delete(d)
    for (const d of deleted) mainWindow?.webContents.send('task:deleted', d)
    return { ok: true }
  })
  ipcMain.handle('tasks:retry', (_e, id) => {
    const t = store.get(id)
    if (!t) return { ok: false, error: '任务不存在' }
    if (t.status === 'running' || t.status === 'queued') return { ok: false, error: '任务已在队列/运行中' }
    store.update(id, { status: 'queued', error: undefined, failure: undefined, result: undefined, sessionId: undefined, attempt: undefined })
    runner.enqueue(store.get(id)!)
    return { ok: true }
  })

  ipcMain.handle('settings:get', () => settings)
  ipcMain.handle('settings:set', (_e, patch: Partial<AppSettings>) => {
    settings = { ...settings, ...patch }
    return saveSettings(settings)
  })
  ipcMain.handle('settings:probe', async () => {
    const r = await zcode.probe()
    return { ...r, searched: zcodeDefaultPaths() }
  })
  ipcMain.handle('dialog:pick-dir', async () => {
    const r = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'] })
    return r.canceled ? '' : r.filePaths[0] ?? ''
  })
  ipcMain.handle('shell:open', async (_e, target: string) => {
    const { shell } = await import('electron')
    // 只放行本地路径与 http(s)
    if (/^https?:\/\//i.test(target)) return shell.openExternal(target)
    if (fs.existsSync(target)) return shell.openPath(target)
    return Promise.reject(new Error('不允许的目标'))
  })

  // 系统通知（渲染层触发）
  ipcMain.on('notify', (_e, { title, body }) => {
    if (Notification.isSupported()) new Notification({ title, body }).show()
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', async () => {
  await runner?.shutdown()
})

app.on('window-all-closed', () => {
  app.quit()
})
