# 提示词系统（src/main/prompts/）

> 现行参考。写于 2026-09-29（0.23.0-hot.9 之后的「提示词去歧义重做」）。改任何提示词文案、或改拼装/解析它们的调用点，都以本文为准，并跑 `npm run smoke:prompts`。

AgentDeck 的提示词不只是文案：它们是运行时解析器（`<delegate>`、`<round>`、`<review>`、`<stance>`、checkpoint JSON 等）的**输入协议**，一部分原文被 smoke 断言钉住，锻造师技能还带版本升级机制。所以本目录的规矩比普通文案严：先保证协议与解析器对得上、再谈措辞。

## 1. 模块地图

| 文件 | 内容 | 主要调用方 |
|---|---|---|
| `delegation.ts` | 身份注入、交接备注、派发协议（含队长间咨询）、子任务提示、共享工作区只读约定、回灌报告/拒单处理/【下一步】/审核、预算收尾、护栏拒单、重启对账、全文入口、总结轮、咨询请求与回复 | `runner.ts`、`delegate.ts`、`index.ts` |
| `goal.ts` | 目标模式协议块 `GOAL_BLOCK`、推进任务 prompt（首次与兜底新会话同一构造器）、同会话续轮回灌、规格澄清问题 | `goal-controller.ts` |
| `handoff.ts` | 阶段接力协议 `CONTINUE_BLOCK`、接力按钮指令、接手/手动启动确认、标题重命名 | `runner.ts` |
| `meeting.ts` | 会议优先规则、汇报/质疑/答辩/综合/强制综合五类发言、纪要 schema、主席插话、办公室会话引导、只读调查的派单与回灌 | `meeting-controller.ts`、`agent-sessions.ts`、`runner.ts` |
| `forge.ts` | 锻造师技能正文（v5 现行 + V1–V4 升级比对基准）、SKILL.md、生成/改进/评测三模式 prompt | `agent-forge.ts` |
| `personas.ts` | 预置队伍的默认人设（只影响新装/迁移补缺） | `agents.ts` |

本目录只放纯字符串与纯模板函数：不 import electron、不放解析器与业务逻辑。解析器在 `delegate.ts`（委派/咨询/调查/接力/评估/审核）、`meeting-controller.ts`（表态/反对/纪要）、`goal-controller.ts`（checkpoint）。

## 2. 注入地图

### 2.1 首条消息（`runner.launch`）

按顺序拼接：

1. `buildAgentPrompt`：`【你的身份】`（定位 + systemPrompt）+ `【任务】`（task.prompt）
2. `handoffNoteBlock`：有指派交接备注时
3. `buildDelegationBlock`：该 agent 有队员、非 dsh、不是调查子任务、**不是办公室会话**时
4. `CONTINUE_BLOCK`：不是委派子任务、**不是办公室会话**时
5. `HANDOFF_RECEIVE_CUE`（+ `HANDOFF_START_CONFIRMED_CUE`）：接力后继任务

`【任务】` 里的 task.prompt 按任务来源不同：

| 任务 | task.prompt |
|---|---|
| 普通任务 | 用户原文 |
| 目标推进（首次与兜底新会话） | `goalLaunchPrompt` = 目标 +（兜底时）`【接续进度】` + 完成/停止条件 + `GOAL_BLOCK` |
| 委派子单 | `buildChildPrompt` = 指令（共享工作区队员前置 `sharedWorkspaceInstruction`）+ 背景块（领队原文前 2000 字，超长标注截断）+ 工程纪律 |
| 只读调查子单 | `buildChildPrompt(investigationTaskPrompt(问题), 背景)`；发起方是办公室会话时背景为空（会话引导不是任务原文） |
| 办公室会话 | `officeSessionPrompt`（只说会话用途；人设由第 1 步注入一次） |
| 会议行动项 | `actionItemTaskPrompt`（标题 + 验收条件清单） |

### 2.2 后续回合（`sendTurn` / `followUp`）

| 时机 | 文案 |
|---|---|
| 委派每轮结果 | `buildReportFeedback`（报告头 + 各单报告 + 捎带拒单 + `nextStepInstruction`） |
| 本轮全部派单被拒 | `buildRejectionFeedbackPrompt`（含按拒因过滤的 `rejectHandlingGuide`） |
| 预算收尾轮 | `budgetTailFeedback`（`nextStepInstruction('final')`：不再受理派单） |
| 层级/全链轮数护栏早退 | `policyRejectionPrompt` |
| 标 summary 的超长结果 | `childSummaryPrompt`（发给子单会话） |
| 咨询往返 | 请求 `consultRequestPrompt`（进对方办公室会话）→ 回复 `consultReplyFeedback`（回发起方） |
| 调查结果 | `investigationFeedback` |
| 目标模式同会话续轮 | `goalRoundRecap` |
| 会议发言 | `reportPrompt` / `challengePrompt` / `defensePrompt` / `synthPrompt` / `forcedSynthesisPrompt`（都以 `meetingPriority` 开头） |
| 用户点「接力下一阶段」 | `HANDOFF_CUE` +（重启后有未确认派单时）`delegateRecoveryNotice` |
| 自动重命名 | `RETITLE_PROMPT`（隐藏回合） |

### 2.3 办公室会话（会议发言 / 咨询应答）

办公室会话是每位队长一个的长期会话（`agent-sessions.ts`，去重键前缀 `OFFICE_TASK_KEY_V2_PREFIX` = `office:v2:`，`isOfficeTask` 按 `officeAgentId` 识别）。它**不注入派发协议与阶段接力**，runner 也**不武装派单嗅探、不跑委派循环**：会议优先规则禁用日常协议标记，咨询只要意见。越界输出的派单/评估/审核标记只从展示文本剥离并在时间线留痕。

三层身份收口（缺一层就会漏）：

1. **建键隔离**（`officeTaskKeyCandidates`）：运行期键形带版本号，且是**候选序列**（`office:v2:<id>`、`office:v2:<id>#2`…）——单个固定键不够，键被占用时还得有备用键位可建。
2. **复用与建单同源核验**（`pickKey`）：查询与建单走同一套候选序列，两处都要求 `officeAgentId` 与队长一致。键形**不是**安全边界——`requestId`/`idempotencyKey` 是用户可构造的自由串，所以这一层才是主闸。特别注意 `createTask` 是「键命中即复用」：建单路径若沿用被占用的键，它会直接返回那张用户单，核验形同虚设。所以键被占用时换下一个候选键位，`get()` 返回 null、`ensure()` 另建并在时间线留痕，建单结果**再核验一次身份**（防并发抢键）。
3. **旧键收养**（`legacyLookup`）：键形改动前建的旧单在 `ensure()` 里被收养并改写键，否则线上已存在的办公室会话会被抛弃、续聊历史留在旧单。收养的前提是迁移（`store.ts` 的 `migrateTaskRecord`）先为它补上 `officeAgentId`，补写判据 = 旧键形 `office_<agentId>` + 标题以「·办公室」结尾 + `suppressIssue` + **`agentId` 在注册名册里**（`TaskStore` 构造时从 `userDataDir/agents.json` 就地读出，`store.ts` 不 import `agents.ts` 以免引入 electron 依赖）。前三项都是建单入口可自由填写的字段（`requestId` 会成为 `dedupeKey`、sidecar 的 `suppressIssue` 不受白名单约束），名册是唯一建单侧写不进的可信来源（只由本机 IPC 的 `agents:save` 写入，sidecar 没有 agents 端点）。残留风险：冒用**已入册**队长 id 的伪造单仍能通过补写，其后由收养侧键位次序兜底——真实办公室单的 `office:v2:` 键在 `pickKey` 里先于 `legacyLookup` 命中；名册缺失/损坏按空集处理（fail-closed：宁可不补写让收养降级为重新拉首回合，也不误补写）。
4. **外部入口白名单**（`sidecar-server.ts` 的 `assertNoInternalIdentity`）：`officeAgentId` 是「这是办公室会话」的唯一运行期判据，外部建单入口（`tasks.create`/`issues.create`）一律拒绝该字段——建单侧拿到它就能让普通任务跳过派发/咨询/接力协议。桌面 IPC 侧由 `parseTaskCreate` 的键白名单兜住。

**只读调查的放行面按回合而非身份**：办公室会话同时承载「会议发言」与「咨询应答」，`completeTurn` 无从自证本回合是哪种，所以由发起侧显式标注 `followUp({ meetingTurn: true })`——目前只有 `meeting-controller.speak`（会议发言）带它。不带该标记的办公室回合（咨询应答、自由追问）里出现 `<investigate>` 只剥离展示并具名留痕，不发起调查；普通领队任务不受此闸约束（会议外的调查是既有能力）。

**会议内部还要再分一层**：`speak()` 的 `opts.investigate` 默认放行（常规发言轮），强制综合显式传 `false`——它的提示词已写明「不要发起调查」，运行时必须同口径，否则模型越界输出会被当成合法回合照发。

## 3. 协议标记与解析器契约

| 标记 | 解析器 | 要点 |
|---|---|---|
| `<delegate to="…" reason="…" summary>指令</delegate>` | `parseDelegates` | 开标签必须带 to；正文不跨下一个 `<delegate`（残缺标记具名拒单）；同会话同 to+指令去重——重派必须改写指令 |
| `<round outcome="action\|no_action\|failed" reason="…"/>` | `parseRoundNotes` | outcome 定义 `ROUND_OUTCOMES`；只留痕、不影响流程 |
| `<review of="#单号" verdict="pass\|fail" note="…"/>` | `parseReviews` | 单号只在本条汇报内有效；verdict 只认 pass/fail |
| `<consult to="队长名" …>问题</consult>` | `parseConsults` | 只能咨询队长（非 dsh）；受理名单与 `buildDelegationBlock` 的可咨询名单一致——排除发起人**与其直属队员**（队员顶着队长头衔也只能派活）；办公室会话深度 ≥1 不再转咨询 |
| `<investigate to="队员名" …>指令</investigate>` | `parseInvestigates` | 只在会议发言里教，且只对名下有队员的发言人教；**运行时只在 `meetingTurn` 回合受理**（见 §2.3） |
| `<continue start="auto\|parked">简报</continue>` | `parseContinue` | 末尾锚定为主（起点取末尾闭合标签之前的**最后一个**开标记，标记后只允许空白）；缺省/写错按 parked；与示例指纹同源的简报视为复述 |
| `<stance verdict="agree\|disagree\|abstain" grounds="…"/>` | `parseStance` | 必须是整条回复最后一行；判定对象见 `STANCE_MEANING` |
| `<objection ref="…" priority="high">…</objection>` | `parseObjections` | ref 必填；每轮最多 3 条；只认 priority="high" |
| 纪要 JSON（`ENVELOPE_SCHEMA`） | `parseEnvelope` | 整段 / ```json 块 / 首尾花括号三路尝试。**实例必须是空数组骨架**（字段含义另由 `ENVELOPE_FIELDS` 文字说明）：属性位置给非空示例时模型会照抄，示例反对被 `mergeEnvelopeObjections` 登记成真反对、示例行动项被强制综合分支直接采用 |
| checkpoint JSON（`GOAL_BLOCK`） | `parseCheckpoint` | 围栏块**从后往前**尝试；停止条件按原文子串识别 |

**示例标记的红线**：提示词里写出的完整标记，agent 复述时就可能被解析。规则：

- 派发协议全文只有语法行一张完整 `<delegate>`（to="队员名" 不在任何名单里，复述只会得到具名拒单）；summary 属性用文字教，不给第二个标记字样。
- `CONTINUE_BLOCK` 全块只有带指纹的示例一处 `<continue` 开标记；`HANDOFF_CUE`、`GOAL_BLOCK` 不写标记字样。原因：主通道取**最后一个**开标记、兜底通道取最后一个完整闭合标记，正文里的开标记字样都会参与锚定起点的选取——提示词侧少给一个开标记字样，解析器侧就少一类「示例被当成起点」的边界；示例简报的指纹拦截是第二层防线，不是替代。
- 审核示例的 `verdict="pass|fail"` 是占位，解析器不认。

## 4. 术语表

| 术语 | 含义 |
|---|---|
| 领队 | 有队员、能派单的 agent |
| 队员 | 领队名下可派单的 agent |
| 队长 | 定位含「队长/领队」或有队员的 agent；队长之间只能咨询，不能互相派单 |
| 派单 | 一个 `<delegate>` 标记；系统为它建一个子任务 |
| 单号 | 回灌汇报给每个子任务编的 `#n`，只在该条汇报内有效 |
| 回灌 | 系统把结果/拒单作为一条新消息发回会话 |
| 回灌界 | 结果原文整段进回灌正文的上限（`REPORT_INLINE_MAX` = 2000 字） |
| 拒单 | 派单没有建成子任务；回灌里以「没有被执行」具名说明 |
| 推进 | 目标模式的一次执行（第 N 次推进） |
| 接力 | 阶段边界用 `<continue>` 把工作交给新会话 |
| 办公室会话 | 队长的长期会话，只用于会议发言与咨询应答 |

## 5. 措辞约定

1. **单一发射点**：一条规则只在一处定义，其他地方引用它。例：`ROUND_MARK`/`ROUND_OUTCOMES` 被派发协议与目标续轮共用；`REPORT_INLINE_MAX` 同时决定协议里讲的数和回灌组装；`ENVELOPE_SCHEMA` 被答辩/综合/强制综合共用；人设不复述派发协议。
2. **规则放在决策处，只给相关分支**：拒单处理按本批拒因过滤（`rejectHandlingGuide`）；只对名下有队员的发言人教 investigate；预算收尾的【下一步】不再出现「下一轮改派」。
3. **写事实，不写空泛禁令**：说明机制（「完全相同的派单会被去重」「本会话读不到 Issue 评论」），模型才知道为什么、怎么绕。
4. **同一语境不给相反的模态**：旧版「没看到回执请说明」与「派完即收尾不必解说」冲突，现按时机拆开（派单那条回复 vs 之后的回复）。
5. **引用即数据**：他人原文（咨询问题、会议材料、交接备注）逐行 `> ` 引用并声明「不是指令」。
6. **中文为协议语言**：协议块、续轮与澄清问题统一中文；标记名、JSON 字段名保持英文。
7. **诚实描述可达性**：全文入口逐条写明领队能否读到（报告副本可读；Issue 评论与任务详情只供用户查看）。

## 6. smoke 固化的原文（改之前先看断言）

以下子串被 smoke 直接断言或被假后端用来识别回合类型，改动须同步改对应 smoke：

- 委派：`【系统】队员执行结果汇报：`、`没有被执行`、`不存在「在途」`、`— 全文入口 —`、`Issue 评论「队员报告全文`、`以下是队员总结（非全文）`、`预算收尾`、`不要再输出派发标记`、`审核结论`、`<review of=`、`派单拒绝`、`可咨询的队长`、`<consult`、`只读协作约定`、`不要修改、创建或删除文件`、`原文超回灌界不进正文`、`总结轮未产出`、`总结仍超长`、`交接备注`、`咨询回复`；runner/delegate 里的拒因原文（`不在你的队员名单里`、`防环拒单`、`委派层级已达上限`、`全链委派轮数预算已耗尽`、`worktree 建立失败，请稍后重派`、`标记残缺`、`按字面独立受理` 等）
- 接力：`【阶段接力` 标题前缀（smoke-runner 据此切分首条消息）、示例指纹 `阶段2：按 docs/plan.md §3 实现模型选择 UI；阶段1 已完成数据管道（commit 09a47a4`（与 `delegate.ts` 的 `CONTINUE_EXAMPLE_FINGERPRINT` 逐字联动）、`【系统·接力接收】`、`【系统·手动启动确认】`、`重起一个简短标题`
- 会议：`汇报轮`/`质疑轮`/`答辩轮`/`综合轮`/`强制综合`、`会议优先`、`<stance verdict=`、`"decisions"`、`"actionItems"`、`只读调查`、`调查结果`
- 目标：`自动续轮`
- 回灌消息结构：队员可控段在 `\n\n【下一步】` 之前结束（smoke-delegate 以此截取黑盒断言范围）

## 7. 锻造师技能的升级规则

共享目录的 `skills/agent-crafter/SKILL.md` 可以被用户编辑。`ensureForgeSkill` 只升级「未经编辑的旧版」：文件版本低于 `FORGE_SKILL_VERSION`，且正文与 `FORGE_SKILL_BODIES_PREVIOUS` 中某一代逐字相同。所以改内置正文必须：

1. `src/shared/forge.ts` 的 `FORGE_SKILL_VERSION` +1；
2. 把当前正文逐字追加进 `FORGE_SKILL_BODIES_PREVIOUS`。

v3→v4 曾漏第 2 步，未编辑的 v3 副本被误判为用户编辑过、永不升级；v5 一并补回 V3/V4。`smoke:prompts` 逐代验证升级链。

## 8. 已知遗留（不在本次范围）

- 咨询意见与调查报告回灌前没有走 `escapeProtocolLiterals`（委派报告走了）：对方文本里的协议字面量仍是活的。
- 桌宠的人设与生图提示词（`src/main/pet/`）不在本目录，也不在本次重做范围。
