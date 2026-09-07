// AgentDeck 主进程入口
import { app, BrowserWindow, ipcMain, dialog, Notification } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { TaskStore } from './store'
import { TaskRunner } from './runner'
import { IssueStore } from './issue-store'
import { AutomationStore } from './automation-store'
import { loadSettings, saveSettings } from './settings'
import { loadAgents, saveAgents, newAgentId, type Agent } from './agents'
import { loadPresets, savePresets, newPresetId, fetchPresetModels, type ApiPreset } from './presets'
import { createZcodeBackend, findZcodeBundle, ensureZcodeCliConfig, zcodeDefaultPaths, listZcodeModels } from './backends/zcode'
import { createClaudeBackend } from './backends/claude'
import { createCodexBackend } from './backends/codex'
import { createOpencodeBackend } from './backends/opencode'
import { createDshBackend } from './backends/dsh'
import { probeCli } from './backends/cli-locator'
import { buildAnalytics } from './analytics'
import { aggregateUsage } from './usage'
import { probeRuntimes } from './runtime'
import type { AgentBackend } from './backends/types'
import type { AppSettings, Task, RunTrigger } from '../shared/types'
import { validateMove } from '../shared/taskflow'

let mainWindow: BrowserWindow | null = null
let settings: AppSettings
let store: TaskStore
let runner: TaskRunner
let issueStore: IssueStore
let automationStore: AutomationStore
let automationTimer: NodeJS.Timeout | undefined
let agents: Agent[]
let presets: ApiPreset[]
const backends = new Map<string, AgentBackend>()

/** Sync the durable projection and notify issue/run consumers for one task. */
function publishIssueUpdate(task: Task | null) {
  if (!task || !issueStore || !store) return
  issueStore.sync(store.list())
  const issueId = task.issueId ?? `iss_${task.id}`
  const issue = issueStore.get(issueId)
  const run = issue ? issueStore.runForTask(task.id) : undefined
  mainWindow?.webContents.send('issues:updated', {
    taskId: task.id,
    issueId: issue?.id ?? issueId,
    issue: issue ?? null,
    run: run ?? null
  })
}

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
  issueStore = new IssueStore(app.getPath('userData'))
  issueStore.sync(store.list())
  automationStore = new AutomationStore(app.getPath('userData'))

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
  }), (task) => publishIssueUpdate(task))
  runner.attachTeam(() => agents)
  presets = loadPresets()
  runner.attachPresets(() => presets)

  type CreateInput = { title: string; prompt: string; workdir: string; backend?: string; agentId?: string; handoff?: string; startNow?: boolean; suppressIssue?: boolean; issueId?: string; titleAuto?: boolean }
  /** Single creation path for user issues, automation runs, and legacy tasks. */
  const createTask = (input: CreateInput, trigger: RunTrigger = 'assignment') => {
    const agent = agents.find((a) => a.id === input.agentId)
    const backend = agent?.backend ?? input.backend ?? 'zcode'
    const task = store.create({
      title: input.title.trim() || '未命名任务',
      prompt: input.prompt.trim(),
      workdir: input.workdir || '',
      backend,
      trigger,
      ...(agent ? { agentId: agent.id } : {}),
      ...(input.handoff?.trim() ? { handoff: input.handoff.trim() } : {}),
      ...(input.startNow === false ? { parked: true } : {}),
      ...(input.suppressIssue ? { suppressIssue: true } : {}),
      ...(input.issueId ? { issueId: input.issueId } : {}),
      ...(input.titleAuto ? { titleAuto: true } : {})
    })
    if (!task.suppressIssue && !task.issueId) store.update(task.id, { issueId: `iss_${task.id}` })
    issueStore.sync(store.list())
    return store.get(task.id)!
  }

  // 阶段接力（<continue>）：同一 Issue 上创建后继执行——新会话硬切，简报为唯一携带物
  runner.attachContinue(({ sourceTaskId, issueId, brief, start }) => {
    const source = store.get(sourceTaskId)
    if (!source) return null
    const title = brief.split(/\r?\n/).map((l) => l.trim()).find(Boolean)?.slice(0, 40) ?? `${source.title}（下一阶段）`
    const task = createTask({
      title: `▶ ${title}`,
      prompt: brief,
      workdir: source.workdir,
      agentId: source.agentId,
      backend: source.backend,
      issueId,
      startNow: start !== 'parked'
    }, 'handoff')
    if (start !== 'parked') runner.enqueue(store.get(task.id)!)
    else publishIssueUpdate(store.get(task.id)!)
    return store.get(task.id)!
  })

  const runAutomation = (id: string) => {
    const automation = automationStore.get(id)
    if (!automation || !automation.enabled || !automation.prompt.trim()) return null
    const agent = agents.find((item) => item.id === automation.agentId)
    const task = createTask({ title: automation.name, prompt: automation.prompt, workdir: automation.workdir, backend: agent?.backend, ...(agent ? { agentId: agent.id } : {}), ...(automation.output === 'run_only' ? { suppressIssue: true } : {}) }, 'autopilot')
    automationStore.markRun(id)
    runner.enqueue(store.get(task.id)!)
    return store.get(task.id)
  }
  const automationTick = () => {
    const now = Date.now()
    for (const automation of automationStore.list()) if (automation.enabled && (automation.nextRunAt ?? now) <= now) runAutomation(automation.id)
  }
  automationTimer = setInterval(automationTick, 15_000)
  automationTick()

  // ---- IPC ----
  ipcMain.handle('tasks:list', () => store.list())
  ipcMain.handle('tasks:get', (_e, id) => store.get(id) ?? null)
  ipcMain.handle('tasks:events', (_e, id: string, afterSeq: number) => store.readEvents(id, afterSeq))
  ipcMain.handle('tasks:create', (_e, input: CreateInput & { trigger?: RunTrigger }) => {
    const task = createTask(input, input.trigger ?? 'assignment')
    if (input.startNow === false) {
      publishIssueUpdate(store.get(task.id)!)
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
    issueStore.sync(store.list())
    return { ok: true }
  })

  // ---- Issue / Run projection (the product model for new UI) ----
  ipcMain.handle('issues:list', () => { issueStore.sync(store.list()); return issueStore.list() })
  ipcMain.handle('issues:get', (_e, id: string) => { issueStore.sync(store.list()); return issueStore.get(id) ?? null })
  ipcMain.handle('issues:create', (_e, input: { title: string; description: string; workdir: string; agentId?: string; backend?: string; handoff?: string; startNow?: boolean; trigger?: RunTrigger; titleAuto?: boolean }) => {
    const task = createTask({ title: input.title, prompt: input.description, workdir: input.workdir, agentId: input.agentId, backend: input.backend, handoff: input.handoff, startNow: input.startNow, titleAuto: input.titleAuto }, input.trigger ?? 'assignment')
    if (input.startNow === false) publishIssueUpdate(task)
    else runner.enqueue(task)
    const issue = issueStore.get(task.issueId ?? `iss_${task.id}`)
    if (!issue) throw new Error('Issue projection failed')
    return issue
  })
  ipcMain.handle('issues:runs', (_e, id: string) => { issueStore.sync(store.list()); const issue = issueStore.get(id); return issue ? issueStore.runs(issue.id) : [] })
  ipcMain.handle('issues:comments', (_e, id: string) => { issueStore.sync(store.list()); const issue = issueStore.get(id); return issue ? issueStore.comments(issue.id) : [] })
  ipcMain.handle('issues:update', (_e, id: string, patch: { priority?: import('../shared/types').IssuePriority; labels?: string[]; dueDate?: number; status?: import('../shared/types').IssueStatus }) => {
    issueStore.sync(store.list())
    const issue = patch.status ? issueStore.updateWorkflow(id, patch.status) : issueStore.updateMetadata(id, patch)
    if (issue) mainWindow?.webContents.send('issues:updated', { taskId: issue.taskId, issueId: issue.id, issue, run: issueStore.runForTask(issue.taskId) ?? null })
    return issue
  })
  ipcMain.handle('issues:add-comment', (_e, id: string, content: string) => {
    issueStore.sync(store.list())
    const issue = issueStore.get(id)
    const comment = issue ? issueStore.addComment(issue.id, content) : null
    // A direct @agent mention is a new Run on the same Issue. Keep this
    // deliberately small: the existing runner owns prompt construction and
    // session lifecycle, while the comment remains the human request.
    let executionTask: Task | undefined
    if (issue && comment) {
      const mention = content.match(/@([^\s@]+)/)?.[1]?.replace(/[),.;:!?]+$/, '').toLowerCase()
      const agent = mention ? agents.find((item) => item.name.toLowerCase() === mention || item.id.toLowerCase() === mention) : undefined
      if (agent) {
        executionTask = createTask({ title: issue.title, prompt: content, workdir: store.get(issue.taskId)?.workdir ?? '', agentId: agent.id, backend: agent.backend, startNow: true, issueId: issue.id }, 'mention')
        issueStore.sync(store.list())
        runner.enqueue(store.get(executionTask.id)!)
      }
    }
    if (issue && comment) mainWindow?.webContents.send('issues:updated', { taskId: executionTask?.id ?? issue.taskId, issueId: issue.id, issue, run: executionTask ? issueStore.runForTask(executionTask.id) ?? null : issueStore.runForTask(issue.taskId) ?? null })
    return comment
  })
  ipcMain.handle('issues:notifications', (_e, unreadOnly = false) => { issueStore.sync(store.list()); return issueStore.notifications(!!unreadOnly) })
  ipcMain.handle('issues:notification-read', (_e, id: string) => {
    const issueId = issueStore.notificationIssueId(id)
    const ok = issueStore.markNotificationRead(id)
    const issue = issueId ? issueStore.get(issueId) : undefined
    if (ok && issue) mainWindow?.webContents.send('issues:updated', { taskId: issue.taskId, issueId: issue.id, issue, run: issueStore.runForTask(issue.taskId) ?? null })
    return { ok }
  })

  // ---- Local autopilot schedules ----
  ipcMain.handle('automations:list', () => automationStore.list())
  ipcMain.handle('automations:create', (_e, input: { name: string; prompt: string; workdir: string; agentId?: string; scheduleMinutes: number; output: 'issue' | 'run_only' }) => automationStore.create(input))
  ipcMain.handle('automations:update', (_e, id: string, patch: Partial<import('../shared/types').Automation>) => automationStore.update(id, patch))
  ipcMain.handle('automations:delete', (_e, id: string) => ({ ok: automationStore.remove(id) }))
  ipcMain.handle('automations:run-now', (_e, id: string) => {
    const task = runAutomation(id)
    return task ? { ok: true, task } : { ok: false, error: 'Automation is disabled or incomplete' }
  })

  // ---- Agent 队伍 ----
  ipcMain.handle('agents:list', () => agents)
  ipcMain.handle('agents:save', (_e, list: Agent[]) => {
    agents = list.filter((a) => a?.name && backends.has(a.backend))
    return saveAgents(agents)
  })
  ipcMain.handle('agents:new-id', () => newAgentId())
  // ---- API 预设（连接档案；agent 引用后按会话内存注入，零全局切换） ----
  ipcMain.handle('presets:list', () => presets)
  ipcMain.handle('presets:save', (_e, list: ApiPreset[]) => {
    presets = savePresets(list)
    return presets
  })
  ipcMain.handle('presets:new-id', () => newPresetId())
  // 从预设在线拉取模型目录（OpenAI/Anthropic 风格自适应）
  ipcMain.handle('presets:models', async (_e, presetId: string) => {
    const preset = presets.find((p) => p.id === presetId)
    if (!preset) throw new Error('预设不存在')
    const models = await fetchPresetModels(preset)
    return { backend: preset.backend, source: 'catalog', models } as const
  })
  // 模型目录：zcode 有本地真目录（cli config），其余平台自由填写 + 常用预设
  ipcMain.handle('agents:models', (_e, backendId: string) => {
    if (backendId === 'zcode') {
      const { models, defaultModel } = listZcodeModels()
      if (models.length) return { backend: backendId, source: 'catalog', default: defaultModel, models }
    }
    const presets: Record<string, string[]> = { claude: ['sonnet', 'opus', 'haiku'], codex: ['gpt-5.5', 'gpt-5.2-codex'], opencode: [], dsh: [] }
    return { backend: backendId, source: 'freeform', models: presets[backendId] ?? [] }
  })
  ipcMain.handle('tasks:cancel', (_e, id) => { const result = runner.cancel(id); issueStore.sync(store.list()); return result })
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
    issueStore.sync(store.list())
    for (const d of deleted) mainWindow?.webContents.send('task:deleted', d)
    return { ok: true }
  })
  ipcMain.handle('tasks:retry', (_e, id) => {
    const t = store.get(id)
    if (!t) return { ok: false, error: '任务不存在' }
    if (t.status === 'running' || t.status === 'queued') return { ok: false, error: '任务已在队列/运行中' }
    // 关掉可能还挂着的前一会话：重跑要开新会话，旧会话若还在跑会继续往同一任务日志交错写事件
    runner.closeSession(id)
    store.update(id, { status: 'queued', error: undefined, failure: undefined, result: undefined, sessionId: undefined, attempt: undefined, runId: undefined })
    runner.enqueue(store.get(id)!)
    issueStore.sync(store.list())
    return { ok: true }
  })
  // 消息回退：截断 toSeq 之后的事件记录，并按剩余事件重算 result/usage（不影响后端会话上下文）
  ipcMain.handle('tasks:rewind', (_e, id: string, toSeq: number) => {
    const t = store.get(id)
    if (!t) return { ok: false, error: '任务不存在' }
    if (t.status === 'running' || t.status === 'queued') return { ok: false, error: '任务运行中，不能回退' }
    if (!store.truncateEvents(id, toSeq)) return { ok: false, error: '回退失败' }
    const rest = store.readEvents(id)
    const finalEv = [...rest].reverse().find((ev) => ev.kind === 'final' && ev.text)
    store.update(id, { result: finalEv?.text, usage: aggregateUsage(rest) })
    runner.pushTask(id)
    // 回退是删事件：渲染层靠增量推送拿不到通知，广播让所有窗口整段重拉
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('task:events-invalidated', { taskId: id }))
    return { ok: true }
  })
  // 任务重命名（标题）
  ipcMain.handle('tasks:rename', (_e, id: string, title: string) => {
    const name = (title ?? '').trim()
    if (!name) return null
    store.update(id, { title: name.slice(0, 120), titleAuto: false })
    const next = store.get(id)
    if (next) runner.pushTask(id)
    return next ?? null
  })
  ipcMain.handle('runtime:snapshot', async () => probeRuntimes(backends.values(), store.list()))
  ipcMain.handle('analytics:summary', (_e, input?: { since?: number; until?: number }) =>
    buildAnalytics(store.list(), agents, input?.since, input?.until))
  ipcMain.handle('tasks:move', (_e, id: string, status: Task['status']) => {
    const t = store.get(id)
    if (!t) return { ok: false, error: '任务不存在' }
    const transition = validateMove(t.status, status)
    if (!transition.ok) return transition
    if (t.status === status) return { ok: true }
    if (t.status === 'running') return { ok: false, error: '请先取消运行中的任务' }
    if (status === 'running') {
      if (t.status !== 'queued') return { ok: false, error: '只有排队中的任务可以启动' }
      store.update(id, { parked: undefined })
      runner.enqueue(store.get(id)!)
      issueStore.sync(store.list())
    } else if (status === 'queued') {
      store.update(id, { status: 'queued', parked: true, error: undefined, failure: undefined, result: undefined, endedAt: undefined })
      publishIssueUpdate(store.get(id)!)
      mainWindow?.webContents.send('task:updated', store.get(id))
    } else {
      store.update(id, { status, parked: undefined, endedAt: Date.now() })
      publishIssueUpdate(store.get(id)!)
      mainWindow?.webContents.send('task:updated', store.get(id))
    }
    issueStore.sync(store.list())
    return { ok: true }
  })

  ipcMain.handle('settings:get', () => settings)
  ipcMain.handle('settings:set', (_e, patch: Partial<AppSettings>) => {
    settings = { ...settings, ...patch }
    const saved = saveSettings(settings)
    // 广播到所有窗口：App 与设置页各持一份 useSettings 实例，靠事件同步（否则主题切换等不生效）
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('settings:updated', saved))
    return saved
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
  if (automationTimer) clearInterval(automationTimer)
  await runner?.shutdown()
})

app.on('window-all-closed', () => {
  app.quit()
})
