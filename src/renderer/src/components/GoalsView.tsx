import { useEffect, useMemo, useState } from 'react'
import { CircleDashed, Target, Trash2, XCircle, Zap } from 'lucide-react'
import { bridge, fmtDuration, useIssues, useTasks, type AgentInfo } from '../api'
import { toast } from '../ui/Toasts'
import { confirmDialog } from '../ui/Confirm'
import { EmptyState } from '../ui/EmptyState'
import { IssuePicker } from '../ui/IssuePicker'
import { GoalCreateDialog } from './goal/GoalCreateDialog'
import { goalActions } from './goal/GoalPanel'
import { GOAL_STATUS_COLORS, GOAL_STATUS_LABELS } from '../labels'
import type { Goal, Issue } from '../../../shared/types'

export const OPEN_GOAL_CREATE = 'agentdeck:open-goal-create'

/** 命令面板跨视图唤起「开启目标模式」：视图未挂载时置 flag，挂载后消费 */
let createRequested = false
export function requestGoalCreate() {
  createRequested = true
  window.dispatchEvent(new Event(OPEN_GOAL_CREATE))
}

const prefillOf = (task: { title: string; workdir: string; agentId?: string; backend?: string }) =>
  ({ text: task.title, workdir: task.workdir, agentId: task.agentId ?? '', backend: task.backend })

/** 全局目标页：跨 Issue 查看并管控所有目标模式；开启目标先选 Issue 再进创建对话框 */
export function GoalsView({ onOpenIssue }: { onOpenIssue: (taskId: string) => void }) {
  const [goals, setGoals] = useState<Goal[]>([])
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const { issues } = useIssues()
  const { tasks } = useTasks()
  const [picking, setPicking] = useState(false)
  const [picked, setPicked] = useState<Issue | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    bridge.goals.list().then((items) => { if (alive) setGoals(items) }).catch(() => {})
    const off = bridge.goals.onUpdated((goal) => setGoals((current) => {
      const index = current.findIndex((item) => item.id === goal.id)
      if (index === -1) return [goal, ...current]
      const next = current.slice()
      next[index] = goal
      return next
    }))
    const offDeleted = bridge.goals.onDeleted((goalId) => setGoals((current) => current.filter((goal) => goal.id !== goalId)))
    bridge.agents.list().then((list) => { if (alive) setAgents(list) }).catch(() => {})
    return () => { alive = false; off(); offDeleted() }
  }, [])
  useEffect(() => {
    const open = () => { createRequested = false; setPicking(true) }
    if (createRequested) open()
    window.addEventListener(OPEN_GOAL_CREATE, open)
    return () => window.removeEventListener(OPEN_GOAL_CREATE, open)
  }, [])

  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks])
  const issueById = useMemo(() => new Map(issues.map((issue) => [issue.id, issue])), [issues])
  const sorted = useMemo(() => goals.slice().sort((a, b) => {
    const live = (goal: Goal) => (goal.status === 'active' || goal.status === 'waiting_user' ? 0 : 1)
    return live(a) - live(b) || b.updatedAt - a.updatedAt
  }), [goals])

  const act = async (goal: Goal, key: 'start' | 'pause' | 'continue') => {
    if (busy) return
    setBusy(true)
    const call = key === 'start' ? bridge.goals.start : key === 'pause' ? bridge.goals.pause : bridge.goals.continue
    const res = await call(goal.id).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
    if (!res.ok) toast.error(`目标操作失败: ${res.error ?? '未知错误'}`)
    setBusy(false)
  }
  const cancelGoal = async (goal: Goal) => {
    if (busy) return
    setBusy(true)
    const res = await bridge.goals.cancel(goal.id).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
    if (!res.ok) toast.error(`取消失败: ${res.error ?? '未知错误'}`)
    setBusy(false)
  }
  /** 清除目标模式：删掉目标及其 checkpoint（运行中任务连带取消），语义同 GoalPanel.removeGoal */
  const removeGoal = async (goal: Goal) => {
    const yes = await confirmDialog({
      title: '清除目标模式',
      body: `将删除「${goal.text.length > 40 ? goal.text.slice(0, 40) + '…' : goal.text}」及其全部 checkpoint 记录，运行中的任务会被取消。`,
      danger: true,
      confirmText: '清除'
    })
    if (!yes) return
    setBusy(true)
    const res = await bridge.goals.delete(goal.id).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
    if (!res.ok) toast.error(`清除失败: ${res.error ?? '未知错误'}`)
    setBusy(false)
  }
  /** 选定 Issue 后用其绑定任务预填创建对话框；无任务的 Issue 在选择器里已禁选，这里兜底 */
  const startCreateOn = (issue: Issue) => {
    const task = issue.taskId ? taskById.get(issue.taskId) : undefined
    if (!task) { toast.error('该 Issue 未绑定任务，无法开启目标模式'); return }
    setPicked(issue)
    setPicking(false)
  }

  return <div className="goals-page page-surface">
    <header className="page-header-bar">
      <div className="page-title-row"><Target size={16} className="page-icon" /><h1 className="page-title">目标</h1><span className="page-count">{goals.length}</span><span className="page-desc">目标模式：agent 在 Issue 内自省自推，逐轮留 checkpoint 直到完成条件达成。</span></div>
      <div className="detail-actions"><button className="btn primary" onClick={() => setPicking(true)}><Zap size={14} /> 开启目标模式</button></div>
    </header>
    {sorted.length === 0 ? <EmptyState icon={Target} title="还没有目标" description="给一个 Issue 设定目标与可验证的完成条件，agent 每轮自评并继续，直到全部达成或触发护栏；也可以在 Issue 详情侧栏开启。" action={<button className="btn primary" onClick={() => setPicking(true)}><Zap size={14} /> 开启第一个目标</button>} /> : (
      <div className="goals-grid">
        {sorted.map((goal) => {
          const issue = issueById.get(goal.issueId)
          return <GoalCard key={goal.id} goal={goal} agents={agents} issue={issue} busy={busy}
            onAct={act} onCancel={cancelGoal} onRemove={removeGoal}
            onOpenIssue={(taskId) => onOpenIssue(taskId)} />
        })}
      </div>
    )}
    {picking && <div className="overlay" onClick={(e) => e.target === e.currentTarget && setPicking(false)}>
      <div className="dialog goal-issue-dialog">
        <h2>选择 Issue</h2>
        <p className="hint">目标模式绑定到一个 Issue 上自动推进；先选要开启的 Issue（未绑定任务的 Issue 暂不可选）。</p>
        <IssuePicker
          value={picked?.id ?? ''}
          onChange={(id) => { const issue = issueById.get(id); if (issue) startCreateOn(issue) }}
          disabledReason={(issue) => (!issue.taskId || !taskById.get(issue.taskId)) ? '未绑定任务，无法开启目标模式' : null}
          placeholder="选择 Issue…"
        />
        <div className="dialog-footer"><span className="hint">开启后可随时在这里或 Issue 侧栏暂停 / 继续 / 取消。</span><button className="btn" onClick={() => setPicking(false)}>取消</button></div>
      </div>
    </div>}
    {picked && (() => {
      const task = picked.taskId ? taskById.get(picked.taskId) : undefined
      if (!task) return null
      return <GoalCreateDialog issueId={picked.id} prefill={prefillOf(task)} onClose={() => setPicked(null)} />
    })()}
  </div>
}

function GoalCard({ goal, agents, issue, busy, onAct, onCancel, onRemove, onOpenIssue }: {
  goal: Goal
  agents: AgentInfo[]
  issue: Issue | undefined
  busy: boolean
  onAct: (goal: Goal, key: 'start' | 'pause' | 'continue') => void
  onCancel: (goal: Goal) => void
  onRemove: (goal: Goal) => void
  onOpenIssue: (taskId: string) => void
}) {
  const agent = agents.find((a) => a.id === goal.agentId)
  return <article className="goal-card">
    <div className="goal-card-head">
      <span className="badge goal-status-chip" style={{ color: GOAL_STATUS_COLORS[goal.status] }}>{GOAL_STATUS_LABELS[goal.status]}</span>
      {issue && issue.taskId && <button className="mini link goal-card-issue" title={`打开 ${issue.title}`} onClick={() => onOpenIssue(issue.taskId)}>{issue.identifier}</button>}
      <span className="goal-card-agent">{agent ? agent.name : goal.backend}</span>
    </div>
    <p className="goal-card-text" title={goal.text}>{goal.text}</p>
    <div className="hint">
      {goal.runCount}/{goal.maxRuns} 轮 · 累计 {fmtDuration(goal.totalDurationMs) || '0s'}
      {goal.currentRunId ? ' · 执行中' : ''}
      {goal.failures ? ` · 失败 ${goal.failures}/2` : ''}
    </div>
    {(goal.stopReason || (goal.noProgress ?? 0) > 0 || (goal.blockCount ?? 0) > 0) && (
      <div className="hint goal-panel-reason">
        {goal.stopReason ? `护栏：${goal.stopReason}` : '护栏监测中'}
        {(goal.noProgress ?? 0) > 0 ? ` · 连续无进展 ${goal.noProgress}` : ''}
        {(goal.blockCount ?? 0) > 0 ? ` · 裁判拦截 ${goal.blockCount}/${goal.blockCap ?? 8}` : ''}
      </div>
    )}
    {goal.blockedReason && <div className="hint goal-panel-reason" title={goal.blockedReason}>{goal.blockedReason}</div>}
    {goal.completionConditions.length > 0 && <div className="goal-card-conds">
      {goal.completionConditions.slice(0, 3).map((condition) => <span key={condition} className="goal-cond"><CircleDashed size={11} /> {condition}</span>)}
      {goal.completionConditions.length > 3 && <span className="hint">还有 {goal.completionConditions.length - 3} 条…</span>}
    </div>}
    <div className="goal-card-actions">
      {goalActions(goal.status).map(({ key, label, icon: Icon }) => (
        <button key={key} className="btn" disabled={busy} onClick={() => onAct(goal, key)}><Icon size={12} /> {label}</button>
      ))}
      {!['completed', 'cancelled'].includes(goal.status) && <button className="btn" disabled={busy} title="取消目标" onClick={() => onCancel(goal)}><XCircle size={12} /> 取消</button>}
      <button className="btn goal-card-remove" disabled={busy} title="清除目标模式：删除目标及其 checkpoint，运行中的任务会被取消" onClick={() => onRemove(goal)}><Trash2 size={12} /> 清除</button>
    </div>
  </article>
}
