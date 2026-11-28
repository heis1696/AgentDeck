# MCP 委派与 AgentDeck 平台认知升级方案

> 分支：`feat/mcp-delegation`（基于 `main` `8fbabd3`）  
> 目标：把 AgentDeck 的「平台托管认知」与「多 Agent 协作委派协议」从纯首条消息 XML 标记升级为 **Host Framing（系统级认知 + 防压缩锚点）+ 按会话隔离的轻量 Streamable HTTP MCP**，在不阉割底层 CLI 原生能力的前提下，解决原生提示词/工具冲突、自动上下文压缩失忆、以及 XML 正则解析脆弱性。

---

## 1. 背景与核心问题

1. **宿主认知冲突**：各 CLI（Claude Code、Codex、ZCode 等）都自带极强的原生系统提示与子代理工具（如 Codex 默认在 `developer` 层注入 `<multi_agent_role>` 声明自己是 `/root` 领队，Claude Code 自带 `Agent` 工具）。此前 AgentDeck 把角色、队员名单与委派协议全部塞在首条用户消息中，既在指令层级上吃亏，又未向所有任务清晰声明「你正在 AgentDeck 协作派单平台托管的隔离任务中运行」。
2. **自动上下文压缩失忆**：长任务或多轮委派触发 CLI 自动压缩时，首条用户消息最先被压缩摘要，导致 Agent 定位、队员名册与 `<delegate>` / `<review>` / `<continue>` 精确语法丢失。
3. **文本 XML 解析复杂度与事后拒单成本**：正文混排 XML 需要大量防复述指纹、哨兵正则、残缺开标记检出与 `escapeProtocolLiterals` 序列破坏转义；且领队写错队员名或触碰护栏要等回合结束才回灌，白烧一整轮。

---

## 2. Step 0 实测能力矩阵（三大主力全原生支持会话级 HTTP MCP）

| 后端 | 会话级 MCP 注入（均原生 Streamable HTTP + Bearer 鉴权） | 原生 System / Developer Prompt 层（免疫自动压缩） |
|---|---|---|
| `claude` | `--mcp-config <tmpJson>`（`type: "http"`, `url`, `headers.Authorization`），不加 `--strict-mcp-config` 保留用户自身 MCP | `--append-system-prompt-file <tmpFile>`（新建 & `--resume` 均支持） |
| `codex` | `-c mcp_servers.agentdeck.url="…"` + `-c mcp_servers.agentdeck.bearer_token_env_var="AGENTDECK_MCP_TOKEN"` + 子进程 env | `-c developer_instructions="…"`（新建 & `exec resume` 均支持，实测直入 `role: "developer"` 与原生 `<multi_agent_role>` 平级） |
| `zcode` | `session/create` 与 `session/resume` 原生参数 `mcpServers: [{ name: "agentdeck", type: "http", url, headers, isolation: "session", alwaysLoad: true }]` | 无 `session/create` 级 `systemPrompt` 参数，走 MCP 标准 `initialize.instructions` + 回灌锚点 |
| `opencode` / `dsh` / `agy` | 保持 `delegationTransport: 'prompt'` 兜底（`dsh-acp` `session/new` 原生支持 `mcpServers`，后续可平滑补接） | `dsh-acp` 并入 `persona`；其余走首条 Host Framing + 每轮回灌锚点 |

逃生开关：环境变量 `AGENTDECK_DELEGATION_TRANSPORT=prompt` 可一键强制全部后端回退 Prompt 协议。

---

## 3. 架构设计

### 3.1 认知层（Host Framing + System Prompt 分层 + 防压缩锚点）

- 新增纯文案模块 `src/main/prompts/host.ts`（不 import electron）：
  - `buildHostFraming(input)`：覆盖 `leader` / `worker` / `solo` / `office` 四种角色与工作区契约（独占隔离 worktree / 共享只读 / 主目录），明确**原生工具与子代理照常全力使用（用于单兵深挖），AgentDeck 协作能力负责跨角色/跨后端/隔离工作区的团队派单与交付**。
  - `buildTurnAnchor(input)`：3 行轻量防压缩状态锚点，附在每轮回灌末尾（不破坏 `REPORT_PROMPT_HEADER` 与 `【下一步】` 之前的可控段断言），确保任意后端压缩后立即重对齐身份、名单与剩余预算。
  - MCP 模式专用瘦身提示与回灌模板（`buildMcpReportFeedback`、`buildMcpBudgetTailFeedback`、`buildMcpHandoffCue`），彻底卸掉 XML 语法墙。
- 既有 Prompt 协议函数（`buildDelegationBlock`、`CONTINUE_BLOCK`、`buildReportFeedback` 等）**保持完整与零回归**，作为 Prompt 兜底通道。

### 3.2 协议层：纯 Node 零依赖 Per-Run MCP Server（`src/main/mcp-delegation-server.ts`）

- 遵循主进程热更链路零运行时 npm 依赖约束，基于 `node:http` + `node:crypto` 实现极简 MCP Streamable HTTP（JSON-RPC 2.0：`initialize`、`notifications/initialized`、`ping`、`tools/list`、`tools/call`）。
- 绑定 `127.0.0.1:0`（OS 临时回环端口），由 `TaskRunner` 惰性拉起（首个 MCP 任务启动时监听，无 MCP 任务零端口占用），在 `TaskRunner.shutdown()` 统一关闭。
- 每个 Run 签发 32 字节随机 `Bearer` Token；Run 结束或换手立即吊销，杜绝跨任务越权与延迟回调污染。
- 握手 `initialize.instructions` 返回当前 Run 的 `HostFraming`，使所有 MCP 客户端（含 `zcode`）获得免疫压缩的宿主说明。

### 3.3 动态工具集（全部短平快同步返回，严禁阻塞等子任务）

| 工具名 | 暴露条件 | 职责与即时校验 |
|---|---|---|
| `agentdeck_context` | 所有 MCP 任务 | 返回当前角色定位、任务目标、工作区契约、团队名单、剩余预算、本轮可审核单号——压缩后随时自恢复 |
| `agentdeck_dispatch_worker` | 非办公室、非调查、有直属队员、未暂停建单且有预算 | `to` 为当前直属队员动态 `enum`（描述附 backend/角色/专长/只读标注）；当场调用 `spawnDelegateChild` 做目标/防环/层级/预算校验并异步建单入队；合法即返回 `{ accepted: true, childTaskId, nextStep }`（提示派完本批结束回复，勿轮询）；非法即返回 `isError: true` + 具体拒因与有效名单（回合内当场改派） |
| `agentdeck_submit_review` | 领队存在待审核子单时 | `{ seq, verdict: "pass"\|"fail", note? }`，立即落看板审核态并登记本轮已审 |
| `agentdeck_read_report` | 领队存在子单报告时 | `{ seq, offset?, limit? }`，分页读取超回灌界子单报告全文（不依赖 worktree 文件路径） |
| `agentdeck_record_round` | 领队 | `{ outcome: "action"\|"no_action"\|"failed", reason }`，立即落时间线评估事件 |
| `agentdeck_consult_captain` | 非办公室且有可咨询队长 | `to` 为可咨询队长动态 `enum`，校验后入本轮咨询队列，回合末由 `completeConsults` 执行并回灌 |
| `agentdeck_investigate` | 非办公室领队，或办公室 `meetingTurn === true` 领队 | `to` 为直属队员动态 `enum`，校验后入本轮调查队列，回合末由 `completeInvestigates` 执行并回灌；非会议回合直接从 `tools/list` 隐身 |
| `agentdeck_handoff_phase` | 非子任务、非办公室、有 `issueId` | `{ start: "auto"\|"parked", brief, thinking? }`，当场校验重复阶段与接力链上限，登记后由 `handleContinue` 落盘 |

### 3.4 与既有编排内核接驳（零状态机复制）

- `DelegateLedger` 增加 `recordExternalSpawn(taskId, call, childId)`：MCP 通道通过 `agentdeck_dispatch_worker` 建出的子单直接写入同一套 `earlySpawns` + `seenKeys` 台账。
- `runDelegationLoop`、`collectBudgetTail`、`abandonEarlySpawns` 零复制复用：MCP 建出的子单自动进入等待终态 → `commitAllDetailed` → 全文双落 → 可选 summary 轮 → 提前归池 → 回灌汇报 → 集成合入 → 续链换基线 → 重启对账全套链路。
- 同步经 MCP 返回给领队的拒单立即确认送达（`acknowledge`），避免回合末重复打扰。
- ZCode 非 yolo 模式下，`permission` 回调自动放行 `agentdeck` 内部协作工具（`mcp__agentdeck__*` / `agentdeck_*`）。

---

## 4. 实施阶段与验证门

1. **Phase 1（认知层）**：新增 `src/main/prompts/host.ts`、扩展 `backends/types.ts` 能力位与 `systemPrompt` / `mcpEndpoint` 选项、接入 `runner.ts` 首条与回灌锚点。
2. **Phase 2（MCP Server）**：新增 `src/main/mcp-delegation-server.ts`（纯 Node Streamable HTTP + 动态工具集 + Per-Run Token 隔离与动作台账）。
3. **Phase 3（编排接驳与三大主力适配）**：`DelegateLedger` / `delegate.ts` / `runner.ts` 接驳 MCP 通道；`claude.ts`、`codex.ts`、`zcode.ts` 接入 `mcpEndpoint` 与 `systemPrompt`（`dsh-acp.ts` 顺带并入 `persona`）。
4. **Phase 4（验证门）**：新增 `scripts/smoke-mcp-delegation.mjs`（并在 `package.json` 注册 `smoke:mcp-delegation`）；通过 `npm run typecheck`、`npm run build`、`npm run check:architecture`、`npm run smoke:stage6`、`npm run smoke:prompts`、`npm run smoke:delegate`、`npm run smoke:delegate-reject`、`npm run smoke:continue`、`npm run smoke`、`npm run smoke:zcode`、`npm run smoke:mcp-delegation`。
