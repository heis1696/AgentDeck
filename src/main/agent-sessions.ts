import type { RunTrigger, Task } from '../shared/types'
import type { AgentLike } from './delegate'
import type { TaskCreateInput, TaskService } from './task-service'
import type { TaskStore } from './store'
import { officeSessionPrompt } from './prompts/meeting'
import { isCaptainLike } from './prompts/delegation'

/** 旧办公室会话的键前缀（仅用于识别与迁移历史单，不作运行期建键） */
export const OFFICE_TASK_KEY_PREFIX = 'office_'

/** 运行期办公室键前缀。注册表私有：刻意带版本号与分隔符，公开建单入口的键形与它撞不上。
 *  注意键形**不是**安全边界（requestId/idempotencyKey 是用户可构造的自由串），
 *  隔离只防误撞；真正的判据是复用时的身份核验（见 verifiedLookup）。 */
export const OFFICE_TASK_KEY_V2_PREFIX = 'office:v2:'

/**
 * 办公室键的候选序列（第 n 个：`office:v2:<agentId>`，其后 `office:v2:<agentId>#2`…）。
 * 键会被用户任务占用（键形是自由串，构造得出来），而 `createTask`/`deduped` 都是"键命中即复用"，
 * 所以**查询与建单必须走同一套候选序列**：查询取第一个身份匹配的候选，建单取第一个既没被占用、
 * 也没有身份冲突的候选。只用单个固定键会让建单路径复用占键的用户任务——绕过核对。
 */
export function officeTaskKeyCandidates(agentId: string): string[] {
  return [OFFICE_TASK_KEY_V2_PREFIX + agentId, `${OFFICE_TASK_KEY_V2_PREFIX}${agentId}#2`]
}

/**
 * 会议成员会话键的候选序列：键形同时携带会议与成员双重身份，与共享咨询办公室
 * （`office:v2:<agentId>`）及旧键形（`office_<agentId>`）的键空间互不相交。
 * 同办公室键一样，键形只防误撞不防伪造（dedupeKey 是用户可构造的自由串）；
 * 真正的判据是复用时的身份核验（见 isOwnMeetingTask）。
 */
export function officeMeetingTaskKeyCandidates(meetingId: string, agentId: string): string[] {
  const base = `${OFFICE_TASK_KEY_V2_PREFIX}meeting:${meetingId}:${agentId}`
  return [base, `${base}#2`]
}

/**
 * 办公室会话任务（会议发言/咨询应答专用）：runner 据此不注入派发与接力协议、不受理派单。
 * 判据只认创建侧写入的 officeAgentId——公开建单入口（parseTaskCreate 的键白名单）拿不到它，
 * 因此用户任务无法自称办公室会话。
 * 不用 dedupeKey 前缀：requestId/idempotencyKey 会成为 dedupeKey，键形是用户可构造的；
 * 本功能落地前建的旧办公室单由 adoptLegacyOfficeTasks 一次性补写该字段，不做运行期回退。
 */
export function isOfficeTask(task: Partial<Pick<Task, 'officeAgentId'>>): boolean {
  return typeof task.officeAgentId === 'string' && task.officeAgentId.length > 0
}

/** 旧办公室会话的键形：恰好是 office_<agentId>（仅用于一次性迁移，不作运行期判据） */
export function legacyOfficeTaskKey(task: Pick<Task, 'agentId'>): string | null {
  return task.agentId ? OFFICE_TASK_KEY_PREFIX + task.agentId : null
}

export interface OfficeFollowUpResult {
  ok: boolean
  error?: string
  finalText?: string
  /** 本次操作实际使用的会话任务（共享办公室或会议成员会话）。 */
  taskId?: string
}

export interface OfficeDeliveryResult extends OfficeFollowUpResult {
  created?: boolean
}

/** 增补协议的回合开关。`meetingTurn` 由发起侧显式标注：本回合是结构化会议发言，
 *  是唯一放行只读调查（<investigate>）的场合。咨询应答、自由追问一律不带它——
 *  只读调查的边界因此不靠「办公室会话」这个身份推断，避免顾问把咨询当会议。 */
export interface TurnProtocolOptions {
  meetingTurn?: boolean
  collectFinal?: boolean
  consultDepth?: number
  onExecution?: (identity: { taskId: string; runId: string; turnId: string }) => void
}

/** 会话范围选项：`meetingId` 把操作切到该会议的成员会话（与共享咨询办公室互不复用、
 *  互不收养）；`signal` 让取锁/建单/入队/首回合等待/回合发送全程可取消——中止后的
 *  请求绝不调用 runner.followUp 把已取消的会话恢复起来。这三项都是注册表内部范围，
 *  绝不透传给 runner 的公开回合协议。 */
export interface OfficeSessionOptions {
  meetingId?: string
  workdir?: string
  signal?: AbortSignal
}

/** 取消检查：signal 已中止就抛出（排队/建单/入队/等待/发送前后共用同一道闸）。 */
function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
  if (signal?.aborted) throw new Error(message)
}

export interface OfficeRunner {
  enqueue(task: Task): void
  followUp(taskId: string, content: string, opts?: TurnProtocolOptions): Promise<OfficeFollowUpResult>
}

export interface AgentSessionRegistryOptions {
  store: Pick<TaskStore, 'get' | 'update' | 'appendEvent'>
  taskService: Pick<TaskService, 'createTask' | 'deduped'>
  runner: OfficeRunner
  getAgents: () => AgentLike[]
  /** Override the first-turn prompt in tests or a host-specific integration. */
  officePrompt?: (agent: AgentLike) => string
  waitPollMs?: number
  waitTimeoutMs?: number
}

/**
 * Durable one-task-per-agent office sessions used by consult and meetings.
 * The registry owns only office-task serialization; ordinary tasks for the
 * same agent continue to use the normal runner/scheduler independently.
 */
export class AgentSessionRegistry {
  private readonly store: Pick<TaskStore, 'get' | 'update' | 'appendEvent'>
  private readonly taskService: Pick<TaskService, 'createTask' | 'deduped'>
  private readonly runner: OfficeRunner
  private readonly getAgents: () => AgentLike[]
  private readonly officePrompt: (agent: AgentLike) => string
  private readonly waitPollMs: number
  private readonly waitTimeoutMs: number
  private readonly locks = new Map<string, Promise<void>>()
  private disposed = false

  constructor(options: AgentSessionRegistryOptions) {
    this.store = options.store
    this.taskService = options.taskService
    this.runner = options.runner
    this.getAgents = options.getAgents
    // 身份（定位 + 人设）由 runner 的 buildAgentPrompt 统一注入，引导正文只说明会话用途，不重复拼人设
    this.officePrompt = options.officePrompt ?? ((agent) => officeSessionPrompt(agent.name))
    this.waitPollMs = Math.max(5, options.waitPollMs ?? 100)
    this.waitTimeoutMs = Math.max(this.waitPollMs, options.waitTimeoutMs ?? 10 * 60 * 1000)
  }

  /** 身份核验：这张记录是否确实是该队长的**共享办公室**会话。
   *  meetingId 必须缺席——带会议归属的成员会话即便 officeAgentId 相同，
   *  也绝不能被办公室查询/建单路径复用（普通办公室查询不能撞上会议会话）。 */
  private isOwnOfficeTask(found: Task | null, agentId: string): boolean {
    return !!found && found.officeAgentId === agentId && found.meetingId === undefined
      && (found.agentId === undefined || found.agentId === agentId)
  }

  /** 身份核验：这张记录是否确实是该会议该成员的成员会话（键位占用者必须逐项对上）。 */
  private isOwnMeetingTask(found: Task | null, meetingId: string, agentId: string): boolean {
    return !!found && found.meetingId === meetingId && found.meetingTaskRole === 'member'
      && found.officeAgentId === agentId && (found.agentId === undefined || found.agentId === agentId)
  }

  /** 按候选序列找一个可用的键位（查询与建单共用这一处，避免两条路径对"键能不能用"判断不一致）：
   *  - `existing`：身份匹配的会话单（复用）
   *  - `free`：既无占用、也无身份冲突的键位（建单用）
   *  两者都可能为 null（候选用尽）。 */
  private pickSessionKey(candidates: string[], own: (found: Task | null) => boolean): { existing: Task | null; free: string | null; collision: Task | null } {
    let collision: Task | null = null
    for (const key of candidates) {
      const found = this.taskService.deduped(key)
      if (!found) return { existing: null, free: key, collision }
      if (own(found)) return { existing: found, free: null, collision }
      // 键被其他任务占用：换下一个候选，绝不复用这张记录
      collision = found
    }
    return { existing: null, free: null, collision }
  }

  private pickKey(agentId: string): { existing: Task | null; free: string | null; collision: Task | null } {
    return this.pickSessionKey(officeTaskKeyCandidates(agentId), (found) => this.isOwnOfficeTask(found, agentId))
  }

  private pickMeetingKey(meetingId: string, agentId: string): { existing: Task | null; free: string | null; collision: Task | null } {
    return this.pickSessionKey(officeMeetingTaskKeyCandidates(meetingId, agentId), (found) => this.isOwnMeetingTask(found, meetingId, agentId))
  }

  /** 旧键形的历史办公室单：仅当身份核验通过时收养。
   *  没有这条，改键形会让线上已存在的办公室会话被抛弃、重新拉一整套首回合（续聊历史留在旧单）。 */
  private legacyLookup(agentId: string): Task | null {
    if (!agentId) return null
    const key = legacyOfficeTaskKey({ agentId })
    if (!key) return null
    const found = this.taskService.deduped(key)
    return this.isOwnOfficeTask(found, agentId) ? found : null
  }

  /** Return a persisted office task without creating or starting anything.
   *  带 meetingId：查该会议的成员会话；不带：查共享咨询办公室（含旧键收养）。
   *  办公室查询绝不返回会议成员会话，会议查询也不复用办公室或旧键记录。 */
  get(agentId: string, meetingId?: string): Task | null {
    if (meetingId) return this.pickMeetingKey(meetingId, agentId).existing
    return this.pickKey(agentId).existing ?? this.legacyLookup(agentId)
  }

  /** Create/recover a session task and make sure its bootstrap turn finished.
   *  不带 meetingId：共享咨询办公室，含旧键迁移收养（行为与历史版本一致）。
   *  带 meetingId：该会议的成员会话——suppressIssue + officeAgentId（沿用办公室执行协议）
   *  + meetingTaskRole:'member'，刻意不设 parentTaskId（会议归属与普通执行父子解耦），
   *  且绝不收养共享旧办公室；signal 在取锁、建单、入队与首回合等待全程生效。 */
  async ensure(agentId: string, options?: OfficeSessionOptions): Promise<Task> {
    if (this.disposed) throw new Error('办公室会话注册表已关闭')
    const agent = this.resolveAgent(agentId)
    const meetingId = options?.meetingId?.trim() || undefined
    const signal = options?.signal
    throwIfAborted(signal, `会话操作已取消（${agent.name}）`)
    let task: Task | null
    if (meetingId) {
      // 会议成员会话：键位候选与身份核验和办公室同构，但与共享办公室的键空间、
      // 旧键迁移互不相通——会议会话不得收养共享旧办公室。
      const picked = this.pickMeetingKey(meetingId, agent.id)
      task = picked.existing
      if (!task && picked.collision) this.noteKeyCollision(agent.id, picked.collision, meetingId)
      if (!task) {
        throwIfAborted(signal, `会话操作已取消（${agent.name}）`)
        const key = picked.free ?? officeMeetingTaskKeyCandidates(meetingId, agent.id)[0]
        const input: TaskCreateInput = {
          title: `${agent.name}·会议成员`,
          prompt: this.officePrompt(agent),
          backend: agent.backend,
          agentId: agent.id,
          workdir: options?.workdir ?? '',
          trigger: 'meeting' as RunTrigger,
          suppressIssue: true,
          titleAuto: false,
          officeAgentId: agent.id,
          meetingId,
          meetingTaskRole: 'member',
          dedupeKey: key
        }
        const created = this.taskService.createTask(input, 'meeting')
        // 建单路径同样核验：占键竞态（并发建单）下 createTask 可能"键命中即复用"别的记录，
        // 拿回的不是本会议本成员的会话单就绝不当成成员会话用。
        if (!this.isOwnMeetingTask(created, meetingId, agent.id)) {
          throw new Error(`会议成员会话建单失败：键 ${key} 被其他任务占用（${created.id}）`)
        }
        task = created
      }
    } else {
      const picked = this.pickKey(agent.id)
      task = picked.existing
      if (!task && picked.collision) this.noteKeyCollision(agent.id, picked.collision)
      if (!task) {
        // 旧键形的历史办公室单优先收养：迁移（store.ts 的三重键判定）已为它补上 officeAgentId，
        // 这里把它的键改写成新键形，续聊历史与任务时间线都留在原单上。
        const legacy = this.legacyLookup(agent.id)
        // 收养需要改写键位：只挑本次选定的空闲键，避免覆盖别的队长/任务正在用的键
        if (legacy && picked.free && legacy.dedupeKey !== picked.free) {
          const migrated = this.store.update(legacy.id, { dedupeKey: picked.free })
          if (migrated) {
            task = migrated
            this.note(legacy.id, `办公室会话已迁移到键空间隔离后的新键（${legacy.dedupeKey ?? '（无）'} → ${picked.free}）`)
          }
        } else if (legacy) {
          task = legacy
        }
      }
      if (!task) {
        throwIfAborted(signal, `会话操作已取消（${agent.name}）`)
        // 键位是候选序列里挑出的空闲键；createTask 仍是"键命中即复用"，
        // 所以建单后必须核验身份——占键竞态（并发建单）下它可能返回别的记录。
        const key = picked.free ?? officeTaskKeyCandidates(agent.id)[0]
        const input: TaskCreateInput = {
          title: `${agent.name}·办公室`,
          prompt: this.officePrompt(agent),
          backend: agent.backend,
          agentId: agent.id,
          workdir: options?.workdir ?? '',
          trigger: 'meeting' as RunTrigger,
          suppressIssue: true,
          titleAuto: false,
          officeAgentId: agent.id,
          dedupeKey: key
        }
        const created = this.taskService.createTask(input, 'meeting')
        if (!this.isOwnOfficeTask(created, agent.id)) {
          throw new Error(`办公室会话建单失败：键 ${key} 被其他任务占用（${created.id}）`)
        }
        task = created
      }
    }

    if (task.status === 'queued') {
      throwIfAborted(signal, `会话操作已取消（${agent.name}）`)
      if (task.parked) {
        // An office task is controlled by this registry, never by the parked
        // UI queue. Clear a stale flag before handing it to the runner.
        this.store.update(task.id, { parked: undefined })
        task = this.store.get(task.id) ?? task
      }
      this.runner.enqueue(task)
    }

    task = await this.waitForTerminal(task.id, signal)
    return task
  }

  /** Serialize one session (per agent, or per meeting+agent) while leaving other
   *  agents/meetings and normal tasks free. 取消在取锁、发送前、发送后全程把关：
   *  中止后的请求绝不调用 runner.followUp 把已取消的会话恢复起来；
   *  发送期间收到的中止让晚到的结果不作数。 */
  async followUp(agentId: string, content: string, opts?: TurnProtocolOptions & OfficeSessionOptions): Promise<OfficeFollowUpResult> {
    const meetingId = opts?.meetingId?.trim() || undefined
    const signal = opts?.signal
    throwIfAborted(signal, '会话回合已取消')
    const agent = this.resolveAgent(agentId)
    return this.withLock(meetingId ? `meeting:${meetingId}:${agent.id}` : agent.id, async () => {
      throwIfAborted(signal, `排队等待期间已取消（${agent.name}）`)
      const task = await this.ensure(agent.id, { meetingId, workdir: opts?.workdir, signal })
      throwIfAborted(signal, `会话回合已取消（${task.id}）：收到中止信号，不得恢复会话`)
      // 只传回合协议开关：meetingId/workdir/signal 是注册表内部范围，不进入 runner 协议
      const result = await this.runner.followUp(task.id, content, {
        collectFinal: opts?.collectFinal ?? true,
        consultDepth: opts?.consultDepth ?? 0,
        ...(opts?.onExecution ? { onExecution: opts.onExecution } : {}),
        ...(opts?.meetingTurn ? { meetingTurn: true } : {})
      })
      throwIfAborted(signal, `会话回合已取消（${task.id}）：发送期间收到中止信号，结果不作数`)
      return { ...result, taskId: task.id }
    })
  }

  async ensureOffice(agentId: string, options?: { workdir?: string; signal?: AbortSignal }): Promise<Task> { return this.ensure(agentId, options) }

  async deliver(agentId: string, content: string): Promise<OfficeDeliveryResult> {
    const existing = this.get(agentId)
    const result = await this.followUp(agentId, content, { collectFinal: true })
    const task = this.get(agentId)
    return { ...result, ...(task ? { taskId: task.id } : {}), created: !existing && !!task }
  }

  officeTask(agentId: string): Task | null { return this.get(agentId) }
  pendingTurns(agentId: string): number { return this.locks.has(agentId) ? 1 : 0 }
  dispose() { this.disposed = true; this.locks.clear() }

  /** Resolve a displayed team name/backend/id to an office session target.
   *  受理条件与 buildDelegationBlock 的「可咨询的队长」名单一致：排除发起人本人**与其直属队员**。
   *  队员即便顶着队长头衔也只能派活——否则提示词说不许咨询、运行时却照发，同一条规则在
   *  两处判据里漂移（这正是许可层与展示层不同步的成因）。 */
  resolve(ref: string, excludeAgentId?: string): AgentLike | null {
    if (!ref || typeof ref !== 'string') return null
    const needle = ref.trim().toLowerCase()
    if (!needle) return null
    const agents = this.getAgents()
    // 发起人的直属队员不可被咨询（与 delegation.ts 的 subordinateIds 同一条规则）
    const subordinateIds = new Set(
      (excludeAgentId ? agents.find((agent) => agent.id === excludeAgentId)?.subordinates ?? [] : [])
    )
    return agents.find((agent) => {
      if (agent.id === excludeAgentId || subordinateIds.has(agent.id)) return false
      return isCaptainLike(agent) && (
        agent.id.toLowerCase() === needle ||
        agent.name.toLowerCase() === needle ||
        agent.backend.toLowerCase() === needle
      )
    }) ?? null
  }

  list(): Task[] {
    return this.getAgents()
      .map((agent) => this.get(agent.id))
      .filter((task): task is Task => !!task)
  }

  /** 键碰撞留痕（时间线可见）：说明为什么另建了单、以及被占用的记录没被动过。 */
  private noteKeyCollision(agentId: string, holder: Task, meetingId?: string): void {
    const text = meetingId
      ? `⚠ 会议成员键 ${holder.dedupeKey ?? '（无）'} 已被非会议会话任务占用，未复用该记录，改为另建会议成员会话（会议 ${meetingId}，队长 ${agentId}）`
      : `⚠ 办公室键 ${holder.dedupeKey ?? '（无）'} 已被非办公室任务占用，未复用该记录，改为另建办公室会话（队长 ${agentId}）`
    this.note(holder.id, text)
  }

  /** 任务时间线留痕（办公室会话的边界事件不能被静默吞掉）。 */
  private note(taskId: string | undefined, text: string): void {
    if (!taskId) return
    try {
      this.store.appendEvent(taskId, { ts: Date.now(), kind: 'status', text })
    } catch {}
  }

  private resolveAgent(agentId: string): AgentLike {
    const agent = this.getAgents().find((candidate) => candidate.id === agentId)
    if (!agent) throw new Error(`办公室队长不存在: ${agentId}`)
    if (agent.backend.toLowerCase() === 'dsh') throw new Error('DeepSeek Harness 不支持跨重启续聊，不能进入办公室会话')
    return agent
  }

  private async waitForTerminal(taskId: string, signal?: AbortSignal): Promise<Task> {
    const deadline = Date.now() + this.waitTimeoutMs
    for (;;) {
      throwIfAborted(signal, `会话首回合等待已取消: ${taskId}`)
      const task = this.store.get(taskId)
      if (!task) throw new Error(`办公室任务已消失: ${taskId}`)
      if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') return task
      if (Date.now() >= deadline) throw new Error(`办公室首回合超时: ${taskId}`)
      await new Promise((resolve) => setTimeout(resolve, this.waitPollMs))
    }
  }

  private async withLock<T>(agentId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(agentId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    const chain = previous.then(() => current)
    this.locks.set(agentId, chain)
    await previous
    try {
      return await action()
    } finally {
      release()
      if (this.locks.get(agentId) === chain) this.locks.delete(agentId)
    }
  }
}
