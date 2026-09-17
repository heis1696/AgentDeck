import { useEffect, useMemo, useState } from 'react'
import { Activity, AlertTriangle, CheckCircle2, Coins, Gauge, RefreshCw, Server, Timer, Users, Wallet } from 'lucide-react'
import { bridge, fmtDuration, fmtTokens } from '../api'
import type { AnalyticsSummary, UsageAggregate } from '../../../shared/types'

const empty: UsageAggregate = { runs: 0, completed: 0, failed: 0, cancelled: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, durationMs: 0 }

/** 运行时分布的固定色板（按占比顺序取色，与状态色无冲突） */
const BACKEND_HUES = ['#4bc0c8', '#e3a84b', '#8f7ff0', '#58c58a', '#5b9dff', '#ef7168', '#d8739e']

type Range = '7d' | '30d' | 'all'

interface TrendBucket {
  key: string
  label: string
  full: string
  runs: number
  failed: number
  inputTokens: number
  outputTokens: number
}

const pad2 = (n: number) => `${n}`.padStart(2, '0')
const dayKeyOf = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

/** 把每日序列装进图表桶：7/30 天按天补零；「全部」跨度 >60 天时并成月桶 */
function buildTrend(summary: AnalyticsSummary | null, range: Range): TrendBucket[] {
  const byDay = summary?.byDay ?? []
  if (!byDay.length) return []
  const byKey = new Map(byDay.map((d) => [d.date, d]))
  const today = new Date()
  const first = new Date(`${byDay[0].date}T00:00:00`)
  const spanDays = Math.round((today.getTime() - first.getTime()) / 86_400_000)
  const monthMode = range === 'all' && spanDays > 60
  const buckets: TrendBucket[] = []
  if (monthMode) {
    const start = new Date(first.getFullYear(), first.getMonth(), 1)
    const end = new Date(today.getFullYear(), today.getMonth(), 1)
    for (const cursor = start; cursor <= end; cursor.setMonth(cursor.getMonth() + 1)) {
      const key = `${cursor.getFullYear()}-${pad2(cursor.getMonth() + 1)}`
      const row = byKey.get(key)
      buckets.push({
        key,
        label: `${cursor.getMonth() + 1}月`,
        full: key,
        runs: row?.runs ?? 0,
        failed: row?.failed ?? 0,
        inputTokens: row?.inputTokens ?? 0,
        outputTokens: row?.outputTokens ?? 0
      })
    }
  } else {
    const start = range === '7d' ? new Date(today.getTime() - 6 * 86_400_000)
      : range === '30d' ? new Date(today.getTime() - 29 * 86_400_000)
      : new Date(`${byDay[0].date}T00:00:00`)
    for (const cursor = new Date(start); cursor <= today; cursor.setDate(cursor.getDate() + 1)) {
      const key = dayKeyOf(cursor)
      const row = byKey.get(key)
      buckets.push({
        key,
        label: `${pad2(cursor.getMonth() + 1)}-${pad2(cursor.getDate())}`,
        full: key,
        runs: row?.runs ?? 0,
        failed: row?.failed ?? 0,
        inputTokens: row?.inputTokens ?? 0,
        outputTokens: row?.outputTokens ?? 0
      })
    }
  }
  return buckets
}

/** Catmull-Rom → 三次贝塞尔，产出平滑曲线 path */
function smoothPath(pts: Array<[number, number]>): string {
  if (!pts.length) return ''
  if (pts.length === 1) return `M ${pts[0][0]},${pts[0][1]}`
  let d = `M ${pts[0][0]},${pts[0][1]}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[Math.min(pts.length - 1, i + 2)]
    const c1x = p1[0] + (p2[0] - p0[0]) / 6
    const c1y = p1[1] + (p2[1] - p0[1]) / 6
    const c2x = p2[0] - (p3[0] - p1[0]) / 6
    const c2y = p2[1] - (p3[1] - p1[1]) / 6
    d += ` C ${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`
  }
  return d
}

const CHART_W = 1000
const CHART_H = 230
const PAD_TOP = 18
const PAD_BOTTOM = 12

/** SVG 面积趋势图：平滑曲线 + 渐变填充 + 峰值光点 + 失败日红刻度；HTML 覆盖层负责交互 */
function TrendChart({ buckets, peak }: { buckets: TrendBucket[]; peak: number }) {
  const points = buckets.map((b, i) => {
    const x = (i + 0.5) / buckets.length * CHART_W
    const v = b.inputTokens + b.outputTokens
    const y = CHART_H - PAD_BOTTOM - (v / peak) * (CHART_H - PAD_TOP - PAD_BOTTOM)
    return { x, y, v }
  })
  const line = smoothPath(points.map((p) => [p.x, p.y]))
  const area = `${line} L ${points[points.length - 1].x.toFixed(2)},${CHART_H - PAD_BOTTOM} L ${points[0].x.toFixed(2)},${CHART_H - PAD_BOTTOM} Z`
  const peakIndex = peak > 0 ? points.findIndex((p) => p.v === peak) : -1
  const labelStep = Math.max(1, Math.ceil(buckets.length / 8))
  return <div className="us-chart">
    <div className="us-chart-head">
      <span className="us-legend"><i className="us-dot us-dot-in" />输入<i className="us-dot us-dot-out" />输出<i className="us-dot us-dot-fail" />失败日</span>
      <span className="us-chart-max">峰值 {fmtTokens(peak)}</span>
    </div>
    <div className="us-chart-plot">
      <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none" aria-hidden>
        <defs>
          <linearGradient id="us-area-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" className="us-area-stop-a" />
            <stop offset="100%" className="us-area-stop-b" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => {
          const y = PAD_TOP + f * (CHART_H - PAD_TOP - PAD_BOTTOM)
          return <line key={f} className="us-gridline" x1="0" x2={CHART_W} y1={y} y2={y} />
        })}
        <path className="us-area" d={area} fill="url(#us-area-fill)" />
        {line ? <path className="us-line" d={line} pathLength={1} /> : null}
      </svg>
      <div className="us-chart-overlay" aria-hidden>
        {points.map((p, i) => <span key={buckets[i].key} className="us-pline" style={{ left: `${p.x / CHART_W * 100}%`, bottom: `${(CHART_H - p.y) / CHART_H * 100}%` }} />)}
        {peakIndex >= 0 ? <span className="us-peak-pin" style={{ left: `${points[peakIndex].x / CHART_W * 100}%`, bottom: `${(CHART_H - points[peakIndex].y) / CHART_H * 100}%` }} /> : null}
        {buckets.map((b, i) => b.failed ? <span key={`f-${b.key}`} className="us-fail-pin" style={{ left: `${(i + 0.5) / buckets.length * 100}%` }} /> : null)}
      </div>
      <div className="us-chart-cols">
        {buckets.map((b, i) => {
          const amount = b.inputTokens + b.outputTokens
          return <div key={b.key} className="us-chart-col" title={`${b.full} · ${fmtTokens(amount)} tokens · ${b.runs} 次运行${b.failed ? ` · 失败 ${b.failed}` : ''}`} />
        })}
      </div>
    </div>
    <div className="us-chart-x">
      {buckets.map((b, i) => <span key={b.key}>{buckets.length <= 10 || (i % labelStep === 0 && buckets.length - 1 - i >= labelStep) || i === buckets.length - 1 ? b.label : ''}</span>)}
    </div>
  </div>
}

export function UsageView() {
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [range, setRange] = useState<Range>('7d')
  const since = useMemo(() => range === 'all' ? undefined : Date.now() - (range === '7d' ? 7 : 30) * 86_400_000, [range])
  const refresh = async () => { setLoading(true); try { setSummary(await bridge.analytics.summary({ since })) } finally { setLoading(false) } }
  useEffect(() => { void refresh(); const off = bridge.tasks.onUpdated(() => void refresh()); return off }, [since])

  const total = summary?.totals ?? empty
  const tokens = total.inputTokens + total.outputTokens
  const failureRate = total.runs ? Math.round(total.failed / total.runs * 100) : 0
  const avgDuration = total.runs ? total.durationMs / total.runs : 0
  const costPerMTok = tokens ? total.costUsd / (tokens / 1_000_000) : 0
  const trend = useMemo(() => buildTrend(summary, range), [summary, range])
  const trendPeak = Math.max(1, ...trend.map((b) => b.inputTokens + b.outputTokens))
  const backendTotal = Math.max(1, (summary?.byBackend ?? []).reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0))
  const agentTokenMax = Math.max(1, ...(summary?.byAgent ?? []).map((row) => row.inputTokens + row.outputTokens))

  return <div className="usage-page">
    <header className="page-header-bar us-header">
      <div className="page-title-row"><Gauge size={16} className="page-icon" /><h2 className="page-title">用量与错误</h2><span className="page-desc">token、成本、运行时长与失败情况的聚合统计。</span></div>
      <div className="us-controls">
        <div className="us-seg" role="tablist">
          {([['7d', '近 7 天'], ['30d', '近 30 天'], ['all', '全部']] as const).map(([value, label]) =>
            <button key={value} role="tab" aria-selected={range === value} className={range === value ? 'active' : ''} onClick={() => setRange(value)}>{label}</button>)}
        </div>
        <button className="btn" onClick={() => void refresh()} disabled={loading}><RefreshCw size={14} className={loading ? 'spin' : ''} /> 刷新</button>
      </div>
    </header>
    <div className="us-body">
      <div className="us-aurora" aria-hidden />
      {loading && !summary ? <div className="empty"><Gauge size={32} /><span>统计加载中…</span></div> : <>
        <section className="us-hero">
          <div className="us-stats">
            <div className="us-stat us-stat-lead">
              <span className="us-stat-icon"><Coins size={15} /></span>
              <div className="us-stat-figure us-tokens">{fmtTokens(tokens)}</div>
              <span className="us-stat-label">Tokens 总消耗</span>
              <span className="us-stat-sub">输入 {fmtTokens(total.inputTokens)} · 输出 {fmtTokens(total.outputTokens)}</span>
            </div>
            <div className="us-stat">
              <span className="us-stat-icon"><Wallet size={15} /></span>
              <div className="us-stat-figure">{total.costUsd ? <>$<span className="us-figure-unit">{total.costUsd.toFixed(2)}</span></> : '—'}</div>
              <span className="us-stat-label">预估成本</span>
              <span className="us-stat-sub">{tokens && total.costUsd ? `$${costPerMTok.toFixed(3)} / 1M tok` : '暂无计费数据'}</span>
            </div>
            <div className="us-stat">
              <span className="us-stat-icon"><Activity size={15} /></span>
              <div className="us-stat-figure">{total.runs}</div>
              <span className="us-stat-label">运行次数</span>
              <span className="us-stat-sub">{total.runs ? <>成功 {total.completed} · 失败 {total.failed}{total.cancelled ? <> · 取消 {total.cancelled}</> : null} · 均次 {fmtDuration(avgDuration)}</> : '该时段没有运行'}</span>
            </div>
            <div className="us-stat us-stat-ring">
              <span className={`us-ring ${failureRate > 0 ? 'is-bad' : 'is-ok'}`}>
                <svg viewBox="0 0 48 48" width="54" height="54">
                  <circle className="us-ring-bg" cx="24" cy="24" r="20" fill="none" strokeWidth="4.5" />
                  <circle
                    className="us-ring-arc" cx="24" cy="24" r="20" fill="none" strokeWidth="4.5" strokeLinecap="round"
                    strokeDasharray={`${125.66 * failureRate / 100} 125.66`} transform="rotate(-90 24 24)"
                  />
                </svg>
                <b>{failureRate}<small>%</small></b>
              </span>
              <span className="us-ring-side">
                <span className="us-stat-label">失败率</span>
                <span className="us-stat-sub">{failureRate > 0 ? <span className="us-warn-text"><AlertTriangle size={11} /> {total.failed} 次失败待处理</span> : <span className="us-ok-text"><CheckCircle2 size={11} /> 运行全部成功</span>}</span>
              </span>
            </div>
          </div>
          {trend.length
            ? <TrendChart buckets={trend} peak={trendPeak} />
            : <div className="us-trend-empty">该时段没有消耗记录，切到更大范围看看。</div>}
        </section>

        <div className="us-grid">
          <section className="us-panel">
            <div className="us-panel-head"><h3><AlertTriangle size={13} className="us-hicon us-hicon-err" />失败构成</h3><span className="us-subtle">{summary?.errors.length ?? 0} 类错误</span></div>
            {summary?.errors.length ? <div className="us-mix">
              {summary.errors.map((error, index) => {
                const max = Math.max(...summary.errors.map((item) => item.count))
                return <div className="us-mix-row" key={error.code} style={{ '--d': `${index * 50}ms` } as React.CSSProperties}>
                  <span className="us-mix-rank">{index + 1}</span>
                  <span className="us-mix-info">
                    <b>{error.title}</b>
                    <small><i className={error.retryable ? 'us-chip us-chip-retry' : 'us-chip'}>{error.retryable ? '可重试' : error.code}</i></small>
                  </span>
                  <span className="us-mix-track"><i style={{ width: `${Math.max(6, error.count / max * 100)}%` }} /></span>
                  <b className="us-mix-count">{error.count}</b>
                </div>
              })}
            </div> : <div className="us-blank"><CheckCircle2 size={20} /><span>该时段没有失败记录。</span></div>}
          </section>
          <section className="us-panel">
            <div className="us-panel-head"><h3><Server size={13} className="us-hicon" />按运行时</h3><span className="us-subtle">运行次数与 token 占比</span></div>
            {summary?.byBackend.length ? <div className="us-back">
              {summary.byBackend.map((row, index) => {
                const amount = row.inputTokens + row.outputTokens
                const share = amount / backendTotal * 100
                const shareText = share > 0 && share < 1 ? '<1' : Math.round(share)
                const hue = BACKEND_HUES[index % BACKEND_HUES.length]
                return <div className="us-back-row" key={row.key} style={{ '--d': `${index * 50}ms`, '--hue': hue } as React.CSSProperties}>
                  <span className="us-back-name"><i />{row.label}</span>
                  <span className="us-back-meta">{row.runs} 次</span>
                  <span className="us-back-track"><i style={{ width: `${Math.max(share, 2)}%` }} /></span>
                  <b className="us-back-share">{shareText}%</b>
                  <span className="us-back-tokens">{fmtTokens(amount)}</span>
                </div>
              })}
            </div> : <div className="us-blank"><Gauge size={20} /><span>该时段没有运行时活动。</span></div>}
          </section>
        </div>

        <section className="us-panel us-agents">
          <div className="us-panel-head"><h3><Users size={13} className="us-hicon" />队员明细</h3><span className="us-subtle"><Timer size={11} /> 用时为累计执行时长</span></div>
          {summary?.byAgent.length ? <div className="us-table-scroll"><table className="us-table">
            <thead><tr><th className="us-num">#</th><th>队员</th><th className="us-num">运行</th><th className="us-num">成功</th><th className="us-num">失败</th><th>Tokens</th><th className="us-num">成本</th><th className="us-num">用时</th></tr></thead>
            <tbody>
              {summary.byAgent.map((row, index) => {
                const amount = row.inputTokens + row.outputTokens
                return <tr key={row.key}>
                  <td className="us-num us-rank">{pad2(index + 1)}</td>
                  <td className="us-agent">{row.label}</td>
                  <td className="us-num">{row.runs}</td>
                  <td className="us-num us-ok-text">{row.completed}</td>
                  <td className="us-num">{row.failed ? <span className="us-chip us-chip-fail">{row.failed}</span> : <span className="us-num-dim">0</span>}</td>
                  <td>
                    <div className="us-token-cell">
                      <span>{fmtTokens(amount)}</span>
                      {amount ? <i style={{ width: `${Math.max(4, amount / agentTokenMax * 100)}%` }} /> : null}
                    </div>
                  </td>
                  <td className="us-num">{row.costUsd ? `$${row.costUsd.toFixed(2)}` : '—'}</td>
                  <td className="us-num">{row.durationMs ? fmtDuration(row.durationMs) : '—'}</td>
                </tr>
              })}
            </tbody>
          </table></div> : <div className="us-blank"><Users size={20} /><span>该时段没有队员活动。</span></div>}
        </section>
        <footer className="us-foot">统计生成于 {summary ? new Date(summary.generatedAt).toLocaleTimeString() : '—'}</footer>
      </>}
    </div>
  </div>
}
