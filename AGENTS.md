# AGENTS.md

AgentDeck：本地任务看板——把任务派给本地 agent 执行（Electron + React；主进程热更链路零运行时 npm 依赖，五个 CLI 后端适配器可插拔）。

## 验证门（提交前至少过这三关）

```bash
npm run typecheck        # tsc --noEmit，strict 全开
npm run build            # electron-vite build（main/preload/renderer 三入口）
npm run smoke:stage6     # 类型 + 事件日志/任务流/回合模型/迁移/issues 关键冒烟
```

改到编排、委派、sidecar、worktree 时加跑对应专项：`npm run smoke`、`npm run smoke:lifecycle`、`npm run smoke:sidecar`、`npm run smoke:worktrees`；smoke 全量串见 `npm run smoke:all`。

## 代码地图

- **入口：`docs/graph/README.md`** —— 图谱枢纽（`ARCHITECTURE-GRAPH.md` 人读主图 6 张 / `deps.mmd`+`deps.json` 机读全量依赖图 / `INVENTORY.md` 原始盘点与死代码判定）。改动 `src/` 结构后跑 `npm run graph:deps` 刷新机读图。
- 设计决策与领域概念看 `docs/ARCHITECTURE.md`；IPC API 面参考看 `docs/API.md`。

## 铁律：smoke 测试面不是死代码

凡 `scripts/smoke-*.mjs`（约 40 个）经 esbuild `entryPoints` **直连消费**的 `src/**` 导出——函数、常量、类型——是**被测试固化的公共 API**，不是死代码。这类符号在 `src/` 内部零引用属正常状态，删除或降级前必须先查 `scripts/` 里的 esbuild 直连清单与 `docs/graph/INVENTORY.md` **附录 A**（smoke → src 逐条映射）。
