// 任务运行器：队列 + 生命周期 + 事件管道
// 状态机：queued → running → done | failed | cancelled
import type { ExecutionOwner, Task, TaskEvent, WorktreeInfo } from '../shared/types'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { sameExecutionOwner, type TaskExpectation, type TaskStore } from './store'
import { createExecutionOwner } from './persistence'
import type { AgentBackend, BackendSession, BackendSessionEvents, BackendTurnStamp, PermissionRequest, BackendTurnResult } from './backends/types'
import { runDelegationLoop, parseContinueMerged, stripContinue, parseDelegates, parseConsultsMerged, stripConsults, parseInvestigatesMerged, stripInvestigates, ancestorBudget, sanitizeChildPrompt, MAX_DEPTH, MAX_TOTAL_ROUNDS, type AgentLike, type DelegateCall, type ConsultCall, type InvestigateCall, type IssueCommentLike } from './delegate'
import { buildAgentPrompt, buildDelegationBlock, buildChildPrompt, CONTINUE_BLOCK, HANDOFF_CUE, HANDOFF_RECEIVE_CUE, HANDOFF_START_CONFIRMED_CUE, RETITLE_PROMPT } from './prompts'
import { findHandoffSuccessor, prepareManualTaskStart, repeatsHandoffPhase } from './handoff'
import { probeGitRepository, probeCurrentBranch, createWorktree, setWorktreeOwner, reclaimWorktree, replayLeaderBaseline, type GitRepositoryProbeResult } from './git'

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
import { decideRetry } from './retry-policy'
import { TurnLifecycle, type EventGateToken } from './turn-lifecycle'
import { DSH_TURN_BUDGET_MS } from './backends/dsh'
import { BoundedEventBatcher } from './event-batcher'

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
    suppressIssue?: boolean
    trigger?: import('../shared/types').RunTrigger
  }): Task
}
export type TaskCreationRequest = Parameters<ChildTaskCreator['createChildTask']>[0]
export type TaskCreator = ChildTaskCreator | ((input: TaskCreationRequest) => Task)

export interface RunnerPorts {
  send: (channel: string, payload: unknown) => void
  notify: (task: Task, what: string, body: string) => void
  onTaskEvent?: (taskId: string, event: Omit<TaskEvent, 'seq'>) => void
}

type RunnerEvent = Omit<TaskEvent, 'seq'>

const STREAM_DELTA_TYPES = new Set(['text.delta', 'reasoning.delta', 'tool.input.delta', 'compaction.delta'])

function isStreamDeltaEvent(event: RunnerEvent): boolean {
  return event.kind === 'text' && (!event.type || event.type.endsWith('.delta') || STREAM_DELTA_TYPES.has(event.type))
}

function hasStableEventIdentity(event: RunnerEvent): boolean {
  return (typeof event.eventId === 'string' && event.eventId.length > 0)
    || (typeof event.id === 'string' && event.id.length > 0)
}

function streamType(event: RunnerEvent): string {
  return event.type || 'text.delta'
}

function streamPersistence(event: RunnerEvent): 'live' | 'durable' {
  if (event.durability === 'durable' || event.durable === true || (event.durable && typeof event.durable === 'object')) return 'durable'
  if (event.durability === 'live' || event.durable === false || STREAM_DELTA_TYPES.has(event.type ?? '')) return 'live'
  return 'durable'
}

function mergeStreamEvents(previous: RunnerEvent, next: RunnerEvent): RunnerEvent {
  return {
    ...previous,
    text: `${previous.text ?? ''}${next.text ?? ''}`,
    data: next.data ?? previous.data
  }
}

function eventSize(event: RunnerEvent): number {
  return Buffer.byteLength(JSON.stringify(event), 'utf8') + 1
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
/** 后端连接已死的特征：命中后丢弃内存会话、降级 resume 重建（不再需要重启应用） */
const SESSION_DEAD_RE = /连接已关闭|进程退出|EPIPE|ENOTCONN|ECONNRESET|ECONNREFUSED|disconnected/i

/**
 * One execution Run, captured when its conditional claim committed.
 *
 * Every durable write produced by that Run's asynchronous work carries this
 * identity as its `expected` condition. A stale callback therefore cannot
 * finish, re-label or re-session a newer Run on the same compatibility Task,
 * no matter which process it came from. The owner is absent only for legacy or
 * hand-authored records whose identity is unknown; such a record only matches
 * other owner-less records, so an unknown owner is never silently adopted.
 */
interface RunClaim {
  taskId: string
  runId: string
  owner?: ExecutionOwner
}

/** A write that is only valid while the claimed Run is still the running one. */
function runCondition(claim: RunClaim, extra: TaskExpectation = {}): TaskExpectation {
  return { ...extra, status: 'running', runId: claim.runId, executionOwner: claim.owner }
}

/** A write that belongs to the claimed Run regardless of its current status. */
function runIdentity(claim: RunClaim, extra: TaskExpectation = {}): TaskExpectation {
  return { ...extra, runId: claim.runId, executionOwner: claim.owner }
}

/**
 * One accepted prompt→reply turn on one backend session.
 *
 * The record is immutable: `claim`, `generation`, `stamp` and its callback set
 * are fixed when the turn opens and are never re-pointed. A callback is judged
 * against the record it was stamped with, so opening a later turn can never
 * re-authorize the closures of an earlier one — the failure mode of the old
 * shared-and-mutated `EventContext`.
 */
interface TurnRecord {
  readonly taskId: string
  readonly seq: number
  readonly stamp: BackendTurnStamp
  readonly generation: number
  readonly claim: RunClaim
  readonly token: EventGateToken
  readonly events: BackendSessionEvents
}

/** Reported when a session cannot prove which turn a callback belongs to. */
export const TURN_ISOLATION_REQUIRED = 'session-turn-identity-unavailable'

/**
 * Correlates the callbacks of one `BackendSession` with the turn that produced
 * them. The session-level channel (created once, handed to the adapter at
 * start) forwards into this router; only the router decides which immutable
 * `TurnRecord` — if any — receives a callback:
 *
 * - a callback stamped with a known, still-open turn id goes to that turn;
 * - an unknown or already-closed id is dropped, never re-credited to the
 *   newest turn;
 * - a session that did **not** declare `turnScoped` cannot distinguish turns at
 *   all, so it is used for its isolated first turn only. Every later turn
 *   rebuilds the connection from its session id instead of guessing.
 */
class SessionTurnRouter {
  private readonly open = new Map<string, TurnRecord>()
  private currentId?: string
  private seq = 0
  /** 未声明回合身份的连接：未标记回调只能归给当时唯一在飞的回合 */
  legacy = true
  /** 有回合没收终态就被放弃：未标记回调的归属不再可信 */
  ambiguous = false
  /** 会话 id（登记后可知；回合 token 用它做 owner 门禁） */
  owner?: string
  /** 最近一次开在此连接上的运行身份（closeSession 的归属兜底） */
  lastClaim?: RunClaim

  nextSeq() {
    return ++this.seq
  }

  openTurn(record: TurnRecord) {
    this.open.set(record.stamp.id, record)
    this.currentId = record.stamp.id
  }

  /** Terminal admitted: the turn may no longer receive anything. */
  closeTurn(id: string) {
    this.open.delete(id)
  }

  /**
   * The turn was given up (watchdog, cancel, send failure) before any terminal.
   * Its callbacks are dropped from now on, and a connection that cannot stamp
   * callbacks is marked unpinnable so the next turn rebuilds it.
   */
  abandonTurn(id?: string) {
    if (!this.currentId) return
    if (id !== undefined && id !== this.currentId) return
    const record = this.open.get(this.currentId)
    if (!record) return
    this.open.delete(record.stamp.id)
    if (this.legacy) this.ambiguous = true
  }

  abandonOpen() {
    this.abandonTurn()
  }

  /** Drop every callback still associated with this connection. */
  retire(reason: 'closed' | 'replaced' = 'closed') {
    this.open.clear()
    this.currentId = undefined
    if (reason === 'replaced') this.ambiguous = true
  }

  /** Immutable routing decision for one adapter callback. */
  resolve(stamp?: BackendTurnStamp): TurnRecord | undefined {
    if (stamp && typeof stamp.id === 'string') return this.open.get(stamp.id)
    if (!this.legacy) return undefined
    if (this.ambiguous) return undefined
    return this.currentId ? this.open.get(this.currentId) : undefined
  }

  current(): TurnRecord | undefined {
    return this.currentId ? this.open.get(this.currentId) : undefined
  }

  /** A connection without turn identity may only be reused while unambiguous. */
  mayOpenNewTurn() {
    return !this.ambiguous
  }
}

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
  /** 会话绑定的工作目录（安装该会话时 backend.start 用的 cwd）。续链换基线后
   *  task.workdir 变更，followUp 凭它发现内存会话还跑在旧目录，强制走 resume 重建。 */
  private sessionWorkdirs = new Map<string, string>()
  /** Runs this runner committed to. Only a committed claim may start a backend
   *  or authorize a later write; the durable record is the tie-breaker. */
  private claims = new Map<string, RunClaim>()
  /** Per-session turn router: the single place that maps an adapter callback to
   *  a turn. Turn records are immutable; only the routing pointer moves. */
  private sessionTurns = new WeakMap<BackendSession, SessionTurnRouter>()
  /** Turn sequence for stamp ids (monotonic across sessions of one runner). */
  private turnSeq = 0
  /** 启动即注册的中止句柄（一次性 CLI 在 session 返回前就要能取消） */
  private launchHandles = new Map<string, { stop: () => void | Promise<unknown> }>()
  /** Delayed provider retries must be cancellable and must not outlive shutdown. */
  private retryTimers = new Map<string, NodeJS.Timeout>()
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
  private turnWatchdogs = new Map<string, { timer: NodeJS.Timeout; expire: () => void; budgetMs: number }>()
  /** Lifecycle gate: prevents abandoned-turn callbacks from resolving a newer waiter. */
  /** One gate/lifecycle per task. The Task remains the durable compatibility
   * record; these objects only own in-memory callback admission state. */
  private turnLifecycles = new Map<string, TurnLifecycle>()
  /** Pending provider batches are flushed at turn and process lifecycle boundaries. */
  private eventBatchers = new Map<BoundedEventBatcher<RunnerEvent>, string>()
  private readonly onTaskChanged?: (task: Task) => void
  /** 流式派单嗅探：领队会话期间逐条 text 事件累计扫描，闭合一个 <delegate> 即提前建单入队。
   *  回灌仍只在回合末（委派循环）发生，不会打断领队正在进行的主运行。 */
  private earlySpawns = new Map<string, { buffer: string; scanOffset: number; closeScanOffset: number; spawned: Map<string, { call: DelegateCall; childId: string }>; seenKeys: Set<string>; pending: Promise<unknown>[] }>()
  /** 被拒派单的原因（按任务累积）：委派循环每轮取走并回灌给领队，让它当场改派而不是干等不存在的回灌 */
  private delegateRejections = new Map<string, string[]>()
  private workerIndexReservations = new Map<string, number>()
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

  private async closeEventBatches(taskId?: string): Promise<boolean> {
    const selected = [...this.eventBatchers].filter(([, owner]) => taskId === undefined || owner === taskId)
    const committed = await Promise.all(selected.map(async ([batcher]) => {
      const ok = await batcher.close()
      if (ok) this.eventBatchers.delete(batcher)
      return ok
    }))
    return committed.every(Boolean)
  }

  private disposeEventBatches(taskId?: string) {
    for (const [batcher, owner] of this.eventBatchers) {
      if (taskId !== undefined && owner !== taskId) continue
      batcher.dispose()
      this.eventBatchers.delete(batcher)
    }
  }

  private lifecycle(taskId: string) {
    let lifecycle = this.turnLifecycles.get(taskId)
    if (!lifecycle) {
      lifecycle = new TurnLifecycle({ taskId, initialStatus: this.store.get(taskId)?.status ?? 'queued' })
      this.turnLifecycles.set(taskId, lifecycle)
    }
    return lifecycle
  }

  /**
   * 事件管道：落盘 + 推 UI；onTurnEnd 可挂回调。
   *
   * 闭包只读本回合的不可变身份（claim / generation / token），运行器任何时刻都不再
   * 改写它——给旧回调"重新授权"的唯一途径因此消失。
   */
  private makeTurnEvents(
    taskId: string,
    router: SessionTurnRouter,
    claim: RunClaim,
    token: EventGateToken,
    stamp: BackendTurnStamp,
    onTurnEnd?: (r: BackendTurnResult) => void
  ): BackendSessionEvents {
    const life = this.lifecycle(taskId)
    const active = (kind?: string, terminal = false) => {
      if (this.claims.get(taskId) !== claim) return false
      return life.accepts(token, { kind, terminal })
    }
    let ownershipCheckedAt = 0
    let ownershipValid = true
    const durableActive = (kind?: string, terminal = false, throttleMs = 0) => {
      if (!active(kind, terminal)) return false
      const now = Date.now()
      if (throttleMs > 0 && now - ownershipCheckedAt < throttleMs) return ownershipValid
      ownershipCheckedAt = now
      ownershipValid = this.isCurrentRun(claim)
      if (ownershipValid) life.setStatus('running')
      return ownershipValid && life.accepts(token, { kind, terminal })
    }
    let eventSequence = 0
    let terminalStarted = false
    let batcher!: BoundedEventBatcher<RunnerEvent>
    batcher = new BoundedEventBatcher<RunnerEvent>({
      // Ten UI updates per second remain visually responsive while keeping
      // synchronous durable commits off the per-token cadence.
      maxDelayMs: 100,
      maxRetryDelayMs: 5_000,
      maxItems: 64,
      maxBytes: 128 * 1024,
      sizeOf: eventSize,
      canMerge: (previous, next) => isStreamDeltaEvent(previous)
        && isStreamDeltaEvent(next)
        && !hasStableEventIdentity(previous)
        && !hasStableEventIdentity(next)
        && streamType(previous) === streamType(next)
        && streamPersistence(previous) === streamPersistence(next),
      merge: mergeStreamEvents,
      onFlush: (events) => {
        // Local lifecycle checks stay memory-only on the per-delta hot path.
        // The conditional batch append below is the durable ownership gate.
        if (!events.length) return true
        if (!active(events[0].kind)) return true
        this.touchWatchdog(taskId)
        // These objects stay queued after a failed commit. Assigning identity
        // once makes partial-write and uncertain-fsync retries idempotent.
        for (const event of events) {
          if (!hasStableEventIdentity(event)) {
            event.eventId = `agentdeck:batch:${stamp.id}:${++eventSequence}`
          }
        }
        let full: TaskEvent[]
        try {
          full = this.store.appendEvents(taskId, events, runCondition(claim))
        } catch {
          return false
        }
        if (full.length !== events.length) {
          // A replaced Run must discard its stale batch. A still-current Run
          // retains the same identified events and retries with backoff.
          return !durableActive(events[0].kind)
        }
        ownershipCheckedAt = Date.now()
        ownershipValid = true
        for (let index = 0; index < events.length; index++) {
          const event = events[index]
          if (!active(event.kind)) continue
          try {
            this.touchWatchdog(taskId)
            if (event.kind === 'text') this.sniffDelegates(taskId, event.text)
            if (event.kind === 'tool') this.observeToolCall(taskId, event, claim)
            this.ports.onTaskEvent?.(taskId, event)
            this.pushEvent(taskId, full[index])
          } catch (error) {
            // The batch is already durable. Do not retry it after a host/UI
            // callback failure, or the same events could be appended twice.
            console.error('[TaskRunner] Event delivery failed after commit', error)
          }
        }
        return true
      }
    })
    this.eventBatchers.set(batcher, taskId)
    return {
      onEvent: (incoming: RunnerEvent) => {
        // Legacy zcode, dsh ACP, and OpenCode CLI fallback text events are
        // durable by contract. Explicit provider live markers stay live, but
        // ordinary text is merged without changing its persistence semantics.
        let e = { ...incoming }
        if (!active(e.kind)) {
          // 标题回合的普通事件被静默，但线级进展照样给看门狗续命
          if (life.gate.state.titleMode && life.accepts(token)) this.touchWatchdog(taskId)
          return
        }
        if (e.kind === 'tool') {
          // The runner owns the live PermissionBroker decision in production.
          // Mark the forwarded event so GoalController does not run a second
          // doom-loop state machine for the same tool invocation.
          const data = e.data && typeof e.data === 'object' ? e.data as Record<string, unknown> : {}
          e = { ...e, data: { ...data, runnerDoomHandled: true } }
        }
        // The append, side effects, and renderer broadcast happen once per
        // bounded batch. A final event remains in the same ordered queue and
        // is flushed synchronously by onTurnEnd below.
        batcher.add(e)
      },
      onHeartbeat: () => { if (durableActive(undefined, false, 1_000)) this.touchWatchdog(taskId) },
      onTurnEnd: (r: BackendTurnResult) => {
        if (terminalStarted) return
        const response = typeof r.response === 'string' ? r.response.trim() : ''
        if (life.gate.state.titleMode && this.lastTerminalResponses.get(taskId) === response) return
        terminalStarted = true
        if (!durableActive('final', true)) {
          batcher.dispose()
          this.eventBatchers.delete(batcher)
          // 终态没被接受（运行器已换代/任务已终态）：本回合就此作废，回调不再可投递
          router.abandonTurn(stamp.id)
          return
        }
        void batcher.close().then((committed) => {
          this.eventBatchers.delete(batcher)
          if (!committed || !durableActive('final', true)) {
            router.abandonTurn(stamp.id)
            return
          }
          // 同一回合的重复终态按内容去重（标题回合不可被复述的旧终态顶掉）。回合保持
          // 开启，真正属于它的终态仍能落地。回合身份明确的适配器不需要这条，退回复用
          // 连接的老后端仍然依赖它。
          this.lastTerminalResponses.set(taskId, response)
          // 先收口本回合再投递：投递可能同步开启下一回合（标题/回灌）。
          router.closeTurn(stamp.id)
          onTurnEnd?.(r)
          // TurnLifecycle owns the one-shot waiter and generation check. This
          // keeps terminal admission on the same gate as ordinary events.
          life.resolveResume(token, r)
        })
      },
      onSessionId: (sessionId: string) => {
        if (!active() || !sessionId) return
        const task = this.store.get(taskId)
        if (!task || task.sessionId === sessionId) return
        // A resume id belongs to one Run. Binding it conditionally keeps a
        // delayed session callback from repointing a newer Run.
        if (!this.store.updateIf(taskId, runCondition(claim), { sessionId })) return
        life.gate.setSessionOwner(sessionId)
        this.pushTask(taskId)
      },
      onPermission: (req: PermissionRequest) => durableActive()
        ? this.askPermission(taskId, req)
        : Promise.resolve({ decision: 'deny' as const })
    }
  }

  /**
   * 会话级通道（一个 BackendSession 一个，交给适配器后不再改变）：把适配器回调
   * 连同它携带的回合身份交给路由器。身份不明的回调在这里被丢弃，不会被记到
   * "当前回合"头上。
   */
  private sessionChannel(router: SessionTurnRouter): BackendSessionEvents {
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
          void Promise.resolve(handle.stop()).catch(() => {})
          return
        }
        this.launchHandles.set(record.taskId, handle)
        this.lifecycle(record.taskId).registerLaunch(handle.stop)
      }
    }
  }

  /** 开启一个回合：身份一经创建即冻结，之后只读。 */
  private openTurn(
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
      id: `turn_${taskId}_${generation}_${++this.turnSeq}_${Math.random().toString(36).slice(2, 8)}`
    })
    const token: EventGateToken = Object.freeze({ generation, sessionOwner })
    const events = this.makeTurnEvents(taskId, router, claim, token, stamp, onTurnEnd)
    const record: TurnRecord = { taskId, seq, stamp, generation, claim, token, events }
    router.lastClaim = claim
    router.openTurn(record)
    return record
  }

  /** 会话仍是当前运行、且能证明新回合归属时，才允许在同一连接上开新回合。 */
  private sessionMayOpenNewTurn(session: BackendSession): boolean {
    const router = this.sessionTurns.get(session)
    if (!router) return false
    return session.turnScoped === true && router.mayOpenNewTurn()
  }

  /** 关掉一个连接的归属：之后它吐出的任何回调都不再被采纳。 */
  private retireSession(session: BackendSession, reason: 'closed' | 'replaced' = 'closed') {
    this.sessionTurns.get(session)?.retire(reason)
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
  private observeToolCall(taskId: string, event: Omit<TaskEvent, 'seq'>, claim: RunClaim) {
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
    }, runCondition(claim))
    if (!full) return
    this.pushEvent(taskId, full)
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
      // The answer belongs to the Run that asked for it. While the prompt was
      // pending a newer Run may have installed its own doom-loop window; a
      // stale answer must neither clear that window nor write into it.
      if (!this.isCurrentRun(claim)) return
      if (decision.decision === 'allow') {
        this.toolWindows.delete(taskId)
        const allowed = this.store.appendEvent(taskId, { ts: Date.now(), kind: 'status', text: 'doom-loop: 人工审批通过，继续执行', data: { stopReason: 'doom_loop_approved' } }, runCondition(claim))
        if (allowed) this.pushEvent(taskId, allowed)
        return
      }
      const denied = this.store.appendEvent(taskId, { ts: Date.now(), kind: 'status', text: 'doom-loop: 未获人工审批，停止当前回合', data: { stopReason: 'doom_loop_denied' } }, runCondition(claim))
      if (denied) this.pushEvent(taskId, denied)
      if (!this.store.matches(taskId, runCondition(claim))) return
      void Promise.resolve(this.sessions.get(taskId)?.stop()).catch(() => {})
    }).catch(() => {})
  }

  /** UI 应答权限请求 */
  resolvePermission(requestId: string, optionId: string, decision: 'allow' | 'deny', requestToken?: string) {
    return this.permissionBroker.resolve(requestId, optionId, decision, undefined, requestToken)
  }

  pendingPermissions(taskId: string): PermissionRequest[] {
    return this.permissionBroker.pendingFor(taskId)
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
    const record: { timer: NodeJS.Timeout; expire: () => void; budgetMs: number } = {
      timer: undefined as unknown as NodeJS.Timeout,
      budgetMs,
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
    w.timer = setTimeout(w.expire, w.budgetMs)
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
    const life = this.lifecycle(taskId)
    // 换代即作废在飞回合：它的回调从此不再可投递，无法归属的连接标记为不可复用
    const session = this.sessions.get(taskId)
    if (session) this.sessionTurns.get(session)?.abandonOpen()
    // TurnLifecycle is the authority for callback generations. A new
    // generation starts ownerless so synchronous start callbacks can be
    // admitted; the session owner is installed as soon as start resolves.
    const gen = life.invalidate()
    life.gate.setStatus(this.store.get(taskId)?.status ?? 'queued')
    life.gate.setSessionOwner(undefined)
    return gen
  }

  /**
   * Close a provider session that resolved for a Run this runner no longer
   * owns. It was never installed in memory, so it is stopped directly instead
   * of going through the task-keyed session map.
   */
  private async closeLateSession(session: BackendSession) {
    await this.awaitCleanup(() => session.stop())
    await this.awaitCleanup(() => session.close())
  }

  /** 关闭并移除内存会话（容错）：防止放弃的会话继续在后台跑、往任务日志里交错写事件 */
  async closeSession(taskId: string, expected?: TaskExpectation, preserveProviderSession = false) {
    const s = this.sessions.get(taskId)
    const claim = this.claims.get(taskId) ?? (s && this.sessionTurns.get(s)?.lastClaim)
    if (expected && (!claim || claim.runId !== expected.runId || !sameExecutionOwner(claim.owner, expected.executionOwner))) return
    await this.closeEventBatches(taskId)
    this.clearRetry(taskId)
    this.bumpTurnGen(taskId)
    this.earlySpawns.delete(taskId)
    this.delegateRejections.delete(taskId)
    this.lastTerminalResponses.delete(taskId)
    if (!s) return
    this.sessions.delete(taskId)
    this.sessionWorkdirs.delete(taskId)
    this.retireSession(s)
    await this.awaitCleanup(() => s.stop())
    await this.awaitCleanup(() => preserveProviderSession && s.detach ? s.detach() : s.close())
  }

  /** Release in-memory lifecycle state after IPC removes a terminal task. */
  async forget(taskId: string) {
    this.disposeEventBatches(taskId)
    this.clearRetry(taskId)
    this.disarmWatchdog(taskId)
    this.launchHandles.delete(taskId)
    this.claims.delete(taskId)
    const session = this.sessions.get(taskId)
    this.sessions.delete(taskId)
    this.sessionWorkdirs.delete(taskId)
    if (session) this.retireSession(session)
    this.permissionBroker.cancelTask(taskId)
    this.toolWindows.delete(taskId)
    this.earlySpawns.delete(taskId)
    this.delegateRejections.delete(taskId)
    this.workerIndexReservations.delete(taskId)
    this.lastTerminalResponses.delete(taskId)
    this.turnLifecycles.get(taskId)?.dispose()
    this.turnLifecycles.delete(taskId)
    if (session) {
      await this.awaitCleanup(() => session.stop())
      await this.awaitCleanup(() => session.close())
    }
  }

  private clearRetry(taskId: string) {
    const timer = this.retryTimers.get(taskId)
    if (!timer) return false
    clearTimeout(timer)
    this.retryTimers.delete(taskId)
    return true
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
    if (!this.store.updateIf(taskId, expected, { status: 'failed', endedAt: Date.now(), error, failure: classifyFailure({ error }) })) return false
    this.abandonEarlySpawns(taskId)
    if (claim && this.claims.get(taskId) === claim) this.claims.delete(taskId)
    this.lifecycle(taskId).setStatus('failed')
    this.pushTask(taskId)
    return true
  }

  /** Resolve a caller-supplied run id to the claim this runner committed.
   *  A run id this runner never claimed cannot authorize turns or writes. */
  private claimForRun(taskId: string, runId?: string): RunClaim | undefined {
    const claim = this.claims.get(taskId)
    return claim && (runId === undefined || claim.runId === runId) ? claim : undefined
  }

  /** True while the exact claimed Run is still the committed running one. */
  private isCurrentRun(claim: RunClaim | undefined): claim is RunClaim {
    return !!claim && this.store.matches(claim.taskId, runCondition(claim))
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
    this.delegateRejections.delete(taskId)
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
  async takeEarlySpawns(taskId: string, expectedRunId?: string): Promise<{ entries: Array<{ call: DelegateCall; childId: string }>; seenKeys: Set<string> }> {
    const empty = () => ({ entries: [] as Array<{ call: DelegateCall; childId: string }>, seenKeys: new Set<string>() })
    // 只收编仍属于该运行的内存状态：陈旧委派循环不得偷走替换运行的提前建单
    if (expectedRunId !== undefined && this.claims.get(taskId)?.runId !== expectedRunId) return empty()
    const state = this.earlySpawns.get(taskId)
    if (!state) return empty()
    if (state.pending.length) await Promise.allSettled(state.pending)
    // 等待期间运行可能已被替换：收编前重新核对归属
    if (expectedRunId !== undefined && this.claims.get(taskId)?.runId !== expectedRunId) return empty()
    state.pending = []
    const entries: Array<{ call: DelegateCall; childId: string }> = []
    for (const [key, entry] of state.spawned) {
      state.spawned.delete(key)
      state.seenKeys.add(key)
      if (entry.childId) entries.push(entry)
    }
    return { entries, seenKeys: new Set(state.seenKeys) }
  }
  /** 记录一条被拒派单的原因。只收「目标解析失败」（名单外/不存在）——这类改派有用；
   *  护栏拒单（防环/层级/预算）是政策性拒绝，回灌只会诱导模型再烧一轮，只留痕不回灌 */
  private recordDelegateRejection(taskId: string, reason: string) {
    const list = this.delegateRejections.get(taskId) ?? []
    list.push(reason)
    this.delegateRejections.set(taskId, list)
  }
  /** 取走并清空本任务被拒派单的原因（委派循环每轮回灌用；不残留到后续轮）。
   *  expectedRunId 限定只有仍持有该运行的循环才能取走，替换运行不被陈旧循环掏空。 */
  takeDelegateRejections(taskId: string, expectedRunId?: string): string[] {
    if (expectedRunId !== undefined && this.claims.get(taskId)?.runId !== expectedRunId) return []
    const list = this.delegateRejections.get(taskId) ?? []
    this.delegateRejections.delete(taskId)
    return list
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
  async spawnDelegateChild(taskId: string, call: DelegateCall, expectedRunId = this.store.get(taskId)?.runId): Promise<Task | null> {
    const task = this.store.get(taskId)
    if (!task) return null
    const claim = this.claimForRun(taskId, expectedRunId)
    // Only a committed claim may drive a running parent. A parent that is not
    // running yet (queued/parked) has no Run to invalidate, so the observed
    // record is the whole condition; a running record this runner never
    // claimed is foreign and is never adopted.
    const expected: TaskExpectation = claim ? runCondition(claim) : { runId: expectedRunId }
    const active = () => claim
      ? this.store.matches(taskId, expected)
      : this.store.get(taskId)?.status !== 'running' && this.store.get(taskId)?.runId === expectedRunId
    if (!active()) return null
    const guardedNote = (text: string) => this.note(taskId, text, expected)
    const team = this.getTeam?.() ?? []
    const me = team.find((a) => a.id === task.agentId)
    const subs = (me?.subordinates ?? []).map((id) => team.find((a) => a.id === id)).filter(Boolean) as AgentLike[]
    const target =
      subs.find((a) => a.name.toLowerCase() === call.to.toLowerCase()) ??
      subs.find((a) => a.backend.toLowerCase() === call.to.toLowerCase())
    if (!target) {
      // 名单回填 + 队长提示：模型常把「可咨询的队长」当成可派单对象，说清有效名单它才改派得动
      const rosterText = subs.map((a) => `${a.name}（${a.backend}）`).join('、') || '当前为空'
      const elsewhere = team.find((a) => a.id !== me?.id && (a.name.toLowerCase() === call.to.toLowerCase() || a.backend.toLowerCase() === call.to.toLowerCase()))
      const why = elsewhere
        ? `在团队里但不是你的队员（${(elsewhere.subordinates?.length ?? 0) > 0 ? '它是队长' : '它不归你管'}；只能 <consult> 咨询，不能被派活）`
        : '不在你的队员名单里'
      guardedNote(`⚠ 未找到可驱使的队员 "${call.to}"（${why}；你的队员：${rosterText}），跳过`)
      this.recordDelegateRejection(taskId, `to="${call.to}"：${why}`)
      return null
    }
    // 防环：目标已在祖先链上（或就是自己）→ 拒绝派发；顺带执行层级闸与全链轮数预算闸
    const { inherited, depth, ancestors } = ancestorBudget(this.store, taskId)
    ancestors.add(me?.id ?? `@${task.backend}`)
    const targetKey = target.id || `@${target.backend}`
    if (ancestors.has(targetKey)) {
      guardedNote(`⚠ 拒绝派给 ${call.to}：它在当前委派链上（防环），请改派他人或自己做`)
      return null
    }
    const delegateMaxDepth = this.opts().delegateMaxDepth ?? MAX_DEPTH
    const delegateTotalRounds = this.opts().delegateMaxTotalRounds ?? MAX_TOTAL_ROUNDS
    if (depth >= delegateMaxDepth) {
      guardedNote(`⚠ 委派层级已达上限（${delegateMaxDepth} 层），拒绝派给 ${call.to}`)
      return null
    }
    if (delegateTotalRounds - inherited <= 0) {
      guardedNote(`⚠ 全链委派轮数预算已耗尽，拒绝派给 ${call.to}`)
      return null
    }
    const workerIndex = this.reserveWorkerIndex(taskId)
    let workdir = task.workdir
    let unavailableReason: string | undefined
    let worktree: WorktreeInfo | undefined
    const gitProbe = !target.sharedWorkspace && task.workdir ? await this.gitRepositoryProbe(task.workdir) : undefined
    if (gitProbe && !active()) return null
    if (gitProbe?.status === 'error') {
      const why = `无法确认工作区是否可安全隔离，拒绝共享工作区派单——${gitProbe.reason}`
      guardedNote(`⚠ 拒绝派给 ${call.to}：${why}`)
      this.recordDelegateRejection(taskId, `to="${call.to}"：${why}`)
      return null
    }
    if (target.sharedWorkspace) {
      // 只读协作队员（审码/咨询类）显式声明共享工作区：零建树开销，直接用领队现场——
      // 与 meeting 调查模式同一约定；写代码的队员仍一律走隔离 worktree
      unavailableReason = 'Agent 标记共享工作区（只读协作）：直接使用领队工作区，不建 worktree'
    } else if (task.workdir && gitProbe?.status === 'repo') {
      if (!active()) return null
      // 基线分支显式传（缺省会从当前 HEAD 建——领队若中途动过分支，子任务基线会漂移）
      const branchProbe = await probeCurrentBranch(task.workdir)
      if (!active()) return null
      if (!branchProbe.ok) {
        const why = `无法确认隔离 worktree 基线，拒绝派单——${branchProbe.reason}`
        guardedNote(`⚠ 拒绝派给 ${call.to}：${why}`)
        this.recordDelegateRejection(taskId, `to="${call.to}"：${why}`)
        return null
      }
      const base = branchProbe.branch || undefined
      if (!active()) return null
      // worktree 创建与领队/其他子任务的 git 操作可能撞 index.lock：重试两次再放弃。
      // lastWtError 只记首次失败——后续重试撞上的是首次失败留下的残肢（branch already
      // exists 等），属余波而非原因；报余波会掩盖真凶（如 Filename too long 被顶掉）
      let wt: { path: string; metadata: WorktreeInfo } | null = null
      let lastWtError = ''
      const leaderDir = task.workdir
      const reclaimCancelledWorktree = async (candidate: { path: string }, phase: string) => {
        let reason = ''
        try {
          const cleanup = await reclaimWorktree(candidate.path, { force: true, deleteBranch: true, expectedOwnerTaskId: taskId })
          if (!cleanup.ok) reason = `回收结果 ${cleanup.status}：${cleanup.reason ?? '未知原因'}`
        } catch (error) {
          reason = `回收异常：${error instanceof Error ? error.message : String(error)}`
        }
        if (!reason) return
        const name = path.basename(candidate.path)
        const detail = `取消后${phase} worktree 回收失败（${reason}）；现场保留并已记录`
        this.store.noteWorktreeCleanupFailure(leaderDir, { name, reason: detail, ownerTaskId: taskId })
        this.note(taskId, `⚠ ${detail}`)
      }
      for (let attempt = 0; attempt < 3 && !wt; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, 500))
        if (!active()) return null
        wt = await createWorktree(leaderDir, `${taskId}_c${workerIndex}`, base, taskId, (m) => { if (!lastWtError) lastWtError = m }, {
          // 超时残肢清理部分失败（分支/注册残留）→ owner 时间线可见，重派撞
          // already exists 时现场与原因都查得到，不再静默复发
          onCleanupResidue: (failure) => { this.store.noteWorktreeCleanupFailure(leaderDir, failure) }
        })
        if (!active()) {
          if (wt) await reclaimCancelledWorktree(wt, '建树后')
          return null
        }
      }
      if (wt) {
        workdir = wt.path
        worktree = wt.metadata
        // 子单基线回放（multica「工作区即状态」不变量）：领队的未提交增量此刻只存在于
        // 领队工作区，子单的隔离 worktree 看不见就等于白派单。在子 agent 拿到 cwd 之前，
        // 用私有 index 把增量采集成一个提交回放进子 worktree（不修改领队工作区与用户 index；
        // 失败后的子侧回滚需核验，拒单回收失败需留痕）。回放提交随即成为子分支起始提交（B2 防双算：digest/集成以它为基线，
        // 领队改动不算子产出）；无增量零开销跳过；采集/应用失败具名拒建单回灌原因。
        const replay = await replayLeaderBaseline(task.workdir, wt.path, wt.metadata.baseSha)
        if (!active()) {
          await reclaimCancelledWorktree(wt, '基线回放后')
          return null
        }
        if (replay.status === 'refused') {
          let cleanupFailure: string | undefined
          try {
            const reclaimed = await reclaimWorktree(wt.path, { force: true, deleteBranch: true, expectedOwnerTaskId: taskId })
            if (!reclaimed.ok) cleanupFailure = `拒单后的 worktree 回收失败（${reclaimed.status}）：${reclaimed.reason ?? '未知原因'}`
          } catch (error) {
            cleanupFailure = `拒单后的 worktree 回收异常：${String(error)}`
          }
          if (cleanupFailure) {
            this.store.noteWorktreeCleanupFailure(leaderDir, {
              name: path.basename(wt.path),
              reason: cleanupFailure,
              ownerTaskId: taskId
            })
          }
          const refusal = `领队基线回放失败，拒建单——${replay.reason}${cleanupFailure ? `；${cleanupFailure}，现场保留并已记录` : ''}`
          guardedNote(`⚠ 拒绝派给 ${call.to}：${refusal}`)
          this.recordDelegateRejection(taskId, `to="${call.to}"：${refusal}`)
          return null
        }
        if (replay.status === 'applied') {
          worktree = {
            ...wt.metadata,
            baseSha: replay.commitSha,
            replay: { commitSha: replay.commitSha, files: replay.files, at: Date.now() }
          }
          guardedNote(`↧ 领队未提交基线已回放进子单（${replay.files} 个文件），子单以回放提交为基线`)
        }
      } else {
        // fail-closed：建树重试 3 次仍失败不再降级共享工作区——队员会在旧基线上白写、
        // 并行队员互相踩，隔离破了等于白派单。具名拒单走既有回灌通道（报首次 git 错误，
        // 重试余波不顶替）；仅 workdir 非 git 仓库/只读共享的环境性共享降级（上方分支）保留。
        const why = `worktree 建立失败，请稍后重派${lastWtError ? `——${lastWtError}` : ''}`
        guardedNote(`⚠ 拒绝派给 ${call.to}：${why}（不降级共享工作区）`)
        this.recordDelegateRejection(taskId, `to="${call.to}"：${why}`)
        return null
      }
    } else if (task.workdir) {
      unavailableReason = 'Workspace is not a Git worktree; using the shared workspace'
    }
    if (!active()) return null
    const childInstruction = sanitizeChildPrompt(call.prompt, task.workdir ?? '')
    const scopedInstruction = target.sharedWorkspace
      ? `【只读协作约定】此任务运行在领队共享工作区中。只检查并返回发现，不要修改、创建或删除文件，也不要执行会改变工作区或 Git 状态的操作。\n\n${childInstruction}`
      : childInstruction
    const childPrompt = buildChildPrompt(scopedInstruction, task.prompt)
    // 标题取 prompt 前 40 字——多个派单共享同一开场白时（如"每人审查两份报告"）标题会一模一样，
    // 看板上无法区分；与兄弟任务撞标题时追加序号
    const baseTitle = `${target.name}: ${call.prompt.slice(0, 40).replace(/\n/g, ' ')}`
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
      // The child was just created and has not been dispatched yet; bind the
      // metadata to the exact record so a concurrent claim cannot be rewritten.
      this.store.updateIf(child.id, { status: 'queued', runId: child.runId, executionOwner: child.executionOwner }, { worktree })
    }
    if (!active()) {
      await this.cancel(child.id)
      return null
    }
    guardedNote(`⚡ 已接单：${target.name} ← ${call.prompt.slice(0, 50).replace(/\n/g, ' ')}${call.prompt.length > 50 ? '…' : ''}`)
    this.enqueue(this.store.get(child.id)!)
    return child
  }

  /** Create a read-only investigation child: no worktree, no integration, no Issue. */
  async spawnInvestigateChild(taskId: string, call: InvestigateCall): Promise<Task | null> {
    const task = this.store.get(taskId)
    if (!task || task.parentTaskId) return null
    // Investigation runs on behalf of one claimed Run; round accounting must not
    // be charged to a run that replaced it (or that this runner never owned).
    const claim = this.claimForRun(taskId)
    if (!claim) return null
    const expected = runCondition(claim)
    if (!this.store.matches(taskId, expected)) return null
    const team = this.getTeam?.() ?? []
    const me = team.find((agent) => agent.id === task.agentId)
    const subs = (me?.subordinates ?? []).map((id) => team.find((agent) => agent.id === id)).filter(Boolean) as AgentLike[]
    const target = subs.find((agent) => agent.name.toLowerCase() === call.to.toLowerCase())
      ?? subs.find((agent) => agent.backend.toLowerCase() === call.to.toLowerCase())
    if (!target) { this.note(taskId, `⚠ 未找到可调查队员 "${call.to}"，跳过`, expected); return null }
    const { inherited } = ancestorBudget(this.store, taskId)
    const budget = this.opts().delegateMaxTotalRounds ?? MAX_TOTAL_ROUNDS
    if (budget - inherited <= 0) { this.note(taskId, '⚠ 全链委派轮数预算已耗尽，拒绝调查', expected); return null }
    this.store.updateIf(taskId, expected, { roundsUsed: (task.roundsUsed ?? 0) + 1 })
    const childInput = {
      title: `${target.name}: 调查 ${call.prompt.slice(0, 40).replace(/\n/g, ' ')}`,
      prompt: buildChildPrompt(`只读调查：${call.prompt}\n不要修改代码、不要创建提交，只返回可核验事实与引用。`, task.prompt),
      workdir: task.workdir,
      backend: target.backend,
      ...(target.id ? { agentId: target.id } : {}),
      parentTaskId: taskId,
      workerIndex: this.workerCount(taskId) + 1,
      suppressIssue: true,
      trigger: 'meeting' as const,
      unavailableReason: '调查模式：共享工作区只读，不创建 worktree'
    }
    const child = this.taskCreator
      ? (typeof this.taskCreator === 'function' ? this.taskCreator(childInput) : this.taskCreator.createChildTask(childInput))
      : this.store.create(childInput)
    this.note(taskId, `⚡ 已接单（调查）：${target.name} ← ${call.prompt.slice(0, 60).replace(/\n/g, ' ')}`, expected)
    this.enqueue(this.store.get(child.id)!)
    return child
  }
  private workerCount(taskId: string) {
    return this.store.list().filter((t) => t.parentTaskId === taskId).length
  }
  private reserveWorkerIndex(taskId: string) {
    const existing = this.store.list().filter((task) => task.parentTaskId === taskId)
    const previous = this.workerIndexReservations.get(taskId) ?? 0
    const next = Math.max(previous, existing.length, ...existing.map((task) => task.workerIndex ?? 0)) + 1
    this.workerIndexReservations.set(taskId, next)
    return next
  }
  /** Git 工作区探测（成功/非仓库带缓存；临时探测错误不缓存）。 */
  private gitUsableCache = new Map<string, GitRepositoryProbeResult>()
  private async gitRepositoryProbe(dir: string): Promise<GitRepositoryProbeResult> {
    const cached = this.gitUsableCache.get(dir)
    if (cached) return cached
    const probe = await probeGitRepository(dir)
    if (probe.status !== 'error') this.gitUsableCache.set(dir, probe)
    return probe
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
  private async completeTurn(taskId: string, session: BackendSession, r: BackendTurnResult, claim: RunClaim, consultDepth = 0): Promise<string> {
    const task = this.store.get(taskId)!
      const isInvestigation = !!task.suppressIssue && !!task.parentTaskId
      const team = this.getTeam?.() ?? []
      const me = team.find((a) => a.id === task.agentId)
      let finalText = r.response
      /** <continue> 与 delegate 同源解析：领队用委派循环的全部回合文本，普通任务用首回合两源 */
      let scanTexts: string[] = [r.delegationText ?? '', r.response]
      if (me?.subordinates?.length && task.backend !== 'dsh' && !isInvestigation) {
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
          addIssueComment: (issueId, text) => this.addIssueComment(issueId, text)
        })
        finalText = outcome.finalText || r.response
        scanTexts = outcome.scanTexts
      }
      if (!this.isCurrentRun(claim)) return finalText
      if (this.onInvestigate) {
        const investigation = await this.completeInvestigates(taskId, session, finalText, scanTexts, task.parentTaskId ? 1 : 0, claim)
        finalText = investigation.finalText
        scanTexts = investigation.scanTexts
      }
      if (!this.isCurrentRun(claim)) return finalText
      if (this.onConsult) {
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
    const seen = new Set<string>()
    const calls = parseInvestigatesMerged(...scanTexts).filter((call) => {
      const key = `${call.to}\n${call.prompt}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    if (!calls.length) return { finalText: stripInvestigates(finalText), scanTexts }
    const reports: string[] = []
    for (const call of calls) {
      if (!this.isCurrentRun(claim)) return { finalText, scanTexts }
      const report = await this.onInvestigate?.({ sourceTaskId: taskId, call, depth })
      if (!this.isCurrentRun(claim)) return { finalText, scanTexts }
      if (report?.trim()) reports.push(`### 调查 ${call.to} 的结果\n${report.trim()}`)
    }
    if (!reports.length) return { finalText: stripInvestigates(finalText), scanTexts }
    const turn = await this.sendTurn(taskId, session, `【系统·调查结果】\n${reports.join('\n\n')}\n\n请基于以上只读调查继续处理原任务。`, claim)
    if (!this.isCurrentRun(claim)) return { finalText, scanTexts }
    if (!turn.ok) throw new Error(turn.error || '调查结果回灌回合失败')
    finalText = turn.response
    scanTexts = [turn.delegationText ?? '', turn.response]
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
      const answers: string[] = []
      for (const call of calls) {
        if (!this.isCurrentRun(claim)) return { finalText, scanTexts }
        const answer = await this.onConsult?.({ sourceTaskId: taskId, call, depth: consultDepth })
        if (!this.isCurrentRun(claim)) return { finalText, scanTexts }
        if (answer?.trim()) answers.push(`### 队长 ${call.to} 的意见\n${answer.trim()}`)
      }
      if (!answers.length) return { finalText: stripConsults(finalText), scanTexts }
      const turn = await this.sendTurn(taskId, session, `【系统·咨询回复】\n${answers.join('\n\n')}\n\n请基于以上咨询继续处理原任务。`, claim)
      if (!this.isCurrentRun(claim)) return { finalText, scanTexts }
      if (!turn.ok) throw new Error(turn.error || '咨询回灌回合失败')
      finalText = turn.response
      scanTexts = [turn.delegationText ?? '', turn.response]
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
    const previous = this.sessions.get(taskId)
    const resumeSessionId = task.sessionId || previous?.sessionId
    if (!resumeSessionId) return { ok: false, response: '', error: TURN_ISOLATION_REQUIRED }
    if (previous) {
      this.sessions.delete(taskId)
      this.sessionWorkdirs.delete(taskId)
      this.retireSession(previous, 'replaced')
      this.launchHandles.delete(taskId)
      await this.awaitCleanup(() => previous.stop())
      await this.awaitCleanup(() => previous.detach ? previous.detach() : previous.close())
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
    try {
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
        () => this.isCurrentRun(claim) && life.accepts(turn.token)
      )
      let bound: Task | undefined
      try {
        bound = this.store.updateIf(taskId, runCondition(claim), session.sessionId ? { sessionId: session.sessionId } : {})
      } catch (error) {
        await this.closeLateSession(session)
        throw error
      }
      if (!bound) {
        await this.closeLateSession(session)
        return { ok: false, response: '', error: 'Task execution is no longer active' }
      }
      life.gate.setSessionOwner(session.sessionId)
      void life.attachSession({ generation, sessionOwner: session.sessionId }, session)
      router.legacy = session.turnScoped !== true
      router.owner = session.sessionId
      this.sessionTurns.set(session, router)
      this.sessions.set(taskId, session)
      this.sessionWorkdirs.set(taskId, task.workdir)
      this.pushTask(taskId)
      return await Promise.race([result, sentinel.timeout])
    } catch (error) {
      return { ok: false, response: '', error: error instanceof Error ? error.message : String(error) }
    } finally {
      sentinel.cancel()
      if (life.generation === generation) unregister()
    }
  }

  async sendTurn(taskId: string, session: BackendSession, content: string, expected?: string | RunClaim): Promise<BackendTurnResult> {
    const claim = typeof expected === 'object' && expected !== null ? expected : this.claimForRun(taskId, expected)
    const installed = this.sessions.get(taskId)
    if (!claim || !this.store.matches(taskId, runCondition(claim)) || !installed) {
      return { ok: false, response: '', error: 'Task execution is no longer active' }
    }
    session = installed
    const router = this.sessionTurns.get(session)
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
    this.claims.set(taskId, claim)
    this.pushTask(taskId)
    this.recordUser(taskId, task.prompt, runCondition(claim))
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

    // agent 身份注入：人设 + （领队时）委派协议
    const team = this.getTeam?.() ?? []
    const me = team.find((a) => a.id === task.agentId)
    let prompt = buildAgentPrompt(me, task.prompt, team)
    if (task.handoff) {
      prompt = `${prompt}

【交接备注（指派者为本次执行划定的范围指令：优先按它收窄工作，但不要把它当作需要回复的评论）】
> ${task.handoff}`
    }
    if (me?.subordinates?.length && task.backend !== 'dsh' && !(task.suppressIssue && task.parentTaskId)) {
      const block = buildDelegationBlock(me, team)
      if (block) prompt = `${prompt}\n\n${block}`
    }
    // 阶段接力协议（非委派子任务：worker 的生命周期归委派循环管）
    if (!isWorker) prompt = `${prompt}\n\n${CONTINUE_BLOCK}`
    if (!isWorker && task.continuesFrom) {
      prompt = `${prompt}\n\n${HANDOFF_RECEIVE_CUE}`
      if (task.manualStartConfirmedAt && Number.isFinite(task.manualStartConfirmedAt)) prompt = `${prompt}\n\n${HANDOFF_START_CONFIRMED_CUE}`
    }
    // 领队会话武装流式派单嗅探：闭合一个 <delegate> 即提前建单（回灌仍只在回合末）
    const isLeader = !!me?.subordinates?.length && task.backend !== 'dsh' && !(task.suppressIssue && task.parentTaskId)
    if (isLeader) this.armDelegateSniffer(taskId)

    // 看门狗在 backend.start 之前武装：握手/建会话阶段挂死同样按空转判败并可硬杀，
    // 不再永久卡住 running 状态与并发槽；启动期间的线级心跳照常续命
    const sentinel = this.idleSentinel(taskId)
    try {
      // 标题回合的事件不进对话流（text/final/usage 静默），onTurnEnd 照常驱动 sendTurn。
      // 会话级通道 + 首回合身份：回调只在身份对得上时才会被投递。
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
          && this.lifecycle(taskId).accepts(firstTurn.token)
      )
      // The durable session binding is the commit point. Only a session whose
      // conditional write succeeded may be installed in memory: a start whose
      // Run was replaced while it was pending is closed as-is and never keeps
      // the scheduler slot waiting for its turn.
      let bound: Task | undefined
      try {
        bound = this.store.updateIf(taskId, runCondition(claim), session.sessionId ? { sessionId: session.sessionId } : {})
      } catch (error) {
        await this.closeLateSession(session)
        throw error
      }
      if (!bound) {
        await this.closeLateSession(session)
        if (!this.isCurrentRun(claim)) return
        throw new Error('会话绑定失败：执行归属已变化')
      }
      this.lifecycle(taskId).gate.setSessionOwner(session.sessionId)
      void this.lifecycle(taskId).attachSession({ generation: runGen, sessionOwner: session.sessionId }, session)
      // 适配器声明了回合身份才允许在同一连接上继续跑回合；否则连接一旦失去
      // 归属确定性（有回合没收终态就被放弃）就必须重建。
      router.legacy = session.turnScoped !== true
      router.owner = session.sessionId
      this.sessionTurns.set(session, router)
      this.sessions.set(taskId, session)
      this.sessionWorkdirs.set(taskId, task.workdir)
      this.pushTask(taskId)

      // 首回合由同一哨兵继续护送：长时间无任何进展先停回合再判失败，不再无限等待
      let r: BackendTurnResult
      try {
        r = await Promise.race([firstTurnPromise, sentinel.timeout])
      } finally {
        sentinel.cancel()
      }
      if (!this.isCurrentRun(claim)) return
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
    } catch (e) {
      if (!this.isCurrentRun(claim)) return
      const msg = e instanceof Error ? e.message : String(e)
      await this.closeSession(taskId, runIdentity(claim))
      if (this.failTask(taskId, msg, claim)) {
        this.maybeAutoRetry(taskId, claim)
        this.notifyFailure(taskId, task, msg)
      }
    } finally {
      sentinel.cancel()
      this.store.flushEvents(taskId)
      if (this.store.matches(taskId, runIdentity(claim))) {
        this.launchHandles.delete(taskId)
        // Session-level seenKeys are intentionally retained for follow-up turns.
        this.lastTerminalResponses.delete(taskId)
      }
      this.pushTask(taskId)
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
      this.retryTimers.delete(taskId)
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
      if (claim) this.claims.delete(taskId)
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
      this.clearRetry(taskId)
      const full = this.store.appendEvent(taskId, {
        ts: Date.now(),
        kind: 'status',
        text: `⟳ ${failure.title}：退避 ${Math.round(delayMs / 1000)}s 后自动重试 ${next}/2（${fresh ? '新会话' : '续会话'}）${goalBudget}`
      }, failedRun)
      if (full) this.pushEvent(taskId, full)
      this.pushTask(taskId)
      const timer = setTimeout(schedule, delayMs)
      this.retryTimers.set(taskId, timer)
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
  async followUp(taskId: string, content: string, opts?: { relay?: boolean; collectFinal?: boolean; consultDepth?: number; wait?: boolean }): Promise<{ ok: boolean; error?: string; finalText?: string }> {
    const task = this.store.get(taskId)
    if (!task) return { ok: false, error: '任务不存在' }
    const message = content.trim()
    if (!message) return { ok: false, error: '追问不能为空' }
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
    if (!this.sessions.get(taskId) && !task.sessionId) return { ok: false, error: '无会话可恢复' }
    const turnContent = wantsHandoff ? `${HANDOFF_CUE}\n（用户原话：${message}）` : message
    // 领队续聊同样武装流式派单嗅探（追问里派发 → 提前建单）
    const me = (this.getTeam?.() ?? []).find((a) => a.id === task.agentId)
    if (me?.subordinates?.length && task.backend !== 'dsh' && !(task.suppressIssue && task.parentTaskId)) this.armDelegateSniffer(taskId)

    const runId = this.newRunId(taskId)
    const beginRun = (): RunClaim | null => {
      this.toolWindows.delete(taskId)
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
      this.claims.set(taskId, claim)
      this.recordUser(taskId, message, runCondition(claim))
      this.pushTask(taskId)
      return claim
    }

    // A dead live session may fall through to resume. Both paths belong to
    // this one follow-up Run, so initialize its identity exactly once.
    const claim = beginRun()
    if (!claim) return { ok: false, error: '任务已开始新的执行，本次追问未生效' }

    // UI 追问传 wait:false：回合在后台跑、IPC 在 beginRun 后即返回——渲染层 busy 不
    // 锁整轮，否则「停止」会禁用到回合结束。默认（goal/meeting/sidecar 等自动化
    // 调用方）仍等整轮结束以拿 finalText。
    const runTurn = async (): Promise<{ ok: boolean; error?: string; finalText?: string }> => {
      // 1) 内存会话健在：直接续聊
      let liveSession = this.sessions.get(taskId)
      // M2 会话绑定工作目录：内存会话跑在安装时的 cwd 上。集成后续链换基线
      // （task.workdir 指向集成分支的托管 worktree）后，直续会把追问跑回旧目录、
      // 拿旧基线重复劳动——强制丢弃内存会话走 resume 重建（新连接以新 workdir 启动，
      // 会话内容经 sessionId 恢复；detach 保证 provider 会话不被销毁）。
      const liveWorkdir = this.sessionWorkdirs.get(taskId)
      if (liveSession && task.workdir && liveWorkdir && path.resolve(liveWorkdir) !== path.resolve(task.workdir)) {
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
          const r = await this.sendTurn(taskId, liveSession, turnContent, claim)
          if (!this.isCurrentRun(claim)) return { ok: false, error: '回合已失效' }
          if (!r.ok) throw new Error(r.error || '续聊回合失败')
          const finalText = await this.completeTurn(taskId, liveSession, r, claim, opts?.consultDepth ?? 0)
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
      // 续聊沿用 agent 钉死的模型（zcode resume 后用 session/setModel 补设；CLI --model 与 --resume 正交）
      let resumeSession: BackendSession
      // 看门狗在 backend.start 之前武装：resume 重建阶段挂死同样按空转判败，
      // 不永久挂住 running 状态（此前只能重启应用）
      const sentinel = this.idleSentinel(taskId)
      let unregisterResume: () => void = () => {}
      try {
        const gen = this.bumpTurnGen(taskId)
        const life = this.lifecycle(taskId)
        // 重建连接是独立会话：自己的通道、自己的回合身份，不与旧连接共享任何状态
        const router = new SessionTurnRouter()
        const channel = this.sessionChannel(router)
        const turnRecord = this.openTurn(taskId, router, claim, gen, undefined)
        const turn = new Promise<BackendTurnResult>((resolve) => {
          unregisterResume = life.registerResume(turnRecord.token, (v) => resolve(v as BackendTurnResult))
        })
        resumeSession = await this.executor.start(
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
            && this.lifecycle(taskId).accepts(turnRecord.token)
        )
        // Bind the resumed session to this Run before installing anything in
        // memory; a failed binding closes the exact session and writes no map.
        let bound: Task | undefined
        try {
          bound = this.store.updateIf(taskId, runCondition(claim), resumeSession.sessionId ? { sessionId: resumeSession.sessionId } : {})
        } catch (error) {
          await this.closeLateSession(resumeSession)
          throw error
        }
        if (!bound) {
          await this.closeLateSession(resumeSession)
          if (!this.isCurrentRun(claim)) return { ok: false, error: '回合已失效' }
          throw new Error('会话绑定失败：执行归属已变化')
        }
        this.lifecycle(taskId).gate.setSessionOwner(resumeSession.sessionId)
        void this.lifecycle(taskId).attachSession({ generation: gen, sessionOwner: resumeSession.sessionId }, resumeSession)
        router.legacy = resumeSession.turnScoped !== true
        router.owner = resumeSession.sessionId
        this.sessionTurns.set(resumeSession, router)
        this.sessions.set(taskId, resumeSession)
        this.sessionWorkdirs.set(taskId, task.workdir)
        this.pushTask(taskId)
        try {
          const r = await Promise.race([turn, sentinel.timeout])
          sentinel.cancel()
          if (!this.isCurrentRun(claim)) return { ok: false, error: '回合已失效' }
          if (!r?.ok) throw new Error(r?.error || '续聊回合失败')
          const finalText = await this.completeTurn(taskId, resumeSession, r, claim, opts?.consultDepth ?? 0)
          if (!this.store.matches(taskId, runIdentity(claim, { status: 'done' }))) return { ok: false, error: '回合已失效' }
          if (this.opts().notify) this.notify(task, '完成', finalText)
          return opts?.collectFinal ? { ok: true, finalText } : { ok: true }
        } finally {
          sentinel.cancel()
          if (life.generation === gen) unregisterResume()
        }
      } catch (e) {
        unregisterResume()
        const msg = e instanceof Error ? e.message : String(e)
        this.failTask(taskId, msg, claim)
        this.pushTask(taskId)
        return { ok: false, error: msg }
      } finally {
        sentinel.cancel()
      }
    }

    if (opts?.wait === false) {
      // 后台回合自身失败已走 failTask→pushTask 广播显错；这里只兜意外抛出，防静默挂 running
      void runTurn().catch((e) => {
        const msg = e instanceof Error ? e.message : String(e)
        this.failTask(taskId, msg, claim)
        this.pushTask(taskId)
      })
      return { ok: true }
    }
    return runTurn()
  }

  async cancel(taskId: string): Promise<{ ok: boolean; error?: string }> {
    const task = this.store.get(taskId)
    if (!task) return { ok: false, error: '任务不存在' }
    // Cancel the execution this call observed. The condition is captured before
    // any teardown, so a Run that replaced the observed one keeps running.
    const observed: TaskExpectation = { status: task.status, runId: task.runId, executionOwner: task.executionOwner }
    const cancelObserved = () => this.store.updateIf(taskId, observed, { status: 'cancelled', endedAt: Date.now() })
    const retryPending = this.retryTimers.has(taskId)
    if (task.status === 'failed' && retryPending) {
      if (!cancelObserved()) return { ok: false, error: '任务状态已变化，取消未生效' }
      this.clearRetry(taskId)
      this.bumpTurnGen(taskId)
      this.claims.delete(taskId)
      this.lifecycle(taskId).dispose()
      this.pushTask(taskId)
      this.store.flushEvents(taskId)
      return { ok: true }
    }
    if (task.status === 'queued') {
      if (!cancelObserved()) return { ok: false, error: '任务状态已变化，取消未生效' }
      this.clearRetry(taskId)
      this.bumpTurnGen(taskId)
      this.claims.delete(taskId)
      this.lifecycle(taskId).dispose()
      this.pushTask(taskId)
      return { ok: true }
    }
    if (task.status !== 'running') return { ok: false, error: '任务不在运行中' }
    // The Run claim is still valid here, so buffered provider data can be
    // committed before cancellation rejects late callbacks.
    if (!await this.closeEventBatches(taskId)) {
      return { ok: false, error: '事件持久化尚未完成，任务仍保持运行状态' }
    }
    const session = this.sessions.get(taskId)
    const launchHandle = this.launchHandles.get(taskId)
    const claim = this.claims.get(taskId)
    if (!claim || !this.isCurrentRun(claim)) return { ok: false, error: '执行归属不在当前运行器，未取消任务' }
    const cancelled = this.store.updateIf(taskId, runCondition(claim), { status: 'cancelled', endedAt: Date.now() })
    if (!cancelled) return { ok: false, error: '任务状态已变化，取消未生效' }
    this.clearRetry(taskId)
    this.claims.delete(taskId)
    // Resolve start/send races immediately. Waiting for the idle timeout would
    // keep a scheduler slot occupied after cancellation.
    this.turnWatchdogs.get(taskId)?.expire()
    // 级联取消子任务（领队被取消时，运行中/排队的子任务一并停）
    for (const child of this.store.list().filter((t) => t.parentTaskId === taskId && (t.status === 'running' || t.status === 'queued'))) {
      void this.cancel(child.id)
    }
    // Detach the cancelled Run before awaiting provider cleanup: a retry may
    // already be using this taskId when stop/close eventually settles.
    this.launchHandles.delete(taskId)
    this.sessions.delete(taskId)
    this.sessionWorkdirs.delete(taskId)
    if (session) this.retireSession(session)
    this.permissionBroker.cancelTask(taskId)
    this.toolWindows.delete(taskId)
    this.disarmWatchdog(taskId)
    this.earlySpawns.delete(taskId)
    this.delegateRejections.delete(taskId)
    this.lifecycle(taskId).dispose()
    this.lastTerminalResponses.delete(taskId)
    this.pushTask(taskId)
    if (!session) {
      try { await this.awaitCleanup(() => launchHandle?.stop()) } catch {}
    }
    await this.awaitCleanup(() => session?.stop())
    await this.awaitCleanup(() => session?.close())
    this.store.flushEvents(taskId)
    return { ok: true }
  }

  /** 空闲判定（热更 L1 apply 门控，设计 §7.4）：无在跑会话、无启动竞态句柄、store 无 running 任务。 */
  isIdle(): boolean {
    return this.sessions.size === 0 && this.launchHandles.size === 0 && this.eventBatchers.size === 0
      && this.store.list().every((task) => task.status !== 'running')
  }

  async shutdown() {
    // Drain accepted events while current Run claims are still valid, then
    // stop accepting provider callbacks before lifecycle invalidation.
    await this.awaitCleanup(() => this.closeEventBatches(), 2_000)
    this.disposeEventBatches()
    // First invalidate callbacks and stop owned sessions, then wait for any
    // Executor start races that resolve late and still need closing.
    for (const timer of this.retryTimers.values()) clearTimeout(timer)
    this.retryTimers.clear()
    for (const [taskId, handle] of this.launchHandles) {
      this.bumpTurnGen(taskId)
      if (!this.sessions.has(taskId)) {
        await this.awaitCleanup(() => handle.stop())
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
      this.retireSession(s, 'replaced')
      await this.awaitCleanup(() => s.stop())
      await this.awaitCleanup(() => s.close())
    }
    this.sessions.clear()
    // 会话清空必须连带清目录绑定：sessionWorkdirs 的键值只在随会话安装/关闭时增删，
    // 留着旧 taskId→workdir 就是悬空脏数据，下个生命周期读到的是上个生命周期的 cwd
    this.sessionWorkdirs.clear()
    this.claims.clear()
    this.earlySpawns.clear()
    this.delegateRejections.clear()
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
