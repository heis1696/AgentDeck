import type { Task } from '../../../shared/types'

/** 任务标签条（P5 简版）：点击切换、× 关闭、状态点、标题截断 */
export function TabBar({
  tabs,
  tasks,
  activeId,
  onSelect,
  onClose
}: {
  tabs: string[]
  tasks: Task[]
  activeId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
}) {
  return (
    <div className="tab-bar">
      {tabs.map((id) => {
        const t = tasks.find((x) => x.id === id)
        if (!t) return null
        return (
          <div
            key={id}
            className={`tab ${id === activeId ? 'active' : ''}`}
            onClick={() => onSelect(id)}
            title={`${t.title}${t.parentTaskId ? '（子任务）' : ''}`}
          >
            <span className={`dot dot-${t.status}`} />
            <span className="tab-title">{t.parentTaskId ? '└ ' : ''}{t.title}</span>
            {!!t.attempt && (t.status === 'running' || t.status === 'queued') && <span className="mini">⟳</span>}
            <button
              className="tab-close"
              title="关闭（Ctrl+W）"
              onClick={(e) => {
                e.stopPropagation()
                onClose(id)
              }}
            >
              ×
            </button>
          </div>
        )
      })}
    </div>
  )
}
