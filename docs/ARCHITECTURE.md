# AgentDeck 架构文档

> 对齐 v0.13.x。本地多 agent 协作台：五个 agent CLI 平台（zcode/claude/codex/opencode/dsh）同队，Issue-first 工作流，委派内置、领队自主拆解派工，目标模式在 Issue 内自动推进，全程本地运行。

---

## 1. 总览

```
┌────────────────────────────────────────────────────────────────┐
│ Electron 主进程（Node）                                          │
│                                                                │
│  index.ts ── 依赖装配 ──► ipc/（按领域注册 channel，入参全量校验）    │
│      │                                                         │
│  TaskRunner ── Scheduler/Executor ──► backends（5 个适配器）       │
│      │   ▲                    │        │        │        │      │
│      │   └── attachTeam       zcode   claude   codex  opencode  │
│      │       (agents.json)   (常驻)   (一次性×3)        dsh      │
│      │                                                         │
│  delegate.ts ◄──委派循环（领队回合后驱动）                          │
│  goal-controller.ts ◄──目标模式循环（每轮 Task 终态后驱动）          │
│  automation-store + 15s tick ◄──定时触发                          │
│      │                                                         │
│  TaskStore / IssueStore / GoalStore（文件存储）                    │
│  git.ts（worktree 创建/回收/合并/快照）                            │
└──────────────┬─────────────────────────────────────────────────┘
               │ preload（contextBridge → window.agentdeck）
┌──────────────┴─────────────────────────────────────────────────┐
│ 渲染进程（React）                                                 │
│  App → 侧栏导航：Issue（队列/详情）/ 看板 / Agent / 收件箱 /        │
│         自动化 / 技能 / 用量 / 设置                                │
│  TaskDetail（日志/结果/Git/子任务/权限/GoalPanel 侧栏）             │
└────────────────────────────────────────────────────────────────┘
```

无云端、无服务进程、无数据库——应用状态全部在 `userData/` 的 JSON/JSONL 文件里；用户资产（技能库）在独立共享目录（默认 `~/.agentdeck`，可配置），两者互不混写。

## 1.1 产品级工作模型（Issue-first）

AgentDeck 的用户工作单元是 **Issue**，不是无限增长的聊天会话：

```
Issue（目标、状态、负责人、评论时间线）
  └─ Run × N（每次指派、提及、自动化、目标阶段或手动执行）
       └─ Task（本地 CLI 执行兼容记录）
            └─ Goal 阶段（goalId + phaseIndex 标记，可选）
```

每个 Run 都保留独立的状态、触发来源、执行日志和用量。成功/失败结束后，IssueStore 将结果写成带 `runId` 的 Agent 报告评论，并创建收件箱通知；用户可以在同一 Issue 的评论中 `@agent`，触发新的 Run，而不会创建新的 Issue。Task 仍负责进程、事件流、会话恢复和 git 快照，作为本地执行层兼容契约。Goal 是叠加在 `Issue -> Run -> Task` 之上的持久化状态脊柱（§7.1），不替代该模型。

---

## 2. 核心概念

### 2.1 Agent（队员）

`{ id, name, backend, model?, presetId?, role?, systemPrompt?, subordinates?, note?, color }`

- **身份**：定位 + 系统提示词，注入该队员的每个任务（`buildAgentPrompt`）
- **能力**：`subordinates` 非空即领队——任务提示自动附加委派协议，对话中可派工
- **模型/连接**：可钉死模型（`model`）或绑定 API 预设（`presetId`，baseURL/apiKey 按会话内存注入，不写全局配置）；平台模型目录经 `agents:models` 拉取
- 同一平台可建多个队员（如"Claude 审查员"），身份互不相同
- 预置五名：ZetCode（领队，GLM）、Claude、Codex、OpenCode、DeepSeek

### 2.2 Task（任务）与委派

子任务通过 `parentTaskId` 挂在领队下（侧栏缩进展示）；领队集成结果记 `Task.integration {branch, note}`。支持二层委派：队员带 subordinates 即为子领队，可继续下派——防环（祖先链检测）+ 层级上限 3 层 + 全链共享 8 轮预算；派工可带 reason 留痕；集成递归合入子领队的集成分支；worktree 一律归位主仓库根。

没有"协同模式"开关——**委派是领队队员的内在能力**：

```
用户 → 领队：升级 utils.py 并补文档
领队回合1：判断两件事可并行 → 输出 <delegate to="Claude">…</delegate> ×2
   ├─ 系统截获标记：sanitize 路径 → 各建 worktree → 子任务入队（独立并发通道）
   ├─ 子任务各自执行（真并行，互不污染）
   └─ 全部终态后结果带单号回灌领队会话
领队回合2：对每个 done 单输出 <review> 审核 → 核验、收尾（可再派/可自己做）→ 最终总结（无标记）
系统：子任务分支合入 agentdeck/task-<id> 集成分支；领队结果剥除标记落盘
```

设计取舍：

| 决策 | 理由 |
|---|---|
| 协议用输出标记而非注入原生工具 | 各 CLI 无统一工具注入面；标记法对任何可续聊后端成立 |
| 子任务在独立 git worktree | 真并行 + 零冲突合并；用户当前分支永不被自动改 |
| worktree 用后即回收 | 合入集成分支后立即 removeWorktree + 删工作分支；删任务连带回收；启动清扫兜底 |
| 结果回灌而非子任务直连领队 | 领队保有完整决策上下文，可多轮调整；单号 + `<review>` 审核（maker/checker）落看板状态 |
| 领队编排不占并发槽 | 避免 concurrency=1 时领队等子任务、子任务等领队的死锁 |
| 子任务并发独立通道 | 委派扇出不受普通任务节流影响 |

### 2.3 后端抽象

`AgentBackend`（probe/start）+ `BackendSession`（send/stop/close）统一两种进程模型：

- **常驻服务型**（zcode）：stdio JSON 协议，会话存活多轮，`send` 即续聊
- **一次性进程型**（claude/codex/opencode/dsh）：每回合一进程，resume 参数续聊；dsh 无 resume

会话事件除日志/回合终态外还有 `onHeartbeat`（连接上有任何消息即回调，供空转看门狗续命——模型长思考、后台子代理不误判超时）与 `onSessionId`（provider session id 一经知晓立即持久化，首轮 429 也能续会话）。

新平台接入成本 ≈ 一个适配器文件 + 注册一行（见 `docs/API.md` §4）。

---

## 3. 模块地图

```
src/
├── main/                     主进程
│   ├── index.ts              窗口、依赖装配、createTask 单一创建路径、
│   │                         启动清扫（sweepWorktrees + goalController.recover）
│   ├── ipc/                  领域注册器：goals/tasks/issues/catalog/skills/system
│   │   ├── context.ts        IpcContext（依赖容器：stores/runner/agents/createTask…）
│   │   └── register.ts       装配入口；全部写入口 main 侧收 unknown 并校验
│   ├── ipc-validation.ts     parseId/parseContent/parseTaskCreate… 纯校验器
│   ├── runner.ts             执行协调、会话映射、取消级联、委派/接力/目标接入、
│   │                         followUp（done/failed/cancelled 均可续聊）
│   ├── scheduler.ts          普通任务/worker 双通道队列与并发槽（parked 跳过）
│   ├── executor.ts           start/超时/取消竞态与迟到 session 清理
│   ├── retry-policy.ts       失败 attempt、resume/fresh 和退避纯策略
│   ├── permission-broker.ts  权限等待、响应、超时与取消清理
│   ├── task-finalizer.ts     最终文本、用量、Git 快照与状态落盘
│   ├── delegate.ts           委派协议：解析/身份注入/循环/worktree 派发与回收/
│   │                         集成/<review> 审核/<continue> 接力/<round> 评估
│   ├── goal-controller.ts    目标模式循环引擎：Issue 收养、checkpoint、续轮/护栏决策、
│   │                         remove（清除目标）
│   ├── goal-store.ts         目标与 GoalCheckpoint 持久化（userData/goals/index.json）
│   ├── issue-store.ts        Issue/Run/Comment/Notification 持久化与 Task→Issue 投影
│   │                         （userData/issues/index.json；updateWorkflow/statusOverride）
│   ├── store.ts              任务与事件的文件存储（EventLog seq 单调分配）
│   ├── event-log.ts          单任务追加日志：offset 索引、seq 恢复、truncateEvents（rewind）
│   ├── automation-store.ts   定时自动化持久化（userData/automations/index.json）
│   ├── analytics.ts          用量/失败按后端与队员聚合（AnalyticsSummary）
│   ├── usage.ts              从事件流聚合 TaskUsage
│   ├── runtime.ts            运行时健康快照探测（probeRuntimes，带超时）
│   ├── failure.ts            失败分类：11 类稳定 code + 人话标题 + 处置提示
│   ├── skills.ts             共享目录技能库：SKILL.md 解析/CRUD/导入（纯 Node，目录参数注入）
│   ├── skill-targets.ts      技能安装目标注册表与同步状态（claude/codex/zcode/agents，路径逃逸校验）
│   ├── agents.ts             队伍持久化 + 预置 + 迁移补员
│   ├── presets.ts            API 预设（baseURL/apiKey）持久化 + 连通性探测
│   ├── settings.ts           设置持久化（theme/concurrency/…/sharedDir）
│   ├── git.ts                isGitRepo/snapshot/commitAll/createWorktree/removeWorktree/
│   │                         sweepWorktrees/deleteBranch/mergeBranchInto/branchDiffSummary
│   └── backends/
│       ├── types.ts          AgentBackend / BackendSession / SessionEvents（onHeartbeat…）
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
├── preload/index.ts          contextBridge 桥（window.agentdeck，契约 = shared/contracts.ts）
├── shared/                   跨进程契约
│   ├── types.ts              Task/TaskEvent/Issue/Run/Goal/AppSettings…
│   ├── contracts.ts          AgentDeckApi 桥接口 + 各 *CreateInput + PermissionRequest
│   ├── taskflow.ts           任务状态转换、Issue/Run 派生、ExecutionRecord 唯一映射
│   └── skills.ts             SkillMeta/SkillDetail/SkillTarget/SyncState
└── renderer/src/             React UI
    ├── App.tsx               视图路由 + 侧栏（Issue/看板/Agent/收件箱/自动化/技能/用量/设置）
    │                         + 命令面板 Ctrl+K + Toast/确认框/菜单
    ├── api.ts                bridge 类型 + hooks（useTasks/useSettings）
    ├── task-service.ts       任务操作 → Bridge command 单一入口
    ├── hooks/                useTaskEvents（订阅+seq 归并）/turnModel（事件→回合模型）/
    │                         useIssueDetails/eventMerge
    └── components/
        ├── IssuesView / BoardView（看板五列）/ WorkspaceView（新建）
        ├── TaskDetail + task/（TurnTimeline/PermissionPrompt/RunHistory/CommentPanel/GitSummary）
        ├── goal/GoalPanel    Issue 详情侧栏的目标模式面板（开启/状态/checkpoint/清除）
        ├── AgentsView / SkillsView（编辑器+同步状态）/ AutomationView / InboxView
        ├── UsageView / RuntimeView（设置页内）/ SettingsView / DiffView / Markdown / TabBar
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

### 4.2 委派子任务（含 worktree 生命周期）

```
delegate 标记 → 目标解析（限 subordinates，名字/平台 id 忽略大小写）
  → sanitizeChildPrompt（绝对路径→相对，防改错目录）
  → createWorktree（.agentdeck-worktrees/<taskId>_cN，记录 owner/base SHA/branch/cleanup metadata）
  → 子任务入队（worker 并发通道）→ 独立执行/日志/权限
  → 终态后：commitAll（排除 __pycache__ 等）→ mergeBranchInto 集成分支
  → 集成成功即回收：removeWorktree + deleteBranch（失败/冲突保留现场）
  → branchDiffSummary 总 diff → 领队任务 gitStat/gitDiff
兜底回收：tasks:delete 连带回收名下 worktree；启动时 sweepWorktrees/pruneWorktrees 清扫
          已删任务目录与 .agentdeck-merge-* 临时目录（进程被杀时 finally 兜不住）。
          脏目录、冲突现场和 manualKeep 标记 fail-closed 保留并记录原因；
          仅带 agentdeck/ 前缀且已脱离 worktree 的临时分支允许自动删除。
```

### 4.3 权限确认（非 yolo 模式）

```
后端 onPermission → runner.askPermission（5 分钟超时自动 deny）
  → IPC task:permission → UI 横幅 → respondPermission → 选项回传后端
```

### 4.4 阶段接力与自动化

- **`<continue>` 接力**：领队/长任务在阶段边界输出 `<continue>` 简报 → `attachContinue` 在同一 Issue 上创建后继任务（`continuesFrom` 指向前任，新会话硬切，简报自包含）→ 触发来源记 `handoff`。目标模式循环天然跟随这条链。
- **自动化**：主进程 15s tick 扫 `automation-store`，到期即以 `autopilot` 触发创建任务（`output: 'run_only'` 时 `suppressIssue`，只留执行日志不建 Issue）。

### 4.5 重启恢复

- 悬挂的 running 任务加载时标为 failed 并提示重跑，不再永久"执行中"
- 委派任务重启后：领队任务标 failed（子任务结果已保留），可单看/重跑
- 目标模式：active → `waiting_user`，需显式 continue，绝不静默续跑
- worktree：`sweepWorktrees` 后台清扫上次会话遗留（不阻塞启动）

---

## 5. 可靠性设计

| 机制 | 防什么 |
|---|---|
| 流式看门狗（zcode 单回合 300KB / CLI 总量 5MB + 10 分钟空闲）+ onHeartbeat 续命 | 模型退化循环；长思考/后台子代理被误判超时 |
| 子进程 stderr 尾巴随错误抛出 | 真实失败原因被吞（曾导致 node:sqlite 排查困难） |
| store 原子写（tmp+rename）+ seq 从文件尾恢复 | 中断损坏与日志重复 |
| launchHandles 启动即注册 + per-session 进程树终止 | 一次性 CLI 在 session 返回前无法取消/杀错进程 |
| onSessionId 首次知晓即持久化 | 首轮 429 后无法续会话 |
| 集成"无合并不报成功" | 误报（实测绝对路径导致空合并仍报成功） |
| sanitizeChildPrompt | 领队指令带主仓库绝对路径，队员改错目录 |
| worktree 三处回收（集成后/删任务/启动清扫）+ removeWorktree 守卫（只动 `.agentdeck-worktrees/`，从 worktree 内解析主仓库根再移除） | 隔离副本无限累积；误删共享主目录工作区 |
| followUp 放行 done/failed/cancelled | 取消目标后 Issue 被卡死、无法继续手动推进 |
| goals:delete（非终态先停任务再级联删 runs/checkpoints）+ goals:deleted 广播 | 旧目标永久占据面板、无法重新开启目标模式 |
| 退出码/非零即失败 + 无输出判失败（opencode） | 静默假成功 |

---

## 6. 已知限制

- dsh 无流式过程与续聊（协议本身不提供），也不能当领队
- 领队自己动手的改动留在主工作区（不自动提交，设计使然）
- 委派最多 3 层、单领队循环最多 6 轮、全链最多 8 轮；不支持无上限递归派发
- 日志无虚拟滚动（单任务万级事件才需要）
- Windows 沙箱限制：codex 必须 bypass（workspace-write 下命令执行会失败）
- 未做多显示器/DPI 与国际化（界面中文）

---

## 7. 渲染层与领域边界

渲染入口保持 `TaskDetail` 兼容组件，但职责已拆到独立模块：

- `renderer/src/hooks/useTaskEvents.ts` 负责事件订阅、按 `seq` 归并、权限响应和回退刷新（`onEventsInvalidated` 触发全量重拉）。
- `renderer/src/hooks/turnModel.ts` 负责把 `TaskEvent[]` 转为回合模型；流式文本与重复 `final` 只保留一个最终消息。
- `renderer/src/hooks/useIssueDetails.ts` 负责 Issue、Run、Comment 查询与更新。
- `renderer/src/components/task/` 提供 `TurnTimeline`、`PermissionPrompt`、`RunHistory`、`CommentPanel` 和 `GitSummary`。
- `renderer/src/task-service.ts` 是任务操作到 Bridge command 的单一入口。
- `App.tsx` 侧栏路由：Issue（默认）/ 看板 / Agent / 收件箱 / 自动化 / 技能 / 用量 / 设置；Ctrl+K 命令面板可搜索任务、跳页与切主题。

领域边界为 `Issue -> Run -> Task`：Issue 是用户工作单元，Run 是一次面向 Issue 的执行投影，Task 是本地 CLI 兼容记录；`ExecutionRecord` 由 `shared/taskflow.ts` 提供唯一映射。任务状态转换（含看板拖动的 `validateMove`）、Issue/Run 状态派生均集中在 `shared/taskflow.ts`。

`tasks/tasks.json` 使用 `{ schemaVersion, tasks }` envelope。`migrateTaskIndex` 显式处理版本 0 数组和当前版本，旧字段迁移与坏记录过滤是幂等的，未来版本会拒绝加载。

## 7.1 目标模式 v2：Issue 内自动推进（Goal-based Loop）

目标模式 v2 不建立独立「目标」页或合成 Issue（`iss_goal_xxx`），而是**在真实 Issue 内开启**，按 Loop Engineering 的 Goal-based loop 理念自动推进（对照 `docs/LOOP-ENGINEERING.md` §3 模块映射：Goal-based loop → `goal-controller.ts` + `goal-store.ts`）。`Goal` 层作为持久化状态脊柱叠加在 `Issue -> Run -> Task` 之上，不替代该模型：

- **目标绑定真实 Issue**：`GoalCreateInput.issueId` 必填。开启即「收养」该 Issue 当前最新 Task 作为阶段任务：无 Task → 建首个（prompt 末尾注入目标模式块，startNow 即入队）；有 Task → 登记为当前阶段任务，startNow 时按其状态启动（queued/running 等执行、done/failed 走续聊回灌）。循环跟随 Issue 最新任务（天然含 `<continue>` 接力产生的 handoff 任务），不再只认自己建的任务。
- **自省自推直到完成条件达成**：每轮 Task 终态（含失败/取消）→ 解析 checkpoint envelope 落盘 `GoalCheckpoint`（runId 幂等，状态脊柱）→ 预算扣减与护栏决策 → 续轮**优先同会话续聊回灌**（`continueTask` = `runner.followUp`，不重开上下文）；后端未注入续聊或 Task 无 `sessionId` 时**兜底新建 Task**（prompt = 目标块 + checkpoint 简报）。
- **完成判定可验证**：checkpoint 的 `completedConditions` 由 agent 逐条对照完成条件原文填写（不靠 prose 撞子串）。全部达成的那一轮 → goal completed，经 `finalizeIssue` 把 Issue 自动归档 done；预算耗尽 → blocked、停止条件命中 → waiting_user、连续失败超限 → failed，均停下并写明原因。
- **委派单 maker/checker 审核流**：委派结果回灌后，领队（checker）须对每个 done 单输出 `<review of="#单号" verdict="pass|fail" note="…"/>` 结论——pass → 对应 Issue 看板状态置 done（自动归档）；fail → 置 blocked 并由领队下一轮改派或自行修复；未出结论的单保持 in_review（人工兜底）。写回复用 `issue-store` 的 `updateWorkflow`/`statusOverride`，审核得到的 done 不会被后续状态投影翻回。
- **预算与护栏**：运行/时长预算、停止条件保留 v1 语义；连续非重试失败由 `Goal.failures`（持久化）计数，`failures < 2` 自动续轮（回灌带失败上下文），≥2 → goal failed。重启恢复仍为 active → waiting_user，需显式 continue，绝不静默续跑。
- **可清除**：`GoalPanel` 标题栏「清除目标模式」任何状态可用——非终态目标连带取消在跑任务，随后 `GoalStore.delete` 级联删 runs/checkpoints、`goals:deleted` 广播摘除 🎯 徽标，面板回到可重新开启的空态。
- **持久化与接线**：`goal-store.ts` 写 `userData/goals/index.json`（与任务存储同样 tmp+rename）；`goal-controller.ts` 拥有生命周期、预算、checkpoint 与续轮决策，复用 TaskRunner 的创建/队列/取消/权限边界。主进程经 `ipc/goals.ts` 注册 `goals:*` handler，更新推送为 `goals:updated` / `goals:deleted`。
- **渲染层**：无整页目标视图；`components/goal/GoalPanel.tsx` 嵌入 TaskDetail 侧栏（开启对话框、状态 chip、轮数预算、checkpoint 历史、暂停/继续/取消/清除）；BoardView 给非终态目标的 Issue 卡片加 🎯 徽标。

## 8. 测试与验证基线

高频回归入口：

| 命令 | 覆盖 |
|---|---|
| `npm run smoke` | runner 状态机：完成/续聊/取消/失败/超时/迟到 session 隔离 |
| `npm run smoke:goal` | 目标模式：Issue 收养、checkpoint envelope 完成判定与 Issue 自动归档、预算/停止条件/连续失败护栏、重启恢复、无续聊新任务兜底、remove 清除 |
| `npm run smoke:skills` | 共享目录技能库：CRUD/导入/安装同步/逃逸校验 |
| `npm run smoke:delegate` | 委派循环（假后端）：多轮派发/剥离/集成/worktree 回收/取消 + 单号报告与 `<review>` 审核 |
| `npm run smoke:stage7` | typecheck + stage6（taskflow/turn-model/migration/issues）+ smoke + goal 串行 |
| `npm run smoke:all` | 全量矩阵：上述全部 + 事件日志/权限/执行服务/IPC 校验/CLI 错误/git 错误/迁移/失败分类/diff/重试/flow/resume/自动化/用量分析/model/continue/round 等 25 个纯本地套件串行 |

专项套件（均 `npm run smoke:<name>`）：`event-log` `permission` `execution-services` `ipc-validation` `final-dedup` `zcode`（真实回合）`clis`（claude/codex/opencode 真实回合）`cli-errors` `git-errors` `migration` `failure` `diff` `retry` `flow`（交接备注/parked/手动启动）`resume` `issues` `automation` `runtime-analytics` `taskflow` `model` `continue` `round`（幻影吞单/round 标记/continue 简报）`turn-model`。

真实 e2e：`npm run e2e:delegate`（GLM 领队自发派 Claude/OpenCode + 集成分支）。

打包：`npm run dist`（NSIS）；开发：`npm run dev`；类型：`npm run typecheck`。
