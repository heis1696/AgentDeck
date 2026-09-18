/**
 * SideDock v3（反馈二轮 1-4）：右侧分页容器是**常规布局列**——
 * 挂在 .detail 行布局末位，与左侧主内容共分界面宽度；分割线拖动只在此区域内
 * 重新分配（dock 变宽=主内容让出空白，反之亦然），**不再改变窗口尺寸、不再悬浮覆盖**。
 * 窗口最小宽度由主进程 minWidth 兜底（主区最小 + 分栏最小），拉窄不会互相遮挡。
 * tab 导航为顶部横向标签条；宽度 320–720px，localStorage 记忆。
 * openDockItem/closeDockItem 经 window CustomEvent('agentdeck:dock') 通信，零 prop 透传；
 * 同 id 重复打开=更新快照并激活（TurnTimeline 用它做「先开快照、git diff 回来再补」的二段式）。
 * file 项 payload：事件参数快照（DockEditMetadata）+ 可选 git 权威 diff（diff/additions/deletions/diffNote）。
 * items 清空 → 整体卸载，主内容自动占回全宽。
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { FileCode2, ListTodo, X } from 'lucide-react'
import type { Task } from '../../../shared/types'
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

export function SideDock({ tasks, onOpen }: { tasks: Task[]; onOpen: (id: string) => void }) {
  const [state, setState] = useState<{ items: DockItem[]; activeId: string | null }>({ items: [], activeId: null })
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(DOCK_WIDTH_KEY))
    return Number.isFinite(saved) && saved >= DOCK_MIN && saved <= DOCK_MAX ? saved : 480
  })
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

  // 分割线只重新分配本行内宽度：向左拖=分栏变宽（主内容让空白），向右拖=分栏收窄
  const onSplitterDown = useCallback((event: React.PointerEvent) => {
    event.preventDefault()
    dragRef.current = { startX: event.clientX, startWidth: width }
    stripRef.current?.setPointerCapture(event.pointerId)
  }, [width])
  const onSplitterMove = useCallback((event: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag) return
    const next = Math.min(DOCK_MAX, Math.max(DOCK_MIN, drag.startWidth - (event.clientX - drag.startX)))
    if (next === width) return
    setWidth(next)
    localStorage.setItem(DOCK_WIDTH_KEY, String(next))
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
    <div ref={stripRef} className="dock-splitter" role="separator" aria-orientation="vertical" aria-label="拖动调整分页宽度" title="拖动调整分页宽度" onPointerDown={onSplitterDown} onPointerMove={onSplitterMove} onPointerUp={onSplitterUp} onPointerCancel={onSplitterUp} />
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
