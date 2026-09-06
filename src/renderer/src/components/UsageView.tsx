import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Gauge, RefreshCw } from 'lucide-react'
import { bridge, fmtDuration, fmtTokens } from '../api'
import type { AnalyticsSummary, UsageAggregate } from '../../../shared/types'

const empty: UsageAggregate = { runs: 0, completed: 0, failed: 0, cancelled: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, durationMs: 0 }

export function UsageView() {
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [range, setRange] = useState<'7d' | '30d' | 'all'>('7d')
  const since = useMemo(() => range === 'all' ? undefined : Date.now() - (range === '7d' ? 7 : 30) * 86_400_000, [range])
  const refresh = async () => { setLoading(true); try { setSummary(await bridge.analytics.summary({ since })) } finally { setLoading(false) } }
  useEffect(() => { void refresh(); const off = bridge.tasks.onUpdated(() => void refresh()); return off }, [since])
  const total = summary?.totals ?? empty
  const failureRate = total.runs ? Math.round(total.failed / total.runs * 100) : 0
  return <div className="usage-page">
    <header className="page-header-bar"><div className="page-title-row"><Gauge size={16} className="page-icon" /><h2 className="page-title">用量与错误</h2><span className="page-desc">token、成本、运行时长与失败情况的聚合统计。</span></div><button className="btn" onClick={() => void refresh()} disabled={loading}><RefreshCw size={14} className={loading ? 'spin' : ''} /> 刷新</button></header>
    <div className="usage-range usage-range-top"><button className={range === '7d' ? 'active' : ''} onClick={() => setRange('7d')}>近 7 天</button><button className={range === '30d' ? 'active' : ''} onClick={() => setRange('30d')}>近 30 天</button><button className={range === 'all' ? 'active' : ''} onClick={() => setRange('all')}>全部</button></div>
    {loading && !summary ? <div className="empty"><Gauge size={32} /><span>统计加载中…</span></div> : <>
      <div className="usage-cards"><Kpi value={fmtTokens(total.inputTokens + total.outputTokens)} label={`tokens · 输入 ${fmtTokens(total.inputTokens)} / 输出 ${fmtTokens(total.outputTokens)}`} /><Kpi value={total.costUsd ? `$${total.costUsd.toFixed(2)}` : '—'} label="预估成本" /><Kpi value={String(total.runs)} label={`${total.completed} 次成功 · ${total.failed} 次失败`} /><Kpi value={`${failureRate}%`} label="失败率" danger={failureRate > 0} /></div>
      <section className="usage-analytics"><div className="usage-analytics-head"><h3>失败构成</h3><span className="usage-subtle">{summary?.errors.length ?? 0} 类错误</span></div>{summary?.errors.length ? <div className="error-mix">{summary.errors.map((error) => <div className="error-mix-row" key={error.code}><span className="error-mix-title"><AlertTriangle size={13} />{error.title}</span><span className="error-mix-track"><i style={{ width: `${Math.max(5, error.count / Math.max(...summary.errors.map((item) => item.count)) * 100)}%` }} /></span><b>{error.count}</b><span className="mini">{error.retryable ? '可重试' : error.code}</span></div>)}</div> : <div className="list-empty">该时段没有失败记录。</div>}</section>
      <section className="usage-analytics"><div className="usage-analytics-head"><h3>按运行时</h3><span className="usage-subtle">运行次数与 token 占比</span></div><AggregateRows rows={summary?.byBackend ?? []} total={total} /></section>
      <section className="usage-table-wrap"><table className="usage-table"><thead><tr><th>队员</th><th>运行次数</th><th>成功</th><th>失败</th><th>Tokens</th><th>成本</th><th>用时</th></tr></thead><tbody>{summary?.byAgent.map((row) => <tr key={row.key}><td>{row.label}</td><td>{row.runs}</td><td>{row.completed}</td><td className={row.failed ? 'error-text' : ''}>{row.failed}</td><td>{fmtTokens(row.inputTokens + row.outputTokens)}</td><td>{row.costUsd ? `$${row.costUsd.toFixed(2)}` : '—'}</td><td>{row.durationMs ? fmtDuration(row.durationMs) : '—'}</td></tr>)}</tbody></table>{!summary?.byAgent.length && <div className="list-empty">该时段没有队员活动。</div>}</section>
    </>}
  </div>
}

function Kpi({ value, label, danger }: { value: string; label: string; danger?: boolean }) { return <div className="usage-card"><span className={`usage-kpi ${danger ? 'error-text' : ''}`}>{value}</span><span className="usage-label">{label}</span></div> }
function AggregateRows({ rows, total }: { rows: Array<UsageAggregate & { key: string; label: string }>; total: UsageAggregate }) { return <div className="usage-model-list">{rows.length ? rows.map((row) => { const amount = row.inputTokens + row.outputTokens; const share = total.inputTokens + total.outputTokens ? Math.round(amount / (total.inputTokens + total.outputTokens) * 100) : 0; return <div className="usage-model-row" key={row.key}><span className="usage-model-name"><i />{row.label}</span><span className="usage-model-track"><i style={{ width: `${Math.max(share, 2)}%` }} /></span><b>{share}%</b><span>{fmtTokens(amount)}</span></div> }) : <div className="list-empty">该时段没有运行时活动。</div>}</div> }
