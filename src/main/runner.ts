// 任务运行器：队列 + 生命周期 + 事件管道
// 状态机：queued → running → done | failed | cancelled
import type { Task, TaskEvent, WorktreeInfo } from '../shared/types'
import { createHash } from 'node:crypto'
import type { TaskStore } from './store'
import type { AgentBackend, BackendSession, PermissionRequest, BackendTurnResult } from './backends/types'
import { buildAgentPrompt, buildDelegationBlock, runDelegationLoop, parseContinueMerged, stripContinue, parseDelegates, ancestorBudget, buildChildPrompt, sanitizeChildPrompt, MAX_DEPTH, MAX_TOTAL_ROUNDS, type AgentLike, type DelegateCall } from './delegate'
import { isGitRepo, createWorktree, currentBranch, setWorktreeOwner } from './git'

/** API 预设（主进程 presets.ts 的 ApiPreset 的运行时子集，避免环依赖） */
interface PresetLike {
  id: string
  name: string
  backend: string
  baseURL: string
  apiKey: string
}

/** 阶段接力处理器：主进程接 createTask（同 issue 新 run、新会话硬切） */
export type ContinueHandler = (input: { sourceTaskId: string; issueId: string; brief: string; start: 'auto' | 'parked' }) => unknown

/** 阶段接力协议：多阶段任务在阶段边界输出 <continue>，系统在同一 Issue 上硬切新会话 */
const CONTINUE_BLOCK = `【阶段接力（仅多阶段任务使用）】
若本任务是分阶段施工的其中一阶段、且下一阶段的目标已明确，在回复的最后一行输出：
<continue start="auto">下一阶段简报</continue>
- 标记必须是整个回复的结尾（其后不能再有任何正文）——系统只识别位于末尾的标记；正文、示例或讨论里出现标记字样不会触发接力。
- 简报必须自包含：阶段目标、方案文档路径、上阶段成果（commit/关键文件:行号）、约束与验收。接手的会话看不到本会话上下文，一切靠简报。
- start="auto"：下一阶段目标已明确、可立即执行时用（系统立即在同一 Issue 上以新会话开始执行）。
- start="parked"：你主动备好下一阶段、等用户确认时用；不确定能否直接开工时一律用 parked。
- 没有明确的下一阶段就不要输出该标记；输出了就不再写"后续可以…"之类的口头交接。
- 示例：<continue start="auto">阶段2：按 docs/plan.md §3 实现模型选择 UI；阶段1 已完成数据管道（commit 09a47a4，src/main/presets.ts）；验收：两个不同模型的 agent 并发执行成功</continue>`

/** 同一 Issue 上 <continue> 自继链上限（防无限自我接力） */
const MAX_HANDOFF_CHAIN = 8

/** 用户点「⇥ 接力下一阶段」按钮时注入的合成指令（显式人工入口；自由追问不再按关键词猜测意图） */
const HANDOFF_CUE = `【系统】用户通过「接力下一阶段」按钮要求进入下一阶段。请按【阶段接力】协议输出一个 <continue start="auto">…</continue> 标记作为回复的最后一行：简报必须自包含（下一阶段目标、方案文档/计划路径、本阶段成果与 commit、关键文件:行号、约束与验收——接手会话看不到本会话上下文）。若确实不存在明确的下一阶段，直接说明原因，不要输出标记。`
import { classifyFailure } from './failure'
import { canTransition } from '../shared/taskflow'
import { Scheduler } from './scheduler'
import { PermissionBroker } from './permission-broker'
import { TaskFinalizer } from './task-finalizer'
import { Executor } from './executor'
import { decideRetry } from './retry-policy'
import { TurnLifecycle } from './turn-lifecycle'
import { DSH_TURN_BUDGET_MS } from './backends/dsh'

/** Main-process task creation dependency. Kept structural to avoid coupling
 * the runner to persistence/projection implementation details. */
export interface ChildTaskCreator {
  createChildTask(input: {
    title: string
    prompt: string
    workdir: string
    backend: string
    agentId?: string
    parentTaskId: string
    workerIndex: number
    unavailableReason?: string
    worktree?: WorktreeInfo
  }): Task
}
export type TaskCreationRequest = Parameters<ChildTaskCreator['createChildTask']>[0]
export type TaskCreator = ChildTaskCreator | ((input: TaskCreationRequest) => Task)

export interface RunnerPorts {
  send: (channel: string, payload: unknown) => void
  notify: (task: Task, what: string, body: string) => void
  onTaskEvent?: (taskId: string, event: Omit<TaskEvent, 'seq'>) => void
}

/**
 * 回合空转上限：等待终态期间「没有任何事件」（文本增量/工具/状态）达到该时长才判超时。
 * 有事件即续命——真实 agent 一个回合跑十几分钟很正常，固定总时长会把还在工作的回合误杀。
 * 与一次性 CLI 后端（cli-common 10 分钟无输出看门狗）语义对齐。
 * 可用 AGENTDECK_TURN_IDLE_MS 覆盖（测试加速用）。
 */
const TURN_IDLE_TIMEOUT_MS = Number(process.env.AGENTDECK_TURN_IDLE_MS) > 0
  ? Number(process.env.AGENTDECK_TURN_IDLE_MS)
  : 10 * 60 * 1000
const turnTimeoutError = (budgetMs = TURN_IDLE_TIMEOUT_MS): BackendTurnResult =>
  ({ ok: false, response: '', error: `回合超时（${Math.round(budgetMs / 60000)} 分钟无进展，已停止本回合）` })
/** 后端连接已死的特征：命中后丢弃内存会话、降级 resume 重建（不再需要重启应用） */
const SESSION_DEAD_RE = /连接已关闭|进程退出|EPIPE|ENOTCONN|ECONNRESET|ECONNREFUSED|disconnected/i

export class TaskRunner {
  private store: TaskStore
  private backends: Map<string, AgentBackend>
  private opts: () => {
    concurrency: number; mode: string; notify: boolean; workerConcurrency?: number
    turnIdleTimeoutMs?: number; permissionTimeoutMs?: number
    maxRetryAttempts?: number; retryBackoffMs?: number; maxHandoffChain?: number
    delegateMaxRounds?: number; delegateMaxTotalRounds?: number; delegateMaxDepth?: number
    doomLoopThreshold?: number
  }
  private sessions = new Map<string, BackendSession>()
  /** Bind a backend session's callbacks to the currently accepted turn. */
  private sessionEventContexts = new WeakMap<BackendSession, { generation: number; sessionOwner?: string }>()
  /** 启动即注册的中止句柄（一次性 CLI 在 session 返回前就要能取消） */
  private launchHandles = new Map<string, { stop: () => void | Promise<unknown> }>()
  /** Delayed provider retries must be cancellable and must not outlive shutdown. */
  private retryTimers = new Map<string, NodeJS.Timeout>()
  private pendingResume = new Map<string, (v: BackendTurnResult) => void>()
  /** Last accepted terminal payload, used to quarantine duplicate callbacks
   * from the preceding turn while an internal title turn is in flight. */
  private lastTerminalResponses = new Map<string, string>()
  private permissionBroker: PermissionBroker
  private getTeam: (() => AgentLike[]) | null = null
  private scheduler: Scheduler
  private finalizer: TaskFinalizer
  private executor = new Executor()
  private ports: RunnerPorts
  /** 回合空转看门狗：等待终态期间任务有新事件即续命，长时间无进展才判超时 */
  private turnWatchdogs = new Map<string, { timer: NodeJS.Timeout; expire: () => void }>()
  /** 回合代号：防止已放弃回合的迟到终态误 resolve 新回合的等待 */
  private turnGen = new Map<string, number>()
  /** One gate/lifecycle per task. The Task remains the durable compatibility
   * record; these objects only own in-memory callback admission state. */
  private turnLifecycles = new Map<string, TurnLifecycle>()
  private readonly onTaskChanged?: (task: Task) => void
  /** 流式派单嗅探：领队会话期间逐条 text 事件累计扫描，闭合一个 <delegate> 即提前建单入队。
   *  回灌仍只在回合末（委派循环）发生，不会打断领队正在进行的主运行。 */
  private earlySpawns = new Map<string, { buffer: string; scanOffset: number; closeScanOffset: number; spawned: Map<string, { call: DelegateCall; childId: string }>; seenKeys: Set<string>; pending: Promise<unknown>[] }>()
  /** Consecutive tool-call signatures used by the doom-loop approval guard. */
  private toolWindows = new Map<string, { key: string; count: number; requested: boolean }>()
  private doomRequestSeq = 0

  /** Cleanup must be awaited, but a broken provider must not block cancellation
   * or application shutdown indefinitely. */
  private awaitCleanup(action: () => Promise<unknown> | void, timeoutMs = 2_000): Promise<void> {
    return new Promise((resolve) => {
      let settled = false
      let timer: NodeJS.Timeout
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      timer = setTimeout(finish, timeoutMs)
      Promise.resolve().then(action).then(finish, finish)
    })
  }

  constructor(
    store: TaskStore,
    backends: Map<string, AgentBackend>,
    opts: () => { concurrency: number; mode: string; notify: boolean; workerConcurrency?: number },
    onTaskChanged?: (task: Task) => void,
    ports: Partial<RunnerPorts> = {}
  ) {
    this.store = store
    this.backends = backends
    this.opts = opts
    this.onTaskChanged = onTaskChanged
    const send = ports.send ?? (() => {})
    const notify = ports.notify ?? (() => {})
    this.ports = { send, notify, onTaskEvent: ports.onTaskEvent }
    this.permissionBroker = new PermissionBroker((taskId, request) => {
      send('task:permission', { taskId, request })
    }, () => this.opts().permissionTimeoutMs ?? 5 * 60 * 1000, (taskId) => this.workVersion(taskId))
    this.finalizer = new TaskFinalizer(store, (taskId) => this.pushTask(taskId))
    this.scheduler = new Scheduler(
      () => this.store.list(),
      () => ({ concurrency: this.opts().concurrency, workerConcurrency: this.opts().workerConcurrency }),
      (taskId) => this.run(taskId)
    )
  }

  pushTask(taskId: string) {
    const task = this.store.get(taskId)
    if (!task) return
    this.permissionBroker.setWorkVersion(taskId, this.workVersion(taskId))
    // Keep the in-memory gate aligned with the durable compatibility record;
    // this makes terminal transitions visible before any late callback arrives.
    this.lifecycle(taskId).setStatus(task.status)
    // Keep projections in step with every runner lifecycle transition before
    // notifying renderer consumers. The callback is optional for CLI/smoke use.
    this.onTaskChanged?.(task)
    this.ports.send('task:updated', task)
  }
  /** 记录用户输入（首条 prompt / 追问），对话视图按 user 事件分气泡 */
  private recordUser(taskId: string, text: string) {
    const full = this.store.appendEvent(taskId, { ts: Date.now(), kind: 'user', text })
    if (full) this.pushEvent(taskId, full)
  }
  pushEvent(taskId: string, e: TaskEvent) {
    this.ports.send('task:event', { taskId, event: e })
  }

  private lifecycle(taskId: string) {
    let lifecycle = this.turnLifecycles.get(taskId)
    if (!lifecycle) {
      lifecycle = new TurnLifecycle({ taskId, initialStatus: this.store.get(taskId)?.status ?? 'queued' })
      this.turnLifecycles.set(taskId, lifecycle)
    }
    return lifecycle
  }

  /** 事件管道：落盘 + 推 UI；onTurnEnd 可挂回调 */
  private makeEvents(taskId: string, onTurnEnd?: (r: BackendTurnResult) => void, context?: { generation: number; sessionOwner?: string }) {
    const life = this.lifecycle(taskId)
    const active = (kind?: string, terminal = false) => {
      const task = this.store.get(taskId)
      life.setStatus(task?.status ?? 'queued')
      const token = context ? { generation: context.generation, sessionOwner: context.sessionOwner } : life.gate.token()
      return life.accepts(token, { kind, terminal })
    }
    return {
      onEvent: (e: Omit<TaskEvent, 'seq'>) => {
        if (!active(e.kind)) return
        this.touchWatchdog(taskId)
        if (e.kind === 'text') this.sniffDelegates(taskId, e.text)
        if (e.kind === 'tool') this.observeToolCall(taskId, e)
        this.ports.onTaskEvent?.(taskId, e)
        const full = this.store.appendEvent(taskId, e)
        if (full) this.pushEvent(taskId, full)
      },
      onHeartbeat: () => { if (active()) this.touchWatchdog(taskId) },
      onTurnEnd: (r: BackendTurnResult) => {
        if (!active('final', true)) return
        const response = typeof r.response === 'string' ? r.response.trim() : ''
        if (life.gate.state.titleMode && this.lastTerminalResponses.get(taskId) === response) return
        this.lastTerminalResponses.set(taskId, response)
        onTurnEnd?.(r)
        const waiter = this.pendingResume.get(taskId)
        if (waiter) {
          this.pendingResume.delete(taskId)
          waiter(r)
        }
      },
      onLaunch: (handle: { stop: () => void | Promise<unknown> }) => {
        if (!active()) {
          void Promise.resolve(handle.stop()).catch(() => {})
          return
        }
        this.launchHandles.set(taskId, handle)
        life.registerLaunch(handle.stop)
      },
      onSessionId: (sessionId: string) => {
        if (!active() || !sessionId) return
        const task = this.store.get(taskId)
        if (!task || task.sessionId === sessionId) return
        if (context) context.sessionOwner = sessionId
        life.gate.setSessionOwner(sessionId)
        this.store.update(taskId, { sessionId })
        this.pushTask(taskId)
      },
      onPermission: (req: PermissionRequest) => active()
        ? this.askPermission(taskId, req)
        : Promise.resolve({ decision: 'deny' as const })
    }
  }

  /** 权限确认：推给 UI，5 分钟无响应自动拒绝（领队/worker 共用） */
  askPermission(taskId: string, req: PermissionRequest): Promise<{ optionId?: string; decision: 'allow' | 'deny' }> {
    const workVersion = this.workVersion(taskId)
    return this.permissionBroker.ask(taskId, { ...req, workVersion }, workVersion)
  }

  /** Hash the execution-relevant task snapshot. Status/results are excluded so
   * routine lifecycle updates do not invalidate an approval. */
  private workVersion(taskId: string): string {
    const task = this.store.get(taskId)
    if (!task) return 'missing'
    return createHash('sha256').update(JSON.stringify({
      title: task.title,
      prompt: task.prompt,
      workdir: task.workdir,
      backend: task.backend,
      agentId: task.agentId ?? '',
      handoff: task.handoff ?? ''
    })).digest('hex')
  }

  /** Convert backend tool events into an auditable, one-shot doom-loop approval. */
  private observeToolCall(taskId: string, event: Omit<TaskEvent, 'seq'>) {
    // Doom-loop is a Goal-mode guard. Ordinary Tasks retain their existing
    // permission behavior and must not be paused by Goal policy.
    if (!this.store.get(taskId)?.goalId) return
    const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {}
    if (data.phase !== 'started') return
    let args = data.args ?? data.input ?? ''
    if (typeof args !== 'string') {
      try { args = JSON.stringify(args) } catch { args = String(args) }
    }
    const key = `${event.text ?? ''}:${args}`
    const previous = this.toolWindows.get(taskId)
    const state = previous?.key === key ? previous : { key, count: 0, requested: false }
    state.count += 1
    this.toolWindows.set(taskId, state)
    if (state.count !== (this.opts().doomLoopThreshold ?? 3) || state.requested) return
    state.requested = true
    const requestId = `doom_${taskId}_${++this.doomRequestSeq}`
    const reason = `检测到同名同参工具连续调用 ${state.count} 次，疑似 doom-loop；需要人工确认是否继续。`
    const full = this.store.appendEvent(taskId, {
      ts: Date.now(),
      kind: 'status',
      text: `doom-loop: ${reason}`,
      data: { stopReason: 'doom_loop', toolName: event.text ?? '', args }
    })
    if (full) this.pushEvent(taskId, full)
    const request: PermissionRequest = {
      requestId,
      toolName: String(event.text ?? ''),
      reason,
      riskLevel: 'high',
      input: args,
      options: [
        { optionId: 'allow', name: '允许继续', response: { decision: 'allow' } },
        { optionId: 'deny', name: '停止回合', response: { decision: 'deny' } }
      ]
    }
    void this.askPermission(taskId, request).then((decision) => {
      if (decision.decision === 'allow') {
        this.toolWindows.delete(taskId)
        const allowed = this.store.appendEvent(taskId, { ts: Date.now(), kind: 'status', text: 'doom-loop: 人工审批通过，继续执行', data: { stopReason: 'doom_loop_approved' } })
        if (allowed) this.pushEvent(taskId, allowed)
        return
      }
      const denied = this.store.appendEvent(taskId, { ts: Date.now(), kind: 'status', text: 'doom-loop: 未获人工审批，停止当前回合', data: { stopReason: 'doom_loop_denied' } })
      if (denied) this.pushEvent(taskId, denied)
      void Promise.resolve(this.sessions.get(taskId)?.stop()).catch(() => {})
    }).catch(() => {})
  }

  /** UI 应答权限请求 */
  resolvePermission(requestId: string, optionId: string, decision: 'allow' | 'deny') {
    return this.permissionBroker.resolve(requestId, optionId, decision)
  }

  /**
   * 空转哨兵：护送一个回合的等待。到点先停掉进行中的回合（会话仍可续聊，不留
   * 僵尸 agent 继续在后台跑），再以超时错误裁决等待方。
   * 在 backend.start 之前就可武装：会话尚未建立时用启动句柄硬杀，握手挂死同样
   * 判败——否则任务会永久卡在 running 并占住并发槽，只能重启应用。
   */
  private idleSentinel(taskId: string, onFire?: () => void): { timeout: Promise<BackendTurnResult>; cancel: () => void } {
    this.disarmWatchdog(taskId)
    const budgetMs = this.turnBudgetMs(taskId)
    let fire: () => void = () => {}
    const timeout = new Promise<BackendTurnResult>((resolve) => {
      fire = () => resolve(turnTimeoutError(budgetMs))
    })
    // 哨兵只裁决自己武装的那一回合：零延迟自动重试会在上一回合收尾（finally cancel）
    // 之前就用同一 taskId 换上新看门狗，过期/取消必须先核对记录身份，
    // 否则会误删后继回合的定时器——后继回合从此无人看护，永久卡在 running。
    const record: { timer: NodeJS.Timeout; expire: () => void } = {
      timer: undefined as unknown as NodeJS.Timeout,
      expire: () => {
        if (this.turnWatchdogs.get(taskId) !== record) return
        this.turnWatchdogs.delete(taskId)
        // Invalidate callbacks from the abandoned turn before stopping it. A
        // late terminal event must never settle a later retry or follow-up.
        this.bumpTurnGen(taskId)
        onFire?.()
        const session = this.sessions.get(taskId)
        if (session) {
          void Promise.resolve(session.stop()).catch(() => {})
        } else {
          void Promise.resolve(this.launchHandles.get(taskId)?.stop()).catch(() => {})
        }
        fire()
      }
    }
    record.timer = setTimeout(record.expire, budgetMs)
    this.turnWatchdogs.set(taskId, record)
    return {
      timeout,
      cancel: () => {
        if (this.turnWatchdogs.get(taskId) !== record) return
        clearTimeout(record.timer)
        this.turnWatchdogs.delete(taskId)
      }
    }
  }
  /** 任务有新事件（任何种类）即视为有进展：看门狗重新计时 */
  private touchWatchdog(taskId: string) {
    const w = this.turnWatchdogs.get(taskId)
    if (!w) return
    clearTimeout(w.timer)
    w.timer = setTimeout(w.expire, this.turnBudgetMs(taskId))
  }
  /**
   * 该任务当前回合的看门狗预算：常规后端按空闲语义（有事件续命），
   * dsh headless 运行期零输出、永远等不到续命事件，按固定总预算裁决。
   */
  private turnBudgetMs(taskId: string): number {
    return this.store.get(taskId)?.backend === 'dsh' ? DSH_TURN_BUDGET_MS : this.turnIdleBudgetMs()
  }
  /** 空转预算来源：测试 env > 设置（默认 10 分钟） */
  private turnIdleBudgetMs(): number {
    const env = Number(process.env.AGENTDECK_TURN_IDLE_MS)
    if (env > 0) return env
    return this.opts().turnIdleTimeoutMs ?? 600_000
  }
  private disarmWatchdog(taskId: string) {
    const w = this.turnWatchdogs.get(taskId)
    if (!w) return
    clearTimeout(w.timer)
    this.turnWatchdogs.delete(taskId)
  }
  private bumpTurnGen(taskId: string) {
    const gen = (this.turnGen.get(taskId) ?? 0) + 1
    this.turnGen.set(taskId, gen)
    const life = this.lifecycle(taskId)
    // Keep the compatibility counter and gate generation in lockstep. A new
    // generation starts ownerless so synchronous start callbacks can be
    // admitted; the session owner is installed as soon as start resolves.
    life.gate.invalidate()
    life.gate.setStatus(this.store.get(taskId)?.status ?? 'queued')
    life.gate.setSessionOwner(undefined)
    life.gate.setPendingResume(false)
    return gen
  }

  /** 关闭并移除内存会话（容错）：防止放弃的会话继续在后台跑、往任务日志里交错写事件 */
  async closeSession(taskId: string) {
    this.clearRetry(taskId)
    this.bumpTurnGen(taskId)
    this.earlySpawns.delete(taskId)
    this.lastTerminalResponses.delete(taskId)
    const s = this.sessions.get(taskId)
    if (!s) return
    this.sessions.delete(taskId)
    await this.awaitCleanup(() => s.stop())
    await this.awaitCleanup(() => s.close())
  }

  /** Release in-memory lifecycle state after IPC removes a terminal task. */
  async forget(taskId: string) {
    this.clearRetry(taskId)
    this.disarmWatchdog(taskId)
    this.pendingResume.delete(taskId)
    this.launchHandles.delete(taskId)
    const session = this.sessions.get(taskId)
    this.sessions.delete(taskId)
    if (session) {
      await this.awaitCleanup(() => session.stop())
      await this.awaitCleanup(() => session.close())
    }
    this.permissionBroker.cancelTask(taskId)
    this.toolWindows.delete(taskId)
    this.earlySpawns.delete(taskId)
    this.lastTerminalResponses.delete(taskId)
    this.turnGen.delete(taskId)
    this.turnLifecycles.get(taskId)?.dispose()
    this.turnLifecycles.delete(taskId)
  }

  private clearRetry(taskId: string) {
    const timer = this.retryTimers.get(taskId)
    if (!timer) return false
    clearTimeout(timer)
    this.retryTimers.delete(taskId)
    return true
  }

  /** 回合成功后的收尾：取最终结果 + git 快照 + 用量聚合 + 状态落盘 */
  private async finalizeDone(taskId: string, directResult?: string) {
    await this.finalizer.finalizeDone(taskId, directResult)
  }

  /** 失败落库：原始错误 + 分类解读（P1） */
  private failTask(taskId: string, error: string) {
    const task = this.store.get(taskId)
    if (!task) return
    // A queued task with an unavailable backend never entered execution, but
    // it still needs a terminal state so the scheduler cannot dispatch it forever.
    if (task.status !== 'queued' && !canTransition(task.status, 'failed', 'runner')) return
    // 回合失败：流式期间基于半截输出提前建的单一并撤销（无人收编/回灌，也不该被信任）
    this.abandonEarlySpawns(taskId)
    this.store.update(taskId, { status: 'failed', endedAt: Date.now(), error, failure: classifyFailure({ error }) })
    this.lifecycle(taskId).setStatus('failed')
    this.pushTask(taskId)
  }

  enqueue(task: Task) {
    this.pushTask(task.id)
    this.scheduler.enqueue()
  }

  /** 队伍提供者（agent 身份与委派名单） */
  attachTeam(getTeam: () => AgentLike[]) {
    this.getTeam = getTeam
  }

  private getPresets: (() => PresetLike[]) | null = null
  /** API 预设提供者（agent 引用的连接覆盖） */
  attachPresets(getPresets: () => PresetLike[]) {
    this.getPresets = getPresets
  }

  private onContinue: ContinueHandler | null = null
  /** 阶段接力处理器（主进程接 createTask：同 issue 新 run、新会话硬切） */
  attachContinue(handler: ContinueHandler) {
    this.onContinue = handler
  }

  private taskCreator: TaskCreator | null = null
  /** Route delegated child creation through the main application service. */
  attachTaskCreator(creator: TaskCreator) {
    this.taskCreator = creator
  }
  /** Named alias for callers that refer to the dependency as TaskService. */
  attachTaskService(creator: TaskCreator) {
    this.attachTaskCreator(creator)
  }

  private issueOps: { reviewStatus: (childId: string, verdict: 'pass' | 'fail', note?: string) => void } | null = null
  /** Issue 操作接口（委派审核流用） */
  attachIssueOps(ops: { reviewStatus: (childId: string, verdict: 'pass' | 'fail', note?: string) => void }) {
    this.issueOps = ops
  }

  /** 审核子任务（委派循环调用，runner 负责调度 issueOps 写状态） */
  applyChildReview(childId: string, verdict: 'pass' | 'fail', note?: string) {
    this.issueOps?.reviewStatus(childId, verdict, note)
  }

  /** 执行日志留痕（状态类事件：落盘 + 推 UI） */
  private note(taskId: string, text: string) {
    const full = this.store.appendEvent(taskId, { ts: Date.now(), kind: 'status' as const, text })
    if (full) this.pushEvent(taskId, full)
  }

  /** 武装流式派单嗅探（领队会话开始时调用；armed 才会在 text 事件上扫描 delegate 标记） */
  private armDelegateSniffer(taskId: string) {
    const existing = this.earlySpawns.get(taskId)
    if (existing) {
      // Follow-up turns reuse the same provider session. Reset only the
      // per-turn scanner and retain the session-wide seenKeys ledger.
      existing.buffer = ''
      existing.scanOffset = 0
      existing.closeScanOffset = 0
      existing.spawned.clear()
      existing.pending = []
      return
    }
    this.earlySpawns.set(taskId, { buffer: '', scanOffset: 0, closeScanOffset: 0, spawned: new Map(), seenKeys: new Set(), pending: [] })
  }
  /** 撤销流式期间提前建的单：领队回合失败时，基于半截输出建的单不可信，
   *  取消仍在排队/运行的子任务并清空嗅探状态（对齐旧语义——失败回合不产生子任务） */
  private abandonEarlySpawns(taskId: string) {
    const state = this.earlySpawns.get(taskId)
    if (!state) return
    this.earlySpawns.delete(taskId)
    if (!state.pending.length && ![...state.spawned.values()].some((e) => e.childId)) return
    const cancelSpawned = () => {
      for (const { childId } of state.spawned.values()) {
        if (!childId) continue
        const child = this.store.get(childId)
        if (child && (child.status === 'queued' || child.status === 'running')) {
          void this.cancel(childId)
          this.note(taskId, `回合失败：撤销提前接单的「${child.title}」`)
        }
      }
    }
    if (state.pending.length) void Promise.allSettled(state.pending).then(cancelSpawned)
    else cancelSpawned()
  }
  /**
   * 收编流式期间提前建的单（委派循环每轮调用）。
   * entries = 尚未交付过的建单（本轮并入等待/回灌）；seenKeys = 本会话出现过的全部
   * 派单 key——**永不清空**。缓冲区里旧标签文本随会话一直存在，若 take 清掉登记，
   * 之后任何一条 text 事件的重扫描都会把同一派单再建一遍（生产事故：同一任务派两次）。
   */
  async takeEarlySpawns(taskId: string): Promise<{ entries: Array<{ call: DelegateCall; childId: string }>; seenKeys: Set<string> }> {
    const state = this.earlySpawns.get(taskId)
    if (!state) return { entries: [], seenKeys: new Set() }
    if (state.pending.length) await Promise.allSettled(state.pending)
    state.pending = []
    const entries: Array<{ call: DelegateCall; childId: string }> = []
    for (const [key, entry] of state.spawned) {
      state.spawned.delete(key)
      state.seenKeys.add(key)
      if (entry.childId) entries.push(entry)
    }
    return { entries, seenKeys: new Set(state.seenKeys) }
  }
  /** 逐条 text 事件增量扫描：闭合一个 <delegate to="...">...</delegate> 即提前建单 */
  private sniffDelegates(taskId: string, delta?: string) {
    const state = this.earlySpawns.get(taskId)
    if (!state || !delta) return
    state.buffer += delta
    // Only parse newly closed markup. This keeps token-sized streams
    // amortized O(n) while retaining the complete buffer for the session's
    // seenKeys lifetime and for a possible partial tag crossing deltas.
    const closeTag = '</delegate>'
    let searchFrom = Math.max(state.closeScanOffset, state.buffer.length - delta.length - closeTag.length + 1)
    let closeAt = -1
    for (;;) {
      const found = state.buffer.indexOf(closeTag, searchFrom)
      if (found < 0) break
      closeAt = found
      searchFrom = found + 1
    }
    if (closeAt < 0) {
      state.closeScanOffset = Math.max(state.closeScanOffset, state.buffer.length - closeTag.length + 1)
      return
    }
    const scanEnd = closeAt + closeTag.length
    const source = state.buffer.slice(state.scanOffset, scanEnd)
    state.scanOffset = scanEnd
    state.closeScanOffset = scanEnd
    for (const call of parseDelegates(source)) {
      const key = `${call.to}\n${call.prompt}`
      // key 一经出现终身登记（spawned 在途 / seenKeys 已交付），会话内同一派单绝不重建
      if (state.spawned.has(key) || state.seenKeys.has(key)) continue
      state.seenKeys.add(key)
      // 先同步占位去重（建单异步进行中，后续 text 事件不得重复建单），完成后回填 childId
      state.spawned.set(key, { call, childId: '' })
      const p = this.spawnDelegateChild(taskId, call).then((child) => {
        if (child) {
          state.spawned.set(key, { call, childId: child.id })
          this.pushTask(taskId)
        }
      })
      state.pending.push(p)
    }
    // Drop already-scanned prefix after it is no longer needed. The cursor is
    // retained so an unfinished opening tag remains available for the next
    // delta, without allowing long transcripts to grow without bound.
    if (state.scanOffset > 128 * 1024 && state.scanOffset > state.buffer.length / 2) {
      state.buffer = state.buffer.slice(state.scanOffset)
      state.scanOffset = 0
      state.closeScanOffset = 0
    }
  }

  /**
   * 建一个委派子任务并立即入队（委派循环与流式嗅探共用）。
   * 目标解析、防环、层级闸、轮数预算闸都在这里（两条建单路径同一套护栏）；
   * 回灌不在本方法（仍归委派循环回合末处理）。返回 null = 被护栏拒绝（原因已留痕事件）。
   */
  async spawnDelegateChild(taskId: string, call: DelegateCall): Promise<Task | null> {
    const task = this.store.get(taskId)
    if (!task) return null
    const team = this.getTeam?.() ?? []
    const me = team.find((a) => a.id === task.agentId)
    const subs = (me?.subordinates ?? []).map((id) => team.find((a) => a.id === id)).filter(Boolean) as AgentLike[]
    const target =
      subs.find((a) => a.name.toLowerCase() === call.to.toLowerCase()) ??
      subs.find((a) => a.backend.toLowerCase() === call.to.toLowerCase())
    if (!target) {
      this.note(taskId, `⚠ 未找到可驱使的队员 "${call.to}"（不在你的队员名单里），跳过`)
      return null
    }
    // 防环：目标已在祖先链上（或就是自己）→ 拒绝派发；顺带执行层级闸与全链轮数预算闸
    const { inherited, depth, ancestors } = ancestorBudget(this.store, taskId)
    ancestors.add(me?.id ?? `@${task.backend}`)
    const targetKey = target.id || `@${target.backend}`
    if (ancestors.has(targetKey)) {
      this.note(taskId, `⚠ 拒绝派给 ${call.to}：它在当前委派链上（防环），请改派他人或自己做`)
      return null
    }
    const delegateMaxDepth = this.opts().delegateMaxDepth ?? MAX_DEPTH
    const delegateTotalRounds = this.opts().delegateMaxTotalRounds ?? MAX_TOTAL_ROUNDS
    if (depth >= delegateMaxDepth) {
      this.note(taskId, `⚠ 委派层级已达上限（${delegateMaxDepth} 层），拒绝派给 ${call.to}`)
      return null
    }
    if (delegateTotalRounds - inherited <= 0) {
      this.note(taskId, `⚠ 全链委派轮数预算已耗尽，拒绝派给 ${call.to}`)
      return null
    }
    let workdir = task.workdir
    let unavailableReason: string | undefined
    let worktree: WorktreeInfo | undefined
    if (task.workdir && (await this.gitUsable(task.workdir))) {
      // 基线分支显式传（缺省会从当前 HEAD 建——领队若中途动过分支，子任务基线会漂移）
      const base = (await currentBranch(task.workdir)) || undefined
      // worktree 创建与领队/其他子任务的 git 操作可能撞 index.lock：重试两次再放弃
      let wt: { path: string; metadata: WorktreeInfo } | null = null
      for (let attempt = 0; attempt < 3 && !wt; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, 500))
        wt = await createWorktree(task.workdir, `${taskId}_c${this.workerCount(taskId) + 1}`, base, taskId)
      }
      if (wt) {
        workdir = wt.path
        worktree = wt.metadata
      } else {
        unavailableReason = 'Git worktree creation failed; using the shared workspace'
      }
    } else if (task.workdir) {
      unavailableReason = 'Workspace is not a Git worktree; using the shared workspace'
    }
    const childPrompt = buildChildPrompt(sanitizeChildPrompt(call.prompt, task.workdir ?? ''), task.prompt)
    // 标题取 prompt 前 40 字——多个派单共享同一开场白时（如"每人审查两份报告"）标题会一模一样，
    // 看板上无法区分；与兄弟任务撞标题时追加序号
    const baseTitle = `${target.name}: ${call.prompt.slice(0, 40).replace(/\n/g, ' ')}`
    const workerIndex = this.workerCount(taskId) + 1
    const siblings = this.store.list().filter((t) => t.parentTaskId === taskId)
    const title = siblings.some((s) => s.title === baseTitle) ? `${baseTitle} #${workerIndex}` : baseTitle
    // 登记 key：循环侧新建的单同样进入会话级去重（否则后续回合复述同一派单会再建）
    this.earlySpawns.get(taskId)?.seenKeys.add(`${call.to}\n${call.prompt}`)
    const childInput = {
      title,
      prompt: childPrompt,
      workdir,
      backend: target.backend,
      ...(target.id ? { agentId: target.id } : {}),
      parentTaskId: taskId,
      workerIndex,
      ...(unavailableReason ? { unavailableReason } : {}),
      ...(worktree ? { worktree } : {})
    }
    const child = this.taskCreator
      ? (typeof this.taskCreator === 'function' ? this.taskCreator(childInput) : this.taskCreator.createChildTask(childInput))
      : this.store.create({
        // Standalone runner smoke harnesses predate TaskService. Production
        // always attaches the creator above, so this preserves that legacy API.
        ...childInput,
        titleAuto: true
      })
    if (worktree) {
      await setWorktreeOwner(worktree.path, child.id)
      worktree = { ...worktree, ownerTaskId: child.id }
      this.store.update(child.id, { worktree })
    }
    this.note(taskId, `⚡ 已接单：${target.name} ← ${call.prompt.slice(0, 50).replace(/\n/g, ' ')}${call.prompt.length > 50 ? '…' : ''}`)
    this.enqueue(this.store.get(child.id)!)
    return child
  }
  private workerCount(taskId: string) {
    return this.store.list().filter((t) => t.parentTaskId === taskId).length
  }
  /** git 仓库判定（带缓存：同 workdir 只探测一次） */
  private gitUsableCache = new Map<string, boolean>()
  private async gitUsable(dir: string): Promise<boolean> {
    let usable = this.gitUsableCache.get(dir)
    if (usable === undefined) {
      usable = await isGitRepo(dir)
      this.gitUsableCache.set(dir, usable)
    }
    return usable
  }

  /** agent 引用的 API 预设 → 会话连接覆盖（预设 + 模型须同时具备） */
  private resolveConnection(agentId?: string) {
    const me = (this.getTeam?.() ?? []).find((a) => a.id === agentId)
    const preset = me?.presetId ? this.getPresets?.().find((p) => p.id === me.presetId) : undefined
    return me?.model && preset ? { name: preset.name, baseURL: preset.baseURL, apiKey: preset.apiKey } : undefined
  }

  private newRunId(taskId: string) {
    return `run_${taskId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
  }

  /** Finish one successful turn, including any delegation emitted before the final message. */
  private async completeTurn(taskId: string, session: BackendSession, r: BackendTurnResult): Promise<string> {
    const task = this.store.get(taskId)!
      const team = this.getTeam?.() ?? []
      const me = team.find((a) => a.id === task.agentId)
      let finalText = r.response
      /** <continue> 与 delegate 同源解析：领队用委派循环的全部回合文本，普通任务用首回合两源 */
      let scanTexts: string[] = [r.delegationText ?? '', r.response]
      if (me?.subordinates?.length && task.backend !== 'dsh') {
        const outcome = await runDelegationLoop(taskId, session, r, {
          store: this.store,
          runner: this,
          getTeam: () => this.getTeam?.() ?? [],
          opts: () => ({
            mode: this.opts().mode,
            notify: this.opts().notify,
            maxParallel: Math.max(1, this.opts().workerConcurrency ?? this.opts().concurrency),
            maxRounds: this.opts().delegateMaxRounds,
            maxTotalRounds: this.opts().delegateMaxTotalRounds,
            maxDepth: this.opts().delegateMaxDepth
          }),
          pushTask: (id) => this.pushTask(id),
          pushEvent: (id, e) => this.pushEvent(id, e),
          applyReview: (childId, verdict, note) => this.applyChildReview(childId, verdict, note)
        })
        finalText = outcome.finalText || r.response
        scanTexts = outcome.scanTexts
      }
      finalText = this.handleContinue(taskId, task, scanTexts, finalText)
      await this.finalizeDone(taskId, finalText)
    return finalText
  }

  /**
   * 阶段接力：回合文本里有 <continue> 时在同一 Issue 创建后继执行（新会话硬切）。
   * 护栏：委派子任务不参与（生命周期归委派循环）；同 issue handoff 任务 ≥ 8 拒绝；
   * 剥掉标记防止外漏，并在结果末尾留指向。
   */
  private handleContinue(taskId: string, task: Task, scanTexts: string[], finalText: string): string {
    const issueId = task.issueId
    if (task.parentTaskId || !issueId) return finalText
    const cont = parseContinueMerged(...scanTexts)
    if (!cont) return finalText
    const stripped = stripContinue(finalText)
    const note = (text: string) => {
      const e = { ts: Date.now(), kind: 'status' as const, text }
      const full = this.store.appendEvent(taskId, e)
      if (full) this.pushEvent(taskId, full)
    }
    // Cancelled handoffs are abandoned attempts and must not consume the
    // finite relay chain budget. Failed, queued, running and completed
    // handoffs remain durable chain members for audit and loop prevention.
    const chainLimit = this.opts().maxHandoffChain ?? MAX_HANDOFF_CHAIN
    const handoffCount = this.store.list().filter((t) =>
      t.issueId === task.issueId && t.trigger === 'handoff' && t.status !== 'cancelled'
    ).length
    if (handoffCount >= chainLimit) {
      note(`⚠ 阶段接力已达上限（${chainLimit} 次），<continue> 被拒绝；请人工推进后续阶段`)
      return stripped
    }
    let ok = false
    try {
      ok = !!this.onContinue?.({ sourceTaskId: taskId, issueId, brief: cont.brief, start: cont.start })
    } catch (e) {
      note(`⚠ 阶段接力创建失败：${e instanceof Error ? e.message : String(e)}`)
      return stripped
    }
    if (!ok) return stripped
    note(`阶段接力：下一阶段已${cont.start === 'auto' ? '开始执行' : '备好（待启动）'}（同一 Issue 的新执行 #${handoffCount + 1}）`)
    return `${stripped}\n\n→ 阶段接力：下一阶段已${cont.start === 'auto' ? '开始执行' : '备好（待启动）'}，见该 Issue 的最新执行。`
  }

  /**
   * 隐藏回合：让 agent 根据执行内容重起一个简短标题。
   * 调用方需先把事件管道切到静默（titleMode），失败静默返回 false，不影响任务本体。
   */
  private async retitleByAgent(taskId: string, session: BackendSession): Promise<boolean> {
    try {
      const r = await this.sendTurn(
        taskId,
        session,
        '【系统】请根据这次任务的执行内容，用不超过 24 个字重起一个简短标题（概括做了什么，不要复述指令原文）。只输出标题本身：不要编号、引号、书名号或任何解释。'
      )
      if (!r.ok) return false
      const line = r.response
        .split(/\r?\n/)
        .map((s) => s.replace(/^[#>*\-\s]+/, '').replace(/["'「」《》`*]/g, '').trim())
        .find((s) => s.length > 0)
      if (!line) return false
      this.store.update(taskId, { title: line.slice(0, 60), titleAuto: false })
      return true
    } catch {
      return false
    }
  }

  /**
   * Send one follow-up and return the exact turn payload, including prior messages.
   * 等待全程由空转看门狗护送：有事件就续命；真超时时先停回合再返回错误，
   * 后端不会留一个还在跑的僵尸回合跟下一次操作抢会话。
   */
  async sendTurn(taskId: string, session: BackendSession, content: string): Promise<BackendTurnResult> {
    const current = this.store.get(taskId)
    if (!current || current.status !== 'running') {
      return { ok: false, response: '', error: 'Task execution is no longer active' }
    }
    // A task owns at most one provider turn. This also prevents a delayed
    // orchestration callback from replacing the waiter for a live turn.
    if (this.pendingResume.has(taskId)) {
      return { ok: false, response: '', error: 'Task already has an active turn' }
    }
    const gen = this.bumpTurnGen(taskId)
    const context = this.sessionEventContexts.get(session)
    // A live BackendSession owns one callback multiplexer for all sends, so its
    // active generation must be advanced for follow-up turns. The context is
    // still owner-bound; callbacks from a replaced/late session are rejected by
    // EventGate before this generation can be observed.
    if (context) context.generation = gen
    let settleTurn: (v: BackendTurnResult) => void = () => {}
    const turn = new Promise<BackendTurnResult>((resolve) => {
      settleTurn = resolve
      this.pendingResume.set(taskId, (v) => {
        if ((this.turnGen.get(taskId) ?? 0) !== gen) return // 已放弃回合的迟到终态：丢弃，不污染新回合
        resolve(v)
      })
    })
    const life = this.lifecycle(taskId)
    life.gate.setPendingResume(true)
    let idleFired = false
    const { timeout, cancel } = this.idleSentinel(taskId, () => { idleFired = true })
    try {
      // send 不阻塞裁决：立即失败（连接已死等）要马上浮出，不能干等空转上限；
      // 看门狗触发的 stop 会让 send 以 reject 收尾，统一按超时语义上报
      void session.send(content).catch((e) => {
        settleTurn(idleFired ? turnTimeoutError(this.turnBudgetMs(taskId)) : { ok: false, response: '', error: e instanceof Error ? e.message : String(e) })
      })
      return await Promise.race([turn, timeout])
    } finally {
      cancel()
      this.pendingResume.delete(taskId)
      life.gate.setPendingResume(false)
    }
  }

  /** 执行一个任务（首回合） */
  private async run(taskId: string) {
    const task = this.store.get(taskId)
    if (!task || task.status !== 'queued') return
    this.toolWindows.delete(taskId)
    const backend = this.backends.get(task.backend)
    if (!backend) {
      this.failTask(taskId, `未知后端: ${task.backend}`)
      this.pushTask(taskId)
      return
    }
    const isWorker = !!task.parentTaskId
    this.store.update(taskId, { status: 'running', startedAt: Date.now(), runId: this.newRunId(taskId), error: undefined, failure: undefined })
    this.pushTask(taskId)
    this.recordUser(taskId, task.prompt)
    const runGen = this.bumpTurnGen(taskId)
    const eventContext: { generation: number; sessionOwner?: string } = { generation: runGen }

    // 首回合完成信号
    let firstTurnDone: ((v: BackendTurnResult) => void) | null = null
    const firstTurnPromise = new Promise<BackendTurnResult>((resolve) => {
      firstTurnDone = resolve
    })

    // agent 身份注入：人设 + （领队时）委派协议
    const team = this.getTeam?.() ?? []
    const me = team.find((a) => a.id === task.agentId)
    let prompt = buildAgentPrompt(me, task.prompt, team)
    if (task.handoff) {
      prompt = `${prompt}

【交接备注（指派者为本次执行划定的范围指令：优先按它收窄工作，但不要把它当作需要回复的评论）】
> ${task.handoff}`
    }
    if (me?.subordinates?.length && task.backend !== 'dsh') {
      const block = buildDelegationBlock(me, team)
      if (block) prompt = `${prompt}\n\n${block}`
    }
    // 阶段接力协议（非委派子任务：worker 的生命周期归委派循环管）
    if (!isWorker) prompt = `${prompt}\n\n${CONTINUE_BLOCK}`
    // 领队会话武装流式派单嗅探：闭合一个 <delegate> 即提前建单（回灌仍只在回合末）
    const isLeader = !!me?.subordinates?.length && task.backend !== 'dsh'
    if (isLeader) this.armDelegateSniffer(taskId)

    // 看门狗在 backend.start 之前武装：握手/建会话阶段挂死同样按空转判败并可硬杀，
    // 不再永久卡住 running 状态与并发槽；启动期间的线级心跳照常续命
    const sentinel = this.idleSentinel(taskId)
    try {
      // 标题回合的事件不进对话流（text/final/usage 静默），onTurnEnd 照常驱动 sendTurn
      let titleMode = false
      const baseEvents = this.makeEvents(taskId, (r) => firstTurnDone?.(r), eventContext)
      const session = await this.executor.start(
        () => backend.start({
          prompt,
          workdir: task.workdir,
          mode: this.opts().mode,
          model: me?.model,
          connection: this.resolveConnection(task.agentId),
          // 自动重试第 1 次带会话续跑（maybeAutoRetry 故意保留 sessionId）：从失败处接着干，
          // 不再整任务从头重来；手动"重新运行"会清 sessionId，恒新会话不受影响
          resumeSessionId: task.sessionId || undefined,
          events: {
            ...baseEvents,
            onEvent: (e) => {
              if ((this.turnGen.get(taskId) ?? 0) !== eventContext.generation || this.store.get(taskId)?.status !== 'running') return
              this.touchWatchdog(taskId) // 静默事件（标题回合增量）不进日志，但同样是进展信号
              if (titleMode && e.kind !== 'error') return
              baseEvents.onEvent(e)
            }
          }
        }),
        sentinel.timeout,
        () => (this.turnGen.get(taskId) ?? 0) === eventContext.generation && this.store.get(taskId)?.status === 'running'
      )
      eventContext.sessionOwner = session.sessionId
      this.lifecycle(taskId).gate.setSessionOwner(session.sessionId)
      void this.lifecycle(taskId).attachSession({ generation: runGen, sessionOwner: session.sessionId }, session)
      this.sessionEventContexts.set(session, eventContext)
      this.sessions.set(taskId, session)
      this.store.update(taskId, { sessionId: session.sessionId })
      this.pushTask(taskId)

      // 首回合由同一哨兵继续护送：长时间无任何进展先停回合再判失败，不再无限等待
      let r: BackendTurnResult
      try {
        r = await Promise.race([firstTurnPromise, sentinel.timeout])
      } finally {
        sentinel.cancel()
      }
      if (r.ok) {
        // 自动派生标题的任务：让 agent 总结重起标题（隐藏回合；worker/dsh 除外——前者会与回灌争用会话，后者不支持续聊）
        if (task.titleAuto && !task.parentTaskId && task.backend !== 'dsh') {
          titleMode = true
          this.lifecycle(taskId).setTitleMode(true)
          const titled = await this.retitleByAgent(taskId, session)
          titleMode = false
          this.lifecycle(taskId).setTitleMode(false)
          if (titled) this.pushTask(taskId)
        }
        // 领队：进入委派循环（截获 <delegate> 标记 → 并行子任务 → 回灌 → 继续）
        // 0.7.0 起 worker 也可以是子领队（带 subordinates 即生效；delegate 内有防环与层级/预算闸）
        const finalText = await this.completeTurn(taskId, session, r)
        if (this.opts().notify) this.notify(task, '完成', finalText)
      } else {
        await this.closeSession(taskId)
        this.failTask(taskId, r.error || '回合失败')
        this.maybeAutoRetry(taskId)
        this.notifyFailure(taskId, task, r.error || '')
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      await this.closeSession(taskId)
      this.failTask(taskId, msg)
      this.maybeAutoRetry(taskId)
      this.notifyFailure(taskId, task, msg)
    } finally {
      sentinel.cancel()
      this.store.flushEvents(taskId)
      this.launchHandles.delete(taskId)
      // Session-level seenKeys are intentionally retained for follow-up turns.
      this.lastTerminalResponses.delete(taskId)
      this.pushTask(taskId)
    }
  }

  /**
   * 自动重试（P4）：仅 retryable 的瞬态失败（限流/超时/进程崩溃/沙箱），上限 2 次。
   * 第 1 次优先带会话续跑（同后端可 resume）；第 2 次强制新会话（会话可能已被污染）。
   * 手动"重新运行"不受此影响（恒新会话、attempt 清零）。
   * 限流（429）退避后再重试：立即重打只会继续 429（各重试叠加请求量形成正反馈）。
   */
  private maybeAutoRetry(taskId: string) {
    const task = this.store.get(taskId)
    if (!task || task.status !== 'failed') return
    const failure = task.failure
    const maxAttempts = this.opts().maxRetryAttempts ?? 2
    const decision = decideRetry(task, failure, maxAttempts, this.opts().retryBackoffMs)
    if (!decision.retry || !failure) return
    const next = decision.attempt
    const fresh = decision.freshSession
    const goalBudget = task.goalId ? ` · Phase execution ${next + 1}/${maxAttempts + 1}` : ''
    const schedule = () => {
      this.retryTimers.delete(taskId)
      // 退避等待期间用户可能已取消/手动处理：不再是 failed 态就放弃重试
      if (this.store.get(taskId)?.status !== 'failed') return
      this.store.update(taskId, {
        status: 'queued',
        endedAt: undefined,
        runId: undefined,
        attempt: next,
        ...(fresh ? { sessionId: undefined } : {})
      })
      const full = this.store.appendEvent(taskId, {
        ts: Date.now(),
        kind: 'status',
        text: `⟳ 自动重试 ${next}/2（${failure.title}）${fresh ? '· 新会话' : '· 续会话'}${goalBudget}`
      })
      if (full) this.pushEvent(taskId, full)
      this.pushTask(taskId)
      this.enqueue(this.store.get(taskId)!)
    }
    const delayMs = decision.delayMs
    if (delayMs > 0) {
      this.clearRetry(taskId)
      const full = this.store.appendEvent(taskId, {
        ts: Date.now(),
        kind: 'status',
        text: `⟳ ${failure.title}：退避 ${Math.round(delayMs / 1000)}s 后自动重试 ${next}/2（${fresh ? '新会话' : '续会话'}）${goalBudget}`
      })
      if (full) this.pushEvent(taskId, full)
      this.pushTask(taskId)
      const timer = setTimeout(schedule, delayMs)
      this.retryTimers.set(taskId, timer)
    } else {
      schedule()
    }
  }

  private notify(task: Task, what: string, body: string) {
    if (!this.opts().notify) return
    this.ports.notify(task, what, body)
  }

  /** Cancellation winning a start/turn race is not a user-visible failure. */
  private notifyFailure(taskId: string, snapshot: Task, msg: string) {
    if (this.store.get(taskId)?.status === 'cancelled') return
    this.notify(snapshot, '失败', msg)
  }

  /** 续聊：在已完成任务的会话上追加消息，任务回到 running。
   *  opts.relay 仅由「⇥ 接力下一阶段」按钮传入（显式人工入口）；自由追问不再按关键词猜测接力意图。 */
  async followUp(taskId: string, content: string, opts?: { relay?: boolean }): Promise<{ ok: boolean; error?: string }> {
    const task = this.store.get(taskId)
    if (!task) return { ok: false, error: '任务不存在' }
    const message = content.trim()
    if (!message) return { ok: false, error: '追问不能为空' }
    if (task.status === 'running') return { ok: false, error: '任务正在运行（长时间无输出时可先「停止」再「重新运行」）' }
    // cancelled 也放行：目标模式停止/用户取消后的任务仍可追问续聊，别把 Issue 卡死在"任务尚未完成"
    if (task.status !== 'done' && task.status !== 'failed' && task.status !== 'cancelled') return { ok: false, error: '任务尚未完成' }
    const backend = this.backends.get(task.backend)
    if (!backend) return { ok: false, error: '后端不可用' }
    if (!this.sessions.get(taskId) && !task.sessionId) return { ok: false, error: '无会话可恢复' }
    this.recordUser(taskId, message)
    // 显式接力入口（按钮）：把人工意图翻译成协议标记指令（recordUser 仍记原话）；
    // 追问正文里出现"下一阶段"等字样不会被再当成接力信号
    const wantsHandoff = !task.parentTaskId && opts?.relay === true
    const turnContent = wantsHandoff ? `${HANDOFF_CUE}\n（用户原话：${message}）` : message
    // 领队续聊同样武装流式派单嗅探（追问里派发 → 提前建单）
    const me = (this.getTeam?.() ?? []).find((a) => a.id === task.agentId)
    if (me?.subordinates?.length && task.backend !== 'dsh') this.armDelegateSniffer(taskId)

    const beginRun = () => {
      this.toolWindows.delete(taskId)
      this.store.update(taskId, { status: 'running', startedAt: Date.now(), runId: this.newRunId(taskId), endedAt: undefined, error: undefined, failure: undefined })
      this.pushTask(taskId)
    }

    // 1) 内存会话健在：直接续聊
    let liveSession = this.sessions.get(taskId)
    if (liveSession) {
      beginRun()
      try {
        const r = await this.sendTurn(taskId, liveSession, turnContent)
        if (!r.ok) throw new Error(r.error || '续聊回合失败')
        const finalText = await this.completeTurn(taskId, liveSession, r)
        if (this.opts().notify) this.notify(task, '完成', finalText)
        return { ok: true }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (!SESSION_DEAD_RE.test(msg)) {
          // A failed follow-up turn invalidates the provider session as well;
          // close it before dropping the session-wide delegate ledger.
          await this.closeSession(taskId)
          this.failTask(taskId, msg)
          this.pushTask(taskId)
          return { ok: false, error: msg }
        }
        // 后端连接已死（进程退出/管道断开）：丢弃内存会话，走下面的 resume 重建——
        // 以前这种情况只能重启应用，现在等价于把重启后的恢复路径内置
        await this.closeSession(taskId)
        liveSession = undefined
      }
    }

    // 2) resume 路径：内存会话丢失（应用重启/连接死亡）时按 sessionId 重建
    if (!task.sessionId) {
      const msg = '无会话可恢复'
      this.failTask(taskId, msg)
      this.pushTask(taskId)
      return { ok: false, error: msg }
    }
    beginRun()
    // 续聊沿用 agent 钉死的模型（zcode resume 每次重传 runtimeModel；CLI --model 与 --resume 正交）
    let resumeSession: BackendSession
    // 看门狗在 backend.start 之前武装：resume 重建阶段挂死同样按空转判败，
    // 不永久卡住 running 状态（此前只能重启应用）
    const sentinel = this.idleSentinel(taskId)
    try {
      const gen = this.bumpTurnGen(taskId)
      const eventContext: { generation: number; sessionOwner?: string } = { generation: gen }
      const life = this.lifecycle(taskId)
      const turn = new Promise<BackendTurnResult>((resolve) => {
        this.pendingResume.set(taskId, (v) => {
          if ((this.turnGen.get(taskId) ?? 0) !== gen) return
          resolve(v)
        })
      })
      life.gate.setPendingResume(true)
      resumeSession = await this.executor.start(
        () => backend.start({
          prompt: turnContent,
          workdir: task.workdir,
          mode: this.opts().mode,
          model: me?.model,
          connection: this.resolveConnection(task.agentId),
          resumeSessionId: task.sessionId,
          events: this.makeEvents(taskId, undefined, eventContext)
        }),
        sentinel.timeout,
        () => (this.turnGen.get(taskId) ?? 0) === eventContext.generation && this.store.get(taskId)?.status === 'running'
      )
      this.sessionEventContexts.set(resumeSession, eventContext)
      eventContext.sessionOwner = resumeSession.sessionId
      this.lifecycle(taskId).gate.setSessionOwner(resumeSession.sessionId)
      void this.lifecycle(taskId).attachSession({ generation: gen, sessionOwner: resumeSession.sessionId }, resumeSession)
      this.sessions.set(taskId, resumeSession)
      this.store.update(taskId, { sessionId: resumeSession.sessionId })
      this.pushTask(taskId)
      try {
        const r = await Promise.race([turn, sentinel.timeout])
        if (!r.ok) throw new Error(r.error || '续聊回合失败')
        const finalText = await this.completeTurn(taskId, resumeSession, r)
        if (this.opts().notify) this.notify(task, '完成', finalText)
        return { ok: true }
      } finally {
        sentinel.cancel()
        this.pendingResume.delete(taskId)
        life.gate.setPendingResume(false)
      }
    } catch (e) {
      this.pendingResume.delete(taskId)
      this.lifecycle(taskId).gate.setPendingResume(false)
      this.disarmWatchdog(taskId)
      const msg = e instanceof Error ? e.message : String(e)
      this.failTask(taskId, msg)
      this.pushTask(taskId)
      return { ok: false, error: msg }
    }
  }

  async cancel(taskId: string): Promise<{ ok: boolean; error?: string }> {
    const task = this.store.get(taskId)
    if (!task) return { ok: false, error: '任务不存在' }
    const retryPending = this.clearRetry(taskId)
    if (task.status === 'failed' && retryPending) {
      this.bumpTurnGen(taskId)
      this.store.update(taskId, { status: 'cancelled', endedAt: Date.now() })
      this.lifecycle(taskId).dispose()
      this.pushTask(taskId)
      this.store.flushEvents(taskId)
      return { ok: true }
    }
    if (task.status === 'queued') {
      this.bumpTurnGen(taskId)
      this.store.update(taskId, { status: 'cancelled', endedAt: Date.now() })
      this.lifecycle(taskId).dispose()
      this.pushTask(taskId)
      return { ok: true }
    }
    if (task.status !== 'running') return { ok: false, error: '任务不在运行中' }
    const session = this.sessions.get(taskId)
    this.store.update(taskId, { status: 'cancelled', endedAt: Date.now() })
    this.pushTask(taskId)
    // Resolve start/send races immediately. Waiting for the idle timeout would
    // keep a scheduler slot occupied after cancellation.
    this.turnWatchdogs.get(taskId)?.expire()
    // 级联取消子任务（领队被取消时，运行中/排队的子任务一并停）
    for (const child of this.store.list().filter((t) => t.parentTaskId === taskId && (t.status === 'running' || t.status === 'queued'))) {
      void this.cancel(child.id)
    }
    // 先用启动句柄硬停（一次性 CLI 的 session 可能还没返回）
    // Once a session is attached its stop method owns the provider process;
    // the launch handle is only needed while start is still pending.
    if (!session) {
      try { await Promise.resolve(this.launchHandles.get(taskId)?.stop()) } catch {}
    }
    this.launchHandles.delete(taskId)
    try {
      await this.awaitCleanup(() => session?.stop())
    } catch {}
    try {
      await this.awaitCleanup(() => session?.close())
    } catch {}
    this.sessions.delete(taskId)
    this.permissionBroker.cancelTask(taskId)
    this.toolWindows.delete(taskId)
    this.disarmWatchdog(taskId)
    this.earlySpawns.delete(taskId)
    this.lifecycle(taskId).dispose()
    this.lastTerminalResponses.delete(taskId)
    this.store.flushEvents(taskId)
    return { ok: true }
  }

  async shutdown() {
    // First invalidate callbacks and stop owned sessions, then wait for any
    // Executor start races that resolve late and still need closing.
    for (const timer of this.retryTimers.values()) clearTimeout(timer)
    this.retryTimers.clear()
    for (const [taskId, handle] of this.launchHandles) {
      this.bumpTurnGen(taskId)
      if (!this.sessions.has(taskId)) {
        try { await Promise.resolve(handle.stop()) } catch {}
      }
    }
    this.launchHandles.clear()
    // Shutdown is a lifecycle boundary, not a task failure. Invalidate the
    // callbacks and clear watchdog timers without resolving them as timeout;
    // the app is already leaving and must not rewrite active tasks to failed.
    for (const [taskId, watchdog] of this.turnWatchdogs) {
      this.bumpTurnGen(taskId)
      clearTimeout(watchdog.timer)
    }
    this.turnWatchdogs.clear()
    for (const [, s] of this.sessions) {
      await this.awaitCleanup(() => s.stop())
      await this.awaitCleanup(() => s.close())
    }
    this.sessions.clear()
    this.earlySpawns.clear()
    this.lastTerminalResponses.clear()
    for (const lifecycle of this.turnLifecycles.values()) lifecycle.dispose()
    this.turnLifecycles.clear()
    this.permissionBroker.shutdown()
    this.toolWindows.clear()
    await this.executor.shutdown()
  }

  sessionCount() {
    return this.sessions.size
  }
}
