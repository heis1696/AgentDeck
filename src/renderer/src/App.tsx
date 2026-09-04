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
import { ListTodo, Users, Gauge, Settings } from 'lucide-react'
import { ToastHost, toast } from './ui/Toasts'
import { ConfirmHost } from './ui/Confirm'
import { Palette, type PaletteCommand } from './ui/Palette'
import type { Task } from '../../shared/types'

type View = 'tasks' | 'team' | 'usage' | 'settings'

const MAX_TABS = 8

export function App() {
  const { tasks } = useTasks()
  const { settings, update } = useSettings()

  // 主题：dark | light | system（跟随系统时监听变化）
  useEffect(() => {
    const theme = settings?.theme ?? 'dark'
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
  /** 任务页展示形态：列表 / 看板（记忆） */
  const [board, setBoard] = useState(() => localStorage.getItem('agentdeck:board') === '1')
  const toggleBoard = () => setBoard((b) => { localStorage.setItem('agentdeck:board', b ? '0' : '1'); return !b })
  /** 已打开的任务标签（taskId 列表，按打开顺序）；null 激活 = 工作区起始页 */
  const [tabs, setTabs] = useState<string[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const selected = tasks.find((t) => t.id === activeId) ?? null

  const openTask = (id: string) => {
    setTabs((cur) => (cur.includes(id) ? cur : [...cur, id].slice(-MAX_TABS)))
    setActiveId(id)
    setView('tasks')
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
      { id: 'act-board', group: '操作', label: board ? '切换为列表视图' : '切换为看板视图', keywords: 'board list', run: toggleBoard },
      { id: 'act-theme', group: '操作', label: `主题：切换为${(settings?.theme ?? 'dark') === 'dark' ? '浅色' : '深色'}`, keywords: 'theme light dark', run: () => { void update({ theme: (settings?.theme ?? 'dark') === 'dark' ? 'light' : 'dark' }) } }
    ]
    for (const t of tasks.slice(0, 20)) {
      cmds.push({ id: `task-${t.id}`, group: '任务', label: t.title, hint: t.status, keywords: t.prompt, run: () => openTask(t.id) })
    }
    return cmds
  }, [tasks, board, settings?.theme])

  return (
    <div className="app">
      <ToastHost />
      <ConfirmHost />
      <Palette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">⚓</span> AgentDeck
        </div>
        <button className="new-task-btn" onClick={goWorkspace}>
          ＋ 新任务 <kbd>Ctrl+N</kbd>
        </button>
        <nav className="nav">
          <button className={view === 'tasks' ? 'active' : ''} onClick={() => setView('tasks')}>
            <ListTodo /> 任务
          </button>
          <button className={view === 'team' ? 'active' : ''} onClick={() => setView('team')}>
            <Users /> 队伍
          </button>
          <button className={view === 'usage' ? 'active' : ''} onClick={() => setView('usage')}>
            <Gauge /> 用量
          </button>
          <button className={view === 'settings' ? 'active' : ''} onClick={() => setView('settings')}>
            <Settings /> 设置
          </button>
        </nav>
        {view === 'tasks' && <TaskList tasks={tasks} selectedId={activeId} onSelect={openTask} />}
      </aside>
      <main className="main">
        {view === 'settings' ? (
          <SettingsView />
        ) : view === 'team' ? (
          <TeamView />
        ) : view === 'usage' ? (
          <UsageView />
        ) : (
          <div className="tasks-column">
            <div className="tasks-toolbar">
              <button className={`btn pill ${board ? '' : 'on'}`} onClick={() => board && toggleBoard()}>列表</button>
              <button className={`btn pill ${board ? 'on' : ''}`} onClick={() => !board && toggleBoard()}>看板</button>
            </div>
            {tabs.length > 0 && <TabBar tabs={tabs} tasks={tasks} activeId={activeId} onSelect={setActiveId} onClose={closeTab} />}
            {selected ? (
              <TaskDetail task={selected} tasks={tasks} onSelect={openTask} />
            ) : board ? (
              <BoardView tasks={tasks.filter((t) => !t.parentTaskId)} onOpen={openTask} />
            ) : (
              <WorkspaceView onCreated={onCreated} />
            )}
          </div>
        )}
      </main>
    </div>
  )
}
