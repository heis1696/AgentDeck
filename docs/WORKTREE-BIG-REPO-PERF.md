# 大仓 worktree 建树性能：问题档案与稀疏检出方案

> 2026-09-28 排查档案。背景：nxii（Unity 项目，HEAD 检出 82,584 文件 / 68.53 GiB）上派单建 worktree 极慢且频繁失败。本文记录完整根因链、已落地修复（commit `a205009`）与下一阶段「队长界定稀疏检出」的详细设计，供开发机侧提示词优化一并参考。

## 1. 问题现象

- nxii 派单建 worktree 动辄数分钟，且经常失败；`.agentdeck-worktrees/` 累计 175 GiB。
- 现场残留三具「残尸」worktree（`.agentdeck-merge-mukwp7of`、`t_..._c2`、`t_..._c3`），git 侧特征完全一致：`locked` 文件内容为 `initializing`、`.git/worktrees/<n>/` 下只有 `index.lock` 没有 `index`、无 `agentdeck-generation` 代际标记。
- 主仓 `.git` 约 80 GiB：61.25 GiB 正式 pack（37 个碎片 pack，单个最大 25 GiB）+ 18.22 GiB `tmp_pack_*` 垃圾（9 月 10 日中断的 fetch/repack 残留）。

## 2. 测量数据（证据）

| 测量项 | 结果 |
| --- | --- |
| HEAD 追踪规模 | 82,584 文件 / 68.53 GiB（`client/Assets/Art` 一目录 47.4 GiB） |
| 检出吞吐（小文件基准） | ~44 MB/s、~636 文件/s——瓶颈是海量小文件逐文件开销，非磁盘带宽（NVMe） |
| `git worktree add --no-checkout`（纯元数据） | **110 ms**——worktree 机制本身无罪，全部耗时在检出阶段 |
| 冷建树实际耗时 | 4-6 分钟（安静盘）；磁盘争用下 >9 分钟 |
| `locked=initializing` 的来源 | **git 自身**：`worktree add` 检出期间自锁防并发 prune，完成才解锁。中途被杀即定格残尸 |

关键推理：AgentDeck 从不写 `worktree lock`。残尸 = **被超时树杀（`taskkill /T /F`）掐死在检出中途的 git 进程**。这是全部三类失败的统一物证。

## 3. 根因链（三条，按严重度）

1. **合并/集成链路建树硬编码 60s 超时**（`createWorktreeAtBranch` / `mergeBranchInto` / `mergeIntoManagedWorktreeDetached`）：大仓完整检出至少 4-6 分钟，60s 必死 → `.agentdeck-merge-*` 残尸的成因，意味着这类仓库上**集成/二次集成从未成功过**。
2. **worker 链路自适应档位太紧**：原公式 60s + 每 1 万文件 +60s（8 万文件 = 9 分钟）、封顶 15 分钟。安静盘 4-6 分钟能过，但磁盘争用（并行建树、Unity 编辑器同跑）下 9 分钟被击穿 → `c2`/`c3` 残尸成因。
3. **残尸磁盘螺旋**：每次超时击杀留下半写的 68.5 GiB 目录残尸；重试用新名字继续付全款；残尸只能靠重启清扫回收 → 175 GiB。

背景慢性病（属仓库侧，非 AgentDeck 问题）：大二进制全直进 git（LFS 零使用）、37 个碎片 pack、17,027 提交——fetch/repack 都是数十 GiB 级操作，易超时再留垃圾，恶性循环。

## 4. 已落地修复（commit `a205009`，main）

1. **三处合并/集成建树改用与 worker 建树相同的规模自适应超时**（`planWorktreeAddTimeout`，ls-files 计数 + 每仓 TTL 缓存）。小仓维持 60s 基线，行为零变化。
2. **档位校准**：每 1 万文件 +60s → **+90s**，封顶 15 → **30 分钟**（8 万文件仓约 13 分钟预算）。常量 `WORKTREE_ADD_TIMEOUT_PER_10K_FILES_MS` / `WORKTREE_ADD_MAX_TIMEOUT_MS`。
3. **检出并行化**：新增 `checkoutWorkersArgs()`——建树与池化换基线的全部检出命令（`worktree add` / 池内 `switch -c` / `reset --hard`）统一注入 `git -c checkout.workers=<n>` 并行检出。
   - 默认按 CPU 保守档：`min(4, floor(cpus/4))`，≥2 才启用（8 核→2、16 核→4 封顶）。
   - 环境变量 `AGENTDECK_CHECKOUT_WORKERS=<n>` 显式覆盖；≤1 或非法值 = 关闭（机械盘/网络盘负优化时的逃生门）。
   - 超时树杀不受影响：`checkout--worker` 是 git 子进程，`taskkill /T` 按树可达。
4. smoke-worktree-timeout 档位断言同步 + 新增 ①c（注入与开关断言）；CHANGELOG 补「变更」「修复」各一条。
5. 验证：typecheck / build / smoke:worktrees（lifecycle+ownership+timeout）/ smoke:stage6 / smoke:lifecycle 全绿。

诚实备注：并行检出的净提速比未拿到干净测量（实测时与线上建树争抢磁盘，13 分钟跑了 78%，机械可行、无损坏，但数字被污染）。保守默认档 + env 开关就是为此留的余地。

## 5. 运维侧动作（仓库侧）

- nxii 的 18.3 GiB `tmp_pack_*` 垃圾已清理（`count-objects` 确认 garbage=0）。
- 残尸 worktree 归 AgentDeck 启动清扫管：**重启 AgentDeck 即自动回收**（约 100+ GiB）。
- 中期治理（仓库侧）：大资源迁 LFS、低峰期 `git gc` 合并碎片 pack（注意 61 GiB pack 的 gc 本身要跑很久）。

## 6. 稀疏检出方案：范围交队长界定（下一阶段，未实施）

**决策已定**：默认仍走全量建树；稀疏检出的范围由领队在派单时按单声明，属提示词/协议层扩展。结构性优点：**集成本来就发生在独立的全量 worktree（分支级 merge），稀疏只作用于子队员工作树**——爆炸半径天然可控。

### 6.1 协议形态

- `<delegate>` 标记新增可选属性：`<delegate to="X" sparse="client/Assets/GameMain,excel-tool">指令</delegate>`
- **只收目录前缀列表**（逗号分隔），映射 git cone 模式（`git sparse-checkout set --cone`）；**不收 glob 通配**——从根上防住 LLM 写错路径模式（空格、中文目录名、Windows 反斜杠）。
- 缺省属性 = 全量，行为与今天完全一致。
- 校验失败（目录不存在 / 格式非法）→ **回落全量 + 时间线注记**，不拒单——与池化同一哲学：加速捷径永远不是正确性依赖。

### 6.2 建树层实现

带 sparse 时：`worktree add --no-checkout` → `sparse-checkout set --cone <dirs>` → `git checkout`（检出命令照常注入 `checkout.workers` 与规模档位超时）。

### 6.3 各层工程点与风险

| 层 | 交互 | 处理 |
| --- | --- | --- |
| 基线回放 | 领队未提交增量 cherry-pick 进子树，稀疏树 scope 外文件带 skip-worktree 位，有暗坑 | 回放有自己的文件清单，与稀疏范围**取并集**后回放，工程上干净（关键点） |
| 池化复用 | 池树带旧稀疏配置 | 池条目记录稀疏范围：同范围秒级换基线；异范围重设 + 补物化（可二期） |
| 集成合并 | 不受影响（独立全量树做 merge） | 无 |
| digest/diff | tree 级 diff 不受工作树稀疏影响 | 天然安全 |
| 圈错范围 | 子 agent 缺文件失败 | 回灌文案带「本单稀疏检出范围：…」→ 队长扩圈重派（自愈但烧一轮，守则要讲清成本） |

### 6.4 分期与验收

- 一期（最小闭环）：协议解析 + 建树稀疏路径 + 回放并集 + 回落全量 + 专项 smoke（稀疏生命周期/回放交互/回落）。
- 二期：池化稀疏范围匹配。
- 验收：nxii 上声明 `client/Assets/GameMain,excel-tool` 的派单建树 < 1 分钟（对照全量 4-6 分钟）；不声明 sparse 的单子全量行为零变化（既有 smoke 不动全绿）。

## 7. 提示词部分的具体建议（给开发机侧提示词优化直接取用）

### 7.1 领队系统提示词增补段（草稿，可改写）

```
【稀疏建树（可选）】派单标记可带 sparse 属性圈定子任务的检出范围（目录前缀、逗号分隔）：
<delegate to="队员" sparse="client/Assets/GameMain,excel-tool">…</delegate>
仅圈目录粒度，不含通配符。使用守则：
- 只在明确知道子任务触达面时声明（改代码/文档/配置类单子最典型）；拿不准就省略属性走全量。
- 声明前先勘察仓库布局确认目录存在且覆盖子任务要读写的全部路径；资源/构建类任务不要稀疏。
- 范围圈小了子任务会因缺文件失败，回灌会注明本单稀疏范围——扩圈后重派即可，但会多烧一轮，宁可略宽。
- 大仓（数万文件级）优先考虑：全量建树要数分钟，稀疏可降到秒-分钟级。
```

### 7.2 回灌文案模板增补

子单失败回灌若该单带稀疏范围，失败说明附：「本单稀疏检出范围：X、Y——若子任务报告文件缺失，请扩圈或去掉 sparse 属性重派」。

### 7.3 协议规范要点（解析侧）

- 属性名 `sparse`；值 = 目录前缀列表，逗号分隔，`/` 或 `\` 分隔符都收、归一为 `/`；空值/全空白 = 视为未声明。
- 目录不存在 → 回落全量 + 时间线注记（注记文案含被拒目录与回落决定）。
- 属性不得出现通配符 `*?[]`，含则整单回落全量并注记。
- 解析层与既有 delegate 协议错误容忍一致：非法不拒单、不静默——注记可见。
