// 文件存储：userData/tasks.json（索引）+ userData/tasks/<id>/events.jsonl（日志流）
import fs from 'node:fs'
import path from 'node:path'
import type { Task, TaskEvent } from '../shared/types'

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
      const list = JSON.parse(raw) as Task[]
      for (const t of list) this.tasks.set(t.id, t)
    } catch {}
  }

  private saveIndex() {
    const list = [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt)
    const tmp = this.indexFile() + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2))
    fs.renameSync(tmp, this.indexFile())
  }

  create(input: Pick<Task, 'title' | 'prompt' | 'workdir' | 'backend'> & Partial<Pick<Task, 'mode' | 'parentTaskId' | 'workerIndex' | 'squad'>>): Task {
    const task: Task = {
      id: `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      title: input.title,
      prompt: input.prompt,
      workdir: input.workdir,
      backend: input.backend,
      mode: input.mode ?? 'single',
      ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      ...(input.workerIndex !== undefined ? { workerIndex: input.workerIndex } : {}),
      ...(input.squad ? { squad: input.squad } : {}),
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
