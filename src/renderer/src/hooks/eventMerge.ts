import type { TaskEvent } from '../../../shared/types'

/** Merge persisted and live events by sequence, preserving deterministic order. */
export function mergeTaskEvents(current: TaskEvent[], incoming: TaskEvent[]): TaskEvent[] {
  if (incoming.length === 0) return current
  if (orderedUnique(current) && orderedUnique(incoming)) {
    if (!current.length || incoming[0].seq > current[current.length - 1].seq) return current.concat(incoming)
    if (incoming.length === 1) {
      const event = incoming[0]
      let low = 0
      let high = current.length
      while (low < high) {
        const mid = (low + high) >>> 1
        if (current[mid].seq < event.seq) low = mid + 1
        else high = mid
      }
      if (current[low] === event) return current
      const next = current.slice()
      if (next[low]?.seq === event.seq) next[low] = event
      else next.splice(low, 0, event)
      return next
    }
    const next: TaskEvent[] = []
    let i = 0
    let j = 0
    while (i < current.length && j < incoming.length) {
      if (current[i].seq < incoming[j].seq) next.push(current[i++])
      else {
        if (current[i].seq === incoming[j].seq) i++
        next.push(incoming[j++])
      }
    }
    while (i < current.length) next.push(current[i++])
    while (j < incoming.length) next.push(incoming[j++])
    return next
  }
  // Snapshots and replay batches may be unordered or contain duplicate sequences.
  const bySeq = new Map<number, TaskEvent>()
  for (const event of current) bySeq.set(event.seq, event)
  for (const event of incoming) bySeq.set(event.seq, event)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

function orderedUnique(events: TaskEvent[]): boolean {
  for (let i = 1; i < events.length; i++) if (events[i - 1].seq >= events[i].seq) return false
  return true
}
