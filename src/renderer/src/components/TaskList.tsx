import { useMemo, useState } from 'react'
import type { Task } from '../../../shared/types'
import { fmtDuration, fmtTime } from '../api'
import { EmptyState } from '../ui/EmptyState'
import { ChevronDown, Folder, Layers3, Plus, SlidersHorizontal } from 'lucide-react'

const STATUS_LABEL: Record<Task['status'], string> = {
  queued: '排队中', running: '执行中', done: '完成', failed: '失败', cancelled: '已取消'
}

function StatusDot({ status }: { status: Task['status'] }) {
  return <span className={`dot dot-${status}`} title={STATUS_LABEL[status]} />
}

function projectName(workdir: string) {
  const clean = workdir.trim().replace(/[\\/]+$/, '')
  return clean ? (clean.split(/[\\/]/).pop() || clean) : '未归属项目'
}

type TaskListProps = {
  tasks: Task[]
  selectedId: string | null
  onSelect: (id: string) => void
  onPickWorkspace?: () => void
}

export function TaskList({ tasks, selectedId, onSelect, onPickWorkspace }: TaskListProps) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'active' | 'all'>('all')
  const [view, setView] = useState<'groups' | 'projects'>('groups')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const q = query.trim().toLowerCase()

  const match = (t: Task) => !q || t.title.toLowerCase().includes(q) || t.prompt.toLowerCase().includes(q) || t.workdir.toLowerCase().includes(q)
  const active = tasks.filter((t) => (t.status === 'running' || t.status === 'queued') && match(t))
  const finished = tasks.filter((t) => t.status !== 'running' && t.status !== 'queued' && match(t))
  const shown = filter === 'active' ? active : [...active, ...finished]

  const projects = useMemo(() => {
    const map = new Map<string, { name: string; workdir: string; tasks: Task[] }>()
    for (const task of shown) {
      const workdir = task.workdir.trim()
      const key = workdir.toLowerCase() || '__none__'
      const current = map.get(key)
      if (current) current.tasks.push(task)
      else map.set(key, { name: projectName(workdir), workdir, tasks: [task] })
    }
    return [...map.entries()].sort(([a], [b]) => a === '__none__' ? 1 : b === '__none__' ? -1 : a.localeCompare(b)).map(([, value]) => value)
  }, [shown])

  const item = (t: Task) => {
    const kids = tasks.filter((x) => x.parentTaskId === t.id)
    const kidsDone = kids.filter((k) => k.status === 'done').length
    return (
      <div key={t.id} className={`task-item ${t.id === selectedId ? 'selected' : ''} status-${t.status} ${t.parentTaskId ? 'is-worker' : ''}`} onClick={() => onSelect(t.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(t.id) } }} role="button" tabIndex={0} aria-pressed={t.id === selectedId}>
        <div className="task-item-row1"><StatusDot status={t.status} /><span className="task-item-title">{t.parentTaskId ? `└ ${t.title}` : t.title}</span></div>
        <div className="task-item-row2">
          {kids.length > 0 && <span className="badge badge-squad">Squad {kidsDone}/{kids.length}</span>}
          <span className="badge">{t.backend}</span>
          {t.status === 'running' && <span className="mini">执行中…</span>}
          {t.status === 'queued' && <span className="mini">排队</span>}
          {!!t.attempt && (t.status === 'running' || t.status === 'queued') && <span className="mini">try {t.attempt}/2</span>}
          {(t.status === 'done' || t.status === 'failed' || t.status === 'cancelled') && <><span className="mini">{fmtTime(t.endedAt)}</span>{t.startedAt && t.endedAt ? <span className="mini">{fmtDuration(t.endedAt - t.startedAt)}</span> : null}</>}
          {view === 'groups' && t.workdir ? <span className="mini workdir" title={t.workdir}>{projectName(t.workdir)}</span> : null}
        </div>
      </div>
    )
  }

  const toggleProject = (key: string) => setCollapsed((current) => {
    const next = new Set(current)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })

  return (
    <div className="task-list">
      <div className="task-list-view-toggle" role="tablist" aria-label="任务组织方式">
        <button className={view === 'groups' ? 'active' : ''} role="tab" aria-selected={view === 'groups'} onClick={() => setView('groups')}><Layers3 size={13} aria-hidden="true" /> 分组</button>
        <button className={view === 'projects' ? 'active' : ''} role="tab" aria-selected={view === 'projects'} onClick={() => setView('projects')}><Folder size={13} aria-hidden="true" /> 项目</button>
        <button className="task-list-tool" type="button" title="筛选任务" aria-label="筛选任务"><SlidersHorizontal size={13} /></button>
      </div>
      <div className="list-filter"><button className={filter === 'active' ? 'active' : ''} onClick={() => setFilter('active')}>进行中 {active.length || ''}</button><button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>全部</button></div>
      <input className="list-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索任务…" />
      {shown.length === 0 ? <EmptyState compact title={q ? '无匹配任务' : filter === 'active' ? '暂无进行中任务' : '暂无历史任务'} /> : view === 'groups' ? <>{active.length > 0 && filter === 'all' && <div className="list-group-label">进行中 / 排队</div>}{active.map(item)}{filter === 'all' && finished.length > 0 && <div className="list-group-label">已完成</div>}{filter === 'all' && finished.map(item)}</> : (
        <div className="project-groups">
          {projects.map((project) => {
            const key = project.workdir.trim().toLowerCase() || '__none__'
            const isCollapsed = collapsed.has(key)
            const running = project.tasks.filter((t) => t.status === 'running').length
            return <section className="project-group" key={key}><button className="project-group-header" type="button" onClick={() => toggleProject(key)} aria-expanded={!isCollapsed}><ChevronDown size={14} className={isCollapsed ? 'collapsed' : ''} aria-hidden="true" /><Folder size={14} aria-hidden="true" /><span className="project-group-name" title={project.workdir || '未选择工作目录'}>{project.name}</span><span className="project-group-count">{project.tasks.length}{running > 0 ? ` · ${running} 执行中` : ''}</span></button>{!isCollapsed && <div className="project-group-items">{project.tasks.map(item)}</div>}</section>
          })}
          {onPickWorkspace && <button className="add-project-btn" type="button" onClick={onPickWorkspace}><Plus size={13} aria-hidden="true" /> 添加项目</button>}
        </div>
      )}
      {view === 'groups' && onPickWorkspace && <button className="add-project-btn" type="button" onClick={onPickWorkspace}><Plus size={13} aria-hidden="true" /> 添加项目</button>}
    </div>
  )
}
