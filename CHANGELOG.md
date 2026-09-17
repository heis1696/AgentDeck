# 更新日志（Changelog）

本项目所有显著变更记录于此文件。格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- **免安装热更阶段3-4：feed 上线 + L0 壳自替换**（docs/HOT-UPDATE-IMPL-DESIGN.md §9 / docs/INSTALLER-FREE-HOT-UPDATE.md §5）：`DEFAULT_FEED_BASE` 指向用户阿里云 IP（域名审核后换 HTTPS 重发壳）；`release:hot` 增 shell 通道（electron-builder --dir 旁路打包 → store-only zip，exe 在根，72 文件自检 → 签名进 stable/shell + versions/shell，并产出免安装分发物 dist/agentdeck-版本-portable-win-x64.zip，§9.2 zip 渠道 GA）；部署一键化 `deploy:hot`（scp + nginx reload，env 覆盖 FEED_HOST/USER/DIR）与 docs/HOT-FEED-DEPLOY.md（nginx 配置/安全组/备案换端口提示/服务端回滚/域名迁移/NSIS 并行期）；L0 壳自替换三棒机制——存活期放无锁文件 → swap helper（本 exe RUN_AS_NODE、detached 逃逸 Chromium Job 的 KILL_ON_JOB_CLOSE）等主进程退出后文件级腾挪（被占用目标改名 .old-让位，E3）→ finisher-bin 私用副本 exe 收尾 icudtl/v8 快照自举死角 → 拉起新壳；§6 协同换壳清 L1+L2 指针，启动时 sweepOldShellDirs 清扫让位残留（保留最新一批作回滚源）；updater 两段式 shell apply（staging→用户确认执行，§9.3 半自动）+ rollback('shell') 反向腾挪 + UpdatePanel 壳通道确认按钮；zip.ts 改 original-fs 绕 Electron 对 .asar 路径的读写劫持；AGENTDECK_HOT_DEBUG_LOG 状态流观测通道。smoke:hot-shell 真机演练全绿（复制打包产物→本地 feed→自动两段 apply→断言进程重启/新壳就位/指针重置/让位留证/staging 收尾；受限环境对 2 个被占用数据文件容忍文档化降级），指针四态与载荷端到端回归全绿。

## [0.20.0] - 2026-09-17

### 新增

- **系统托盘 + 关闭语义分级（「关闭后重启没反应」根治）**：普通点 X 关闭 = 隐藏到托盘继续运行（首次收起弹一次气泡说明，任务照跑、完成照通知），托盘菜单「显示主窗口 / 退出（结束后台任务）」，单击托盘图标即唤回窗口；「退出」与热更 relaunch 置 quitting 后走既有 before-quit 链（runner.shutdown 杀会话进程树 → sidecar.stop → store flush）。配套修复 second-instance 只聚焦不重建：`mainWindow` 已销毁时 `focusMainWindow` 改为重建窗口——此前残留主进程持有单实例锁、二次启动只把 second-instance 发给一个没有窗口的僵尸进程，用户看到的就是「点了没反应」，只能任务管理器杀进程。另补 `app.setAppUserModelId('ai.agentdeck.desktop')`（与 appId 一致）——不设置时打包版 Windows toast 通知静默失效，这就是「后台任务完成了却没通知」的原因。
- **锻造师三期：触发评测 + subagent Markdown 导入导出**。草稿确认页新增「评测路由」：锻造师构造 3 条应接 + 2 条不应接的典型任务并逐条判定归属（SkillForge 式 should/should-not 实测，优先于自评），`passRate` 由应用侧按 verdicts 复算不信任模型自报，低命中时给出一句话修改建议（指出定义过宽/过窄/歧义处）。新增 `agents:import-md` / `agents:export-md`：与 Claude Code subagent 生态互通（`.claude/agents/*.md` 格式，frontmatter name/description[/model] + 正文即 system prompt，可接 wshobson/agents 等 200+ 社区素材）——页头「导入 .md」解析后直接走既有草稿确认视图（backend/预设/可驱使仍人工配置，导入正文同样剥派发标记），队员卡片 Download 按钮一键导出（另存对话框，description 由 role/note 拼合）。`agent-crafter` 技能升级 v3（生成/改进/评测三模式），升级比对扩为历代内置正文清单——正文与任何一代内置都不同即视为用户编辑过，不覆盖。

### 修复

- **委派被拒的反馈闭环（「回复里有两个单、等半天不出现」）**：领队输出 `<delegate to="claude">` 这类名单外目标时，护栏拒单只留痕不回灌——领队不知道单被拒，在「等队员回灌」的幻觉里收尾，任务看起来正常完成实则什么都没派出去（实战：队长把可咨询的队长 claude/codex 当成可派单队员）。现在「目标解析失败」类拒单原因（含队长提示「只能 consult 咨询不能派活」与有效队员名单）会记录并在委派循环里回灌给领队，让它当场改派名单内队员或自己完成；回灌有界（连续 2 轮后终止），重复同一被拒目标凭 seenKeys 静默去重不再回灌，防环/层级/预算等政策性硬闸拒绝维持只留痕不回灌（避免诱导再烧一轮）。拒单时间线文案同步回填有效名单。新增 `scripts/smoke-delegate-reject.mjs`（流式被拒改派成功 / 回合末被拒自行收尾 / 顽固重派有界终止三场景，`npm run smoke:delegate-reject`，已入 smoke:all 链）。

## [0.19.0] - 2026-09-17

### 新增

- **免安装热更（阶段 0-2，`docs/HOT-UPDATE-IMPL-DESIGN.md` 全量落地）**：三层热更先落 L1 载荷 + L2 渲染层两层。新增 `src/main/hot/` 模块族——`canonical` 规范化序列化（键序字节排序，发布端与验签端同一实现）、`verifier` Ed25519 manifest 验签 + 3 段 semver 通道门禁（minMainVersion/minShellVersion 应用/加载双处执行）、`trust` 信任锚（keyId→公钥 hex，支持轮换与 `AGENTDECK_HOT_TRUST_HEX` 测试注入）、`pointer` 指针原子写与规则 1-6 校验、`resolve` 解析单源（bootstrap 与主进程共用，载荷层优先/渲染层次之/内置兜底）、`zip` store-only 读写（零依赖，解压带 zip-slip 防护与 CRC 校验）、`feed` 拉取（超时+3 次退避）、`updater` 两通道状态机（staging→验签→原子指针，任一步失败删 staging 现网零触碰；串行互斥；版本目录 GC 保留 3 版）。`src/main/bootstrap.ts` 五步加载链：dev/逃生开关直通 → 载荷指针解析 → 载荷 require → 失败自愈 → 内置兜底；三类失败路径全演练通过——指针损坏改名留证、验签失败留证+版本目录隔离、载荷 require 抛错清指针+relaunch 干净重启（`--agentdeck-hot-fallback` 循环保险 + `--agentdeck-relaunch-retry` 取锁重试环 500ms×10）。主进程：单实例锁 + second-instance 聚焦；`loadFile` 接 `resolveHotState`（L2 免重启热载）+ `did-fail-load`/`render-process-gone`（5 分钟两次防抖）自动回退并隔离坏渲染层；`runner.isIdle()` 空闲门控 L1 apply（挂起为 staged，退出时 before-quit 链补应用后 relaunch）；IPC 新增 `updates` 命名空间四 handler + `updates:state` 事件（契约只增不改），preload 桥与设置页「更新」面板（当前版本/检查/进度/应用并重载/应用并重启/回退 + `updateFeedUrl` feed 基址覆盖）。发布脚本 `scripts/release-hot.mjs`（npm build→§6.1 组装→store zip→签名→verifier 回读自检→`dist/feed/{stable,versions}` 树，版本历史不可变；私钥经 `HOT_SIGNING_KEY`/`HOT_SIGNING_KEY_PATH`，绝不进仓库）；验收 smoke：`smoke:hot-pointer`（打包态四态：正常/损坏/验签失败/require 抛错全绿）、`smoke:hot-payload`（载荷启动、sidecar 自载荷目录拉起、second boot 对账、指针移除回退全绿）。测试隔离通道 `AGENTDECK_USER_DATA_DIR`（Windows 上 Electron 经系统 API 解析 appData，env APPDATA 重定向无效）。开发签名密钥 keyId `ad-2026-09` 公钥内置 `trust.ts`，私钥在仓库外 `~/.agentdeck/hot-keys/`。
- **从描述生成 Agent（锻造师）**：新建队员不再逐项手填——Agent 页新增「✦ 从描述生成」，一句描述经内置「锻造师」专职 agent（`ag_forge`，默认挂 zcode；在列表里改它的平台/模型/预设即换生成引擎）扩写成完整定义草稿（name/role/systemPrompt/note/color/model），回填表单检查后走正常保存；backend/预设/可驱使永不自动生成。元提示词随包内置为 `agent-crafter` 技能（首次调用落到共享目录 `skills/agent-crafter/SKILL.md`，用户可编辑且共享目录优先），主进程新 IPC `agents:draft` 直读技能正文发起单回合会话（90 秒硬预算、权限一律拒绝、失败静默返回 `{ok:false,error}` 不抛异常），输出经围栏剥离/派发标记清洗/白名单截断三重校验（`src/main/agent-forge.ts`）。锻造师按保留 id 启动自愈复活（`loadAgents` 补缺，与领队同平台不受按 backend 补缺盲区影响），并从任务指派/自动化/会议名册/可驱使勾选四处选择器过滤（`isForgeAgent` 共享谓词，新建任务默认执行者也跳过它）；编辑锻造师时隐藏系统提示词与可驱使字段（改为指向技能文件的提示）。设计全文见 [docs/AGENT-GENERATION-RESEARCH.md](docs/AGENT-GENERATION-RESEARCH.md)。
- **锻造师二期：澄清追问 + 草稿确认视图 + 改进提示词迭代**。生成升级为三段式：描述含糊时锻造师先返回 1-3 条澄清问题（`DraftResult` 新增 `{kind:'clarify'}` 形态；UI 逐题作答带回答重试，或"跳过追问"以空 answers 强制出稿，answers 经 IPC 校验 ≤5 条、每条 ≤1000 字符）；草稿不再直接回填表单，而是进入确认视图逐字段勾选（名字恒填入，其余可跳过留空，长文本截断预览）。新增 `agents:improve`：任意队员卡片上的 ✦ 入口提交反馈（如"更严格些 / 加上 git 提交规范"），锻造师按"诊断→最小改动→摘要"重写定义（未涉及字段原样带回，name 非点名不动），UI 呈现字段级 old→new diff（仅列变化字段、旧值划除），逐字段勾选后应用并直接保存；锻造师自身与 backend/预设/可驱使不在改进范围。`agent-crafter` 技能正文升级 v2（生成/改进双模式，frontmatter 携带 `version`），落盘升级尊重用户编辑：仅"未经编辑的旧版"自动升级，用户改过或已是新版保持原样。

### 变更

- **页面壳统一（用量页 / Agent 页共用 page-shell）**：两页的页头、滚动内容区、极光氛围层抽成共享 `polish/page-shell.css`（psh- 前缀：`.psh-page/.psh-header/.psh-body/.psh-aurora/.psh-actions`），页头高度/半透明底/标题与按钮的 flex 分配、氛围层参数、内容边距节奏完全同源，消除两页布局差异；容器查询宿主（`container: page`）落在 `.psh-body` 上，两页断点统一为 `@container page`。**两个伴生 bug 修复**：① 用量页趋势图连线在窗口拉伸后碎成虚点——旧实现用 `pathLength=1 + dasharray` 描边动画，`non-scaling-stroke` 下 dash 会被 Chromium 拉到屏幕空间解释，resize 后 dash 全乱；改为 clip-path 从左向右整体揭示（线+面积+网格一起展开，与 resize 无关）。② Agent 页「新建 Agent」弹窗跑到页面下方黑块——`container` 属性自带 layout containment，会把 fixed 后代的包含块从视口改成容器，弹窗被钉进滚动区裁掉；弹窗移出滚动区（挂 `.psh-page` 直下，该层无容器），实测 dialog fixed 居中于视口。另加窄视口页头两行化（≤900px 标题行+操作行，防操作按钮挤压标题）。
- **Agent（队员）页界面重制**：修复列表卡片布局破版（卡片内文字挤成窄列竖排、名字被拆行、头像与文本错位——旧 `.agent-card` flex 结构在徽章与长描述下失衡）。卡片重构为三段结构：头像+名字+定位 → 徽章行（平台 / 模型等宽字体 / ✦锻造师紫徽 / ⚡领队·可驱使数 accent 徽 / 引用预设）→ 两行截断描述；操作按钮（✦ 锻造师改进 / ✕ 删除）悬停显现，删除态红色。页头与列表区改为常驻页头 + 独立滚动区 + 顶部极光氛围层（与用量页同族驾驶舱语言，tm- 命名空间迁移至 `polish/team.css`，auto-fill 网格 + 容器查询响应式）；预设区空态从一行小字升级为虚线空态框。styles.css 中被替代的 `.agent-card/.agent-grid/.agent-info/.agent-name` 三代际规则清理（弹窗仍在用的 `.agent-avatar/.agent-picker` 等保留）。foundation.css 的亮色桥接从墨色三变量扩为整套旧代际重映射（补 `--surface-0/1/2/3`、`--line-soft/strong`——此前亮色下用到的页面画布仍是黑底）。
- **用量页界面与美术重制（"深夜驾驶舱"仪表盘 v2）**：整页重做——布局从 1060px 居中窄列改为**全宽自适应**（跟随窗口流动）；内容区顶部新增青色**极光氛围层**（双 radial 光晕 + 微点阵，向下渐隐，亮色自动减淡），Hero 四格大数字（Tokens 总消耗渐变字 / 预估成本含 $/1M tok 单价 / 运行次数含均次用时 / 失败率 SVG 环形仪表，零失败翠绿满环、有失败红弧+辉光）直接浮在氛围上；趋势图升级为 **SVG 平滑面积图**（Catmull-Rom 曲线 + 渐变填充 + 描边生长动画 + 峰值光钉 + 失败日红刻 + hover 列高亮，「全部」跨度 >60 天自动并月桶）；失败构成（名次徽标+红→琥珀渐变条+可重试芯片）、按运行时（七色色板方点+单色渐变轨道）、队员明细（等宽数字+失败红芯片+token 占比微条）保持卡片化并统一 hover 细节。**响应式改用容器查询**（`container: usage`）——内容区宽度扣除侧栏后才是真实可用宽度，视口断点在带侧栏的布局里必然错位（实测 760px 视口下四格挤压文字溢出）；1150/860/560px 三档容器断点：4 格→2×2→单列、双栏→单栏，数字字号用 `cqw` 随容器流动。数据层 `AnalyticsSummary` 新增 `byDay` 每日聚合序列（本地时区分桶，升序）。样式迁移至 `polish/usage.css`（us- 命名空间，全令牌驱动，暗/亮双主题，reduced-motion 降级），styles.css 三代际旧 usage/error-mix 规则清理；修复 `.usage-page` 缺 `flex:1` 导致内容不足一屏时页底露出异色背景。顺带修复亮色主题全站页头标题白字白底（`--ink-strong` 等 0.12 代际墨色变量在 `html.light` 从未重映射，foundation.css 统一桥接到字色令牌）。

### 修复

- **dev 与打包版数据目录隔离（含首启数据快照）**：两实例曾共用 `Roaming/agentdeck` userData——打包版执行中的任务持久化为 running，dev 每次启动的恢复逻辑都把它标记中断（`应用重启导致任务中断` 错误评论 + `委派报告未送达` relay 摘要成对重复补写），双方互相覆盖 issues/index.json 又打穿了 runId 去重，实战 iss_t_mu4p5p10 / iss_t_mu4phb1n 两张队长单出现"莫名复制的回复"且队长进度汇报被覆盖丢失。现在 `!app.isPackaged` 时 userData 固定重定向到 `agentdeck-dev`，且置于单实例锁声明之前（锁以 userData 为键，dev 只与 dev 互斥、不再拦打包版，反之亦然；bootstrap 显式指定的 `AGENTDECK_USER_DATA_DIR` 优先于隐式重定向）；dev 首次启动自动把生产目录的应用数据快照拷入（settings/agents/api-presets + tasks/issues/goals/meetings/automations，逐项容错，Chromium 缓存与 sidecar 活动状态不拷），之后 dev 独立读写永不回写生产；`AGENTDECK_DEV_SEED=1` 可强制用生产快照覆盖刷新。
- **会议收敛语义返工（第二场实战 iss_t_mu420e1e 复盘后的结构修复）**：实战暴露三个结构性缺陷——① 答辩轮由 designer（第三方队长）执行，但反对全部指向 reporter 的汇报，designer 无权标记 resolved 只能输出空 envelope，导致整场 3 轮 0 决策空转到预算耗尽（死循环根因）；② no-progress 熔断的 SHA256 签名包含 objection 全文，质疑者措辞逐轮漂移（"前三轮调查"→"前四轮调查"）即完全绕过熔断；③ reporter 在汇报回合越权直接实现方案并 git 提交（0667e63，会议期间改用户仓库）。返工：答辩轮改由被质疑的汇报人执行（逐条回应 + resolved/resolution 标记），designer 改为收敛后「综合轮」固化 decisions/actionItems；熔断键改为稳定语义（未决 ref 集合 + 产出规模），措辞漂移不再逃逸；【会议优先】声明追加仓库纪律（会议期间禁止改文件 / git 提交，实现只在行动项被主席批准后执行）。
- **会议发言实时汇入 Issue 时间线**：此前与会者的发言只落在各自办公室会话的事件流里，issue 只在散会/暂停时收到一份结构化纪要——一场 30-60 分钟的会议期间 issue 全程空白（用户实测反馈"别的队长的发言为什么没汇到 issue"）。现在每次发言结束即以发言者 agent 身份镜像一条评论（`【会议·第 N 轮/汇报|质疑|答辩|综合】队长名（角色）` + 正文，截 4000 字符），配合 `currentTurn` 实时字段，issue 评论区就是会议直播实录；smoke-meeting 增加镜像断言（每人一条/作者正确/带轮次阶段标签）。

## [0.18.2] - 2026-09-16

### 修复

- **会议模式实战缺陷三连修（首次真实会议 iss_t_mu3uprnm_hdg3w5 复盘）**：① 答辩轮主持词只说"输出 JSON envelope"未给 schema 与 stance 标记语法，答辩者自由发挥输出 `{"agree":1,"response":null}` 导致 envelope/stance 双双解析失败、整轮纪要为空且收敛永不可达——答辩/质疑/汇报主持词现在内联完整字段 schema 与 `<stance/>` 标记原文（MAST FM-1.5 教训的第二次兑现）；② 与会队长会话同时注入派发协议（delegate/round/review）与会议协议，质疑者被派发协议劫持收尾（输出 round/review 而非 objection），首轮 0 条反对——三类发言主持词统一前置【会议优先】声明；③ 会议回合内 UI 零反馈（Claude opus 单回合 7 分钟 + 调查 6 分钟，整场看起来像卡死）——新增 `Meeting.currentTurn` 实时字段（每次发言开始即推送），MeetingCard 显示"谁在发言（阶段）"；默认时长预算 30→60 分钟。

### 文档

- 新增 [docs/HOT-UPDATE-COMPARISON.md](docs/HOT-UPDATE-COMPARISON.md)：生产环境热更方案对比——electron-updater 全量 / 渲染层热更 / 混合三路线评估（含仓库事实盘点、风险闭环、引用清单），结论推荐混合分阶段：日常渲染层热更先行，主进程改动走全量更新。

## [0.18.1] - 2026-09-16

### 修复

- **咨询/调查协议教学补齐（标记通电）**：`<consult>` 与 `<investigate>` 此前只接通了运行回路（解析→路由→办公室会话→回灌），但未出现在任何注入给模型的 prompt 中，真实模型无从得知动作存在（fake 冒烟硬编码标记故测不出；对应 MAST FM-1.5「不知道可用动作」）。委派协议块新增【队长间咨询】段——列出可咨询的队长名册（排除自己与 dsh），声明"咨询只收集意见、不能派活"；会议汇报轮与质疑轮主持词新增 `<investigate>` 只读调查教学；smoke-meeting-consult / smoke-meeting 增加教学存在性断言防回归。

## [0.18.0] - 2026-09-16

### 新增

- **新建 Issue 时可选类型**：新建页顶部新增类型选择「任务 / 目标模式 / 团队会议」——目标型内联配置完成条件/停止条件/最大轮数/最长时长，会议型内联指定汇报/质疑/答辩三队长（不可重复）；「稍后 / 开始执行」对三种类型一致生效（目标型 `startNow` 控制是否立即推进、会议型稍后即草稿会议）；提交编排为“先建 Issue，再在其上创建 goal/meeting”，Issue 数据模型零改动。
- **模式角标**：看板与 Issue 列表对有活跃目标/会议的 Issue 显示 🎯 / 💬 角标；Issue 详情侧栏的目标/会议面板保留为实时管控与事后附加入口。

### 变更

- **移除全局「会议」「目标」导航页**（v0.17.0 引入）：两种模式的入口收敛到「新建 Issue 时选类型」（见上），命令面板的「发起会议 / 开启目标模式」快捷操作一并移除；抽出的共用件（`MeetingCard` / `GoalCreateDialog` / `captains`）保留复用。
- **移除收件箱功能**：删 InboxView 与侧栏入口/未读红点/命令面板跳转；契约层去 notifications 相关 IPC 与类型；存量数据兼容（`notifications` 字段加载即忽略）；Windows 系统弹窗链路不受影响。
- **自动化功能标注「待定」**：功能未经完整设计，已知缺口（空工作目录兜底到临时目录、「仅执行」结果不可见、无运行历史、无重叠保护）在 README 与页面内注明，暂不建议依赖。

## [0.17.0] - 2026-09-16

### 新增

- **全局会议入口**：侧栏新增「会议」导航页（`MeetingsView`）——跨 Issue 总览全部会议（进行中/等你处理/已结束），可直接发起（议题 + 选 Issue + 三队长）；进行中可暂停/继续/取消/插话，已结束可审批行动项；Issue 详情内会议面板保留。
- **全局目标模式入口**：侧栏新增「目标」导航页（`GoalsView`）——跨 Issue 总览全部目标（状态/轮次/护栏），并可从任意 Issue 开启目标模式（选 Issue + 目标/完成条件/护栏配置）；命令面板同步新增「会议」「目标」跳转与「发起会议」「开启目标模式」操作。

## [0.16.0] - 2026-09-16

### 团队会议模式（多队长结构化会议，设计见 docs/TEAM-MEETING-CONSTRUCTION.md）

- **结构化回合制会议**：用户把 Issue 委派给队长，队长召集其他队长进会——汇报者（主张带引用收据）/ 质疑者（反对挂编号）/ 设计者（逐条答辩 + 纪要草案）三角色回合发言；**主持人是确定性代码**（`meeting-controller`），不是 LLM——发言顺序、表态收割、收敛裁决、纪要落盘全部由代码驱动，不做自由讨论与投票。
- **主席是用户**：可插话（下一轮注入）、可喊停（级联取消）；会议挂在被讨论的真实 Issue 上，纪要（决策/反对及处置/行动项/开放问题）镜像进 Issue 评论时间线。
- **行动项过人工闸门**：会议产出的行动项落 parked 任务挂到对应队长名下，经人工批准（plan gate）才进入实现——会议不直接驱动实现。
- **队长办公室会话与咨询**（office sessions + `<consult>`）：跨队长通信收编为「咨询 / 会议」两个原语；`agent-sessions.ts` 管理队长级会话。
- **只读调查**（`<investigate>`）：质疑者需要证据时派自己的队员调查，结果回灌会议会话后继续发言。
- **安全闸门**：全局单活跃会议强制；会议生命周期流式更新（waiting_user/active/终态即时广播）；会议错误分类恢复。
- 新增 `smoke:meeting-office` / `smoke:meeting-consult` / `smoke:meeting` / `smoke:meeting-investigate` 四组冒烟。

### 异步回合交互修复

- **续聊不再锁死整轮**（`followUp` 支持 `wait:false`）：UI 追问的 IPC 在回合开跑即返回，busy 不再锁到回合结束——「停止」随时可点；goal/meeting/sidecar 等自动化调用方默认仍等整轮拿 finalText。后台回合失败走 failTask→pushTask 广播显错，兜底防静默挂 running。
- **会议转 active 即释放 busy**：start/resume 的 IPC 要等整场会议结束才返回，会议面板在收到 active 状态时即解锁——暂停/取消/插话不再禁用到散会。
- **parked 一键启动兜异常**：看板/Issue 列表的启动按钮改 try/finally，失败也复位 starting 状态。
- **终态碎片去重**（`absorbFinalFragments`）：zcode 语义下终态只含最后一条 assistant 消息，流式阶段已展示的正文碎片会残留为重复残影（同一回复显示两遍）；终态回灌时从队尾回溯吸收碎片，替换为单一终态气泡。

## [0.15.0] - 2026-09-15

### 硬切接力「卡队列」修复：parked 语义纠偏 + 全链路可见性（自主硬切后继滞留排查结论）

- **根因**：模型按旧指引「不确定时一律 parked」输出 `<continue start="parked">`，后继建成 queued+parked 后调度泵（scheduler）与重启对账都跳过 parked，看板又按普通排队展示——用户看到"没有运行中任务、队列却卡死"。auto 接力链路本身零延迟无回归。
- **指引重写**（`CONTINUE_BLOCK`）：自主硬切默认 `auto`；`parked` 仅限"明确需要用户做 X 才能继续"（确认方案/提供凭据），环境受限（无头跑不了 GUI 等）不算等用户的理由——照常 auto 并在简报写明风险。
- **解析器加固**（`delegate.ts parseContinue`）：start 属性容忍多属性/无引号/大小写；缺省或非 `parked` 一律按 auto（显式 parked 才停放），消除 auto 被语法偏差误判成 parked 的暗坑。
- **parked 落地必有信号**（`index.ts attachContinue`）：新建停放后继时给 Issue 落 agent 评论「⏸ 阶段接力已备好……等你启动」（10s 新鲜窗口防幂等重放刷屏）。
- **回灌失败兜底**（`delegate.ts` 委派循环 catch）：领队会话已死时把队员报告摘要落为 Issue 评论，不再静默丢弃；重启对账对被打断的委派领队同样补队员报告摘要（`index.ts drainRestartInterrupted`）。runner 的 issueOps 相应扩展 `addIssueComment` 通道。
- **UI 可见可点**（`BoardView` / `IssuesView` / `Markdown` / `labels.ts` / `polish/*.css`）：queued+parked 显示「⏸ 等你启动」徽标（区别于普通排队，卡片/行有 is-parked 视觉层级），看板卡与 Issue 行提供「▶ 启动」一键清停放入队（复用 `tasks:start`）；硬切卡片文案统一为「等你启动」口径。

### dsh 接入 ACP 常驻服务（流式事件 + 续聊 + 权限桥接）

- **dsh 后端升级为双模式**：优先接入 deepseek-harness 自带的 ACP server（`packages/examples/acp-demo`，NDJSON JSON-RPC over stdio），ACP 组件缺失或启动握手失败时自动回退原 headless 一次性模式（回退会在事件流里注明原因），backend id 仍为 `dsh`，任务/设置/契约零变化。probe 详情现在标注当前生效模式。
- **ACP 模式解决 dsh 三大短板**：① 每条 committed assistant 消息经 `session/update` 实时推送，UI 不再全程黑箱，且每条协议通知都触发 `onHeartbeat` 给看门狗续命；② 同一服务进程内 `session/prompt` 多轮即续聊（`BackendSession.send` 真正可用，headless 时代「不支持续聊」的限制解除）；③ `session/request_permission` 桥接到 PermissionBroker，非 yolo 模式下 dsh 工具执行有人工审批（yolo 照旧 `DSH_PERMISSION_MODE=danger-full-access` 全放行）。
- **实现**：新增 [src/main/backends/dsh-acp.ts](src/main/backends/dsh-acp.ts)——手写 NDJSON JSON-RPC 双向路由（响应按 id 分发/通知回调/服务端请求应答，无新依赖）+ 内嵌 cordis 组合配置（基于 `examples/acp-agent/cordis.yml`，改动：`dsh-credentials-local` 凭证行接管 `~/.dsh/.credentials.yaml`、shell 沙箱按平台分行——Windows 用 pwsh 行规避 Linux 向 bash-sandbox 的 E_ACCESSDENIED、provider/model/会话落盘根经 `AGENTDECK_DSH_*` 环境变量参数化，落盘默认 `~/.agentdeck/dsh-sessions`）。组合配置写到 dsh 仓库 `examples/acp-agent/agentdeck.cordis.yml`（loader 以 config 所在目录为锚解析插件，examples 是唯一同时链接 acp-demo 与 llm/credentials 的工作区）；Windows 下自愈补 `dsh-pwsh-sandbox` 的 junction 链接（pnpm install 会清掉、下次启动重建）。`dsh.ts` 的 `start` 优先走 ACP，`AcpBootError` 才降级。
- **协议限制（已知）**：工具活动不上协议——纯工具长跑静默期仍无心跳，dsh 固定回合预算（60 分钟）继续兜底；ACP 仅新建会话，应用重启后无法按 sessionId 恢复（会话随服务进程存亡）；dsh 仍不能当领队（runner 侧 `backend !== 'dsh'` 守卫未放开，属后续工作）。
- 新增 `smoke:dsh-acp`（fake ACP server 覆盖握手/事件流/续聊/权限/取消/关闭/启动失败 15 断言，已入 `smoke:all`）与 `smoke:dsh-acp-real`（真机：真实会话、回复 OK、流式可见、续聊、工具执行贯通）。

### 扩展模块（Extensions Hub）主进程侧（设计见 docs/EXTENSIONS-HUB.md）

- **技能页升级为扩展模块的主进程落地**：统一管理 Skills / MCP 服务器 / Hooks / 插件四类扩展资产（存放于共享目录 `~/.agentdeck` 下 `mcp/`、`hooks/` 新布局），可一键安装到各 agent CLI 的用户级配置；新增扩展源仓库层（内置精选目录 + 自定义 git/本地源）。
- **新增主进程模块**：`mcp-store.ts`（`<name>.mcp.json` CRUD，transport 严格校验——拒绝未知 type/未知字段）、`hook-store.ts`（HOOK.md + hook.json，事件/匹配组校验）、`config-editor.ts`（用户配置安全合并器）、`plugin-inventory.ts`（三 CLI 插件/市场只读盘点 + claude 启停）、`sources.ts`（git/local 源 add/sync/remove/browse/导入技能）、`extension-catalog.ts`（内置精选源目录）。
- **用户配置安全合并器（`config-editor.ts`）**：写任何用户配置前先备份 `<file>.agentdeck-bak`（已存在 .bak 不覆盖，保住用户最初状态）；JSON 配置只增删自己的键、其余键原样保留，zcode 侧严格只写 canonical 字段（schema 严格，未知字段会导致服务器被丢弃）；codex 的 `~/.codex/config.toml` 用**块级文本操作**（从块头到下一块头），不引入 toml 依赖；hook 装到 zcode 时强制 `hooks.enabled = true`，卸载按 command 集合精确匹配、不惊扰用户手工配置的组。
- **扩展源仓库**：内置 7 个精选仓库（anthropics/skills、claude-plugins-official、superpowers 等）一键添加；自定义源支持 git URL（浅克隆）与本地目录；浏览扫描发现 SKILL.md / marketplace.json 资产（跳过 .git/node_modules、深度与文件数上限防大仓库卡死）并一键导入技能库（自动 -2 去重）。
- IPC `src/main/ipc/extensions.ts`（mcp/hooks/plugins/sources 四组 channel，契约见 `src/shared/contracts.ts`）；目标路径全部由主进程从 `os.homedir()` 推导，渲染层不传路径。
- **插件市场闭环（§8.1 主进程侧）**：仓库 tab 发现的 `marketplace.json` 一键注册为 Claude/ZCode 市场——`config-editor.ts` 新增 `registerMarketplaceToClaude`（settings.json `extraKnownMarketplaces`，repo 限 owner/repo github 形式，已注册幂等不覆盖）与 `registerMarketplaceToZcode`（`known_marketplaces.json` 数组 append，不写 ZCode CLI 自维护的 lastUpdated/cacheTransactionId）；`plugin-inventory.ts` 新增 `marketplaceStatus`（两 CLI 已注册市场清单，容错）；新模块 `plugin-cli.ts` 借 claude 官方 CLI `plugin install/uninstall` 代跑（复用 backends 的 CLI 解析/spawn 基建，60s 总超时，spec 校验 `plugin@marketplace`，输出尾部 ≤2000 字符）；`sources.ts` browse 为 marketplace 资产填 `pluginCount`，并新增 `registerMarketplaceAsset`（assetPath 越界/非 marketplace.json/缺 name 拒绝，local 与非 github 源明确报错，claude/zcode 成败独立返回）；IPC 新增 `marketplaces:status/register` 与 `plugins:install/uninstall`；`smoke:extensions` 增设市场闭环场景（假 home + 假 claude CLI 垫片，不 spawn 真 claude 不联网）。
- 新增 `smoke:extensions`（纯 Node + 临时目录 + 本地 git fixture，不碰真实家目录不联网，已并入 `smoke:all` 链尾）。

### 修复发布版连不上 codex/claude/opencode（npm 垫片类 CLI 全军覆没）

- **根因**：npm 全局安装的 CLI 只有 `.cmd` 垫片（本机 codex 即如此），`resolveCli` 解析出 JS 入口后返回 `process.execPath` 充当 node 去跑它，且 spawn 时不带 `ELECTRON_RUN_AS_NODE=1`——**打包版 exe 收到 `.js` 参数会忽略并把自己再启动一遍**（实测 `AgentDeck.exe codex.js --version` 打开的是 AgentDeck 的 Chromium，codex 从未执行），发布版因此永远连不上；dev 版正常纯属侥幸（dev 的 electron.exe 恰好把 `.js` 参数当单文件应用入口执行）。dsh/zcode/sidecar 各自已有正确处理，唯独 claude/codex/opencode 共用的 `resolveCli` + `runCliJsonl` 链路漏了。
- **修复**：`cli-locator.ts` JS 入口改用 `findSystemNode() ?? process.execPath`（与 dsh 一致，优先真 node）；`cli-common.ts` `runCliJsonl` 兜底注入 `ELECTRON_RUN_AS_NODE=1`（命令即 `process.execPath` 时，与 zcode-transport 同款守卫）——裸机没装系统 node 时发布版也能跑。
- `smoke:clis` 实测 codex/opencode 真实跑通一轮（claude 因账户 403 额度不足跳过，与本修复无关）。

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
