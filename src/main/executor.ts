import type { BackendSession, BackendTurnResult } from './backends/types'

/** Owns the start race and late-session cleanup shared by runner entry points. */
export class Executor {
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
      void starting.then(async (session) => {
        if (!accept()) await session.close().catch(() => {})
      }).catch(() => {})
      throw new Error(outcome.error.error || '回合失败')
    }
    if (!accept()) {
      await outcome.session.close().catch(() => {})
      throw new Error('Task execution was cancelled')
    }
    return outcome.session
  }
}
