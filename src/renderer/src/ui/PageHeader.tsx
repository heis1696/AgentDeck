import type { ReactNode } from 'react'
import '../polish/page-header.css'

/**
 * 主页面共享页头（docs/UI-VISUAL-REPAIR.md · Shared Header Contract）。
 *
 * 七个主页面 + 详情标题共用同一个页头结构：每个页面只有一个可见主标题（h1），
 * 标题 / 图标 / 计数 / 上下文 / 操作的沟槽与几何完全一致。
 * 标记固定为 header.view-header[data-page-header]，样式只在 polish/page-header.css：
 * 不挂 page-header-bar / psh-header 等历史页头类，避免再叠一层覆盖。
 */
export type PageHeaderProps = {
  title: ReactNode
  icon?: ReactNode
  count?: ReactNode
  actions?: ReactNode
  metadata?: ReactNode
}

export function PageHeader({ title, icon, count, actions, metadata }: PageHeaderProps) {
  return <header className="view-header" data-page-header>
    <div className="view-header-main">
      <div className="view-header-heading">
        {icon != null && <span className="view-header-icon" aria-hidden="true">{icon}</span>}
        <h1 className="view-header-title">{title}</h1>
        {/* 计数可选；给了就照实显示（0 也显示，不用「有没有」兼职「开没开始」） */}
        {count != null && <span className="view-header-count">{count}</span>}
      </div>
      {metadata != null && <div className="view-header-meta">{metadata}</div>}
    </div>
    {actions != null && <div className="view-header-actions">{actions}</div>}
  </header>
}
