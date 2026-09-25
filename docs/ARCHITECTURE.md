# AgentDeck 架构文档
> ✅ 校验于 `6b2f038` / v0.22.0-hot.19（2026-09-19 文档审计）

> 🧭 **差异注记（2026-09-19，基线 `6b2f038` / v0.22.0-hot.19）**：总览、Issue-first 工作模型、关键数据流与可靠性设计仍准确；差异如下——
> **模块地图（§3）未收录** 0.14 以来新增的主进程模块：`src/main/hot/`（9 文件，热更）、`bootstrap.ts`、`retention.ts`（终态 Issue 30 天清理，0.22.0）、`meeting-controller.ts` / `meeting-store.ts` / `agent-sessions.ts` / `agent-exchange.ts` / `agent-forge.ts` / `acceptance-verifier.ts` / `task-service.ts` / `turn-lifecycle.ts`、`sidecar.ts` / `sidecar-runtime.ts` / `sidecar-server.ts`，以及 `ipc/meetings.ts`、`ipc/updates.ts`。
> **导航与视图（§1/§7）过时**：全局「会议 / 目标」导航页已删除（0.18.0），两种模式收敛进 Issue（0.22.0 起为浮窗 + header 进度芯片）；应用默认落地看板；详情页常驻右侧栏已移除、改 SideDock 行布局分栏（0.22.0）。渲染层新组件：`ui/SideDock.tsx`、`ui/FloatWindow.tsx`、`CodeViewer`、设置页 UpdatePanel。
> **测试基线（§8）**：`smoke:all` 已从 25 套件扩至 **46 套件**（新增 meeting×4、goal-guards / goal-spec、orchestration-matrix、worktrees、lifecycle / turn-lifecycle、task-service、sidecar、opencode-server、board-retention、edit-meta、file-diff、dsh-acp / dsh-budget、delegate-reject、retitle-cap 等）。


> 对齐 v0.13.x。本地多 agent 协作台：五个 agent CLI 平台（zcode/claude/codex/opencode/dsh）同队，Issue-first 工作流，委派内置、领队自主拆解派工，目标模式在 Issue 内自动推进，全程本地运行。

---

## 1. 总览

```
┌────────────────────────────────────────────────────────────────┐
│ Electron 主进程（Node）                                          │
│                                                                │
│  index.ts ── 依赖装配 ──► ipc/（按领域注册 channel，入参全量校验）    │
│      │                                                         │
│  TaskRunner ── Scheduler/Executor ──► backends（5 个适配器）       │
│      │   ▲                    │        │        │        │      │
│      │   └── attachTeam       zcode   claude   codex  opencode  │
│      │       (agents.json)   (常驻)   (一次性×3)        dsh      │
│      │                                                         │
│  delegate.ts ◄──委派循环（领队回合后驱动）                          │
│  goal-controller.ts ◄──目标模式循环（每轮 Task 终态后驱动）          │
│  automation-store + 15s tick ◄──定时触发                          │
│      │                                                         │
│  TaskStore / IssueStore / GoalStore（文件存储）                    │
│  git.ts（worktree 创建/回收/合并/快照）                            │
└──────────────┬─────────────────────────────────────────────────┘
               │ preload（contextBridge → window.agentdeck）
┌──────────────┴─────────────────────────────────────────────────┐
│ 渲染进程（React）                                                 │
│  App → 侧栏导航：Issue（队列/详情）/ 看板 / Agent / 会议 /        │
│         目标 / 自动化 / 技能 / 用量 / 设置                         │
│  TaskDetail（日志/结果/Git/子任务/权限/GoalPanel 侧栏）             │
└────────────────────────────────────────────────────────────────┘
```

无云端、无服务进程、无数据库——应用状态全部在 `userData/` 的 JSON/JSONL 文件里；用户资产（技能库）在独立共享目录（默认 `~/.agentdeck`，可配置），两者互不混写。

## 1.1 产品级工作模型（Issue-first）

AgentDeck 的用户工作单元是 **Issue**，不是无限增长的聊天会话：

```
Issue（目标、状态、负责人、评论时间线）
  └─ Run × N（每次指派、提及、自动化、目标阶段或手动执行）
       └─ Task（本地 CLI 执行兼容记录）
            └─ Goal 阶段（goalId + phaseIndex 标记，可选）
```

每个 Run 都保留独立的状态、触发来源、执行日志和用量。成功/失败结束后，IssueStore 将结果写成带 `runId` 的 Agent 报告评论；用户可以在同一 Issue 的评论中 `@agent`，触发新的 Run，而不会创建新的 Issue。Task 仍负责进程、事件流、会话恢复和 git 快照，作为本地执行层兼容契约。Goal 是叠加在 `Issue -> Run -> Task` 之上的持久化状态脊柱（§7.1），不替代该模型。

---

## 2. 核心概念

### 2.1 Agent（队员）

`{ id, name, backend, model?, presetId?, role?, systemPrompt?, subordinates?, note?, color }`

- **身份**：定位 + 系统提示词，注入该队员的每个任务（`buildAgentPrompt`）
- **能力**：`subordinates` 非空即领队——任务提示自动附加委派协议，对话中可派工
- **模型/连接**：可钉死模型（`model`）或绑定 API 预设（`presetId`——预设是全局连接档案，不绑定平台；baseURL/apiKey 按会话内存注入，不写全局配置，注入执行目前仅 zcode / claude 支持）；平台模型目录经 `agents:models` 拉取
- 同一平台可建多个队员（如"Claude 审查员"），身份互不相同
- 预置五名：ZetCode（领队，GLM）、Claude、Codex、OpenCode、DeepSeek

### 2.2 Task（任务）与委派

子任务通过 `parentTaskId` 挂在领队下（侧栏缩进展示）；领队集成结果记 `Task.integration {branch, note}`。支持二层委派：队员带 subordinates 即为子领队，可继续下派——防环（祖先链检测）+ 层级上限 3 层 + 全链共享 8 轮预算；派工可带 reason 留痕；集成递归合入子领队的集成分支；worktree 一律归位主仓库根。**worktree 建立失败 fail-closed**：建树重试 3 次仍失败即具名拒单走既有回灌通道（文案含首次 git 错误与「worktree 建立失败，请稍后重派」），不再降级共享工作区——降级会让队员在旧基线上白写、并行队员互相踩，隔离破了等于白派单；仅 workdir 非 git 仓库的环境性共享降级保留。

回灌增厚：每轮结果汇报为**结构化摘要**——条目标题即单号+状态，体由「结论段（result 首部 1200 字有界；码点级切割——切点不孤立代理项、落在未闭合 ``` 围栏内时截至块前；与 git 小节同源过序列内部破坏转义）+ **git 改动小节**（工作分支名、`--name-status` 文件状态清单、文件 stat、有界 diff 摘要；整节 ≤2KB 按 UTF-8 字节计、文件清单 ≤50 行，超限按字节收缩留标记）+ **全文入口指引**（报告副本相对路径 + Issue 评论）」组装；4000 字物理截断只是最后防线（同样码点级），触发必须带「后 N 字未送」标记。摘要之外是**全文双落**（multica「nothing silently discarded」）：队员到达终态（含 failed）即把完整 result 同时落到 ① 领队**主仓库根** `.agentdeck-reports/<单号>.md`（**副本先行落盘=权威层**；worktree 内写入经 `git-common-dir` 归位主仓库根——领队续链切到托管 worktree 后副本不再散落在随时可回收的目录里；目录自建，`.git/info/exclude` 追加忽略，不改 tracked 文件零污染；文件头带 runId 防串轮；指引按领队 cwd 用 `reportCopyRelPath` 重算相对路径）与 ② 领队 Issue 评论（**64KB UTF-8 字节通道上限**：码点级钳制、预留截断指引字节预算，截断评论持真实副本路径指引回权威层；`addComment` 因 Issue 不存在返回 null 时必须降级留痕——统一走 `src/main/issue-relay.ts` 的降级出口：console.warn + 任务事件 + pushEvent，重启续报/审核备注/停放通知（主进程×3 + sidecar×1）全部接线，绝不静默丢弃）。副本生命周期三挂线 GC：`tasks:delete` 显式回收、retention 级联随删、启动清扫孤儿副本（清孤儿、留在册）。指引文本与 git 小节同源（队员可控文本），整体用围栏包裹，协议字面量再做**序列内部破坏**：六类回合标记（delegate/review/consult/investigate/round/continue）的开闭形态、行首三连井、`【系统` 前缀与 ``` 围栏字面量，在末字符前插 `\`（如标记字样呈 `<delegat\e` 形）——六个回合解析器全是非锚定子串正则（行中同样命中），行首加前缀转义拦不住，必须让原字面量子串不再连续出现；diff `+/-` 行与未跟踪文件名（逐项独立转义）一视同仁，人读几乎无损。队员改的文件里不能伪造领队协议；无 diff 可展示时不留悬空的「diff 摘要：」标题。

子单基线回放（multica「工作区即状态」不变量）：worktree 隔离曾导致队员看不见领队的未提交改动——派单等于让队员在旧基线上白写。现在 `spawnDelegateChild` 在建好 worktree 之后、子 agent 拿到 cwd 之前，把领队工作区的未提交增量（已跟踪改动 + 未跟踪未忽略文件）**只读采集**回放进子单：`GIT_INDEX_FILE` 指向私有临时 index（从领队 index 副本播种，失败退 `read-tree` 重建——兜底保留）→ `add -A`（排除 `.agentdeck-worktrees`/`.agentdeck-reports` 系统目录）→ `write-tree` → `commit-tree`（parent=子基线 sha）得回放提交 → 子 worktree `cherry-pick --no-commit` 应用 → `reset --soft` 推进子分支到回放提交。reset --soft 失败、后续 status 失败或状态非空，均执行 `reset --hard` 回到子基线，并核验子分支 HEAD、index tree 与 status；无法核验时明确报告回滚未验证。**硬约束：采集过程不修改领队工作区与用户 index**——全程使用私有 index，并清除父子 Git 子进程继承的仓库重定向变量（包括 `GIT_DIR`、`GIT_WORK_TREE`、`GIT_COMMON_DIR`、`GIT_INDEX_FILE` 和对象目录变量）。**锁加固**：回放全部 git 调用注入 `GIT_OPTIONAL_LOCKS=0`（只读命令不再 opportunistic 拿 index 锁，领队侧持有 index.lock 时盘点照常），任何步骤撞 index.lock / Another git process 都按 400-900ms 抖动退避重试 2 次而非立即拒单，耗尽才拒且文案指明「领队 git 并发写冲突，请稍后重派」。**子侧陈锁清除**：子侧应用段（cherry-pick/reset/status）重试耗尽仍是锁错时，子 worktree 的 index.lock（`rev-parse --git-path index.lock` 定位真实路径）mtime 距今超 5s 视为建树竞态残留（子 worktree 刚建、子 agent 未启动、无并发写者，锁必为残留而非活锁），`fs.unlink` 删除后追加最后一次尝试；锁新鲜（真活锁）或删除失败按重试耗尽处理；领队 workdir 侧的锁一律不删（可能属用户真实 git 进程），只用既有退避重试。防双算：回放提交即子分支起始提交（tip），worktree 元数据的 `baseSha` 改写指向它——此后 digest/集成证据都以它为基线，领队改动不算子产出、不进子 git 小节；集成说明与时间线事件标注「含领队回放基线 N 文件」。失败路径不静默：采集或应用失败、或体量闸超限（未跟踪文件数 >2000、总体积 >200MiB、含软链——lstat 逐一检查，软链拒单带可操作指引「gitignore、先提交或移出领队工作区后重派」），一律具名拒建单并把原因回灌给领队改派；拒建后的 worktree 回收失败记入领队任务时间线，不宣称现场已清理；未跟踪盘点（`ls-files`）超时（15s 含锁退避）同样即拒单——宁可拒建单也不拿残缺清单当基线静默回放；领队无增量时仍核对原有暂存路径与 index 差异后才能跳过；暂存文件消失或暂存增量与工作区不一致一律拒建单。

暂存竞态防护：采集前与 `add -A` 后，对全部将回放的路径（含已跟踪 M 路径）检查各级父目录，拒绝指向仓库外的 Windows junction；正常已跟踪删除允许文件缺失。原已暂存的已跟踪 M/D 等状态和私有 index 采集结果逐项核对，暂存后工作区恢复 HEAD、内容另有变化或删除被撤回时具名拒单，不静默丢失原暂存内容。私有 index 的新增路径、对象类型和 blob 体积复核先前盘点的未跟踪清单；盘点后新增、消失或变成软链的文件均拒建单并要求重派。原已暂存新增路径也逐项复核父目录与文件类型；只有 blob 对象 ID 未变化时保留计数豁免，变化时按实际暂存 blob 纳入文件数和体量闸。采集阶段拒建不修改领队 index 或子分支 HEAD；软重置后的拒建必须先验证子侧回滚，验证失败会明确标记残留风险。

基线回放的已知取舍（文档化，不做自动去重）：集成分支会含回放提交，而领队原工作区仍持同一份未提交改动——跨线合并是人/后续流程的事（对齐 multica 立场），集成证据与 UI 说明负责把这件事说清。`.gitignore` 排除的依赖目录（node_modules 等）不参与回放——子单需要完整依赖时领队应先提交 lockfile，这是写明的边界而非缺陷。

续链换基线：集成成功后系统为领队新建托管 worktree 检出集成分支 `agentdeck/task-<id>`，并把 `task.workdir` 指过去——此后追问/续聊/目标模式及二次派单自然以集成结果为基线（子单 base=集成分支；基线已切换后的再集成在托管 worktree 内就地 merge）。**续链互殴修复（就地 merge 三道工序）**：① 就地 merge 前先对领队集成 worktree `commitAll`——领队留在托管 worktree 的未提交交付先行落盘（曾几何时这份改动会触发干净校验拒掉整轮集成、任务带着空集成说明静默 done），本轮证据基线 roundBaseSha 取 commitAll 之后的 HEAD：领队交付计入集成分支净新增提交（finalizer headSha 观测链自洽），diff 证据以它为基线不与队员改动混算；② commitAll 后仍不干净或就地被拒（非冲突）→ 退回**临时 worktree 通道** `mergeIntoManagedWorktreeDetached`：同分支双检出用 `--detach` 检出分支当前提交、merge 后 `update-ref` 回指分支，托管副本由 `realignCleanWorktreeToHead` 对齐；③ 失败原因一律写集成说明（note 非空）+ 时间线事件，绝不静默 done。就地 merge 前置校验托管 worktree 的 owner 归属保留不变。会话绑定工作目录：`task.workdir` 变更后追问不再直续旧目录里的内存会话，强制走 resume 重建（新连接以新 workdir 启动，会话内容经 sessionId 恢复）；切换前领队留在原目录的未提交改动先摘录收编进本轮证据，不从 gitDiff/gitStat 静默消失。用户当前分支与仓库根工作副本绝不被自动改；无改动早退、集成失败路径不切换。

幻影暂存守卫（`realignCleanWorktreeToHead`，update-ref 回指后托管副本对齐的唯一通道）：判脏后先 `update-index --refresh` 再重判——刷新成功且残余脏仅在暂存列（index 陈旧，典型即分支被 update-ref 前进而副本停在旧提交的形态）照常 `reset --hard` 对齐；未跟踪或工作副本列有改动 = 领队真实未落盘改动，fail-closed 拒绝对齐、现场保留；refresh 撞 index.lock（并发）按锁退避重试（400-900ms 抖动 × 2），耗尽 fail-closed。守卫保证退回临时 worktree 通道后副本干净、finalizer headSha 观测链自洽，且下一轮 commitAll 不回滚已合入改动（否则对齐失败会留旧树副本，下轮提交把集成分支倒卷回去）。

集成结果与清扫的不变量：merge 只在集成分支 HEAD 真实前进时计入（Already-up-to-date 不产生新提交，本轮无净新增时整体省略证据键，上一轮 gitDiff/gitStat/gitSnapshot 保留——finalizer 跨轮保留直接观测集成分支 HEAD 与快照记录的采集时点 headSha 一致才重盖时间戳，不从工作副本干净推断；部分失败轮（分支已前进但不写证据）的过期 diff 拒绝重盖为本轮证据）；续链 worktree 的保留判定只按 `owner.integration.branch` 认归属（不依赖 task.workdir 仍指向它），启动清扫一律**不删集成分支**——集成分支只有删任务的显式回收路径（tasks:delete）可以带走；owner 任务在册且终态 cancelled 的子单 worktree 同样跳过清扫回收（cancelled 对终态落盘是例外，现场原样保留，目录与分支都留，删任务显式路径统一回收）；worktree 落盘与目录创建拆两步，operation 释放后立即落盘归属，放弃窗口留下的也是已登记的续链 worktree。清扫自动回收必须有与仓库、路径吻合的 owner metadata；池条目还须通过池进程身份判定，临时 merge 脚手架在创建成功后写入独立归属侧车。托管目录名、分支命名和终态清扫租约本身都不构成资源归属证明。

没有"协同模式"开关——**委派是领队队员的内在能力**：

```
用户 → 领队：升级 utils.py 并补文档
领队回合1：判断两件事可并行 → 输出 <delegate to="Claude">…</delegate> ×2
   ├─ 系统截获标记：sanitize 路径 → 各建 worktree → 子任务入队（独立并发通道）
   ├─ 子任务各自执行（真并行，互不污染）
   └─ 全部终态后结果带单号回灌领队会话
领队回合2：对每个 done 单输出 <review> 审核 → 核验、收尾（可再派/可自己做）→ 最终总结（无标记）
系统：子任务分支合入 agentdeck/task-<id> 集成分支；领队结果剥除标记落盘；领队 workdir 切到集成 worktree（续链基线）
```

设计取舍：

| 决策 | 理由 |
|---|---|
| 协议用输出标记而非注入原生工具 | 各 CLI 无统一工具注入面；标记法对任何可续聊后端成立 |
| 子任务在独立 git worktree | 真并行 + 零冲突合并；用户当前分支永不被自动改 |
| worktree 用后即回收 | 合入集成分支后立即 removeWorktree + 删工作分支；删任务连带回收；启动清扫兜底（续链集成 worktree 例外：只按 integration.branch 认归属、任务存在期间保留，且清扫路径绝不删集成分支——它持有未合并的唯一集成结果） |
| 回灌附 git 改动小节（≤2KB 有界） | 集成前领队就能看到队员真实改动面（分支/stat/diff/name-status），不再只信文字总结 |
| 摘要只带结论段（1200 字有界）+ 全文双落（Issue 评论 + 报告副本） | 摘要回灌是索引不是载体：全文不随领队会话生死、不因 Issue 缺失静默丢失；4000 字截断只是最后防线且必须留痕 |
| 子单基线回放（领队未提交增量进子单） | 队员在真实最新基线上干活，不再「队员看不见领队改动＝白派单」；私有 index 采集，领队工作区与用户 index 保持不变；无增量零开销 |
| 集成分支含回放提交（已知取舍，不做自动去重） | 领队原工作区仍持同一份未提交改动，跨线合并是人/后续流程的事；集成证据与 UI 说明标注「含领队回放基线 N 文件」；gitignore 掉的依赖目录不回放（子单需完整依赖时领队先提交 lockfile） |
| 集成后续链换基线（workdir → 集成 worktree） | 追问/二次派单跑在集成结果之上，不再拿旧基线重复劳动；只动托管目录，不碰用户工作副本 |
| 续链轮就地 merge 前先 commitAll 领队交付 + 非冲突被拒退回临时 worktree 通道（--detach + update-ref 回指 + 幻影暂存守卫对齐） | 领队在托管 worktree 里自己写的文件曾把整轮集成拒成静默失败（空 note、队员改动悬空 retained）；领队交付与队员改动同轮进集成分支，失败原因进集成说明不静默 done |
| Issue 评论统一降级出口（issue-relay）+ 64KB 通道钳制持真实副本路径 | 「评论未送达」曾是四处各写各的降级、漏一处即静默丢；钳制后指引回副本，权威层（先行落盘的全文副本）永不因评论通道失真 |
| 报告副本统一落主仓库根 + 三挂线 GC（tasks:delete / retention 级联 / 启动清孤儿） | 副本落 workdir 曾随续链切进随时可回收的托管 worktree；统一归位主仓库根后可达性稳定，删任务/保留清扫/启动清扫三条路都不留孤儿全文 |
| 结果回灌而非子任务直连领队 | 领队保有完整决策上下文，可多轮调整；单号 + `<review>` 审核（maker/checker）落看板状态 |
| 领队编排不占并发槽 | 避免 concurrency=1 时领队等子任务、子任务等领队的死锁 |
| 子任务并发独立通道 | 委派扇出不受普通任务节流影响 |

### 2.3 后端抽象

`AgentBackend`（probe/start）+ `BackendSession`（send/stop/close）统一两种进程模型：

- **常驻服务型**（zcode；dsh 走 ACP 时同属此类）：stdio JSON 协议，会话存活多轮，`send` 即续聊
- **一次性进程型**（claude/codex/opencode；dsh 无 ACP 组件时的 headless 回退）：每回合一进程，resume 参数续聊；dsh 无跨进程 resume（ACP 会话随进程存亡）

会话事件除日志/回合终态外还有 `onHeartbeat`（连接上有任何消息即回调，供空转看门狗续命——模型长思考、后台子代理不误判超时）与 `onSessionId`（provider session id 一经知晓立即持久化，首轮 429 也能续会话）。

新平台接入成本 ≈ 一个适配器文件 + 注册一行（见 `docs/API.md` §4）。

---

## 3. 模块地图

```
src/
├── main/                     主进程
│   ├── index.ts              窗口、依赖装配、createTask 单一创建路径、
│   │                         启动清扫（sweepWorktrees + goalController.recover）
│   ├── ipc/                  领域注册器：goals/tasks/issues/catalog/skills/extensions/system
│   │   ├── context.ts        IpcContext（依赖容器：stores/runner/agents/createTask…）
│   │   └── register.ts       装配入口；全部写入口 main 侧收 unknown 并校验
│   ├── ipc-validation.ts     parseId/parseContent/parseTaskCreate… 纯校验器
│   ├── runner.ts             执行协调、会话映射、取消级联、委派/接力/目标接入、
│   │                         followUp（done/failed/cancelled 均可续聊）
│   ├── scheduler.ts          普通任务/worker 双通道队列与并发槽（parked 跳过）
│   ├── executor.ts           start/超时/取消竞态与迟到 session 清理
│   ├── retry-policy.ts       失败 attempt、resume/fresh 和退避纯策略
│   ├── permission-broker.ts  权限等待、响应、超时与取消清理
│   ├── task-finalizer.ts     最终文本、用量、Git 快照与状态落盘
│   ├── delegate.ts           委派协议：解析/身份注入/循环/worktree 派发与回收/
│   │                         集成/<review> 审核/<continue> 接力/<round> 评估
│   ├── issue-relay.ts        Issue 评论统一中继：64KB 通道钳制 + 未送达统一降级
│   │                         （warn + 任务事件 + pushEvent，绝不静默丢）
│   ├── goal-controller.ts    目标模式循环引擎：Issue 收养、checkpoint、续轮/护栏决策、
│   │                         remove（清除目标）
│   ├── goal-store.ts         目标与 GoalCheckpoint 持久化（userData/goals/index.json）
│   ├── issue-store.ts        Issue/Run/Comment/Notification 持久化与 Task→Issue 投影
│   │                         （userData/issues/index.json；updateWorkflow/statusOverride）
│   ├── store.ts              任务与事件的文件存储（EventLog seq 单调分配）
│   ├── event-log.ts          单任务追加日志：offset 索引、seq 恢复、truncateEvents（rewind）
│   ├── automation-store.ts   定时自动化持久化（userData/automations/index.json）
│   ├── analytics.ts          用量/失败按后端与队员聚合（AnalyticsSummary）
│   ├── usage.ts              从事件流聚合 TaskUsage
│   ├── runtime.ts            运行时健康快照探测（probeRuntimes，带超时）
│   ├── failure.ts            失败分类：11 类稳定 code + 人话标题 + 处置提示
│   ├── skills.ts             共享目录技能库：SKILL.md 解析/CRUD/导入（纯 Node，目录参数注入）
│   ├── skill-targets.ts      技能安装目标注册表与同步状态（claude/codex/zcode/agents，路径逃逸校验）
│   ├── mcp-store.ts          共享目录 MCP 服务器库：<name>.mcp.json CRUD + transport 严格校验
│   ├── hook-store.ts         共享目录 Hook 库：HOOK.md + hook.json（事件/匹配组校验）
│   ├── config-editor.ts      用户配置安全合并器：装/卸 MCP/Hook 到三 CLI 用户级配置，
│   │                         写前 .agentdeck-bak 备份；codex TOML 块级文本操作（无 toml 依赖）
│   ├── plugin-inventory.ts   插件/市场只读盘点（claude/zcode/codex，单 CLI 缺失容错）+ claude 启停 + marketplaceStatus
│   ├── plugin-cli.ts         插件装卸：借 claude 官方 CLI plugin install/uninstall 代跑（60s 总超时，spec 校验）
│   ├── sources.ts            扩展源仓库：git/local 源 clone/同步/移除 + 浏览发现资产 + 一键导入技能 + 市场注册
│   ├── extension-catalog.ts  内置精选扩展源目录（一键添加）
│   ├── agents.ts             队伍持久化 + 预置 + 迁移补员
│   ├── presets.ts            API 预设（baseURL/apiKey）持久化 + 连通性探测
│   ├── settings.ts           设置持久化（theme/concurrency/…/sharedDir）
│   ├── git.ts                isGitRepo/snapshot/commitAll/createWorktree/removeWorktree/
│   │                         sweepWorktrees/deleteBranch/mergeBranchInto/branchDiffSummary
│   └── backends/
│       ├── types.ts          AgentBackend / BackendSession / SessionEvents（onHeartbeat…）
│       ├── zcode.ts          ZCode 协议到 BackendSession 的映射
│       ├── zcode-transport.ts JSON-RPC stdio transport 与进程树清理
│       ├── zcode-config.ts   CLI 配置迁移、runtimeModel 与模型目录
│       ├── zcode-protocol.ts ZCode 消息 guard、握手与事件辅助映射
│       ├── claude.ts         -p stream-json（含费用）
│       ├── codex.ts          exec --json（Windows 必须 bypass 沙箱）
│       ├── opencode.ts       run --format json
│       ├── dsh.ts            优先 ACP 常驻服务；缺组件/握手失败回退 --profile headless
│       ├── dsh-acp.ts        ACP 客户端（NDJSON JSON-RPC：流式 text/续聊/权限桥）+ 内嵌组合配置
│       ├── cli-common.ts     JSONL 行解析 + 空闲超时 + 输出上限
│       └── cli-locator.ts    Windows npm .cmd 垫片解析（防 EINVAL）
├── preload/index.ts          contextBridge 桥（window.agentdeck，契约 = shared/contracts.ts）
├── shared/                   跨进程契约
│   ├── types.ts              Task/TaskEvent/Issue/Run/Goal/AppSettings…
│   ├── contracts.ts          AgentDeckApi 桥接口 + 各 *CreateInput + PermissionRequest
│   ├── taskflow.ts           任务状态转换、Issue/Run 派生、ExecutionRecord 唯一映射
│   ├── skills.ts             SkillMeta/SkillDetail/SkillTarget/SyncState
│   └── extensions.ts         McpDef/HookDef/PluginInventoryItem/ExtSourceMeta/CatalogEntry/DiscoveredAsset
└── renderer/src/             React UI
    ├── App.tsx               视图路由 + 侧栏（Issue/看板/Agent/会议/目标/自动化/技能/用量/设置）
    │                         + 命令面板 Ctrl+K + Toast/确认框/菜单
    ├── api.ts                bridge 类型 + hooks（useTasks/useSettings）
    ├── task-service.ts       任务操作 → Bridge command 单一入口
    ├── hooks/                useTaskEvents（订阅+seq 归并）/turnModel（事件→回合模型）/
    │                         useIssueDetails/eventMerge
    └── components/
        ├── IssuesView / BoardView（看板五列）/ WorkspaceView（新建）
        ├── TaskDetail + task/（TurnTimeline/PermissionPrompt/RunHistory/CommentPanel/GitSummary）
        ├── goal/GoalPanel    Issue 详情侧栏的目标模式面板（开启/状态/checkpoint/清除）
        ├── AgentsView / SkillsView（编辑器+同步状态）/ AutomationView / MeetingsView / GoalsView
        ├── UsageView / RuntimeView（设置页内）/ SettingsView / DiffView / Markdown / TabBar
```

---

## 4. 关键数据流

### 4.1 任务执行（单 agent）

```
create → queued → pump 取队 → running
  → buildAgentPrompt（身份注入）
  → backend.start（spawn/连接）
      事件流: onEvent → store.appendEvent（seq 分配+落盘）→ IPC 推送 → UI 实时渲染
  → onTurnEnd（首回合）
  → [领队: runDelegationLoop]
  → finalizeDone（结果 + snapshotGitAfter + 通知）→ done
```

### 4.2 委派子任务（含 worktree 生命周期）

Worktree 代际约定：每棵成功创建的托管 worktree 都在其 common Git dir 注册 admin 目录写入唯一 `agentdeck-generation`，并把同一 `generationId` 持久化到 owner metadata；池化复用保留该代际，不能因路径/分支同名而继承旧 owner。自动回收必须同时核验仓库、托管路径、完整注册（含有效 `HEAD`）和代际标记；旧代 metadata 缺代际、标记缺失或不匹配、注册不完整时只报告并保留，不能清目录或分支。普通无 owner metadata 的目录/注册仍只报告不回收；唯一例外是 `.agentdeck-merge-*` 施工脚手架，其可在无 JSON sidecar 时凭有效注册与代际标记回收，且集成分支仍受保护。嵌套 worktree 的注册盘点始终从真实 common Git dir 读取，注册-only 残留在重启清扫报告中可见。

```
delegate 标记 → 目标解析（限 subordinates，名字/平台 id 忽略大小写）
  → sanitizeChildPrompt（绝对路径→相对，防改错目录）
  → createWorktree（.agentdeck-worktrees/<taskId>_cN，记录 owner/base SHA/branch/cleanup metadata）
  → 子单基线回放（领队未提交增量 → 私有 index add -A → write-tree → commit-tree（parent=子
    基线 sha）→ 子 worktree cherry-pick --no-commit + reset --soft 推进子分支；领队工作区与用户 index 保持不变，回滚/回收失败明确核验并留痕；
    无增量零开销跳过；体量闸 2000 文件/200MiB/软链，未跟踪盘点（ls-files）超时即拒单，
    超限或失败一律具名拒建单回灌原因）
  → 子任务入队（worker 并发通道）→ 独立执行/日志/权限
  → 终态（含 failed）即 commitAll 落盘到工作分支（nothing silently discarded，不等集成期；
    cancelled 例外，现场原样保留）
  → 终态全文双落：完整 result → ① 领队 Issue 评论（addComment 返回 null = Issue 不存在，
    必须降级任务事件通道留痕）+ ② 领队 workdir/.agentdeck-reports/<单号>.md（info/exclude
    忽略零污染，文件头带 runId 防串轮；二层领队落自己的 workdir）
  → 终态回灌：结构化摘要（单号+状态标题；结论段=result 首部 1200 字有界；git 改动小节=
    对子分支基线（回放后即回放提交）的全部改动，分支/name-status/stat/diff 摘要，≤2KB 按字节
    计，围栏包裹+协议字面量序列内部破坏，超限留截断标记；全文入口指引）——4000 字物理截断
    只是最后防线，触发带「后 N 字未送」
  → 领队对每个 done 单输出 <review> 审核结论
  → 循环结束后：commitAll → merge 进集成分支（只计 HEAD 真实前进，Already-up-to-date 不计入）
     （基线=集成分支自身时在领队托管 worktree 内就地 merge——前置校验 owner 归属 + 工作副本
       干净，不干净/归属不符拒绝并保留现场；临时检出同分支会被 git 拒绝）
  → 集成成功即回收子 worktree + 删工作分支（失败/冲突保留现场）
  → branchDiffSummary 总 diff（续链轮以本轮集成起点 sha 为基，快照记录采集时点的分支
    HEAD）→ 领队任务 gitStat/gitDiff（本轮无净新增时省略证据键，上一轮证据保留；
    finalizer 跨轮保留直接观测集成分支 HEAD 与快照 headSha 一致才重盖时间戳——部分
    失败轮（分支已前进但不写证据）的过期 diff 拒绝重盖为本轮证据）
  → 首次集成成功：createWorktreeAtBranch 建续链 worktree 检出集成分支；切换前把领队留在
    原目录的未提交改动摘录收编进本轮证据；operation 释放后立即落盘 workdir 归属（拆两步
    消除放弃窗口，落盘失败回滚目录、分支保留；无改动早退/集成失败不切换；用户工作区不动）
    → 换基线后 followUp 强制 resume 重建会话（会话绑定 workdir，直续会跑旧目录）
兜底回收：tasks:delete 连带回收名下 worktree（含领队续链 worktree，集成分支随显式删除回收——
          唯一允许删集成分支的路径）；启动时 sweepWorktrees/pruneWorktrees 只自动清扫 owner
          metadata 与仓库、路径吻合的已删任务 worktree、merge 脚手架，以及已确认所属进程退出的池条目。
          无归属侧车的干净树或仅注册残留也进入 failed 报告并保留；扫描从 Git common dir 盘点注册，
          可报告目录或分支已不存在的残留。脏目录、冲突现场和 manualKeep 标记 fail-closed 保留并记录原因；
          续链集成 worktree 的保留判定只按 owner.integration.branch 认归属（领队任务存在期间清扫保留，
          且清扫路径绝不删集成分支）。
```

并行派单在异步建树前预留子单编号，避免同名分支/目录碰撞。池化只复用干净的托管树：目标分支/目录已存在时拒绝接管，复用前清除上一单的忽略文件（保留 AgentDeck 系统目录）；显式删单按原任务归属回收，重启后只有池所属进程被确认退出的条目才由清扫回收；缺失进程身份的旧元数据保守保留。`sharedWorkspace` 只表示共享目录的只读协作提示，不提供文件系统级只读保障。

建树失败若无法证明目录、注册或分支归本次尝试所有，一律保留现场并具名留痕，不接管或清理并发创建的资源；启动清扫遇到缺失/不匹配的 owner metadata 时同样只报告，不以目录名、终态租约或“干净”状态推断归属。此类遗留需人工先用 `git worktree list --porcelain` 对照目录、注册与分支确认归属；确认是失效注册后再执行 `git worktree prune`，确认是可丢弃目录后再显式 `git worktree remove`，不得对未知分支自动删除。普通非 Git 工作区允许共享降级，现存但损坏的 .git 元数据按探测错误拒单。

### 4.3 权限确认（非 yolo 模式）

```
后端 onPermission → runner.askPermission（5 分钟超时自动 deny）
  → IPC task:permission → UI 横幅 → respondPermission → 选项回传后端
```

### 4.4 阶段接力与自动化

- **`<continue>` 接力**：领队/长任务在阶段边界输出 `<continue>` 简报 → `attachContinue` 在同一 Issue 上创建后继任务（`continuesFrom` 指向前任，新会话硬切，简报自包含）→ 触发来源记 `handoff`。目标模式循环天然跟随这条链。
- **自动化**：主进程 15s tick 扫 `automation-store`，到期即以 `autopilot` 触发创建任务（`output: 'run_only'` 时 `suppressIssue`，只留执行日志不建 Issue）。

### 4.5 重启恢复

- 悬挂的 running 任务加载时标为 failed 并提示重跑，不再永久"执行中"
- 委派任务重启后：领队任务标 failed（子任务结果已保留），可单看/重跑
- 目标模式：active → `waiting_user`，需显式 continue，绝不静默续跑
- worktree：`sweepWorktrees` 后台清扫上次会话遗留（不阻塞启动）

---

## 5. 可靠性设计

| 机制 | 防什么 |
|---|---|
| 流式看门狗（zcode 单回合 300KB / CLI 总量 5MB + 10 分钟空闲）+ onHeartbeat 续命 | 模型退化循环；长思考/后台子代理被误判超时 |
| 子进程 stderr 尾巴随错误抛出 | 真实失败原因被吞（曾导致 node:sqlite 排查困难） |
| store 原子写（tmp+rename）+ seq 从文件尾恢复 | 中断损坏与日志重复 |
| launchHandles 启动即注册 + per-session 进程树终止 | 一次性 CLI 在 session 返回前无法取消/杀错进程 |
| onSessionId 首次知晓即持久化 | 首轮 429 后无法续会话 |
| 集成"无合并不报成功" | 误报（实测绝对路径导致空合并仍报成功） |
| sanitizeChildPrompt | 领队指令带主仓库绝对路径，队员改错目录 |
| worktree 三处回收（集成后/删任务/启动清扫）+ removeWorktree 守卫（只动 `.agentdeck-worktrees/`，从 worktree 内解析主仓库根再移除） | 隔离副本无限累积；误删共享主目录工作区 |
| followUp 放行 done/failed/cancelled | 取消目标后 Issue 被卡死、无法继续手动推进 |
| goals:delete（非终态先停任务再级联删 runs/checkpoints）+ goals:deleted 广播 | 旧目标永久占据面板、无法重新开启目标模式 |
| 退出码/非零即失败 + 无输出判失败（opencode） | 静默假成功 |

---

## 6. 已知限制

- dsh 工具活动不上 ACP 协议（committed assistant 消息有流式；纯工具长跑静默期靠固定回合预算兜底），也不能当领队
- dsh ACP 仅新建会话：应用重启后无法按 sessionId 恢复（会话随服务进程存亡）
- 领队自己动手的改动留在主工作区（不自动提交，设计使然）
- 委派最多 3 层、单领队循环最多 6 轮、全链最多 8 轮；不支持无上限递归派发
- 日志无虚拟滚动（单任务万级事件才需要）
- Windows 沙箱限制：codex 必须 bypass（workspace-write 下命令执行会失败）
- 未做多显示器/DPI 与国际化（界面中文）

---

## 7. 渲染层与领域边界

渲染入口保持 `TaskDetail` 兼容组件，但职责已拆到独立模块：

- `renderer/src/hooks/useTaskEvents.ts` 负责事件订阅、按 `seq` 归并、权限响应和回退刷新（`onEventsInvalidated` 触发全量重拉）。
- `renderer/src/hooks/turnModel.ts` 负责把 `TaskEvent[]` 转为回合模型；流式文本与重复 `final` 只保留一个最终消息。
- `renderer/src/hooks/useIssueDetails.ts` 负责 Issue、Run、Comment 查询与更新。
- `renderer/src/components/task/` 提供 `TurnTimeline`、`PermissionPrompt`、`RunHistory`、`CommentPanel` 和 `GitSummary`。
- `renderer/src/task-service.ts` 是任务操作到 Bridge command 的单一入口。
- `App.tsx` 侧栏路由：Issue（默认）/ 看板 / 会议 / 目标 / Agent / 自动化 / 技能 / 用量 / 设置；Ctrl+K 命令面板可搜索任务、跳页与切主题。

领域边界为 `Issue -> Run -> Task`：Issue 是用户工作单元，Run 是一次面向 Issue 的执行投影，Task 是本地 CLI 兼容记录；`ExecutionRecord` 由 `shared/taskflow.ts` 提供唯一映射。任务状态转换（含看板拖动的 `validateMove`）、Issue/Run 状态派生均集中在 `shared/taskflow.ts`。

`tasks/tasks.json` 使用 `{ schemaVersion, tasks }` envelope。`migrateTaskIndex` 显式处理版本 0 数组和当前版本，旧字段迁移与坏记录过滤是幂等的，未来版本会拒绝加载。

## 7.1 目标模式 v2：Issue 内自动推进（Goal-based Loop）

目标模式 v2 不建立独立「目标」页或合成 Issue（`iss_goal_xxx`），而是**在真实 Issue 内开启**，按 Loop Engineering 的 Goal-based loop 理念自动推进（对照 `docs/archive/LOOP-ENGINEERING.md` §3 模块映射：Goal-based loop → `goal-controller.ts` + `goal-store.ts`）。`Goal` 层作为持久化状态脊柱叠加在 `Issue -> Run -> Task` 之上，不替代该模型：

- **目标绑定真实 Issue**：`GoalCreateInput.issueId` 必填。开启即「收养」该 Issue 当前最新 Task 作为阶段任务：无 Task → 建首个（prompt 末尾注入目标模式块，startNow 即入队）；有 Task → 登记为当前阶段任务，startNow 时按其状态启动（queued/running 等执行、done/failed 走续聊回灌）。循环跟随 Issue 最新任务（天然含 `<continue>` 接力产生的 handoff 任务），不再只认自己建的任务。
- **自省自推直到完成条件达成**：每轮 Task 终态（含失败/取消）→ 解析 checkpoint envelope 落盘 `GoalCheckpoint`（runId 幂等，状态脊柱）→ 预算扣减与护栏决策 → 续轮**优先同会话续聊回灌**（`continueTask` = `runner.followUp`，不重开上下文）；后端未注入续聊或 Task 无 `sessionId` 时**兜底新建 Task**（prompt = 目标块 + checkpoint 简报）。
- **完成判定可验证**：checkpoint 的 `completedConditions` 由 agent 逐条对照完成条件原文填写（不靠 prose 撞子串）。全部达成的那一轮 → goal completed，经 `finalizeIssue` 把 Issue 自动归档 done；预算耗尽 → blocked、停止条件命中 → waiting_user、连续失败超限 → failed，均停下并写明原因。
- **委派单 maker/checker 审核流**：委派结果回灌后，领队（checker）须对每个 done 单输出 `<review of="#单号" verdict="pass|fail" note="…"/>` 结论——pass → 对应 Issue 看板状态置 done（自动归档）；fail → 置 blocked 并由领队下一轮改派或自行修复；未出结论的单保持 in_review（人工兜底）。写回复用 `issue-store` 的 `updateWorkflow`/`statusOverride`，审核得到的 done 不会被后续状态投影翻回。
- **预算与护栏**：运行/时长预算、停止条件保留 v1 语义；连续非重试失败由 `Goal.failures`（持久化）计数，`failures < 2` 自动续轮（回灌带失败上下文），≥2 → goal failed。重启恢复仍为 active → waiting_user，需显式 continue，绝不静默续跑。
- **可清除**：`GoalPanel` 标题栏「清除目标模式」任何状态可用——非终态目标连带取消在跑任务，随后 `GoalStore.delete` 级联删 runs/checkpoints、`goals:deleted` 广播摘除 🎯 徽标，面板回到可重新开启的空态。
- **持久化与接线**：`goal-store.ts` 写 `userData/goals/index.json`（与任务存储同样 tmp+rename）；`goal-controller.ts` 拥有生命周期、预算、checkpoint 与续轮决策，复用 TaskRunner 的创建/队列/取消/权限边界。主进程经 `ipc/goals.ts` 注册 `goals:*` handler，更新推送为 `goals:updated` / `goals:deleted`。
- **渲染层**：无整页目标视图；`components/goal/GoalPanel.tsx` 嵌入 TaskDetail 侧栏（开启对话框、状态 chip、轮数预算、checkpoint 历史、暂停/继续/取消/清除）；BoardView 给非终态目标的 Issue 卡片加 🎯 徽标。

## 8. 测试与验证基线

高频回归入口：

| 命令 | 覆盖 |
|---|---|
| `npm run smoke` | runner 状态机：完成/续聊/取消/失败/超时/迟到 session 隔离 |
| `npm run smoke:goal` | 目标模式：Issue 收养、checkpoint envelope 完成判定与 Issue 自动归档、预算/停止条件/连续失败护栏、重启恢复、无续聊新任务兜底、remove 清除 |
| `npm run smoke:skills` | 共享目录技能库：CRUD/导入/安装同步/逃逸校验 |
| `npm run smoke:extensions` | 扩展模块：MCP/Hook 库、三 CLI 配置装/卸与 .agentdeck-bak 备份、codex TOML 块操作、插件盘点、扩展源仓库（本地 git fixture，不联网） |
| `npm run smoke:delegate` | 委派循环（假后端）：多轮派发/剥离/集成/worktree 回收/取消 + 单号报告与 `<review>` 审核 |
| `npm run smoke:stage7` | typecheck + stage6（taskflow/turn-model/migration/issues）+ smoke + goal 串行 |
| `npm run smoke:all` | 全量矩阵：上述全部 + 事件日志/权限/执行服务/IPC 校验/CLI 错误/git 错误/迁移/失败分类/diff/重试/flow/resume/自动化/用量分析/model/continue/round 等 25 个纯本地套件串行 |

专项套件（均 `npm run smoke:<name>`）：`event-log` `permission` `execution-services` `ipc-validation` `final-dedup` `zcode`（真实回合）`clis`（claude/codex/opencode 真实回合）`cli-errors` `git-errors` `migration` `failure` `diff` `retry` `flow`（交接备注/parked/手动启动）`resume` `issues` `automation` `runtime-analytics` `taskflow` `model` `continue` `round`（幻影吞单/round 标记/continue 简报）`turn-model`。

真实 e2e：`npm run e2e:delegate`（GLM 领队自发派 Claude/OpenCode + 集成分支）。

打包：`npm run dist`（NSIS）；开发：`npm run dev`；类型：`npm run typecheck`。
