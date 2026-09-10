# Agent 编排与目标模式施工总册

> 版本：v1.0（2026-09-09）
>
> 状态：阶段 0 施工边界已冻结；阶段 1（交互矩阵基线）具备开工条件。
>
> 本文是施工文档，不是产品宣传。每一阶段都必须有明确的代码边界、可重复验收和可回滚提交；未在“已完成”栏列出的能力，均视为未交付。

---

## 1. 施工目标

本轮工作的对象是 AgentDeck 的两条相互耦合的链路：

```text
编排链：Issue → Task/Run → Scheduler → Executor → Backend → EventLog → Issue 投影
目标链：Goal → checkpoint → 续轮/委派 → 验证 → completed / blocked / waiting_user / failed
```

最终要达到的不是“让 Agent 多跑几轮”，而是：

1. 任意一次派发、续轮、取消、重试和应用重启，都能从持久状态解释清楚发生了什么。
2. 多条创建路径遵守同一套 Issue/Task/Run 不变量，不再出现看板投影断链或重复建单。
3. 目标模式以可验证条件停止，能区分完成、阻塞、需要人决策和执行失败。
4. 并发、worktree、权限、预算和事件回放都有确定性边界；LLM 只能提出动作，不能绕过边界。
5. 每个阶段都能单独验收，失败时只回滚当前阶段，不回滚用户数据目录。

### 1.1 非目标

- 本轮不迁移到云服务、数据库或新的编排框架。
- 不同时引入新后端；OpenCode server 化是协议升级阶段，不改变其他 backend 的公开接口。
- 不让模型修改 AgentDeck 自身代码作为“自我改进”机制；Loop 4 只进化目标规格和验收条件。
- 不以增加自动续轮次数作为成功指标；预算、停止条件和人工接管优先。

## 2. 学习结论到施工项

六份 teardown 报告是设计输入，具体证据和文件行号见 `docs/teardown/`。下表只保留会改变 AgentDeck 代码或验收方式的结论。

| 学习样本 | 已确认的机制 | AgentDeck 落点 | 施工阶段 |
|---|---|---|---|
| learn-claude-code s01–s17 | Loop 1 是稳定的“消息 → 工具 → 结果”循环；s08 渐进压缩、s12 at-least-once、s13 审批快照、s17 `block_cap`/后台 defer | runner、event-log、permission-broker、goal-controller | 3、5、6 |
| cc-haha | Electron 壳与 Bun sidecar 解耦；每会话 CLI 子进程；worktree 失败时可诚实降级；副链 transcript + metadata sidecar | runner、delegate、git、长期 sidecar 设计 | 4、8 |
| ruflo | 子 Agent 能力信封只允许单调收缩；tick 前 checkpoint；停滞自动 rollback；裁判结果必须带 provenance 和成本上限 | delegate、permission-broker、goal-store、task-finalizer | 2、5、9 |
| deer-flow | 以最新产出 SHA256 判断无进展；blocker 白名单；advisory 与 deterministic 验收分层；JSON contracts 双侧钉死 | goal-controller、retry-policy、task-finalizer、shared contracts | 1、5、6 |
| opencode | `durable + aggregate + version`；live-only 与 durable 终态分界；SSE 游标重放；doom-loop 转人工审批；CLI 只是 server SDK 客户端 | event-log、backends/opencode、permission-broker、runner | 5、6、7 |
| ouroboros | Loop 4 改目标规格而不是自身代码；已通过 AC 只能 keep；采访门控先于执行；结果门优先于进化预算 | goal-store、goal-controller、event-log | 9 |

## 3. 当前基线与风险

### 3.1 已有能力

- `TaskRunner` 已通过 `Scheduler`、`Executor`、`PermissionBroker`、`RetryPolicy` 和 `TaskFinalizer` 协调任务生命周期。
- `delegate.ts` 已支持多源解析、流式提前建单、层级/防环/总轮数护栏、回灌和 `<review>` 审核。
- Goal v2 已绑定真实 Issue，支持 checkpoint、同会话续聊优先、新任务兜底、预算、重启后人工接管，以及清除目标时的任务取消和 runs/checkpoints 级联删除。
- `issue-store`、`goal-store`、`event-log` 使用文件持久化；任务迁移和状态转换已有独立 smoke。
- 当前工作树已加入会话级委派 `seenKeys`、重复标题消歧、即时“已接单”事件，以及 worktree 合并后回收、任务删除回收和启动清扫；这些都是阶段 1 的输入，不得在后续重构中丢失。

### 3.2 必须先固化的风险

| 编号 | 风险 | 影响 | 首次处理阶段 |
|---|---|---|---|
| R1 | Goal × delegate × retry × handoff 没有交互矩阵测试 | 局部修复可能互相抵消，失败续轮可能叠加 | 1 |
| R2 | worktree 回收已接入合并、删除和启动路径，但路径守卫、异常现场保留和孤儿目录清理仍未形成完整契约 | 长期运行仍可能出现资源泄漏或误清理 | 4 |
| R3 | IPC/Goal/delegate/continue 有多条直接 `store.create` 路径 | Issue 投影、issueId 和 Run 归属容易漂移 | 2 |
| R4 | 事件 wrapper、generation 和 pending resume 有三层重复门卫 | 未来修改容易静默吞事件 | 3 |
| R5 | runner 自动重试与 Goal 失败续轮预算语义可能叠加 | 单阶段最坏执行次数超出用户预期 | 5 |
| R6–R9 | 接力计数、委派解析、进程树清理和上下文扫描的低级风险 | 长任务边界条件退化 | 3、4 |

### 3.3 施工基线命令

每阶段至少执行以下命令；阶段专属命令由阶段表追加：

```text
npm run typecheck
npm run smoke:all
npm run build
git diff --check
```

当前基线结果：上述四项均通过。真实 provider 的 `smoke:clis`、`smoke:zcode` 和 `e2e:delegate` 需要本机 CLI 和凭据，不能用本地 fake backend 的绿灯替代。

## 4. 不变量与契约

这些规则是跨阶段的“钉子”。任何阶段修改都必须说明是否影响它们，并补对应测试。

### 4.1 任务与 Issue

1. 业务创建入口必须能得到 `issueId`；没有 Issue 的内部任务必须显式标记为 `suppressIssue`，不能靠调用方记忆。
2. 一个 Issue 可以有多个 Run，但一个 Run 只能指向一个 Task；重试和续轮生成新 Run 时必须保留来源字段。
3. 终态 Task 不得被普通泵自动复活；复活只能来自手动 retry、Goal continue、follow-up 或明确的阶段接力入口。
4. Issue 的人工 `statusOverride` 优先于任务投影；审核通过/退回不得在下一次同步时被覆盖。

### 4.2 事件与会话

1. 每个任务的事件 `seq` 单调递增；重复写入必须幂等，迟到回合事件必须被丢弃并留痕。
2. 事件必须区分“可回放终态”和“仅实时增量”；不能用增量事件重建最终结果。
3. 一个 Task 同时最多只有一个在飞回合；`turnGen`、session 引用和 watchdog 必须属于同一生命周期。
4. `afterSeq` 增量读取与完整回放得到的状态必须一致；分歧要 fail-loud，而不是静默修正。

### 4.3 委派与 worktree

1. 同一领队会话中，`to + prompt` 组合最多建立一个子任务；`seenKeys` 的生命周期不得短于会话。
2. 所有委派路径都经过同一套目标解析、防环、深度、总轮数和能力检查。
3. 每个写入型子任务拥有独立 worktree 或明确的 `unavailableReason`；隔离失败不得伪装成已隔离。
4. 子任务只在完成收尾和合并成功后才报告“已集成”；冲突、脏仓库和回收失败都要结构化留痕。

### 4.4 Goal

1. Goal 只能绑定真实 Issue；每轮完成、失败、取消和等待人工都必须写 checkpoint 或终止原因。
2. 完成判定优先使用结构化 checkpoint 与确定性验收；模型自然语言只能作为说明。
3. 续轮必须受 `maxRuns`、总时长、连续失败、无进展和人工停止条件共同约束。
4. 应用重启后 active Goal 默认进入 `waiting_user`，不得静默继续消耗 token。
5. Loop 4 的候选规格只能增量修改；已通过的验收条件不得删除或降低强度。

## 5. 分阶段施工

阶段必须按顺序推进。表中的“准入”是开始条件，“出站”是完成条件；出站条件未满足时不得进入下一阶段。

### 阶段 0：学习与基线冻结

**目的**：把六份 teardown、架构审查和现有实现变成统一施工输入。

**产出**：

- `docs/LOOP-ENGINEERING.md`：四层模型、agentdeck 映射、行动清单和拆解计划。
- `docs/teardown/`：六份源码精读报告。
- 本文：不变量、风险台账、阶段顺序和验收协议。
- `docs/ARCHITECTURE-REVIEW.md`：现状风险登记册。

**出站验收**：七份核心文档存在且为有效 UTF-8；第三方 clone 位于被忽略的 `teardown/repos/`；`typecheck`、`smoke:all`、`build` 通过。状态：已完成。

### 阶段 1：交互矩阵与行为快照

**目的**：先记录现状，再修状态机，消除“拆东墙补西墙”。

**范围**：新增 `scripts/smoke-orchestration-matrix.mjs`，使用 fake backend 和临时 Git 仓库覆盖至少五个场景：

1. Goal 领队派发子任务，子任务完成后回灌、审核、Goal 续轮。
2. 领队回合失败且已经流式提前建单，确认提前单撤销、Goal 失败计数和重试次数不重复。
3. `<continue>` handoff 产生的新 Task 被同一 Goal 收养，Issue/Run/Goal 归属不漂移。
4. Goal 续轮、手动取消和应用 shutdown 交错，确认没有迟到事件复活任务。
5. 同一 `<delegate>` 在流式文本、回灌文本和评估文本中重复出现，确认只建一个子任务。

**准入**：阶段 0 出站通过；现有 `smoke:delegate`、`smoke:continue`、`smoke:goal` 全绿。

**出站**：矩阵脚本串行、可重复、每个场景至少有一个状态/事件/投影断言；加入 `npm run smoke:all`；不改变生产行为。失败只回滚测试提交。

### 阶段 2：统一任务创建与 Issue 投影入口

**目的**：消灭 R3，令 IPC、Goal、delegate、continue 都通过同一个 application service 创建 Task/Run。

**范围**：

- 新增 `src/main/task-service.ts` 或等价 application service，封装 `createTask`、`createChildTask`、`createHandoffTask`。
- `runner.spawnDelegateChild`、`index.createTask`、`attachContinue`、`goal-controller.launchNext` 改为调用统一入口。
- 创建成功时同步建立必要的 Issue/Run 投影；`suppressIssue` 语义显式化。
- 保留旧 IPC payload 和旧 `tasks.json` 格式，迁移只增加字段，不删除历史数据。

**出站**：重复执行同一创建请求不会重复 Issue、Run、Comment 或 Notification；矩阵场景和迁移 smoke 全绿；统一入口具备单测或纯本地 smoke。回滚方式是保留旧 wrapper，切回旧写入路径。

### 阶段 3：执行生命周期与事件门卫收口

**目的**：消灭 R4/R6/R9，把会话、回合代号、watchdog 和迟到事件收进一个确定性生命周期对象。

**范围**：

- 抽取 `TurnLifecycle`/`EventGate`（名称可调整），统一检查 task status、`turnGen`、session owner、title mode 和 pending resume。
- 统一“启动竞速失败、取消、超时、迟到 session、旧终态事件”的收尾顺序。
- 接力链计数只统计有效 handoff；委派嗅探改为按扫描游标增量处理，保留 `seenKeys` 全生命周期。
- `killTree` 返回可观察的完成结果，应用退出时不留下未确认的清理 promise。

**出站**：取消、启动挂起、迟到终态、接力上限和并发会话场景全绿；事件 gate 只有一个生产判定入口；性能 smoke 证明长文本不会每个 delta 全量重扫。

### 阶段 4：worktree、分支和资源生命周期

**目的**：消灭 R2，令隔离资源可追踪、可回收、可审计。

**范围**：

- worktree metadata 记录 owner task、创建时间、基线 SHA、分支和清理状态。
- 合并成功且任务完成后按策略回收 worktree 和临时分支；有冲突、未提交变更或人工保留标记时保留并给出原因。
- 增加幂等 `prune` 命令/服务和 fail-closed 的最大保留期限；非 Git 工作区返回降级原因继续执行。

**出站**：重复执行 prune 不破坏活跃任务；重启可发现孤儿 worktree；用户工作分支不被删除；回收失败不伪报成功。需要真实 Git 临时仓库 smoke。

### 阶段 5：Goal Controller 防空转与预算收口

**目的**：把学习样本中的防空转机制落到目标模式，不增加无限自动化。

**范围**：

- 对最新可见 AI 产出计算稳定 `progressKey`（SHA256）；只有产出签名连续相同才累计 `noProgress`。
- 增加 checker `blockCap`（默认 8）和后台任务 `defer` 语义；达到上限后进入人工可见状态，不静默放行。
- 工具调用滑窗检测 doom-loop（同名同参连续 3 次），转为权限/人工审批事件。
- 将 runner retry attempt 与 Goal failures 写成统一预算解释，明确单阶段最大执行次数。
- PermissionBroker 请求绑定 `taskId + workVersion` 快照；任务内容变化后旧审批自动失效。

**出站**：每个熔断都有 `stopReason`、事件和 UI 可读说明；相同结果不同裁判措辞仍能熔断；版本变化不会复用旧审批；目标模式 smoke 覆盖每条护栏。

### 阶段 6：事件日志契约与回放一致性

**目的**：吸收 opencode 的 durable/live 边界，解决 event-log 无版本、快照/增量语义不清的问题。

**范围**：

- 为 `TaskEvent` 增加可选版本和 aggregate 元数据，旧 JSONL 读侧归一化。
- 明确 `text.delta`、工具增量等 live-only 事件与 final/tool-result 等 durable 终态。
- `append`、批量 flush、崩溃恢复、`afterSeq` 读取和 replay 分歧检测统一走 EventLog API。
- 事件清单从 shared contract 生成或由单一 manifest 驱动，未知事件按兼容策略处理。

**出站**：旧日志可读；重放与增量读取一致；重复 append 幂等；断电模拟不产生半行或重复 seq；事件版本演进有迁移 smoke。

### 阶段 7：OpenCode server 适配器

**目的**：消除当前 `opencode run --format json` 的薄视图和 `--dangerously-skip-permissions` 旁路。

**范围**：

- 优先评估嵌入式 `createOpencode()`，否则管理 `opencode serve` sidecar；CLI JSON 模式保留为 fallback。
- `start/send/stop/close` 映射 session create/prompt/interrupt/close；SSE 订阅支持 `after=seq` 重连。
- 接回 permission、reasoning、step finish tokens/cost、session.error、compaction、fork 和原生子 Agent 能力。
- 版本探测和 SDK 不兼容时 fail-loud，并保留旧 adapter 路径。

**出站**：无需危险跳过权限即可完成最小回合；中断和重连不丢 durable 终态；usage/failure 能读取结构化数据；server 不可用时 fallback 行为明确。需要真实 OpenCode CLI 验收。

### 阶段 8：业务大脑 sidecar 化（中长期）

**目的**：参考 cc-haha，把任务执行从 Electron 窗口生命周期中解耦。

**范围**：

- 先定义本地 loopback RPC/HTTP 契约，再把 runner、Issue projector、EventLog 放入独立 Node/Bun 进程。
- Electron 只保留窗口、通知、权限 UI 和 sidecarManager；客户端断开不停止任务。
- sidecar 使用粘性端口、实例 token、启动握手、健康检查和优雅关闭；renderer 重连先同步权威状态再发送排队消息。

**出站**：关闭/刷新 renderer 不会杀任务；sidecar 重启能恢复或明确接管孤儿 run；IPC 契约测试覆盖版本不匹配和权限边界。此阶段不得与 Goal 规则改动同一提交。

### 阶段 9：Loop 4 规格进化

**目的**：用安全、可审计的方式改善目标规格，而不是让 Agent 改写自身执行器。

**范围**：

- `Goal` 增加带稳定位置身份的 acceptance criteria；候选变更只允许 `keep/revise/add`，禁止删除已 PASS 条件。
- 采访门控先判断目标歧义，未过门槛只生成澄清问题，不消耗执行预算。
- 每代保存 goal/spec/checkpoint 快照；结果门优先于进化代数，停滞和成本超限立即停止。
- LLM 只生成结构化 patch，确定性代码校验、审批和应用；所有建议带 provenance，不冒充 ground truth。

**出站**：已 PASS 条件不可被候选 patch 移除或弱化；拒绝/回滚可重放；第 1 代已满足结果门时不为进化仪式付费；Loop 4 smoke 不会触碰 `src/main/backends/`。

## 6. 提交与验收协议

### 6.1 每阶段提交格式

每个阶段至少一个提交，提交说明必须包含：

```text
目标：本阶段解决哪个风险/不变量
范围：修改了哪些模块，明确没有修改哪些模块
迁移：数据格式、兼容读侧和回滚方式
验证：typecheck / smoke / build 的确切结果
已知限制：真实 provider、性能或人工验收缺口
```

### 6.2 阶段闸门

```text
阶段 0 文档/基线
        ↓
阶段 1 交互矩阵（只加测试）
        ↓
阶段 2 创建入口与投影
        ↓
阶段 3 生命周期门卫 ──→ 阶段 4 资源回收
        ↓
阶段 5 Goal 防空转与审批版本
        ↓
阶段 6 EventLog 契约
        ↓
阶段 7 OpenCode server
        ↓
阶段 8 sidecar（中长期）
        ↓
阶段 9 Loop 4 规格进化
```

任何阶段出现以下情况，立即停在当前阶段并记录 blocker：

- `npm run typecheck` 或现有 smoke 变红，且无法证明是测试本身的契约错误。
- 任务、Issue、Run 或 Goal 出现无法从事件日志解释的状态。
- 取消、权限、worktree 隔离或预算边界被绕过。
- 需要删除旧数据、静默改变用户工作区或引入未评估的外部服务。

## 7. 当前开工单（阶段 1）

阶段 1 的第一批改动只允许触及：

- `scripts/smoke-orchestration-matrix.mjs`
- `package.json` 的 `smoke:orchestration-matrix` 和 `smoke:all` 接线
- 本文的验证记录

第一批不改 `runner.ts`、`delegate.ts`、`goal-controller.ts`。先把当前行为变成可重复事实，再根据矩阵暴露的实际冲突进入阶段 2 或阶段 3。这样每一次后续重构都有明确的前后对照，而不是用单特性绿灯推断组合场景正确。

### 阶段 1 验证记录（2026-09-09）

已新增 `scripts/smoke-orchestration-matrix.mjs`，每个场景使用独立的 fake backend、Task/Issue/Goal 持久化目录和临时 Git 仓库，按串行顺序覆盖：

1. Goal × delegate：子任务完成、回灌、`<review>` 通过、Goal 同会话续轮、Issue/Run 投影和 worktree 回收。
2. 失败重试 × Goal：429 瞬态失败、保留 session resume、单次 retry 事件、Goal failures 不重复累计。
3. continue handoff × Goal：记录当前接线的 `issueId`、`continuesFrom`、`trigger=handoff` 和 Issue/Run 投影；同时钉住现状：handoff Task 尚未携带 `goalId`/Goal phase metadata，Goal projection 不会收养它（R-B，留待阶段 2 统一创建入口修复）。
4. 取消 × 提前派单：流式提前接单后取消，父子任务和 Goal 保持 cancelled，迟到终态不复活。
5. 重复 delegate：同一标签在流式文本、回灌文本和评估文本重复出现时只创建一个子任务。

脚本只在临时目录生成 bundle，结束时关闭 runner、flush store 并清理临时仓库；已接入 `npm run smoke:orchestration-matrix` 和串行 `npm run smoke:all`。本批次未修改生产执行代码。

验证结果：`node scripts/smoke-orchestration-matrix.mjs`（连续运行通过）、`npm run typecheck`（通过）、`npm run build`（通过）、`npm run smoke:all`（通过）。

已知限制：矩阵场景3复刻当前 `attachContinue` 行为，确认接力任务与原 Issue 关联但不带 `goalId`，因此不会进入 GoalStore 的 Run/Checkpoint 投影；这不是本阶段伪造的成功条件，属于阶段2统一任务创建入口的待修复证据。
