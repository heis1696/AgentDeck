import type { Agent } from './agents'
import type { AnalyticsSummary, ErrorAggregate, FailureInfo, Task, UsageAggregate } from '../shared/types'

const empty = (): UsageAggregate => ({ runs: 0, completed: 0, failed: 0, cancelled: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, durationMs: 0 })

function add(target: UsageAggregate, task: Task) {
  target.runs++
  if (task.status === 'done') target.completed++
  if (task.status === 'failed') target.failed++
  if (task.status === 'cancelled') target.cancelled++
  const usage = task.usage
  if (usage) {
    target.inputTokens += usage.inputTokens || 0
    target.outputTokens += usage.outputTokens || 0
    target.totalTokens += usage.totalTokens || (usage.inputTokens || 0) + (usage.outputTokens || 0)
    target.costUsd += usage.costUsd || 0
    target.durationMs += usage.durationMs || 0
  } else if (task.startedAt && task.endedAt) {
    target.durationMs += Math.max(0, task.endedAt - task.startedAt)
  }
}

/** Build a stable usage/error report from durable task snapshots. */
export function buildAnalytics(tasks: Task[], agents: Agent[] = [], since?: number, until = Date.now()): AnalyticsSummary {
  const selected = tasks.filter((task) => {
    const timestamp = task.endedAt ?? task.startedAt ?? task.createdAt
    return timestamp <= until && (since === undefined || timestamp >= since)
  })
  const totals = empty()
  const backend = new Map<string, UsageAggregate>()
  const agent = new Map<string, UsageAggregate>()
  const agentNames = new Map(agents.map((item) => [item.id, item.name]))
  const errors = new Map<string, ErrorAggregate>()
  for (const task of selected) {
    add(totals, task)
    if (!backend.has(task.backend)) backend.set(task.backend, empty())
    add(backend.get(task.backend)!, task)
    const agentKey = task.agentId ?? '__unassigned'
    if (!agent.has(agentKey)) agent.set(agentKey, empty())
    add(agent.get(agentKey)!, task)
    if (task.status === 'failed') {
      const failure = task.failure
      const code = failure?.code ?? 'unknown'
      const title = failure?.title ?? task.error ?? 'Agent execution error'
      const existing = errors.get(code)
      if (existing) {
        existing.count++
        existing.lastSeenAt = Math.max(existing.lastSeenAt ?? 0, task.endedAt ?? task.startedAt ?? task.createdAt)
      } else {
        errors.set(code, { code, title, count: 1, retryable: failure?.retryable ?? false, lastSeenAt: task.endedAt ?? task.startedAt ?? task.createdAt })
      }
    }
  }
  const toRows = (map: Map<string, UsageAggregate>, labels: Map<string, string>) => [...map.entries()]
    .map(([key, value]) => ({ key, label: labels.get(key) ?? key, ...value }))
    .sort((a, b) => b.runs - a.runs || b.costUsd - a.costUsd)
  return {
    ...(since === undefined ? {} : { since }),
    until,
    generatedAt: Date.now(),
    totals,
    byBackend: toRows(backend, new Map([...backend.keys()].map((key) => [key, key]))),
    byAgent: toRows(agent, agentNames),
    errors: [...errors.values()].sort((a, b) => b.count - a.count || (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))
  }
}

export type { FailureInfo }
