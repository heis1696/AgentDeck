import type { PermissionRequest } from '../shared/contracts'
import { permissionDecision } from '../shared/permission'

type Decision = { optionId?: string; decision: 'allow' | 'deny' }
export type WorkVersion = string | number
type Pending = { taskId: string; workVersion: WorkVersion; request: PermissionRequest; resolve: (decision: Decision) => void; timer: NodeJS.Timeout }

export class PermissionBroker {
  private pending = new Map<string, Pending>()
  private taskVersions = new Map<string, WorkVersion>()
  private requestSequence = 0
  private closed = false

  constructor(
    private readonly onRequest: (taskId: string, request: PermissionRequest) => void,
    /** 固定毫秒数或实时读取设置的取值函数（每次 ask 时取当前值，改设置无需重启） */
    private readonly timeoutMs: number | (() => number) = 5 * 60 * 1000,
    private readonly getWorkVersion?: (taskId: string) => WorkVersion | undefined
  ) {}

  private timeout(): number {
    return typeof this.timeoutMs === 'function' ? this.timeoutMs() : this.timeoutMs
  }

  pendingFor(taskId: string): PermissionRequest[] {
    return [...this.pending.values()].filter((pending) => pending.taskId === taskId).map((pending) => pending.request)
  }

  private publish(taskId: string, request: PermissionRequest) {
    try { this.onRequest(taskId, request) }
    catch { /* A missing renderer can recover pending requests through the snapshot API. */ }
  }

  private settle(key: string, pending: Pending, decision: Decision, resolution: NonNullable<PermissionRequest['resolution']>) {
    clearTimeout(pending.timer)
    if (this.pending.get(key) === pending) this.pending.delete(key)
    pending.resolve(decision)
    // Finish replacement/cancellation before observers can reenter the broker.
    queueMicrotask(() => this.publish(pending.taskId, { ...pending.request, resolution }))
  }

  /** Update the current content version and invalidate older pending requests. */
  setWorkVersion(taskId: string, version: WorkVersion) {
    const previous = this.taskVersions.get(taskId)
    this.taskVersions.set(taskId, version)
    if (previous !== undefined && previous !== version) this.invalidateTask(taskId, version)
  }

  setTaskWorkVersion(taskId: string, version: WorkVersion) {
    this.setWorkVersion(taskId, version)
  }

  updateTaskVersion(taskId: string, version: WorkVersion) {
    this.setWorkVersion(taskId, version)
  }

  /** Alias used by lifecycle callers when a task snapshot changes. */
  invalidateTask(taskId: string, version?: WorkVersion) {
    if (version !== undefined) this.taskVersions.set(taskId, version)
    for (const [key, pending] of [...this.pending]) {
      if (pending.taskId !== taskId) continue
      if (version !== undefined && pending.workVersion === version) continue
      this.settle(key, pending, { decision: 'deny' }, 'invalidated')
    }
  }

  ask(taskId: string, request: PermissionRequest, workVersion?: WorkVersion): Promise<Decision> {
    if (this.closed) return Promise.resolve({ decision: 'deny' })
    const key = String(request.requestId)
    const snapshot = workVersion ?? request.workVersion ?? this.getWorkVersion?.(taskId) ?? this.taskVersions.get(taskId) ?? '0'
    this.setWorkVersion(taskId, snapshot)
    const previous = this.pending.get(key)
    if (previous) {
      // Request ids are provider-scoped in practice. Reusing one across tasks
      // is ambiguous to the legacy IPC response (which carries only the id),
      // so fail closed instead of allowing a stale response to authorize the
      // other task. Same-task replacements retain the historical behavior.
      if (previous.taskId !== taskId) {
        this.settle(key, previous, { decision: 'deny' }, 'invalidated')
        return Promise.resolve({ decision: 'deny' })
      }
      this.settle(key, previous, { decision: 'deny' }, 'invalidated')
    }
    return new Promise((resolve) => {
      const requestedAt = Date.now()
      const timeout = this.timeout()
      const published = { ...request, workVersion: snapshot, requestedAt, expiresAt: requestedAt + timeout, requestToken: `${requestedAt}:${++this.requestSequence}`, resolution: undefined }
      const timer = setTimeout(() => {
        const pending = this.pending.get(key)
        if (pending?.request === published) this.settle(key, pending, { decision: 'deny' }, 'expired')
      }, timeout)
      this.pending.set(key, { taskId, workVersion: snapshot, request: published, resolve, timer })
      this.publish(taskId, published)
    })
  }

  resolve(requestId: string | number, optionId: string, decision: 'allow' | 'deny', workVersion?: WorkVersion, requestToken?: string) {
    const key = String(requestId)
    const pending = this.pending.get(key)
    if (!pending) return { ok: false, error: '请求不存在或已超时' }
    if (requestToken !== undefined && requestToken !== pending.request.requestToken) return { ok: false, error: '权限请求已更新，请重新选择' }
    if (pending.request.expiresAt! <= Date.now()) {
      this.settle(key, pending, { decision: 'deny' }, 'expired')
      return { ok: false, error: '权限请求已超时并拒绝' }
    }
    const current = this.getWorkVersion?.(pending.taskId) ?? this.taskVersions.get(pending.taskId) ?? pending.workVersion
    if ((workVersion !== undefined && workVersion !== pending.workVersion) || current !== pending.workVersion) {
      this.settle(key, pending, { decision: 'deny' }, 'invalidated')
      return { ok: false, error: '权限请求已因任务内容变化失效' }
    }
    const option = pending.request.options.find((item) => item.optionId === optionId && permissionDecision(item.response.decision) === decision)
    if (decision === 'allow' && !option) return { ok: false, error: '授权选项无效，请重新选择' }
    this.settle(key, pending, { ...(option ? { optionId } : {}), decision }, 'answered')
    return { ok: true }
  }

  cancelTask(taskId: string) {
    for (const [key, pending] of [...this.pending]) {
      if (pending.taskId !== taskId) continue
      this.settle(key, pending, { decision: 'deny' }, 'cancelled')
    }
  }

  shutdown() {
    this.closed = true
    for (const [key, pending] of [...this.pending]) {
      this.settle(key, pending, { decision: 'deny' }, 'cancelled')
    }
  }
}
