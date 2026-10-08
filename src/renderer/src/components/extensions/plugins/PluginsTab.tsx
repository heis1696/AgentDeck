/**
 * 插件域（自 ExtensionsView.tsx「插件 tab」+「插件发现区」区原样迁出）：
 * Installed / Discover 两段式盘点装卸 + 已注册市场浏览（MarketBrowse）。
 * 本域只单向依赖 shared/、sources/（添加市场折叠块）与 ui / api 基础模块，不与其他域互相 import。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  FolderOpen,
  LoaderCircle,
  Package,
  Plus,
  Puzzle,
  RefreshCw,
  Store,
  Trash2
} from 'lucide-react'
import { bridge } from '../../../api'
import { ui, isComposingKey } from '../../../ui/interaction-center'
import { EmptyState } from '../../../ui/EmptyState'
import { StaleBanner } from '../../SkillsView'
import { MarketplacePluginPanel } from '../shared/MarketplacePanel'
import { errText } from '../shared/ui'
import { AddMarketplaceBlock } from '../sources/SourceManager'
import type { PluginInventoryItem, RegisteredMarketplace } from '../../../../../shared/extensions'

const CLI_LABELS: Record<PluginInventoryItem['cli'], string> = { claude: 'Claude Code', zcode: 'ZCode', codex: 'Codex' }
const CLI_ORDER: PluginInventoryItem['cli'][] = ['claude', 'zcode', 'codex']
/** 插件 tab 页面 / 空态描述（EXTENSIONS-HUB §8.6 定位：盘点装卸 + 市场浏览） */
const PLUGINS_DESC = '各 agent CLI 已安装插件的盘点与装卸；浏览市场安装新插件。'

/** 插件 tab（EXTENSIONS-HUB §8.7）：Installed / Discover 两段式——三 CLI 已装盘点在上、
 *  发现区在下（「+ 添加市场」折叠块在发现区顶部 + 已注册市场浏览），与 ZCode Plugin Management 同构。 */
export function PluginsTab() {
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
