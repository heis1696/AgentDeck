# opencode 拆解报告（OPENCODE-TEARDOWN）

> 拆解日期：2026-09-09
> 对象：`D:\agentdeck\teardown\repos\opencode`（本地克隆的工作副本）
> 方法：直接通读源码（packages/protocol、packages/schema、packages/opencode 核心、packages/llm、packages/plugin、packages/core、packages/sdk、packages/client、specs/），并与 agentdeck 的 `src/main/backends/opencode.ts` 适配器及其 runner/delegate/permission 体系逐条对照。
> 本文中所有行号均指本地克隆文件的实际行号。

---

## 1. 一句话定位与 monorepo 地图

**一句话定位**：opencode 是一个「本地优先、server/client 分离、事件溯源（event-sourced）的编码 Agent 平台」——核心是一个常驻 HTTP+SSE 服务器进程，CLI/TUI/桌面/Web 全部是它的客户端；LLM 调用、工具执行、权限审批、会话历史全部以带版本号的**事件流**形式暴露和持久化。

### 1.1 顶层结构

```
opencode/
├── packages/    # 全部产品代码（turbo monorepo，bun 工具链）
├── specs/       # 架构规格文档（设计中的协议/存储/TUI 规格，非构建产物）
├── sdks/        # vscode 扩展（独立 npm 工程）
├── script/ infra/ nix/ patches/ perf/ github/ artifacts/  # 构建/CI/实验
```

`specs/` 不是协议规范本身，而是**仓库内的架构设计文档目录**：`specs/project.md` 是"单实例多项目/多 worktree"的 API 设计稿（定义了 `/project/:projectID/session/...` 路由族）；`specs/v2/` 是正在进行的 V2 事件溯源会话架构规格（`session.md`、`config.md`、`tools.md`、`provider-model.md`、`schema-changelog.md` 等），其中 `schema-changelog.md` 逐条记录持久化契约变更——这本身就是一种值得学习的"协议演进治理"实践。真正的协议代码在 `packages/schema`（数据契约）与 `packages/protocol`（HTTP 契约）。

### 1.2 packages 职责与依赖方向

依赖方向已从各 package.json 的 `dependencies` 核实（箭头 = 依赖）：

| 包 | 职责 | 依赖（@opencode-ai/*） |
|---|---|---|
| `schema` | **全部数据契约的叶子包**：事件定义 `define()`、Session/Message/Part、Permission、LLM 消息等 Effect Schema | 无（叶子） |
| `llm` | 自研 LLM 客户端：Route = Protocol×Endpoint×Auth×Framing，7 种协议 × 10+ provider | schema |
| `protocol` | HTTP API 定义（Effect HttpApi）：18 个 endpoint group + SSE 事件流 | schema |
| `client` | Effect 原生客户端（复用 protocol 定义） | schema, protocol |
| `sdk`（`packages/sdk/js`） | 从 openapi.json 生成的 TypeScript 客户端 + `createOpencode()`（拉起服务器并返回 client） | （生成物，自包含） |
| `plugin` | 插件宿主类型：Hooks 面向插件作者 | sdk |
| `core` | Effect 化的核心服务：数据库（drizzle+SQLite）、EventV2 事件总线、V1 兼容层 | llm, schema, plugin, effect-drizzle-sqlite, effect-sqlite-node |
| `server` | HTTP 服务器组装（CORS、鉴权等） | core, protocol |
| `opencode` | **主二进制**：session 引擎、agent 循环、权限、工具、CLI/TUI 命令 | codemode, llm, plugin, protocol, schema, script, sdk, server, tui |
| `tui` / `session-ui` / `ui` / `web` / `app` | 终端 UI / 会话 UI 组件 / 设计系统 / Web 前端（app 是 vite+playwright 的 Web 应用） | — |
| `desktop` | Electron 桌面壳 | — |
| `cli` | 独立 CLI 发布包 | core, sdk, server, tui |
| `codemode` | "Effect 原生受限代码执行，基于 schema 描述的工具"（沙箱执行） | — |
| `console` `containers` `enterprise` `function` `identity` `slack` `stats` `httpapi-codegen` `http-recorder` `sdk-next` | 周边：云函数/企业版/身份/Slack 集成、HTTP API 代码生成、HTTP 录制回放（测试用 cassette） | — |

依赖方向总结：`schema → (llm, protocol) → (core, client) → server → opencode`，一条严格单向的分层；**"数据契约包（schema）零依赖"** 是整个 monorepo 稳定性的锚点。

---

## 2. Client/Server 协议（最重要章节）

### 2.1 分层：三个包构成一条契约链

- `packages/schema`：定义**事件**与**实体**（Session、Message、Part、Permission…），全部用 Effect Schema 写成可解码的类型；
- `packages/protocol`：把实体装配成 **HTTP API**（Effect `HttpApi`），一处定义同时产出服务端路由、客户端调用与 OpenAPI 文档；
- `packages/sdk`（`packages/sdk/js`）：从 `packages/sdk/openapi.json` 生成的发布用客户端。

`packages/protocol/src/api.ts:37-64` 是总装现场——18 个 group 一次拼装，并统一挂上 `Authorization` 与 `SchemaErrorMiddleware`：

```ts
// packages/protocol/src/api.ts:37-45
HttpApi.make("server")
  .add(HealthGroup)
  .add(LocationGroup.middleware(locationMiddleware))
  .add(AgentGroup.middleware(locationMiddleware))
  .add(makeSessionGroup(sessionLocationMiddleware))
  .add(MessageGroup.middleware(sessionLocationMiddleware))
  ...
  .add(eventGroup)
```

值得注意的设计：**protocol 包持有中间件位置，server 注入具体实现**（`api.ts:25` 注释），使协议定义不绑定任何运行时。

### 2.2 事件模型：`define()` + durable 版本号

事件的原子定义在 `packages/schema/src/event.ts:42-70`：

```ts
// packages/schema/src/event.ts:42-70（节选）
export function define(input: {
  readonly type: Type
  readonly durable?: { readonly version: number; readonly aggregate: string }
  readonly schema: Fields
}) {
  const data = Schema.Struct(input.schema)
  return Schema.Struct({
    id: ID,                                       // "evt_" + ascending
    metadata: optional(Schema.Record(Schema.String, Schema.Unknown)),
    type: Schema.Literal(input.type),
    durable: optional(Schema.Struct({
      aggregateID: Schema.String, seq: Schema.Int, version: Schema.Int })),
    location: optional(Location.Ref),
    data,
  })
}
```

三个关键决策：

1. **durable 是事件定义的属性而非负载**：`durable: { aggregate: "sessionID", version: 1 }` 声明"此事件持久化到 sessionID 聚合流，当前 schema 版本 1"。事件清单 `packages/schema/src/event-manifest.ts:57-61` 把 `ServerDefinitions`（服务器对外 SSE 暴露的子集）与全量 `Definitions` 区分开。
2. **live-only 增量 vs 可回放边界**：V2 会话事件里，`text.delta`/`reasoning.delta`/`tool.input.delta`/`compaction.delta` **不带 durable**（不落盘），而 `text.ended`/`tool.success` 等终态事件才持久化。`packages/schema/src/session-event.ts:209` 的注释一针见血："Stream fragments are live-only; Text.Ended is the replayable full-value boundary."
3. **版本化类型名**：落库类型是 `versionedType(type, version)` 即 `"session.next.step.ended.2"`（`event.ts:94-96`），同一事件多版本可共存，`latest()` 取最新（`event.ts:76-92`）。

### 2.3 订阅/广播：SSE + 断线重放

全局事件流是一个 SSE 端点（`packages/protocol/src/groups/event.ts:33-45`）：

```ts
// packages/protocol/src/groups/event.ts:33-45
group: HttpApiGroup.make("server.event").add(
  HttpApiEndpoint.get("event.subscribe", "/api/event", {
    success: HttpApiSchema.StreamSse({ data: EventSchema }),
  })
)
```

会话级事件流则支持**按序号重放**（`packages/protocol/src/groups/session.ts:327-343`）：

```ts
// packages/protocol/src/groups/session.ts:329-332
HttpApiEndpoint.get("session.events", "/api/session/:sessionID/event", {
  query: { after: ... NonNegativeInt ... optional },
  success: HttpApiSchema.StreamSse({ data: SessionEvent.Durable }),
})
// description: "Replay durable events after an aggregate sequence,
//               then continue with new durable events."
```

即"先回放 `after` 之后的持久事件，再无缝续接实时流"——客户端崩溃重连不丢事件。配套还有有限分页读 `session.history`（`session.ts:306-325`，`hasMore` 显式耗尽信号，页上限 100）。

### 2.4 会话抽象：Session = 聚合根，Message = 投影

`session.prompt` 是整个协议的心脏（`packages/protocol/src/groups/session.ts:205-224`）：

```ts
// packages/protocol/src/groups/session.ts:205-224（节选）
HttpApiEndpoint.post("session.prompt", "/api/session/:sessionID/prompt", {
  payload: Schema.Struct({
    id: SessionMessage.ID.pipe(Schema.optional),
    prompt: PromptInput.Prompt,
    delivery: SessionInput.Delivery.pipe(Schema.optional),
    resume: Schema.Boolean.pipe(Schema.optional),
  }),
  success: Schema.Struct({ data: SessionInput.Admitted }),
  // "Durably admit one session input and schedule agent-loop execution
  //  unless resume is false."
})
```

**"admitted（准入）≠ prompted（可见）"** 是 V2 的核心语义：prompt 先作为 `session.next.prompt.admitted.1` 持久化进收件箱（`packages/schema/src/session-event.ts:94-99`），runner 在安全的 provider-turn 边界把它"晋升"为 `session.next.prompted.1` 并投影为用户消息。`specs/v2/session.md` 对此有完整说明（"session_input is the durable admission inbox"）。客户端 id 幂等：同一 messageID 重放返回同一准入回执。

消息/部件模型（`packages/schema/src/session-message.ts`）：消息是 tagged union（`agent-switched | model-switched | user | synthetic | system | shell | assistant | compaction`，`session-message.ts:200-212`）；assistant 消息的 `content` 是部件数组（text/reasoning/tool 三种，`session-message.ts:159-162`），工具部件的状态机为：

```ts
// packages/schema/src/session-message.ts:116-119
export const ToolState = Schema.Union([
  ToolStatePending, ToolStateRunning, ToolStateCompleted, ToolStateError,
]).pipe(Schema.toTaggedUnion("status"))
```

assistant 消息本体带 `finish`（停止原因）、`cost`、`tokens`（input/output/reasoning/cache.read/cache.write 五维，`session-message.ts:176-183`）、`error`、`time.completed`——**回合的终态语义是协议的一部分**。

### 2.5 服务端实现：EventV2 总线与会话状态

服务器内部的事件总线在 `packages/core/src/event.ts`：

- 接口（`event.ts:126-148`）：`publish`（可带 `commit` 回调做原子投影）、`subscribe(type)`、`all()`、`durable({aggregateID, after})`、`project`（投影器）、`replay/replayAll`（带分歧检测）；
- 内存侧是三张 PubSub（all / typed / durable-per-aggregate，`event.ts:174-178`）；
- 持久侧 `commitDurableEvent`（`event.ts:205-367`）在**一个 SQLite 事务**里完成：读 `EventSequenceTable` 取聚合最新 seq → 调用已注册 projectors → 执行可选 `commit(seq)` 投影 → 写 `EventSequenceTable` 与 `EventTable`。回放时逐条比对（`event.ts:262-302`）：seq 与内容完全一致则幂等跳过，否则抛 `InvalidDurableEventError("Replay diverged…")`。

`packages/opencode/src/event-v2-bridge.ts:35-61` 是发布边界：自动附加 location（directory/project/workspace），并把每个事件转发到 `GlobalBus`——后者只是一个 `EventEmitter`（`packages/opencode/src/bus/global.ts:11-22`），SSE 路由从它订阅。**"进程内 PubSub（精确）+ GlobalBus（广播）+ SQLite（持久）"三层各司其职**。

### 2.6 关键真相：CLI 自己也是 SDK 客户端

`opencode run` 并不是绕过服务器直连引擎，而是**在进程内拉起服务器再用 SDK 客户端驱动**（`packages/opencode/src/cli/cmd/run.ts:948-960`）：

```ts
// packages/opencode/src/cli/cmd/run.ts:948-960（节选）
const fetchFn = (async (input, init) => {
  const { Server } = await import("@/server/server")
  const request = new Request(input, init)
  ...
  return Server.Default().app.fetch(new Request(request, { headers }))
}) as typeof globalThis.fetch
const sdk = createOpencodeClient({ baseUrl: "http://opencode.internal", fetch: fetchFn, directory })
```

`--format json` 的输出就是把 `sdk.event.subscribe()` 的事件流翻译成 JSON 行（`run.ts:678-691` 的 `emit()`，每行带 `type/timestamp/sessionID`）：

- `message.part.updated` + `part.type==="tool"` 且 `state.status` 为 completed/error → `tool_use`（`run.ts:724-732`）；
- `part.type==="step-start"/"step-finish"` → `step_start`/`step_finish`（`run.ts:745-751`）；
- `part.type==="text"` 且 **`part.time?.end` 已置**（即部件已完成）→ `text`（`run.ts:753`）；
- `part.type==="reasoning"` 且 `time.end` 且**传了 `--thinking`** → `reasoning`（`run.ts:766`）；
- `session.error` → `error`；`session.status` idle → 退出循环（`run.ts:781-799`）；
- `permission.asked` → 有 `--auto/--yolo/--dangerously-skip-permissions` 时自动 `reply:"once"`，否则自动 **reject**（`run.ts:801-821`）。

这一节直接解释了 agentdeck 适配器看到的一切，也暴露了它丢掉的一切（见第 7 章）。

---

## 3. Agent 主循环实现

### 3.1 三层结构：runLoop（回合编排）→ processor（流处理）→ llm.stream（provider 调用）

**主循环** `runLoop` 在 `packages/opencode/src/session/prompt.ts:1081-1341`，一个 `while (true)`：

```ts
// packages/opencode/src/session/prompt.ts:1088-1130（骨架节选）
while (true) {
  yield* status.set(sessionID, { type: "busy" })
  let msgs = yield* MessageV2.filterCompactedEffect(sessionID)   // 压缩后的历史
  const { user: lastUser, assistant: lastAssistant, finished, tasks } = MessageV2.latest(msgs)
  // ① 停止条件：上一条 assistant 的 finish 不是 tool-calls/unknown，
  //    且没有未完成的本地工具调用，且 parentID 对应本轮 user
  if (lastAssistant?.finish && !["tool-calls","unknown"].includes(lastAssistant.finish)
      && !hasToolCalls && lastAssistant.parentID === lastUser.id) break
  step++
  // ② 任务部件优先：subtask → TaskTool 子会话；compaction → 压缩流程
  if (task?.type === "subtask") { yield* handleSubtask(...); continue }
  if (task?.type === "compaction") { ...; continue }
  // ③ 上下文溢出 → 自动压缩
  if (lastFinished && (yield* compaction.isOverflow({...}))) {
    yield* compaction.create({ auto: true }); continue }
  // ④ 组装本轮 assistant 消息与工具集，调 processor
  const maxSteps = agent.steps ?? Infinity
  const handle = yield* processor.create({ assistantMessage: msg, sessionID, model })
  const result = yield* handle.process({ user, agent, system, messages, tools, model,
    ...(isLastStep ? [{ role: "assistant", content: MAX_STEPS_PROMPT }] : []) })
  if (result === "stop") break
  if (result === "compact") { yield* compaction.create({ auto: true }) }
  continue
}
```

要点：

- **停止条件是数据驱动的**：不靠"模型说完了"的单一信号，而是检查消息流里最后一条 assistant 的 `finish` 原因 + 是否残留未完成工具部件（`prompt.ts:1106-1130`；还专门容忍"provider 明明有 tool-calls 却报 stop"的情况，并忽略被 cleanup 标记为 interrupted 的孤儿工具，`prompt.ts:1103-1109` 与 `isOrphanedInterruptedTool`，`prompt.ts:96-100`）。
- **步数预算**：`agent.steps ?? Infinity`，最后一步注入 `MAX_STEPS_PROMPT` 强制收尾（`prompt.ts:1178-1181, 1281`）。
- **system prompt 组装**是每轮动态拼的：环境块 + 用户/项目指令 + MCP 说明 + skills（`prompt.ts:1257-1269`）。
- **结构化输出**通过注入一个 `StructuredOutput` 工具实现（`prompt.ts:1243-1250`，工具构造在 `prompt.ts:1565-1591`）——强制 `toolChoice:"required"`，模型调用该工具即回合终结。这与 llm 包的 `generateObject`（见第 4 章）是同一哲学：**统一用工具调用表达结构化输出，规避各家 provider 原生 JSON mode 的差异**。
- 循环外还有收尾：`compaction.prune`（清理旧压缩产物，`prompt.ts:1338`）。

**流处理器** `SessionProcessor`（`packages/opencode/src/session/processor.ts`）把 `LLMEvent` 流翻译成会话部件：

- `handleEvent` 巨型 switch（`processor.ts:278-551`）：`reasoning-start/delta/end`、`text-start/delta/end`、`tool-input-start/delta/end`、`tool-call`、`tool-result`、`tool-error`、`step-start/finish`——每类事件即时 `session.updatePart/updatePartDelta` 落库并触发事件；
- **doom loop 检测**（`processor.ts:29, 353-380`）：连续 3 个同名工具 + 相同输入（`DOOM_LOOP_THRESHOLD = 3`）→ 触发一次 `permission: "doom_loop"` 的审批；
- `step-finish`（`processor.ts:435-498`）：累计 `finish` 原因、`cost`、五维 `tokens`；对 step 起止做**文件快照 diff**（snapshot→patch 部件）；fork 出后台标题/摘要生成；溢出检查置 `needsCompaction`；
- 中断清理 `cleanup`（`processor.ts:553-611`）：把仍在 running 的工具标记为 `error: "Tool execution aborted"` 且 `metadata.interrupted = true`（孤儿标记的来源）；
- `process`（`processor.ts:641-697`）用 Effect 组合子完成重试编排：

```ts
// packages/opencode/src/session/processor.ts:656-695（节选）
yield* stream.pipe(
  Stream.tap((event) => handleEvent(event)),
  Stream.takeUntil(() => ctx.needsCompaction),   // 溢出即截断流
  Stream.runDrain,
).pipe(
  Effect.retry(SessionRetry.policy({ provider, parse, set: (info) =>
    status.set(sessionID, { type: "retry", attempt: info.attempt, ... }) })),
  Effect.catch(halt),
  Effect.ensuring(cleanup()),
)
if (ctx.needsCompaction) return "compact"
if (ctx.blocked || ctx.assistantMessage.error) return "stop"   // 权限拒绝 → blocked
return "continue"
```

**并发与单飞**：`SessionRunState`（`packages/opencode/src/session/run-state.ts:52-94`）给每个 session 一个 `Runner`（busy/idle 单飞闸），`prompt()` 经 `state.ensureRunning` 进入（`prompt.ts:1343-1347`）；`cancel` 会级联取消后台任务（含子会话，`run-state.ts:111-143`）。状态变化发布为事件（`packages/opencode/src/session/status.ts:39-48`：idle 时同时发 `session.status` 与 `session.idle`）。

### 3.2 与 agentdeck runner.ts 的对照

| 维度 | opencode runLoop | agentdeck runner.ts |
|---|---|---|
| 循环体 | 数据驱动 while：读消息流 → 判停止 → 组装 → 流处理（`prompt.ts:1081`） | 任务级单回合：`run(taskId)` 一次性 start→等终态（`runner.ts:559-674`）；多圈循环交给 delegate.ts 的回灌循环与 goal-controller |
| 停止条件 | `finish` 原因 + 工具部件完备性（协议字段） | `BackendTurnResult.ok/error`（`backends/types.ts:26-33`），来源是进程退出码/超时/终态事件 |
| 步数预算 | `agent.steps`，最后一步注入收尾提示（`prompt.ts:1178`） | 无（委派层有 MAX_ROUNDS=6/MAX_TOTAL_ROUNDS=8/MAX_DEPTH=3，`delegate.ts:227-231`） |
| 上下文管理 | 溢出自动压缩 + 压缩事件（`processor.ts:491-497`） | 无——长任务上下文无限增长，靠新会话硬切（`<continue>` 接力） |
| 重试 | 流内 Effect.retry，尊重 `retry-after` 头（`session/retry.ts:47-78`），重试状态作为 session 事件发布 | 任务级 `decideRetry`（`retry-policy.ts:17-27`）：2 次、429 退避 60s、第 2 次换新会话 |
| 超时看门狗 | 无总超时（服务器长驻）；中断是协作式 interrupt | `idleSentinel` 空转看门狗（10 分钟无事件，`runner.ts:56-58, 191-214`）——这是 agentdeck 针对"不可信 CLI 进程"的必要防御，opencode 因架构不同不需要 |
| 失败分类 | `SessionV1.ContextOverflowError`、`APIError(statusCode/headers/body)`、`ContentFilterError` | `classifyFailure`（failure.ts）按错误文本分类 |

agentdeck 的 runner 本质是"**进程外** agent 的回合管理器"，opencode 的 runLoop 是"**进程内** agent 的步骤管理器"——前者管生命周期，后者管推理循环。二者互补而非同构；agentdeck 不需要重写 runLoop，但**回合终态语义（finish 原因、tokens、blocked）值得抄进 `BackendTurnResult`**。

---

## 4. Provider/模型抽象（llm 包）

### 4.1 Route：四轴正交组合

`packages/llm/src/route/client.ts:303-339` 的注释给出了官方口径：一条 Route = **Protocol（说什么 API）× Endpoint（发到哪）× Auth（怎么认证）× Framing（字节流怎么切帧）**：

```ts
// packages/llm/src/route/client.ts:36-53（Route 接口节选）
export interface Route<Body, Prepared = unknown> {
  readonly id: string
  readonly provider?: ProviderID
  readonly protocol: ProtocolID
  readonly endpoint: Endpoint<Body>
  readonly auth: AuthDef
  readonly transport: Transport<Body, Prepared, unknown>
  readonly body: RouteBody<Body>   // schema + from(LLMRequest) -> provider 原生 body
  readonly streamPrepared: (prepared, request, runtime) => Stream.Stream<LLMEvent, LLMError>
}
```

协议实现（`packages/llm/src/protocols/`）：`anthropic-messages`、`openai-chat`、`openai-responses`、`openai-compatible-chat`、`gemini`、`bedrock-converse`、`bedrock-event-stream`。Provider 门面（`packages/llm/src/providers/`）：anthropic、openai、openai-compatible、azure、google、amazon-bedrock、cloudflare、github-copilot、openrouter、xai——每个都是几十行的 `route.with({...})` 补丁（换 baseURL/auth/headers）。**新增一家 OpenAI 兼容厂商 = 一个 30 行的 provider 文件，不碰协议代码。**

`compile` 是关键边界（`client.ts:341-359`）：公共 `LLMRequest` → 校验过的 provider 原生 body + transport 私有 prepared 数据，**不执行**。`generate` 只是流的折叠：`stream(request).pipe(Stream.runFold(LLMResponse.empty, LLMResponse.reduce))`（`client.ts:382-391`）。

### 4.2 归一化事件：LLMEvent

`packages/schema`→`packages/llm/src/schema/events.ts:209-226` 定义了 16 种归一化流事件（tagged union）：`step-start | text-start/delta/end | reasoning-start/delta/end | tool-input-start/delta/end | tool-call | tool-result | tool-error | step-finish | finish | provider-error`。每个事件都带可选 `providerMetadata`（原始 provider 载荷逃生舱）。

Usage 的设计文档值得整段引用（`events.ts:8-49`）：**inclusive totals（对齐 OpenAI/AI SDK 习惯）+ non-overlapping breakdown（每字段独立有意义，消费者永不需要做减法）**，并显式记录各家语义（Anthropic 原生给 breakdown，OpenAI/Gemini 给 inclusive 总量由 mapper 反推）。这消除了"clamped difference 存错值"这一类 bug。

结构化输出 `generateObject`（`packages/llm/src/llm.ts:146-186`）：强制注入名为 `generate_object` 的合成工具 + `toolChoice: named`，**刻意不用 provider 原生 JSON mode 以保证跨协议行为一致**。

### 4.3 双运行时缝合

opencode 核心里 LLM 调用有两条路径（`packages/opencode/src/session/llm.ts`）：

- 默认：Vercel **AI SDK** `streamText`（`llm.ts:276-354`），随后 `LLMAISDK.toLLMEvents` 把 fullStream 归一为 LLMEvent（`llm.ts:370-378`）；
- 实验：`flags.experimentalNativeLlm` 时走 `LLMNativeRuntime.stream`（`@opencode-ai/llm` 路由直连），不支持则回退并记录原因（`llm.ts:226-269`）。

两条路径共享同一 `StreamInput`（`llm.ts:35-48`：user/sessionID/model/agent/permission/system/messages/tools/toolChoice）。还有两个工程细节：`experimental_repairToolCall` 修复大小写错误的工具名（`llm.ts:296-311`）；GitLab workflow 模型的 `toolExecutor`/`approvalHandler` 桥接（`llm.ts:119-206`）把服务端工作流工具执行拉回本地工具系统并接入权限审批。

**对 agentdeck 的启示**：agentdeck 的预设（presets，`shared/contracts.ts:32-39` 的 baseURL/apiKey 注入）相当于 opencode 的 provider credentials + custom provider；但 agentdeck 没有自己的 LLM 层（也不需要有——它的后端都是完整 agent）。真正可借鉴的是**事件归一化层**：agentdeck 各 CLI 后端各自手写解析（opencode.ts 的 tool_use/text 映射只是其中一个），`LLMEvent` 这种"归一事件 + providerMetadata 逃生舱"正是 `backends/types.ts` 里 `TaskEvent` 应该长成的样子。

---

## 5. 权限/审批系统

### 5.1 规则模型与求值

权限 = 规则数组，每条 `{ permission, pattern, action: "allow"|"deny"|"ask" }`（`packages/schema/src/v1/permission.ts:16-25`）。求值用**最后匹配优先** + 通配符：

```ts
// packages/opencode/src/permission/index.ts:28-38
export function evaluate(permission: string, pattern: string, ...rulesets: PermissionV1.Ruleset[]) {
  return (
    rulesets.flat()
      .findLast((rule) => Wildcard.match(permission, rule.permission)
                         && Wildcard.match(pattern, rule.pattern))
    ?? { action: "ask", permission, pattern: "*" }   // 默认 ask
  )
}
```

规则来源分层合并：agent 内置默认（`packages/opencode/src/agent/agent.ts:119-136`：`doom_loop: ask`、`question: deny`、`read: {"*.env": "ask"}` 等）→ 命令行/会话注入 → 用户 config（支持 `~`/`$HOME` 展开，`permission/index.ts:178-198`）。

### 5.2 ask/reply：Deferred + 事件 + 级联

`ask`（`permission/index.ts:67-107`）：对每个 pattern 求值——deny 立即抛 `DeniedError`；全 allow 直接过；否则发布 `permission.asked` 事件并 `Deferred.await`（Effect 的 Promise 等价物）挂起工具执行。**审批等待是进程内挂起，不是轮询。**

`reply`（`permission/index.ts:109-167`）三值语义，两个精妙设计：

1. **reject 级联**：拒绝一个请求 = 同 session 的所有 pending 请求一并拒绝（`index.ts:129-139`）——用户说"停"，整个回合停；且 `reply:"reject" + message` 会抛 `CorrectedError`（带反馈），失败工具的输出把反馈文本喂回模型（`processor.ts:200-202` 将其置 `ctx.blocked`）。
2. **always 自动收编**：`reply:"always"` 把 pattern 写入内存 approved 规则后，**重估同 session 其它 pending 请求，全部命中的自动放行**（`index.ts:145-166`）——一次审批解决一串同类请求。

权限还反向决定**工具可见性**：`disabled/visibleTools`（`permission/index.ts:204-219`）把 `deny pattern="*"` 的工具直接从模型工具清单里移除（edit/write/read 归并处理）。

HTTP 面（`packages/protocol/src/groups/permission.ts`）：`GET /api/permission/request`（列 pending）、`POST /api/session/:id/permission`（创建/求值）、`POST /api/session/:id/permission/:requestID/reply`（应答）。

### 5.3 对照 agentdeck permission-broker

agentdeck 的 `PermissionBroker`（`src/main/permission-broker.ts:6-57`）是"requestId → Promise + 5 分钟超时自动 deny"的单点仲裁，`PermissionRequest`（`shared/contracts.ts:3-10`）有 options 数组但决策只有 allow/deny 两值。

差距与可借鉴：

- **三值应答**（once/always/reject+feedback）：agentdeck 的 `respondPermission(requestId, optionId, decision)`（`contracts.ts:119`）协议上支持 optionId 但语义未定义；opencode 的 always-自动收编 + reject-带反馈直接可以搬；
- **规则求值前置**：agentdeck 的权限完全依赖各后端自己的机制（opencode 后端干脆 `--dangerously-skip-permissions` 跳过）；opencode 的 `evaluate()`（15 行）+ 规则合并是 agentdeck 在编排层做统一权限闸的现成蓝本；
- **doom_loop 作为一种权限**：把"循环检测"建模成权限请求（`processor.ts:372-379`），人工批准后放行——比 agentdeck 的硬编码上限（委派预算闸）更柔软，且留痕。

---

## 6. Plugin 体系与 SDK

### 6.1 插件 = 一个返回 Hooks 的函数

`packages/plugin/src/index.ts:74`：`export type Plugin = (input: PluginInput, options?) => Promise<Hooks>`。PluginInput（`index.ts:56-66`）给插件：SDK client、project、directory、worktree、serverUrl、`$`（Bun shell）。钩子面（`index.ts:222-335`）按拦截点分类：

- **输入/输出**：`chat.message`（消息落库前）、`experimental.chat.messages.transform`（发给模型前的历史改写）、`experimental.chat.system.transform`（系统提示改写）、`experimental.text.complete`（文本部件完成时）；
- **参数**：`chat.params`（temperature/topP/maxOutputTokens）、`chat.headers`（自定义请求头）；
- **工具**：`tool`（注册自定义工具）、`tool.definition`（改写给模型的工具描述/参数）、`tool.execute.before/after`（执行前后拦截）；
- **权限**：`permission.ask`（改写审批结论）；
- **环境**：`shell.env`（注入子进程环境变量）、`config`、`auth`（自定义 provider 登录流）、`provider`（动态模型列表）；
- **压缩**：`experimental.session.compacting`（自定义压缩提示）、`experimental.compaction.autocontinue`；
- **兜底**：`event`（全事件流订阅）。

注意钩子签名统一是 `(input, output) => Promise<void>`——**插件就地 mutate output**，无返回值链。这是简单但高效的"参数改写器"模式，比责任链便宜。

### 6.2 SDK 与 sdks/

- `packages/sdk/js`：由 `packages/sdk/openapi.json` 生成的 TypeScript 客户端（`gen/`），`createOpencodeClient`（`packages/sdk/js/src/client.ts:38-53`）支持注入自定义 `fetch` 与 `directory`（自动加 `x-opencode-directory` 头）；`createOpencode()`（`index.ts:9-21`）一步拉起本地 server + client——**嵌入式使用的一等入口**。
- `packages/client`：Effect 原生客户端（直接复用 protocol 的 HttpApi 定义，`packages/client/src/contract.ts:17-19`），供 Effect 应用内用；
- `sdks/vscode`：VSCode 扩展工程（独立 lockfile）。

---

## 7. 与 agentdeck 的对照与可借鉴点（最重要章节）

### 7.1 agentdeck 的 opencode.ts 适配器用了协议的哪些部分、漏掉了什么

`src/main/backends/opencode.ts` 的用法（全部事实）：

- 调用形态：`opencode run --format json --dangerously-skip-permissions [--model M] --dir W [-s session] <prompt>`（`opencode.ts:24-32`），一次性进程，回合结束 = 进程退出（`opencode.ts:94-104`）；
- 消费的事件：`sessionID`（`:59-63`）、`tool_use`（state running/pending → started，否则 result，`:65-73`）、`text`（按 part.id 做增量去重，`:74-89`）；
- 续聊：`-s sessionId` 重启进程（`:117-126`）；停止 = kill 进程（`:128-133`）。

对照第 2.6 节 CLI 的事件翻译表，**逐条列出漏掉的能力**：

| # | 漏掉的协议能力 | 依据（opencode 源码） | 对 agentdeck 的价值 |
|---|---|---|---|
| 1 | **权限审批流**。`--dangerously-skip-permissions` 使 CLI 对一切 `permission.asked` 自动 `reply:"once"`（`run.ts:274, 801-810`）；若去掉该 flag，非交互模式自动 **reject**（`run.ts:810-820`）——agentdeck 的 PermissionBroker 在两种模式下都接不上 | `run.ts:801-821`；HTTP 面 `protocol/groups/permission.ts:118-136` | agentdeck 已有 UI 审批管道（`task:permission`），却对 opencode 后端完全旁路。改走 server 模式即可把 `permission.asked/replied` 接入 broker |
| 2 | **reasoning 流**。CLI 只在传 `--thinking` 时输出 reasoning 部件（`run.ts:766`），适配器没传 | `run.ts:766-778` | 思考过程可见性；一行 flag 的成本 |
| 3 | **step_finish 的 tokens/cost**。适配器完全忽略 step_start/step_finish 行（只当 heartbeat）；`usage.ts` 聚合因此对 opencode 后端无数据 | `run.ts:745-751`；部件 schema 带 `tokens/cost`（`prompt.ts:460-469` 落 part） | agentdeck 的 analytics/usage 对 opencode 是盲区 |
| 4 | **真流式增量**。CLI json 模式的 `text` 事件只在 `part.time?.end`（部件完成）时发出（`run.ts:753`）；token 级增量只存在于 `message.part.delta` 事件（`schema/src/v1/session.ts:632-641`），CLI 不透出 | `run.ts:753`；`v1/session.ts:632` | agentdeck 的"text 事件流式展示"在 opencode 后端实际是**部件级**粒度；适配器里的增量去重（`opencode.ts:35-37` 注释）是在补协议的缺 |
| 5 | **error 事件正文**。`session.error` 行被适配器忽略，失败只剩退出码 + stderr 尾巴（`opencode.ts:94-104`） | `run.ts:781-791` | 失败分类（failure.ts）拿不到 provider 错误正文（statusCode/headers），重试决策降级为文本猜测 |
| 6 | **interrupt vs kill**。协议有 `POST /session/:id/interrupt`（协作式中断：finalize assistant、孤儿工具标记、状态回 idle，`processor.ts:553-611`）；适配器只能 kill 进程 | `protocol/groups/session.ts:344-358` | kill 会丢"中断边界"，续聊时上下文里有未完成的工具调用 |
| 7 | **会话恢复面**。`session.list/get/fork`、`session.events?after=seq` 重放、`session.wait`、`session.context`（压缩后活跃上下文）全部可用而未用 | `protocol/groups/session.ts:109-171, 240-254, 291-343` | agentdeck 重启恢复现在只靠存 sessionId（`runner.ts:783-839` resume 路径）；fork 可与 agentdeck 的 worktree 并行试验组合 |
| 8 | **压缩（compaction）**。溢出自动压缩是引擎内建（`prompt.ts:1161-1168`）；CLI 一次性进程里长任务直接顶到上下文上限报错 | `processor.ts:491-497`；`specs/v2/session.md` | agentdeck 长循环 goal 任务最需要的能力 |
| 9 | **agent 选择与 variant**。`--agent`（plan/build/subagent…）、`--variant`（推理力度档位）、`--command`（slash 命令）、`--fork` 均未用 | `run.ts:166-260` | agentdeck 的 mode（`backends/types.ts:48`）传了但 CLI 没映射到 `--agent`；plan 模式等于免费获得 |
| 10 | **结构化输出**。`format: json_schema` prompt 输入 + StructuredOutput 工具（`prompt.ts:1243-1250`） | `prompt.ts:74-82, 1565-1591` | goal-controller 的 checkpoint 解析（`goal-controller.ts:54-82` 用正则/JSON 试探）可用协议级结构化输出替代 |
| 11 | **原生子代理（TaskTool）**。工具级委派：子会话 parentID、深度闸 `subagent_depth`、background 模式、权限继承派生 | `tool/task.ts:104-172`；`prompt.ts:255-449` handleSubtask | 见 7.3-③ |
| 12 | **常驻 server 模式本身**。`opencode serve` + `createOpencode()`（嵌入式 server+client，`packages/sdk/js/src/index.ts:9-21`） | `sdk/js/src/index.ts` | 见 7.3-① |

### 7.2 对 agentdeck 自有协议（backends/types.ts、shared/contracts.ts）的启示

**(a) 回合终态是一等契约**。opencode 把 `finish` 原因（stop/tool-calls/error/content-filter/length…）、五维 tokens、cost、error 全部放进消息 schema（`schema/src/session-message.ts:164-189`）；agentdeck 的 `BackendTurnResult`（`backends/types.ts:26-33`）只有 `response/ok/error/tokenCount?/durationMs?`。建议扩为：

```ts
interface BackendTurnResult {
  response: string
  ok: boolean
  error?: string
  finishReason?: 'stop' | 'tool-calls' | 'length' | 'content-filter' | 'error' | 'aborted' | 'unknown'
  tokens?: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
  cost?: number
  durationMs?: number
  delegationText?: string
}
```

这使得 retry-policy 能按 `finishReason` 而非错误文本分类，analytics 有真实用量，UI 能区分"被内容过滤截断"与"正常收尾"（opencode 专门把 content-filter finish 升级为错误，`prompt.ts:1295-1308`）。

**(b) 事件 = 全量快照 or 增量，二选一要显式**。opencode 有两条正交通道：`message.part.updated`（全量快照）与 `message.part.delta`（增量，live-only 不落盘，`v1/session.ts:612-641`）。agentdeck 的 `TaskEvent` 只有 text 增量一种，适配器被迫自己发明"快照去重"（`opencode.ts:35-37, 79-88`）。在 `shared/types.ts` 的 TaskEvent 里显式定义 `part_updated`（快照）与 `part_delta`（增量）两种，或至少在协议注释里声明"text 事件一律为增量、由后端负责去重"，能消灭每个新后端重复发明的去重逻辑（zcode/claude/codex 适配器各有各的补丁）。

**(c) 事件持久化要带版本号**。`define()` 的 `durable: {aggregate, version}`（`schema/src/event.ts:15-25`）+ 落库时 `versionedType`（`event.ts:94-96`）+ `specs/v2/schema-changelog.md` 的变更日志纪律，使事件 schema 可以演化而旧记录可解码。agentdeck 的 `event-log.ts` 是无版本 JSONL；一旦 TaskEvent 加字段，`rewind`（truncate + 重放）语义就悬空。最小改动：给 TaskEvent 加可选 `v` 字段并在 append 时写入。

**(d) 订阅契约要含"重放游标"**。`session.events?after=seq` 的"先回放后续接"（`protocol/groups/session.ts:327-343`）对应 agentdeck 的 `tasks.events(id, afterSeq)`（`contracts.ts:103`）——已经同构，值得保持；但 agentdeck 缺推送通道上的对应物（渲染进程靠 IPC `task:event` 推送，无重连语义）。若未来 renderer 崩溃重连，opencode 的模式是答案。

**(e) 权限请求要带"规则指纹"**。opencode 的 Request 带 `permission/patterns/always/metadata.tool`（`v1/permission.ts:27-36`），应答三值 + 反馈。agentdeck 的 `PermissionRequest`（`contracts.ts:3-10`）已有 options 雏形，补上 `always` 语义与 reject-feedback 即可对齐（详见第 5 章）。

### 7.3 哪些设计可直接搬进 agentdeck

**① 把 opencode 适配器升级为 server 模式（最大单项收益）**。用 `createOpencode()`（`packages/sdk/js/src/index.ts:9-21`）或 `opencode serve --port` 长驻进程 + HTTP/SSE，替代一次性 CLI：

- `session.prompt` 发消息、`session.events` SSE 收流（真增量 + 断线重放）、`session.interrupt` 协作式中断、`permission.asked → broker → permission.reply` 接回审批、`session.fork` 配合 worktree；
- 会话跨回合常驻，消灭"每回合重启进程 + `-s` 重放历史"的冷启动成本；
- 实现上仍是 `AgentBackend` 接口（`backends/types.ts:35-66`）：`start` = ensureServer + createSession + subscribe；`send` = prompt；`stop` = interrupt；`close` = 按引用计数决定是否关 server。风险：server 生命周期管理与版本探测（`probe` 需查 `opencode --version` 与 SDK 兼容性）。这是渐进式改造：保留 CLI 模式作 fallback。

**② doom loop 检测器（约 30 行，立刻可搬）**。`processor.ts:353-380`：滑窗取最近 N=3 个工具部件，同名 + 同输入（JSON 序列化比较）连击 → 触发人工审批（或 agentdeck 语境下：自动暂停任务 + 发通知）。放进 `runner.ts` 的事件管道（`makeEvents.onEvent` 里对 `tool` 事件计数）即可，与现有委派预算闸互补。

**③ 委派的"工具化"路线图**。agentdeck 的 `<delegate>` 文本标记协议（`delegate.ts:26-37` 解析）对任意后端通用，但有解析歧义成本（正则容错、多源去重 `parseDelegatesMerged`、幻影吞单防御，`delegate.ts:23-25` 注释）。opencode 证明委派可以建模为**工具调用**（TaskTool，`tool/task.ts:81`）：模型输出结构化参数而非文本标记，运行时创建子会话（`parentID`，`task.ts:156-172`）。agentdeck 的 zcode/claude 后端若原生支持 subagent 工具，可在 `AgentBackend` 上加可选能力位 `nativeDelegation?: boolean`：有则用工具通道（无解析），无则回落文本标记。**文本标记协议保留为最小公分母，工具通道作为能力升级**——这正是 agentdeck 多后端架构的正确演进方向。

**④ 重试策略的细节**。`session/retry.ts` 三件套直接搬进 `retry-policy.ts`：(a) `retry-after-ms`/`retry-after`（秒数与 HTTP 日期两种格式）头解析（`retry.ts:47-78`）；(b) 指数退避 + 25% 抖动、初始 2s、上限 30s（无头时）/2^31-1（有头时）（`retry.ts:26-31, 80-83`）；(c) 不可重试清单显式化（context overflow 永不重试，`retry.ts:87`）。agentdeck 目前只有"429 → 60s"一条规则（`retry-policy.ts:24-25`）。

**⑤ Usage 记账的"inclusive + breakdown"双轨**。`llm/src/schema/events.ts:51-74` 的 Usage 类：总量字段对齐生态习惯、细分字段独立存储不做减法、`providerMetadata` 保留原始载荷。agentdeck 的 `usage.ts` 聚合若采用此形状，未来接入任何后端的用量口径都不会打架。

**⑥ 事件清单（manifest）作为单一事实源**。`packages/schema/src/event-manifest.ts` 把"服务器对外暴露哪些事件"（ServerDefinitions）与"内部全部事件"分开，并以此**生成**协议 SSE 的 schema union（`protocol/groups/event.ts:15-27`）。agentdeck 的 TaskEvent kinds 定义在 `shared/types.ts`，若抽成显式清单并让 IPC 校验（ipc-validation.ts）从清单生成，前后端契约漂移会在编译期暴露。

---

## 8. 结论

**架构评价**。opencode 是目前把"编码 Agent 服务器化"做得最彻底的开源实现：协议三层（schema 数据契约 / protocol HTTP 契约 / sdk 生成客户端）单向依赖、事件溯源 + 每聚合单调 seq + 版本化 schema、准入/晋升两段式 prompt 语义、live-only 增量与 durable 终态的分界、权限三值应答与级联、Route 四轴 provider 抽象——每一处都在为"多客户端（CLI/TUI/Web/桌面/IDE）+ 崩溃恢复 + 协议演化"服务。CLI 本身只是 SDK 客户端的事实（`run.ts:948-960`）保证了协议没有" privileged caller"，这是它能长出庞大生态（vscode 扩展、桌面端、web 端）的根本原因。工程纪律同样突出：`specs/v2/schema-changelog.md` 式的持久化契约变更日志、Effect Schema 全链路校验、http-recorder 的确定性回放测试。

**风险与代价**：

1. **Effect 依赖的深度绑定**。全仓库建在 effect（unstable httpapi）之上：Layer/Service/PubSub/Deferred 的心智成本高，`effect/unstable/*` 的 API 在本仓库代码里随处可见（如 `protocol/src/api.ts:2`），跟随上游 breaking change 的维护压力真实存在。agentdeck 若只借鉴**协议形状**而不引入 Effect 运行时，是收益/成本比最高的路径。
2. **V1/V2 双轨的复杂度**。session-message（V1 投影）与 session-event（V2 事件）并存，`EventV2Bridge`/`LegacyEvent`/shadow bridge（`event-v2-bridge.ts`、`schema/src/legacy-event.ts`、`specs/v2/schema-changelog.md` 里反复出现的"Reset experimental V2 events"）表明迁移仍在进行、且实验性事件历史多次整体重置。跟随其 HEAD 的消费者要有契约抖动预期。
3. **一次性 CLI 模式是二等公民**。agentdeck 现在依赖的 `--format json` 输出是 CLI 客户端视图的副产物：无 token 级增量（`run.ts:753`）、reasoning 默认关闭（`run.ts:766`）、权限只能全放行或全拒绝（`run.ts:801-821`）、错误正文丢失。**这不是 opencode 协议的缺陷，而是 agentdeck 适配层选了最薄的接入点。**
4. 对 agentdeck 最直接的行动项排序：**(1)** 适配器去掉 `--dangerously-skip-permissions`、补 `--thinking` 与 step_finish/error 事件解析（小改，立刻回血审批与用量）；**(2)** 扩 `BackendTurnResult` 终态契约；**(3)** 规划 server 模式适配器（`createOpencode` 嵌入式或 `opencode serve`），把 interrupt/compaction/fork/权限审批全部接通；**(4)** 搬 doom-loop 检测与 retry 细节。前三项分别对应 Loop Engineering 的 Loop 1 观测性、协议层与 Loop 2/3（长循环、无人值守）能力——与 `docs/LOOP-ENGINEERING.md` 中"agentdeck 拆解重点：状态脊柱健壮性、委派/验证链路、多后端协议适配"的判断完全吻合。

---

### 附：本报告直接引用的核心源码文件

- 协议层：`packages/protocol/src/api.ts`、`groups/{event,session,permission}.ts`；`packages/schema/src/{event,event-manifest,session-message,session-event}.ts`、`v1/{session,permission}.ts`
- 引擎：`packages/opencode/src/session/{prompt,processor,llm,retry,run-state,status}.ts`、`permission/index.ts`、`event-v2-bridge.ts`、`bus/global.ts`、`agent/agent.ts`、`tool/task.ts`、`server/server.ts`、`cli/cmd/run.ts`
- LLM：`packages/llm/src/{llm.ts,route/client.ts,schema/events.ts}`
- 总线：`packages/core/src/event.ts`
- 插件/SDK：`packages/plugin/src/index.ts`、`packages/sdk/js/src/{client,index}.ts`、`packages/client/src/contract.ts`
- 规格：`specs/project.md`、`specs/v2/{session.md,schema-changelog.md}`
