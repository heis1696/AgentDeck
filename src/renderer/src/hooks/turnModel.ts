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
      const replay = finalText !== '' && finalText === squashText(turn.streamed)
      const last = turn.items[turn.items.length - 1]
      // A backend may emit the streamed response, tool events, and then the
      // same response again as its final payload. Promote the existing text
      // bubble wherever it lives so the timeline has one canonical final.
      const matchingText = replay
        ? turn.items.findIndex((item) => item.type === 'text' && squashText(item.text) === finalText)
        : -1
      if (matchingText >= 0) {
        const item = turn.items[matchingText]
        if (item.type === 'text') turn.items[matchingText] = { type: 'final', text: item.text }
      } else if (last?.type === 'text' && !last.closed) {
        turn.items[turn.items.length - 1] = { type: 'final', text: replay ? last.text : event.text ?? '' }
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
