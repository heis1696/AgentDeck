// 共享类型：主进程与渲染层之间的数据契约

export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

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

export interface AppSettings {
  zcodePath: string // zcode.cjs 路径
  dshPath: string // deepseek-harness bin.js 路径（留空自动扫描）
  nodePath: string // 用来跑 zcode.cjs 的 node；空 = process.execPath 或 PATH 上的 node
  concurrency: number
  notifyOnDone: boolean
  mode: 'yolo' | 'build' | 'edit' | 'plan'
  workerConcurrency: number
}

export const DEFAULT_SETTINGS: AppSettings = {
  zcodePath: '',
  dshPath: '',
  nodePath: '',
  concurrency: 1,
  notifyOnDone: true,
  mode: 'yolo',
  workerConcurrency: 3
}
