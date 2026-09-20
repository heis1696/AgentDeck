import { useEffect, useMemo, useRef, useState } from 'react'
import { bridge, useSettings, useTasks, waitForTaskListed } from './api'
import { TASK_STATUS_LABELS, isParkedQueued, PARKED_QUEUED_LABEL } from './labels'
import { taskService } from './task-service'
import { TaskDetail } from './components/TaskDetail'
import { SettingsView } from './components/SettingsView'
import { UsageView } from './components/UsageView'
import { WorkspaceView } from './components/WorkspaceView'
import { TabBar } from './components/TabBar'
import { BoardView } from './components/BoardView'
import { AutomationView } from './components/AutomationView'
import { ExtensionsView } from './components/ExtensionsView'
import { IssuesView } from './components/IssuesView'
import { AgentsView } from './components/AgentsView'
import { ListTodo, Kanban, Gauge, Settings, Search, Plus, Command, FolderOpen, ChevronDown, AlarmClock, Layers, Users } from 'lucide-react'
import { ToastHost } from './ui/Toasts'
import { ConfirmHost } from './ui/Confirm'
import { Palette, type PaletteCommand } from './ui/Palette'
import { PageHeader } from './ui/PageHeader'
import { ui, rootTabsOf, type UiView } from './ui/interaction-center'
import { useInteractionSelector } from './hooks/useInteraction'
import { useInteractionLayer } from './hooks/useInteractionLayer'
import { PetStage } from './pet/PetStage'
import { PetSettingsPage } from './pet/PetSettingsPage'
import type { Task } from '../../shared/types'

type View = UiView
/** 最近工作区列表的上限（切换器下拉里展示） */
const MAX_RECENT_WORKSPACES = 8

export function App() {
  // 小助理（桌宠）复用同一 renderer 入口的两个 hash 路由：#/pet 透明舞台、#/pet-settings 独立设置窗。
  //（hash 每窗固定，早退在所有 hook 之前，不违反 hooks 规则）
  // 兼容 #/pet（dev 拼接与新版 loadFile '/pet'）与 #pet（旧主进程 loadFile 'pet'——热更错峰期防主 UI 误入宠物窗）
  if (/^#\/?pet$/.test(window.location.hash)) return <PetStage />
  if (/^#\/?pet-settings$/.test(window.location.hash)) return <PetSettingsPage />
  const { tasks, refresh, ready, error: tasksError } = useTasks()
  const { settings, update } = useSettings()
  // 界面交互状态（视图/页签/面板/设置分区）全部来自交互中心：宿主只订阅，不再各持一份
  const view = useInteractionSelector((state) => state.view)
  const activeId = useInteractionSelector((state) => state.activeId)
  const tabs = useInteractionSelector((state) => state.tabs)
  const paletteOpen = useInteractionSelector((state) => state.paletteOpen)
  const settingsSection = useInteractionSelector((state) => state.settingsSection)
  const [workspaceDir, setWorkspaceDir] = useState(() => localStorage.getItem('agentdeck:workspace-dir') ?? '')
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('agentdeck:recent-workspaces') ?? '[]') as string[] } catch { return [] }
  })
  const selected = tasks.find((task) => task.id === activeId) ?? null
  // 顶部页签条只列「普通页签」：子任务（祖先链完整）在领队详情的右侧分页里。
  // 判定与 openTask 的路由同源（rootTabsOf）：祖先链断裂的任务是普通页签，不能再按
  // parentTaskId 一刀切过滤——那会把它们从页签条上藏掉，只剩一个看不见的激活项。
  const rootTabs = useMemo(() => rootTabsOf(tasks, tabs), [tasks, tabs])

  useEffect(() => {
    const theme = settings?.theme ?? 'light'
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const apply = () => document.documentElement.classList.toggle('light', theme === 'light' || (theme === 'system' && mq.matches))
    apply()
    if (theme === 'system') { mq.addEventListener('change', apply); return () => mq.removeEventListener('change', apply) }
  }, [settings?.theme])

  // 中心持有最新任务目录：祖先链解析（子任务→领队）、删除清理、dock 桶剪枝都以它为准。
  // 首份真实列表到达前不喂（ready 门控）：启动瞬间的空目录是「未加载」不是「没有任务」，
  // 喂进去会把待决路由乐观页签全部剪掉。
  useEffect(() => {
    if (ready) ui.setTasks(tasks.map((task) => ({ id: task.id, title: task.title, parentTaskId: task.parentTaskId })))
  }, [tasks, ready])
  useEffect(() => { if (tasksError) ui.toast.error(`读取任务失败：${tasksError}`) }, [tasksError])

  const openTask = (id: string) => { ui.openTask(id) }
  /** 草稿创建只广播 Issue 更新，必须把新任务写入页面目录后再导航。 */
  const openCreatedTask = async (id: string) => {
    await waitForTaskListed(id)
    const list = await refresh()
    if (!list?.some((task) => task.id === id)) {
      ui.toast.error('任务已创建，目录暂未刷新，请稍后从看板打开')
      return
    }
    ui.setTasks(list)
    ui.openTask(id)
  }
  /** Ctrl+N/侧栏「新建任务」：导航到 Issue 主页（新建表单即主页主体）并请求聚焦输入框 */
  const goWorkspace = () => { ui.focusComposer() }
  /** 切到某个最近用过的工作区：新任务默认目录随之变化 */
  const chooseWorkspace = (dir: string) => {
    if (!dir) return
    setWorkspaceDir(dir)
    localStorage.setItem('agentdeck:workspace-dir', dir)
    setRecentWorkspaces((current) => {
      const next = [dir, ...current.filter((d) => d !== dir)].slice(0, MAX_RECENT_WORKSPACES)
      localStorage.setItem('agentdeck:recent-workspaces', JSON.stringify(next))
      return next
    })
  }
  const pickWorkspace = async () => { const dir = await bridge.pickDir(); if (dir) chooseWorkspace(dir) }
  // 任务里出现过的工作目录自动进最近列表（新装/清缓存后不用手动重选）
  useEffect(() => {
    const dirs = tasks.map((task) => task.workdir.trim()).filter(Boolean)
    if (!dirs.length) return
    setRecentWorkspaces((current) => {
      const next = [...current]
      let changed = false
      for (const dir of dirs) if (!next.includes(dir)) { next.push(dir); changed = true }
      if (!changed) return current
      const capped = next.slice(0, MAX_RECENT_WORKSPACES)
      localStorage.setItem('agentdeck:recent-workspaces', JSON.stringify(capped))
      return capped
    })
  }, [tasks])
  useEffect(() => bridge.tasks.onDeleted((id) => ui.closeTab(id)), [])
  useEffect(() => bridge.tasks.onFocusTask((id) => ui.openTask(id)), [])
  // 全局快捷键：解析与执行都在交互中心（输入法组合中/可编辑元素/浮层打开时让路）
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const action = ui.handleKey({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        isComposing: event.isComposing,
        keyCode: event.keyCode,
        target: event.target as HTMLElement | null
      })
      if (action) event.preventDefault()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const nav = (next: View) => { ui.navigate(next) }
  const navIssues = () => ui.navigate('issues')
  const openSettings = (section?: string) => { ui.openSettings(section) }

  const commands: PaletteCommand[] = useMemo(() => [
    ...[['Issue', navIssues], ['看板', () => nav('board')], ['Agent 管理', () => nav('agents')], ['自动化', () => nav('automation')], ['扩展', () => nav('skills')], ['用量', () => nav('usage')], ['设置', () => openSettings('general')], ['设置 · 运行时', () => openSettings('runtime')]].map(([label, run]) => ({ id: String(label), group: '跳转', label: String(label), run: run as () => void })),
    { id: 'new', group: '操作', label: '新建任务', hint: 'Ctrl+N', run: goWorkspace },
    { id: 'theme', group: '操作', label: '切换深浅主题', run: () => void update({ theme: (settings?.theme ?? 'light') === 'dark' ? 'light' : 'dark' }) },
    ...tasks.slice(0, 20).map((task) => {
      const parked = isParkedQueued(task)
      return {
        id: task.id,
        group: '任务',
        label: task.title,
        hint: parked ? PARKED_QUEUED_LABEL : TASK_STATUS_LABELS[task.status],
        keywords: parked ? '启动' : undefined,
        run: () => {
          // parked 任务 Enter/点击 = 一键启动（tasks:start 清停放并入队），并打开详情跟进。
          // 任务执行仍走 task-service，交互中心只管导航/反馈。
          openTask(task.id)
          if (!parked) return
          void taskService.start(task.id).then((result) => { if (!result.ok) ui.toast.error(result.error ?? '启动失败') })
        }
      }
    })
  ], [tasks, settings?.theme])

  return <div className="app" data-view={view}>
    <ToastHost /><ConfirmHost /><Palette open={paletteOpen} onClose={() => ui.palette.close()} commands={commands} />
    <aside className="sidebar">
      <div className="brand" aria-label="AgentDeck"><span className="brand-mark">A</span><span className="brand-name">AgentDeck</span><span className="brand-status" aria-hidden="true" title="本地工作区已连接" /></div>
      <WorkspaceSwitcher dir={workspaceDir} recent={recentWorkspaces} onChoose={chooseWorkspace} onPick={pickWorkspace} />
      <button className="new-task-btn" type="button" onClick={goWorkspace} title="新建任务（Ctrl+N）"><Plus size={15} /> 新建任务 <kbd>Ctrl+N</kbd></button>
      {/* title 兼作图标轨（≤560px）下的悬浮说明：窄侧栏里 .nav-label 视觉隐藏但仍在可访问树中 */}
      <nav className="nav" aria-label="主导航">
        <button className={view === 'issues' || view === 'detail' ? 'active' : ''} aria-current={view === 'issues' || view === 'detail' ? 'page' : undefined} onClick={navIssues} title="新建及已打开的 Issue"><ListTodo /><span className="nav-label">Issue</span></button>
        <button className={view === 'board' ? 'active' : ''} aria-current={view === 'board' ? 'page' : undefined} onClick={() => nav('board')} title="看板"><Kanban /><span className="nav-label">看板</span></button>
        <button className={view === 'agents' ? 'active' : ''} aria-current={view === 'agents' ? 'page' : undefined} onClick={() => nav('agents')} title="Agent 管理"><Users /><span className="nav-label">Agent</span></button>
        <button className={view === 'automation' ? 'active' : ''} aria-current={view === 'automation' ? 'page' : undefined} onClick={() => nav('automation')} title="自动化"><AlarmClock /><span className="nav-label">自动化</span></button>
        <button className={view === 'skills' ? 'active' : ''} aria-current={view === 'skills' ? 'page' : undefined} onClick={() => nav('skills')} title="扩展"><Layers /><span className="nav-label">扩展</span></button>
        <button className={view === 'usage' ? 'active' : ''} aria-current={view === 'usage' ? 'page' : undefined} onClick={() => nav('usage')} title="用量"><Gauge /><span className="nav-label">用量</span></button>
        <button className={view === 'settings' ? 'active' : ''} aria-current={view === 'settings' ? 'page' : undefined} onClick={() => openSettings()} title="设置"><Settings /><span className="nav-label">设置</span></button>
      </nav>
      <div className="sidebar-footer"><span className="connection-dot" aria-hidden="true" /> 本地引擎就绪</div>
    </aside>
    <main className="main">
      {view === 'agents' ? <AgentsView /> : view === 'automation' ? <AutomationView /> : view === 'skills' ? <ExtensionsView /> : view === 'settings' ? <SettingsView section={settingsSection} onSection={(section) => ui.openSettings(section)} /> : view === 'usage' ? <UsageView /> : view === 'board' ? <div className="tasks-column"><PageHeader title="看板" icon={<Kanban size={16} />} count={tasks.length} actions={<button className="command-trigger" type="button" onClick={() => ui.palette.open()} title="搜索任务（Ctrl+K）" aria-label="搜索任务" aria-keyshortcuts="Control+K Meta+K"><Search size={14} /> 搜索任务 <kbd><Command size={10} /> K</kbd></button>} /><BoardView tasks={tasks} onOpen={openTask} /></div> : view === 'detail' && selected ? <div className="tasks-column detail-page"><Chrome title={selected.title} onBack={() => ui.navigate('issues')} />{rootTabs.length > 0 && <TabBar tabs={rootTabs} tasks={tasks} activeId={activeId} onSelect={openTask} onClose={(id) => ui.closeTab(id)} />}<TaskDetail task={selected} tasks={tasks} onSelect={openTask} /></div> : <IssuesView tasks={tasks} tabs={tabs} onOpen={openTask} onClose={(id) => ui.closeTab(id)}><WorkspaceView onCreated={(task) => openCreatedTask(task.id)} workspaceDir={workspaceDir} onPickWorkspace={pickWorkspace} /></IssuesView>}
    </main>
  </div>
}

/** 工作区切换器：下拉列出最近工作区，点击即切换新任务的默认目录 */
function WorkspaceSwitcher({ dir, recent, onChoose, onPick }: { dir: string; recent: string[]; onChoose: (dir: string) => void; onPick: () => void }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  // 统一浮层：外点关闭 + 最上层 Escape + 焦点归还（原自挂 window mousedown 已收敛）
  useInteractionLayer<HTMLDivElement>({ open, onClose: () => setOpen(false), kind: 'popover', name: 'workspace-switcher', closeOnOutside: true, autoFocus: false, layerRef: rootRef })
  const name = (d: string) => d.split(/[\\/]/).filter(Boolean).pop() ?? d
  return (
    <div className="ws-switch" ref={rootRef}>
      <button className="workspace-switcher" type="button" aria-haspopup="menu" aria-expanded={open} title={dir || '选择工作区'} onClick={() => setOpen((value) => !value)}>
        <span className="workspace-glyph"><FolderOpen size={14} /></span>
        <span><b>{dir ? name(dir) : '选择工作区'}</b><small>{dir || '新任务将默认在此目录执行'}</small></span>
        <ChevronDown size={14} className={`workspace-caret ${open ? 'flip' : ''}`} />
      </button>
      {open && (
        <div className="ws-menu" role="menu" aria-label="切换工作区">
          <div className="ws-menu-label">最近工作区</div>
          {recent.length === 0 && <div className="ws-menu-empty">还没有记录，先选一个目录</div>}
          {recent.map((d) => (
            <button key={d} className={`ws-menu-item ${d === dir ? 'current' : ''}`} role="menuitem" type="button" aria-current={d === dir ? 'true' : undefined} title={d} onClick={() => { onChoose(d); setOpen(false) }}>
              <FolderOpen size={13} />
              <span className="ws-menu-name">{name(d) || d}</span>
              <small className="ws-menu-path">{d}</small>
            </button>
          ))}
          <div className="ws-menu-sep" />
          <button className="ws-menu-item" role="menuitem" type="button" onClick={() => { onPick(); setOpen(false) }}>
            <Plus size={13} />
            <span className="ws-menu-name">选择其他目录…</span>
          </button>
        </div>
      )}
    </div>
  )
}

/** 详情页顶栏：返回 + 面包屑（从属上下文；主标题由 TaskDetail 的共享页头承担，不在这里重复大标题） */
function Chrome({ title, onBack }: { title: string; onBack: () => void }) {
  return <div className="workspace-topbar">
    <div className="breadcrumb"><span>个人工作区</span><i>/</i><strong>{title}</strong></div>
    <div className="topbar-actions"><button className="icon-btn" type="button" onClick={onBack} title="返回任务列表" aria-label="返回任务列表"><ListTodo size={16} /></button></div>
  </div>
}
