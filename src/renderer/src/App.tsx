import { useEffect, useMemo, useRef, useState } from 'react'
import { bridge, useSettings, useTasks } from './api'
import { TASK_STATUS_LABELS } from './labels'
import { TaskDetail } from './components/TaskDetail'
import { SettingsView } from './components/SettingsView'
import { UsageView } from './components/UsageView'
import { WorkspaceView, FOCUS_WORKSPACE } from './components/WorkspaceView'
import { TabBar } from './components/TabBar'
import { BoardView } from './components/BoardView'
import { AutomationView } from './components/AutomationView'
import { MarketView } from './components/MarketView'
import { InboxView } from './components/InboxView'
import { IssuesView } from './components/IssuesView'
import { AgentsView } from './components/AgentsView'
import { GoalsView } from './components/goal/GoalsView'
import { ListTodo, Kanban, Gauge, Settings, Search, Plus, Command, FolderOpen, ChevronDown, AlarmClock, Blocks, Inbox, Users, Target } from 'lucide-react'
import { ToastHost } from './ui/Toasts'
import { ConfirmHost } from './ui/Confirm'
import { Palette, type PaletteCommand } from './ui/Palette'
import type { Issue, Task } from '../../shared/types'

type View = 'issues' | 'goals' | 'create' | 'detail' | 'usage' | 'settings' | 'automation' | 'market' | 'inbox' | 'board' | 'agents'
const MAX_TABS = 8
/** 最近工作区列表的上限（切换器下拉里展示） */
const MAX_RECENT_WORKSPACES = 8

export function App() {
  const { tasks } = useTasks()
  const { settings, update } = useSettings()
  const [view, setView] = useState<View>('issues')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [workspaceDir, setWorkspaceDir] = useState(() => localStorage.getItem('agentdeck:workspace-dir') ?? '')
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('agentdeck:recent-workspaces') ?? '[]') as string[] } catch { return [] }
  })
  const [settingsSection, setSettingsSection] = useState('general')
  const [tabs, setTabs] = useState<string[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [unreadCount, setUnreadCount] = useState(0)
  const selected = tasks.find((task) => task.id === activeId) ?? null

  useEffect(() => {
    const theme = settings?.theme ?? 'light'
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const apply = () => document.documentElement.classList.toggle('light', theme === 'light' || (theme === 'system' && mq.matches))
    apply()
    if (theme === 'system') { mq.addEventListener('change', apply); return () => mq.removeEventListener('change', apply) }
  }, [settings?.theme])
  useEffect(() => {
    let alive = true
    const refresh = () => void bridge.issues.notifications(true).then((items) => { if (alive) setUnreadCount(items.length) })
    refresh()
    const off = bridge.issues.onUpdated(refresh)
    return () => { alive = false; off() }
  }, [])

  const openTask = (id: string) => { setTabs((current) => current.includes(id) ? current : [...current, id].slice(-MAX_TABS)); setActiveId(id); setView('detail') }
  const closeTab = (id: string) => { const next = tabs.filter((tab) => tab !== id); setTabs(next); if (activeId === id) setActiveId(next[next.length - 1] ?? null) }
  const goWorkspace = () => { setView('create'); window.dispatchEvent(new Event(FOCUS_WORKSPACE)) }
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
  useEffect(() => bridge.tasks.onDeleted((id) => closeTab(id)), [tabs, activeId])
  useEffect(() => bridge.tasks.onFocusTask((id) => openTask(id)), [])
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey
      if (mod && event.key.toLowerCase() === 'k') { event.preventDefault(); setPaletteOpen((value) => !value) }
      else if (mod && event.key.toLowerCase() === 'n') { event.preventDefault(); goWorkspace() }
      else if (!mod && !event.altKey && event.key.toLowerCase() === 'c' && !['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement)?.tagName ?? '')) { event.preventDefault(); goWorkspace() }
      else if (mod && event.key.toLowerCase() === 'w' && activeId) { event.preventDefault(); closeTab(activeId) }
      else if (mod && event.key === 'Tab' && tabs.length > 1) { event.preventDefault(); const index = tabs.indexOf(activeId ?? ''); setActiveId(tabs[((index + (event.shiftKey ? -1 : 1)) + tabs.length) % tabs.length]) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [activeId, tabs])

  // 视图切换不再清空当前 issue：Issue 主导航可回到最后浏览的详情（Chrome 返回按钮才显式退出）
  const nav = (next: View) => { setView(next) }
  /** Issue 导航：有正在浏览的 issue 就回到它的详情，否则进总览 */
  const navIssues = () => { if (activeId && tasks.some((t) => t.id === activeId)) setView('detail'); else setView('issues') }
  const openSettings = (section?: string) => { if (section) setSettingsSection(section); setView('settings') }

  const commands: PaletteCommand[] = useMemo(() => [
    ...[['Issue', navIssues], ['目标', () => nav('goals')], ['看板', () => nav('board')], ['Agent 管理', () => nav('agents')], ['收件箱', () => setView('inbox')], ['自动化', () => nav('automation')], ['扩展中心', () => nav('market')], ['用量', () => nav('usage')], ['设置', () => openSettings('general')], ['设置 · 运行时', () => openSettings('runtime')]].map(([label, run]) => ({ id: String(label), group: '跳转', label: String(label), run: run as () => void })),
    { id: 'new', group: '操作', label: '新建任务', hint: 'Ctrl+N', run: goWorkspace },
    { id: 'theme', group: '操作', label: '切换深浅主题', run: () => void update({ theme: (settings?.theme ?? 'light') === 'dark' ? 'light' : 'dark' }) },
    ...tasks.slice(0, 20).map((task) => ({ id: task.id, group: '任务', label: task.title, hint: TASK_STATUS_LABELS[task.status], run: () => openTask(task.id) }))
  ], [tasks, settings?.theme])

  const openIssue = (issue: Issue) => { if (issue.taskId) openTask(issue.taskId) }
  return <div className="app">
    <ToastHost /><ConfirmHost /><Palette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
    <aside className="sidebar">
      <div className="brand" aria-label="AgentDeck"><span className="brand-mark">A</span><span className="brand-name">AgentDeck</span><span className="brand-status" title="本地工作区已连接" /></div>
      <WorkspaceSwitcher dir={workspaceDir} recent={recentWorkspaces} onChoose={chooseWorkspace} onPick={pickWorkspace} />
      <button className="new-task-btn" onClick={goWorkspace}><Plus size={15} /> 新建任务 <kbd>Ctrl+N</kbd></button>
      <nav className="nav" aria-label="主导航">
        <button className={view === 'issues' || view === 'detail' ? 'active' : ''} onClick={navIssues} title={activeId ? '回到当前 Issue（再点总览请用面包屑返回）' : undefined}><ListTodo /><span className="nav-label">Issue</span></button>
        <button className={view === 'goals' ? 'active' : ''} onClick={() => nav('goals')}><Target /><span className="nav-label">目标</span></button>
        <button className={view === 'board' ? 'active' : ''} onClick={() => nav('board')}><Kanban /><span className="nav-label">看板</span></button>
        <button className={view === 'agents' ? 'active' : ''} onClick={() => nav('agents')}><Users /><span className="nav-label">Agent</span></button>
        <button className={view === 'inbox' ? 'active' : ''} onClick={() => nav('inbox')}><Inbox /><span className="nav-label">收件箱</span>{unreadCount > 0 && <span className="nav-count">{unreadCount > 99 ? '99+' : unreadCount}</span>}</button>
        <button className={view === 'automation' ? 'active' : ''} onClick={() => nav('automation')}><AlarmClock /><span className="nav-label">自动化</span></button>
        <button className={view === 'market' ? 'active' : ''} onClick={() => nav('market')}><Blocks /><span className="nav-label">扩展</span></button>
        <button className={view === 'usage' ? 'active' : ''} onClick={() => nav('usage')}><Gauge /><span className="nav-label">用量</span></button>
        <button className={view === 'settings' ? 'active' : ''} onClick={() => openSettings()}><Settings /><span className="nav-label">设置</span></button>
      </nav>
      <div className="sidebar-footer"><span className="connection-dot" /> 本地引擎就绪</div>
    </aside>
    <main className="main">
      {view === 'goals' ? <GoalsView workspaceDir={workspaceDir} /> : view === 'inbox' ? <InboxView onOpenIssue={openIssue} /> : view === 'agents' ? <AgentsView /> : view === 'automation' ? <AutomationView /> : view === 'market' ? <MarketView /> : view === 'settings' ? <SettingsView section={settingsSection} onSection={setSettingsSection} /> : view === 'usage' ? <UsageView /> : view === 'board' ? <Page title="看板" count={tasks.length}><BoardView tasks={tasks} onOpen={openTask} /></Page> : view === 'detail' && selected ? <div className="tasks-column detail-page"><Chrome title={selected.title} onBack={() => { setActiveId(null); setView('issues') }} />{tabs.length > 0 && <TabBar tabs={tabs} tasks={tasks} activeId={activeId} onSelect={openTask} onClose={closeTab} />}<TaskDetail task={selected} tasks={tasks} onSelect={openTask} /></div> : view === 'create' ? <Page title="新建 Issue" count={0}><WorkspaceView onCreated={(task) => openTask(task.id)} workspaceDir={workspaceDir} onPickWorkspace={pickWorkspace} /></Page> : <IssuesView tasks={tasks} onOpen={openTask} onCreate={goWorkspace} />}
    </main>
  </div>
}

/** 工作区切换器：下拉列出最近工作区，点击即切换新任务的默认目录 */
function WorkspaceSwitcher({ dir, recent, onChoose, onPick }: { dir: string; recent: string[]; onChoose: (dir: string) => void; onPick: () => void }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false) }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])
  const name = (d: string) => d.split(/[\\/]/).filter(Boolean).pop() ?? d
  return (
    <div className="ws-switch" ref={rootRef}>
      <button className="workspace-switcher" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="workspace-glyph"><FolderOpen size={14} /></span>
        <span><b>{dir ? name(dir) : '选择工作区'}</b><small>{dir || '新任务将默认在此目录执行'}</small></span>
        <ChevronDown size={14} className={`workspace-caret ${open ? 'flip' : ''}`} />
      </button>
      {open && (
        <div className="ws-menu" role="menu" aria-label="切换工作区">
          <div className="ws-menu-label">最近工作区</div>
          {recent.length === 0 && <div className="ws-menu-empty">还没有记录，先选一个目录</div>}
          {recent.map((d) => (
            <button key={d} className={`ws-menu-item ${d === dir ? 'current' : ''}`} role="menuitem" title={d} onClick={() => { onChoose(d); setOpen(false) }}>
              <FolderOpen size={13} />
              <span className="ws-menu-name">{name(d) || d}</span>
              <small className="ws-menu-path">{d}</small>
            </button>
          ))}
          <div className="ws-menu-sep" />
          <button className="ws-menu-item" role="menuitem" onClick={() => { onPick(); setOpen(false) }}>
            <Plus size={13} />
            <span className="ws-menu-name">选择其他目录…</span>
          </button>
        </div>
      )}
    </div>
  )
}

function Chrome({ title, onBack }: { title: string; onBack: () => void }) { return <div className="workspace-topbar"><div className="breadcrumb"><span>个人工作区</span><i>/</i><strong>{title}</strong></div><button className="icon-btn" onClick={onBack} title="返回任务列表"><ListTodo size={16} /></button></div> }
function Page({ title, count, children }: { title: string; count: number; children: React.ReactNode }) { return <div className="tasks-column"><div className="workspace-topbar"><div className="breadcrumb"><span>个人工作区</span><i>/</i><strong>{title}</strong></div><div className="topbar-actions"><button className="command-trigger" onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))}><Search size={14} /> 搜索任务 <kbd><Command size={10} /> K</kbd></button></div></div><div className="tasks-toolbar"><div className="toolbar-title"><span className="toolbar-kicker">{title}</span><span className="toolbar-count">{count}</span></div></div>{children}</div> }
