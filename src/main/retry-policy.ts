import type { FailureInfo, Task } from '../shared/types'

export interface RetryDecision {
  retry: boolean
  attempt: number
  freshSession: boolean
  delayMs: number
}

const DEFAULT_MAX_ATTEMPTS = 2
const retryBackoffMs = () => {
  const value = Number(process.env.AGENTDECK_RETRY_DELAY_MS)
  return Number.isFinite(value) && value >= 0 ? value : 60_000
}

/** Pure retry semantics. Scheduling and persistence remain owned by TaskRunner. */
export function decideRetry(task: Pick<Task, 'attempt' | 'sessionId' | 'backend'>, failure?: FailureInfo, maxAttempts = DEFAULT_MAX_ATTEMPTS): RetryDecision {
  const attempt = task.attempt ?? 0
  if (!failure?.retryable || attempt >= maxAttempts) return { retry: false, attempt, freshSession: false, delayMs: 0 }
  const next = attempt + 1
  return {
    retry: true,
    attempt: next,
    freshSession: next >= maxAttempts || !task.sessionId || task.backend === 'dsh',
    delayMs: failure.code === 'rate_limit' ? retryBackoffMs() : 0
  }
}
