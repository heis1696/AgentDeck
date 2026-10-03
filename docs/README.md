# docs/ 文档索引

> 基线：`6b2f038` / v0.22.0-hot.19（2026-09-19 全量审计）→ 2026-09-30 清理：完工施工记录与失效调研**物理删除**（19 篇，git 历史可恢复），现行参考与仍有史料价值的 archive 档案保留。
> 三档判定：**A 仍有效**（就地保留）／**B 过时有史料价值**（在 `archive/`，按写作时点封存）／**C 完工记录或彻底失效**（物理删除，依赖 git 历史）。

---

## 一、现行参考（`docs/`）

| 文档 | 一句话 | 状态 |
|---|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | 架构总览：Issue-first 工作模型、模块地图、关键数据流、可靠性设计、测试基线；§14 为规范机器检查（`check:design` / `check:architecture`）规则与基线还清约定 | A · 头部差异注记（新模块/导航/测试矩阵待补） |
| [API.md](API.md) | 四层接口：IPC 桥全量表格、数据模型、后端适配器接口、委派协议、ZCode 协议要点 | A · 头部差异注记（正文 v0.13.x 基准，桌宠 pet 域未收录，对照表见注记框） |
| [PROMPTS.md](PROMPTS.md) | 提示词系统：模块地图、注入地图、协议标记与解析器契约、术语表、措辞约定、smoke 固化原文、锻造升级规则 | A · 2026-09-29 去歧义重做后写成，改提示词以此为准 |
| [SIDECAR.md](SIDECAR.md) | Business Brain sidecar：独立 Node 进程、loopback RPC 契约与生命周期 | A |
| [EXTENSIONS-HUB.md](EXTENSIONS-HUB.md) | 扩展模块设计：Skills/MCP/Hooks/插件四类资产 + 扩展源仓库 + 插件市场闭环 | A · §8.8（cc-switch 阶段3f）待施工 |
| [UI-DETAIL-FEEDBACK.md](UI-DETAIL-FEEDBACK.md) | UI 细节反馈：§B 为 Settings 控件几何/状态**现行契约**；§A 详情交互、git 快照、窄 Dock 为已落地完工记录 | A · §B 被 `polish/operations.css` 与 browser 冒烟引用钉死 |
| [DESIGN-SYSTEM-V2.md](DESIGN-SYSTEM-V2.md) | v2 视觉规范背景；现行令牌以 `src/renderer/src/tokens.css` 为准 | A · 文头已注明被取代项 |
| [HOT-UPDATE-IMPL-DESIGN.md](HOT-UPDATE-IMPL-DESIGN.md) | 免安装热更机制设计基准：三层（渲染/载荷/壳）指针模型、验签、自愈回退 | A · 0.19–0.21 已全量落地 |
| [HOT-FEED-DEPLOY.md](HOT-FEED-DEPLOY.md) | 热更 feed 运维手册：nginx 部署、两条发版命令、回滚、域名迁移 | A · 现行操作手册 |
| [WORKTREE-BIG-REPO-PERF.md](WORKTREE-BIG-REPO-PERF.md) | 大仓派单性能：建树慢根因档案与 worktree 池化/稀疏检出方案 | A · §1–5 根因仍准；§6–7「下一阶段」已被稀疏检出上线超越 |
| `graph/`（INVENTORY.md · CodeGraph 索引 · README） | 领域图谱：IPC 面调用点/域清单、CodeGraph 语义索引（`npm run graph:index`）及读图指南 | A |

### 功能契约与路线图

| 文档 | 一句话 | 状态 |
|---|---|---|
| [features/desktop-pet.md](features/desktop-pet.md) | 小助理（桌宠）现行功能契约：设置项名、`pet.json` 字段、七态状态名为稳定契约 | A · 0.23.0 上线 |
| [plan/pet-pack-ai-generation.md](plan/pet-pack-ai-generation.md) | 八态素材包 AI 生成配方 | A · 被 `src/main/pet/pet-gen.ts` 按节引用 |
| [plan/desktop-pet-standalone.md](plan/desktop-pet-standalone.md) | 小助理独立窗口/独立仓库/多宠路线图 | B · 阶段 1 已实现，后续阶段未施工 |

---

## 二、archive/ 史料（`docs/archive/`）

> 迁入文档头部均带引注块；此区内容按写作时点封存，不代表现状。

| 文档 | 一句话 | 状态 |
|---|---|---|
| [INSTALLER-FREE-HOT-UPDATE.md](archive/INSTALLER-FREE-HOT-UPDATE.md) | 免安装热更方案讨论稿（三层模型、rename dance、分发形态对比） | B · 被 HOT-UPDATE-IMPL-DESIGN.md 取代并实施；§5 仍被 `src/main/hot/shell.ts` 注释引为设计依据 |

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

1. 新文档默认落本目录并在此登记；施工/调研类写完即处理，不与活文档混放。
2. 处置分两路：**仍有史料价值**的 `git mv` 到 `archive/` + 头部补引注块（写于何时 · 被什么取代 · 现状看哪篇）；**完工记录、失效调研**直接物理删除（git 历史可恢复）。删除/移动后需校验 `docs/`、根 `README.md`、`src/`、`scripts/` 的活引用不断链（`CHANGELOG.md` 为历史日志，允许悬空）。
3. 活文档（ARCHITECTURE / API / SIDECAR 等）改版时更新头部「校验于」行与差异注记，不做结构性重写。
