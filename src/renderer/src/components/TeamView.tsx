import { useEffect, useState } from 'react'
import { bridge } from '../api'

interface Agent {
  id: string
  name: string
  backend: string
  model?: string
  note?: string
  color: string
}

export function TeamView() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [probes, setProbes] = useState<Record<string, { ok: boolean; detail: string }>>({})
  const [editing, setEditing] = useState<Agent | null>(null)

  useEffect(() => {
    bridge.agents.list().then(setAgents)
  }, [])

  const probeAll = async () => {
    setProbes(await bridge.agents.probe())
  }
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
    setEditing({ id: `ag_${Date.now().toString(36)}`, name: '', backend: 'zcode', color: '#4f8cff', note: '' })

  const backends = ['zcode', 'claude', 'codex', 'opencode']

  return (
    <div className="settings team">
      <div className="team-header">
        <h2>队伍（{agents.length} 名队员）</h2>
        <div className="row">
          <button className="btn" onClick={probeAll}>
            检测各平台可用性
          </button>
          <button className="btn primary" onClick={add}>
            ＋ 加队员
          </button>
        </div>
      </div>

      <div className="agent-grid">
        {agents.map((a) => (
          <div key={a.id} className="agent-card" onClick={() => setEditing(a)}>
            <div className="agent-avatar" style={{ background: a.color }}>
              {a.name.slice(0, 1)}
            </div>
            <div className="agent-info">
              <div className="agent-name">
                {a.name} <span className="badge">{a.backend}</span>
                {probes[a.backend] && (
                  <span className={probes[a.backend].ok ? 'probe-ok' : 'probe-fail'} title={probes[a.backend].detail}>
                    {probes[a.backend].ok ? '✓' : '✗'}
                  </span>
                )}
              </div>
              <div className="hint">{a.note || (probes[a.backend]?.detail ?? '')}</div>
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
            <h2>{agents.some((a) => a.id === editing.id) ? '编辑队员' : '新队员'}</h2>
            <label className="field">
              <span>名字 *</span>
              <input value={editing.name} onChange={(e) => update(editing, { name: e.target.value })} autoFocus />
            </label>
            <label className="field">
              <span>平台 *</span>
              <select value={editing.backend} onChange={(e) => update(editing, { backend: e.target.value })}>
                {backends.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>说明（给领队看的专长描述）</span>
              <input value={editing.note ?? ''} onChange={(e) => update(editing, { note: e.target.value })} placeholder="如：擅长前端 React" />
            </label>
            <label className="field">
              <span>头像色</span>
              <input type="color" value={editing.color} onChange={(e) => update(editing, { color: e.target.value })} />
            </label>
            <div className="dialog-footer">
              <span className="hint">squad 规划时领队会看到队员名单和说明，可指定队员执行子任务</span>
              <button className="btn primary" onClick={commit} disabled={!editing.name.trim()}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
