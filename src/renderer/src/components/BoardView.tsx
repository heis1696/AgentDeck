import { useEffect, useMemo, useState } from 'react'
import type { Goal, Issue, IssueStatus, Task } from '../../../shared/types'
import type { Meeting } from '../../../shared/meeting'
import { bridge, fmtDuration } from '../api'
import { ISSUE_STATUS_LABELS, TASK_STATUS_LABELS, isParkedQueued, PARKED_QUEUED_LABEL } from '../labels'
import { taskService } from '../task-service'
import { toast } from '../ui/Toasts'
import { IssueIdChip } from '../ui/IssueIdChip'
import { EmptyState } from '../ui/EmptyState'
import { CheckCircle2, CircleAlert, CircleDot, Clock3, Ban, Eye, ListTodo, Search, ChevronDown, ChevronRight } from 'lucide-react'

type Scope = 'all' | 'mine' | 'agents'
type CardKind = 'normal' | 'delegate' | 'handoff' | 'goal' | 'meeting'
export type BoardNode = { task: Task; issue?: Issue; children: BoardNode[] }
const PRIORITY_LABELS: Record<Issue['priority'], string> = { urgent: '紧急', high: '高', medium: '中', low: '低', none: '无' }
const KIND_LABELS: Record<CardKind, string> = { normal: '普通', delegate: '委派', handoff: '接力', goal: '目标', meeting: '会议' }
const DAY = 86_400_000
const DATE_GROUPS = ['今天', '昨天', '近7天', '更早（≤30天）', '超30天 · 保留']
const COLUMNS: { key: IssueStatus; label: string; icon: typeof Clock3 }[] = [
  { key: 'backlog', label: ISSUE_STATUS_LABELS.backlog, icon: ListTodo },
  { key: 'todo', label: ISSUE_STATUS_LABELS.todo, icon: Clock3 },
  { key: 'in_progress', label: ISSUE_STATUS_LABELS.in_progress, icon: CircleDot },
  { key: 'in_review', label: ISSUE_STATUS_LABELS.in_review, icon: Eye },
  { key: 'done', label: ISSUE_STATUS_LABELS.done, icon: CheckCircle2 },
  { key: 'blocked', label: ISSUE_STATUS_LABELS.blocked, icon: CircleAlert },
  { key: 'cancelled', label: ISSUE_STATUS_LABELS.cancelled, icon: Ban }
]

export function boardDateGroup(ts: number, now: number): string {
  const today = new Date(now).setHours(0, 0, 0, 0)
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  if (ts >= today) return DATE_GROUPS[0]
  if (ts >= yesterday.getTime()) return DATE_GROUPS[1]
  if (now - ts < 7 * DAY) return DATE_GROUPS[2]
  return now - ts <= 30 * DAY ? DATE_GROUPS[3] : DATE_GROUPS[4]
}

export function relativeBoardTime(ts: number, now: number): string {
  const diff = Math.max(0, now - ts)
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < DAY) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / DAY)} 天前`
}

export function boardCardKind(task: Task, issue: Issue | undefined, goalIssues: Set<string>, meetingIssues: Set<string>): CardKind {
  if (issue && meetingIssues.has(issue.id)) return 'meeting'
  if (task.goalId || (issue && goalIssues.has(issue.id))) return 'goal'
  if (task.trigger === 'handoff') return 'handoff'
  if (task.parentTaskId || issue?.createdBy === 'agent') return 'delegate'
  return 'normal'
}

/** Historical leader runs resolve to the current card of the same Issue. */
export function buildBoardTree(tasks: Task[], issues: Issue[]): { roots: BoardNode[]; orphans: BoardNode[] } {
  const byIssue = new Map(issues.map((issue) => [issue.id, issue]))
  const byTask = new Map(issues.map((issue) => [issue.taskId, issue]))
  const issueOf = (task: Task) => byIssue.get(task.issueId ?? `iss_${task.id}`) ?? byTask.get(task.id)
  const nodes = new Map<string, BoardNode>()
  for (const task of tasks) {
    const issue = issueOf(task)
    if (issue && issue.taskId !== task.id) continue
    if (!issue && !task.parentTaskId) continue
    nodes.set(task.id, { task, issue, children: [] })
  }
  const aliases = new Map(tasks.map((task) => [task.id, nodes.get(issueOf(task)?.taskId ?? task.id)]))
  const roots: BoardNode[] = []
  const orphans: BoardNode[] = []
  for (const node of nodes.values()) {
    const parentId = node.task.parentTaskId
    if (!parentId) { roots.push(node); continue }
    const parent = aliases.get(parentId)
    const seen = new Set([node.task.id])
    let ancestor = parent
    while (ancestor && !seen.has(ancestor.task.id)) {
      seen.add(ancestor.task.id)
      ancestor = ancestor.task.parentTaskId ? aliases.get(ancestor.task.parentTaskId) : undefined
    }
    if (parent && !ancestor) parent.children.push(node)
    else orphans.push(node)
  }
  return { roots, orphans }
}

function nodeStatus(node: BoardNode): IssueStatus {
  return node.issue?.status ?? ({ queued: 'todo', running: 'in_progress', done: 'done', failed: 'blocked', cancelled: 'cancelled' } as const)[node.task.status]
}
function updatedAt(node: BoardNode) { return node.issue?.updatedAt ?? node.task.endedAt ?? node.task.createdAt }
function elapsed(task: Task, now: number) { return task.startedAt ? fmtDuration(Math.max(0, (task.endedAt ?? now) - task.startedAt)) : '未开始' }
function descendants(node: BoardNode): BoardNode[] { return node.children.flatMap((child) => [child, ...descendants(child)]) }

export function BoardView({ tasks, onOpen }: { tasks: Task[]; onOpen: (id: string) => void }) {
  const [issues, setIssues] = useState<Issue[]>([])
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<Scope>('all')
  const [status, setStatus] = useState<IssueStatus | 'all'>('all')
  const [goals, setGoals] = useState<Goal[]>([])
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [now, setNow] = useState(Date.now)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [dropTarget, setDropTarget] = useState<IssueStatus | null>(null)
  const [starting, setStarting] = useState<string | null>(null)
  useEffect(() => {
    const refresh = () => void bridge.issues.list().then(setIssues).catch(() => toast.error('读取 Issue 失败'))
    refresh()
    const off = bridge.issues.onUpdated(refresh)
    const offTasks = bridge.tasks.onDeleted(refresh)
    const offGoals = bridge.goals.onUpdated((goal) => setGoals((cur) => cur.some((g) => g.id === goal.id) ? cur.map((g) => g.id === goal.id ? goal : g) : [...cur, goal]))
    const offGoalDeleted = bridge.goals.onDeleted((id) => setGoals((cur) => cur.filter((g) => g.id !== id)))
    void bridge.goals.list().then(setGoals).catch(() => {})
    const offMeetings = bridge.meetings.onUpdated((meeting) => setMeetings((cur) => cur.some((m) => m.id === meeting.id) ? cur.map((m) => m.id === meeting.id ? meeting : m) : [...cur, meeting]))
    const offMeetingDeleted = bridge.meetings.onDeleted((id) => setMeetings((cur) => cur.filter((m) => m.id !== id)))
    void bridge.meetings.list().then(setMeetings).catch(() => {})
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => { off(); offTasks(); offGoals(); offGoalDeleted(); offMeetings(); offMeetingDeleted(); window.clearInterval(timer) }
  }, [])
  useEffect(() => {
    const close = () => setMenu(null)
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('click', close); window.removeEventListener('blur', close); window.removeEventListener('keydown', escape) }
  }, [])
  const byTask = useMemo(() => new Map(issues.map((issue) => [issue.taskId, issue])), [issues])
  const goalIssues = useMemo(() => new Set(goals.map((g) => g.issueId)), [goals])
  const meetingIssues = useMemo(() => new Set(meetings.map((m) => m.issueId)), [meetings])
  const tree = useMemo(() => buildBoardTree(tasks, issues), [tasks, issues])
  const filtering = !!query.trim() || scope !== 'all' || status !== 'all'
  const matches = (node: BoardNode): boolean => {
    const { task, issue } = node
    const agent = issue?.createdBy === 'agent' || !!task.parentTaskId
    const q = query.trim().toLowerCase()
    const own = (scope === 'all' || (scope === 'agents' ? agent : !agent))
      && (status === 'all' || nodeStatus(node) === status)
      && (!q || `${issue?.identifier ?? ''} ${task.title} ${task.prompt} ${issue?.labels.join(' ') ?? ''} ${task.backend}`.toLowerCase().includes(q))
    return own || node.children.some(matches)
  }
  const move = async (taskId: string, next: IssueStatus) => {
    setMenu(null)
    const issue = byTask.get(taskId)
    if (!issue) return
    try {
      const result = await bridge.issues.update(issue.id, { status: next })
      if (!result) toast.error('更新 Issue 失败')
      else { setIssues((cur) => cur.map((item) => item.id === result.id ? result : item)); toast.success(`已移到「${ISSUE_STATUS_LABELS[next]}」`) }
    } catch { toast.error('更新 Issue 失败') }
  }
  const startTask = async (taskId: string) => {
    setStarting(taskId)
    try {
      const result = await taskService.start(taskId)
      if (!result.ok) toast.error(result.error ?? '启动失败')
    } catch { toast.error('启动失败') } finally { setStarting(null) }
  }
  const toggle = (id: string) => setExpanded((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const childRows = (nodes: BoardNode[]): React.ReactNode => <div className="board-child-list">{nodes.map((node) => <div key={node.task.id}>
    <button className={`board-child-row status-${node.task.status}`} onClick={() => onOpen(node.task.id)} title={`${TASK_STATUS_LABELS[node.task.status]} · ${node.task.title}`}>
      <span className={`dot dot-${node.task.status}`} /><span className="board-child-title">{node.task.title}</span><span className="board-child-time">{elapsed(node.task, now)}</span>
    </button>{node.children.length > 0 && childRows(node.children)}
  </div>)}</div>
  const renderCard = (node: BoardNode) => {
    const { task, issue } = node
    const parked = isParkedQueued(task)
    const kind = boardCardKind(task, issue, goalIssues, meetingIssues)
    const workers = descendants(node)
    const done = workers.filter((child) => child.task.status === 'done').length
    const open = filtering || expanded.has(task.id)
    return <article key={task.id} className={`board-card issue-card kind-${kind} status-${task.status}${parked ? ' is-parked' : ''}`} data-card-kind={kind} data-task-id={task.id}
      onClick={(event) => { if (!(event.target as HTMLElement).closest('button, a, input, select')) onOpen(task.id) }}
      onContextMenu={(event) => { if (!issue) return; event.preventDefault(); event.stopPropagation(); setMenu({ id: task.id, x: Math.min(event.clientX, window.innerWidth - 190), y: Math.min(event.clientY, window.innerHeight - 310) }) }}
      draggable={!!issue} onDragStart={(event) => { event.dataTransfer.setData('text/task-id', task.id); event.dataTransfer.effectAllowed = 'move' }} onDragEnd={() => setDropTarget(null)}>
      <div className="board-card-head"><span className="issue-identifier">{issue?.identifier ?? task.id}</span>{issue && <IssueIdChip id={issue.id} />}{issue && issue.priority !== 'none' && <span className={`badge board-priority priority-${issue.priority}`}>{PRIORITY_LABELS[issue.priority]}</span>}</div>
      <button className="board-card-open" onClick={() => onOpen(task.id)} title={task.prompt.slice(0, 120)}><span className="board-card-title">{issue?.title ?? task.title}</span></button>
      <div className="board-card-tags"><span className="board-kind-badge">{KIND_LABELS[kind]}</span>{parked && <span className="badge badge-parked">{PARKED_QUEUED_LABEL}</span>}{task.status === 'running' && <span className="board-running-label">运行中</span>}{issue?.labels.filter((label) => label !== '委派').slice(0, 2).map((label) => <span className="badge badge-meta" key={label}>{label}</span>)}</div>
      <div className="board-card-meta"><span className="badge board-backend">{task.backend}</span><span className="board-elapsed" title="执行耗时">{elapsed(task, now)}</span><time className="board-updated" dateTime={new Date(updatedAt(node)).toISOString()} title={new Date(updatedAt(node)).toLocaleString()}>{relativeBoardTime(updatedAt(node), now)}</time></div>
      {parked && <button className="btn board-card-start" disabled={starting === task.id} onClick={() => void startTask(task.id)}>▶ 启动</button>}
      {workers.length > 0 && <div className="board-workers"><button className="board-workers-toggle" aria-expanded={open} aria-controls={`workers-${task.id}`} onClick={() => toggle(task.id)} disabled={filtering} title={filtering ? '筛选时展开子单以保留匹配上下文' : '展开或折叠子派单'}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<span>子单</span><strong>{done}/{workers.length}</strong><span className="board-worker-progress" role="progressbar" aria-label="子单完成进度" aria-valuenow={done} aria-valuemin={0} aria-valuemax={workers.length}><span style={{ width: `${done / workers.length * 100}%` }} /></span></button>{open && <div id={`workers-${task.id}`}>{childRows(node.children)}</div>}</div>}
    </article>
  }
  const menuIssue = menu ? byTask.get(menu.id) : undefined
  return <div className="board-page">
    <div className="issues-toolbar board-toolbar">
      <div className="issues-scopes" role="tablist" aria-label="看板范围">{([['all', '全部'], ['mine', '我的'], ['agents', '智能体']] as const).map(([key, label]) => <button key={key} className={scope === key ? 'active' : ''} role="tab" aria-selected={scope === key} onClick={() => setScope(key)}>{label}</button>)}</div>
      <label className="issues-search"><Search size={14} /><input aria-label="搜索 Issue" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Issue…" /></label>
      <select className="issues-status-select" value={status} onChange={(event) => setStatus(event.target.value as IssueStatus | 'all')} aria-label="按状态筛选"><option value="all">所有状态</option>{COLUMNS.map((column) => <option value={column.key} key={column.key}>{column.label}</option>)}</select>
      <span className="board-retention-note" title="仅清理超过30天、全部执行终结且无活跃目标/会议绑定的 Issue；未完成工作始终保留">终态保留 30 天</span>
    </div>
    <div className="board issue-board">{COLUMNS.map((column) => {
      const items = tree.roots.filter((node) => nodeStatus(node) === column.key && matches(node)).sort((a, b) => updatedAt(b) - updatedAt(a))
      const orphans = tree.orphans.filter((node) => nodeStatus(node) === column.key && matches(node)).sort((a, b) => updatedAt(b) - updatedAt(a))
      return <section key={column.key} className={`board-col ${dropTarget === column.key ? 'is-drag-target' : ''}`} aria-label={column.label} onDragEnter={() => setDropTarget(column.key)} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move' }} onDragLeave={(event) => { if (event.currentTarget === event.target) setDropTarget(null) }} onDrop={(event) => { event.preventDefault(); const id = event.dataTransfer.getData('text/task-id'); if (id) void move(id, column.key); setDropTarget(null) }}>
        <div className="board-col-head"><span className={`dot board-col-dot board-col-dot-${column.key}`} /><column.icon size={14} aria-hidden="true" /><span className="board-col-title">{column.label}</span><span className="board-col-count">{items.length + orphans.length}</span></div>
        <div className="board-col-body">{DATE_GROUPS.map((group) => {
          const grouped = items.filter((node) => boardDateGroup(updatedAt(node), now) === group)
          // 「更早（≤30天）」节已贴 30 天清理边界：一次性角标提醒这批卡会被自动清扫
          const expiring = group === DATE_GROUPS[3]
          return grouped.length > 0 && <section className="board-date-section" key={group}><h3 className="board-section-head">{group}{expiring && <span className="board-expiring-badge" title="超过 30 天且全部执行终结的 Issue 会被自动清理；未完成工作始终保留">将自动清理</span>}<span>{grouped.length}</span></h3>{grouped.map(renderCard)}</section>
        })}{orphans.length > 0 && <section className="board-orphans"><h3 className="board-section-head">（无领队）<span>{orphans.length}</span></h3>{orphans.map(renderCard)}</section>}{!items.length && !orphans.length && <EmptyState compact title={filtering ? '无匹配' : '空'} />}</div>
      </section>
    })}</div>
    {menu && menuIssue && <div className="board-context-menu" role="menu" style={{ left: menu.x, top: menu.y }} onClick={(event) => event.stopPropagation()}><button role="menuitem" onClick={() => { setMenu(null); onOpen(menu.id) }}>打开 Issue</button><div className="board-context-separator" />{COLUMNS.filter((column) => column.key !== menuIssue.status).map((column) => <button key={column.key} role="menuitem" onClick={() => void move(menu.id, column.key)}>移到「{column.label}」</button>)}</div>}
  </div>
}
