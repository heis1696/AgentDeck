import { useMemo } from 'react'
import { Copy } from 'lucide-react'
import { DiffView, parseDiff } from '../DiffView'
import { ui } from '../../ui/interaction-center'
import type { Task } from '../../../../shared/types'
import { currentGitChanges, currentGitSnapshot } from '../../../../shared/git-snapshot'

type GitSnapshotState = 'executing' | 'unavailable' | 'error' | 'clean' | 'available' | 'historical'

function snapshotState(task: Task, snapshot: ReturnType<typeof currentGitSnapshot>, hasHistorical: boolean): GitSnapshotState {
  if (snapshot) return snapshot.state
  if (task.status === 'running' || task.status === 'queued') return 'executing'
  return hasHistorical ? 'historical' : 'unavailable'
}

/** Git view keeps access available and distinguishes absent snapshots from a recorded clean result. */
export function GitSummary({ task }: { task: Task }) {
  const snapshot = currentGitSnapshot(task)
  const changes = currentGitChanges(task)
  const historicalDiff = changes || task.gitSnapshot ? '' : (task.gitDiff ?? '')
  const historicalStat = changes || task.gitSnapshot ? '' : (task.gitStat ?? '')
  const hasHistorical = Boolean(historicalDiff.trim() || historicalStat.trim())
  const state = snapshotState(task, snapshot, hasHistorical)
  const displayDiff = changes?.diff ?? historicalDiff
  const displayStat = changes?.stat ?? historicalStat
  const historical = !changes && hasHistorical
  const files = useMemo(() => displayDiff ? parseDiff(displayDiff) : [], [displayDiff])
  const adds = files.reduce((sum, file) => sum + file.adds, 0)
  const dels = files.reduce((sum, file) => sum + file.dels, 0)
  const binaries = files.filter((file) => file.binary).length
  const statFiles = displayStat.split('\n').filter((line) => line.includes('|')).length
  const fileCount = files.length || statFiles
  const copyDiff = async () => {
    if (!changes?.diff.trim()) return
    try {
      await navigator.clipboard.writeText(changes.diff)
      ui.toast.success('diff 已复制')
    } catch { ui.toast.error('复制失败') }
  }
  return (
    <div className="git-pane" tabIndex={0} aria-label="Git 改动" data-snapshot-state={state}>
      {state === 'executing' && <div className="git-snapshot-state" role="status"><strong>{task.status === 'queued' ? '等待执行，暂无 Git 快照' : '执行中，尚未收集 Git 快照'}</strong><span>执行结束后会收集可用的仓库变更。</span></div>}
      {state === 'unavailable' && <div className="git-snapshot-state" role="status"><strong>未记录 Git 快照</strong><span>{snapshot?.reason || (task.workdir ? '没有本次执行的有效快照，当前仓库状态未知。' : '此任务未绑定工作目录。')}</span></div>}
      {state === 'error' && <div className="git-snapshot-state" role="alert"><strong>Git 快照采集失败</strong><span>{snapshot?.reason || '无法确定仓库变更状态。'}</span></div>}
      {state === 'clean' && <div className="git-snapshot-state" role="status"><strong>快照显示无改动</strong><span>{snapshot?.scope === 'integration' ? '集成分支与基线没有文件差异。' : '采集时工作区没有未提交或未跟踪的文件变更。'}</span></div>}
      {historical && <div className="git-snapshot-state" role="status"><strong>历史 Git 快照</strong><span>这组改动没有当前执行的有效来源，仅作历史展示，不会计入当前任务摘要或复制内容。</span></div>}
      {(state === 'available' || state === 'historical' || historical) && <div className="git-summary">
        <span className="git-summary-files">{fileCount ? `${fileCount} 个文件有改动` : '已记录 Git 改动'}</span>
        <span className="badge">{historical ? '历史快照' : snapshot?.scope === 'integration' ? '集成分支快照' : '工作区快照'}</span>
        {(adds > 0 || dels > 0) && <span className="git-summary-counts"><span className="edit-added">+{adds}</span><span className="edit-deleted">-{dels}</span></span>}
        {binaries > 0 && <span className="mini dim">{binaries} 个二进制</span>}
        {snapshot?.scope === 'integration' && task.integration?.branch && <span className="meta-chip mono" title={`集成分支 ${task.integration.branch}`}>⎇ {task.integration.branch.replace('agentdeck/task-', '#')}</span>}
        <button type="button" className="btn detail-btn-ghost git-copy" disabled={!changes?.diff.trim()} onClick={() => void copyDiff()}><Copy size={12} aria-hidden="true" /> 复制 diff</button>
      </div>}
      {snapshot && <div className="mini dim">采集于 {new Date(snapshot.capturedAt).toLocaleString()}</div>}
      {historical && !task.gitSnapshot && <div className="mini dim" role="status">历史记录未保存所属执行，无法确认是否来自本轮。</div>}
      {snapshot?.truncated && <div className="git-snapshot-state" role="status">快照超过保存上限，当前仅显示部分内容。</div>}
      {(state === 'available' || state === 'historical' || historical) && displayStat.trim() && <details className="git-stat-wrap" open><summary>git stat</summary><pre className="git-stat">{displayStat}</pre></details>}
      {(state === 'available' || state === 'historical' || historical) && (displayDiff.trim() ? <DiffView diff={displayDiff} /> : <div className="list-empty">已记录 Git 变更，但没有可展开的 diff</div>)}
    </div>
  )
}
