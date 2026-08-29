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

  // 流式文本（text 增量聚合）
  const streamText = useMemo(() => {
    let out = ''
    for (const e of events) if (e.kind === 'text' && e.text) out += e.text
    return out
  }, [events])

  const turnActive = task.status === 'running'

  // 自动滚底
  useEffect(() => {
    if (tab === 'log' && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [events, tab, streamText])

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
    await bridge.tasks.delete(task.id)
  }
  const doDuplicate = async () => {
    const t = await bridge.tasks.create({
      title: task.title + ' (副本)',
      prompt: task.prompt,
      workdir: task.workdir,
      backend: task.backend
    })
    if (t) window.location.reload()
  }
  const sendFollowUp = async () => {
    const content = followUp.trim()
    if (!content || busy) return
    setBusy(true)
    setFollowUp('')
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
            {task.mode === 'squad' && (
              <span className="badge badge-squad">
                协同 · {{ planning: '规划中', executing: '子任务执行中', synthesizing: '汇总中', integrating: '集成中', done: '已完成' }[task.squad?.phase ?? 'planning']}
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

      {task.status === 'failed' && task.error && <div className="error-banner">⚠ {task.error}</div>}

      {task.squad?.integrationNote && (
        <div className={`integration-banner ${task.squad.integrationNote.includes('未完成') ? 'warn' : ''}`}>
          🔀 {task.squad.integrationNote}
          {task.squad.integrationBranch && task.workdir && (
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
          执行日志
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
          <div className="log" ref={logRef}>
            <div className="log-prompt">
              <span className="log-label">prompt</span>
              <pre>{task.prompt}</pre>
            </div>
            {events.map((e) => (
              <LogLine key={e.seq} e={e} />
            ))}
            {turnActive && streamText && (
              <div className="log-stream">
                <span className="log-label">agent</span>
                <pre>{streamText}</pre>
              </div>
            )}
            {turnActive && <div className="log-running">● 执行中…</div>}
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

      {task.status === 'done' && task.sessionId && task.mode !== 'squad' && (
        <footer className="followup">
          <textarea
            value={followUp}
            placeholder="追问 / 继续这个会话…"
            onChange={(e) => setFollowUp(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendFollowUp()
            }}
            rows={2}
          />
          <button className="btn primary" disabled={busy || !followUp.trim()} onClick={sendFollowUp}>
            发送
          </button>
        </footer>
      )}
    </div>
  )
}

function LogLine({ e }: { e: TaskEvent }) {
  if (e.kind === 'text') return null // 文本在 stream 区聚合展示
  if (e.kind === 'final') {
    return (
      <div className="log-final">
        <span className="log-label ok">final</span>
        <Markdown text={e.text ?? ''} />
      </div>
    )
  }
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
  if (e.kind === 'usage') {
    const d = (e.data ?? {}) as Record<string, unknown>
    const tokens = (d.totalTokens ?? d.tokenCount) as number | undefined
    const parts: string[] = []
    if (tokens) parts.push(`${tokens.toLocaleString()} tokens`)
    const inp = d.inputTokens as number | undefined
    const out = d.outputTokens as number | undefined
    if (inp != null && out != null) parts.push(`in ${inp.toLocaleString()} / out ${out.toLocaleString()}`)
    const dur = d.durationMs as number | undefined
    if (dur != null) parts.push(`${fmtDuration(dur)}`)
    if (parts.length === 0) return null
    return (
      <div className="log-line usage">
        <span className="ts">{new Date(e.ts).toISOString().slice(11, 19)}</span> ⚡ {parts.join(' · ')}
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
