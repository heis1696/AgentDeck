import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, CircleAlert, CircleDot, Clock3, Eye, ListTodo, Plus, Search, SlidersHorizontal } from 'lucide-react'
import type { Issue, IssueStatus, Task } from '../../../shared/types'
import { bridge, fmtDuration, fmtTime, useIssues } from '../api'
import { ISSUE_STATUS_LABELS, TASK_STATUS_LABELS } from '../labels'
import { EmptyState } from '../ui/EmptyState'
import { toast } from '../ui/Toasts'

type Scope = 'all' | 'mine' | 'agents'
type Layout = 'list' | 'board'

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

/** Issue-first home: the durable work queue, with Task only supplying live execution details. */
export function IssuesView({ tasks, onOpen, onCreate }: { tasks: Task[]; onOpen: (taskId: string) => void; onCreate: () => void }) {
  const { issues } = useIssues()
  const [scope, setScope] = useState<Scope>('all')
  const [layout, setLayout] = useState<Layout>('list')
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<IssueStatus | 'all'>('all')
  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks])
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return issues.filter((issue) => {
      const task = taskById.get(issue.taskId)
      if (!task) return false
      if (scope === 'agents' && !issue.assignee?.type.match(/agent/)) return false
      if (scope === 'mine' && issue.assignee?.type === 'agent') return false
      if (status !== 'all' && issue.status !== status) return false
      return !q || `${issue.identifier} ${issue.title} ${issue.description} ${issue.labels.join(' ')}`.toLowerCase().includes(q)
    })
  }, [issues, taskById, query, status, scope])

  const move = async (issue: Issue, next: IssueStatus) => {
    const result = await bridge.issues.update(issue.id, { status: next })
    if (!result) toast.error('更新 Issue 失败')
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
        <div className="issues-layout" role="group" aria-label="视图"><button className={layout === 'list' ? 'active' : ''} onClick={() => setLayout('list')} title="列表视图"><ListTodo size={14} /></button><button className={layout === 'board' ? 'active' : ''} onClick={() => setLayout('board')} title="看板视图"><SlidersHorizontal size={14} /></button></div>
      </div>
      {visible.length === 0 ? <EmptyState title={query ? '没有匹配的 Issue' : '还没有 Issue'} description="创建一个 Issue，把目标交给智能体执行。" action={<button className="btn primary" onClick={onCreate}><Plus size={14} /> 创建第一个 Issue</button>} /> : layout === 'board' ? (
        <div className="issue-board-grid">{STATUS_ORDER.map(({ key, icon: Icon }) => {
          const items = visible.filter((issue) => issue.status === key)
          return <section className={`issue-column status-${key}`} key={key}><div className="issue-column-head"><Icon size={14} /><strong>{ISSUE_STATUS_LABELS[key]}</strong><span>{items.length}</span></div><div className="issue-column-body">{items.map((issue) => <IssueCard key={issue.id} issue={issue} task={taskById.get(issue.taskId)!} onOpen={onOpen} onMove={move} />)}{items.length === 0 && <span className="issue-column-empty">暂无 Issue</span>}</div></section>
        })}</div>
      ) : (
        <div className="issue-list-view">{STATUS_ORDER.map(({ key, icon: Icon }) => {
          const items = visible.filter((issue) => issue.status === key)
          if (!items.length) return null
          return <section className="issue-list-group" key={key}><div className="issue-list-group-head"><Icon size={14} /><strong>{ISSUE_STATUS_LABELS[key]}</strong><span>{items.length}</span></div>{items.map((issue) => <IssueRow key={issue.id} issue={issue} task={taskById.get(issue.taskId)!} onOpen={onOpen} onMove={move} />)}</section>
        })}</div>
      )}
    </div>
  )
}

function IssueCard({ issue, task, onOpen, onMove }: { issue: Issue; task: Task; onOpen: (id: string) => void; onMove: (issue: Issue, status: IssueStatus) => void }) {
  return <article className="issue-home-card" role="button" tabIndex={0} onClick={() => onOpen(task.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(task.id) } }}><div className="issue-home-card-title"><span className="issue-identifier">{issue.identifier}</span>{issue.title}</div><p>{issue.description}</p><div className="issue-home-meta"><span className={`badge priority-${issue.priority}`}>{PRIORITY[issue.priority]}</span><span className="badge">{task.agentId ? '智能体' : task.backend}</span>{task.status === 'running' ? <span className="issue-live"><i /> 执行中</span> : task.endedAt ? <span className="mini">{fmtTime(task.endedAt)} · {task.startedAt ? fmtDuration(task.endedAt - task.startedAt) : TASK_STATUS_LABELS[task.status]}</span> : null}</div><div className="issue-card-actions"><select value={issue.status} aria-label="移动 Issue" onClick={(event) => event.stopPropagation()} onChange={(event) => void onMove(issue, event.target.value as IssueStatus)}>{STATUS_ORDER.map(({ key }) => <option value={key} key={key}>{ISSUE_STATUS_LABELS[key]}</option>)}</select></div></article>
}

function IssueRow({ issue, task, onOpen, onMove }: { issue: Issue; task: Task; onOpen: (id: string) => void; onMove: (issue: Issue, status: IssueStatus) => void }) {
  return <article className="issue-home-row" role="button" tabIndex={0} onClick={() => onOpen(task.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(task.id) } }}><span className={`dot dot-${task.status}`} /><span className="issue-identifier">{issue.identifier}</span><strong>{issue.title}</strong><span className={`badge priority-${issue.priority}`}>{PRIORITY[issue.priority]}</span><span className="badge">{issue.labels[0] || task.backend}</span><span className="issue-row-state">{task.status === 'running' ? '执行中' : ISSUE_STATUS_LABELS[issue.status]}</span><select value={issue.status} aria-label="移动 Issue" onClick={(event) => event.stopPropagation()} onChange={(event) => void onMove(issue, event.target.value as IssueStatus)}>{STATUS_ORDER.map(({ key }) => <option value={key} key={key}>{ISSUE_STATUS_LABELS[key]}</option>)}</select></article>
}
