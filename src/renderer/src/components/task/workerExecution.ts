import { isTaskStatus, type TaskEvent, type TaskStatus } from '../../../../shared/types'

export interface WorkerExecution {
  runId: string
  turnId?: string
  contextLabel?: string
  status?: TaskStatus
  startedAt?: number
  endedAt?: number
  error?: string
}

export interface WorkerExecutionView {
  locatable: boolean
  events: TaskEvent[]
  missingAssociationCount: number
  status?: TaskStatus
  startedAt?: number
  endedAt?: number
  lastEventAt?: number
  error?: string
}

function hasExecutionIdentity(execution: WorkerExecution | undefined): execution is WorkerExecution {
  return typeof execution?.runId === 'string' && execution.runId.trim().length > 0
    && (execution.turnId === undefined || (typeof execution.turnId === 'string' && execution.turnId.trim().length > 0))
}

function hasStampedIdentity(value: unknown): value is { runId: string; turnId: string } {
  if (!value || typeof value !== 'object') return false
  const identity = value as { runId?: unknown; turnId?: unknown }
  return typeof identity.runId === 'string' && identity.runId.trim().length > 0
    && typeof identity.turnId === 'string' && identity.turnId.trim().length > 0
}

function isHostBatchIdentity(event: TaskEvent): boolean {
  return typeof event.eventId === 'string' && /^agentdeck:batch:.+:\d+$/.test(event.eventId)
}

function isInExecution(event: TaskEvent, execution: WorkerExecution): boolean {
  if (event.execution !== undefined) {
    if (!hasStampedIdentity(event.execution)) return false
    return event.execution.runId === execution.runId
      && (execution.turnId === undefined || event.execution.turnId === execution.turnId)
  }
  if (!execution.turnId || !isHostBatchIdentity(event)) return false
  const prefix = `agentdeck:batch:${execution.turnId}:`
  return event.eventId!.startsWith(prefix) && /^\d+$/.test(event.eventId!.slice(prefix.length))
}

function isUnattributed(event: TaskEvent, execution: WorkerExecution): boolean {
  if (event.execution !== undefined) return !hasStampedIdentity(event.execution)
  if (!isHostBatchIdentity(event)) return true
  return execution.turnId === undefined
}

export function filterWorkerExecutionEvents(events: TaskEvent[], execution: WorkerExecution | undefined): TaskEvent[] {
  if (!hasExecutionIdentity(execution)) return []
  return events.filter((event) => isInExecution(event, execution))
}

export function resolveWorkerExecution(events: TaskEvent[], execution: WorkerExecution | undefined): WorkerExecutionView {
  if (!hasExecutionIdentity(execution)) {
    return { locatable: false, events: [], missingAssociationCount: 0 }
  }

  const selected = events.filter((event) => isInExecution(event, execution))
  const missingAssociationCount = events.filter((event) => isUnattributed(event, execution)).length
  const ordered = [...selected].sort((left, right) => left.seq - right.seq || left.ts - right.ts)
  let observedStatus: TaskStatus | undefined
  let latestOutcome: TaskEvent | undefined
  for (const event of ordered) {
    if (event.kind === 'status' && event.data && typeof event.data === 'object') {
      const status = (event.data as { status?: unknown }).status
      if (isTaskStatus(status)) {
        observedStatus = status
        latestOutcome = event
      }
    } else if (event.kind === 'final') {
      observedStatus = 'done'
      latestOutcome = event
    } else if (event.kind === 'error') {
      observedStatus = 'failed'
      latestOutcome = event
    }
  }

  const timestamps = selected.map((event) => event.ts).filter(Number.isFinite)
  const startedAt = execution.startedAt ?? (execution.turnId && timestamps.length ? Math.min(...timestamps) : undefined)
  const lastEventAt = timestamps.length ? Math.max(...timestamps) : undefined
  const status = execution.status ?? (execution.turnId ? observedStatus : undefined)
  const endedAt = execution.endedAt ?? (execution.turnId && status && status !== 'running' && status !== 'queued' ? latestOutcome?.ts : undefined)
  const observedError = execution.turnId && latestOutcome?.kind === 'error' ? latestOutcome.text : undefined

  return {
    locatable: true,
    events: selected,
    missingAssociationCount,
    status,
    startedAt,
    endedAt,
    lastEventAt,
    error: execution.error || observedError || undefined
  }
}
