# Multica 拆解报告：功能与界面 UI

> 拆解对象：Multica（multica-ai/multica，开源）
> 拆解方法：① GitHub 主干源码（克隆于 D:\multica-src，对应发行版 ≥ v0.4.36）② 本机安装的桌面版实机取证（app v0.4.29 / 内嵌 daemon CLI v0.2.29，界面语言 zh-CN）③ 官方文档站源码（apps/docs，42 个主题页）
> 源码规模：monorepo 5363 文件；前端功能区 `packages/views`（641 个非测试 TS/TSX）+ `packages/core`（数据层）；后端 Go `server/`（400+ 迁移）；桌面端 `apps/desktop`

---

## 1. 一句话定位与核心对象模型

**"Agents that show up on the board"** —— 把 AI coding agent 当 teammate 管理的 Linear 式工作台。名字致敬 Multics：把"分时系统多用户"换成"人类+agent 混编团队复用同一套机器"。

核心对象（官方 concepts.mdx）：

```
Workspace（容器：人 + agent 在同一工作区协作）
 ├─ Issue（工作单元：标题/描述/讨论/状态/执行历史；assignee 三选一 = 成员 | agent | squad）
 │   └─ Task/Run（一次具体执行记录；一个 issue 随时间可产生多次 run）
 ├─ Project（issue 分组 + 绑定 repo/本地目录作为 agent 执行上下文）
 ├─ Agent（可复用身份配置：指令/模型/技能/runtime；不是常驻进程，被触发才执行）
 │   ├─ Skill（可复用能力包，可挂多个 agent）
 │   └─ Squad（一个 leader agent + 若干成员；指派给 squad 只唤醒 leader）
 ├─ Runtime（执行资源 = 一台连上 Multica 的机器 + 其上的 agent CLI）
 └─ Chat / Autopilot / Inbox（三个外围触发与通知面）
```

触发 agent 的四种方式（docs/triggering-agents）：**指派 issue**、**评论 @mention**、**Chat 直接对话**、**Autopilot 定时/事件**。每种都产生一个 task，由 runtime 认领执行，结果写回触发处。

数据/执行边界（产品核心卖点）：Multica 服务器只存"工作记录"（issue/评论/状态/task 记录）；**代码、凭证、文件改动全部留在你自己的机器上**（daemon 执行）。

---

## 2. 总体架构

### 2.1 三种产品形态，同一后端

| 形态 | 组成 |
|---|---|
| Multica Cloud（托管） | 官方 server + web |
| 自托管 | docker-compose：postgres(pgvector) + backend(Go :8080) + frontend(Next :3000)，无 Redis 也行（多节点 fanout 才需要） |
| **桌面版**（本机装的） | Electron 壳 + **内嵌管理的本地 daemon**（连 Cloud 或自托管，`~/.multica/desktop.json` 切换 apiUrl） |

### 2.2 Go server 拓扑（server/cmd/server/main.go 装配）

- HTTP API（chi，`/api/*`；`/api/daemon/*` 子树用 PAT/daemon token 鉴权）
- **两条 WebSocket**：`/ws`（浏览器实时，按 workspace 授权）+ `/api/daemon/ws`（daemon 控制：心跳/唤醒/WS RPC claim）
- 事件总线 + 后台 worker 群：runtime sweeper（30s 离线检测+任务回收）、GC sweeper（1h）、autopilot 失败监控/配额对账、webhook 投递、PR 卡片刷新、IM 渠道 supervisor 等
- DB 调度器（sys_cron_executions 表 = 分布式租约）：task_usage 小时聚合、autopilot 调度、插件钩子调度

### 2.3 Daemon（执行核心，server/internal/daemon/）

- **不是独立二进制**：`multica daemon start` 拉起的本地常驻进程（CLI 子命令）
- 桌面版通过 `execFile` 调打包的 multica CLI 起它，用独立 profile `~/.multica/profiles/desktop-<host>/`，不碰用户终端 CLI 的默认 profile；健康端口 = `19514 + 1 + (profileNameBytesSum % 1000)`，5s 轮询 `/health`
- 启动即探测 PATH 上 25 个 agent CLI（`--version` + 路径自愈）→ 按 workspace 批量注册 `agent_runtime` 行
- 与 server 双通道：**WS 推送唤醒**（`daemon:task_available`、能力协商 skill-bundles-v1 / rpc-v1 等 8 项）+ **HTTP 轮询兜底**（30s poll、15s 心跳、claim/start/progress/messages/usage/complete/fail 端点群）

### 2.4 一次 run 的完整链路

```
触发(指派/@/chat/autopilot) → 入队 status=queued（deferred+fire_at 定时）
→ daemon 认领（批量 HTTP 或 WS RPC tasks.claim；SQL FOR UPDATE SKIP LOCKED，
  授权栅栏=runtime 在线+owner 匹配+同 issue 互斥）→ dispatched（铸任务级 task_token）
→ daemon 准备：skill bundle 下发(hash 校验) → 执行环境准备(隔离工作区) → running
→ spawn agent CLI（四种协议族适配）流式 Message → 批量 POST /tasks/{id}/messages
→ complete(output/branch/session) | fail(error/failure_reason) | cancelled
→ 服务器兜底：dispatched>5min 无 start 判死；自动重试（瞬态故障 2 次/网络 3 次）
```

四种 CLI 协议族适配（server/pkg/agent/）：
1. **stream-json 族**：claude（`--output-format stream-json --permission-mode bypassPermissions --disallowedTools AskUserQuestion`）、qwen、codebuddy、cursor、copilot、opencode、dsh…
2. **JSON-RPC app-server**：codex（`codex app-server`，initialize → thread/start → turn/start，每任务独立 CODEX_HOME）
3. **ACP 族**（Agent Client Protocol）：kimi/kiro/qoder/traecli/grok/qwenpaw/mcode/dim/zeroclaw/hermes/reasonix（session/new、session/resume 或 load）
4. **每 provider 特化**：antigravity/deveco/openclaw/pi/omp

**权限模型没有交互式弹窗**：本地 agent 一律自主模式跑（bypassPermissions/--yolo/--always-approve 且禁 CLI 反问人类），安全边界由平台层承担——触发鉴权（Access 白名单）、任务级凭证（agent 只拿 MULTICA_TOKEN 任务 token，拿不到 daemon PAT）、执行隔离（worktree/分支交付）、repo allowlist。人审体现在工作流（in_review 状态、comment 线程、inbox action_required 通知）。

---

## 3. 功能全景（侧栏导航 = 功能地图）

实机侧栏（zh-CN）与代码一致（`packages/views/layout/app-sidebar.tsx` 三组导航）：

| 分组 | 项（实机文案） | 对应功能域 |
|---|---|---|
| 个人 | **收件箱**（未读数徽标，实机 9） | Inbox 通知中心 |
| | **Chat**（未读消息数） | 浮动聊天 + 会话页 |
| | **我的 Issue** | My Issues 聚合视图 |
| 置顶 | Pinned（issue/项目/保存视图，可拖拽排序） | 快速访问 |
| 工作区 | **Issue**（核心看板） | 五视图工作区 |
| | **项目** | Projects |
| | **自动化** | Autopilots |
| | **智能体** | Agents |
| | **小队 Squads** | Squads |
| | **Usage/Analytics** | Dashboard 用量分析 |
| 配置 | **运行时** | Runtimes（机器管理） |
| | **Skill** | Skills |
| | **设置** | Settings（30+ 子页） |
| 头部 | 工作区切换器（跨工作区未读点、待接受邀请 Join/Decline）、**搜索 Ctrl+K**、**新建 issue C**（草稿小圆点） | |
| 底部 | Discord 卡片 + 帮助菜单（Docs/Changelog/Feedback/Server version） | |

桌面壳专属：**多标签页系统**（每工作区独立标签组，可排序/钉住，每标签有虚拟历史栈+滚动/视图状态备忘录）、前进/后退按钮、macOS 手势、更新横幅（实机 "New version available v0.4.36 · Download update"）、顶部运行时状态 chip（实机 "Status: Online 主程"）。

---

## 4. 核心功能拆解

### 4.1 Issues —— 协作中枢

**五视图**：board / list / table / gantt（日周月缩放）/ swimlane，同一份数据。表格视图 13 系统列 + 自定义属性列，支持分组、列计算（sum/average/count）、导出。

**状态 = 两层目录模型**（设计精髓）：
- 固定 7 个**类别**（category）：`backlog / todo / in_progress / in_review / done / blocked / cancelled` —— 平台规则挂在类别上（backlog 不启动 run、todo 指派即跑、in_review 结算 autopilot、失败回滚 in_progress→todo、PR 合且带 close intent→done）
- 工作区可自定义**状态**（Settings→Issue Statuses，如"Code Review""QA"），每个自定义状态归属一个类别；**看板列 = 类别**（永远 7 列），自定义状态在卡片上以小 chip 区分
- 内置状态锁定不可改；归档≠删除（存量 issue 保留）

**看板卡片**：优先级图标 + 编号（YOU-1 式，前缀+工作区内递增）+ 标题 + 描述预览 + 自定义状态 chip + 项目 chip + 标签 + **assignee 头像（人/agent/squad 统一 ActorAvatar，悬停出卡）** + 起止日期（**过期变红**）+ 子任务进度环 + "Updated Nm ago" + agent 正在工作指示器。

**交互**：拖拽换列即改状态（列内可排序）；卡片上内联编辑优先级/assignee/日期；右键菜单含 Relations（建子 issue/设父 issue）、Pin to sidebar、**Copy local workdir path**、Open in new tab；批量工具栏；过滤（状态/优先级/assignee/创建者/项目/标签/属性+日期范围）+ 保存视图；指派给 agent 弹 **run-confirm**（"Start work now?" + 可选 Handoff note）。

**创建双模式**：Manual / **Create with agent**（一句话 + 选 agent，AI 结构化成 issue——quick-create 范式，贯穿创建、评论触发、收件箱重试）。

**issue 详情页**（3587 行 issue-detail.tsx，实机取证）：
- 左：描述 + **活动时间线**（agent 评论带完整 Markdown：表格/清单/代码块、**Git 提交卡片**（哈希+message 列表）、**Tag 卡片**、"已推送至 origin"、子 issue 引用链接、"已完成 task（1 次）" 系统事件）+ 底部评论器（TipTap 富文本，@mention 人/agent/squad，/slash 调技能，附件）
- 右侧属性栏：状态/优先级/负责人/截止日期/项目/标签（全部点开即改）+ 创建者/创建时间/更新时间
- 右栏**执行日志**区（见 4.11）
- 头部 chip "X is working"（悬停看活跃 run）

**子 issue 与 stage**：子 issue 可编号 stage 1/2/3 批次推进；最早未完 stage 全部 done/cancelled 时父 issue 收通知；**父 issue 的 assignee 是 agent 时，agent 被唤醒决定是否开下一阶段**（批次自动化）。

### 4.2 Agents —— 身份配置层

**列表**（实机取证列）：智能体（头像+状态点+名称+描述+private 锁）| 状态（**在线性** Online/Unstable/Offline/Archived + "· N tasks" 工作负载 + "Needs a runtime" 琥珀警告）| 工作负载 | 运行时（CLI 徽标）| 活动（7 天 sparkline）| 运行次数 | Model。过滤：我的/全部/归档 + 可用性/runtime/owner/model/access 五维。

**双状态模型**（概念关键）：availability 来自 runtime（在线性），workload 来自 tasks（working/queued/idle）——"离线"≠删除，只是 run 会排队。

**详情页** 4 顶级 tab：Overview / Work / Capabilities（instructions、skills、MCP、MCP Apps、integrations）/ Settings（general、access、environment、custom args、routing）。Inspector 右侧分区：Profile（头像/名/描述——**描述仅展示，不进执行 prompt**）/ Execution（Runtime、Model、**Thinking level**、Speed、**并发上限**）/ Details（只读）。

**Agent 配置项全景**（docs/agents）：名称头像描述、**Instructions**（每次 run 注入的系统指令）、**Conversation starters**（≤3 条开场建议，开新聊天时展示）、Skills、Runtime+Model+Thinking、**Access**（Only me / Entire workspace / Specific people；默认 Only me，admin 也不能 bypass）、执行设置（并发上限、环境变量、CLI 参数、MCP、外部集成）。

**创建流**：Manual / 模板 / **Agent Builder（AI 对话式构建）**——右侧 live draft 实时同步成表单，草稿可恢复。Onboarding 会自动创建首个 agent "Mika"。

**归档**：从选择器消失、取消所有未完任务、历史保留、可恢复。

### 4.3 Squads —— 领队派工（与 AgentDeck 委派同构，机制值得对照）

- 组成：**Leader 必须是 agent**（自动成为成员）+ 成员（agent 或人）+ 每成员**角色描述**（只给 leader 看的路由提示，不授权）+ **Squad instructions**（路由规则/协作规范，只注入 leader）
- 指派 issue 给 squad → **只唤醒 leader**。leader 每 run 的 prompt 附加三块（docs/squads）：
  1. **Squad Operating Protocol**（系统硬编码：读 issue→**用精确 mention markdown 派工** `[@Name](mention://agent/<uuid>)`→简洁→**每轮记录评估**（`multica squad activity … --reason`）→**派发后即停，父 issue 保持 in_progress**→整体达标才移 in_review；@ 别人的 squad issue 不许动状态）
  2. **Squad Roster**（自行+每成员一行，含精确 mention 文本——纯文本 @ 不触发）
  3. **Squad Instructions**（用户自定义）
- **leader 不亲自实现**。成员回帖/子 issue stage 闭环后 leader 被重新触发，决定派下一步/升级/移 in_review/沉默
- **重触发规则表**：非成员评论→触发；成员无 @ 的进度汇报→触发；评论显式 @ 了别人→**不触发**（明确交接就让路）；leader 自己的评论→不触发（防环）；纯 issue 交叉引用→触发。叠加去重：已有 queued/dispatched 任务不重复入队
- UI：列表（name/Leader/members/creator）+ 详情（左 profile 卡 inline 编辑，右 Members|Instructions 两 tab；成员行显示状态点、角色、**当前活动 issue**、last active；操作：Add Member / Create Agent / **Make squad leader** / Remove）

### 4.4 Chat —— 与单个 agent 的一对一

- **浮窗形态**（FAB "Ask Multica" + 右侧滑出窗口，Settings→Chat 可关，关了才显示 Chat 标签页）+ 全页形态，同一 chat-window.tsx（1640 行）
- 左栏会话历史（按 agent 过滤、My agents/Others 分组、行副标题 Working/Completed/New reply）；输入框 placeholder 随 agent 变（"Message X…"）
- 消息内**工具调用折叠**（"N tools / N steps"、Show details）、"Finished in Xs"、失败原因细分 15+ 类
- **Steer**：向进行中的回复追加排队消息转向（Queue message / Stop）
- **Project context** 选择器：带着项目上下文聊
- 每条消息触发一次 run；开场建议（conversation starters）；追问建议 + Regenerate；草稿恢复
- 各类护栏 banner：无 agent/已归档/**需 runtime**/权限被撤销/离线

### 4.5 Autopilots —— 定时与事件自动化

- 触发三类：**Schedule**（cron）/ **Webhook**（URL 显示/复制/**Rotate**、事件过滤、payload 预览）/ **API**
- 输出两模式：**Create Issue**（产物是 issue，走常规重试）/ **Run Only**（不建 issue、不自动重试以防与下次调度重叠）
- 调度编辑器：**结构化双向映射 5 字段 cron**（每日 at HH:MM / every N minutes+时间窗；每天/每周多选星期/每月几号；IANA 时区）——超出的 cron 进 advanced-only raw 模式
- 6 个模板：daily news digest / PR review reminder / bug triage / weekly progress report / dependency audit / documentation check
- Run History（Issue Created/Running/Skipped/Completed/Failed × Schedule/Manual/Webhook/API）+ "Run now"（被阻止时给出 8 种原因文案）+ Pause/Activate（状态含 "Paused — the assignee needs a runtime"）+ 订阅者 + 成员访问管理 + Danger Zone

### 4.6 Inbox —— 人的通知中心（agent 无收件箱）

- **19 种通知类型**：指派/退派/被订阅、状态/优先级/起止日期变更、新评论、**@mentioned**、review_requested、task_completed/failed、**agent_blocked**、quick_create 完成/失败/待确认、reaction 等；severity 三级 action_required/attention/info
- 列表+详情双栏；过滤（status/priority/from/unread）；标记已读/归档/Mark as done；批量操作
- quick_create 类详情含 **Original input**（原始一句话）+ **Retry with context** / Edit as advanced form
- OS 集成：原生通知点击直达对应工作区 inbox（跨工作区路由正确性有专门 issue 修复）；任务栏/dock 未读徽标；前台时不打扰

### 4.7 Projects —— 上下文供给层

- 列表（Table/Cards 视图 × Compact/Comfortable 密度）；状态机 Planned/In Progress/Paused/Completed/Cancelled；lead 可指给 **agent**
- 详情：Properties（起止/lead）、Progress（issue 指标）、Description（明示 "Shared with agents as context"）、project scope 的 issue 列表（复用 IssueSurface）
- **Resources（关键）**：GitHub repo 附件 + **本地目录**（daemon 提供）。本地目录两种模式，UI 明示语义：**in-place**（"work in-place at <路径>"）或 **isolated worktree**（"isolated worktree of <路径>，你的工作副本不被触碰"）

### 4.8 Skills —— 可复用能力包

- workspace 级实体，多 agent 附加（"N/M added" 部分附加态）；来源：手动创建 / From runtime / ClawHub / Skills.sh / GitHub
- 列表（name/added by/**used by**/source/时间）+ 详情（文件树 + SKILL.md 浏览器）
- 操作：Add to agent（多选）、**Update from source**（批量刷新，进度 N/M）、Delete、从本地 runtime 导入（banner："本地 runtime 技能保持私有，复制到此才共享"）
- 执行时 claim 阶段按引用下发 + hash 校验（skill-bundles-v1 能力）

### 4.9 Runtimes —— 机器与执行位管理（实机取证页）

- **机器三分组：Local / Remote / Cloud**（"This device" 徽标 + "连接远程机器" 按钮）
- 顶部 **Local daemon 卡**（实机）："Local daemon · Running · 1m" + "Running here · 3 runtimes available for tasks." + **Stop / Restart / View logs** + Live 徽标
- runtime 表列：运行时 | 健康度 | 智能体 | 工作负载 | **费用·7 天** | CLI；badge：Built-in/Custom/Registering/Disabled/Desktop
- 健康状态机：Online（45s 心跳内）/ Recently lost（<5min）/ Offline（5min+）/ Long offline（6 天+，进入"即将清理"）
- **Add a computer**：两步命令引导（装 CLI + 起 daemon），实时等待检测；无浏览器环境用 token 方案
- **Cloud Runtime**（Fleet 云节点：instance type/region/disk/AMI/subnet/key pair/bootstrap PAT）
- **Custom runtimes**：选基础协议族 → 填 display name/command/description（命令校验禁 shell 管道/重定向/变量展开）
- 详情页：Serving N agents、visibility（private/public 控制谁能在此建 agent）、daemon ID、CLI **在线更新**（pending/running/completed/failed/timeout）、用量图表（活跃热力图 + 日/周成本/token/耗时/任务/错误折线）、自定义单价

### 4.10 Dashboard / Usage

两 tab **Usage | Errors**：KPI 四卡（Cost·ND / Tokens·ND（输入输出拆分）/ Run time·ND / Tasks·ND（N failed））+ 趋势；Errors：失败数/失败率/受影响 agent + **Failure mix**（Auth/Rate limit/Timeout/Provider/Runtime/Agent/Other）+ error codes + Top offenders 表；**Leaderboard**（agent 按 Tokens/Cost/Time/Tasks 排名）。issue 详情右栏也有 Token 用量汇总（实机：输入 56.1M / 输出 144.9k / 缓存 25.2M 读 0 写 / 运行 21 次）。

### 4.11 执行日志与转录（run 可观测性，UI 亮点）

- issue 右栏**执行日志**区：活跃 run 置顶常显，历史折叠 "显示历史运行（N)"（实机 23）；每行 = agent 头像 + 触发描述（Initial run / From a comment / Autopilot / Retry / From chat / Quick create / Direct assignment）+ 状态图标，hover 变操作（View transcript / Stop / Retry）
- **Agent Execution Transcript 对话框**：
  - 步骤流：tool call / text / thinking / error，连续小步骤自动分组；搜索/类型过滤/复制
  - run 详情 popover：Runtime/Provider/Mode/**Workdir/Project directory/Branch**/时间戳/Reason
  - **token 用量**：Input/Output/**Cache read/Cache write** + 估算成本
  - **双泳道时间线**（Model | Tools，壁钟轴，zoom 1/2/4/8x，点击 seek；**颜色表达成败**而非分类）
  - 工具分类统计（Commands/Edits/Reads/Other）+ "Produced: N files + N commands"
  - 工具调用呈现：参数摘要、**unified diff 高亮**、图片结果、输出脱敏

---

## 5. UI/UX 设计拆解

### 5.1 信息架构与视觉

- 三段式：左侧栏（工作区切换器+搜索+新建+三组导航+置顶区）→ 顶部 tab 栏 → 圆角画布内容区（桌面壳 MainCanvas，ring+shadow 内嵌卡片感）
- 通用页面骨架：CollectionPageHeader（图标+标题+计数+一句话 tagline+了解更多+New 按钮）→ 工具栏（搜索/过滤 chips/排序）→ 虚拟化表格/看板；详情页统一"双栏+右侧属性面板"
- 视觉：Linear 风（紧凑、灰阶+单品牌色、status 色彩语义：in_progress 黄/in_review 绿/done 蓝/blocked 红）；浅色模式实机确认
- i18n：4 语言（en/zh-Hans/ja/ko）25 个 namespace，parity 测试保证键一致

### 5.2 桌面壳工程（apps/desktop）

- **TabSession 模型**：标签是"会话"不是路由——纯可序列化状态（URL、resourceKey=pathname 去重身份、pinned 不变量（钉住的恒在左、push 自动转新标签）、**虚拟历史栈**（单路由器永远 replace，前进后退是会话操作）、**memento**（按 route 记忆滚动位置+任意视图状态，上限 100 条 LRU））；按工作区分组持久化，登出清空
- 独立 **issue 弹出窗口**（openIssueWindow，绑定登录账号，换号自动关旧窗）
- main 进程模块化极细（30+ 文件各司一职）：daemon 生命周期管理（版本漂移重启、auth 探测分类"登录过期 vs 网络慢"）、CLI 引导下载（GitHub Releases + checksums sha256 校验）、渲染进程挂死检测（breadcrumb 落盘+下次上报）、通知资格门（前台检测+去重+多窗只发一条）、导航手势、外部 URL 审计出口、deep link（multica://）
- 自动更新：electron-updater，按 OS+CPU 架构分 feed

### 5.3 全局交互

- **命令面板 Ctrl+K**：分组 Pages/Commands/Members/Projects/Issues/Recent；命令含 New Issue、Copy Issue Link、折叠全部评论、主题切换
- **快捷键体系**（Settings→Shortcuts，23 个可自定义动作）：`C` 新建 issue、`Mod+K` 搜索、`Mod+B` 侧栏、`Mod+J` Chat、`Mod+F` 页内查找、`Mod+[ / ]` 前进后退；支持录制/冲突检测/禁用/重置
- **编辑器**（TipTap）：气泡菜单全套格式 + **@mention（拼音+最近使用）** + **/slash 调技能**（`slash://skill/` 链接）+ issue 编号自动链接 + Markdown 粘贴 + 数学公式 + **Mermaid 图表** + 沙箱代码块 + 图片缩放画布
- **流式 Markdown**：rich-content 用 streaming-fence 判断未闭合代码块，流式期间不重建 DOM（细节到位）
- 通知闭环：WS 实时推送 → inbox 徽标/侧栏计数/OS 通知/dock badge 四级呈现

---

## 6. 数据模型速查（server/migrations + sqlc）

| 域 | 表 | 关键点 |
|---|---|---|
| 组织 | workspace / member / user / invitation | member.role ∈ owner/admin/member；PAT `mul_`（90 天）/ daemon token `mdt_` / **task token**（claim 时铸造，agent 只拿这个） |
| Agent | agent | runtime_mode(local/cloud)、runtime_id、instructions、custom_env/args/mcp/model/thinking_level、**max_concurrent_tasks**、permission_mode(private|public_to)+允许名单 |
| 执行位 | agent_runtime / runtime_profile | UNIQUE(workspace_id, daemon_id, provider)；profile = 工作区自定义 CLI（protocol_family CHECK 白名单+command） |
| 工作项 | issue / comment | issue: 7 状态+position（看板序）+parent_issue_id+stage+metadata(≤50键8B)+origin_type；comment: author_type(member|agent)、type(comment|status_change|progress_update|system)、source_task_id（agent 回帖溯源） |
| Run | **agent_task_queue** / task_message / task_usage(+hourly) | 8 态状态机；session_id/work_dir/branch_name（resume 指针）；attempt/max_attempts；**UNIQUE(issue_id, agent_id) WHERE status IN (queued,dispatched)**（每 issue 每 agent 至多一个 pending run）；token 用量含 cost_usd_ticks(1e-10 USD) |
| 协作 | project(+resource) / squad(+member) / skill(+file+agent_skill) / autopilot(+trigger+run+quota) / inbox_item / chat_session(+message) | autopilot_trigger.kind ∈ schedule(cron)/webhook/api；inbox severity 三级 |
| 集成 | github_* / vcs_* / channel_* / plugin_*（20 张） | PR 镜像+CI 快照；Lark/Slack/WeCom/DingTalk/Telegram；插件可注面板/模态/菜单/MCP 审批 |

失败原因枚举（pkg/taskfailure）：平台侧 `runtime_offline / queued_expired / runtime_recovery / timeout / iteration_limit / agent_blocked / codex_semantic_inactivity …`；工具侧 `agent_error.provider_auth_or_access / provider_quota_limit / context_overflow / missing_config / runtime_missing_executable / agent_timeout …`。

---

## 7. Runtime/CLI 清单（代码为准，25 个身份）

| 协议族 | runtime |
|---|---|
| stream-json | claude、qwen、codebuddy、cursor(cursor-agent)、copilot、opencode、dsh |
| app-server RPC | codex |
| ACP | kimi、kiro-cli、qodercli、qoderclicn、traecli、grok、qwenpaw、mcode、dim、zeroclaw、hermes、reasonix |
| 特化 | antigravity(agy)、deveco、openclaw、pi、omp |

（README 宣传"23 agent CLIs"为历史口径。）

---

## 8. 值得借鉴的设计决策（对照 AgentDeck）

1. **状态即目录（两层模型）**：平台规则挂"类别"、团队词汇用"自定义状态"，看板永远 7 列不膨胀——比纯枚举状态优雅得多。
2. **issue 与 run 分离**："跑完了"≠"做完了"；一个 issue 多次 run 全部留痕，重试/换 agent 不覆盖历史。
3. **run-confirm + Handoff note**：指派 agent 的一次显式确认 + 交接备注，成本感知的触发设计。
4. **执行可观测性**：转录（步骤流+双泳道时间线+token/成本+diff 高亮）是"信任 agent"的 UI 基建；AgentDeck 目前只有事件流，缺时间线/成本维度。
5. **派工协议工程化**（squad）：mention markdown 精确触发 + 重触发规则表 + 去重 + 防环——AgentDeck 的 `<delegate>` 协议可补：**领队评估记录**（每轮写 activity）与"派发后即停"。
6. **本地目录双模式明示**：in-place vs isolated worktree 在 UI 上写清楚语义——AgentDeck 的 worktree 集成可以学这个文案级透明。
7. **任务级凭证**：agent 进程拿 task token 而非 daemon PAT——最小权限落地。
8. **桌面壳 tab 即会话**：虚拟历史+滚动备忘录，多 issue 并行开发体验的核心。
9. **失败原因分类学**：平台侧/工具侧两段式枚举 + 每类"怎么办"文案——错误 UX 范本。
10. **quick-create 范式**：一句话→agent 结构化成 issue→收件箱确认/重试，降低建档门槛。

---

## 9. 附录

- 官方文档 42 主题：concepts / how-multica-works / issues / agents / agents-create / squads / skills / autopilots / chat / inbox / tasks / daemon-runtimes / providers / desktop-app / security-model / cli / 各 IM 集成…（apps/docs/content/docs/*.mdx，×4 语言）
- 官方截图 58 张：apps/docs/public/images/docs/*.webp（workspace-overview 看板、task-transcript 转录、squad-detail/dispatch、autopilot-schedule、chat-conversation、agent-access-settings…）
- 关键源码索引：
  - 侧栏/布局 `packages/views/layout/app-sidebar.tsx`；tab 系统 `apps/desktop/src/renderer/src/stores/tab-store.ts`
  - issue 域 `packages/views/issues/`（issue-detail.tsx 3587 行、surface/issue-surface.tsx）
  - daemon `server/internal/daemon/daemon.go`（9200 行）；执行环境 `server/internal/daemon/execenv/`（git worktree、per-task CODEX_HOME/HERMES_HOME、GC）
  - 协议 `server/pkg/protocol/{messages,events}.go`；runtime 适配 `server/pkg/agent/*.go`（每 provider 一文件）
  - 桌面 main `apps/desktop/src/main/`（daemon-manager / cli-bootstrap / freeze-breadcrumb / notification-gate…）
- 本机实机取证：工作区 youyou_toolkit（3 agent：Claude/Opencode/Codex，各绑运行时 主程/编程/审查，均为桌面端内嵌 daemon 注册）；issue YOU-1 含 24 次 run、agent Markdown 评论（表格/Git 提交卡/Tag 卡）、token 汇总面板
