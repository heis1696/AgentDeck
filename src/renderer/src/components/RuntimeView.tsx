import { useEffect, useMemo, useState } from 'react'
import { Activity, CheckCircle2, Cpu, RefreshCw, Server, XCircle } from 'lucide-react'
import { bridge, type AgentInfo } from '../api'
import type { RuntimeSnapshot } from '../../../shared/types'

/** 运行时健康页；0.14 起作为设置分区嵌入（embedded 时不再渲染整页外壳） */
export function RuntimeView({ embedded = false }: { embedded?: boolean }) {
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [snapshots, setSnapshots] = useState<RuntimeSnapshot[]>([])
  const [checking, setChecking] = useState(false)
  const refresh = async () => {
    setChecking(true)
    try {
      const [list, result] = await Promise.all([bridge.agents.list(), bridge.runtimes.snapshot()])
      setAgents(list)
      setSnapshots(result)
    } finally { setChecking(false) }
  }
  useEffect(() => { void refresh() }, [])
  const healthy = useMemo(() => snapshots.filter((snapshot) => snapshot.health === 'online').length, [snapshots])
  const checkButton = <button className="btn" disabled={checking} onClick={() => void refresh()}><RefreshCw size={14} className={checking ? 'spin' : ''} /> {checking ? '检测中…' : '检测可用性'}</button>
  const body = (
    <>
      <div className="runtime-content">
        <section className="runtime-local"><div className="runtime-local-icon"><Activity size={22} /></div><div><strong>本地引擎</strong><span>运行在当前桌面会话</span><small>任务在本地执行，过程实时汇入对应 Issue 的时间线。</small></div><b className="runtime-live"><i /> 运行中</b></section>
        <div className="runtime-summary"><div><span className="runtime-kpi">{healthy}</span><small>健康后端</small></div><div><span className="runtime-kpi">{snapshots.length - healthy}</span><small>需要关注</small></div><div><span className="runtime-kpi">{agents.length}</span><small>已配置队员</small></div></div>
        <section className="runtime-section"><div className="section-heading"><h3>后端健康</h3><span>探测只在本地进行，可随时重复。</span></div><div className="runtime-grid">{snapshots.map((snapshot) => { const agent = agents.find((item) => item.backend === snapshot.backend); const online = snapshot.health === 'online'; return <article className="runtime-card" key={snapshot.id}><div className="runtime-card-head"><span className="agent-avatar sm" style={{ background: agent?.color ?? '#64748b' }}>{(agent?.name ?? snapshot.label).slice(0, 1)}</span><div><strong>{snapshot.label}</strong><small>{snapshot.backend}{snapshot.version ? ` · v${snapshot.version}` : ''}</small></div>{online ? <CheckCircle2 className="runtime-ok" size={17} /> : <XCircle className="runtime-fail" size={17} />}</div><p>{snapshot.detail || '暂无详情。'}</p><div className="runtime-card-foot"><span className={`runtime-status ${online ? 'ok' : 'fail'}`}>{online ? '就绪' : snapshot.health === 'offline' ? '不可用' : snapshot.health}</span><span className="mini">{snapshot.activeTaskCount} 个进行中任务</span></div></article> })}</div></section>
        <section className="runtime-section runtime-note"><Cpu size={16} /><span>后端凭据与 CLI 路径只保存在本机；探测失败不会改动任务状态。</span></section>
      </div>
    </>
  )
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
    <header className="page-header-bar"><div className="page-title-row"><Server size={16} className="page-icon" /><h2 className="page-title">运行时</h2><span className="page-count">{healthy}/{snapshots.length || agents.length}</span><span className="page-desc">AgentDeck 可调用的本地执行后端。</span></div>{checkButton}</header>
    {body}
  </div>
}
