import { useEffect, useMemo, useRef, useState } from 'react'
import { bridge, fmtDuration } from '../api'
import { Markdown } from './Markdown'
import type { Task, TaskEvent } from '../../../shared/types'
import type { PermissionRequest } from '../../../main/backends/types'

type Tab = 'log' | 'result' | 'git'

export function TaskDetail({ task, tasks, onSelect }: { task: Task; tasks: Task[]; onSelect: (id: string) => void }) {
  const [events, setEvents] = useState<TaskEvent[]>([])
  const [tab, setTab] = useState<Tab>('log')
  const [followUp, setFollowUp] = useState('')
  const [busy, setBusy] = useState(false)
  const [permission, setPermission] = useState<PermissionRequest | null>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const followRef = useRef<HTMLTextAreaElement>(null)
  const lastSeqRef = useRef(0)
  const workers = tasks.filter((t) => t.parentTaskId === task.id).sort((a, b) => (a.workerIndex ?? 0) - (b.workerIndex ?? 0))
  const parent = task.parentTaskId ? tasks.find((t) => t.id === task.parentTaskId) : null

  // 初载 + 切任务重置
  useEffect(() => {
    setEvents([])
    lastSeqRef.current = 0
    bridge.tasks.events(task.id, 0).then((es) => {
      setEvents(es)
      lastSeqRef.current = es.length ? es[es.length - 1].seq : 0
    })
  }, [task.id])

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
    const open = (userText: string | null): Turn => {
      cur = { userText, work: [], text: '', final: null, usage: null }
      list.push(cur)
      return cur
    }
    for (const e of events) {
      if (e.kind === 'user') {
        open(e.text ?? '')
        continue
      }
      let t = cur ?? open(null)
      if ((e.kind === 'text' || e.kind === 'final') && t.final !== null) t = open(null)
      if (e.kind === 'text') t.text += e.text ?? ''
      else if (e.kind === 'final') t.final = e.text ?? ''
      else if (e.kind === 'usage') t.usage = { ...(t.usage ?? {}), ...cleanUsage(e.data) }
      else t.work.push(e)
    }
    // 旧任务（无 user 事件）的兜底：首回合用户气泡用 task.prompt 补
    if (list.length && list[0].userText == null) list[0].userText = task.prompt || null
    if (!list.length && task.prompt) list.push({ userText: task.prompt, work: [], text: '', final: null, usage: null })
    return list
  }, [events, task.prompt])

  const turnActive = task.status === 'running'

  // 自动滚底
  useEffect(() => {
    if (tab === 'log' && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [events, tab, turns])

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
    if (!confirm('删除该任务及其日志？')) return
    const r = await bridge.tasks.delete(task.id)
    if (!r.ok) alert(r.error ?? '删除失败')
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
  const sendFollowUp = async () => {
    const content = followUp.trim()
    if (!content || busy) return
    setBusy(true)
    setFollowUp('')
    if (followRef.current) followRef.current.style.height = 'auto'
    const r = await bridge.tasks.followUp(task.id, content)
    if (!r.ok) alert(r.error)
    setBusy(false)
  }

  const duration = task.startedAt ? (task.endedAt ?? Date.now()) - task.startedAt : 0

  return (
    <div className="detail">
      <header className="detail-header">
        <div className="detail-title-wrap">
          <h1 className="detail-title">{task.title}</h1>
          <div className="detail-meta">
            <span className={`status-chip status-${task.status}`}>
              {{ queued: '排队中', running: '执行中', done: '完成', failed: '失败', cancelled: '已取消' }[task.status]}
            </span>
            {workers.length > 0 && (
              <span className="badge badge-squad">
                ⚡ 委派 {workers.filter((w) => w.status === 'done').length}/{workers.length}
              </span>
            )}
            {parent && (
              <a className="mini link" onClick={() => onSelect(parent.id)}>
                ↩ 领队任务: {parent.title}
              </a>
            )}
            {duration > 0 && <span className="mini">{fmtDuration(duration)}</span>}
            {task.workdir && (
              <a className="mini link" title={task.workdir} onClick={() => bridge.openPath(task.workdir)}>
                📂 {task.workdir}
              </a>
            )}
            {task.sessionId && <span className="mini mono">{task.sessionId.slice(0, 18)}…</span>}
          </div>
        </div>
        <div className="detail-actions">
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
            <a className="mini link" onClick={() => bridge.openPath(task.workdir)}>
              打开仓库
            </a>
          )}
        </div>
      )}

      {workers.length > 0 && (
        <div className="workers-pane">
          <div className="list-group-label">子任务（{workers.filter((w) => w.status === 'done').length}/{workers.length} 完成）</div>
          {workers.map((w) => (
            <div key={w.id} className="worker-card" onClick={() => onSelect(w.id)}>
              <span className={`dot dot-${w.status}`} />
              <span className="worker-title">{w.title}</span>
              <span className="mini">
                {w.status === 'running'
                  ? '执行中…'
                  : w.status === 'queued'
                    ? '排队'
                    : w.startedAt && w.endedAt
                      ? fmtDuration(w.endedAt - w.startedAt)
                      : w.status === 'done'
                        ? '✓'
                        : '✗'}
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
        <button className={tab === 'log' ? 'active' : ''} onClick={() => setTab('log')}>
          对话
        </button>
        <button className={tab === 'result' ? 'active' : ''} onClick={() => setTab('result')}>
          结果
        </button>
        <button className={tab === 'git' ? 'active' : ''} onClick={() => setTab('git')} disabled={!task.gitDiff && !task.gitStat}>
          Git 改动
        </button>
      </div>

      <div className="detail-body">
        {tab === 'log' && (
          <div className="log chat" ref={logRef}>
            {turns.map((turn, i) => {
              const isLast = i === turns.length - 1
              const streaming = isLast && turnActive
              const pending = isLast && task.status === 'queued'
              const hasBubble = turn.final != null || !!turn.text || streaming || pending
              return (
                <div className="turn" key={i}>
                  {turn.userText != null && (
                    <div className="bubble user">
                      <pre>{turn.userText}</pre>
                    </div>
                  )}
                  {turn.work.length > 0 && (
                    <details className="worklog">
                      <summary>🔧 工作过程（{turn.work.filter((e) => e.kind === 'tool').length} 次工具调用）</summary>
                      <div className="worklog-body">
                        {turn.work.map((e) => (
                          <LogLine key={e.seq} e={e} />
                        ))}
                      </div>
                    </details>
                  )}
                  {hasBubble && (
                    <div className="bubble agent">
                      {turn.final != null ? (
                        <Markdown text={turn.final} />
                      ) : turn.text ? (
                        <pre className="streaming">{turn.text}</pre>
                      ) : null}
                      {streaming && <div className="log-running">● 回复中…</div>}
                      {pending && <div className="log-running">排队等待执行…</div>}
                      {turn.usage && <UsageBadge usage={turn.usage} />}
                    </div>
                  )}
                </div>
              )
            })}
            {turns.length === 0 && <div className="list-empty">（无对话内容）</div>}
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
            {task.gitDiff ? <pre className="git-diff">{task.gitDiff}</pre> : <div className="list-empty">无改动</div>}
          </div>
        )}
      </div>

      {task.status === 'done' && task.sessionId && (
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
  )
}

/** 对话视图的一个回合：用户输入 → 工作过程（折叠）→ 回复气泡（含用量角标） */
interface Turn {
  userText: string | null
  work: TaskEvent[]
  text: string
  final: string | null
  usage: Record<string, unknown> | null
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
