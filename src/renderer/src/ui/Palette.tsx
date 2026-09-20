import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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
  // 统一浮层：Escape 由交互层接管（最上层），打开时聚焦输入框，关闭后焦点归还
  const layerRef = useInteractionLayer<HTMLDivElement>({ open, onClose, kind: 'modal', name: 'palette', trap: true, initialFocusRef: inputRef })

  const results = useMemo(() => {
    const scored = commands
      .map((c) => {
        const s = Math.min(fuzzyScore(query, c.label), c.keywords ? fuzzyScore(query, c.keywords) : Infinity)
        return { c, s }
      })
      .filter((x) => x.s >= 0)
      .sort((a, b) => a.s - b.s)
      .slice(0, 12)
    return scored.map((x) => x.c)
  }, [commands, query])

  useEffect(() => {
    if (open) {
      setQuery('')
      setActive(0)
    }
  }, [open])

  useEffect(() => setActive(0), [query])

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
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(results.length - 1, a + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); runAt(active) }
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
      <div className="palette" onKeyDown={onKeyDown}>
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder ?? '搜索任务、跳转页面、执行操作…'}
          spellCheck={false}
        />
        <div className="palette-list" ref={listRef}>
          {sections.map((sec) => (
            <div key={sec.group}>
              <div className="palette-group">{sec.group}</div>
              {sec.items.map(({ c, i }) => (
                <button
                  key={c.id}
                  className={`palette-item ${i === active ? 'active' : ''}`}
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
