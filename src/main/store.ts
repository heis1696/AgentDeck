// 文件存储：userData/tasks.json（索引）+ userData/tasks/<id>/events.jsonl（日志流）
import fs from 'node:fs'
import path from 'node:path'
import type { Task, TaskEvent, IntegrationInfo } from '../shared/types'

export class TaskStore {
  private dir: string
  private tasks = new Map<string, Task>()
  private seqCounters = new Map<string, number>()

  constructor(userDataDir: string) {
    this.dir = path.join(userDataDir, 'tasks')
    fs.mkdirSync(this.dir, { recursive: true })
    this.loadIndex()
  }

  private indexFile() {
    return path.join(this.dir, 'tasks.json')
  }

  private taskDir(id: string) {
    return path.join(this.dir, id)
  }

  private loadIndex() {
    try {
      const raw = fs.readFileSync(this.indexFile(), 'utf8')
      const list = JSON.parse(raw) as unknown[]
      for (const t of list) {
        const migrated = this.migrate(t)
        // Reconcile counters with the append-only log after an interrupted write.
        if (migrated.id && migrated.eventCount === 0) {
          try {
            const rawEvents = fs.readFileSync(path.join(this.taskDir(migrated.id), 'events.jsonl'), 'utf8')
            migrated.eventCount = rawEvents.split('\n').filter(Boolean).length
          } catch {}
        }
        this.tasks.set(migrated.id, migrated)
      }
      if (list.length) this.saveIndex()
    } catch {}
  }

  /** 一次性迁移 + 启动清扫：0.3.x 双轨 squad 字段 → integration；重启后悬挂的 running 任务标失败 */
  private migrate(raw: unknown): Task {
    const old = raw as Task & { mode?: string; squad?: { integrationBranch?: string; integrationNote?: string } }
    const out = { ...old } as Partial<Task> & Record<string, unknown>
    // Older indexes may omit fields introduced after the initial schema.
    if (typeof out.eventCount !== 'number' || out.eventCount < 0) out.eventCount = 0
    if (typeof out.workdir !== 'string') out.workdir = ''
    if (typeof out.backend !== 'string' || !out.backend) out.backend = 'zcode'
    if (typeof out.status !== 'string') out.status = 'queued'
    delete out.mode
    if (old.squad) {
      const integration: IntegrationInfo = {}
      if (old.squad.integrationBranch) integration.branch = old.squad.integrationBranch
      if (old.squad.integrationNote) integration.note = old.squad.integrationNote
      delete out.squad
      if (integration.branch || integration.note) out.integration = integration
      if (old.status === 'running') {
        out.status = 'failed'
        out.error = '旧版协同任务在升级后中断，请重新运行'
        out.endedAt = Date.now()
      }
    } else if (old.status === 'running') {
      // 应用重启后没有任何会话能续上这个任务——标失败让用户重试，而不是永远"执行中"
      out.status = 'failed'
      out.error = '应用重启导致任务中断，请重新运行'
      out.endedAt = Date.now()
    }
    return out as Task
  }

  private saveIndex() {
    const list = [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt)
    const tmp = this.indexFile() + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2))
    fs.renameSync(tmp, this.indexFile())
  }

  create(input: Pick<Task, 'title' | 'prompt' | 'workdir' | 'backend'> & Partial<Pick<Task, 'parentTaskId' | 'workerIndex' | 'integration' | 'agentId' | 'handoff' | 'parked' | 'suppressIssue' | 'trigger' | 'issueId' | 'titleAuto'>>): Task {
    const task: Task = {
      id: `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      title: input.title,
      prompt: input.prompt,
      workdir: input.workdir,
      backend: input.backend,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.trigger ? { trigger: input.trigger } : {}),
      ...(input.issueId ? { issueId: input.issueId } : {}),
      ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      ...(input.workerIndex !== undefined ? { workerIndex: input.workerIndex } : {}),
      ...(input.integration ? { integration: input.integration } : {}),
      ...(input.handoff ? { handoff: input.handoff } : {}),
      ...(input.parked ? { parked: true } : {}),
      ...(input.suppressIssue ? { suppressIssue: true } : {}),
      ...(input.titleAuto ? { titleAuto: true } : {}),
      status: 'queued',
      createdAt: Date.now(),
      eventCount: 0
    }
    this.tasks.set(task.id, task)
    fs.mkdirSync(this.taskDir(task.id), { recursive: true })
    fs.writeFileSync(path.join(this.taskDir(task.id), 'task.json'), JSON.stringify(task, null, 2))
    this.saveIndex()
    return task
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id)
  }

  list(): Task[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  update(id: string, patch: Partial<Task>) {
    const t = this.tasks.get(id)
    if (!t) return
    Object.assign(t, patch)
    try {
      fs.writeFileSync(path.join(this.taskDir(id), 'task.json'), JSON.stringify(t, null, 2))
    } catch {}
    this.saveIndex()
  }

  delete(id: string) {
    const t = this.tasks.get(id)
    if (!t) return
    this.seqCounters.delete(id)
    this.tasks.delete(id)
    fs.rmSync(this.taskDir(id), { recursive: true, force: true })
    this.saveIndex()
  }

  /** seq 由 store 统一分配：重启后从文件尾部恢复，保证单调 */
  private nextSeq(id: string): number {
    if (!this.seqCounters.has(id)) {
      let max = 0
      try {
        const raw = fs.readFileSync(path.join(this.taskDir(id), 'events.jsonl'), 'utf8')
        const lines = raw.trimEnd().split('\n').filter(Boolean)
        const last = lines[lines.length - 1]
        if (last) max = (JSON.parse(last) as TaskEvent).seq ?? 0
      } catch {}
      this.seqCounters.set(id, max)
    }
    const n = (this.seqCounters.get(id) ?? 0) + 1
    this.seqCounters.set(id, n)
    return n
  }

  appendEvent(id: string, e: Omit<TaskEvent, 'seq'>): TaskEvent | null {
    const t = this.tasks.get(id)
    if (!t) return null
    fs.mkdirSync(this.taskDir(id), { recursive: true })
    const full: TaskEvent = { ...e, seq: this.nextSeq(id) }
    // Synchronous append keeps readEvents/finalization and crash recovery consistent.
    try {
      fs.appendFileSync(path.join(this.taskDir(id), 'events.jsonl'), JSON.stringify(full) + '\n', 'utf8')
    } catch {
      this.seqCounters.delete(id)
      return null
    }
    t.eventCount = (t.eventCount ?? 0) + 1
    try {
      fs.writeFileSync(path.join(this.taskDir(id), 'task.json'), JSON.stringify(t, null, 2))
    } catch {}
    this.saveIndex()
    return full
  }

  flushEvents(id: string) {
    // Kept for API compatibility; events are durable when appendEvent returns.
  }

  /** 消息回退：只保留 seq <= keepThroughSeq 的事件并重写 events.jsonl（tmp+rename）；
   * 同步重置 seq 计数器与 eventCount，task.json 和索引落盘。任务不存在返回 false。 */
  truncateEvents(id: string, keepThroughSeq: number): boolean {
    const t = this.tasks.get(id)
    if (!t) return false
    const file = path.join(this.taskDir(id), 'events.jsonl')
    const kept: TaskEvent[] = []
    try {
      const raw = fs.readFileSync(file, 'utf8')
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try {
          const e = JSON.parse(line) as TaskEvent
          if (e.seq <= keepThroughSeq) kept.push(e)
        } catch {}
      }
    } catch {}
    try {
      fs.mkdirSync(this.taskDir(id), { recursive: true })
      const tmp = file + '.tmp'
      fs.writeFileSync(tmp, kept.map((e) => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''))
      fs.renameSync(tmp, file)
    } catch {
      return false
    }
    this.seqCounters.set(id, keepThroughSeq)
    t.eventCount = kept.length
    try {
      fs.writeFileSync(path.join(this.taskDir(id), 'task.json'), JSON.stringify(t, null, 2))
    } catch {}
    this.saveIndex()
    return true
  }

  readEvents(id: string, afterSeq = 0, limit = 5000): TaskEvent[] {
    const file = path.join(this.taskDir(id), 'events.jsonl')
    const out: TaskEvent[] = []
    try {
      const raw = fs.readFileSync(file, 'utf8')
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try {
          const e = JSON.parse(line) as TaskEvent
          if (e.seq > afterSeq) out.push(e)
          if (out.length >= limit) break
        } catch {}
      }
    } catch {}
    return out
  }
}
