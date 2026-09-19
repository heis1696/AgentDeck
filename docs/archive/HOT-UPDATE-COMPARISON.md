# AgentDeck 生产环境热更方案对比
> 📦 **档案（2026-09-19 文档审计，基线 `6b2f038` / v0.22.0-hot.19）**：历史选型对比，已归档。
> **写于** 2026-09-16（0.18.2 三路线对比）｜ **被取代**：「混合分阶段」结论经 INSTALLER-FREE-HOT-UPDATE.md（本目录）细化为三层免安装方案，由 docs/HOT-UPDATE-IMPL-DESIGN.md 设计并于 0.19.0–0.21.0 落地 ｜ **现状看** docs/HOT-UPDATE-IMPL-DESIGN.md（机制）与 docs/HOT-FEED-DEPLOY.md（运维）。


> 目标：为 AgentDeck（Electron + electron-builder NSIS、Windows x64、`appId: ai.agentdeck.desktop`、无代码签名、`files` 仅 `out/**` + `package.json`、渲染层生产模式 `loadFile` 加载）设计生产环境热更。
> 本文只做方案对比与决策，不含实现代码；引用代码位置一律使用仓库相对路径。

## 0. 结论先行（TL;DR）

**推荐路线 ③（混合 / 分阶段）：日常渲染层热更（路线 ②）+ 主进程改动走 electron-updater 全量更新（路线 ①），落地顺序先 ② 后 ①。**

一句话理由：AgentDeck 的执行状态驻留在主进程（runner / sidecar），全量更新必然重启应用、打断正在运行的 agent 任务；而日常迭代主战场是渲染层（`src/renderer/` 60+ 文件）。先上 ② 用最小代价覆盖最高频更新且不打断任务，再补 ① 作为主进程 / 兜底通道，两条路线的完整性校验都可在无签名约束下自主补强。若只允许单通道（以维护成本最低为唯一目标），退而求其次选 ①。

---

## 1. 与热更直接相关的现状盘点（仓库事实）

| # | 事实 | 位置 | 对热更的影响 |
|---|---|---|---|
| F1 | `appId: ai.agentdeck.desktop`，无任何签名配置（无证书、无 `publish` 段） | `electron-builder.yml:1` | 安装器无 Authenticode 签名；electron-updater 失去发布者身份背书 |
| F2 | `files` 仅 `out/**` + `package.json`，未关闭 asar、未配 `asarUnpack` | `electron-builder.yml:6-8` | 运行时全部资源打进只读 `app.asar`（含 `out/renderer`），**运行时不可原地改写** |
| F3 | NSIS 目标，`oneClick: false`、`allowToChangeInstallationDirectory: true`，仅 x64 | `electron-builder.yml:10-17` | 单 feed（win-x64）即可；安装目录可能落在 Program Files（ACL 受限） |
| F4 | 生产模式 `mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))` | `src/main/index.ts:93` | 渲染层入口从 asar 内固定路径加载；热更需改解析逻辑 |
| F5 | 渲染层构建输出 `out/renderer`，入口 `src/renderer/index.html` | `electron.vite.config.ts:27-36` | 路线 ② 的更新物即整个 `out/renderer` 目录 |
| F6 | 退出流程：`before-quit` 中 `runner.shutdown()` + `sidecarManager.stop()` | `src/main/index.ts:418-432` | 全量更新的强制重启 = 杀掉在跑的 agent 任务（虽有重启对账兜底，见 F8） |
| F7 | 关窗不退出：`window-all-closed` 保持主进程存活 | `src/main/index.ts:434-438` | 渲染层窗口重载 / 重建很便宜，主进程状态不受影响 —— 路线 ② 的核心前提 |
| F8 | 启动对账：重启后把中断任务补记为失败 / 恢复排队 | `src/main/index.ts:224-249` | 中断有兜底，但仍是"中断"，体验与产出损失真实存在 |
| F9 | preload 为 `contextBridge` 类型安全桥（`nodeIntegration: false`、`contextIsolation: true`） | `src/preload/index.ts:1-2`、`src/main/index.ts:81-86` | 渲染层无权写文件；下载 / 校验 / 落盘只能由主进程经 IPC 完成（对路线 ② 反而是安全边界） |
| F10 | 当前无任何更新代码、无 `electron-updater` 依赖 | `package.json`（dependencies） | 三条路线都从零开始 |
| F11 | Multica 参照：自动更新用 electron-updater、按 OS+CPU 架构分 feed；CLI 引导下载用 GitHub Releases + sha256 校验 | `reports/MULTICA-TEARDOWN.md:237`、`:236` | 路线 ① 的直接先例；sha256 校验是该团队的既有实践 |

---

## 2. 评估维度

| 维度 | 含义 |
|---|---|
| 覆盖面 | 能更新哪些部分（渲染层 / 主进程 / Electron 本体） |
| 中断代价 | 更新是否会打断运行中的 agent 任务、是否强制重启 |
| 签名依赖 | 无代码签名约束下的信任锚是什么、用户侧摩擦多大 |
| 一致性 | 更新中途被杀进程时，应用是否仍可启动、状态是否一致 |
| 回滚能力 | 出问题后回退的路径与速度 |
| 工作量 | 端到端（主进程改造 + 发布管线 + 运维）人日 |

---

## 3. 路线 ①：electron-updater 全量自动更新（generic feed 静态托管）

### 3.1 原理

1. 在 `electron-builder.yml` 增加 `publish: { provider: generic, url: <https 静态托管> }`，构建时产出 `latest.yml`（含 `version`、`files[].url/size`、`sha512`、`path`、`releaseDate`）与 blockmap（差分更新用），与 NSIS 安装包一并上传到静态托管（Multica 做法：按 OS+CPU 架构分 feed，`reports/MULTICA-TEARDOWN.md:237`；AgentDeck 只需一个 `win-x64` feed）。
2. 主进程引入 `electron-updater`，启动 / 定时调用 `checkForUpdates`；检测到新版后下载安装包 → 校验 `latest.yml` 中的 sha512 → 静默执行 NSIS 安装器（`/S`）→ 以 `--updated` 参数拉起新版本。
3. 安装布局上，electron-builder NSIS 产物采用版本化目录（安装目录下 `app-<version>/resources/app.asar` + 根目录加载器指针），升级 = 写入新版本目录后切换指针，旧版本目录保留。
4. 下载与安装由主进程完成（同 F9：渲染层只通过 IPC 拿到"可更新 / 下载进度 / 已完成"状态并展示）。

### 3.2 优点

- **覆盖面完整**：主进程、preload、渲染层、Electron 版本、依赖树一次到位 —— 是唯一能修复主进程 bug / 升级 Electron 的通道。
- **生态成熟**：electron-updater 是行业标准件，下载重试、差分（blockmap）、进度事件、退出时安装（`autoInstallOnAppQuit`）等都有现成实现，自研代码量最小。
- **有既有先例**：Multica 同构做法已验证（`reports/MULTICA-TEARDOWN.md:237`），团队有可抄的作业。

### 3.3 风险与对策

| 风险 | 对策 |
|---|---|
| **无签名（Windows）**：安装器无 Authenticode，SmartScreen / Mark of the Web 可能弹"未知发布者"警告，个别环境直接拦截；electron-updater 在 Windows 上不强制校验安装包签名（macOS 才强制），可选的 `publisherName` 发布者校验因无签名不可用 | ① 信任锚改为 **HTTPS feed + `latest.yml` sha512**（electron-updater 内置，下载后先验哈希再执行），把风险压到"信任 feed 源"级别；② feed 服务器额外提供**自签 manifest**（见路线 ② 的同款签名方案），主进程下载前先验签；③ 内部小规模分发场景可容忍 SmartScreen 一次放行；④ 中长期申请代码签名证书，①③ 路线同时受益 |
| **完整性校验**：仅靠 `latest.yml` 的 sha512，若 feed 被攻破，`latest.yml` 本身可被篡改 | HTTPS + 证书固定；对 `latest.yml` 额外做内容签名（主进程内置 Ed25519 公钥验签），无签名环境也能获得内容级防篡改 |
| **回滚**：electron-updater 无自动回滚；新版有 bug 只能等下一个版本 | ① 服务器侧版本门禁：保留旧安装包，把旧版 `latest.yml` 重新发布即可让存量客户端回退（配置 `allowDowngrade`）；② 用 stable/beta 双 feed 做灰度，坏版本只发 beta；③ 本地侧 NSIS 版本化目录保留了旧 `app-<version>`，紧急时可引导用户直接启动旧目录 |
| **被杀进程时的一致性**：安装器执行中途被杀（断电 / 强杀） | 版本化目录 + 指针式切换天然原子：指针切换前旧目录完好；最多残留一个未接管的 `app-<version>` 新目录，下次安装 / 卸载时清理。补充对策：安装完成后才重启（`--updated`），下载失败 / 安装失败自动重试并留日志，更新前 UI 明确提示 |
| **中断运行任务**：全量更新必然重启进程，杀掉在跑的 agent 任务 | ① 用 `autoInstallOnAppQuit`：下载好安装包，**等用户自然退出时再装**，不打断；② 即使被强更打断，`src/main/index.ts:224-249` 的启动对账会把中断任务补记为失败 / 恢复排队（兜底存在，但仍是中断 —— 这是本路线被扣分的主因） |
| **安装目录写权限**：装在 Program Files 时，更新需写安装目录（assisted 安装器弹 UAC）；用户装在用户目录则无碍 | 文档写明"建议安装到用户目录"；UAC 提示属预期行为，不静默绕过；后续可评估 perMachine 策略 |

### 3.4 工作量

**约 3–5 人日**：electron-updater 集成 + 更新状态 IPC/UI（可挂 `src/renderer/src/components/SettingsView.tsx`）+ `publish` 配置与 feed 托管（静态托管 + 发布脚本）+ 无签名下的 manifest 验签补强 + 测试（含中断 / 回滚演练）。后续维护成本最低。

---

## 4. 路线 ②：渲染层热更（只换 `out/renderer`，主进程不动）

### 4.1 原理

1. **发布物**：每个渲染层版本 = 整个 `out/renderer` 目录（`electron.vite.config.ts:27-36` 的产物）打包成 zip + 一份 manifest：`{ version, minMainVersion, files: [{ path, sha256 }], signature }`，上传静态托管。
2. **更新流程（全在主进程）**：定时 / 启动时拉 manifest → 主进程用内置公钥验签 → 下载 zip 到 `userData` 下的 staging 目录 → 逐文件校验 sha256 → 解压到 `userData/hot-renderer/<version>/renderer/` → 原子写指针文件 `current.json`（写临时文件 + rename）→ 显式 `loadFile(新目录/index.html)` 切换。注意：**切换必须显式 `loadFile` 新路径**，`webContents.reload()` 只会重载旧 URL。
3. **主进程"不动"的准确含义**：热更运行时不需要重启或替换主进程任何代码（`src/main/index.ts:434-438` 保证窗口重载时 runner / sidecar 状态原样保留）；但需要**一次性**的主进程改造：加载路径解析（`src/main/index.ts:93` 改为"热更目录优先、asar 内置兜底"）+ 一个 updater 模块 + 新增 IPC（挂 `src/main/ipc/register.ts` / `src/preload/index.ts`）。此后每次渲染层发版都不再触碰主进程。
4. 渲染层因 `nodeIntegration: false` 无法自写文件（F9），下载与验签全部收敛在主进程 —— 安全边界恰好正确。

### 4.2 asar 与文件写权限（本路线的核心工程约束）

| 问题 | 结论 |
|---|---|
| 更新物能否直接写进 `app.asar`？ | **不能**。asar 是只读归档（F2：未关 asar、未 `asarUnpack`），运行时无法改写 `resources/app.asar` 内的 `out/renderer` |
| 能否 `asarUnpack` 后写安装目录？ | 不可靠：安装目录若在 Program Files，普通用户无 ACL 写权限（F3 允许用户自选目录）；要写就得提权，与"无签名、免打扰"的目标冲突。**否决** |
| 正确落点 | `app.getPath('userData')`（`%APPDATA%\agentdeck`）：恒可写、无需提权、与 asar 解耦。加载解析顺序改为：指针有效且校验通过 → `userData/hot-renderer/<ver>/renderer/index.html`；否则回退 asar 内置版本（`src/main/index.ts:93` 原路径） |

### 4.3 优点

- **不打断执行**：更新只重载渲染窗口，主进程 runner / sidecar 全程存活（F7），运行中的 agent 任务零影响 —— 对 AgentDeck 这种长任务应用价值最大。
- **秒级、高频友好**：更新物只有渲染层资源（比全量安装包小一到两个数量级），适合日更甚至更频繁的 UI 迭代。
- **签名无关**：下载物是静态资源而非可执行文件，SmartScreen / Authenticode 完全不参与；完整性由 manifest 内容签名自足保障。
- **天然多版本**：`userData/hot-renderer/` 下可保留最近 N 个版本目录，回滚 / 对比成本极低。

### 4.4 风险与对策

| 风险 | 对策 |
|---|---|
| **完整性校验**：zip 与单文件 sha256 只防传输损坏，不防篡改；manifest 被替换则校验整体失效 | manifest 用 **Ed25519 签名**，公钥内置主进程（随主进程发布、更新需走路线 ①）；私钥离线保管 / 进 CI secret，manifest 带 `keyId` 支持密钥轮换。校验失败即拒绝切换并回退内置版 |
| **被杀进程时的一致性**：下载 / 解压 / 写指针中途被杀 | 三阶段 + 指针原子化：staging 目录里完成下载与全部校验 → rename 成版本目录 → 指针文件"临时文件写入 + rename"翻转（同卷原子）。**启动自愈**：每次启动校验当前指针目录的 manifest 哈希，不通过立即回退 asar 内置版并清指针；staging 残留目录启动时清理。任一时刻要么旧版要么新版，不存在半截状态 |
| **回滚**：新版渲染层有 bug / 资源损坏 | ① 保留最近 N 个版本目录，设置页提供"回退上一版本"；② 指针目录自愈校验失败自动回退内置版；③ 服务器侧下架该版本 manifest 即止血 |
| **IPC 契约漂移（最重要风险）**：新渲染层调用了旧主进程没有的 API / 事件（`src/shared/contracts.ts` 的 `AgentDeckApi` 是渲染层与 preload 的契约面） | manifest 声明 `minMainVersion`，主进程用 `app.getVersion()` 比对，低于则拒绝该渲染层版本；渲染层对新 API 调用失败要有降级 UI（契约面只增不改 / 加能力协商标志） |
| **与全量更新的版本错位**（未来接路线 ① 后）：旧热更渲染层覆盖新 asar 内置渲染层 | 见路线 ③ 的协同规则（指针随主进程版本失效） |
| **相对路径 / 缓存**：渲染层从 asar 内路径换到 userData 路径，静态资源引用必须相对化 | electron-vite 渲染层构建默认 `base: './'`，产物可整体搬移；落地第一步用 `npm run build` 产物在 userData 目录实测加载一遍（含刷新、深链接） |
| 主进程一次性改造本身的回归风险 | 改动面小（仅加载解析 + 新模块 + IPC），用"热更目录优先、内置兜底"的双路径保证改造不破坏现有启动链路 |

### 4.5 工作量

**约 5–8 人日**：主进程 updater 模块（下载 / 验签 / staged 替换 / 指针 / 自愈）+ 加载解析改造 + IPC/preload/设置页 UI + 发布侧脚本（打 zip、生成签名 manifest）+ 测试（校验失败、中断重放、回滚、契约漂移）。无第三方依赖，但一致性逻辑全部自研，需要一次认真的边界测试。

---

## 5. 路线 ③：混合 / 分阶段（日常 ② + 主进程改动 ①）

### 5.1 原理

- **日常更新走 ②**：渲染层 UI / 交互类改动发渲染层热更，秒级生效、不打断任务。
- **主进程改动走 ①**：主进程（runner、sidecar、backends、迁移逻辑）、preload、Electron 升级、依赖树变更 → 走 electron-updater 全量更新，频率低、可排期；用 `autoInstallOnAppQuit` 把中断降到最低。
- **协同规则（关键）**：全量版本自带当时最新的渲染层。全量安装完成后，主进程比对版本，**清空 / 作废旧指针**，直到新的渲染层热更再次写入 —— 保证"全量 > 热更"的覆盖顺序永远一致。
- **单一检查面**：两条通道共用一个 updater 模块与同一处 UI（设置页更新区）：② 高频（启动 + 定时），① 低频（启动 + 每日），互斥执行（不同时下载）。

### 5.2 优点

- 继承 ② 的"不打断"与 ① 的"全覆盖"，两条路线按更新内容的性质各司其职。
- 热更失败自愈（回退 asar 内置版）+ 全量兜底（重新安装），纵深防御。
- 无签名环境下：高频通道（②）完全不受签名影响，低频通道（①）的 SmartScreen 摩擦被摊薄到每月级。

### 5.3 风险与对策

| 风险 | 对策 |
|---|---|
| 双系统复杂度：两套 feed、两套检查器、两套状态机 | 单一 updater 模块统一封装（下载 / 校验 / 状态 / 日志共享），② 与 ① 只是两个策略对象；发布管线一套脚本同时产出两份 feed |
| 版本矩阵膨胀：主进程 vN × 渲染层热更 vM 的兼容组合 | `minMainVersion` 门禁（② 的 manifest）+ 全量更新后指针作废（③ 的协同规则）+ 渲染层契约只增不改（`src/shared/contracts.ts`），把有效组合压到"当前主进程 + 合规渲染层"一维 |
| 双通道同时触发互相踩踏（下载带宽 / 指针被全量覆盖） | 检查器互斥锁：同一时刻只跑一条通道；全量安装进行中暂停热更检查 |
| 初期投入最高 | 分阶段摊薄：阶段 0 先做两通道共用的加载解析改造（半天级），阶段 1 上线 ②（约 1 周），阶段 2 再补 ①（约半周）；任一阶段都可先止步（② 单独也能长期运转） |

### 5.4 工作量与阶段计划

**总计约 8–12 人日**（两路线之和减去共享部分），分三阶段交付：

| 阶段 | 内容 | 产出 | 约 |
|---|---|---|---|
| 0 | 加载解析改造（热更目录优先 / 内置兜底）+ 启动自愈骨架 | 可回退的双路径加载 | 0.5 天 |
| 1 | 路线 ② 完整落地（updater / 验签 / 指针 / UI / 发布脚本） | 渲染层热更上线 | 5–7 天 |
| 2 | 路线 ① 接入（electron-updater + publish 配置 + feed + 协同规则） | 全量通道上线 | 3–4 天 |

---

## 6. 三路线对比总表

| 维度 | ① electron-updater 全量 | ② 渲染层热更 | ③ 混合分阶段（推荐） |
|---|---|---|---|
| 覆盖面 | 全部（含 Electron 本体） | 仅渲染层 | 全部，按需分流 |
| 中断代价 | 高：强制重启杀任务（可 `autoInstallOnAppQuit` 缓解） | 零：只重载窗口 | 日常零中断；主进程更新低概率中断 |
| 无签名影响 | SmartScreen 警告 / 拦截，无发布者校验可用 | 无关（不下载可执行文件） | 高频通道无关；低频通道摩擦摊薄 |
| 完整性校验 | 内置 sha512 + HTTPS；可补自签 manifest | sha256 + Ed25519 签名 manifest（自足） | 两套并用 |
| 回滚 | 服务器重发旧 `latest.yml` + `allowDowngrade`；NSIS 版本化目录保留旧版 | 保留 N 个版本目录一键回退 + 校验失败自愈回退内置版 | 双路径回滚 + asar 内置兜底 |
| 被杀一致性 | 版本化目录 + 指针切换，旧目录完好 | staging + 原子指针 + 启动自愈校验 | 两者各自生效 |
| 自研代码量 | 最少（标准件） | 最多（一致性逻辑自研） | 中 |
| 工作量 | 3–5 人日 | 5–8 人日 | 8–12 人日（分阶段） |
| 长期维护 | 低 | 中（发布脚本 + 契约纪律） | 中 |

---

## 7. 推荐与理由

**推荐路线 ③，按"阶段 0 → ② → ①"顺序落地。**

1. **执行不中断是硬需求**：AgentDeck 是本地任务看板，agent 执行状态驻留主进程（`src/main/index.ts:418-432` 退出才停机）。全量更新必然重启并打断在跑任务（重启对账 `src/main/index.ts:224-249` 只是事后补救）。③ 让高频更新走 ②，日常迭代零中断。
2. **迭代重心在渲染层**：`src/renderer/` 是 UI 迭代主战场，② 的更新物小、秒级生效、失败自愈回退内置版，收益最大；主进程改动频率低，走 ① 排期即可。
3. **无签名约束下两条通道都站得住**：② 完全绕开签名体系（静态资源 + 内容签名自足）；① 的无签名摩擦只剩低频时的 SmartScreen 提示，内部分发可容忍，后续补证书两通道同时受益。三条路线都无"必须等签名证书"的阻塞。
4. **风险可封闭**：② 的三个硬风险（一致性、完整性、契约漂移）分别由"staged + 原子指针 + 启动自愈""Ed25519 签名 manifest""minMainVersion 门禁"闭环；③ 新增的双系统复杂度由"单一 updater 模块 + 互斥检查 + 全量后指针作废"封闭。全部风险均有对策（见 §3.3 / §4.4 / §5.3）。
5. **若只能选单通道**：维护成本最敏感时选 ①（覆盖面完整、生态最成熟、3–5 人日起步），把"渲染层热更"仅作为止血过渡手段。

---

## 8. 附：引用清单

- `electron-builder.yml:1` / `:6-8` / `:10-17` —— appId、files/asar、NSIS 目标
- `src/main/index.ts:90-94` —— 生产 `loadFile` 与开发 `loadURL` 分支；`:93` —— 生产渲染层入口
- `src/main/index.ts:418-432` —— 退出停机（runner / sidecar）
- `src/main/index.ts:434-438` —— 关窗不退出（路线 ② 前提）
- `src/main/index.ts:224-249` —— 启动对账（中断兜底）
- `src/main/index.ts:81-86` —— 渲染层安全配置（无 node 集成）
- `src/preload/index.ts:1-2` —— contextBridge 类型安全桥
- `src/shared/contracts.ts` —— 渲染层 ↔ 主进程契约面（`AgentDeckApi`）
- `electron.vite.config.ts:27-36` —— 渲染层构建输出
- `reports/MULTICA-TEARDOWN.md:237` / `:236` —— Multica 的 electron-updater 分 feed 与 sha256 校验实践
