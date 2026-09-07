import { useEffect, useState } from 'react'
import { bridge, type AgentInfo as Agent, type AgentModelCatalog } from '../api'
import { Users } from 'lucide-react'
import { Menu } from '../ui/Menu'
import { BACKEND_IDS } from '../../../shared/types'

/** Agent 管理页（0.15 起从设置"队伍"分区提级为顶级 tab）。
 *  同一平台可建多个 Agent，各自钉死不同模型（Agent.model 会话级注入，执行层不走全局配置）。
 *  平台可用性检测归设置-运行时分区，本页只管身份与配置。 */
export function AgentsView() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [editing, setEditing] = useState<Agent | null>(null)
  const [catalog, setCatalog] = useState<AgentModelCatalog | null>(null)

  useEffect(() => {
    bridge.agents.list().then(setAgents)
  }, [])

  // 模型目录随平台切换刷新（zcode 有本地目录，其余平台自由填写 + 预设）
  useEffect(() => {
    if (!editing) return
    let alive = true
    bridge.agents
      .models(editing.backend)
      .then((c) => { if (alive) setCatalog(c) })
      .catch(() => { if (alive) setCatalog(null) })
    return () => { alive = false }
  }, [editing?.backend])

  const save = async (list: Agent[]) => {
    setAgents(await bridge.agents.save(list))
  }
  const update = (a: Agent, patch: Partial<Agent>) => {
    setEditing({ ...a, ...patch })
  }
  const commit = () => {
    if (!editing) return
    const exists = agents.some((a) => a.id === editing.id)
    save(exists ? agents.map((a) => (a.id === editing.id ? editing : a)) : [...agents, editing])
    setEditing(null)
  }
  const remove = (id: string) => save(agents.filter((a) => a.id !== id))
  const add = () =>
    setEditing({ id: `ag_${Date.now().toString(36)}`, name: '', backend: 'zcode', color: '#4f8cff', note: '', role: '', systemPrompt: '', subordinates: [], model: '' })

  const actions = (
    <div className="detail-actions">
      <button className="btn primary" onClick={add}>
        ＋ 新建 Agent
      </button>
    </div>
  )

  const grid = (
    <>
      <div className="agent-grid">
        {agents.map((a) => (
          <div key={a.id} className="agent-card" role="button" tabIndex={0} onClick={() => setEditing(a)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setEditing(a) } }}>
            <div className="agent-avatar" style={{ background: a.color }}>
              {a.name.slice(0, 1)}
            </div>
            <div className="agent-info">
              <div className="agent-name">
                {a.name} <span className="badge">{a.backend}</span>{a.model ? <span className="badge">{a.model}</span> : null}{a.role ? <span className="mini">{a.role}</span> : null}
              </div>
              <div className="hint">
                {a.subordinates?.length
                  ? `⚡ 可驱使 ${(a.subordinates ?? []).map((sid) => agents.find((x) => x.id === sid)?.name ?? '?').join('、')}（对话中自行派发）`
                  : a.note || '（无备注）'}
              </div>
            </div>
            <button
              className="btn ghost agent-del"
              onClick={(e) => {
                e.stopPropagation()
                remove(a.id)
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

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
                onChange={(v) => update(editing, { backend: v })}
                trigger={(cur, open) => (
                  <button className="btn menu-trigger" type="button">
                    {cur?.label ?? editing.backend} <span className="menu-caret">{open ? '▴' : '▾'}</span>
                  </button>
                )}
              />
            </label>
            <label className="field">
              <span>模型（空 = 平台默认；同平台多个 Agent 可各钉不同模型，执行时按会话注入）</span>
              <input
                value={editing.model ?? ''}
                onChange={(e) => update(editing, { model: e.target.value })}
                placeholder={catalog?.source === 'catalog' ? catalog.default ?? '平台默认' : '如 glm-5.3 / sonnet / gpt-5.5（自由填写）'}
              />
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
              <span className="hint">重名会自动加后缀（委派按名字匹配）；平台检测在设置-运行时</span>
              <button className="btn primary" onClick={commit} disabled={!editing.name.trim()}>
                保存
              </button>
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
            <span className="page-desc">同一平台可建多个 Agent，各钉不同模型；勾选可驱使名单的 Agent 成为领队。</span>
          </div>
        </div>
        {actions}
      </header>
      {grid}
    </div>
  )
}
