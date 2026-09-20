import { useEffect, useState } from 'react'
import { Check, Pause, Play, Send, Square, X } from 'lucide-react'
import { bridge } from '../../api'
import { isComposingKey } from '../../ui/interaction-center'
import type { AgentInfo } from '../../../../shared/contracts'
import type { Meeting, MeetingRole, MeetingTurnPhase } from '../../../../shared/meeting'

export const MEETING_STATUS_LABEL: Record<Meeting['status'], string> = {
  draft: '草稿', active: '进行中', waiting_user: '等你处理', concluded: '已结束', cancelled: '已取消', failed: '失败'
}
const ROLE_LABEL: Record<MeetingRole, string> = { reporter: '汇报', critic: '质疑', designer: '答辩' }
const PHASE_LABEL: Record<MeetingTurnPhase, string> = { report: '汇报', challenge: '质疑', defense: '答辩', synthesis: '综合' }

type MeetingRun = (action: () => Promise<{ ok: boolean; error?: string }>) => Promise<unknown>

/** 单场会议的展示与管控：状态行、参与者、最新纪要、暂停/继续/取消/插话与行动项审批（Issue 侧栏与全局会议页共用） */
export function MeetingCard({ meeting, agents, run }: { meeting: Meeting; agents: AgentInfo[]; run: MeetingRun }) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    // start/resume 的 IPC 要等整场会议结束才返回；本场转入 active 即释放 busy，
    // 别让暂停/取消/插话禁用到散会（MeetingPanel 同款缺陷的同款处理）
    return bridge.meetings.onUpdated((next) => { if (next.id === meeting.id && next.status === 'active') setBusy(false) })
  }, [meeting.id])

  const guard = async (action: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true)
    try { await run(action) } finally { setBusy(false) }
  }
  const selectedName = (id: string) => agents.find((agent) => agent.id === id)?.name ?? id
  const latest = meeting.minutes[meeting.minutes.length - 1]
  const sendNote = () => {
    const text = note.trim()
    if (!text) return
    setNote('')
    void guard(() => bridge.meetings.interject(meeting.id, text))
  }

  return <>
    <div className={`meeting-status-line status-${meeting.status}`}><span className="meeting-status-dot" /><span>第 {meeting.round || 1} / {meeting.maxRounds} 轮</span><span className="meeting-stop-reason">{meeting.stopReason ?? '主持人调度中'}</span></div>
    {meeting.status === 'active' && meeting.currentTurn && <div className="meeting-live">🗣 {ROLE_LABEL[meeting.currentTurn.role]}·{selectedName(meeting.currentTurn.agentId)} 发言中（{PHASE_LABEL[meeting.currentTurn.phase]}）——单回合含调查可达 10 分钟以上，请耐心等待</div>}
    <div className="meeting-participants">{meeting.participants.map((participant) => <div className="meeting-participant" key={participant.agentId}><span className="meeting-role">{ROLE_LABEL[participant.role]}</span><span>{selectedName(participant.agentId)}</span><span className={`meeting-mini-status ${meeting.status}`} /></div>)}</div>
    {latest && <div className="meeting-minutes"><span className="prop-label">最新纪要</span><p>{latest.summary || `${latest.decisions.length} 项决定，${latest.objections.length} 条反对`}</p>{latest.openQuestions.length > 0 && <div className="meeting-open">待处理：{latest.openQuestions.join('；')}</div>}</div>}
    <div className="meeting-actions">
      {meeting.status === 'draft' && <button className="icon-btn" title="启动会议" disabled={busy} onClick={() => void guard(() => bridge.meetings.start(meeting.id))}><Play size={14} /></button>}
      {meeting.status === 'active' && <button className="icon-btn" title="暂停会议" disabled={busy} onClick={() => void guard(() => bridge.meetings.pause(meeting.id))}><Pause size={14} /></button>}
      {meeting.status === 'waiting_user' && <button className="icon-btn" title="继续会议" disabled={busy} onClick={() => void guard(() => bridge.meetings.resume(meeting.id))}><Play size={14} /></button>}
      {(meeting.status === 'active' || meeting.status === 'waiting_user') && <button className="icon-btn danger-icon" title="取消会议" disabled={busy} onClick={() => void guard(() => bridge.meetings.cancel(meeting.id))}><Square size={14} /></button>}
      <div className="meeting-interject"><input value={note} placeholder="主席插话" onChange={(event) => setNote(event.target.value)} onKeyDown={(event) => { if (isComposingKey(event.nativeEvent)) return; if (event.key === 'Enter' && note.trim()) sendNote() }} /><button className="icon-btn" title="发送插话" disabled={busy || !note.trim() || meeting.status !== 'active'} onClick={sendNote}><Send size={13} /></button></div>
    </div>
    {meeting.status === 'concluded' && meeting.minutes.at(-1)?.actionItems.map((item, index) => <div className="meeting-action-item" key={`${item.title}-${index}`}><span>{item.title}</span>{item.approval === 'pending' ? <span className="meeting-approval"><button className="icon-btn" title="批准行动项" onClick={() => void guard(() => bridge.meetings.approveAction(meeting.id, index, 'approved'))}><Check size={13} /></button><button className="icon-btn danger-icon" title="拒绝行动项" onClick={() => void guard(() => bridge.meetings.approveAction(meeting.id, index, 'rejected'))}><X size={13} /></button></span> : <span className="badge">{item.approval === 'approved' ? '已批准' : '已拒绝'}</span>}</div>)}
  </>
}
