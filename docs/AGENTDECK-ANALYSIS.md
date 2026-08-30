# AgentDeck 项目分析报告

> 分析对象：AgentDeck v0.3.0（`D:\agentdeck`，已封板 demo）
> 分析方法：全量源码走读（27 个源文件 4255 行）+ 健康检查实测 + 对照《MULTICA-TEARDOWN.md》
> 健康基线（本次实测）：`tsc --noEmit` 0 错误；`npm run smoke`（runner 全链路假后端）通过；`npm run smoke:delegate`（委派循环 + worktree 集成 + 用户工作区未动断言）通过；git 干净（5 个提交，0.3.0 封板点）

---

## 1. 定位与完成度

**一句话**：本地单机任务看板——建任务 → 派给本地 agent（5 个 CLI 后端）→ 实时看执行 → 收结果/续聊；多 agent 协作不是开关，而是领队 agent 的**内置能力**（对话中自行判断派工）。

对照 Multica（4255 行 vs 全家桶 5363 文件）取舍明确：**去掉**多用户/工作区/云 runtime/服务器/自定义状态目录/IM 集成；**保留并做实**核心闭环 + 身份层 + 委派协议 + git 隔离集成。对单人本地使用场景，这个裁剪是对的。

---

## 2. 代码地图

| 层 | 文件（行数） | 职责 |
|---|---|---|
| 入口 | `main/index.ts` (204) | 窗口、5 后端注册、19 个 IPC handler、agents 探测（并行+20s 超时+逐个推送） |
| 编排 | `main/runner.ts` (387) | 队列/生命周期/事件管道；**双通道并发泵**（普通任务受 concurrency、worker 受 squadMaxWorkers，领队不占槽）；权限确认（5min 超时自动拒）；取消级联；resume（进程内 session 优先，重启后 sessionId 冷恢复，120s 超时） |
| 委派 | `main/delegate.ts` (258) | 协议核心：`<delegate to>` 解析/剥离、身份注入、派发协议 prompt、路径消毒、多轮循环（≤6 轮、每轮并行上限）、git 集成 |
| 遗留 | `main/squad.ts` (337) | 旧"显式 squad 模式"编排器，仅存量任务恢复路径（见 §6 技术债） |
| 存储 | `main/store.ts` (149) | userData/tasks.json + 每任务 task.json/events.jsonl；原子写；seq 从文件尾恢复 |
| git | `main/git.ts` (177) | isGitRepo/snapshot/commitAll/`createWorktree`（.agentdeck-worktrees + .git/info/exclude）/mergeBranchInto（冲突中止）/branchDiffSummary |
| 身份 | `main/agents.ts` (60) | Agent {id,name,backend,role,systemPrompt,subordinates,model,note,color}；5 预置；缺失平台迁移补齐 |
| 后端 | `backends/zcode.ts` (573) | app-server 协议（无 jsonrpc 键的信封）；resume 需 runtimeModel 注册表快照；300KB 文本看门狗；node:sqlite 需要 PATH node ≥22.5 |
| 后端 | `backends/{claude 139, codex 124, opencode 111, dsh 139}` | 一次性进程模型（spawn→干活→退出），续聊 = 再 spawn + resume 参数；dsh 纯文本无流式无续聊 |
| 后端 | `backends/{cli-common 92, cli-locator 89, types 52}` | JSONL 泵（10min idle、5MB cap）；Windows .cmd shim 解析；AgentBackend 接口 |
| UI | `components/TaskDetail.tsx` (442) | 对话视图（按 user 事件分回合、工具调用折叠、流式气泡、用量角标）+ 结果/Git tab + 子任务面板 + 权限 banner + 追问输入 |
| UI | `components/{TeamView 184, WorkspaceView 155, SettingsView 113, TaskList 73, Markdown 27}` | 队伍编辑（含 subordinates 多选）/快捷输入（草稿、IME 安全）/设置/列表（搜索、进行中与历史分组） |
| UI | `App.tsx` (82) + `api.ts` (94) + `preload/index.ts` (76) | 三视图切换、Ctrl+N、bridge 封装 |

分层评价：**main 进程职责切分干净**（编排/协议/存储/git/身份五块正交，backends 全部实现同一 AgentBackend 接口，两种进程模型抽象正确）；renderer 极薄（纯 IPC 消费，无业务逻辑）；shared/types 是唯一契约。对一个 demo 来说结构超出预期。

---

## 3. 功能清单（现状核对）

**任务闭环**：创建（工作区一句话输入 + 队员选择 + 工作目录）→ 排队 → 执行（实时事件流）→ 完成/失败/取消 → 结果 Markdown 渲染 → 追问续聊 → 重试/复制/删除（级联子任务）→ OS 通知（点击聚焦任务）。

**对话视图**（TaskDetail 亮点）：事件流按 user 事件切回合（旧数据兜底）；工具调用折叠（"N 次工具调用" details 展开，started/result 两态、耗时、预览首行）；流式气泡（text 增量 → final 替换渲染 Markdown）；回合用量角标（tokens / in-out / 时长 / $成本 / 轮数，字段名多态兼容）。

**身份与委派**：5 预置队员（ZetCode 领队可驱使 4 队员；Claude/Codex/OpenCode 工程师；DeepSeek 分析员）；队伍页可编辑 name/backend/role/systemPrompt/note/头像色/**subordinates 多选**；卡片明示"⚡ 可驱使 X、Y（对话中自行派发）"；工作区选领队时提示"需要时会自行派工"。委派运行时：领队回复中 `<delegate to>` 标记 → 名称/后端不区分大小写匹配（限直属下属）→ git worktree 隔离子任务并行 → 终态后结果回灌 `session.send("【系统】队员执行结果汇报…")` → 领队继续，≤6 轮 → 全部 commitAll + 逐个 merge 进集成分支（冲突诚实上报，mergedCount=0 不假装成功）。

**可靠性机制**（实测/代码核对）：

| 机制 | 参数 | 位置 |
|---|---|---|
| GLM 退化循环看门狗 | 300KB/回合 强停截断 | zcode.ts |
| CLI 输出上限 | 5MB | cli-common.ts |
| 空闲超时 | 10min | cli-common.ts |
| 权限确认超时 | 5min 自动拒绝 | runner.ts |
| resume 超时 | 120s | runner.ts |
| 预会话取消 | launchHandles（session 未返回即可停） | runner.ts |
| 取消级联 | 领队停 → 子任务递归停 | runner.ts |
| 原子写 | tmp+rename | store.ts |
| seq 恢复 | 从 events.jsonl 尾部重算 | store.ts |

---

## 4. 与 Multica 对照

### 4.1 已对齐的核心机制

| 机制 | Multica | AgentDeck | 评价 |
|---|---|---|---|
| agent 身份层 | Agent（instructions/skills/runtime/access） | Agent（role/systemPrompt/subordinates） | 等价够用；Access 多人权限正确裁掉 |
| 领队派工 | squad：mention markdown + Operating Protocol + 重触发规则表 | `<delegate>` 标记 + 派发协议块 + 回灌循环 | **同构**；我们更直接（进程内截获 vs 服务器中转） |
| 隔离交付 | local worktree（in-place/isolated 两模式，UI 明示语义） | 每 worker 独立 worktree + 集成分支 | 对齐；我们强制隔离（更安全），但没有 in-place 选项 |
| 执行记录 | task_message（seq 流） | events.jsonl（seq 流） | 等价 |
| 续聊 | session_id + resume | sessionId + 进程内 session / 冷 resume | 对齐（zcode 的 runtimeModel 陷阱已解） |
| 权限 | 无弹窗（平台层承担） | 权限 banner（5min 超时） | **我们更细**——单机场景交互确认合理 |

### 4.2 缺口（按价值排序，对照 Multica 拆解第 8 章）

1. **run 状态粒度**：我们 queued→running→done/failed/cancelled 五态；Multica 八态（dispatched/waiting_local_directory 细分）+ **瞬态故障自动重试**（2-3 次带 attempt 上限）。demo 可不做，但"后端启动失败"与"跑挂"目前同样对待。
2. **失败分类学**：我们的 error 是原始字符串；Multica 平台侧/工具侧两段枚举 + 每类"怎么办"文案。低成本高收益：把 stderr 特征归类（spawn ENOENT=CLI 未装、401=凭证、超时=idle）即可覆盖 80%。
3. **用量聚合**：只有回合角标；无任务累计、无全局 Usage 页。Multica 的 KPI/趋势/排行榜支撑"哪个 agent 烧钱"决策。事件里已有 usage 数据，聚合是纯前端活。
4. **转录呈现**：Multica 双泳道时间线（Model|Tools 壁钟轴）+ diff 高亮 + 工具分类统计；我们是折叠清单 + 纯文本 `<pre>` diff。中期最值得抄的一块。
5. **多任务并行浏览**：单详情视图；Multica 桌面 tab 即会话（虚拟历史+滚动备忘录）。本地 demo 用浏览器式 tab 或多窗口即可，不必抄全套。
6. **委派深度与留痕**：1 层、无领队评估记录（Multica 每轮 `squad activity --reason` 写时间线）；领队自己的编辑留在主工作区不自动提交。
7. **dsh 后端**：无流式、无续聊，体验二等公民（协议本身限制）。
8. 杂项：无命令面板（只有标题搜索）、无快捷键自定义（仅 Ctrl+N）、renderer 类型重复定义（api.ts AgentInfo 与 TeamView 本地 Agent 两套，preload 已是全量形）、无 i18n。

### 4.3 不建议抄的

多用户/workspace/邀请、云 runtime Fleet、自定义状态目录（两层状态模型对单人无意义）、IM 渠道集成、插件系统、Analytics 全家桶。这些是 Multica 的组织级卖点，与本项目"个人本地"定位正交。

---

## 5. 架构风险评估

| 风险 | 现状 | 影响 | 建议 |
|---|---|---|---|
| **双轨 mode** | `mode:'squad'` 旧路径仍在 runner（squad.run 分支）+ types + UI 徽标；新委派走 `subordinates`，UI 已不可创建 squad 任务 | 337 行死代码 + 恢复路径复杂度；概念混乱（TaskList/TaskDetail 仍渲染 squad 徽标） | 下个版本删除 squad.ts 与 mode 字段（或 mode 仅留 'single'），存量任务一次性迁移 |
| zcode 私有协议耦合 | 573 行手写协议 + `~/.zcode/cli/config.json` 物化 + runtimeModel 快照 | CLI 升级即碎（已吃过 3 次亏：EINVAL/双终态/resume 模型） | 加协议版本探测或最小握手自检；错误信息里给出"协议可能已变"提示 |
| 状态全在内存 | runner 内存 Map（sessions/launchHandles/权限）+ 启动 recover | 崩溃恢复粒度 = 任务级重跑，无断点 | demo 可接受；若做长任务需把 run 状态落盘 |
| 通知点击聚焦 | `task:focus` 依赖窗口在前 | 后台时点击通知行为弱 | 接 mainWindow.show()+聚焦 |
| doDuplicate 用 `window.location.reload()` | 暴力整页刷新 | 闪屏 | 走 onSelect(t.id) 即可 |
| 无日志滚动优化 | events 全量 setState 追加 | 超长任务（几千事件）会卡 | 已在 ARCHITECTURE.md 声明 out-of-scope，维持 |

---

## 6. 总结判断

**作为 demo：完成度高、边界干净、可演示核心主张**（领队自主判断派工——e2e 已证明领队会自发委派并正确理解 worktree 语义）。代码质量：main 进程结构好于典型 demo，测试基线（假后端冒烟 + 真实 e2e 两级）是亮点。

**作为产品的下一步**（若继续演进，按序）：① 删双轨 squad 净化概念 → ② 失败分类 + 任务级用量汇总（数据已有）→ ③ 转录升级（diff 高亮 + 工具统计）→ ④ run 自动重试（瞬态白名单）→ ⑤ 多 tab 浏览。每步都对照 MULTICA-TEARDOWN.md §8 的借鉴清单即可，不需要引入 Multica 的任何服务器端复杂度。

**文档资产**：API.md（IPC 契约）/ ARCHITECTURE.md（架构与限制）/ MULTICA-TEARDOWN.md（对标参照）/ CHANGELOG.md（59 行）——四份文档与本报告构成完整决策上下文。
