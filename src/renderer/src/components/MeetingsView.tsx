import { useEffect, useMemo, useState } from 'react'
import { MessagesSquare, Plus } from 'lucide-react'
import { bridge, type AgentInfo } from '../api'
import { toast } from '../ui/Toasts'
import { EmptyState } from '../ui/EmptyState'
import { IssuePicker } from '../ui/IssuePicker'
import { captains } from './meeting/captains'
import { MeetingCard, MEETING_STATUS_LABEL } from './meeting/MeetingCard'
import type { Issue } from '../../../shared/types'
import type { Meeting } from '../../../shared/meeting'

export const OPEN_MEETING_CREATE = 'agentdeck:open-meeting-create'

/** 命令面板跨视图唤起「发起会议」：视图未挂载时置 flag，挂载后消费 */
let createRequested = false
export function requestMeetingCreate() {
  createRequested = true
  window.dispatchEvent(new Event(OPEN_MEETING_CREATE))
}

const GROUPS: Array<{ key: string; label: string; match: (meeting: Meeting) => boolean }> = [
  { key: 'live', label: '进行中 / 等你处理', match: (m) => m.status === 'active' || m.status === 'waiting_user' },
  { key: 'draft', label: '草稿', match: (m) => m.status === 'draft' },
  { key: 'done', label: '已结束', match: (m) => m.status === 'concluded' || m.status === 'cancelled' || m.status === 'failed' }
]

/** 全局会议页：不进 Issue 也能发起/管控全部结构化会议；单卡管控复用 MeetingCard */
export function MeetingsView({ onOpenIssue }: { onOpenIssue: (taskId: string) => void }) {
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [issues, setIssues] = useState<Issue[]>([])
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [topic, setTopic] = useState('')
  const [issueId, setIssueId] = useState('')
  const [reporter, setReporter] = useState('')
  const [critic, setCritic] = useState('')
  const [designer, setDesigner] = useState('')
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)

  const refresh = () => bridge.meetings.list().then(setMeetings).catch(() => {})
  useEffect(() => {
    refresh()
    bridge.issues.list().then(setIssues).catch(() => {})
    bridge.agents.list().then((items) => {
      const eligible = captains(items)
      setAgents(eligible)
      setReporter((current) => current || eligible[0]?.id || '')
      setCritic((current) => current || eligible[1]?.id || eligible[0]?.id || '')
      setDesigner((current) => current || eligible[2]?.id || eligible[0]?.id || '')
    }).catch(() => {})
    return bridge.meetings.onUpdated((meeting) => {
      // start/resume 的 IPC 要等整场会议结束才返回；转入 active 即释放 busy（同 MeetingPanel）
      if (meeting.status === 'active') setBusy(false)
      refresh()
    })
  }, [])
  useEffect(() => {
    const open = () => { createRequested = false; setCreating(true) }
    if (createRequested) open()
    window.addEventListener(OPEN_MEETING_CREATE, open)
    return () => window.removeEventListener(OPEN_MEETING_CREATE, open)
  }, [])

  const run = async (action: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true)
    try {
      const result = await action()
      if (!result.ok) toast.error(result.error ?? '会议操作失败')
      await refresh()
    } finally {
      setBusy(false)
    }
  }
  /** 同 MeetingPanel.create 的流程：创建后自动 start */
  const create = async () => {
    if (!topic.trim() || !issueId || !reporter || !critic || !designer || new Set([reporter, critic, designer]).size < 3) {
      toast.error('请填写议题、选择 Issue 并指定三位不同队长')
      return
    }
    setBusy(true)
    try {
      const meeting = await bridge.meetings.create({ issueId, topic: topic.trim(), participants: [
        { agentId: reporter, role: 'reporter' }, { agentId: critic, role: 'critic' }, { agentId: designer, role: 'designer' }
      ] })
      setMeetings((items) => [meeting, ...items])
      setTopic('')
      setIssueId('')
      setCreating(false)
      await run(() => bridge.meetings.start(meeting.id))
    } catch (error) { toast.error(error instanceof Error ? error.message : '创建会议失败') }
  }

  const issueById = useMemo(() => new Map(issues.map((issue) => [issue.id, issue])), [issues])
  const grouped = GROUPS.map(({ key, label, match }) => ({ key, label, items: meetings.filter(match).sort((a, b) => b.updatedAt - a.updatedAt) }))

  return <div className="meetings-page page-surface">
    <header className="page-header-bar">
      <div className="page-title-row"><MessagesSquare size={16} className="page-icon" /><h1 className="page-title">会议</h1><span className="page-count">{meetings.length}</span><span className="page-desc">三队长结构化研讨：汇报、质疑、答辩，收敛为纪要与行动项。</span></div>
      <div className="detail-actions"><button className="btn primary" onClick={() => setCreating(true)}><Plus size={14} /> 发起会议</button></div>
    </header>
    {meetings.length === 0 ? <EmptyState icon={MessagesSquare} title="还没有会议" description="召集汇报、质疑、答辩三位队长，围绕一个 Issue 做结构化研讨；也可以在 Issue 详情侧栏发起。" action={<button className="btn primary" onClick={() => setCreating(true)}><Plus size={14} /> 发起第一场会议</button>} /> : (
      <div className="meetings-list">
        {grouped.map((group) => group.items.length === 0 ? null : <section className="meetings-group" key={group.key}>
          <div className="meetings-group-head"><strong>{group.label}</strong><span>{group.items.length}</span></div>
          {group.items.map((meeting) => {
            const issue = issueById.get(meeting.issueId)
            return <article className={`meeting-card status-${meeting.status}`} key={meeting.id}>
              <div className="meeting-card-head">
                <strong className="meeting-card-topic" title={meeting.topic}>{meeting.topic}</strong>
                <span className={`badge meeting-status-chip status-${meeting.status}`}>{MEETING_STATUS_LABEL[meeting.status]}</span>
                {issue && issue.taskId && <button className="mini link meeting-issue-link" title={`打开 ${issue.title}`} onClick={() => onOpenIssue(issue.taskId)}>{issue.identifier}</button>}
              </div>
              <MeetingCard meeting={meeting} agents={agents} run={run} />
            </article>
          })}
        </section>)}
      </div>
    )}
    {creating && <div className="overlay" onClick={(e) => e.target === e.currentTarget && setCreating(false)}>
      <div className="dialog">
        <h2>发起会议</h2>
        <p className="hint">选一个 Issue 作为议题背景，指定汇报 / 质疑 / 答辩三位队长（不可重复），创建后自动开始。</p>
        <label className="field"><span>会议议题 *</span><input value={topic} autoFocus placeholder="如：审查搜索排序方案的技术选型" onChange={(event) => setTopic(event.target.value)} /></label>
        <div className="field"><span>所属 Issue *</span><IssuePicker value={issueId} onChange={setIssueId} placeholder="选择要研讨的 Issue…" /></div>
        <div className="field"><span>三队长（汇报 / 质疑 / 答辩，不得重复）</span><div className="meeting-selects meeting-dialog-selects">
          <label>汇报<select value={reporter} onChange={(event) => setReporter(event.target.value)}>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
          <label>质疑<select value={critic} onChange={(event) => setCritic(event.target.value)}>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
          <label>答辩<select value={designer} onChange={(event) => setDesigner(event.target.value)}>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
        </div></div>
        <div className="dialog-footer">
          <span className="hint">{agents.length < 3 ? '可用队长不足三位——先在 Agent 管理里配置（角色名匹配队长或带队员）' : '三位队长将按轮次「汇报 → 质疑 → 答辩」收敛结论'}</span>
          <button className="btn primary" disabled={busy || agents.length < 3} onClick={() => void create()}>开始会议</button>
        </div>
      </div>
    </div>}
  </div>
}
