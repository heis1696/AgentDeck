import { History } from 'lucide-react'
import { fmtDuration, fmtTokens } from '../../api'
import type { Run } from '../../../../shared/types'

export function RunHistory({ runs }: { runs: Run[] }) {
  return (
    <>
      <div className="prop-group-label"><History size={13} /> 执行记录 {runs.length ? `(${runs.length})` : ''}</div>
      <div className="run-history">
        {runs.length === 0 && <span className="mini dim">暂无执行记录</span>}
        {runs.map((run) => (
          <div className="run-history-row" key={run.id}>
            <span className={`dot dot-${run.status === 'completed' ? 'done' : run.status === 'running' ? 'running' : run.status === 'error' ? 'failed' : 'cancelled'}`} />
            <span className="run-history-main"><b>{run.status === 'completed' ? '已完成' : run.status === 'running' ? '执行中' : run.status === 'error' ? '失败' : '已取消'}</b>{run.trigger === 'handoff' && <span className="badge badge-handoff">⇥ 接力</span>}<small>{run.startedAt ? new Date(run.startedAt).toLocaleString() : '排队中'}{run.durationMs ? ` · ${fmtDuration(run.durationMs)}` : ''}</small></span>
            {run.usage && <span className="mini mono">{fmtTokens(run.usage.inputTokens + run.usage.outputTokens)}</span>}
          </div>
        ))}
      </div>
    </>
  )
}
