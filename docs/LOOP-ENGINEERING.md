# Loop Engineering 调研报告与拆解学习计划

> 调研时间：2026-09-09
> 调研方法：联网检索（Addy Osmani 原文、LangChain 官方博客、Claude 官方博客、IBM/MindStudio 等）+ GitHub API 星数核实（2026-09 当前值）
> 目的：为 agentdeck 的后续演进建立方法论坐标系，并选定开源项目拆解目标

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
| Loop 4（自我改进） | ——（空白，唯一未覆盖层） | Loop 4 |

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

## 5. 拆解执行计划

- **本轮执行**：克隆 learn-claude-code、cc-haha、ruflo、deer-flow 四个（浅克隆至 `teardown/`，不入库），并行派出 4 个子代理，各产出 `docs/teardown/<NAME>-TEARDOWN.md`。
- **报告规格**：沿用 `MULTICA-TEARDOWN.md` 风格——一句话定位、总体架构（带目录树）、核心链路（一次 run 的完整时序）、关键实现细节（引用具体文件路径）、**与 agentdeck 的对照与可借鉴点**（最重要的章节）。
- **后续轮次**：opencode（协议层）、langgraph（编排/持久化）、planning-with-files（状态脊柱）、ouroboros（Loop 4）。

## 6. 来源

- [Loop Engineering | AddyOsmani.com](https://addyosmani.com/blog/loop-engineering/)
- [The Art of Loop Engineering | LangChain](https://www.langchain.com/blog/the-art-of-loop-engineering)
- [Getting started with loops | Claude Blog](https://claude.com/blog/getting-started-with-loops)
- [How the agent loop works | Claude Code Docs](https://code.claude.com/docs/en/agent-sdk/agent-loop)
- [What Is Loop Engineering? | IBM](https://www.ibm.com/think/topics/loop-engineering)
- [What Is Loop Engineering? | MindStudio](https://www.mindstudio.ai/blog/what-is-loop-engineering-ai-coding-agents)
- [Loop Engineering: A Guide for Engineers | Medium (Adnan Masood)](https://medium.com/@adnanmasood/loop-engineering-a-guide-for-engineers-and-practitioners-893bb65ea943)
