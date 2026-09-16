import { useEffect, useMemo, useState } from 'react'
import type { Goal, Issue, IssueStatus, Task } from '../../../shared/types'
import { bridge, fmtDuration, fmtTime } from '../api'
import { ISSUE_STATUS_LABELS, TASK_STATUS_LABELS, isParkedQueued, PARKED_QUEUED_LABEL } from '../labels'
import { taskService } from '../task-service'
import { toast } from '../ui/Toasts'
import { IssueIdChip } from '../ui/IssueIdChip'
import { EmptyState } from '../ui/EmptyState'
import { CheckCircle2, CircleAlert, CircleDot, Clock3, Ban, Eye, ListTodo } from 'lucide-react'

/** 优先级中文（卡片角标用） */
const PRIORITY_LABELS: Record<Issue['priority'], string> = {
  urgent: '紧急', high: '高', medium: '中', low: '低', none: '无'
}

const COLUMNS: { key: IssueStatus; label: string; icon: typeof Clock3 }[] = [
  { key: 'backlog', label: ISSUE_STATUS_LABELS.backlog, icon: ListTodo },
  { key: 'todo', label: ISSUE_STATUS_LABELS.todo, icon: Clock3 },
  { key: 'in_progress', label: ISSUE_STATUS_LABELS.in_progress, icon: CircleDot },
  { key: 'in_review', label: ISSUE_STATUS_LABELS.in_review, icon: Eye },
  { key: 'done', label: ISSUE_STATUS_LABELS.done, icon: CheckCircle2 },
  { key: 'blocked', label: ISSUE_STATUS_LABELS.blocked, icon: CircleAlert },
  { key: 'cancelled', label: ISSUE_STATUS_LABELS.cancelled, icon: Ban }
]

export function BoardView({ tasks, onOpen }: { tasks: Task[]; onOpen: (id: string) => void }) {
  const [issues, setIssues] = useState<Issue[]>([])
  const [goals, setGoals] = useState<Goal[]>([])
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [dropTarget, setDropTarget] = useState<IssueStatus | null>(null)
  const [starting, setStarting] = useState<string | null>(null)
  const refresh = () => void bridge.issues.list().then(setIssues)
  useEffect(() => {
    refresh()
    const off = bridge.issues.onUpdated(refresh)
    const offGoals = bridge.goals.onUpdated((goal) => setGoals((cur) => (cur.some((g) => g.id === goal.id) ? cur.map((g) => (g.id === goal.id ? goal : g)) : [...cur, goal])))
    const offGoalDeleted = bridge.goals.onDeleted((goalId) => setGoals((cur) => cur.filter((g) => g.id !== goalId)))
    void bridge.goals.list().then(setGoals).catch(() => {})
    return () => { off(); offGoals(); offGoalDeleted() }
  }, [])
  useEffect(() => {
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    return () => { window.removeEventListener('click', close); window.removeEventListener('blur', close) }
  }, [])
  const byTask = useMemo(() => new Map(issues.map((issue) => [issue.taskId, issue])), [issues])
  /** 目标模式进行中的 Issue（看板角标：非终态目标即视为自动推进中） */
  const autopilotIssues = useMemo(() => new Set(goals.filter((g) => !['completed', 'cancelled'].includes(g.status)).map((g) => g.issueId)), [goals])
  const cards = useMemo(() => tasks.map((task) => ({ task, issue: byTask.get(task.id) })).filter((item): item is { task: Task; issue: Issue } => !!item.issue), [tasks, byTask])
  const move = async (taskId: string, status: IssueStatus) => {
    setMenu(null)
    const issue = byTask.get(taskId)
    if (!issue) return
    const result = await bridge.issues.update(issue.id, { status })
    if (!result) toast.error('更新 issue 失败')
    else { setIssues((current) => current.map((item) => item.id === result.id ? result : item)); toast.success(`已移到「${ISSUE_STATUS_LABELS[status]}」`) }
  }
  const menuCard = menu ? cards.find((card) => card.task.id === menu.id) : undefined
  /** parked 任务一键启动：tasks:start 已实现清 parked + 入队 */
  const startTask = async (taskId: string) => {
    setStarting(taskId)
    try {
      const result = await taskService.start(taskId)
      if (!result.ok) toast.error(result.error ?? '启动失败')
    } finally {
      setStarting(null)
    }
  }
  return <div className="board issue-board">
    {COLUMNS.map((column) => {
      const items = cards.filter(({ issue }) => issue.status === column.key).sort((a, b) => b.issue.updatedAt - a.issue.updatedAt)
      return <div key={column.key} className={`board-col ${dropTarget === column.key ? 'is-drag-target' : ''}`} onDragEnter={() => setDropTarget(column.key)} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move' }} onDragLeave={(event) => { if (event.currentTarget === event.target) setDropTarget(null) }} onDrop={(event) => { event.preventDefault(); const id = event.dataTransfer.getData('text/task-id'); if (id) void move(id, column.key); setDropTarget(null) }}>
        <div className="board-col-head"><span className={`dot board-col-dot board-col-dot-${column.key}`} /><column.icon size={14} aria-hidden="true" /><span className="board-col-title">{column.label}</span><span className="board-col-count">{items.length}</span></div>
        <div className="board-col-body">{items.map(({ task, issue }) => { const parked = isParkedQueued(task); return <div key={task.id} className={`board-card issue-card status-${task.status}${parked ? ' is-parked' : ''}`} onClick={() => onOpen(task.id)} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setMenu({ id: task.id, x: event.clientX, y: event.clientY }) }} draggable onDragStart={(event) => { event.dataTransfer.setData('text/task-id', task.id); event.dataTransfer.effectAllowed = 'move' }} onDragEnd={() => setDropTarget(null)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(task.id) } }} role="button" tabIndex={0} title={task.prompt.slice(0, 120)}>
          <div className="board-card-head"><span className="issue-identifier">{issue.identifier}</span><IssueIdChip id={issue.id} />{parked && <span className="badge badge-parked" title="任务停放在队列外，等你手动启动">{PARKED_QUEUED_LABEL}</span>}{autopilotIssues.has(issue.id) && <span className="badge badge-goal" title="目标模式自动推进中">🎯</span>}{task.parentTaskId && <span className="badge badge-delegate">⚡ 委派</span>}{task.trigger === 'handoff' && <span className="badge badge-handoff">⇥ 接力</span>}{issue.priority !== 'none' && <span className={`badge priority-${issue.priority}`}>{PRIORITY_LABELS[issue.priority]}</span>}</div>
          <div className="board-card-title">{task.title}</div>
          <div className="board-card-meta"><span className="badge badge-meta">{task.backend}</span>{issue.labels.filter((label) => label !== '委派').slice(0, 2).map((label) => <span className="badge badge-meta" key={label}>{label}</span>)}{task.status === 'running' && <span className="mini board-card-time is-running">{TASK_STATUS_LABELS.running}…</span>}{task.startedAt && task.endedAt && <span className="mini board-card-time">{fmtDuration(task.endedAt - task.startedAt)}</span>}{task.status !== 'running' && task.status !== 'queued' && <span className="mini board-card-time">{fmtTime(task.endedAt)}</span>}{task.workdir && <span className="mini board-card-time workdir">{task.workdir.split(/[\\/]/).pop()}</span>}{parked && <button className="btn board-card-start" disabled={starting === task.id} title="清停放并加入执行队列" onClick={(event) => { event.stopPropagation(); void startTask(task.id) }} onKeyDown={(event) => event.stopPropagation()}>▶ 启动</button>}</div>
        </div>})}{items.length === 0 && <EmptyState compact title="空" />}</div>
      </div>
    })}
    {menu && menuCard && <div className="board-context-menu" role="menu" style={{ left: menu.x, top: menu.y }} onClick={(event) => event.stopPropagation()}><button role="menuitem" onClick={() => { setMenu(null); onOpen(menuCard.task.id) }}>打开 issue</button><div className="board-context-separator" />{COLUMNS.filter((column) => column.key !== menuCard.issue.status).map((column) => <button key={column.key} role="menuitem" onClick={() => void move(menuCard.task.id, column.key)}>移到「{column.label}」</button>)}</div>}
  </div>
}
