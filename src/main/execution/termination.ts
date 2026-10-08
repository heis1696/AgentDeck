// 终止协调（批次 5）：严格终止的全量编排与三组终止态的唯一所有者——terminating（并发
// 去重）、terminationTargets（捕获身份）、retiredProviderSessions（平台会话退役台账）。
// 设计与迁移归属见 docs/plan/runner-decomposition.md §5.1/§6.5；TaskRunner 保留签名冻结
// 的 terminateTask 公共门面，经窄端口注入内核原语与 runner 编排回调，绝不反向依赖
// runner（§5.2）。时序不变量随迁：I1.2（lastClaim 归属校验）、I6.3（终止清扫位的权限/doom
// 成对半部经 sweep→purgeTaskWorkflowState 端口回路保持）、I7.1–I7.4（结算即摘、problems
// 不中断、terminatedRunId 唯一退出证明、捕获身份校验）。
import type { ExecutionOwner, Task } from '../../shared/types'
import { sameExecutionOwner, type TaskExpectation } from '../store'
import { processOwnerState } from '../persistence'
import type { BackendSession } from '../backends/types'
import { runCondition, type RunClaim } from './identity'
import { awaitExit, checkedCleanup, strictCleanup } from './cleanup'
import type { RetiredSessionEntry, TaskSweepOptions, WorktreeSessionRelease } from './execution-kernel'

/**
 * 终止协调端口：每个端口都是单个动作，不暴露任何 Map（窄端口注入，非「Context 袋」，§4.2）。
 * execution/* → runner.ts 反向 import 严禁；需要回调一律经此注入（§5.2）。
 */
export interface TerminationPorts {
  // 持久层窄探针/条件写
  taskOf(taskId: string): Task | undefined
  matches(taskId: string, expected: TaskExpectation): boolean
  updateIf(taskId: string, expected: TaskExpectation, patch: Partial<Task>): Task | undefined
  /** 同父任务的现存子单快照（终止级联的目标清单） */
  childTasks(parentTaskId: string): Task[]
  // 内核原语（身份/会话/释放台账）
  claimOf(taskId: string): RunClaim | undefined
  isCurrentRun(claim: RunClaim | undefined): claim is RunClaim
  sessionOf(taskId: string): BackendSession | undefined
  workdirOf(taskId: string): string | undefined
  launchHandleOf(taskId: string): { stop: () => void | Promise<unknown> } | undefined
  hasRetryTimer(taskId: string): boolean
  /** 会话路由的最近认领（I1.2 的归属校验依据） */
  lastClaimOf(session: BackendSession): RunClaim | undefined
  dropSessionIfCurrent(taskId: string, session: BackendSession): void
  retireSession(session: BackendSession): void
  sweepTaskExecutionState(taskId: string, o: TaskSweepOptions): void
  trackSessionRelease(session: BackendSession, workdir: string, release: () => Promise<void>): Promise<void>
  hasSessionReleaseClaimedBy(taskId: string, runId: string | undefined, owner: ExecutionOwner | undefined): boolean
  sessionReleasesForTask(taskId: string): Array<[BackendSession, WorktreeSessionRelease]>
  dropSessionRelease(session: BackendSession): void
  // runner 编排回调
  pushTask(taskId: string): void
  drainEvents(taskId: string, timeoutMs?: number): Promise<boolean>
  /** 取消 drain 计数（cancellationDrains 归 runner）：进位 → body → finally 退位 */
  runUnderCancellationDrain<T>(taskId: string, body: () => Promise<T>): Promise<T>
  /** 晚到会话兜底回收（runner：executor.drain） */
  drainLateSessions(key: string): Promise<void>
  /** 终点处理走管线单点（清在途 + 变体钩子 + 流水账） */
  settleTask(taskId: string, outcome: 'done' | 'failed' | 'cancelled', context: { actor: 'runner'; reason: string }): Promise<unknown>
  /** activeRuns/activeTurns 只读快照（所有权留 runner，§5.1）：每次调用现取，不长期持有引用 */
  getActiveExecutions(taskId: string): { run?: Promise<unknown>; turn?: Promise<unknown> }
  /** 终止各步的清理预算（runner：opts().terminationTimeoutMs，各步自带兜底默认值） */
  terminationTimeoutMs(): number | undefined
}

/** 已捕获身份的终止目标：终止全程只对这份快照动手（I7.3） */
interface TerminationTarget {
  task: Task
  session?: BackendSession
  workdir: string
  launch?: { stop: () => void | Promise<unknown> }
  launchCleanup?: Promise<void>
  launchStopped: boolean
  sessionClosed: boolean
  activeRun?: Promise<unknown>
  activeTurn?: Promise<unknown>
}

export class TerminationCoordinator {
  private readonly ports: TerminationPorts
  /** taskId → 在途严格终止：并发 terminateTask 复用同一 promise，结算即摘（I7.1 同型） */
  private terminating = new Map<string, Promise<{ ok: boolean; error?: string; warning?: string }>>()
  /** taskId → 已捕获身份的终止目标：全部确认完成后才摘除（I7.3 的身份锚） */
  private targets = new Map<string, TerminationTarget>()
  /** closeSession detach 保留的平台会话台账（唯一所有者）：只服务 terminateTask 的收尾关闭 */
  readonly retiredSessions = new Map<string, RetiredSessionEntry>()

  constructor(ports: TerminationPorts) {
    this.ports = ports
  }

  /** isIdle 管线源：在途终止目标数。与 targets 的摘除同进同退——真空态必须归零
   *  （smoke-issue-pipeline 的 idle 不变式；sessions/retiredProviderSessions 两次把
   *  看板永久判忙的历史教训见 runner isIdle 注释）。 */
  get targetCount(): number {
    return this.targets.size
  }

  /** closeSession 的平台会话保留候选（内核经 retainRetiredSession 端口上报）：
   *  meetingId 判定与落账都在本单点（批次 2 时曾由 runner 内联，本批收窄归位）。 */
  parkRetiredSession(key: string, entry: RetiredSessionEntry): void {
    if (entry.session.detach && this.ports.taskOf(entry.taskId)?.meetingId) this.retiredSessions.set(key, entry)
  }

  /** forget 的台账半部：任务移除后无人能再触发终止，随行清除防累积。 */
  forgetTask(taskId: string): void {
    for (const [key, entry] of this.retiredSessions) {
      if (entry.taskId === taskId) this.retiredSessions.delete(key)
    }
  }

  /** 终止前的执行态退役：单点 sweep（内核执行态半部；工作流半部经 sweep→
   *  purgeTaskWorkflowState 端口回调 runner 清，I6.3 成对语义保持） */
  private retireExecutionState(taskId: string) {
    this.ports.sweepTaskExecutionState(taskId, {
      watchdog: 'expire', invalidateTurns: true, retry: true, claim: true, launch: true,
      session: 'retireOnly', workflow: { permissions: true, delegationLedger: true },
      terminal: true, lifecycle: 'dispose'
    })
  }

  private async terminateSession(taskId: string, target: TerminationTarget, problems: string[]): Promise<void> {
    if (target.sessionClosed) return
    const session = target.session ?? this.ports.sessionOf(taskId)
    if (!session) return
    const claim = this.ports.lastClaimOf(session)
    if (claim && (claim.runId !== target.task.runId || !sameExecutionOwner(claim.owner, target.task.executionOwner))) {
      problems.push('会话已属于替换执行，未关闭')
      return
    }
    target.session = session
    this.ports.dropSessionIfCurrent(taskId, session)
    this.ports.retireSession(session)
    await strictCleanup(() => this.ports.trackSessionRelease(session, target.workdir, async () => {
      let stopError: unknown
      const stopProblems: string[] = []
      await strictCleanup(() => checkedCleanup(() => session.stop()), '会话中止', stopProblems, this.ports.terminationTimeoutMs() ?? 4_000)
      if (stopProblems.length) stopError = new Error(stopProblems.join('；'))
      await checkedCleanup(() => session.close())
      target.sessionClosed = true
      if (stopError) throw stopError
    }), '会话关闭', problems, this.ports.terminationTimeoutMs() ?? 8_000)
  }

  async terminateTask(taskId: string): Promise<{ ok: boolean; error?: string; warning?: string }> {
    const pending = this.terminating.get(taskId)
    if (pending) return pending
    const task = this.ports.taskOf(taskId)
    if (!task) return { ok: false, error: '任务不存在' }
    const execution = this.terminateTaskExclusive(taskId)
    this.terminating.set(taskId, execution)
    void execution.finally(() => {
      if (this.terminating.get(taskId) === execution) this.terminating.delete(taskId)
    }).catch(() => {})
    return execution
  }

  private async terminateTaskExclusive(taskId: string): Promise<{ ok: boolean; error?: string; warning?: string }> {
    const current = this.ports.taskOf(taskId)
    if (!current) return { ok: false, error: '任务不存在' }
    let target = this.targets.get(taskId)
    if (target && !this.ports.matches(taskId, { runId: target.task.runId, executionOwner: target.task.executionOwner })) {
      return { ok: false, error: '任务已被替换执行接手，旧终止请求未触碰替换执行' }
    }
    const claim = current.status === 'running' ? this.ports.claimOf(taskId) : undefined
    if (current.status === 'running' && (!claim || !this.ports.isCurrentRun(claim))) {
      return { ok: false, error: '执行归属不在当前运行器，终止未生效' }
    }
    const registered = this.ports.claimOf(taskId)
    const knownRelease = this.ports.hasSessionReleaseClaimedBy(taskId, current.runId, current.executionOwner)
    if (!target && current.meetingId && current.runId && current.terminatedRunId !== current.runId
      && processOwnerState(current.executionOwner) !== 'dead'
      && !(registered?.runId === current.runId && sameExecutionOwner(registered.owner, current.executionOwner))
      && !this.ports.sessionOf(taskId) && !this.ports.getActiveExecutions(taskId).run
      && !this.ports.getActiveExecutions(taskId).turn && !knownRelease) {
      // owner 进程已死时不再拒停：没有任何进程能补上退出确认，等下去是永久死锁
      // （会议既停不掉也删不掉）。owner 存活且无凭据时维持拒停——它的关闭流程可能还在途。
      return { ok: false, error: '历史会议执行退出未确认，已保留任务与日志' }
    }
    if (!target) {
      const captured = this.ports.getActiveExecutions(taskId)
      target = {
        task: { ...current }, session: this.ports.sessionOf(taskId),
        workdir: this.ports.workdirOf(taskId) ?? current.workdir,
        launch: this.ports.launchHandleOf(taskId), launchStopped: false, sessionClosed: false,
        activeRun: captured.run, activeTurn: captured.turn
      }
      this.targets.set(taskId, target)
    }
    const task = target.task
    const problems: string[] = []
    const warnings: string[] = []
    if (current.status === 'running' && claim) {
      let replaced: { ok: boolean; error?: string; warning?: string } | undefined
      await this.ports.runUnderCancellationDrain(taskId, async () => {
        if (!await this.ports.drainEvents(taskId)) warnings.push('部分事件日志写入失败，已保存的恢复副本将在重启时回放')
        if (!this.ports.updateIf(taskId, runCondition(claim), { status: 'cancelled', endedAt: Date.now() })) {
          const latest = this.ports.taskOf(taskId)
          if (!latest || latest.status === 'running' || !this.ports.matches(taskId, { runId: task.runId, executionOwner: task.executionOwner })) {
            replaced = { ok: false, error: '任务已被替换执行接手，终止未生效；替换执行未受影响' }
          }
        }
      })
      if (replaced) return replaced
    } else if (current.status === 'queued' || (current.status === 'failed' && this.ports.hasRetryTimer(taskId))) {
      const observed: TaskExpectation = { status: current.status, runId: task.runId, executionOwner: task.executionOwner }
      if (!this.ports.updateIf(taskId, observed, { status: 'cancelled', endedAt: Date.now() })) {
        return { ok: false, error: '任务状态已变化，终止未生效' }
      }
    }
    target.session ??= this.ports.sessionOf(taskId)
    target.launch ??= this.ports.launchHandleOf(taskId)
    this.retireExecutionState(taskId)
    this.ports.pushTask(taskId)
    if (target.launch && !target.launchStopped) {
      const captured = target
      captured.launchCleanup ??= checkedCleanup(() => captured.launch!.stop()).then(() => {
        captured.launchStopped = true
      }, (error) => { captured.launchCleanup = undefined; throw error })
      await strictCleanup(() => captured.launchCleanup, '初始化中止', problems, this.ports.terminationTimeoutMs() ?? 4_000)
    }
    await this.terminateSession(taskId, target, problems)
    for (const child of this.ports.childTasks(taskId)) {
      if (task.meetingId && child.meetingId !== task.meetingId) {
        problems.push(`${child.id}: 后代会议归属不一致，已保留`)
        continue
      }
      const result = await this.terminateTask(child.id)
      if (!result.ok) problems.push(`${child.title || child.id}: ${result.error ?? '终止未确认'}`)
    }
    for (const tracked of [target.activeRun, target.activeTurn]) {
      await awaitExit(tracked, '执行退出确认', problems, this.ports.terminationTimeoutMs() ?? 15_000)
    }
    for (const [session, entry] of this.ports.sessionReleasesForTask(taskId)) {
      if (session === target.session && target.sessionClosed) { this.ports.dropSessionRelease(session); continue }
      await strictCleanup(() => entry.failed ? this.ports.trackSessionRelease(session, entry.workdir, entry.release) : entry.promise,
        '已移除会话退出确认', problems, this.ports.terminationTimeoutMs() ?? 8_000)
    }
    for (const [key, entry] of this.retiredSessions) {
      if (entry.taskId !== taskId) continue
      entry.closing ??= checkedCleanup(() => entry.session.close()).then(() => { entry.closed = true }, (error) => {
        entry.closing = undefined
        throw error
      })
      await strictCleanup(() => entry.closing, '已断开平台会话关闭', problems, this.ports.terminationTimeoutMs() ?? 8_000)
      if (entry.closed && this.retiredSessions.get(key) === entry) this.retiredSessions.delete(key)
    }
    await strictCleanup(() => this.ports.drainLateSessions(`${taskId}:${task.runId}`), '晚到会话回收', problems, this.ports.terminationTimeoutMs() ?? 5_000)
    if (problems.length) return { ok: false, error: problems.join('；') }
    if (!this.ports.updateIf(taskId, { runId: task.runId, executionOwner: task.executionOwner }, { terminatedRunId: task.runId })) {
      return { ok: false, error: '退出确认时任务已被替换，未清除诊断记录' }
    }
    if (target.session && target.sessionClosed) this.ports.dropSessionRelease(target.session)
    if (this.targets.get(taskId) === target) this.targets.delete(taskId)
    // 终点处理走管线单点：终止验证完成后的收尾（清在途 + 变体钩子 + 流水账）。
    // 任务若本就终态（done 后补停），settle 幂等只补记账，不改写结果。
    {
      const settled = this.ports.taskOf(taskId)
      const outcome = settled?.status === 'done' || settled?.status === 'failed' ? settled.status : 'cancelled'
      await this.ports.settleTask(taskId, outcome, { actor: 'runner', reason: 'termination verified' })
    }
    if (warnings.length) return { ok: true, warning: warnings.join('；') }
    return { ok: true }
  }
}
