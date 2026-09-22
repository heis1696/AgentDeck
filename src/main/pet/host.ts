// PetHost：小助理宿主（阶段 1）——契约事件通道（开关位闸门）+ deck.* 工具 + 看板快照缓存 + 事件合并窗。
// 零 electron / 零第三方运行时依赖：主进程组装在 initMain（经 PetControllerDeps 移交），smoke esbuild 直连即公共 API。
import type {
  PetBoardTaskRow,
  PetHostAnnotateTaskInput,
  PetHostAnnotateTaskResult,
  PetHostCreateTaskInput,
  PetHostCreateTaskResult,
  PetHostEvent,
  PetHostSwitches
} from '../../shared/pet'
import { DEFAULT_PET_HOST_SWITCHES, normalizePetHostSwitches, petBatchFlushAt, petHostSwitchKeyFor } from '../../shared/pet'
import type { Task } from '../../shared/types'

export interface PetHostDeps {
  /** 开关位读取（pet.json 持久化）：每次 emit 边界实时读取，切换即时生效 */
  getSwitches?: () => PetHostSwitches
  /** 看板摘要构建（{board_summary} 宏同源）：board.snapshot 到达时刷新缓存 */
  buildBoardSummary: () => string
  /** deck.queryBoard 数据源（TaskStore.list()）；行剥离在 toPetBoardTaskRow 完成 */
  queryBoard: () => Task[]
  /** deck.createTask 落点：toPetHostDraftCreateInput 固定 startNow:false → parked 草稿，绝不 enqueue */
  createDraftTask: (input: PetHostCreateTaskInput) => { id: string; title: string; status: string }
  /** deck.annotateTask 落点：直连 issueStore.addComment 的独立通道——绝不走解析 @mention 的评论路径（src/main/ipc/issues.ts:29-45 的坑） */
  annotateIssue: (issueId: string, text: string) => unknown
  /** annotateTask 由 taskId 反查归属 Issue 用 */
  resolveTask?: (taskId: string) => { issueId?: string } | undefined
}

export type PetHostListener = (event: PetHostEvent) => void

/** Task → 看板行：白名单取字段，prompt/workdir/密钥/日志正文一概不出现 */
export function toPetBoardTaskRow(task: Task): PetBoardTaskRow {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    agentId: task.agentId ?? '',
    backend: task.backend,
    createdAt: task.createdAt,
    ...(task.endedAt !== undefined ? { endedAt: task.endedAt } : {})
  }
}

/** deck.createTask → 主进程建任务入参：固定 startNow:false（parked 草稿语义在这里钉死，不靠调用方自觉） */
export function toPetHostDraftCreateInput(input: PetHostCreateTaskInput): { title: string; prompt: string; workdir: string; agentId?: string; startNow: false } {
  return {
    title: input.title.trim(),
    prompt: input.prompt.trim(),
    workdir: typeof input.workdir === 'string' ? input.workdir : '',
    ...(typeof input.agentId === 'string' && input.agentId.trim() ? { agentId: input.agentId.trim() } : {}),
    startNow: false
  }
}

/** 定时器注入面：默认 setTimeout/clearTimeout；smoke 注入手动假时钟测合并窗行为 */
export interface PetBatchScheduler {
  schedule: (delayMs: number, fire: () => void) => void
  cancel: () => void
}

/** 真实定时器（生产用）：单定时器句柄，cancel 后 schedule 前旧回调失效 */
export function timeoutScheduler(): PetBatchScheduler {
  let timer: NodeJS.Timeout | undefined
  return {
    schedule: (delayMs, fire) => {
      timer = setTimeout(fire, delayMs)
    },
    cancel: () => {
      if (timer) clearTimeout(timer)
      timer = undefined
    }
  }
}

/**
 * 事件合并窗：批量终态合成一次冲刷。push 重算单定时器，到期 at = min(firstAt+15s, lastAt+2.5s)；
 * 拖拽/聊天进行中 hold 扣住（到点不冲），最后一次 release 立即冲出。
 */
export class PetEventBatchWindow<T> {
  private items: T[] = []
  private firstAt = 0
  private lastAt = 0
  private scheduled = false
  private holdCount = 0
  private pendingFire = false

  constructor(private readonly opts: {
    onFlush: (items: T[]) => void
    now?: () => number
    scheduler: PetBatchScheduler
  }) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now()
  }

  /** push 一条：单定时器每次重算 */
  push(item: T): void {
    const at = this.now()
    if (!this.items.length) this.firstAt = at
    this.lastAt = at
    this.items.push(item)
    this.reschedule()
  }

  /** 拖拽/聊天开始：扣住（可叠加） */
  hold(): void {
    this.holdCount += 1
  }

  /** 拖拽/聊天结束：全部松开时若有到点未冲的批次立即冲出 */
  release(): void {
    this.holdCount = Math.max(0, this.holdCount - 1)
    if (this.holdCount === 0 && this.pendingFire) this.flush()
  }

  /** 立即冲刷（未到点也冲）：清空批次与定时器 */
  flush(): void {
    this.pendingFire = false
    if (this.scheduled) {
      this.opts.scheduler.cancel()
      this.scheduled = false
    }
    const items = this.items
    this.items = []
    this.firstAt = 0
    this.lastAt = 0
    if (items.length) this.opts.onFlush(items)
  }

  /** 丢弃一切（dispose 用）：不冲刷 */
  clear(): void {
    if (this.scheduled) this.opts.scheduler.cancel()
    this.scheduled = false
    this.pendingFire = false
    this.items = []
    this.firstAt = 0
    this.lastAt = 0
  }

  get pendingCount(): number {
    return this.items.length
  }

  private reschedule(): void {
    const delay = Math.max(0, petBatchFlushAt(this.firstAt, this.lastAt) - this.now())
    this.opts.scheduler.cancel()
    this.scheduled = true
    this.opts.scheduler.schedule(delay, () => this.onDue())
  }

  private onDue(): void {
    this.scheduled = false
    if (this.holdCount > 0) {
      this.pendingFire = true
      return
    }
    this.flush()
  }
}

/**
 * 契约事件通道：emit 入口先查开关位，关 = 边界处直接丢弃（不转发不记忆）；
 * 开 = 刷新看板快照缓存（board.snapshot 时）并扇出订阅者（订阅者异常互不影响）。
 */
export class PetHost {
  private listeners = new Set<PetHostListener>()
  /** 最近一次 board.snapshot 捕获的看板摘要（null = 尚未捕获，读时惰性现算） */
  private boardSummary: string | null = null

  constructor(private readonly deps: PetHostDeps) {}

  /** 订阅契约事件流；返回退订函数 */
  addListener(listener: PetHostListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 当前生效开关位（未接 pet.json 时默认全开） */
  switches(): PetHostSwitches {
    return normalizePetHostSwitches(this.deps.getSwitches?.())
  }

  /**
   * 契约 emit 入口：开关位关 = 边界丢弃（不转发不记忆）；非法事件同样丢弃。
   * workflow.milestone 的发射点留阶段 2：真实源在 TaskRunner 的 onTaskEvent 钩子
   *（goalController.onTaskEvent 同款挂法，见 main/index.ts runner 装配处）；主进程入口
   * 本阶段只允许两处改道点，故先类型+开关位先行，emit 已支持该种类。
   */
  emit(event: PetHostEvent): void {
    const key = event && typeof event === 'object' ? petHostSwitchKeyFor(event.kind) : null
    if (!key) return
    if (!this.switches()[key]) return
    if (typeof event.taskId !== 'string' || !event.taskId || typeof event.title !== 'string' || !Number.isFinite(event.at)) return
    if (event.kind === 'board.snapshot') this.boardSummary = this.deps.buildBoardSummary()
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch { /* 单个订阅者异常不拖垮扇出 */ }
    }
  }

  /**
   * notifyTaskChanged 改道入口：任务状态迁移 → 契约事件（task.* 各自受开关位闸）+ 看板快照刷新。
   * 契约外状态（queued/cancelled/parked）只走 board.snapshot——快照不带状态，controller 靠
   * deck.queryBoard 对账补齐（见 PetController.syncTaskStatusFromBoard）。
   */
  emitTaskChanged(task: { id: string; title: string; status: string }, at = Date.now()): void {
    const kind = task.status === 'running' ? 'task.running'
      : task.status === 'done' ? 'task.done'
        : task.status === 'failed' ? 'task.failed'
          : null
    if (kind) this.emit({ kind, taskId: task.id, title: task.title, at })
    this.emit({ kind: 'board.snapshot', taskId: task.id, title: task.title, at })
  }

  /** {board_summary} 宏来源：读最近一次 board.snapshot 缓存；从未捕获时惰性现算一次（宏注入行为保持） */
  getBoardSummary(): string {
    if (this.boardSummary === null) this.boardSummary = this.deps.buildBoardSummary()
    return this.boardSummary
  }

  /** deck.queryBoard：包 store.list()，剥除 prompt/workdir/密钥/日志正文 */
  queryBoard(): PetBoardTaskRow[] {
    return this.deps.queryBoard().map(toPetBoardTaskRow)
  }

  /** deck.createTask：只建草稿（parked），绝不触发 runner 执行 */
  createTask(input: PetHostCreateTaskInput): PetHostCreateTaskResult {
    const title = typeof input?.title === 'string' ? input.title.trim() : ''
    const prompt = typeof input?.prompt === 'string' ? input.prompt.trim() : ''
    if (!title || !prompt) return { ok: false, taskId: '', title: '', parked: false, reason: '标题与内容必填' }
    try {
      const task = this.deps.createDraftTask({ title, prompt, ...(typeof input.workdir === 'string' ? { workdir: input.workdir } : {}), ...(typeof input.agentId === 'string' && input.agentId.trim() ? { agentId: input.agentId } : {}) })
      return { ok: true, taskId: task.id, title: task.title, parked: true }
    } catch (err) {
      return { ok: false, taskId: '', title, parked: false, reason: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * deck.annotateTask：独立批注通道——直连 issueStore.addComment（agent 身份 pet），
   * 不经过 issues:add-comment 的 @mention 解析路径（那条路会把批注当指令拉起执行）。
   */
  annotateTask(input: PetHostAnnotateTaskInput): PetHostAnnotateTaskResult {
    const text = typeof input?.text === 'string' ? input.text.trim() : ''
    if (!text) return { ok: false, issueId: '', reason: '批注内容必填' }
    let issueId = typeof input?.issueId === 'string' ? input.issueId.trim() : ''
    if (!issueId && typeof input?.taskId === 'string' && input.taskId.trim()) {
      issueId = this.deps.resolveTask?.(input.taskId.trim())?.issueId ?? `iss_${input.taskId.trim()}`
    }
    if (!issueId) return { ok: false, issueId: '', reason: '未找到目标任务' }
    try {
      this.deps.annotateIssue(issueId, text)
      return { ok: true, issueId }
    } catch (err) {
      return { ok: false, issueId, reason: err instanceof Error ? err.message : String(err) }
    }
  }
}
