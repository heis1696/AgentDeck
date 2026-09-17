/**
 * R3 接线契约：在 .detail-columns 内、.detail-main 后挂载一个 <SideDock tasks={tasks} onOpen={onSelect} />。
 * 用 key={主任务.id} 可在切换主任务时清空分页；保持挂载（无 items 时自行返回 null）。
 * openDockItem({ id: `task:${id}`, kind: 'task', title, payload: { taskId: id } }) 打开子任务；
 * file 项 payload 为 DockEditMetadata & { taskId: string }，推荐 id 包含 taskId + 事件 seq + file。
 * openDockItem/closeDockItem 仅经 window CustomEvent('agentdeck:dock') 通信；需先挂载容器，事件不持久化。
 * 同 id 打开更新快照并激活，不新增分页；tasks/onOpen 仅供 WorkerPane 获取最新任务及打开完整详情。
 */
import { useEffect, useId, useRef, useState } from 'react'
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
export type DockItem =
  | { id: string; kind: 'task'; title: string; payload: { taskId: string } }
  | { id: string; kind: 'file'; title: string; payload: DockEditMetadata & { taskId: string } }
type DockEvent = { type: 'open'; item: DockItem } | { type: 'close'; id: string }
const DOCK_EVENT = 'agentdeck:dock'

export function openDockItem(item: DockItem) {
  window.dispatchEvent(new CustomEvent<DockEvent>(DOCK_EVENT, { detail: { type: 'open', item } }))
}
export function closeDockItem(id: string) {
  window.dispatchEvent(new CustomEvent<DockEvent>(DOCK_EVENT, { detail: { type: 'close', id } }))
}

export function SideDock({ tasks, onOpen }: { tasks: Task[]; onOpen: (id: string) => void }) {
  const [state, setState] = useState<{ items: DockItem[]; activeId: string | null }>({ items: [], activeId: null })
  const railRef = useRef<HTMLDivElement>(null)
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
  const active = state.items.find((item) => item.id === state.activeId)
  if (!active) return null
  const activeIndex = state.items.indexOf(active)
  const activate = (index: number) => {
    const item = state.items[index]
    if (!item) return
    setState((current) => ({ ...current, activeId: item.id }))
    railRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index]?.focus()
  }
  return <aside className="side-dock" aria-label="子任务与文件预览">
    <div ref={railRef} className="dock-tabs" role="tablist" aria-label="右侧分页" aria-orientation="vertical">
      {state.items.map((item, index) => <div className={`dock-tab-row${item.id === active.id ? ' is-active' : ''}`} key={item.id}>
        <button type="button" role="tab" id={`${prefix}-tab-${index}`} aria-controls={`${prefix}-panel`} aria-selected={item.id === active.id} tabIndex={item.id === active.id ? 0 : -1} title={item.kind === 'file' ? item.payload.file : item.title} className="dock-tab" onClick={() => activate(index)} onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); activate((index + (event.key === 'ArrowDown' ? 1 : -1) + state.items.length) % state.items.length) }
          if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); activate(event.key === 'Home' ? 0 : state.items.length - 1) }
          if (event.key === 'Delete') { event.preventDefault(); closeDockItem(item.id) }
        }}>
          {item.kind === 'file' ? <FileCode2 size={15} aria-hidden="true" /> : <ListTodo size={15} aria-hidden="true" />}
          <span>{item.title}</span>
        </button>
        <button type="button" className="dock-tab-close" aria-label={`关闭 ${item.title}`} title="关闭分页" onClick={() => closeDockItem(item.id)}><X size={12} aria-hidden="true" /></button>
      </div>)}
    </div>
    <div className="dock-panel" role="tabpanel" id={`${prefix}-panel`} aria-labelledby={`${prefix}-tab-${activeIndex}`}>
      {active.kind === 'file' ? <CodeViewer key={active.id} {...active.payload} /> : <WorkerPane key={active.payload.taskId} taskId={active.payload.taskId} tasks={tasks} onOpen={onOpen} />}
    </div>
  </aside>
}
