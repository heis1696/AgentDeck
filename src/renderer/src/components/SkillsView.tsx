import { useCallback, useEffect, useMemo, useState } from 'react'
import { FolderOpen, Plus, RefreshCw, Search, Sparkles, Trash2, Upload } from 'lucide-react'
import { bridge, fmtTime, useSettings } from '../api'
import { toast } from '../ui/Toasts'
import { confirmDialog } from '../ui/Confirm'
import { EmptyState } from '../ui/EmptyState'
import type { SkillDetail, SkillMeta, SkillTarget, SyncState } from '../../../shared/skills'

type TargetStates = Record<string, Record<string, SyncState>>

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

/** 技能页：共享目录技能库（SKILL.md 标准，可一键同步到各 agent CLI 技能目录） */
export function SkillsView() {
  const { settings } = useSettings()
  const [root, setRoot] = useState('')
  const [skills, setSkills] = useState<SkillMeta[]>([])
  const [targets, setTargets] = useState<SkillTarget[]>([])
  const [states, setStates] = useState<TargetStates>({})
  const [draft, setDraft] = useState<SkillDraft | null>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)

  const loadList = useCallback(async () => {
    const list = await bridge.skills.list()
    setRoot(list.root)
    setSkills(list.skills)
  }, [])
  const loadTargets = useCallback(async () => {
    const data = await bridge.skills.targets()
    setTargets(data.targets)
    setStates(data.states)
  }, [])
  const refreshAll = useCallback(() => Promise.all([loadList(), loadTargets()]), [loadList, loadTargets])

  // 挂载与共享目录变更（settings:updated → useSettings）都会重载
  useEffect(() => { void refreshAll() }, [settings?.sharedDir, refreshAll])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return skills
    return skills.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(q))
  }, [skills, query])

  const openSkill = async (name: string) => {
    try {
      const detail: SkillDetail | null = await bridge.skills.get(name)
      if (!detail) { toast.error(`技能不存在: ${name}`); return }
      setDraft({ name: detail.name, description: detail.description, body: detail.body, originName: detail.name })
    } catch (e) {
      toast.error('读取技能失败: ' + (e instanceof Error ? e.message : String(e)))
    }
  }
  const newSkill = () => setDraft({ name: '', description: '', body: '', originName: null })

  const save = async () => {
    if (!draft || busy) return
    const name = draft.name.trim()
    if (!name) { toast.error('技能名不能为空'); return }
    setBusy(true)
    try {
      const meta = await bridge.skills.save(name, {
        description: draft.description,
        body: draft.body,
        ...(draft.originName ? { originName: draft.originName } : {})
      })
      await refreshAll()
      setDraft({ name: meta.name, description: meta.description, body: draft.body, originName: meta.name })
      toast.success(`已保存「${meta.name}」`)
    } catch (e) {
      toast.error('保存失败: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (name: string) => {
    if (!await confirmDialog({ title: `删除技能「${name}」？`, body: '共享目录中的技能目录会被删除；已安装到各工具的副本不受影响，可稍后卸载。', danger: true, confirmText: '删除' })) return
    try {
      await bridge.skills.delete(name)
      if (draft?.originName === name) setDraft(null)
      await refreshAll()
      toast.success(`已删除「${name}」`)
    } catch (e) {
      toast.error('删除失败: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const importFromDir = async () => {
    const dir = await bridge.pickDir()
    if (!dir) return
    try {
      const meta = await bridge.skills.import(dir)
      await refreshAll()
      await openSkill(meta.name)
      toast.success(`已导入「${meta.name}」`)
    } catch (e) {
      toast.error('导入失败: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const toggleTarget = async (name: string, targetId: string) => {
    if (busy) return
    setBusy(true)
    try {
      const state = states[name]?.[targetId] ?? 'missing'
      if (state === 'in-sync') await bridge.skills.uninstall(name, targetId)
      else await bridge.skills.install(name, targetId)
      await loadTargets()
    } catch (e) {
      toast.error('同步失败: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  const syncAll = async () => {
    if (busy) return
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
      await loadTargets()
      toast.success(pending > 0 ? `已同步 ${pending} 项` : '全部目标均已是最新')
    } catch (e) {
      toast.error('同步失败: ' + (e instanceof Error ? e.message : String(e)))
      await loadTargets()
    } finally {
      setBusy(false)
    }
  }

  const currentStates = draft?.originName ? states[draft.originName] : undefined

  return <div className="skills-view page-surface">
    <header className="page-header-bar">
      <div className="detail-title-wrap">
        <div className="page-title-row">
          <Sparkles size={16} className="page-icon" />
          <h2 className="page-title">技能</h2>
          <span className="page-desc">SKILL.md 技能库，可共享到各 agent CLI 的技能目录。</span>
        </div>
        <button className="skills-root-link" onClick={() => void bridge.skills.openDir()} title="打开共享目录">
          <FolderOpen size={13} /><span>{root || '…'}</span>
        </button>
      </div>
      <div className="skills-header-actions">
        <button className="btn" onClick={syncAll} disabled={busy || skills.length === 0}><RefreshCw size={14} /> 全部同步</button>
        <button className="btn" onClick={importFromDir}><Upload size={14} /> 导入…</button>
        <button className="btn primary" onClick={newSkill}><Plus size={14} /> 新建技能</button>
      </div>
    </header>
    <div className="page-content market-content skills-content">
      {skills.length === 0 && !draft ? (
        <EmptyState
          icon={Sparkles}
          title="还没有技能"
          description={`技能以标准 SKILL.md 存放在共享目录（${root || '首次打开时自动创建'}），可被 Claude Code、Codex、ZCode 等工具复用。`}
          action={<>
            <button className="btn primary" onClick={newSkill}><Plus size={14} /> 新建技能</button>
            <button className="btn" onClick={importFromDir}><Upload size={14} /> 从目录导入</button>
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
                    <button className="btn primary" onClick={save} disabled={busy}>保存</button>
                    {draft.originName && <button className="btn danger" onClick={() => void remove(draft.originName!)}><Trash2 size={14} /> 删除</button>}
                  </div>
                </div>
                <div className="skill-targets">
                  <div className="section-heading">
                    <h3>共享目标</h3>
                    <span>点击安装 / 卸载；源文件改动后会显示「重新同步」</span>
                  </div>
                  {!draft.originName ? (
                    <p className="hint">先保存技能，再同步到各工具的技能目录。</p>
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
                            disabled={busy}
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
  </div>
}
