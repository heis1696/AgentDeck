import { useEffect, useState } from 'react'
import { bridge, type AgentInfo as Agent } from '../api'

export function TeamView() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [probes, setProbes] = useState<Record<string, { ok: boolean; detail: string }>>({})
  const [probing, setProbing] = useState(false)
  const [editing, setEditing] = useState<Agent | null>(null)

  useEffect(() => {
    bridge.agents.list().then(setAgents)
  }, [])

  // 主进程逐个推送探测结果，先到先显示（不被最慢的后端拖住）
  useEffect(() => bridge.agents.onProbeResult((id, result) => {
    setProbes((prev) => ({ ...prev, [id]: result }))
  }), [])

  const probeAll = async () => {
    if (probing) return
    setProbing(true)
    try {
      setProbes(await bridge.agents.probe())
    } catch (e) {
      alert('检测失败: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setProbing(false)
    }
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
    setEditing({ id: `ag_${Date.now().toString(36)}`, name: '', backend: 'zcode', color: '#4f8cff', note: '', role: '', systemPrompt: '', subordinates: [] })

  const backends = ['zcode', 'claude', 'codex', 'opencode', 'dsh']

  return (
    <div className="settings team">
      <div className="team-header">
        <h2>队伍（{agents.length} 名队员）</h2>
        <div className="row">
          <button className="btn" onClick={probeAll} disabled={probing}>
            {probing ? '检测中…' : '检测各平台可用性'}
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
                {a.name} <span className="badge">{a.backend}</span>{a.role ? <span className="mini">{a.role}</span> : null}
                {probes[a.backend] && (
                  <span className={probes[a.backend].ok ? 'probe-ok' : 'probe-fail'} title={probes[a.backend].detail}>
                    {probes[a.backend].ok ? '✓' : '✗'}
                  </span>
                )}
              </div>
              <div className="hint">
                {a.subordinates?.length
                  ? `⚡ 可驱使 ${(a.subordinates ?? []).map((sid) => agents.find((x) => x.id === sid)?.name ?? '?').join('、')}（对话中自行派发）`
                  : a.note || (probes[a.backend]?.detail ?? '')}
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
              <span>可驱使的队员（勾选后它成为领队/子领队：对话中可自行把子任务派给他们；领队→子领队→队员最多 3 层）</span>
              <div className="agent-picker">
                {agents.filter((o) => o.id !== editing.id).length === 0 && <span className="hint">（队里还没有其他队员）</span>}
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
                      {o.name}
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
              <span className="hint">勾选可驱使队员即成领队（队员也可以是子领队）；委派在对话中自动发生，无需切模式</span>
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
