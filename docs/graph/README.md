# docs/graph — CodeGraph 语义索引（代码图枢纽）

本目录是 AgentDeck 的代码图入口：给 agent 与人共用的仓库结构事实源。代码图由 [CodeGraph](https://github.com/codegraph-ai/CodeGraph) 驱动——基于 tree-sitter 的语义图（函数/类/导入/调用链，42 个查询工具、38 种语言），引擎经 devDependency `@astudioplus/codegraph-mcp` 的 postinstall 从 GitHub release 下载本平台二进制（win32-x64 落在包内 `bin/`）。⚠️ 同名裸包 `codegraph` 是 469 字节占位空包，不要装。

> 旧 dependency-cruiser 管线（`deps.mmd` / `deps.json` / `deps.md`、`npm run graph:deps` / `graph:view` 3D 星图）已于 2026-09 退役删除。其中的历史口径（143/292 基线、模块邻接表、死代码三档判定）仍以 [`INVENTORY.md`](./INVENTORY.md) 为准。

## 索引：本目录有什么

| 文件 | 性质 | 什么时候看它 |
| --- | --- | --- |
| **CodeGraph 语义索引** | 机读语义图：当前快照 190 个 src 文件 / 6206 节点 / 13401 边（随提交漂移，以 `npm run graph:index` 输出为准） | 要**机器可计算的代码事实**时：符号检索、谁调用它、循环依赖、死导入、影响面 |
| [`ARCHITECTURE-GRAPH.md`](./ARCHITECTURE-GRAPH.md) | **人读主图**：6 张 Mermaid 图 + 人话导读（**人工维护**，不随索引自动更新） | 想**快速理解架构**时：新人入职、动手前定位改动面 |
| [`INVENTORY.md`](./INVENTORY.md) | **原始盘点**（只读快照）：全量文件职责表、死代码候选三档、smoke 直连清单（附录 A/B） | 要**证据与全量清单**时；判死代码前必查（见 `AGENTS.md` 铁律） |
| `docs/ARCHITECTURE.md` / `docs/API.md` | 既有**人工叙事文档** | 图谱回答「是什么、谁连谁」；这两篇回答「为什么这么设计、每个 API 怎么用」 |

## 刷新索引

```bash
npm run graph:index
```

等价展开（`scripts/graph-index.mjs`，spawn args 数组直调引擎、不经 shell，规避 Windows 引号地狱）：

```bash
npx codegraph-mcp --workspace src --exclude .agentdeck-worktrees --exclude .agentdeck-reports \
  --exclude out --exclude dist --exclude release --exclude teardown \
  --embedding-model static --run-tool codegraph_find_entry_points --tool-args '{}'
```

- **口径**：`--workspace src` 与旧管线 `depcruise src` 同语义——索引计数即 src 文件数；目录聚合摘要 `get_module_summary` 在本版引擎返回全 0，脚本改以索引器日志行为护栏数据源（引擎版本随 package-lock 固定，日志格式稳定）。
- **护栏**（继承旧管线教训：空图静默 exit 0）：src 文件数 < 150 或符号数为 0 → 非零退出并报数；通过则打印 文件数/符号数/节点/边/模式/耗时 与 MCP 查询入口。
- **降级**：默认 `--embedding-model static`（免 ONNX 免 1.5GB 内存门禁）；启动失败或报内存门禁时自动降级重跑一次 `--graph-only`（纯结构兜底），输出注明当前模式。

## 查询四条路

### ① MCP 常驻接入（日常查询首选）

Claude Code 在 `~/.claude.json` 加：

```json
{
  "mcpServers": {
    "codegraph": {
      "command": "npx",
      "args": ["-y", "@astudioplus/codegraph-mcp", "--workspace", "<仓库根路径>"]
    }
  }
}
```

- **DSH 用户**：装 `@hyzyn/dsh-codegraph` 插件即可，无需手写配置。
- **VS Code / JetBrains**：marketplace 装 CodeGraph 官方扩展/插件，装完自带图面板（引擎复用同一份 `~/.codegraph` 安装）。

### ② one-shot（脚本 / CI：先索引 → 跑一次查询 → 退出）

以下三条均在本仓库实测通过（`--graph-only` 纯结构模式，免模型加载）：

```bash
# 符号检索（名字/文本匹配；返回 node_id / 位置 / 签名）
npx codegraph-mcp --workspace src --graph-only --run-tool codegraph_symbol_search \
  --tool-args '{"query":"TaskRunner","limit":10}'

# 谁调用了我（nodeId 来自上一步 symbol_search 的 node_id，注意是字符串）
npx codegraph-mcp --workspace src --graph-only --run-tool codegraph_get_callers \
  --tool-args '{"nodeId":"464"}'

# 循环依赖（文件级环，含自环）
npx codegraph-mcp --workspace src --graph-only --run-tool codegraph_find_circular_deps \
  --tool-args '{}'
```

`codegraph_analyze_impact`（影响面）本版 one-shot 的 uri+line 形态不可用（见「已知坑」），待引擎修复后补入实测示例。

配套还有 `codegraph_find_by_imports`（按导入名反查引用方，实测可用）、`codegraph_find_dead_imports`（死导入候选，实测当前 144 条）、`codegraph_get_dependency_graph` / `codegraph_get_callees` / `codegraph_traverse_graph` 等 42 个工具，全部带 `codegraph_` 前缀。

### ③ IDE 图面板（可视化）

VS Code / JetBrains 插件内置图视图，查看文件/符号依赖关系——替代退役的 3D 星图（`deps-3d.html`）。

### ④ 人读文档

[`ARCHITECTURE-GRAPH.md`](./ARCHITECTURE-GRAPH.md) 人读主图**保留人工维护**（机器图是结构口径，不替代人话导读）；`codegraph_generate_architecture_doc` 可基于索引生成架构文档草稿，供人修订。

## 旧 → 新能力映射

| 旧管线（dependency-cruiser，已退役） | CodeGraph 对应 |
| --- | --- |
| `deps.json` 依赖查询（脚本解析 modules/dependencies） | `codegraph_get_dependency_graph`（本版 one-shot 报 Invalid URI，见已知坑）/ `codegraph_find_by_imports`（实测可用） |
| 循环依赖判定 | `codegraph_find_circular_deps`（实测可用，文件级环） |
| 死代码候选（INVENTORY §4 三档） | `codegraph_find_dead_imports` 只覆盖死**导入**；死**符号**判定仍走 INVENTORY 附录 A + smoke 直连清单（`AGENTS.md` 铁律不变） |
| 3D 星图 `npm run graph:view`（`deps-3d.html`） | VS Code / JetBrains 插件的图面板 |
| `ARCHITECTURE-GRAPH.md` 人读主图 | 保留，**人工维护** |
| ——（旧管线没有） | `codegraph_generate_architecture_doc` 架构文档草稿；`codegraph_analyze_impact` 影响面 |

## 已知坑

- **引擎下载**：postinstall 从 GitHub release 拉 ~101MB 引擎 + `onnxruntime.dll` sidecar，直连可能极慢/超时；**下载失败不炸安装**，重试 `npx codegraph-mcp-fetch-engine`。注意 Node 下载器不读 `HTTP(S)_PROXY`——代理环境要么开 TUN/系统代理，要么手工下载落位到 `node_modules/@astudioplus/codegraph-mcp/bin/`（官方 URL + `.sha256` 校验和，落位后写 `.engine-version` 文件内容为引擎版本号）。
- **内存门禁**：嵌入模式（bge-small 等默认模型需 ONNX）要求 ~1.5GB 可用内存，不足时引擎自动降 graph-only；`CODEGRAPH_SKIP_MEMORY_CHECK=1` 可强开（慎用，可能被 OOM 杀）。本仓库脚本默认 `--embedding-model static` 避开此门禁。
- **static 模型位置**：`~/.codegraph/static_models/jina-code-static-256/`（postinstall best-effort 下载；缺失时索引与结构查询照常，仅语义搜索不可用，脚本不报错）。
- **索引库不入库**：`.codegraph/`（工程本地产物，已 gitignore）；全局图库与命名空间在 `~/.codegraph/`（`graph.db`，按 workspace 派生命名空间）。
- **one-shot 位置解析不可靠（0.20.1）**：`codegraph_analyze_impact` / `codegraph_get_callers` 的 uri+line 形态报 "Could not find symbol at location"，`codegraph_get_dependency_graph` 的 uri 正反斜杠都报 "Invalid URI"（MCP 模式同样）。用 `nodeId`（先 `codegraph_symbol_search` 取 `node_id`）与 `codegraph_find_by_imports` 兜底，等引擎升级后复核。
- **tree-sitter 解析告警**：`src/preload/index.ts:135` 的 `import('../shared/meeting').Meeting` 会打一条 parse WARN（引擎已知噪音，符号照常提取，不影响护栏）。

## 维护约定

- 改动 `src/` 结构后跑 `npm run graph:index`；护栏不过（<150 文件或 0 符号）说明索引坏了，先修再提交。
- 图谱描述**已提交基线**；WIP 不画进图（与旧约定一致）。
- `INVENTORY.md` 是只读快照，不随索引刷新；死代码判定以它 + smoke 直连清单为准。
