import { useMemo, useState } from 'react'
import { Blocks, Check, Code2, FileText, Globe2, Search, ShieldCheck, Wrench } from 'lucide-react'

const extensions = [
  ['文档助手', '读取、总结并更新项目文档。', FileText], ['代码安全', '检查依赖和变更中的安全风险。', ShieldCheck], ['浏览器操作', '访问网页并完成可审计的多步操作。', Globe2], ['技能创建器', '把稳定流程封装成可复用的 Agent 能力。', Wrench], ['代码审查', '按仓库约定检查实现和测试覆盖。', Code2], ['MCP 工具箱', '连接本地服务和团队内部工具。', Blocks]
] as const

export function MarketView() {
  const [query, setQuery] = useState('')
  const [installed, setInstalled] = useState<Set<string>>(new Set(['文档助手']))
  const visible = useMemo(() => extensions.filter(([name, desc]) => `${name} ${desc}`.includes(query.trim())), [query])
  return <div className="market-view page-surface"><header className="page-header-bar"><div className="detail-title-wrap"><div className="page-title-row"><Blocks size={16} className="page-icon" /><h2 className="page-title">扩展中心</h2><span className="page-desc">为 AgentDeck 增加技能、命令和 MCP 工具。</span></div></div><button className="btn"><Wrench size={14} /> 管理已安装</button></header><div className="page-content market-content"><div className="market-toolbar"><label className="market-search"><Search size={16} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索扩展" /></label><div className="market-scope"><button className="active">公开</button><button>个人</button></div></div><div className="section-heading"><h3>推荐扩展</h3><span>{visible.length} 个可用能力</span></div><div className="extension-grid">{visible.map(([name, desc, Icon]) => { const active = installed.has(name); return <article className="extension-card" key={name}><div className="extension-icon"><Icon size={21} /></div><div className="extension-copy"><h4>{name}</h4><p>{desc}</p><small>AgentDeck 社区</small></div><button className={`btn ${active ? 'extension-installed' : ''}`} onClick={() => setInstalled((current) => { const next = new Set(current); active ? next.delete(name) : next.add(name); return next })}>{active ? <><Check size={14} /> 已安装</> : '安装'}</button></article> })}</div></div></div>
}
