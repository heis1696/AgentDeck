// 渲染层 API 封装：window.agentdeck 的类型 + 常用 hooks
import { useEffect, useState, useCallback } from 'react'
import type { AgentDeckApi, AgentInfo, AgentModelCatalog, PresetInfo, PermissionRequest, SidecarSnapshot } from '../../shared/contracts'
import type { Task, TaskEvent, AppSettings, Issue, Run, Comment, Notification, Automation, RuntimeSnapshot, AnalyticsSummary, IssuePriority, IssueStatus, RunTrigger } from '../../shared/types'

/** 队员（agent 身份）——与主进程 agents.ts 的 Agent 对齐 */
export type { AgentInfo, AgentModelCatalog }

/** API 预设（连接档案）——与主进程 presets.ts 的 ApiPreset 对齐 */
export type ApiPresetInfo = PresetInfo

/** 模型目录（agents:models 返回）：zcode 有本地 catalog，其余平台 freeform */
export const bridge: AgentDeckApi = (window as unknown as { agentdeck: AgentDeckApi }).agentdeck

/** Sidecar lifecycle state is a read-only renderer projection. A ready event
 * is emitted only after the main process has completed its state barrier. */
export function useSidecar() {
  const [sidecar, setSidecar] = useState<SidecarSnapshot | null>(null)
  useEffect(() => {
    let mounted = true
    bridge.sidecar.status().then((snapshot) => { if (mounted) setSidecar(snapshot) }).catch(() => {})
    const off = bridge.sidecar.onStatus((snapshot) => { if (mounted) setSidecar(snapshot) })
    return () => { mounted = false; off() }
  }, [])
  return sidecar
}

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

/** Issue is the durable user-facing unit; tasks remain an execution detail. */
export function useIssues() {
  const [issues, setIssues] = useState<Issue[]>([])
  const refresh = useCallback(async () => {
    setIssues(await bridge.issues.list())
  }, [])
  useEffect(() => {
    refresh()
    const off = bridge.issues.onUpdated(() => refresh())
    return off
  }, [refresh])
  return { issues, refresh }
}

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  useEffect(() => {
    bridge.settings.get().then(setSettings)
    // 订阅广播：App 与设置页各持一份实例，任何一处更新都要同步到全部实例（主题切换等）
    return bridge.settings.onUpdated(setSettings)
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

/** token 数人类可读（1234567 → 1.23M） */
export function fmtTokens(n?: number): string {
  if (!n) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}
