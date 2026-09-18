/**
 * R3 契约：<WorkerPane taskId={id} tasks={tasks} onOpen={onSelect} /> 为 Dock 内紧凑只读详情。
 * tasks 由宿主持续传入最新列表；内部按 taskId 订阅 useTaskEvents/useTurnModel，切换任务重建订阅。
 * onOpen(id) 仅在「打开完整详情」按钮触发；无运行/追问/权限审批/回退操作——最终回复
 * 本身就在时间线末尾，不再额外挂底部执行结果区（反馈二轮7）。
 * 样式依赖 polish/dock.css；独立使用时同样隐藏时间线回退按钮且回调为空操作。
 */
import { useEffect, useRef, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import type { Task } from '../../../../shared/types'
import { fmtDuration } from '../../api'
import { PARKED_QUEUED_LABEL } from '../../labels'
import { useTaskEvents } from '../../hooks/useTaskEvents'
import { useTurnModel } from '../../hooks/turnModel'
import { TurnTimeline } from './TurnTimeline'

export interface WorkerPaneProps {
  taskId: string
  tasks: Task[]
  onOpen: (id: string) => void
}
const STATUS: Record<Task['status'], string> = { queued: '排队中', running: '执行中', done: '已完成', failed: '失败', cancelled: '已取消' }
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
  const [activeNav, setActiveNav] = useState(0)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (task.status !== 'running') return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [task.status])
  useEffect(() => {
    const log = logRef.current
    if (log && followRef.current) { log.scrollTop = log.scrollHeight; setActiveNav(Math.max(0, turns.length - 1)) }
  }, [events, turns.length])
  const onScroll = () => {
    const log = logRef.current
    if (!log) return
    followRef.current = log.scrollHeight - log.scrollTop - log.clientHeight < 40
    let active = 0
    const top = log.getBoundingClientRect().top
    log.querySelectorAll<HTMLElement>('.turn').forEach((node, index) => { if (node.getBoundingClientRect().top - top <= 70) active = index })
    setActiveNav(followRef.current ? Math.max(0, turns.length - 1) : active)
  }
  const navigate = (index: number) => {
    const log = logRef.current
    const target = log?.querySelectorAll<HTMLElement>('.turn')[index]
    if (!log || !target) return
    followRef.current = false
    log.scrollTo({ top: Math.max(0, log.scrollTop + target.getBoundingClientRect().top - log.getBoundingClientRect().top - 8), behavior: 'smooth' })
    setActiveNav(index)
  }
  const duration = task.startedAt ? Math.max(0, (task.endedAt ?? now) - task.startedAt) : 0
  return <section className="worker-pane" aria-label="子任务只读详情">
    <header className="worker-pane-header">
      <div className="worker-pane-title"><h2 title={task.title}>{task.title}</h2><button type="button" onClick={() => onOpen(task.id)} title="打开完整详情" aria-label="打开子任务完整详情"><ExternalLink size={14} aria-hidden="true" /></button></div>
      <div className="worker-pane-meta"><span className={`dot dot-${task.status}`} /><span>{task.status === 'queued' && task.parked ? PARKED_QUEUED_LABEL : STATUS[task.status]}</span><span className="worker-pane-backend">{task.backend}</span><span>{duration ? fmtDuration(duration) : '—'}</span><span className="worker-pane-readonly">只读</span></div>
    </header>
    {task.error && <div className="worker-pane-error" role="status">{task.failure?.title ?? task.error}</div>}
    <div className="worker-pane-timeline"><TurnTimeline task={task} turns={turns} activeNav={activeNav} onNavigate={navigate} onRewind={noRewind} logRef={logRef} onScroll={onScroll} /></div>
  </section>
}
