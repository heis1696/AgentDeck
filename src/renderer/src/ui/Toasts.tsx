import { useEffect, useState } from 'react'

export type ToastKind = 'info' | 'success' | 'error'

interface ToastItem {
  id: number
  kind: ToastKind
  text: string
}

let nextId = 1
let pushFn: ((kind: ToastKind, text: string) => void) | null = null

/** 命令式推送（全局单例宿主挂载后可用） */
export const toast = {
  info: (text: string) => pushFn?.('info', text),
  success: (text: string) => pushFn?.('success', text),
  error: (text: string) => pushFn?.('error', text)
}

const ICON: Record<ToastKind, string> = { info: 'ℹ', success: '✓', error: '✕' }

/** Toast 宿主：挂一次在 App 根部；替代原生 alert() */
export function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([])

  useEffect(() => {
    pushFn = (kind, text) => {
      const id = nextId++
      setItems((cur) => [...cur.slice(-3), { id, kind, text }])
      setTimeout(() => setItems((cur) => cur.filter((t) => t.id !== id)), 4200)
    }
    return () => { pushFn = null }
  }, [])

  return (
    <div className="toast-host">
      {items.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => setItems((cur) => cur.filter((x) => x.id !== t.id))}>
          <span className="toast-icon">{ICON[t.kind]}</span>
          <span className="toast-text">{t.text}</span>
        </div>
      ))}
    </div>
  )
}
