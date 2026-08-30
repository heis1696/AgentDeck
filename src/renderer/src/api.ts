// 渲染层 API 封装：window.agentdeck 的类型 + 常用 hooks
import { useEffect, useState, useCallback } from 'react'
import type { Task, TaskEvent, AppSettings } from '../../shared/types'
import type { PermissionRequest } from '../../main/backends/types'

interface Bridge {
  tasks: {
    list: () => Promise<Task[]>
    get: (id: string) => Promise<Task | null>
    events: (id: string, afterSeq?: number) => Promise<TaskEvent[]>
    create: (input: { title: string; prompt: string; workdir: string; backend?: string; agentId?: string }) => Promise<Task>
    cancel: (id: string) => Promise<{ ok: boolean; error?: string }>
    followUp: (id: string, content: string) => Promise<{ ok: boolean; error?: string }>
    delete: (id: string) => Promise<{ ok: boolean; error?: string }>
    retry: (id: string) => Promise<{ ok: boolean; error?: string }>
    onUpdated: (cb: (t: Task) => void) => () => void
    onDeleted: (cb: (id: string) => void) => () => void
    onFocusTask: (cb: (id: string) => void) => () => void
    onEvent: (cb: (taskId: string, e: TaskEvent) => void) => () => void
    onPermission: (cb: (taskId: string, req: PermissionRequest) => void) => () => void
    respondPermission: (requestId: string | number, optionId: string, decision: 'allow' | 'deny') => Promise<{ ok: boolean; error?: string }>
  }
  settings: {
    get: () => Promise<AppSettings>
    set: (patch: Partial<AppSettings>) => Promise<AppSettings>
    probe: () => Promise<{ ok: boolean; detail: string; searched: string[] }>
  }
  pickDir: () => Promise<string>
  openPath: (target: string) => Promise<void>
  notify: (title: string, body: string) => void
  agents: {
    list: () => Promise<AgentInfo[]>
    save: (list: AgentInfo[]) => Promise<AgentInfo[]>
    probe: () => Promise<Record<string, { ok: boolean; detail: string }>>
    onProbeResult: (cb: (id: string, result: { ok: boolean; detail: string }) => void) => () => void
  }
}

/** 队员（agent 身份）——与主进程 agents.ts 的 Agent 对齐 */
export interface AgentInfo {
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

export const bridge: Bridge = (window as any).agentdeck

/** 任务列表 + 实时更新 */
export function useTasks() {
  const [tasks, setTasks] = useState<Task[]>([])
  const refresh = useCallback(async () => {
    setTasks(await bridge.tasks.list())
  }, [])
  useEffect(() => {
    refresh()
    const off1 = bridge.tasks.onUpdated(() => refresh())
    const off2 = bridge.tasks.onDeleted(() => refresh())
    return () => {
      off1()
      off2()
    }
  }, [refresh])
  return { tasks, refresh }
}

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  useEffect(() => {
    bridge.settings.get().then(setSettings)
  }, [])
  const update = useCallback(async (patch: Partial<AppSettings>) => {
    setSettings(await bridge.settings.set(patch))
  }, [])
  return { settings, update }
}

export function fmtDuration(ms?: number): string {
  if (!ms || ms < 0) return ''
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${s % 60}s`
  return `${Math.floor(m / 60)}h${m % 60}m`
}

export function fmtTime(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}
