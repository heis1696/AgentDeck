import { useMemo } from 'react'
import { Copy } from 'lucide-react'
import { DiffView, parseDiff } from '../DiffView'
import { ui } from '../../ui/interaction-center'
import type { Task } from '../../../../shared/types'

type GitSnapshotState = 'executing' | 'unavailable' | 'clean' | 'available'

function snapshotState(task: Task, hasChanges: boolean): GitSnapshotState {
  const hasSnapshot = typeof task.gitDiff === 'string' || typeof task.gitStat === 'string'
  if (!hasSnapshot) return task.status === 'running' || task.status === 'queued' ? 'executing' : 'unavailable'
  return hasChanges ? 'available' : 'clean'
}

/** Git view keeps access available and distinguishes absent snapshots from a recorded clean result. */
export function GitSummary({ task }: { task: Task }) {
  const files = useMemo(() => task.gitDiff ? parseDiff(task.gitDiff) : [], [task.gitDiff])
  const adds = files.reduce((sum, file) => sum + file.adds, 0)
  const dels = files.reduce((sum, file) => sum + file.dels, 0)
  const binaries = files.filter((file) => file.binary).length
  const statFiles = (task.gitStat ?? '').split('\n').filter((line) => line.includes('|')).length
  const hasChanges = Boolean(task.gitDiff?.trim() || task.gitStat?.trim())
  const state = snapshotState(task, hasChanges)
  const fileCount = files.length || statFiles
  const copyDiff = async () => {
    if (!task.gitDiff?.trim()) return
    try {
      await navigator.clipboard.writeText(task.gitDiff)
      ui.toast.success('diff 已复制')
    } catch { ui.toast.error('复制失败') }
  }
  return (
    <div className="git-pane" tabIndex={0} aria-label="Git 改动" data-snapshot-state={state}>
      {state === 'executing' && <div className="git-snapshot-state" role="status"><strong>{task.status === 'queued' ? '等待执行，暂无 Git 快照' : '执行中，尚未收集 Git 快照'}</strong><span>执行结束后会收集可用的仓库变更。</span></div>}
      {state === 'unavailable' && <div className="git-snapshot-state" role="status"><strong>未记录 Git 快照</strong><span>{task.workdir ? '没有已收集的执行快照，当前仓库状态未知。' : '此任务未绑定工作目录。'}</span></div>}
      {state === 'clean' && <div className="git-snapshot-state" role="status"><strong>快照显示无改动</strong><span>已收集执行结束快照，但没有记录到文件变更。</span></div>}
      {state === 'available' && <div className="git-summary">
        <span className="git-summary-files">{fileCount ? `${fileCount} 个文件有改动` : '已记录 Git 改动'}</span>
        <span className="badge">执行快照</span>
        {(adds > 0 || dels > 0) && <span className="git-summary-counts"><span className="edit-added">+{adds}</span><span className="edit-deleted">-{dels}</span></span>}
        {binaries > 0 && <span className="mini dim">{binaries} 个二进制</span>}
        {task.integration?.branch && <span className="meta-chip mono" title={`集成分支 ${task.integration.branch}`}>⎇ {task.integration.branch.replace('agentdeck/task-', '#')}</span>}
        <button type="button" className="btn detail-btn-ghost git-copy" disabled={!task.gitDiff?.trim()} onClick={() => void copyDiff()}><Copy size={12} aria-hidden="true" /> 复制 diff</button>
      </div>}
      {task.gitStat?.trim() && <details className="git-stat-wrap" open><summary>git stat</summary><pre className="git-stat">{task.gitStat}</pre></details>}
      {state === 'available' && task.status === 'running' && <div className="mini dim" role="status">本轮仍在执行，当前显示已记录的快照。</div>}
      {task.gitDiff?.trim() ? <DiffView diff={task.gitDiff} /> : state === 'available' ? <div className="list-empty">已记录 Git 变更，但没有可展开的 diff</div> : null}
    </div>
  )
}
