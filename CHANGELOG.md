# 更新日志（Changelog）

本项目所有显著变更记录于此文件。格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### dsh 专属回合预算（修复超 10 分钟任务被误杀）

- **修复 dsh 任务一旦超过 10 分钟必被看门狗掐断**：dsh headless 是一次性纯文本 CLI——整个运行期 stdout 完全静默、退出前才打印最终回复（无 JSON 流、无 resume，源码契约见 deepseek-harness `packages/bundle/headless`），既产生不了任何续命事件，也没有中间输出刷新 `cli-common` 的空闲看门狗，两层「10 分钟无输出即死」的看门狗都从进程启动起跑且永不重置。现在 dsh 改按**固定回合总预算**裁决（默认 60 分钟，`AGENTDECK_DSH_TURN_MS` 可覆盖）：`dsh.ts` 新增 `DSH_TURN_BUDGET_MS` 并传入 `runCliJsonl` 的 `idleTimeoutMs`，`runner.ts` 的 `turnBudgetMs` 按 backend 取预算供回合层看门狗（武装/续命/超时文案）使用。代价：dsh 真卡死时要等满预算才被判败。
- **修复回合超时自动重试后看门狗丢失（永久 running）**：零延迟自动重试会在上一回合 `finally cancel` 之前用同一 taskId 换上新看门狗，旧哨兵的 `cancel`/过期回调按 taskId 裸删定时器，恰好删掉后继回合的看门狗——重试回合从此无人看护，永久卡在 running（HEAD 上即可复现，与本次预算改动无关）。`idleSentinel` 现在按武装时的看门狗记录对象核对所有权：`expire`/`cancel` 只动自己的回合，`touchWatchdog` 原地刷新保持记录身份不变。
- 附带影响：dsh 本不支持 resume，超时重试原本会从头重跑整个任务；配合预算上调后，长任务被拦腰掐断再整段重跑的情况大幅减少。
- 新增 `smoke:dsh-budget`（静默假 backend 对照：常规后端按空闲阈值判败重试、dsh 按专属预算撑过空闲阈值并完整走完重试链），已并入 `smoke:all`；长期正路是接入 deepseek-harness 的 ACP 服务（`packages/acp`）获得流式事件与真续聊。

### 目标模式可清除（修复停止后卡死 Issue）

- **新增「清除目标模式」**：GoalPanel 标题栏新增清除按钮（危险确认框），任何状态（含已取消/已完成/失败）都可一键清除——非终态目标连带取消在跑任务，随后删除目标及其全部 runs/checkpoints 记录，面板回到可重新开启的空态。此前目标只能「取消」不能删，旧目标永久占据面板、无法重新开启目标模式。
- **删除即时广播**：新增 `goals:delete` IPC 与 `goals:deleted` 事件（preload bridge + `AgentDeckApi` 契约同步），看板 🎯 角标与详情面板即时摘除，无需刷新。
- **修复取消后 Issue 被卡死**：`runner.followUp` 原本只放行 done/failed 任务，「取消目标」连带取消任务后追问必报「任务尚未完成」；现在 cancelled 任务也允许追问续聊，停止目标模式的 Issue 可继续手动推进或归档。
- `GoalStore` 新增 `delete(id)`（级联删除该目标的 runs 与 checkpoints）；`GoalController` 新增 `remove(id)`（非终态先停任务再删记录并清 taskByGoal 登记）；`smoke:goal` 新增场景 10（remove 停任务 + 级联删记录 + 列表移除）。

### 委派 worktree 生命周期回收（修复累积）

- **修复委派 worktree 只建不删**：此前 `runner.ts` 为每个子任务在 `.agentdeck-worktrees/` 下创建的隔离 worktree（及 `agentdeck/<任务>_c<N>` 工作分支）从未被回收，随使用不断累积。现在三处兜底：
  - 委派循环集成阶段（`delegate.ts`）：子任务改动全部合入集成分支后立即回收其 worktree 并删除已合并的工作分支；合并失败/冲突则保留现场便于排查。子任务无任何可集成改动时也直接回收。
  - 删除任务（`ipc/tasks.ts` `tasks:delete`）：连带回收该任务及其子任务名下的 worktree。
  - 启动清扫（`index.ts` → `git.ts` `sweepWorktrees`）：按已知仓库回收上次会话遗留的合并临时目录（`.agentdeck-merge-*`，其 `finally` 兜不住进程被杀）与已不存在任务的委派目录；任务仍在的目录不动（可能存有未提交改动）。
- `git.ts` 新增 `removeWorktree`（守卫：只动 `.agentdeck-worktrees/` 下的目录，绝不误删回退共享主目录的子任务工作区；从 worktree 内解析主仓库根再执行移除，规避 git 拒绝在 worktree 内部移除自身）、`deleteBranch`、`sweepWorktrees`。

### Loop Engineering 调研与六项目拆解（文档）

- 新增 [docs/LOOP-ENGINEERING.md](docs/LOOP-ENGINEERING.md)：Loop Engineering 方法论综述（prompt→context→loop 谱系、六大构件、LangChain 四层循环、Claude 四种循环类型）、agentdeck 现状映射，以及拆解结果与 12 条行动清单（按改动成本排序，含“明确不学”清单）。
- 新增 `docs/teardown/` 六份深度拆解报告（共约 26 万字符，结论均带源码 文件:行号 引用）：learn-claude-code（Loop 1 教学实现）、cc-haha（桌面编排同类）、ruflo（多后端 meta-harness）、deer-flow（长时程 SuperAgent）、opencode（agentdeck 上游协议）、ouroboros（Loop 4 自我改进样本）。
- 关键行动项：opencode 适配器升级 server 模式（当前 `--format json` 视图旁路了 PermissionBroker 并丢弃增量/cost 事件）；goal-controller 增加产出签名熔断 + 拦截上限 + doom-loop 检测；permission-broker 增加审批-版本绑定；scheduler 增加 at-least-once 交付语义。
- 拆解用克隆位于 `teardown/repos/`（已 gitignore，不入库）。
- 新增 [`docs/ORCHESTRATION-GOAL-CONSTRUCTION.md`](docs/ORCHESTRATION-GOAL-CONSTRUCTION.md)：把六份 teardown 和架构审查收敛为 Agent 编排/目标模式的阶段施工总册，固定跨阶段不变量、风险台账、验收闸门及阶段 1 交互矩阵范围。

### 共享目录与技能库

- **共享目录**：AgentDeck 拥有自己的用户资产目录（对标 `~/.claude` 等工具目录），默认 `~/.agentdeck`，可在设置「存储」中更改；首次启动/访问自动生成 `README.md` 与 `skills/`，目录用途与布局说明见 [docs/SKILLS-SHARED-DIR.md](docs/SKILLS-SHARED-DIR.md)。应用状态仍在 userData，两者互不混写。
- **技能库**：技能以标准 `SKILL.md`（YAML frontmatter + Markdown 正文）存放于共享目录，支持新建/编辑/重命名/删除/从目录或单文件导入（重名自动 `-2` 后缀）；无 frontmatter 的老文件也能列出，导入不丢内容。
- **一键共享到各 agent CLI**：技能可安装/卸载到 `~/.claude/skills`、`~/.codex/skills`、`~/.zcode/skills` 与跨工具共享位 `~/.agents/skills`（整目录拷贝、含附加文件）；逐字节比较（CRLF 归一）给出 in-sync/outdated/missing 状态，源改动后可一键「全部同步」。
- **技能页替换扩展中心假页**：`SkillsView` 取代硬编码的 `MarketView`（已删除），左列技能列表（搜索、同步状态圆点），右侧编辑器 + 共享目标 chip；命令面板与导航同步改为「技能」。
- 新增 `skills.ts`/`skill-targets.ts`（纯 Node、目录参数注入、`path.relative` 逃逸校验）与 `skills:*` IPC（`IpcContext.sharedDir` getter、`parseSettingsPatch` 放行 `sharedDir`）；新增 `npm run smoke:skills` 并入 `smoke:all`。
### 目标模式 v2（Issue 内自动推进）

- **目标模式改为 Issue 内开启**：不再建立独立「目标」或合成 Issue——在 Issue 详情里开启目标模式后，agent 每轮结束自动续聊自省推进（同会话回灌优先），直到完成条件全部达成；达成后目标标记完成、对应 Issue 自动归档为已完成；触发预算/停止条件/连续失败护栏时停下并写明原因。
- **委派单审核流（maker/checker）**：队员完成的委派单回灌时带单号，领队须对每个 done 单给出 `<review>` 审核结论——通过则该单在看板自动归档为已完成，退回则标记受阻并改派/修复；未出结论的单保留人工审核，看板状态不再全靠手动点选。
- **独立目标页移除**：「目标」导航页与整页目标视图删除，改为 TaskDetail 侧栏的「目标模式」面板（开启、状态、轮数预算、checkpoint 历史、暂停/继续/取消）；看板上的目标 Issue 显示 🎯 徽标。

### 阶段 8：并发与架构收口

- IPC 从主入口拆到 goals/tasks/issues/catalog/system 领域注册器，所有写入口在 main 侧接收 `unknown` 并校验；保持既有 channel 和 payload。
- runner 接入独立 Scheduler、Executor、PermissionBroker、RetryPolicy 与 TaskFinalizer；取消、启动迟到、旧回合事件和 429 退避均纳入统一生命周期。
- 一次性 CLI 使用 per-session 进程句柄和进程树终止；首次拿到 provider session ID 即持久化，使首轮 429 可以续会话。
- ZCode 拆出 JSON-RPC transport 和配置/model catalog；CLI JSONL 协议边界改为 `unknown` + type guards。
- 新增 `smoke:all` 串行全量矩阵与执行服务 smoke；真实 Claude/Codex/OpenCode/ZCode 验收通过，本轮无 429。

### 阶段 7：目标模式

- 新增 `Goal`、`GoalRun`、`GoalCheckpoint` 共享模型，以及版本化 `GoalStore` 持久化。
- 新增 `GoalController`：多 Run 续接、checkpoint、运行/时长预算、取消/失败边界与重启后显式恢复。
- 主进程接入 `goals:*` IPC；目标执行复用既有 Issue/TaskRunner、权限与委派协议。
- 新增目标 UI 与 `npm run smoke:goal`，覆盖完成、继续、暂停/取消、预算耗尽、幂等和重启恢复。

### 阶段 6：渲染层拆分和领域模型收口

- 从 `TaskDetail` 提取 `useTaskEvents`、`turnModel`、`useIssueDetails`，并拆分时间线、权限、运行历史、评论和 Git 视图；保留现有 DOM class、IPC channel 与交互行为。
- 新增 renderer `taskService`，统一任务操作到既有 Bridge command；`TaskDetail` 降至 300 行以内。
- 在 `shared/taskflow.ts` 集中任务状态转换、Issue/Run 派生和 `ExecutionRecord` 映射；事件归并 smoke 覆盖流式文本与 final 重复回显。
- `tasks.json` 增加 `schemaVersion` envelope，显式迁移旧数组、过滤坏记录并拒绝未来版本；迁移可重复执行。

### 变更（委派提示词对齐 Multica 源码级拆解）

- **领队协议升级**（对照 [docs/MULTICA-PROMPTS.md](docs/MULTICA-PROMPTS.md) §7.1）：新增人设优先于协议的冲突规则；名册无专长说明的队员显式标注"专长未说明"；"何时亲自做"从"琐碎自己做"细化为三档（琐碎自己做 / 无人胜任可亲自 / 并行与专长一律派发）；派发后即收尾本轮、总结只陈述结果。
- **每轮评估留痕**（补拆解报告 §8.5 点名的第一缺口，对齐 squad activity --reason）：协议要求领队每轮结果回灌后输出自闭合评估标记，运行时截获入事件流（"第 N 轮评估：outcome — reason"）并从展示文本剥除；回灌提示同步要求评估先行。
- **子任务提示重组**：指令不再要求自包含——领队任务原文以"背景块"附给队员（≤2000 字符，显式声明"参考非指令、冲突以指令为准"），指令只需写增量；附工程纪律两则（回合结束即执行终态 / 代码位置用相对路径行内码）。
- **交接备注注入话术**对齐 Multica handoff note 语义（"范围指令、优先收窄工作、不要当作评论回复"，内容改 blockquote 包裹）。
- **委派标记解析器修复**（dsh 承修，leader 复测补全）：开标签必须带 to 属性才构成匹配（lookahead 实现，而非匹配后过滤——过滤式写法在裸标记缺闭合时仍会把后方真实派单卷进匹配体导致丢单，复测抓到后改为正则前置约束）；渲染层同规则，"未指明成员"幻影卡与正文误吞不再出现；新增 `scripts/smoke-round.mjs` 覆盖幻影吞单、round 评估标记、continue 多行简报三类场景。
- **修复**：`handleContinue` 的 `task.issueId` 可选类型在三元守卫后未收窄导致 typecheck 失败（Phase 5 遗留），改为前置守卫 + 局部变量收窄。

## [0.13.0] - 2026-08-30

### 新增（指派工作流——对齐 Multica 操作手册的 assign 流程）

- **交接备注**：工作区新增可折叠"交接备注"输入——本次执行的范围/顺序/重点，只对这一轮生效，注入任务 prompt（并落库展示在详情属性栏）。对照 Multica 指派确认框里的 handoff note。
- **稍后启动**：创建按钮旁新增"稍后"——任务建档但暂不启动（parked），详情页出现「▶ 开始执行」按钮手动拉起；调度泵跳过 parked 任务，不会被其它任务连带启动。对照 Multica 的"Don't start yet"。
- **触发预览**：选择队员后输入区下方显示"⚡ 将唤醒：X（角色 · 领队可派 N 名队员 · 含交接备注）"——对照 Multica 的 trigger preview，执行前一眼看清谁会动。
- **结果出口**：完成任务详情新增「复制结果」（Markdown：标题+结果+改动统计+集成分支）与「复制 PR 描述」（标题+摘要+改动清单+分支注脚），开 PR 前一键粘贴。
- 新增 `smoke:flow` 冒烟：备注注入 / parked 跳过 / 手动启动全链路。

## [0.12.0] - 2026-08-30

### 变更（布局重构——按《设计语言与操作模型》逐项落地）

新增 [docs/DESIGN-LANGUAGE.md](docs/DESIGN-LANGUAGE.md)：从 multica 源码布局组件与 42 页官方操作手册提炼的界面宪法（表面分层、页面骨架语法、签名布局、操作模型），后续 UI 改动逐项对照。

- **任务详情双栏（签名布局）**：主列限宽居中（≈896px，阅读长度受控）+ 右侧 320px 属性栏（border-l）——状态/平台/会话/工作目录/用时/用量（tokens 分输入输出、回合数、成本）/集成分支/重试计数，行式 label+控件、hr 分组，窄屏自动隐藏。原先平铺在头部的 meta 行迁入属性栏。
- **页面统一 PageHeader 骨架**：队伍/用量/设置三页换成同檐头条（h-48px + border-b + 统一 16px 沟槽）：图标 + 标题 + 计数 + 一句话描述 + 右侧操作；任务详情头部对齐同一语法。头部、工具栏、正文从此共享一条左边缘。
- 清理 dev 探针；typecheck/冒烟全绿；结构经 DOM 几何探针验证（面板 320px、双栏、限宽主列）。

## [0.11.0] - 2026-08-30

### 新增（交互套件——对标 Multica 的浮层交互体系）

- **命令面板 Ctrl+K**：模糊搜索任务、跳转四个页面、新建任务、切换列表/看板、切换深浅主题；分组分区、↑↓/Enter/Esc 键盘导航、匹配高亮。
- **Toast 通知**：右下角浮层（成功/错误/信息三态，自动消失、点击关闭），替代全部原生 `alert()`——删除被拒、续聊失败、检测失败等反馈不再弹系统对话框打断心流。
- **确认对话框**：危险操作（删除任务）改为应用内模态确认（红色确认键 + 任务名上下文），替代原生 `confirm()`。
- **下拉菜单组件**：设置页主题/权限模式、队伍页平台选择全部从原生 `<select>` 换成 Multica 式菜单——勾选标记、右侧弱化说明、键盘导航、点击外部关闭。

### 变更（设计令牌 v2，源自 multica tokens.css）

- **分层表面系统**：壳（最暗外框）→ 画布（内容区）→ 表面（内容组）→ 浮起（浮层）四层底色，浅色主题同步适配；菜单与窗口级浮层使用两档阴影（menu-shadow / floating-shadow）。
- **语义字阶**：全站字号收敛为 micro/caption/label/body/title 六步角色命名令牌，标题、列表、导航逐处对齐。

## [0.10.0] - 2026-08-30

### 新增

- **主题三选一**：设置页新增「外观」卡片——深色 / 浅色 / 跟随系统（监听系统配色变化实时切换，偏好存 settings.json）。浅色主题为全套变量覆盖（含看板、diff 染色、气泡、徽章、滚动条的浅色适配），状态色相应调深保证对比度。

## [0.9.0] - 2026-08-30

### 新增

- **看板视图**：任务页新增 列表/看板 切换（右上胶囊，localStorage 记忆）。看板按状态分五列（排队中/执行中/已完成/失败/已取消），卡片显示标题、后端徽标、⚡ 委派标记、重试计数、耗时与时间；悬停浮起，点击打开任务标签；子任务不占板（从领队任务进入）。空列显示占位符。

## [0.8.0] - 2026-08-30

### 变更（UI 视觉改版）

- **全局质感升级**（Linear 式设计语言）：更深的分层底色、四层文字层级、统一的圆角/阴影/悬停过渡体系；系统字体栈（Segoe UI/苹方）；自定义细滚动条。
- **侧栏**：品牌区渐变 logo + 版本徽标；"新任务"渐变发光主按钮；导航带图标（lucide）+ 胶囊激活态。
- **任务列表**：顶部"进行中 / 历史 / 全部"过滤 tab（带计数）；任务项卡片化（悬停浮起、选中描边）；分组标签大写小字。
- **开始页**：英雄卡顶部双色氛围光；新增三个快捷示例 chips（点击填入提示词）；输入框聚焦光环。
- **任务详情**：头部渐变底 + 分隔线；状态 chip 改为彩色胶囊（进行中黄/完成绿/失败红）；"对话/结果/Git"改胶囊 tab；子任务卡片化可悬停。
- 按钮体系（渐变主按钮/hover 上浮）、气泡（用户描边卡/agent 内嵌卡）全面翻新。

## [0.7.1] - 2026-08-30

### 变更（可见性修复）

- **委派过程不再藏在折叠区**：派工轮次（含理由）、结果回灌、防环拒绝、自动重试、集成结果这些系统事件，从"🔧 工作过程"折叠详情提升为回合内的可见条带（蓝色左边线样式）——0.7.0 的 reason 留痕此前即使产生了也看不见，本版修复。
- **任务运行中自动展开工作过程**：进行中的任务，最后一回合的工具调用默认展开可见（结束后恢复折叠）——实时盯着 agent 干活不用手动点开。
- 队伍编辑对话框的"可驱使的队员"说明补充二层语义（领队→子领队→队员最多 3 层）。

## [0.7.0] - 2026-08-30

> **可见性说明**：本版默认界面没有任何变化——两项新能力都要特定条件才生效，属于委派协议与编排层的演进，不是新页面/新按钮。

### 新增

- **派工理由留痕**：派工标记支持可选的 reason 属性（`<delegate to="X" reason="为什么派它">`，属性顺序任意）。
  - **怎么看到**：给领队派一个真实任务，等它派工后看「对话」页事件流——"第 N 轮派发：X（这里会显示理由）"。理由由领队自述，协议要求带上但模型偶会省略，省略时显示与 0.6.0 无异。
- **二层委派**：队员本身也可以是领队——它执行任务时能继续向下派工（领队 → 子领队 → 队员，最多 3 层）。
  - **怎么开启**：「队伍」页编辑某名队员，勾选"可驱使的队员"→ 该队员即成为子领队；不配置则行为与 0.6.0 完全一致。
  - **怎么看到**：子领队任务详情会出现它自己的"子任务"面板和 ↩ 领队链接；孙子任务的改动经子领队集成分支一路合入顶层集成分支（Git 改动页可见）。
- **内部加固（无 UI，可靠性）**：防环闸（派发目标在祖先链上 → 拒绝并事件留痕）；全链共享 8 轮预算（`Task.roundsUsed` 记账，防多层各自 6 轮叠加失控）；子领队无自身改动时其集成分支不再被集成跳过；worktree 统一归位主仓库根（嵌套 worktree 不再污染父级 status）。
- `smoke:delegate` 新增场景 B：二层链路 + 恶意回派拒绝 + 递归集成断言。

## [0.6.0] - 2026-08-30

### 新增

- **多标签浏览**：详情视图顶部任务标签条——点击切换、× 关闭、状态点实时刷新、重试中显示 ⟳；同任务不重复开（上限 8 个）；删除任务自动关其标签；Ctrl+W 关当前标签、Ctrl(+Shift)+Tab 循环切换；工作区仍是"空标签"起始页（Ctrl+N 回去）。领队 + 多个子任务终于可以并排观察。

## [0.5.0] - 2026-08-30

### 新增

- **diff 语法高亮**：Git 改动页从纯文本升级为零依赖的 DiffView——按文件分组、+/- 行数徽标、hunk/增/删/上下文行级染色、二进制文件标记、超长 diff 渲染截断（3000 行）。
- **工具分类统计**：对话视图每回合的工作过程摘要显示分类计数（读取 / 命令 / 编辑 / 其他），一眼看出这轮 agent 在干嘛。
- **瞬态失败自动重试**：限流、超时、沙箱、进程崩溃类失败自动重跑，上限 2 次——第 1 次优先续会话（可 resume 的后端），第 2 次强制新会话；凭证/配额/配置类失败不自动重试。每次重试在事件流留痕（⟳ 自动重试 n/2 · 新会话/续会话），任务头与列表显示重试徽标；手动"重新运行"恒新会话并清零计数。
- 新增 `smoke:diff` / `smoke:retry` 冒烟脚本。

## [0.4.0] - 2026-08-30

### 变更（清债）

- **删除旧版双轨 squad 模式**：`src/main/squad.ts` 与 `mode:'squad'` 执行路径移除（0.3.0 起已无 UI 入口）；`Task.squad` 字段重命名为 `Task.integration {branch, note}`，启动时自动迁移存量数据；运行中的旧 squad 任务与重启后悬挂的 running 任务一律标记为失败并提示重跑（不再永久"执行中"）；设置项 `squadMaxWorkers` 更名 `workerConcurrency`（自动迁移）。侧栏/详情的委派徽标改为实时派生（⚡ 委派 已完成/总数）。
- 复制任务不再整页刷新；renderer 的 Agent 类型统一为 `api.ts` 的 `AgentInfo`；系统通知点击会先唤起并聚焦窗口再跳转任务。

### 新增

- **失败分类学**：原始错误自动归类为 11 个稳定 code（cli_missing / protocol_config / provider_auth / provider_quota / rate_limit / output_limit / context_overflow / timeout / sandbox / process_crash / unknown），失败横幅显示人话标题 + code 徽标 + 处置提示，错误原文折叠保留；`retryable` 标记为后续自动重试的依据。
- **用量汇总**：任务完成时把各回合 usage 事件（多态键名归一）累计到 `Task.usage`；详情页头部显示 tokens/成本 chip；新「用量」页按队员与平台聚合（KPI 卡 + 两张表）。
- 新增 `smoke:migration`（0.3.x→0.4 数据迁移）与 `smoke:failure`（分类规则 + 落库）冒烟脚本。

## [0.3.0] - 2026-08-30

### 新增

- **内置委派协议（无模式开关）**：领队 agent 在对话中自主决策派工——回复中的 `<delegate to="队员">子任务</delegate>` 标记被运行时截获，各队员在隔离 git worktree + 分支并行执行，结果回灌领队继续（可再派、可自己收尾），循环直至不再派发；子任务改动自动提交合入 `agentdeck/task-<id>` 集成分支，当前分支不动。任何支持续聊的后端都可当领队（dsh 一次性无头除外）。
- **队伍页升级为完整 agent 身份**：每名队员可配置角色定位（role）与系统提示词（人设/专长），勾选「可驱使的队员」（subordinates）即成为领队；任务绑定 agent 身份（agentId），执行时注入人设与（领队时）委派协议。预置五名队员自带角色设定，ZetCode 默认领队。
- **取消级联**：取消领队任务会级联取消运行中的子任务。
- 新增 `smoke:delegate` / `e2e:delegate` 脚本；新增 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)（模块地图、数据流、可靠性设计）与 [docs/API.md](docs/API.md)（IPC 桥、数据模型、后端适配器接口、委派协议）。

### 变更

- 新建任务移除「单任务 / ⚡ 多 agent 协同」开关：协同改由领队内置委派承担，存量 squad 任务仍可恢复查看（runner 保留旧模式恢复路径）；领队自己动手的改动保留在工作区，不再自动提交。
- 版本号升至 0.3.0。

## [0.2.0] - 2026-08-30

### 新增

- **常驻工作区**：主区空状态改为可直接输入的任务创建区——提示词（自适应高度）、工作目录、执行队员、单任务/协同切换、并行数，Enter 直接创建；替代原「新任务」弹窗（NewTaskDialog 移除）。Ctrl+N 与侧栏按钮聚焦工作区；草稿在切换任务/视图间保留（会话内存活）。
- **任务详情改为对话式视图**：用户输入与 agent 回复按回合分成聊天气泡；每回合的工具调用（读/写/执行命令等）与状态日志折叠在「🔧 工作过程」里；token 用量不再作为日志行，合并后显示在回复气泡右下角角标（tokens / in-out / 时长 / 费用）。

### 修复

- **执行日志看不到用户输入**：首条 prompt 与追问现在以 `user` 事件落盘并渲染为用户气泡；旧任务（无 user 事件）用 task.prompt 兜底显示。
- **agent 回复不及时开新气泡**：事件流按 `user` 事件分回合（旧数据按 `final` 切分），流式文本与最终回复归属各自气泡，不再跨回合拼接成一大段。
- **每回合出现两条 token 用量日志**：zcode 的 telemetry 与 session/event 两条终态路径都可能发 usage，已按回合去重合并（主进程防双发 + 渲染层合并兜底）。
- **输入框固定高度、内容多时要内部滚动**：追问框与工作区输入框均改为自适应高度（封顶）；**回车默认发送，Shift+Enter 换行**，中文输入法组词时的回车不会误发送（isComposing 判定）。
- **队伍页「检测各平台可用性」点击无反馈**：五个后端的探测由串行改为并行，单个完成后立即推送结果到界面；按钮点击即显示「检测中…」并禁用；单个探测带 20 秒兜底超时，异常不再静默吞掉。（设置页「检测可用性」按钮同样处理）
- **删除任务后界面不立即刷新**：主进程删除成功后广播 `task:deleted`，任务列表即时刷新、被删的选中项自动回到工作区；删除被拒绝（如任务运行中）时弹出原因。
- **删除协同（squad）任务遗留孤儿子任务**：删除父任务时级联删除其全部子任务；子任务仍在运行时拒绝删除并提示先取消。
- **dsh 路径设置需重启才生效**：后端原先在应用启动时固化设置快照，改为每次探测/执行时读取最新设置。
- **dsh 探测可能挂起至 15 秒超时**：回退用 electron.exe 充当 node 运行 `--version` 时补上 `ELECTRON_RUN_AS_NODE=1`，避免被当作 GUI 应用拉起。

### 变更

- 任务详情首个标签由「执行日志」改为「对话」；原 prompt 置顶块移除（由用户气泡替代）。
- 设置页「执行后端 · ZCode」卡片更名为「执行后端 · ZCode / DeepSeek Harness 路径」，并补充说明：执行后端 = 实际执行任务的 CLI 程序；claude / codex / opencode 从 PATH 自动发现，无需配置。

### 已知限制（demo 范围）

- **squad 协同的异构派工依赖领队模型自觉**：子任务默认全部由领队所属队员执行；仅当领队在规划 JSON 里为子任务输出 `"agent"` 字段（按队员名/平台名匹配）时才路由到其他队员。想提高异构概率，可在「队伍」页给队员写上明确的专长说明（note）。

## [0.1.0] - 2026-08-30

初始基线（对应初始提交 `7197420`）。

- Electron + React + TypeScript 桌面应用：本地任务看板，把任务派给本地 agent CLI 执行
- 任务模式：单任务、squad 多 agent 协同（领队拆解 → 并行执行（git worktree 隔离）→ 汇总 → 集成）
- 执行后端：zcode（GLM，app-server 协议）、claude（Claude Code）、codex、opencode、dsh（DeepSeek Harness）
- 任务队列与并发控制、实时事件流（文本/工具调用/用量）、权限确认、追问续聊、git 改动快照
- 数据持久化于系统 userData 目录（tasks.json + 每任务 events.jsonl）
