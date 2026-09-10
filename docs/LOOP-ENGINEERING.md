# Loop Engineering 调研报告与拆解学习计划

> 调研时间：2026-09-09
> 调研方法：联网检索（Addy Osmani 原文、LangChain 官方博客、Claude 官方博客、IBM/MindStudio 等）+ GitHub API 星数核实（2026-09 当前值）
> 目的：为 agentdeck 的后续演进建立方法论坐标系，并选定开源项目拆解目标
> **状态：✅ 六项目拆解已完成**——报告见 `docs/teardown/`（6 份，合计约 26 万字符，全部结论带文件路径:行号引用）；跨项目综合发现与 agentdeck 行动清单见 §5–6

---

## 1. 定义与谱系

**Loop Engineering（循环工程）**：不再由人逐轮提示 Agent，而是设计一个"替你提示 Agent 的系统"——它负责发现工作、分发任务、校验结果、记录状态、决定下一步。人只设计循环，不参与每一圈。

一句话：**"You shouldn't be prompting coding agents anymore. You should be designing loops that prompt your agents."**（Peter Steinberger）；Claude Code 负责人 Boris Cherny："My job is to write loops."

谱系（抽象层级逐级上移）：

```
Prompt Engineering   —— 写好一次提问
Context Engineering  —— 管好一个上下文窗口
Loop Engineering     —— 设计替你运行 Agent 的循环系统（本篇）
Agent Harness Eng.   —— 单个 Agent 运行的环境/外壳（loop 的下一层楼）
```

一个 loop = **一个递归目标**：定义目的与可验证的停止条件，AI 迭代逼近直到达成。

## 2. 核心模型

### 2.1 最内层循环（Loop 1）

所有 Agent 的最小骨架：**给 LLM 上下文 + 工具，让它反复调用工具直到任务完成**。停止条件由模型自判（turn-based）或外部裁判判定。

### 2.2 六大构件（Addy Osmani；Claude Code / Codex 均已内置）

| 构件 | 作用 | 典型实现 |
|---|---|---|
| Automations（心跳） | 定时发现/分诊工作 | cron、hooks、`/loop`、GitHub Actions |
| Worktrees | 并行 Agent 隔离检出，互不冲突 | git worktree、per-subagent isolation |
| Skills | SKILL.md 固化项目约定，循环不必每圈重新理解项目 | `.claude/skills/`、`$skill-name` |
| Plugins/Connectors | 经 MCP 接入 issue 系统/Slack/数据库，让循环能在真实环境行动 | MCP |
| Sub-agents | maker/checker 分离：写代码的模型给自己打分太宽松 | explore/implement/verify 三分 |
| State/Memory | 外部状态文件是循环的"脊柱"："The agent forgets, the repo doesn't." | markdown / Linear board |

### 2.3 四层循环堆栈（LangChain《The Art of Loop Engineering》，术语 loopcraft 源自 swyx）

| 层 | 作用 | 关键机制 | 对应构件 |
|---|---|---|---|
| Loop 1 Agent loop | 执行工作 | 工具调用循环 | model + tools |
| Loop 2 验证循环 | 保证正确性 | grader 按 rubric 打分，失败带反馈重试（LLM-as-judge 或确定性检查） | RubricMiddleware / after_agent hook |
| Loop 3 事件驱动循环 | 规模化 | cron / webhook / heartbeat 触发，Agent 嵌入更大系统 | Fleet、openclaw heartbeats |
| Loop 4 爬山循环 | 改进循环本身 | 分析生产 trace，回头改写 prompt/工具/grader 配置 | LangSmith Engine |

论点：多数团队止步 Loop 1–2，**复利在 Loop 3–4**（对应 Satya Nadella "human judgment + token capital 复利" 论）。

### 2.4 四种循环类型（Claude 官方博客《Getting started with loops》）

| 类型 | 触发 | 停止 | 工具 | 适用 |
|---|---|---|---|---|
| Turn-based | 用户提示 | 模型自判完成 | verification skills | 短任务、一次性 |
| Goal-based | 实时提示 | 目标达成或轮数上限；**独立小模型当裁判** | `/goal` | 有可验证退出条件的任务 |
| Time-based | 时间间隔 | 手动取消或完成 | `/loop`（本地）/`/schedule`（云端） | 周期性工作 |
| Proactive | 事件/日程 | 目标达成；例行则直到停止 | 以上组合 | 无人值守工作流 |

### 2.5 关键原则与风险

- **停止条件必须可验证、量化**——"完成"只是模型的主张，不是证明。
- **maker/checker 分离要贯穿到停止条件本身**（goal 裁判模型 ≠ 干活模型）。
- **状态文件是脊柱**：每圈从上次断点续跑；Agent 会忘，repo 不会。
- Token 是最大成本杠杆：模型/effort 档位选择 > 一切微优化；先小切片试点再放量。
- 风险：**comprehension debt**（理解债）与 **cognitive surrender**（认知投降）——人的审查带宽决定可并行 Agent 数；同样的循环，有人越跑越强，有人彻底不理解自己的系统。

## 3. agentdeck 现状映射

agentdeck 已实现的模块恰好覆盖了 Loop Engineering 图谱的大半，拆解学习时可按下表对照：

| Loop Engineering 概念 | agentdeck 模块 | 覆盖层 |
|---|---|---|
| Loop 1（工具调用循环） | `runner.ts` + `backends/*`（claude/codex/opencode/zcode/dsh 适配） | Loop 1 |
| Loop 2（验证循环） | `retry-policy.ts`、`task-finalizer.ts` | Loop 2 |
| Goal-based loop（/goal） | `goal-controller.ts` + `goal-store.ts` | Loop 2 |
| Time-based / 事件驱动 | `scheduler.ts` | Loop 3 |
| Sub-agents / maker-checker | `delegate.ts`（委派 + round notes） | Loop 1→2 桥 |
| State/Memory 脊柱 | `issue-store.ts`、`goal-store.ts`、`event-log.ts` | 全层 |
| Human-in-the-loop 干预点 | `permission-broker.ts`、`ipc-validation.ts` | 全层 |
| Loop 4（自我改进） | ——（空白，唯一未覆盖层；起步方案见 §6 行动清单 #10） | Loop 4 |

**结论**：agentdeck 是"loop harness + 桌面工作台"定位；拆解重点应放在①状态脊柱的健壮性 ②委派/验证链路 ③多后端协议适配 ④Loop 4 的可行设计。

## 4. 拆解目标清单（星数为 2026-09 当前值）

按对 agentdeck 的架构参考价值排序：

| 优先 | 项目 | 星数 | 定位 | 拆解重点 |
|---|---|---|---|---|
| ★★★ | [shareAI-lab/learn-claude-code](https://github.com/shareAI-lab/learn-claude-code) | 76k | "Bash is all you need"，0→1 教学版 nano harness | Loop 1 最小实现：主循环、工具分发、上下文管理、权限流 |
| ★★★ | [NanmiCoder/cc-haha](https://github.com/NanmiCoder/cc-haha) | 14k | 本地优先桌面工作区，多 Agent + worktree + 聊天集成 | agentdeck 直接同类：桌面编排层、多 Agent 管理、状态持久化 |
| ★★★ | [ruvnet/ruflo](https://github.com/ruvnet/ruflo) | 72k | TypeScript agent meta-harness，原生对接 Claude Code/Codex | 多后端编排（与 agentdeck 定位几乎重合）、群协、自适应记忆 |
| ★★☆ | [bytedance/deer-flow](https://github.com/bytedance/deer-flow) | 82k | 长时程 SuperAgent（sandbox/记忆/skills/subagent/消息网关） | 长时程任务链路：分钟~小时级任务的分段、检查点、恢复 |
| ★★☆ | [anomalyco/opencode](https://github.com/anomalyco/opencode) | 206k | 当前星数最高的开源编码 Agent | client/server 协议、provider 抽象（agentdeck 的上游之一） |
| ★☆☆ | [OpenHands/OpenHands](https://github.com/OpenHands/OpenHands) | 87k | 循环 harness 教科书（事件流、沙箱） | 事件流架构、Agent 抽象层 |
| ★☆☆ | [langchain-ai/langgraph](https://github.com/langchain-ai/langgraph) | 41k | 图编排 + checkpoint + HITL interrupt | retry-policy / permission-broker 的通用化设计 |
| ★☆☆ | [OthmanAdi/planning-with-files](https://github.com/OthmanAdi/planning-with-files) | 27k | 文件即计划（防崩溃 markdown 计划 + 会话恢复） | issue-store/goal-store 的"状态脊柱"设计 |
| 备选 | [princeton-nlp/SWE-agent](https://github.com/princeton-nlp/SWE-agent)（20k，ACI 研究）、[QwenLM/qwen-code](https://github.com/QwenLM/qwen-code)（28k）、[aaif-goose/goose](https://github.com/aaif-goose/goose)（54k）、[Q00/ouroboros](https://github.com/Q00/ouroboros)（5.8k，Loop 4 样本） | | | |

### 4.1 拆解计划与验收标准

本轮拆解按“先建立共同坐标系，再做源码精读，最后回写 agentdeck 决策”的顺序执行。`teardown/repos/` 只保存本地研究副本，研究产物只进入 `docs/teardown/`，不把第三方源码纳入版本库。

| 阶段 | 工作内容 | 产出与验收 |
|---|---|---|
| 0. 基线 | 固定调研日期、项目版本/星数，记录 clone 根目录；先读项目 README、目录树和构建入口 | 每个项目有可追溯的对象说明；引用以 clone 内文件为准 |
| 1. 纵向精读 | 按项目角色阅读主循环、状态/事件、权限、子 Agent、调度、持久化和测试；只记录能落到源码的机制 | 每个结论至少有 `path:line` 依据；区分“真实执行路径”与宣传/未接线代码 |
| 2. 报告成稿 | 使用统一模板：一句话定位、总体架构、一次 run 链路、关键实现、与 agentdeck 对照、风险与“不学”清单 | 六份报告均包含 agentdeck 模块映射和可操作借鉴项；表格中的路径、行号与 clone 可核对 |
| 3. 横向合并 | 把各报告归并到 Loop 1–4、六大构件和四种循环类型，按改动成本排序行动项 | 总览提供四大模型、agentdeck 映射表、六项目结果表和低/中/高成本行动清单 |
| 4. 回归复核 | 检查文件名、链接、编码、`.gitignore`；对关键引用抽查行号和上下文，避免把研究建议误写成已实现功能 | `docs/teardown/` 恰有六份目标报告；`teardown/repos/` 被忽略；总览状态与实际产物一致 |

本轮六个项目的专属验收重点如下：learn-claude-code 必须覆盖 `s01`–`s17` 全部阶段；cc-haha 必须解释 Bun sidecar 与 worktree 工程化；ruflo 必须覆盖能力信封、checkpoint 回滚和成本纪律；deer-flow 必须覆盖 goal 熔断、分层验证和 contracts；opencode 必须对照 `src/main/backends/opencode.ts` 说明事件模型与主循环能力缺口；ouroboros 必须说明“改规格而非改自身”、采访门控和预算排序。

## 5. 拆解执行结果（2026-09-09 完成）

六个项目浅克隆至 `teardown/repos/`（已 gitignore，不入库），6 个子代理并行拆解，各产出一份报告（沿用 `MULTICA-TEARDOWN.md` 规格：一句话定位 / 总体架构 / 核心链路 / 关键实现细节 / **与 agentdeck 的对照与可借鉴点**；子代理各精读 20–46 个核心源码文件）。

| 报告 | 对象（星数） | 一句话结论 |
|---|---|---|
| [LEARN-CLAUDE-CODE-TEARDOWN.md](teardown/LEARN-CLAUDE-CODE-TEARDOWN.md) | learn-claude-code（76k） | 实为 s01–s17 共 17 个教学阶段（README 只列 12）；s17 goal loop 与 agentdeck goal-controller 直系同源 |
| [CC-HAHA-TEARDOWN.md](teardown/CC-HAHA-TEARDOWN.md) | cc-haha（14k） | agentdeck 直接同类：业务大脑在可独立存活的 Bun sidecar server，不在 Electron 主进程 |
| [RUFLO-TEARDOWN.md](teardown/RUFLO-TEARDOWN.md) | ruflo（72k） | 宣传的 swarm/共识/消息总线在真实执行路径上未接线——真实编排 = 巨型 Queen 提示词 + `.rvf` 共享内存黑板 |
| [DEER-FLOW-TEARDOWN.md](teardown/DEER-FLOW-TEARDOWN.md) | deer-flow（82k） | 长时程 SuperAgent：goal 熔断 + 分层验证词汇纪律 + contracts CI 双侧钉死 |
| [OPENCODE-TEARDOWN.md](teardown/OPENCODE-TEARDOWN.md) | opencode（206k） | agentdeck 上游协议：`opencode run --format json` 只是最薄视图，升级 server 模式可接回十余项能力 |
| [OUROBOROS-TEARDOWN.md](teardown/OUROBOROS-TEARDOWN.md) | ouroboros（5.8k） | Loop 4 现成样本：自我改进改的是**任务规格（Seed）**而非自身代码，LLM 提议 + 确定性裁决 |

### 5.1 各报告核心发现速览

**learn-claude-code**（Loop 1 教科书）
- s17 goal loop 两个防御设计值得照搬：`block_cap=8`（裁判连续拦截上限，防无限拉锯烧 token）、`background_running → defer`（后台任务未收割时裁判不得判"完成"）（`s17_goal_loop/code.py:360-364`）。
- s08 四级渐进压缩流水线（单批 tool_result 预算落盘 → 消息数 snip → 旧结果换磁盘路径 → LLM 摘要兜底）是零 LLM 成本的上下文工程范本；`unseen_tool_result_positions`（模型没看过的最新结果不许压）是现成安全模板。
- s12 cron 的 at-least-once 交付（pending_delivery 先落盘、确认后 ack、失败回队列）与 s13 审批-版本绑定（`(work_version, task_id)` 快照，任务变更即旧审批失效）都是小改动大收益。

**cc-haha**（桌面编排同类）
- 四类进程分工：Electron 壳 / 本地 server / 每会话一个 CLI 子进程 / 每平台一个 IM 适配器；客户端断开与任务存活彻底解耦（宽限期 + 完成 watcher）。
- subagent = 进程内 AsyncGenerator 递归 + 副链 transcript/sidecar 双持久化（ownerAgentId/toolUseId/worktreePath 归属元数据），resume 时能把子 agent 挂回原始 Agent 卡片。
- worktree 工程化最扎实：SHA 起点 + `-B` 防并发写、无变更自动回收、fail-closed 30 天 GC、非 git 工作区**降级共享 cwd 而非失败**（隔离是优化不是前提）。
- ⚠️ 两个风险事实：内含大量 ant-internal stub（对 Claude Code 内部实现的重建，有上游血统风险）；cron 自动任务默认 `bypassPermissions`。

**ruflo**（多后端 meta-harness）
- 能力信封（`WorkerCapabilityEnvelope`，权限单调收缩只减不增即拒）+ spawn 前外部策略裁决 → 对应 agentdeck 的 delegate/permission-broker。
- autopilot 每 tick 前 O(1) checkpoint、停滞 10 轮自动 rollback → 对应 goal-controller/goal-store。
- Loop 2/4 成本纪律教科书：实测数据驱动（项目目录起 claude -p $1.56 → 干净临时 cwd $0.34 → 批 20 条 $0.02/条），判定结果强制 `judge:fable` provenance 标签、永不冒充 ground truth。

**deer-flow**（长时程 SuperAgent）
- **产出签名熔断**：无进展判定不依赖裁判自由文本，而对最新 AI 消息文本做 SHA256，`{satisfied, blocker, signature}` 连续相同才计 no_progress；六值 blocker 枚举只有 `goal_not_met_yet` 可续跑（`runtime/goal.py:345-390`）。
- 验证分层 + 词汇纪律：Layer 1 引用核对（advisory，布尔名禁用 satisfied/verified/passed）与 Layer 2 确定性验收（`file: exists` / `tests_passed:<cmd>`）严格分离，判不了一律 UNVERIFIED。
- contracts/ 最小契约面（4 个 JSON 只冻结枚举词汇 + envelope schema），Python 测试与 TS 消费者引用同一 fixture，双侧漂移即红；演进只走加性字段。

**opencode**（agentdeck 上游）
- `opencode run` 自己也只是 SDK 客户端：agentdeck 适配器消费的 `--format json` 丢了 token 级增量、reasoning、tokens/cost、session.error 正文，且 `--dangerously-skip-permissions` 使 PermissionBroker 被完全旁路（报告 §7.1 列了升级 server 模式可接回的 12 项能力）。
- 事件模型三设计：`durable: {aggregate, version}` 声明式持久化；live-only 增量（`text.delta`）与 durable 终态（`text.ended`）显式分界；SQLite 事务内 projector + seq + replay 分歧检测。
- 主循环两机制可零成本移植：停止条件数据驱动（finish 原因 + 工具部件完备性，非单一信号）；doom-loop 检测（连续 3 次同名同参工具调用 → 转审批而非硬终止，约 30 行）。

**ouroboros**（Loop 4 样本）
- 进化循环改的是 goal/constraints/AC 列表的增量补丁：LLM 只提议、确定性代码裁决，已 PASS 的 AC 强制 keep 兜底——**Loop 4 的安全形态是"改进规格"而非"改进自己"**。
- 采访门控（歧义总分 ≤0.2 且各维度清晰度过地板才放行执行）是最便宜的成本杠杆，可用小模型 + 现有审批管道复刻。
- 预算控制的正确位置在停止条件的**排序**里：结果门排在最小代数之前（第 1 代通过立即停，不为进化仪式感付费）、停滞 3 代 ε=0.01 早停、无进展看门狗取代纯时长超时。
- 反面教材：frugality 配对对照证明体系（默认永远 insufficient_data）与 ontology 哲学层属于过度设计，不学。

## 6. agentdeck 行动清单（按改动成本排序）

| # | 行动 | 对应模块 | 来源 | 成本 |
|---|---|---|---|---|
| 1 | **opencode 适配器升级 server 模式**（嵌入式 `createOpencode()` + SSE `session.events?after=seq`），接回审批/中断/压缩/fork 等 12 项能力，解除 PermissionBroker 旁路 | `backends/opencode.ts` | opencode 报告 §7.1 | 中 |
| 2 | **防 LLM 空转三件套**：产出签名熔断（SHA256 三元组连续相同才计 no_progress）、`block_cap=8` 拦截上限、doom-loop 检测（连续 3 次同参调用转审批） | `goal-controller.ts` | deer-flow + learn-claude-code + opencode | 低 |
| 3 | **审批-版本绑定**：审批绑定 `(work_version, task_id)` 快照，任务变更即旧审批失效 | `permission-broker.ts`、`delegate.ts` | learn-claude-code s13 | 低 |
| 4 | **scheduler at-least-once 交付**：pending_delivery 先落盘、确认后 ack、失败回队列 | `scheduler.ts` | learn-claude-code s12 | 低 |
| 5 | **event-log 升级**：`durable:{aggregate,version}` 声明式持久化 + live/durable 事件分界 + replay 分歧检测 | `event-log.ts`、`shared/contracts.ts` | opencode | 中 |
| 6 | **子 Agent 副链持久化**：子 agent 独立 JSONL + 归属 sidecar（ownerAgentId/toolUseId），resume 挂回原卡片 | `delegate.ts` | cc-haha | 中 |
| 7 | **委派能力信封**：子 Agent 权限单调收缩 + spawn 前策略裁决 | `delegate.ts` + `permission-broker.ts` | ruflo | 中 |
| 8 | **验证分层词汇纪律**：advisory（引用核对）与 deterministic（`file: exists` / `tests_passed:`）分层，禁用 satisfied/verified/passed 于 advisory 层，判不了一律 UNVERIFIED | `task-finalizer.ts`、`retry-policy.ts` | deer-flow | 中 |
| 9 | **contracts 钉死**：主进程/渲染进程/5 个 backend 之间引入最小 JSON 契约面 + CI 双侧 fixture 钉死，演进只走加性字段 | `shared/contracts.ts` | deer-flow | 中 |
| 10 | **Loop 4 起步（规格进化而非代码进化）**：goal-store 加带位置身份的 AC 列表（禁删除，只 keep/revise/add）+ goal-controller 进化步 + event-log 世代快照即回滚；先做批量裁判与分层预设，进化算法最后做 | `goal-store.ts` + `goal-controller.ts` | ouroboros + ruflo | 高 |
| 11 | **架构演进（中长期）**：业务大脑（runner/issue-store/event-log）下沉为可独立存活的 sidecar server，Electron 退化为壳+sidecarManager，客户端断开任务不死 | `src/main/` 整体 | cc-haha | 高 |
| 12 | **上下文压缩流水线**：四级渐进压缩 + unseen_tool_result_positions 保护 + "历史是数据不是指令"双层反注入 | 跨 backend 上下文整理 | learn-claude-code s08 | 高 |

**明确不学**：ruflo 未接线的 swarm 宣传面（只实现会真跑的编排原语）、ouroboros 的 frugality 配对对照证明体系与 ontology 哲学层、cc-haha cron 默认 `bypassPermissions`（若借鉴其双层分钟键去重，须让 permission-broker 拦住这一点）。

## 7. 后续拆解轮次（未执行）

OpenHands（事件流架构）、langgraph（编排/持久化/HITL interrupt）、planning-with-files（状态脊柱）、goose（time-based 循环与插件化）、SWE-agent（ACI 最小工具面）。

## 8. 来源

- [Loop Engineering | AddyOsmani.com](https://addyosmani.com/blog/loop-engineering/)
- [The Art of Loop Engineering | LangChain](https://www.langchain.com/blog/the-art-of-loop-engineering)
- [Getting started with loops | Claude Blog](https://claude.com/blog/getting-started-with-loops)
- [How the agent loop works | Claude Code Docs](https://code.claude.com/docs/en/agent-sdk/agent-loop)
- [What Is Loop Engineering? | IBM](https://www.ibm.com/think/topics/loop-engineering)
- [What Is Loop Engineering? | MindStudio](https://www.mindstudio.ai/blog/what-is-loop-engineering-ai-coding-agents)
- [Loop Engineering: A Guide for Engineers | Medium (Adnan Masood)](https://medium.com/@adnanmasood/loop-engineering-a-guide-for-engineers-and-practitioners-893bb65ea943)
