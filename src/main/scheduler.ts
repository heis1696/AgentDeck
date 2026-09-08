import type { Task } from '../shared/types'

export interface SchedulerLimits {
  concurrency: number
  workerConcurrency?: number
}

/** Queues normal tasks and delegated workers without knowing execution details. */
export class Scheduler {
  private runningNormal = 0
  private runningWorkers = 0
  private pumping = false

  constructor(
    private readonly listTasks: () => Task[],
    private readonly limits: () => SchedulerLimits,
    private readonly run: (taskId: string) => Promise<void>
  ) {}

  enqueue() {
    this.pump()
  }

  private pump() {
    if (this.pumping) return
    this.pumping = true
    try {
      const { concurrency, workerConcurrency } = this.limits()
      const queued = this.listTasks()
        .filter((task) => task.status === 'queued' && !task.parked)
        .sort((a, b) => a.createdAt - b.createdAt)
      const normal = queued.filter((task) => !task.parentTaskId)
      const workers = queued.filter((task) => !!task.parentTaskId)
      while (this.runningNormal < Math.max(1, concurrency) && normal.length) {
        this.launch(normal.shift()!, false)
      }
      while (this.runningWorkers < Math.max(1, workerConcurrency ?? concurrency) && workers.length) {
        this.launch(workers.shift()!, true)
      }
    } finally {
      this.pumping = false
    }
  }

  private launch(task: Task, worker: boolean) {
    if (worker) this.runningWorkers++
    else this.runningNormal++
    void this.run(task.id).finally(() => {
      if (worker) this.runningWorkers--
      else this.runningNormal--
      this.pump()
    })
  }
}
