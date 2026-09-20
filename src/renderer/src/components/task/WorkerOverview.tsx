import { CircleDashed, ExternalLink, Users } from 'lucide-react'
import { fmtDuration } from '../../api'
import { PARKED_QUEUED_LABEL } from '../../labels'
import type { Task } from '../../../../shared/types'
import type { WorkerRound } from './workerRounds'
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

function WorkerRow({ task, now, onOpen }: { task: Task; now: number; onOpen: (id: string) => void }) {
  return <button
    type="button"
    className={`worker-overview-row worker-card status-${task.status}${task.status === 'cancelled' ? ' is-cancelled' : ''}`}
    data-worker-id={task.id}
    onClick={() => onOpen(task.id)}
    title={`${task.title}\n查看执行记录与结果`}
  >
    <span className={`dot dot-${task.status}`} aria-hidden="true" />
    {task.workerIndex != null && <span className="worker-index">#{task.workerIndex}</span>}
    <span className="worker-title">{task.title}</span>
    <span className="worker-state mini">{workerState(task, now)}</span>
    {!!task.attempt && <span className="mini dim">⟳{task.attempt}</span>}
    {currentGitChanges(task) && <span className="mini dim" title="已记录本次执行的 Git 快照">· Git</span>}
    <ExternalLink size={12} aria-hidden="true" />
  </button>
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
  const total = rounds.reduce((count, round) => count + round.workers.length, 0)
  return <div id="worker-overview" className="worker-overview" data-testid="worker-overview" aria-label="队员概览">
    <div className="worker-overview-summary"><Users size={13} aria-hidden="true" /><strong>{total} 个队员任务</strong><span className="mini dim">{rounds.length} 组</span></div>
    {rounds.map((round, index) => <section key={round.id} className={`worker-round${round.unclassified ? ' is-unclassified' : ''}`} data-round-key={round.id}>
      <header className="worker-round-head">
        <strong>{round.label}</strong>
        <RoundCounts round={round} />
      </header>
      {(round.active.length > 0 || round.queued.length > 0 || round.parked.length > 0) && <div className="worker-round-active" aria-label="进行中的队员">
        <div className="worker-group-label">执行与等待</div>
        {round.active.map((task) => <WorkerRow key={task.id} task={task} now={now} onOpen={onOpen} />)}
        {round.queued.map((task) => <WorkerRow key={task.id} task={task} now={now} onOpen={onOpen} />)}
        {round.parked.map((task) => <WorkerRow key={task.id} task={task} now={now} onOpen={onOpen} />)}
      </div>}
      {round.ended.length > 0 && <details className="worker-round-ended" aria-label="已结束的队员" open={index === 0 && round.ended.length === round.workers.length}>
        <summary>已结束队员 <span>{round.ended.length}</span></summary>
        {round.ended.map((task) => <WorkerRow key={task.id} task={task} now={now} onOpen={onOpen} />)}
      </details>}
    </section>)}
    {rounds.length === 0 && <div className="list-empty" role="status"><CircleDashed size={15} aria-hidden="true" />暂无队员记录</div>}
  </div>
}
