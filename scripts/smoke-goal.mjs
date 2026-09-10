// smoke-goal.mjs：目标模式 v2 冒烟
// 按 docs/GOAL-AUTOPILOT-REDESIGN.md §6 重写
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
let finalizeCalls = []
let continueCalls = []
let cancelCalls = []

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
  listTasks: () => tasks,
  continueTask: (taskId, content) => { continueCalls.push({ taskId, content }); return Promise.resolve({ ok: true }) },
  cancelTask: (taskId) => { cancelCalls.push(taskId); const t = tasks.find((x) => x.id === taskId); if (t) t.status = 'cancelled'; return { ok: true } },
  finalizeIssue: (issueId) => { finalizeCalls.push(issueId) }
})

// === 场景 1：Issue 收养（无 Task 建单 / 有 done Task 续聊不新建）===
const issue1 = 'iss_adopt_test_1'
const adopt1 = controller.create({
  text: 'Ship the feature',
  issueId: issue1,
  completionConditions: ['tests pass'],
  stopConditions: [],
  maxRuns: 3,
  maxDurationMs: 60_000,
  workdir: userData,
  startNow: true
})
ok(adopt1.issueId === issue1 && tasks.length === 1, 'create no existing Task: build first Task')
ok(adopt1.status === 'active' && queued.length === 1, 'create start immediately if startNow')

// 有 done Task：收养不新建
const issue2 = 'iss_adopt_test_2'
const doneTask = {
  id: 'task_existing',
  title: 'Existing',
  prompt: 'orig',
  issueId: issue2,
  status: 'done',
  createdAt: Date.now(),
  sessionId: 'sess_1',
  eventCount: 0
}
tasks.push(doneTask)
const adopt2 = controller.create({
  text: 'Continue work',
  issueId: issue2,
  completionConditions: ['ready'],
  stopConditions: [],
  maxRuns: 2,
  maxDurationMs: 10_000,
  workdir: userData,
  startNow: true
})
ok(adopt2.issueId === issue2 && tasks.filter((t) => t.issueId === issue2).length === 1, 'create with existing done Task: adopt not build')
await new Promise((r) => setTimeout(r, 50))
ok(continueCalls.some((c) => c.taskId === 'task_existing'), 'create startNow on done Task triggers continueTask')

// === 场景 2：envelope 完成判定 + finalizeIssue 调用 ===
const issue3 = 'iss_complete_test'
const compGoal = controller.create({
  text: 'Complete test',
  issueId: issue3,
  completionConditions: ['code done', 'docs done'],
  stopConditions: [],
  maxRuns: 2,
  maxDurationMs: 10_000,
  workdir: userData,
  startNow: false
})
const compTask = tasks.at(-1)
compTask.status = 'done'
compTask.startedAt = compTask.createdAt
compTask.endedAt = compTask.createdAt + 100
compTask.result = JSON.stringify({ summary: 'All done', completedConditions: ['code done', 'docs done'], incompleteConditions: [], nextPlan: '', blockers: [] })
compTask.usage = { durationMs: 100, inputTokens: 2, outputTokens: 3, totalTokens: 5 }
controller.onTaskChanged(compTask)
ok(controller.get(compGoal.id)?.status === 'completed', 'envelope all conditions met → completed')
ok(finalizeCalls.includes(issue3), 'completed goal calls finalizeIssue')

// === 场景 3：预算耗尽 blocked ===
const issue4 = 'iss_budget_test'
const budgetGoal = controller.create({
  text: 'Budget test',
  issueId: issue4,
  completionConditions: ['never'],
  stopConditions: [],
  maxRuns: 1,
  maxDurationMs: 10_000,
  workdir: userData,
  startNow: true
})
const budgetTask = tasks.at(-1)
budgetTask.status = 'done'
budgetTask.startedAt = budgetTask.createdAt
budgetTask.endedAt = budgetTask.createdAt + 100
budgetTask.result = ''
controller.onTaskChanged(budgetTask)
ok(controller.get(budgetGoal.id)?.status === 'blocked' && controller.get(budgetGoal.id)?.blockedReason?.includes('budget'), 'runCount exhausted → blocked')

// === 场景 4：非重试失败自动续轮（failures 上限 2）===
const issue5 = 'iss_fail_test'
const failGoal = controller.create({
  text: 'Fail test',
  issueId: issue5,
  completionConditions: ['goal'],
  stopConditions: [],
  maxRuns: 5,
  maxDurationMs: 100_000,
  workdir: userData,
  startNow: true
})
const failTask = tasks.at(-1)
failTask.issueId = issue5
failTask.sessionId = 'sess_fail_1'
failTask.status = 'failed'
failTask.error = 'oops'
failTask.failure = { code: 'unknown', title: 'Unknown', hint: '', retryable: false }
failTask.startedAt = failTask.createdAt
failTask.endedAt = failTask.createdAt + 100
controller.onTaskChanged(failTask)
ok(controller.get(failGoal.id)?.failures === 1 && controller.get(failGoal.id)?.status === 'active', 'first non-retry failure → failures=1, auto-continue')
await new Promise((r) => setTimeout(r, 100))
const failContent = continueCalls.find((c) => c.taskId === failTask.id)?.content
ok(failContent && (failContent.includes('失败') || failContent.includes('自动续轮')), 'auto-continue sends feedbackContext')
// 第二次失败（续轮同任务，但 runId 不同以表示新的执行）
failTask.runId = 'run_fail_2'
failTask.status = 'failed'
failTask.error = 'oops again'
failTask.failure = { code: 'unknown', title: 'Unknown', hint: '', retryable: false }
failTask.startedAt = failTask.createdAt + 200
failTask.endedAt = failTask.createdAt + 300
controller.onTaskChanged(failTask)
const g = controller.get(failGoal.id)
ok(g?.failures === 2 && g?.status === 'failed', 'second non-retry failure → failed, no auto-continue')

// === 场景 5：stop 条件 waiting_user ===
const issue6 = 'iss_stop_test'
const stopGoal = controller.create({
  text: 'Stop test',
  issueId: issue6,
  completionConditions: ['never'],
  stopConditions: ['user review'],
  maxRuns: 3,
  maxDurationMs: 10_000,
  workdir: userData,
  startNow: true
})
const stopTask = tasks.at(-1)
stopTask.status = 'done'
stopTask.startedAt = stopTask.createdAt
stopTask.endedAt = stopTask.createdAt + 100
stopTask.result = JSON.stringify({ summary: 'Need user review', blockers: ['user review needed'], completedConditions: [], incompleteConditions: ['never'], nextPlan: '' })
controller.onTaskChanged(stopTask)
ok(controller.get(stopGoal.id)?.status === 'waiting_user' && controller.get(stopGoal.id)?.blockedReason?.includes('Stop condition'), 'stop condition → waiting_user')

// === 场景 6：重启恢复 waiting_user ===
// 创建一个 active 状态的目标来测试 recover
const issue6b = 'iss_recover_test'
const recoverGoal = controller.create({
  text: 'Recover test',
  issueId: issue6b,
  completionConditions: ['x'],
  stopConditions: [],
  maxRuns: 2,
  maxDurationMs: 10_000,
  workdir: userData,
  startNow: true
})
const recoverTask = tasks.at(-1)
recoverTask.issueId = issue6b
recoverTask.status = 'running'
// 模拟重启：目标是 active，任务是 running
const resumeStore = new GoalStore(userData)
const resumed = new GoalController(resumeStore, { createTask: () => { throw new Error('not expected') }, listTasks: () => tasks })
const recovered = resumed.recover(tasks)
ok(recovered.some((g) => g.id === recoverGoal.id) && resumed.get(recoverGoal.id)?.status === 'waiting_user', 'recover sets active goal to waiting_user')

// === 场景 7：无 continueTask 时新任务兜底 ===
const issue7 = 'iss_fallback_test'
const fbGoal = controller.create({
  text: 'Fallback test',
  issueId: issue7,
  completionConditions: ['done'],
  stopConditions: [],
  maxRuns: 3,
  maxDurationMs: 10_000,
  workdir: userData,
  startNow: true
})
const fbController = new GoalController(new GoalStore(path.join(outDir, 'fb-data')), {
  createTask: (input) => { const task = { id: 'fb_task', issueId: input.issueId, goalId: input.goalId, phaseIndex: input.phaseIndex, status: 'queued', createdAt: Date.now(), prompt: input.prompt, title: input.title, workdir: input.workdir, eventCount: 0 }; tasks.push(task); return task },
  enqueueTask: () => {},
  listTasks: () => tasks,
  finalizeIssue: () => {}
})
const fbGoal2 = fbController.create({ text: 'No continue', issueId: 'iss_fb2', completionConditions: ['x'], stopConditions: [], maxRuns: 3, maxDurationMs: 10_000, workdir: userData, startNow: true })
const fbTask = tasks.at(-1)
fbTask.status = 'done'
fbTask.startedAt = fbTask.createdAt
fbTask.endedAt = fbTask.createdAt + 100
fbTask.result = ''
const beforeCount = tasks.length
fbController.onTaskChanged(fbTask)
await new Promise((r) => setTimeout(r, 100))
ok(tasks.length > beforeCount, 'no continueTask → launchNext fallback creates new task')

// === 场景 8：envelope 解析单测 ===
ok(parseCheckpoint('{"summary":"ok","completedConditions":["release ready"]}', ['release ready'])?.completedConditions.length === 1, 'checkpoint envelope parser is deterministic')

// === 场景 9：issueId 必填校验 ===
let rejectedInput = false
try { parseGoalCreate({ text: 'test', issueId: '', completionConditions: ['x'], stopConditions: [], maxRuns: 1, maxDurationMs: 1000, workdir: '/' }) } catch { rejectedInput = true }
ok(rejectedInput, 'goal IPC rejects empty issueId')

// === 场景 10：清除目标模式（remove 停在跑任务 + 级联删 runs/checkpoints）===
const issue8 = 'iss_remove_test'
const rmGoal = controller.create({
  text: 'Remove test',
  issueId: issue8,
  completionConditions: ['never'],
  stopConditions: [],
  maxRuns: 5,
  maxDurationMs: 100_000,
  workdir: userData,
  startNow: true
})
const rmTask = tasks.at(-1)
rmTask.status = 'running'
rmTask.sessionId = 'sess_rm_1'
controller.onTaskChanged(rmTask)
rmTask.status = 'done'
rmTask.startedAt = rmTask.createdAt
rmTask.endedAt = rmTask.createdAt + 100
rmTask.result = JSON.stringify({ summary: 'halfway', completedConditions: [], incompleteConditions: ['never'], nextPlan: 'keep going', blockers: [] })
controller.onTaskChanged(rmTask)
await new Promise((r) => setTimeout(r, 100))
ok(controller.get(rmGoal.id)?.status === 'active' && controller.checkpoints(rmGoal.id).length > 0, 'goal active with checkpoint before remove')
const removed = controller.remove(rmGoal.id)
ok(removed.ok && controller.get(rmGoal.id) === null, 'remove deletes the goal')
ok(controller.runs(rmGoal.id).length === 0 && controller.checkpoints(rmGoal.id).length === 0, 'remove cascades runs/checkpoints')
ok(cancelCalls.includes(rmTask.id) && rmTask.status === 'cancelled', 'remove cancels the in-flight task')
ok(!controller.list().some((goal) => goal.id === rmGoal.id), 'goal no longer listed')

fs.rmSync(outDir, { recursive: true, force: true })
if (failed) process.exitCode = 1
else console.log('\n✅ GOAL SMOKE PASSED (v2)')
