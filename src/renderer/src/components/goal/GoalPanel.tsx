import { useCallback, useEffect, useState } from 'react'
import { Target, Play, Pause, XCircle, RotateCw, ChevronDown, ChevronRight, CircleCheck, CircleDashed, Zap, Trash2 } from 'lucide-react'
import { bridge, fmtDuration, fmtTime } from '../../api'
import { toast } from '../../ui/Toasts'
import { Menu } from '../../ui/Menu'
import { confirmDialog } from '../../ui/Confirm'
import { GOAL_STATUS_LABELS } from '../../labels'
import type { Goal, GoalCheckpoint, GoalRun, Task } from '../../../../shared/types'
import type { AgentInfo } from '../../../../shared/contracts'

/** 状态色：进行中蓝、等待琥珀、完成绿、其余灰/红（与旧目标页一致） */
const STATUS_COLORS: Record<Goal['status'], string> = {
  draft: '#8b95a5', active: '#4f8cff', waiting_user: '#e8a13c',
  completed: '#3cb96e', blocked: '#e8a13c', cancelled: '#8b95a5', failed: '#e05252'
}

function goalActions(status: Goal['status']): Array<{ key: 'start' | 'pause' | 'continue'; label: string; icon: typeof Play }> {
  switch (status) {
    case 'draft': return [{ key: 'start', label: '启动', icon: Play }]
    case 'active': return [{ key: 'pause', label: '暂停', icon: Pause }]
    case 'waiting_user': return [{ key: 'continue', label: '继续', icon: Play }]
    case 'blocked': case 'failed': return [{ key: 'continue', label: '重试', icon: RotateCw }]
    default: return []
  }
}

interface CreateDraft {
  text: string
  completion: string
  stop: string
  maxRuns: number
  hours: number
  agentId: string
  startNow: boolean
}

const lines = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean)

/**
 * 目标模式面板（嵌在 Issue 详情侧栏）：在一个 Issue 内开启自动推进——
 * 开启后系统按 Loop Engineering 循环回灌推进，直到完成条件全部达成。
 */
export function GoalPanel({ task, issueId }: { task: Task; issueId: string }) {
  const [goal, setGoal] = useState<Goal | null>(null)
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [expanded, setExpanded] = useState(false)
  const [checkpoints, setCheckpoints] = useState<GoalCheckpoint[]>([])
  const [runs, setRuns] = useState<GoalRun[]>([])
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<CreateDraft>({ text: '', completion: '', stop: '', maxRuns: 8, hours: 8, agentId: '', startNow: true })

  useEffect(() => {
    let alive = true
    const pick = (goals: Goal[]) => { if (alive) setGoal(goals.filter((g) => g.issueId === issueId).sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null) }
    void bridge.goals.list().then(pick).catch(() => {})
    const off = bridge.goals.onUpdated((g) => {
      if (g.issueId !== issueId) return
      setGoal((cur) => (!cur || g.id === cur.id || g.updatedAt >= cur.updatedAt) ? g : cur)
    })
    const offDeleted = bridge.goals.onDeleted((goalId) => setGoal((cur) => (cur?.id === goalId ? null : cur)))
    void bridge.agents.list().then((list) => { if (alive) setAgents(list) }).catch(() => {})
    return () => { alive = false; off(); offDeleted() }
  }, [issueId])

  const loadDetail = useCallback(async (id: string) => {
    try {
      const [cps, rs] = await Promise.all([bridge.goals.checkpoints(id), bridge.goals.runs(id)])
      setCheckpoints(cps); setRuns(rs)
    } catch { setCheckpoints([]); setRuns([]) }
  }, [])

  const toggle = () => {
    const next = !expanded
    setExpanded(next)
    if (next && goal) void loadDetail(goal.id)
  }

  const act = async (key: 'start' | 'pause' | 'continue') => {
    if (!goal || busy) return
    setBusy(true)
    const call = key === 'start' ? bridge.goals.start : key === 'pause' ? bridge.goals.pause : bridge.goals.continue
    const res = await call(goal.id).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
    if (!res.ok) toast.error(`目标操作失败: ${res.error ?? '未知错误'}`)
    setBusy(false)
  }

  const cancelGoal = async () => {
    if (!goal || busy) return
    setBusy(true)
    const res = await bridge.goals.cancel(goal.id).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
    if (!res.ok) toast.error(`取消失败: ${res.error ?? '未知错误'}`)
    setBusy(false)
  }

  /** 清除目标模式：删掉目标及其 checkpoint（运行中任务连带取消），面板回到可重新开启的空态 */
  const removeGoal = async () => {
    if (!goal || busy) return
    const yes = await confirmDialog({
      title: '清除目标模式',
      body: '将删除该目标及其全部 checkpoint 记录，运行中的任务会被取消。清除后本 Issue 不再被目标模式锁定，可重新开启。',
      danger: true,
      confirmText: '清除'
    })
    if (!yes) return
    setBusy(true)
    const res = await bridge.goals.delete(goal.id).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
    if (res.ok) {
      setGoal(null)
      setCheckpoints([])
      setRuns([])
    } else {
      toast.error(`清除失败: ${res.error ?? '未知错误'}`)
    }
    setBusy(false)
  }

  const startCreate = () => {
    setDraft({ text: task.title, completion: '', stop: '', maxRuns: 8, hours: 8, agentId: task.agentId ?? '', startNow: true })
    setCreating(true)
  }

  const commitCreate = async () => {
    setBusy(true)
    try {
      const agent = agents.find((a) => a.id === draft.agentId)
      await bridge.goals.create({
        text: draft.text.trim(),
        issueId,
        completionConditions: lines(draft.completion),
        stopConditions: lines(draft.stop),
        maxRuns: Math.max(1, Math.floor(draft.maxRuns) || 1),
        maxDurationMs: Math.max(1, Math.floor(draft.hours * 3600_000) || 3600_000),
        workdir: task.workdir,
        agentId: draft.agentId || undefined,
        backend: agent?.backend ?? task.backend,
        startNow: draft.startNow
      })
      toast.success('目标模式已开启')
      setCreating(false)
    } catch (e) {
      toast.error('开启失败: ' + (e instanceof Error ? e.message : String(e)))
    }
    setBusy(false)
  }

  const agent = agents.find((a) => a.id === goal?.agentId)
  const canCreate = draft.text.trim().length > 0 && lines(draft.completion).length > 0

  return <div className="goal-panel">
    <div className="goal-panel-head">
      <Target size={13} className="page-icon" />
      <span className="prop-group-label" style={{ margin: 0 }}>目标模式</span>
      {goal && <span className="badge" style={{ color: STATUS_COLORS[goal.status] }}>{GOAL_STATUS_LABELS[goal.status]}</span>}
      {goal && !['completed', 'cancelled'].includes(goal.status) && (
        <button className="btn ghost agent-del" title="取消目标" disabled={busy} onClick={() => void cancelGoal()}><XCircle size={13} /></button>
      )}
      {goal && (
        <button className="btn ghost agent-del" title="清除目标模式：删除目标及其 checkpoint，运行中的任务会被取消" disabled={busy} onClick={() => void removeGoal()}><Trash2 size={13} /></button>
      )}
      {goal && <button className="btn ghost agent-del" title={expanded ? '收起' : '展开 checkpoint'} onClick={toggle}>{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>}
    </div>
    {!goal && <div className="goal-panel-empty">
      <span className="hint">开启后 agent 在本 Issue 内自省自推：每轮留 checkpoint，直到完成条件全部达成或触发护栏。</span>
      <button className="btn" disabled={busy} onClick={startCreate}><Zap size={13} /> 开启目标模式</button>
    </div>}
    {goal && <div className="goal-panel-body">
      <div className="goal-panel-goal" title={goal.text}>{goal.text.length > 60 ? goal.text.slice(0, 60) + '…' : goal.text}</div>
      <div className="hint">
        {goal.runCount}/{goal.maxRuns} 轮 · 累计 {fmtDuration(goal.totalDurationMs) || '0s'}
        {agent ? ` · ${agent.name}` : ` · ${goal.backend}`}
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
      <div className="goal-panel-actions">
        {goalActions(goal.status).map(({ key, label, icon: Icon }) => (
          <button key={key} className="btn" disabled={busy} onClick={() => void act(key)}><Icon size={12} /> {label}</button>
        ))}
      </div>
    </div>}
    {expanded && goal && <div className="goal-panel-detail">
      {checkpoints.length === 0 && <p className="hint">还没有 checkpoint——每轮 Run 结束后由控制器生成摘要。</p>}
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
    {creating && (
      <div className="overlay" onClick={(e) => e.target === e.currentTarget && setCreating(false)}>
        <div className="dialog">
          <h2>开启目标模式</h2>
          <p className="hint">在本 Issue 上开启自动推进：agent 每轮自评并继续，直到完成条件全部达成（完成条件须可验证）。</p>
          <label className="field"><span>目标 *</span><textarea value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} rows={3} autoFocus placeholder="如：把 docs/ 下的 API 文档全部对齐当前代码" /></label>
          <label className="field"><span>完成条件 *（每行一条，逐条可验证）</span><textarea value={draft.completion} onChange={(e) => setDraft({ ...draft, completion: e.target.value })} rows={3} placeholder={'每条一行，如：\n所有示例可编译\n接口签名与 src 一致'} /></label>
          <label className="field"><span>停止条件（每行一条，命中即暂停等你决策）</span><textarea value={draft.stop} onChange={(e) => setDraft({ ...draft, stop: e.target.value })} rows={2} placeholder={'如：\n需要删除用户数据\n需要付费 API 密钥'} /></label>
          <div className="row" style={{ gap: 12 }}>
            <label className="field" style={{ flex: 1 }}><span>最大轮数</span><input type="number" min={1} value={draft.maxRuns} onChange={(e) => setDraft({ ...draft, maxRuns: Number(e.target.value) })} /></label>
            <label className="field" style={{ flex: 1 }}><span>最长总时长（小时）</span><input type="number" min={0.5} step={0.5} value={draft.hours} onChange={(e) => setDraft({ ...draft, hours: Number(e.target.value) })} /></label>
          </div>
          <label className="field">
            <span>执行 Agent</span>
            <Menu
              items={[{ value: task.agentId ?? '', label: task.agentId ? '沿用当前 Issue 的 Agent' : '不指定（按平台默认执行）' }, ...agents.filter((a) => a.id !== task.agentId).map((a) => ({ value: a.id, label: a.name }))]}
              value={draft.agentId}
              onChange={(v) => setDraft({ ...draft, agentId: v })}
              trigger={(cur, open) => <button className="btn menu-trigger" type="button">{cur?.label ?? '不指定'} <span className="menu-caret">{open ? '▴' : '▾'}</span></button>}
            />
          </label>
          <label className="field row" style={{ gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={draft.startNow} onChange={(e) => setDraft({ ...draft, startNow: e.target.checked })} />
            <span>立即开始推进</span>
          </label>
          <div className="dialog-footer">
            <span className="hint">工作目录：{task.workdir || '（未绑定）'}</span>
            <button className="btn primary" disabled={!canCreate || busy} onClick={() => void commitCreate()}>开启</button>
          </div>
        </div>
      </div>
    )}
  </div>
}
