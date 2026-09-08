import fs from 'node:fs'
import type { TaskEvent } from '../shared/types'

/** Append-only event log for one task directory. */
export class EventLog {
  private nextSequence: number | undefined
  private offsets = new Map<number, number>()
  private indexed = false

  constructor(private readonly file: string) {}

  private ensureSequence() {
    if (this.nextSequence !== undefined) return
    this.ensureIndex()
    this.nextSequence = [...this.offsets.keys()].pop() ?? 0
  }

  private ensureIndex() {
    if (this.indexed) return
    this.offsets.clear()
    let max = 0
    try {
      const bytes = fs.readFileSync(this.file)
      let start = 0
      while (start < bytes.length) {
        const end = bytes.indexOf(0x0a, start)
        if (end < 0) break
        const line = bytes.subarray(start, end).toString('utf8').trim()
        if (line) {
          try {
            const event = JSON.parse(line) as TaskEvent
            this.offsets.set(event.seq, start)
            max = Math.max(max, event.seq)
          } catch {}
        }
        start = end + 1
      }
    } catch {}
    this.nextSequence = max
    this.indexed = true
  }

  append(event: Omit<TaskEvent, 'seq'>): TaskEvent | null {
    this.ensureSequence()
    const full: TaskEvent = { ...event, seq: (this.nextSequence ?? 0) + 1 }
    try {
      const offset = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0
      fs.appendFileSync(this.file, JSON.stringify(full) + '\n', 'utf8')
      this.nextSequence = full.seq
      this.offsets.set(full.seq, offset)
      this.indexed = true
      return full
    } catch {
      this.nextSequence = undefined
      return null
    }
  }

  truncate(keepThroughSeq: number): TaskEvent[] | null {
    const kept: TaskEvent[] = []
    try {
      let raw = ''
      try { raw = fs.readFileSync(this.file, 'utf8') } catch {}
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line) as TaskEvent
          if (event.seq <= keepThroughSeq) kept.push(event)
        } catch {}
      }
      const tmp = this.file + '.tmp'
      fs.writeFileSync(tmp, kept.map((event) => JSON.stringify(event)).join('\n') + (kept.length ? '\n' : ''))
      fs.renameSync(tmp, this.file)
      this.nextSequence = undefined
      this.indexed = false
      return kept
    } catch {
      return null
    }
  }

  read(afterSeq = 0, limit = 5000): TaskEvent[] {
    const out: TaskEvent[] = []
    this.ensureIndex()
    try {
      const firstSeq = [...this.offsets.keys()].find((seq) => seq > afterSeq)
      if (firstSeq === undefined) return out
      const start = this.offsets.get(firstSeq) ?? 0
      for (const line of fs.readFileSync(this.file).subarray(start).toString('utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line) as TaskEvent
          if (event.seq > afterSeq) out.push(event)
          if (out.length >= limit) break
        } catch {}
      }
    } catch {}
    return out
  }
}
