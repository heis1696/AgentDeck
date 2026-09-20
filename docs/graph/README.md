# docs/graph — 代码地图集（知识图谱枢纽）

本目录是 AgentDeck 的代码地图入口：给 agent 与人共用的仓库结构事实源。四份产物分工如下。

## 索引：四份产物怎么用

| 文件 | 性质 | 什么时候看它 |
| --- | --- | --- |
| [`INVENTORY.md`](./INVENTORY.md) | **原始盘点**（只读快照）：全量文件职责表、邻接表、循环依赖判定、死代码候选三档、smoke 直连清单（附录 A/B） | 要**证据与全量清单**时：查某个符号谁在用、某文件干什么、死代码判定依据 |
| [`ARCHITECTURE-GRAPH.md`](./ARCHITECTURE-GRAPH.md) | **人读主图**：6 张 Mermaid 图（四层总览 / 编排主干 / IPC 域地图 / sidecar 双腿 / hot 链路 / renderer 分层），每图配人话导读 | 想**快速理解架构**时：新人入职、动手前定位改动面 |
| [`deps.mmd`](./deps.mmd) / [`deps.json`](./deps.json) | **机读全量图**：dependency-cruiser 输出，143 模块（133 个 .ts/.tsx + 10 个 css）/ 292 条已解析依赖边 | 要**机器可计算的依赖事实**时：agent 检索引用关系、脚本化分析、画自定义视图 |
| `docs/ARCHITECTURE.md` / `docs/API.md` | 既有**人工叙事文档**：ARCHITECTURE 讲设计决策与领域概念，API 是 IPC 面参考手册 | 图谱回答「**是什么、谁连谁**」；这两篇回答「**为什么这么设计、每个 API 怎么用**」。三者互补不互替 |

## 怎么看图（渲染方式）

| 想看什么 | 怎么打开 |
| --- | --- |
| **3D 力导向星图**（节点悬浮空间网状，可拖拽旋转缩放） | **`npm run graph:view`** — 生成 `deps-3d.html`（3d-force-graph，库+数据全内联、离线可开）并自动开浏览器；面板可搜索聚焦、点节点高亮其依赖；`-- --no-open` 只生成不打开 |
| 6 张人读架构图 | GitHub 上直接渲染 `ARCHITECTURE-GRAPH.md`；本地 VS Code 装「Markdown Preview Mermaid Support」扩展后预览 |
| 平面交互依赖图（depcruise 官方页） | `npm run graph:view -- --flat` — 生成并打开 `deps.html` |
| 全量图（GitHub 页内渲染） | [`deps.md`](./deps.md)（mermaid 壳，随 `graph:view` 再生成）；节点数接近 GitHub 页内 mermaid 上限，渲染失败就改用上面的 3D 星图 |
| 单文件 `deps.mmd` | 粘贴到 https://mermaid.live 即时渲染 |

`deps.html` / `deps-3d.html` 是按需产物（自包含页面），已 gitignore 不入库；入库的是 `deps.mmd` / `deps.json` / `deps.md`。

## 再生成

```bash
npm run graph:deps
```

等价展开（`package.json` 的 `graph:deps`，一条命令含产物校验）：

```bash
npm install --no-save --no-audit --no-fund dependency-cruiser@18
npx dependency-cruiser src --include-only "^src" --output-type mermaid --no-config > docs/graph/deps.mmd
npx dependency-cruiser src --include-only "^src" --output-type json  --no-config > docs/graph/deps.json
# 内置护栏：JSON 里模块数 < 140 则报错退出
```

**已知坑（本次踩过）**：用 `npx -y dependency-cruiser@18`（纯 npx 缓存实例）时，depcruise 从自身安装目录 `require('typescript')`，解析不到项目的 typescript 包 → TS 解析器不激活 → **静默输出空图且 exit 0**（`deps.mmd` 只剩一行 `flowchart LR`）。对策就是上面脚本里的先 `npm install --no-save dependency-cruiser@18`（装进项目 node_modules，不改 package.json / package-lock.json），再本地 `npx` 解析。生成后务必核对 `deps.json` 的 `modules.length ≥ 140`（`graph:deps` 已内置该校验，不达标即失败退出）。

**口径说明**：dependency-cruiser 默认**不含纯 `import type` 的边**（编译期擦除），故边数比 INVENTORY §2.7 邻接表（含 type-only）少；查 type-only 依赖以 INVENTORY §2.7 为准。

## 数据基线

- **工作流体验优化刷新（2026-09-20）**：`deps.mmd` / `deps.json` 已重新生成，为 179 个模块，包含 `AgentPicker` 与当前任务隔离实现。`npm run graph:deps` 使用 `ELECTRON_SKIP_BINARY_DOWNLOAD=1` 跳过无关 Electron 二进制下载；图谱生成及规模校验通过。

- **UI 统一改造刷新（2026-09-20）**：当前 `deps.mmd` / `deps.json` 已经 `npm run graph:deps` 刷新，为 173 个模块；`interaction-center`、`interaction-layer` 与订阅/焦点 hook 已纳入。下方数字及 INVENTORY 主体仍保留原始盘点时的历史口径，当前依赖以机器图为准。

- **commit `6b2f038`**（`chore(ship): 热更发布 0.22.0-hot.19 …`，生成图谱时 main 侧最新提交），快照取自检自该提交的干净 worktree。
- **机读图刷新注记（2026-09-19）**：`deps.mmd` / `deps.json` / `deps.md` / `deps-3d` 系列后经 `npm run graph:view` 在主检出重生成，因 `src/main/prompts/` WIP 当时已在工作区，机读图现为 **151 模块 / 305 边**（多了 prompts 组 8 文件）；INVENTORY 与 ARCHITECTURE-GRAPH 仍为基线口径 **143/292**，两套数字之差即该 WIP。WIP 合入后重跑 `npm run graph:deps` 即自然归一。
- 主检出当时存在未提交 WIP：7 个已修改文件（`scripts/smoke-meeting-consult.mjs`、`src/main/{agent-forge,agents,delegate,goal-controller,meeting-controller,runner}.ts`）+ 未跟踪目录 `src/main/prompts/`。**这批 WIP 不在本图谱内**——图谱描述的是已提交基线。
- 因此 INVENTORY 中「`src/main/prompts/` 不存在、提示词逻辑内嵌于 delegate/agent-forge/goal-controller/meeting-controller」等表述只对基线成立；WIP 落地后需重跑 `npm run graph:deps` 并复核相关章节。
- 口径备注：`deps.json` 的 143 模块 = 133 个 .ts/.tsx **+ 10 个 css**（`main.tsx` 引入的样式被 dependency-cruiser 计入）；INVENTORY 的「src 总量 136」单指 .ts/.tsx，两者并不矛盾（136 → 133 的差值是本轮删除的三个 sidecar 垫片）。

## WIP 后处理清单

以下事项因落在主检出**禁改 WIP 文件**里（本轮动了会冲突毁两边），只登记不动刀。WIP 合入后处理：

1. **WIP 文件内的死符号**：`src/main/goal-controller.ts:44-48` 的 `computeGoalProgressKey` / `stableProgressKey` / `computeProgressKey`——三个都是 `progressKeyForOutput` 的历史迭代别名，全仓零引用（INVENTORY §4.A 高置信档）。注意 `progressKeyForOutput` 本身被 `smoke-goal-guards` 消费，**不可删**（§4.C）。其余 WIP 文件（delegate/runner/agents/agent-forge/meeting-controller/smoke-meeting-consult/prompts）合入后建议重跑一轮 INVENTORY 的符号扫描再定。
2. **renderer 三角环已解耦（2026-09-20）**：`TurnTimeline` 已改依赖 `ui/interaction-center.ts`，不再反向导入 `SideDock`。UI 中心与 `interaction-layer` 共用类型明确的状态/命令接口；`npm run smoke:ui` 包含导入环检查及真实 React DOM 焦点回归。
3. **45/46 文件数差异**：任务书口径「src/main 46 个顶层 .ts」，基线快照实为 **45 个**。差异来源即 WIP 的 `src/main/prompts/`——该目录合入后顶层计数会再次变化，届时以 `npm run graph:deps` 产物为准（另：`src/main/sidecar/` 下三个零引用垫片已在本轮删除，`src/main/sidecar/` 目录仅存 `protocol.ts`）。

## 维护约定

- 改动 `src/` 结构（新增目录组、新构建入口、新 IPC 域）后：跑 `npm run graph:deps` 刷新机读图；若分组/主干变了，同步修订 `ARCHITECTURE-GRAPH.md` 对应图与 `INVENTORY.md`（或注明「以 deps.json 为准」）。
- 图谱描述**已提交基线**；WIP 一律进上方清单，不提前画进图里。
