import { useEffect, useMemo, useState } from 'react'
import { Bell, CheckCheck, Inbox as InboxIcon } from 'lucide-react'
import { bridge, fmtTime } from '../api'
import { ISSUE_STATUS_LABELS, NOTIFICATION_KIND_LABELS } from '../labels'
import type { Issue, IssueStatus, Notification } from '../../../shared/types'

type KindFilter = 'all' | Notification['kind']

export function InboxView({ onOpenIssue }: { onOpenIssue: (issue: Issue) => void }) {
  const [items, setItems] = useState<Notification[]>([])
  const [issues, setIssues] = useState<Issue[]>([])
  const [readFilter, setReadFilter] = useState<'all' | 'unread'>('all')
  const [statusFilter, setStatusFilter] = useState<IssueStatus | 'all'>('all')
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const refresh = async () => {
    const [nextItems, nextIssues] = await Promise.all([bridge.issues.notifications(readFilter === 'unread'), bridge.issues.list()])
    setItems(nextItems); setIssues(nextIssues)
  }
  useEffect(() => { void refresh(); const off = bridge.issues.onUpdated(() => void refresh()); return off }, [readFilter])
  const issueById = useMemo(() => new Map(issues.map((issue) => [issue.id, issue])), [issues])
  const visible = useMemo(() => items.filter((item) => {
    const issue = issueById.get(item.issueId)
    return !!issue && (statusFilter === 'all' || issue.status === statusFilter) && (kindFilter === 'all' || item.kind === kindFilter)
  }), [items, issueById, statusFilter, kindFilter])
  const markRead = async (item: Notification) => { if (!item.read) await bridge.issues.markNotificationRead(item.id); await refresh() }
  const markVisibleRead = async () => { await Promise.all(visible.filter((item) => !item.read).map((item) => bridge.issues.markNotificationRead(item.id))); await refresh() }
  const unreadCount = visible.filter((item) => !item.read).length
  return <div className="settings inbox-page">
    <header className="page-header-bar"><div className="page-title-row"><InboxIcon size={16} className="page-icon" /><h2 className="page-title">收件箱</h2><span className="page-count">{unreadCount}</span><span className="page-desc">需要你关注的汇报与动态。</span></div><div className="detail-actions"><button className={`btn ${readFilter === 'unread' ? 'primary' : ''}`} onClick={() => setReadFilter(readFilter === 'all' ? 'unread' : 'all')}>{readFilter === 'all' ? '只看未读' : '显示全部'}</button><button className="btn" disabled={!unreadCount} onClick={() => void markVisibleRead()}><CheckCheck size={14} /> 全部标为已读</button></div></header>
    <div className="inbox-filters"><label>Issue 状态<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as IssueStatus | 'all')}><option value="all">全部状态</option>{Object.entries(ISSUE_STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>来源<select value={kindFilter} onChange={(event) => setKindFilter(event.target.value as KindFilter)}><option value="all">全部来源</option>{Object.entries(NOTIFICATION_KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><span className="inbox-filter-count">{visible.length} 条通知</span></div>
    <div className="inbox-list">
      {visible.length === 0 && <div className="empty inbox-empty"><Bell size={34} /><strong>没有待处理通知</strong><span>当前筛选下没有新动态。</span></div>}
      {visible.map((item) => { const issue = issueById.get(item.issueId); if (!issue) return null; return <button key={item.id} className={`inbox-item ${item.read ? '' : 'unread'}`} onClick={() => { void markRead(item); onOpenIssue(issue) }}><span className="inbox-marker" aria-hidden="true" /><span className="inbox-copy"><strong>{issue.identifier} · {issue.title}</strong><span>{NOTIFICATION_KIND_LABELS[item.kind]} · {ISSUE_STATUS_LABELS[issue.status]}</span></span><time>{fmtTime(item.createdAt)}</time></button> })}
    </div>
  </div>
}
