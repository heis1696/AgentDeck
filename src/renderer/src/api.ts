// 渲染层 API 封装：window.agentdeck 的类型 + 常用 hooks
import { useEffect, useState, useCallback } from 'react'
import type { AgentDeckApi, AgentInfo, AgentModelCatalog, FileDiffResult, PresetInfo, PermissionRequest } from '../../shared/contracts'
import type { Task, TaskEvent, AppSettings, Issue, Run, Comment, Automation, RuntimeSnapshot, AnalyticsSummary, IssuePriority, IssueStatus, RunTrigger } from '../../shared/types'
import type { PackAssets, PetSayPayload, PetStateSnapshot } from '../../shared/pet'

/** 队员（agent 身份）——与主进程 agents.ts 的 Agent 对齐 */
export type { AgentInfo, AgentModelCatalog }

/** 锻造师（agent 生成器）草稿契约——与 src/shared/forge.ts 对齐 */
export type { AgentDraft, DraftResult, ImproveOutcome, ImproveResult, ImportResult, ExportResult, EvaluateVerdict, EvaluateOutcome, EvaluateResult } from '../../shared/forge'

/** API 预设（连接档案）——与主进程 presets.ts 的 ApiPreset 对齐 */
export type ApiPresetInfo = PresetInfo

/** 模型目录（agents:models 返回）：zcode 有本地 catalog，其余平台 freeform */
export const bridge: AgentDeckApi = (window as unknown as { agentdeck: AgentDeckApi }).agentdeck

/** 编辑详情：单文件的 git 权威未提交 diff（工作区 + 暂存对 HEAD）；失败返回 ok:false + code，不抛。
 *  文件无改动时 ok:true 且 note:'clean'（回退事件里的 +/- 快照）。 */
export function fileDiff(taskId: string, file: string): Promise<FileDiffResult> {
  return bridge.tasks.fileDiff(taskId, file)
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

/** 桌宠状态快照 + 实时广播订阅（设置卡片用） */
export function usePetState() {
  const [state, setState] = useState<PetStateSnapshot | null>(null)
  const refresh = useCallback(async () => {
    setState(await bridge.pet.getState())
  }, [])
  useEffect(() => {
    refresh()
    return bridge.pet.onState(setState)
  }, [refresh])
  return { state, refresh }
}

/** 桌宠共享类型再导出（组件层统一从 api.ts 取桌宠契约） */
export type { PackAssets, PetSayPayload, PetStateSnapshot }

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
