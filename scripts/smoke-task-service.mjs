// Stage 2 smoke: exercise the application creation boundary independently
// from Electron. The same service is used by user, delegate, Goal and handoff
// paths; the checks below focus on metadata, projection and replay behavior.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-task-service-bundles-'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sources = [
  ['src/main/task-service.ts', 'service.cjs'],
  ['src/main/store.ts', 'store.cjs'],
  ['src/main/issue-store.ts', 'issues.cjs'],
  ['src/main/runner.ts', 'runner.cjs'],
  ['src/main/goal-controller.ts', 'goal-controller.cjs'],
  ['src/main/goal-store.ts', 'goal-store.cjs']
]

try {
  for (const [source, output] of sources) {
    await build({
      entryPoints: [path.join(root, source)],
      outfile: path.join(bundleDir, output),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node18',
      external: ['electron']
    })
  }
  const load = (name) => import(pathToFileURL(path.join(bundleDir, name)).href)
  const [{ TaskService }, { TaskStore }, { IssueStore }, { TaskRunner }, { GoalController }, { GoalStore }] = await Promise.all([
    load('service.cjs'), load('store.cjs'), load('issues.cjs'), load('runner.cjs'), load('goal-controller.cjs'), load('goal-store.cjs')
  ])

  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-task-service-data-'))
  let failed = 0
  const check = (condition, label) => {
    console.log(`  ${condition ? 'OK' : 'FAIL'} ${label}`)
    if (!condition) failed++
  }

  try {
    const store = new TaskStore(data)
    const issueStore = new IssueStore(data)
    const service = new TaskService({ store, issueStore })

    const user = service.create({ title: ' user ', prompt: ' work ', workdir: '' })
    check(user.issueId === `iss_${user.id}`, 'user creation assigns a stable Issue id')
    check(issueStore.get(user.issueId)?.taskId === user.id, 'user creation immediately projects an Issue')
    const runOnly = service.create({ title: 'run only', prompt: 'background', workdir: '', suppressIssue: true })
    check(!runOnly.issueId && !issueStore.get(`iss_${runOnly.id}`), 'suppressIssue stays out of the Issue projection')

    const team = [
      { id: 'lead', name: 'Lead', backend: 'fake', subordinates: ['worker'] },
      { id: 'worker', name: 'Worker', backend: 'fake' }
    ]
    const runner = new TaskRunner(store, new Map(), () => ({ concurrency: 2, workerConcurrency: 2, mode: 'yolo', notify: false }), () => {}, { send: () => {} })
    runner.attachTeam(() => team)
    runner.attachTaskService((input) => service.create(input, 'assignment'))
    const leader = service.create({ title: 'leader', prompt: 'delegate', workdir: '', backend: 'fake', agentId: 'lead' })
    const child = await runner.spawnDelegateChild(leader.id, { to: 'Worker', prompt: 'inspect file', reason: 'parallel' })
    check(!!child?.issueId && issueStore.get(child.issueId)?.createdBy === 'agent', 'delegate child uses the service and receives an Issue projection')
    await runner.shutdown()

    const goals = new GoalStore(data)
    let controller
    const controllerTasks = () => store.list()
    controller = new GoalController(goals, {
      createTask: (input) => service.create(input, input.trigger),
      enqueueTask: () => {},
      startTask: (task) => { store.update(task.id, { parked: undefined }); return store.get(task.id) },
      listTasks: controllerTasks,
      cancelTask: () => ({ ok: true }),
      continueTask: () => ({ ok: true }),
      finalizeIssue: () => {}
    })
    const goal = controller.create({
      text: 'two phase', issueId: 'iss_goal_service', completionConditions: ['done'], stopConditions: [],
      maxRuns: 3, maxDurationMs: 60_000, workdir: '', startNow: false
    })
    const phase0 = store.list().find((task) => task.goalId === goal.id)
    check(phase0?.goalId === goal.id && phase0.phaseIndex === 0, 'Goal launchNext uses the unified service with phase metadata')
    store.update(phase0.id, { status: 'running', runId: `run_${phase0.id}`, startedAt: Date.now() })
    controller.onTaskChanged(store.get(phase0.id))
    const handoff = service.createHandoffTask({ sourceTaskId: phase0.id, issueId: goal.issueId, brief: 'phase two', start: 'parked' })
    check(handoff?.goalId === goal.id && handoff.phaseIndex === 1 && handoff.trigger === 'handoff', 'handoff inherits Goal and increments phaseIndex')
    controller.onTaskChanged(handoff)
    store.update(phase0.id, { status: 'done', endedAt: Date.now(), result: 'not done yet' })
    controller.onTaskChanged(store.get(phase0.id))
    check(goals.runs(goal.id).some((run) => run.taskId === phase0.id), 'source phase enters GoalRun projection')
    store.update(handoff.id, { status: 'running', runId: `run_${handoff.id}`, startedAt: Date.now() })
    controller.onTaskChanged(store.get(handoff.id))
    store.update(handoff.id, { status: 'done', endedAt: Date.now(), result: JSON.stringify({ summary: 'done', completedConditions: ['done'], incompleteConditions: [], nextPlan: '', blockers: [] }) })
    controller.onTaskChanged(store.get(handoff.id))
    check(goals.runs(goal.id).some((run) => run.taskId === handoff.id && run.phaseIndex === 1), 'handoff enters GoalRun projection')
    check(controller.get(goal.id)?.status === 'completed', 'linked handoff can complete the Goal')

    const key = `goal_${goal.id}:phase_replay`
    const first = service.create({ title: 'replay', prompt: 'replay', workdir: '', issueId: goal.issueId, goalId: goal.id, phaseIndex: 2, dedupeKey: key })
    const issueCount = issueStore.list().length
    const second = service.create({ title: 'replay', prompt: 'replay', workdir: '', issueId: goal.issueId, goalId: goal.id, phaseIndex: 2, dedupeKey: key })
    check(first.id === second.id && service.deduped(key)?.id === first.id, 'replayed dedupeKey returns the original Task')
    check(issueStore.list().length === issueCount, 'dedupe replay adds no Issue or notification projection')
    const reloaded = new TaskStore(data).get(handoff.id)
    check(reloaded?.goalId === goal.id && reloaded.phaseIndex === 1 && reloaded.continuesFrom === phase0.id, 'tasks.json reload preserves handoff metadata')
    // Runner notes append asynchronously flushed snapshots; drain them before
    // removing the temporary directory so no timer can write after cleanup.
    store.flush()
    await sleep(40)
  } finally {
    fs.rmSync(data, { recursive: true, force: true })
  }
  if (failed) process.exitCode = 1
  else console.log('\nTASK SERVICE SMOKE PASSED')
} finally {
  fs.rmSync(bundleDir, { recursive: true, force: true })
}
