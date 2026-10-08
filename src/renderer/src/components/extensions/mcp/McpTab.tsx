/**
 * MCP 域（自 ExtensionsView.tsx「MCP tab」区原样迁出）：共享目录服务器定义 + 三目标安装 chip。
 * 本域只单向依赖 shared/ 与 ui / api 基础模块，不与其他域互相 import。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle, Plus, RefreshCw, Search, Server, Trash2 } from 'lucide-react'
import { bridge, useSettings } from '../../../api'
import { ui } from '../../../ui/interaction-center'
import { EmptyState } from '../../../ui/EmptyState'
import { StaleBanner } from '../../SkillsView'
import {
  TargetChips,
  TargetStates,
  aggregateState,
  errText,
  linesToArray,
  linesToRecord,
  recordToLines
} from '../shared/ui'
import type { McpMeta, McpTarget, McpTransport } from '../../../../../shared/extensions'

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
export function McpTab() {
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
