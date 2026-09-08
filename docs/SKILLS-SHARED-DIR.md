# 共享目录与技能库（Shared Dir + Skills）设计

> 目标：AgentDeck 拥有自己的共享目录（对标各 agent 工具的 `~/.claude`、`~/.codex`、`~/.zcode`），技能以标准 `SKILL.md` 文件形式存放在其中，并可一键共享（安装）到各 agent CLI 的技能目录——参考 ccswitch 的「集中管理 + 分发同步」模式与 Multica 的 Skills（workspace 级实体、多 agent 复用）。

## 1. 背景与约定

各 CLI 工具的技能目录（用户级，已在本机验证）：

| 工具 | 技能目录 | 格式 |
|---|---|---|
| Claude Code | `~/.claude/skills/<name>/SKILL.md` | YAML frontmatter（name/description）+ Markdown 正文 |
| Codex | `~/.codex/skills/<name>/SKILL.md` | 同上 |
| ZCode | `~/.zcode/skills/<name>/SKILL.md` | 同上（官方配置指南确认；`~/.agents/skills/` 为跨工具共享位） |
| 跨工具中立 | `~/.agents/skills/<name>/SKILL.md` | 同上（ZCode 官方推荐的多工具共享位置） |

四者格式完全一致 → 一份技能文件可多处分发。当前痛点：技能文件散落各工具目录，手工拷贝同步；AgentDeck 的「扩展中心」页面是硬编码假数据。

## 2. 共享目录

- 默认路径：`path.join(app.getPath('home'), '.agentdeck')`（Windows 即 `C:\Users\<user>\.agentdeck`）。
- 可在设置中改为任意目录：`AppSettings.sharedDir: string`（空串 = 默认路径；解析函数集中在主进程，渲染层只读展示解析后的实际路径）。
- 布局（v1 只实现 skills，其余在 README 中预留说明）：

```
~/.agentdeck/
├── README.md            # 首次初始化时生成：目录用途与布局说明
└── skills/
    └── <skill-name>/
        ├── SKILL.md     # 必需：frontmatter + 正文
        └── <附加文件>    # 跟随技能一起安装/导入/导出
```

- 边界：`userData/` 继续存应用状态（任务、设置、队伍）；`~/.agentdeck/` 只存**用户资产**（可手动编辑、可备份、可入库同步）。

## 3. 技能模型与主进程模块

### 3.1 SKILL.md 解析

- frontmatter 用「按行解析」实现（`---` 分隔，`key: value`），不引入 YAML 依赖；支持字段 `name`、`description`。
- 技能名即目录名，校验 `^[a-z0-9][a-z0-9._-]{0,127}$`（与 ZCode plugin 命名一致，兼容各 CLI）。
- 无 frontmatter 的 SKILL.md 也能列出（name 取目录名，description 为空），导入老文件不丢内容。

### 3.2 `src/main/skills.ts`（纯 Node，不 import electron，目录由参数传入——便于 smoke 测试）

```ts
interface SkillMeta { name: string; description: string; dir: string; files: string[]; updatedAt: number; bodyBytes: number }
listSkills(root: string): SkillMeta[]
readSkill(root: string, name: string): { name: string; description: string; body: string; files: string[] }   // body 为去 frontmatter 后正文
saveSkill(root: string, name: string, input: { description: string; body: string; originName?: string }): SkillMeta
  // originName 存在 = 重命名（目录改名）；已存在同名目录且 originName 不同 → 报错
deleteSkill(root: string, name: string): void
importSkill(root: string, source: string): SkillMeta   // source 为目录（含 SKILL.md）或单个 .md 文件；重名自动 -2 后缀
```

写入策略：先写 `SKILL.md.tmp` 再 rename（与 store.ts 的 tmp+rename 一致）；根目录不存在时 `mkdirSync(recursive)` 惰性创建。

### 3.3 `src/main/skill-targets.ts`（安装目标注册表 + 同步状态）

```ts
interface SkillTarget { id: string; label: string; dir: string; hint: string }
resolveSkillTargets(home: string): SkillTarget[]
// 固定四项：claude(~/.claude/skills)、codex(~/.codex/skills)、zcode(~/.zcode/skills)、agents(~/.agents/skills，跨工具共享)

type SyncState = 'in-sync' | 'outdated' | 'missing'
skillSyncState(skillDir: string, targetDir: string, name: string): SyncState
  // 目标 <name>/SKILL.md 与源内容逐字节比较（比较前先做 CRLF→LF 归一，Windows 换行不误报 outdated）
installSkill(root: string, targetId: string, name: string): void    // 整目录拷贝（含附加文件），已存在先删后拷
uninstallSkill(targetId: string, name: string, home: string): void  // 只删 target/<name>/，删除前校验 name 合法
```

安全约束：所有目录参数必须校验在预期根之下（`path.relative` 检查），防止 `name` 带 `..` 逃逸；uninstall 只允许删除形如 `<target>/<合法名>` 的目录。

## 4. IPC 与桥接

`src/main/ipc/skills.ts`（注册进 `register.ts`；输入校验沿用 `ipc-validation.ts` 风格）：

| channel | 入参 | 出参 |
|---|---|---|
| `skills:list` | — | `{ root: string; skills: SkillMeta[] }` |
| `skills:get` | name | `SkillDetail \| null` |
| `skills:save` | name, `{description, body, originName?}` | `SkillMeta` |
| `skills:delete` | name | `{ ok }` |
| `skills:import` | sourcePath（`dialog:pick-dir` 由渲染层先选） | `SkillMeta` |
| `skills:targets` | — | `{ targets: SkillTarget[]; states: Record<name, Record<targetId, SyncState>> }` |
| `skills:install` | name, targetId | `{ ok }` |
| `skills:uninstall` | name, targetId | `{ ok }` |
| `skills:open-dir` | — | 打开共享目录（复用 `shell:open` 逻辑，用 `shell.openPath`） |

- 共享目录解析：`ipc/context.ts` 的 `IpcContext` 增加 `sharedDir: string` getter（settings.sharedDir 非空用之，否则 home 默认），skills IPC 全部经它取路径。
- `shared/types.ts`：`AppSettings` 增加 `sharedDir: string`（`DEFAULT_SETTINGS` 补 `''`）；新增 `SkillMeta`/`SkillTarget`/`SyncState`/`SkillDetail` 类型（或放 `src/shared/skills.ts`，types.ts re-export）。
- `shared/contracts.ts`：`AgentDeckApi` 增加 `skills` 组；`preload/index.ts` 同步实现。
- `settings:set` 的 `parseSettingsPatch` 需接受 `sharedDir`（string，trim）。

## 5. 界面：SkillsView（替换扩展中心假页）

- `src/renderer/src/components/SkillsView.tsx` 新建；`App.tsx`：`View` 中 `market` → `skills`，导航项图标 `Blocks` → `Sparkles`，文案「扩展」→「技能」，Palette 命令同步改；**删除 `MarketView.tsx`**（硬编码假数据页，被真实现取代）。
- 布局（复用 `page-surface`/`page-header-bar`/`market-content` 等既有样式类，新增少量样式进 `styles.css`）：
  - 顶栏：标题「技能」+ 共享目录实际路径（点击=打开目录）+「导入…」（pick-dir → skills:import）+「新建技能」+「全部同步」（对四个目标逐技能 install，跳过 in-sync）。
  - 左列：技能列表（搜索框过滤 name/description；每项显示 name、description 截断、updatedAt；每行小圆点标注同步状态：全绿=全部 in-sync，黄=存在 outdated，灰=未安装到任何目标）。
  - 右侧：详情 = name/description 编辑框 + 正文 `<textarea>`（等宽字体，min-height 320px，可直接写 Markdown）+ 保存；下方「共享目标」区：四个目标 chip（label + 状态色点），点击切换安装/卸载；outdated 显示「重新同步」。
  - 空态：EmptyState 引导「新建技能 / 从目录导入」。
- Settings「存储」区（`StorageSection`）加一张卡：共享目录当前路径 +「更改…」（pickDir → settings.set({sharedDir})）+「打开目录」。更改路径后 SkillsView 需刷新（监听 `settings:updated` 即可，`useSettings` 已有）。

## 6. 测试与文档

- `scripts/smoke-skills.mjs`（纯 node 直跑 skills.ts/skill-targets.ts 的编译产物或直接 import 源码同 smoke-runner 风格）：frontmatter 往返、list/save/rename/delete、import 重名、install→in-sync→改源→outdated→重装→in-sync、uninstall、`..` 逃逸拒绝、CRLF 归一不误报。npm script `smoke:skills`，并加入 `smoke:all` 链。
- 文档：本文件；`ARCHITECTURE.md` 模块地图补 `skills.ts`/`skill-targets.ts`/`ipc/skills.ts` 一行；`CHANGELOG.md` 加版本条目。

## 7. 验收

1. `npm run typecheck` 通过。
2. `npm run smoke:skills` 通过。
3. 首次启动生成 `~/.agentdeck/README.md` 与 `skills/`；技能页可新建/编辑/删除/导入技能，安装到 `~/.claude/skills` 后该目录出现同名文件夹，状态为 in-sync；改动源后目标变 outdated，可一键重同步。
4. 设置中修改共享目录后，技能页立即反映新路径内容。
