// 委派台账（批次 4a）：流式提前建单的嗅探/去重态、被拒派单双层账的内存半部、同键建单
// 互斥与 worker 编号预留的唯一所有者。
// 设计与迁移归属见 docs/plan/runner-decomposition.md §5.1/§6.4；TaskRunner 保留编排与九个
// smoke 直连的签名冻结门面，经窄端口回调业务侧（store 探针读写、note、建单、撤单），
// 绝不反向依赖 runner（§5.2）。持久层（Task.delegateRejections / delegateDeliveredAt /
// dedupeKey）仍是 store 的——双层账结构（I5.1）不得合并成单层。
import type { Task } from '../../shared/types'
import type { TaskExpectation } from '../store'
import { parseDelegates, DELEGATE_REJECT_EXCERPT_MARK, type DelegateCall } from '../delegate'
import type { RunClaim } from './identity'

/**
 * 委派台账端口：每个端口都是单个动作，不暴露任何 Map（窄端口注入，非「Context 袋」，§4.2）。
 * execution/* → runner.ts 反向 import 严禁；需要回调一律经此注入（§5.2）。
 */
export interface DelegateLedgerPorts {
  /** 持久层只读探针：双层账的持久半部（Task.delegateRejections）与撤子单/回执确认前的子单快照 */
  taskOf(taskId: string): Task | undefined
  /** 持久层条件写（身份核对失败即落空）：具名拒单落库与回执确认都走它 */
  updateIf(taskId: string, expected: TaskExpectation, patch: Partial<Task>): Task | undefined
  /** 当前运行认领（陈旧委派循环不得偷走替换运行的内存态） */
  claimOf(taskId: string): RunClaim | undefined
  /** 时间线留痕（runner：note——状态事件落盘 + 推 UI） */
  note(taskId: string, text: string): void
  /** 失败回合撤销提前接单的子单（runner：cancel） */
  cancelTask(taskId: string): void
  /** 建单后的看板推送（runner：pushTask） */
  pushTask(taskId: string): void
  /** 流式提前建单（runner：spawnDelegateChild——护栏与互斥键仍在 runner 编排层，批次 4b 外移） */
  spawnDelegateChild(taskId: string, call: DelegateCall): Promise<Task | null>
  /** 同父任务的现存子单快照（reserveWorkerIndex 的编号下限来源） */
  listChildTasks(parentTaskId: string): Task[]
}

export class DelegateLedger {
  private readonly ports: DelegateLedgerPorts
  /** 同键并发建单互斥（dedupeKey → 在途执行）：既有去重是「落盘后查册」，两条并发
   *  调用在双方都未落盘时互相看不见，各自 reserveWorkerIndex 建子单建树。进程内
   *  竞态用内存互斥关掉；跨进程仍由 store 层 dedupeKey 落盘约束兜底。执行完成后
   *  登记即撤，后续调用走既有落盘查册短路。 */
  private spawnCreatesInFlight = new Map<string, Promise<Task | null>>()
  /** 流式派单嗅探：领队会话期间逐条 text 事件累计扫描，闭合一个 <delegate> 即提前建单入队。
   *  回灌仍只在回合末（委派循环）发生，不会打断领队正在进行的主运行。 */
  private earlySpawns = new Map<string, { buffer: string; scanOffset: number; closeScanOffset: number; spawned: Map<string, { call: DelegateCall; childId: string }>; seenKeys: Set<string>; pending: Promise<unknown>[]; suspended: boolean }>()
  /** 被拒派单的原因（按任务累积）：委派循环每轮取走并回灌给领队，让它当场改派而不是干等不存在的回灌 */
  private delegateRejections = new Map<string, Array<{ runId?: string; reason: string; key?: string }>>()
  private workerIndexReservations = new Map<string, number>()

  constructor(ports: DelegateLedgerPorts) {
    this.ports = ports
  }

  /** 工作流态清扫（purgeTaskWorkflowState 的委派半部，批次 4a 随迁）：earlySpawns /
   *  delegateRejections / workerIndexReservations 三项删除原样搬入；permissions 半部
   *  仍归 runner 单点。scope 显式列出本次要清的半部，五个清扫位各自原语义逐位保持。 */
  purge(taskId: string, scope: { delegationLedger?: boolean; workerIndex?: boolean }) {
    if (scope.delegationLedger) {
      this.earlySpawns.delete(taskId)
      this.delegateRejections.delete(taskId)
    }
    if (scope.workerIndex) this.workerIndexReservations.delete(taskId)
  }

  /** 武装流式派单嗅探（领队会话开始时调用；armed 才会在 text 事件上扫描 delegate 标记） */
  armDelegateSniffer(taskId: string) {
    const existing = this.earlySpawns.get(taskId)
    if (existing) {
      // Follow-up turns reuse the same provider session. Reset only the
      // per-turn scanner and retain the session-wide seenKeys ledger.
      existing.buffer = ''
      existing.scanOffset = 0
      existing.closeScanOffset = 0
      existing.spawned.clear()
      existing.pending = []
      existing.suspended = false
      return
    }
    this.earlySpawns.set(taskId, { buffer: '', scanOffset: 0, closeScanOffset: 0, spawned: new Map(), seenKeys: new Set(), pending: [], suspended: false })
  }

  /** 收尾回合关闭流式建单通道（预算收尾护栏）：文本事件照常推进扫描游标，但不再提前
   *  建单、不再登记 seenKeys——收尾回复里的新标记由委派循环回合末按已接单键对账具名
   *  拒单，复述的已接单标记不会被误当新单。换代重开通道时由 armDelegateSniffer 复位。 */
  suspendDelegateSpawns(taskId: string) {
    const state = this.earlySpawns.get(taskId)
    if (state) state.suspended = true
  }
  /** 撤销流式期间提前建的单：领队回合失败时，基于半截输出建的单不可信，
   *  取消仍在排队/运行的子任务并清空嗅探状态（对齐旧语义——失败回合不产生子任务） */
  abandonEarlySpawns(taskId: string) {
    const state = this.earlySpawns.get(taskId)
    if (!state) return
    this.earlySpawns.delete(taskId)
    this.delegateRejections.delete(taskId)
    if (!state.pending.length && ![...state.spawned.values()].some((e) => e.childId)) return
    const cancelSpawned = () => {
      for (const { childId } of state.spawned.values()) {
        if (!childId) continue
        const child = this.ports.taskOf(childId)
        if (child && (child.status === 'queued' || child.status === 'running')) {
          this.ports.cancelTask(childId)
          this.ports.note(taskId, `回合失败：撤销提前接单的「${child.title}」`)
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
    if (expectedRunId !== undefined && this.ports.claimOf(taskId)?.runId !== expectedRunId) return empty()
    const state = this.earlySpawns.get(taskId)
    if (!state) return empty()
    if (state.pending.length) await Promise.allSettled(state.pending)
    // 等待期间运行可能已被替换：收编前重新核对归属
    if (expectedRunId !== undefined && this.ports.claimOf(taskId)?.runId !== expectedRunId) return empty()
    state.pending = []
    const entries: Array<{ call: DelegateCall; childId: string }> = []
    for (const [key, entry] of state.spawned) {
      state.spawned.delete(key)
      if (entry.childId) {
        state.seenKeys.add(key)
        entries.push(entry)
        continue
      }
      // 建单已收场却没建出子单：有具名拒单 = 已走回执通道（key 留在 seenKeys，回合末
      // 不再重试）；无拒单 = 静默丢失（建单异常被吞 / silent null）——撤键让回合末把该单
      // 当新单重试或具名回灌。绝不能把“seenKeys 判已处理”变成丢单通道（实测事故：
      // 流式提前建单静默失败后整单无回执无建单无时间线痕迹，重发才被受理）。
      if (this.delegateRejectionRecorded(taskId, expectedRunId, key)) state.seenKeys.add(key)
      else state.seenKeys.delete(key)
    }
    return { entries, seenKeys: new Set(state.seenKeys) }
  }
  /** 该派单 key 是否已有未交付的具名拒单（store 持久层 + 内存层都查）。丢失型建单
   *  收场（无子单无拒单）与此判定联用：有拒单不再重试，无拒单必须补回执。 */
  delegateRejectionRecorded(taskId: string, expectedRunId: string | undefined, key: string): boolean {
    const runMatches = (entryRunId: string | undefined) => expectedRunId === undefined || entryRunId === undefined || entryRunId === expectedRunId
    const stored = this.ports.taskOf(taskId)?.delegateRejections
      ?.some((entry) => !entry.deliveredAt && entry.key === key && runMatches(entry.runId))
    if (stored) return true
    return (this.delegateRejections.get(taskId) ?? []).some((entry) => entry.key === key && runMatches(entry.runId))
  }
  recordDelegateRejection(taskId: string, reason: string, dispatch?: { to: string; prompt: string }) {
    const key = dispatch ? `${dispatch.to}\n${dispatch.prompt}` : undefined
    const storedReason = dispatch
      ? `${reason}${DELEGATE_REJECT_EXCERPT_MARK}${dispatch.prompt.replace(/\s+/g, ' ').trim().slice(0, 60)}）`
      : reason
    const task = this.ports.taskOf(taskId)
    const runId = this.ports.claimOf(taskId)?.runId ?? task?.runId
    if (task && runId) {
      const pending = task.delegateRejections ?? []
      if (pending.some((entry) => entry.runId === runId && (key !== undefined
        ? entry.key === key
        : entry.key === undefined && entry.reason === reason))) return
      this.ports.updateIf(taskId, { runId }, { delegateRejections: [...pending, { runId, reason: storedReason, ...(key !== undefined ? { key } : {}) }] })
      return
    }
    const list = this.delegateRejections.get(taskId) ?? []
    if (list.some((entry) => entry.runId === runId && (key !== undefined
      ? entry.key === key
      : entry.key === undefined && entry.reason === reason))) return
    list.push({ runId, reason: storedReason, ...(key !== undefined ? { key } : {}) })
    this.delegateRejections.set(taskId, list)
  }
  peekDelegateRejections(taskId: string, expectedRunId?: string): string[] {
    if (expectedRunId !== undefined && this.ports.claimOf(taskId)?.runId !== expectedRunId) return []
    const stored = this.ports.taskOf(taskId)?.delegateRejections?.filter((entry) => entry.runId === expectedRunId && !entry.deliveredAt).map((entry) => entry.reason) ?? []
    const memory = (this.delegateRejections.get(taskId) ?? [])
      .filter((entry) => entry.runId === undefined || expectedRunId === undefined || entry.runId === expectedRunId)
      .map((entry) => entry.reason)
    return [...stored, ...memory]
  }
  acknowledgeDelegateRejections(taskId: string, expectedRunId: string | undefined, count: number): void {
    if (expectedRunId !== undefined && this.ports.claimOf(taskId)?.runId !== expectedRunId) return
    const task = this.ports.taskOf(taskId)
    const entries = task?.delegateRejections
    if (task && entries && expectedRunId) {
      let acknowledged = 0
      this.ports.updateIf(taskId, { runId: expectedRunId }, { delegateRejections: entries.map((entry) => {
        if (entry.runId !== expectedRunId || entry.deliveredAt || acknowledged >= count) return entry
        acknowledged++
        return { ...entry, deliveredAt: Date.now() }
      }) })
      count -= acknowledged
    }
    const memory = this.delegateRejections.get(taskId) ?? []
    const remaining = memory.filter((entry) => {
      if (entry.runId !== undefined && expectedRunId !== undefined && entry.runId !== expectedRunId) return true
      if (count <= 0) return true
      count--
      return false
    })
    if (remaining.length) this.delegateRejections.set(taskId, remaining)
    else this.delegateRejections.delete(taskId)
  }
  /** 取走并清空本任务被拒派单的原因（委派循环每轮回灌用；不残留到后续轮）。
   *  expectedRunId 限定只有仍持有该运行的循环才能取走，替换运行不被陈旧循环掏空。 */
  takeDelegateRejections(taskId: string, expectedRunId?: string): string[] {
    const list = this.peekDelegateRejections(taskId, expectedRunId)
    this.acknowledgeDelegateRejections(taskId, expectedRunId, list.length)
    return list
  }
  acknowledgeDelegateReceipts(taskId: string, runId: string | undefined, childIds: readonly string[]): void {
    if (!runId || this.ports.claimOf(taskId)?.runId !== runId) return
    for (const childId of childIds) {
      const child = this.ports.taskOf(childId)
      if (child?.parentTaskId === taskId && child.delegateSourceRunId === runId && !child.delegateDeliveredAt) {
        this.ports.updateIf(childId, { runId: child.runId }, { delegateDeliveredAt: Date.now() })
      }
    }
  }
  /** 逐条 text 事件增量扫描：闭合一个 <delegate to="...">...</delegate> 即提前建单 */
  sniffDelegates(taskId: string, delta?: string) {
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
    // Drop already-scanned prefix after it is no longer needed. The cursor is
    // retained so an unfinished opening tag remains available for the next
    // delta, without allowing long transcripts to grow without bound.
    // 压缩必须覆盖全部早退路径（含「本轮无闭合标记」与「建单通道已关闭」两个早退）：
    // 长收尾流的后续 delta 只会走这两条路，漏掉任何一条都会让整段领队全文持续占内存。
    const compactBuffer = () => {
      if (state.scanOffset > 128 * 1024 && state.scanOffset > state.buffer.length / 2) {
        const cut = state.scanOffset
        state.buffer = state.buffer.slice(cut)
        state.scanOffset = 0
        state.closeScanOffset = Math.max(0, state.closeScanOffset - cut)
      }
    }
    // 建单通道已关闭（预算收尾护栏）：不再解析建单、不再登记 seenKeys——收尾回复里的
    // 新标记由回合末按已接单键对账具名拒单，复述的已接单标记不会被误当新单。暂停期间
    // 缓冲区没有任何未来读者（重开通道由 armDelegateSniffer 整体重置），任何早退路径都
    // 释放已扫描文本：长收尾流不持续占内存。
    const releaseSuspendedBuffer = () => {
      state.buffer = ''
      state.scanOffset = 0
      state.closeScanOffset = 0
    }
    if (state.suspended) {
      releaseSuspendedBuffer()
      return
    }
    if (closeAt < 0) {
      state.closeScanOffset = Math.max(state.closeScanOffset, state.buffer.length - closeTag.length + 1)
      compactBuffer()
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
      const p = this.ports.spawnDelegateChild(taskId, call).then((child) => {
        if (child) {
          state.spawned.set(key, { call, childId: child.id })
          this.ports.pushTask(taskId)
        }
      }).catch((error) => {
        // 建单通道异常绝不静默（takeEarlySpawns 的 allSettled 会吞掉 rejection，占位
        // 留在 spawned 里会被当「已处理」整单吞成无痕）：撤键 + 时间线留痕，回合末把
        // 该单当新单重试（成功→正常报告回执；再败→护栏具名拒单/扫尾具名回执）
        state.spawned.delete(key)
        state.seenKeys.delete(key)
        this.ports.note(taskId, `⚠ 流式提前建单失败（${error instanceof Error ? error.message : String(error)}），该派单将在回合末重试`)
      })
      state.pending.push(p)
    }
    compactBuffer()
  }

  /** 诊断面（冒烟用）：指定任务嗅探缓冲区的当前字符数——压缩行为断言的观测口。 */
  sniffBufferChars(taskId: string): number {
    return this.earlySpawns.get(taskId)?.buffer.length ?? 0
  }

  /** 会话级派单去重登记（委派循环侧新建的单同样进入；earlySpawns 无登记态时 no-op，
   *  与原 runner 直读 earlySpawns.get(taskId)?.seenKeys.add 语义逐位一致）。 */
  rememberSeenKey(taskId: string, key: string) {
    this.earlySpawns.get(taskId)?.seenKeys.add(key)
  }
  /** 已登记派单键计数（completeTurn 的委派循环判定观测口）；无登记态计 0。 */
  seenKeyCount(taskId: string): number {
    return this.earlySpawns.get(taskId)?.seenKeys.size ?? 0
  }

  // ---- 同键建单互斥（spawnCreatesInFlight 的窄面；互斥编排仍在 runner 的
  // spawnDelegateChild，批次 4b 随 child-spawner 外移后收口到这里） ----

  spawnInFlightOf(key: string): Promise<Task | null> | undefined {
    return this.spawnCreatesInFlight.get(key)
  }
  registerSpawnInFlight(key: string, execution: Promise<Task | null>) {
    this.spawnCreatesInFlight.set(key, execution)
  }
  /** 结算即撤登记：仅当登记副本仍是本执行才撤（登记已被同键后继替换时不误删） */
  retireSpawnInFlight(key: string, execution: Promise<Task | null>) {
    if (this.spawnCreatesInFlight.get(key) === execution) this.spawnCreatesInFlight.delete(key)
  }

  /** 进程关机清扫（runner shutdown 原语义）：仅清嗅探与拒单两账；
   *  spawnCreatesInFlight / workerIndexReservations 原本就不在关机清扫清单，保持不变。 */
  clearSessionState() {
    this.earlySpawns.clear()
    this.delegateRejections.clear()
  }

  reserveWorkerIndex(taskId: string) {
    const existing = this.ports.listChildTasks(taskId)
    const previous = this.workerIndexReservations.get(taskId) ?? 0
    const next = Math.max(previous, existing.length, ...existing.map((task) => task.workerIndex ?? 0)) + 1
    this.workerIndexReservations.set(taskId, next)
    return next
  }
}
