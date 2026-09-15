import { ipcMain } from 'electron'
import { parseContent, parseId, parseNonNegativeInteger } from '../ipc-validation'
import type { MeetingCreateInput, MeetingRole } from '../../shared/meeting'
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

export function registerMeetingIpc(ctx: IpcContext) {
  const send = (channel: string, payload: unknown) => ctx.getWindow()?.webContents.send(channel, payload)
  ipcMain.handle('meetings:list', () => ctx.meetingController.list())
  ipcMain.handle('meetings:get', (_event, id: unknown) => ctx.meetingController.get(parseId(id, 'meetingId')))
  ipcMain.handle('meetings:create', (_event, input: unknown) => {
    const meeting = ctx.meetingController.create(parseMeetingCreate(input))
    send('meetings:updated', meeting)
    return meeting
  })
  ipcMain.handle('meetings:start', async (_event, id: unknown) => {
    const result = await ctx.meetingController.start(parseId(id, 'meetingId'))
    if (result.meeting) send('meetings:updated', result.meeting)
    return { ok: result.ok, ...(result.error ? { error: result.error } : {}) }
  })
  ipcMain.handle('meetings:pause', (_event, id: unknown) => {
    const result = ctx.meetingController.pause(parseId(id, 'meetingId'))
    if (result.meeting) send('meetings:updated', result.meeting)
    return { ok: result.ok, ...(result.error ? { error: result.error } : {}) }
  })
  ipcMain.handle('meetings:resume', async (_event, id: unknown) => {
    const result = await ctx.meetingController.resume(parseId(id, 'meetingId'))
    if (result.meeting) send('meetings:updated', result.meeting)
    return { ok: result.ok, ...(result.error ? { error: result.error } : {}) }
  })
  ipcMain.handle('meetings:interject', (_event, id: unknown, note: unknown) => {
    const result = ctx.meetingController.interject(parseId(id, 'meetingId'), parseContent(note, '插话'))
    if (result.meeting) send('meetings:updated', result.meeting)
    return { ok: result.ok, ...(result.error ? { error: result.error } : {}) }
  })
  ipcMain.handle('meetings:cancel', async (_event, id: unknown) => {
    const result = await ctx.meetingController.cancel(parseId(id, 'meetingId'))
    if (result.meeting) send('meetings:updated', result.meeting)
    return { ok: result.ok, ...(result.error ? { error: result.error } : {}) }
  })
  ipcMain.handle('meetings:approve-action', (_event, id: unknown, index: unknown, verdict: unknown) => {
    const itemIndex = parseNonNegativeInteger(index, 'itemIndex')
    if (verdict !== 'approved' && verdict !== 'rejected') throw new Error('verdict 无效')
    const result = ctx.meetingController.approveAction(parseId(id, 'meetingId'), itemIndex, verdict)
    if (result.meeting) send('meetings:updated', result.meeting)
    return { ok: result.ok, ...(result.error ? { error: result.error } : {}) }
  })
  ipcMain.handle('meetings:delete', (_event, id: unknown) => {
    const meetingId = parseId(id, 'meetingId')
    const result = ctx.meetingController.delete(meetingId)
    if (result.ok) send('meetings:deleted', meetingId)
    return result
  })
}
