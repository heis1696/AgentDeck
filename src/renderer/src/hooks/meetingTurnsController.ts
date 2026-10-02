import type { MeetingTurnDetail, MeetingTurnPage, MeetingTurnReadQuery } from '../../../shared/meeting'

export interface MeetingTurnsSource {
  readTurns(meetingId: string, query?: MeetingTurnReadQuery): Promise<MeetingTurnPage>
}

export interface MeetingTurnsSnapshot {
  turns: MeetingTurnDetail[]
  latestVersion: number | null
  initialized: boolean
  loading: boolean
  error: string | null
}

export function emptyMeetingTurns(): MeetingTurnsSnapshot {
  return { turns: [], latestVersion: null, initialized: false, loading: true, error: null }
}

export function mergeMeetingTurns(current: readonly MeetingTurnDetail[], incoming: readonly MeetingTurnDetail[]): MeetingTurnDetail[] {
  const merged = new Map(current.map((turn) => [turn.id, turn]))
  for (const turn of incoming) {
    const previous = merged.get(turn.id)
    if (!previous || (turn.version ?? 0) >= (previous.version ?? 0)) merged.set(turn.id, turn)
  }
  return [...merged.values()].sort((first, second) => (first.sequence ?? 0) - (second.sequence ?? 0) || first.round - second.round || first.id.localeCompare(second.id))
}

export class MeetingTurnsController {
  private snapshot = emptyMeetingTurns()
  private disposed = false
  private dirty = false
  private reading: Promise<MeetingTurnsSnapshot> | null = null

  constructor(
    readonly meetingId: string,
    private readonly source: MeetingTurnsSource,
    private readonly onSnapshot: (snapshot: MeetingTurnsSnapshot) => void
  ) {}

  getSnapshot(): MeetingTurnsSnapshot { return this.snapshot }

  refresh(): Promise<MeetingTurnsSnapshot> {
    if (this.disposed) return Promise.resolve(this.snapshot)
    this.dirty = true
    if (!this.reading) this.reading = Promise.resolve().then(() => this.drain()).finally(() => {
      this.reading = null
      if (this.dirty && !this.disposed) return this.refresh()
    })
    return this.reading
  }

  dispose(): void { this.disposed = true; this.dirty = false }

  private emit(patch: Partial<MeetingTurnsSnapshot>): void {
    if (this.disposed) return
    this.snapshot = { ...this.snapshot, ...patch }
    this.onSnapshot(this.snapshot)
  }

  private async drain(): Promise<MeetingTurnsSnapshot> {
    while (this.dirty && !this.disposed) {
      this.dirty = false
      this.emit({ loading: true })
      try {
        const previousVersion = this.snapshot.latestVersion
        const query: MeetingTurnReadQuery = { limit: 64, ...(previousVersion === null ? {} : { afterVersion: previousVersion }) }
        const incoming: MeetingTurnDetail[] = []
        const cursors = new Set<string>()
        let cursor: string | undefined
        let latestVersion: number | undefined
        do {
          const page = await this.source.readTurns(this.meetingId, { ...query, ...(cursor ? { cursor } : {}) })
          if (this.disposed) return this.snapshot
          if (page.meetingId !== this.meetingId) throw new Error('发言分页不属于当前会议')
          if (!Number.isSafeInteger(page.latestVersion) || page.latestVersion < 0) throw new Error('无效的会议发言版本')
          if (latestVersion !== undefined && latestVersion !== page.latestVersion) throw new Error('会议分页水位发生变化，请重试')
          latestVersion = page.latestVersion
          if (page.turns.some((turn) => turn.meetingId !== this.meetingId || (turn.version ?? 0) > page.latestVersion)) throw new Error('会议发言归属或版本无效')
          incoming.push(...page.turns)
          if (!page.hasMore) break
          if (!page.nextCursor || cursors.has(page.nextCursor)) throw new Error('会议发言分页游标缺失或重复')
          cursor = page.nextCursor
          cursors.add(cursor)
        } while (true)
        if (latestVersion === undefined || previousVersion !== null && latestVersion < previousVersion) throw new Error('会议发言水位不能回退')
        this.emit({ turns: mergeMeetingTurns(this.snapshot.turns, incoming), latestVersion, initialized: true, loading: false, error: null })
      } catch (cause) {
        this.emit({ loading: false, error: cause instanceof Error ? cause.message : String(cause) })
      }
    }
    return this.snapshot
  }
}
