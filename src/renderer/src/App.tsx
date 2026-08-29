import { useEffect, useState } from 'react'
import { useTasks } from './api'
import { TaskList } from './components/TaskList'
import { TaskDetail } from './components/TaskDetail'
import { NewTaskDialog } from './components/NewTaskDialog'
import { SettingsView } from './components/SettingsView'
import { TeamView } from './components/TeamView'
import type { Task } from '../../shared/types'

type View = 'tasks' | 'team' | 'settings'

export function App() {
  const { tasks } = useTasks()
  const [view, setView] = useState<View>('tasks')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showNew, setShowNew] = useState(false)
  const selected = tasks.find((t) => t.id === selectedId) ?? null

  // 任务完成/失败 → 系统通知
  useEffect(() => {
    // 通知由主进程 task:notify 推送，这里仅负责聚焦（v1 简化：不加监听）
  }, [])

  // 快捷键：Ctrl+N 新任务
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        setShowNew(true)
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  const onCreated = (t: Task) => {
    setShowNew(false)
    setSelectedId(t.id)
    setView('tasks')
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">⚓</span> AgentDeck
        </div>
        <button className="new-task-btn" onClick={() => setShowNew(true)}>
          ＋ 新任务 <kbd>Ctrl+N</kbd>
        </button>
        <nav className="nav">
          <button className={view === 'tasks' ? 'active' : ''} onClick={() => setView('tasks')}>
            任务
          </button>
          <button className={view === 'team' ? 'active' : ''} onClick={() => setView('team')}>
            队伍
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
        ) : selected ? (
          <TaskDetail task={selected} tasks={tasks} onSelect={setSelectedId} />
        ) : (
          <div className="empty">
            <div className="empty-icon">⚓</div>
            <p>左侧选择任务，或 Ctrl+N 创建新任务</p>
            <p className="hint">单任务或 squad 协同均可指定队员（claude / codex / opencode / zcode）</p>
          </div>
        )}
      </main>
      {showNew && <NewTaskDialog onClose={() => setShowNew(false)} onCreated={onCreated} />}
    </div>
  )
}
