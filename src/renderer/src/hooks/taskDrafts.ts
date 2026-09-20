import { useCallback, useRef, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react'

/**
 * 任务状态隔离（本轮修复）：把「属于某个任务」的界面状态按 task.id 分槽。
 *
 * 为什么需要：任务详情是**同一个组件实例**在任务之间复用（App 不按 task.id 挂 key，也不允许
 * 为了清状态重挂载——那会把未发送的草稿一起丢掉）。原先这些状态都是 TaskDetail 的 useState，
 * 切到任务 B 之后，A 的追问草稿、历史、busy、重命名编辑框与各种浮层会原样挂在 B 的界面上。
 *
 * 本模块提供两类语义，各自对应「不该串味」的两种要求：
 * 1. `useTaskScopedState`：**瞬态会话**——切换任务即作废，A→B→A 不会自己重新打开（浮层/菜单/编辑框）；
 * 2. 追问槽位（草稿 / 历史 / busy）：**按任务保留**——A→B→A 各自取回自己的草稿与历史，
 *    且写入带任务归属，迟到的异步回调只落回它出发的那个任务。
 */

/* ==================================================================== *
 * 一、任务作用域会话状态：切换任务即作废
 * ==================================================================== */

/**
 * 把一段瞬态 UI 会话绑到当前任务上：taskId 一变，值立刻回到初始值。
 *
 * - 读：值只认「属于当前任务」的槽；任务已变则本帧直接返回初始值，因此不存在「先画出旧值、
 *   effect 再清掉」的泄漏帧；
 * - 写：setter 绑定任务 id 与会话代次；离开任务后，旧回调被丢弃，
 *   不会重置另一任务，也不会覆盖 A→B→A 后新建的 A 会话。
 *
 * 语义是「作废」而非「恢复」：需要跨任务保留的内容请用下面的追问槽位。
 */
export function useTaskScopedState<T>(taskId: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const initialRef = useRef(initial)
  const resolve = () => (typeof initialRef.current === 'function' ? (initialRef.current as () => T)() : initialRef.current)
  const [slot, setSlot] = useState<{ taskId: string; generation: number; value: T }>(() => ({ taskId, generation: 0, value: resolve() }))
  // 渲染期结算（React 官方「props 变化时调整 state」模式）：提交前 React 会立刻重渲染，旧会话不会被画出来
  if (slot.taskId !== taskId) setSlot({ taskId, generation: slot.generation + 1, value: resolve() })
  const value = slot.taskId === taskId ? slot.value : resolve()
  const set = useCallback<Dispatch<SetStateAction<T>>>((next) => {
    setSlot((current) => {
      // Ignore retired sessions, including callbacks from A before an A/B/A switch.
      if (current.taskId !== taskId || current.generation !== slot.generation) return current
      const value = typeof next === 'function' ? (next as (prev: T) => T)(current.value) : next
      return Object.is(current.value, value) ? current : { ...current, value }
    })
  }, [taskId, slot.generation])
  return [value, set]
}

/* ==================================================================== *
 * 二、追问槽位：每个任务一份草稿 / 历史 / busy
 * ==================================================================== */

/** 每任务追问历史条数上限（既有契约） */
const HISTORY_LIMIT = 50

const historyKey = (taskId: string) => `agentdeck:followup-history:${taskId}`

/** 追问状态槽：按 task.id 分槽，A→B→A 各自取回自己的草稿与历史 */
export interface TaskDraftSlot {
  /** 未发送的追问草稿。只活在当前会话内存里（不新增持久化），但重挂载也不会丢 */
  prompt: string
  /** Changes on every prompt edit, including edits that restore earlier text. */
  promptRevision: number
  /** 追问历史（最新在前）：首次建槽时按任务读 localStorage，之后以内存为准并继续写回 localStorage */
  history: string[]
  /** 历史浏览位置：-1 = 不在历史里（当前草稿）；0 = 最新一条 */
  historyIndex: number
  /** 进入历史浏览前记住的草稿，翻回最新之下时还原 */
  browseDraft: string
  /** 该任务是否有在途动作（发送追问 / 开始 / 停止 / 重新运行） */
  busy: boolean
}

const slots = new Map<string, TaskDraftSlot>()
const listeners = new Set<() => void>()

function readStoredHistory(taskId: string): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(historyKey(taskId)) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : []
  } catch { return [] }
}

/** 取任务槽（首次访问按该任务落在 localStorage 的历史惰性建槽）；同一槽未变更时返回同一引用，供 useSyncExternalStore 比较 */
export function taskDraftSlot(taskId: string): TaskDraftSlot {
  const existing = slots.get(taskId)
  if (existing) return existing
  const created: TaskDraftSlot = { prompt: '', promptRevision: 0, history: readStoredHistory(taskId), historyIndex: -1, browseDraft: '', busy: false }
  slots.set(taskId, created)
  return created
}

/** 更新任务槽：不可变替换（保证快照可比较），实际值没变则不通知、不落新对象 */
export function patchTaskDraft(taskId: string, patch: Partial<TaskDraftSlot>): void {
  const current = taskDraftSlot(taskId)
  const next = { ...current, ...patch }
  if (Object.prototype.hasOwnProperty.call(patch, 'prompt')) next.promptRevision = current.promptRevision + 1
  const changed = next.promptRevision !== current.promptRevision
    || (Object.keys(patch) as Array<keyof TaskDraftSlot>).some((key) => !Object.is(current[key], next[key]))
  if (!changed) return
  slots.set(taskId, next)
  for (const listener of listeners) listener()
}

/** 发送成功入栈：连续重复去重、截断到上限，并同步该任务在 localStorage 的历史（既有契约） */
export function pushTaskHistory(taskId: string, value: string): void {
  const text = value.trim()
  if (!text) return
  const next = [text, ...taskDraftSlot(taskId).history.filter((item) => item !== text)].slice(0, HISTORY_LIMIT)
  try { localStorage.setItem(historyKey(taskId), JSON.stringify(next)) } catch { /* 配额满等场景静默：历史是锦上添花 */ }
  patchTaskDraft(taskId, { history: next, historyIndex: -1, browseDraft: '' })
}

/** 订阅槽位变更（useSyncExternalStore 用） */
export function subscribeTaskDrafts(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** 测试用：清空所有任务槽（等价于新开一个应用会话），避免用例之间串味 */
export function resetTaskDrafts(): void {
  slots.clear()
}

/** 读取当前任务的追问槽：槽变更时重渲染 */
export function useTaskDraftSlot(taskId: string): TaskDraftSlot {
  const getSnapshot = useCallback(() => taskDraftSlot(taskId), [taskId])
  return useSyncExternalStore(subscribeTaskDrafts, getSnapshot, getSnapshot)
}

/**
 * 读/写当前任务的槽字段。setter 绑定任务归属：异步链路里迟到的写入只会写回**它出发的那个任务**，
 * 因此在任务 B 的界面上等待任务 A 的响应，不会把 B 的 busy/草稿改掉。
 */
export function useTaskDraftField<K extends keyof TaskDraftSlot>(taskId: string, field: K): [TaskDraftSlot[K], (next: TaskDraftSlot[K]) => void] {
  const slot = useTaskDraftSlot(taskId)
  const set = useCallback((next: TaskDraftSlot[K]) => { patchTaskDraft(taskId, { [field]: next } as Partial<TaskDraftSlot>) }, [field, taskId])
  return [slot[field], set]
}
