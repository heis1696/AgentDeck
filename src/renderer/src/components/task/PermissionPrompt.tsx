import type { PermissionRequest } from '../../../../shared/contracts'

export function PermissionPrompt({ permission, onAnswer }: { permission: PermissionRequest; onAnswer: (decision: 'allow' | 'deny') => void }) {
  return (
    <div className="permission-banner">
      <div className="permission-info">
        <b>🔒 {permission.toolName || '工具'}</b>
        <span className={`risk risk-${permission.riskLevel}`}>{permission.riskLevel}</span>
        <div className="permission-reason">{permission.reason}</div>
      </div>
      <div className="row">
        <button className="btn primary" onClick={() => onAnswer('allow')}>允许</button>
        <button className="btn danger" onClick={() => onAnswer('deny')}>拒绝</button>
      </div>
    </div>
  )
}
