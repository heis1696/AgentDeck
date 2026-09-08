# AgentDeck API 文档

> 封板版本 v0.3.0（demo）。本文描述四层接口：渲染层 IPC 桥、主进程内部模块、后端适配器接口（扩展点）、委派协议。

---

## 1. 渲染层 IPC 桥（`window.agentdeck`）

> 产品层以 Issue/Run 为中心；Task API 仍保留给本地执行器和旧数据兼容。一个 Issue 可以拥有多个 Run，Run 结束后会生成报告评论和收件箱通知。

preload 以 `contextBridge` 暴露，全部经 `ipcRenderer.invoke/on` 与主进程通信。TypeScript 侧对应 `src/renderer/src/api.ts` 的 `Bridge` 接口。

### 1.1 任务 `bridge.tasks`

Renderer 组件通过 `src/renderer/src/task-service.ts` 调用任务命令；该服务只接收任务 ID、文本或领域对象，并将参数映射到下列兼容 channel。组件不直接拼装 IPC payload。

| 方法 | 签名 | 说明 |
|---|---|---|
| `list` | `() => Promise<Task[]>` | 全量任务，按创建时间倒序 |
| `get` | `(id) => Promise<Task \| null>` | 单个任务 |
| `events` | `(id, afterSeq = 0) => Promise<TaskEvent[]>` | 增量读执行日志（seq > afterSeq，上限 5000 条） |
| `create` | `(input) => Promise<Task>` | 创建并立即入队。`input: { title, prompt, workdir, backend?, agentId? }`。`agentId` 优先于 `backend`；领队身份由该 agent 的 `subordinates` 决定 |
| `cancel` | `(id) => Promise<{ok, error?}>` | 取消排队/运行中任务；**级联取消其运行中子任务** |
| `followUp` | `(id, content) => Promise<{ok, error?}>` | 在已完成任务会话上追问；无活跃会话时走 resume；dsh 不支持（报错） |
| `delete` | `(id) => Promise<{ok, error?}>` | 删除任务及日志；运行中拒绝 |
| `retry` | `(id) => Promise<{ok, error?}>` | 重置为 queued 重跑 |
| `respondPermission` | `(requestId, optionId, decision) => Promise<{ok, error?}>` | 应答权限确认；超时 5 分钟自动 deny |

订阅类（返回取消函数）：

| 方法 | 回调参数 | 触发时机 |
|---|---|---|
| `onUpdated` | `(task: Task)` | 任何任务状态/字段变更 |
| `onDeleted` | `(id: string)` | 任务删除（用户侧扩展） |
| `onEvent` | `(taskId, event: TaskEvent)` | 实时执行日志推送 |
| `onPermission` | `(taskId, req: PermissionRequest)` | 非 yolo 模式下 agent 请求放行工具 |

### 1.2 队伍 `bridge.agents`

| 方法 | 签名 | 说明 |
|---|---|---|
| `list` | `() => Promise<Agent[]>` | 全部队员 |
| `save` | `(list: Agent[]) => Promise<Agent[]>` | 整表保存（校验 name 与 backend 合法性），落 `userData/agents.json` |
| `probe` | `() => Promise<Record<backendId, {ok, detail}>>` | 逐平台探测可用性 |
| `onProbeResult` | `(id, result)` 订阅 | 探测结果逐个推送（不等最慢平台） |

### 1.3 Issue / Run `bridge.issues`

| 方法 | 说明 |
|---|---|
| `create` | 创建一个 Issue，并按 `startNow` 创建首个 assignment Run |
| `list` / `get` | 读取 Issue 工作队列 |
| `runs` / `comments` | 读取执行历史与 Issue 时间线 |
| `update` | 更新工作流状态、优先级、标签或截止日期 |
| `addComment` | 留下评论；内容中的 `@agent` 会在同一 Issue 上创建 mention Run |
| `notifications` / `markNotificationRead` | 收件箱读取与已读状态 |

`Agent`：`{ id, name, backend, role?, systemPrompt?, subordinates?: string[], model?, note?, color }`

- `backend ∈ { zcode, claude, codex, opencode, dsh }`
- `subordinates` 非空 → 领队（获得委派能力）

### 1.4 Goal mode (`bridge.goals`)

Goal is a durable long-running objective attached to one Issue. Each
continuation creates another GoalRun/Task under that Issue. Terminal runs leave
one GoalCheckpoint; repeated TaskChanged notifications are idempotent by run id.

| Method | Description |
|---|---|
| `list` / `get` | Read goals persisted in `userData/goals/index.json` |
| `create(input)` | Create completion/stop conditions plus run and duration budgets; `startNow` controls the first run |
| `runs(id)` / `checkpoints(id)` | Read phase history and durable checkpoint summaries |
| `start` / `pause` / `continue` / `resume` / `cancel` | Lifecycle commands checked by the shared goal state machine |
| `checkpoint(id, input)` | Persist a user-provided checkpoint for the current phase |

An active goal is never resumed silently after restart. Recovery moves it to
`waiting_user` and requires an explicit continuation. Goal execution reuses the
existing TaskRunner, permission broker, workdir boundary and delegation protocol.

### 1.3 设置与工具

| 方法 | 说明 |
|---|---|
| `bridge.settings.get() / set(patch)` | `AppSettings` 读写，见 §3.2 |
| `bridge.settings.probe()` | zcode 综合探测（含 node 运行时解析结果） |
| `bridge.pickDir()` | 系统目录选择框，取消返回 `''` |
| `bridge.openPath(target)` | 只放行 http(s) URL 与本地已存在路径 |
| `bridge.notify(title, body)` | 主进程系统通知 |

---

## 2. 数据模型（`src/shared/types.ts`）

### 2.0 Task 索引 schema

`userData/tasks/tasks.json` 使用显式 envelope：

```json
{ "schemaVersion": 1, "tasks": [] }
```

启动时 `migrateTaskIndex` 只接受未版本化数组（版本 0）或已声明版本；旧 `mode`/`squad` 字段仅在版本 0 迁移为 `integration`，坏记录会被过滤，未来版本会明确拒绝。迁移通过临时文件 + rename 写回，并可重复执行而不重新生成时间戳。

Task 是本地执行兼容记录，不是用户工作单元。一个 Issue 可以关联多个 Run（重试、续聊、提及或接力），`executionRecordFromTask` 在 `src/shared/taskflow.ts` 中提供 Task 到内部 `ExecutionRecord` 的唯一映射。

### 2.1 Task

```ts
interface Task {
  id: string                    // t_<base36时间>_<随机>
  title: string; prompt: string
  workdir: string               // '' = 无绑定
  backend: string               // zcode | claude | codex | opencode | dsh
  agentId?: string              // 执行队员
  failure?: FailureInfo         // 失败分类（0.4.0）：code/title/hint/retryable
  parentTaskId?: string         // 委派产生的子任务指向领队
  workerIndex?: number
  integration?: { branch?, note? }  // 领队任务的 git 集成结果（0.4.0 由 squad 更名）
  attempt?: number              // 自动重试计数（0.5.0，上限 2）
  usage?: TaskUsage             // 累计用量（0.4.0：input/output/totalTokens, costUsd, durationMs, turns）
  roundsUsed?: number           // 委派已用轮数（0.7.0：全链共享预算记账）
  status: 'queued'|'running'|'done'|'failed'|'cancelled'
  createdAt; startedAt?; endedAt?
  result?: string               // 最终回复（委派任务已剥除 delegate 标记）
  error?: string
  sessionId?: string            // 续聊用
  gitDiff?: string; gitStat?: string
  eventCount: number
}
```

### 2.2 TaskEvent（执行日志，追加写 events.jsonl）

```ts
interface TaskEvent {
  seq: number                   // store 统一分配，重启后从文件尾恢复，单调递增
  ts: number
  kind: 'status'|'text'|'final'|'tool'|'usage'|'error'|'raw'
  text?: string
  data?: unknown                // tool: {phase:'started'|'result', args?, ok?, durationMs?, preview?}
                                // usage: 各平台原生用量对象（统一映射见适配器）
}
```

---

## 3. 主进程模块

### 3.1 TaskStore（`src/main/store.ts`）

- `create(input)` / `get(id)` / `list()` / `update(id, patch)` / `delete(id)`
- `appendEvent(id, e): TaskEvent | null` — 分配 seq 并追加落盘，返回完整事件（含 seq）供 UI 推送
- `readEvents(id, afterSeq=0, limit=5000)` — 增量读
- `flushEvents(id)` — 结束写流

存储布局（`userData/`）：

```
tasks/tasks.json                 # 任务索引（原子写：tmp+rename）
tasks/<taskId>/task.json         # 单任务快照
tasks/<taskId>/events.jsonl      # 执行日志流
agents.json                      # 队伍
settings.json                    # 设置
```

### 3.2 AppSettings

```ts
{ zcodePath, dshPath, nodePath, concurrency(默认1),
  notifyOnDone(默认true), mode('yolo'|'build'|'edit'|'plan'), workerConcurrency(默认3，0.4.0 由 squadMaxWorkers 更名) }
```

- `concurrency`：普通任务并行上限
- `workerConcurrency`：委派子任务并行上限（两通道独立，领队编排不占普通槽）
- `mode`：传给后端的权限模式；非 yolo 时交互确认

### 3.3 TaskRunner（`src/main/runner.ts`）

- `enqueue(task)` → `pump()`：双通道取队（普通 / 子任务），领队编排不占槽
- `run(taskId)` 状态机：`queued → running → done|failed|cancelled`
  1. 组装提示词：`buildAgentPrompt(agent) (+ buildDelegationBlock(领队))`
  2. `backend.start(...)` → 等 `onTurnEnd`
  3. 领队且非 dsh → `runDelegationLoop(...)`
  4. `finalizeDone`：最终结果 + `snapshotGitAfter` 工作区 diff + 通知
- `followUp` / `cancel`（级联）/ `resolvePermission` / `attachTeam` / `maybeAutoRetry`（0.5.0：retryable 失败自动重入队，≤2 次）
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
  // opts: { prompt, workdir, mode, resumeSessionId?, events }
}

interface BackendSession {
  sessionId: string
  send(content): Promise<void>    // 续聊；回合结束经 events.onTurnEnd
  stop(): Promise<void>           // 中止当前回合
  close(): Promise<void>          // 关闭并释放进程
}

interface BackendSessionEvents {
  onEvent(e: Omit<TaskEvent,'seq'>)                           // 日志事件（ts 必填，seq 由 store 分配）
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
<delegate to="队员名">完整子任务指令（相对路径，自包含）</delegate>
```

- 可多个，本轮并行执行；每轮上限 `workerConcurrency`
- 领队最终输出不应再含标记；对外结果经 `stripDelegates` 剥离

### 5.2 导出 API

| 导出 | 用途 |
|---|---|
| `parseDelegates(text): DelegateCall[]` | 提取 `{to, prompt}[]` |
| `stripDelegates(text): string` | 剥除标记 |
| `buildAgentPrompt(agent, userPrompt, team)` | 身份注入（人设+定位） |
| `buildDelegationBlock(agent, team)` | 领队能力说明（名单+协议） |
| `sanitizeChildPrompt(prompt, repoDir)` | 子任务指令绝对路径→相对（防改错目录） |
| `runDelegationLoop(taskId, session, firstResponse, ctx)` | 委派主循环，返回 `{rounds, children, finalText}` |

### 5.3 循环语义

```
首回合结束 → 解析 delegate 标记
  ├─ 无标记 → 结束（领队自己干完了）
  ├─ 有标记 → 逐个：解析队员（名字/平台 id，忽略大小写，限 subordinates 内）
  │           sanitizeChildPrompt → 建 worktree（仓库时）→ 建子任务入队
  ├─ 等本轮子任务全部终态 → 结果格式化回灌并等待完整回合结果
  └─ 领队继续输出 → 再解析（最多 6 轮）
结束 → 子任务分支 commitAll + 依序 merge 进 agentdeck/task-<领队id> 集成分支
       branchDiffSummary 生成总 diff；无实际合并时如实标注
```

约束：取消领队级联取消子任务；领队自己的改动留在主工作区不自动提交；dsh 不能当领队（无 send）。

---

## 6. ZCode 协议要点（适配器内部，供维护参考）

- 传输：spawn `node zcode.cjs app-server --stdio`，换行分隔 JSON，信封 `{id, method, params}`（**无** `jsonrpc` 键）
- 前置：物化 `~/.zcode/cli/config.json`（`model.main = "zai/glm-5.3"`，apiKey 在 `provider.zai.options`，models 目录非空——resume 校验依赖）
- 握手：服务端先发 `session/requestRuntimePreferences`（string id），必须应答扁平对象，`session/create` 才返回
- 关键方法：`session/create {workspace, mode}` / `session/subscribe {sessionId, deliveryKind:"desktop-continuous"}` / `session/send {sessionId, content}` / `session/stop` / `session/resume {sessionId, workspace, runtimeModel}` / `session/close`
- resume 必须带 `runtimeModel`（模型注册表快照，从 cli config 构造：`{revision, generatedAt, model, provider}`，provider.apiKey 为 `{source:'inline', value}` 形状），否则后续 send 报 `ZCODE_RUNTIME_MODEL_UNAVAILABLE`
- 事件：`session/event`（`model.streaming` 的 `text_delta`/`tool_input_*`、`tool.updated` 的 `started/result`、带 `response+usage` 的回合终态——每回合两种终态取首个完整版）、`state.updated`（idle↔running）、`v4/telemetry/event`（备用终态）
- 防护：单回合文本 > 300KB 判定模型退化循环，强制 stop 并截断收尾
