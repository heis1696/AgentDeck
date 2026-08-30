# AgentDeck 架构文档

> 封板版本 v0.3.0（demo）。本地多 agent 协作台：五个 agent CLI 平台（zcode/claude/codex/opencode/dsh）同队，委派内置、领队自主拆解派工，全程本地运行。

---

## 1. 总览

```
┌─────────────────────────────────────────────────────────────┐
│ Electron 主进程（Node）                                       │
│                                                             │
│  index.ts ── IPC（tasks / agents / settings / dialog / shell）│
│      │                                                      │
│  TaskRunner ──双通道队列──► backends（5 个 AgentBackend 适配器）│
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
│  App → 侧栏导航 → WorkspaceView（快速输入）/ TaskList /        │
│         TaskDetail（日志/结果/Git/子任务/权限横幅）/           │
│         TeamView（队伍编辑）/ SettingsView                    │
└─────────────────────────────────────────────────────────────┘
```

无云端、无服务进程、无数据库——全部状态在 `userData/` 的 JSON/JSONL 文件里。

---

## 2. 核心概念

### 2.1 Agent（队员）

`{ id, name, backend, role?, systemPrompt?, subordinates?, color }`

- **身份**：定位 + 系统提示词，注入该队员的每个任务（`buildAgentPrompt`）
- **能力**：`subordinates` 非空即领队——任务提示自动附加委派协议，对话中可派工
- 同一平台可建多个队员（如"Claude 审查员"），身份互不相同
- 预置五名：ZetCode（领队，GLM）、Claude、Codex、OpenCode、DeepSeek

### 2.2 Task（任务）与委派

子任务通过 `parentTaskId` 挂在领队下（侧栏缩进展示）；领队集成结果记 `Task.integration {branch, note}`（0.4.0 删除了旧 squad 双轨，存量自动迁移）。
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
│   ├── index.ts              窗口、IPC 注册、backend/agent 装配、启动恢复
│   ├── runner.ts             任务状态机、双通道队列、取消级联、权限网关
│   ├── delegate.ts           委派协议：解析/身份注入/循环/worktree 派发/集成
│   ├── store.ts              任务与事件的文件存储（seq 单调分配）
│   ├── agents.ts             队伍持久化 + 预置 + 迁移补员
│   ├── settings.ts           设置持久化
│   ├── git.ts                isGitRepo/snapshot/commitAll/createWorktree/
│   │                         mergeBranchInto/branchDiffSummary
│   └── backends/
│       ├── types.ts          AgentBackend / BackendSession / PermissionRequest
│       ├── zcode.ts          ZCode 协议（常驻型，resume+runtimeModel，300KB 看门狗）
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
│   └── components/           WorkspaceView/TaskList/TaskDetail/TeamView/
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
- 委派深度一层（子任务不能再委派）
- 日志无虚拟滚动（单任务万级事件才需要）
- Windows 沙箱限制：codex 必须 bypass（workspace-write 下命令执行会失败）
- 未做多显示器/DPI 与国际化（界面中文）

---

## 7. 测试与验证基线

| 套件 | 命令 | 覆盖 |
|---|---|---|
| runner 状态机 | `npm run smoke` | 12 项断言（完成/续聊/取消/失败/删除） |
| zcode 适配器 | `npm run smoke:zcode` | 真实回合端到端 |
| 三个 CLI 适配器 | `npm run smoke:clis` | claude/codex/opencode 真实回合 |
| 数据迁移 | `npm run smoke:migration` | 0.3.x→0.4 schema（mode/squad→integration、悬挂 running 清扫） |
| 失败分类 | `npm run smoke:failure` | 11 类规则 + runner 落库 |
| 自动重试 | `npm run smoke:retry` | 瞬态重试/非瞬态不重试/上限打满 |
| diff 解析 | `npm run smoke:diff` | DiffView 解析器边界 |
| 委派循环 | `npm run smoke:delegate` | 假后端：多轮派发/剥离/集成/取消语义 |
| 真实委派 e2e | `npm run e2e:delegate` | GLM 领队自发派 Claude/OpenCode + 集成分支 |
| 真实异构 e2e | `npm run e2e:delegate` | zcode 领队 + claude/opencode 队员（领队自主决策） |

打包：`npm run dist`（NSIS）；开发：`npm run dev`；类型：`npm run typecheck`。
