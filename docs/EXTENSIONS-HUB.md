# 扩展模块（Extensions Hub）设计

> 目标：把「技能」页升级为完整的**扩展模块**——统一管理 Skills / MCP 服务器 / Hooks / 插件四类扩展资产，全部存放于 AgentDeck 共享目录（`~/.agentdeck`，与既有技能库同根），可一键安装到各 agent CLI 的用户级配置；并新增**扩展源仓库**层：内置常用仓库精选目录（一键添加）+ 自定义添加 git/本地仓库，扫描发现可导入资产。设计延续 [SKILLS-SHARED-DIR.md](SKILLS-SHARED-DIR.md)（skills 部分已实现，本文档只做增量）。

## 1. 共享目录布局（增量）

```
~/.agentdeck/
├── README.md            # 已有；描述需补 mcp/hooks/sources 段落（ensureSharedDir 只在新建时写入，存量不覆盖——README 段落补充可省略）
├── skills/              # 已有：技能库
├── mcp/                 # 新增：MCP 服务器定义，每项一个 JSON 文件
│   └── <name>.mcp.json
├── hooks/               # 新增：Hook 资产，每项一个目录
│   └── <name>/
│       ├── HOOK.md      # frontmatter(name/description) + 说明文档正文
│       └── hook.json    # { events: { <Event>: [ { matcher?, hooks: [{type:'command', command, timeoutMs?}] } ] } }
└── sources/             # 新增：扩展源仓库
    ├── sources.json     # 注册表 [{id,name,kind,ref,category,description,addedAt,lastSyncedAt}]
    └── <id>/            # git 仓库 clone（local 源不落目录，直接读 ref 路径）
```

## 2. 各 CLI 用户级配置（本机已核实的准确格式）

| 资产 | Claude Code | ZCode | Codex |
|---|---|---|---|
| MCP | `~/.claude.json` 顶层 `mcpServers`：`{ <name>: {type:'stdio',command,args,env} \| {type:'http',url,headers} }` | `~/.zcode/cli/config.json` 的 `mcp.servers`（**嵌套两级**）；schema 严格：未知键会导致服务器被丢弃，只写 canonical 字段 | `~/.codex/config.toml` 的 `[mcp_servers.<name>]` 块：`command=...`、`args=[...]`、`[mcp_servers.<name>.env]` 子表 |
| Hooks | `~/.claude/settings.json` 顶层 `hooks`：`{ <Event>: [ {matcher?, hooks:[{type:'command',command}]} ] }` | `~/.zcode/cli/config.json` 顶层 `hooks`：`{ enabled, timeoutMs?, events: { <Event>: [同左] } }`——**配置文件 hooks 必须 `enabled:true` 才运行** | 不支持（v1 无 codex hook 目标） |
| Plugins | `~/.claude/settings.json` 的 `enabledPlugins`：`{ 'plugin@marketplace': true/false }`；市场在 `extraKnownMarketplaces` | `~/.zcode/cli/plugins/known_marketplaces.json`（市场注册表）+ `marketplaces/<id>/`（内容）+ `cache/<marketplace>/<plugin>/<version>/` | `~/.codex/plugins/cache/`（目录盘点即可） |

Claude 与 ZCode 的 hooks 事件组结构同形（matcher + hooks 数组），同一份 `hook.json` 可安装到两者；装 zcode 时需额外置 `hooks.enabled = true`。

## 3. 主进程新模块（全部纯 Node、路径参数注入、沿用 skills.ts 的逃逸校验风格）

### 3.1 `src/main/mcp-store.ts`

- `listMcp(root)` / `saveMcp(root, def, originName?)` / `deleteMcp(root, name)` / `readMcp(root, name)`。
- 名字沿用 `SKILL_NAME_PATTERN` 校验；文件 `<name>.mcp.json`，tmp+rename 写入；重命名 = 文件改名；重名报错。
- transport 校验：stdio 必有 `command`（字符串），`args` 字符串数组，`env` 字符串表；http/sse 必有 `url`；**拒绝未知 type 与未知字段**（写入用户配置前把好关）。

### 3.2 `src/main/hook-store.ts`

- `listHooks(root)` / `readHook(root, name)` / `saveHook(root, name, {description, body, events, originName?})` / `deleteHook(root, name)`。
- HOOK.md = `serializeFrontmatter` 同款 frontmatter（name/description）+ body；hook.json = events 定义。目录改名即重命名（同 saveSkill 语义，附加文件跟随）。
- events 校验：事件名为非空字符串（`/^[A-Za-z][A-Za-z0-9_-]*$/`），值为数组，每组 `{matcher?: string, hooks: [{type:'command', command: 非空字符串, timeoutMs?: 正数}]}`，拒绝未知字段。

### 3.3 `src/main/config-editor.ts`（用户配置安全合并器——本模块风险最高的部分）

对 JSON 配置（claude/zcode）统一走：`readJsonSafe(file)`（不存在→`{}`）→ 内存合并 → 写前 `fs.copyFileSync(file, file + '.agentdeck-bak')`（已存在 .bak 不覆盖）→ tmp+rename 写回。**只增删自己的键，其余键原样保留（引用不动的键，不做深合并覆盖）。**

- `installMcpToClaude(home, name, transport)`：`~/.claude.json` → `mcpServers[name] = transport`（剥离 undefined 字段）。
- `installMcpToZcode(home, name, transport)`：`~/.zcode/cli/config.json` → `mcp.servers[name] = transport`（canonical 字段：stdio 写 type/command/args/env/cwd；http 写 type/url/headers；**剥离 timeoutMs 以外的一切未知字段**——schema 严格）。
- `uninstallMcpFromJson(file, getter, name)`：删除后 `mcpServers`/`mcp.servers` 为空对象则保留空对象（不删键，避免惊扰其它工具）。
- `installMcpToCodex(home, name, transport)`：TOML **块级文本操作**——读全文，删除既有 `[mcp_servers.<name>]` 与 `[mcp_servers.<name>.env]` 块（从块头到下一个 `[` 块头或文件尾），再在文件尾追加生成的块：`command = "..."`（字符串引号转义）、`args = ["..."]`、env 逐键 `[mcp_servers.<name>.env]` 子表。stdio 之外的类型跳过并在返回中注明（codex 仅支持 stdio MCP）。写前同样 `.agentdeck-bak` 备份。
- `uninstallMcpFromCodex(home, name)`：同上删除块。
- `installHookToClaude(home, name, events)`：`~/.claude/settings.json` → `hooks` 下逐事件：删除本 hook 已装的组（见卸载判定），append 我们的组。
- `installHookToZcode(home, name, events)`：`~/.zcode/cli/config.json` → `hooks.events` 同形合并 + `hooks.enabled = true`。
- **卸载判定（claude/zcode 同规则）**：组内所有 `hooks[].command` 与我们 hook.json 中的 command 集合完全一致 → 该组由本 hook 安装，删除之；事件数组删空则删除该事件键；zcode 侧 events 删空则删除整个 `hooks` 键。
- 状态判定：`mcpState` / `hookState` 读目标配置与我们定义做**归一化深比较**（undefined 剥离、codex 需把 TOML 块解析回同形对象：块内 key=value、数组、env 子表），相等=in-sync，键存在≠=outdated，无=missing。

### 3.4 `src/main/plugin-inventory.ts`（只读盘点 + claude 启停）

- `pluginInventory(home)`：
  - claude：`settings.json` 的 `enabledPlugins`（`plugin@marketplace` → enabled）逐项输出 `{cli:'claude',kind:'plugin',name,marketplace,enabled}`；`extraKnownMarketplaces` + 固定 `claude-plugins-official` 输出 kind:'marketplace' 项。
  - zcode：`known_marketplaces.json` 输出市场项（pluginCount 入 description）；`cache/<marketplace>/*/<version>` 输出插件项（取最高版本）。
  - codex：`~/.codex/plugins/cache/` 一级子目录输出插件项。
  - 全部 try/catch 容错——任何 CLI 未安装/无配置就跳过该 CLI，不报错。
- `setClaudePluginEnabled(home, name, marketplace, enabled)`：改 `~/.claude/settings.json` 的 `enabledPlugins['name@marketplace']`（走 config-editor 的备份写回）。

### 3.5 `src/main/sources.ts`（扩展源仓库）

- 注册表 `sources/sources.json`（tmp+rename）；id 用 `sanitizeSkillName(name)` + 重名 `-2`。
- `addSource(root, ref, name?)`：`ref` 以 `.git` 结尾或匹配 `https?://` → kind:git；`fs.existsSync` 的目录 → kind:local（不 clone）；否则报错。git 源立即 `git clone --depth 1 <ref> <dir>`（`child_process.spawnSync`，Windows `shell:true`；失败则不落注册表，错误上抛）。name 省略时取 URL 末段/目录名。
- `syncSource(root, id)`：git → `git -C <dir> pull --ff-only`（失败上抛，注册表不动）；local → 仅刷新 lastSyncedAt。
- `removeSource(root, id)`：删注册表项 + git 目录 `rmSync`（local 不删原目录）。
- `browseSource(root, id)`：扫描源根（跳过 `.git`/`node_modules`，深度 ≤6，文件数 ≤20000 防大仓库卡死）：
  - `**/SKILL.md` → `{kind:'skill', name=目录名, path=SKILL.md 所在目录相对路径, description=frontmatter.description}`；已存在于共享技能库 → `importedAs` 填共享库名。
  - `**/.claude-plugin/marketplace.json` → kind:'marketplace'（name 取 json 的 name 字段，description 同）。
  - 根 `README.md` → kind:'readme' 一条（description=首个 `# ` 标题行），作为仓库简介锚点。
- `importSkillFromSource(root, id, relPath)`：relPath 必须落在源根内（assertInside），且该目录含 SKILL.md；复用 `importSkill(root, <源内绝对路径>)`（自动 `-2` 去重），返回 `{name}`。

### 3.6 `src/main/extension-catalog.ts`（内置精选目录——「常用仓库」清单）

```ts
export const EXTENSION_CATALOG: CatalogEntry[] = [
  { id: 'anthropic-skills', name: 'Anthropic 官方 Skills', repo: 'https://github.com/anthropics/skills', category: 'skills', description: '官方 Agent Skills 集：文档处理、创意工件等' },
  { id: 'claude-plugins-official', name: 'Claude 官方插件市场', repo: 'https://github.com/anthropics/claude-plugins-official', category: 'plugins', description: 'Claude Code 官方插件目录（290+ 插件）' },
  { id: 'superpowers', name: 'Superpowers', repo: 'https://github.com/obra/superpowers', category: 'skills', description: '知名技能合集：TDD、头脑风暴、调试方法论等' },
  { id: 'wshobson-agents', name: 'Claude Agents', repo: 'https://github.com/wshobson/agents', category: 'skills', description: '70+ 专业 subagent 提示词集' },
  { id: 'mcp-reference-servers', name: 'MCP 参考服务器', repo: 'https://github.com/modelcontextprotocol/servers', category: 'mcp', description: 'MCP 官方参考服务器源码（Filesystem/SQLite/GitHub 等）' },
  { id: 'awesome-mcp-servers', name: 'Awesome MCP Servers', repo: 'https://github.com/punkpeye/awesome-mcp-servers', category: 'index', description: 'MCP 服务器大全索引' },
  { id: 'awesome-claude-code', name: 'Awesome Claude Code', repo: 'https://github.com/hesreallyhim/awesome-claude-code', category: 'index', description: 'Claude Code 生态资源大全索引' }
]
```

`sources:add-catalog`（见 IPC）= addSource(repo, name)。UI 的「添加源」默认展示该目录一键添加，也接受任意 git URL / 本地路径。

### 3.7 IPC `src/main/ipc/extensions.ts`（channel 名即 preload 已冻结实现，不再列实现）

输入校验沿用 `ipc-validation.ts` + skills IPC 的 record/assertKeys 风格：`mcp:save` 校验 transport 形状（stdio/http/sse 三型、未知字段拒绝）；`hooks:save` 校验 events 形状；`sources:add` 校验 ref 非空字符串；`plugins:set-enabled` 只接受 cli==='claude'；targetId 只接受注册表白名单。所有目标路径由主进程从 `os.homedir()` 推导，渲染层不传路径。

### 3.8 目标注册表

- MCP：`claude`（~/.claude.json）/ `zcode`（~/.zcode/cli/config.json）/ `codex`（~/.codex/config.toml）。
- Hooks：`claude` / `zcode`。

## 4. UI（渲染层，dsh 负责）

- 导航：`App.tsx` 中「技能」→「**扩展**」（view id 保持 `'skills'` 不变，避免大范围改动；图标可沿用 Sparkles 或换 Layers），命令面板同步改文案。
- `ExtensionsView.tsx` 新建：外壳 = `page-surface` + `page-header-bar`（标题「扩展」+ 共享目录路径链接 openDir + 无全局按钮），标题下方 **tab 条**：`技能 | MCP | Hooks | 插件 | 仓库`（tab 态存本地 state，样式可复用/参照 detail 页 TabBar 的 tab 视觉，新增少量 `styles.css` 类）。
- **技能 tab**：现有 `SkillsView.tsx` 的内容重构为 `SkillsTab`（去掉外层 page-surface/page-header-bar，保留左右布局、全部功能不变）——功能零回退。
- **MCP tab**：左列服务器列表（name/description/状态点聚合三目标）+ 右侧编辑器（name、description、type 三选一 stdio/http/sse、对应字段表单：command/args(每行一个)/env(key=value 行)或 url/headers）+ 三个目标 chip（点击安装/卸载，outdated 显示重新同步）。args/env 用 textarea 按行编辑（`args` 每行一项；`env` 每行 `KEY=VALUE`）。
- **Hooks tab**：左列 hook 列表 + 右侧编辑器（name、description、说明文档 textarea、事件编辑器：每个事件一组——事件名输入 + matcher 输入 + command textarea（多条命令每行一个）；提供「添加事件」按钮，预置常用事件 datalist：PreToolUse/PostToolUse/Notification/Stop/UserPromptSubmit）+ claude/zcode 两个目标 chip。
- **插件 tab**：按 CLI 分组（Claude/ZCode/Codex 三节）展示 inventory 列表（name@marketplace、版本、claude 项有启停开关调 `plugins:set-enabled`、每节「打开目录」按钮）；空 CLI 显示「未检测到」。
- **仓库 tab**：上半部「精选目录」网格（EXTENSION_CATALOG：名称、描述、分类徽标、「添加」或「已添加」态）+「自定义源」表单（输入 git URL 或本地路径 → sources:add）；下半部已添加源列表（name、ref 截断、category、lastSyncedAt 相对时间；操作：浏览（展开显示 DiscoveredAsset 列表，skill 型每条「导入到技能库」按钮 → importSkill → toast 成功含去重后名字）、同步、移除）。浏览展开态存组件内 state。
- 全部交互沿用现有 toast/confirmDialog/EmptyState 组件与视觉语言；列表/编辑器布局参照 SkillsTab 的 skills-layout 复用样式类，新类前缀 `ext-`。

## 5. 测试与文档

- `scripts/smoke-extensions.mjs`（纯 Node，目录/家目录全部参数注入临时目录，**不碰真实 ~/.claude 等**；git 用 `git init` 本地 fixture 仓库测 clone/pull 路径，不联网）：
  1. mcp-store：save/list/read/rename/delete、非法 transport 拒绝（未知 type、stdio 缺 command、未知字段）、名字逃逸拒绝。
  2. config-editor JSON：装到假 home 的 claude.json（其它键保留）、zcode 嵌套 mcp.servers、卸载删键保留其它键、.agentdeck-bak 备份生成。
  3. config-editor TOML：codex 块插入（command/args/env 转义）、重装替换不残留、卸载删块、其它 TOML 内容不动、状态判定 in-sync/outdated/missing 往返。
  4. hook-store + hooks 安装：装到 claude/zcode、zcode enabled:true、卸载按 command 集合匹配删除、事件删空清理、用户手工加的其它组保留。
  5. plugin-inventory：假 home 三 CLI 各造一点数据、缺 CLI 容错、claude 启停写回。
  6. sources：local 源 add/browse（fixture 含 2 个 SKILL.md + 1 个 marketplace.json）、importSkill 导入与 -2 去重、git 源用本地 fixture 仓库 add/sync/remove、非法 ref 拒绝、sources.json 注册表往返。
  7. catalog：EXTENSION_CATALOG 至少 5 项、repo 均为 https URL。
- npm scripts：`smoke:extensions` 注册并追加进 `smoke:all` 链尾。
- 文档：本文件；`ARCHITECTURE.md` 模块地图补 5 个新文件一行；`CHANGELOG.md` Unreleased 加「扩展模块」条目（skills 页升级、MCP/Hooks 管理、插件盘点、扩展源仓库与精选目录）。

## 6. 文件所有权（并行施工边界）

- **领队（已完成）**：`src/shared/extensions.ts`、`src/shared/contracts.ts`、`src/preload/index.ts`、本文档。
- **zcode**：`src/main/mcp-store.ts`、`src/main/hook-store.ts`、`src/main/config-editor.ts`、`src/main/plugin-inventory.ts`、`src/main/sources.ts`、`src/main/extension-catalog.ts`、`src/main/ipc/extensions.ts`、`src/main/ipc/register.ts`（注册一行）、`scripts/smoke-extensions.mjs`、`package.json`（scripts 两处）、`docs/ARCHITECTURE.md`、`CHANGELOG.md`。**不得改 src/renderer 与 src/shared 与 src/preload。**
- **dsh**：`src/renderer/src/components/ExtensionsView.tsx`（新）、`SkillsView.tsx`（重构为 SkillsTab）、`App.tsx`（导航文案/引用）、`src/renderer/src/styles.css`（追加 ext- 前缀新类）。**不得改 src/main、src/shared、src/preload、package.json、docs。**

## 7. 验收

1. `npm run typecheck` 通过。
2. `npm run smoke:extensions` 与 `npm run smoke:skills` 通过（技能功能零回退）。
3. UI：扩展页五 tab 可用；MCP 新建 stdio 服务器 → 安装到 claude/zcode 后对应配置文件出现该键且其它键原样；卸载后键消失、`.agentdeck-bak` 备份存在；hook 安装后 zcode `hooks.enabled` 为 true。
4. 仓库 tab：从精选目录添加 anthropics/skills → 浏览发现其中技能 → 一键导入技能库 → 技能 tab 可见并可照常同步到各 CLI。
5. 自定义添加本地目录源可用；移除源不删本地目录内容。

## 8. 插件市场闭环（阶段3 增量）

> 目标：仓库 tab 发现的 `marketplace.json` 资产可**一键注册**为 Claude / ZCode 插件市场；插件 tab 从只读盘点升级为可**安装/卸载**（claude 侧）。本机已核实的事实基础：claude 官方 CLI 有 `plugin install/uninstall <plugin@marketplace>`；`~/.claude/settings.json` 的 `extraKnownMarketplaces` 为声明式配置（`{ <name>: { source: { repo: 'owner/repo', source: 'github' } } }`）；ZCode 市场注册表 `~/.zcode/cli/plugins/known_marketplaces.json` 条目形状 `{ id, source: {source:'github', repo}, name, description, addedAt, pluginCount, lastUpdated?, cacheTransactionId? }`（后两个由 ZCode CLI 维护，我方不写）；marketplace.json 结构 `{ name, description, owner, plugins: [{ name, description, ... }] }`。

### 8.1 主进程

- `config-editor.ts` 新增：
  - `registerMarketplaceToClaude(home, name, repo)`：settings.json → `extraKnownMarketplaces[name] = { source: { repo, source: 'github' } }`，走既有备份写回；键已存在 = alreadyRegistered（幂等成功，不覆盖）。
  - `registerMarketplaceToZcode(home, id, meta)`：known_marketplaces.json → marketplaces 数组 append `{ id, source: { source: 'github', repo }, name, description, addedAt: ISO, pluginCount }`（不写 lastUpdated/cacheTransactionId）；同 id 已存在 = alreadyRegistered。该文件虽由 ZCode CLI 维护，但格式为纯 JSON 数组表，append 安全；CLI 下次同步会补齐自己的字段。
  - 两函数的 repo 参数均要求 `owner/repo` 形式（github）；非 github 的 git 源与 local 源返回明确错误（claude/zcode 市场仅支持 github 仓库源）。
- `plugin-inventory.ts` 新增 `marketplaceStatus(home)`：`{ claude: string[]（extraKnownMarketplaces 键）, zcode: string[]（known_marketplaces.json 的 id） }`。
- 新模块 `src/main/plugin-cli.ts`：`installClaudePlugin(home, spec)` / `uninstallClaudePlugin(home, spec)`——spawn claude CLI 的 `plugin install/uninstall`，**CLI 解析与 spawn 方式复用 `src/main/backends/claude.ts` 既有基建**（Windows .js 入口 / ELECTRON_RUN_AS_NODE 的坑已在 0.14.1 修过）；60s 超时；返回 `{ ok, output }`（stdout+stderr 尾部 ≤2000 字符）。spec 校验 `/^[\w.-]+@[\w.-]+$/`。
- `sources.ts` browse：marketplace 资产读 json 填 `pluginCount`（plugins 数组长度；读失败省略）。
- IPC 新 channel：`marketplaces:status` / `marketplaces:register(sourceId, assetPath)`（assetPath 必须 assertInside 源根且为 marketplace.json；注册名取 json 的 name，claude 与 zcode 各自成败独立返回）/ `plugins:install` / `plugins:uninstall`（入参 `{ cli:'claude'; spec }`，cli 白名单）。
- smoke 增量（不碰真实 home、不 spawn 真 claude）：假 home 市场注册（claude 键出现/其它键原样/zcode append/alreadyRegistered 幂等/非 github 源拒绝/pluginCount 解析/spec 与 assetPath 校验拒绝）。

### 8.2 UI（渲染层）

- 仓库 tab 浏览视图：marketplace 资产行显示 `pluginCount` 徽标 + 「注册市场」按钮（→ marketplaces.register；toast 汇报 claude/zcode 各自结果）；`marketplaces:status` 命中已注册 → 「已注册」态 + 可重复注册（幂等）。
- 插件 tab claude 节：顶部「安装插件」行（input 占位 `plugin@marketplace`，datalist = 已注册市场名；→ plugins.install，成功刷新 inventory）；claude 插件行加「卸载」按钮（confirmDialog 危险确认 → plugins.uninstall(name@marketplace) → 刷新）。zcode/codex 节维持盘点不变。

### 8.3 验收

1. typecheck + smoke:extensions/skills/ipc-validation 全绿。
2. 真实环境 GUI 走查：仓库 tab 添加「Claude 官方插件市场」源 → 浏览出 marketplace.json（291 插件计数）→ 注册 → `~/.claude/settings.json` 出现 extraKnownMarketplaces 键、`~/.zcode/cli/plugins/known_marketplaces.json` 出现该 id 且其它条目原样 → 插件 tab 安装一个未装插件 → enabledPlugins/目录出现 → 卸载 → 消失。
3. 技能/MCP/Hooks 既有功能零回退。

### 8.4 浏览增强：看得见、筛得了、逐项装（阶段3b）

> 用户主诉：仓库 tab「只导入进来，看不到有哪些东西，不能选择安装，不能筛选」。补齐浏览体验闭环——市场插件清单直接在浏览视图展开（搜索/分类筛选/逐项安装），技能资产搜索 + 批量导入。

- 主进程 `sources.ts` 新增 `listMarketplacePlugins(root, sourceId, assetPath)`：assertInside + marketplace.json 校验（复用 readMarketplaceAsset），读 `plugins[]` 宽松映射 `MarketplacePluginInfo`（name 必填，description/category/version/author 字符串缺失省略），`installed` 与 claude 侧 `~/.claude/plugins/installed_plugins.json` + `enabledPlugins` 交叉（`name@<marketplace json 的 name>` 命中即 true）。
- IPC `marketplaces:list-plugins`（校验同 register）。
- smoke：fixture marketplace.json 含 3 插件（含分类/无分类各一）→ listPlugins 映射正确；installed 交叉（种 installed_plugins 命中一项）；assetPath 逃逸拒绝。
- UI 仓库 tab 浏览展开态：
  - 资产面板顶部工具条：搜索框（name/description 前端 filter）+ kind 筛选（全部/技能/市场）+ 资产计数。
  - marketplace 资产行「插件清单」展开按钮 → 调 listPlugins 渲染插件列表（name + category 徽标 + description 截断 + author/version 小字）：顶部独立搜索框 + 分类下拉（distinct）；每项 claude 安装按钮（`plugins.install({cli:'claude', spec: name@市场名})`，成功后该项转「已安装」态），installed 项显示「已安装」徽标。
  - skill 资产多源批量：「全部导入」按钮 → 循环 `sources.importSkill`（已导入的跳过），聚合 toast（导入 N 个 / 跳过 M 个 / 失败列表）。
- 验收：typecheck + smoke 绿；真机浏览官方插件市场源 → 插件清单 296 项可搜索可筛选 → 搜索定位一个插件 → 安装成功徽标翻转 → 卸载还原。


### 8.5 从 URL 一键安装（阶段3c）

> 用户诉求：「能不能加从 git 安装（网址安装）」。设计：把 添加源→浏览→导入 三步压缩为粘贴 URL 一步——`sources:quick-add` = addSource + browseSource 组合（主进程几行编排，clone/校验/扫描全复用既有管线），UI 收到结果后自动展开该源的资产面板（浏览工具条/插件清单/全部导入全部就绪）。

- 主进程 `sources.ts` 新增 `quickAddSource(root, ref, name?)`：调 addSource 成功后立即 browseSource，返回 `{ source, assets }`；任一步失败按原错误上抛（addSource 的 clone 失败不落注册表语义不变）。
- IPC `sources:quick-add`（校验同 `sources:add`）。
- smoke：本地 fixture git 仓库 quickAdd 返回源与资产；非法 ref 拒绝。
- UI：「自定义源」区输入框旁新增主按钮「从 URL 安装」（或回车触发 quickAdd）：成功后刷新列表、`browsingId` 置为新源、assets 预填充 → 面板展开直接可导可装；toast 摘要（「发现 N 技能 / M 市场」）。
- 验收：typecheck + smoke 绿；真机粘贴 github URL → 面板自动展开 → 全部导入可用。

### 8.6 按资产维度重排安装入口（阶段3d）

> 用户反馈（IA 层）：仓库应是源管理层，安装动作应发生在对应资产 tab（按目的找入口）；从 URL 装技能不该先去仓库页；插件 tab 定位不清。重构三点：技能 tab 直装、插件 tab 市场浏览、仓库 tab 收窄为源管理。

- **技能 tab**：顶部工具区加「从 URL 安装技能」入口（输入 git URL → `skills:install-from-url`：主进程 quickAddSource + 对 skill 型资产循环 importSkillFromSource，返回 `{ skills: 实际落库名[], sourceName, sourceId }`）；toast「从 <repo> 导入 N 个技能」；源照常登记（仓库 tab 可管理）。既有本地导入按钮保留。
- **插件 tab**：claude 节「安装插件」行旁加「浏览市场」展开区（`marketplaces:list-registered` 聚合：AgentDeck 源内 marketplace.json + claude `~/.claude/plugins/marketplaces/*/`（或 `~/.claude/plugins/marketplaces/<name>/marketplace.json`）+ zcode `~/.zcode/cli/plugins/marketplaces/<id>/marketplace.json`，读失败容错跳过）；按市场分组渲染（复用 §8.4 的 MarketplacePluginList 视觉：搜索/分类/安装/已装徽标）；页面描述改为「各 agent CLI 已安装插件的盘点与装卸；浏览市场安装新插件」。
- **仓库 tab**：文案定位改为「扩展源仓库管理」（精选目录/自定义源/同步/移除/浏览检查），现有浏览与导入能力保留（一个仓库啥都有时可集中处理）。
- 主进程：`src/main/sources.ts` 加 `installSkillsFromUrl(root, ref)`（编排 quickAddSource + importSkillFromSource 循环，importedAs 已存在的跳过）；`plugin-inventory.ts` 加 `registeredMarketplaces(root, home)`（三来源聚合去重，市场名为键，clis 取并集，plugins 读 marketplace.json + installed 交叉）。IPC：`skills:install-from-url` / `marketplaces:list-registered`（校验同族 channel）。
- smoke：install-from-url（fixture git 仓库 → 2 技能导入 + 已存在跳过 + 非法 ref 拒绝）；list-registered（假 home 种 claude/zcode 市场缓存 + AgentDeck 源市场 → 聚合/去重/clis 并集/读失败容错）。
- 验收：typecheck + smoke 绿；真机：技能 tab 粘 URL 直装、插件 tab 浏览市场装一个插件、仓库 tab 文案与定位。

### 8.7 交互模型对齐 ZCode/VS Code（阶段3e，范本重排）

> 用户反馈与范本：抄 ZCode 客户端自己的模型（本机 zcode-configuration-guide 文档核实）——Settings → Plugin Management 为 **Installed / Discover 两段式**，添加市场的「+」就在 Discover 页内（GitHub 仓库/Git URL/本地目录）；技能/MCP/子代理各有独立设置页；**没有独立"仓库"页，源是 Discover 的数据层**（与 VS Code 扩展面板同构）。

- **tab 条砍成 4 个**：`技能 | MCP | Hooks | 插件`（仓库 tab 移除，ExtTabId 删 'sources'）。
- **技能 tab**：顶部折叠「发现技能」区（默认收起，badge 显示可导数）：内含 URL 直装行（§8.6 已有）+ 各源技能聚合（新 `sources:list-skills` 按源分组：源名/同步时间/技能资产列表 + 搜索 + 单导 + 按源「全部导入」；importedAs 已导入徽标）。
- **插件 tab**：Discover 区（§8.6 市场浏览）顶部加「+ 添加市场」折叠块：精选目录网格（EXTENSION_CATALOG）+ 自定义源表单（URL/本地路径，quickAdd 语义）+ 已添加源列表（同步/移除/同步时间）——整体从原 SourcesTab 迁移复用。
- **MCP/Hooks tab**：不动。
- 主进程：`sources.ts` 加 `listSkillGroups(root)`（对注册表逐源 browseSource，只取 skill 型资产；单源扫描失败容错跳过并在组内体现为空）；IPC `sources:list-skills`（无参）。
- smoke：list-skills（两源 fixture → 分组/失败容错/空源省略）。
- 验收：typecheck（runner.ts 并行半成品除外）+ smoke 绿；真机：4 tab、技能页发现区 URL 直装与聚合导入、插件页「+ 添加市场」→ 浏览 → 安装、旧仓库能力无丢失。

### 8.8 交互照抄 cc-switch（阶段3f）

> 用户指令：「翻那个 ccswitch，照抄算了」。已 clone farion1231/cc-switch 逆向调研（TEMP/cc-switch-research）：其 Skills 模型 = 已装列表每行尾部一排 App 图标开关（AppToggleGroup，点亮=分发该 app，暗=未分发）+ 发现页独立卡片网格（SkillCard：名称 + owner/repo 徽标 + 描述 + 「查看」README 外链 + 一键安装/已装徽标）+ 双搜索源（我的仓库 | skills.sh 在线公共目录，API `GET https://skills.sh/api/search?q&limit&offset`）+ 仓库管理面板（URL 解析 owner/name）。照抄三点，其余（软链接分发/更新检查/ZIP/托盘）后置。

- **A. CLI 图标开关组**（技能/MCP/Hooks 已装行尾部）：每行一排目标图标按钮（技能=claude/zcode/codex/跨工具共享 4 个，MCP=3 个，Hooks=claude/zcode 2 个）；状态映射 in-sync=点亮、missing=35% 暗淡、outdated=半亮+刷新角标；点击即 install/uninstall（复用 skills/mcp/hooks:install/uninstall IPC，语义不变）。行尾原聚合状态点删除（信息被开关组覆盖）；详情编辑器的目标 chip 保留。
- **B. 发现区卡片网格**（SkillDiscoverPanel 聚合视图改卡片）：每卡=技能名 + 源徽标（owner/repo 或源名）+ 描述（3 行截断）+「查看」（skills:open-external 打开 GitHub README/仓库页）+「导入」/「已导入」徽标。
- **C. skills.sh 在线搜索**（发现区来源切换「我的源 | skills.sh」）：主进程 `searchOnlineSkills(query, limit, offset)` fetch skills.sh API（10s 超时，离线/失败返回空不报错）；`installOnlineSkill(entry)` clone `https://github.com/<owner>/<repo>` --depth 1 到临时目录 → 定位 `<skillId>/SKILL.md`（或 `skills/<skillId>/SKILL.md`）→ 复用 importSkill 导入 → 清理临时目录；`skills:open-external`（shell.openExternal，仅 https 白名单校验）。
- smoke：searchOnline 用注入 fetch stub 测解析/超时容错；installOnline 用参数注入的本地 fixture git 仓库（repoUrl 前缀可注入）测定位/导入/清理/找不到 skillId 报错；openExternal 校验拒绝非 https。
- 验收：typecheck + smoke 绿；真机：技能行开关组点亮/熄灭真实写各 CLI 配置、发现区卡片网格+查看外链、skills.sh 搜到真技能并一键安装成功。
