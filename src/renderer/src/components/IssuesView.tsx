import { ArrowUpRight, ListTodo, X } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Task } from '../../../shared/types'
import { useIssues } from '../api'
import { isParkedQueued, PARKED_QUEUED_LABEL, TASK_STATUS_LABELS } from '../labels'
import { PageHeader } from '../ui/PageHeader'

/**
 * Issue 主页：共享页头（唯一主标题）+ 新建表单（WorkspaceView）即主体；
 * 页头下一条紧凑横条汇总已打开的 Issue——流式胶囊（状态点+标题截断+×），
 * 单行横向滚动，点胶囊进详情，× 只关标签页不删任务。
 */
export function IssuesView({ tasks, tabs, onOpen, onClose, onBrowseAll, children }: {
  tasks: Task[]
  tabs: readonly string[]
  onOpen: (taskId: string) => void
  onClose: (taskId: string) => void
  onBrowseAll: () => void
  children: ReactNode
}) {
  const { issues } = useIssues()
  const opened = tabs.flatMap((id) => {
    const task = tasks.find((item) => item.id === id)
    if (!task) return []
    const issue = issues.find((item) => item.taskId === id || item.id === task.issueId)
    return [{ id: task.id, status: task.status, title: issue?.title ?? task.title }]
  })
  const recentRoots = [...tasks]
    .filter((task) => !task.parentTaskId)
    .sort((a, b) => Math.max(b.createdAt, b.startedAt ?? 0, b.endedAt ?? 0) - Math.max(a.createdAt, a.startedAt ?? 0, a.endedAt ?? 0))
    .slice(0, 6)
  return <div className="issues-page page-surface issue-home">
    <PageHeader title="Issue" icon={<ListTodo size={16} />} count={opened.length} />
    {opened.length > 0 && <div className="issue-open-strip">
      <span className="issue-open-label">已打开 <strong>{opened.length}</strong></span>
      <div className="issue-open-track" role="list" aria-label="已打开的 Issue">
        {opened.map((item) => (
          <span className="issue-pill" role="listitem" key={item.id}>
            <button type="button" className="issue-pill-main" title={item.title} onClick={() => onOpen(item.id)}>
              <span className={`dot dot-${item.status}`} aria-hidden="true" />
              <span className="issue-pill-title">{item.title}</span>
            </button>
            <button type="button" className="issue-pill-close" title="关闭标签" onClick={() => onClose(item.id)}><X size={11} aria-hidden="true" /></button>
          </span>
        ))}
      </div>
    </div>}
    <div className="issue-home-body">
      {recentRoots.length > 0 && <section className="issue-recent" aria-label="最近任务">
        <div className="issue-recent-heading">
          <div><strong>最近任务</strong><span>最近访问的根任务</span></div>
          <button type="button" className="issue-recent-all" onClick={onBrowseAll}><span>查看全部任务</span><ArrowUpRight size={13} aria-hidden="true" /></button>
        </div>
        <div className="issue-recent-list" role="list">
          {recentRoots.map((task) => <div className="issue-recent-task" role="listitem" key={task.id}>
            <span className={`dot dot-${task.status}`} aria-hidden="true" />
            <span className="issue-recent-title" title={task.title}>{task.title}</span>
            <span className={`issue-recent-status issue-recent-status-${task.status}`}>{isParkedQueued(task) ? PARKED_QUEUED_LABEL : TASK_STATUS_LABELS[task.status]}</span>
            <button type="button" className="issue-recent-open" onClick={() => onOpen(task.id)}>打开</button>
          </div>)}
        </div>
      </section>}
      {children}
    </div>
  </div>
}
