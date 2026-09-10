// 共享类型：主进程与渲染层之间的数据契约

export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

/** Backends shipped by the main process. Keep string compatibility at IPC boundaries. */
export type BackendId = 'zcode' | 'claude' | 'codex' | 'opencode' | 'dsh'
export const BACKEND_IDS: readonly BackendId[] = ['zcode', 'claude', 'codex', 'opencode', 'dsh']

export function isTaskStatus(value: unknown): value is TaskStatus {
  return value === 'queued' || value === 'running' || value === 'done' || value === 'failed' || value === 'cancelled'
}

/** Issue is the durable unit of work. A task is retained as the execution adapter during migration. */
export type IssueStatus = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'blocked' | 'cancelled'
export type IssuePriority = 'urgent' | 'high' | 'medium' | 'low' | 'none'
export type RunStatus = 'running' | 'completed' | 'cancelled' | 'error'
export type RunTrigger = 'assignment' | 'mention' | 'autopilot' | 'manual' | 'handoff'

/** Lifecycle of a durable, multi-run user goal. */
export type GoalStatus = 'draft' | 'active' | 'waiting_user' | 'completed' | 'blocked' | 'cancelled' | 'failed'

export function isGoalStatus(value: unknown): value is GoalStatus {
  return value === 'draft' || value === 'active' || value === 'waiting_user' || value === 'completed'
    || value === 'blocked' || value === 'cancelled' || value === 'failed'
}

/** Durable product model for a long-running objective. */
export interface Goal {
  id: string
  /** A Goal always belongs to one Issue and reuses that Issue's execution history. */
  issueId: string
  text: string
  completionConditions: string[]
  stopConditions: string[]
  maxRuns: number
  maxDurationMs: number
  status: GoalStatus
  runCount: number
  totalDurationMs: number
  /** 连续非重试失败次数（自动续轮上限用；续轮成功后清零） */
  failures?: number
  /** SHA-256 signature of the latest visible AI output. */
  progressKey?: string
  /** Consecutive terminal runs with the same progressKey. */
  noProgress?: number
  /** Maximum consecutive no-progress runs before human intervention. */
  noProgressCap?: number
  /** Consecutive checker blocks for this Goal. */
  blockCount?: number
  /** Maximum consecutive checker blocks before human intervention. */
  blockCap?: number
  /** Stable machine-readable reason for the latest guard decision. */
  stopReason?: string
  currentRunId?: string
  agentId?: string
  backend?: string
  workdir?: string
  blockedReason?: string
  createdAt: number
  updatedAt: number
}

export interface IssueAssignee {
  type: 'agent' | 'user'
  id: string
}

export interface Issue {
  id: string
  identifier: string
  title: string
  description: string
  status: IssueStatus
  /** Human workflow override for terminal executions (for example in_review -> done). */
  statusOverride?: IssueStatus
  priority: IssuePriority
  assignee?: IssueAssignee
  parentIssueId?: string
  projectId?: string
  labels: string[]
  dueDate?: number
  position: number
  createdBy: string
  createdAt: number
  updatedAt: number
  /** Compatibility link to the task execution record. */
  taskId: string
}

export interface Run {
  id: string
  issueId: string
  taskId: string
  agentId?: string
  trigger: RunTrigger
  prompt: string
  status: RunStatus
  startedAt?: number
  finishedAt?: number
  durationMs?: number
  usage?: TaskUsage
  transcriptEventCount: number
  /** Goal execution metadata; omitted for ordinary Issue runs. */
  goalId?: string
  phaseIndex?: number
}

/** A Run projected as one phase of a Goal. */
export interface GoalRun extends Run {
  goalId: string
  phaseIndex: number
}

/** Durable summary emitted at the end of each Goal phase. */
export interface GoalCheckpoint {
  id: string
  goalId: string
  runId: string
  phaseIndex: number
  summary: string
  completedConditions: string[]
  incompleteConditions: string[]
  nextPlan: string
  blockers: string[]
  createdAt: number
  durationMs?: number
  usage?: TaskUsage
}

/**
 * Internal execution boundary used while Task remains the on-disk/IPC
 * compatibility shape.  A record describes one concrete attempt; Run is the
 * user-facing projection that may outlive and group several Tasks.
 */
export interface ExecutionRecord {
  id: string
  issueId: string
  taskId: string
  agentId?: string
  trigger: RunTrigger
  prompt: string
  status: RunStatus
  startedAt?: number
  finishedAt?: number
  durationMs?: number
  usage?: TaskUsage
  transcriptEventCount: number
  goalId?: string
  phaseIndex?: number
}

export interface Comment {
  id: string
  issueId: string
  author: IssueAssignee
  content: string
  reactions: string[]
  /** The execution that produced an agent report, when applicable. */
  runId?: string
  createdAt: number
}

export interface Notification {
  id: string
  userId: string
  issueId: string
  kind: 'reported' | 'mentioned' | 'status' | 'assigned'
  runId?: string
  read: boolean
  createdAt: number
}

export interface Automation {
  id: string
  name: string
  prompt: string
  workdir: string
  agentId?: string
  scheduleMinutes: number
  output: 'issue' | 'run_only'
  enabled: boolean
  createdAt: number
  lastRunAt?: number
  nextRunAt?: number
}

/** Runtime health snapshot exposed by the main process. A runtime maps to one
 * registered backend/CLI provider and is intentionally independent from an
 * agent, so several agents can share the same runtime. */
export type RuntimeHealth = 'online' | 'offline' | 'degraded' | 'unknown'

export interface RuntimeSnapshot {
  id: string
  label: string
  backend: string
  kind: 'local' | 'cloud'
  health: RuntimeHealth
  detail: string
  version?: string
  activeTaskCount: number
  checkedAt: number
}

export interface UsageAggregate {
  runs: number
  completed: number
  failed: number
  cancelled: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  costUsd: number
  durationMs: number
}

export interface ErrorAggregate {
  code: FailureInfo['code']
  title: string
  count: number
  retryable: boolean
  lastSeenAt?: number
}

export interface AnalyticsSummary {
  since?: number
  until: number
  generatedAt: number
  totals: UsageAggregate
  byBackend: Array<UsageAggregate & { key: string; label: string }>
  byAgent: Array<UsageAggregate & { key: string; label: string }>
  errors: ErrorAggregate[]
}

/** 失败分类（main/failure.ts 产出；code 稳定，文案可变） */
export interface FailureInfo {
  code:
    | 'cli_missing' | 'protocol_config' | 'provider_auth' | 'provider_quota' | 'rate_limit'
    | 'output_limit' | 'context_overflow' | 'timeout' | 'sandbox' | 'process_crash' | 'unknown'
  title: string
  hint: string
  retryable: boolean
}

/** 领队任务的 git 集成结果 */
export interface IntegrationInfo {
  /** 集成分支名（repo 任务用） */
  branch?: string
  /** 集成结果说明（冲突等） */
  note?: string
}

/** Durable ownership and cleanup record for an isolated delegate worktree. */
export type WorktreeCleanupStatus = 'active' | 'removed' | 'retained' | 'failed'

export interface WorktreeInfo {
  ownerTaskId: string
  repoDir: string
  path: string
  branch: string
  baseSha: string
  createdAt: number
  cleanupStatus: WorktreeCleanupStatus
  cleanupReason?: string
  cleanedAt?: number
  manualKeep?: boolean
}

/** 任务累计用量（finalize 时从 events 聚合） */
export interface TaskUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  costUsd: number
  durationMs: number
  /** usage 事件条数（≈回合数） */
  turns: number
}

export interface Task {
  id: string
  title: string
  prompt: string
  /** 任务绑定的本地目录（agent 的工作目录）；空字符串表示无绑定 */
  workdir: string
  /** 执行后端 id: zcode | claude | codex | opencode | dsh */
  backend: string
  /** 执行队员（agent 身份）；空 = 默认 zcode 队员 */
  agentId?: string
  /** 触发这次执行的产品动作，映射到 Issue 的 Run。 */
  trigger?: RunTrigger
  /** Durable issue that owns this execution. Added in the issue/run migration. */
  issueId?: string
  /** Run-only automation executions stay in task logs without creating an Issue. */
  suppressIssue?: boolean
  /** Unique execution instance used to preserve Run history across retries/follow-ups. */
  runId?: string
  /** Goal that owns this execution, when the task is one goal phase. */
  goalId?: string
  /** Zero-based phase number within the owning Goal. */
  phaseIndex?: number
  /** 委派子任务专用：指向领队任务 */
  parentTaskId?: string
  /** 委派子任务专用：序号（展示用） */
  workerIndex?: number
  /** Worktree 创建失败或工作区非 Git 时的显式降级原因。 */
  unavailableReason?: string
  /** 隔离 worktree 的 durable owner/base/cleanup metadata。 */
  worktree?: WorktreeInfo
  /** 领队任务专用：git 集成结果 */
  integration?: IntegrationInfo
  status: TaskStatus
  createdAt: number
  startedAt?: number
  endedAt?: number
  /** agent 的最终回复 */
  result?: string
  /** 失败原因 */
  error?: string
  /** 失败分类（error 的人话解读） */
  failure?: FailureInfo
  /** 自动重试次数（0/缺省 = 首次；仅 retryable 失败自动 +1，上限 2） */
  attempt?: number
  /** 委派循环已用轮数（二层委派共享预算用） */
  roundsUsed?: number
  /** 交接备注（本次执行重点，创建时填写，注入 prompt） */
  handoff?: string
  /** 阶段接力来源（<continue> 后继指向其前一阶段执行；同 issue 串行链） */
  continuesFrom?: string
  /** 暂不启动：创建后停放在队列外，等用户手动开始 */
  parked?: boolean
  /** Background work is still running; Goal evaluation must defer. */
  backgroundRunning?: boolean
  /** 标题由 prompt 首行自动派生（非用户拟定）：首轮完成后由 agent 总结重起，重命名后失效 */
  titleAuto?: boolean
  /** zcode 会话 id，用于续聊 */
  sessionId?: string
  /** Stable snapshot of task content used to invalidate stale approvals. */
  workVersion?: string
  /** 完成时抓取的 git 改动 */
  gitDiff?: string
  gitStat?: string
  /** 完成时聚合的累计用量 */
  usage?: TaskUsage
  /** 事件条数（详情按需加载） */
  eventCount: number
}

/** 执行日志条目（落盘 events.jsonl，UI 逐条渲染） */
export interface TaskEvent {
  seq: number
  ts: number
  /** Persisted event schema version. `v` is the wire/on-disk spelling. */
  v?: number
  /** Read-side alias accepted for callers that use a descriptive name. */
  version?: number
  /** Stable producer id used to make retries of an append idempotent. */
  id?: string
  eventId?: string
  /** Provider event name, when `kind` is only a compatibility category. */
  type?: string
  /** Original kind retained when an unknown provider event is normalized to raw. */
  rawKind?: string
  /** Whether the event is only an in-memory stream update or a durable record. */
  durability?: TaskEventDurability
  /** OpenCode-style durable declaration. `false` is accepted for live events. */
  durable?: TaskEventDurableMetadata | boolean
  /** Aggregate metadata for durable event streams. */
  aggregate?: TaskEventAggregateMetadata | string
  kind: TaskEventKind
  text?: string
  data?: unknown
}

/** Stable manifest for the compatibility `kind` field. Provider-specific
 * names remain in TASK_EVENT_MANIFEST below, while this list drives legacy
 * event normalization. */
export const TASK_EVENT_KINDS = ['user', 'status', 'text', 'final', 'tool', 'usage', 'error', 'raw'] as const
export type TaskEventKind = typeof TASK_EVENT_KINDS[number]
export function isTaskEventKind(value: unknown): value is TaskEventKind {
  return typeof value === 'string' && (TASK_EVENT_KINDS as readonly string[]).includes(value)
}

/** Event schema version written by the local EventLog. */
export const TASK_EVENT_SCHEMA_VERSION = 1 as const

export type TaskEventDurability = 'durable' | 'live'

/** Durable metadata follows the OpenCode event contract while remaining optional. */
export interface TaskEventDurableMetadata {
  aggregate: string
  aggregateId?: string
  seq?: number
  version: number
}

export interface TaskEventAggregateMetadata {
  aggregate?: string
  id?: string
  seq?: number
  version?: number
}

/** Single source of truth for the provider event names with special replay semantics. */
export const TASK_EVENT_MANIFEST = {
  'text.delta': 'live',
  'reasoning.delta': 'live',
  'tool.input.delta': 'live',
  'compaction.delta': 'live',
  'text.ended': 'durable',
  'tool.result': 'durable',
  'tool.success': 'durable',
  'tool.error': 'durable'
} as const

function taskEventDataRecord(event: Pick<TaskEvent, 'data'>): Record<string, unknown> | undefined {
  return event.data && typeof event.data === 'object' && !Array.isArray(event.data)
    ? event.data as Record<string, unknown>
    : undefined
}

/** Return the provider event name used to select a manifest entry. */
export function taskEventType(event: Pick<TaskEvent, 'type' | 'data'>): string | undefined {
  if (typeof event.type === 'string' && event.type) return event.type
  const data = taskEventDataRecord(event)
  for (const key of ['type', 'eventType', 'event']) {
    if (typeof data?.[key] === 'string' && data[key]) return data[key] as string
  }
  return undefined
}

/** Stream fragments are live-only; old `kind: text` events remain durable. */
export function isTaskEventLiveOnly(event: Pick<TaskEvent, 'kind' | 'type' | 'data' | 'durability' | 'durable'>): boolean {
  if (event.durability === 'live' || event.durable === false) return true
  if (event.durability === 'durable' || event.durable === true || (event.durable && typeof event.durable === 'object')) return false
  const type = taskEventType(event)
  return !!type && TASK_EVENT_MANIFEST[type as keyof typeof TASK_EVENT_MANIFEST] === 'live'
}

export function isTaskEventDurable(event: Pick<TaskEvent, 'kind' | 'type' | 'data' | 'durability' | 'durable'>): boolean {
  return !isTaskEventLiveOnly(event)
}

export type Theme = 'dark' | 'light' | 'system'

export interface AppSettings {
  theme: Theme
  zcodePath: string // zcode.cjs 路径
  dshPath: string // deepseek-harness bin.js 路径（留空自动扫描）
  nodePath: string // 用来跑 zcode.cjs 的 node；空 = process.execPath 或 PATH 上的 node
  concurrency: number
  notifyOnDone: boolean
  mode: 'yolo' | 'build' | 'edit' | 'plan'
  workerConcurrency: number
  sharedDir: string // 共享目录（技能库）；空串 = 默认 ~/.agentdeck，实际路径解析集中在主进程
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'light',
  zcodePath: '',
  dshPath: '',
  nodePath: '',
  concurrency: 1,
  notifyOnDone: true,
  mode: 'yolo',
  workerConcurrency: 3,
  sharedDir: ''
}
