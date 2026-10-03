// Issue 管线状态机框架：把「创建 → 派发（排队/停放）→ 运行 → 收尾 → 终态」统一为一条管线。
//
// 为什么需要它（历史教训，见 runner.isIdle 注释）：任务/会议/硬切接力/目标各自维护
// 在途状态与收尾路径，每加一种机制就多一处「忙」的来源——sessions、retiredProviderSessions
// 两次把全结束的看板永久判忙，热更 apply 被「有任务在执行」挡死。本框架把三件事收单：
//
// 1. 状态迁移：迁移合法性只查 shared/taskflow 的矩阵（runner/ui 两个视角），管线不做
//    第二套矩阵；settle 只在迁移落库后做统一收尾，落库本身仍由持有身份栅栏的调用方
//    （store.updateIf 条件写）完成——不夺走竞态防护，只统一终点处理。
// 2. 在途账本：新机制的在途操作（启动竞态、终止进行中、晚到清理……）一律 begin/end
//    登记，键名带 `${taskId}:` 前缀；idle = 账本空 + 适配源空 + store 无 running。
//    「任务结束后合法存活的常态」（done 任务的活会话、detach 后的平台会话台账）结构性
//    不在账本内——不是靠某次修复把它们排除，而是它们从来就不该登记。
// 3. 变体：普通任务/会议成员/会议容器/硬切接力/……都是管线上的变体，只贡献准入守卫
//    （admits）与终点钩子（onSettle）；新增机制不再自建状态机，注册变体即可。
import { canTransition, isTerminalTaskStatus } from '../../shared/taskflow'
import type { TaskStatus } from '../../shared/types'

/** 管线终态：与 TaskStatus 的终态子集一一对应，终点处理唯一出口 */
export type IssueOutcome = 'done' | 'failed' | 'cancelled'

/** 迁移触发方：决定套用 taskflow 矩阵的哪个视角 */
export type PipelineActor = 'runner' | 'ui'

export interface SettleContext {
  actor: PipelineActor
  /** 收尾来源（'cancel' | 'finalize' | 'terminate' 等）：横切钩子按来源区分行为 */
  source?: string
  runId?: string
  reason?: string
}

/** 管线视角的任务最小面：Task 结构性满足；测试可自带轻量夹具 */
export interface PipelineTask {
  id: string
  status: TaskStatus
  parked?: boolean
  meetingId?: string
  meetingTaskRole?: 'container' | 'member' | 'investigation'
  trigger?: string
}

/** 迁移期兼容源：runner 既有在途 Map 的只读适配；新机制不再加源，走账本 */
export interface OperationSource {
  label: string
  size(): number
}

export interface PipelineVariant<T extends PipelineTask = PipelineTask> {
  /** 变体标识，流水账与断言用 */
  id: string
  /** 变体解析：注册序首个命中者生效 */
  match(task: T): boolean
  /** 准入守卫：是否允许该任务进入/继续运行（如会议停止屏障）。缺省放行 */
  admits?(task: T): boolean
  /** 终点钩子：settle 统一调用；抛错被收集为 warning，不阻断其它钩子 */
  onSettle?(task: T, outcome: IssueOutcome, context: SettleContext): void | Promise<void>
}

export interface PipelineJournalEntry {
  taskId: string
  from: TaskStatus | 'created'
  to: TaskStatus | 'removed'
  variant: string
  at: number
  detail?: string
}

export interface IssuePipelineOptions<T extends PipelineTask = PipelineTask> {
  /** store 探针：只读，idle 判定与 settle 校验用 */
  probe: { list(): T[]; get(id: string): T | undefined }
  sources?: OperationSource[]
  variants?: PipelineVariant<T>[]
  /** 横切准入守卫：对多类任务生效的规则（会议停止屏障、issue 占有栅栏） */
  admitGuards?: Array<(task: T) => boolean>
  /** 横切收尾钩子：与变体 onSettle 同批执行，全部终态迁移都会经过 */
  settleHooks?: Array<(task: T, outcome: IssueOutcome, context: SettleContext) => void | Promise<void>>
  /** 流水账上限（环形），缺省 200 */
  journalLimit?: number
}

/** 缺省变体：无守卫、无钩子，保证任何任务都能解析到变体 */
const FALLBACK_VARIANT: PipelineVariant<never> = { id: 'task', match: () => true }

export class IssuePipeline<T extends PipelineTask = PipelineTask> {
  private readonly probe: { list(): T[]; get(id: string): T | undefined }
  private readonly sources: OperationSource[]
  private readonly admitGuards: Array<(task: T) => boolean> = []
  private readonly settleHooks: Array<(task: T, outcome: IssueOutcome, context: SettleContext) => void | Promise<void>> = []
  private readonly settledOutcomes = new Map<string, IssueOutcome>()
  private readonly variants: PipelineVariant<T>[] = []
  private readonly journal: PipelineJournalEntry[] = []
  private readonly journalLimit: number
  private readonly ledger = new Set<string>()

  constructor(options: IssuePipelineOptions<T>) {
    this.probe = options.probe
    this.sources = [...options.sources ?? []]
    this.journalLimit = options.journalLimit ?? 200
    for (const variant of options.variants ?? []) this.variants.push(variant)
    for (const guard of options.admitGuards ?? []) this.admitGuards.push(guard)
    for (const hook of options.settleHooks ?? []) this.settleHooks.push(hook)
  }

  /** 注册变体：解析按注册序首个命中，先到先得，行为可预测 */
  registerVariant(variant: PipelineVariant<T>): this {
    this.variants.push(variant)
    return this
  }

  /** 迁移期适配源：把既有 Map 挂为在途来源；新机制不要再用这个口子 */
  addSource(source: OperationSource): this {
    this.sources.push(source)
    return this
  }

  /** 横切准入守卫：全部通过且变体自身放行时才允许运行 */
  addAdmitGuard(guard: (task: T) => boolean): this {
    this.admitGuards.push(guard)
    return this
  }

  /** 横切收尾钩子：与变体 onSettle 同批、全部终态迁移都会执行（级联取消等跨变体规则挂这里） */
  addSettleHook(hook: (task: T, outcome: IssueOutcome, context: SettleContext) => void | Promise<void>): this {
    this.settleHooks.push(hook)
    return this
  }

  /** 任务重新进入执行（新 Run claim）：终态收尾登记重置，下次终态照常跑钩子 */
  reopen(taskId: string): void {
    this.settledOutcomes.delete(taskId)
  }

  /** 变体解析：注册序首个 match；全部未命中落到内置 'task' */
  resolveVariant(task: T): PipelineVariant<T> {
    for (const variant of this.variants) if (variant.match(task)) return variant
    return FALLBACK_VARIANT as PipelineVariant<T>
  }

  /** 准入裁决：横切守卫全过 + 变体自身守卫（若有）放行。会议停止屏障等机制经由此口统一生效 */
  admits(task: T): boolean {
    if (!this.admitGuards.every((guard) => guard(task))) return false
    const variant = this.resolveVariant(task)
    return variant.admits ? variant.admits(task) : true
  }

  // ---- 在途账本 ----

  /** 登记一条在途操作。键约定 `${taskId}:${op}`，以便 settle/drop 按任务前缀清账 */
  begin(key: string): void {
    this.ledger.add(key)
  }

  /** 结束一条在途操作；键不存在返回 false（可作泄漏断言探针） */
  end(key: string): boolean {
    return this.ledger.delete(key)
  }

  /** 结束某任务名下全部在途操作（settle/drop 调用），返回清除条数 */
  endScope(taskId: string): number {
    const prefix = `${taskId}:`
    let removed = 0
    for (const key of this.ledger) {
      if (key.startsWith(prefix)) { this.ledger.delete(key); removed++ }
    }
    return removed
  }

  has(key: string): boolean {
    return this.ledger.has(key)
  }

  ledgerSize(): number {
    return this.ledger.size
  }

  ledgerEntries(): readonly string[] {
    return [...this.ledger]
  }

  /**
   * 空闲判定（热更 apply 门控的唯一出口）：账本空 + 适配源空 + store 无 running。
   * 排队/停放任务不计入（沿用历史语义：派发是瞬态，重启后由调度器恢复）；
   * done 任务常驻的活会话、detach 后的平台会话台账等「合法存活的常态」不登记，
   * 结构性杜绝「幽灵任务」——新增守卫条件前先对表 smoke-issue-pipeline 的 idle 不变式。
   */
  isIdle(): boolean {
    return this.ledger.size === 0
      && this.sources.every((source) => source.size() === 0)
      && this.probe.list().every((task) => task.status !== 'running')
  }

  /** 各在途来源的具名快照：诊断「谁在忙」用（不再逐个翻 runner 私有 Map） */
  busySources(): Array<{ label: string; size: number }> {
    return [
      { label: 'ledger', size: this.ledger.size },
      ...this.sources.map((source) => ({ label: source.label, size: source.size() }))
    ].filter((entry) => entry.size > 0)
  }

  // ---- 终点处理 ----

  /**
   * 统一收尾：在终态迁移**落库之后**调用（落库仍由持有身份栅栏的调用方完成）。
   * 职责：校验迁移一致性 → 清该任务名下在途账 → 按变体与横切链跑收尾钩子 → 记流水账。
   * 首次收尾（含落库后补收口）照常执行钩子；**同一终态的重复收尾**只补记账不再跑钩子。
   * 已处于其它终态时拒绝改写。钩子抛错收集进返回值 error（warning 语义），不阻断账目
   * 清理与流水账。
   */
  async settle(taskId: string, outcome: IssueOutcome, context: SettleContext): Promise<{ ok: boolean; error?: string }> {
    const task = this.probe.get(taskId)
    if (!task) return { ok: false, error: '任务不存在' }
    const variant = this.resolveVariant(task)
    if (isTerminalTaskStatus(task.status)) {
      if (task.status !== outcome) {
        this.record(taskId, task.status, task.status, variant, `拒绝改写：已终态 ${task.status}，请求 ${outcome}`)
        return { ok: false, error: `任务已终态 ${task.status}，拒绝改写为 ${outcome}` }
      }
      if (this.settledOutcomes.get(taskId) === outcome) {
        this.endScope(taskId)
        this.record(taskId, task.status, task.status, variant, `幂等重放 ${outcome}${context.reason ? `（${context.reason}）` : ''}`)
        return { ok: true }
      }
      const cleared = this.endScope(taskId)
      this.settledOutcomes.set(taskId, outcome)
      const problems: string[] = []
      await this.runSettleHooks(task, outcome, context, variant, problems)
      this.record(taskId, task.status, outcome, variant, [context.reason, cleared ? `清在途 ${cleared} 条` : ''].filter(Boolean).join('；'))
      return problems.length ? { ok: true, error: problems.join('；') } : { ok: true }
    }
    if (!canTransition(task.status, outcome, context.actor)) {
      return { ok: false, error: `非法迁移 ${task.status} → ${outcome}（${context.actor}）` }
    }
    const from = task.status
    const cleared = this.endScope(taskId)
    this.settledOutcomes.set(taskId, outcome)
    const problems: string[] = []
    await this.runSettleHooks(task, outcome, context, variant, problems)
    this.record(taskId, from, outcome, variant, [context.reason, cleared ? `清在途 ${cleared} 条` : ''].filter(Boolean).join('；'))
    return problems.length ? { ok: true, error: problems.join('；') } : { ok: true }
  }

  /** 任务移除（forget）：清在途 + 清收尾登记 + 记 removed */
  drop(taskId: string): void {
    const cleared = this.endScope(taskId)
    this.settledOutcomes.delete(taskId)
    const task = this.probe.get(taskId)
    const from = task ? task.status : ('created' as const)
    this.record(taskId, from, 'removed', this.variantOf(taskId), cleared ? `清在途 ${cleared} 条` : '')
  }

  /** 变体钩子 + 横切收尾链依次执行；单个失败收集为 warning，不阻断其余钩子 */
  private async runSettleHooks(task: T, outcome: IssueOutcome, context: SettleContext, variant: PipelineVariant<T>, problems: string[]): Promise<void> {
    try {
      await variant.onSettle?.(task, outcome, context)
    } catch (error) {
      problems.push(`${variant.id} 收尾钩子失败：${error instanceof Error ? error.message : String(error)}`)
    }
    for (let index = 0; index < this.settleHooks.length; index++) {
      try {
        await this.settleHooks[index](task, outcome, context)
      } catch (error) {
        problems.push(`横切收尾钩子 #${index} 失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /** 流水账快照（环形，最新在后）：跨机制调试与回归断言用 */
  journalSnapshot(): readonly PipelineJournalEntry[] {
    return [...this.journal]
  }

  private variantOf(taskId: string): PipelineVariant<T> {
    const task = this.probe.get(taskId)
    return task ? this.resolveVariant(task) : (FALLBACK_VARIANT as PipelineVariant<T>)
  }

  private record(taskId: string, from: PipelineJournalEntry['from'], to: PipelineJournalEntry['to'], variant: PipelineVariant<T>, detail?: string): void {
    this.journal.push({ taskId, from, to, variant: variant.id, at: Date.now(), ...(detail ? { detail } : {}) })
    if (this.journal.length > this.journalLimit) this.journal.splice(0, this.journal.length - this.journalLimit)
  }
}
