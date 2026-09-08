import { useCallback, useEffect, useState } from 'react'
import { Target, Play, Pause, XCircle, Plus, RotateCw, ChevronDown, ChevronRight, Flag, CircleCheck, CircleDashed } from 'lucide-react'
import { bridge, fmtDuration, fmtTime } from '../../api'
import { toast } from '../../ui/Toasts'
import { Menu } from '../../ui/Menu'
import { GOAL_STATUS_LABELS } from '../../labels'
import { BACKEND_IDS } from '../../../../shared/types'
import type { Goal, GoalRun, GoalCheckpoint } from '../../../../shared/types'
import type { AgentInfo } from '../../../../shared/contracts'

/** 状态色：进行中蓝、等待琥珀、完成绿、其余灰/红 */
const STATUS_COLORS: Record<Goal['status'], string> = {
  draft: '#8b95a5', active: '#4f8cff', waiting_user: '#e8a13c',
  completed: '#3cb96e', blocked: '#e8a13c', cancelled: '#8b95a5', failed: '#e05252'
}

/** 状态机驱动的操作按钮：draft 启动 / active 暂停 / waiting·blocked·failed 继续 / 终态无操作 */
function goalActions(status: Goal['status']): Array<{ key: string; label: string; icon: typeof Play }> {
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
  backend: string
  startNow: boolean
}

const lines = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean)

/** 目标页：长期目标由 Agent 多轮推进，受完成/停止条件与预算约束，每轮留 checkpoint。 */
export function GoalsView({ workspaceDir }: { workspaceDir: string }) {
  const [goals, setGoals] = useState<Goal[]>([])
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [degraded, setDegraded] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [runs, setRuns] = useState<GoalRun[]>([])
  const [checkpoints, setCheckpoints] = useState<GoalCheckpoint[]>([])
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState<CreateDraft>({ text: '', completion: '', stop: '', maxRuns: 5, hours: 8, agentId: '', backend: 'zcode', startNow: true })

  const refresh = useCallback(async () => {
    try {
      setGoals(await bridge.goals.list())
      setDegraded(false)
    } catch {
      setDegraded(true)
    }
  }, [])

  useEffect(() => {
    void refresh()
    bridge.agents.list().then(setAgents).catch(() => {})
    const off = bridge.goals.onUpdated((goal) => setGoals((cur) => (cur.some((g) => g.id === goal.id) ? cur.map((g) => (g.id === goal.id ? goal : g)) : [...cur, goal])))
    return off
  }, [refresh])

  const toggleDetail = async (id: string) => {
    if (expandedId === id) { setExpandedId(null); return }
    setExpandedId(id)
    try {
      const [nextRuns, nextCheckpoints] = await Promise.all([bridge.goals.runs(id), bridge.goals.checkpoints(id)])
      setRuns(nextRuns); setCheckpoints(nextCheckpoints)
    } catch {
      setRuns([]); setCheckpoints([])
    }
  }

  const act = async (goal: Goal, key: string) => {
    const call = key === 'start' ? bridge.goals.start : key === 'pause' ? bridge.goals.pause : key === 'continue' ? bridge.goals.continue : bridge.goals.resume
    const res = await call(goal.id).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
    if (!res.ok) toast.error(`目标操作失败: ${res.error ?? '未知错误'}`)
    await refresh()
  }

  const cancelGoal = async (goal: Goal) => {
    const res = await bridge.goals.cancel(goal.id).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
    if (!res.ok) toast.error(`取消失败: ${res.error ?? '未知错误'}`)
    await refresh()
  }

  const startCreate = () => {
    setDraft({ text: '', completion: '', stop: '', maxRuns: 5, hours: 8, agentId: '', backend: 'zcode', startNow: true })
    setCreating(true)
  }

  const commitCreate = async () => {
    const agent = agents.find((a) => a.id === draft.agentId)
    try {
      await bridge.goals.create({
        text: draft.text.trim(),
        completionConditions: lines(draft.completion),
        stopConditions: lines(draft.stop),
        maxRuns: Math.max(1, Math.floor(draft.maxRuns) || 1),
        maxDurationMs: Math.max(1, Math.floor(draft.hours * 3600_000) || 3600_000),
        workdir: workspaceDir,
        agentId: draft.agentId || undefined,
        backend: agent?.backend ?? draft.backend,
        startNow: draft.startNow
      })
      toast.success('目标已创建')
      setCreating(false)
      await refresh()
    } catch (e) {
      toast.error('创建失败: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const draftAgent = agents.find((a) => a.id === draft.agentId)
  const canCreate = draft.text.trim().length > 0 && lines(draft.completion).length > 0 && !!workspaceDir
  const expanded = goals.find((g) => g.id === expandedId) ?? null

  return <div className="settings goal-page">
    <header className="page-header-bar">
      <div className="page-title-row">
        <Target size={16} className="page-icon" />
        <h2 className="page-title">目标</h2>
        {goals.length > 0 && <span className="page-count">{goals.length}</span>}
        <span className="page-desc">长期目标多轮推进：完成/停止条件与预算受控，每轮结束留 checkpoint 可回看。</span>
      </div>
      <div className="detail-actions">
        <button className="btn" onClick={() => void refresh()}><RotateCw size={14} /> 刷新</button>
        <button className="btn primary" onClick={startCreate}><Plus size={14} /> 新建目标</button>
      </div>
    </header>
    {degraded && <div className="hint goal-degraded">目标数据暂时无法加载，请检查主进程后重试。</div>}
    <div className="agent-grid">
      {goals.map((g) => {
        const agent = agents.find((a) => a.id === g.agentId)
        const isOpen = expandedId === g.id
        return (
          <div key={g.id} className={`agent-card goal-card ${isOpen ? 'open' : ''}`} role="button" tabIndex={0}
            onClick={() => void toggleDetail(g.id)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void toggleDetail(g.id) } }}>
            <div className="agent-avatar" style={{ background: STATUS_COLORS[g.status] }}><Target size={16} /></div>
            <div className="agent-info">
              <div className="agent-name">
                {g.text.length > 64 ? g.text.slice(0, 64) + '…' : g.text}
                <span className="badge">{GOAL_STATUS_LABELS[g.status]}</span>
              </div>
              <div className="hint">
                {g.runCount}/{g.maxRuns} 轮 · 累计 {fmtDuration(g.totalDurationMs) || '0s'}
                {' · '}{agent ? agent.name : g.backend}
                {g.currentRunId ? ' · 执行中' : ''}
                {g.blockedReason ? ` · ${g.blockedReason}` : ''}
              </div>
            </div>
            <div className="detail-actions goal-card-actions" onClick={(e) => e.stopPropagation()}>
              {goalActions(g.status).map(({ key, label, icon: Icon }) => (
                <button key={key} className="btn" onClick={() => void act(g, key)}><Icon size={14} /> {label}</button>
              ))}
              {!['completed', 'cancelled'].includes(g.status) && (
                <button className="btn ghost agent-del" title="取消目标" onClick={() => void cancelGoal(g)}><XCircle size={14} /></button>
              )}
              <button className="btn ghost agent-del" title={isOpen ? '收起' : '展开阶段历史'}>{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
            </div>
          </div>
        )
      })}
      {!degraded && goals.length === 0 && (
        <div className="empty inbox-empty"><Target size={34} /><strong>还没有目标</strong><span>新建一个长期目标，交给 Agent 按完成条件多轮推进。</span></div>
      )}
    </div>
    {expanded && (
      <section className="goal-detail">
        <div className="section-heading"><h3><Flag size={14} /> {expanded.text}</h3><span>{GOAL_STATUS_LABELS[expanded.status]} · 创建于 {fmtTime(expanded.createdAt)}</span></div>
        <div className="goal-conditions">
          <div className="goal-cond-group">
            <strong>完成条件</strong>
            {expanded.completionConditions.map((c) => <span key={c} className="goal-cond"><CircleDashed size={12} /> {c}</span>)}
          </div>
          <div className="goal-cond-group">
            <strong>停止条件</strong>
            {expanded.stopConditions.length ? expanded.stopConditions.map((c) => <span key={c} className="goal-cond stop"><XCircle size={12} /> {c}</span>) : <span className="hint">（无）</span>}
          </div>
        </div>
        <h4>阶段 Checkpoint</h4>
        {checkpoints.length === 0 && <p className="hint">还没有 checkpoint——每轮 Run 结束后由控制器生成摘要。</p>}
        {checkpoints.map((cp) => (
          <div key={cp.id} className="goal-checkpoint">
            <div className="goal-cp-head"><span className="badge">第 {cp.phaseIndex + 1} 轮</span><time>{fmtTime(cp.createdAt)}</time>{cp.durationMs ? <span className="hint">{fmtDuration(cp.durationMs)}</span> : null}</div>
            <p>{cp.summary}</p>
            <div className="goal-cond-group">
              {cp.completedConditions.map((c) => <span key={c} className="goal-cond done"><CircleCheck size={12} /> {c}</span>)}
              {cp.incompleteConditions.map((c) => <span key={c} className="goal-cond"><CircleDashed size={12} /> {c}</span>)}
            </div>
            {cp.nextPlan && <p className="hint">下一步：{cp.nextPlan}</p>}
            {cp.blockers.length > 0 && <p className="hint">阻塞：{cp.blockers.join('；')}</p>}
          </div>
        ))}
        <h4>Run 历史</h4>
        {runs.length === 0 && <p className="hint">还没有 Run 记录。</p>}
        {runs.map((r) => (
          <div key={r.id} className="goal-run">
            <span className="badge">第 {r.phaseIndex + 1} 轮</span>
            <span className="hint">{r.trigger} · {r.status}{r.startedAt ? ` · ${fmtTime(r.startedAt)}` : ''}{r.durationMs ? ` · ${fmtDuration(r.durationMs)}` : ''}</span>
          </div>
        ))}
      </section>
    )}
    {creating && (
      <div className="overlay" onClick={(e) => e.target === e.currentTarget && setCreating(false)}>
        <div className="dialog">
          <h2>新建目标</h2>
          <label className="field"><span>目标 *</span><textarea value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} rows={3} autoFocus placeholder="如：把 docs/ 下的 API 文档全部对齐当前代码" /></label>
          <label className="field"><span>完成条件 *（每行一条）</span><textarea value={draft.completion} onChange={(e) => setDraft({ ...draft, completion: e.target.value })} rows={3} placeholder={'每条一行，如：\n所有示例可编译\n接口签名与 src 一致'} /></label>
          <label className="field"><span>停止条件（每行一条，命中即暂停）</span><textarea value={draft.stop} onChange={(e) => setDraft({ ...draft, stop: e.target.value })} rows={2} placeholder={'如：\n需要删除用户数据\n需要付费 API 密钥'} /></label>
          <div className="row" style={{ gap: 12 }}>
            <label className="field" style={{ flex: 1 }}><span>最大轮数</span><input type="number" min={1} value={draft.maxRuns} onChange={(e) => setDraft({ ...draft, maxRuns: Number(e.target.value) })} /></label>
            <label className="field" style={{ flex: 1 }}><span>最长总时长（小时）</span><input type="number" min={0.5} step={0.5} value={draft.hours} onChange={(e) => setDraft({ ...draft, hours: Number(e.target.value) })} /></label>
          </div>
          <label className="field">
            <span>执行 Agent（空 = 用下方平台默认）</span>
            <Menu
              items={[{ value: '', label: '不指定（按平台默认执行）' }, ...agents.map((a) => ({ value: a.id, label: a.name }))]}
              value={draft.agentId}
              onChange={(v) => setDraft({ ...draft, agentId: v })}
              trigger={(cur, open) => <button className="btn menu-trigger" type="button">{cur?.label ?? '不指定'} <span className="menu-caret">{open ? '▴' : '▾'}</span></button>}
            />
          </label>
          {!draft.agentId && (
            <label className="field">
              <span>平台 *</span>
              <Menu
                items={BACKEND_IDS.map((b) => ({ value: b, label: b }))}
                value={draft.backend}
                onChange={(v) => setDraft({ ...draft, backend: v })}
                trigger={(cur, open) => <button className="btn menu-trigger" type="button">{cur?.label ?? draft.backend} <span className="menu-caret">{open ? '▴' : '▾'}</span></button>}
              />
            </label>
          )}
          <label className="field row" style={{ gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={draft.startNow} onChange={(e) => setDraft({ ...draft, startNow: e.target.checked })} />
            <span>创建后立即启动第一轮</span>
          </label>
          <div className="dialog-footer">
            <span className="hint">工作区：{workspaceDir || '（未选择工作区，无法创建）'}</span>
            <button className="btn primary" disabled={!canCreate} onClick={() => void commitCreate()}>创建</button>
          </div>
        </div>
      </div>
    )}
  </div>
}
