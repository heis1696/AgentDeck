import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Task } from '../../../shared/types'
import { useIssues } from '../api'

/**
 * Issue 主页：新建表单（WorkspaceView）即主体；
 * 上方一条紧凑横条汇总已打开的 Issue——流式胶囊（状态点+标题截断+×），
 * 单行横向滚动，点胶囊进详情，× 只关标签页不删任务。
 */
export function IssuesView({ tasks, tabs, onOpen, onClose, children }: {
  tasks: Task[]
  tabs: string[]
  onOpen: (taskId: string) => void
  onClose: (taskId: string) => void
  children: ReactNode
}) {
  const { issues } = useIssues()
  const opened = tabs.flatMap((id) => {
    const task = tasks.find((item) => item.id === id)
    if (!task) return []
    const issue = issues.find((item) => item.taskId === id || item.id === task.issueId)
    return [{ id: task.id, status: task.status, title: issue?.title ?? task.title }]
  })
  return <div className="issues-page page-surface issue-home">
    {opened.length > 0 && <div className="issue-open-strip">
      <span className="issue-open-label">已打开</span>
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
    <div className="issue-home-body">{children}</div>
  </div>
}
