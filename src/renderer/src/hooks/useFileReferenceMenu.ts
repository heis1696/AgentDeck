import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { workspaceListEntries } from '../api'
import { detectFileToken, splitToken, filterEntries, type FileMenuItem } from '../components/WorkspaceFileMenu'
import type { WorkspaceEntry } from '../../../shared/contracts'

/**
 * @ 文件引用补全（吸收 ZCode 输入壳 mention 面板）：派单框与追问框共用的状态机。
 * 宿主职责：onChange 后调 onTextChange；onKeyDown 里先问 handleKeyDown（true = 已消费）；
 * 渲染 WorkspaceFileMenu（items/activeIndex/onHover/onPick）。
 * 键盘契约与 SkillMenu 同款：IME 组合中一律让路（宿主需先用 isComposingKey 短路）。
 */
export function useFileReferenceMenu(options: { workdir: string; textareaRef: RefObject<HTMLTextAreaElement | null> }) {
  const { workdir, textareaRef } = options
  const [items, setItems] = useState<FileMenuItem[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const cacheRef = useRef(new Map<string, WorkspaceEntry[]>())
  const seqRef = useRef(0)
  useEffect(() => { cacheRef.current.clear() }, [workdir])

  const run = useCallback((token: string) => {
    const base = workdir.trim()
    if (!base) { setOpen(false); return }
    const { subdir, filter } = splitToken(token)
    const cached = cacheRef.current.get(subdir)
    if (cached) { setItems(filterEntries(cached, filter, subdir)); setActive(0); setOpen(true); return }
    const seq = ++seqRef.current
    setItems([])
    setActive(0)
    setOpen(true)
    void workspaceListEntries(base, subdir).then((result) => {
      if (seq !== seqRef.current) return
      if (!result.ok) { setOpen(false); return }
      cacheRef.current.set(subdir, result.entries)
      setItems(filterEntries(result.entries, filter, subdir))
    }).catch(() => { if (seq === seqRef.current) setOpen(false) })
  }, [workdir])

  /** 宿主 onChange 后调用：检测光标处 @ 片段并驱动菜单 */
  const onTextChange = useCallback((value: string, selectionStart: number) => {
    const token = detectFileToken(value, selectionStart)
    if (token) run(token.token)
    else setOpen(false)
  }, [run])

  const clear = useCallback(() => { setOpen(false); setItems([]) }, [])

  /** 选中条目：替换光标处 @ 片段；目录带 / 继续下钻，文件落完整相对路径后收起。
   *  返回新的输入值（受控组件由宿主落 state）。 */
  const pick = useCallback((item: FileMenuItem, value: string): { value: string; caret: number } | null => {
    const el = textareaRef.current
    const caret = el?.selectionStart ?? value.length
    const token = detectFileToken(value, caret)
    const start = token ? token.at : caret
    const insert = item.kind === 'dir' ? `${item.path}/` : `${item.path} `
    const next = value.slice(0, start) + insert + value.slice(caret)
    if (item.kind === 'dir') run(`${item.path}/`)
    else { setOpen(false); setItems([]) }
    return { value: next, caret: start + insert.length }
  }, [run, textareaRef])

  /** 键盘导航：菜单有候选时消费 ↑↓/Enter/Tab/Esc；返回 true 表示已消费（宿主不再处理） */
  const handleKeyDown = useCallback((event: KeyboardEvent, value: string, onPicked: (next: { value: string; caret: number }) => void): boolean => {
    if (!open) return false
    if (event.key === 'ArrowDown' && items.length) { event.preventDefault(); setActive((i) => Math.min(items.length - 1, i + 1)); return true }
    if (event.key === 'ArrowUp' && items.length) { event.preventDefault(); setActive((i) => Math.max(0, i - 1)); return true }
    if ((event.key === 'Enter' || event.key === 'Tab') && items.length) {
      event.preventDefault()
      const result = pick(items[Math.min(active, items.length - 1)], value)
      if (result) onPicked(result)
      return true
    }
    if (event.key === 'Escape') { event.preventDefault(); clear(); return true }
    return false
  }, [open, items, active, pick, clear])

  return { open, items, active, setActive, onTextChange, handleKeyDown, pick, clear }
}
