import type { Task, TaskEvent } from '../shared/types'
import { sameExecutionOwner, type TaskExpectation, type TaskStore } from './store'

/**
 * The identity of a Task record a decision was made from. Every lifecycle
 * write (start / retry / move / delete / rewind / reconciliation) commits
 * conditionally on this exact observation, so a run that replaced it in the
 * meantime is never overwritten by the older decision.
 */
export function taskIdentity(task: Task): TaskExpectation {
  return { status: task.status, runId: task.runId, executionOwner: task.executionOwner }
}

/**
 * Explicit user starts share this preparation; scheduler/recovery never call
 * it. The write is conditional on the observed queued record, so a task that
 * started, moved or was parked in between keeps its newer state and this
 * start reports failure instead of clobbering it.
 */
export function prepareManualTaskStart(store: Pick<TaskStore, 'get' | 'updateIf'>, taskId: string): Task | null {
  const task = store.get(taskId)
  if (!task || task.status !== 'queued') return null
  // 建单门禁未释放的子单不可手动启动：这里只清 parked，清不了门禁——放行只会造出
  // 「看似已启动、调度器却永不可见」的假入口，处置提示统一在 IPC 层给
  if (task.dispatchHold === true) return null
  const started = store.updateIf(taskId, { ...taskIdentity(task), parked: task.parked }, {
    parked: undefined,
    ...(task.continuesFrom ? { manualStartConfirmedAt: Date.now() } : {})
  })
  return started ?? null
}

function phaseKey(brief: string): string | undefined {
  // Only a leading, explicitly numbered phase is an identity. Body references
  // to earlier phases are evidence, not the phase this brief asks to execute.
  const match = brief.normalize('NFKC').trim().match(/^(?:\u9636\u6bb5\s*(\d+(?:\.\d+)*)|\u7b2c\s*(\d+(?:\.\d+)*)\s*\u9636\u6bb5|phase\s+(\d+(?:\.\d+)*))(?![\d.a-z])/i)
  return match?.slice(1).find(Boolean)?.split('.').map(Number).join('.')
}

export function repeatsHandoffPhase(source: Pick<Task, 'continuesFrom' | 'prompt'>, brief: string): boolean {
  if (!source.continuesFrom) return false
  const normalize = (text: string) => text.normalize('NFKC').trim().replace(/\s+/g, ' ')
  if (normalize(source.prompt) === normalize(brief)) return true
  const current = phaseKey(source.prompt)
  return current !== undefined && current === phaseKey(brief)
}

/** One non-cancelled successor per source, irrespective of wording changes. */
export function findHandoffSuccessor(tasks: readonly Task[], source: Pick<Task, 'id' | 'issueId'>): Task | undefined {
  return tasks.find((task) => task.issueId === source.issueId && task.continuesFrom === source.id && task.status !== 'cancelled')
}

// ---- 启动对账（应用重启后的僵尸运行与遗留排队） ----

export interface StartupReconcileDeps {
  store: Pick<TaskStore, 'list' | 'get' | 'readEvents' | 'recoverDeadRuns' | 'transaction'>
  pushEvent: (taskId: string, event: TaskEvent) => void
  enqueue: (task: Task) => void
  notifyTaskChanged: (task: Task) => void
  /** Relay an interrupted leader's already-delivered worker reports. */
  relayInterruptedLeader?: (stale: Task, children: Task[]) => void
  /**
   * dispatchHold 子单的磁盘归属核实+绑定（生产接线 setWorktreeOwner，fail-closed）：
   * 目录存在 + Git 注册在案 + 工作树身份与任务对应（路径/世代）三步全过才返回 true。
   * 缺省且子单带 worktree = 无法核实 → 一律转具名终态，绝不凭登记翻面派发。
   */
  bindWorktreeOwner?: (wtDir: string, ownerTaskId: string, expectedGenerationId?: string) => Promise<boolean>
}

export interface StartupReconcileResult {
  /** Runs taken over from a proven-dead owner (the pre-recovery record). */
  recovered: Task[]
  /** Legacy queued tasks handled by the startup pass (unparked or parked). */
  queued: Task[]
  /** dispatchHold 子单收场：磁盘归属核实通过，条件翻面并恢复派发。 */
  holdingResumed: Task[]
  /** dispatchHold 子单收场：无法核实磁盘归属，转具名终态（现场保留+处置提示）。 */
  holdingTerminated: Task[]
}

/**
 * 启动对账：执行只活在主进程内存里，快照里遗留的 running 只有在**执行身份被证实
 * 已死**时才是僵尸——活跃或身份不可读的运行一律保留（租约过期不是死亡证据）。
 * 接管统一走 store.recoverDeadRuns：锁外探活、锁内按捕获身份条件提交，每个死运行
 * 只认领一次。
 *
 * Recovery writes an identified event. Reconciliation reads the log immediately
 * before that event under the storage lock, checks the observed Run identity,
 * and commits its result and explanatory event together.
 *
 * dispatchHold 子单（建单在翻面前被打断）不进本函数的普通排队两路：上面单独按磁盘
 * 归属核实收场——翻面派发或具名终态，绝不挂起成「可手动启动却领不动」。
 */
export async function reconcileStartupTasks(deps: StartupReconcileDeps): Promise<StartupReconcileResult> {
  const { store, pushEvent, enqueue, notifyTaskChanged } = deps
  // The observation identifies which Run startup saw. Read its final log tail
  // only after recovery, while the same Run is fenced by the transaction.
  const observed = new Map(store.list()
    .filter((task) => task.status === 'running')
    .map((task) => [task.id, task]))
  const recovered: Task[] = []
  for (const stale of store.recoverDeadRuns('failed')) {
    const snapshot = observed.get(stale.id)
    const sameRun = !!snapshot
      && snapshot.runId === stale.runId
      && sameExecutionOwner(snapshot.executionOwner, stale.executionOwner)
    const captured: TaskExpectation = { status: 'failed', runId: stale.runId, executionOwner: stale.executionOwner }
    const committed = store.transaction((tx) => {
      const current = tx.get(stale.id)
      if (!current || current.status !== 'failed' || current.runId !== stale.runId || !sameExecutionOwner(current.executionOwner, stale.executionOwner)) return undefined
      const events = sameRun ? store.readEvents(stale.id, 0, Number.MAX_SAFE_INTEGER) : []
      const recoveryId = 'owner-recovery-' + stale.id + '-' + stale.runId + '-' + stale.executionOwner?.token
      const recoveryIndex = events.findIndex((event) => event.eventId === recoveryId)
      const lastEvent = events[recoveryIndex - 1]
      const lastFinal = lastEvent?.kind === 'final' && lastEvent.text ? lastEvent : undefined
      const note = tx.appendEvent(stale.id, {
        ts: Date.now(), kind: 'status',
        text: lastFinal
          ? '启动对账：检测到本任务在上次退出前已完成输出，自动标记为完成'
          : '启动对账：应用重启导致执行中断，自动标记为失败（可「重新运行」或继续追问）'
      }, captured)
      const task = tx.update(stale.id, lastFinal
        ? { status: 'done', endedAt: lastFinal.ts, result: lastFinal.text ?? stale.result, error: undefined }
        : { status: 'failed', endedAt: Date.now(), error: '应用重启导致任务中断，请重新运行' }, captured)!
      return { task, note }
    })
    if (!committed) continue
    const { task, note } = committed
    if (note) pushEvent(stale.id, note)
    notifyTaskChanged(task)
    // 委派领队被重启打断时，队员可能已交付——报告摘要留到 Issue，别随领队一起失联
    const kids = store.list().filter((task) => task.parentTaskId === stale.id && (task.status === 'done' || task.status === 'failed'))
    if (stale.issueId && kids.length) {
      // 转投失败只属于这一个领队的收场：按单捕获留日志，不拖垮整个启动对账
      try { deps.relayInterruptedLeader?.(stale, kids) } catch (error) {
        console.error('[startup-reconcile] 中断领队的队员报告转投失败', stale.id, error)
      }
    }
    recovered.push(stale)
  }

  // 排队启动依赖事件（enqueue / 上一跑落幕触发 pump），重启后事件源全消失，
  // 遗留的 queued 会永远滞留——硬切接力的后继任务正是这么卡死的。启动对账分两路：
  // ① 普通任务（自包含，如硬切后继）→ 补一次 enqueue 自动恢复，时间线留痕；
  // ② goal 绑定 / 委派 worker → 置 parked 挂起（pump 只认非 parked，不停车迟早被
  //    后续任何一次 pump 顺带扫走，等于静默恢复）。goal 重启后由 waiting_user 确认
  //    续跑（launchNext 新建）；worker 的委派循环已死，跑了也无人收编，留 ▶ 手动入口。
  //    已翻面的 worker 才有可用的 ▶ 入口；仍持 dispatchHold 门禁的建单残单不进本路
  //    （手动入口释放不了门禁）——下方 holding 收场单独处理。本路必须先行：holding
  //    翻面会释放门禁，若本路后行会把刚翻面的子单误当遗留 worker 二次 park 掉。
  const queued: Task[] = []
  const deferredDispatch: Task[] = []
  for (const stale of store.list().filter((task) => task.status === 'queued' && !task.parked && task.dispatchHold !== true)) {
    const captured: TaskExpectation = { ...taskIdentity(stale), parked: stale.parked }
    const park = !!(stale.goalId || stale.parentTaskId)
    const committed = store.transaction((tx) => {
      const task = tx.update(stale.id, park ? { parked: true } : {}, captured)
      if (!task) return undefined
      const note = tx.appendEvent(stale.id, {
        ts: Date.now(), kind: 'status',
        text: park ? '启动对账：应用重启，排队任务挂起待确认（可手动启动）' : '启动对账：恢复上次排队中的执行'
      })
      return { task, note }
    })
    if (!committed) continue
    if (committed.note) pushEvent(stale.id, committed.note)
    if (park) notifyTaskChanged(committed.task)
    else deferredDispatch.push(committed.task)
    queued.push(stale)
  }
  // dispatchHold 子单单独收场（置于排队对账之后：排队轮扫描时门禁未释放，天然互斥，
  // 不会把翻面后的子单误当遗留 worker 再 park）：建单流程（归属绑定→登记核实→翻面）
  // 在翻面前被重启打断，子单带着门禁停在队列外——调度器不可见、手动入口（▶ 启动/
  // 重跑/移回排队）对持门禁的单一律拒绝，按普通 worker 挂起等于留下「永远领不动」
  // 的悬挂。单独按磁盘归属核实分两路：① 三步核实通过（目录在、Git 注册在案、
  // 工作树身份与任务对应（路径/世代））→ 带出生身份+holding 条件翻面并恢复派发；
  // ② 无法核实/核实过程异常 → 具名终态 + 时间线留痕 + 现场处置提示，门禁保持。
  // 两路都不留 queued 持门禁的悬挂单（含旧快照的 parked+holding）。
  // 派发延后：对账期间只做条件提交，enqueue 统一攒到收尾一次性触发——pump 由 enqueue
  // 驱动且会顺带扫队列，若对账中途就入队，pump 会在本函数未完场时开跑（把还没 park 的
  // 遗留 worker 抢跑掉），对账必须对 pump 原子。
  const holdingResumed: Task[] = []
  const holdingTerminated: Task[] = []
  for (const stale of store.list().filter((task) => task.dispatchHold === true && task.status === 'queued')) {
    // 单个子单的核实/落盘异常按单捕获，绝不中断整个启动对账（对账跑在窗口/IPC 建立
    // 之前，任何未捕获异常都会打死启动）：核实异常与核实不通过同归具名终态。
    try {
      const captured: TaskExpectation = { ...taskIdentity(stale), parked: stale.parked, dispatchHold: true }
      let unverifiable = ''
      if (stale.worktree?.path) {
        try {
          const bound = deps.bindWorktreeOwner
            ? await deps.bindWorktreeOwner(stale.worktree.path, stale.id, stale.worktree.generationId)
            : false
          if (!bound) unverifiable = 'worktree 磁盘归属无法核实（目录缺失、Git 注册不在案或世代身份不符）'
        } catch (error) {
          unverifiable = `worktree 磁盘归属核实过程异常（${error instanceof Error ? error.message : String(error)}）`
        }
      }
      const committed = store.transaction((tx) => {
        if (unverifiable) {
          const task = tx.update(stale.id, {
            status: 'cancelled', endedAt: Date.now(),
            error: `应用重启时建单未完成（${unverifiable}），启动对账转取消`
          }, captured)
          if (!task) return undefined
          const note = tx.appendEvent(stale.id, {
            ts: Date.now(), kind: 'status',
            text: `启动对账：建单在翻面前被重启打断，${unverifiable}，本单转取消未执行${stale.workdir ? `；worktree 现场保留于 ${stale.workdir}，可手动清理或重派` : ''}`
          })
          return { task, note }
        }
        // 翻面与 worktree 归属元数据绑定同一原子提交（与 runner 恢复路径同规），无中间可领取态
        const task = tx.update(stale.id, {
          dispatchHold: undefined,
          ...(stale.parked ? { parked: undefined } : {}),
          ...(stale.worktree ? { worktree: { ...stale.worktree, ownerTaskId: stale.id } } : {})
        }, captured)
        if (!task) return undefined
        const note = tx.appendEvent(stale.id, {
          ts: Date.now(), kind: 'status',
          text: '启动对账：建单在翻面前被重启打断，磁盘归属已核实，恢复派发'
        })
        return { task, note }
      })
      if (!committed) continue
      if (committed.note) pushEvent(stale.id, committed.note)
      if (unverifiable) {
        notifyTaskChanged(committed.task)
        holdingTerminated.push(committed.task)
      } else {
        deferredDispatch.push(committed.task)
        holdingResumed.push(committed.task)
      }
    } catch (error) {
      // 兜底按单捕获：这笔收场写不进去（存储异常等）只留日志继续对账其余子单，
      // 门禁原样保留——绝不让单个子单的异常把整个启动对账炸掉
      console.error('[startup-reconcile] dispatchHold 子单收场异常，跳过该单继续对账', stale.id, error)
    }
  }

  // 对账写全部落盘后才驱动队列：此时挂起的已挂起、翻面的已翻面，pump 看到的是终态视图
  for (const task of deferredDispatch) enqueue(task)
  return { recovered, queued, holdingResumed, holdingTerminated }
}
