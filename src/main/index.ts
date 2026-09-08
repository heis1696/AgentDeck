// AgentDeck 主进程入口
import { app, BrowserWindow, Notification } from 'electron'
import path from 'node:path'
import { TaskStore } from './store'
import { TaskRunner } from './runner'
import { IssueStore } from './issue-store'
import { GoalStore } from './goal-store'
import { GoalController } from './goal-controller'
import { AutomationStore } from './automation-store'
import { loadSettings, saveSettings } from './settings'
import { loadAgents, type Agent } from './agents'
import { loadPresets, type ApiPreset } from './presets'
import { createZcodeBackend } from './backends/zcode'
import { createClaudeBackend } from './backends/claude'
import { createCodexBackend } from './backends/codex'
import { createOpencodeBackend } from './backends/opencode'
import { createDshBackend } from './backends/dsh'
import type { AgentBackend } from './backends/types'
import type { AppSettings, Task, RunTrigger } from '../shared/types'
import { registerIpcHandlers, type CreateTaskInput } from './ipc/register'

let mainWindow: BrowserWindow | null = null
let settings: AppSettings
let store: TaskStore
let runner: TaskRunner
let issueStore: IssueStore
let goalStore: GoalStore
let goalController!: GoalController
let automationStore: AutomationStore
let automationTimer: NodeJS.Timeout | undefined
let agents: Agent[]
let presets: ApiPreset[]
const backends = new Map<string, AgentBackend>()

/** Sync the durable projection and notify issue/run consumers for one task. */
function publishIssueUpdate(task: Task | null) {
  if (!task || !issueStore || !store) return
  const parent = task.parentTaskId ? store.get(task.parentTaskId) : undefined
  issueStore.syncTask(task, parent)
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
  goalStore = new GoalStore(app.getPath('userData'))
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
  }), (task) => {
    publishIssueUpdate(task)
    goalController?.onTaskChanged(task)
  }, {
    send: (channel, payload) => mainWindow?.webContents.send(channel, payload),
    notify: (task, what, body) => {
      try {
        if (!Notification.isSupported()) return
        const notification = new Notification({ title: `任务${what}: ${task.title}`, body: (body || '').slice(0, 180) })
        notification.on('click', () => {
          mainWindow?.show()
          mainWindow?.focus()
          mainWindow?.webContents.send('task:focus', task.id)
        })
        notification.show()
      } catch {}
    }
  })
  runner.attachTeam(() => agents)
  presets = loadPresets()
  runner.attachPresets(() => presets)

  /** Single creation path for user issues, automation runs, and legacy tasks. */
  const createTask = (input: CreateTaskInput, trigger: RunTrigger = 'assignment') => {
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
      ...(input.continuesFrom ? { continuesFrom: input.continuesFrom } : {}),
      ...(input.goalId ? { goalId: input.goalId } : {}),
      ...(input.phaseIndex !== undefined ? { phaseIndex: input.phaseIndex } : {}),
      ...(input.titleAuto ? { titleAuto: true } : {})
    })
    if (!task.suppressIssue && !task.issueId) store.update(task.id, { issueId: `iss_${task.id}` })
    issueStore.sync(store.list())
    return store.get(task.id)!
  }

  // Goals reuse the existing TaskRunner/Issue projection.  The controller is
  // intentionally installed after createTask so every compatibility run uses
  // the same creation path and retains the existing task/JSONL contract.
  goalController = new GoalController(goalStore, {
    createTask: (input) => createTask({
      title: input.title,
      prompt: input.prompt,
      workdir: input.workdir,
      backend: input.backend,
      agentId: input.agentId,
      issueId: input.issueId,
      goalId: input.goalId,
      phaseIndex: input.phaseIndex,
      startNow: input.startNow
    }, input.trigger),
    enqueueTask: (task) => runner.enqueue(task),
    startTask: (task) => {
      store.update(task.id, { parked: undefined })
      return store.get(task.id)!
    },
    cancelTask: (taskId) => runner.cancel(taskId),
    listTasks: () => store.list()
  })
  goalController.subscribe((goal) => mainWindow?.webContents.send('goals:updated', goal))
  // An active goal must never resume silently after an application restart.
  goalController.recover(store.list())

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
      continuesFrom: sourceTaskId,
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
    return store.get(task.id) ?? null
  }
  const automationTick = () => {
    const now = Date.now()
    for (const automation of automationStore.list()) if (automation.enabled && (automation.nextRunAt ?? now) <= now) runAutomation(automation.id)
  }
  automationTimer = setInterval(automationTick, 15_000)
  automationTick()

  registerIpcHandlers({
    getWindow: () => mainWindow,
    get settings() { return settings },
    setSettings: (next) => { settings = saveSettings(next) },
    store,
    runner,
    issueStore,
    goalController,
    automationStore,
    backends,
    zcode,
    get agents() { return agents },
    set agents(value) { agents = value },
    get presets() { return presets },
    set presets(value) { presets = value },
    createTask,
    runAutomation,
    publishIssueUpdate
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', async () => {
  if (automationTimer) clearInterval(automationTimer)
  await runner?.shutdown()
  store?.flush()
})

app.on('window-all-closed', () => {
  app.quit()
})
