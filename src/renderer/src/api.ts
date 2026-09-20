// 渲染层 API 封装：window.agentdeck 的类型 + 常用 hooks
import { useEffect, useState, useCallback, useRef } from 'react'
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

/** 任务列表 + 实时更新。
 *  refresh 用单调请求序号防响应乱序：主进程事件密集时多次 list 并发在途，先发后至的旧快照
 *  直接丢弃，只有最新一次请求的响应会落地——否则草稿创建后，一份创建前发出的旧列表快照
 *  会把新任务从目录里抹掉（详情页随之丢 selected 弹回列表）。
 *  ready 标记目录是否拿到过第一份真实列表：false = 目录未加载，宿主不应把空目录喂给交互中心。 */
export function useTasks() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const seqRef = useRef(0)
  const latestRequest = useRef<Promise<Task[] | null>>(Promise.resolve(null))
  const refresh = useCallback(async () => {
    const seq = ++seqRef.current
    const request: Promise<Task[] | null> = bridge.tasks.list().then((list) => {
      if (seq !== seqRef.current) return latestRequest.current
      setTasks(list)
      setReady(true)
      setError(null)
      return list
    }).catch((cause: unknown) => {
      if (seq !== seqRef.current) return latestRequest.current
      setError(cause instanceof Error ? cause.message : String(cause))
      return null
    })
    latestRequest.current = request
    return request
  }, [])
  useEffect(() => {
    refresh()
    const off1 = bridge.tasks.onUpdated(() => refresh())
    const off2 = bridge.tasks.onDeleted(() => refresh())
    return () => {
      seqRef.current++
      latestRequest.current = Promise.resolve(null)
      off1()
      off2()
    }
  }, [refresh])
  return { tasks, refresh, ready, error }
}

/** 轮询等待任务出现在桥接任务目录里（草稿创建后的导航前置条件：目录可见才进详情）。
 *  主进程 issues:create 同步注册任务，但「稍后」创建只广播 issues:updated、不广播
 *  task:updated——渲染层目录不会自己刷新，这里以有界重试吸收时序差。 */
export async function waitForTaskListed(id: string, opts: { attempts?: number; delayMs?: number } = {}): Promise<boolean> {
  const attempts = opts.attempts ?? 20
  const delayMs = opts.delayMs ?? 50
  for (let attempt = 0; attempt < attempts; attempt++) {
    const list = await bridge.tasks.list().catch(() => [] as Task[])
    if (list.some((task) => task.id === id)) return true
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  return false
}

/** 有界重试取单个任务：Issue 已建但执行记录注册略有延迟时不立刻判失败。 */
export async function getTaskWhenReady(id: string, opts: { attempts?: number; delayMs?: number } = {}): Promise<Task | null> {
  const attempts = opts.attempts ?? 10
  const delayMs = opts.delayMs ?? 50
  for (let attempt = 0; attempt < attempts; attempt++) {
    const task = await bridge.tasks.get(id).catch(() => null)
    if (task) return task
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  return null
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
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const requestSeq = useRef(0)
  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current
    setLoading(true)
    try {
      const next = await bridge.settings.get()
      if (seq !== requestSeq.current) return null
      setSettings(next)
      setError(null)
      return next
    } catch (cause) {
      if (seq === requestSeq.current) setError(cause instanceof Error ? cause.message : String(cause))
      return null
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [])
  useEffect(() => {
    void refresh()
    // 订阅广播：App 与设置页各持一份实例，任何一处更新都要同步到全部实例（主题切换等）
    const off = bridge.settings.onUpdated((next) => {
      ++requestSeq.current
      setSettings(next)
      setError(null)
      setLoading(false)
    })
    return () => {
      requestSeq.current++
      off()
    }
  }, [refresh])
  const update = useCallback(async (patch: Partial<AppSettings>) => {
    const seq = ++requestSeq.current
    try {
      const next = await bridge.settings.set(patch)
      if (seq === requestSeq.current) {
        setSettings(next)
        setError(null)
        setLoading(false)
      }
      return next
    } catch (cause) {
      if (seq === requestSeq.current) setError(cause instanceof Error ? cause.message : String(cause))
      throw cause
    }
  }, [])
  return { settings, update, refresh, loading, error }
}

/** 桌宠状态快照 + 实时广播订阅（设置卡片用）。
 *  读取与广播分开结算：广播是权威快照，收到广播即作废在途读取——否则一份更早发出、
 *  更晚返回的读取会把广播后的新状态打回旧值。enabled=false 是有效的已加载状态，
 *  只有「还没拿到过任何快照」才由 state=null 表示。
 *  loading/error/stale 供设置页区分首次加载、读取失败与「失败但保留上次成功快照」。 */
export function usePetState() {
  const [state, setState] = useState<PetStateSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const requestSeq = useRef(0)
  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current
    setLoading(true)
    try {
      const next = await bridge.pet.getState()
      if (seq !== requestSeq.current) return null
      // getState 理论上总有快照；真拿到空值也不该抹掉已有的成功快照
      setState((current) => next ?? current)
      setError(null)
      return next
    } catch (cause) {
      if (seq === requestSeq.current) setError(cause instanceof Error ? cause.message : String(cause))
      return null
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [])
  useEffect(() => {
    void refresh()
    const off = bridge.pet.onState((next) => {
      ++requestSeq.current
      setState(next)
      setError(null)
      setLoading(false)
    })
    return () => {
      requestSeq.current++
      off()
    }
  }, [refresh])
  return { state, refresh, loading, error, stale: error !== null && state !== null }
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
