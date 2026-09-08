# AgentDeck 架构重构施工方案

> 目标版本：0.14.x - 0.17.x
>
> 本方案针对当前仓库的结构性问题编写：主进程职责集中、事件持久化同步 I/O、Issue 投影全量重建、IPC 契约重复、渲染组件过大，以及 Task/Issue 双模型边界不清。
>
> 约束：保持本地单机和现有 Electron 边界；第一阶段不新增状态管理库或测试框架；每一阶段都可独立回滚，并在阶段末执行 typecheck 和相关 smoke。

---

## 1. 当前基线

### 1.1 代码边界

| 区域 | 当前职责 | 主要问题 |
|---|---|---|
| `src/main/index.ts` | Electron 启动、依赖组装、所有 IPC、自动化、Issue 广播 | composition root 与业务服务混在一起，约 400 行 |
| `src/main/runner.ts` | 队列、并发、会话、超时、权限、重试、通知、Git、委派、续聊 | 单类约 749 行，修改影响面大，直接依赖 Electron |
| `src/main/store.ts` | 任务快照、事件日志、迁移 | 每个事件同步写多个文件，并全量重写索引 |
| `src/main/issue-store.ts` | Task 到 Issue/Run/Comment/Notification 的投影 | 每次读取都可能全量同步和写盘 |
| `src/main/backends/zcode.ts` | JSON-RPC、进程、事件解析、模型配置、权限 | 约 708 行，协议传输和领域映射耦合 |
| `src/renderer/src/api.ts` | Bridge 类型、IPC hooks、格式化工具 | 与 preload 重复维护契约，并反向引用 main 类型 |
| `src/renderer/src/components/TaskDetail.tsx` | 事件归并、订阅、权限、评论、Git、运行历史、视图 | 约 955 行，状态和视图无法独立测试 |

### 1.2 验证基线

- `npm run typecheck`：通过。
- `npm run smoke`：当前失败于 `scripts/smoke-runner.mjs` 的任务结果断言。测试替身把 runner 注入的系统提示也拼进了业务 prompt，导致断言依赖实现细节；第一阶段必须先修复该测试契约。
- 当前没有独立测试框架，smoke 脚本是主要回归入口。

### 1.3 不在本轮范围内

- 不迁移到数据库或云服务。
- 不重做 UI 视觉系统，不引入全局状态库。
- 不修改现有 Agent 委派协议和 Git worktree 产品语义，除非为解耦所必需。
- 不在重构期间同时扩展新的后端平台。

---

## 2. 目标结构

```text
src/
  shared/
    types.ts              领域实体和状态枚举
    contracts.ts          IPC DTO、Bridge、跨进程安全类型
    taskflow.ts           唯一状态转换规则
  main/
    index.ts              Electron composition root
    ipc/                  按领域注册 IPC
    application/          task/issue/runtime 服务
    execution/            scheduler、executor、权限、重试、收尾
    persistence/          event-log、task-store、issue-projector
    backends/             transport、protocol、adapter
  renderer/src/
    api/                  由 shared 契约驱动的桥接封装
    hooks/                订阅、事件归并、Issue 查询
    components/task/      时间线、权限、运行历史、评论、Git
```

目标不是一次性移动所有文件，而是先建立边界，再逐步替换调用方。每一步都保留现有 IPC 名称和数据文件格式，避免 UI 与用户数据同时迁移。

---

## 3. 阶段计划

### 阶段 0：建立可回归基线（0.14.0）

**目的**：在改架构前消除红色基线，固定现有行为。

**改动范围**：

1. 修复 `scripts/smoke-runner.mjs` 的 fake backend 断言，使它检查稳定的业务结果，而不是完整的内部 prompt。
2. 给 `TaskRunner`、`TaskStore`、`IssueStore` 增加最小的纯函数 smoke：状态转换、事件 seq、投影幂等、失败分类。
3. 记录当前所有 `npm run smoke:*` 脚本的通过/失败矩阵，写入本文件或 `docs/VALIDATION.md`。
4. 为重构期间保留的 IPC 增加一份 channel 清单，作为后续契约迁移的对照表。

**验收**：`npm run typecheck` 和 `npm run smoke` 通过；所有现有 smoke 脚本有明确结果；不改变用户数据格式和产品行为。

**回滚点**：只修改测试和文档，直接回滚单个提交即可。

### 阶段 1：持久化和事件流解耦（0.14.x）

**目的**：停止高频事件对 Electron 主线程的同步阻塞，并让事件日志成为独立基础设施。

**改动范围**：

1. 将 `src/main/store.ts` 拆为 `task-store.ts` 与 `event-log.ts`。
2. `EventLog.append` 负责 seq 分配、追加和恢复；`TaskStore` 只负责任务快照和元数据。
3. 事件追加使用内存队列 + 有界批量 flush；任务状态变更仍使用临时文件 + rename。
4. 保留进程退出时的显式 flush 和启动时日志尾部恢复。
5. `readEvents` 增加 `afterSeq` 分页/上限语义，避免每次从头扫描整个 JSONL。
6. 所有落盘错误返回结构化结果或抛出可识别错误，禁止静默吞掉关键写入失败。

**兼容要求**：继续读取现有 `userData/tasks/<id>/events.jsonl` 和 `tasks.json`；`eventCount`、事件 seq、回退/截断语义保持不变；异常退出不得产生重复 seq 或半行事件。

**验收**：10,000 个事件写入不再为每个事件全量重写 `tasks.json`；重启后 seq 和 `eventCount` 正确；增量读取可用；批量追加、重启恢复、截断后追加和落盘失败均有 smoke。

**回滚点**：保留旧 `TaskStore` 适配接口，必要时切回同步实现而不改 runner/API。

### 阶段 2：Issue 增量投影（0.15.0）

**目的**：将 Issue/Run 从“每次读取时重建”改为任务变更驱动的增量投影。

**改动范围**：

1. 新增 `IssueProjector`，维护 `issueId -> Issue`、`runId -> Run`、`taskId -> Run` 索引。
2. 将 `IssueStore.sync(tasks)` 拆成启动迁移和单任务 `applyTaskChange(task)` 两条路径。
3. `TaskService` 和 runner 的状态变更统一发布 `TaskChanged` 内部事件；projector 订阅后更新 Issue/Run/Comment/Notification。
4. 查询接口只读内存投影，不再隐式写盘；写入只发生在投影变更时。
5. 保留一次性全量 rebuild 命令，用于升级、修复和 smoke 验证。

**验收**：Issue 查询不触发全量扫描或隐式重建；重复应用变更不会生成重复 Run、Comment 或 Notification；任务完成、失败、重试、续聊、委派子任务和删除的投影结果与现有 UI 一致。

**回滚点**：保留 `rebuildFromTasks()`，必要时通过设置开关回退为全量投影。

### 阶段 3：运行编排拆分（0.15.x）

**目的**：让 `TaskRunner` 只负责协调，去除对 Electron、通知和具体持久化细节的直接依赖。

**拆分顺序**：

1. `Scheduler`：普通任务/worker 队列、并发槽、pump。
2. `Executor`：一次 start/send/stop/close 生命周期和 session 映射。
3. `PermissionBroker`：请求等待、超时、响应和取消清理。
4. `RetryPolicy`：失败分类、attempt 上限、resume/fresh 决策。
5. `TaskFinalizer`：最终文本、usage、Git 快照、状态落盘。
6. `NotificationPort` 与 `EventSink`：由 `index.ts` 注入 Electron 实现；smoke 使用内存实现。
7. `TaskRunner` 保留旧公开方法，内部改为调用上述服务，完成后再收窄接口。

**必须保持的行为**：空闲 watchdog、启动卡死终止、取消级联、权限超时 deny、session resume、委派和阶段接力；普通任务与 worker 使用独立并发上限；现有 task IPC payload 不变。

**验收**：runner 单文件降至 300 行以内，或每个拆分服务有明确单一职责；核心 smoke 可不加载 Electron；取消、超时、启动挂起、续聊和自动重试 smoke 全部通过。

### 阶段 4：IPC 契约统一（0.16.0）

**目的**：消除 preload/renderer/main 的重复类型和无校验输入。

**改动范围**：

1. 在 `src/shared/contracts.ts` 集中定义 IPC DTO、事件 payload、`PermissionRequest`、Agent/Preset 类型和 Bridge 接口。
2. preload 只负责 `ipcRenderer` 转发和事件解绑；不再手写重复接口。
3. renderer `api.ts` 直接引用 shared Bridge 类型，并拆出 hooks 与纯格式化函数。
4. 为所有写入型 IPC 增加运行时 parser：字符串、枚举、数组、路径和 patch 字段逐项校验。
5. 统一错误返回结构：`{ ok: true, data } | { ok: false, error }`；迁移完成后删除旧分支。
6. 将 handler 注册按 tasks/issues/settings/agents/automations 分文件。

**安全边界**：renderer 不再导入 `src/main/**`；shell、任务创建、Issue 更新和权限响应均在 main 侧校验；非法输入不得写入持久化层。

**验收**：删除 preload/renderer 的重复 DTO 后 typecheck 通过；非法 IPC 输入有稳定错误且不改变磁盘数据。

### 阶段 5：后端适配器和 Git 错误模型（0.16.x）

**目的**：让后端协议复杂度停留在 adapter 内，向 runner 暴露稳定结果。

**改动范围**：

1. `cli-common.ts` 的 `any` 改为 `unknown`，增加 JSONL event type guards。
2. 将 `zcode.ts` 拆为 JSON-RPC transport、ZCode protocol、model catalog、BackendSession adapter。
3. Claude/Codex/OpenCode/DSH 统一走 adapter 工厂，保留各自协议差异。
4. `git.ts` 的命令执行返回 `{ ok, stdout, stderr, code }`，调用方不再用空字符串判断错误。
5. worktree 创建、提交、合并和清理失败都写入结构化错误，并映射到 Task/Issue 可读状态。

**验收**：各后端对 runner 只暴露稳定 Backend 接口；进程退出、无输出、非零退出码、JSON 解析失败和 Git 合并冲突都有独立 smoke；`smoke:clis`、`smoke:zcode`、`smoke:delegate` 通过。

### 阶段 6：渲染层拆分和领域模型收口（0.17.0）

**目的**：降低 UI 修改耦合，并明确 Issue、Run、ExecutionRecord 的边界。

**UI 改动范围**：

1. 从 `TaskDetail.tsx` 提取 `useTaskEvents`、`turnModel`、`useIssueDetails`。
2. 拆分 `TurnTimeline`、`PermissionPrompt`、`RunHistory`、`CommentPanel`、`GitSummary`。
3. 保留现有 DOM 类名和交互行为，先做职责迁移，再做视觉调整。
4. 将任务操作统一走 task service 对应的 bridge command，组件不再拼装业务参数。

**模型收口**：

1. 将 Task 明确定义为执行兼容模型，新增内部 `ExecutionRecord` 语义。
2. 集中状态转换到 `shared/taskflow.ts`，删除 runner、index、IssueStore 中重复的状态判断。
3. UI 新功能优先读取 Issue/Run；Task API 只保留日志、会话恢复和兼容详情所需字段。
4. 为旧 `tasks.json` 增加 schema version 和显式迁移函数，禁止继续堆叠隐式兼容字段。

**验收**：`TaskDetail.tsx` 降至 300 行以内；事件归并有独立 smoke；状态转换规则只有一个实现；旧数据迁移、委派、重试、续聊和删除行为保持一致；全量 smoke 和 `npm run dist` 通过。

### 阶段 7：目标模式（0.18.0，框架重构完成后）

**目的**：增加一个面向用户的长期目标执行模式。用户提交目标后，AgentDeck 可以在同一 Issue 下连续执行、检查进展、创建后续 Run，并在达到完成条件、需要用户决策或触发安全边界时停止。

这不是简单的“无限自动续聊”，而是建立在阶段 1-6 的事件日志、Run 模型、状态机、IPC 契约和执行编排之上的产品能力。

**产品模型**：

- `Goal`：目标文本、完成条件、停止条件、最大 Run 数、最大总时长、当前状态。
- `GoalRun`：目标驱动的一次 Run，复用现有 `Run`，增加 `goalId` 和阶段序号。
- `GoalCheckpoint`：每轮结束时保存的摘要、已完成条件、未完成条件、下一步计划和阻塞原因。
- 一个 Goal 归属一个 Issue；每个阶段仍保留独立 Task/Run/事件日志，支持回看和重跑。

**目标状态**：

```text
draft → active → waiting_user → completed
                  └──────────→ blocked / cancelled / failed
```

**第一版范围**：

1. 创建目标时填写目标描述、完成条件和最大预算；默认复用当前 Agent、工作目录和权限模式。
2. 每个 Run 结束后由 `GoalController` 判断：已完成、继续执行、等待用户、失败或达到预算。
3. 继续执行时创建同一 Issue 下的新 Run，携带结构化 checkpoint，不依赖完整历史 prompt。
4. 用户可以暂停、继续、取消目标，并查看每个阶段的结果和消耗。
5. 委派仍由当前 Agent 能力决定；目标模式不新增第二套委派协议。
6. 触发权限请求、工作区冲突、预算耗尽、连续失败或需要选择时必须停止并明确原因。

**不在第一版范围内**：

- 无限循环或无预算的后台执行。
- 跨 Issue 目标依赖图。
- 自动修改用户未授权的工作目录或自动发布外部结果。
- 重新实现一套与 `<continue>` 并行的阶段接力协议。

**实现拆分**：

1. `src/shared/contracts.ts`：增加 Goal/Checkpoint/GoalStatus 与目标命令 DTO。
2. `src/main/goal-controller.ts`：预算、状态转换、checkpoint 和下一 Run 决策。
3. `src/main/goal-store.ts`：目标元数据和 checkpoint 持久化，复用现有原子写入约束。
4. `src/main/index.ts`：注册 `goals:*` IPC，并把 Run 终态事件接入 controller。
5. `src/renderer/src/components/goal/`：目标创建、进度、阶段历史、暂停/继续/取消和阻塞原因。
6. `scripts/smoke-goal.mjs`：覆盖完成、继续、暂停、取消、预算耗尽、失败和重启恢复。

**验收**：

- 同一 Goal 的多个 Run 可恢复、可审计，不重复创建 Issue。
- 每次自动继续都有 checkpoint 和预算扣减记录。
- 应用重启后 active Goal 不会静默运行；恢复后进入 `waiting_user` 或按明确策略继续。
- 权限、取消、并发和失败状态不会绕过 Goal 状态机。
- 全量 typecheck、smoke、目标模式 smoke 和 `npm run dist` 通过。

**依赖**：必须在阶段 1-6 完成后开始；尤其依赖增量事件日志、Run/Issue 投影、统一 IPC 契约和拆分后的 Executor/Finalizer。

### 阶段 8：并发与架构收口（0.18.x）

**目的**：把并发 hotfix 固化进阶段 3-5 的正式模块边界，避免临时修复继续堆在 runner、主入口和 adapter 单文件中。

**完成范围**：

1. runner 使用 `Scheduler`、`Executor`、`PermissionBroker`、`retry-policy` 和 `TaskFinalizer`；保留既有公开方法与委派/接力协议。
2. 取消、启动超时、迟到 session、旧回合事件、429 退避 timer 和 provider session ID 纳入同一生命周期语义。
3. IPC 按 goals/tasks/issues/catalog/system 拆分注册，写入口以 `unknown` 接收并在触达 store 前校验。
4. ZCode 拆出 JSON-RPC transport、protocol helpers 和配置/model catalog；一次性 CLI adapter 使用 per-session 进程句柄与 JSON guards。
5. 新增串行 `smoke:all` 与执行服务 smoke，防止多个测试并发覆盖 `out` 临时 bundle。

**验收**：`npm run typecheck`、`npm run smoke:all`、真实 `smoke:clis`、真实 `smoke:zcode` 和 `npm run dist` 通过；并发取消、启动期取消、429 resume/取消退避、显式 relay、流式提前委派和 Goal 重启恢复均有回归。真实 provider 的 429 与延迟观察写入 `docs/CONCURRENCY-HOTFIX-REPORT.md` 和 `docs/VALIDATION.md`。

---

## 4. 依赖关系和提交策略

```text
阶段 0 基线
   ↓
阶段 1 事件日志
   ↓
阶段 2 Issue 投影
   ↓
阶段 3 运行编排 ─────┐
   ↓                 │
阶段 4 IPC 契约      │
   ↓                 │
阶段 5 Backend/Git ──┘
   ↓
阶段 6 UI 与模型收口
   ↓
阶段 7 目标模式
   ↓
阶段 8 并发与架构收口
```

- 每阶段至少一个独立提交；阶段 1、2、3 不与视觉改动混合。
- 每个提交说明迁移前后数据格式、回滚方式和验证命令。
- 不在同一提交中同时修改存储格式和所有 UI 读取路径；先提供兼容适配，再移除旧路径。
- 发生回归时优先回滚最后一个边界迁移，不回滚用户数据目录。
- 目标模式必须作为独立版本和独立数据迁移发布，不与框架重构提交混合。

---

## 5. 统一验收门槛

每个阶段结束必须满足：

1. `npm run typecheck` 通过。
2. 与阶段相关的 smoke 通过；阶段 0 起全量 `npm run smoke` 必须保持通过。
3. 关键数据迁移可重复执行，不重复生成 Issue、Run、Comment 或 Notification。
4. 任务取消、超时、重试、续聊、权限超时和应用退出均有验证记录。
5. 不引入新的 `any` 到跨进程契约；新增类型必须位于 shared 或 adapter 内部。
6. 文档同步更新 `docs/ARCHITECTURE.md`、`docs/API.md` 和 `CHANGELOG.md`。

性能观察项：事件高频写入时主进程事件循环延迟；任务数量和事件数量增长后的 Issue 查询耗时；renderer 实时事件追加时的渲染次数和内存增长；异常退出后的恢复耗时和数据完整性。

---

## 6. 风险与处理

| 风险 | 影响 | 处理 |
|---|---|---|
| 批量 flush 丢失尾部事件 | 日志或结果不完整 | 退出前 flush；每批有 seq；启动扫描尾部并重建计数 |
| projector 与旧 index 不一致 | Issue/Run 重复或状态错误 | 保留全量 rebuild；投影操作幂等；迁移 smoke 覆盖 |
| runner 拆分改变竞态语义 | 任务卡在 running 或重复结束 | 先提取纯策略，再移动副作用；保留 watchdog/turn generation smoke |
| IPC 契约迁移导致 renderer 崩溃 | UI 无法启动 | 先新增 shared 类型和兼容 wrapper，再删除重复接口 |
| Git 错误模型改变集成结果 | 委派结果误报成功 | 先增加结构化返回和日志，再改变上层成功判定 |
| 旧任务数据字段继续增长 | 迁移成本累积 | 引入 schema version，新增字段必须有迁移和废弃策略 |

---

## 7. 第一轮执行清单

1. 修复 `smoke-runner.mjs` 红色断言并记录全量 smoke 基线。
2. 新增事件日志与投影的纯函数 smoke，不先改生产调用方。
3. 抽取 `EventLog`，保持 `TaskStore` 公开方法兼容。
4. 将 runner 的事件写入切换到新日志接口，验证取消、超时和重启恢复。
5. 抽取 `IssueProjector`，让读取路径停止调用 `sync(store.list())`。
6. 通过 smoke 后再开始拆分 runner 和 IPC；任何阶段不得跨越未通过的前置验收。

第一轮完成标志：事件写入不再每次重写全量任务索引，Issue 查询不再隐式全量重建，且原有 smoke 全部恢复为绿色。
