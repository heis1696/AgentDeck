# 桌宠 AI 素材包生成：方案、工具与踩坑记录

> 2026-09-20 一次完整生图实践的经验沉淀。目标：供后续桌宠开发（尤其是"AI 生成素材包内置到应用"功能，见 §7）迁移复用。
> 产物样例：`mint-blob` 包（八态 19 帧，256×256），已装 `%APPDATA%/agentdeck[-dev]/pets/mint-blob/`。
> 工作文件全部在 `out/pet-gen/`（gitignored），文件地图见 §8。

## 1. 任务与契约回顾

生成一个桌宠素材包 = 产出 `pet.json` + 帧图，满足：

- **八态**：`idle/walk/fall/dragged/sleep/happy/think` 七态必需 + `eat` 可选（白名单，`src/shared/pet.ts` 的 `PET_CORE_STATE_IDS/PET_EXTRA_STATE_IDS`）
- **帧命名**：`<state>-<n>.png`（0 基），`pet.json` 的 `states.<id>.frames` 引用真实文件
- **校验**：过 `validatePetManifest`（注意返回语义：**null = 失败，返回解析后的对象 = 成功**）
- **安装位置**：`userData/pets/<packId>/`（Windows：`%APPDATA%/agentdeck[-dev]/pets/`）。⚠️ 不是 `src/renderer/src/pet/assets/`——那是内置包（`default`）的位置，且内置是构建期 vite 内联硬编码导入，运行时不扫（`src/main/pet/packs.ts:1`，文档漂移已修正）
- **显示端几何**（决定帧该做多大，见 §5）：精灵矩形 = 64 × `PET_SPRITE_SCALE`(=2) × zoom(1/1.5/2) = **128/192/256px** 三档

## 2. 路线演进（按时间序）

| 路线 | 做法 | 结论 |
|---|---|---|
| A. 本地 SDXL 逐帧 | ComfyUI + 动漫 checkpoint，每帧独立文生图 | 探针可行但**帧间姿势/风格漂移**（社区公认短板），否决。残留文件差点混包，见 §6 |
| B. 现成方案调研 | FalSprite / SpriteForge / ai-game-spritesheets / ComfyUI Purz workflow | 各有门槛（fal key / Azure / 手动流程 / 需 Nano Banana），但**方法论全部可白嫖**，见 §3 |
| C. ✅ 最终采纳 | 中转站 gpt-image-2（用户自写 ComfyUI 节点）+ agent-sprite-forge 方法论 + pet-pack.mjs 装配 | mint-blob 包成功产出，QC 全绿 |
| D. 已规划未实施 | 内置到桌宠应用（主进程直连中转站，去 ComfyUI 中间人） | 方案见 §7，等开发排期 |

**核心认知**（来自社区实测，本次全部验证）：
- 一致性靠**编辑类模型（gpt-image 系列）+ 角色锚点参考图**，纯扩散逐帧文生图必漂
- 单张 sheet 内多帧一致性靠"**一图多格**"天然保证；跨 sheet 一致性靠锚点链
- gpt-image-2 **无 seed**（不可复现），一致性设计必须绕开种子

## 3. 使用的 skill / 工具清单

| 工具 | 是什么 | 本次怎么用 / 评价 |
|---|---|---|
| **agent-sprite-forge**（0x0funky，MIT，~3.7k★） | Codex skill：洋红 sheet prompt 规则 + 确定性 Python 后处理 | **最大功臣**。用了它的 `references/prompt-rules.md` 提示词铁律 + `generate2dsprite.py process` 切帧器（LANCZOS 缩放、四角洋红键控、QC 元数据、scale-profile 跨表统一尺寸、GIF 预览）。clone 在 `out/pet-gen/vendor/agent-sprite-forge/`。⚠️ 它的 `build-prompt` 会硬编码追加 "Digimon/Pokemon... NOT cute, NOT round" 风格标签，与自定义人设冲突——**prompt 手写、后处理用它的** |
| **ComfyUI_GPT_Image_2**（用户自写节点） | `GPTImage2Generate`（文生图 `/images/generations`）+ `GPTImage2Edit`（图生图 `/images/edits`，IMAGE+MASK 输入，multipart） | 节点代码在 `G:\ComfyUI_windows_portable\ComfyUI\custom_nodes\ComfyUI_GPT_Image_2\`。质量高（size 按 tier+ratio 算、SSE 流式、524/504 中文报错提示）。注意：**Edit 节点早就有**，别再以为它只支持文生图 |
| **中转站** `api.zayuapi.com` | OpenAI 兼容代理，key 在用户 ComfyUI workflow 里 | `/v1/images/generations` + `/v1/images/edits` 都支持；**~100s 网关超时**（Cloudflare 层），1k+medium 单张 36-61s 安全，偶发 504 需重试 |
| **pet-pack.mjs**（仓库自带） | 素材包 CLI：契约装配 + 零依赖图像链路 | 用了 `buildManifest`（导出可 import）。其 comfyui 通道有个 payload bug 已修（§6） |
| **gpt-image-2 skill**（`~/.codex/skills/gpt-image-2`） | 三模式图像 skill（A 需 OPENAI_API_KEY / B 宿主生图 / C 纯顾问） | 本次未用上（无直连 key），Mode C 的模板库以后可参考 |
| 本地 SDXL checkpoints | `rinFlanimeIllustrious_v40` 等 5 个动漫模型 | 路线 A 用过，网格纪律其实不差（idle 探针 3 列等分合格），但一致性不足被否决 |

## 4. 最终配方（可直接迁移）

### 4.1 八态 sheet 规格

| 态 | 网格 | API ratio | 逐格动作（prompt 里的 Cell 描述） |
|---|---|---|---|
| idle | 1×3 | 3:2 | 站立呼吸：中立→压扁吸气→伸展呼气 |
| walk | 2×2 | 1:1 | 侧视走路循环：触地→压缩→回弹→最高伸展 |
| fall | 1×2 | 3:2 | 空中惊慌手舞→落地压扁晕 |
| dragged | 1×1 | 1:1 | 被拎头悬空、下垂拉伸、哭脸 |
| sleep | 1×2 | 3:2 | 蜷睡微笑气泡→睡更深蜷更紧 |
| happy | 1×2 | 3:2 | 跳起张手大笑→落地压扁眯眼 |
| think | 1×2 | 3:2 | 歪头上看撅嘴→缩下巴沉思汗滴 |
| eat | 1×3 | 3:2 | 持饼干张口→咀嚼鼓腮碎屑→舔嘴满足 |

### 4.2 Prompt 模板（agent-sprite-forge 规则，手写版）

```
A {rows}x{cols} 2D game sprite animation sheet of the same {角色描述}.
Layout: {N} equal vertical columns side by side / {cols} columns x {rows} rows, reading order left-to-right then top-to-bottom.
Cell 1: {动作}. Cell 2: {动作}. ...
SAME character, SAME size, SAME facing direction, SAME palette in all {N} cells. {风格标签}.
Background is 100% solid flat magenta (#FF00FF) everywhere, no gradients.
NO text, NO labels, NO words, NO letters anywhere.
ABSOLUTE RULES: 1. EXACTLY {N} equal cells. 2. NO borders/dividing lines/frames between cells.
3. NO text. 4. Character fills 80%+ of each cell, SAME size/bounding box/pixel scale, nothing crossing a cell edge.
5. Cells connected by magenta background only.
```

锚点版（后续 7 张走 edits）：`Recreate the EXACT same character from the reference image (identical identity, colors, proportions, outline and style), arranged as a new sheet: {同上} + Use the reference image only for the character identity, not its poses or layout.`

### 4.3 生成流程（gpt-sheet-run.mjs 已实现）

1. **idle 文生图**：`POST /v1/images/generations`，JSON `{model:'gpt-image-2', prompt, size, quality:'medium'}`，tier 1k
2. idle 结果经 ComfyUI `/upload/image` 上传为锚点
3. **其余 7 张图生图**：`LoadImage(锚点) → GPTImage2Edit`，`/v1/images/edits` multipart
4. 每张 3 次退避重试（5s×attempt）；断点续跑（`raw/<state>.png` 已存在即跳过）
5. 取图：轮询 `/history/<prompt_id>` → `/view`（ComfyUI 侧）

### 4.4 切帧（sprite-forge 处理器）

```bash
python generate2dsprite.py process --input raw/idle.png --target creature --mode idle \
  --output-dir frames-hd/idle --rows 1 --cols 3 --cell-size 256 --align bottom --shared-scale \
  --label-prefix idle --write-scale-profile scale-profile-hd.json   # 首张写 profile
# 其余 --scale-profile scale-profile-hd.json 复用（跨表角色像素尺寸一致，防状态间忽大忽小）
```

QC 看 `pipeline-meta.json` 的 `qc_summary`：`empty_frames / edge_touch_frames / paste_clamped_frames` 全空才收。

### 4.5 装配（assemble.mjs）

- 帧 1 基（`idle-1.png`）→ 契约 0 基（`idle-0.png`），文件名以 `buildManifest` 产出的 `states.<id>.frames` 为准
- `frameSize: [256, 256]`、**`rendering: 'smooth'`**（见 §5，渲染端按包切换 image-rendering，已实现：`src/shared/pet.ts` 类型 + `PetStage.tsx` 应用）
- 装包到两个 userData（打包版 + dev 版）：`%APPDATA%/agentdeck/pets/` 和 `%APPDATA%/agentdeck-dev/pets/`

## 5. 清晰度问题（本次最重要的教训）

**现象**：ComfyUI 里原图清晰，装包后锯齿糊成一团。

**根因链**（两个叠加）：
1. 切帧默认 `--cell-size 64`，而显示端是 128/192/256px（`PET_SPRITE_SCALE=2` × zoom 三档）——64px 位图放大 2~4 倍
2. `pet.css` 硬编码 `image-rendering: pixelated`（为内置 default 像素风设计）——平滑位图非整数倍缩放时最近邻采样加重锯齿

**修复**（已合入代码）：
- 帧源 256px（最大档原生 1:1，其余高质量下采样）——纯资产层，旧代码也立竿见影
- pet.json 顶层 `rendering: 'smooth'` 字段（契约本就放行顶层扩展），`PetStage` 在 manifest 装载时设 `imageRendering: 'auto'`；**缺省仍是 pixelated，default 像素包零影响**

**迁移要点**：以后任何 AI 生成包都 `cell-size 256` + `rendering:'smooth'`；手绘像素包继续 64 + 缺省。

## 6. 踩坑全录（现象 → 根因 → 解法）

1. **ComfyUI /prompt 传字符串 workflow → HTTP 500**
   根因：`pet-pack.mjs` 的 `comfyBackend` 把 workflow `JSON.stringify` 后放进 `prompt` 字段；ComfyUI 0.28 要求对象。
   解法：已修（`prompt: filled`），`smoke-pet-pack.mjs` 加了"prompt 字段必须是对象"断言防回归。**此修复尚未提交，记得带上**。
2. **首帧垫图 {{REF_IMAGE}} 空串炸 LoadImage**
   根因：pet-pack 的 REF_IMAGE 机制首帧传 `''`，ComfyUI LoadImage 校验文件名非空即拒。
   解法：sheet 模式不用 workflow 内 LoadImage 占位符，驱动脚本自己管理锚点上传与引用。
3. **中转站 504「网站请求超时」**
   根因：中转/Cloudflare 层 ~100s 上限，偶发慢。
   解法：1k + medium 控制单张时长；每张 3 次退避重试；断点续跑。节点作者注释还提示了 partial_images SSE 方案（需中转真转发流式）。
4. **被取消任务的残留文件差点混包**
   根因：SDXL 旧跑（被用户转向打断）留下 `fall.png(1024×512)/dragged.png(512×512)`，尺寸与 gpt 产物（1024×688/1024×1024）不同。
   解法：装配前指纹校验（尺寸 + 四角像素是否洋红）。**任何断点续跑管线都要防这个**。
5. **`build-prompt` 风格标签污染**
   根因：sprite-forge 的 prompt 构建器硬编码 "Digimon/Pokemon inspired... NOT cute, NOT round"，与团子人设冲突。
   解法：按 `prompt-rules.md` 手写模板，只借规则不借构建器。
6. **素材包装错位置（renderer assets 无效）**
   根因：`docs/features/desktop-pet.md` 旧文档写的是 `src/renderer/src/pet/assets/`，但那只是内置包（构建期内联）位置；用户包在 `userData/pets/`。
   解法：文档两处已修正；装包装到两个 userData（打包/dev 各一）。
7. **`validatePetManifest` 返回语义误读**
   现象：打印出 `[object Object]` 以为失败。
   根因：它返回 `PetManifest | null`——**null 才是失败**，返回对象是成功（smoke 里 `!== null` 即通过）。
8. **gpt 返回尺寸不严格等于请求**
   现象：请求 3:2@1k，回来 1529×1029 / 1254×1254 等。
   解法：切帧器按 rows/cols 等分切割，对绝对尺寸不敏感，无需处理。
9. **Node 子进程 stdout 管道缓冲**
   现象：后台 run 的日志文件迟迟不刷新，误判任务挂死。
   根因：node 输出到非 TTY 管道是块缓冲。判断进度用 ComfyUI `/queue`+`/history` 而不是日志。

## 7. 迁移方案：内置到桌宠应用（已设计待实施）

ComfyUI 在链路里只是"调中转站 HTTP API 的中间人"。内置 = 主进程直连，复用现有 `ApiPreset` 体系（`src/main/presets.ts`，baseURL+apiKey 存 `userData/api-presets.json`，桌宠聊天脑已在用，**key 管理零新增**）：

- **`src/main/pet/pack-generator.ts`**（纯逻辑可 smoke）：`buildSheetPrompts(description)` + `generatePetPack({preset, description, packId, userDataDir}, onProgress)`——首张 generations、其余 edits multipart（锚点字节内存传递）、每张 3 次重试、切帧（洋红泛洪去背 + 网格等分 + 缩放，图像函数从 pet-pack.mjs 复制副本保持主进程零 npm 依赖）、`buildManifest` + `rendering:'smooth'`、原子写 `userData/pets/<packId>/`
- **IPC**：`pet:generate-pack` invoke + `pet:packgen-progress` 推送事件（照 `pet:state` 的 `webContents.send` 模式）；模块级并发锁
- **UI**：SettingsView 桌宠卡片尾部加"AI 生成素材包"区（描述 + 包名 + preset 下拉默认当前 + 进度 + 完成自动 setPack）
- **smoke**：`smoke-pet-packgen.mjs` 假 HTTP server 断言调用序列（1×generations + 7×edits 含锚图）+ 产物过 `validatePetManifest`
- **URL 拼接**：照 `pet-llm.ts` 的 baseURL 归一化（裸主机/带 /v1 两种候选）
- 边界：打包版需热更发布；要求站点支持 `/v1/images/*`（zayuapi 已验证）

## 8. 工作文件地图（out/pet-gen/，gitignored）

| 路径 | 用途 |
|---|---|
| `gpt-sheet-run.mjs` | **主力驱动**：八态洋红 sheet 生成（锚点法 + 重试 + 断点续跑），key 运行时从用户 ComfyUI workflow 读取不落盘 |
| `assemble.mjs` | 帧装配：frames-hd → packs/mint-blob（pet.json + 0 基重命名 + rendering:'smooth'） |
| `sheet-run.mjs` | ⚠️ 废弃：SDXL 本地版驱动（路线 A 遗物，勿用） |
| `probe.mjs` / `sheet-workflow-api.json` / `workflow-api.json` / `pet-pack.config.json` | 探针与 workflow 模板（占位符版，给 pet-pack.mjs 通道用的） |
| `raw/` | 8 张 gpt 洋红 sheet 成品（可复用再切不同 cell-size） |
| `frames-hd/`（256）/ `frames/`（64，废弃） | 切帧产物 + QC meta |
| `packs/mint-blob/` + `*-preview.png` | 装配产物 + 目检拼图 |
| `vendor/agent-sprite-forge/` | 处理器源码（MIT） |

## 9. 成本与耗时参考

- 8 张 sheet（1k + medium，中转站）：**全程约 6 分钟**，单张 36-61s
- 包体积：256px 19 帧 ≈ **960KB**
- 复盘口径：一次完整试错（含废弃路线、504 重试、残留清理）约 2 小时；熟路重跑（改 CHAR 描述 + `gpt-sheet-run.mjs` + 处理器 + `assemble.mjs`）约 10 分钟
