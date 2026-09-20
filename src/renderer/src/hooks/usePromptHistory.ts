import { useCallback } from 'react'
import { patchTaskDraft, pushTaskHistory, useTaskDraftSlot } from './taskDrafts'

/**
 * 追问框历史（readline 语义）：
 * - ↑ 向旧翻、↓ 向新翻；停在最旧再按 ↑ 不动
 * - 翻回最新之下（index < 0）恢复进框前的草稿
 * - 发送成功入栈（连续重复去重），按任务持久化到 localStorage
 * 非受控导航：不管理输入值本身，只把历史文本回调给调用方写入 textarea；
 * 调用方在用户手动编辑时应退出浏览态（setIndex(-1) 语义由 draft 兜底）。
 *
 * 任务隔离（本轮修复）：历史、浏览位置与浏览草稿都按 task.id 分槽（见 taskDrafts）。
 * 切到任务 B 看到的是 B 自己的历史；A→B→A 回到 A 原来的浏览位置，
 * 上一个任务的历史不会残留在新任务的 ↑/↓ 里。localStorage 的键与语义保持不变。
 */
export function usePromptHistory(taskId: string) {
  const { history, historyIndex: index, browseDraft } = useTaskDraftSlot(taskId)

  /** 进入历史浏览前记住当前草稿，翻回最新之下时还原 */
  const beginBrowse = useCallback(() => { if (index < 0) patchTaskDraft(taskId, { browseDraft: '' }) }, [index, taskId])

  const navigate = useCallback((direction: -1 | 1): string | null => {
    if (!history.length) return null
    // ↑：从草稿进入历史取最新一条；继续按向旧走
    const next = index < 0 && direction === -1 ? 0 : Math.min(history.length - 1, Math.max(-1, index + direction))
    if (next === index) return null
    const draft = index < 0 ? '' : browseDraft
    patchTaskDraft(taskId, { historyIndex: next, browseDraft: draft })
    return next < 0 ? draft : history[next]
  }, [browseDraft, history, index, taskId])

  const exitBrowse = useCallback(() => patchTaskDraft(taskId, { historyIndex: -1 }), [taskId])

  const push = useCallback((value: string) => { pushTaskHistory(taskId, value) }, [taskId])

  return { history, index, beginBrowse, navigate, exitBrowse, push }
}
