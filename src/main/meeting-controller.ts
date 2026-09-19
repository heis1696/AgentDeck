import type { AgentLike } from './delegate'
import { AgentSessionRegistry } from './agent-sessions'
import { MeetingStore } from './meeting-store'
import type { TaskService } from './task-service'
import {
  reportPrompt,
  challengePrompt,
  defensePrompt,
  synthPrompt,
  forcedSynthesisPrompt,
  renderChairNotes,
  meetingData,
  actionItemTaskPrompt
} from './prompts/meeting'
import {
  canTransitionMeeting,
  DEFAULT_MEETING_MAX_INNER_TURNS,
  type Meeting,
  type MeetingActionItem,
  type MeetingCreateInput,
  type MeetingMinutes,
  type MeetingObjection,
  type MeetingParticipant,
  type MeetingRole,
  type MeetingStopReason,
  type MeetingTurn,
  type MeetingTurnPhase
} from '../shared/meeting'

export interface MeetingControllerOptions {
  store: MeetingStore
  offices: AgentSessionRegistry
  getAgents: () => AgentLike[]
  taskService?: Pick<TaskService, 'createTask'>
  startTask?: (taskId: string) => void
  addIssueComment?: (issueId: string, content: string, authorId?: string) => void
  cancelTask?: (taskId: string) => Promise<{ ok: boolean; error?: string }>
  issueExists?: (issueId: string) => boolean
  now?: () => number
}

export interface MeetingResult {
  ok: boolean
  error?: string
  meeting?: Meeting
}

interface Stance { verdict: 'agree' | 'disagree' | 'abstain'; grounds: string }
interface Envelope {
  decisions: string[]
  objections: Array<{ text: string; ref: string; resolved: boolean; resolution?: string; targetAgentId?: string; priority?: 'high' | 'normal' }>
  actionItems: Array<{ title: string; owner: string; acceptance: string[] }>
  openQuestions: string[]
}

interface RoundRun {
  reportText: string
  stances: Map<string, Stance>
  objections: MeetingObjection[]
  envelope: Envelope | null
  turns: MeetingTurn[]
}

const TERMINAL = new Set(['done', 'failed', 'cancelled'])

function attr(attrs: string, name: string): string | undefined {
  const match = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'))
  return match?.[2]?.trim() || undefined
}

export function parseStance(text: string): Stance | null {
  const lines = text.trim().split(/\r?\n/)
  const last = lines[lines.length - 1]?.trim() ?? ''
  if (!last.startsWith('<stance')) return null
  const matches = [...text.matchAll(/<stance\b([^>]*)\/>/gi)]
  const match = matches[matches.length - 1]
  if (!match) return null
  const verdict = attr(match[1], 'verdict')
  const grounds = attr(match[1], 'grounds') ?? ''
  if (verdict !== 'agree' && verdict !== 'disagree' && verdict !== 'abstain') return null
  return { verdict, grounds }
}

export function stripMeetingTags(text: string): string {
  return text
    .replace(/<stance\b[^>]*\/>/gi, '')
    .replace(/<objection\b[^>]*>[\s\S]*?<\/objection>/gi, '')
    .trim()
}

export function parseObjections(text: string, raisedBy: string, defaultTargetAgentId?: string): MeetingObjection[] {
  const out: MeetingObjection[] = []
  const tags = /<objection\b([^>]*)>([\s\S]*?)<\/objection>/gi
  let match: RegExpExecArray | null
  while ((match = tags.exec(text))) {
    const body = match[2].trim()
    const ref = attr(match[1], 'ref')
    if (!body || !ref) continue
    const targetAgentId = attr(match[1], 'target') ?? defaultTargetAgentId
    out.push({ id: `obj_${out.length + 1}`, text: body, ref, raisedBy, targetAgentId, priority: attr(match[1], 'priority') === 'high' ? 'high' : 'normal', resolved: false })
  }
  if (out.length) return out.slice(0, 3)
  // Conservative markdown fallback: only lines with an explicit ref count.
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:[-*]\s*)?(?:反对|objection)\s*\[([^\]]+)\]\s*[:：]\s*(.+)$/i)
    if (!m) continue
    out.push({ id: `obj_${out.length + 1}`, text: m[2].trim(), ref: m[1].trim(), raisedBy, targetAgentId: defaultTargetAgentId, priority: out.length === 0 ? 'high' : 'normal', resolved: false })
    if (out.length >= 3) break
  }
  return out
}

function validEnvelope(value: unknown): value is Envelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  if (!Array.isArray(item.decisions) || !item.decisions.every((entry) => typeof entry === 'string')) return false
  const objections = Array.isArray(item.objections) ? item.objections : []
  if (!objections.every((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
    const row = entry as Record<string, unknown>
    return typeof row.text === 'string' && typeof row.ref === 'string' && typeof row.resolved === 'boolean'
  })) return false
  const actionItems = Array.isArray(item.actionItems) ? item.actionItems : []
  if (!actionItems.every((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
    const row = entry as Record<string, unknown>
    return typeof row.title === 'string' && typeof row.owner === 'string' && Array.isArray(row.acceptance) && row.acceptance.every((v) => typeof v === 'string')
  })) return false
  const openQuestions = Array.isArray(item.openQuestions) ? item.openQuestions : []
  if (!openQuestions.every((entry) => typeof entry === 'string')) return false
  return true
}

function extractJson(text: string): unknown {
  const candidates = [
    text.trim(),
    ...[...text.matchAll(/```json\s*([\s\S]*?)```/gi)].map((match) => match[1]),
    text.match(/\{[\s\S]*\}/)?.[0]
  ].filter((candidate): candidate is string => !!candidate)
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (validEnvelope(parsed)) return parsed
    } catch {}
  }
  return null
}

export function parseEnvelope(text: string): Envelope | null {
  const parsed = extractJson(text)
  if (validEnvelope(parsed)) return parsed
  return null
}

const PHASE_LABEL: Record<MeetingTurnPhase, string> = { report: '汇报', challenge: '质疑', defense: '答辩', synthesis: '综合' }
const ROLE_LABEL: Record<MeetingRole, string> = { reporter: '汇报', critic: '质疑', designer: '答辩' }

function isCaptain(agent: AgentLike): boolean {
  return !!agent.role && /队长|领队|captain|leader/i.test(agent.role) || (agent.subordinates?.length ?? 0) > 0
}

function uniqueObjections(rows: MeetingObjection[]): MeetingObjection[] {
  const seen = new Set<string>()
  return rows.filter((row) => {
    const key = `${row.ref}\n${row.text}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 3)
}

export class MeetingController {
  private readonly store: MeetingStore
  private readonly offices: AgentSessionRegistry
  private readonly getAgents: () => AgentLike[]
  private readonly taskService?: Pick<TaskService, 'createTask'>
  private readonly startTask?: (taskId: string) => void
  private readonly addIssueComment?: MeetingControllerOptions['addIssueComment']
  private readonly cancelTask?: MeetingControllerOptions['cancelTask']
  private readonly issueExists?: (issueId: string) => boolean
  private readonly now: () => number
  private readonly running = new Set<string>()
  private readonly pauseRequested = new Set<string>()
  private readonly listeners = new Set<(meeting: Meeting) => void>()

  constructor(options: MeetingControllerOptions) {
    this.store = options.store
    this.offices = options.offices
    this.getAgents = options.getAgents
    this.taskService = options.taskService
    this.startTask = options.startTask
    this.addIssueComment = options.addIssueComment
    this.cancelTask = options.cancelTask
    this.issueExists = options.issueExists
    this.now = options.now ?? Date.now
  }

  list() { return this.store.list() }
  get(id: string) { return this.store.get(id) }
  subscribe(listener: (meeting: Meeting) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private save(id: string, patch: Partial<Meeting>) {
    const updated = this.store.update(id, patch)
    if (updated) for (const listener of this.listeners) listener(updated)
    return updated
  }

  create(input: MeetingCreateInput): Meeting {
    if (this.issueExists && !this.issueExists(input.issueId)) throw new Error(`Issue 不存在: ${input.issueId}`)
    const ids = new Set<string>()
    for (const participant of input.participants) {
      if (ids.has(participant.agentId)) throw new Error('会议参与者不能重复')
      ids.add(participant.agentId)
      const agent = this.getAgents().find((candidate) => candidate.id === participant.agentId)
      if (!agent) throw new Error(`会议队长不存在: ${participant.agentId}`)
      if (agent.backend.toLowerCase() === 'dsh') throw new Error('DeepSeek Harness 不支持会议续聊')
      if (!isCaptain(agent)) throw new Error(`只有队长可以参加会议: ${agent.name}`)
    }
    if (!input.participants.some((participant) => participant.role === 'reporter')) throw new Error('会议必须有 reporter')
    if (!input.participants.some((participant) => participant.role === 'designer')) throw new Error('会议必须有 designer')
    return this.store.create(input)
  }

  async start(id: string): Promise<MeetingResult> {
    const meeting = this.store.get(id)
    if (!meeting) return { ok: false, error: '会议不存在' }
    if (meeting.status === 'draft') {
      if (this.store.list().some((item) => item.status === 'active' && item.id !== id)) return { ok: false, error: '已有会议正在进行' }
      this.save(id, { status: 'active', round: 1, stopReason: undefined, blockedReason: undefined })
    } else if (meeting.status !== 'active') {
      return { ok: false, error: `会议当前状态不可启动: ${meeting.status}` }
    }
    if (this.store.list().some((item) => item.status === 'active' && item.id !== id)) return { ok: false, error: '已有会议正在进行' }
    if (this.running.has(id)) return { ok: false, error: '会议正在运行' }
    this.running.add(id)
    try {
      return await this.run(id)
    } finally {
      this.running.delete(id)
    }
  }

  async resume(id: string): Promise<MeetingResult> {
    const meeting = this.store.get(id)
    if (!meeting || meeting.status !== 'waiting_user') return { ok: false, error: '会议不在 waiting_user' }
    if (this.store.list().some((item) => item.status === 'active')) return { ok: false, error: '已有会议正在进行' }
    this.save(id, { status: 'active', stopReason: undefined, blockedReason: undefined })
    return this.start(id)
  }

  pause(id: string): MeetingResult {
    const meeting = this.store.get(id)
    if (!meeting || meeting.status !== 'active') return { ok: false, error: '会议不在 active' }
    this.pauseRequested.add(id)
    if (!this.running.has(id)) this.save(id, { status: 'waiting_user', stopReason: 'no_progress', blockedReason: '用户请求暂停', currentTurn: undefined })
    return { ok: true, meeting: this.store.get(id) ?? meeting }
  }

  async cancel(id: string): Promise<MeetingResult> {
    const meeting = this.store.get(id)
    if (!meeting || ['concluded', 'cancelled'].includes(meeting.status)) return { ok: false, error: '会议不可取消' }
    this.pauseRequested.add(id)
    for (const participant of meeting.participants) {
      const office = this.offices.get(participant.agentId)
      if (office && this.cancelTask) await this.cancelTask(office.id)
    }
    this.save(id, { status: 'cancelled', stopReason: undefined, blockedReason: '用户取消会议', currentTurn: undefined })
    return { ok: true, meeting: this.store.get(id) ?? meeting }
  }

  interject(id: string, note: string): MeetingResult {
    const meeting = this.store.get(id)
    if (!meeting || meeting.status !== 'active') return { ok: false, error: '会议不在 active' }
    const value = note.trim()
    if (!value) return { ok: false, error: '插话不能为空' }
    this.save(id, { pendingChairNotes: [...meeting.pendingChairNotes, value] })
    return { ok: true, meeting: this.store.get(id) ?? meeting }
  }

  delete(id: string): MeetingResult {
    const meeting = this.store.get(id)
    if (!meeting) return { ok: false, error: '会议不存在' }
    if (this.running.has(id) || meeting.status === 'active') return { ok: false, error: '请先停止运行中的会议' }
    return this.store.delete(id) ? { ok: true } : { ok: false, error: '会议删除失败' }
  }

  approveAction(meetingId: string, itemIndex: number, verdict: 'approved' | 'rejected'): MeetingResult {
    const meeting = this.store.get(meetingId)
    if (!meeting || meeting.status !== 'concluded') return { ok: false, error: '只有已结束会议可以审批行动项' }
    const minutes = meeting.minutes[meeting.minutes.length - 1]
    const item = minutes?.actionItems[itemIndex]
    if (!item) return { ok: false, error: '行动项不存在' }
    item.approval = verdict
    if (verdict === 'approved' && item.taskId) this.startTask?.(item.taskId)
    this.save(meetingId, { minutes: meeting.minutes })
    return { ok: true, meeting: this.store.get(meetingId) ?? meeting }
  }

  recover(): Meeting[] {
    const recovered: Meeting[] = []
    for (const meeting of this.store.list()) {
      if (meeting.status !== 'active') continue
      const updated = this.save(meeting.id, { status: 'waiting_user', stopReason: 'failed', blockedReason: '应用重启导致会议中断，请确认继续' })
      if (updated) recovered.push(updated)
    }
    return recovered
  }

  private async run(id: string): Promise<MeetingResult> {
    let meeting = this.store.get(id)!
    const startedAt = this.now()
    while (meeting.status === 'active') {
      if (this.now() - startedAt >= meeting.maxDurationMs) {
        return await this.stopAfterSynthesis(meeting, 'budget', '会议时长预算耗尽')
      }
      if (this.pauseRequested.has(id)) {
        this.pauseRequested.delete(id)
        const updated = this.save(id, { status: 'waiting_user', stopReason: 'no_progress', blockedReason: '用户请求暂停', currentTurn: undefined })!
        return { ok: true, meeting: updated }
      }
      let round: RoundRun
      try {
        round = await this.runRound(meeting)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        const current = this.store.get(id)
        if (current?.status === 'cancelled') return { ok: true, meeting: current }
        const updated = this.save(id, { status: 'failed', stopReason: 'failed', blockedReason: reason, currentTurn: undefined })!
        return { ok: false, error: reason, meeting: updated }
      }
      const minutes = this.minutesFromRound(meeting.round, round)
      // 熔断键只取稳定语义（未决 ref 集合 + 产出规模）：objection 措辞逐轮漂移（"前三轮"→"前四轮"）曾让 SHA256 全文签名熔断完全失效（iss_t_mu420e1e 实战）
      const loopKeyOf = (minutes: MeetingMinutes) => JSON.stringify({
        unresolved: minutes.objections.filter((objection) => !objection.resolved).map((objection) => objection.ref).sort(),
        decisions: minutes.decisions.length,
        actionItems: minutes.actionItems.length,
        openQuestions: minutes.openQuestions.length
      })
      const previous = meeting.minutes[meeting.minutes.length - 1]
      const previousKey = previous ? loopKeyOf(previous) : ''
      const noProgress = previousKey && loopKeyOf(minutes) === previousKey
        ? meeting.noProgress + 1
        : Math.max(0, meeting.noProgress - 1)
      meeting = this.save(id, { minutes: [...meeting.minutes, minutes], round: meeting.round, noProgress, currentTurn: undefined })!
      for (const turn of round.turns) this.store.appendTurn(turn)
      const allAgree = meeting.participants.every((participant) => round.stances.get(participant.agentId)?.verdict === 'agree')
      const allResolved = !!round.envelope && round.objections.every((objection) => objection.resolved)
      if (allAgree && allResolved && !!round.envelope) {
        return this.conclude(meeting, minutes)
      }
      if (meeting.noProgress >= meeting.noProgressCap) return await this.stopAfterSynthesis(meeting, 'no_progress', '连续无进展，请先检查失败根因')
      if (meeting.round >= meeting.maxRounds) return await this.stopAfterSynthesis(meeting, 'budget', '会议轮数预算耗尽')
      meeting = this.save(id, { round: meeting.round + 1 })!
    }
    return { ok: false, error: '会议在执行中被终止', meeting }
  }

  private async runRound(meeting: Meeting): Promise<RoundRun> {
    const turns: MeetingTurn[] = []
    const stances = new Map<string, Stance>()
    const reporter = meeting.participants.find((participant) => participant.role === 'reporter')!
    const reportPromptText = reportPrompt(this.chairNotes(meeting), meeting.round, meeting.topic)
    const reportText = await this.speak(meeting, reporter, 'report', reportPromptText, turns)
    const reportStance = parseStance(reportText)
    if (reportStance) stances.set(reporter.agentId, reportStance)
    let objections: MeetingObjection[] = []
    let envelope: Envelope | null = null
    const critics = meeting.participants.filter((participant) => participant.role === 'critic')
    const designer = meeting.participants.find((participant) => participant.role === 'designer')!
    for (let inner = 0; inner < Math.max(1, meeting.maxInnerTurns); inner++) {
      for (const critic of critics) {
        const prompt = challengePrompt(this.chairNotes(meeting), meeting.round, meeting.topic, meetingData(stripMeetingTags(reportText)))
        const text = await this.speak(meeting, critic, 'challenge', prompt, turns)
        const stance = parseStance(text)
        if (stance) stances.set(critic.agentId, stance)
        objections = uniqueObjections([...objections, ...parseObjections(text, critic.agentId)])
      }
      if (!objections.length) break
      const objectionText = objections.map((objection) => `- ${objection.id} [${objection.ref}] ${objection.text}`).join('\n')
      // 答辩必须由被质疑的汇报人执行：designer 无权解决针对汇报的反对，只会输出空 envelope，resolved 永远为 false（iss_t_mu420e1e 死循环根因）
      const defensePromptText = defensePrompt(this.chairNotes(meeting), meeting.round, meeting.topic, meetingData(objectionText))
      const defenseText = await this.speak(meeting, reporter, 'defense', defensePromptText, turns)
      const defenseStance = parseStance(defenseText)
      if (defenseStance) stances.set(reporter.agentId, defenseStance)
      envelope = parseEnvelope(defenseText)
      if (envelope) objections = this.mergeEnvelopeObjections(objections, envelope, reporter.agentId)
      if (objections.every((objection) => objection.resolved)) break
    }
    if ((!objections.length || objections.every((objection) => objection.resolved)) && designer) {
      // 综合轮：反对清零后由设计者把共识固化为 decisions/actionItems（conclude 依赖有效 envelope）
      const resolutionText = objections.length
        ? objections.map((objection) => `- [${objection.ref}] ${objection.resolved ? '已解决' : '未决'}：${objection.text}${objection.resolution ? ' → ' + objection.resolution : ''}`).join('\n')
        : '（本轮没有反对）'
      const synthPromptText = synthPrompt(this.chairNotes(meeting), meeting.round, meeting.topic, meetingData(resolutionText))
      const synthText = await this.speak(meeting, designer, 'synthesis', synthPromptText, turns)
      const synthStance = parseStance(synthText)
      if (synthStance) stances.set(designer.agentId, synthStance)
      envelope = parseEnvelope(synthText) ?? envelope
    }
    return { reportText, stances, objections, envelope, turns }
  }

  private async speak(meeting: Meeting, participant: MeetingParticipant, phase: MeetingTurnPhase, prompt: string, turns: MeetingTurn[]): Promise<string> {
    // 发言级实时进度：一回合真实可达 5-15 分钟，轮末才落盘会让 UI 整场"看起来卡死"
    this.save(meeting.id, { currentTurn: { agentId: participant.agentId, role: participant.role, phase, startedAt: this.now() } })
    const result = await this.offices.followUp(participant.agentId, prompt, { collectFinal: true })
    const office = this.offices.get(participant.agentId)
    if (office) participant.officeTaskId = office.id
    if (!result.ok) throw new Error(result.error || `${participant.agentId} 发言失败`)
    const text = result.finalText?.trim() ?? ''
    turns.push({ id: `turn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`, meetingId: meeting.id, round: meeting.round, phase, agentId: participant.agentId, officeTaskId: office?.id ?? '', status: 'done', summary: stripMeetingTags(text).slice(0, 1000), startedAt: this.now(), endedAt: this.now() })
    // 发言实时汇入 Issue 时间线：会议全程 30-60 分钟，只靠散会时的纪要镜像会让 issue 在整个会期空白（用户实测反馈）
    const speaker = this.getAgents().find((candidate) => candidate.id === participant.agentId)
    this.addIssueComment?.(meeting.issueId, `【会议·第 ${meeting.round} 轮/${PHASE_LABEL[phase]}】${speaker?.name ?? participant.agentId}（${ROLE_LABEL[participant.role]}）：\n\n${stripMeetingTags(text).slice(0, 4000)}`, participant.agentId)
    return text
  }

  private chairNotes(meeting: Meeting): string {
    // splice(0) 取走插话（消费副作用）保留在 controller；渲染格式集中在 prompts/meeting.ts
    return renderChairNotes(meeting.pendingChairNotes.splice(0))
  }

  private mergeEnvelopeObjections(existing: MeetingObjection[], envelope: Envelope, defender: string): MeetingObjection[] {
    const rows = existing.map((objection) => {
      const match = envelope.objections.find((candidate) => candidate.ref === objection.ref || candidate.text === objection.text)
      if (!match) return objection
      return { ...objection, resolved: match.resolved, resolution: match.resolution, targetAgentId: match.targetAgentId ?? objection.targetAgentId ?? defender }
    })
    for (const candidate of envelope.objections) {
      if (!candidate.ref || !candidate.text) continue
      if (rows.some((row) => row.ref === candidate.ref && row.text === candidate.text)) continue
      rows.push({ id: `obj_${rows.length + 1}`, text: candidate.text, ref: candidate.ref, raisedBy: defender, targetAgentId: candidate.targetAgentId ?? defender, priority: candidate.priority === 'high' ? 'high' : 'normal', resolved: candidate.resolved, resolution: candidate.resolution })
    }
    return uniqueObjections(rows)
  }

  private minutesFromRound(round: number, result: RoundRun): MeetingMinutes {
    const envelope = result.envelope
    return {
      round,
      summary: stripMeetingTags(result.reportText).slice(0, 500),
      decisions: envelope?.decisions ?? [],
      objections: result.objections,
      actionItems: (envelope?.actionItems ?? []).map((item) => ({ title: item.title, ownerAgentId: this.resolveOwner(item.owner), acceptance: item.acceptance, approval: 'pending' as const })),
      openQuestions: envelope?.openQuestions ?? [],
      provenance: 'consensus:advisory'
    }
  }

  private resolveOwner(owner: string) {
    const normalized = owner.trim().toLowerCase()
    return this.getAgents().find((agent) => agent.id.toLowerCase() === normalized || agent.name.toLowerCase() === normalized)?.id ?? owner
  }

  private conclude(meeting: Meeting, minutes: MeetingMinutes): MeetingResult {
    this.materializeActionItems(meeting, minutes)
    const updated = this.save(meeting.id, { status: 'concluded', stopReason: 'converged', concludedAt: this.now(), blockedReason: undefined })!
    this.addIssueComment?.(meeting.issueId, `【会议纪要·第 ${minutes.round} 轮】\n${JSON.stringify(minutes, null, 2)}`, 'meeting')
    return { ok: true, meeting: updated }
  }

  private materializeActionItems(meeting: Meeting, minutes: MeetingMinutes) {
    if (!this.taskService) return
    for (const item of minutes.actionItems) {
      if (item.taskId) continue
      const task = this.taskService.createTask({
        title: item.title,
        prompt: actionItemTaskPrompt(item.title, item.acceptance),
        agentId: item.ownerAgentId,
        issueId: meeting.issueId,
        parked: true,
        startNow: false,
        trigger: 'meeting'
      })
      item.taskId = task.id
    }
  }

  private async stopAfterSynthesis(meeting: Meeting, reason: MeetingStopReason, message: string): Promise<MeetingResult> {
    const last = meeting.minutes[meeting.minutes.length - 1]
    let synthesis: Envelope | null = null
    const turns: MeetingTurn[] = []
    const designer = meeting.participants.find((participant) => participant.role === 'designer')
    if (designer) {
      try {
        const text = await this.speak(meeting, designer, 'synthesis', forcedSynthesisPrompt(this.chairNotes(meeting), message, meetingData(JSON.stringify(last ?? {}))), turns)
        synthesis = parseEnvelope(text)
      } catch (error) {
        const reasonText = error instanceof Error ? error.message : String(error)
        const failed = this.save(meeting.id, { status: 'failed', stopReason: 'failed', blockedReason: reasonText })!
        return { ok: false, error: reasonText, meeting: failed }
      }
    }
    for (const turn of turns) this.store.appendTurn(turn)
    const unresolved = (synthesis?.objections ?? last?.objections ?? []).map((objection, index) => ({
      id: `obj_forced_${index + 1}`,
      text: objection.text,
      ref: objection.ref,
      raisedBy: designer?.agentId ?? 'meeting',
      targetAgentId: objection.targetAgentId,
      priority: objection.priority === 'high' ? 'high' as const : 'normal' as const,
      resolved: false,
      resolution: undefined
    }))
    const forced: MeetingMinutes = {
      round: meeting.round,
      summary: `强制综合：${message}`,
      decisions: synthesis?.decisions ?? last?.decisions ?? [],
      objections: unresolved,
      actionItems: (synthesis?.actionItems ?? []).map((item) => ({ title: item.title, ownerAgentId: this.resolveOwner(item.owner), acceptance: item.acceptance, approval: 'pending' as const })),
      openQuestions: [...(synthesis?.openQuestions ?? last?.openQuestions ?? []), message],
      provenance: 'consensus:advisory'
    }
    const minutes = last?.summary?.startsWith('强制综合：') ? meeting.minutes : [...meeting.minutes, forced]
    const updated = this.save(meeting.id, { minutes, status: 'waiting_user', stopReason: reason, blockedReason: message, currentTurn: undefined })!
    this.addIssueComment?.(meeting.issueId, `【会议暂停·${reason}】\n${JSON.stringify(forced, null, 2)}`, 'meeting')
    return { ok: true, meeting: updated }
  }
}

export { TERMINAL }
