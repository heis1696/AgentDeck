# DeerFlow 2.0 拆解报告：长时程 Super Agent Harness 的工程化实现

> 拆解时间：2026-09-09
> 拆解对象：`D:\agentdeck\teardown\repos\deer-flow`（bytedance/deer-flow，82k 星，DeerFlow 2.0，Python 3.12 backend + Node 22 frontend）
> 拆解方法：源码通读为主（重点 backend/packages/harness、backend/app、contracts/），所有结论均带文件路径与行号引用
> 方法论坐标系：`D:\agentdeck\docs\LOOP-ENGINEERING.md` 四层循环模型（Loop 1 工具调用 / Loop 2 验证 / Loop 3 事件驱动 / Loop 4 自我改进）

---

## 1. 一句话定位与总体架构

**一句话定位**：DeerFlow 2.0 是一个构建在 LangChain/LangGraph 之上的 **super agent harness**——单个 lead agent（LangChain `create_agent` 图 + 约 30 个 middleware 组成的拦截链）通过 `task` 工具把工作委派给隔离子 Agent，用 checkpoint 做状态脊柱、用 run event store 做事件流、用可插拔 sandbox 执行命令、用可插拔 memory 持久记忆、用 SKILL.md 技能包扩展能力，并由 FastAPI Gateway + 12 类 IM 消息网关 + cron 调度器把整个系统嵌入外部事件世界，支撑分钟到小时级的长时程任务。

### 1.1 目录树（去除 node_modules / 构建产物 / 多语言 README）

```
deer-flow/
├── backend/
│   ├── app/                          # FastAPI 应用层（Gateway + 消息网关 + 调度）
│   │   ├── gateway/                  # HTTP API：routers/(runs, threads, skills, memory,
│   │   │                             #   scheduled_tasks, subagents, subagent_batches,
│   │   │                             #   github_webhooks, ...) + auth/(jwt/oidc/pat) + services
│   │   ├── channels/                 # 消息网关：slack/discord/telegram/feishu/dingtalk/
│   │   │                             #   wechat/wecom/github/buzz(nostr) + message_bus + 运行策略
│   │   ├── scheduler/service.py      # 定时任务轮询服务（cron/once → dispatch run）
│   │   ├── mcp_tasks/  subagent_batches/
│   │   └── langgraph.json            # LangGraph Server ABI 声明
│   └── packages/
│       ├── harness/deerflow/         # ★ 核心 harness 包（532 个 py 文件）
│       │   ├── agents/
│       │   │   ├── lead_agent/       # 主 Agent 工厂（agent.py 1221 行 + prompt.py 1172 行）
│       │   │   ├── middlewares/      # ~50 个 middleware（loop/token_budget/subagent_limit/
│       │   │   │                     #   summarization/durable_context/delegation_ledger/...）
│       │   │   ├── memory/           # 记忆：manager.py 契约 + backends/(deermem/mem0/openviking)
│       │   │   └── thread_state.py / goal_state.py
│       │   ├── runtime/              # ★ 运行时脊柱
│       │   │   ├── runs/             #   worker.py(2946 行) manager.py(2337 行) store/
│       │   │   ├── events/           #   事件目录 + store/(db/jsonl/memory)
│       │   │   ├── journal.py        #   RunJournal（回调→事件存储）
│       │   │   ├── goal.py           #   /goal 循环原语（评估器/续跑/无进展熔断）
│       │   │   ├── checkpointer/ checkpoint_cache/ stream_bridge/(redis)
│       │   │   └── checkpoint_state.py / checkpoint_mode.py / context_compaction.py
│       │   ├── subagents/            # ★ 子 Agent：executor.py(1951 行) acceptance_checks.py
│       │   │                         #   status_contract.py batch_service.py capacity.py
│       │   ├── sandbox/              # 沙箱：Sandbox/SandboxProvider 抽象 + local/ + lease.py
│       │   ├── skills/               # 技能：catalog.py(延迟发现) installer/ parser/ review/
│       │   ├── scheduler/schedules.py# cron/once 的 next_run_at 计算
│       │   ├── persistence/          # SQLAlchemy 模型 + 20 个 alembic 迁移（runs/threads/
│       │   │                         #   scheduled_tasks/managed_subagents/subagent_batches/...）
│       │   ├── tools/builtins/       # task_tool / batch_task_tool / tool_search / ...
│       │   ├── community/            # 第三方沙箱 provider（aio/e2b/opensandbox）
│       │   ├── extensions/ guardrails/ authz/ mcp/ models/ uploads/ tui/ workspace_changes/
│       │   └── config/               # app_config（config_version: 40 的 YAML schema）
│       └── extension-api/            # 扩展 API 契约包（deerflow_extension_api）
├── contracts/                        # ★ 跨语言契约（JSON，被 CI 双侧钉死）
│   ├── run_event_stream_contract.json    # 事件流 schema（frozen event names + 兼容规则）
│   ├── subagent_status_contract.json     # 子 Agent 状态枚举 v2
│   ├── slash_skill_contract.json         # /skill 语法（保留字 + name 正则）
│   └── skill_review/                     # 4 个 JSON Schema（技能包审查）
├── frontend/                         # Next.js 14 前端（src/core 镜像后端契约，见 §1.3）
├── skills/public/                    # 20 个内置技能（deep-research/podcast-generation/...）
├── config.example.yaml               # 1300+ 行配置样例（config_version: 40）
├── tests/  examples/  deploy/  docker/  scripts/  plans/  pr-build/
```

### 1.2 模块职责表

| 模块 | 路径 | 职责 | 对应 Loop 层 |
|---|---|---|---|
| Lead Agent 工厂 | `backend/packages/harness/deerflow/agents/lead_agent/agent.py:757` | 按运行时配置组装 LangChain agent 图（模型解析/鉴权、工具过滤、middleware 链、系统提示词） | Loop 1 |
| Middleware 链 | `agents/middlewares/*` | 一切横切关注点：loop 检测、token 预算、子 Agent 限额、摘要压缩、durable context 注入、安全终止 | Loop 1/2 |
| Run Worker | `runtime/runs/worker.py:761` | 一次 run 的完整生命周期：preflight → 建 agent → 流式执行 → goal 续跑循环 → 终态/回滚/收据 | Loop 1/2 |
| Run Manager | `runtime/runs/manager.py:219` | run 状态机 + 租约（lease）+ 心跳 + 孤儿回收 + 分布式取消 | 基础设施 |
| Goal 循环 | `runtime/goal.py` | /goal 目标状态、小模型评估器、隐藏续跑消息、无进展熔断 | Loop 2 |
| Subagent 执行器 | `subagents/executor.py:765` | 子 Agent 独立建图、独立事件循环、容量闸门、turn 上限恢复 | Loop 1→2 |
| 验收检查 | `subagents/acceptance_checks.py` + `agents/middlewares/receipt_verification.py` | maker/checker 双层：引用核对（advisory）+ 确定性验收清单（deterministic） | Loop 2 |
| Run Journal | `runtime/journal.py:218` | LangChain 回调 → RunEvent 记录 → 事件存储（带缓冲/flush 阈值） | 状态脊柱 |
| Checkpointer | `runtime/checkpointer/` + `checkpoint_state.py` | LangGraph checkpoint（Full/Delta 双通道模式）+ 状态快照访问器 | 状态脊柱 |
| 消息网关 | `backend/app/channels/` | 12 类 IM/webhook 入站 → MessageBus → ChannelManager → Gateway run；出站回流 | Loop 3 |
| 调度器 | `backend/app/scheduler/service.py:28` + `scheduler/schedules.py:35` | cron/once 定时任务：认领、排队、租约恢复、完成回调 | Loop 3 |
| Sandbox | `sandbox/` | 抽象接口 + 本地实现 + 远端 provider + 执行租约 + 命令作用域隔离 | 执行环境 |
| Memory | `agents/memory/manager.py` | 9 方法契约 + 可插拔后端（deermem/mem0/openviking）+ 摘要前 flush 钩子 | 状态脊柱 |
| Skills | `skills/` | SKILL.md 解析、延迟发现目录、/slash 激活、安全扫描、安装器 | Loop 1 增强 |
| Contracts | `contracts/*.json` | Python/TypeScript 双端共享的冻结契约（枚举/schema/兼容规则） | 全层 |

### 1.3 backend / contracts / frontend 三方分工

- **backend** 分两层：`backend/app/` 是 FastAPI 应用层（Gateway 路由、消息网关、调度循环），`backend/packages/harness/deerflow/` 是可独立复用的 harness 库——`runtime/goal.py:5` 明确写着 goal 原语"harness 可以在不 import FastAPI 的情况下评估和续跑 run"。这种 app/harness 分离使同一套 harness 既可被 LangGraph Server 加载（`make_lead_agent`，见 `agents/lead_agent/agent.py:757-759`），也可被嵌入式 `DeerFlowClient`（`client.py`）和 Gateway worker 三种宿主驱动。
- **contracts/** 是跨语言"宪法"：4 个 JSON 文件冻结了**事件流 schema**（`contracts/run_event_stream_contract.json` 的 `compatibility` 块明确列出 additive 与 breaking 变更清单，规定"consumer 必须忽略未知事件类型"）、**子 Agent 状态枚举**、**/skill 语法**。它不是文档摆设——`backend/tests/test_subagent_status_contract.py:31-38` 的测试把 Python 枚举与 JSON fixture 钉死，任何一侧改动不过 CI；前端 `frontend/src/core/tasks/subtask-result.ts:37-44` 注释直接声明"镜像 Python 契约、由共享 fixture 双侧钉死"。
- **frontend** 的 `src/core/` 按后端域组织镜像消费者（tasks/messages/skills/memory/scheduled-tasks/subagent-batches...），UI 层只消费 contract 字段，不解析模型文本。

**对多端一致的关键设计**：契约只钉**枚举词汇表和 envelope schema**，不钉业务结构。例如 `subagent_stop_reason`（token_capped/turn_capped/loop_capped）作为**加性字段**加入 v2 契约（`contracts/subagent_status_contract.json` 的 `valid_stop_reason_values`），老前端读不到就忽略，新前端用它区分"完成"与"被预算截断"——`subagents/status_contract.py:91-99` 的注释明确记录了这个演进决策（#3875 Phase 2 用 additive 字段替代新增状态枚举值，避免破坏 v1 消费者）。

---

## 2. Super Agent 主循环（最重要章节）

### 2.1 总体形态：三层嵌套循环

DeerFlow 的"主循环"不是手写的 while 循环，而是三层嵌套：

1. **最内层（Loop 1）**：LangChain `create_agent` 的标准 agent loop（model → tool_calls → tools → model...），由 `agents/lead_agent/agent.py:1182-1188` 组装，横切行为全部由 middleware 链在 model 调用前后拦截实现（`build_middlewares`，`agent.py:457-732`）。
2. **中层（单次 run）**：`runtime/runs/worker.py:761` 的 `run_agent()`——preflight（等待前序 run finalizing、获取租约、捕获回滚点、快照工作区）→ `_stream_once()` 流式执行一轮用户可见对话 → 终态判定。
3. **外层（goal 续跑循环）**：run 结束后由小模型评估器判断目标是否达成，未达成则注入一条**对用户隐藏的续跑消息**再次进入 `_stream_once`，直到满足/熔断/被打断。

### 2.2 核心：goal 续跑循环的代码级实现

主循环的灵魂在外层。`worker.py:1281-1307`：

```python
        # 7. Stream the requested turn, then optionally continue hidden goal turns.
        # Clear any stale stop_reason before the first (user-visible) turn only.
        # Continuation turns preserve a cap reason from the user turn: a run that
        # hits a cap during the user turn IS capped even if hidden goal-evaluator
        # turns complete cleanly afterward (#4176 review).
        if isinstance(runtime.context, dict):
            runtime.context.pop("stop_reason", None)
        await _stream_once(graph_input, initial_runnable_config)
        while not record.abort_event.is_set() and not llm_error_fallback_message and (journal is None or not journal.had_llm_error_fallback):
            continuation_input = await _prepare_goal_continuation_input(
                bridge=bridge, accessor=accessor, checkpointer=checkpointer,
                thread_id=thread_id, run_id=run_id, model_name=record.model_name,
                app_config=ctx.app_config,
                evaluator_model_factory=_get_goal_evaluator_model,
                abort_event=record.abort_event, ...
            )
            if continuation_input is None or record.abort_event.is_set():
                break
            await _stream_once(continuation_input, _continuation_runnable_config())
```

`_prepare_goal_continuation_input`（`worker.py:1834-2028`）是"裁判+守门"的完整实现，流程：

1. 读 checkpoint 里的 `goal` 通道（`goal.py:464`），非 active 则返回 None；
2. 物化 checkpoint 消息，检查 **"durable goal turn receipt"**（`worker.py:1906`）——最后一条可见消息必须是 AI 且 checkpoint 无 pending_writes（`worker.py:1730-1747`），否则视为 run_failed 熔断（`stand_down_reason="no_durable_end_of_turn"`）；
3. 调用评估器（详见 2.3）；
4. **竞态复核**：评估期间若 goal 实例、checkpoint id 或可见对话签名变化（用户插话或 /goal clear），评估结果作废（`worker.py:1940-1955`）；
5. 满足 → 清除 goal 并发布 values 事件（`worker.py:1957-1983`）；不满足且可续 → 递增计数、写入 goal、构造续跑输入（`worker.py:1990-2028`）。

### 2.3 停止条件与轮次控制：五重闸门

**（a）评估器与干活模型分离（maker/checker 贯穿到停止条件）**。评估器是一个**关闭 thinking 的小模型**（`goal.py:226-247`）：

```python
def create_goal_evaluator_model(*, model_name=None, app_config=None) -> Any:
    """Create the non-thinking chat model used by the goal evaluator."""
    return create_chat_model(
        name=model_name, thinking_enabled=False,
        app_config=app_config, attach_tracing=True,
    )
```

它的系统指令（`goal.py:285-294`）是"严格完成度评估器"人设，核心约束：

```python
    system_instruction = (
        "You are a strict completion evaluator for an AI coding assistant.\n"
        "Decide whether the active goal is fully satisfied using ONLY the visible conversation evidence.\n"
        "Do not assume files, commands, tests, or external state changed unless the conversation explicitly shows it.\n"
        "If the visible evidence is too weak to prove progress, fail closed with blocker missing_evidence.\n"
        ...
        'Output exactly one JSON object: {"satisfied": boolean, "blocker": string, "reason": string, "evidence_summary": string}.'
    )
```

输出是结构化 JSON，`blocker` 枚举六值（`goal.py:41-48`）：`none / missing_evidence / needs_user_input / run_failed / external_wait / goal_not_met_yet`，**只有 `goal_not_met_yet` 允许续跑**（`CONTINUABLE_GOAL_BLOCKERS`，`goal.py:49`）——"需要用户输入""外部等待""证据不足"全部停机，防止 Agent 拿着模糊理由空转。

**（b）双重轮次预算**（`goal.py:33-34`）：`DEFAULT_MAX_GOAL_CONTINUATIONS = 8`（最多 8 个隐藏续跑轮）、`DEFAULT_MAX_NO_PROGRESS_CONTINUATIONS = 2`（最多 2 个无进展轮）。

**（c）无进展熔断的巧妙设计**。无进展的判定**不依赖评估器的自由文本**（LLM 每轮都会换措辞，永远不重复），而是对"最新可见 AI 消息文本"做 SHA256 签名（`goal.py:345-361`），progress_key = `{satisfied, blocker, evidence_signature}` 的 JSON（`goal.py:364-379`）。签名连续相同 → `no_progress_count+1`；任何一项变化 → 归零（`goal.py:382-390`）：

```python
def compute_no_progress_count(goal, evaluation, *, evidence_signature="") -> int:
    if evaluation["satisfied"]:
        return 0
    progress_key = compute_goal_progress_key(evaluation, evidence_signature=evidence_signature)
    previous = goal.get("last_evaluation", {})
    if isinstance(previous, dict) and previous.get("progress_key") == progress_key:
        return int(goal.get("no_progress_count", 0)) + 1
    return 0
```

**（d）四重停止闸门汇总**在 `should_continue_goal`（`goal.py:332-342`）：satisfied → 停；blocker 不可续 → 停；continuation_count 达上限 → 停；no_progress_count 达上限 → 停。`_stand_down_reason`（`worker.py:1750-1761`）把停止原因分类成 `blocked:<blocker> / max_continuations_reached / no_progress_detected` 持久化到 goal state，供前端 goal-status 展示。

**（e）续跑消息对用户隐藏**。续跑输入是一条带 `hide_from_ui: True` 的 HumanMessage（`goal.py:393-410`），内容包裹在 `<goal_continuation>` 标签里并携带评估器结论，让 Agent 拿着裁判反馈继续干：

```python
def make_goal_continuation_message(goal, evaluation) -> HumanMessage:
    content = (
        "<goal_continuation>\n"
        f"Active goal: {goal['objective']}\n"
        f"Evaluator result: not satisfied. Blocker: {evaluation['blocker']}. Reason: {evaluation['reason'] or 'No reason provided.'}\n"
        ...
        "Continue working toward the active goal. Use the available tools and conversation context. "
        "Do not ask the user to continue unless you are genuinely blocked.\n"
        "</goal_continuation>"
    )
    return HumanMessage(content=content,
        additional_kwargs={"hide_from_ui": True, "deerflow_goal_continuation": True})
```

**（f）goal 状态写入的乐观并发控制**：goal 存活在 LangGraph checkpoint 的 `goal` 通道里（`goal.py:476-538`），写入时校验 `expected_checkpoint_id`，不匹配抛 `GoalWriteConflict`（`goal.py:501-502`），调用方静默放弃（`worker.py:1815-1816`）——保证竞态中的陈旧评估写入"自行退位"而不是覆盖新目标。`worker.py:1790-1795` 还有防御性注释：在锁内从新鲜 goal 重算 continuation_count，取 `max(调用值, 当前值+1)` 防止双重计数。

### 2.4 规划→分发→执行→汇总

- **规划**：lead agent 没有独立的 planner 节点。规划能力由两条路径承担：① `is_plan_mode` 请求参数启用 `TodoMiddleware`（`agent.py:586-591`，write_todos 工具的完整 prompt 在 `agent.py:345-444`，含"完成一项立刻标记、保持恰好一个 in_progress"的实时纪律）；② 系统提示词中的委托决策框架（`agents/lead_agent/prompt.py:409-517`）——一个显式的**净收益比较**模板："Expected cost = delegation and startup overhead + duplicate context + coordination and synthesis + state-conflict risk"，并给出正反示例（"Refactor auth implementation and its tests directly... Complexity alone does not justify delegation"）。
- **分发**：`task` 工具（`tools/builtins/task_tool.py:646`）是唯一委派入口，docstring（646-745 行）本身就是委托政策：何时用/何时不用/成本清单/如何读结果。并发与总量由 `SubagentLimitMiddleware` 强制（`agents/middlewares/subagent_limit_middleware.py`：并发 clamp 到 [1,64]，总量上限触发时注入 "MAXIMUM N task CALLS PER RUN" 提示，超额的并行调用被截断）。
- **执行**：子 Agent 在独立事件循环、独立上下文、独立容量闸门中运行（§3）。
- **汇总**：结果回流到三个消费点——① `ToolMessage.additional_kwargs` 里的结构化元数据（§3.3）；② **delegation ledger**（`agents/middlewares/delegation_ledger.py`）：从消息流中确定性抽取每次委派的 description/type/status/result_brief/sha256，先于摘要压缩捕获，再由 **DurableContextMiddleware**（`agents/middlewares/durable_context_middleware.py:1-9`）在下一次 model 调用前作为 checkpoint 化的持久上下文注入（summary + ledger + skills 三个通道，渲染为隐藏 `<durable_context_data>` 消息，附"authority contract"防注入声明）。这意味着**即使摘要压缩吃掉了原始 ToolMessage，委派台账也永远在场**。

### 2.5 横切守护：三个"软熔断"middleware

所有守护共享同一模式：**不抛异常，剥掉 tool_calls 强制自然终止**，并把原因写进 `stop_reason` 供 worker 收集（`worker.py:1326-1342` 列出 loop_capped/token_capped/safety_capped/subagent_limit_capped/model_length_capped 五种）：

- **LoopDetectionMiddleware**（`agents/middlewares/loop_detection_middleware.py:1-50`）：对 tool_calls（name+args）做哈希滑窗统计，≥warn_threshold 注入"你在重复自己"警告，≥hard_limit 剥 tool_calls。警告注入特意延迟到 `wrap_model_call` 而非 `after_model`——因为 OpenAI/Anthropic 校验器要求 tool_calls 后紧跟 ToolMessage，中途插消息会被 provider 拒绝。
- **TokenBudgetMiddleware**（`agents/middlewares/token_budget_middleware.py:7-20`）：跨模型调用累计 usage（**含子 Agent**——TokenUsageMiddleware 会把子 Agent 用量回填到父历史），达到 warn 阈值注入软警告，达到 hard_stop 剥 tool_calls。
- **ModelLengthFinishReasonMiddleware / SafetyFinishReasonMiddleware / TerminalResponseMiddleware**（`agent.py:683-698`）：分别处理长度截断标记、provider 安全终止后的工具抑制、空响应重试。

---

## 3. Sub-agent 体系

### 3.1 spawn：task 工具 → SubagentExecutor → 独立事件循环

`task_tool`（`tools/builtins/task_tool.py:646`）收集父上下文（sandbox 状态、thread_data、上传文件、trace_id、user 身份、鉴权属性、run_id），构造 `SubagentExecutor` 并 `execute_async` 启动（`task_tool.py:936`），随后**由后端轮询而非让 LLM 轮询**（`task_tool.py:938-943`：`max_poll_count = (config.timeout_seconds + 60) // 5`，5 秒一拍，超时 → `polling_timed_out`）。期间通过 LangGraph `get_stream_writer()` 发 `task_started` 等 custom event 供前端渲染子任务卡片。

关键隔离机制：

- **独立事件循环**：子 Agent 跑在专用的 `_isolated_subagent_loop` 线程（`executor.py:570-697`），父循环通过复制后的 Context 提交协程，避免与 Gateway 主循环互相阻塞。跨循环传递 RunJournal 时只传代理（`task_tool.py:88-146` 的 `_ParentLoopMiddlewareRecorderProxy`），保证 journal 写回发生在拥有它的事件循环上。
- **容量闸门**：进程级 FIFO 信号量 `SubagentExecutionCapacity`（`subagents/capacity.py:37`），`_aexecute` 先 `async with capacity.slot()`（`executor.py:1300`），满员则排队、超时 `SubagentCapacityError` → 立刻 FAILED（admission_failure）。配置的并发数与向 lead 公告的数字对齐（`agent.py:497-499` 注释：startup-frozen capacity 保证"公告的与执行的"一致）。
- **禁套娃**：子 Agent 拿到的工具集 `subagent_enabled: False`（`task_tool.py:876-881`），不能再调 task。
- **身份传播**：user_role / oauth / authz_attributes / channel_user_id / is_internal 全部从父 context 复制（`task_tool.py:829-851`），保证委派出去的工具调用与父 Run 同一鉴权身份评估（注释明确指出不传会导致"role-aware policy silently mis-attributes"）。

### 3.2 执行：独立 agent 图 + values 流 + 协作取消

子 Agent 是**完整重建**的 LangChain agent（`executor.py:1417-1422`：`_build_initial_state` → `_create_agent`），不是父图的子图。执行主循环（`executor.py:1520-1556`）：

```python
            async for chunk in agent.astream(state, config=run_config, context=context, stream_mode="values"):
                # A yielded values chunk is already executed state.  Retain it
                # before observing cooperative cancellation so terminal receipt
                # harvesting includes a tool result that completed while the
                # cancellation request was in flight.
                final_state = chunk
                result.update_tool_receipts(terminal_receipts())
                result.update_bash_executions(current_bash_executions())
                # Cooperative cancellation: check if parent requested stop.
                if result.cancel_event.is_set():
                    ...result.try_set_terminal(SubagentStatus.CANCELLED, ...)
                    return result
                result.update_token_usage_records(collector.snapshot_records())
                messages = chunk.get("messages", [])
                previous_count = len(ai_messages)
                processed_message_count = capture_new_step_messages(messages, ai_messages, seen_message_ids, processed_message_count)
```

细节亮点：① **turn 上限即 `recursion_limit`**（`executor.py:1434`：`"recursion_limit": self.config.max_turns`），超限抛 `GraphRecursionError`，被捕获后**恢复部分成果**——倒序找最后一条有文本的 AIMessage，有则 `COMPLETED + stop_reason=turn_capped`，无则 `FAILED`（`executor.py:1585-1646`）；② 消息捕获用"已见 id 集合 + 游标"做 O(n) 增量（`executor.py:1373-1381` 注释解释了不做 O(n²) 重扫的原因：deep-research 子 Agent 可达 150 轮）；③ sandbox 租约在 finally 中释放（`executor.py:1657-1671`），owner_id 为 `subagent:{task_id}`（`executor.py:1336`）。

**批量子 Agent**（`subagents/batch_service.py:34` `SubagentBatchService` + `tools/builtins/batch_task_tool.py`）：大量独立同构任务（如 100 个 URL 摘要）走**持久化批表 + 轮询认领 + 租约恢复**，而非一次性塞进 context——batch item 是数据库行，崩溃后由租约回收重派。

### 3.3 通信与结构化结果契约

子 Agent 结果通过 `ToolMessage.additional_kwargs` 回流，字段全集定义在 `subagents/status_contract.py:52-61`：`subagent_status`（5 枚举值：completed/failed/cancelled/timed_out/polling_timed_out，`status_contract.py:83-89`）、`subagent_stop_reason`（token_capped/turn_capped/loop_capped）、`subagent_result_brief`（2000 字符截断）+ `subagent_result_sha256`（全量结果摘要）、`subagent_token_usage`、`subagent_tool_receipts` 等。生产端 `make_subagent_additional_kwargs`（`status_contract.py:154-208`）对枚举值**fail-loudly 校验**（写错直接 ValueError，防止拼错静默漏到消费端）。旧值 `max_turns_reached` 在读侧归一化为新形态（`status_contract.py:124-126` 的 `_LEGACY_STATUS_NORMALIZATION`），历史 checkpoint 数据不搁浅。

### 3.4 maker/checker：明确做了，且是两层

这是 DeerFlow 最值得学习的部分之一，RFC #4651 实现了**验证栈分层**：

**Layer 1 — 引用核对（advisory）**：`agents/middlewares/receipt_verification.py:1-20`。子 Agent 被要求在最终报告中为每个行动断言引用收据 id（`[rN]`），父侧把引用与从子 Agent 消息流**收割的执行记录**交叉核对。纯函数、无 LLM。词汇纪律：结论布尔叫 `citation_resolved`，**禁用** satisfied/verified/passed 这类强肯定词（"reserved for the runtime hard gate so the model never conflates advisory execution evidence with task acceptance"）。还有零引用启发式：报告含行动动词（英/中双列表，`receipt_verification.py:26-36`）或文件路径但无任何引用 → UNVERIFIED；超 240 字符的报告 + 非空收据账本 + 零引用 → 无条件 UNVERIFIED（`receipt_verification.py:38-41`）。

**Layer 2 — 确定性验收清单（deterministic）**：`subagents/acceptance_checks.py:1-54`。lead 在 `task` 调用上附带 `acceptance_criteria`（如 `file:report.md non-empty`、`tests_passed:npm test`），子 Agent 完成后**由代码**逐条判定：

```python
_FILE_LEAF_RE = re.compile(r"^file:(?P<path>.+?)\s+(?P<mode>exists|non-empty)$", re.IGNORECASE)
_FILE_WRITTEN_RE = re.compile(r"^file_written:(?P<path>.+)$", re.IGNORECASE)
_TESTS_PASSED_RE = re.compile(r"^tests_passed:(?P<command>.+)$", re.IGNORECASE)
```

设计原则（docstring 1-54 行）极其克制：① 文件叶子读取**限定在线程工作区根内**（越界 → UNVERIFIED 而非猜测），字节上限 50KB，远程沙箱用 `env -i` 的 stat 探针防被污染会话操纵；② `tests_passed` 必须锚定**一条具体记录在案的 bash 执行**且输出尾部匹配测试摘要形状（`acceptance_checks.py:100-123` 的 pass/fail/zero 三组正则识别 pytest/jest/go/cargo/unittest/maven），`echo "npm test"` 冒充不了；③ 无法确定性判定的 criteria 一律 `checked=False` 渲染为 UNVERIFIED——"never silently passed"；④ criteria 文本作为**不可信数据**追加到子 Agent 的任务 HumanMessage，绝不进 SystemMessage（`task_tool.py:905-911` 注释："criterion text can never gain system-channel authority"）。

**分层总结**：子 Agent 写代码（maker）→ 评估器小模型判 goal（checker A）→ 引用核对判"执行过没"（checker B，advisory）→ 验收清单判"客观条件成立没"（checker C，deterministic）。`task` 工具 docstring（`task_tool.py:709-723`）把这套语义直接教给 lead："completed means execution ended, not task acceptance... UNVERIFIED is missing evidence, not a failed condition"。

---

## 4. 长时程任务的分段与恢复

分钟~小时级任务在 DeerFlow 中被拆成四个正交的分段/恢复轴（对应 agentdeck 的 issue-store/event-log/goal-store）：

### 4.1 状态脊柱的三层存储

| 层 | 存储 | 内容 | 对应 agentdeck |
|---|---|---|---|
| LangGraph checkpoint | `runtime/checkpointer/`（SQLite/Postgres/Redis，Full 与 Delta 双通道模式，`runtime/checkpoint_mode.py`） | 消息历史 + goal 通道 + delegation ledger + skills 等状态通道 | goal-store + 会话状态 |
| Run 事件流 | `run_events` 表（`persistence/models/run_event.py`），经 `runtime/events/store/db.py:33` `DbRunEventStore` 落库 | run.start/llm.ai.response/llm.tool.result/subagent.start|step|end/workspace.changes/middleware:* 等（事件目录 `runtime/events/catalog.py:48-80`） | event-log |
| Run 行 | `persistence/run/model.py`（20 个 alembic 迁移支撑） | 状态机 + 租约 + token 用量 + stop_reason + delivery 收据 | issue-store（弱对应） |

`RunJournal`（`runtime/journal.py:218`）是 LangChain 回调 → 事件存储的桥梁：缓冲写（flush_threshold=20）、token 用量累计、按 caller 标签（lead_agent/subagent:{name}/middleware:{name}）归因。

### 4.2 一次 run 的"事务边界"

`run_agent` 的 preflight（`worker.py:1106-1141`）在动线程状态前**先捕获回滚点**（物化消息 + 原始 pending writes），任何快照失败则**禁用回滚**（"restoring an empty or partial message history would silently truncate the thread"）。finally 块（`worker.py:1389-1520`）按严格顺序收尾：flush 子 Agent 事件缓冲 → 记录工作区变更 → flush journal → **幂等写 delivery receipt**（run-scoped idempotent write，与崩溃恢复共享，`worker.py:1459`）→ 持久化终态 → 写 run 时长 checkpoint。取消分两档（`worker.py:841-883`）：`interrupt` 保留 checkpoint；`rollback` 恢复到 pre-run checkpoint 并 fork 血统（`worker.py:2226` `_rollback_to_pre_run_checkpoint`）。**edit-replay 失败自动回滚**（`worker.py:1397-1419`）：编辑重放的 run 未成功则恢复 pre-run 状态并向流上发布恢复后的 values。

### 4.3 崩溃恢复：租约 + 心跳 + 孤儿回收

多 worker 部署下每个 run 行携带 `lease_expires_at`（`manager.py:1409-1422`，心跳续期）；worker 死亡后任何 peer 可在宽限期后 `claim_for_takeover` 接管并标记 error（`manager.py:1362-1385`）：

```python
        grace_seconds = self.grace_seconds
        lease_expires_at: str | None = row.get("lease_expires_at")
        if not is_lease_expired(lease_expires_at, grace_seconds=grace_seconds):
            return await self._request_remote_cancel(run_id, action=action)
        take_over_msg = f"Run reclaimed by worker {self._worker_id}: the owning worker ({row.get('owner_worker_id') or 'unknown'}) stopped renewing its lease and is presumed dead."
        taken = await self._call_store_with_retry(
            "claim_for_takeover", run_id,
            lambda: self._store.claim_for_takeover(run_id, grace_seconds=grace_seconds, error=take_over_msg),
        )
```

接管的 peer 还会为孤儿 run **补写零投递收据**（`manager.py:1035-1056` `_ensure_delivery_receipt`，"Idempotently persist a zero-delivery receipt during recovery"），保证下游"投递必有收据"的不变量跨崩溃成立。丢租约的 worker 在每个持久化点被 fence（`manager.py:379-381`："Skipped status update ... after lease ownership was lost"）。

### 4.4 历史迁移与分支播种

`runtime/journal.py:100-176` 的 `_build_history_seed_events` 把 checkpoint 消息序列化成事件行，**每个持久化 HumanMessage 开一个合成 run**（`{prefix}-{n}`）——注释（112-119 行）解释了为什么不能共享一个 id：分支上第一次 regenerate 会把整个继承历史删掉（#4458）。这是"两种存储（checkpoint 与事件流）共存"的必然代价：需要种子迁移逻辑保持一致，且迁移规则必须精确复刻 RunJournal 的持久化语义（哪些隐藏消息保留、`restore_original_human_message` 等，118-137 行逐条列举）。

### 4.5 长时程的"分段"实质

DeerFlow 没有显式的"阶段（phase）"对象。长任务被切分为：**run（用户可见一轮）→ goal continuation（隐藏续跑轮，最多 8）→ 子 Agent turn（受 max_turns 限制，超限恢复部分成果）→ 批 item（持久化行，租约恢复）**。跨段连续性靠三个 durable 通道：goal（裁判状态）、delegation ledger（委派台账，摘要压缩后仍在）、memory（跨 thread 用户级事实）。上下文膨胀由 `SummarizationMiddleware`（991 行）+ `tool_output_budget/synopsis` + `context_compaction.py` 多级治理，且摘要前触发 memory flush（`agents/memory/summarization_hook.py:16-28`，"Flush messages about to be summarized into the memory queue"——被压缩掉的内容先进记忆队列，不丢失）。

---

## 5. Sandbox / Memory / Skills 三大构件

### 5.1 Sandbox：抽象接口 + 执行租约 + 命令作用域

- **两级抽象**：`Sandbox`（`sandbox/sandbox.py:44`，单实例：execute_command/read_file/write_file/list_dir/search）与 `SandboxProvider`（`sandbox/sandbox_provider.py:14`，创建/复用实例）。实现有 local（`sandbox/local/`）、community 三家远程（e2b/opensandbox/aio，`community/` 目录），由 `get_sandbox_provider()` 按 config 解析。
- **诚实的元数据声明**：`persistent_shell_sessions` 三态属性（`sandbox/sandbox.py:49-64`）——AIO 声明 True（会话状态跨调用存活），逐次 exec 的实现声明 False，**未声明的自定义 provider 一律按不可信处理**，验收检查的 `tests_passed` 对持久会话的记录降级 UNVERIFIED（"a recorded command's environment cannot be proven clean"）。接口层还内置防御：`extra_env` 键校验 POSIX 变量名防注入（`sandbox/sandbox.py:17-41`），注释明确这是"为未来可能拼接 shell 的实现预置的纵深防御"。
- **进程内租约**：`sandbox/lease.py:1-8`——"provider ownership 回答哪个 Gateway 实例可以回收远端沙箱；本模块回答同一 Gateway 内哪些并发执行还在用活跃客户端。只有最后一个执行租约才能调 release"。租约配合 `execute_command_in_scope(scope_id)`（`sandbox/sandbox.py:110-129`）让并发子 Agent 的 shell 互相隔离；子 Agent 的 scope_id 就是 `subagent:{task_id}`（`executor.py:1495-1496`）。
- **安全分层**：env_policy（环境变量白名单）、path_patterns、security.py（路径逃逸防护）、`SandboxAuditMiddleware`（531 行，审计中间件）、`file_operation_lock.py`（文件操作锁）。
- 每线程独立工作区目录（workspace/uploads/outputs），文件读写经虚拟路径 `/mnt/user-data/...` 映射（`acceptance_checks.py:149-195` 的 `_resolve_scoped_path` 展示了虚拟路径 → 宿主路径 → 作用域校验 → 回转虚拟路径的全过程）。

### 5.2 Memory：9 方法契约 + 可插拔后端 + 两种接入模式

`agents/memory/manager.py:1-12` 开宗明义："Swap backend = drop a backends/<name>/ folder exposing MANAGER_CLASS and set manager_class: <name>. Nothing else in deer-flow changes."。契约是 pydantic BaseModel（而非裸 ABC），后端缺 add/get_context 会在**实例化时** TypeError（"memory is persistent state; a backend missing add is a severe bug, caught at construction"，`manager.py:104-110`）。方法分级：tier-1（add/get_context）是 abstractmethod，tier-2/3 有 noop 默认。记忆按 `(agent_name, user_id)` 分桶，thread_id 对齐会话。

后端三家：自研 **DeerMem**（core/updater.py 2326 行 + storage.py 1853 行，含提取/检索/队列/纠正强化检测）、mem0、openviking。两种接入：**tool 模式**（Agent 主动调 memory_search/add/update/delete 四工具，`agents/memory/tools.py:50-240`）与**被动模式**（MemoryMiddleware 排队 + 摘要前 flush 钩子）。

### 5.3 Skills：SKILL.md + 延迟发现 + 三段激活管线

- **载体**：SKILL.md + frontmatter（`skills/frontmatter.py` 解析），带 `allowed_tools`、`required_secrets`（按需注入请求级密钥到沙箱子进程环境，issue #3861）、`secrets-autonomous` 开关。四类别：PUBLIC（内置 20 个，`skills/public/`：deep-research/podcast-generation/ppt-generation/skill-creator/skill-reviewer...）/CUSTOM/INTEGRATION/LEGACY（`skills/types.py:9-24`）。
- **延迟发现**：`skills/catalog.py:1-9`——系统提示词只放 `<skill_index>` 里的名字，模型需要时调 `describe_skill` 检索元数据（支持 `select:a,b` / `+required rank` / 自由 regex 三种查询，最多 5 条）。目的："keep the system prompt compact and prefix-cache friendly"。工具侧同构的 `DeferredToolCatalog`（`tool_search.py`）+ `DeferredToolFilterMiddleware` 对 MCP 工具做同样的事。
- **激活三段管线**：① `/skill-name` 显式激活 → `SkillActivationMiddleware` 确定性加载全文（`agent.py:529-542`，"explicit user activation priority over model-side relevance guessing"）；② 运行时按相关性自主加载（受 `secrets-autonomous` 门控）；③ `SkillToolPolicyMiddleware` 在激活后才应用 allowed-tools 限制（"skills are only discoverable metadata until activated"，`agent.py:553-563`）。
- **供应链安全**：`skills/security_scanner.py`（LLM 扫描）+ `security_static_scanner.py`（静态）在 skill_manage 安装时扫描；`contracts/skill_review/` 下 4 个 JSON Schema 定义技能包审查的输入输出。`/skill` 语法本身有跨语言契约（`contracts/slash_skill_contract.json`：8 个保留字 + name 正则 `^/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s+|$)`）。

---

## 6. 消息网关与事件驱动（Loop 3）

### 6.1 入站：12 类 channel → MessageBus → run

`backend/app/channels/` 是一个完整的 IM 网关层：slack/discord/telegram/feishu/dingtalk/wechat/wecom/github(webhook)/buzz(nostr)。架构（`channels/message_bus.py:1` + `channels/manager.py:1`）：

- `MessageBus` 是异步 pub/sub 枢纽，解耦 channel 适配器与分发器；入站消息标准化为 `InboundMessage`（channel_name/chat_id/user_id/text/files/metadata，支持 topic_id → DeerFlow thread 映射：同 topic 复用 thread，无 topic 则一问一答新 thread）。
- `ChannelManager` 消费消息并经 HTTP 调 Gateway 创建 run（`channels/manager.py:36-40` 的默认端点），出站流式回帖有节流（1 秒或 60 字符一 flush）。
- **运行策略按 channel 定制**：`run_policy.py` + `feishu_run_policy.py`/`buzz_run_policy.py`——不同 IM 有不同的并发上限（默认 5）、目标模型、subagent 开关；`CHANNEL_RUN_POLICY` 注册表分发。
- **入站去重**：`dedupe_store.py`，10 分钟窗口（`channels/manager.py:80-92` 长注释解释了为何选这个窗口，并引用 GitHub 文档说明 GitHub webhook 失败不重发）；多实例部署用 Postgres 共享去重存储。
- **untrusted 边界意识**：github webhook 渠道被标记为不可信（`agent.py:81-87` `_WEBHOOK_CHANNELS`），该渠道触发的 run **拿不到 update_agent 等管理工具**（`agent.py:1114-1129`）——外部评论者不能借 @bot 改 Agent 的 SOUL.md/模型/工具组。

### 6.2 定时：ScheduledTaskService

`backend/app/scheduler/service.py:56-77` 的 `run_once` 是经典数据库轮询认领模式：

```python
    async def run_once(self, *, now: datetime) -> None:
        if self._multi_instance:
            ...await self._reconcile_active_state(now=now)
        else:
            await self._task_run_repo.recover_expired_launch_claims(
                error=_LEASE_RECOVERY_ERROR, now=now)
        await self._expire_waiting_runs(now=now)
        await self._drain_queue(now=now)
        # Admission and execution capacity are separate. Due occurrences are
        # persisted even when all execution slots are busy; claim_queued_run()
        # applies the global launch budget under the database lock.
        claimed = await self._task_repo.claim_due_tasks(
            now=now, lease_owner=self._lease_owner, lease_seconds=self._lease_seconds,
            limit=self._max_concurrent_runs)
        for task in claimed:
            await self._dispatch_task(task, now=now, trigger="scheduled")
```

`scheduler/schedules.py:35-59` 的 `next_run_at` 支持 cron（croniter + 时区）与 once（naive 时间按任务时区解释）两种。工程细节：**准入与执行容量分离**（due 的触发先落库排队，执行槽空闲再认领）；同 thread 已有活跃 run 时排队而非丢弃（`_active_run_conflict_result`/`_queued_result`）；run 完成回调 `handle_run_completion`（service.py:515）驱动 `once` 任务终态；`context_mode: fresh_thread_per_run` 支持每次全新 thread。手动触发失败**不消耗**调度的未来（service.py:88-97 的注释专门处理了这个语义）。

Loop 3 生态总结：cron（定时）+ IM/webhook（事件）+ channels 去重/限流/运行策略 + scheduler 排队/租约。**Loop 4（自我改进）没有系统化实现**——`reflection/` 目录只是 importlib 类解析工具（与"反思"无关），最接近 Loop 4 的是 skills 的 skill-creator/skill-reviewer 技能与 trace 导出（Monocle/Langfuse 观测），即"人看 trace 改技能"，而非自动改写。

---

## 7. 与 agentdeck 的对照与可借鉴点（最重要章节）

### 7.1 逐条可借鉴设计

| # | DeerFlow 设计 | 出处 | 对应 agentdeck 模块 | 为什么值得搬 |
|---|---|---|---|---|
| 1 | **goal 评估器 = 独立非 thinking 小模型 + fail-closed blocker 枚举**：六值 blocker，只有 `goal_not_met_yet` 可续跑，其余（missing_evidence/needs_user_input/run_failed/external_wait）全部停机 | `runtime/goal.py:41-49, 285-294` | `goal-controller.ts` | agentdeck 的 goal 循环目前主要靠"目标达成或轮数上限"。引入**类型化 blocker + 白名单续跑**能把"该问人/该等外部/证据不足"从"继续空转"里摘出来，这是防 token 黑洞的最便宜手段。评估器复用主模型但关 thinking 也是现成做法 |
| 2 | **无进展熔断基于产出签名而非裁判文本**：对最新可见 AI 消息文本做 SHA256，`{satisfied, blocker, signature}` 三元组连续相同才计 no_progress | `runtime/goal.py:345-390` | `goal-controller.ts` | LLM 裁判每轮换措辞，任何基于 reason 文本的对比都会失效。**以 Agent 实际产出（而非裁判转述）为进展证据**是这个问题的通用解，agentdeck 的 goal-store 加一个 `progress_key` 字段即可 |
| 3 | **续跑消息 hide_from_ui + 携带裁判反馈**：隐藏 HumanMessage 包 `<goal_continuation>` 标签，含 objective/blocker/reason/evidence_summary | `runtime/goal.py:393-410` | `goal-controller.ts` + `runner.ts` | agentdeck 做 round notes 时可借鉴：下一轮注入的"驱动消息"应当结构化携带上轮裁决（而不是干巴巴的"continue"），且用户界面不因内部续跑而闪烁 |
| 4 | **goal 写入乐观并发（expected_checkpoint_id）+ 锁内重算计数取 max** | `runtime/goal.py:501-502`、`worker.py:1790-1795` | `goal-store.ts` | agentdeck 的 goal-store 若支持用户随时 /goal clear，同样需要"陈旧写入自行退位"语义；取 max 防计数双计是现成坑位规避 |
| 5 | **验证栈分层 + 词汇纪律**：citation_resolved（advisory）≠ 验收（deterministic）；禁用 satisfied/verified/passed 于 advisory 层 | `receipt_verification.py:1-20`、`acceptance_checks.py:47-50` | `retry-policy.ts` + `task-finalizer.ts` | agentdeck 的验证循环可以显式分两层：证据核对（"执行过"）与结果验收（"成立"），并**在 prompt 与数据结构两个层面**禁止混用强肯定词，防止 Agent 把 advisory 当 acceptance |
| 6 | **确定性验收清单**：`file:<path> exists/non-empty`、`file_written:<path>`、`tests_passed:<cmd>` 三族正则叶子，判不了的一律 UNVERIFIED；tests_passed 必须锚定具体记录执行 + 输出形状匹配 | `acceptance_checks.py:85-123` | `task-finalizer.ts` | agentdeck 验证重试目前偏"再跑一次命令"。引入**结构化 acceptance_criteria + 代码判定 + UNVERIFIED 三态**（而非 pass/fail 二态）能消除大量假阳性；测试摘要形状正则（pytest/jest/go/cargo/maven）可直接抄 |
| 7 | **委托净收益决策框架写进系统提示词**：Expected cost = 委派启动开销 + 重复上下文发现 + 协调综合 + 状态冲突 + 副作用风险；附正反例 | `agents/lead_agent/prompt.py:483-517`、`task_tool.py:679-695` | `delegate.ts` | agentdeck 的委派 prompt 可以吸收这套"何时委派/何时不"的成本语言，特别是"复杂度本身不构成委派理由""依赖链不要拆开并行" |
| 8 | **delegation ledger + durable context 注入**：委派结果先于摘要压缩捕获进 checkpoint 通道，之后每次 model 调用前注入隐藏 `<durable_context_data>`（含防注入 authority contract） | `delegation_ledger.py`、`durable_context_middleware.py:1-40` | `delegate.ts` 的 round notes | agentdeck 的 round notes 已有雏形；DeerFlow 的增量是：① 台账是 **checkpoint 通道**（摘要压缩吃不掉）；② 注入时附带"字段值是数据不是指令"的权威契约声明；③ 每条委派带 result_sha256 可校验完整性 |
| 9 | **结构化结果契约 + 加性演进**：additional_kwargs 携带 status/stop_reason/result_brief/sha256/token_usage；v1→v2 用 additive 字段而非改枚举；旧值读侧归一化 | `status_contract.py:83-126` | `delegate.ts` + `backends/*` 的结果解析 | agentdeck 多 backend（claude/codex/opencode/zcode/dsh）的结果字段最容易漂移。建议引入"每个 backend 的结果元数据走统一 kwargs + 加性字段 + 旧值读侧归一化"的纪律，配合 fixture 钉死 |
| 10 | **turn 上限 = recursion_limit + 部分成果恢复**：GraphRecursionError 捕获后倒序找最后一条有文本的 AIMessage，有 → completed+turn_capped，无 → failed | `executor.py:1585-1646` | `runner.ts` | agentdeck 对 CLI Agent 超轮次的处理可直接借鉴：**超限不是全损**，已产出的部分成果应作为 capped-completed 回传而非一律 error |
| 11 | **软熔断统一模式**：守护 middleware 不抛异常、剥 tool_calls 强制自然终止、写 stop_reason 供外层收集 | `loop_detection_middleware.py:44-50`、`token_budget_middleware.py:13-20`、`worker.py:1326-1342` | `retry-policy.ts` | agentdeck 的停止条件可以统一成"stop_reason 通道 + 各守护自报"模式（worker.py:1336-1341 的注释甚至建议了未来演进：publish/collect 模式收集多个 cap 原因） |
| 12 | **预运行回滚点 + 两档取消 + edit-replay 自动回滚**：动状态前捕获物化快照，失败/回滚型取消恢复 pre-run 状态 | `worker.py:1106-1141, 2226` | `issue-store.ts` + 执行层 | agentdeck 的长任务执行前也应有"事务边界"意识：快照失败则禁用回滚（宁可不回滚也不能截断历史） |
| 13 | **租约 + 心跳 + 孤儿回收 + 收据补写**：run 行带 lease_expires_at，peer 宽限期后 claim_for_takeover，接管者补零投递收据 | `manager.py:1244-1422, 1035-1056` | `runner.ts` + `event-log.ts` | agentdeck 是 Electron 单进程，但 CLI 子进程崩溃/应用重启后的"孤儿 run"问题同构：给 run 记录加启动时间戳 + 重启时扫描未终态 run 补终态与事件，是桌面版的租约回收 |
| 14 | **摘要压缩前 flush 进记忆队列**：被压缩 ≠ 被遗忘 | `agents/memory/summarization_hook.py:16-28` | （新）上下文治理 | agentdeck 长会话压缩时，可在压缩钩子里把被删消息沉淀进本地 notes/issue-store，而不是纯丢弃 |
| 15 | **cron 调度的准入/执行分离 + once 语义保护**：due 触发先落库排队；手动触发失败不消耗调度未来；once 任务终态由完成回调驱动而非启动时预写 | `scheduler/service.py:56-97` | `scheduler.ts` | agentdeck 的定时调度可直接吸收：排队不丢弃、once 状态机由真实终态驱动（防进程死亡后卡 running） |
| 16 | **契约 fixture + CI 双侧钉死**：contracts/*.json 被 Python 测试与 TS 消费者共同引用，枚举漂移即红 | `test_subagent_status_contract.py:31-38`、`frontend/src/core/tasks/subtask-result.ts:37-44` | 全模块（新 practice） | agentdeck 是 TS 单语言，但**主进程 ↔ 渲染进程 ↔ 各 backend 适配层**之间同样需要冻结契约（如 run 事件 schema）；用 JSON fixture + 双侧测试是最便宜的防漂移手段 |
| 17 | **不可信渠道工具裁剪**：webhook 渠道拿不到 update_agent | `agent.py:81-87, 1114-1129` | `permission-broker.ts` | agentdeck 接入外部触发（如 git hook / IM）时，应按**触发来源可信度**裁剪工具面，而不是只按用户身份 |
| 18 | **子 Agent 容量闸门与公告一致**：进程级 FIFO 容量，startup 冻结，配置公告数 = 执行强制数 | `capacity.py:37`、`agent.py:497-499` | `delegate.ts` | agentdeck 并行 CLI Agent 也需要：向主 Agent 公告的并发上限必须与实际信号量一致，否则 prompt 里说能开 8 个实际只跑 3 个，主 Agent 会错误规划 |

### 7.2 架构选择的启示

**（a）contracts-first 的真实含义**。DeerFlow 的 contracts/ 只钉**词汇表和 envelope**（枚举值、必填字段、兼容规则），把业务结构留给单一语言实现——这是"最小契约面"策略。加性演进规则（"consumer 必须忽略未知字段"、additive_changes/breaking_changes 清单）使得 v1→v2 过渡零停机。agentdeck 在主进程/渲染进程/backend 适配层之间引入这层，成本一天，收益是永久防漂移。

**（b）middleware 化的横切关注点**。DeerFlow 把 loop 检测、预算、限额、摘要、durable context、安全全部做成 `AgentMiddleware`，主循环保持极简（worker 只管"流式执行 + goal 续跑 + 终态"）。agentdeck 的 runner.ts 若不断长胖，可以考虑同构的"执行中间件"数组（before-model/after-model/before-agent/after-agent 四挂点），每层单一职责、可独立测试。

**（c）"诚实降级"哲学**。全代码库反复出现同一模式：拿不到证据 → UNVERIFIED（不是 fail 也不是 pass）；快照失败 → 禁用回滚（不是强行回滚）；自定义沙箱未声明会话语义 → 按不可信处理；评估器异常 → 放弃续跑（不是猜一个结论）。**宁可少承诺，不可假阳性**——这对 agentdeck 的验证循环是直接的世界观输入。

**（d）harness 与 app 分离**。`deerflow`（harness 包）不 import FastAPI，goal/事件/执行原语全部在 harness 层，Gateway 只是宿主之一。agentdeck 的 runner/backends 与 Electron 壳之间保持同构分离，未来可平移到 CLI/server 形态。

**（e）文档即代码的注释文化**。几乎所有关键决策都有 issue 编号（#3779、#3875、#4458、#4651...）和"为什么不在别处做"的反面论证（如 `agent.py:447-456` 的 middleware 顺序注释、`goal.py:344-353` 解释为何不用 reason 文本判进展）。这种"决策考古层"让拆解者能还原每条规则的事故来源——agentdeck 的模块注释值得对齐。

### 7.3 差异警示（不可直接照搬处）

- DeerFlow 的"子 Agent"是**同进程同语言的 LangChain 图重建**，通信靠进程内对象 + ToolMessage；agentdeck 的子 Agent 是**外部 CLI 进程**，握手、超时、部分输出抓取的难度高一档，DeerFlow 的 executor 逻辑只能借鉴语义（capped-completed、receipt 收割）不能借鉴机制（astream/values）。
- DeerFlow 单 lead agent + 工具委派，**没有多 Agent 对等协商**；agentdeck 的多 backend 编排（claude 与 codex 互相校验）在 DeerFlow 中无对应物。
- checkpoint 双模式（Full/Delta）与 `_linearize_delta_checkpoint_resume`（`worker.py:2137`）之类的复杂度是为多宿主/多 worker 服务的；Electron 单进程的 agentdeck 不应引入这层。

---

## 8. 结论

**架构评价**：DeerFlow 2.0 是目前开源界对"Loop Engineering 四层模型中 Loop 1–3"**最完整的工程化表达**之一。它的核心贡献不在单点创新，而在**把每个已知难题都做成了有事故编号、有反面论证、有契约钉死的工程决策**：

- Loop 1：middleware 化的 agent loop + 延迟发现（工具/技能双目录）+ 三重预算（turn/token/loop）软熔断；
- Loop 2：goal 评估器与干活模型分离、类型化 blocker 白名单续跑、产出签名无进展熔断、双层 maker/checker（advisory 引用核对 + deterministic 验收清单）；
- Loop 3：12 类 IM 网关 + cron 调度 + webhook 去重 + 渠道差异化运行策略 + 不可信渠道工具裁剪；
- 状态脊柱：checkpoint（goal/ledger 通道）+ run 事件流 + run 行租约三层的明确分工，配齐回滚点、孤儿回收、收据幂等补写。

**亮点**（按对 agentdeck 价值排序）：① 验证栈的词汇纪律与 UNVERIFIED 三态；② goal 循环的 blocker 枚举 + 产出签名熔断；③ delegation ledger 的"摘要压缩免疫"；④ contracts fixture 的 CI 双侧钉死；⑤ turn 超限的部分成果恢复。

**风险与代价**：

1. **复杂度重力**。532 文件的 harness 包、2946 行的 worker、约 50 个 middleware、20 个数据库迁移——大量复杂度花在多宿主（LangGraph Server/嵌入/Gateway）、多 worker 租约、checkpoint 双模式兼容上。单进程场景（agentdeck）取其语义即可，取其机制会被淹没。
2. **双存储一致性的持续税**。checkpoint 与事件流并存导致种子迁移逻辑（`journal.py:100-176`）必须逐字段复刻持久化语义，历史上已出过 #4458 这类"分支再生成删光继承历史"的事故。agentdeck 的单一人可读状态文件（issue-store/goal-store）在这点上反而更稳。
3. **Loop 4 空缺**。没有自动改写 prompt/工具/grader 的机制，trace 观测（Langfuse/Monocle）与技能迭代仍靠人。这与 agentdeck 的空白层相同，是行业共同空白，不构成负面但也不提供参考。
4. **评估器单点**。goal 评估器是一个小模型看最多 30 条/12000 字符的可见对话（`goal.py:38-39`）判"目标是否达成"——证据窗口有限，对"做了但没说"的 Agent 会误判 missing_evidence。DeerFlow 用 fail-closed 缓解（宁可停也不空转），但意味着"沉默执行型" Agent 的长任务更容易被提前熔断。agentdeck 引入同构设计时，应考虑让 checker 能读工具执行记录而不只是对话文本。

**一句话总结**：DeerFlow 证明了一个"替你提示 Agent 的系统"可以完全由**类型化的停止条件、分层的验证语义、免疫压缩的状态台账、加性演进的跨端契约**四块基石构成——这四块基石 agentdeck 都可以按自己的形态重铸。

---

## 附：本次拆解直接通读的核心源码（35 文件）

lead_agent/agent.py（全）、lead_agent/prompt.py（委托框架节选）、runtime/goal.py（全）、runtime/runs/worker.py（主循环/取消/goal 续跑/回滚节选约 1200 行）、runtime/runs/manager.py（租约与取消节选）、runtime/journal.py（头部 260 行）、runtime/events/catalog.py、runtime/events/store/db.py、runtime/checkpoint_lineage.py、subagents/executor.py（执行主循环与异常恢复节选）、subagents/status_contract.py（全）、subagents/acceptance_checks.py（头部 200 行）、subagents/batch_service.py、subagents/capacity.py、tools/builtins/task_tool.py（646-985 行）、tools/builtins/batch_task_tool.py、agents/middlewares/{delegation_ledger, durable_context_middleware, loop_detection_middleware, subagent_limit_middleware, token_budget_middleware, receipt_verification}.py、agents/memory/{manager.py, summarization_hook.py, tools.py}、sandbox/{sandbox.py, lease.py}、skills/{catalog.py, types.py}、scheduler/schedules.py（全）、backend/app/scheduler/service.py、backend/app/channels/{manager.py, message_bus.py}、backend/app/gateway/app.py（结构）、contracts/ 全部 3 个顶层 JSON、backend/tests/test_subagent_status_contract.py、frontend/src/core/tasks/subtask-result.ts、README.md、backend/README.md、config.example.yaml。
