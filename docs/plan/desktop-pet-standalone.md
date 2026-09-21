# 小助理独立化与大加强·实施方案（调研定稿）

> 状态：**调研定稿，未实施**。本文是「小助理从 AgentDeck 内置功能独立成项目」的总体方案，由 2026-09-21 四路并行调研汇总而成：①web 渲染栈选型验证（联网查证）、②Cortico/Alife 借用机制实现级深读、③AgentDeck 侧耦合与缝合点盘点、④架构红队评审（8 高危）。
> 前置文档：[desktop-pet.md](desktop-pet.md)（A/B/C 期设计与实现）、[desktop-pet-content.md](desktop-pet-content.md)（人设与台词基线）、[pet-pack-ai-generation.md](pet-pack-ai-generation.md)（生图实践）、[desktop-pet-references.md](../research/desktop-pet-references.md)（桌宠生态调研）、[../features/desktop-pet.md](../features/desktop-pet.md)（现行功能契约）。
> 定位一句话：**陪玩、陪聊、有交互、有自主行为、屏幕感知、动画可无限扩展、可多宠多模型同屏互动的独立陪伴 agent；AgentDeck 是它的第一个宿主。**

---

## 0. 决策记录（已拍板，后续章节均以此为准）

| # | 决策 | 理由 |
|---|---|---|
| D1 | **不上游戏引擎**。独立项目渲染栈 = Electron 透明窗 + PixiJS(WebGL) + matter-js | 桌宠生存刚需（透明/置顶/逐像素穿透/多屏混 DPI/屏幕捕捉/npm 扩展生态）全是 web 栈主场；透明穿透窗在 Unity/Godot 里非一等公民。赛道共识（Alife 用 WPF+WebView2、PetKit 纯 web） |
| D2 | **扩展两层**：素材/人设/台词包 = 纯数据包（校验器守门）；可执行扩展 = 受限子进程 capability RPC，**首版不开放** | npm 可执行包会击穿宿主工具白名单（红队高危③）；数据包已满足初期「方便拓展」 |
| D3 | **createTask 默认只建草稿**，执行权独立确认；annotateTask 走不触发 @mention 的独立通道 | 建任务会启动本地 agent、评论 @agent 会触发执行（`src/main/ipc/issues.ts:11,30`），都不是小权限 |
| D4 | **不采用 Live2D，帧动画为唯一动画路线**（2026-09-21 用户决策） | Cubism 授权结论留档备查：个人/年营收 <1000 万日元免费，超过须付费 Publication License（发布前 ≥1 个月办理）；约束来自 Cubism Core 运行时，与包装库无关 |
| D5 | 阶段 1 在 AgentDeck 仓库内实施，**继续守主进程零第三方运行时依赖铁律**；PixiJS/matter-js/GSAP 只进独立仓库（或渲染层） | 延续 `docs/plan/desktop-pet.md` 硬约束与热更链路 |
| D6 | 多宠 = **单进程共享舞台**，但解析/推理移入 Worker；对渲染层崩溃**不承诺单宠故障隔离**，主进程监督并从快照重建舞台 | 红队高危①：共享 renderer 中死循环/OOM/WebGL context 丢失会带走全部宠物 |

## 1. 需求 → 能力映射

| 需求（原话要旨） | 承载能力 | 蓝图来源 |
|---|---|---|
| 陪玩、陪聊、有交互 | 对话层升级（多轮质量、流式气泡）、投喂/拖拽/抛掷既有交互 | 既有 + Cortico Persona |
| 自主独立行为和「意识」 | 自主行为阶梯 + 记忆分段 + 内部状态（好感/心情）调制 | Alife SystemEvent/记忆 |
| 方便拓展 | 数据包生态（pack/persona/lines）+ 宿主工具注册表 | Cortico 扩展门 |
| 动画完备、想要更多动作 | 开放动作注册表 + PetGen 增量生成新动作 | 自研（锚点链已验证） |
| 屏幕捕捉 | 视觉三层（L0 窗口统计/L1 OCR/L2 VLM） | Alife Vision（触发策略改良） |
| 多模型多宠打架 | 共享舞台层 + 宠际事件 + 打架编排 | Alife 多开互联（补回执/离线队列） |
| AgentDeck 联动 | PetHostContract（事件进+反应开关 / 小权限工具出） | Cortico World 契约 |

## 2. 目标架构

```
┌─ 小助理（独立项目）──────────────────────────────┐
│ 表现层  Electron 透明窗 + PixiJS 舞台 + matter-js │  D1
│         （逐像素 alpha 命中、GSAP 补间、Live2D 可选）│
│ 世界层  共享舞台：坐标/碰撞/宠际事件广播/打架编排   │  D6
│ 生命层  开放动作注册表 + 养成调制 + 自主行为阶梯    │
│ 认知层  LLM 全局调度器 + 记忆分段条目 + 视觉三层    │
│ ────── 宿主契约（major/minor + capabilities）─────│
└────────────┬────────────────────────────────────┘
             │ AgentDeck = 第一宿主（进程内直连 → 未来可换传输层）
```

抽取原则（红队高危⑧）：先定义 `BoardPort/ModelPort/WindowPort/SecretRef` DTO，专用 preload，**假宿主契约测试通过后才迁移数据**；独立包禁止 import AgentDeck 内部类型。

## 3. 技术选型（2026-09-21 联网查证）

| 项 | 选型 | 版本 | 关键事实与风险 |
|---|---|---|---|
| 渲染 | pixi.js | 8.21.0（npm latest） | 透明窗需 `backgroundAlpha:0`；透明×GPU 合成是 Electron 复发型老 issue（#2170 等），兜底 `app.disableHardwareAcceleration()` |
| 物理 | matter-js | 0.20.0（MIT） | **单 Engine** + 每宠 circle 刚体 + `collisionFilter` 分区；可变 delta 会速度漂移（#332），必须固定步长 `Engine.update(engine, 16.666)` |
| 补间 | GSAP | ≥3.13 | 2025-04 起 100% 免费含商业插件（Webflow 收购后），仅禁「构建竞品动画库」 |
| 粒子 | Pixi v8 原生 `ParticleContainer` | — | `@pixi/particle-emitter@5.x` peer `<8` 不兼容 v8，自写发射器 |
| Live2D | @jannchie/pixi-live2d-display | 1.4.0（peer pixi ^8） | 原版 guansss 库停在 pixi ^6；授权见 D4 |
| 命中 | `IHitArea.contains` + 纹理 alpha 缓存表 | — | 加载后 `renderer.extract` 一次导出 getImageData 缓存；`contains` 收舞台坐标需换算纹理局部坐标；替代现有矩形 hover（消灭 `PetStage` 矩形命中粗糙） |
| 帧率 | `ticker.maxFPS` 30–60 可配 | — | 透明置顶窗每帧强制桌面合成，省电考量 |
| 穿透 | `setIgnoreMouseEvents({forward:true})` | — | **Linux 不支持 forward**（官方文档）；Windows/macOS 按 hover toggle |

性能预算（推断，无权威基准）：纯 spritesheet 宠 10+ 只 + 粒子在集显 60fps 无虞；Live2D 宠安全线 3–5 只（每模型多网格 + CPU 顶点更新）。

## 4. 借用机制实现规格（抄什么、怎么裁）

### 4.1 事件批处理（Cortico WakeBus）
- 抄公式：`at = min(firstAt+maxBatchAge, max(firstAt+minBatchAge, lastAt+quietGap))`，每次 push 重算单定时器（Cortico `src/core/bus.ts:126-132`）。
- 裁剪：只留 `quietGapMs=2500` + `maxBatchAgeMs=15000` 两参数 + 一个「用户正在输入/交互时扣住」布尔闸门；砍 preempt/piggyback/候选/maxBatchSize。
- 落点：`PetController.onTaskChanged` 入口（`src/main/pet/index.ts:196`），在现有 taskStatuses 去重之后、setLife/brain 反应之前加合并窗；勿放 `src/main/index.ts:145` fanout 处（会牵连 goal/issues）。约 +30 行。

### 4.2 前缀缓存友好（Cortico + Alife 的省钱术）
- 重排规格（改 `src/shared/pet-lines.ts:218-228`，拆 MACRO_LINE 为稳定宏行+易变宏行并调序，±25 行）：
  **静稳人设句 → pack_name/model（天级稳定）→ OUTPUT_CONTRACT → memory 段 → 「当前信息」段（time_of_day/board_summary/recent_event）收尾**。
- 定位为**优化而非保障**（红队中危）：OpenAI 自动但要求前缀与设置完全匹配、缓存 token 仍计限流；Anthropic 依赖 `cache_control` + 5m/1h TTL；DeepSeek best-effort 持久化。工具 schema 固定顺序；按各家 usage 字段实测命中率再调。
- 多轮聊天的易变内容放最后一条 user 消息，不进 system。

### 4.3 自主行为阶梯（Alife SystemEvent）
- 抄：`interval = (30s ± 10s) × 3^count`，count 封顶 5（30s→90s→270s→13.5min→40.5min≈2h）；仅 AI 回合空闲时触发（Alife `SystemEventService.cs:121-133,86`）。
- 裁剪改良：Reset 条件从「真实对话」放宽为**任何用户输入（含打断）**；打满后从「只给模型的提示」改为**用户可见的「安静待命」状态**，一聊即满血复活。

### 4.4 宠际互联（Alife VirtualWorld）
- 抄：名字寻址（大小写不敏感查角色表）+ 直灌对方上下文 `[来自 X 的消息]` 前缀 + 防骗/可忽略提示（Alife `VirtualWorldService.cs:42-99`）；每宠历史完全隔离，仅共享花名册注入。
- 补 Alife 缺口：**投递回执 + 离线队列**（原版「对方暂不在」即静默丢信）。

### 4.5 视觉三层（Alife Vision，触发策略改良）
- L0 窗口统计：枚举可见窗口标题 + 前台焦点（Alife `WindowCaptureHelper.cs:151`、`VisionService.cs:184-194`）。**改良：从「AI 想看才截」改为事件驱动**（前台窗口切换/久无操作才触发）。
- L1 OCR：系统级引擎（Windows 原生 OCR 免费）+ 2 倍三次插值上采样提小字识别 + 中文去冗余空格（`VisionService.cs:207-228`）。**OCR 前置分流：有文字走 L1，仅图表/无字才升级 L2**，省本地 GPU。
- L2 VLM：三接入模式照抄（本地 transformers 管道 / OpenAI 兼容 HTTP，Alife `IVisionModel` 三实现）；30s 超时、精简回复长度。
- 隐私（红队高危⑦，全量执行）：观察/截图/上传/写记忆/产生反应**五开关拆分**；默认本地 OCR；上传前裁剪脱敏；常驻指示器 + 全局急停；审计只留来源哈希/范围/provider/时间/删除状态，原图与 OCR 文本加密 + TTL。

### 4.6 记忆分段条目（Alife 分级思想的最小版）
- 单段 800 字 → 条目数组（每条 ≤300 字 + 时间戳），新条目追加不合并截断（解决码点硬截半句问题，`pet-brain.ts:279`）。
- 注入：最近 2 条全注入，更早按关键词命中注入，总预算千字内；量大后再上分级压缩，本地 embedding 留作可选件。
- 元数据（红队中危）：每条带 `petId/source/trust/sensitivity/createdAt/ttl`；检索内容以数据块隔离**不得提升为指令**（防 OCR/宠际内容固化为提示注入）；跨宠共享默认关。

## 5. 安全与权限模型（红队 8 高危逐条决策）

| 红队高危 | 决策 |
|---|---|
| ① 多宠故障隔离 | D6：解析/插件/推理进 Worker/utilityProcess，主进程监督、快照重建；不承诺渲染层单宠隔离 |
| ② LLM 并发风暴 | 新增**全局调度器**：优先级队列「用户对话 > 主动工具 > 事件反应 > 自主发言 > 记忆摘要」+ provider RPM/TPM、每宠配额、取消、合并、冷却、`causationId/maxHop` 防循环反馈（现 `inFlight` 仅单实例闸，`pet-brain.ts:94`） |
| ③ npm 扩展安全 | D2；分发时 `ignore-scripts` + 锁版本/完整性 |
| ④ 开放动作边界 | **语义槽位封闭强类型**（何时用/衔接/进出场），manifest 只做槽位→动作映射；限制文件数/帧数/fps/尺寸/解码字节/GPU 预算/转移可达性；隔离进程解码（现校验只查文件名存在性，`packs.ts:61,84`） |
| ⑤ 宿主工具权限 | D3 + pet 身份、项目范围、配额、幂等键、ETag/CAS、完整审计；queryBoard 默认不返回 prompt/workdir/密钥/日志正文 |
| ⑥ 契约演进 | hello 协商 major/minor 范围 + capabilities；破坏性变更升 major 且**双栈一代**；durable outbox + 序号 + resume token + 事件/副作用幂等（现 sidecar `version===1` 严格模式不适合独立发布，`src/main/sidecar/protocol.ts:92`） |
| ⑦ 视觉隐私 | §4.5 全量执行 |
| ⑧ 抽离层 | §2 抽取原则 |

异步陈旧结果（中危）：每次请求携带 pet generation/配置版本，完成时校验；存储写入 CAS；删宠取消其全部在途请求。

## 6. 阶段 1：AgentDeck 内改动清单（全部可回收，守 D5 铁律）

**A. PetHostContract 缝合**（新 `src/main/pet/host.ts` ~80 行；`src/shared/pet.ts` 类型 +30；`src/main/pet/index.ts` ±40；`src/main/index.ts` ±15）：
- 事件进：`onTaskRunning/onTaskDone/onTaskFailed/onWorkflowMilestone/onBoardSnapshot`，开关位 `{events:{taskRunning,taskDone,taskFailed,workflowMilestone,boardSnapshot}}` 置于 `enabled` 总闸下（开关语义写入审计：关=不上传不记忆不转发）。
- 工具出：`deck.queryBoard`（包 `store.list()`）/ `deck.createTask`（草稿制，复用 `IpcContext.createTask`）/ `deck.annotateTask`（独立通道，落 issueStore）。
- 四处改道：`src/main/index.ts:150`（直调→contract.emit）、`:633`（getBoardSummary→快照注入）、`src/main/pet/index.ts:77`（deps 移交 host）、`:216`（事件反应改由契约流驱动）。

**B. 前缀缓存重排**：§4.2 规格，`pet-lines.ts` ±25、`pet-brain.ts` ±10。

**C. 事件批处理**：§4.1 落点，`pet/index.ts` +30。

**D. 顺手债**：`packs.ts:7` main→renderer 反向依赖解耦（内置包 JSON 移 `shared/`）±10；`docs/features/desktop-pet.md` 三处漂移修复（:31,191 默认值/静默模式不可达；:161,233 缺状态实为整包拒收；:184-195 退避与请求上限描述不符）。

**E. smoke +2**：host 契约（假宿主收发+开关语义）、批处理（合并窗行为）。验收：`npm run typecheck && npm run build && npm run smoke:stage6` + 新 smoke；改侧car/编排无关，不必加专项。

## 7. 路线图

| 阶段 | 内容 | 出口判据 |
|---|---|---|
| 1（AgentDeck 内） | §6 全部 | 三关绿 + 假宿主契约 smoke 通过 |
| 2（独立仓库启动） | 抽包 Port 化（shared 三层 + brain/store/gen）+ **开放动作注册表**（§5④ 边界）+ Pixi 渲染层迁移（§3）+ 对话层升级 | 单宠全功能跑通，AgentDeck 经契约驱动无回归 |
| 3 | 视觉三层 L0→L2（§4.5）+ 数据包生态（npm 分发 ignore-scripts） | 隐私五开关与审计落地 |
| 4 | 共享舞台多宠多模型 + 宠际互联（§4.4）+ 打架编排（规则引擎裁判先行，裁判模型可选） | 双宠互动机理验证 + LLM 调度器配额生效 |

依赖关系：阶段 2 的开放动作表是 PetGen 增量生成新动作与阶段 4 打架动作的前置；单宠体验（阶段 2/3）打磨好之前不开做多宠。

## 8. 风险登记册

| # | 风险 | 缓解 |
|---|---|---|
| R1 | Live2D 授权：年营收过 1000 万日元须付费且提前 ≥1 个月 | 默认序列帧；Live2D 做成可选项并在启用处明示授权条款 |
| R2 | 透明×GPU 合成兼容性（Electron 老病灶） | 兜底 `disableHardwareAcceleration`；平台交互矩阵测试（Win/mac 优先） |
| R3 | Linux 无 `forward`，穿透方案平台差异 | 首版平台范围 Win/mac，Linux 标注实验性 |
| R4 | 前缀缓存三家机制不同、非保障 | 定位优化；usage 实测命中率；不做成本承诺 |
| R5 | 多宠共享 renderer 故障传播 | D6 声明 + Worker 隔离 + 快照重建 |
| R6 | 抽离期 `shared/pet*` 双拷热更错峰漂移（现靠弱校验容错） | 抽离期间 smoke 直连双端各跑一份；独立后消除 |
| R7 | LLM 成本随自主+视觉+多宠叠加 | 全局调度器配额（§5②）+ 阶梯稀疏化（§4.3）+ 缓存优化（§4.2）三层控 |

## 9. 决策确认记录（2026-09-21）

1. **阶段 1 开工**（§6 清单，约 5 个文件 ±250 行 + 2 个 smoke）。
2. 独立项目名字**待定**，阶段 2 启动时再定（不影响阶段 1，契约命名沿用 pet/deck 前缀）。
3. **Live2D 不采用**，按现行帧动画路线推进（D4 已更新）。
