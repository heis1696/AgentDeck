import { useMemo } from 'react'
import { Copy } from 'lucide-react'
import { DiffView, parseDiff } from '../DiffView'
import { ui } from '../../ui/interaction-center'
import type { Task } from '../../../../shared/types'

/**
 * Git 改动页：顶部一行改动摘要（文件数 / +行 / -行 / 二进制 / 集成分支 + 复制 diff），
 * 下面是可折叠的 git stat 与逐文件 diff。整页可聚焦（Tab 进入后用方向键/PageDown 阅读长 diff）。
 */
export function GitSummary({ task }: { task: Task }) {
  const files = useMemo(() => task.gitDiff ? parseDiff(task.gitDiff) : [], [task.gitDiff])
  const adds = files.reduce((sum, file) => sum + file.adds, 0)
  const dels = files.reduce((sum, file) => sum + file.dels, 0)
  const binaries = files.filter((file) => file.binary).length
  const statFiles = (task.gitStat ?? '').split('\n').filter((line) => line.includes('|')).length
  const copyDiff = async () => {
    if (!task.gitDiff) return
    try {
      await navigator.clipboard.writeText(task.gitDiff)
      ui.toast.success('diff 已复制')
    } catch { ui.toast.error('复制失败') }
  }
  return (
    <div className="git-pane" tabIndex={0} aria-label="Git 改动">
      <div className="git-summary">
        <span className="git-summary-files">{files.length || statFiles} 个文件有改动</span>
        {(adds > 0 || dels > 0) && <span className="git-summary-counts"><span className="edit-added">+{adds}</span><span className="edit-deleted">-{dels}</span></span>}
        {binaries > 0 && <span className="mini dim">{binaries} 个二进制</span>}
        {task.integration?.branch && <span className="meta-chip mono" title={`集成分支 ${task.integration.branch}`}>⎇ {task.integration.branch.replace('agentdeck/task-', '#')}</span>}
        <button type="button" className="btn detail-btn-ghost git-copy" disabled={!task.gitDiff} onClick={() => void copyDiff()}><Copy size={12} aria-hidden="true" /> 复制 diff</button>
      </div>
      {task.gitStat && <details className="git-stat-wrap" open><summary>git stat</summary><pre className="git-stat">{task.gitStat}</pre></details>}
      {task.gitDiff ? <DiffView diff={task.gitDiff} /> : <div className="list-empty">无改动</div>}
    </div>
  )
}
