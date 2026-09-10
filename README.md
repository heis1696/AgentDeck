# AgentDeck

本地多 agent 协作台（Issue-first）：**Claude Code、Codex、OpenCode、ZCode、DeepSeek Harness 同队协作**——工作以 **Issue** 为单位组织，派给指定队员、由领队拆解异构派工（比如 Claude 写代码、Codex 写文档），或在 Issue 内开启目标模式让 agent 自动多轮推进，全程实时可见，改动合入集成分支。

是 [Multica](https://github.com/multica-ai/multica) 的极简单机仿写——保留 agent 队伍/Issue 派发/执行日志/squad 协同，去掉云端服务器、多用户、计费、IM 集成。

## 快速开始

```bash
npm install          # electron 二进制下载失败时：ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
npm run dev          # 开发模式
npm run smoke:all    # 全量本地冒烟矩阵（不经 GUI，串行执行全部纯本地 smoke）
```

## 前置条件

- 本机装了任一 agent CLI 即可用对应队员（全部可选）：
  - `claude`（Claude Code，已登录）
  - `codex`（OpenAI Codex，已登录）
  - `opencode`（OpenCode）
  - ZCode 桌面版（GLM，已登录）——工具自动从其登录态生成所需配置
  - DeepSeek Harness（源码编译即可，自动扫描常见目录；找不到时在设置页指定 `apps/cli/lib/bin.js` 路径）
- Agent 页可一键检测各平台可用性；设置页可查看各运行时的健康快照

## 功能一览

### Issue（工作单元）

侧栏「Issue」页是工作队列：标题 + 描述 + 工作目录 + 负责人，支持优先级/标签/截止日期/状态流转（backlog→todo→in_progress→in_review→done/blocked）。执行历史以 Run 记录在 Issue 时间线里，agent 跑完自动写报告评论、进收件箱；评论里 `@队员名` 会在同一 Issue 上触发新一轮执行。看板页按状态分列拖动卡片；每条 Issue 执行可展开实时日志、Markdown 结果、git diff 与追问。

### Agent 队伍与委派

「Agent」页创建队员：**名字、定位、系统提示词、平台**（zcode/claude/codex/opencode/dsh）、模型/连接预设、头像色；勾选队员即成为领队。委派没有模式开关——给领队发任务后它**在对话中自行判断**要不要派子任务、派给谁：

```
你 → 领队：升级 utils.py 并补文档
领队（思考）：两件事可并行 → 输出 <delegate to="Claude">改 utils.py</delegate> <delegate to="Codex">写 NOTES.md</delegate>
  ├─ Claude 在隔离 worktree + 分支执行
  └─ Codex 在另一个隔离副本执行（真并行）
系统：结果带单号回灌领队 → 领队对每个 done 单输出 <review> 审核（pass→看板归档 / fail→blocked 改派）
    → 领队继续（可再派、可自己做收尾）→ 最终总结
子任务改动自动提交合入 agentdeck/task-<id> 集成分支，worktree 用后即回收；你的当前分支不动
```

- 支持二层委派（子领队继续下派）：祖先链防环 + 层级上限 3 层 + 全链共享 8 轮预算
- 取消领队会级联取消运行中的子任务；领队自己动手的改动留在主工作区（不自动提交）

### 目标模式（Issue 内自动推进）

在 Issue 详情侧栏开启「目标模式」：填写目标、可验证的完成条件、轮数/时长预算与停止条件。之后 agent 每轮结束自动自省续推——优先同会话续聊回灌，完成条件逐条达成即标记完成、Issue 自动归档 done；预算耗尽、停止条件命中或连续失败超限则停下并写明原因。重启后绝不静默续跑（进入待用户确认态）。看板上进行中的目标 Issue 带 🎯 徽标。

### 自动化 / 收件箱 / 技能库 / 用量

- **自动化**：按分钟间隔定时用固定 prompt 唤醒某队员，产出可选落成 Issue 或只留执行日志
- **收件箱**：报告/提及/状态/指派四类通知，未读计数挂在侧栏
- **技能库**：AgentDeck 拥有自己的共享目录（默认 `~/.agentdeck`，可在设置中更改），技能以标准 `SKILL.md` 存放，支持新建/编辑/导入，并一键安装同步到 `~/.claude/skills`、`~/.codex/skills`、`~/.zcode/skills`、`~/.agents/skills`（逐字节比较给出同步状态）
- **用量**：按后端/队员聚合 token、成本、时长与失败分类

## 架构

```
src/
├── main/                  Electron 主进程（Node）
│   ├── index.ts           窗口、依赖装配、启动清扫（worktree 回收/目标恢复）
│   ├── ipc/               goals/tasks/issues/catalog/skills/system 领域注册器
│   ├── runner.ts          执行协调、会话映射、取消级联、委派/接力/目标接入
│   ├── scheduler.ts       普通/worker 双通道队列与并发槽
│   ├── delegate.ts        委派协议：解析/派发/集成/<review> 审核/<continue> 接力
│   ├── goal-controller.ts 目标模式循环引擎（Issue 收养、checkpoint、护栏决策）
│   ├── store.ts 等        全部状态落 userData/ 的 JSON/JSONL（原子写）
│   └── backends/          5 个 AgentBackend 适配器（types.ts 为扩展点）
├── preload/index.ts       IPC 桥（contextIsolation → window.agentdeck）
├── shared/                types/taskflow/contracts/skills 跨进程契约
└── renderer/              React 界面（Issue/看板/Agent/收件箱/自动化/技能/用量/设置）
```

### ZCode 集成方式

通过逆向 ZCode 桌面版同款的 stdio 协议（"ZCode Protocol"，换行分隔 JSON）：

- spawn `node zcode.cjs app-server --stdio`（每任务一个进程，杀进程即取消）
- `session/create`（需应答服务端的 runtimePreferences 请求）→ `session/subscribe` → `session/send`
- 事件流：`model.streaming` 文本增量、`turn.terminal` 回合终态、`state.updated` 状态机
- 首次运行自动生成 `~/.zcode/cli/config.json`（app-server 必需，从 GUI 登录态迁移）

### 新增执行后端

实现 `src/main/backends/types.ts` 的 `AgentBackend` 接口并在 `src/main/index.ts` 注册。
接口：`probe` / `start`（返回 `{sessionId, send, stop, close}`）；详见 [API 文档](docs/API.md) §4。

## 文档

- [架构文档](docs/ARCHITECTURE.md) — 总览、模块地图、关键数据流、可靠性设计、测试基线、已知限制
- [API 文档](docs/API.md) — IPC 桥全接口、数据模型、后端适配器接口、委派协议、ZCode 协议要点
- [共享目录与技能库](docs/SKILLS-SHARED-DIR.md) · [目标模式设计](docs/GOAL-AUTOPILOT-REDESIGN.md) · [Loop Engineering](docs/LOOP-ENGINEERING.md)

## 打包

```bash
npm run dist          # NSIS 安装包（release/ 目录）
```

## 已知限制

- 权限确认只支持"允许/拒绝"两档（协议里的 escalate/modify 档未暴露）
- dsh 无流式过程与续聊（协议本身不提供），也不能当领队
- 事件日志量大时未做虚拟滚动（个人规模够用）
- 委派最多 3 层、全链最多 8 轮；不支持无上限递归派发
- Windows 沙箱限制：codex 必须 bypass 沙箱模式
