import { useEffect, useState } from 'react'
import { Check, ShieldAlert, X } from 'lucide-react'
import type { PermissionRequest } from '../../../../shared/contracts'
import { fmtDuration } from '../../api'

const RISK_LABEL: Record<string, string> = { low: '低风险', medium: '中风险', high: '高风险', critical: '极高风险' }

/**
 * 权限审批横幅：工具名 + 风险等级 + 理由 + 允许/拒绝。
 *
 * 本轮升级（不改变语义，只把「要你决定什么」说清楚）：
 * - 风险等级中文化 + 图标化，颜色不是唯一信号（文字同样标注等级）；
 * - 显示等待时长（审批挂起会阻塞执行，用户需要知道已经等了多久）；
 * - 工具入参摘要可展开（有 input 时），决定前能看到要执行什么；
 * - role="alert" + aria-live：横幅出现时读屏会播报，但**不抢焦点**（不打断正在输入的追问）。
 */
export function PermissionPrompt({ permission, onAnswer }: { permission: PermissionRequest; onAnswer: (decision: 'allow' | 'deny') => void }) {
  const [now, setNow] = useState(() => Date.now())
  const [since] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const risk = RISK_LABEL[permission.riskLevel] ?? permission.riskLevel
  const input = permission.input === undefined || permission.input === null ? '' : typeof permission.input === 'string' ? permission.input : JSON.stringify(permission.input, null, 2)
  return (
    <div className="permission-banner" role="alert" aria-live="assertive">
      <div className="permission-info">
        <div className="permission-head">
          <b className="permission-tool"><ShieldAlert size={13} aria-hidden="true" /> {permission.toolName || '工具'}</b>
          <span className={`risk risk-${permission.riskLevel}`}>{risk}</span>
          <span className="permission-wait" aria-hidden="true" title="审批挂起时长：未答复前执行会一直等待">已等待 {fmtDuration(now - since)}</span>
          <span className="permission-id mono">{String(permission.requestId)}</span>
        </div>
        <div className="permission-reason">{permission.reason}</div>
        {!!input && <details className="permission-input"><summary>查看工具入参</summary><pre>{input}</pre></details>}
      </div>
      <div className="row permission-actions">
        <button className="btn primary" onClick={() => onAnswer('allow')} title="允许本次调用并继续执行"><Check size={13} aria-hidden="true" /> 允许</button>
        <button className="btn danger" onClick={() => onAnswer('deny')} title="拒绝本次调用（执行会收到拒绝结果并继续处理）"><X size={13} aria-hidden="true" /> 拒绝</button>
      </div>
    </div>
  )
}
