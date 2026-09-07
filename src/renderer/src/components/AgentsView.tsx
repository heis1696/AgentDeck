import { useEffect, useState } from 'react'
import { bridge, type AgentInfo as Agent, type AgentModelCatalog, type ApiPresetInfo as Preset } from '../api'
import { Users, KeyRound } from 'lucide-react'
import { toast } from '../ui/Toasts'
import { Menu } from '../ui/Menu'
import { BACKEND_IDS } from '../../../shared/types'

/** v1 支持预设注入执行的平台：zcode（runtimeModel）/ claude（spawn env） */
const PRESET_BACKENDS = ['zcode', 'claude']

/** Agent 管理页（顶级 tab）：Agent 身份 + API 预设（连接档案）两个分区。
 *  预设按平台存多套（cc-switch 式），但零全局切换——agent 引用预设后，
 *  连接与模型只在它的会话里内存注入。模型列表从预设在线拉取。 */
export function AgentsView() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [presets, setPresets] = useState<Preset[]>([])
  const [editing, setEditing] = useState<Agent | null>(null)
  const [editingPreset, setEditingPreset] = useState<Preset | null>(null)
  /** 模型目录：选了预设 → 从预设在线拉取；否则用平台目录（zcode）/ 预设 */
  const [catalog, setCatalog] = useState<AgentModelCatalog | null>(null)
  const [fetching, setFetching] = useState(false)

  useEffect(() => {
    bridge.agents.list().then(setAgents)
    bridge.presets.list().then(setPresets)
  }, [])

  const refreshCatalog = (backend: string, presetId?: string) => {
    setCatalog(null)
    if (!backend) return
    const source = presetId ? bridge.presets.models(presetId) : bridge.agents.models(backend)
    source.then((c) => setCatalog(c)).catch(() => setCatalog(null))
  }

  useEffect(() => {
    if (!editing) return
    refreshCatalog(editing.backend, editing.presetId)
  }, [editing?.backend, editing?.presetId])

  const refetchCatalog = () => {
    if (!editing) return
    setFetching(true)
    const source = editing.presetId ? bridge.presets.models(editing.presetId) : bridge.agents.models(editing.backend)
    source.then((c) => { setCatalog(c); toast.success(`获取到 ${c.models.length} 个模型`) }).catch((e) => toast.error('获取模型失败: ' + (e instanceof Error ? e.message : String(e)))).finally(() => setFetching(false))
  }

  const saveAgents_ = async (list: Agent[]) => {
    setAgents(await bridge.agents.save(list))
  }
  const savePresets_ = async (list: Preset[]) => {
    setPresets(await bridge.presets.save(list))
  }
  const update = (a: Agent, patch: Partial<Agent>) => {
    setEditing({ ...a, ...patch })
  }
  const commit = () => {
    if (!editing) return
    const exists = agents.some((a) => a.id === editing.id)
    saveAgents_(exists ? agents.map((a) => (a.id === editing.id ? editing : a)) : [...agents, editing])
    setEditing(null)
  }
  const remove = (id: string) => saveAgents_(agents.filter((a) => a.id !== id))
  const add = () =>
    setEditing({ id: `ag_${Date.now().toString(36)}`, name: '', backend: 'zcode', color: '#4f8cff', note: '', role: '', systemPrompt: '', subordinates: [], model: '', presetId: '' })
  const addPreset = async () => {
    const id = await bridge.presets.newId()
    setEditingPreset({ id, name: '', backend: 'zcode', baseURL: '', apiKey: '', note: '', createdAt: Date.now() })
  }
  const commitPreset = () => {
    if (!editingPreset) return
    const exists = presets.some((p) => p.id === editingPreset.id)
    savePresets_(exists ? presets.map((p) => (p.id === editingPreset.id ? editingPreset : p)) : [...presets, editingPreset])
    setEditingPreset(null)
  }
  const removePreset = (id: string) => {
    // 清掉引用该预设的 agent，避免悬空 presetId
    saveAgents_(agents.filter((a) => a.presetId !== id).map((a) => ({ ...a, presetId: undefined })))
    savePresets_(presets.filter((p) => p.id !== id))
  }
  const testPreset = (p: Preset) => {
    toast.info(`正在从 ${p.name} 拉取模型…`)
    bridge.presets.models(p.id).then((c) => toast.success(`${p.name}：${c.models.length} 个模型（${c.models.slice(0, 3).join('、')}${c.models.length > 3 ? '…' : ''}）`)).catch((e) => toast.error('拉取失败: ' + (e instanceof Error ? e.message : String(e))))
  }

  const editingPresetRef = editing?.presetId ? presets.find((p) => p.id === editing.presetId) : undefined
  const backendPresets = presets.filter((p) => p.backend === editing?.backend)

  const actions = (
    <div className="detail-actions">
      <button className="btn" onClick={addPreset}><KeyRound size={14} /> 新建 API 预设</button>
      <button className="btn primary" onClick={add}>＋ 新建 Agent</button>
    </div>
  )

  const presetSection = (
    <section className="preset-section">
      <div className="section-heading"><h3>API 预设</h3><span>按平台存多套连接（baseURL / 密钥）；Agent 选取后在它的会话里生效，不改全局配置。zcode / claude 支持注入执行。</span></div>
      <div className="agent-grid">
        {presets.map((p) => (
          <div key={p.id} className="agent-card" role="button" tabIndex={0} onClick={() => setEditingPreset(p)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setEditingPreset(p) } }}>
            <div className="agent-avatar" style={{ background: '#8b95a5' }}><KeyRound size={16} /></div>
            <div className="agent-info">
              <div className="agent-name">{p.name} <span className="badge">{p.backend}</span></div>
              <div className="hint">{p.baseURL} · 密钥 ••••{p.apiKey.slice(-4)}</div>
            </div>
            <button className="btn ghost agent-del" title="拉取模型列表" onClick={(e) => { e.stopPropagation(); testPreset(p) }}>↻</button>
            <button className="btn ghost agent-del" title="删除" onClick={(e) => { e.stopPropagation(); removePreset(p.id) }}>✕</button>
          </div>
        ))}
        {presets.length === 0 && <span className="hint">还没有预设——新建一个，或留空让 Agent 走平台默认连接。</span>}
      </div>
    </section>
  )

  const grid = (
    <>
      <div className="agent-grid">
        {agents.map((a) => {
          const preset = presets.find((p) => p.id === a.presetId)
          return (
            <div key={a.id} className="agent-card" role="button" tabIndex={0} onClick={() => setEditing(a)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setEditing(a) } }}>
              <div className="agent-avatar" style={{ background: a.color }}>{a.name.slice(0, 1)}</div>
              <div className="agent-info">
                <div className="agent-name">
                  {a.name} <span className="badge">{a.backend}</span>{a.model ? <span className="badge">{a.model}</span> : null}{a.role ? <span className="mini">{a.role}</span> : null}
                </div>
                <div className="hint">
                  {a.subordinates?.length
                    ? `⚡ 可驱使 ${(a.subordinates ?? []).map((sid) => agents.find((x) => x.id === sid)?.name ?? '?').join('、')}（对话中自行派发）`
                    : preset ? `连接：${preset.name} · ${preset.baseURL}` : a.note || '（平台默认连接）'}
                </div>
              </div>
              <button className="btn ghost agent-del" onClick={(e) => { e.stopPropagation(); remove(a.id) }}>✕</button>
            </div>
          )
        })}
      </div>

      {editingPreset && (
        <div className="overlay" onClick={(e) => e.target === e.currentTarget && setEditingPreset(null)}>
          <div className="dialog">
            <h2>{presets.some((p) => p.id === editingPreset.id) ? '编辑 API 预设' : '新建 API 预设'}</h2>
            <label className="field"><span>名称 *</span><input value={editingPreset.name} onChange={(e) => setEditingPreset({ ...editingPreset, name: e.target.value })} placeholder="如：智谱官方 / 某中转站" autoFocus /></label>
            <label className="field">
              <span>平台 *</span>
              <Menu
                items={PRESET_BACKENDS.map((b) => ({ value: b, label: b }))}
                value={editingPreset.backend}
                onChange={(v) => setEditingPreset({ ...editingPreset, backend: v })}
                trigger={(cur, open) => (
                  <button className="btn menu-trigger" type="button">{cur?.label ?? editingPreset.backend} <span className="menu-caret">{open ? '▴' : '▾'}</span></button>
                )}
              />
            </label>
            <label className="field"><span>Base URL *</span><input value={editingPreset.baseURL} onChange={(e) => setEditingPreset({ ...editingPreset, baseURL: e.target.value })} placeholder="https://api.z.ai/api/anthropic" /></label>
            <label className="field"><span>API Key *</span><input type="password" value={editingPreset.apiKey} onChange={(e) => setEditingPreset({ ...editingPreset, apiKey: e.target.value })} placeholder="sk-…" /></label>
            <label className="field"><span>备注</span><input value={editingPreset.note ?? ''} onChange={(e) => setEditingPreset({ ...editingPreset, note: e.target.value })} /></label>
            <div className="dialog-footer">
              <span className="hint">只存本机（userData/api-presets.json）；保存后可用列表里的 ↻ 测试拉取</span>
              <button className="btn primary" onClick={commitPreset} disabled={!editingPreset.name.trim() || !editingPreset.baseURL.trim() || !editingPreset.apiKey.trim()}>保存</button>
            </div>
          </div>
        </div>
      )}

      {editing && (
        <div className="overlay" onClick={(e) => e.target === e.currentTarget && setEditing(null)}>
          <div className="dialog">
            <h2>{agents.some((a) => a.id === editing.id) ? '编辑 Agent' : '新建 Agent'}</h2>
            <label className="field">
              <span>名字 *</span>
              <input value={editing.name} onChange={(e) => update(editing, { name: e.target.value })} autoFocus />
            </label>
            <label className="field">
              <span>平台 *</span>
              <Menu
                items={BACKEND_IDS.map((b) => ({ value: b, label: b }))}
                value={editing.backend}
                onChange={(v) => update(editing, { backend: v, ...(editing.presetId ? { presetId: '' } : {}) })}
                trigger={(cur, open) => (
                  <button className="btn menu-trigger" type="button">
                    {cur?.label ?? editing.backend} <span className="menu-caret">{open ? '▴' : '▾'}</span>
                  </button>
                )}
              />
            </label>
            {PRESET_BACKENDS.includes(editing.backend) && (
              <label className="field">
                <span>API 预设（连接覆盖；可空 = 平台默认连接）</span>
                <Menu
                  items={[{ value: '', label: '不使用（平台默认）' }, ...backendPresets.map((p) => ({ value: p.id, label: `${p.name}（${p.baseURL}）` }))]}
                  value={editing.presetId ?? ''}
                  onChange={(v) => update(editing, { presetId: v })}
                  trigger={(cur, open) => (
                    <button className="btn menu-trigger" type="button">
                      {cur?.label ?? '不使用（平台默认）'} <span className="menu-caret">{open ? '▴' : '▾'}</span>
                    </button>
                  )}
                />
              </label>
            )}
            <label className="field">
              <span>模型{editingPresetRef ? '（从预设拉取）' : '（空 = 平台默认）'}；同平台多个 Agent 可各钉不同模型</span>
              <div className="row" style={{ gap: 8 }}>
                <input
                  style={{ flex: 1 }}
                  value={editing.model ?? ''}
                  onChange={(e) => update(editing, { model: e.target.value })}
                  placeholder={catalog?.source === 'catalog' ? catalog.default ?? '平台默认' : '如 glm-5.3 / sonnet / gpt-5.5'}
                />
                <button className="btn" type="button" disabled={fetching || (editing.backend === 'zcode' && !editing.presetId)} onClick={refetchCatalog}>
                  {fetching ? '拉取中…' : '↻ 获取模型'}
                </button>
              </div>
              {editing.backend !== 'zcode' && !editing.presetId && <span className="hint">该平台无本地模型目录，可自由填写，或选 API 预设后在线获取</span>}
              {catalog && catalog.models.length > 0 && (
                <div className="agent-picker">
                  {catalog.models.map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={`agent-pick ${(editing.model ?? '') === m ? 'active' : ''}`}
                      onClick={() => update(editing, { model: (editing.model ?? '') === m ? '' : m })}
                    >
                      {m}{catalog.default === m ? ' · 默认' : ''}
                    </button>
                  ))}
                </div>
              )}
            </label>
            <label className="field">
              <span>定位（头衔：领队 / 工程师 / 审查员…）</span>
              <input value={editing.role ?? ''} onChange={(e) => update(editing, { role: e.target.value })} placeholder="领队" />
            </label>
            <label className="field">
              <span>系统提示词（人设/专长/做事方式，注入它的每个任务）</span>
              <textarea
                value={editing.systemPrompt ?? ''}
                onChange={(e) => update(editing, { systemPrompt: e.target.value })}
                rows={5}
                placeholder="你是资深前端工程师，擅长 React/TS。写代码前先读现有实现…"
              />
            </label>
            <label className="field">
              <span>可驱使的 Agent（勾选后它成为领队/子领队：对话中可自行把子任务派给他们；领队→子领队→队员最多 3 层）</span>
              <div className="agent-picker">
                {agents.filter((o) => o.id !== editing.id).length === 0 && <span className="hint">（还没有其他 Agent）</span>}
                {agents
                  .filter((o) => o.id !== editing.id)
                  .map((o) => (
                    <button
                      key={o.id}
                      className={`agent-pick ${(editing.subordinates ?? []).includes(o.id) ? 'active' : ''}`}
                      onClick={() =>
                        update(editing, {
                          subordinates: (editing.subordinates ?? []).includes(o.id)
                            ? (editing.subordinates ?? []).filter((x) => x !== o.id)
                            : [...(editing.subordinates ?? []), o.id]
                        })
                      }
                    >
                      <span className="agent-avatar sm" style={{ background: o.color }}>
                        {o.name.slice(0, 1)}
                      </span>
                      {o.name}{o.model ? <span className="mini">{o.model}</span> : null}
                    </button>
                  ))}
              </div>
            </label>
            <label className="field">
              <span>备注（列表展示用）</span>
              <input value={editing.note ?? ''} onChange={(e) => update(editing, { note: e.target.value })} placeholder="如：擅长前端 React" />
            </label>
            <label className="field">
              <span>头像色</span>
              <input type="color" value={editing.color} onChange={(e) => update(editing, { color: e.target.value })} />
            </label>
            <div className="dialog-footer">
              <span className="hint">重名会自动加后缀（委派按名字匹配）；预设须搭配模型使用</span>
              <button className="btn primary" onClick={commit} disabled={!editing.name.trim()}>保存</button>
            </div>
          </div>
        </div>
      )}
    </>
  )

  return (
    <div className="settings team">
      <header className="page-header-bar">
        <div className="detail-title-wrap">
          <div className="page-title-row">
            <Users size={16} className="page-icon" />
            <h2 className="page-title">Agent</h2>
            {agents.length > 0 && <span className="page-count">{agents.length}</span>}
            <span className="page-desc">同一平台可建多个 Agent，各自钉死 API 预设与模型；勾选可驱使名单的 Agent 成为领队。</span>
          </div>
        </div>
        {actions}
      </header>
      {grid}
      {presetSection}
    </div>
  )
}
