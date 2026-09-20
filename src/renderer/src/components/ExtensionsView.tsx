import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  CloudDownload,
  FolderGit2,
  FolderOpen,
  Globe,
  Layers,
  LoaderCircle,
  Package,
  Plus,
  Puzzle,
  RefreshCw,
  Search,
  Server,
  Sparkles,
  Store,
  Trash2,
  Webhook,
  type LucideIcon
} from 'lucide-react'
import { bridge, useSettings } from '../api'
import { ui, isComposingKey } from '../ui/interaction-center'
import { EmptyState } from '../ui/EmptyState'
import { PageHeader } from '../ui/PageHeader'
import { SkillsTab, StaleBanner } from './SkillsView'
import type {
  CatalogEntry,
  DiscoveredAsset,
  ExtSourceMeta,
  HookDetail,
  HookGroup,
  HookMeta,
  HookTarget,
  MarketplacePluginInfo,
  MarketplaceStatus,
  McpMeta,
  McpTarget,
  McpTransport,
  PluginInventoryItem,
  RegisteredMarketplace,
  SkillDiscoveryGroup,
  SyncState
} from '../../../shared/extensions'

type TargetStates = Record<string, Record<string, SyncState>>
type ExtTabId = 'skills' | 'mcp' | 'hooks' | 'plugins'

const TABS: Array<{ id: ExtTabId; label: string; icon: LucideIcon }> = [
  { id: 'skills', label: '技能', icon: Sparkles },
  { id: 'mcp', label: 'MCP', icon: Server },
  { id: 'hooks', label: 'Hooks', icon: Webhook },
  { id: 'plugins', label: '插件', icon: Puzzle }
]

/** 常用 hook 事件（事件名输入框的 datalist 预置项） */
const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'UserPromptSubmit']
/** 扩展源分类标签 */
const CATEGORY_LABELS: Record<string, string> = { skills: '技能', plugins: '插件', mcp: 'MCP', index: '索引', custom: '自定义' }
/** 源仓库扫描出的资产类型标签 */
const ASSET_KIND_LABELS: Record<DiscoveredAsset['kind'], string> = { skill: '技能', marketplace: '市场', readme: '说明' }
/** 浏览资产面板的 kind 筛选档位（说明类资产只在「全部」下可见） */
const ASSET_KIND_FILTERS: Array<{ id: 'all' | 'skill' | 'marketplace'; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'skill', label: '技能' },
  { id: 'marketplace', label: '市场' }
]
const CLI_LABELS: Record<PluginInventoryItem['cli'], string> = { claude: 'Claude Code', zcode: 'ZCode', codex: 'Codex' }
const CLI_ORDER: PluginInventoryItem['cli'][] = ['claude', 'zcode', 'codex']
/** 插件 tab 页面 / 空态描述（EXTENSIONS-HUB §8.6 定位：盘点装卸 + 市场浏览） */
const PLUGINS_DESC = '各 agent CLI 已安装插件的盘点与装卸；浏览市场安装新插件。'
/** 选中的 tab 跨普通导航保留（离开扩展页再回来不重置）；与 workspace-dir 等一样走 localStorage */
const EXT_TAB_KEY = 'agentdeck:extensions-tab'
const EXT_TAB_IDS = TABS.map((item) => item.id)

function readStoredTab(): ExtTabId {
  try {
    const saved = localStorage.getItem(EXT_TAB_KEY)
    return EXT_TAB_IDS.includes(saved as ExtTabId) ? saved as ExtTabId : 'skills'
  } catch {
    return 'skills'
  }
}

/** 扩展页：技能 / MCP / Hooks / 插件四 tab 的外壳（标题 + 共享目录链接 + tab 条）。
 *  EXTENSIONS-HUB §8.7：无独立仓库 tab——发现与已装同页，扩展源是发现区（技能 tab / 插件 tab）的数据层。 */
export function ExtensionsView() {
  const { settings } = useSettings()
  const [tab, setTab] = useState<ExtTabId>(readStoredTab)
  const [root, setRoot] = useState('')

  // 共享目录解析路径（空设置时主进程回落到 ~/.agentdeck）
  useEffect(() => {
    let alive = true
    void bridge.skills.list().then((data) => { if (alive) setRoot(data.root) }).catch(() => {})
    return () => { alive = false }
  }, [settings?.sharedDir])

  /** 选中即记忆：普通导航（切走再切回）不重置到技能 tab，应用重启后也保持一致 */
  const selectTab = (next: ExtTabId) => {
    setTab(next)
    try {
      localStorage.setItem(EXT_TAB_KEY, next)
    } catch {
      /* 存储不可用（隐私模式 / 配额）时只在本次会话内保留 */
    }
  }

  return <div className="skills-view page-surface ext-view">
    {/* 共享目录路径是页头里的上下文/动作项，不再另起一套页头布局 */}
    <PageHeader
      title="扩展"
      icon={<Layers size={16} />}
      metadata={<button className="skills-root-link" onClick={() => void bridge.skills.openDir()} title="打开共享目录">
        <FolderOpen size={13} /><span>{root || settings?.sharedDir || '…'}</span>
      </button>}
    />
    <div className="ext-tabs" role="tablist" aria-label="扩展分类">
      {TABS.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={tab === item.id}
          className={`ext-tab ${tab === item.id ? 'active' : ''}`}
          onClick={() => selectTab(item.id)}
        >
          <item.icon size={14} />
          <span>{item.label}</span>
        </button>
      ))}
    </div>
    <div className="page-content market-content ext-content">
      {tab === 'skills' ? <SkillsTabWithUrlInstall />
        : tab === 'mcp' ? <McpTab />
          : tab === 'hooks' ? <HooksTab />
            : <PluginsTab />}
    </div>
  </div>
}

/* ============================== 技能 tab ============================== */

/**
 * 技能 tab（EXTENSIONS-HUB §8.7）：技能库之上叠加折叠「发现技能」区——URL 直装（§8.6）+
 * 各扩展源技能资产聚合（sources:list-skills 按源分组，搜索 / 单导 / 按源全部导入）。
 * SkillsTab 本体在 SkillsView.tsx（本轮不改其文件），故导入成功后用 key 重挂载刷新技能列表。
 */
function SkillsTabWithUrlInstall() {
  const [refreshKey, setRefreshKey] = useState(0)
  const refreshLibrary = useCallback(() => setRefreshKey((key) => key + 1), [])

  return <>
    <SkillDiscoverPanel onLibraryChanged={refreshLibrary} />
    <SkillsTab key={refreshKey} />
  </>
}

/**
 * 「发现技能」折叠区（默认收起、标题带可导计数 badge）：URL 直装行 + 各源技能聚合。
 * 交互参照原仓库 tab 浏览区迁移：全局搜索、单条「导入」、「全部导入」、importedAs 已导入徽标。
 * sources:list-skills 主进程暂不可用时静默降级（折叠态无 badge，展开态提示错误），URL 直装不受影响。
 */
function SkillDiscoverPanel({ onLibraryChanged }: { onLibraryChanged: () => void }) {
  const { settings } = useSettings()
  const [open, setOpen] = useState(false)
  const [groups, setGroups] = useState<SkillDiscoveryGroup[] | null>(null)
  const [syncAts, setSyncAts] = useState<Record<string, number | null>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [url, setUrl] = useState('')
  const [urlBusy, setUrlBusy] = useState(false)
  const [importing, setImporting] = useState<string | null>(null)
  const requestRef = useRef(0)

  /** listSkills（按源聚合技能）+ sources.list（补齐同步时间）；挂载 / 共享目录变更时刷新。
   *  刷新失败保留上次成功的分组：陈旧数据仍然可读，只在横幅里说明并给重试。 */
  const load = useCallback(async () => {
    const request = ++requestRef.current
    setLoading(true)
    setError('')
    try {
      const [listSkills, list] = await Promise.all([bridge.sources.listSkills(), bridge.sources.list()])
      if (request !== requestRef.current) return
      setGroups(listSkills.groups)
      setSyncAts(Object.fromEntries(list.sources.map((source) => [source.id, source.lastSyncedAt])))
    } catch (e) {
      if (request === requestRef.current) setError(errText(e))
    } finally {
      if (request === requestRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [settings?.sharedDir, load])
  useEffect(() => () => { requestRef.current++ }, [])

  const allSkills = useMemo(() => groups?.flatMap((group) => group.skills) ?? [], [groups])
  const importable = useMemo(() => allSkills.filter((skill) => !skill.importedAs).length, [allSkills])

  const visibleGroups = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!groups) return []
    return groups
      .map((group) => ({
        ...group,
        skills: group.skills.filter((skill) => !q || `${skill.name} ${skill.description}`.toLowerCase().includes(q))
      }))
      .filter((group) => group.skills.length > 0)
  }, [groups, query])

  /** URL 直装（skills:install-from-url = 登记源 + 扫描 + 批量导入一步完成） */
  const installFromUrl = async () => {
    const ref = url.trim()
    if (!ref || urlBusy) return
    setUrlBusy(true)
    try {
      const result = await bridge.skills.installFromUrl(ref)
      setUrl('')
      await load()
      onLibraryChanged()
      ui.toast.success(`从 ${result.sourceName} 导入 ${result.skills.length} 个技能`)
    } catch (e) {
      ui.toast.error('安装失败: ' + errText(e))
    } finally {
      setUrlBusy(false)
    }
  }

  const importSkill = async (group: SkillDiscoveryGroup, asset: DiscoveredAsset) => {
    if (importing) return
    setImporting(`${group.source.id}:${asset.path}`)
    try {
      const result = await bridge.sources.importSkill(group.source.id, asset.path)
      await load()
      onLibraryChanged()
      ui.toast.success(`已导入技能「${result.name}」`)
    } catch (e) {
      ui.toast.error('导入失败: ' + errText(e))
    } finally {
      setImporting(null)
    }
  }

  /** 按源「全部导入」：循环 importSkill，已存在（importedAs）跳过，聚合 toast 汇报（迁自原仓库 tab） */
  const importAll = async (group: SkillDiscoveryGroup) => {
    if (importing) return
    setImporting(`${group.source.id}:*`)
    let imported = 0
    let skipped = 0
    const failures: string[] = []
    try {
      for (const asset of group.skills) {
        if (asset.importedAs) { skipped++; continue }
        try {
          await bridge.sources.importSkill(group.source.id, asset.path)
          imported++
        } catch (e) {
          failures.push(`${asset.name}：${errText(e)}`)
        }
      }
      await load()
      onLibraryChanged()
      const summary = `导入 ${imported} / 跳过 ${skipped}`
      if (failures.length > 0) {
        const detail = failures.slice(0, 3).join('；') + (failures.length > 3 ? `…等 ${failures.length} 项` : '')
        ui.toast.error(`${summary} / 失败：${detail}`)
      } else if (imported > 0) {
        ui.toast.success(summary)
      } else {
        ui.toast.info(`${summary}（没有新技能可导入）`)
      }
    } finally {
      setImporting(null)
    }
  }

  return <section className="ext-discover ext-skill-discover">
    <button type="button" className="ext-fold-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
      <Sparkles size={14} />
      <b>发现技能</b>
      {importable > 0 && <span className="ext-badge">可导 {importable}</span>}
      <span className="ext-fold-hint">从扩展源或 URL 发现并导入新技能</span>
    </button>
    {open && <div className="ext-fold-body">
      <div className="ext-tab-toolbar ext-url-bar">
        <label className="market-search skills-search ext-url-input">
          <Globe size={15} />
          <input
            value={url}
            disabled={urlBusy}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (isComposingKey(e.nativeEvent)) return; if (e.key === 'Enter') void installFromUrl() }}
            placeholder="https://github.com/owner/repo"
            aria-label="技能仓库 URL"
          />
        </label>
        <button className="btn primary" disabled={urlBusy || !url.trim()} onClick={() => void installFromUrl()}>
          <CloudDownload size={14} /> {urlBusy ? '安装中…' : '从 URL 安装技能'}
        </button>
      </div>
      <div className="ext-asset-toolbar">
        <label className="market-search skills-search ext-asset-search">
          <Search size={14} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索技能名或描述" />
        </label>
        {groups && groups.length > 0 && <span className="ext-asset-count" title="已发现 / 可导入">{importable} / {allSkills.length} 可导</span>}
      </div>
      {loading && groups === null ? <p className="hint">正在扫描各扩展源的技能资产…</p>
        : error && (groups === null || groups.length === 0) ? <EmptyState
            compact
            icon={Sparkles}
            title="发现技能读取失败"
            description={error}
            action={<button className="btn" type="button" onClick={() => void load()} disabled={loading}><RefreshCw size={14} /> 重试</button>}
          />
          : <>{error && <StaleBanner marker="skill-discovery" label="显示上次成功的发现结果" error={error} onRetry={() => void load()} busy={loading} />}
            {!groups || groups.length === 0
              ? <p className="hint">还没有扩展源；可直接粘贴 URL 直装，或在插件 tab「+ 添加市场」中登记扩展源。</p>
              : visibleGroups.length === 0
                ? <p className="hint">没有匹配的技能。</p>
                : <div className="ext-skill-groups">
                {visibleGroups.map((group) => {
                  const groupImportable = group.skills.filter((skill) => !skill.importedAs).length
                  const allBusy = importing === `${group.source.id}:*`
                  return <div key={group.source.id} className="ext-skill-group">
                    <div className="ext-skill-group-head">
                      <span className="ext-skill-group-name">
                        <b>{group.source.name}</b>
                        <small className="ext-ref" title={group.source.ref}>{group.source.ref}</small>
                      </span>
                      <span className="ext-badge muted">{group.source.kind === 'git' ? 'git' : '本地'}</span>
                      <small className="ext-source-sync">同步于 {fmtAgo(syncAts[group.source.id] ?? null)}</small>
                      {groupImportable > 0 && (
                        <button className="btn" disabled={!!importing} onClick={() => void importAll(group)}>
                          <CloudDownload size={14} /> {allBusy ? '导入中…' : '全部导入'}
                        </button>
                      )}
                      <span className="ext-asset-count">{group.skills.length} 项</span>
                    </div>
                    <div className="ext-asset-list">
                      {group.skills.map((asset, index) => (
                        <div key={`${asset.path}-${index}`} className="ext-asset">
                          <span className="ext-asset-icon"><Sparkles size={13} /></span>
                          <span className="ext-asset-main">
                            <b>{asset.name}</b>
                            {asset.description && <small>{asset.description}</small>}
                            <small className="ext-ref" title={asset.path}>{asset.path}</small>
                          </span>
                          {asset.importedAs
                            ? <span className="ext-badge muted" title={`已存在于技能库：${asset.importedAs}`}><Check size={11} /> 已导入为 {asset.importedAs}</span>
                            : <button className="btn" disabled={!!importing} onClick={() => void importSkill(group, asset)}>
                              <CloudDownload size={14} /> {importing === `${group.source.id}:${asset.path}` ? '导入中…' : '导入'}
                            </button>}
                        </div>
                      ))}
                    </div>
                  </div>
                })}
              </div>}
          </>}
    </div>}
  </section>
}

/* ============================== 通用小工具 ============================== */

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 多行文本 → 去空行数组（args / 命令列表用） */
function linesToArray(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean)
}

/** 多行 KEY=VALUE → 字符串表（env / headers 用；无 = 的行按空值处理） */
function linesToRecord(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const at = trimmed.indexOf('=')
    if (at < 0) out[trimmed] = ''
    else out[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim()
  }
  return out
}

/** 字符串表 → 多行 KEY=VALUE */
function recordToLines(record?: Record<string, string>): string {
  return record ? Object.entries(record).map(([key, value]) => `${key}=${value}`).join('\n') : ''
}

/** 列表行的聚合状态点：全绿=全部目标 in-sync；黄=存在 outdated；灰=未安装到任何目标 */
function aggregateState(states: Record<string, SyncState> | undefined, targetIds: string[]): 'ok' | 'warn' | 'none' {
  if (!states) return 'none'
  const values = targetIds.map((id) => states[id] ?? 'missing')
  if (values.length === 0 || values.every((value) => value === 'missing')) return 'none'
  if (values.every((value) => value === 'in-sync')) return 'ok'
  return 'warn'
}

/** 相对时间（源仓库 lastSyncedAt 展示用） */
function fmtAgo(ts: number | null): string {
  if (!ts) return '从未同步'
  const minutes = Math.floor((Date.now() - ts) / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  return new Date(ts).toLocaleDateString()
}

/** 浏览资产面板的前端过滤：搜索命中 name/description，kind 三档（说明类仅在「全部」可见） */
function filterAssets(list: DiscoveredAsset[], query: string, kind: 'all' | 'skill' | 'marketplace'): DiscoveredAsset[] {
  const q = query.trim().toLowerCase()
  return list.filter((asset) => {
    if (kind !== 'all' && asset.kind !== kind) return false
    if (!q) return true
    return `${asset.name} ${asset.description}`.toLowerCase().includes(q)
  })
}

/** 安装目标 chip 行：点击安装 / 卸载；outdated 显示重新同步（MCP / Hooks 共用） */
function TargetChips({ targets, states, busy, onToggle }: {
  targets: Array<{ id: string; label: string; hint: string }>
  states: Record<string, SyncState> | undefined
  busy: boolean
  onToggle: (targetId: string) => void
}) {
  return <div className="skill-target-row">
    {targets.map((target) => {
      const state = states?.[target.id] ?? 'missing'
      return <button
        key={target.id}
        type="button"
        className={`skill-target st-${state}`}
        title={`${target.hint} · ${state}`}
        disabled={busy}
        onClick={() => onToggle(target.id)}
      >
        <i className="target-dot" />
        <span className="skill-target-copy">
          <b>{target.label}</b>
          <small>{state === 'in-sync' ? '已同步 · 卸载' : state === 'outdated' ? '过期 · 重新同步' : '未安装 · 安装'}</small>
        </span>
      </button>
    })}
  </div>
}

/* ============================== MCP tab ============================== */

interface McpDraft {
  name: string
  description: string
  type: McpTransport['type']
  command: string
  /** args：每行一项 */
  argsText: string
  /** env：每行 KEY=VALUE */
  envText: string
  url: string
  /** headers：每行 KEY=VALUE */
  headersText: string
  /** 已存在的服务器名（编辑/重命名基准）；null = 全新 */
  originName: string | null
}

function mcpToDraft(def: McpMeta): McpDraft {
  const transport = def.transport
  return {
    name: def.name,
    description: def.description,
    type: transport.type,
    command: transport.type === 'stdio' ? transport.command : '',
    argsText: transport.type === 'stdio' ? (transport.args ?? []).join('\n') : '',
    envText: transport.type === 'stdio' ? recordToLines(transport.env) : '',
    url: transport.type === 'stdio' ? '' : transport.url,
    headersText: transport.type === 'stdio' ? '' : recordToLines(transport.headers),
    originName: def.name
  }
}

function draftToTransport(draft: McpDraft): McpTransport {
  if (draft.type === 'stdio') {
    const args = linesToArray(draft.argsText)
    const env = linesToRecord(draft.envText)
    return { type: 'stdio', command: draft.command.trim(), ...(args.length ? { args } : {}), ...(Object.keys(env).length ? { env } : {}) }
  }
  const headers = linesToRecord(draft.headersText)
  return { type: draft.type, url: draft.url.trim(), ...(Object.keys(headers).length ? { headers } : {}) }
}

function emptyMcpDraft(): McpDraft {
  return { name: '', description: '', type: 'stdio', command: '', argsText: '', envText: '', url: '', headersText: '', originName: null }
}

/** MCP tab：共享目录服务器定义（stdio/http/sse）+ 三目标安装 chip。
 *  读状态与技能 tab 同构：加载中 / 首次失败 / 成功为空 / 陈旧四态；首次读不成功不写盘。 */
function McpTab() {
  const { settings } = useSettings()
  const [servers, setServers] = useState<McpMeta[]>([])
  const [targets, setTargets] = useState<McpTarget[]>([])
  const [states, setStates] = useState<TargetStates>({})
  const [draft, setDraft] = useState<McpDraft | null>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [targetsLoaded, setTargetsLoaded] = useState(false)
  const [targetsError, setTargetsError] = useState<string | null>(null)
  const [reloading, setReloading] = useState(true)
  const requestRef = useRef(0)

  const refreshAll = useCallback(async () => {
    const request = ++requestRef.current
    setReloading(true)
    const [listResult, targetResult] = await Promise.allSettled([bridge.mcp.list(), bridge.mcp.targets()])
    if (request !== requestRef.current) return
    if (listResult.status === 'fulfilled') {
      setServers(listResult.value.servers)
      setLoaded(true)
      setListError(null)
    } else {
      setListError(errText(listResult.reason))
    }
    if (targetResult.status === 'fulfilled') {
      setTargets(targetResult.value.targets)
      setStates(targetResult.value.states)
      setTargetsLoaded(true)
      setTargetsError(null)
    } else {
      setTargetsError(errText(targetResult.reason))
    }
    setReloading(false)
  }, [])

  useEffect(() => { void refreshAll() }, [settings?.sharedDir, refreshAll])
  useEffect(() => () => { requestRef.current++ }, [])

  /** 共享目录未知时写操作一律停用：写盘需要一个确定的目录 */
  const writesBlocked = !settings || !loaded

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return servers
    return servers.filter((server) => `${server.name} ${server.description}`.toLowerCase().includes(q))
  }, [servers, query])

  const targetIds = useMemo(() => targets.map((target) => target.id), [targets])

  const openServer = (name: string) => {
    const def = servers.find((server) => server.name === name)
    if (!def) { ui.toast.error(`服务器不存在: ${name}`); return }
    setDraft(mcpToDraft(def))
  }
  const newServer = () => {
    if (writesBlocked) { ui.toast.error('共享目录未知，暂时不能新建 MCP 服务器。'); return }
    setDraft(emptyMcpDraft())
  }

  const save = async () => {
    if (!draft || busy || writesBlocked) return
    const name = draft.name.trim()
    if (!name) { ui.toast.error('服务器名不能为空'); return }
    if (draft.type === 'stdio' && !draft.command.trim()) { ui.toast.error('stdio 类型必须填写 command'); return }
    if (draft.type !== 'stdio' && !draft.url.trim()) { ui.toast.error(`${draft.type} 类型必须填写 url`); return }
    setBusy(true)
    try {
      const transport = draftToTransport(draft)
      const meta = await bridge.mcp.save(
        { name, description: draft.description, transport },
        draft.originName ?? undefined
      )
      await refreshAll()
      setDraft(mcpToDraft(meta))
      ui.toast.success(`已保存「${meta.name}」`)
    } catch (e) {
      ui.toast.error('保存失败: ' + errText(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (name: string) => {
    if (writesBlocked) { ui.toast.error('共享目录未知，暂时不能删除 MCP 服务器。'); return }
    if (!await ui.confirm({ title: `删除 MCP 服务器「${name}」？`, body: '共享目录中的定义文件会被删除；已安装到各 CLI 配置的键不受影响，可稍后卸载。', danger: true, confirmText: '删除' })) return
    try {
      await bridge.mcp.delete(name)
      if (draft?.originName === name) setDraft(null)
      await refreshAll()
      ui.toast.success(`已删除「${name}」`)
    } catch (e) {
      ui.toast.error('删除失败: ' + errText(e))
    }
  }

  const toggleTarget = async (name: string, targetId: string) => {
    if (busy || writesBlocked) return
    setBusy(true)
    try {
      const state = states[name]?.[targetId] ?? 'missing'
      if (state === 'in-sync') await bridge.mcp.uninstall(name, targetId)
      else {
        const result = await bridge.mcp.install(name, targetId)
        if (result.ok === false) ui.toast.info(result.error ?? '该目标不支持此服务器类型，已跳过')
      }
      await refreshAll()
    } catch (e) {
      ui.toast.error('安装失败: ' + errText(e))
    } finally {
      setBusy(false)
    }
  }

  const retry = () => { void refreshAll() }

  if (!loaded && reloading) {
    return <EmptyState icon={LoaderCircle} title="MCP 服务器加载中" description="正在读取共享目录中的服务器定义。" />
  }
  // 读失败且列表为空：不声称「还没有服务器」——空结果来自上一次成功读取，不代表现在没有
  if (listError && servers.length === 0 && !draft) {
    return <EmptyState
      icon={Server}
      title="MCP 服务器读取失败"
      description={`${listError}；共享目录位置未知或结果不可信，因此新建、保存与安装暂时不可用。`}
      action={<button className="btn" type="button" onClick={retry}><RefreshCw size={14} /> 重试</button>}
    />
  }

  if (servers.length === 0 && !draft) {
    return <EmptyState
      icon={Server}
      title="还没有 MCP 服务器"
      description="MCP 服务器以 JSON 定义存放在共享目录，可一键安装到 Claude Code、ZCode、Codex 的用户级配置。"
      action={<button className="btn primary" onClick={newServer} disabled={writesBlocked}><Plus size={14} /> 新建 MCP 服务器</button>}
    />
  }

  return <>
    <div className="ext-tab-toolbar">
      <span className="ext-tab-desc">共享目录中的 MCP 服务器定义；安装目标为各 CLI 的用户级配置（Claude / ZCode / Codex）。</span>
      <div className="skills-header-actions">
        <button className="btn primary" onClick={newServer} disabled={writesBlocked}><Plus size={14} /> 新建 MCP 服务器</button>
      </div>
    </div>
    {listError && <StaleBanner marker="mcp" label="显示上次成功的 MCP 列表" error={listError} onRetry={retry} busy={reloading} />}
    {targetsError && <StaleBanner marker="mcp-targets" label={targetsLoaded ? '显示上次成功的安装状态' : '安装状态读取失败'} error={targetsError} onRetry={retry} busy={reloading} />}
    {writesBlocked && <p className="hint" data-mcp-writes-blocked>共享目录未知：MCP 写操作（新建 / 保存 / 删除 / 安装）已停用，重试读取成功后再操作。</p>}
    <div className="skills-layout">
      <aside className="skills-side">
        <label className="market-search skills-search">
          <Search size={15} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索服务器名或描述" />
        </label>
        <div className="skills-list">
          {visible.length === 0 && <div className="skills-list-empty">没有匹配的服务器</div>}
          {visible.map((server) => (
            <button
              key={server.name}
              type="button"
              className={`skills-item ${draft?.originName === server.name ? 'active' : ''}`}
              onClick={() => openServer(server.name)}
              title={server.description || server.name}
            >
              <i className={`sync-dot dot-${aggregateState(states[server.name], targetIds)}`} />
              <span className="skills-item-main">
                <b>{server.name}</b>
                <small>{server.description || '（无描述）'}</small>
                <small className="skills-item-time">{server.transport.type}</small>
              </span>
            </button>
          ))}
        </div>
      </aside>
      <section className="skills-detail">
        {!draft ? (
          <EmptyState compact title="选择左侧服务器查看详情" description="或新建一个 MCP 服务器。" />
        ) : (
          <>
            <div className="skills-editor">
              <div className="skills-editor-row">
                <label className="field">
                  <span>名称（即文件名，小写字母/数字/._-）</span>
                  <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="filesystem" />
                </label>
                <label className="field">
                  <span>描述</span>
                  <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="这个 MCP 服务器提供什么能力" />
                </label>
              </div>
              <div className="field">
                <span>传输类型</span>
                <div className="ext-seg">
                  {(['stdio', 'http', 'sse'] as const).map((type) => (
                    <button key={type} type="button" className={draft.type === type ? 'active' : ''} onClick={() => setDraft({ ...draft, type })}>{type}</button>
                  ))}
                </div>
              </div>
              {draft.type === 'stdio' ? (
                <div className="ext-editor-grid">
                  <label className="field">
                    <span>command</span>
                    <input value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} placeholder="npx" />
                  </label>
                  <label className="field">
                    <span>args（每行一项）</span>
                    <textarea className="ext-textarea" value={draft.argsText} onChange={(e) => setDraft({ ...draft, argsText: e.target.value })} placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/path/to/dir'} spellCheck={false} />
                  </label>
                  <label className="field">
                    <span>env（每行 KEY=VALUE）</span>
                    <textarea className="ext-textarea" value={draft.envText} onChange={(e) => setDraft({ ...draft, envText: e.target.value })} placeholder={'API_KEY=...'} spellCheck={false} />
                  </label>
                </div>
              ) : (
                <div className="ext-editor-grid">
                  <label className="field">
                    <span>url</span>
                    <input value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} placeholder="https://example.com/mcp" />
                  </label>
                  <label className="field">
                    <span>headers（每行 KEY=VALUE）</span>
                    <textarea className="ext-textarea" value={draft.headersText} onChange={(e) => setDraft({ ...draft, headersText: e.target.value })} placeholder={'Authorization=Bearer ...'} spellCheck={false} />
                  </label>
                </div>
              )}
              <div className="skills-editor-actions">
                <button className="btn primary" onClick={save} disabled={busy || writesBlocked}>保存</button>
                {draft.originName && <button className="btn danger" onClick={() => void remove(draft.originName!)} disabled={writesBlocked}><Trash2 size={14} /> 删除</button>}
              </div>
            </div>
            <div className="skill-targets">
              <div className="section-heading">
                <h3>安装目标</h3>
                <span>点击安装 / 卸载；定义改动后显示「重新同步」</span>
              </div>
              {!draft.originName ? (
                <p className="hint">先保存服务器，再安装到各 CLI 配置。</p>
              ) : targets.length === 0 ? (
                <p className="hint">{targetsLoaded ? '当前没有可安装的目标 CLI。' : '安装目标未知：读取失败，重试后再操作。'}</p>
              ) : (
                <TargetChips
                  targets={targets}
                  states={draft.originName ? states[draft.originName] : undefined}
                  busy={busy || writesBlocked}
                  onToggle={(targetId) => draft.originName && void toggleTarget(draft.originName, targetId)}
                />
              )}
            </div>
          </>
        )}
      </section>
    </div>
  </>
}

/* ============================== Hooks tab ============================== */

interface HookGroupDraft {
  event: string
  matcher: string
  /** 多条命令每行一个 */
  commands: string
}

interface HookDraft {
  name: string
  description: string
  body: string
  groups: HookGroupDraft[]
  originName: string | null
}

function hookToDraft(detail: HookDetail): HookDraft {
  const groups: HookGroupDraft[] = []
  for (const [event, list] of Object.entries(detail.events)) {
    for (const group of list) {
      groups.push({ event, matcher: group.matcher ?? '', commands: group.hooks.map((entry) => entry.command).join('\n') })
    }
  }
  if (groups.length === 0) groups.push({ event: 'PreToolUse', matcher: '', commands: '' })
  return { name: detail.name, description: detail.description, body: detail.body, groups, originName: detail.name }
}

function draftToEvents(draft: HookDraft): Record<string, HookGroup[]> {
  const events: Record<string, HookGroup[]> = {}
  for (const group of draft.groups) {
    const event = group.event.trim()
    if (!event) continue
    const commands = linesToArray(group.commands)
    if (commands.length === 0) continue
    const entry: HookGroup = {
      ...(group.matcher.trim() ? { matcher: group.matcher.trim() } : {}),
      hooks: commands.map((command) => ({ type: 'command' as const, command }))
    }
    ;(events[event] ??= []).push(entry)
  }
  return events
}

function emptyHookDraft(): HookDraft {
  return { name: '', description: '', body: '', groups: [{ event: 'PreToolUse', matcher: '', commands: '' }], originName: null }
}

/** Hooks tab：共享目录 hook 资产（HOOK.md + hook.json）+ claude/zcode 目标安装。
 *  读状态与 MCP / 技能 tab 同构；首次读不成功不写盘。 */
function HooksTab() {
  const { settings } = useSettings()
  const [hooks, setHooks] = useState<HookMeta[]>([])
  const [targets, setTargets] = useState<HookTarget[]>([])
  const [states, setStates] = useState<TargetStates>({})
  const [draft, setDraft] = useState<HookDraft | null>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [targetsLoaded, setTargetsLoaded] = useState(false)
  const [targetsError, setTargetsError] = useState<string | null>(null)
  const [reloading, setReloading] = useState(true)
  const requestRef = useRef(0)

  const refreshAll = useCallback(async () => {
    const request = ++requestRef.current
    setReloading(true)
    const [listResult, targetResult] = await Promise.allSettled([bridge.hooks.list(), bridge.hooks.targets()])
    if (request !== requestRef.current) return
    if (listResult.status === 'fulfilled') {
      setHooks(listResult.value.hooks)
      setLoaded(true)
      setListError(null)
    } else {
      setListError(errText(listResult.reason))
    }
    if (targetResult.status === 'fulfilled') {
      setTargets(targetResult.value.targets)
      setStates(targetResult.value.states)
      setTargetsLoaded(true)
      setTargetsError(null)
    } else {
      setTargetsError(errText(targetResult.reason))
    }
    setReloading(false)
  }, [])

  useEffect(() => { void refreshAll() }, [settings?.sharedDir, refreshAll])
  useEffect(() => () => { requestRef.current++ }, [])

  /** 共享目录未知时写操作一律停用 */
  const writesBlocked = !settings || !loaded

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return hooks
    return hooks.filter((hook) => `${hook.name} ${hook.description}`.toLowerCase().includes(q))
  }, [hooks, query])

  const targetIds = useMemo(() => targets.map((target) => target.id), [targets])

  const openHook = async (name: string) => {
    try {
      const detail = await bridge.hooks.get(name)
      if (!detail) { ui.toast.error(`Hook 不存在: ${name}`); return }
      setDraft(hookToDraft(detail))
    } catch (e) {
      ui.toast.error('读取 Hook 失败: ' + errText(e))
    }
  }
  const newHook = () => {
    if (writesBlocked) { ui.toast.error('共享目录未知，暂时不能新建 Hook。'); return }
    setDraft(emptyHookDraft())
  }

  const save = async () => {
    if (!draft || busy || writesBlocked) return
    const name = draft.name.trim()
    if (!name) { ui.toast.error('Hook 名不能为空'); return }
    setBusy(true)
    try {
      const meta = await bridge.hooks.save(name, {
        description: draft.description,
        body: draft.body,
        events: draftToEvents(draft),
        ...(draft.originName ? { originName: draft.originName } : {})
      })
      await refreshAll()
      setDraft({ ...draft, name: meta.name, originName: meta.name })
      ui.toast.success(`已保存「${meta.name}」`)
    } catch (e) {
      ui.toast.error('保存失败: ' + errText(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (name: string) => {
    if (writesBlocked) { ui.toast.error('共享目录未知，暂时不能删除 Hook。'); return }
    if (!await ui.confirm({ title: `删除 Hook「${name}」？`, body: '共享目录中的 hook 目录会被删除；已安装到各 CLI 配置的事件组不受影响，可稍后卸载。', danger: true, confirmText: '删除' })) return
    try {
      await bridge.hooks.delete(name)
      if (draft?.originName === name) setDraft(null)
      await refreshAll()
      ui.toast.success(`已删除「${name}」`)
    } catch (e) {
      ui.toast.error('删除失败: ' + errText(e))
    }
  }

  const toggleTarget = async (name: string, targetId: string) => {
    if (busy || writesBlocked) return
    setBusy(true)
    try {
      const state = states[name]?.[targetId] ?? 'missing'
      if (state === 'in-sync') await bridge.hooks.uninstall(name, targetId)
      else await bridge.hooks.install(name, targetId)
      await refreshAll()
    } catch (e) {
      ui.toast.error('安装失败: ' + errText(e))
    } finally {
      setBusy(false)
    }
  }

  const patchGroup = (index: number, patch: Partial<HookGroupDraft>) => {
    if (!draft) return
    setDraft({ ...draft, groups: draft.groups.map((group, i) => i === index ? { ...group, ...patch } : group) })
  }
  const addGroup = () => draft && setDraft({ ...draft, groups: [...draft.groups, { event: '', matcher: '', commands: '' }] })
  const removeGroup = (index: number) => draft && setDraft({ ...draft, groups: draft.groups.filter((_, i) => i !== index) })

  const hookCount = draft ? Object.keys(draftToEvents(draft)).length : 0
  const retry = () => { void refreshAll() }

  if (!loaded && reloading) {
    return <EmptyState icon={LoaderCircle} title="Hook 资产加载中" description="正在读取共享目录中的 Hook 资产。" />
  }
  // 读失败且列表为空：不声称「还没有 Hook」——空结果来自上一次成功读取
  if (listError && hooks.length === 0 && !draft) {
    return <EmptyState
      icon={Webhook}
      title="Hook 资产读取失败"
      description={`${listError}；共享目录位置未知或结果不可信，因此新建、保存与安装暂时不可用。`}
      action={<button className="btn" type="button" onClick={retry}><RefreshCw size={14} /> 重试</button>}
    />
  }

  if (hooks.length === 0 && !draft) {
    return <EmptyState
      icon={Webhook}
      title="还没有 Hook 资产"
      description="Hook 以 HOOK.md（说明文档）+ hook.json（事件定义）存放在共享目录，可安装到 Claude Code / ZCode。"
      action={<button className="btn primary" onClick={newHook} disabled={writesBlocked}><Plus size={14} /> 新建 Hook</button>}
    />
  }

  return <>
    <datalist id="ext-hook-events">
      {HOOK_EVENTS.map((event) => <option key={event} value={event} />)}
    </datalist>
    <div className="ext-tab-toolbar">
      <span className="ext-tab-desc">共享目录中的 Hook 资产；安装目标为 Claude Code / ZCode 的用户级配置（ZCode 会自动置 hooks.enabled）。</span>
      <div className="skills-header-actions">
        <button className="btn primary" onClick={newHook} disabled={writesBlocked}><Plus size={14} /> 新建 Hook</button>
      </div>
    </div>
    {listError && <StaleBanner marker="hooks" label="显示上次成功的 Hook 列表" error={listError} onRetry={retry} busy={reloading} />}
    {targetsError && <StaleBanner marker="hook-targets" label={targetsLoaded ? '显示上次成功的安装状态' : '安装状态读取失败'} error={targetsError} onRetry={retry} busy={reloading} />}
    {writesBlocked && <p className="hint" data-hooks-writes-blocked>共享目录未知：Hook 写操作（新建 / 保存 / 删除 / 安装）已停用，重试读取成功后再操作。</p>}
    <div className="skills-layout">
      <aside className="skills-side">
        <label className="market-search skills-search">
          <Search size={15} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索 Hook 名或描述" />
        </label>
        <div className="skills-list">
          {visible.length === 0 && <div className="skills-list-empty">没有匹配的 Hook</div>}
          {visible.map((hook) => (
            <button
              key={hook.name}
              type="button"
              className={`skills-item ${draft?.originName === hook.name ? 'active' : ''}`}
              onClick={() => void openHook(hook.name)}
              title={hook.description || hook.name}
            >
              <i className={`sync-dot dot-${aggregateState(states[hook.name], targetIds)}`} />
              <span className="skills-item-main">
                <b>{hook.name}</b>
                <small>{hook.description || '（无描述）'}</small>
                <small className="skills-item-time">{Object.keys(hook.events).length} 事件</small>
              </span>
            </button>
          ))}
        </div>
      </aside>
      <section className="skills-detail">
        {!draft ? (
          <EmptyState compact title="选择左侧 Hook 查看详情" description="或新建一个 Hook 资产。" />
        ) : (
          <>
            <div className="skills-editor">
              <div className="skills-editor-row">
                <label className="field">
                  <span>名称（即目录名，小写字母/数字/._-）</span>
                  <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="format-on-write" />
                </label>
                <label className="field">
                  <span>描述（写入 HOOK.md frontmatter）</span>
                  <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="这个 Hook 做什么、什么时候触发" />
                </label>
              </div>
              <label className="field">
                <span>说明文档（HOOK.md 正文）</span>
                <textarea className="ext-textarea ext-textarea-body" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} placeholder="在这里写 Markdown 说明…" spellCheck={false} />
              </label>
              <div className="section-heading ext-group-heading">
                <h3>事件（{hookCount}）</h3>
                <button className="btn" onClick={addGroup}><Plus size={14} /> 添加事件</button>
              </div>
              {draft.groups.length === 0 && <p className="hint">还没有事件组；点「添加事件」开始。</p>}
              {draft.groups.map((group, index) => (
                <div key={index} className="ext-group">
                  <div className="ext-group-row">
                    <label className="field">
                      <span>事件名</span>
                      <input list="ext-hook-events" value={group.event} onChange={(e) => patchGroup(index, { event: e.target.value })} placeholder="PreToolUse" />
                    </label>
                    <label className="field">
                      <span>matcher（留空 = 匹配全部）</span>
                      <input value={group.matcher} onChange={(e) => patchGroup(index, { matcher: e.target.value })} placeholder="Edit|Write" />
                    </label>
                    <button className="btn ghost ext-group-del" title="删除该事件组" onClick={() => removeGroup(index)}><Trash2 size={14} /></button>
                  </div>
                  <label className="field">
                    <span>command（多条命令每行一个）</span>
                    <textarea className="ext-textarea" value={group.commands} onChange={(e) => patchGroup(index, { commands: e.target.value })} placeholder={'npx prettier --write "$FILE"'} spellCheck={false} />
                  </label>
                </div>
              ))}
              <div className="skills-editor-actions">
                <button className="btn primary" onClick={save} disabled={busy || writesBlocked}>保存</button>
                {draft.originName && <button className="btn danger" onClick={() => void remove(draft.originName!)} disabled={writesBlocked}><Trash2 size={14} /> 删除</button>}
              </div>
            </div>
            <div className="skill-targets">
              <div className="section-heading">
                <h3>安装目标</h3>
                <span>点击安装 / 卸载；事件定义改动后显示「重新同步」</span>
              </div>
              {!draft.originName ? (
                <p className="hint">先保存 Hook，再安装到各 CLI 配置。</p>
              ) : targets.length === 0 ? (
                <p className="hint">{targetsLoaded ? '当前没有可安装的目标 CLI。' : '安装目标未知：读取失败，重试后再操作。'}</p>
              ) : (
                <TargetChips
                  targets={targets}
                  states={draft.originName ? states[draft.originName] : undefined}
                  busy={busy || writesBlocked}
                  onToggle={(targetId) => draft.originName && void toggleTarget(draft.originName, targetId)}
                />
              )}
            </div>
          </>
        )}
      </section>
    </div>
  </>
}

/* ============================== 插件 tab ============================== */

/** 插件 tab（EXTENSIONS-HUB §8.7）：Installed / Discover 两段式——三 CLI 已装盘点在上、
 *  发现区在下（「+ 添加市场」折叠块在发现区顶部 + 已注册市场浏览），与 ZCode Plugin Management 同构。 */
function PluginsTab() {
  const [items, setItems] = useState<PluginInventoryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [installSpec, setInstallSpec] = useState('')
  const [marketplaceNames, setMarketplaceNames] = useState<string[]>([])
  const requestRef = useRef(0)

  /** 盘点失败保留上次成功的清单：装卸按钮只能基于已知的已装状态 */
  const load = useCallback(async () => {
    const request = ++requestRef.current
    setLoading(true)
    try {
      const data = await bridge.plugins.inventory()
      if (request !== requestRef.current) return
      setItems(data.items)
      setLoaded(true)
      setError('')
    } catch (e) {
      // 首次失败由整块错误态承担，不再额外弹 toast（同一次失败只说一次）
      if (request === requestRef.current) setError(errText(e))
    } finally {
      if (request === requestRef.current) setLoading(false)
    }
  }, [])

  /** 已注册市场名（安装输入框 datalist 候选）；marketplaces:status 不可用时静默降级为空 */
  const loadMarketplaceNames = useCallback(async () => {
    try {
      const status = await bridge.marketplaces.status()
      setMarketplaceNames(Array.from(new Set([...status.claude, ...status.zcode])).sort())
    } catch {
      setMarketplaceNames([])
    }
  }, [])

  useEffect(() => { void load(); void loadMarketplaceNames() }, [load, loadMarketplaceNames])
  useEffect(() => () => { requestRef.current++ }, [])

  /** 清单未知（首次盘点没成功）时停用装卸：不知道装了什么就不能盲改 CLI 配置 */
  const writesBlocked = !loaded
  const retry = () => { void load() }

  const toggle = async (item: PluginInventoryItem) => {
    if (item.cli !== 'claude' || !item.marketplace || busy || writesBlocked) return
    setBusy(true)
    try {
      await bridge.plugins.setEnabled({ cli: 'claude', name: item.name, marketplace: item.marketplace, enabled: !item.enabled })
      await load()
      ui.toast.success(`${item.enabled ? '已停用' : '已启用'}「${item.name}」`)
    } catch (e) {
      ui.toast.error('切换失败: ' + errText(e))
    } finally {
      setBusy(false)
    }
  }

  /** 安装 claude 插件（spec = plugin@marketplace，由官方 claude CLI 代跑）；成功后刷新盘点 */
  const installPlugin = async () => {
    const spec = installSpec.trim()
    if (!spec || busy || writesBlocked) return
    setBusy(true)
    try {
      const result = await bridge.plugins.install({ cli: 'claude', spec })
      if (!result.ok) {
        ui.toast.error(`安装失败: ${result.output || '未知错误'}`)
        return
      }
      setInstallSpec('')
      await load()
      await loadMarketplaceNames()
      ui.toast.success(`已安装「${spec}」`)
    } catch (e) {
      ui.toast.error('安装失败: ' + errText(e))
    } finally {
      setBusy(false)
    }
  }

  /** 卸载 claude 插件（危险确认 → plugins.uninstall）；成功后刷新盘点 */
  const uninstall = async (item: PluginInventoryItem) => {
    if (item.cli !== 'claude' || !item.marketplace || busy || writesBlocked) return
    const spec = `${item.name}@${item.marketplace}`
    if (!await ui.confirm({
      title: `卸载插件「${spec}」？`,
      body: '将通过 claude 官方 CLI 卸载该插件，其本地缓存与配置会被移除；重启会话后生效。',
      danger: true,
      confirmText: '卸载'
    })) return
    setBusy(true)
    try {
      const result = await bridge.plugins.uninstall({ cli: 'claude', spec })
      if (!result.ok) {
        ui.toast.error(`卸载失败: ${result.output || '未知错误'}`)
        return
      }
      await load()
      ui.toast.success(`已卸载「${spec}」`)
    } catch (e) {
      ui.toast.error('卸载失败: ' + errText(e))
    } finally {
      setBusy(false)
    }
  }

  const openDir = async (cli: PluginInventoryItem['cli']) => {
    try {
      await bridge.plugins.openDir(cli)
    } catch (e) {
      ui.toast.error('打开目录失败: ' + errText(e))
    }
  }

  if (!loaded && loading) return <EmptyState icon={LoaderCircle} title="插件盘点中" description="正在盘点各 CLI 已安装的插件与市场。" />
  if (!loaded && error) {
    return <EmptyState
      icon={Puzzle}
      title="插件清单读取失败"
      description={`${error}；已装状态未知，因此安装、启用与卸载暂时不可用。`}
      action={<button className="btn" type="button" onClick={retry}><RefreshCw size={14} /> 重试</button>}
    />
  }

  return <div className="ext-plugins">
    <div className="ext-tab-toolbar">
      <span className="ext-tab-desc">{PLUGINS_DESC}</span>
    </div>
    {error && <StaleBanner marker="plugins" label="显示上次成功的插件盘点" error={error} onRetry={retry} busy={loading} />}
    {writesBlocked && <p className="hint" data-plugins-writes-blocked>插件清单未知：安装 / 启用 / 卸载已停用，重试盘点成功后再操作。</p>}
    <datalist id="ext-plugin-marketplaces">
      {marketplaceNames.map((name) => <option key={name} value={name} />)}
    </datalist>
    {CLI_ORDER.map((cli) => {
      const list = items.filter((item) => item.cli === cli)
      const pluginCount = list.filter((item) => item.kind === 'plugin').length
      return <section key={cli} className="ext-plugin-section">
        <div className="section-heading">
          <h3>{CLI_LABELS[cli]}{pluginCount > 0 && <span className="ext-badge muted">{pluginCount}</span>}</h3>
          <button className="btn" onClick={() => void openDir(cli)}><FolderOpen size={14} /> 打开目录</button>
        </div>
        {cli === 'claude' && (
          <div className="ext-form-row ext-install-row">
            <label className="field">
              <input
                list="ext-plugin-marketplaces"
                value={installSpec}
                disabled={busy}
                onChange={(e) => setInstallSpec(e.target.value)}
                onKeyDown={(e) => { if (isComposingKey(e.nativeEvent)) return; if (e.key === 'Enter') void installPlugin() }}
                placeholder="plugin@marketplace"
              />
            </label>
            <button className="btn primary" disabled={busy || writesBlocked || !installSpec.trim()} onClick={() => void installPlugin()}>
              <Plus size={14} /> 安装插件
            </button>
          </div>
        )}
        {list.length === 0 ? <p className="hint">未检测到</p> : (
          <div className="ext-plugin-list">
            {list.map((item, index) => (
              <div key={`${item.kind}-${item.name}-${item.marketplace ?? ''}-${index}`} className="ext-plugin-item">
                <span className="ext-plugin-icon">{item.kind === 'marketplace' ? <Store size={14} /> : <Package size={14} />}</span>
                <span className="ext-plugin-name">
                  <b>{item.kind === 'plugin' && item.marketplace ? `${item.name}@${item.marketplace}` : item.name}</b>
                  {(item.version || item.description) && <small>{[item.version ? `v${item.version}` : '', item.description ?? ''].filter(Boolean).join(' · ')}</small>}
                </span>
                <span className={`ext-badge ${item.kind === 'marketplace' ? '' : 'muted'}`}>{item.kind === 'marketplace' ? '市场' : '插件'}</span>
                {cli === 'claude' && item.kind === 'plugin' && item.installed === false && (
                  <span className="ext-badge muted" title="enabledPlugins 有键但实际未安装，可忽略或点卸载清理">未装残留</span>
                )}
                {cli === 'claude' && item.kind === 'plugin' && item.marketplace && (
                  <>
                    {item.installed !== false && (
                      <button
                        type="button"
                        className={`toggle-control ${item.enabled ? 'on' : ''}`}
                        disabled={busy || writesBlocked}
                        title={item.enabled ? '点击停用' : '点击启用'}
                        onClick={() => void toggle(item)}
                      >
                        <span />{item.enabled ? '已启用' : '已停用'}
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn danger ext-plugin-remove"
                      disabled={busy || writesBlocked}
                      title={`通过 claude CLI 卸载 ${item.name}@${item.marketplace}`}
                      onClick={() => void uninstall(item)}
                    >
                      <Trash2 size={13} /> 卸载
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    })}
    {/* 发现区（Discover）：「+ 添加市场」折叠块在顶部 + 已注册市场浏览 */}
    <section className="ext-plugin-section">
      <div className="section-heading">
        <h3>发现</h3>
        <span>添加插件市场、浏览并安装新插件</span>
      </div>
      <AddMarketplaceBlock />
      <MarketBrowse onInstalled={() => void load()} />
    </section>
  </div>
}

/* ============================== 插件发现区 ============================== */

/** 已注册市场浏览（§8.6 迁入发现区）：展开时才拉取 listRegistered，按市场分组渲染插件清单。
 *  刷新失败保留上次成功的清单（已装态仍可读），只在横幅里说明并给重试。 */
function MarketBrowse({ onInstalled }: { onInstalled: (marketplace: string, pluginName: string) => void }) {
  const [show, setShow] = useState(false)
  const [markets, setMarkets] = useState<RegisteredMarketplace[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')

  const reload = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await bridge.marketplaces.listRegistered()
      setMarkets(data.marketplaces)
      setLoaded(true)
    } catch (e) {
      setError(errText(e))
    } finally {
      setLoading(false)
    }
  }, [])

  /** 展开 / 收起（每次展开重新拉取，保证已装态新鲜；失败保留旧数据并给重试） */
  const toggle = () => {
    if (show) { setShow(false); return }
    setShow(true)
    void reload()
  }

  return <div className="ext-discover-browse">
    <div className="ext-browse-head">
      <button className="btn" onClick={toggle}>
        <Store size={14} /> {show ? '收起市场' : '浏览已注册市场'}
      </button>
      <span className="ext-tab-desc">从已注册市场（AgentDeck 源 + Claude / ZCode 市场缓存）浏览并安装插件</span>
    </div>
    {show && <div className="ext-market-browse">
      {error && !loaded ? <EmptyState
        compact
        icon={Store}
        title="市场清单读取失败"
        description={error}
        action={<button className="btn" type="button" onClick={() => void reload()} disabled={loading}><RefreshCw size={14} /> 重试</button>}
      />
        : <>{error && <StaleBanner marker="market-browse" label="显示上次成功的市场清单" error={error} onRetry={() => void reload()} busy={loading} />}
          {loading && !loaded ? <p className="hint">正在读取已注册市场…</p>
            : !markets || markets.length === 0
              ? <p className="hint">未发现已注册市场；可在「+ 添加市场」中登记扩展源、浏览并注册市场。</p>
              : markets.map((market) => (
                <section key={market.name} className="ext-market-group">
                  <div className="ext-market-head">
                    <Store size={14} />
                    <b>{market.name}</b>
                    {market.clis.map((marketCli) => <span key={marketCli} className="ext-badge muted">{CLI_LABELS[marketCli]}</span>)}
                    <span className="ext-badge muted">{market.plugins.length} 插件</span>
                  </div>
                  <MarketplacePluginPanel
                    marketplaceName={market.name}
                    plugins={market.plugins}
                    canInstall={market.clis.includes('claude')}
                    onInstalled={(pluginName) => {
                      setMarkets((current) => current?.map((m) => m.name === market.name
                        ? { ...m, plugins: m.plugins.map((plugin) => plugin.name === pluginName ? { ...plugin, installed: true } : plugin) }
                        : m) ?? current)
                      onInstalled(market.name, pluginName)
                    }}
                  />
                </section>
              ))}</>}
    </div>}
  </div>
}

/** 「+ 添加市场」折叠块（§8.7）：精选目录 + 自定义源表单 + 已添加源列表，整体迁移自原仓库 tab。 */
function AddMarketplaceBlock() {
  const [open, setOpen] = useState(false)
  return <div className="ext-discover-fold">
    <button type="button" className="ext-fold-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
      <Plus size={14} />
      <b>添加市场</b>
      <span className="ext-fold-hint">精选目录 · git URL / 本地目录 · 已添加源同步与移除</span>
    </button>
    {open && <div className="ext-fold-body"><SourceManager /></div>}
  </div>
}

/* ============================== 扩展源管理（原仓库 tab 迁移） ============================== */

/**
 * 市场插件面板：搜索框 + 分类下拉 + 逐项安装 + 已装徽标（EXTENSIONS-HUB §8.4 抽取的可复用展示层），
 * 供扩展源管理的源内市场清单（MarketplacePluginList）与插件 tab 发现区的已注册市场浏览共用。
 * install spec = 插件名@市场名；canInstall=false（市场未注册到 claude）时降级为「不可安装」徽标。
 */
function MarketplacePluginPanel({ marketplaceName, plugins, loading, error, canInstall = true, onInstalled }: {
  marketplaceName: string
  plugins: MarketplacePluginInfo[]
  loading?: boolean
  error?: string
  canInstall?: boolean
  onInstalled?: (pluginName: string) => void
}) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [installing, setInstalling] = useState<string | null>(null)

  /** 分类下拉候选（distinct，仅含声明了 category 的插件） */
  const categories = useMemo(
    () => Array.from(new Set(plugins.map((plugin) => plugin.category).filter((c): c is string => !!c))).sort(),
    [plugins]
  )

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return plugins.filter((plugin) => {
      if (category && plugin.category !== category) return false
      if (!q) return true
      return `${plugin.name} ${plugin.description ?? ''}`.toLowerCase().includes(q)
    })
  }, [plugins, query, category])

  const install = async (plugin: MarketplacePluginInfo) => {
    if (installing || !canInstall) return
    const spec = `${plugin.name}@${marketplaceName}`
    setInstalling(plugin.name)
    try {
      const result = await bridge.plugins.install({ cli: 'claude', spec })
      if (!result.ok) {
        ui.toast.error(`安装「${spec}」失败: ${result.output || '未知错误'}`)
        return
      }
      onInstalled?.(plugin.name)
      ui.toast.success(`已安装「${spec}」`)
    } catch (e) {
      ui.toast.error(`安装「${spec}」失败: ${errText(e)}`)
    } finally {
      setInstalling(null)
    }
  }

  return <div className="ext-mp">
    <div className="ext-mp-toolbar">
      <label className="market-search skills-search ext-mp-search">
        <Search size={14} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索插件名或描述" />
      </label>
      <select className="ext-mp-select" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="按分类筛选插件">
        <option value="">全部分类</option>
        {categories.map((name) => <option key={name} value={name}>{name}</option>)}
      </select>
      <span className="ext-asset-count">{visible.length} / {plugins.length}</span>
    </div>
    {error ? (
      <p className="hint">插件清单读取失败：{error}</p>
    ) : loading ? (
      <p className="hint">正在读取插件清单…</p>
    ) : plugins.length === 0 ? (
      <p className="hint">该市场未声明插件。</p>
    ) : visible.length === 0 ? (
      <p className="hint">没有匹配的插件。</p>
    ) : (
      <div className="ext-mp-list">
        {visible.map((plugin, index) => (
          <div key={`${plugin.name}-${index}`} className="ext-mp-item">
            <span className="ext-plugin-icon"><Package size={13} /></span>
            <span className="ext-mp-main">
              <span className="ext-mp-title">
                <b>{plugin.name}</b>
                {plugin.category && <span className="ext-badge muted">{plugin.category}</span>}
              </span>
              {plugin.description && <small className="ext-mp-desc" title={plugin.description}>{plugin.description}</small>}
              {(plugin.author || plugin.version) && (
                <small className="ext-mp-meta">{[plugin.author, plugin.version ? `v${plugin.version}` : ''].filter(Boolean).join(' · ')}</small>
              )}
            </span>
            {plugin.installed ? (
              <span className="ext-badge" title="已安装到 Claude Code"><Check size={11} /> 已安装</span>
            ) : canInstall ? (
              <button
                type="button"
                className="btn"
                disabled={!!installing}
                title={`安装 ${plugin.name}@${marketplaceName}`}
                onClick={() => void install(plugin)}
              >
                <CloudDownload size={13} /> {installing === plugin.name ? '安装中…' : '安装'}
              </button>
            ) : (
              <span className="ext-badge muted" title="该市场未注册到 Claude Code，暂不能经 claude CLI 安装">不可安装</span>
            )}
          </div>
        ))}
      </div>
    )}
  </div>
}

/* ============================== 扩展源管理（原仓库 tab 迁移） ============================== */

/**
 * marketplace.json 插件清单（浏览展开态内联）：展开时才经 listPlugins 拉取，
 * 展示层复用 MarketplacePluginPanel，安装成功后本项翻转为「已安装」。
 */
function MarketplacePluginList({ sourceId, asset }: { sourceId: string; asset: DiscoveredAsset }) {
  const [plugins, setPlugins] = useState<MarketplacePluginInfo[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    setPlugins(null)
    setError('')
    bridge.marketplaces.listPlugins(sourceId, asset.path)
      .then((data) => { if (alive) setPlugins(data.plugins) })
      .catch((e) => { if (alive) setError(errText(e)) })
    return () => { alive = false }
  }, [sourceId, asset.path])

  return <MarketplacePluginPanel
    marketplaceName={asset.name}
    plugins={plugins ?? []}
    loading={plugins === null && !error}
    error={error || undefined}
    onInstalled={(pluginName) => setPlugins((current) => current?.map((plugin) => plugin.name === pluginName ? { ...plugin, installed: true } : plugin) ?? current)}
  />
}

/** 扩展源管理器（§8.7：原仓库 tab，现整体迁入插件 tab「+ 添加市场」折叠块——仓库 tab 移除后能力一个不少）：
 *  内置精选目录一键添加 + 自定义 git/本地源 + 已添加源的浏览/导入/注册市场/同步/移除。 */
function SourceManager() {
  const [entries, setEntries] = useState<CatalogEntry[]>([])
  const [sources, setSources] = useState<ExtSourceMeta[]>([])
  const [customRef, setCustomRef] = useState('')
  const [assets, setAssets] = useState<Record<string, DiscoveredAsset[]>>({})
  const [browsingId, setBrowsingId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [marketplaces, setMarketplaces] = useState<MarketplaceStatus | null>(null)
  const requestRef = useRef(0)
  // 浏览展开态：资产工具条（搜索/kind）与插件清单展开项（单开）
  const [assetQuery, setAssetQuery] = useState('')
  const [assetKind, setAssetKind] = useState<'all' | 'skill' | 'marketplace'>('all')
  const [pluginPath, setPluginPath] = useState<string | null>(null)
  const [importingAll, setImportingAll] = useState(false)

  /** 目录 / 已添加源读取：失败保留上次成功的数据，「精选目录为空」不能拿来冒充失败 */
  const load = useCallback(async () => {
    const request = ++requestRef.current
    setLoading(true)
    try {
      const [catalog, list] = await Promise.all([bridge.sources.catalog(), bridge.sources.list()])
      if (request !== requestRef.current) return
      setEntries(catalog.entries)
      setSources(list.sources)
      setLoaded(true)
      setLoadError('')
    } catch (e) {
      if (request === requestRef.current) setLoadError(errText(e))
    } finally {
      if (request === requestRef.current) setLoading(false)
    }
  }, [])

  /** 已注册市场清单（市场资产行「已注册」态判定）；marketplaces:status 不可用时静默降级 */
  const loadMarketplaceStatus = useCallback(async () => {
    try {
      setMarketplaces(await bridge.marketplaces.status())
    } catch {
      setMarketplaces(null)
    }
  }, [])

  useEffect(() => { void load(); void loadMarketplaceStatus() }, [load, loadMarketplaceStatus])
  useEffect(() => () => { requestRef.current++ }, [])

  const addSource = async (ref: string, name?: string) => {
    const trimmed = ref.trim()
    if (!trimmed || busy) return
    setBusy(true)
    try {
      const meta = await bridge.sources.add(trimmed, name)
      await load()
      if (!name) setCustomRef('')
      ui.toast.success(`已添加扩展源「${meta.name}」`)
    } catch (e) {
      ui.toast.error('添加失败: ' + errText(e))
    } finally {
      setBusy(false)
    }
  }

  const pickLocal = async () => {
    const dir = await bridge.pickDir()
    if (dir) setCustomRef(dir)
  }

  /**
   * 从 URL 一键安装（EXTENSIONS-HUB §8.5）：addSource + browseSource 一步完成。
   * 成功后刷新源列表、browsingId 置为新源、assets 预填充，并复位浏览筛选，
   * 使资产面板直接展开就绪（工具条 / 插件清单 / 全部导入均可用）；摘要 toast 汇报发现数。
   */
  const quickAdd = async (ref: string, name?: string) => {
    const trimmed = ref.trim()
    if (!trimmed || busy) return
    setBusy(true)
    try {
      const result = await bridge.sources.quickAdd(trimmed, name)
      setAssets((current) => ({ ...current, [result.source.id]: result.assets }))
      setBrowsingId(result.source.id)
      setAssetQuery('')
      setAssetKind('all')
      setPluginPath(null)
      if (!name) setCustomRef('')
      await load()
      const skills = result.assets.filter((asset) => asset.kind === 'skill').length
      const markets = result.assets.filter((asset) => asset.kind === 'marketplace').length
      ui.toast.success(`发现 ${skills} 技能 / ${markets} 市场`)
    } catch (e) {
      ui.toast.error('安装失败: ' + errText(e))
    } finally {
      setBusy(false)
    }
  }

  const refreshBrowse = useCallback(async (id: string) => {
    try {
      const data = await bridge.sources.browse(id)
      setAssets((current) => ({ ...current, [id]: data.assets }))
    } catch {
      // 浏览刷新失败不打扰用户（源可能已被移除）
    }
  }, [])

  const browse = async (id: string) => {
    if (browsingId === id) { setBrowsingId(null); setPluginPath(null); return }
    setBrowsingId(id)
    setAssetQuery('')
    setAssetKind('all')
    setPluginPath(null)
    try {
      const data = await bridge.sources.browse(id)
      setAssets((current) => ({ ...current, [id]: data.assets }))
    } catch (e) {
      ui.toast.error('扫描失败: ' + errText(e))
      setBrowsingId(null)
    }
  }

  const syncSource = async (id: string) => {
    if (busy) return
    setBusy(true)
    try {
      await bridge.sources.sync(id)
      await load()
      if (browsingId === id) await refreshBrowse(id)
      ui.toast.success('已同步')
    } catch (e) {
      ui.toast.error('同步失败: ' + errText(e))
    } finally {
      setBusy(false)
    }
  }

  const removeSource = async (source: ExtSourceMeta) => {
    if (!await ui.confirm({
      title: `移除扩展源「${source.name}」？`,
      body: source.kind === 'git' ? '注册表项与已 clone 的仓库目录会被删除。' : '只移除注册表项，本地目录内容不受影响。',
      danger: true,
      confirmText: '移除'
    })) return
    try {
      await bridge.sources.remove(source.id)
      if (browsingId === source.id) setBrowsingId(null)
      await load()
      ui.toast.success(`已移除「${source.name}」`)
    } catch (e) {
      ui.toast.error('移除失败: ' + errText(e))
    }
  }

  const importSkill = async (sourceId: string, asset: DiscoveredAsset) => {
    try {
      const result = await bridge.sources.importSkill(sourceId, asset.path)
      await refreshBrowse(sourceId)
      ui.toast.success(`已导入技能「${result.name}」`)
    } catch (e) {
      ui.toast.error('导入失败: ' + errText(e))
    }
  }

  /** 全部导入：循环 importSkill，已存在（importedAs）跳过，聚合 toast 汇报导入/跳过/失败列表 */
  const importAllSkills = async (sourceId: string, targets: DiscoveredAsset[]) => {
    if (importingAll) return
    setImportingAll(true)
    let imported = 0
    let skipped = 0
    const failures: string[] = []
    try {
      for (const asset of targets) {
        if (asset.importedAs) { skipped++; continue }
        try {
          await bridge.sources.importSkill(sourceId, asset.path)
          imported++
        } catch (e) {
          failures.push(`${asset.name}：${errText(e)}`)
        }
      }
      await refreshBrowse(sourceId)
      const summary = `导入 ${imported} / 跳过 ${skipped}`
      if (failures.length > 0) {
        const detail = failures.slice(0, 3).join('；') + (failures.length > 3 ? `…等 ${failures.length} 项` : '')
        ui.toast.error(`${summary} / 失败：${detail}`)
      } else if (imported > 0) {
        ui.toast.success(summary)
      } else {
        ui.toast.info(`${summary}（没有新技能可导入）`)
      }
    } finally {
      setImportingAll(false)
    }
  }

  /** 展开/收起某 marketplace 资产的插件清单（单开，避免同时拉取多份） */
  const togglePluginList = (path: string) => setPluginPath((current) => current === path ? null : path)

  /** 市场是否已注册（claude extraKnownMarketplaces / zcode id 命中即可） */
  const isMarketplaceRegistered = (name: string) =>
    !!marketplaces && (marketplaces.claude.includes(name) || marketplaces.zcode.includes(name))

  /** 把源内发现的市场注册到 Claude / ZCode（两侧成败独立）；重复注册幂等，成功后刷新已注册态 */
  const registerMarketplace = async (source: ExtSourceMeta, asset: DiscoveredAsset) => {
    if (busy) return
    setBusy(true)
    try {
      const result = await bridge.marketplaces.register(source.id, asset.path)
      await loadMarketplaceStatus()
      const count = result.pluginCount || asset.pluginCount || 0
      if (result.claudeName) ui.toast.success(`Claude 市场「${result.claudeName}」已注册${count ? `（${count} 个插件）` : ''}`)
      else ui.toast.error(`Claude 注册失败: ${result.claudeError ?? '未知错误'}`)
      if (result.zcodeId) ui.toast.success(`ZCode 市场「${result.zcodeId}」已注册`)
      else ui.toast.error(`ZCode 注册失败: ${result.zcodeError ?? '未知错误'}`)
    } catch (e) {
      ui.toast.error('注册市场失败: ' + errText(e))
    } finally {
      setBusy(false)
    }
  }

  return <div className="ext-sources">
    {loadError && !loaded ? <EmptyState
      compact
      icon={FolderGit2}
      title="扩展源读取失败"
      description={loadError}
      action={<button className="btn" type="button" onClick={() => void load()} disabled={loading}><RefreshCw size={14} /> 重试</button>}
    />
      : <>
        {loadError && <StaleBanner marker="extension-sources" label="显示上次成功的扩展源" error={loadError} onRetry={() => void load()} busy={loading} />}
        <section className="ext-section">
          <div className="section-heading">
            <h3>精选目录</h3>
            <span>内置常用扩展仓库，一键添加为扩展源</span>
          </div>
          {entries.length === 0 ? (
            <p className="hint">{loading ? '正在读取精选目录…' : '精选目录为空。'}</p>
          ) : (
            <div className="ext-catalog-grid">
              {entries.map((entry) => {
                const added = sources.some((source) => source.ref === entry.repo)
                return <div key={entry.id} className="ext-catalog-card">
                  <div className="ext-row-between">
                    <b>{entry.name}</b>
                    <span className="ext-badge muted">{CATEGORY_LABELS[entry.category] ?? entry.category}</span>
                  </div>
                  <p>{entry.description}</p>
                  <span className="ext-ref" title={entry.repo}>{entry.repo}</span>
                  <div className="ext-card-actions">
                    {added
                      ? <button className="btn" disabled><Check size={14} /> 已添加</button>
                      : <button className="btn" disabled={busy} onClick={() => void addSource(entry.repo, entry.name)}><Plus size={14} /> 添加</button>}
                  </div>
                </div>
              })}
            </div>
          )}
        </section>

    <section className="ext-section">
      <div className="section-heading">
        <h3>添加扩展源</h3>
        <span>支持任意 git URL 或本地目录路径；添加后可浏览检查其中资产（「从 URL 安装」会克隆并直接展开）</span>
      </div>
      <div className="ext-form-row ext-source-form">
        <label className="field">
          <input
            value={customRef}
            onChange={(e) => setCustomRef(e.target.value)}
            placeholder="https://github.com/owner/repo.git"
            onKeyDown={(e) => { if (isComposingKey(e.nativeEvent)) return; if (e.key === 'Enter') void quickAdd(customRef) }}
          />
        </label>
        <button className="btn" onClick={() => void pickLocal()}><FolderOpen size={14} /> 选目录</button>
        <button className="btn" disabled={busy || !customRef.trim()} onClick={() => void addSource(customRef)}><Plus size={14} /> 添加源</button>
        <button className="btn primary" disabled={busy || !customRef.trim()} onClick={() => void quickAdd(customRef)} title="克隆该源并直接展开发现的资产"><CloudDownload size={14} /> 从 URL 安装</button>
      </div>
    </section>

    <section className="ext-section">
      <div className="section-heading">
        <h3>已添加源</h3>
        <span>{sources.length} 个</span>
      </div>
      {sources.length === 0 ? (
        <EmptyState compact icon={FolderGit2} title="还没有扩展源" description="从上方精选目录一键添加，或自定义添加 git / 本地目录。" />
      ) : (
        <div className="ext-source-list">
          {sources.map((source) => {
            const open = browsingId === source.id
            const list = assets[source.id]
            const searched = list ? filterAssets(list, assetQuery, 'all') : []
            const visibleAssets = list ? filterAssets(list, assetQuery, assetKind) : []
            const kindCount = (kind: 'skill' | 'marketplace') => searched.filter((asset) => asset.kind === kind).length
            const skillTargets = visibleAssets.filter((asset) => asset.kind === 'skill')
            return <div key={source.id} className="ext-source-item">
              <div className="ext-source-head">
                <button
                  type="button"
                  className="ext-source-toggle"
                  title={open ? '收起发现的资产' : '浏览发现的资产'}
                  onClick={() => void browse(source.id)}
                >
                  {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                </button>
                <span className="ext-source-main">
                  <b>{source.name}</b>
                  <small className="ext-ref" title={source.ref}>{source.ref}</small>
                </span>
                <span className="ext-badge muted">{CATEGORY_LABELS[source.category] ?? source.category}</span>
                <span className="ext-badge muted">{source.kind === 'git' ? 'git' : '本地'}</span>
                <small className="ext-source-sync">同步于 {fmtAgo(source.lastSyncedAt)}</small>
                <div className="ext-card-actions">
                  <button className="btn" disabled={busy} onClick={() => void syncSource(source.id)}><RefreshCw size={14} /> 同步</button>
                  <button className="btn danger" onClick={() => void removeSource(source)}><Trash2 size={14} /> 移除</button>
                </div>
              </div>
              {open && <div className="ext-source-assets">
                {!list ? (
                  <p className="hint">正在扫描…</p>
                ) : list.length === 0 ? (
                  <p className="hint">未发现可导入资产（SKILL.md / marketplace.json / README）。</p>
                ) : <>
                  <div className="ext-asset-toolbar">
                    <label className="market-search skills-search ext-asset-search">
                      <Search size={14} />
                      <input value={assetQuery} onChange={(e) => setAssetQuery(e.target.value)} placeholder="搜索资产名或描述" />
                    </label>
                    <div className="ext-seg ext-kind-filter" role="group" aria-label="资产类型筛选">
                      {ASSET_KIND_FILTERS.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          className={assetKind === item.id ? 'active' : ''}
                          onClick={() => setAssetKind(item.id)}
                        >
                          {item.label}<span className="ext-kind-count">{item.id === 'all' ? searched.length : kindCount(item.id)}</span>
                        </button>
                      ))}
                    </div>
                    {skillTargets.length > 0 && (
                      <button className="btn" disabled={importingAll} onClick={() => void importAllSkills(source.id, skillTargets)}>
                        <CloudDownload size={14} /> 全部导入{skillTargets.length > 1 ? `（${skillTargets.length}）` : ''}
                      </button>
                    )}
                    <span className="ext-asset-count" title={`共 ${list.length} 个资产`}>{visibleAssets.length} / {list.length}</span>
                  </div>
                  {visibleAssets.length === 0
                    ? <p className="hint">没有匹配的资产。</p>
                    : visibleAssets.map((asset, index) => (
                      <Fragment key={`${asset.kind}-${asset.path}-${index}`}>
                        <div className="ext-asset">
                          <span className="ext-asset-icon">
                            {asset.kind === 'skill' ? <Sparkles size={13} /> : asset.kind === 'marketplace' ? <Store size={13} /> : <Globe size={13} />}
                          </span>
                          <span className="ext-asset-main">
                            <b>{asset.name}</b>
                            {asset.description && <small>{asset.description}</small>}
                            <small className="ext-ref" title={asset.path}>{asset.path}</small>
                          </span>
                          {asset.kind === 'marketplace' && typeof asset.pluginCount === 'number' && (
                            <span className="ext-badge muted" title="marketplace.json 声明的插件数">{asset.pluginCount} 插件</span>
                          )}
                          <span className={`ext-badge ${asset.kind === 'skill' ? '' : 'muted'}`}>{ASSET_KIND_LABELS[asset.kind]}</span>
                          {asset.kind === 'skill' && (asset.importedAs
                            ? <span className="ext-badge muted">已导入为 {asset.importedAs}</span>
                            : <button className="btn" onClick={() => void importSkill(source.id, asset)}><CloudDownload size={14} /> 导入到技能库</button>)}
                          {asset.kind === 'marketplace' && (
                            <div className="ext-card-actions">
                              {isMarketplaceRegistered(asset.name) && <span className="ext-badge" title="已注册为插件市场"><Check size={11} /> 已注册</span>}
                              <button
                                className="btn"
                                disabled={busy}
                                title={`注册为 Claude / ZCode 插件市场：${asset.name}`}
                                onClick={() => void registerMarketplace(source, asset)}
                              >
                                <Store size={14} /> {isMarketplaceRegistered(asset.name) ? '重新注册' : '注册市场'}
                              </button>
                              <button
                                type="button"
                                className={`btn ext-plugin-toggle ${pluginPath === asset.path ? 'open' : ''}`}
                                title={pluginPath === asset.path ? '收起插件清单' : `查看「${asset.name}」的插件清单`}
                                onClick={() => togglePluginList(asset.path)}
                              >
                                {pluginPath === asset.path ? <ChevronDown size={14} /> : <ChevronRight size={14} />} 插件清单
                              </button>
                            </div>
                          )}
                        </div>
                        {asset.kind === 'marketplace' && pluginPath === asset.path && (
                          <MarketplacePluginList sourceId={source.id} asset={asset} />
                        )}
                      </Fragment>
                    ))}
                </>}
              </div>}
            </div>
          })}
        </div>
      )}
    </section>
      </>}
  </div>
}
