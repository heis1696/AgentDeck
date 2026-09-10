import type { FailureInfo, Task } from '../shared/types'

export interface RetryDecision {
  retry: boolean
  attempt: number
  freshSession: boolean
  delayMs: number
}

const DEFAULT_MAX_ATTEMPTS = 2
/** 限流退避：测试 env 优先，否则用调用方注入的设置值（默认 60s） */
const retryBackoffMs = (configuredMs?: number) => {
  const env = Number(process.env.AGENTDECK_RETRY_DELAY_MS)
  if (Number.isFinite(env) && env >= 0) return env
  return configuredMs ?? 60_000
}

/** Pure retry semantics. Scheduling and persistence remain owned by TaskRunner. */
export function decideRetry(task: Pick<Task, 'attempt' | 'sessionId' | 'backend'>, failure?: FailureInfo, maxAttempts = DEFAULT_MAX_ATTEMPTS, backoffMs?: number): RetryDecision {
  const attempt = task.attempt ?? 0
  if (!failure?.retryable || attempt >= maxAttempts) return { retry: false, attempt, freshSession: false, delayMs: 0 }
  const next = attempt + 1
  return {
    retry: true,
    attempt: next,
    freshSession: next >= maxAttempts || !task.sessionId || task.backend === 'dsh',
    delayMs: failure.code === 'rate_limit' ? retryBackoffMs(backoffMs) : 0
  }
}
