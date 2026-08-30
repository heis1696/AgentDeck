// preload：向渲染层暴露类型安全的 IPC 桥
import { contextBridge, ipcRenderer } from 'electron'
import type { Task, TaskEvent, AppSettings } from '../shared/types'
import type { PermissionRequest } from '../main/backends/types'

const api = {
  tasks: {
    list: (): Promise<Task[]> => ipcRenderer.invoke('tasks:list'),
    get: (id: string): Promise<Task | null> => ipcRenderer.invoke('tasks:get', id),
    events: (id: string, afterSeq = 0): Promise<TaskEvent[]> => ipcRenderer.invoke('tasks:events', id, afterSeq),
    create: (input: { title: string; prompt: string; workdir: string; backend?: string }) =>
      ipcRenderer.invoke('tasks:create', input) as Promise<Task>,
    cancel: (id: string) => ipcRenderer.invoke('tasks:cancel', id) as Promise<{ ok: boolean; error?: string }>,
    followUp: (id: string, content: string) =>
      ipcRenderer.invoke('tasks:followup', id, content) as Promise<{ ok: boolean; error?: string }>,
    delete: (id: string) => ipcRenderer.invoke('tasks:delete', id) as Promise<{ ok: boolean; error?: string }>,
    retry: (id: string) => ipcRenderer.invoke('tasks:retry', id) as Promise<{ ok: boolean; error?: string }>,
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
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
    set: (patch: Partial<AppSettings>): Promise<AppSettings> => ipcRenderer.invoke('settings:set', patch),
    probe: (): Promise<{ ok: boolean; detail: string; searched: string[] }> => ipcRenderer.invoke('settings:probe')
  },
  pickDir: (): Promise<string> => ipcRenderer.invoke('dialog:pick-dir'),
  openPath: (target: string): Promise<void> => ipcRenderer.invoke('shell:open', target),
  notify: (title: string, body: string): void => ipcRenderer.send('notify', { title, body }),
  agents: {
    list: (): Promise<Array<{ id: string; name: string; backend: string; model?: string; note?: string; color: string }>> =>
      ipcRenderer.invoke('agents:list'),
    save: (list: Array<{ id: string; name: string; backend: string; model?: string; note?: string; color: string }>) =>
      ipcRenderer.invoke('agents:save', list) as Promise<Array<{ id: string; name: string; backend: string; model?: string; note?: string; color: string }>>,
    probe: (): Promise<Record<string, { ok: boolean; detail: string }>> => ipcRenderer.invoke('agents:probe'),
    onProbeResult: (cb: (id: string, result: { ok: boolean; detail: string }) => void) => {
      const h = (_e: unknown, p: { id: string; result: { ok: boolean; detail: string } }) => cb(p.id, p.result)
      ipcRenderer.on('agents:probe-result', h)
      return () => ipcRenderer.removeListener('agents:probe-result', h)
    }
  }
}

contextBridge.exposeInMainWorld('agentdeck', api)
export type AgentDeckApi = typeof api
