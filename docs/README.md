# docs/ 文档索引

> 基线：`6b2f038` / v0.22.0-hot.19（2026-09-19 全量审计：docs/ 32 篇 md → **现行参考 9 篇 + archive 史料 23 篇**，图片 6 张随档案迁入）。
> 三档判定：**A 仍有效**（就地保留，头部有「校验于」行）／**B 过时有史料价值**（移入 `archive/`，头部有引注块：写于何时 · 被什么取代 · 现状看哪篇）／**C 彻底失效或误导**（本仓审计未发现，空档）。本仓库一律不物理删除文档。

---

## 一、现行参考（`docs/`）

| 文档 | 一句话 | 状态 |
|---|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | 架构总览：Issue-first 工作模型、模块地图、关键数据流、可靠性设计、测试基线 | A · 头部差异注记（新模块/导航/测试矩阵待补） |
| [API.md](API.md) | 四层接口：IPC 桥全量表格、数据模型、后端适配器接口、委派协议、ZCode 协议要点 | A · 头部差异注记（正文 v0.13.x 基准，70 调用点未收录，对照表见注记框） |
| [VALIDATION.md](VALIDATION.md) | 阶段 0–8 重构验证记录（typecheck/smoke/dist 逐阶段留痕） | A · 历史验证快照，现行回归以 `smoke:all`（46 套件）为准 |
| [SIDECAR.md](SIDECAR.md) | Business Brain sidecar：独立 Node 进程、loopback RPC 契约与生命周期 | A |
| [SKILLS-SHARED-DIR.md](SKILLS-SHARED-DIR.md) | 共享目录（`~/.agentdeck`）与技能库设计：SKILL.md 模型、安装目标与同步状态 | A |
| [EXTENSIONS-HUB.md](EXTENSIONS-HUB.md) | 扩展模块设计：Skills/MCP/Hooks/插件四类资产 + 扩展源仓库 + 插件市场闭环 | A |
| [DESIGN-SYSTEM-V2.md](DESIGN-SYSTEM-V2.md) | 现行视觉规范：令牌系统、组件规格、交互态总规范（§5 重组方案已执行完） | A |
| [HOT-UPDATE-IMPL-DESIGN.md](HOT-UPDATE-IMPL-DESIGN.md) | 免安装热更机制设计基准：三层（渲染/载荷/壳）指针模型、验签、自愈回退 | A · 0.19–0.21 已全量落地 |
| [HOT-FEED-DEPLOY.md](HOT-FEED-DEPLOY.md) | 热更 feed 运维手册：nginx 部署、两条发版命令、回滚、域名迁移 | A · 现行操作手册 |
| `graph/`（INVENTORY.md · deps.json · README） | 领域图谱：IPC 面 141 调用点/20 域清单、模块依赖图及读图指南 | 随并行工作合入本目录后即为现行参考 |

---

## 二、archive/ 史料（`docs/archive/`）

> 迁入文档头部均带引注块；此区内容按写作时点封存，不代表现状。

### 施工方案与设计定稿

| 文档 | 一句话 | 状态 |
|---|---|---|
| [CONSTRUCTION-PLAN.md](archive/CONSTRUCTION-PLAN.md) | 0.14–0.18 架构重构施工方案（事件日志/投影/编排/IPC 契约分阶段拆分） | B · 阶段 0–8 全部实施完成 |
| [ORCHESTRATION-GOAL-CONSTRUCTION.md](archive/ORCHESTRATION-GOAL-CONSTRUCTION.md) | 编排与目标模式施工总册：不变量、风险台账、阶段闸门 | B · 主要阶段已分批落地 |
| [TEAM-MEETING-CONSTRUCTION.md](archive/TEAM-MEETING-CONSTRUCTION.md) | 结构化会议模式施工方案（确定性主持人、回合制、收敛门） | B · 0.16.0 落地后三轮实战返工 |
| [GOAL-AUTOPILOT-REDESIGN.md](archive/GOAL-AUTOPILOT-REDESIGN.md) | 目标模式 v2 重设计：Issue 内 Goal-based loop + maker/checker 审核 | B · 0.15.0 落地，语义看 ARCHITECTURE §7.1 |
| [AGENT-PROFILES-PLAN.md](archive/AGENT-PROFILES-PLAN.md) | Agent 管理提级 + 同平台多队员各钉模型施工方案 | B · 已实施 |
| [INSTALLER-FREE-HOT-UPDATE.md](archive/INSTALLER-FREE-HOT-UPDATE.md) | 免安装热更方案讨论稿（三层模型、rename dance、分发形态对比） | B · 被 HOT-UPDATE-IMPL-DESIGN.md 取代并实施 |

### 调研与选型

| 文档 | 一句话 | 状态 |
|---|---|---|
| [LOOP-ENGINEERING.md](archive/LOOP-ENGINEERING.md) | Loop Engineering 方法论综述 + 六项目拆解计划 + 12 条行动清单 | B · 拆解已完成，行动项陆续落地 |
| [AGENT-GENERATION-RESEARCH.md](archive/AGENT-GENERATION-RESEARCH.md) | 「描述生成 Agent 定义」生态调研（subagent 文件格式、元提示词、评测回路） | B · 结论由锻造师（0.19–0.20）实施 |
| [HOT-UPDATE-COMPARISON.md](archive/HOT-UPDATE-COMPARISON.md) | 热更三路线对比（electron-updater / 渲染层热更 / 混合），结论选混合分阶段 | B · 选型已按后续方案实施 |
| [DESIGN-LANGUAGE.md](archive/DESIGN-LANGUAGE.md) | 0.12 界面宪法（源自 Multica 拆解：表面分层、页面骨架、签名布局、操作模型） | B · 整改清单已完成，视觉规范由 DESIGN-SYSTEM-V2.md 承接 |

### 外部项目拆解（`teardown/`，2026-09-09/10，均为 B 档调研快照）

| 文档 | 拆解对象 |
|---|---|
| [LEARN-CLAUDE-CODE-TEARDOWN.md](archive/teardown/LEARN-CLAUDE-CODE-TEARDOWN.md) | learn-claude-code（Loop 1 教学实现，s01–s17） |
| [CC-HAHA-TEARDOWN.md](archive/teardown/CC-HAHA-TEARDOWN.md) | cc-haha（Electron+Bun sidecar 桌面同类） |
| [RUFLO-TEARDOWN.md](archive/teardown/RUFLO-TEARDOWN.md) | ruflo/claude-flow（多后端 meta-harness，swarm 未接线实证） |
| [DEER-FLOW-TEARDOWN.md](archive/teardown/DEER-FLOW-TEARDOWN.md) | deer-flow（长时程 SuperAgent、goal 熔断） |
| [OPENCODE-TEARDOWN.md](archive/teardown/OPENCODE-TEARDOWN.md) | opencode（agentdeck 上游协议；server 适配已落地 API.md §6） |
| [OUROBOROS-TEARDOWN.md](archive/teardown/OUROBOROS-TEARDOWN.md) | ouroboros（Loop 4 自我改进样本） |
| [MULTI-AGENT-MEETING-TEARDOWN.md](archive/teardown/MULTI-AGENT-MEETING-TEARDOWN.md) | 多 agent 会议/圆桌系统专项轮（会议模式外部参照） |

### 报告（`reports/`，均为 B 档一次性产物）

| 文档 | 一句话 | 状态 |
|---|---|---|
| [AGENTDECK-ANALYSIS.md](archive/reports/AGENTDECK-ANALYSIS.md) | v0.3.0 封板 demo 的全量源码分析（健康基线 + 问题清单） | B · 对象已落后 30+ 个版本 |
| [ARCHITECTURE-REVIEW.md](archive/reports/ARCHITECTURE-REVIEW.md) | 2026-09-09 执行管线全局体检 | B · 多数发现已修复 |
| [CONCURRENCY-HOTFIX-REPORT.md](archive/reports/CONCURRENCY-HOTFIX-REPORT.md) | 2026-09-08 并发缺陷临时止血报告 | B · 已被阶段 8 正式收口取代 |
| [MULTICA-PROMPTS.md](archive/reports/MULTICA-PROMPTS.md) | Multica 提示词源码级拆解（0.15.0 委派协议升级依据） | B · 长期参考 |
| [MULTICA-TEARDOWN.md](archive/reports/MULTICA-TEARDOWN.md) | Multica 功能与界面拆解（设计语言素材源） | B · 长期参考 |
| [ZCODE-UI-STUDY.md](archive/reports/ZCODE-UI-STUDY.md) | ZCode 桌面端 UI 取证（截图见 `images/`） | B · 长期参考 |

### 图片（`images/`）

6 张 ZCode 桌面端截图，仅被 `archive/reports/ZCODE-UI-STUDY.md` 与 `archive/reports/MULTICA-TEARDOWN.md` 以 `../images/` 相对引用，随引用方一并迁入本目录，相对链接不断。

---

## 维护约定

1. 新文档默认落本目录并在此登记；施工/调研类写完即归档，不与活文档混放。
2. 归档 = `git mv` 到 `archive/` + 头部补引注块（写于何时 · 被什么取代 · 现状看哪篇），**一律不物理删除**；移动后需全量校验 `docs/`、`README.md`、`CHANGELOG.md` 的内部引用不断链。
3. 活文档（ARCHITECTURE / API / VALIDATION / SIDECAR 等）改版时更新头部「校验于」行与差异注记，不做结构性重写。
