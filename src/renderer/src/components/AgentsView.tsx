import { useEffect, useRef, useState } from 'react'
import { bridge, type AgentInfo as Agent, type AgentModelCatalog, type ApiPresetInfo as Preset, type AgentDraft, type ImproveOutcome, type EvaluateOutcome } from '../api'
import { Users, KeyRound, Sparkles, X, RefreshCw, Network, Download, Upload, Search } from 'lucide-react'
import { useInteractionLayer } from '../hooks/useInteractionLayer'
import { ui, isComposingKey } from '../ui/interaction-center'
import { Menu } from '../ui/Menu'
import { PageHeader } from '../ui/PageHeader'
import { EmptyState } from '../ui/EmptyState'
import { BACKEND_IDS } from '../../../shared/types'
import { isForgeAgent } from '../../../shared/forge'

/** v1 支持预设注入执行的后端面（Agent 表单的预设提示文案据此区分，非预设归属）：zcode（runtimeModel）/ claude（spawn env） */
const CONNECTION_BACKENDS = ['zcode', 'claude']

export type ListLoadState = 'loading' | 'ready' | 'error'

export function canPersistList<T>(state: ListLoadState, list: T[] | null, refreshing = false): list is T[] {
  return state === 'ready' && !refreshing && list !== null
}

/** Agent 管理页（顶级 tab）：Agent 身份 + API 预设（连接档案）两个分区。
 *  预设是全局连接档案，不绑定平台——agent 引用预设后，
 *  连接与模型只在它的会话里内存注入。模型列表从预设在线拉取。 */
export function AgentsView() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [presets, setPresets] = useState<Preset[]>([])
  const [agentsLoadState, setAgentsLoadState] = useState<ListLoadState>('loading')
  const [presetsLoadState, setPresetsLoadState] = useState<ListLoadState>('loading')
  const [agentsError, setAgentsError] = useState<string | null>(null)
  const [presetsError, setPresetsError] = useState<string | null>(null)
  const [agentsRefreshing, setAgentsRefreshing] = useState(true)
  const [presetsRefreshing, setPresetsRefreshing] = useState(true)
  const [agentsSaving, setAgentsSaving] = useState(false)
  const [presetsSaving, setPresetsSaving] = useState(false)
  const [agentQuery, setAgentQuery] = useState('')
  const [creatingPreset, setCreatingPreset] = useState(false)
  const [testingPresetId, setTestingPresetId] = useState<string | null>(null)
  const agentsSavingRef = useRef(false)
  const presetsSavingRef = useRef(false)
  const deletingAgentRef = useRef(new Set<string>())
  const deletingPresetRef = useRef(new Set<string>())
  const agentsSnapshotRef = useRef<Agent[] | null>(null)
  const presetsSnapshotRef = useRef<Preset[] | null>(null)
  const agentsRequestRef = useRef(0)
  const presetsRequestRef = useRef(0)
  const modelRequestRef = useRef(0)
  const catalogBusyRef = useRef(false)
  const presetModelRequestRef = useRef(new Map<string, number>())
  const presetModelBusyRef = useRef(new Set<string>())
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

  // 统一浮层：四个页面内模态共用「最上层 Escape + Tab 焦点陷阱 + 关闭后焦点归还」
  const presetLayerRef = useInteractionLayer<HTMLDivElement>({ open: editingPreset !== null, onClose: () => setEditingPreset(null), kind: 'modal', name: 'preset-editor', trap: true })
  const draftLayerRef = useInteractionLayer<HTMLDivElement>({ open: draftOpen, onClose: () => { if (!drafting) setDraftOpen(false) }, kind: 'modal', name: 'agent-draft', trap: true })
  const improveLayerRef = useInteractionLayer<HTMLDivElement>({ open: improveOpen, onClose: () => { if (!improving) setImproveOpen(false) }, kind: 'modal', name: 'agent-improve', trap: true })
  const editingLayerRef = useInteractionLayer<HTMLDivElement>({ open: editing !== null, onClose: () => setEditing(null), kind: 'modal', name: 'agent-editor', trap: true })

  const loadAgents = async () => {
    const request = ++agentsRequestRef.current
    setAgentsRefreshing(true)
    setAgentsError(null)
    if (agentsSnapshotRef.current === null) setAgentsLoadState('loading')
    try {
      const next = await bridge.agents.list()
      if (request !== agentsRequestRef.current) return
      agentsSnapshotRef.current = next
      setAgents(next)
      setAgentsLoadState('ready')
    } catch (cause) {
      if (request !== agentsRequestRef.current) return
      setAgentsLoadState(agentsSnapshotRef.current === null ? 'error' : 'ready')
      setAgentsError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (request === agentsRequestRef.current) setAgentsRefreshing(false)
    }
  }

  const loadPresets = async () => {
    const request = ++presetsRequestRef.current
    setPresetsRefreshing(true)
    setPresetsError(null)
    if (presetsSnapshotRef.current === null) setPresetsLoadState('loading')
    try {
      const next = await bridge.presets.list()
      if (request !== presetsRequestRef.current) return
      presetsSnapshotRef.current = next
      setPresets(next)
      setPresetsLoadState('ready')
    } catch (cause) {
      if (request !== presetsRequestRef.current) return
      setPresetsLoadState(presetsSnapshotRef.current === null ? 'error' : 'ready')
      setPresetsError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (request === presetsRequestRef.current) setPresetsRefreshing(false)
    }
  }

  useEffect(() => {
    void loadAgents()
    void loadPresets()
    return () => {
      agentsRequestRef.current++
      presetsRequestRef.current++
    }
  }, [])

  const refreshCatalog = (backend: string, presetId?: string) => {
    const request = ++modelRequestRef.current
    catalogBusyRef.current = false
    setCatalog(null)
    if (!backend) return
    const source = presetId ? bridge.presets.models(presetId) : bridge.agents.models(backend)
    source.then((c) => { if (request === modelRequestRef.current) setCatalog(c) }).catch(() => { if (request === modelRequestRef.current) setCatalog(null) })
  }

  useEffect(() => {
    if (!editing) {
      ++modelRequestRef.current
      catalogBusyRef.current = false
      setCatalog(null)
      return
    }
    refreshCatalog(editing.backend, editing.presetId)
  }, [editing?.backend, editing?.presetId])

  const refetchCatalog = () => {
    if (!editing || catalogBusyRef.current) return
    const request = ++modelRequestRef.current
    catalogBusyRef.current = true
    setFetching(true)
    const target = { backend: editing.backend, presetId: editing.presetId }
    const source = target.presetId ? bridge.presets.models(target.presetId) : bridge.agents.models(target.backend)
    source.then((c) => {
      if (request !== modelRequestRef.current) return
      setCatalog(c)
      ui.toast.success(`获取到 ${c.models.length} 个模型`)
    }).catch((e) => {
      if (request === modelRequestRef.current) ui.toast.error('获取模型失败: ' + (e instanceof Error ? e.message : String(e)))
    }).finally(() => {
      if (request === modelRequestRef.current) {
        catalogBusyRef.current = false
        setFetching(false)
      }
    })
  }

  const canWriteAgents = canPersistList(agentsLoadState, agentsSnapshotRef.current, agentsRefreshing) && !agentsError && !agentsSaving
  const canWritePresets = canPersistList(presetsLoadState, presetsSnapshotRef.current, presetsRefreshing) && !presetsError && !presetsSaving
  const saveAgents_ = async (change: (current: Agent[]) => Agent[]) => {
    const current = agentsSnapshotRef.current
    if (!canWriteAgents || !current || agentsSavingRef.current) {
      ui.toast.error('Agent 列表尚未成功加载，暂不能保存')
      return false
    }
    agentsSavingRef.current = true
    setAgentsSaving(true)
    try {
      const saved = await bridge.agents.save(change(current))
      agentsSnapshotRef.current = saved
      setAgents(saved)
      setAgentsLoadState('ready')
      setAgentsError(null)
      return true
    } catch (cause) {
      ui.toast.error('Agent 保存失败：' + (cause instanceof Error ? cause.message : String(cause)))
      return false
    } finally {
      agentsSavingRef.current = false
      setAgentsSaving(false)
    }
  }
  const savePresets_ = async (change: (current: Preset[]) => Preset[]) => {
    const current = presetsSnapshotRef.current
    if (!canWritePresets || !current || presetsSavingRef.current) {
      ui.toast.error('预设列表尚未成功加载，暂不能保存')
      return false
    }
    presetsSavingRef.current = true
    setPresetsSaving(true)
    try {
      const saved = await bridge.presets.save(change(current))
      presetsSnapshotRef.current = saved
      setPresets(saved)
      setPresetsLoadState('ready')
      setPresetsError(null)
      return true
    } catch (cause) {
      ui.toast.error('预设保存失败：' + (cause instanceof Error ? cause.message : String(cause)))
      return false
    } finally {
      presetsSavingRef.current = false
      setPresetsSaving(false)
    }
  }
  const update = (a: Agent, patch: Partial<Agent>) => {
    setEditing({ ...a, ...patch })
  }
  const commit = async () => {
    if (!editing) return
    const saved = await saveAgents_((current) => {
      const exists = current.some((a) => a.id === editing.id)
      return exists ? current.map((a) => (a.id === editing.id ? editing : a)) : [...current, editing]
    })
    if (saved) setEditing(null)
  }
  const remove = async (id: string) => {
    if (deletingAgentRef.current.has(id)) return
    const target = agents.find((agent) => agent.id === id)
    if (!target) return
    deletingAgentRef.current.add(id)
    try {
      if (!await ui.confirm({ title: `删除 Agent「${target.name}」？`, body: '删除只移除本机队伍定义，不会删除已有任务或执行记录。', danger: true, confirmText: '删除' })) return
      await saveAgents_((current) => current.filter((a) => a.id !== id))
    } finally {
      deletingAgentRef.current.delete(id)
    }
  }
  const add = () =>
    canWriteAgents && setEditing({ id: `ag_${Date.now().toString(36)}`, name: '', backend: 'zcode', color: '#4f8cff', note: '', role: '', systemPrompt: '', subordinates: [], model: '', presetId: '' })
  const openDraft = () => {
    if (!canWriteAgents) return
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
        ui.toast.error('生成失败：' + result.error)
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
      ui.toast.error('生成失败：' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setDrafting(false)
    }
  }
  /** 确认页勾选的字段填入新建表单，未勾选用空默认（color 回落主题蓝）；backend/预设/可驱使仍人工配置 */
  const applyDraft = () => {
    if (!draftResult) return
    if (!canWriteAgents) {
      ui.toast.error('Agent 列表尚未成功加载，暂不能保存')
      return
    }
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
    ui.toast.success('草稿已填入——请检查后保存')
  }
  const openImprove = (a: Agent) => {
    if (!canWriteAgents) return
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
        ui.toast.error('改进失败：' + result.error)
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
      ui.toast.error('改进失败：' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setImproving(false)
    }
  }
  /** 勾选的改动写回该 agent 并直接保存（入口在卡片上，不经编辑表单） */
  const applyImprove = async () => {
    if (!improveTarget || !improveOutcome) return
    const d = improveOutcome.draft
    const patch: Partial<Agent> = {}
    if (improvePicked.name) patch.name = d.name
    if (improvePicked.role) patch.role = d.role ?? ''
    if (improvePicked.systemPrompt) patch.systemPrompt = d.systemPrompt
    if (improvePicked.note) patch.note = d.note ?? ''
    if (improvePicked.color) patch.color = d.color
    if (improvePicked.model) patch.model = d.model ?? ''
    const saved = await saveAgents_((current) => current.map((a) => (a.id === improveTarget.id ? { ...a, ...patch } : a)))
    if (!saved) return
    setImproveOpen(false)
    ui.toast.success(`已改进「${improveTarget.name}」并保存`)
  }
  /** 导入 subagent .md：解析为草稿后走既有确认视图（backend 等仍人工配置） */
  const importMd = async () => {
    if (!canWriteAgents) return
    const result = await bridge.agents.importMd()
    if (!result.ok) {
      if (result.error !== '已取消导入') ui.toast.error('导入失败：' + result.error)
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
      if (result.error !== '已取消导出') ui.toast.error('导出失败：' + result.error)
      return
    }
    ui.toast.success(`已导出：${result.path}`)
  }
  /** 触发评测：锻造师构造 should/should-not 输入并判定归属，低命中时给修改建议 */
  const runEvaluate = async () => {
    if (!draftResult || evaluating) return
    setEvaluating(true)
    try {
      const result = await bridge.agents.evaluate(draftResult)
      if (!result.ok) {
        ui.toast.error('评测失败：' + result.error)
        return
      }
      setEvaluation(result.outcome)
    } catch (err) {
      ui.toast.error('评测失败：' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setEvaluating(false)
    }
  }
  const addPreset = async () => {
    if (creatingPreset) return
    if (!canWritePresets) {
      ui.toast.error('预设列表尚未成功加载，暂不能保存')
      return
    }
    setCreatingPreset(true)
    try {
      const id = await bridge.presets.newId()
      setEditingPreset({ id, name: '', baseURL: '', apiKey: '', note: '', createdAt: Date.now() })
    } catch (cause) {
      ui.toast.error('新建预设失败：' + (cause instanceof Error ? cause.message : String(cause)))
    } finally {
      setCreatingPreset(false)
    }
  }
  const commitPreset = async () => {
    if (!editingPreset) return
    const saved = await savePresets_((current) => {
      const exists = current.some((p) => p.id === editingPreset.id)
      return exists ? current.map((p) => (p.id === editingPreset.id ? editingPreset : p)) : [...current, editingPreset]
    })
    if (saved) setEditingPreset(null)
  }
  const removePreset = async (id: string) => {
    if (deletingPresetRef.current.has(id)) return
    if (!canWriteAgents || !canWritePresets) {
      ui.toast.error('Agent 和预设列表尚未成功加载，暂不能保存')
      return
    }
    const preset = presets.find((item) => item.id === id)
    if (!preset) return
    const affected = agents.filter((agent) => agent.presetId === id).length
    deletingPresetRef.current.add(id)
    try {
      if (!await ui.confirm({ title: `删除 API 预设「${preset.name}」？`, body: affected ? `将同时解除 ${affected} 个 Agent 的预设绑定；Agent 本身不会删除。` : '没有 Agent 使用此预设。', danger: true, confirmText: '删除' })) return
      // Detach only this preset; retain agents and their unrelated preset bindings.
      const agentsSaved = await saveAgents_((current) => current.map((a) => a.presetId === id ? { ...a, presetId: undefined } : a))
      if (agentsSaved) await savePresets_((current) => current.filter((p) => p.id !== id))
    } finally {
      deletingPresetRef.current.delete(id)
    }
  }
  const testPreset = (p: Preset) => {
    if (presetModelBusyRef.current.has(p.id)) return
    presetModelBusyRef.current.add(p.id)
    const request = (presetModelRequestRef.current.get(p.id) ?? 0) + 1
    presetModelRequestRef.current.set(p.id, request)
    setTestingPresetId(p.id)
    ui.toast.info(`正在从 ${p.name} 拉取模型…`)
    bridge.presets.models(p.id).then((c) => {
      if (presetModelRequestRef.current.get(p.id) !== request) return
      ui.toast.success(`${p.name}：${c.models.length} 个模型（${c.models.slice(0, 3).join('、')}${c.models.length > 3 ? '…' : ''}）`)
    }).catch((e) => {
      if (presetModelRequestRef.current.get(p.id) === request) ui.toast.error('拉取失败: ' + (e instanceof Error ? e.message : String(e)))
    }).finally(() => {
      presetModelBusyRef.current.delete(p.id)
      if (presetModelRequestRef.current.get(p.id) === request) setTestingPresetId(null)
    })
  }

  /** 确认页将填入的字段数（名字恒填入）：用于页脚计数与"只填入名字"按钮文案，防误取消全部字段 */
  const draftPickCount = 1 + (['role', 'systemPrompt', 'note', 'model', 'color'] as const).filter((k) => draftPicked[k]).length
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
  const filteredAgents = agents.filter((agent) => {
    const query = agentQuery.trim().toLowerCase()
    return !query || [agent.name, agent.role, agent.backend].filter(Boolean).join(' ').toLowerCase().includes(query)
  })

  const actions = (
    <>
      <button className="btn" onClick={() => void addPreset()} disabled={!canWritePresets || creatingPreset}><KeyRound size={14} /> {creatingPreset ? '准备中…' : '新建 API 预设'}</button>
      <button className="btn" onClick={() => void importMd()} disabled={!canWriteAgents}><Upload size={14} /> 导入 .md</button>
      <button className="btn" onClick={openDraft} disabled={!canWriteAgents}>✦ 从描述生成</button>
      <button className="btn primary" onClick={add} disabled={!canWriteAgents}>＋ 新建 Agent</button>
    </>
  )

  const presetSection = (
    <section className="tm-section">
      <div className="tm-section-head">
        <h3><KeyRound size={13} className="tm-hicon" />API 预设</h3>
        <span className="tm-section-desc">全局连接档案（baseURL / 密钥），不绑定平台；Agent 选取后在它的会话里生效，不改全局配置。zcode / claude 支持注入执行。</span>
      </div>
      <div className="tm-grid">
        {presetsLoadState === 'loading' && <EmptyState compact icon={KeyRound} title="预设加载中" description="正在读取 API 预设。" />}
        {presetsLoadState === 'error' && presetsSnapshotRef.current === null && <EmptyState compact icon={KeyRound} title="预设加载失败" description={presetsError ?? '无法读取 API 预设。'} action={<button className="btn" type="button" onClick={() => void loadPresets()}><RefreshCw size={13} /> 重试</button>} />}
        {presetsError && presetsSnapshotRef.current !== null && <div className="data-state-banner data-state-stale" role="status"><RefreshCw size={13} /><span>预设显示上次成功快照：{presetsError}</span><button className="btn" type="button" onClick={() => void loadPresets()} disabled={presetsRefreshing}><RefreshCw size={12} className={presetsRefreshing ? 'spin' : ''} /> 重试</button></div>}
        {presets.map((p) => (
          <div key={p.id} className="tm-card" role="button" aria-disabled={!canWritePresets} tabIndex={canWritePresets ? 0 : -1} onClick={() => { if (canWritePresets) setEditingPreset(p) }} onKeyDown={(e) => { if (isComposingKey(e.nativeEvent) || !canWritePresets) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setEditingPreset(p) } }}>
            <div className="tm-card-top">
              <div className="agent-avatar tm-avatar-preset"><KeyRound size={16} /></div>
              <div className="tm-id">
                <span className="tm-name">{p.name}</span>
                <span className="tm-role">API 连接档案</span>
              </div>
              <div className="tm-acts">
                <button className="tm-act" title="拉取模型列表" disabled={testingPresetId === p.id} onClick={(e) => { e.stopPropagation(); testPreset(p) }}><RefreshCw size={13} className={testingPresetId === p.id ? 'spin' : undefined} /></button>
                <button className="tm-act tm-act-danger" title="删除" disabled={!canWriteAgents || !canWritePresets || deletingPresetRef.current.has(p.id)} onClick={(e) => { e.stopPropagation(); void removePreset(p.id) }}><X size={13} /></button>
              </div>
            </div>
            <p className="tm-note tm-note-mono">{p.baseURL}<br />密钥 ••••{p.apiKey.slice(-4)}</p>
          </div>
        ))}
        {presetsLoadState === 'ready' && presets.length === 0 && (
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
          <div className="tm-section-title"><h3><Users size={13} className="tm-hicon tm-hicon-accent" />队员</h3><span className="tm-section-desc">勾选「可驱使」的 Agent 成为领队：对话中可自行派发子任务，最多三层。</span></div>
          <label className="tm-filter"><Search size={13} aria-hidden="true" /><input aria-label="筛选 Agent" value={agentQuery} onChange={(event) => setAgentQuery(event.target.value)} placeholder="筛选名称、角色、后端" /></label>
        </div>
        <div className="tm-grid">
          {agentsLoadState === 'loading' && <EmptyState compact icon={Users} title="Agent 加载中" description="正在读取队伍列表。" />}
          {agentsLoadState === 'error' && agentsSnapshotRef.current === null && <EmptyState compact icon={Users} title="Agent 加载失败" description={agentsError ?? '无法读取 Agent 列表。'} action={<button className="btn" type="button" onClick={() => void loadAgents()}><RefreshCw size={13} /> 重试</button>} />}
          {agentsError && agentsSnapshotRef.current !== null && <div className="data-state-banner data-state-stale" role="status"><RefreshCw size={13} /><span>Agent 列表显示上次成功快照：{agentsError}</span><button className="btn" type="button" onClick={() => void loadAgents()} disabled={agentsRefreshing}><RefreshCw size={12} className={agentsRefreshing ? 'spin' : ''} /> 重试</button></div>}
          {filteredAgents.map((a) => {
            const preset = presets.find((p) => p.id === a.presetId)
            return (
              <div key={a.id} className="tm-card" role="button" aria-disabled={!canWriteAgents} tabIndex={canWriteAgents ? 0 : -1} onClick={() => { if (canWriteAgents) setEditing(a) }} onKeyDown={(e) => { if (isComposingKey(e.nativeEvent) || !canWriteAgents) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setEditing(a) } }}>
                <div className="tm-card-top">
                  <div className="agent-avatar" style={{ background: a.color }}>{a.name.slice(0, 1)}</div>
                  <div className="tm-id">
                    <span className="tm-name">{a.name}</span>
                    <span className="tm-role">{a.role || (isForgeAgent(a) ? '锻造师' : '') || '\u00A0'}</span>
                  </div>
                  <div className="tm-acts">
                    {!isForgeAgent(a) && <button className="tm-act" title="导出为 .md（Claude subagent 格式）" onClick={(e) => { e.stopPropagation(); void exportMd(a) }}><Download size={13} /></button>}
                    {!isForgeAgent(a) && <button className="tm-act" title="用锻造师改进提示词" disabled={!canWriteAgents} onClick={(e) => { e.stopPropagation(); openImprove(a) }}><Sparkles size={13} /></button>}
                    <button className="tm-act tm-act-danger" title="删除" disabled={!canWriteAgents || deletingAgentRef.current.has(a.id)} onClick={(e) => { e.stopPropagation(); void remove(a.id) }}><X size={13} /></button>
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
          {agentsLoadState === 'ready' && agents.length > 0 && filteredAgents.length === 0 && (
            <div className="tm-empty tm-empty-filtered">
              <Users size={20} />
              <span>没有匹配的 Agent。</span>
              <button className="btn" type="button" onClick={() => setAgentQuery('')}>清除筛选</button>
            </div>
          )}
          {agentsLoadState === 'ready' && agents.length === 0 && (
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
        <div className="overlay" ref={presetLayerRef} onClick={(e) => e.target === e.currentTarget && setEditingPreset(null)}>
          <div className="dialog">
            <h2>{presets.some((p) => p.id === editingPreset.id) ? '编辑 API 预设' : '新建 API 预设'}</h2>
            <label className="field"><span>名称 *</span><input value={editingPreset.name} onChange={(e) => setEditingPreset({ ...editingPreset, name: e.target.value })} placeholder="如：智谱官方 / 某中转站" autoFocus /></label>
            <label className="field"><span>Base URL *</span><input value={editingPreset.baseURL} onChange={(e) => setEditingPreset({ ...editingPreset, baseURL: e.target.value })} placeholder="https://api.z.ai/api/anthropic" /></label>
            <label className="field"><span>API Key *</span><input type="password" value={editingPreset.apiKey} onChange={(e) => setEditingPreset({ ...editingPreset, apiKey: e.target.value })} placeholder="sk-…" /></label>
            <label className="field"><span>线协议</span>
              <select value={editingPreset.protocol ?? ''} onChange={(e) => setEditingPreset({ ...editingPreset, protocol: (e.target.value || undefined) as Preset['protocol'] })}>
                <option value="">自动（按 Base URL 推断）</option>
                <option value="anthropic">anthropic（/messages）</option>
                <option value="openai">openai（/chat/completions，OpenRouter 等）</option>
              </select>
            </label>
            <label className="field"><span>备注</span><input value={editingPreset.note ?? ''} onChange={(e) => setEditingPreset({ ...editingPreset, note: e.target.value })} /></label>
            <div className="dialog-footer">
              <span className="hint">只存本机（userData/api-presets.json）；保存后可用列表里的 ↻ 测试拉取</span>
              <button className="btn primary" onClick={commitPreset} disabled={!canWritePresets || !editingPreset.name.trim() || !editingPreset.baseURL.trim() || !editingPreset.apiKey.trim()}>保存</button>
            </div>
          </div>
        </div>
      )}

      {draftOpen && (
        <div className="overlay" ref={draftLayerRef} onClick={(e) => { if (!drafting && e.target === e.currentTarget) setDraftOpen(false) }}>
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
                      <span className="hint" style={draftPicked[key] ? { flex: 1, whiteSpace: 'pre-wrap' } : { flex: 1, whiteSpace: 'pre-wrap', textDecoration: 'line-through', opacity: 0.45 }}>{brief(value) || '—'}</span>
                      <button className="btn" onClick={() => setDraftPicked({ ...draftPicked, [key]: !draftPicked[key] })}>
                        {draftPicked[key] ? '✓ 填入' : '已跳过'}
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
                  <span className="hint">将填入 {draftPickCount}/6 个字段——按钮单击即取消/恢复，取消的字段进表单后留空可手改</span>
                  <button className="btn" onClick={() => void runEvaluate()} disabled={evaluating}>{evaluating ? '评测中…' : '评测路由'}</button>
                  {!draftFromImport && <button className="btn" onClick={() => setDraftStage('input')}>重新生成</button>}
                  <button className="btn primary" onClick={applyDraft} disabled={!canWriteAgents}>{draftPickCount === 1 ? '只填入名字' : '填入表单'}</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {improveOpen && improveTarget && (
        <div className="overlay" ref={improveLayerRef} onClick={(e) => { if (!improving && e.target === e.currentTarget) setImproveOpen(false) }}>
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
                  <button className="btn primary" onClick={applyImprove} disabled={!canWriteAgents || improveDiff.length === 0}>应用勾选改动并保存</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {editing && (
        <div className="overlay" ref={editingLayerRef} onClick={(e) => e.target === e.currentTarget && setEditing(null)}>
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
                onChange={(v) => update(editing, { backend: v })}
                trigger={(cur, open) => (
                  <button className="btn menu-trigger" type="button">
                    {cur?.label ?? editing.backend} <span className="menu-caret">{open ? '▴' : '▾'}</span>
                  </button>
                )}
              />
            </label>
            <label className="field">
              <span>{CONNECTION_BACKENDS.includes(editing.backend) ? 'API 预设（连接覆盖；可空 = 平台默认连接）' : 'API 预设（可空 = 平台默认连接；该平台暂不支持注入，绑定保留、切回 zcode / claude 后生效）'}</span>
              <Menu
                items={[{ value: '', label: '不使用（平台默认）' }, ...presets.map((p) => ({ value: p.id, label: `${p.name}（${p.baseURL}）` }))]}
                value={editing.presetId ?? ''}
                onChange={(v) => update(editing, { presetId: v })}
                trigger={(cur, open) => (
                  <button className="btn menu-trigger" type="button">
                    {cur?.label ?? '不使用（平台默认）'} <span className="menu-caret">{open ? '▴' : '▾'}</span>
                  </button>
                )}
              />
            </label>
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
                placeholder="你是资深前端工程师，擅长 React/TS 组件与状态管理。写代码前先读现有实现、与既有风格保持一致；只改与任务相关的代码，拿不准的先问清再动手。"
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
              <button className="btn primary" onClick={commit} disabled={!canWriteAgents || !editing.name.trim()}>保存</button>
            </div>
          </div>
        </div>
      )}
    </>
  )

  return (
    <div className="psh-page">
      <PageHeader title="Agent" icon={<Users size={16} />} count={agentsLoadState === 'ready' ? agents.length : undefined} actions={actions} />
      <div className="psh-body">
        {sections}
      </div>
      {dialogs}
    </div>
  )
}
