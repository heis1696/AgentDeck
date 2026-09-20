import { useState } from 'react'
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

/**
 * 工作动态时间线（动态 Tab）：单行化——图标 + 一句话 + 时间。
 * Run 条目一行汇总触发方式/耗时/tokens；agent 评论（含接力停放通知）保留渲染，
 * 默认单行截断，点击展开全文。用户评论入口已下线，仅 agent 评论可见。
 */
export function ActivityTimeline({ task, issueIdentifier, runs, comments, onShowLog }: { task: Task; issueIdentifier?: string; runs: Run[]; comments: Comment[]; onShowLog: () => void }) {
  const agentComments = comments.filter((comment) => comment.author.type === 'agent')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const items = [
    ...runs.map((run) => ({ kind: 'run' as const, at: run.startedAt ?? 0, run })),
    ...agentComments.map((comment) => ({ kind: 'comment' as const, at: comment.createdAt, comment }))
  ].sort((a, b) => a.at - b.at)
  return (
    <div className="issue-timeline">
      <div className="timeline-intro"><span className="badge">{issueIdentifier ?? 'Issue'}</span><strong>工作动态</strong><span className="mini">执行报告与 Agent 通知</span></div>
      {items.length === 0 && <div className="list-empty">暂无动态。执行开始后，Run 和 Agent 汇报会出现在这里。</div>}
      {items.map((item) => item.kind === 'run' ? (
        <article className="timeline-item timeline-run" key={`run-${item.run.id}`}>
          <span className={`timeline-marker dot-${item.run.status === 'completed' ? 'done' : item.run.status === 'running' ? 'running' : item.run.status === 'error' ? 'failed' : 'cancelled'}`} />
          <div className="timeline-content timeline-line">
            <strong>{item.run.status === 'completed' ? 'Run 完成' : item.run.status === 'running' ? 'Run 执行中' : item.run.status === 'error' ? 'Run 失败' : 'Run 已取消'}</strong>
            {item.run.trigger === 'handoff' && <span className="badge badge-handoff">⇥ 接力</span>}
            <span className="timeline-sentence">{RUN_TRIGGER_TEXT[item.run.trigger]}{item.run.durationMs ? ` · ${fmtDuration(item.run.durationMs)}` : ''}{item.run.usage ? ` · ${fmtTokens(item.run.usage.totalTokens)} tokens` : ''}</span>
            {item.run.taskId === task.id && <button className="link timeline-action" onClick={onShowLog}>查看执行记录</button>}
            <time>{item.run.startedAt ? fmtTime(item.run.startedAt) : '刚刚'}</time>
          </div>
        </article>
      ) : (
        <article className={`timeline-item timeline-comment ${item.comment.author.type}`} key={`comment-${item.comment.id}`}>
          <span className="timeline-marker timeline-avatar">A</span>
          <div className="timeline-content timeline-line timeline-comment-line" role="button" tabIndex={0} title={expandedId === item.comment.id ? '收起' : '展开全文'} onClick={() => setExpandedId((current) => (current === item.comment.id ? null : item.comment.id))} onKeyDown={(event) => { if (isComposingKey(event.nativeEvent)) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setExpandedId((current) => (current === item.comment.id ? null : item.comment.id)) } }}>
            <strong>Agent · {item.comment.author.id}</strong>
            <span className={`timeline-sentence ${expandedId === item.comment.id ? 'is-expanded' : ''}`}>{item.comment.content}</span>
            <time>{fmtTime(item.comment.createdAt)}</time>
          </div>
          {expandedId === item.comment.id && <div className="timeline-comment-full"><Markdown text={item.comment.content} /></div>}
        </article>
      ))}
    </div>
  )
}
