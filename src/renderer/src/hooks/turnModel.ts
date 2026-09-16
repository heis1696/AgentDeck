import { useMemo } from 'react'
import type { Task, TaskEvent } from '../../../shared/types'

export type TurnItem =
  | { type: 'text'; text: string; closed: boolean }
  | { type: 'final'; text: string }
  | { type: 'work'; work: TaskEvent[] }

export interface Turn {
  userText: string | null
  firstSeq: number
  items: TurnItem[]
  sysNotes: string[]
  usage: Record<string, unknown> | null
  done: boolean
  streamed: string
}

const SYS_NOTE_RE = /(第\s*\d+\s*轮|拒绝派给|未找到可驱使|自动重试|不再下派|回灌|集成)/
const squashText = (value: string) => value.replace(/\s+/g, ' ').trim()

// 与 delegate.ts / Markdown.tsx 同规则的真实派单标记（开标签须带 to 才匹配）
const DELEGATE_BLOCK_RE = /<delegate\b(?=[^>]*\bto\s*=)([^>]*)>([\s\S]*?)<\/delegate>/g
const DELEGATE_TO_ATTR_RE = /\bto\s*=\s*"([^"]*)"/

/**
 * 终态只含最后一条 assistant 消息的协议（zcode 语义）下，吸收流式阶段已展示的正文碎片。
 * 流式中的文本气泡会被中途插入的非工具工作项（如派单接单的 ⚡ status note、错误）切开：
 * 终态只转正末尾碎片时，之前的碎片残留为重复残影，同一回复就显示了两遍。
 * 从队尾回溯收集文本碎片，可越过不含工具调用的工作项（与后端 lastSegment 只在工具
 * 活动时重置的边界语义一致，含工具的工作项才是消息分界）；终态空白不敏感地包含碎片
 * 拼接时，把它们整体替换为插在首碎片位置的单一终态气泡。返回是否发生了替换。
 */
function absorbFinalFragments(turn: Turn, finalText: string, compact: (value: string) => string): boolean {
  const fullFinal = compact(finalText)
  if (!fullFinal) return false
  const texts: string[] = []
  let first = -1
  for (let i = turn.items.length - 1; i >= 0; i--) {
    const item = turn.items[i]
    if (item.type === 'text') {
      texts.unshift(item.text)
      first = i
      continue
    }
    if (item.type === 'work' && !item.work.some((workEvent) => workEvent.kind === 'tool')) continue
    break
  }
  if (first < 0) return false
  const merged = compact(texts.join(''))
  if (!merged || !fullFinal.includes(merged)) return false
  const items = turn.items.filter((item, index) => !(index >= first && item.type === 'text'))
  items.splice(first, 0, { type: 'final', text: finalText })
  turn.items = items
  return true
}

/**
 * 领队在回灌评估/总结回合里复述旧派单标记时（主进程按 to+指令 去重、只执行一次），
 * 展示层若把每次复述都卡片化，看起来就像派了多单。按同款 key 跨回合去重：
 * 首次出现保留卡片，之后重复的整段剥掉、只留周围正文，展示与执行语义对齐。
 */
function dedupeDelegateCards(turns: Turn[]) {
  const seen = new Set<string>()
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.type === 'work' || !item.text.includes('<delegate')) continue
      item.text = item.text.replace(DELEGATE_BLOCK_RE, (whole: string, attrs: string, prompt: string) => {
        const key = `${attrs.match(DELEGATE_TO_ATTR_RE)?.[1] ?? ''}\n${prompt.trim()}`
        if (seen.has(key)) return ''
        seen.add(key)
        return whole
      })
    }
  }
}

export function buildTurns(events: TaskEvent[], prompt = ''): Turn[] {
  const list: Turn[] = []
  let current: Turn | null = null
  const open = (userText: string | null, firstSeq: number) => {
    current = { userText, firstSeq, items: [], sysNotes: [], usage: null, done: false, streamed: '' }
    list.push(current)
    return current
  }
  const closeText = (turn: Turn) => {
    const last = turn.items[turn.items.length - 1]
    if (last?.type === 'text' && !last.closed) last.closed = true
  }
  const pushWork = (turn: Turn, event: TaskEvent) => {
    closeText(turn)
    const last = turn.items[turn.items.length - 1]
    if (last?.type === 'work') last.work.push(event)
    else turn.items.push({ type: 'work', work: [event] })
  }
  for (const event of events) {
    if (event.kind === 'user') {
      open(event.text ?? '', event.seq)
      continue
    }
    let turn = current ?? open(null, event.seq)
    if ((event.kind === 'text' || event.kind === 'final') && turn.done) turn = open(null, event.seq)
    if (event.kind === 'text') {
      const last = turn.items[turn.items.length - 1]
      turn.streamed += event.text ?? ''
      if (last?.type === 'text' && !last.closed) last.text += event.text ?? ''
      else turn.items.push({ type: 'text', text: event.text ?? '', closed: false })
    } else if (event.kind === 'tool') {
      pushWork(turn, event)
    } else if (event.kind === 'final') {
      const finalText = squashText(event.text ?? '')
      const last = turn.items[turn.items.length - 1]
      // 终态全文与流式累计做空白不敏感的包含判断（与 zcode mergeTurnTexts 同规则）。
      // 流式累计被包含时（服务端流中途断流后终态补发全文，或终态原样重发），
      // 已流的文本气泡全是残影：整体收敛为单一终态气泡，避免「残影 + 终态」双份回复。
      const compact = (value: string) => value.replace(/\s+/g, '')
      const fullFinal = compact(event.text ?? '')
      const fullStreamed = compact(turn.streamed)
      if (fullFinal !== '' && fullStreamed !== '' && fullFinal.includes(fullStreamed)) {
        const firstBubble = turn.items.findIndex((item) => item.type !== 'work')
        const items: TurnItem[] = turn.items.filter((item) => item.type === 'work')
        items.splice(firstBubble >= 0 ? firstBubble : items.length, 0, { type: 'final', text: event.text ?? '' })
        turn.items = items
      } else if (absorbFinalFragments(turn, event.text ?? '', compact)) {
        // 终态已把流式碎片（含被 status 工作项切碎的多段）收敛为单一气泡
      } else if (last?.type === 'text' && !last.closed) {
        // 终态只含最后一条 assistant 消息（zcode 协议语义）：末尾开放气泡就地转正。
        // 空 final（zcode 以 response || error || '' 兜底发出）不能拿空终态抹掉
        // 已流式展示的正文——就地收口保留内容
        if (finalText) turn.items[turn.items.length - 1] = { type: 'final', text: event.text ?? '' }
        else last.closed = true
      } else if (finalText) {
        const duplicate = turn.items.some((item) => (item.type === 'text' || item.type === 'final') && squashText(item.text) === finalText)
        if (!duplicate) turn.items.push({ type: 'final', text: event.text ?? '' })
      }
      turn.done = true
    } else if (event.kind === 'usage') {
      turn.usage = { ...(turn.usage ?? {}), ...cleanUsage(event.data) }
    } else if (event.kind === 'status' && SYS_NOTE_RE.test(event.text ?? '')) {
      turn.sysNotes.push(event.text ?? '')
    } else {
      pushWork(turn, event)
    }
  }
  dedupeDelegateCards(list)
  if (list.length && list[0].userText == null) list[0].userText = prompt || null
  if (!list.length && prompt) list.push({ userText: prompt, firstSeq: 0, items: [], sysNotes: [], usage: null, done: false, streamed: '' })
  return list
}

export function useTurnModel(events: TaskEvent[], prompt: string) {
  return useMemo(() => buildTurns(events, prompt), [events, prompt])
}

export function navSummary(turn: Turn, index: number): string {
  const first = (turn.userText ?? '').split('\n')[0].trim()
  if (!first) return index === 0 ? '初始任务' : `回合 ${index + 1}`
  return first.length > 24 ? first.slice(0, 24) + '…' : first
}

export function cleanUsage(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== 'object') return {}
  return Object.fromEntries(Object.entries(data as Record<string, unknown>).filter(([, value]) => value !== undefined && value !== null && value !== ''))
}

export function classifyTool(name: string): 'reads' | 'commands' | 'edits' | 'other' {
  const normalized = name.toLowerCase()
  if (/^(read|grep|glob|ls|find|search|view|cat|notebookread)/.test(normalized)) return 'reads'
  if (/^(bash|shell|exec|run|terminal|command)/.test(normalized)) return 'commands'
  if (/^(edit|write|multiedit|notebookedit|applypatch|apply_patch|replace)/.test(normalized)) return 'edits'
  return 'other'
}
