import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Search } from 'lucide-react'
import { useIssues } from '../api'
import { ISSUE_STATUS_LABELS } from '../labels'
import type { Issue } from '../../../shared/types'

/**
 * 可搜索的 Issue 下拉选择器：行内展示状态点 + identifier + 标题。
 * 全局会议/目标页用它挑发起对象；disabledReason 返回文案则该行禁选（如未绑定任务的 Issue 不能开目标模式）。
 */
export function IssuePicker({ value, onChange, disabledReason, placeholder = '选择 Issue…' }: {
  value: string
  onChange: (issueId: string) => void
  /** 返回禁选原因文案则该行禁选并提示；不传则全部可选 */
  disabledReason?: (issue: Issue) => string | null
  placeholder?: string
}) {
  const { issues } = useIssues()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false) }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const selected = issues.find((issue) => issue.id === value)
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return issues
    return issues.filter((issue) => `${issue.identifier} ${issue.title}`.toLowerCase().includes(q))
  }, [issues, query])

  return <div className="issue-picker" ref={rootRef}>
    <button type="button" className="issue-picker-trigger" aria-haspopup="listbox" aria-expanded={open} onClick={() => { setOpen((v) => !v); setQuery('') }}>
      {selected
        ? <span className="issue-picker-value"><span className={`issue-dot status-${selected.status}`} title={ISSUE_STATUS_LABELS[selected.status]} /><b>{selected.identifier}</b><span className="issue-picker-title">{selected.title}</span></span>
        : <span className="issue-picker-placeholder">{placeholder}</span>}
      <ChevronDown size={14} className="issue-picker-caret" />
    </button>
    {open && <div className="issue-picker-panel" role="listbox" aria-label="选择 Issue">
      <label className="issue-picker-search"><Search size={13} /><input autoFocus value={query} placeholder="搜索 identifier / 标题…" onChange={(event) => setQuery(event.target.value)} /></label>
      <div className="issue-picker-list">
        {visible.length === 0 && <div className="issue-picker-empty">没有匹配的 Issue</div>}
        {visible.map((issue) => {
          const reason = disabledReason?.(issue) ?? null
          return <button type="button" key={issue.id} role="option" aria-selected={issue.id === value} disabled={!!reason} title={reason ?? issue.title}
            className={`issue-picker-item${issue.id === value ? ' selected' : ''}`}
            onClick={() => { onChange(issue.id); setOpen(false) }}>
            <span className={`issue-dot status-${issue.status}`} title={ISSUE_STATUS_LABELS[issue.status]} />
            <b>{issue.identifier}</b>
            <span className="issue-picker-title">{issue.title}</span>
            <span className="issue-picker-hint">{reason ?? ISSUE_STATUS_LABELS[issue.status]}</span>
          </button>
        })}
      </div>
    </div>}
  </div>
}
