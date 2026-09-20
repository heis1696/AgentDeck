import { useCallback, useEffect, useRef, useState } from 'react'
import { Target, Play, Pause, XCircle, RotateCw, CircleCheck, CircleDashed, Zap, Trash2, RefreshCw } from 'lucide-react'
import { bridge, fmtDuration, fmtTime } from '../../api'
import { ui } from '../../ui/interaction-center'
import { FloatWindow } from '../../ui/FloatWindow'
import { GOAL_STATUS_COLORS, GOAL_STATUS_LABELS } from '../../labels'
import type { Goal, GoalCheckpoint, GoalRun, Task } from '../../../../shared/types'
import type { AgentInfo } from '../../../../shared/contracts'
import { GoalCreateDialog } from './GoalCreateDialog'

type GoalDataState = 'loading' | 'ready' | 'error'

const GOAL_STOP_REASON_LABELS: Record<string, string> = {
  user_cancel: '你已取消目标，当前任务已停止，目标记录仍保留',
  user_pause: '你已暂停目标，等待确认后再继续',
  run_budget: '已达到最大轮数，不能继续消耗预算',
  duration_budget: '已达到总时长预算，不能继续消耗预算',
  no_progress: '连续多轮没有产生可确认的进展',
  block_cap: '审核拦截次数已达到上限',
  stop_condition: '命中停止条件，等待你的决定',
  doom_loop: '检测到重复操作，等待人工确认',
  failure_cap: '连续失败次数已达到上限',
  application_restart: '应用重启中断了这次推进，等待确认',
  launch_failed: '执行任务启动失败',
  spec_rollback: '规格已回滚，等待确认后再继续'
}

function goalBudgetExhausted(goal?: Pick<Goal, 'status' | 'runCount' | 'maxRuns' | 'totalDurationMs' | 'maxDurationMs' | 'stopReason' | 'blockedReason'>): boolean {
  if (!goal) return false
  return goal.stopReason === 'run_budget' || goal.stopReason === 'duration_budget'
    || goal.blockedReason?.toLowerCase().includes('budget exhausted') === true
    || goal.runCount >= goal.maxRuns
    || goal.totalDurationMs >= goal.maxDurationMs
}

/** 目标操作按钮语义：启动/暂停/继续/重试按状态给出（GoalPanel 与全局目标页共用） */
export function goalActions(status: Goal['status'], goal?: Pick<Goal, 'status' | 'runCount' | 'maxRuns' | 'totalDurationMs' | 'maxDurationMs' | 'stopReason' | 'blockedReason'>): Array<{ key: 'start' | 'pause' | 'continue'; label: string; icon: typeof Play }> {
  switch (status) {
    case 'draft': return [{ key: 'start', label: '启动', icon: Play }]
    case 'active': return [{ key: 'pause', label: '暂停', icon: Pause }]
    case 'waiting_user': return goalBudgetExhausted(goal) ? [] : [{ key: 'continue', label: '继续', icon: Play }]
    case 'blocked': case 'failed': return goalBudgetExhausted(goal) ? [] : [{ key: 'continue', label: '重试', icon: RotateCw }]
    default: return []
  }
}

function readableGoalStopReason(goal: Goal): string | null {
  if (!goal.stopReason && !goal.blockedReason) return null
  const reason = goal.stopReason ? (GOAL_STOP_REASON_LABELS[goal.stopReason] ?? goal.stopReason.replaceAll('_', ' ')) : '目标暂时受阻'
  return goal.blockedReason && !GOAL_STOP_REASON_LABELS[goal.stopReason ?? ''] ? `${reason}：${goal.blockedReason}` : reason
}

function readableGoalBlockedReason(goal: Goal): string | null {
  const reason = goal.blockedReason
  if (!reason) return null
  if (reason.toLowerCase().includes('run budget exhausted')) return `轮数预算：已使用 ${goal.runCount}/${goal.maxRuns}`
  if (reason.toLowerCase().includes('duration budget exhausted')) return `时长预算：已使用 ${fmtDuration(goal.totalDurationMs) || '0s'} / ${fmtDuration(goal.maxDurationMs) || '0s'}`
  if (reason === 'Cancelled by user') return '目标已取消，目标记录仍保留'
  if (reason === 'Paused by user') return '目标已暂停，等待你的决定'
  if (reason.startsWith('Stop condition:')) return `停止条件：${reason.slice('Stop condition:'.length).trim()}`
  return reason
}

/**
 * 目标模式浮窗（Issue 详情头部 🎯 芯片 / 追问框 /goal 命令唤起）：
 * 数据始终在挂载时加载并经 onGoal 上报宿主（驱动头部芯片），
 * 浮窗本体仅 open 时渲染；无目标时打开浮窗直接进入创建流程。
 */
export function GoalPanel({ task, issueId, open, onToggle, onGoal }: {
  task: Task
  issueId: string
  open: boolean
  onToggle: (open: boolean) => void
  onGoal: (goal: Goal | null) => void
}) {
  const [goal, setGoal] = useState<Goal | null>(null)
  const [readState, setReadState] = useState<GoalDataState>('loading')
  const [readError, setReadError] = useState<string | null>(null)
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [checkpoints, setCheckpoints] = useState<GoalCheckpoint[]>([])
  const [runs, setRuns] = useState<GoalRun[]>([])
  const [detailState, setDetailState] = useState<GoalDataState>('ready')
  const [detailError, setDetailError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [busy, setBusyState] = useState(false)
  const busyRef = useRef(false)
  const setBusy = (next: boolean) => { busyRef.current = next; setBusyState(next) }
  const readSeq = useRef(0)
  const detailSeq = useRef(0)

  const refreshGoals = useCallback(async () => {
    const seq = ++readSeq.current
    setReadState('loading')
    try {
      const goals = await bridge.goals.list()
      if (seq !== readSeq.current) return
      setGoal(goals.filter((g) => g.issueId === issueId).sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null)
      setReadError(null)
      setReadState('ready')
    } catch (error) {
      if (seq !== readSeq.current) return
      setReadError(error instanceof Error ? error.message : String(error))
      setReadState('error')
    }
  }, [issueId])

  useEffect(() => {
    void refreshGoals()
    const off = bridge.goals.onUpdated((g) => {
      if (g.issueId !== issueId) return
      readSeq.current++
      setReadState('ready')
      setReadError(null)
      setGoal((cur) => (!cur || g.id === cur.id || g.updatedAt >= cur.updatedAt) ? g : cur)
    })
    const offDeleted = bridge.goals.onDeleted((goalId) => { setGoal((cur) => (cur?.id === goalId ? null : cur)); void refreshGoals() })
    void bridge.agents.list().then(setAgents).catch(() => {})
    return () => { readSeq.current++; off(); offDeleted() }
  }, [issueId, refreshGoals])

  useEffect(() => { onGoal(goal) }, [goal, onGoal])

  const loadDetail = useCallback(async (id: string) => {
    const seq = ++detailSeq.current
    setDetailState('loading')
    setDetailError(null)
    try {
      const [cps, rs] = await Promise.all([bridge.goals.checkpoints(id), bridge.goals.runs(id)])
      if (seq !== detailSeq.current) return
      setCheckpoints(cps); setRuns(rs)
      setDetailState('ready')
    } catch (error) {
      if (seq !== detailSeq.current) return
      setDetailError(error instanceof Error ? error.message : String(error))
      setDetailState('error')
    }
  }, [])

  // 浮窗打开即加载进度明细；无目标时直接进入创建流程（/goal 命令的主路径）
  useEffect(() => {
    if (!open) return
    if (goal) void loadDetail(goal.id)
    else if (readState === 'ready') setCreating(true)
  }, [open, goal, readState, loadDetail])

  const act = async (key: 'start' | 'pause' | 'continue') => {
    if (!goal || busyRef.current || !goalActions(goal.status, goal).some((action) => action.key === key)) return
    setBusy(true)
    try {
      const call = key === 'start' ? bridge.goals.start : key === 'pause' ? bridge.goals.pause : bridge.goals.continue
      const res = await call(goal.id).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
      if (!res.ok) ui.toast.error(`目标操作失败: ${res.error ?? '未知错误'}`)
    } finally { setBusy(false) }
  }

  const cancelGoal = async () => {
    if (!goal || busyRef.current) return
    setBusy(true)
    try {
      const yes = await ui.confirm({
        title: '取消目标模式？',
        body: goal.currentRunId
          ? '会停止当前正在运行的目标任务，并将目标标为已取消。目标、轮次和 checkpoint 记录会保留，但取消后不能继续推进。'
          : '会将目标标为已取消。目标、轮次和 checkpoint 记录会保留，但取消后不能继续推进。',
        danger: true,
        confirmText: '取消目标'
      })
      if (!yes) return
      const res = await bridge.goals.cancel(goal.id).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
      if (!res.ok) ui.toast.error(`取消失败: ${res.error ?? '未知错误'}`)
    } finally { setBusy(false) }
  }

  /** 清除目标模式：删掉目标及其 checkpoint（运行中任务连带取消），回到可重新开启的空态 */
  const removeGoal = async () => {
    if (!goal || busyRef.current) return
    setBusy(true)
    try {
      const yes = await ui.confirm({
        title: '清除目标模式',
        body: '将删除该目标及其全部 checkpoint 记录，运行中的任务会被取消。清除后本 Issue 不再被目标模式锁定，可重新开启。',
        danger: true,
        confirmText: '清除'
      })
      if (!yes) return
      const res = await bridge.goals.delete(goal.id).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
      if (res.ok) {
        setGoal(null)
        setCheckpoints([])
        setRuns([])
      } else {
        ui.toast.error(`清除失败: ${res.error ?? '未知错误'}`)
      }
    } finally {
      setBusy(false)
    }
  }

  const agent = agents.find((a) => a.id === goal?.agentId)

  return <>
    {open && <FloatWindow title="目标模式" icon={<Target size={13} />} onClose={() => onToggle(false)}>
      <div className="goal-panel float-panel">
        {goal && <div className="goal-panel-head">
          <span className="badge" style={{ color: GOAL_STATUS_COLORS[goal.status] }}>{GOAL_STATUS_LABELS[goal.status]}</span>
          {!['completed', 'cancelled'].includes(goal.status) && (
            <button className="btn ghost agent-del" title="取消目标：停止当前任务并保留目标记录" disabled={busy} onClick={() => void cancelGoal()}><XCircle size={13} /></button>
          )}
          <button className="btn ghost agent-del" title="清除目标模式：删除目标及其 checkpoint，运行中的任务会被取消" disabled={busy} onClick={() => void removeGoal()}><Trash2 size={13} /></button>
        </div>}
        {readState === 'loading' && !goal && <div className="goal-panel-empty" data-goal-state="loading"><span className="hint">正在读取目标记录…</span></div>}
        {readState === 'error' && <div className="goal-panel-empty" data-goal-state={goal ? 'stale' : 'error'}>
          <strong>{goal ? '目标记录读取失败，当前显示上次成功数据' : '目标记录读取失败'}</strong>
          <span className="hint">{readError || '请重试后再创建或操作目标。'}</span>
          <button className="btn" disabled={busy} onClick={() => void refreshGoals()}><RefreshCw size={13} /> 重试读取</button>
        </div>}
        {!goal && readState === 'ready' && <div className="goal-panel-empty" data-goal-state="empty">
          <span className="hint">开启后 agent 在本 Issue 内自省自推：每轮留 checkpoint，直到完成条件全部达成或触发护栏。</span>
          <button className="btn" disabled={busy} onClick={() => setCreating(true)}><Zap size={13} /> 创建目标模式</button>
        </div>}
        {goal && <div className="goal-panel-body">
          <div className="goal-panel-goal" title={goal.text}>{goal.text.length > 60 ? goal.text.slice(0, 60) + '…' : goal.text}</div>
          <div className="hint">
            {goal.runCount}/{goal.maxRuns} 轮 · 累计 {fmtDuration(goal.totalDurationMs) || '0s'}
            {agent ? ` · ${agent.name}` : ` · ${goal.backend}`}
            {goal.currentRunId ? ' · 执行中' : ''}
            {goal.failures ? ` · 失败 ${goal.failures}/2` : ''}
          </div>
          {(readState === 'error' || goal.stopReason || (goal.noProgress ?? 0) > 0 || (goal.blockCount ?? 0) > 0) && (
            <div className="hint goal-panel-reason">
              {readState === 'error' ? '数据可能已过期' : readableGoalStopReason(goal) ?? '护栏监测中'}
              {(goal.noProgress ?? 0) > 0 ? ` · 连续无进展 ${goal.noProgress}` : ''}
              {(goal.blockCount ?? 0) > 0 ? ` · 裁判拦截 ${goal.blockCount}/${goal.blockCap ?? 8}` : ''}
            </div>
          )}
          {readableGoalBlockedReason(goal) && <div className="hint goal-panel-reason" title={readableGoalBlockedReason(goal) ?? undefined}>{readableGoalBlockedReason(goal)}</div>}
          <div className="goal-panel-actions">
            {goalActions(goal.status, goal).map(({ key, label, icon: Icon }) => (
              <button key={key} className="btn" disabled={busy} onClick={() => void act(key)}><Icon size={12} /> {label}</button>
            ))}
            {goalBudgetExhausted(goal) && <span className="hint">预算已耗尽，当前目标不能继续</span>}
          </div>
        </div>}
        {goal && <div className="goal-panel-detail">
          {detailState === 'loading' && <p className="hint">正在读取目标进度…</p>}
          {detailState === 'error' && <div className="goal-panel-empty" data-goal-detail-state="error"><span className="hint">目标进度读取失败：{detailError || '未知错误'}</span><button className="btn" disabled={busy} onClick={() => void loadDetail(goal.id)}><RefreshCw size={13} /> 重试进度</button></div>}
          {detailState === 'ready' && checkpoints.length === 0 && <p className="hint">还没有 checkpoint——每轮 Run 结束后由控制器生成摘要。</p>}
          {checkpoints.map((cp) => (
            <div key={cp.id} className="goal-checkpoint">
              <div className="goal-cp-head"><span className="badge">第 {cp.phaseIndex + 1} 轮</span><time>{fmtTime(cp.createdAt)}</time>{cp.durationMs ? <span className="hint">{fmtDuration(cp.durationMs)}</span> : null}</div>
              <p>{cp.summary}</p>
              <div className="goal-cond-group">
                {cp.completedConditions.map((c) => <span key={c} className="goal-cond done"><CircleCheck size={11} /> {c}</span>)}
                {cp.incompleteConditions.map((c) => <span key={c} className="goal-cond"><CircleDashed size={11} /> {c}</span>)}
              </div>
              {cp.nextPlan && <p className="hint">下一步：{cp.nextPlan}</p>}
              {cp.blockers.length > 0 && <p className="hint">阻塞：{cp.blockers.join('；')}</p>}
            </div>
          ))}
          {runs.length > 0 && <div className="goal-panel-runs">{runs.map((r) => (
            <div key={r.id} className="goal-run"><span className="badge">第 {r.phaseIndex + 1} 轮</span><span className="hint">{r.status}{r.startedAt ? ` · ${fmtTime(r.startedAt)}` : ''}{r.durationMs ? ` · ${fmtDuration(r.durationMs)}` : ''}</span></div>
          ))}</div>}
        </div>}
      </div>
    </FloatWindow>}
    {creating && <GoalCreateDialog issueId={issueId} prefill={{ text: task.title, workdir: task.workdir, agentId: task.agentId ?? '', backend: task.backend }} onClose={() => setCreating(false)} />}
  </>
}
