# AgentDeck 执行管线架构审查(2026-09-09)

> 起因:近两周围绕并发/委派/接力/目标模式做了多轮点状修复(本会话 5 次 + 重构会话 1 次大改),需要一次全局体检,回答"哪些是对的、哪些在互相拆台、下一步按什么顺序收敛"。
> 范围:src/main 全部执行管线(runner 945 行 + executor/retry-policy/scheduler/task-finalizer + delegate + goal-controller + store/issue-store + ipc 层),基于当日完整通读。

## 一、当前架构图(谁拥有什么)

```
┌─ 创建路径(三条,未完全统一) ────────────────────────────┐
│ ipc/tasks:create → index.createTask ──┐                 │
│ GoalController.launchNext ────────────┤→ index.createTask│  ← 唯一正规入口
│ delegate.spawnDelegateChild ──────────┼─→ store.create 直接写(绕过 createTask)
│ runner.attachContinue(接力) ───────────┘   同上           │
└──────────────────────────────────────────────────────────┘
        ↓ store.create(+issueId 语义差异,见 R3)
┌─ 调度与执行 ────────────────────────────────────────────┐
│ Scheduler(普通池 concurrency / 工人池 workerConcurrency) │
│   → TaskRunner.run:                                      │
│     状态=running → recordUser → prompt 组装               │
│     (身份+委派协议+CONTINUE_BLOCK) → 武装派单嗅探          │
│     → Executor.start(与哨兵竞速,迟到会话关闭)             │
│     → 首回合 → retitle(titleMode 静默)                    │
│     → completeTurn: 委派循环(领队)→ handleContinue → finalizer │
└──────────────────────────────────────────────────────────┘
        ↓ 每次状态变更 pushTask
┌─ 反应式订阅者(onTaskChanged 广播,顺序敏感) ─────────────┐
│ 1. publishIssueUpdate → issueStore 投影(sync/syncTask)    │
│ 2. goalController.onTaskChanged(仅 goalId 任务)→ 自动续轮  │
│ 3. ports.send('task:updated') → 渲染层                    │
└──────────────────────────────────────────────────────────┘
        ↓
┌─ 会话内协议(领队回合文本 = 控制通道) ───────────────────┐
│ <delegate> 流式嗅探(seenKeys 会话级去重)→ 即时建单        │
│ 委派循环:收编→等待→回灌→<round>评估→<review>审核         │
│ <continue> 末尾锚定 → 同 Issue 硬切新会话(链上限 8)       │
└──────────────────────────────────────────────────────────┘
```

## 二、状态机与写入方(全景清单)

| 状态 | 写入方 | 备注 |
|---|---|---|
| task.status | run(→running)、TaskFinalizer(→done)、failTask(→failed)、cancel(→cancelled)、retry schedule(failed→queued)、ipc retry/move/start、goal pause(经 cancelTask) | **7 个写者**,靠 `canTransition` 约束 |
| issue.status | issueStore.sync 投影(跟随 task)、updateWorkflow(人工 + review 流共用!)、finalizeIssue(goal 完成→done) | `updateWorkflow` 写 `statusOverride` 防投影覆盖——审核结论因此安全 ✓ |
| goal.status | GoalController.transition(controller/user 双角色)+ recover(重启→waiting_user) | 收敛良好 ✓ |
| run/ExecutionRecord | issue-store 从 task 投影 | ✓ |

## 三、确认健全的部分(不要动)

1. **cancel 全路径**:retry 待定/queued/running 三态全覆盖,级联子任务、看门狗 expire 即时释放并发槽、launchHandles+sessions+earlySpawns 清理齐全。
2. **shutdown 语义**:生命周期边界不把任务改写成 failed;retry 定时器、launchHandles 全清。
3. **retry-policy 纯函数化** + 退避可取消(clearRetry + schedule 前状态复查);测试覆盖"退避中取消"。
4. **Executor.start** 把"启动竞速 + 迟到会话关闭"收敛成一处,accept() 判定取消。
5. **seenKeys 会话级派单去重** + spawnDelegateChild 统一护栏(防环/层级/预算)——两条建单路径同一套闸。
6. **<continue> 末尾锚定**后,讨论/复述不再误触接力;relay 显式入口契约清晰。
7. **审核流写 statusOverride**,不被任务投影覆盖;每轮回灌后对 done 单逐单出结论,未出结论留人工。
8. **goal 恢复语义**:重启后 active goal 一律 waiting_user,不静默续跑。

## 四、风险登记册(按严重度)

### R1【高·系统性】组合场景零测试——"拆东墙补西墙"的根源
现有冒烟覆盖单特性(delegate/continue/goal/retry 各自),但**没有任何测试覆盖交互矩阵**:
- goal 阶段任务同时是领队(带队员)时:autopilot 续轮 × 委派循环 × 回灌再续轮
- 领队回合失败(自动重试)× 已提前建单的撤销 × goal 对 failed 的续轮判定(两套失败续轮:runner attempt 2 次 + goal failures 2 次,**叠加后一个阶段最多跑 3×3=9 次**——这几乎肯定不是设计意图)
- handoff 接力链 × goal 收养(nipi47 式:goal 收养同 Issue 最新任务,接力任务也会被收养——设计文档说是有意的,但 goal.continue 后 taskByGoal 指向接力任务,续轮语义随之改变)
**建议**:先写 3~5 条"交互场景"冒烟(真实假后端、真实时序),把上述组合的现状行为**固化成快照**;之后任何修改先跑快照。这是止住"拆东墙补西墙"的唯一办法——不是少改,而是改之前知道现状是什么。

### R2【高·资源】worktree 与集成分支永不清理
每个委派子任务建一个 worktree(`git.ts` `.agentdeck-worktrees/`)+ 集成分支 `agentdeck/task-*` + 子分支 `agentdeck/*_cN`。全仓 grep 无任何 remove/prune。长期使用 = 磁盘按"子任务数 × 仓库大小"线性泄漏,git 分支列表也会被淹没。**建议**:领队回灌完成 + 集成合并后 `git worktree remove` + 删分支(保留 diff 引用);或加设置项"保留 N 天"。

### R3【中·结构性】三条创建路径两种不变量
`index.createTask` 负责 issueId 赋值 + issue 投影;`spawnDelegateChild`/`attachContinue` 直接 `store.create`,依赖**后续的** sync 投影补 issue。历史上"看板不显示委派单"正是这条缝。任何新创建路径(比如未来的编排功能)再忘一步就是同类 bug。**建议**:把创建收敛为唯一 funnel(哪怕函数签名难看),投影创建在 create 内部完成,而非依赖调用方记得调 sync。

### R4【中·健壮性】事件管道三层门卫,语义重叠
一次 text 事件要过三道闸:外层 wrapper(runner.ts:651,查 titleMode+generation+status)→ baseEvents `active()`(查 status+generation)→ sendTurn 的 pendingResume generation 检查。三层各自为政:titleMode 只在第一层;generation 在三层各查一遍(靠 `sessionEventContexts` 可变对象保持同步——**这是隐式约定**:sendTurn 必须记得更新 WeakMap,否则静默吞事件)。本次审查确认当前无 bug,但这是未来改动最容易踩的地方。**建议**:合并为单一 `EventGate` 对象(构造时注入 titleMode/G/status 三个谓词的与),管道里只调用一次。

### R5【中·正确性】两套失败续轮叠加(见 R1 第二条)
runner 自动重试(attempt≤2,rate_limit 退避)+ goal 失败自动续轮(failures<2)。goal 的 decide 对 `failed && retryable && attempt<2` 让路(等待 runner 重试),但 attempt 用尽后 goal 再续 2 次——单阶段最坏 9 次执行。若这是有意的弹性,应写进文档;若不是,failures 上限应把 runner 的 attempt 计入。

### R6【低·正确性】handleContinue 链上限把已取消/已重试的接力都计数
`runner.ts:516` 统计 `trigger==='handoff'` 的任务数含 cancelled/failed——取消过的接力也烧链预算,极端下 8 次上限被历史失败耗尽。改为只数非 cancelled。

### R7【低·性能】嗅探 O(n²) 重扫描
每条 text delta 都对**全量 buffer** 跑一次 `parseDelegates`(领队长回合 buffer 可达 MB 级,claude 是 token 级 delta)。当前规模无感,但按"标签闭合后记录扫描偏移、只从上一个未闭合 `<` 起扫"即可摊平。

### R8【低·健壮性】review 匹配的字符串兜底
`delegate.ts:402`:`#序号` 精确匹配失败后兜底 `of === 队员名 || title.includes(of)`——同一队员多单时可能误配(精确匹配优先级在前,实际风险低,但兜底建议改为只认 `#序号`,匹配不到就留人工,现有提示已这么兜底)。

### R9【低】taskkill fire-and-forget
`cli-common.killTree` spawn taskkill 后不等待,应用立即退出时可能留下没杀干净的树。量级很小,记录在案。

## 五、建议的不变量清单(建议固化为断言/测试,写进 CI)

1. 非 suppressIssue 的任务,创建后必须存在 issue 投影(防"看板不显示"类回归)。
2. 同一领队会话内,`to+prompt` 派单 key 至多建单一次(seenKeys——已有测试,重构时必须保留)。
3. 任意时刻每任务至多一个在飞回合(turnGen 单调,迟到终态必须被丢弃)。
4. 终态任务不可自行复活;复活只能来自:手动 retry / followUp / goal continue / 自动重试,且各有唯一入口。
5. 预算闸(层级≤3、全链轮数≤8、goal maxRuns/maxDuration)在**所有**建单/续轮路径生效——含未来新增路径。
6. 回合失败 ⇒ 该回合流式期间建的未收编单必须被撤销(failTask→abandonEarlySpawns,已有)。

## 六、落地顺序建议

| 优先级 | 事项 | 理由 |
|---|---|---|
| P0 | R1 交互场景快照测试(先固化现状,不修任何东西) | 一切后续重构的安全网 |
| P0 | 决策:runner+goal 双层失败续轮叠加是否有意(R5) | 影响预算语义,重构侧需要明确 |
| P1 | R2 worktree/分支清理 | 唯一在积累的真实资源泄漏 |
| P1 | R3 创建路径统一 funnel | 消灭"看板不显示"类 bug 的土壤 |
| P2 | R4 事件门卫归一、R6 链计数、R8 兜底收紧 | 低风险小改,可攒一批做 |
| P3 | R7 嗅探增量扫描、R9 | 有需要再做 |

## 七、一句话总结

当前架构的**分层是合理的**(调度/执行/重试/收尾/投影各自成模块,goal 与委派复用同一套 task/issue 契约),最近两轮修复的关键不变量(会话级派单去重、末尾锚定接力、per-session 进程句柄、退避重试)都还在且被测试钉住。真正的系统性短板只有一个:**交互矩阵没有测试,状态机写者多而分散**——先固化现状快照,再谈任何重构,否则每一轮修复都仍在赌交互面。
