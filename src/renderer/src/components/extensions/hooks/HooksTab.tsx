/**
 * Hooks 域（自 ExtensionsView.tsx「Hooks tab」区原样迁出）：共享目录 hook 资产 + claude/zcode 目标安装。
 * 本域只单向依赖 shared/ 与 ui / api 基础模块，不与其他域互相 import。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle, Plus, RefreshCw, Search, Trash2, Webhook } from 'lucide-react'
import { bridge, useSettings } from '../../../api'
import { ui } from '../../../ui/interaction-center'
import { EmptyState } from '../../../ui/EmptyState'
import { StaleBanner } from '../../SkillsView'
import { TargetChips, TargetStates, aggregateState, errText, linesToArray } from '../shared/ui'
import type { HookDetail, HookGroup, HookMeta, HookTarget } from '../../../../../shared/extensions'

/** 常用 hook 事件（事件名输入框的 datalist 预置项） */
const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'UserPromptSubmit']

interface HookGroupDraft {
  event: string
  matcher: string
  /** 多条命令每行一个 */
  commands: string
}

interface HookDraft {
  name: string
  description: string
  body: string
  groups: HookGroupDraft[]
  originName: string | null
}

function hookToDraft(detail: HookDetail): HookDraft {
  const groups: HookGroupDraft[] = []
  for (const [event, list] of Object.entries(detail.events)) {
    for (const group of list) {
      groups.push({ event, matcher: group.matcher ?? '', commands: group.hooks.map((entry) => entry.command).join('\n') })
    }
  }
  if (groups.length === 0) groups.push({ event: 'PreToolUse', matcher: '', commands: '' })
  return { name: detail.name, description: detail.description, body: detail.body, groups, originName: detail.name }
}

function draftToEvents(draft: HookDraft): Record<string, HookGroup[]> {
  const events: Record<string, HookGroup[]> = {}
  for (const group of draft.groups) {
    const event = group.event.trim()
    if (!event) continue
    const commands = linesToArray(group.commands)
    if (commands.length === 0) continue
    const entry: HookGroup = {
      ...(group.matcher.trim() ? { matcher: group.matcher.trim() } : {}),
      hooks: commands.map((command) => ({ type: 'command' as const, command }))
    }
    ;(events[event] ??= []).push(entry)
  }
  return events
}

function emptyHookDraft(): HookDraft {
  return { name: '', description: '', body: '', groups: [{ event: 'PreToolUse', matcher: '', commands: '' }], originName: null }
}

/** Hooks tab：共享目录 hook 资产（HOOK.md + hook.json）+ claude/zcode 目标安装。
 *  读状态与 MCP / 技能 tab 同构；首次读不成功不写盘。 */
export function HooksTab() {
  const { settings } = useSettings()
  const [hooks, setHooks] = useState<HookMeta[]>([])
  const [targets, setTargets] = useState<HookTarget[]>([])
  const [states, setStates] = useState<TargetStates>({})
  const [draft, setDraft] = useState<HookDraft | null>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [targetsLoaded, setTargetsLoaded] = useState(false)
  const [targetsError, setTargetsError] = useState<string | null>(null)
  const [reloading, setReloading] = useState(true)
  const requestRef = useRef(0)

  const refreshAll = useCallback(async () => {
    const request = ++requestRef.current
    setReloading(true)
    const [listResult, targetResult] = await Promise.allSettled([bridge.hooks.list(), bridge.hooks.targets()])
    if (request !== requestRef.current) return
    if (listResult.status === 'fulfilled') {
      setHooks(listResult.value.hooks)
      setLoaded(true)
      setListError(null)
    } else {
      setListError(errText(listResult.reason))
    }
    if (targetResult.status === 'fulfilled') {
      setTargets(targetResult.value.targets)
      setStates(targetResult.value.states)
      setTargetsLoaded(true)
      setTargetsError(null)
    } else {
      setTargetsError(errText(targetResult.reason))
    }
    setReloading(false)
  }, [])

  useEffect(() => { void refreshAll() }, [settings?.sharedDir, refreshAll])
  useEffect(() => () => { requestRef.current++ }, [])

  /** 共享目录未知时写操作一律停用 */
  const writesBlocked = !settings || !loaded

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return hooks
    return hooks.filter((hook) => `${hook.name} ${hook.description}`.toLowerCase().includes(q))
  }, [hooks, query])

  const targetIds = useMemo(() => targets.map((target) => target.id), [targets])

  const openHook = async (name: string) => {
    try {
      const detail = await bridge.hooks.get(name)
      if (!detail) { ui.toast.error(`Hook 不存在: ${name}`); return }
      setDraft(hookToDraft(detail))
    } catch (e) {
      ui.toast.error('读取 Hook 失败: ' + errText(e))
    }
  }
  const newHook = () => {
    if (writesBlocked) { ui.toast.error('共享目录未知，暂时不能新建 Hook。'); return }
    setDraft(emptyHookDraft())
  }

  const save = async () => {
    if (!draft || busy || writesBlocked) return
    const name = draft.name.trim()
    if (!name) { ui.toast.error('Hook 名不能为空'); return }
    setBusy(true)
    try {
      const meta = await bridge.hooks.save(name, {
        description: draft.description,
        body: draft.body,
        events: draftToEvents(draft),
        ...(draft.originName ? { originName: draft.originName } : {})
      })
      await refreshAll()
      setDraft({ ...draft, name: meta.name, originName: meta.name })
      ui.toast.success(`已保存「${meta.name}」`)
    } catch (e) {
      ui.toast.error('保存失败: ' + errText(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (name: string) => {
    if (writesBlocked) { ui.toast.error('共享目录未知，暂时不能删除 Hook。'); return }
    if (!await ui.confirm({ title: `删除 Hook「${name}」？`, body: '共享目录中的 hook 目录会被删除；已安装到各 CLI 配置的事件组不受影响，可稍后卸载。', danger: true, confirmText: '删除' })) return
    try {
      await bridge.hooks.delete(name)
      if (draft?.originName === name) setDraft(null)
      await refreshAll()
      ui.toast.success(`已删除「${name}」`)
    } catch (e) {
      ui.toast.error('删除失败: ' + errText(e))
    }
  }

  const toggleTarget = async (name: string, targetId: string) => {
    if (busy || writesBlocked) return
    setBusy(true)
    try {
      const state = states[name]?.[targetId] ?? 'missing'
      if (state === 'in-sync') await bridge.hooks.uninstall(name, targetId)
      else await bridge.hooks.install(name, targetId)
      await refreshAll()
    } catch (e) {
      ui.toast.error('安装失败: ' + errText(e))
    } finally {
      setBusy(false)
    }
  }

  const patchGroup = (index: number, patch: Partial<HookGroupDraft>) => {
    if (!draft) return
    setDraft({ ...draft, groups: draft.groups.map((group, i) => i === index ? { ...group, ...patch } : group) })
  }
  const addGroup = () => draft && setDraft({ ...draft, groups: [...draft.groups, { event: '', matcher: '', commands: '' }] })
  const removeGroup = (index: number) => draft && setDraft({ ...draft, groups: draft.groups.filter((_, i) => i !== index) })

  const hookCount = draft ? Object.keys(draftToEvents(draft)).length : 0
  const retry = () => { void refreshAll() }

  if (!loaded && reloading) {
    return <EmptyState icon={LoaderCircle} title="Hook 资产加载中" description="正在读取共享目录中的 Hook 资产。" />
  }
  // 读失败且列表为空：不声称「还没有 Hook」——空结果来自上一次成功读取
  if (listError && hooks.length === 0 && !draft) {
    return <EmptyState
      icon={Webhook}
      title="Hook 资产读取失败"
      description={`${listError}；共享目录位置未知或结果不可信，因此新建、保存与安装暂时不可用。`}
      action={<button className="btn" type="button" onClick={retry}><RefreshCw size={14} /> 重试</button>}
    />
  }

  if (hooks.length === 0 && !draft) {
    return <EmptyState
      icon={Webhook}
      title="还没有 Hook 资产"
      description="Hook 以 HOOK.md（说明文档）+ hook.json（事件定义）存放在共享目录，可安装到 Claude Code / ZCode。"
      action={<button className="btn primary" onClick={newHook} disabled={writesBlocked}><Plus size={14} /> 新建 Hook</button>}
    />
  }

  return <>
    <datalist id="ext-hook-events">
      {HOOK_EVENTS.map((event) => <option key={event} value={event} />)}
    </datalist>
    <div className="ext-tab-toolbar">
      <span className="ext-tab-desc">共享目录中的 Hook 资产；安装目标为 Claude Code / ZCode 的用户级配置（ZCode 会自动置 hooks.enabled）。</span>
      <div className="skills-header-actions">
        <button className="btn primary" onClick={newHook} disabled={writesBlocked}><Plus size={14} /> 新建 Hook</button>
      </div>
    </div>
    {listError && <StaleBanner marker="hooks" label="显示上次成功的 Hook 列表" error={listError} onRetry={retry} busy={reloading} />}
    {targetsError && <StaleBanner marker="hook-targets" label={targetsLoaded ? '显示上次成功的安装状态' : '安装状态读取失败'} error={targetsError} onRetry={retry} busy={reloading} />}
    {writesBlocked && <p className="hint" data-hooks-writes-blocked>共享目录未知：Hook 写操作（新建 / 保存 / 删除 / 安装）已停用，重试读取成功后再操作。</p>}
    <div className="skills-layout">
      <aside className="skills-side">
        <label className="market-search skills-search">
          <Search size={15} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索 Hook 名或描述" />
        </label>
        <div className="skills-list">
          {visible.length === 0 && <div className="skills-list-empty">没有匹配的 Hook</div>}
          {visible.map((hook) => (
            <button
              key={hook.name}
              type="button"
              className={`skills-item ${draft?.originName === hook.name ? 'active' : ''}`}
              onClick={() => void openHook(hook.name)}
              title={hook.description || hook.name}
            >
              <i className={`sync-dot dot-${aggregateState(states[hook.name], targetIds)}`} />
              <span className="skills-item-main">
                <b>{hook.name}</b>
                <small>{hook.description || '（无描述）'}</small>
                <small className="skills-item-time">{Object.keys(hook.events).length} 事件</small>
              </span>
            </button>
          ))}
        </div>
      </aside>
      <section className="skills-detail">
        {!draft ? (
          <EmptyState compact title="选择左侧 Hook 查看详情" description="或新建一个 Hook 资产。" />
        ) : (
          <>
            <div className="skills-editor">
              <div className="skills-editor-row">
                <label className="field">
                  <span>名称（即目录名，小写字母/数字/._-）</span>
                  <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="format-on-write" />
                </label>
                <label className="field">
                  <span>描述（写入 HOOK.md frontmatter）</span>
                  <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="这个 Hook 做什么、什么时候触发" />
                </label>
              </div>
              <label className="field">
                <span>说明文档（HOOK.md 正文）</span>
                <textarea className="ext-textarea ext-textarea-body" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} placeholder="在这里写 Markdown 说明…" spellCheck={false} />
              </label>
              <div className="section-heading ext-group-heading">
                <h3>事件（{hookCount}）</h3>
                <button className="btn" onClick={addGroup}><Plus size={14} /> 添加事件</button>
              </div>
              {draft.groups.length === 0 && <p className="hint">还没有事件组；点「添加事件」开始。</p>}
              {draft.groups.map((group, index) => (
                <div key={index} className="ext-group">
                  <div className="ext-group-row">
                    <label className="field">
                      <span>事件名</span>
                      <input list="ext-hook-events" value={group.event} onChange={(e) => patchGroup(index, { event: e.target.value })} placeholder="PreToolUse" />
                    </label>
                    <label className="field">
                      <span>matcher（留空 = 匹配全部）</span>
                      <input value={group.matcher} onChange={(e) => patchGroup(index, { matcher: e.target.value })} placeholder="Edit|Write" />
                    </label>
                    <button className="btn ghost ext-group-del" title="删除该事件组" onClick={() => removeGroup(index)}><Trash2 size={14} /></button>
                  </div>
                  <label className="field">
                    <span>command（多条命令每行一个）</span>
                    <textarea className="ext-textarea" value={group.commands} onChange={(e) => patchGroup(index, { commands: e.target.value })} placeholder={'npx prettier --write "$FILE"'} spellCheck={false} />
                  </label>
                </div>
              ))}
              <div className="skills-editor-actions">
                <button className="btn primary" onClick={save} disabled={busy || writesBlocked}>保存</button>
                {draft.originName && <button className="btn danger" onClick={() => void remove(draft.originName!)} disabled={writesBlocked}><Trash2 size={14} /> 删除</button>}
              </div>
            </div>
            <div className="skill-targets">
              <div className="section-heading">
                <h3>安装目标</h3>
                <span>点击安装 / 卸载；事件定义改动后显示「重新同步」</span>
              </div>
              {!draft.originName ? (
                <p className="hint">先保存 Hook，再安装到各 CLI 配置。</p>
              ) : targets.length === 0 ? (
                <p className="hint">{targetsLoaded ? '当前没有可安装的目标 CLI。' : '安装目标未知：读取失败，重试后再操作。'}</p>
              ) : (
                <TargetChips
                  targets={targets}
                  states={draft.originName ? states[draft.originName] : undefined}
                  busy={busy || writesBlocked}
                  onToggle={(targetId) => draft.originName && void toggleTarget(draft.originName, targetId)}
                />
              )}
            </div>
          </>
        )}
      </section>
    </div>
  </>
}
