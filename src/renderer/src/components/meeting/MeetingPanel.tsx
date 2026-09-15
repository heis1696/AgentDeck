import { useEffect, useMemo, useState } from 'react'
import { Check, MessageSquare, Pause, Play, Plus, Send, Square, Users, X } from 'lucide-react'
import { bridge, type AgentInfo } from '../../api'
import { toast } from '../../ui/Toasts'
import type { Meeting, MeetingRole } from '../../../../shared/meeting'

const STATUS_LABEL: Record<Meeting['status'], string> = {
  draft: '草稿', active: '进行中', waiting_user: '等你处理', concluded: '已结束', cancelled: '已取消', failed: '失败'
}
const ROLE_LABEL: Record<MeetingRole, string> = { reporter: '汇报', critic: '质疑', designer: '答辩' }

export function MeetingPanel({ issueId }: { issueId: string }) {
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [topic, setTopic] = useState('')
  const [reporter, setReporter] = useState('')
  const [critic, setCritic] = useState('')
  const [designer, setDesigner] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = () => bridge.meetings.list().then((items) => setMeetings(items.filter((meeting) => meeting.issueId === issueId))).catch(() => {})
  useEffect(() => {
    refresh()
    bridge.agents.list().then((items) => {
      const eligible = items.filter((agent) => agent.backend !== 'dsh')
      setAgents(eligible)
      setReporter((current) => current || eligible[0]?.id || '')
      setCritic((current) => current || eligible[1]?.id || eligible[0]?.id || '')
      setDesigner((current) => current || eligible[2]?.id || eligible[0]?.id || '')
    }).catch(() => {})
    return bridge.meetings.onUpdated((meeting) => { if (meeting.issueId === issueId) refresh() })
  }, [issueId])

  const active = meetings.find((meeting) => meeting.status === 'active' || meeting.status === 'waiting_user') ?? meetings[0]
  const eligible = useMemo(() => agents.filter((agent) => agent.backend !== 'dsh'), [agents])
  const run = async (action: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true)
    const result = await action()
    if (!result.ok) toast.error(result.error ?? '会议操作失败')
    await refresh()
    setBusy(false)
  }
  const create = async () => {
    if (!topic.trim() || !reporter || !critic || !designer || new Set([reporter, critic, designer]).size < 3) {
      toast.error('请填写议题并选择三位不同队长')
      return
    }
    setBusy(true)
    try {
      const meeting = await bridge.meetings.create({ issueId, topic: topic.trim(), participants: [
        { agentId: reporter, role: 'reporter' }, { agentId: critic, role: 'critic' }, { agentId: designer, role: 'designer' }
      ] })
      setMeetings((items) => [meeting, ...items])
      setTopic('')
      await run(() => bridge.meetings.start(meeting.id))
    } catch (error) { toast.error(error instanceof Error ? error.message : '创建会议失败'); setBusy(false) }
  }
  const selectedName = (id: string) => agents.find((agent) => agent.id === id)?.name ?? id

  return <section className="meeting-panel">
    <div className="meeting-panel-head"><div><div className="meeting-kicker"><MessageSquare size={13} /> 结构化会议</div><strong>{active ? STATUS_LABEL[active.status] : '围绕这个 Issue 开会'}</strong></div><Users size={16} className="meeting-head-icon" /></div>
    {!active && <div className="meeting-create">
      <input value={topic} placeholder="会议议题" onChange={(event) => setTopic(event.target.value)} />
      <div className="meeting-selects">
        <label>汇报<select value={reporter} onChange={(event) => setReporter(event.target.value)}>{eligible.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
        <label>质疑<select value={critic} onChange={(event) => setCritic(event.target.value)}>{eligible.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
        <label>答辩<select value={designer} onChange={(event) => setDesigner(event.target.value)}>{eligible.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
      </div>
      <button className="btn primary meeting-create-btn" disabled={busy || eligible.length < 3} onClick={() => void create()}><Plus size={14} /> 开始会议</button>
    </div>}
    {active && <>
      <div className={`meeting-status-line status-${active.status}`}><span className="meeting-status-dot" /><span>第 {active.round || 1} / {active.maxRounds} 轮</span><span className="meeting-stop-reason">{active.stopReason ?? '主持人调度中'}</span></div>
      <div className="meeting-participants">{active.participants.map((participant) => <div className="meeting-participant" key={participant.agentId}><span className="meeting-role">{ROLE_LABEL[participant.role]}</span><span>{selectedName(participant.agentId)}</span><span className={`meeting-mini-status ${active.status}`} /></div>)}</div>
      {active.minutes.length > 0 && <div className="meeting-minutes"><span className="prop-label">最新纪要</span><p>{active.minutes[active.minutes.length - 1].summary || `${active.minutes[active.minutes.length - 1].decisions.length} 项决定，${active.minutes[active.minutes.length - 1].objections.length} 条反对`}</p>{active.minutes[active.minutes.length - 1].openQuestions.length > 0 && <div className="meeting-open">待处理：{active.minutes[active.minutes.length - 1].openQuestions.join('；')}</div>}</div>}
      <div className="meeting-actions">
        {active.status === 'draft' && <button className="icon-btn" title="启动会议" disabled={busy} onClick={() => void run(() => bridge.meetings.start(active.id))}><Play size={14} /></button>}
        {active.status === 'active' && <button className="icon-btn" title="暂停会议" disabled={busy} onClick={() => void run(() => bridge.meetings.pause(active.id))}><Pause size={14} /></button>}
        {active.status === 'waiting_user' && <button className="icon-btn" title="继续会议" disabled={busy} onClick={() => void run(() => bridge.meetings.resume(active.id))}><Play size={14} /></button>}
        {(active.status === 'active' || active.status === 'waiting_user') && <button className="icon-btn danger-icon" title="取消会议" disabled={busy} onClick={() => void run(() => bridge.meetings.cancel(active.id))}><Square size={14} /></button>}
        <div className="meeting-interject"><input value={note} placeholder="主席插话" onChange={(event) => setNote(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && note.trim()) { void run(() => bridge.meetings.interject(active.id, note)); setNote('') } }} /><button className="icon-btn" title="发送插话" disabled={busy || !note.trim() || active.status !== 'active'} onClick={() => { void run(() => bridge.meetings.interject(active.id, note)); setNote('') }}><Send size={13} /></button></div>
      </div>
      {active.status === 'concluded' && active.minutes.at(-1)?.actionItems.map((item, index) => <div className="meeting-action-item" key={`${item.title}-${index}`}><span>{item.title}</span>{item.approval === 'pending' ? <span className="meeting-approval"><button className="icon-btn" title="批准行动项" onClick={() => void run(() => bridge.meetings.approveAction(active.id, index, 'approved'))}><Check size={13} /></button><button className="icon-btn danger-icon" title="拒绝行动项" onClick={() => void run(() => bridge.meetings.approveAction(active.id, index, 'rejected'))}><X size={13} /></button></span> : <span className="badge">{item.approval === 'approved' ? '已批准' : '已拒绝'}</span>}</div>)}
    </>}
  </section>
}
