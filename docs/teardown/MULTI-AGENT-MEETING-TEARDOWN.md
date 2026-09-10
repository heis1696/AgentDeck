# 多 Agent 会议/圆桌/辩论系统拆解报告（会议模式专项轮）

> 调研时间：2026-09-10
> 调研方法：5 个仓库浅克隆至 `teardown/repos/`（已 gitignore），4 个子代理并行源码精读 + 1 篇论文（MAST）全文提取；全部结论带 path:line 引用
> 目的：为 `docs/TEAM-MEETING-CONSTRUCTION.md`（结构化多 agent 会议模式）寻找外部参照实现，验证或优化已冻结的设计决策
> 声明：克隆副本只存本地不入库；引用行号以克隆时 commit 为准

| 项目 | 星数 | commit | 一句话结论 |
|---|---|---|---|
| microsoft/autogen | 60.9k | `027ecf0` (2026-04-06) | 群聊基础设施最全（终止条件可组合、双台账），但**没有确定性收敛门**，全量广播上下文 O(n²) |
| OpenBMB/ChatDev | 34.3k | `4fb2db0` (2026-07-24) | 本地 main 是重写版 2.0（图工作流）；经典链在 `chatdev1.0` 分支；收敛令牌 `<INFO>` + 上限双出口最成熟 |
| OpenBMB/AgentVerse | 5.1k | `f90c4bd` (2024-09-09) | vertical-solver-first 内循环（并发质疑→只收反对→空则收敛）≈ 我们 R1↔R2 的现成参照；recruiter/manager 是空壳 |
| Skytliang/Multi-Agents-Debate (MAD) | 612 | `e58d146` (2025-12-16) | "裁判单方偏好即收敛"的反面教材；但两步判决（先列候选再裁决）防锚定值得抄 |
| erickong/agent-roundtable | 8 | `f36d66c` (2026-03-18) | 与我们形态最像的最小参照：结构化攻击 `{target, point, weakness}` + 定向投递答辩；但收敛是单个 LLM 布尔 |

论文：**MAST**《Why Do Multi-Agent LLM Systems Fail?》(arXiv:2503.13657)——1642 条 trace、14 条失败模式、三大类占比 FC1 44% / FC2 32% / FC3 24%；LLM-as-Judge（o1）κ=0.77 vs 人类专家 κ=0.88。

---

## 1. AutoGen（agentchat `_group_chat` + magentic-one）

路径缩写：`MGR`=_base_group_chat_manager.py、`BASE`=_base_group_chat.py、`SEL`=_selector_group_chat.py、`RR`=_round_robin_group_chat.py、`MO`=_magentic_one/_magentic_one_orchestrator.py、`MOP`=_magentic_one/_prompts.py、`TERM`=conditions/_terminations.py（均在 `python/packages/autogen-agentchat/src/autogen_agentchat/` 下）。注：独立的 `autogen-magentic-one` 包在本地快照只剩 README（原版已废弃并入 agentchat），移植版 `_prompts.py` 台账 prompt 与 GitHub v0.4.4 tag 原独立版逐字一致，已交叉核实。

### 1.1 回合驱动
- 主循环是事件驱动闭环而非 while：任一 agent 回复 → `MGR:134-170 handle_agent_response`（更新 thread → 判终止 → 选下一位）。选人抽象在 `MGR:305-318 select_speaker`。
- **round_robin = 纯代码取模**（`RR:72-82`）；**selector = LLM 选人**：`selector_func` 代码函数优先（`SEL:162-177`），否则拼 `{roles}`+全量历史进选人 prompt（原文 `SEL:607-614`），正则数名字失败重试 3 次（`max_selector_attempts`，`SEL:616`），全败 fallback 重复上一发言人（`SEL:302-308`）。
- participant 执行异常 → `CTN:150-159` 发 GroupChatError → manager 直接 fail-fast 终止全会话并把异常抛回调用方（`MGR:267-270`、`BASE:550-554`）。

### 1.2 终止条件
- 11 种：MaxMessage/TextMention（可限定 source）/Functional(代码谓词)/TokenUsage/Handoff/Timeout/External/SourceMatch/TextMessage/FunctionCall/StopMessage（`TERM` 全文件）。`__and__`/`__or__` 可组合（`base/_termination.py:79-85, 92-179`）。
- 终止后**自动 reset 所有条件 + turn 归零**（`MGR:203-205, 222-223`）→ 不带 task 再 `run()` 即续聊（`RR:290-293` docstring）。`save_state/load_state`（`BASE:748-834`）但 docstring 警告运行中存档不一致（`BASE:773-777`）——落盘必须在轮边界。
- **没有"收敛语义终止"的现成实现**：最接近的是 MO 的 `is_request_satisfied`（`MO:388-391`，LLM 自由判断）和 FunctionalTermination 钩子（`TERM:158-226`）。确定性收敛门是 AutoGen 的空白。

### 1.3 Magentic-One 双台账（重点）
- Task ledger = `task/facts/plan` 三字符串（`MO:95-97`）；facts 由 pre-survey prompt 生成，强制四节：`GIVEN OR VERIFIED FACTS / FACTS TO LOOK UP / FACTS TO DERIVE / EDUCATED GUESSES`（原文 `MOP:6-27`）。
- Progress ledger 五键 JSON（原文 `MOP:59-100`）：`is_request_satisfied / is_in_loop / is_progress_being_made / next_speaker / instruction_or_question`，每键带 `{reason, answer}` 双字段（schema `MOP:103-118`）。解析失败重试上限 10 次，仍败 `raise ValueError` fail-loud（`MO:94, 318-384`）。
- **stall 计数是反递增的**：`not progress → +1`；`elif in_loop → +1`；**否则 −1（下限 0）**——正常轮会回吐 stall 额度（`MO:394-399`）。达 `max_stalls`（默认 3，`MOG:119`）→ replan。
- **replan 三步**（`MO:451-476, 262-298`）：① facts 重写 prompt 强制"至少新增/修正一条 educated guess"（`MOP:121-130`）；② plan 重写 prompt 要求"先归因失败根因，再出新计划并明确避免重复犯错"（`MOP:133-136`）；③ **给全员发 reset、清空 message thread、把更新后的 task ledger 全文广播作为唯一下文**（`MOP:37-56` + `MO:275-295`）——replan 后历史清零，只留台账。
- 指令注入：`instruction_or_question` 广播全员 + 只向 `next_speaker` 定向发请求（`MO:408-440`）。

### 1.4 上下文/下派/护栏
- **全量广播**：每人 buffer 全部消息，每 agent token 成本近似 O(n²)（`BASE:42-54`、`CTN:56-73, 130-133`）。裁剪只有 BufferedChatCompletionContext（只作用于选人 prompt，`SEL:532-588`）与 MO replan 清 thread，无逐轮摘要。
- Swarm HandoffMessage 自带 `{target, context}` 结构化通道，普通工具调用产物打包进 context 带给目标（`messages.py:421-430`、`_assistant_agent.py:1364-1394`）；A→B→A 无限转无深度/环检测（`SW:82-98`）。
- **普通群聊 max_turns 默认 None（无限制）**（`RR:249` 等）；全系只有 MagenticOne 默认 max_turns=20 / max_stalls=3（`MOG:117, 119`）。无默认成本熔断。

## 2. AgentVerse

### 2.1 TaskSolving 主循环（真实执行路径）
- 驱动者是代码：`tasksolving.py:59-70 while not environment.is_done(): environment.step(advice, previous_plan)`。每轮四段硬编码流水线：Recruitment → Decision → Execute → Evaluate（`environments/tasksolving_env/basic.py:45-109`）。
- **vertical-solver-first 内循环**（`rules/decision_maker/vertical_solver_first.py:26-72`）：solver 出 initial plan 广播 → `max_inner_turns`（默认 3，`:24`）循环：critics 并发评审（`:45-49`）→ **只收集 `is_agree=False` 的非空反对，agree 内容直接丢弃**（`:60-63` + `output_parser.py:478-480`）→ **反对为空即 "Consensus Reached!" break**（`:64-65`）→ 反对广播全员、solver 修订（`:68-69`）。
- evaluator 判定影响：score 全过 → success；否则产出 `advice` 字符串由**代码**回注下一轮 role_assigner 与 solver prompt（`basic.py:95-107`、mgsm `config.yaml:13-14`）。evaluator prompt 还会建议"下一轮该招什么专家"——跨轮闭环。
- **宣传 vs 真实**："recruiter" 一词源码零命中（代码叫 role_assigner，`rules/role_assigner/role_description.py:36-39`）；recruit 只给固定成员重命名+重写人设，新角色继承旧角色聊天史（隐性 bug）；`decision_maker/dynamic.py:24` 标着 "To Do: implement dynamic"，无任何 config 使用——**"manager 智能规划"是空壳**。

### 2.2 上下文与护栏
- 无共享黑板：每 agent 独立 ChatHistoryMemory，共享靠代码主动复制（broadcast_messages，`vertical_solver_first.py:74-77`）。critic 默认 `max_history=3`（`agents/tasksolving_agent/critic.py:22, 79-84`）——只看最近 3 条，天然截断但也看不到早期反对。
- brainstorming decision maker 最激进：每轮 `memory.reset()` 清空所有人，只广播一条 `sender="Summary From Previous Discussion"` 的 solver 总结（`decision_maker/brainstorming.py:58-66`）。
- max_turn 默认 10（`basic.py:26`）、内层 3；example config 大量配 `max_retry: 1000`（commongen `config.yaml:93`）——解析失败无限重打，无退避无放弃。成本只有事后 per-agent 报表（`llms/openai.py:452-489`、`basic.py:123-132`），**无预算硬闸**。`tasksolving.py:53` 的 max_rounds 键根本没人读（死配置）。
- **两个收敛坑**：critics 缺席/静默 = 隐性同意（`vertical.py:48-52` 只收反对，没说话不算反对）；`score >= 8` 魔法阈值（`basic.py:95-99`，作者自注 arbitrary）。

## 3. ChatDev

本地 main = 重写版 2.0（图工作流 `entity/ runtime/ workflow/ yaml_instance/`）；经典 1.0 在 `chatdev1.0` 分支（GitHub 拉取核对）。2.0 的 `yaml_instance/ChatDev_v1.yaml` 用新框架逐节点复刻了经典链，是新旧对照最好样本。

### 3.1 双 agent 循环与收敛令牌
- 1.0 核心循环 `chatdev1.0:chatdev/phase.py:55-182 chatting`：`chat_turn_limit=10` 默认（`:64`）；approve 信号 = 输出**最后一行**以 `<INFO>` 开头（`camel/agents/chat_agent.py:269-272`——被注释掉的宽松版在 `:270`，防正文误伤的设计点）；任何一方 info=True 即短路结束（`role_playing.py:253-255, 271-273`）。**原版双方均可结束——MAST 的"上级专属终止 +9.4%"是论文干预实验，不在仓库任何分支**。
- 2.0 升级为关键词边条件：`runtime/edge/conditions/keyword_manager.py:36-49`（none 关键词优先否决 → any → regex）；Code Reviewer 输出 `<INFO> Finished` 才进测试（`ChatDev_v1.yaml:924-939`）。
- 循环上限三出口：ComposedPhase **执行前后各查一次 break_cycle**（`composed_phase.py:138-161`，`:150-155`）；2.0 loop_counter 没到上限返回空列表静默吞下游、**到上限才放行一条强制收敛消息**（`loop_counter_executor.py:16-52`）；环执行器 `cycle_executor.py:210` `while iteration < max_iterations`。

### 3.2 阶段链 / 审查 / 上下文
- ChatChain = 纯线性数组（`CompanyConfig/Default/ChatChainConfig.json`），无 DAG 无回退；跨 phase 传递 = `ChatEnv.env_dict` 九个强类型槽位（`chatdev1.0:chatdev/chat_env.py:62-73`：task_prompt/modality/ideas/language/review_comments/error_summary/test_reports…）+ 代码全文塞 prompt（`chat_env.py:174-175`）。**唯一落盘门：修改结论含 ``` 代码块才 update_codes**（`phase.py:466-473`）。
- Review prompt 的对抗设计（`PhaseConfig.json` CodeReviewComment；2.0 拷贝 `ChatDev_v1.yaml:140-154`）：先立 6 条 regulation（含第 5 条"整个项目符合用户任务"——**高层目标验证只是 prompt 软规则**，MAST +15.6% 同为论文实验），再要求 **一次只提一条最高优先级意见**，结尾收敛令牌；答辩者（Programmer）被要求**输出完整全文且格式固定**，测试修复版甚至写"从头实现就开除你"（`yaml:410, 424`）。
- 真实判据测试：`exist_bugs()` 子进程跑 `python main.py` + 3 秒超时 + stderr 含 Traceback 才算 bug（`chat_env.py:107-152`）——GUI 程序退出码 0 但功能错会误判通过。
- **伪对话警示**：默认 chain 8 个 phase 有 6 个 `max_turn_step: 1`（`ChatChainConfig.json`）+ `phase.py:258-263 assistant_only` 短路——名为双 agent 实为两次单轮调用。
- token 预算：1.0 CAMEL 超限静默 terminated（`chat_agent.py:274-280`，失败被当正常结束）；2.0 TokenTracker 逐节点记账**但不熔断**（`token_tracker.py:36-153`）。2.0 的 `context_window` 策略（0=执行后清空/-1=无限/N 条）与工具轨迹回放 `context_trace`（`agent_executor.py:1004-1017`）是上下文管理的一等公民化。

## 4. agent-roundtable + MAD

### 4.1 agent-roundtable（约 1500 行）
- 固定议程 R0 开场 → R1 独立观点 → R2 攻击 → R3 回应 → (R4 聚焦) → Final，**硬编码在 `meeting.py:115-243`**；议程是代码，但开场/总结/收敛/终局全是 LLM 调用（`agents.py:414-527`）。
- **攻击结构化三兄弟**：R2 必须输出 `{target_agent, target_point, weakness}`（`prompts.py:76-82`）；R3 系统按 `target_agent` 过滤后**定向投递给被攻击者并强制回应**（`_extract_attacks_on_agent`，`meeting.py:24-36, 186`；R3 prompt `prompts.py:101-135`）。
- 终止：**无收敛门**——R1-R3 无条件跑，唯一分支 `should_continue`（moderator 总结 JSON 里的一个 LLM 布尔，`prompts.py:186`、解析 `agents.py:482`；JSON 解析失败回退 `round_index < 3` 即 `agents.py:459`）。novelty/critique 分数生成后控制流**零使用**——装饰性功能。
- 状态传递：R1→R2 传上一轮**全部发言 JSON 全文**+总结（`meeting.py:15-21, 155-161`）；R3→R4 只传压缩摘要（"新观点|关键攻击|值得保留"，`meeting.py:39-52, 210`）；终局传完整逐字实录（`:238-243`）——SPECDOC 宣称"传摘要"与代码传全文有差距。
- 工程反面：会议循环写两份（`meeting.py` 与 `meeting_streaming.py` 复制粘贴）；LLM 改头衔用正则刮自由文本（`meeting.py:67-94`）；max_rounds=4 三处硬编码、专家固定 4 人无配置入口、温度硬编码 0.7；逐轮 RoundSummary 只在内存、最后才写 meeting_report.md（`main.py:380-384`）。每会 25-40 次 LLM 调用。

### 4.2 MAD（源码仅 `code/debate4tran.py` + `code/utils/` 约 500 行）
- 固定 3 角色（affirmative/negative/moderator，`debate4tran.py:31-35`）；affirmative 先绑定一个具体产物（baseline translation）再辩护（`:124-132` + `config4tran.json:10`）；negative 被 prompt 硬性要求反对（`config4tran.json:11`）——**无证据的强制抬杠**。
- 判决：moderator 每轮输出 JSON，**代码只检查 `debate_translation != ''`**（`debate4tran.py:215`），`Whether there is a preference` 字段从不被读取——收敛 = 裁判单方认为有明显更优方，辩手从未被告知判决。跑满 3 轮（`max_round` 默认 3，`:60`）→ 兜底 Judge **只看双方首轮发言**做两步判决：先无理由列候选、再裁决（`:236-259` + `config4tran.json:13-14` 两步 prompt——防位置偏差的便宜技巧）。
- 工程反面：判决 JSON 用 `eval()` 解析（`:162, 230, 254`）——不安全且脆；`broadcast/speak` 等死代码从未调用（`:180-208`）；记忆全量累积无截断，超限即 max_tokens 变负报错（`agent.py:97-99`）。

## 5. MAST 论文（arXiv:2503.13657）

14 条失败模式（1642 条 trace）：
- **FC1 系统设计 44%**：FM-1.1 违反任务规格 11.8%；FM-1.2 违反角色规格 1.5%；**FM-1.3 步骤重复 15.7%（最高频）**；FM-1.4 丢失对话史 2.8%；**FM-1.5 不知道终止条件 12.4%**
- **FC2 agent 间失调 32%**：FM-2.1 对话重置 2.2%；FM-2.2 不请求澄清 6.8%；FM-2.3 任务脱轨 7.4%；FM-2.4 信息扣留 0.85%；FM-2.5 忽视他人输入 1.9%；**FM-2.6 言行不一 13.2%**
- **FC3 任务验证 24%**：FM-3.1 过早终止 6.2%；FM-3.2 无/不完整验证 8.2%；FM-3.3 错误验证 9.1%

缓解措施（论文）：明确终止条件 + **指定唯一可终止角色**（AG2/ChatDev 干预实验 +9.4%/+15.6%，论文级证据非仓库实现）；模块化简单 agent；自验证+交叉验证；记忆与状态管理。LLM-as-Judge（o1+少样本）κ=0.77 < 人类 κ=0.88——LLM 裁判不够，需要确定性门。

---

## 6. 跨项目综合 → 对 AgentDeck 会议方案的回填

### 6.1 交叉验证了我们的四个核心假设

1. **"代码定流程、LLM 填内容"的分工线**：AutoGen（manager 是代码类）、AgentVerse（`environment.step` 四段硬编码）、agent-roundtable（议程硬编码）、ChatDev（chain JSON 数据化）全部站在同一边；无一例外。
2. **确定性收敛门是全行业空白**：AutoGen 没有（`is_request_satisfied` 是 LLM 自由判断）、AgentVerse 沉默即同意+魔法阈值、agent-roundtable 单个 LLM 布尔、MAD 裁判单方偏好。我们"全员显式 stance + 反对 resolved + 代码裁决"的设计补的正是这个洞。
3. **结构化反对 + 定向投递**在 400KB 的小项目里就能跑通（agent-roundtable），我们的 ref+resolved 是它的硬化版。
4. **每轮纪要落台账**：五个项目没有一个做到（roundtable 逐轮只在内存、AutoGen 只在 stall 时清 thread 广播台账）——我们的"每轮 envelope 落盘 + 注入用台账"是独有增量。

### 6.2 回填到施工方案的改动（详见 TEAM-MEETING-CONSTRUCTION.md §11）

| 来源 | 机制 | 改动 |
|---|---|---|
| AutoGen `MO:394-399` | stall 反递增计数（正常轮回吐额度） | 无进展熔断改进版：连续计无进展，正常轮 −1 下限 0 |
| AutoGen `MOP:103-118` | ledger entry 的 `{reason, answer}` 双字段 | stance/纪要字段全部带理由（部分已有，补齐 envelope） |
| AutoGen `MOP:121-136` | replan 先归因失败再出计划、强制更新一条猜测 | 连续 2 轮无进展转 waiting_user 时，主持词要求先归因 |
| AutoGen `TBASE:79-85` | 终止条件 AND/OR 可组合 | 收敛门 = (全员 agree ∧ 反对 resolved) ∨ 熔断 ∨ 预算，写成组合器 |
| AutoGen `BASE:773-777` | 运行中 save_state 不一致警告 | 状态落盘只在轮边界（写进不变量 5 条补充） |
| AutoGen `MOG:117,119` vs `RR:249` | 默认上限必须显式 | maxRounds 必填不可为 null，拒绝无上限配置 |
| AutoGen `CTN:150-159` | 参与者执行异常 fail-fast | 发言回合硬错误（非 429 类）直接 meeting failed，不走 failures 重试 |
| AgentVerse `vertical_solver_first.py:26-72` | 内循环：只收反对/agree 丢弃/空则收敛/上限 3 | R1↔R2 加 `maxInnerTurns`（默认 3）；答辩轮上下文只注入反对清单，agree 只计票不注入 |
| AgentVerse `vertical.py:48-52` | 沉默即同意的坑 | 反向采纳：缺席/解析失败 = 未收敛（fail-closed） |
| AgentVerse `brainstorming.py:58-66` | 轮末清空换单条总结 | 反向采纳：不 reset（丢早期反对），但确认"下轮注入 = 台账摘要而非全量"的节奏 |
| ChatDev `chat_agent.py:269-272` | `<INFO>` 只认最后一行（防正文误伤） | stance 标记声明"必须为最后一行"，解析取最后一个且校验行首位置 |
| ChatDev `composed_phase.py:150-155` + `loop_counter_executor.py:26-48` | 上限双出口：条件 OR 上限，超限放行强制收敛消息 | 预算耗尽不直接 waiting_user，先跑一轮强制综合（未决项标 unresolved）再交主席 |
| ChatDev `ChatChainConfig.json` | 议程即数据（chain 外置） | 会议议程数据化（Meeting.agenda 可配置），Phase 4 模板的地基 |
| ChatDev `PhaseConfig.json` review | 质疑者一次只提一条最高优先级意见 | R1 每位质疑者每轮最多 3 条反对、标注 1 条最高优先级，防意见雪崩 |
| ChatDev `phase.py:466-473` | 确定性产物门（含代码块才落盘） | 纪要 envelope 过 schema 校验才入账（已有），补充"自述已记录无效" |
| ChatDev 反面 | 超限静默当正常结束 | stopReason 必须区分 converged / no_progress / budget / failed（状态位不同） |
| roundtable `prompts.py:76-82, meeting.py:24-36` | 攻击结构化 + 按对象定向投递 | R2 答辩上下文按 defender 过滤反对清单（只看指向自己的） |
| roundtable `parser.py:11-74` | 三级解析回退（直解→代码块→大括号→markdown 字段） | envelope 解析链照抄；**解析失败 fail-closed = 未收敛** |
| roundtable `meeting.py:39-52` | 跨轮压缩摘要模板（新观点\|关键攻击\|值得保留） | 每轮 envelope 增加轮摘要字段，下一轮注入用摘要 |
| roundtable 反面 | 评分生成后控制流零使用 | 不做打分功能（砍掉省解析成本）；文档记录该教训 |
| MAD `config4tran.json:13-14` | 两步判决（先列候选再裁决）防锚定 | 主席处理行动项争议时的可选裁决法（Phase 4） |
| MAD `debate4tran.py:124-132` | 挑战对象绑定具体产物 | R1 质疑 prompt 明确"只针对 R0 汇报中的具体条目" |
| MAST FM-1.3 (15.7%) | 步骤重复是最高频失败 | 强化 seenKeys 去重 + no-progress；主持词每轮重申"已派过的工作不要重派" |
| MAST FM-1.5 (12.4%) | 不知道终止条件 | 会议协议块明确教终止语义（stance/收敛/未决，已有但补教学措辞） |
| MAST FM-2.6 (13.2%) | 言行不一 | 收敛判定只认结构化 stance，不认"我们达成一致"的散文（已有，钉进不变量） |
| MAST FM-3.1/3.2/3.3 | 过早终止/验证缺口 | advisory/verified 两态 + 行动项验收条件必填（已有） |
| MAST 论文 | LLM 裁判 κ=0.77 < 人类 0.88 | 佐证 D1（主持人=纯代码）；书记员小模型仍只做措辞不做判定 |

### 6.3 明确不学清单（外部）

SelectorGroupChat 的 LLM 选人+role-play prompt+正则数名字（固定议程下选人零成本可判定）；`TextMentionTermination("TERMINATE")` 暗号式终止；eval() 解析 LLM 输出；`max_retry: 1000`；全量广播 O(n²) 上下文；无限链式 handoff 无深度计数；LLM 改名正则刮取；会议循环复制粘贴两份；"负方必须反对"的强制抬杠；逐轮不落盘。
