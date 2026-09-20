import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Goal, Issue, IssueStatus, Task } from '../../../shared/types'
import type { Meeting } from '../../../shared/meeting'
import { bridge, fmtDuration } from '../api'
import { ISSUE_STATUS_LABELS, TASK_STATUS_LABELS, isParkedQueued, PARKED_QUEUED_LABEL } from '../labels'
import { taskService } from '../task-service'
import { ui } from '../ui/interaction-center'
import { useInteractionLayer } from '../hooks/useInteractionLayer'
import { IssueIdChip } from '../ui/IssueIdChip'
import { EmptyState } from '../ui/EmptyState'
import { Ban, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, CircleDot, Clock3, Eye, ListTodo, LoaderCircle, RefreshCw, Search, X } from 'lucide-react'
import { currentGitChanges } from '../../../shared/git-snapshot'

type Scope = 'all' | 'mine' | 'agents'
type CardKind = 'normal' | 'delegate' | 'handoff' | 'goal' | 'meeting'
export type BoardNode = { task: Task; issue?: Issue; children: BoardNode[] }
const PRIORITY_LABELS: Record<Issue['priority'], string> = { urgent: '紧急', high: '高', medium: '中', low: '低', none: '无' }
const KIND_LABELS: Record<CardKind, string> = { normal: '普通', delegate: '委派', handoff: '接力', goal: '目标', meeting: '会议' }
const DAY = 86_400_000
const EXPIRING_TITLE = '超过 30 天且全部执行终结的 Issue 会被自动清理；未完成工作始终保留'
/** 选中日期没有任何卡片时，列空态的统一提示 */
export const BOARD_EMPTY_DAY_HINT = '这一天没有 Issue'
export const BOARD_EMPTY_ALL_HINT = '还没有 Issue'
const COLUMNS: { key: IssueStatus; label: string; icon: typeof Clock3 }[] = [
  { key: 'backlog', label: ISSUE_STATUS_LABELS.backlog, icon: ListTodo },
  { key: 'todo', label: ISSUE_STATUS_LABELS.todo, icon: Clock3 },
  { key: 'in_progress', label: ISSUE_STATUS_LABELS.in_progress, icon: CircleDot },
  { key: 'in_review', label: ISSUE_STATUS_LABELS.in_review, icon: Eye },
  { key: 'done', label: ISSUE_STATUS_LABELS.done, icon: CheckCircle2 },
  { key: 'blocked', label: ISSUE_STATUS_LABELS.blocked, icon: CircleAlert },
  { key: 'cancelled', label: ISSUE_STATUS_LABELS.cancelled, icon: Ban }
]

/** 本地时区当日 0 点：单日视图跨天归属的唯一基准 */
export function boardDayFloor(ts: number): number {
  return new Date(ts).setHours(0, 0, 0, 0)
}

/** 本地日期键 YYYY-MM-DD（日节头 DOM 标记 / 下拉选项展示） */
export function boardDayKey(floor: number): string {
  const day = new Date(floor)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`
}

/** 顶栏日期文案：今天·9月18日 / 9月15日，跨年补年份 */
export function formatBoardDay(floor: number, todayFloor: number): string {
  const day = new Date(floor)
  const monthDay = `${day.getMonth() + 1}月${day.getDate()}日`
  if (floor === todayFloor) return `今天·${monthDay}`
  return day.getFullYear() === new Date(todayFloor).getFullYear() ? monthDay : `${day.getFullYear()}年${monthDay}`
}

/** 单步日期导航：+1 向未来但钳在今天，-1 向过去不设上限（受 30 天保留窗自然约束） */
export function shiftBoardDay(floor: number, delta: number, todayFloor: number): number {
  return delta > 0 ? Math.min(floor + DAY, todayFloor) : floor - DAY
}

/** 时间戳是否归属选中日期（本地 0 点至次日 0 点） */
export function onBoardDay(ts: number, floor: number): boolean {
  return boardDayFloor(ts) === floor
}

/** 日期下拉选项：只列有卡片的日期（去重降序），空日期不列；超龄受保护日期自然保留 */
export function boardDayOptions(timestamps: number[]): number[] {
  return [...new Set(timestamps.map(boardDayFloor))].sort((a, b) => b - a)
}

/** 选中日期是否已越过 30 天保留窗（这一天还可见的卡都是受保护卡，节头出现「将自动清理」角标） */
export function isOverAgeDay(floor: number, todayFloor: number): boolean {
  return todayFloor - floor >= 30 * DAY
}

/** gitStat（git diff --stat 文本）→ 迷你卡改动徽标数据；无数据返回 undefined（次行跳过徽标） */
export function boardDiffStat(gitStat: string | undefined): { files: number; plus?: number; minus?: number } | undefined {
  if (!gitStat) return undefined
  const lines = gitStat.split('\n')
  const files = lines.filter((line) => line.includes('|')).length
  const summary = lines.find((line) => /files? changed/.test(line)) ?? ''
  const plus = summary.match(/(\d+) insertions?/)
  const minus = summary.match(/(\d+) deletions?/)
  if (!files && !plus && !minus) return undefined
  return { files, plus: plus ? Number(plus[1]) : undefined, minus: minus ? Number(minus[1]) : undefined }
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
  const [loading, setLoading] = useState(true)
  const [issuesLoaded, setIssuesLoaded] = useState(false)
  const [issuesError, setIssuesError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<Scope>('all')
  const [status, setStatus] = useState<IssueStatus | 'all'>('all')
  const [goals, setGoals] = useState<Goal[]>([])
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [now, setNow] = useState(Date.now)
  // 默认展示所有保留日期，避免用户首次打开看板只能看到今天。
  const [selectedDay, setSelectedDay] = useState<number | null>(null)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [dropTarget, setDropTarget] = useState<IssueStatus | null>(null)
  const [draggingTask, setDraggingTask] = useState<string | null>(null)
  const [starting, setStarting] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const issuesRequestRef = useRef(0)
  // 统一浮层：卡片右键菜单的外点关闭 / 最上层 Escape（原 window click+keydown 监听已收敛）
  useInteractionLayer<HTMLDivElement>({ open: menu !== null, onClose: () => setMenu(null), kind: 'popover', name: 'board-card-menu', closeOnOutside: true, autoFocus: false, layerRef: menuRef })
  const refreshIssues = useCallback(async () => {
    const request = ++issuesRequestRef.current
    setLoading(true)
    try {
      const next = await bridge.issues.list()
      if (request !== issuesRequestRef.current) return
      setIssues(next)
      setIssuesLoaded(true)
      setIssuesError(null)
    } catch (cause) {
      if (request === issuesRequestRef.current) setIssuesError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (request === issuesRequestRef.current) setLoading(false)
    }
  }, [])
  useEffect(() => {
    void refreshIssues()
    const off = bridge.issues.onUpdated(() => { void refreshIssues() })
    const offTasks = bridge.tasks.onDeleted(() => { void refreshIssues() })
    const offGoals = bridge.goals.onUpdated((goal) => setGoals((cur) => cur.some((g) => g.id === goal.id) ? cur.map((g) => g.id === goal.id ? goal : g) : [...cur, goal]))
    const offGoalDeleted = bridge.goals.onDeleted((id) => setGoals((cur) => cur.filter((g) => g.id !== id)))
    void bridge.goals.list().then(setGoals).catch(() => {})
    const offMeetings = bridge.meetings.onUpdated((meeting) => setMeetings((cur) => cur.some((m) => m.id === meeting.id) ? cur.map((m) => m.id === meeting.id ? meeting : m) : [...cur, meeting]))
    const offMeetingDeleted = bridge.meetings.onDeleted((id) => setMeetings((cur) => cur.filter((m) => m.id !== id)))
    void bridge.meetings.list().then(setMeetings).catch(() => {})
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => { issuesRequestRef.current++; off(); offTasks(); offGoals(); offGoalDeleted(); offMeetings(); offMeetingDeleted(); window.clearInterval(timer) }
  }, [refreshIssues])
  useEffect(() => {
    if (!menu) return
    // 窗口失焦收起（外点/Escape 已由统一交互层负责）
    const close = () => setMenu(null)
    window.addEventListener('blur', close)
    return () => window.removeEventListener('blur', close)
  }, [menu])
  const byTask = useMemo(() => new Map(issues.map((issue) => [issue.taskId, issue])), [issues])
  const goalIssues = useMemo(() => new Set(goals.map((g) => g.issueId)), [goals])
  const meetingIssues = useMemo(() => new Set(meetings.map((m) => m.issueId)), [meetings])
  const tree = useMemo(() => buildBoardTree(tasks, issues), [tasks, issues])
  const todayFloor = boardDayFloor(now)
  // null = 全部档（反馈三轮4）：不受日期过滤，30 天保留窗内所有卡都显示
  const dayRoots = useMemo(() => selectedDay == null ? tree.roots : tree.roots.filter((node) => onBoardDay(updatedAt(node), selectedDay)), [tree, selectedDay])
  const dayOrphans = useMemo(() => selectedDay == null ? tree.orphans : tree.orphans.filter((node) => onBoardDay(updatedAt(node), selectedDay)), [tree, selectedDay])
  const dayHasCards = dayRoots.length + dayOrphans.length > 0
  const dayTotal = dayRoots.length + dayOrphans.length
  const overAgeDay = selectedDay != null && isOverAgeDay(selectedDay, todayFloor) && dayHasCards
  const dayOptions = useMemo(() => boardDayOptions([...tree.roots, ...tree.orphans].map((node) => updatedAt(node))), [tree])
  const filtering = !!query.trim() || scope !== 'all' || status !== 'all'
  const dateFiltered = selectedDay != null
  const matches = (node: BoardNode): boolean => {
    const { task, issue } = node
    const agent = issue?.createdBy === 'agent' || !!task.parentTaskId
    const q = query.trim().toLowerCase()
    const own = (scope === 'all' || (scope === 'agents' ? agent : !agent))
      && (status === 'all' || nodeStatus(node) === status)
      && (!q || `${issue?.identifier ?? ''} ${task.title} ${task.prompt} ${issue?.labels.join(' ') ?? ''} ${task.backend}`.toLowerCase().includes(q))
    return own || node.children.some(matches)
  }
  const visibleCount = useMemo(() => [...dayRoots, ...dayOrphans].filter(matches).length, [dayRoots, dayOrphans, query, scope, status])
  const move = async (taskId: string, next: IssueStatus) => {
    setMenu(null)
    const issue = byTask.get(taskId)
    if (!issue) return
    try {
      const result = await bridge.issues.update(issue.id, { status: next })
      if (!result) ui.toast.error('更新 Issue 失败')
      else { setIssues((cur) => cur.map((item) => item.id === result.id ? result : item)); ui.toast.success(`已移到「${ISSUE_STATUS_LABELS[next]}」`) }
    } catch { ui.toast.error('更新 Issue 失败') }
  }
  const startTask = async (taskId: string) => {
    setStarting(taskId)
    try {
      const result = await taskService.start(taskId)
      if (!result.ok) ui.toast.error(result.error ?? '启动失败')
    } catch { ui.toast.error('启动失败') } finally { setStarting(null) }
  }
  const toggle = (id: string) => setExpanded((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next })
  /** 子单两行迷你卡：改动徽标只来自本次执行的有效 Git 快照。 */
  const diffBadge = (task: Task) => {
    const stat = boardDiffStat(currentGitChanges(task)?.stat)
    if (!stat) return null
    return <span className="badge board-child-diff" title="完成时抓取的 git 改动统计">{stat.files > 0 && <span>{stat.files}文件</span>}{stat.plus !== undefined && <span className="diff-add">+{stat.plus}</span>}{stat.minus !== undefined && <span className="diff-del">−{stat.minus}</span>}</span>
  }
  const childCards = (nodes: BoardNode[]): React.ReactNode => <div className="board-child-list">{nodes.map((node) => <div key={node.task.id} className="board-child-item">
    <button className="board-child-card" data-status={node.task.status} onClick={() => onOpen(node.task.id)} title={`${TASK_STATUS_LABELS[node.task.status]} · ${node.task.title}`}>
      <span className="board-child-line1">
        <span className={`dot dot-${node.task.status}${node.task.status === 'running' ? ' board-child-dot-running' : ''}`} />
        <span className="board-child-title">{node.task.title}</span>
        <span className="board-child-state">{TASK_STATUS_LABELS[node.task.status]}</span>
        {node.task.startedAt && <span className="board-child-time">{elapsed(node.task, now)}</span>}
      </span>
      <span className="board-child-line2">
        <span className="badge board-child-backend">{node.task.backend}</span>
        {diffBadge(node.task)}
      </span>
    </button>
    {node.children.length > 0 && childCards(node.children)}
  </div>)}</div>
  const renderCard = (node: BoardNode) => {
    const { task, issue } = node
    const parked = isParkedQueued(task)
    const kind = boardCardKind(task, issue, goalIssues, meetingIssues)
    const workers = descendants(node)
    const done = workers.filter((child) => child.task.status === 'done').length
    const open = filtering || expanded.has(task.id)
    return <article key={task.id} className={`board-card issue-card kind-${kind} status-${task.status}${parked ? ' is-parked' : ''}${draggingTask === task.id ? ' is-dragging' : ''}`} data-card-kind={kind} data-task-id={task.id}
      onClick={(event) => { if (!(event.target as HTMLElement).closest('button, a, input, select')) onOpen(task.id) }}
      onContextMenu={(event) => { if (!issue) return; event.preventDefault(); event.stopPropagation(); setMenu({ id: task.id, x: Math.min(event.clientX, window.innerWidth - 190), y: Math.min(event.clientY, window.innerHeight - 310) }) }}
      draggable={!!issue} onDragStart={(event) => { setDraggingTask(task.id); event.dataTransfer.setData('text/task-id', task.id); event.dataTransfer.effectAllowed = 'move' }} onDragEnd={() => { setDraggingTask(null); setDropTarget(null) }}>
      <div className="board-card-head"><span className="issue-identifier">{issue?.identifier ?? task.id}</span>{issue && <IssueIdChip id={issue.id} />}{issue && issue.priority !== 'none' && <span className={`badge board-priority priority-${issue.priority}`}>{PRIORITY_LABELS[issue.priority]}</span>}</div>
      <button className="board-card-open" onClick={() => onOpen(task.id)} title={task.prompt.slice(0, 120)}><span className="board-card-title">{issue?.title ?? task.title}</span></button>
      <div className="board-card-tags"><span className="board-kind-badge">{KIND_LABELS[kind]}</span>{parked && <span className="badge badge-parked">{PARKED_QUEUED_LABEL}</span>}{task.status === 'running' && <span className="board-running-label">运行中</span>}{issue?.labels.filter((label) => label !== '委派').slice(0, 2).map((label) => <span className="badge badge-meta" key={label}>{label}</span>)}</div>
      <div className="board-card-meta"><span className="badge board-backend">{task.backend}</span><span className="board-elapsed" title="执行耗时">{elapsed(task, now)}</span><time className="board-updated" dateTime={new Date(updatedAt(node)).toISOString()} title={new Date(updatedAt(node)).toLocaleString()}>{relativeBoardTime(updatedAt(node), now)}</time></div>
      {parked && <button className="btn board-card-start" disabled={starting === task.id} onClick={() => void startTask(task.id)}>▶ 启动</button>}
      {workers.length > 0 && <section className="board-workers">
        <button className="board-workers-toggle" aria-expanded={open} aria-controls={`workers-${task.id}`} onClick={() => toggle(task.id)} disabled={filtering} title={filtering ? '筛选时展开子单以保留匹配上下文' : '展开或折叠子派单'}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<span>子单</span><strong>{done}/{workers.length}</strong><span className="board-worker-progress" role="progressbar" aria-label="子单完成进度" aria-valuenow={done} aria-valuemin={0} aria-valuemax={workers.length}><span style={{ width: `${done / workers.length * 100}%` }} /></span></button>
        {open && <div className="board-child-root" id={`workers-${task.id}`}>{childCards(node.children)}</div>}
      </section>}
    </article>
  }
  const menuIssue = menu ? byTask.get(menu.id) : undefined
  const clearFilters = () => { setQuery(''); setScope('all'); setStatus('all'); setSelectedDay(null) }
  return <div className="board-page">
    <div className="issues-toolbar board-toolbar">
      <div className="board-toolbar-heading"><strong>工作流</strong><span>{loading ? '正在同步…' : `${visibleCount} / ${dayTotal} 个 Issue`}</span></div>
      <div className="issues-scopes" role="tablist" aria-label="看板范围">{([['all', '全部'], ['mine', '我的'], ['agents', '智能体']] as const).map(([key, label]) => <button key={key} className={scope === key ? 'active' : ''} role="tab" aria-selected={scope === key} onClick={() => setScope(key)}>{label}</button>)}</div>
      <label className="issues-search"><Search size={14} /><input aria-label="搜索 Issue" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Issue…" /></label>
      <select className="issues-status-select" value={status} onChange={(event) => setStatus(event.target.value as IssueStatus | 'all')} aria-label="按状态筛选"><option value="all">所有状态</option>{COLUMNS.map((column) => <option value={column.key} key={column.key}>{column.label}</option>)}</select>
      {(filtering || dateFiltered) && <button type="button" className="board-filter-reset" aria-label="重置看板筛选" title="重置看板筛选（包含日期）" onClick={clearFilters}><X size={13} /> 重置筛选</button>}
      <div className="board-day-nav" role="group" aria-label="按最后更新时间筛选日期">
        <span className="board-day-nav-caption">最后更新</span>
        <button type="button" className={`board-day-nav-all${selectedDay == null ? ' is-active' : ''}`} aria-pressed={selectedDay == null} title="显示保留窗内全部日期的 Issue" onClick={() => setSelectedDay(null)}>全部日期</button>
        <button type="button" className="board-day-nav-btn" aria-label="前一天" title="前一天" disabled={selectedDay == null} onClick={() => setSelectedDay((day) => day == null ? day : shiftBoardDay(day, -1, todayFloor))}><ChevronLeft size={14} /></button>
         {selectedDay != null && <span className="board-day-nav-label" aria-live="polite">{formatBoardDay(selectedDay, todayFloor)}</span>}
        <button type="button" className="board-day-nav-btn" aria-label="后一天" title="后一天" disabled={selectedDay == null || selectedDay >= todayFloor} onClick={() => setSelectedDay((day) => day == null ? day : shiftBoardDay(day, 1, todayFloor))}><ChevronRight size={14} /></button>
        <button type="button" className="board-day-nav-today" disabled={selectedDay === todayFloor} onClick={() => setSelectedDay(todayFloor)}>今天</button>
        <select className="board-day-nav-select" aria-label="按最后更新时间跳转日期" value={selectedDay == null ? 'all' : String(selectedDay)} onChange={(event) => setSelectedDay(event.target.value === 'all' ? null : Number(event.target.value))}>
          <option value="all">全部日期</option>
          {selectedDay != null && !dayOptions.includes(selectedDay) && <option value={String(selectedDay)}>{formatBoardDay(selectedDay, todayFloor)}</option>}
          {dayOptions.map((floor) => <option key={floor} value={String(floor)}>{formatBoardDay(floor, todayFloor)}</option>)}
        </select>
      </div>
      <span className="board-retention-note" title="日期按 Issue 最后更新时间归类；仅清理超过30天、全部执行终结且无活跃目标/会议绑定的 Issue">按最后更新时间 · 终态保留 30 天</span>
    </div>
    {issuesError && <div className="data-state-banner data-state-stale" role="status"><CircleAlert size={14} /><span>{issuesLoaded ? '显示上次成功的 Issue 快照：' : '看板加载失败：'}{issuesError}</span><button className="btn" type="button" onClick={() => void refreshIssues()} disabled={loading}><RefreshCw size={13} className={loading ? 'spin' : ''} /> 重试</button></div>}
    <div className="board-day-head" data-day-key={selectedDay == null ? 'all' : boardDayKey(selectedDay)}>
      <span className="board-day-head-date">{selectedDay == null ? '最后更新：全部日期（30 天保留窗）' : `最后更新：${formatBoardDay(selectedDay, todayFloor)}`}</span>
      <span className="board-day-head-count">{loading ? '正在读取最新状态…' : dayTotal > 0 ? `共 ${dayTotal} 个 Issue` : selectedDay == null ? BOARD_EMPTY_ALL_HINT : BOARD_EMPTY_DAY_HINT}</span>
      {overAgeDay && <span className="board-expiring-badge" title={EXPIRING_TITLE}>将自动清理</span>}
    </div>
    <div className="board issue-board">{COLUMNS.map((column) => {
      const items = dayRoots.filter((node) => nodeStatus(node) === column.key && matches(node)).sort((a, b) => updatedAt(b) - updatedAt(a))
      const orphans = dayOrphans.filter((node) => nodeStatus(node) === column.key && matches(node)).sort((a, b) => updatedAt(b) - updatedAt(a))
      return <section key={column.key} className={`board-col ${dropTarget === column.key ? 'is-drag-target' : ''}`} aria-label={column.label} onDragEnter={() => setDropTarget(column.key)} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move' }} onDragLeave={(event) => { if (event.currentTarget === event.target) setDropTarget(null) }} onDrop={(event) => { event.preventDefault(); const id = event.dataTransfer.getData('text/task-id'); if (id) void move(id, column.key); setDropTarget(null) }}>
        <div className="board-col-head"><span className={`dot board-col-dot board-col-dot-${column.key}`} /><column.icon size={14} aria-hidden="true" /><span className="board-col-title">{column.label}</span><span className="board-col-count">{items.length + orphans.length}</span></div>
        <div className="board-col-body">{loading && !issues.length ? <div className="board-loading-state" aria-live="polite"><LoaderCircle size={17} className="spin" /><span>正在加载</span></div> : <>{items.map(renderCard)}{orphans.length > 0 && <section className="board-orphans"><h3 className="board-orphans-head">（无领队）<span>{orphans.length}</span></h3>{orphans.map(renderCard)}</section>}{!items.length && !orphans.length && <EmptyState compact title={!dayHasCards ? (selectedDay == null ? BOARD_EMPTY_ALL_HINT : BOARD_EMPTY_DAY_HINT) : filtering ? '没有匹配的 Issue' : '空'} />}</>}</div>
        {draggingTask && dropTarget === column.key && <div className="board-drop-hint"><span>放置到</span><strong>{column.label}</strong></div>}
      </section>
    })}</div>
    {menu && menuIssue && <div className="board-context-menu" ref={menuRef} role="menu" style={{ left: menu.x, top: menu.y }} onClick={(event) => event.stopPropagation()}><button role="menuitem" onClick={() => { setMenu(null); onOpen(menu.id) }}>打开 Issue</button><div className="board-context-separator" />{COLUMNS.filter((column) => column.key !== menuIssue.status).map((column) => <button key={column.key} role="menuitem" onClick={() => void move(menu.id, column.key)}>移到「{column.label}」</button>)}</div>}
  </div>
}
