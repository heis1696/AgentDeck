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
  onPending?: (events: readonly T[]) => boolean
  maxPendingBytes?: number
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
    if (this.retryAttempt > 0 && this.options.maxPendingBytes !== undefined
      && this.pendingBytes + eventBytes > this.options.maxPendingBytes) return false
    const previous = this.retryAttempt > 0 ? [...this.pending] : undefined
    const previousItems = this.pendingItems
    const previousBytes = this.pendingBytes

    const last = this.pending.at(-1)
    // 合并进的片段不新增待保护集合（内容长在队尾元素上，其权威文本由不可合并的
    // 终态事件重新陈述），是否增长决定正常路径要不要补一道恢复边界。
    const grewPending = !(last && this.options.canMerge?.(last, event) && this.options.merge)
    if (grewPending) this.pending.push(event)
    else this.pending[this.pending.length - 1] = this.options.merge!(last!, event)
    // Thresholds count provider inputs, not the number left after coalescing.
    this.pendingItems += 1
    this.pendingBytes += eventBytes

    if (this.retryAttempt > 0) {
      let protectedPending = true
      try { protectedPending = this.options.onPending?.(this.pending) ?? true }
      catch { protectedPending = false }
      if (!protectedPending) {
        this.pending = previous!
        this.pendingItems = previousItems
        this.pendingBytes = previousBytes
        return false
      }
      this.scheduleRetry()
    } else if (this.pendingItems >= this.options.maxItems || this.pendingBytes >= this.options.maxBytes) {
      this.flush()
    } else {
      // 接受即恢复边界（正常路径）：凡让批次集合增长的接受同步过一次 onPending，
      // 批次定时器到期前的硬崩溃不再丢失已接受事件——原先这道保护只在 flush 失败
      // 后（retryAttempt > 0）生效，接受与首次落盘之间存在最长 maxDelayMs 的纯内存
      // 崩溃窗。合并进的流式片段不逐条落盘（见 grewPending），其暴露窗仍由批次周期
      // 与 flush 前的 stagePending 兜住；这保住了「同步持久化不进每 token 热路径」的
      // 既有设计。保护写入失败按 best-effort 处理不拒收：硬失败语义归 flush 路径
      // （双写失败的具名终态文案契约在 onFlush 里，此处拒收会改写验收固化的行为）。
      if (grewPending) {
        try { this.options.onPending?.(this.pending) } catch { /* flush 路径统一报 */ }
      }
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
  close(timeoutMs?: number): Promise<boolean> {
    this.accepting = false
    if (this.closed) return Promise.resolve(!this.pending.length)
    if (this.flush()) return Promise.resolve(true)
    return new Promise((resolve) => {
      let timeout: ReturnType<typeof setTimeout> | undefined
      this.drainWaiters.push((committed) => { if (timeout) clearTimeout(timeout); resolve(committed) })
      if (timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          this.clearTimer()
          this.closed = true
          this.finishDrain(false)
        }, timeoutMs)
        timeout.unref?.()
      }
    })
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
