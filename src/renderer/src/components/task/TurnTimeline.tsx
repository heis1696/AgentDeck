import { Undo2 } from 'lucide-react'
import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { Markdown, renderStreamingMarkers } from '../Markdown'
import { fmtDuration } from '../../api'
import type { Task, TaskEvent } from '../../../../shared/types'
import type { Turn } from '../../hooks/turnModel'
import { classifyTool, navSummary } from '../../hooks/turnModel'

function ToolChips({ work }: { work: TaskEvent[] }) {
  const counts = { reads: 0, commands: 0, edits: 0, other: 0 }
  for (const event of work) {
    if (event.kind !== 'tool' || (event.data as { phase?: string } | undefined)?.phase === 'result') continue
    counts[classifyTool(event.text || '')]++
  }
  const parts = Object.entries(counts).filter(([, count]) => count).map(([kind, count]) => `${kind === 'reads' ? '读取' : kind === 'commands' ? '命令' : kind === 'edits' ? '编辑' : '其他'} ${count}`)
  return parts.length ? <span className="tool-chips"> · {parts.join(' · ')}</span> : null
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
// 悬停弹出该回合预览，点击跳转。
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
    <div className="chat-minimap" ref={railRef} onMouseLeave={leave}>
      {turns.map((_, index) => (
        <button
          key={index}
          type="button"
          className={`chat-minimap-item${index === activeNav ? ' active' : ''}`}
          style={{ top: `${itemTop(index)}px` }}
          onMouseEnter={() => enter(index)}
          onFocus={() => enter(index)}
          onClick={() => onNavigate(index)}
          aria-label={`回合 ${index + 1}`}
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
    const data = (event.data ?? {}) as { phase?: string; args?: string; ok?: boolean; durationMs?: number; preview?: string }
    if (data.phase === 'started') return <div className="log-line tool" title={data.args}><span className="ts">{time}</span> 🛠 <b>{event.text}</b> <span className="mono dim">{data.args}</span></div>
    if (data.phase === 'result') return <div className="log-line tool-result" title={data.preview}><span className="ts">{time}</span> {data.ok === false ? '✗' : '✓'} <b>{event.text}</b><span className="dim">{data.durationMs != null ? ` (${Math.round(data.durationMs)}ms)` : ''}</span>{data.preview ? <span className="mono dim preview"> {firstLine(data.preview)}</span> : null}</div>
    return <div className="log-line tool"><span className="ts">{time}</span> 🛠 <b>{event.text}</b></div>
  }
  if (event.kind === 'error') return <div className="log-line error"><span className="ts">{time}</span> ✗ {event.text}</div>
  if (event.kind === 'raw' && event.text) return <div className="log-line raw"><span className="ts">{time}</span> · {event.text}</div>
  return null
}

export function TurnTimeline({ task, turns, activeNav, onNavigate, onRewind, logRef, onScroll }: { task: Task; turns: Turn[]; activeNav: number; onNavigate: (index: number) => void; onRewind: (index: number) => void; logRef: RefObject<HTMLDivElement>; onScroll: () => void }) {
  const active = task.status === 'running'
  return (
    <div className="chat-wrap">
      <TurnMinimap turns={turns} activeNav={activeNav} onNavigate={onNavigate} />
      <div className="log chat" ref={logRef} onScroll={onScroll}>
        {turns.map((turn, index) => {
          const streaming = index === turns.length - 1 && active
          const pending = index === turns.length - 1 && task.status === 'queued'
          const lastItem = turn.items[turn.items.length - 1]
          const endsWithOpenText = lastItem?.type === 'text' && !lastItem.closed
          const finalIndex = turn.items.findIndex((item) => item.type === 'final')
          let lastBubbleIndex = -1
          let lastWorkIndex = -1
          turn.items.forEach((item, itemIndex) => { if (item.type === 'work') lastWorkIndex = itemIndex; else lastBubbleIndex = itemIndex })
          return <div className="turn" id={`turn-${index}`} key={index}>
            {turn.userText != null && <div className="bubble user"><pre>{turn.userText}</pre>{index > 0 && <button className="turn-rewind" type="button" title="回退到这里" onClick={() => onRewind(index)}><Undo2 size={12} aria-hidden="true" /></button>}</div>}
            {turn.sysNotes.length > 0 && <div className="sys-strip">{turn.sysNotes.map((note, noteIndex) => <div key={noteIndex} className="sys-note">⚡ {note}</div>)}</div>}
            {turn.items.map((item, itemIndex) => {
              if (item.type === 'work') return <details className="worklog" key={itemIndex} open={streaming && itemIndex === lastWorkIndex ? true : undefined}><summary>🔧 工作过程（{item.work.filter((event) => event.kind === 'tool').length} 次工具调用）<ToolChips work={item.work} /></summary><div className="worklog-body">{item.work.map((event) => <LogLine key={event.seq} event={event} />)}</div></details>
              if (item.type === 'final') return <div className="bubble agent" key={itemIndex}><Markdown text={item.text} />{turn.usage && <UsageBadge usage={turn.usage} />}</div>
              return <div className="bubble agent" key={itemIndex}>{item.closed ? <Markdown text={item.text} /> : <pre className="streaming">{renderStreamingMarkers(item.text)}</pre>}{streaming && !item.closed && <div className="log-running"><span className="dots"><i /><i /><i /></span>回复中…</div>}{turn.usage && finalIndex < 0 && itemIndex === lastBubbleIndex && <UsageBadge usage={turn.usage} />}</div>
            })}
            {streaming && !endsWithOpenText && finalIndex < 0 && <div className="bubble agent"><div className="log-running"><span className="dots"><i /><i /><i /></span>回复中…</div></div>}
            {pending && <div className="bubble agent"><div className="log-running"><span className="dots"><i /><i /><i /></span>排队等待执行…</div></div>}
          </div>
        })}
        {turns.length === 0 && <div className="list-empty">（无对话内容）</div>}
      </div>
    </div>
  )
}
