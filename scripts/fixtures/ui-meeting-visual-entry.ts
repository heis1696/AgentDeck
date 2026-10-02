import './ui-draft-bridge'
import '../../src/renderer/src/main'
import { getDraftBridge } from './ui-draft-bridge'
import { ui } from '../../src/renderer/src/ui/interaction-center'
import { DEFAULT_SETTINGS } from '../../src/shared/types'
import type { Meeting, MeetingTurnDetail } from '../../src/shared/meeting'

const mock = getDraftBridge()
const api = window.agentdeck
const now = Date.now()
const container = mock.seedTask({ id: 'visual_container', title: '评审：团队会议公开讨论与执行隔离', status: 'running' })
Object.assign(container, { meetingId: 'visual', meetingTaskRole: 'container' })
const participants = [
  { agentId: 'agent_c1', role: 'reporter' as const, sessionTaskId: 'visual_member_a', name: 'ZCode 工程队长', platform: 'ZCode' },
  { agentId: 'agent_c2', role: 'critic' as const, sessionTaskId: 'visual_member_b', name: 'Claude 质疑队长', platform: 'Claude' },
  { agentId: 'agent_c3', role: 'designer' as const, sessionTaskId: 'visual_member_c', name: 'Codex 架构队长', platform: 'Codex' }
]
for (const [index, participant] of participants.entries()) {
  const task = mock.seedTask({ id: participant.sessionTaskId, title: participant.name, status: 'running' })
  Object.assign(task, { meetingId: 'visual', meetingTaskRole: 'member', suppressIssue: true, runId: `run_${index + 1}`, backend: participant.platform.toLowerCase() })
}
const investigation = mock.seedTask({ id: 'visual_investigation', title: '核验历史日志与停止屏障', status: 'running', parentTaskId: 'visual_member_b' })
Object.assign(investigation, { meetingId: 'visual', meetingTaskRole: 'investigation', suppressIssue: true, runId: 'run_investigation' })
mock.store.issues = mock.store.issues.filter((issue) => issue.taskId === container.id)
let meeting: Meeting = {
  id: 'visual', issueId: container.issueId!, containerTaskId: container.id, ownsIssue: true,
  topic: container.title, participants, status: 'active', round: 1, maxRounds: 3,
  maxInnerTurns: 3, maxDurationMs: 600000, minutes: [], noProgress: 0, noProgressCap: 3,
  failures: 0, pendingChairNotes: [], createdAt: now - 360000, updatedAt: now, turnVersion: 3,
  currentTurn: { agentId: 'agent_c3', role: 'designer', phase: 'defense', startedAt: now - 20000 }
}
const turns: MeetingTurnDetail[] = participants.map((participant, index) => ({
  id: `visual_speech_${index + 1}`, meetingId: 'visual', round: 1,
  phase: (['report', 'challenge', 'defense'] as const)[index], agentId: participant.agentId,
  officeTaskId: '', sessionTaskId: participant.sessionTaskId, runId: `run_${index + 1}`,
  executionTurnId: `execution_${index + 1}`, sequence: index + 1, version: index + 1,
  purpose: 'speech', status: index === 2 ? 'speaking' : 'done', contextVersion: index,
  speaker: { name: participant.name, platform: participant.platform, role: participant.role },
  startedAt: now - (3 - index) * 70000, endedAt: index === 2 ? undefined : now - (3 - index) * 50000,
  deliveryState: index === 2 ? 'dispatched' : 'accepted', delivery: { publicVersion: index, chairTurnIds: [] },
  body: index === 0 ? '## 方案\n\n公开讨论只保留正式发言；成员的工具和调查放在右侧。\n\n- 一个会议对应一个主 Issue。\n- 页面默认固定用户所选成员。\n- 停止失败不冒充退出确认。'
    : index === 1 ? '我同意展示方向，但还有两个需要复核的边界：\n\n1. 点击旧发言必须定位确切的 **Task / Run / Turn**。\n2. 若容器任务已经删除，仍能从历史会议入口看到正式讨论。\n\n请答辩者说明如何避免把最新一次执行当成这条旧发言。' : undefined
}))
const listeners = new Set<(meeting: Meeting) => void>()
const readQueries: unknown[] = []
api.meetings.list = async () => [structuredClone(meeting)]
api.meetings.get = async (id) => id === meeting.id ? structuredClone(meeting) : null
api.meetings.onUpdated = (callback) => { listeners.add(callback); return () => listeners.delete(callback) }
api.meetings.readTurns = async (id, query = {}) => {
  readQueries.push(structuredClone(query))
  const selected = turns.filter((turn) => query.afterVersion === undefined || turn.version! > query.afterVersion)
  const offset = Number(query.cursor ?? 0)
  const chunk = selected.slice(offset, offset + 2)
  const hasMore = offset + 2 < selected.length
  return { meetingId: id, turns: structuredClone(chunk), latestVersion: meeting.turnVersion!, hasMore, ...(hasMore ? { nextCursor: String(offset + 2) } : {}) }
}
api.meetings.getTurn = async (id, turnId) => id === meeting.id ? structuredClone(turns.find((turn) => turn.id === turnId) ?? null) : null
api.meetings.memberExecutions = async (id, agentId) => ({
  agentId, sessionTaskId: participants.find((participant) => participant.agentId === agentId)?.sessionTaskId,
  turns: structuredClone(turns.filter((turn) => turn.agentId === agentId)),
  investigations: agentId === 'agent_c2' ? [{ taskId: investigation.id, runId: investigation.runId, status: investigation.status }] : []
})
api.tasks.events = async (taskId) => taskId === 'visual_member_b' ? [
  { taskId, seq: 1, ts: now - 120000, kind: 'user', text: '核验公开输入 v1 和前一位的正式报告。', execution: { runId: 'run_2', turnId: 'execution_2' } },
  { taskId, seq: 2, ts: now - 118000, kind: 'text', text: '精确历史执行日志：只属于这条质疑发言。', execution: { runId: 'run_2', turnId: 'execution_2' } },
  { taskId, seq: 3, ts: now - 100000, kind: 'final', text: '精确历史执行日志：两个边界已明确，等待答辩。', execution: { runId: 'run_2', turnId: 'execution_2' } },
  { taskId, seq: 4, ts: now, kind: 'text', text: 'OTHER_RUN_SECRET', execution: { runId: 'run_new', turnId: 'execution_new' } }
] : []
let settings = { ...DEFAULT_SETTINGS, theme: 'dark' as const }
const settingsListeners = new Set<(settings: typeof DEFAULT_SETTINGS) => void>()
api.settings.get = async () => settings
api.settings.set = async (patch) => { settings = { ...settings, ...patch } as typeof settings; for (const callback of settingsListeners) callback(settings); return settings }
api.settings.onUpdated = (callback) => { settingsListeners.add(callback); return () => settingsListeners.delete(callback) }
const broadcast = () => { for (const callback of listeners) callback(structuredClone(meeting)) }
Object.assign(window, { __meetingVisual: {
  ui, readQueries,
  advance: () => {
    turns[0] = { ...turns[0], version: 4, body: `${turns[0].body}\n\n**旧序号记录已增量更新。**` }
    turns.push({ ...turns[0], id: 'visual_speech_4', sequence: 4, version: 5, status: 'speaking', body: undefined, endedAt: undefined, startedAt: Date.now(), executionTurnId: 'execution_4' })
    meeting = { ...meeting, turnVersion: 5, currentTurn: { agentId: 'agent_c1', role: 'reporter', phase: 'report', startedAt: Date.now() } }
    broadcast()
  },
  showState: (state: 'stopping' | 'failed') => { meeting = { ...meeting, status: 'cancelled', stopState: state, blockedReason: state === 'failed' ? '仍有成员执行未取得退出证明（隔离视觉夹具）。' : undefined }; broadcast() }
} })
ui.openTask('meeting:visual')
