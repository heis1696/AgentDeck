import { useEffect } from 'react'
import { ui, type ToastKind } from './interaction-center'
import { useInteractionSelector } from '../hooks/useInteraction'

export type { ToastKind }

/**
 * 兼容转发：命令式推送改由交互中心托管。
 * 宿主挂载前的推送会排队（不再丢），宿主卸载时中心清掉全部定时器。
 */
export const toast = {
  info: (text: string) => ui.toast.info(text),
  success: (text: string) => ui.toast.success(text),
  error: (text: string) => ui.toast.error(text)
}

const ICON: Record<ToastKind, string> = { info: 'ℹ', success: '✓', error: '✕' }

/** Toast 宿主：挂一次在 App 根部；条目与定时器都由交互中心托管 */
export function ToastHost() {
  const items = useInteractionSelector((state) => state.toasts)

  useEffect(() => {
    ui.toast.attach()
    return () => ui.toast.detach()
  }, [])

  return (
    <div className="toast-host">
      {items.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => ui.toast.dismiss(t.id)}>
          <span className="toast-icon">{ICON[t.kind]}</span>
          <span className="toast-text">{t.text}</span>
        </div>
      ))}
    </div>
  )
}
