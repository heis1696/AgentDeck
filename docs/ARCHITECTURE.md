# AgentDeck 架构文档

> 当前重构基线。本地多 agent 协作台：五个 agent CLI 平台（zcode/claude/codex/opencode/dsh）同队，委派内置、领队自主拆解派工，全程本地运行。

---

## 1. 总览

```
┌─────────────────────────────────────────────────────────────┐
│ Electron 主进程（Node）                                       │
│                                                             │
│  index.ts ── 依赖装配 ──► ipc/（按领域注册 channel）             │
│      │                                                      │
│  TaskRunner ── Scheduler/Executor ──► backends（5 个适配器）   │
│      │   ▲                    │        │        │        │   │
│      │   └── attachTeam       zcode   claude   codex  opencode│
│      │       (agents.json)   (常驻)   (一次性×3)       dsh    │
│      │                                                      │
│  delegate.ts ◄──委派循环（领队回合后驱动）                      │
│      │                                                      │
│  TaskStore（文件存储）      git.ts（worktree/merge/快照）        │
└──────────────┬──────────────────────────────────────────────┘
               │ preload（contextBridge → window.agentdeck）
┌──────────────┴──────────────────────────────────────────────┐
│ 渲染进程（React）                                             │
│  App → 侧栏导航 → WorkspaceView（快速输入）/                │
│         TaskDetail（日志/结果/Git/子任务/权限横幅）/           │
│         TeamView（队伍编辑）/ SettingsView                    │
└─────────────────────────────────────────────────────────────┘
```

无云端、无服务进程、无数据库——全部状态在 `userData/` 的 JSON/JSONL 文件里。

## 1.1 产品级工作模型（Issue-first）

AgentDeck 的用户工作单元是 **Issue**，不是无限增长的聊天会话：

```
Issue（目标、状态、负责人、评论时间线）
  └─ Run × N（每次指派、提及、自动化或手动执行）
       └─ Task（本地 CLI 执行兼容记录）
```

每个 Run 都保留独立的状态、触发来源、执行日志和用量。成功/失败结束后，IssueStore 将结果写成带 `runId` 的 Agent 报告评论，并创建收件箱通知；用户可以在同一 Issue 的评论中 `@agent`，触发新的 Run，而不会创建新的 Issue。Task 仍负责进程、事件流、会话恢复和 git 快照，作为本地执行层兼容契约。

---

## 2. 核心概念

### 2.1 Agent（队员）

`{ id, name, backend, role?, systemPrompt?, subordinates?, color }`

- **身份**：定位 + 系统提示词，注入该队员的每个任务（`buildAgentPrompt`）
- **能力**：`subordinates` 非空即领队——任务提示自动附加委派协议，对话中可派工
- 同一平台可建多个队员（如"Claude 审查员"），身份互不相同
- 预置五名：ZetCode（领队，GLM）、Claude、Codex、OpenCode、DeepSeek

### 2.2 Task（任务）与委派

子任务通过 `parentTaskId` 挂在领队下（侧栏缩进展示）；领队集成结果记 `Task.integration {branch, note}`（0.4.0 删除了旧 squad 双轨，存量自动迁移）。0.7.0 起支持二层委派：队员带 subordinates 即为子领队，可继续下派——防环（祖先链检测）+ 层级上限 3 层 + 全链共享 8 轮预算；派工可带 reason 留痕；集成递归合入子领队的集成分支；worktree 一律归位主仓库根。
没有"协同模式"开关——**委派是领队队员的内在能力**：

```
用户 → 领队：升级 utils.py 并补文档
领队回合1：判断两件事可并行 → 输出 <delegate to="Claude">…</delegate> ×2
   ├─ 系统截获标记：sanitize 路径 → 各建 worktree → 子任务入队（独立并发通道）
   ├─ 子任务各自执行（真并行，互不污染）
   └─ 全部终态后结果回灌领队会话
领队回合2：核验、收尾（可再派/可自己做）→ 最终总结（无标记）
系统：子任务分支合入 agentdeck/task-<id> 集成分支；领队结果剥除标记落盘
```

设计取舍：

| 决策 | 理由 |
|---|---|
| 协议用输出标记而非注入原生工具 | 各 CLI 无统一工具注入面；标记法对任何可续聊后端成立 |
| 子任务在独立 git worktree | 真并行 + 零冲突合并；用户当前分支永不被自动改 |
| 结果回灌而非子任务直连领队 | 领队保有完整决策上下文，可多轮调整 |
| 领队编排不占并发槽 | 避免 concurrency=1 时领队等子任务、子任务等领队的死锁 |
| 子任务并发独立通道 | 委派扇出不受普通任务节流影响 |

### 2.3 后端抽象

`AgentBackend`（probe/start）+ `BackendSession`（send/stop/close）统一两种进程模型：

- **常驻服务型**（zcode）：stdio JSON 协议，会话存活多轮，`send` 即续聊
- **一次性进程型**（claude/codex/opencode/dsh）：每回合一进程，resume 参数续聊；dsh 无 resume

新平台接入成本 ≈ 一个适配器文件 + 注册一行（见 `docs/API.md` §4）。

---

## 3. 模块地图

```
src/
├── main/                     主进程
│   ├── index.ts              窗口、backend/agent 装配、启动恢复
│   ├── ipc/                  goals/tasks/issues/catalog/system 注册器
│   ├── runner.ts             执行协调、会话映射、取消级联、委派接入
│   ├── scheduler.ts          普通任务/worker 双通道队列与并发槽
│   ├── executor.ts           start/超时/取消竞态与迟到 session 清理
│   ├── retry-policy.ts       失败 attempt、resume/fresh 和退避纯策略
│   ├── permission-broker.ts  权限等待、响应、超时与取消清理
│   ├── task-finalizer.ts     最终文本、用量、Git 快照与状态落盘
│   ├── delegate.ts           委派协议：解析/身份注入/循环/worktree 派发/集成/
│   │                         委派单审核（<review> → applyReview）
│   ├── goal-controller.ts    目标模式循环引擎：Issue 收养、checkpoint、续轮/护栏决策
│   ├── goal-store.ts         目标与 GoalCheckpoint 持久化（userData/goals/）
│   ├── store.ts              任务与事件的文件存储（seq 单调分配）
│   ├── agents.ts             队伍持久化 + 预置 + 迁移补员
│   ├── settings.ts           设置持久化
│   ├── git.ts                isGitRepo/snapshot/commitAll/createWorktree/
│   │                         mergeBranchInto/branchDiffSummary
│   └── backends/
│       ├── types.ts          AgentBackend / BackendSession / PermissionRequest
│       ├── zcode.ts          ZCode 协议到 BackendSession 的映射
│       ├── zcode-transport.ts JSON-RPC stdio transport 与进程树清理
│       ├── zcode-config.ts   CLI 配置迁移、runtimeModel 与模型目录
│       ├── zcode-protocol.ts ZCode 消息 guard、握手与事件辅助映射
│       ├── claude.ts         -p stream-json（含费用）
│       ├── codex.ts          exec --json（Windows 必须 bypass 沙箱）
│       ├── opencode.ts       run --format json
│       ├── dsh.ts            --profile headless（纯文本，无流无 resume）
│       ├── cli-common.ts     JSONL 行解析 + 空闲超时 + 输出上限
│       └── cli-locator.ts    Windows npm .cmd 垫片解析（防 EINVAL）
├── preload/index.ts          contextBridge 桥（window.agentdeck）
├── renderer/src/             React UI
│   ├── App.tsx               视图路由（任务/队伍/设置）
│   ├── api.ts                bridge 类型 + hooks（useTasks/useSettings）
│   └── components/           WorkspaceView/TaskDetail/TeamView/
│                             SettingsView/Markdown
└── shared/types.ts           Task/TaskEvent/AppSettings 跨进程契约
```

---

## 4. 关键数据流

### 4.1 任务执行（单 agent）

```
create → queued → pump 取队 → running
  → buildAgentPrompt（身份注入）
  → backend.start（spawn/连接）
      事件流: onEvent → store.appendEvent（seq 分配+落盘）→ IPC 推送 → UI 实时渲染
  → onTurnEnd（首回合）
  → [领队: runDelegationLoop]
  → finalizeDone（结果 + snapshotGitAfter + 通知）→ done
```

### 4.2 委派子任务

```
delegate 标记 → 目标解析（限 subordinates，名字/平台 id 忽略大小写）
  → sanitizeChildPrompt（绝对路径→相对，防改错目录）
  → createWorktree（.agentdeck-worktrees/<taskId>_cN，exclude 入 .git/info/exclude）
  → 子任务入队（worker 并发通道）→ 独立执行/日志/权限
  → 终态后：commitAll（排除 __pycache__ 等）→ mergeBranchInto 集成分支
  → branchDiffSummary 总 diff → 领队任务 gitStat/gitDiff
```

### 4.3 权限确认（非 yolo 模式）

```
后端 onPermission → runner.askPermission（5 分钟超时自动 deny）
  → IPC task:permission → UI 横幅 → respondPermission → 选项回传后端
```

### 4.4 重启恢复

- 重启清扫（0.4.0）：加载时把悬挂的 running 任务（含旧 squad 存量）标为 failed 并提示重跑，不再永久"执行中"
- 新委派任务重启后：领队任务标 failed（子任务结果已保留），可单看/重跑

---

## 5. 可靠性设计

| 机制 | 防什么 |
|---|---|
| 流式看门狗（zcode 单回合 300KB / CLI 总量 5MB + 10 分钟空闲） | 模型退化循环（实测 GLM 曾 10 分钟吐 1.5MB） |
| 子进程 stderr 尾巴随错误抛出 | 真实失败原因被吞（曾导致 node:sqlite 排查困难） |
| store 原子写（tmp+rename）+ seq 从文件尾恢复 | 中断损坏与日志重复 |
| launchHandles 启动即注册 | 一次性 CLI 在 session 返回前无法取消/杀错进程 |
| 集成"无合并不报成功" | 误报（实测绝对路径导致空合并仍报成功） |
| sanitizeChildPrompt | 领队指令带主仓库绝对路径，队员改错目录 |
| 退出码/非零即失败 + 无输出判失败（opencode） | 静默假成功 |

---

## 6. 已知限制（封板范围外）

- dsh 无流式过程与续聊（协议本身不提供）
- 领队自己动手的改动留在主工作区（不自动提交，设计使然）
- 委派最多 3 层、全链最多 8 轮；不支持无上限递归派发
- 日志无虚拟滚动（单任务万级事件才需要）
- Windows 沙箱限制：codex 必须 bypass（workspace-write 下命令执行会失败）
- 未做多显示器/DPI 与国际化（界面中文）

---

## 7. 阶段 6 渲染与领域边界

阶段 6 的渲染入口保持 `TaskDetail` 兼容组件，但职责已拆到独立模块：

- `renderer/src/hooks/useTaskEvents.ts` 负责事件订阅、按 `seq` 归并、权限响应和回退刷新。
- `renderer/src/hooks/turnModel.ts` 负责把 `TaskEvent[]` 转为回合模型；流式文本与重复 `final` 只保留一个最终消息。
- `renderer/src/hooks/useIssueDetails.ts` 负责 Issue、Run、Comment 查询与更新。
- `renderer/src/components/task/` 提供 `TurnTimeline`、`PermissionPrompt`、`RunHistory`、`CommentPanel` 和 `GitSummary`。
- `renderer/src/task-service.ts` 是任务操作到 Bridge command 的单一入口。

领域边界为 `Issue -> Run -> Task`：Issue 是用户工作单元，Run 是一次面向 Issue 的执行投影，Task 是本地 CLI 兼容记录；`ExecutionRecord` 由 `shared/taskflow.ts` 提供唯一映射。任务状态转换、Issue/Run 状态派生均集中在 `shared/taskflow.ts`。

`tasks/tasks.json` 使用 `{ schemaVersion, tasks }` envelope。`migrateTaskIndex` 显式处理版本 0 数组和当前版本，旧字段迁移与坏记录过滤是幂等的，未来版本会拒绝加载。

## 7.1 目标模式 v2：Issue 内自动推进（Goal-based Loop）

目标模式 v2 不再建立独立「目标」页或合成 Issue（`iss_goal_xxx`），而是**在真实 Issue 内开启**，按 Loop Engineering 的 Goal-based loop 理念自动推进（对照 `docs/LOOP-ENGINEERING.md` §3 模块映射：Goal-based loop → `goal-controller.ts` + `goal-store.ts`）。`Goal` 层作为持久化状态脊柱叠加在 `Issue -> Run -> Task` 之上，不替代该模型：

- **目标绑定真实 Issue**：`GoalCreateInput.issueId` 必填。开启即「收养」该 Issue 当前最新 Task 作为阶段任务：无 Task → 建首个（prompt 末尾注入目标模式块，startNow 即入队）；有 Task → 登记为当前阶段任务，startNow 时按其状态启动（queued/running 等执行、done/failed 走续聊回灌）。循环跟随 Issue 最新任务（天然含 `<continue>` 接力产生的 handoff 任务），不再只认自己建的任务。
- **自省自推直到完成条件达成**：每轮 Task 终态（含失败/取消）→ 解析 checkpoint envelope 落盘 `GoalCheckpoint`（runId 幂等，状态脊柱）→ 预算扣减与护栏决策 → 续轮**优先同会话续聊回灌**（`continueTask` = `runner.followUp`，不重开上下文）；后端未注入续聊或 Task 无 `sessionId` 时**兜底新建 Task**（prompt = 目标块 + checkpoint 简报）。
- **完成判定可验证**：checkpoint 的 `completedConditions` 由 agent 逐条对照完成条件原文填写（不再靠 prose 撞子串）。全部达成的那一轮 → goal completed，经 `finalizeIssue` 把 Issue 自动归档 done；预算耗尽 → blocked、停止条件命中 → waiting_user、连续失败超限 → failed，均停下并写明原因。
- **委派单 maker/checker 审核流**：委派结果回灌后，领队（checker）须对每个 done 单输出 `<review of="#单号" verdict="pass|fail" note="…"/>` 结论——pass → 对应 Issue 看板状态置 done（自动归档）；fail → 置 blocked 并由领队下一轮改派或自行修复；未出结论的单保持 in_review（人工兜底）。写回复用 `issue-store` 的 `updateWorkflow`/`statusOverride`，审核得到的 done 不会被后续状态投影翻回。
- **预算与护栏**：运行/时长预算、停止条件保留 v1 语义；连续非重试失败由 `Goal.failures`（可选，持久化）计数，`failures < 2` 自动续轮（回灌带失败上下文），≥2 → goal failed。重启恢复仍为 active → waiting_user，需显式 continue，绝不静默续跑。
- **持久化与接线**：`goal-store.ts` 写 `userData/goals/index.json`（与任务存储同样 tmp+rename）；`goal-controller.ts` 拥有生命周期、预算、checkpoint 与续轮决策，复用 TaskRunner 的创建/队列/取消/权限边界。主进程经 `ipc/goals.ts` 注册 `goals:*` handler，更新推送为 `goals:updated`。
- **渲染层**：删除整页 `GoalsView` 与「目标」导航（App.tsx）；`components/goal/GoalPanel.tsx` 嵌入 TaskDetail 侧栏（开启对话框、状态 chip、轮数预算、checkpoint 历史、暂停/继续/取消）；BoardView 给非终态目标的 Issue 卡片加 🎯 徽标。

## 8. 测试与验证基线

| 套件 | 命令 | 覆盖 |
|---|---|---|
| runner 状态机 | `npm run smoke` | 完成/续聊/取消/失败/超时/迟到 session 隔离 |
| 执行服务 | `npm run smoke:execution-services` | Executor 迟到清理与 RetryPolicy 决策 |
| zcode 适配器 | `npm run smoke:zcode` | 真实回合端到端 |
| 三个 CLI 适配器 | `npm run smoke:clis` | claude/codex/opencode 真实回合 |
| 数据迁移 | `npm run smoke:migration` | 0.3.x→0.4 schema（mode/squad→integration、悬挂 running 清扫） |
| 失败分类 | `npm run smoke:failure` | 11 类规则 + runner 落库 |
| 自动重试 | `npm run smoke:retry` | 瞬态重试/非瞬态不重试/上限打满 |
| diff 解析 | `npm run smoke:diff` | DiffView 解析器边界 |
| 委派循环 | `npm run smoke:delegate` | 假后端：多轮派发/剥离/集成/取消 + 单号报告与 `<review>` 审核（pass/fail/无结论不动状态） |
| 真实委派 e2e | `npm run e2e:delegate` | GLM 领队自发派 Claude/OpenCode + 集成分支 |
| 真实异构 e2e | `npm run e2e:delegate` | zcode 领队 + claude/opencode 队员（领队自主决策） |
| 目标模式 | `npm run smoke:goal` | Issue 收养、checkpoint envelope 完成判定与 Issue 自动归档、预算/停止条件/连续失败护栏、重启恢复、无续聊时新任务兜底 |
| 全量本地矩阵 | `npm run smoke:all` | 所有纯本地 smoke 串行执行 |

打包：`npm run dist`（NSIS）；开发：`npm run dev`；类型：`npm run typecheck`。
