import type { ReactNode } from 'react'
import { Inbox, type LucideIcon } from 'lucide-react'

export function EmptyState({
  title,
  description,
  action,
  icon: Icon = Inbox,
  compact = false
}: {
  title: string
  description?: string
  action?: ReactNode
  icon?: LucideIcon
  compact?: boolean
}) {
  return (
    <div className={`empty-state${compact ? ' compact' : ''}`}>
      <span className="empty-state-icon"><Icon size={compact ? 18 : 24} strokeWidth={1.7} /></span>
      <strong>{title}</strong>
      {description && <p>{description}</p>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  )
}
