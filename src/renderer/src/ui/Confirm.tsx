import { useEffect, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { ui, type ConfirmOptions } from './interaction-center'
import { useInteractionSelector } from '../hooks/useInteraction'
import { useInteractionLayer } from '../hooks/useInteractionLayer'

export type { ConfirmOptions }

/** 兼容转发：命令式确认框改由交互中心排队（FIFO，多个并发按调用顺序逐个弹） */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return ui.confirm(options)
}

/** 确认框宿主：挂一次在 App 根部 */
export function ConfirmHost() {
  const request = useInteractionSelector((state) => state.confirm)
  const confirmBtnRef = useRef<HTMLButtonElement>(null)
  const [submission, setSubmission] = useState<{ id: number; submitting: boolean; error: string | null } | null>(null)
  const layerRef = useInteractionLayer<HTMLDivElement>({
    open: request !== null,
    onClose: () => { ui.confirmHost.respond(false) },
    kind: 'modal',
    name: 'confirm',
    trap: true,
    initialFocusRef: confirmBtnRef
  })

  // 宿主卸载：当前 + 排队中的全部按「取消」结算，不留悬空 Promise
  useEffect(() => () => ui.confirmHost.cancelAll(), [])
  // FIFO 下一个请求接棒时把焦点移到确认按钮（层本身没有重新打开）
  useEffect(() => { if (request) confirmBtnRef.current?.focus() }, [request?.id])

  if (!request) return null
  const currentSubmission = submission?.id === request.id ? submission : null
  const submitting = currentSubmission?.submitting ?? false
  const submitError = currentSubmission?.error ?? null
  const confirm = async () => {
    if (submitting) return
    if (!request.onConfirm) {
      ui.confirmHost.respond(true)
      return
    }
    setSubmission({ id: request.id, submitting: true, error: null })
    try {
      await request.onConfirm()
      if (ui.getState().confirm?.id === request.id) ui.confirmHost.respond(true)
    } catch (cause) {
      if (ui.getState().confirm?.id === request.id) {
        const message = cause instanceof Error ? cause.message : String(cause)
        setSubmission({ id: request.id, submitting: false, error: message || '提交失败，请重试。' })
      }
    }
  }

  return (
    <div className="overlay" ref={layerRef} onClick={(e) => e.target === e.currentTarget && ui.confirmHost.respond(false)}>
      <div className="dialog confirm-dialog" role="dialog" aria-modal="true" aria-label={request.title}>
        <h2>{request.title}</h2>
        {request.body && <p className="confirm-body">{request.body}</p>}
        {!!request.impactSections?.length && <div className="confirm-impact" aria-label="操作影响预览">
          {request.impactSections.map((section, index) => <section className="confirm-impact-section" key={`${section.title}-${index}`}>
            <h3>{section.title}</h3>
            <ul>{section.items.map((item, itemIndex) => <li key={`${item.label}-${itemIndex}`}>
              <strong>{item.label}</strong><span>{item.description}</span>
            </li>)}</ul>
          </section>)}
        </div>}
        {submitError && <p className="confirm-error" role="alert">{submitError}</p>}
        <div className="dialog-footer">
          <button className="btn" onClick={() => ui.confirmHost.respond(false)}>{submitError ? '关闭' : request.cancelText ?? '取消'}</button>
          <button
            ref={confirmBtnRef}
            className={`btn ${request.danger ? 'danger' : 'primary'}`}
            onClick={() => void confirm()}
            disabled={submitting}
            aria-busy={submitting}
          >
            {submitting ? <><LoaderCircle size={14} className="spin" aria-hidden="true" />提交中…</> : submitError ? '重试' : request.confirmText ?? '确定'}
          </button>
        </div>
      </div>
    </div>
  )
}
