# 桌宠（AI Desktop Pet）设计文档

> 状态：设计定稿（本轮仅侦察 + 写文档，零代码改动）。
> 目标：在 AgentDeck 里加一只 AI 桌宠——透明置顶小窗挂在桌面上，可拖拽抛掷、点击互动、气泡聊天；按可配间隔自主「活着」（走动、说话、想事情）；大脑走用户已有的 API 预设（不绑任何平台），系统提示词可编辑、任务板上下文可注入；素材包与动画行为全部是 JSON，换目录即换皮肤。
> 硬约束：**零新 npm 依赖**；主进程侧延续热更链路铁律（`src/main/pet/` 不引第三方运行时包）；素材生成脚本只用 Node 内置模块。

---

## 0. 对任务草案的修正清单（均附侦察依据）

草案整体成立（新模块组 `src/main/pet/`、复用现有入口 + hash 路由、纯函数状态机供 smoke 直连、分期 A/B/C 均保留）。以下 6 处按侦察结果修正：

| # | 草案原案 | 修正 | 理由（侦察证据） |
|---|---|---|---|
| 1 | 默认素材包放仓库顶层 `assets/pets/<packId>/` | 默认包源文件放 `src/renderer/src/pet/assets/<packId>/`，经 vite import 进渲染层 bundle | 热更 zip 清单 = `walkFiles(out/…)`（`scripts/release-hot.mjs:203`-`238`），payload 通道只收 `out/main`、`out/preload`、`out/renderer` + `package.json` + `build/icon.png`；renderer 通道只收 `out/renderer`。顶层 `assets/` 不在任何清单里，要带上就得同时改 `scripts/release-hot.mjs` 与 `electron-builder.yml:6`-`9`（其 `files` 也只有 `out/**`、`package.json`、`build/icon.png`）两处打包配置。走 vite import 后 PNG 自动落 `out/renderer/assets/`（<4KB 由 assetsInlineLimit 内联为 dataURL），**双通道零登记**。 |
| 2 | `pet-behavior` 放 `src/main/pet/` | 纯函数状态机 + 素材包 schema 放 `src/shared/pet.ts` | 全仓渲染层对 `src/main` 零 import（grep 证实，渲染层宁可复制一份 `task-service`）。`src/shared/forge.ts`、`src/shared/meeting.ts`、`src/shared/skills.ts` 是既有的「双端纯逻辑」先例。状态机主进程（brain 决策）与渲染层（帧动画/加权转移）都要用，放 shared 一处定义、smoke 直连一份即钉住双端。 |
| 3 | pet-store「设置」并入现有设置体系 | 设置不进 `AppSettings`，独立持久化到 `userData/pet.json` | `AppSettings` 每次更新全量广播给所有窗口（`src/main/ipc/system.ts:58`-`63`），改动需在 `src/shared/types.ts:537`（AppSettings）与 `src/main/ipc-validation.ts:295`（parseSettingsPatch 白名单）各加一份；对话环形缓冲（KB 级历史）混进 settings.json 会让每次切主题都重写对话史。pet-store 按 `src/main/automation-store.ts:6`-`28` 的「ctor(userDataDir) + try/catch 读 + tmp+rename 原子写」惯例独立成 store。 |
| 4 | 「App.tsx 按 hash 路由（现有机制）」 | 定性修正：App 无路由机制，hash 分支是**新增**的最小路由 | `src/renderer/src/App.tsx:22`（`type View` 联合）、`:30`（`useState<View>`）、`:159`（三元链条件渲染）——无 router 库。方案不变（hash 分支 + 早返回），实现约为一个 `hashchange` 监听 + 组件树早返回，≈15 行。 |
| 5 | 「走 presets 调 LLM（复用现成函数）」 | 主进程**没有**现成 chat 调用可复用；新增 `pet-llm.ts`（≈60 行），鉴权/协议推断/超时惯例照抄先例 | 主进程唯一的 LLM 相关 HTTP 是拉模型目录的 `fetchPresetModels`（`src/main/presets.ts:85`-`110`，GET /models），没有 chat/completions 或 /messages 的 POST 先例（grep 证实）。全局 `fetch` 在主进程已被热更链路使用（`src/main/hot/feed.ts:27`、`:48`、`:100`），零依赖可用，只是要新写调用面。 |
| 6 | 「热更有无入口清单要登记」（存疑项） | 结论：**无模块清单要登记**；要登记的是文档面（smoke 映射 + 依赖图） | 载荷 zip 按目录整体收集构建产物（`scripts/release-hot.mjs:214`-`224`），新模块只要从三个构建入口（`electron.vite.config.ts:8`-`12`：`index.ts`/`bootstrap.ts`/`sidecar-server.ts`）经 import 链可达，就自动进 `out/main/index.js` 进 zip。渲染层同理（入口 `src/renderer/index.html`）。需要登记的只有：`docs/graph/INVENTORY.md:491` 附录 A 补 smoke→src 映射（AGENTS.md 铁律）、`npm run graph:deps` 刷新。详见 §3.4。 |

另有一条对「验收」的落点修正：草案提到的 `docs/features` 目录不存在，`docs/README.md` 是现行文档导航（现行参考表 + archive 分区）。C 期的文档动作 = 本文档随实现更新 + `docs/README.md` 导航行 + `docs/API.md` 补 pet 域 IPC 表。

---

## 1. 侦察结论（七项，带 file:line）

### 1.1 BrowserWindow 创建与多窗口先例

- 唯一的窗口创建点：`src/main/index.ts:149`-`208` `createWindow()`——1180×760、`minWidth/minHeight`、`autoHideMenuBar`、`backgroundColor: '#0f1115'`、图标 `path.join(__dirname, '../../build/icon.png')`、webPreferences 三件套：`preload: path.join(__dirname, '../preload/index.js')` + `contextIsolation: true` + `nodeIntegration: false` + `sandbox: false`（`src/main/index.ts:160`-`165`）。**仓库里没有任何 transparent/alwaysOnTop/skipTaskbar/frame:false 先例**——桌宠窗口是首例，注意事项见 §9 风险表 R1/R2。
- 多窗口：目前只有主窗 + 托盘（`src/main/index.ts:240`-`268`），没有第二个 BrowserWindow 的先例，但结构上无障碍：
  - 单实例锁按 userData 加键（`src/main/index.ts:104`），桌宠窗是**同进程第二个窗口**，与锁无关；
  - `second-instance` → `focusMainWindow`（`src/main/index.ts:93`-`103`）只碰主窗引用，桌宠窗不受影响；
  - `app.on('activate')` 用 `BrowserWindow.getAllWindows().length === 0` 判断是否重建主窗（`src/main/index.ts:657`-`659`）——桌宠窗存活时该条件不成立，win32 上 activate 不触发，低风险但记录为 R3；
  - `window-all-closed` 是保活空实现（`src/main/index.ts:688`-`692`），两窗全关进程仍活着（托盘退出是唯一真退出，`src/main/index.ts:668`-`686`）；
  - 关闭主窗 = 隐藏进托盘不销毁（`src/main/index.ts:170`-`182`，`quitting` 门控）。桌宠窗不应复用这套拦截：close 即销毁置 null。
- 初始化幂等闸：`initMain` 用 `initStarted` 防双跑，注释明确「handler 二次注册即抛」（`src/main/index.ts:271`-`276`）——pet IPC 域只在 `registerIpcHandlers` 里注册一次即可。
- dev 数据目录隔离到 `agentdeck-dev`（`src/main/index.ts:69`-`72`）——pet.json 落 `app.getPath('userData')` 自动随之隔离，无需额外处理。
- 热更渲染层解析与自愈：主窗加载 `resolveHotState(...)` 的 `rendererIndexHtml ?? 内置 index.html`（`src/main/index.ts:197`-`207`）；`did-fail-load`/`render-process-gone` 的回退只挂在主窗 webContents 上（`src/main/index.ts:184`-`196`，`fallbackFromHotRenderer` `:223`-`237`）——桌宠窗首版不做自愈（坏了就关窗），C 期可选加固（R4）。

### 1.2 IPC 域注册模式、preload 暴露面、渲染层桥接

- 域注册：`src/main/ipc/register.ts:14`-`24` `registerIpcHandlers(ctx)` 逐域调 `registerXxxIpc(ctx)`；共享上下文类型 `IpcContext` 在 `src/main/ipc/context.ts:18`-`43`（可选依赖先例：`readonly sidecar?: SidecarManager` `:33`——pet 控制器同样设为可选，测试 context 不必构造）。handler 写法见 `src/main/ipc/system.ts:10`-`82`：`ipcMain.handle('settings:get', …)`；入参校验用 `src/main/ipc-validation.ts` 的解析器（`parseSettingsPatch` `:295`、`parseId`、`parseContent`）。
- 广播先例（多窗口关键）：`settings:set` 用 `BrowserWindow.getAllWindows().forEach(w => w.webContents.send('settings:updated', saved))`（`src/main/ipc/system.ts:61`）——pet 推送对「全部窗口」类事件照此广播；对桌宠窗的定向推送则持 `petWindow` 引用单发（`mainWindow?.webContents.send(...)` 的单发先例遍布 `src/main/index.ts`，如 `:134`）。
- preload：`src/preload/index.ts:29`-`286` 组装类型化 `api: AgentDeckApi` 对象，末尾 `contextBridge.exposeInMainWorld('agentdeck', api)`（`:288`）。事件订阅模式：`ipcRenderer.on` + 返回去订阅函数（如 `:162`-`166`）。
- 契约类型：`AgentDeckApi` 在 `src/shared/contracts.ts:197`，`settings` 分区 `:277`-`281`；pet 域在此加 `pet: { … }` 分区。
- 渲染层桥接：`src/renderer/src/api.ts:16` `export const bridge: AgentDeckApi = (window as …).agentdeck`，其上是 `useSettings`（读+订阅+patch 更新）等 hooks——pet 侧加 `usePetConfig` 同构 hook。

### 1.3 presets：预置了什么、可复用的零依赖 HTTP、key 存储

- 预设结构 `ApiPreset`（`src/main/presets.ts:9`-`21`）：`{ id, name, backend, baseURL, apiKey, protocol?: 'anthropic' | 'openai', note?, createdAt }`，backend 限定 `BACKEND_IDS`。**protocol 是现成的线协议字段**：openai = `/chat/completions` 兼容（OpenRouter/OneAPI/DeepSeek 等），anthropic = `/messages`；缺省推断规则写在 `:16`-`18`（baseURL 以 `/v1` 结尾或含 `openrouter.ai` → openai）。
- 存储：`userData/api-presets.json` 明文 JSON（`src/main/presets.ts:59`，`savePresets` `:69`-`74` 先 normalize 再整写）。**apiKey 明文存放**是现状惯例（settings 同理），pet 沿用、不新增存储机制，也不把 key 发往渲染层（渲染层只见 `PresetInfo`，`src/shared/contracts.ts:69`——按现状确认是否含 key，pet 设置面板只引用 presetId）。
- 可复用的零依赖 HTTP 惯例（`fetchPresetModels`，`src/main/presets.ts:85`-`110`）：全局 `fetch` + `AbortSignal.timeout(12s)` + 双鉴权头（`Authorization: Bearer` 与 `x-api-key`、`anthropic-version: 2023-06-01` 同时带，网关容忍多余头）+ base 归一（剥尾 `/`、剥尾 `/v1`）。`pet-llm.ts` 照抄这套，只把 GET /models 换成两协议的 POST chat。热更链路的 `fetchWithRetry`（`src/main/hot/feed.ts:27`-`100`）是超时/重试的另一个参考，但 pet 场景失败即降级，不需要重试。

### 1.4 settings/store 持久化约定

- `src/main/settings.ts:7`-`25`：`userData/settings.json`；`loadSettings` 以 `{ ...DEFAULT_SETTINGS, ...raw }` 合并（默认值在 `src/shared/types.ts:561`）；`saveSettings` 直接 writeFileSync。
- 更细腻的 store 惯例：`src/main/automation-store.ts:5`-`28`——ctor 接 `userDataDir`、目录 mkdir、读失败静默视为首启、**原子写**（写 `.tmp` 再 `renameSync`，`:17`）、字段白名单校验函数守入口。pet-store 采用后者（有环形缓冲要截断，值得独立类）。
- 直连冒烟样板：`scripts/smoke-automation.mjs:8`-`10` 用 `os.mkdtempSync` 临时目录实例化 store 做断言——pet-store 冒烟照此。

### 1.5 热更双通道：新模块组与新组件能否随热更发布

- 三层模型：壳（Electron 本体）→ L1 载荷指针 `userData/hot-app/<ver>` → L2 渲染层指针 `userData/hot-renderer/<ver>`（通道目录名映射 `src/main/hot/pointer.ts:33`-`34`）。bootstrap 五步加载链 `src/main/bootstrap.ts:62`-`98`；解析单源 `resolveHotState`（`src/main/hot/resolve.ts:26`-`79`）：载荷生效时主进程入口重定位到 `<ver>/out/main/index.js`（`:42`-`50`），渲染层优先 `<ver>/out/renderer/index.html`。
- 发布产物清单（`scripts/release-hot.mjs:203`-`238` `collectChannelFiles`）：
  - **payload 通道** = `walkFiles(out/main)` + `walkFiles(out/preload)` + `walkFiles(out/renderer)` + `package.json` + `build/icon.png` → **新增主进程模块组与渲染层组件都能随载荷发布**，无任何逐模块登记；
  - **renderer 通道** = 仅 `out/renderer/**` → 纯渲染层改动可免 relaunch 发布；pet 功能两进程都改，走 payload（relaunch）发布，与仓库近期 hot.18/19/20 发布节奏一致。
- 唯一的可达性要求：新代码必须从构建入口 import 可达。构建入口只有三个（`electron.vite.config.ts`：main `index`/`bootstrap`/`sidecar-server` `:10`-`14`；preload `index` `:24`；renderer `index.html` `:34`）。pet 主进程模块由 `src/main/index.ts` 引入、PetStage 由 `App.tsx` 引入即满足。
- 门禁：`minMainVersion: '0.18.2'` 硬编码在发布脚本（`scripts/release-hot.mjs:296`-`299`），客户端按壳版本验门（`src/main/hot/resolve.ts:30`、`:52`）。桌宠用的 Electron API（transparent 窗、`screen`、`Menu.popup`）都是远早于该基线的稳定 API，**旧壳收新载荷无兼容问题**。
- 静态资源的通道归属：非 bundle 资源目录（如顶层 `assets/`）不会出现在任何通道 zip 里（这也是修正 #1 的根据）；经 vite import 的图片会出现在 `out/renderer/`（内联或 `out/renderer/assets/`），两通道自然覆盖。`userData/pets/` 用户素材不进 zip（运行时本地文件，主进程 IPC 读取）。

### 1.6 App.tsx 路由分支、设置面板位置、tokens.css 约定

- 路由：无路由库。`type View = 'issues' | 'detail' | 'usage' | 'settings' | 'automation' | 'skills' | 'board' | 'agents'`（`src/renderer/src/App.tsx:22`），`useState<View>('board')`（`:30`），渲染三元链（`:159`）。桌宠分支：监听 `hashchange`，`location.hash` 以 `#/pet` 开头时整树早返回 `<PetStage />`（hooks 全部先执行完再分支，保住 React hooks 顺序；主题 effect `:41`-`47` 照常生效——桌宠窗气泡配色自动跟随主题）。
- 设置面板：`src/renderer/src/components/SettingsView.tsx`——`type Section`（`:12`）、左侧 `SECTIONS` 导航（`:14`）、分区条件渲染（`:48`-`52`）。桌宠设置以新分区或 General 区新卡片挂入；`openSettings(section)` 入口在 `src/renderer/src/App.tsx:117`。
- tokens.css：头部注释即宪法（`src/renderer/src/tokens.css:1`-`12`）——「组件代码只引用令牌变量，不直接写色值」，暗色默认 + `.light` 类切换。PetStage 的气泡/菜单/输入框全部走 `--bg-raised`、`--border`、`--text`、`--accent` 等令牌；桌宠窗根节点要把 html/body 背景显式置透明（`styles.css` 的默认底色会盖住 transparent 窗）。
- 渲染层入口 `src/renderer/src/main.tsx:15`-`18` 把 `<App />` 挂到 `#root`，全局 CSS 在此集中 import——PetStage 的样式文件在 `main.tsx` 或组件内 import 均可进 bundle。

### 1.7 smoke 直连写法（esbuild entryPoints）

- 主进程纯模块样板 `scripts/smoke-automation.mjs:8`-`9`：
  ```js
  await build({ entryPoints: [path.join(root, 'src/main/automation-store.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
  const { AutomationStore } = await import(pathToFileURL(outfile).href)
  ```
- 渲染层 TSX 样板 `scripts/smoke-diff.mjs:7`-`13`：同一套 build 参数 + `loader: { '.tsx': 'tsx' }` + `external: ['electron']`，直连 `src/renderer/src/components/DiffView.tsx` 消费其导出 `parseDiff`。
- 铁律（AGENTS.md）：凡被 `scripts/smoke-*.mjs` 经 entryPoints 直连的 `src/**` 导出 = 被测试固化的公共 API，**在 `src/` 内部零引用属正常状态，不得当死代码删除**；新增直连必须同步登记 `docs/graph/INVENTORY.md:491` 附录 A。pet 的新增直连清单见 §6。

---

## 2. 总体架构

```
┌─ 主进程 ──────────────────────────────────────────────┐
│ src/main/index.ts            initMain 里装配 PetController │
│ src/main/pet/                                              │
│   pet-controller.ts   组装入口：窗/存储/脑 的生命周期与开关   │
│   pet-window.ts       透明置顶窗创建/定位/移动/尺寸切换       │
│   pet-store.ts        userData/pet.json：配置+对话环形缓冲    │
│   pet-brain.ts        自主循环 + 单次互动；纯逻辑部分抽到 shared │
│   pet-llm.ts          零依赖 fetch 调 ApiPreset（双协议）      │
│   pet-pack-scan.ts    扫描 userData/pets/<packId>/（C 期）    │
│ src/main/ipc/pet.ts   pet:* 域 handler（注册进 register.ts）  │
│ src/main/prompts/pet-persona.ts  默认人设纯文案（先例:personas.ts）│
├─ 共享（双端同源，smoke 直连这里）────────────────────────┘
│ src/shared/pet.ts     素材包 schema/normalize + 状态机纯函数  │
├─ 渲染层 ──────────────────────────────────────────────┐
│ src/renderer/src/App.tsx        hash===#/pet → <PetStage/>   │
│ src/renderer/src/pet/                                        │
│   PetStage.tsx        帧动画 rAF + 物理 + 交互 + 气泡 UI       │
│   pet.css             令牌引用；html/body 置透明               │
│   pack-blob.ts        默认包帧 import 映射（vite 资产管线）      │
│   assets/blob/*.png   scripts/gen-pet-assets.mjs 生成并提交     │
└──────────────────────────────────────────────────────┘
```

分工原则：**主进程拥有一切状态与 IO**（窗口几何、配置、LLM、记忆），渲染层只做表现（帧动画、物理积分、交互捕获）并经 IPC 申报意图；跨端的「下一状态怎么转移」「包是否合法」只有一份实现（`src/shared/pet.ts`）。

---

## 3. 关键设计点

### 3.1 桌宠窗口（pet-window）

- 创建参数（对 `src/main/index.ts:150`-`166` 主窗参数的桌宠变体）：
  ```ts
  new BrowserWindow({
    width: frameSize.w, height: frameSize.h + bubbleReserve, // 贴身尺寸：sprite 区 + 气泡预留
    transparent: true, frame: false, hasShadow: false,
    resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    alwaysOnTop: true, skipTaskbar: true,
    webPreferences: { preload: <同主窗>, contextIsolation: true, nodeIntegration: false, sandbox: false }
    // 注意：不设 backgroundColor（主窗的 '#0f1115' 在透明窗上会变成实底黑块）
  })
  ```
  初始位置 = 主 display workArea 右下角；`showInactive()` 显示避免抢焦点。
- 加载：dev 走 `loadURL(process.env.ELECTRON_RENDERER_URL + '/#/pet')`；生产走与主窗相同的热更解析（`src/main/index.ts:197`-`207` 同款 `resolveHotState` + `loadFile(html, { hash: 'pet' })`）。
- 生命周期：`closed` 置 null；close 不拦截（无托盘驻留语义）；配置 `enabled=false` 或菜单退出即 `destroy()`。进程保活由现有 `window-all-closed` 空实现（`src/main/index.ts:688`-`692`）天然满足。
- 移动模型：渲染层 rAF 积分物理，每帧把新坐标经 `pet:move`（fire-and-forget `send`）交主进程 `win.setPosition`；拖拽 = 鼠标位移直接映射窗口位移并累计速度，松手带初速进入 `fall` 态（重力积分到 workArea 底边）。坐标一律 DIP，workArea 取窗口所在 display（`screen.getDisplayNearestPoint`），规避多屏 DPI（R7）。
- 窗口尺寸切换：双击聊天时主进程 `setBounds` 向上扩出气泡输入区，收起时还原——sprite 始终锚定窗口底部，扩缩不跳。
- 交互与点击：点击/双击/右键全部在渲染层 DOM 捕获（拖拽启动设 4px 位移阈值，与双击/点击区分）。C 期打磨项：透明 padding 区 hover 时 `setIgnoreMouseEvents(true, { forward: true })` + `document.elementFromPoint` 判定回切（R2 的彻底解）。

### 3.2 素材包格式（定稿）

包 = 一个目录：`pet.json` + 帧图。默认包帧经 vite import（名称→dataURL/URL 映射，`pack-blob.ts`）；用户包帧由主进程读文件转 dataURL 下发。schema 与校验/状态机函数一起住在 `src/shared/pet.ts`：

```jsonc
{
  "id": "blob",                      // 包 id；userData/pets/ 下与目录名一致
  "name": "小团子",                   // 展示名
  "version": 1,
  "frameSize": { "w": 64, "h": 64 }, // 单帧逻辑尺寸（DIP）
  "bubbleOffset": { "x": 0, "y": -8 },// 气泡相对 sprite 锚点的偏移
  "movement": {
    "walkSpeedPx": 40,               // DIP/s
    "gravityPx": 900,                // 抛掷下落加速度 DIP/s²
    "edgeBehavior": "turn"           // turn | bounce | wrap：到 workArea 左右边缘的处理
  },
  "states": {
    "idle":   { "frames": ["idle-0.png", "idle-1.png"], "fps": 2, "loop": true,  "next": [] },
    "walk":   { "frames": ["walk-0.png", "walk-1.png", "walk-2.png", "walk-3.png"], "fps": 6, "loop": true, "next": [] },
    "fall":   { "frames": ["fall-0.png"], "fps": 1, "loop": true, "next": [] },
    "dragged":{ "frames": ["dragged-0.png"], "fps": 1, "loop": true, "next": [] },
    "sleep":  { "frames": ["sleep-0.png", "sleep-1.png"], "fps": 1, "loop": true, "next": [] },
    "happy":  { "frames": ["happy-0.png", "happy-1.png"], "fps": 4, "loop": false,
                "next": [{ "to": "idle", "weight": 1, "afterMs": 1600 }] },
    "think":  { "frames": ["think-0.png", "think-1.png"], "fps": 3, "loop": true, "next": [] }
  }
}
```

- `states` 的 key 即状态 id，内置七个（idle/walk/fall/dragged/sleep/happy/think），**可扩展**：包里多写一个 state，PetStage 与状态机按数据驱动处理，无需改代码（brain 的 action 白名单另校验，未知 action 降级 `idle`）。
- 「动画行为可编辑」= 改 pet.json（帧序列/fps/loop/加权转移/速度/重力）；「素材替换」= 换目录里的 PNG。两者都不碰代码。
- `normalizePetPack(value: unknown): PetPack | null`：字段白名单 + 兜底（缺 movement 用内置默认；缺某 state 报 null），风格对齐 `src/main/presets.ts:25`-`44` 的 normalizePreset。
- 状态机纯函数（同文件）：`pickNextState(pack, stateId, rand): string | null`（非 loop 态播完按 `next[]` 权重抽下一个）、`petActionToState(action): PetStateId`（brain 产物 → 动画态映射与降级）。

### 3.3 大脑（pet-brain + pet-llm）

- 配置（存 pet.json）：`{ enabled, packId, presetId, model, intervalSec, persona }`。`intervalSec` 默认 90，钳位 ≥30（防手滑打爆配额）；`presetId`/`model` 复用 `presets:list`、`presets:models`（`src/main/ipc/catalog.ts:104`-`110`）的既有数据面，设置面板下拉即用。
- 自主循环（`pet-brain.ts`，主进程 `setInterval`，模式参照 automationTick `src/main/index.ts:562`-`573`）：
  1. 组 prompt：system = persona（用户可编辑，默认文案放 `src/main/prompts/pet-persona.ts`，纯文案模块先例 `src/main/prompts/personas.ts:1`-`3`）+ 宏展开后的任务板上下文；messages = 记忆环形缓冲最近 6 轮 + 本轮指令「以严格 JSON 返回 {say, action}，action ∈ idle|walk|think|sleep|happy」。
  2. 宏集（首版）：`{TASKS_SUMMARY}`（按状态计数的任务板摘要）、`{ISSUES_OPEN}`（进行中 Issue 标题列表）、`{RECENT_DONE}`（最近完成 N 条）、`{TIME}`。数据从 `store.list()` / `issueStore.list()` 聚合，构造时注入访问器（依赖注入风格同 runner 的 attachXxx，`src/main/index.ts:458`）。
  3. `pet-llm.ts` 按所选预设的 protocol 发 chat 请求（openai → `POST {base}/chat/completions`；anthropic → `POST {base}/v1/messages`），`max_tokens` 压到 ~120，超时 12s，不重试。
  4. 解析：健壮 JSON 抽取（首个平衡 `{…}` + `JSON.parse`，失败则整段当 `say`、action=`idle`）；再失败走内置台词轮换（`pet-persona.ts` 的 fallback 数组）——**任何失败都不阻塞动画**，桌宠永远「活着」。
  5. 产出经 `pet:say` 推送到桌宠窗（显示气泡 + 触发对应状态），并追加进记忆缓冲。
- 互动单发：点击反应（`pet:interact`，主进程 5s 防抖）与气泡聊天（`pet:chat`）走同一个「组 prompt → 调 LLM → 解析 → 推送」管线，只是用户消息不同、防抖不同。未配预设时全部降级内置台词。
- 记忆：环形缓冲 `{role: 'user'|'pet', text, ts, kind: 'chat'|'auto'}` 上限 50 条，随 pet.json 原子持久化；设置面板可一键清空。

### 3.4 热更登记结论（修正 #6 展开版）

- **不需要**任何新增入口/模块清单：payload zip 收 `out/**` 目录整体（`scripts/release-hot.mjs:214`-`224`），模块经 import 链进 bundle 即随包。桌宠上线按仓库现行节奏跑 `node scripts/release-hot.mjs`（payload+renderer 双通道）即可。
- **需要**登记的是三处文档/脚本面：① 新 smoke 直连写进 `docs/graph/INVENTORY.md:491` 附录 A；② `src/` 结构变化后 `npm run graph:deps`（AGENTS.md 约定）；③ `docs/API.md` 补 pet 域 IPC 表、`docs/README.md` 导航行。
- 未来若真要加「非 bundle 静态资源目录」（本设计已规避），才需要动 `collectChannelFiles` + `electron-builder.yml` 两处——在那时再评估。

---

## 4. 交互设计

| 交互 | 行为 | 实现 |
|---|---|---|
| 单击 | 反应动画（happy/think）+ LLM 一句话（5s 防抖；无预设 → 内置台词） | 渲染层 click（拖拽阈值外）→ `pet:interact` → `pet:say` |
| 拖拽 | `dragged` 态跟手；松手带速度进 `fall`，重力落底 | 4px 位移阈值启动；`pet:move` 流；速度末采样 |
| 落地后 | 底边随机行走（`walkSpeedPx`），边缘按 `edgeBehavior` | 主进程 tick 或落底回调触发 `walk`，方向由 brain/随机 |
| 双击 | 气泡聊天输入（窗口上扩），发送 → 回复气泡 | `pet:window-resize` + 渲染层输入框 → `pet:chat` |
| 右键 | 原生菜单：打开主窗口 · 切换素材包 · 暂停/恢复自主 · 清空记忆 · 关闭桌宠 | 渲染层 `contextmenu`（带屏幕坐标）→ `pet:menu` → 主进程 `Menu.buildFromTemplate(...).popup()`（模板先例 `src/main/index.ts:253`-`263`） |
| 自主 | 每 `intervalSec` 一次 brain tick：说话/走动/思考/睡觉 | §3.3；窗内被拖拽/聊天时 tick 静默让位 |

PetStage 动画为 DOM+CSS：sprite 是绝对定位 `<img>`（或 background-image），rAF 按 `fps` 换帧、按物理积分改窗口位置；气泡为令牌化样式的浮层。

---

## 5. IPC 面定稿（pet 域）

新增 `src/main/ipc/pet.ts`，登记进 `src/main/ipc/register.ts:14`-`24`；`IpcContext` 增 `readonly pet?: PetController`（可选，先例 `src/main/ipc/context.ts:33`）。契约进 `src/shared/contracts.ts`（`AgentDeckApi` `:197` 加 `pet` 分区），preload 加 `pet` 分区，渲染层 `src/renderer/src/api.ts` 加 hooks。

| 通道 | 类型 | 入参 → 出参 | 说明 |
|---|---|---|---|
| `pet:get-state` | invoke | → `{ config: PetConfig; packs: Array<{id,name,source:'builtin'\|'user'}> }` | 主窗设置面板读取 |
| `pet:set-config` | invoke | `Partial<PetConfig>` → `PetConfig` | normalize 后存 pet.json；广播 `pet:config-updated` 到全部窗口（先例 `src/main/ipc/system.ts:61`）；enabled 翻转时开/关窗 |
| `pet:open` / `pet:close` | invoke | → `{ ok }` | 显式开/关桌宠窗 |
| `pet:move` | send | `{ x, y }` | 渲染层物理帧 → `win.setPosition`（节流至 rAF） |
| `pet:window-resize` | invoke | `{ bubble: boolean }` → `{ bounds }` | 聊天气泡区扩/缩 |
| `pet:interact` | invoke | → `{ queued: boolean }` | 点击反应（主进程防抖） |
| `pet:chat` | invoke | `{ text }` → `{ queued }` | 气泡聊天，回复走推送 |
| `pet:clear-memory` | invoke | → `{ ok }` | 清空环形缓冲 |
| `pet:menu` | invoke | `{ x, y }` | 原生右键菜单 |
| `pet:say` | send（→ 桌宠窗） | `{ text, action, kind: 'auto'\|'reply'\|'react' }` | 大脑/互动统一出口 |
| `pet:config-updated` | send（→ 全部窗口） | `PetConfig` | 配置变更广播 |

入参校验沿用 `src/main/ipc-validation.ts` 解析器 + `src/shared/pet.ts` 的 normalize；key 等敏感量不下发（渲染层只持 presetId）。

---

## 6. 分期计划（文件清单 + smoke 清单 + 验证门）

### A 期——骨架（看得见、摸得着）

文件：
- `src/shared/pet.ts`（新增）：包 schema、`normalizePetPack`、`pickNextState`、`petActionToState`、`PetConfig` 类型与钳位。
- `src/main/pet/pet-store.ts`（新增）：`userData/pet.json` 读写 + 环形缓冲（automation-store 惯例）。
- `src/main/pet/pet-window.ts`、`src/main/pet/pet-controller.ts`（新增）：窗口创建/移动/缩放、开关生命周期。
- `src/main/ipc/pet.ts`（新增）+ `src/main/ipc/register.ts`、`src/main/ipc/context.ts`（登记）；`src/main/index.ts` initMain 装配（一行级改动）。
- `src/preload/index.ts` + `src/shared/contracts.ts`（pet 分区）；`src/renderer/src/api.ts`（hooks）。
- `src/renderer/src/pet/PetStage.tsx`、`pet.css`、`pack-blob.ts`、`assets/blob/*.png`（新增）；`src/renderer/src/App.tsx`（hash 分支）。
- `src/renderer/src/components/SettingsView.tsx`（桌宠卡片：开关 + 打开/关闭；A 期不接 LLM）。
- `scripts/gen-pet-assets.mjs`（新增）：Node 内置 `zlib` 手写极简 PNG 编码器（IHDR/IDAT(store 或 deflate)/IEND + CRC32 表，8-bit RGBA、逐扫描线 filter 0）把 ASCII 像素画编译为「小团子」七态帧（64×64，约 14 帧）+ 默认 `pet.json`，产物提交进仓库——**构建与运行时均零 npm 依赖**。
- `package.json`：`smoke:pet-pack`、`smoke:pet-store`、`smoke:pet-behavior` 三条 script。

smoke（直连清单，登记 INVENTORY 附录 A）：
- `scripts/smoke-pet-pack.mjs` → `src/shared/pet.ts`：normalize 合法/畸形包、字段兜底、状态 id 扩展。
- `scripts/smoke-pet-behavior.mjs` → `src/shared/pet.ts`：加权转移分布、非 loop 态播完转移、action 降级映射。
- `scripts/smoke-pet-store.mjs` → `src/main/pet/pet-store.ts`：mkdtemp 持久化、环形缓冲截断、配置钳位（样板 `scripts/smoke-automation.mjs`）。

验证门：`npm run typecheck` + `npm run build` + `npm run smoke:stage6` + 三个新 smoke；win32 真机过一遍透明窗/拖拽/点击（AGENTS.md 三关 + 专项）。

### B 期——AI 脑（开口说话）

文件：`src/main/pet/pet-brain.ts`、`src/main/pet/pet-llm.ts`（新增）；`src/main/prompts/pet-persona.ts`（默认人设 + fallback 台词）；`src/main/ipc/pet.ts`（interact/chat/say 接线）；SettingsView（persona 编辑器 + 宏插入按钮 + 间隔 + 预设/模型下拉——下拉数据走既有 `presets:list`/`presets:models`）；PetStage（气泡聊天输入/回复 UI、自主行为动画接线）。

smoke：`scripts/smoke-pet-brain.mjs` → 纯逻辑抽层（prompt 组装含宏展开、JSON 抽取解析、失败降级决策），LLM HTTP 不进 smoke（与全仓惯例一致——网络调用无直连冒烟）。

### C 期——打磨

- 右键原生菜单；`userData/pets/` 扫描（`src/main/pet/pet-pack-scan.ts`，包切换热生效）；点击穿透优化（`setIgnoreMouseEvents(true,{forward:true})` + `elementFromPoint`）；桌宠窗 `did-fail-load` 兜底关窗（对齐主窗自愈语义，`src/main/index.ts:184`-`196`）。
- 文档：本文档随实现校正；`docs/API.md` 补 pet 域表；`docs/README.md` 导航行。
- `npm run graph:deps` 刷新机读依赖图；`npm run smoke:all` 全量 + `typecheck`/`build` 三关。

---

## 7. 风险表

| # | 风险 | 事实基础 | 缓解 |
|---|---|---|---|
| R1 | win32 透明窗异常：实底黑块/阴影残影/缩放黑边 | 仓库无 transparent 先例（§1.1）；Electron 要求 transparent 与 frame:false 同用、不可 resize/maximize | 参数定死（§3.1）：`transparent+frame:false+resizable:false+hasShadow:false`，**不设 backgroundColor**；A 期首个验收项就是 win32 真机目检 |
| R2 | 透明 padding 挡住下层窗口点击（透明区默认仍收鼠标） | Electron 默认行为 | MVP 用贴身窗口尺寸把 padding 压到最小；C 期 `setIgnoreMouseEvents(true,{forward:true})` + `elementFromPoint` hover 回切彻底解决 |
| R3 | 多窗口边角：`activate` 重建判断按 `getAllWindows().length===0`（`src/main/index.ts:657`-`659`），桌宠窗存活会抑制主窗重建（主要影响 macOS） | 侦察 §1.1 | win32 主目标不受影响；如需根治，把判断改为 `mainWindow` 空引用检查（一行，C 期顺手项） |
| R4 | 热更自愈只护主窗：`did-fail-load`/`render-process-gone` 处理挂在主窗（`src/main/index.ts:184`-`196`） | 侦察 §1.1 | A 期桌宠窗加载失败直接销毁（用户无感损失）；C 期补同款回退：坏版本时关桌宠窗并提示重开 |
| R5 | 热更发布遗漏：默认包资源走错通道 | payload/renderer 通道只收 `out/**`（`scripts/release-hot.mjs:203`-`238`） | 帧图必须经 vite import（修正 #1），评审时检查「无新增顶层静态资源目录」；发布后按 §1.5 自检 zip 内含 `out/renderer/assets/*` 或 dataURL |
| R6 | LLM 成本与失效：90s 自主循环打 API | 用户自带预设（需求原文「毕竟我给 api」） | 间隔可配且钳位 ≥30s、`max_tokens` 压小、失败不重试直接降级内置台词；设置面板明示当前预设与间隔 |
| R7 | 多屏/DPI 抛掷漂移：混合 DPI 下 setPosition 坐标系不一致 | 主进程尚无 `screen.*` 使用先例（grep 证实，全新 API 面） | 统一 DIP 坐标；workArea/边界计算取 `screen.getDisplayNearestPoint(win.getPosition())`；A 期真机验证双屏 |
| R8 | IPC handler 双注册崩溃 | `initMain` 幂等闸已防双初始化（`src/main/index.ts:271`-`276`） | pet 域只经 `registerIpcHandlers` 单点注册，不另起 RegisterIpc 入口 |
| R9 | apiKey 明文存储被桌宠面放大（气泡/日志泄露） | 现状即明文存 `userData/api-presets.json`（`src/main/presets.ts:59`） | 不新增暴露面：渲染层只持 presetId，say/chat 日志不落盘 key，prompt 不含 key |

---

## 8. 验收清单（本设计文档自包含性）

- [x] 侦察结论七项带 file:line —— §1.1–§1.7
- [x] 定稿素材包格式（pet.json schema + 状态机语义 + 扩展规则）—— §3.2
- [x] IPC 面（通道表 + 校验 + 广播语义 + 契约落点）—— §5
- [x] 分期文件清单与 smoke 清单（含直连写法与登记义务）—— §6、§1.7
- [x] 风险表（win32 透明窗 / 多窗口 / 热更登记三大必答项 + 其余六项）—— §7
- [x] 约束达成路径：零代码改动（本文档为唯一交付物）、零新 npm 依赖（PNG 生成器用 `node:zlib`，LLM 用全局 `fetch`）、全篇仓库相对路径
