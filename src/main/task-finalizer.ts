import type { Task, TaskGitSnapshot } from '../shared/types'
import type { TaskStore } from './store'
import { snapshotGitAfter } from './git'
import { aggregateUsage } from './usage'
import { canTransition } from '../shared/taskflow'
import { currentGitSnapshot } from '../shared/git-snapshot'

export class TaskFinalizer {
  constructor(
    private readonly store: TaskStore,
    private readonly pushTask: (taskId: string) => void,
    private readonly snapshot: (workdir: string) => Promise<{ diff: string; stat: string; snapshot?: TaskGitSnapshot }> = snapshotGitAfter
  ) {}

  async finalizeDone(taskId: string, directResult?: string) {
    const task = this.store.get(taskId)
    if (!task || task.status !== 'running') return
    let result = directResult
    const events = this.store.readEvents(taskId)
    if (result === undefined) {
      const finals = events.filter((event) => event.kind === 'final')
      result = finals[finals.length - 1]?.text ?? ''
    }
    const runId = task.runId
    const phaseIndex = task.phaseIndex
    const startedAt = task.startedAt
    const captured = await this.snapshot(task.workdir)
    const current = this.store.get(taskId)
    // Snapshotting is asynchronous. A follow-up can start the next Run while
    // the old Run is waiting for git, so never let the old snapshot finalize it.
    const sameRun = current
      && current.runId === runId
      && current.phaseIndex === phaseIndex
      && (runId !== undefined || current.startedAt === startedAt)
    if (!sameRun) {
      this.pushTask(taskId)
      return
    }
    const previous = currentGitSnapshot(current)
    // Integration diffs describe another branch. Keep only a proven same-run
    // integration snapshot when the final working-tree capture is clean.
    const keepIntegration = captured.snapshot?.state === 'clean'
      && previous?.scope === 'integration'
    const gitFields: Pick<Task, 'gitDiff' | 'gitStat' | 'gitSnapshot'> = keepIntegration
      ? { gitDiff: current.gitDiff, gitStat: current.gitStat, gitSnapshot: previous }
      : {
          gitDiff: captured.diff,
          gitStat: captured.stat,
          gitSnapshot: {
            ...(captured.snapshot ?? {
              state: captured.diff.trim() || captured.stat.trim() ? 'available' : 'unavailable',
              scope: 'workspace', capturedAt: Date.now()
            }),
            runId, phaseIndex, startedAt
          }
        }
    if (!current || !canTransition(current.status, 'done', 'runner')) {
      if (current) this.store.update(taskId, { result, ...gitFields, usage: aggregateUsage(events) })
      this.pushTask(taskId)
      return
    }
    this.store.update(taskId, {
      status: 'done',
      endedAt: Date.now(),
      result,
      ...gitFields,
      usage: aggregateUsage(events)
    })
    this.pushTask(taskId)
  }
}
