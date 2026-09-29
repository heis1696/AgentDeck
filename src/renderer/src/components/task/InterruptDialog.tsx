/**
 * 打断队员任务的回执对话框：确认后由宿主以 taskService.cancel(id, reason) 提交——
 * 原因可空（空 = 主进程记「用户打断（未填写原因）」），回执落该单时间线并随委派报告回灌领队。
 * Escape / 外点关闭走 useInteractionLayer 统一浮层语义（modal + 焦点陷阱）。
 */
import { useState } from 'react'
import { useInteractionLayer } from '../../hooks/useInteractionLayer'

export interface InterruptDialogProps {
  /** 被打断单的标题（正文确认文案里展示） */
  title: string
  /** 提交进行中：两个按钮都禁用，Escape/外点不关闭 */
  busy: boolean
  /** 确认打断：带输入框原文本（未 trim，收敛规则由调用方定） */
  onConfirm: (reason: string) => void
  onClose: () => void
}

export function InterruptDialog({ title, busy, onConfirm, onClose }: InterruptDialogProps) {
  const [reason, setReason] = useState('')
  // 提交进行中不响应 Escape/外点关闭（取消按钮同样禁用），避免半途关掉丢回执
  const requestClose = () => { if (!busy) onClose() }
  const layerRef = useInteractionLayer<HTMLDivElement>({ open: true, onClose: requestClose, kind: 'modal', name: 'worker-interrupt', trap: true })
  return <div className="overlay" ref={layerRef} onClick={(e) => e.target === e.currentTarget && requestClose()}>
    <div className="dialog" role="dialog" aria-modal="true" aria-label="打断队员任务">
      <h2>打断队员任务</h2>
      <p className="hint">将打断「{title}」。回执会写进该队员单的时间线，并随委派报告回灌给领队。</p>
      <label className="field">
        <span>打断回执（可空）</span>
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} autoFocus placeholder={'如：方向偏了，先停掉等重新派单\n留空则记「未填写原因」'} />
      </label>
      <div className="dialog-footer">
        <button type="button" className="btn" disabled={busy} onClick={onClose}>取消</button>
        <button type="button" className="btn danger" disabled={busy} onClick={() => onConfirm(reason)}>{busy ? '打断中…' : '打断'}</button>
      </div>
    </div>
  </div>
}
