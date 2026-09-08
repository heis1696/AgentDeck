# 重构验证记录

## 阶段 0 基线（2026-09-07）

| 命令 | 结果 | 备注 |
|---|---|---|
| `npm run typecheck` | 通过 | TypeScript 无错误 |
| `npm run smoke` | 通过 | 修复 fake backend 不应回显系统协议的脆弱断言 |
| `npm run smoke:final-dedup` | 通过 | 终态去重 |
| `npm run smoke:delegate` | 通过 | 委派、集成、二层防环 |
| `npm run smoke:migration` | 通过 | 旧任务 schema 迁移 |
| `npm run smoke:failure` | 通过 | 失败分类和 runner 接线 |
| `npm run smoke:diff` | 通过 | unified diff 解析 |
| `npm run smoke:retry` | 通过 | 自动重试策略 |
| `npm run smoke:flow` | 通过 | handoff、parked、手动启动 |
| `npm run smoke:resume` | 通过 | 会话恢复 |
| `npm run smoke:issues` | 通过 | Issue/Run 投影 |
| `npm run smoke:automation` | 通过 | 自动化持久化 |
| `npm run smoke:runtime-analytics` | 通过 | 运行时和统计 |
| `npm run smoke:taskflow` | 通过 | 状态机和 UI 移动规则 |
| `npm run smoke:model` | 通过 | 多源回合/模型解析 |
| `npm run smoke:continue` | 通过 | 阶段接力 |
| `npm run smoke:round` | 通过 | round/委派标记解析 |
| `npm run smoke:event-log` | 通过 | 事件追加、恢复、批量快照和增量读取 |
| `npm run smoke:permission` | 通过 | 权限响应、去重、超时和取消清理 |
| `npm run smoke:ipc-validation` | 通过 | IPC DTO 边界校验 |
| `npm run smoke:clis` | 未完成 | Claude 通过；Codex CLI 在当前环境超过 90 秒无输出，已终止。需要单独检查 Codex 登录、沙箱或 CLI 进程。 |

并行启动会覆盖 `out/smoke-*.cjs` 临时 bundle，导致 `smoke:migration` 和 `smoke:retry` 出现 `TaskStore/TaskRunner is not a constructor`。两者串行重跑均通过；后续不要并行执行会写入同一 `out` 文件的 smoke 脚本。

## 阶段 1 进度（2026-09-07）

- 已完成：新增 `src/main/event-log.ts`，将事件 seq 分配、追加、读取、截断从 `TaskStore` 提取出来。
- 已完成：任务快照和全量索引采用 25ms 有界批量 flush；事件 JSONL 仍立即追加，退出、任务收尾和截断会显式 flush。
- 已保持：现有任务目录格式、事件 seq、`eventCount`、回退语义和 `TaskStore` 对外 API。
- 已验证：`npm run typecheck`、`npm run smoke`、`npm run smoke:migration`、`npm run smoke:taskflow`、`npm run smoke:issues`、`npm run smoke:event-log` 通过。
- 未完成：落盘错误结构化；offset 索引已加入内存实现，截断后重建路径由 `smoke:event-log` 覆盖。

## 阶段 2 进度（2026-09-07）

- 已完成：`IssueStore.sync` 增加任务快照指纹；无任务变化时直接返回，避免重复写投影。
- 已完成：`issues:list/get/runs/comments/notifications` 查询路径不再主动触发全量同步。
- 已完成：新增 `syncTask` 有界更新路径，runner 的任务广播只投影当前任务及必要父任务。
- 已验证：`npm run smoke:issues`、`npm run smoke`、`npm run smoke:flow`、`npm run smoke:delegate` 通过。
- 未完成：删除任务的增量清理、独立 projector 类以及长期运行时的 taskId/runId 索引。

## 阶段 3 进度（2026-09-07）

- 已完成：新增 `src/main/scheduler.ts`，负责普通任务/worker 双通道并发、队列选择、槽位释放和重新 pump。
- 已完成：`TaskRunner` 保留执行生命周期和兼容 `enqueue` API，不再持有调度计数器。
- 已修复：不可用 backend 的 queued 任务现在直接进入 failed，避免调度器反复重派。
- 已完成：新增 `src/main/permission-broker.ts`，统一权限请求去重、超时 deny、响应和任务/应用清理。
- 已完成：新增 `src/main/task-finalizer.ts`，负责最终文本、usage 聚合、Git 快照和 done 落盘。
- 已完成：新增 `RunnerPorts`，Electron 窗口广播和系统通知由 `main/index.ts` 注入，runner 不再直接依赖 Electron。
- 已验证：`npm run typecheck`、`npm run smoke`、`npm run smoke:delegate`、`npm run smoke:retry`、`npm run smoke:taskflow`、`npm run smoke:permission`、`npm run smoke:event-log` 通过。
- 阶段 3 完成：调度、权限、收尾和 Electron port 已拆出；后续进入阶段 4 IPC 契约统一。

## 阶段 4 进度（2026-09-07）

- 已完成：新增 `src/shared/contracts.ts`，集中定义 Bridge、IPC DTO、Agent/Preset、model catalog 和 PermissionRequest。
- 已完成：preload 与 renderer 改用 shared 契约；保留 `api.ts` 的兼容类型导出。
- 已完成：renderer/preload 不再引用 `src/main/**` 或 `backends/types`。
- 已完成：新增 `src/main/ipc-validation.ts`，为任务、Issue、设置、状态、评论等写入型 IPC 增加 main 侧边界校验。
- 已验证：`npm run typecheck`、`npm run smoke`、`npm run smoke:issues`、`npm run smoke:permission`、`npm run smoke:ipc-validation` 通过。
- 阶段 4 完成：shared 契约和运行时 DTO 校验已落地；统一错误 envelope 可作为后续兼容性改造单独推进。

## 阶段 6 验证（2026-09-08）

| 命令 | 结果 | 备注 |
|---|---|---|
| `npm run typecheck` | 通过 | 渲染层拆分和 shared 模型无类型错误 |
| `npm run smoke:stage6` | 通过 | taskflow、事件归并、迁移幂等、Issue 投影 |
| `npm run smoke` | 通过 | runner 全量回归 |
| `npm run smoke:event-log` | 通过 | 事件追加、恢复、增量读取和截断 |
| `npm run smoke:delegate` | 通过 | 委派、二层链路和 Git 集成 |
| `npm run smoke:retry` | 通过 | 自动重试与上限 |
| `npm run smoke:continue` | 通过 | 续聊和阶段接力 |
| `npm run dist` | 通过 | Electron main/preload/renderer 与 NSIS 构建成功 |

阶段 6 渲染入口 `TaskDetail.tsx` 为 179 行；事件归并 smoke 独立构建 `src/renderer/src/hooks/turnModel.ts`，不加载 Electron。

## 阶段 7 验证（2026-09-08）

| 命令 | 结果 | 备注 |
|---|---|---|
| `npm run typecheck` | 通过 | Goal shared types、controller、IPC 与 renderer 无类型错误 |
| `npm run smoke:goal` | 通过 | 多 Run、checkpoint 幂等、完成/失败/取消、预算和重启恢复 |
| `npm run smoke:stage7` | 通过 | 阶段 6 smoke、runner 回归与目标 smoke |
| `npm run dist` | 通过 | Electron main/preload/renderer 与 NSIS 构建成功 |

目标索引写入 `userData/goals/index.json`，采用 schema version 与 tmp+rename；
活动目标重启后进入 `waiting_user`，不会静默继续执行。

## 后续排期

- 阶段 7“目标模式”已实现并通过目标 smoke；后续可在保持 `goals:*` 契约的前提下扩展条件解析和更细粒度预算计量。

## 阶段 8 并发与架构收口（2026-09-08）

| 命令 | 结果 | 备注 |
|---|---|---|
| `npm run typecheck` | 通过 | runner/IPC/backend 拆分与 shared 契约无类型错误 |
| `npm run smoke:all` | 通过 | 25 项本地 smoke 串行执行，避免临时 bundle 并发覆盖 |
| `npm run smoke:clis` | 通过 | 真实 Claude、Codex、OpenCode 各完成一轮文件读取 |
| `npm run smoke:zcode` | 通过 | 真实 ZCode app-server 完成首轮并返回会话 ID |
| `npm run dist` | 通过 | Electron 三 bundle 与安装包构建成功 |

收口结果：`src/main/index.ts` 降为 composition root，IPC 按 goals/tasks/issues/catalog/system 注册；ZCode transport、protocol 与配置/模型目录分离；runner 使用独立 Scheduler、Executor、PermissionBroker、RetryPolicy 和 TaskFinalizer，并保留旧公开方法。runner smoke 直接覆盖两个并发会话中取消 A、B 继续完成且 stop 只命中 A。

本次真实 provider 验收未出现 429。Codex 单任务从启动到完成约 46 秒；历史压力数据仍显示 8 并发后延迟显著上升、到 16 并发未观察到硬 429，因此默认 `workerConcurrency=3` 保持不变。429 退避、首轮 session ID 持久化后 resume、退避取消均由 `smoke:retry` 的可控假 provider 覆盖。
