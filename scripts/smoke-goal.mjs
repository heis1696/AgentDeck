import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-goal-smoke-'))
const bundle = path.join(outDir, 'goal-controller.cjs')
const storeBundle = path.join(outDir, 'goal-store.cjs')
const validationBundle = path.join(outDir, 'ipc-validation.cjs')
await build({
  entryPoints: [path.join(root, 'src/main/goal-controller.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18'
})
await build({ entryPoints: [path.join(root, 'src/main/goal-store.ts')], outfile: storeBundle, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
await build({ entryPoints: [path.join(root, 'src/main/ipc-validation.ts')], outfile: validationBundle, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
const { GoalStore } = await import(pathToFileURL(storeBundle).href)
const { GoalController, parseCheckpoint } = await import(pathToFileURL(bundle).href)
const { parseGoalCreate } = await import(pathToFileURL(validationBundle).href)

let failed = 0
const ok = (condition, label) => {
  console.log(`  ${condition ? 'OK' : 'FAIL'} ${label}`)
  if (!condition) failed++
}

const userData = path.join(outDir, 'user-data')
const tasks = []
const queued = []
const controller = new GoalController(new GoalStore(userData), {
  createTask: (input) => {
    const task = {
      id: `task_${tasks.length + 1}`,
      title: input.title,
      prompt: input.prompt,
      workdir: input.workdir,
      backend: input.backend ?? 'zcode',
      agentId: input.agentId,
      trigger: input.trigger,
      issueId: input.issueId,
      goalId: input.goalId,
      phaseIndex: input.phaseIndex,
      status: 'queued',
      createdAt: Date.now() + tasks.length,
      eventCount: 0,
      parked: !input.startNow
    }
    tasks.push(task)
    return task
  },
  enqueueTask: (task) => queued.push(task),
  listTasks: () => tasks
})

const goal = controller.create({
  text: 'Ship the feature',
  completionConditions: ['tests pass', 'docs updated'],
  stopConditions: ['needs approval'],
  maxRuns: 3,
  maxDurationMs: 60_000,
  workdir: userData,
  startNow: true
})
ok(goal.status === 'active' && tasks.length === 1 && queued.length === 1, 'create starts first goal run')
ok(goal.issueId.startsWith('iss_'), 'goal keeps one Issue relation')

const first = tasks[0]
first.status = 'done'
first.startedAt = first.createdAt
first.endedAt = first.createdAt + 100
first.result = JSON.stringify({ summary: 'Tests pass; docs updated', completedConditions: ['tests pass', 'docs updated'], incompleteConditions: [], nextPlan: '', blockers: [] })
first.usage = { durationMs: 100, inputTokens: 2, outputTokens: 3, totalTokens: 5 }
const decision = controller.onTaskChanged(first)
ok(decision?.complete === true && controller.get(goal.id)?.status === 'completed', 'completion conditions move goal to completed')
ok(controller.runs(goal.id).length === 1 && controller.checkpoints(goal.id).length === 1, 'terminal run and checkpoint are persisted')

// Duplicate terminal notifications must be idempotent.
controller.onTaskChanged(first)
ok(controller.runs(goal.id).length === 1 && controller.checkpoints(goal.id).length === 1, 'duplicate TaskChanged does not duplicate run/checkpoint')

const paused = controller.create({
  text: 'Prepare release',
  completionConditions: ['release ready'],
  stopConditions: [],
  maxRuns: 2,
  maxDurationMs: 1_000,
  workdir: userData,
  startNow: true
})
const second = tasks.at(-1)
second.status = 'failed'
second.error = 'transient failure'
second.startedAt = second.createdAt
second.endedAt = second.createdAt + 200
controller.onTaskChanged(second)
ok(controller.get(paused.id)?.status === 'failed', 'failed run pauses goal with a reason')
const continued = controller.continue(paused.id)
ok(continued.ok && tasks.length === 3 && queued.length === 3, 'continue creates a new run on the same goal')
ok(tasks.at(-1)?.issueId === paused.issueId && tasks.at(-1)?.phaseIndex === 1, 'continued run reuses Issue and advances phase')
ok(!controller.continue(paused.id).ok, 'active goal cannot be continued twice')
const resumedStore = new GoalStore(userData)
const resumed = new GoalController(resumedStore, { createTask: () => { throw new Error('not expected') }, listTasks: () => tasks })
const recovered = resumed.recover(tasks)
ok(recovered.length === 1 && resumed.get(paused.id)?.status === 'waiting_user', 'restart recovery requires explicit user continuation')
const last = tasks.at(-1)
last.status = 'done'
last.startedAt = last.createdAt
last.endedAt = last.createdAt + 900
last.result = ''
controller.onTaskChanged(last)
ok(controller.get(paused.id)?.status === 'blocked' && controller.checkpoints(paused.id).length === 2, 'run budget exhaustion blocks after the final checkpoint')
ok(controller.checkpoints(paused.id).at(-1)?.summary === 'Run ended without a checkpoint', 'empty terminal result still persists a checkpoint')

ok(parseCheckpoint('{"summary":"ok","completedConditions":["release ready"]}', ['release ready'])?.completedConditions.length === 1, 'checkpoint envelope parser is deterministic')

const parkedTasks = []
const parked = new GoalController(new GoalStore(path.join(outDir, 'parked-data')), {
  createTask: (input) => { const task = { id: `parked_task_${parkedTasks.length + 1}`, title: input.title, prompt: input.prompt, workdir: input.workdir, backend: 'zcode', issueId: input.issueId, goalId: input.goalId, phaseIndex: input.phaseIndex, trigger: input.trigger, status: 'queued', parked: !input.startNow, createdAt: Date.now() + parkedTasks.length, eventCount: 0 }; parkedTasks.push(task); return task },
  startTask: (task) => { delete task.parked; return task },
  enqueueTask: (task) => queued.push(task),
  listTasks: () => parkedTasks
})
const parkedGoal = parked.create({ text: 'Parked goal', completionConditions: ['ready'], stopConditions: [], maxRuns: 1, maxDurationMs: 1_000, workdir: userData, startNow: false })
ok(parkedGoal.status === 'draft', 'create can leave a goal parked')
const parkedStart = parked.start(parkedGoal.id)
ok(parkedStart.ok && parkedTasks.length === 1 && parkedTasks[0].parked === undefined, 'starting a parked goal un-parks the existing run')

const cancelTasks = []
const cancellable = new GoalController(new GoalStore(path.join(outDir, 'cancel-data')), {
  createTask: (input) => { const task = { id: 'cancel_task', title: input.title, prompt: input.prompt, workdir: input.workdir, backend: 'zcode', issueId: input.issueId, goalId: input.goalId, phaseIndex: input.phaseIndex, trigger: input.trigger, status: 'queued', createdAt: Date.now(), eventCount: 0 }; cancelTasks.push(task); return task },
  cancelTask: (id) => { const task = cancelTasks.find((item) => item.id === id); if (task) task.status = 'cancelled'; return { ok: true } },
  listTasks: () => cancelTasks
})
const cancelledGoal = cancellable.create({ text: 'Cancel me', completionConditions: ['done'], stopConditions: [], maxRuns: 1, maxDurationMs: 1_000, workdir: userData, startNow: true })
ok(cancellable.cancel(cancelledGoal.id).ok, 'user can cancel an active goal')
cancelTasks[0].status = 'cancelled'
cancellable.onTaskChanged(cancelTasks[0])
ok(cancellable.get(cancelledGoal.id)?.status === 'cancelled' && cancellable.checkpoints(cancelledGoal.id).length === 1, 'late task cancellation does not resurrect the goal')

const retryGoal = controller.create({ text: 'Retry transient work', completionConditions: ['ready'], stopConditions: [], maxRuns: 1, maxDurationMs: 10_000, workdir: userData, startNow: true })
const retryTask = tasks.at(-1)
retryTask.status = 'failed'
retryTask.attempt = 0
retryTask.failure = { code: 'rate_limit', title: 'Rate limited', hint: 'retry', retryable: true }
retryTask.error = '429'
controller.onTaskChanged(retryTask)
ok(controller.get(retryGoal.id)?.status === 'active' && controller.get(retryGoal.id)?.runCount === 0 && controller.checkpoints(retryGoal.id).length === 0, 'automatic transient retry does not consume a Goal phase budget')
retryTask.attempt = 2
controller.onTaskChanged(retryTask)
ok(controller.get(retryGoal.id)?.status === 'failed' && controller.checkpoints(retryGoal.id).length === 1, 'exhausted retry becomes a failed Goal checkpoint')

const futureDir = path.join(outDir, 'future-data')
fs.mkdirSync(path.join(futureDir, 'goals'), { recursive: true })
fs.writeFileSync(path.join(futureDir, 'goals', 'index.json'), JSON.stringify({ schemaVersion: 99, goals: [], runs: [], checkpoints: [] }))
let rejectedFuture = false
try { new GoalStore(futureDir) } catch { rejectedFuture = true }
ok(rejectedFuture, 'future goal schema is rejected instead of silently resetting data')
let rejectedInput = false
try { parseGoalCreate({ text: 'unsafe', completionConditions: ['done'], stopConditions: [], maxRuns: 0, maxDurationMs: 1, workdir: '' }) } catch { rejectedInput = true }
ok(rejectedInput, 'goal IPC rejects an exhausted run budget at the boundary')

fs.rmSync(outDir, { recursive: true, force: true })
if (failed) process.exitCode = 1
else console.log('\nGOAL SMOKE PASSED')
