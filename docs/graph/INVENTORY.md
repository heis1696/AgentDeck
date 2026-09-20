# AgentDeck 仓库盘点（INVENTORY）

> 生成日期：2026-09-19。快照来源：worktree 分支 `agentdeck/t_mu86or8r_ynf8xs_c2`（检出自 `6b2f038`，即 main 侧最新提交）。
> 本文档为**只读盘点**产物：本轮未删除、未修改任何既有文件。
>
> **WIP 标注**：任务下达时提到"git status 里 7 个已修改文件与未跟踪的 `src/main/prompts/` 是活跃 WIP"。经核实，该状态存在于主检出（`D:\agentdeck`）工作区；本快照（独立 worktree，检自 `6b2f038`）git status 为 **clean**，且**不存在** `src/main/prompts/` 目录——协作提示词逻辑在本快照中内嵌于 `src/main/delegate.ts`（协议标记/提示词块构建）、`src/main/agent-forge.ts`（锻造 prompt 构建/解析）、`src/main/goal-controller.ts`、`src/main/meeting-controller.ts`（会议信封解析）等文件。本盘点基于 clean 快照，未触碰上述任何 WIP。
>
> 文件数勘误：任务书写"src/main 46 个顶层 .ts"，本快照实际为 **45 个**（+4 个子目录 `backends/`、`hot/`、`ipc/`、`sidecar/` 共 38 个子文件）。

## 0. 总览统计

| 指标 | 值 |
| --- | --- |
| 应用定位 | 本地任务看板：把任务派给本地 agent（Electron + React，零运行时 npm 依赖于主进程热更链路） |
| src 总量 | 136 个 .ts/.tsx，28,233 行 |
| src/main | 83 个文件（顶层 45 + backends 14 + hot 9 + ipc 11 + sidecar 4），顶层合计 12,741 行 |
| src/preload | 1 个文件 `src/preload/index.ts`（21KB，141 个 IPC 调用点） |
| src/renderer | 56 个文件（45 个 .tsx/.ts + 10 个 css + `index.html`） |
| src/shared | 7 个契约文件 |
| scripts/ | 65 个 .mjs + `fixtures/` 目录 |
| package.json 脚本 | 61 条直连 + 4 条聚合（`smoke:stage6/7/8/all`） |
| docs/ | 19 个顶层 .md + `docs/teardown/`(7) + `docs/reports/`(6) + `images/` |
| 构建入口 | `electron.vite.config.ts` 三个 rollup input：`src/main/index.ts`、`src/main/bootstrap.ts`、`src/main/sidecar-server.ts` |
| Electron 主入口 | `package.json` → `./out/main/bootstrap.js`（bootstrap 运行时 `require` 动态加载 `index.js`，因此静态 import 图中 index 无入边——**不是死文件**） |

---

## 1. 代码结构盘点

### 1.1 src/main 顶层 45 文件（按职责分组）

#### A. 入口与组合根（2）

| 文件 | 一句话职责 | 关键导出 |
| --- | --- | --- |
| `src/main/bootstrap.ts` | 免安装热更 bootstrap（asar 五步加载链 + 三类失败自愈），`package.json` main 指向其编译产物，运行时动态 `require` 内置 index 或热更载荷 | 无（副作用入口；`loadBuiltin`/`selfHeal`/`main` 均私有） |
| `src/main/index.ts` | 主进程组合根：窗口/托盘/生命周期，装配 Store/Runner/Stores/IPC/后端表/侧车/热更，自动化定时器 | 无（副作用入口；无静态入边，由 bootstrap 运行时 require） |

#### B. 编排与调度（16）

| 文件 | 一句话职责 | 关键导出 |
| --- | --- | --- |
| `src/main/runner.ts` | 任务运行器：队列 + 生命周期状态机（queued→running→done/failed/cancelled）+ 事件管道 + 委派循环编排 | `TaskRunner`、`RunnerPorts`、`MAX_CONSULT_ROUNDS` |
| `src/main/executor.ts` | 执行器：后端会话 start/stop 与晚到回调/清理 promise 的收尾（2s 上限的 settleWithin） | `Executor` |
| `src/main/delegate.ts` | 委派协议：`<delegate>/<consult>/<investigate>/<continue>/<review>` 标记解析、子任务并行执行、worktree 分支合并回灌 | `runDelegationLoop`、`parseDelegates(Merged)`、`buildAgentPrompt`、`buildDelegationBlock`、`MAX_DEPTH`、`MAX_TOTAL_ROUNDS`、`ancestorBudget` |
| `src/main/scheduler.ts` | 并发调度器：普通任务与委派 worker 双队列，不感知执行细节 | `Scheduler`、`SchedulerLimits` |
| `src/main/task-service.ts` | 任务创建领域服务：assignment/handoff/child 三类创建的统一入口与校验 | `TaskService`、`CreateTaskInput`、`TaskCreationService`（死别名，见 §4） |
| `src/main/task-finalizer.ts` | 任务终态收尾：git 快照、状态落库、UI 推送 | `TaskFinalizer` |
| `src/main/turn-lifecycle.ts` | 回合生命周期：EventGate 代际门禁（拦截 stop/close 之后晚到的后端回调） | `EventGate`、`TurnLifecycle`、`TurnHandle` |
| `src/main/retry-policy.ts` | 失败重试决策：是否重试/第几次/是否换新会话/退避时长 | `decideRetry`、`RetryDecision` |
| `src/main/failure.ts` | 失败分类：后端原始错误 → 稳定 code + 人话标题 + 处置提示（规则按序短路） | `classifyFailure` |
| `src/main/goal-controller.ts` | 目标自动驾驶状态机：阶段推进、预算护栏（block/no-progress/retry）、doom-loop 检测、验收调用 | `GoalController`、`detectDoomLoop`、`progressKeyForOutput`、阈值常量（`DEFAULT_BLOCK_CAP` 等被 smoke 消费） |
| `src/main/meeting-controller.ts` | 多人会议编排：回合发言、插话、反对意见、行动项审批、纪要产出 | `MeetingController` |
| `src/main/agent-forge.ts` | 锻造师：队员草稿生成/按反馈改进/触发评测（唯一编排入口 runForgeTurn，ctx 注入依赖） | `draftAgent`、`improveAgent`、`evaluateDraft` |
| `src/main/agent-sessions.ts` | 后端会话登记表：跨任务复用的会话（领队/队员续聊）与办公送达跟进 | `AgentSessionRegistry`、`OfficeFollowUpResult` |
| `src/main/acceptance-verifier.ts` | 保守的主机侧验收：仅处理带机器前缀的验收判据，自然语言判据返回 null 走兼容路径 | `verifyAcceptance` |
| `src/main/retention.ts` | 过期 Issue 清扫定时任务（终态超龄归档） | `startIssueRetention`、`sweepExpiredIssues`（smoke 消费） |
| `src/main/permission-broker.ts` | 权限经纪：后端权限请求的挂起/超时/裁决（allow/deny）桥 | `PermissionBroker` |

#### C. 存储与状态（10）

| 文件 | 一句话职责 | 关键导出 |
| --- | --- | --- |
| `src/main/store.ts` | 任务存储：`userData/tasks.json` 索引 + `userData/tasks/<id>/events.jsonl` 事件流，schema 版本化迁移 | `TaskStore`、`TASK_INDEX_SCHEMA_VERSION`（smoke 消费）、`migrateTaskIndex`（smoke 消费） |
| `src/main/event-log.ts` | 事件日志：JSONL 读写、schema 迁移、重放一致性（ReplayDivergence 检测） | `EventLog`、`migrateTaskEvent`（smoke 消费）、`UnsupportedTaskEventVersionError`（smoke 消费） |
| `src/main/issue-store.ts` | Issue/Run/Comment 投影持久化（自增编号 iss_xxx） | `IssueStore` |
| `src/main/goal-store.ts` | Goal/GoalRun/Checkpoint/Spec 快照/决策持久化（版本化索引） | `GoalStore`、`GOAL_INDEX_SCHEMA_VERSION` |
| `src/main/meeting-store.ts` | 会议持久化（版本化索引） | `MeetingStore` |
| `src/main/settings.ts` | 应用设置读写：`userData/settings.json` | `loadSettings`、`saveSettings` |
| `src/main/agents.ts` | Agent 身份层持久化：名字 + 后端 + 模型/说明（"agent 即队友"） | `Agent`、`loadAgents`、`saveAgents`、`defaultAgents` |
| `src/main/presets.ts` | API 预设（连接档案：baseURL/apiKey）持久化 + 预设在线拉模型目录 | `ApiPreset`、`loadPresets`、`savePresets`、`fetchPresetModels` |
| `src/main/automation-store.ts` | 定时自动化规则持久化（`automations/index.json`） | `AutomationStore` |
| `src/main/usage.ts` | 用量归一：各后端键名不一的 usage 事件聚合为 TaskUsage | `aggregateUsage`、`fmtTokens` |

#### D. 观测与探测（2）

| 文件 | 一句话职责 | 关键导出 |
| --- | --- | --- |
| `src/main/analytics.ts` | 统计聚合：任务/运行/Token/费用/时长汇总为 AnalyticsSummary | `buildAnalytics` |
| `src/main/runtime.ts` | 运行时健康探测：各后端 CLI 可用性 → RuntimeSnapshot（带超时） | `probeRuntimes` |

#### E. Git 与 worktree（1）

| 文件 | 一句话职责 | 关键导出 |
| --- | --- | --- |
| `src/main/git.ts` | git 命令基座 + worktree 全生命周期（创建/认领/合并/清理/清扫）+ 单文件权威 diff | `runGit`、`createWorktree`、`sweepWorktrees`、`mergeBranchInto`、`fileDiff`、`branchDiffSummary`（`cleanupWorktree`/`pruneWorktree` 为死别名，见 §4） |

#### F. IPC（12：顶层 1 + `ipc/` 11）

| 文件 | 一句话职责 | 关键导出 |
| --- | --- | --- |
| `src/main/ipc-validation.ts` | 入参校验纯函数族（parseId/parseTaskCreate/parseGoalEvolve…，白名单集合驱动） | `parseId`、`parseTaskCreate`、`parseIssueCreate`、`parseGoalCreate`、`parseAgents` 等 22 个 parse* |
| `src/main/ipc/register.ts` | IPC 总装：按域装配 9 个 register* 模块 | `registerIpcHandlers` |
| `src/main/ipc/context.ts` | `IpcContext` 服务容器接口：IPC 层依赖倒置中枢（被所有 ipc/* 与 agent-forge 以 type-only 引用） | `IpcContext`（type） |
| `src/main/ipc/tasks.ts` | `tasks:*` handlers：CRUD/移动/rewind/followUp/权限应答/fileDiff/usage | `registerTaskIpc` |
| `src/main/ipc/issues.ts` | `issues:*` handlers + `issues:updated` 事件广播 | `registerIssueIpc` |
| `src/main/ipc/goals.ts` | `goals:*` handlers：创建/演化/回滚/检查点/启停 | `registerGoalIpc` |
| `src/main/ipc/meetings.ts` | `meetings:*` handlers：创建/启停/插话/行动项裁决 | `registerMeetingIpc` |
| `src/main/ipc/catalog.ts` | `agents:*`/`presets:*`/`automations:*` handlers + 锻造师 draft/improve/evaluate + Markdown 导入导出 + 模型目录 | `registerCatalogIpc` |
| `src/main/ipc/extensions.ts` | 扩展资产 IPC：skills/mcp/hooks 的安装同步、plugins 盘点启停、marketplaces、sources 源仓库 | `registerExtensionsIpc` |
| `src/main/ipc/skills.ts` | `skills:*` handlers：共享目录技能 CRUD/导入/目标安装 | `registerSkillsIpc` |
| `src/main/ipc/system.ts` | 系统域：settings 读写探测、runtime 快照、analytics、dialog/shell/notify、worktrees:prune | `registerSystemIpc` |
| `src/main/ipc/updates.ts` | 热更 IPC：updates 四 handler + `updates:state` 推送（只增不改约定） | `registerUpdatesIpc` |

#### G. 后端适配 `backends/`（14）

| 文件 | 一句话职责 | 关键导出 |
| --- | --- | --- |
| `src/main/backends/types.ts` | `AgentBackend` 适配器接口 + 会话/事件契约（新后端实现此接口注册即可） | `AgentBackend`、`BackendSession`、`BackendTurnResult` |
| `src/main/backends/cli-common.ts` | 一次性 CLI 进程公共基座：spawn + JSONL 行解析 + 看门狗 + 清理 | `runCliJsonl`、`killProcessTree`、`JsonValue` |
| `src/main/backends/cli-locator.ts` | Windows CLI 查找：.cmd 垫片解析（Node 18+ 禁 spawn .cmd 的坑） | `findOnPath`、`resolveCli`、`probeCli`、`findSystemNode` |
| `src/main/backends/edit-meta.ts` | 工具调用编辑元数据归一（渲染层 `file +N -M` 角标契约） | `parseEditMeta`、`countEditLines`（smoke 消费） |
| `src/main/backends/zcode.ts` | ZCode 适配器：spawn `zcode app-server --stdio`，讲逆向得到的 ZCode Protocol（NDJSON JSON-RPC） | `createZcodeBackend` |
| `src/main/backends/zcode-protocol.ts` | ZCode 协议纯函数解析（record/string 等容错取值） | `zcodeRecord`、`zcodeString` |
| `src/main/backends/zcode-transport.ts` | ZCode 线格式与传输层（消息帧/JSON 容错） | `ZcodeConnection`、`ZcodeWireMessage` |
| `src/main/backends/zcode-config.ts` | zcode.cjs 定位（多盘扫描）+ 模型目录在线拉取 | `zcodeDefaultPaths`、`listZcodeModels` |
| `src/main/backends/claude.ts` | Claude Code 适配器：`claude -p --output-format stream-json`（一次性进程，--resume 续聊） | `createClaudeBackend` |
| `src/main/backends/codex.ts` | Codex 适配器：`codex exec --json`（bypass 沙箱，resume 续聊） | `createCodexBackend` |
| `src/main/backends/opencode.ts` | OpenCode 适配器：`opencode run --format json`（-s 续聊） | `createOpencodeBackend` |
| `src/main/backends/opencode-server.ts` | OpenCode server 常驻接入（HTTP + delta 流式事件） | `createOpencodeServerBackend`、`validateOpencodeVersion` |
| `src/main/backends/dsh.ts` | DeepSeek Harness 适配器：ACP 常驻优先，headless 一次性纯文本回退（含 `DSH_TURN_BUDGET_MS` 预算常量，被 runner 引用） | `createDshBackend`、`DSH_TURN_BUDGET_MS` |
| `src/main/backends/dsh-acp.ts` | DSH 的 ACP 接入：NDJSON JSON-RPC over stdio（session/update 流式、权限确认桥接） | `startDshAcpSession`、`findDshAcpBin`、`AcpBootError` |

#### H. 侧车 sidecar（顶层 3 + 子目录 4）

| 文件 | 一句话职责 | 关键导出 |
| --- | --- | --- |
| `src/main/sidecar.ts` | `SidecarManager`：业务侧车管理器——spawn loopback HTTP 子进程（`out/main/sidecar-server.js`）、RPC 调用、状态落盘、失联重生 | `SidecarManager`、`SIDECAR_PROTOCOL_VERSION`、`SidecarSnapshot` |
| `src/main/sidecar-server.ts` | 侧车 HTTP 服务（**被 spawn 的子进程入口，独立构建入口**）：HTTP RPC → SidecarRuntime，事件经 EventLog 回放推送 | `startSidecarServer` |
| `src/main/sidecar-runtime.ts` | 侧车内执行栈自举：复用 Store/IssueStore/GoalStore/GoalController/TaskService/Runner + 五后端表（与主进程同构的迷你组合根） | `SidecarRuntime` |
| `src/main/sidecar/index.ts` | 公共导出桶（预留 RPC 方法拆分；当前**无任何引用方**，见 §4.B） | `export * from …` |
| `src/main/sidecar/protocol.ts` | 侧车 RPC 协议：握手/请求响应/版本断言/错误构造 | `SIDECAR_PROTOCOL`、`makeSidecarRequest`、`assertSidecarVersion` |
| `src/main/sidecar/manager.ts` | 再导出垫片（`../sidecar` 的别名桶；**无引用方**，见 §4.B） | — |
| `src/main/sidecar/server.ts` | 再导出垫片（`../sidecar-server` 的别名桶；**无引用方**，见 §4.B） | — |

> 命名陷阱提示：真正的管理器是 `src/main/sidecar.ts`（导出 SidecarManager），真正的服务入口是 `src/main/sidecar-server.ts`；`src/main/sidecar/manager.ts` 与 `src/main/sidecar/server.ts` 只是垫片。

#### I. 热更 hot（9）

| 文件 | 一句话职责 | 关键导出 |
| --- | --- | --- |
| `src/main/hot/canonical.ts` | 规范化 JSON 序列化（发布脚本与 verifier 同字节保证；键按 UTF-8 序排序） | `canonicalJson` |
| `src/main/hot/feed.ts` | feed 拉取：manifest 定点下载 + artifact 下载（20s 超时 + 1/2/4s 退避重试） | `fetchManifest`、`downloadArtifact` |
| `src/main/hot/pointer.ts` | 热更指针：读侧校验规则 1-3、tmp+rename 原子写、清除=改名留证 | `readPointer`、`writePointerAtomic`、`clearPointer`、`HotChannel` |
| `src/main/hot/resolve.ts` | 指针全链解析（规则 4-6 校验），bootstrap（L1）与 index（L2）共用，只读不写 | `resolveHotState`、`HotResolution` |
| `src/main/hot/shell.ts` | L0 壳自替换：Windows 运行中 exe 的文件级 rename dance（stageShellZip/placeUnlockedFiles/spawnSwapHelper）+ 过期目录清扫 | `sweepOldShellDirs`、`stagingDirFor`、`rollbackShell` |
| `src/main/hot/trust.ts` | 信任锚：内置 Ed25519 raw 公钥（keyId 支持轮换），私钥不进仓库 | `TRUST_KEYS`（`scripts/gen-hot-key.mjs` 消费） |
| `src/main/hot/verifier.ts` | manifest 校验：sha256（`sha256File`）+ Ed25519 签名 + 通道门禁（规则 5/6） | `verifyManifest`、`ed25519PublicKeyFromRawHex`、`ManifestVerdict` |
| `src/main/hot/updater.ts` | `HotUpdater` 双通道状态机：staging→验签→原子指针→（载荷）relaunch；全程单飞互斥 | `HotUpdater` |
| `src/main/hot/zip.ts` | store-only zip 读写（零 npm 依赖、CRC 校验、zip-slip 防护；发布与解压共用） | `createZipStore`（release 脚本消费）、`extractZipStore` |

#### J. 提示词、协作协议与扩展生态（10）

> 任务分组中的"提示词 prompts"：本快照无独立目录；提示词构建/解析逻辑落在 `src/main/delegate.ts`、`src/main/agent-forge.ts`、`src/main/goal-controller.ts`、`src/main/meeting-controller.ts`（见 B 组），以及本组的 `src/main/agent-exchange.ts`。本组其余为共享资产与外部 CLI 配置生态。

| 文件 | 一句话职责 | 关键导出 |
| --- | --- | --- |
| `src/main/agent-exchange.ts` | 队员定义 ↔ Claude Code subagent Markdown 互换（纯函数；导入内容剥离派发协议标记） | `serializeAgentMarkdown`、`parseAgentMarkdown` |
| `src/main/skills.ts` | 共享目录技能库：SKILL.md 解析/CRUD/导入（纯 Node，路径参数注入便于 smoke） | `listSkills`、`readSkill`、`saveSkill`、`importSkill`、`parseFrontmatter`、`isValidSkillName` |
| `src/main/skill-targets.ts` | 技能安装目标注册表（三大 CLI 用户目录 + 中立共享位）与同步状态 | `resolveSkillTargets`、`installSkill`、`uninstallSkill`、`skillSyncState` |
| `src/main/mcp-store.ts` | 共享目录 MCP 服务器库 CRUD（`mcp/<name>.mcp.json`） | `listMcp`、`saveMcp`、`deleteMcp` |
| `src/main/hook-store.ts` | 共享目录 Hook 库 CRUD（HOOK.md + hook.json 事件定义） | `listHooks`、`saveHook`、`deleteHook`、`assertHookEvents` |
| `src/main/sources.ts` | 扩展源仓库：git clone 注册表、浏览发现资产、技能导入、marketplace 资产读取 | `addSource`、`syncSource`、`browseSource`、`installSkillsFromUrl`、`registerMarketplaceAsset` |
| `src/main/extension-catalog.ts` | 内置精选扩展源目录（随应用发布的"常用仓库"清单） | `EXTENSION_CATALOG` |
| `src/main/config-editor.ts` | 用户配置安全合并器：MCP/Hook/插件装/卸到各 CLI 用户级配置（先备份 .agentdeck-bak、只动自己的键、codex TOML 块级文本操作） | `installMcpTo*`、`installHookTo*`、`registerMarketplaceTo*`、`setClaudePluginEnabled`、`mcpState` |
| `src/main/plugin-cli.ts` | 插件装卸（v1 仅 claude）：借官方 CLI `plugin install/uninstall` 子命令，60s 超时强杀 | `installClaudePlugin`、`uninstallClaudePlugin` |
| `src/main/plugin-inventory.ts` | 插件/市场只读盘点（claude/zcode/codex 三 CLI，全容错） | `pluginInventory`、`marketplaceStatus`、`registeredMarketplaces` |

### 1.2 preload：IPC API 面（`src/preload/index.ts`）

单一文件经 `contextBridge.exposeInMainWorld('agentdeck', api)` 暴露类型安全桥；共 **141 个调用点 = 126 invoke + 14 事件订阅（on）+ 1 send**。类型全部来自 `src/shared/*`（`contracts.ts` 为 API 面契约）。按域归类：

| 域 | 方法（invoke） | 事件（on/send） | 主进程 handler 落点 |
| --- | --- | --- | --- |
| `tasks` | list/get/events/create/cancel/followUp/delete/retry/move/start/rewind/rename/fileDiff/respondPermission | task:events-invalidated、task:updated、task:deleted、task:focus、task:event、task:permission | `src/main/ipc/tasks.ts` |
| `issues` | list/get/create/runs/comments/update/addComment | issues:updated | `src/main/ipc/issues.ts` |
| `goals` | list/get/create/runs/checkpoints/snapshots/decisions/approveEvolution/evolve/evolveStep/rollback/start/pause/resume/cancel/continue/checkpoint/delete | goals:updated、goals:deleted | `src/main/ipc/goals.ts` |
| `meetings` | list/get/create/start/pause/resume/interject/cancel/approveAction/delete | meetings:updated、meetings:deleted | `src/main/ipc/meetings.ts` |
| `automations` | list/create/update/delete/runNow | — | `src/main/ipc/catalog.ts` |
| `agents` | list/save/models/draft/improve/evaluate/importMd/exportMd | — | `src/main/ipc/catalog.ts` |
| `presets` | list/save/newId/models | — | `src/main/ipc/catalog.ts` |
| `settings` | get/set/probe | settings:updated | `src/main/ipc/system.ts` |
| `runtimes` | snapshot | — | `src/main/ipc/system.ts` |
| `analytics` | summary | — | `src/main/ipc/system.ts` |
| `sidecar` | status/sync/reconnect | sidecar:status | `src/main/ipc/system.ts`（handler）；事件由 `src/main/index.ts:296` 直推 |
| `updates` | getState/check/apply/applyAll/rollback | updates:state | `src/main/ipc/updates.ts` |
| `skills` | list/get/save/delete/import/installFromUrl/searchOnline/installOnline/openExternal/targets/install/uninstall/openDir | — | `src/main/ipc/skills.ts` |
| `mcp` | list/save/delete/targets/install/uninstall | — | `src/main/ipc/extensions.ts` |
| `hooks` | list/get/save/delete/targets/install/uninstall | — | `src/main/ipc/extensions.ts` |
| `plugins` | inventory/setEnabled/openDir/install/uninstall | — | `src/main/ipc/extensions.ts` |
| `marketplaces` | status/register/listPlugins/listRegistered | — | `src/main/ipc/extensions.ts` |
| `sources` | catalog/list/add/quickAdd/remove/sync/browse/listSkills/importSkill | — | `src/main/ipc/extensions.ts` |
| `worktrees` | prune | — | `src/main/ipc/system.ts` |
| 顶层 | `pickDir`（dialog:pick-dir）、`openPath`（shell:open）、`notify`（send） | — | `src/main/ipc/system.ts` |

### 1.3 renderer 结构简述（45 个 .tsx/.ts）

- 入口链：`src/renderer/index.html` → `src/renderer/src/main.tsx`（挂载 + 引入 10 个 css）→ `src/renderer/src/App.tsx`（视图路由 `board/issues/detail/usage/settings/automation/skills/agents` 8 视图 + TabBar + 命令面板 + 最近工作区）。
- API 层：`src/renderer/src/api.ts` —— `window.agentdeck` 的类型封装 + `useTasks`/`useSettings` 等 hooks（注意其中的 `useSidecar` 尚无消费方，见 §4）。
- 领域服务：`src/renderer/src/task-service.ts`（渲染层任务命令封装，组件只传领域值不碰 IPC payload）、`src/renderer/src/labels.ts`（状态中文标签）、`src/renderer/src/components/meeting/captains.ts`（队长资格判定）。
- 视图组件（`components/`）：`BoardView`（看板）、`IssuesView`、`TaskDetail`、`WorkspaceView`、`AgentsView`、`SkillsView`、`ExtensionsView`、`AutomationView`、`UsageView`、`RuntimeView`、`SettingsView`、`UpdatePanel`、`DiffView`、`Markdown`、`TabBar`；子目录 `task/`（WorkerPane、TurnTimeline、ActivityTimeline、GitSummary、PermissionPrompt、SkillMenu）、`goal/`（GoalPanel、GoalCreateDialog）、`meeting/`（MeetingPanel、MeetingCard）。
- 通用 UI（`ui/`）：`SideDock`（右侧停靠 + 详情面板，**渲染层循环依赖一环**）、`CodeViewer`（shiki 高亮）、`Palette`（命令面板）、`Toasts`、`Confirm`、`Menu`、`FloatWindow`、`EmptyState`、`IssueIdChip`。
- hooks（`hooks/`）：`useTaskEvents`（持久化+实时事件合并）、`eventMerge`、`turnModel`（回合模型构建，被 `scripts/smoke-turn-model.mjs` 直接消费）、`useIssueDetails`、`usePromptHistory`。
- 样式：`styles.css`/`tokens.css` + `polish/` 8 个分区样式。

### 1.4 shared 契约层（7 个文件）

| 文件 | 内容 |
| --- | --- |
| `src/shared/types.ts` | Task/TaskEvent/Issue/Run/Goal/Automation/AppSettings 等核心领域类型 + 事件 schema 常量 |
| `src/shared/contracts.ts` | 渲染层↔主进程 API 面契约（AgentDeckApi、各 Input/Snapshot） |
| `src/shared/taskflow.ts` | 任务/目标状态机纯函数（状态转移、终态集合、canRetry） |
| `src/shared/meeting.ts` | 会议域类型 + 状态常量 |
| `src/shared/forge.ts` | 锻造师草稿/评测契约 |
| `src/shared/skills.ts` | 技能元数据/详情/安装目标契约 |
| `src/shared/extensions.ts` | MCP/Hook/插件/市场/源仓库契约 |

---

## 2. 核心依赖链（邻接表）

以下为"谁 import 谁"的文本邻接表（仅列 `src/` 内相对导入；`→` 为静态 import，`(type)` 标注 type-only 导入即编译期擦除）。

### 2.1 主干一：任务执行 runner → executor → delegate

```text
src/main/index.ts        → runner, task-service, store, issue-store, goal-store, goal-controller,
                           meeting-controller, agent-sessions, automation-store, retention,
                           acceptance-verifier, settings, agents, presets, sidecar,
                           backends/{claude,codex,dsh,opencode,zcode,types}, git, skills,
                           event-log, ipc/register, hot/{pointer,resolve,shell,updater}
src/main/runner.ts       → executor, delegate, backends/dsh(仅 DSH_TURN_BUDGET_MS 常量), backends/types,
                           failure, git, permission-broker, retry-policy, scheduler, store,
                           task-finalizer, turn-lifecycle, shared/taskflow, shared/types
src/main/executor.ts     → backends/types            （执行面只依赖适配器接口，具体后端由组合根注入）
src/main/delegate.ts     → runner(type), backends/types, git, store, shared/types
src/main/task-service.ts → store, issue-store, shared/types
src/main/task-finalizer.ts → git, store, usage, shared/taskflow, shared/types
src/main/turn-lifecycle.ts → backends/types, shared/taskflow, shared/types
src/main/scheduler.ts    → shared/types
```

要点：`runner → executor` 是"编排 → 执行"，`executor` 只认 `backends/types` 接口；`runner → delegate` 是"编排 → 委派循环"，delegate 反向只在类型层引用 `TaskRunner`（见 §2.6 循环依赖）。五个后端适配器由 `index.ts` / `sidecar-runtime.ts` 在组合根创建后注入 `Map<string, AgentBackend>`，`runner.ts` 对 `backends/dsh` 的唯一依赖是一个预算常量。

### 2.2 主干二：goal-controller

```text
src/main/goal-controller.ts → goal-store, shared/contracts, shared/taskflow, shared/types
被谁引用（入边）： acceptance-verifier、index.ts、ipc/context(type)、sidecar-runtime、scripts/smoke-goal*.mjs(esbuild 直连)
src/main/goal-store.ts      → event-log, shared/taskflow, shared/types
src/main/acceptance-verifier.ts → goal-controller, shared/types
```

### 2.3 主干三：meeting-controller

```text
src/main/meeting-controller.ts → agent-sessions(值), meeting-store, delegate(type), task-service(type), shared/meeting
被谁引用（入边）： index.ts、ipc/context(type)
src/main/agent-sessions.ts  → delegate, store, task-service, shared/types
src/main/meeting-store.ts   → shared/meeting
```

### 2.4 主干四：agent-forge

```text
src/main/agent-forge.ts  → agents, skills, backends/types, ipc/context(type), shared/forge
被谁引用（入边）： ipc/catalog（agents:draft/improve/evaluate 的唯一 IPC 出口）
src/main/agents.ts       → shared/forge, shared/types
src/main/agent-exchange.ts → agents, skills, shared/forge
```

### 2.5 主干五：sidecar

```text
src/main/index.ts            → sidecar.ts（SidecarManager）
src/main/ipc/context.ts      → sidecar.ts(type)
src/main/sidecar.ts          → （无 src 内静态依赖；运行时 spawn out/main/sidecar-server.js）
src/main/sidecar-server.ts   → sidecar.ts(协议版本常量), sidecar/protocol, event-log, sidecar-runtime, shared/types
src/main/sidecar-runtime.ts  → runner, goal-controller, goal-store, issue-store, store, task-service,
                               backends/{claude,codex,dsh,opencode,zcode,types}, shared/types
src/main/sidecar/protocol.ts → sidecar.ts(type-only 重导出面)
src/main/sidecar/index.ts    → sidecar, sidecar-server, sidecar-runtime, sidecar/protocol （桶，无出边入边）
```

要点：这是**进程级**两条腿——主进程内 `SidecarManager` 通过 spawn 拥有子进程；子进程 `sidecar-server`（独立构建入口）内 `SidecarRuntime` 自举出与主进程同构的执行栈。两侧经 `sidecar/protocol` 约定的 HTTP RPC 通信。

### 2.6 循环依赖判定（Tarjan SCC 全量扫描）

> 2026-09-20 更正：下表是原始基线快照。UI 统一改造已解开第 2 项渲染层三角环，`TurnTimeline` 现改依赖 `ui/interaction-center.ts`；当前边以 `deps.json` 为准。`smoke-ui-interaction-center.mjs` 直接消费中心/层栈及兼容导出，`smoke-ui-focus.mjs` 经 `fixtures/ui-focus-harness.tsx` 消费 `useInteractionLayer`、Confirm/Menu/Palette/SideDock；这些新增测试入口同样受附录 A 的公共 API 保护规则约束。

| # | 环 | 性质 | 风险与解耦点 |
| --- | --- | --- | --- |
| 1 | `src/main/delegate.ts` ↔ `src/main/runner.ts` | **类型级环**：delegate→runner 仅为 `import type { TaskRunner }`（`src/main/delegate.ts:6`，编译期擦除）；runner→delegate 为真实值导入（`src/main/runner.ts:7`） | 运行时无环，低风险。若想消除类型环：把 `TaskRunner` 的委派端口收窄成接口移入 `delegate.ts`（`RunnerPorts` 已有雏形） |
| 2 | `src/renderer/src/ui/SideDock.tsx` → `components/task/WorkerPane.tsx` → `components/task/TurnTimeline.tsx` → `ui/SideDock.tsx` | **真值导入三角环**（`SideDock.tsx:16`、`WorkerPane.tsx:15`、`TurnTimeline.tsx:9`） | 运行时依赖 ESM/CJS 提升才成立，重构风险点。解耦建议：`TurnTimeline` 需要的 `openDockItem` 抽到独立模块（如 `ui/dock-bus.ts`） |
| — | 其余全部 src 模块 | 无环（SCC 扫描仅上述两处多节点强连通分量；`ipc/context` 虽被 `agent-forge` 引用但全部为 type-only，且 context 不反向依赖 forge） | — |

### 2.7 全量邻接表（src/main，知识图谱直接可用）

```text
# 格式：源 -> 目标[, 目标…]（仅 src/ 内相对导入；含 type-only）
src/main/acceptance-verifier -> src/main/goal-controller, src/shared/types
src/main/agent-exchange -> src/main/agents, src/main/skills, src/shared/forge
src/main/agent-forge -> src/main/agents, src/main/backends/types, src/main/ipc/context, src/main/skills, src/shared/forge
src/main/agent-sessions -> src/main/delegate, src/main/store, src/main/task-service, src/shared/types
src/main/agents -> src/shared/forge, src/shared/types
src/main/analytics -> src/main/agents, src/shared/types
src/main/automation-store -> src/shared/types
src/main/backends/claude -> src/main/backends/cli-common, src/main/backends/cli-locator, src/main/backends/edit-meta, src/main/backends/types, src/shared/types
src/main/backends/cli-common -> src/shared/types
src/main/backends/cli-locator -> (none)
src/main/backends/codex -> src/main/backends/cli-common, src/main/backends/cli-locator, src/main/backends/edit-meta, src/main/backends/types, src/shared/types
src/main/backends/dsh -> src/main/backends/cli-common, src/main/backends/cli-locator, src/main/backends/dsh-acp, src/main/backends/types
src/main/backends/dsh-acp -> src/main/backends/cli-common, src/main/backends/cli-locator, src/main/backends/types, src/shared/contracts, src/shared/types
src/main/backends/edit-meta -> src/shared/types
src/main/backends/opencode -> src/main/backends/cli-common, src/main/backends/cli-locator, src/main/backends/edit-meta, src/main/backends/opencode-server, src/main/backends/types, src/shared/types
src/main/backends/opencode-server -> src/main/backends/edit-meta, src/main/backends/types, src/shared/contracts, src/shared/types
src/main/backends/types -> src/shared/contracts, src/shared/types
src/main/backends/zcode -> src/main/backends/cli-common, src/main/backends/edit-meta, src/main/backends/types, src/main/backends/zcode-config, src/main/backends/zcode-protocol, src/main/backends/zcode-transport, src/shared/types
src/main/backends/zcode-config -> src/main/backends/cli-common
src/main/backends/zcode-protocol -> src/main/backends/cli-common, src/main/backends/zcode-transport
src/main/backends/zcode-transport -> src/main/backends/cli-common
src/main/bootstrap -> src/main/hot/pointer, src/main/hot/resolve
src/main/config-editor -> src/shared/extensions, src/shared/skills
src/main/delegate -> src/main/backends/types, src/main/git, src/main/runner(type), src/main/store, src/shared/types
src/main/event-log -> src/shared/types
src/main/executor -> src/main/backends/types
src/main/extension-catalog -> src/shared/extensions
src/main/failure -> src/shared/types
src/main/git -> src/shared/contracts, src/shared/types
src/main/goal-controller -> src/main/goal-store, src/shared/contracts, src/shared/taskflow, src/shared/types
src/main/goal-store -> src/main/event-log, src/shared/taskflow, src/shared/types
src/main/hook-store -> src/main/skills, src/shared/extensions
src/main/hot/canonical -> (none)
src/main/hot/feed -> src/main/hot/verifier
src/main/hot/pointer -> (none)
src/main/hot/resolve -> src/main/hot/pointer, src/main/hot/verifier
src/main/hot/shell -> src/main/hot/zip
src/main/hot/trust -> (none)
src/main/hot/updater -> src/main/hot/feed, src/main/hot/pointer, src/main/hot/resolve, src/main/hot/shell, src/main/hot/trust, src/main/hot/verifier, src/main/hot/zip, src/shared/contracts, src/shared/types
src/main/hot/verifier -> src/main/hot/canonical, src/main/hot/trust
src/main/hot/zip -> (none)
src/main/index -> src/main/acceptance-verifier, src/main/agent-sessions, src/main/agents, src/main/automation-store, src/main/backends/{claude,codex,dsh,opencode,types,zcode}, src/main/event-log, src/main/git, src/main/goal-controller, src/main/goal-store, src/main/hot/{pointer,resolve,shell,updater}, src/main/ipc/register, src/main/issue-store, src/main/meeting-controller, src/main/meeting-store, src/main/presets, src/main/retention, src/main/runner, src/main/settings, src/main/sidecar, src/main/skills, src/main/store, src/main/task-service, src/shared/types
src/main/ipc-validation -> src/main/agents, src/main/presets, src/shared/contracts, src/shared/types
src/main/ipc/catalog -> src/main/agent-exchange, src/main/agent-forge, src/main/agents, src/main/backends/zcode-config, src/main/ipc-validation, src/main/ipc/context, src/main/presets, src/shared/forge
src/main/ipc/context -> src/main/agents, src/main/automation-store, src/main/backends/types, src/main/goal-controller, src/main/hot/updater, src/main/issue-store, src/main/meeting-controller, src/main/presets, src/main/runner, src/main/sidecar, src/main/store, src/main/task-service, src/shared/types （注：本文件大量为 type-only）
src/main/ipc/extensions -> src/main/config-editor, src/main/extension-catalog, src/main/hook-store, src/main/ipc-validation, src/main/ipc/context, src/main/mcp-store, src/main/plugin-cli, src/main/plugin-inventory, src/main/skills, src/main/sources, src/shared/extensions
src/main/ipc/goals -> src/main/ipc-validation, src/main/ipc/context
src/main/ipc/issues -> src/main/ipc-validation, src/main/ipc/context, src/shared/types
src/main/ipc/meetings -> src/main/ipc-validation, src/main/ipc/context, src/shared/meeting
src/main/ipc/register -> src/main/ipc/{catalog,context,extensions,goals,issues,meetings,skills,system,tasks,updates}
src/main/ipc/skills -> src/main/ipc-validation, src/main/ipc/context, src/main/skill-targets, src/main/skills
src/main/ipc/system -> src/main/analytics, src/main/backends/zcode-config, src/main/git, src/main/ipc-validation, src/main/ipc/context, src/main/runtime
src/main/ipc/tasks -> src/main/git, src/main/ipc-validation, src/main/ipc/context, src/main/usage, src/shared/taskflow, src/shared/types
src/main/ipc/updates -> src/main/ipc/context, src/shared/contracts
src/main/issue-store -> src/shared/taskflow, src/shared/types
src/main/mcp-store -> src/main/skills, src/shared/extensions
src/main/meeting-controller -> src/main/agent-sessions, src/main/delegate(type), src/main/meeting-store, src/main/task-service(type), src/shared/meeting
src/main/meeting-store -> src/shared/meeting
src/main/permission-broker -> src/shared/contracts
src/main/plugin-cli -> src/main/backends/cli-common, src/main/backends/cli-locator, src/shared/extensions
src/main/plugin-inventory -> src/main/config-editor, src/main/sources, src/shared/extensions
src/main/presets -> src/shared/types
src/main/retention -> src/main/event-log, src/main/issue-store, src/main/store, src/main/task-service, src/shared/types
src/main/retry-policy -> src/shared/types
src/main/runner -> src/main/backends/dsh, src/main/backends/types, src/main/delegate, src/main/executor, src/main/failure, src/main/git, src/main/permission-broker, src/main/retry-policy, src/main/scheduler, src/main/store, src/main/task-finalizer, src/main/turn-lifecycle, src/shared/taskflow, src/shared/types
src/main/runtime -> src/main/backends/types, src/shared/types
src/main/scheduler -> src/shared/types
src/main/settings -> src/shared/types
src/main/sidecar -> (none)
src/main/sidecar-runtime -> src/main/backends/{claude,codex,dsh,opencode,types,zcode}, src/main/goal-controller, src/main/goal-store, src/main/issue-store, src/main/runner, src/main/store, src/main/task-service, src/shared/types
src/main/sidecar-server -> src/main/event-log, src/main/sidecar, src/main/sidecar-runtime, src/main/sidecar/protocol, src/shared/types
src/main/sidecar/index -> src/main/sidecar, src/main/sidecar-runtime, src/main/sidecar-server, src/main/sidecar/protocol
src/main/sidecar/manager -> src/main/sidecar
src/main/sidecar/protocol -> src/main/sidecar
src/main/sidecar/server -> src/main/sidecar-server
src/main/skill-targets -> src/main/skills, src/shared/skills
src/main/skills -> src/shared/skills
src/main/sources -> src/main/config-editor, src/main/skills, src/shared/extensions
src/main/store -> src/main/event-log, src/shared/types
src/main/task-finalizer -> src/main/git, src/main/store, src/main/usage, src/shared/taskflow, src/shared/types
src/main/task-service -> src/main/issue-store, src/main/store, src/shared/types
src/main/turn-lifecycle -> src/main/backends/types, src/shared/taskflow, src/shared/types
src/main/usage -> src/shared/types
```

---

## 3. 清理清单

### 3.1 根目录八项核查

核查方法：`git ls-files`（跟踪状态）× 主检出磁盘（`D:\agentdeck`，本快照不含这些未跟踪内容）× 全仓 `git grep` 引用扫描。

| 对象 | git 跟踪 | 磁盘状态（主检出） | 仓库内引用点 | 建议 | 理由 |
| --- | --- | --- | --- | --- | --- |
| `gui-forge-test/` | 0 个文件（未跟踪、未忽略） | 存在，**空目录**（4KB，无内容） | 仅 `CHANGELOG.md` 历史条目提及 | **删** | 空目录无任何内容与代码引用；实验脉络已由 CHANGELOG 留痕 |
| `teardown/` | 0 个文件；其中 `teardown/repos/` 被 `.gitignore:29` 显式忽略 | 存在，1.2GB，内容仅 `repos/`（竞品学习用 git clone） | `.gitignore` 注释指向 `docs/LOOP-ENGINEERING.md`；配套笔记在被跟踪的 `docs/teardown/*.md` | **留**（或把 `repos/` 移到仓库外的学习目录） | clone 是本地学习资料，已正确忽略，不影响仓库；真正有价值的拆解结论已入库（`docs/teardown/` 7 篇）。若追求目录清爽，移出仓库根即可，不必删 |
| `agentdeck-task-branches-backup.bundle` | 0 个文件；被 `.gitignore:32` 显式忽略 | 存在，1.4MB git bundle | 仅 `.gitignore` | **移入 backups/**（仓库外统一备份目录） | 分支历史备份，与代码库无关；集中到仓库外 `backups/` 后可从 .gitignore 移除该行（后续轮次再做） |
| `agentdeck-worktree-backups/` | 0 个文件；被 `.gitignore:33` 忽略 | 存在，12MB，约 87 项 | 仅 `.gitignore` | **移入 backups/** 或留 | worktree 快照备份，性质同上 |
| `.sessions/` | 0 个文件；被 `.gitignore:18` 忽略 | 存在，140KB | 无（注意：`src/main/backends/dsh-acp.ts:73` 的 `'./.sessions'` 是 dsh headless 模式在**其运行 cwd** 的持久化根默认值，与仓库根此目录同名不同物） | **留** | 应用本地会话数据，运行时产物 |
| `.agentdeck-worktrees/` | 0 个文件；被 `.gitignore:38` 忽略 | 存在，16MB | `.gitignore` 注释："worktrees are registered per-machine" | **留** | 工具（本 agent 会话）的 worktree 停放区，**当前会话就运行在其中**，绝不可动 |
| `docs/teardown/` | **7 个文件已跟踪**（CC/DEER-FLOW/LEARN-CLAUDE-CODE/MULTI-AGENT-MEETING/OPENCODE/OUROBOROS/RUFLO 拆解笔记） | 与仓库一致 | `.gitignore:29` 注释经 `docs/LOOP-ENGINEERING.md` 关联 | **留** | 竞品拆解知识资产，是后续知识图谱/设计的原始素材 |
| `docs/reports/` | **6 个文件已跟踪**（ANALYSIS/ARCHITECTURE-REVIEW/CONCURRENCY-HOTFIX/MULTICA-PROMPTS/MULTICA-TEARDOWN/ZCODE-UI-STUDY） | 与仓库一致 | 被 `README.md`、`docs/CONSTRUCTION-PLAN.md`、`docs/HOT-UPDATE-COMPARISON.md`、`docs/LOOP-ENGINEERING.md`、`docs/ORCHESTRATION-GOAL-CONSTRUCTION.md` 引用；`scripts/stress-codex.mjs` 又被 `docs/reports/CONCURRENCY-HOTFIX-REPORT.md` 引用 | **留** | 架构评审与热修报告，被多条文档交叉引用，删除会断链 |

小结：八项中**无一被 git 跟踪于根目录堆放**（根目录的六项全部未跟踪且基本已忽略，两项 docs 已跟踪且被引用）。真正能"清爽"的动作只有：删空目录 `gui-forge-test/`、把两个备份对象移到仓库外 `backups/`——均属后续轮次（本轮只读）。

### 3.2 scripts/ 与 package.json 对齐（65 个 .mjs + fixtures/）

package.json：61 条直连脚本 + 4 条聚合（`smoke:stage6`、`smoke:stage7`、`smoke:stage8`、`smoke:all`）。57 个 `smoke-*.mjs` 中 56 个已挂 npm script，8 个非 smoke 工具脚本全部挂载或被调用。

**孤儿脚本（package.json、其他脚本、文档三处均无引用）——3 个：**

| 脚本 | 性质 | 建议 |
| --- | --- | --- |
| `scripts/cdp-walk.mjs` | CDP 调试走查脚本 | 移入 `scripts/archive/`（或删）；先和作者确认非在用调试工具 |
| `scripts/make-icon.mjs` | 图标生成一次性工具（产物已在 `build/`） | 保留价值低，移入 `scripts/archive/` |
| `scripts/smoke-queue-recovery.mjs` | smoke 脚本（内含 esbuild 构建 src/main），但**没挂任何 npm script**，疑为遗漏 | 建议挂回 `package.json`（如 `smoke:queue-recovery`）或明确废弃移除——需要人拍板 |

**非孤儿但未挂 npm script 的 2 个：**

| 脚本 | 被谁引用 | 建议 |
| --- | --- | --- |
| `scripts/gen-hot-key.mjs` | `scripts/ship.mjs`（发布链内调用，生成热更密钥对） | 留（发布工具链一部分） |
| `scripts/stress-codex.mjs` | `docs/reports/CONCURRENCY-HOTFIX-REPORT.md`（并发热修的复现压测） | 留（报告的可复现附件），或随报告归档 |

**未纳入 `smoke:all` 全量串的直连脚本（非孤儿，按设计单独跑）：** `smoke:zcode`、`smoke:cli-adapters`（别名 `smoke:clis`）、`smoke:opencode-real`、`smoke:opencode-cli-real`、`smoke:dsh-acp-real`（以上多为依赖本机真实 CLI 安装的 `-real` 类）、`smoke:markdown`、`smoke:hot-pointer`、`smoke:hot-payload`、`smoke:hot-shell`（热更专项，`smoke:stage8` 只取 sidecar+build）。

**npm 名与文件名不一致的映射（知识图谱建边时注意）：** `smoke`→`smoke-runner.mjs`、`smoke:clis`→`smoke-cli-adapters.mjs`、`smoke:worktrees`→`smoke-worktree-lifecycle.mjs`、`e2e:delegate`→`e2e-delegate-real.mjs`、`release:hot`→`release-hot.mjs`、`deploy:hot`→`deploy-feed.mjs`。

**脚本与 src 的另一条边（esbuild 直连）**：约 40 个 smoke 脚本用 esbuild 把 `src/**` 单文件打成 CJS 直接调用导出函数（如 `smoke-goal-guards.mjs` → `src/main/goal-controller.ts`），因此**大量 export 是测试面契约，不是死代码**——详见 §4。

---

## 4. 死代码候选

判定方法：全量解析 `src/**` 的导出符号，交叉扫描 (a) src 内其他文件的整词引用、(b) `scripts/*.mjs` 的引用（smoke 会 esbuild 直连消费）、(c) 符号在**定义文件内部**的使用（排除 export 行）、(d) 构建入口与运行时入口豁免。按置信度分三档：

### 4.A 高置信：完全死（导出后无任何调用方，连定义文件内部也不用）——11 个符号 + 3 个文件

| 位置 | 符号 | 性质 | 建议 |
| --- | --- | --- | --- |
| `src/main/git.ts:665` | `cleanupWorktree` | `= reclaimWorktree` 的旧名兼容别名 | 删（连先更新 CHANGELOG 口径） |
| `src/main/git.ts:666` | `pruneWorktree` | `= pruneWorktrees` 旧名别名 | 删 |
| `src/main/goal-controller.ts:44-48` | `computeGoalProgressKey` / `stableProgressKey` / `computeProgressKey` | 三个均为 `progressKeyForOutput` 的历史迭代别名 | 删 |
| `src/main/task-service.ts:279` | `TaskCreationService` | `= TaskService` 别名 | 删 |
| `src/main/event-log.ts:513` | `isDurableEvent` | 定义后从未被调用 | 删或补调用 |
| `src/main/hot/pointer.ts:36` | `channelDirName` | 定义后从未被调用 | 删 |
| `src/main/hot/shell.ts:33` | `shellDirs` | 定义后从未被调用（sweepOldShellDirs 另行拼路径） | 删 |
| `src/main/ipc-validation.ts:416` | `parseOptionalBoolean` | 定义后从未被调用 | 删 |
| `src/renderer/src/api.ts:26` | `useSidecar` | hook 定义后无组件消费（侧车 UI 尚未接） | 留待侧车 UI 接入，或删（接入时重写） |
| `src/main/sidecar/manager.ts` | 整文件 | 纯再导出垫片，无引用方、非构建入口 | 删（真身是 `src/main/sidecar.ts`） |
| `src/main/sidecar/server.ts` | 整文件 | 纯再导出垫片，无引用方、非构建入口 | 删（真身是 `src/main/sidecar-server.ts`） |
| `src/main/sidecar/index.ts` | 整文件 | 公共桶（注释称"为未来 RPC 拆分预留"），当前无引用方、非构建入口 | 二选一：删；或让 `ipc/context` 等改从桶导入使其成为唯一公共面（推荐后者，注释意图如此） |

### 4.B 中置信：冗余导出（仅定义文件内部使用，export 是无人消费的"准公共面"）

共约 150 个符号（src/main 顶层 92、子目录 31、renderer 17、shared 21——已剔除被 smoke 脚本消费的约 40 个"测试面"符号）。典型代表：

| 文件 | 代表符号（完整清单见附录 B） |
| --- | --- |
| `src/main/agent-forge.ts` | `ensureForgeSkill`、`buildDraftPrompt`、`parseDraftResponse` 等 8 个纯函数（内部被 draftAgent/improveAgent 组合） |
| `src/main/config-editor.ts` | `codexConfigFile`、`writeJsonWithBackup`、`readCodexMcpBlock`、`BACKUP_SUFFIX` 等 5 个 |
| `src/main/delegate.ts` | `ContinueCall`、`RoundNote`、`ReviewCall`、`DelegationContext`、`DelegationOutcome`（类型契约） |
| `src/main/meeting-controller.ts` | `parseStance`、`stripMeetingTags`、`parseObjections`、`parseEnvelope`（内部解析器） |
| `src/main/runner.ts` | `RunnerPorts`、`TaskCreator`、`ConsultHandler` 等 7 个类型 |
| `src/main/turn-lifecycle.ts` | `EventGateState`、`TurnHandle` 等 5 个类型 |
| `src/main/backends/*`、`src/main/hot/*` | 主要是类型/选项契约导出 |
| `src/shared/*` | `Theme`、`TaskEventKind`、`IpcResult` 等 21 个类型（**契约文档面，建议保留**） |

处置建议：**不要批量删**。其中类型导出是"契约即文档"；函数/常量类可按文件顺手降级为模块私有（去 `export`），无行为风险（typecheck 即可验证）。优先级低于 §4.A。

### 4.C 已排除的误报（smoke 测试面，勿当死代码）

以下符号在 src 内无消费方，但被 `scripts/*.mjs` esbuild 直连调用，属于**被测试固化的公共 API**：`DEFAULT_BLOCK_CAP`/`DOOM_LOOP_THRESHOLD`/`MAX_PHASE_EXECUTIONS`/`detectDoomLoop`/`explainGoalBudget`/`progressKeyForOutput`（smoke-goal-guards）、`TASK_INDEX_SCHEMA_VERSION`/`migrateTaskIndex`（smoke-migration）、`migrateTaskEvent`/`UnsupportedTaskEventVersionError`（smoke-event-log）、`FILE_DIFF_MAX_CHARS`/`normalizeRepoFilePath`（smoke-file-diff）、`createZipStore`（release-hot + smoke-hot-shell）、`TRUST_KEYS`（gen-hot-key）、BoardView 日期函数族（smoke-board-retention）、`parseConsults`/`parseInvestigates`/`parseReviews`/`parseRoundNotes`/`strip*`（smoke-delegate/round/meeting-*）、`buildTurns`（smoke-turn-model）、`canRetry`/`taskStatusToRunStatus`（smoke-taskflow）、`sweepExpiredIssues`（smoke-board-retention）、`setWorktreeManualKeep`/`worktreeAvailability`（smoke-worktree-lifecycle）、`countEditLines`（smoke-edit-meta）、`parseDiff`（smoke-diff）。

---

## 5. 知识图谱生成素材约定

本文档可直接机械转换为图，建议节点/边类型：

- **节点**：`file`（本文所有表格行，id 用仓库相对路径）；`symbol`（表格"关键导出"列，id 形如 `src/main/runner.ts#TaskRunner`）；`ipc-domain`（§1.2 的 20 个域）；`npm-script`（§3.2 的 65 个脚本）；`doc`（docs/ 32 篇 md）。
- **边**：
  - `file --imports--> file`（§2.7 全量邻接表，一行一边；`(type)` 标注可作边属性 `kind: type-only`）；
  - `file --exports--> symbol`（§1.1 各表"关键导出"列）；
  - `ipc-domain --handled-by--> file`（§1.2 末列）；`ipc-domain --exposed-by--> src/preload/index.ts`；
  - `npm-script --runs--> file(scripts/)`（§3.2，注意 4 条改名映射）；
  - `file(scripts/) --bundles--> file(src)`（§3.2 末段的 esbuild 直连边，这是区分死代码与测试面的关键边）；
  - `file --spawns--> src/main/sidecar-server.ts`（进程边：`src/main/sidecar.ts` 运行时 spawn 编译产物）；
  - `cycle-member` 标记（§2.6 的 2 个环）。
- **特殊节点**：`src/main/bootstrap.ts` 与 `src/main/index.ts` 是"入口"节点（index 无静态入边是动态 require 所致）；`out/main/sidecar-server.js` 是 `src/main/sidecar-server.ts` 的构建产物入口。

## 附录 A：smoke 脚本 → src 直连清单（esbuild entryPoints）

`smoke-automation`→`automation-store`；`smoke-cli-errors`→`backends/cli-common`；`smoke-continue`→`sidecar-runtime`；`smoke-diff`→`renderer/DiffView`；`smoke-dsh-acp(-real)`→`backends/dsh-acp`；`smoke-dsh-budget`→`runner`+`store`；`smoke-edit-meta`→`backends/edit-meta`；`smoke-event-log`→`store`+`event-log`；`smoke-execution-services`→`executor`+`retry-policy`；`smoke-extensions`→`src/main`（多文件）；`smoke-failure`→`failure`+`runner`+`store`；`smoke-file-diff`→`git`；`smoke-final-dedup`/`smoke-resume`/`smoke-zcode(-protocol)`→`backends/zcode`；`smoke-flow`/`smoke-retry`/`smoke-model`/`smoke-lifecycle`/`smoke-queue-recovery`→`runner` 族（模板化多文件）；`smoke-git-errors`/`smoke-worktree-lifecycle`→`git`；`smoke-goal(-guards)`→`goal-controller`+`goal-store`(+`ipc-validation`)；`smoke-hot-*`→`hot/canonical`(+`hot/zip`)；`smoke-ipc-validation`→`ipc-validation`；`smoke-issues`→`issue-store`；`smoke-markdown`→`renderer/Markdown`；`smoke-migration`→`store`；`smoke-opencode-server`→`backends/opencode-server`；`smoke-opencode(-real|-cli-real)`→`backends/opencode`；`smoke-permission`→`permission-broker`；`smoke-pet-behavior`→`shared/pet`；`smoke-pet-life`→`shared/pet-life`；`smoke-pet-store`→`pet/pet-store`+`pet/packs`；`smoke-pet-brain`→`pet/pet-brain`+`pet/pet-llm`+`shared/pet-lines`；`smoke-pet-pack`→`shared/pet`+`pet/packs`（直连反校验 `scripts/pet-pack.mjs` 产物）；`smoke-retitle-cap`→`runner`+`store`；`smoke-round`→`delegate`；`smoke-runner`→`runner`+`store`；`smoke-runtime-analytics`→`analytics`+`runtime`；`smoke-sidecar`→`sidecar-server`+`sidecar`；`smoke-skills`→`skills`+`skill-targets`；`smoke-taskflow`→`shared/taskflow`；`smoke-turn-lifecycle`→`turn-lifecycle`；`smoke-turn-model`→`renderer/hooks/turnModel`+`eventMerge`；`e2e-delegate-real`→`src/main`（端到端）。

## 附录 B：§4.B 冗余导出完整清单（每文件一行）

```text
src/main/agent-forge: ensureForgeSkill resolveForgeSkillBody buildDraftPrompt buildImprovePrompt parseDraftResponse parseImproveResponse buildEvaluatePrompt parseEvaluateResponse
src/main/agent-sessions(type): OfficeFollowUpResult OfficeDeliveryResult OfficeRunner AgentSessionRegistryOptions
src/main/agents: normalizeAgent normalizeAgents dedupeAgentNames
src/main/backends/cli-common(type): JsonPrimitive CliJsonlRunner
src/main/backends/dsh-acp(type): DshAcpBin DshAcpSessionOptions
src/main/backends/dsh: findDshBin
src/main/backends/edit-meta: EDIT_FIELD_LIMIT（countEditLines 被 smoke 消费，见 §4.C）
src/main/backends/opencode-server: validateOpencodeVersion (type)OpencodeServerClientOptions (type)OpencodeServerBackendOptions
src/main/backends/opencode(type): OpencodeBackendOptions
src/main/config-editor: codexConfigFile writeJsonWithBackup mcpJsonState readCodexMcpBlock BACKUP_SUFFIX (type)ZcodeMarketplaceMeta
src/main/delegate(type): ContinueCall RoundNote ReviewCall DelegationContext DelegationOutcome
src/main/event-log: ReplayDivergence(type) ReplayResult(type)（migrateTaskEvent/UnsupportedTaskEventVersionError 被 smoke 消费）
src/main/git(type): GitCommandResult WorktreeCreateResult WorktreeCleanupResult WorktreePruneResult
src/main/goal-controller: AMBIGUITY_THRESHOLD computeGoalProgressKey stableProgressKey computeProgressKey (type)GoalToolCall (type)GoalBudgetExplanation (type)GoalTaskInput (type)GoalAcceptanceVerifier (type)GoalControllerOptions (type)GoalDecision
src/main/goal-store: GOAL_INDEX_SCHEMA_VERSION (type)GoalIndexDocument (type)GoalCheckpointRecord
src/main/hook-store: hooksDir
src/main/hot/feed: FeedError (type)FetchedManifest (type)DownloadProgress
src/main/hot/pointer: channelDirName
src/main/hot/resolve(type): HotPayloadInfo HotResolution ResolveHotOptions
src/main/hot/shell: shellDirs listAgedFiles stagingDirFor (type)ShellDirs
src/main/hot/verifier: ed25519PublicKeyFromRawHex (type)HotManifestArtifact (type)HotManifestFile (type)ManifestVerdict
src/main/hot/zip(type): ZipEntryInput ExtractedEntry
src/main/ipc-validation: parseOptionalBoolean (type)AutomationCreateInput (type)AutomationUpdateInput
src/main/issue-store: priorityForIssue
src/main/mcp-store: mcpDir
src/main/meeting-controller: parseStance stripMeetingTags parseObjections parseEnvelope (type)MeetingControllerOptions (type)MeetingResult
src/main/meeting-store: MEETING_INDEX_SCHEMA_VERSION
src/main/permission-broker(type): WorkVersion
src/main/presets: normalizePreset normalizePresets
src/main/retention(type): RetentionDeps RetentionReport（sweepExpiredIssues 被 smoke 消费）
src/main/retry-policy(type): RetryDecision
src/main/runner: MAX_CONSULT_ROUNDS (type)ContinueHandler (type)ConsultHandler (type)InvestigateHandler (type)ChildTaskCreator (type)TaskCreationRequest (type)TaskCreator (type)RunnerPorts
src/main/scheduler(type): SchedulerLimits
src/main/sidecar-server(type): SidecarServer
src/main/skills: SKILL_NAME_PATTERN
src/main/sources: sourcesDir (type)MarketplaceAssetInfo
src/main/store: migrateTaskRecord (type)TaskIndexDocument
src/main/task-service(type): TaskAgentRef ChildTaskCreateInput HandoffTaskCreateInput TaskServiceOptions
src/main/turn-lifecycle(type): EventGateState EventGateToken EventGateAcceptOptions TurnLifecycleOptions TurnHandle
src/renderer/src/api: useSidecar（已列 §4.A）
src/renderer/src/components/BoardView: boardDayKey relativeBoardTime BOARD_EMPTY_DAY_HINT (type)BoardNode（其余日期函数被 smoke 消费）
src/renderer/src/components/goal/GoalCreateDialog(type): GoalPrefill
src/renderer/src/components/goal/GoalPanel: goalActions
src/renderer/src/components/Markdown: DelegateCard
src/renderer/src/components/task/WorkerPane(type): WorkerPaneProps
src/renderer/src/hooks/turnModel: cleanUsage (type)TurnItem（buildTurns 被 smoke 消费）
src/renderer/src/ui/CodeViewer: parseUnifiedDiff (type)CodeViewerProps
src/renderer/src/ui/SideDock: closeDockItem (type)DockFileDiff (type)DockItem
src/renderer/src/ui/Toasts(type): ToastKind
src/shared/contracts(type): IpcResult UpdatePhase
src/shared/extensions(type): HookEntry DiscoveredKind
src/shared/meeting: TERMINAL_MEETING_STATUSES (type)MeetingCurrentTurn
src/shared/taskflow: canTransitionGoal TERMINAL_TASK_STATUSES TERMINAL_GOAL_STATUSES（canRetry/taskStatusToRunStatus 被 smoke 消费）
src/shared/types: taskEventType TASK_EVENT_KINDS TASK_EVENT_MANIFEST (type)AcceptanceCriterionStatus (type)GoalPatchAction (type)IssueAssignee (type)RuntimeHealth (type)TaskEventKind (type)TaskEventDurability (type)TaskEventDurableMetadata (type)TaskEventAggregateMetadata (type)Theme
```

---

*盘点方法备注：import 图/循环依赖/导出符号/死代码均由一次性脚本静态解析（相对 import 正则 + Tarjan SCC + 符号整词交叉扫描），未运行任何会改动文件的命令；清理对象的磁盘状态取自主检出只读 `ls`/`du`/`git check-ignore`。*
