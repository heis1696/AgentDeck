/**
 * SideDock v2（反馈3）：右侧分页容器——
 * - 不再挤压原布局：固定定位贴窗口右缘，打开时通过 window:resizeBy 把窗口**向右延展**出分页宽度；
 *   屏幕放不下（已顶到右缘/最大化）时退化为覆盖层（带阴影提示层级）。
 * - tab 导航为**顶部横向**标签条；左缘为可拖分割线（320–720px，localStorage 记忆），
 *   拖动同步增减窗口宽度。
 * - openDockItem/closeDockItem 经 window CustomEvent('agentdeck:dock') 通信，零 prop 透传；
 *   同 id 重复打开=更新快照并激活（TurnTimeline 用它做「先开快照、git diff 回来再补」的二段式）。
 * - file 项 payload：事件参数快照（DockEditMetadata）+ 可选 git 权威 diff（diff/additions/deletions/diffNote）。
 * - items 清空 → 整体卸载并收回延展的窗口宽度。
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { FileCode2, ListTodo, X } from 'lucide-react'
import type { Task } from '../../../shared/types'
import { bridge } from '../api'
import { CodeViewer } from './CodeViewer'
import { WorkerPane } from '../components/task/WorkerPane'

export interface DockEditMetadata {
  file: string
  additions: number
  deletions: number
  content?: string
  oldString?: string
  newString?: string
  truncated?: boolean
}
/** file 项的 git 权威 diff 通道（tasks:fileDiff 返回；clean/失败时缺省回退参数快照） */
export interface DockFileDiff {
  diff?: string
  additions?: number
  deletions?: number
  diffNote?: string
  binary?: boolean
}
export type DockItem =
  | { id: string; kind: 'task'; title: string; payload: { taskId: string } }
  | { id: string; kind: 'file'; title: string; payload: DockEditMetadata & { taskId: string } & DockFileDiff }
type DockEvent = { type: 'open'; item: DockItem } | { type: 'close'; id: string }
const DOCK_EVENT = 'agentdeck:dock'
const DOCK_WIDTH_KEY = 'agentdeck:dock-width'
const DOCK_MIN = 320
const DOCK_MAX = 720

export function openDockItem(item: DockItem) {
  window.dispatchEvent(new CustomEvent<DockEvent>(DOCK_EVENT, { detail: { type: 'open', item } }))
}
export function closeDockItem(id: string) {
  window.dispatchEvent(new CustomEvent<DockEvent>(DOCK_EVENT, { detail: { type: 'close', id } }))
}

/** 窗口宽度增减（主进程 window:resizeBy）；失败静默——放不下就当覆盖层用 */
const resizeWindowBy = (dx: number) => { if (dx) void bridge.resizeBy(dx).catch(() => {}) }

export function SideDock({ tasks, onOpen }: { tasks: Task[]; onOpen: (id: string) => void }) {
  const [state, setState] = useState<{ items: DockItem[]; activeId: string | null }>({ items: [], activeId: null })
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(DOCK_WIDTH_KEY))
    return Number.isFinite(saved) && saved >= DOCK_MIN && saved <= DOCK_MAX ? saved : 480
  })
  /** 当前因 dock 打开而延展出的窗口宽度（items 清空时收回） */
  const widenedRef = useRef(0)
  const stripRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const prefix = useId()

  useEffect(() => {
    const receive = (event: Event) => {
      const action = (event as CustomEvent<DockEvent>).detail
      if (!action || (action.type !== 'open' && action.type !== 'close')) return
      setState((current) => {
        if (action.type === 'open') {
          const exists = current.items.some((item) => item.id === action.item.id)
          return { items: exists ? current.items.map((item) => item.id === action.item.id ? action.item : item) : [...current.items, action.item], activeId: action.item.id }
        }
        const index = current.items.findIndex((item) => item.id === action.id)
        if (index < 0) return current
        const items = current.items.filter((item) => item.id !== action.id)
        return { items, activeId: current.activeId === action.id ? items[Math.min(index, items.length - 1)]?.id ?? null : current.activeId }
      })
    }
    window.addEventListener(DOCK_EVENT, receive)
    return () => window.removeEventListener(DOCK_EVENT, receive)
  }, [])

  // 打开首个分页 → 向右延展窗口；全部关闭 → 收回；卸载（主任务切换重建）同样收回
  useEffect(() => {
    const open = state.items.length > 0
    if (open && !widenedRef.current) {
      widenedRef.current = width
      resizeWindowBy(width)
    } else if (!open && widenedRef.current) {
      resizeWindowBy(-widenedRef.current)
      widenedRef.current = 0
    }
  }, [state.items.length, width])
  const widenedOnUnmount = useRef(0)
  widenedOnUnmount.current = widenedRef.current
  useEffect(() => () => resizeWindowBy(-widenedOnUnmount.current), [])

  const onSplitterDown = useCallback((event: React.PointerEvent) => {
    event.preventDefault()
    dragRef.current = { startX: event.clientX, startWidth: width }
    stripRef.current?.setPointerCapture(event.pointerId)
  }, [width])
  const onSplitterMove = useCallback((event: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag) return
    const next = Math.min(DOCK_MAX, Math.max(DOCK_MIN, drag.startWidth - (event.clientX - drag.startX)))
    const delta = next - width
    if (!delta) return
    setWidth(next)
    localStorage.setItem(DOCK_WIDTH_KEY, String(next))
    if (widenedRef.current) { widenedRef.current += delta; resizeWindowBy(delta) }
  }, [width])
  const onSplitterUp = useCallback((event: React.PointerEvent) => {
    dragRef.current = null
    stripRef.current?.releasePointerCapture(event.pointerId)
  }, [])

  const active = state.items.find((item) => item.id === state.activeId)
  if (!active) return null
  const activeIndex = state.items.indexOf(active)
  const activate = (index: number) => {
    const item = state.items[index]
    if (!item) return
    setState((current) => ({ ...current, activeId: item.id }))
    stripRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index]?.focus()
  }
  return <aside className="side-dock" aria-label="子任务与文件预览" style={{ width }}>
    <div ref={stripRef} className="dock-splitter" role="separator" aria-orientation="vertical" aria-label="拖动调整分页宽度" title="拖动调整宽度（窗口随之延展/收回）" onPointerDown={onSplitterDown} onPointerMove={onSplitterMove} onPointerUp={onSplitterUp} onPointerCancel={onSplitterUp} />
    <div className="dock-body">
      <div className="dock-tabs" role="tablist" aria-label="右侧分页" aria-orientation="horizontal">
        {state.items.map((item, index) => <div className={`dock-tab-row${item.id === active.id ? ' is-active' : ''}`} key={item.id}>
          <button type="button" role="tab" id={`${prefix}-tab-${index}`} aria-controls={`${prefix}-panel`} aria-selected={item.id === active.id} tabIndex={item.id === active.id ? 0 : -1} title={item.kind === 'file' ? item.payload.file : item.title} className="dock-tab" onClick={() => activate(index)} onKeyDown={(event) => {
            if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); activate((index + (event.key === 'ArrowRight' ? 1 : -1) + state.items.length) % state.items.length) }
            if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); activate(event.key === 'Home' ? 0 : state.items.length - 1) }
            if (event.key === 'Delete') { event.preventDefault(); closeDockItem(item.id) }
          }}>
            {item.kind === 'file' ? <FileCode2 size={14} aria-hidden="true" /> : <ListTodo size={14} aria-hidden="true" />}
            <span className="dock-tab-title">{item.title}</span>
          </button>
          <button type="button" className="dock-tab-close" aria-label={`关闭 ${item.title}`} title="关闭分页" onClick={() => closeDockItem(item.id)}><X size={12} aria-hidden="true" /></button>
        </div>)}
      </div>
      <div className="dock-panel" role="tabpanel" id={`${prefix}-panel`} aria-labelledby={`${prefix}-tab-${activeIndex}`}>
        {active.kind === 'file'
          ? <CodeViewer key={active.id} {...active.payload} />
          : <WorkerPane key={active.payload.taskId} taskId={active.payload.taskId} tasks={tasks} onOpen={onOpen} />}
      </div>
    </div>
  </aside>
}
