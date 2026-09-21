import { pathToFileURL } from 'node:url'

const [dataDir, bundle, ...taskIds] = process.argv.slice(2)
if (!dataDir || !bundle || !taskIds.length) throw new Error('git-operation worker requires data dir, store bundle and task ids')
const { TaskStore } = await import(pathToFileURL(bundle).href)
const store = new TaskStore(dataDir, { recoverRunning: false })
const records = taskIds.map((id) => {
  const task = store.get(id)
  if (!task) throw new Error('missing task ' + id)
  return {
    id,
    expected: {
      status: task.status, runId: task.runId, executionOwner: task.executionOwner,
      attempt: task.attempt, phaseIndex: task.phaseIndex, startedAt: task.startedAt,
      workdir: task.workdir, workVersion: task.workVersion
    }
  }
})
const claim = store.claimGitOperation(records)
if (!claim) throw new Error('could not claim Git operation')
process.stdout.write(JSON.stringify(claim))
