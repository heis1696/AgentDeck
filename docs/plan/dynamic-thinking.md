# 动态思考强度施工方案（分诊师 Agent + 领队按单定档 + 回合热切 + 两道 2s 悬浮确认）

> **读者与目的**：本文是动态思考强度功能的唯一施工输入（自包含，不依赖对话上下文）。施工时**一律按符号名定位，不要按行号**；每完成一个批次先过验证门再推进下一批。
>
> **产品目标一句话**：同时防住两头——简单任务不再顶着高思考又慢又贵，复杂任务不再忘了切回高思考导致又蠢又返工。利用 AgentDeck 独有的「多 Agent 编排台 + 跨五后端」定位，通过 **内置分诊师 Agent (`ag_triage`) + 领队 `<delegate thinking>` 完全指派权 + 回合级热切 + 安全网自动升档 + 不偷跑的两道 2s 悬浮确认框** 形成闭环。

---

## 0. 批次总览

| 批次 | 核心交付 | 新增文件 | 主要修改面 | 独立回滚 |
|---|---|---|---|---|
| **Batch 1** | 类型契约 + 五后端回合热切 + 委派/接力/调查 `thinking` 覆写 + 隐藏回合降档 | `src/shared/triage.ts` | `shared/types.ts`、`shared/contracts.ts`、`backends/*`、`store.ts`、`task-service.ts`、`delegate.ts`、`execution/child-spawner.ts`、`prompts/delegation.ts`、`prompts/handoff.ts`、`runner.ts`、`ipc-validation.ts`、`ipc/tasks.ts`、`ipc/issues.ts`、`sidecar-runtime.ts`、`sidecar-server.ts`、`preload/index.ts` | 单提交 revert |
| **Batch 2** | 内置分诊师 Agent (`ag_triage`) + 版本化技能 + 双通路评估引擎 + `RouteThinkingNode` + 自动升档安全网 | `src/main/prompts/triage.ts`、`src/main/thinking-triage.ts` | `agents.ts`、`agent-forge.ts`、`pet/pet-llm.ts`、`pipeline/nodes.ts`、`runner.ts`、`goal-controller.ts`、`ipc/catalog.ts`、`ipc/tasks.ts`、`index.ts`、`preload/index.ts` | 单提交 revert |
| **Batch 3** | UI 配置面（`auto` 与分诊师卡片）+ 全局两道 2s 悬浮确认条 + 任务档位可观测性 | `src/renderer/src/ui/triage-flow.ts`、`src/renderer/src/ui/TriageBar.tsx` | `renderer/src/ui/interaction-center.ts`、`renderer/src/App.tsx`、`renderer/src/api.ts`、`renderer/src/task-service.ts`、`AgentsView.tsx`、`WorkspaceView.tsx`、`TaskDetail.tsx`、`AutomationView.tsx`、`MeetingPanel.tsx`、`GoalCreateDialog.tsx`、`polish/*.css` | 单提交 revert |
| **Batch 4** | 专项 smoke 回归 + 文档同步 + CodeGraph 刷新 | `scripts/smoke-dynamic-thinking.mjs`、`scripts/smoke-ui-triage.mjs` | `package.json`、`docs/PROMPTS.md`、`docs/ARCHITECTURE.md`、`docs/API.md` | 单提交 revert |

**每批硬性验证门**（见 `AGENTS.md`）：
```bash
npm run typecheck
npm run build
npm run smoke:stage6
```
并按改动域加跑专项：`smoke:prompts`、`smoke:lifecycle`、`smoke:delegate`、`smoke:continue`、`smoke:sidecar`、`smoke:ui`、`check:architecture`、`check:design -- --check-baseline`。

---

## 1. 已拍板的产品决策（不可擅自更改）

1. **双目标并重**：既帮简单任务省钱提速，也帮复杂任务自动加码防蠢返工。
2. **分诊师为一等公民系统 Agent**：仿照现有锻造师（`ag_forge`），预置 `ag_triage`（分诊师）在队伍管理页中，用户可直接修改其平台、模型、API 预设与思考强度；判难规则外置为共享目录可编辑、带版本升级的 `SKILL.md`。
3. **领队拥有完全指派覆写权**：领队在 `<delegate to="..." thinking="...">`（以及 `<investigate>`、`<continue>`）里显式标注 `thinking` 时，**无条件覆写队员自身配置**（即使队员被配置为固定档位如 `high`，本次子单仍按领队指定的档位执行），且该子单跳过分诊师、零延迟启动。
4. **放开全档位**：动态分诊可选范围放开至 `off | low | medium | high | max` 全 5 档（是否选 `off` 由 `SKILL.md` 软规则约束：改代码/查逻辑保底 `low`，纯闲聊/纯格式整理才允许 `off`）。
5. **每次追问也走动态分诊**：不仅新任务启动前评估，用户在同一任务下每次追问（`followUp`）也触发动态评估（`dsh`/`opencode` 等不支持热切的后端追问诚实跳过）。
6. **两道独立、不偷跑的 2s 悬浮确认框（仅人工交互入口）**：
   - **第 1 道（分诊前，2s）**：询问是否跳过动态思考评估；**在 2s 倒计时结束前绝不提前调用分诊师**（不偷跑、用户点「跳过」零分诊请求/零 token 消耗）；2s 到期自动进入分诊。
   - **第 2 道（分诊后，2s）**：分诊师返回定档与理由后，再弹出一次 2s 确认窗，把最终决定权交回用户（2s 无操作自动按建议执行，点任意档位立刻改选发车，hover 暂停倒计时）。
   - **后台无人值守路径静默执行**：领队漏标 `thinking` 的委派子单、`autopilot` 自动化、`Goal` 自动续轮、`<continue>` 自动接力不弹确认框，在主进程静默定档。

---

## 2. 数据模型与跨进程契约

### 2.1 类型严格分层（编译期禁止 `'auto'` 漏入后端）

在 `src/shared/types.ts` 中保持 `ThinkingLevel` 纯净，新增配置态联合类型与来源元数据：

```ts
/** 真实执行档位：传给后端、落盘到 Task.thinking，绝不含 'auto' */
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'max'
export const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'max']

/** Agent 静态配置可选值：固定 5 档 | 动态分诊（auto）；undefined = 跟随平台默认 */
export type AgentThinking = ThinkingLevel | 'auto'
export const AGENT_THINKING_VALUES: readonly AgentThinking[] = ['off', 'low', 'medium', 'high', 'max', 'auto']

/** 本次任务/回合生效档位的决策来源（用于 UI 展示、审计与迟滞策略） */
export type ThinkingSource = 'user' | 'leader' | 'triage' | 'escalation' | 'system' | 'agent' | 'fallback'
```

`Task`（`src/shared/types.ts`）新增 4 个可选字段：

```ts
/** 本任务当前生效（或预设覆写）的执行思考档位；缺省按 Agent.thinking 决定 */
thinking?: ThinkingLevel
/** 当前生效档位的决策来源 */
thinkingSource?: ThinkingSource
/** 定档/升降档的一句话理由（≤120 字，时间线与徽章提示用） */
thinkingReason?: string
/** 用户在分诊前主动跳过动态评估：后端 RouteThinkingNode 见此标记直接短路，绝不二次触发分诊师 */
skipTriage?: boolean
```

> **持久化红线**：`src/main/store.ts` 的 `TASK_INDEX_FIELDS` 必须加入 `'thinking'`, `'thinkingSource'`, `'thinkingReason'`, `'skipTriage'`，并在 `migrateTaskRecord` 中校验 `thinking` ∈ `THINKING_LEVELS`、`thinkingSource` ∈ 白名单、`thinkingReason` 截断 ≤120 字、`skipTriage === true` 才保留，防止重启丢字段或脏数据污染索引。

### 2.2 系统内置 Agent 统一抽象（`src/shared/triage.ts`）

新建 `src/shared/triage.ts`（对齐 `src/shared/forge.ts`）：

```ts
import type { ThinkingLevel, ThinkingSource } from './types'
import { isForgeAgent } from './forge'

export const TRIAGE_AGENT_ID = 'ag_triage'
export const TRIAGE_SKILL_NAME = 'thinking-triage'
export const TRIAGE_SKILL_VERSION = 1

export function isTriageAgent(agent: { id: string }): boolean {
  return agent.id === TRIAGE_AGENT_ID
}

/** 系统内置专用 Agent（锻造师 + 分诊师）：不进常规任务/委派/会议/自动化/目标执行名单，不可导出或被锻造师改进 */
export function isSystemAgent(agent: { id: string }): boolean {
  return isForgeAgent(agent) || isTriageAgent(agent)
}

export interface TriageAssessInput {
  /** 前端请求标识，供 triage:cancel 精确中止 */
  requestId?: string
  prompt: string
  handoff?: string
  agentId?: string
  workdir?: string
  /** 追问场景携带：当前任务已生效档位，供迟滞防抖与分诊参考 */
  currentThinking?: ThinkingLevel
  /** 调用语境 */
  kind: 'task' | 'followup' | 'delegate' | 'goal' | 'handoff'
}

export interface TriageDecision {
  level: ThinkingLevel
  reason: string
  /** 追问迟滞保缓存触发时：rawLevel 为分诊师原始建议，level 为最终采纳档位 */
  rawLevel?: ThinkingLevel
  cachePreserved?: boolean
  source: Extract<ThinkingSource, 'triage' | 'fallback'>
  /** 耗时与通路诊断，便于日志留痕 */
  via: 'preset-http' | 'backend-cli' | 'fallback'
  durationMs: number
}

export type TriageAssessResult =
  | { ok: true; decision: TriageDecision }
  | { ok: false; error: string; fallback: ThinkingLevel; cancelled?: boolean }
```

**全仓库系统 Agent 过滤点清单**（施工时全部替换为 `isSystemAgent`）：
1. `src/main/agents.ts`（`defaultAgents` 补 `ag_triage` + `loadAgents` 按 id 补缺，同 `ag_forge`；`normalizeAgent` 接受 `AGENT_THINKING_VALUES`，并禁止把系统 Agent 写进任何人的 `subordinates`）
2. `src/main/agent-forge.ts`（`improveAgent` 拒绝改进 `isSystemAgent`）
3. `src/main/ipc/catalog.ts`（`agents:export-md` 拒绝导出 `isSystemAgent`）
4. `src/main/ipc/issues.ts`（`issues:add-comment` 的 `@mention` 过滤 `!isSystemAgent`）
5. `src/renderer/src/components/AgentsView.tsx`（分诊师卡片徽章、隐藏系统提示词/下属/导出/改进按钮、下属多选排除 `isSystemAgent`）
6. `src/renderer/src/components/WorkspaceView.tsx`（可用执行 Agent 排除 `isSystemAgent`）
7. `src/renderer/src/components/AutomationView.tsx`（排除 `isSystemAgent`）
8. `src/renderer/src/components/meeting/MeetingPanel.tsx`（排除 `isSystemAgent`）
9. `src/renderer/src/components/goal/GoalCreateDialog.tsx`（排除 `isSystemAgent`，顺手补齐旧遗漏）

### 2.3 IPC 与输入白名单扩展

- `src/shared/contracts.ts` & `src/preload/index.ts`：
  - `AgentInfo.thinking?: AgentThinking`
  - `TaskCreateInput` / `IssueCreateInput` 新增可选字段：`thinking?: ThinkingLevel`、`thinkingSource?: ThinkingSource`、`thinkingReason?: string`、`skipTriage?: boolean`
  - `tasks.followUp` 的 `opts` 新增：`thinking?: ThinkingLevel`、`thinkingSource?: ThinkingSource`、`thinkingReason?: string`、`skipTriage?: boolean`
  - 新增 `triage` 域：
    ```ts
    triage: {
      assess: (input: TriageAssessInput) => Promise<TriageAssessResult>
      cancel: (requestId: string) => Promise<{ ok: boolean }>
    }
    ```
- `src/main/ipc-validation.ts`：
  - `parseAgents` 的 `thinking` 改用 `optionalAgentThinking`（收 `AGENT_THINKING_VALUES`）
  - `parseTaskCreate` / `parseIssueCreate` / `parseFollowUpOptions` 的 `assertKeys` 同步放行 `thinking`（仅 `THINKING_LEVELS`）、`thinkingSource`（白名单）、`thinkingReason`（trim ≤120 字）、`skipTriage`（boolean）
  - 新增 `parseTriageAssess(value: unknown): TriageAssessInput`
- `src/main/task-service.ts`：
  - `TaskCreateInput`、`ChildTaskCreateInput`、`HandoffTaskCreateInput` 同步透传 `thinking`、`thinkingSource`、`thinkingReason`、`skipTriage` 进 `tx.create(...)`
- `src/main/sidecar-runtime.ts`：
  - `SidecarAgent` 补上 `thinking?: AgentThinking`，确保 sidecar 进程读取 `agents.json` 时不丢思考配置。

---

## 3. 五后端回合级热切规格

### 3.1 后端接口扩展（`src/main/backends/types.ts`）

```ts
export type ThinkingSwitchMode = 'per-turn' | 'startup-only' | 'none'

export interface BackendTurnOptions {
  /** 本回合覆盖的思考强度（缺省沿用会话建立时的档位） */
  thinking?: ThinkingLevel
}
```

- `AgentBackend` 新增可选只读属性 `thinkingSwitchMode?: ThinkingSwitchMode`（缺省按 `'none'` 保守处理，兼容所有测试桩 fake backend）。
- `BackendSession.send` 签名向后兼容扩展为：
  ```ts
  send: (content: string, turn?: BackendTurnStamp, opts?: BackendTurnOptions) => Promise<void>
  ```

### 3.2 逐后端行为矩阵

| 后端 | `thinkingSwitchMode` | `start()` | `send(..., opts)` 热切实现 | 关键注意点 |
|---|---|---|---|---|
| **claude** (`claude.ts`) | `'per-turn'` | `MAX_THINKING_TOKENS` env 注入 | `runTurn` 接收 `turnThinking = opts?.thinking ?? thinking`，直接注入新进程 env | 零重启、不断 `--resume` 上下文 |
| **codex** (`codex.ts`) | `'per-turn'` | `-c model_reasoning_effort=...` | `runTurn` 接收 `turnThinking = opts?.thinking ?? thinking`，直接拼进 `exec resume` 参数 | 零重启、不断 `resume` 上下文 |
| **zcode** (`zcode.ts` + `zcode-config.ts`) | `'per-turn'` | `session/setModel` | 记录会话内 `appliedThinking`；`send` 时若 `opts?.thinking && opts.thinking !== appliedThinking`，先按 `buildModelSelection(model, connection, nextThinking, bundle)` + `setModelWithLevelFallback(conn, sessionId, nextSelection, nextThinking)` 切档，成功即更新 `appliedThinking`，再发 `session/send`；切档失败记状态事件并沿用原档继续，不炸回合 | **关键修复（`zcode-config.ts`）**：`upsertPresetProvider` 注册预设模型时，将 `optionSpecs.reasoningLevel.values` 从单值 `[reasoning.level]` 改为该协议全量可切档位（anthropic: `['disabled','low','high','max']`，openai: `['disabled','low','medium','high','max']`）；仅当明确非动态且 `silent` 时保留原静默兼容，避免热切撞注册表拒收 |
| **dsh** (`dsh.ts` + `dsh-acp.ts`) | `'startup-only'` | 启动 env 注入 `cordis.yml` | 忽略 `opts?.thinking`（不杀进程、不丢会话） | 分诊 prompt 显式告知「不支持中途升档，拿不准宁可偏高一档」；追问跳过分诊与弹框 |
| **opencode** (`opencode.ts` + `opencode-server.ts`) | `'none'` | 忽略 | 忽略 | 追问跳过分诊与弹框；Agent 页选 `opencode + auto` 时展示灰字提示「当前平台暂不支持动态思考」 |

---

## 4. 分诊师 Agent 与评估引擎

### 4.1 预置定义与迁移（`src/main/agents.ts`）

在 `defaultAgents()` 中紧随 `FORGE_AGENT_ID` 新增：

```ts
{
  id: TRIAGE_AGENT_ID,
  name: '分诊师',
  backend: 'zcode',
  thinking: 'off',
  color: '#06b6d4',
  role: '分诊',
  note: '专职评估任务难度并分配思考强度——绑定 API 预设与快模型可走直连（~1 秒），未绑预设自动回退 CLI；无需系统提示词（由 thinking-triage 技能提供）'
}
```

`loadAgents()` 迁移补缺逻辑与 `ag_forge` 完全一致：按 `id` 查缺自动补入老用户的 `agents.json`，不覆盖用户已改过的配置。

### 4.2 技能正文与升级规则（`src/main/prompts/triage.ts`）

严格遵循 `docs/PROMPTS.md` 约定（纯字符串/纯函数、不 import `electron`、带 `TRIAGE_SKILL_VERSION` + `TRIAGE_SKILL_BODIES_PREVIOUS` 升级比对链）：

- 技能落盘路径：`<sharedDir>/skills/thinking-triage/SKILL.md`。
- 5 档判难标尺（清晰可操作、用户可直接编辑）：
  - `off`：纯闲聊、问候、极简纯文本润色/格式转换（**涉及代码阅读、修改或排错严禁给 `off`**）；
  - `low`：单文件明确小改（改文案/注释/配置/重命名/简单查询）、信息检索、已知路径的直接提取；
  - `medium`：常规单模块功能开发、补单测、明确根因的 bug 修复、中等文档编写；
  - `high`：跨多文件/跨模块改动、需要权衡方案的设计、非显然的 bug 排查、复杂重构、领队需要拆解并行委派的中大型任务；
  - `max`：核心状态机/并发/竞态/死锁/数据一致性排查、大规模架构重构、高风险破坏性变更、此前低/中档已失败返工的难题。
- 特殊偏置说明（拼在运行时评估上下文块里）：
  - 目标后端 `thinkingSwitchMode === 'startup-only'`（如 `dsh`）：注明「该执行后端启动后无法升档，拿不准时宁可高选一档」；
  - 目标为领队（带 `subordinates`）：注明「领队负责拆解与审单，若任务需规划并行方案，不应低估」；
  - 追问场景附带 `currentThinking`：注明「用户正在同一会话追问，若仅是顺手微调，可参考当前档位避免无谓波动」。
- 硬输出契约：只输出单行 JSON `{"level":"off|low|medium|high|max","reason":"≤30字中文理由"}`，字段不得含派发标签。

### 4.3 双通路评估引擎（`src/main/thinking-triage.ts`）

纯函数面（供 smoke 直连）：`ensureTriageSkill`、`resolveTriageSkillBody`、`parseTriageResponse`、`applyFollowUpHysteresis`、`escalateThinkingLevel`。

主进程编排入口 `assessTaskThinking(deps, input, signal?)`：
1. **查找引擎**：从 `deps.agents` 找 `isTriageAgent`（缺失退回默认定义）。
2. **输入清洗与硬截断**：`prompt` 截断前 3000 字符、`handoff` 截断前 800 字符，避免把巨型日志原样塞进分诊师拖慢推理。
3. **通路分流**：
   - **快通路（HTTP 直连）**：若分诊师同时配置了 `presetId`（在 `deps.presets` 中存在）与 `model` → 调用扩展支持 `signal?: AbortSignal` 和 `maxTokens?: number` 的 `chatCompletion`（复用 [src/main/pet/pet-llm.ts](file:///d:/agentdeck/src/main/pet/pet-llm.ts)，不重复造轮子！），硬超时 **12 秒**。
   - **兜底通路（CLI 单回合）**：未配预设或预设不存在 → 复用类似 `runForgeTurn` 的一次性 `backend.start`（`workdir = os.homedir()`、权限全 `deny`、`thinking = triageAgent.thinking === 'auto' ? 'off' : triageAgent.thinking` 防自递归！），硬超时 **15 秒**，监听 `AbortSignal` 立即 `stopLaunch/close` 杀进程。
4. **严格解析 + Fail-open 兜底**：
   - 走 `parseTriageResponse` 剥围栏、提取首个 `{` 到末个 `}`、校验 `level ∈ THINKING_LEVELS`、清洗 `reason`（剥 `DISPATCH_TAG_RE`，截断 ≤60 字）。
   - 任何异常/超时/解析失败 → 返回 `{ ok: false, error, fallback: 'medium' }`（若 `signal.aborted` 则 `cancelled: true`），**绝不抛异常阻断主流程**。
5. **在飞请求管理**：主进程维护 `Map<string, AbortController>` 供 `triage:cancel(requestId)` 精确取消；结束后 `finally` 清理，零泄漏。

### 4.4 追问迟滞防抖（`applyFollowUpHysteresis`）

为保护同会话的 Prompt Cache，仅对 `kind === 'followup'` 且 `currentThinking` 存在时执行纯函数规整：
- **升档**（`rank(proposed) > rank(current)`）：**无条件采纳**（宁可失效一次缓存也不返工）。
- **同档**（`proposed === current`）：保持不变。
- **小幅降档（仅差 1 档，如 `max → high` 或 `high → medium`）**：保留 `currentThinking`，返回 `cachePreserved: true` 与 `rawLevel: proposed`，并把 `reason` 附注 `（保缓存沿用原档）`；用户仍可在第 2 道 2s 确认框里一键手动改低。
- **大幅降档（落差 ≥ 2 档，如 `max → low`/`off` 或 `high → low`/`off`）**：采纳降档（省下的思考开销远高于单次 cache 重建）。

---

## 5. 编排层规则：委派覆写、`FlowEngine` 节点与安全网

### 5.1 协议标记扩展（严守 `docs/PROMPTS.md` 红线）

1. **解析器（`src/main/delegate.ts`）**：
   - 新增纯函数 `parseThinkingAttr(attrs: string): { level?: ThinkingLevel; invalid?: string }`：读取 `thinking` 属性，不区分大小写匹配 `THINKING_LEVELS`；未写返回 `{}`；写错返回 `{ invalid }`（**宽容降级：按未声明处理并在时间线注记，绝不因此拒单**）。
   - `DelegateCall`、`InvestigateCall`、`ContinueCall` 均增加可选 `thinking?: ThinkingLevel` 与 `invalidThinking?: string`。
   - `parseDelegates`、`parseInvestigates`、`parseContinue` 同步提取 `thinking` 属性。
2. **提示词（`src/main/prompts/delegation.ts`、`src/main/prompts/handoff.ts`）**：
   - **严守示例标记红线**：全文绝不新增第二个 `<delegate ...>` 或 `<continue ...>` 完整尖括号标签！
   - 在 `buildDelegationBlock` 的「写派单」小节中仿照 `summary`/`sparse` 用纯文字加一条：
     - 告知领队可在开标签里加可选属性 `thinking`（写法形态：`thinking="off|low|medium|high|max"`，不写尖括号），该属性直接覆盖队员本次思考强度；简短机械改法给 `low`、常规开发给 `medium`、跨文件复杂改动/疑难排错给 `high` 或 `max`、拿不准可省略。
   - 在 `CONTINUE_BLOCK` 的「怎么写」中用纯文字补一句可选属性 `thinking` 说明（不新增开标记字样）。
3. **派单透传（`src/main/execution/child-spawner.ts`、`src/main/runner.ts`）**：
   - `ChildSpawner.spawnDelegateChildExclusive` / `spawnInvestigateChild`：若 `call.thinking` 存在，向 `taskCreator` 传入 `thinking: call.thinking, thinkingSource: 'leader', thinkingReason: call.reason ? '领队指派：' + call.reason : '领队按单定档'`；若 `call.invalidThinking` 存在，时间线 `guardedNote` 提示已忽略非法值。
   - `runner.ts` 的 `attachContinue` 处理器同步接收 `thinking?: ThinkingLevel` 透传给 `taskService.resolveHandoffTask`。

### 5.2 思考档位裁决器与 `RouteThinkingNode`

新增纯函数 `resolveStaticThinking(task, agent)` + `FlowEngine` 节点 `RouteThinkingNode`（`src/main/pipeline/nodes.ts`）：

| 优先级 | 条件 | 最终档位 | 是否调分诊师 |
|---|---|---|---|
| 1 | `task.thinking` 已落盘（来自用户手选 / 前端两道确认 / 领队 `<delegate thinking>` / 接力 / 安全网升档） | 直接用 `task.thinking` | 否 |
| 2 | `task.skipTriage === true` | 平台默认（`undefined`） | 否（绝不违背用户跳过） |
| 3 | `agent?.thinking === 'auto'` 且后端 `thinkingSwitchMode !== 'none'` 且非办公室会话 | 调用分诊师 `assessTaskThinking`（后台静默），落盘 `thinking`/`thinkingSource`/`thinkingReason` | **是**（仅后台无人值守/兜底路径会走到此步） |
| 4 | `agent?.thinking` 为固定 5 档之一 | `agent.thinking` | 否 |
| 5 | 其他（`undefined` 或 `opencode`） | `undefined`（跟随平台默认） | 否 |

- `RouteThinkingNode` 插在 `runner.run()` 的 `[RouteThinkingNode, StartNode, RunningNode, FinalizeNode]` 最前；因为节点走 `FlowEngine` 标准 `begin/end` 账本，**`IssuePipeline.isIdle()` 天然精确记账，热更门控零泄漏**。
- 定档结果落盘后，在任务时间线写入一条 `kind: 'status'` 事件：
  - 例：`思考强度：高（领队指派：排查并发锁）` / `思考强度：低（分诊师：单文件文案修改）` / `思考强度：中（分诊超时，降级兜底）`。
- **热切与 `followUp`**：
  - `runner.followUp` 收到 `opts.thinking` 时，落盘更新 `task.thinking` / `thinkingSource` / `thinkingReason`，并在 `sendTurn(taskId, session, turnContent, claim, { thinking })` 或 `resume` 的 `backend.start({ thinking })` 中下发。
  - 若是后台自动调 `followUp`（例如 Goal 续轮）且未传 `opts.thinking`、且 `agent.thinking === 'auto'`、且后端 `thinkingSwitchMode === 'per-turn'`，则在 `followUp` 内部走静默分诊 + 迟滞防抖。

### 5.3 隐藏回合强制降档 + 确定性升档安全网

1. **隐藏辅助回合降档**（`src/main/runner.ts`）：
   - `retitleByAgent` 调用 `sendTurn(..., { thinking: 'off' })`；
   - `sendChildSummaryTurn` 调用 `session.send(content, stamp, { thinking: 'low' })`。
   - 对不支持 `off` 的模型，由 `zcode` 的 `setModelWithLevelFallback` 或 `codex` 的 `minimal`、`claude` 的 `MAX_THINKING_TOKENS=0` 自然承接。
2. **确定性自动升档安全网**（纯函数 `nextEscalatedLevel(current?: ThinkingLevel): ThinkingLevel | null`：`off→low→medium→high→max`，已 `max` 返回 `null`）：
   - **瞬态失败重试**（`runner.maybeAutoRetry`）：第 2 次重试（`freshSession: true`）且 `agent?.thinking === 'auto'` 时自动升一档并落盘 `thinkingSource: 'escalation'` + 时间线留痕。
   - **Goal 停滞**（`goal-controller.ts`）：当 `goal.noProgress >= 1`（上一轮无可见进展）触发续轮/新阶段，若当前档位低于 `max` 且 `agent.thinking === 'auto'`，下轮自动升一档。
   - **Doom Loop 放行后续轮**（`execution/doom-window.ts`）：当 doom-loop 被人工审批允许继续时，标记该任务下回合请求升一档（经回调端口通知 runner，不破坏 `execution/* → runner` 单向依赖边界）。
   - **领队 `<review verdict="fail">` 提示**（`delegate.ts` 回灌报告）：当失败或被退回的子单带有 `task.thinking` 时，在报告标题附注 `（思考：低）` 等信息，帮助领队改派时自然加码。

---

## 6. 前端两道 2s 悬浮确认条与 UI 规格

### 6.1 严格串行、不偷跑的状态机（`src/renderer/src/ui/triage-flow.ts`）

独立纯 TypeScript 模块（零 React/DOM 依赖，注入 `timers` 方便 Node 单测），挂载到 `interaction-center.ts`（跨页面切换状态不丢、宿主卸载自动清理）：

```
                      ┌──────────────── 用户点「跳过」────────────────────────┐
                      │（绝不调 triage:assess，直接以 skipTriage:true 发车）    │
                      │                                                       ▼
[ idle ] ──开始──▶ [ 1. confirm-triage (2000ms) ] ──点任意档位──▶ [ dispatching ] ──▶ [ idle ]
                      │    • 尚未调用分诊师（零偷跑）                         ▲
                      │    • hover 暂停倒计时                                │
                      │    • 点「取消」/ Esc → 撤回不发车，回 [idle]          │
                      │                                                       │
                      │ 2s 到期 / 点「立即评估」                               │
                      ▼                                                       │
                 [ 2. assessing ] ──点「跳过」→ triage:cancel ────────────────┤
                      │    • 调 bridge.triage.assess                         │
                      │    • 失败/超时 → toast 轻提示，fallback='medium' ─────┤
                      │                                                       │
                      │ 分诊师返回 { level, reason }                          │
                      ▼                                                       │
                 [ 3. confirm-level (2000ms) ] ──2s 到期 / 立即执行 / 改选档位─┘
                           • 展示分诊师定档与理由
                           • hover 暂停倒计时
                           • 点「取消」/ Esc → 撤回不发车，回 [idle]
```

**触发条件判断（纯函数 `shouldPromptTriage`）**：
- 新任务（`WorkspaceView` 创建普通 `task` 且 `startNow === true`）：目标 Agent 的 `thinking === 'auto'` **且** `backend !== 'opencode'` → 走两道悬浮确认；否则直接提交，零打扰。
- 追问（`TaskDetail.sendFollowUp`，非 `/goal`/`/meeting`、非 `relay` 按钮）：目标 Agent 的 `thinking === 'auto'` **且** `backend ∈ { 'claude', 'codex', 'zcode' }`（支持回合热切）→ 走两道悬浮确认；`dsh`/`opencode` 或固定档位直接发送，零打扰。
- 取消发送防丢稿：若用户在阶段 1 或阶段 3 点「取消」或按 `Escape`，`Promise` 解析为 `{ cancelled: true }`，输入框内容原样保留不清空！
- 并发保护：若当前已有正在确认的悬浮条，禁止重复打开第二条（提示「请先完成当前思考强度确认」）。

### 6.2 视觉与交互组件（`src/renderer/src/ui/TriageBar.tsx` + `polish/` 令牌）

- 挂载在 `App.tsx` 全局层（与 `Toasts` 同级，底部居中悬浮条，非模态——不抢页面焦点、不触发 `topModal()` 封锁切页）。
- **阶段 1（分诊前 2s）**：
  - 文案：`即将评估思考强度 · 1.8s`（底部细进度条随倒计时收缩，hover 暂停）
  - 操作：`跳过（沿用原档）` | `关 · 低 · 中 · 高 · 极` 紧凑胶囊 | `立即评估` | `× 取消`
- **评估中**：
  - 文案：`分诊师评估任务难度中…`（微妙脉冲点）
  - 操作：`跳过` | `× 取消`
- **阶段 2（定档后 2s）**：
  - 文案：`分诊师建议：[高] 涉及跨进程状态机锁竞态 · 1.8s`（若追问触发迟滞保缓存，附小标签 `保缓存`）
  - 操作：`立即执行`（主按钮） | `关 · 低 · 中 · 高 · 极`（当前建议档高亮，点击任意档位立即改选并执行） | `× 取消`
- **设计令牌约束**：所有颜色/圆角/字号/间距全部引用 `src/renderer/src/tokens.css` 的既有 CSS 变量，**零新增 `check:design` 违规**。

### 6.3 Agent 页与任务详情页改动

- **`AgentsView.tsx`**：
  - `THINKING_OPTIONS` 新增 `{ value: 'auto', label: '动态（分诊师）' }`（`THINKING_LABELS.auto = '动态'`）。
  - 为 `isTriageAgent(a)` 渲染专属徽章 `✦ 分诊师`；编辑弹窗隐藏「系统提示词 / 委派下属 / 共享工作区」，保留「平台 / 模型 / API 预设 / 思考强度 / 备注」并给出「绑定预设+快模型走 1 秒直连」引导提示。
  - 当普通 Agent 选 `opencode` 且思考设为 `auto` 时，显示提示「OpenCode 暂不支持动态思考，执行时将沿用其自身配置」。
- **`TaskDetail.tsx`**：
  - 任务标题栏元数据区在 `task.thinking` 存在时渲染紧凑档位徽章（如 `思考：高`），`title` tooltip 展示来源与理由（如 `分诊师定档：涉及跨进程状态机锁竞态`）。

---

## 7. 不变量与防回归红线清单

| 编号 | 不变量 | 验收方式 |
|---|---|---|
| **DT-1** | `'auto'` 永不流入 `AgentBackend.start`、`BackendSession.send` 或 `Task.thinking` | TS 类型分离 + `smoke-dynamic-thinking` 断言 |
| **DT-2** | 阶段 1（2s 确认是否跳过分诊）期间**绝不**调用 `triage:assess`；用户点「跳过」后零分诊调用且任务带 `skipTriage: true`，后端 `RouteThinkingNode` 不得补跑分诊 | `smoke-ui-triage`（断言 assess 调用次数 === 0）+ `smoke-dynamic-thinking` |
| **DT-3** | 领队 `<delegate thinking="...">` 无条件覆写队员静态档位与 `auto`，且子单跳过分诊师 | `smoke-dynamic-thinking` + `smoke-delegate` |
| **DT-4** | `prompts/delegation.ts` 与 `prompts/handoff.ts` 不新增任何完整 `<delegate>`/`<continue>` 尖括号示例 | `npm run smoke:prompts` |
| **DT-5** | `isSystemAgent`（锻造师 + 分诊师）不出现在任务/委派/会议/目标/自动化执行名单，不被 `@mention` 建单，不被导出或改进 | `smoke-dynamic-thinking` + `smoke-ipc-validation` |
| **DT-6** | 分诊师超时/报错/非 JSON 回复时 Fail-open 降级（默认 `medium`）并记状态日志，绝不阻塞任务启动 | `smoke-dynamic-thinking` |
| **DT-7** | `zcode` 预设线同会话热切 `reasoningLevel` 不被注册表拒绝；`claude`/`codex` 追问热切不丢 `sessionId` | `smoke-cli-adapters` + `smoke-zcode` + `smoke-dynamic-thinking` |
| **DT-8** | 追问迟滞：升档立刻切；差 1 档降档保缓存；落差 ≥ 2 档或用户手动点选直接切 | `smoke-dynamic-thinking` |
| **DT-9** | `RouteThinkingNode` 经 `FlowEngine` 进出 `IssuePipeline` 账本，终态/取消/报错后 `isIdle() === true` 无泄漏 | `smoke-flow` + `smoke-issue-pipeline` |
| **DT-10** | 跨进程边界零违规（`check:architecture` 全绿）、渲染令牌零新增基线外违规（`check:design -- --check-baseline` 全绿） | 两个静态门禁脚本 |

---

## 8. 分批施工计划与各批验收命令

### Batch 1：契约 + 后端热切 + 委派覆写 + 隐藏回合降档
- **范围**：`src/shared/types.ts`、`src/shared/triage.ts`、`src/shared/contracts.ts`、`src/main/store.ts`、`src/main/task-service.ts`、`src/main/backends/{types,claude,codex,zcode,zcode-config,dsh,opencode,opencode-server}.ts`、`src/main/delegate.ts`、`src/main/execution/child-spawner.ts`、`src/main/prompts/{delegation,handoff}.ts`、`src/main/runner.ts`、`src/main/ipc-validation.ts`、`src/main/ipc/{tasks,issues}.ts`、`src/main/sidecar-runtime.ts`、`src/preload/index.ts`。
- **验收命令**：
  ```bash
  npm run typecheck && npm run build && npm run smoke:stage6 && npm run smoke:prompts && npm run smoke:lifecycle && npm run smoke:delegate && npm run smoke:continue && npm run smoke:sidecar && npm run check:architecture
  ```

### Batch 2：分诊师 Agent + 双通路评估引擎 + `RouteThinkingNode` + 升档安全网
- **范围**：`src/main/prompts/triage.ts`、`src/main/thinking-triage.ts`、`src/main/pet/pet-llm.ts`（扩展可选 `signal`/`maxTokens`）、`src/main/agents.ts`、`src/main/agent-forge.ts`、`src/main/pipeline/nodes.ts`、`src/main/execution/doom-window.ts`、`src/main/goal-controller.ts`、`src/main/runner.ts`、`src/main/index.ts`、`src/main/ipc/{catalog,issues}.ts`、`src/preload/index.ts`。
- **验收命令**：
  ```bash
  npm run typecheck && npm run build && npm run smoke:stage6 && npm run smoke:prompts && npm run smoke:lifecycle && npm run smoke:sidecar && npm run check:architecture
  ```

### Batch 3：前端配置面 + 两道 2s 悬浮确认条 + 任务档位徽章
- **范围**：`src/renderer/src/ui/triage-flow.ts`、`src/renderer/src/ui/TriageBar.tsx`、`src/renderer/src/ui/interaction-center.ts`、`src/renderer/src/App.tsx`、`src/renderer/src/api.ts`、`src/renderer/src/task-service.ts`、`src/renderer/src/components/{AgentsView,WorkspaceView,TaskDetail,AutomationView}.tsx`、`src/renderer/src/components/meeting/MeetingPanel.tsx`、`src/renderer/src/components/goal/GoalCreateDialog.tsx`、样式表（令牌合规）。
- **验收命令**：
  ```bash
  npm run typecheck && npm run build && npm run smoke:stage6 && npm run smoke:ui && npm run check:architecture && npm run check:design -- --check-baseline
  ```

### Batch 4：专项冒烟测试 + 文档与图谱收口
- **范围**：新增 `scripts/smoke-dynamic-thinking.mjs` 与 `scripts/smoke-ui-triage.mjs` 并接入 `package.json`；同步更新 `docs/PROMPTS.md`、`docs/ARCHITECTURE.md`、`docs/API.md`；运行 `npm run graph:index` 刷新 CodeGraph。
- **验收命令**：
  ```bash
  npm run typecheck && npm run build && npm run smoke:stage6 && npm run smoke:prompts && npm run smoke:lifecycle && npm run smoke:ui && npm run check:architecture && npm run check:design -- --check-baseline && npm run graph:index
  ```
