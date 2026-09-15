import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_SETTINGS, type AppSettings, type Task } from '../shared/types'
import { TaskStore } from './store'
import { IssueStore } from './issue-store'
import { GoalStore } from './goal-store'
import { GoalController } from './goal-controller'
import { TaskService } from './task-service'
import { TaskRunner } from './runner'
import type { AgentBackend } from './backends/types'
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
    this.issueStore = new IssueStore(userDataDir)
    this.issueStore.sync(this.store.list())
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
      startTask: (task) => { this.store.update(task.id, { parked: undefined }); return this.store.get(task.id)! },
      cancelTask: (taskId) => this.runner.cancel(taskId),
      listTasks: () => this.store.list(),
      continueTask: (taskId, content) => this.runner.followUp(taskId, content),
      maxRetryAttempts: () => this.settings.maxRetryAttempts
    })
    this.runner.attachContinue(({ sourceTaskId, issueId, brief, start }) => {
      const task = this.taskService.createHandoffTask({ sourceTaskId, issueId, brief, start })
      if (task && start !== 'parked') this.runner.enqueue(task)
      return task
    })
  }

  private onTaskChanged(task: Task) {
    this.issueStore.sync(this.store.list())
    this.goalController.onTaskChanged(task)
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

  refreshAfterTakeover() {
    this.store.reload()
    this.issueStore.sync(this.store.list())
  }

  refreshIfIdle() {
    if (!this.started) this.refreshAfterTakeover()
  }

  async close() { await this.runner.shutdown(); this.store.flush() }
}
