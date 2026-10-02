export type MeetingStatus = 'draft' | 'active' | 'waiting_user' | 'concluded' | 'cancelled' | 'failed'
export type MeetingActor = 'host' | 'user'
export type MeetingRole = 'reporter' | 'critic' | 'designer'
export type MeetingTurnPhase = 'report' | 'challenge' | 'defense' | 'synthesis'
export type MeetingStopReason = 'converged' | 'no_progress' | 'budget' | 'failed'

export interface MeetingParticipant {
  agentId: string
  role: MeetingRole
  officeTaskId?: string
  sessionTaskId?: string
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
  sourceTurnId?: string
  replyTurnId?: string
  reviewTurnId?: string
  reviewVersion?: number
}

export interface MeetingActionItem {
  title: string
  ownerAgentId: string
  acceptance: string[]
  approval: 'pending' | 'approved' | 'rejected'
  taskId?: string
}

export interface MeetingConfirmation {
  agentId: string
  turnId: string
  minutesVersion: string
  contextVersion: number
  chairTurnIds: string[]
  verdict: 'agree' | 'disagree' | 'abstain' | 'invalid'
}

export interface MeetingMinutes {
  round: number
  summary?: string
  decisions: string[]
  objections: MeetingObjection[]
  actionItems: MeetingActionItem[]
  openQuestions: string[]
  provenance: 'consensus:advisory'
  version?: string
  confirmations?: MeetingConfirmation[]
}

export type MeetingTurnStatus = 'pending' | 'speaking' | 'done' | 'failed' | 'skipped' | 'cancelled'
/** purpose 区分发言性质：speech 正式发言、review 质疑/复核、confirmation 确认、minutes 纪要、chair 用户插话（保留为事实记录） */
export type MeetingTurnPurpose = 'speech' | 'review' | 'confirmation' | 'minutes' | 'chair'

/** 发言时的姓名/角色/平台快照：此后改名或卸载平台不抹掉旧发言者归属 */
export interface MeetingSpeakerSnapshot {
  name: string
  role: string
  platform: string
}

/** Issue 评论镜像状态：镜像失败可重试，不影响权威发言读取 */
export interface MeetingTurnMirror {
  state: 'pending' | 'published' | 'failed' | 'skipped'
  attempts?: number
  lastError?: string
  commentId?: string
}

export interface MeetingTurnDeliveryCompression {
  source: string
  originalLength: number
  keptLength: number
}

/** 投递元数据与正文独立持久化：保留完整来源ID和压缩账本，不进入整体索引或状态广播 */
export interface MeetingTurnDelivery {
  publicVersion?: number
  sourceTurnIds?: string[]
  chairTurnIds?: string[]
  compression?: MeetingTurnDeliveryCompression
  compressions?: MeetingTurnDeliveryCompression[]
  protectedTurnIds?: string[]
  omittedTurnIds?: string[]
  attempts?: Array<{ taskId: string; runId: string; turnId: string; dispatchedAt: number }>
}

export interface MeetingTurn {
  id: string
  meetingId: string
  round: number
  phase: MeetingTurnPhase
  agentId: string
  officeTaskId: string
  sessionTaskId?: string
  status: MeetingTurnStatus
  summary?: string
  startedAt?: number
  endedAt?: number
  /** 会议内稳定顺序号（存储分配、调用方不可指定）；旧记录缺省按 0 排在最前 */
  sequence?: number
  /** 会议级变更水位：记录保存最后一次成功变更的水位；旧记录缺省按 0 */
  version?: number
  purpose?: MeetingTurnPurpose
  speaker?: MeetingSpeakerSnapshot
  runId?: string
  executionTurnId?: string
  contextVersion?: number
  executionEpoch?: number
  error?: string
  mirror?: MeetingTurnMirror
  delivery?: MeetingTurnDelivery
  publicVersion?: number
  bodyVersion?: number
  deliveredAt?: number
  deliveryState?: 'prepared' | 'dispatched' | 'accepted' | 'failed'
  minutesVersion?: string
}

/** 完整发言详情：正文独立存储，仅经 getTurn/readTurns 拉取，不进入整体索引或广播 */
export interface MeetingTurnDetail extends MeetingTurn {
  body?: string
  bodyError?: string
}

export interface MeetingMemberExecutions {
  agentId: string
  sessionTaskId?: string
  turns: MeetingTurn[]
  investigations: Array<{ taskId: string; parentTaskId?: string; runId?: string; status: string }>
}

export interface MeetingTurnReadQuery {
  afterSequence?: number
  afterVersion?: number
  limit?: number
  cursor?: string
}

export interface MeetingTurnPage {
  meetingId: string
  turns: MeetingTurnDetail[]
  latestVersion: number
  hasMore: boolean
  nextCursor?: string
}

export type MeetingTurnUpdatePatch = Partial<Omit<MeetingTurn, 'id' | 'meetingId' | 'sequence' | 'version'>>

export interface MeetingCurrentTurn {
  agentId: string
  role: MeetingRole
  phase: MeetingTurnPhase
  startedAt: number
}

export interface Meeting {
  id: string
  issueId: string
  containerTaskId?: string
  ownsIssue?: boolean
  workdir?: string
  executionEpoch?: number
  stopState?: 'stopping' | 'failed'
  deleting?: boolean
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
  publicVersion?: number
  turnVersion?: number
  objections?: MeetingObjection[]
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
