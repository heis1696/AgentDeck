// preload：向渲染层暴露类型安全的 IPC 桥
import { contextBridge, ipcRenderer } from 'electron'
import type { Task, TaskEvent, AppSettings, Issue, Run, Comment, Notification, Automation, RuntimeSnapshot, AnalyticsSummary, IssuePriority, IssueStatus, RunTrigger } from '../shared/types'
import type { PermissionRequest } from '../main/backends/types'

interface AgentInfo {
  id: string
  name: string
  backend: string
  model?: string
  note?: string
  color: string
  role?: string
  systemPrompt?: string
  subordinates?: string[]
}

/** 模型目录（agents:models 返回）：zcode 有本地 catalog，其余平台 freeform */
interface AgentModelCatalog {
  backend: string
  source: 'catalog' | 'freeform'
  default?: string
  models: string[]
}

const api = {
  tasks: {
    list: (): Promise<Task[]> => ipcRenderer.invoke('tasks:list'),
    get: (id: string): Promise<Task | null> => ipcRenderer.invoke('tasks:get', id),
    events: (id: string, afterSeq = 0): Promise<TaskEvent[]> => ipcRenderer.invoke('tasks:events', id, afterSeq),
    create: (input: { title: string; prompt: string; workdir: string; backend?: string; agentId?: string; handoff?: string; startNow?: boolean; trigger?: RunTrigger }) =>
      ipcRenderer.invoke('tasks:create', input) as Promise<Task>,
    cancel: (id: string) => ipcRenderer.invoke('tasks:cancel', id) as Promise<{ ok: boolean; error?: string }>,
    followUp: (id: string, content: string) =>
      ipcRenderer.invoke('tasks:followup', id, content) as Promise<{ ok: boolean; error?: string }>,
    delete: (id: string) => ipcRenderer.invoke('tasks:delete', id) as Promise<{ ok: boolean; error?: string }>,
    retry: (id: string) => ipcRenderer.invoke('tasks:retry', id) as Promise<{ ok: boolean; error?: string }>,
    move: (id: string, status: Task['status']) => ipcRenderer.invoke('tasks:move', id, status) as Promise<{ ok: boolean; error?: string }>,
    start: (id: string) => ipcRenderer.invoke('tasks:start', id) as Promise<{ ok: boolean; error?: string }>,
    rewind: (id: string, toSeq: number): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('tasks:rewind', id, toSeq),
    rename: (id: string, title: string): Promise<Task | null> =>
      ipcRenderer.invoke('tasks:rename', id, title),
    onEventsInvalidated: (cb: (taskId: string) => void) => {
      const h = (_e: unknown, payload: { taskId: string }) => cb(payload.taskId)
      ipcRenderer.on('task:events-invalidated', h)
      return () => ipcRenderer.removeListener('task:events-invalidated', h)
    },
    onUpdated: (cb: (t: Task) => void) => {
      const h = (_e: unknown, t: Task) => cb(t)
      ipcRenderer.on('task:updated', h)
      return () => ipcRenderer.removeListener('task:updated', h)
    },
    onDeleted: (cb: (id: string) => void) => {
      const h = (_e: unknown, id: string) => cb(id)
      ipcRenderer.on('task:deleted', h)
      return () => ipcRenderer.removeListener('task:deleted', h)
    },
    onFocusTask: (cb: (id: string) => void) => {
      const h = (_e: unknown, id: string) => cb(id)
      ipcRenderer.on('task:focus', h)
      return () => ipcRenderer.removeListener('task:focus', h)
    },
    onEvent: (cb: (taskId: string, e: TaskEvent) => void) => {
      const h = (_e: unknown, payload: { taskId: string; event: TaskEvent }) => cb(payload.taskId, payload.event)
      ipcRenderer.on('task:event', h)
      return () => ipcRenderer.removeListener('task:event', h)
    },
    onPermission: (cb: (taskId: string, req: PermissionRequest) => void) => {
      const h = (_e: unknown, payload: { taskId: string; request: PermissionRequest }) => cb(payload.taskId, payload.request)
      ipcRenderer.on('task:permission', h)
      return () => ipcRenderer.removeListener('task:permission', h)
    },
    respondPermission: (requestId: string | number, optionId: string, decision: 'allow' | 'deny') =>
      ipcRenderer.invoke('tasks:permission-respond', String(requestId), optionId, decision) as Promise<{ ok: boolean; error?: string }>
  },
  issues: {
    list: (): Promise<Issue[]> => ipcRenderer.invoke('issues:list'),
    get: (id: string): Promise<Issue | null> => ipcRenderer.invoke('issues:get', id),
    create: (input: { title: string; description: string; workdir: string; agentId?: string; backend?: string; handoff?: string; startNow?: boolean; trigger?: RunTrigger; titleAuto?: boolean }): Promise<Issue> => ipcRenderer.invoke('issues:create', input),
    runs: (id: string): Promise<Run[]> => ipcRenderer.invoke('issues:runs', id),
    comments: (id: string): Promise<Comment[]> => ipcRenderer.invoke('issues:comments', id),
    update: (id: string, patch: { priority?: IssuePriority; labels?: string[]; dueDate?: number; status?: IssueStatus }): Promise<Issue | null> => ipcRenderer.invoke('issues:update', id, patch),
    addComment: (id: string, content: string): Promise<Comment | null> => ipcRenderer.invoke('issues:add-comment', id, content),
    notifications: (unreadOnly = false): Promise<Notification[]> => ipcRenderer.invoke('issues:notifications', unreadOnly),
    markNotificationRead: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('issues:notification-read', id),
    onUpdated: (cb: (payload: { taskId: string; issueId: string; issue: Issue | null; run: Run | null }) => void) => {
      const h = (_e: unknown, payload: { taskId: string; issueId: string; issue: Issue | null; run: Run | null }) => cb(payload)
      ipcRenderer.on('issues:updated', h)
      return () => ipcRenderer.removeListener('issues:updated', h)
    }
  },
  automations: {
    list: (): Promise<Automation[]> => ipcRenderer.invoke('automations:list'),
    create: (input: Omit<Automation, 'id' | 'createdAt' | 'lastRunAt' | 'nextRunAt'>): Promise<Automation> => ipcRenderer.invoke('automations:create', input),
    update: (id: string, patch: Partial<Automation>): Promise<Automation | null> => ipcRenderer.invoke('automations:update', id, patch),
    delete: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('automations:delete', id),
    runNow: (id: string): Promise<{ ok: boolean; error?: string; task?: Task }> => ipcRenderer.invoke('automations:run-now', id)
  },
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
    set: (patch: Partial<AppSettings>): Promise<AppSettings> => ipcRenderer.invoke('settings:set', patch),
    onUpdated: (cb: (s: AppSettings) => void): (() => void) => {
      const listener = (_e: unknown, s: AppSettings) => cb(s)
      ipcRenderer.on('settings:updated', listener)
      return () => ipcRenderer.removeListener('settings:updated', listener)
    },
    probe: (): Promise<{ ok: boolean; detail: string; searched: string[] }> => ipcRenderer.invoke('settings:probe')
  },
  pickDir: (): Promise<string> => ipcRenderer.invoke('dialog:pick-dir'),
  openPath: (target: string): Promise<void> => ipcRenderer.invoke('shell:open', target),
  notify: (title: string, body: string): void => ipcRenderer.send('notify', { title, body }),
  agents: {
    list: (): Promise<Array<AgentInfo>> =>
      ipcRenderer.invoke('agents:list'),
    save: (list: Array<AgentInfo>) =>
      ipcRenderer.invoke('agents:save', list) as Promise<Array<AgentInfo>>,
    models: (backend: string): Promise<AgentModelCatalog> =>
      ipcRenderer.invoke('agents:models', backend)
  },
  runtimes: {
    snapshot: (): Promise<RuntimeSnapshot[]> => ipcRenderer.invoke('runtime:snapshot')
  },
  analytics: {
    summary: (input?: { since?: number; until?: number }): Promise<AnalyticsSummary> => ipcRenderer.invoke('analytics:summary', input)
  }
}

contextBridge.exposeInMainWorld('agentdeck', api)
export type AgentDeckApi = typeof api
