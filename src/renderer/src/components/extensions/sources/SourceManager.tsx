/**
 * 扩展源管理域（自 ExtensionsView.tsx「扩展源管理（原仓库 tab 迁移）」区原样迁出）：
 * 精选目录 + 自定义 git/本地源 + 已添加源的浏览/导入/注册市场/同步/移除，
 * 经「+ 添加市场」折叠块（AddMarketplaceBlock）整体挂在插件 tab 发现区顶部。
 * 本域只单向依赖 shared/ 与 ui / api 基础模块，不与其他域互相 import。
 */
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  CloudDownload,
  FolderGit2,
  FolderOpen,
  Globe,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Store,
  Trash2
} from 'lucide-react'
import { bridge } from '../../../api'
import { ui, isComposingKey } from '../../../ui/interaction-center'
import { EmptyState } from '../../../ui/EmptyState'
import { StaleBanner } from '../../SkillsView'
import { MarketplacePluginList } from '../shared/MarketplacePanel'
import { errText, filterAssets, fmtAgo } from '../shared/ui'
import type { CatalogEntry, DiscoveredAsset, ExtSourceMeta, MarketplaceStatus } from '../../../../../shared/extensions'

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

/** 「+ 添加市场」折叠块（§8.7）：精选目录 + 自定义源表单 + 已添加源列表，整体迁移自原仓库 tab。 */
export function AddMarketplaceBlock() {
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
