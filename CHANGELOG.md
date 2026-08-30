# 更新日志（Changelog）

本项目所有显著变更记录于此文件。格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 修复

- **队伍页「检测各平台可用性」点击无反馈**：五个后端的探测由串行改为并行，单个完成后立即推送结果到界面；按钮点击即显示「检测中…」并禁用；单个探测带 20 秒兜底超时，异常不再静默吞掉。（设置页「检测可用性」按钮同样处理）
- **删除任务后界面不立即刷新**：主进程删除成功后广播 `task:deleted`，任务列表即时刷新、被删的选中项自动回到空状态；删除被拒绝（如任务运行中）时弹出原因。
- **删除协同（squad）任务遗留孤儿子任务**：删除父任务时级联删除其全部子任务；子任务仍在运行时拒绝删除并提示先取消。
- **dsh 路径设置需重启才生效**：后端原先在应用启动时固化设置快照，改为每次探测/执行时读取最新设置。
- **dsh 探测可能挂起至 15 秒超时**：回退用 electron.exe 充当 node 运行 `--version` 时补上 `ELECTRON_RUN_AS_NODE=1`，避免被当作 GUI 应用拉起。

### 变更

- 设置页「执行后端 · ZCode」卡片更名为「执行后端 · ZCode / DeepSeek Harness 路径」，并补充说明：执行后端 = 实际执行任务的 CLI 程序；claude / codex / opencode 从 PATH 自动发现，无需配置。

## [0.1.0] - 2026-08-30

初始基线（对应初始提交 `7197420`）。

- Electron + React + TypeScript 桌面应用：本地任务看板，把任务派给本地 agent CLI 执行
- 任务模式：单任务、squad 多 agent 协同（领队拆解 → 并行执行（git worktree 隔离）→ 汇总 → 集成）
- 执行后端：zcode（GLM，app-server 协议）、claude（Claude Code）、codex、opencode、dsh（DeepSeek Harness）
- 任务队列与并发控制、实时事件流（文本/工具调用/用量）、权限确认、追问续聊、git 改动快照
- 数据持久化于系统 userData 目录（tasks.json + 每任务 events.jsonl）
