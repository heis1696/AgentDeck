import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle, Plus, RefreshCw, Search, Sparkles, Trash2, Upload } from 'lucide-react'
import { bridge, fmtTime, useSettings } from '../api'
import { ui } from '../ui/interaction-center'
import { EmptyState } from '../ui/EmptyState'
import type { SkillDetail, SkillMeta, SkillTarget, SyncState } from '../../../shared/skills'

type TargetStates = Record<string, Record<string, SyncState>>

const describe = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

/**
 * 刷新失败但手里还有旧数据时的横幅：数据照常展示，只说清「这是陈旧快照」并给重试。
 * 首次失败不走这里——那种情况没有可展示的数据，各 tab 用 EmptyState + 重试。
 */
export function StaleBanner({ marker, label, error, onRetry, busy }: {
  marker: string
  label: string
  error: string
  onRetry: () => void
  busy?: boolean
}) {
  return <div className="data-state-banner data-state-stale" role="status" data-stale={marker}>
    <RefreshCw size={13} />
    <span>{label}：{error}</span>
    <button className="btn" type="button" onClick={onRetry} disabled={busy}>
      <RefreshCw size={12} className={busy ? 'spin' : ''} /> 重试
    </button>
  </div>
}

interface SkillDraft {
  name: string
  description: string
  body: string
  /** 已存在的技能名（编辑/重命名基准）；null = 全新技能 */
  originName: string | null
}

/** 技能列表行的聚合状态点：全绿=全部目标 in-sync；黄=存在 outdated；灰=未安装到任何目标 */
function aggregateState(states: Record<string, SyncState> | undefined, targets: SkillTarget[]): 'ok' | 'warn' | 'none' {
  if (!states) return 'none'
  const values = targets.map((target) => states[target.id] ?? 'missing')
  if (values.length === 0 || values.every((v) => v === 'missing')) return 'none'
  if (values.every((v) => v === 'in-sync')) return 'ok'
  return 'warn'
}

/** 技能 tab：共享目录技能库（SKILL.md 标准，可一键同步到各 agent CLI 技能目录）。
 *  由 ExtensionsView 挂载；外壳（page-surface / page-header-bar / tab 条）在扩展页统一提供。
 *
 *  读状态契约（Batch B follow-up）：加载中 / 首次失败 / 成功但为空 / 陈旧四态互斥；
 *  刷新失败保留上次成功的数据并给重试；共享目录未知（设置没到、清单一度没读成功）时不写盘，
 *  因为写操作需要一个确定的目录。 */
export function SkillsTab() {
  const { settings } = useSettings()
  const [root, setRoot] = useState('')
  const [skills, setSkills] = useState<SkillMeta[]>([])
  const [targets, setTargets] = useState<SkillTarget[]>([])
  const [states, setStates] = useState<TargetStates>({})
  const [draft, setDraft] = useState<SkillDraft | null>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [targetsLoaded, setTargetsLoaded] = useState(false)
  const [targetsError, setTargetsError] = useState<string | null>(null)
  const [reloading, setReloading] = useState(true)
  const requestRef = useRef(0)

  /** 清单与目标各自结算：一边失败不抹掉另一边的数据，也不把失败渲染成「空」 */
  const refreshAll = useCallback(async () => {
    const request = ++requestRef.current
    setReloading(true)
    const [listResult, targetResult] = await Promise.allSettled([bridge.skills.list(), bridge.skills.targets()])
    if (request !== requestRef.current) return
    if (listResult.status === 'fulfilled') {
      setRoot(listResult.value.root)
      setSkills(listResult.value.skills)
      setLoaded(true)
      setListError(null)
    } else {
      setListError(describe(listResult.reason))
    }
    if (targetResult.status === 'fulfilled') {
      setTargets(targetResult.value.targets)
      setStates(targetResult.value.states)
      setTargetsLoaded(true)
      setTargetsError(null)
    } else {
      setTargetsError(describe(targetResult.reason))
    }
    setReloading(false)
  }, [])

  // 挂载与共享目录变更（settings:updated → useSettings）都会重载
  useEffect(() => { void refreshAll() }, [settings?.sharedDir, refreshAll])
  useEffect(() => () => { requestRef.current++ }, [])

  /** 写操作需要一个确定的共享目录：设置没到或清单一度没读成功时一律禁用 */
  const dirKnown = !!settings && loaded
  const writesBlocked = !dirKnown

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return skills
    return skills.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(q))
  }, [skills, query])

  const openSkill = async (name: string) => {
    try {
      const detail: SkillDetail | null = await bridge.skills.get(name)
      if (!detail) { ui.toast.error(`技能不存在: ${name}`); return }
      setDraft({ name: detail.name, description: detail.description, body: detail.body, originName: detail.name })
    } catch (e) {
      ui.toast.error('读取技能失败: ' + describe(e))
    }
  }
  const newSkill = () => {
    if (writesBlocked) { ui.toast.error('共享目录未知，暂时不能新建技能。'); return }
    setDraft({ name: '', description: '', body: '', originName: null })
  }

  const save = async () => {
    if (!draft || busy || writesBlocked) return
    const name = draft.name.trim()
    if (!name) { ui.toast.error('技能名不能为空'); return }
    setBusy(true)
    try {
      const meta = await bridge.skills.save(name, {
        description: draft.description,
        body: draft.body,
        ...(draft.originName ? { originName: draft.originName } : {})
      })
      await refreshAll()
      setDraft({ name: meta.name, description: meta.description, body: draft.body, originName: meta.name })
      ui.toast.success(`已保存「${meta.name}」`)
    } catch (e) {
      ui.toast.error('保存失败: ' + describe(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (name: string) => {
    if (writesBlocked) { ui.toast.error('共享目录未知，暂时不能删除技能。'); return }
    if (!await ui.confirm({ title: `删除技能「${name}」？`, body: '共享目录中的技能目录会被删除；已安装到各工具的副本不受影响，可稍后卸载。', danger: true, confirmText: '删除' })) return
    try {
      await bridge.skills.delete(name)
      if (draft?.originName === name) setDraft(null)
      await refreshAll()
      ui.toast.success(`已删除「${name}」`)
    } catch (e) {
      ui.toast.error('删除失败: ' + describe(e))
    }
  }

  const importFromDir = async () => {
    if (writesBlocked) { ui.toast.error('共享目录未知，暂时不能导入技能。'); return }
    const dir = await bridge.pickDir()
    if (!dir) return
    try {
      const meta = await bridge.skills.import(dir)
      await refreshAll()
      await openSkill(meta.name)
      ui.toast.success(`已导入「${meta.name}」`)
    } catch (e) {
      ui.toast.error('导入失败: ' + describe(e))
    }
  }

  const toggleTarget = async (name: string, targetId: string) => {
    if (busy || writesBlocked) return
    setBusy(true)
    try {
      const state = states[name]?.[targetId] ?? 'missing'
      if (state === 'in-sync') await bridge.skills.uninstall(name, targetId)
      else await bridge.skills.install(name, targetId)
      await refreshAll()
    } catch (e) {
      ui.toast.error('同步失败: ' + describe(e))
    } finally {
      setBusy(false)
    }
  }

  const syncAll = async () => {
    if (busy || writesBlocked) return
    setBusy(true)
    let pending = 0
    try {
      for (const skill of skills) {
        for (const target of targets) {
          if ((states[skill.name]?.[target.id] ?? 'missing') === 'in-sync') continue
          await bridge.skills.install(skill.name, target.id)
          pending++
        }
      }
      await refreshAll()
      ui.toast.success(pending > 0 ? `已同步 ${pending} 项` : '全部目标均已是最新')
    } catch (e) {
      ui.toast.error('同步失败: ' + describe(e))
      await refreshAll()
    } finally {
      setBusy(false)
    }
  }

  const currentStates = draft?.originName ? states[draft.originName] : undefined
  const retry = () => { void refreshAll() }
  const listFailure = listError !== null && skills.length === 0 && !draft

  // 首次加载 / 首次失败：没有可展示的数据，用整块空态说清楚，并给重试
  if (!loaded && reloading) {
    return <EmptyState icon={LoaderCircle} title="技能加载中" description="正在读取共享目录中的技能库。" />
  }
  // 读失败且手里没有技能：不声称「还没有技能」——上次成功的结果是空的，不代表现在没有
  if (listFailure) {
    return <EmptyState
      icon={Sparkles}
      title="技能库读取失败"
      description={`${listError}；共享目录位置未知或结果不可信，因此新建、导入与同步暂时不可用。`}
      action={<button className="btn" type="button" onClick={retry}><RefreshCw size={14} /> 重试</button>}
    />
  }

  return <div className="skills-tab">
    <div className="ext-tab-toolbar">
      <span className="ext-tab-desc">SKILL.md 技能库，可共享到各 agent CLI 的技能目录。</span>
      <div className="skills-header-actions">
        <button className="btn" onClick={syncAll} disabled={busy || writesBlocked || skills.length === 0}><RefreshCw size={14} /> 全部同步</button>
        <button className="btn" onClick={importFromDir} disabled={writesBlocked}><Upload size={14} /> 导入…</button>
        <button className="btn primary" onClick={newSkill} disabled={writesBlocked}><Plus size={14} /> 新建技能</button>
      </div>
    </div>
    {listError && <StaleBanner marker="skills" label="显示上次成功的技能库快照" error={listError} onRetry={retry} busy={reloading} />}
    {targetsError && <StaleBanner marker="skill-targets" label={targetsLoaded ? '显示上次成功的同步状态' : '同步状态读取失败'} error={targetsError} onRetry={retry} busy={reloading} />}
    {writesBlocked && <p className="hint" data-skills-writes-blocked>共享目录未知：技能库写操作（新建 / 导入 / 保存 / 删除 / 同步）已停用，重试读取成功后再操作。</p>}
    {skills.length === 0 && !draft ? (
        <EmptyState
          icon={Sparkles}
          title="还没有技能"
          description={`技能以标准 SKILL.md 存放在共享目录（${root || '首次打开时自动创建'}），可被 Claude Code、Codex、ZCode 等工具复用。`}
          action={<>
            <button className="btn primary" onClick={newSkill} disabled={writesBlocked}><Plus size={14} /> 新建技能</button>
            <button className="btn" onClick={importFromDir} disabled={writesBlocked}><Upload size={14} /> 从目录导入</button>
          </>}
        />
      ) : (
        <div className="skills-layout">
          <aside className="skills-side">
            <label className="market-search skills-search">
              <Search size={15} />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索技能名或描述" />
            </label>
            <div className="skills-list">
              {visible.length === 0 && <div className="skills-list-empty">没有匹配的技能</div>}
              {visible.map((skill) => (
                <button
                  key={skill.name}
                  className={`skills-item ${draft?.originName === skill.name ? 'active' : ''}`}
                  onClick={() => void openSkill(skill.name)}
                  title={skill.description || skill.name}
                >
                  <i className={`sync-dot dot-${aggregateState(states[skill.name], targets)}`} />
                  <span className="skills-item-main">
                    <b>{skill.name}</b>
                    <small>{skill.description || '（无描述）'}</small>
                    <small className="skills-item-time">{fmtTime(skill.updatedAt)}</small>
                  </span>
                </button>
              ))}
            </div>
          </aside>
          <section className="skills-detail">
            {!draft ? (
              <EmptyState compact title="选择左侧技能查看详情" description="或新建一个技能。" />
            ) : (
              <>
                <div className="skills-editor">
                  <div className="skills-editor-row">
                    <label className="field">
                      <span>技能名（即目录名，小写字母/数字/._-）</span>
                      <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="my-skill" />
                    </label>
                    <label className="field">
                      <span>描述（写入 frontmatter，供各 CLI 触发判断）</span>
                      <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="这个技能做什么、什么时候用" />
                    </label>
                  </div>
                  <textarea
                    className="skills-body"
                    value={draft.body}
                    onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                    placeholder={'在这里写 Markdown 正文（保存时自动生成 frontmatter）…'}
                    spellCheck={false}
                  />
                  <div className="skills-editor-actions">
                    <button className="btn primary" onClick={save} disabled={busy || writesBlocked}>保存</button>
                    {draft.originName && <button className="btn danger" onClick={() => void remove(draft.originName!)} disabled={writesBlocked}><Trash2 size={14} /> 删除</button>}
                  </div>
                </div>
                <div className="skill-targets">
                  <div className="section-heading">
                    <h3>共享目标</h3>
                    <span>点击安装 / 卸载；源文件改动后会显示「重新同步」</span>
                  </div>
                  {!draft.originName ? (
                    <p className="hint">先保存技能，再同步到各工具的技能目录。</p>
                  ) : targets.length === 0 ? (
                    <p className="hint">{targetsLoaded ? '当前没有可同步的目标 CLI。' : '同步目标未知：读取失败，重试后再操作。'}</p>
                  ) : (
                    <div className="skill-target-row">
                      {targets.map((target) => {
                        const state = currentStates?.[target.id] ?? 'missing'
                        return (
                          <button
                            key={target.id}
                            className={`skill-target st-${state}`}
                            title={`${target.hint} · ${state}`}
                            onClick={() => draft.originName && void toggleTarget(draft.originName, target.id)}
                            disabled={busy || writesBlocked}
                          >
                            <i className="target-dot" />
                            <span className="skill-target-copy">
                              <b>{target.label}</b>
                              <small>{state === 'in-sync' ? '已同步 · 卸载' : state === 'outdated' ? '过期 · 重新同步' : '未安装 · 安装'}</small>
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      )}
  </div>
}
