/**
 * SideDock v4（交互中心化）：右侧分页容器仍是**常规布局列**——
 * 挂在 .detail 行布局末位，与左侧主内容共分界面宽度；分割线拖动只在此区域内重新分配。
 * 窗口最小宽度由主进程 minWidth 兜底。tab 导航为顶部横向标签条；宽度 320–720px，localStorage 记忆。
 *
 * 与 v3 的区别：分页状态（items/activeId）不再由组件自持，也不再走 window CustomEvent——
 * 全部存在 ui/interaction-center 的 dock 桶里，**按根任务隔离**、跨挂载保留：
 * - openDockItem/closeDockItem 保留为兼容转发（转调 ui.dock.open/close）；
 * - 同 id 重复 open = 换新打开请求标识（token）并激活；TurnTimeline 的二段式 diff 回写
 *   必须凭 token 命中同一次打开，页签被关掉后旧异步结果直接作废（不会重开）。
 * file 项 payload：事件参数快照（DockEditMetadata）+ 可选 git 权威 diff（diff/additions/deletions/diffNote）。
 * items 清空 → 整体卸载，主内容自动占回全宽。
 */
import { useCallback, useId, useRef, useState } from 'react'
import { FileCode2, ListTodo, X } from 'lucide-react'
import type { Task } from '../../../shared/types'
import { CodeViewer } from './CodeViewer'
import { WorkerPane } from '../components/task/WorkerPane'
import { ui, isComposingKey, type DockHandle, type DockItem } from './interaction-center'
import { useInteractionSelector } from '../hooks/useInteraction'

export type { DockEditMetadata, DockFileDiff, DockItem } from './interaction-center'

const DOCK_WIDTH_KEY = 'agentdeck:dock-width'
const DOCK_MIN = 320
const DOCK_MAX = 720

/** 兼容转发：打开/更新分页项（返回打开请求标识，供异步回写校验） */
export function openDockItem(item: DockItem): DockHandle {
  return ui.dock.open(item)
}
/** 兼容转发：关闭分页项 */
export function closeDockItem(id: string): boolean {
  return ui.dock.close(id)
}

export function SideDock({ taskId, tasks, onOpen }: { taskId: string; tasks: Task[]; onOpen: (id: string) => void }) {
  // 分页桶按根任务隔离：子任务详情页与其领队共享同一桶，切走再回来不丢
  const rootId = ui.rootTaskId(taskId)
  const bucket = useInteractionSelector((state) => state.docks[rootId])
  const items = bucket?.items ?? []
  const activeId = items.some((item) => item.id === bucket?.activeId) ? bucket!.activeId : items[0]?.id ?? null

  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(DOCK_WIDTH_KEY))
    return Number.isFinite(saved) && saved >= DOCK_MIN && saved <= DOCK_MAX ? saved : 480
  })
  const stripRef = useRef<HTMLDivElement>(null)
  // 页签按钮按 id 登记：键盘切换靠它把焦点带到新激活页签。
  // （原先拿 stripRef 这个**分割线**容器去 querySelectorAll('[role=tab]')，永远查不到元素：
  //   ←/→/Home/End 只换激活项、焦点原地不动，Delete 关页签还会把焦点掉到 body。）
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const prefix = useId()

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

  const active = items.find((item) => item.id === activeId)
  if (!active) return null
  const activeIndex = items.indexOf(active)
  const focusTab = (id: string) => tabRefs.current.get(id)?.focus()
  const activate = (index: number) => {
    const item = items[index]
    if (!item) return
    ui.dock.activate(item.id, { rootId })
    // 焦点跟着激活项走（roving tabindex）：按 id 取自己的按钮，不再从容器 ref 里按序号找
    focusTab(item.id)
  }
  /** Delete 关页签：先把焦点交给接棒的页签，否则按钮一卸载焦点就掉到 body */
  const closeTab = (index: number) => {
    const item = items[index]
    if (!item) return
    const rest = items.filter((current) => current.id !== item.id)
    const next = rest[Math.min(index, rest.length - 1)]
    ui.dock.close(item.id, { rootId })
    if (next) focusTab(next.id)
  }
  return <aside className="side-dock" aria-label="子任务与文件预览" style={{ width }}>
    <div ref={stripRef} className="dock-splitter" role="separator" aria-orientation="vertical" aria-label="拖动调整分页宽度" title="拖动调整分页宽度" onPointerDown={onSplitterDown} onPointerMove={onSplitterMove} onPointerUp={onSplitterUp} onPointerCancel={onSplitterUp} />
    <div className="dock-body">
      <div className="dock-tabs" role="tablist" aria-label="右侧分页" aria-orientation="horizontal">
        {items.map((item, index) => <div className={`dock-tab-row${item.id === active.id ? ' is-active' : ''}`} key={item.id}>
          <button type="button" role="tab" id={`${prefix}-tab-${index}`} aria-controls={`${prefix}-panel`} aria-selected={item.id === active.id} tabIndex={item.id === active.id ? 0 : -1} title={item.kind === 'file' ? item.payload.file : item.title} className="dock-tab" ref={(node) => { if (node) tabRefs.current.set(item.id, node); else tabRefs.current.delete(item.id) }} onClick={() => activate(index)} onKeyDown={(event) => {
            if (isComposingKey(event.nativeEvent)) return
            if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); activate((index + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length) }
            if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); activate(event.key === 'Home' ? 0 : items.length - 1) }
            if (event.key === 'Delete') { event.preventDefault(); closeTab(index) }
          }}>
            {item.kind === 'file' ? <FileCode2 size={14} aria-hidden="true" /> : <ListTodo size={14} aria-hidden="true" />}
            <span className="dock-tab-title">{item.title}</span>
          </button>
          <button type="button" className="dock-tab-close" aria-label={`关闭 ${item.title}`} title="关闭分页" onClick={() => ui.dock.close(item.id, { rootId })}><X size={12} aria-hidden="true" /></button>
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
