/**
 * 技能发现域（自 ExtensionsView.tsx「技能 tab」区原样迁出）：技能库之上叠加折叠「发现技能」区。
 * 本域只单向依赖 shared/ 与 ui / api 基础模块，不与其他域互相 import。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  CloudDownload,
  Globe,
  RefreshCw,
  Search,
  Sparkles
} from 'lucide-react'
import { bridge, useSettings } from '../../../api'
import { ui, isComposingKey } from '../../../ui/interaction-center'
import { EmptyState } from '../../../ui/EmptyState'
import { SkillsTab, StaleBanner } from '../../SkillsView'
import { errText, fmtAgo } from '../shared/ui'
import type { DiscoveredAsset, SkillDiscoveryGroup } from '../../../../../shared/extensions'

/**
 * 技能 tab（EXTENSIONS-HUB §8.7）：技能库之上叠加折叠「发现技能」区——URL 直装（§8.6）+
 * 各扩展源技能资产聚合（sources:list-skills 按源分组，搜索 / 单导 / 按源全部导入）。
 * SkillsTab 本体在 SkillsView.tsx（本轮不改其文件），故导入成功后用 key 重挂载刷新技能列表。
 */
export function SkillsTabWithUrlInstall() {
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
