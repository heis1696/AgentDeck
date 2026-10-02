/**
 * 独立会议详情页（阶段 3：公开时间线 + 固定成员侧栏）。
 *
 * 组合而非复制：页面骨架沿用普通 Issue 的 PageHeader / .detail 左右分栏 /
 * SideDock（renderTask 插槽），正文气泡用共享 Markdown；会议业务状态全部来自
 * meetingViewState 的纯函数（meetingPresentation / currentMeetingSpeech），
 * 公开发言来自 useMeetingTurns（初次全量分页 + 之后按版本增量的权威 readTurns），
 * 成员执行分栏在 MeetingMemberPane（只消费 readTurns/getTurn/memberExecutions）。
 *
 * 生命周期纪律：
 * - 控制按钮全部走 meetings API 并尊重主进程结果；start/resume 的 IPC 要等整场
 *   会议结束才返回——转入 active 即释放自身占用，绝不因此禁用停止/插话；
 * - stopState 优先于普通终态（停止受阻即使 status=cancelled 也不显示停止成功），
 *   停止失败保留记录并允许重试；失败不冒充退出确认；咨询办公室不纳入停止/删除；
 * - 迟到的控制响应一律先核对会议 id（meetingIdRef）再落地，不能覆盖新会议，
 *   也不能清空发送期间编辑的新插话（composer 按 meeting.id 重挂 + 草稿修订号）；
 * - 侧栏按会议 root 显式 ui.dock.open，默认不抢开；用户关闭后任何事件都不重开，
 *   只能通过成员栏/查看本次执行/重新打开按钮显式恢复；删除成功后清空本会议的
 *   dock 桶与选择缓存。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { MessageSquare, Pause, Play, Square, Trash2 } from 'lucide-react'
import type { Meeting, MeetingTurnDetail } from '../../../../shared/meeting'
import type { IpcResult } from '../../../../shared/contracts'
import type { Task } from '../../../../shared/types'
import { bridge, fmtTime } from '../../api'
import { ui, type DockEntry } from '../../ui/interaction-center'
import { useInteractionSelector } from '../../hooks/useInteraction'
import { useMeetingTurns } from '../../hooks/useMeetingTurns'
import { PageHeader } from '../../ui/PageHeader'
import { Markdown } from '../Markdown'
import { SideDock } from '../../ui/SideDock'
import { currentMeetingSpeech, meetingPresentation, meetingRootId } from './meetingViewState'
import { useMeetingSelection } from './meetingSelection'
import {
  MeetingInvestigationPane, MeetingMemberPane,
  MEETING_ROLE_LABEL, MEETING_TURN_STATUS_LABEL,
  meetingMemberDisplayName, meetingMemberItemId, meetingTurnContextLabel
} from './MeetingMemberPane'
import '../../polish/meeting-detail.css'

const INVESTIGATION_PREFIX = 'meeting-investigation:'

/** 气泡正文：done 用完整 Markdown；缺正文/其余状态都是明确的说明文字，不解析兼容评论顶替 */
function meetingTurnBody(turn: MeetingTurnDetail): { markdown?: string; text: string; kind: 'missing' | 'state' } {
  if (turn.status === 'done') {
    return turn.body !== undefined
      ? { markdown: turn.body, text: '', kind: 'state' }
      : { text: '完整正文缺失，不能用兼容评论或摘要代替。', kind: 'missing' }
  }
  if (turn.status === 'failed') return { text: turn.error ?? '执行失败，本次未发布正式发言。', kind: 'state' }
  if (turn.status === 'speaking') return { text: '正在生成正式发言。内部调查、工具调用和草稿仅在右侧成员分栏查看。', kind: 'state' }
  if (turn.status === 'pending') return { text: '准备公开上下文，尚未投递给成员；正式发言还未开始。', kind: 'state' }
  if (turn.status === 'skipped') return { text: '本次已跳过，没有发布正式发言。', kind: 'state' }
  return { text: '本次已取消，没有发布正式发言。', kind: 'state' }
}

export function MeetingDetail({ meeting, tasks, onDeleted }: {
  meeting: Meeting
  tasks: Task[]
  onDeleted?: (meetingId: string) => void
}) {
  const meetingId = meeting.id
  const rootId = meetingRootId(meetingId)
  const meetingIdRef = useRef(meetingId)
  meetingIdRef.current = meetingId

  const { turns, latestVersion, initialized, loading, error: turnsError, refresh: refreshTurns } = useMeetingTurns(meeting)
  const [selection, setSelection] = useMeetingSelection(meetingId)
  const bucket = useInteractionSelector((state) => state.docks[rootId])
  const dockOpen = !!bucket && bucket.items.length > 0
  const presentation = meetingPresentation(meeting)
  const speech = currentMeetingSpeech(meeting, turns)
  const latestMinutes = meeting.minutes.length ? meeting.minutes[meeting.minutes.length - 1] ?? null : null
  const memberItemId = meetingMemberItemId(meetingId)

  const [pending, setPending] = useState<{ meetingId: string; name: string } | null>(null)
  const pendingRef = useRef<{ meetingId: string; name: string } | null>(null)
  const setPendingFor = (value: { meetingId: string; name: string } | null) => {
    pendingRef.current = value
    setPending(value)
  }
  useEffect(() => {
    if (pendingRef.current && pendingRef.current.meetingId !== meeting.id) setPendingFor(null)
  }, [meeting.id])
  useEffect(() => {
    return bridge.meetings.onUpdated((next) => {
      const current = pendingRef.current
      if (next.id !== meeting.id || current?.meetingId !== next.id) return
      if ((current.name === 'start' || current.name === 'resume')
        && (next.status === 'active' || next.status === 'concluded' || next.status === 'cancelled' || next.status === 'failed')) setPendingFor(null)
    })
  }, [meeting.id])
  const pendingName = pending && pending.meetingId === meetingId ? pending.name : null
  const shortBusy = pendingName === 'pause' || pendingName === 'stop' || pendingName === 'delete'

  const runLongControl = async (name: 'start' | 'resume', action: () => Promise<IpcResult>, failureLabel: string) => {
    const id = meetingIdRef.current
    if (pendingRef.current?.meetingId === id && pendingRef.current.name === name) return
    setPendingFor({ meetingId: id, name })
    try {
      const result = await action()
      if (meetingIdRef.current === id && !result.ok) ui.toast.error(result.error ?? failureLabel)
    } catch (cause) {
      if (meetingIdRef.current === id) ui.toast.error(cause instanceof Error ? cause.message : failureLabel)
    } finally {
      if (pendingRef.current?.meetingId === id && pendingRef.current?.name === name) setPendingFor(null)
    }
  }
  const runControl = async (
    name: 'pause' | 'stop' | 'delete',
    action: () => Promise<IpcResult>,
    failureLabel: string,
    confirmOptions?: Parameters<typeof ui.confirm>[0]
  ) => {
    const id = meetingIdRef.current
    const current = pendingRef.current
    if (current?.meetingId === id && (current.name === 'pause' || current.name === 'stop' || current.name === 'delete')) return
    if (confirmOptions && !(await ui.confirm(confirmOptions))) return
    setPendingFor({ meetingId: id, name })
    try {
      const result = await action()
      if (meetingIdRef.current !== id) return
      if (!result.ok) {
        ui.toast.error(result.error ?? failureLabel)
      } else if (name === 'delete') {
        ui.dock.clear(rootId)
        setSelection(null)
        onDeleted?.(id)
      }
    } catch (cause) {
      if (meetingIdRef.current === id) ui.toast.error(cause instanceof Error ? cause.message : failureLabel)
    } finally {
      if (pendingRef.current?.meetingId === id && pendingRef.current?.name === name) setPendingFor(null)
    }
  }

  const canStart = meeting.status === 'draft'
  const canPause = meeting.status === 'active'
  const canResume = meeting.status === 'waiting_user'
  const stoppable = !meeting.deleting && meeting.stopState !== 'stopping'
    && (meeting.status === 'active' || meeting.status === 'waiting_user' || meeting.stopState === 'failed')
  const deletable = !meeting.deleting && meeting.stopState !== 'stopping' && meeting.stopState !== 'failed'

  const openMemberDock = (agentId: string) => {
    ui.dock.open({ id: memberItemId, kind: 'task', title: meetingMemberDisplayName(turns, agentId), payload: { taskId: rootId } }, { rootId })
  }
  const selectMember = (agentId: string, turnId: string | null = null) => {
    setSelection({ agentId, turnId, follow: false })
    openMemberDock(agentId)
  }
  useEffect(() => {
    if (!selection?.follow || !speech) return
    if (selection.agentId === speech.agentId && selection.turnId === speech.id) return
    setSelection({ agentId: speech.agentId, turnId: speech.id, follow: true })
  }, [selection?.follow, selection?.agentId, selection?.turnId, speech?.agentId, speech?.id, setSelection])
  useEffect(() => {
    if (!selection || !dockOpen || !bucket) return
    const entry = bucket.items.find((item) => item.id === memberItemId)
    if (!entry) return
    const title = meetingMemberDisplayName(turns, selection.agentId)
    if (entry.title !== title) ui.dock.update({ id: entry.id, token: entry.token, rootId }, { title })
  }, [bucket, dockOpen, memberItemId, rootId, selection, turns])

  const renderDockTask = useCallback((entry: Extract<DockEntry, { kind: 'task' }>) => {
    if (entry.id === meetingMemberItemId(meeting.id)) return <MeetingMemberPane meeting={meeting} tasks={tasks} turns={turns} />
    if (entry.id.startsWith(INVESTIGATION_PREFIX)) {
      return <MeetingInvestigationPane key={`${entry.id}:${entry.token}`} meeting={meeting} tasks={tasks} taskId={entry.id.slice(INVESTIGATION_PREFIX.length)} runId={entry.payload.execution?.runId} />
    }
    return <div className="mtd-pane" role="note">未知的会议分栏内容。</div>
  }, [meeting, tasks, turns])

  const minutesAgreeCount = (() => {
    if (!latestMinutes?.version) return null
    const agents = new Set(
      (latestMinutes.confirmations ?? [])
        .filter((item) => item.minutesVersion === latestMinutes.version && item.verdict === 'agree')
        .map((item) => item.agentId)
    )
    return agents.size
  })()

  const [approvalBusy, setApprovalBusy] = useState<string | null>(null)
  const approvalBusyRef = useRef<string | null>(null)
  const setApproval = (value: string | null) => {
    approvalBusyRef.current = value
    setApprovalBusy(value)
  }
  const decideActionItem = async (index: number, verdict: 'approved' | 'rejected') => {
    const id = meetingIdRef.current
    const busyKey = `${id}:${index}:${verdict}`
    if (approvalBusyRef.current) return
    if (verdict === 'approved') {
      const item = latestMinutes?.actionItems[index]
      if (!item) return
      const owner = meetingMemberDisplayName(turns, item.ownerAgentId)
      const yes = await ui.confirm({
        title: '批准并开始执行？',
        body: `将批准行动项「${item.title}」，负责人：${owner}。批准后会释放已停放的任务并立即开始执行；验收条件：${item.acceptance.length ? item.acceptance.join('；') : '未提供'}。`,
        confirmText: '批准并开始执行'
      })
      if (!yes || meetingIdRef.current !== id) return
    }
    setApproval(busyKey)
    try {
      const result = await bridge.meetings.approveAction(id, index, verdict)
      if (meetingIdRef.current === id && !result.ok) ui.toast.error(result.error ?? '行动项审批失败')
    } catch (cause) {
      if (meetingIdRef.current === id) ui.toast.error(cause instanceof Error ? cause.message : '行动项审批失败')
    } finally {
      if (approvalBusyRef.current === busyKey) setApproval(null)
    }
  }

  const speakerOf = (agentId: string) => [...turns].reverse().find((turn) => turn.agentId === agentId && turn.speaker)?.speaker ?? null

  return <div className="detail meeting-detail" data-meeting-detail={meeting.id}>
    <div className="detail-left">
      <PageHeader
        title={<span className="task-title-text" title={meeting.topic}>{meeting.topic}</span>}
        icon={<MessageSquare size={15} aria-hidden="true" />}
        metadata={<div className="detail-meta">
          <span className="meta-group meta-identity"><span className="detail-eyebrow">会议主 Issue · 所有公开发言在这里</span></span>
          <code className="meta-chip mono">{meeting.issueId}</code>
          <span className="meta-group meta-status"><span className={`status-chip status-${presentation.status}`} data-meeting-status={presentation.label}>{presentation.label}</span></span>
          <span className="meta-chip">第 {meeting.round || 1} / {meeting.maxRounds} 轮 · 公开讨论</span>
          <span className="meta-chip">{meeting.participants.length} 位成员</span>
          <span className="meta-chip">发言水位 v{latestVersion ?? 0}</span>
        </div>}
        actions={<>
          {canStart && <button type="button" className="btn primary" disabled={pendingName === 'start'} data-control="start" onClick={() => void runLongControl('start', () => bridge.meetings.start(meeting.id), '会议启动失败')}><Play size={13} aria-hidden="true" /> 开始会议</button>}
          {canResume && <button type="button" className="btn primary" disabled={pendingName === 'resume'} data-control="resume" onClick={() => void runLongControl('resume', () => bridge.meetings.resume(meeting.id), '会议继续失败')}><Play size={13} aria-hidden="true" /> 继续会议</button>}
          {canPause && <button type="button" className="btn" disabled={shortBusy} data-control="pause" onClick={() => void runControl('pause', () => bridge.meetings.pause(meeting.id), '暂停会议失败')}><Pause size={13} aria-hidden="true" /> 暂停</button>}
          {stoppable && <button type="button" className="btn danger" disabled={shortBusy} data-control="stop" title={meeting.stopState === 'failed' ? '上一次停止未取得退出确认，可重试' : '停止整场会议并等待退出确认'} onClick={() => void runControl('stop', () => bridge.meetings.cancel(meeting.id), '停止失败：会议仍未取得退出确认，可重试', {
            title: '停止整场会议？',
            body: '会停止当前会议及全部成员与调查执行，并等待退出确认；独立咨询办公室不在停止范围。已产生的发言和纪要保留。',
            danger: true,
            confirmText: '停止会议'
          })}><Square size={12} aria-hidden="true" />{meeting.stopState === 'failed' ? '重试停止' : '停止会议'}</button>}
          <button type="button" className="btn" disabled={!deletable || shortBusy} data-control="delete" onClick={() => void runControl('delete', () => bridge.meetings.delete(meeting.id), '删除失败：会议记录保留，可重试', {
            title: '删除会议任务和日志？',
            body: '会先停止并等待整场会议全部执行退出，再删除成员、调查、公开发言、纪要与镜像评论；工作目录中的源文件与已批准的独立行动项不在删除范围。删除失败会保留可诊断记录并可重试。',
            danger: true,
            confirmText: '删除任务和日志'
          })}><Trash2 size={13} aria-hidden="true" /> 删除任务和日志</button>
        </>}
      />
      <div className="mtd-banner" role="status" data-state={presentation.status} data-meeting-banner={presentation.label}>
        <strong>{presentation.label}</strong>
        <span>{presentation.detail}</span>
      </div>

      <div className="mtd-members" role="group" aria-label="选择会议成员" data-members>
        {meeting.participants.map((participant) => {
          const name = meetingMemberDisplayName(turns, participant.agentId)
          const platform = speakerOf(participant.agentId)?.platform
          const isSpeaking = speech?.agentId === participant.agentId
          const pressed = dockOpen && selection?.agentId === participant.agentId
          return <button key={participant.agentId} type="button" className="btn mtd-member" data-member={participant.agentId} aria-pressed={pressed} onClick={() => selectMember(participant.agentId)}>
            <span className="mtd-avatar" aria-hidden="true">{name.slice(0, 1)}</span>
            <span className="mtd-member-label"><strong>{name}</strong><span>{[MEETING_ROLE_LABEL[participant.role] ?? participant.role, platform].filter(Boolean).join(' · ')}</span></span>
            <span className={`mtd-member-state${isSpeaking ? ' is-current' : ''}`}>{isSpeaking ? '公开发言中' : '查看执行'}</span>
          </button>
        })}
      </div>

      <div className="mtd-timeline-head">
        <strong>公开时间线</strong>
        <span>{turns.length} 条记录</span>
        <span>实名 · 正式发言</span>
        {selection && !dockOpen && <button type="button" className="btn mtd-reopen" data-reopen-dock onClick={() => openMemberDock(selection.agentId)}>重新打开成员侧栏</button>}
      </div>
      <div className="mtd-timeline" data-timeline-scroll>
        {turnsError && <div className="mtd-note" data-tone="error" role="alert" data-turns-error>
          发言读取失败：{turnsError}。已保留上次成功的时间线与水位，不降级读取兼容评论。
          <button type="button" className="btn" onClick={() => void refreshTurns()}>重试读取</button>
        </div>}
        {!initialized && loading && <div className="mtd-note" role="status">正在读取公开发言…</div>}
        {initialized && !turns.length && <div className="mtd-note" data-timeline-empty>还没有公开发言。准备完成后，第一位成员会实名出现在这里。</div>}
        <div className="mtd-turns" aria-label="会议公开发言" aria-busy={!initialized && loading ? 'true' : 'false'} data-timeline>
          {turns.map((turn) => {
            const body = meetingTurnBody(turn)
            const name = turn.speaker?.name ?? turn.agentId
            const roleLabel = turn.speaker ? [MEETING_ROLE_LABEL[turn.speaker.role] ?? turn.speaker.role, turn.speaker.platform].filter(Boolean).join(' · ') : ''
            const selected = dockOpen && selection?.turnId === turn.id
            const canInspect = turn.purpose !== 'chair' && turn.purpose !== 'minutes'
            return <article key={turn.id} className={`mtd-turn${selected ? ' is-selected' : ''}`} data-turn-id={turn.id} data-status={turn.status}>
              <span className="mtd-avatar" aria-hidden="true">{name.slice(0, 1)}</span>
              <div className="mtd-turn-main">
                <div className="mtd-speaker">
                  <strong>{name}</strong>
                  {roleLabel && <span>{roleLabel}</span>}
                  <span>{meetingTurnContextLabel(turn)}</span>
                  {turn.startedAt !== undefined
                    ? <time dateTime={new Date(turn.startedAt).toISOString()}>{fmtTime(turn.startedAt)}</time>
                    : <time>时间未记录</time>}
                </div>
                <div className="mtd-bubble">
                  {body.markdown !== undefined
                    ? <div className="mtd-body" data-body="markdown"><Markdown text={body.markdown} /></div>
                    : <div className="mtd-body" data-body={body.kind}>{body.text}</div>}
                  <div className="mtd-turn-foot">
                    <span className="mtd-chip" data-state={turn.status}>{MEETING_TURN_STATUS_LABEL[turn.status] ?? turn.status}</span>
                    {turn.purpose === 'chair'
                      ? <span>进入后续公共输入 · 在途请求不改写</span>
                      : <>
                        <span>输入上下文 v{turn.delivery?.publicVersion ?? turn.contextVersion ?? '—'}</span>
                        {canInspect && <button type="button" className="mtd-exec-link" data-execution-link={turn.id} aria-label={`查看 ${name} ${meetingTurnContextLabel(turn)}的本次执行`} onClick={() => selectMember(turn.agentId, turn.id)}>查看本次执行 →</button>}
                      </>}
                  </div>
                </div>
              </div>
            </article>
          })}
        </div>
        {latestMinutes && <section className="mtd-minutes" data-minutes>
          <div className="mtd-minutes-head">
            <strong>最新纪要</strong>
            <span className="mtd-chip" data-minutes-confirm data-version={latestMinutes.version ?? ''}>
              {latestMinutes.version
                ? `${minutesAgreeCount ?? 0} / ${meeting.participants.length} 位成员确认同版本 · ${latestMinutes.version}`
                : '纪要未带版本，按未确认显示'}
            </span>
          </div>
          <p>{latestMinutes.summary || (latestMinutes.decisions.length ? latestMinutes.decisions.join('；') : '质疑、答复与成员确认保留在公开时间线。')}</p>
          {meeting.status === 'concluded' && latestMinutes.actionItems.map((item, index) => {
            const owner = meetingMemberDisplayName(turns, item.ownerAgentId)
            const busy = approvalBusy === `${meeting.id}:${index}:approved` || approvalBusy === `${meeting.id}:${index}:rejected`
            return <div className="mtd-action-item" key={`${item.title}-${index}`} data-action-item={index}>
              <div className="mtd-action-copy">
                <strong>{item.title}</strong>
                <span>负责人：{owner} · 验收条件：{item.acceptance.length ? item.acceptance.join('；') : '未提供'}</span>
              </div>
              {item.approval === 'pending'
                ? <span className="meeting-approval">
                  <button type="button" className="btn primary" disabled={busy} data-action-approve={index} onClick={() => void decideActionItem(index, 'approved')}>批准并开始执行</button>
                  <button type="button" className="btn" disabled={busy} data-action-reject={index} title="拒绝行动项，不会启动任务" onClick={() => void decideActionItem(index, 'rejected')}>拒绝</button>
                </span>
                : <span className="mtd-chip">{item.approval === 'approved' ? '已批准并已启动' : '已拒绝（未启动）'}</span>}
            </div>
          })}
        </section>}
      </div>

      <MeetingComposer key={meeting.id} meeting={meeting} />
    </div>
    <SideDock key={meeting.id} taskId={rootId} tasks={tasks} onOpen={() => {}} renderTask={renderDockTask} />
  </div>
}

/** 底部插话输入：草稿修订号保证迟到响应不清空期间编辑的新插话；按 meeting.id 重挂隔离会议 */
function MeetingComposer({ meeting }: { meeting: Meeting }) {
  const meetingId = meeting.id
  const [note, setNote] = useState('')
  const noteRevision = useRef(0)
  const sendingRef = useRef(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const active = meeting.status === 'active' && !meeting.stopState && !meeting.deleting
  const deliveryHint = !active
    ? meeting.status === 'draft' ? '会议尚未开始，插话在开始后可发送'
      : meeting.status === 'waiting_user' ? '会议在等你处理；继续会议后可发送插话'
      : meeting.status === 'concluded' ? '会议已结束，插话入口保留为只读'
      : '当前不能发送插话'
    : meeting.pendingChairNotes.length
      ? `${meeting.pendingChairNotes.length} 条插话待随下一个安全阶段边界送达`
      : '新插话立即进入公开时间线；在途发言不追认已收到'
  const send = async () => {
    const text = note.trim()
    if (!text || sendingRef.current || meeting.status !== 'active' || meeting.stopState || meeting.deleting) return
    const submittedRevision = noteRevision.current
    sendingRef.current = true
    setSending(true)
    setError(null)
    try {
      const result = await bridge.meetings.interject(meetingId, text)
      if (result.ok) {
        if (noteRevision.current === submittedRevision) {
          noteRevision.current += 1
          setNote('')
        }
      } else {
        setError(result.error ?? '插话发送失败，草稿已保留')
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '插话发送失败，草稿已保留')
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }
  return <div className="mtd-composer" data-meeting-composer={meetingId}>
    <div className="mtd-composer-box">
      <label htmlFor="mtd-chair-note">向整场会议插话</label>
      <textarea
        id="mtd-chair-note"
        value={note}
        placeholder="补充约束，或请成员澄清一个问题…（Enter 发送）"
        onChange={(event) => { noteRevision.current += 1; setNote(event.target.value); setError(null) }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
          event.preventDefault()
          void send()
        }}
      />
      <div className="mtd-composer-foot">
        <span>{deliveryHint}</span>
        <button type="button" className="btn" disabled={!active || sending || !note.trim()} data-interject-send onClick={() => void send()}>{sending ? '发送中…' : '发送插话'}</button>
      </div>
    </div>
    <div className="mtd-delivery" role="status" data-interject-state={sending ? 'pending' : error ? 'error' : 'idle'} data-tone={error ? 'error' : sending ? 'live' : undefined}>
      {error ?? (sending ? '插话发送中…' : '')}
    </div>
  </div>
}
