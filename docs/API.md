# AgentDeck API 文档

> 对齐 v0.13.x。本文描述四层接口：渲染层 IPC 桥（`window.agentdeck`，契约定义在 `src/shared/contracts.ts`）、主进程内部模块、后端适配器接口（扩展点）、委派/目标协议。

---

## 1. 渲染层 IPC 桥（`window.agentdeck`）

> 产品层以 Issue/Run 为中心；Task API 保留给本地执行器和旧数据兼容。一个 Issue 可以拥有多个 Run，Run 结束后会生成报告评论和收件箱通知。

preload 以 `contextBridge` 暴露，全部经 `ipcRenderer.invoke/on` 与主进程通信。TypeScript 契约：`src/shared/contracts.ts` 的 `AgentDeckApi` 接口；渲染层组件经 `src/renderer/src/task-service.ts`（任务操作单一入口）调用，不直接拼装 IPC payload。全部写入口在 main 侧接收 `unknown` 并经 `ipc-validation.ts` 校验。

### 1.1 任务 `bridge.tasks`

| 方法 | 签名 | 说明 |
|---|---|---|
| `list` | `() => Promise<Task[]>` | 全量任务，按创建时间倒序 |
| `get` | `(id) => Promise<Task \| null>` | 单个任务 |
| `events` | `(id, afterSeq = 0) => Promise<TaskEvent[]>` | 增量读执行日志（seq > afterSeq，上限 5000 条） |
| `create` | `(input: TaskCreateInput) => Promise<Task>` | 创建并按 `startNow` 决定是否立即入队。`input: { title, prompt, workdir, backend?, agentId?, handoff?, startNow?, trigger? }`。`agentId` 优先于 `backend`；领队身份由该 agent 的 `subordinates` 决定；`startNow: false` 落为 parked（等 `start` 手动拉起） |
| `start` | `(id) => Promise<IpcResult>` | 启动 parked 任务（仅 queued+parked 可启动） |
| `cancel` | `(id) => Promise<IpcResult>` | 取消排队/运行中任务；**级联取消其运行中子任务** |
| `followUp` | `(id, content, opts?: { relay?: boolean }) => Promise<IpcResult>` | 在已完成任务会话上追问（done/failed/cancelled 均可）；无活跃会话走 resume；dsh 不支持。`relay: true` 仅由「接力下一阶段」按钮传入，触发 `<continue>` 语义的 handoff |
| `delete` | `(id) => Promise<IpcResult>` | 删除任务及日志（连带子任务），并回收名下委派 worktree；运行中拒绝 |
| `retry` | `(id) => Promise<IpcResult>` | 清空结果/会话/attempt 重置为 queued 重跑 |
| `move` | `(id, status) => Promise<IpcResult>` | 看板拖动的状态流转；`validateMove`（shared/taskflow）校验合法性，→ running 仅限 queued 且解除 parked |
| `rewind` | `(id, toSeq) => Promise<IpcResult>` | 截断 toSeq 之后的事件（truncateEvents），重算 result/usage，重新入队执行；广播 `task:events-invalidated` |
| `rename` | `(id, title) => Promise<Task \| null>` | 重命名（≤120 字符，titleAuto 失效） |
| `respondPermission` | `(requestId, optionId, decision: 'allow'\|'deny') => Promise<IpcResult>` | 应答权限确认；超时 5 分钟自动 deny |

订阅类（返回取消函数）：

| 方法 | 回调参数 | 触发时机 |
|---|---|---|
| `onUpdated` | `(task: Task)` | 任何任务状态/字段变更 |
| `onDeleted` | `(id: string)` | 任务删除 |
| `onEvent` | `(taskId, event: TaskEvent)` | 实时执行日志推送 |
| `onEventsInvalidated` | `(taskId: string)` | rewind 等导致本地事件缓存失效，需全量重拉 |
| `onFocusTask` | `(id: string)` | 系统通知点击 → 聚焦该任务 |
| `onPermission` | `(taskId, req: PermissionRequest)` | 非 yolo 模式下 agent 请求放行工具 |

### 1.2 队伍 `bridge.agents` 与预设 `bridge.presets`

| 方法 | 签名 | 说明 |
|---|---|---|
| `agents.list` | `() => Promise<AgentInfo[]>` | 全部队员 |
| `agents.save` | `(list: AgentInfo[]) => Promise<AgentInfo[]>` | 整表保存（校验 name 与 backend），落 `userData/agents.json` |
| `agents.models` | `(backend) => Promise<AgentModelCatalog>` | 平台模型目录：`{ backend, source: 'catalog'\|'freeform', default?, models[] }` |
| `presets.list / save` | `PresetInfo[]` 读写 | API 预设（`{ id, name, backend, baseURL, apiKey, note? }`），落 `userData/api-presets.json` |
| `presets.newId` | `() => Promise<string>` | 生成预设 id |
| `presets.models` | `(presetId) => Promise<AgentModelCatalog>` | 经预设连通探测拉模型目录 |

`AgentInfo`：`{ id, name, backend, model?, presetId?, note?, color, role?, systemPrompt?, subordinates?: string[] }`

- `backend ∈ { zcode, claude, codex, opencode, dsh }`
- `subordinates` 非空 → 领队（获得委派能力）；`model` 钉死模型覆盖；`presetId` 绑定 API 预设连接

### 1.3 Issue / Run `bridge.issues`

| 方法 | 签名 | 说明 |
|---|---|---|
| `create` | `(input: IssueCreateInput) => Promise<Issue>` | `{ title, description, workdir, agentId?, backend?, handoff?, startNow?, trigger?, titleAuto? }`；按 `startNow` 创建首个 assignment Run（`titleAuto` 表示标题由 agent 派生） |
| `list` / `get` | | 读取 Issue 工作队列 |
| `runs` / `comments` | `(issueId) => Promise<Run[] \| Comment[]>` | 读取执行历史与 Issue 时间线 |
| `update` | `(id, patch: { priority?, labels?, dueDate?, status? }) => Promise<Issue \| null>` | 更新工作流状态、优先级、标签或截止日期 |
| `addComment` | `(id, content) => Promise<Comment \| null>` | 留下评论；内容中的 `@agent` 会在同一 Issue 上创建 mention Run |
| `notifications` | `(unreadOnly = false) => Promise<Notification[]>` | 收件箱读取 |
| `markNotificationRead` | `(id) => Promise<{ ok }>` | 标记已读 |
| `onUpdated` 订阅 | `({ taskId, issueId, issue, run })` | Task → Issue 投影变更（每次任务字段更新都同步） |

### 1.4 目标模式 Goal mode（`bridge.goals`）

Goal 是绑定**真实 Issue** 的持久长时程目标（v2 起不再创建独立「目标」或合成 Issue）。在 Issue 详情内开启目标模式后，agent 每轮结束自动续聊自省推进，直到完成条件全部达成或护栏触发；执行复用 TaskRunner、权限、workdir 边界与委派协议。

| 方法 | 说明 |
|---|---|
| `list` / `get` | 读取 `userData/goals/index.json` 中的目标 |
| `create(input)` | `GoalCreateInput = { text, issueId, completionConditions[], stopConditions[], maxRuns, maxDurationMs, workdir, agentId?, backend?, startNow? }`；`issueId` **必填**（空串报错）；创建后「收养」该 Issue 现有最新 Task 作为阶段任务（无 Task 则建首个并注入目标模式块） |
| `runs(id)` / `checkpoints(id)` | 读取轮次记录与每轮 checkpoint（状态脊柱） |
| `start` / `pause` / `continue` / `resume` / `cancel` | 共享目标状态机校验的生命周期命令；`continue` 对最新 Task 触发续轮（优先同会话续聊） |
| `checkpoint(id, input)` | 持久化人工 checkpoint：`{ summary, completedConditions[], incompleteConditions[], nextPlan, blockers[] }` |
| `delete(id)` | 清除目标模式：非终态先停任务，级联删除目标及其全部 runs/checkpoints，广播 `onDeleted`；任何状态（含已取消/已完成/失败）都可清，面板回到可重新开启的空态 |
| `onUpdated` / `onDeleted` 订阅 | 目标变更/删除广播（看板 🎯 徽标与面板即时摘除） |

自动推进语义：每轮 Task 终态（含失败/取消）→ 解析 checkpoint envelope 落盘（runId 幂等）→ 预算/停止条件/连续失败护栏决策 → 续轮**优先同会话续聊回灌**（`runner.followUp`，不重开上下文）；后端未注入续聊或 Task 无 `sessionId` 时**兜底新建 Task**（prompt = 目标块 + checkpoint 简报）。完成条件逐条对照原文全部达成 → goal completed、Issue 自动归档 done。重启恢复：active → `waiting_user`，需显式 continue，绝不静默续跑。

委派单审核（maker/checker）：委派结果回灌后，领队须对每个 done 单输出审核标记 `<review of="#单号" verdict="pass|fail" note="…"/>`——pass → 对应 Issue 看板自动归档 done；fail → 标 blocked 并由领队改派/修复；未出结论的单保持人工审核（不改状态）。匹配与剥离规则见 §5。

**协议标记一览**（委派/目标模式共用的协议标记）：

| 标记 | 用途 |
|---|---|
| `<delegate to="…" reason="…">…</delegate>` | 委派子任务（领队能力协议，详见 §5.1） |
| `<round outcome="…" reason="…"/>` | 每轮收尾自评，运行时截获留痕并从展示文本剥除 |
| `<continue>…</continue>` | 阶段边界换新会话接力（简报自包含），一般推进不硬切会话 |
| `<review of="#单号" verdict="pass\|fail" note="…"/>` | 委派单审核结论：pass → 看板归档 done；fail → blocked（详见 §5.1） |

### 1.5 自动化 `bridge.automations`

| 方法 | 说明 |
|---|---|
| `list` | 全部定时自动化（`Automation`） |
| `create(input)` | `{ name, prompt, workdir, agentId?, scheduleMinutes, output: 'issue'\|'run_only', enabled }`；`run_only` 只留执行日志不建 Issue |
| `update(id, patch)` / `delete(id)` | 修改/删除（删除即时生效） |
| `runNow(id)` | 立即触发一次，返回 `{ ok, error?, task? }` |

调度在主进程：15s tick 扫描到期项，以 `autopilot` 触发创建任务并入队。

### 1.6 技能库 `bridge.skills`（共享目录）

技能资产存放在 AgentDeck 共享目录（默认 `~/.agentdeck`，`settings.sharedDir` 可改），以标准 `SKILL.md`（YAML frontmatter + Markdown 正文）为单元，目录内附加文件随安装一起拷贝。

| 方法 | 说明 |
|---|---|
| `list` | `{ root: string, skills: SkillMeta[] }`（root 为共享目录实际路径） |
| `get(name)` | `SkillDetail`（去 frontmatter 后正文 + 目录内全部文件） |
| `save(name, { description, body, originName? })` | 新建/重命名保存（重名自动 `-2` 后缀） |
| `delete(name)` | 删除技能目录 |
| `import(sourcePath)` | 从目录或单文件导入（目录须含 SKILL.md；无 frontmatter 也能导入） |
| `targets()` | 安装目标与同步状态：`{ targets: SkillTarget[], states: Record<targetId, Record<skillName, SyncState>> }`，`SyncState = 'in-sync'\|'outdated'\|'missing'` |
| `install(name, targetId)` / `uninstall` | 安装/卸载到目标目录（整目录拷贝，逐字节比较 CRLF 归一） |
| `openDir` | 在系统文件管理器打开共享目录 |

内置安装目标：`~/.claude/skills`、`~/.codex/skills`、`~/.zcode/skills`、跨工具共享位 `~/.agents/skills`。目录参数由主进程注入、`path.relative` 逃逸校验，设计见 `docs/SKILLS-SHARED-DIR.md`。

### 1.7 运行时与用量 `bridge.runtimes` / `bridge.analytics`

| 方法 | 说明 |
|---|---|
| `runtimes.snapshot()` | `RuntimeSnapshot[]`：每个注册后端的健康快照（`online/offline/degraded/unknown`、版本、activeTaskCount、checkedAt）；运行时与 agent 解耦，多个 agent 可共享一个运行时 |
| `analytics.summary(input?: { since?, until? })` | `AnalyticsSummary`：总量/按后端/按队员的 token、成本、时长、成败计数，以及失败分类聚合 |

### 1.8 设置与工具

| 方法 | 说明 |
|---|---|
| `bridge.settings.get() / set(patch)` | `AppSettings` 读写，见 §2.6；`sharedDir` 变更即切换技能库根目录 |
| `bridge.settings.onUpdated(cb)` | 设置变更广播（主题跟随等） |
| `bridge.settings.probe()` | zcode 综合探测（含 node 运行时解析结果与搜索路径） |
| `bridge.pickDir()` | 系统目录选择框，取消返回 `''` |
| `bridge.openPath(target)` | 只放行 http(s) URL 与本地已存在路径 |
| `bridge.notify(title, body)` | 主进程系统通知（点击聚焦窗口并广播 `task:focus`） |

---

## 2. 数据模型（`src/shared/types.ts` + `contracts.ts` + `skills.ts`）

### 2.0 Task 索引 schema

`userData/tasks/tasks.json` 使用显式 envelope：

```json
{ "schemaVersion": 1, "tasks": [] }
```

启动时 `migrateTaskIndex` 只接受未版本化数组（版本 0）或已声明版本；旧 `mode`/`squad` 字段仅在版本 0 迁移为 `integration`，坏记录会被过滤，未来版本会明确拒绝。迁移通过临时文件 + rename 写回，并可重复执行而不重新生成时间戳。

Task 是本地执行兼容记录，不是用户工作单元。一个 Issue 可以关联多个 Run（重试、续聊、提及、接力或目标阶段），`executionRecordFromTask` 在 `src/shared/taskflow.ts` 中提供 Task 到内部 `ExecutionRecord` 的唯一映射。

### 2.1 Task

```ts
interface Task {
  id: string                    // t_<base36时间>_<随机>
  title: string; prompt: string
  workdir: string               // '' = 无绑定
  backend: string               // zcode | claude | codex | opencode | dsh
  agentId?: string              // 执行队员
  trigger?: RunTrigger          // assignment | mention | autopilot | manual | handoff
  issueId?: string              // 所属 Issue（iss_<taskId> 兼容派生）
  suppressIssue?: boolean       // run_only 自动化：不投影成 Issue
  runId?: string                // 执行实例（重试/续聊保留 Run 历史）
  goalId?: string; phaseIndex?: number   // 目标模式阶段标记
  failure?: FailureInfo         // 失败分类：code/title/hint/retryable（11 类稳定 code）
  parentTaskId?: string         // 委派产生的子任务指向领队
  workerIndex?: number
  integration?: { branch?, note? }  // 领队任务的 git 集成结果
  attempt?: number              // 自动重试计数（仅 retryable 失败 +1，上限 2）
  roundsUsed?: number           // 委派已用轮数（全链共享预算记账）
  handoff?: string              // 交接备注（创建时填写，注入 prompt）
  continuesFrom?: string        // <continue> 接力来源任务（同 Issue 串行链）
  parked?: boolean              // 暂不启动：停在队列外等手动开始
  titleAuto?: boolean           // 标题由 prompt 首行派生（agent 总结后重起）
  status: 'queued'|'running'|'done'|'failed'|'cancelled'
  createdAt; startedAt?; endedAt?
  result?: string               // 最终回复（委派任务已剥除 delegate 标记）
  error?: string
  sessionId?: string            // 续聊用
  gitDiff?: string; gitStat?: string
  usage?: TaskUsage             // { inputTokens, outputTokens, totalTokens, costUsd, durationMs, turns }
  eventCount: number
}
```

### 2.2 TaskEvent（执行日志，追加写 events.jsonl）

```ts
interface TaskEvent {
  seq: number                   // store 统一分配，重启后从文件尾恢复，单调递增
  ts: number
  v?: number                   // 事件 schema 版本；旧 JSONL 读侧归一化为 1
  version?: number             // v 的兼容别名
  id?: string; eventId?: string // at-least-once producer 幂等键
  type?: string                // provider 事件名（如 text.delta/tool.result）
  durability?: 'live'|'durable'
  durable?: boolean | { aggregate: string; aggregateId?: string; seq?: number; version: number }
  aggregate?: string | { aggregate?: string; id?: string; seq?: number; version?: number }
  kind: 'user'      // 用户输入（首条 prompt / 追问），对话视图按它分回合
      | 'status'    // 状态变化/请求状态
      | 'text'      // 流式文本增量
      | 'final'     // 回合最终回复
      | 'tool'      // 工具调用（data: {phase:'started'|'result', args?, ok?, durationMs?, preview?}）
      | 'usage'     // token 用量（各平台原生对象，适配器统一映射）
      | 'error'
      | 'raw'       // 其他协议事件
  text?: string
  data?: unknown
}
```

`text.delta`、`reasoning.delta`、`tool.input.delta` 和 `compaction.delta` 属于
live-only 事件：可以通过实时 IPC 推送，但不占用 durable `seq`、不进入
`tasks.events(afterSeq)` 回放，也不计入任务的 `eventCount`。旧版未带
durability/type 的 `kind: 'text'` 事件按 durable 处理，保证历史 JSONL 可读。
事件写入由 `EventLog` 统一完成 v1 归一化、幂等 append、批量 fsync、半行尾恢复、
`afterSeq` 读取和 replay 分歧检测；未知 kind 会保留原值到 `rawKind` 并按 `raw`
兼容处理，未来版本则 fail-closed。

### 2.3 Issue / Run / Comment / Notification

```ts
type IssueStatus = 'backlog'|'todo'|'in_progress'|'in_review'|'done'|'blocked'|'cancelled'
type IssuePriority = 'urgent'|'high'|'medium'|'low'|'none'
type RunStatus = 'running'|'completed'|'cancelled'|'error'
type RunTrigger = 'assignment'|'mention'|'autopilot'|'manual'|'handoff'

interface Issue {
  id; identifier; title; description
  status: IssueStatus
  statusOverride?: IssueStatus   // 人工/审核终态覆盖（不被执行投影翻回）
  priority; assignee?: { type: 'agent'|'user', id }
  parentIssueId?; projectId?; labels: string[]; dueDate?
  position; createdBy; createdAt; updatedAt
  taskId                         // 兼容链接到执行记录
}

interface Run {
  id; issueId; taskId; agentId?
  trigger: RunTrigger
  prompt: string
  status: RunStatus
  startedAt?; finishedAt?; durationMs?
  usage?: TaskUsage
  transcriptEventCount: number
  goalId?; phaseIndex?           // 目标阶段元数据（普通 Run 省略）
}

interface Comment {
  id; issueId; author: IssueAssignee; content
  reactions: string[]
  runId?                         // 产生该报告的执行
  createdAt
}

interface Notification {
  id; userId; issueId
  kind: 'reported'|'mentioned'|'status'|'assigned'
  runId?; read; createdAt
}
```

### 2.4 Goal / GoalRun / GoalCheckpoint

```ts
type GoalStatus = 'draft'|'active'|'waiting_user'|'completed'|'blocked'|'cancelled'|'failed'

interface Goal {
  id: string
  issueId: string               // 必绑真实 Issue，复用其执行历史
  text: string
  completionConditions: string[]; stopConditions: string[]
  maxRuns: number; maxDurationMs: number
  status: GoalStatus
  runCount: number; totalDurationMs: number
  failures?: number             // 连续非重试失败次数（≥2 → failed；续轮成功清零）
  currentRunId?; agentId?; backend?; workdir?; blockedReason?
  createdAt; updatedAt
}

interface GoalRun extends Run { goalId: string; phaseIndex: number }

interface GoalCheckpoint {
  id; goalId; runId; phaseIndex
  summary: string
  completedConditions: string[]; incompleteConditions: string[]
  nextPlan: string; blockers: string[]
  createdAt; durationMs?; usage?
}
```

### 2.5 Automation / RuntimeSnapshot / AnalyticsSummary

```ts
interface Automation {
  id; name; prompt; workdir; agentId?
  scheduleMinutes: number
  output: 'issue' | 'run_only'
  enabled: boolean
  createdAt; lastRunAt?; nextRunAt?
}

type RuntimeHealth = 'online'|'offline'|'degraded'|'unknown'
interface RuntimeSnapshot {
  id; label; backend; kind: 'local'|'cloud'
  health: RuntimeHealth; detail; version?
  activeTaskCount; checkedAt
}

interface AnalyticsSummary {
  since?; until; generatedAt
  totals: UsageAggregate        // runs/completed/failed/cancelled + tokens/costUsd/durationMs
  byBackend: Array<UsageAggregate & { key, label }>
  byAgent:   Array<UsageAggregate & { key, label }>
  errors: Array<{ code, title, count, retryable, lastSeenAt? }>
}
```

### 2.6 AppSettings 与技能模型

```ts
interface AppSettings {
  theme: 'dark'|'light'|'system'
  zcodePath; dshPath; nodePath          // CLI 路径（空 = 自动扫描/默认）
  concurrency: number                   // 普通任务并行上限（默认 1）
  workerConcurrency: number             // 委派子任务并行上限（默认 3，双通道独立）
  notifyOnDone: boolean
  mode: 'yolo'|'build'|'edit'|'plan'    // 权限模式，非 yolo 时交互确认
  sharedDir: string                     // 共享目录；空串 = 默认 ~/.agentdeck
}

// shared/skills.ts
interface SkillMeta   { name; description; dir; files: string[]; updatedAt; bodyBytes }
interface SkillDetail { name; description; body /* 去 frontmatter */; files }
type SyncState = 'in-sync' | 'outdated' | 'missing'
interface SkillTarget { id; label; dir; hint }
```

`PermissionRequest`（`shared/contracts.ts`）：`{ requestId, toolName, reason, riskLevel, input?, options: [{ optionId, name, description?, response: { decision } }] }`。

存储布局（`userData/`）：

```
tasks/tasks.json                 # 任务索引（原子写：tmp+rename）
tasks/<taskId>/task.json         # 单任务快照
tasks/<taskId>/events.jsonl      # 执行日志流
issues/index.json                # Issue/Run/Comment/Notification
goals/index.json                 # Goal/GoalRun/GoalCheckpoint
automations/index.json           # 定时自动化
agents.json                      # 队伍
api-presets.json                 # API 预设
settings.json                    # 设置
```

用户资产在独立共享目录（默认 `~/.agentdeck/`）：`README.md`（首次自动生成）+ `skills/<name>/SKILL.md`。

---

## 3. 主进程模块

### 3.1 TaskStore（`src/main/store.ts`）

- `create(input)` / `get(id)` / `list()` / `update(id, patch)` / `delete(id)`
- `appendEvent(id, e): TaskEvent | null` — 分配 seq 并追加落盘，返回完整事件（含 seq）供 UI 推送
- `readEvents(id, afterSeq=0, limit=5000)` — 增量读
- `truncateEvents(id, toSeq)` — rewind 用截断（EventLog offset 索引）
- `flushEvents(id)` / `flush()` — 结束写流 / 退出前全量落盘

存储布局见 §2.6；底层 `event-log.ts` 持有 seq 与字节偏移索引，重启后从文件尾恢复 seq。

### 3.2 IssueStore / GoalStore / AutomationStore

- `IssueStore`（`issue-store.ts`）：Issue/Run/Comment/Notification 持久化；`syncTask(task, parent)` 把 Task 投影为 Run 并派生 Issue 状态；`updateWorkflow` / `statusOverride` 写看板状态（审核得到的终态不被翻回）；`addComment` 解析 `@agent` 触发 mention Run。
- `GoalStore`（`goal-store.ts`）：Goal/GoalRun/GoalCheckpoint 版本化持久化，`delete(id)` 级联删 runs/checkpoints。
- `AutomationStore`（`automation-store.ts`）：定时自动化 CRUD 与 `markRun`。
- `GoalController`（`goal-controller.ts`）：生命周期（start/pause/resume/continue/cancel/remove）、`create` 收养 Issue、`onTaskChanged` 循环推进、`recover` 重启恢复、`subscribe` 广播。

### 3.3 TaskRunner（`src/main/runner.ts`）

- `enqueue(task)` → `pump()`：双通道取队（普通 / 子任务），领队编排不占槽，parked 跳过
- `run(taskId)` 状态机：`queued → running → done|failed|cancelled`
  1. 组装提示词：`buildAgentPrompt(agent) (+ buildDelegationBlock(领队))`
  2. `backend.start(...)` → 等 `onTurnEnd`
  3. 领队且非 dsh → `runDelegationLoop(...)`
  4. `finalizeDone`：最终结果 + `snapshotGitAfter` 工作区 diff + 通知
- `followUp(id, content, opts?)`：done/failed/cancelled 均可续聊；`relay: true` 触发 handoff 接力
- `cancel`（级联）/ `resolvePermission` / `attachTeam` / `attachPresets` / `attachIssueOps`（`<review>` 审核回调）/ `attachContinue`（`<continue>` 接力）/ `maybeAutoRetry`（retryable 失败自动重入队，≤2 次）
- 启动句柄 `launchHandles`：一次性 CLI 在 session 返回前即可被取消

---

## 4. 后端适配器接口（扩展点，`src/main/backends/types.ts`）

新增平台 = 实现此接口 + 在 `src/main/index.ts` 的 `backends` Map 注册 + 队伍可选队员。

```ts
interface AgentBackend {
  id: string
  label: string
  probe(): Promise<{ ok: boolean; detail: string }>          // 可用性探测
  start(opts): Promise<BackendSession>
  // opts: {
  //   prompt, workdir, mode,
  //   model?: string              // agent 钉死的模型覆盖；空 = 平台默认
  //   connection?: { name, baseURL, apiKey }   // API 预设覆盖，按会话内存注入
  //   resumeSessionId?: string    // 提供时走 session/resume
  //   events: BackendSessionEvents
  // }
}

interface BackendSession {
  sessionId: string
  send(content): Promise<void>    // 续聊；回合结束经 events.onTurnEnd
  stop(): Promise<void>           // 中止当前回合
  close(): Promise<void>          // 关闭并释放进程
}

interface BackendSessionEvents {
  onEvent(e: Omit<TaskEvent,'seq'>)                           // 日志事件（ts 必填，seq 由 store 分配）
  onHeartbeat?()                                              // 连接上有任何消息即回调：
                                                              // 供空转看门狗续命，长思考/后台子代理不误判超时
  onTurnEnd(r: { response, ok, error?, tokenCount?, durationMs?, delegationText? })
  onPermission?(req): Promise<{ optionId?, decision }>        // 可选；缺省自动放行
  onLaunch?(handle: { stop() })                               // 可选；进程拉起即注册取消句柄
  onSessionId?(sessionId: string)                             // 可选；首轮失败前也立即持久化，供 retry resume
}
```

**两种进程模型**：

| 模型 | 代表 | 会话 | 续聊实现 |
|---|---|---|---|
| 常驻服务 | zcode（app-server stdio 协议） | 连接存活期间多轮 | `session/send` |
| 一次性进程 | claude / codex / opencode / dsh | 每回合一个进程 | 重新 spawn + resume 参数（`--resume` / `exec resume` / `-s`；dsh 无 resume，`send` 直接抛错） |

公共基建：`cli-common.ts`（JSONL 行解析、10 分钟空闲超时、5MB 输出上限看门狗）；`cli-locator.ts`（Windows npm `.cmd` 垫片解析到原生 exe / node 脚本，绕开 EINVAL）。

---

## 5. 委派协议（`src/main/delegate.ts`）

领队任务提示末尾自动附加能力说明；运行时截获标记驱动多 agent 协同。

### 5.1 标记语法

```
<delegate to="队员名" reason="为什么派给TA">完整子任务指令（相对路径，指令只写增量）</delegate>
```

- 可多个，本轮并行执行；每轮上限 `workerConcurrency`
- 领队最终输出不应再含标记；对外结果经 `stripDelegates` 剥离
- 子任务提示 = 指令 + 领队任务原文背景块（`buildChildPrompt`，≤2000 字符，声明"参考非指令、冲突以指令为准"）

委派单审核结论标记（maker/checker）：

```
<review of="#单号" verdict="pass|fail" note="一句话：通过理由或退回原因"/>
```

- 队员是 maker、领队是 checker：对回灌报告里每个状态为 done 的单给出一条结论
- pass → 对应 Issue 看板自动归档为已完成；fail → 标记受阻，由领队下一轮改派或自行修复；未出结论的单保留人工审核，不改状态
- `of` 按 `#序号` 精确匹配，兜底按队员名/标题子串；回灌报告带单号（`### 队员 X 的结果（done，单号 #1）`）
- 对外文本（`finalText`）剥除 review 标记（`stripReviews`）；`scanTexts` 不剥，供多源解析

每轮评估与阶段接力标记（目标模式/长任务共用）：

```
<round outcome="done|partial|blocked" reason="…"/>      // 每轮收尾自评，截获留痕后剥除
<continue>
下一阶段简报（自包含：目标、已完成、下一步、风险）
</continue>                                             // 阶段边界换新会话，简报为唯一携带物
```

### 5.2 导出 API

| 导出 | 用途 |
|---|---|
| `parseDelegates(text) / parseDelegatesMerged(...texts)` | 提取 `{to, reason?, prompt}[]`（开标签必须带 to 属性才构成匹配，防裸标记卷单） |
| `stripDelegates(text)` | 剥除委派标记 |
| `parseReviews(text) / stripReviews(text)` | `<review>` 审核结论提取/剥除 |
| `parseRoundNotes(text) / stripRoundNotes(text)` | `<round>` 评估标记提取/剥除 |
| `parseContinue(text) / parseContinueMerged(...texts) / stripContinue(text)` | `<continue>` 接力简报提取/剥除 |
| `buildAgentPrompt(agent, userPrompt, team)` | 身份注入（人设+定位，人设优先于协议） |
| `buildDelegationBlock(agent, team)` | 领队能力说明（名单+协议，含"何时亲自做"三档） |
| `buildChildPrompt(instruction, parentPrompt)` | 子任务指令 + 领队任务原文背景块 |
| `sanitizeChildPrompt(prompt, repoDir)` | 子任务指令绝对路径→相对（防改错目录） |
| `runDelegationLoop(taskId, session, firstResponse, ctx)` | 委派主循环，返回 `{rounds, children, finalText}` |

### 5.3 循环语义

```
首回合结束 → 解析 delegate 标记
  ├─ 无标记 → 结束（领队自己干完了）
  ├─ 有标记 → 逐个：解析队员（名字/平台 id，忽略大小写，限 subordinates 内）
  │           sanitizeChildPrompt → 建 worktree（仓库时）→ 建子任务入队
  ├─ 等本轮子任务全部终态 → 结果格式化回灌（报告带单号）并等待完整回合结果
  ├─ 领队对报告里每个 done 单输出 <review> 审核结论
  │      pass → 看板归档 done / fail → blocked / 无结论 → 不动状态留人工审核
  └─ 领队继续输出 → 再解析（单领队最多 6 轮，全链共享 8 轮预算）
结束 → 子任务分支 commitAll + 依序 merge 进 agentdeck/task-<领队id> 集成分支
       → 集成成功即回收 worktree + 删工作分支；branchDiffSummary 生成总 diff
       无实际合并时如实标注
```

约束：取消领队级联取消子任务；领队自己的改动留在主工作区不自动提交；dsh 不能当领队（无 send）；子任务未绑定 Issue 时审核结论只留痕、不写看板状态；二层委派时子领队的集成分支递归合入领队集成分支。

---

## 6. OpenCode server 适配器（适配器内部，供维护参考）

`createOpencodeBackend()` 优先使用 OpenCode HTTP server。设置
`AGENTDECK_OPENCODE_SERVER_URL`（或 `OPENCODE_SERVER_URL`）时连接既有服务；否则
首次使用时按需启动本地 `opencode serve --port <free> --hostname 127.0.0.1 --pure`。
服务器健康检查读取 `/global/health`，版本缺失或非 1.x 会 fail-loud。服务不可用时才
回退到历史 `opencode run --format json` CLI 适配器；设置
`AGENTDECK_OPENCODE_SERVER_REQUIRED=1` 可禁止回退，`AGENTDECK_OPENCODE_CLI_ONLY=1`
可显式选择 CLI。

server 会话映射如下：

| AgentBackend | OpenCode HTTP | 说明 |
|---|---|---|
| `start` | `POST /session` + `POST /session/:id/prompt_async` | 新建会话并发送首个 prompt；`resumeSessionId` 复用已有会话 |
| `send` | `POST /session/:id/prompt_async` | 同一会话续聊 |
| `stop` | `POST /session/:id/abort` | 兼容旧 `/interrupt` |
| `close` | `DELETE /session/:id` | 关闭会话并终止 SSE |
| permission | `POST /permission/:id/reply` | `allow` 映射 `once`，`deny` 映射 `reject` |

事件通过 `GET /event?directory=...&after=<seq>` SSE 读取；断线后使用最近游标重连并按
provider event id 去重。`text.delta`、`reasoning.delta`、`tool.input.delta`、
`compaction.delta` 是 live-only，不占 durable seq；文本终态、工具结果、step-finish
usage、`session.error`、compaction/fork 状态是 durable 事件。若 server 构建不发送 SSE
消息，适配器会以只读 `GET /session/:id/message` 轮询补齐终态，仍走同一映射路径。

## 7. ZCode 协议要点（适配器内部，供维护参考）

- 传输：spawn `node zcode.cjs app-server --stdio`，换行分隔 JSON，信封 `{id, method, params}`（**无** `jsonrpc` 键）
- 前置：物化 `~/.zcode/cli/config.json`（`model.main = "zai/glm-5.3"`，apiKey 在 `provider.zai.options`，models 目录非空——resume 校验依赖）
- 握手：服务端先发 `session/requestRuntimePreferences`（string id），必须应答扁平对象，`session/create` 才返回
- 关键方法：`session/create {workspace, mode}` / `session/subscribe {sessionId, deliveryKind:"desktop-continuous"}` / `session/send {sessionId, content}` / `session/stop` / `session/resume {sessionId, workspace, runtimeModel}` / `session/close`
- resume 必须带 `runtimeModel`（模型注册表快照，从 cli config 构造：`{revision, generatedAt, model, provider}`，provider.apiKey 为 `{source:'inline', value}` 形状），否则后续 send 报 `ZCODE_RUNTIME_MODEL_UNAVAILABLE`
- 事件：`session/event`（`model.streaming` 的 `text_delta`/`tool_input_*`、`tool.updated` 的 `started/result`、带 `response+usage` 的回合终态——每回合两种终态取首个完整版）、`state.updated`（idle↔running）、`v4/telemetry/event`（备用终态）
- 防护：单回合文本 > 300KB 判定模型退化循环，强制 stop 并截断收尾
