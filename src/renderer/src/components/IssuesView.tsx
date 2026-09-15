import { useMemo, useState } from 'react'
import { CheckCircle2, CircleAlert, CircleDot, Clock3, Eye, ListTodo, Plus, Search } from 'lucide-react'
import type { Issue, IssueStatus, Task } from '../../../shared/types'
import { bridge, useIssues } from '../api'
import { ISSUE_STATUS_LABELS, isParkedQueued, PARKED_QUEUED_LABEL } from '../labels'
import { taskService } from '../task-service'
import { EmptyState } from '../ui/EmptyState'
import { IssueIdChip } from '../ui/IssueIdChip'
import { toast } from '../ui/Toasts'

type Scope = 'all' | 'mine' | 'agents'

const STATUS_ORDER: Array<{ key: IssueStatus; icon: typeof Clock3 }> = [
  { key: 'backlog', icon: ListTodo },
  { key: 'todo', icon: Clock3 },
  { key: 'in_progress', icon: CircleDot },
  { key: 'in_review', icon: Eye },
  { key: 'done', icon: CheckCircle2 },
  { key: 'blocked', icon: CircleAlert },
  { key: 'cancelled', icon: CircleAlert }
]

const PRIORITY: Record<Issue['priority'], string> = { urgent: '紧急', high: '高', medium: '中', low: '低', none: '无优先级' }

/** 相对时间：列表行的轻量时间线索（刚刚/N 分钟前/…/9月5日） */
function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 45_000) return '刚刚'
  const minutes = Math.round(diff / 60_000)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days} 天前`
  const date = new Date(ts)
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

/** Issue-first home: the durable work queue, with Task only supplying live execution details. */
export function IssuesView({ tasks, onOpen, onCreate }: { tasks: Task[]; onOpen: (taskId: string) => void; onCreate: () => void }) {
  const { issues } = useIssues()
  const [scope, setScope] = useState<Scope>('all')
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<IssueStatus | 'all'>('all')
  const [starting, setStarting] = useState<string | null>(null)
  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks])
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return issues.filter((issue) => {
      const task = taskById.get(issue.taskId)
      if (!task) return false
      if (scope === 'agents' && issue.createdBy !== 'agent') return false
      if (scope === 'mine' && issue.createdBy === 'agent') return false
      if (status !== 'all' && issue.status !== status) return false
      return !q || `${issue.identifier} ${issue.title} ${issue.description} ${issue.labels.join(' ')}`.toLowerCase().includes(q)
    })
  }, [issues, taskById, query, status, scope])

  const move = async (issue: Issue, next: IssueStatus) => {
    const result = await bridge.issues.update(issue.id, { status: next })
    if (!result) toast.error('更新 Issue 失败')
  }
  /** parked 任务一键启动：tasks:start 已实现清 parked + 入队 */
  const start = async (taskId: string) => {
    setStarting(taskId)
    const result = await taskService.start(taskId)
    setStarting(null)
    if (!result.ok) toast.error(result.error ?? '启动失败')
  }

  return (
    <div className="issues-page page-surface">
      <header className="page-header-bar issues-header">
        <div className="page-title-row"><ListTodo size={17} className="page-icon" /><h1 className="page-title">Issue</h1><span className="page-count">{visible.length}</span><span className="page-desc">可追踪的工作单元，以及每次执行留下的报告。</span></div>
        <button className="btn primary" onClick={onCreate}><Plus size={14} /> 新建 Issue</button>
      </header>
      <div className="issues-toolbar">
        <div className="issues-scopes" role="tablist" aria-label="Issue 范围">
          {([['all', '全部'], ['mine', '我的'], ['agents', '智能体']] as const).map(([key, label]) => <button key={key} className={scope === key ? 'active' : ''} role="tab" aria-selected={scope === key} onClick={() => setScope(key)}>{label}</button>)}
        </div>
        <label className="issues-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Issue…" /></label>
        <select className="issues-status-select" value={status} onChange={(event) => setStatus(event.target.value as IssueStatus | 'all')} aria-label="按状态筛选">
          <option value="all">所有状态</option>
          {STATUS_ORDER.map(({ key }) => <option value={key} key={key}>{ISSUE_STATUS_LABELS[key]}</option>)}
        </select>
      </div>
      {visible.length === 0 ? <EmptyState title={query ? '没有匹配的 Issue' : '还没有 Issue'} description="创建一个 Issue，把目标交给智能体执行。" action={<button className="btn primary" onClick={onCreate}><Plus size={14} /> 创建第一个 Issue</button>} /> : (
        <div className="issue-list-view">{STATUS_ORDER.map(({ key, icon: Icon }) => {
          const items = visible.filter((issue) => issue.status === key)
          if (!items.length) return null
          return <section className="issue-list-group" key={key}><div className="issue-list-group-head"><Icon size={14} /><strong>{ISSUE_STATUS_LABELS[key]}</strong><span>{items.length}</span></div>{items.map((issue) => <IssueRow key={issue.id} issue={issue} task={taskById.get(issue.taskId)!} onOpen={onOpen} onMove={move} onStart={start} starting={starting === issue.taskId} />)}</section>
        })}</div>
      )}
    </div>
  )
}

function IssueRow({ issue, task, onOpen, onMove, onStart, starting }: { issue: Issue; task: Task; onOpen: (id: string) => void; onMove: (issue: Issue, status: IssueStatus) => void; onStart: (id: string) => void; starting: boolean }) {
  // 行内已有状态分组头作语境，行内不再重复状态文字；搬运控件 hover 才浮现
  const parked = isParkedQueued(task)
  return <article className={`issue-home-row${parked ? ' is-parked' : ''}`} role="button" tabIndex={0} onClick={() => onOpen(task.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(task.id) } }}>
    <span className={`dot dot-${task.status}`} />
    <span className="issue-home-id"><span className="issue-identifier">{issue.identifier}</span><IssueIdChip id={issue.id} /></span>
    <strong className="issue-home-title">{issue.title}</strong>
    {issue.createdBy === 'agent' && <span className="badge badge-delegate">⚡ 委派</span>}
    {task.trigger === 'handoff' && <span className="badge badge-handoff">⇥ 接力</span>}
    {parked && <span className="badge badge-parked" title="任务停放在队列外，等你手动启动">{PARKED_QUEUED_LABEL}</span>}
    {issue.priority !== 'none' && <span className={`badge priority-${issue.priority}`}>{PRIORITY[issue.priority]}</span>}
    <span className="badge badge-meta">{issue.labels[0] && issue.labels[0] !== '委派' ? issue.labels[0] : task.backend}</span>
    <span className="issue-row-time" title={new Date(issue.updatedAt).toLocaleString()}>{relativeTime(issue.updatedAt)}</span>
    {parked && <button className="btn issue-row-start" disabled={starting} title="清停放并加入执行队列" onClick={(event) => { event.stopPropagation(); onStart(task.id) }} onKeyDown={(event) => event.stopPropagation()}>▶ 启动</button>}
    <select className="issue-row-move" value={issue.status} aria-label="移动 Issue" onClick={(event) => event.stopPropagation()} onChange={(event) => void onMove(issue, event.target.value as IssueStatus)}>{STATUS_ORDER.map(({ key }) => <option value={key} key={key}>{ISSUE_STATUS_LABELS[key]}</option>)}</select>
  </article>
}
