import type { Task, TaskEvent } from '../../../../shared/types'
import type { Turn } from '../../hooks/turnModel'

export type WorkerRoundBucket = 'active' | 'queued' | 'parked' | 'ended'

export interface WorkerRound {
  id: string
  label: string
  firstSeq?: number
  startedAt?: number
  unclassified: boolean
  workers: Task[]
  active: Task[]
  queued: Task[]
  parked: Task[]
  ended: Task[]
}

export const UNCLASSIFIED_WORKER_ROUND_ID = 'unclassified'

function taskOrder(a: Task, b: Task): number {
  const aIndex = a.workerIndex ?? Number.MAX_SAFE_INTEGER
  const bIndex = b.workerIndex ?? Number.MAX_SAFE_INTEGER
  if (aIndex !== bIndex) return aIndex - bIndex
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
  return a.id.localeCompare(b.id)
}

function eventTimestamp(turn: Turn, events: ReadonlyMap<number, TaskEvent>): number | undefined {
  if (turn.firstSeq <= 0) return undefined
  const event = events.get(turn.firstSeq)
  return event && Number.isFinite(event.ts) && event.ts > 0 ? event.ts : undefined
}

function roundBucket(task: Task): WorkerRoundBucket {
  if (task.status === 'running') return 'active'
  if (task.status === 'queued') return task.parked ? 'parked' : 'queued'
  return 'ended'
}

function makeRound(id: string, label: string, details: Pick<WorkerRound, 'firstSeq' | 'startedAt' | 'unclassified'>): WorkerRound {
  return { id, label, ...details, workers: [], active: [], queued: [], parked: [], ended: [] }
}

/**
 * Associate child tasks with the same conversation turns shown in the leader
 * execution record. A missing or ambiguous timestamp is kept visible in an
 * explicit bucket instead of being inferred from workerIndex or status text.
 */
export function buildWorkerRounds(workers: Task[], turns: Turn[], events: TaskEvent[]): WorkerRound[] {
  const orderedWorkers = [...new Map(workers.map((worker) => [worker.id, worker])).values()].sort(taskOrder)
  const bySequence = new Map(events.map((event) => [event.seq, event] as const))
  const boundaries = turns.map((turn) => eventTimestamp(turn, bySequence))
  const known = boundaries.filter((timestamp): timestamp is number => timestamp !== undefined)
  const chronological = known.every((timestamp, index) => index === 0 || timestamp >= known[index - 1])

  const rounds = turns.map((turn, index) => makeRound(
    `turn-${turn.firstSeq}-${index}`,
    `回合 ${index + 1}`,
    { firstSeq: turn.firstSeq, startedAt: boundaries[index], unclassified: false }
  ))
  const unclassified = makeRound(UNCLASSIFIED_WORKER_ROUND_ID, '未分类记录', { unclassified: true })

  for (const worker of orderedWorkers) {
    const createdAt = Number.isFinite(worker.createdAt) && worker.createdAt > 0 ? worker.createdAt : undefined
    let round: WorkerRound | undefined
    if (createdAt !== undefined && chronological && boundaries.filter((timestamp) => timestamp === createdAt).length <= 1) {
      for (let index = boundaries.length - 1; index >= 0; index--) {
        const start = boundaries[index]
        const end = index === boundaries.length - 1 ? Infinity : boundaries[index + 1]
        // A missing next boundary makes this interval uncertain, not longer.
        if (start === undefined || end === undefined || end <= start) continue
        if (createdAt >= start && createdAt < end) { round = rounds[index]; break }
      }
    }
    const target = round ?? unclassified
    target.workers.push(worker)
    const bucket = roundBucket(worker)
    target[bucket].push(worker)
  }

  return [...rounds.filter((round) => round.workers.length > 0).reverse(), ...(unclassified.workers.length ? [unclassified] : [])]
}
