# cc-haha 拆解报告：Claude Code 开源桌面工作区

> 拆解对象：NanmiCoder/cc-haha（14k 星，克隆于 D:\agentdeck\teardown\repos\cc-haha）
> 拆解方法：主干源码通读（重点读 server 层 / Agent 内核 / worktree / 持久化 / Electron 壳 / IM 网关），辅以官方 internals 文档（docs/en/internals/*.md）交叉验证
> 源码规模：4468 文件（排除 node_modules）；根 package.json 名为 `claude-code-local`（package.json:2），Bun 1.3.14 + TypeScript，MIT
> 定位备注：cc-haha 不是"调 Claude CLI 的壳"，而是**自带一整套 Claude Code CLI 重实现**（`src/`，Ink TUI + Agent 内核 + 工具集）+ 本地 Server（Bun.serve）+ Electron 桌面壳 + 8 个 IM 适配器的完整栈。部分 ant-internal feature-gated 模块以 `@generated stub` 占位（如 `src/server/sessionManager.ts:1`、`src/proactive/index.ts:1`），说明其上游是 Claude Code 内部代码的反编译/重建产物。

---

## 1. 一句话定位与总体架构

**一句话**：把 Claude Code 从终端搬进桌面——用"本地 Server（Bun sidecar）+ 每会话一个 CLI 子进程 + Electron 壳 + IM 网关"四类进程，构成一个本地优先的多 Agent 编排工作区；同一份 `~/.claude/` 文件系统是 CLI 与桌面 UI 的共同真相源。

### 1.1 目录树与模块职责

```text
cc-haha/
├── bin/claude-haha                  # CLI 启动器（bin/claude-haha:1，spawn src/entrypoints/cli.tsx）
├── preload.ts                       # Bun preload（CALLER_DIR chdir、构建兼容）
├── src/                             # Claude Code CLI 完整重实现（Agent 内核）
│   ├── entrypoints/cli.tsx          # CLI 主入口（TUI）
│   ├── query.ts / QueryEngine.ts    # Agent 主循环（query():222 / queryLoop():244）
│   ├── tools/                       # 60+ 工具：AgentTool、Team*、Task*、Worktree、Bash…
│   ├── tasks/                       # 后台任务类型：LocalAgentTask、InProcessTeammateTask、LocalShellTask…
│   ├── goals/goalState.ts           # /goal（Stop hook 裁判实现）
│   ├── state/AppState.tsx           # 全局可变状态（tasks/todos/teamContext…）
│   ├── utils/sessionStorage.ts      # 会话 JSONL 读写（5179 行，持久化脊柱）
│   ├── utils/worktree.ts            # worktree 全套（创建/复用/清理/GC）
│   ├── utils/swarm/                 # Agent Teams（mailbox、spawn、backends）
│   └── server/                      # 本地 Server（Bun.serve，桌面/H5/IM 共用）
│       ├── index.ts                 # startServer():205，HTTP+WS+H5+鉴权
│       ├── services/sessionService.ts       # 会话文件读写（4682 行）
│       ├── services/conversationService.ts  # 每会话 CLI 子进程生命周期（2494 行）
│       ├── services/cronScheduler.ts        # 定时任务调度（1141 行）
│       ├── services/sessionRewindService.ts # 会话回滚（checkpoint 恢复）
│       ├── services/localIndex/             # bun:sqlite 会话投影索引
│       └── ws/handler.ts             # /ws/:id 与 /sdk/:id 两条 WS 通道（4671 行）
├── desktop/                         # Electron 应用
│   ├── electron/main.ts             # Electron 主进程（867 行）
│   ├── electron/services/           # sidecarManager、terminal、preview、updater…
│   ├── electron/ipc/                # IPC 通道白名单 + payload 校验
│   ├── sidecars/claude-sidecar.ts   # server/cli/adapters 三合一 sidecar 入口
│   └── src/                         # React 渲染进程（api/、stores/、components/）
├── adapters/                        # IM 消息网关（每个平台一个 sidecar）
│   ├── common/                      # ChatPort 抽象 + WsBridge + 会话路由 + 权限同步
│   └── feishu/ telegram/ wechat/ dingtalk/ whatsapp/ wecom/ qq/ slack/
├── native/                          # Swift/macOS 助手
├── runtime/                         # Python Computer Use 助手（win/mac helper）
├── scripts/                         # 质量门禁、PR 检查、发布
├── site/ + docs/                    # 文档站与中英文档
└── src-tauri/                       # 历史遗留：现在只放打包资源，Electron 才是宿主
```

### 1.2 三层分工（desktop 壳 / runtime / adapters）

| 层 | 载体 | 职责 | 关键约束 |
|---|---|---|---|
| **desktop 壳** | `desktop/electron/main.ts` | 窗口/托盘/更新/PTY 终端/原生预览/宠物窗/侧边栏生命周期 | 只管原生能力，不碰业务；渲染层经 `window.desktopHost` 访问原生（desktop/electron/preload.ts） |
| **runtime（本地 Server）** | `desktop/sidecars/claude-sidecar.ts` → `src/server/index.ts` | REST + 两条 WebSocket + provider 代理 + 会话/任务/团队/技能/MCP 管理；按需为每个会话 spawn CLI 子进程 | 单个 Bun.serve 承载 `/api/*`、`/ws/:sessionId`（桌面/H5/宠物）、`/sdk/:sessionId`（CLI 内部）、`/proxy/*`、H5 静态资源（src/server/index.ts:244-399） |
| **adapters** | `adapters/<platform>/`（每平台独立 sidecar 进程） | 把 IM 消息桥接进同一套 server 会话 | 一个平台凭据故障不拖垮其他平台（desktop/sidecars/claude-sidecar.ts:141-208） |

**与 Electron 主/渲染进程的对应关系**（这是 cc-haha 最有意思的结构决策）：

- Electron **主进程**只做"窗口 + 原生服务 + sidecar 生命周期"，真正的业务大脑（会话编排、Agent 执行）**不在主进程，而在 Bun sidecar server**——`desktop/electron/main.ts:791` 在 `whenReady` 后调用 `getServerRuntime().startServer()` 拉起 `claude-sidecar server`，健康检查通过后渲染进程拿到 loopback URL 自行连 HTTP/WS。
- Electron **渲染进程**是纯 React UI（Zustand stores：`desktop/src/stores/sessionStore.ts`、`chatStore.ts`、`agentStore.ts` 等），通过 `desktop/src/api/websocket.ts` 直连 `ws://127.0.0.1:<port>/ws/<sessionId>`，**不经过 Electron IPC 传业务数据**。IPC 只留给原生能力且逐通道做 payload 校验（desktop/electron/ipc/capabilities.ts:57-110，含 key 白名单 `hasOnlyKeys`、长度/字符集校验）。
- **Agent 执行在第三类进程**：server 为每个会话 `Bun.spawn` 一个 CLI 子进程（src/server/services/conversationService.ts:441），CLI 再通过内部 SDK WebSocket 连回 server。也就是说桌面端断开、Electron 退出，都不直接影响正在跑的 Agent turn。

### 1.3 运行时边界表（官方 structure.md + 代码核实）

| 入口 | 运行时 | 职责 |
|---|---|---|
| `src/entrypoints/cli.tsx` | Bun | CLI/TUI、Agent 工具循环 |
| `src/server/index.ts` | Bun（Bun.serve） | 本地 HTTP/WS/H5 |
| `desktop/electron/main.ts` | Electron 主进程 | 原生桌面宿主 |
| `desktop/src/` | Chromium 渲染进程 | React UI |
| `desktop/sidecars/claude-sidecar.ts` | bun-compile 单二进制 | server/cli/adapters 三模式复用一份 55MB runtime（文件头注释 desktop/sidecars/claude-sidecar.ts:2-7 明说这是为省体积合并的） |

---

## 2. 多 Agent 管理与编排

### 2.1 三层并发模型

cc-haha 的"多 Agent"分三层，各层进程/隔离模型完全不同：

| 层 | 单元 | 运行位置 | 隔离方式 | 代表代码 |
|---|---|---|---|---|
| 桌面会话层 | session（UUID） | 每会话一个 CLI 子进程 | OS 进程 + 独立 JSONL + 可选 worktree | conversationService.ts:334 `startSession` |
| 会话内 subagent | agentId | **同一 CLI 进程内**（AsyncGenerator 嵌套） | 独立 ToolUseContext/abortController/readFileState | runAgent.ts:292 `runAgent` |
| Agent Teams 队友 | name@team | in-process（AsyncLocalStorage）或 tmux/iTerm2 pane | 身份隔离 + 文件邮箱 | InProcessTeammateTask.tsx:1-10、teammateMailbox.ts |

**subagent 是进程内递归，不是子进程**。核心是 `runAgent`（src/tools/AgentTool/runAgent.ts:292-997）：它接收父会话的 `toolUseContext`，用 `createSubagentContext`（runAgent.ts:795）克隆出子上下文后直接再次调用主循环 `query()`（runAgent.ts:858），把 Claude Code 的 agent loop 当成可递归复用的原语。同步子 agent 与父共享 abortController，异步（`run_in_background`）子 agent 拿独立 unlinked controller（runAgent.ts:613-617）——注释明确"背景 agent 应在用户 ESC 取消主线程时存活，由 chat:killAgents 显式杀"（AgentTool.tsx:713-715）。

```ts
// src/tools/AgentTool/runAgent.ts:613-617（同步/异步的隔离语义）
const agentAbortController = override?.abortController
  ? override.abortController
  : isAsync
    ? new AbortController()
    : toolUseContext.abortController
```

### 2.2 六种内置 agent + 前言定义文件

内置 Explore/Plan/verification/general-purpose 等（src/tools/AgentTool/builtInAgents.ts），自定义 agent 用 markdown frontmatter（`~/.claude/agents/*.md` 与 `<project>/.claude/agents/*.md`，加载器 src/tools/AgentTool/loadAgentsDir.ts，801 行），桌面端 Agent 管理器**直接写同一份 md 文件**而非数据库（官方 agent.md:346-353），并支持保存后热重载当前会话。

值得注意的**成本工程**（runAgent.ts:460-490）：

```ts
// src/tools/AgentTool/runAgent.ts:465-478 —— 只读 agent 裁剪上下文
// Explore/Plan 不吃 CLAUDE.md（省 ~5-15 Gtok/周），再丢弃父会话启动时的
// gitStatus（最多 40KB，标注为 stale，省 ~1-3 Gtok/周）
const shouldOmitClaudeMd =
  agentDefinition.omitClaudeMd && !override?.userContext &&
  getFeatureValue_CACHED_MAY_BE_STALE('tengu_slim_subagent_claudemd', true)
const { claudeMd: _omittedClaudeMd, ...userContextNoClaudeMd } = baseUserContext
```

### 2.3 Worktree 隔离：完整工程化实现（本项目最扎实的一块）

入口在 AgentTool：`isolation: "worktree"` 时以 `agent-{agentId前8位}` 为 slug 创建（AgentTool.tsx:598-603），执行期间用 `runWithCwdOverride` 把整个 agent 的 cwd 覆盖到 worktree（AgentTool.tsx:650-653）。核心实现 `src/utils/worktree.ts`（1735 行）：

**创建**（worktree.ts:366-477 `getOrCreateWorktree`）：
- worktree 统一落在**主仓库**的 `.claude/worktrees/` 下（`findCanonicalGitRoot` 保证即使从 session worktree 里 spawn 也不嵌套，worktree.ts:1118-1122 注释）；
- **快速复用路径**：直接读 `.git` 指针文件拿 HEAD SHA，跳过 fetch/子进程（worktree.ts:376-388，注释算了 15ms spawn 开销的账）；
- 用 `git worktree add -B <branch> <path> <resolvedSha>` 而非 `-b`，且**用 SHA 起点而非 origin/<branch>**——避免 git 把 remote 配置写进共享 `.git/config` 造成多 worktree 并发竞争（worktree.ts:463-467 注释）；
- 支持 sparse-checkout（`--no-checkout` + `sparse-checkout set --cone`），失败时主动拆除半成品防止下次 fast-resume 把空 worktree 当有效（worktree.ts:479-495）。

**降级而非失败**（worktree.ts:1057-1096）：

```ts
// src/utils/worktree.ts:1062-1070 —— 隔离是优化，不是前提
// 非 git 工作区且无 WorktreeCreate hook → 返回原因，调用方退化到共享 cwd
export function agentWorktreeUnavailableReason(): string | null {
  if (hasWorktreeCreateHook()) return null
  if (findCanonicalGitRoot(getCwd())) return null
  return AGENT_WORKTREE_UNAVAILABLE_REASON
}
```

同时支持 `WorktreeCreate/WorktreeRemove` hooks 让非 git VCS 也能提供隔离（worktree.ts:1104-1115）。

**回收**（AgentTool.tsx:656-704 + worktree.ts:1157-1223）：agent 结束后 `hasWorktreeChanges` 检查——无变更则 `git worktree remove --force` + 删临时分支，并**回写 agent metadata 清掉 worktreePath**（防止 resume 指向已删目录）；有变更则保留并把路径/分支写进结果。

**GC**（worktree.ts:1233-1261 `cleanupStaleAgentWorktrees`）：按**精确 slug 正则**（`^agent-a[0-9a-f]{7}$`、`^wf_…`、`^bridge-…`、`^job-…`）只清临时 worktree，绝不碰用户命名的；fail-closed——`git status` 失败或有未推送提交则跳过；30 天阈值；fast-resume 会 bump mtime 防误清（worktree.ts:1139-1144）。

**会话级 worktree**（区别于 agent 级）：桌面端新建会话可选 branch + worktree，元数据存进 session-meta（sessionService.ts:3920-3929 `repository` 字段），CLI 启动参数带 `--worktree <slug> --worktree-base-ref <ref>`（conversationService.ts:303-311）。

### 2.4 Agent Teams：文件系统当协作总线

TeamCreate（src/tools/TeamCreateTool/TeamCreateTool.ts:117-255）建立：
- `~/.claude/teams/{team_name}/config.json`（TeamFile：成员、leadSessionId、每人 color/cwd）；
- `~/.claude/tasks/{team_name}/` 共享任务目录——**Team = Project = TaskList**（TeamCreateTool.ts:194-197 注释）；
- 跨进程**名字预留做成一个事务**：`withTaskListLifecycleLock` + `beginTaskListLifecycle` 代次（generation）失效旧写者（TeamCreateTool.ts:148-199，注释点名"两个 leader 同名互相覆盖"的竞态）。

队友间通信是**文件邮箱 + lockfile**：每个成员 `~/.claude/teams/{team}/inboxes/{name}.json`，写方用 proper-lockfile 带重试加锁（src/utils/teammateMailbox.ts:80-96、38-44），收方把新消息作为 attachment 注入对话。关闭协作走 shutdown_request/shutdown_response 两阶段握手，全部成员退出后 TeamDelete 清理（官方 agent.md:310-328）。桌面端 Agent Teams 工作台（`desktop/src/components/agentTeams/AgentTeamsCanvas.tsx` 等）则通过 server 的 teamWatcher（src/server/services/teamWatcher.ts，561 行）watch 这些文件渲染画布/通信流。

### 2.5 后台任务框架

统一 Task 接口（src/Task.ts）+ 每类任务一个实现（src/tasks/*）：LocalAgentTask（后台 subagent）、InProcessTeammateTask、LocalShellTask、LocalWorkflowTask、MonitorMcpTask、RemoteAgentTask…。后台 agent 的**进度追踪**很细（src/tasks/LocalAgentTask/LocalAgentTask.tsx:42-58）：输入 token 取最新值（API 的 input_tokens 是累计的）、输出 token 逐轮累加，recentActivities 环形缓冲 5 条，配 `getActivityDescription()` 预计算人类可读活动描述（LocalAgentTask.tsx:111-116）——这是桌面"活动面板"和 stuck 检测的数据基础。

---

## 3. 一次 run 的完整链路

以桌面端发送一条消息为例（含文件路径引用），完整时序：

```text
[渲染进程] 用户输入
 → desktop/src/api/websocket.ts: ws.send({type:'user_message', content, attachments})
 → [server] src/server/ws/handler.ts:621 case 'user_message'
    → handler.ts:760 handleUserMessage()
       1. :786  beginSessionChatActivity() 登记本轮活动状态机
       2. :798  waitForRuntimeTransitionBeforeUserTurn() 等 CLI 运行时切换完成
       3. :812-844 会话标题状态机（首条消息占位标题/触发生成）
       4. :848  ensureCliSessionStarted() —— 惰性拉起 CLI：
          → src/server/services/conversationService.ts:334 startSession()
             a. sessionService.getSessionLaunchInfo() 判断 resume/占位替换/worktree
             b. :295 buildSessionCliArgs() 组装参数（见下）
             c. :430 buildChildEnv() 注入 provider/代理/OAuth env
             d. :441 Bun.spawn(args, {cwd: workDir, stdin/stdout: 'pipe'})
             e. :505-513 启动宽限竞赛（proc.exited vs sdkAttached vs 3s 超时）
             f. :522-527 CLI 早退且是陈旧锁 → 清锁自动重试一次
       5. :899 bindAllClientSessionOutputs() 绑定输出转发（静默到 replay 确认）
       6. :918 refreshDisconnectedTurnCleanupWatcher()（渲染层可能在 CLI 启动期间已离开）
       7. :921 conversationService.sendMessage(sessionId, content, attachments)
 → [CLI 子进程] 逆连接：ws://…/sdk/<sessionId>?token=<sdkToken>
    → server index.ts:392 /sdk/ 升级 → handler.ts:539 channel==='sdk'
    → conversationService.ts:981 attachSdkConnection() 挂载 + 冲刷 pendingOutbound
    → conversationService.ts:603 sendMessage 把用户轮写入 SDK socket（NDJSON）
 → [CLI] src/entrypoints/cli.tsx 解析 → src/query.ts:222 query() 主循环
    （LLM 调用 → 工具执行 → permission can_use_tool …，子 agent 经 runAgent 递归）
 → [CLI → server] SDK socket 逐行推 stream-json 消息
    → conversationService.ts:1039 handleSdkPayload()
       · :1021 isReplayedSdkMessage() 按 UUID 去重（CLI 重连会整段重放，注释详述睡眠唤醒场景）
       · :1094 control_request/can_use_tool → pendingPermissionRequests 登记
    → outputCallbacks → handler.ts 转译为 ServerMessage（content_delta/tool_result/…）
 → [渲染进程] ws 收 events.ts 定义的消息流渲染；权限弹 PermissionDialog
 → 权限决定：ws {type:'permission_response', requestId, allowed, rule?}
    → handler.ts:657 → conversationService.respondToPermission() → SDK socket
 → [CLI] turn 结束：自己把消息 append 进 ~/.claude/projects/<dir>/<sessionId>.jsonl
    （server 不代写主 transcript，读写同一份文件保证 CLI/UI 互通，sessionService.ts:1-6）
```

**CLI 启动参数**（conversationService.ts:313-331，值得整段看）：

```ts
// src/server/services/conversationService.ts:313-331
return this.resolveCliArgs([
  '--print', '--verbose',
  '--sdk-url', sdkUrl,              // 内部逆连接通道
  '--enable-auth-status',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--include-partial-messages',     // 桌面端流式渲染依赖
  ...(shouldResume ? ['--resume', sessionId] : ['--session-id', sessionId]),
  ...worktreeArgs,                  // --worktree <slug> --worktree-base-ref <ref>
  '--replay-user-messages',         // 本轮回放的 user 消息带 uuid，供 handler 对齐
  ...this.getRuntimeArgs(options),
  ...this.getPermissionArgs(options?.permissionMode, dangerousMode),
])
```

链路中三处防御性设计值得点名：
1. **CALLER_DIR/PWD 覆盖**（conversationService.ts:418-426）：sidecar 从 cwd=/ 启动时 preload 会 chdir 回 '/'，必须显式覆盖 env，否则 IM 会话里 AI 感知的工作目录变成根目录（Bug#5，注释写得很清楚）。
2. **回放对齐**：server 给每轮 user_message 预生成 `expectedReplayUuid`（handler.ts:792），CLI `--replay-user-messages` 回放时用 uuid 匹配（handler.ts:972-977），"停止后替换输入"的 fence 语义靠它实现。
3. **断线不清任务**（handler.ts:709-749）：最后一个客户端断开时，若还有活跃 turn/后台任务，只挂 completion watcher 等 work 结束再进入空闲宽限期；宽限期内重连即取消清理——这是"锁屏/刷新不打断任务"的机制根源（issue #764 驱动的重构）。

**cron 触发的 run** 是另一条入口（对应 agentdeck scheduler）：`src/server/services/cronScheduler.ts:532` start() 起 60s interval，`tick()`（:565）做**双层分钟键去重**——内存 Map（:579）+ 文件持久化 `lastFiredAt`（:583-585，跨进程）；命中后立即 `updateLastFired`（:669）再 spawn。每次 run 是**全新 CLI 子进程**，prompt 经 stdin NDJSON 写入（:674-710），带超时 kill；手动"Run Now"才建可见 session（:641-655 注释：避免刷侧栏），自动跑默认 `bypassPermissions`（:646）。

---

## 4. 状态持久化

### 4.1 存储地图（"不同数据不共享一个库"，官方 desktop.md:182-192）

| 数据 | 位置 | 写方 |
|---|---|---|
| 主会话 transcript | `~/.claude/projects/{sanitized_path}/{sessionId}.jsonl`（sessionService.ts:4-5） | **CLI 子进程自己 append**；server 只读/管理（列表/重命名/裁剪） |
| 会话元数据 | JSONL 首部两条：`file-history-snapshot` + `session-meta`（workDir/repository/permissionMode，sessionService.ts:3908-3931） | server createSession 写，CLI resume 读 |
| subagent 副链 | `{projectDir}/{sessionId}/subagents/agent-{agentId}.jsonl` + `.meta.json` sidecar（sessionStorage.ts:248-263） | runAgent 逐消息 record（runAgent.ts:834、916，fire-and-forget 不阻塞） |
| agent 元数据 | 同目录 `agent-{id}.meta.json`：agentType/model/worktreePath/description/toolUseId/ownerAgentId/workflow（sessionStorage.ts:265-301） | 启动前先写（runAgent.ts:841-852），worktree 回收时**重写清空 worktreePath**（AgentTool.tsx:685-695） |
| workflow 分组 | `subagents/workflows/<runId>/`（sessionStorage.ts:232-242 subdir map） | WorkflowTool |
| Team | `~/.claude/teams/{team}/config.json` + `inboxes/*.json`；任务 `~/.claude/tasks/{team}/` | 各 agent 进程，lockfile 串行化 |
| 定时任务与运行史 | cronService 任务文件 + runs 日志文件（cronScheduler.ts:236-415 appendRun/updateRun） | server |
| 会话投影索引 | `~/.claude/cc-haha/…index-v1.sqlite`（localIndex/database.ts:2,116，bun:sqlite） | server 后台 projector + reconciliationWatcher + 损坏恢复备份（recovery.ts） |
| 桌面 UI 偏好/标签 | localStorage（带迁移）；Electron 窗口状态 | 渲染进程/Electron |

设计核心是**"CLI 拥有 transcript，server 拥有会话管理，二者共享同一文件系统"**——桌面 UI 的会话列表/搜索（localIndex）是对 JSONL 的**可重建投影**（startup 按 优先级排序建索引：先 session 列表索引等 30s 上限，再内容搜索，src/server/index.ts:97-121），并有 shadow 对比校验（cronScheduler.ts:318-339、sessionService 的 SessionListShadowComparison:108）。

### 4.2 崩溃恢复

1. **会话级**：CLI 子进程崩溃 → server `handleProcessExit` 记诊断、清 sessions Map；重连时 `startSession` 检测 transcript 有消息则改用 `--resume <sessionId>`（conversationService.ts:348-349）续跑。CLI 侧还有独立恢复入口 `CLAUDE_CODE_FORCE_RECOVERY_CLI=1` → `src/localRecoveryCli.ts`（bin/claude-haha:14-16）。
2. **turn 级断点**：`file-history-snapshot`（trackedFileBackups）每轮落盘，`sessionRewindService.ts:2043 executeSessionRewind` 提供"回滚到某条 user 消息"：先 `stopSessionAndWait` 排干运行时（:2053），构建 checkpoint 恢复计划 `applyRestorePlan`（:2116），再裁剪 transcript `trimSessionMessagesFrom`（:2121）；**裁剪失败则回滚文件恢复**（:2125-2137 rollbackRestorePlan），保证"要么全成要么不动"。
3. **subagent 级**：`.meta.json` sidecar 记录 agentType/worktreePath/toolUseId，resume 时把 agent 重新挂回**原始 Agent 卡片**而非当前工具调用（sessionStorage.ts:279-283 注释）；`subagentRunService.ts:16` 的 `SubagentRunResponse` 说明重建 Activity 面板用三来源兜底：subagent-jsonl / session-history / live-task。
4. **索引级**：sqlite 损坏 → 备份家族 + 分类恢复（localIndex/recovery.ts），projection 永远可从 JSONL 重建。
5. **进程级**：cron `cleanupStaleRuns()`（cronScheduler.ts:987）清掉上次崩溃留下的 "running" 僵尸记录；worktree 30 天 GC 清理被 Ctrl+C 泄漏的临时检出（worktree.ts:1233-1244 注释直说泄漏来源）。

---

## 5. 聊天应用集成（IM 消息网关）

8 个平台（feishu/telegram/wechat/dingtalk/whatsapp/wecom/qq/slack），**每平台独立 sidecar 进程**，共享 `adapters/common/` 的网关层：

### 5.1 ChatPort 抽象——"平台只管怎么说，runtime 管整个回路"

`adapters/common/chat-runtime.ts:1-17` 的头注释就是设计宣言：五个平台各自复制同一循环且各自回归过，所以抽出统一 runtime；平台只需实现 `ChatPort`：

```ts
// adapters/common/chat-runtime.ts:67-83
export interface ChatPort {
  platform: ImPlatform
  logPrefix: string
  sendNotice(chatId: string, text: string): Promise<void>   // 命令输出/权限提示/错误
  createResponse(chatId: string): ResponseStream             // 一轮助手回复的呈现
  sendImage?(chatId: string, image: OutboundImage): Promise<void>
  setBusy?(chatId: string, busy: boolean): void
  clearChat?(chatId: string): void
}
// ResponseStream = { append(delta), finish() } —— runtime 负责攒批，平台只收增量
```

`ImChatRuntime`（chat-runtime.ts:135）持有全部状态机：`runtimeStates`（idle/thinking/streaming/tool_executing/permission_pending）、`buffers`（流式攒批，平台可调 flush 窗口：编辑式平台短窗、发离散消息的平台长窗，:116-121）、`pendingPermissions`、`sessionSelection`（/projects /new 会话路由）。

### 5.2 WsBridge——chatId → sessionId 的多路复用

`adapters/common/ws-bridge.ts:43`：一个 bridge 管多个 chat 的 WebSocket（每 chat 连 `ws://server/ws/<sessionId>`，带 localAccess token），30s 心跳、指数退避重连（1s 起、30s 封顶、10 次上限，:38-41）。精髓是**按 chat 串行化 handler 链**（ws-bridge.ts:207-226）：每条消息的异步 handler（可能 await IM API 发消息）链在上一条之后，防止后一条读到前一条未完成的 map 状态；且投递时**复查 session 所有权**，reset 后旧 socket 的在途 promise 不会污染新会话。

### 5.3 权限同步：多客户端仲裁

`adapters/common/permission-sync.ts:9 syncImPermissionState`：IM 端收到 `permission_resolved`（别人批了/离线时批了）或 `permission_requests_snapshot`（重连快照）时对账本地 pending 集合——快照"显式数组才权威"（:29-30 注释），避免旧版部分快照把重放的请求清掉。IM 侧审批用文本命令（parsePermissionCommand），支持 `always` 规则持久化（ws-bridge.ts:91-97）。

### 5.4 入站防线

`InboundChatMessage`（chat-runtime.ts:86-105）：去重键 `dedupKey`（MessageDedup，IM 平台重投是常态）；**附件懒下载**——`loadAttachments` 只在通过 dedup + pairing 门之后、且在 per-chat 队列内执行（:96-102 注释：否则陌生人能让适配器下载字节并写 `~/.claude/im-downloads/`）。每 chat 串行队列 `enqueue`（chat-queue.ts）防乱序。配对（pairing.ts）+ 会话绑定持久恢复（session-recovery.ts）。

---

## 6. 与 agentdeck 的对照与可借鉴点（最重要章节）

> agentdeck 模块对照基线：`backends/*`（CLI 协议适配）、`runner.ts`、`delegate.ts`、`goal-controller.ts`+`goal-store.ts`、`scheduler.ts`、`retry-policy.ts`+`task-finalizer.ts`、`issue-store.ts`+`event-log.ts`、`permission-broker.ts`（见 LOOP-ENGINEERING.md:75-86 的映射表）。

### 6.1 可直接借鉴的设计（按价值排序）

**A. 把业务编排移出 Electron 主进程，放进可独立存活的本地 server（对应 agentdeck 全局架构）**
cc-haha 的进程拓扑 = Electron 壳（原生能力）+ Bun server（业务大脑）+ 每 session 一个 CLI 子进程。收益已经在代码里兑现：渲染层刷新/锁屏/断网不杀任务（ws/handler.ts:709-749 的宽限期+完成 watcher 机制）、H5/IM/宠物窗复用同一 server 只是不同 token 与能力面（index.ts:244-399）、CLI 崩溃粒度隔离。agentdeck 若现在把 runner/goal-controller 等放在主进程，值得评估"sidecar server 化"：**最小改法**是把 `runner.ts`+`issue-store.ts`+`event-log.ts` 抽到一个独立 Node/Bun 进程，Electron 主进程退化为 sidecarManager（cc-haha 的 desktop/electron/services/sidecarManager.ts 是现成参考：粘性端口 desktop-server-state.json:38、浏览器安全端口过滤:153-158、首选端口列表回退:176-193）。

**B. "断开不等于停止"的会话生命周期（对应 runner.ts / 任务存活语义）**
cc-haha 把"客户端连接"与"工作存活"彻底解耦：活跃 turn/后台任务结束后才起空闲宽限计时器；等待权限的会话有独立的有限清理策略（handler.ts:735-748）。agentdeck 的多 Agent 会话应补这套语义——尤其"渲染进程崩溃恢复后 `sync_state` 拉权威状态 + 离线消息排队冲刷后补 sync"（desktop/src/api/websocket.ts:76-80 注释明确 sync_state 要排在排队消息之后）。

**C. worktree 工程化细节（对应 agentdeck 的 worktree/隔离层，如果还没有的话）**
直接可抄的四个点（src/utils/worktree.ts）：① SHA 起点 + `-B` 避免共享 `.git/config` 写竞争（:463-467）；② 无变更自动回收 + 回写 metadata 清路径（AgentTool.tsx:656-704）；③ 精确 slug 正则 + fail-closed 的 30 天 GC（:1233-1261）；④ 隔离降级而非失败——非 git 工作区返回 unavailableReason 继续跑（:1066-1096）。第 ④ 点对 agentdeck 的 `delegate.ts` 尤其重要：委派子 Agent 时隔离失败不应炸掉整个任务，把"隔离没发生"的信息带回结果即可。

**D. subagent 副链 transcript + metadata sidecar（对应 delegate.ts 的 round notes + event-log.ts）**
cc-haha 每个子 agent 一份独立 JSONL（父链不断）+ 启动前先写 `.meta.json`（ownerAgentId/toolUseId/workflow 归属）。agentdeck 的 round notes 若目前挂在主事件流里，可借鉴"子 Agent 独立文件 + sidecar 归属"两件套：UI 重建活动面板时有三来源兜底（subagentRunService.ts:16-52 的 source 字段），崩溃后 resume 能把子 Agent 挂回**原来的 Agent 卡片**而不是新的工具调用。同时注意它的写入是 fire-and-forget（runAgent.ts:834-852）——持久化失败只打日志不阻塞 agent，脊柱写入与执行解耦。

**E. ChatPort 六行接口（对应 agentdeck 未来 IM/消息网关；也比 MULTICA 的 channel 层干净）**
如果 agentdeck 要做 IM/聊天集成，`ChatPort`（chat-runtime.ts:67-83）+ ResponseStream 攒批 + per-chat 串行队列 + dedup 键 + 附件懒下载这一套就是模板。特别值得抄的两条注释级教训：handler 链串行化防状态竞态（ws-bridge.ts:207-226）、附件只在通过配对门后下载（chat-runtime.ts:96-102）。

**F. /goal 用 Stop-hook 裁判实现 Goal-based loop（对照 goal-controller.ts + goal-store.ts）**
cc-haha 的 `/goal`（src/goals/goalState.ts）极简：目标字符串 → 注册一个 **Stop hook**，hook prompt 让（独立调用的）模型只输出 `{"ok": true/false, "reason"}`（goalState.ts:140-158），false 则循环继续；目标状态从 transcript 重放恢复（:161-185）。对照 agentdeck 的 goal-controller：cc-haha 版本的优点是**裁判就是一次独立 LLM 调用、无自研状态机**、目标恢复靠"repo 不会忘"的 transcript。agentdeck 的差异化应保留（独立裁判模型、轮数上限、goal-store 显式状态），但可以借鉴它的**从 transcript 重建目标**这条恢复路径，以及 45s 裁判超时这类小参数（goalState.ts:31）。

**G. cron 的双层分钟键去重 + fire-then-record（对照 scheduler.ts）**
agentdeck 的 scheduler 若担心"桌面多实例/重启后重复触发"，cc-haha 的做法直接可用：内存 minuteKey + 持久 lastFiredAt 双层去重（cronScheduler.ts:565-598），**先记后跑**（:667-669 注释：立即写 lastFiredAt 让其他调度进程看见）。另外"自动跑不留会话、手动跑才建会话"（:641-655）是好的产品分寸。

**H. 权限请求的多客户端快照对账（对照 permission-broker.ts）**
`permission_requests_snapshot`（连接时 ws/handler.ts:580-587 全量重放 pending 请求）+ `permission_resolved` 广播 + IM 侧对账（permission-sync.ts）三件套，解决"审批人在多个端、任一端批掉、其他端收敛"。agentdeck 的 permission-broker 若目前只有桌面弹窗，补"连接即快照 + 他端已批广播"两个事件即可获得多端审批能力。

### 6.2 cc-haha 做得更好的地方

1. **上下文成本工程**：runAgent.ts:460-490 对只读子 agent 裁掉 CLAUDE.md 与 stale gitStatus（注释给出 Gtok/周量级），fork 路径追求与父会话 byte-identical 前缀以命中 prompt cache（AgentTool.tsx:620-643）。agentdeck 的 delegate 目前未必算这笔账。
2. **错误语义的文档化**：`ConversationStartupError` 的 code 枚举（WORKDIR_INVALID/CLI_AUTH_REQUIRED/CLI_SESSION_CONFLICT/CLI_START_FAILED/CLI_SPAWN_FAILED/SESSION_DELETED）+ retryable 标志（conversationService.ts:254-269），UI 能据此给出"重试还是修配置"的分流。
3. **单二进制三模式 sidecar**：server/cli/adapters 共享一份 55MB runtime（claude-sidecar.ts:2-19），适配器缺凭据只跳过不拖死进程（:177-196）。对分发体积敏感的 Electron 应用是实打实的优化。
4. **测试密度与质量门禁**：根 package.json 的 quality-gate 体系（provider-smoke/desktop-smoke/agent-flow/persistence-upgrade 等 40+ 脚本），连"会话列表投影冷启动 I/O 优先级"都有可测函数（index.ts:97-121）。

### 6.3 agentdeck 已有的差异化优势

1. **多后端编排**：cc-haha 本质是**单后端**（自家 Claude Code 重实现，provider 只换模型网关 `src/server/proxy/`）；agentdeck 的 `backends/*`（claude/codex/opencode/zcode/dsh 五协议适配）在"异构 CLI 编排"维度上领先，且这是 Multica 拆解报告里确认的稀缺能力。
2. **验证重试循环（Loop 2）**：cc-haha 只有内置 verification subagent（一次性 PASS/FAIL），没有"失败带反馈重试"的策略层；agentdeck 的 `retry-policy.ts`+`task-finalizer.ts` 是显式的 Loop 2。
3. **目标循环状态机**：cc-haha 的 /goal 是 Stop-hook 裁判（好骨架但薄）；agentdeck 的 goal-controller+goal-store 有显式状态、停止条件与 maker/checker 分离。
4. **状态脊柱的中心化设计**：agentdeck 的 issue-store/event-log 是**任务为中心**的事件脊柱（对齐 Loop Engineering 的 State/Memory 构件）；cc-haha 的脊柱是**会话为中心**的 transcript，长任务管理（issue 派发/聚合）反而要靠 Agent Teams 的文件任务目录凑。两种取舍，但编排器视角 agentdeck 的更对。

---

## 7. 结论：架构评价与风险

**评价：四星（架构参考价值高，执行细节是教科书级）**。cc-haha 最值得学的不是某个功能，而是**进程边界的纪律**：业务大脑在 Bun server、原生能力在 Electron 壳、Agent 执行在每会话 CLI 子进程、IM 在独立适配器进程——四类进程只通过 WS/文件系统两个介质通信，任何一个死掉都有明确的恢复路径（resume/transcript 重建/适配器跳过）。持久化上"CLI 拥有 transcript、投影可重建、元数据 sidecar 化"三板斧，加上 rewrite/rewind 的事务性（applyRestorePlan 失败回滚），是"文件即状态脊柱"的成熟示范。

**风险与局限**：
1. **上游血统风险**：代码含大量 ant-internal feature() gated 的 stub（`@generated stub from scan-missing-imports`，如 src/server/sessionManager.ts:1-5、src/proactive/index.ts），且注释里出现 ant/tengu 内部指标口径——它是对 Claude Code 内部实现的重建，法律与可持续升级风险自担；Anthropic 改协议时跟进成本高。
2. **单后端锁定**：所有编排原语（runAgent/teams/worktree）长在自家 CLI 内部，无法编排外部 Agent CLI——与 agentdeck 的定位差异也在于此。
3. **进程内 subagent 的爆炸半径**：同步子 agent 共享父进程，一个子 agent 的内存泄漏/hook 异常影响全会话（cc-haha 自己在 finally 里逐项清理 todos/todos 键泄漏、僵尸 bash 任务，runAgent.ts:951-995 的注释就是事故记录）。
4. **巨型文件**：ws/handler.ts 4671 行、sessionService.ts 4682 行、conversationService.ts 2494 行，sessionStorage.ts 5179 行——状态机与转发逻辑高度耦合，改动成本高（agentdeck 拆分 event-log/issue-store 的做法更可维护）。
5. **安全面**：server 对 loopback 的信任判定要同时看 client address/Host/Origin/代理头（docs server.md:87），H5 与宠物窗各自 token 能力受限（petAccessPolicy），但默认 `127.0.0.1:3456` + cron 自动跑 `bypassPermissions`（cronScheduler.ts:646）意味着本地提权面值得 agentdeck 借鉴时警惕——定时任务默认全权放行这件事，agentdeck 的 permission-broker 应该拦。

---

### 附：本报告直接引用的核心源码文件清单（29 个）

server 层：src/server/index.ts、services/sessionService.ts、services/conversationService.ts、services/cronScheduler.ts、services/cronService.ts（结构）、services/sessionRewindService.ts、services/subagentRunService.ts、services/repositoryLaunchService.ts（结构）、services/localIndex/{coordinator,database}.ts、ws/handler.ts、ws/events.ts；Agent 内核：src/query.ts、src/tools/AgentTool/{runAgent,AgentTool,loadAgentsDir(结构)}.ts(x)、src/utils/worktree.ts、src/utils/sessionStorage.ts、src/utils/teammateMailbox.ts、src/tools/TeamCreateTool/TeamCreateTool.ts、src/tasks/LocalAgentTask/LocalAgentTask.tsx、src/tasks/InProcessTeammateTask/InProcessTeammateTask.tsx、src/goals/goalState.ts；桌面壳：desktop/electron/main.ts、desktop/electron/services/sidecarManager.ts、desktop/electron/ipc/capabilities.ts、desktop/sidecars/claude-sidecar.ts、desktop/src/api/websocket.ts；适配器：adapters/common/{ws-bridge,chat-runtime,permission-sync}.ts。另核读官方 internals 文档 4 篇（structure/desktop/agent/server）与 README.en.md。
