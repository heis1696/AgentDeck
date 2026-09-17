import { useEffect, useState } from 'react'
import { bridge, type AgentInfo as Agent, type AgentModelCatalog, type ApiPresetInfo as Preset, type AgentDraft, type ImproveOutcome, type EvaluateOutcome } from '../api'
import { Users, KeyRound, Sparkles, X, RefreshCw, Network, Download, Upload } from 'lucide-react'
import { toast } from '../ui/Toasts'
import { Menu } from '../ui/Menu'
import { BACKEND_IDS } from '../../../shared/types'
import { isForgeAgent } from '../../../shared/forge'

/** v1 支持预设注入执行的平台：zcode（runtimeModel）/ claude（spawn env） */
const PRESET_BACKENDS = ['zcode', 'claude']

/** Agent 管理页（顶级 tab）：Agent 身份 + API 预设（连接档案）两个分区。
 *  预设按平台存多套（cc-switch 式），但零全局切换——agent 引用预设后，
 *  连接与模型只在它的会话里内存注入。模型列表从预设在线拉取。 */
export function AgentsView() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [presets, setPresets] = useState<Preset[]>([])
  const [editing, setEditing] = useState<Agent | null>(null)
  const [editingPreset, setEditingPreset] = useState<Preset | null>(null)
  /** 模型目录：选了预设 → 从预设在线拉取；否则用平台目录（zcode）/ 预设 */
  const [catalog, setCatalog] = useState<AgentModelCatalog | null>(null)
  const [fetching, setFetching] = useState(false)
  // —— 锻造师·从描述生成：input 填描述 → clarify 答追问 → confirm 逐字段勾选后填入表单 ——
  const [draftOpen, setDraftOpen] = useState(false)
  const [draftStage, setDraftStage] = useState<'input' | 'clarify' | 'confirm'>('input')
  const [draftText, setDraftText] = useState('')
  const [draftQuestions, setDraftQuestions] = useState<string[]>([])
  const [draftAnswers, setDraftAnswers] = useState<string[]>([])
  const [draftResult, setDraftResult] = useState<AgentDraft | null>(null)
  const [draftPicked, setDraftPicked] = useState<Record<string, boolean>>({})
  const [drafting, setDrafting] = useState(false)
  /** 草稿来源：import 时不显示"重新生成"（没有描述可回退）；评测结果挂在确认页 */
  const [draftFromImport, setDraftFromImport] = useState(false)
  const [evaluating, setEvaluating] = useState(false)
  const [evaluation, setEvaluation] = useState<EvaluateOutcome | null>(null)
  // —— 锻造师·改进既有 agent：反馈 → 字段级 old→new diff → 勾选应用并保存 ——
  const [improveOpen, setImproveOpen] = useState(false)
  const [improveTarget, setImproveTarget] = useState<Agent | null>(null)
  const [improveText, setImproveText] = useState('')
  const [improving, setImproving] = useState(false)
  const [improveOutcome, setImproveOutcome] = useState<ImproveOutcome | null>(null)
  const [improvePicked, setImprovePicked] = useState<Record<string, boolean>>({})

  useEffect(() => {
    bridge.agents.list().then(setAgents)
    bridge.presets.list().then(setPresets)
  }, [])

  const refreshCatalog = (backend: string, presetId?: string) => {
    setCatalog(null)
    if (!backend) return
    const source = presetId ? bridge.presets.models(presetId) : bridge.agents.models(backend)
    source.then((c) => setCatalog(c)).catch(() => setCatalog(null))
  }

  useEffect(() => {
    if (!editing) return
    refreshCatalog(editing.backend, editing.presetId)
  }, [editing?.backend, editing?.presetId])

  const refetchCatalog = () => {
    if (!editing) return
    setFetching(true)
    const source = editing.presetId ? bridge.presets.models(editing.presetId) : bridge.agents.models(editing.backend)
    source.then((c) => { setCatalog(c); toast.success(`获取到 ${c.models.length} 个模型`) }).catch((e) => toast.error('获取模型失败: ' + (e instanceof Error ? e.message : String(e)))).finally(() => setFetching(false))
  }

  const saveAgents_ = async (list: Agent[]) => {
    setAgents(await bridge.agents.save(list))
  }
  const savePresets_ = async (list: Preset[]) => {
    setPresets(await bridge.presets.save(list))
  }
  const update = (a: Agent, patch: Partial<Agent>) => {
    setEditing({ ...a, ...patch })
  }
  const commit = () => {
    if (!editing) return
    const exists = agents.some((a) => a.id === editing.id)
    saveAgents_(exists ? agents.map((a) => (a.id === editing.id ? editing : a)) : [...agents, editing])
    setEditing(null)
  }
  const remove = (id: string) => saveAgents_(agents.filter((a) => a.id !== id))
  const add = () =>
    setEditing({ id: `ag_${Date.now().toString(36)}`, name: '', backend: 'zcode', color: '#4f8cff', note: '', role: '', systemPrompt: '', subordinates: [], model: '', presetId: '' })
  const openDraft = () => {
    setDraftText('')
    setDraftQuestions([])
    setDraftAnswers([])
    setDraftResult(null)
    setDraftFromImport(false)
    setEvaluation(null)
    setDraftStage('input')
    setDraftOpen(true)
  }
  /** 生成一轮：无 answers 时描述含糊可能返回澄清问题；有 answers（含空数组）强制出稿 */
  const runDraft = async (answers?: string[]) => {
    if (!draftText.trim() || drafting) return
    setDrafting(true)
    try {
      const result = await bridge.agents.draft(draftText.trim(), answers)
      if (!result.ok) {
        toast.error('生成失败：' + result.error)
        return
      }
      if (result.kind === 'clarify') {
        setDraftQuestions(result.questions)
        setDraftAnswers(result.questions.map(() => ''))
        setDraftStage('clarify')
        return
      }
      setDraftResult(result.draft)
      setDraftPicked({ name: true, role: true, systemPrompt: true, note: true, color: true, model: true })
      setDraftFromImport(false)
      setEvaluation(null)
      setDraftStage('confirm')
    } catch (err) {
      toast.error('生成失败：' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setDrafting(false)
    }
  }
  /** 确认页勾选的字段填入新建表单，未勾选用空默认（color 回落主题蓝）；backend/预设/可驱使仍人工配置 */
  const applyDraft = () => {
    if (!draftResult) return
    const d = draftResult
    setEditing({
      id: `ag_${Date.now().toString(36)}`,
      backend: 'zcode',
      presetId: '',
      name: d.name,
      role: draftPicked.role ? d.role ?? '' : '',
      systemPrompt: draftPicked.systemPrompt ? d.systemPrompt : '',
      note: draftPicked.note ? d.note ?? '' : '',
      color: draftPicked.color ? d.color : '#4f8cff',
      model: draftPicked.model ? d.model ?? '' : '',
      subordinates: []
    })
    setDraftOpen(false)
    toast.success('草稿已填入——请检查后保存')
  }
  const openImprove = (a: Agent) => {
    setImproveTarget(a)
    setImproveText('')
    setImproveOutcome(null)
    setImproveOpen(true)
  }
  const runImprove = async () => {
    if (!improveTarget || !improveText.trim() || improving) return
    setImproving(true)
    try {
      const result = await bridge.agents.improve(improveTarget.id, improveText.trim())
      if (!result.ok) {
        toast.error('改进失败：' + result.error)
        return
      }
      const d = result.outcome.draft
      const base = improveTarget
      const changed: Record<string, boolean> = {}
      if (base.name !== d.name) changed.name = true
      if ((base.role ?? '') !== (d.role ?? '')) changed.role = true
      if ((base.systemPrompt ?? '') !== d.systemPrompt) changed.systemPrompt = true
      if ((base.note ?? '') !== (d.note ?? '')) changed.note = true
      if (base.color !== d.color) changed.color = true
      if ((base.model ?? '') !== (d.model ?? '')) changed.model = true
      setImprovePicked(changed)
      setImproveOutcome(result.outcome)
    } catch (err) {
      toast.error('改进失败：' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setImproving(false)
    }
  }
  /** 勾选的改动写回该 agent 并直接保存（入口在卡片上，不经编辑表单） */
  const applyImprove = () => {
    if (!improveTarget || !improveOutcome) return
    const d = improveOutcome.draft
    const patch: Partial<Agent> = {}
    if (improvePicked.name) patch.name = d.name
    if (improvePicked.role) patch.role = d.role ?? ''
    if (improvePicked.systemPrompt) patch.systemPrompt = d.systemPrompt
    if (improvePicked.note) patch.note = d.note ?? ''
    if (improvePicked.color) patch.color = d.color
    if (improvePicked.model) patch.model = d.model ?? ''
    void saveAgents_(agents.map((a) => (a.id === improveTarget.id ? { ...a, ...patch } : a)))
    setImproveOpen(false)
    toast.success(`已改进「${improveTarget.name}」并保存`)
  }
  /** 导入 subagent .md：解析为草稿后走既有确认视图（backend 等仍人工配置） */
  const importMd = async () => {
    const result = await bridge.agents.importMd()
    if (!result.ok) {
      if (result.error !== '已取消导入') toast.error('导入失败：' + result.error)
      return
    }
    setDraftResult(result.draft)
    setDraftPicked({ name: true, role: true, systemPrompt: true, note: true, color: true, model: true })
    setDraftFromImport(true)
    setEvaluation(null)
    setDraftStage('confirm')
    setDraftOpen(true)
  }
  /** 导出为 Claude subagent 格式 .md（另存对话框在主进程；用户取消静默） */
  const exportMd = async (a: Agent) => {
    const result = await bridge.agents.exportMd(a.id)
    if (!result.ok) {
      if (result.error !== '已取消导出') toast.error('导出失败：' + result.error)
      return
    }
    toast.success(`已导出：${result.path}`)
  }
  /** 触发评测：锻造师构造 should/should-not 输入并判定归属，低命中时给修改建议 */
  const runEvaluate = async () => {
    if (!draftResult || evaluating) return
    setEvaluating(true)
    try {
      const result = await bridge.agents.evaluate(draftResult)
      if (!result.ok) {
        toast.error('评测失败：' + result.error)
        return
      }
      setEvaluation(result.outcome)
    } catch (err) {
      toast.error('评测失败：' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setEvaluating(false)
    }
  }
  const addPreset = async () => {
    const id = await bridge.presets.newId()
    setEditingPreset({ id, name: '', backend: 'zcode', baseURL: '', apiKey: '', note: '', createdAt: Date.now() })
  }
  const commitPreset = () => {
    if (!editingPreset) return
    const exists = presets.some((p) => p.id === editingPreset.id)
    savePresets_(exists ? presets.map((p) => (p.id === editingPreset.id ? editingPreset : p)) : [...presets, editingPreset])
    setEditingPreset(null)
  }
  const removePreset = (id: string) => {
    // 清掉引用该预设的 agent，避免悬空 presetId
    saveAgents_(agents.filter((a) => a.presetId !== id).map((a) => ({ ...a, presetId: undefined })))
    savePresets_(presets.filter((p) => p.id !== id))
  }
  const testPreset = (p: Preset) => {
    toast.info(`正在从 ${p.name} 拉取模型…`)
    bridge.presets.models(p.id).then((c) => toast.success(`${p.name}：${c.models.length} 个模型（${c.models.slice(0, 3).join('、')}${c.models.length > 3 ? '…' : ''}）`)).catch((e) => toast.error('拉取失败: ' + (e instanceof Error ? e.message : String(e))))
  }

  /** 改进 diff 行：只列发生变化的字段 [key, label, old, new]；长文本在展示层截断 */
  const brief = (s: string) => (s.length > 160 ? s.slice(0, 160) + '…' : s)
  const improveDiff = improveOutcome && improveTarget
    ? ([
        ['name', '名字', improveTarget.name, improveOutcome.draft.name],
        ['role', '定位', improveTarget.role ?? '', improveOutcome.draft.role ?? ''],
        ['systemPrompt', '系统提示词', improveTarget.systemPrompt ?? '', improveOutcome.draft.systemPrompt],
        ['note', '备注', improveTarget.note ?? '', improveOutcome.draft.note ?? ''],
        ['color', '头像色', improveTarget.color, improveOutcome.draft.color],
        ['model', '模型', improveTarget.model ?? '', improveOutcome.draft.model ?? '']
      ] as Array<[string, string, string, string]>).filter(([, , oldV, newV]) => oldV !== newV)
    : []
  const editingPresetRef = editing?.presetId ? presets.find((p) => p.id === editing.presetId) : undefined
  const backendPresets = presets.filter((p) => p.backend === editing?.backend)

  const actions = (
    <div className="psh-actions">
      <button className="btn" onClick={addPreset}><KeyRound size={14} /> 新建 API 预设</button>
      <button className="btn" onClick={() => void importMd()}><Upload size={14} /> 导入 .md</button>
      <button className="btn" onClick={openDraft}>✦ 从描述生成</button>
      <button className="btn primary" onClick={add}>＋ 新建 Agent</button>
    </div>
  )

  const presetSection = (
    <section className="tm-section">
      <div className="tm-section-head">
        <h3><KeyRound size={13} className="tm-hicon" />API 预设</h3>
        <span className="tm-section-desc">按平台存多套连接（baseURL / 密钥）；Agent 选取后在它的会话里生效，不改全局配置。zcode / claude 支持注入执行。</span>
      </div>
      <div className="tm-grid">
        {presets.map((p) => (
          <div key={p.id} className="tm-card" role="button" tabIndex={0} onClick={() => setEditingPreset(p)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setEditingPreset(p) } }}>
            <div className="tm-card-top">
              <div className="agent-avatar tm-avatar-preset"><KeyRound size={16} /></div>
              <div className="tm-id">
                <span className="tm-name">{p.name}</span>
                <span className="tm-role">API 连接档案</span>
              </div>
              <div className="tm-acts">
                <button className="tm-act" title="拉取模型列表" onClick={(e) => { e.stopPropagation(); testPreset(p) }}><RefreshCw size={13} /></button>
                <button className="tm-act tm-act-danger" title="删除" onClick={(e) => { e.stopPropagation(); removePreset(p.id) }}><X size={13} /></button>
              </div>
            </div>
            <div className="tm-badges">
              <span className="tm-badge">{p.backend}</span>
            </div>
            <p className="tm-note tm-note-mono">{p.baseURL}<br />密钥 ••••{p.apiKey.slice(-4)}</p>
          </div>
        ))}
        {presets.length === 0 && (
          <div className="tm-empty">
            <KeyRound size={20} />
            <span>还没有预设——新建一个，或留空让 Agent 走平台默认连接。</span>
          </div>
        )}
      </div>
    </section>
  )

  const sections = (
    <>
      <section className="tm-section">
        <div className="tm-section-head">
          <h3><Users size={13} className="tm-hicon tm-hicon-accent" />队员</h3>
          <span className="tm-section-desc">勾选「可驱使」的 Agent 成为领队：对话中可自行派发子任务，最多三层。</span>
        </div>
        <div className="tm-grid">
          {agents.map((a) => {
            const preset = presets.find((p) => p.id === a.presetId)
            return (
              <div key={a.id} className="tm-card" role="button" tabIndex={0} onClick={() => setEditing(a)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setEditing(a) } }}>
                <div className="tm-card-top">
                  <div className="agent-avatar" style={{ background: a.color }}>{a.name.slice(0, 1)}</div>
                  <div className="tm-id">
                    <span className="tm-name">{a.name}</span>
                    <span className="tm-role">{a.role || (isForgeAgent(a) ? '锻造师' : '') || '\u00A0'}</span>
                  </div>
                  <div className="tm-acts">
                    {!isForgeAgent(a) && <button className="tm-act" title="导出为 .md（Claude subagent 格式）" onClick={(e) => { e.stopPropagation(); void exportMd(a) }}><Download size={13} /></button>}
                    {!isForgeAgent(a) && <button className="tm-act" title="用锻造师改进提示词" onClick={(e) => { e.stopPropagation(); openImprove(a) }}><Sparkles size={13} /></button>}
                    <button className="tm-act tm-act-danger" title="删除" onClick={(e) => { e.stopPropagation(); remove(a.id) }}><X size={13} /></button>
                  </div>
                </div>
                <div className="tm-badges">
                  <span className="tm-badge"><Network size={10} />{a.backend}</span>
                  {a.model ? <span className="tm-badge tm-badge-mono">{a.model}</span> : null}
                  {isForgeAgent(a) ? <span className="tm-badge tm-badge-forge">✦ 锻造师</span> : null}
                  {a.subordinates?.length ? <span className="tm-badge tm-badge-lead">⚡ 领队 · 可驱使 {a.subordinates.length}</span> : null}
                  {preset ? <span className="tm-badge tm-badge-preset" title={`连接：${preset.name} · ${preset.baseURL}`}>预设：{preset.name}</span> : null}
                </div>
                <p className="tm-note">
                  {a.subordinates?.length
                    ? `可驱使：${(a.subordinates ?? []).map((sid) => agents.find((x) => x.id === sid)?.name ?? '?').join('、')}（对话中自行派发）`
                    : a.note || '（平台默认连接）'}
                </p>
              </div>
            )
          })}
          {agents.length === 0 && (
            <div className="tm-empty">
              <Users size={20} />
              <span>还没有 Agent——从描述生成一个，或手动新建。</span>
            </div>
          )}
        </div>
      </section>
      {presetSection}
    </>
  )

  /** 弹窗层：position:fixed 的包含块必须是视口——不能挂在容器查询的 .psh-body（layout containment）里，否则弹窗被钉进滚动区裁掉 */
  const dialogs = (
    <>
      {editingPreset && (
        <div className="overlay" onClick={(e) => e.target === e.currentTarget && setEditingPreset(null)}>
          <div className="dialog">
            <h2>{presets.some((p) => p.id === editingPreset.id) ? '编辑 API 预设' : '新建 API 预设'}</h2>
            <label className="field"><span>名称 *</span><input value={editingPreset.name} onChange={(e) => setEditingPreset({ ...editingPreset, name: e.target.value })} placeholder="如：智谱官方 / 某中转站" autoFocus /></label>
            <label className="field">
              <span>平台 *</span>
              <Menu
                items={PRESET_BACKENDS.map((b) => ({ value: b, label: b }))}
                value={editingPreset.backend}
                onChange={(v) => setEditingPreset({ ...editingPreset, backend: v })}
                trigger={(cur, open) => (
                  <button className="btn menu-trigger" type="button">{cur?.label ?? editingPreset.backend} <span className="menu-caret">{open ? '▴' : '▾'}</span></button>
                )}
              />
            </label>
            <label className="field"><span>Base URL *</span><input value={editingPreset.baseURL} onChange={(e) => setEditingPreset({ ...editingPreset, baseURL: e.target.value })} placeholder="https://api.z.ai/api/anthropic" /></label>
            <label className="field"><span>API Key *</span><input type="password" value={editingPreset.apiKey} onChange={(e) => setEditingPreset({ ...editingPreset, apiKey: e.target.value })} placeholder="sk-…" /></label>
            <label className="field"><span>备注</span><input value={editingPreset.note ?? ''} onChange={(e) => setEditingPreset({ ...editingPreset, note: e.target.value })} /></label>
            <div className="dialog-footer">
              <span className="hint">只存本机（userData/api-presets.json）；保存后可用列表里的 ↻ 测试拉取</span>
              <button className="btn primary" onClick={commitPreset} disabled={!editingPreset.name.trim() || !editingPreset.baseURL.trim() || !editingPreset.apiKey.trim()}>保存</button>
            </div>
          </div>
        </div>
      )}

      {draftOpen && (
        <div className="overlay" onClick={(e) => { if (!drafting && e.target === e.currentTarget) setDraftOpen(false) }}>
          <div className="dialog">
            {draftStage === 'input' && (
              <>
                <h2>从描述生成 Agent</h2>
                <label className="field">
                  <span>描述（职责 / 专长 / 风格，一句话即可）</span>
                  <textarea
                    value={draftText}
                    onChange={(e) => setDraftText(e.target.value)}
                    rows={4}
                    placeholder="如：一个擅长 React 单测、用中文汇报的严谨工程师"
                    autoFocus
                    disabled={drafting}
                  />
                </label>
                <div className="dialog-footer">
                  <span className="hint">由「锻造师」生成——引擎即锻造师的平台/模型；描述含糊它会先追问</span>
                  <button className="btn" onClick={() => setDraftOpen(false)} disabled={drafting}>取消</button>
                  <button className="btn primary" onClick={() => void runDraft()} disabled={!draftText.trim() || drafting}>
                    {drafting ? '生成中…（最长 90 秒）' : '生成草稿'}
                  </button>
                </div>
              </>
            )}
            {draftStage === 'clarify' && (
              <>
                <h2>锻造师想先确认几件事</h2>
                {draftQuestions.map((q, i) => (
                  <label className="field" key={i}>
                    <span>{q}</span>
                    <input
                      value={draftAnswers[i] ?? ''}
                      onChange={(e) => setDraftAnswers(draftAnswers.map((a, j) => (j === i ? e.target.value : a)))}
                      disabled={drafting}
                    />
                  </label>
                ))}
                <div className="dialog-footer">
                  <span className="hint">回答可留空——留空即按锻造师自己的理解生成</span>
                  <button className="btn" onClick={() => setDraftStage('input')} disabled={drafting}>← 改描述</button>
                  <button className="btn" onClick={() => void runDraft([])} disabled={drafting}>跳过追问</button>
                  <button className="btn primary" onClick={() => void runDraft(draftAnswers.map((a) => a.trim()))} disabled={drafting}>
                    {drafting ? '生成中…' : '带回答生成'}
                  </button>
                </div>
              </>
            )}
            {draftStage === 'confirm' && draftResult && (
              <>
                <h2>草稿已生成——确认要填入的字段</h2>
                <div className="field">
                  <span>名字（必填，始终填入）</span>
                  <span className="hint">{draftResult.name}</span>
                </div>
                {([
                  ['role', '定位', draftResult.role ?? ''],
                  ['systemPrompt', '系统提示词', draftResult.systemPrompt],
                  ['note', '备注', draftResult.note ?? ''],
                  ['model', '模型', draftResult.model ?? ''],
                  ['color', '头像色', draftResult.color]
                ] as Array<[string, string, string]>).map(([key, label, value]) => (
                  <div className="field" key={key}>
                    <span>{label}{draftPicked[key] ? '' : '（不填入）'}</span>
                    <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                      <span className="hint" style={{ flex: 1, whiteSpace: 'pre-wrap' }}>{brief(value) || '—'}</span>
                      <button className="btn" onClick={() => setDraftPicked({ ...draftPicked, [key]: !draftPicked[key] })}>
                        {draftPicked[key] ? '✓ 填入' : '跳过'}
                      </button>
                    </div>
                  </div>
                ))}
                {evaluation && (
                  <div className="field">
                    <span>触发评测 · 命中 {Math.round(evaluation.passRate * 100)}%（{evaluation.verdicts.filter((v) => v.matched === v.shouldMatch).length}/{evaluation.verdicts.length}）</span>
                    <div style={{ display: 'grid', gap: 4 }}>
                      {evaluation.verdicts.map((v, i) => (
                        <span key={i} className="hint">{v.matched === v.shouldMatch ? '✓' : '✗'} {v.input}（应{v.shouldMatch ? '接' : '不接'} · 判{v.matched ? '接' : '不接'}）</span>
                      ))}
                      {evaluation.suggestion && <span className="hint">建议：{evaluation.suggestion}</span>}
                    </div>
                  </div>
                )}
                <div className="dialog-footer">
                  <span className="hint">未勾选的字段留空，进表单后仍可手改</span>
                  <button className="btn" onClick={() => void runEvaluate()} disabled={evaluating}>{evaluating ? '评测中…' : '评测路由'}</button>
                  {!draftFromImport && <button className="btn" onClick={() => setDraftStage('input')}>重新生成</button>}
                  <button className="btn primary" onClick={applyDraft}>填入表单</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {improveOpen && improveTarget && (
        <div className="overlay" onClick={(e) => { if (!improving && e.target === e.currentTarget) setImproveOpen(false) }}>
          <div className="dialog">
            {!improveOutcome ? (
              <>
                <h2>改进「{improveTarget.name}」的提示词</h2>
                <label className="field">
                  <span>想改什么（如：更严格些 / 加上 git 提交规范 / 汇报改用英文）</span>
                  <textarea
                    value={improveText}
                    onChange={(e) => setImproveText(e.target.value)}
                    rows={4}
                    autoFocus
                    disabled={improving}
                  />
                </label>
                <div className="dialog-footer">
                  <span className="hint">由锻造师按反馈做最小改动；改动逐字段确认后才保存</span>
                  <button className="btn" onClick={() => setImproveOpen(false)} disabled={improving}>取消</button>
                  <button className="btn primary" onClick={() => void runImprove()} disabled={!improveText.trim() || improving}>
                    {improving ? '改进中…（最长 90 秒）' : '开始改进'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2>改动确认——{improveTarget.name}</h2>
                {improveOutcome.changes.length > 0 && <p className="hint">{improveOutcome.changes.join('；')}</p>}
                {improveDiff.length === 0 && <span className="hint">锻造师认为当前定义无需改动。</span>}
                {improveDiff.map(([key, label, oldV, newV]) => (
                  <div className="field" key={key}>
                    <span>{label}{improvePicked[key] ? '' : '（不应用）'}</span>
                    <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                      <span className="hint" style={{ flex: 1, whiteSpace: 'pre-wrap' }}>
                        <s style={{ opacity: 0.55 }}>{brief(oldV) || '（空）'}</s>
                        {'\n'}→ {brief(newV) || '（空）'}
                      </span>
                      <button className="btn" onClick={() => setImprovePicked({ ...improvePicked, [key]: !improvePicked[key] })}>
                        {improvePicked[key] ? '✓ 应用' : '跳过'}
                      </button>
                    </div>
                  </div>
                ))}
                <div className="dialog-footer">
                  <button className="btn" onClick={() => setImproveOutcome(null)}>再提一轮反馈</button>
                  <button className="btn" onClick={() => setImproveOpen(false)}>放弃</button>
                  <button className="btn primary" onClick={applyImprove} disabled={improveDiff.length === 0}>应用勾选改动并保存</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {editing && (
        <div className="overlay" onClick={(e) => e.target === e.currentTarget && setEditing(null)}>
          <div className="dialog">
            <h2>{agents.some((a) => a.id === editing.id) ? '编辑 Agent' : '新建 Agent'}</h2>
            <label className="field">
              <span>名字 *</span>
              <input value={editing.name} onChange={(e) => update(editing, { name: e.target.value })} autoFocus />
            </label>
            <label className="field">
              <span>平台 *</span>
              <Menu
                items={BACKEND_IDS.map((b) => ({ value: b, label: b }))}
                value={editing.backend}
                onChange={(v) => update(editing, { backend: v, ...(editing.presetId ? { presetId: '' } : {}) })}
                trigger={(cur, open) => (
                  <button className="btn menu-trigger" type="button">
                    {cur?.label ?? editing.backend} <span className="menu-caret">{open ? '▴' : '▾'}</span>
                  </button>
                )}
              />
            </label>
            {PRESET_BACKENDS.includes(editing.backend) && (
              <label className="field">
                <span>API 预设（连接覆盖；可空 = 平台默认连接）</span>
                <Menu
                  items={[{ value: '', label: '不使用（平台默认）' }, ...backendPresets.map((p) => ({ value: p.id, label: `${p.name}（${p.baseURL}）` }))]}
                  value={editing.presetId ?? ''}
                  onChange={(v) => update(editing, { presetId: v })}
                  trigger={(cur, open) => (
                    <button className="btn menu-trigger" type="button">
                      {cur?.label ?? '不使用（平台默认）'} <span className="menu-caret">{open ? '▴' : '▾'}</span>
                    </button>
                  )}
                />
              </label>
            )}
            <label className="field">
              <span>模型{editingPresetRef ? '（从预设拉取）' : '（空 = 平台默认）'}；同平台多个 Agent 可各钉不同模型</span>
              <div className="row" style={{ gap: 8 }}>
                <input
                  style={{ flex: 1 }}
                  value={editing.model ?? ''}
                  onChange={(e) => update(editing, { model: e.target.value })}
                  placeholder={catalog?.source === 'catalog' ? catalog.default ?? '平台默认' : '如 glm-5.3 / sonnet / gpt-5.5'}
                />
                <button className="btn" type="button" disabled={fetching || (editing.backend === 'zcode' && !editing.presetId)} onClick={refetchCatalog}>
                  {fetching ? '拉取中…' : '↻ 获取模型'}
                </button>
              </div>
              {editing.backend !== 'zcode' && !editing.presetId && <span className="hint">该平台无本地模型目录，可自由填写，或选 API 预设后在线获取</span>}
              {catalog && catalog.models.length > 0 && (
                <div className="agent-picker">
                  {catalog.models.map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={`agent-pick ${(editing.model ?? '') === m ? 'active' : ''}`}
                      onClick={() => update(editing, { model: (editing.model ?? '') === m ? '' : m })}
                    >
                      {m}{catalog.default === m ? ' · 默认' : ''}
                    </button>
                  ))}
                </div>
              )}
            </label>
            <label className="field">
              <span>定位（头衔：领队 / 工程师 / 审查员…）</span>
              <input value={editing.role ?? ''} onChange={(e) => update(editing, { role: e.target.value })} placeholder="领队" />
            </label>
            {isForgeAgent(editing) ? (
              <span className="hint">锻造师专职生成 Agent，无需系统提示词——元提示词由 agent-crafter 技能提供（共享目录 skills/agent-crafter/SKILL.md，可在「技能」页编辑）。平台 / 模型 / 预设即生成引擎配置。</span>
            ) : (
              <>
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
              <span>可驱使的 Agent（勾选后它成为领队/子领队：对话中可自行把子任务派给他们；领队→子领队→队员最多 3 层）</span>
              <div className="agent-picker">
                {agents.filter((o) => o.id !== editing.id && !isForgeAgent(o)).length === 0 && <span className="hint">（还没有其他 Agent）</span>}
                {agents
                  .filter((o) => o.id !== editing.id && !isForgeAgent(o))
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
                      {o.name}{o.model ? <span className="mini">{o.model}</span> : null}
                    </button>
                  ))}
              </div>
            </label>
              </>
            )}
            <label className="field">
              <span>备注（列表展示用）</span>
              <input value={editing.note ?? ''} onChange={(e) => update(editing, { note: e.target.value })} placeholder="如：擅长前端 React" />
            </label>
            <label className="field">
              <span>头像色</span>
              <input type="color" value={editing.color} onChange={(e) => update(editing, { color: e.target.value })} />
            </label>
            <div className="dialog-footer">
              <span className="hint">重名会自动加后缀（委派按名字匹配）；预设须搭配模型使用</span>
              <button className="btn primary" onClick={commit} disabled={!editing.name.trim()}>保存</button>
            </div>
          </div>
        </div>
      )}
    </>
  )

  return (
    <div className="psh-page">
      <header className="page-header-bar psh-header">
        <div className="page-title-row">
          <Users size={16} className="page-icon" />
          <h2 className="page-title">Agent</h2>
          {agents.length > 0 && <span className="page-count">{agents.length}</span>}
          <span className="page-desc">同一平台可建多个 Agent，各自钉死 API 预设与模型；勾选可驱使名单的 Agent 成为领队。</span>
        </div>
        {actions}
      </header>
      <div className="psh-body">
        <div className="psh-aurora" aria-hidden />
        {sections}
      </div>
      {dialogs}
    </div>
  )
}
