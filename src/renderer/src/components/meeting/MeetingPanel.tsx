import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MessageSquare, Plus, Users } from 'lucide-react'
import { bridge, type AgentInfo } from '../../api'
import { ui } from '../../ui/interaction-center'
import { FloatWindow } from '../../ui/FloatWindow'
import { captains } from './captains'
import { isForgeAgent } from '../../../../shared/forge'
import { MeetingCard, MEETING_STATUS_LABEL } from './MeetingCard'
import type { Meeting } from '../../../../shared/meeting'

type MeetingDataState = 'loading' | 'ready' | 'error'

/**
 * 结构化会议浮窗（Issue 详情头部 💬 芯片 / 追问框 /meeting 命令唤起）：
 * 会议数据始终加载并经 onMeeting 上报宿主（驱动头部芯片），
 * 浮窗本体仅 open 时渲染；无进行中会议时浮窗内直接给创建表单。
 */
export function MeetingPanel({ issueId, open, onToggle, onMeeting }: {
  issueId: string
  open: boolean
  onToggle: (open: boolean) => void
  onMeeting: (meeting: Meeting | null) => void
}) {
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [readState, setReadState] = useState<MeetingDataState>('loading')
  const [readError, setReadError] = useState<string | null>(null)
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [agentError, setAgentError] = useState<string | null>(null)
  const [topic, setTopic] = useState('')
  const [reporter, setReporter] = useState('')
  const [critic, setCritic] = useState('')
  const [designer, setDesigner] = useState('')
  const [busy, setBusy] = useState(false)
  const [newMeeting, setNewMeeting] = useState(false)
  const readSeq = useRef(0)
  const creatingRef = useRef(false)

  const refresh = useCallback(async () => {
    const seq = ++readSeq.current
    setReadState('loading')
    try {
      const items = await bridge.meetings.list()
      if (seq !== readSeq.current) return
      setMeetings(items.filter((meeting) => meeting.issueId === issueId))
      setReadError(null)
      setReadState('ready')
    } catch (error) {
      if (seq !== readSeq.current) return
      setReadError(error instanceof Error ? error.message : String(error))
      setReadState('error')
    }
  }, [issueId])

  const refreshAgents = useCallback(async () => {
    try {
      const items = await bridge.agents.list()
      const eligible = captains(items)
      setAgents(eligible)
      setAgentError(null)
      setReporter((current) => current || eligible[0]?.id || '')
      setCritic((current) => current || eligible[1]?.id || eligible[0]?.id || '')
      setDesigner((current) => current || eligible[2]?.id || eligible[0]?.id || '')
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  useEffect(() => {
    void refresh()
    void refreshAgents()
    const off = bridge.meetings.onUpdated((meeting) => {
      if (meeting.issueId !== issueId) return
      readSeq.current++
      // start/resume 的 IPC 要等整场会议结束才返回；会议转入 active 即释放 busy，
      // 别让暂停/取消/插话禁用到散会（切换视图才恢复的同款缺陷；单卡管控由 MeetingCard 自行释放）
      if (meeting.status === 'active') setBusy(false)
      setReadState('ready')
      setReadError(null)
      setMeetings((currentMeetings) => currentMeetings.some((current) => current.id === meeting.id)
        ? currentMeetings.map((current) => current.id === meeting.id ? meeting : current)
        : [meeting, ...currentMeetings])
    })
    const offDeleted = bridge.meetings.onDeleted((id) => { setMeetings((items) => items.filter((meeting) => meeting.id !== id)); void refresh() })
    return () => { readSeq.current++; off(); offDeleted() }
  }, [issueId, refresh, refreshAgents])

  // 上报当前会议给宿主（头部 💬 芯片）：仅活跃（进行中/等你处理）才算
  const current = meetings.find((meeting) => meeting.status === 'active' || meeting.status === 'waiting_user')
  useEffect(() => { onMeeting(current ?? null) }, [current, onMeeting])

  const eligible = useMemo(() => agents.filter((agent) => agent.backend !== 'dsh' && !isForgeAgent(agent)), [agents])
  const run = async (action: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true)
    try {
      const result = await action()
      if (!result.ok) ui.toast.error(result.error ?? '会议操作失败')
      await refresh()
      return result
    } finally {
      setBusy(false)
    }
  }
  const create = async () => {
    if (creatingRef.current || readState !== 'ready' || agentError) return
    if (!topic.trim() || !reporter || !critic || !designer || new Set([reporter, critic, designer]).size < 3) {
      ui.toast.error('请填写议题并选择三位不同队长')
      return
    }
    creatingRef.current = true
    setBusy(true)
    try {
      const meeting = await bridge.meetings.create({ issueId, topic: topic.trim(), participants: [
        { agentId: reporter, role: 'reporter' }, { agentId: critic, role: 'critic' }, { agentId: designer, role: 'designer' }
      ] })
      setMeetings((items) => [meeting, ...items])
      setTopic('')
      setNewMeeting(false)
      await run(() => bridge.meetings.start(meeting.id))
    } catch (error) { ui.toast.error(error instanceof Error ? error.message : '创建会议失败') }
    finally { creatingRef.current = false; setBusy(false) }
  }
  const active = current ?? (newMeeting ? undefined : meetings[0])
  const showCreate = readState === 'ready' && !active

  return <>
    {open && <FloatWindow title="团队会议" icon={<MessageSquare size={13} />} onClose={() => onToggle(false)}>
      <section className="meeting-panel float-panel">
        <div className="meeting-panel-head"><div><div className="meeting-kicker"><MessageSquare size={13} /> 结构化会议</div><strong>{active ? MEETING_STATUS_LABEL[active.status] : '围绕这个 Issue 开会'}</strong></div><span className="meeting-head-actions">{meetings[0] && !current && !newMeeting && <button className="icon-btn" title="新建会议" onClick={() => setNewMeeting(true)}><Plus size={14} /></button>}<Users size={16} className="meeting-head-icon" /></span></div>
        {readState === 'loading' && !meetings.length && <div className="meeting-empty" data-meeting-state="loading"><span className="hint">正在读取会议记录…</span></div>}
        {readState === 'error' && <div className="meeting-empty" data-meeting-state={meetings.length ? 'stale' : 'error'}>
          <strong>{meetings.length ? '会议读取失败，当前显示上次成功数据' : '会议记录读取失败'}</strong>
          <span className="hint">{readError || '请重试后再创建或操作会议。'}</span>
          <button className="btn" disabled={busy} onClick={() => void refresh()}><Plus size={13} /> 重试读取</button>
        </div>}
        {showCreate && <div className="meeting-create" data-meeting-state={meetings.length ? 'new' : 'empty'}>
          {!meetings.length && <div className="hint">当前 Issue 还没有会议记录。</div>}
          {agentError && <div className="meeting-read-error" data-meeting-agent-error>参与者读取失败：{agentError}<button className="btn ghost" type="button" onClick={() => void refreshAgents()}>重试参与者</button></div>}
          <input value={topic} placeholder="会议议题" onChange={(event) => setTopic(event.target.value)} />
          <div className="meeting-selects">
            <label>汇报<select value={reporter} onChange={(event) => setReporter(event.target.value)}>{eligible.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
            <label>质疑<select value={critic} onChange={(event) => setCritic(event.target.value)}>{eligible.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
            <label>答辩<select value={designer} onChange={(event) => setDesigner(event.target.value)}>{eligible.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
          </div>
          <button className="btn primary meeting-create-btn" disabled={busy || !!agentError || eligible.length < 3} onClick={() => void create()}><Plus size={14} /> 创建并开始会议</button>
        </div>}
        {active && <MeetingCard key={active.id} meeting={active} agents={agents} run={run} />}
      </section>
    </FloatWindow>}
  </>
}
