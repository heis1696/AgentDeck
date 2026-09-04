import { useEffect, useRef, useState } from 'react'

interface ConfirmOptions {
  title: string
  body?: string
  /** 危险操作：确认按钮红色 */
  danger?: boolean
  confirmText?: string
  cancelText?: string
}

let askFn: ((o: ConfirmOptions) => Promise<boolean>) | null = null

/** 命令式确认框（Promise）；替代原生 confirm() */
export function confirmDialog(o: ConfirmOptions): Promise<boolean> {
  return askFn ? askFn(o) : Promise.resolve(false)
}

/** 确认框宿主：挂一次在 App 根部 */
export function ConfirmHost() {
  const [opt, setOpt] = useState<ConfirmOptions | null>(null)
  const resolveRef = useRef<((v: boolean) => void) | null>(null)
  const confirmBtnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    askFn = (o) =>
      new Promise<boolean>((resolve) => {
        resolveRef.current?.(false) // 上一个未决的直接取消
        resolveRef.current = resolve
        setOpt(o)
      })
    return () => { askFn = null }
  }, [])

  useEffect(() => {
    if (opt) confirmBtnRef.current?.focus()
  }, [opt])

  if (!opt) return null
  const done = (v: boolean) => {
    resolveRef.current?.(v)
    resolveRef.current = null
    setOpt(null)
  }
  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && done(false)}>
      <div className="dialog confirm-dialog">
        <h2>{opt.title}</h2>
        {opt.body && <p className="confirm-body">{opt.body}</p>}
        <div className="dialog-footer">
          <button className="btn" onClick={() => done(false)}>{opt.cancelText ?? '取消'}</button>
          <button
            ref={confirmBtnRef}
            className={`btn ${opt.danger ? 'danger' : 'primary'}`}
            onClick={() => done(true)}
          >
            {opt.confirmText ?? '确定'}
          </button>
        </div>
      </div>
    </div>
  )
}
