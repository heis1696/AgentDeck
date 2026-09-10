import type { BackendSession, BackendTurnResult } from './backends/types'

function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    promise.then(() => {
      clearTimeout(timer)
      resolve()
    }, () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/** Owns the start race and late-session cleanup shared by runner entry points. */
export class Executor {
  private cleanups = new Set<Promise<unknown>>()

  private async closeLateSession(session: BackendSession) {
    await settleWithin(Promise.resolve().then(() => session.close()), 2_000)
  }

  private trackCleanup(cleanup: Promise<unknown>) {
    this.cleanups.add(cleanup)
    void cleanup.finally(() => this.cleanups.delete(cleanup))
  }

  async start(
    start: () => Promise<BackendSession>,
    timeout: Promise<BackendTurnResult>,
    accept: () => boolean
  ): Promise<BackendSession> {
    const starting = start()
    const outcome = await Promise.race([
      starting.then((session) => ({ session })),
      timeout.then((error) => ({ error }))
    ])
    if ('error' in outcome) {
      const lateClose = starting.then(async (session) => {
        if (!accept()) await this.closeLateSession(session)
      }).catch(() => {})
      const cleanup = settleWithin(lateClose, 2_000)
      this.trackCleanup(cleanup)
      throw new Error(outcome.error.error || '回合失败')
    }
    if (!accept()) {
      await outcome.session.close().catch(() => {})
      throw new Error('Task execution was cancelled')
    }
    return outcome.session
  }

  /** Wait for sessions that resolved after an abandoned start race. */
  async shutdown() {
    await Promise.allSettled([...this.cleanups])
  }
}
