import { useEffect, useRef, useState } from 'react'
import { FolderOpen, Pencil, Waypoints } from 'lucide-react'
import { bridge, fmtDuration, fmtTokens } from '../api'
import { taskService } from '../task-service'
import { Markdown } from './Markdown'
import { confirmDialog } from '../ui/Confirm'
import { toast } from '../ui/Toasts'
import { useTaskEvents } from '../hooks/useTaskEvents'
import { useTurnModel } from '../hooks/turnModel'
import { useIssueDetails } from '../hooks/useIssueDetails'
import { PermissionPrompt } from './task/PermissionPrompt'
import { TurnTimeline } from './task/TurnTimeline'
import { ActivityTimeline, CommentPanel } from './task/CommentPanel'
import { RunHistory } from './task/RunHistory'
import { GitSummary } from './task/GitSummary'
import { GoalPanel } from './goal/GoalPanel'
import type { IssuePriority, IssueStatus, Task } from '../../../shared/types'

type Tab = 'activity' | 'log' | 'result' | 'git'
const STATUS_META: Record<Task['status'], string> = { queued: '排队中', running: '执行中', done: '完成', failed: '失败', cancelled: '已取消' }

export function TaskDetail({ task, tasks, onSelect }: { task: Task; tasks: Task[]; onSelect: (id: string) => void }) {
  const [tab, setTab] = useState<Tab>('activity')
  const [followUp, setFollowUp] = useState('')
  const [busy, setBusy] = useState(false)
  const [, setClock] = useState(0)
  const [commentDraft, setCommentDraft] = useState('')
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [activeNav, setActiveNav] = useState(-1)
  const logRef = useRef<HTMLDivElement>(null)
  const followRef = useRef<HTMLTextAreaElement>(null)
  const editingTitleRef = useRef(false)
  const navFrameRef = useRef(0)
  const { events, permission, refreshEvents, answerPermission } = useTaskEvents(task.id)
  const turns = useTurnModel(events, task.prompt)
  const issueId = task.issueId ?? `iss_${task.id}`
  const { issue, comments, runs, labelsDraft, setLabelsDraft, addComment, updateIssue, updateWorkflow } = useIssueDetails(issueId, `${task.status}:${task.result ?? ''}:${task.eventCount}`)
  const workers = tasks.filter((item) => item.parentTaskId === task.id).sort((a, b) => (a.workerIndex ?? 0) - (b.workerIndex ?? 0))
  const activeWorkers = workers.filter((item) => item.status === 'running' || item.status === 'queued')
  const parent = task.parentTaskId ? tasks.find((item) => item.id === task.parentTaskId) : null
  const relayPred = task.continuesFrom ? tasks.find((item) => item.id === task.continuesFrom) : null
  const relaySucc = tasks.find((item) => item.continuesFrom === task.id)
  const relayStage = relayNumber(task, tasks)
  const isRelay = task.trigger === 'handoff' || !!relayPred || !!relaySucc
  const turnActive = task.status === 'running'

  useEffect(() => {
    if (!turnActive) return
    const timer = window.setInterval(() => setClock((value) => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [task.id, turnActive])

  const scrollEl = () => {
    const element = logRef.current
    if (!element) return null
    return element.scrollHeight > element.clientHeight + 1 ? element : element.closest<HTMLElement>('.detail-main') ?? element
  }
  const updateActiveNav = () => {
    const element = scrollEl()
    if (!element) return
    const nodes = element.querySelectorAll<HTMLElement>('.turn')
    if (!nodes.length) { setActiveNav(0); return }
    // 滚到底（含新消息后自动跟随最新内容）时，当前回合就是最新回合——
    // 否则短的新回合在视口下半部永远够不着顶部门线，高亮会卡在上一条
    if (element.scrollHeight - element.scrollTop - element.clientHeight < 40) {
      setActiveNav(nodes.length - 1)
      return
    }
    const top = element.getBoundingClientRect().top
    let active = 0
    nodes.forEach((node, index) => { if (node.getBoundingClientRect().top - top <= 80) active = index })
    setActiveNav(active)
  }
  const onLogScroll = () => {
    if (navFrameRef.current) return
    navFrameRef.current = requestAnimationFrame(() => { navFrameRef.current = 0; updateActiveNav() })
  }
  useEffect(() => {
    if (tab !== 'log') return
    const element = scrollEl()
    if (element) element.scrollTop = element.scrollHeight
    updateActiveNav()
  }, [events, tab, turns.length])
  const scrollToTurn = (index: number) => {
    const element = scrollEl()
    const target = element?.querySelector<HTMLElement>(`#turn-${index}`)
    if (!element || !target) return
    const delta = target.getBoundingClientRect().top - element.getBoundingClientRect().top
    element.scrollTo({ top: Math.max(0, element.scrollTop + delta - 8), behavior: 'smooth' })
    setActiveNav(index)
  }

  const doRewind = async (index: number) => {
    const turn = turns[index]
    if (!turn || index === 0) return
    const ok = await confirmDialog({ title: '回退到这里？', body: `将删除第 ${index + 1} 回合及其之后的所有消息记录，并按剩余内容重算任务结果与用量。该操作只影响本地日志，不会改动后端会话上下文，且不可撤销。`, danger: true, confirmText: '回退' })
    if (!ok) return
    const result = await taskService.rewind(task.id, turn.firstSeq - 1)
    if (!result.ok) toast.error(result.error ?? '回退失败')
    else { toast.success('已回退'); void refreshEvents() }
  }
  const doAction = async (action: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true)
    const result = await action()
    if (!result.ok && result.error) toast.error(result.error)
    setBusy(false)
  }
  const doCancel = () => doAction(() => taskService.cancel(task.id))
  const doRetry = () => doAction(() => taskService.retry(task.id))
  const doStart = () => doAction(() => taskService.start(task.id))
  const doDelete = async () => {
    if (!(await confirmDialog({ title: '删除该任务及其日志？', body: task.title, danger: true, confirmText: '删除' }))) return
    const result = await taskService.delete(task.id)
    if (!result.ok) toast.error(result.error ?? '删除失败')
  }
  const doDuplicate = async () => {
    const copy = await taskService.duplicate(task)
    if (copy) onSelect(copy.id)
  }
  const beginTitleEdit = () => { setTitleDraft(task.title); editingTitleRef.current = true; setEditingTitle(true) }
  const cancelTitleEdit = () => { editingTitleRef.current = false; setEditingTitle(false) }
  const saveTitle = async () => {
    if (!editingTitleRef.current) return
    editingTitleRef.current = false
    setEditingTitle(false)
    const title = titleDraft.trim()
    if (!title || title === task.title) return
    const next = await taskService.rename(task.id, title)
    if (next) toast.success('标题已更新')
  }
  const sendFollowUp = async (preset?: string, opts?: { relay?: boolean }) => {
    const content = (preset ?? followUp).trim()
    if (!content || busy) return
    setBusy(true); setFollowUp('')
    if (followRef.current) followRef.current.style.height = 'auto'
    const result = await taskService.followUp(task.id, content, opts)
    if (!result.ok) toast.error(result.error ?? '续聊失败')
    setBusy(false)
  }
  const copyResult = async () => {
    const parts = [`# ${task.title}`, '', task.result ?? '']
    if (task.gitStat) parts.push('', '## 改动', '```', task.gitStat, '```')
    if (task.integration?.branch) parts.push('', `集成分支：\`${task.integration.branch}\``)
    await navigator.clipboard.writeText(parts.join('\n')); toast.success('结果已复制为 Markdown')
  }
  const copyPrBody = async () => {
    const branch = task.integration?.branch
    const files = (task.gitStat || '').split('\n').filter((line) => line.includes('|')).length
    const body = ['## 摘要', '', (task.result ?? '').slice(0, 2000), '', '## 改动', '', files ? `${files} 个文件有改动。` : '见提交记录。', branch ? `\n> 由 AgentDeck 队员在隔离分支 \`${branch}\` 上完成。` : ''].join('\n')
    await navigator.clipboard.writeText(`**${task.title}**\n\n${body}`); toast.success('PR 描述已复制（标题 + 摘要 + 改动）')
  }
  const duration = task.startedAt ? (task.endedAt ?? Date.now()) - task.startedAt : 0

  return <div className="detail">
    <header className="detail-header page-header-bar"><div className="detail-title-wrap">
      <div className="detail-eyebrow">{parent ? '队员任务' : '工作任务'}</div>
      {editingTitle ? <input className="title-edit-input" value={titleDraft} autoFocus onChange={(event) => setTitleDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void saveTitle() } else if (event.key === 'Escape') cancelTitleEdit() }} onBlur={() => void saveTitle()} /> : <h1 className="detail-title">{task.title}<button className="title-edit" type="button" title="重命名" onClick={beginTitleEdit}><Pencil size={13} aria-hidden="true" /></button></h1>}
      <details className="detail-prompt"><summary>原始指令</summary><p>{task.prompt}</p></details>
      <div className="detail-meta"><span className={`status-chip status-${task.status}`}>{STATUS_META[task.status]}</span>{turnActive && <span className="active-duration" aria-live="polite">工作中 · {fmtDuration(Date.now() - (task.startedAt ?? Date.now()))}</span>}{task.workdir && <button className="workspace-chip" type="button" title={task.workdir} onClick={() => void bridge.openPath(task.workdir)}><FolderOpen size={13} aria-hidden="true" /><span>{task.workdir.split(/[\\/]/).filter(Boolean).pop()}</span></button>}{workers.length > 0 && <span className="badge badge-squad">⚡ 子任务 {workers.filter((worker) => worker.status === 'done').length}/{workers.length}</span>}{parent && <a className="mini link" role="button" tabIndex={0} onClick={() => onSelect(parent.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(parent.id) } }}>↩ 领队任务: {parent.title}</a>}{!!task.attempt && <span className="mini retry-chip" title={`自动重试 ${task.attempt}/2`}>⟳ 重试 {task.attempt}/2</span>}</div>
    </div><div className="detail-actions">{task.parked && task.status === 'queued' && <button className="btn primary" disabled={busy} onClick={() => void doStart()}>▶ 开始执行</button>}{task.status === 'done' && <><button className="btn" title="复制结果为 Markdown" disabled={busy || !task.result} onClick={() => void copyResult()}>复制结果</button><button className="btn" title="复制 PR 描述（标题+摘要+改动）" disabled={busy || !task.result} onClick={() => void copyPrBody()}>复制 PR 描述</button></>}{turnActive && <button className="btn danger" disabled={busy} onClick={() => void doCancel()}>停止</button>}{(task.status === 'failed' || task.status === 'cancelled' || task.status === 'done') && <><button className="btn" disabled={busy} onClick={() => void doRetry()}>重新运行</button><button className="btn" disabled={busy} onClick={() => void doDuplicate()}>复制</button></>}{task.status !== 'running' && task.status !== 'queued' && <button className="btn ghost" onClick={() => void doDelete()}>删除</button>}</div></header>

    <div className="detail-columns"><div className="detail-main" onScroll={onLogScroll}>
      {task.status === 'failed' && task.error && <div className="error-banner">{task.failure ? <><div className="failure-head">⚠ <b>{task.failure.title}</b><span className="failure-code">{task.failure.code}</span>{task.failure.retryable && <span className="failure-retryable">可重试</span>}</div><div className="failure-hint">{task.failure.hint}</div><details className="failure-raw"><summary>错误原文</summary><pre>{task.error}</pre></details></> : <>⚠ {task.error}</>}</div>}
      {task.integration?.note && <div className={`integration-banner ${task.integration.note.includes('未完成') ? 'warn' : ''}`}>🔀 {task.integration.note}{task.integration.branch && task.workdir && <a className="mini link" role="button" tabIndex={0} onClick={() => void bridge.openPath(task.workdir)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void bridge.openPath(task.workdir) } }}>打开仓库</a>}</div>}
      {activeWorkers.length > 0 && <div className="workers-pane"><div className="list-group-label">运行中的队员（{activeWorkers.length}）</div>{activeWorkers.map((worker) => <div key={worker.id} className={`worker-card ${worker.status === 'cancelled' ? 'is-cancelled' : ''}`} role="button" tabIndex={0} onClick={() => onSelect(worker.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(worker.id) } }}><span className={`dot dot-${worker.status}`} /><span className="worker-title">{worker.title}</span><span className="mini">{worker.status === 'running' ? '执行中…' : worker.status === 'queued' ? '排队' : worker.status === 'cancelled' ? '已取消' : worker.status === 'failed' ? '✗ 失败' : worker.startedAt && worker.endedAt ? `✓ ${fmtDuration(worker.endedAt - worker.startedAt)}` : '✓'}</span>{worker.gitStat ? <span className="mini dim">· 有改动</span> : null}</div>)}</div>}
      {permission && <PermissionPrompt permission={permission} onAnswer={(decision) => void answerPermission(decision)} />}
      <div className="tabs"><button className={tab === 'activity' ? 'active' : ''} onClick={() => setTab('activity')}>动态</button><button className={tab === 'log' ? 'active' : ''} onClick={() => setTab('log')}>执行记录</button><button className={tab === 'result' ? 'active' : ''} onClick={() => setTab('result')}>结果</button><button className={tab === 'git' ? 'active' : ''} onClick={() => setTab('git')} disabled={!task.gitDiff && !task.gitStat}>Git 改动</button></div>
      <div className="detail-body">{tab === 'activity' && <ActivityTimeline task={task} issueIdentifier={issue?.identifier} runs={runs} comments={comments} onShowLog={() => setTab('log')} />}{tab === 'log' && <TurnTimeline task={task} turns={turns} activeNav={activeNav} onNavigate={scrollToTurn} onRewind={(index) => void doRewind(index)} logRef={logRef} onScroll={onLogScroll} />}{tab === 'result' && <div className="result">{task.result ? <Markdown text={task.result} /> : turnActive ? <div className="list-empty">执行中，暂无最终结果</div> : <div className="list-empty">（无结果）</div>}</div>}{tab === 'git' && <GitSummary task={task} />}</div>
      {task.sessionId && task.status !== 'queued' && <footer className="followup"><textarea ref={followRef} value={followUp} placeholder="追问 / 继续这个会话…（Enter 发送，Shift+Enter 换行）" rows={1} onChange={(event) => { setFollowUp(event.target.value); autoGrow(event.target) }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void sendFollowUp() } }} /><button className="btn" disabled={busy || !!task.parentTaskId || (task.status !== 'done' && task.status !== 'failed')} title={task.parentTaskId ? '委派子任务不参与阶段接力' : '让本执行交出下一阶段简报，并在同一 Issue 上硬切新会话'} onClick={() => void sendFollowUp('执行下一阶段', { relay: true })}>⇥ 接力下一阶段</button><button className="btn primary" disabled={busy || !followUp.trim()} onClick={() => void sendFollowUp()}>发送</button></footer>}
    </div>
    <aside className="detail-panel">{!task.parentTaskId && <><GoalPanel task={task} issueId={issueId} /><hr className="prop-sep" /></>}<div className="issue-meta-edit"><span className="prop-label">工作流</span><select value={issue?.status ?? 'todo'} onChange={(event) => void updateWorkflow(event.target.value as IssueStatus)}><option value="backlog">待梳理</option><option value="todo">待办</option><option value="in_progress">进行中</option><option value="in_review">审查中</option><option value="done">已完成</option><option value="blocked">受阻</option><option value="cancelled">已取消</option></select></div><div className="issue-meta-edit"><span className="prop-label">优先级</span><select value={issue?.priority ?? 'none'} onChange={(event) => void updateIssue({ priority: event.target.value as IssuePriority })}><option value="urgent">紧急</option><option value="high">高</option><option value="medium">中</option><option value="low">低</option><option value="none">无</option></select></div><div className="issue-meta-edit"><span className="prop-label">标签</span><input value={labelsDraft} placeholder="design, review" onChange={(event) => setLabelsDraft(event.target.value)} onBlur={() => void updateIssue({ labels: labelsDraft.split(',') })} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void updateIssue({ labels: labelsDraft.split(',') }) } }} /></div>{issue?.labels.length ? <div className="issue-labels">{issue.labels.map((label) => <span className="badge" key={label}>{label}</span>)}</div> : null}<div className="prop-row"><span className="prop-label">状态</span><span className={`status-chip status-${task.status}`}>{STATUS_META[task.status]}</span></div><div className="prop-row"><span className="prop-label">平台</span><span className="badge">{task.backend}</span>{task.sessionId && <span className="mini mono" title={task.sessionId}>{task.sessionId.slice(0, 12)}…</span>}</div>{task.handoff && <div className="prop-row" title={task.handoff}><span className="prop-label">交接备注</span><span className="prop-value" style={{ whiteSpace: 'normal' }}>{task.handoff}</span></div>}<div className="prop-row"><span className="prop-label">工作目录</span>{task.workdir ? <a className="prop-value link" role="button" tabIndex={0} title={task.workdir} onClick={() => void bridge.openPath(task.workdir)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void bridge.openPath(task.workdir) } }}>{task.workdir.split(/[\\/]/).pop()}</a> : <span className="prop-value dim">未绑定</span>}</div><div className="prop-row"><span className="prop-label">用时</span><span className="prop-value">{duration > 0 ? fmtDuration(duration) : '—'}</span></div><hr className="prop-sep" /><div className="prop-group-label">用量</div>{task.usage ? <><div className="prop-row"><span className="prop-label">Tokens</span><span className="prop-value" title={`输入 ${task.usage.inputTokens.toLocaleString()} / 输出 ${task.usage.outputTokens.toLocaleString()}`}>{fmtTokens(task.usage.inputTokens)} / {fmtTokens(task.usage.outputTokens)}</span></div><div className="prop-row"><span className="prop-label">回合</span><span className="prop-value">{task.usage.turns}</span></div><div className="prop-row"><span className="prop-label">成本</span><span className="prop-value">{task.usage.costUsd > 0 ? `$${task.usage.costUsd.toFixed(4)}` : '—'}</span></div></> : <div className="prop-row"><span className="prop-value dim">完成后统计</span></div>}{(task.integration?.branch || task.attempt) && <hr className="prop-sep" />}{task.integration?.branch && <><div className="prop-group-label">集成</div><div className="prop-row"><span className="prop-label">分支</span><span className="prop-value mono" title={task.integration.branch}>{task.integration.branch.replace('agentdeck/task-', '#')}</span></div></>}{!!task.attempt && <div className="prop-row"><span className="prop-label">重试</span><span className="prop-value retry-chip">⟳ {task.attempt}/2</span></div>}<hr className="prop-sep" />{isRelay && <><div className="prop-group-label"><Waypoints size={13} /> 阶段接力<span className="mini dim">阶段 {relayStage}</span></div>{relayPred && <div className="prop-row"><span className="prop-label">接力自</span><span className="prop-value"><a className="mini link" role="button" tabIndex={0} title={relayPred.title} onClick={() => onSelect(relayPred.id)}>▶ {relayPred.title.slice(0, 26)}{relayPred.title.length > 26 ? '…' : ''}</a></span></div>}{relaySucc && <div className="prop-row"><span className="prop-label">已接力 →</span><span className="prop-value"><a className="mini link" role="button" tabIndex={0} title={relaySucc.title} onClick={() => onSelect(relaySucc.id)}>{relaySucc.status === 'queued' && relaySucc.parked ? '⏸ ' : '▶ '}{relaySucc.title.replace(/^▶ /, '').slice(0, 24)}{relaySucc.title.length > 24 ? '…' : ''}</a></span></div>}{!relayPred && <div className="prop-row"><span className="prop-label">触发</span><span className="prop-value">上一阶段接力（同 Issue 新会话）</span></div>}</>}<RunHistory runs={runs} /><CommentPanel comments={comments} draft={commentDraft} onDraftChange={setCommentDraft} onSubmit={() => { void addComment(commentDraft).then(() => setCommentDraft('')) }} /></aside>
    </div>
  </div>
}

function relayNumber(task: Task, tasks: Task[]) {
  let count = 1
  let cursor = task.continuesFrom ? tasks.find((item) => item.id === task.continuesFrom) : undefined
  const seen = new Set([task.id])
  while (cursor && !seen.has(cursor.id)) { seen.add(cursor.id); count++; cursor = cursor.continuesFrom ? tasks.find((item) => item.id === cursor?.continuesFrom) : undefined }
  return count
}

function autoGrow(element: HTMLTextAreaElement, max = 200) {
  element.style.height = 'auto'
  element.style.height = `${Math.min(element.scrollHeight, max)}px`
}
