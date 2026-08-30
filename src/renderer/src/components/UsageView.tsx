import { useEffect, useMemo, useState } from 'react'
import { bridge, fmtDuration, fmtTokens, type AgentInfo } from '../api'
import type { Task } from '../../../shared/types'

interface Row {
  key: string
  name: string
  backend: string
  color?: string
  total: number
  done: number
  failed: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  wallMs: number
}

function emptyRow(key: string, name: string, backend: string, color?: string): Row {
  return { key, name, backend, color, total: 0, done: 0, failed: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, wallMs: 0 }
}

function fold(row: Row, t: Task) {
  row.total++
  if (t.status === 'done') row.done++
  if (t.status === 'failed') row.failed++
  const u = t.usage
  if (u) {
    row.inputTokens += u.inputTokens
    row.outputTokens += u.outputTokens
    row.costUsd += u.costUsd
  }
  if (t.startedAt && t.endedAt) row.wallMs += t.endedAt - t.startedAt
}

/** 用量聚合页：纯前端 reduce tasks（数据都已在 Task 上） */
export function UsageView() {
  const { tasks } = bridgeTasks()
  const [agents, setAgents] = useState<AgentInfo[]>([])

  useEffect(() => {
    bridge.agents.list().then(setAgents)
  }, [])

  const { byAgent, byBackend, total } = useMemo(() => {
    const agentMap = new Map<string, Row>()
    const backendMap = new Map<string, Row>()
    const sum = emptyRow('__total', '合计', '')
    for (const t of tasks) {
      const agent = agents.find((a) => a.id === t.agentId)
      const ak = t.agentId ?? '_none'
      if (!agentMap.has(ak)) agentMap.set(ak, emptyRow(ak, agent?.name ?? '（未指定队员）', t.backend, agent?.color))
      const aRow = agentMap.get(ak)!
      fold(aRow, t)
      if (!backendMap.has(t.backend)) backendMap.set(t.backend, emptyRow(t.backend, t.backend, t.backend))
      fold(backendMap.get(t.backend)!, t)
      fold(sum, t)
    }
    return {
      byAgent: [...agentMap.values()].sort((a, b) => b.costUsd - a.costUsd || b.total - a.total),
      byBackend: [...backendMap.values()].sort((a, b) => b.total - a.total),
      total: sum
    }
  }, [tasks, agents])

  return (
    <div className="usage-page">
      <header className="page-head">
        <h2>用量</h2>
        <p className="hint">按队员与平台聚合全部任务的 token、成本与耗时（完成时从回合用量累计）。</p>
      </header>

      <div className="usage-cards">
        <div className="usage-card">
          <span className="usage-kpi">{fmtTokens(total.inputTokens + total.outputTokens)}</span>
          <span className="usage-label">tokens（入 {fmtTokens(total.inputTokens)} / 出 {fmtTokens(total.outputTokens)}）</span>
        </div>
        <div className="usage-card">
          <span className="usage-kpi">{total.costUsd > 0 ? `$${total.costUsd.toFixed(2)}` : '—'}</span>
          <span className="usage-label">估算成本</span>
        </div>
        <div className="usage-card">
          <span className="usage-kpi">{total.total}</span>
          <span className="usage-label">任务（{total.done} 完成 · {total.failed} 失败）</span>
        </div>
        <div className="usage-card">
          <span className="usage-kpi">{total.wallMs ? fmtDuration(total.wallMs) : '—'}</span>
          <span className="usage-label">累计执行时长</span>
        </div>
      </div>

      <section className="usage-table-wrap">
        <table className="usage-table">
          <thead>
            <tr>
              <th>队员</th><th>平台</th><th>任务</th><th>完成/失败</th>
              <th>输入 tok</th><th>输出 tok</th><th>成本</th><th>执行时长</th>
            </tr>
          </thead>
          <tbody>
            {byAgent.map((r) => (
              <tr key={r.key}>
                <td>
                  <span className="agent-avatar xs" style={{ background: r.color ?? '#666' }}>{r.name.slice(0, 1)}</span> {r.name}
                </td>
                <td><span className="badge">{r.backend}</span></td>
                <td>{r.total}</td>
                <td className="mini">{r.done} / {r.failed}</td>
                <td>{fmtTokens(r.inputTokens)}</td>
                <td>{fmtTokens(r.outputTokens)}</td>
                <td>{r.costUsd > 0 ? `$${r.costUsd.toFixed(2)}` : '—'}</td>
                <td>{r.wallMs ? fmtDuration(r.wallMs) : '—'}</td>
              </tr>
            ))}
            {byAgent.length === 0 && (
              <tr><td colSpan={8} className="list-empty">暂无任务</td></tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="usage-table-wrap">
        <div className="list-group-label">按平台</div>
        <table className="usage-table">
          <thead>
            <tr><th>平台</th><th>任务</th><th>输入 tok</th><th>输出 tok</th><th>成本</th></tr>
          </thead>
          <tbody>
            {byBackend.map((r) => (
              <tr key={r.key}>
                <td><span className="badge">{r.name}</span></td>
                <td>{r.total}</td>
                <td>{fmtTokens(r.inputTokens)}</td>
                <td>{fmtTokens(r.outputTokens)}</td>
                <td>{r.costUsd > 0 ? `$${r.costUsd.toFixed(2)}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  )
}

/** 轻封装：任务列表 + 实时刷新（与 useTasks 一致，但避免双份请求竞争这里的聚合） */
function bridgeTasks() {
  const [tasks, setTasks] = useState<Task[]>([])
  useEffect(() => {
    let alive = true
    const refresh = async () => {
      const list = await bridge.tasks.list()
      if (alive) setTasks(list)
    }
    void refresh()
    const off = bridge.tasks.onUpdated(() => void refresh())
    return () => {
      alive = false
      off()
    }
  }, [])
  return { tasks }
}
