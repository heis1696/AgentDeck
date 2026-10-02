import { ipcMain } from 'electron'
import { parseContent, parseId, parseNonNegativeInteger } from '../ipc-validation'
import type { MeetingCreateInput, MeetingRole, MeetingTurnReadQuery } from '../../shared/meeting'
import type { IpcContext } from './context'

function parseMeetingCreate(value: unknown): MeetingCreateInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('会议参数必须是对象')
  const input = value as Record<string, unknown>
  const allowed = new Set(['issueId', 'topic', 'participants', 'maxRounds', 'maxInnerTurns', 'maxDurationMs', 'noProgressCap'])
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`会议参数包含未知字段: ${key}`)
  if (typeof input.issueId !== 'string' || !input.issueId.trim()) throw new Error('issueId 不能为空')
  if (typeof input.topic !== 'string' || !input.topic.trim()) throw new Error('topic 不能为空')
  if (!Array.isArray(input.participants)) throw new Error('participants 必须是数组')
  const participants = input.participants.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`participants[${index}] 无效`)
    const item = raw as Record<string, unknown>
    if (typeof item.agentId !== 'string' || !item.agentId.trim()) throw new Error(`participants[${index}].agentId 无效`)
    if (item.role !== 'reporter' && item.role !== 'critic' && item.role !== 'designer') throw new Error(`participants[${index}].role 无效`)
    return { agentId: item.agentId.trim(), role: item.role as MeetingRole }
  })
  const positive = (name: string) => {
    const candidate = input[name]
    if (candidate === undefined) return undefined
    if (typeof candidate !== 'number' || !Number.isInteger(candidate) || candidate < 1) throw new Error(`${name} 必须是正整数`)
    return candidate
  }
  const maxRounds = positive('maxRounds')
  const maxInnerTurns = positive('maxInnerTurns')
  const noProgressCap = positive('noProgressCap')
  const maxDurationMs = input.maxDurationMs
  if (maxDurationMs !== undefined && (typeof maxDurationMs !== 'number' || !Number.isFinite(maxDurationMs) || maxDurationMs < 1)) throw new Error('maxDurationMs 必须是正数')
  return {
    issueId: input.issueId.trim(),
    topic: input.topic.trim(),
    participants,
    ...(maxRounds !== undefined ? { maxRounds } : {}),
    ...(maxInnerTurns !== undefined ? { maxInnerTurns } : {}),
    ...(maxDurationMs !== undefined ? { maxDurationMs: maxDurationMs as number } : {}),
    ...(noProgressCap !== undefined ? { noProgressCap } : {})
  }
}

export function parseMeetingTurnQuery(value: unknown): MeetingTurnReadQuery {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('发言读取参数必须是对象')
  const input = value as Record<string, unknown>
  const output: MeetingTurnReadQuery = {}
  for (const key of Object.keys(input)) {
    if (!['afterSequence', 'afterVersion', 'limit', 'cursor'].includes(key)) throw new Error(`未知发言读取参数: ${key}`)
  }
  for (const key of ['afterSequence', 'afterVersion', 'limit'] as const) {
    const value = input[key]
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (key === 'limit' ? 1 : 0) || key === 'limit' && value > 500) throw new Error(`无效的 ${key}`)
    output[key] = value
  }
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== 'string' || !input.cursor || input.cursor.length > 2048) throw new Error('无效的 cursor')
    output.cursor = input.cursor
  }
  return output
}

export function registerMeetingIpc(ctx: IpcContext) {
  const send = (channel: string, payload: unknown) => ctx.getWindow()?.webContents.send(channel, payload)
  ipcMain.handle('meetings:list', () => ctx.meetingController.list())
  ipcMain.handle('meetings:get', (_event, id: unknown) => ctx.meetingController.get(parseId(id, 'meetingId')))
  ipcMain.handle('meetings:read-turns', (_event, id: unknown, query: unknown) => ctx.meetingController.readTurns(parseId(id, 'meetingId'), parseMeetingTurnQuery(query)))
  ipcMain.handle('meetings:get-turn', (_event, id: unknown, turnId: unknown) => ctx.meetingController.getTurn(parseId(id, 'meetingId'), parseId(turnId, 'turnId')))
  ipcMain.handle('meetings:member-executions', (_event, id: unknown, agentId: unknown) => ctx.meetingController.memberExecutions(parseId(id, 'meetingId'), parseId(agentId, 'agentId')))
  ipcMain.handle('meetings:retry-mirrors', (_event, id: unknown) => {
    const result = ctx.meetingController.retryMirrors(parseId(id, 'meetingId'))
    return { ok: result.ok, ...(result.error ? { error: result.error } : {}) }
  })
  ipcMain.handle('meetings:create', (_event, input: unknown) => {
    const meeting = ctx.meetingController.create(parseMeetingCreate(input))
    send('meetings:updated', meeting)
    return meeting
  })
  ipcMain.handle('meetings:start', async (_event, id: unknown) => {
    const result = await ctx.meetingController.start(parseId(id, 'meetingId'))
    return { ok: result.ok, ...(result.error ? { error: result.error } : {}) }
  })
  ipcMain.handle('meetings:pause', (_event, id: unknown) => {
    const result = ctx.meetingController.pause(parseId(id, 'meetingId'))
    return { ok: result.ok, ...(result.error ? { error: result.error } : {}) }
  })
  ipcMain.handle('meetings:resume', async (_event, id: unknown) => {
    const result = await ctx.meetingController.resume(parseId(id, 'meetingId'))
    return { ok: result.ok, ...(result.error ? { error: result.error } : {}) }
  })
  ipcMain.handle('meetings:interject', (_event, id: unknown, note: unknown) => {
    const result = ctx.meetingController.interject(parseId(id, 'meetingId'), parseContent(note, '插话'))
    return { ok: result.ok, ...(result.error ? { error: result.error } : {}) }
  })
  ipcMain.handle('meetings:cancel', async (_event, id: unknown) => {
    const result = await ctx.meetingController.cancel(parseId(id, 'meetingId'))
    return { ok: result.ok, ...(result.error ? { error: result.error } : {}) }
  })
  ipcMain.handle('meetings:approve-action', (_event, id: unknown, index: unknown, verdict: unknown) => {
    const itemIndex = parseNonNegativeInteger(index, 'itemIndex')
    if (verdict !== 'approved' && verdict !== 'rejected') throw new Error('verdict 无效')
    const result = ctx.meetingController.approveAction(parseId(id, 'meetingId'), itemIndex, verdict)
    return { ok: result.ok, ...(result.error ? { error: result.error } : {}) }
  })
  ipcMain.handle('meetings:delete', async (_event, id: unknown) => {
    const meetingId = parseId(id, 'meetingId')
    const result = await ctx.meetingController.delete(meetingId)
    if (result.ok) send('meetings:deleted', meetingId)
    return result
  })
}
