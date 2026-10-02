import { createHash, randomUUID } from 'node:crypto'
import { assembleMeetingContext, publicVersion, chairTurnIds } from './meeting-context'
import type { AgentLike } from './delegate'
import { AgentSessionRegistry } from './agent-sessions'
import { MeetingStore } from './meeting-store'
import type { TaskService } from './task-service'
import type { TaskStore } from './store'
import type { Task } from '../shared/types'
import {
  reportPrompt,
  challengePrompt,
  reviewPrompt,
  defensePrompt,
  synthPrompt,
  forcedSynthesisPrompt,
  renderChairNotes,
  meetingData,
  actionItemTaskPrompt
} from './prompts/meeting'
import {
  canTransitionMeeting,
  type Meeting,
  type MeetingActionItem,
  type MeetingCreateInput,
  type MeetingConfirmation,
  type MeetingTurnReadQuery,
  type MeetingTurnPurpose,
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
  addIssueComment?: (issueId: string, content: string, authorId?: string, meetingId?: string, sourceTurnId?: string) => void
  cancelTask?: (taskId: string) => Promise<{ ok: boolean; error?: string }>
  issueExists?: (issueId: string) => boolean
  taskStore?: Pick<TaskStore, 'get' | 'list' | 'update'>
  getIssueTask?: (issueId: string) => Task | undefined
  isFreshIssue?: (issueId: string) => boolean
  onTaskUpdated?: (task: Task) => void
  deleteTaskData?: (meeting: Meeting, tasks: Task[]) => Promise<{ ok: boolean; error?: string }>
  deleteIssue?: (issueId: string) => void
  deleteMeetingComments?: (meetingId: string) => void
  stopTimeoutMs?: number
  now?: () => number
}

export interface MeetingResult {
  ok: boolean
  error?: string
  meeting?: Meeting
}

interface Stance { verdict: 'agree' | 'disagree' | 'abstain'; grounds: string; minutesVersion?: string }
interface Envelope {
  decisions: string[]
  objections: Array<{ id?: string; text: string; ref: string; resolved: boolean; resolution?: string; targetAgentId?: string; priority?: 'high' | 'normal' }>
  actionItems: Array<{ title: string; owner: string; acceptance: string[] }>
  openQuestions: string[]
}

interface RoundRun {
  reportText: string
  stances: Map<string, Stance>
  objections: MeetingObjection[]
  envelope: Envelope | null
  turns: MeetingTurn[]
  confirmed: boolean
  minutesVersion?: string
  confirmations: MeetingConfirmation[]
}

const TERMINAL = new Set(['done', 'failed', 'cancelled'])

function attr(attrs: string, name: string): string | undefined {
  const match = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'))
  return match?.[2]?.trim() || undefined
}

export function parseStance(text: string): Stance | null {
  const last = text.trim().split(/\r?\n/).at(-1) ?? ''
  const match = last.match(/^<stance\b((?:\s+[\w-]+\s*=\s*(?:"[^"<>]*"|'[^'<>]*'))+)\s*\/>$/i)
  if (!match) return null
  const names = [...match[1].matchAll(/\s+([\w-]+)\s*=\s*(?:"[^"<>]*"|'[^'<>]*')/g)].map((item) => item[1].toLowerCase())
  if (new Set(names).size !== names.length) return null
  const verdict = attr(match[1], 'verdict')
  const grounds = attr(match[1], 'grounds') ?? ''
  if (verdict !== 'agree' && verdict !== 'disagree' && verdict !== 'abstain') return null
  return { verdict, grounds, ...(attr(match[1], 'version') ? { minutesVersion: attr(match[1], 'version') } : {}) }
}

export function stripMeetingTags(text: string): string {
  return text
    .replace(/<stance\b[^>]*\/>/gi, '')
    .replace(/<objection\b([^>]*)>([\s\S]*?)<\/objection>/gi, (_match, attrs: string, body: string) => `反对[${attr(attrs, 'ref') ?? '未注明出处'}]：${body.trim()}`)
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
    out.push({ id: attr(match[1], 'id') ?? `obj_${randomUUID()}`, text: body, ref, raisedBy, targetAgentId, priority: attr(match[1], 'priority') === 'high' ? 'high' : 'normal', resolved: false })
  }
  if (out.length) return out.slice(0, 3)
  // Conservative markdown fallback: only lines with an explicit ref count.
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:[-*]\s*)?(?:反对|objection)\s*\[([^\]]+)\]\s*[:：]\s*(.+)$/i)
    if (!m) continue
    out.push({ id: `obj_${randomUUID()}`, text: m[2].trim(), ref: m[1].trim(), raisedBy, targetAgentId: defaultTargetAgentId, priority: out.length === 0 ? 'high' : 'normal', resolved: false })
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
  const fenced = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)].map((match) => match[1])
  const candidates = fenced.length ? fenced : []
  if (!fenced.length) {
    let depth = 0
    let start = 0
    let quoted = false
    let escaped = false
    for (let index = 0; index < text.length; index++) {
      const character = text[index]
      if (quoted) {
        if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === '"') quoted = false
        continue
      }
      if (character === '"' && depth) quoted = true
      else if (character === '{') {
        if (!depth) start = index
        depth++
      } else if (character === '}' && depth && --depth === 0) candidates.push(text.slice(start, index + 1))
    }
    if (depth !== 0 || candidates.length !== 1) return null
  }
  const valid: Envelope[] = []
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (validEnvelope(parsed)) valid.push(parsed)
      else if (fenced.length) return null
    } catch { if (fenced.length) return null }
  }
  return valid.length === 1 ? valid[0] : null
}

export function parseEnvelope(text: string): Envelope | null {
  const parsed = extractJson(text)
  if (!validEnvelope(parsed)) return null
  return { decisions: parsed.decisions, objections: parsed.objections ?? [], actionItems: parsed.actionItems ?? [], openQuestions: parsed.openQuestions ?? [] }
}

const PHASE_LABEL: Record<MeetingTurnPhase, string> = { report: '汇报', challenge: '质疑', defense: '答辩', synthesis: '综合' }
const ROLE_LABEL: Record<MeetingRole, string> = { reporter: '汇报', critic: '质疑', designer: '答辩' }

function isCaptain(agent: AgentLike): boolean {
  return !!agent.role && /队长|领队|captain|leader/i.test(agent.role) || (agent.subordinates?.length ?? 0) > 0
}

function uniqueObjections(rows: MeetingObjection[]): MeetingObjection[] {
  const seen = new Set<string>()
  return rows.filter((row) => {
    const key = `${row.raisedBy}\n${row.ref}\n${row.text}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
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
  private readonly taskStore?: MeetingControllerOptions['taskStore']
  private readonly getIssueTask?: MeetingControllerOptions['getIssueTask']
  private readonly isFreshIssue?: MeetingControllerOptions['isFreshIssue']
  private readonly onTaskUpdated?: MeetingControllerOptions['onTaskUpdated']
  private readonly deleteTaskData?: MeetingControllerOptions['deleteTaskData']
  private readonly deleteIssue?: MeetingControllerOptions['deleteIssue']
  private readonly deleteMeetingComments?: MeetingControllerOptions['deleteMeetingComments']
  private readonly stopTimeoutMs: number
  private readonly now: () => number
  private readonly running = new Set<string>()
  private readonly runs = new Map<string, { abort: AbortController; done: Promise<void>; finish: () => void }>()
  private readonly stopping = new Map<string, Promise<MeetingResult>>()
  private readonly deleting = new Map<string, Promise<MeetingResult>>()
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
    this.taskStore = options.taskStore
    this.getIssueTask = options.getIssueTask
    this.isFreshIssue = options.isFreshIssue
    this.onTaskUpdated = options.onTaskUpdated
    this.deleteTaskData = options.deleteTaskData
    this.deleteIssue = options.deleteIssue
    this.deleteMeetingComments = options.deleteMeetingComments
    this.stopTimeoutMs = options.stopTimeoutMs ?? 5_000
    this.now = options.now ?? Date.now
  }

  list() { return this.store.list() }
  get(id: string) { return this.store.get(id) }
  readTurns(id: string, query: MeetingTurnReadQuery = {}) { return this.store.readTurns(id, query) }
  getTurn(id: string, turnId: string) { return this.store.getTurn(id, turnId) }
  memberExecutions(id: string, agentId: string) {
    const meeting = this.get(id)
    if (!meeting?.participants.some((participant) => participant.agentId === agentId)) return null
    const sessionTaskId = this.offices.get(agentId, id)?.id
    const tasks = this.ownedTasks(meeting)
    const descendants = new Set(sessionTaskId ? [sessionTaskId] : [])
    for (let pass = 0; pass < tasks.length; pass++) for (const task of tasks) if (task.parentTaskId && descendants.has(task.parentTaskId)) descendants.add(task.id)
    return { agentId, sessionTaskId, turns: this.store.turns(id).filter((turn) => turn.agentId === agentId), investigations: tasks.filter((task) => task.id !== sessionTaskId && descendants.has(task.id)).map((task) => ({ taskId: task.id, parentTaskId: task.parentTaskId, runId: task.runId, status: task.status })) }
  }
  retryMirrors(id: string): MeetingResult {
    const meeting = this.get(id)
    if (!meeting || meeting.stopState || meeting.deleting || meeting.status === 'cancelled') return { ok: false, error: '会议不存在或已停止/删除' }
    for (const turn of this.store.turns(id).filter((item) => item.status === 'done' && item.mirror?.state !== 'published')) this.mirrorTurn(meeting, turn.id)
    this.notifyTurns(id)
    return { ok: true, meeting }
  }
  private notifyTurns(id: string) {
    const turns = this.store.turns(id)
    return this.save(id, { turnVersion: turns.reduce((maximum, turn) => Math.max(maximum, turn.version ?? 0), 0), publicVersion: publicVersion(this.store, id) })
  }
  private mirrorTurn(meeting: Meeting, turnId: string) {
    const turn = this.store.getTurn(meeting.id, turnId)
    if (!turn || turn.status !== 'done' || turn.body === undefined || turn.mirror?.state === 'published' || !this.addIssueComment) return
    const attempts = (turn.mirror?.attempts ?? 0) + 1
    try {
      this.addIssueComment(meeting.issueId, `【会议·第 ${turn.round} 轮/${turn.purpose === 'chair' ? '用户插话' : PHASE_LABEL[turn.phase]}】${turn.speaker?.name ?? turn.agentId}：\n\n${stripMeetingTags(turn.body).slice(0, 4000)}${turn.body.length > 4000 ? '\n\n[兼容镜像摘要；完整正文请按来源发言ID读取]' : ''}`, turn.agentId, meeting.id, turn.id)
      this.store.updateTurn(meeting.id, turn.id, { mirror: { state: 'published', attempts } })
    } catch (error) {
      try { this.store.updateTurn(meeting.id, turn.id, { mirror: { state: 'failed', attempts, lastError: error instanceof Error ? error.message : String(error) } }) } catch (storageError) { console.error('[Meeting] mirror status persistence failed', storageError) }
    }
  }
  private publishMinutes(meeting: Meeting, minutes: MeetingMinutes, label: string) {
    const id = `minutes_${meeting.id}_${createHash('sha256').update(JSON.stringify(minutes)).digest('hex').slice(0, 16)}`
    this.store.appendTurn({ id, meetingId: meeting.id, round: meeting.round, phase: 'synthesis', purpose: 'minutes', agentId: 'meeting', officeTaskId: '', speaker: { name: label, role: 'host', platform: 'host' }, status: 'pending', executionEpoch: meeting.executionEpoch })
    this.store.updateTurn(meeting.id, id, { status: 'done', summary: label, endedAt: this.now(), publicVersion: publicVersion(this.store, meeting.id) + 1, mirror: { state: 'pending', attempts: 0 } }, JSON.stringify(minutes, null, 2))
    this.mirrorTurn(meeting, id)
    this.notifyTurns(meeting.id)
  }
  forIssue(issueId: string) { return this.store.list().find((meeting) => meeting.issueId === issueId) ?? null }
  forTask(taskId: string) {
    const task = this.taskStore?.get(taskId)
    return (task?.meetingId ? this.get(task.meetingId) : null)
      ?? (task?.issueId ? this.forIssue(task.issueId) : null)
      ?? this.store.list().find((meeting) => meeting.containerTaskId === taskId)
      ?? null
  }
  canRunTask(task: Task): boolean {
    if (task.meetingTaskRole === 'container') return false
    if (task.meetingId) {
      const meeting = this.get(task.meetingId)
      return !!meeting && meeting.status === 'active' && !meeting.stopState && !meeting.deleting
    }
    return !task.issueId || !this.forIssue(task.issueId)
  }
  subscribe(listener: (meeting: Meeting) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private save(id: string, patch: Partial<Meeting>) {
    const updated = this.store.update(id, patch)
    if (updated) this.syncContainer(updated)
    if (updated) for (const listener of this.listeners) listener(updated)
    return updated
  }

  private syncContainer(meeting: Meeting) {
    if (!meeting.ownsIssue || !meeting.containerTaskId || !this.taskStore) return
    const task = this.taskStore.get(meeting.containerTaskId)
    if (!task || task.meetingId !== meeting.id || task.meetingTaskRole !== 'container') return
    const status = meeting.status === 'active' ? 'running'
      : meeting.status === 'concluded' ? 'done'
        : meeting.status === 'failed' ? 'failed'
          : meeting.status === 'cancelled' ? 'cancelled' : 'queued'
    if (task.status === status) return
    const updated = this.taskStore.update(task.id, {
      status,
      parked: status === 'queued' ? true : undefined,
      startedAt: status === 'running' ? this.now() : task.startedAt,
      endedAt: status === 'done' || status === 'failed' || status === 'cancelled' ? this.now() : undefined,
      error: status === 'failed' ? meeting.blockedReason : undefined
    })
    if (updated) this.onTaskUpdated?.(updated)
  }

  private assertActive(id: string, epoch: number) {
    const meeting = this.store.get(id)
    if (!meeting || meeting.status !== 'active' || meeting.stopState || meeting.deleting
      || meeting.executionEpoch !== epoch || this.runs.get(id)?.abort.signal.aborted) {
      throw new Error('会议执行已终止')
    }
  }

  private ownedTasks(meeting: Meeting): Task[] {
    if (this.taskStore) return this.taskStore.list().filter((task) => task.meetingId === meeting.id)
    return meeting.participants.flatMap((participant) => {
      const task = this.offices.get(participant.agentId, meeting.id)
      return task?.meetingId === meeting.id ? [task] : []
    })
  }

  private async stopExecutions(meeting: Meeting): Promise<{ ok: boolean; error?: string }> {
    const tasks = this.ownedTasks(meeting).filter((task) => task.meetingTaskRole !== 'container')
    if (tasks.length && !this.cancelTask) return { ok: false, error: '会议缺少执行终止接口' }
    const results = await Promise.all(tasks.map(async (task) => {
      try { return await this.cancelTask!(task.id) }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
    }))
    const errors = results.flatMap((result, index) => result.ok ? [] : [`${tasks[index].id}: ${result.error ?? '执行终止未确认'}`])
    return errors.length ? { ok: false, error: errors.join('；') } : { ok: true }
  }

  private waitForRun(id: string): Promise<boolean> {
    const running = this.runs.get(id)
    if (!running) return Promise.resolve(true)
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), this.stopTimeoutMs)
      void running.done.then(() => { clearTimeout(timer); resolve(true) })
    })
  }

  create(input: MeetingCreateInput): Meeting {
    if (this.issueExists && !this.issueExists(input.issueId)) throw new Error(`Issue 不存在: ${input.issueId}`)
    if (this.forIssue(input.issueId)) throw new Error('该 Issue 已有关联会议')
    const container = this.getIssueTask?.(input.issueId)
    if (container?.status === 'running') throw new Error('请先停止该 Issue 的普通执行')
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
    const meeting = this.store.create(input)
    const ownsIssue = !!container && !!this.isFreshIssue?.(input.issueId)
    if (ownsIssue && container && this.taskStore) {
      const updated = this.taskStore.update(container.id, { meetingId: meeting.id, meetingTaskRole: 'container', parked: true, trigger: 'meeting' })
      if (updated) this.onTaskUpdated?.(updated)
    }
    return this.save(meeting.id, { containerTaskId: container?.id, ownsIssue, workdir: container?.workdir ?? '', executionEpoch: 0 })!
  }

  async start(id: string): Promise<MeetingResult> {
    const meeting = this.store.get(id)
    if (!meeting) return { ok: false, error: '会议不存在' }
    if (meeting.stopState || meeting.deleting) return { ok: false, error: '请先完成会议停止或删除' }
    if (this.running.has(id)) return { ok: true, meeting }
    if (meeting.status === 'draft' || meeting.status === 'failed') {
      if (this.store.list().some((item) => item.status === 'active' && item.id !== id)) return { ok: false, error: '已有会议正在进行' }
      this.save(id, { status: 'active', round: Math.max(1, meeting.round), stopReason: undefined, blockedReason: undefined })
    } else if (meeting.status !== 'active') {
      return { ok: false, error: `会议当前状态不可启动: ${meeting.status}` }
    }
    if (this.store.list().some((item) => item.status === 'active' && item.id !== id)) return { ok: false, error: '已有会议正在进行' }
    const abort = new AbortController()
    let finish!: () => void
    const done = new Promise<void>((resolve) => { finish = resolve })
    this.runs.set(id, { abort, done, finish })
    this.save(id, { executionEpoch: (meeting.executionEpoch ?? 0) + 1 })
    this.running.add(id)
    try {
      const result = await this.run(id)
      if (result.meeting && ['concluded', 'failed', 'waiting_user'].includes(result.meeting.status)) {
        abort.abort()
        const stopped = await this.stopExecutions(result.meeting)
        if (!stopped.ok) {
          const current = this.store.get(id)
          if (current && current.status !== 'cancelled') {
            this.save(id, { stopState: 'failed', blockedReason: stopped.error })
          }
          return { ok: false, error: stopped.error, meeting: this.store.get(id) ?? undefined }
        }
      }
      return result
    } finally {
      this.running.delete(id)
      this.runs.delete(id)
      finish()
    }
  }

  async resume(id: string): Promise<MeetingResult> {
    const meeting = this.store.get(id)
    if (!meeting || meeting.status !== 'waiting_user') return { ok: false, error: '会议不在 waiting_user' }
    if (meeting.stopState || meeting.deleting || this.running.has(id)) return { ok: false, error: '请先完成会议停止或删除' }
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
    const pending = this.stopping.get(id)
    if (pending) return pending
    const meeting = this.store.get(id)
    if (!meeting) return { ok: false, error: '会议不存在' }
    this.runs.get(id)?.abort.abort()
    this.pauseRequested.delete(id)
    this.save(id, {
      status: meeting.status === 'concluded' ? 'concluded' : 'cancelled',
      executionEpoch: (meeting.executionEpoch ?? 0) + 1,
      stopState: 'stopping', stopReason: undefined, blockedReason: '正在停止会议执行', currentTurn: undefined
    })
    const stopping = (async (): Promise<MeetingResult> => {
      const stopped = await this.stopExecutions(meeting)
      const finished = stopped.ok && await this.waitForRun(id)
      if (!stopped.ok || !finished) {
        const error = stopped.error ?? '会议调度尚未退出，请重试停止'
        return { ok: false, error, meeting: this.save(id, { stopState: 'failed', blockedReason: error }) ?? undefined }
      }
      return { ok: true, meeting: this.save(id, { stopState: undefined, blockedReason: '会议执行已停止' }) ?? undefined }
    })()
    this.stopping.set(id, stopping)
    try { return await stopping }
    finally { if (this.stopping.get(id) === stopping) this.stopping.delete(id) }
  }

  interject(id: string, note: string): MeetingResult {
    const meeting = this.store.get(id)
    if (!meeting || meeting.status !== 'active') return { ok: false, error: '会议不在 active' }
    const value = note.trim()
    if (!value) return { ok: false, error: '插话不能为空' }
    if (meeting.stopState || meeting.deleting) return { ok: false, error: '会议正在停止或删除' }
    const idOfTurn = `chair_${randomUUID()}`
    this.store.appendTurn({ id: idOfTurn, meetingId: id, round: meeting.round, phase: 'challenge', purpose: 'chair', agentId: 'user', officeTaskId: '', status: 'pending', speaker: { name: '用户', role: '主席', platform: 'user' }, startedAt: this.now(), executionEpoch: meeting.executionEpoch })
    this.store.updateTurn(id, idOfTurn, { status: 'done', endedAt: this.now(), summary: value.slice(0, 500), publicVersion: publicVersion(this.store, id) + 1, mirror: { state: 'pending', attempts: 0 } }, value)
    this.mirrorTurn(meeting, idOfTurn)
    this.notifyTurns(id)
    return { ok: true, meeting: this.store.get(id) ?? meeting }
  }

  async delete(id: string): Promise<MeetingResult> {
    const pending = this.deleting.get(id)
    if (pending) return pending
    const meeting = this.store.get(id)
    if (!meeting) return { ok: true }
    this.runs.get(id)?.abort.abort()
    this.save(id, { deleting: true })
    const deleting = (async (): Promise<MeetingResult> => {
      try {
        const stopped = await this.cancel(id)
        if (!stopped.ok) return stopped
        const tasks = this.ownedTasks(meeting)
        if (tasks.length && !this.deleteTaskData) return { ok: false, error: '会议缺少任务清理接口' }
        const cleaned = await this.deleteTaskData?.(meeting, tasks)
        if (cleaned && !cleaned.ok) return { ok: false, error: cleaned.error, meeting: this.get(id) ?? undefined }
        this.deleteMeetingComments?.(id)
        if (meeting.ownsIssue) {
          if (!this.deleteIssue) return { ok: false, error: '会议缺少 Issue 清理接口' }
          this.deleteIssue(meeting.issueId)
        }
        return this.store.delete(id) ? { ok: true } : { ok: false, error: '会议删除失败' }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.save(id, { blockedReason: `会议删除未完成：${message}` })
        return { ok: false, error: message, meeting: this.get(id) ?? undefined }
      }
    })()
    this.deleting.set(id, deleting)
    try { return await deleting }
    finally { if (this.deleting.get(id) === deleting) this.deleting.delete(id) }
  }

  approveAction(meetingId: string, itemIndex: number, verdict: 'approved' | 'rejected'): MeetingResult {
    const meeting = this.store.get(meetingId)
    if (!meeting || meeting.status !== 'concluded') return { ok: false, error: '只有已结束会议可以审批行动项' }
    const minutes = meeting.minutes[meeting.minutes.length - 1]
    const item = minutes?.actionItems[itemIndex]
    if (!item) return { ok: false, error: '行动项不存在' }
    item.approval = verdict
    if (verdict === 'approved') {
      if (!item.taskId && this.taskService) {
        const task = this.taskService.createTask({
          title: item.title,
          prompt: actionItemTaskPrompt(item.title, item.acceptance),
          workdir: meeting.workdir,
          agentId: item.ownerAgentId,
          parked: true,
          startNow: false,
          trigger: 'meeting'
        })
        item.taskId = task.id
      }
      this.save(meetingId, { minutes: meeting.minutes })
      if (item.taskId) this.startTask?.(item.taskId)
    }
    this.save(meetingId, { minutes: meeting.minutes })
    return { ok: true, meeting: this.store.get(meetingId) ?? meeting }
  }

  recover(): Meeting[] {
    const recovered: Meeting[] = []
    for (const meeting of this.store.list()) {
      for (const turn of this.store.turns(meeting.id).filter((item) => item.status === 'pending' || item.status === 'speaking')) {
        this.store.updateTurn(meeting.id, turn.id, { status: meeting.stopState || meeting.deleting || meeting.status === 'cancelled' ? 'cancelled' : 'failed', endedAt: this.now(), error: '应用重启，未收到本次公开发言结果', mirror: { state: 'skipped' } })
      }
      if (meeting.deleting) {
        void this.delete(meeting.id).catch((error) => console.error('[Meeting] delete recovery failed', error))
        continue
      }
      if (meeting.stopState) {
        void this.cancel(meeting.id).catch((error) => console.error('[Meeting] stop recovery failed', error))
        continue
      }
      if (meeting.status !== 'active') continue
      const updated = this.save(meeting.id, { status: 'waiting_user', executionEpoch: (meeting.executionEpoch ?? 0) + 1, stopReason: 'failed', blockedReason: '应用重启导致会议中断，请确认继续', currentTurn: undefined })
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
      const epoch = meeting.executionEpoch!
      try {
        round = await this.runRound(meeting)
        this.assertActive(id, epoch)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        const current = this.store.get(id)
        if (!current || current.status === 'cancelled' || current.deleting) return { ok: true, meeting: current ?? undefined }
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
      const allAgree = round.confirmed && meeting.participants.every((participant) => round.stances.get(participant.agentId)?.verdict === 'agree')
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
    const confirmations = new Map<string, MeetingConfirmation>()
    const owners = this.ownerNames(meeting)
    const reporter = meeting.participants.find((participant) => participant.role === 'reporter')!
    const designer = meeting.participants.find((participant) => participant.role === 'designer')!
    const reviewers = meeting.participants.filter((participant) => participant.agentId !== reporter.agentId)
    let objections = (meeting.objections ?? meeting.minutes.at(-1)?.objections ?? []).map((objection) => ({ ...objection }))
    let envelope: Envelope | null = null
    let draft: { version: string; envelope: Envelope } | undefined
    const draftVersion = (value: Envelope) => createHash('sha256').update(JSON.stringify({ envelope: value, chairs: chairTurnIds(this.store, meeting.id) })).digest('hex').slice(0, 24)
    const speak = async (participant: MeetingParticipant, phase: MeetingTurnPhase, prompt: string, purpose: MeetingTurnPurpose = 'speech') => {
      const text = await this.speak(meeting, participant, phase, prompt, turns, { purpose, objections, draft })
      const stance = parseStance(text)
      stances.delete(participant.agentId)
      if (stance) stances.set(participant.agentId, stance)
      return text
    }
    const recordReview = (participant: MeetingParticipant, text: string, targetAgentId: string, canResolve: boolean) => {
      const turn = turns.at(-1)!
      const raised = parseObjections(text, participant.agentId, targetAgentId)
      const stance = stances.get(participant.agentId)
      const malformed = /<objection\b/i.test(text) && !raised.length
      const confirmed = canResolve && stance?.verdict === 'agree' && !raised.length && !malformed
      objections = objections.map((objection) => objection.raisedBy === participant.agentId && !objection.resolved && confirmed
        ? { ...objection, resolved: true, resolution: objection.resolution ?? stance!.grounds, reviewTurnId: turn.id, reviewVersion: turn.contextVersion }
        : objection)
      for (const objection of raised) {
        const existing = objections.findIndex((candidate) => candidate.raisedBy === objection.raisedBy && (candidate.id === objection.id || candidate.ref === objection.ref && candidate.text === objection.text))
        if (existing >= 0) objections[existing] = { ...objections[existing], resolved: false, reviewTurnId: turn.id, reviewVersion: turn.contextVersion }
        else objections.push({ ...objection, id: `obj_${randomUUID()}`, sourceTurnId: turn.id })
      }
      if (malformed) stances.delete(participant.agentId)
      this.save(meeting.id, { objections })
    }
    const review = async (participant: MeetingParticipant, stage: 'defense' | 'minutes', targetAgentId: string) => {
      const text = await speak(participant, 'challenge', reviewPrompt('', meeting.round, meeting.topic, '', this.investigatorNames(participant.agentId), stage), stage === 'minutes' ? 'confirmation' : 'review')
      recordReview(participant, text, targetAgentId, true)
      return text
    }
    const reportText = await speak(reporter, 'report', reportPrompt('', meeting.round, meeting.topic, this.investigatorNames(reporter.agentId)))
    recordReview(reporter, reportText, reporter.agentId, false)
    for (const critic of reviewers) {
      const text = await speak(critic, 'challenge', challengePrompt('', meeting.round, meeting.topic, '', this.investigatorNames(critic.agentId)), 'review')
      recordReview(critic, text, reporter.agentId, true)
    }
    const ready = () => objections.every((objection) => objection.resolved) && reviewers.every((participant) => stances.get(participant.agentId)?.verdict === 'agree')
    for (let inner = 0; inner < meeting.maxInnerTurns && !ready(); inner++) {
      const defenseText = await speak(reporter, 'defense', defensePrompt('', meeting.round, meeting.topic, '', this.investigatorNames(reporter.agentId), owners))
      recordReview(reporter, defenseText, reporter.agentId, false)
      envelope = parseEnvelope(defenseText)
      if (envelope) objections = this.mergeEnvelopeObjections(objections, envelope, reporter.agentId, turns.at(-1)?.id)
      this.save(meeting.id, { objections })
      for (const critic of reviewers) await review(critic, 'defense', reporter.agentId)
    }
    if (ready()) {
      stances.clear()
      const synthText = await speak(designer, 'synthesis', synthPrompt('', meeting.round, meeting.topic, '', this.investigatorNames(designer.agentId), owners))
      recordReview(designer, synthText, designer.agentId, false)
      envelope = parseEnvelope(synthText)
      if (envelope) {
        objections = this.mergeEnvelopeObjections(objections, envelope, designer.agentId, turns.at(-1)?.id)
        this.save(meeting.id, { objections })
        draft = { envelope, version: draftVersion(envelope) }
        const remember = (participant: MeetingParticipant, version: string) => {
          const turn = turns.at(-1)!
          const detail = this.store.getTurn(meeting.id, turn.id)!
          const stance = stances.get(participant.agentId)
          const valid = !!stance && (!stance.minutesVersion || stance.minutesVersion === version) && !parseObjections(detail.body ?? '', participant.agentId).length && !objections.some((objection) => objection.raisedBy === participant.agentId && !objection.resolved)
          confirmations.set(participant.agentId, { agentId: participant.agentId, turnId: turn.id, minutesVersion: version, contextVersion: turn.contextVersion ?? 0, chairTurnIds: detail.delivery?.chairTurnIds ?? [], verdict: valid ? stance!.verdict : 'invalid' })
        }
        remember(designer, draft.version)
        for (let pass = 0; pass <= meeting.maxInnerTurns; pass++) {
          if (draft.version !== draftVersion(draft.envelope)) {
            draft = { envelope: draft.envelope, version: draftVersion(draft.envelope) }
            confirmations.clear()
            stances.clear()
          }
          let revised = false
          for (const participant of meeting.participants) {
            const prior = confirmations.get(participant.agentId)
            if (prior?.minutesVersion === draft.version && chairTurnIds(this.store, meeting.id).every((id) => prior.chairTurnIds.includes(id))) continue
            const receivedVersion = draft.version
            const text = await review(participant, 'minutes', designer.agentId)
            const proposal = parseEnvelope(text)
            if (proposal && JSON.stringify(proposal) !== JSON.stringify(draft.envelope)) {
              envelope = proposal
              objections = this.mergeEnvelopeObjections(objections, proposal, participant.agentId, turns.at(-1)?.id)
              this.save(meeting.id, { objections })
              draft = { envelope: proposal, version: draftVersion(proposal) }
              confirmations.clear()
              stances.clear()
              revised = true
              break
            }
            if (!proposal && /```json|\{\s*"decisions"/i.test(text)) stances.delete(participant.agentId)
            remember(participant, receivedVersion)
            if (draft.version !== draftVersion(draft.envelope)) { revised = true; break }
          }
          if (!revised) break
        }
      }
    }
    const chairs = chairTurnIds(this.store, meeting.id)
    const confirmed = !!draft && draft.version === draftVersion(draft.envelope) && meeting.participants.every((participant) => {
      const confirmation = confirmations.get(participant.agentId)
      return confirmation?.verdict === 'agree' && confirmation.minutesVersion === draft!.version && chairs.every((id) => confirmation.chairTurnIds.includes(id))
    })
    return { reportText, stances, objections, envelope, turns, confirmed, minutesVersion: draft?.version, confirmations: [...confirmations.values()] }
  }

  /** opts.investigate 默认放行（会议发言的常规能力）；强制综合的提示词明令「不要发起调查」，
   *  那里必须显式传 false——否则模型越界输出 <investigate> 会被当成合法回合照发调查。 */
  private async speak(meeting: Meeting, participant: MeetingParticipant, phase: MeetingTurnPhase, prompt: string, turns: MeetingTurn[], opts?: { investigate?: boolean; purpose?: MeetingTurnPurpose; objections?: MeetingObjection[]; draft?: { version: string; envelope: Envelope } }): Promise<string> {
    const epoch = meeting.executionEpoch!
    this.assertActive(meeting.id, epoch)
    const speaker = this.getAgents().find((candidate) => candidate.id === participant.agentId)
    const turn = this.store.appendTurn({ id: `speech_${randomUUID()}`, meetingId: meeting.id, round: meeting.round, phase, purpose: opts?.purpose ?? 'speech', agentId: participant.agentId, officeTaskId: '', sessionTaskId: this.offices.get(participant.agentId, meeting.id)?.id, status: 'pending', startedAt: this.now(), speaker: { name: speaker?.name ?? participant.agentId, role: participant.role, platform: speaker?.backend ?? 'unknown' }, executionEpoch: epoch, minutesVersion: opts?.draft?.version, mirror: { state: 'pending', attempts: 0 } })
    turns.push(turn)
    this.save(meeting.id, { currentTurn: { agentId: participant.agentId, role: participant.role, phase, startedAt: turn.startedAt! } })
    this.notifyTurns(meeting.id)
    try {
      const context = assembleMeetingContext(this.store, meeting, opts?.objections ?? meeting.objections ?? [], opts?.draft)
      this.store.updateTurn(meeting.id, turn.id, { contextVersion: context.delivery.publicVersion, delivery: context.delivery, deliveryState: 'prepared' })
      this.notifyTurns(meeting.id)
      this.assertActive(meeting.id, epoch)
      const result = await this.offices.followUp(participant.agentId, context.text + prompt, {
        collectFinal: true, meetingTurn: opts?.investigate !== false, meetingId: meeting.id, workdir: meeting.workdir, signal: this.runs.get(meeting.id)?.abort.signal,
        onExecution: (identity) => {
          this.assertActive(meeting.id, epoch)
          participant.sessionTaskId = identity.taskId
          const detail = this.store.getTurn(meeting.id, turn.id)!
          const dispatchedAt = this.now()
          const delivery = { ...detail.delivery, attempts: [...(detail.delivery?.attempts ?? []), { ...identity, dispatchedAt }] }
          this.store.updateTurn(meeting.id, turn.id, { status: 'speaking', sessionTaskId: identity.taskId, runId: identity.runId, executionTurnId: identity.turnId, deliveredAt: dispatchedAt, deliveryState: 'dispatched', delivery })
          this.notifyTurns(meeting.id)
        }
      })
      this.assertActive(meeting.id, epoch)
      const session = this.offices.get(participant.agentId, meeting.id)
      participant.sessionTaskId = result.taskId ?? session?.id
      if (!result.ok) throw new Error(result.error || `${participant.agentId} 发言失败`)
      const text = result.finalText?.trim() ?? ''
      if (!text) throw new Error(`${participant.agentId} 发言为空，不能算同意`)
      const updated = this.store.updateTurn(meeting.id, turn.id, { status: 'done', sessionTaskId: participant.sessionTaskId, endedAt: this.now(), summary: stripMeetingTags(text).slice(0, 500), publicVersion: publicVersion(this.store, meeting.id) + 1, deliveryState: 'accepted', deliveredAt: this.store.getTurn(meeting.id, turn.id)?.deliveredAt ?? this.now() }, text)!
      Object.assign(turn, updated)
      this.assertActive(meeting.id, epoch)
      this.mirrorTurn(meeting, turn.id)
      this.notifyTurns(meeting.id)
      return text
    } catch (error) {
      const current = this.get(meeting.id)
      const cancelled = !current || current.status === 'cancelled' || !!current.stopState || !!current.deleting || current.executionEpoch !== epoch
      if (current) {
        this.store.updateTurn(meeting.id, turn.id, { status: cancelled ? 'cancelled' : 'failed', endedAt: this.now(), error: error instanceof Error ? error.message : String(error), deliveryState: 'failed', mirror: { state: 'skipped' } })
        this.notifyTurns(meeting.id)
      }
      throw error
    }
  }

  private chairNotes(meeting: Meeting): string {
    return renderChairNotes(meeting.pendingChairNotes)
  }

  private investigatorNames(agentId: string): string[] {
    const agents = this.getAgents()
    const me = agents.find((agent) => agent.id === agentId)
    return (me?.subordinates ?? []).map((id) => agents.find((agent) => agent.id === id)?.name).filter((name): name is string => !!name)
  }

  /** 行动项 owner 候选：与会队长名（resolveOwner 按 id/名字解析，名字是模型最可能照抄的形式） */
  private ownerNames(meeting: Meeting): string[] {
    const agents = this.getAgents()
    return meeting.participants.map((participant) => agents.find((agent) => agent.id === participant.agentId)?.name ?? participant.agentId)
  }

  private mergeEnvelopeObjections(existing: MeetingObjection[], envelope: Envelope, defender: string, replyTurnId?: string): MeetingObjection[] {
    const rows = existing.map((objection) => {
      const match = envelope.objections.find((candidate) => candidate.id === objection.id || candidate.ref === objection.ref && candidate.text === objection.text)
      if (!match) return objection
      return { ...objection, resolved: objection.resolved && match.resolved, resolution: match.resolution ?? objection.resolution, replyTurnId }
    })
    for (const candidate of envelope.objections) {
      if (!candidate.ref || !candidate.text) continue
      if (rows.some((row) => row.ref === candidate.ref && row.text === candidate.text)) continue
      rows.push({ id: `obj_${randomUUID()}`, text: candidate.text, ref: candidate.ref, raisedBy: defender, targetAgentId: candidate.targetAgentId ?? defender, priority: candidate.priority === 'high' ? 'high' : 'normal', resolved: false, resolution: candidate.resolution, sourceTurnId: replyTurnId })
    }
    return uniqueObjections(rows)
  }

  private minutesFromRound(round: number, result: RoundRun): MeetingMinutes {
    const envelope = result.envelope
    const dissent = [...result.stances].filter(([, stance]) => stance.verdict !== 'agree').map(([agentId, stance]) => {
      const name = this.getAgents().find((agent) => agent.id === agentId)?.name ?? agentId
      return `${name}尚未同意：${stance.grounds || stance.verdict}`
    })
    return {
      round,
      summary: stripMeetingTags(result.reportText).slice(0, 500),
      decisions: envelope?.decisions ?? [],
      objections: result.objections,
      actionItems: (envelope?.actionItems ?? []).map((item) => ({ title: item.title, ownerAgentId: this.resolveOwner(item.owner), acceptance: item.acceptance, approval: 'pending' as const })),
      openQuestions: [...new Set([...(envelope?.openQuestions ?? []), ...dissent])],
      provenance: 'consensus:advisory',
      version: result.minutesVersion,
      confirmations: result.confirmations
    }
  }

  private resolveOwner(owner: string) {
    const normalized = owner.trim().toLowerCase()
    return this.getAgents().find((agent) => agent.id.toLowerCase() === normalized || agent.name.toLowerCase() === normalized)?.id ?? owner
  }

  private conclude(meeting: Meeting, minutes: MeetingMinutes): MeetingResult {
    const epoch = meeting.executionEpoch!
    this.assertActive(meeting.id, epoch)
    const updated = this.save(meeting.id, { status: 'concluded', stopReason: 'converged', concludedAt: this.now(), blockedReason: undefined })!
    if (updated.executionEpoch === epoch && !updated.stopState && !updated.deleting) {
      this.publishMinutes(meeting, minutes, '会议纪要')
    }
    return { ok: true, meeting: updated }
  }

  private async stopAfterSynthesis(meeting: Meeting, reason: MeetingStopReason, message: string): Promise<MeetingResult> {
    const epoch = meeting.executionEpoch!
    this.assertActive(meeting.id, epoch)
    const last = meeting.minutes[meeting.minutes.length - 1]
    let synthesis: Envelope | null = null
    const turns: MeetingTurn[] = []
    const designer = meeting.participants.find((participant) => participant.role === 'designer')
    if (designer) {
      try {
        // 强制综合：提示词已写明「不要发起调查」，运行时同一口径关闭调查放行
        const text = await this.speak(meeting, designer, 'synthesis', forcedSynthesisPrompt(this.chairNotes(meeting), message, meetingData(JSON.stringify(last ?? {})), this.ownerNames(meeting)), turns, { investigate: false })
        synthesis = parseEnvelope(text)
      } catch (error) {
        const current = this.store.get(meeting.id)
        if (!current || current.status === 'cancelled' || current.deleting) return { ok: true, meeting: current ?? undefined }
        const reasonText = error instanceof Error ? error.message : String(error)
        const failed = this.save(meeting.id, { status: 'failed', stopReason: 'failed', blockedReason: reasonText })!
        return { ok: false, error: reasonText, meeting: failed }
      }
    }
    const current = this.get(meeting.id)
    if (!current || current.executionEpoch !== epoch || current.stopState || current.deleting || current.status !== 'active') return { ok: true, meeting: current ?? undefined }
    const unresolved = uniqueObjections([
      ...(last?.objections.filter((objection) => !objection.resolved) ?? []),
      ...(synthesis?.objections ?? []).filter((objection) => !last?.objections.some((existing) => existing.ref === objection.ref && existing.text === objection.text)).map((objection, index) => ({
        id: `obj_${randomUUID()}`,
        text: objection.text,
        ref: objection.ref,
        raisedBy: designer?.agentId ?? 'meeting',
        targetAgentId: objection.targetAgentId,
        priority: objection.priority === 'high' ? 'high' as const : 'normal' as const,
        resolved: false
      }))
    ])
    const forced: MeetingMinutes = {
      round: meeting.round,
      summary: `强制综合：${message}`,
      decisions: synthesis?.decisions ?? last?.decisions ?? [],
      objections: unresolved,
      actionItems: (synthesis?.actionItems ?? []).map((item) => ({ title: item.title, ownerAgentId: this.resolveOwner(item.owner), acceptance: item.acceptance, approval: 'pending' as const })),
      openQuestions: [...new Set([...(last?.openQuestions ?? []), ...(synthesis?.openQuestions ?? []), message])],
      provenance: 'consensus:advisory'
    }
    const minutes = last?.summary?.startsWith('强制综合：') ? meeting.minutes : [...meeting.minutes, forced]
    const updated = this.save(meeting.id, { minutes, status: 'waiting_user', stopReason: reason, blockedReason: message, currentTurn: undefined })!
    if (updated.executionEpoch === epoch && !updated.stopState && !updated.deleting) {
      this.publishMinutes(meeting, forced, `会议暂停·${reason}`)
    }
    return { ok: true, meeting: updated }
  }
}

export { TERMINAL }
