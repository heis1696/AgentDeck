import type { Issue, Task } from '../shared/types'
import type { TaskStore } from './store'
import type { IssueStore } from './issue-store'
import type { TaskService } from './task-service'
import type { EventLog } from './event-log'

const DAY = 86_400_000
const TERMINAL = new Set(['done', 'failed', 'cancelled'])
export interface RetentionDeps {
  store: TaskStore
  issueStore: IssueStore
  taskService: TaskService
  activeGoalIssueIds(): Set<string>
  activeMeetingIssueIds(): Set<string>
  forget(id: string): unknown
  eventLog: Pick<EventLog, 'append'>
  onTaskDeleted?(id: string): void
  now?(): number
}
export interface RetentionReport { deletedIssues: number; deletedTasks: number; deletedComments: number; deletedRuns: number }

export async function sweepExpiredIssues(deps: RetentionDeps, maxAgeDays = 30): Promise<RetentionReport> {
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) throw new Error('maxAgeDays must be positive')
  const { store, issueStore, taskService } = deps
  const cutoff = (deps.now ?? Date.now)() - maxAgeDays * DAY
  const report: RetentionReport = { deletedIssues: 0, deletedTasks: 0, deletedComments: 0, deletedRuns: 0 }
  issueStore.sync(store.list())
  const protectedIds = () => new Set([...deps.activeGoalIssueIds(), ...deps.activeMeetingIssueIds()])
  const runTasks = new Map(issueStore.list().map((issue) => [issue.id, new Set(issueStore.runs(issue.id).map((run) => run.taskId))]))
  const belongs = (task: Task, issue: Issue) => task.issueId === issue.id || task.id === issue.taskId || (!task.issueId && issue.id === `iss_${task.id}`) || !!runTasks.get(issue.id)?.has(task.id)

  // Expand both ownership and descendants: a child's fresh sibling run must
  // protect the whole deletion cascade, not just its latest visible card.
  const planFor = (seed: string) => {
    const issues = issueStore.list()
    const tasks = store.list()
    const selectedIssues = new Set([seed])
    const selectedTasks = new Set<string>()
    let changed = true
    while (changed) {
      const size = selectedIssues.size + selectedTasks.size
      for (const issue of issues) {
        if (selectedIssues.has(issue.id)) for (const task of tasks) if (belongs(task, issue)) selectedTasks.add(task.id)
      }
      for (const task of taskService.taskCascade([...selectedTasks])) selectedTasks.add(task.id)
      for (const issue of issues) {
        if (tasks.some((task) => selectedTasks.has(task.id) && belongs(task, issue))) selectedIssues.add(issue.id)
      }
      changed = size !== selectedIssues.size + selectedTasks.size
    }
    const group = issues.filter((issue) => selectedIssues.has(issue.id))
    const selected = tasks.filter((task) => selectedTasks.has(task.id))
    const protectedIssues = protectedIds()
    const safe = group.length > 0
      && group.every((issue) => Number.isFinite(issue.updatedAt) && issue.updatedAt < cutoff && !protectedIssues.has(issue.id))
      && selected.every((task) => TERMINAL.has(task.status))
      // An unrelated run-only/orphan task is not disposable just because its
      // parent happens to be old; without an Issue it has no retention clock.
      && selected.every((task) => group.some((issue) => belongs(task, issue)))
    return { issues: group, tasks: selected, safe }
  }

  try {
    for (const issue of issueStore.list()) {
      if (!issueStore.get(issue.id) || !Number.isFinite(issue.updatedAt) || issue.updatedAt >= cutoff || protectedIds().has(issue.id)) continue
      const plan = planFor(issue.id)
      if (!plan.safe) continue
      const ids = new Set(plan.tasks.map((task) => task.id))
      const valid = () => {
        const current = planFor(issue.id)
        return current.safe && current.tasks.length === ids.size && current.tasks.every((task) => ids.has(task.id))
          && current.issues.length === plan.issues.length && current.issues.every((item) => plan.issues.some((prior) => prior.id === item.id))
      }
      const deleted = await taskService.deleteTerminalCascade([...ids], deps.forget, valid)
      if (!deleted) continue
      // No await between task removal and projection removal: sync cannot
      // interleave and resurrect a partially purged Issue.
      for (const item of plan.issues) {
        report.deletedComments += issueStore.comments(item.id).length
        report.deletedRuns += issueStore.runs(item.id).length
        if (issueStore.deleteIssue(item.id)) report.deletedIssues++
      }
      report.deletedTasks += deleted.length
      for (const id of deleted) deps.onTaskDeleted?.(id)
    }
    issueStore.sync(store.list())
    return report
  } finally {
    deps.eventLog.append({ ts: (deps.now ?? Date.now)(), kind: 'status', text: `保留清扫：清理 ${report.deletedIssues} 个 Issue、${report.deletedTasks} 个任务、${report.deletedComments} 条评论、${report.deletedRuns} 条运行记录`, data: { ...report, maxAgeDays } })
  }
}

export function startIssueRetention(deps: RetentionDeps, maxAgeDays = 30): () => void {
  let busy = false
  let stopped = false
  const tick = async () => {
    if (busy || stopped) return
    busy = true
    try { await sweepExpiredIssues(deps, maxAgeDays) }
    catch (error) {
      deps.eventLog.append({ ts: Date.now(), kind: 'status', text: `保留清扫失败：${String(error)}` })
    } finally { busy = false }
  }
  void tick()
  const timer = setInterval(() => void tick(), 24 * 60 * 60 * 1000)
  timer.unref()
  return () => { stopped = true; clearInterval(timer) }
}
