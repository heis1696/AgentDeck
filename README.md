# AgentDeck

本地多 agent 协作台：**Claude Code、Codex、OpenCode、ZCode、DeepSeek Harness 同队协作**——任务派给指定队员，或由领队拆解后异构派工（比如 Claude 写代码、Codex 写文档），全程实时可见，改动合入集成分支。

是 [Multica](https://github.com/multica-ai/multica) 的极简单机仿写——保留 agent 队伍/任务派发/执行日志/squad 协同，去掉云端服务器、多用户、计费、IM 集成。

## 快速开始

```bash
npm install          # electron 二进制下载失败时：ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
npm run dev          # 开发模式
npm run smoke        # 核心链路冒烟测试（不经 GUI）
```

## 前置条件

- 本机装了任一 agent CLI 即可用对应队员（全部可选）：
  - `claude`（Claude Code，已登录）
  - `codex`（OpenAI Codex，已登录）
  - `opencode`（OpenCode）
  - ZCode 桌面版（GLM，已登录）——工具自动从其登录态生成所需配置
  - DeepSeek Harness（源码编译即可，自动扫描常见目录；找不到时在设置页指定 `apps/cli/lib/bin.js` 路径）
- 队伍页可一键检测各平台可用性

## 使用

### 队伍（Agents）

侧栏「队伍」页创建你的 agent：**名字、定位、系统提示词（人设/专长）、平台**（zcode/claude/codex/opencode/dsh）、头像色。勾选**可驱使的队员**即成为领队。预置五名队员，ZetCode 默认是领队。

### 委派（内置，无模式开关）

给领队发任务后，它**在对话中自行判断**要不要派子任务、派给谁：

```
你 → 领队：升级 utils.py 并补文档
领队（思考）：两件事可并行 → 输出 <delegate to="Claude">改 utils.py</delegate> <delegate to="Codex">写 NOTES.md</delegate>
  ├─ Claude 在隔离 worktree + 分支执行
  └─ Codex 在另一个隔离副本执行（真并行）
系统：结果汇报回领队 → 领队继续（可再派、可自己做收尾）→ 最终总结
子任务改动自动提交合入 agentdeck/task-<id> 集成分支；你的当前分支不动
```

- 委派完全由领队自主决策：小事它自己做，可并行/需要专长才派
- 取消领队会级联取消运行中的子任务
- 领队自己动手的改动保留在主目录工作区（不自动提交）

### 单任务 / 续聊 / 其他

- 普通队员任务：实时日志（流式/工具/token）、Markdown 结果、git diff、追问（zcode 重启后可续聊；dsh 一次性不支持）
- 权限模式 build/edit/plan 弹确认横幅；yolo 全自动

## 架构

```
src/
├── main/                  Electron 主进程（Node）
│   ├── index.ts           窗口 + IPC
│   ├── runner.ts          任务队列与状态机 queued→running→done|failed|cancelled
│   ├── store.ts           文件存储（userData: tasks.json + 每任务 events.jsonl）
│   ├── git.ts             任务结束后的 git diff 快照
│   ├── settings.ts        设置持久化
│   └── backends/
│       ├── types.ts       AgentBackend 适配器接口（扩展点）
│       └── zcode.ts       ZCode 适配器（spawn zcode app-server --stdio）
├── preload/index.ts       IPC 桥（contextIsolation）
└── renderer/              React 界面（列表/详情/新建/设置）
```

### ZCode 集成方式

通过逆向 ZCode 桌面版同款的 stdio 协议（"ZCode Protocol"，换行分隔 JSON）：

- spawn `node zcode.cjs app-server --stdio`（每任务一个进程，杀进程即取消）
- `session/create`（需应答服务端的 runtimePreferences 请求）→ `session/subscribe` → `session/send`
- 事件流：`model.streaming` 文本增量、`turn.terminal` 回合终态、`state.updated` 状态机
- 首次运行自动生成 `~/.zcode/cli/config.json`（app-server 必需，从 GUI 登录态迁移）

### 新增执行后端

实现 `src/main/backends/types.ts` 的 `AgentBackend` 接口并在 `src/main/index.ts` 注册。
接口：`probe` / `start`（返回 `{sessionId, send, stop, close}`）。

## 文档

- [架构文档](docs/ARCHITECTURE.md) — 模块地图、数据流、可靠性设计、已知限制
- [API 文档](docs/API.md) — IPC 桥、数据模型、后端适配器接口、委派协议、ZCode 协议要点

## 打包

```bash
npm run dist          # NSIS 安装包（release/ 目录）
```

## 已知限制（v0.2）

- 权限确认只支持"允许/拒绝"两档（协议里的 escalate/modify 档未暴露）
- 事件日志量大时未做虚拟滚动（个人规模够用）
- follow-up 队列：同一任务追问会阻塞到上一回合结束（符合预期但无排队提示）
