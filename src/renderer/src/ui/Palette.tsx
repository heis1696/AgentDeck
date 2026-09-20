import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { useInteractionLayer } from '../hooks/useInteractionLayer'
import { isComposingKey } from './interaction-center'

export interface PaletteCommand {
  id: string
  label: string
  /** 分组名（面板里按组分区显示） */
  group: string
  hint?: string
  keywords?: string
  run: () => void
}

interface PaletteProps {
  open: boolean
  onClose: () => void
  /** 空查询时的占位文案 */
  placeholder?: string
  commands: PaletteCommand[]
}

/** 子序列模糊匹配：返回匹配得分（越小越好）或 -1 */
function fuzzyScore(query: string, text: string): number {
  if (!query) return 100
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  const idx = t.indexOf(q)
  if (idx === 0) return 0 // 前缀最优
  if (idx > 0) return idx
  // 子序列兜底
  let ti = 0
  for (const ch of q) {
    ti = t.indexOf(ch, ti)
    if (ti === -1) return -1
    ti++
  }
  return 50
}

/** Ctrl+K 命令面板：模糊过滤 + 分组 + 键盘导航（对照 Multica SearchCommand 的形态） */
export function Palette({ open, onClose, commands, placeholder }: PaletteProps) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  // 统一浮层：Escape 由交互层接管（最上层），打开时聚焦输入框，关闭后焦点归还
  const layerRef = useInteractionLayer<HTMLDivElement>({ open, onClose, kind: 'modal', name: 'palette', trap: true, initialFocusRef: inputRef })

  const results = useMemo(() => {
    const scored = commands
      .map((c) => {
        const scores = [fuzzyScore(query, c.label), c.keywords ? fuzzyScore(query, c.keywords) : -1].filter((score) => score >= 0)
        const s = scores.length ? Math.min(...scores) : -1
        return { c, s }
      })
      .filter((x) => x.s >= 0)
      .sort((a, b) => a.s - b.s)
      .slice(0, 12)
    // Grouping changes visual order; keyboard indices must follow that same order.
    const groups = new Map<string, PaletteCommand[]>()
    for (const { c } of scored) {
      const group = groups.get(c.group) ?? []
      group.push(c)
      groups.set(c.group, group)
    }
    return [...groups.values()].flat()
  }, [commands, query])
  const activeIndex = results.length ? Math.max(0, Math.min(active, results.length - 1)) : -1

  useEffect(() => {
    if (open) {
      setQuery('')
      setActive(0)
    }
  }, [open])

  useEffect(() => setActive(0), [query])

  useEffect(() => {
    if (!open || activeIndex < 0) return
    const list = listRef.current
    const item = list?.querySelector<HTMLElement>('.palette-item.active')
    if (!list || !item) return
    const bounds = list.getBoundingClientRect()
    const target = item.getBoundingClientRect()
    if (target.top < bounds.top) list.scrollTop += target.top - bounds.top
    else if (target.bottom > bounds.bottom) list.scrollTop += target.bottom - bounds.bottom
  }, [open, activeIndex, results])

  if (!open) return null

  const runAt = (i: number) => {
    const c = results[i]
    if (!c) return
    onClose()
    c.run()
  }

  // Escape（含关闭）交给统一交互层；这里只处理列表导航
  const onKeyDown = (e: React.KeyboardEvent) => {
    // IME 组合中（isComposing / keyCode 229）：Enter 是上屏、↑↓ 是选候选，一律不抢
    if (isComposingKey(e.nativeEvent)) return
    if (e.key === 'ArrowDown') { e.preventDefault(); if (results.length) setActive(Math.min(results.length - 1, activeIndex + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (results.length) setActive(Math.max(0, activeIndex - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); runAt(activeIndex) }
  }

  // 按分组分区渲染（保持 results 的排序）
  const sections: { group: string; items: { c: (typeof results)[number]; i: number }[] }[] = []
  results.forEach((c, i) => {
    let sec = sections.find((x) => x.group === c.group)
    if (!sec) { sec = { group: c.group, items: [] }; sections.push(sec) }
    sec.items.push({ c, i })
  })

  return (
    <div className="overlay palette-overlay" ref={layerRef} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="命令面板" onKeyDown={onKeyDown}>
        <input
          ref={inputRef}
          className="palette-input"
          role="combobox"
          aria-label="搜索命令"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls={listId}
          aria-activedescendant={activeIndex >= 0 ? `${listId}-option-${activeIndex}` : undefined}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder ?? '搜索任务、跳转页面、执行操作…'}
          spellCheck={false}
        />
        <div className="palette-list" ref={listRef} id={listId} role="listbox" aria-label="命令">
          {sections.map((sec) => (
            <div key={sec.group} role="group" aria-label={sec.group}>
              <div className="palette-group">{sec.group}</div>
              {sec.items.map(({ c, i }) => (
                <button
                  key={c.id}
                  type="button"
                  role="option"
                  id={`${listId}-option-${i}`}
                  aria-selected={i === activeIndex}
                  tabIndex={-1}
                  className={`palette-item ${i === activeIndex ? 'active' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => runAt(i)}
                >
                  <span className="palette-label">{highlight(c.label, query)}</span>
                  {c.hint && <span className="menu-hint">{c.hint}</span>}
                </button>
              ))}
            </div>
          ))}
          {results.length === 0 && <div className="palette-empty">无匹配结果</div>}
        </div>
        <div className="palette-foot">
          <kbd>↑↓</kbd> 选择 <kbd>Enter</kbd> 执行 <kbd>Esc</kbd> 关闭
        </div>
      </div>
    </div>
  )
}

function highlight(label: string, query: string): ReactNode {
  if (!query) return label
  const idx = label.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return label
  return (
    <>
      {label.slice(0, idx)}
      <b className="palette-hl">{label.slice(idx, idx + query.length)}</b>
      {label.slice(idx + query.length)}
    </>
  )
}
