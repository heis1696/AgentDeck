/**
 * R3 契约：<WorkerPane taskId={id} tasks={tasks} onOpen={onSelect} /> 为 Dock 内紧凑详情。
 * tasks 由宿主持续传入最新列表；内部按 taskId 订阅 useTaskEvents/useTurnModel，切换任务重建订阅。
 * onOpen(id) 仅在「打开完整详情」按钮触发；唯一运行操作是「停止」打断（running/queued 可用，
 * 经 InterruptDialog 收集可空回执，回灌领队）；无追问/回退操作，待审批工具请求就地处理。最终回复
 * 本身就在时间线末尾，不再额外挂底部执行结果区（反馈二轮7）。
 * 样式依赖 polish/dock.css；独立使用时回退按钮由 CSS 隐藏且回调为空操作。
 *
 * 本轮升级（密度 / 运行反馈 / 长内容阅读）：页头收成两行（标题 + 只读元信息行），
 * 执行中显示不定量进度檐与实时用时；回合数/tokens/最近事件时间一次看全。
 */
import { useEffect, useRef, useState } from 'react'
import { ExternalLink, RefreshCw, Square } from 'lucide-react'
import type { Task } from '../../../../shared/types'
import { fmtDuration, fmtTime, fmtTokens } from '../../api'
import { ui } from '../../ui/interaction-center'
import { taskService } from '../../task-service'
import { PARKED_QUEUED_LABEL, TASK_STATUS_LABELS, isParkedQueued } from '../../labels'
import { useTaskEvents } from '../../hooks/useTaskEvents'
import { useTurnModel } from '../../hooks/turnModel'
import { scrollElementTo } from '../../ui/motion'
import { FOLLOW_EPSILON, TurnTimeline } from './TurnTimeline'
import { PermissionPrompt } from './PermissionPrompt'
import { InterruptDialog } from './InterruptDialog'
import { resolveWorkerExecution, type WorkerExecution } from './workerExecution'

export type { WorkerExecution } from './workerExecution'

export interface WorkerPaneProps {
  taskId: string
  tasks: Task[]
  onOpen: (id: string) => void
  readOnly?: boolean
  dockRootId?: string
  execution?: WorkerExecution
}
const noRewind = () => {}

export function WorkerPane({ taskId, tasks, onOpen, readOnly = false, dockRootId, execution }: WorkerPaneProps) {
  const task = tasks.find((item) => item.id === taskId)
  if (!task) return <div className="worker-pane worker-pane-empty" role="status">找不到该子任务，可能已删除。</div>
  const key = readOnly ? `${taskId}:${execution?.runId ?? 'unlocated'}:${execution?.turnId ?? 'run'}` : taskId
  return <WorkerDetail key={key} task={task} onOpen={onOpen} readOnly={readOnly} dockRootId={dockRootId} execution={execution} />
}

function WorkerDetail({ task, onOpen, readOnly, dockRootId, execution }: { task: Task; onOpen: (id: string) => void; readOnly: boolean; dockRootId?: string; execution?: WorkerExecution }) {
  const { events: taskEvents, permission, permissionBusy, permissionError, permissionNotice, refreshPermissions, answerPermission } = useTaskEvents(task.id)
  const executionView = readOnly ? resolveWorkerExecution(taskEvents, execution) : null
  const events = readOnly ? executionView!.events : taskEvents
  const turns = useTurnModel(events, readOnly ? '' : task.prompt)
  const logRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  const [following, setFollowing] = useState(true)
  const [activeNav, setActiveNav] = useState(0)
  const [now, setNow] = useState(Date.now)
  // 打断（唯一运行操作）：回执对话框 + 提交 busy；失败走既有 toast 通道
  const [interrupting, setInterrupting] = useState(false)
  const [stopBusy, setStopBusy] = useState(false)
  const confirmInterrupt = async (reason: string) => {
    setStopBusy(true)
    try {
      // 空串也按用户打断提交（主进程记「未填写原因」）；undefined 才是系统取消不打标
      const result = await taskService.cancel(task.id, reason.trim() ? reason : '')
      if (!result.ok && result.error) ui.toast.error(result.error)
      else if (result.warning) ui.toast.error(result.warning)
    } catch (e) {
      ui.toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setStopBusy(false)
      setInterrupting(false)
    }
  }
  useEffect(() => {
    const status = readOnly ? executionView?.status : task.status
    if (status !== 'running') return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [readOnly, executionView?.status, task.status])
  // 贴底跟随是宿主状态：只有用户在底部时才自动滚到流式末尾（审查项 2）
  const syncFollowing = () => {
    const log = logRef.current
    if (!log) return
    const next = log.scrollHeight - log.scrollTop - log.clientHeight < FOLLOW_EPSILON
    followRef.current = next
    setFollowing((current) => (current === next ? current : next))
  }
  useEffect(() => {
    const log = logRef.current
    if (log && followRef.current) { log.scrollTop = log.scrollHeight; setActiveNav(Math.max(0, turns.length - 1)) }
  }, [events, turns.length])
  const onScroll = () => {
    const log = logRef.current
    if (!log) return
    syncFollowing()
    let active = 0
    const top = log.getBoundingClientRect().top
    log.querySelectorAll<HTMLElement>('.turn').forEach((node, index) => { if (node.getBoundingClientRect().top - top <= 70) active = index })
    setActiveNav(followRef.current ? Math.max(0, turns.length - 1) : active)
  }
  /** 「回到最新」：滚到末尾并把跟随状态重新打开（滚动本身尊重 prefers-reduced-motion） */
  const followLatest = () => {
    const log = logRef.current
    followRef.current = true
    setFollowing(true)
    if (log) scrollElementTo(log, log.scrollHeight)
    setActiveNav(Math.max(0, turns.length - 1))
  }
  const navigate = (index: number) => {
    const log = logRef.current
    const target = log?.querySelectorAll<HTMLElement>('.turn')[index]
    if (!log || !target) return
    followRef.current = false
    setFollowing(false)
    scrollElementTo(log, Math.max(0, log.scrollTop + target.getBoundingClientRect().top - log.getBoundingClientRect().top - 8))
    setActiveNav(index)
  }
  const status = readOnly ? executionView?.status : task.status
  const startedAt = readOnly ? executionView?.startedAt : task.startedAt
  const endedAt = readOnly ? executionView?.endedAt : task.endedAt
  const lastEventAt = readOnly ? executionView?.lastEventAt ?? 0 : events.length ? events[events.length - 1].ts : 0
  const running = status === 'running'
  const duration = readOnly
    ? startedAt ? Math.max(0, ((status === 'running' ? now : endedAt ?? lastEventAt) ?? startedAt) - startedAt) : 0
    : task.startedAt ? Math.max(0, (task.endedAt ?? now) - task.startedAt) : 0
  const timeTitle = readOnly
    ? startedAt ? `${fmtTime(startedAt)} → ${endedAt ? fmtTime(endedAt) : status === 'running' ? '进行中' : lastEventAt ? fmtTime(lastEventAt) : '—'}` : '未开始'
    : task.startedAt ? `${fmtTime(task.startedAt)} → ${task.endedAt ? fmtTime(task.endedAt) : running ? '进行中' : '—'}` : '未开始'
  const state = readOnly
    ? status ? TASK_STATUS_LABELS[status] : '状态未记录'
    : isParkedQueued(task) ? PARKED_QUEUED_LABEL : TASK_STATUS_LABELS[task.status]
  const stoppable = !readOnly && (running || task.status === 'queued')
  const error = readOnly ? executionView?.error : task.error ? task.failure?.title ?? task.error : undefined
  return <section className={`worker-pane status-${status ?? 'unknown'}${running ? ' is-live' : ''}`} aria-label={readOnly ? '会议执行详情' : '子任务详情'}>
    <header className="worker-pane-header">
      <div className="worker-pane-title">
        <h2 title={task.title}>{task.title}</h2>
        {stoppable && <button type="button" className="btn danger worker-pane-stop" disabled={stopBusy} onClick={() => setInterrupting(true)} title="打断该队员任务（可附回执）"><Square size={12} aria-hidden="true" /><span className="worker-pane-stop-text">停止</span></button>}
        {!readOnly && <button type="button" onClick={() => onOpen(task.id)} title="打开完整详情" aria-label="打开子任务完整详情"><ExternalLink size={14} aria-hidden="true" /><span className="worker-pane-open-text">完整详情</span></button>}
      </div>
      <div className="worker-pane-meta">
        <span className={`status-chip status-${status ?? 'unknown'}`}><span className={`dot dot-${status ?? 'unknown'}`} aria-hidden="true" />{state}</span>
        {readOnly && executionView?.locatable && <span className="worker-pane-item" title={execution!.turnId ? `Run ${execution!.runId} · Turn ${execution!.turnId}` : `Run ${execution!.runId}`}>{execution!.turnId ? `Run ${execution!.runId} · Turn ${execution!.turnId}` : `Run ${execution!.runId}`}</span>}
        <span className="worker-pane-backend">{task.backend}</span>
        <span className="worker-pane-item" title={timeTitle}>⏱ {duration ? fmtDuration(duration) : '—'}</span>
        <span className="worker-pane-item">{turns.length} 回合</span>
        {!readOnly && task.usage && <span className="worker-pane-item" title={`输入 ${task.usage.inputTokens.toLocaleString()} · 输出 ${task.usage.outputTokens.toLocaleString()}`}>{fmtTokens(task.usage.inputTokens + task.usage.outputTokens)} tokens</span>}
        {lastEventAt > 0 && <span className="worker-pane-item">最近 {fmtTime(lastEventAt)}</span>}
        <span className="worker-pane-readonly">{readOnly ? '历史只读' : permission ? '等待审批' : '只读'}</span>
      </div>
      {running && <span className="worker-pane-progress" aria-hidden="true" />}
    </header>
    {error && <div className="worker-pane-error" role="status">{error}</div>}
    {!readOnly && permission && <PermissionPrompt key={permission.requestToken ?? permission.requestId} permission={permission} busy={permissionBusy} onAnswer={(choice) => void answerPermission(choice)} />}
    {!readOnly && permissionError && <div className="data-state-banner" role="alert"><span>{permissionError}</span><button type="button" className="btn" onClick={() => void refreshPermissions()}><RefreshCw size={13} /> 刷新审批</button></div>}
    {!readOnly && permissionNotice && <div className="data-state-banner" role="status">{permissionNotice}</div>}
    {readOnly && !executionView?.locatable && <div className="data-state-banner" role="status">未提供有效的 Run 标识，无法安全定位会议执行记录；为避免显示其他历史日志，已隐藏日志。</div>}
    {readOnly && executionView?.locatable && executionView.missingAssociationCount > 0 && <div className="data-state-banner" role="status">有 {executionView.missingAssociationCount} 条事件缺少可验证的执行关联，未纳入本次记录。</div>}
    {readOnly && executionView?.locatable && events.length === 0 && executionView.missingAssociationCount === 0 && <div className="data-state-banner" role="status">所选 Run/Turn 没有可验证的事件记录。</div>}
    {executionView?.locatable !== false && <div className="worker-pane-timeline"><TurnTimeline task={task} turns={turns} activeNav={activeNav} following={following} onFollowLatest={followLatest} onNavigate={navigate} onRewind={noRewind} logRef={logRef} onScroll={onScroll} dockRootId={dockRootId} snapshotOnly={readOnly} /></div>}
    {!readOnly && interrupting && <InterruptDialog title={task.title} busy={stopBusy} onConfirm={(reason) => void confirmInterrupt(reason)} onClose={() => setInterrupting(false)} />}
  </section>
}
