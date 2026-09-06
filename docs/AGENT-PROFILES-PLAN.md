# Agent 提级与同平台多模型 — 施工方案

> 目标：把"队员管理"从设置分区提级为顶级 **Agent 管理** tab；支持**同一平台多个 agent、各自钉死不同模型**（如 zcode 上的 glm-5.3 与 glm-5.2 并发执行）。
> 附带修复施工中实测发现的委派截获 bug（Phase 0，P0 前置）。
> 依据：2026-09-07 对本仓库源码、`~/.zcode/cli/config.json`、cc-switch 本机数据（`~/.cc-switch/cc-switch.db`）的实测调研。

---

## 0. 定位：与 multica / cc-switch 的差异

| | multica | cc-switch | 本方案 |
|---|---|---|---|
| Agent 是什么 | 身份（指令/模型）绑到 runtime（机器+CLI） | 无 agent，只有 provider 配置档案 | **身份 + 会话级钉死的模型**，runtime 与 agent 解耦（`shared/types.ts:96` 注释已声明此原则） |
| 多配置并发 | 不同 runtime 天然并发 | 靠"启动快照"时机技巧（切配置→开终端→再切→再开），人为掐时机 | **声明式**：model 是 agent 字段，任务带 agentId，任何触发路径（指派/@/自动化/重试/委派）确定性取到配置 |
| 全局副作用 | — | 每次切换覆写 `~/.claude/settings.json` 等全局文件 | **零文件写入**：zcode 走会话内存 runtimeModel；CLI 后端走 spawn 参数/env |

一句话：把 cc-switch 用户手动玩转的"启动快照并发"固化成数据模型，使编排器（委派/自动化/重试）在无人值守时也能做对。

---

## 1. 现状与断点（证据清单）

### 1.1 `Agent.model` 是死字段——链路只断三处

| 环节 | 位置 | 状态 |
|---|---|---|
| 数据模型 | `src/main/agents.ts:20`（`model?: string`），`normalizeAgent` 透传 | ✅ 已有 |
| 持久化 | `userData/agents.json` | ✅ 兼容，无迁移 |
| IPC 桥 | `src/preload/index.ts:10`、`src/renderer/src/api.ts:74`（AgentInfo.model） | ✅ 已透传 |
| 编辑表单 | `src/renderer/src/components/TeamView.tsx:98-174` | ❌ 无 model 输入 |
| 执行入口 | `src/main/runner.ts:272`（新任务）、`:384`（续聊）调 `backend.start()` 未传 model | ❌ |
| 后端接口 | `src/main/backends/types.ts:45` `start(opts)` 无 model 参数 | ❌ |

### 1.2 UI：提级是"复活"不是新建

- `TeamView.tsx:190-205` **整页渲染模式仍在**（0.14 被嵌进设置）；embedded 分支 `:178-188`。
- 入口现状：`SettingsView.tsx:14`（SECTIONS 含 team）+ `:48` 渲染 `<TeamView embedded />`；App 导航 `App.tsx:120-126` 无入口；命令面板 `App.tsx:106` 有"设置 · 队伍"。
- 检测冗余：`TeamView.tsx:53-58` "检测各平台可用性"按钮 + probe 徽标（`:73-77`），与设置-运行时分区的检测（`SettingsView.tsx:141-153` + `RuntimeView` 经 `runtime:snapshot`）重复；主进程 `agents:probe`（`index.ts:226-247`）整个可删。

### 1.3 "一后端一队员"隐含假设（需清理）

- `RuntimeView.tsx:27`：`agents.find((item) => item.backend === snapshot.backend)` 取首匹配当头像。
- `TeamView.tsx:50`：backends 数组硬编码（应取 `BACKEND_IDS`）。
- `AutomationView.tsx:40`：下拉默认项文案"默认（zcode）"。
- 委派目标按名匹配优先（`delegate.ts:196` 名字 → `:197` backend 兜底）：同平台多 agent 后**重名会产生歧义**，保存时需校验。
- `agents.ts:93-95` 迁移逻辑按 backend 补缺预置——不阻碍多 agent，保留。

### 1.4 执行链路已有的正确基础

- `createTask`（`index.ts:99-118`）：backend 由 agent 解析（agent-first），mention/automation/委派全走它 → 多 agent 无需改。
- 身份注入 `buildAgentPrompt`（`delegate.ts:53`）拼 prompt，与后端无关。
- zcode 模型机制现成 90%：`buildRuntimeModelFromCliConfig()`（`zcode.ts:253`）从 `~/.zcode/cli/config.json` 构造含 provider 注册表（baseURL/apiKey/模型目录）的 runtimeModel，**resume 已带**（`:529-534`），create 未带（`:538-541`）。
- CLI 后端参数注入点：`claude.ts:23`（args 数组）、`codex.ts:21`（exec / exec resume 两处）、`opencode.ts:22`；`runCliJsonl` 已支持 per-spawn `env`（`cli-common.ts:25`，Phase 4 用）。
- analytics `byAgent` 已按 agent id 聚合；issue 投影子任务会建子 issue（本仓 YOU-7/8 实证）。

### 1.5 Phase 0：委派截获 bug（本会话实测复现）

**现象**：领队回复含 `<delegate>` 标记（UI 可见），但委派循环解析为 0 个调用：无"第 N 轮派发"事件、`roundsUsed: 0`、无子任务。

**根因**：`zcode.ts:342` `const scan = full.length >= currentText.length ? full : currentText` —— 服务端回合终态 `response`（full）在思考型回合里可长于流式累计文本（`currentText`）却**不含中间消息里的标记**；按长度二选一选中 full，含标记的 currentText 被丢弃。已验证：用本任务 events.jsonl 重建 currentText 后 `parseDelegates()` 完整解析出两个调用（正则与标记格式无误）；历史上委派成功属偶然（那次 full 恰短或含中间消息）。

**修复设计**（两层，缺一不可。实施修正：只改消费侧不够——失效场景里 `delegationText`（=full）与 `response`（=最后一条消息）**双双不含标记**，含标记的 `currentText` 在 zcode.ts 源头就被丢弃，消费侧无从找回）：

1. **zcode.ts 源头并集**：新增导出 `mergeTurnTexts(full, streamed)`——包含判断空白不敏感（终态全文带消息分隔、流式累计是裸拼接），互含时取终态全文（保真消息边界，final-dedup 契约），互不包含时拼接；`handleTurnEnd` 的 `scan` 由"按长度取长者"改为 `mergeTurnTexts(full, currentText)`，`delegationText` 传并集。
2. **delegate.ts 消费去重**：新增导出 `parseDelegatesMerged(...texts)` 按 `to+prompt` 去重；`runDelegationLoop` 的标记解析（入口 / 循环 / 回灌轮）改为对 `[delegationText ?? '', response]` 多源合并解析，兜底文案取 `scanTexts[0] || scanTexts[1]`。

CLI 后端的 `delegationText`（codex `messageTexts.join`）不受影响；拼接引入的重复解析由去重吸收。

**验收**：`scripts/smoke-model.mjs`（事故重建：终态更长无标记 + 流式含标记 → 旧口径解析 0、新口径找回 2 个委派；三分支 merge；去重与边界）；`scripts/smoke-delegate.mjs` 与 `smoke-final-dedup.mjs` 全绿。

---

## 2. 数据模型与契约

### 2.1 Agent（不变更结构，激活字段）

```ts
// src/main/agents.ts —— model 已存在，无迁移
interface Agent { id; name; backend; role?; systemPrompt?; subordinates?; model?; note?; color }
```

**模型引用格式**：`"<modelId>"`（provider 沿用 config 默认，如 `glm-5.2`）或 `"<providerId>/<modelId>"`（跨 provider 时）。空 = 平台默认。

**决策：Task 不快照 model**。执行时（含 retry/followUp/resume）实时从 agent 定义解析。理由：
1. 改 agent 模型立即对后续所有触发生效，无需任务级同步；
2. zcode resume 本就每次重传 runtimeModel（`zcode.ts:529`），claude `--resume` 可带 `--model`，切换被协议支持；
3. 代价是"改模型后续聊会换模型"——在 Agent 管理页编辑表单加一句 hint 说明即可。

### 2.2 IPC 变更汇总

| 通道 | 变更 | 说明 |
|---|---|---|
| `agents:models` | **新增** `(backend: string) => { backend, source: 'catalog'\|'freeform', default?: string, models: string[] }` | zcode：读 `~/.zcode/cli/config.json` 的 `provider.*.models` 键 + `model.main`（默认项）；claude/codex/opencode：freeform + 常用预设（sonnet/opus/haiku、gpt-5.x 等）；dsh：空（profile 机制 v2） |
| `agents:probe`、`agents:probe-result` | **删除** | 与 `runtime:snapshot` 重复；TeamView 同步删调用，preload/api.ts 删方法 |
| `agents:save` | **加固** | 校验 name 在队内唯一（委派按名匹配，重名歧义） |
| `AgentBackend.start(opts)` | **新增** `model?: string` | 见 §4 |

### 2.3 后端能力矩阵（model 注入方式）

| 后端 | 注入方式 | 位置 |
|---|---|---|
| zcode | `session/create` 与 `session/resume` 都带 runtimeModel（`buildRuntimeModelFromCliConfig(modelRef)` 解析覆盖；目录缺该 modelId 时 push 兜底，`zcode.ts:265-267` 已有此逻辑） | `zcode.ts:529-541` |
| claude | `--model <m>`（与 `--resume` 正交） | `claude.ts:23-30` |
| codex | `exec`/`exec resume` 均加 `-m <m>` | `codex.ts:20-22` |
| opencode | `run` 加 `--model <m>` | `opencode.ts:22-28` |
| dsh | v1 不动（`--profile headless` 固定）；v2 把 model 映射为 profile 名 | `dsh.ts:77` |

---

## 3. 施工阶段

### Phase 0（P0，单独提交）：委派截获修复

见 §1.5。改动文件：`delegate.ts`（+parseDelegatesMerged、runDelegationLoop 三处解析点）。**先于一切**——多 agent 会放大委派使用频率，且后续验收依赖委派。

### Phase 1（主进程，~100 行）：model 管道

1. `backends/types.ts:45`：`start` opts 增加 `model?: string`。
2. `runner.ts`
   - `:272` `backend.start({ ..., model: me?.model })`（`me` 在 `:258` 已查）。
   - `:384` followUp 分支同样注入：`const me = (this.getTeam?.() ?? []).find(a => a.id === task.agentId)`。
3. `zcode.ts`
   - `buildRuntimeModelFromCliConfig(modelRef?: string)`：ref 含 `/` 时拆 provider/model，否则沿用 `cfg.model.main` 的 provider；modelId 覆盖 `model.modelId` 并确保进目录；**export**（供冒烟）。
   - `session/create`（`:538`）加 `...(runtimeModel ? { runtimeModel } : {})`，与 resume 同源取参。
   - `start()` opts 解构加 `model`，create/resume 两处传入 `buildRuntimeModelFromCliConfig(model)`。
4. `claude.ts` / `codex.ts` / `opencode.ts`：按 §2.3 插参数。
5. `index.ts`：`agents:models` handler（zcode 读 config 目录，异常返回 freeform 空）；`agents:save` 加重名校验（重名时给旧名自动加后缀或返回错误——推荐直接 `normalizeAgents` 阶段重名加后缀并在 UI 提示）。

### Phase 2（渲染层，~120 行）：Agent 管理 tab

1. `App.tsx`
   - `View` 类型（`:20`）加 `'agents'`；导航（`:120-126`）加按钮（Users 图标，标签"Agent"），位置放"看板"之后。
   - 视图分支（`:131`）：`view === 'agents' ? <TeamView /> : ...`（不传 embedded）。
   - 命令面板（`:106`）："设置 · 队伍" → "Agent 管理"。
   - TeamView 挪出 SettingsView 后，`settingsSection` 的 `'team'` 值自然失效，保留兼容无必要（同 commit 删）。
2. `SettingsView.tsx`：SECTIONS 删 team 项（`:14`）、删 `:48` 渲染与 `:7` import。其余分区不动（运行时检测留在设置-运行时，符合"检测归 runtime"的分工）。
3. `TeamView.tsx`（本 phase 主要工作量，建议顺手改名 `AgentsView.tsx`）
   - 删：`probeAll`/probes state/`onProbeResult` 订阅（`:19-33`）、检测按钮（`:53-55`）、卡片 probe 徽标（`:73-77`）。
   - 表单加"模型"字段（平台选择之后）：`agents:models` 拉目录——catalog 时 Menu 下拉（首项"默认（平台配置）"）+ "自定义…"输入；freeform 时纯输入框。zcode 实测目录：`zai: glm-5.3 / glm-5.2 / glm-5-turbo`。
   - 卡片（`:72`）backend 徽标旁加 model 徽标（如 `glm-5.2`），同平台多 agent 一眼可辨。
   - `:50` 硬编码数组 → `BACKEND_IDS`（from shared）。
   - `add()`（`:48`）初始值加 `model: ''`。
   - 文案："队员"→"Agent"（标题、按钮"＋ 新建 Agent"、分区描述），保留"可驱使的 Agent"语义。
4. `RuntimeView.tsx:27`：首匹配改为该 backend 的 agents 列表（头像组，≤3 个 + "+N"；悬停列出名字与 model）。
5. `preload/index.ts` + `api.ts`：删 `agents.probe`/`onProbeResult`，加 `agents.models(backend)`。
6. `AutomationView.tsx:40` / `WorkspaceView.tsx`（agent 下拉）：agent 多起来后按 backend 分组（optgroup）；默认项文案改"默认（zcode · 无身份）"。

### Phase 3（清理与文档）

- `ARCHITECTURE.md` §2.1 更新（model 字段语义、会话级注入机制）；`CHANGELOG.md`。
- `agents.ts:74-82` defaultAgents 的 role/systemPrompt 文案不受影响，不动。
- 全局 grep `agents.probe`/`probe-result`/`设置 · 队伍` 确认清零。

### Phase 4（v2，另立方案）：连接级配置与 cc-switch 导入

- `Agent.connection?`（baseURL/apiKey 引用）：zcode 经 runtimeModel 的 provider options 内嵌（`zcode.ts:268-276` 已构造）；CLI 后端经 `runCliJsonl` 的 `env`（`ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`、codex `OPENAI_API_KEY`）。**待实测**：process env 与 settings.json env 的优先级。
- **cc-switch 导入器**（亮点）：读 `~/.cc-switch/cc-switch.db` 的 providers 表，按 app_type 映射平台，每个 provider 生成一个 agent（name + settings_config 里的 model/env）。用户已积累的 22 个 provider 配置一键变成 22 个 agent——这是 cc-switch 数据模型的直接复用，也是对"切换器"到"编排器"升级的最好注脚。
- dsh profile 映射；模型用量/成本（cc-switch 的 model-pricing.json 思路）。

---

## 4. 验收

### 4.1 自动化

- 新增 `scripts/smoke-model.mjs`（仿 `smoke-cli-adapters.mjs`：esbuild bundle 后直调）：
  1. 单测 `buildRuntimeModelFromCliConfig('glm-5.2')` → `model.modelId === 'glm-5.2'`、provider 与 config 一致；`'x/y'` 形式拆分正确；目录缺项时被 push。
  2. claude 后端带 `model: 'sonnet'` 起一轮，status 事件里出现的模型名非空即通过（探测本机无 claude 时跳过）。
  3. `parseDelegatesMerged`：full 不含标记、currentText 含标记的构造样例 → 解析出 1 个调用（Phase 0 回归）。
- 现有冒烟全绿：`smoke:delegate`、`smoke:final-dedup`、`smoke:clis`、`smoke:issues`、`smoke:flow`；`npm run typecheck`。

### 4.2 手工验收场景

1. **双模型并发**：建 "GLM-5.3"（zcode, glm-5.3）与 "GLM-5.2"（zcode, glm-5.2）两个 agent，同一 issue 看板分别指派两个任务，同时 running；任务详情 usage/事件正常、互不串扰。
2. **委派到不同模型**：领队（zcode glm-5.3）`<delegate>` 给 glm-5.2 队友，子任务执行日志出现"第 1 轮派发"，子 issue 挂在父 issue 下（Phase 0 回归 + 多模型委派一箭双雕）。
3. **续聊一致性**：glm-5.2 agent 的任务完成后追问，resume 仍带 glm-5.2（事件流无"历史模型不可用"报错）。
4. **自动化**：automation 绑定非默认 agent，产出 run 的 agent/model 正确。
5. **设置瘦身**：设置里无"队伍"分区、无检测按钮；Agent tab 可增删改、重名被拦/加后缀；运行时分区检测正常。
6. **删除探针无残留**：DevTools 无 `agents:probe` 相关报错。

### 4.3 提交切分

| commit | 内容 | 依赖 |
|---|---|---|
| 1 | Phase 0 委派修复 + smoke-model 的 parseDelegatesMerged 用例 | 无 |
| 2 | Phase 1 主进程管道 + `agents:models` + smoke-model 其余用例 | — |
| 3 | Phase 2 UI（tab 提级、表单、删 probe IPC 同 commit 清理 preload/api） | 2 |
| 4 | Phase 3 文案/文档清理 | 3 |

---

## 5. 风险与回滚

| 风险 | 缓解 |
|---|---|
| zcode create 带 runtimeModel 引发服务端行为变化（未实测） | smoke-model 直连验证；异常时 create 仅在 agent.model 非空时带 runtimeModel（默认路径零变化） |
| 改 agent 模型后续聊换模型 | 表单 hint 明示；协议层支持，非数据损坏 |
| 委派重名歧义 | agents:save 重名校验（§2.2） |
| 删 `agents:probe` 遗漏引用 | 同 commit 清 preload/api/TeamView；grep 验收项 6 |
| 回滚成本 | 数据零迁移（agents.json 兼容），各 commit 独立可 revert；UI 提级 commit 单独成粒度即为回滚单元 |
