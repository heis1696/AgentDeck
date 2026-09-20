import { useEffect, useRef } from 'react'
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
  return (
    <div className="overlay" ref={layerRef} onClick={(e) => e.target === e.currentTarget && ui.confirmHost.respond(false)}>
      <div className="dialog confirm-dialog" role="dialog" aria-modal="true" aria-label={request.title}>
        <h2>{request.title}</h2>
        {request.body && <p className="confirm-body">{request.body}</p>}
        <div className="dialog-footer">
          <button className="btn" onClick={() => ui.confirmHost.respond(false)}>{request.cancelText ?? '取消'}</button>
          <button
            ref={confirmBtnRef}
            className={`btn ${request.danger ? 'danger' : 'primary'}`}
            onClick={() => ui.confirmHost.respond(true)}
          >
            {request.confirmText ?? '确定'}
          </button>
        </div>
      </div>
    </div>
  )
}
