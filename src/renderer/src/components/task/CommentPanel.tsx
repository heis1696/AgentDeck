import { MessageSquare, Send } from 'lucide-react'
import { Markdown } from '../Markdown'
import { fmtDuration, fmtTime, fmtTokens } from '../../api'
import type { Comment, Run, Task } from '../../../../shared/types'

export function ActivityTimeline({ task, issueIdentifier, runs, comments, onShowLog }: { task: Task; issueIdentifier?: string; runs: Run[]; comments: Comment[]; onShowLog: () => void }) {
  const items = [...runs.map((run) => ({ kind: 'run' as const, at: run.startedAt ?? 0, run })), ...comments.map((comment) => ({ kind: 'comment' as const, at: comment.createdAt, comment }))].sort((a, b) => a.at - b.at)
  return (
    <div className="issue-timeline">
      <div className="timeline-intro"><span className="badge">{issueIdentifier ?? 'Issue'}</span><strong>工作动态</strong><span className="mini">评论、状态变化与执行报告</span></div>
      {items.length === 0 && <div className="list-empty">暂无动态。执行开始后，Run 和 Agent 汇报会出现在这里。</div>}
      {items.map((item) => item.kind === 'run' ? (
        <article className="timeline-item timeline-run" key={`run-${item.run.id}`}>
          <span className={`timeline-marker dot-${item.run.status === 'completed' ? 'done' : item.run.status === 'running' ? 'running' : item.run.status === 'error' ? 'failed' : 'cancelled'}`} />
          <div className="timeline-content"><div className="timeline-head"><strong>{item.run.status === 'completed' ? 'Run 完成' : item.run.status === 'running' ? 'Run 执行中' : item.run.status === 'error' ? 'Run 失败' : 'Run 已取消'}</strong>{item.run.trigger === 'handoff' && <span className="badge badge-handoff">⇥ 接力</span>}<time>{item.run.startedAt ? fmtTime(item.run.startedAt) : '刚刚'}</time></div><p>{item.run.trigger === 'mention' ? '由 Issue 评论提及触发' : item.run.trigger === 'autopilot' ? '由自动化计划触发' : item.run.trigger === 'handoff' ? '由上一阶段接力触发（同 Issue 新会话硬切）' : '由指派触发'}{item.run.durationMs ? ` · ${fmtDuration(item.run.durationMs)}` : ''}{item.run.usage ? ` · ${fmtTokens(item.run.usage.totalTokens)} tokens` : ''}</p>{item.run.taskId === task.id && <button className="link timeline-action" onClick={onShowLog}>查看执行记录</button>}</div>
        </article>
      ) : (
        <article className={`timeline-item timeline-comment ${item.comment.author.type}`} key={`comment-${item.comment.id}`}><span className="timeline-marker timeline-avatar">{item.comment.author.type === 'agent' ? 'A' : '我'}</span><div className="timeline-content"><div className="timeline-head"><strong>{item.comment.author.type === 'agent' ? `Agent · ${item.comment.author.id}` : '我'}</strong><time>{fmtTime(item.comment.createdAt)}</time></div><Markdown text={item.comment.content} /></div></article>
      ))}
    </div>
  )
}

export function CommentPanel({ comments, draft, onDraftChange, onSubmit }: { comments: Comment[]; draft: string; onDraftChange: (value: string) => void; onSubmit: () => void }) {
  return (
    <>
      <hr className="prop-sep" />
      <div className="prop-group-label"><MessageSquare size={13} /> 讨论 {comments.length ? `(${comments.length})` : ''}</div>
      <div className="issue-comments">
        {comments.length === 0 && <span className="mini dim">暂无评论</span>}
        {comments.slice(-4).map((comment) => <div className={`issue-comment ${comment.author.type}`} key={comment.id}><b>{comment.author.type === 'agent' ? comment.author.id : '我'}</b><span>{comment.content}</span></div>)}
      </div>
      <div className="comment-compose"><input value={draft} onChange={(event) => onDraftChange(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); onSubmit() } }} placeholder="写评论…" /><button className="icon-btn" title="发送评论" disabled={!draft.trim()} onClick={onSubmit}><Send size={13} /></button></div>
    </>
  )
}
