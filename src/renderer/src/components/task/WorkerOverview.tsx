import { useState } from 'react'
import { CircleDashed, ExternalLink, Square, Users } from 'lucide-react'
import { fmtDuration } from '../../api'
import { ui } from '../../ui/interaction-center'
import { taskService } from '../../task-service'
import { PARKED_QUEUED_LABEL } from '../../labels'
import type { Task } from '../../../../shared/types'
import type { WorkerRound } from './workerRounds'
import { InterruptDialog } from './InterruptDialog'
import { currentGitChanges } from '../../../../shared/git-snapshot'

export interface WorkerOverviewProps {
  rounds: WorkerRound[]
  now?: number
  onOpen: (id: string) => void
}

function workerState(task: Task, now: number): string {
  if (task.status === 'running') return `执行中 · ${fmtDuration(Math.max(0, now - (task.startedAt ?? now))) || '0s'}`
  if (task.status === 'queued') return task.parked ? PARKED_QUEUED_LABEL : '排队'
  if (task.status === 'cancelled') return '已取消'
  if (task.status === 'failed') return '失败'
  return task.startedAt && task.endedAt ? `完成 · ${fmtDuration(task.endedAt - task.startedAt)}` : '已完成'
}

/** 整行是 div 容器（role=button 键盘可达）：running/queued 行内嵌停止图标按钮——
 *  按钮不能嵌在 button 里（非法 HTML），嵌套点击用 stopPropagation 隔开。 */
function WorkerRow({ task, now, onOpen, onStop }: { task: Task; now: number; onOpen: (id: string) => void; onStop: (task: Task) => void }) {
  const stoppable = task.status === 'running' || task.status === 'queued'
  return <div
    role="button"
    tabIndex={0}
    className={`worker-overview-row worker-card status-${task.status}${task.status === 'cancelled' ? ' is-cancelled' : ''}`}
    data-worker-id={task.id}
    onClick={() => onOpen(task.id)}
    onKeyDown={(e) => {
      // 键盘可达性对齐原 button 语义；嵌套停止按钮的按键不冒泡成「打开」
      if (e.target !== e.currentTarget) return
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(task.id) }
    }}
    title={`${task.title}\n查看执行记录与结果`}
  >
    <span className={`dot dot-${task.status}`} aria-hidden="true" />
    {task.workerIndex != null && <span className="worker-index">#{task.workerIndex}</span>}
    <span className="worker-title">{task.title}</span>
    <span className="worker-state mini">{workerState(task, now)}</span>
    {!!task.attempt && <span className="mini dim">⟳{task.attempt}</span>}
    {currentGitChanges(task) && <span className="mini dim" title="已记录本次执行的 Git 快照">· Git</span>}
    {stoppable && <button
      type="button"
      className="worker-row-stop"
      title="打断该队员任务（可附回执）"
      aria-label={`打断 ${task.title}`}
      onClick={(e) => { e.stopPropagation(); onStop(task) }}
    ><Square size={12} aria-hidden="true" /></button>}
    <ExternalLink size={12} aria-hidden="true" />
  </div>
}

function RoundCounts({ round }: { round: WorkerRound }) {
  const activeCount = round.active.length
  const queuedCount = round.queued.length
  const parkedCount = round.parked.length
  const endedCount = round.ended.length
  return <span className="mini dim">
    {activeCount > 0 && `${activeCount} 执行中`}
    {queuedCount > 0 && `${activeCount ? ' · ' : ''}${queuedCount} 排队`}
    {parkedCount > 0 && `${activeCount || queuedCount ? ' · ' : ''}${parkedCount} ${PARKED_QUEUED_LABEL}`}
    {endedCount > 0 && `${activeCount || queuedCount || parkedCount ? ' · ' : ''}${endedCount} 已结束`}
  </span>
}

/** Compact, floating overview of every child task grouped by leader turn. */
export function WorkerOverview({ rounds, now = Date.now(), onOpen }: WorkerOverviewProps) {
  // 打断入口与 WorkerPane 头部同一套回执对话框：确认后 cancel(id, reason)，失败走既有 toast
  const [interruptTarget, setInterruptTarget] = useState<Task | null>(null)
  const [busy, setBusy] = useState(false)
  const confirmInterrupt = async (reason: string) => {
    if (!interruptTarget) return
    setBusy(true)
    try {
      // 空串也按用户打断提交（主进程记「未填写原因」）；undefined 才是系统取消不打标
      const result = await taskService.cancel(interruptTarget.id, reason.trim() ? reason : '')
      if (!result.ok && result.error) ui.toast.error(result.error)
      else if (result.warning) ui.toast.error(result.warning)
    } catch (e) {
      ui.toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      setInterruptTarget(null)
    }
  }
  const total = rounds.reduce((count, round) => count + round.workers.length, 0)
  const openRow = (task: Task) => <WorkerRow key={task.id} task={task} now={now} onOpen={onOpen} onStop={setInterruptTarget} />
  return <div id="worker-overview" className="worker-overview" data-testid="worker-overview" aria-label="队员概览">
    <div className="worker-overview-summary"><Users size={13} aria-hidden="true" /><strong>{total} 个队员任务</strong><span className="mini dim">{rounds.length} 组</span></div>
    {rounds.map((round, index) => <section key={round.id} className={`worker-round${round.unclassified ? ' is-unclassified' : ''}`} data-round-key={round.id}>
      <header className="worker-round-head">
        <strong>{round.label}</strong>
        <RoundCounts round={round} />
      </header>
      {(round.active.length > 0 || round.queued.length > 0 || round.parked.length > 0) && <div className="worker-round-active" aria-label="进行中的队员">
        <div className="worker-group-label">执行与等待</div>
        {round.active.map(openRow)}
        {round.queued.map(openRow)}
        {round.parked.map(openRow)}
      </div>}
      {round.ended.length > 0 && <details className="worker-round-ended" aria-label="已结束的队员" open={index === 0 && round.ended.length === round.workers.length}>
        <summary>已结束队员 <span>{round.ended.length}</span></summary>
        {round.ended.map(openRow)}
      </details>}
    </section>)}
    {rounds.length === 0 && <div className="list-empty" role="status"><CircleDashed size={15} aria-hidden="true" />暂无队员记录</div>}
    {interruptTarget && <InterruptDialog title={interruptTarget.title} busy={busy} onConfirm={(reason) => void confirmInterrupt(reason)} onClose={() => setInterruptTarget(null)} />}
  </div>
}
