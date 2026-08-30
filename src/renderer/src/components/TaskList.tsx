import { useState } from 'react'
import type { Task } from '../../../shared/types'
import { fmtDuration, fmtTime } from '../api'

const STATUS_LABEL: Record<Task['status'], string> = {
  queued: '排队中',
  running: '执行中',
  done: '完成',
  failed: '失败',
  cancelled: '已取消'
}

function StatusDot({ status }: { status: Task['status'] }) {
  return <span className={`dot dot-${status}`} title={STATUS_LABEL[status]} />
}

export function TaskList({ tasks, selectedId, onSelect }: { tasks: Task[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'active' | 'history' | 'all'>('all')
  const q = query.trim().toLowerCase()
  const match = (t: Task) => !q || t.title.toLowerCase().includes(q) || t.prompt.toLowerCase().includes(q) || t.workdir.toLowerCase().includes(q)
  const active = tasks.filter((t) => (t.status === 'running' || t.status === 'queued') && match(t))
  const finished = tasks.filter((t) => t.status !== 'running' && t.status !== 'queued' && match(t))
  const shownActive = filter === 'history' ? [] : active
  const shownFinished = filter === 'active' ? [] : finished

  const item = (t: Task) => {
    const kids = tasks.filter((x) => x.parentTaskId === t.id)
    const kidsDone = kids.filter((k) => k.status === 'done').length
    return (
      <div
        key={t.id}
        className={`task-item ${t.id === selectedId ? 'selected' : ''} status-${t.status} ${t.parentTaskId ? 'is-worker' : ''}`}
        onClick={() => onSelect(t.id)}
      >
        <div className="task-item-row1">
          <StatusDot status={t.status} />
          <span className="task-item-title">{t.parentTaskId ? `└ ${t.title}` : t.title}</span>
        </div>
        <div className="task-item-row2">
          {kids.length > 0 && <span className="badge badge-squad">⚡ 委派 {kidsDone}/{kids.length}</span>}{' '}<span className="badge">{t.backend}</span>
          {t.status === 'running' && <span className="mini">执行中…</span>}
          {t.status === 'queued' && <span className="mini">排队</span>}
          {!!t.attempt && (t.status === 'running' || t.status === 'queued') && <span className="mini">⟳{t.attempt}/2</span>}
          {(t.status === 'done' || t.status === 'failed' || t.status === 'cancelled') && (
            <>
              <span className="mini">{fmtTime(t.endedAt)}</span>
              {t.startedAt && t.endedAt ? <span className="mini">{fmtDuration(t.endedAt - t.startedAt)}</span> : null}
            </>
          )}
          {t.workdir ? <span className="mini workdir" title={t.workdir}>{t.workdir.split(/[\\/]/).pop()}</span> : null}
        </div>
      </div>
    )
  }

  return (
    <div className="task-list">
      <div className="list-filter">
        <button className={filter === 'active' ? 'active' : ''} onClick={() => setFilter('active')}>
          进行中 {active.length || ''}
        </button>
        <button className={filter === 'history' ? 'active' : ''} onClick={() => setFilter('history')}>
          历史 {finished.length || ''}
        </button>
        <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
          全部
        </button>
      </div>
      <input
        className="list-search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="搜索任务…"
      />
      {shownActive.length > 0 && (
        <>
          <div className="list-group-label">进行中 / 排队</div>
          {shownActive.map(item)}
        </>
      )}
      <div className="list-group-label">历史</div>
      {shownFinished.length === 0 && <div className="list-empty">{q ? '无匹配任务' : '暂无历史任务'}</div>}
      {shownFinished.map(item)}
    </div>
  )
}
