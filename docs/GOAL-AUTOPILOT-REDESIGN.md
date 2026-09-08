# 目标模式重构：Issue 内自动推进（按 Loop Engineering 理念）

> 状态：设计定稿，随 0.18.0 目标模式阶段实施
> 前置阅读：`docs/LOOP-ENGINEERING.md`（理念出处）、`docs/CONSTRUCTION-PLAN.md` 阶段 7

## 0. 为什么重构 v1

目标模式 v1 的问题（用户反馈 + 对标 Loop Engineering）：

1. **独立"目标"页 + 合成 Issue**（`iss_goal_xxx`）：脱离用户的 Issue 工作流，看板上看不到、管不到。
2. **每阶段新建 Task、重建巨型 prompt、丢弃会话**：既贵又违背"状态脊柱 + 断点续跑"——上下文每轮从零开始，靠 prompt 拼接续命。
3. **完成判定靠 prose 子串匹配**：'"完成"只是模型的主张，不是证明'——停止条件不可验证。
4. **委派单状态断链**：队员完成后 Issue 卡在 in_review，只能人工点成 done；maker/checker 分离没有落到看板上。

## 1. 目标模式 v2 = Issue 内的 Goal-based Loop

对照 `LOOP-ENGINEERING.md` 的模型：

| Loop Engineering 构件 | v2 落地 |
|---|---|
| Goal-based loop（/goal 型） | 目标绑定**真实 Issue**，在 Issue 详情内开启；开启后 agent 自省自推，直到完成条件验证通过 |
| Loop 1（执行循环） | 复用现有 Task/Runner/会话续聊（followUp 回灌），不重开上下文 |
| Loop 2（验证循环） | ① 每轮 checkpoint envelope 由 agent 显式声明；② 委派单必须过**领队审核**（`<review>` 标记，maker/checker）；③ 完成条件全达成才终局 |
| Sub-agents | 照旧 `<delegate>` 派工；队员结果回灌时领队必须出审核结论 |
| 状态脊柱 | `GoalCheckpoint` 每轮落盘（runId 幂等）；Goal/Issue/Run 三层状态互相投影 |
| 停止条件可验证 | 完成判定主判据 = envelope 逐条对照原文（不再靠 prose 撞子串）；预算/停止条件/连续失败护栏保留 |

### 1.1 用户可见行为

- Issue 详情（TaskDetail）新增**目标模式**面板：未开启时一个「🎯 开启目标模式」入口；开启后显示状态、轮数预算、checkpoint 历史，以及暂停/继续/取消操作。
- 「目标」导航页**删除**（App.tsx）；`goals:*` IPC 保留。
- 目标开启后：该 Issue 的当前任务每轮结束，系统自动回灌让 agent 继续（同会话续聊），**直到完成条件全部达成**（此时 Goal → completed，Issue 自动归档 done）或触发护栏（预算/停止条件/连续失败 → 停下并写明原因）。
- 委派单：队员完成 → 领队审核（pass → Issue 自动 done；fail → Issue 标 blocked 并由领队改派/修复）→ 看板状态不再依赖人工点选；领队未出结论的单保持 in_review（人工兜底）。

## 2. 契约变化（shared）

- `GoalCreateInput` 新增必填 `issueId: string`（目标必须归属真实 Issue）。
- `Goal` 新增可选 `failures?: number`（连续非重试失败次数，自动续轮上限用）。
- 其余 `goals:*` IPC 面不变。

## 3. 后端改动清单

### 3.1 `src/main/goal-controller.ts`（重写循环引擎）

- `create(input)`：`issueId` 必填且非空；**不再合成伪 Issue**。创建后**收养**该 Issue 现有最新 Task：
  - 无 Task → 建首个 Task（prompt = 目标块，见 §4），startNow 时入队；
  - 有 Task（queued/running/done/failed）→ 登记为当前阶段任务；startNow 时按状态启动（queued→enqueue/startTask；done/failed→续聊回灌；running→等终态）。
- `onTaskChanged(task)`：只处理 `task.issueId === goal.issueId` 的任务（天然包含 `<continue>` 接力产生的 handoff 任务——循环跟随 Issue 最新任务，不再只认自己建的）。终态时：
  1. `parseCheckpoint`（envelope 优先，prose 兜底）→ `addCheckpoint`（runId 幂等，保留）；
  2. 预算扣减（runCount、totalDurationMs，逻辑保留）；
  3. 决策（`decide` 保留原顺序，两处增强）：
     - **完成** → goal completed + 调 `finalizeIssue(issueId)`（Issue 归档 done）；
     - **非重试失败** → `goal.failures`（持久化）+1；`failures < 2` 时**自动续轮**（回灌里带失败上下文），否则 goal failed；
     - 其余（stop 命中 → waiting_user、预算尽 → blocked、重试中 → active）保持 v1 语义。
  4. 续轮引擎（新）：
     - **首选同会话续聊**：`continueTask(taskId, 回灌文本)`（index.ts 接到 `runner.followUp`）；fire-and-forget，按 goalId+taskId 加在飞标记防重复派发；
     - **兜底新任务**：`continueTask` 未注入、或 Task 无 `sessionId`（dsh 一次性无头）时，走 v1 的 `launchNext`（prompt = 目标块 + checkpoint 简报）。
- `recover()`：语义不变（重启后 active → waiting_user，绝不静默续跑）。
- pause/cancel/continue：语义不变；`continue()` 改为对最新 Task 触发续轮（优先 followUp）。
- `GoalControllerOptions` 变化：`+ continueTask?`、`+ finalizeIssue?`，其余保留。

### 3.2 `src/main/delegate.ts`（委派单审核流）

- 新增 `parseReviews(text): Array<{ of, verdict, note? }>`：解析 `<review of="#1" verdict="pass|fail" note="…"/>`（自闭合，与 `<round>` 同风格）；`stripReviews(text)` 剥展示文本。
- `runDelegationLoop` 回灌报告格式加单号：`### 队员 X 的结果（done，单号 #1）`；回灌指令追加审核协议（见 §4）。
- 每轮回灌回合结束后：对**本轮**每个 done 子任务匹配审核结论（`of` 按 `#序号` 精确匹配，兜底按队员名/标题子串）：
  - pass → `ctx.applyReview(childId, 'pass', note)`；fail → `ctx.applyReview(childId, 'fail', note)`；
  - 未出结论 → 留痕 `单 #n 未出审核结论，保留人工审核`，不改状态。
- `DelegationContext` 新增 `applyReview?: (childId, verdict: 'pass'|'fail', note?) => void`。
- `finalText` 剥离 review 标记（stripReviews），`scanTexts` 不剥（多源解析兼容）。

### 3.3 `src/main/runner.ts` + `src/main/index.ts`（接线）

- runner 新增 `attachIssueOps(ops: { reviewStatus(childId, verdict, note) })` 与公开方法 `applyChildReview(childId, verdict, note)`（delegate ctx 的 applyReview 实现）。
- index.ts：
  - `runner.attachIssueOps({ reviewStatus: (childId, verdict, note) => { const child = store.get(childId); if (!child?.issueId) return; issueStore.updateWorkflow(child.issueId, verdict === 'pass' ? 'done' : 'blocked'); if (note) issueStore.addComment(child.issueId, `审核${verdict === 'pass' ? '通过' : '退回'}：${note}`, { type: 'agent', id: 'reviewer' }); publishIssueUpdate(child) } })`
  - `goalController` options 接 `continueTask: (taskId, content) => runner.followUp(taskId, content)`、`finalizeIssue: (issueId) => { const issue = issueStore.get(issueId); if (issue) { issueStore.updateWorkflow(issueId, 'done'); /* 广播：找该 issue 任一 task publishIssueUpdate */ } }`。

### 3.4 `src/main/ipc-validation.ts` + `src/main/ipc/goals.ts`

- `parseGoalCreate`：assertKeys 增加 `issueId`；返回值带 `issueId`（必填，空串报错）。

### 3.5 状态投影（无改动说明）

- `issue-store.ts` 的 `statusOverride` 机制天然支持审核写入（updateWorkflow 已存在）；`existingStatus` 对非 running 任务保持 override——审核通过的 done 不会被后续投影翻回 in_review。

## 4. 注入协议文本（定稿，直接照抄）

### 4.1 目标模式块（GOAL_BLOCK，注入目标 Issue 首个 Task 的 prompt 末尾）

```
【目标模式（自动推进协议）】
本任务在目标模式下运行：每轮回合结束后系统会检查进度并自动让你继续，直到完成条件全部达成。
- 每轮收尾时，在回复末尾输出一个 checkpoint JSON 代码块（```json 包裹）：
  {"summary":"本轮摘要","completedConditions":["已达成的完成条件原文"],"incompleteConditions":["未达成的完成条件原文"],"nextPlan":"下一轮计划","blockers":["阻塞项，没有则空数组"]}
- completedConditions/incompleteConditions 必须逐条对照目标完成条件原文填写，不要改写、不要合并。
- 全部完成条件达成的那一轮：completedConditions 填全所有条件，nextPlan 留空，停止派发，直接收尾。
- 需要并行或专长的工作用 <delegate> 派发队员；队员结果回灌后由你按回灌指令给出审核结论。
- 确需换新会话的阶段边界才用 <continue>（简报自包含）；一般推进不要硬切会话。
- 遇到必须人工决策或命中停止条件的事，写进 blockers，不要自行猜测执行。
```

### 4.2 续轮回灌文本（followUp 内容，GoalController 组装）

```
【系统·目标模式】第 {n} 轮已结束并记录 checkpoint。
- 摘要：{summary}
- 未完成条件：{incompleteConditions 逐条}
- 上一轮下一步计划：{nextPlan}
{有 blockers 时：- 阻塞：{blockers}}
{失败续轮时：- 上一轮失败原因：{error}（自动续轮 {failures}/2）}
请继续推进目标：先输出一行 <round outcome="..." reason="..."/> 自评，再继续执行或派发；完成条件全部达成时按【目标模式】协议输出 checkpoint 收尾。
```

### 4.3 审核协议（追加进 delegate.ts 回灌指令）

```
对报告里每个状态为 done 的单给出审核结论（maker/checker：队员是 maker，你是 checker）：
<review of="#单号" verdict="pass|fail" note="一句话：通过理由或退回原因"/>
- verdict=pass：该单在看板自动归档为已完成；verdict=fail：标记受阻，你应在下一轮改派或自行修复。
- 未出结论的单将保留在人工审核列。
```

## 5. 渲染层改动清单（领队亲自做）

- `App.tsx`：删除 `goals` 视图、导航按钮、命令面板项、GoalsView import。
- 删除 `components/goal/GoalsView.tsx`；新增 `components/goal/GoalPanel.tsx`（嵌入 TaskDetail 侧栏）：开启对话框（目标/完成条件/停止条件/预算/Agent）、状态 chip、操作按钮、checkpoint 折叠列表。
- `TaskDetail.tsx`：侧栏顶部挂 GoalPanel。
- `BoardView.tsx`：目标非终态的 Issue 卡片加 🎯 badge。
- `styles.css`：goal-panel 复用/微调现有 goal-* 样式。

## 6. 测试要求

- `scripts/smoke-goal.mjs` 重写：Issue 收养（无 Task 建单 / 有 done Task 续聊不新建）、envelope 完成判定 + finalizeIssue 调用、预算耗尽 blocked、非重试失败自动续轮（failures 上限 2）、stop 条件 waiting_user、重启恢复 waiting_user、无 continueTask 时新任务兜底。
- `scripts/smoke-delegate.mjs` 增加：回灌报告带单号；`<review>` 解析（#序号/名字匹配/无结论不动状态）；pass → applyReview('pass')；fail → applyReview('fail')；finalText 剥离 review 标记。
- 全量 `npm run typecheck` + `npm run smoke` 绿。

## 7. 明确不做（本轮）

- 独立裁判模型（Loop 2 的 LLM-as-judge 用独立小模型）——本轮 checker = 领队本人/指定审核队员，不引入第三种执行角色。
- 跨 Issue 目标依赖图、Loop 4 自改循环。
- 旧伪 Issue 目标数据迁移（磁盘保留，UI 不再展示）。
