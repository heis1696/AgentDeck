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
  private cleanups = new Map<symbol, { key?: string; action: () => Promise<void>; promise: Promise<void>; failed: boolean }>()

  registerCleanup(key: string | undefined, action: () => Promise<void>): Promise<void> {
    const id = Symbol()
    const entry = { key, action, promise: Promise.resolve().then(action), failed: false }
    this.cleanups.set(id, entry)
    this.observeCleanup(id, entry)
    return entry.promise
  }

  private observeCleanup(id: symbol, entry: { key?: string; action: () => Promise<void>; promise: Promise<void>; failed: boolean }) {
    void entry.promise.then(() => {
      if (this.cleanups.get(id) === entry) this.cleanups.delete(id)
    }, () => { entry.failed = true })
  }

  private closeLateSession(starting: Promise<BackendSession>, key?: string): Promise<void> {
    return this.registerCleanup(key, () => starting.then(async (session) => {
      const result: unknown = await session.close()
      if (result === false || result && typeof result === 'object' && (result as { ok?: unknown }).ok === false) {
        throw new Error('晚到会话关闭未确认')
      }
    }, () => {}))
  }

  async start(
    start: () => Promise<BackendSession>,
    timeout: Promise<BackendTurnResult>,
    accept: () => boolean,
    key?: string
  ): Promise<BackendSession> {
    if (!accept()) throw new Error('Task execution was cancelled')
    const starting = start()
    const outcome = await Promise.race([
      starting.then((session) => ({ session })),
      timeout.then((error) => ({ error }))
    ])
    if ('error' in outcome) {
      this.closeLateSession(starting, key)
      throw new Error(outcome.error.error || '回合失败')
    }
    if (!accept()) {
      await settleWithin(this.closeLateSession(Promise.resolve(outcome.session), key), 2_000)
      throw new Error('Task execution was cancelled')
    }
    return outcome.session
  }

  /** Wait for sessions that resolved after an abandoned start race. */
  async drain(key?: string): Promise<void> {
    const pending: Promise<void>[] = []
    for (const [id, entry] of this.cleanups) {
      if (key !== undefined && entry.key !== key) continue
      if (entry.failed) {
        entry.failed = false
        entry.promise = Promise.resolve().then(entry.action)
        this.observeCleanup(id, entry)
      }
      pending.push(entry.promise)
    }
    const results = await Promise.allSettled(pending)
    const failures = results.flatMap((result) => result.status === 'rejected' ? [String(result.reason)] : [])
    if (failures.length) throw new Error(failures.join('；'))
  }

  isIdle() { return this.cleanups.size === 0 }

  async shutdown() {
    await settleWithin(this.drain(), 2_000)
  }
}
