import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { useInteractionLayer } from '../hooks/useInteractionLayer'

/**
 * 详情页浮窗：绝对定位于最近的有定位祖先（.detail）内，默认贴右上，
 * 按住头部可拖拽（限制在容器内），右上 × 关闭。承载 GoalPanel/MeetingPanel 等去常驻后的内容。
 */
export function FloatWindow({ title, icon, onClose, width = 360, children }: {
  title: ReactNode
  icon?: ReactNode
  onClose: () => void
  width?: number
  children: ReactNode
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null)
  // 统一浮层：最上层 Escape 收起浮窗，关闭后焦点归还（浮窗不抢页面交互，故不设焦点陷阱）
  useInteractionLayer<HTMLDivElement>({ open: true, onClose, kind: 'window', name: 'float-window', layerRef: boxRef })
  // null = 尚未拖过，走 CSS 默认贴右上；拖动后改用 left/top
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)

  const clamp = (x: number, y: number) => {
    const box = boxRef.current
    const parent = box?.offsetParent as HTMLElement | null
    if (!box || !parent) return { x, y }
    const maxX = Math.max(8, parent.clientWidth - box.offsetWidth - 8)
    const maxY = Math.max(8, parent.clientHeight - box.offsetHeight - 8)
    return { x: Math.min(Math.max(8, x), maxX), y: Math.min(Math.max(8, y), maxY) }
  }
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('button')) return
    const box = boxRef.current
    const parent = box?.offsetParent as HTMLElement | null
    if (!box || !parent) return
    const rect = box.getBoundingClientRect()
    const parentRect = parent.getBoundingClientRect()
    const base = pos ?? { x: rect.left - parentRect.left, y: rect.top - parentRect.top }
    dragRef.current = { startX: event.clientX, startY: event.clientY, baseX: base.x, baseY: base.y }
    if (!pos) setPos(base)
    event.preventDefault()
    document.body.classList.add('float-dragging')
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current
    if (!drag) return
    setPos(clamp(drag.baseX + event.clientX - drag.startX, drag.baseY + event.clientY - drag.startY))
  }
  const endDrag = () => {
    dragRef.current = null
    document.body.classList.remove('float-dragging')
  }

  return (
    <div
      ref={boxRef}
      className="float-window"
      style={{ width, ...(pos ? { left: pos.x, top: pos.y } : {}) }}
      role="dialog"
      aria-label={typeof title === 'string' ? title : '浮窗'}
    >
      <header
        className="float-window-head"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
      >
        <span className="float-window-icon" aria-hidden="true">{icon}</span>
        <strong className="float-window-title">{title}</strong>
        <button type="button" className="icon-btn float-window-close" title="收起浮窗" onClick={onClose}><X size={14} /></button>
      </header>
      <div className="float-window-body">{children}</div>
    </div>
  )
}
