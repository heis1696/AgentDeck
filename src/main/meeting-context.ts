import type { Meeting, MeetingObjection, MeetingTurnDelivery, MeetingTurnDetail } from '../shared/meeting'
import type { MeetingStore } from './meeting-store'
import { meetingData } from './prompts/meeting'

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

export function assembleMeetingContext(store: MeetingStore, meeting: Meeting, objections: MeetingObjection[], draft?: { version: string; envelope: unknown }): { text: string; delivery: MeetingTurnDelivery } {
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
    representation: 'complete' as const
  }))
  const version = allTurns.reduce((maximum, turn) => Math.max(maximum, turn.publicVersion ?? 0), 0)
  const chairs = allTurns.filter((turn) => turn.purpose === 'chair' && turn.status === 'done').map((turn) => turn.id).sort()
  const delivery: MeetingTurnDelivery = { publicVersion: version, sourceTurnIds: turns.map((turn) => turn.id), chairTurnIds: chairs, compressions: [], protectedTurnIds: [...protectedIds], omittedTurnIds: [] }
  const packet = { schemaVersion: 1, meetingId: meeting.id, topic: meeting.topic, round: meeting.round, publicVersion: version, history, objections, draft, previousMinutes: meeting.minutes.at(-1), compression: delivery.compressions }
  const text = `【系统·版本化公共上下文 v${version}】\n${meetingData(JSON.stringify(packet))}\n`
  delivery.compression = { source: 'public-history', originalLength: text.length, keptLength: text.length }
  return { text, delivery }
}
