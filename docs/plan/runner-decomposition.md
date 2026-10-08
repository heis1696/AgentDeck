# TaskRunner 拆解设计（src/main/runner.ts → 执行内核 + 事件持久化 + 委派工作流）

> **读者与目的**：本文是下一阶段施工的唯一输入（自包含，不依赖任何对话上下文）。本轮**只设计不改代码**；所有行号以撰写时的工作树为基线（`TaskRunner` 类体 `src/main/runner.ts:326`–`:3454`）。施工时**一律按符号名定位，不要按行号**——每个批次开始时行号必然已漂移。
>
> **结论一句话**：问题不在文件长，而在 24 个实例级 Map/Set/计数器被编排逻辑跨职责直接读写，时序不变量散落在 96 个方法里。拆法是把「会话安装 / 回合身份 / 启动句柄 / 失效 / 退出确认」收敛为一个 `ExecutionKernel`（状态唯一所有者），事件持久化与委派工作流随后外移为独立模块；`TaskRunner` 保留外部门面与编排，调用方与 smoke 零改动。

---

## 0. 批次总览（先看这个）

| 批次 | 内容 | 新文件 | 行为变化 | 独立回滚 |
|---|---|---|---|---|
| 1 | 无状态原语与类型搬迁（纯代码搬移，零行为变化） | `src/main/execution/identity.ts`、`session-turn-router.ts`、`cleanup.ts`、`git-probe-cache.ts` | 无 | revert 单提交 |
| 2 | **执行内核**：12 项状态收口 + 三处会话安装序列合并 + F1 对称解除修复 | `src/main/execution/execution-kernel.ts` | 仅 F1（见 §8，缺陷修复） | revert 单提交 |
| 3 | 事件持久化外移（3a 批次台账 / 3b 事件工厂） | `src/main/execution/event-pump.ts`、`turn-events.ts` | 无 | 每子批一个提交 |
| 4 | 委派工作流外移（4a 台账 / 4b 建单器） | `src/main/execution/delegate-ledger.ts`、`child-spawner.ts` | 无 | 每子批一个提交 |
| 5 | 终止协调 + doom 窗外移 | `src/main/execution/termination.ts`、`doom-window.ts` | 无 | 每模块一个提交 |
| 6 | （可选）run/followUp 编排节点化 | `src/main/execution/run-flow.ts`、`followup-flow.ts` | 无 | 默认不做，另行评估 |

每批验收门（硬性）：`npm run typecheck && npm run build && npm run smoke:stage6` 全绿，**再加跑该批触达面的 runner 专项 smoke**（见 §9 各批清单；注意 `smoke:stage6` **不包含** `smoke:lifecycle`/`smoke:queue-recovery`/`smoke:delegate*`/`smoke:turn-lifecycle`/`smoke:execution-services`，这些必须手动加跑）。

---

## 1. 现状定性

### 1.1 状态清单（拆解的对象就是这张表）

`TaskRunner`（`src/main/runner.ts:326`）持有 24 个实例级集合与 3 个可变标量：

| # | 状态 | 定义行 | 所属职责组（§2） |
|---|---|---|---|
| 1 | `sessions` | `runner.ts:337` | 组1 |
| 2 | `sessionWorkdirs` | `runner.ts:340` | 组1 |
| 3 | `worktreeSessionReleases` | `runner.ts:341` | 组7 |
| 4 | `claims` | `runner.ts:344` | 组1 |
| 5 | `sessionTurns`（WeakMap） | `runner.ts:347` | 组1 |
| 6 | `turnSeq` | `runner.ts:349` | 组1/组3 |
| 7 | `turnStartObservers` | `runner.ts:350` | 组1 |
| 8 | `launchHandles` | `runner.ts:352` | 组1 |
| 9 | `retryTimers` | `runner.ts:354` | 组1（句柄面） |
| 10 | `lastTerminalResponses` | `runner.ts:357` | 组2 |
| 11 | `turnWatchdogs` | `runner.ts:369` | 组3 |
| 12 | `turnLifecycles` | `runner.ts:373` | 组1/组3 |
| 13 | `eventBatchers` | `runner.ts:375` | 组2 |
| 14 | `spawnCreatesInFlight` | `runner.ts:380` | 组4 |
| 15 | `shuttingDown` | `runner.ts:381` | 组2 |
| 16 | `cancellationDrains` | `runner.ts:382` | 组2 |
| 17 | `terminating` | `runner.ts:384` | 组7 |
| 18 | `activeRuns` / `activeTurns` | `runner.ts:385`–`:386` | 组7 |
| 19 | `terminationTargets` | `runner.ts:387` | 组7 |
| 20 | `retiredProviderSessions` | `runner.ts:388` | 组7 |
| 21 | `earlySpawns`（含 `spawned`/`seenKeys`/`pending`/`suspended` 四层嵌套态） | `runner.ts:392` | 组4 |
| 22 | `delegateRejections`（内存层；持久层在 `Task.delegateRejections`） | `runner.ts:394` | 组5 |
| 23 | `workerIndexReservations` | `runner.ts:395` | 组4 |
| 24 | `toolWindows` + `doomRequestSeq` | `runner.ts:397`–`:398` | 组6 |
| — | `gitUsableCache` | `runner.ts:1945` | 独立（探测缓存） |

### 1.2 重复模式（拆解的直接收益点）

- **会话安装六步序列重复三次**，逐字相同：`run()` `runner.ts:2623`–`:2633`、`startIsolatedTurn()` `runner.ts:2350`–`:2357`、`followUp()` resume 分支 `runner.ts:3013`–`:3021`。顺序为：`gate.setSessionOwner` → `lifecycle.attachSession` → `router.legacy/owner` → `sessionTurns.set` → `sessions.set` → `sessionWorkdirs.set` → `pushTask`。三份拷贝已经出现过漂移风险，必须收敛为一个入口。
- **任务级状态清扫清单重复五处**：`closeSession`（`:1010`–`:1014`）、`forget`（`:1071`–`:1095`）、`cancel`（`:3131`–`:3150`）、`retireExecutionState`（`:3222`–`:3235`）、`shutdown`（`:3400`–`:3448`）。任何新增任务级 Map 都要记得改五个地方——这正是漏清导致 `isIdle` 永久 false（历史事故，见 `runner.ts:3390` 注释）的根源。
- **时序不变量以注释而非类型表达**：如「旧心跳不能给新回合续命」靠 `idleSentinel` 的记录身份核对（`runner.ts:911`–`929`）、「删 Map 项 ≠ 取消 Promise」靠 `abandonEarlySpawns` 的 allSettled（`runner.ts:1295`）。

---

## 2. 七组共享状态：审查结论逐条验证

以下每条不变量编号 `I<组>.<序>`，是后续批次验收的锚点；§7 的覆盖矩阵按这些编号核对。

### 组1 启动/续聊 ↔ 回合路由 ↔ 会话回收

涉及：`claims` / `sessions` / `sessionWorkdirs` / `sessionTurns` / `turnLifecycles`。

审查结论「旧 Run 的清理不能关闭替换 Run 的会话」——**属实，且在四处分别设防**（没有单点）：

- `closeSession`（`runner.ts:1001`）双重校验：入口 `:1005` + await 后复查 `:1008`–`:1009`，用 `expected`（runId+executionOwner）拒绝旧身份；
- `releaseWorktreeSessions`（`runner.ts:1030`）逐会话校验 `claim.runId === task.runId` 且 owner 一致（`:1037`–`:1038`）、任务已终态（`:1036`）、无在飞回合（`:1039`）；
- `terminateSession`（`runner.ts:3242`–`:3246`）用 `SessionTurnRouter.lastClaim` 校验目标会话归属，不属本终止目标则记 problem 跳过；
- `startIsolatedTurn`（`runner.ts:2296`–`:2304`）拆旧连接后再次 `isCurrentRun` 复核。

**不变量**：
- **I1.1** 会话安装六步必须经唯一入口同步完成，安装前必须先有持久绑定成功（`store.updateIf` + `runCondition`，`:2609`/`:2341`/`:3000`）；绑定失败 → `closeLateSession`，会话**绝不**进内存表。
- **I1.2** 任何旧 Run 身份（`expected` 不匹配）的清理调用不得摘除/关闭替换 Run 的会话登记（上述四处防线语义不变，且收敛后不得新增绕行路径）。
- **I1.3** `closeSession` 顺序：drain 事件批（`:1006`）→ 摘登记（`:1019`–`:1021`）→ `retireSession` → `turnLifecycles.detachSession`（`:1023`）→ `stop`→`close|detach`（经 `trackSessionRelease` 台账，`:1024`–`:1027`）。
- **I1.4** `bumpTurnGen`（`runner.ts:968`–`:980`）顺序：先 `abandonOpen` 作废在飞回合路由 → 再 `life.invalidate()` → 再同步 status/清 sessionOwner。新代无主（ownerless），同步 start 回调因此可被接纳。
- **I1.5** 会话与目录绑定同进同退：`sessions`/`sessionWorkdirs` 的键值只在安装与回收时成对增删（`shutdown` `:3437`–`:3439` 注释即为此教训）。

### 组2 事件持久化 ↔ 终态投递 ↔ 取消/关闭

涉及：`eventBatchers` / `cancellationDrains` / `shuttingDown`。

审查结论「终态与取消必须保持事件提交→门禁失效→waiter 完成的既有顺序」——**属实**，锚点在 `makeTurnEvents` 的 `onTurnEnd`（`runner.ts:687`–`:725`）：`durableActive('final', true)` 门禁核对 → `batcher.close(5000)` 持久提交 → `lastTerminalResponses` 去重 → `router.closeTurn`（门禁收口）→ `onTurnEnd` 回调投递 → `life.resolveResume`（waiter 完成）。注释 `:719`「先收口本回合再投递：投递可能同步开启下一回合」就是这个顺序的理由。

**不变量**：
- **I2.1** 终态路径严格保持：持久提交 → 门禁收口（`closeTurn`）→ 投递 → waiter 完成。任何重排都可能让投递回调同步开启的下一回合看到未收口的旧回合。
- **I2.2** 取消路径：`closeEventBatches` 在 claim 仍有效时先 drain（`runner.ts:3119`–`:3121`）→ `updateIf` 落 cancelled（`:3128`）→ `turnWatchdogs.expire()` 触发门禁失效（`:3135`）→ `lifecycle.dispose`（`:3149`）→ `store.flushEvents`（`:3159`）。drain 先于失效是有意的（缓冲数据在身份仍有效时提交）；`cancellationDrains` 计数使 drain 期间 `onFlush` 失败分支（`:703`）改走 `abandonTurn` 而非报失败。
- **I2.3** 关机路径：`shuttingDown` 置位 → drain(2s) → dispose → 各回路 invalidate，**不把活跃任务改写为 failed**（`runner.ts:3417`–`:3419` 注释为契约）。
- **I2.4** flush 失败分支与终态同构：构造 failure 结果走同一条 `closeTurn → onTurnEnd → resolveResume` 链（`:699`–`:709`），只是错误文案换成 `persistenceProblem`。
- **I2.5** 接受即恢复边界：`stagePending` 用 `STAGED_BATCH_ID_PREFIX`（`:98`）暂存批身份，崩溃重放/重试幂等依赖它；合并判定放行暂存身份（`:603`–`:608`），否则每 token 一包。

### 组3 心跳/事件 ↔ 看门狗 ↔ 回合失效

涉及：`turnWatchdogs` + 生命周期 generation。

审查结论「旧心跳不能给新回合续命」——**属实**，机制是**记录身份**而非任务键：`idleSentinel` 的 `expire`/`cancel` 都先核对 `this.turnWatchdogs.get(taskId) !== record`（`runner.ts:916`、`:936`）；`touchWatchdog` 只重置当前记录（`:943`–`:948`）；心跳能否到达 touch 由 `durableActive` 的 token/generation 校验先行把关（`:686`）。

**不变量**：
- **I3.1** 看门狗 armed/续命/解除只对创建时登记的那条记录生效；零延迟自动重试在上一回合 finally cancel 之前换狗时，不得误删后继回合的狗（`runner.ts:908`–`911` 注释为回归教训）。
- **I3.2** `expire` 顺序：身份核对 → 清表 → `bumpTurnGen`（先失效在飞回调，**再**停会话）→ `onFire` → `session.stop`/`launchHandles.stop` → fire 裁决等待方（`:914`–`:929`）。
- **I3.3** 看门狗可在 `backend.start` 之前武装（启动挂死同样判败，`:2570`–`:2572`）；标题回合有独立硬预算 `retitleByAgent`（`:2237`–`:2274`），超时路径 = `bumpTurnGen` + `disarmWatchdog` + `session.stop` + 按原结果收尾。

### 组4 流式嗅探 ↔ 末轮收编 ↔ 建单 ↔ 失败撤销

涉及：`earlySpawns` 内 `spawned`/`seenKeys`/`pending`/`suspended` + `spawnCreatesInFlight` 建单互斥 + `workerIndexReservations` 编号预留。

审查结论「删 Map 项 ≠ 取消已启动的 Promise」——**属实**，三处体现：
- `abandonEarlySpawns`（`runner.ts:1279`–`:1297`）：先 `Promise.allSettled(state.pending)` **再**取消已建子单（`:1295`）；
- `sniffDelegates` 的建单 catch（`:1473`–`:1480`）：撤键 + 时间线留痕，回合末按「新单」重试；
- `takeEarlySpawns`（`:1304`–`:1330`）：await pending 后**重新核对 claim**（`:1312`），等待期间运行被替换则返回空。

**不变量**：
- **I4.1** `seenKeys` 会话级终身登记、永不因收编清空（`:1298`–`:1303` 注释为生产事故：同单重派）；收编只清 `spawned`。
- **I4.2** 撤销嗅探状态必须先等在途建单 Promise 收场，再处置已建子单；建单异常必须撤键留痕，绝不让占位无痕地留在 `spawned` 里被当「已处理」吞掉（`:1322`–`:1327` 的三分支）。
- **I4.3** 建单互斥：同键并发共享同一次执行（`spawnDelegateChild` `:1498`–`:1513`），结算即撤登记；互斥键 = `delegate:sha256(taskId,expectedRunId,to,prompt)`（`:1499`–`:1501`），**键格式与落盘 `dedupeKey` 对齐，迁移不得改动**；跨进程由 store 层 dedupeKey 兜底。
- **I4.4** 建单门禁三步（登记 `dispatchHold` → `setWorktreeOwner` 磁盘绑定 → `updateIf`(出生身份+holding) 翻面 → 入队前复核）与失败收口 `closeSpawnedChild`（`:1847`–`:1886`）的条件撤销/让位语义。
- **I4.5** `workerIndexReservations` 单调预留（`:1935`–`:1941`），并发建单编号不重号。
- **I4.6** `suspended` 收尾护栏：暂停期间不建单、不登记 seenKeys，收尾流复述的已接单标记由回合末按 seenKeys 对账具名拒单，零误拒（`:1270`–`:1276`、`:1439`–`:1447`）。

### 组5 拒单/回执 ↔ 委派循环 ↔ 重启续报

涉及：内存 `delegateRejections` / 持久化 `Task.delegateRejections` / 子单 `delegateDeliveredAt`。

审查结论「已读取 ≠ 已确认反馈」——**属实**：读取（`peekDelegateRejections` `:1362`）与确认（`acknowledgeDelegateRejections` `:1370`，落 `deliveredAt`）是分离的两步，`takeDelegateRejections`（`:1395`）= peek + acknowledge；子单交付标记 `acknowledgeDelegateReceipts`（`:1400`）同样只在 claim 仍匹配时落 `delegateDeliveredAt`。

**不变量**：
- **I5.1** 双层账同权：`delegateRejectionRecorded`（`:1333`–`:1339`）必须同时查持久层与内存层；写入去重按 `runId+key`（`:1349`–`:1359`）。
- **I5.2** 所有读/取/确认入口都以 `expectedRunId` 核对 claim（`:1307`/`:1363`/`:1371`/`:1401`），陈旧委派循环不得掏空或污染替换运行的账。
- **I5.3** 重启续报：`followUp` 组装 `recoveryNotice`（未交付子单 + 未送达拒单，`:2805`–`:2813`），仅当回合成功且 claim 仍有效才 `acknowledgeRecovery`（`:2866`–`:2878`）——失败回合不确认，下次续报重列。

### 组6 权限/重复工具检测 ↔ 内容更新 ↔ 取消

涉及：`toolWindows` + broker 请求版本。

审查结论核实：`workVersion` 是执行相关内容 hash（不含状态/结果，`runner.ts:816`–`:827`），权限请求与应答都带版本，内容更新即失效旧应答；doom-loop 应答回调先 `isCurrentRun`（`:872`–`:873`）——「新 Run 的 window 不被旧应答清除或写入」。取消/终止/释放/forget 四处都要 `permissionBroker.cancelTask` + `toolWindows.delete`（`:3144`–`:3145`/`:1088`–`:1089`/`:1058`–`:1059`/`:3230`–`:3231`）。

**不变量**：
- **I6.1** 权限应答只对提出请求时的 workVersion 有效；broker 由 runner 构造时注入 `workVersion` 探针（`:443`–`:445`）。
- **I6.2** doom 应答回调必须核对 claim；tool 事件转发打 `runnerDoomHandled` 标记防 GoalController 二次状态机（`:666`–`:671`）。
- **I6.3** 任务级状态清扫必须成对包含 `permissionBroker.cancelTask(taskId)` 与 `toolWindows.delete(taskId)`。

### 组7 执行 Promise ↔ 严格终止 ↔ worktree 释放

涉及：`activeRuns`/`activeTurns`/`terminationTargets`/`worktreeSessionReleases`（+ `terminating`/`retiredProviderSessions`）。

审查结论「超时返回 ≠ 资源已退出」——**属实**：`strictCleanup`/`awaitExit` 把超时与错误**收集进 problems 而不中断**（`runner.ts:3176`–`:3213`），`terminatedRunId` 只在启动中止、会话关闭、子任务终止、执行退出确认、已移除会话确认、晚到会话 drain 全部走完后才条件落盘（`:3374`）；无法确认退出历史会议执行时维持拒停（`:3293`–`:3299`）。`trackSessionRelease`（`:417`–`:427`）失败标记 `failed` 保留 release 供重试，完成才摘台账。

**不变量**：
- **I7.1** `trackMap` 结算即摘（`map.get(taskId) === promise` 才删，`:3168`–`:3174`）。
- **I7.2** 终止的每一步失败只进 `problems`，最终汇总返回；`terminatedRunId` 的写入是**全部确认之后**的唯一退出证明。
- **I7.3** `terminationTargets` 按捕获身份校验：旧终止请求不得触碰替换执行（`:3281`–`:3283`）。
- **I7.4** 会话释放台账：同会话重复登记复用在途 promise；失败保留 release；完成摘账。

### 资源所有权重叠（审查指出的硬点，核实属实）

`turn-lifecycle.ts:193` 的 `sessionValue` 让 `TurnLifecycle` 同时**持有物理会话**并实现关闭能力（`cancel()` `turn-lifecycle.ts:332`–`:347` stop+close；`attachSession` 的 previous 清扫 `:289`–`:292`）；runner 也持同一会话（`runner.ts:2624` attach / `:2630` `sessions.set`）。runner 侧 `closeSession` 有对称解除（`runner.ts:1023` `detachSession`），**`releaseWorktreeSessions`（`runner.ts:1046`–`:1060`）删除 runner 侧登记时没有对称解除**——后继 `attachSession` 会把已 detach 保留的 provider 会话当 previous sweep 掉。此缺口记为 **F1**，修复方案与批次归属见 §8。

---

## 3. 外部契约冻结面（拆解不得触碰）

`TaskRunner` 的以下面被 smoke 与调用方直连，**全部保持原样**（AGENTS.md 铁律：smoke esbuild 直连消费的导出是被测试固化的公共 API，见 `docs/graph/INVENTORY.md` 附录 A）：

1. **构造签名**：`new TaskRunner(store, backends, opts, onTaskChanged?, ports?)`（全部 smoke 按此构造）。
2. **全部公共方法**：`enqueue`/`pushTask`/`pushEvent`/`followUp`/`cancel`/`terminateTask`/`forget`/`closeSession`/`releaseWorktreeSessions`/`shutdown`/`isIdle`/`sessionCount`/`askPermission`/`resolvePermission`/`pendingPermissions`/`attach*` 七件套/`applyChildReview`/`addIssueComment`/`spawnDelegateChild`/`spawnInvestigateChild`/`sendChildSummaryTurn`/`takeEarlySpawns`/`suspendDelegateSpawns`/`sniffBufferChars`/`delegateRejectionRecorded`/`recordDelegateRejection`/`peekDelegateRejections`/`acknowledgeDelegateRejections`/`takeDelegateRejections`/`acknowledgeDelegateReceipts`/`gitRepositoryProbeForTest`，以及字段 `pipeline`/`flowEngine`。
3. **⚠ 两个私有字段被 smoke 直读**：`runner.turnWatchdogs`（`scripts/smoke-lifecycle.mjs:272`）、`runner.turnLifecycles`（`scripts/smoke-lifecycle.mjs:316`、`:360`）。状态迁入内核后，`TaskRunner` **必须保留这两个同名属性且返回内核持有的同一活 Map 引用**（普通 getter 即可，smoke 只用 `.has`/`.get`）。这是「smoke 不动」约束下的硬性兼容点。
4. **模块级导出**：`TaskRunner`、`MAX_CONSULT_ROUNDS`、`TURN_ISOLATION_REQUIRED`、`RESUME_UNSUPPORTED_MESSAGE`（`scripts/smoke-delegate.mjs` 直连消费）、`setGitRepositoryProbeCacheProbeForTest` 及类型 `GitRepositoryProbeCacheEvent`、`RunnerPorts`、`ContinueHandler`、`ConsultHandler`、`InvestigateHandler`、`ChildTaskCreator`/`TaskCreator`/`TaskCreationRequest`。批次 1 搬迁这些符号时 `runner.ts` 必须 **re-export 原名**。
5. **依赖边现状**：`delegate.ts → runner.ts` 仅为 `import type { TaskRunner }` 的类型环（`docs/graph/INVENTORY.md` §2.6 已记录）。拆解不得加深它：新模块 `src/main/execution/*` **不得** import `delegate.ts` 的运行时值以外的解析器（`parseDelegates` 等纯函数可以，`runDelegationLoop` 只留在 runner 编排层）。
6. **⚠ 变异红测锚点钉在 runner.ts 上**：`scripts/smoke-delegate-mutation.mjs` 按 `{file, find, replace}` 三元组对临时源码树做字符串变异，锚点未命中即抛 `变异锚点未命中`（`:20`）。其中 **4 处 `file: 'src/main/runner.ts'`**，锚的正是批次 4 要迁走的代码：建单门禁 `dispatchHold: true` 注释块（`:1241`）、`setWorktreeOwner` 绑定失败收口（`:1251`）、嗅探暂停护栏 `if (state.suspended)`（`:1280`）、`closeSpawnedChild` 条件撤销段（`:1292`）。批次 4 迁移这些函数后**必须**同步把这几条变异条目的 `file:` 重定向到新路径（`find`/`replace` 锚文随逐行搬迁原样保留，断言零改动）。这是对测试**工装**的机械路径维护，不是改断言；若领队裁定连 `file:` 重定向也不允许，则批次 4 的三个函数必须留在 `runner.ts`（仅改为委托内核台账），见 §10 第 6 条。

直连 `src/main/runner.ts` 的 smoke 共 29 个（grep 核实）：`smoke-runner`、`smoke-turn-identity`、`smoke-lifecycle`、`smoke-run-ownership(-repair)`、`smoke-queue-recovery`、`smoke-event-pipeline`、`smoke-delegate(-reject/-mutation)`、`smoke-continue`、`smoke-failure`、`smoke-dsh-budget`、`smoke-retitle-cap`、`smoke-sparse-worktree`、`smoke-orchestration-matrix`、`smoke-issue-pipeline`、`smoke-task-service`、`smoke-sidecar`、`smoke-hot-transaction`、`smoke-worktree-lifecycle`、`smoke-meeting*` 六件、`e2e-delegate-real`。任何一批落地前，触达面内的这些脚本必须全绿。

---

## 4. 被否决的方案（点名，施工时不要重新发明）

1. **❌ 行数切薄式 helper 搬运**：把 96 个方法按行数/主题切成 `runner-helpers-a.ts`/`runner-helpers-b.ts`，函数签名统一 `(runner: TaskRunner, ...)`。否决理由：`this` 换名为 `runner`，24 个 Map 的跨职责读写原封不动，耦合零改善；只是把一个 3400 行文件变成两个互相 import 的文件，typecheck 照样全绿、问题原样存在。
2. **❌ Context 袋**：定义 `RunnerContext { runner, store, claims, sessions, ... /* 全部 Map */ }` 传给所有 helper。否决理由：这是方案 1 的变体——「全部 Map 打包」让每个模块都能写任何状态，所有权比现状**更**模糊，且构造出一个上帝对象参数。
3. **❌ 模块级单例/全局 WeakMap**：把 `sessionTurns`、`turnLifecycles` 等提升为模块级单例图。否决理由：`smoke-run-ownership` 等在同进程构造多个 TaskRunner 实例做双实例竞速，单例状态会跨实例泄漏，直接破坏 `[2]`/`[5]` 场景。
4. **❌ Mixin/继承组合**：把 TaskRunner 拆成 `RunnerSessionMixin` 等多继承组合。否决理由：私有字段跨 mixin 可见性混乱、`this` 类型推导灾难，且没有解决任何状态所有权问题。
5. **❌ 上帝内核**：把 `ExecutionKernel` 做成「什么都管」——塞入 store 写入、prompt 拼装、委派循环。否决理由：内核只是第二个 runner。内核边界：**只管身份签发、登记、失效、退出确认原语**；凡涉及业务裁决（prompt、委派、通知、pipeline 结算）一律留在 runner 编排层，经窄端口回调。
6. **❌ 一次性大爆炸搬迁**：一个提交重排全部 96 方法。否决理由：违反「每批独立可回滚」；runner 是全仓库回归密度最高的模块（29 个直连 smoke），必须小步。

---

## 5. 目标架构

### 5.1 模块与状态所有权（迁移前 → 迁移后）

新目录 `src/main/execution/`（与既有 `src/main/pipeline/` 同构：引擎/节点下沉、runner 编排）。若领队偏好平铺命名，仅路径差异，不影响设计。

| 目标模块 | 批次 | 拥有状态（迁移后唯一所有者） | 从 runner.ts 迁入的操作 |
|---|---|---|---|
| `execution/identity.ts` | 1 | 无（纯类型+常量） | `RunClaim`、`runCondition`、`runIdentity`、`TurnRecord`、`TURN_ISOLATION_REQUIRED`、`RESUME_UNSUPPORTED_MESSAGE`（runner.ts re-export 原名） |
| `execution/session-turn-router.ts` | 1 | 路由器内部 `open`/`currentId`/`seq`/`legacy`/`ambiguous`/`owner`/`lastClaim` | `SessionTurnRouter` 整类（`runner.ts:225`–`:312` 逐行搬迁） |
| `execution/cleanup.ts` | 1 | 无（纯函数族） | `awaitCleanup`、`strictCleanup`、`awaitExit`、`checkedCleanup` |
| `execution/git-probe-cache.ts` | 1 | `gitUsableCache` + 探针 | `gitRepositoryProbe`、`gitRepositoryProbeForTest`、`setGitRepositoryProbeCacheProbeForTest` |
| `execution/execution-kernel.ts` | 2 | `claims`、`sessions`、`sessionWorkdirs`、`sessionTurns`、`turnLifecycles`、`turnSeq`、`turnStartObservers`、`launchHandles`、`retryTimers`、`lastTerminalResponses`、`turnWatchdogs`、`worktreeSessionReleases` | `lifecycle()`、`openTurn()`、`bumpTurnGen()`、`sessionMayOpenNewTurn()`、`retireSession()`、`sessionChannel()`、**`installSession()`（六步序列唯一入口，替换三处拷贝）**、`closeSession()`、`releaseWorktreeSessions()`、`trackSessionRelease()`、`idleSentinel`/`touchWatchdog`/`disarmWatchdog`/`expireWatchdog`、`claimForRun`/`isCurrentRun`/`setClaim`/`dropClaim`、`clearRetry`、`closeLateSession`、`forget` 的登记清理半部 |
| `execution/event-pump.ts` | 3a | `eventBatchers` | `closeEventBatches`、`disposeEventBatches`、批登记 |
| `execution/turn-events.ts` | 3b | 工厂闭包内的单回合态（`eventSequence`/`terminalStarted`/`persistenceProblem`/`ownershipCheckedAt`） | `makeTurnEvents` 整函数（`runner.ts:548`–`:741`），依赖全部经端口注入 |
| `execution/delegate-ledger.ts` | 4a | `earlySpawns`、`delegateRejections`、`spawnCreatesInFlight`、`workerIndexReservations` | `armDelegateSniffer`、`suspendDelegateSpawns`、`abandonEarlySpawns`、`takeEarlySpawns`、`sniffDelegates`、`sniffBufferChars`、拒单五方法、`reserveWorkerIndex` |
| `execution/child-spawner.ts` | 4b | 无（编排无状态，读 ledger 与 kernel） | `spawnDelegateChild(Exclusive)`、`closeSpawnedChild`、`spawnInvestigateChild` |
| `execution/doom-window.ts` | 5 | `toolWindows`、`doomRequestSeq` | `observeToolCall` |
| `execution/termination.ts` | 5 | `terminating`、`terminationTargets`、`retiredProviderSessions` | `retireExecutionState`、`terminateSession`、`terminateTask(Exclusive)` |
| runner.ts（保留） | — | `activeRuns`、`activeTurns`、`cancellationDrains`、`shuttingDown`、全部 attach* 注入依赖 | 编排：构造装配、`run`/`followUp`/`completeTurn`（含 consult/investigate/continue/retitle）/`cancel`/`shutdown`/`maybeAutoRetry`/`sendTurn`/`startIsolatedTurn`/`sendChildSummaryTurn`、facade 委托 |

保留在 runner 的四个状态的理由：`activeRuns`/`activeTurns` 是 Scheduler 回调写入的在途账（`runner.ts:481`），pipeline sources 也读它；`cancellationDrains`/`shuttingDown` 是进程级取消/关机编排态，事件工厂（批次 3）经只读探针端口访问。

### 5.2 依赖方向规则

```
runner.ts ──→ execution/*（kernel、event-pump、delegate-ledger、child-spawner、termination、doom-window、原语）
execution/* ──→ turn-lifecycle.ts、event-batcher.ts、backends/types、store 的类型与窄探针接口
execution/* ──✗→ runner.ts（严禁反向 import；需要回调一律端口注入）
delegate.ts ──type-only──→ runner.ts（维持现状，不加深）
```

内核端口（批次 2 落地时的形态，名字可调，宽度不可调）：

```ts
export interface ExecutionKernelPorts {
  // 持久层只读探针：isCurrentRun 与 bumpTurnGen 的状态同步（不持有 TaskStore 引用）
  matches(taskId: string, expected: TaskExpectation): boolean
  status(taskId: string): TaskStatus | undefined
  // 会话安装/回收后的广播与工作流态清扫（runner 实现：pushTask、earlySpawns/delegateRejections/toolWindows 清理）
  onSessionInstalled(taskId: string): void
  purgeTaskWorkflowState(taskId: string): void
  // 事件批 drain（批次 2 时由 runner 实现，批次 3 后委托 EventPump）
  drainEvents(taskId: string, timeoutMs?: number): Promise<boolean>
  // 回合事件组装（批次 2 时由 runner 提供 makeTurnEvents，批次 3 后由 turn-events 模块提供）
  composeTurnEvents(req: TurnEventsRequest): BackendSessionEvents
  // closeSession 的退役会话暂存（批次 2 由 runner 持 retiredProviderSessions，批次 5 移入 termination 后收窄）
  parkRetiredSession(key: string, entry: RetiredSessionEntry): void
  // 孤儿启动句柄兜底（runner 实现：executor.registerCleanup）
  registerOrphanLaunchCleanup(key: string | undefined, stop: () => Promise<void>): Promise<void>
}
```

这是「窄端口注入」，不是被否决的 Context 袋：每个端口都是单个动作，不暴露任何 Map。

---

## 6. 逐项拆解规格

### 6.1 批次 1：原语与类型搬迁

- **目标文件**：`src/main/execution/identity.ts`、`session-turn-router.ts`、`cleanup.ts`、`git-probe-cache.ts`。
- **所有者变化**：无（均为无状态或模块内私有状态原样搬迁）。
- **做法**：逐行搬迁 + `runner.ts` 改 import 并 re-export 冻结面（§3 第 4 条）。`SessionTurnRouter`/`TurnRecord`/`RunClaim` 不 re-export 也行（smoke 不直连），但 `TURN_ISOLATION_REQUIRED`/`RESUME_UNSUPPORTED_MESSAGE`/`setGitRepositoryProbeCacheProbeForTest`/`GitRepositoryProbeCacheEvent` **必须**从 `./runner` 继续可得。
- **保持的不变量**：无行为变化（typecheck + 全量绿即证）。
- **验收 smoke**：`smoke:stage6` 全套 + `npm run smoke:turn-lifecycle && npm run smoke:turn-identity && npm run smoke:lifecycle && npm run smoke:delegate`。

### 6.2 批次 2：执行内核 ExecutionKernel

- **目标文件**：`src/main/execution/execution-kernel.ts`。
- **所有者变化**：见 §5.1 表（12 项状态归内核；`TaskRunner` 变为唯一编排者）。facade 兼容：`get turnWatchdogs()`、`get turnLifecycles()` 返回内核活引用；`sessionCount()` 委托。
- **结构性收益**：三处安装序列合并为 `installSession()`；五处任务级清扫清单里属于执行态的半部收敛进内核（`closeSession`/`forget` 登记半部/`retireExecutionState` 的内核部分/`shutdown` 的内核部分），runner 侧各自保留工作流态清扫并经 `purgeTaskWorkflowState` 端口被内核回调。
- **必须保持的时序不变量**：I1.1–I1.5、I2.2（cancel 编排仍在 runner，内核只提供原子原语）、I3.1–I3.3、I7.4。
- **行为修复（本批唯一）**：F1，见 §8。
- **施工注意**：
  - `openTurn` 在内核里需要 `composeTurnEvents` 端口（批次 3 前由 runner 提供 `makeTurnEvents`）。
  - `sendChildSummaryTurn`（`runner.ts:2433`，公共 API）手工组装 `TurnRecord` 且直接 `++this.turnSeq`（`:2441`）——批次 2 改用 `kernel.nextTurnSeq()` 签发 stamp，其余不动。
  - `terminateSession`/`terminateTaskExclusive` 批次 2 仍在 runner，经 `kernel.routerOf(session)` 读 `lastClaim`（现 `runner.ts:3242`、`:3289`–`:3291`、`:3358` 的读点改为内核访问器）。
- **验收 smoke**：`smoke:stage6` + `smoke:lifecycle` + `smoke:turn-identity` + `smoke:run-ownership` + `smoke:turn-lifecycle` + `npm run smoke:worktrees`（含 `smoke-worktree-sessions` 真 zcode detach 语义，F1 的正面证据）+ `smoke:queue-recovery` + `smoke:continue` + `smoke:runner`。

### 6.3 批次 3：事件持久化外移

- **3a `execution/event-pump.ts`**：拥有 `eventBatchers`（批 → taskId 台账），提供 register/close(taskId?)/dispose(taskId?)/size。所有者变化仅此一 Map。
- **3b `execution/turn-events.ts`**：`makeTurnEvents` 整体工厂化。端口注入：store 的 `stagePendingEvents`/`appendEvents`/`clearPendingEvents`、kernel 的 `isCurrentRun`/`lifecycle`/`touchWatchdog`、runner 的 `sniffDelegates`（批次 4 前先经端口，4a 后直连 ledger）、`observeToolCall`、`pushEvent`、`isCancelling(taskId)`/`isShuttingDown()` 只读探针、event-pump 登记。
- **必须保持的时序不变量**：I2.1–I2.5 全部；工厂内以注释锚点标注 I2.1 的四步顺序，施工禁止重排。
- **验收 smoke**：`smoke:stage6`（已含 `smoke:event-pipeline`、`smoke:event-log`）+ `smoke:lifecycle` + `smoke:turn-identity` + `smoke:retitle-cap` + `smoke:turn-lifecycle`。

### 6.4 批次 4：委派工作流外移

- **4a `execution/delegate-ledger.ts`**：拥有 `earlySpawns`（含四层嵌套态）、`delegateRejections` 双层账的内存半部、`spawnCreatesInFlight`、`workerIndexReservations`。持久层（`Task.delegateRejections`/`delegateDeliveredAt`/`dedupeKey`）仍是 store 的，ledger 经 store 窄探针读写——**双层账结构（I5.1）不得合并成单层**。
- **4b `execution/child-spawner.ts`**：`spawnDelegateChildExclusive`（约 320 行）+ `closeSpawnedChild` + `spawnInvestigateChild`。端口：store、kernel（claim/active 校验）、note/pushEvent/enqueue、`taskCreator`、`issueOps`、`getTeam`、opts。**互斥键格式（I4.3）与 dispatchHold 三步（I4.4）逐行保持。**
- **必须保持的时序不变量**：I4.1–I4.6、I5.1–I5.3。特别地 `abandonEarlySpawns` 的「先 allSettled 再撤子单」顺序在 ledger 内固化。
- **⚠ 红测锚点随迁（§3 第 6 条）**：`smoke-delegate-mutation.mjs` 中锚在 `runner.ts` 的 4 条变异（建单门禁/绑定失败收口/嗅探暂停/条件撤销）须把 `file:` 重定向到 `delegate-ledger.ts`/`child-spawner.ts`，`find` 锚文不变（逐行搬迁保证命中）。未重定向则该脚本以 `变异锚点未命中` 报错——这本身就是搬迁完整性的免费校验器。
- **验收 smoke**：`smoke:stage6` + `smoke:delegate` + `smoke:delegate-reject` + `smoke:delegate-mutation`（变异红测对拆解同样有效——它在新代码上必须仍全绿、人为回退断言必红）+ `smoke:sparse-worktree` + `smoke:queue-recovery` + `smoke:continue` + `smoke:orchestration-matrix` + `smoke:meeting-investigate`。

### 6.5 批次 5：终止协调 + doom 窗

- **`execution/termination.ts`**：拥有 `terminating`/`terminationTargets`/`retiredProviderSessions`；迁入 `terminateTask(Exclusive)`/`terminateSession`/`retireExecutionState`。`activeRuns`/`activeTurns` 以只读快照端口传入（`getActiveExecutions(taskId): { run?, turn? }`）。批次 2 的 `parkRetiredSession` 端口在本批收窄删除。
- **`execution/doom-window.ts`**：拥有 `toolWindows`/`doomRequestSeq`；`observeToolCall` 迁入，`askPermission`/`isCurrentRun` 经端口。
- **必须保持的时序不变量**：I6.1–I6.3、I7.1–I7.4、I1.2（terminateSession 的 lastClaim 校验随迁）。
- **验收 smoke**：`smoke:stage6` + `smoke:issue-pipeline`（`terminateTask`/`isIdle` 集成）+ `smoke:worktrees` + `smoke:lifecycle`（cleanup 竞速两案）+ `smoke:goal-guards`（doom）+ `smoke:permission` + `smoke:meeting-termination` + `smoke:task-service`。

### 6.6 批次 6（可选，默认不做）

`run`/`followUp`/`completeTurn` 的 FlowNode ports 对象提为 `execution/run-flow.ts`/`followup-flow.ts`。收益（行数）远低于风险（prompt 拼装与门禁交织），待 1–5 稳定一个回归周期后另行评估。

---

## 7. 指定 smoke 覆盖矩阵（六脚本 × 不变量组）

| 脚本 | 覆盖的不变量 | 明确**未**覆盖 |
|---|---|---|
| `smoke:turn-lifecycle`（83 行，纯单元） | `turn-lifecycle.ts` 契约：generation/status/owner/titleMode 准入、cancel 迟到会话清理、pendingResume 单次、invalidate 清 pending。它是批次 2 内核调用 `TurnLifecycle` 的**地基契约** | runner 侧一切：安装六步、看门狗联动、`closeSession` 的 `detachSession` 对称性、`releaseWorktreeSessions`、**F1 缺口不在其射程** |
| `smoke:turn-identity`（349 行） | 组1 回合身份面：旧回合迟到终态/事件/sessionId/权限/未知 stamp 不污染新回合（A）；组3：旧心跳不续命（B）；组2：标题回合内容去重（C）；回灌回合保护（D）；组1 路由器语义：legacy 连接首回合兼容 + 废弃重建（E） | 跨 Run（claim 换代）竞速；事件批崩溃窗；worktree 释放；`terminateTask` |
| `smoke:run-ownership`（610 行） | 组1 启动面：claim 先于启动、双实例/双进程、外来 running 不收养（1–4）；I1.2 的 **closeSession 面**（[5b] 旧身份 closeSession 被拒）；组7 部分：finalizer 捕获身份（6）；重试归属（7）；终态写失败唤醒后继（8）；活租约/死恢复（9–10）；dedupeKey（11） | I1.2 的 **`releaseWorktreeSessions` 面**（无替换 Run 同 workdir 场景）；`terminationTargets` 身份校验；看门狗；事件批 |
| `smoke:lifecycle`（376 行） | 组3：看门狗超时→重试→迟到终态不污染（1）、并发隔离（4）、启动挂死（5）；组2：取消后迟到事件不落盘 + 不误报通知（3）；组7 部分：cancel 与旧失败清理竞速、替换运行不被污染、watchdog 仍武装（cleanup 两案）；组1/5：investigate/consult 旧结果不触碰替换；被取消委派循环不打扰替换 | 组2 flush 失败分支（仅间接）；`shuttingDown` 分支；`terminateTask` 全链。**注意：它直读私有字段 `turnWatchdogs`/`turnLifecycles`，是批次 2 facade getter 的存在理由** |
| `smoke:execution-services`（53 行，纯单元） | 组7 的 **executor 子面**：迟到会话在 start 竞速被弃后关闭、preflight 拒绝不启动、拒绝的迟到会话不占槽、未确认 close 保持追踪；retry-policy 决策 | 组7 的 runner 侧全部：`terminationTargets`/`awaitExit` 编排/`worktreeSessionReleases`/`retiredProviderSessions` |
| `smoke:queue-recovery`（306 行） | 组4 恢复路径：dispatchHold 子单翻面/具名终态二分（含真实 worktree 证据矩阵）；组1 跨进程：死运行接管三态、身份未知/活租约不接管、对账幂等（`reconcileStartupTasks` 真实现） | 组4 进程内部分：`spawnCreatesInFlight` 互斥（在 `smoke:delegate-reject`）、流式嗅探；组3；组7 |

**矩阵结论（未覆盖清单，施工时的回归盲区）**：
- **G1** I1.2 的 `releaseWorktreeSessions` 面：没有任何 smoke 构造「替换 Run 的会话挂在同一 workdir 上，旧 Run 发起 release」的场景。F1 修复（批次 2）恰好落在该盲区——建议批次 2 施工时在 `scripts/smoke-worktree-sessions.mjs` 增补一案（**增补 smoke 是新增覆盖，不算“改 smoke”**，与「调用方与 smoke 不动」约束不冲突；若领队从严解读，则 F1 依赖 `smoke:lifecycle` cleanup 竞速两案 + `smoke:worktree-sessions` 既有 detach 断言兜底，并在提交说明里标注）。
- **G2** I7.2 的超时分支：`strictCleanup` 收集 problems 的路径无专项 smoke（现有脚本都走成功关闭）。
- **G3** I2.4：runner 内 flush 失败 → 具名失败终态路径仅 `smoke-event-pipeline:469`（`noBackupStore.stagePendingEvents = () => false`）间接覆盖。
- **G4** I4.3 互斥的跨实例兜底（store dedupeKey）由 `smoke:run-ownership` [11] 覆盖，进程内互斥仅 `smoke:delegate-reject` 一案。

---

## 8. 已识别行为缺口与修复归属

| 编号 | 缺口 | 证据 | 归属 |
|---|---|---|---|
| **F1** | `releaseWorktreeSessions` 摘 runner 侧登记（`runner.ts:1053`–`:1060`）时未调 `turnLifecycles.get(taskId)?.detachSession(session)`，与 `closeSession`（`runner.ts:1023`）不对称。后果：`TurnLifecycle.sessionValue` 仍挂旧会话，后继 `attachSession`（`turn-lifecycle.ts:289`–`:292`）会把已 **detach 保留**的 provider 会话当 previous sweep 掉（stop+close），违背 detach 保留语义；`cancel()`（`turn-lifecycle.ts:341`–`:346`）同理会二次关闭已释放会话 | 对照 `runner.ts:1023` 与 `:1046`–`:1060`；`turn-lifecycle.ts:193`/`:299`–`:301` | **批次 2**：内核收口 `releaseWorktreeSessions` 时补 `detachSession`（对齐 `closeSession` 既有语义，单向修复、无行为面扩大）。唯一的行为变化，随批验收 `smoke:worktrees` + `smoke:lifecycle` |
| F2 | 五处任务级清扫清单（§1.2）靠人肉对齐，新增 Map 易漏 | `runner.ts:1010`/`:1071`/`:3131`/`:3222`/`:3400` | 批次 2 结构性消除（内核收口执行态半部 + `purgeTaskWorkflowState` 单点） |

---

## 9. 分批实施顺序（每批独立过门、可单独回滚）

通用规则：
- 每批 = 1–2 个提交（子批各一个），提交信息注明批次号与迁移的符号清单；回滚 = `git revert` 该批提交，互不依赖中间态。
- 每批开始时按符号名重新定位（行号已漂移）；结束前跑 `npm run graph:index` 刷新语义索引（AGENTS.md 要求）。
- 硬门：`npm run typecheck && npm run build && npm run smoke:stage6`；下表「加跑」列是触达面的专项。

| 批 | 内容 | 加跑（在 stage6 之外） | 预计 runner.ts 减量 |
|---|---|---|---|
| 1 | §6.1 四个原语/类型文件 | `smoke:turn-lifecycle`、`smoke:turn-identity`、`smoke:lifecycle`、`smoke:delegate`、`smoke:runner` | ~230 行 |
| 2 | §6.2 内核 + F1 | `smoke:lifecycle`、`smoke:turn-identity`、`smoke:run-ownership`、`smoke:turn-lifecycle`、`smoke:worktrees`、`smoke:queue-recovery`、`smoke:continue`、`smoke:runner` | ~600 行 |
| 3a/3b | §6.3 事件外移 | 每子批：`smoke:lifecycle`、`smoke:turn-identity`、`smoke:retitle-cap`、`smoke:turn-lifecycle` | ~300 行 |
| 4a/4b | §6.4 委派外移 | 每子批：`smoke:delegate`、`smoke:delegate-reject`、`smoke:delegate-mutation`、`smoke:sparse-worktree`、`smoke:queue-recovery`、`smoke:continue`、`smoke:orchestration-matrix`、`smoke:meeting-investigate` | ~900 行 |
| 5 | §6.5 终止 + doom | `smoke:issue-pipeline`、`smoke:worktrees`、`smoke:lifecycle`、`smoke:goal-guards`、`smoke:permission`、`smoke:meeting-termination`、`smoke:task-service` | ~350 行 |

完成后 runner.ts 剩约 1000–1200 行（构造装配 + run/followUp/completeTurn/cancel/shutdown 编排 + facade 委托 + attach* 注入），每个 `src/main/execution/*` 模块 150–500 行、单一所有权。

---

## 10. 假设与待确认点（施工前请领队裁决）

1. **smoke 直读私有字段**：按「smoke 不动」约束，批次 2 用 `get turnWatchdogs()`/`get turnLifecycles()` 返回内核活 Map 保持兼容。若允许给 `smoke-lifecycle.mjs` 加三行改用公共探针，可去掉 getter——默认**不改 smoke**。
2. **F1 修复的批次归属**：默认随批次 2 同提交落地（回滚粒度一致、语义同源）。若要求批次 2 绝对零行为变化，可拆成独立小提交紧跟其后；不建议更晚（拖到批次 5 会让 detach 语义多裸奔几个批次）。
3. **G1 补测**：默认在批次 2 的 `smoke-worktree-sessions.mjs` 追加「替换 Run 会话不受旧 release 影响」一案（新增覆盖 ≠ 修改既有断言）。若从严解读「smoke 不动」，则标注为已知盲区带病上线。
4. **目录命名**：默认 `src/main/execution/`；偏好平铺（如 `src/main/runner-kernel.ts`）不影响任何设计决策，仅路径替换。
5. **design 检查基线**：新文件是主进程 TS 模块，不触 renderer 令牌，`check:design` 预期无新增；`check:architecture` 因新增 `execution/* → main` 边需确认无环（§5.2 规则已保证），每批结束跑一次 `npm run check:architecture`。
6. **变异红测的 `file:` 重定向**：批次 4 必须把 `smoke-delegate-mutation.mjs` 中 4 条 runner.ts 锚点的 `file:` 改指新文件（断言与 `find` 锚文零改动）。默认允许；若裁定「smoke 一字不动」从严执行到工装层，则批次 4 的 `sniffDelegates`/`spawnDelegateChildExclusive`/`closeSpawnedChild` 三个函数体保留在 `runner.ts`（仅状态台账外移到 ledger），拆解收益相应减少约 450 行。
