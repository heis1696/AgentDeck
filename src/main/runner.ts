// 任务运行器：队列 + 生命周期 + 事件管道
// 状态机：queued → running → done | failed | cancelled
import type { ExecutionOwner, Task, TaskEvent } from '../shared/types'
import { createHash } from 'node:crypto'
import { type TaskExpectation, type TaskStore } from './store'
import { createExecutionOwner } from './persistence'
import type { AgentBackend, BackendSession, BackendSessionEvents, BackendTurnStamp, PermissionRequest, BackendTurnResult } from './backends/types'
import { runDelegationLoop, parseContinueMerged, stripContinue, parseDelegates, stripDelegates, stripRoundNotes, stripReviews, parseConsultsMerged, stripConsults, parseInvestigatesMerged, stripInvestigates, ancestorBudget, escapeProtocolLiterals, findUnmatchedConsultOpens, findUnmatchedInvestigateOpens, unmatchedConsultOpenReason, unmatchedInvestigateOpenReason, type AgentLike, type DelegateCall, type ConsultCall, type InvestigateCall, type IssueCommentLike } from './delegate'
import { buildAgentPrompt, buildDelegationBlock, handoffNoteBlock, delegateRecoveryNotice, consultReplyFeedback, investigationFeedback, CONTINUE_BLOCK, HANDOFF_CUE, HANDOFF_RECEIVE_CUE, HANDOFF_START_CONFIRMED_CUE, RETITLE_PROMPT } from './prompts'
import { isOfficeTask } from './agent-sessions'
import { findHandoffSuccessor, prepareManualTaskStart, repeatsHandoffPhase } from './handoff'
import { sameWorktreePath, type GitRepositoryProbeResult } from './git'
import { runCondition, runIdentity, TURN_ISOLATION_REQUIRED, RESUME_UNSUPPORTED_MESSAGE } from './execution/identity'
import type { RunClaim, TurnRecord } from './execution/identity'
import { SessionTurnRouter } from './execution/session-turn-router'
import { awaitCleanup } from './execution/cleanup'
import { gitRepositoryProbe } from './execution/git-probe-cache'
import { ExecutionKernel, turnTimeoutError } from './execution/execution-kernel'
import { EventPump } from './execution/event-pump'
import { DelegateLedger } from './execution/delegate-ledger'
import { ChildSpawner, type TaskCreator } from './execution/child-spawner'
import { TerminationCoordinator } from './execution/termination'
import { DoomWindow } from './execution/doom-window'

// 冻结面：以下符号的 smoke 直连消费以 `./runner` 为准（AGENTS.md 铁律），实现已在批次 1
// 迁入 src/main/execution/*，这里按原名 re-export——调用方与 smoke 零改动。
export { TURN_ISOLATION_REQUIRED, RESUME_UNSUPPORTED_MESSAGE } from './execution/identity'
export type { RunClaim, TurnRecord } from './execution/identity'
export { SessionTurnRouter } from './execution/session-turn-router'
export { setGitRepositoryProbeCacheProbeForTest } from './execution/git-probe-cache'
export type { GitRepositoryProbeCacheEvent } from './execution/git-probe-cache'

/** API 预设（主进程 presets.ts 的 ApiPreset 的运行时子集，避免环依赖） */
interface PresetLike {
  id: string
  name: string
  baseURL: string
  apiKey: string
  protocol?: 'anthropic' | 'openai'
}

/** 阶段接力处理器：主进程接 createTask（同 issue 新 run、新会话硬切） */
export type ContinueHandler = (input: { sourceTaskId: string; issueId: string; brief: string; start: 'auto' | 'parked' }) => unknown

/** Cross-leader consultation hook. The runner owns source-session turn order;
 * the host resolves the target office session and returns its final answer. */
export type ConsultHandler = (input: { sourceTaskId: string; call: ConsultCall; depth: number }) => Promise<string | null>
export type InvestigateHandler = (input: { sourceTaskId: string; call: InvestigateCall; depth: number }) => Promise<string | null>

/** Maximum source-session consultation回合 per turn; target depth is capped separately. */
export const MAX_CONSULT_ROUNDS = 2

/** 阶段接力协议正文与接力/重命名指令集中在 src/main/prompts/handoff.ts */

/** 同一 Issue 上 <continue> 自继链上限（防无限自我接力） */
const MAX_HANDOFF_CHAIN = 8
import { classifyFailure } from './failure'
import { canTransition } from '../shared/taskflow'
import { Scheduler } from './scheduler'
import { PermissionBroker } from './permission-broker'
import { TaskFinalizer } from './task-finalizer'
import { Executor } from './executor'
import { IssuePipeline } from './pipeline/issue-pipeline'
import { FlowEngine, type FlowState } from './pipeline/flow'
import { StartNode, RunningNode, FinalizeNode, type ExecutionPorts } from './pipeline/nodes'
import { decideRetry } from './retry-policy'
import { DSH_TURN_BUDGET_MS } from './backends/dsh'
import { createTurnEvents, type RunnerEvent } from './execution/turn-events'

/** Main-process task creation dependency（批次 4b 随建单器迁 execution/child-spawner.ts，
 *  这里按原名 re-export——调用方与类型消费零改动）。 */
export type { ChildTaskCreator, TaskCreationRequest, TaskCreator } from './execution/child-spawner'

export interface RunnerPorts {
  send: (channel: string, payload: unknown) => void
  notify: (task: Task, what: string, body: string) => void
  onTaskEvent?: (taskId: string, event: Omit<TaskEvent, 'seq'>) => void
}

// 回合事件组装面已外移 execution/turn-events.ts（批次 3b）：RunnerEvent 类型与
// STREAM_DELTA_TYPES/isStreamDeltaEvent/hasStableEventIdentity/STAGED_BATCH_ID_PREFIX/
// hasStagedBatchIdentity/streamType/streamPersistence/mergeStreamEvents/eventSize
// 九个模块级 helper 随 makeTurnEvents 整体搬迁；runner 按 §5.2 正向 import
// createTurnEvents/RunnerEvent，execution/turn-events 严禁反向 import runner。

/**
 * 标题回合硬预算：改标题是装饰性收尾，且在 titleMode 下事件不落日志——它一挂，
 * 用户看到的就是"结果早出来了，任务却一直运行中"（实测 zcode 终态丢失时拖满
 * 30 分钟回合上限）。到点放弃标题、护栏当回合、按原结果立即收尾。
 * AGENTDECK_RETITLE_MS 可覆盖（测试加速用）。
 */
const RETITLE_TURN_BUDGET_MS = Number(process.env.AGENTDECK_RETITLE_MS) > 0
  ? Number(process.env.AGENTDECK_RETITLE_MS)
  : 90_000
const RETITLE_BUDGET_EXCEEDED = 'retitle-budget-exceeded'
/**
 * 总结轮硬预算：委派协议 summary 层（派单标 summary 且结果超回灌界）对子单会话追加的
 * 一轮压缩总结，预期 ≤1000 字快速返回；到点放弃并把回灌按入口指引回退，绝不无限等。
 */
const SUMMARY_TURN_BUDGET_MS = 120_000
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
    terminationTimeoutMs?: number
  }
  /** 执行内核（批次 2）：会话/回合身份/句柄/失效/退出确认原语的状态唯一所有者，
   *  在构造函数最前装配（端口回调引用 runner 编排面，惰性生效）。 */
  private kernel: ExecutionKernel
  /** 回合事件工厂（批次 3b）：makeTurnEvents 整体外移至 execution/turn-events.ts，
   *  依赖全部经窄端口注入（§6.3 3b）；在内核之前装配，composeTurnEvents 端口直连。 */
  private turnEvents: ReturnType<typeof createTurnEvents>
  private permissionBroker: PermissionBroker
  private getTeam: (() => AgentLike[]) | null = null
  private scheduler: Scheduler
  private finalizer: TaskFinalizer
  private executor = new Executor()
  /** Issue 管线：isIdle/准入/终点处理的单点出口（见 src/main/pipeline/issue-pipeline.ts） */
  readonly pipeline: IssuePipeline<Task>
  /** 执行流引擎：实际运行为 FlowNode 组合（见 src/main/pipeline/flow.ts），节点在途账接管线 */
  readonly flowEngine: FlowEngine
  private ports: RunnerPorts
  /** Pending provider batches are flushed at turn and process lifecycle boundaries.
   *  批 → taskId 台账已迁 EventPump（批次 3a，唯一所有者，§6.3）；runner 只留门面委托。 */
  private readonly eventPump = new EventPump<RunnerEvent>()
  /** 委派台账（批次 4a）：流式提前建单嗅探态、被拒派单双层账的内存半部、同键建单互斥、
   *  worker 编号预留的唯一所有者迁入 execution/delegate-ledger.ts；runner 留九个 smoke
   *  直连的签名冻结门面。持久半部（Task.delegateRejections）仍在 store——双层账
   *  （I5.1）不得合并成单层。 */
  private readonly delegateLedger: DelegateLedger
  /** 委派建单器（批次 4b）：同键建单互斥编排（I4.3 键格式）、派单护栏、worktree 建树与
   *  dispatchHold 三步翻面（I4.4）、建单失败收口与只读调查建单外移
   *  execution/child-spawner.ts；runner 留两个 smoke 直连的签名冻结门面。依赖全部经窄端口
   *  注入（§6.4 4b），spawner 绝不反向 import runner。 */
  private readonly childSpawner: ChildSpawner
  /** 终止协调（批次 5）：terminating/terminationTargets/retiredProviderSessions 的唯一
   *  所有者与严格终止全量编排迁入 execution/termination.ts；runner 留 smoke 直连的
   *  terminateTask 签名冻结门面。activeRuns/activeTurns 所有权留在 runner（§5.1：
   *  Scheduler 回调写、pipeline sources 读），以只读快照端口现取。 */
  private readonly termination: TerminationCoordinator
  /** doom 窗（批次 5）：toolWindows/doomRequestSeq 唯一所有者与 observeToolCall 编排
   *  迁入 execution/doom-window.ts；I6.3 任务级清扫经 forget/clear 窄方法收口，
   *  与 permissionBroker.cancelTask 成对（四个清扫位同经 purgeTaskWorkflowState 单点）。 */
  private readonly doomWindows: DoomWindow
  private shuttingDown = false
  private cancellationDrains = new Map<string, number>()
  private meetingGuard: ((task: Task) => boolean) | null = null
  private activeRunsMap = new Map<string, Promise<unknown>>()
  private activeTurns = new Map<string, Promise<unknown>>()
  private readonly onTaskChanged?: (task: Task) => void
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
    // 委派台账（批次 4a）先于回合事件工厂装配：turnEvents 的嗅探端口 4a 起直连 ledger
    // （§6.3）；其余端口回调引用 runner 编排面（惰性调用，构造期不触发）
    this.delegateLedger = new DelegateLedger({
      taskOf: (taskId) => this.store.get(taskId),
      updateIf: (taskId, expected, patch) => this.store.updateIf(taskId, expected, patch),
      claimOf: (taskId) => this.kernel.claimOf(taskId),
      note: (taskId, text) => this.note(taskId, text),
      cancelTask: (childId) => { void this.cancel(childId) },
      pushTask: (taskId) => this.pushTask(taskId),
      spawnDelegateChild: (taskId, call) => this.spawnDelegateChild(taskId, call),
      listChildTasks: (parentTaskId) => this.store.list().filter((task) => task.parentTaskId === parentTaskId)
    })
    // doom 窗（批次 5）先于回合事件工厂装配：observeToolCall 端口直连（惰性调用，
    // 构造期不触发）；askPermission/isCurrentRun 经端口注入（§6.5）
    this.doomWindows = new DoomWindow({
      taskOf: (taskId) => this.store.get(taskId),
      matches: (taskId, expected) => this.store.matches(taskId, expected),
      doomLoopThreshold: () => this.opts().doomLoopThreshold,
      appendEvent: (taskId, event, expected) => this.store.appendEvent(taskId, event, expected),
      pushEvent: (taskId, event) => this.pushEvent(taskId, event),
      askPermission: (taskId, request) => this.askPermission(taskId, request),
      isCurrentRun: (claim) => this.kernel.isCurrentRun(claim),
      stopSession: (taskId) => this.kernel.sessionOf(taskId)?.stop()
    })
    // 回合事件工厂（批次 3b）先于内核装配：端口回调引用 runner 编排面（惰性调用，
    // 构造期不触发）；store/kernel/pump 的访问全部经窄端口注入（§6.3 3b 端口清单）
    this.turnEvents = createTurnEvents({
      // store 持久化写路径
      stagePendingEvents: (taskId, turnId, runId, events, expected, openedAt) => this.store.stagePendingEvents(taskId, turnId, runId, events, expected, openedAt),
      appendEvents: (taskId, events, expected) => this.store.appendEvents(taskId, events, expected),
      clearPendingEvents: (taskId, turnId) => this.store.clearPendingEvents(taskId, turnId),
      // store 只读探针与条件写（onSessionId 的 resume 身份绑定）
      taskOf: (taskId) => this.store.get(taskId),
      updateIf: (taskId, expected, patch) => this.store.updateIf(taskId, expected, patch),
      // kernel 原语
      lifecycle: (taskId) => this.kernel.lifecycle(taskId),
      isCurrentRun: (claim) => this.kernel.isCurrentRun(claim),
      claimOf: (taskId) => this.kernel.claimOf(taskId),
      touchWatchdog: (taskId) => this.kernel.touchWatchdog(taskId),
      lastTerminalResponse: (taskId) => this.kernel.lastTerminalResponse(taskId),
      rememberTerminalResponse: (taskId, response) => this.kernel.rememberTerminalResponse(taskId, response),
      // runner 编排回调（业务裁决留在 runner）
      sniffDelegates: (taskId, delta) => this.delegateLedger.sniffDelegates(taskId, delta),
      observeToolCall: (taskId, event, claim) => this.doomWindows.observeToolCall(taskId, event, claim),
      pushEvent: (taskId, e) => this.pushEvent(taskId, e),
      onTaskEvent: (taskId, event) => this.ports.onTaskEvent?.(taskId, event),
      pushTask: (taskId) => this.pushTask(taskId),
      askPermission: (taskId, req) => this.askPermission(taskId, req),
      // 只读探针（取消/关机编排态）
      isCancelling: (taskId) => this.cancellationDrains.has(taskId),
      isShuttingDown: () => this.shuttingDown,
      // 事件批登记（批次 3a EventPump 窄面：revoke=dispose+摘账，forget=仅摘账）
      register: (batcher, taskId) => this.eventPump.register(batcher, taskId),
      revoke: (batcher) => this.eventPump.revoke(batcher),
      forget: (batcher) => this.eventPump.forget(batcher)
    })
    // 执行内核先于一切编排组件装配：端口回调引用 runner 编排面（惰性调用，构造期不触发）
    this.kernel = new ExecutionKernel({
      matches: (taskId, expected) => this.store.matches(taskId, expected),
      status: (taskId) => this.store.get(taskId)?.status,
      taskSnapshot: (taskId) => {
        const task = this.store.get(taskId)
        return task ? { status: task.status, runId: task.runId, executionOwner: task.executionOwner } : undefined
      },
      turnBudgetMs: (taskId) => this.turnBudgetMs(taskId),
      onSessionInstalled: (taskId) => this.pushTask(taskId),
      purgeTaskWorkflowState: (taskId, scope) => this.purgeTaskWorkflowState(taskId, scope),
      drainEvents: (taskId, timeoutMs) => this.eventPump.close(taskId, timeoutMs),
      // 回合事件组装（批次 3b 起由 turn-events 工厂提供；台账登记收口在 3a 的 EventPump）
      composeTurnEvents: this.turnEvents,
      retainRetiredSession: (key, entry) => this.termination.parkRetiredSession(key, entry),
      registerOrphanLaunchCleanup: (key, action) => this.executor.registerCleanup(key, action)
    })
    // 终止协调（批次 5）在内核之后装配：端口回调引用内核原语与 runner 编排面（惰性调用，
    // 构造期不触发）；activeRuns/activeTurns 只读快照每次调用现取（§6.5），不长期持有引用
    this.termination = new TerminationCoordinator({
      // 持久层窄探针/条件写
      taskOf: (taskId) => this.store.get(taskId),
      matches: (taskId, expected) => this.store.matches(taskId, expected),
      updateIf: (taskId, expected, patch) => this.store.updateIf(taskId, expected, patch),
      childTasks: (parentTaskId) => this.store.list().filter((task) => task.parentTaskId === parentTaskId),
      // 内核原语（身份/会话/释放台账）
      claimOf: (taskId) => this.kernel.claimOf(taskId),
      isCurrentRun: (claim) => this.kernel.isCurrentRun(claim),
      sessionOf: (taskId) => this.kernel.sessionOf(taskId),
      workdirOf: (taskId) => this.kernel.workdirOf(taskId),
      launchHandleOf: (taskId) => this.kernel.launchHandleOf(taskId),
      hasRetryTimer: (taskId) => this.kernel.hasRetryTimer(taskId),
      lastClaimOf: (session) => this.kernel.routerOf(session)?.lastClaim,
      dropSessionIfCurrent: (taskId, session) => this.kernel.dropSessionIfCurrent(taskId, session),
      retireSession: (session) => this.kernel.retireSession(session),
      sweepTaskExecutionState: (taskId, o) => this.kernel.sweepTaskExecutionState(taskId, o),
      trackSessionRelease: (session, workdir, release) => this.kernel.trackSessionRelease(session, workdir, release),
      hasSessionReleaseClaimedBy: (taskId, runId, owner) => this.kernel.hasSessionReleaseClaimedBy(taskId, runId, owner),
      sessionReleasesForTask: (taskId) => this.kernel.sessionReleasesForTask(taskId),
      dropSessionRelease: (session) => this.kernel.dropSessionRelease(session),
      // runner 编排回调（业务裁决留在 runner）
      pushTask: (taskId) => this.pushTask(taskId),
      drainEvents: (taskId, timeoutMs) => this.eventPump.close(taskId, timeoutMs),
      runUnderCancellationDrain: async (taskId, body) => {
        this.cancellationDrains.set(taskId, (this.cancellationDrains.get(taskId) ?? 0) + 1)
        try {
          return await body()
        } finally {
          const remaining = (this.cancellationDrains.get(taskId) ?? 1) - 1
          if (remaining) this.cancellationDrains.set(taskId, remaining)
          else this.cancellationDrains.delete(taskId)
        }
      },
      drainLateSessions: (key) => this.executor.drain(key),
      settleTask: (taskId, outcome, context) => this.pipeline.settle(taskId, outcome, context),
      getActiveExecutions: (taskId) => ({ run: this.activeRunsMap.get(taskId), turn: this.activeTurns.get(taskId) }),
      terminationTimeoutMs: () => this.opts().terminationTimeoutMs
    })
    // 委派建单器（批次 4b）在内核之后装配：端口回调引用 runner 编排面与台账（惰性调用，
    // 构造期不触发）；taskCreator 惰性读取——attachTaskCreator 在构造之后才挂接
    this.childSpawner = new ChildSpawner({
      // 持久层窄面（六个单动作）：只读探针/条件写/全量清单/standalone 直建/工作树清扫留痕
      store: {
        get: (taskId) => this.store.get(taskId),
        matches: (taskId, expected) => this.store.matches(taskId, expected),
        updateIf: (taskId, expected, patch) => this.store.updateIf(taskId, expected, patch),
        list: () => this.store.list(),
        create: (input) => this.store.create(input),
        noteWorktreeCleanupFailure: (repoDir, failure) => this.store.noteWorktreeCleanupFailure(repoDir, failure)
      },
      claimForRun: (taskId, runId) => this.claimForRun(taskId, runId),
      enforceMeetingGuard: (task) => this.enforceMeetingGuard(task),
      note: (taskId, text, expected) => this.note(taskId, text, expected),
      pushTask: (taskId) => this.pushTask(taskId),
      enqueue: (task) => this.enqueue(task),
      getTeam: () => this.getTeam?.() ?? [],
      opts: () => ({ delegateMaxDepth: this.opts().delegateMaxDepth, delegateMaxTotalRounds: this.opts().delegateMaxTotalRounds }),
      taskCreator: () => this.taskCreator,
      // 变异红测红1/红5 的「旧代码直接撤销」经 spawner 的 this.cancel 触达此端口
      cancel: (childId) => this.cancel(childId),
      ancestorBudget: (taskId) => ancestorBudget(this.store, taskId),
      ledger: this.delegateLedger
    })
    this.permissionBroker = new PermissionBroker((taskId, request) => {
      send('task:permission', { taskId, request })
    }, () => this.opts().permissionTimeoutMs ?? 5 * 60 * 1000, (taskId) => this.workVersion(taskId))
    this.finalizer = new TaskFinalizer(store, (taskId) => this.pushTask(taskId), undefined, (taskId, outcome) => {
      void this.pipeline.settle(taskId, outcome, { actor: 'runner' })
    })
    // Issue 管线：状态/准入/在途/终点的单点裁决。既有在途 Map 以只读源接入（迁移期
    // 兼容，语义零变化）；新机制的在途操作一律走管线账本，不再自建 Map 挂进 isIdle。
    this.pipeline = new IssuePipeline<Task>({
      probe: { list: () => this.store.list(), get: (id) => this.store.get(id) },
      sources: [
        { label: 'launchHandles', size: () => this.kernel.launchCount() },
        { label: 'eventBatchers', size: () => this.eventPump.size },
        { label: 'terminationTargets', size: () => this.termination.targetCount },
        { label: 'executorCleanups', size: () => (this.executor.isIdle() ? 0 : 1) }
      ]
    })
    this.pipeline
      .registerVariant({ id: 'meeting-member', match: (task) => !!task.meetingId && task.meetingTaskRole !== 'container' })
      .registerVariant({ id: 'meeting-container', match: (task) => task.meetingTaskRole === 'container' })
      .registerVariant({ id: 'relay', match: (task) => task.trigger === 'handoff' })
      .registerVariant({ id: 'delegate-child', match: (task) => !!task.parentTaskId })
    this.flowEngine = new FlowEngine((key) => this.pipeline.begin(key), (key) => this.pipeline.end(key))
    this.pipeline.addAdmitGuard((task) => {
      const guard = this.meetingGuard
      return !guard || guard(task)
    })
    // 级联取消迁入统一终点处理：取消源的收尾钩子里停掉运行中/排队的子任务
    // （原 cancel() 内联语义；terminateTask 自带的全量子任务终止不受影响）
    this.pipeline.addSettleHook((task, outcome, context) => {
      if (context.source !== 'cancel' || outcome !== 'cancelled') return
      for (const child of this.store.list().filter((t) => t.parentTaskId === task.id && (t.status === 'running' || t.status === 'queued'))) {
        void this.cancel(child.id)
      }
    })
    this.scheduler = new Scheduler(
      () => this.store.list().filter((task) => this.meetingGuardAllows(task)),
      () => ({ concurrency: this.opts().concurrency, workerConcurrency: this.opts().workerConcurrency }),
      (taskId) => this.trackMap(this.activeRunsMap, taskId, this.run(taskId).catch((error) => {
        console.error('[Scheduler] Task launch failed', error)
      }))
    )
  }

  // 冻结面（§3 第 3 条）：smoke 直读的「私有」字段——smoke-lifecycle.mjs:272/316/321/360/363
  // 直读 turnWatchdogs/turnLifecycles，smoke-issue-pipeline 直读/写入 sessions/claims，
  // smoke-hot-transaction 直读 launchHandles.size 与 eventBatchers.size，smoke-event-pipeline
  // 直读/迭代 eventBatchers，smoke-meeting-termination 直读 turnWatchdogs/sessions。
  // 状态外移后保留同名 getter 返回所有者持有的同一活 Map 引用（不是拷贝、不是快照）；
  // runner 内部代码不得经此读写，一律走所有者模块的窄方法。
  get sessions() { return this.kernel.sessions }
  get claims() { return this.kernel.claims }
  get launchHandles() { return this.kernel.launchHandles }
  get turnWatchdogs() { return this.kernel.turnWatchdogs }
  get turnLifecycles() { return this.kernel.turnLifecycles }
  /** 台账已迁 EventPump（批次 3a）：smoke-event-pipeline.mjs:342-357 与
   *  smoke-hot-transaction.mjs:365/463 直读，getter 返回其活 Map 引用。 */
  get eventBatchers() { return this.eventPump.batches }
  /** 冻结面（批次 5）：smoke-meeting-termination.mjs:347 写入 activeRuns.set(...) 造在途
   *  假状态、:396/400 与 smoke-continue.mjs:375 直读 retiredProviderSessions——两个 getter
   *  都返回同一活 Map 引用（可写），不是拷贝/快照（§3 第 3 条）。retiredProviderSessions
   *  的所有权已随终止协调迁入 execution/termination.ts，activeRuns 留在 runner。 */
  get retiredProviderSessions() { return this.termination.retiredSessions }
  get activeRuns() { return this.activeRunsMap }

  pushTask(taskId: string) {
    const task = this.store.get(taskId)
    if (!task) return
    this.permissionBroker.setWorkVersion(taskId, this.workVersion(taskId))
    // Keep the in-memory gate aligned with the durable compatibility record;
    // this makes terminal transitions visible before any late callback arrives.
    this.lifecycle(taskId).setStatus(task.status)
    // Follow-up turns have no scheduler slot to release. Wake after terminal
    // writes, even if projection fails; defer until retry/cancel bookkeeping ends.
    if ((task.status === 'done' || task.status === 'failed' || task.status === 'cancelled')
      && this.store.list().some((next) => next.continuesFrom === taskId && next.status === 'queued' && !next.parked)) {
      queueMicrotask(() => this.scheduler.enqueue())
    }
    // Keep projections in step with every runner lifecycle transition before
    // notifying renderer consumers. The callback is optional for CLI/smoke use.
    this.onTaskChanged?.(task)
    this.ports.send('task:updated', task)
  }
  /** 记录用户输入（首条 prompt / 追问），对话视图按 user 事件分气泡 */
  private recordUser(taskId: string, text: string, expected: TaskExpectation = {}) {
    const full = this.store.appendEvent(taskId, { ts: Date.now(), kind: 'user', text }, expected)
    if (full) this.pushEvent(taskId, full)
  }
  pushEvent(taskId: string, e: TaskEvent) {
    this.ports.send('task:event', { taskId, event: e })
  }

  /** facade：事件批台账已迁 EventPump（批次 3a），drain/作废只留委托；调用方与签名不变 */
  private async closeEventBatches(taskId?: string, timeoutMs = 5_000): Promise<boolean> {
    return this.eventPump.close(taskId, timeoutMs)
  }

  private disposeEventBatches(taskId?: string) {
    this.eventPump.dispose(taskId)
  }

  private lifecycle(taskId: string) {
    return this.kernel.lifecycle(taskId)
  }

  /** facade：会话级通道组装已迁内核（状态唯一所有者），编排层只留委托 */
  private sessionChannel(router: SessionTurnRouter): BackendSessionEvents {
    return this.kernel.sessionChannel(router)
  }

  /** facade：回合身份签发已迁内核 */
  private openTurn(
    taskId: string,
    router: SessionTurnRouter,
    claim: RunClaim,
    generation: number,
    sessionOwner: string | undefined,
    onTurnEnd?: (r: BackendTurnResult) => void
  ): TurnRecord {
    return this.kernel.openTurn(taskId, router, claim, generation, sessionOwner, onTurnEnd)
  }

  /** facade：会话复用门禁已迁内核 */
  private sessionMayOpenNewTurn(session: BackendSession): boolean {
    return this.kernel.sessionMayOpenNewTurn(session)
  }

  /** facade：连接归属退役已迁内核 */
  private retireSession(session: BackendSession, reason: 'closed' | 'replaced' = 'closed') {
    this.kernel.retireSession(session, reason)
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

  /** UI 应答权限请求 */
  resolvePermission(requestId: string, optionId: string, decision: 'allow' | 'deny', requestToken?: string) {
    return this.permissionBroker.resolve(requestId, optionId, decision, undefined, requestToken)
  }

  pendingPermissions(taskId: string): PermissionRequest[] {
    return this.permissionBroker.pendingFor(taskId)
  }

  /** facade：空转哨兵已迁内核（在 backend.start 之前就可武装，启动挂死同样判败） */
  private idleSentinel(taskId: string, onFire?: () => void): { timeout: Promise<BackendTurnResult>; cancel: () => void } {
    return this.kernel.idleSentinel(taskId, onFire)
  }
  /** facade：看门狗续命已迁内核（I3.1：只重置当前记录） */
  private touchWatchdog(taskId: string) {
    this.kernel.touchWatchdog(taskId)
  }
  /**
   * 该任务当前回合的看门狗预算：常规后端按空闲语义（有事件续命），dsh headless
   * 运行期零输出、永远等不到续命事件，按固定总预算裁决。
   * 空转上限语义：等待终态期间「没有任何事件」达到该时长才判超时，有事件即续命
   * （与一次性 CLI 后端的 10 分钟无输出看门狗对齐）；AGENTDECK_TURN_IDLE_MS 可覆盖。
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
  /** facade：看门狗静默拆除已迁内核 */
  private disarmWatchdog(taskId: string) {
    this.kernel.disarmWatchdog(taskId)
  }
  /** facade：换代失效已迁内核（I1.4 顺序：先 abandonOpen 作废在飞回调，再 invalidate） */
  private bumpTurnGen(taskId: string) {
    return this.kernel.bumpTurnGen(taskId)
  }

  /** facade：晚到会话关闭已迁内核（executor 孤儿兜底经端口注册） */
  private async closeLateSession(session: BackendSession, claim?: RunClaim | null) {
    await this.kernel.closeLateSession(session, claim)
  }

  /** 关闭并移除内存会话（容错）：防止放弃的会话继续在后台跑、往任务日志里交错写事件。
   *  编排已迁内核（drain→双身份校验→sweep→暂存→摘登记→detachSession→释放台账）。 */
  async closeSession(taskId: string, expected?: TaskExpectation, preserveProviderSession = false) {
    await this.kernel.closeSession(taskId, expected, preserveProviderSession)
  }

  async releaseWorktreeSessions(workdir: string): Promise<boolean> {
    return this.kernel.releaseWorktreeSessions(workdir)
  }

  /** Release in-memory lifecycle state after IPC removes a terminal task.
   *  执行态半部经内核 sweep 单点收口（F2）；工作流态半部走 purgeTaskWorkflowState
   *  同一清单的 forget 档——新增状态只需改内核 sweep 与 purge 单点两处清单。 */
  async forget(taskId: string) {
    this.disposeEventBatches(taskId)
    const session = this.kernel.sessionOf(taskId)
    const workdir = this.kernel.workdirOf(taskId) ?? ''
    this.kernel.sweepTaskExecutionState(taskId, {
      watchdog: 'disarm', retry: true, claim: true, launch: true, session: 'drop',
      workflow: { permissions: true, delegationLedger: true, workerIndex: true },
      terminal: true, lifecycle: 'disposeDrop'
    })
    // 管线侧同步销账：任务移除后无人能再触发 settle，在途与流水账随行清除
    this.pipeline.drop(taskId)
    // 台账只服务 terminateTask 的平台会话收尾；任务移除后无人能再触发终止，随行清除防累积
    // （台账已迁 execution/termination.ts，批次 5）
    this.termination.forgetTask(taskId)
    if (session) {
      await awaitCleanup(() => this.kernel.trackSessionRelease(session, workdir, async () => {
        await awaitCleanup(() => session.stop())
        await session.close()
      }), 4_000)
    }
  }

  /** facade：重试定时器清理已迁内核 */
  private clearRetry(taskId: string) {
    return this.kernel.clearRetry(taskId)
  }

  /** 工作流态清扫单点（F2 的 runner 半部清单）：权限在飞/doom 窗的 runner 半部；
   *  嗅探与拒单账、worker 编号预留的委派半部已随批次 4a 迁 ledger（delegateLedger.purge）。
   *  scope 显式列出本次要清的半部，五个清扫位各自原语义逐位保持；新增工作流态时把清除
   *  登记进本方法或 ledger.purge 对应 scope，不新增第五处散点。 */
  private purgeTaskWorkflowState(
    taskId: string,
    scope: { permissions?: boolean; delegationLedger?: boolean; workerIndex?: boolean }
  ) {
    if (scope.permissions) {
      this.permissionBroker.cancelTask(taskId)
      this.doomWindows.forget(taskId)
    }
    this.delegateLedger.purge(taskId, scope)
  }

  /** 回合成功后的收尾：取最终结果 + git 快照 + 用量聚合 + 状态落盘 */
  private async finalizeDone(taskId: string, directResult: string | undefined, claim: RunClaim) {
    await this.finalizer.finalizeDone(taskId, directResult, runCondition(claim))
  }

  /** 失败落库：原始错误 + 分类解读（P1）。
   *  `claim` 是启动该回合前捕获的运行身份；只有它仍是当前运行才允许落终态。 */
  private failTask(taskId: string, error: string, claim?: RunClaim) {
    const task = this.store.get(taskId)
    if (!task) return false
    // A queued task with an unavailable backend never entered execution, but
    // it still needs a terminal state so the scheduler cannot dispatch it forever.
    if (task.status !== 'queued' && !canTransition(task.status, 'failed', 'runner')) return false
    // Both paths write conditionally on the identity observed before the
    // failure was decided: a run that lost its claim cannot fail a newer one.
    const expected: TaskExpectation = claim
      ? runCondition(claim)
      : { status: 'queued', runId: task.runId, executionOwner: task.executionOwner }
    // 回合失败：流式期间基于半截输出提前建的单一并撤销（无人收编/回灌，也不该被信任）
    // terminatedRunId 同时落盘：失败由本运行器亲眼观察（进程退出/spawn 即败），
    // 它就是该 run 的退出证明——不落的话，会议停止的「历史执行退出未确认」守卫
    // 会对这张已终态任务永久拒停（spawn ENAMETOOLONG 实战：会议无法停止也无法删除）。
    if (!this.store.updateIf(taskId, expected, {
      status: 'failed', endedAt: Date.now(), error, failure: classifyFailure({ error }),
      ...(claim ? { terminatedRunId: claim.runId } : {})
    })) return false
    this.abandonEarlySpawns(taskId)
    if (claim) this.kernel.dropClaimIfCurrent(taskId, claim)
    this.lifecycle(taskId).setStatus('failed')
    this.pushTask(taskId)
    // 终点处理走管线单点：清在途账 + 变体钩子 + 流水账（状态已落库，钩子异步不阻断）
    void this.pipeline.settle(taskId, 'failed', { actor: 'runner', ...(claim ? { runId: claim.runId } : {}), reason: error.slice(0, 200) }).catch(() => {})
    return true
  }

  /** facade：运行认领解析已迁内核 */
  private claimForRun(taskId: string, runId?: string): RunClaim | undefined {
    return this.kernel.claimForRun(taskId, runId)
  }

  /** facade：当前运行判定已迁内核（持久层 matches 经端口） */
  private isCurrentRun(claim: RunClaim | undefined): claim is RunClaim {
    return this.kernel.isCurrentRun(claim)
  }

  enqueue(task: Task) {
    if (!this.enforceMeetingGuard(task)) return
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
  private onConsult: ConsultHandler | null = null
  private onInvestigate: InvestigateHandler | null = null
  /** 阶段接力处理器（主进程接 createTask：同 issue 新 run、新会话硬切） */
  attachContinue(handler: ContinueHandler) {
    this.onContinue = handler
  }

  /** Attach the host-side resolver for `<consult>` tags emitted by a leader. */
  attachConsult(handler: ConsultHandler) {
    this.onConsult = handler
  }

  attachInvestigate(handler: InvestigateHandler) {
    this.onInvestigate = handler
  }

  attachMeetingGuard(guard: (task: Task) => boolean) {
    this.meetingGuard = guard
  }

  private meetingGuardAllows(task: Task): boolean {
    // 会议守卫已注册为管线横切准入（构造函数），此处委托单点裁决
    return this.pipeline.admits(task)
  }

  private enforceMeetingGuard(task: Task): boolean {
    if (this.meetingGuardAllows(task)) return true
    const current = this.store.get(task.id)
    if (current?.meetingTaskRole === 'container') {
      if (current.status === 'queued' && !current.parked
        && this.store.updateIf(current.id, { status: 'queued' }, { parked: true })) this.pushTask(current.id)
      return false
    }
    if (current?.meetingId && current.status === 'queued'
      && this.store.updateIf(current.id, { status: 'queued', runId: current.runId, executionOwner: current.executionOwner }, { status: 'cancelled', endedAt: Date.now() })) {
      this.kernel.sweepTaskExecutionState(current.id, { retry: true, claim: true, lifecycle: 'dispose' })
      this.pushTask(current.id)
    }
    return false
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

  private issueOps: { reviewStatus: (childId: string, verdict: 'pass' | 'fail', note?: string) => void; addIssueComment?: (issueId: string, text: string) => IssueCommentLike | null } | null = null
  /** Issue 操作接口（委派审核流用；addIssueComment 供全文/兜底落评论，返回 null = Issue 不存在，
   *  调用方必须降级任务证据/事件通道，绝不静默丢弃） */
  attachIssueOps(ops: { reviewStatus: (childId: string, verdict: 'pass' | 'fail', note?: string) => void; addIssueComment?: (issueId: string, text: string) => IssueCommentLike | null }) {
    this.issueOps = ops
  }

  /** 审核子任务（委派循环调用，runner 负责调度 issueOps 写状态） */
  applyChildReview(childId: string, verdict: 'pass' | 'fail', note?: string) {
    this.issueOps?.reviewStatus(childId, verdict, note)
  }

  /** Issue 评论（队员全文报告与回灌失败兜底的落点）；返回 null = 未送达（Issue 不存在） */
  addIssueComment(issueId: string, text: string): IssueCommentLike | null {
    return this.issueOps?.addIssueComment?.(issueId, text) ?? null
  }

  /** 执行日志留痕（状态类事件：落盘 + 推 UI）；expected 限定该事件属于哪次运行 */
  private note(taskId: string, text: string, expected: TaskExpectation = {}) {
    const full = this.store.appendEvent(taskId, { ts: Date.now(), kind: 'status' as const, text }, expected)
    if (full) this.pushEvent(taskId, full)
  }

  /** facade：武装流式派单嗅探已迁 ledger（批次 4a） */
  private armDelegateSniffer(taskId: string) {
    this.delegateLedger.armDelegateSniffer(taskId)
  }

  /** facade：收尾回合关闭流式建单通道已迁 ledger（批次 4a；smoke 直连，签名冻结） */
  suspendDelegateSpawns(taskId: string) {
    this.delegateLedger.suspendDelegateSpawns(taskId)
  }

  /** facade：撤销流式期间提前建的单已迁 ledger（批次 4a；「先 allSettled 再撤子单」
   *  顺序与 child.title 留痕在 ledger 内原样保持） */
  private abandonEarlySpawns(taskId: string) {
    this.delegateLedger.abandonEarlySpawns(taskId)
  }

  /** facade：收编流式期间提前建的单已迁 ledger（批次 4a；smoke 直连，签名冻结；
   *  seenKeys 永不清空语义随迁） */
  async takeEarlySpawns(taskId: string, expectedRunId?: string): Promise<{ entries: Array<{ call: DelegateCall; childId: string }>; seenKeys: Set<string> }> {
    return this.delegateLedger.takeEarlySpawns(taskId, expectedRunId)
  }

  /** facade：具名拒单查账已迁 ledger（批次 4a；smoke 直连，签名冻结；持久层+内存层
   *  双层账同查，不得合并成单层） */
  delegateRejectionRecorded(taskId: string, expectedRunId: string | undefined, key: string): boolean {
    return this.delegateLedger.delegateRejectionRecorded(taskId, expectedRunId, key)
  }

  /** facade：具名拒单落账已迁 ledger（批次 4a；smoke 直连，签名冻结） */
  recordDelegateRejection(taskId: string, reason: string, dispatch?: { to: string; prompt: string }) {
    this.delegateLedger.recordDelegateRejection(taskId, reason, dispatch)
  }

  /** facade：具名拒单窥探已迁 ledger（批次 4a；smoke 直连，签名冻结） */
  peekDelegateRejections(taskId: string, expectedRunId?: string): string[] {
    return this.delegateLedger.peekDelegateRejections(taskId, expectedRunId)
  }

  /** facade：具名拒单按数确认已迁 ledger（批次 4a；smoke 直连，签名冻结） */
  acknowledgeDelegateRejections(taskId: string, expectedRunId: string | undefined, count: number): void {
    this.delegateLedger.acknowledgeDelegateRejections(taskId, expectedRunId, count)
  }

  /** facade：取走并清空被拒派单原因已迁 ledger（批次 4a；smoke 直连，签名冻结） */
  takeDelegateRejections(taskId: string, expectedRunId?: string): string[] {
    return this.delegateLedger.takeDelegateRejections(taskId, expectedRunId)
  }

  /** facade：委派回执确认已迁 ledger（批次 4a；smoke 直连，签名冻结） */
  acknowledgeDelegateReceipts(taskId: string, runId: string | undefined, childIds: readonly string[]): void {
    this.delegateLedger.acknowledgeDelegateReceipts(taskId, runId, childIds)
  }

  /** facade：诊断面（冒烟用）嗅探缓冲字符数已迁 ledger（批次 4a；smoke 直连，签名冻结） */
  sniffBufferChars(taskId: string): number {
    return this.delegateLedger.sniffBufferChars(taskId)
  }

  /** facade：同键互斥与建单编排已迁 execution/child-spawner.ts（批次 4b；smoke 直连，签名冻结）。
   *  互斥键格式（I4.3）与 dispatchHold 三步（I4.4）在 spawner 内逐字保持。 */
  spawnDelegateChild(taskId: string, call: DelegateCall, expectedRunId = this.store.get(taskId)?.runId): Promise<Task | null> {
    return this.childSpawner.spawnDelegateChild(taskId, call, expectedRunId)
  }

  /** facade：只读调查建单已迁 execution/child-spawner.ts（批次 4b；smoke 直连，签名冻结） */
  async spawnInvestigateChild(taskId: string, call: InvestigateCall): Promise<Task | null> {
    return this.childSpawner.spawnInvestigateChild(taskId, call)
  }
  /** facade：worker 编号预留已迁 ledger（批次 4a） */
  private reserveWorkerIndex(taskId: string) {
    return this.delegateLedger.reserveWorkerIndex(taskId)
  }
  /** 测试出口：直连探测缓存（配 setGitRepositoryProbeCacheProbeForTest 观测命中/未命中）。 */
  gitRepositoryProbeForTest(dir: string): Promise<GitRepositoryProbeResult> {
    return gitRepositoryProbe(dir)
  }

  /** agent 引用的 API 预设 → 会话连接覆盖（预设 + 模型须同时具备） */
  private resolveConnection(agentId?: string) {
    const me = (this.getTeam?.() ?? []).find((a) => a.id === agentId)
    const preset = me?.presetId ? this.getPresets?.().find((p) => p.id === me.presetId) : undefined
    return me?.model && preset ? { name: preset.name, baseURL: preset.baseURL, apiKey: preset.apiKey, protocol: preset.protocol } : undefined
  }

  private newRunId(taskId: string) {
    return `run_${taskId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
  }

  /** Finish one successful turn, including any delegation emitted before the final message. */
  private async completeTurn(taskId: string, session: BackendSession, r: BackendTurnResult, claim: RunClaim, consultDepth = 0, meetingTurn = false): Promise<string> {
    const task = this.store.get(taskId)!
      const isInvestigation = !!task.suppressIssue && !!task.parentTaskId
      const team = this.getTeam?.() ?? []
      const me = team.find((a) => a.id === task.agentId)
      let finalText = r.response
      /** <continue> 与 delegate 同源解析：领队用委派循环的全部回合文本，普通任务用首回合两源 */
      let scanTexts: string[] = [r.delegationText ?? '', r.response]
      if (isOfficeTask(task)) {
        // 办公室会话不受理派单与咨询（会议优先规则已禁用这些日常协议标记，首条消息也不注入派发协议）：
        // 越界输出的派单/评估/审核/咨询/接力标记一律只剥离展示并留痕，绝不建单、绝不发起咨询或接力。
        // 会议允许的 investigate 不在此列，走下方 completeInvestigates。
        const texts = [r.delegationText ?? '', r.response]
        const ignoredDelegates = texts.reduce((max, text) => Math.max(max, parseDelegates(text).length), 0)
        const ignoredConsults = texts.reduce((max, text) => Math.max(max, parseConsultsMerged(text).length), 0)
        if (ignoredDelegates || ignoredConsults) {
          const parts = [ignoredDelegates ? `派单 ${ignoredDelegates} 个` : '', ignoredConsults ? `咨询 ${ignoredConsults} 个` : ''].filter(Boolean)
          this.note(taskId, `⚠ 办公室会话不受理${ignoredDelegates ? '派单' : ''}${ignoredDelegates && ignoredConsults ? '与' : ''}${ignoredConsults ? '咨询' : ''}标记（已忽略 ${parts.join('、')}）`, runCondition(claim))
        }
        // 接力标记一并剥掉（办公室任务没有 Issue，handleContinue 会原样返回标记、污染展示结果）
        finalText = stripContinue(stripConsults(stripReviews(stripRoundNotes(stripDelegates(finalText)))))
      } else if ((me?.subordinates?.length || this.delegateLedger.seenKeyCount(taskId) || (task.agentId && (!me || (me.role && /队长|领队|captain|leader/i.test(me.role)))
        && [r.delegationText, r.response].some((text) => text && parseDelegates(text).length)))
        && task.backend !== 'dsh' && !isInvestigation) {
        // The loop receives this Run's full execution expectation explicitly:
        // it must never rediscover the identity from whatever record is latest
        // by the time the turn's response is processed.
        const outcome = await runDelegationLoop(taskId, session, r, runCondition(claim), {
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
          applyReview: (childId, verdict, note) => this.applyChildReview(childId, verdict, note),
          addIssueComment: (issueId, text) => this.addIssueComment(issueId, text),
          sendChildSummaryTurn: (childId, content) => this.sendChildSummaryTurn(childId, content)
        })
        finalText = outcome.finalText || r.response
        scanTexts = outcome.scanTexts
      }
      if (!this.isCurrentRun(claim)) return finalText
      // 只读调查的放行面：办公室会话只在自己的会议发言回合放行（发起侧显式标注，见
      // meeting-controller 的 speak）——办公室身份同时承载「会议发言」与「咨询应答」，
      // 拿身份当放行条件会让顾问把咨询当会议、真的发出调查。普通领队任务照旧（会议外的
      // 调查是既有能力，有独立 smoke 与预算记账），不受此闸约束。
      const investigateAllowed = !isOfficeTask(task) || meetingTurn
      if (this.onInvestigate && investigateAllowed) {
        const investigation = await this.completeInvestigates(taskId, session, finalText, scanTexts, task.parentTaskId ? 1 : 0, claim)
        finalText = investigation.finalText
        scanTexts = investigation.scanTexts
      } else if (this.onInvestigate) {
        // 办公室会话的非会议回合（咨询应答/自由追问）：标记只剥离展示、不发起调查，
        // 并具名留痕——静默丢弃与「模型没输出」无从区分，正是这类边界失效的盲区。
        const dropped = scanTexts.flatMap((text) => parseInvestigatesMerged(text)).length
        if (dropped) {
          this.note(taskId, `⚠ 办公室会话只在会议发言回合受理只读调查；本回合是咨询应答，已忽略 ${dropped} 个调查标记`, runCondition(claim))
          finalText = stripInvestigates(finalText)
          scanTexts = scanTexts.map((text) => stripInvestigates(text))
        }
      }
      if (!this.isCurrentRun(claim)) return finalText
      // 办公室会话不发起咨询（会议优先只在提示词层禁用；运行时闸门同上，避免会议中途拉进另一条办公室会话）
      if (this.onConsult && !isOfficeTask(task)) {
        const consultation = await this.completeConsults(taskId, session, finalText, scanTexts, consultDepth, claim)
        finalText = consultation.finalText
        scanTexts = consultation.scanTexts
      }
      if (!this.isCurrentRun(claim)) return finalText
      finalText = this.handleContinue(taskId, task, scanTexts, finalText, claim)
      await this.finalizeDone(taskId, finalText, claim)
    return finalText
  }

  private async completeInvestigates(
    taskId: string,
    session: BackendSession,
    initialText: string,
    initialScanTexts: string[],
    depth: number,
    claim: RunClaim
  ): Promise<{ finalText: string; scanTexts: string[] }> {
    let finalText = initialText
    let scanTexts = initialScanTexts
    const expected = runCondition(claim)
    // 残缺 investigate 开标记具名回执（与 delegate 同构）：解析不出调查≠可以无痕，
    // 多源去重后逐条留痕（本单未应答 + 其后完整标记按字面独立受理，不断言内嵌已应答）
    const notedBrokenInvestigates = new Set<string>()
    const drainBrokenInvestigates = () => {
      for (const broken of scanTexts.flatMap((text) => findUnmatchedInvestigateOpens(text))) {
        const key = `${broken.to}\n${broken.excerpt}`
        if (notedBrokenInvestigates.has(key)) continue
        notedBrokenInvestigates.add(key)
        this.note(taskId, `⚠ ${unmatchedInvestigateOpenReason(broken)}`, expected)
      }
    }
    drainBrokenInvestigates()
    const seen = new Set<string>()
    const calls = parseInvestigatesMerged(...scanTexts).filter((call) => {
      const key = `${call.to}\n${call.prompt}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    if (!calls.length) return { finalText: stripInvestigates(finalText), scanTexts }
    const reports: Array<{ to: string; text: string }> = []
    for (const call of calls) {
      if (!this.isCurrentRun(claim)) return { finalText, scanTexts }
      const report = await this.onInvestigate?.({ sourceTaskId: taskId, call, depth })
      if (!this.isCurrentRun(claim)) return { finalText, scanTexts }
      if (report?.trim()) reports.push({ to: call.to, text: report.trim() })
    }
    if (!reports.length) return { finalText: stripInvestigates(finalText), scanTexts }
    const turn = await this.sendTurn(taskId, session, investigationFeedback(reports), claim)
    if (!this.isCurrentRun(claim)) return { finalText, scanTexts }
    if (!turn.ok) throw new Error(turn.error || '调查结果回灌回合失败')
    finalText = turn.response
    scanTexts = [turn.delegationText ?? '', turn.response]
    drainBrokenInvestigates()
    return { finalText: stripInvestigates(finalText), scanTexts }
  }

  /**
   * Resolve consultations emitted by the current session, then give the
   * source agent a chance to continue with the answers. Consultation answers
   * are deliberately sent through sendTurn so the source session remains
   * single-flight and all resulting events keep their normal task timeline.
   */
  private async completeConsults(
    taskId: string,
    session: BackendSession,
    initialText: string,
    initialScanTexts: string[],
    consultDepth: number,
    claim: RunClaim
  ): Promise<{ finalText: string; scanTexts: string[] }> {
    let finalText = initialText
    let scanTexts = initialScanTexts
    const expected = runCondition(claim)
    // 残缺 consult 开标记具名回执（与 delegate 同构）：本单未应答也要具名留痕，
    // 绝不允许领队按「已应答」契约等到永远；多源去重，回灌回合新见的一并补痕
    const notedBrokenConsults = new Set<string>()
    const drainBrokenConsults = () => {
      for (const broken of scanTexts.flatMap((text) => findUnmatchedConsultOpens(text))) {
        const key = `${broken.to}\n${broken.excerpt}`
        if (notedBrokenConsults.has(key)) continue
        notedBrokenConsults.add(key)
        this.note(taskId, `⚠ ${unmatchedConsultOpenReason(broken)}`, expected)
      }
    }
    drainBrokenConsults()
    const seen = new Set<string>()
    let rounds = 0
    for (;;) {
      const calls = parseConsultsMerged(...scanTexts).filter((call) => {
        const key = `${call.to}\n${call.prompt}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      if (!calls.length) return { finalText: stripConsults(finalText), scanTexts }
      if (rounds >= MAX_CONSULT_ROUNDS) return { finalText: stripConsults(finalText), scanTexts }
      rounds++
      const answers: Array<{ from: string; text: string }> = []
      for (const call of calls) {
        if (!this.isCurrentRun(claim)) return { finalText, scanTexts }
        const answer = await this.onConsult?.({ sourceTaskId: taskId, call, depth: consultDepth })
        if (!this.isCurrentRun(claim)) return { finalText, scanTexts }
        if (answer?.trim()) answers.push({ from: call.to, text: answer.trim() })
      }
      if (!answers.length) return { finalText: stripConsults(finalText), scanTexts }
      const turn = await this.sendTurn(taskId, session, consultReplyFeedback(answers), claim)
      if (!this.isCurrentRun(claim)) return { finalText, scanTexts }
      if (!turn.ok) throw new Error(turn.error || '咨询回灌回合失败')
      finalText = turn.response
      scanTexts = [turn.delegationText ?? '', turn.response]
      drainBrokenConsults()
    }
  }

  /**
   * 阶段接力：回合文本里有 <continue> 时在同一 Issue 创建后继执行（新会话硬切）。
   * 护栏：委派子任务不参与（生命周期归委派循环）；同 issue handoff 任务 ≥ 8 拒绝；
   * 剥掉标记防止外漏，并在结果末尾留指向。
   */
  private handleContinue(taskId: string, task: Task, scanTexts: string[], finalText: string, claim?: RunClaim): string {
    const issueId = task.issueId
    if (task.parentTaskId || !issueId) return finalText
    // The caller normally passes the claim captured before the turn started.
    // Standalone harnesses may call this with the record they just read; that
    // record is the observation, never a freshly re-read newer Run.
    const expected: TaskExpectation = claim
      ? runCondition(claim)
      : { status: 'running', runId: task.runId, executionOwner: task.executionOwner }
    const cont = parseContinueMerged(...scanTexts)
    if (!cont) {
      // 可观测性：回复里出现过标记字样却没解析成功（未闭合/围栏内/示例复述），留痕说明为何没接力——
      // 否则用户只看到"硬切从没触发过"，无从分辨是 agent 没输出还是解析拒收
      if (scanTexts.some((text) => text.includes('<continue'))) {
        const e = { ts: Date.now(), kind: 'status' as const, text: '⚠ 检测到 <continue> 字样但未构成有效接力（需完整闭合且位于回复末尾；不在末尾的标记必须显式 start="auto" 才走兜底），未触发' }
        const full = this.store.appendEvent(taskId, e, expected)
        if (full) this.pushEvent(taskId, full)
      }
      return finalText
    }
    const stripped = stripContinue(finalText)
    const note = (text: string) => {
      const e = { ts: Date.now(), kind: 'status' as const, text }
      const full = this.store.appendEvent(taskId, e, expected)
      if (full) this.pushEvent(taskId, full)
    }
    if (cont.loose) note('阶段接力标记不在回复末尾（其后仍有内容），已按显式 start="auto" 兜底解析')
    const existing = findHandoffSuccessor(this.store.list(), task)
    if (!existing && repeatsHandoffPhase(task, cont.brief)) {
      note('阶段接力已阻止：简报仍指向当前阶段，请在当前会话继续处理或等待用户回复')
      return `${stripped}\n\n已阻止重复交接当前阶段，保留当前会话。`
    }
    // Cancelled handoffs are abandoned attempts and must not consume the
    // finite relay chain budget. Failed, queued, running and completed
    // handoffs remain durable chain members for audit and loop prevention.
    const chainLimit = this.opts().maxHandoffChain ?? MAX_HANDOFF_CHAIN
    const handoffCount = new Set(this.store.list().filter((t) =>
      t.issueId === task.issueId && t.trigger === 'handoff' && t.status !== 'cancelled'
    ).map((t) => t.continuesFrom ?? t.id)).size
    if (!existing && handoffCount >= chainLimit) {
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
    if (!ok) {
      // 接线回归可观测：处理器未挂接（attachContinue 缺失）或拒绝建单（如源任务已不存在）。
      // 此前这里静默吞掉标记，与"agent 没输出标记"无从区分——正是硬切"看起来失效"的盲区。
      note('⚠ 阶段接力未生效：处理器未挂接或拒绝创建后继，标记已剥除')
      return stripped
    }
    if (existing) {
      note(`阶段接力后继已存在（${existing.id}），已忽略重复交接`)
      return `${stripped}\n\n阶段接力后继已存在，未创建或启动新的执行。`
    }
    note(`阶段接力：下一阶段已${cont.start === 'auto' ? '排队（本阶段收尾后自动执行）' : '备好（等你启动）'}（同一 Issue 的新执行 #${handoffCount + 1}）`)
    return `${stripped}\n\n→ 阶段接力：下一阶段已${cont.start === 'auto' ? '排队（本阶段收尾后自动执行）' : '备好（等你启动，见该 Issue 的「▶ 启动」）'}，见该 Issue 的最新执行。`
  }

  /**
   * 隐藏回合：让 agent 根据执行内容重起一个简短标题。
   * 调用方需先把事件管道切到静默（titleMode），失败静默返回 false，不影响任务本体。
   * 硬预算：标题是装饰性收尾，绝不许把已完成的回合拖在 running。
   */
  private async retitleByAgent(taskId: string, session: BackendSession, claim: RunClaim): Promise<boolean> {
    const expected = runCondition(claim)
    let budgetTimer: NodeJS.Timeout | undefined
    try {
      const r = await Promise.race([
        this.sendTurn(taskId, session, RETITLE_PROMPT, claim),
        new Promise<BackendTurnResult>((resolve) => {
          budgetTimer = setTimeout(() => resolve({ ok: false, response: '', error: RETITLE_BUDGET_EXCEEDED }), RETITLE_TURN_BUDGET_MS)
        })
      ])
      if (!this.store.matches(taskId, expected)) return false
      if (!r.ok) {
        if (r.error === RETITLE_BUDGET_EXCEEDED) {
          // 预算耗尽：作废标题回合的代数（迟到的终态/回调一律拒绝）、停掉服务端
          // 仍在跑的标题回合，任务按原标题立即收尾
          this.bumpTurnGen(taskId)
          this.disarmWatchdog(taskId)
          void Promise.resolve(session.stop()).catch(() => {})
          this.note(taskId, `标题生成超时（${Math.round(RETITLE_TURN_BUDGET_MS / 1000)}s 无响应），保留原标题收尾`, expected)
        } else {
          this.note(taskId, `标题生成失败（${r.error || '未知原因'}），保留原标题收尾`, expected)
        }
        return false
      }
      const line = r.response
        .split(/\r?\n/)
        .map((s) => s.replace(/^[#>*\-\s]+/, '').replace(/["'「」《》`*]/g, '').trim())
        .find((s) => s.length > 0)
      if (!line) return false
      // A decorative title belongs to the Run that produced it; a stale title
      // turn must not rename a newer Run's Task.
      return !!this.store.updateIf(taskId, expected, { title: line.slice(0, 60), titleAuto: false })
    } catch {
      return false
    } finally {
      if (budgetTimer) clearTimeout(budgetTimer)
    }
  }

  /**
   * Send one follow-up and return the exact turn payload, including prior messages.
   * 等待全程由空转看门狗护送：有事件就续命；真超时时先停回合再返回错误，
   * 后端不会留一个还在跑的僵尸回合跟下一次操作抢会话。
   * `expected` 只接受本 runner 已提交的运行身份：外部传入的 runId 必须能解析到
   * 该次认领，否则视为已被新运行取代，不再驱动会话。
   *
   * 每个回合在这里拿到**自己的**不可变身份（新 generation + 新 stamp）；不会去改写
   * 任何既有回合的身份对象，旧回调因此不可能被"续命"成新回合的回调。
   */
  private async startIsolatedTurn(taskId: string, content: string, claim: RunClaim): Promise<BackendTurnResult> {
    const task = this.store.get(taskId)
    const backend = task && this.backends.get(task.backend)
    if (!task || !backend || !this.isCurrentRun(claim)) return { ok: false, response: '', error: 'Task execution is no longer active' }
    const previous = this.kernel.sessionOf(taskId)
    const resumeSessionId = task.sessionId || previous?.sessionId
    if (!resumeSessionId) return { ok: false, response: '', error: TURN_ISOLATION_REQUIRED }
    // 诚实降级：后端没有恢复通路时， resumeSessionId 只会被它静默忽略、开一个新会话
    // 冒充恢复成功——在拆掉旧连接之前就拒绝，按可行动报错落败
    if (!backend.supportsResume) return { ok: false, response: '', error: RESUME_UNSUPPORTED_MESSAGE }
    if (previous) {
      this.kernel.dropInstalledSession(taskId, 'replaced')
      this.kernel.dropLaunchHandle(taskId)
      await awaitCleanup(() => previous.stop())
      await awaitCleanup(() => previous.detach ? previous.detach() : previous.close())
    }
    if (!this.isCurrentRun(claim)) return { ok: false, response: '', error: 'Task execution is no longer active' }

    const generation = this.bumpTurnGen(taskId)
    const life = this.lifecycle(taskId)
    const router = new SessionTurnRouter()
    const channel = this.sessionChannel(router)
    const turn = this.openTurn(taskId, router, claim, generation, undefined)
    let unregister: () => void = () => {}
    const result = new Promise<BackendTurnResult>((resolve) => {
      unregister = life.registerResume(turn.token, (value) => resolve(value as BackendTurnResult))
    })
    const sentinel = this.idleSentinel(taskId)
    const me = (this.getTeam?.() ?? []).find((agent) => agent.id === task.agentId)
    // 实际运行走执行流节点（Start→Running）：启动竞态与回合执行各自成节点，节点在途账
    // 接管线账本（`${taskId}:node:*`），流级收尾端口承接原 finally 的全部语义。
    type IsolatedState = FlowState & { turnResult?: BackendTurnResult }
    const state: IsolatedState = {}
    const ports: ExecutionPorts<IsolatedState> = {
      start: async () => {
        const session = await this.executor.start(
          () => backend.start({
            prompt: content,
            workdir: task.workdir,
            mode: this.opts().mode,
            model: me?.model,
            thinking: me?.thinking,
            connection: this.resolveConnection(task.agentId),
            resumeSessionId,
            turn: turn.stamp,
            events: channel
          }),
          sentinel.timeout,
          () => this.isCurrentRun(claim) && life.accepts(turn.token) && this.meetingGuardAllows(task),
          `${taskId}:${claim.runId}`
        )
        let bound: Task | undefined
        try {
          bound = this.store.updateIf(taskId, runCondition(claim), session.sessionId ? { sessionId: session.sessionId } : {})
        } catch (error) {
          await this.closeLateSession(session, claim)
          throw error
        }
        if (!bound) {
          await this.closeLateSession(session, claim)
          throw new Error('Task execution is no longer active')
        }
        // 会话安装唯一入口（六步序列；I1.1：持久绑定成功后才允许进内存表）
        this.kernel.installSession({ taskId, session, router, generation, workdir: task.workdir })
      },
      runTurn: async () => {
        state.turnResult = await Promise.race([result, sentinel.timeout])
      }
    }
    const flow = await this.flowEngine.run<IsolatedState>(taskId, [new StartNode(ports), new RunningNode(ports)], state, {
      onFlowEnd: (ctx, error) => {
        sentinel.cancel()
        if (life.generation === generation) unregister()
        // 隔离回合自建会话的启动句柄同 run() 收尾清账，防 isIdle 永久 false（热更门堵死）
        if (this.store.matches(taskId, runIdentity(claim))) this.kernel.dropLaunchHandle(taskId)
      }
    })
    if (state.turnResult !== undefined) return state.turnResult
    return { ok: false, response: '', error: flow.error ?? 'Task execution is no longer active' }
  }

  async sendTurn(taskId: string, session: BackendSession, content: string, expected?: string | RunClaim): Promise<BackendTurnResult> {
    const claim = typeof expected === 'object' && expected !== null ? expected : this.claimForRun(taskId, expected)
    const installed = this.kernel.sessionOf(taskId)
    if (!claim || !this.store.matches(taskId, runCondition(claim)) || !installed) {
      return { ok: false, response: '', error: 'Task execution is no longer active' }
    }
    session = installed
    const router = this.kernel.routerOf(session)
    if (!router) return { ok: false, response: '', error: TURN_ISOLATION_REQUIRED }
    // A task owns at most one provider turn. This also prevents a delayed
    // orchestration callback from replacing the waiter for a live turn.
    const life = this.lifecycle(taskId)
    if (life.pendingResume) {
      return { ok: false, response: '', error: 'Task already has an active turn' }
    }
    if (!this.sessionMayOpenNewTurn(session)) {
      return this.startIsolatedTurn(taskId, content, claim)
    }
    // 换代先作废在飞回合（含"没有终态就被放弃"的判定），再开启已证明可复用的连接。
    const gen = this.bumpTurnGen(taskId)
    const turn = this.openTurn(taskId, router, claim, gen, router.owner)
    let settleTurn: (v: BackendTurnResult) => void = () => {}
    let unregisterResume: () => void = () => {}
    const settled = new Promise<BackendTurnResult>((resolve) => {
      settleTurn = resolve
      unregisterResume = life.registerResume(turn.token, (v) => resolve(v as BackendTurnResult))
    })
    let idleFired = false
    const { timeout, cancel } = this.idleSentinel(taskId, () => { idleFired = true })
    try {
      // send 不阻塞裁决：立即失败（连接已死等）要马上浮出，不能干等空转上限；
      // 看门狗触发的 stop 会让 send 以 reject 收尾，统一按超时语义上报
      void session.send(content, turn.stamp).catch((e) => {
        // 只有这一回合自己的失败才作废它；迟到的 reject 不得连累后继回合
        router.abandonTurn(turn.stamp.id)
        settleTurn(idleFired ? turnTimeoutError(this.turnBudgetMs(taskId)) : { ok: false, response: '', error: e instanceof Error ? e.message : String(e) })
      })
      const result = await Promise.race([settled, timeout])
      return result ?? { ok: false, response: '', error: '回合已失效' }
    } finally {
      cancel()
      // 已放弃回合（预算超时后被护栏的）不得清理后继回合的等待句柄；
      // lifecycle generation 守卫只允许清理属于自己的那一回合。
      if (life.generation === gen) unregisterResume()
    }
  }

  /**
   * 总结轮通路（独立实现）：对已终态子单的存活会话追加一轮 prompt→reply，供委派循环
   * 在全文双落之后换取压缩总结。有意独立于 sendTurn——子单已终态、claim 已释放，
   * running 闸门必然拒绝；本通路直接在既有会话路由上登记一个一次性回合记录，回复只经
   * 本方法返回值交给调用方：不落任务事件、不改终态、不写 store，也不触碰派单去重/
   * 归属交接/建树清理边界（委派协议 summary 层，见 delegate.ts 的 DelegationContext）。
   * 返回 null = 无存活会话或连接无法证明回合归属（非 turnScoped / 已弃用 / 恢复挂起）；
   * 回合超时按失败裁决，并取消在飞请求（session.stop）+ 退役连接（不可复用）——适配器
   * 单槽在飞，迟到响应会顶着「当前回合」身份投递给同连接的下个回合，必须让追问改走
   * resume 重建；被顶掉/退役的旧回合由 onRevoked 立即收口，不等预算。
   */
  async sendChildSummaryTurn(childId: string, content: string): Promise<BackendTurnResult | null> {
    const session = this.kernel.sessionOf(childId)
    const router = session ? this.kernel.routerOf(session) : undefined
    if (!session || !router || session.turnScoped !== true || !router.mayOpenNewTurn()) return null
    if (this.lifecycle(childId).pendingResume) return null
    const seq = router.nextSeq()
    const stamp: BackendTurnStamp = Object.freeze({
      seq,
      id: `turn_summary_${childId}_${this.kernel.nextTurnSeq()}_${Math.random().toString(36).slice(2, 8)}`
    })
    let settle: (r: BackendTurnResult) => void = () => {}
    const settled = new Promise<BackendTurnResult>((resolve) => { settle = resolve })
    const record: TurnRecord = {
      taskId: childId,
      seq,
      stamp,
      generation: -1,
      claim: { taskId: childId, runId: this.store.get(childId)?.runId ?? '' },
      token: Object.freeze({ generation: -1, sessionOwner: session.sessionId }),
      events: {
        onEvent: () => {},
        onTurnEnd: (r) => { router.closeTurn(stamp.id); settle(r) }
      },
      // 被顶掉（后继回合接管/连接退役）时立即落败等待方：撤销不等预算兜底
      onRevoked: () => settle({ ok: false, response: '', error: '总结回合被撤销：会话被后继回合接管' })
    }
    // 入口检查到 openTurn 之间零 await：同会话单在飞回合的互斥在这个同步段内闭合
    router.openTurn(record)
    // 预算计时与发起 send 同时启动：终态、发送失败、预算三者竞速——send 悬挂（既不
    // resolve 也不 reject、终态也永不到达）同样必然在预算内返回；超时收口见 finally。
    const budget = Math.min(this.turnBudgetMs(childId), SUMMARY_TURN_BUDGET_MS)
    let timer: NodeJS.Timeout | undefined
    let timedOut = false
    const timeout = new Promise<BackendTurnResult>((resolve) => {
      timer = setTimeout(() => { timedOut = true; resolve(turnTimeoutError(budget)) }, budget)
    })
    try {
      // send 不阻塞裁决：立即失败先 settle（失败原因直达调用方）再撤销本回合记录；
      // 悬挂/慢速 resolve 不得拖住预算竞速，迟到的 reject 只作废仍在表中的自己
      void session.send(content, stamp).catch((e) => {
        settle({ ok: false, response: '', error: e instanceof Error ? e.message : String(e) })
        router.abandonTurn(stamp.id)
      })
      return await Promise.race([settled, timeout])
    } finally {
      // 超时收场（双保险）：适配器是单槽在飞请求（如 dsh-acp 的 session/prompt + 当前槽裁决），
      // 只撤路由记录挡不住迟到响应——旧请求的迟到终态会顶着「当前回合」的通道身份投递，
      // 同连接上的下个回合将收到旧回合的响应、自己的响应反被槽丢弃，旧 send 也悬而无收口。
      // ①取消在飞请求：BackendSession.stop 的契约即「中止当前回合」（dsh-acp 走
      //   session/cancel 通知，连接保活），旧请求尽快落终态、旧 send 得到收口；
      // ②退役连接（标记不可复用）：followUp 的复用门禁 sessionMayOpenNewTurn 据此拒绝旧
      //   连接，下个追问走既有 resume 重建通路，旧连接上的迟到消息随会话关闭无人接收。
      if (timedOut) {
        void session.stop().catch(() => {})
        router.retire('replaced')
      }
      if (timer) clearTimeout(timer)
    }
  }

  /** 执行一个任务（首回合） */
  private async run(taskId: string) {
    const task = this.store.get(taskId)
    if (!task || task.status !== 'queued') return
    if (!this.enforceMeetingGuard(task)) return
    this.doomWindows.forget(taskId)
    const backend = this.backends.get(task.backend)
    if (!backend) {
      this.failTask(taskId, `未知后端: ${task.backend}`)
      this.pushTask(taskId)
      return
    }
    const isWorker = !!task.parentTaskId
    const runId = this.newRunId(taskId)
    // Start a backend only after the queued -> running claim commits. The
    // expectation is the exact record observed when the scheduler decided to
    // dispatch: another instance (or another callback) that already claimed
    // this Task makes the claim fail, so the backend is never started twice.
    const owner = createExecutionOwner()
    const claimed = this.store.claimRun(taskId, {
      status: 'queued',
      runId: task.runId,
      executionOwner: task.executionOwner
    }, runId, owner, { startedAt: Date.now(), endedAt: undefined, error: undefined, failure: undefined })
    if (!claimed) {
      // Nothing was started: the Task either moved on (foreign running owner is
      // never adopted) or is parked. Re-project the durable state and stop.
      this.pushTask(taskId)
      return
    }
    const claim: RunClaim = { taskId, runId, owner }
    this.kernel.setClaim(taskId, claim)
    // 重新进入执行：终态收尾登记重置（重跑后再终态，收尾钩子照常执行）
    this.pipeline.reopen(taskId)
    this.pushTask(taskId)
    try {
      this.recordUser(taskId, task.prompt, runCondition(claim))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      try { this.failTask(taskId, `启动日志持久化失败：${message}`, claim) }
      catch (failure) { console.error('[TaskRunner] Could not persist launch failure', failure) }
      return
    }
    const runGen = this.bumpTurnGen(taskId)
    // 本会话的回合路由器：会话级通道只负责把回调交给它，归属判定集中在路由器里
    const router = new SessionTurnRouter()
    const channel = this.sessionChannel(router)

    // 首回合完成信号
    let firstTurnDone: ((v: BackendTurnResult) => void) | null = null
    const firstTurnPromise = new Promise<BackendTurnResult>((resolve) => {
      firstTurnDone = resolve
    })
    const firstTurn = this.openTurn(taskId, router, claim, runGen, undefined, (r) => firstTurnDone?.(r))

    // agent 身份注入：人设 + （领队时）委派协议。办公室会话（会议发言/咨询应答）只带人设与会话引导：
    // 不注入派发协议与阶段接力——会议优先规则禁用这些标记，注入了只会在两套协议之间制造冲突
    const team = this.getTeam?.() ?? []
    const me = team.find((a) => a.id === task.agentId)
    const office = isOfficeTask(task)
    let prompt = buildAgentPrompt(me, task.prompt, team)
    if (task.handoff) prompt = `${prompt}\n\n${handoffNoteBlock(task.handoff)}`
    if (!office && me?.subordinates?.length && task.backend !== 'dsh' && !(task.suppressIssue && task.parentTaskId)) {
      const block = buildDelegationBlock(me, team)
      if (block) prompt = `${prompt}\n\n${block}`
    }
    // 阶段接力协议（非委派子任务：worker 的生命周期归委派循环管）
    if (!isWorker && !office) prompt = `${prompt}\n\n${CONTINUE_BLOCK}`
    if (!isWorker && task.continuesFrom) {
      prompt = `${prompt}\n\n${HANDOFF_RECEIVE_CUE}`
      if (task.manualStartConfirmedAt && Number.isFinite(task.manualStartConfirmedAt)) prompt = `${prompt}\n\n${HANDOFF_START_CONFIRMED_CUE}`
    }
    // 领队会话武装流式派单嗅探：闭合一个 <delegate> 即提前建单（回灌仍只在回合末）
    const isLeader = !office && (!!me?.subordinates?.length || (!!task.agentId && (!me || !!me.role && /队长|领队|captain|leader/i.test(me.role))))
      && task.backend !== 'dsh' && !(task.suppressIssue && task.parentTaskId)
    if (isLeader) this.armDelegateSniffer(taskId)

    // 看门狗在 backend.start 之前武装：握手/建会话阶段挂死同样按空转判败并可硬杀，
    // 不再永久卡住 running 状态与并发槽；启动期间的线级心跳照常续命
    const sentinel = this.idleSentinel(taskId)
    // 实际运行走执行流节点（Start→Running→Finalize）：主路径与续聊/隔离回合同构，
    // 节点在途账接管线账本（`${taskId}:node:*`）；原 try/catch/finally 语义逐条映射——
    // 良性早退（绑定换手/回合失效）用协作中断表达，真错误走流错误路径（关会话+落败
    // +自动重试），外层 finally 映射到流级 onFlowEnd 端口。
    type RunState = FlowState & { session?: BackendSession; result?: BackendTurnResult; benign?: boolean }
    const state: RunState = {}
    const ports: ExecutionPorts<RunState> = {
      start: async (ctx) => {
        const session = await this.executor.start(
          () => backend.start({
            prompt,
            workdir: task.workdir,
            mode: this.opts().mode,
            model: me?.model,
            thinking: me?.thinking,
            connection: this.resolveConnection(task.agentId),
            // 自动重试第 1 次带会话续跑（maybeAutoRetry 故意保留 sessionId）：从失败处接着干，
            // 不再整任务从头重来；手动"重新运行"会清 sessionId，恒新会话不受影响
            resumeSessionId: task.sessionId || undefined,
            turn: firstTurn.stamp,
            events: channel
          }),
          sentinel.timeout,
          // The accept check captures this Run's claim: a start that resolves
          // after an external replacement (another instance, explicit cancel)
          // must be rejected, not installed under the newer Run.
          () => this.isCurrentRun(claim)
            && this.lifecycle(taskId).accepts(firstTurn.token) && this.meetingGuardAllows(task),
          `${taskId}:${claim.runId}`
        )
        // The durable session binding is the commit point. Only a session whose
        // conditional write succeeded may be installed in memory: a start whose
        // Run was replaced while it was pending is closed as-is and never keeps
        // the scheduler slot waiting for its turn.
        let bound: Task | undefined
        try {
          bound = this.store.updateIf(taskId, runCondition(claim), session.sessionId ? { sessionId: session.sessionId } : {})
        } catch (error) {
          await this.closeLateSession(session, claim)
          throw error
        }
        if (!bound) {
          await this.closeLateSession(session, claim)
          if (!this.isCurrentRun(claim)) {
            state.benign = true
            ctx.interrupted = { reason: '会话绑定失败：执行已换手' }
            return
          }
          throw new Error('会话绑定失败：执行归属已变化')
        }
        // 会话安装唯一入口（六步序列；I1.1：持久绑定成功后才允许进内存表）
        this.kernel.installSession({ taskId, session, router, generation: runGen, workdir: task.workdir })
        state.session = session
      },
      runTurn: async (ctx) => {
        // 首回合由同一哨兵继续护送：长时间无任何进展先停回合再判失败，不再无限等待
        try {
          state.result = await Promise.race([firstTurnPromise, sentinel.timeout])
        } finally {
          sentinel.cancel()
        }
        if (!this.isCurrentRun(claim)) {
          state.benign = true
          ctx.interrupted = { reason: '回合已失效' }
        }
      },
      finalize: async () => {
        const session = state.session as BackendSession
        const r = state.result as BackendTurnResult
        if (r.ok) {
          // 自动派生标题的任务：让 agent 总结重起标题（隐藏回合；worker/dsh 除外——前者会与回灌争用会话，后者不支持续聊）
          if (task.titleAuto && !task.parentTaskId && task.backend !== 'dsh') {
            this.lifecycle(taskId).setTitleMode(true)
            const titled = await this.retitleByAgent(taskId, session, claim)
            if (!this.isCurrentRun(claim)) return
            this.lifecycle(taskId).setTitleMode(false)
            if (titled) this.pushTask(taskId)
          }
          // 领队：进入委派循环（截获 <delegate> 标记 → 并行子任务 → 回灌 → 继续）
          // 0.7.0 起 worker 也可以是子领队（带 subordinates 即生效；delegate 内有防环与层级/预算闸）
          const finalText = await this.completeTurn(taskId, session, r, claim)
          if (this.store.matches(taskId, runIdentity(claim, { status: 'done' })) && this.opts().notify) this.notify(task, '完成', finalText)
        } else {
          await this.closeSession(taskId, runIdentity(claim))
          if (this.failTask(taskId, r.error || '回合失败', claim)) {
            this.maybeAutoRetry(taskId, claim)
            this.notifyFailure(taskId, task, r.error || '')
          }
        }
      }
    }
    const flow = await this.flowEngine.run<RunState>(taskId, [new StartNode(ports), new RunningNode(ports), new FinalizeNode(ports)], state, {
      onFlowEnd: () => {
        sentinel.cancel()
        this.store.flushEvents(taskId)
        if (this.store.matches(taskId, runIdentity(claim))) {
          this.kernel.dropLaunchHandle(taskId)
          // Session-level seenKeys are intentionally retained for follow-up turns.
          this.kernel.forgetTerminalResponse(taskId)
        }
        this.pushTask(taskId)
      }
    })
    if (state.benign) return
    if (flow.error !== undefined) {
      // 原 try/catch 的 catch 段：归属不在则静默让位，否则关会话+落败+自动重试+失败通知
      if (!this.isCurrentRun(claim)) return
      const msg = flow.error
      await this.closeSession(taskId, runIdentity(claim))
      if (this.failTask(taskId, msg, claim)) {
        this.maybeAutoRetry(taskId, claim)
        this.notifyFailure(taskId, task, msg)
      }
    }
  }

  /**
   * 自动重试（P4）：仅 retryable 的瞬态失败（限流/超时/进程崩溃/沙箱），上限 2 次。
   * 第 1 次优先带会话续跑（同后端可 resume）；第 2 次强制新会话（会话可能已被污染）。
   * 手动"重新运行"不受此影响（恒新会话、attempt 清零）。
   * 限流（429）退避后再重试：立即重打只会继续 429（各重试叠加请求量形成正反馈）。
   */
  private maybeAutoRetry(taskId: string, claim?: RunClaim) {
    const task = this.store.get(taskId)
    if (!task || task.status !== 'failed') return
    if (!this.meetingGuardAllows(task)) return
    const failure = task.failure
    const maxAttempts = this.opts().maxRetryAttempts ?? 2
    const decision = decideRetry(task, failure, maxAttempts, this.opts().retryBackoffMs)
    if (!decision.retry || !failure) return
    const next = decision.attempt
    const fresh = decision.freshSession
    const goalBudget = task.goalId ? ` · Phase execution ${next + 1}/${maxAttempts + 1}` : ''
    // The retry belongs to the Run that just failed. Its identity was captured
    // before the retry was decided, so a user cancel or a newer Run always wins.
    const failedRun: TaskExpectation = claim
      ? runIdentity(claim, { status: 'failed' })
      : { status: 'failed', runId: task.runId, executionOwner: task.executionOwner }
    const schedule = () => {
      this.kernel.clearRetry(taskId)
      const current = this.store.get(taskId)
      if (!current || !this.meetingGuardAllows(current)) return
      const requeued = this.store.updateIf(taskId, failedRun, {
        status: 'queued',
        endedAt: undefined,
        runId: undefined,
        executionOwner: undefined,
        attempt: next,
        ...(fresh ? { sessionId: undefined } : {})
      })
      // 退避等待期间用户可能已取消/手动处理：不再是原失败运行就放弃重试
      if (!requeued) return
      if (claim) this.kernel.dropClaim(taskId)
      const full = this.store.appendEvent(taskId, {
        ts: Date.now(),
        kind: 'status',
        text: `⟳ 自动重试 ${next}/2（${failure.title}）${fresh ? '· 新会话' : '· 续会话'}${goalBudget}`
      }, { status: 'queued', runId: undefined, executionOwner: undefined })
      if (full) this.pushEvent(taskId, full)
      this.pushTask(taskId)
      this.enqueue(this.store.get(taskId)!)
    }
    const delayMs = decision.delayMs
    if (delayMs > 0) {
      this.kernel.clearRetry(taskId)
      const full = this.store.appendEvent(taskId, {
        ts: Date.now(),
        kind: 'status',
        text: `⟳ ${failure.title}：退避 ${Math.round(delayMs / 1000)}s 后自动重试 ${next}/2（${fresh ? '新会话' : '续会话'}）${goalBudget}`
      }, failedRun)
      if (full) this.pushEvent(taskId, full)
      this.pushTask(taskId)
      const timer = setTimeout(schedule, delayMs)
      this.kernel.armRetryTimer(taskId, timer)
    } else {
      schedule()
    }
  }

  private notify(task: Task, what: string, body: string) {
    if (task.suppressIssue) return
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
  async followUp(taskId: string, content: string, opts?: { relay?: boolean; collectFinal?: boolean; consultDepth?: number; wait?: boolean; meetingTurn?: boolean; onExecution?: (identity: { taskId: string; runId: string; turnId: string }) => void }): Promise<{ ok: boolean; error?: string; finalText?: string }> {
    const task = this.store.get(taskId)
    if (!task) return { ok: false, error: '任务不存在' }
    const message = content.trim()
    if (!message) return { ok: false, error: '追问不能为空' }
    if (!this.enforceMeetingGuard(task)) return { ok: false, error: '会议已停止或删除，会话不再恢复' }
    if (task.status === 'running') return { ok: false, error: '任务正在运行（长时间无输出时可先「停止」再「重新运行」）' }
    // cancelled 也放行：目标模式停止/用户取消后的任务仍可追问续聊，别把 Issue 卡死在"任务尚未完成"
    if (task.status !== 'done' && task.status !== 'failed' && task.status !== 'cancelled') return { ok: false, error: '任务尚未完成' }
    // 显式接力入口（按钮）：把人工意图翻译成协议标记指令（recordUser 仍记原话）；
    // 追问正文里出现"下一阶段"等字样不会被再当成接力信号
    const wantsHandoff = !task.parentTaskId && opts?.relay === true
    if (wantsHandoff) {
      const existing = findHandoffSuccessor(this.store.list(), task)
      if (existing) {
        try {
          if (this.onContinue && !this.onContinue({ sourceTaskId: taskId, issueId: task.issueId!, brief: existing.prompt, start: 'parked' })) {
            return { ok: false, error: '阶段接力后继无法复用' }
          }
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
        this.recordUser(taskId, message)
        const started = prepareManualTaskStart(this.store, existing.id)
        if (started) this.enqueue(started)
        return { ok: true, ...(opts?.collectFinal ? { finalText: '阶段接力后继已存在，未重复创建。' } : {}) }
      }
    }
    const backend = this.backends.get(task.backend)
    if (!backend) return { ok: false, error: '后端不可用' }
    if (!this.kernel.sessionOf(taskId) && !task.sessionId) return { ok: false, error: '无会话可恢复' }
    const pendingChildren = this.store.list().filter((child) => child.parentTaskId === taskId && child.delegateSourceRunId && !child.delegateDeliveredAt)
    const pendingRejects = (task.delegateRejections ?? []).filter((entry) => !entry.deliveredAt)
    const safeReceipt = (value: string, limit: number) => escapeProtocolLiterals(value.slice(0, limit).replace(/[\r\n]+/g, ' '))
    const recoveryLines = [
      ...pendingChildren.map((child) => `- 已接单 ${child.id}（${child.status}）：${safeReceipt(child.title, 100)}${child.result ? `；结果：${safeReceipt(child.result, 400)}` : ''}`),
      ...pendingRejects.map((entry) => `- 未建单（运行 ${entry.runId}）：${safeReceipt(entry.reason, 600)}`)
    ].slice(0, 30)
    const recoveryNotice = recoveryLines.length ? delegateRecoveryNotice(recoveryLines) : ''
    const turnContent = (wantsHandoff ? `${HANDOFF_CUE}\n（用户原话：${message}）` : message) + recoveryNotice
    // 领队续聊同样武装流式派单嗅探（追问里派发 → 提前建单）；办公室会话不受理派单，不武装
    const me = (this.getTeam?.() ?? []).find((a) => a.id === task.agentId)
    if (!isOfficeTask(task) && (me?.subordinates?.length || (task.agentId && (!me || !!me.role && /队长|领队|captain|leader/i.test(me.role))))
      && task.backend !== 'dsh' && !(task.suppressIssue && task.parentTaskId)) this.armDelegateSniffer(taskId)

    const runId = this.newRunId(taskId)
    const beginRun = async (): Promise<RunClaim | null> => {
      this.doomWindows.forget(taskId)
      // Claim exactly the record this follow-up was built from. Only a
      // committed claim may start the backend; a Task that already moved on
      // (another instance, an explicit cancel, a newer Run) is left untouched.
      const owner = createExecutionOwner()
      const claimed = this.store.claimRun(taskId, {
        status: task.status,
        runId: task.runId,
        executionOwner: task.executionOwner,
        phaseIndex: task.phaseIndex
      }, runId, owner, {
        startedAt: Date.now(),
        // A follow-up on the same compatibility Task is still a new Goal
        // phase. Advance the phase index so maxRuns/runCount account for
        // continuation turns instead of remaining pinned at phase zero.
        ...(task.goalId ? { phaseIndex: (task.phaseIndex ?? 0) + 1 } : {}),
        endedAt: undefined,
        error: undefined,
        failure: undefined
      })
      if (!claimed) return null
      const claim: RunClaim = { taskId, runId, owner }
      this.kernel.setClaim(taskId, claim)
      this.pipeline.reopen(taskId)
      try {
        this.recordUser(taskId, message, runCondition(claim))
      } catch (error) {
        const failure = error instanceof Error ? error.message : String(error)
        try { await this.closeSession(taskId, runIdentity(claim)) }
        catch (closeError) { console.error('[TaskRunner] Could not close failed follow-up session', closeError) }
        try { this.failTask(taskId, `续聊日志持久化失败：${failure}`, claim) }
        catch (persistError) { console.error('[TaskRunner] Could not persist follow-up failure', persistError) }
        throw error
      }
      this.pushTask(taskId)
      return claim
    }

    // A dead live session may fall through to resume. Both paths belong to
    // this one follow-up Run, so initialize its identity exactly once.
    let claim: RunClaim | null
    try { claim = await beginRun() }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
    if (!claim) return { ok: false, error: '任务已开始新的执行，本次追问未生效' }
    if (opts?.onExecution) this.kernel.registerTurnStartObserver(claim.runId, opts.onExecution)
    const acknowledgeRecovery = () => {
      if (!recoveryNotice || !this.isCurrentRun(claim)) return
      for (const child of pendingChildren.slice(0, recoveryLines.length)) {
        if (!child.delegateDeliveredAt) this.store.updateIf(child.id, { runId: child.runId }, { delegateDeliveredAt: Date.now() })
      }
      const acknowledgedRejects = pendingRejects.slice(0, Math.max(0, recoveryLines.length - pendingChildren.length))
      if (acknowledgedRejects.length) {
        const current = this.store.get(taskId)
        const keys = new Set(acknowledgedRejects.map((entry) => JSON.stringify([entry.runId, entry.key ?? '', entry.reason])))
        if (current?.delegateRejections) this.store.updateIf(taskId, runCondition(claim), { delegateRejections: current.delegateRejections.map((entry) =>
          !entry.deliveredAt && keys.has(JSON.stringify([entry.runId, entry.key ?? '', entry.reason])) ? { ...entry, deliveredAt: Date.now() } : entry) })
      }
    }

    // UI 追问传 wait:false：回合在后台跑、IPC 在 beginRun 后即返回——渲染层 busy 不
    // 锁整轮，否则「停止」会禁用到回合结束。默认（goal/meeting/sidecar 等自动化
    // 调用方）仍等整轮结束以拿 finalText。
    const runTurn = async (): Promise<{ ok: boolean; error?: string; finalText?: string }> => {
      if (!this.isCurrentRun(claim) || !this.meetingGuardAllows(task)) return { ok: false, error: '会议执行已终止' }
      // 1) 内存会话健在：直接续聊
      let liveSession = this.kernel.sessionOf(taskId)
      // M2 会话绑定工作目录：内存会话跑在安装时的 cwd 上。集成后续链换基线
      // （task.workdir 指向集成分支的托管 worktree）后，直续会把追问跑回旧目录、
      // 拿旧基线重复劳动——强制丢弃内存会话走 resume 重建（新连接以新 workdir 启动，
      // 会话内容经 sessionId 恢复；detach 保证 provider 会话不被销毁）。
      const liveWorkdir = this.kernel.workdirOf(taskId)
      // 换基线判定按别名折叠等价（与 git.ts 路径键同源）：同一目录的大小写/盘符别名写法
      // 不是换基线，误判会每次追问都丢弃内存会话走 resume 重建（白丢会话上下文）
      if (liveSession && task.workdir && liveWorkdir && !sameWorktreePath(liveWorkdir, task.workdir)) {
        await this.closeSession(taskId, runIdentity(claim), true)
        liveSession = undefined
      }
      // 连接无法证明新回合的归属（没有回合标识且上一回合归属已不可信）：不复用，
      // 关掉它走下面的 resume 重建——隔离连接 + 恢复，而不是猜回调属于谁。
      if (liveSession && !this.sessionMayOpenNewTurn(liveSession)) {
        await this.closeSession(taskId, runIdentity(claim), true)
        liveSession = undefined
      }
      if (liveSession) {
        try {
          if (!this.isCurrentRun(claim) || !this.meetingGuardAllows(task)) return { ok: false, error: '会议执行已终止' }
          const r = await this.sendTurn(taskId, liveSession, turnContent, claim)
          if (!this.isCurrentRun(claim)) return { ok: false, error: '回合已失效' }
          if (!r.ok) throw new Error(r.error || '续聊回合失败')
          acknowledgeRecovery()
          const finalText = await this.completeTurn(taskId, liveSession, r, claim, opts?.consultDepth ?? 0, opts?.meetingTurn === true)
          if (!this.store.matches(taskId, runIdentity(claim, { status: 'done' }))) return { ok: false, error: '回合已失效' }
          if (this.opts().notify) this.notify(task, '完成', finalText)
          return opts?.collectFinal ? { ok: true, finalText } : { ok: true }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (!this.isCurrentRun(claim)) return { ok: false, error: msg }
          if (!SESSION_DEAD_RE.test(msg) && msg !== TURN_ISOLATION_REQUIRED) {
            // A failed follow-up turn invalidates the provider session as well;
            // close it before dropping the session-wide delegate ledger.
            await this.closeSession(taskId, runIdentity(claim))
            this.failTask(taskId, msg, claim)
            this.pushTask(taskId)
            return { ok: false, error: msg }
          }
          // 后端连接已死（进程退出/管道断开）：丢弃内存会话，走下面的 resume 重建——
          // 以前这种情况只能重启应用，现在等价于把重启后的恢复路径内置
          await this.closeSession(taskId, runIdentity(claim), true)
          if (!this.isCurrentRun(claim)) return { ok: false, error: '回合已失效' }
          liveSession = undefined
        }
      }

      // 2) resume 路径：内存会话丢失（应用重启/连接死亡/归属不可信）时按 sessionId 重建
      if (!task.sessionId) {
        const msg = '无会话可恢复'
        this.failTask(taskId, msg, claim)
        this.pushTask(taskId)
        return { ok: false, error: msg }
      }
      // 诚实降级：后端不支持跨进程恢复时不得重建（resumeSessionId 只会被静默忽略、
      // 开新会话冒充恢复成功）——按可行动报错落败，任务显式 failed
      if (!backend.supportsResume) {
        this.failTask(taskId, RESUME_UNSUPPORTED_MESSAGE, claim)
        this.pushTask(taskId)
        return { ok: false, error: RESUME_UNSUPPORTED_MESSAGE }
      }
      // 续聊沿用 agent 钉死的模型（zcode resume 后用 session/setModel 补设；CLI --model 与 --resume 正交）
      // 看门狗在 backend.start 之前武装：resume 重建阶段挂死同样按空转判败，
      // 不永久挂住 running 状态（此前只能重启应用）
      const sentinel = this.idleSentinel(taskId)
      let unregisterResume: () => void = () => {}
      // 实际运行走执行流节点（Start→Running→Finalize）：启动竞态/回合执行/终态收尾
      // 各自成节点，节点在途账接管线账本；原 try/catch/finally 语义逐条映射到节点
      // enter 与流级 onFlowEnd 端口。良性早退（「回合已失效」）用协作中断表达：
      // 引擎在节点边界停止、不进错误路径（不 failTask）。
      type ResumeState = FlowState & { outcome?: { ok: boolean; error?: string; finalText?: string } }
      const state: ResumeState = {}
      const benignExit = (ctx: { interrupted?: { reason: string } }, error: string) => {
        state.outcome = { ok: false, error }
        ctx.interrupted = { reason: error }
      }
      const ports: ExecutionPorts<ResumeState> = {
        start: async (ctx) => {
          const gen = this.bumpTurnGen(taskId)
          const life = this.lifecycle(taskId)
          // 重建连接是独立会话：自己的通道、自己的回合身份，不与旧连接共享任何状态
          const router = new SessionTurnRouter()
          const channel = this.sessionChannel(router)
          const turnRecord = this.openTurn(taskId, router, claim, gen, undefined)
          const turn = new Promise<BackendTurnResult>((resolve) => {
            unregisterResume = life.registerResume(turnRecord.token, (v) => resolve(v as BackendTurnResult))
          })
          state.router = router
          state.turn = turn
          state.generation = gen
          const resumeSession = await this.executor.start(
            () => backend.start({
              prompt: turnContent,
              workdir: task.workdir,
              mode: this.opts().mode,
              model: me?.model,
              thinking: me?.thinking,
              connection: this.resolveConnection(task.agentId),
              resumeSessionId: task.sessionId,
              turn: turnRecord.stamp,
              events: channel
            }),
            sentinel.timeout,
            // Same captured-claim accept as the first run: a resume that resolves
            // after a replacement is closed instead of installed.
            () => this.isCurrentRun(claim)
              && this.lifecycle(taskId).accepts(turnRecord.token) && this.meetingGuardAllows(task),
            `${taskId}:${claim.runId}`
          )
          // Bind the resumed session to this Run before installing anything in
          // memory; a failed binding closes the exact session and writes no map.
          let bound: Task | undefined
          try {
            bound = this.store.updateIf(taskId, runCondition(claim), resumeSession.sessionId ? { sessionId: resumeSession.sessionId } : {})
          } catch (error) {
            await this.closeLateSession(resumeSession, claim)
            throw error
          }
          if (!bound) {
            await this.closeLateSession(resumeSession, claim)
            if (!this.isCurrentRun(claim)) {
              benignExit(ctx, '回合已失效')
              return
            }
            throw new Error('会话绑定失败：执行归属已变化')
          }
          // 会话安装唯一入口（六步序列；I1.1：持久绑定成功后才允许进内存表）
          this.kernel.installSession({ taskId, session: resumeSession, router, generation: gen, workdir: task.workdir })
          state.session = resumeSession
        },
        runTurn: async (ctx) => {
          const r = await Promise.race([state.turn as Promise<BackendTurnResult>, sentinel.timeout])
          state.result = r
          sentinel.cancel()
          if (!this.isCurrentRun(claim)) {
            benignExit(ctx, '回合已失效')
            return
          }
          if (!r?.ok) throw new Error(r?.error || '续聊回合失败')
        },
        finalize: async (ctx) => {
          acknowledgeRecovery()
          const finalText = await this.completeTurn(taskId, state.session as BackendSession, state.result as BackendTurnResult, claim, opts?.consultDepth ?? 0, opts?.meetingTurn === true)
          if (!this.store.matches(taskId, runIdentity(claim, { status: 'done' }))) {
            benignExit(ctx, '回合已失效')
            return
          }
          if (this.opts().notify) this.notify(task, '完成', finalText)
          state.outcome = opts?.collectFinal ? { ok: true, finalText } : { ok: true }
        }
      }
      const flow = await this.flowEngine.run<ResumeState>(taskId, [new StartNode(ports), new RunningNode(ports), new FinalizeNode(ports)], state, {
        onFlowEnd: (ctx, error) => {
          sentinel.cancel()
          if (error !== undefined) unregisterResume()
          else if (this.lifecycle(taskId).generation === (state.generation as number)) unregisterResume()
          // 重建会话的启动句柄随回合收尾清账（与 run() 的 finally 同语义）：漏清会让每次
          // 重建式续聊（换基线/重启后续聊）都漏一个句柄，isIdle 永久 false、热更 apply
          // 被「有任务在执行」挡死。归属已换手时不动，替换执行自己的句柄自己管。
          if (this.store.matches(taskId, runIdentity(claim))) this.kernel.dropLaunchHandle(taskId)
        }
      })
      if (state.outcome) return state.outcome
      const msg = flow.error ?? '续聊回合失败'
      this.failTask(taskId, msg, claim)
      this.pushTask(taskId)
      return { ok: false, error: msg }
    }

    const executeTurn = () => runTurn().finally(() => this.kernel.dropTurnStartObserver(claim.runId))
    if (opts?.wait === false) {
      // 后台回合自身失败已走 failTask→pushTask 广播显错；这里只兜意外抛出，防静默挂 running
      void this.trackMap(this.activeTurns, taskId, executeTurn()).catch((e) => {
        const msg = e instanceof Error ? e.message : String(e)
        this.failTask(taskId, msg, claim)
        this.pushTask(taskId)
      })
      return { ok: true }
    }
    return this.trackMap(this.activeTurns, taskId, executeTurn())
  }

  /** 用户打断回执文案：note 存在 = 用户主动打断（reason 非空带原因，空 = 未填写）；
   *  undefined = 系统/级联取消，不打标。 */
  private interruptText(note?: { reason?: string }): string | undefined {
    if (!note) return undefined
    const reason = (note.reason ?? '').trim()
    return reason ? `用户打断：${reason}` : '用户打断（未填写原因）'
  }

  async cancel(taskId: string, note?: { reason?: string }): Promise<{ ok: boolean; error?: string; warning?: string }> {
    const task = this.store.get(taskId)
    if (!task) return { ok: false, error: '任务不存在' }
    const interrupt = this.interruptText(note)
    // Cancel the execution this call observed. The condition is captured before
    // any teardown, so a Run that replaced the observed one keeps running.
    const observed: TaskExpectation = { status: task.status, runId: task.runId, executionOwner: task.executionOwner }
    const cancelObserved = () => this.store.updateIf(taskId, observed, { status: 'cancelled', endedAt: Date.now(), ...(interrupt ? { error: interrupt } : {}) })
    const retryPending = this.kernel.hasRetryTimer(taskId)
    if (task.status === 'failed' && retryPending) {
      if (!cancelObserved()) return { ok: false, error: '任务状态已变化，取消未生效' }
      // 状态已翻转为 cancelled：事件期望身份必须匹配翻转后的库内状态，写错会静默不落
      if (interrupt) this.note(taskId, interrupt, { ...observed, status: 'cancelled' })
      this.kernel.sweepTaskExecutionState(taskId, { retry: true, invalidateTurns: true, claim: true, lifecycle: 'dispose' })
      this.pushTask(taskId)
      this.store.flushEvents(taskId)
      void this.pipeline.settle(taskId, 'cancelled', { actor: 'runner', source: 'cancel', ...(interrupt ? { reason: interrupt } : {}) }).catch(() => {})
      return { ok: true }
    }
    if (task.status === 'queued') {
      if (!cancelObserved()) return { ok: false, error: '任务状态已变化，取消未生效' }
      if (interrupt) this.note(taskId, interrupt, { ...observed, status: 'cancelled' })
      this.kernel.sweepTaskExecutionState(taskId, { retry: true, invalidateTurns: true, claim: true, lifecycle: 'dispose' })
      this.pushTask(taskId)
      void this.pipeline.settle(taskId, 'cancelled', { actor: 'runner', source: 'cancel', ...(interrupt ? { reason: interrupt } : {}) }).catch(() => {})
      return { ok: true }
    }
    if (task.status !== 'running') return { ok: false, error: '任务不在运行中' }
    this.cancellationDrains.set(taskId, (this.cancellationDrains.get(taskId) ?? 0) + 1)
    try {
      // The Run claim is still valid here, so buffered provider data can be
      // committed before cancellation rejects late callbacks.
      const drained = await this.closeEventBatches(taskId)
      const persistenceWarning = drained ? '' : '任务已停止，但部分事件日志写入失败；已保存的恢复副本将在重启时回放，无法写入副本的事件可能丢失'
      const session = this.kernel.sessionOf(taskId)
      const launchHandle = this.kernel.launchHandleOf(taskId)
      const sessionWorkdir = this.kernel.workdirOf(taskId) ?? task.workdir
      const claim = this.kernel.claimOf(taskId)
      if (!claim || !this.isCurrentRun(claim)) return { ok: false, error: '执行归属不在当前运行器，未取消任务' }
      const cancelled = this.store.updateIf(taskId, runCondition(claim), { status: 'cancelled', endedAt: Date.now(), ...(interrupt || persistenceWarning ? { error: [interrupt, persistenceWarning].filter(Boolean).join('；') } : {}) })
      if (!cancelled) return { ok: false, error: '任务状态已变化，取消未生效' }
      if (interrupt) this.note(taskId, interrupt, runIdentity(claim, { status: 'cancelled' }))
      // Resolve start/send races immediately. Waiting for the idle timeout would
      // keep a scheduler slot occupied after cancellation.
      this.kernel.sweepTaskExecutionState(taskId, { retry: true, claim: true, watchdog: 'expire' })
      // 终点处理走管线单点（取消源）：级联取消子任务已挂横切收尾钩子，此处只销账
      void this.pipeline.settle(taskId, 'cancelled', { actor: 'runner', source: 'cancel', runId: claim.runId, ...(interrupt ? { reason: interrupt } : {}) }).catch(() => {})
      // Detach the cancelled Run before awaiting provider cleanup: a retry may
      // already be using this taskId when stop/close eventually settles.
      this.kernel.sweepTaskExecutionState(taskId, {
        launch: true, session: 'drop', workflow: { permissions: true, delegationLedger: true },
        watchdog: 'disarm', lifecycle: 'dispose', terminal: true
      })
      this.pushTask(taskId)
      if (!session) {
        try { await awaitCleanup(() => launchHandle?.stop()) } catch {}
      }
      if (session) await awaitCleanup(() => this.kernel.trackSessionRelease(session, sessionWorkdir, async () => {
        await awaitCleanup(() => session.stop())
        await session.close()
      }), 4_000)
      this.store.flushEvents(taskId)
      return persistenceWarning ? { ok: true, warning: persistenceWarning } : { ok: true }
    } finally {
      const remaining = (this.cancellationDrains.get(taskId) ?? 1) - 1
      if (remaining) this.cancellationDrains.set(taskId, remaining)
      else this.cancellationDrains.delete(taskId)
    }
  }

  private trackMap<T>(map: Map<string, Promise<unknown>>, taskId: string, promise: Promise<T>): Promise<T> {
    map.set(taskId, promise)
    void promise.catch(() => {}).then(() => {
      if (map.get(taskId) === promise) map.delete(taskId)
    })
    return promise
  }

  /** facade：严格终止已迁 execution/termination.ts（批次 5，含 terminateSession/
   *  retireExecutionState/terminateTaskExclusive 与 terminating/terminationTargets/
   *  retiredProviderSessions 三组状态）。公共 API 签名冻结（§3 第 2 条，smoke 直连）。 */
  async terminateTask(taskId: string): Promise<{ ok: boolean; error?: string; warning?: string }> {
    return this.termination.terminateTask(taskId)
  }

  /** 空闲判定（热更 L1 apply 门控，设计 §7.4）——委托 Issue 管线单点裁决：
   * 在途账本空 + 适配源空 + store 无 running。计入条件只允许「在途瞬态」；任务
   * 结束后合法存活的常态（done 任务常驻活会话、detach 平台会话台账）结构性不在
   * 账本内。历史上 sessions 与 retiredProviderSessions 两次把看板永久判忙（热更
   * 被「有任务在执行」挡死）；新增机制的在途状态走管线 begin/end 登记，不再自建
   * Map 挂进判定。回归对表 smoke-issue-pipeline 的 idle 不变式。 */
  isIdle(): boolean {
    return this.pipeline.isIdle()
  }

  async shutdown() {
    // Drain accepted events while current Run claims are still valid, then
    // stop accepting provider callbacks before lifecycle invalidation.
    this.shuttingDown = true
    if (!await this.closeEventBatches(undefined, 2_000)) console.error('[TaskRunner] Shutdown left events in local recovery backups')
    this.disposeEventBatches()
    // First invalidate callbacks and stop owned sessions, then wait for any
    // Executor start races that resolve late and still need closing.
    // —— 执行态半部在内核 shutdownExecutionState 单点收口（F2）；runner 只清
    // 自己持有的工作流态与 executor/permissionBroker。
    await this.kernel.shutdownExecutionState()
    this.activeRunsMap.clear()
    this.activeTurns.clear()
    this.delegateLedger.clearSessionState()
    this.permissionBroker.shutdown()
    this.doomWindows.clear()
    await this.executor.shutdown()
  }

  sessionCount() {
    return this.kernel.sessionCount()
  }
}
