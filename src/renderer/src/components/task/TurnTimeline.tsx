import { ArrowDown, ChevronDown, Copy, Search, Undo2, X, ChevronUp } from 'lucide-react'
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { Markdown, renderStreamingMarkers } from '../Markdown'
import { bridge, fmtDuration, fmtTime } from '../../api'
import { PARKED_QUEUED_LABEL } from '../../labels'
import type { Task, TaskEvent } from '../../../../shared/types'
import type { Turn } from '../../hooks/turnModel'
import { classifyTool, navSummary } from '../../hooks/turnModel'
import { isComposingKey, ui, type DockEditMetadata } from '../../ui/interaction-center'

interface TimelineOptions {
  taskId: string
  dockRootId?: string
  snapshotOnly: boolean
}

const TimelineOptionsContext = createContext<TimelineOptions>({ taskId: '', snapshotOnly: false })
/** 贴底阈值：与宿主 activeNav 判定同源，滚动只剩不到一行半就算「跟随最新」 */
export const FOLLOW_EPSILON = 40

function EditBadge({ edit, seq }: { edit: DockEditMetadata; seq: number }) {
  const { taskId, dockRootId, snapshotOnly } = useContext(TimelineOptionsContext)
  if (!edit || typeof edit.file !== 'string' || !edit.file) return null
  const name = edit.file.split(/[\\/]/).pop() || edit.file
  const dockId = `file:${taskId}:${seq}:${edit.file}`
  const open = () => {
    const payload = {
      ...edit,
      taskId,
      diffNote: snapshotOnly ? '历史执行：仅显示工具参数快照，未读取当前工作区改动' : '工具入参快照，正在读取 git 改动…'
    }
    const item = { id: dockId, kind: 'file' as const, title: name, payload }
    const handle = dockRootId ? ui.dock.open(item, { rootId: dockRootId }) : ui.dock.open(item)
    if (snapshotOnly) return
    void bridge.tasks.fileDiff(taskId, edit.file).then((r) => {
      if (!r) { ui.dock.update(handle, { payload: { diffNote: 'git diff 未返回数据，当前为工具入参快照' } }); return }
      const patch = r.ok
        ? r.diff
          ? { diff: r.diff, additions: r.additions ?? edit.additions, deletions: r.deletions ?? edit.deletions, binary: r.binary, diffNote: r.binary ? '二进制文件，仅统计' : 'git 未提交 diff（工作区 + 暂存）' }
          : { diffNote: `git 显示无未提交改动（${r.note ?? 'clean'}）——回退为工具入参快照` }
        : { diffNote: `git diff 不可用（${r.error ?? r.code ?? '失败'}）——回退为工具入参快照` }
      ui.dock.update(handle, { payload: patch })
    }).catch((cause) => { ui.dock.update(handle, { payload: { diffNote: `git diff 读取失败：${cause instanceof Error ? cause.message : String(cause)}；当前为工具入参快照` } }) })
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

/** worklog 行上限：头尾留窗 + 中段折叠。运行中展开的也是「尾部活动区」，
 *  完成后自动收起（details 本身）；「显示全部」是用户的否决权，点开后不再折叠。 */
const WORKLOG_HEAD = 12
const WORKLOG_TAIL = 40
function WorkLog({ work, autoOpen }: { work: TaskEvent[]; autoOpen: boolean }) {
  const [showAll, setShowAll] = useState(false)
  const total = work.length
  const capped = !showAll && total > WORKLOG_HEAD + WORKLOG_TAIL + 12
  const omitted = capped ? total - WORKLOG_HEAD - WORKLOG_TAIL : 0
  const head = capped ? work.slice(0, WORKLOG_HEAD) : []
  const tail = capped ? work.slice(total - WORKLOG_TAIL) : work
  return <details className="worklog" open={autoOpen ? true : undefined}>
    <summary>🔧 工作过程（{work.filter((event) => event.kind === 'tool').length} 次工具调用）<ToolChips work={work} /></summary>
    <div className="worklog-body">
      {capped ? <>
        {head.map((event) => <LogLine key={event.seq} event={event} />)}
        <div className="worklog-omitted"><button type="button" className="worklog-expand" onClick={() => setShowAll(true)}>⋯ 已折叠 {omitted} 行（长回合防卡顿）· 点开显示全部</button></div>
        {tail.map((event) => <LogLine key={event.seq} event={event} />)}
      </> : work.map((event) => <LogLine key={event.seq} event={event} />)}
    </div>
  </details>
}

/** 回合窗口：默认只渲染最近 WINDOW_STEP 个回合，向上渐进加载（长会话万级事件不再全量渲染）。
 *  「历史/实时分离」：运行中回合永远在窗口内（窗口从末尾数起），流式追加不触碰未渲染的旧回合。 */
const WINDOW_STEP = 30

/** 回合可检索文本：用户输入 + 回复正文 + 工具名（长会话里「刚才哪轮说了 XX」的查找面） */
function turnSearchText(turn: Turn): string {
  const parts: string[] = []
  if (turn.userText != null) parts.push(turn.userText)
  for (const item of turn.items) {
    if (item.type === 'final' || item.type === 'text') parts.push(item.text)
    else for (const event of item.work) if (event.text) parts.push(event.text)
  }
  return parts.join('\n')
}

/**
 * 执行记录（回合时间线）：
 * - 每个回合有极简页眉（#序号 + 起始时间 + 状态），长会话里随时知道「读到第几问」；
 * - 用户气泡吸顶：滚长回复时问题不丢，读完能立刻对回上下文；
 * - 气泡右上角悬浮「复制」；工作过程摘要补上工具总耗时；
 * - 「贴底跟随」是**宿主受控状态**（审查项 2）：following / onFollowLatest 由宿主传入，
 *   宿主在滚动与流式事件到达时更新它——本组件只是视图，不再自己算一份（否则两套判定会打架）。
 * - 回合窗口化：只渲染最近 WINDOW_STEP 个回合；.turn 带 data-turn-idx（全局索引），
 *   宿主 activeNav 判定以它为准；跳到未渲染回合先扩窗再走宿主 onNavigate。
 */
export function TurnTimeline({ task, turns, activeNav, following, onFollowLatest, onNavigate, onRewind, logRef, onScroll, dockRootId, snapshotOnly = false, contextLabel }: { task: Task; turns: Turn[]; activeNav: number; following: boolean; onFollowLatest: () => void; onNavigate: (index: number) => void; onRewind: (index: number) => void; logRef: RefObject<HTMLDivElement>; onScroll: () => void; dockRootId?: string; snapshotOnly?: boolean; contextLabel?: string }) {
  const active = !snapshotOnly && task.status === 'running'
  const [visibleCount, setVisibleCount] = useState(WINDOW_STEP)
  // 切任务/换会话重置窗口：新会话从最近回合起步
  useEffect(() => { setVisibleCount(WINDOW_STEP) }, [task.id])
  const firstVisible = Math.max(0, turns.length - visibleCount)
  const hiddenBefore = firstVisible
  const sentinelRef = useRef<HTMLDivElement>(null)
  // 跳到未渲染回合：先扩窗，等 DOM 出现后再把全局索引交给宿主滚动
  const pendingNavRef = useRef<number | null>(null)
  const onNavigateRef = useRef(onNavigate)
  onNavigateRef.current = onNavigate
  useLayoutEffect(() => {
    const index = pendingNavRef.current
    if (index == null) return
    if (logRef.current?.querySelector(`#turn-${index}`)) {
      pendingNavRef.current = null
      onNavigateRef.current(index)
    }
  }, [visibleCount, turns.length])
  const navigateTo = (index: number) => {
    if (index < firstVisible) {
      pendingNavRef.current = index
      setVisibleCount(turns.length - index + 4) // 目标回合上下各留余量
      return // 滚动交给上面的 layout effect（DOM 就位后）
    }
    onNavigate(index)
  }
  // 接近顶部自动扩窗（IntersectionObserver 不可用的环境退化为只按按钮）
  useEffect(() => {
    if (hiddenBefore <= 0 || typeof IntersectionObserver === 'undefined') return
    const root = logRef.current
    const sentinel = sentinelRef.current
    if (!root || !sentinel) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) expandWindow()
    }, { root, rootMargin: '320px 0px 0px 0px' })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hiddenBefore, logRef])
  // 扩窗锚点恢复：按钮与观察器共用同一条路径——记录扩窗前内容高度，DOM 提交后把
  // 新增高度补回 scrollTop，阅读位置不动；哨兵随新增内容退到视口上方，观察器不会
  // 连环触发把历史一次全加载进来。锁保证一次扩窗未提交（锚点未恢复）前不再叠加触发。
  const expandAnchorRef = useRef<number | null>(null)
  const expandLockRef = useRef(false)
  useLayoutEffect(() => {
    if (expandAnchorRef.current == null) return
    const before = expandAnchorRef.current
    expandAnchorRef.current = null
    expandLockRef.current = false
    const el = logRef.current
    if (el) el.scrollTop += el.scrollHeight - before
  }, [visibleCount])
  const expandWindow = () => {
    if (expandLockRef.current) return
    expandLockRef.current = true
    expandAnchorRef.current = logRef.current?.scrollHeight ?? 0
    setVisibleCount((count) => count + WINDOW_STEP)
  }

  // 页内搜索（吸收 ZCode find 模式，回合级 MVP）：数据层匹配（不受窗口化影响），命中跳转走 navigateTo
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchPos, setSearchPos] = useState(-1)
  const searchMatches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return [] as number[]
    return turns.reduce<number[]>((acc, turn, index) => (turnSearchText(turn).toLowerCase().includes(q) ? (acc.push(index), acc) : acc), [])
  }, [turns, searchQuery])
  const gotoMatch = (delta: number) => {
    if (!searchMatches.length) return
    const next = searchPos < 0 ? (delta > 0 ? 0 : searchMatches.length - 1) : (searchPos + delta + searchMatches.length) % searchMatches.length
    setSearchPos(next)
    navigateTo(searchMatches[next])
  }

  return (
    <TimelineOptionsContext.Provider value={{ taskId: task.id, dockRootId, snapshotOnly }}><div className={`chat-wrap${following ? ' is-following' : ' is-reading'}`}>
      <TurnMinimap turns={turns} activeNav={activeNav} onNavigate={navigateTo} />
      <div
        className="log chat"
        ref={logRef}
        onScroll={onScroll}
        tabIndex={0}
        aria-label="执行记录（回合对话与工具调用）"
      >
        {hiddenBefore > 0 && <div className="log-more" ref={sentinelRef}>
          <button type="button" className="log-more-btn" onClick={expandWindow}>↑ 加载更早 {Math.min(WINDOW_STEP, hiddenBefore)} 回合 · 前面还有 {hiddenBefore} 回合</button>
        </div>}
        {/* 页内搜索：吸顶不随内容滚动；命中按回合计数，↑↓/Enter 循环跳转（数据层匹配，含未渲染回合） */}
        <div className="chat-search">
          {searchOpen && <div className="chat-search-bar" role="search">
            <input
              value={searchQuery}
              placeholder="在执行记录中查找…"
              aria-label="在执行记录中查找"
              onChange={(event) => { setSearchQuery(event.target.value); setSearchPos(-1) }}
              onKeyDown={(event) => {
                if (isComposingKey(event.nativeEvent)) return
                if (event.key === 'Enter') { event.preventDefault(); gotoMatch(event.shiftKey ? -1 : 1) }
                if (event.key === 'Escape') { event.preventDefault(); setSearchOpen(false) }
              }}
            />
            <span className="chat-search-count" aria-live="polite">{searchQuery.trim() ? (searchMatches.length ? `${searchPos < 0 ? '–' : searchPos + 1}/${searchMatches.length}` : '无匹配') : ''}</span>
            <button type="button" className="icon-btn" onClick={() => gotoMatch(-1)} disabled={!searchMatches.length} title="上一个匹配（Shift+Enter）" aria-label="上一个匹配"><ChevronUp size={12} aria-hidden="true" /></button>
            <button type="button" className="icon-btn" onClick={() => gotoMatch(1)} disabled={!searchMatches.length} title="下一个匹配（Enter）" aria-label="下一个匹配"><ChevronDown size={12} aria-hidden="true" /></button>
            <button type="button" className="icon-btn" onClick={() => setSearchOpen(false)} title="关闭搜索（Esc）" aria-label="关闭搜索"><X size={12} aria-hidden="true" /></button>
          </div>}
          {!searchOpen && <button type="button" className="icon-btn chat-search-trigger" onClick={() => setSearchOpen(true)} title="在执行记录中查找" aria-label="在执行记录中查找"><Search size={13} aria-hidden="true" /></button>}
        </div>
        {turns.slice(firstVisible).map((turn, offset) => {
          const index = firstVisible + offset
          const streaming = index === turns.length - 1 && active
          const pending = !snapshotOnly && index === turns.length - 1 && task.status === 'queued'
          const lastItem = turn.items[turn.items.length - 1]
          const endsWithOpenText = lastItem?.type === 'text' && !lastItem.closed
          const finalIndex = turn.items.findIndex((item) => item.type === 'final')
          const startedAt = turnTime(turn)
          let lastBubbleIndex = -1
          let lastWorkIndex = -1
          turn.items.forEach((item, itemIndex) => { if (item.type === 'work') lastWorkIndex = itemIndex; else lastBubbleIndex = itemIndex })
          // key 带任务身份：切任务时回合子树整体重挂，worklog「显示全部」等本地状态
          // 不跨任务继承（否则 A 展开的第 70 回合会把 B 的第 70 回合也顶成全量渲染）
          return <div className="turn" id={`turn-${index}`} data-turn-idx={index} key={`${task.id}:${index}`}>
            <div className="turn-head">
              <span className="turn-index">{snapshotOnly && contextLabel ? contextLabel : `#${index + 1}`}</span>
              {startedAt > 0 && <time className="turn-time" title={fmtTime(startedAt)}>{fmtTime(startedAt)}</time>}
              <span className={`turn-state${turn.done ? ' is-done' : streaming || pending ? ' is-live' : ''}`}>
                {turn.done ? '已完成' : streaming ? '回复中' : pending ? (task.parked ? PARKED_QUEUED_LABEL : '排队中') : '—'}
              </span>
              {!snapshotOnly && index > 0 && <button className="turn-rewind-inline" type="button" title="回退到这里（删除本回合及其之后的记录）" onClick={() => onRewind(index)}><Undo2 size={12} aria-hidden="true" /> 回退</button>}
            </div>
            {turn.userText != null && <div className="bubble user"><pre>{turn.userText}</pre><BubbleTools text={turn.userText} label="提问" /></div>}
            {turn.sysNotes.length > 0 && <div className="sys-strip">{turn.sysNotes.map((note, noteIndex) => <div key={noteIndex} className="sys-note">⚡ {note}</div>)}</div>}
            {turn.items.map((item, itemIndex) => {
              if (item.type === 'work') return <WorkLog key={itemIndex} work={item.work} autoOpen={streaming && itemIndex === lastWorkIndex} />
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
    </div></TimelineOptionsContext.Provider>
  )
}
