import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  DEFAULT_MEETING_MAX_DURATION_MS,
  DEFAULT_MEETING_MAX_INNER_TURNS,
  DEFAULT_MEETING_MAX_ROUNDS,
  DEFAULT_MEETING_NO_PROGRESS_CAP,
  type Meeting,
  type MeetingCreateInput,
  type MeetingMinutes,
  type MeetingTurn,
  type MeetingTurnDelivery,
  type MeetingTurnDetail,
  type MeetingTurnPage,
  type MeetingTurnReadQuery,
  type MeetingTurnUpdatePatch
} from '../shared/meeting'

/**
 * 索引 schema 保持 1：新字段全部可选、纯增量，旧程序可直接读新索引（回退安全），
 * 新程序可直接读旧索引（缺正文即历史记录不足，不用 summary 冒充）。
 *
 * 阶段4迁移（schema 1 内的水位物化，内容判定、幂等、可重入）：
 * - 旧会议缺会议级 publicVersion/turnVersion 时首次写入固化为显式 0（发言级 sequence/version
 *   保持读侧 ?? 0，旧记录字段保持未写）；显式 0 是版本增量的权威基线。
 * - 首次迁移写入前把 index.json 原字节复制到 index.pre-migration.json：一次性、之后任何
 *   保存/重入都不覆盖；备份失败则放弃本次迁移（fail-closed），下次加载重试。
 * - 高于本版本的 schema 视为未知：拒读拒写，主文件字节不动，也不得用陈旧备份自愈覆盖。
 */
export const MEETING_INDEX_SCHEMA_VERSION = 1 as const

/** 索引 schema 高于本程序支持版本（更新版本程序写入的数据）：拒读拒写，保留原文件 */
export class MeetingIndexSchemaError extends Error {
  constructor(readonly foundVersion: unknown) {
    super(`Unsupported meeting index schema version: ${foundVersion}; refusing to read or write`)
    this.name = 'MeetingIndexSchemaError'
  }
}

export const MEETING_TURN_BODY_SCHEMA_VERSION = 1 as const
const MEETING_TURN_CURSOR_VERSION = 1 as const
const DEFAULT_TURN_PAGE_LIMIT = 200
const MAX_TURN_PAGE_LIMIT = 500
/** 进入文件路径的 meetingId/turnId 白名单；防目录穿越，也挡住误把任意字符串当存储键 */
const SAFE_STORAGE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const PROTECTED_TURN_KEYS = new Set(['id', 'meetingId', 'sequence', 'version', 'bodyVersion'])

interface MeetingIndexDocument {
  schemaVersion: typeof MEETING_INDEX_SCHEMA_VERSION
  meetings: Meeting[]
  turns: MeetingTurn[]
}

interface TurnBodyDocument {
  schemaVersion: typeof MEETING_TURN_BODY_SCHEMA_VERSION
  meetingId: string
  turnId: string
  body?: string
  delivery?: MeetingTurnDelivery
  bodyVersion?: number
  updatedAt: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export class MeetingStore {
  private readonly dir: string
  private readonly file: string
  private readonly backupFile: string
  private readonly preMigrationFile: string
  private readonly bodiesRoot: string
  private writeError: Error | null = null
  private data: MeetingIndexDocument = { schemaVersion: MEETING_INDEX_SCHEMA_VERSION, meetings: [], turns: [] }

  constructor(userDataDir: string) {
    this.dir = path.join(userDataDir, 'meetings')
    this.file = path.join(this.dir, 'index.json')
    this.backupFile = `${this.file}.bak`
    this.preMigrationFile = path.join(this.dir, 'index.pre-migration.json')
    this.bodiesRoot = path.join(this.dir, 'bodies')
    fs.mkdirSync(this.bodiesRoot, { recursive: true })
    this.load()
    this.migrateLegacyWatermarks()
    if (!this.writeError) {
      this.recoverPendingBody()
      this.reclaimOrphanBodies()
    }
  }

  private parseIndex(file: string): MeetingIndexDocument {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    if (!isRecord(raw) || raw.schemaVersion !== MEETING_INDEX_SCHEMA_VERSION || !Array.isArray(raw.meetings) || !Array.isArray(raw.turns)) {
      // 未来版本的更高 schema 是未知数据：单独标识，调用方必须拒写且不得用备份覆盖
      if (isRecord(raw) && 'schemaVersion' in raw && raw.schemaVersion !== MEETING_INDEX_SCHEMA_VERSION) throw new MeetingIndexSchemaError(raw.schemaVersion)
      throw new Error('Invalid meeting index')
    }
    // 正文不属于整体索引：即使索引文件被外部塞入 body 字段，加载时也剥离
    const turns = (raw.turns as Array<Record<string, unknown>>).map((turn) => {
      const { body: _body, ...rest } = turn
      return rest as unknown as MeetingTurn
    })
    return { schemaVersion: MEETING_INDEX_SCHEMA_VERSION, meetings: raw.meetings as Meeting[], turns }
  }

  private load() {
    try {
      this.data = this.parseIndex(this.file)
      this.writeError = null
      return
    } catch (error) {
      // 未知 schema：主文件是更新版本程序的数据，拒写——不重写主文件，也不用陈旧备份覆盖它
      if (error instanceof MeetingIndexSchemaError) throw error
      try {
        this.data = this.parseIndex(this.backupFile)
      } catch (backupError) {
        if (backupError instanceof MeetingIndexSchemaError) throw backupError
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !fs.existsSync(this.backupFile)) return
        throw error
      }
      // 主索引损坏：用备份自愈重写主文件；先删主文件，防止 save 把损坏内容复制进备份
      fs.rmSync(this.file, { force: true })
      this.save()
    }
  }

  private assertWritable() {
    if (this.writeError) throw this.writeError
  }

  private save() {
    this.assertWritable()
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2))
    fs.renameSync(tmp, this.file)
    // 备份与最新已提交状态保持一致（改名是原子的，静态损坏时备份可零丢失恢复）；复制失败不影响已提交数据
    try {
      fs.copyFileSync(this.file, this.backupFile)
    } catch {}
  }

  /** 先改内存再落盘；落盘失败回滚内存，保证内存与磁盘一致（残留正文等孤儿由加载期回收） */
  private commit(rollback: () => void) {
    try {
      this.save()
    } catch (error) {
      rollback()
      throw error
    }
  }

  /**
   * 阶段4迁移：把旧会议缺失的会议级 publicVersion/turnVersion 固化为显式 0，
   * 作为版本增量读取的权威基线（发言级 sequence/version 保持读侧 ?? 0，不在此改写）。
   * 内容判定天然幂等：全部显式后不再触发。备份只写一次且永不覆盖；备份或落盘失败
   * 都只推迟迁移（读侧零默认保证语义正确），下次加载重入完成。
   */
  private migrateLegacyWatermarks() {
    if (!this.data.meetings.some((meeting) => meeting.publicVersion === undefined || meeting.turnVersion === undefined)) return
    const temporary = this.preMigrationFile + '.' + randomUUID() + '.tmp'
    try {
      if (!fs.existsSync(this.preMigrationFile)) {
        fs.copyFileSync(this.file, temporary, fs.constants.COPYFILE_EXCL)
        try { fs.linkSync(temporary, this.preMigrationFile) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      }
      this.parseIndex(this.preMigrationFile)
    } catch (error) {
      this.writeError = error instanceof Error ? error : new Error(String(error))
      console.warn('[MeetingStore] pre-migration backup failed; store is read-only until reload', error)
      return
    } finally {
      try { fs.unlinkSync(temporary) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    const watermarks = new Map<string, { publicVersion: number; turnVersion: number }>()
    for (const turn of this.data.turns) {
      const current = watermarks.get(turn.meetingId) ?? { publicVersion: 0, turnVersion: 0 }
      current.publicVersion = Math.max(current.publicVersion, turn.publicVersion ?? 0)
      current.turnVersion = Math.max(current.turnVersion, turn.version ?? 0)
      watermarks.set(turn.meetingId, current)
    }
    const previous = this.data.meetings
    this.data.meetings = previous.map((meeting) => meeting.publicVersion !== undefined && meeting.turnVersion !== undefined
      ? meeting
      : { ...meeting, publicVersion: meeting.publicVersion ?? watermarks.get(meeting.id)?.publicVersion ?? 0, turnVersion: meeting.turnVersion ?? watermarks.get(meeting.id)?.turnVersion ?? 0 })
    this.writeError = null
    try {
      this.save()
    } catch (error) {
      this.data.meetings = previous
      this.writeError = error instanceof Error ? error : new Error(String(error))
      console.warn('[MeetingStore] watermark migration deferred; legacy records keep read-side zero defaults', error)
    }
  }

  private id(prefix: string) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  }

  private turnsOf(meetingId: string) {
    return this.data.turns.filter((turn) => turn.meetingId === meetingId)
  }

  private findTurn(meetingId: string, turnId: string) {
    return this.data.turns.find((turn) => turn.meetingId === meetingId && turn.id === turnId)
  }

  private turnRevisionOf(meetingId: string) {
    return this.turnsOf(meetingId).reduce((max, turn) => Math.max(max, turn.version ?? 0), 0)
  }

  private nextSequenceOf(meetingId: string) {
    return this.turnsOf(meetingId).reduce((max, turn) => Math.max(max, turn.sequence ?? 0), 0) + 1
  }

  private bodyJournalFile() { return path.join(this.dir, 'body-pending.json') }

  private cleanupBodyJournal() {
    try { fs.rmSync(this.bodyJournalFile(), { force: true }) } catch (error) { console.warn('[MeetingStore] committed body journal cleanup deferred', error) }
  }

  private publishBodyJournal(meetingId: string, turnId: string, version: number, previous?: TurnBodyDocument) {
    const journal = this.bodyJournalFile()
    fs.writeFileSync(`${journal}.tmp`, JSON.stringify({ meetingId, turnId, version, previous }))
    fs.renameSync(`${journal}.tmp`, journal)
  }

  private recoverPendingBody() {
    const journal = this.bodyJournalFile()
    if (!fs.existsSync(journal)) return
    let pending: { meetingId: string; turnId: string; version: number; previous?: TurnBodyDocument }
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(journal, 'utf8'))
      if (!isRecord(parsed) || typeof parsed.meetingId !== 'string' || typeof parsed.turnId !== 'string' || !this.bodyFile(parsed.meetingId, parsed.turnId) || !Number.isSafeInteger(parsed.version) || (parsed.version as number) < 1) throw new Error('Invalid meeting body journal')
      if (parsed.previous !== undefined && (!isRecord(parsed.previous) || parsed.previous.meetingId !== parsed.meetingId || parsed.previous.turnId !== parsed.turnId || parsed.previous.schemaVersion !== MEETING_TURN_BODY_SCHEMA_VERSION || parsed.previous.body !== undefined && typeof parsed.previous.body !== 'string')) throw new Error('Invalid previous meeting body')
      pending = parsed as unknown as typeof pending
    } catch (error) {
      fs.renameSync(journal, `${journal}.invalid-${Date.now()}`)
      console.warn('[MeetingStore] damaged journal quarantined; index remains available', error)
      return
    }
    const turn = this.findTurn(pending.meetingId, pending.turnId)
    const committed = (turn?.bodyVersion ?? 0) >= pending.version || turn?.bodyVersion === undefined && (turn?.version ?? 0) >= pending.version
    if (!committed) this.restoreDetail(pending.meetingId, pending.turnId, pending.previous)
    this.cleanupBodyJournal()
  }

  /** 按 key 合并；显式 undefined 清除字段，sequence/version 等存储键不可由调用方写入 */
  private mergeTurn(target: MeetingTurn, source: MeetingTurn | MeetingTurnUpdatePatch): MeetingTurn {
    const merged: Record<string, unknown> = { ...target }
    for (const [key, value] of Object.entries(source)) {
      if (PROTECTED_TURN_KEYS.has(key)) continue
      if (value === undefined) {
        delete merged[key]
        continue
      }
      if (key !== 'body' && key !== 'delivery') merged[key] = value
    }
    return merged as unknown as MeetingTurn
  }

  private replaceTurn(existing: MeetingTurn, next: MeetingTurn) {
    const index = this.data.turns.indexOf(existing)
    this.data.turns[index] = next
    this.commit(() => {
      this.data.turns[index] = existing
    })
  }

  list() { return [...this.data.meetings].sort((a, b) => b.updatedAt - a.updatedAt) }
  get(id: string) { return this.data.meetings.find((meeting) => meeting.id === id) ?? null }
  turns(meetingId: string) { return this.turnsOf(meetingId).sort((a, b) => a.round - b.round || a.id.localeCompare(b.id)) }

  create(input: MeetingCreateInput): Meeting {
    this.assertWritable()
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
      // 新会议显式落水位 0：内容判定的迁移因此对新数据保持静默（不会为升级后新建的会议再触发备份）
      publicVersion: 0,
      turnVersion: 0,
      createdAt: now,
      updatedAt: now
    }
    this.data.meetings.push(meeting)
    this.commit(() => { this.data.meetings = this.data.meetings.filter((item) => item !== meeting) })
    return meeting
  }

  update(id: string, patch: Partial<Meeting>) {
    this.assertWritable()
    const meeting = this.get(id)
    if (!meeting) return null
    const previous = { ...meeting }
    Object.assign(meeting, patch, { updatedAt: Date.now() })
    this.commit(() => {
      for (const key of Object.keys(meeting)) delete (meeting as unknown as Record<string, unknown>)[key]
      Object.assign(meeting, previous)
    })
    return meeting
  }

  /** 追加发言占位。同一 turnId 重复追加按幂等重放合并：内容无变化不推进版本，不产生重复气泡 */
  appendTurn(turn: MeetingTurn): MeetingTurn {
    this.assertWritable()
    const existing = this.findTurn(turn.meetingId, turn.id)
    if (!existing) {
      const record: MeetingTurn = { ...turn }
      delete (record as MeetingTurnDetail).body
      delete record.delivery
      delete record.bodyVersion
      record.sequence = this.nextSequenceOf(turn.meetingId)
      record.version = this.turnRevisionOf(turn.meetingId) + 1
      this.data.turns.push(record)
      this.commit(() => {
        this.data.turns = this.data.turns.filter((candidate) => candidate !== record)
      })
      return { ...record }
    }
    if (['done', 'failed', 'cancelled'].includes(existing.status) && ['pending', 'speaking'].includes(turn.status)) return { ...existing }
    const merged = this.mergeTurn(existing, turn)
    merged.sequence = existing.sequence ?? this.nextSequenceOf(turn.meetingId)
    merged.version = existing.version ?? 0
    if (JSON.stringify(merged) === JSON.stringify(existing)) return { ...existing }
    merged.version = this.turnRevisionOf(turn.meetingId) + 1
    this.replaceTurn(existing, merged)
    return { ...merged }
  }

  /** 原记录就地更新（占位→正式发言、失败、取消都更新同一条）；先写正文再提交索引 */
  updateTurn(meetingId: string, turnId: string, patch: MeetingTurnUpdatePatch, body?: string): MeetingTurnDetail | null {
    this.assertWritable()
    const existing = this.findTurn(meetingId, turnId)
    if (!existing) return null
    this.recoverPendingBody()
    const previous = this.readDetail(meetingId, turnId)
    const previousDelivery = previous?.delivery ?? existing.delivery
    const merged = this.mergeTurn(existing, patch)
    delete merged.delivery
    merged.sequence = existing.sequence ?? this.nextSequenceOf(meetingId)
    const nextBody = body ?? previous?.body
    const nextDelivery = Object.hasOwn(patch, 'delivery') ? patch.delivery : previousDelivery
    const changed = nextBody !== previous?.body || JSON.stringify(nextDelivery) !== JSON.stringify(previousDelivery)
    if (JSON.stringify(merged) === JSON.stringify(existing) && !changed) return { ...existing, body: previous?.body, delivery: previousDelivery }
    merged.version = this.turnRevisionOf(meetingId) + 1
    if (changed) {
      merged.bodyVersion = merged.version
      this.publishBodyJournal(meetingId, turnId, merged.version, previous)
    }
    try {
      if (changed) this.writeDetail(meetingId, turnId, nextBody, nextDelivery, merged.bodyVersion)
      this.replaceTurn(existing, merged)
    } catch (error) {
      if (changed) this.restoreDetail(meetingId, turnId, previous)
      this.cleanupBodyJournal()
      throw error
    }
    if (changed) this.cleanupBodyJournal()
    return { ...merged, body: nextBody, delivery: nextDelivery }
  }

  getTurn(meetingId: string, turnId: string): MeetingTurnDetail | null {
    const turn = this.findTurn(meetingId, turnId)
    if (!turn) return null
    let detail: TurnBodyDocument | undefined
    let bodyError: string | undefined
    try { detail = this.readDetail(meetingId, turnId) } catch (error) { bodyError = error instanceof Error ? error.message : String(error) }
    return JSON.parse(JSON.stringify({ ...turn, body: detail?.body, bodyError, delivery: detail?.delivery ?? turn.delivery })) as MeetingTurnDetail
  }

  /**
   * 分页/增量读取。sequence 为稳定顺序号（旧记录缺省 0，排在最前，不参与增量），
   * version 为会议级变更水位（每条记录最后一次变更时的水位），latestVersion 返回当前水位。
   * cursor 与 afterSequence 同义，cursor 优先；两者可叠加 afterVersion 做增量。
   */
  readTurns(meetingId: string, query: MeetingTurnReadQuery = {}): MeetingTurnPage {
    for (const value of [query.afterSequence, query.afterVersion]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new Error('无效的会议发言水位')
    const cursor = query.cursor ? this.decodeCursor(query.cursor) : undefined
    if (cursor && cursor.meetingId !== meetingId) throw new Error('分页 cursor 不属于本会议')
    const latestVersion = cursor?.latestVersion ?? this.turnRevisionOf(meetingId)
    const afterVersion = cursor?.afterVersion ?? query.afterVersion
    const afterSequence = cursor?.afterSequence ?? query.afterSequence
    const requestedLimit = query.limit ?? DEFAULT_TURN_PAGE_LIMIT
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.trunc(requestedLimit), 1), MAX_TURN_PAGE_LIMIT) : DEFAULT_TURN_PAGE_LIMIT
    const rows = this.turnsOf(meetingId).filter((turn) => (turn.version ?? 0) <= latestVersion)
      .sort((first, second) => (first.sequence ?? 0) - (second.sequence ?? 0) || first.round - second.round || first.id.localeCompare(second.id))
      .filter((turn) => {
        const sequence = turn.sequence ?? 0
        const beyond = afterSequence === undefined || sequence > afterSequence || !!cursor && sequence === afterSequence && (turn.round > cursor.round || turn.round === cursor.round && turn.id.localeCompare(cursor.turnId) > 0)
        return beyond && (afterVersion === undefined || (turn.version ?? 0) > afterVersion)
      })
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    const hasMore = rows.length > page.length
    return { meetingId, turns: page.map((turn) => this.getTurn(meetingId, turn.id)!), latestVersion, hasMore, nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ v: MEETING_TURN_CURSOR_VERSION, meetingId, latestVersion, afterVersion, afterSequence: last.sequence ?? 0, round: last.round, turnId: last.id }), 'utf8').toString('base64url') : undefined }
  }

  private decodeCursor(cursor: string): { meetingId: string; latestVersion: number; afterVersion?: number; afterSequence: number; round: number; turnId: string } {
    let parsed: unknown
    try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) } catch { throw new Error('无效的会议发言分页 cursor') }
    if (!isRecord(parsed) || parsed.v !== MEETING_TURN_CURSOR_VERSION || typeof parsed.meetingId !== 'string' || typeof parsed.turnId !== 'string'
      || ![parsed.latestVersion, parsed.afterSequence, parsed.round].every((value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
      || parsed.afterVersion !== undefined && (typeof parsed.afterVersion !== 'number' || !Number.isSafeInteger(parsed.afterVersion) || parsed.afterVersion < 0)) throw new Error('无效的会议发言分页 cursor')
    return parsed as unknown as { meetingId: string; latestVersion: number; afterVersion?: number; afterSequence: number; round: number; turnId: string }
  }

  private bodyFile(meetingId: string, turnId: string): string | null {
    if (!SAFE_STORAGE_ID.test(meetingId) || !SAFE_STORAGE_ID.test(turnId)) return null
    return path.join(this.bodiesRoot, meetingId, `${turnId}.json`)
  }

  private readDetail(meetingId: string, turnId: string): TurnBodyDocument | undefined {
    const file = this.bodyFile(meetingId, turnId)
    if (!file) return undefined
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as TurnBodyDocument
      if (parsed.schemaVersion !== MEETING_TURN_BODY_SCHEMA_VERSION || parsed.meetingId !== meetingId || parsed.turnId !== turnId || parsed.body !== undefined && typeof parsed.body !== 'string') throw new Error('Invalid meeting body')
      const expected = this.findTurn(meetingId, turnId)?.bodyVersion
      if ((expected !== undefined || parsed.bodyVersion !== undefined) && parsed.bodyVersion !== expected) throw new Error('Meeting body/index transaction mismatch')
      return parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private writeDetail(meetingId: string, turnId: string, body?: string, delivery?: MeetingTurnDelivery, bodyVersion?: number) {
    const file = this.bodyFile(meetingId, turnId)
    if (!file) throw new Error('非法的会议发言标识')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const document: TurnBodyDocument = { schemaVersion: MEETING_TURN_BODY_SCHEMA_VERSION, meetingId, turnId, body, delivery, bodyVersion, updatedAt: Date.now() }
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(document))
    fs.renameSync(`${file}.tmp`, file)
  }

  private restoreDetail(meetingId: string, turnId: string, previous?: TurnBodyDocument) {
    const file = this.bodyFile(meetingId, turnId)
    if (!file) throw new Error('非法的会议发言标识')
    if (!previous) fs.rmSync(file, { force: true })
    else this.writeDetail(meetingId, turnId, previous.body, previous.delivery, previous.bodyVersion)
  }

  deleteTurnBody(meetingId: string, turnId: string): boolean {
    this.assertWritable()
    this.recoverPendingBody()
    const detail = this.getTurn(meetingId, turnId)
    if (detail?.body === undefined) return false
    const previous = this.readDetail(meetingId, turnId)!
    const existing = this.findTurn(meetingId, turnId)!
    const version = this.turnRevisionOf(meetingId) + 1
    const next = { ...existing, version, bodyVersion: version }
    this.publishBodyJournal(meetingId, turnId, version, previous)
    try {
      this.writeDetail(meetingId, turnId, undefined, previous.delivery, version)
      this.replaceTurn(existing, next)
    } catch (error) {
      this.restoreDetail(meetingId, turnId, previous)
      this.cleanupBodyJournal()
      throw error
    }
    this.cleanupBodyJournal()
    return true
  }

  /** 加载期回收：索引提交失败留下的孤儿正文、无法识别的残留临时文件。只清白名单形态的路径 */
  private reclaimOrphanBodies() {
    let meetingEntries: fs.Dirent[]
    try {
      meetingEntries = fs.readdirSync(this.bodiesRoot, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of meetingEntries) {
      if (!entry.isDirectory() || !SAFE_STORAGE_ID.test(entry.name)) continue
      const meetingDir = path.join(this.bodiesRoot, entry.name)
      if (!this.data.meetings.some((meeting) => meeting.id === entry.name)) {
        // 孤儿清理是垃圾回收，不是事务一致性：单项失败只记日志延后（下次构造/reload 重试），
        // 绝不让 EPERM/EACCES 之类的删除失败炸掉构造函数、阻断整个应用初始化
        try {
          fs.rmSync(meetingDir, { recursive: true, force: true })
        } catch (error) {
          console.warn('[MeetingStore] orphan meeting body dir cleanup deferred', error)
        }
        continue
      }
      const turnIds = new Set(this.turnsOf(entry.name).map((turn) => turn.id))
      let files: fs.Dirent[]
      try {
        files = fs.readdirSync(meetingDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const file of files) {
        const turnId = file.name.endsWith('.json') ? file.name.slice(0, -'.json'.length) : file.name
        if (!SAFE_STORAGE_ID.test(turnId) || !turnIds.has(turnId)) {
          try {
            fs.rmSync(path.join(meetingDir, file.name), { force: true })
          } catch (error) {
            console.warn('[MeetingStore] orphan turn body cleanup deferred', error)
          }
        }
      }
    }
  }

  appendMinutes(id: string, minutes: MeetingMinutes) {
    this.assertWritable()
    const meeting = this.get(id)
    if (!meeting) return null
    return this.update(id, { minutes: [...meeting.minutes, minutes] })
  }

  delete(id: string) {
    this.assertWritable()
    const before = this.data.meetings.length
    const nextMeetings = this.data.meetings.filter((meeting) => meeting.id !== id)
    if (nextMeetings.length === before) return false
    const snapshotMeetings = this.data.meetings
    const snapshotTurns = this.data.turns
    this.data.meetings = nextMeetings
    this.data.turns = this.data.turns.filter((turn) => turn.meetingId !== id)
    try {
      this.save()
    } catch (error) {
      this.data.meetings = snapshotMeetings
      this.data.turns = snapshotTurns
      throw error
    }
    // 正文目录在索引提交成功后清理；失败残留的孤儿由下次加载回收
    if (SAFE_STORAGE_ID.test(id)) fs.rmSync(path.join(this.bodiesRoot, id), { recursive: true, force: true })
    return true
  }

  reload() {
    // 加载失败（含未知 schema 拒写）时回护内存：实例不得带着空数据继续运行，
    // 否则后续 save 会把未知 schema 的索引覆盖成空库
    const previous = this.data
    this.data = { schemaVersion: MEETING_INDEX_SCHEMA_VERSION, meetings: [], turns: [] }
    try {
      this.load()
      this.migrateLegacyWatermarks()
      if (!this.writeError) {
        this.recoverPendingBody()
        this.reclaimOrphanBodies()
      }
    } catch (error) {
      this.data = previous
      this.writeError = error instanceof Error ? error : new Error(String(error))
      throw error
    }
  }
}
