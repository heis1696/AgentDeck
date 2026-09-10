# OUROBOROS 拆解报告（Loop 4 自我改进循环样本）

> 拆解对象：`Q00/ouroboros`（GitHub 5.8k 星，Rust + Python，本地副本 `D:\agentdeck\teardown\repos\ouroboros`）
> 拆解日期：2026-09-09 · 拆解方法：源码通读（Python 631 文件 / 约 32.4 万行；Rust 10 文件 / 4,819 行）
> 对照方法论：`D:\agentdeck\docs\LOOP-ENGINEERING.md` 四层循环模型，重点 Loop 4

---

## 1. 一句话定位与总体架构

**一句话定位**：ouroboros 是一个"规格优先（specification-first）的 Agent OS"——用苏格拉底式采访把模糊需求逼成一份不可变 Seed 规格，再围绕这份规格跑"执行→评估→进化"的世代循环，直到本体（ontology）收敛；它以 MCP server 形态嵌入 14 种编码 Agent CLI，自身几乎不执行模型调用，而是把所有 CLI 当作可替换的执行引擎。

一个必须先澄清的关键事实（README 自己承认）：

> "This project locks a specification before executing rather than rewriting its own architecture"——`README.md:137-139`

即：**ouroboros 的"衔尾蛇"进化的不是自己的代码，而是任务的规格（Seed）**。它的自我改进对象是"系统对任务的理解"，不是"系统本身"。这一点决定了它作为 Loop 4 样本的真实价值：它提供的是一套**受预算约束、带门控、事件溯源的迭代改进机制**，而非字面意义的自我改写。详见第 2 章。

### 1.1 目录树与模块职责

```
ouroboros/
├── src/ouroboros/            # Python 内核（631 文件，~324k 行）
│   ├── bigbang/              # 采访（Interview）、歧义评分、Seed 生成、棕地探测（17 文件）
│   ├── evolution/            # ★ 进化循环：loop/reflect/wonder/frugality/convergence/watchdog（23 文件）
│   ├── orchestrator/         # ★ runtime 抽象层：14+ 种 CLI runtime 适配 + 并行执行器（135 文件）
│   ├── mcp/                  # ★ MCP server：32 个工具 handler + resources + 后台 job（88 文件）
│   ├── auto/                 # "ooo auto" 全自动管线：目标→采访→A 级 Seed→执行交接（49 文件）
│   ├── evaluation/           # 三段式评估：机械→语义→多模型共识（15 文件）
│   ├── resilience/           # 4 种停滞模式检测 + 5 个横向思维人格（4 文件）
│   ├── persistence/          # 事件溯源 EventStore（SQLite/aiosqlite）+ checkpoint（21 文件）
│   ├── core/                 # Seed/lineage/ontology 类型、安全、HITL 契约（38 文件）
│   ├── providers/            # LiteLLM 适配（100+ 模型）（32 文件）
│   ├── router/               # PAL Router 三档成本路由（1x/10x/30x）（5 文件）
│   ├── cli/                  # Typer CLI（ouroboros setup/interview/run/mcp serve...）（54 文件）
│   ├── tui/ + config_tui/    # Python Textual TUI / 配置 GUI（28 文件）
│   └── plugin/               # 技能/Agent 自动发现插件系统（18 文件）
├── crates/ouroboros-tui/     # Rust TUI（只读仪表盘，直读 SQLite，4,819 行）
├── skills/                   # 22 个 SKILL.md（ooo evolve / interview / ralph / unstuck...）
├── hooks/                    # Claude Code 插件钩子（hooks.json + 3 个 Python 脚本）
├── integrations/dsh-plugin/  # DeepSeek Harness 插件（反向集成）
├── scripts/                  # 安装器、ralph 循环脚本、drift-monitor、守门 CI 脚本
├── docs/                     # architecture.md、runtime-guides/（14 个 runtime 各一份）
├── .ouroboros/seeds/         # 本仓库自用的 Seed 样例 + mechanical.toml
├── project-context.md / HANDOFF.md / backlog.md / AGENTS.md / CLAUDE.md  # 维护者给"开发本项目的 AI"看的状态脊柱
└── pyproject.toml            # 包名 ouroboros-ai，extras：[mcp]/[tui]/[claude]/[litellm]...
```

### 1.2 模块职责表（运行时主链路）

| 模块 | 职责 | 关键文件 |
|---|---|---|
| bigbang/ | 采访门控：苏格拉底提问、歧义评分（≤0.2 才许生成 Seed） | `src/ouroboros/bigbang/interview.py`（1804 行）、`ambiguity.py`（1107 行） |
| evolution/ | Loop 4 核心：Wonder→Reflect→新 Seed 世代循环、收敛判定、预算守卫 | `src/ouroboros/evolution/loop.py`（2098 行）、`reflect.py`、`frugality.py` |
| orchestrator/ | runtime 抽象 + AC 级并行执行、worktree、验证门 | `src/ouroboros/orchestrator/adapter.py`（2000+ 行）、`runtime_factory.py` |
| evaluation/ | 三段式验证：机械（$0）→语义→多模型共识，反 reward-hacking | `src/ouroboros/evaluation/pipeline.py` |
| mcp/ | 对外工具面：interview/evolve_step/ralph/rewind 等 32 个 MCP 工具 | `src/ouroboros/mcp/tools/definitions.py:459-654` |
| persistence/ | 事件溯源状态脊柱 + 相位 checkpoint 恢复 | `src/ouroboros/persistence/event_store.py`、`checkpoint.py` |
| crates/ouroboros-tui/ | Rust 只读仪表盘：直读 `~/.ouroboros/ouroboros.db` | `crates/ouroboros-tui/src/main.rs:66-70` |

### 1.3 Rust 与 Python 的分工

分工极其清晰：**Python 是内核，Rust 是一块外接仪表盘**。

- Rust 端（`crates/ouroboros-tui/src/`，共 4,819 行）不包含任何编排逻辑。`main.rs` 打开 `~/.ouroboros/ouroboros.db`（`main.rs:66-70` 的 `--db-path` 默认值），`db.rs`（1240 行）用只读 SQL 轮询事件库，五个视图（dashboard/execution/lineage/logs/session_selector）做可视化，还有 `--mock` 演示模式。它不写库、不调用引擎——本质上是把 SQLite 事件流当渲染数据源。
- Python 端另有自己的 Textual TUI（`src/ouroboros/tui/`，22 文件）承担交互式配置/状态视图。README:466-485 的架构图里两者并列。
- 值得注意：README:96-105 宣称的"三仓栈"中，终端壳层其实已外移到独立仓库 `Ouro-labs/ourocode`；本仓的 Rust TUI 更像早期尝试的遗留仪表盘。

---

## 2. 自我改进循环（Loop 4）精读

### 2.0 先纠正前提：它改进的到底是什么

"ouroboros 衔尾蛇"改的**不是自身的配置/代码/skill，而是任务的 Seed 规格**：目标（goal）、约束（constraints）、验收标准列表（acceptance criteria, AC）、本体模式（ontology schema）。每过一代，评估输出被喂回去改写下一代 Seed，直到本体收敛。官方描述（`README.md:367-403`）：

```
Interview -> Seed -> Execute -> Evaluate
    ^                           |
    +------ Evolutionary Loop --+
```

进化对象的数据结构（`src/ouroboros/evolution/reflect.py:89-105`）：

```python
class ReflectOutput(BaseModel, frozen=True):
    """Output of the Reflect phase -- feeds directly into SeedGenerator."""
    refined_goal: str
    refined_constraints: tuple[str, ...] = Field(default_factory=tuple)
    refined_acs: tuple[str, ...] = Field(default_factory=tuple)
    ac_patches: tuple[ACPatch, ...] = Field(default_factory=tuple)
    settled_ac_indices: tuple[int, ...] = Field(default_factory=tuple)
    ontology_mutations: tuple[OntologyMutation, ...] = Field(default_factory=tuple)
    reasoning: str = ""
```

三个值得注意的细节：

1. **AC 补丁不允许删除**（`reflect.py:66-77`）：`op` 只有 `keep/revise/add`，"remove is not offered in v1 — deleting an AC would shift positional identity that regression detection and the per-AC gate depend on"。AC 用下标做位置身份，删除会让回归检测与逐 AC 门控失效——这是把"身份稳定性"当作循环基础设施的设计决策。
2. **采访只属于第 1 代**（`reflect.py:9-10`）："Interview is Gen 1 only; Reflect handles all subsequent generations autonomously"——人工输入集中在起点，后续世代自主进化。
3. **本体突变是显式声明**（`reflect.py:56-64`）：`OntologyMutation(action=add|modify|remove, field_name, field_type, description, reason)`，本体演化本身也被记录为结构化增量（OntologyDelta）并入事件流。

### 2.1 循环骨架：EvolutionaryLoop

`src/ouroboros/evolution/loop.py:174-190` 的类文档就是完整时序：

```
Gen 1 lifecycle (seed provided externally):
1. Execute(Seed₁) → execution_output
2. Evaluate(execution_output) → E₁
3. Record generation → check convergence

Gen 2+ lifecycle (autonomous):
1. Wonder(Oₙ, Eₙ) → WonderOutput
2. Reflect(Seedₙ, output, Eₙ, wonder) → ReflectOutput
3. SeedGenerator(reflect_output, parent=Seedₙ) → Seed_{n+1}
4. Execute(Seed_{n+1}) → execution_output
5. Evaluate(execution_output) → E_{n+1}
6. Record generation → check convergence(Oₙ, O_{n+1})
7. If not converged → goto 1 with n+1
```

两个引擎的分工：

- **WonderEngine**（`src/ouroboros/evolution/wonder.py:1-9`）："What do we still not know?"——检查当前本体+评估结果+执行输出，找出缺口与张力。它的问题必须"落地"（grounded）到具体 AC：要么 challenge 指定 AC 下标，要么指出 goal 要求但没有 AC 覆盖的 gap（`wonder.py:53-62` 的 `GroundedQuestion`），并有正则 `_AC_REF_PATTERN` 把漂浮的问题字符串钉回 AC 编号（`wonder.py:55`）。
- **ReflectEngine**（`reflect.py:1-11`）："How should the ontology evolve?"——把 Wonder 的问题转成对下一代的补丁。模块 docstring 即品牌口号："This is where the Ouroboros eats its tail: the output of evaluation becomes the input for the next generation's seed specification."

Reflect 的系统提示词（`reflect.py:638-692`，节选）把"满足化（satisficing）增量"原则写死了：

```
SATISFICING DELTA — patch the AC list, do NOT rewrite it:
- "keep" (index only): an AC that PASSED evaluation AND is not named by any
  grounded challenge AND is not regressed MUST be kept VERBATIM. ... (A
  deterministic backstop will force-keep these even if you try to revise them.)
- "revise" (index + content): only for ACs that FAILED, were CHALLENGED by a
  grounded Wonder question, or REGRESSED. Provide the full corrected AC text.
- "add" (content only): for gap questions — something the goal requires that no
  AC covers yet.
- "remove" is NOT available in v1. Never delete an AC; it would break
  positional AC identity.
```

（`reflect.py:663-676`）注意最后一句括号：**确定性兜底会强制 keep 已通过的 AC，即使模型试图改写**——LLM 提议、确定性代码裁决，这是贯穿全项目的 maker/checker 原则。

### 2.2 怎么触发进化：外部调用 + 世代单步

进化不是自触发的守护进程，而是**每次调用推进恰好一代**的 MCP 工具：

```python
async def evolve_step(
    self,
    lineage_id: str,
    initial_seed: Seed | None = None,
    execute: bool = True,
    parallel: bool = True,
    conductor_directive: ConductorDirective | None = None,
    benchmark_control: bool = False,
    ...
) -> Result[StepResult, OuroborosError]:
    """Advance one lineage once while a durable lease owns all effects."""
```
（`src/ouroboros/evolution/loop.py:578-588`）

调用方有三种：

1. **Agent 宿主**：skill `skills/evolve/SKILL.md` 指导宿主 CLI（Claude Code/Codex/...）反复调 `ouroboros_evolve_step`，根据返回的 `action`（continue/converged/ontology_stable/stagnated/exhausted/failed）决定下一步。
2. **Ralph 循环**（`src/ouroboros/ralph_loop.py:1-8`）："MCP-owned Ralph loop runner ... running repeated `evolve_step` calls inside one background job"——服务器端后台作业，逐代推进直到终止动作。每代超时 `DEFAULT_PER_ITERATION_TIMEOUT_SECONDS = 1800.0`（`ralph_loop.py:34`），终止动作集合 `_TERMINAL_SUCCESS_ACTIONS = {"converged"}` / `_TERMINAL_FAILURE_ACTIONS = {"failed","interrupted","exhausted","stagnated"}`（`ralph_loop.py:26-27`）。
3. **CLI**：`ouroboros init start` / `ooo auto` 全自动管线（`src/ouroboros/auto/pipeline.py`）。

**跨会话/跨机器的续跑**靠事件溯源：`evolve_step` 完全无状态，世系（lineage）从 EventStore 重建（`README.md:393-403`："even if your machine restarts, the serpent picks up where it left off"）。

并发安全用**持久租约**实现：`owned_lineage_step` + `StepLease`（`src/ouroboros/evolution/generation_claims.py:93-102`）——单租约心跳续期、过期两阶段回收（先标记 revoked、等一个心跳间隔让原 owner 可证明地观察到移交并停下，再接管，`generation_claims.py:16-30` docstring），外加请求指纹单飞（single-flight）去重（`loop.py:611-636`）。这解决的是"两个 Ralph 同时推进同一条世系"的问题。

### 2.3 采访门控：歧义分数 ≤ 0.2 才许结晶

采访门控是进化的**入口闸门**：需求不清就不许进入循环。核心在 `src/ouroboros/bigbang/ambiguity.py:36-56`：

```python
# Threshold for allowing Seed generation (NFR6)
AMBIGUITY_THRESHOLD = 0.2
SEED_CLOSER_ACTIVATION_THRESHOLD = 0.25
AUTO_COMPLETE_STREAK_REQUIRED = 2

# Minimum per-dimension clarity required before interview auto-completion.
GOAL_CLARITY_FLOOR = 0.75
CONSTRAINT_CLARITY_FLOOR = 0.65
SUCCESS_CRITERIA_CLARITY_FLOOR = 0.70
BROWNFIELD_CONTEXT_CLARITY_FLOOR = 0.60

# Weights for greenfield score components (3 dimensions)
GOAL_CLARITY_WEIGHT = 0.40
CONSTRAINT_CLARITY_WEIGHT = 0.30
SUCCESS_CRITERIA_CLARITY_WEIGHT = 0.30
```

评分是 LLM-as-judge 打维度清晰度（0-1，清晰度越高越好），加权合成歧义分数（越低越好）。门控有三层：

1. **总分门**：`is_ready_for_seed()` 即 `overall_score <= 0.2`（`ambiguity.py:287-293`）；
2. **维度地板门**：即使总分达标，每个维度清晰度还必须过各自的 floor（`ambiguity.py:41-45` + `get_completion_floor_failures`，`ambiguity.py:296`）——防止某维度塌陷但被加权平均掩盖；
3. **自动收尾防抖**：连续 2 轮达到收尾条件才允许自动结束采访（`AUTO_COMPLETE_STREAK_REQUIRED = 2`，`ambiguity.py:39`），且采访状态一旦变更就作废已存的歧义快照（`interview.py:305-329` 的 `store_ambiguity/clear_stored_ambiguity`）——快照只反映"已回答的轮次"，防止陈旧分数放行。

维度评分可以**拆分扇出**（fan-out）：把组合评分提示词按维度拆成独立调用并行跑（`ambiguity.py:58-68` 注释），且逐字复用同一 rubric，保证单维度打分与组合打分字节等价。棕地（brownfield）任务加第 4 维 Context Clarity（权重 0.15，`ambiguity.py:52-56`）。

### 2.4 预算控制：四道闸

预算控制在四个层面展开，从粗到细：

**（1）世代数与轮次上限**（`src/ouroboros/evolution/loop.py:80-96`）：

```python
@dataclass
class EvolutionaryLoopConfig:
    max_generations: int = 30
    convergence_threshold: float = 0.95
    stagnation_window: int = 3
    min_generations: int = 3
    ...
    eval_gate_enabled: bool = True
    eval_min_score: float = 0.7
    evaluation_plateau_epsilon: float = 0.01
    scoped_reexecution: bool = True
    focused_evolution: bool = True
```

**（2）收敛/停滞判定（Judge/Gate 分离）**：评估只记录分数与证据，**确定性代码**决定 accept/continue/stagnate（`skills/evolve/SKILL.md` "Judge/Gate split" 条目）。`src/ouroboros/evolution/convergence.py:94-127` 的判定顺序本身就是预算设计：

```python
# Loop-engineering exit gate: a convergence loop is finished when its
# independently checked outcome passes.  Requiring ontology churn after
# that point spends generations optimizing the loop rather than the
# product.  This gate deliberately precedes ``min_generations`` so a
# correct Gen 1 can stop after one expensive Execute→Evaluate cycle.
if self.outcome_gate_enabled and evaluation_expected and latest_evaluation is not None:
    outcome_block = self._outcome_gate_block(...)
    if outcome_block is None:
        return ConvergenceSignal(converged=True, reason="Outcome gate passed: ...")
```

结果门放在最前——第 1 代就通过就立即停，不为"进化的仪式感"多烧一代。其余信号依次：硬上限 30 代（`convergence.py:119-127`）、最小代数、本体相似度 ≥0.95、停滞窗口（3 代内被拒分数移动 <0.01 即判 stagnated，交给 `ooo unstuck` 而不是烧完 30 代）。还有一条防伪装收敛的规则：`execute:false` 的纯本体模式即使相似度达标也只返回 `ontology_stable`（非成功），必须同世系再跑一次 `execute:true` 才算数（SKILL.md "Convergence" 条目 + `convergence.py:138-150` 注释"Approval is convergence authority"）。

**（3）聚焦进化（focused evolution）——工作集必须收缩**（`src/ouroboros/evolution/focus.py:1-11`）：

```
Loop engineering converges by shrinking the work that remains.  This module
turns the previous generation's verification evidence into an explicit AC
working set: failed, changed, challenged, regressed, and newly-added nodes stay
active; proven passing nodes are frozen and only reverified at the boundary.

The selector is deliberately independent of LLM output such as
``ReflectOutput.settled_ac_indices``.  A model may propose a change, but it does
not decide which already-passing nodes are safe to rerun.
```

每代从上一代验证证据**确定性地**推导 active/frozen 两个 AC 集合：失败的、被挑战的、回归的、新增的留在 active；已证明通过的冻结，只在最终边界复验。active 集合应逐代收缩到零。这是"循环收敛 = 剩余工作收缩"的工程化表述，且选择器刻意不信任 LLM 输出。

**（4）节俭凭据（frugality receipt）——fail-closed 的 token 记账**。"少干了逻辑工作"不等于"少花了资源"，所以 `src/agentdeck.../ouroboros/src/ouroboros/evolution/frugality.py:1-11` 如此立规：

```
Focused node counts prove that the loop did less *logical work*; they do not
prove that it spent fewer resources.  This module records measured generation
observations and compares them only when a full-graph control and a focused
treatment started from the same clean Git commit in distinct worktrees.

The control is never launched automatically.  Shadowing every production
generation would consume the savings being measured.  A normal evolve run
therefore emits an ``insufficient_data`` receipt until a deliberately isolated
comparison arm exists.
```

要点：① 默认Receipt= `insufficient_data`（fail-closed）；② 对照组（全图重跑）**从不自动启动**——否则影子跑本身就会吃掉要省的钱；③ 要拿到 PASS，需同 commit 的两个干净 worktree 配对对照+处理组，实测 token 至少少 10%（`MIN_TOKEN_REDUCTION_PCT = 10.0`，`frugality.py:42`），且质量无回归；④ 基线采集只读不写（`capture_project_baseline`，`frugality.py:303-316`：`git rev-parse HEAD` + `status --porcelain` 判断 clean）。token 记账同样 fail-closed：`provider_usage.py:1-9` "A provider error, exception, malformed counter, or zero/absent usage makes the whole generation incomplete rather than letting a partial numerator manufacture savings."

**（5）看门狗（watchdog）——无进展超时**：`GenerationProgressWatchdog`（`src/ouroboros/evolution/watchdog.py:52-99`）监听 EventStore 活动与"实质进展"事件（区别于心跳类噪音），超时则按 `cooperative_direct_one_stage` 契约取消任务（单阶段直接 `task.cancel()`，`watchdog.py:100-120`），并把决策与控制指令作为事件原子追加。旧版 `generation_timeout_seconds` 已废弃，映射为 `generation_no_progress_timeout_seconds`（`loop.py:98-106`）——纯时长超时被无进展超时取代。

### 2.5 停滞检测与破局：4 模式 + 5 人格

停滞不是单一状态（`src/ouroboros/resilience/stagnation.py:58-71`）：

```python
class StagnationPattern(StrEnum):
    """Four stagnation patterns detected in execution loops."""
    SPINNING = "spinning"            # 同样输出重复（同错误、同结果）
    OSCILLATION = "oscillation"      # A→B→A→B 摆动
    NO_DRIFT = "no_drift"            # 有产出但无朝向目标的进展
    DIMINISHING_RETURNS = "diminishing_returns"  # 进展率持续下降
```

破局手段是横向思维人格（`resilience/lateral.py`：CONTRARIAN/HACKER/SIMPLIFIER 等 5 个，`lateral.py:64-68,157-177`），由 `RecoveryPlanner`（`resilience/recovery.py:58-115`）按模式推荐，暴露为 MCP 工具 `ouroboros_lateral_think` 与 skill `ooo unstuck`。人格策略从 markdown 加载（`lateral.py:164` `_load_persona_strategies_from_md`）——破局知识本身是数据不是代码。

### 2.6 回滚：世代快照 + Rewind

每个世代是不可变快照（GenerationRecord 携带完整 `seed_json`，`loop.py:448-460`），可以回退到任意代并从那里分叉进化：MCP 工具 `ouroboros_evolve_rewind`（`definitions.py:645` 的 `EvolveRewindHandler`）+ skill 语法 `ooo evolve --rewind <lineage_id> <generation_number>`。回滚提交走类型化边界（`src/ouroboros/evolution/rewind.py:55-64` 的 `RewindCommitter.rewind_to` 协议），观察者只拿标量快照、对结果无否决权（`rewind.py:47-53`）——回滚是引擎权威行为，插件只能旁观。配套脚本 `scripts/ralph-rewind.py` 可在 Ralph 跑偏时手工回退。

### 2.7 Loop 4 小结：它的"自我改进"边界

| 维度 | ouroboros 的做法 |
|---|---|
| 改什么 | 任务 Seed（goal/constraints/AC 列表/ontology schema），世代间增量补丁 |
| 不改什么 | 自己的代码、配置、skills、模型路由（README:137-139 明确否认自改架构） |
| 触发 | 外部调用（MCP 工具/Ralph 后台 job），每次一代，事件溯源续跑 |
| 入口门控 | 采访歧义 ≤0.2 + 维度地板 + 连续 2 轮防抖 |
| 预算 | 30 代硬上限、结果门优先、停滞 3 代窗口 ε=0.01、无进展看门狗、聚焦工作集、fail-closed token 凭据 |
| 停止条件 | 结果门通过 / 本体相似度 ≥0.95 / 停滞 / 耗尽，全部由确定性代码裁决 |
| 回滚 | 世代快照 + rewind 工具 + 租约防并发 |

---

## 3. 14 种 runtime 支持

### 3.1 注册表：一份 spec 表 + 两个工厂列

runtime 支持的中心是 `src/ouroboros/backends/factory_registry.py:23-135` 的 `_FACTORY_SPECS`，每个后端一条 `BackendFactorySpec(name, llm_backend, runtime_backend, llm_adapter_factory, agent_runtime_factory)`：

```python
_FACTORY_SPECS: tuple[BackendFactorySpec, ...] = (
    BackendFactorySpec(name="claude", llm_backend="claude_code",
        runtime_backend="claude",
        llm_adapter_factory="_create_claude_code_adapter",
        agent_runtime_factory="_create_claude_runtime"),
    BackendFactorySpec(name="codex", ...),
    BackendFactorySpec(name="codex_mcp", ...),      # codex 的 MCP 传输变体
    BackendFactorySpec(name="claude_mcp", ...),     # claude 的 MCP 传输变体
    BackendFactorySpec(name="copilot", ...),
    BackendFactorySpec(name="gemini", ...),
    BackendFactorySpec(name="hermes", ...),
    BackendFactorySpec(name="kiro", ...),
    BackendFactorySpec(name="opencode", ...),
    BackendFactorySpec(name="goose", ...),
    BackendFactorySpec(name="pi", ...),
    BackendFactorySpec(name="omp", ...),
    BackendFactorySpec(name="gjc", ...),
    BackendFactorySpec(name="antigravity", ...),
    BackendFactorySpec(name="grok", ...),
    BackendFactorySpec(name="zcode", ...),
    BackendFactorySpec(name="host", ...),           # 宿主自身执行
    ...
)
```

README 口径的"14 runtime"= Claude Code、Codex CLI、GitHub Copilot CLI、OpenCode、Hermes、Gemini、Kiro、Pi、OMP、Zcode、Goose、GJC、Antigravity、Grok（`README.md:189`）；注册表里另有 codex_mcp/claude_mcp（传输变体）和 host/ourocode（`factory_registry.py:112-135`）。每个 runtime 一份适配器文件（如 `orchestrator/zcode_cli_runtime.py`、`gemini_cli_runtime.py`、`grok_cli_runtime.py`）。

### 3.2 协议：AgentRuntime Protocol + 能力协商

所有 runtime 实现同一个 Protocol（`src/ouroboros/orchestrator/adapter.py:954-1027`）：

```python
class AgentRuntime(Protocol):
    @property
    def runtime_backend(self) -> str: ...          # 规范名，如 "claude"/"codex_cli"

    @property
    def capabilities(self) -> RuntimeCapabilities: ...
    # ↑ 功能契约。默认 FULL_CAPABILITIES（skill_dispatch + targeted_resume
    #   + structured_output 全 True），窄面 runtime 覆盖此属性声明。
    #   调用方按能力标志分支，而不是按后端名字分支。

    @property
    def llm_backend(self) -> str | None: ...       # 非 runtime LLM 任务的后端

    @property
    def working_directory(self) -> str | None: ...

    @property
    def permission_mode(self) -> str | None: ...

    def execute_task(self, prompt, tools=None, system_prompt=None,
                     resume_handle=None, resume_session_id=None,
    ) -> AsyncIterator[AgentMessage]: ...          # 归一化消息流

    async def execute_task_to_result(...) -> Result[TaskResult, ProviderError]: ...
```

三个设计要点：

1. **能力协商优先于名字分支**（`adapter.py:962-975` 注释）：窄面 runtime（如 Kiro）声明 `capabilities`，调用方查标志而非 if-else 后端名。老适配器不实现该属性也能结构化兼容（Protocol 默认实现）。
2. **消息归一化**：各 CLI 的输出事件被映射到统一生命周期状态机（`adapter.py:120-138` `_RUNTIME_LIFECYCLE_STATE_BY_EVENT_TYPE`：runtime.connected→connecting、session.started→running、run.completed→completed、error→failed...），统一 `AgentMessage` 流。
3. **每个 runtime 的局限被显式文档化并 fail-loud**：例如 `zcode_cli_runtime.py:16-28`——zcode 没有 `--model` CLI 旗标（对着 0.14.5/0.15.0/0.15.2 的 `--help` 验证过，传了会被硬拒），模型选择只能走 `~/.zcode/cli/config.json` 的 `model.main`，构造器传入的 model 值被有意忽略并打警告，让"期望模型 vs 实际模型"的错配可见。

工厂入口 `runtime_factory.py:53-63` 的 `resolve_agent_runtime_backend()` 做名字归一化+校验，未知名直接报错列出全部支持项。安装器 `ouroboros setup --runtime <x>` 探测本机存在的 runtime 并按各家期望的形态注册 MCP（Codex 用 rules+skills、OpenCode 用 plugin+AGENTS.md、Kiro 写 `~/.kiro/settings/mcp.json`——`README.md:169-189`），`src/ouroboros/runtime_instruction_artifacts.py:27-30` 用 `<!-- ouroboros:...:start/end -->` 标记段落把能力指南 idempotent 地插进宿主指令文件、不破坏用户文本。

---

## 4. MCP server 形态

### 4.1 形态与启动

ouroboros 的主产品形态就是 MCP server：`ouroboros mcp serve --runtime <claude-cli|codex|...> --llm-backend <...>`（CLI 入口 `src/ouroboros/cli/commands/mcp.py:681` 的 Typer app）。仓库根的 `.mcp.json` 是标准样例：

```json
{
  "mcpServers": {
    "ouroboros": {
      "command": "uvx",
      "args": ["--isolated", "--python", ">=3.12", "--from", "ouroboros-ai[mcp]",
               "ouroboros", "mcp", "serve", "--runtime", "claude-cli",
               "--llm-backend", "claude_code"]
    }
  }
}
```

### 4.2 工具面：32 个 handler

`src/ouroboros/mcp/tools/definitions.py:459-654` 的 `get_ouroboros_tools()` 组装全部工具（依赖注入 runtime_backend/llm_backend/project_dir），按职能分组：

| 职能 | 工具（`ouroboros_` 前缀） |
|---|---|
| 采访/规格 | `interview`、`generate_seed`、`pm_interview`、`brownfield` |
| 执行 | `execute_seed`、`start_execute_seed`（fire-and-forget）、`auto`、`start_auto` |
| 评估 | `evaluate`、`start_evaluate`、`checklist_verify`、`qa`、`measure_drift` |
| 进化（Loop 4） | `evolve_step`、`start_evolve_step`、`lineage_status`、`evolve_rewind`、`ralph`、`start_ralph` |
| 破局 | `lateral_think`、`submit_fanout`、`fetch_artifact`（采访/横向思维的顾问扇出-提交-合成） |
| 会话/作业 | `session_status`、`job_status`、`job_wait`、`job_result`、`cancel_job`、`cancel_execution` |
| 观测 | `query_events`、`projection_query`、`project_status`、`ac_tree_hud` |

`start_*` 系列把长任务丢进后台 job（`mcp/job_manager.py` + `detached_jobs.py`），宿主轮询 job_status/job_wait——避免一次 MCP 调用阻塞数十分钟。进化类 handler 有收据机制（`evolve_handler_receipt.py`）与启动租约（`evolve_start_claim.py`）。

### 4.3 资源面与脱敏

MCP resources 暴露三类只读数据：seeds / sessions / events（`src/ouroboros/mcp/resources/handlers.py:10-17`）。所有出站内容经过秘密脱敏：`_REDACTED` 常量 + 敏感字段名集合 + 命令行旗标正则（`handlers.py:29-53`），与 `core/security.py:38-70` 的统一掩码共用策略。

### 4.4 hooks/ 与 integrations/ 的作用

- **hooks/**（`hooks/hooks.json` + `scripts/*.py`）是 Claude Code 插件钩子面，三条全部 **fail-open**（脚本缺失/Python 缺失/非零退出都只告警不阻断，hooks.json 中每个 command 的 `|| { ...; exit 0; }` 兜底）：
  - `SessionStart` → `session-start.py`：会话引导；
  - `UserPromptSubmit` → `keyword-detector.py`：魔术关键字检测，用户提示里出现 `ooo` 语法时建议对应 skill；若 MCP 未配置，除 setup/help/qa/resume-session 外全部重定向到 setup 先行门（`keyword-detector.py:26-33` 的 `SETUP_BYPASS_SKILLS`）；
  - `PostToolUse(Write|Edit)` → `drift-monitor.py`：检测到活跃采访会话期间的文件修改时给**顾问性**漂移提醒（`drift-monitor.py:1-13`："This is a lightweight check - actual drift measurement requires calling ... the MCP server"）——重活留给 MCP 工具，钩子只做廉价预警。
- **integrations/dsh-plugin/**（`package.json` + `README.md` + `cordis.patch.yml`，共 3 文件）：反向集成——把 `ooo interview`/`ooo auto` 作为 DeepSeek Harness 的插件装进 dsh 聊天，使同一套 MCP 工具在 dsh 内原生可用（`README.md:191-193`）。这与"ouroboros 作为 MCP server 嵌入宿主"是同一工具面的两个方向。

---

## 5. 状态与记忆

### 5.1 运行态脊柱：EventStore（SQLite 事件溯源）

真正的状态脊柱是事件溯源库：`src/ouroboros/persistence/event_store.py:1-6`——"async methods for appending and replaying events using SQLAlchemy Core with aiosqlite backend"，默认落盘 `~/.ouroboros/ouroboros.db`（Rust TUI 的默认 `--db-path`，`crates/ouroboros-tui/src/main.rs:66-70`）。每个相位都发事件（`lineage.generation.completed` 携带完整 `seed_json` 与执行输出，`evolution/loop.py:464-485`；看门狗决策、控制指令、token 归因、frugality 观察各有事件类型）。恢复链路：相位级 checkpoint（`persistence/checkpoint.py`）+ `evolve_step` 的世代重建（`loop.py:599-601` `planned_evolve_generation` 从事件规划代数）+ Ralph 的无状态逐代推进。

### 5.2 根目录 markdown：不是运行态脊柱，是"开发态"脊柱

对 `project-context.md`、`HANDOFF.md`、`backlog.md` 三个文件在 `src/` 全树 grep，**零引用**——运行时代码不读写它们。它们的真实身份：

- `project-context.md`：给"开发 ouroboros 本身的 AI Agent"看的项目规范（"AI Agent Implementation Guide - Read this BEFORE writing any code"，Python 3.12/async 纪律等），配合根目录 `AGENTS.md`/`CLAUDE.md`/`.codex/` 一起构成贡献者 Agent 的上下文注入；
- `HANDOFF.md`：维护者（韩文）的产品迭代交接文档——最近 30 天 PostHog 漏斗（MCP 用户 2086 → command 到达 807，38.7%）与三层改造决策（server instructions / 入口工具描述 / 宿主自然语言路由）；
- `backlog.md`：5 个并行分析 Agent 对 31.2 万行代码的审计积压（158 项发现：类型安全压制 12、真实 bug 24、安全 11、上帝对象 29……"mypy clean 只是因为关了 14 个错误码"）。

也就是说，**这些 markdown 是维护者自己实践 Loop Engineering 的状态脊柱（"agent forgets, repo doesn't" 原则的落地），服务对象是"开发本项目的循环"，而非产品运行时**。仓库内 `.ouroboros/seeds/seed_*.yaml` 也只是开发自用的 Seed 样例。这个区分对 agentdeck 很有参考意义：状态脊柱可以有两套，一套给产品运行时（ouroboros 用 SQLite 事件库），一套给"改进产品的那条循环"自己用（markdown）。

---

## 6. 安全边界

自我改进（即使是改规格不改代码）的风险控制全链路：

1. **沙箱等级词汇表单一化**（`src/ouroboros/sandbox.py:19-31`）：引擎侧 `SandboxClass` 枚举三档——`READ_ONLY` / `WORKSPACE_WRITE` / `UNRESTRICTED`，模块零上行依赖地放在顶层；引擎决定会话配几档沙箱，每个 provider 适配器用**自己的平铺翻译表**查表，"never re-derives the decision from free-form permission strings"。
2. **fail-loud 的权限翻译**（`src/ouroboros/claude_permissions.py:33-43`）：`SandboxClass→ClaudePermissionMode` 映射查不到就 `raise KeyError`——"failing loudly beats silently defaulting to a possibly-permissive mode"；落到 `UNRESTRICTED` 必打警告。Codex 侧对等（`codex_permissions.py`）。
3. **人工审批点（HITL）是类型化契约**（`src/ouroboros/core/hitl_contract.py:1-9,15-40`）：WAIT/RESUME 流程有稳定载荷形状（schema_version=2、载荷上限 8KB、秘密字段名/后缀集合强制脱敏），渲染器中立（CLI/MCP/TUI 都能实现）——审批点不绑定某个 UI。采访本身（歧义 ≤0.2 门）就是最大的人工审批点：人只在 Gen 1 参与，之后自主。
4. **确定性与 LLM 的权限分界**（贯穿全项目的 maker/checker）：
   - 收敛与否由确定性 `ConvergenceCriteria` 裁决，评估只供证（2.4 节）；
   - AC 工作集选择不信任 LLM（`focus.py:8-10`）；
   - 已 PASS 的 AC 有确定性 backstop 强制 keep（`reflect.py:669-670`）；
   - token 记账 fail-closed，计数缺失整代作废（`provider_usage.py:1-9`）。
5. **回滚**：世代快照 + `ouroboros_evolve_rewind`（2.6 节）；回滚观察者无否决权，提交走单一 `RewindCommitter` 原语。
6. **输入与凭据防护**（`core/security.py:12-26`）：外部输入尺寸上限（初始上下文 50KB/用户回答 10KB/Seed 文件 1MB/LLM 响应 100KB）防 DoS；API key 形态校验 + 敏感字段/前缀掩码（`security.py:28-70`）；MCP 出站统一脱敏（4.3 节）。
7. **并发与单飞**：世代租约防双写（2.2 节），请求指纹去重防重复扣费。
8. **优雅停机**：SIGINT 两段式——第一次置优雅停机旗（相位间安全停下，代结果标记 INTERRUPTED 并保留已进化 Seed，`loop.py:432-442`），第二次强制退出（`loop.py:244-251`）。

值得指出的缺口：`UNRESTRICTED`/`bypassPermissions` 档仍然存在且只是"打警告"；execution 多数路径默认 `WORKSPACE_WRITE` 起步。没有 OS 级沙箱（对比 OpenHands 的容器隔离），隔离单位是 CLI 自身的权限模式 + git worktree（`auto/worktree.py`、`core/worktree.py`）。

---

## 7. 与 agentdeck 的对照与可借鉴点（最重要）

### 7.1 现状对照

| Loop Engineering 概念 | ouroboros 实现 | agentdeck 现状 |
|---|---|---|
| Loop 1 工具调用 | AgentRuntime Protocol + 14 runtime（orchestrator/） | `runner.ts` + `backends/*`（5 后端）✔ |
| Loop 2 验证 | 三段评估 + Judge/Gate 分离 + 回归检测（evaluation/） | `retry-policy.ts`、`task-finalizer.ts` ✔ |
| Goal-based | 结果门 + 世代收敛（convergence.py） | `goal-controller.ts` + `goal-store.ts` ✔（弱一档） |
| Loop 3 事件/定时 | Ralph 后台 job + MCP start_* 异步作业 | `scheduler.ts` ✔ |
| Sub-agent/委派 | 并行执行器 + AC 级扇出 + 顾问 fan-out | `delegate.ts` ✔ |
| 状态脊柱 | SQLite EventStore + checkpoint | `issue-store.ts`、`event-log.ts` ✔ |
| HITL | hitl_contract + 采访门 | `permission-broker.ts` ✔ |
| **Loop 4 自我改进** | **Seed 世代进化全链路（evolution/）** | **空白** |

### 7.2 可借鉴点一：把 Loop 4 落成"规格进化循环"，不是"agent 改自己"

ouroboros 最有价值的一课是**选择了一个安全且可验证的自我改进对象**：任务的验收标准与规格，而不是 agent 自身的提示词/代码。理由（从它的实现反推）：

- 规格进化的每一步都可被独立验证（三段评估、逐 AC 判定），改进效果可度量；
- 不会产生"改坏自己导致无法回滚"的死锁（agentdeck 若让 agent 改 `backends/*.ts`，一次坏改动可能弄坏执行器本身）；
- 与 agentdeck 现有模块严丝合缝：**goal-store 里的 goal 已经是"规格"的雏形**。

落地建议：
- 给 `goal-store.ts` 的 goal 增加**带位置身份的 AC 列表**（ouroboros 的教训：禁止删除、只 keep/revise/add，`reflect.py:663-676`——位置身份是回归检测和逐 AC 门控的前提）；
- `goal-controller.ts` 增加一个"进化步"端点：每圈结束后，用廉价模型（对照 ouroboros 的 wonder/reflect 角色分离）产出 `ReflectOutput` 形状的补丁（refined_goal/ac_patches），**确定性代码**决定哪些 AC 进入下一代工作集（对照 `focus.py`）;
- 每代 goal 快照进 `event-log.ts`，天然获得 rewind 能力（对照 GenerationRecord + `evolve_rewind`）。

### 7.3 可借鉴点二：入口歧义门控（成本最低的杠杆）

agentdeck 的 goal-controller 直接把用户目标扔给 CLI 跑。ouroboros 用数据证明瓶颈在输入（`README.md:225-231`："Most AI coding fails at the input, not the output"），其采访门控（2.3 节）是**在 Loop 1 启动之前**省钱的闸门。agentdeck 落地：

- 新增 `ambiguity-gate.ts`：goal 创建时用小模型按维度打清晰度（goal/constraints/success-criteria 三维足够，权重 40/30/30 抄作业即可，`ambiguity.py:47-50`）；
- 总分 > 0.2 或任一维度低于地板（0.75/0.65/0.70，`ambiguity.py:41-44`）时，不启动 runner，而是生成一轮澄清问题经 `permission-broker.ts` 推给用户——这正好复用 agentdeck 已有的审批管道；
- 两个防抖细节值得抄：**连续 2 轮达标才自动放行**（`ambiguity.py:39`）；**快照失效机制**（goal 文本一变，已存的歧义分数作废，`interview.py:305-329`）。

### 7.4 可借鉴点三：预算与停止条件的工程化

agentdeck 的 goal-controller 已有停止条件，但 ouroboros 提供了更完整的"停止条件栈"，可直接充实 `retry-policy.ts`/`task-finalizer.ts`/`goal-controller.ts`：

1. **结果门优先于轮数下限**（`convergence.py:94-116`）：第一圈就独立验证通过就立刻停——"不为进化的仪式感付费"。agentdeck 的 goal 循环应把"外部裁判通过"放在"最少圈数"检查之前；
2. **停滞 ≠ 耗尽**：4 种停滞模式（spinning/oscillation/no_drift/diminishing_returns，`stagnation.py:58-71`）分类处理，检测到停滞就换策略（对照 `delegate.ts` 换人格/换后端重派）而不是继续空转烧完预算；
3. **收缩式工作集**：每圈结束把"已证明通过的子任务"冻结（`focus.py`），下一圈只对失败/回归/新增的子目标重派——agentdeck 的 issue-store 天然支持按 issue 粒度冻结；
4. **无进展超时取代纯时长超时**（`loop.py:98-106` 的废弃迁移）：watchdog 盯"实质进展事件"而非时钟——agentdeck 的 `event-log.ts` 已有事件流，加个 cursor 就能实现同款；
5. **每圈 token 收据**：fail-closed 记账（`provider_usage.py`）让"这圈花了多少"成为 event-log 里的一等公民，为后续成本归因打地基。

### 7.5 可借鉴点四：runtime 抽象的三个细节

agentdeck `backends/*` 已有 5 个后端，ouroboros 的 14 后端抽象里三个细节值得吸收：

1. **能力协商代替名字分支**（`adapter.py:962-975`）：给 backend 接口加 `capabilities`（如 resume 支持/结构化输出/工具白名单），runner 查标志而非 `if (backend === 'dsh')`——后端数量增长时分支不爆炸；
2. **统一生命周期状态机**（`adapter.py:120-138`）：把各 CLI 的事件名映射到 connecting/running/completed/failed 终态集合，event-log 里的状态就规范了；
3. **局限显式文档化 + fail-loud**（`zcode_cli_runtime.py:16-28` 的范式）：zcode 无 `--model` 旗标这一事实被写进模块 docstring（含验证过的版本号），错配时打警告而非静默忽略——agentdeck 的 `backends/zcode.ts` 同样面临模型选择问题。

### 7.6 可借鉴点五：双脊柱的启示

ouroboros 把"产品运行态脊柱"（SQLite 事件库）与"开发改进态脊柱"（根目录 markdown：HANDOFF.md 是漏斗数据+决策记录，backlog.md 是审计积压，project-context.md 是实现纪律）**分开维护**。agentdeck 可以照此把 `docs/LOOP-ENGINEERING.md` 升级为"改进循环自己的状态脊柱"：每轮 teardown/借鉴落地后，在 markdown 里记录决策与证据，供下一轮改进的 agent 读取——这正是 Loop 4 在"deck 开发"层面的最小可行实现，且零代码成本。

### 7.7 过度设计、不值得学的部分

1. **frugality 凭据机制**（`frugality.py` 1443 行 + `provider_usage.py` 1462 行 + orchestrator 侧 `frugality_proof.py`/`frugality_runtime_attestation.py`）：为了证明"聚焦进化真的省了 ≥10% token"，构建了配对对照/处理组、密封派发配置、适配器证明链、每单元调用次数守恒……学术级严谨，但默认输出永远是 `insufficient_data`（对照臂从不自动启动）。对 agentdeck：**记账值得抄（每圈 token 收据），证明体系不值得**。
2. **本体（ontology）哲学层**：ontology schema、本体相似度收敛（0.95）、OntologyMutation/ontology_aspect/ontology_questions 一整套概念税。实际收敛判据里"结果门"才是权威（`convergence.py:94-116`），本体相似度更多是品牌叙事。agentdeck 用普通 goal+AC 即可，不必引入本体层。
3. **规模本身**：32.4 万行 Python 实现"采访+规格循环"，`backlog.md` 自曝 158 项审计发现、29 个上帝对象、14 个被禁用的 mypy 错误码掩盖 430 个真实错误。`mcp/` 88 文件、`orchestrator/` 135 文件的复杂度大部分来自 14 runtime × 多传输（CLI/MCP/plugin）× 后台 job 的组合爆炸。agentdeck 服务 5 个后端 + Electron 单一形态，不应追这个面。
4. **双 TUI**：Rust TUI（4,819 行）与 Python Textual TUI 并存，且终端壳层已外移到 ourocode 仓库——Rust 部分基本是遗留资产。它唯一干净的启示是"只读仪表盘直读事件库"这个模式（agentdeck 的 renderer 本来就只读 store，已等价）。
5. **22 个 skill × 21 个 agent 的九宫格人格体系**（`README.md:445-459`）：营销好看，实际链路只依赖 wonder/reflect/evaluator/lateral 几个角色。

---

## 8. 结论：架构评价与风险

**架构评价**：ouroboros 是"Loop Engineering 四层模型"里少见的把 **Loop 2（验证）做厚、Loop 4（改进）做实**的开源样本。它的核心洞见有三条，且都有代码背书：

1. **自我改进的安全形态是"改进规格"而非"改进自己"**——进化对象（Seed）可验证、可快照、可回滚，进化机制本身（ConvergenceCriteria/focus/watchdog）全是确定性代码，LLM 只负责提议（reflect），永不负责裁决；
2. **循环收敛 = 剩余工作收缩**（`focus.py:1-3`）——active AC 集合逐代缩小到零，比"本体相似度 0.95"的哲学叙事更是工程上真正起作用的停止机制；
3. **预算控制的正确位置在停止条件的排序里**——结果门放在最小代数之前（第 1 代通过就停）、停滞早停交给破局、看门狗盯进展不盯时钟。

**风险与局限**：

- **复杂度失控是现实而非假设**：维护者自己的 backlog.md 记录了 158 项审计发现，类型安全压制集中在"构造全部后端的 runtime 工厂与 MCP wire 边界"——恰好是最要害的两处（`backlog.md` Executive summary）；
- **每代成本极高**：一代 = 完整 Execute + 三段评估 + Wonder/Reflect 多次 LLM 调用，30 代上限是必要保险而非富余；采访门控（歧义 ≤0.2）实质是把成本从"多代试错"转移到"前期人时"；
- **"自我改进"的营销语义大于实际**：README 明确否认重写自身架构（`README.md:137-139`），若按"agent 改自身提示词/代码"的严格 Loop 4 定义，ouroboros 只提供了机制骨架（门控/预算/快照/回滚），没有提供那个被改进的对象——这部分留给 agentdeck 自己设计（见 7.2 的落地路径）；
- **安全边界依赖 CLI 自身权限模式**：无 OS 级隔离，`UNRESTRICTED` 档存在且仅警告；对单人本地工具可接受，对 agentdeck 这类多 agent 并行的桌面编排器，隔离强度需要另加 worktree/容器层。

**一句话收束**：把 ouroboros 的"进化循环骨架"（AC 位置身份 + 确定性工作集 + 结果门优先 + 世代快照回滚 + fail-closed 记账）移植进 agentdeck 的 goal-controller/issue-store/event-log 三件套，把它的"哲学层"（ontology/人格/frugality 证明）留下——这是本仓对 agentdeck Loop 4 空白最直接的填补路径。

---

### 附：本报告直接引用的核心源码文件清单（28 个）

| 文件 | 行数 | 用途 |
|---|---|---|
| `src/ouroboros/evolution/loop.py` | 2098 | 进化主循环 |
| `src/ouroboros/evolution/reflect.py` | 1072 | Reflect 引擎与 AC 补丁 |
| `src/ouroboros/evolution/wonder.py` | 705 | Wonder 引擎 |
| `src/ouroboros/evolution/convergence.py` | 603 | 收敛/停滞判定 |
| `src/ouroboros/evolution/frugality.py` | 1443 | 节俭凭据 |
| `src/ouroboros/evolution/provider_usage.py` | 1462 | token 记账 |
| `src/ouroboros/evolution/focus.py` | 238 | 工作集选择 |
| `src/ouroboros/evolution/watchdog.py` | 610 | 看门狗 |
| `src/ouroboros/evolution/generation_claims.py` | 620 | 世代租约 |
| `src/ouroboros/evolution/rewind.py` | 80 | 回滚协议 |
| `src/ouroboros/ralph_loop.py` | — | Ralph 后台循环 |
| `src/ouroboros/bigbang/interview.py` | 1804 | 采访状态机 |
| `src/ouroboros/bigbang/ambiguity.py` | 1107 | 歧义评分与门控 |
| `src/ouroboros/backends/factory_registry.py` | ~140 | runtime 注册表 |
| `src/ouroboros/orchestrator/adapter.py` | 2000+ | AgentRuntime 协议 |
| `src/ouroboros/orchestrator/runtime_factory.py` | ~400 | runtime 工厂 |
| `src/ouroboros/orchestrator/zcode_cli_runtime.py` | ~300 | zcode 适配（样例） |
| `src/ouroboros/mcp/tools/definitions.py` | 707 | 32 个 MCP 工具组装 |
| `src/ouroboros/mcp/resources/handlers.py` | — | MCP 资源与脱敏 |
| `src/ouroboros/persistence/event_store.py` | — | 事件溯源 |
| `src/ouroboros/evaluation/pipeline.py` | — | 三段评估 |
| `src/ouroboros/resilience/stagnation.py` / `lateral.py` / `recovery.py` | — | 停滞与破局 |
| `src/ouroboros/sandbox.py` / `claude_permissions.py` / `core/security.py` / `core/hitl_contract.py` | — | 安全边界 |
| `src/ouroboros/runtime_instruction_artifacts.py` | — | 宿主指令注入 |
| `crates/ouroboros-tui/src/main.rs` + `db.rs` | 829+1240 | Rust 只读仪表盘 |
| `hooks/hooks.json` + `scripts/keyword-detector.py` + `scripts/drift-monitor.py` | — | 宿主钩子 |
| `skills/evolve/SKILL.md` | — | 进化技能定义 |
| `README.md` / `docs/architecture.md` / `project-context.md` / `HANDOFF.md` / `backlog.md` | — | 定位与开发态脊柱 |
