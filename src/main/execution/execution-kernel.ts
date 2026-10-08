// 执行内核（批次 2）：会话安装 / 回合身份 / 启动句柄 / 失效 / 退出确认原语的状态唯一所有者。
// 设计与迁移归属见 docs/plan/runner-decomposition.md §5.1/§6.2；TaskRunner 保留编排与外部门面，
// 经窄端口回调业务侧（pushTask、工作流态清扫、事件组装），绝不反向依赖 runner。
// 内核边界：只管身份签发、登记、失效、退出确认原语——业务裁决（prompt、委派、通知、
// pipeline 结算）一律留在 runner 编排层（被否决的「上帝内核」见 §4.5）。
import type { ExecutionOwner, Task, TaskStatus } from '../../shared/types'
import { sameExecutionOwner, type TaskExpectation } from '../store'
import type { BackendSession, BackendSessionEvents, BackendTurnResult, BackendTurnStamp } from '../backends/types'
import { runCondition, type RunClaim, type TurnRecord } from './identity'
import { SessionTurnRouter } from './session-turn-router'
import { awaitCleanup, checkedCleanup } from './cleanup'
import { TurnLifecycle, type EventGateToken } from '../turn-lifecycle'
import { sameWorktreePath } from '../git'

/** 回合事件组装请求（批次 2 由 runner 的 makeTurnEvents 提供，批次 3 后由 turn-events 模块提供） */
export interface TurnEventsRequest {
  taskId: string
  router: SessionTurnRouter
  claim: RunClaim
  token: EventGateToken
  stamp: BackendTurnStamp
  onTurnEnd?: (r: BackendTurnResult) => void
}

/** closeSession 的退役会话暂存条目（批次 2 由 runner 持 retiredProviderSessions 台账，批次 5 移入 termination 后收窄） */
export interface RetiredSessionEntry {
  taskId: string
  session: BackendSession
  closing?: Promise<void>
  closed: boolean
}

/** 会话释放台账条目：同会话重复登记复用在途 promise；失败保留 release 供重试；完成摘账（I7.4） */
export interface WorktreeSessionRelease {
  workdir: string
  promise: Promise<void>
  release: () => Promise<void>
  failed: boolean
}

/**
 * 回合空转上限：等待终态期间「没有任何事件」（文本增量/工具/状态）达到该时长才判超时。
 * 有事件即续命——真实 agent 一个回合跑十几分钟很正常，固定总时长会把还在工作的回合误杀。
 * 预算来源经端口注入（runner 的 turnBudgetMs：测试 env > 设置，dsh 按固定总预算）。
 */
const turnTimeoutError = (budgetMs: number): BackendTurnResult =>
  ({ ok: false, response: '', error: `回合超时（${Math.round(budgetMs / 60000)} 分钟无进展，已停止本回合）` })
export { turnTimeoutError }

/**
 * 内核端口：每个端口都是单个动作，不暴露任何 Map（窄端口注入，非「Context 袋」，§4.2）。
 * execution/* → runner.ts 反向 import 严禁；需要回调一律经此注入（§5.2）。
 */
export interface ExecutionKernelPorts {
  /** 持久层只读探针：isCurrentRun 与 bumpTurnGen 的状态同步（不持有 TaskStore 引用） */
  matches(taskId: string, expected: TaskExpectation): boolean
  status(taskId: string): TaskStatus | undefined
  /** releaseWorktreeSessions 的终态/身份核对快照（只读三字段，不暴露整表） */
  taskSnapshot(taskId: string): Pick<Task, 'status' | 'runId' | 'executionOwner'> | undefined
  /** 回合预算（runner：测试 env > 设置；dsh 固定总预算） */
  turnBudgetMs(taskId: string): number
  /** 会话安装/回收后的广播（runner：pushTask） */
  onSessionInstalled(taskId: string): void
  /** 工作流态清扫（runner 单点实现：权限在飞/doom 窗/嗅探与拒单账/worker 编号预留）；
   *  scope 显式列出本次要清的半部——五个清扫位各自的原语义逐位保持，不偷偷扩大 */
  purgeTaskWorkflowState(taskId: string, scope: { permissions?: boolean; delegationLedger?: boolean; workerIndex?: boolean }): void
  /** 事件批 drain（批次 2 由 runner 实现 closeEventBatches，批次 3 后委托 EventPump） */
  drainEvents(taskId: string, timeoutMs?: number): Promise<boolean>
  /** 回合事件组装（批次 2 由 runner 提供 makeTurnEvents，批次 3 后由 turn-events 模块提供） */
  composeTurnEvents(req: TurnEventsRequest): BackendSessionEvents
  /** closeSession 的退役会话暂存裁决与落账（runner：meetingId 判定 + retiredProviderSessions） */
  parkRetiredSession(key: string, entry: RetiredSessionEntry): void
  /** 孤儿启动句柄兜底（runner：executor.registerCleanup） */
  registerOrphanLaunchCleanup(key: string | undefined, action: () => Promise<void>): Promise<void>
}

/** 任务级执行态清扫位（F2 统一清单）：内核持有状态的单点收口。
 *  新增任务级执行态必须登记进 sweepTaskExecutionState 的固定次序里，五个清扫位自动跟随；
 *  工作流态（runner 侧）经 ports.purgeTaskWorkflowState 单点回调。 */
export interface TaskSweepOptions {
  /** 看门狗处置：expire=按超时裁决（身份核对→换代→停会话/句柄→决议等待方）；disarm=静默拆除 */
  watchdog?: 'expire' | 'disarm'
  /** 作废在飞回合回调（bumpTurnGen：换代 + 状态同步 + 清会话主） */
  invalidateTurns?: boolean
  /** 清重试定时器（clearTimeout + 摘除） */
  retry?: boolean
  /** 摘运行认领 */
  claim?: boolean
  /** 摘启动句柄 */
  launch?: boolean
  /** 会话登记处置：drop=摘 sessions/sessionWorkdirs 并退役路由；retireOnly=仅退役路由
   *  （会话登记留给终止协调按身份摘除，批次 5 前的 terminateSession 语义） */
  session?: 'drop' | 'retireOnly'
  /** 工作流态清扫（经端口回调 runner 单点实现） */
  workflow?: { permissions?: boolean; delegationLedger?: boolean; workerIndex?: boolean }
  /** 摘末轮终态去重缓存 */
  terminal?: boolean
  /** 生命周期门处置：dispose=作废并保留 Map 项（cancel/retireExecutionState 原语义，
   *  含「不存在则惰性创建再作废」）；disposeDrop=作废并摘除（forget/shutdown 原语义） */
  lifecycle?: 'dispose' | 'disposeDrop'
}

export class ExecutionKernel {
  private readonly ports: ExecutionKernelPorts
  /** taskId → 安装的 provider 会话（与 sessionWorkdirs 成对增删，I1.5） */
  readonly sessions = new Map<string, BackendSession>()
  /** 会话绑定的工作目录（安装该会话时 backend.start 用的 cwd）。续链换基线后
   *  task.workdir 变更，followUp 凭它发现内存会话还跑在旧目录，强制走 resume 重建。 */
  readonly sessionWorkdirs = new Map<string, string>()
  readonly worktreeSessionReleases = new Map<BackendSession, WorktreeSessionRelease>()
  /** Runs this runner committed to. Only a committed claim may start a backend
   *  or authorize a later write; the durable record is the tie-breaker. */
  readonly claims = new Map<string, RunClaim>()
  /** Per-session turn router: the single place that maps an adapter callback to
   *  a turn. Turn records are immutable; only the routing pointer moves. */
  readonly sessionTurns = new WeakMap<BackendSession, SessionTurnRouter>()
  /** Turn sequence for stamp ids (monotonic across sessions of one runner). */
  private turnSeq = 0
  readonly turnStartObservers = new Map<string, (identity: { taskId: string; runId: string; turnId: string }) => void>()
  /** 启动即注册的中止句柄（一次性 CLI 在 session 返回前就要能取消） */
  readonly launchHandles = new Map<string, { stop: () => void | Promise<unknown> }>()
  /** Delayed provider retries must be cancellable and must not outlive shutdown. */
  readonly retryTimers = new Map<string, NodeJS.Timeout>()
  /** Last accepted terminal payload, used to quarantine duplicate callbacks
   * from the preceding turn while an internal title turn is in flight. */
  readonly lastTerminalResponses = new Map<string, string>()
  /** 回合空转看门狗：等待终态期间任务有新事件即续命，长时间无进展才判超时 */
  readonly turnWatchdogs = new Map<string, { timer: NodeJS.Timeout; expire: () => void; budgetMs: number }>()
  /** Lifecycle gate: prevents abandoned-turn callbacks from resolving a newer waiter. */
  /** One gate/lifecycle per task. The Task remains the durable compatibility
   * record; these objects only own in-memory callback admission state. */
  readonly turnLifecycles = new Map<string, TurnLifecycle>()

  constructor(ports: ExecutionKernelPorts) {
    this.ports = ports
  }

  // ---------------------------------------------------------------- 身份签发

  /** Resolve a caller-supplied run id to the claim this kernel committed.
   *  A run id this runner never claimed cannot authorize turns or writes. */
  claimForRun(taskId: string, runId?: string): RunClaim | undefined {
    const claim = this.claims.get(taskId)
    return claim && (runId === undefined || claim.runId === runId) ? claim : undefined
  }

  /** True while the exact claimed Run is still the committed running one. */
  isCurrentRun(claim: RunClaim | undefined): claim is RunClaim {
    return !!claim && this.ports.matches(claim.taskId, runCondition(claim))
  }

  setClaim(taskId: string, claim: RunClaim) {
    this.claims.set(taskId, claim)
  }

  dropClaim(taskId: string) {
    this.claims.delete(taskId)
  }

  dropClaimIfCurrent(taskId: string, claim: RunClaim) {
    if (this.claims.get(taskId) === claim) this.claims.delete(taskId)
  }

  nextTurnSeq(): number {
    return ++this.turnSeq
  }

  // ---------------------------------------------------------------- 登记与路由

  lifecycle(taskId: string) {
    let lifecycle = this.turnLifecycles.get(taskId)
    if (!lifecycle) {
      lifecycle = new TurnLifecycle({ taskId, initialStatus: this.ports.status(taskId) ?? 'queued' })
      this.turnLifecycles.set(taskId, lifecycle)
    }
    return lifecycle
  }

  sessionOf(taskId: string): BackendSession | undefined {
    return this.sessions.get(taskId)
  }

  workdirOf(taskId: string): string | undefined {
    return this.sessionWorkdirs.get(taskId)
  }

  claimOf(taskId: string): RunClaim | undefined {
    return this.claims.get(taskId)
  }

  routerOf(session: BackendSession): SessionTurnRouter | undefined {
    return this.sessionTurns.get(session)
  }

  launchHandleOf(taskId: string) {
    return this.launchHandles.get(taskId)
  }

  dropLaunchHandle(taskId: string) {
    this.launchHandles.delete(taskId)
  }

  lastTerminalResponse(taskId: string): string | undefined {
    return this.lastTerminalResponses.get(taskId)
  }

  rememberTerminalResponse(taskId: string, response: string) {
    this.lastTerminalResponses.set(taskId, response)
  }

  forgetTerminalResponse(taskId: string) {
    this.lastTerminalResponses.delete(taskId)
  }

  registerTurnStartObserver(runId: string, observer: (identity: { taskId: string; runId: string; turnId: string }) => void) {
    this.turnStartObservers.set(runId, observer)
  }

  dropTurnStartObserver(runId: string) {
    this.turnStartObservers.delete(runId)
  }

  hasRetryTimer(taskId: string): boolean {
    return this.retryTimers.has(taskId)
  }

  armRetryTimer(taskId: string, timer: NodeJS.Timeout) {
    this.retryTimers.set(taskId, timer)
  }

  sessionCount(): number {
    return this.sessions.size
  }

  launchCount(): number {
    return this.launchHandles.size
  }

  /** 会话级通道（一个 BackendSession 一个，交给适配器后不再改变）：把适配器回调
   * 连同它携带的回合身份交给路由器。身份不明的回调在这里被丢弃，不会被记到
   * "当前回合"头上。 */
  sessionChannel(router: SessionTurnRouter): BackendSessionEvents {
    const pick = (stamp?: BackendTurnStamp) => router.resolve(stamp)
    return {
      onEvent: (e, stamp) => { pick(stamp)?.events.onEvent(e) },
      onHeartbeat: (stamp) => { pick(stamp)?.events.onHeartbeat?.() },
      onTurnEnd: (r, stamp) => { pick(stamp)?.events.onTurnEnd(r) },
      onPermission: (req, stamp) => {
        const record = pick(stamp)
        return record?.events.onPermission?.(req) ?? Promise.resolve({ decision: 'deny' as const })
      },
      onSessionId: (sessionId, stamp) => { pick(stamp)?.events.onSessionId?.(sessionId) },
      onLaunch: (handle) => {
        const record = router.current()
        if (!record || !this.isCurrentRun(record.claim) || !this.lifecycle(record.taskId).accepts(record.token)) {
          const claim = record?.claim ?? router.lastClaim
          void this.ports.registerOrphanLaunchCleanup(claim ? `${claim.taskId}:${claim.runId}` : undefined, () => checkedCleanup(() => handle.stop()))
          return
        }
        this.launchHandles.set(record.taskId, handle)
        this.lifecycle(record.taskId).registerLaunch(handle.stop)
      }
    }
  }

  /** 开启一个回合：身份一经创建即冻结，之后只读。 */
  openTurn(
    taskId: string,
    router: SessionTurnRouter,
    claim: RunClaim,
    generation: number,
    sessionOwner: string | undefined,
    onTurnEnd?: (r: BackendTurnResult) => void
  ): TurnRecord {
    const seq = router.nextSeq()
    const stamp: BackendTurnStamp = Object.freeze({
      seq,
      id: `turn_${taskId}_${generation}_${this.nextTurnSeq()}_${Math.random().toString(36).slice(2, 8)}`
    })
    const token: EventGateToken = Object.freeze({ generation, sessionOwner })
    const events = this.ports.composeTurnEvents({ taskId, router, claim, token, stamp, onTurnEnd })
    const record: TurnRecord = { taskId, seq, stamp, generation, claim, token, events }
    router.lastClaim = claim
    router.openTurn(record)
    const observer = this.turnStartObservers.get(claim.runId)
    observer?.({ taskId, runId: claim.runId, turnId: stamp.id })
    return record
  }

  /** 会话仍是当前运行、且能证明新回合归属时，才允许在同一连接上开新回合。 */
  sessionMayOpenNewTurn(session: BackendSession): boolean {
    const router = this.sessionTurns.get(session)
    if (!router) return false
    return session.turnScoped === true && router.mayOpenNewTurn()
  }

  /** 关掉一个连接的归属：之后它吐出的任何回调都不再被采纳。 */
  retireSession(session: BackendSession, reason: 'closed' | 'replaced' = 'closed') {
    this.sessionTurns.get(session)?.retire(reason)
  }

  /**
   * 会话安装唯一入口（I1.1；§1.2 三处逐字拷贝的六步序列在此收口：原 run()、
   * startIsolatedTurn()、followUp() resume 分支）。调用前置条件：持久绑定已成功
   * （store.updateIf + runCondition；绑定失败走 closeLateSession，会话绝不进内存表）。
   * 次序固定：setSessionOwner → attachSession → router.legacy/owner → sessionTurns
   * → sessions → sessionWorkdirs → 广播；新增安装步骤只改这里。
   */
  installSession(input: { taskId: string; session: BackendSession; router: SessionTurnRouter; generation: number; workdir: string }): void {
    const life = this.lifecycle(input.taskId)
    life.gate.setSessionOwner(input.session.sessionId)
    void life.attachSession({ generation: input.generation, sessionOwner: input.session.sessionId }, input.session)
    // 适配器声明了回合身份才允许在同一连接上继续跑回合；否则连接一旦失去
    // 归属确定性（有回合没收终态就被放弃）就必须重建。
    input.router.legacy = input.session.turnScoped !== true
    input.router.owner = input.session.sessionId
    this.sessionTurns.set(input.session, input.router)
    this.sessions.set(input.taskId, input.session)
    this.sessionWorkdirs.set(input.taskId, input.workdir)
    this.ports.onSessionInstalled(input.taskId)
  }

  /** 摘除任务的会话登记并退役其路由（不 清 claim/工作流账——调用方自行编排）。
   *  返回被摘除的会话；无登记时返回 undefined。 */
  dropInstalledSession(taskId: string, reason: 'closed' | 'replaced' = 'closed'): BackendSession | undefined {
    const session = this.sessions.get(taskId)
    this.sessions.delete(taskId)
    this.sessionWorkdirs.delete(taskId)
    if (session) this.retireSession(session, reason)
    return session
  }

  /** 仅当登记仍是传入会话时摘除（终止协调按身份防误摘，I1.2） */
  dropSessionIfCurrent(taskId: string, session: BackendSession) {
    if (this.sessions.get(taskId) !== session) return
    this.sessions.delete(taskId)
    this.sessionWorkdirs.delete(taskId)
  }

  // ---------------------------------------------------------------- 失效

  /** 看门狗静默拆除（不裁决超时）：forget/shutdown 等生命周期边界用 */
  disarmWatchdog(taskId: string) {
    const w = this.turnWatchdogs.get(taskId)
    if (!w) return
    clearTimeout(w.timer)
    this.turnWatchdogs.delete(taskId)
  }

  /** 按超时裁决当前看门狗（若仍是武装的那条）：换代 → 停会话/启动句柄 → 决议等待方 */
  expireWatchdog(taskId: string) {
    this.turnWatchdogs.get(taskId)?.expire()
  }

  bumpTurnGen(taskId: string) {
    const life = this.lifecycle(taskId)
    // 换代即作废在飞回合：它的回调从此不再可投递，无法归属的连接标记为不可复用
    const session = this.sessions.get(taskId)
    if (session) this.sessionTurns.get(session)?.abandonOpen()
    // TurnLifecycle is the authority for callback generations. A new
    // generation starts ownerless so synchronous start callbacks can be
    // admitted; the session owner is installed as soon as start resolves.
    const gen = life.invalidate()
    life.gate.setStatus(this.ports.status(taskId) ?? 'queued')
    life.gate.setSessionOwner(undefined)
    return gen
  }

  /** 任务级执行态统一清扫（F2 单点清单）。内核持有的任务键状态只在这里摘除；
   *  固定次序：watchdog → invalidateTurns → retry → claim → launch → session →
   *  workflow(端口) → terminal → lifecycle。各清扫位的组合见 runner 侧调用点。 */
  sweepTaskExecutionState(taskId: string, o: TaskSweepOptions = {}): void {
    if (o.watchdog === 'expire') this.expireWatchdog(taskId)
    else if (o.watchdog === 'disarm') this.disarmWatchdog(taskId)
    if (o.invalidateTurns) this.bumpTurnGen(taskId)
    if (o.retry) this.clearRetry(taskId)
    if (o.claim) this.claims.delete(taskId)
    if (o.launch) this.launchHandles.delete(taskId)
    if (o.session === 'drop') this.dropInstalledSession(taskId)
    else if (o.session === 'retireOnly') {
      const session = this.sessions.get(taskId)
      if (session) this.retireSession(session)
    }
    if (o.workflow) this.ports.purgeTaskWorkflowState(taskId, o.workflow)
    if (o.terminal) this.lastTerminalResponses.delete(taskId)
    if (o.lifecycle === 'dispose') this.lifecycle(taskId).dispose()
    else if (o.lifecycle === 'disposeDrop') {
      this.turnLifecycles.get(taskId)?.dispose()
      this.turnLifecycles.delete(taskId)
    }
  }

  // ---------------------------------------------------------------- 看门狗

  /**
   * 空转哨兵：护送一个回合的等待。到点先停掉进行中的回合（会话仍可续聊，不留
   * 僵尸 agent 继续在后台跑），再以超时错误裁决等待方。
   * 在 backend.start 之前就可武装：会话尚未建立时用启动句柄硬杀，握手挂死同样
   * 判败——否则任务会永久卡在 running 并占住并发槽，只能重启应用。
   */
  idleSentinel(taskId: string, onFire?: () => void): { timeout: Promise<BackendTurnResult>; cancel: () => void } {
    this.disarmWatchdog(taskId)
    const budgetMs = this.ports.turnBudgetMs(taskId)
    let fire: () => void = () => {}
    const timeout = new Promise<BackendTurnResult>((resolve) => {
      fire = () => resolve(turnTimeoutError(budgetMs))
    })
    // 哨兵只裁决自己武装的那一回合：零延迟自动重试会在上一回合收尾（finally cancel）
    // 之前就用同一 taskId 换上新看门狗，过期/取消必须先核对记录身份，
    // 否则会误删后继回合的定时器——后继回合从此无人看护，永久卡在 running。（I3.1）
    const record: { timer: NodeJS.Timeout; expire: () => void; budgetMs: number } = {
      timer: undefined as unknown as NodeJS.Timeout,
      budgetMs,
      expire: () => {
        if (this.turnWatchdogs.get(taskId) !== record) return
        clearTimeout(record.timer)
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

  /** 任务有新事件（任何种类）即视为有进展：看门狗重新计时（I3.1：只重置当前记录） */
  touchWatchdog(taskId: string) {
    const w = this.turnWatchdogs.get(taskId)
    if (!w) return
    clearTimeout(w.timer)
    w.timer = setTimeout(w.expire, w.budgetMs)
  }

  clearRetry(taskId: string) {
    const timer = this.retryTimers.get(taskId)
    if (!timer) return false
    clearTimeout(timer)
    this.retryTimers.delete(taskId)
    return true
  }

  // ---------------------------------------------------------------- 退出确认原语

  /** 会话释放台账登记（I7.4）：同会话重复登记复用在途 promise；失败保留 release；完成摘账 */
  trackSessionRelease(session: BackendSession, workdir: string, release: () => Promise<void>): Promise<void> {
    const previous = this.worktreeSessionReleases.get(session)
    if (previous && !previous.failed) return previous.promise
    const retry = previous?.release ?? release
    const entry = { workdir: previous?.workdir ?? workdir, promise: Promise.resolve().then(retry), release: retry, failed: false }
    this.worktreeSessionReleases.set(session, entry)
    void entry.promise.then(() => {
      if (this.worktreeSessionReleases.get(session) === entry) this.worktreeSessionReleases.delete(session)
    }, () => { entry.failed = true })
    return entry.promise
  }

  /**
   * Close a provider session that resolved for a Run this runner no longer
   * owns. It was never installed in memory, so it is stopped directly instead
   * of going through the task-keyed session map.
   */
  async closeLateSession(session: BackendSession, claim?: RunClaim | null) {
    let closed = false
    const cleanup = this.ports.registerOrphanLaunchCleanup(claim ? `${claim.taskId}:${claim.runId}` : undefined, async () => {
      if (closed) return
      let stopError: unknown
      try { await checkedCleanup(() => session.stop()) } catch (error) { stopError = error }
      await checkedCleanup(() => session.close())
      closed = true
      if (stopError) throw stopError
    })
    await awaitCleanup(() => cleanup)
  }

  /** 关闭并移除内存会话（容错）：防止放弃的会话继续在后台跑、往任务日志里交错写事件 */
  async closeSession(taskId: string, expected?: TaskExpectation, preserveProviderSession = false) {
    const s = this.sessions.get(taskId)
    const workdir = this.sessionWorkdirs.get(taskId) ?? ''
    const claim = this.claims.get(taskId) ?? (s && this.sessionTurns.get(s)?.lastClaim)
    if (expected && (!claim || claim.runId !== expected.runId || !sameExecutionOwner(claim.owner, expected.executionOwner))) return
    await this.ports.drainEvents(taskId)
    if (this.sessions.get(taskId) !== s) return
    const latestClaim = this.claims.get(taskId) ?? (s && this.sessionTurns.get(s)?.lastClaim)
    if (expected && (!latestClaim || latestClaim.runId !== expected.runId || !sameExecutionOwner(latestClaim.owner, expected.executionOwner))) return
    this.sweepTaskExecutionState(taskId, { invalidateTurns: true, retry: true, workflow: { delegationLedger: true }, terminal: true })
    if (!s) return
    if (preserveProviderSession && s.detach) {
      this.ports.parkRetiredSession(`${taskId}:${s.sessionId ?? claim?.runId}`, { taskId, session: s, closed: false })
    }
    this.dropInstalledSession(taskId)
    // 会话在此处释放（close 或 detach），从 lifecycle 解绑防 attachSession 前会话清扫二次释放
    this.turnLifecycles.get(taskId)?.detachSession(s)
    await awaitCleanup(() => this.trackSessionRelease(s, workdir, async () => {
      await awaitCleanup(() => s.stop())
      await checkedCleanup(() => preserveProviderSession && s.detach ? s.detach() : s.close())
    }), 4_000)
  }

  async releaseWorktreeSessions(workdir: string): Promise<boolean> {
    const targets: Array<{ taskId: string; session: BackendSession }> = []
    for (const [taskId, session] of this.sessions) {
      const boundDir = this.sessionWorkdirs.get(taskId)
      if (!boundDir || !sameWorktreePath(boundDir, workdir)) continue
      const task = this.ports.taskSnapshot(taskId)
      if (!task || !['done', 'failed', 'cancelled'].includes(task.status)) return false
      const claim = this.claims.get(taskId) ?? this.sessionTurns.get(session)?.lastClaim
      if (!claim || claim.runId !== task.runId || !sameExecutionOwner(claim.owner, task.executionOwner)) return false
      if (this.sessionTurns.get(session)?.hasOpenTurn()) return false
      targets.push({ taskId, session })
    }
    for (const { taskId, session } of targets) {
      this.clearRetry(taskId)
      this.bumpTurnGen(taskId)
      this.retireSession(session, 'replaced')
      const promise = this.trackSessionRelease(session, workdir, async () => {
        if (session.detach) await session.detach()
        else {
          await awaitCleanup(() => session.stop())
          await session.close()
        }
      })
      void promise.then(() => {
        if (this.sessions.get(taskId) !== session) return
        this.sessions.delete(taskId)
        this.sessionWorkdirs.delete(taskId)
        this.launchHandles.delete(taskId)
        this.ports.purgeTaskWorkflowState(taskId, { permissions: true })
      }, () => {})
    }
    const pending = [...this.worktreeSessionReleases].filter(([, entry]) => sameWorktreePath(entry.workdir, workdir))
    const results = await Promise.all(pending.map(([session, entry]) => {
      const promise = entry.failed ? this.trackSessionRelease(session, entry.workdir, entry.release) : entry.promise
      return awaitCleanup(() => promise, 4_000)
    }))
    return results.every(Boolean)
  }

  // ---------------------------------------------------------------- 只读视图（批次 5 随终止协调迁入后收窄删除）

  /** terminateTask 专用的释放台账判定：该任务身份的会话是否有在途/失败释放 */
  hasSessionReleaseClaimedBy(taskId: string, runId: string | undefined, owner: ExecutionOwner | undefined): boolean {
    for (const session of this.worktreeSessionReleases.keys()) {
      const last = this.sessionTurns.get(session)?.lastClaim
      if (last?.taskId === taskId && last.runId === runId && sameExecutionOwner(last.owner, owner)) return true
    }
    return false
  }

  /** terminateTask 专用的释放台账只读视图（按 lastClaim.taskId 过滤） */
  sessionReleasesForTask(taskId: string): Array<[BackendSession, WorktreeSessionRelease]> {
    return [...this.worktreeSessionReleases].filter(([session]) => this.sessionTurns.get(session)?.lastClaim?.taskId === taskId)
  }

  dropSessionRelease(session: BackendSession) {
    this.worktreeSessionReleases.delete(session)
  }

  // ---------------------------------------------------------------- 关机边界

  /** 关机时的执行态清扫（shutdown 的内核半部）：失效回调 → 停自有会话 → 等释放台账，
   *  不把活跃任务改写为 failed（I2.3）。runner 侧保留事件批/工作流态/executor 半部。 */
  async shutdownExecutionState(): Promise<void> {
    for (const timer of this.retryTimers.values()) clearTimeout(timer)
    this.retryTimers.clear()
    for (const [taskId, handle] of this.launchHandles) {
      this.bumpTurnGen(taskId)
      if (!this.sessions.has(taskId)) await awaitCleanup(() => handle.stop())
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
      this.retireSession(s, 'replaced')
      await awaitCleanup(() => s.stop())
      await awaitCleanup(() => s.close())
    }
    await Promise.all([...this.worktreeSessionReleases].map(([session, entry]) => {
      const promise = entry.failed ? this.trackSessionRelease(session, entry.workdir, entry.release) : entry.promise
      return awaitCleanup(() => promise, 4_000)
    }))
    this.sessions.clear()
    // 会话清空必须连带清目录绑定：sessionWorkdirs 的键值只在随会话安装/关闭时增删，
    // 留着旧 taskId→workdir 就是悬空脏数据，下个生命周期读到的是上个生命周期的 cwd（I1.5）
    this.sessionWorkdirs.clear()
    this.claims.clear()
    this.lastTerminalResponses.clear()
    for (const lifecycle of this.turnLifecycles.values()) lifecycle.dispose()
    this.turnLifecycles.clear()
  }
}
