import { useEffect, useId, useRef, useState } from 'react'
import type { AppSettings } from '../../../shared/types'
import { bridge, usePetState, useSettings } from '../api'
import { LoaderCircle, RefreshCw, Settings } from 'lucide-react'
import { Menu } from '../ui/Menu'
import { PageHeader } from '../ui/PageHeader'
import { EmptyState } from '../ui/EmptyState'
import { RuntimeView } from './RuntimeView'
import { UpdatePanel } from './UpdatePanel'
import { ui, isComposingKey } from '../ui/interaction-center'

const describe = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

/** 设置分区（侧栏导航用）；队伍已提级为顶级 Agent tab，运行时页并入设置 */
type Section = 'general' | 'runtime' | 'advanced' | 'storage' | 'updates'

const SECTIONS: Array<{ group: string; items: Array<{ id: Section; label: string; desc: string }> }> = [
  { group: '基础', items: [{ id: 'general', label: '常规', desc: '外观、执行与通知' }, { id: 'updates', label: '更新', desc: '热更通道与版本' }] },
  { group: '执行', items: [{ id: 'runtime', label: '运行时', desc: '后端路径与健康状态' }, { id: 'advanced', label: '调优', desc: '看门狗、重试、委派预算与护栏' }] },
  { group: '数据', items: [{ id: 'storage', label: '存储', desc: '数据落盘位置说明' }] }
]

export function SettingsView({ section, onSection }: { section: string; onSection: (s: string) => void }) {
  const active = (SECTIONS.flatMap((g) => g.items).find((item) => item.id === section)?.id ?? 'general') as Section
  const current = SECTIONS.flatMap((g) => g.items).find((item) => item.id === active)!
  return (
    <div className="settings-page">
      {/* 页题在两栏之上：全页只有一个主标题，导航与内容都从属于它 */}
      <PageHeader title="设置" icon={<Settings size={16} />} />
      <div className="settings-layout">
        <aside className="settings-nav" aria-label="设置分区">
          {SECTIONS.map((group) => (
            <div className="settings-nav-group" key={group.group}>
              <div className="settings-nav-group-label">{group.group}</div>
              {group.items.map((item) => (
                <button key={item.id} className={`settings-nav-item ${item.id === active ? 'active' : ''}`} onClick={() => onSection(item.id)}>
                  <span>{item.label}</span>
                  <small>{item.desc}</small>
                </button>
              ))}
            </div>
          ))}
        </aside>
        <div className="settings-body">
          <div className="section-heading"><h2>{current.label}</h2><span>{current.desc}</span></div>
          {active === 'general' && <GeneralSection />}
          {active === 'updates' && <UpdatePanel />}
          {active === 'runtime' && <RuntimeSection />}
          {active === 'advanced' && <AdvancedSection />}
          {active === 'storage' && <StorageSection />}
        </div>
      </div>
    </div>
  )
}

/** 常规：外观 + 执行 + 通知 */
function SettingsState({ loading, error, onRetry }: { loading: boolean; error: string | null; onRetry: () => void }) {
  return (
    <EmptyState
      icon={loading ? LoaderCircle : Settings}
      title={loading ? '设置加载中' : '设置加载失败'}
      description={loading ? '正在读取本地设置。' : (error ?? '无法读取本地设置。')}
      action={!loading ? <button className="btn" type="button" onClick={onRetry}><RefreshCw size={14} /> 重试</button> : undefined}
    />
  )
}

function GeneralSection() {
  const { settings, update, refresh, error } = useSettings()
  /**
   * 设置写盘统一兜错：失败必须看得见（toast + 调优项的 aria 反馈），
   * 绝不静默吞掉 rejection。各控件仍保持「本地草稿 + 即时提交」的既有模式。
   */
  const save = (patch: Partial<AppSettings>) => {
    update(patch).catch((cause) => ui.toast.error(`设置保存失败：${describe(cause)}`))
  }
  if (!settings && error) return <SettingsState loading={false} error={error} onRetry={() => { void refresh() }} />
  if (!settings) return <EmptyState title="设置加载中" />
  return (
    <div className="settings-stack">
      <section className="settings-card">
        <h3>外观</h3>
        <label className="field">
          <span>主题</span>
          <Menu
            items={[
              { value: 'dark', label: '深色' },
              { value: 'light', label: '浅色' },
              { value: 'system', label: '跟随系统' }
            ]}
            value={settings.theme ?? 'light'}
            onChange={(v) => save({ theme: v as AppSettings['theme'] })}
            trigger={(cur, open) => (
              <button className="btn menu-trigger" type="button">
                {cur?.label ?? '深色'} <span className="menu-caret">{open ? '▴' : '▾'}</span>
              </button>
            )}
          />
        </label>
      </section>

      <section className="settings-card">
        <h3>执行</h3>
        <label className="field">
          <span>并发任务数：{settings.concurrency}</span>
          <input
            type="range"
            min={1}
            max={4}
            value={settings.concurrency}
            onChange={(e) => save({ concurrency: Number(e.target.value) })}
          />
        </label>
        <label className="field">
          <span>权限模式</span>
          <Menu
            items={[
              { value: 'yolo', label: 'yolo', hint: '全自动，推荐' },
              { value: 'build', label: 'build', hint: '构建类操作自动放行' },
              { value: 'edit', label: 'edit', hint: '编辑需确认*' },
              { value: 'plan', label: 'plan', hint: '只读规划*' }
            ]}
            value={settings.mode}
            onChange={(v) => save({ mode: v as AppSettings['mode'] })}
            trigger={(cur, open) => (
              <button className="btn menu-trigger" type="button">
                {cur?.label ?? settings.mode} <span className="menu-caret">{open ? '▴' : '▾'}</span>
              </button>
            )}
          />
          <span className="hint">* 当前版本确认请求也会自动放行，交互式确认在路线图上</span>
        </label>
        <label className="field row-field">
          <input type="checkbox" checked={settings.notifyOnDone} onChange={(e) => save({ notifyOnDone: e.target.checked })} />
          <span>任务完成/失败时弹系统通知</span>
        </label>
      </section>

      <PetCard />
    </div>
  )
}

/** 数字调优项：本地草稿 + 失焦/回车提交（避免每次击键写盘）；越界或非法输入回落当前生效值 */
export function validateTuningValue(raw: string, min: number, max: number): string | null {
  if (!raw.trim()) return '请输入数值。'
  const next = Number(raw)
  if (!Number.isFinite(next) || !Number.isInteger(next)) return '请输入整数。'
  if (next < min || next > max) return `请输入 ${min} 到 ${max} 之间的整数。`
  return null
}

function TuningNumber({ label, value, min, max, unit, hint, onCommit }: {
  label: string
  value: number
  min: number
  max: number
  unit?: string
  hint?: string
  onCommit: (v: number) => void
}) {
  const [draft, setDraft] = useState(String(value))
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setDraft(String(value)) }, [value])
  const commit = () => {
    const validation = validateTuningValue(draft, min, max)
    setError(validation)
    if (validation) return
    const next = Number(draft)
    if (next === value) return
    onCommit(next)
  }
  const fieldId = useId()
  return (
    <label className="field">
      <span>{label}{unit ? `（${unit}）` : ''}</span>
      <input
        id={fieldId}
        type="number" min={min} max={max} step={1} value={draft}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={error ? `${fieldId}-error` : hint ? `${fieldId}-hint` : undefined}
        onChange={(e) => {
          const next = e.target.value
          setDraft(next)
          setError(validateTuningValue(next, min, max))
        }}
        onBlur={commit}
        onKeyDown={(e) => { if (isComposingKey(e.nativeEvent)) return; if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur() } }}
      />
      {error && <span id={`${fieldId}-error`} className="field-error" role="alert">{error}</span>}
      {hint && <span id={`${fieldId}-hint`} className="hint">{hint}</span>}
    </label>
  )
}

/** 调优：把散在主进程的运行参数暴露出来；保持默认 = 出厂行为，改小/改大用于调试 */
function AdvancedSection() {
  const { settings, update, refresh, error } = useSettings()
  if (!settings && error) return <SettingsState loading={false} error={error} onRetry={() => { void refresh() }} />
  if (!settings) return <EmptyState title="设置加载中" />
  const num = (v: number | undefined, d: number) => v ?? d
  const save = (patch: Partial<AppSettings>) => {
    update(patch).catch((e) => ui.toast.error(e instanceof Error ? e.message : String(e)))
  }
  return (
    <div className="settings-stack">
      <section className="settings-card">
        <h3>看门狗与超时</h3>
        <TuningNumber
          label="回合空转看门狗（分钟）" min={1} max={1440}
          value={Math.round(num(settings.turnIdleTimeoutMs, 600_000) / 60_000)}
          hint="回合等待终态期间「无任何事件」达此时长才判超时，有事件会自动续命；改小更快发现挂死，改大容忍长思考"
          onCommit={(v) => save({ turnIdleTimeoutMs: v * 60_000 })}
        />
        <TuningNumber
          label="权限请求自动拒绝（秒）" min={5} max={3600}
          value={Math.round(num(settings.permissionTimeoutMs, 300_000) / 1000)}
          hint="权限确认弹窗无响应超时后自动拒绝"
          onCommit={(v) => save({ permissionTimeoutMs: v * 1000 })}
        />
      </section>

      <section className="settings-card">
        <h3>失败重试</h3>
        <TuningNumber
          label="自动重试次数上限" min={0} max={10}
          value={num(settings.maxRetryAttempts, 2)}
          hint="仅对可重试的瞬态失败（限流/超时/进程崩溃/沙箱）生效；0 = 关闭自动重试"
          onCommit={(v) => save({ maxRetryAttempts: v })}
        />
        <TuningNumber
          label="限流（429）退避时长（秒）" min={0} max={3600}
          value={Math.round(num(settings.retryBackoffMs, 60_000) / 1000)}
          hint="命中限流后等待再重试的时长，立即重打只会继续 429"
          onCommit={(v) => save({ retryBackoffMs: v * 1000 })}
        />
      </section>

      <section className="settings-card">
        <h3>委派预算</h3>
        <TuningNumber
          label="单领队委派轮数上限" min={1} max={50}
          value={num(settings.delegateMaxRounds, 6)}
          hint="领队在一轮执行里最多派发几批队员"
          onCommit={(v) => save({ delegateMaxRounds: v })}
        />
        <TuningNumber
          label="全链委派轮数预算" min={1} max={200}
          value={num(settings.delegateMaxTotalRounds, 8)}
          hint="二层委派时祖先已用轮数计入，防递归派发失控"
          onCommit={(v) => save({ delegateMaxTotalRounds: v })}
        />
        <TuningNumber
          label="委派层级上限（层）" min={1} max={10}
          value={num(settings.delegateMaxDepth, 3)}
          hint="领队→子领队→队员的最大委派深度"
          onCommit={(v) => save({ delegateMaxDepth: v })}
        />
      </section>

      <section className="settings-card">
        <h3>护栏与回收</h3>
        <TuningNumber
          label="doom-loop 审批阈值（次）" min={2} max={100}
          value={num(settings.doomLoopThreshold, 3)}
          hint="同名同参工具连续调用 N 次触发人工确认"
          onCommit={(v) => save({ doomLoopThreshold: v })}
        />
        <TuningNumber
          label="阶段接力链上限（次）" min={1} max={100}
          value={num(settings.maxHandoffChain, 8)}
          hint="同一 Issue 上硬切（<continue>）接力的最大次数，防无限自继"
          onCommit={(v) => save({ maxHandoffChain: v })}
        />
        <TuningNumber
          label="委派 worktree 回收年龄（天）" min={1} max={365}
          value={num(settings.worktreeMaxAgeDays, 30)}
          hint="手动清理 worktree 时，超过该年龄的委派工作树会被回收"
          onCommit={(v) => save({ worktreeMaxAgeDays: v })}
        />
      </section>
    </div>
  )
}

/**
 * 运行时：后端路径配置 + provider 健康（原独立 Runtimes 页并入）。
 *
 * 路径编辑契约（Batch B）：输入框是本地草稿，显式「保存路径」才写盘；
 * 脏值 / 保存中 / 保存失败三态都要看得见，失败时草稿原样保留；
 * 「检测路径可用性」先等这次保存落盘再探测——否则探测的是旧路径，反馈会骗人。
 */
function RuntimeSection() {
  const { settings, update, refresh, error } = useSettings()
  const [probe, setProbe] = useState<{ ok: boolean; detail: string } | null>(null)
  const [probing, setProbing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [zcodePath, setZcodePath] = useState('')
  const [nodePath, setNodePath] = useState('')
  const [dshPath, setDshPath] = useState('')
  const saveRef = useRef(false)

  useEffect(() => {
    if (settings) {
      setZcodePath(settings.zcodePath)
      setNodePath(settings.nodePath)
      setDshPath(settings.dshPath ?? '')
    }
  }, [settings?.zcodePath, settings?.nodePath, settings?.dshPath])

  // 生效值（已落盘）与草稿比对；settings 还没到时不算脏，避免刚挂载就报未保存
  const dirty = !!settings && (
    zcodePath.trim() !== settings.zcodePath ||
    nodePath.trim() !== settings.nodePath ||
    dshPath.trim() !== (settings.dshPath ?? '')
  )

  const save = async (): Promise<boolean> => {
    if (saveRef.current) return false
    saveRef.current = true
    setSaving(true)
    setSaveError(null)
    try {
      await update({ zcodePath: zcodePath.trim(), nodePath: nodePath.trim(), dshPath: dshPath.trim() })
      setSavedAt(Date.now())
      return true
    } catch (cause) {
      const detail = describe(cause)
      setSaveError(detail)
      ui.toast.error(`运行时路径保存失败：${detail}`)
      return false
    } finally {
      saveRef.current = false
      setSaving(false)
    }
  }

  if (!settings && error) return <SettingsState loading={false} error={error} onRetry={() => { void refresh() }} />

  if (!settings) return <EmptyState title="设置加载中" />

  const doProbe = async () => {
    if (probing || saving) return
    // 检测必须基于已保存的路径：脏值先落盘，保存失败就不检测（错误已就地展示）
    if (dirty && !(await save())) return
    setProbing(true)
    setProbe(null)
    try {
      const r = await bridge.settings.probe()
      setProbe({ ok: r.ok, detail: r.detail })
    } catch (cause) {
      setProbe({ ok: false, detail: '检测失败: ' + describe(cause) })
    } finally {
      setProbing(false)
    }
  }

  return (
    <div className="settings-stack">
      <section className="settings-card">
        <h3>执行后端 · ZCode / DeepSeek Harness 路径</h3>
        <p className="hint">
          执行后端 = 实际执行任务的 CLI 程序（zcode、claude、codex、opencode、dsh）。zcode 与 dsh
          不是标准 PATH 安装，需要在此指定路径；claude / codex / opencode 装在 PATH 上即可自动发现，无需配置，未安装也不影响 zcode 使用。
        </p>
        <label className="field">
          <span>zcode.cjs 路径（留空 = 自动探测）</span>
          <input value={zcodePath} onChange={(e) => setZcodePath(e.target.value)} placeholder="D:\Program Files\ZCode\resources\glm\zcode.cjs" />
        </label>
        <label className="field">
          <span>Node 路径（留空 = 使用内置运行时）</span>
          <input value={nodePath} onChange={(e) => setNodePath(e.target.value)} placeholder="C:\Program Files\nodejs\node.exe" />
        </label>
        <label className="field">
          <span>DeepSeek Harness bin.js 路径（留空 = 自动扫描）</span>
          <input
            value={dshPath}
            onChange={(e) => setDshPath(e.target.value)}
            placeholder="D:\Program files\deepseek-harness\apps\cli\lib\bin.js"
          />
        </label>
        <div className="row">
          <button className="btn primary" type="button" onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? '保存中…' : '保存路径'}
          </button>
          <button className="btn" type="button" onClick={() => void doProbe()} disabled={probing || saving}>
            {probing ? '检测中…' : '检测路径可用性'}
          </button>
          {saving && <span className="hint">正在保存路径…</span>}
          {!saving && dirty && <span className="hint" data-paths-dirty>有未保存的修改；点「检测路径可用性」会先保存再探测。</span>}
          {!saving && !dirty && savedAt !== null && <span className="probe-ok" data-paths-saved>路径已保存，可检测。</span>}
          {probe && (
            <span className={probe.ok ? 'probe-ok' : 'probe-fail'} data-paths-probe>
              {probe.ok ? '✓ ' : '✗ '}
              {probe.detail}
            </span>
          )}
        </div>
        {saveError && (
          <p className="probe-fail" role="alert" data-paths-error>
            保存失败：{saveError}。改动仍保留在输入框，修正后可再次保存。
          </p>
        )}
      </section>
      <RuntimeView embedded />
    </div>
  )
}

/** 存储说明 */
function StorageSection() {
  const { settings, update, refresh, error } = useSettings()
  const [sharedRoot, setSharedRoot] = useState('')
  const [sharedError, setSharedError] = useState<string | null>(null)

  // 渲染层只读展示解析后的实际路径（settings.sharedDir 为空 = 主进程默认 ~/.agentdeck）
  useEffect(() => {
    let alive = true
    bridge.skills.list()
      .then((r) => { if (alive) { setSharedRoot(r.root); setSharedError(null) } })
      .catch((cause) => { if (alive) setSharedError(describe(cause)) })
    return () => { alive = false }
  }, [settings?.sharedDir])

  if (!settings && error) return <SettingsState loading={false} error={error} onRetry={() => { void refresh() }} />
  if (!settings) return <EmptyState title="设置加载中" icon={LoaderCircle} />

  const changeSharedDir = async () => {
    try {
      const dir = await bridge.pickDir()
      if (!dir) return
      await update({ sharedDir: dir })
      ui.toast.success('共享目录已更新')
    } catch (cause) {
      ui.toast.error(`共享目录更新失败：${describe(cause)}`)
    }
  }

  const openSharedDir = () => {
    bridge.skills.openDir().catch((cause) => ui.toast.error(`打开共享目录失败：${describe(cause)}`))
  }

  return (
    <div className="settings-stack">
      <section className="settings-card">
        <h3>共享目录</h3>
        <p className="hint">
          存放可手动编辑、可备份、可入库的用户资产（技能库 skills/ 等），与 Claude Code、Codex、ZCode 等工具的 SKILL.md 格式互通。
          应用状态（任务、设置、队伍）仍保存在 userData，两者互不混写。
        </p>
        <div className="mono storage-path">{sharedRoot || '…'}</div>
        {sharedError && <p className="probe-fail" role="alert">读取共享目录失败：{sharedError}</p>}
        <div className="row">
          <button className="btn" onClick={() => void changeSharedDir()}>更改…</button>
          <button className="btn" onClick={openSharedDir}>打开目录</button>
        </div>
      </section>
      <section className="settings-card">
        <h3>存储</h3>
        <p className="hint">
          任务数据保存在系统 userData 目录（tasks.json + 每任务 events.jsonl）。
          <br />
          首次执行会从 ZCode 登录态（~/.zcode/v2/config.json）生成本工具所需的 ~/.zcode/cli/config.json。
        </p>
      </section>
    </div>
  )
}

/** 小助理：开关 + 打开独立设置窗（全量设置已迁到 #/pet-settings 独立窗，见 pet/PetSettingsPage） */
function PetCard() {
  const { state } = usePetState()
  if (!state) return null
  const setEnabled = (on: boolean) => {
    bridge.pet.setEnabled(on).catch((cause) => ui.toast.error(`小助理开关保存失败：${describe(cause)}`))
  }
  return (
    <section className="settings-card">
      <h3>小助理</h3>
      <label className="field row-field">
        <input type="checkbox" checked={state.enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span>启用小助理（透明置顶小窗，可拖拽、可聊天）</span>
      </label>
      <div className="row" style={{ gap: 6 }}>
        <button className="btn" type="button" onClick={() => { bridge.pet.openSettingsWindow().catch((cause) => ui.toast.error(`打开小助理设置失败：${describe(cause)}`)) }}>打开小助理设置…</button>
        <span className="hint">素材包、人设、模型与生成素材包都在小助理设置窗里</span>
      </div>
    </section>
  )
}
