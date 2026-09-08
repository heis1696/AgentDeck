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
  /** 标题由 prompt 首行自动派生（非用户拟定）：首轮完成后由 agent 总结重起，重命名后失效 */
  titleAuto?: boolean
  /** zcode 会话 id，用于续聊 */
  sessionId?: string
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
  kind:
    | 'user' // 用户输入（首条 prompt / 追问），对话视图按它分回合
    | 'status' // 状态变化/请求状态
    | 'text' // 流式文本增量
    | 'final' // 回合最终回复
    | 'tool' // 工具调用
    | 'usage' // token 用量
    | 'error'
    | 'raw' // 其他协议事件
  text?: string
  data?: unknown
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
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'light',
  zcodePath: '',
  dshPath: '',
  nodePath: '',
  concurrency: 1,
  notifyOnDone: true,
  mode: 'yolo',
  workerConcurrency: 3
}
