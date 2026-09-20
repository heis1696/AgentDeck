import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import type { Task } from '../../../shared/types'
import { PARKED_QUEUED_LABEL, TASK_STATUS_LABELS, isParkedQueued } from '../labels'
import { isComposingKey } from '../ui/interaction-center'

/**
 * 任务标签条（P5）：点击切换、× 关闭、状态点、标题截断。
 *
 * 本轮升级（密度 / 运行反馈 / 窄窗 / 键盘可达）：
 * - WAI-ARIA tabs 键盘模型：←/→ 环绕、Home/End 首尾、Delete 关闭（焦点交给接棒页签），
 *   与 SideDock 页签条同一套手感；中键点击关闭；
 * - 运行反馈：执行中页签底部一条不定量进度檐 + 状态点脉冲，排队/停放/重试各有标识；
 * - 密度：页签内容为「状态点 + 标题 + 运行标识 + 关闭」，宽度上限收紧、窄窗横向滚动；
 * - 激活项自动滚入视野（页签上限 8，窄窗仍可能溢出）。
 * 交互中心契约不变：本组件仍是无状态受控视图，选择/关闭全部回调给宿主。
 */
export function TabBar({
  tabs,
  tasks,
  activeId,
  onSelect,
  onClose
}: {
  tabs: readonly string[]
  tasks: Task[]
  activeId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
}) {
  const tabRefs = useRef(new Map<string, HTMLDivElement>())
  const barRef = useRef<HTMLDivElement>(null)
  /** 关页签时焦点本来就在页签条里：新 tabs/activeId 渲染完成后按实际 activeId 归位（见下方 effect） */
  const pendingCloseFocusRef = useRef(false)
  /** 被关页签的下标：仅在宿主把激活项移到了本页签条不显示的任务时用于兜底 */
  const lastClosedIndexRef = useRef(0)
  const visible = tabs
    .map((id) => tasks.find((task) => task.id === id))
    .filter((task): task is Task => !!task)

  // 激活页签滚入视野：窄窗 + 多页签时不让「当前任务」躲在横向滚动区之外
  // （jsdom 等无排版环境没有 scrollIntoView，按可选调用容错）
  useEffect(() => {
    if (!activeId) return
    tabRefs.current.get(activeId)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [activeId, tabs.length])

  const focusTab = (id: string) => tabRefs.current.get(id)?.focus()
  const activate = (index: number) => {
    const task = visible[index]
    if (!task) return
    onSelect(task.id)
    focusTab(task.id)
  }
  /**
   * 关页签（审查项 3）：焦点不能按「邻位」猜，必须跟随宿主结算后的**实际** activeId——
   * closeTab 把激活项落到最后一个剩余页签（不是被关项的右邻），被关的那项还可能不是激活项。
   * 这里只置一个待办标记，等 tabs/activeId 新值渲染完再按 id 定位焦点。
   * 焦点原本不在页签条里（如中键关闭）则不抢焦点。
   */
  const closeAt = (index: number) => {
    const task = visible[index]
    if (!task) return
    pendingCloseFocusRef.current = barRef.current?.contains(document.activeElement) ?? false
    lastClosedIndexRef.current = index
    onClose(task.id)
  }

  // 关闭后焦点归位：优先落在实际 activeId 上；若宿主把激活项移到了本页签条不显示的任务
  // （子任务挂在领队详情的右侧分页里），退回到被关项的邻位，保证焦点不掉给 body。
  useEffect(() => {
    if (!pendingCloseFocusRef.current) return
    pendingCloseFocusRef.current = false
    if (!visible.length) return
    const target = activeId && tabRefs.current.has(activeId)
      ? activeId
      : visible[Math.min(lastClosedIndexRef.current, visible.length - 1)]?.id
    if (target) focusTab(target)
  }, [tabs, activeId])

  return (
    <div
      className="tab-bar"
      ref={barRef}
      role="tablist"
      aria-label="已打开的任务"
      aria-orientation="horizontal"
      onKeyDown={(event) => {
        // IME 组合中：Enter 上屏、←/→ 选候选，页签条不抢键
        if (isComposingKey(event.nativeEvent)) return
        const id = (event.target as HTMLElement | null)?.closest<HTMLElement>('[role="tab"]')?.dataset.tabId
        const index = visible.findIndex((task) => task.id === id)
        if (index < 0) return
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          event.preventDefault()
          activate((index + (event.key === 'ArrowRight' ? 1 : -1) + visible.length) % visible.length)
          return
        }
        if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault()
          activate(event.key === 'Home' ? 0 : visible.length - 1)
          return
        }
        if (event.key === 'Delete') {
          event.preventDefault()
          closeAt(index)
        }
      }}
    >
      {visible.map((task, index) => {
        const isActive = task.id === activeId
        const state = isParkedQueued(task) ? PARKED_QUEUED_LABEL : TASK_STATUS_LABELS[task.status]
        return (
          <div
            key={task.id}
            ref={(node) => { if (node) tabRefs.current.set(task.id, node); else tabRefs.current.delete(task.id) }}
            className={`tab${isActive ? ' active' : ''} status-${task.status}${task.status === 'running' ? ' is-busy' : ''}`}
            data-tab-id={task.id}
            data-status={task.status}
            onClick={() => onSelect(task.id)}
            onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); onClose(task.id) } }}
            role="tab"
            aria-selected={isActive}
            aria-label={`${task.title}（${state}）${index + 1}/${visible.length}`}
            tabIndex={isActive ? 0 : -1}
            title={`${task.title}${task.parentTaskId ? '（子任务）' : ''}\n${state}${task.workerIndex != null ? `\n队员 #${task.workerIndex + 1}` : ''}\n←/→ 切换 · Delete 关闭 · Ctrl+W 关闭当前`}
          >
            <span className={`dot dot-${task.status}`} aria-hidden="true" />
            <span className="tab-title">{task.parentTaskId ? '└ ' : ''}{task.title}</span>
            {!!task.attempt && <span className="tab-flag" aria-hidden="true" title={`自动重试 ${task.attempt}/2`}>⟳{task.attempt}</span>}
            {task.status === 'queued' && <span className="tab-flag is-queued" aria-hidden="true">{isParkedQueued(task) ? '⏸' : '…'}</span>}
            {task.status === 'running' && <span className="tab-progress" aria-hidden="true" />}
            <button
              className="tab-close"
              title="关闭（Ctrl+W）"
              aria-label={`关闭任务 ${task.title}`}
              tabIndex={-1}
              onClick={(event) => {
                event.stopPropagation()
                closeAt(index)
              }}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
