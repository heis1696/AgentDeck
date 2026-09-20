import { useEffect, useRef, useState } from 'react'
import { Check, Pause, Play, Send, Square, X } from 'lucide-react'
import { bridge } from '../../api'
import { isComposingKey, ui } from '../../ui/interaction-center'
import type { AgentInfo } from '../../../../shared/contracts'
import type { Meeting, MeetingRole, MeetingTurnPhase } from '../../../../shared/meeting'

export const MEETING_STATUS_LABEL: Record<Meeting['status'], string> = {
  draft: '草稿', active: '进行中', waiting_user: '等你处理', concluded: '已结束', cancelled: '已取消', failed: '失败'
}
const ROLE_LABEL: Record<MeetingRole, string> = { reporter: '汇报', critic: '质疑', designer: '答辩' }
const PHASE_LABEL: Record<MeetingTurnPhase, string> = { report: '汇报', challenge: '质疑', defense: '答辩', synthesis: '综合' }
const MEETING_STOP_REASON_LABEL: Record<string, string> = {
  converged: '已达成共识，请复核行动项',
  no_progress: '已暂停，等待你的决定',
  budget: '会议预算已耗尽，等待你的决定',
  failed: '会议执行失败',
}

type MeetingRun = (action: () => Promise<{ ok: boolean; error?: string }>) => Promise<{ ok: boolean; error?: string }>
type PendingAction = string | null

/** 单场会议的展示与管控：状态行、参与者、最新纪要、暂停/继续/取消/插话与行动项审批（Issue 侧栏与全局会议页共用） */
export function MeetingCard({ meeting, agents, run }: { meeting: Meeting; agents: AgentInfo[]; run: MeetingRun }) {
  const [note, setNote] = useState('')
  const noteRevision = useRef(0)
  const actionSequence = useRef(0)
  const [noteError, setNoteError] = useState<string | null>(null)
  const [pendingAction, setPendingActionState] = useState<PendingAction>(null)
  const [pendingApproval, setPendingApproval] = useState<number | null>(null)
  const pendingActionRef = useRef<PendingAction>(null)
  const pendingCancelConfirmRef = useRef(false)
  const pendingApprovalRef = useRef<number | null>(null)

  const setPendingAction = (value: PendingAction) => {
    pendingActionRef.current = value
    setPendingActionState(value)
  }

  useEffect(() => {
    // start/resume 的 IPC 要等整场会议结束才返回；转入 active 后只释放启动/继续按钮，
    // 让暂停、取消和插话仍能在会议进行中使用。
    return bridge.meetings.onUpdated((next) => {
      if (next.id !== meeting.id) return
      if (next.status === 'active' && (pendingActionRef.current === 'start' || pendingActionRef.current === 'resume')) setPendingAction(null)
      if (['concluded', 'cancelled', 'failed'].includes(next.status)) setPendingAction(null)
    })
  }, [meeting.id])

  const guard = async (name: string, action: () => Promise<{ ok: boolean; error?: string }>) => {
    if (pendingActionRef.current) return null
    const sequence = ++actionSequence.current
    setPendingAction(name)
    try {
      return await run(action)
    } catch (error) {
      ui.toast.error(error instanceof Error ? error.message : String(error))
      return null
    } finally {
      if (sequence === actionSequence.current && pendingActionRef.current === name) setPendingAction(null)
    }
  }
  const selectedName = (id: string) => agents.find((agent) => agent.id === id)?.name ?? id
  const latest = meeting.minutes[meeting.minutes.length - 1]
  const stopReason = meeting.status === 'cancelled'
    ? (meeting.blockedReason ?? '已取消，会议记录保留')
    : (meeting.stopReason ? MEETING_STOP_REASON_LABEL[meeting.stopReason] ?? meeting.stopReason.replaceAll('_', ' ') : '主持人调度中')
  const sendNote = () => {
    if (meeting.status !== 'active' || pendingActionRef.current) return
    const text = note.trim()
    if (!text) return
    const submittedRevision = noteRevision.current
    void (async () => {
      const result = await guard(`interject:${meeting.id}`, () => bridge.meetings.interject(meeting.id, text))
      if (!result?.ok) {
        setNoteError(result?.error ?? '插话发送失败')
        return
      }
      if (submittedRevision === noteRevision.current) { noteRevision.current++; setNote('') }
      setNoteError(null)
    })()
  }
  const cancelMeeting = async () => {
    if (pendingActionRef.current || pendingCancelConfirmRef.current || !['active', 'waiting_user'].includes(meeting.status)) return
    pendingCancelConfirmRef.current = true
    try {
      const yes = await ui.confirm({
        title: '取消会议？',
        body: meeting.status === 'active'
          ? '会停止当前会议及正在运行的与会任务，并将会议标为已取消。已产生的发言和纪要会保留，取消后不能继续。'
          : '会将等待中的会议标为已取消。已产生的发言和纪要会保留，取消后不能继续。',
        danger: true,
        confirmText: '取消会议'
      })
      if (yes) await guard('cancel', () => bridge.meetings.cancel(meeting.id))
    } finally {
      pendingCancelConfirmRef.current = false
    }
  }
  const approveAction = async (index: number, title: string, owner: string, acceptance: string[]) => {
    if (pendingActionRef.current || pendingApprovalRef.current !== null || meeting.status !== 'concluded') return
    pendingApprovalRef.current = index
    setPendingApproval(index)
    try {
      const yes = await ui.confirm({
        title: '批准并开始执行？',
        body: `将批准行动项“${title}”，负责人：${owner}。批准后会释放已停放的任务并立即开始执行；验收条件：${acceptance.length ? acceptance.join('；') : '未提供'}。`,
        confirmText: '批准并开始执行'
      })
      if (yes) await guard(`approve:${index}`, () => bridge.meetings.approveAction(meeting.id, index, 'approved'))
    } finally {
      pendingApprovalRef.current = null
      setPendingApproval(null)
    }
  }

  return <>
    <div className={`meeting-status-line status-${meeting.status}`}><span className="meeting-status-dot" /><span>第 {meeting.round || 1} / {meeting.maxRounds} 轮</span><span className="meeting-stop-reason">{stopReason}</span></div>
    {meeting.status === 'active' && meeting.currentTurn && <div className="meeting-live">🗣 {ROLE_LABEL[meeting.currentTurn.role]}·{selectedName(meeting.currentTurn.agentId)} 发言中（{PHASE_LABEL[meeting.currentTurn.phase]}）——单回合含调查可达 10 分钟以上，请耐心等待</div>}
    <div className="meeting-participants">{meeting.participants.map((participant) => <div className="meeting-participant" key={participant.agentId}><span className="meeting-role">{ROLE_LABEL[participant.role]}</span><span>{selectedName(participant.agentId)}</span><span className={`meeting-mini-status ${meeting.status}`} /></div>)}</div>
    {latest && <div className="meeting-minutes"><span className="prop-label">最新纪要</span><p>{latest.summary || `${latest.decisions.length} 项决定，${latest.objections.length} 条反对`}</p>{latest.openQuestions.length > 0 && <div className="meeting-open">待处理：{latest.openQuestions.join('；')}</div>}</div>}
    <div className="meeting-actions">
      {meeting.status === 'draft' && <button className="icon-btn" title="启动会议" disabled={pendingAction === 'start'} onClick={() => void guard('start', () => bridge.meetings.start(meeting.id))}><Play size={14} /></button>}
      {meeting.status === 'active' && <button className="icon-btn" title="暂停会议" disabled={pendingAction === 'pause'} onClick={() => void guard('pause', () => bridge.meetings.pause(meeting.id))}><Pause size={14} /></button>}
      {meeting.status === 'waiting_user' && <button className="icon-btn" title="继续会议" disabled={pendingAction === 'resume'} onClick={() => void guard('resume', () => bridge.meetings.resume(meeting.id))}><Play size={14} /></button>}
      {(meeting.status === 'active' || meeting.status === 'waiting_user') && <button className="icon-btn danger-icon" title="取消会议：停止任务并保留会议记录" disabled={pendingAction === 'cancel'} onClick={() => void cancelMeeting()}><Square size={14} /></button>}
      <div className="meeting-interject">
        <input value={note} placeholder="主席插话" aria-label="主席插话" onChange={(event) => { noteRevision.current++; setNote(event.target.value); setNoteError(null) }} onKeyDown={(event) => { if (isComposingKey(event.nativeEvent)) return; if (event.key === 'Enter' && meeting.status === 'active' && !pendingActionRef.current && note.trim()) { event.preventDefault(); sendNote() } }} />
        <button className="icon-btn" title={pendingAction === `interject:${meeting.id}` ? '插话发送中' : '发送插话'} disabled={pendingAction === `interject:${meeting.id}` || !note.trim() || meeting.status !== 'active'} onClick={sendNote}><Send size={13} /></button>
      </div>
    </div>
    {pendingAction === `interject:${meeting.id}` && <div className="meeting-interject-state" data-interject-state="pending">插话发送中…</div>}
    {noteError && <div className="meeting-interject-state error" data-interject-state="error">{noteError}，草稿已保留</div>}
    {meeting.status === 'concluded' && meeting.minutes.at(-1)?.actionItems.map((item, index) => {
      const owner = selectedName(item.ownerAgentId)
      return <div className="meeting-action-item" key={`${item.title}-${index}`}>
        <div className="meeting-action-copy"><strong className="meeting-action-title">{item.title}</strong><span className="meeting-action-meta">负责人：{owner}</span><span className="meeting-action-meta">验收条件：{item.acceptance.length ? item.acceptance.join('；') : '未提供'}</span></div>
        {item.approval === 'pending' ? <span className="meeting-approval">
          <button className="btn primary" disabled={pendingAction !== null || pendingApproval !== null} title="批准后立即释放停放任务并开始执行" onClick={() => void approveAction(index, item.title, owner, item.acceptance)}><Check size={13} /> 批准并开始执行</button>
          <button className="btn ghost danger-icon" disabled={pendingAction !== null || pendingApproval !== null} title="拒绝行动项，不会启动任务" onClick={() => void guard(`reject:${index}`, () => bridge.meetings.approveAction(meeting.id, index, 'rejected'))}><X size={13} /> 拒绝</button>
        </span> : <span className="badge">{item.approval === 'approved' ? '已批准并已启动' : '已拒绝（未启动）'}</span>}
      </div>
    })}
  </>
}
