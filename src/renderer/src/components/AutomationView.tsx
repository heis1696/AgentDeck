import { useEffect, useState } from 'react'
import { AlarmClock, Clock3, GitBranch, Play, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import { bridge, type AgentInfo } from '../api'
import type { Automation } from '../../../shared/types'
import { toast } from '../ui/Toasts'

const templates = [
  ['Git 站会摘要', '回顾最近提交，总结重要变更。', GitBranch],
  ['风险扫描', '检查最近的代码改动，识别高风险位置并给出修复建议。', ShieldCheck],
  ['文档同步检查', '对照实现与文档，报告缺口。', GitBranch],
  ['发布简报', '把近期的功能、修复与工程改进整理成发布说明。', AlarmClock]
] as const

export function AutomationView() {
  const [items, setItems] = useState<Automation[]>([])
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [formOpen, setFormOpen] = useState(false)
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [workdir, setWorkdir] = useState('')
  const [agentId, setAgentId] = useState('')
  const [scheduleMinutes, setScheduleMinutes] = useState(60)
  const [output, setOutput] = useState<'issue' | 'run_only'>('issue')

  const refresh = async () => setItems(await bridge.automations.list())
  useEffect(() => { void Promise.all([refresh(), bridge.agents.list().then(setAgents)]) }, [])
  const openCreate = (template?: readonly [string, string, typeof GitBranch]) => { if (template) { setName(template[0]); setPrompt(template[1]) } else { setName(''); setPrompt('') }; setFormOpen(true) }
  const create = async () => { if (!name.trim() || !prompt.trim()) return; await bridge.automations.create({ name, prompt, workdir, agentId: agentId || undefined, scheduleMinutes: Math.max(1, scheduleMinutes), output, enabled: true }); setFormOpen(false); await refresh(); toast.success('自动化已创建') }
  const toggle = async (item: Automation) => { await bridge.automations.update(item.id, { enabled: !item.enabled }); await refresh() }
  const runNow = async (item: Automation) => { const result = await bridge.automations.runNow(item.id); if (!result.ok) toast.error(result.error ?? '启动失败'); else toast.success('已开始运行') }
  const remove = async (item: Automation) => { await bridge.automations.delete(item.id); await refresh() }

  return <div className="automation-view page-surface">
    <header className="page-header-bar"><div className="detail-title-wrap"><div className="page-title-row"><AlarmClock size={16} className="page-icon" /><h2 className="page-title">自动化</h2><span className="page-count">{items.length}</span><span className="page-desc">按本地计划重复执行的工作。</span></div></div><button className="btn primary" onClick={() => openCreate()}><Plus size={14} /> 新建自动化</button></header>
    <div className="page-content automation-content">
      <section className="automation-hero"><div><h1>让重复的工作自动运转</h1><p>每次运行都会生成一个可追踪的任务，带独立的执行历史。</p></div></section>
      {items.length > 0 && <section className="automation-section"><div className="section-heading"><h3>已配置的自动化</h3><span>{items.filter((item) => item.enabled).length} 个启用</span></div><div className="automation-list">{items.map((item) => <article className="automation-row" key={item.id}><div className="automation-row-main"><strong>{item.name}</strong><span>{item.prompt}</span><small><Clock3 size={12} /> 每 {item.scheduleMinutes} 分钟{item.nextRunAt ? ` · 下次 ${new Date(item.nextRunAt).toLocaleString()}` : ''}</small></div><button className={`toggle-control compact ${item.enabled ? 'on' : ''}`} onClick={() => void toggle(item)} aria-label={item.enabled ? '暂停自动化' : '启用自动化'}><span /></button><button className="icon-btn" title="立即运行" onClick={() => void runNow(item)}><Play size={14} /></button><button className="icon-btn danger-icon" title="删除自动化" onClick={() => void remove(item)}><Trash2 size={14} /></button></article>)}</div></section>}
      <section className="automation-section"><div className="section-heading"><h3>从模板开始</h3><span>选择后可再调整提示词。</span></div><div className="automation-grid">{templates.map(([title, body, Icon]) => <article className="automation-card" key={title}><div className="automation-card-icon"><Icon size={18} /></div><div><h4>{title}</h4><p>{body}</p><small><Clock3 size={12} /> 点击配置</small></div><button className="btn ghost" onClick={() => openCreate([title, body, Icon])}>使用模板</button></article>)}</div></section>
    </div>
    {formOpen && <div className="overlay" onClick={(event) => event.target === event.currentTarget && setFormOpen(false)}><div className="dialog automation-dialog"><h2>新建自动化</h2><label className="field"><span>名称</span><input value={name} onChange={(event) => setName(event.target.value)} autoFocus /></label><label className="field"><span>提示词</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={5} /></label><label className="field"><span>工作目录</span><input value={workdir} onChange={(event) => setWorkdir(event.target.value)} placeholder="本地路径（可选）" /></label><label className="field"><span>执行队员</span><select value={agentId} onChange={(event) => setAgentId(event.target.value)}><option value="">默认（zcode）</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label><div className="automation-form-grid"><label className="field"><span>间隔（分钟）</span><input type="number" min={1} value={scheduleMinutes} onChange={(event) => setScheduleMinutes(Number(event.target.value) || 1)} /></label><label className="field"><span>产出</span><select value={output} onChange={(event) => setOutput(event.target.value as 'issue' | 'run_only')}><option value="issue">创建 issue</option><option value="run_only">仅执行</option></select></label></div><div className="dialog-footer"><button className="btn" onClick={() => setFormOpen(false)}>取消</button><button className="btn primary" disabled={!name.trim() || !prompt.trim()} onClick={() => void create()}>创建</button></div></div></div>}
  </div>
}
