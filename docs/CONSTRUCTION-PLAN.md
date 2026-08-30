# AgentDeck 施工方案（v0.4.x – v0.6.x）

> 依据：《AGENTDECK-ANALYSIS.md》§4.2 缺口排序 + §5 风险表 + §6 演进路线；对标《MULTICA-TEARDOWN.md》§8 借鉴清单
> 原则：① 保持"个人本地"边界，不引入 Multica 的服务器端复杂度；② 零新增重依赖（不引 UI 库/状态库，diff 高亮手写）；③ 每阶段独立可验收、可封板、可发版；④ 每阶段结束跑全量 smoke + typecheck。

---

## 总览

| 阶段 | 内容 | 主要动点 | 规模 | 版本 |
|---|---|---|---|---|
| P0 | 清债净化：删双轨 squad + 三个小修 | squad.ts / runner / types / store / index | ~400 行删改 | 0.4.0 |
| P1 | 失败分类学 | 新 failure.ts + Task.failure + UI banner | ~150 行 | 0.4.0 |
| P2 | 用量汇总（任务累计 + 聚合页） | runner finalize + 新 Usage 视图 | ~200 行 | 0.4.0 |
| P3 | 转录升级（diff 高亮 + 工具统计） | 新 DiffView + TaskDetail | ~150 行 | 0.5.0 |
| P4 | run 自动重试（瞬态白名单） | runner + failure.retryable | ~100 行 | 0.5.0 |
| P5 | 多 tab 浏览（简版会话标签） | App/TaskList/TaskDetail | ~150 行 | 0.6.0 |
| 平行池 | 委派增强两项（评估留痕 / 二层深度） | delegate.ts | ~80 行 | 随任意版本 |

依赖关系：P0 必须先行（后续全部触碰 types/runner）；P4 依赖 P1 的 `retryable` 标记；P2/P3/P5 相互独立。

---

## P0 清债净化（删双轨 squad）

**问题**：`mode:'squad'` 旧显式模式已无 UI 入口，但 squad.ts(337 行)、runner 的 squad 分支、Task.squad 五字段、TaskList/TaskDetail 的旧徽标全部健在；新委派又借用 `squad.integrationBranch/integrationNote` 字段存集成结果——概念双轨。

**改动清单**：

1. `src/main/squad.ts` **整文件删除**（`SquadRunner`、旧规划 prompt、旧恢复路径）。
2. `src/main/runner.ts`：
   - 删 `attachSquad()`、`registerLaunch()`（仅旧路径调用）、`run()` 中 `mode==='squad'` 分支；
   - `opts` 收窄为 `{concurrency, mode, notify}`（`squadMaxWorkers` 改名 `workerConcurrency`，双通道泵保留——委派子任务仍用它限流）。
3. `src/shared/types.ts`：
   - 删 `Task.mode`、`SquadPhase`、`SquadInfo`；
   - 新增 `interface IntegrationInfo { branch?: string; note?: string }`，`Task.integration?: IntegrationInfo`；
   - 保留 `parentTaskId` / `workerIndex`（委派子任务在用）。
4. `src/main/delegate.ts`：结尾 `store.update` 的 `squad:{phase:'done',...}` 改写为 `integration:{branch, note}`。
5. `src/main/store.ts`：**一次性迁移**——`load()` 时 `mode:'squad'`→丢弃 mode；`squad`→`{branch: integrationBranch, note: integrationNote}`；旧 squad 任务若 `status==='running'`→`failed`（error:"旧版协同任务，请重新运行"）。
6. `src/main/index.ts`：删 SquadRunner 装配与 `squad.recover()`；`tasks:create` IPC 去掉 `mode/maxWorkers` 入参。
7. UI：`TaskList.tsx` 删 `⚡ 委派` 徽标的 phase 文案（保留徽标但改读 `t.integration`）；`TaskDetail.tsx` 集成 banner 改读 `task.integration.note`；`WorkspaceView.tsx` 提示文案不变；`SettingsView.tsx` `squadMaxWorkers` 标签改"子任务并行数"。
8. **小修三连**（并入本阶段）：
   - `TaskDetail.doDuplicate` 的 `window.location.reload()` → `onSelect(t.id)`；
   - renderer 类型统一：`api.ts` 的 `AgentInfo` 补 `role/systemPrompt/subordinates`，`TeamView/WorkspaceView` 删本地重复定义改 import；
   - `runner.notify` 点击 → `mainWindow.show()` + `focus()` 后再发 `task:focus`。

**验收**：
- `grep -rn "squad" src/` 仅剩注释级残留或零命中；typecheck 0 错误；
- `npm run smoke` + `smoke:delegate` 通过（smoke-squad.mjs 删除，package.json 脚本同步清理）；
- 构造旧格式 tasks.json（含 mode:'squad' 运行中任务）→ 启动后正确迁移、不炸、历史 banner 仍渲染。

**回滚**：git 单提交，revert 即回 0.3.0 行为。

---

## P1 失败分类学

**对标**：Multica 平台侧/工具侧两段枚举 + "怎么办"文案。

**新增 `src/main/failure.ts`**：

```ts
export interface FailureInfo {
  code: string            // 机器可读：cli_missing | provider_auth | provider_quota | rate_limit |
                          // timeout | idle_timeout | output_limit | protocol_config | context_overflow |
                          // sandbox | process_crash | unknown
  title: string           // 一句话人话："CLI 未安装或无法启动"
  hint: string            // 怎么办："在设置页探测；确认 PATH 上有可执行文件"
  retryable: boolean      // P4 的重试白名单依据
}
export function classifyFailure(input: { error: string; backend: string; exitCode?: number }): FailureInfo
```

**匹配规则**（按序短路）：
- `spawn`/`ENOENT`/`EINVAL` → `cli_missing`；`ZCODE_RUNTIME_MODEL_UNAVAILABLE` → `protocol_config`；
- `401|403|auth|unauthorized` → `provider_auth`；`402|quota|余额` → `provider_quota`；`429|529|rate` → `rate_limit`(retryable)；
- `resume 超时|idle|空闲超时` → `idle_timeout`(retryable)；`300KB|输出超限|maxBytes` → `output_limit`；
- `context|上下文` → `context_overflow`；`exit code -1|sandbox` → `sandbox`（codex Windows 专属提示：须 bypass）；其余非零退出 → `process_crash`；兜底 `unknown`。

**接线**：runner 三个失败写点（`r.ok=false` / catch / resume catch）统一走 `classifyFailure`，`Task.failure` 落库，`Task.error` 保留原文；`TaskDetail` error-banner 渲染 `code 徽标 + title + hint`，原文收进 `<details>`。

**验收**：`failure.test`（或 smoke 内嵌）对每类样例断言 code；fake 后端抛各特征错误 → UI 显示对应分类；typecheck/smoke 全绿。

---

## P2 用量汇总

**数据已有，纯聚合**。events 里每回合 `usage` 事件含 inputTokens/outputTokens/costUsd/durationMs（多态键名，`cleanUsage` 已兼容）。

1. `shared/types.ts`：`Task.usage?: { inputTokens, outputTokens, totalTokens?, costUsd?, durationMs?, turns }`。
2. `runner.finalizeDone`：扫全部 usage 事件累加（复用回合聚合逻辑，抽 `aggregateUsage(events)` 到独立函数便于测试）。
3. **任务级 UI**：TaskDetail header 加累计 chip（"⚡ 1.2M/340k tok · $2.31 · 18m"）。
4. **聚合视图**：侧栏第四项"用量"（`UsageView.tsx`）：按队员聚合表（join `agents.json`）——队员 | 任务数 | 完成/失败 | tokens in/out | 成本 | 总时长；按后端小计一行；底部合计。数据 = `bridge.tasks.list()` 一次性 reduce，无新 IPC。
5. 可选（低优先）：导出 CSV 按钮。

**验收**：多回合任务累计与逐回合角标之和一致；聚合页合计 = 各行和；无 usage 数据的旧任务显示"—"不报错。

---

## P3 转录升级

1. **diff 高亮**：新增 `DiffView.tsx`（~80 行）：解析 unified diff——文件头（`+++---`）分组、`@@` hunk 行号、`+`/`-` 行染色、等行弱化；替换 `git-pane` 的 `<pre>`。零依赖，`task.gitDiff` 原文进、React 元素出。
2. **工具统计条**：TaskDetail 对话视图每个 turn 的 worklog summary 处加分类 chips：按工具名前缀映射 `Read/Grep/Glob→读取`、`Bash→命令`、`Edit/Write/NotebookEdit→编辑`、其余→其他，显示"🔧 12 次调用 · 读取 6 · 命令 4 · 编辑 2"。
3. 可选（默认不做，卡了再做）：事件虚拟滚动。

**验收**：真实 git diff 渲染正确（含中文路径、二进制标记 "Binary files differ" 直通）；空 diff/hunk 边界不炸；工具 chips 与展开行数一致。

---

## P4 run 自动重试

**规则**（对照 Multica：瞬态才重试，最多 2 次；凭证/配置类不自动重试）：

- 触发：run 终态 `failed` 且 `failure.retryable === true` 且 `(task.attempt ?? 0) < 2`；
- 语义：第 1 次重试**带 resume**（有 sessionId 且后端支持——zcode/claude/codex/opencode；dsh 直接 fresh）；第 2 次强制 fresh（清 sessionId）；两次都失败则终态 failed，error 标注"已自动重试 2 次"；
- 落地：`Task.attempt?: number`；runner 失败分支调 `maybeAutoRetry(taskId)`——`store.update(attempt+1, status queued)` + 事件流记 status "⟳ 自动重试 1/2（原因：rate_limit）" + `enqueue`；手动"重新运行"按钮恒 fresh（attempt 清零，现行为）；
- UI：TaskList/TaskDetail 显示"重试 1/2" mini 徽标。

**验收**：smoke 新用例——fake 后端首轮抛 `429` 次轮成功 → 任务终态 done、事件流含重试记录、attempt=1；首轮抛 `401` → 不重试直接 failed；dsh 后端失败 → 直接 fresh 路径。

---

## P5 多 tab 浏览（简版）

明确**不抄** Multica 的 TabSession 全套（虚拟历史/滚动备忘录/钉住不变量），做实用最小版：

- `App.tsx`：`tabs: string[]`（taskId 列表）+ `activeId`；顶部 tab 条（TaskDetail 上方）：标题截断 + 状态点 + 关闭 X；侧栏点任务 → 已开则激活，未开则追加 tab；删除任务联动关 tab；上限 8 个（超出提示）。
- 快捷键：`Ctrl+W` 关当前 tab、`Ctrl+Tab` 切换。
- `selectedId` 语义改为 `activeId`，TaskList 高亮跟随。

**验收**：并行观察领队 + 多个子任务不再来回切；删任务/取消后 tab 状态一致；Ctrl+N 仍回工作区（工作区 = 隐藏 tab 的特殊页）。

---

## 平行池：委派增强（可插进任意阶段）

1. **领队评估留痕**（对标 squad activity --reason）：`<delegate>` 协议增加可选属性 `<delegate to="X" reason="为何派它">`；`parseDelegates` 提取 reason；每轮 status 事件从"第 N 轮派发：X"升级为"第 N 轮：派 X —— <reason>"；`buildDelegationBlock` 协议文案同步要求附 reason。零成本，纯展示增益。
2. **二层委派**：允许 worker 本身是领队——`runDelegationLoop` 的 worker 分支不再硬性排除（当前 `!isWorker` 条件放宽）；**防环**：`sanitizeChildPrompt` 之外新增祖先链检查（沿 parentTaskId 上溯，禁止循环引用与自我委派）；MAX_ROUNDS 全局共享预算（祖先轮数计入）。风险中等，单独提交，默认关（agents 预置不动，想用时给队员配 subordinates 即生效）。

---

## 里程碑与发版

| 版本 | 内容 | 出口条件 |
|---|---|---|
| **0.4.0** | P0+P1+P2 | 清债完成 + 失败可读 + 用量可见；全量 smoke 通过；CHANGELOG 更新 |
| **0.5.0** | P3+P4（+平行池①） | 转录升级 + 自动重试；真实后端 e2e 各跑一轮 |
| **0.6.0** | P5（+平行池②） | 多 tab；`npm run dist` 出 NSIS 安装包 |

每阶段一个 git 提交（P0 拆两提交：纯删除 + 迁移与小修），提交前 `typecheck + 对应 smoke` 必须绿。

## 需要拍板的决策点

1. **P0 squad 字段**：按方案重命名 `integration` 并做一次性迁移（推荐，概念干净）——还是保留 `squad` 字段名只删 squad.ts（少动但名不符实）？
2. **P2 聚合页位置**：侧栏独立"用量"页（推荐）vs 塞进设置页 tab？
3. **P5 范围**：简版 tab（推荐）vs 直接不做（当前单详情也够 demo）？
4. **平行池②二层委派**：本周期做（带防环）vs 留到需要时再说？

默认按推荐项执行；有异议在开工前指出即可。
