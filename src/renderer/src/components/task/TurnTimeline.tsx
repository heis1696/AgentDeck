import { ArrowDown, ChevronDown, Copy, Undo2 } from 'lucide-react'
import { createContext, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { Markdown, renderStreamingMarkers } from '../Markdown'
import { bridge, fmtDuration, fmtTime } from '../../api'
import { PARKED_QUEUED_LABEL } from '../../labels'
import type { Task, TaskEvent } from '../../../../shared/types'
import type { Turn } from '../../hooks/turnModel'
import { classifyTool, navSummary } from '../../hooks/turnModel'
import { isComposingKey, ui, type DockEditMetadata } from '../../ui/interaction-center'

const TimelineTaskId = createContext('')
/** 贴底阈值：与宿主 activeNav 判定同源，滚动只剩不到一行半就算「跟随最新」 */
export const FOLLOW_EPSILON = 40

function EditBadge({ edit, seq }: { edit: DockEditMetadata; seq: number }) {
  const taskId = useContext(TimelineTaskId)
  if (!edit || typeof edit.file !== 'string' || !edit.file) return null
  const name = edit.file.split(/[\\/]/).pop() || edit.file
  const dockId = `file:${taskId}:${seq}:${edit.file}`
  // 二段式：先以工具入参快照立即开页（流式即可点），git 权威 diff 回来后凭打开请求标识回写——
  // token 只认这一次打开：页签被关掉（或另开一次）后旧结果直接作废，绝不重开分页
  const open = () => {
    const handle = ui.dock.open({ id: dockId, kind: 'file', title: name, payload: { ...edit, taskId } })
    void bridge.tasks.fileDiff(taskId, edit.file).then((r) => {
      if (!r) return
      const patch = r.ok
        ? r.diff
          ? { diff: r.diff, additions: r.additions ?? edit.additions, deletions: r.deletions ?? edit.deletions, binary: r.binary, diffNote: r.binary ? '二进制文件，仅统计' : 'git 未提交 diff（工作区 + 暂存）' }
          : { diffNote: `git 显示无未提交改动（${r.note ?? 'clean'}）——回退为工具入参快照` }
        : { diffNote: `git diff 不可用（${r.error ?? r.code ?? '失败'}）——回退为工具入参快照` }
      ui.dock.update(handle, { payload: patch })
    }).catch(() => {})
  }
  return <button type="button" className="timeline-edit-badge" title={edit.file} aria-label={`查看 ${edit.file}，新增 ${edit.additions} 行，删除 ${edit.deletions} 行`} onClick={open}><span className="timeline-edit-name">{name}</span><span className="edit-added">+{edit.additions}</span><span className="edit-deleted">-{edit.deletions}</span></button>
}

/** 工作过程摘要：调用种类分布 + 工具总耗时（长回合的「这段时间花在哪」一目了然） */
function ToolChips({ work }: { work: TaskEvent[] }) {
  const counts = { reads: 0, commands: 0, edits: 0, other: 0 }
  let elapsed = 0
  for (const event of work) {
    if (event.kind !== 'tool') continue
    const data = event.data as { phase?: string; durationMs?: number } | undefined
    if (data?.phase === 'result') { if (typeof data.durationMs === 'number') elapsed += data.durationMs; continue }
    counts[classifyTool(event.text || '')]++
  }
  const parts = Object.entries(counts).filter(([, count]) => count).map(([kind, count]) => `${kind === 'reads' ? '读取' : kind === 'commands' ? '命令' : kind === 'edits' ? '编辑' : '其他'} ${count}`)
  const summary = parts.length ? parts.join(' · ') : ''
  return <span className="tool-chips">{summary}{elapsed > 0 && <>{summary ? ' · ' : ''}{fmtDuration(elapsed)}</>}</span>
}

function UsageBadge({ usage }: { usage: Record<string, unknown> }) {
  const num = (value: unknown) => typeof value === 'number' ? value : undefined
  const tokens = num(usage.totalTokens) ?? num(usage.tokenCount)
  const input = num(usage.inputTokens) ?? num(usage.input_tokens)
  const output = num(usage.outputTokens) ?? num(usage.output_tokens)
  const duration = num(usage.durationMs)
  const cost = num(usage.costUsd)
  const rounds = num(usage.numTurns)
  const parts: string[] = []
  if (tokens) parts.push(`${tokens.toLocaleString()} tokens`)
  else if (input != null || output != null) parts.push(`${(input ?? 0).toLocaleString()} / ${(output ?? 0).toLocaleString()} tokens`)
  if (tokens && input != null && output != null) parts.push(`in ${input.toLocaleString()} / out ${output.toLocaleString()}`)
  if (duration != null) parts.push(fmtDuration(duration))
  if (cost != null) parts.push(`$${cost.toFixed(4)}`)
  if (rounds != null) parts.push(`${rounds} 轮`)
  return parts.length ? <span className="bubble-usage">⚡ {parts.join(' · ')}</span> : null
}

function firstLine(value: string) {
  const line = value.split('\n')[0] ?? ''
  return line.length > 100 ? line.slice(0, 100) + '…' : line
}

/** 回合起始时间：取该回合第一个带时间戳的工作事件（用户气泡本身不带 ts） */
function turnTime(turn: Turn): number {
  for (const item of turn.items) {
    if (item.type === 'work' && item.work.length) return item.work[0].ts
  }
  return 0
}

/** 一个气泡右上角的悬浮动作（复制原文）：只在 hover / 键盘聚焦时出现，不占版面 */
function BubbleTools({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(timer.current), [])
  return <div className="bubble-tools">
    <button
      type="button"
      className="bubble-tool"
      title={`复制${label}`}
      aria-label={`复制${label}`}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          ui.toast.success(`${label}已复制`)
          clearTimeout(timer.current)
          timer.current = setTimeout(() => setCopied(false), 1600)
        }).catch(() => ui.toast.error('复制失败'))
      }}
    >
      <Copy size={12} aria-hidden="true" />{copied && <span className="bubble-tool-flag">已复制</span>}
    </button>
  </div>
}

// 迷你导航悬停预览：用户首行 + 最近的回复首行
function turnPreview(turn: Turn): { title: string; body: string } {
  const title = (turn.userText ?? '').split('\n')[0].replace(/\s+/g, ' ').trim()
  let replyText = ''
  for (let i = turn.items.length - 1; i >= 0; i--) {
    const item = turn.items[i]
    if ((item.type === 'final' || item.type === 'text') && item.text.trim()) { replyText = item.text.trim(); break }
  }
  const bodyLine = replyText.split('\n').map((line) => line.trim()).filter(Boolean)[0] ?? ''
  return {
    title: title.length > 46 ? title.slice(0, 46) + '…' : title,
    body: bodyLine.length > 80 ? bodyLine.slice(0, 80) + '…' : bodyLine
  }
}

// ZCode 式回合索引线：固定不随滚动，线组在左缘垂直居中、等距排列；
// 线宽编码回合内容量占比；静默态淡灰、悬停加长提亮（带动画）、当前回合青色高亮；
// 悬停弹出该回合预览，点击跳转；键盘 ↑↓/Home/End 在索引线上同样可走。
function TurnMinimap({ turns, activeNav, onNavigate }: { turns: Turn[]; activeNav: number; onNavigate: (index: number) => void }) {
  const railRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const hoveredRef = useRef(-1)
  const [railH, setRailH] = useState(0)
  const [hovered, setHovered] = useState(-1)

  useEffect(() => {
    const rail = railRef.current
    if (!rail) return
    const measure = () => setRailH(rail.clientHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(rail)
    return () => observer.disconnect()
    // 首回合为空时轨道未挂载，回合出现后需重新挂上测量
  }, [turns.length])

  const enter = (index: number) => {
    hoveredRef.current = index
    setHovered(index)
    const pop = popRef.current
    const rail = railRef.current
    if (pop && rail) {
      // 与线条同高对齐，夹在轨道范围内
      const top = itemTop(index)
      pop.style.top = `${Math.max(18, Math.min(top, rail.clientHeight - 34))}px`
    }
  }
  const leave = () => {
    hoveredRef.current = -1
    setHovered(-1)
  }

  // 线距固定 10px，回合过多时压缩间距塞进轨道；线组整体垂直居中，数量增长时两端对称扩展
  const itemTop = (index: number) => {
    const n = turns.length
    const pitch = n > 1 ? Math.min(10, Math.max(5, (railH - 40) / (n - 1))) : 0
    return railH / 2 - (pitch * (n - 1)) / 2 + pitch * index
  }

  if (!turns.length) return null
  const preview = hovered >= 0 ? turnPreview(turns[hovered]) : null
  return (
    <div
      className="chat-minimap"
      ref={railRef}
      onMouseLeave={leave}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) leave()
      }}
      onKeyDown={(event) => {
        if (isComposingKey(event.nativeEvent)) return
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('.chat-minimap-item'))
        const current = buttons.indexOf(event.target as HTMLButtonElement)
        if (current < 0 || !buttons.length) return
        event.preventDefault()
        const next = event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? buttons.length - 1
            : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
        buttons[next]?.focus()
      }}
      role="navigation"
      aria-label="回合索引"
    >
      {turns.map((turn, index) => (
        <button
          key={index}
          type="button"
          className={`chat-minimap-item${index === activeNav ? ' active' : ''}`}
          style={{ top: `${itemTop(index)}px` }}
          onMouseEnter={() => enter(index)}
          onFocus={() => enter(index)}
          onClick={() => onNavigate(index)}
          aria-label={`第 ${index + 1} 回合：${navSummary(turn, index)}`}
          aria-current={index === activeNav ? 'true' : undefined}
        />
      ))}
      {hovered >= 0 && preview && (
        <div ref={popRef} className="chat-minimap-pop" style={{ top: itemTop(hovered) }} role="tooltip">
          <div className="chat-minimap-pop-head"><span className="chat-minimap-pop-idx">{hovered + 1}</span>{preview.title || navSummary(turns[hovered], hovered)}</div>
          {preview.body && <div className="chat-minimap-pop-body">{preview.body}</div>}
        </div>
      )}
    </div>
  )
}

function LogLine({ event }: { event: TaskEvent }) {
  const time = new Date(event.ts).toISOString().slice(11, 19)
  if (event.kind === 'status') return <div className="log-line status"><span className="ts">{time}</span> {event.text}</div>
  if (event.kind === 'tool') {
    const data = (event.data ?? {}) as { phase?: string; args?: string; ok?: boolean; durationMs?: number; preview?: string; edit?: DockEditMetadata }
    if (data.phase === 'started') return <div className="log-line tool" title={data.args}><span className="ts">{time}</span> 🛠 <b>{event.text}</b> <span className="mono dim">{data.args}</span></div>
    if (data.phase === 'result') return <div className="log-line tool-result" title={data.preview}><span className="ts">{time}</span> {data.ok === false ? '✗' : '✓'} <b>{event.text}</b><span className="dim">{data.durationMs != null ? ` (${Math.round(data.durationMs)}ms)` : ''}</span>{data.preview ? <span className="mono dim preview"> {firstLine(data.preview)}</span> : null}{data.edit && <EditBadge edit={data.edit} seq={event.seq} />}</div>
    return <div className="log-line tool"><span className="ts">{time}</span> 🛠 <b>{event.text}</b></div>
  }
  if (event.kind === 'error') return <div className="log-line error"><span className="ts">{time}</span> ✗ {event.text}</div>
  if (event.kind === 'raw' && event.text) return <div className="log-line raw"><span className="ts">{time}</span> · {event.text}</div>
  return null
}

/**
 * 执行记录（回合时间线）：
 * - 每个回合有极简页眉（#序号 + 起始时间 + 状态），长会话里随时知道「读到第几问」；
 * - 用户气泡吸顶：滚长回复时问题不丢，读完能立刻对回上下文；
 * - 气泡右上角悬浮「复制」；工作过程摘要补上工具总耗时；
 * - 「贴底跟随」是**宿主受控状态**（审查项 2）：following / onFollowLatest 由宿主传入，
 *   宿主在滚动与流式事件到达时更新它——本组件只是视图，不再自己算一份（否则两套判定会打架）。
 */
export function TurnTimeline({ task, turns, activeNav, following, onFollowLatest, onNavigate, onRewind, logRef, onScroll }: { task: Task; turns: Turn[]; activeNav: number; following: boolean; onFollowLatest: () => void; onNavigate: (index: number) => void; onRewind: (index: number) => void; logRef: RefObject<HTMLDivElement>; onScroll: () => void }) {
  const active = task.status === 'running'

  return (
    <TimelineTaskId.Provider value={task.id}><div className={`chat-wrap${following ? ' is-following' : ' is-reading'}`}>
      <TurnMinimap turns={turns} activeNav={activeNav} onNavigate={onNavigate} />
      <div
        className="log chat"
        ref={logRef}
        onScroll={onScroll}
        tabIndex={0}
        aria-label="执行记录（回合对话与工具调用）"
      >
        {turns.map((turn, index) => {
          const streaming = index === turns.length - 1 && active
          const pending = index === turns.length - 1 && task.status === 'queued'
          const lastItem = turn.items[turn.items.length - 1]
          const endsWithOpenText = lastItem?.type === 'text' && !lastItem.closed
          const finalIndex = turn.items.findIndex((item) => item.type === 'final')
          const startedAt = turnTime(turn)
          let lastBubbleIndex = -1
          let lastWorkIndex = -1
          turn.items.forEach((item, itemIndex) => { if (item.type === 'work') lastWorkIndex = itemIndex; else lastBubbleIndex = itemIndex })
          return <div className="turn" id={`turn-${index}`} key={index}>
            <div className="turn-head">
              <span className="turn-index">#{index + 1}</span>
              {startedAt > 0 && <time className="turn-time" title={fmtTime(startedAt)}>{fmtTime(startedAt)}</time>}
              <span className={`turn-state${turn.done ? ' is-done' : streaming || pending ? ' is-live' : ''}`}>
                {turn.done ? '已完成' : streaming ? '回复中' : pending ? (task.parked ? PARKED_QUEUED_LABEL : '排队中') : '—'}
              </span>
              {index > 0 && <button className="turn-rewind-inline" type="button" title="回退到这里（删除本回合及其之后的记录）" onClick={() => onRewind(index)}><Undo2 size={12} aria-hidden="true" /> 回退</button>}
            </div>
            {turn.userText != null && <div className="bubble user"><pre>{turn.userText}</pre><BubbleTools text={turn.userText} label="提问" /></div>}
            {turn.sysNotes.length > 0 && <div className="sys-strip">{turn.sysNotes.map((note, noteIndex) => <div key={noteIndex} className="sys-note">⚡ {note}</div>)}</div>}
            {turn.items.map((item, itemIndex) => {
              if (item.type === 'work') return <details className="worklog" key={itemIndex} open={streaming && itemIndex === lastWorkIndex ? true : undefined}><summary>🔧 工作过程（{item.work.filter((event) => event.kind === 'tool').length} 次工具调用）<ToolChips work={item.work} /></summary><div className="worklog-body">{item.work.map((event) => <LogLine key={event.seq} event={event} />)}</div></details>
              if (item.type === 'final') return <div className="bubble agent is-final" key={itemIndex}><BubbleTools text={item.text} label="回复" /><Markdown text={item.text} />{turn.usage && <UsageBadge usage={turn.usage} />}</div>
              return <div className="bubble agent" key={itemIndex}>{item.closed && <BubbleTools text={item.text} label="回复" />}{item.closed ? <Markdown text={item.text} /> : <pre className="streaming">{renderStreamingMarkers(item.text)}</pre>}{streaming && !item.closed && <div className="log-running"><span className="dots"><i /><i /><i /></span>回复中…</div>}{turn.usage && finalIndex < 0 && itemIndex === lastBubbleIndex && <UsageBadge usage={turn.usage} />}</div>
            })}
            {streaming && !endsWithOpenText && finalIndex < 0 && <div className="bubble agent"><div className="log-running"><span className="dots"><i /><i /><i /></span>回复中…</div></div>}
            {pending && <div className="bubble agent"><div className="log-running">{task.parked ? PARKED_QUEUED_LABEL : <><span className="dots"><i /><i /><i /></span>排队等待执行…</>}</div></div>}
          </div>
        })}
        {turns.length === 0 && <div className="list-empty">（无对话内容）</div>}
      </div>
      {!following && turns.length > 0 && <button type="button" className="chat-latest" onClick={onFollowLatest} title="回到最新内容（End）">
        <ArrowDown size={13} aria-hidden="true" /> 回到最新
        <span className="chat-latest-hint"><ChevronDown size={11} aria-hidden="true" /></span>
      </button>}
    </div></TimelineTaskId.Provider>
  )
}
