import type { Task } from '../../../shared/types'
import { fmtDuration, fmtTime } from '../api'

/** 看板视图（0.9.0）：任务按状态分列，卡片点击打开 */
const COLUMNS: { key: Task['status']; label: string }[] = [
  { key: 'queued', label: '排队中' },
  { key: 'running', label: '执行中' },
  { key: 'done', label: '已完成' },
  { key: 'failed', label: '失败' },
  { key: 'cancelled', label: '已取消' }
]

export function BoardView({ tasks, onOpen }: { tasks: Task[]; onOpen: (id: string) => void }) {
  // 委派子任务也显示（缩进标记），排序：新建在前
  const sorted = [...tasks].sort((a, b) => b.createdAt - a.createdAt)
  return (
    <div className="board">
      {COLUMNS.map((col) => {
        const items = sorted.filter((t) => t.status === col.key)
        return (
          <div key={col.key} className="board-col">
            <div className="board-col-head">
              <span className={`dot dot-${col.key}`} />
              <span className="board-col-title">{col.label}</span>
              <span className="board-col-count">{items.length}</span>
            </div>
            <div className="board-col-body">
              {items.map((t) => (
                <div key={t.id} className={`board-card status-${t.status}`} onClick={() => onOpen(t.id)} title={t.prompt.slice(0, 120)}>
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
              {items.length === 0 && <div className="board-col-empty">—</div>}
            </div>
          </div>
        )
      })}
    </div>
  )
}
