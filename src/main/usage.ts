// 用量聚合：把 events 里的 usage 事件（各后端键名不一）归一累计成 TaskUsage
import type { TaskEvent, TaskUsage } from '../shared/types'

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

/** 多态键名取第一个命中的数值 */
function pick(d: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = num(d[k])
    if (v !== undefined) return v
  }
  return undefined
}

export function aggregateUsage(events: TaskEvent[]): TaskUsage | undefined {
  const out: TaskUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, durationMs: 0, turns: 0 }
  let any = false
  for (const e of events) {
    if (e.kind !== 'usage' || !e.data || typeof e.data !== 'object') continue
    const d = e.data as Record<string, unknown>
    const inp = pick(d, ['inputTokens', 'input_tokens', 'inputTokenCount', 'promptTokens', 'input_tokens_details'])
    const outp = pick(d, ['outputTokens', 'output_tokens', 'outputTokenCount', 'completionTokens'])
    const tot = pick(d, ['totalTokens', 'total_tokens', 'tokenCount'])
    const cost = pick(d, ['costUsd', 'cost_usd', 'costUSD', 'total_cost_usd'])
    const dur = pick(d, ['durationMs', 'duration_ms', 'elapsedMs'])
    if (inp === undefined && outp === undefined && tot === undefined && cost === undefined && dur === undefined) continue
    any = true
    if (inp !== undefined) out.inputTokens += inp
    if (outp !== undefined) out.outputTokens += outp
    if (tot !== undefined) out.totalTokens += tot
    if (cost !== undefined) out.costUsd += cost
    if (dur !== undefined) out.durationMs += dur
    out.turns++
  }
  return any ? out : undefined
}

/** 人类可读的 token 数（1234567 → 1.23M） */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}
