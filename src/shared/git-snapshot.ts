import type { Task, TaskGitSnapshot } from './types'

type SnapshotTask = Pick<Task, 'runId' | 'phaseIndex' | 'startedAt' | 'gitSnapshot'>

/** Only provenance tied to this execution may certify its Git state. */
export function currentGitSnapshot(task: SnapshotTask): TaskGitSnapshot | undefined {
  const snapshot = task.gitSnapshot
  const hasIdentity = (typeof task.runId === 'string' && task.runId.trim().length > 0)
    || (typeof task.startedAt === 'number' && Number.isFinite(task.startedAt) && task.startedAt > 0)
  if (!snapshot || !hasIdentity || !Number.isFinite(snapshot.capturedAt) || snapshot.capturedAt <= 0) return undefined
  if (snapshot.runId !== task.runId || snapshot.phaseIndex !== task.phaseIndex || snapshot.startedAt !== task.startedAt) return undefined
  return snapshot
}

/** Counts, exports and automatic acceptance must not consume legacy/stale data. */
export function currentGitChanges(task: SnapshotTask & Pick<Task, 'gitDiff' | 'gitStat'>):
  { snapshot: TaskGitSnapshot; diff: string; stat: string } | undefined {
  const snapshot = currentGitSnapshot(task)
  if (snapshot?.state !== 'available') return undefined
  return { snapshot, diff: task.gitDiff ?? '', stat: task.gitStat ?? '' }
}
