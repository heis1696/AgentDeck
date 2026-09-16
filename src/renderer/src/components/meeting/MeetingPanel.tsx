import { useEffect, useMemo, useState } from 'react'
import { MessageSquare, Plus, Users } from 'lucide-react'
import { bridge, type AgentInfo } from '../../api'
import { toast } from '../../ui/Toasts'
import { captains } from './captains'
import { MeetingCard, MEETING_STATUS_LABEL } from './MeetingCard'
import type { Meeting } from '../../../../shared/meeting'

export function MeetingPanel({ issueId }: { issueId: string }) {
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [topic, setTopic] = useState('')
  const [reporter, setReporter] = useState('')
  const [critic, setCritic] = useState('')
  const [designer, setDesigner] = useState('')
  const [busy, setBusy] = useState(false)
  const [newMeeting, setNewMeeting] = useState(false)

  const refresh = () => bridge.meetings.list().then((items) => setMeetings(items.filter((meeting) => meeting.issueId === issueId))).catch(() => {})
  useEffect(() => {
    refresh()
    bridge.agents.list().then((items) => {
      const eligible = captains(items)
      setAgents(eligible)
      setReporter((current) => current || eligible[0]?.id || '')
      setCritic((current) => current || eligible[1]?.id || eligible[0]?.id || '')
      setDesigner((current) => current || eligible[2]?.id || eligible[0]?.id || '')
    }).catch(() => {})
    return bridge.meetings.onUpdated((meeting) => {
      if (meeting.issueId !== issueId) return
      // start/resume 的 IPC 要等整场会议结束才返回；会议转入 active 即释放 busy，
      // 别让暂停/取消/插话禁用到散会（切换视图才恢复的同款缺陷；单卡管控由 MeetingCard 自行释放）
      if (meeting.status === 'active') setBusy(false)
      refresh()
    })
  }, [issueId])

  const eligible = useMemo(() => agents.filter((agent) => agent.backend !== 'dsh'), [agents])
  const run = async (action: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true)
    try {
      const result = await action()
      if (!result.ok) toast.error(result.error ?? '会议操作失败')
      await refresh()
    } finally {
      setBusy(false)
    }
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
      setNewMeeting(false)
      await run(() => bridge.meetings.start(meeting.id))
    } catch (error) { toast.error(error instanceof Error ? error.message : '创建会议失败') }
  }
  const current = meetings.find((meeting) => meeting.status === 'active' || meeting.status === 'waiting_user')
  const active = current ?? (newMeeting ? undefined : meetings[0])

  return <section className="meeting-panel">
    <div className="meeting-panel-head"><div><div className="meeting-kicker"><MessageSquare size={13} /> 结构化会议</div><strong>{active ? MEETING_STATUS_LABEL[active.status] : '围绕这个 Issue 开会'}</strong></div><span className="meeting-head-actions">{meetings[0] && !current && !newMeeting && <button className="icon-btn" title="新建会议" onClick={() => setNewMeeting(true)}><Plus size={14} /></button>}<Users size={16} className="meeting-head-icon" /></span></div>
    {!active && <div className="meeting-create">
      <input value={topic} placeholder="会议议题" onChange={(event) => setTopic(event.target.value)} />
      <div className="meeting-selects">
        <label>汇报<select value={reporter} onChange={(event) => setReporter(event.target.value)}>{eligible.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
        <label>质疑<select value={critic} onChange={(event) => setCritic(event.target.value)}>{eligible.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
        <label>答辩<select value={designer} onChange={(event) => setDesigner(event.target.value)}>{eligible.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
      </div>
      <button className="btn primary meeting-create-btn" disabled={busy || eligible.length < 3} onClick={() => void create()}><Plus size={14} /> 开始会议</button>
    </div>}
    {active && <MeetingCard meeting={active} agents={agents} run={run} />}
  </section>
}
