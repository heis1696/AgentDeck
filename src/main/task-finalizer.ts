import type { Task, TaskGitSnapshot } from '../shared/types'
import type { TaskExpectation, TaskStore } from './store'
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

  /**
   * Commit one successful turn.
   *
   * `expected` is the execution identity captured before the turn started
   * (status, run ID and execution owner). Git snapshotting is asynchronous, so
   * a follow-up can claim the next Run while this one waits: every write below
   * is conditional on that captured identity and the store re-checks it inside
   * the storage transaction. A stale finalizer therefore cannot finish, or
   * even relabel, a newer Run on the same compatibility Task.
   */
  async finalizeDone(taskId: string, directResult?: string, expected?: TaskExpectation) {
    const task = this.store.get(taskId)
    if (!task || task.status !== 'running') return
    const running: TaskExpectation = expected ?? {
      status: 'running',
      runId: task.runId,
      executionOwner: task.executionOwner,
      phaseIndex: task.phaseIndex,
      // A run without a durable id is identified by its start stamp alone.
      ...(task.runId === undefined ? { startedAt: task.startedAt } : {})
    }
    if (!this.store.matches(taskId, running)) return
    // The same identity without the status fence: used for the derived
    // result/snapshot fields when the Run is still ours but no longer running.
    const { status: _running, ...identity } = running
    let result = directResult
    const events = this.store.readEvents(taskId)
    if (result === undefined) {
      const finals = events.filter((event) => event.kind === 'final')
      result = finals[finals.length - 1]?.text ?? ''
    }
    const captured = await this.snapshot(task.workdir)
    const current = this.store.get(taskId)
    if (!current || !this.store.matches(taskId, identity)) {
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
            runId: current.runId, phaseIndex: current.phaseIndex, startedAt: current.startedAt
          }
        }
    const derived = { result, ...gitFields, usage: aggregateUsage(events) }
    if (!canTransition(current.status, 'done', 'runner')) {
      // Same Run, already terminal (for example cancelled while git ran):
      // retain the derived fields without resurrecting it into done.
      this.store.updateIf(taskId, { ...identity, status: ['done', 'failed', 'cancelled'] }, derived)
      this.pushTask(taskId)
      return
    }
    this.store.updateIf(taskId, running, { status: 'done', endedAt: Date.now(), ...derived })
    this.pushTask(taskId)
  }
}
