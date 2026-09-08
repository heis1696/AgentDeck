import type { Task } from '../shared/types'
import type { TaskStore } from './store'
import { snapshotGitAfter } from './git'
import { aggregateUsage } from './usage'
import { canTransition } from '../shared/taskflow'

export class TaskFinalizer {
  constructor(
    private readonly store: TaskStore,
    private readonly pushTask: (taskId: string) => void,
    private readonly snapshot = snapshotGitAfter
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
    const { diff, stat } = await this.snapshot(task.workdir)
    const current = this.store.get(taskId)
    if (!current || !canTransition(current.status, 'done', 'runner')) {
      if (current) this.store.update(taskId, { result, gitDiff: diff || current.gitDiff, gitStat: stat || current.gitStat, usage: aggregateUsage(events) })
      this.pushTask(taskId)
      return
    }
    this.store.update(taskId, {
      status: 'done',
      endedAt: Date.now(),
      result,
      gitDiff: diff || task.gitDiff,
      gitStat: stat || task.gitStat,
      usage: aggregateUsage(events)
    })
    this.pushTask(taskId)
  }
}
