// 文件存储：userData/tasks.json（索引）+ userData/tasks/<id>/events.jsonl（日志流）
import fs from 'node:fs'
import path from 'node:path'
import type { Task, TaskEvent, IntegrationInfo } from '../shared/types'

export class TaskStore {
  private dir: string
  private tasks = new Map<string, Task>()
  private eventsFiles = new Map<string, fs.WriteStream>()
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
      for (const t of list) this.tasks.set((t as Task).id, this.migrate(t))
      if (list.length) this.saveIndex()
    } catch {}
  }

  /** 一次性迁移 + 启动清扫：0.3.x 双轨 squad 字段 → integration；重启后悬挂的 running 任务标失败 */
  private migrate(raw: unknown): Task {
    const old = raw as Task & { mode?: string; squad?: { integrationBranch?: string; integrationNote?: string } }
    const out = { ...old } as Partial<Task> & Record<string, unknown>
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

  create(input: Pick<Task, 'title' | 'prompt' | 'workdir' | 'backend'> & Partial<Pick<Task, 'parentTaskId' | 'workerIndex' | 'integration' | 'agentId' | 'handoff' | 'parked'>>): Task {
    const task: Task = {
      id: `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      title: input.title,
      prompt: input.prompt,
      workdir: input.workdir,
      backend: input.backend,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      ...(input.workerIndex !== undefined ? { workerIndex: input.workerIndex } : {}),
      ...(input.integration ? { integration: input.integration } : {}),
      ...(input.handoff ? { handoff: input.handoff } : {}),
      ...(input.parked ? { parked: true } : {}),
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
    this.eventsFiles.get(id)?.end()
    this.eventsFiles.delete(id)
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
    let ws = this.eventsFiles.get(id)
    if (!ws) {
      fs.mkdirSync(this.taskDir(id), { recursive: true })
      ws = fs.createWriteStream(path.join(this.taskDir(id), 'events.jsonl'), { flags: 'a' })
      this.eventsFiles.set(id, ws)
    }
    const full: TaskEvent = { ...e, seq: this.nextSeq(id) }
    ws.write(JSON.stringify(full) + '\n')
    t.eventCount++
    return full
  }

  flushEvents(id: string) {
    const ws = this.eventsFiles.get(id)
    if (ws) {
      ws.end()
      this.eventsFiles.delete(id)
    }
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
