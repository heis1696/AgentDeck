# 调研报告：从自然语言描述自动生成 Agent 定义（尤其 system prompt）

> 子任务交付物 · 检索日期 2026-09（实机抓取：code.claude.com、docs.anthropic.com、agentskills.io、GitHub API/仓库；标注"基于训练知识"处为补充）
> 背景诉求：研究如何"根据描述让模型自己创建 agent（利用 agent skill？），而不是所有参数都由用户填写，尤其系统提示词"。

## 0. 结论速览

1. **没有现成的"输入一句描述 → 输出完整可用 agent"银弹**，但生态里存在一条被官方与社区充分验证的主路径：**"文件即定义"格式（frontmatter + system prompt 正文）作为输出目标 + 一个结构化生成提示词（元提示词）把描述扩写成定义草稿 + 人工 diff 确认 + 轻量校验/评估回路**。Claude Code 官方的 subagent 创建流程本身就是这个模式。
2. Agent Skills（SKILL.md）**不能直接平移到"生成 agent 人设"**：它是"任务程序"（procedure），不是"人设"（persona）。可以平移的是它的两件东西：`description` 作为触发路由的设计方式，和 skill-creator 的"评测-迭代"回路。真正的平移目标格式是 **subagent 文件**（frontmatter + system prompt body）。
3. 对目标产品（Electron 桌面端、多 CLI 后端），推荐：**内部统一 agent schema 为单一事实源 → 描述驱动的生成向导（元提示词 + few-shot + 澄清追问）→ 字段级 diff 人工确认 → 按后端适配器序列化导出 → 保存时跑校验门 + 可选触发评测**。密钥/后端连接/权限永不自动生成。

---

## 1. 模式分类（5 类）

### 模式 A：文件即定义，"描述 → AI 写文件 → 人工确认"（Claude Code subagents / skills）

**代表做法（官方，已实机验证）**：
- Claude Code 官方文档"Subagents"页的第一节就是 **"Ask Claude to create the subagent"**：用户在对话里说一句 "Create a personal code-improver subagent in ~/.claude/agents/ that scans files and suggests improvements…"，Claude 直接写出文件（含 `name`、`description`、`tools` 列表、`model` 和 system prompt），然后文档明确要求第二步 **"Review the file"**（人工确认 frontmatter 是否符合意图）、第三步 "Try it out"（实测委派）。
- 文件格式：YAML frontmatter + Markdown 正文即 system prompt。只有 `name` 和 `description` 必填；可选字段有 `tools`、`disallowedTools`、`model`、`permissionMode`、`maxTurns`、`skills`、`mcpServers`、`hooks`、`memory`、`background`、`effort`、`isolation`、`color`、`initialPrompt` 等。
- 旧版还有 `/agents` 交互式向导（Running / Library 两个 tab，Library 支持创建、编辑、删除）。
- 安全边界先例（对推荐方案很关键）：**plugin 提供的 subagent 直接忽略 `hooks`、`mcpServers`、`permissionMode` 三个字段**——即"由他人/工具批量生成的 agent 定义不能自带权限与密钥配置"。
- Skills 侧（`SKILL.md` = `name` + `description` frontmatter + 指令正文）：`description` 是自动触发的唯一依据（"what it does and when to use it"），正文按需加载（progressive disclosure）；官方还给出了描述预算机制（技能清单预算 = 上下文 1%，单条描述合并上限 1536 字符）——说明"description 写得好不好"直接决定 agent 能否被正确路由，是生成器的重点产出物。
- skill-creator：Claude Code 内置/插件技能，现文档描述为**评测与迭代工具**（用 grader 对"带/不带 skill"跑同一批 prompt 打分、可设 CI 门槛），历史上也承担交互式创建 SKILL.md 的引导。
- 平移性结论：SKILL.md ≠ 人设；**平移到"agent 人设/系统提示词"的正确格式是 subagent 文件**；但 skills 的 `description` 触发设计 + skill-creator 评测回路可以原样借用。

### 模式 B：元提示词（meta-prompt）生成 system prompt

**代表做法**：
- **Anthropic metaprompt**（anthropic-cookbook `misc/metaprompt.ipynb`，已实机抓取全文）：机制 = 内置 few-shot 的 `<Task Instruction Example>` XML 示例（客服 agent、句意判断、文档问答等）→ 先输出**澄清问题** → 再产出带 `{$VARIABLES}` 占位符的完整指令模板 → 最后用示例变量值**试跑**。官方 caveats：设计用于单轮问答提示、产物不保证最优、必须迭代。
- **OpenAI prompt generator**（platform.openai.com/docs/guides/prompt-generation；本次抓取 403，内容基于训练知识）：meta-prompt 扮演"资深 prompt 工程师"，先最多 5 个澄清问题，再输出结构化 prompt（角色 / 上下文 / 指令 / 输出格式 / 约束 / 示例）。
- **Anthropic system prompt 最佳实践结构**（docs.anthropic.com 本次地区受限，基于训练知识 + cookbook）：角色 + 上下文/背景 + 明确指令（含边界与升级路径，"遇到 X 就做 Y"、"不确定时提问"）+ 示例 + 输出格式。

**要点**：元提示词的价值不在"一键生成"，而在**把"空白页问题"变成"填空问题"**：先追问、后产出、产出带变量模板、最后试跑验证。

### 模式 C：多步流水线生成器（生成 + 校验 + 评估）

**代表做法**：
- **SkillForge**（github.com/mmlong818/skillforge，~88★，README 2026-09 实机抓取）：输入名称+描述，跑 **4 步流水线**：① 资格判定（该不该做成 skill）→ ② 内容规划（定位、触发场景、知识缺口、资源文件需求）→ ③ SKILL.md 生成（硬约束 80–150 行、≤600 行上限）→ ④ 资源文件 + 使用说明/验证清单。另有"修正已有 skill"3 步模式（诊断 → 重写 → 质量审计）。工程细节：`%%SKILL_BEGIN%%/%%SKILL_END%%` 标记提取防截断、流式进度、支持 Claude CLI / Anthropic API / OpenAI 兼容后端。**v1.5 的关键演进**：description 改为**触发评测驱动**——构造 should / should-not / near-neighbor 触发测试集并**实测选优**，"实测优先于自评分"。
- **AutoGen Studio**：声明式 JSON spec + 拖拽 UI（teams/agents/tools/models/终止条件），官方明确"非生产就绪，认证/安全/权限自己实现"。

### 模式 D：框架内"描述性字段即配置"（有配置、无生成）

- **CrewAI**：`Agent(role=…, goal=…, backstory=…, llm=…, tools=…)`，框架用模板把 role/goal/backstory 拼成 system prompt；支持 YAML（agents.yaml/tasks.yaml）+ `crewai create crew` 脚手架。**"描述"本身即字段**，但没有"从描述自动生成"这一步。
- **AutoGen（AgentChat）**：`AssistantAgent(system_message=…)`，system prompt 手写。
- **LangGraph**：`create_react_agent(prompt=…)`，无描述→agent 生成机制，官方强调自定义 prompt。
- **OpenAI Agents SDK**：`Agent(name, instructions, model, tools)` 声明式但 instructions 手写。

**结论**：这些框架解决"编排与运行"，不解决"生成"；生成靠外挂（Studio UI / CLI 脚手架 / YAML 模板）。对我们而言它们最有价值的是**字段清单**（name/role/goal/backstory/tools/model）。

### 模式 E：多 CLI 编排器与社区生态（先例与素材库）

- **wshobson/agents**：**单一 Markdown 源**（94 插件 / 202 agents / 183 skills / 105 commands）→ 按 harness 生成各自原生格式（Claude Code、Codex CLI、Cursor、OpenCode、Antigravity CLI、Copilot、Pi）。"one source-of-truth → per-harness native artifacts"正是多 CLI 后端序列化的现成先例。
- **davila7/claude-code-templates**：社区 subagent/command 的 Markdown 模板集（npm 包）——"从模板起步"的素材源。
- **Dicklesworthstone/claude_code_agent_farm**（918★）：结构化配置驱动 20+ Claude Code agent 并行（tmux 编排）——多 agent 配置格式的先例。
- **derek-codebridge/subagent-example-script**（117★）、**gensecaihq/Claude-Code-Subagents-Collection**（75+ subagents）：社区"生成器/集合"类仓库，说明用户确实有"描述→生成 agent 定义"的需求，但社区方案普遍是"人肉模板 + AI 扩写"，缺少校验与评估回路。

---

## 2. 字段分级：哪些适合自动生成，哪些留给人工

| 字段 | 归属 | 理由 |
|---|---|---|
| `name`（唯一 id） | ✅ 自动生成 | 低风险，可由描述提取 + schema 约束（小写连字符） |
| `description`（触发条件） | ✅ 自动生成（重点投入） | 决定路由命中率；SkillForge v1.5 证明应"先评测 description 再写正文" |
| system prompt（角色/边界/工作流/输出格式/示例） | ✅ 自动生成草稿 + 人工确认 | 核心诉求；元提示词 few-shot 产出 |
| `tools` 建议列表 | ⚠️ 自动生成**建议**（必须引用能力清单） | 直接生成工具名 = 幻觉高发区；生成器只能从后端 capabilities registry 里选 |
| `model` / `effort` 建议 | ⚠️ 自动生成建议 | 同上，从后端可用模型清单里选 |
| backend（CLI 类型与连接方式） | ❌ 人工 | 环境事实（装了什么、怎么认证），LLM 不知道 |
| API key / 密钥 | ❌ 人工，禁止出现在生成输出 | 安全红线；密钥管理走系统级凭据存储 |
| 权限 / 审批策略（allowlist、permissionMode） | ❌ 人工，默认最保守 | Claude Code 官方对 plugin subagents 禁用权限类字段即为先例 |
| 工作目录 / 沙箱隔离 | ❌ 人工 | 环境事实 |
| MCP 服务器配置 | ❌ 人工 | 含密钥与网络事实 |

---

## 3. 常见坑与对策

1. **幻觉字段**：生成不存在的工具名/模型名/权限 → 对策：生成器输出必须与后端**能力清单**（tools/models/permission modes 注册表）比对，比对失败即标记"建议"而非写入；保存时 schema 校验。
2. **过长提示词**：生成物膨胀、稀释重点 → 对策：硬上限（SkillForge 600 行；Claude Code 描述 1536 字符）、分节模板、progressive disclosure（正文按需加载）。
3. **模板僵化**：元提示词输出同质化 → 对策：多样 few-shot 样例 + 澄清追问保留用户原话特征词 + 允许用户对单字段重新生成。
4. **缺乏评估回路**：生成完即止，好坏无人知 → 对策：skill-creator 式触发评测（should/should-not/near-neighbor 输入集 + grader，实测优先于自评）；"改进提示词"按钮走 SkillForge 修正模式（诊断→重写→审计）。
5. **description 与正文脱节**：description 写不好，agent 永远不被路由 → 对策：生成顺序先 description（含触发评测）后 system prompt，二者分开校验。

---

## 4. 对"桌面端多 agent 编排器（Electron，多 CLI 后端）"的推荐方案

**推荐组合：模式 A 的骨架 + 模式 B 的内核 + 模式 C 的校验门 + 模式 E 的序列化层。**（不采用模式 D：框架内置的"描述即配置"适合代码内建团队，不适合面向普通用户的向导式生成。）

1. **内部统一 schema（单一事实源）**：
   `{ id, name, description, systemPrompt, backendId, model?, tools?: string[], permissions?, workdir?, meta: { source, updatedAt } }`
   生成器只允许产出 `name / description / systemPrompt / tools建议 / model建议` 五个字段，其余字段一律不进入生成 schema。
2. **创建向导（描述 → 草稿 → diff 确认）**：
   - 用户输入一句描述（可选回答 2–3 个澄清问题）；
   - 用任一已配置 CLI 后端（推荐固定选一个强模型做"生成后端"，与执行后端解耦）跑内置 agent-crafter 元提示词（参照 Anthropic metaprompt：few-shot 内置 3–5 个高质量 agent 样例 + 澄清 + 变量模板 + 输出严格 JSON schema）；
   - 渲染**字段级 diff 视图**（生成值 vs 默认值），人工确认后落盘；backend/密钥/权限默认为最保守值，需用户显式配置。
3. **格式兼容**：以 Claude Code subagent 格式（frontmatter + body）为中间交换格式，支持导入/导出 `.claude/agents/*.md` 与社区集合（wshobson/agents、davila7/claude-code-templates 等，素材池 200+）；按后端适配器序列化（Claude Code → Markdown；自研/其他 CLI → JSON），即模式 E 的 one-source-of-truth 做法。
4. **保存时校验门 + 可选评测**：① JSON schema 校验；② tools/models 与后端能力清单比对（不存在的只降级为注释建议）；③ 可选触发评测：构造 3 条 should / 2 条 should-not 输入，实测 description 路由命中率，低分时提示用户重写 description。
5. **迭代回路**：每个 agent 提供"改进提示词"入口（把当前定义 + 用户反馈回传生成器，走诊断→重写→审计三步）。

**理由**：① 模式 A 是官方（Claude Code 内置流程）与社区双重验证过的路径，天然自带"人工确认"这道安全边界，契合桌面端密钥分散的现实；② 模式 B 几乎零基础设施成本，专治"空白页"；③ 模式 C 的校验门与触发评测补上社区工具普遍缺失的质量回路；④ 模式 E 的序列化层是"多 CLI 后端"的硬需求，已有成熟先例；⑤ 生成与执行分离（生成后端 ≠ 运行后端）避免单个后端故障拖垮创建流程。

---

## 5. 仓库接入点与落地 Wiring（agentdeck 实测，2026-09-17）

> 本节把 §4 的推荐方案映射到本仓库代码。前提更正：旧文档里的 `TeamView.tsx` 已在 commit 9942ba2 改名为 `src/renderer/src/components/AgentsView.tsx`（`docs/AGENT-PROFILES-PLAN.md:137` 有案）。

### 5.1 现状链路：agent 创建全靠手填

| 环节 | 位置 | 要点 |
|---|---|---|
| 表单 | `AgentsView.tsx:63-64` `add()` | 预置 `ag_<timestamp>`/backend=zcode/color；唯一硬性必填是 name（`:280` 保存按钮 disabled 逻辑） |
| IPC | `src/main/ipc/catalog.ts:18-32` | `agents:list/save/new-id/models` 四个通道，`save` 里 `parseAgents` 校验 + 过滤未安装后端 |
| 校验 | `src/main/ipc-validation.ts:329-354` | ≤100 项、`assertKeys` 拒绝未知字段、id/name/backend/color 必填、backend ∈ `BACKEND_IDS`（`src/shared/types.ts:7`） |
| 落盘 | `src/main/agents.ts` | `normalizeAgent`（:31-53）、`dedupeAgentNames`（:106-114，同名自动加后缀——委派按名匹配所以名字是准键）、写 `userData/agents.json` |
| systemPrompt 消费点 | `src/main/delegate.ts:198`、`src/main/agent-sessions.ts:41-46` | 任务首条消息与办公室会话两处注入 |
| 现成样例 | `agents.ts:77-85` `defaultAgents` | 5 个预置队员的 systemPrompt 就是天然 few-shot 素材 |

### 5.2 应用内没有"单轮 LLM API"，但有三条可复用通路

1. **办公室会话一次性投递**：`AgentSessionRegistry.followUp(agentId, content, {collectFinal: true})` → `finalText`（`agent-sessions.ts:105-111`）。consult（`index.ts:178-188`）与会议逐人发言（`meeting-controller.ts:383`）已是既定用户；`suppressIssue + dedupeKey office_<id>` 可藏出看板。**注意 dsh 后端被排除**（`agent-sessions.ts:152`），生成后端应选 zcode/claude。
2. **隐藏回合模式（最佳范本）**：`retitleByAgent`（`runner.ts:979-1017`）——对在跑会话发一条指令性 prompt、取首行当答案、90 秒硬预算、事件静默、失败不影响任务本体。`agents:draft` 照抄这个形状即可。
3. **后端原语本身**：`AgentBackend.start()` 就是"一条 prompt → 一个回合"（`backends/types.ts:45-56`）；dsh 是真·无头一次性进程（`dsh.ts:66-119`，`--profile headless`）；zcode 常驻 app-server 一个 `session/send` 一个回合（`zcode.ts:404-420`）。

### 5.3 推荐 wiring：`agents:draft`（最小改动路径）

```
AgentsView「从描述生成」入口（用户输入一句描述 + 生成引擎选择器；⚠ 引擎机制已被 §5.4 锻造师方案取代，本图保留作对照）
  → 新 IPC agents:draft { description, engineAgentId? }
  → 主进程走后端 start() 一次性调用（仿 retitleByAgent 的静默+硬预算形状）
      生成引擎 = 用户指定（已安装平台过滤复用 ctx.backends.has，catalog.ts:20，可选模型）
                未指定则默认 zcode 领队（或记住上次选择）
      ⚠ 不走办公室会话通路——dsh 被排除（agent-sessions.ts:152）；start() 原语五平台全支持，
        dsh 反而是最纯粹的生成引擎（真·无头一次性进程）；指定引擎失败/超时静默回退默认引擎
      prompt = 元提示词（§4.2）+ few-shot（用 defaultAgents 5 个预置当样例）
      输出 = 严格 JSON，只允许 name/role/systemPrompt/note/color/model建议 六个字段
  → 校验门：字段白名单 + 长度上限；model 建议与 agents:models 目录比对，不在目录只降级为建议
  → 草稿回填表单（字段级 diff 呈现），用户编辑后走既有 agents:save（parseAgents 二次校验）
```

- **人工确认即安全边界**：与 Claude Code 官方 subagent 流程（写文件 → Review → Try it out）同构；backend/presetId/subordinates/密钥类字段**永不生成**，留在表单人工配置。
- **校验基础设施零新增**：`parseAgents` + `BACKEND_IDS` 现成，生成输出只需先过一层"允许字段白名单"。

### 5.4 方案变体：内置"锻造师"专职 agent（采纳，替代 §5.3 的引擎选择器）

> 用户决策（2026-09-17）：内置一个只做 agent 生成的专职 agent，其平台/模型即生成引擎配置；systemPrompt 留空，元提示词走专门技能。

- **引擎配置零新 UI**：锻造师（保留 id `ag_forge`，进 `defaultAgents`）的平台/模型/预设就是引擎配置——完全复用 AgentsView 现有 UX（探测徽标、`agents:models` 模型目录、预设绑定全白拿）。换引擎=改它的平台；多引擎=复制一份（如一份挂 dsh 跑廉价草稿、一份挂 claude 出精品）。
- **技能是数据源，不是运行时插件**：一次性调用里 CLI 的 description 触发不可靠（短 prompt 不命中 + 依赖技能先同步进该 CLI 目录）。可靠姿势：随包内置 `agent-crafter` 技能（SKILL.md，含元提示词 + few-shot + 输出 schema），主进程 draft 时**直读技能正文拼进 prompt**；同时照常走技能管道同步到各 CLI 目录，支持对话式迭代草稿。
- **用户可编辑优先级**：技能同时落到共享目录（`~/.agentdeck/skills/agent-crafter/`），生效顺序 共享目录 > 随包内置——改共享目录这份即可定制生成风格，不动应用代码。
- **隔离与自愈**：按保留 id 从"可驱使 agent"勾选、委派目标、会议名册中过滤；加入 `defaultAgents` 后被删除会由启动补缺逻辑（`agents.ts:87-100` 同款机制）自动复活。识别最小改=保留 id（零 schema 变更）；语义化方案=可选字段 `kind?: 'default' | 'forge'`（contracts.ts + assertKeys 白名单 + normalizeAgent 三处小改）。
- **IPC 简化**：`agents:draft { description }`，引擎解析=找锻造师；§5.3 的 `engineAgentId` 参数不再需要（如留作逃生门则为可选）。
- 一期施工内容相应微调：种子锻造师 + 随包/共享技能文件 + `agents:draft` + 回填表单（**无引擎选择器 UI**）。

### 5.5 与技能管道的关系（回应"利用 agent skill？"）

- 仓库技能管道（`src/main/skills.ts`、`src/shared/skills.ts`、`skill-targets.ts`，见 `docs/SKILLS-SHARED-DIR.md`）能分发**知识**——元提示词本身可做成共享目录里的 SKILL.md 资产，同步给各 CLI agent 使用。
- 但技能**不能成为调用通道**：它是被 CLI agent 加载的程序，应用内生成必须走 5.2 的通路之一。
- 进阶玩法（二期后）：把"agent-crafter"做成技能 → 领队在对话中被委派"帮我建个测试工程师"，输出 AgentInfo JSON，应用侧新增回收/解析入口。复杂度高、收益是"对话中建队员"，列为可选。

### 5.6 分阶段落地建议

> 状态：**一、二、三期全部于 2026-09-17 落地**（一二期已随 v0.19.0 发布，三期 typecheck 全绿待发布）。一期：`src/shared/forge.ts` 契约、`src/main/agent-forge.ts`（技能+单回合调用+解析）、`agents.ts` 种子+按 id 复活、`ipc/catalog.ts` `agents:draft`、`preload`/`contracts` 桥接、§5.7 全部 UI。二期：澄清追问（`DraftResult` 三形态 + answers 强制出稿）、草稿确认视图（逐字段勾选填入）、`agents:improve` 改进回路（字段级 old→new diff 勾选应用并保存）、技能 v2 双模式与"尊重用户编辑"的升级规则。三期：`agents:evaluate` 触发评测（should/should-not 实测，passRate 应用侧复算 + 修改建议，挂在草稿确认页）、`agents:import-md`/`agents:export-md` subagent 互通（`src/main/agent-exchange.ts` 纯函数序列化/解析，导入走既有确认视图）、技能 v3 三模式（升级比对扩为历代内置正文清单）。

| 阶段 | 内容 | 规模 |
|---|---|---|
| 一期 | 种子锻造师（`defaultAgents` + 启动补缺）+ 随包/共享 `agent-crafter` 技能 + `agents:draft`（直读技能正文）+ §5.7 UI 清单全部改动 + 草稿回填表单（无引擎选择器） | 2-3 人日 |
| 二期 | 字段级 diff 视图、澄清追问、"改进提示词"迭代入口（SkillForge 诊断→重写→审计三步） | 2-3 人日 |
| 三期（可选） | description 触发评测（should/should-not 实测路由）；`.claude/agents/*.md` 导入导出（接 wshobson 素材池 200+） | 按需 |

### 5.7 UI 改动清单（渲染层实测盘点，2026-09-17，随一期施工）

| 界面 | 位置 | 改动 |
|---|---|---|
| Agent 管理表单 | `AgentsView.tsx` | ① 创建表单顶部加「从描述生成」入口：描述输入 + 生成按钮（loading/失败态，失败提示去检查锻造师的平台配置）；草稿回填 name/role/systemPrompt/note/color/model。② 卡片给锻造师加「锻造」徽标，标明专职身份。③ 锻造师编辑态：隐藏系统提示词 textarea，改为提示"元提示词由 agent-crafter 技能提供"+ 入口跳 SkillsView；隐藏「可驱使 Agent」勾选（它不派发） |
| 可驱使 Agent 勾选 | `AgentsView.tsx:244-269` | 列表过滤锻造师 |
| 新建任务 Agent 选择 | `WorkspaceView.tsx:263`（选中态 `:230`） | 下拉过滤锻造师 |
| 自动化执行 Agent 下拉 | `AutomationView.tsx:40` | 过滤锻造师（无人值守调度锻造师无意义） |
| 会议名册 | `meeting/MeetingPanel.tsx:38` | `eligible` 现为 `backend !== 'dsh'`，追加锻造师排除 |
| 后端健康头像堆 | `RuntimeView.tsx:27` | **不改**——锻造师计入该后端 Agent 数，反而直观显示生成引擎挂在哪个平台 |
| 技能页 | `SkillsView.tsx` | **零改动**——agent-crafter 落共享目录后天然出现在技能列表，可照常同步各 CLI |

> 过滤规则收敛为一个共享谓词（如 `isForgeAgent(agent)`，随保留 id / `kind` 字段定义在 shared 层），四处界面 import 同一实现，避免各自硬编码漂移。

> 入口挂点：`docs/AGENT-PROFILES-PLAN.md` 的 Agent 管理提级方案落地后，生成入口放顶级 Agent tab 的创建表单顶部。

---

## 6. 信息来源

**实机抓取（2026-09）**：
- Claude Code Subagents 官方文档：https://docs.anthropic.com/en/docs/claude-code/sub-agents（"Ask Claude to create the subagent"、frontmatter 全字段表、plugin 权限限制）
- Claude Code Skills 官方文档：https://code.claude.com/docs/en/skills（SKILL.md 格式、描述预算、skill-creator 评测）
- Agent Skills 规范与官方仓库：https://agentskills.io 、https://github.com/anthropics/skills（spec/、template/）
- Anthropic metaprompt 全文：https://github.com/anthropics/anthropic-cookbook/blob/main/misc/metaprompt.ipynb
- SkillForge：https://github.com/mmlong818/skillforge（4 步流水线、触发评测驱动 description、v1.5 演进）
- AutoGen Studio：https://microsoft.github.io/autogen/stable/user-guide/autogenstudio-user-guide/
- CrewAI Agents：https://docs.crewai.com/en/concepts/agents（Agent 字段实测验证；YAML 一节基于训练知识）
- 社区生态：https://github.com/wshobson/agents 、https://github.com/davila7/claude-code-templates 、https://github.com/Dicklesworthstone/claude_code_agent_farm 、https://github.com/derek-codebridge/subagent-example-script 、https://github.com/gensecaihq/Claude-Code-Subagents-Collection

**基于训练知识（本次不可抓取或未抓取）**：
- OpenAI prompt generator：https://platform.openai.com/docs/guides/prompt-generation（本次 403；机制描述基于训练知识）
- Anthropic system prompt 最佳实践：https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/system-prompts（本次地区受限；结构要点基于训练知识）
- LangGraph create_react_agent：https://langchain-ai.github.io/langgraph/
- OpenAI Agents SDK / AutoGen AgentChat 声明式字段（无描述→生成机制）
