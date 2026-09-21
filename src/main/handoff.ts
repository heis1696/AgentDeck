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
}

export interface StartupReconcileResult {
  /** Runs taken over from a proven-dead owner (the pre-recovery record). */
  recovered: Task[]
  /** Legacy queued tasks handled by the startup pass (unparked or parked). */
  queued: Task[]
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
 */
export function reconcileStartupTasks(deps: StartupReconcileDeps): StartupReconcileResult {
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
    if (stale.issueId && kids.length) deps.relayInterruptedLeader?.(stale, kids)
    recovered.push(stale)
  }

  // 排队启动依赖事件（enqueue / 上一跑落幕触发 pump），重启后事件源全消失，
  // 遗留的 queued 会永远滞留——硬切接力的后继任务正是这么卡死的。启动对账分两路：
  // ① 普通任务（自包含，如硬切后继）→ 补一次 enqueue 自动恢复，时间线留痕；
  // ② goal 绑定 / 委派 worker → 置 parked 挂起（pump 只认非 parked，不停车迟早被
  //    后续任何一次 pump 顺带扫走，等于静默恢复）。goal 重启后由 waiting_user 确认
  //    续跑（launchNext 新建）；worker 的委派循环已死，跑了也无人收编，留 ▶ 手动入口。
  const queued: Task[] = []
  for (const stale of store.list().filter((task) => task.status === 'queued' && !task.parked)) {
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
    else enqueue(committed.task)
    queued.push(stale)
  }
  return { recovered, queued }
}
