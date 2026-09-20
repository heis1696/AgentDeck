import { useEffect, useRef, useState } from 'react'
import { AlarmClock, Clock3, GitBranch, LoaderCircle, Play, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import { bridge, type AgentInfo } from '../api'
import { BACKEND_IDS, type Automation } from '../../../shared/types'
import { isForgeAgent } from '../../../shared/forge'
import { ui } from '../ui/interaction-center'
import { PageHeader } from '../ui/PageHeader'
import { EmptyState } from '../ui/EmptyState'
import { useInteractionLayer } from '../hooks/useInteractionLayer'

const templates = [
  ['Git 站会摘要', '回顾最近提交，总结重要变更。', GitBranch],
  ['风险扫描', '检查最近的代码改动，识别高风险位置并给出修复建议。', ShieldCheck],
  ['文档同步检查', '对照实现与文档，报告缺口。', GitBranch],
  ['发布简报', '把近期的功能、修复与工程改进整理成发布说明。', AlarmClock]
] as const

/** 新建表单的出厂默认值：空表单必须显式回到这套值，不能残留上一次的配置 */
const DEFAULT_SCHEDULE_MINUTES = 60
const DEFAULT_OUTPUT: 'issue' | 'run_only' = 'issue'

const describe = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

/**
 * 自动化：模板/列表/行内操作 + 新建表单。
 *
 * 交互契约（Batch B）：调度与执行语义不变（含顶部「待定」可用性说明）；
 * 变的是操作反馈——创建/启停/立即运行/删除都有 pending 闸门与捕获到的错误，
 * 删除先确认（取消不触碰 IPC），成功只收敛一次，失败时表单输入原样保留。
 *
 * 复核（Batch B follow-up）：创建在途时表单仍可被 Escape / 遮罩关闭并重新打开，
 * 用「表单会话号」把迟到的成功限制在它自己的那次会话里——既不关掉新表单，也不动新草稿。
 */
export function AutomationView() {
  const [items, setItems] = useState<Automation[]>([])
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [formOpen, setFormOpen] = useState(false)
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [workdir, setWorkdir] = useState('')
  const [agentId, setAgentId] = useState('')
  const [scheduleMinutes, setScheduleMinutes] = useState(DEFAULT_SCHEDULE_MINUTES)
  const [output, setOutput] = useState<'issue' | 'run_only'>(DEFAULT_OUTPUT)
  const [creating, setCreating] = useState(false)
  const [creatingSession, setCreatingSession] = useState(0)
  const [createError, setCreateError] = useState<string | null>(null)
  const [pendingIds, setPendingIds] = useState<readonly string[]>([])
  const creatingRef = useRef(false)
  const pendingRef = useRef(new Set<string>())
  /** 表单会话号：每次打开/关闭 +1，用来识别「迟到的成功」属于哪一次表单 */
  const formSeqRef = useRef(0)
  // 统一浮层：Escape 关闭 + Tab 焦点陷阱 + 焦点归还
  const formLayerRef = useInteractionLayer<HTMLDivElement>({ open: formOpen, onClose: () => closeForm(), kind: 'modal', name: 'automation-form', trap: true })

  const requestRef = useRef(0)
  const refresh = async () => {
    const request = ++requestRef.current
    setLoading(true)
    try {
      const next = await bridge.automations.list()
      if (request !== requestRef.current) return
      setItems(next)
      setLoaded(true)
      setError(null)
    } catch (cause) {
      if (request === requestRef.current) setError(describe(cause))
    } finally {
      if (request === requestRef.current) setLoading(false)
    }
  }
  useEffect(() => {
    void refresh()
    void bridge.agents.list().then(setAgents).catch(() => setAgents([]))
    return () => { requestRef.current++ }
  }, [])
  /** 打开新建表单：无论空表单还是模板，配置项一律显式复位（不继承上一次的草稿） */
  const openCreate = (template?: readonly [string, string, typeof GitBranch]) => {
    formSeqRef.current += 1
    setName(template ? template[0] : '')
    setPrompt(template ? template[1] : '')
    setWorkdir('')
    setAgentId('')
    setScheduleMinutes(DEFAULT_SCHEDULE_MINUTES)
    setOutput(DEFAULT_OUTPUT)
    setCreateError(null)
    setFormOpen(true)
  }
  /** 关闭表单（取消 / Escape / 点遮罩）：会话号前进，在途创建的成功不再收敛到这里 */
  const closeForm = () => {
    formSeqRef.current += 1
    setFormOpen(false)
  }
  const create = async () => {
    if (creatingRef.current) return
    if (!name.trim() || !prompt.trim()) return
    const session = formSeqRef.current
    creatingRef.current = true
    setCreating(true)
    setCreatingSession(session)
    setCreateError(null)
    let created = false
    try {
      await bridge.automations.create({ name, prompt, workdir, agentId: agentId || undefined, scheduleMinutes: Math.max(1, scheduleMinutes), output, enabled: true })
      created = true
    } catch (cause) {
      // 失败：表单保持打开、输入原样保留，用户改完可以直接重试；
      // 迟到的失败只提示——表单已经换过会话时，不把上一次的失败写进新表单
      const detail = describe(cause)
      if (formSeqRef.current === session) setCreateError(detail)
      ui.toast.error(`创建自动化失败：${detail}`)
    } finally {
      creatingRef.current = false
      setCreating(false)
    }
    if (!created) return
    // 成功只收敛一次，且只收敛它自己那次表单会话：期间被关掉/重开的新表单不受影响
    if (formSeqRef.current === session) setFormOpen(false)
    ui.toast.success('自动化已创建')
    await refresh()
  }
  /** 行内操作闸门：同一行的请求在途时不再受理第二次点击 */
  const withRow = async (id: string, op: () => Promise<void>) => {
    if (pendingRef.current.has(id)) return
    pendingRef.current.add(id)
    setPendingIds([...pendingRef.current])
    try {
      await op()
    } catch (cause) {
      ui.toast.error(describe(cause))
    } finally {
      pendingRef.current.delete(id)
      setPendingIds([...pendingRef.current])
    }
  }
  const toggle = async (item: Automation) => {
    await withRow(item.id, async () => {
      await bridge.automations.update(item.id, { enabled: !item.enabled })
      await refresh()
    })
  }
  const runNow = async (item: Automation) => {
    await withRow(item.id, async () => {
      const result = await bridge.automations.runNow(item.id)
      if (!result.ok) ui.toast.error(result.error ?? '启动失败')
      else ui.toast.success('已开始运行')
    })
  }
  const remove = async (item: Automation) => {
    if (pendingRef.current.has(item.id)) return
    const confirmed = await ui.confirm({
      title: `删除自动化「${item.name}」？`,
      body: `计划（每 ${item.scheduleMinutes} 分钟）会被移除；此前运行已产生的 Issue 与记录不受影响。此操作不可撤销。`,
      danger: true,
      confirmText: '删除'
    })
    if (!confirmed) return // 取消：不发起任何 IPC
    await withRow(item.id, async () => {
      await bridge.automations.delete(item.id)
      await refresh()
      ui.toast.success('自动化已删除')
    })
  }

  return <div className="automation-view page-surface">
    {/* 唯一主标题 + 可用性警示（待定徽标 title 里是完整已知问题）+ 调度操作 */}
    <PageHeader
      title="自动化"
      icon={<AlarmClock size={16} />}
      count={loaded ? items.length : undefined}
      metadata={<span className="badge" title="功能待重新设计，已知问题：工作目录留空时 Agent 会在临时目录空跑；「仅执行」模式的结果界面上不可见；无运行历史与重叠保护。">待定</span>}
      actions={<button className="btn primary" onClick={() => openCreate()}><Plus size={14} /> 新建自动化</button>}
    />
    <div className="page-content automation-content">
      {error && loaded && <div className="data-state-banner data-state-stale" role="status"><RefreshCw size={13} /><span>显示上次成功的自动化快照：{error}</span><button className="btn" type="button" onClick={() => void refresh()} disabled={loading}><RefreshCw size={12} className={loading ? 'spin' : ''} /> 重试</button></div>}
      {!loaded && loading && <EmptyState icon={LoaderCircle} title="自动化加载中" description="正在读取已配置的自动化。" />}
      {!loaded && !loading && error && <EmptyState title="自动化加载失败" description={error} action={<button className="btn" type="button" onClick={() => void refresh()}><RefreshCw size={14} /> 重试</button>} />}
      {loaded && !error && items.length === 0 && <EmptyState icon={AlarmClock} title="还没有自动化" description="创建一个自动化，按计划重复执行常用任务。" />}
      <p className="hint">功能待重新设计，暂不建议依赖——已知问题见标题旁「待定」说明。</p>
      {items.length > 0 && <section className="automation-section"><div className="section-heading"><h3>已配置的自动化</h3><span>{items.filter((item) => item.enabled).length} 个启用</span></div><div className="automation-list">{items.map((item) => { const pendingRow = pendingIds.includes(item.id); return <article className="automation-row" key={item.id}><div className="automation-row-main"><strong>{item.name}</strong><span>{item.prompt}</span><small><Clock3 size={12} /> 每 {item.scheduleMinutes} 分钟{item.nextRunAt ? ` · 下次 ${new Date(item.nextRunAt).toLocaleString()}` : ''}</small></div><button className={`toggle-control compact ${item.enabled ? 'on' : ''}`} disabled={pendingRow} onClick={() => void toggle(item)} aria-label={item.enabled ? '暂停自动化' : '启用自动化'}><span /></button><button className="icon-btn" title="立即运行" disabled={pendingRow} onClick={() => void runNow(item)}><Play size={14} /></button><button className="icon-btn danger-icon" title="删除自动化" disabled={pendingRow} onClick={() => void remove(item)}><Trash2 size={14} /></button></article> })}</div></section>}
      <section className="automation-section"><div className="section-heading"><h3>从模板开始</h3><span>选择后可再调整提示词。</span></div><div className="automation-grid">{templates.map(([title, body, Icon]) => <article className="automation-card" key={title}><div className="automation-card-icon"><Icon size={18} /></div><div><h4>{title}</h4><p>{body}</p><small><Clock3 size={12} /> 点击配置</small></div><button className="btn ghost" onClick={() => openCreate([title, body, Icon])}>使用模板</button></article>)}</div></section>
    </div>
    {formOpen && <div className="overlay" ref={formLayerRef} onClick={(event) => event.target === event.currentTarget && closeForm()}><div className="dialog automation-dialog"><h2>新建自动化</h2><label className="field"><span>名称</span><input value={name} onChange={(event) => setName(event.target.value)} autoFocus /></label><label className="field"><span>提示词</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={5} /></label><label className="field"><span>工作目录</span><input value={workdir} onChange={(event) => setWorkdir(event.target.value)} placeholder="本地路径（可选）" /></label><label className="field"><span>执行 Agent</span><select value={agentId} onChange={(event) => setAgentId(event.target.value)}><option value="">默认（zcode · 无身份）</option>{BACKEND_IDS.filter((b) => agents.some((agent) => agent.backend === b && !isForgeAgent(agent))).map((b) => (<optgroup key={b} label={b}>{agents.filter((agent) => agent.backend === b && !isForgeAgent(agent)).map((agent) => <option key={agent.id} value={agent.id}>{agent.name}{agent.model ? `（${agent.model}）` : ''}</option>)}</optgroup>))}</select></label><div className="automation-form-grid"><label className="field"><span>间隔（分钟）</span><input type="number" min={1} value={scheduleMinutes} onChange={(event) => setScheduleMinutes(Number(event.target.value) || 1)} /></label><label className="field"><span>产出</span><select value={output} onChange={(event) => setOutput(event.target.value as 'issue' | 'run_only')}><option value="issue">创建 issue</option><option value="run_only">仅执行</option></select></label></div>{createError && <p className="probe-fail" role="alert" data-automation-create-error>创建失败：{createError}。填写内容仍保留，可直接重试。</p>}{creating && creatingSession !== formSeqRef.current && <p className="hint" data-automation-create-pending>上一次创建仍在进行中，完成后只会刷新列表，不会关闭或清空当前表单。</p>}<div className="dialog-footer"><button className="btn" disabled={creating} onClick={() => closeForm()}>取消</button><button className="btn primary" disabled={!name.trim() || !prompt.trim() || creating} onClick={() => void create()}>{creating && creatingSession === formSeqRef.current ? '创建中…' : '创建'}</button></div></div></div>}
  </div>
}
