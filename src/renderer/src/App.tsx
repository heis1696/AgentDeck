import { useEffect, useState } from 'react'
import { bridge, useTasks } from './api'
import { TaskList } from './components/TaskList'
import { TaskDetail } from './components/TaskDetail'
import { SettingsView } from './components/SettingsView'
import { TeamView } from './components/TeamView'
import { UsageView } from './components/UsageView'
import { WorkspaceView, FOCUS_WORKSPACE } from './components/WorkspaceView'
import type { Task } from '../../shared/types'

type View = 'tasks' | 'team' | 'usage' | 'settings'

export function App() {
  const { tasks } = useTasks()
  const [view, setView] = useState<View>('tasks')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = tasks.find((t) => t.id === selectedId) ?? null

  // 删除任务后若正选中它，回到工作区
  useEffect(() => bridge.tasks.onDeleted((id) => {
    setSelectedId((cur) => (cur === id ? null : cur))
  }), [])

  // 系统通知点击：聚焦对应任务
  useEffect(() => bridge.tasks.onFocusTask((id) => {
    setSelectedId(id)
    setView('tasks')
  }), [])

  /** 回到常驻工作区（Ctrl+N / 侧栏按钮） */
  const goWorkspace = () => {
    setSelectedId(null)
    setView('tasks')
    window.dispatchEvent(new Event(FOCUS_WORKSPACE))
  }

  // 快捷键：Ctrl+N 新任务（聚焦工作区输入框）
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        goWorkspace()
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  const onCreated = (t: Task) => {
    setSelectedId(t.id)
    setView('tasks')
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">⚓</span> AgentDeck
        </div>
        <button className="new-task-btn" onClick={goWorkspace}>
          ＋ 新任务 <kbd>Ctrl+N</kbd>
        </button>
        <nav className="nav">
          <button className={view === 'tasks' ? 'active' : ''} onClick={() => setView('tasks')}>
            任务
          </button>
          <button className={view === 'team' ? 'active' : ''} onClick={() => setView('team')}>
            队伍
          </button>
          <button className={view === 'usage' ? 'active' : ''} onClick={() => setView('usage')}>
            用量
          </button>
          <button className={view === 'settings' ? 'active' : ''} onClick={() => setView('settings')}>
            设置
          </button>
        </nav>
        {view === 'tasks' && <TaskList tasks={tasks} selectedId={selectedId} onSelect={setSelectedId} />}
      </aside>
      <main className="main">
        {view === 'settings' ? (
          <SettingsView />
        ) : view === 'team' ? (
          <TeamView />
        ) : view === 'usage' ? (
          <UsageView />
        ) : selected ? (
          <TaskDetail task={selected} tasks={tasks} onSelect={setSelectedId} />
        ) : (
          <WorkspaceView onCreated={onCreated} />
        )}
      </main>
    </div>
  )
}
