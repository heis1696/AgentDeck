/**
 * 市场插件展示层（自 ExtensionsView.tsx 原样迁出）：EXTENSIONS-HUB §8.4 抽取的可复用展示层，
 * 供扩展源管理的源内市场清单（MarketplacePluginList）与插件 tab 发现区的已注册市场浏览（MarketBrowse）共用。
 * 各域单向依赖本目录，本目录不得反向 import 任何域。
 */
import { useEffect, useMemo, useState } from 'react'
import { Check, CloudDownload, Package, Search } from 'lucide-react'
import { bridge } from '../../../api'
import { ui } from '../../../ui/interaction-center'
import { errText } from './ui'
import type { DiscoveredAsset, MarketplacePluginInfo } from '../../../../../shared/extensions'

/**
 * 市场插件面板：搜索框 + 分类下拉 + 逐项安装 + 已装徽标（EXTENSIONS-HUB §8.4 抽取的可复用展示层），
 * 供扩展源管理的源内市场清单（MarketplacePluginList）与插件 tab 发现区的已注册市场浏览共用。
 * install spec = 插件名@市场名；canInstall=false（市场未注册到 claude）时降级为「不可安装」徽标。
 */
export function MarketplacePluginPanel({ marketplaceName, plugins, loading, error, canInstall = true, onInstalled }: {
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

/**
 * marketplace.json 插件清单（浏览展开态内联）：展开时才经 listPlugins 拉取，
 * 展示层复用 MarketplacePluginPanel，安装成功后本项翻转为「已安装」。
 */
export function MarketplacePluginList({ sourceId, asset }: { sourceId: string; asset: DiscoveredAsset }) {
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
