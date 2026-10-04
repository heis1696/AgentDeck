import { useEffect, useState } from 'react'
import { FolderOpen, RefreshCw } from 'lucide-react'
import { bridge, workspaceGitSummary, type WorkspaceGitSummary } from '../api'

function truncate(value: string, max: number) {
  return value.length > max ? value.slice(0, max) + '…' : value
}

/**
 * 工作区 git 状态卡（吸收 ZCode 工作区上下文头）：回答「这个目录现在长什么样」——
 * 分支 / 领先落后 / 未提交计数 / 最近提交，让派单前的目录不再是个黑盒名字。
 * 语义：非 git 仓库 = 灰字提示（仍可派单）；探测失败/加载中 = 安静隐藏，不挡派单流程。
 */
export function WorkspaceGitCard({ dir }: { dir: string }) {
  const [summary, setSummary] = useState<WorkspaceGitSummary | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!dir) { setSummary(null); return }
    let alive = true
    setSummary(null)
    workspaceGitSummary(dir)
      .then((result) => { if (alive) setSummary(result) })
      .catch(() => { if (alive) setSummary(null) })
    return () => { alive = false }
  }, [dir, tick])
  if (!summary) return null
  return <WorkspaceGitCardView summary={summary} onRefresh={() => setTick((value) => value + 1)} onOpen={() => void bridge.openPath(dir)} />
}

/** 纯视图层（可 SSR 冒烟）：normal 拿 ok:true 的概览，not-a-repo 灰态，其余失败态不渲染 */
export function WorkspaceGitCardView({ summary, onRefresh, onOpen }: { summary: WorkspaceGitSummary; onRefresh: () => void; onOpen: () => void }) {
  if (!summary.ok) {
    if (summary.code === 'not-a-repo') {
      return <div className="workspace-git-card is-muted" data-code="not-a-repo" role="note">非 git 仓库 · 仍可派单，执行后无改动对比</div>
    }
    return null
  }
  const staged = summary.staged ?? 0
  const unstaged = summary.unstaged ?? 0
  const untracked = summary.untracked ?? 0
  const dirty = staged + unstaged + untracked
  return <div className="workspace-git-card" data-ok>
    <span className="wg-branch mono" title={`分支 ${summary.branch ?? '—'}`}>⎇ {summary.branch ?? '—'}</span>
    {(summary.ahead ?? 0) > 0 && <span className="wg-sync" title={`领先远端 ${summary.ahead} 个提交（未推送）`}>↑ {summary.ahead}</span>}
    {(summary.behind ?? 0) > 0 && <span className="wg-sync is-behind" title={`落后远端 ${summary.behind} 个提交（先拉取再派单更稳）`}>↓ {summary.behind}</span>}
    <span className={dirty ? 'wg-dirty is-dirty' : 'wg-dirty is-clean'} title={`暂存 ${staged} · 未暂存 ${unstaged} · 未跟踪 ${untracked}`}>
      {dirty ? `${dirty} 处未提交` : '工作区干净'}
    </span>
    {summary.lastCommit && (
      <span className="wg-last" title={`${summary.lastCommit.hash} ${summary.lastCommit.subject}`}>
        <span className="mono">{summary.lastCommit.hash}</span> {truncate(summary.lastCommit.subject, 42)} · {summary.lastCommit.when}
      </span>
    )}
    <span className="wg-actions">
      <button type="button" className="icon-btn" onClick={onRefresh} title="刷新工作区状态" aria-label="刷新工作区状态"><RefreshCw size={12} aria-hidden="true" /></button>
      <button type="button" className="icon-btn" onClick={onOpen} title="在资源管理器打开" aria-label="打开工作目录"><FolderOpen size={12} aria-hidden="true" /></button>
    </span>
  </div>
}
