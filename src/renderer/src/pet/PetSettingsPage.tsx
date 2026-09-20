// 小助理设置窗页面：#/pet-settings hash 路由（独立 BrowserWindow，照 #/pet 先例复用 renderer 入口）。
// 全量承载小助理设置（素材包/persona 三预设+宏/自主间隔/模型预设+模型名/当前状态）+
// 「生成素材包」分区（pet:gen-* IPC：按态分表八表为默认——角色描述/风格标签/只读网格表随帧数联动/
// 进度按 sheet 计/结果带耗时与 QC 警告；per-frame 保留为可选）。
// 主程序设置的「常规」里只留开关与打开本窗的按钮（见 SettingsView 的 PetCard）。
//
// 读数口径：整页只挂一个 usePetState（页级读取一次），五张卡片共享同一份快照——读失败/重试/
// 陈旧提示都在页级结算，卡片不再各挂一份订阅、各读一次。
// 写入口径：任何设置写入都先等确认再改本地展示；失败必须可见并保留草稿，待确认期间拒绝重复提交。
import { useEffect, useRef, useState } from 'react'
import { bridge, usePetState, useSettings } from '../api'
import { PET_PERSONA_PRESETS } from '../../../shared/pet-lines'
import { PET_PRESET_NONE, petSheetGridFor, petSheetSizeForGrid } from '../../../shared/pet'
import type { PetGenStartInput, PetStateSnapshot } from '../../../shared/pet'
import { Menu } from '../ui/Menu'
import { ToastHost, toast } from '../ui/Toasts'

/** 生成默认角色描述（嵌入按态分表模板；背景/布局/铁律句由模板自带，描述只管角色本身） */
const DEFAULT_DESCRIPTION = 'cute round jelly blob mascot, mint green body, thick soft outline, flat shading, chibi, full body'
/** 帧数表默认值（八态照复盘 §4.1：idle3/walk4/fall2/dragged1/sleep2/happy2/think2/eat3） */
const DEFAULT_FRAME_COUNTS: Record<string, number> = { idle: 3, walk: 4, fall: 2, dragged: 1, sleep: 2, happy: 2, think: 2, eat: 3 }
const FRAME_STATE_LABELS: Array<{ id: string; label: string }> = [
  { id: 'idle', label: '待机' },
  { id: 'walk', label: '走路' },
  { id: 'fall', label: '下落' },
  { id: 'dragged', label: '被拖' },
  { id: 'sleep', label: '睡觉' },
  { id: 'happy', label: '开心' },
  { id: 'think', label: '思考' },
  { id: 'eat', label: '吃（可选，0=不生成）' }
]

const errText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)

/** 设置写入收口：失败必须提示（toast）并把原因交回调用方，调用方据此保留草稿/就地报错。
 *  返回 null = 已确认成功。 */
async function writeSetting(label: string, action: () => Promise<unknown>): Promise<string | null> {
  try {
    await action()
    return null
  } catch (cause) {
    const message = errText(cause)
    toast.error(`${label}失败：${message}`)
    return message
  }
}

/** 五张卡片共享同一份已确认快照 + 同一个刷新入口 */
interface CardProps {
  state: PetStateSnapshot
  onRefresh: () => Promise<unknown>
}

/** 单项设置写入：pending 闸门（同一份草稿连点只写一次）+ 失败原因就地保留 + 成功后刷新快照 */
function useSettingWriter(onRefresh: () => Promise<unknown>) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pendingRef = useRef(false)
  const run = async (label: string, action: () => Promise<unknown>): Promise<'ok' | 'failed' | 'busy'> => {
    if (pendingRef.current) return 'busy'
    pendingRef.current = true
    setPending(true)
    setError(null)
    const message = await writeSetting(label, action)
    if (message) setError(message)
    else await onRefresh()
    pendingRef.current = false
    setPending(false)
    return message ? 'failed' : 'ok'
  }
  return { pending, error, run }
}

export function PetSettingsPage() {
  const { state, refresh, loading, error, stale } = usePetState()
  const { settings } = useSettings()
  // 主题跟随主程序设置（独立窗不挂主 UI，自刷主题类）
  useEffect(() => {
    const theme = settings?.theme ?? 'dark'
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const apply = () => document.documentElement.classList.toggle('light', theme === 'light' || (theme === 'system' && mq.matches))
    apply()
    if (theme === 'system') { mq.addEventListener('change', apply); return () => mq.removeEventListener('change', apply) }
  }, [settings?.theme])
  return (
    <div className="pet-settings-page">
      <ToastHost />
      <header className="pet-settings-head">
        <h2>小助理设置</h2>
        <span className="page-desc">透明置顶小窗，可拖拽、可聊天、会自己说话</span>
      </header>
      {/* 读到过快照但这次刷新失败：保留旧快照并标明它来自上一次成功读取 */}
      {stale && (
        <div className="data-state-banner data-state-stale" role="status" data-pet-stale>
          <span>显示上次成功读取的小助理状态：{error}</span>
          <button className="btn" type="button" onClick={() => void refresh()} disabled={loading}>{loading ? '重试中…' : '重试'}</button>
        </div>
      )}
      {state ? (
        <div className="settings-stack">
          <StatusCard state={state} onRefresh={refresh} />
          <PackCard state={state} onRefresh={refresh} />
          <PersonaCard state={state} onRefresh={refresh} />
          <ModelCard state={state} onRefresh={refresh} />
          <GenCard state={state} onRefresh={refresh} />
        </div>
      ) : (
        <div className="settings-stack">
          {/* 「未启用」是有效状态（state.enabled=false），不是加载态；这里只处理真的没有快照 */}
          <section className="settings-card" data-pet-read={loading ? 'loading' : error ? 'error' : 'empty'}>
            <h3>小助理</h3>
            <p className="hint">
              {loading ? '正在读取小助理状态…' : error ? `小助理状态读取失败：${error}` : '暂时读不到小助理状态。'}
            </p>
            {!loading && <button className="btn" type="button" onClick={() => void refresh()}>重试</button>}
          </section>
        </div>
      )}
    </div>
  )
}

/** 当前状态行（好感/心情/投喂/最近事件）+ 启用开关 */
function StatusCard({ state, onRefresh }: CardProps) {
  const { pending, error: actionError, run } = useSettingWriter(onRefresh)
  return (
    <section className="settings-card">
      <h3>小助理</h3>
      {!state.enabled && <p className="hint" data-pet-disabled>小助理当前未启用：下面的设置仍会保存，启用后生效。</p>}
      {state.enabled && state.life && (
        <label className="field">
          <span>当前状态</span>
          <span className="hint">
            好感 {state.life.affection}（{state.life.tier}）· 心情 {state.life.mood}（{state.life.moodLabel}）· 今日投喂 {state.life.fedToday} 次
            {state.recentEvent ? ` · 最近事件：${state.recentEvent}` : ''}
          </span>
          <span className="hint">点它、陪它聊天、给它投喂、完成任务都会累积好感；好感与心情会悄悄影响它的行为和台词。</span>
        </label>
      )}
      <label className="field row-field">
        <input
          type="checkbox"
          checked={state.enabled}
          disabled={pending}
          onChange={(e) => { const next = e.target.checked; void run('启用小助理', () => bridge.pet.setEnabled(next)) }}
        />
        <span>启用小助理（透明置顶小窗，可拖拽、可聊天）</span>
      </label>
      <label className="field">
        <span>尺寸（窗体、精灵与命中区同缩放）</span>
        <Menu
          items={[{ value: '1', label: '100%' }, { value: '1.5', label: '150%' }, { value: '2', label: '200%' }]}
          value={String(state.zoom)}
          onChange={(v) => void run('小助理尺寸保存', () => bridge.pet.setZoom(Number(v)))}
          trigger={(cur, open) => (
            <button className="btn menu-trigger" type="button">
              {cur?.label ?? '100%'} <span className="menu-caret">{open ? '▴' : '▾'}</span>
            </button>
          )}
        />
      </label>
      {pending && <span className="hint" data-pet-pending>正在保存…</span>}
      {actionError && <span className="hint" data-pet-action-error>保存失败：{actionError}</span>}
    </section>
  )
}

/** 素材包选择 + 坏包提示 */
function PackCard({ state, onRefresh }: CardProps) {
  const { pending, error: actionError, run } = useSettingWriter(onRefresh)
  return (
    <section className="settings-card">
      <h3>素材包</h3>
      <label className="field">
        <span>当前素材包</span>
        <Menu
          items={state.packs.filter((pack) => pack.ok).map((pack) => ({
            value: pack.id,
            label: pack.builtin ? pack.id : `${pack.id}（用户）`,
            hint: `${pack.frameCount} 帧`
          }))}
          value={state.packId}
          onChange={(v) => void run('素材包切换', () => bridge.pet.setPack(v))}
          trigger={(cur, open) => (
            <button className="btn menu-trigger" type="button">
              {cur?.label ?? state.packId} <span className="menu-caret">{open ? '▴' : '▾'}</span>
            </button>
          )}
        />
      </label>
      {state.packs.some((pack) => !pack.ok) && (
        <span className="hint">
          已跳过坏素材包：{state.packs.filter((pack) => !pack.ok).map((pack) => `${pack.id}（${pack.reason}）`).join('、')}
        </span>
      )}
      {pending && <span className="hint" data-pet-pack-pending>正在保存…</span>}
      {actionError && <span className="hint" data-pet-pack-error>切换素材包失败：{actionError}</span>}
    </section>
  )
}

/** persona 人设：三版预设 + 宏插入 + 文本域 */
function PersonaCard({ state, onRefresh }: CardProps) {
  const [personaDraft, setPersonaDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [autonomyError, setAutonomyError] = useState<string | null>(null)
  // 草稿版本号：保存期间「改走又改回来」也算更新的一份草稿，不能被迟到的成功收起
  const revision = useRef(0)
  // 滑杆照本地区间设置模式写：每次变更都提交（末次生效），只有最新一次的结果决定提示
  const autonomySeq = useRef(0)
  const commitAutonomy = (next: number) => {
    const seq = ++autonomySeq.current
    void (async () => {
      const message = await writeSetting('自主发言间隔保存', () => bridge.pet.setAutonomy(next))
      if (seq === autonomySeq.current) setAutonomyError(message)
    })()
  }
  const persona = personaDraft ?? state.personaPrompt
  const editDraft = (next: string | null) => { revision.current++; setPersonaDraft(next) }
  const insertMacro = (macro: string) => {
    revision.current++
    setPersonaDraft((current) => {
      const base = current ?? state.personaPrompt
      return `${base.trimEnd()}${base.trim() ? '\n' : ''}{${macro}}`
    })
  }
  const savePersona = async () => {
    // 闸门用 ref：同一 tick 内的连点看到的还是上一次渲染的 saving=false
    if (savingRef.current || personaDraft === null) return
    savingRef.current = true
    const submitted = persona
    const submittedRevision = revision.current
    setSaving(true)
    setSaveError(null)
    try {
      await bridge.pet.setPersona(submitted)
      if (revision.current === submittedRevision) setPersonaDraft(null)
      toast.success('人设已保存')
      void onRefresh()
    } catch (cause) {
      const message = errText(cause)
      setSaveError(message)
      toast.error(`人设保存失败：${message}`)
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }
  return (
    <section className="settings-card">
      <h3>人设</h3>
      <label className="field">
        <span>人设预设</span>
        <Menu
          items={PET_PERSONA_PRESETS.map((preset) => ({ value: preset.id, label: preset.label }))}
          value={PET_PERSONA_PRESETS.find((preset) => preset.template === persona)?.id ?? ''}
          onChange={(id) => {
            const preset = PET_PERSONA_PRESETS.find((item) => item.id === id)
            if (preset) editDraft(preset.template)
          }}
          trigger={(cur, open) => (
            <button className="btn menu-trigger" type="button">
              {cur?.label ?? '自定义（基于当前文本）'} <span className="menu-caret">{open ? '▴' : '▾'}</span>
            </button>
          )}
        />
        <span className="hint">选中预设会把模板填入下方文本域，可继续手改；点「保存人设」才生效</span>
      </label>
      <label className="field">
        <span>人设提示词（系统提示词，支持宏；空 = 内置「活泼」预设）</span>
        <textarea
          rows={6}
          value={persona}
          onChange={(e) => editDraft(e.target.value)}
          placeholder="留空使用内置「活泼」预设"
        />
        <span className="hint">
          可用宏：{'{board_summary} 看板摘要'}、{'{pack_name} 素材包'}、{'{time_of_day} 时段'}、{'{model} 模型'}、{'{recent_event} 最近看板事件'}；缺失的宏自动降级为「暂无」。
          模板需内联输出契约（只输出 JSON {'{"say","action"}'}，say≤30 字，action 五值枚举）。
        </span>
        <span className="row" style={{ gap: 6, marginTop: 6 }}>
          {['board_summary', 'pack_name', 'time_of_day', 'model', 'recent_event'].map((macro) => (
            <button key={macro} className="btn" type="button" onClick={() => insertMacro(macro)}>+{macro}</button>
          ))}
        </span>
        <span className="row" style={{ gap: 6, marginTop: 6 }}>
          <button className="btn primary" type="button" disabled={saving || personaDraft === null} onClick={() => void savePersona()}>
            {saving ? '保存中…' : '保存人设'}
          </button>
          <button className="btn" type="button" disabled={personaDraft === null} onClick={() => editDraft(null)}>放弃修改</button>
        </span>
        {personaDraft !== null && <span className="hint" data-persona-dirty>有未保存的修改；「保存人设」成功后才会生效。</span>}
        {saveError && <span className="hint" data-persona-error>人设保存失败：{saveError}（草稿已保留，可重试）</span>}
      </label>
      <label className="field">
        <span>自主发言间隔：{state.autonomySec}s（下限 20s）</span>
        <input
          type="range"
          min={20}
          max={300}
          step={10}
          value={state.autonomySec}
          onChange={(e) => commitAutonomy(Number(e.target.value))}
        />
        {autonomyError && <span className="hint" data-pet-autonomy-error>自主发言间隔保存失败：{autonomyError}（已回到保存生效的值）</span>}
      </label>
    </section>
  )
}

/** 模型预设 + 模型名 + AI 脑状态 */
function ModelCard({ state, onRefresh }: CardProps) {
  // Both controls update the same preset/model pair, so writes share one queue.
  const presetWriter = useSettingWriter(onRefresh)
  const modelWriter = useSettingWriter(onRefresh)
  const writes = useRef<Promise<void>>(Promise.resolve())
  const latestModelWrite = useRef<{ text: string; revision: number; result: Promise<void> } | null>(null)
  const presetRef = useRef(state.presetId)
  useEffect(() => { presetRef.current = state.presetId }, [state.presetId])
  const enqueue = (action: () => Promise<void>) => {
    const next = writes.current.then(action)
    writes.current = next.catch(() => {})
    return next
  }
  // 模型名走受控草稿：state.model 因预设切换/外部写入变化时草稿跟随，不再是一个永不跟预设走的 defaultValue
  const [modelDraft, setModelDraft] = useState<string | null>(null)
  const modelRevision = useRef(0)
  const modelBase = useRef(state.model)
  const ownEcho = useRef<string | null>(null)
  useEffect(() => {
    if (modelBase.current === state.model) return
    modelBase.current = state.model
    // 自己刚提交的值回显：保存期间输入的新草稿要留着，不能被回显抹掉
    if (ownEcho.current !== null && state.model === ownEcho.current) { ownEcho.current = null; return }
    setModelDraft(null)
  }, [state.model])
  const model = modelDraft ?? state.model
  const commitModel = async () => {
    const submitted = model.trim()
    if (!latestModelWrite.current && !presetWriter.pending && submitted === state.model) { modelRevision.current++; setModelDraft(null); return }
    const revision = modelRevision.current
    if (latestModelWrite.current?.text === submitted && latestModelWrite.current.revision === revision) return latestModelWrite.current.result
    const result = enqueue(async () => {
      ownEcho.current = submitted
      const outcome = await modelWriter.run('模型名保存', () => bridge.pet.setPreset(presetRef.current, submitted))
      if (outcome === 'failed') { ownEcho.current = null; return }
      if (outcome === 'ok' && modelRevision.current === revision) setModelDraft(null)
    })
    const submittedWrite = { text: submitted, revision, result }
    latestModelWrite.current = submittedWrite
    await result
    if (latestModelWrite.current === submittedWrite) latestModelWrite.current = null
  }
  return (
    <section className="settings-card">
      <h3>模型</h3>
      <label className="field">
        <span>模型预设（小助理 AI 脑走这里；密钥不离开主进程）</span>
        <Menu
          items={[{ value: PET_PRESET_NONE, label: '不接 AI（用本地台词）' }, ...state.presets.map((preset) => ({ value: preset.id, label: `${preset.name}（${preset.protocol}）` }))]}
          value={state.presetId}
          onChange={(v) => {
            if (presetWriter.pending || modelWriter.pending) return
            // 带上输入框里看得见的值：预设切换不该把刚填/刚存的模型名回退成旧值
            const nextModel = model.trim() || state.model
            const revision = modelRevision.current
            const previousPreset = state.presetId
            presetRef.current = v
            void enqueue(async () => {
              ownEcho.current = nextModel
              const outcome = await presetWriter.run('模型预设切换', () => bridge.pet.setPreset(v, nextModel))
              if (outcome === 'failed') { presetRef.current = previousPreset; ownEcho.current = null }
              else if (outcome === 'ok' && modelRevision.current === revision) setModelDraft(null)
            })
          }}
          trigger={(cur, open) => (
            <button className="btn menu-trigger" type="button" disabled={presetWriter.pending || modelWriter.pending}>
              {cur?.label ?? (state.activePresetId ? `${state.presets.find((preset) => preset.id === state.activePresetId)?.name ?? state.activePresetId}（自动）` : '选择预设')} <span className="menu-caret">{open ? '▴' : '▾'}</span>
            </button>
          )}
        />
        <span className="hint">
          {state.brainStatus.source === 'llm' && 'AI 脑正常：最近一次发言走了模型'}
          {state.brainStatus.source === 'fallback' && `AI 走兜底台词${state.brainStatus.lastError ? `：${state.brainStatus.lastError}` : ''}`}
          {state.brainStatus.source === 'none' && 'AI 脑尚未发言（等一个自主间隔，或先在聊天里问一句）'}
          {state.brainStatus.silenced ? '；连续失败已进入 10 分钟静默' : ''}
        </span>
        {state.presetId === '' && state.presets.length > 0 && (
          <span className="hint">未选择预设——已自动使用第一个预设；要停用 AI 请选「不接 AI」</span>
        )}
        {state.presetId === PET_PRESET_NONE && <span className="hint">当前「不接 AI」：模型名不会生效，选一个预设后再填。</span>}
        {presetWriter.pending && <span className="hint" data-pet-preset-pending>正在保存预设…</span>}
        {presetWriter.error && <span className="hint" data-pet-preset-error>预设切换失败：{presetWriter.error}（仍显示上次确认的预设，可重试）</span>}
      </label>
      <label className="field">
        <span>模型名（OpenAI 兼容协议建议填写；Anthropic 协议必填）</span>
        <input
          type="text"
          value={model}
          placeholder="例如 deepseek-chat / claude-3-5-haiku-latest"
          onChange={(e) => { modelRevision.current++; setModelDraft(e.target.value) }}
          onBlur={() => void commitModel()}
        />
        {modelWriter.pending && <span className="hint" data-pet-model-pending>正在保存模型名…</span>}
        {modelWriter.error && <span className="hint" data-pet-model-error>模型名保存失败：{modelWriter.error}（草稿已保留，失焦可重试）</span>}
      </label>
    </section>
  )
}

/** 生成素材包：走所选预设的 images 通道；默认按态分表（每态一张洋红 sheet，锚点保一致性）；完成即进素材包下拉 */
function GenCard({ state, onRefresh }: CardProps) {
  const [packId, setPackId] = useState('my-pet')
  const [presetId, setPresetId] = useState<string | null>(null)
  const [model, setModel] = useState<string | null>(null)
  const [size, setSize] = useState('1024x1024')
  const [quality, setQuality] = useState('medium') // 按态分表默认 medium（1k 单张 30–60s，控制在网关超时内）
  const [background, setBackground] = useState<'transparent' | 'opaque'>('transparent')
  const [mode, setMode] = useState<'sheets' | 'per-frame'>('sheets')
  const [description, setDescription] = useState(DEFAULT_DESCRIPTION)
  const [styleTags, setStyleTags] = useState('')
  const [frameCounts, setFrameCounts] = useState<Record<string, number>>(DEFAULT_FRAME_COUNTS)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [cancelling, setCancelling] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number; stage: string } | null>(null)
  const [result, setResult] = useState<string | null>(null)

  useEffect(() => {
    const offProgress = bridge.pet.onGenProgress((p) => setProgress(p))
    const offDone = bridge.pet.onGenDone(({ packId: id, frameCount, warnings, elapsedMs }) => {
      busyRef.current = false
      setBusy(false)
      setCancelling(false)
      setProgress(null)
      const secs = Math.round((elapsedMs ?? 0) / 1000)
      const warnTail = warnings?.length ? `；⚠ QC 警告 ${warnings.length} 条：${warnings.join('；')}` : ''
      setResult(`✓ 已生成 ${frameCount} 帧 → 素材包「${id}」（耗时 ${secs}s${warnTail}）`)
      if (warnings?.length) toast.success(`素材包生成完成（含 ${warnings.length} 条警告）`)
      else toast.success('素材包生成完成')
      void onRefresh()
    })
    const offError = bridge.pet.onGenError(({ reason }) => {
      busyRef.current = false
      setBusy(false)
      setCancelling(false)
      setProgress(null)
      setResult(`✗ ${reason}`)
      toast.error(`素材包生成失败：${reason}`)
    })
    return () => {
      offProgress()
      offDone()
      offError()
    }
  }, [onRefresh])

  const usablePresets = state.presets
  const effectivePresetId = presetId ?? (state.presetId && state.presetId !== PET_PRESET_NONE ? state.presetId : state.activePresetId)
  const activeStates = FRAME_STATE_LABELS.filter(({ id }) => (frameCounts[id] ?? 0) > 0)
  const start = () => {
    if (busyRef.current) return
    const states: Record<string, number> = {}
    for (const { id } of FRAME_STATE_LABELS) {
      const count = Math.max(0, Math.round(frameCounts[id] ?? 0))
      if (count > 0) states[id] = count
    }
    const input: PetGenStartInput = {
      packId: packId.trim(),
      presetId: effectivePresetId,
      model: (model ?? state.model).trim(),
      params: { size, quality, n: 1, background },
      stylePrompt: description.trim(),
      ...(mode === 'sheets' && styleTags.trim() ? { styleTags: styleTags.trim() } : {}),
      states,
      mode
    }
    busyRef.current = true
    setBusy(true)
    setCancelling(false)
    setProgress(
      mode === 'sheets'
        ? { done: 0, total: activeStates.length, stage: '提交生成请求' }
        : { done: 0, total: Object.values(states).reduce((a, b) => a + b, 0), stage: '提交生成请求' }
    )
    setResult(null)
    void bridge.pet.genStart(input).then((res) => {
      if (!res.ok) {
        busyRef.current = false
        setBusy(false)
        setProgress(null)
        setResult(`✗ ${res.error ?? '无法启动生成'}`)
      }
    }).catch((cause) => {
      // 启动被拒（IPC 拒绝/主进程抛错）：放开 busy，配置原样保留，只回显失败原因
      busyRef.current = false
      setBusy(false)
      setCancelling(false)
      setProgress(null)
      setResult(`✗ ${errText(cause)}`)
      toast.error(`无法启动生成：${errText(cause)}`)
    })
  }
  const cancel = async () => {
    if (cancelling) return
    setCancelling(true)
    const message = await writeSetting('取消生成', () => bridge.pet.genCancel())
    setCancelling(false)
    setResult(message ? `✗ 取消失败：${message}` : '已请求取消：当前帧完成后停下。')
  }
  const totalFrames = Object.values(frameCounts).reduce((a, b) => a + Math.max(0, b), 0)
  const percent = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0
  return (
    <section className="settings-card">
      <h3>生成素材包</h3>
      <p className="hint">
        用上方模型预设的 images 接口（OpenAI 形状）现场生成一套素材包。默认按态分表：每个状态一张洋红底 sheet，首张文生图、其余拿首张当锚点图生图保角色一致，生成后自动切帧去背进包。apiKey 只在主进程使用，不落日志。
      </p>
      <label className="field">
        <span>模式</span>
        <Menu
          items={[{ value: 'sheets', label: '按态分表（推荐）', hint: '每态一张洋红 sheet，锚点保一致' }, { value: 'per-frame', label: '逐帧生成', hint: '首帧作参考图，慢且易漂移' }]}
          value={mode}
          onChange={(v) => setMode(v as 'sheets' | 'per-frame')}
          trigger={(cur, open) => (
            <button className="btn menu-trigger" type="button">
              {cur?.label ?? '按态分表（推荐）'} <span className="menu-caret">{open ? '▴' : '▾'}</span>
            </button>
          )}
        />
      </label>
      <label className="field">
        <span>包 id（字母/数字/连字符；重名覆盖旧包）</span>
        <input type="text" value={packId} onChange={(e) => setPackId(e.target.value)} placeholder="my-pet" />
      </label>
      <label className="field">
        <span>生成用预设（复用 API 预设的 apiKey）</span>
        <Menu
          items={usablePresets.map((preset) => ({ value: preset.id, label: `${preset.name}（${preset.protocol}）` }))}
          value={effectivePresetId}
          onChange={setPresetId}
          trigger={(cur, open) => (
            <button className="btn menu-trigger" type="button">
              {cur?.label ?? '选择预设'} <span className="menu-caret">{open ? '▴' : '▾'}</span>
            </button>
          )}
        />
      </label>
      <label className="field">
        <span>图像模型名（如 gpt-image-1；留空用上方模型名）</span>
        <input type="text" value={model ?? ''} onChange={(e) => setModel(e.target.value)} placeholder="留空 = 聊天模型名" />
      </label>
      {mode === 'per-frame' && (
        <div className="pet-gen-grid">
          <label className="field">
            <span>尺寸</span>
            <Menu
              items={[{ value: '512x512', label: '512×512' }, { value: '768x768', label: '768×768' }, { value: '1024x1024', label: '1024×1024' }]}
              value={size}
              onChange={setSize}
              trigger={(cur, open) => (
                <button className="btn menu-trigger" type="button">
                  {cur?.label ?? size} <span className="menu-caret">{open ? '▴' : '▾'}</span>
                </button>
              )}
            />
          </label>
          <label className="field">
            <span>背景</span>
            <Menu
              items={[{ value: 'transparent', label: '透明（去背）' }, { value: 'opaque', label: '保留背景' }]}
              value={background}
              onChange={(v) => setBackground(v as 'transparent' | 'opaque')}
              trigger={(cur, open) => (
                <button className="btn menu-trigger" type="button">
                  {cur?.label ?? '透明'} <span className="menu-caret">{open ? '▴' : '▾'}</span>
                </button>
              )}
            />
          </label>
        </div>
      )}
      <label className="field">
        <span>质量（按态分表默认 medium：单张控制在网关超时内）</span>
        <Menu
          items={[{ value: '', label: '网关默认（按态分表回落 medium）' }, { value: 'low', label: 'low' }, { value: 'medium', label: 'medium' }, { value: 'high', label: 'high' }]}
          value={quality}
          onChange={setQuality}
          trigger={(cur, open) => (
            <button className="btn menu-trigger" type="button">
              {cur?.label ?? 'medium'} <span className="menu-caret">{open ? '▴' : '▾'}</span>
            </button>
          )}
        />
      </label>
      <label className="field">
        <span>角色描述（嵌入生成模板；英文效果更稳）</span>
        <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="例如：cute round jelly blob mascot, mint green body, chibi" />
      </label>
      {mode === 'sheets' && (
        <label className="field">
          <span>风格标签（可选；追加在一致性约束之后，如 kawaii chibi, thick outline）</span>
          <input type="text" value={styleTags} onChange={(e) => setStyleTags(e.target.value)} placeholder="留空 = 不加风格标签" />
        </label>
      )}
      <label className="field">
        <span>帧数表{mode === 'sheets' ? '（网格与逐格动作随帧数自动换算，共 ' : '（共 '}{totalFrames} 帧）</span>
        <div className="pet-gen-grid">
          {FRAME_STATE_LABELS.map(({ id, label }) => {
            const count = Math.max(0, frameCounts[id] ?? 0)
            const grid = petSheetGridFor(Math.max(1, count))
            return (
              <label className="field" key={id}>
                <span>{label}</span>
                <input
                  type="number"
                  min={id === 'eat' ? 0 : 1}
                  max={32}
                  value={count}
                  onChange={(e) => setFrameCounts((cur) => ({ ...cur, [id]: Number(e.target.value) || 0 }))}
                />
                {mode === 'sheets' && count > 0 && (
                  <span className="hint">
                    {grid.rows}×{grid.cols} 网格 · {petSheetSizeForGrid(grid)}
                  </span>
                )}
              </label>
            )
          })}
        </div>
      </label>
      {mode === 'sheets' && <p className="hint">按态分表约束：洋红 #FF00FF 底、N 等分无框线、无文字、角色占格 80%+；成品帧 256px（rendering: smooth）。八张 sheet 约 6 分钟（单张 30–60s，504 自动退避重试），包约 1MB。</p>}
      <div className="row" style={{ gap: 6 }}>
        <button className="btn primary" type="button" disabled={busy || !effectivePresetId || totalFrames < 1} onClick={start}>
          {busy ? '生成中…' : '开始生成'}
        </button>
        {busy && (
          <button className="btn" type="button" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? '取消中…' : '取消'}</button>
        )}
      </div>
      {!effectivePresetId && <span className="hint" data-gen-blocked>还不能开始：先选一个模型预设（生成走它的 images 通道）。</span>}
      {effectivePresetId && totalFrames < 1 && <span className="hint" data-gen-blocked>还不能开始：帧数表全为 0，至少给一个状态配 1 帧。</span>}
      {progress && (
        <label className="field">
          <span>{progress.stage}：{progress.done}/{progress.total}</span>
          <div className="pet-gen-bar"><div className="pet-gen-bar-fill" style={{ width: `${percent}%` }} /></div>
        </label>
      )}
      {result && <span className="hint" data-gen-result>{result}</span>}
    </section>
  )
}
