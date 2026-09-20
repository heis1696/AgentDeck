import { useState, type MouseEvent } from 'react'
import { ui } from './interaction-center'

/** Issue 原始 id（iss_xxx）小横条：调试定位用。点击复制到剪贴板；必须拦住冒泡，不能触发行/卡片的打开。 */
export function IssueIdChip({ id }: { id: string }) {
  const [copied, setCopied] = useState(false)
  const copy = (event: MouseEvent) => {
    event.stopPropagation()
    void navigator.clipboard.writeText(id).then(() => {
      setCopied(true)
      ui.toast.success('已复制 Issue ID')
      window.setTimeout(() => setCopied(false), 1400)
    })
  }
  return (
    <button
      type="button"
      className={copied ? 'issue-id-chip ok' : 'issue-id-chip'}
      title="点击复制 Issue ID"
      onClick={copy}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {copied ? '✓ 已复制' : id}
    </button>
  )
}
