import { useEffect, useMemo, useRef, useState } from 'react'
import { bridge, fmtDuration, fmtTime, fmtTokens } from '../api'
import { Markdown } from './Markdown'
import { DiffView } from './DiffView'
import { confirmDialog } from '../ui/Confirm'
import { toast } from '../ui/Toasts'
import { FolderOpen, History, MessageSquare, Pencil, Send, Undo2 } from 'lucide-react'
import type { Comment, Issue, IssuePriority, IssueStatus, Run, Task, TaskEvent } from '../../../shared/types'
import type { PermissionRequest } from '../../../main/backends/types'

type Tab = 'activity' | 'log' | 'result' | 'git'

export function TaskDetail({ task, tasks, onSelect }: { task: Task; tasks: Task[]; onSelect: (id: string) => void }) {
  const [events, setEvents] = useState<TaskEvent[]>([])
  const [tab, setTab] = useState<Tab>('activity')
  const [followUp, setFollowUp] = useState('')
  const [busy, setBusy] = useState(false)
  const [, setClock] = useState(0)
  const [permission, setPermission] = useState<PermissionRequest | null>(null)
  const [comments, setComments] = useState<Comment[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [commentDraft, setCommentDraft] = useState('')
  const [issue, setIssue] = useState<Issue | null>(null)
  const [labelsDraft, setLabelsDraft] = useState('')
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [activeNav, setActiveNav] = useState(-1)
  const logRef = useRef<HTMLDivElement>(null)
  const followRef = useRef<HTMLTextAreaElement>(null)
  const lastSeqRef = useRef(0)
  const editingTitleRef = useRef(false)
  const navFrameRef = useRef(0)
  const workers = tasks.filter((t) => t.parentTaskId === task.id).sort((a, b) => (a.workerIndex ?? 0) - (b.workerIndex ?? 0))
  /** 运行时关联：面板只跟未终态的队员；已结束的由 Issue/看板承载，不在这里重复定位 */
  const activeWorkers = workers.filter((t) => t.status === 'running' || t.status === 'queued')
  const parent = task.parentTaskId ? tasks.find((t) => t.id === task.parentTaskId) : null
  const issueId = task.issueId ?? `iss_${task.id}`

  // 初载 + 切任务重置
  const refreshEvents = () => {
    setEvents([])
    lastSeqRef.current = 0
    bridge.tasks.events(task.id, 0).then((es) => {
      setEvents(es)
      lastSeqRef.current = es.length ? es[es.length - 1].seq : 0
    })
  }
  useEffect(() => { refreshEvents() }, [task.id])

  // 回退等操作删除了事件：增量推送拿不到通知，收到失效广播后整段重拉
  useEffect(() => {
    const off = bridge.tasks.onEventsInvalidated((taskId) => {
      if (taskId !== task.id) return
      refreshEvents()
    })
    return off
  }, [task.id])

  useEffect(() => {
    let alive = true
    Promise.all([bridge.issues.get(issueId), bridge.issues.comments(issueId), bridge.issues.runs(issueId)]).then(([nextIssue, nextComments, nextRuns]) => {
      if (!alive) return
      setIssue(nextIssue)
      setLabelsDraft(nextIssue?.labels.join(', ') ?? '')
      setComments(nextComments)
      setRuns(nextRuns)
    })
    return () => { alive = false }
  }, [issueId, task.status, task.result, task.eventCount])

  // 实时事件
  useEffect(() => {
    const off = bridge.tasks.onEvent((taskId, e) => {
      if (taskId !== task.id || e.seq <= lastSeqRef.current) return
      lastSeqRef.current = e.seq
      setEvents((prev) => [...prev, e])
    })
    return off
  }, [task.id])

  // 权限确认请求（非 yolo 模式下 agent 需要放行工具时触发）
  useEffect(() => {
    const off = bridge.tasks.onPermission((taskId, req) => {
      if (taskId === task.id) setPermission(req)
    })
    return off
  }, [task.id])

  const answerPermission = async (decision: 'allow' | 'deny') => {
    if (!permission) return
    const req = permission
    setPermission(null)
    const opt =
      req.options.find((o) => o.response.decision === decision) ?? req.options[0]
    await bridge.tasks.respondPermission(req.requestId, opt.optionId, decision)
  }

  // 对话视图：事件流按回合分组（user 事件开新回合；旧数据无 user 事件时按 final 分）
  const turns = useMemo(() => {
    const list: Turn[] = []
    let cur: Turn | null = null
    const open = (userText: string | null, firstSeq: number): Turn => {
      cur = { userText, firstSeq, items: [], sysNotes: [], usage: null, done: false, streamed: '' }
      list.push(cur)
      return cur
    }
    /** 工具等事件到达即定格末尾未关闭的 text 段（后续 text 另起气泡） */
    const closeText = (t: Turn) => {
      const last = t.items[t.items.length - 1]
      if (last && last.type === 'text' && !last.closed) last.closed = true
    }
    /** 并入末尾的工作过程块（连续的 tool/status/error/raw 合并进同一块） */
    const pushWork = (t: Turn, e: TaskEvent) => {
      closeText(t)
      const last = t.items[t.items.length - 1]
      if (last && last.type === 'work') last.work.push(e)
      else t.items.push({ type: 'work', work: [e] })
    }
    for (const e of events) {
      if (e.kind === 'user') {
        open(e.text ?? '', e.seq)
        continue
      }
      let t = cur ?? open(null, e.seq)
      // final 之后又来 text/final（异常流/旧数据）：另起回合
      if ((e.kind === 'text' || e.kind === 'final') && t.done) t = open(null, e.seq)
      if (e.kind === 'text') {
        const last = t.items[t.items.length - 1]
        t.streamed += e.text ?? ''
        if (last && last.type === 'text' && !last.closed) last.text += e.text ?? ''
        else t.items.push({ type: 'text', text: e.text ?? '', closed: false })
      } else if (e.kind === 'tool') {
        pushWork(t, e)
      } else if (e.kind === 'final') {
        // final ≈ 本回合最后一段 assistant 消息：升级末尾未关闭的 text 段为 Markdown 终段；没有则追加。
        // 与整回合流式文本相同 = 后端全量回显（zcode 完整回合回复/旧数据）：中间回复已各自成泡，不再重复渲染
        const finalTxt = squashText(e.text ?? '')
        const replay = finalTxt !== '' && finalTxt === squashText(t.streamed)
        const last = t.items[t.items.length - 1]
        if (last && last.type === 'text' && !last.closed) {
          t.items[t.items.length - 1] = { type: 'final', text: replay ? last.text : e.text ?? '' }
        } else if (finalTxt !== '' && !replay) {
          // 无未关闭段时：与回合内任一已渲染文本段相同 = 单条消息重复回显（终态追认已展示内容），跳过
          const dup = t.items.some((it) => (it.type === 'text' || it.type === 'final') && squashText(it.text) === finalTxt)
          if (!dup) t.items.push({ type: 'final', text: e.text ?? '' })
        }
        t.done = true
      } else if (e.kind === 'usage') {
        t.usage = { ...(t.usage ?? {}), ...cleanUsage(e.data) }
      } else if (e.kind === 'status' && SYS_NOTE_RE.test(e.text ?? '')) {
        t.sysNotes.push(e.text ?? '')
      } else {
        pushWork(t, e)
      }
    }
    // 旧任务（无 user 事件）的兜底：首回合用户气泡用 task.prompt 补
    if (list.length && list[0].userText == null) list[0].userText = task.prompt || null
    if (!list.length && task.prompt) list.push({ userText: task.prompt, firstSeq: 0, items: [], sysNotes: [], usage: null, done: false, streamed: '' })
    return list
  }, [events, task.prompt])

  const turnActive = task.status === 'running'

  /** 实际滚动容器：现在布局由 .detail-main 滚动（log 自身不可滚），旧布局则相反——两者兼容 */
  const scrollEl = (): HTMLElement | null => {
    const el = logRef.current
    if (!el) return null
    if (el.scrollHeight > el.clientHeight + 1) return el
    return el.closest<HTMLElement>('.detail-main') ?? el
  }

  useEffect(() => {
    if (!turnActive) return
    const timer = window.setInterval(() => setClock((value) => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [turnActive, task.id])

  // 自动滚底
  useEffect(() => {
    if (tab !== 'log') return
    const el = scrollEl()
    if (el) el.scrollTop = el.scrollHeight
  }, [events, tab, turns])

  // ---- 对话导航：当前视口命中的回合（最后一个顶边进入视口上部 80px 的 .turn）----
  const updateActiveNav = () => {
    const el = scrollEl()
    if (!el) return
    const base = el.getBoundingClientRect().top
    let active = 0
    el.querySelectorAll<HTMLElement>('.turn').forEach((n, idx) => {
      if (n.getBoundingClientRect().top - base <= 80) active = idx
    })
    setActiveNav(active)
  }
  const onLogScroll = () => {
    if (navFrameRef.current) return
    navFrameRef.current = requestAnimationFrame(() => {
      navFrameRef.current = 0
      updateActiveNav()
    })
  }
  useEffect(() => {
    if (tab === 'log') updateActiveNav()
  }, [tab, turns.length])

  /** 定位到某回合：按目标与滚动容器的视口差计算（不依赖 offsetParent） */
  const scrollToTurn = (i: number) => {
    const el = scrollEl()
    const target = el?.querySelector<HTMLElement>(`#turn-${i}`)
    if (!el || !target) return
    const delta = target.getBoundingClientRect().top - el.getBoundingClientRect().top
    el.scrollTo({ top: Math.max(0, el.scrollTop + delta - 8), behavior: 'smooth' })
    setActiveNav(i)
  }

  /** 回退到某回合：删除该回合及其之后的消息记录（本地日志，不影响后端会话上下文） */
  const doRewind = async (index: number) => {
    const turn = turns[index]
    if (!turn || index === 0) return
    const ok = await confirmDialog({
      title: '回退到这里？',
      body: `将删除第 ${index + 1} 回合及其之后的所有消息记录，并按剩余内容重算任务结果与用量。该操作只影响本地日志，不会改动后端会话上下文，且不可撤销。`,
      danger: true,
      confirmText: '回退'
    })
    if (!ok) return
    const r = await bridge.tasks.rewind(task.id, turn.firstSeq - 1)
    if (!r.ok) {
      toast.error(r.error ?? '回退失败')
      return
    }
    toast.success('已回退')
    refreshEvents()
  }

  // ---- 标题重命名 ----
  const beginTitleEdit = () => {
    setTitleDraft(task.title)
    editingTitleRef.current = true
    setEditingTitle(true)
  }
  const cancelTitleEdit = () => {
    editingTitleRef.current = false
    setEditingTitle(false)
  }
  const saveTitle = async () => {
    if (!editingTitleRef.current) return
    editingTitleRef.current = false
    setEditingTitle(false)
    const name = titleDraft.trim()
    if (!name || name === task.title) return
    const next = await bridge.tasks.rename(task.id, name)
    if (next) toast.success('标题已更新')
  }

  const doCancel = async () => {
    setBusy(true)
    await bridge.tasks.cancel(task.id)
    setBusy(false)
  }
  const doRetry = async () => {
    setBusy(true)
    await bridge.tasks.retry(task.id)
    setBusy(false)
  }
  const doDelete = async () => {
    if (!(await confirmDialog({ title: '删除该任务及其日志？', body: task.title, danger: true, confirmText: '删除' }))) return
    const r = await bridge.tasks.delete(task.id)
    if (!r.ok) toast.error(r.error ?? '删除失败')
  }
  const doDuplicate = async () => {
    const t = await bridge.tasks.create({
      title: task.title + ' (副本)',
      prompt: task.prompt,
      workdir: task.workdir,
      backend: task.backend
    })
    if (t) onSelect(t.id)
  }
  const doStart = async () => {
    setBusy(true)
    const r = await bridge.tasks.start(task.id)
    if (!r.ok) toast.error(r.error ?? '启动失败')
    setBusy(false)
  }
  /** 复制结果 Markdown（含属性与改动统计） */
  const copyResult = async () => {
    const parts = [`# ${task.title}`, '', task.result ?? '']
    if (task.gitStat) parts.push('', '## 改动', '```', task.gitStat, '```')
    if (task.integration?.branch) parts.push('', `集成分支：\`${task.integration.branch}\``)
    await navigator.clipboard.writeText(parts.join('\n'))
    toast.success('结果已复制为 Markdown')
  }
  /** 复制 PR 描述（标题 + 摘要 + 改动清单） */
  const copyPrBody = async () => {
    const branch = task.integration?.branch
    const files = (task.gitStat || '').split('\n').filter((l) => l.includes('|')).length
    const body = [
      '## 摘要',
      '',
      (task.result ?? '').slice(0, 2000),
      '',
      '## 改动',
      '',
      files ? `${files} 个文件有改动。` : '见提交记录。',
      branch ? `\n> 由 AgentDeck 队员在隔离分支 \`${branch}\` 上完成。` : ''
    ].join('\n')
    await navigator.clipboard.writeText(`**${task.title}**\n\n${body}`)
    toast.success('PR 描述已复制（标题 + 摘要 + 改动）')
  }
  const sendFollowUp = async () => {
    const content = followUp.trim()
    if (!content || busy) return
    setBusy(true)
    setFollowUp('')
    if (followRef.current) followRef.current.style.height = 'auto'
    const r = await bridge.tasks.followUp(task.id, content)
    if (!r.ok) toast.error(r.error ?? '续聊失败')
    setBusy(false)
  }

  const addComment = async () => {
    const content = commentDraft.trim()
    if (!content) return
    const comment = await bridge.issues.addComment(issueId, content)
    if (comment) {
      setComments((current) => [...current, comment])
      setCommentDraft('')
    }
  }

  const updateIssue = async (patch: { priority?: IssuePriority; labels?: string[] }) => {
    const next = await bridge.issues.update(issueId, patch)
    if (next) { setIssue(next); setLabelsDraft(next.labels.join(', ')) }
  }
  const updateWorkflow = async (status: IssueStatus) => {
    const next = await bridge.issues.update(issueId, { status })
    if (next) setIssue(next)
  }

  const duration = task.startedAt ? (task.endedAt ?? Date.now()) - task.startedAt : 0

  return (
    <div className="detail">
      <header className="detail-header page-header-bar">
        <div className="detail-title-wrap">
          <div className="detail-eyebrow">{parent ? '队员任务' : '工作任务'}</div>
          {editingTitle ? (
            <input
              className="title-edit-input"
              value={titleDraft}
              autoFocus
              onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void saveTitle()
                } else if (e.key === 'Escape') {
                  cancelTitleEdit()
                }
              }}
              onBlur={() => void saveTitle()}
            />
          ) : (
            <h1 className="detail-title">
              {task.title}
              <button className="title-edit" type="button" title="重命名" onClick={beginTitleEdit}>
                <Pencil size={13} aria-hidden="true" />
              </button>
            </h1>
          )}
          <p className="detail-prompt">{task.prompt}</p>
          <div className="detail-meta">
            <span className={`status-chip status-${task.status}`}>{STATUS_META[task.status]}</span>
            {turnActive && <span className="active-duration" aria-live="polite">工作中 · {fmtDuration(Date.now() - (task.startedAt ?? Date.now()))}</span>}
            {task.workdir && (
              <button className="workspace-chip" type="button" title={task.workdir} onClick={() => void bridge.openPath(task.workdir)}>
                <FolderOpen size={13} aria-hidden="true" />
                <span>{task.workdir.split(/[\\/]/).filter(Boolean).pop()}</span>
              </button>
            )}
            {workers.length > 0 && (
              <span className="badge badge-squad">
                ⚡ 子任务 {workers.filter((w) => w.status === 'done').length}/{workers.length}
              </span>
            )}
            {parent && (
              <a className="mini link" role="button" tabIndex={0} onClick={() => onSelect(parent.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(parent.id) } }}>
                ↩ 领队任务: {parent.title}
              </a>
            )}
            {!!task.attempt && (
              <span className="mini retry-chip" title={`自动重试 ${task.attempt}/2`}>⟳ 重试 {task.attempt}/2</span>
            )}
          </div>
        </div>
        <div className="detail-actions">
          {task.parked && task.status === 'queued' && (
            <button className="btn primary" disabled={busy} onClick={doStart}>
              ▶ 开始执行
            </button>
          )}
          {task.status === 'done' && (
            <>
              <button className="btn" title="复制结果为 Markdown" disabled={busy || !task.result} onClick={() => void copyResult()}>
                复制结果
              </button>
              <button className="btn" title="复制 PR 描述（标题+摘要+改动）" disabled={busy || !task.result} onClick={() => void copyPrBody()}>
                复制 PR 描述
              </button>
            </>
          )}
          {turnActive && (
            <button className="btn danger" disabled={busy} onClick={doCancel}>
              停止
            </button>
          )}
          {(task.status === 'failed' || task.status === 'cancelled' || task.status === 'done') && (
            <>
              <button className="btn" disabled={busy} onClick={doRetry}>
                重新运行
              </button>
              <button className="btn" disabled={busy} onClick={doDuplicate}>
                复制
              </button>
            </>
          )}
          {task.status !== 'running' && task.status !== 'queued' && (
            <button className="btn ghost" onClick={doDelete}>
              删除
            </button>
          )}
        </div>
      </header>

      <div className="detail-columns">
        <div className="detail-main" onScroll={onLogScroll}>
      {task.status === 'failed' && task.error && (
        <div className="error-banner">
          {task.failure ? (
            <>
              <div className="failure-head">
                ⚠ <b>{task.failure.title}</b>
                <span className="failure-code">{task.failure.code}</span>
                {task.failure.retryable && <span className="failure-retryable">可重试</span>}
              </div>
              <div className="failure-hint">{task.failure.hint}</div>
              <details className="failure-raw">
                <summary>错误原文</summary>
                <pre>{task.error}</pre>
              </details>
            </>
          ) : (
            <>⚠ {task.error}</>
          )}
        </div>
      )}

      {task.integration?.note && (
        <div className={`integration-banner ${task.integration.note.includes('未完成') ? 'warn' : ''}`}>
          🔀 {task.integration.note}
          {task.integration.branch && task.workdir && (
            <a className="mini link" role="button" tabIndex={0} onClick={() => bridge.openPath(task.workdir)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void bridge.openPath(task.workdir) } }}>
              打开仓库
            </a>
          )}
        </div>
      )}

      {activeWorkers.length > 0 && (
        <div className="workers-pane">
          <div className="list-group-label">运行中的队员（{activeWorkers.length}）</div>
          {activeWorkers.map((w) => (
            <div key={w.id} className={`worker-card ${w.status === 'cancelled' ? 'is-cancelled' : ''}`} role="button" tabIndex={0} onClick={() => onSelect(w.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(w.id) } }}>
              <span className={`dot dot-${w.status}`} />
              <span className="worker-title">{w.title}</span>
              <span className="mini">
                {w.status === 'running'
                  ? '执行中…'
                  : w.status === 'queued'
                    ? '排队'
                    : w.status === 'cancelled'
                      ? '已取消'
                      : w.status === 'failed'
                        ? '✗ 失败'
                        : w.startedAt && w.endedAt
                          ? `✓ ${fmtDuration(w.endedAt - w.startedAt)}`
                          : '✓'}
              </span>
              {w.gitStat ? <span className="mini dim">· 有改动</span> : null}
            </div>
          ))}
        </div>
      )}

      {permission && (
        <div className="permission-banner">
          <div className="permission-info">
            <b>🔒 {permission.toolName || '工具'}</b>
            <span className={`risk risk-${permission.riskLevel}`}>{permission.riskLevel}</span>
            <div className="permission-reason">{permission.reason}</div>
          </div>
          <div className="row">
            <button className="btn primary" onClick={() => answerPermission('allow')}>
              允许
            </button>
            <button className="btn danger" onClick={() => answerPermission('deny')}>
              拒绝
            </button>
          </div>
        </div>
      )}

      <div className="tabs">
        <button className={tab === 'activity' ? 'active' : ''} onClick={() => setTab('activity')}>
          动态
        </button>
        <button className={tab === 'log' ? 'active' : ''} onClick={() => setTab('log')}>
          执行记录
        </button>
        <button className={tab === 'result' ? 'active' : ''} onClick={() => setTab('result')}>
          结果
        </button>
        <button className={tab === 'git' ? 'active' : ''} onClick={() => setTab('git')} disabled={!task.gitDiff && !task.gitStat}>
          Git 改动
        </button>
      </div>

      <div className="detail-body">
        {tab === 'activity' && (
          <div className="issue-timeline">
            <div className="timeline-intro"><span className="badge">{issue?.identifier ?? 'Issue'}</span><strong>工作动态</strong><span className="mini">评论、状态变化与执行报告</span></div>
            {runs.length === 0 && comments.length === 0 && <div className="list-empty">暂无动态。执行开始后，Run 和 Agent 汇报会出现在这里。</div>}
            {[...runs.map((run) => ({ kind: 'run' as const, at: run.startedAt ?? 0, run })), ...comments.map((comment) => ({ kind: 'comment' as const, at: comment.createdAt, comment }))].sort((a, b) => a.at - b.at).map((item) => item.kind === 'run' ? (
              <article className="timeline-item timeline-run" key={`run-${item.run.id}`}>
                <span className={`timeline-marker dot-${item.run.status === 'completed' ? 'done' : item.run.status === 'running' ? 'running' : item.run.status === 'error' ? 'failed' : 'cancelled'}`} />
                <div className="timeline-content"><div className="timeline-head"><strong>{item.run.status === 'completed' ? 'Run 完成' : item.run.status === 'running' ? 'Run 执行中' : item.run.status === 'error' ? 'Run 失败' : 'Run 已取消'}</strong><time>{item.run.startedAt ? fmtTime(item.run.startedAt) : '刚刚'}</time></div><p>{item.run.trigger === 'mention' ? '由 Issue 评论提及触发' : item.run.trigger === 'autopilot' ? '由自动化计划触发' : '由指派触发'}{item.run.durationMs ? ` · ${fmtDuration(item.run.durationMs)}` : ''}{item.run.usage ? ` · ${fmtTokens(item.run.usage.totalTokens)} tokens` : ''}</p>{item.run.taskId === task.id && <button className="link timeline-action" onClick={() => setTab('log')}>查看执行记录</button>}</div>
              </article>
            ) : (
              <article className={`timeline-item timeline-comment ${item.comment.author.type}`} key={`comment-${item.comment.id}`}><span className="timeline-marker timeline-avatar">{item.comment.author.type === 'agent' ? 'A' : '我'}</span><div className="timeline-content"><div className="timeline-head"><strong>{item.comment.author.type === 'agent' ? `Agent · ${item.comment.author.id}` : '我'}</strong><time>{fmtTime(item.comment.createdAt)}</time></div><Markdown text={item.comment.content} /></div></article>
            ))}
          </div>
        )}
        {tab === 'log' && (
          <div className="chat-wrap">
            {turns.length > 0 && (
              <nav className="chat-nav">
                <div className="chat-nav-head">对话导航<span className="chat-nav-count">{turns.length} 回合</span></div>
                {turns.map((turn, i) => {
                  const running = i === turns.length - 1 && turnActive
                  return (
                    <button key={i} type="button" className={`chat-nav-item${i === activeNav ? ' active' : ''}`} onClick={() => scrollToTurn(i)}>
                      <span className="chat-nav-idx">{i + 1}</span>
                      <span className="chat-nav-label">{navSummary(turn, i)}</span>
                      {running ? (
                        <span className="chat-nav-state running" aria-label="运行中" />
                      ) : (
                        <span className="chat-nav-state" aria-label="已完成">✓</span>
                      )}
                    </button>
                  )
                })}
              </nav>
            )}
            <div className="log chat" ref={logRef} onScroll={onLogScroll}>
              {turns.map((turn, i) => {
                const isLast = i === turns.length - 1
                const streaming = isLast && turnActive
                const pending = isLast && task.status === 'queued'
                const items = turn.items
                const lastItem = items[items.length - 1]
                const endsWithOpenText = !!lastItem && lastItem.type === 'text' && !lastItem.closed
                const finalIdx = items.findIndex((it) => it.type === 'final')
                let lastBubbleIdx = -1
                let lastWorkIdx = -1
                items.forEach((it, j) => {
                  if (it.type === 'work') lastWorkIdx = j
                  else lastBubbleIdx = j
                })
                return (
                  <div className="turn" id={`turn-${i}`} key={i}>
                    {turn.userText != null && (
                      <div className="bubble user">
                        <pre>{turn.userText}</pre>
                        {i > 0 && (
                          <button className="turn-rewind" type="button" title="回退到这里" onClick={() => void doRewind(i)}>
                            <Undo2 size={12} aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    )}
                    {turn.sysNotes.length > 0 && (
                      <div className="sys-strip">
                        {turn.sysNotes.map((n, j) => (
                          <div key={j} className="sys-note">⚡ {n}</div>
                        ))}
                      </div>
                    )}
                    {items.map((item, j) => {
                      if (item.type === 'work') {
                        return (
                          <details className="worklog" key={j} open={streaming && j === lastWorkIdx ? true : undefined}>
                            <summary>
                              🔧 工作过程（{item.work.filter((e) => e.kind === 'tool').length} 次工具调用）
                              <ToolChips work={item.work} />
                            </summary>
                            <div className="worklog-body">
                              {item.work.map((e) => (
                                <LogLine key={e.seq} e={e} />
                              ))}
                            </div>
                          </details>
                        )
                      }
                      if (item.type === 'final') {
                        return (
                          <div className="bubble agent" key={j}>
                            <Markdown text={item.text} />
                            {turn.usage && <UsageBadge usage={turn.usage} />}
                          </div>
                        )
                      }
                      return (
                        <div className="bubble agent" key={j}>
                          {/* 已关闭的段同样走 Markdown（与终段一致，委派卡片等特殊渲染才能在中间消息出现）；
                              流式中的段保持纯文本，避免半截语法闪烁 */}
                          {item.closed ? <Markdown text={item.text} /> : <pre className="streaming">{item.text}</pre>}
                          {streaming && !item.closed && <div className="log-running">● 回复中…</div>}
                          {turn.usage && finalIdx < 0 && j === lastBubbleIdx && <UsageBadge usage={turn.usage} />}
                        </div>
                      )
                    })}
                    {streaming && !endsWithOpenText && (
                      <div className="bubble agent">
                        <div className="log-running">● 回复中…</div>
                      </div>
                    )}
                    {pending && (
                      <div className="bubble agent">
                        <div className="log-running">排队等待执行…</div>
                      </div>
                    )}
                  </div>
                )
              })}
              {turns.length === 0 && <div className="list-empty">（无对话内容）</div>}
            </div>
          </div>
        )}
        {tab === 'result' && (
          <div className="result">
            {task.result ? (
              <Markdown text={task.result} />
            ) : turnActive ? (
              <div className="list-empty">执行中，暂无最终结果</div>
            ) : (
              <div className="list-empty">（无结果）</div>
            )}
          </div>
        )}
        {tab === 'git' && (
          <div className="git-pane">
            {task.gitStat && <pre className="git-stat">{task.gitStat}</pre>}
            {task.gitDiff ? <DiffView diff={task.gitDiff} /> : <div className="list-empty">无改动</div>}
          </div>
        )}
      </div>

      {task.sessionId && task.status !== 'queued' && (
        <footer className="followup">
          <textarea
            ref={followRef}
            value={followUp}
            placeholder="追问 / 继续这个会话…（Enter 发送，Shift+Enter 换行）"
            rows={1}
            onChange={(e) => {
              setFollowUp(e.target.value)
              autoGrow(e.target)
            }}
            onKeyDown={(e) => {
              // 回车发送；中文输入法组词的 Enter 不算（isComposing）
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void sendFollowUp()
              }
            }}
          />
          <button className="btn primary" disabled={busy || !followUp.trim()} onClick={sendFollowUp}>
            发送
          </button>
        </footer>
      )}
        </div>

        <aside className="detail-panel">
          <div className="issue-meta-edit"><span className="prop-label">工作流</span><select value={issue?.status ?? 'todo'} onChange={(event) => void updateWorkflow(event.target.value as IssueStatus)}><option value="backlog">待梳理</option><option value="todo">待办</option><option value="in_progress">进行中</option><option value="in_review">审查中</option><option value="done">已完成</option><option value="blocked">受阻</option><option value="cancelled">已取消</option></select></div>
          <div className="issue-meta-edit"><span className="prop-label">优先级</span><select value={issue?.priority ?? 'none'} onChange={(event) => void updateIssue({ priority: event.target.value as IssuePriority })}><option value="urgent">紧急</option><option value="high">高</option><option value="medium">中</option><option value="low">低</option><option value="none">无</option></select></div>
          <div className="issue-meta-edit"><span className="prop-label">标签</span><input value={labelsDraft} placeholder="design, review" onChange={(event) => setLabelsDraft(event.target.value)} onBlur={() => void updateIssue({ labels: labelsDraft.split(',') })} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void updateIssue({ labels: labelsDraft.split(',') }) } }} /></div>
          {issue?.labels.length ? <div className="issue-labels">{issue.labels.map((label) => <span className="badge" key={label}>{label}</span>)}</div> : null}
          <div className="prop-row">
            <span className="prop-label">状态</span>
            <span className={`status-chip status-${task.status}`}>{STATUS_META[task.status]}</span>
          </div>
          <div className="prop-row">
            <span className="prop-label">平台</span>
            <span className="badge">{task.backend}</span>
            {task.sessionId && <span className="mini mono" title={task.sessionId}>{task.sessionId.slice(0, 12)}…</span>}
          </div>
          {task.handoff && (
            <div className="prop-row" title={task.handoff}>
              <span className="prop-label">交接备注</span>
              <span className="prop-value" style={{ whiteSpace: 'normal' }}>{task.handoff}</span>
            </div>
          )}
          <div className="prop-row">
            <span className="prop-label">工作目录</span>
            {task.workdir ? (
              <a className="prop-value link" role="button" tabIndex={0} title={task.workdir} onClick={() => bridge.openPath(task.workdir)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void bridge.openPath(task.workdir) } }}>
                {task.workdir.split(/[\/]/).pop()}
              </a>
            ) : (
              <span className="prop-value dim">未绑定</span>
            )}
          </div>
          <div className="prop-row">
            <span className="prop-label">用时</span>
            <span className="prop-value">{duration > 0 ? fmtDuration(duration) : '—'}</span>
          </div>
          <hr className="prop-sep" />
          <div className="prop-group-label">用量</div>
          {task.usage ? (
            <>
              <div className="prop-row">
                <span className="prop-label">Tokens</span>
                <span className="prop-value" title={`输入 ${task.usage.inputTokens.toLocaleString()} / 输出 ${task.usage.outputTokens.toLocaleString()}`}>
                  {fmtTokens(task.usage.inputTokens)} / {fmtTokens(task.usage.outputTokens)}
                </span>
              </div>
              <div className="prop-row">
                <span className="prop-label">回合</span>
                <span className="prop-value">{task.usage.turns}</span>
              </div>
              <div className="prop-row">
                <span className="prop-label">成本</span>
                <span className="prop-value">{task.usage.costUsd > 0 ? `$${task.usage.costUsd.toFixed(4)}` : '—'}</span>
              </div>
            </>
          ) : (
            <div className="prop-row"><span className="prop-value dim">完成后统计</span></div>
          )}
          {(task.integration?.branch || task.attempt) && <hr className="prop-sep" />}
          {task.integration?.branch && (
            <>
              <div className="prop-group-label">集成</div>
              <div className="prop-row">
                <span className="prop-label">分支</span>
                <span className="prop-value mono" title={task.integration.branch}>{task.integration.branch.replace('agentdeck/task-', '#')}</span>
              </div>
            </>
          )}
          {!!task.attempt && (
            <div className="prop-row">
              <span className="prop-label">重试</span>
              <span className="prop-value retry-chip">⟳ {task.attempt}/2</span>
            </div>
          )}
          <hr className="prop-sep" />
          <div className="prop-group-label"><History size={13} /> 执行记录 {runs.length ? `(${runs.length})` : ''}</div>
          <div className="run-history">
            {runs.length === 0 && <span className="mini dim">暂无执行记录</span>}
            {runs.map((run) => (
              <div className="run-history-row" key={run.id}>
                <span className={`dot dot-${run.status === 'completed' ? 'done' : run.status === 'running' ? 'running' : run.status === 'error' ? 'failed' : 'cancelled'}`} />
                <span className="run-history-main"><b>{run.status === 'completed' ? '已完成' : run.status === 'running' ? '执行中' : run.status === 'error' ? '失败' : '已取消'}</b><small>{run.startedAt ? new Date(run.startedAt).toLocaleString() : '排队中'}{run.durationMs ? ` · ${fmtDuration(run.durationMs)}` : ''}</small></span>
                {run.usage && <span className="mini mono">{fmtTokens(run.usage.inputTokens + run.usage.outputTokens)}</span>}
              </div>
            ))}
          </div>
          <hr className="prop-sep" />
          <div className="prop-group-label"><MessageSquare size={13} /> 讨论 {comments.length ? `(${comments.length})` : ''}</div>
          <div className="issue-comments">
            {comments.length === 0 && <span className="mini dim">暂无评论</span>}
            {comments.slice(-4).map((comment) => <div className={`issue-comment ${comment.author.type}`} key={comment.id}><b>{comment.author.type === 'agent' ? comment.author.id : '我'}</b><span>{comment.content}</span></div>)}
          </div>
          <div className="comment-compose"><input value={commentDraft} onChange={(event) => setCommentDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void addComment() } }} placeholder="写评论…" /><button className="icon-btn" title="发送评论" disabled={!commentDraft.trim()} onClick={() => void addComment()}><Send size={13} /></button></div>
        </aside>
      </div>
    </div>
  )
}

/** 回合内按事件到达顺序交错的展示项 */
type TurnItem =
  | { type: 'text'; text: string; closed: boolean } // 模型流式输出的一段（工具调用到达即定格，后续 text 另起气泡）
  | { type: 'final'; text: string } // 回合终态回复（Markdown 渲染）
  | { type: 'work'; work: TaskEvent[] } // 连续的 tool/status/error/raw 事件（折叠的工作过程块）

/** 对话视图的一个回合：用户输入 → 系统条带（派工/重试/集成）→ 交错的 text 段 / 工作过程 / 终段（含用量角标） */
interface Turn {
  userText: string | null
  /** 本回合首个事件的 seq（user 事件优先；旧数据为首个落进来的事件）——回退锚点 */
  firstSeq: number
  items: TurnItem[]
  /** 委派/重试/集成等生命周期事件——提升为可见条带，不折叠 */
  sysNotes: string[]
  usage: Record<string, unknown> | null
  /** 已收到 final（回合结束标志） */
  done: boolean
  /** 本回合流式文本累计（final 全量回显检测用） */
  streamed: string
}

/** 导航条里的回合摘要：用户消息首行截断约 24 字；无 userText 时显示「初始任务」 */
function navSummary(turn: Turn, index: number): string {
  const first = (turn.userText ?? '').split('\n')[0].trim()
  if (!first) return index === 0 ? '初始任务' : `回合 ${index + 1}`
  return first.length > 24 ? first.slice(0, 24) + '…' : first
}

/** 状态中文（头部与属性栏共用） */
const STATUS_META: Record<Task['status'], string> = {
  queued: '排队中', running: '执行中', done: '完成', failed: '失败', cancelled: '已取消'
}

/** 需要可见展示的系统事件（委派轮次、防环拒绝、自动重试、集成结果、回灌） */
const SYS_NOTE_RE = /(第\s*\d+\s*轮|拒绝派给|未找到可驱使|自动重试|不再下派|回灌|集成)/

/** 压平空白后比较，容忍消息拼接处的换行差异 */
const squashText = (s: string) => s.replace(/\s+/g, ' ').trim()

/** 工具调用分类（对标 Multica 转录的 Commands/Edits/Reads/Other） */
function classifyTool(name: string): 'reads' | 'commands' | 'edits' | 'other' {
  const n = name.toLowerCase()
  if (/^(read|grep|glob|ls|find|search|view|cat|notebookread)/.test(n)) return 'reads'
  if (/^(bash|shell|exec|run|terminal|command)/.test(n)) return 'commands'
  if (/^(edit|write|multiedit|notebookedit|applypatch|apply_patch|replace)/.test(n)) return 'edits'
  return 'other'
}

/** worklog 摘要里的分类 chips */
function ToolChips({ work }: { work: TaskEvent[] }) {
  const counts = { reads: 0, commands: 0, edits: 0, other: 0 } as Record<string, number>
  for (const e of work) {
    if (e.kind !== 'tool' || (e.data as { phase?: string } | undefined)?.phase === 'result') continue
    counts[classifyTool(e.text || '')]++
  }
  const parts: string[] = []
  if (counts.reads) parts.push(`读取 ${counts.reads}`)
  if (counts.commands) parts.push(`命令 ${counts.commands}`)
  if (counts.edits) parts.push(`编辑 ${counts.edits}`)
  if (counts.other) parts.push(`其他 ${counts.other}`)
  if (!parts.length) return null
  return <span className="tool-chips"> · {parts.join(' · ')}</span>
}

/** 去掉 usage 里的空值，便于逐条合并 */
function cleanUsage(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== 'object') return {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (v !== undefined && v !== null && v !== '') out[k] = v
  }
  return out
}

/** textarea 自适应高度：随内容长高，封顶 max */
function autoGrow(el: HTMLTextAreaElement, max = 200) {
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, max)}px`
}

/** 回复气泡右下角的用量角标 */
function UsageBadge({ usage }: { usage: Record<string, unknown> }) {
  const num = (v: unknown) => (typeof v === 'number' ? v : undefined)
  const tokens = num(usage.totalTokens) ?? num(usage.tokenCount)
  const inp = num(usage.inputTokens) ?? num(usage.input_tokens)
  const out = num(usage.outputTokens) ?? num(usage.output_tokens)
  const dur = num(usage.durationMs)
  const cost = num(usage.costUsd)
  const nTurns = num(usage.numTurns)
  const parts: string[] = []
  if (tokens) parts.push(`${tokens.toLocaleString()} tokens`)
  else if (inp != null || out != null) parts.push(`${(inp ?? 0).toLocaleString()} / ${(out ?? 0).toLocaleString()} tokens`)
  if (tokens && inp != null && out != null) parts.push(`in ${inp.toLocaleString()} / out ${out.toLocaleString()}`)
  if (dur != null) parts.push(fmtDuration(dur))
  if (cost != null) parts.push(`$${cost.toFixed(4)}`)
  if (nTurns != null) parts.push(`${nTurns} 轮`)
  if (!parts.length) return null
  return <span className="bubble-usage">⚡ {parts.join(' · ')}</span>
}

function LogLine({ e }: { e: TaskEvent }) {
  // text/final/user/usage 由气泡负责，这里只渲染工作过程里的行
  if (e.kind === 'status') {
    return (
      <div className="log-line status">
        <span className="ts">{new Date(e.ts).toISOString().slice(11, 19)}</span> {e.text}
      </div>
    )
  }
  if (e.kind === 'tool') {
    const d = (e.data ?? {}) as { phase?: string; args?: string; ok?: boolean; durationMs?: number; preview?: string }
    const name = e.text || ''
    const args = d.args || ''
    const time = new Date(e.ts).toISOString().slice(11, 19)
    if (d.phase === 'started') {
      return (
        <div className="log-line tool" title={args}>
          <span className="ts">{time}</span> 🛠 <b>{name}</b> <span className="mono dim">{args}</span>
        </div>
      )
    }
    if (d.phase === 'result') {
      const dur = d.durationMs != null ? ` (${Math.round(d.durationMs)}ms)` : ''
      const mark = d.ok === false ? '✗' : '✓'
      return (
        <div className="log-line tool-result" title={d.preview}>
          <span className="ts">{time}</span> {mark} <b>{name}</b>
          <span className="dim">{dur}</span>
          {d.preview ? <span className="mono dim preview"> {firstLine(d.preview)}</span> : null}
        </div>
      )
    }
    return (
      <div className="log-line tool">
        <span className="ts">{time}</span> 🛠 <b>{name}</b>
      </div>
    )
  }
  if (e.kind === 'error') {
    return (
      <div className="log-line error">
        <span className="ts">{new Date(e.ts).toISOString().slice(11, 19)}</span> ✗ {e.text}
      </div>
    )
  }
  // raw：折叠展示类型
  if (e.kind === 'raw' && e.text) {
    return (
      <div className="log-line raw">
        <span className="ts">{new Date(e.ts).toISOString().slice(11, 19)}</span> · {e.text}
      </div>
    )
  }
  return null
}

function firstLine(s: string): string {
  const l = s.split('\n')[0] ?? ''
  return l.length > 100 ? l.slice(0, 100) + '…' : l
}
