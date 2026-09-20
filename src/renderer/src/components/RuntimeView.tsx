import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Activity, CheckCircle2, Cpu, LoaderCircle, RefreshCw, Server, XCircle } from 'lucide-react'
import { bridge, type AgentInfo } from '../api'
import { PageHeader } from '../ui/PageHeader'
import { EmptyState } from '../ui/EmptyState'
import type { RuntimeSnapshot } from '../../../shared/types'

/** 把「未知」和「已探测为 0」分开：没有成功快照时计数一律显示破折号 */
const UNKNOWN = '—'

const message = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

/** 快照里最新的探测时刻；主进程没给可用时间戳时退回调用时刻 */
function probedAtOf(snapshots: RuntimeSnapshot[]): number {
  const stamps = snapshots.map((snapshot) => snapshot.checkedAt).filter((value) => Number.isFinite(value) && value > 0)
  return stamps.length > 0 ? Math.max(...stamps) : Date.now()
}

function fmtProbedAt(ts: number): string {
  const date = new Date(ts)
  if (!Number.isFinite(date.getTime())) return UNKNOWN
  return date.toLocaleString()
}

/**
 * 运行时健康页；0.14 起作为设置分区嵌入（embedded 时不再渲染整页外壳）。
 *
 * 数据状态契约（Batch B）：
 * - loading / error / empty / known 四态互斥，首次探测失败绝不渲染「0 健康 / 0 关注」这种假健康；
 * - 刷新失败保留上一次成功快照并标注为陈旧，重试入口常驻；
 * - 显式展示「上次成功检测」时间，避免把陈旧快照当成刚刚探测的结果。
 */
export function RuntimeView({ embedded = false }: { embedded?: boolean }) {
  const [agents, setAgents] = useState<AgentInfo[]>([])
  // null = 还没有任何成功快照（未知）；[] = 探测成功但没有后端（空）
  const [snapshots, setSnapshots] = useState<RuntimeSnapshot[] | null>(null)
  const [agentsKnown, setAgentsKnown] = useState(false)
  const [snapshotError, setSnapshotError] = useState<string | null>(null)
  const [agentsError, setAgentsError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [probedAt, setProbedAt] = useState<number | null>(null)
  const requestRef = useRef(0)

  const refresh = async () => {
    const request = ++requestRef.current
    setBusy(true)
    // 两个读取各自结算：Agent 目录失败不该抹掉已经拿到的后端快照，反之亦然
    const [agentsResult, snapshotResult] = await Promise.allSettled([bridge.agents.list(), bridge.runtimes.snapshot()])
    if (request !== requestRef.current) return
    if (agentsResult.status === 'fulfilled') {
      setAgents(agentsResult.value)
      setAgentsKnown(true)
      setAgentsError(null)
    } else {
      setAgentsError(message(agentsResult.reason))
    }
    if (snapshotResult.status === 'fulfilled') {
      setSnapshots(snapshotResult.value)
      setProbedAt(probedAtOf(snapshotResult.value))
      setSnapshotError(null)
    } else {
      setSnapshotError(message(snapshotResult.reason))
    }
    setBusy(false)
  }
  useEffect(() => {
    void refresh()
    return () => { requestRef.current++ }
  }, [])

  const known = snapshots !== null
  const healthy = useMemo(() => (snapshots ?? []).filter((snapshot) => snapshot.health === 'online').length, [snapshots])
  const stale = known && snapshotError !== null
  const count = snapshots ? `${healthy}/${snapshots.length}` : undefined
  const checkButton = (
    <button className="btn" disabled={busy} onClick={() => void refresh()}>
      <RefreshCw size={14} className={busy ? 'spin' : ''} /> {busy ? '检测中…' : '检测可用性'}
    </button>
  )

  const banner = stale && (
    <div className="data-state-banner data-state-stale" role="status" data-runtime-stale>
      <RefreshCw size={13} />
      <span>显示上次成功的运行时快照（{probedAt ? fmtProbedAt(probedAt) : UNKNOWN}）：{snapshotError}</span>
      <button className="btn" type="button" onClick={() => void refresh()} disabled={busy}>
        <RefreshCw size={12} className={busy ? 'spin' : ''} /> 重试
      </button>
    </div>
  )

  const probedNote = known && (
    <p className="hint runtime-probed-at" data-runtime-probed-at>
      上次成功检测：{probedAt ? fmtProbedAt(probedAt) : UNKNOWN}
      {stale ? '（其后一次检测失败，以下为那次成功的结果）' : ''}
    </p>
  )

  let body: ReactNode
  if (snapshots === null) {
    body = busy
      ? <EmptyState icon={LoaderCircle} title="运行时检测中" description="正在探测各执行后端的可用状态。" />
      : (
        <EmptyState
          icon={Server}
          title="运行时检测失败"
          description={`${snapshotError ?? '无法探测执行后端。'}后端状态未知，不代表后端不可用。`}
          action={checkButton}
        />
      )
  } else if (snapshots.length === 0) {
    body = (
      <EmptyState
        icon={Server}
        title="没有可检测的后端"
        description="探测成功，但当前没有返回任何执行后端；配置 Agent 或后端路径后再检测一次。"
        action={checkButton}
      />
    )
  } else {
    body = (
      <div className="runtime-content">
          {banner}
          <section className="runtime-local"><div className="runtime-local-icon"><Activity size={22} /></div><div><strong>本地引擎</strong><span>运行在当前桌面会话</span><small>任务在本地执行，过程实时汇入对应 Issue 的时间线。</small></div><b className="runtime-live"><i /> 运行中</b></section>
          <div className="runtime-summary"><div><span className="runtime-kpi">{healthy}</span><small>健康后端</small></div><div><span className="runtime-kpi">{snapshots.length - healthy}</span><small>需要关注</small></div><div><span className="runtime-kpi">{agentsKnown ? agents.length : UNKNOWN}</span><small>已配置 Agent</small></div></div>
          {probedNote}
          {agentsError && <p className="hint probe-fail" role="status">Agent 目录读取失败：{agentsError}（后端健康数据不受影响）</p>}
          <section className="runtime-section"><div className="section-heading"><h3>后端健康</h3><span>探测只在本地进行，可随时重复。</span></div><div className="runtime-grid">{snapshots.map((snapshot) => { const backendAgents = agents.filter((item) => item.backend === snapshot.backend); const online = snapshot.health === 'online'; return <article className="runtime-card" key={snapshot.id}><div className="runtime-card-head"><div className="avatar-stack" title={backendAgents.map((a) => `${a.name}${a.model ? ' · ' + a.model : ''}`).join('、') || '无 Agent'}>{backendAgents.length > 0 ? backendAgents.slice(0, 3).map((a) => (<span key={a.id} className="agent-avatar sm" style={{ background: a.color }}>{a.name.slice(0, 1)}</span>)) : (<span className="agent-avatar sm" style={{ background: '#64748b' }}>{snapshot.label.slice(0, 1)}</span>)}{backendAgents.length > 3 && <span className="mini">+{backendAgents.length - 3}</span>}</div><div><strong>{snapshot.label}</strong><small>{snapshot.backend}{backendAgents.length > 0 ? ` · ${backendAgents.length} Agent` : ''}{snapshot.version ? ` · v${snapshot.version}` : ''}</small></div>{online ? <CheckCircle2 className="runtime-ok" size={17} /> : <XCircle className="runtime-fail" size={17} />}</div><p>{snapshot.detail || '暂无详情。'}</p><div className="runtime-card-foot"><span className={`runtime-status ${online ? 'ok' : 'fail'}`}>{online ? '就绪' : snapshot.health === 'offline' ? '不可用' : snapshot.health}</span><span className="mini">{Number.isFinite(snapshot.activeTaskCount) ? `${snapshot.activeTaskCount} 个进行中任务` : '进行中任务数未知'}</span></div></article> })}</div></section>
          <section className="runtime-section runtime-note"><Cpu size={16} /><span>后端凭据与 CLI 路径只保存在本机；探测失败不会改动任务状态。</span></section>
      </div>
    )
  }

  if (embedded) {
    return (
      <section className="settings-card runtime-embedded">
        <div className="runtime-embedded-head">
          <div className="section-heading"><h3>运行时健康</h3><span>各执行后端的可用状态与活跃任务数</span></div>
          {checkButton}
        </div>
        {body}
      </section>
    )
  }
  return <div className="settings runtime-page">
    {/* 独立运行时页才用共享页头；embedded 分支保持设置卡片里的 h3，不产生第二个 h1 */}
    <PageHeader title="运行时" icon={<Server size={16} />} count={count} actions={checkButton} />
    {body}
  </div>
}
