import { useCallback, useRef, useState } from 'react'

/** 每任务追问历史条数上限 */
const HISTORY_LIMIT = 50

/**
 * 追问框历史（readline 语义）：
 * - ↑ 向旧翻、↓ 向新翻；停在最旧再按 ↑ 不动
 * - 翻回最新之下（index < 0）恢复进框前的草稿
 * - 发送成功入栈（连续重复去重），按任务持久化到 localStorage
 * 非受控导航：不管理输入值本身，只把历史文本回调给调用方写入 textarea；
 * 调用方在用户手动编辑时应退出浏览态（setIndex(-1) 语义由 draft 兜底）。
 */
export function usePromptHistory(taskId: string) {
  const key = `agentdeck:followup-history:${taskId}`
  const [history, setHistory] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(key) ?? '[]') as string[] } catch { return [] }
  })
  // 浏览位置：-1 = 不在历史里（当前草稿）；0 = 最新一条
  const [index, setIndex] = useState(-1)
  const draftRef = useRef('')

  /** 进入历史浏览前记住当前草稿，翻回最新之下时还原 */
  const beginBrowse = useCallback(() => { if (index < 0) draftRef.current = '' }, [index])

  const navigate = useCallback((direction: -1 | 1): string | null => {
    if (!history.length) return null
    // ↑：从草稿进入历史取最新一条；继续按向旧走
    const next = index < 0 && direction === -1 ? 0 : Math.min(history.length - 1, Math.max(-1, index + direction))
    if (next === index) return null
    if (index < 0) draftRef.current = ''
    setIndex(next)
    return next < 0 ? draftRef.current : history[next]
  }, [history, index])

  const exitBrowse = useCallback(() => setIndex(-1), [])

  const push = useCallback((value: string) => {
    const text = value.trim()
    if (!text) return
    setHistory((current) => {
      const next = [text, ...current.filter((item) => item !== text)].slice(0, HISTORY_LIMIT)
      try { localStorage.setItem(key, JSON.stringify(next)) } catch { /* 配额满等场景静默：历史是锦上添花 */ }
      return next
    })
    setIndex(-1)
    draftRef.current = ''
  }, [key])

  return { history, index, beginBrowse, navigate, exitBrowse, push }
}
