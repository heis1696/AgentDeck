import type { Meeting, MeetingObjection, MeetingTurnDelivery, MeetingTurnDeliveryCompression, MeetingTurnDetail } from '../shared/meeting'
import type { MeetingStore } from './meeting-store'
import { meetingData } from './prompts/meeting'

export const MEETING_PUBLIC_CONTEXT_LIMIT = 32_000

export class MeetingContextLimitError extends Error {
  constructor(message: string, readonly delivery: MeetingTurnDelivery) { super(message) }
}

export function publicTurns(store: MeetingStore, meetingId: string): MeetingTurnDetail[] {
  return store.turns(meetingId)
    .filter((turn) => turn.status === 'done')
    .sort((first, second) => (first.sequence ?? 0) - (second.sequence ?? 0) || first.id.localeCompare(second.id))
    .map((turn) => store.getTurn(meetingId, turn.id)!)
}

export function publicVersion(store: MeetingStore, meetingId: string): number {
  return store.turns(meetingId).reduce((maximum, turn) => Math.max(maximum, turn.publicVersion ?? 0), 0)
}

export function chairTurnIds(store: MeetingStore, meetingId: string): string[] {
  return store.turns(meetingId).filter((turn) => turn.purpose === 'chair' && turn.status === 'done').map((turn) => turn.id).sort()
}

export function assembleMeetingContext(store: MeetingStore, meeting: Meeting, objections: MeetingObjection[], draft?: { version: string; envelope: unknown }, limit = MEETING_PUBLIC_CONTEXT_LIMIT): { text: string; delivery: MeetingTurnDelivery } {
  const allTurns = store.turns(meeting.id)
  const turns = allTurns
    .filter((turn) => turn.status === 'done')
    .sort((first, second) => (first.sequence ?? 0) - (second.sequence ?? 0) || first.id.localeCompare(second.id))
    .map((turn) => store.getTurn(meeting.id, turn.id)!)
  const missing = turns.filter((turn) => turn.publicVersion !== undefined && (turn.body === undefined || turn.bodyError))
  if (missing.length) throw new Error(`公共事实正文不可用：${missing.map((turn) => turn.id).join(',')}`)
  const protectedIds = new Set(turns.filter((turn) => turn.purpose === 'chair').map((turn) => turn.id))
  for (const phase of ['report', 'defense', 'synthesis']) {
    const latest = turns.filter((turn) => turn.phase === phase && turn.purpose !== 'chair' && turn.purpose !== 'minutes').at(-1)
    if (latest) protectedIds.add(latest.id)
  }
  for (const objection of objections.filter((item) => !item.resolved)) {
    if (objection.sourceTurnId) protectedIds.add(objection.sourceTurnId)
    if (objection.replyTurnId) protectedIds.add(objection.replyTurnId)
  }
  const history = turns.map((turn) => ({
    id: turn.id, sequence: turn.sequence, publicVersion: turn.publicVersion,
    round: turn.round, phase: turn.phase, purpose: turn.purpose,
    agentId: turn.agentId, speaker: turn.speaker,
    body: turn.body, bodyAvailable: turn.body !== undefined,
    historicalSummary: turn.body === undefined ? turn.summary : undefined,
    representation: 'complete' as 'complete' | 'summary' | 'omitted'
  }))
  const version = allTurns.reduce((maximum, turn) => Math.max(maximum, turn.publicVersion ?? 0), 0)
  const chairs = allTurns.filter((turn) => turn.purpose === 'chair' && turn.status === 'done').map((turn) => turn.id).sort()
  const delivery: MeetingTurnDelivery = { publicVersion: version, sourceTurnIds: turns.map((turn) => turn.id), chairTurnIds: chairs, compressions: [], protectedTurnIds: [...protectedIds], omittedTurnIds: [] }
  const packet = { schemaVersion: 1, meetingId: meeting.id, topic: meeting.topic, round: meeting.round, publicVersion: version, history, objections, draft, previousMinutes: meeting.minutes.at(-1), compression: delivery.compressions }
  const render = () => `【系统·版本化公共上下文 v${version}】\n${meetingData(JSON.stringify(packet))}\n`
  const originalLength = render().length
  let currentLength = originalLength
  const bodyContribution = (body: string | undefined) => body === undefined ? 0 : JSON.stringify('body').length + 2 + JSON.stringify(body).length
  const compressionBySource = new Map<string, MeetingTurnDeliveryCompression>()
  const appendCompression = (entry: MeetingTurnDeliveryCompression) => {
    currentLength += JSON.stringify(entry).length + (delivery.compressions!.length ? 1 : 0)
    delivery.compressions!.push(entry)
    compressionBySource.set(entry.source, entry)
  }
  const appendOmitted = (id: string) => {
    delivery.omittedTurnIds!.push(id)
  }
  for (const entry of history) {
    if (currentLength <= limit) break
    if (protectedIds.has(entry.id) || !entry.body || entry.body.length <= 512) continue
    const original = entry.body
    entry.body = `${original.slice(0, 256)}\n[宿主摘录；完整原文按发言ID读取]\n${original.slice(-256)}`
    currentLength += bodyContribution(entry.body) - bodyContribution(original)
    currentLength += JSON.stringify('summary').length - JSON.stringify(entry.representation).length
    entry.representation = 'summary'
    appendCompression({ source: entry.id, originalLength: original.length, keptLength: entry.body.length })
  }
  for (const entry of history) {
    if (currentLength <= limit) break
    if (protectedIds.has(entry.id) || !entry.body) continue
    const compression = compressionBySource.get(entry.id)
    if (compression) {
      currentLength += JSON.stringify({ ...compression, keptLength: 0 }).length - JSON.stringify(compression).length
      compression.keptLength = 0
    } else {
      appendCompression({ source: entry.id, originalLength: entry.body.length, keptLength: 0 })
    }
    currentLength += bodyContribution(undefined) - bodyContribution(entry.body)
    currentLength += JSON.stringify('omitted').length - JSON.stringify(entry.representation).length
    entry.body = undefined
    entry.representation = 'omitted'
    appendOmitted(entry.id)
  }
  const text = render()
  if (text.length !== currentLength) throw new Error(`Meeting context size accounting mismatch (${currentLength}/${text.length})`)
  delivery.compression = { source: 'public-history', originalLength, keptLength: text.length }
  if (text.length > limit) throw new MeetingContextLimitError(`公共上下文超限（${text.length}/${limit} 字符）；未解决质疑、最新修订、用户要求及待确认纪要不截断；受保护发言：${[...protectedIds].join(',')}`, delivery)
  return { text, delivery }
}
