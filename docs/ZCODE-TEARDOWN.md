# ZCode（D:\Projects\ZCode）拆解与借鉴分析

> 2026-10-03 · 基于 ZCode v3.14.0（仓库仅 2 个提交，刚开源）的**纯静态只读拆解**：未安装依赖、未构建、未运行测试；结论来自源码、import 关系与调用点的静态检索。覆盖视觉令牌（§三）与布局 / UX / 交互（§四）两大专题。
> 各队员拆解报告全文见本仓 `.agentdeck-reports/`（会话工件，不入库；清单见文末附录）。

---

## 一、ZCode 全景

**定位**：开源 AI 编程工作台（Apache-2.0），一个产品三种形态——Electron 桌面版、浏览器/自托管 Web、终端 Agent CLI（`zcode` 命令）。pnpm monorepo：主仓 14 个包 + `apps/zcode-cli`（自身是嵌套 workspace，含 17 个子包）。

**规模**：全仓 TS/TSX 约 **76.5 万行 / 4,400+ 文件**（不含 node_modules/dist）。两大头：`packages/ui`（32 万行，产品 UI 主体）与 `apps/zcode-cli`（22.5 万行，Agent 执行内核）。

**架构主干**：一条协议，三个执行形态。所有形态共享 `packages/shared` 的 zcode-protocol（stdio NDJSON 帧 + Zod 运行时校验）与 `packages/rpc`（VS Code 风格 Channel 协议栈），最终都把同一个 Agent 运行时作为子进程经 stdio 拉起。依赖方向严格单向：`rpc`/`shared`（叶子）← `provider(-node)` ← `services` ← `server`/`desktop`/`web`/`zcode-server-cli`；Agent 侧自成体系（`contracts ← core ← bootstrap ← cli`），仅靠协议类型与主仓对齐。

```
                ┌─ 桌面: Electron main ─ fork ─ host(Utility Process) ─ spawn ─┐
shared/rpc ─────┼─ Web: server(entry-http, Hono+WS) ─ services ─ spawn ────────┼──► zcode app-server --stdio
(协议单一事实源) └─ 远程: server/remote(SSH/Docker/WSL) ─ 远端 zcode-server.cjs ─┘   （stdout 独占协议帧，日志走 stderr）
```

### 分层速览

| 层 | 包 | 规模 | 要点 |
|---|---|---|---|
| 协议主干 | rpc / shared | 4.1k / 38.4k 行 | Channel/Proxy/Persistent（ACK、心跳、重连重放、背压）；zcode-protocol v1/v4 双版并存（v4 为主） |
| 模型配置 | provider / provider-node / model-option-map | 7.6k 行 | sources→Registry→Resolver→Facade 解析链；选项 DSL 禁调用/禁成员访问 |
| 业务服务 | services | 298 文件 / 87.3k 行 | 47 个一级子域七分组（会话任务/模型订阅/凭据权限/分享遥测/工作区 IO/同步插件/基础设施）；`index.ts` browser-safe 与 `node.ts` 分离 |
| 应用壳 | desktop / web | 60.8k / 3k 行 | 每窗口一个 Utility Process host；renderer 仅 13 文件，UI 全在 `@zcode/ui`；scheduler 是 cron/闲时调度器（非热更） |
| 承载部署 | server / zcode-server-cli | 10.8k / 5.7k 行 | HTTP+WS 与 stdio 双入口；server-cli 是独立守护服务（supervisor 代际状态机 + launchd/systemd/Task Scheduler） |
| Agent 内核 | apps/zcode-cli（17 子包） | 1,327 文件 / 224.7k 行 | core 回合状态机（`turn-machine.ts`）+ 工具注册/调度/执行；bootstrap 装配 app-server 并持有双代协议实现；adapters 接 AI SDK/coding-plan 网关 |

### 工程治理

`architecture-policy.yaml` 定义 16 个模块的 roots/依赖方向/公开入口/owner，`architecture-check.mjs` 机器校验层向、循环、行数上限（`maxFileLines=400`，但目前仅 `managed: true` 的 storage 模块受管）。发布链：`bootstrap → build:bootstrap → bundle:desktop（electron-builder）→ build:sea（Node SEA 独立可执行）→ release`。另有三处原生编译、远程 prebuild、49 个根脚本、knip 死代码检查、mise 锁工具链版本。

### 值得记录的风险（ZCode 侧）

1. 协议 v1/v4 双版并存，迁移节奏仓内无说明；2. `architecture-policy.yaml:24` 声明的 `session/contract.ts` 不存在（过期声明）；3. `hostCapability.ts` 与 server/server-cli 的 HTTP 层均为刻意双副本，需人工同步，有漂移风险；4. 架构检查 `--changed` 只查工作区文件，已提交的越层改动可能漏检；依赖解析只认相对导入，漏别名与动态导入；5. 400 行上限对非 managed 模块不生效（如 `subagent/runner.ts` 2,142 行、`product-projection.ts` 5,459 行）。

---

## 二、与 AgentDeck 的定位对照

| | AgentDeck | ZCode |
|---|---|---|
| 产品 | 本地任务看板，派单给本地 agent | AI 编程工作台（桌面/Web/终端三形态） |
| 架构 | 单包 Electron + electron-vite，主进程热更链路**零运行时 npm 依赖**，五个 CLI 后端适配器 | pnpm monorepo 14 包 + CLI 嵌套 17 子包 |
| 规模 | main 106 文件 / 32k 行；renderer 72 / 15.1k；preload 1 —— 合计约 4.7 万行 | 约 76.5 万行（16 倍） |
| UI 技术 | React + 手写 CSS 令牌（`tokens.css` + `polish/` 命名空间），lucide 图标，无 Tailwind/无组件库 | Tailwind 语义令牌 + `components/ui/` 组件原语 + Zustand 按领域 store |
| 设计文档 | `docs/DESIGN-SYSTEM-V2.md`（令牌+组件规格+验收清单） | `DESIGN.md`（明确写给 coding agent 的设计法典） |
| 质量文化 | 验证门：typecheck/build/smoke（40 个 smoke 脚本，smoke 直连符号视为固化 API） | 架构策略机器检查 + knip + oxlint/oxfmt + 架构基线 |

规模与约束差异决定了：**monorepo 拆包、多形态承载、32 万行 UI 大包这类"形态级"做法不学；令牌体系、规范可执行性、治理自动化这类"纪律级"做法可学且部分必须学。**

---

## 三、UI 设计专题对照（重点）

两份设计文档质量都很高，且哲学同源（克制、密集、操作型、反营销风）。AgentDeck 不必推倒重来——令牌化、六步字阶、4px 间距、四档圆角、五态规范、键盘矩阵、reduced-motion 都已是同类水准，且「状态光环」签名元素比 ZCode 更有产品个性（ZCode 的 Motion 原则是 "fast and low-drama"，我们的光环是状态传达，不违背）。真正的差距在以下七点。

### 3.1 相对字阶：字号是用户设置，不是设计常量 ⭐ 最大差距

ZCode 全部 UI 字号由 `--ui-font-size`（默认 14px）加偏移公式推导：`text-ui-xl = +4`、`lg = +2`、`base = +0`、`caption = -1`、`sm = -2`、`xs = -4`。用户改字号时**只有这一个变量变化**；图标、间距、圆角等 rem 几何不随之缩放；禁止改 `html` 的 font-size 来实现缩放。代码/Diff/终端内容保持独立字号设置，互不牵连。

AgentDeck 的六步字阶是固定 px（11/12/13/14/16/18），用户无字号设置。对长时间盯屏的密集操作工具，可调字号是可访问性硬需求，而且现在改成本最低（令牌已集中）。ZCode 的落地证据：设置页 Appearance 提供 **12–20px 字号档（默认 14）**，写入 `--ui-font-size` 并跨窗口同步（`packages/ui/src/SettingsPage.tsx:1784`、`packages/ui/src/lib/uiFontSize.ts`）。

**落地**：`tokens.css` 中六步改为 `calc(var(--ui-font-size) + Npx)` 公式；设置页加字号档位（12/13/14/15/16）；审查 `polish/` 与组件内的裸 px 字号。ZCode 还给了两条防线可抄：`text-ui-2xs` 之类下限特例写明"仅限图表轴家具"；`text-mobile-input-safe`（16px 防iOS聚焦缩放）这类平台兼容令牌独立成档、不进层级体系。

### 3.2 圆角按嵌套层级递减，而非按组件类型分配

ZCode 的圆角规则：布局区域不算层级；**第一个可见圆角容器从 `rounded-xl` 起，嵌套则 `lg→md→sm` 逐级递减**，同级同值；dialog 壳 `2xl`、菜单壳 `lg` 是白名单特例，且"特例不自动延伸到嵌套内容"。`rounded-full` 只给刻意的胶囊/圆形。

AgentDeck 是"按钮 6 / 输入卡 8 / 大卡 12"按类型分配——单层场景没问题，但嵌套（卡片里的输入框里的按钮）没有判定规则，容易越嵌越不协调。**落地**：把四档语义从"组件类型"改为"嵌套深度"，写一版层级递减表；保留 pill 特例。

### 3.3 表面谱系的完备性与互斥性

ZCode 为每类表面定角色并禁止互串：page（`background`）/`surface`/`card`/`popover`/`menu`/`input` 六级 + 各自的 hover/selected/focused 变体；文本前景三级（`foreground` / `subtle` / `subtlest`）；边框有默认/hover/focused 三态；**语义色自带配对前景色**（`--color-success` + `--color-success-foreground`）。禁令清单明确：不混用同级表面、不写 `text-white/60` 这类临时 alpha、语义色不得挪作装饰、"卡片永远低于浮层"。

AgentDeck 已有 `bg/bg-raised/bg-inset/bg-hover/bg-selected` 与文字三级（`text/text-dim/text-faint`），但缺：菜单/浮层的独立表面 token（菜单复用 `bg-raised`）、`input-focused` 背景、边框 focus 态专属 token、状态色的配对前景。**落地**：补齐表面谱系后，"这个元素该用哪层表面"永远可判定，浅色主题也不再需要组件级补丁。

### 3.4 以文字层级表达密度

ZCode 原则："Prefer text hierarchy to create information density before adding more borders or colors"——先想能不能用字号/字重/前景色分级，再考虑加边框和色块；**字号与颜色是两个独立决策**（`text-ui-sm` 配什么前景色分开定）。我们的看板卡与详情栏可对照自查：信息分级目前有多少靠边框和背景块，多少靠文字层级。

### 3.5 阴影克制：分层靠背景对比，重阴影只给浮层

ZCode 的 elevation 只有四级：Base（无阴影，靠背景对比）/ Surface（边框）/ Overlay（`shadow-md`）/ Attention（`shadow-lg` 仅 toast 与强调浮卡），并明确"Do not rely on large soft shadows for ordinary layout"。

AgentDeck 的看板卡 hover 用了 `--shadow-pop`（0 22px 52px 0.50 黑）+ 位移——这是浮层级阴影用在了一级内容上，多层卡片同时 hover 时会显脏。**落地**：卡片 hover 降为边框变色 + 1px 位移；`shadow-pop` 只留给 dialog/palette/toast。

### 3.6 i18n / 长文本宽容性

ZCode 把"布局必须容纳更长翻译、不允许把截断当作组件存活的唯一手段、图标不得单独表意"写成规则。AgentDeck 当前中文为主，但路径、命令、模型名、agent 输出这类不可控长文本已经存在；若国际化在路线图上，这条必须先立。

### 3.7 把设计文档写成"给 coding agent 的法典"

ZCode 的 `DESIGN.md` 开篇即声明 "This file is meant for coding agents"，把最高优先级约束置顶（`text-ui-*` 强制、禁 Tailwind 内置字号、禁任意值），并规定"违例视为设计系统缺陷，不是风格偏好"。规则全部可判定，agent 和 lint 都能执行。

AgentDeck 的 DESIGN-SYSTEM-V2 同精神（有验收清单、有"不可擅自添加中间值"），可再进两步：① 置顶"最高优先级约束"段，把禁令条款化；② 把验收清单从人工勾选变成脚本（如扫描 `polish/` 与组件里的硬编码色值/裸 px 字号，参照 v2 §5.3 的重组验收思路做成 CI 检查）。**规范的半条命在执行方式里。**

---

## 四、布局 / UX / 交互设计专题对照（重点）

视觉之外，ZCode 真正的功力在交互层的**分寸感**：每个交互问题（长对话、排队输入、权限等待、破坏性操作）都有明确的解法且落成可复用模式。AgentDeck 的同构场景是详情页执行记录（事件流 / 回合分组 / worker 列表）与 Issue 派单流，映射度高，以下逐块对照。

### 4.1 布局体系：三帧结构 + 面板状态按 owner 归属

ZCode 桌面布局（`packages/ui/src/app-shell/WorkspaceShellLayout.tsx:1511`）：

```
DesktopWindowFrame
├─ WorkspaceSidebar（可调宽，按工作区组织任务）
└─ 主区 ResizablePanelGroup（水平）
   ├─ 会话列：WorkspaceHeader（48px 单行）+ Conversation（上下可调）
   │                                └─ 可选底部 Terminal 帧
   └─ Side Pane（自带 tab 栏：Git / 终端 / 浏览器 / 代码查看 / 白板 /
                开发工具 / 模型轨迹 / 子 agent / 计划 / workflow 产物等十余种）
└─ DesktopTopOverlay（悬浮的导航 / 新建任务工具条）
```

三条硬规则值得注意：

- **面板状态按 workspace + 任务 owner 记忆**：`sidePaneOwnerId = activeTaskId ?? draftSessionId`（`hooks/useAppPanels.ts:131`）——切任务恢复各自的 Side Pane 上下文；只有字号/主题/语言是跨窗口同步字段（`store/index.ts:214`）。
- **内容 tab 与容器显隐分离**：toggle 只显隐面板，不自动切 tab、不产生导航（`useAppPanels.ts:187`）——避免"关了再开，内容变了"。
- **窗控 / 标题栏 / 内容分层**：草稿态复用同一 Header 组件但裁剪任务标题区（`WorkspaceHeader.tsx:135`），平台差异不复制整套 Header。
- 另有 coding / office 双界面模式（`lib/interfaceMode.ts`）：同一壳两副面板集（office 隐藏 Terminal/Review）。

**对照 AgentDeck**：我们已有侧栏七视图 + 交互中心全局状态，结构不差。差距：①详情页的面板/分页状态无任务级记忆（全局一份）；②无可调分栏。→ **必须学 owner 归属与显隐/tab 分离**；可调分栏见可以学。

### 4.2 导航与快捷键：声明式命令表

快捷键全部走 `packages/shared/src/shortcutCommands.ts:61` 声明式绑定表 + `hooks/useAppKeyboard.ts:22` 统一分发 + 设置页改键。核心清单：`⌘K/⌘⇧P` 命令中心、`⌘,` 设置、`⌘F` 查找、`⌘B` 侧栏、`⌘⇧L` 主题、`⌘J` 终端、`⌘⌥B` Side Pane、`⌘⇧[ / ]` 前后会话、`⌘[ / ]` 历史导航、`Ctrl+M` 模型、`Ctrl+⇧M` 会话模式、`Ctrl+T` 思考级别。

**对照**：AgentDeck 的交互中心已统一分发（含 `isComposing` 输入法让路，已达同类水准），缺的是声明式绑定表与用户改键。→ 可以学（增量）。

### 4.3 会话时间线：历史与实时分离 ⭐ 本节核心

长对话渲染是 ZCode 交互工程最扎实的一块，四个模式：

- **虚拟化历史 + live tail 分离**：历史区按 renderUnits 虚拟化渲染（`v4/ConversationTimeline.tsx:1826`），运行中的轮单独 live tail——流式更新与历史滚动互不干扰（`:1855`、`ConversationTurnGroup.tsx:1302`）。
- **导航轨**：TurnNavigator 跟随可视区与活动查询行更新，点击定位到 unit/row，尊重 reduced-motion（`ConversationTimeline.tsx:1707`、`ConversationTurnNavigator.tsx:76`）。
- **工具卡可控展开**：`ToolCallBlocks/ToolLayout.tsx:108/:175` 默认折叠、按工具规则自动展开、**运行转完成时自动收起**、用户可再手动展开——收放权在系统但否决权在用户。
- **流式 Markdown 防闪烁**：行状态决定流式/静态解析；未闭合 Markdown 流式期容错、完成态切静态渲染并关闭正文动画；reasoning 默认折叠（`ConversationRowView.tsx:1499`、`components/ai-elements/message.tsx:1632`）。

**对照 AgentDeck**：详情页执行记录（事件流 + 回合分组 + worker）是同构场景，我们已有回合分组（UI-DETAIL-FEEDBACK 决策），缺虚拟化、live tail 分离、工具输出折叠策略、流式完成态切换。→ **四条全部必须学**。

### 4.4 输入壳与排队输入

- **输入壳承接建议/上下文/草稿**：`ChatPromptEditor` 斜杠目录 + `@` mention（`#` 兼容路径保留）；上下文头承载 workspace/Git 信息；草稿按会话保存、350ms 延迟落存（`v4/ConversationComposer.tsx:749/:2235`）。
- **排队输入是可管理队列而非只读列表**：拖动排序、立即发送、编辑、删除；发送/编辑中的行按 dispatch/ACK 状态锁定；暂停时说明原因并提供恢复入口（`ConversationQueuePanel.tsx:167/:209/:321`）。

**对照**：AgentDeck 的派单流同构——busy 任务的追加指令、Issue 管线的待决输入。"队列可管理 + ACK 锁定 + 暂停有原因"模式直接映射。→ **必须学队列模式**；草稿防抖可以学。

### 4.5 人机中断与破坏性操作安全门

- **权限卡是完整的等待交互**：来源、理由、选项 + 用户反馈文字 + 提交中/失败态（`PermissionDialog.tsx:692`）。
- **提问统一弹层**：AskUserQuestion / ExitPlanMode / Elicitation 走同一弹层体系，含问题分页、倒计时、移动端收起（`v4/V4InteractionDialogs.tsx:303/:346`、`ElicitationDialog.tsx:940`）。
- **rewind 安全门**：预览区分**安全 / 非安全 / 忽略**三类文件并列原因；仍在加载或无法应用时禁用破坏性确认；编辑冲突提供"仅保留对话"退路（`ConversationFileRewindDialog.tsx:119/:165/:171`）。

**对照**：AgentDeck 有 permission 链路与 ConfirmHost 通用确认，但确认框无影响预览分级、无提交中/失败态闭环。→ **必须学**（破坏性操作影响预览 + 状态闭环；适用场景：删除任务、worktree 清理、热更发布）。

### 4.6 辅助信息的分寸

- **状态胶囊优先主状态**：目标/Todo 摘要优先，运行计数只作兜底；展开面板才见 Git/计划/终端/workflow 分区（`ConversationStatusPanel.tsx:1658/:1692`）。
- **数值与曝光的诚实性**：后台耗时标签取 max(已知耗时, 本地计时基线) 防回退跳变（`BackgroundTaskElapsedLabel.tsx:39`）；配额横幅只在**实际可见且窗口可见**时登记曝光（`ConversationQuotaBanner.tsx:62`）——曝光数据不虚报。

→ **必须学**（耗时防跳变、曝光真实这两条是交互诚实性，直接可写进我们的规范）。

### 本节必须学清单（汇总）

| # | 模式 | 映射到 AgentDeck |
|---|---|---|
| 1 | 虚拟化历史 + live tail 分离 | 详情页事件流长任务渲染 |
| 2 | 工具卡自动折叠（完成自动收起、可手动展开） | 执行记录里的工具输出 |
| 3 | 流式渲染完成态切换 + reasoning 默认折叠 | agent 输出流式展示 |
| 4 | 排队输入可管理队列（排序/编辑/ACK 锁定/暂停原因） | busy 任务追加指令、Issue 待决输入 |
| 5 | 权限/提问统一等待交互（含提交中/失败态） | permission 流的 UI 闭环 |
| 6 | 破坏性操作影响预览 + 安全门 | 删除任务、worktree 清理、热更发布 |
| 7 | 面板状态 owner 归属 + 显隐/tab 分离 | 详情页分页/侧栏按任务记忆 |
| 8 | 辅助信息分寸（数值防跳变、曝光真实） | 用量页、耗时展示 |

---

## 五、必须学（UI 之外）

1. **架构策略文件 + 机器检查**。`architecture-policy.yaml`（模块 roots/依赖方向/公开入口/owner/行数上限）+ `architecture-check.mjs`，让"renderer 不得 import main 实现"、"跨层不得 import 实现细节"从口头约定变成 CI 拦截项。AgentDeck 已有 `docs/graph/` 语义索引与 40 个 smoke，缺的是**依赖方向的声明式策略与自动检查**——可以从最小的 policy 文件起步（renderer/main/preload 三域 + 禁入清单），挂在 `verify:pre-push` 同级。
   - 注意吸收 ZCode 的教训：检查不能只看未提交文件（`--changed` 盲区），依赖解析要覆盖路径别名；行数上限要么全量生效要么别定。
2. **协议单一事实源 + 运行时校验**。zcode-protocol 用 Zod 同时提供严格类型与运行时校验，三端（desktop/services/cli）消费同一份。AgentDeck 五个 CLI 适配器的输出解析若有"类型有了、运行时没校验"的缺口，按此补齐（`smoke:ipc-validation`、`smoke:zcode-protocol` 已有意识，方向一致）。
3. **入口分域防误用**。services 的 `index.ts`（browser-safe）与 `node.ts`（Node 装配）分离，原因是 renderer 会 value-import 根入口、误带 Node 实现直接黑屏。AgentDeck renderer/preload/main 之间的导出面可对照自查：`src/preload` 只有 1 个文件，风险小，但 renderer 里 `api.ts`/`task-service.ts` 的导入边界值得保持显式。
4. **工具链版本锁定**。`mise.toml` 锁 Node/pnpm 精确版本。AgentDeck 可用同思路锁 Node/electron-vite（README 已写死验证门命令，配版本文件更稳）。

## 六、可以学（按需，触发条件明确）

| 做法 | 来自 | 何时学 |
|---|---|---|
| `@tanstack/react-virtual` 虚拟滚动 | ui 包 | 看板/任务列表滚动卡顿时（§4.3-1 落地载体） |
| 密集菜单规范（紧凑行高、选项间 2px、选中用勾选标记而非整行填充、同一动作集在右键菜单与下拉复用） | DESIGN.md §Menus | 下次改右键菜单/下拉时顺手对齐 |
| 等待类状态统一色（waiting/permission/confirm 一个 treatment，不用 success 色替代） | DESIGN.md §Blocking | 任务等待/权限请求 UI 出现多套绿时 |
| 功能级令牌族（workflow timeline 自有 `--color-workflow-*` 族，不占用全局语义色） | DESIGN.md §Workflow | AgentDeck 出现局部可视化特性（如执行流图）时 |
| 声明式快捷键绑定表 + 用户改键（我们已有集中分发与 IME 让路，缺绑定表与配置） | `shared/shortcutCommands.ts` | 用户开始抱怨快捷键不可改时 |
| 草稿按会话保存 + 350ms 防抖落存 | `ConversationComposer.tsx:2235` | 派单输入框丢过草稿时 |
| 可键盘操作的分隔条（4px 命中区 + 2px hover/focus/drag 指示线） | `WorkspaceShellLayout` / DESIGN.md | SideDock 引入可调宽度时 |
| Turn/回合导航轨（跟随可视区、点击定位回合） | `ConversationTurnNavigator.tsx` | 详情页回合分组变多、找不回某轮时 |
| coding/office 双界面模式（同壳两副面板集） | `lib/interfaceMode.ts` | 出现"轻量视图"产品需求时 |
| knip 死代码检查 | 根工程 | **谨慎**：须配置排除 smoke 直连符号（本仓铁律：smoke 测试面是固化 API，knip 会误报） |
| oxlint/oxfmt | 根工程 | 现有 lint 方案不够快或要上 CI 全量时 |
| formal-proof 式状态机枚举验证器（枚举动作组合、可导出 E2E case） | packages/formal-proof | issue 管线/热更状态机再出回归时 |
| supervisor 代际状态机 + 崩溃退避 | zcode-server-cli | 若做 agent 守护/自更新服务 |
| 跨窗口状态广播 + claim 租约 + 防回环 | services/broadcast + ui store | 多窗口支持立项时 |
| window-scoped Utility Process host 隔离 | desktop | 单窗口 main 进程成为稳定性瓶颈时 |

## 七、不学与反面教材

- **不学 monorepo 拆包**：4.7 万行单仓 + 零依赖主进程是 AgentDeck 的资产，不是债务。ZCode 的包边界服务于 76 万行与三形态，不服务于我们。
- **不学 32 万行 ui 大包**：ZCode 的 ui 包本身是超大单体（单个 `SessionPane.tsx` 4,834 行），这是"共享 UI"吞掉产品逻辑的结果，我们当前 `components/ + polish/` 的轻结构更健康。
- **不学 Side Pane 十余种 tab 的广度与 coding/office 双模式**：那是 IDE 形态产品的需求；AgentDeck 的看板/详情/Issue 形态用不上，学了是负资产。
- **不学移动 Web 单列 + 抽屉**：无移动端计划（ZCode 报告亦注明其 Drawer 实现未在代码中明确定位，规范先行于实现——这个"规范先写、实现后补且不臆断"的态度本身倒是可学）。
- **反面教材（若做同类机制，避开）**：协议双版本并存无迁移说明；hostCapability/HTTP 层刻意双副本靠人工同步；架构检查只拦新违规、基线永远还不清；行数上限只管一个模块。

---

## 附：拆解细节入口

`.agentdeck-reports/` 下会话工件（md 报告全文，按单号）：

- **#1** Agent 侧：17 子包职责、拉起链路、扩展机制、规模表
- **#2** services 47 子域全清单、server 双入口、storage 分层、依赖方向表
- **#3** Electron 进程模型、远程资源、web/formal-proof 定位
- **#4** RPC 协议栈、provider 解析链、治理体系、构建发布链、审查结论
- **#5** 布局体系：三帧结构、面板 owner 归属、快捷键表、字号设置链路、移动适配
- **#7** 会话交互：时间线虚拟化/live tail、工具卡折叠、流式防闪烁、队列管理、权限/rewind 安全门
-（#6 为失败单：只写了勘察开头无正文，已收窄改派为 #7 补齐）

本文件已内联全部关键结论；深入细节再查对应报告。
