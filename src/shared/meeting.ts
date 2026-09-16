export type MeetingStatus = 'draft' | 'active' | 'waiting_user' | 'concluded' | 'cancelled' | 'failed'
export type MeetingActor = 'host' | 'user'
export type MeetingRole = 'reporter' | 'critic' | 'designer'
export type MeetingTurnPhase = 'report' | 'challenge' | 'defense' | 'synthesis'
export type MeetingStopReason = 'converged' | 'no_progress' | 'budget' | 'failed'

export interface MeetingParticipant {
  agentId: string
  role: MeetingRole
  officeTaskId?: string
}

export interface MeetingObjection {
  id: string
  text: string
  ref: string
  raisedBy: string
  targetAgentId?: string
  priority: 'high' | 'normal'
  resolved: boolean
  resolution?: string
}

export interface MeetingActionItem {
  title: string
  ownerAgentId: string
  acceptance: string[]
  approval: 'pending' | 'approved' | 'rejected'
  taskId?: string
}

export interface MeetingMinutes {
  round: number
  summary?: string
  decisions: string[]
  objections: MeetingObjection[]
  actionItems: MeetingActionItem[]
  openQuestions: string[]
  provenance: 'consensus:advisory'
}

export interface MeetingTurn {
  id: string
  meetingId: string
  round: number
  phase: MeetingTurnPhase
  agentId: string
  officeTaskId: string
  status: 'pending' | 'speaking' | 'done' | 'failed' | 'skipped'
  summary?: string
  startedAt?: number
  endedAt?: number
}

export interface MeetingCurrentTurn {
  agentId: string
  role: MeetingRole
  phase: MeetingTurnPhase
  startedAt: number
}

export interface Meeting {
  id: string
  issueId: string
  topic: string
  participants: MeetingParticipant[]
  status: MeetingStatus
  round: number
  maxRounds: number
  maxInnerTurns: number
  maxDurationMs: number
  minutes: MeetingMinutes[]
  noProgress: number
  noProgressCap: number
  failures: number
  stopReason?: MeetingStopReason
  blockedReason?: string
  pendingChairNotes: string[]
  /** 当前正在发言的与会者（每次发言开始即推送；一回合真实可达 5-15 分钟，不能等轮末才有反馈） */
  currentTurn?: MeetingCurrentTurn
  createdAt: number
  updatedAt: number
  concludedAt?: number
}

export interface MeetingCreateInput {
  issueId: string
  topic: string
  participants: MeetingParticipant[]
  maxRounds?: number
  maxInnerTurns?: number
  maxDurationMs?: number
  noProgressCap?: number
}

export const DEFAULT_MEETING_MAX_ROUNDS = 6
export const DEFAULT_MEETING_MAX_INNER_TURNS = 3
/** 真实三队长会议单轮（模型思考 + 只读调查）可达 10-15 分钟，30 分钟一场就爆（iss_t_mu3uprnm 实测）。 */
export const DEFAULT_MEETING_MAX_DURATION_MS = 60 * 60 * 1000
export const DEFAULT_MEETING_NO_PROGRESS_CAP = 2

const MEETING_TRANSITIONS: Record<MeetingActor, Record<MeetingStatus, readonly MeetingStatus[]>> = {
  host: {
    draft: ['active', 'cancelled', 'failed'],
    active: ['waiting_user', 'concluded', 'cancelled', 'failed'],
    waiting_user: ['active', 'cancelled', 'failed'],
    concluded: [],
    cancelled: [],
    failed: []
  },
  user: {
    draft: ['active', 'cancelled'],
    active: ['waiting_user', 'cancelled'],
    waiting_user: ['active', 'cancelled'],
    concluded: [],
    cancelled: [],
    failed: ['active', 'cancelled']
  }
}

export const TERMINAL_MEETING_STATUSES: readonly MeetingStatus[] = ['concluded', 'cancelled', 'failed']

export function canTransitionMeeting(from: MeetingStatus, to: MeetingStatus, actor: MeetingActor): boolean {
  if (from === to) return true
  return MEETING_TRANSITIONS[actor][from].includes(to)
}

export function validateMeetingTransition(from: MeetingStatus, to: MeetingStatus, actor: MeetingActor): { ok: true } | { ok: false; error: string } {
  if (!canTransitionMeeting(from, to, actor)) return { ok: false, error: `Invalid meeting transition: ${from} -> ${to}` }
  return { ok: true }
}

export function isTerminalMeetingStatus(status: MeetingStatus): boolean {
  return TERMINAL_MEETING_STATUSES.includes(status)
}

