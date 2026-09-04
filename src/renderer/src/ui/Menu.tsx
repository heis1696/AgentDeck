import { useEffect, useRef, useState, type ReactNode } from 'react'

/** 下拉菜单项 */
export interface MenuItem {
  value: string
  label: string
  /** 右侧弱化说明 */
  hint?: string
  disabled?: boolean
}

interface MenuProps {
  items: MenuItem[]
  value?: string
  onChange: (value: string) => void
  /** 触发器渲染：open 状态与当前值传入 */
  trigger: (current: MenuItem | undefined, open: boolean) => ReactNode
  align?: 'left' | 'right'
  /** 菜单宽度（默认随内容，最长 260px） */
  width?: number
}

/** Multica 式下拉菜单：键盘导航（↑↓ Enter Esc）、点击外部关闭、选中勾标 */
export function Menu({ items, value, onChange, trigger, align = 'left', width }: MenuProps) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const current = items.find((i) => i.value === value)

  useEffect(() => {
    if (!open) return
    setActive(Math.max(0, items.findIndex((i) => i.value === value)))
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open, items, value])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === ' ') {
        e.preventDefault()
        setOpen(true)
      }
      return
    }
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false) }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)) }
    else if (e.key === 'Enter') {
      e.preventDefault()
      const it = items[active]
      if (it && !it.disabled) { onChange(it.value); setOpen(false) }
    }
  }

  return (
    <div className="menu-root" ref={rootRef} onKeyDown={onKeyDown}>
      <div onClick={() => setOpen((o) => !o)}>{trigger(current, open)}</div>
      {open && (
        <div className={`menu-panel ${align === 'right' ? 'align-right' : ''}`} style={width ? { width } : undefined} role="listbox">
          {items.map((it, i) => (
            <button
              key={it.value}
              role="option"
              aria-selected={it.value === value}
              disabled={it.disabled}
              className={`menu-item ${i === active ? 'active' : ''} ${it.value === value ? 'selected' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => { onChange(it.value); setOpen(false) }}
            >
              <span className="menu-check">{it.value === value ? '✓' : ''}</span>
              <span className="menu-label">{it.label}</span>
              {it.hint && <span className="menu-hint">{it.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
