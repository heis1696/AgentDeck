import { DiffView } from '../DiffView'
import type { Task } from '../../../../shared/types'

export function GitSummary({ task }: { task: Task }) {
  return (
    <div className="git-pane">
      {task.gitStat && <pre className="git-stat">{task.gitStat}</pre>}
      {task.gitDiff ? <DiffView diff={task.gitDiff} /> : <div className="list-empty">无改动</div>}
    </div>
  )
}
