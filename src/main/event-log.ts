import fs from 'node:fs'
import path from 'node:path'
import type { TaskEvent } from '../shared/types'
import {
  isTaskEventDurable,
  isTaskEventLiveOnly,
  TASK_EVENT_SCHEMA_VERSION,
  isTaskEventKind
} from '../shared/types'

/** The shape accepted from legacy JSONL and backend adapters before normalization. */
type TaskEventInput = Omit<TaskEvent, 'seq'> & { seq?: number }

export interface ReplayDivergence {
  seq: number
  reason: 'missing' | 'unexpected' | 'mismatch'
  expected?: TaskEvent
  actual?: TaskEvent
}

export interface ReplayResult {
  ok: boolean
  checked: number
  divergence?: ReplayDivergence
}

export class UnsupportedTaskEventVersionError extends Error {
  readonly version: number

  constructor(version: number) {
    super(`Unsupported task event schema version: ${version}`)
    this.name = 'UnsupportedTaskEventVersionError'
    this.version = version
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function finiteInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Migrate one event at the read/append boundary. Version zero means the
 * original JSONL shape (no version field); it is normalized to v=1 without
 * rewriting the source file until a later append/truncate.
 */
export function migrateTaskEvent(raw: unknown, fallbackSeq?: number, now = Date.now()): TaskEvent | null {
  if (!isRecord(raw)) return null
  const sourceVersion = raw.v ?? raw.version ?? 0
  if (typeof sourceVersion !== 'number' || !Number.isInteger(sourceVersion) || sourceVersion < 0) return null
  if (sourceVersion > TASK_EVENT_SCHEMA_VERSION) throw new UnsupportedTaskEventVersionError(sourceVersion)

  const seqValue = raw.seq ?? fallbackSeq
  // append() supplies a harmless placeholder when the producer leaves seq out;
  // read-side callers omit fallbackSeq and therefore still reject missing seq.
  if (!finiteInt(seqValue) || seqValue === 0) return null
  const ts = finiteNumber(raw.ts) ? raw.ts : now
  const originalKind = typeof raw.kind === 'string' ? raw.kind : undefined
  const kind = originalKind && isTaskEventKind(originalKind) ? originalKind : 'raw'
  const out: TaskEvent = {
    ...raw,
    seq: seqValue,
    ts,
    kind: kind as TaskEvent['kind'],
    // Keep both spellings available to old/new callers while writing the
    // canonical `v` field on disk.
    v: TASK_EVENT_SCHEMA_VERSION,
    version: TASK_EVENT_SCHEMA_VERSION
  }
  if (kind === 'raw' && originalKind && originalKind !== 'raw') out.rawKind = originalKind

  // A missing durability marker is deliberately durable for compatibility:
  // existing `kind: text` JSONL is a replayable transcript. Only explicit
  // live markers or manifest-listed provider deltas opt out of persistence.
  if (isTaskEventLiveOnly(out)) {
    out.durability = 'live'
    out.durable = false
  } else {
    out.durability = 'durable'
    if (out.durable === undefined) {
      out.durable = {
        aggregate: 'task',
        aggregateId: typeof out.aggregate === 'string' ? out.aggregate : undefined,
        seq: seqValue,
        version: TASK_EVENT_SCHEMA_VERSION
      }
    }
  }
  return out
}

function eventIdentity(event: TaskEvent): string | undefined {
  if (typeof event.eventId === 'string' && event.eventId) return `event:${event.eventId}`
  if (typeof event.id === 'string' && event.id) return `id:${event.id}`
  return undefined
}

function canonicalEvent(event: TaskEvent): string {
  // seq is assigned by this log, while both version aliases are equivalent.
  // Keep all semantic fields (including aggregate metadata) in the comparison.
  const migrated = migrateTaskEvent(event, event.seq) ?? event
  const copy: Record<string, unknown> = { ...migrated }
  delete copy.seq
  delete copy.v
  delete copy.version
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable)
    if (!isRecord(value)) return value
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
  }
  return JSON.stringify(stable(copy))
}

/**
 * Append-only event log for one task directory. Durable events are written to
 * JSONL; live-only fragments are returned to the caller for broadcast but do
 * not consume the durable sequence or appear in replay.
 */
export class EventLog {
  private nextSequence: number | undefined
  private liveSequence = 0
  private offsets = new Map<number, number>()
  private eventsByIdentity = new Map<string, TaskEvent>()
  private indexed = false

  constructor(private readonly file: string) {}

  private ensureSequence() {
    if (this.nextSequence !== undefined) return
    this.ensureIndex()
    this.nextSequence = this.maxSequence()
  }

  private maxSequence() {
    let max = 0
    for (const seq of this.offsets.keys()) max = Math.max(max, seq)
    return max
  }

  /** Remove a torn final line before any append can concatenate with it. */
  private recoverTail(bytes: Buffer): Buffer {
    if (bytes.length === 0 || bytes[bytes.length - 1] === 0x0a) return bytes
    const end = bytes.lastIndexOf(0x0a)
    // Some legacy writers emitted a valid final JSON object without a trailing
    // newline. Preserve it and add the delimiter before future appends; only
    // an unparsable final fragment is treated as a torn write.
    if (end < 0) {
      try {
        JSON.parse(bytes.toString('utf8'))
        fs.appendFileSync(this.file, '\n', 'utf8')
        return Buffer.concat([bytes, Buffer.from('\n')])
      } catch {}
    }
    const keep = end < 0 ? 0 : end + 1
    try {
      const fd = fs.openSync(this.file, 'r+')
      fs.ftruncateSync(fd, keep)
      fs.closeSync(fd)
      return bytes.subarray(0, keep)
    } catch {
      return bytes
    }
  }

  private ensureIndex() {
    if (this.indexed) return
    this.offsets.clear()
    this.eventsByIdentity.clear()
    let bytes: Buffer
    try {
      bytes = this.recoverTail(fs.readFileSync(this.file))
    } catch {
      this.nextSequence = 0
      this.indexed = true
      return
    }
    let start = 0
    while (start < bytes.length) {
      const end = bytes.indexOf(0x0a, start)
      if (end < 0) break
      const line = bytes.subarray(start, end).toString('utf8').trim()
      if (line) {
        try {
          const event = migrateTaskEvent(JSON.parse(line))
          if (event) {
            if (isTaskEventDurable(event)) this.offsets.set(event.seq, start)
            const identity = eventIdentity(event)
            if (identity) this.eventsByIdentity.set(identity, event)
          }
        } catch (error) {
          if (error instanceof UnsupportedTaskEventVersionError) throw error
          // Malformed historical lines stay untouched; they cannot enter the
          // replay index and therefore cannot create a duplicate sequence.
        }
      }
      start = end + 1
    }
    this.nextSequence = this.maxSequence()
    this.indexed = true
  }

  private writeLines(lines: string[]) {
    if (lines.length === 0) return
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const fd = fs.openSync(this.file, 'a')
    try {
      const payload = lines.join('')
      let written = 0
      while (written < payload.length) written += fs.writeSync(fd, payload.slice(written), null, 'utf8')
      // append() is the durable boundary; a successful return means bytes are
      // handed to the filesystem, not merely retained in a process buffer.
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  }

  /** Append one event. Repeating an event with the same id/eventId is a no-op. */
  append(event: TaskEventInput): TaskEvent | null {
    const fullInput = migrateTaskEvent(event, 1)
    if (!fullInput) return null
    this.ensureSequence()

    const identity = eventIdentity(fullInput)
    if (identity) {
      const prior = this.eventsByIdentity.get(identity)
      if (prior) return prior
    }

    if (isTaskEventLiveOnly(fullInput)) {
      // Live events have no durable cursor. A fractional cursor keeps their
      // renderer ordering between surrounding durable records while never
      // matching an integer `afterSeq`; it is process-local.
      fullInput.seq = this.maxSequence() + (++this.liveSequence / 1_000_000)
      fullInput.durability = 'live'
      fullInput.durable = false
      if (identity) this.eventsByIdentity.set(identity, fullInput)
      return fullInput
    }

    const requestedSeq = event.seq
    const next = this.maxSequence() + 1
    if (requestedSeq !== undefined && requestedSeq !== next) {
      const existingOffset = this.offsets.get(requestedSeq)
      if (existingOffset !== undefined) {
        const existing = this.readOneAt(existingOffset)
        if (existing && canonicalEvent(existing) === canonicalEvent(fullInput)) return existing
      }
      return null
    }
    fullInput.seq = next
    fullInput.durability = 'durable'
    if (!fullInput.durable || typeof fullInput.durable === 'boolean') {
      fullInput.durable = { aggregate: 'task', seq: next, version: TASK_EVENT_SCHEMA_VERSION }
    } else {
      fullInput.durable = { ...fullInput.durable, seq: next, version: fullInput.durable.version ?? TASK_EVENT_SCHEMA_VERSION }
    }
    const offset = this.fileSize()
    try {
      this.writeLines([JSON.stringify(fullInput) + '\n'])
    } catch {
      this.nextSequence = undefined
      this.indexed = false
      return null
    }
    this.nextSequence = next
    this.offsets.set(next, offset)
    if (identity) this.eventsByIdentity.set(identity, fullInput)
    this.indexed = true
    return fullInput
  }

  /** Append multiple events in one fsync boundary while preserving ordering. */
  appendBatch(events: readonly TaskEventInput[]): TaskEvent[] {
    const result: TaskEvent[] = []
    const lines: string[] = []
    this.ensureSequence()
    let next = this.maxSequence()
    const startOffset = this.fileSize()
    for (const event of events) {
      const normalized = migrateTaskEvent(event, 1)
      if (!normalized) continue
      const identity = eventIdentity(normalized)
      const prior = identity ? this.eventsByIdentity.get(identity) : undefined
      if (prior) {
        result.push(prior)
        continue
      }
      if (isTaskEventLiveOnly(normalized)) {
        normalized.seq = this.maxSequence() + (++this.liveSequence / 1_000_000)
        normalized.durability = 'live'
        normalized.durable = false
        if (identity) this.eventsByIdentity.set(identity, normalized)
        result.push(normalized)
        continue
      }
      const requestedSeq = event.seq
      if (requestedSeq !== undefined && requestedSeq !== next + 1) continue
      normalized.seq = ++next
      normalized.durability = 'durable'
      if (!normalized.durable || typeof normalized.durable === 'boolean') {
        normalized.durable = { aggregate: 'task', seq: normalized.seq, version: TASK_EVENT_SCHEMA_VERSION }
      } else {
        normalized.durable = { ...normalized.durable, seq: normalized.durable.seq ?? normalized.seq, version: normalized.durable.version ?? TASK_EVENT_SCHEMA_VERSION }
      }
      result.push(normalized)
      lines.push(JSON.stringify(normalized) + '\n')
      if (identity) this.eventsByIdentity.set(identity, normalized)
      this.offsets.set(normalized.seq, startOffset + Buffer.byteLength(lines.slice(0, -1).join(''), 'utf8'))
    }
    try {
      this.writeLines(lines)
    } catch {
      this.nextSequence = undefined
      this.indexed = false
      return []
    }
    this.nextSequence = next
    this.indexed = true
    return result
  }

  /** Synchronous appends are already fsync'd; retained as an explicit API boundary. */
  flush() {
    this.ensureIndex()
  }

  private fileSize() {
    try { return fs.statSync(this.file).size } catch { return 0 }
  }

  private readOneAt(offset: number): TaskEvent | null {
    try {
      const line = fs.readFileSync(this.file).subarray(offset).toString('utf8').split('\n', 1)[0]
      return migrateTaskEvent(JSON.parse(line))
    } catch { return null }
  }

  truncate(keepThroughSeq: number): TaskEvent[] | null {
    const kept: TaskEvent[] = []
    try {
      this.ensureIndex()
      for (const event of this.read(0, Number.MAX_SAFE_INTEGER)) {
        if (event.seq <= keepThroughSeq) kept.push(event)
      }
      const tmp = this.file + '.tmp'
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(tmp, kept.map((event) => JSON.stringify(event)).join('\n') + (kept.length ? '\n' : ''), 'utf8')
      const fd = fs.openSync(tmp, 'r+')
      try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      fs.renameSync(tmp, this.file)
      this.nextSequence = undefined
      this.indexed = false
      this.ensureIndex()
      return kept
    } catch {
      return null
    }
  }

  count() {
    this.ensureIndex()
    return this.offsets.size
  }

  read(afterSeq = 0, limit = 5000): TaskEvent[] {
    const out: TaskEvent[] = []
    this.ensureIndex()
    if (!Number.isFinite(limit) || limit <= 0) return out
    try {
      const offsets = [...this.offsets.entries()].sort(([a], [b]) => a - b)
      for (const [seq, offset] of offsets) {
        if (seq <= afterSeq) continue
        const event = this.readOneAt(offset)
        if (event && isTaskEventDurable(event)) out.push(event)
        if (out.length >= limit) break
      }
    } catch {}
    return out
  }

  /** Compare a replay candidate with durable history and report the first split. */
  verifyReplay(expected: readonly TaskEvent[]): ReplayResult {
    const actual = this.read(0, Number.MAX_SAFE_INTEGER)
    const normalizedExpected = expected
      .map((event) => migrateTaskEvent(event, event.seq))
      .filter((event): event is TaskEvent => !!event && isTaskEventDurable(event))
    const total = Math.max(normalizedExpected.length, actual.length)
    for (let i = 0; i < total; i++) {
      const want = normalizedExpected[i]
      const got = actual[i]
      if (!want) return { ok: false, checked: i, divergence: { seq: got.seq, reason: 'unexpected', actual: got } }
      if (!got) return { ok: false, checked: i, divergence: { seq: want.seq, reason: 'missing', expected: want } }
      if (want.seq !== got.seq || canonicalEvent(want) !== canonicalEvent(got)) {
        return { ok: false, checked: i, divergence: { seq: want.seq, reason: 'mismatch', expected: want, actual: got } }
      }
    }
    return { ok: true, checked: total }
  }

  assertReplay(expected: readonly TaskEvent[]) {
    const result = this.verifyReplay(expected)
    if (!result.ok) throw new Error(`Task event replay diverged at seq ${result.divergence?.seq ?? '?'}`)
    return result
  }

  /** `replay(afterSeq)` aliases durable reads; `replay(events)` verifies history. */
  replay(afterSeq?: number | readonly TaskEvent[], limit = 5000): TaskEvent[] | ReplayResult {
    return Array.isArray(afterSeq)
      ? this.verifyReplay(afterSeq)
      : this.read(typeof afterSeq === 'number' ? afterSeq : 0, limit)
  }
}

export function isDurableEvent(event: Pick<TaskEvent, 'kind' | 'type' | 'data' | 'durability' | 'durable'>) {
  return isTaskEventDurable(event)
}
