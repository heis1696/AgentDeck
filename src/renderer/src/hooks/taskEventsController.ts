import type { SidecarSnapshot } from '../../../shared/contracts'
import type { TaskEvent } from '../../../shared/types'
import { mergeTaskEvents } from './eventMerge'

export const TASK_EVENT_BATCH_DELAY_MS = 16
export const TASK_EVENT_BATCH_MAX_ITEMS = 64

export interface TaskEventsSource {
  readSnapshot: (taskId: string) => Promise<TaskEvent[]>
  onEvent: (callback: (taskId: string, event: TaskEvent) => void) => () => void
  onEventsInvalidated: (callback: (taskId: string) => void) => () => void
  onSidecarStatus: (callback: (status: SidecarSnapshot['status']) => void) => () => void
}

export interface TaskEventsScheduler {
  schedule: (callback: () => void, delayMs: number) => unknown
  cancel: (handle: unknown) => void
}

export interface TaskEventsControllerOptions {
  maxDelayMs?: number
  maxBatchItems?: number
  scheduler?: TaskEventsScheduler
}

const defaultScheduler: TaskEventsScheduler = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

export class TaskEventsController {
  readonly taskId: string
  private events: TaskEvent[] = []
  private pendingBatch: TaskEvent[] = []
  private pendingSnapshot: TaskEvent[] = []
  private batchTimer: unknown | null = null
  private requestId = 0
  private loadingRequest = 0
  private disposed = false
  private readonly scheduler: TaskEventsScheduler
  private readonly maxDelayMs: number
  private readonly maxBatchItems: number
  private readonly unsubscribe: Array<() => void>

  constructor(
    taskId: string,
    private readonly source: TaskEventsSource,
    private readonly onEvents: (events: TaskEvent[]) => void,
    options: TaskEventsControllerOptions = {}
  ) {
    this.taskId = taskId
    this.scheduler = options.scheduler ?? defaultScheduler
    this.maxDelayMs = options.maxDelayMs ?? TASK_EVENT_BATCH_DELAY_MS
    this.maxBatchItems = options.maxBatchItems ?? TASK_EVENT_BATCH_MAX_ITEMS
    this.unsubscribe = [
      source.onEvent((id, event) => {
        if (id !== this.taskId || this.disposed) return
        if (this.loadingRequest) this.pendingSnapshot.push(event)
        this.enqueue(event)
      }),
      source.onEventsInvalidated((id) => {
        if (id === this.taskId && !this.disposed) void this.refresh().catch(() => {})
      }),
      source.onSidecarStatus((status) => {
        if (status === 'ready' && !this.disposed) void this.refresh().catch(() => {})
      })
    ]
  }

  async refresh(): Promise<TaskEvent[]> {
    if (this.disposed) return []
    const request = ++this.requestId
    this.loadingRequest = request
    this.pendingSnapshot = []
    this.flushBatch()
    try {
      const snapshot = await this.source.readSnapshot(this.taskId)
      if (this.disposed || request !== this.requestId) return snapshot
      const pending = this.pendingSnapshot
      this.pendingSnapshot = []
      this.loadingRequest = 0
      this.clearBatch()
      this.commit(mergeTaskEvents(snapshot, pending))
      return snapshot
    } catch (error) {
      if (!this.disposed && request === this.requestId) {
        this.loadingRequest = 0
        this.pendingSnapshot = []
      }
      throw error
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    ++this.requestId
    this.loadingRequest = 0
    this.pendingSnapshot = []
    this.clearBatch()
    for (const unsubscribe of this.unsubscribe) unsubscribe()
  }

  private enqueue(event: TaskEvent): void {
    this.pendingBatch.push(event)
    if (this.pendingBatch.length >= this.maxBatchItems) {
      this.flushBatch()
      return
    }
    if (this.batchTimer === null) {
      this.batchTimer = this.scheduler.schedule(() => {
        this.batchTimer = null
        this.flushBatch()
      }, this.maxDelayMs)
    }
  }

  private flushBatch(): void {
    if (this.batchTimer !== null) {
      this.scheduler.cancel(this.batchTimer)
      this.batchTimer = null
    }
    if (!this.pendingBatch.length || this.disposed) return
    const batch = this.pendingBatch
    this.pendingBatch = []
    this.commit(mergeTaskEvents(this.events, batch))
  }

  private clearBatch(): void {
    if (this.batchTimer !== null) {
      this.scheduler.cancel(this.batchTimer)
      this.batchTimer = null
    }
    this.pendingBatch = []
  }

  private commit(next: TaskEvent[]): void {
    if (this.disposed || next === this.events) return
    this.events = next
    this.onEvents(next)
  }
}
