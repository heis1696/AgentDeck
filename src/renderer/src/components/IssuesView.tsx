import { ArrowUpRight, ListTodo, X } from 'lucide-react'
import { useMemo, type ReactNode } from 'react'
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
  const recentRoots = useMemo(() => {
    const issueById = new Map(issues.map((issue) => [issue.id, issue]))
    const issueByTask = new Map(issues.map((issue) => [issue.taskId, issue]))
    const latest = new Map<string, Task>()
    const executionAt = (task: Task) => task.endedAt ?? task.startedAt ?? task.createdAt
    for (const task of tasks) {
      if (task.parentTaskId) continue
      const issue = issueByTask.get(task.id) ?? (task.issueId ? issueById.get(task.issueId) : undefined)
      const key = task.issueId ?? issue?.id ?? `task:${task.id}`
      const current = latest.get(key)
      if (!current || executionAt(task) > executionAt(current) || (executionAt(task) === executionAt(current) && task.createdAt > current.createdAt)) {
        latest.set(key, task)
      }
    }
    return [...latest.entries()]
      .sort(([, a], [, b]) => executionAt(b) - executionAt(a))
      .slice(0, 6)
      .map(([key, task]) => ({ task, title: issueById.get(key)?.title ?? issueByTask.get(task.id)?.title ?? task.title }))
  }, [issues, tasks])
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
      {children}
      {recentRoots.length > 0 && <section className="issue-recent" aria-label="按最近执行时间的任务">
        <div className="issue-recent-heading">
          <div><strong>最近任务</strong><span>按最近执行时间 · 每个 Issue 一行</span></div>
          <button type="button" className="issue-recent-all" onClick={onBrowseAll}><span>查看全部任务</span><ArrowUpRight size={13} aria-hidden="true" /></button>
        </div>
        <div className="issue-recent-list" role="list">
          {recentRoots.map(({ task, title }) => <div className="issue-recent-task" role="listitem" key={task.issueId ?? task.id}>
            <span className={`dot dot-${task.status}`} aria-hidden="true" />
            <span className="issue-recent-title" title={title}>{title}</span>
            <span className={`issue-recent-status issue-recent-status-${task.status}`}>{isParkedQueued(task) ? PARKED_QUEUED_LABEL : TASK_STATUS_LABELS[task.status]}</span>
            <button type="button" className="issue-recent-open" onClick={() => onOpen(task.id)}>打开</button>
          </div>)}
        </div>
      </section>}
    </div>
  </div>
}
