import type { PermissionRequest } from '../shared/contracts'

type Decision = { optionId?: string; decision: 'allow' | 'deny' }
export type WorkVersion = string | number
type Pending = { taskId: string; workVersion: WorkVersion; resolve: (decision: Decision) => void; timer: NodeJS.Timeout }

export class PermissionBroker {
  private pending = new Map<string, Pending>()
  private taskVersions = new Map<string, WorkVersion>()

  constructor(
    private readonly onRequest: (taskId: string, request: PermissionRequest) => void,
    /** 固定毫秒数或实时读取设置的取值函数（每次 ask 时取当前值，改设置无需重启） */
    private readonly timeoutMs: number | (() => number) = 5 * 60 * 1000,
    private readonly getWorkVersion?: (taskId: string) => WorkVersion | undefined
  ) {}

  private timeout(): number {
    return typeof this.timeoutMs === 'function' ? this.timeoutMs() : this.timeoutMs
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
    for (const [key, pending] of this.pending) {
      if (pending.taskId !== taskId) continue
      if (version !== undefined && pending.workVersion === version) continue
      clearTimeout(pending.timer)
      this.pending.delete(key)
      pending.resolve({ decision: 'deny' })
    }
  }

  ask(taskId: string, request: PermissionRequest, workVersion?: WorkVersion): Promise<Decision> {
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
        clearTimeout(previous.timer)
        this.pending.delete(key)
        previous.resolve({ decision: 'deny' })
        return Promise.resolve({ decision: 'deny' })
      }
      clearTimeout(previous.timer)
      previous.resolve({ decision: 'deny' })
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(key)
        resolve({ decision: 'deny' })
      }, this.timeout())
      this.pending.set(key, { taskId, workVersion: snapshot, resolve, timer })
      this.onRequest(taskId, { ...request, workVersion: snapshot })
    })
  }

  resolve(requestId: string | number, optionId: string, decision: 'allow' | 'deny', workVersion?: WorkVersion) {
    const key = String(requestId)
    const pending = this.pending.get(key)
    if (!pending) return { ok: false, error: '请求不存在或已超时' }
    const current = this.getWorkVersion?.(pending.taskId) ?? this.taskVersions.get(pending.taskId) ?? pending.workVersion
    if ((workVersion !== undefined && workVersion !== pending.workVersion) || current !== pending.workVersion) {
      clearTimeout(pending.timer)
      this.pending.delete(key)
      pending.resolve({ decision: 'deny' })
      return { ok: false, error: '权限请求已因任务内容变化失效' }
    }
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
