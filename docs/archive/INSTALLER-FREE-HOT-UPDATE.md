# AgentDeck 免安装热更方案讨论
> 📦 **档案（2026-09-19 文档审计，基线 `6b2f038` / v0.22.0-hot.19）**：历史方案讨论稿（不含实现），已归档。
> **写于** 2026-09-16｜ **被取代**：docs/HOT-UPDATE-IMPL-DESIGN.md（正式实现设计，0.19.0–0.21.0 全量落地） ｜ **现状看** docs/HOT-UPDATE-IMPL-DESIGN.md、docs/HOT-FEED-DEPLOY.md。


> 前置文档：`HOT-UPDATE-COMPARISON.md`（三路线对比，推荐"渲染层热更 + electron-updater 全量"混合分阶段）。
> 本文回答其遗留问题：**更新全程能否不执行任何安装器**（NSIS 静默 `/S` 也算安装器），以及分发形态如何配合。
> 只做方案讨论，不含实现代码。事实基础 = 领队本地盘点 + 两条调研线（外部生态核实、仓库全量清扫），来源见 §2 与 §9。

## 0. 结论先行（TL;DR）

**推荐"三层免安装"架构：渲染层零重启热更（沿用原路线②）+ JS 载荷指针化热更（快速重启壳、不换壳）+ 壳自替换（Chromium 同款 rename dance，低频）。分发侧以"目录式 zip"作为免安装主渠道，NSIS 保留一段迁移期。**

三个载重判断：

1. **electron-updater 帮不上忙**：它在 Windows 上只支持 NSIS 产物，portable 官方明确标注不可自动更新，zip/dir 无任何更新路径（§2.1 E1）——免安装热更**没有标准件，必须自研**。
2. **但自研量可控**：三层共用同一套"staging → 校验 → 原子指针 → 自愈回退"机制，只是更新物粒度不同；比原路线③的"NSIS + 热更双轨"机制反而更统一。
3. **OS 语义已实证**：Windows 运行中的 exe 可改名不可删除，"rename 旧 → 放新"的替换手法本机实证成立且为 Chromium 安装器同款（§2.1 E3）——壳自替换有可靠的地基。

**前置缺口一个：单实例锁**（当前完全没有，`requestSingleInstanceLock` 零命中，§2.2 G4）——无论是否做热更都该先补。

---

## 1. 术语界定

**免安装热更 = 更新全程不执行任何安装器**。三层含义：

- 更新物下载后只做"文件搬运 + 指针翻转"，不执行任何 setup/NSIS；
- 与"分发形态"（首装怎么来）解耦：NSIS 装的、zip 解压的，都可以走同一套免安装热更；
- 极端形态是连首次获得都免安装（目录式 zip，绿色软件）。

注意：免安装 ≠ 解决无签名问题。zip 解压出的 exe 首次运行同样弹 SmartScreen；签名的根治路径仍是证书（见 `HOT-UPDATE-COMPARISON.md` §3.3，结论不变）。免安装的真实收益是：**更新不再需要提权、不再写注册表/安装目录、天然多版本可回滚**。

---

## 2. 事实基础

### 2.1 外部事实（已核实官方文档/源码，Windows 11 本机实证）

| # | 事实 | 置信度 | 对方案的影响 |
|---|---|---|---|
| E1 | electron-updater 的 Windows 自动更新**仅支持 NSIS**（含 nsis-web）：`win32 → NsisUpdater` 无其他分支；官方目标表将 portable 的自动更新标注为 **No (Manual)**，且 portable 构建不写 `app-update.yml`；zip/dir 产物无任何 Updater 实现 | 高（官方源码 + 文档） | 免安装 = 自研，没有标准件可抄 |
| E2 | electron-builder `portable` 单文件产物：每次启动把完整应用解压到 `%TEMP%` 唯一子目录（`unpackDirName` 可改为固定目录），退出后清理，强杀则残留；`requestExecutionLevel` 默认 `user` | 高（NSIS 模板源码） | 冷启动慢、杀软对自解压 exe 敏感、与长驻任务板不匹配 → **否决 portable 单文件作为主分发** |
| E3 | Windows 运行中 exe：**可重命名（可连续多次）**；不可删除、不可覆盖；所在目录可改名、改名后的目录不可删；完整"rename 旧 exe → 放新 exe"**本机实证成立**。Chromium 安装器同款手法（`chrome/installer/setup/install_worker.cc`：目标占用时 move chrome.exe → new_chrome.exe，下次清理） | 高（本机实证 + Chromium 源码出处） | 壳自替换的 OS 语义可靠 |
| E4 | electron-updater 的 NSIS 更新本质 = 下载新安装器 exe 后静默运行安装器本身（`/S`，需要时 `elevate.exe` 提权） | 高（源码） | 原路线①的"静默更新"其实仍在跑安装器——免安装热更正是要消掉这一步 |

### 2.2 仓库事实（src 全量 grep + 构建产物逐文件清点）

| # | 事实 | 位置 | 对方案的影响 |
|---|---|---|---|
| G1 | **JS 载荷自包含**：`out/main/index.js` 仅 require `electron` + node 内置 + 本地 chunk；`sidecar-server.js` 连 electron 都不 require；preload 仅 require electron；渲染层为相对路径 asset、全部依赖已进 bundle（dependencies 只有 React 系且全在渲染层） | `out/` 产物清点；`package.json` dependencies | 载荷 = `out/**` + `package.json`，搬目录**无需拖 node_modules** |
| G2 | 布局假设仅 `__dirname` 相对 5 处（preload / renderer / sidecar-server / icon / sidecar 兜底），`process.resourcesPath`、`app.getAppPath()`、`NODE_PATH` 零引用；持久化全部落在 userData / home | `src/main/index.ts:80,82,93,110`、`src/main/sidecar.ts:261` | 载荷整体搬迁时随 `__dirname` 自动重定位，**无需逐处改代码** |
| G3 | sidecar 是唯一依赖安装目录内容的子进程（入口在 out/ 里，经 `process.execPath + ELECTRON_RUN_AS_NODE` 拉起）；"electron 充当 node"的兜底还散布在 agent CLI 适配层至少 4 处 | `src/main/sidecar.ts:263-267`、`src/main/backends/cli-locator.ts:92`、`dsh.ts:43`、`dsh-acp.ts:137` | 换壳时 exe 被"主进程 + sidecar + 可能多个 CLI 兜底进程"共同持有：**不能删只能改名腾挪，清理必然延后**（机制见 §5） |
| G4 | **单实例锁缺失**：`requestSingleInstanceLock` / `second-instance` 零命中；userData 里的 JSON store 无并发写保护（sidecar 有 port+token 收编机制，救不了 store 并发写） | `src/main/` 全量 grep | 换壳 relaunch 窗口期新旧实例并存 → **阶段 0 前置补锁**（独立于热更也是缺陷） |
| G5 | 顺带发现：窗口图标 `build/icon.png` 是**死路径**——`files` 只含 `out/**` + `package.json`，打包后 asar 内没有 build/，图标静默回落默认 | `src/main/index.ts:80`、`electron-builder.yml:6-8` | 与热更无关的独立小缺陷，建议顺手修（files 增加 `build/icon.png`） |

---

## 3. 分层模型（核心提案）

把"应用"拆成三层，每层有自己的更新物、生效方式与频率：

| 层 | 更新物 | 生效方式 | 重启壳? | 打断任务? | 频率 |
|---|---|---|---|---|---|
| L2 渲染层 | `out/renderer` | 指针翻转 + `loadFile` 新路径 | 否 | 否 | 最高（日级） |
| L1 JS 载荷 | `out/main` + `out/preload` + `out/renderer` + `package.json` | 指针翻转 + `app.relaunch()` | 快速重启 | 是 → 空闲门控 | 中（周级） |
| L0 壳 | Electron exe + dlls 全套 | rename dance 自替换（§5） | 重启 + 换目录 | 是 → 低频 + 用户确认 | 低（月级或更久） |

要点：

- **L1 / L2 共用机制**：原路线②的"staging → manifest 验签 → 原子指针 → 启动自愈回退"原样上移一层。L2 更新物是渲染层目录；L1 更新物是整个 JS 载荷目录（`userData/hot-app/<version>/`），加载入口经 bootstrap 解析。
- **bootstrap stub**：asar 内置一个几乎永不更新的最小入口——读指针 → require userData 载荷 → 校验失败兜底 asar 内置载荷。`package.json` 的 `main` 始终指向 asar 内入口，**无需运行时改 main 字段**。
- **L0 触发条件罕见**：Electron 大版本升级、native 依赖变更。可以先不做全自动 L0：下载好新壳放 staging、引导用户确认甚至手动替换，自动 rename dance 作为进阶（§5 风险）。
- L1 重启虽打断任务，但有双重缓解：更新门控（runner 有活动任务时挂"待更新"，空闲或退出时应用——`autoInstallOnAppQuit` 的思路）；中断兜底已有启动对账（`src/main/index.ts:224-249`）。

---

## 4. 分发形态对比

| 形态 | 首装体验 | 启动 | 自更新适配 | 结论 |
|---|---|---|---|---|
| NSIS 安装器（现状） | 向导 + UAC（装用户目录可免提权） | 快 | electron-updater 标准件 | 保留一段迁移期，服务存量用户 |
| portable 单文件 | 单文件 | 每次解压 `%TEMP%`，慢 | 官方明确 No | **否决**（E2） |
| **目录式 zip（`--dir` 产物打 zip）** | 解压即用 | 快（文件原地） | rename dance 原地替换（E3） | **推荐：免安装主渠道** |

目录式 zip 的附加好处：用户自选位置、无注册表/卸载器负担、版本目录天然多版本；快捷方式指向固定路径，自替换原地腾挪后**快捷方式不失效**。

---

## 5. 壳自替换机制（L0 细节，Chromium 同款）

1. **下载与校验**：壳 zip → staging 解压 → manifest sha256 + Ed25519 验签（与 L1/L2 同一套签名体系，公钥随壳发布）。
2. **时机**：用户确认 + runner 空闲（有活动 agent 任务时不 Offer）。此时仍有约束：sidecar 与 CLI 兜底进程可能持有运行中 exe（G3）——不影响改名，只影响删除。
3. **rename dance**：停机（runner/sidecar shutdown）→ 当前目录改名 `appdir.old-<ts>`（运行中可改名，E3）→ 新壳 move 进原路径 → 指针写新载荷版本 → relaunch。
4. **残留清理**：下次启动扫描 `*.old-<ts>` 删除（通常已无句柄；仍被占则跳过下次再试）——与 Chromium `new_chrome.exe → old_chrome.exe` 清理节奏相同。
5. **一致性**：任一步被杀都安全——改名是原子操作，旧目录在指针翻转前完好；新壳就位但指针未写 = 新壳 + 旧载荷，由 `minShellVersion` 门禁兜底（§6）。

**风险**：无签名放大了杀软对"应用自我替换 exe"的启发式敏感度。对策：观察期用半自动（下载好、引导确认/手动替换），自动 dance 作为进阶；根治仍是证书。

---

## 6. 风险与对策总表

| 风险 | 对策 |
|---|---|
| 无单实例锁 → relaunch 窗口双实例并发写 store（G4） | 阶段 0 补 `requestSingleInstanceLock`（独立收益：防误开多实例）；实现期复核 store 写入是否 tmp+rename 原子 |
| L1 重启打断 agent 任务 | 空闲门控 + 退出时应用；启动对账兜底（`src/main/index.ts:224-249`） |
| IPC 契约漂移（新载荷调旧壳没有的 API） | manifest 版本链：渲染层 `minMainVersion`、载荷 `minShellVersion`；契约只增不改（`src/shared/contracts.ts`） |
| 壳与载荷版本错位 | 壳更新自带当时最新载荷并**重置指针**（"全量 > 增量"协同规则沿用路线③） |
| 完整性 / 防篡改 | 全层统一：HTTPS + sha256 + Ed25519 manifest 签名，校验失败拒绝切换并回退 |
| 回滚 | 载荷：保留 N 版 + 指针回退 + asar 内置兜底；壳：`*.old-<ts>` 目录保留 N 个 |
| SmartScreen / MOTW | 与签名同源，证书是根治；zip 首次运行文档引导"解除锁定" |
| 杀软误报自我替换 | 半自动模式过渡（§5） |

---

## 7. 与原路线③的关系及落地顺序

原③ = 渲染层热更② + electron-updater NSIS ①。本文把①的"NSIS 全量通道"**替换**为"L1 载荷热更 + L0 壳自替换"：全链路免安装器、机制统一（一套指针/验签/自愈）、摆脱 electron-updater 的 Windows NSIS-only 限制；代价是 L0 自替换自研（Chromium 手法有源码参照，OS 语义已实证）。

| 阶段 | 内容 | 产出 | 约工作量 |
|---|---|---|---|
| 0 | 单实例锁 + bootstrap 指针加载骨架（热更目录优先 / asar 兜底）+ 修 G5 图标死路径 | 双路径加载可回退 | 1 天 |
| 1 | L2 渲染层热更（updater / 验签 / 指针 / UI / 发布脚本） | 渲染层热更上线 | 5–7 天 |
| 2 | L1 载荷热更 + 空闲门控 + relaunch 流程 | 载荷通道上线 | 2–3 天 |
| 3 | 分发切目录式 zip + 发布管线（一套脚本产三层 feed） | 免安装分发渠道 | 2 天 |
| 4 | L0 壳自替换（先半自动，后全自动 rename dance + 残留清理） | 壳通道上线 | 3–4 天 |

合计约 **13–17 人日**；任一阶段可止步（阶段 1 后即具备高频免安装热更能力，L0 可长期半自动）。

---

## 8. 开放问题（需决策，不阻塞阶段 0–2）

1. 分发渠道与 feed 托管（GitHub Releases vs 静态站）——影响 feed 结构与下载 URL 策略。
2. NSIS 退役时间表（迁移期多长、是否双产物并行发版）。
3. L0 采用全自动还是长期半自动（杀软观察期长度）。
4. 代码签名证书的预算与时间点（三层与 NSIS 通道共同受益）。

---

## 9. 附：引用清单

**仓库内**

- `electron-builder.yml:1-18` —— appId、files（仅 `out/**` + `package.json`）、NSIS 目标
- `src/main/index.ts:80/82/93/110` —— 图标（死路径 G5）、preload、渲染层入口、sidecar entrypoint 的 `__dirname` 五处
- `src/main/sidecar.ts:261-267` —— sidecar 以 `process.execPath + ELECTRON_RUN_AS_NODE` 拉起
- `src/main/backends/cli-locator.ts:92`、`cli-common.ts:99-102`、`dsh.ts:43`、`dsh-acp.ts:137` —— electron 充当 node 的兜底散布点
- `src/main/index.ts:224-249` —— 启动对账（中断兜底）；`:418-432` 退出停机；`:434-438` 关窗不退出
- `package.json` dependencies —— 仅 React 系（渲染层），主进程无运行时 npm 依赖
- `HOT-UPDATE-COMPARISON.md` —— 前置对比文档（路线①②③、Ed25519 manifest、minMainVersion 等机制细节）

**外部（调研核实出处）**

- electron-updater 源码 `packages/electron-updater/src/index.ts:53-83`（`doLoadAutoUpdater`，win32 仅 NsisUpdater）；`NsisUpdater.ts:362-409`（静默 `/S` + elevate）
- electron-builder 官方文档 auto-update 页（Windows 可更新目标仅 NSIS；Squirrel.Windows 不支持）与 targets 页（portable 自动更新 = No）
- electron-builder 源码 `NsisTarget.ts:363`（`isWriteUpdateInfo: !isPortable`）、`templates/nsis/portable.nsi:33-39,77-90`（portable 解压到临时目录与 `PORTABLE_EXECUTABLE_*` 环境变量）
- Chromium 安装器源码 `chrome/installer/setup/install_worker.cc:622-651`（目标占用时 rename chrome.exe → new_chrome.exe 的替换手法）
- Windows 11（10.0.26200）本机实证：运行中 exe 可改名（含连续）、不可删除/覆盖；所在目录可改名不可删
