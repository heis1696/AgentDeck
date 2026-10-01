// 渲染层 API 封装：window.agentdeck 的类型 + 常用 hooks
import { useEffect, useState, useCallback, useRef } from 'react'
import type { AgentDeckApi, AgentInfo, AgentModelCatalog, FileDiffResult, PresetInfo, PermissionRequest } from '../../shared/contracts'
import type { Task, TaskEvent, AppSettings, Issue, Run, Comment, Automation, RuntimeSnapshot, AnalyticsSummary, IssuePriority, IssueStatus, RunTrigger } from '../../shared/types'
import type { PackAssets, PetSayPayload, PetStateSnapshot } from '../../shared/pet'
import { createDeltaList } from './data-store'
import type { DeltaList } from './data-store'

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
 *  广播自带完整 Task（task:updated）/id（task:deleted），直接增量落位——稳态零 list 拉取；
 *  全量快照只在首次装载与显式 refresh 发生（单调序号最新读获胜 + 读期间广播缓冲重放，
 *  先发后至的旧快照整份作废、显式刷新绝不排队等旧读；卸载/StrictMode 清理作废在途读，
 *  旧装载的响应修改不了新装载的状态）。增量插入与 createdAt 更新按主进程同一 createdAt
 *  降序落位（data-store compare）。
 *  兜底对账（微任务合并，稳态不触发）：①首份快照落地前，事件兼作重试触发器——增量目录
 *  不完整，不能一直卡在未就绪；②issues:create「稍后创建」只广播 issues:updated、不广播
 *  task:updated（waitForTaskListed 注释即此），目录缺失该 taskId 才补一次全量。
 *  对账让位：全量读在途时广播已进缓冲、快照落地即重放，不再逐条广播补发全量读。
 *  ready 标记目录是否拿到过第一份真实列表：false = 目录未加载，宿主不应把空目录喂给交互中心。 */
export function useTasks() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const storeRef = useRef<DeltaList<Task> | null>(null)
  const readySeenRef = useRef(false)
  if (storeRef.current === null) storeRef.current = createDeltaList<Task>((task) => task.id, (left, right) => right.createdAt - left.createdAt)
  const refresh = useCallback(async () => {
    try {
      const list = await storeRef.current!.read(() => bridge.tasks.list())
      if (list) {
        readySeenRef.current = true
        setReady(true)
        setError(null)
      }
      return list
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return null
    }
  }, [])
  useEffect(() => {
    const store = storeRef.current!
    let disposed = false
    let reconciling = false
    let retryBeforeReady = false
    const missingTaskIds = new Set<string>()
    const reconcile = (retry = false) => {
      retryBeforeReady ||= retry
      if (reconciling || disposed) return
      reconciling = true
      queueMicrotask(() => {
        reconciling = false
        const retry = retryBeforeReady
        retryBeforeReady = false
        // 读在途时广播已缓冲、落地即重放——此时补全量读只会逐条广播打翻读序号（首载一条突发 = N 次全量）
        if (disposed || store.reading) return
        const missingTask = [...missingTaskIds].some((id) => !store.has(id))
        missingTaskIds.clear()
        if ((retry && !readySeenRef.current) || missingTask) void refresh()
      })
    }
    const unsubscribe = store.subscribe((items) => {
      if (disposed) return
      setTasks(items)
      if (missingTaskIds.size) reconcile()
    })
    const off1 = bridge.tasks.onUpdated((task) => {
      store.upsert(task)
      if (!readySeenRef.current) reconcile(true)
    })
    const off2 = bridge.tasks.onDeleted((id) => {
      store.remove(id)
      if (!readySeenRef.current) reconcile(true)
    })
    const offIssues = bridge.issues.onUpdated((payload) => {
      // 停泊建单（startNow=false）只有 issues 广播：目录缺失该任务才对账，同批合并为一次
      if (!payload.issue || store.has(payload.issue.taskId)) return
      missingTaskIds.add(payload.issue.taskId)
      reconcile()
    })
    void refresh()
    return () => {
      disposed = true
      unsubscribe()
      off1()
      off2()
      offIssues()
      // 卸载/StrictMode 清理：作废在途读，旧装载的响应整份返回 null，修改不了（新）状态
      store.invalidateReads()
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

/** Issue is the durable user-facing unit; tasks remain an execution detail.
 *  广播自带完整 Issue（issue:null = 删除），按 updatedAt 降序增量落位；全量快照只在装载/显式 refresh。
 *  对账兜底：保留窗 GC 删除 Issue 不广播（主进程仅 deleteIssue 落盘），但 GC 会级联删
 *  任务并逐个广播 task:deleted——借此低频触发一次全量刷新，防止 GC 残影长期滞留。 */
export function useIssues() {
  const [issues, setIssues] = useState<Issue[]>([])
  const storeRef = useRef<DeltaList<Issue> | null>(null)
  if (storeRef.current === null) storeRef.current = createDeltaList<Issue>((issue) => issue.id, (left, right) => right.updatedAt - left.updatedAt)
  const refresh = useCallback(async () => {
    try {
      return await storeRef.current!.read(() => bridge.issues.list())
    } catch {
      return null
    }
  }, [])
  useEffect(() => {
    const store = storeRef.current!
    let disposed = false
    const unsubscribe = store.subscribe((items) => { if (!disposed) setIssues(items) })
    const off = bridge.issues.onUpdated((payload) => {
      if (payload.issue) store.upsert(payload.issue)
      else store.remove(payload.issueId)
    })
    const offTasks = bridge.tasks.onDeleted(() => { void refresh() })
    void refresh()
    return () => {
      disposed = true
      unsubscribe()
      off()
      offTasks()
      store.invalidateReads()
    }
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
