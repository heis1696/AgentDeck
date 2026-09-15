// 扩展模块共享模型：MCP 服务器 / Hooks / 插件盘点 / 扩展源仓库（存放于 AgentDeck 共享目录，
// 可安装到各 agent CLI 的用户级配置），与 skills.ts 的 SkillMeta/SyncState 并列。
import type { SyncState } from './skills'

/** MCP 传输定义：stdio 命令行 或 http/sse 远端（与各 CLI 用户级配置字段一致） */
export type McpTransport =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | { type: 'sse'; url: string; headers?: Record<string, string> }

/** MCP 服务器资产（存于共享目录 mcp/<name>.mcp.json） */
export interface McpDef {
  name: string
  description: string
  transport: McpTransport
}

export interface McpMeta extends McpDef {
  /** 单文件资产：文件所在路径 */
  file: string
  updatedAt: number
}

/** MCP 安装目标（各 CLI 的用户级 MCP 配置位） */
export interface McpTarget {
  id: 'claude' | 'zcode' | 'codex'
  label: string
  hint: string
}

/** Hook 单条动作（v1 仅 command 型，与 Claude Code / ZCode hooks 结构一致） */
export interface HookEntry {
  type: 'command'
  command: string
  timeoutMs?: number
}

/** 同一事件下的匹配组：matcher 省略 = 匹配全部 */
export interface HookGroup {
  matcher?: string
  hooks: HookEntry[]
}

/** Hook 资产（存于共享目录 hooks/<name>/：HOOK.md 说明文档 + hook.json 定义） */
export interface HookDef {
  name: string
  description: string
  /** 事件名（如 PreToolUse/PostToolUse/Stop…）→ 匹配组列表 */
  events: Record<string, HookGroup[]>
}

export interface HookMeta extends HookDef {
  dir: string
  updatedAt: number
}

export interface HookDetail extends HookDef {
  /** HOOK.md 去 frontmatter 后的正文（说明文档，编辑用） */
  body: string
}

/** Hook 安装目标（v1：Claude settings.json 与 ZCode config.json，两者结构同形） */
export interface HookTarget {
  id: 'claude' | 'zcode'
  label: string
  hint: string
}

/** 各 CLI 已安装插件/市场的盘点项（只读清单 + claude 可启停） */
export interface PluginInventoryItem {
  cli: 'claude' | 'zcode' | 'codex'
  kind: 'plugin' | 'marketplace'
  name: string
  /** 插件所属市场（plugin@marketplace） */
  marketplace?: string
  version?: string
  /** 仅 claude：enabledPlugins 中的启停态 */
  enabled?: boolean
  description?: string
  /** 本地缓存/数据目录（可打开） */
  dir?: string
  /** 仅 claude：enabledPlugins 有键但 installed_plugins.json 无对应（卸载残留的幽灵键，UI 标注「未装残留」） */
  installed?: boolean
}

/** 扩展源：git 仓库或本地目录（clone/引用到共享目录 sources/ 下，扫描发现可导入资产） */
export type SourceKind = 'git' | 'local'

export interface ExtSourceMeta {
  id: string
  name: string
  kind: SourceKind
  /** git URL 或本地绝对路径 */
  ref: string
  /** 分类标签（skills/plugins/mcp/index/custom） */
  category: string
  description: string
  addedAt: number
  lastSyncedAt: number | null
}

/** 内置精选目录条目（随应用发布，一键添加为源） */
export interface CatalogEntry {
  id: string
  name: string
  repo: string
  category: 'skills' | 'plugins' | 'mcp' | 'index'
  description: string
}

/** 源仓库扫描出的可发现资产 */
export type DiscoveredKind = 'skill' | 'marketplace' | 'readme'

export interface DiscoveredAsset {
  kind: DiscoveredKind
  name: string
  /** 相对源根的路径（skill=SKILL.md 所在目录，marketplace=marketplace.json 路径，readme=根 README） */
  path: string
  description: string
  /** 已存在于共享技能库的名字（去重提示），仅 skill 型有值 */
  importedAs?: string
  /** marketplace.json 内声明的插件数（json 读失败时省略），仅 marketplace 型有值 */
  pluginCount?: number
}

/** 市场注册结果：把源内发现的 marketplace.json 注册到 Claude/ZCode 的市场表（两侧成败独立） */
export interface MarketplaceRegisterResult {
  /** claude settings.json extraKnownMarketplaces 写入的市场名（失败为 null） */
  claudeName: string | null
  claudeError?: string
  /** zcode known_marketplaces.json 写入的市场 id（失败为 null） */
  zcodeId: string | null
  zcodeError?: string
  /** marketplace.json 内声明的插件数 */
  pluginCount: number
}

/** 两 CLI 已注册市场名清单（注册按钮的已注册态判定） */
export interface MarketplaceStatus {
  /** extraKnownMarketplaces 的键名 */
  claude: string[]
  /** known_marketplaces.json 的 marketplaces[].id */
  zcode: string[]
}

/** 市场插件清单项（marketplace.json 的 plugins[] 宽松读取，字段缺失省略） */
export interface MarketplacePluginInfo {
  name: string
  description?: string
  category?: string
  version?: string
  author?: string
  /** claude 侧已安装（enabledPlugins/installed_plugins 命中 name@marketplace） */
  installed?: boolean
}

/** 插件装卸（claude 官方 CLI 代跑）结果 */
export interface PluginCliResult {
  ok: boolean
  /** CLI stdout/stderr 合并尾部（失败原因展示，≤2000 字符） */
  output: string
}

/** 从 URL 直装技能的结果（clone + 扫描 + 批量导入一步完成） */
export interface SkillsFromUrlResult {
  /** 导入的技能名清单（去重后实际落库的名字） */
  skills: string[]
  /** 来源仓库名（源注册表中的 name） */
  sourceName: string
  /** 源已作为仓库登记（后续可在仓库 tab 同步/移除） */
  sourceId: string
}

/** 已注册市场的插件清单（聚合 AgentDeck 源与 claude/zcode 市场缓存） */
export interface RegisteredMarketplace {
  /** 市场名（marketplace.json 的 name） */
  name: string
  /** 该市场已注册到哪些 CLI */
  clis: Array<'claude' | 'zcode'>
  /** 市场内插件清单（installed 为 claude 侧交叉） */
  plugins: MarketplacePluginInfo[]
}

/** 技能发现分组（技能 tab「发现」区：所有已添加源的技能资产按源聚合） */
export interface SkillDiscoveryGroup {
  source: { id: string; name: string; ref: string; kind: SourceKind }
  skills: DiscoveredAsset[]
}

/** skills.sh 在线技能目录条目（发现区「skills.sh」来源） */
export interface SkillsShEntry {
  /** 技能目录名（安装定位用） */
  skillId: string
  /** GitHub 仓库归属 */
  owner: string
  repo: string
  description?: string
}

/** 各资产安装目标的通用同步状态（与 skills 的 SyncState 同义） */
export type { SyncState }
