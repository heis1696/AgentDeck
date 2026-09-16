# AgentDeck 免安装热更实现设计（阶段 0–2）

> 前置文档：`docs/INSTALLER-FREE-HOT-UPDATE.md`（三层免安装架构：L2 渲染层 / L1 JS 载荷 / L0 壳）、`docs/HOT-UPDATE-COMPARISON.md`（机制细节：staging → 验签 → 原子指针 → 自愈回退）。
> 本文 = 仓库侧实现设计：文件格式、接口签名、时序到可编码粒度；**不含实现代码**。阶段 3（目录式 zip 分发管线收口）只定义发布产物契约，阶段 4（L0 壳自替换）不在范围内，仅做字段/目录预留。
> 所有引用已按工作区现状（= HEAD `4f24a77`，git status 干净）逐条核实到行号。
> 「外部机制与开放问题」章节（§9）已由领队补齐：四问决策 + feed 终局布局 + 私钥流程，外部事实经辅程联网核实（来源随文标注）。

## 0. 范围与总原则

| # | 原则 | 落点 |
|---|---|---|
| P1 | 三层共用同一套机制：staging → 验签 → 原子指针 → 启动自愈回退 | `src/main/hot/` 单一模块族（§5.1） |
| P2 | `package.json` 的 `main` 始终指向 asar 内 bootstrap，**运行时不改 main 字段** | §3.1 |
| P3 | 加载解析单源：bootstrap（载荷级）与 `index.ts`（渲染层级）消费同一个解析函数 | `src/main/hot/resolve.ts`（§3.2 / §4.1） |
| P4 | IPC 契约**只增不改**：新增 `updates` 命名空间，既有 channel 零触碰（已核对 `src/preload/index.ts` 全量 invoke/on 名称，无 `updates:` 冲突） | §5.2 |
| P5 | 任何一层失败的最坏结果 = 回退 asar 内置版本继续可用，绝不出现"起不来" | §3.3 / §4.3 |
| P6 | 层间覆盖规则：L1 载荷 ⊇ 自带渲染层；载荷应用时重置 L2 指针（"全量 > 增量"沿用 `docs/HOT-UPDATE-COMPARISON.md` §5.1） | §4.1 / §6.3 |

---

## 1. 仓库现状事实（本次逐条核实）

| # | 事实 | 位置（已核实） |
|---|---|---|
| V1 | `main` 指向 `./out/main/index.js` | `package.json:5` |
| V2 | main 构建双入口 `index` + `sidecar-server`，输出 `out/main` | `electron.vite.config.ts:6-17` |
| V3 | 渲染层入口 `src/renderer/index.html` → `out/renderer` | `electron.vite.config.ts:27-36` |
| V4 | `files` 仅 `out/**` + `package.json` → asar 内无 `build/`，窗口图标 `../../build/icon.png` 是死路径（G5） | `electron-builder.yml:6-8`、`src/main/index.ts:80` |
| V5 | 生产 `loadFile(path.join(__dirname, '../renderer/index.html'))`；dev 走 `ELECTRON_RENDERER_URL` 分支 | `src/main/index.ts:90-94` |
| V6 | preload 挂 `path.join(__dirname, '../preload/index.js')`；`contextIsolation: true`、`nodeIntegration: false` | `src/main/index.ts:81-86` |
| V7 | sidecar entrypoint 传 `path.join(__dirname, 'sidecar-server.js')`；兜底默认同式 | `src/main/index.ts:110`、`src/main/sidecar.ts:261` |
| V8 | sidecar 以 `process.execPath`（+`ELECTRON_RUN_AS_NODE`）拉起，spawn 后 500ms 内等待退出 | `src/main/sidecar.ts:263-265`、`src/main/sidecar.ts:419-423` |
| V9 | electron 充当 node 的兜底散布 6 处（全部引用 `process.execPath`，不引用载荷文件） | `src/main/backends/cli-locator.ts:92`、`src/main/backends/cli-common.ts:99-100`、`src/main/backends/dsh.ts:43`、`src/main/backends/dsh-acp.ts:137`、`src/main/backends/zcode-config.ts:20`、`src/main/backends/zcode-transport.ts:34-35` |
| V10 | **单实例锁 / `app.relaunch` / `app.setName` / `app.isPackaged` 全仓库零命中**（grep 实证） | `src/` 全量 |
| V11 | 退出链：`before-quit` → `runner.shutdown()` → `sidecarManager.stop()` → `store.flush()`，全部可选链，ready 前触发也安全 | `src/main/index.ts:418-432` |
| V12 | runner 关机会等待全部会话 `stop()+close()`；sidecar stop 先 POST `/shutdown` 再 kill+等待 | `src/main/runner.ts:1452-1479`、`src/main/sidecar.ts:412-433` |
| V13 | 启动对账（中断兜底）现成：僵尸 running 补记 + queued 恢复/挂起 | `src/main/index.ts:224-249`、`src/main/index.ts:256-275` |
| V14 | tmp+rename 原子写在仓库已有两个先例；`settings.json` 是裸 write（对照项，不在本设计范围） | `src/main/store.ts:213-215`、`src/main/config-editor.ts:45-54`、`src/main/settings.ts:21-25` |
| V15 | 主进程零运行时 npm 依赖（dependencies 全是 React 系、只在渲染层 bundle 内）；main/preload bundle 仅 require `electron` + node 内置 + 本地 chunk | `package.json:83-89` + `docs/INSTALLER-FREE-HOT-UPDATE.md` §2.2 G1（out/ 产物清点） |
| V16 | IPC 注册走 `registerIpcHandlers(ctx)`；`IpcContext` 是注入面 | `src/main/ipc/register.ts:13-22`、`src/main/ipc/context.ts:17-40` |
| V17 | `AgentDeckApi` 契约面闭合于 `src/shared/contracts.ts:163-335`（末位成员 `sources` 块 `:322-334`，接口闭合括号 `:335`）——`updates` 追加于此 | `src/shared/contracts.ts:322-335` |
| V18 | 渲染层经 `bridge` 消费 `window.agentdeck`；设置页分区表是本地常量 | `src/renderer/src/api.ts:11`、`src/renderer/src/components/SettingsView.tsx:7-13` |
| V19 | tsconfig `include: ["src"]`——新增 `src/main/bootstrap.ts`、`src/main/hot/*` 自动纳入 typecheck | `tsconfig.json:15` |
| V20 | runner 无公共空闲态访问器（`sessions` 私有于 `src/main/runner.ts:117`、`launchHandles` 私有于 `:121`；`idleSentinel` 是回合超时哨兵，与空闲门控无关）——L1 空闲门控需新增 `isIdle()` | `src/main/runner.ts:117,121` |

---

## 2. 落盘布局、指针文件与 manifest

### 2.1 userData 目录布局

userData 默认 `%APPDATA%\agentdeck`（取自 `package.json:2` 的 `name`，打包后未被改写；dev 模式下是 `%APPDATA%\Electron`，与本机制无关——bootstrap 在 dev 直通，见 §3.2）。

```
<userData>/
  hot-app/                          # L1 载荷通道（阶段 2 启用；目录阶段 0 即由解析器容忍缺失）
    current.json                    # L1 指针（§2.2）
    <version>/                      # 一个已应用的载荷版本目录（staging rename 产生，原子出现）
      manifest.json                 # 该版本 manifest（§2.3）
      out/main/…  out/preload/…  out/renderer/…   # 与 asar 内容同构
      package.json
      build/icon.png                # 阶段 0 修 G5 后进入打包与载荷清单（§6.1）
    .staging-<ts>/                  # 下载+校验工作区，成功后 rename 成 <version>/，失败整体删除
  hot-renderer/                     # L2 渲染层通道（阶段 1 启用）
    current.json                    # L2 指针（§2.2）
    <version>/manifest.json + out/renderer/…
    .staging-<ts>/
```

要点：版本目录**只能整体出现**（staging 目录 rename 进来，同卷原子）；不存在"半截版本目录"被解析器看到的状态。指针损坏/目录缺失不阻断启动（§3.3）。

### 2.2 指针文件格式与原子写

两个通道同构，仅 `channel` 不同。路径：`<userData>/hot-app/current.json`、`<userData>/hot-renderer/current.json`。

```json
{
  "schemaVersion": 1,
  "channel": "renderer",
  "version": "0.18.3-hot.7",
  "dir": "hot-renderer/0.18.3-hot.7",
  "manifestSha256": "<64 位小写 hex，指向版本目录内 manifest.json 的字节摘要>",
  "appliedAt": 1760000000000,
  "appliedByShell": "0.18.2"
}
```

**校验规则**（解析器逐条执行，任一不过即判"指针无效"，进入对应失败路径）：

1. JSON 可解析；`schemaVersion === 1`；
2. `channel` ∈ {`renderer`,`payload`} 且与指针所在目录一致；
3. `dir` 是相对路径、不含 `..`、resolve 后严格落在 `<userData>/<channel 目录名>/` 之下（防指针被改写指向任意目录）；
4. `<userData>/<dir>/manifest.json` 存在，且其 sha256 === `manifestSha256`；
5. manifest 验签通过（§2.3）；
6. 通道门禁：L2 用 `minMainVersion ≤ 生效主进程版本`（生效主进程 = 载荷 manifest.version 若载荷有效，否则 `app.getVersion()`）；L1 用 `minShellVersion ≤ app.getVersion()`。比较用内置的 3 段 semver 比较（bootstrap 内自实现 ~15 行，不引依赖）。

**原子写**：写 `<指针路径>.tmp` → `fs.renameSync(tmp, 目标)`（同卷，先 store 已有先例 `src/main/store.ts:213-215`）。可选加 `fh.syncSync()` 再 rename——不做也不破坏安全性：指针最坏丢失 = 触发"指针无效"回退内置版（§3.3 路径 1），损失的是一次更新而非可用性。

**删除即回退**：指针文件不存在 = 该通道无热更，属合法状态而非错误。

### 2.3 manifest 格式与签名

每个版本目录一份 `manifest.json`，由发布脚本产出（§6.2）。结构 = `payload`（被签名块）+ `signature`（签名）两层：

```json
{
  "payload": {
    "schemaVersion": 1,
    "channel": "renderer",
    "version": "0.18.3-hot.7",
    "minMainVersion": "0.18.2",
    "minShellVersion": "0.18.2",
    "releaseDate": "2026-09-16T00:00:00Z",
    "keyId": "ad-2026-09",
    "artifact": { "name": "renderer-0.18.3-hot.7.zip", "sha256": "<hex>", "size": 1234567 },
    "files": [ { "path": "out/renderer/assets/index-abc.js", "sha256": "<hex>", "size": 12345 } ]
  },
  "signature": "<base64(Ed25519 签名)>"
}
```

- **签名对象与规范化**：`signature = base64(Ed25519.sign(privKey, utf8(canonicalJson(payload))))`。`canonicalJson` = 递归按键名 UTF-8 字节序排序、剔除 `undefined`、以 `JSON.stringify` 序列化。发布脚本与 `src/main/hot/verifier.ts` 共用同一实现（放 `src/main/hot/canonical.ts`），并用一个 smoke 用例固定"同输入 → 同字节"。
- **信任锚**：Ed25519 公钥以 raw 32 字节 hex 常量内置在 `src/main/hot/trust.ts`，`keyId → publicKey` 映射支持轮换；未知 `keyId` = 验签失败。私钥只存在于 CI secret / 离线（外部事项，§9）。
- **验签 API**：Node `crypto.verify(null, data, keyObject, sig)`，公钥经 `crypto.createPublicKey({ key: derBuffer, format: 'der', type: 'spki' })` 构造（DER 由 raw 拼前缀生成或直接存 SPKI hex，实现期二选一并固化进 smoke）。
- **files 清单**：覆盖更新物全部文件（解压后逐文件核对 sha256 + size），`files` 不含 `manifest.json` 自身；`manifestSha256` 进指针（§2.2 规则 4）负责 manifest 本体的传输完整性。
- **通道门禁语义**：`minMainVersion` 管渲染层↔主进程契约漂移（IPC 契约只增不改是前提，P4）；`minShellVersion` 管载荷↔壳（bootstrap 所在 asar）版本错位。两者都在**应用时**（updater 拒绝切换）与**加载时**（bootstrap 拒绝失效载荷，§3.3 路径 2）双重执行。

---

## 3. Bootstrap stub 设计（L1 加载链与自愈）

### 3.1 入口位置与构建链配合

| 项 | 设计 |
|---|---|
| 源文件 | 新增 `src/main/bootstrap.ts`（目标 ≤150 行；只 import `electron`、`node:fs`、`node:path`、`node:crypto` 与 `./hot/resolve`——resolve 再依赖 `./hot/pointer`、`./hot/verifier`、`./hot/trust`、`./hot/canonical`，全部无第三方依赖，符合 V15 的零依赖现状） |
| 构建产物 | `out/main/bootstrap.js`。`electron.vite.config.ts:10-15` 的 `main.build.rollupOptions.input` 增加条目 `bootstrap: resolve(__dirname, 'src/main/bootstrap.ts')`；index 与 bootstrap 共享 `hot/resolve` → rollup 自动产出共享 chunk，`sidecar-server` 入口不受影响 |
| package.json | `package.json:5` 改为 `"main": "./out/main/bootstrap.js"`。electron-builder 原样打进 asar（`electron-builder.yml:6-8` 已含 `package.json`），asar 入口即 bootstrap；**运行时永不修改 main 字段**（P2） |
| dev 链路 | `electron-vite dev` 按 package.json main 启动 → dev 也走 bootstrap；bootstrap 见 `app.isPackaged === false` 直通 `require('./index.js')`（§3.2 步骤 0），dev 行为与现状逐字节等价 |
| typecheck | `tsconfig.json:15` `include: ["src"]` 已覆盖，无需改动 |

### 3.2 加载链时序（bootstrap.js 的执行序列）

```
步骤 0  直通判定：!app.isPackaged 或 env AGENTDECK_DISABLE_HOT=1
        → require('./index.js')；结束（dev / 逃生开关，永远可用）。
步骤 1  u = app.getPath('userData')；解析 L1 指针 <u>/hot-app/current.json 并完整校验（§2.2 规则 1-6）。
步骤 2  校验通过 → r = require(<u>/<dir>/out/main/index.js)   ← 载荷入口；__dirname 自此整体重定位到
        载荷目录（V15：仅 require electron+内置+本地 chunk，无 node_modules 拖挂），结束。
        同步 require 抛错 → 路径③（§3.3）。
步骤 3  步骤 1 失败（指针无效/验签失败/门禁不过）→ 按失败路径处置（§3.3），然后落入步骤 4。
步骤 4  require('./index.js')（asar 内置载荷）。
        内置也抛（与热更无关的既有故障）→ 弹 Electron error dialog（错误 + "热更通道已禁用"提示）后 rethrow，
        进程按既有方式退出——这是全链路唯一"起不来"的出口，且不由热更引入。
```

`app.getPath('userData')`、`app.getVersion()` 在 ready 前可用，bootstrap 全程不等待 whenReady——载荷的 `app.whenReady()`（`src/main/index.ts:97`）在自身模块体内注册，时序不变。

### 3.3 三类失败路径与自愈行为（验收对照表）

| # | 失败点 | 检测信号 | 自愈动作 | 兜底出口 | 残留风险与对策 |
|---|---|---|---|---|---|
| ① | **指针损坏**：JSON 坏 / schemaVersion 未知 / `dir` 越界（§2.2 规则 1-3）/ 指向目录已被删 | 步骤 1 校验抛 `PointerInvalid` | 把坏指针改名为 `current.json.corrupt-<ts>`（留证不阻断），然后步骤 4 | 内置版启动，应用可用；下次 updater 检查可重新应用新版本 | 无。每次启动幂等重试内置版 |
| ② | **载荷验签失败**：manifest 缺失 / sha256 与指针 `manifestSha256` 不符（规则 4）/ Ed25519 验签不过或 `keyId` 未知（规则 5）/ `minShellVersion > app.getVersion()`（规则 6） | 步骤 1 校验抛 `PayloadRejected(reason)` | 指针改名 `current.json.rejected-<ts>`；版本目录改名 `<version>.quarantine-<ts>`（阻止任何路径复用坏载荷；GC 时清理），然后步骤 4 | 内置版启动；若因 `minShellVersion` 拒绝，属版本错位而非载荷损坏——同样回退，等壳更新后指针可重写 | 验签公钥被整包替换的供应链场景超出本地防线，信任根是内置公钥 + HTTPS feed（外部事项 §9） |
| ③ | **载荷 require 抛错**：步骤 2 同步抛（chunk 缺失、加载期异常） | 步骤 2 try/catch 命中 | ①指针改名 `current.json.crash-<ts>`（下次启动直接内置版，**不会循环**）；②`app.relaunch({ args: ['--agentdeck-hot-fallback'] })` + `app.exit(1)` 走**干净进程重启**，避免同进程半初始化状态（载荷若已注册过顶层 `app.on`/whenReady 回调，同进程回退会撞 `ipcMain.handle` 二次注册异常——`src/main/index.ts:388` 处 handler 均在 whenReady 内注册，重复注册会 throw）；③`app.relaunch()` 返回 false（几乎不可达）才就地 `require('./index.js')` | 重启后步骤 1 见不到指针 → 内置版。**循环保险**：新进程带 `--agentdeck-hot-fallback` 参数时跳过步骤 1-3 直落步骤 4，且内置 require 再失败才弹 dialog（步骤 4 语义） | relaunch 期间窗口闪失一次（秒级）；启动对账（V13）兜底中断任务。require 成功但 whenReady 回调内抛错的场景由载荷侧加固承接（§8 阶段 2 条目 R6：whenReady 链加 `.catch` → 判 `--agentdeck-hot-fallback` 不存在则清指针 + relaunch） |

补充语义（三条路径共享）：所有"改名留证"动作本身包 try/catch——处置失败不阻断回退；bootstrap 全程同步、无网络、无用户交互。

---

## 4. L2 渲染层热更接入点

### 4.1 `loadFile` 改造（`src/main/index.ts:90-94`）

解析单源（P3）：新增 `src/main/hot/resolve.ts`，bootstrap 与 index 共用（rollup 共享 chunk）。

```ts
// src/main/hot/resolve.ts —— 消费方仅取所需字段
export interface HotResolution {
  /** 实际可用的渲染层入口绝对路径；null = 用 asar 内置路径 */
  rendererIndexHtml: string | null
  /** 生效载荷信息；null = 无载荷（主进程就是 asar 内置） */
  payload: { dir: string; version: string; entry: string } | null
  /** 诊断：为何回退内置（'no-pointer' | 'pointer-invalid:…' | 'payload-rejected:…' | 'dev' | 'disabled'） */
  reason: string
}
export function resolveHotState(userDataDir: string, shellVersion: string, opts?: { skipPayload?: boolean }): HotResolution
```

解析顺序（严格分层，配合 P6 的应用期互斥——载荷应用时已重置 L2 指针，运行期二者互斥存在）：

1. `skipPayload`（dev / `AGENTDECK_DISABLE_HOT=1` / `--agentdeck-hot-fallback`）→ `{ rendererIndexHtml: null, reason: 'dev'|'disabled' }`；
2. L1 指针有效 → `rendererIndexHtml = <载荷 dir>/out/renderer/index.html`（载荷自带渲染层，L2 指针按 P6 不应存在，存在也忽略并记 `reason`）；
3. 否则 L2 指针有效 → `rendererIndexHtml = <userData>/<dir>/out/renderer/index.html`；
4. 否则内置：`null`。

`createWindow()` 内改造（`src/main/index.ts:93`）：

```ts
const hot = resolveHotState(app.getPath('userData'), app.getVersion())
mainWindow.loadFile(hot.rendererIndexHtml ?? path.join(__dirname, '../renderer/index.html'))
```

dev 分支（`:90-92` `ELECTRON_RENDERER_URL`）保持不变且优先。相对路径前提成立：electron-vite 渲染层产物 `base: './'`、全部 asset 相对引用（V3），整体搬移可加载——阶段 1 第一动作用 `npm run build` 产物落 userData 实测加载（含刷新、深链接），作为上线门禁（沿用 `docs/HOT-UPDATE-COMPARISON.md` §4.4）。

### 4.2 其余 `__dirname` 引用点逐点结论（全部**不需改**）

| 位置 | 结论 | 理由 |
|---|---|---|
| `src/main/index.ts:82` preload | **不改** | 结构性自洽：窗口由谁创建，preload 就来自谁的 `__dirname`——内置 main 配内置 preload（配 L2 热渲染层，契约由 `minMainVersion` 门禁保证渲染层不要求内置主进程没有的 API，P4）；载荷 main 配载荷 preload。跨配不可能出现 |
| `src/main/index.ts:80` 图标 | **不改代码；改打包** | 死路径 G5：`electron-builder.yml:6-8` `files` 增加 `build/icon.png`（asar 内出现 `build/icon.png`）；载荷组装清单同步含 `build/icon.png`（§6.1），载荷目录下 `__dirname/../../build/icon.png` 同样解析成立。一处相对路径两处布局同时满足，零代码改动 |
| `src/main/index.ts:110` sidecar entrypoint | **不改** | 载荷激活时 `__dirname` = 载荷 `out/main`，`sidecar-server.js` 随载荷目录整体搬迁（§2.1 布局），spawn 的是载荷版 sidecar——与载荷主进程版本一致，正是期望行为 |
| `src/main/sidecar.ts:261` 兜底默认值 | **不改** | 同上，仅在 index 未传 entrypoint 时触达，随调用方 `__dirname` 重定位 |
| V9 六处 electron-as-node 兜底 | **不改** | 全部引用 `process.execPath`（壳的 exe），不引用任何载荷文件；L1/L2 搬目录不触及。仅 L0 壳替换（阶段 4，超范围）需在 §7.3 的占用分析里考虑它们 |

### 4.3 切换与运行期自愈（L2 专属）

- **显式切换**：指针写好后必须显式 `mainWindow.loadFile(新路径)`；`webContents.reload()` 只会重载旧 URL（`docs/HOT-UPDATE-COMPARISON.md` §4.1）。`window-all-closed` 保活（`src/main/index.ts:434-438`）保证切换只动窗口不动 runner/sidecar。
- **加载失败自动回退**：`createWindow()` 给 `mainWindow.webContents` 挂 `did-fail-load`（仅主 frame、`errorCode` 非中断类）：若当前 URL 指向热更目录 → 回退加载上一版（内置或前一版本目录）+ 把该版本目录改名 `.quarantine-<ts>` + 指针回指/清除 + 推 `updates` 状态事件（§5.2）。`render-process-gone` 同策略（计数防抖，同一版本 5 分钟内两次 gon → 判坏回退）。

---

## 5. 更新器模块与 IPC 契约（只增不改）

### 5.1 新模块族 `src/main/hot/`（接口签名）

| 文件 | 职责 | 关键签名（导出） |
|---|---|---|
| `pointer.ts` | 指针读写（§2.2） | `readPointer(userDataDir, channel): Pointer \| null`；`writePointerAtomic(file, pointer): void`；`clearPointer(userDataDir, channel, evidence: string): void`（改名留证） |
| `resolve.ts` | 解析单源（§4.1） | `resolveHotState(...): HotResolution`（含 bootstrap 用的载荷校验：同一函数服务两层，`opts.skipPayload` 区分） |
| `verifier.ts` | sha256 + Ed25519 | `sha256File(path): string`；`verifyManifest(manifestPath, channel, gate: { mainVersion: string; shellVersion: string }): { ok: true, manifest } \| { ok: false, reason }` |
| `canonical.ts` | 规范化序列化 | `canonicalJson(value: unknown): string` |
| `trust.ts` | 信任锚 | `export const TRUST_KEYS: Record<string, string>`（keyId → 公钥 hex）；feed 基址常量 `DEFAULT_FEED_BASE`（占位 URL，§9 由领队定托管后替换；运行期可被 `AppSettings.updateFeedUrl` 覆盖） |
| `feed.ts` | 拉取 | `fetchManifest(baseUrl, channel): Promise<{ manifest, manifestBytes }>`；`downloadArtifact(url, dest, onProgress): Promise<void>`（超时 + 3 次退避重试） |
| `updater.ts` | 两通道共用的状态机 | `class HotUpdater { constructor(deps: UpdaterDeps) }`；`check(): Promise<UpdateStateSnapshot>`；`apply(channel): Promise<IpcResult>`；`rollback(channel): Promise<IpcResult>`；`onState(cb): () => void`；内部串行互斥（检查/下载全程单飞，两通道不同时跑，沿用 `docs/HOT-UPDATE-COMPARISON.md` §5.3 互斥锁对策） |

`UpdaterDeps = { getWindow: () => BrowserWindow \| null; isMainIdle: () => boolean; relaunchForUpdate: (note: string) => void; settings: () => AppSettings }`——注入而非 import，保证 IPC 层与 bootstrap 复用无环。

**apply 语义按通道分叉**：
- `renderer`（阶段 1）：staging 下载验签 → rename 成版本目录 → `writePointerAtomic` → `getWindow()?.loadFile(新路径)` → GC（保留最近 3 版）；
- `payload`（阶段 2）：同流程到 `writePointerAtomic`，**额外清 L2 指针**（P6）→ `relaunchForUpdate(version)`（§7.2 时序）；`isMainIdle()` 不过则拒绝 apply 并把状态置 `staged`（挂"待更新"，空闲提示用户，或退出时自动应用——`autoInstallOnAppQuit` 思路，挂到既有 `before-quit` 链：`src/main/index.ts:418-432` 的 async 块里、`app.quit()` 前判断 staged 标志后 relaunch）。

**staging 流程**（两通道一致，对应 `docs/HOT-UPDATE-COMPARISON.md` §4.1 三阶段）：`<channelDir>/.staging-<ts>/` 下载 zip → `artifact.sha256` 核对 → 解压 → `files[]` 逐文件 sha256+size 核对 → 写入 `manifest.json`（拉取时的字节原文）→ `fs.renameSync(staging, <version>/)`（目标已存在 = 版本已装，直接复用）→ 指针原子写。任一步失败：删 staging、状态 `failed`、现网版本零触碰。zip 解压用 Node 内置（Electron 33 自带 `node:zlib`；不引 yauzl 等依赖，条目解包自实现或以 ` unzip ` 原语封装在 `updater.ts` 内——**实现约束：零新 npm 依赖**，与 V15 一致）。

### 5.2 `src/shared/contracts.ts` 增量（只增不改，P4）

追加位置：`AgentDeckApi` 接口内、`sources` 块（`:322-334`）之后、接口闭合括号前（`src/shared/contracts.ts:334` 之后、`:335` 之前）。channel/phase 等类型一并追加在文件尾。

```ts
export type UpdateChannel = 'renderer' | 'payload'
export type UpdatePhase = 'idle' | 'checking' | 'downloading' | 'verifying' | 'staged' | 'applying' | 'failed'

export interface UpdateStateSnapshot {
  phase: UpdatePhase
  channel: UpdateChannel | null
  progress?: { receivedBytes: number; totalBytes: number }
  currentVersion: string          // 生效版本（载荷优先，否则壳版本）
  stagedVersion?: string          // 已就绪待应用（空闲门控挂起时）
  activeRendererVersion?: string  // L2 指针生效中的版本（诊断用）
  error?: string
}

// AgentDeckApi 内追加：
updates: {
  getState: () => Promise<UpdateStateSnapshot>
  check: () => Promise<UpdateStateSnapshot>            // 手动检查（两通道，串行）
  apply: (channel: UpdateChannel) => Promise<IpcResult>
  rollback: (channel: UpdateChannel) => Promise<IpcResult>  // 指针回退上一保留版本
  onState: (cb: (snapshot: UpdateStateSnapshot) => void) => () => void
}
```

既有 25 个 channel 前缀零触碰；`IpcResult` 复用 `src/shared/contracts.ts:144-147`。IPC handler 新文件 `src/main/ipc/updates.ts`（`ipcMain.handle('updates:get-state'|'updates:check'|'updates:apply'|'updates:rollback')`，事件 channel `updates:state`），在 `src/main/ipc/register.ts:21` 后追加一行注册；`IpcContext`（`src/main/ipc/context.ts:17-40`）增加 `readonly updates: HotUpdater`。

### 5.3 preload / 设置 UI 增量

- `src/preload/index.ts`：`api` 对象内追加 `updates` 块（模式照抄 `:188-197` sidecar 块），`src/shared/contracts.ts` 类型 import 增补——**只增不改**（`:267` 的 `exposeInMainWorld('agentdeck', api)` 不动）。
- `src/renderer/src/components/SettingsView.tsx`：`Section` 联合类型（`:7`）加 `'updates'`；`SECTIONS`（`:9-13`）"基础"组追加一项；新增 `src/renderer/src/components/UpdatePanel.tsx`：当前版本 / 检查更新 / 进度条 / 「应用并重载（L2）」「应用并重启（L1，空闲时）」「回退上一版」+ `bridge.updates.onState` 订阅（`bridge` 取自 `src/renderer/src/api.ts:11`）。
- `src/shared/types.ts:513` `AppSettings` 追加可选字段 `updateFeedUrl?: string`（`:536` `DEFAULT_SETTINGS` 不加键 = undefined 走内置默认，同样只增不改）。

---

## 6. L1 载荷更新物组装与发布产物（§7 阶段 1–3 对应）

### 6.1 组装清单（阶段 2 起用；与打包面强对齐）

**对齐规则（硬性）**：载荷 zip 的文件集合 ≡ electron-builder 打进 asar 的文件集合。即 `electron-builder.yml:6-8` `files` 在阶段 0 修 G5 后的清单：

| 载荷 zip 内路径 | 来源 | 说明 |
|---|---|---|
| `out/main/**` | `electron.vite.config.ts:6-17` 产物 | `index.js`、`bootstrap.js`、`sidecar-server.js`、共享 chunk |
| `out/preload/**` | `electron.vite.config.ts:18-26` 产物 | |
| `out/renderer/**` | `electron.vite.config.ts:27-36` 产物 | `base: './'` 相对引用，整体搬移可加载（§4.1） |
| `package.json` | 仓库根（main 字段指向 bootstrap，载荷态不被读取，保持与 asar 同份防漂移） | `app.getVersion()` 仍读壳 asar 元数据，**载荷版本以 manifest.version 为准** |
| `build/icon.png` | `build/icon.png`（阶段 0 进入 files 后） | 维持 `src/main/index.ts:80` 的相对路径在载荷布局下同样成立 |

不自包含物清单（搬目录**不需要**、也不允许混入）：`node_modules`（V15：主进程零运行时依赖）、Electron 运行时（属 L0 壳）、用户数据（全在 userData/home，V2 事实链）。

L2 更新物 = 上述清单的子集：`out/renderer/**`（zip 内同样带 `out/` 前缀，使版本目录内路径与载荷布局同构：`<version>/out/renderer/...`）。

### 6.2 发布脚本与 feed 产物结构（`scripts/release-hot.mjs`，新建）

输入：构建产物 `out/`、版本号、Ed25519 私钥（env `HOT_SIGNING_KEY`，CI secret）；输出：`dist/feed/`。产物树：

```
dist/feed/
  stable/
    renderer/
      manifest.json                       # 当前指针 manifest（签名后整体上传；服务器侧回滚 = 用旧版 manifest 覆盖此文件）
      renderer-<ver>.zip
    payload/
      manifest.json
      payload-<ver>.zip
    shell/                                # 阶段 4 占位：目录先建，产物为空（§9 开放问题 3 决策后填充）
  versions/                               # 全量历史（客户端回滚数据源 + 审计）
    renderer/<ver>/{manifest.json, renderer-<ver>.zip}
    payload/<ver>/{manifest.json, payload-<ver>.zip}
    shell/<ver>/…                         # 占位
```

脚本步骤（阶段 1 先只产 renderer 子树，阶段 2 增 payload，阶段 3 增 shell 占位 + 目录式 zip 打包——对应 `docs/INSTALLER-FREE-HOT-UPDATE.md` §7 阶段 1–3）：`electron-vite build` → 组装 staging（§6.1 清单）→ zip（store-only，不压缩已达目的、解压快）→ 逐文件 sha256 → 组 payload 块 → `canonicalJson` → Ed25519 签名 → 写 manifest.json → 校验器自检（`verifier.verifyManifest` 回读验一遍，防"签出来就是坏的"）→ 输出上述树 + `RELEASE-NOTES.md` 摘要。

**配套 smoke（验收工具，非产品代码）**：
- `scripts/smoke-hot-pointer.mjs`（阶段 0）：对 `--dir` 产物注入四类指针状态（正常/损坏/验签失败/载荷 require 抛错——抛错用截断 chunk 的载荷副本制造），逐一启动断言回退内置版 + 留证文件存在（§3.3 三路径可演练）。
- `scripts/smoke-hot-payload.mjs`（阶段 2）：`--dir` 产物 + 发布脚本产出的载荷目录写指针 → 启动 → 断言窗口来自载荷渲染层、`sidecar-server` 自载荷目录拉起、second boot 对账正常。

### 6.3 版本与门禁规则

| 规则 | 内容 |
|---|---|
| 版本号 | 载荷/渲染层版本 = `info` 语义化（`<壳版本>-hot.<n>`，如 `0.18.3-hot.7`）；manifest.version 是唯一事实，`package.json` 版本只属于壳 |
| 门禁矩阵 | L2：`minMainVersion ≤ 生效主进程版本`；L1：`minShellVersion ≤ app.getVersion()`；双处执行（应用时 updater / 加载时 bootstrap） |
| 全量 > 增量 | 载荷 apply 成功 → `clearPointer(hot-renderer)`；载荷目录自带渲染层接管。壳更新（阶段 4）→ 重置载荷指针（`docs/INSTALLER-FREE-HOT-UPDATE.md` §6 协同规则） |
| 回滚 | 客户端：版本目录保留 3 版，`updates.rollback` 指针回退；自愈：校验失败自动回退内置版。服务端：`versions/<ver>/manifest.json` 覆盖 `stable/<channel>/manifest.json` 即止血 |
| 契约纪律 | `src/shared/contracts.ts` 只增不改（P4）是 `minMainVersion` 门禁成立的前提；漂移即破防，纳入 review checklist |

---

## 7. relaunch 流程与阶段 0 单实例锁时序

### 7.1 锁的插入点与语义（`src/main/index.ts`）

位置：模块顶层、imports 之后 `let` 声明区之前（`src/main/index.ts:29` 一带，**必须先于 `:97` 的 whenReady 注册**）：

- `const gotLock = app.requestSingleInstanceLock()`；失败：带 `--agentdeck-relaunch-retry` 参数时 500ms 后重试取锁（最多 10 次 = 5s，覆盖 §7.2 的退出-取锁竞态窗口），仍失败 `app.quit()`——`before-quit`（`:418-432`）全可选链（V11），ready 前退出安全。
- 成功：注册 `app.on('second-instance', …)` → `mainWindow` restore/show/focus（`mainWindow` 为 null 时幂等跳过——锁声明先于窗口创建）。

### 7.2 L1 apply → relaunch 全时序

```
 1  用户点「应用并重启」/ 空闲自动应用            updates.apply('payload')
 2  幂等与互斥                                  updater 串行锁占用中 → 立即拒绝
 3  空闲门控                                    isMainIdle()（§7.4）= false → 状态置 staged，返回 ok；
                                               挂"待更新"；退出时在 before-quit 链里补一次 relaunch（§5.1）
 4  （staging/验签/指针已在 check/apply 前段完成——指针翻转是本时序的起点）
    writePointerAtomic(hot-app/current.json → 新载荷)  +  clearPointer(hot-renderer)   [P6]
 5  relaunchForUpdate(version)：
      app.relaunch({ args: ['--agentdeck-hot-applied', version] })
      app.quit()                                 ← 走既有 before-quit 链，不另起停机路径
 6  before-quit（src/main/index.ts:418-432）      automationTimer 清除 → runner.shutdown()（等会话清空，
                                               src/main/runner.ts:1472-1475）→ sidecarManager.stop()（POST
                                               /shutdown + kill + ≤500ms 等待，src/main/sidecar.ts:412-433）
                                               → store.flush() → quitReady → app.quit()
 7  进程退出 → OS 释放单实例锁 → relaunch 拉起新进程
 8  新进程取锁                                   竞态窗口（旧进程未完全退出）由 --agentdeck-relaunch-retry
                                               重试环吸收（§7.1）；拿到锁 → bootstrap 正常加载链
 9  bootstrap → 新载荷 require（§3.2 步骤 2）     载荷 require 抛错 → §3.3 路径③（清指针+relaunch 内置版，
                                               不会循环）
10  启动对账（src/main/index.ts:224-275）         重启中断的任务补记/恢复——既有兜底，零新增
11  UI 通知                                      载荷 index.js 检测 --agentdeck-hot-applied 参数 →
                                               updates:state 推一条 staged=false 的"已更新到 <version>"
```

**时序不变式**：指针翻转（步 4）之前任何一步被杀 = 旧版原样；翻转之后、relaunch 完成之前被杀 = 下次启动直接进新载荷（指针已在）——两个方向都收敛，无第三态。

### 7.3 进程占用分析（sidecar / CLI 兜底，G3）

| 持有者 | 生命周期 | 对阶段 2 relaunch | 对阶段 4 壳替换（超范围，仅记录） |
|---|---|---|---|
| 主进程自身 | 步 7 退出 | 无关（L1 不替换任何文件，只换加载目录） | rename dance 的改名不被自身阻塞（运行中 exe 可改名，E3 实证） |
| 自有 sidecar 子进程（`process.execPath`+`ELECTRON_RUN_AS_NODE`，`src/main/sidecar.ts:263-265`） | 步 6 `stop()` 内 POST `/shutdown` + kill + ≤500ms 等待 | 停机后 relaunch，端口/状态文件（`loadPersisted`，`src/main/sidecar.ts:243-255`）一致性由既有协议保证 | 极端下 500ms 未退 → 已被 kill 强收；仍存活也只影响删除不影响改名 |
| **收养 sidecar**（孤儿收编，`ownsSidecar=false`，`src/main/sidecar.ts:247`；`stop()` 只在 `ownsSidecar` 为真时才发 `/shutdown`，`:416-418`——收养的进程不会被停机杀死） | 可能跨 relaunch 存活 | 不阻塞：relaunch 不做文件替换；新实例 `reconnect()` 会重新 probe 收养（`:243-255`） | 持旧 exe 句柄 → 只影响旧目录删除；下次启动扫描 `*.old-<ts>` 延后清理（阶段 4 语义） |
| CLI 兜底子进程（六处 `process.execPath` 兜底，V9） | 随任务会话，步 6 `runner.shutdown()` 逐一 `stop()+close()` 收敛 | 同上不阻塞 | kill 超时漏网者持旧 exe 句柄，同"收养 sidecar"处理 |
| `automationTimer` | `:385` 15s tick | 步 6 `before-quit` 首步清除（`:423`）；步 3→4 之间 tick 新建任务的竞态由 apply 临界区内**重查一次 `isMainIdle()`** 封闭 | — |

结论：阶段 2 的 relaunch **不需要任何占用处理**（不换文件，只换指针 + 干净重启）；V9/V8 的占用清单是阶段 4 rename dance 的输入，其中"只能改名不能删"的结论（E3）使它们全部非阻塞，仅把旧目录删除推迟到下次启动清扫。

### 7.4 空闲门控接口（新增）

`src/main/runner.ts` 增加公共方法 `isIdle(): boolean`，实现 = `this.sessions.size === 0 && this.launchHandles.size === 0 && this.store.list().every(t => t.status !== 'running')`（三条件分别覆盖在跑会话、启动竞态窗口、store 层僵尸；具体私有名以实现期 runner 现状为准，签名固定）。updater 经 `UpdaterDeps.isMainIdle` 注入（§5.1），index.ts 装配处传 `() => runner.isIdle()` 并叠加 `!automationTick临界区`（步 3 重查语义）。

---

## 8. 阶段 0–2 文件级改造清单（验收对照）

### 阶段 0：单实例锁 + bootstrap 指针加载骨架 + G5 图标（产出：双路径加载可回退）

| # | 文件 | 位置 | 改造 | 验收 |
|---|---|---|---|---|
| 0.1 | `src/main/index.ts` | `:29` 一带（imports 后） | 插入 `requestSingleInstanceLock` + 重试环 + `second-instance` 聚焦（§7.1） | 双开 → 第二实例退出且第一实例聚焦；relaunch 竞态被重试环吸收 |
| 0.2 | `src/main/bootstrap.ts` | 新建 | §3.2 五步加载链，零第三方依赖 | dev 直通等价；打包态按指针/内置双路径启动 |
| 0.3 | `src/main/hot/resolve.ts`、`pointer.ts`、`verifier.ts`、`canonical.ts`、`trust.ts` | 新建 | §2.2/§2.3/§4.1 定义；`resolveHotState` 被 bootstrap 与 index 共用 | 指针四态（无/正常/损坏/验签失败）单测全覆盖 |
| 0.4 | `package.json` | `:5` | `main` → `./out/main/bootstrap.js` | `npm run dev` 与 `npm run pack` 产物均从 bootstrap 进入 |
| 0.5 | `electron.vite.config.ts` | `:10-15` | main.input 增 `bootstrap` 条目 | `out/main/bootstrap.js` 产出；index/bootstrap 共享 chunk 无重复打包 |
| 0.6 | `electron-builder.yml` | `:6-8` | `files` 增 `build/icon.png` | asar 内出现 `build/icon.png`，窗口图标不再是默认图（G5 关闭） |
| 0.7 | `src/main/index.ts` | `:93` | `loadFile` 走 `resolveHotState(...).rendererIndexHtml ?? 原路径`（§4.1） | 无指针 = 行为与现状一致（回归基线）；注入指针 = 加载 userData 渲染层 |
| 0.8 | `scripts/smoke-hot-pointer.mjs` | 新建 | §6.2 四态演练 | 三类失败路径 + 正常路径全部按 §3.3 表格断言通过 |

### 阶段 1：L2 渲染层热更（产出：渲染层热更上线）

| # | 文件 | 位置 | 改造 | 验收 |
|---|---|---|---|---|
| 1.1 | `src/main/hot/updater.ts`、`feed.ts` | 新建 | §5.1 状态机 + staging 流程（renderer 通道） | 下载中断/校验失败/目标已存在各分支：staging 清理、现网零触碰 |
| 1.2 | `src/main/index.ts` | `createWindow()`（`:72-95`）与 whenReady 尾部（`:411` 一带） | 挂 `did-fail-load`/`render-process-gone` 自动回退（§4.3）；updater 装配 + 启动检查 + 6h 定时 | 加载坏渲染层 → 自动回退且留证 |
| 1.3 | `src/main/ipc/updates.ts` | 新建 | §5.2 四个 handler + `updates:state` 事件 | 手动检查→下载→切换，`loadFile` 显式换新路径生效 |
| 1.4 | `src/main/ipc/register.ts` / `context.ts` | `:21` 后 / `:17-40` | 注册行 + `updates` 注入字段 | — |
| 1.5 | `src/shared/contracts.ts` | `:334`/`:335` 之间 + 文件尾 | §5.2 类型与 `updates` 命名空间（只增） | typecheck 过；既有契约 diff 为纯追加 |
| 1.6 | `src/preload/index.ts` | `api` 对象内（`:188-197` 块后） | `updates` 桥（只增） | 渲染层可订阅状态 |
| 1.7 | `src/renderer/src/components/SettingsView.tsx` + `UpdatePanel.tsx` | `:7`、`:9-13` / 新建 | 分区 + 更新面板（§5.3） | 设置页可见版本/检查/应用/回退 |
| 1.8 | `src/shared/types.ts` | `:513` | `updateFeedUrl?: string`（只增） | feed 基址可覆盖 |
| 1.9 | `scripts/release-hot.mjs` | 新建 | §6.2（renderer 子树 + 自检） | 本地起静态服务端到端热更一轮成功 |
| 1.10 | （实测门禁） | — | §4.1：userData 产物实测加载（刷新/深链接/相对 asset） | 通过才允许发布 |

### 阶段 2：L1 载荷热更 + 空闲门控 + relaunch（产出：载荷通道上线）

| # | 文件 | 位置 | 改造 | 验收 |
|---|---|---|---|---|
| 2.1 | `src/main/hot/updater.ts` | 既有文件扩展 | payload 通道：组装按 §6.1、apply 清 L2 指针（P6）、staged 挂起与退出时应用（§5.1） | 载荷更新一轮：重启后主进程/preload/sidecar 均来自载荷目录 |
| 2.2 | `src/main/runner.ts` | `:1452` 附近 | 新增 `isIdle(): boolean`（§7.4） | 有在跑任务时 apply 被门控挂起；空闲后可应用 |
| 2.3 | `src/main/index.ts` | 装配处（`:388-411` 一带）+ `before-quit`（`:418-432`） | `relaunchForUpdate`（§7.2 步 5）、`--agentdeck-hot-applied` 通知、退出时 staged 补应用 | relaunch 全时序演练通过；中断任务被对账兜底（V13） |
| 2.4 | `src/main/bootstrap.ts` | 既有 | `--agentdeck-hot-fallback` 循环保险生效确认 + 载荷侧 whenReady `.catch` 加固（§3.3 路径③残留风险列） | 载荷 require 抛错 → 恰好一次干净重启进内置版，无循环 |
| 2.5 | `scripts/release-hot.mjs` | 既有扩展 | payload 子树 + `minShellVersion` 写入 | 载荷 zip 清单与 asar 内容一致（脚本内断言） |
| 2.6 | `scripts/smoke-hot-payload.mjs` | 新建 | §6.2 端到端 | 载荷启动/版本上报/回滚/坏载荷自愈四场景通过 |

---

## 9. 外部机制与开放问题（决策）

> 回答 `docs/INSTALLER-FREE-HOT-UPDATE.md` §8 四问。决策依据 = 辅程外部核实（GitHub 官方限流/发布文档、electron-builder 官方 auto-update 文档、Azure Trusted Signing 定价，本次联网核实）+ 领队裁定。每问给唯一决策。

### 9.1 feed 托管：自管静态站为更新器唯一入口，GitHub Releases 仅作发布历史与人工下载镜像

GitHub Releases 作更新入口的四个硬伤（均已核实）：① 未鉴权 REST API 限 **60 req/h/来源 IP**（官方限流文档）——桌面用户常经 NAT/企业出口共享 IP，集中检查极易 403，token 不能随壳分发；② `releases/latest/download/<asset>` 固定跳转（官方 Linking to releases 页）**拿不到版本号与哈希**，只能解析 302 猜 tag，脆弱；③ 同一 tag 资产可删可重传 = 内容可变；④ 私有仓库下载需认证，electron-builder 官方明言"不适合终端用户"。自管静态站则 feed 结构自定、无配额、版本化不可变路径 + 自有域名 URL 稳定。**零成本折中**：GitHub Pages / Cloudflare Pages 承载 feed（仍属"内容与 URL 自控"的自管阵营），产物留 Releases tag 固定 URL——篡改风险由 sha256 + Ed25519 兜底，不依赖托管商。反方（零运维、社区信任 github 域名）由"feed 仅数 KB、信任由签名解决、github.com 大陆可达性波动"回应。

**终局 feed 布局**（= §6.2 的 `dist/feed/` 树挂到平台分区下）：

```
<DEFAULT_FEED_BASE>/                 # 自有域名（阶段 3 前购入）；此前用 Pages 级托管
  win32-x64/
    stable/{renderer,payload,shell}/manifest.json + *.zip     # 定点入口 = stable/<layer>/manifest.json
    versions/{renderer,payload,shell}/<ver>/…                 # 不可变历史（回滚数据源 + 审计）
  beta/win32-x64/…                   # 同构；stable/beta 两级足够（通道=客户端检查偏好，灰度靠 beta）
```

- 服务端回滚 = 用 `versions/<layer>/<ver>/manifest.json` 覆盖定点文件（§6.3 已定）；**版本号单调递增**，回滚发更高版本号引用旧产物，客户端无需 allowDowngrade 逻辑。
- `trust.ts` 的 `DEFAULT_FEED_BASE`（§5.1 占位）在域名确定后替换；运行期 `AppSettings.updateFeedUrl` 覆盖机制已设计（§5.3）。

### 9.2 NSIS 退役：zip 渠道 GA 后并行 2 个稳定版本（约 4–8 周）即停发

- 并行期 NSIS + 目录式 zip 双产物同发；三层 feed 树只服务 zip 渠道。
- 并行期 NSIS 构建作为**桥接版**：启动横幅/设置页引导存量用户人工迁移到 zip 渠道（NSIS 版无法免安装自更，迁移必然一次性人工）。
- 停发标准：zip 渠道线上运行 ≥2 个稳定版本且无分发类缺陷；之后 Release Notes 标注 NSIS 末版并归档。

### 9.3 L0 模式：无签名期"长期半自动"为终态，全自动只做隐藏实验开关

- 半自动语义：检测→下载→校验→staging 全自动；rename dance（前置文档 §5）由用户 UI 一键确认执行。
- 理由：无 Authenticode 下"应用自我替换 exe"是杀软启发式高敏组合，全自动放大概率；一键确认提供观察窗口。
- 全自动实现保留（同一套代码去掉确认门），藏实验开关后；签名证书到位后评估转正。`stable/shell/` feed 产物（§6.2 占位）随首个半自动 L0 版本填充。

### 9.4 代码签名：IV/OV 级，不晚于阶段 3；EV 不买

- 预算：约 **¥1000–2000/年**（Certum/SSL.com 等 IV/OV 档），或 **Azure Trusted Signing Basic ≈ $9.99/月 + 用量**（个人身份档，购买时复核资格）。
- 时间点：**不晚于阶段 3**（目录式 zip 对外分发前）——zip 首次运行的 SmartScreen/MOTW 摩擦随分发面线性放大。
- EV 不买：个人开发者成本/收益失衡；OV + 信誉时间积累可消除多数摩擦。
- 到位后双轨正交并存：Authenticode 签 exe/安装器（OS 层信任），Ed25519 manifest 验签继续承担 feed 内容完整性（应用层信任）。

### 9.5 私钥保管与签发流程（机制见 §2.3/§6.2，此处约定流程）

- **生成**：`node:crypto` 的 `generateKeyPairSync('ed25519')` 离线生成；公钥 raw hex 进 `trust.ts`，私钥 PKCS#8 PEM 进 CI secret（env `HOT_SIGNING_KEY`，§6.2 已约定）——**绝不进仓库**。
- **keyId 历法**：`ad-YYYY-MM`（生成月）；`trust.ts` 的 map 结构天然支持多 key 并存（§2.3）。
- **轮换**：约 12 个月一次，或疑似泄露即换。流程 = 新 key 签一个壳版本（新壳 `TRUST_KEYS` 同时含新旧两个 keyId）→ 观察一个稳定版本 → 再下一个壳版本移除旧 keyId。轮换只能借壳更新落地：载荷/渲染层 manifest 的 keyId 必须落在存量壳的信任集内。
- **签发**：CI 发布 job（或本地 release 脚本）从 secret 读私钥；§6.2 的"签完回读自检"防坏签名出库；`versions/` 历史树即审计记录。

---

## 10. 附：引用清单（全部按工作区现状核实）

**构建/打包**
- `package.json:5`（main）、`:83-89`（dependencies 仅 React 系）
- `electron.vite.config.ts:6-17`（main 双入口）、`:18-26`（preload）、`:27-36`（renderer）
- `electron-builder.yml:6-8`（files）、`:9-17`（icon/nsis）
- `tsconfig.json:15`（include src）

**主进程**
- `src/main/index.ts:80`（图标 G5）、`:82`（preload）、`:90-94`（loadURL/loadFile 分支，`:93` 改造点）、`:97`（whenReady）、`:108-112`（sidecar entrypoint `:110`）、`:224-249` + `:256-275`（启动对账）、`:388-409`（registerIpcHandlers）、`:411`（createWindow 调用）、`:418-432`（before-quit 停机链，全可选链）、`:434-438`（关窗不退出）
- `src/main/sidecar.ts:243-255`（收养）、`:261`（entrypoint 兜底）、`:263-265`（execPath+env+spawn）、`:412-433`（stop：`:416-418` 仅 owns 才发 /shutdown、`:419-423` kill+等待）
- `src/main/runner.ts:1452-1479`（shutdown 等会话收敛）
- `src/main/store.ts:213-215`（tmp+rename 先例）、`src/main/config-editor.ts:45-54`（writeFileAtomic/WithBackup）、`src/main/settings.ts:21-25`（裸写对照）
- `src/main/ipc/register.ts:13-22`、`src/main/ipc/context.ts:17-40`、`src/main/ipc/system.ts:57-58`（settings handler 位置示例）

**electron-as-node 兜底（V9，六处）**
- `src/main/backends/cli-locator.ts:92`、`src/main/backends/cli-common.ts:99-100`、`src/main/backends/dsh.ts:43`、`src/main/backends/dsh-acp.ts:137`、`src/main/backends/zcode-config.ts:20`、`src/main/backends/zcode-transport.ts:34-35`

**契约与渲染层**
- `src/shared/contracts.ts:144-147`（IpcResult）、`:163-335`（AgentDeckApi，`sources` 末位块 `:322-334`）
- `src/shared/types.ts:513`（AppSettings）、`:536`（DEFAULT_SETTINGS）
- `src/preload/index.ts:28`（api 对象）、`:188-197`（sidecar 桥样例）、`:267`（exposeInMainWorld）
- `src/renderer/src/api.ts:11`（bridge）、`src/renderer/src/components/SettingsView.tsx:7-13`（Section/SECTIONS）

**零命中实证（V10）**：`requestSingleInstanceLock` / `second-instance` / `app.relaunch` / `app.setName` / `app.isPackaged` 在 `src/` 全量 grep 零命中（2026-09-16，工作区 = HEAD `4f24a77`）。

**前置文档**：`docs/INSTALLER-FREE-HOT-UPDATE.md`（三层模型 §3、rename dance §5、阶段表 §7）、`docs/HOT-UPDATE-COMPARISON.md`（L2 三阶段流程 §4.1、minMainVersion/互斥/协同规则 §4.4/§5.1/§5.3、asar 约束 §4.2）。
