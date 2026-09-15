import fs from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_MEETING_MAX_DURATION_MS,
  DEFAULT_MEETING_MAX_INNER_TURNS,
  DEFAULT_MEETING_MAX_ROUNDS,
  DEFAULT_MEETING_NO_PROGRESS_CAP,
  type Meeting,
  type MeetingCreateInput,
  type MeetingMinutes,
  type MeetingTurn
} from '../shared/meeting'

export const MEETING_INDEX_SCHEMA_VERSION = 1 as const

interface MeetingIndexDocument {
  schemaVersion: typeof MEETING_INDEX_SCHEMA_VERSION
  meetings: Meeting[]
  turns: MeetingTurn[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export class MeetingStore {
  private readonly dir: string
  private readonly file: string
  private data: MeetingIndexDocument = { schemaVersion: MEETING_INDEX_SCHEMA_VERSION, meetings: [], turns: [] }

  constructor(userDataDir: string) {
    this.dir = path.join(userDataDir, 'meetings')
    this.file = path.join(this.dir, 'index.json')
    fs.mkdirSync(this.dir, { recursive: true })
    this.load()
  }

  private load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown
      if (!isRecord(raw) || raw.schemaVersion !== MEETING_INDEX_SCHEMA_VERSION || !Array.isArray(raw.meetings) || !Array.isArray(raw.turns)) throw new Error('Invalid meeting index')
      this.data = { schemaVersion: MEETING_INDEX_SCHEMA_VERSION, meetings: raw.meetings as Meeting[], turns: raw.turns as MeetingTurn[] }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }

  private save() {
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2))
    fs.renameSync(tmp, this.file)
  }

  private id(prefix: string) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  }

  list() { return [...this.data.meetings].sort((a, b) => b.updatedAt - a.updatedAt) }
  get(id: string) { return this.data.meetings.find((meeting) => meeting.id === id) ?? null }
  turns(meetingId: string) { return this.data.turns.filter((turn) => turn.meetingId === meetingId).sort((a, b) => a.round - b.round || a.id.localeCompare(b.id)) }

  create(input: MeetingCreateInput): Meeting {
    if (!input.issueId.trim()) throw new Error('issueId 不能为空')
    if (!input.topic.trim()) throw new Error('topic 不能为空')
    if (!input.participants.length) throw new Error('至少需要一个会议参与者')
    const maxRounds = input.maxRounds ?? DEFAULT_MEETING_MAX_ROUNDS
    const maxInnerTurns = input.maxInnerTurns ?? DEFAULT_MEETING_MAX_INNER_TURNS
    const maxDurationMs = input.maxDurationMs ?? DEFAULT_MEETING_MAX_DURATION_MS
    const noProgressCap = input.noProgressCap ?? DEFAULT_MEETING_NO_PROGRESS_CAP
    if (!Number.isInteger(maxRounds) || maxRounds < 1) throw new Error('maxRounds 必须是正整数')
    if (!Number.isInteger(maxInnerTurns) || maxInnerTurns < 1) throw new Error('maxInnerTurns 必须是正整数')
    if (!Number.isFinite(maxDurationMs) || maxDurationMs < 1) throw new Error('maxDurationMs 必须是正数')
    if (!Number.isInteger(noProgressCap) || noProgressCap < 1) throw new Error('noProgressCap 必须是正整数')
    const now = Date.now()
    const meeting: Meeting = {
      id: this.id('meeting'),
      issueId: input.issueId.trim(),
      topic: input.topic.trim(),
      participants: input.participants.map((participant) => ({ ...participant })),
      status: 'draft',
      round: 0,
      maxRounds,
      maxInnerTurns,
      maxDurationMs,
      minutes: [],
      noProgress: 0,
      noProgressCap,
      failures: 0,
      pendingChairNotes: [],
      createdAt: now,
      updatedAt: now
    }
    this.data.meetings.push(meeting)
    this.save()
    return meeting
  }

  update(id: string, patch: Partial<Meeting>) {
    const meeting = this.get(id)
    if (!meeting) return null
    Object.assign(meeting, patch, { updatedAt: Date.now() })
    this.save()
    return meeting
  }

  appendTurn(turn: MeetingTurn) {
    this.data.turns.push({ ...turn })
    this.save()
    return turn
  }

  appendMinutes(id: string, minutes: MeetingMinutes) {
    const meeting = this.get(id)
    if (!meeting) return null
    meeting.minutes = [...meeting.minutes, minutes]
    meeting.updatedAt = Date.now()
    this.save()
    return meeting
  }

  delete(id: string) {
    const before = this.data.meetings.length
    this.data.meetings = this.data.meetings.filter((meeting) => meeting.id !== id)
    this.data.turns = this.data.turns.filter((turn) => turn.meetingId !== id)
    if (this.data.meetings.length === before) return false
    this.save()
    return true
  }

  reload() { this.data = { schemaVersion: MEETING_INDEX_SCHEMA_VERSION, meetings: [], turns: [] }; this.load() }
}
