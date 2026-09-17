import { ListTodo, Plus } from 'lucide-react'
import type { Task } from '../../../shared/types'
import { useIssues } from '../api'
import { ISSUE_STATUS_LABELS, TASK_STATUS_LABELS } from '../labels'
import { EmptyState } from '../ui/EmptyState'

export function IssuesView({ tasks, tabs, onOpen, onCreate }: { tasks: Task[]; tabs: string[]; onOpen: (taskId: string) => void; onCreate: () => void }) {
  const { issues } = useIssues()
  const opened = tabs.flatMap((id) => {
    const task = tasks.find((item) => item.id === id)
    return task ? [{ task, issue: issues.find((item) => item.taskId === id || item.id === task.issueId) }] : []
  })
  return <div className="issues-page page-surface">
    <header className="page-header-bar issues-header">
      <div className="page-title-row"><ListTodo size={17} className="page-icon" /><h1 className="page-title">Issue</h1><span className="page-count">{opened.length}</span><span className="page-desc">已打开的 Issue；全部工作在看板管理。</span></div>
      <button className="btn primary" onClick={onCreate}><Plus size={14} /> 新建 Issue</button>
    </header>
    {opened.length ? <div className="issue-open-grid">{opened.map(({ task, issue }) => <button className="issue-open-card" key={task.id} onClick={() => onOpen(task.id)}>
      <span className="issue-open-card-head"><span className={`dot dot-${task.status}`} /><span className="issue-identifier">{issue?.identifier ?? task.id}</span><span>{issue ? ISSUE_STATUS_LABELS[issue.status] : TASK_STATUS_LABELS[task.status]}</span></span>
      <strong>{issue?.title ?? task.title}</strong><span className="issue-open-backend">{task.backend}</span>
    </button>)}</div> : <EmptyState title="还没有打开的 Issue" description="从看板打开工作单，或新建一个 Issue。" />}
  </div>
}
