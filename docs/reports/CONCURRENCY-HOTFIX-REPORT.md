# 并发问题临时修复报告(2026-09-08)

> 背景:另一条线正在因并发 bug 做整体重构,本报告对应的是**临时止血版修复**——在现有架构上修掉已实锤的缺陷,并收紧三处协议行为。重构侧合并前请以本报告的文件清单与行为变更对照,避免两边的语义分叉。

## 一、根因(全部实锤,非推测)

### R1 后端进程句柄单例——孤儿进程 + 误杀(429 残留的来源)

`codex / claude / opencode / dsh` 四个一次性 CLI 适配器共用一个模块级 `let live` 句柄:

- 多任务并发时,`stop()/close()` 杀的永远是**最近启动**的那个进程 → 该停的没停(孤儿继续打 API,429 持续),不该停的被误杀(触发自动重试,请求量翻倍,与 CLI 内部重试叠成正反馈)。
- `child.kill()` 只杀直接子进程,CLI 自己拉起的孙进程(工具/shell)会残留。

### R2 自动重试"整个任务从头重来"

`maybeAutoRetry` 注释写"第 1 次优先带会话续跑",但 `run()` 从未向 `backend.start` 传 `resumeSessionId`——每次重试都拿原始 prompt 开全新会话,已完成的工作全部重做。

### R3 硬切(阶段接力)误触发面过宽

三条触发路径都偏松:

1. followUp 里 `/下一阶段|next phase/` 正则命中即把整条用户消息替换为 HANDOFF_CUE 祈使指令——**讨论方案也被当成"进入下一阶段"**;
2. `parseContinue` 匹配文本任意位置、`start` 缺省按 `auto` 立即执行——agent 复述/引用协议文档即可触发;
3. 协议提示词附带完整标记示例,模型照抄即触发。

### R4 派单看板滞后整整一个回合

子任务在领队**整个回合结束之后**才创建(`completeTurn → runDelegationLoop`),领队首回合动辄几十分钟,期间看板无任何新增。且超出 `workerConcurrency` 的派发单被**直接丢弃**(仅留一条 ⚠ 事件)。

## 二、修复清单

### 1. 进程生命周期(`src/main/backends/`)

| 文件 | 修复 |
|---|---|
| `cli-common.ts` | `killTree()`:Windows 走 `taskkill /pid <pid> /T /F` 杀整棵进程树;idle 超时与输出超限同样走树击杀 |
| `codex.ts` `claude.ts` `opencode.ts` `dsh.ts` | 删除模块级 `live` 单例,改 **per-session 句柄**(`runOnce` 增加 `onSpawn` 回调落点);每个会话的 `stop/close` 只杀自己的进程 |

### 2. 重试语义(`src/main/runner.ts`)

- `run()` 现在传 `resumeSessionId: task.sessionId || undefined` → 自动重试第 1 次**从失败处续跑**;手动"重新运行"清 sessionId,恒新会话不受影响。
- `rate_limit`(429)重试前默认**退避 60s**(`AGENTDECK_RETRY_DELAY_MS` 可覆盖,测试置 0);退避期间任务保持 failed 可见、可被取消打断;`schedule()` 前复查状态,用户已处理则放弃。

### 3. 硬切触发面收紧

- **自由追问不再按关键词猜测接力意图**(删除正则翻译路径)。接力唯一人工入口 = TaskDetail 的「⇥ 接力下一阶段」按钮,经新增 `followUp(id, content, { relay: true })` 显式参数全链路传递(`contracts.ts` → `preload/index.ts` → `index.ts` IPC → `task-service.ts` → `TaskDetail.tsx`)。
- `parseContinue`(`delegate.ts`)**末尾锚定**:标记后只允许空白,正文/示例/复述文档中的标记不构成接力意图;`start` 只有显式 `="auto"`(带引号)才立即执行,缺省/写错/无引号一律 fail-safe 按 `parked` 备好待人工启动。
- AI 自发判定保留(`CONTINUE_BLOCK` 协议措辞同步收紧为"回复最后一行")。

### 4. 派单:闭合标签即建单(流式增量解析)

- runner 事件管道新增**流式派单嗅探**:领队会话(`run()` 与 `followUp()` 均武装)逐条 `text` 事件增量累计,一个 `<delegate to=…>…</delegate>` **闭合即建单入队**(按 to+prompt 去重)。看板在领队回合进行中就能看到子任务。
- **不打断主运行**:队员结果仍只在领队回合结束后经委派循环注入(协议未变);委派循环每轮 `takeEarlySpawns` 收编提前单进等待/回灌,与终态解析的新单合并去重。
- 建单统一收敛到 `runner.spawnDelegateChild()`:目标解析、防环、层级闸(≤3 层)、**全链轮数预算闸(≤8)**两条路径同一套护栏;worktree 基线分支显式传(缺省会从当前 HEAD 漂移);`index.lock` 冲突重试 2 次。
- 超出 `workerConcurrency` 的派发单不再丢弃,进调度器排队(并行上限仍由 workerConcurrency 管)。

### 5. 顺手修复

- `issue-store.ts`:`sync()` 中 `runId` 声明先于 `.find()` 使用的 TDZ 崩溃。
- `App.tsx` 导入的 `components/goal/GoalsView` 缺失 → 新建视图(降级容错:goals IPC 未就绪时显示提示,不抛未处理异常)+ `GOAL_STATUS_LABELS` + 样式。
- `index.ts`:`goalController` 明确赋值断言,消除 TS2454。

## 三、自审发现并已修复的问题

初版实现自查出 4 个缺陷,均已修复并有回归覆盖:

| # | 问题 | 修复 |
|---|---|---|
| 1 | 提前建单路径绕过轮数预算闸——预算耗尽的子领队回合中仍会建出无人收编的孤儿单 | `spawnDelegateChild` 补 `MAX_TOTAL_ROUNDS - inherited <= 0` 拒绝闸 |
| 2 | 领队回合失败时,流式期间已建的单继续跑:无人等待、结果不回灌、不进集成分支 | `failTask` 统一 `abandonEarlySpawns`:取消仍在排队/运行的提前单并留痕(对齐旧语义——失败回合不产生子任务) |
| 3 | 标记在回合最后一刻闭合时,委派循环取到未决建单(childId='')→ 该子任务被整轮跳过,结果永不回灌 | `takeEarlySpawns` 改 async,先 `await` 未决建单 promise 再交出登记 |
| 4 | worktree 创建漏传基线分支参数 → 从当前 HEAD 建,领队中途动过分支时子任务基线漂移 | `spawnDelegateChild` 显式取 `currentBranch` 传入 |

## 四、验证

- `tsc --noEmit` 通过;`electron-vite build` 三 bundle 构建通过。
- **16 项冒烟全过**:runner / taskflow / issues / migration / flow / failure / diff / event-log / ipc-validation / cli-adapters / cli-errors / git-errors / turn-model / permission / final-dedup / round。
- 新增回归场景:
  - `smoke-delegate.mjs` 场景 C——流式提前建单、不重复、结果仍回合末回灌、改动照常合入集成分支;
  - `smoke-continue.mjs` D1——自由追问提到"下一阶段"**不再**触发硬切;D2——按钮 relay 显式触发 auto 接力;
  - 解析单测:非末尾标记不识别、缺省 start → parked、无引号写法 fail-safe。
- `smoke-retry.mjs` 以 `AGENTDECK_RETRY_DELAY_MS=0` 验证退避不破坏原重试语义(429 重试至 done、上限 2 次、非瞬态不重试)。

## 五、codex 并发压测(2026-09-08,本机,gpt-5.6-sol)

`scripts/stress-codex.mjs`,每档同时发起 N 个 `codex exec`,极小 prompt:

| 并发 | 成功 | 429 | 延迟 min/avg/max |
|---|---|---|---|
| 1 | 1/1 | 0 | 26s |
| 2 | 2/2 | 0 | ~24s |
| 4 | 4/4 | 0 | ~24s |
| 8 | 8/8 | 0 | 17s / **55s** / **98s** |
| 12 | 8/12 | 0 | 26s / 56s / **124s**(4 个超 180s) |
| 16 | 15/16 | 0 | 26s / 47s / 94s(1 个超时) |

**结论**:到 16 并发无硬 429,瓶颈表现为排队延迟劣化(8 并发起 avg 翻倍,12+ 出现 3 分钟级请求)。此前撞到的 429 更可能是**瞬时请求风暴**(孤儿进程 + 误杀重试 + 无退避重试叠加),本修复(R1/R2)正好对症。默认 `workerConcurrency=3` 安全,激进可用 6–8。复测:`node scripts/stress-codex.mjs 24,32`。

## 六、用户可见的行为变化

1. 取消/停止任务不再残留 CLI 进程(任务管理器可验证);并发任务间不再互相误杀。
2. 429 后任务先显示"退避 60s 后自动重试",不再立即重打;重试从失败处续跑而非从头再来(手动"重新运行"仍是从头)。
3. 追问里聊"下一阶段"不会再被切会话;要接力请点「⇥ 接力下一阶段」按钮。agent 自发接力只在标记位于回复末尾且显式 `start="auto"` 时立即执行,其余一律备好(parked)等你启动。
4. 委派子任务在领队回合进行中即出现在看板/列表,不再等到整个回合结束;超出并行的派发排队而非消失。

## 七、遗留风险与重构侧注意事项

- **本轮触及文件**(重构合并时重点对照):`src/main/runner.ts`、`src/main/delegate.ts`、`src/main/backends/{cli-common,codex,claude,opencode,dsh}.ts`、`src/main/{index,issue-store}.ts`、`src/shared/contracts.ts`、`src/preload/index.ts`、`src/renderer/src/{task-service.ts, components/TaskDetail.tsx, components/goal/GoalsView.tsx, labels.ts, styles.css}`、`scripts/{smoke-continue,smoke-delegate,smoke-retry,smoke-round,stress-codex}.mjs`。
- 退避等待用 `setTimeout` 挂在主进程:应用退出会丢掉待重试任务(下次启动为 failed,可手动重试),可接受;重构时可换成持久化调度。
- `followUp` 的 relay 是显式契约(`contracts.ts`),重构若改 IPC 签名需两侧同步。
- 派单嗅探依赖后端发 `kind:'text'` 事件(codex/claude/opencode 均满足);不发 text 的后端自动退回"回合末建单"旧路径,无功能损失。
- 压测只覆盖 codex 单平台;claude/zcode 的并发阈值未测,建议沿用保守 workerConcurrency。

## 八、阶段 8 收口复验（2026-09-08）

- hotfix 已收敛进拆分后的 runner 服务边界：调度、启动竞态、权限、重试策略和终态收尾分别由 `Scheduler`、`Executor`、`PermissionBroker`、`retry-policy`、`TaskFinalizer` 承担。
- IPC 已从 `index.ts` 移到 `src/main/ipc/` 的 goals/tasks/issues/catalog/system 注册器；所有写入口先接收 `unknown` 并运行时校验。
- ZCode 的 JSON-RPC transport 与配置/模型目录已分别移到 `zcode-transport.ts` 和 `zcode-config.ts`；一次性 CLI adapter 使用 JSON object guards。
- `npm run smoke:all`、真实 `smoke:clis`、真实 `smoke:zcode` 与 `npm run dist` 通过。
- runner fake-provider 回归直接覆盖两个并发会话：取消 A 后 B 正常完成，且 stop 句柄只作用于 A。
- 本轮真实 Claude/Codex/OpenCode/ZCode 验收未出现 429；Codex 单任务约 46 秒，观察到的限制仍是排队延迟而非硬限流。历史 1/2/4/8/12/16 压测数据继续保留，不以单次成功推高默认并发。

## 九、生产事故追补:同一派单重复建单(2026-09-09 当日发现并修复)

**现象**:领队一回合内同一份工作出现两份委派单(存储中幽灵任务 `t_mtswisho_zl110s`/`t_mtswisij_ags93t`,与真实子任务标题完全一致,创建时间晚 21 秒;用户删除后 issue 投影残留 YOU-32/33 cancelled)。

**证据链**(领队 `t_mtsvttuv_tus8il`,zcode,events.jsonl 逐 delta 重放):

1. seq=175–181:两个派发标签随流式 delta 闭合,嗅探器正确建单 2 个(去重正常);
2. seq=184(+1147.9s):委派循环第 1 轮收编这 2 个单——`takeEarlySpawns` **清空了去重登记,但嗅探缓冲区里标签文本仍在**;
3. seq=186/187(+1164.4s,回合收尾阶段的新文本):触发重扫描 → 缓冲区中两个标签的 key 已不在登记 → **原样再建一遍**(两幽灵任务创建时间与该文本事件相差 ≤275ms)。

**根因**:去重登记的生命周期(被 take 清空)短于解析源的生命周期(缓冲区整个领队会话常驻)。领队后续任何文本(回灌回合复述派单、评估、retitle 等)都会让重扫描把已派发的标签当作新派单。

**修复**(`runner.ts` + `delegate.ts`):

- 嗅探登记新增 `seenKeys`,**一经出现、永不遗忘**(spawned 只表示"在途",交付后 key 迁入 seenKeys);
- `takeEarlySpawns` 返回 `{ entries(未交付的建单), seenKeys(全量已见 key) }`,不再破坏登记;
- 委派循环的 `fresh` 过滤改用 `seenKeys`——领队在回灌/评估回合里复述旧派单标记,循环与嗅探两侧都识别为已派单,绝不重建。

**回归**:`smoke-delegate.mjs` 场景 C 扩展——领队在回灌回合逐字复述同一 `<delegate>` 标记,断言子任务仍为 1 个(命中循环侧 seenKeys 过滤路径);sniff 侧由同一次重放逻辑覆盖。delegate/continue/round/flow/runner/retry 冒烟全过,tsc 通过。

**给重构侧**:若拆分 runner/delegate,请保留两条不变量——(a) 派单 key 的去重集合生命周期 ≥ 领队会话生命周期,不得随"收编"清空;(b) 循环侧新建单前必须用同一份 seenKeys 过滤,只靠收编条目过滤会在复述场景下漏判。

## 十、"同一任务派了三次"排查结论(2026-09-09,非重复,三项体验修复)

**数据核实**(领队 `t_mtsxm8lt_nipi47`,二层委派 `04dic5 → nipi47 → 3×flash`):三个子任务 prompt md5 各不相同(dc840110/199e3df7/7b42a308),diff 确认分工互斥——分别负责 LEARN-CLAUDE-CODE+CC-HAHA、RUFLO+DEER-FLOW、OPENCODE+OUROBOROS 六份 teardown 报告中的两份。**是有意的三路并行,不是重复派发**;嗅探时序也正确(标签闭合后 ≤0.5s 建单)。

**但暴露三个真实体验/隐患问题,已修**:

1. **看板三张卡片标题一模一样**(标题 = prompt 前 40 字,三份派单共享同一开场白)→ 观感即"同一任务派三次"。修复:`spawnDelegateChild` 与兄弟任务撞标题时追加 ` #N` 序号。
2. **派单发生时领队气泡零反馈**:建单即时完成,但转录里没有任何即时留痕,循环收编提示要等回合末——人和模型都容易以为没派出去。修复:每次建单即时写 `⚡ 已接单:队员 ← 任务摘要` 状态事件。
3. **模型侧误判"派单失败"而重派/亲自重做**:委派协议文本补充明确契约——标记闭合即并行建单、结果本轮末自动回灌、不要因没看到动静而重派或重做、已派工作不要输出第二次。

**顺带关闭一个潜在重复向量**:循环侧 `fresh` 新建的单此前不登记 seenKeys(本次因嗅探侧已登记未触发);现改在 `spawnDelegateChild` 内统一登记,两条建单路径共用同一份会话级去重。

验证:tsc 通过,delegate/round/continue/runner 冒烟全过。
