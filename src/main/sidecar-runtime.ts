import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_SETTINGS, type AppSettings, type Issue, type RunTrigger, type Task } from '../shared/types'
import { TaskStore } from './store'
import { IssueStore } from './issue-store'
import { GoalStore } from './goal-store'
import { GoalController } from './goal-controller'
import { TaskService } from './task-service'
import type { TaskCreateInput } from './task-service'
import { TaskRunner } from './runner'
import type { AgentBackend } from './backends/types'
import { prepareManualTaskStart } from './handoff'
import { createClaudeBackend } from './backends/claude'
import { createCodexBackend } from './backends/codex'
import { createDshBackend } from './backends/dsh'
import { createOpencodeBackend } from './backends/opencode'
import { createZcodeBackend } from './backends/zcode'

type SidecarAgent = { id: string; name: string; backend: string; role?: string; systemPrompt?: string; subordinates?: string[]; model?: string; presetId?: string; color?: string }

function readJson(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function loadSettings(userDataDir: string): AppSettings {
  const raw = readJson(path.join(userDataDir, 'settings.json'))
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...DEFAULT_SETTINGS, ...(raw as Partial<AppSettings>) } : { ...DEFAULT_SETTINGS }
}

function loadAgents(userDataDir: string): SidecarAgent[] {
  const raw = readJson(path.join(userDataDir, 'agents.json'))
  if (!Array.isArray(raw)) return []
  return raw.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const item = value as Partial<SidecarAgent>
    if (typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.backend !== 'string') return []
    return [{ ...item, id: item.id.trim(), name: item.name.trim(), backend: item.backend.trim() }]
  }).filter((agent) => agent.id && agent.name && agent.backend)
}

/**
 * Business-brain runtime owned by the sidecar process. Electron may retain its
 * compatibility runner while migration is in progress, but all sidecar RPC
 * task commands and projections use this instance and its durable stores.
 */
export class SidecarRuntime {
  readonly store: TaskStore
  readonly issueStore: IssueStore
  readonly goalStore: GoalStore
  readonly taskService: TaskService
  readonly runner: TaskRunner
  readonly goalController: GoalController
  readonly agents: SidecarAgent[]
  readonly settings: AppSettings
  private started = false

  constructor(readonly userDataDir: string) {
    this.settings = loadSettings(userDataDir)
    this.agents = loadAgents(userDataDir)
    this.store = new TaskStore(userDataDir, { recoverRunning: false })
    this.store.recoverDeadGitOperations()
    this.issueStore = new IssueStore(userDataDir)
    // A committed Task must keep the sidecar available while its Issue
    // projection retries. This also makes startup resilient to a transient
    // write/fsync/rename failure in the projection file.
    this.issueStore.syncEventually(this.store.list())
    const backends = new Map<string, AgentBackend>([
      ['claude', createClaudeBackend()],
      ['codex', createCodexBackend()],
      ['dsh', createDshBackend(() => ({ dshPath: this.settings.dshPath }))],
      ['opencode', createOpencodeBackend()],
      ['zcode', createZcodeBackend(() => ({ nodePath: this.settings.nodePath, zcodePath: this.settings.zcodePath }))]
    ])
    this.taskService = new TaskService({ store: this.store, issueStore: this.issueStore, getAgent: (id) => this.agents.find((agent) => agent.id === id) })
    this.runner = new TaskRunner(this.store, backends, () => ({
      concurrency: this.settings.concurrency,
      mode: this.settings.mode,
      notify: this.settings.notifyOnDone,
      workerConcurrency: this.settings.workerConcurrency,
      turnIdleTimeoutMs: this.settings.turnIdleTimeoutMs,
      permissionTimeoutMs: this.settings.permissionTimeoutMs,
      maxRetryAttempts: this.settings.maxRetryAttempts,
      retryBackoffMs: this.settings.retryBackoffMs,
      maxHandoffChain: this.settings.maxHandoffChain,
      delegateMaxRounds: this.settings.delegateMaxRounds,
      delegateMaxTotalRounds: this.settings.delegateMaxTotalRounds,
      delegateMaxDepth: this.settings.delegateMaxDepth,
      doomLoopThreshold: this.settings.doomLoopThreshold
    }), (task) => this.onTaskChanged(task), {
      send: () => {},
      notify: () => {},
      onTaskEvent: (taskId, event) => this.goalController?.onTaskEvent(taskId, event)
    })
    this.runner.attachTeam(() => this.agents)
    this.runner.attachTaskService(this.taskService)
    this.goalController = new GoalController(this.goalStore = new GoalStore(userDataDir), {
      createTask: (input) => this.taskService.createTask({ title: input.title, prompt: input.prompt, workdir: input.workdir, backend: input.backend, agentId: input.agentId, issueId: input.issueId, goalId: input.goalId, phaseIndex: input.phaseIndex, dedupeKey: input.dedupeKey, startNow: input.startNow }, input.trigger),
      enqueueTask: (task) => this.runner.enqueue(task),
      startTask: (task) => prepareManualTaskStart(this.store, task.id) ?? this.store.get(task.id) ?? task,
      cancelTask: (taskId) => this.runner.cancel(taskId),
      listTasks: () => this.store.list(),
      continueTask: (taskId, content) => this.runner.followUp(taskId, content),
      maxRetryAttempts: () => this.settings.maxRetryAttempts
    })
    this.runner.attachContinue(({ sourceTaskId, issueId, brief, start }) => {
      const source = this.store.get(sourceTaskId)
      const resolved = this.taskService.resolveHandoffTask({ sourceTaskId, issueId, brief, start })
      if (!resolved) return null
      const { task, created } = resolved
      if (!created) {
        this.onTaskChanged(task)
        return task
      }
      if (!task.parked && task.status === 'queued') this.runner.enqueue(task)
      else this.onTaskChanged(task)
      // 与主进程接线（index.ts attachContinue）对齐：停放的后继对用户是隐形的
      // （调度泵与重启对账都跳过 parked），sidecar 又没有 notifyTaskChanged 推送通道——
      // 落一条 Issue 评论把"等你启动"喊到用户看得到的地方，只在新建时追加。
      if (task.parked && task.issueId) {
        const firstLine = task.prompt.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? task.title
        const comment = this.issueStore.addComment(task.issueId, `⏸ 阶段接力已备好：${firstLine.slice(0, 80)}——下一阶段在等你启动（打开该 Issue 的最新执行，点「▶ 启动」）`, { type: 'agent', id: source?.agentId ?? 'relay' })
        if (!comment) {
          // null = Issue 已不存在：停放通知降级为后继任务事件留痕（sidecar 无推送通道，落盘即证据）
          const event = this.store.appendEvent(task.id, { ts: Date.now(), kind: 'status', text: `⚠ 停放通知未送达（Issue 不存在）：阶段接力已备好，等用户启动` })
          if (event) this.runner.pushEvent(task.id, event)
        }
      }
      return task
    })
  }

  private onTaskChanged(task: Task) {
    this.issueStore.syncEventually(this.store.list())
    this.goalController.onTaskChanged(task)
  }

  /** Sidecar equivalent of issues:create: return an Issue-shaped view even if
   * its durable projection is temporarily unavailable. */
  createIssue(input: TaskCreateInput, trigger: RunTrigger = input.trigger ?? 'assignment'): Issue {
    const task = this.taskService.createTask(input, trigger)
    this.issueStore.syncTaskEventually(task)
    if (input.startNow !== false) this.runner.enqueue(task)
    return this.issueStore.issueForTask(task)
  }

  state() {
    // During the compatibility migration main may still create/update Tasks.
    // Before this runtime owns execution, refresh projections from the durable
    // files so state.sync never serves a stale in-memory snapshot.
    if (!this.started) this.refreshAfterTakeover()
    const issues = this.issueStore.list()
    const goals = this.goalController.list()
    return {
      tasks: this.store.list(),
      issues,
      runs: issues.flatMap((issue) => this.issueStore.runs(issue.id)),
      goals,
      checkpoints: goals.flatMap((goal) => this.goalController.checkpoints(goal.id)),
      specSnapshots: goals.flatMap((goal) => this.goalController.snapshots(goal.id)),
      specDecisions: goals.flatMap((goal) => this.goalController.decisions(goal.id)),
      specApprovals: goals.flatMap((goal) => this.goalStore.specApprovals(goal.id)),
      goalEvents: goals.flatMap((goal) => this.goalStore.events(goal.id))
    }
  }

  start() {
    if (this.started) return
    this.started = true
    for (const task of this.store.list()) if (task.status === 'queued' && !task.parked) this.runner.enqueue(task)
  }

  /**
   * Adopt orphan runs. This is the single takeover entry point: the store
   * probes the recorded execution owner outside the lock and conditionally
   * commits the exact observed run, so only a provably dead owner is claimed
   * and a claim can happen exactly once. An alive or unreadable identity is
   * never taken over, and an expired lease is not death evidence.
   */
  takeoverRuns(ids?: readonly string[]): Task[] {
    const adopted = this.store.recoverDeadRuns('queued', ids)
    if (adopted.length) this.refreshAfterTakeover()
    return adopted
  }

  refreshAfterTakeover() {
    this.store.reload()
    this.issueStore.syncEventually(this.store.list())
  }

  refreshIfIdle() {
    if (!this.started) this.refreshAfterTakeover()
  }

  async close() { await this.runner.shutdown(); this.store.flush(); this.issueStore.close() }
}
