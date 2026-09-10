import fs from 'node:fs'
import path from 'node:path'
import { isGoalStatus, type Goal, type GoalCheckpoint, type GoalRun, type GoalStatus, type Task, type TaskUsage } from '../shared/types'
import { executionRecordFromTask } from '../shared/taskflow'

/** Versioned durable index for long-running goals. */
export const GOAL_INDEX_SCHEMA_VERSION = 1 as const

export interface GoalIndexDocument {
  schemaVersion: typeof GOAL_INDEX_SCHEMA_VERSION
  goals: Goal[]
  runs: GoalRun[]
  checkpoints: GoalCheckpoint[]
}

export interface GoalCreateRecord {
  issueId: string
  text: string
  completionConditions: string[]
  stopConditions: string[]
  maxRuns: number
  maxDurationMs: number
  blockCap?: number
  noProgressCap?: number
  workdir: string
  agentId?: string
  backend?: string
  status?: GoalStatus
}

export interface GoalCheckpointRecord {
  goalId: string
  runId: string
  phaseIndex: number
  summary: string
  completedConditions: string[]
  incompleteConditions: string[]
  nextPlan: string
  blockers: string[]
  createdAt?: number
  durationMs?: number
  usage?: TaskUsage
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean) : []
}

function validGoal(value: unknown): value is Goal {
  if (!record(value)) return false
  return typeof value.id === 'string' && !!value.id
    && typeof value.issueId === 'string' && !!value.issueId
    && typeof value.text === 'string'
    && Array.isArray(value.completionConditions) && Array.isArray(value.stopConditions)
    && typeof value.maxRuns === 'number' && Number.isFinite(value.maxRuns)
    && typeof value.maxDurationMs === 'number' && Number.isFinite(value.maxDurationMs)
    && isGoalStatus(value.status)
    && typeof value.runCount === 'number' && typeof value.totalDurationMs === 'number'
    && typeof value.createdAt === 'number' && typeof value.updatedAt === 'number'
}

/**
 * Goal metadata is intentionally kept separate from tasks.json. Writes use
 * the same temporary-file + rename discipline as TaskStore/IssueStore.
 */
export class GoalStore {
  private readonly dir: string
  private readonly file: string
  private data: GoalIndexDocument = { schemaVersion: GOAL_INDEX_SCHEMA_VERSION, goals: [], runs: [], checkpoints: [] }

  constructor(userDataDir: string) {
    this.dir = path.join(userDataDir, 'goals')
    this.file = path.join(this.dir, 'index.json')
    fs.mkdirSync(this.dir, { recursive: true })
    this.load()
  }

  private load() {
    let raw: string
    try {
      raw = fs.readFileSync(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    try {
      const parsed = JSON.parse(raw) as Partial<GoalIndexDocument>
      if (parsed.schemaVersion !== GOAL_INDEX_SCHEMA_VERSION) {
        throw new Error(`Unsupported goal index schema version: ${String(parsed.schemaVersion)}`)
      }
      const goals = Array.isArray(parsed.goals) ? parsed.goals.filter(validGoal).map((goal) => ({
        ...goal,
        completionConditions: stringArray(goal.completionConditions),
        stopConditions: stringArray(goal.stopConditions),
        runCount: Number.isFinite(goal.runCount) ? goal.runCount : 0,
        totalDurationMs: Number.isFinite(goal.totalDurationMs) ? goal.totalDurationMs : 0,
        noProgress: typeof goal.noProgress === 'number' && Number.isFinite(goal.noProgress) ? Math.max(0, goal.noProgress) : 0,
        noProgressCap: typeof goal.noProgressCap === 'number' && Number.isFinite(goal.noProgressCap) && goal.noProgressCap > 0 ? Math.floor(goal.noProgressCap) : 2,
        blockCount: typeof goal.blockCount === 'number' && Number.isFinite(goal.blockCount) ? Math.max(0, goal.blockCount) : 0,
        blockCap: typeof goal.blockCap === 'number' && Number.isFinite(goal.blockCap) && goal.blockCap > 0 ? Math.floor(goal.blockCap) : 8,
        ...(typeof goal.progressKey === 'string' && goal.progressKey ? { progressKey: goal.progressKey } : {}),
        ...(typeof goal.stopReason === 'string' && goal.stopReason ? { stopReason: goal.stopReason } : {})
      })) : []
      const runs = Array.isArray(parsed.runs) ? parsed.runs.filter((run): run is GoalRun => record(run)
        && typeof run.id === 'string' && !!run.id
        && typeof run.goalId === 'string' && !!run.goalId
        && typeof run.phaseIndex === 'number' && Number.isInteger(run.phaseIndex) && run.phaseIndex >= 0
        && typeof run.issueId === 'string' && !!run.issueId
        && typeof run.taskId === 'string' && !!run.taskId
        && typeof run.trigger === 'string'
        && typeof run.prompt === 'string'
        && typeof run.transcriptEventCount === 'number'
        && (run.status === 'running' || run.status === 'completed' || run.status === 'cancelled' || run.status === 'error')) : []
      const checkpoints = Array.isArray(parsed.checkpoints) ? parsed.checkpoints.filter((cp): cp is GoalCheckpoint => record(cp)
        && typeof cp.id === 'string' && !!cp.id
        && typeof cp.goalId === 'string' && !!cp.goalId
        && typeof cp.runId === 'string' && !!cp.runId
        && typeof cp.phaseIndex === 'number' && Number.isInteger(cp.phaseIndex) && cp.phaseIndex >= 0
        && typeof cp.summary === 'string').map((cp) => ({
        ...cp,
        completedConditions: stringArray(cp.completedConditions),
        incompleteConditions: stringArray(cp.incompleteConditions),
        blockers: stringArray(cp.blockers),
        nextPlan: typeof cp.nextPlan === 'string' ? cp.nextPlan : ''
      })) : []
      this.data = { schemaVersion: GOAL_INDEX_SCHEMA_VERSION, goals, runs, checkpoints }
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error))
    }
  }

  private save() {
    fs.mkdirSync(this.dir, { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2))
    fs.renameSync(tmp, this.file)
  }

  private id(prefix: string) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  }

  list() {
    return [...this.data.goals].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get(id: string) {
    return this.data.goals.find((goal) => goal.id === id) ?? null
  }

  create(input: GoalCreateRecord): Goal {
    const now = Date.now()
    const goal: Goal = {
      id: this.id('goal'),
      issueId: input.issueId,
      text: input.text,
      completionConditions: [...input.completionConditions],
      stopConditions: [...input.stopConditions],
      maxRuns: input.maxRuns,
      maxDurationMs: input.maxDurationMs,
      blockCap: input.blockCap ?? 8,
      status: input.status ?? 'draft',
      runCount: 0,
      totalDurationMs: 0,
      noProgress: 0,
      noProgressCap: input.noProgressCap ?? 2,
      blockCount: 0,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.backend ? { backend: input.backend } : {}),
      ...(input.workdir ? { workdir: input.workdir } : {}),
      createdAt: now,
      updatedAt: now
    }
    this.data.goals.push(goal)
    this.save()
    return goal
  }

  update(id: string, patch: Partial<Omit<Goal, 'id' | 'createdAt'>>): Goal | null {
    const goal = this.get(id)
    if (!goal) return null
    Object.assign(goal, patch, { updatedAt: Date.now() })
    this.save()
    return goal
  }

  /** 删除目标及其全部运行/检查点记录（「清除目标模式」用）；id 不存在返回 false */
  delete(id: string): boolean {
    const before = this.data.goals.length
    this.data.goals = this.data.goals.filter((goal) => goal.id !== id)
    if (this.data.goals.length === before) return false
    this.data.runs = this.data.runs.filter((run) => run.goalId !== id)
    this.data.checkpoints = this.data.checkpoints.filter((checkpoint) => checkpoint.goalId !== id)
    this.save()
    return true
  }

  runs(goalId: string): GoalRun[] {
    return this.data.runs.filter((run) => run.goalId === goalId).sort((a, b) => (a.phaseIndex - b.phaseIndex) || ((a.startedAt ?? 0) - (b.startedAt ?? 0)))
  }

  getRun(id: string) {
    return this.data.runs.find((run) => run.id === id) ?? null
  }

  /** Upsert is keyed by execution id so repeated TaskChanged events are safe. */
  upsertRun(run: GoalRun): GoalRun {
    const current = this.getRun(run.id)
    if (current) Object.assign(current, run)
    else this.data.runs.push({ ...run })
    this.save()
    return current ?? run
  }

  /** Project the compatibility Task shape into a goal-owned Run. */
  upsertRunFromTask(task: Task): GoalRun | null {
    if (!task.goalId) return null
    const execution = executionRecordFromTask(task)
    const run: GoalRun = {
      ...execution,
      goalId: task.goalId,
      phaseIndex: task.phaseIndex ?? this.runs(task.goalId).length
    }
    return this.upsertRun(run)
  }

  checkpoints(goalId: string): GoalCheckpoint[] {
    return this.data.checkpoints.filter((checkpoint) => checkpoint.goalId === goalId).sort((a, b) => (a.phaseIndex - b.phaseIndex) || (a.createdAt - b.createdAt))
  }

  checkpointForRun(runId: string) {
    return this.data.checkpoints.find((checkpoint) => checkpoint.runId === runId) ?? null
  }

  /** Persist exactly one checkpoint for each phase/run. */
  addCheckpoint(input: GoalCheckpointRecord): GoalCheckpoint {
    const existing = this.checkpointForRun(input.runId)
    const checkpoint: GoalCheckpoint = {
      id: existing?.id ?? this.id('checkpoint'),
      goalId: input.goalId,
      runId: input.runId,
      phaseIndex: input.phaseIndex,
      summary: input.summary,
      completedConditions: [...input.completedConditions],
      incompleteConditions: [...input.incompleteConditions],
      nextPlan: input.nextPlan,
      blockers: [...input.blockers],
      createdAt: existing?.createdAt ?? input.createdAt ?? Date.now(),
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      ...(input.usage ? { usage: input.usage } : {})
    }
    if (existing) Object.assign(existing, checkpoint)
    else this.data.checkpoints.push(checkpoint)
    this.save()
    return existing ?? checkpoint
  }

  /** Tests and restart recovery can force a clean reload. */
  reload() {
    this.load()
  }
}
