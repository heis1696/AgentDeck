/**
 * R3 契约：<WorkerPane taskId={id} tasks={tasks} onOpen={onSelect} /> 为 Dock 内紧凑只读详情。
 * tasks 由宿主持续传入最新列表；内部按 taskId 订阅 useTaskEvents/useTurnModel，切换任务重建订阅。
 * onOpen(id) 仅在「打开完整详情」按钮触发；无运行/追问/权限审批/回退操作——最终回复
 * 本身就在时间线末尾，不再额外挂底部执行结果区（反馈二轮7）。
 * 样式依赖 polish/dock.css；独立使用时回退按钮由 CSS 隐藏且回调为空操作。
 *
 * 本轮升级（密度 / 运行反馈 / 长内容阅读）：页头收成两行（标题 + 只读元信息行），
 * 执行中显示不定量进度檐与实时用时；回合数/tokens/最近事件时间一次看全。
 */
import { useEffect, useRef, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import type { Task } from '../../../../shared/types'
import { fmtDuration, fmtTime, fmtTokens } from '../../api'
import { PARKED_QUEUED_LABEL, TASK_STATUS_LABELS, isParkedQueued } from '../../labels'
import { useTaskEvents } from '../../hooks/useTaskEvents'
import { useTurnModel } from '../../hooks/turnModel'
import { scrollElementTo } from '../../ui/motion'
import { FOLLOW_EPSILON, TurnTimeline } from './TurnTimeline'

export interface WorkerPaneProps {
  taskId: string
  tasks: Task[]
  onOpen: (id: string) => void
}
const noRewind = () => {}

export function WorkerPane({ taskId, tasks, onOpen }: WorkerPaneProps) {
  const task = tasks.find((item) => item.id === taskId)
  if (!task) return <div className="worker-pane worker-pane-empty" role="status">找不到该子任务，可能已删除。</div>
  return <WorkerDetail key={taskId} task={task} onOpen={onOpen} />
}

function WorkerDetail({ task, onOpen }: { task: Task; onOpen: (id: string) => void }) {
  const { events } = useTaskEvents(task.id)
  const turns = useTurnModel(events, task.prompt)
  const logRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  const [following, setFollowing] = useState(true)
  const [activeNav, setActiveNav] = useState(0)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (task.status !== 'running') return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [task.status])
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
  const duration = task.startedAt ? Math.max(0, (task.endedAt ?? now) - task.startedAt) : 0
  const lastEventAt = events.length ? events[events.length - 1].ts : 0
  const state = isParkedQueued(task) ? PARKED_QUEUED_LABEL : TASK_STATUS_LABELS[task.status]
  const running = task.status === 'running'
  return <section className={`worker-pane status-${task.status}${running ? ' is-live' : ''}`} aria-label="子任务只读详情">
    <header className="worker-pane-header">
      <div className="worker-pane-title">
        <h2 title={task.title}>{task.title}</h2>
        <button type="button" onClick={() => onOpen(task.id)} title="打开完整详情" aria-label="打开子任务完整详情"><ExternalLink size={14} aria-hidden="true" /><span className="worker-pane-open-text">完整详情</span></button>
      </div>
      <div className="worker-pane-meta">
        <span className={`status-chip status-${task.status}`}><span className={`dot dot-${task.status}`} aria-hidden="true" />{state}</span>
        <span className="worker-pane-backend">{task.backend}</span>
        <span className="worker-pane-item" title={task.startedAt ? `${fmtTime(task.startedAt)} → ${task.endedAt ? fmtTime(task.endedAt) : running ? '进行中' : '—'}` : '未开始'}>⏱ {duration ? fmtDuration(duration) : '—'}</span>
        <span className="worker-pane-item">{turns.length} 回合</span>
        {task.usage && <span className="worker-pane-item" title={`输入 ${task.usage.inputTokens.toLocaleString()} · 输出 ${task.usage.outputTokens.toLocaleString()}`}>{fmtTokens(task.usage.inputTokens + task.usage.outputTokens)} tokens</span>}
        {lastEventAt > 0 && <span className="worker-pane-item">最近 {fmtTime(lastEventAt)}</span>}
        <span className="worker-pane-readonly">只读</span>
      </div>
      {running && <span className="worker-pane-progress" aria-hidden="true" />}
    </header>
    {task.error && <div className="worker-pane-error" role="status">{task.failure?.title ?? task.error}</div>}
    <div className="worker-pane-timeline"><TurnTimeline task={task} turns={turns} activeNav={activeNav} following={following} onFollowLatest={followLatest} onNavigate={navigate} onRewind={noRewind} logRef={logRef} onScroll={onScroll} /></div>
  </section>
}
