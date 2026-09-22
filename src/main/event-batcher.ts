/**
 * Buffers synchronous provider callbacks behind a bounded persistence cadence.
 * Failed commits retain the same event objects and retry with backoff, allowing
 * callers to assign stable identities once and make retries idempotent.
 */
export interface BoundedEventBatcherOptions<T> {
  maxDelayMs: number
  maxRetryDelayMs?: number
  maxItems: number
  maxBytes: number
  sizeOf: (event: T) => number
  canMerge?: (previous: T, next: T) => boolean
  merge?: (previous: T, next: T) => T
  onFlush: (events: readonly T[]) => boolean
  onRetry?: (attempt: number, delayMs: number) => void
}

export class BoundedEventBatcher<T> {
  private pending: T[] = []
  private pendingBytes = 0
  private pendingItems = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private accepting = true
  private closed = false
  private retryAttempt = 0
  private drainWaiters: Array<(committed: boolean) => void> = []

  constructor(private readonly options: BoundedEventBatcherOptions<T>) {}

  add(event: T): boolean {
    if (!this.accepting) return false
    const eventBytes = this.options.sizeOf(event)

    // Keep a healthy batch within its configured serialized-byte boundary.
    // During an IO outage the failed batch must be retained, so new events are
    // allowed to join it without repeatedly forcing synchronous writes.
    if (this.retryAttempt === 0 && this.pending.length > 0
      && (this.pendingItems >= this.options.maxItems || this.pendingBytes + eventBytes > this.options.maxBytes)) {
      this.flush()
    }

    const last = this.pending.at(-1)
    if (last && this.options.canMerge?.(last, event) && this.options.merge) {
      this.pending[this.pending.length - 1] = this.options.merge(last, event)
    } else {
      this.pending.push(event)
    }
    // Thresholds count provider inputs, not the number left after coalescing.
    this.pendingItems += 1
    this.pendingBytes += eventBytes

    if (this.retryAttempt > 0) {
      this.scheduleRetry()
    } else if (this.pendingItems >= this.options.maxItems || this.pendingBytes >= this.options.maxBytes) {
      this.flush()
    } else {
      this.schedule(this.options.maxDelayMs)
    }
    return true
  }

  /** Attempt a synchronous commit. Failure retains the batch for retry. */
  flush(): boolean {
    this.clearTimer()
    if (!this.pending.length) {
      this.finishDrain(true)
      return true
    }
    let committed = false
    try {
      committed = this.options.onFlush(this.pending)
    } catch {
      committed = false
    }
    if (!committed) {
      this.retryAttempt += 1
      this.scheduleRetry()
      return false
    }
    this.pending = []
    this.pendingBytes = 0
    this.pendingItems = 0
    this.retryAttempt = 0
    this.finishDrain(true)
    return true
  }

  /** Stop accepting new events and resolve once all accepted events commit. */
  close(): Promise<boolean> {
    this.accepting = false
    if (this.closed) return Promise.resolve(true)
    if (this.flush()) return Promise.resolve(true)
    return new Promise((resolve) => this.drainWaiters.push(resolve))
  }

  /** Stop retries and release memory. Pending events are reported as uncommitted. */
  dispose(): void {
    this.clearTimer()
    this.accepting = false
    this.closed = true
    this.pending = []
    this.pendingBytes = 0
    this.pendingItems = 0
    this.retryAttempt = 0
    this.finishDrain(false)
  }

  get pendingCount(): number {
    return this.pendingItems
  }

  get hasPending(): boolean {
    return this.pending.length > 0
  }

  private retryDelay(): number {
    const cap = Math.max(this.options.maxDelayMs, this.options.maxRetryDelayMs ?? 5_000)
    return Math.min(this.options.maxDelayMs * (2 ** Math.max(0, this.retryAttempt - 1)), cap)
  }

  private scheduleRetry() {
    if (this.timer || this.closed || !this.pending.length) return
    const delay = this.retryDelay()
    this.options.onRetry?.(this.retryAttempt, delay)
    this.schedule(delay)
  }

  private schedule(delayMs: number) {
    if (this.timer || this.closed) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, delayMs)
    this.timer.unref?.()
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  private finishDrain(committed: boolean) {
    if (committed && !this.accepting && !this.pending.length) this.closed = true
    if (!this.closed) return
    const waiters = this.drainWaiters
    this.drainWaiters = []
    for (const resolve of waiters) resolve(committed)
  }
}
