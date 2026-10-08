// 回合身份原语：RunClaim / runCondition / runIdentity / TurnRecord 与两个冻结文案常量。
// 自 runner.ts 原样搬迁（批次 1，零行为变化）；冻结面经 runner.ts re-export 保持可得。
import type { ExecutionOwner } from '../../shared/types'
import type { TaskExpectation } from '../store'
import type { BackendSessionEvents, BackendTurnStamp } from '../backends/types'
import type { EventGateToken } from '../turn-lifecycle'

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
  /** 回合没等到终态就被撤销（被后继回合顶掉/连接退役/显式放弃）时，等待方经此立即落败，
   *  不必各自等到预算兜底；可选——常规回合由看门狗与一次性 waiter 护送，无需此钩子。 */
  readonly onRevoked?: () => void
}

/** Reported when a session cannot prove which turn a callback belongs to. */
export const TURN_ISOLATION_REQUIRED = 'session-turn-identity-unavailable'

/**
 * 追问重建路径的诚实降级：后端不支持跨进程恢复（supportsResume=false）而旧会话已退役时，
 * 回合按失败收场并给出可行动出口——绝不静默开新会话冒充恢复成功。
 */
export const RESUME_UNSUPPORTED_MESSAGE = '该会话已退役且此后端不支持跨进程恢复，可基于报告全文/Issue 评论重新派单带上下文'

export type { RunClaim, TurnRecord }
export { runCondition, runIdentity }
