// 回合事件工厂（批次 3b）：原 TaskRunner.makeTurnEvents 整函数外移（runner.ts 逐行搬移，
// 零行为变化），依赖全部经窄端口注入（docs/plan/runner-decomposition.md §5.1/§6.3 3b）。
// 工厂闭包持有单回合态（eventSequence/terminalStarted/persistenceProblem/ownershipCheckedAt），
// 只读本回合的不可变身份（claim / generation / token）。execution/* → runner.ts 反向
// import 严禁（§5.2）；store/kernel/pump 的访问全部收口在 TurnEventsPorts 的单个动作里，
// 不持有 TaskStore 引用、不暴露任何 Map（窄端口注入，非「Context 袋」）。
//
// 本模块承载的时序不变量（§2 组2，回归锚点见 smoke-event-pipeline / smoke-lifecycle /
// smoke-turn-identity / smoke-retitle-cap / smoke-turn-lifecycle）：
// - I2.1 终态四步：持久提交 → 门禁收口（closeTurn）→ 投递 → waiter 完成（锚点注释见
//   工厂内 onTurnEnd，施工禁止重排）；
// - I2.2 取消路径的 drain 期间失败改走 abandonTurn（isCancelling 探针）；
// - I2.3 关机路径不把溢出改写为具名失败（isShuttingDown 探针）；
// - I2.4 flush 失败分支与终态同构：同一条 closeTurn → onTurnEnd → resolveResume 链；
// - I2.5 接受即恢复边界：STAGED_BATCH_ID_PREFIX 暂存批身份，合并判定放行暂存身份。
import type { Task, TaskEvent } from '../../shared/types'
import type { TaskExpectation } from '../store'
import type { BackendSessionEvents, BackendTurnResult, BackendTurnStamp, PermissionRequest } from '../backends/types'
import type { EventGateToken, TurnLifecycle } from '../turn-lifecycle'
import { BoundedEventBatcher } from '../event-batcher'
import { runCondition, type RunClaim } from './identity'
import type { SessionTurnRouter } from './session-turn-router'
import type { TurnEventsRequest } from './execution-kernel'

export type RunnerEvent = Omit<TaskEvent, 'seq'>

const STREAM_DELTA_TYPES = new Set(['text.delta', 'reasoning.delta', 'tool.input.delta', 'compaction.delta'])

function isStreamDeltaEvent(event: RunnerEvent): boolean {
  return event.kind === 'text' && (!event.type || event.type.endsWith('.delta') || STREAM_DELTA_TYPES.has(event.type))
}

function hasStableEventIdentity(event: RunnerEvent): boolean {
  return (typeof event.eventId === 'string' && event.eventId.length > 0)
    || (typeof event.id === 'string' && event.id.length > 0)
}

/** 接受即恢复边界（onPending 正常路径）给无身份事件暂存的批身份前缀：崩溃重放/
 * 重试幂等用它当稳定身份，但它不算「提供方身份」——合并判定必须放行，否则每个
 * delta 在接受时被派 id 后即终结合并链（IPC 每 token 一包）。 */
const STAGED_BATCH_ID_PREFIX = 'agentdeck:batch:'

function hasStagedBatchIdentity(event: RunnerEvent): boolean {
  return typeof event.eventId === 'string' && event.eventId.startsWith(STAGED_BATCH_ID_PREFIX)
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
 * 回合事件工厂端口（§6.3 3b 端口清单）：每个端口都是单个动作，不暴露任何 Map。
 * 命名对应：store 的 stagePendingEvents/appendEvents/clearPendingEvents；kernel 的
 * isCurrentRun/lifecycle/touchWatchdog（外加 claimOf/lastTerminalResponse/
 * rememberTerminalResponse 三个回合工厂实际触达的内核原语）；runner 的
 * sniffDelegates/observeToolCall/pushEvent（外加 onTaskEvent/pushTask/askPermission
 * 与 taskOf/updateIf 两个 onSessionId 绑定必需的 store 探针）；isCancelling(taskId)/
 * isShuttingDown() 只读探针；批次 3a EventPump 的登记窄面 register/revoke。
 */
export interface TurnEventsPorts {
  // ── store 持久化写路径（事件日志与恢复副本双写的全部入口）
  stagePendingEvents(taskId: string, turnId: string, runId: string, events: readonly RunnerEvent[], expected: TaskExpectation, openedAt: number): boolean
  appendEvents(taskId: string, events: readonly RunnerEvent[], expected: TaskExpectation): TaskEvent[]
  clearPendingEvents(taskId: string, turnId: string): void
  // store 只读探针（meetingExecution 标记 / onSessionId 的 sessionId 短路）与条件写
  // （resume 身份绑定：迟到回调不得改指更新的 Run）
  taskOf(taskId: string): Task | undefined
  updateIf(taskId: string, expected: TaskExpectation, patch: Partial<Task>): Task | undefined
  // ── kernel 原语（回合门禁与看门狗）
  lifecycle(taskId: string): TurnLifecycle
  isCurrentRun(claim: RunClaim | undefined): boolean
  claimOf(taskId: string): RunClaim | undefined
  touchWatchdog(taskId: string): void
  lastTerminalResponse(taskId: string): string | undefined
  rememberTerminalResponse(taskId: string, response: string): void
  // ── runner 编排回调（业务裁决留在 runner，经端口回调）
  sniffDelegates(taskId: string, delta?: string): void
  observeToolCall(taskId: string, event: RunnerEvent, claim: RunClaim): void
  pushEvent(taskId: string, e: TaskEvent): void
  onTaskEvent?(taskId: string, event: RunnerEvent): void
  pushTask(taskId: string): void
  askPermission(taskId: string, req: PermissionRequest): Promise<{ optionId?: string; decision: 'allow' | 'deny' }>
  // ── 只读探针（取消/关机编排态，runner 持有；I2.2/I2.3 分支的裁决输入）
  isCancelling(taskId: string): boolean
  isShuttingDown(): boolean
  // ── 事件批登记（批次 3a EventPump 的窄面：回合工厂只登记/摘除自己的批）
  register(batcher: BoundedEventBatcher<RunnerEvent>, taskId: string): void
  /** 作废单批：dispose + 摘台账（批溢出 / 终态未获接受的单批收口） */
  revoke(batcher: BoundedEventBatcher<RunnerEvent>): void
  /** 仅摘台账登记（批已 close 提交成功或已在失败分支 dispose），不重复 dispose */
  forget(batcher: BoundedEventBatcher<RunnerEvent>): void
}

/**
 * 事件管道：落盘 + 推 UI；onTurnEnd 可挂回调。
 *
 * 闭包只读本回合的不可变身份（claim / generation / token），运行器任何时刻都不再
 * 改写它——给旧回调"重新授权"的唯一途径因此消失。
 */
export function createTurnEvents(deps: TurnEventsPorts): (req: TurnEventsRequest) => BackendSessionEvents {
  return ({ taskId, router, claim, token, stamp, onTurnEnd }: TurnEventsRequest): BackendSessionEvents => {
    const life = deps.lifecycle(taskId)
    const active = (kind?: string, terminal = false) => {
      if (deps.claimOf(taskId) !== claim) return false
      return life.accepts(token, { kind, terminal })
    }
    let ownershipCheckedAt = 0
    let ownershipValid = true
    const durableActive = (kind?: string, terminal = false, throttleMs = 0) => {
      if (!active(kind, terminal)) return false
      const now = Date.now()
      if (throttleMs > 0 && now - ownershipCheckedAt < throttleMs) return ownershipValid
      ownershipCheckedAt = now
      ownershipValid = deps.isCurrentRun(claim)
      if (ownershipValid) life.setStatus('running')
      return ownershipValid && life.accepts(token, { kind, terminal })
    }
    let eventSequence = 0
    let terminalStarted = false
    let persistenceProblem = ''
    const turnOpenedAt = Date.now()
    const meetingExecution = deps.taskOf(taskId)?.meetingId ? { runId: claim.runId, turnId: stamp.id } : undefined
    const stagePending = (events: readonly RunnerEvent[]) => {
      for (const event of events) {
        if (!hasStableEventIdentity(event)) event.eventId = `${STAGED_BATCH_ID_PREFIX}${stamp.id}:${++eventSequence}`
      }
      try {
        if (deps.stagePendingEvents(taskId, stamp.id, claim.runId, events, runCondition(claim), turnOpenedAt)) return true
      } catch (error) {
        console.error('[TaskRunner] Pending event backup failed', taskId, error)
      }
      if (!persistenceProblem.includes('日志与恢复副本均写入失败')) persistenceProblem = '事件恢复副本无法写入；本轮记录可能不完整'
      return false
    }
    let batcher!: BoundedEventBatcher<RunnerEvent>
    batcher = new BoundedEventBatcher<RunnerEvent>({
      // Ten UI updates per second remain visually responsive while keeping
      // synchronous durable commits off the per-token cadence.
      maxDelayMs: 100,
      maxRetryDelayMs: 5_000,
      maxItems: 64,
      maxBytes: 128 * 1024,
      maxPendingBytes: 1024 * 1024,
      onPending: stagePending,
      sizeOf: eventSize,
      // 接受即恢复边界会给合并组领导暂存批身份（接受时同步写恢复副本需要稳定身份，
      // 崩溃重放与重试幂等都靠它）——这类暂存身份不算稳定身份：合并链照常延续，
      // 否则每个 delta 都因领导带 id 被拆成独立事件，IPC/UI 每 token 一包。
      canMerge: (previous, next) => isStreamDeltaEvent(previous)
        && isStreamDeltaEvent(next)
        && (!hasStableEventIdentity(previous) || hasStagedBatchIdentity(previous))
        && !hasStableEventIdentity(next)
        && streamType(previous) === streamType(next)
        && streamPersistence(previous) === streamPersistence(next),
      merge: mergeStreamEvents,
      onFlush: (events) => {
        // Local lifecycle checks stay memory-only on the per-delta hot path.
        // The conditional batch append below is the durable ownership gate.
        if (!events.length) return true
        if (!active(events[0].kind)) return true
        const protectedEvents = stagePending(events)
        let full: TaskEvent[]
        try {
          full = deps.appendEvents(taskId, events, runCondition(claim))
        } catch (error) {
          persistenceProblem = protectedEvents ? '事件日志写入失败，事件已保存在本地恢复副本' : '事件日志与恢复副本均写入失败，本轮记录可能丢失'
          console.error('[TaskRunner] Event log write failed', taskId, error)
          return false
        }
        if (full.length !== events.length) {
          // A replaced Run must discard its stale batch. A still-current Run
          // retains the same identified events and retries with backoff.
          if (!durableActive(events[0].kind)) return true
          persistenceProblem = protectedEvents ? '事件日志未完整写入，事件已保存在本地恢复副本' : '事件日志与恢复副本均写入失败，本轮记录可能丢失'
          return false
        }
        persistenceProblem = ''
        try { deps.clearPendingEvents(taskId, stamp.id) }
        catch (error) { console.error('[TaskRunner] Pending event cleanup failed', taskId, error) }
        ownershipCheckedAt = Date.now()
        ownershipValid = true
        for (let index = 0; index < events.length; index++) {
          const event = events[index]
          if (!active(event.kind)) continue
          try {
            deps.touchWatchdog(taskId)
            if (event.kind === 'text') deps.sniffDelegates(taskId, event.text)
            if (event.kind === 'tool') deps.observeToolCall(taskId, event, claim)
            deps.onTaskEvent?.(taskId, event)
            deps.pushEvent(taskId, full[index])
          } catch (error) {
            // The batch is already durable. Do not retry it after a host/UI
            // callback failure, or the same events could be appended twice.
            console.error('[TaskRunner] Event delivery failed after commit', error)
          }
        }
        return true
      }
    })
    deps.register(batcher, taskId)
    return {
      onEvent: (incoming: RunnerEvent) => {
        // Legacy zcode, dsh ACP, and OpenCode CLI fallback text events are
        // durable by contract. Explicit provider live markers stay live, but
        // ordinary text is merged without changing its persistence semantics.
        let e = { ...incoming, ...(meetingExecution ? { execution: meetingExecution } : {}) }
        if (!active(e.kind)) {
          // 标题回合的普通事件被静默，但线级进展照样给看门狗续命
          if (life.gate.state.titleMode && life.accepts(token)) deps.touchWatchdog(taskId)
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
        if (!batcher.add(e) && !deps.isShuttingDown() && !terminalStarted && durableActive(e.kind)) {
          terminalStarted = true
          deps.revoke(batcher)
          const failure: BackendTurnResult = { ok: false, response: '', error: persistenceProblem || '事件恢复副本写入失败或待写事件超过上限' }
          router.closeTurn(stamp.id)
          onTurnEnd?.(failure)
          life.resolveResume(token, failure)
        }
      },
      onHeartbeat: () => { if (durableActive(undefined, false, 1_000)) deps.touchWatchdog(taskId) },
      onTurnEnd: (r: BackendTurnResult) => {
        if (terminalStarted) return
        const response = typeof r.response === 'string' ? r.response.trim() : ''
        if (life.gate.state.titleMode && deps.lastTerminalResponse(taskId) === response) return
        terminalStarted = true
        if (!durableActive('final', true)) {
          deps.revoke(batcher)
          // 终态没被接受（运行器已换代/任务已终态）：本回合就此作废，回调不再可投递
          router.abandonTurn(stamp.id)
          return
        }
        // ── I2.1 终态四步（注释锚点，施工禁止重排）────────────────────────
        // ① 持久提交：batcher.close 等待已接受事件全部落盘（未提交分支与终态同构，I2.4）
        // ② 门禁收口：重复终态先按内容去重，再 router.closeTurn——先收口本回合再投递
        // ③ 投递：onTurnEnd 回调（投递可能同步开启下一回合：标题/回灌）
        // ④ waiter 完成：life.resolveResume（TurnLifecycle 持一次性 waiter 与换代核对）
        void batcher.close(5_000).then((committed) => {
          // 批已 close（提交完成或失败已 dispose）：此处只摘台账登记，不重复 dispose——对齐 3a 的 forget 语义
          deps.forget(batcher)
          if (!committed) {
            batcher.dispose()
            if (!deps.isShuttingDown() && !deps.isCancelling(taskId) && durableActive('final', true)) {
              const failure: BackendTurnResult = { ok: false, response: '', error: persistenceProblem || '事件日志未能写入，待本地恢复' }
              router.closeTurn(stamp.id)
              onTurnEnd?.(failure)
              life.resolveResume(token, failure)
            } else router.abandonTurn(stamp.id)
            return
          }
          if (!durableActive('final', true)) {
            router.abandonTurn(stamp.id)
            return
          }
          // 同一回合的重复终态按内容去重（标题回合不可被复述的旧终态顶掉）。回合保持
          // 开启，真正属于它的终态仍能落地。回合身份明确的适配器不需要这条，退回复用
          // 连接的老后端仍然依赖它。
          deps.rememberTerminalResponse(taskId, response)
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
        const task = deps.taskOf(taskId)
        if (!task || task.sessionId === sessionId) return
        // A resume id belongs to one Run. Binding it conditionally keeps a
        // delayed session callback from repointing a newer Run.
        if (!deps.updateIf(taskId, runCondition(claim), { sessionId })) return
        life.gate.setSessionOwner(sessionId)
        deps.pushTask(taskId)
      },
      onPermission: (req: PermissionRequest) => durableActive()
        ? deps.askPermission(taskId, req)
        : Promise.resolve({ decision: 'deny' as const })
    }
  }
}
