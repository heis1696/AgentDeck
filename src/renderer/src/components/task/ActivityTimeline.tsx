import { Fragment, useState } from 'react'
import { ChevronDown, ChevronRight, ScrollText } from 'lucide-react'
import { Markdown } from '../Markdown'
import { fmtDuration, fmtTime, fmtTokens } from '../../api'
import { isComposingKey } from '../../ui/interaction-center'
import type { Comment, Run, Task } from '../../../../shared/types'

const RUN_TRIGGER_TEXT: Record<Run['trigger'], string> = {
  assignment: '由指派触发',
  mention: '由 Issue 评论提及触发',
  autopilot: '由自动化计划触发',
  manual: '手动触发',
  handoff: '由上一阶段接力触发（同 Issue 新会话硬切）',
  meeting: '由团队会议结论触发'
}
const RUN_STATE: Record<Run['status'], { label: string; dot: string }> = {
  completed: { label: 'Run 完成', dot: 'done' },
  running: { label: 'Run 执行中', dot: 'running' },
  error: { label: 'Run 失败', dot: 'failed' },
  cancelled: { label: 'Run 已取消', dot: 'cancelled' }
}

/** 天分组：今天 / 昨天 / M 月 D 日（跨天长会话里给动态分节拍） */
function dayKey(at: number): string {
  if (at <= 0) return '时间未知'
  const date = new Date(at)
  const today = new Date()
  const start = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  const days = Math.round((start(today) - start(date)) / 86_400_000)
  if (days === 0) return '今天'
  if (days === 1) return '昨天'
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`
}

/**
 * 工作动态时间线（动态 Tab）：单行化——图标 + 一句话 + 时间。
 * Run 条目一行汇总触发方式/耗时/tokens；agent 评论（含接力停放通知）保留渲染，
 * 默认单行截断，点击展开全文。用户评论入口已下线，仅 agent 评论可见。
 * 本轮升级：按天分节、状态图标化、展开态箭头与 aria-expanded、窄窗自动换行。
 */
export function ActivityTimeline({ task, issueIdentifier, runs, comments, onShowLog }: { task: Task; issueIdentifier?: string; runs: Run[]; comments: Comment[]; onShowLog: () => void }) {
  const agentComments = comments.filter((comment) => comment.author.type === 'agent')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const items = [
    ...runs.map((run) => ({ kind: 'run' as const, at: run.startedAt ?? 0, run })),
    ...agentComments.map((comment) => ({ kind: 'comment' as const, at: comment.createdAt, comment }))
  ].sort((a, b) => a.at - b.at)
  const toggle = (id: string) => setExpandedId((current) => (current === id ? null : id))
  const runningRuns = runs.filter((run) => run.status === 'running').length

  return (
    <div className="issue-timeline">
      <div className="timeline-intro">
        <span className="badge">{issueIdentifier ?? 'Issue'}</span>
        <strong>工作动态</strong>
        <span className="mini">{runs.length} 次 Run · {agentComments.length} 条通知{runningRuns > 0 ? ` · ${runningRuns} 进行中` : ''}</span>
      </div>
      {items.length === 0 && <div className="list-empty">暂无动态。执行开始后，Run 和 Agent 汇报会出现在这里。</div>}
      {items.map((item, index) => {
        const day = dayKey(item.at)
        const showDay = index === 0 || dayKey(items[index - 1].at) !== day
        return <Fragment key={item.kind === 'run' ? `run-${item.run.id}` : `comment-${item.comment.id}`}>
          {showDay && <div className="timeline-day" role="separator">{day}</div>}
          {item.kind === 'run' ? (
            <article className="timeline-item timeline-run">
              <span className={`timeline-marker dot-${RUN_STATE[item.run.status].dot}`} aria-hidden="true" />
              <div className="timeline-content timeline-line">
                <strong>{RUN_STATE[item.run.status].label}</strong>
                {item.run.trigger === 'handoff' && <span className="badge badge-handoff">⇥ 接力</span>}
                <span className="timeline-sentence">{RUN_TRIGGER_TEXT[item.run.trigger]}{item.run.durationMs ? ` · ${fmtDuration(item.run.durationMs)}` : ''}{item.run.usage ? ` · ${fmtTokens(item.run.usage.totalTokens)} tokens` : ''}</span>
                {item.run.taskId === task.id && <button className="link timeline-action" onClick={onShowLog}><ScrollText size={11} aria-hidden="true" /> 查看执行记录</button>}
                <time dateTime={item.at ? new Date(item.at).toISOString() : undefined}>{item.run.startedAt ? fmtTime(item.run.startedAt) : '时间未知'}</time>
              </div>
            </article>
          ) : (
            <article className={`timeline-item timeline-comment ${item.comment.author.type}`}>
              <span className="timeline-marker timeline-avatar" aria-hidden="true">A</span>
              <div
                className="timeline-content timeline-line timeline-comment-line"
                role="button"
                tabIndex={0}
                aria-expanded={expandedId === item.comment.id}
                title={expandedId === item.comment.id ? '收起' : '展开全文'}
                onClick={() => toggle(item.comment.id)}
                onKeyDown={(event) => { if (isComposingKey(event.nativeEvent)) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(item.comment.id) } }}
              >
                <span className="timeline-caret" aria-hidden="true">{expandedId === item.comment.id ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
                <strong>Agent · {item.comment.author.id}</strong>
                <span className={`timeline-sentence ${expandedId === item.comment.id ? 'is-expanded' : ''}`}>{item.comment.content}</span>
                <time dateTime={item.at ? new Date(item.at).toISOString() : undefined}>{fmtTime(item.comment.createdAt)}</time>
              </div>
              {expandedId === item.comment.id && <div className="timeline-comment-full"><Markdown text={item.comment.content} /></div>}
            </article>
          )}
        </Fragment>
      })}
    </div>
  )
}
