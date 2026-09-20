import { useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { ChevronDown, X } from 'lucide-react'
import { useInteractionLayer } from '../hooks/useInteractionLayer'
import { isComposingKey } from './interaction-center'

const NUDGE = 16
const NUDGE_LARGE = 64

/**
 * 详情页浮窗：绝对定位于最近的有定位祖先（.detail）内，默认贴右上，
 * 按住头部可拖拽（限制在容器内），右上 × 关闭。承载 GoalPanel/MeetingPanel 等去常驻后的内容。
 *
 * 本轮升级（窄窗 / 键盘可达 / 长内容）：
 * - 头部可聚焦：←/→/↑/↓ 移动 16px（Shift 64px）、Home 复位到默认贴右上、双击头部同样复位；
 * - 可折叠内容区（头部 ▾ 按钮），窄窗下先收起来不挡标题与动作；
 * - 折叠态与位置都写进 data 属性，样式与回归测试可读；拖拽/关闭/Escape 语义完全不变。
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
  const [collapsed, setCollapsed] = useState(false)

  const clamp = (x: number, y: number) => {
    const box = boxRef.current
    const parent = box?.offsetParent as HTMLElement | null
    if (!box || !parent) return { x, y }
    const maxX = Math.max(8, parent.clientWidth - box.offsetWidth - 8)
    const maxY = Math.max(8, parent.clientHeight - box.offsetHeight - 8)
    return { x: Math.min(Math.max(8, x), maxX), y: Math.min(Math.max(8, y), maxY) }
  }
  /** 重新测量后限位：容器缩小或内容高度变化时，旧 left/top 可能已经越界。 */
  const reclamp = () => {
    const box = boxRef.current
    const parent = box?.offsetParent as HTMLElement | null
    if (!box || !parent) return
    const rect = box.getBoundingClientRect()
    const parentRect = parent.getBoundingClientRect()
    const next = clamp(rect.left - parentRect.left, rect.top - parentRect.top)
    setPos((current) => current && current.x === next.x && current.y === next.y ? current : next)
  }
  useLayoutEffect(() => {
    reclamp()
    const box = boxRef.current
    const parent = box?.offsetParent as HTMLElement | null
    if (!box || !parent || typeof ResizeObserver === 'undefined') return
    let frame = 0
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(reclamp)
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(parent)
    observer.observe(box)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [collapsed, width])
  /** 当前位置（未拖过时按实际排版算），供键盘微调与拖拽共用 */
  const currentPos = () => {
    if (pos) return pos
    const box = boxRef.current
    const parent = box?.offsetParent as HTMLElement | null
    if (!box || !parent) return { x: 8, y: 8 }
    const rect = box.getBoundingClientRect()
    const parentRect = parent.getBoundingClientRect()
    return { x: rect.left - parentRect.left, y: rect.top - parentRect.top }
  }
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('button')) return
    const box = boxRef.current
    const parent = box?.offsetParent as HTMLElement | null
    if (!box || !parent) return
    const base = currentPos()
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
  const nudge = (dx: number, dy: number) => {
    const base = currentPos()
    setPos(clamp(base.x + dx, base.y + dy))
  }
  const onHeadKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    // IME 组合中方向键属于候选选择，不搬窗口
    if (isComposingKey(event.nativeEvent)) return
    const step = event.shiftKey ? NUDGE_LARGE : NUDGE
    if (event.key === 'ArrowLeft') { event.preventDefault(); nudge(-step, 0); return }
    if (event.key === 'ArrowRight') { event.preventDefault(); nudge(step, 0); return }
    if (event.key === 'ArrowUp') { event.preventDefault(); nudge(0, -step); return }
    if (event.key === 'ArrowDown') { event.preventDefault(); nudge(0, step); return }
    if (event.key === 'Home') { event.preventDefault(); setPos(null) }
  }

  return (
    <div
      ref={boxRef}
      className={`float-window${collapsed ? ' is-collapsed' : ''}`}
      style={{ width, ...(pos ? { left: pos.x, top: pos.y } : {}) }}
      role="dialog"
      aria-label={typeof title === 'string' ? title : '浮窗'}
      data-collapsed={collapsed ? 'true' : 'false'}
      data-positioned={pos ? 'true' : 'false'}
    >
      <header
        className="float-window-head"
        tabIndex={0}
        aria-label="浮窗标题栏：按住可拖动，方向键移动，Home 复位"
        title="按住拖动 · 方向键移动 · Home 复位 · 双击复位"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
        onDoubleClick={() => setPos(null)}
        onKeyDown={onHeadKeyDown}
      >
        <span className="float-window-icon" aria-hidden="true">{icon}</span>
        <strong className="float-window-title">{title}</strong>
        <button type="button" className="icon-btn float-window-fold" title={collapsed ? '展开内容' : '折叠内容'} aria-expanded={!collapsed} aria-label={collapsed ? '展开浮窗内容' : '折叠浮窗内容'} onClick={() => setCollapsed((value) => !value)}><ChevronDown size={14} aria-hidden="true" /></button>
        <button type="button" className="icon-btn float-window-close" title="收起浮窗" onClick={onClose}><X size={14} /></button>
      </header>
      <div className="float-window-body" hidden={collapsed}>{children}</div>
    </div>
  )
}
