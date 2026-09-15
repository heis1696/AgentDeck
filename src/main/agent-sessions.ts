import type { RunTrigger, Task } from '../shared/types'
import type { AgentLike } from './delegate'
import type { TaskCreateInput, TaskService } from './task-service'
import type { TaskStore } from './store'

export interface OfficeFollowUpResult {
  ok: boolean
  error?: string
  finalText?: string
}

export interface OfficeDeliveryResult extends OfficeFollowUpResult {
  taskId?: string
  created?: boolean
}

export interface OfficeRunner {
  enqueue(task: Task): void
  followUp(taskId: string, content: string, opts?: { collectFinal?: boolean; consultDepth?: number }): Promise<OfficeFollowUpResult>
}

export interface AgentSessionRegistryOptions {
  store: Pick<TaskStore, 'get' | 'update'>
  taskService: Pick<TaskService, 'createTask' | 'deduped'>
  runner: OfficeRunner
  getAgents: () => AgentLike[]
  /** Override the first-turn prompt in tests or a host-specific integration. */
  officePrompt?: (agent: AgentLike) => string
  waitPollMs?: number
  waitTimeoutMs?: number
}

/**
 * Durable one-task-per-agent office sessions used by consult and meetings.
 * The registry owns only office-task serialization; ordinary tasks for the
 * same agent continue to use the normal runner/scheduler independently.
 */
export class AgentSessionRegistry {
  private readonly store: Pick<TaskStore, 'get' | 'update'>
  private readonly taskService: Pick<TaskService, 'createTask' | 'deduped'>
  private readonly runner: OfficeRunner
  private readonly getAgents: () => AgentLike[]
  private readonly officePrompt: (agent: AgentLike) => string
  private readonly waitPollMs: number
  private readonly waitTimeoutMs: number
  private readonly locks = new Map<string, Promise<void>>()
  private disposed = false

  constructor(options: AgentSessionRegistryOptions) {
    this.store = options.store
    this.taskService = options.taskService
    this.runner = options.runner
    this.getAgents = options.getAgents
    this.officePrompt = options.officePrompt ?? ((agent) => [
      `【办公室会话】这是 ${agent.name} 的长期工作会话。`,
      agent.role ? `你的定位：${agent.role}` : '',
      agent.systemPrompt?.trim() ?? '',
      '后续收到的任务消息请直接处理并给出最终答复。'
    ].filter(Boolean).join('\n'))
    this.waitPollMs = Math.max(5, options.waitPollMs ?? 100)
    this.waitTimeoutMs = Math.max(this.waitPollMs, options.waitTimeoutMs ?? 10 * 60 * 1000)
  }

  /** Return a persisted office task without creating or starting anything. */
  get(agentId: string): Task | null {
    const key = this.key(agentId)
    return this.taskService.deduped(key) ?? null
  }

  /** Create/recover an office task and make sure its bootstrap turn finished. */
  async ensure(agentId: string, options?: { workdir?: string }): Promise<Task> {
    if (this.disposed) throw new Error('办公室会话注册表已关闭')
    const agent = this.resolveAgent(agentId)
    let task = this.get(agent.id)
    if (!task) {
      const input: TaskCreateInput = {
        title: `${agent.name}·办公室`,
        prompt: this.officePrompt(agent),
        backend: agent.backend,
        agentId: agent.id,
        workdir: options?.workdir ?? '',
        trigger: 'meeting' as RunTrigger,
        suppressIssue: true,
        titleAuto: false,
        dedupeKey: this.key(agent.id)
      }
      task = this.taskService.createTask(input, 'meeting')
    }

    if (task.status === 'queued') {
      if (task.parked) {
        // An office task is controlled by this registry, never by the parked
        // UI queue. Clear a stale flag before handing it to the runner.
        this.store.update(task.id, { parked: undefined })
        task = this.store.get(task.id) ?? task
      }
      this.runner.enqueue(task)
    }

    task = await this.waitForTerminal(task.id)
    return task
  }

  /** Serialize one office agent while leaving other agents and normal tasks free. */
  async followUp(agentId: string, content: string, opts?: { collectFinal?: boolean; consultDepth?: number }): Promise<OfficeFollowUpResult> {
    const agent = this.resolveAgent(agentId)
    return this.withLock(agent.id, async () => {
      const task = await this.ensure(agent.id)
      return this.runner.followUp(task.id, content, { collectFinal: opts?.collectFinal ?? true, consultDepth: opts?.consultDepth ?? 0 })
    })
  }

  async ensureOffice(agentId: string, options?: { workdir?: string }): Promise<Task> { return this.ensure(agentId, options) }

  async deliver(agentId: string, content: string): Promise<OfficeDeliveryResult> {
    const existing = this.get(agentId)
    const result = await this.followUp(agentId, content, { collectFinal: true })
    const task = this.get(agentId)
    return { ...result, ...(task ? { taskId: task.id } : {}), created: !existing && !!task }
  }

  officeTask(agentId: string): Task | null { return this.get(agentId) }
  pendingTurns(agentId: string): number { return this.locks.has(agentId) ? 1 : 0 }
  dispose() { this.disposed = true; this.locks.clear() }

  /** Resolve a displayed team name/backend/id to an office session target. */
  resolve(ref: string, excludeAgentId?: string): AgentLike | null {
    const needle = ref.trim().toLowerCase()
    return this.getAgents().find((agent) => {
      const isCaptain = agent.role?.includes('队长') || agent.role?.includes('领队') || (agent.subordinates?.length ?? 0) > 0
      return agent.id !== excludeAgentId && !!isCaptain && (
        agent.id.toLowerCase() === needle ||
        agent.name.toLowerCase() === needle ||
        agent.backend.toLowerCase() === needle
      )
    }) ?? null
  }

  list(): Task[] {
    return this.getAgents()
      .map((agent) => this.get(agent.id))
      .filter((task): task is Task => !!task)
  }

  private key(agentId: string) {
    return `office_${agentId}`
  }

  private resolveAgent(agentId: string): AgentLike {
    const agent = this.getAgents().find((candidate) => candidate.id === agentId)
    if (!agent) throw new Error(`办公室队长不存在: ${agentId}`)
    if (agent.backend.toLowerCase() === 'dsh') throw new Error('DeepSeek Harness 不支持跨重启续聊，不能进入办公室会话')
    return agent
  }

  private async waitForTerminal(taskId: string): Promise<Task> {
    const deadline = Date.now() + this.waitTimeoutMs
    for (;;) {
      const task = this.store.get(taskId)
      if (!task) throw new Error(`办公室任务已消失: ${taskId}`)
      if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') return task
      if (Date.now() >= deadline) throw new Error(`办公室首回合超时: ${taskId}`)
      await new Promise((resolve) => setTimeout(resolve, this.waitPollMs))
    }
  }

  private async withLock<T>(agentId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(agentId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    const chain = previous.then(() => current)
    this.locks.set(agentId, chain)
    await previous
    try {
      return await action()
    } finally {
      release()
      if (this.locks.get(agentId) === chain) this.locks.delete(agentId)
    }
  }
}
