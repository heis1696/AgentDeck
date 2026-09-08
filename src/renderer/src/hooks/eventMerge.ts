import type { TaskEvent } from '../../../shared/types'

/** Merge persisted and live events by sequence, preserving deterministic order. */
export function mergeTaskEvents(current: TaskEvent[], incoming: TaskEvent[]): TaskEvent[] {
  if (incoming.length === 0) return current
  const bySeq = new Map<number, TaskEvent>()
  for (const event of current) bySeq.set(event.seq, event)
  for (const event of incoming) bySeq.set(event.seq, event)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}
