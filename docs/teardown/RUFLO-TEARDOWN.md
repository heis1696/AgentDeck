# RUFLO 拆解报告（ruflo / claude-flow v3.38.23）

> 拆解时间：2026-09-09。拆解对象：`D:\agentdeck\teardown\repos\ruflo`（GitHub ruvnet/ruflo，72k 星，前身 claude-flow）。
> 方法：直接通读源码（重点 v3 monorepo 与 Rust crates），排除 node_modules 与构建产物。所有结论均给出 `路径:行号` 引用；引文为仓库当前 checkout 的原文。

---

## 1. 一句话定位与总体架构

**一句话定位**：ruflo 是一个"Claude Code / Codex 的外围神经系统"——它不替代任何 agent CLI，而是通过 **MCP 工具服务器（314 个工具）+ Claude Code hooks + 插件市场（40+ 插件）+ 共享记忆数据库**，把单个编码 Agent 升级为带记忆、带后台循环、带跨机联邦的群协系统。README 自述为 "agent meta-harness"（`README.md:40`），即"包裹 harness 的 harness"。

### 1.1 顶层目录与真实入口

```
ruflo/（npm 包名 claude-flow，bin: bin/cli.js）
├── bin/cli.js                 # CLI 入口 → v3/@claude-flow/cli
├── v3/                        # 真正的代码主体（pnpm monorepo "Claude Flow V3"）
│   ├── @claude-flow/          # 25 个工作区包：cli, cli-core, mcp, swarm, memory,
│   │                          #   codex, providers, agents, hooks, neural, security…
│   ├── crates/                # 3 个 Rust crate（见 1.3）
│   ├── src/                   # 20 个文件的 DDD 骨架（v3 重构未完成的残迹）
│   ├── docs/adr/              # 177 份 ADR（ADR-001 … ADR-384）
│   └── goal_ui/               # 目标追踪 Web UI（React，独立子项目）
├── plugins/                   # 40+ 个 Claude Code 插件（ruflo-core/swarm/goals/…）
├── plugin/                    # 单独发布的 "claude-flow" 插件（hooks.json 等）
├── .claude-plugin/            # 插件市场清单 marketplace.json
├── agentdb.rvf                # 自研记忆数据库文件（162 字节，几乎为空壳）
├── data/clone-data.*.json     # "克隆数证明"徽章的源数据
└── services/cognitum-analytics/ # 遥测分析服务
```

关键事实：**仓库根的 `Cargo.toml` 不是真正的 Rust workspace 核心**，其注释自陈它只为让 repo-scorecard 分析器看到 Rust 组件而存在（`Cargo.toml:6-9`："this workspace manifest exists so the repo-scorecard analyzer sees ruflo's Rust components"）。ruflo 主体是 TypeScript；Rust 只出现在边缘能力上。

### 1.2 TS 主体分工（v3/@claude-flow/*）

| 包 | 职责 | 关键文件 |
|---|---|---|
| `cli` | 主 CLI（60+ 命令）、MCP 服务器、hooks 运行时、autopilot、daemon | `cli/src/commands/*.ts`、`cli/src/mcp-server.ts`（1031 行） |
| `mcp` | MCP 协议实现（stdio） | `cli/src/mcp-tools/*.ts`（40+ 工具组文件） |
| `swarm` | 进程内群协模拟层：拓扑/消息总线/共识/任务编排/Queen | `swarm/src/types.ts`（546 行类型总纲） |
| `memory` | 记忆后端族：SQLite/AgentDB/RVF/Hybrid/Tiered + 检索管线 | `memory/src/types.ts:308`（IMemoryBackend） |
| `codex` | Codex 侧适配：双模编排器、worktree 协调器、harness 契约 | `codex/src/dual-mode/orchestrator.ts`（786 行） |
| `providers` | LLM provider 抽象（Anthropic/OpenAI/Google/Cohere/Ollama/RuVector） | `providers/src/types.ts:305`（ILLMProvider） |
| `neural`/`embeddings` | 嵌入、神经路由、SONA 自适应 | `cli/src/ruvector/*` |
| `security`/`aidefence` | 策略评估、安全守卫 | `cli/src/commands/policy.ts` |

Rust 核心 vs TS 插件层的分工：**TS 是全部业务与编排逻辑；Rust 只承担三件"数学/网络密集"的事**（水印、QUIC 联邦、授权判定）；插件层（plugins/）则完全是 markdown 资产（commands/skills/agents 定义 + 冒烟脚本），不含编译代码，通过 Claude Code 插件机制加载。

### 1.3 Rust crates 一览（v3/crates/）

| crate | 干什么 | 为什么用 Rust |
|---|---|---|
| `ruflo-federation-peer` | 跨机联邦：QUIC 传输（midstreamer-quic）+ AIMDS 三门安检（检测/分析/响应），一个进程完成"联邦跳 + 内容扫描 + stdio 交接给本地 agent"（`src/lib.rs:1-14`） | 异步网络 + 高吞吐内容扫描；`#![deny(unsafe_code)]`（lib.rs:33） |
| `ruflo-watermark` | LLM 文本水印：SynthID-Text 锦标赛采样 + Aaronson Gumbel 指数最小规则，可编译到 WASM（`src/lib.rs:1-30`） | 逐 token 的 PRF/贝叶斯检测是热循环；WASM 边界 |
| `ruflo-agntcy` | AGNTCY/Outshift 运行时集成：CASA 意图授权信封的**纯函数 deny-by-default 执法** + SLIM 传输（`src/lib.rs:1-15`） | 授权判定必须确定性、无 I/O、不可被模型说服（envelope.rs:15-16） |

### 1.4 agentdb（.rvf）是什么、为什么自研

`.rvf` 是 ruflo 的**单文件记忆/向量混合存储格式**。TS 参考实现 `RvfBackend`（`v3/@claude-flow/memory/src/rvf-backend.ts:213`）定义了格式：

```
[4B magic "RVF\0"][4B headerLen LE][header JSON][entryLen LE][entry JSON]…
```

- header 携带 dimensions/metric/quantization/entryCount/时间戳（`rvf-backend.ts:194-203,643-672`）；
- 写入用 tmp + rename 原子替换，崩溃安全（`rvf-backend.ts:674-677`）；
- 脏标记 + 30 秒自动落盘（`rvf-backend.ts:211,260-265`）；
- 原生路径尝试动态加载 `@ruvector/rvf`，失败则退回纯 TS + 自带 HnswLite 索引（`rvf-backend.ts:249-257`）。

为什么自研：① 摆脱 sqlite/hnswlib 的原生模块编译脆弱性（npm optional deps 一堆 fallback 可证）；② **单文件=可整体 checkpoint/rollback**——autopilot 循环把 `.rvf` 当作可回滚的"记忆分支"（见 §5.2）；③ 向量+JSON 记录同文件，跨进程（CLI/worker/daemon）通过 `CLAUDE_FLOW_DB_PATH` 环境变量共享同一库（`dual-mode/orchestrator.ts:599,608-613`）。仓库根的 `agentdb.rvf` 只有 162 字节、magic 为 `SFVR`（原生 RuVector 变体格式），本质是格式演示而非真实数据——自研存储更多是**格式契约 + 可控性**，不是数据库引擎。

---

## 2. 多后端 harness 接入层（核心章节）

ruflo 对多 harness 的适配不是一个统一的接口，而是**三层各司其职**：CLI 进程执行层（dual-mode）、宿主注册层（HostRegistry）、仓库协作契约层（RepositoryHarnessAdapter）。

### 2.1 执行层：DualModeOrchestrator（claude | codex 双平台 worker）

`v3/@claude-flow/codex/src/dual-mode/orchestrator.ts:23-48` 定义 worker 模型：

```ts
export interface WorkerConfig {
  id: string;
  platform: 'claude' | 'codex';
  role: string;
  prompt: string;
  model?: string;
  maxTurns?: number;
  timeout?: number;
  dependsOn?: string[];
  /** Required for concurrent writing roles; each writer must own one cwd. */
  worktreePath?: string;
  readOnly?: boolean;
  capabilityEnvelope?: WorkerCapabilityEnvelope;
}
```

每个平台的非交互入口与旗标集在 `executeHeadless` 中硬编码分流（`orchestrator.ts:200-222`）：

```ts
// Claude Code:  claude -p <prompt> --output-format text [--max-turns N] [--model M]
// OpenAI Codex: codex exec --sandbox workspace-write --skip-git-repo-check [-m M] <prompt>
if (config.platform === 'claude') {
  args = ['-p', enhancedPrompt, '--output-format', 'text'];
  if (config.maxTurns) args.push('--max-turns', String(config.maxTurns));
  if (config.model) args.push('--model', config.model);
} else {
  args = ['exec', '--sandbox',
    config.readOnly ? 'read-only' : 'workspace-write',
    '--skip-git-repo-check'];
  if (config.model) args.push('-m', config.model);
  args.push(enhancedPrompt);   // codex 的 PROMPT 是位置参数，必须放最后
}
```

两个著名的进程管理"战伤"修复直接写在注释里：
- **stdin 必须关闭**（`orchestrator.ts:234-240`，issue #2947）：prompt 一律走 argv 不走 stdin，但管道保持打开时 `claude -p` 无感、`codex exec` 却会在 `resolve_root_prompt` 等 stdin EOF 而永久挂起——所以 spawn 后立刻 `proc.stdin?.end()`；
- **输出上限**：stdout/stderr 各截断到 `maxOutputBytes`（默认 1 MiB，`orchestrator.ts:244-250`），防单 worker 吃爆内存。

Windows 适配单独成文件：`resolveClaudeLaunchCommand`（`v3/@claude-flow/cli/src/runtime/claude-command.ts:25-69`）解决 npm 的 `claude.cmd`/`claude.ps1` shim 无法被 `spawn(shell:false)` 启动的问题——用 `where.exe` 枚举候选，优先 `.exe` 原生可执行，其次回退到 `node cli.js`，保证用户 prompt 永不进 shell。

### 2.2 宿主层：HostAdapter 注册表 + 分层冠军

`v3/@claude-flow/cli/src/services/harness-hosts.ts:17-46` 是一个刻意做小的宿主抽象：

```ts
export interface HostAdapter {
  id: string;    // 'claude-code' | 'codex'
  label: string;
  detect: () => boolean;   // 用 bin --version 探测
}
export function defaultHostRegistry(): HostRegistry {
  return new HostRegistry()
    .register({ id: 'claude-code', label: 'Claude Code', detect: () => commandExists('claude') })
    .register({ id: 'codex', label: 'OpenAI Codex', detect: () => commandExists('codex') });
}
```

它服务于 ADR-176 的"分层进化"：提示词/配置的最优变体按 `global → language → framework → repo` 四层分别基准测试，安装时取"最深可用祖先"的冠军（`harness-hosts.ts:63-96` 的 `LAYER_LEVELS` 与 `selectChampionForLayer`）。**能力协商在这里表现为"逐宿主验证冠军"**——`fanOutHosts` 让优化/验证/金丝雀流程在每个可用宿主上各跑一遍，而不是无验证地 `--host` 透传（`harness-hosts.ts:49-59`）。

### 2.3 契约层：RepositoryHarnessAdapter（能力协商最完整的样本）

`v3/@claude-flow/codex/src/harness/contract.ts:14-22,159-171` 是一套"咨询式（advisory）仓库 harness 契约"，用**能力枚举 + 渐进可选方法 + 特性检测**做协商：

```ts
export type HarnessCapability =
  | 'sessions' | 'leases' | 'lease-fencing' | 'messages'
  | 'message-acknowledgement' | 'run-evidence'
  | 'exact-source-state' | 'release-decisions';

export interface RepositoryHarnessAdapter {
  describe(): Promise<HarnessDescriptor | LegacyHarnessDescriptor>;
  start?(request: StartSessionRequest): Promise<HarnessSession>;
  acquire?(request: LeaseRequest): Promise<FencedLease>;
  renew?(lease: FencedLease): Promise<FencedLease>;
  release?(lease: FencedLease): Promise<void>;
  send?(message: HarnessMessage): Promise<MessageReceipt>;
  receive?(cursor?: string): AsyncIterable<HarnessMessage>;
  acknowledge?(messageId: string): Promise<void>;
  recordRun?(run: RunEvidence): Promise<RunReceipt>;
  authorizeRelease?(request: ReleaseRequest): Promise<ReleaseDecision>;
  end?(sessionId: string): Promise<void>;
}
```

设计要点：
- 所有方法除 `describe` 外均可选，**调用方必须逐操作特性检测**（contract.ts:154-158 注释）；旧 harness 描述符经 `normalizeHarnessDescriptor` 归一时**永远降级为 observe-only**，无法自我声明 enforce/release 权力（contract.ts:184-216）——能力不能靠自报，要靠外部验证的适配器；
- `FencedLease.epoch` 用十进制字符串跨 JSON 保 64 位精度（contract.ts:88-89）；`RunEvidence` 携带精确源状态、命令摘要、lease epochs，构成"运行回执"证据链（contract.ts:114-130）。

### 2.4 能力信封（capability envelope）与最小权限子进程

worker 子进程的权限收敛实现在 `orchestrator.ts:548-605`：父进程给出默认信封（无网络、非破坏、delegationDepth=0、带过期），子请求只能**单调收缩**——`resolveWorkerEnvelope` 做子集校验，`"worker capability envelope cannot expand"`（orchestrator.ts:585）；最终以环境变量注入子进程（`CLAUDE_FLOW_PRINCIPAL_ID`、`CLAUDE_FLOW_CAPABILITY_ENVELOPE`），同时**剥离一切名字匹配 KEY/SECRET/TOKEN/PASSWORD 的环境变量**（orchestrator.ts:589-598 的正则）。可选的 `policyPreflight` 会在 spawn 前调用 `ruflo policy evaluate` 做外部策略裁决（orchestrator.ts:520-546）。

### 2.5 MCP 作为跨宿主集成面

对 Claude Code 与 Codex，ruflo 的共同语言是 MCP 工具服务器（`claude mcp add ruflo -- npx ruflo mcp start`，`docs/ruflo-explained.md:161`）。`mcp-server.ts` 里两条防御值得抄录：
- **console 劫持**（`cli/src/mcp-server.ts:390-406`）：懒加载模块（transformers.js、ONNX 等）向 stdout 打印任何非 JSON 行都会让 Codex 关闭 MCP 传输——所以把 `console.log/info/debug` 永久改写为 stderr，JSON-RPC 帧走专用 `writeFrame()`；
- **阻塞写**（mcp-server.ts:408-430，issue #2426）：大于 64KB 管道缓冲的 JSON-RPC 帧被部分写会导致 Claude Code **静默丢弃全部 314 个工具**——`stdout._handle.setBlocking(true)`。

hive-mind 启动 Claude 实例时还有一个 `--mcp-config=path` 用 `=` 语法而非空格分隔的坑（变长参数会把后续 positional 吃成第二个配置文件，`cli/src/commands/hive-mind.ts:277-283`，issue #1780）。

---

## 3. 群协/编排模型

### 3.1 真实执行路径：提示协议 + MCP 工具箱（"皇后"就是一个 claude 会话）

`hive-mind spawn` 的实现揭示真相：它生成一份巨型提示词（`hive-mind.ts:67-179`），声明"你是 Queen coordinator"，列出可用的 `mcp__ruflo__*` 工具（consensus/memory/broadcast/task_assign/agent_spawn…），规定四阶段执行协议（初始化→任务分发→协调→完成），并强制"所有编排必须走 MCP 工具、不得用 Claude 原生 Task 工具"（hive-mind.ts:162-167）。然后**spawn 一个 claude CLI 进程**（`spawnClaudeCodeInstance`，hive-mind.ts:185-286），把提示词交给它。也就是说：**真正的多 Agent 编排者是 Claude Code 自身，ruflo 提供的是工具箱与协议文本**。worker 之间不直接通信，而是通过 `memory store/search` 共享内存间接协作（orchestrator.ts:287-295 的协作协议提示）。

### 3.2 进程内模拟层：拓扑 + 消息总线 + 任务 DAG + 共识

`@claude-flow/swarm` 包是一套进程内的群协原语（类型总纲 `swarm/src/types.ts`）：
- **拓扑**：`TopologyType = 'mesh' | 'hierarchical' | 'centralized' | 'hybrid'`（types.ts:33），`TopologyManager` 维护邻接表、角色索引、分区与领导者选举（`topology-manager.ts:17-150`）；
- **消息总线**：`MessageBus` 用 4 级环形缓冲双端队列实现 O(1) 优先级队列，目标 1000 msg/s（`message-bus.ts:1-5,145-215`）；消息带 `priority/ttlMs/requiresAck/correlationId`，队列满时 O(1) 淘汰最低优先级（message-bus.ts:343-363），ACK 失败重试（SWARM_CONSTANTS.MAX_RETRIES=3，types.ts:425-438）；
- **任务编排**：`TaskOrchestrator` 维护 `dependencyGraph`/`dependentGraph` 双向 DAG，创建时即计算 blocked 状态，事件总线驱动状态机（`coordination/task-orchestrator.ts:101-163`）；
- **Queen**：`QueenCoordinator` 做 TaskAnalysis（复杂度/子任务分解/ReasoningBank 模式匹配）→ DelegationPlan（主/备 agent、并行分派、ExecutionStrategy ∈ sequential/parallel/pipeline/fan-out-fan-in/hybrid，`queen-coordinator.ts:47-177`）；
- **共识**：类型上支持 raft/byzantine/gossip/paxos（types.ts:199），阈值默认 0.66（types.ts:433）。

### 3.3 判定：最接近什么模型

把三层拼起来看：
1. **真实进程间是 blackboard（黑板）模型**——Claude/Codex worker 各自独立运行，通过 `.rvf`/SQLite 共享内存读写（`npx ruflo memory store/search`），无直接消息传递；
2. **进程内是分层协调者 + 消息总线**（接近 actor 的寻址 + CSP 式的每 agent 队列），Queen/coordinator 角色构成 hierarchical 拓扑；
3. **DAG 分层调度**（`buildDependencyLevels` 拓扑分层 + `partitionLevel` 批内并发/写者上限分离，orchestrator.ts:392-472）是数据流模型的实用化。

一句话：**对外宣称 swarm/共识，落地是"黑板共享内存 + 分层 DAG 调度 + 提示协议"**。raft/byzantine 共识代码在真实 CLI 执行路径上基本未被调用——这是 ruflo 最值得警惕的"双重真相"。

### 3.4 并行写隔离：worktree 协调器

`CodexWorktreeCoordinator`（`v3/@claude-flow/codex/src/worktrees/coordinator.ts:34-142`）是并行 Agent 落地 git 的干净样本：每个写者一个 worktree + 分支 `ruflo/<runId>/<agentId>`，只读者 `--detach`；注册表记录到 `.claude-flow/swarm/worktrees/<runId>.json`，status() 校验路径不得逃逸 owned root（coordinator.ts:106-112）；integrate() 逐 agent `merge --no-ff`；拒绝从脏仓库准备写 worktree（coordinator.ts:62-64）；ID 白名单正则防注入（coordinator.ts:5）。配合 dual-mode 的"每层写者路径唯一"约束（orchestrator.ts:434-447），构成完整的"并行读、串行合并"策略。

---

## 4. 自适应记忆与状态

### 4.1 记忆模型与后端族

认知科学式分型（`v3/@claude-flow/memory/src/types.ts:15-20`）：

```ts
export type MemoryType =
  | 'episodic'    // 时间线经历
  | 'semantic'    // 事实/概念
  | 'procedural'  // how-to 技能
  | 'working'     // 短期操作记忆
  | 'cache';
```

`MemoryEntry`（types.ts:55-106）携带 embedding(Float32Array)、namespace、tags、accessLevel(private/team/swarm/public/system)、乐观锁 version、references、accessCount。统一后端接口 `IMemoryBackend`（types.ts:308-356）覆盖 store/get/query/search/bulkInsert/healthCheck 全家。实现族：`SQLiteBackend`、`sqljs-backend`、`AgentDBBackend`（agentdb@2/3 + hnswlib→ruvector→WASM 三级 fallback，`agentdb-backend.ts:48-62,139-143`）、`RvfBackend`（自研格式）、`HybridBackend`（SQLite 结构化 + AgentDB 向量联查，`hybrid-backend.ts`）、`TieredMemory`（working/长期分层）。

### 4.2 RAG 检索管线：SmartRetrieval（ADR-090）

`smart-retrieval.ts:1-17` 声明其来源是 LongMemEval 基准的五段式管线，全部无 LLM、可插拔（`SearchFn` 打到任何裸存储）：

1. 模板式查询扩展（不花模型钱）；
2. 多查询扇出 + Reciprocal Rank Fusion；
3. 基于时间戳的 recency 加权（半衰期默认 30 天，`smart-retrieval.ts:82-84`）；
4. MMR 多样性重排（token-Jaccard 或真余弦，λ=0.7）；
5. 跨 session 轮转保证多会话覆盖。

每段有独立开关与调参（`SmartSearchOptions`，smart-retrieval.ts:58-94），并返回逐段过滤统计（SmartSearchStats）。另有 ADR-377 的**检索层注入守卫**：`AgentDbRetrievalGuard` 按 `CLAUDE_FLOW_RETRIEVAL_GUARD` 启用，在结果返回前过滤（`agentdb-backend.ts:33-37,103-109`）。

### 4.3 学习闭环与断点恢复

- **学习存储**：`RvfLearningStore` 把 PatternRecord、LoRA 适配器记录、EWC 状态、轨迹（TrajectoryRecord）持久化到 .rvf（`rvf-learning-store.ts:109,164-245`）；autopilot 的 `learn/history/predict` 子命令分别暴露 discoverSuccessPatterns / recallSimilarTasks / predictNextAction（`cli/src/commands/autopilot.ts:297-405`）。
- **断点恢复（两层）**：
  1. **会话层**：hooks 的 SessionStart 事件恢复上下文（`plugin/hooks/hooks.json:148-159`），hive-mind 把提示词与状态落在 `.hive-mind/sessions/`（hive-mind.ts:228-234）；
  2. **记忆分支层**：`CheckpointGate`（`cli/src/services/checkpoint-gate.ts:105-143`）对 `.rvf` 做 checkpoint/rollback/promote——checkpoint 是 O(1) 固定成本，rollback 是 O(自检查点以来的编辑数) 而非全量重建（checkpoint-gate.ts:7-12 注释）。autopilot 在**每个冒险 tick 前 checkpoint、循环退化（stall）时自动 rollback**（见 §5.2），等于给"学习型记忆"装了 git。

---

## 5. 调度与循环控制（对照 Loop Engineering）

### 5.1 Loop 3（事件/定时驱动）：daemon + loop-workers + hooks

- **daemon**：`worker-daemon.ts`（2141 行）是常驻进程，tick 驱动；蒸馏服务用"每 namespace rowid 游标"增量推进，大积压分摊到多个 tick 而不阻塞（worker-daemon.ts:156-161）；AI worker（headless claude sweep）默认关闭，需显式开启（worker-daemon.ts:366）。
- **loop-workers 插件**：包装 5 个 `hooks_worker-*` MCP 工具（worker-list/dispatch/status/detect/cancel，`plugins/ruflo-loop-workers/docs/adrs/0001-loop-workers-contract.md:14`），暴露 **12 个后台触发器**：ultralearn/optimize/consolidate/predict/audit/map/preload/deepdive/document/refactor/benchmark/testgaps（CLI 实现 `swarm/src/workers/worker-dispatch.ts:613-629` 的 executors 分发表）。`/ruflo-schedule` 用 Claude Code 的 `CronCreate` 注册 cron（audit/testgaps 每 15 分钟，consolidate/document 每小时，`plugins/ruflo-loop-workers/commands/ruflo-schedule.md:12-16`）——**定时能力直接复用宿主（Claude Code）的 cron，不自建调度器**。
- **hooks**：Claude Code 全套事件（PreToolUse/PostToolUse/UserPromptSubmit/SessionStart/Stop/SubagentStop/Notification/PermissionRequest）经 stdin-jq-xargs 防注入管道转入 ruflo CLI（`plugin/hooks/hooks.json:3-70`）；路由 hook 在 UserPromptSubmit 上做任务→最优 agent 分派（hooks.json:135-147）。

### 5.2 Loop 2（目标循环与停止条件）：autopilot

`autopilotCheck()`（`cli/src/commands/autopilot.ts:53-135`）是教科书式的 Stop-hook 目标循环，返回 `{allowStop, reason, continueWith}` 三元组。停止条件全量化：

| 停止条件 | 位置 | 语义 |
|---|---|---|
| 手动禁用 | autopilot.ts:56-59 | enabled=false |
| 轮数上限 | autopilot.ts:61-66 | iterations ≥ maxIterations（1-1000 可配） |
| 时间上限 | autopilot.ts:68-75 | timeoutMinutes（1-1440） |
| 无任务 | autopilot.ts:78-80 | 任务源（issues/todos/files…）空 |
| 全部完成 | autopilot.ts:85-91 | 进度 100%，计算 reward 落日志 |
| **停滞检测** | autopilot.ts:94-105 | 最近 5 次历史完成数不变且总历史≥10 → auto-disable + **回滚 .rvf 到 tick 前检查点** |

不满足停止条件时，构造 `continueWith` 续跑提示（含进度百分比、剩余任务前 5 条、停滞警告）注入下一轮（autopilot.ts:124-134）；每个 tick 前先 `checkpointTick`（autopilot.ts:115）。事件日志 appendLog 落盘，`autopilot log` 可回放。另有一个纯 prompt 式 Stop hook 让模型自评 `{"decision":"stop"}`（hooks.json:161-171）——确定性检查与模型自评双轨并存。

### 5.3 Loop 4（自我改进）：metaharness + fable 裁判 + 分层进化

- **fable-harness**（`cli/src/services/fable-harness.ts`）：成本纪律化的 LLM-as-judge。文件头就是一份测量数据（fable-harness.ts:10-27）：从项目目录起 `claude -p` 会自动加载 CLAUDE.md 与 ~56k 缓存 token，**$1.56/次**；换干净空 cwd + `--append-system-prompt` 降到 **$0.34**；批处理 20 条/次摊薄到 **$0.02/条**。因此它：在临时空目录运行、角色走 append-system-prompt、批量判定、`--max-budget-usd` 硬顶、累计花费到预算即停、**默认关闭**（构造不花钱，isEnabled 需要 maxBudgetUsd>0）。判定结果带 provenance 标签 `judge:fable`，"永远不得当作 ground truth 呈现"（ADR-169）。`reflectFailures` 输出 failureClass/diagnosis/mutationHint，供 GEPA 反思式变异使用（fable-harness.ts:314-327）。
- **metaharness 插件**（`plugins/ruflo-metaharness/README.md`）：`harness-evolve` 变异七个策略面、沙箱计分、**只晋升实测赢的变体**；`harness-gepa` 跑 GEPA。架构约束是"可移除增强"：无静态 import、只进 optionalDependencies、所有脚本吞 MODULE_NOT_FOUND 并输出 `{degraded:true}` 退避 JSON、CI 用 `--no-optional` 跑冒烟门禁（README "ADR-150 architectural constraint" 一节）。
- **分层冠军进化**（ADR-176）：优化结果按 global→language→framework→repo 四层各留冠军，新安装取最深可用祖先（`harness-hosts.ts:63-96`），提示词优化天然按仓库分层沉淀。

### 5.4 goals（GOAP 目标规划）

`plugins/ruflo-goals/README.md`：GOAP 动作规划（前置条件分析 + 代价优化）、horizon 跨会话目标追踪（漂移检测）、deep-research 多源研究编排、dossier 递归并行扇出调查（预算帽 + 去重 + 逐声明溯源，ADR-099）。这是 agentdeck `goal-controller.ts` 的"重装版"对照物。

---

## 6. 与 agentdeck 的对照与可借鉴点（核心章节）

先摆事实：agentdeck 的 `AgentBackend`（`src/main/backends/types.ts:35-56`）已经是比 ruflo 更正统的后端抽象（probe/start/send/stop/close + onTurnEnd/onHeartbeat/onPermission 事件），且是 5 后端（claude/codex/opencode/zcode/dsh）对 ruflo 的 2 后端。ruflo 值得借鉴的不是"更全"，而是它在**循环控制、权限收敛、验证成本、状态安全**四个 agentdeck 相对薄弱方向上的工程化细节。

### 6.1 可直接借鉴的设计（逐条对应模块）

| # | ruflo 设计（引用） | agentdeck 对应模块 | 为什么值得搬 |
|---|---|---|---|
| 1 | **能力信封单调收缩**：子 Agent 请求权限只能是不父集即拒（`orchestrator.ts:561-587`），经 `CLAUDE_FLOW_CAPABILITY_ENVELOPE` 环境变量传递（orchestrator.ts:589-605），spawn 前可选外部策略裁决（orchestrator.ts:520-546） | `delegate.ts`（父子委派）+ `permission-broker.ts` | agentdeck 委派目前是"全权限继承"。给 delegate.ts 加一个 `CapabilityEnvelope {actions, tools, maxConcurrency, network, destructive, delegationDepth, expiresAt}`，序列化进子进程 env，子后端启动时校验"只减不增"，即可把 permission-broker 的人工审批结果编译成机器可执法的信封，审批粒度从"每次工具调用"升级为"每次委派" |
| 2 | **stall 检测 + 记忆回滚的停止条件**：5 轮窗口无进展告警、10 轮 auto-disable 并 rollback（`autopilot.ts:94-105`）；每 tick 前 checkpoint（autopilot.ts:115） | `goal-controller.ts` + `goal-store.ts` + `retry-policy.ts` | agentdeck 的停止条件（达成/轮数上限）缺"停滞"维度。补三件事：① goal-store 记 per-round progress 快照，连续 N 轮无进展即熔断并换策略（而不是傻等轮数上限）；② 每次 round notes 写入前对 goal-store/issue-store 做轻量快照（文件级 tmp+rename 即可）；③ 验证失败回退到最近快照，防止"越修越坏"的状态污染 |
| 3 | **批量 LLM-as-judge 的成本纪律**：空 cwd 避开 CLAUDE.md、批 20 条/次、预算硬顶、provenance 标签区分"裁判认为"与"证明"（`fable-harness.ts:10-31,43-54,346-355`） | `task-finalizer.ts` + `retry-policy.ts`（Loop 2 验证） | agentdeck 用小模型裁判时可直接套：判定请求打一个干净临时目录、角色 prompt 走 append-system-prompt、一次调用判定多个已完成任务、结果上打 `judge:<model>` 标签与置信度，`completed` 状态区分 `verified-mechanical` / `verified-judge`。**"完成是模型的主张，不是证明"在数据模型上落地** |
| 4 | **写者隔离 + DAG 分层调度**：拓扑分层（`orchestrator.ts:392-449`）、批内 maxConcurrent 与 maxWriters 分开（`partitionLevel`，orchestrator.ts:451-472）、每写者独占 worktree、层内写路径唯一 | `delegate.ts`（并行子 Agent） | agentdeck 并行委派多个写代码子 Agent 时同一 workdir 必然冲突。ruflo 的"读者无限并行、写者各占 worktree、合并时逐个 merge --no-ff"（`worktrees/coordinator.ts:47-126`）是现成方案，且注册表+路径逃逸校验（coordinator.ts:106-112）值得照抄 |
| 5 | **stdin/argv 的跨 CLI 战伤库**：codex exec 必须 `stdin.end()`（#2947）、prompt 永不走 stdin 防 shell 重分词（#1852，`fable-harness.ts:200-204`）、`--mcp-config=path` 用等号（#1780）、Windows shim 解析链（`claude-command.ts:25-69`）、stdout >64KB 需 setBlocking（#2426） | `backends/*` + `runner.ts` | 这些是 ruflo 用 issue 编号换来的教训，agentdeck 接 dsh/zcode 等新后端时应作为 checklist 逐条核对 |
| 6 | **宿主注册表 + 分层冠军**：`HostAdapter{id,label,detect}` 极简探测（`harness-hosts.ts:17-46`）+ global→repo 四层预设冠军选择（harness-hosts.ts:88-96） | `backends/types.ts` 的 probe + `presets.ts` | agentdeck 的 preset 目前是全局的。按"全局→语言→框架→仓库"分层沉淀验证过的运行配置（模型/effort/重试参数），每个 worktree 安装取最深可用层，形成"越用越准"的预设库 |
| 7 | **检索五段管线**（查询扩展/RRF/recency/MMR/session 轮转，全无 LLM、逐段开关，`smart-retrieval.ts:58-94`） | `event-log.ts` + 未来记忆层 | agentdeck 若给 issue-store/event-log 加语义检索（"上次类似失败怎么解决的"），这套管线可直接移植——特别是 recency 半衰期与 MMR 多样性，对"别总检索到同一条旧日志"很关键 |
| 8 | **可移除增强四规则**（无静态 import / optionalDependencies / degraded JSON / no-optional CI 门，metaharness README） | 任何未来可选增强（如 RAG、神经路由） | agentdeck 接入重依赖（嵌入模型、向量库）时应遵循同一契约：删掉包后应用照常启动，降级路径是默认行为而非异常分支 |

### 6.2 架构选择对 agentdeck 的启示

**是否引入 Rust 层？——不需要为编排引入，只为"确定性执法"保留可能性。** ruflo 自己的答案很有说服力：编排、循环、记忆全是 TS；Rust 只出现在(a)逐 token 水印数学、(b)QUIC 联邦网络栈、(c)CASA 授权的**纯函数 deny-by-default 执法**（`agntcy/src/envelope.rs:96` 起：过期→deny 优先→allow 白名单，三道门全是确定性代码，注释明言"enforcement 必须永不在调用时问模型"）。agentdeck 是 Electron 桌面应用，Node 层完全够用；唯一值得考虑的 Rust/WASM 场景是把 permission-broker 的规则引擎做成纯函数（输入：信封+动作，输出：决定），保证审批逻辑可单测、可形式化、不受模型输出影响。

**是否自研存储？——格式自研有价值，引擎自研没有。** ruflo 的 .rvf 本质是"magic+header+定长前缀记录"的单文件格式加原子 rename，换来的是(a)免原生模块编译、(b)单文件可整体快照/回滚。agentdeck 的 issue-store/goal-store/event-log 已经是文件型状态脊柱，只需补两点：**所有写入走 tmp+rename 原子替换**（ruflo `rvf-backend.ts:674-677`），以及**单写者锁**（ruflo 用 `agentdb.rvf.lock` 伴生文件）。不需要自研向量库——若要语义检索，按 ruflo 的依赖降级链（原生→WASM→纯 TS 暴力）处理即可。

**MCP-vs-库的集成面。** ruflo 把全部能力暴露为 314 个 MCP 工具，换来"任何 MCP 宿主都能用"，代价是工具爆炸（README 自己都写"你不需要学 314 个工具"）。agentdeck 作为桌面工作台用进程内库调用（backends/*）是更优解：类型安全、无 stdio 帧脆弱性（对照 §2.5 的两条防御）、权限可精确执法。

### 6.3 agentdeck 的差异化定位

1. **真实 vs 模拟**：ruflo 的进程内 swarm/共识层与真实执行路径脱节（§3.3）；agentdeck 的 delegate/runner 是每一步都真实执行 DAG，应保持"只实现会真跑的编排原语"的克制。
2. **人机带宽优先**：ruflo 走"无人化群协"叙事（hive-mind、100 agents），agentdeck 反向定位"人的审查带宽是瓶颈"（LOOP-ENGINEERING.md 的 comprehension debt 风险）——permission-broker + round notes + 桌面可视化正是把 comprehension debt 控制住的工具。
3. **Loop 4 的正确起点**：ruflo 的 Loop 4（metaharness/fable）最可取的是**成本纪律与 provenance 纪律**，不是进化算法本身。agentdeck 补 Loop 4 时应先做"trace 记录 + 批量裁判 + 分层预设冠军"（§6.1 #3/#6），变异/进化最后做。

---

## 7. 结论：架构评价与风险

**评价**。ruflo 是一份罕见的"循环工程全谱系实现目录"：Loop 1（dual-mode 执行）、Loop 2（autopilot 停止条件 + fable 裁判）、Loop 3（daemon/cron/hooks）、Loop 4（metaharness 进化）全部有落地代码，且 177 份 ADR 把每个决策的动机写得异常诚实（连"Cargo.toml 只为 scorecard 存在"都注明）。它的最佳资产是**细节工程**：stdin/argv 战伤、原子写、能力信封、检查点回滚、成本测量驱动的裁判设计。

**风险与警示**：
1. **双重真相**：宣称的 swarm/raft/byzantine 共识（`swarm/src/consensus/`）在真实 CLI 执行路径上基本未接线；真实编排是"一个大 prompt 教 claude 用 MCP 工具"。借鉴时要分清哪层是真跑的。
2. **面积失控**：5647 文件、25 个 workspace、40+ 插件、177 ADR，大量 alpha 版包（package.json 里 alpha 版本串成链）；同一能力常有 3-4 个平行实现（memory 后端 6 种、编排器至少 3 套）。维护带宽存疑。
3. **平台偏科**：hooks.json 自我标注"POSIX-only，native Windows 已知损坏且未修"（`plugin/hooks/hooks.json` 的 `_platform_note`）——对同为桌面编排、必须赢 Windows 的 agentdeck 是反面提醒。
4. **可信度运营**：仓库内放 clone 数 ledger/proof（`data/clone-data.*.json`）为星数背书，说明其影响力叙事本身被审视过；拆解取用时以代码为准、以 README 为线索。

**对 agentdeck 的一句话总结**：ruflo 证明了"外围 harness + 共享状态文件 + 确定性停止条件"这条路能走多远；agentdeck 应取其"执法纯函数化、状态原子化、验证批量化、预设分层化"四件兵器，避开其"面积失控与模拟层幻觉"两个坑。

---

### 附：本报告深读的核心源码文件（26 个）

`v3/@claude-flow/codex/src/harness/contract.ts`、`codex/src/dual-mode/orchestrator.ts`、`codex/src/worktrees/coordinator.ts`、`cli/src/runtime/claude-command.ts`、`cli/src/runtime/headless.ts`、`cli/src/services/harness-hosts.ts`、`cli/src/services/fable-harness.ts`、`cli/src/services/checkpoint-gate.ts`、`cli/src/commands/autopilot.ts`、`cli/src/commands/hive-mind.ts`、`cli/src/mcp-server.ts`、`cli/src/mcp-tools/agent-execute-core.ts`、`swarm/src/types.ts`、`swarm/src/message-bus.ts`、`swarm/src/topology-manager.ts`、`swarm/src/queen-coordinator.ts`、`swarm/src/coordination/task-orchestrator.ts`、`swarm/src/workers/worker-dispatch.ts`、`memory/src/types.ts`、`memory/src/rvf-backend.ts`、`memory/src/agentdb-backend.ts`、`memory/src/smart-retrieval.ts`、`memory/src/rvf-learning-store.ts`、`providers/src/base-provider.ts`、`v3/crates/ruflo-federation-peer/src/lib.rs`、`v3/crates/ruflo-agntcy/src/envelope.rs`（另有 `ruflo-watermark/src/lib.rs`、`plugin/hooks/hooks.json`、loop-workers/goals/metaharness 插件契约文档等约 10 份支撑材料）。
