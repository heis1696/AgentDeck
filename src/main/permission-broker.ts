import type { PermissionRequest } from '../shared/contracts'

type Decision = { optionId?: string; decision: 'allow' | 'deny' }
type Pending = { taskId: string; resolve: (decision: Decision) => void; timer: NodeJS.Timeout }

export class PermissionBroker {
  private pending = new Map<string, Pending>()

  constructor(
    private readonly onRequest: (taskId: string, request: PermissionRequest) => void,
    private readonly timeoutMs = 5 * 60 * 1000
  ) {}

  ask(taskId: string, request: PermissionRequest): Promise<Decision> {
    const key = String(request.requestId)
    const previous = this.pending.get(key)
    if (previous) {
      clearTimeout(previous.timer)
      previous.resolve({ decision: 'deny' })
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(key)
        resolve({ decision: 'deny' })
      }, this.timeoutMs)
      this.pending.set(key, { taskId, resolve, timer })
      this.onRequest(taskId, request)
    })
  }

  resolve(requestId: string | number, optionId: string, decision: 'allow' | 'deny') {
    const key = String(requestId)
    const pending = this.pending.get(key)
    if (!pending) return { ok: false, error: '请求不存在或已超时' }
    clearTimeout(pending.timer)
    this.pending.delete(key)
    pending.resolve({ optionId, decision })
    return { ok: true }
  }

  cancelTask(taskId: string) {
    for (const [key, pending] of this.pending) {
      if (pending.taskId !== taskId) continue
      clearTimeout(pending.timer)
      pending.resolve({ decision: 'deny' })
      this.pending.delete(key)
    }
  }

  shutdown() {
    for (const [key, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.resolve({ decision: 'deny' })
      this.pending.delete(key)
    }
  }
}
