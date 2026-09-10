// Focused Stage 5 Goal Controller guard smoke.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-goal-guards-'))
const bundle = path.join(outDir, 'goal-controller.cjs')
const storeBundle = path.join(outDir, 'goal-store.cjs')
await build({ entryPoints: [path.join(root, 'src/main/goal-controller.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
await build({ entryPoints: [path.join(root, 'src/main/goal-store.ts')], outfile: storeBundle, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
const { GoalController, DEFAULT_BLOCK_CAP, DEFAULT_NO_PROGRESS_CAP, DEFAULT_MAX_RETRY_ATTEMPTS, MAX_PHASE_EXECUTIONS, DOOM_LOOP_THRESHOLD, detectDoomLoop, explainGoalBudget, progressKeyForOutput } = await import(pathToFileURL(bundle).href)
const { GoalStore } = await import(pathToFileURL(storeBundle).href)

let failed = 0
const ok = (condition, label) => {
  console.log(`  ${condition ? 'OK' : 'FAIL'} ${label}`)
  if (!condition) failed++
}

ok(DEFAULT_BLOCK_CAP === 8, 'default checker block cap is 8')
ok(DEFAULT_NO_PROGRESS_CAP === 2, 'default no-progress cap is 2')
ok(DEFAULT_MAX_RETRY_ATTEMPTS === 2 && MAX_PHASE_EXECUTIONS === 3, 'retry attempts explain three max executions per phase')
ok(progressKeyForOutput('same output') === progressKeyForOutput('same output'), 'progressKey is deterministic')
ok(progressKeyForOutput('same output') !== progressKeyForOutput('different output'), 'progressKey changes with visible output')
ok(detectDoomLoop([
  { toolName: 'shell', input: { command: 'pwd' } },
  { toolName: 'shell', input: { command: 'pwd' } },
  { toolName: 'shell', input: { command: 'pwd' } }
]), 'same tool and args trip doom-loop threshold')
ok(!detectDoomLoop([
  { toolName: 'shell', input: { command: 'pwd' } },
  { toolName: 'shell', input: { command: 'pwd' } },
  { toolName: 'shell', input: { command: 'ls' } }
]), 'different tool args do not trip doom-loop')
ok(DOOM_LOOP_THRESHOLD === 3, 'doom-loop threshold is three calls')

const out = path.join(outDir, 'data')
const tasks = []
const controller = new GoalController(new GoalStore(out), {
  createTask: (input) => {
    const task = { id: `task_${tasks.length + 1}`, ...input, status: 'queued', createdAt: Date.now(), eventCount: 0, sessionId: 'session_1' }
    tasks.push(task)
    return task
  },
  listTasks: () => tasks,
  continueTask: () => ({ ok: true })
})

const noProgressGoal = controller.create({ text: 'No progress', issueId: 'issue_no_progress', completionConditions: ['done'], stopConditions: [], maxRuns: 20, maxDurationMs: 100000, blockCap: 20, workdir: out, startNow: true })
const noProgressTask = tasks.at(-1)
for (let round = 0; round < 3; round++) {
  noProgressTask.status = 'done'
  noProgressTask.runId = `run_np_${round}`
  noProgressTask.phaseIndex = round
  noProgressTask.startedAt = noProgressTask.createdAt + round * 100
  noProgressTask.endedAt = noProgressTask.startedAt + 10
  noProgressTask.result = 'unchanged output'
  controller.onTaskChanged(noProgressTask)
}
const np = controller.get(noProgressGoal.id)
ok(np?.noProgress === 2 && np.progressKey === progressKeyForOutput('unchanged output'), 'only repeated visible output increments noProgress')
ok(np?.status === 'waiting_user' && np.stopReason === 'no_progress', 'no-progress cap creates a human-visible stop')
noProgressTask.runId = 'run_np_changed'
noProgressTask.phaseIndex = 3
noProgressTask.result = 'new evidence'
controller.onTaskChanged(noProgressTask)
ok(controller.get(noProgressGoal.id)?.noProgress === 0, 'changed visible output resets noProgress')

const blockGoal = controller.create({ text: 'Block cap', issueId: 'issue_block_cap', completionConditions: ['never'], stopConditions: [], maxRuns: 20, maxDurationMs: 100000, blockCap: 2, workdir: out, startNow: true })
const blockTask = tasks.at(-1)
for (let round = 0; round < 2; round++) {
  blockTask.status = 'done'
  blockTask.runId = `run_block_${round}`
  blockTask.phaseIndex = round
  blockTask.startedAt = blockTask.createdAt + round * 100
  blockTask.endedAt = blockTask.startedAt + 10
  blockTask.result = `evidence ${round}`
  controller.onTaskChanged(blockTask)
}
ok(controller.get(blockGoal.id)?.status === 'waiting_user' && controller.get(blockGoal.id)?.stopReason === 'block_cap', 'blockCap moves Goal to human-visible waiting_user')

const deferGoal = controller.create({ text: 'Defer', issueId: 'issue_defer', completionConditions: ['done'], stopConditions: [], maxRuns: 4, maxDurationMs: 100000, workdir: out, startNow: true })
const deferTask = tasks.at(-1)
deferTask.status = 'done'
deferTask.runId = 'run_defer'
deferTask.result = JSON.stringify({ summary: 'done', completedConditions: ['done'], incompleteConditions: [], nextPlan: '', blockers: ['background_running'] })
controller.onTaskChanged(deferTask)
const deferred = controller.get(deferGoal.id)
ok(deferred?.status === 'active' && deferred.stopReason === 'defer', 'background_running defers completion')

const doomGoal = controller.create({ text: 'Doom', issueId: 'issue_doom', completionConditions: ['done'], stopConditions: [], maxRuns: 4, maxDurationMs: 100000, workdir: out, startNow: true })
const doomTask = tasks.at(-1)
controller.onTaskEvent(doomTask.id, { kind: 'tool', data: { name: 'shell', args: { command: 'pwd' } } })
controller.onTaskEvent(doomTask.id, { kind: 'tool', data: { name: 'shell', args: { command: 'pwd' } } })
const doom = controller.onTaskEvent(doomTask.id, { kind: 'tool', data: { name: 'shell', args: { command: 'pwd' } } })
ok(doom.doomLoop && controller.get(doomGoal.id)?.status === 'waiting_user' && controller.get(doomGoal.id)?.stopReason === 'doom_loop', 'doom-loop enters human approval boundary')

const budget = explainGoalBudget({ runCount: 2, maxRuns: 5, failures: 1 }, { attempt: 1 })
ok(budget.phaseExecutions === 2 && budget.maxPhaseExecutions === 3 && budget.goalFailures === 1 && budget.maxGoalFailures === 2, 'retry and Goal failure budgets have one explanation')

fs.rmSync(outDir, { recursive: true, force: true })
if (failed) process.exitCode = 1
else console.log('\nGOAL GUARDS SMOKE PASSED')
