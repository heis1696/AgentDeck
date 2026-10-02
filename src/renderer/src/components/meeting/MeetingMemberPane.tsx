/**
 * 会议成员执行分栏（SideDock renderTask 插槽内容）。
 *
 * 权威来源只有 readTurns/getTurn/memberExecutions 三个会议公共 API：
 * - 成员执行列表与内部调查来自 memberExecutions（会话范围，不是办公室全部历史）；
 * - 选定发言（旧发言或当前发言）一律按 getTurn 的 sessionTaskId/officeTaskId、
 *   runId、executionTurnId 展示确切关联；关联不完整时明确标缺失，
 *   绝不回退「该成员最新一次 Run」，也绝不跳转普通任务页；
 * - Task 不在页面目录时用 tasks.get 兜底读取，读不到就显示关联缺失，不伪造。
 *
 * 选中成员与旧发言存在 meetingSelection（按 meetingId 隔离，跨挂载/关闭重开恢复）；
 * 本组件只消费选择与切换历史执行，不主动开关侧栏——重开只由用户显式动作
 * （成员栏/查看本次执行/重新打开成员侧栏/调查项）触发，事件到达永远不能重开已关闭的侧栏。
 *
 * 读取防串扰：memberExecutions/getTurn/tasks.get 全部带请求令牌 + 卸载守卫，
 * 乱序到达的旧响应与卸载后的迟到结果一律丢弃（MeetingDetail 按 meeting.id 重挂本组件）。
 *
 * WorkerPane 只读日志按所选 Task/Run/Turn 过滤，不回退成员会话的全部历史。
 */
import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { FolderSearch } from 'lucide-react'
import type { Meeting, MeetingMemberExecutions, MeetingTurn, MeetingTurnDetail } from '../../../../shared/meeting'
import type { Task, TaskStatus } from '../../../../shared/types'
import { bridge } from '../../api'
import { ui } from '../../ui/interaction-center'
import { meetingRootId } from './meetingViewState'
import { useMeetingSelection } from './meetingSelection'
import { WorkerPane } from '../task/WorkerPane'

export const MEETING_ROLE_LABEL: Record<string, string> = { reporter: '汇报', critic: '质疑', designer: '答辩' }
export const MEETING_TURN_STATUS_LABEL: Record<string, string> = {
  pending: '正在准备', speaking: '正在执行', done: '已完成', failed: '失败', cancelled: '已取消', skipped: '已跳过'
}
const PHASE_LABEL: Record<string, string> = { report: '汇报', challenge: '质疑', defense: '答辩', synthesis: '综合' }

/** 发言的上下文标签：实名插话/纪要/确认与阶段发言分开，不把成员角色冒充成阶段名 */
export function meetingTurnContextLabel(turn: Pick<MeetingTurn, 'purpose' | 'phase' | 'round'>): string {
  if (turn.purpose === 'chair') return '用户插话'
  if (turn.purpose === 'minutes') return '纪要'
  if (turn.purpose === 'review') return '质疑复核'
  if (turn.purpose === 'confirmation') return '成员确认'
  return `第 ${turn.round} 轮 · ${PHASE_LABEL[turn.phase] ?? turn.phase}`
}

/** 成员分栏在 dock 桶里的条目 id（桶本身按 meetingRootId 隔离，id 再带会议 id 双保险） */
export function meetingMemberItemId(meetingId: string): string { return `meeting-member:${meetingId}` }
/** 调查分栏条目 id：就地开在会议 root 下，绝不导航到普通任务页 */
export function meetingInvestigationItemId(taskId: string): string { return `meeting-investigation:${taskId}` }

/** 实名显示：优先最近一次发言的姓名快照；没有快照（更老的记录）按 agentId 显示，不伪造 */
export function meetingMemberDisplayName(turns: readonly MeetingTurn[], agentId: string): string {
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]
    if (turn?.agentId === agentId && turn.speaker?.name) return turn.speaker.name
  }
  return agentId
}

interface MemberPaneProps {
  meeting: Meeting
  tasks: Task[]
  /** 会议公开时间线快照（来自 useMeetingTurns）：用于实名显示与跟随对齐 */
  turns: readonly MeetingTurnDetail[]
}

export function MeetingMemberPane({ meeting, tasks, turns }: MemberPaneProps) {
  const meetingId = meeting.id
  const rootId = meetingRootId(meetingId)
  const [selection, setSelection] = useMeetingSelection(meetingId)
  const agentId = selection?.agentId ?? ''
  const participant = meeting.participants.find((item) => item.agentId === agentId) ?? null

  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])
  const execRequestRef = useRef(0)
  const turnRequestRef = useRef(0)
  const taskRequestRef = useRef(0)
  const [executions, setExecutions] = useState<{ meetingId: string; agentId: string; data: MeetingMemberExecutions } | null>(null)
  const [executionsError, setExecutionsError] = useState<string | null>(null)
  const [executionsLoading, setExecutionsLoading] = useState(false)
  const [turnState, setTurnState] = useState<{ meetingId: string; turnId: string; turn: MeetingTurnDetail | null } | null>(null)
  const [turnError, setTurnError] = useState<string | null>(null)
  const [fetchedTask, setFetchedTask] = useState<{ meetingId: string; taskId: string; task: Task | null } | null>(null)
  const executionRevision = tasks.filter((task) => task.meetingId === meetingId && task.meetingTaskRole !== 'container')
    .map((task) => `${task.id}:${task.runId ?? ''}:${task.status}`).sort().join('|')

  useEffect(() => {
    const token = ++execRequestRef.current
    if (!agentId) return
    setExecutionsLoading(true)
    setExecutionsError(null)
    bridge.meetings.memberExecutions(meetingId, agentId).then((data) => {
      if (!aliveRef.current || token !== execRequestRef.current) return
      setExecutionsLoading(false)
      if (!data) { setExecutionsError('成员执行查询为空：该成员可能已不在这场会议的名单里。'); return }
      setExecutions({ meetingId, agentId, data })
    }).catch((cause) => {
      if (!aliveRef.current || token !== execRequestRef.current) return
      setExecutionsLoading(false)
      setExecutionsError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => { ++execRequestRef.current }
  }, [meetingId, agentId, meeting.turnVersion, meeting.updatedAt, executionRevision])

  const executionsData = executions && executions.meetingId === meetingId && executions.agentId === agentId ? executions.data : null
  const memberTurns = executionsData?.turns ?? []
  const defaultTurnId = memberTurns.find((turn) => turn.status === 'speaking')?.id ?? memberTurns[memberTurns.length - 1]?.id ?? null
  const requestedTurnId = selection?.turnId ?? defaultTurnId
  const requestedTurnVersion = turns.find((turn) => turn.id === requestedTurnId)?.version

  useEffect(() => {
    const token = ++turnRequestRef.current
    if (!requestedTurnId) { setTurnState(null); setTurnError(null); return }
    setTurnError(null)
    bridge.meetings.getTurn(meetingId, requestedTurnId).then((turn) => {
      if (!aliveRef.current || token !== turnRequestRef.current) return
      setTurnState({ meetingId, turnId: requestedTurnId, turn })
    }).catch((cause) => {
      if (!aliveRef.current || token !== turnRequestRef.current) return
      setTurnState(null)
      setTurnError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => { ++turnRequestRef.current }
  }, [meetingId, requestedTurnId, requestedTurnVersion])

  const selectedTurn = turnState && turnState.meetingId === meetingId && turnState.turnId === requestedTurnId ? turnState.turn : null
  const associatedTaskId = selectedTurn ? (selectedTurn.sessionTaskId ?? selectedTurn.officeTaskId ?? '') : ''
  const directoryTask = associatedTaskId ? tasks.find((item) => item.id === associatedTaskId) ?? null : null
  useEffect(() => {
    if (!associatedTaskId || directoryTask) return
    const token = ++taskRequestRef.current
    bridge.tasks.get(associatedTaskId).then((task) => {
      if (!aliveRef.current || token !== taskRequestRef.current) return
      setFetchedTask({ meetingId, taskId: associatedTaskId, task })
    }).catch(() => {
      if (!aliveRef.current || token !== taskRequestRef.current) return
      setFetchedTask({ meetingId, taskId: associatedTaskId, task: null })
    })
  }, [meetingId, associatedTaskId, directoryTask])
  const fetchedTaskResolved = !!fetchedTask && fetchedTask.meetingId === meetingId && fetchedTask.taskId === associatedTaskId
  const resolvedTask = directoryTask ?? (fetchedTaskResolved ? fetchedTask.task : null)
  const taskMissing = !!associatedTaskId && (!!directoryTask || fetchedTaskResolved) && !resolvedTask

  const memberName = meetingMemberDisplayName(turns, agentId)
  const speakerSnapshot = [...turns].reverse().find((turn) => turn.agentId === agentId && turn.speaker)?.speaker
  const roleText = [speakerSnapshot?.platform, MEETING_ROLE_LABEL[participant?.role ?? ''] ?? participant?.role].filter(Boolean).join(' · ')
  const memberSessionTaskId = participant?.sessionTaskId ?? participant?.officeTaskId ?? executionsData?.sessionTaskId ?? null
  const investigations = executionsData?.investigations ?? []
  const followChecked = !!selection?.follow

  const patchSelection = (patch: Partial<{ agentId: string; turnId: string | null; follow: boolean }>) => {
    if (!selection) return
    setSelection({ ...selection, ...patch })
  }
  const onSelectExecution = (turnId: string) => {
    patchSelection({ turnId: turnId || null, follow: false })
  }
  const onToggleFollow = (event: ChangeEvent<HTMLInputElement>) => {
    patchSelection({ follow: event.target.checked })
  }
  const openInvestigation = (investigation: { taskId: string; runId?: string }) => {
    const title = tasks.find((item) => item.id === investigation.taskId)?.title ?? investigation.taskId
    ui.dock.open({ id: meetingInvestigationItemId(investigation.taskId), kind: 'task', title, payload: { taskId: investigation.taskId, ...(investigation.runId ? { execution: { runId: investigation.runId } } : {}) } }, { rootId })
  }

  if (!agentId || !selection) return <div className="mtd-pane" data-member-pane="empty" role="status">还没有选择成员。点击成员或任意发言的「查看本次执行」后，这里就地显示其内部执行。</div>

  const executionExact = !!(associatedTaskId && selectedTurn?.runId && selectedTurn?.executionTurnId)
  const turnGone = !!requestedTurnId && turnState && turnState.turnId === requestedTurnId && !turnState.turn

  return <div className="mtd-pane" data-member-pane={agentId}>
    <div className="mtd-pane-person">
      <span className="mtd-avatar" aria-hidden="true">{memberName.slice(0, 1)}</span>
      <div><strong>{memberName}</strong><span>{roleText || '会议成员'} · 会议范围会话</span></div>
    </div>
    <div className="mtd-pane-mode">
      <span data-mode-label={followChecked ? 'follow' : 'fixed'}>{followChecked ? '跟随正式发言' : '固定所选成员'}</span>
      <label><input type="checkbox" checked={followChecked} onChange={onToggleFollow} aria-label="跟随当前发言者" />跟随当前发言者</label>
    </div>
    <div>
      <span className="mtd-pane-label" id="mtd-execution-label">当前或历史发言的执行</span>
      <select
        className="mtd-exec-select"
        aria-labelledby="mtd-execution-label"
        data-execution-select
        value={requestedTurnId ?? ''}
        onChange={(event) => onSelectExecution(event.target.value)}
      >
        {!memberTurns.length && <option value="">该成员暂无发言记录</option>}
        {memberTurns.map((turn) => (
          <option key={turn.id} value={turn.id}>
            {meetingTurnContextLabel(turn)} · {MEETING_TURN_STATUS_LABEL[turn.status] ?? turn.status} · {turn.runId ?? '尚未建立 Run'}
          </option>
        ))}
        {requestedTurnId && !memberTurns.some((turn) => turn.id === requestedTurnId) && (
          <option value={requestedTurnId}>选定旧发言 · 执行列表中缺失</option>
        )}
      </select>
      {executionsLoading && <div className="mtd-pane-label" role="status">正在读取成员执行…</div>}
      {executionsError && <div className="mtd-note" data-tone="error" role="alert" data-member-executions-error>{executionsError}</div>}
    </div>
    {requestedTurnId && <div className="mtd-pane-execution">
      <details className="mtd-execution-metadata" open={!!turnError || !!turnGone || !!taskMissing || (!!selectedTurn && !executionExact)}>
      <summary>发言关联与投递审计 · {selectedTurn ? meetingTurnContextLabel(selectedTurn) : '正在读取'}</summary>
      <dl className="mtd-exec-detail" data-execution-detail>
        <dt>发言</dt><dd><code>{requestedTurnId}</code></dd>
        <dt>Task</dt><dd><code data-execution-task>{associatedTaskId || '关联缺失'}</code></dd>
        <dt>Run</dt><dd><code data-execution-run>{selectedTurn?.runId ?? '尚未建立 / 关联缺失'}</code></dd>
        <dt>Turn</dt><dd><code data-execution-turn>{selectedTurn?.executionTurnId ?? '尚未建立 / 关联缺失'}</code></dd>
      </dl>
      <div className="mtd-audit" data-execution-audit data-exact={executionExact ? 'true' : 'false'}>
        <strong>{executionExact ? '按所选发言的确切关联读取' : '执行关联尚未完整，不替换为最新一次'}</strong>
        {selectedTurn && <>实际输入上下文 v{selectedTurn.delivery?.publicVersion ?? selectedTurn.contextVersion ?? '—'} · {selectedTurn.deliveryState === 'prepared' ? '尚未投递' : selectedTurn.deliveryState ? `投递 ${selectedTurn.deliveryState}` : '投递状态未知'}；用户插话来源：{selectedTurn.delivery?.chairTurnIds?.length ? selectedTurn.delivery.chairTurnIds.join(', ') : '无'}</>}
        {resolvedTask && <>关联任务：{resolvedTask.title}</>}
        {taskMissing && <>会议任务目录中找不到该发言关联的任务记录，按「关联缺失」显示，不回退最新 Run。</>}
        {turnGone && <>选定发言在权威记录中已不存在（可能被整场删除），不替换为其他发言。</>}
        {turnError && <>读取失败：{turnError}</>}
      </div>
      </details>
      {executionExact && resolvedTask && selectedTurn && <WorkerPane key={`${resolvedTask.id}:${selectedTurn.runId}:${selectedTurn.executionTurnId}`} taskId={resolvedTask.id} tasks={[resolvedTask]} onOpen={() => {}} readOnly dockRootId={rootId} execution={{
        runId: selectedTurn.runId!, turnId: selectedTurn.executionTurnId!,
        contextLabel: meetingTurnContextLabel(selectedTurn),
        status: ({ pending: 'queued', speaking: 'running', done: 'done', failed: 'failed', cancelled: 'cancelled', skipped: 'cancelled' } as Record<string, TaskStatus>)[selectedTurn.status],
        startedAt: selectedTurn.startedAt, endedAt: selectedTurn.endedAt, error: selectedTurn.error
      }} />}
      {!selectedTurn && !turnError && <div className="mtd-pane-label">该发言尚未建立可定位的执行。</div>}
    </div>}
    <details className="mtd-pane-section" data-investigations-section>
      <summary>内部调查 · {investigations.length} 条 · 与公开发言分开</summary>
      {!investigations.length && <div className="mtd-pane-label">该成员没有内部调查。</div>}
      {investigations.map((investigation) => (
        <button key={investigation.taskId} type="button" className="mtd-investigation" data-investigation={investigation.taskId} onClick={() => openInvestigation(investigation)}>
          <FolderSearch size={13} aria-hidden="true" />
          <code>{investigation.taskId}</code>
          <span>{investigation.status === 'running' ? '执行中' : investigation.status}{investigation.runId ? ` · ${investigation.runId}` : ''}</span>
        </button>
      ))}
    </details>
    <div className="mtd-pane-foot">会话任务 {memberSessionTaskId ?? '关联缺失'} · 内部过程不发布到公开讨论，也不跳转普通任务页。执行日志仅限所选 Run/Turn。</div>
  </div>
}

/** 会议内部调查的只读分栏（会议 root dock 桶内）：不跳普通任务页，不挂未限定日志 */
export function MeetingInvestigationPane({ meeting, tasks, taskId, runId }: { meeting: Meeting; tasks: Task[]; taskId: string; runId?: string }) {
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])
  const requestRef = useRef(0)
  const directoryTask = tasks.find((item) => item.id === taskId) ?? null
  const [fetched, setFetched] = useState<Task | null | undefined>(undefined)
  useEffect(() => {
    if (directoryTask) return
    const token = ++requestRef.current
    bridge.tasks.get(taskId).then((task) => {
      if (aliveRef.current && token === requestRef.current) setFetched(task)
    }).catch(() => {
      if (aliveRef.current && token === requestRef.current) setFetched(null)
    })
  }, [taskId, directoryTask])
  const task = directoryTask ?? (fetched === undefined ? null : fetched)
  const resolved = directoryTask ? 'directory' : fetched === undefined ? 'loading' : task ? 'fetched' : 'missing'
  return <div className="mtd-pane" data-investigation-pane={taskId} data-investigation-state={resolved}>
    <div className="mtd-pane-person">
      <span className="mtd-avatar" aria-hidden="true">调</span>
      <div><strong>{task?.title ?? taskId}</strong><span>会议内部调查 · 只读</span></div>
    </div>
    <dl className="mtd-exec-detail">
      <dt>会议</dt><dd><code>{meeting.id}</code></dd>
      <dt>Task</dt><dd><code>{taskId}</code></dd>
      <dt>状态</dt><dd>{task && runId && task.runId === runId ? MEETING_TURN_STATUS_LABEL[task.status] ?? task.status : resolved === 'loading' ? '正在读取…' : '所选执行状态未确认'}</dd>
      {task?.backend && <><dt>后端</dt><dd>{task.backend}</dd></>}
      <dt>Run</dt><dd><code>{runId ?? '关联缺失，不替换为最新一次'}</code></dd>
    </dl>
    <div className="mtd-audit">
      {task ? '调查在会议 root 下就地只读查看；不发布到公开讨论，也不跳转普通任务页。'
        : resolved === 'missing' ? '任务目录中找不到这条调查记录（可能已随会议清理），按缺失显示，不伪造内容。'
        : '正在读取调查记录…'}
    </div>
    {task && runId && <WorkerPane key={`${task.id}:${runId}`} taskId={task.id} tasks={[task]} onOpen={() => {}} readOnly dockRootId={meetingRootId(meeting.id)} execution={{
      runId, ...(task.runId === runId ? { status: task.status, startedAt: task.startedAt, endedAt: task.endedAt, error: task.error } : {})
    }} />}
  </div>
}
