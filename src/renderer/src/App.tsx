import { useEffect, useMemo, useState } from 'react'
import { bridge, useTasks, useSettings } from './api'
import { TaskList } from './components/TaskList'
import { TaskDetail } from './components/TaskDetail'
import { SettingsView } from './components/SettingsView'
import { TeamView } from './components/TeamView'
import { UsageView } from './components/UsageView'
import { WorkspaceView, FOCUS_WORKSPACE } from './components/WorkspaceView'
import { TabBar } from './components/TabBar'
import { BoardView } from './components/BoardView'
import { ListTodo, Kanban, Users, Gauge, Settings, Search, Plus, Command } from 'lucide-react'
import { ToastHost, toast } from './ui/Toasts'
import { ConfirmHost } from './ui/Confirm'
import { Palette, type PaletteCommand } from './ui/Palette'
import type { Task } from '../../shared/types'

type View = 'tasks' | 'board' | 'detail' | 'team' | 'usage' | 'settings'

const MAX_TABS = 8

export function App() {
  const { tasks } = useTasks()
  const { settings, update } = useSettings()

  // 主题：dark | light | system（跟随系统时监听变化）
  useEffect(() => {
    const theme = settings?.theme ?? 'light'
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const apply = () => {
      const light = theme === 'light' || (theme === 'system' && mq.matches)
      document.documentElement.classList.toggle('light', light)
    }
    apply()
    if (theme === 'system') {
      mq.addEventListener('change', apply)
      return () => mq.removeEventListener('change', apply)
    }
  }, [settings?.theme])
  const [view, setView] = useState<View>('tasks')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [workspaceDir, setWorkspaceDir] = useState(() => localStorage.getItem('agentdeck:workspace-dir') ?? '')
  /** 任务页展示形态：列表 / 看板（记忆） */
  /** 已打开的任务标签（taskId 列表，按打开顺序）；null 激活 = 工作区起始页 */
  const [tabs, setTabs] = useState<string[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const selected = tasks.find((t) => t.id === activeId) ?? null

  const openTask = (id: string) => {
    setTabs((cur) => (cur.includes(id) ? cur : [...cur, id].slice(-MAX_TABS)))
    setActiveId(id)
    setView('detail')
  }
  const closeTab = (id: string) => {
    const next = tabs.filter((x) => x !== id)
    setTabs(next)
    if (activeId === id) setActiveId(next[next.length - 1] ?? null)
  }
  const closeActive = () => {
    if (activeId) closeTab(activeId)
  }
  const cycleTab = (dir: 1 | -1) => {
    if (tabs.length < 2 || !activeId) return
    const i = tabs.indexOf(activeId)
    setActiveId(tabs[(i + dir + tabs.length) % tabs.length])
  }

  // 删除任务 → 关掉它的标签（正选中则回退到最后一个/工作区）
  useEffect(() => bridge.tasks.onDeleted((id) => closeTab(id)), [tabs, activeId])

  // 系统通知点击：聚焦对应任务
  useEffect(() => bridge.tasks.onFocusTask((id) => openTask(id)), [])

  /** 回到常驻工作区（Ctrl+N / 侧栏按钮） */
  const goWorkspace = () => {
    setActiveId(null)
    setView('tasks')
    window.dispatchEvent(new Event(FOCUS_WORKSPACE))
  }
  const pickWorkspace = async () => {
    const dir = await bridge.pickDir()
    if (dir) {
      setWorkspaceDir(dir)
      localStorage.setItem('agentdeck:workspace-dir', dir)
    }
  }

  // 快捷键：Ctrl+N 新任务；Ctrl+W 关当前标签；Ctrl(+Shift)+Tab 切换标签
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((o) => !o)
      } else if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        goWorkspace()
      } else if (mod && e.key.toLowerCase() === 'w') {
        e.preventDefault()
        closeActive()
      } else if (mod && e.key === 'Tab') {
        e.preventDefault()
        cycleTab(e.shiftKey ? -1 : 1)
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [tabs, activeId])

  const onCreated = (t: Task) => {
    openTask(t.id)
  }

  const commands: PaletteCommand[] = useMemo(() => {
    const cmds: PaletteCommand[] = [
      { id: 'nav-tasks', group: '跳转', label: '任务', hint: '页面', run: () => setView('tasks') },
      { id: 'nav-team', group: '跳转', label: '队伍', hint: '页面', run: () => setView('team') },
      { id: 'nav-usage', group: '跳转', label: '用量', hint: '页面', run: () => setView('usage') },
      { id: 'nav-settings', group: '跳转', label: '设置', hint: '页面', run: () => setView('settings') },
      { id: 'act-new', group: '操作', label: '新建任务', hint: 'Ctrl+N', keywords: 'new create', run: goWorkspace },
      { id: 'nav-board', group: '跳转', label: '看板', hint: '页面', keywords: 'board kanban', run: () => { setActiveId(null); setView('board') } },
      { id: 'act-theme', group: '操作', label: `主题：切换为${(settings?.theme ?? 'light') === 'dark' ? '浅色' : '深色'}`, keywords: 'theme light dark', run: () => { void update({ theme: (settings?.theme ?? 'light') === 'dark' ? 'light' : 'dark' }) } }
    ]
    for (const t of tasks.slice(0, 20)) {
      cmds.push({ id: `task-${t.id}`, group: '任务', label: t.title, hint: t.status, keywords: t.prompt, run: () => openTask(t.id) })
    }
    return cmds
  }, [tasks, settings?.theme])

  return (
    <div className="app">
      <ToastHost />
      <ConfirmHost />
      <Palette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
      <aside className="sidebar">
        <div className="brand" aria-label="AgentDeck">
          <span className="brand-mark" aria-hidden="true">⚓</span>
          <span className="brand-name">AgentDeck</span>
          <span className="brand-status" title="本地工作区已连接" aria-label="本地工作区已连接" />
        </div>
        <button className="workspace-switcher" type="button" title="选择个人工作区" onClick={pickWorkspace}>
          <span className="workspace-glyph">A</span>
          <span><b>个人工作区</b><small>{workspaceDir ? workspaceDir.split(/[\\/]/).pop() : '选择工作目录'}</small></span>
          <span className="workspace-caret">⌄</span>
        </button>
        <button className="new-task-btn" onClick={goWorkspace}>
          <Plus size={15} aria-hidden="true" /> 新建任务 <kbd>Ctrl+N</kbd>
        </button>
        <nav className="nav" aria-label="主导航">
          <button className={view === 'tasks' || view === 'detail' ? 'active' : ''} onClick={() => { setActiveId(null); setView('tasks') }} aria-current={view === 'tasks' || view === 'detail' ? 'page' : undefined}>
            <ListTodo aria-hidden="true" /> <span className="nav-label">任务</span>
          </button>
          <button className={view === 'board' ? 'active' : ''} onClick={() => { setActiveId(null); setView('board') }} aria-current={view === 'board' ? 'page' : undefined}>
            <Kanban aria-hidden="true" /> <span className="nav-label">看板</span>
          </button>
          <button className={view === 'team' ? 'active' : ''} onClick={() => { setActiveId(null); setView('team') }} aria-current={view === 'team' ? 'page' : undefined}>
            <Users aria-hidden="true" /> <span className="nav-label">队伍</span>
          </button>
          <button className={view === 'usage' ? 'active' : ''} onClick={() => setView('usage')} aria-current={view === 'usage' ? 'page' : undefined}>
            <Gauge aria-hidden="true" /> <span className="nav-label">用量</span>
          </button>
          <button className={view === 'settings' ? 'active' : ''} onClick={() => setView('settings')} aria-current={view === 'settings' ? 'page' : undefined}>
            <Settings aria-hidden="true" /> <span className="nav-label">设置</span>
          </button>
        </nav>
        <div className="sidebar-section-label">工作台</div>
        {view === 'tasks' && <TaskList tasks={tasks} selectedId={activeId} onSelect={openTask} onPickWorkspace={pickWorkspace} />}
        <div className="sidebar-footer"><span className="connection-dot" /> 本地引擎正常</div>
      </aside>
      <main className="main">
        {view === 'settings' ? (
          <SettingsView />
        ) : view === 'team' ? (
          <TeamView />
        ) : view === 'usage' ? (
          <UsageView />
        ) : view === 'board' ? (
          <div className="tasks-column board-page">
            <div className="workspace-topbar">
              <div className="breadcrumb"><span>个人工作区</span><i>/</i><strong>看板</strong></div>
              <div className="topbar-actions">
                <button className="command-trigger" type="button" onClick={() => setPaletteOpen(true)}><Search size={14} aria-hidden="true" /> 搜索任务 <kbd><Command size={10} /> K</kbd></button>
                <button className="icon-btn" type="button" title="新建任务" onClick={goWorkspace}><Plus size={16} /></button>
              </div>
            </div>
            <div className="tasks-toolbar"><div className="toolbar-title"><span className="toolbar-kicker">看板</span><span className="toolbar-count">{tasks.length}</span></div></div>
            <BoardView tasks={tasks.filter((t) => !t.parentTaskId)} onOpen={openTask} />
          </div>
        ) : view === 'detail' && selected ? (
          <div className="tasks-column detail-page">
            <div className="workspace-topbar">
              <div className="breadcrumb"><span>个人工作区</span><i>/</i><strong>{selected.title}</strong></div>
              <div className="topbar-actions">
                <button className="icon-btn" type="button" title="返回任务列表" onClick={() => { setActiveId(null); setView('tasks') }}><ListTodo size={16} /></button>
              </div>
            </div>
            {tabs.length > 0 && <TabBar tabs={tabs} tasks={tasks} activeId={activeId} onSelect={(id) => { setActiveId(id); setView('detail') }} onClose={closeTab} />}
            <TaskDetail task={selected} tasks={tasks} onSelect={openTask} />
          </div>
        ) : (
          <div className="tasks-column">
            <div className="workspace-topbar">
              <div className="breadcrumb"><span>个人工作区</span><i>/</i><strong>任务</strong>{selected && <><i>/</i><span>{selected.title}</span></>}</div>
              <div className="topbar-actions">
                <button className="command-trigger" type="button" onClick={() => setPaletteOpen(true)}><Search size={14} aria-hidden="true" /> 搜索任务 <kbd><Command size={10} /> K</kbd></button>
                <button className="icon-btn" type="button" title="新建任务" onClick={goWorkspace}><Plus size={16} /></button>
              </div>
            </div>
            <div className="tasks-toolbar">
              <div className="toolbar-title"><span className="toolbar-kicker">任务</span><span className="toolbar-count">{tasks.length}</span></div>
            </div>
            <WorkspaceView onCreated={onCreated} workspaceDir={workspaceDir} onPickWorkspace={pickWorkspace} />
          </div>
        )}
      </main>
    </div>
  )
}
