import { useEffect, useState } from 'react'
import type { Task } from '../../../shared/types'
import { fmtDuration, fmtTime } from '../api'
import { bridge } from '../api'
import { toast } from '../ui/Toasts'
import { EmptyState } from '../ui/EmptyState'
import { CheckCircle2, CircleAlert, CircleDot, Clock3, Ban } from 'lucide-react'

/** 看板视图（0.9.0）：任务按状态分列，卡片点击打开 */
const COLUMNS: { key: Task['status']; label: string; icon: typeof Clock3 }[] = [
  { key: 'queued', label: '排队中', icon: Clock3 },
  { key: 'running', label: '执行中', icon: CircleDot },
  { key: 'done', label: '已完成', icon: CheckCircle2 },
  { key: 'failed', label: '失败', icon: CircleAlert },
  { key: 'cancelled', label: '已取消', icon: Ban }
]

export function BoardView({ tasks, onOpen }: { tasks: Task[]; onOpen: (id: string) => void }) {
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [dropTarget, setDropTarget] = useState<Task['status'] | null>(null)
  useEffect(() => {
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    return () => { window.removeEventListener('click', close); window.removeEventListener('blur', close) }
  }, [])
  const move = async (id: string, status: Task['status']) => {
    setMenu(null)
    const result = await bridge.tasks.move(id, status)
    if (!result.ok) toast.error(result.error ?? '无法移动任务')
    else toast.success('任务已移动')
  }
  const menuTask = menu ? tasks.find((t) => t.id === menu.id) : undefined
  // 委派子任务也显示（缩进标记），排序：新建在前
  const sorted = [...tasks].sort((a, b) => b.createdAt - a.createdAt)
  return (
    <div className="board">
      {COLUMNS.map((col) => {
        const items = sorted.filter((t) => t.status === col.key)
        return (
          <div
            key={col.key}
            className={`board-col ${dropTarget === col.key ? 'is-drag-target' : ''}`}
            onDragEnter={() => setDropTarget(col.key)}
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }}
            onDragLeave={(e) => { if (e.currentTarget === e.target) setDropTarget(null) }}
            onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData('text/task-id'); if (id) void move(id, col.key); setDropTarget(null) }}
          >
            <div className="board-col-head">
              <span className={`dot dot-${col.key}`} />
              <col.icon size={14} aria-hidden="true" />
              <span className="board-col-title">{col.label}</span>
              <span className="board-col-count">{items.length}</span>
            </div>
            <div className="board-col-body">
              {items.map((t) => (
                <div
                  key={t.id}
                  className={`board-card status-${t.status}`}
                  onClick={() => onOpen(t.id)}
                  onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ id: t.id, x: e.clientX, y: e.clientY }) }}
                  draggable
                  onDragStart={(e) => { e.dataTransfer.setData('text/task-id', t.id); e.dataTransfer.effectAllowed = 'move' }}
                  onDragEnd={() => setDropTarget(null)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(t.id) } }}
                  role="button"
                  tabIndex={0}
                  title={t.prompt.slice(0, 120)}
                >
                  {t.parentTaskId && <span className="board-card-worker">└ 子任务</span>}
                  <div className="board-card-title">{t.title}</div>
                  <div className="board-card-meta">
                    <span className="badge">{t.backend}</span>
                    {t.integration?.branch && <span className="badge badge-squad">⚡</span>}
                    {!!t.attempt && <span className="mini">⟳{t.attempt}/2</span>}
                    {t.startedAt && t.endedAt && <span className="mini">{fmtDuration(t.endedAt - t.startedAt)}</span>}
                    {t.status !== 'running' && t.status !== 'queued' && <span className="mini">{fmtTime(t.endedAt)}</span>}
                    {t.workdir && <span className="mini workdir">{t.workdir.split(/[\\/]/).pop()}</span>}
                  </div>
                </div>
              ))}
              {items.length === 0 && <EmptyState compact title="Empty" />}
            </div>
          </div>
        )
      })}
      {menu && menuTask && (
        <div
          className="board-context-menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button role="menuitem" onClick={() => { setMenu(null); onOpen(menuTask.id) }}>打开任务</button>
          <div className="board-context-separator" />
          {COLUMNS.filter((c) => c.key !== menuTask.status).map((c) => (
            <button key={c.key} role="menuitem" onClick={() => void move(menuTask.id, c.key)}>移动到 {c.label}</button>
          ))}
        </div>
      )}
    </div>
  )
}
