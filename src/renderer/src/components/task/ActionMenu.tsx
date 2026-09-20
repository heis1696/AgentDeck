import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { useInteractionLayer } from '../../hooks/useInteractionLayer'
import { isComposingKey } from '../../ui/interaction-center'

export interface ActionMenuItem {
  key: string
  label: string
  icon?: ReactNode
  /** 右侧弱化说明（快捷键/后果提示） */
  hint?: string
  danger?: boolean
  disabled?: boolean
  run: () => void
}

/**
 * 详情页「更多操作」动作菜单：把低频/破坏性动作从头部按钮行收进一个浮层，
 * 让主行动（开始/停止/重新运行/复制结果）独占视线。
 *
 * 契约：动作本身仍由宿主传入（本组件不碰 taskService / bridge），
 * 浮层语义走统一交互层——最上层 Escape 关闭、外点关闭、关闭后焦点归还触发器；
 * 打开时首焦点落在第一个可用动作，↑↓/Home/End 在动作间移动，Enter/Space 触发。
 */
export function ActionMenu({ items, label = '更多操作', triggerLabel, align = 'right' }: {
  items: ActionMenuItem[]
  label?: string
  triggerLabel?: string
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const firstRef = useRef<HTMLButtonElement | null>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  useInteractionLayer<HTMLDivElement>({
    open,
    onClose: () => setOpen(false),
    kind: 'popover',
    name: 'task-actions',
    closeOnOutside: true,
    layerRef: boxRef,
    initialFocusRef: firstRef,
    // 触发器在层根内部（.action-menu-root 包着按钮 + 面板），默认归还目标会被
    // 「不把焦点还进层内」的规则挡掉；显式给出归还目标，关闭当帧的微任务兜底把焦点收回按钮
    restoreFocusRef: triggerRef
  })
  if (!items.length) return null
  // 首焦点必须落在**第一个可用动作**上：disabled 按钮不可聚焦，指过去会留在 body（焦点空档）
  const firstEnabled = items.findIndex((item) => !item.disabled)

  const move = (from: HTMLButtonElement | null, delta: number) => {
    const nodes = itemRefs.current.filter((node): node is HTMLButtonElement => !!node && !node.disabled)
    if (!nodes.length) return
    const index = from ? nodes.indexOf(from) : -1
    const next = index < 0 ? (delta > 0 ? 0 : nodes.length - 1) : (index + delta + nodes.length) % nodes.length
    nodes[next]?.focus()
  }
  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // IME 组合中：↑↓/Enter 属于输入法候选，不抢键
    if (isComposingKey(event.nativeEvent)) return
    const target = event.target as HTMLButtonElement
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); move(target, event.key === 'ArrowDown' ? 1 : -1); return }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const nodes = itemRefs.current.filter((node): node is HTMLButtonElement => !!node && !node.disabled)
      const node = event.key === 'Home' ? nodes[0] : nodes[nodes.length - 1]
      node?.focus()
    }
  }

  return (
    <div className="action-menu-root" ref={boxRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`btn detail-btn-ghost action-menu-trigger${open ? ' is-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal size={14} aria-hidden="true" />
        {triggerLabel && <span className="action-menu-trigger-label">{triggerLabel}</span>}
      </button>
      {open && (
        <div className={`action-menu-panel${align === 'left' ? ' align-left' : ''}`} role="menu" aria-label={label} onKeyDown={onPanelKeyDown}>
          {items.map((item, index) => (
            <button
              key={item.key}
              ref={(node) => { itemRefs.current[index] = node; if (index === firstEnabled) firstRef.current = node }}
              type="button"
              role="menuitem"
              className={`action-menu-item${item.danger ? ' is-danger' : ''}`}
              disabled={item.disabled}
              onClick={() => { setOpen(false); item.run() }}
            >
              <span className="action-menu-icon" aria-hidden="true">{item.icon}</span>
              <span className="action-menu-label">{item.label}</span>
              {item.hint && <span className="action-menu-hint">{item.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
