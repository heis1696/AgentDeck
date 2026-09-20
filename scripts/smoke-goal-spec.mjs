// Focused Loop 4 goal spec-evolution smoke: snapshots / evolve / rollback end to end.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-goal-spec-'))
const bundle = async (entry, name) => {
  const outfile = path.join(outDir, name)
  await build({ entryPoints: [path.join(root, entry)], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
  return pathToFileURL(outfile).href
}
const { GoalController } = await import(await bundle('src/main/goal-controller.ts', 'goal-controller.cjs'))
const { GoalStore } = await import(await bundle('src/main/goal-store.ts', 'goal-store.cjs'))
const { parseGoalEvolve } = await import(await bundle('src/main/ipc-validation.ts', 'ipc-validation.cjs'))
const { verifyAcceptance } = await import(await bundle('src/main/acceptance-verifier.ts', 'acceptance-verifier.cjs'))

let failed = 0
const ok = (condition, label) => {
  console.log(`  ${condition ? 'OK' : 'FAIL'} ${label}`)
  if (!condition) failed++
}
const verifierFixtureGoal = { workdir: root, acceptanceCriteria: [{ id: 'file', text: 'file exists: package.json', status: 'pending' }, { id: 'natural', text: 'release is excellent', status: 'pending' }] }
const verifierEvidence = verifyAcceptance(verifierFixtureGoal, { workdir: root, gitDiff: '' })
ok(verifierEvidence?.find((item) => item.criterionId === 'file')?.passed === true && verifierEvidence?.find((item) => item.criterionId === 'natural')?.passed === false, 'host verifier checks explicit machine rules and fails closed for natural language')

// diff 验收证据必须绑定「当前执行 + available 快照」：其他 Run / 其他阶段 / 无来源旧数据
// 以及失败、取消后残留的 diff 都不能认证本轮。
const acceptanceGoal = { workdir: root, acceptanceCriteria: [{ id: 'diff', text: 'git diff contains: hello', status: 'pending' }] }
const acceptanceTask = {
  id: 'task_acceptance', status: 'done', workdir: root, runId: 'run_accept_1', phaseIndex: 1, startedAt: 1000,
  gitDiff: 'diff --git a/x.txt b/x.txt\n+hello\n', gitStat: ' x.txt | 1 +',
  gitSnapshot: { scope: 'workspace', state: 'available', capturedAt: Date.now(), runId: 'run_accept_1', phaseIndex: 1, startedAt: 1000 }
}
const acceptDiff = (patch) => verifyAcceptance(acceptanceGoal, { ...acceptanceTask, ...patch })[0]
ok(acceptDiff({}).passed === true, 'diff criterion passes on the current run available snapshot')
for (const [label, patch] of [
  ['another runId', { runId: 'run_accept_2' }],
  ['another phaseIndex', { phaseIndex: 2 }],
  ['another startedAt', { startedAt: 1001 }],
  ['legacy diff without provenance', { gitSnapshot: undefined }],
  ['clean snapshot', { gitSnapshot: { ...acceptanceTask.gitSnapshot, state: 'clean' } }],
  ['failed run after a follow-up run', { status: 'failed', runId: 'run_accept_3', startedAt: 2000 }],
  ['cancelled run with an earlier snapshot', { status: 'cancelled', runId: 'run_accept_4', startedAt: 3000 }]
]) {
  ok(acceptDiff(patch).passed === false, `diff criterion rejects ${label}`)
}
ok(acceptDiff({ gitSnapshot: undefined }).evidence.includes('no available Git snapshot'), 'rejected stale diff explains the missing provenance')

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-goal-spec-data-'))
const tasks = []
const goalStore = new GoalStore(userData)
const controller = new GoalController(goalStore, {
  createTask: (input) => {
    const task = { id: `task_${tasks.length + 1}`, ...input, status: 'queued', createdAt: Date.now(), eventCount: 0, sessionId: 'session_1' }
    tasks.push(task)
    return task
  },
  listTasks: () => tasks,
  continueTask: () => ({ ok: true })
})
const ambiguousCreate = controller.create({
  text: 'Ambiguous launch', issueId: 'issue_spec_ambiguous', completionConditions: ['done'], stopConditions: [],
  maxRuns: 2, maxDurationMs: 10_000, workdir: root, startNow: true, ambiguityScore: 0.9
})
ok(ambiguousCreate.status === 'waiting_user' && tasks.length === 0 && ambiguousCreate.stopReason === 'ambiguity', 'creation ambiguity gate blocks execution before Task launch')
const goal = controller.create({
  text: 'Ship the release',
  issueId: 'issue_spec_1',
  completionConditions: ['CI green', 'installer built'],
  acceptanceCriteria: ['AC1 installer exists', 'AC2 smoke passes'],
  stopConditions: ['repo deleted'],
  maxRuns: 5,
  maxDurationMs: 60 * 60 * 1000,
  workdir: root,
  startNow: false
})

// 初始快照：generation 1，验收标准已一等公民化
const initial = controller.snapshots(goal.id)
ok(initial.length === 1 && initial[0].generation === 1 && initial[0].decision === 'initial', 'create records the initial spec snapshot at generation 1')
ok(initial[0].acceptanceCriteria.length === 2 && initial[0].acceptanceCriteria[0].id === 'ac_0' && initial[0].acceptanceCriteria[0].text === 'AC1 installer exists', 'acceptance criteria are stored as first-class records')
ok(tasks[0].prompt.includes('AC1 installer exists') && tasks[0].prompt.includes('AC2 smoke passes'), 'first-class acceptance criteria are injected into the execution prompt')

// 无补丁 / 未批准 → 拒绝且无副作用
ok(controller.evolve(goal.id, {}).ok === false, 'evolve without patch is rejected')
ok(controller.evolve(goal.id, { patch: { criteria: [], provenance: { source: 'user', rationale: 'test' } } }).ok === false, 'evolve without approval is rejected')
ok(controller.snapshots(goal.id).length === 1, 'rejected evolve leaves no snapshot')
ok(controller.decisions(goal.id).some((decision) => decision.decision === 'rejected'), 'rejected evolve is durably replayable')

goalStore.addCheckpoint({ goalId: goal.id, runId: 'run_spec_1', phaseIndex: 0, summary: 'generation evidence', completedConditions: [], incompleteConditions: ['AC1 installer exists'], nextPlan: 'refine the spec', blockers: [] })

// 应用补丁：改文本 + 修订 ac_0 + 保留 ac_1 + 新增标准
const evolved = controller.evolve(goal.id, {
  approve: true,
  outcomeGatePassed: true,
  approvalSnapshot: controller.approveEvolution(goal.id, 'user'),
  patch: {
    text: 'Ship the release candidate',
    criteria: [
      { action: 'keep', criterionId: 'ac_1' },
      { action: 'revise', criterionId: 'ac_0', text: 'AC1 signed installer exists' },
      { action: 'add', text: 'AC3 release notes published' }
    ],
    provenance: { source: 'user', rationale: 'scope agreed in review' }
  }
})
ok(evolved.ok === true && evolved.goal?.text === 'Ship the release candidate', 'approved evolve applies the goal text patch')
const revised = evolved.goal?.acceptanceCriteria ?? []
ok(revised.length === 3 && revised[0].text === 'AC1 signed installer exists' && revised[0].status === 'pending', 'revised criterion replaces text and resets to pending')
ok(revised[1].text === 'AC2 smoke passes', 'kept criterion is unchanged')
ok(revised[2].text === 'AC3 release notes published' && revised[2].id.startsWith('ac_'), 'added criterion receives a generated stable id')
ok(evolved.snapshot?.generation === 2 && evolved.snapshot?.decision === 'applied' && evolved.snapshot?.outcomeGatePassed === false, 'applied evolve records a generation-2 snapshot with deterministic gate outcome')
ok(evolved.snapshot?.goalSnapshot?.text === 'Ship the release candidate' && evolved.snapshot?.checkpoint?.summary === 'generation evidence', 'generation snapshot captures goal, spec, and checkpoint together')
ok(controller.decisions(goal.id).some((decision) => decision.decision === 'applied' && decision.generation === 2 && decision.approvalSnapshot?.requestId), 'applied evolve decision carries provenance and approval in the ledger')

// 修订不存在的标准 → 拒绝且无副作用
const criteriaBefore = controller.get(goal.id)?.acceptanceCriteria?.length
const missing = controller.evolve(goal.id, { approve: true, patch: { criteria: [{ action: 'revise', criterionId: 'ac_missing', text: 'x' }], provenance: { source: 'user', rationale: 'r' } } })
ok(missing.ok === false && controller.get(goal.id)?.acceptanceCriteria?.length === criteriaBefore, 'revise of unknown criterion is rejected without side effects')

// 回滚到 generation 1：文本与标准恢复，回滚本身记为 generation 3
const rolled = controller.rollback(goal.id, 1)
ok(rolled.ok === true && rolled.goal?.text === 'Ship the release', 'rollback restores the generation-1 goal text')
ok(rolled.goal?.acceptanceCriteria?.length === 2 && rolled.goal?.acceptanceCriteria?.[0].text === 'AC1 installer exists', 'rollback restores the generation-1 acceptance criteria')
ok(rolled.snapshot?.generation === 3 && rolled.snapshot?.decision === 'rollback', 'rollback appends an immutable rollback record at generation 3')

// 回滚目标非法：不存在 / 非正整数 / 回滚记录本身
ok(controller.rollback(goal.id, 99).ok === false, 'rollback to unknown generation is rejected')
ok(controller.rollback(goal.id, 0).ok === false, 'rollback requires a positive integer generation')
ok(controller.rollback(goal.id, 3).ok === false, 'rollback target cannot itself be a rollback record')
ok(controller.snapshots(goal.id).map((snapshot) => snapshot.generation).join(',') === '1,2,3', 'snapshot history is append-only in generation order')
ok(controller.decisions(goal.id).some((decision) => decision.decision === 'rollback' && decision.generation === 3), 'rollback decision is durably replayable')

// Passed criteria are immutable; ambiguity is a clarification gate.
const passedGoal = controller.create({ text: 'Passed guard', issueId: 'issue_spec_passed', completionConditions: ['x'], acceptanceCriteria: [{ id: 'passed', text: 'immutable evidence' }, { id: 'pending', text: 'still pending' }], stopConditions: [], maxRuns: 2, maxDurationMs: 10000, workdir: root, startNow: false })
passedGoal.acceptanceCriteria[0].status = 'passed'
const revisedPassed = controller.evolve(passedGoal.id, { approve: true, patch: { criteria: [{ action: 'revise', criterionId: 'passed', text: 'weakened' }], provenance: { source: 'test', rationale: 'should reject' } } })
ok(revisedPassed.ok === false && controller.get(passedGoal.id)?.acceptanceCriteria?.[0].text === 'immutable evidence', 'passed acceptance criteria cannot be revised')
const rolledPassed = controller.rollback(passedGoal.id, 1)
ok(rolledPassed.ok === true && rolledPassed.goal?.acceptanceCriteria?.[0].status === 'passed', 'rollback preserves the monotonic PASS status of unchanged criteria')
const beforeAmbiguitySnapshots = controller.snapshots(passedGoal.id).length
const ambiguous = controller.evolve(passedGoal.id, { ambiguityScore: 0.9, approve: true, patch: { criteria: [], provenance: { source: 'test', rationale: 'clarify' } } })
ok(ambiguous.ok === false && (ambiguous.questions?.length ?? 0) > 0 && controller.snapshots(passedGoal.id).length === beforeAmbiguitySnapshots, 'ambiguity gate returns questions without evolving the spec')
const gateGoal = controller.create({ text: 'Already complete', issueId: 'issue_spec_gate', completionConditions: ['done'], stopConditions: [], maxRuns: 2, maxDurationMs: 10000, workdir: root, startNow: false })
gateGoal.acceptanceCriteria[0].status = 'passed'
const gateResult = controller.evolve(gateGoal.id, { outcomeGatePassed: false })
ok(gateResult.ok === true && gateResult.snapshot?.generation === 1, 'outcome gate short-circuits generation-1 evolution ceremony')
const stepResult = controller.evolveStep(gateGoal.id, { outcomeGatePassed: false, approve: true, patch: { criteria: [{ action: 'add', text: 'would spend a generation' }], provenance: { source: 'test', rationale: 'must not run after pass' } } })
ok(stepResult.ok === true && controller.snapshots(gateGoal.id).length === 1 && !(stepResult.goal?.acceptanceCriteria ?? []).some((criterion) => criterion.text === 'would spend a generation'), 'evolveStep gives the result gate priority over generation evolution')
const costGoal = controller.create({ text: 'Cost stop', issueId: 'issue_spec_cost', completionConditions: ['done'], stopConditions: [], maxRuns: 2, maxDurationMs: 10, workdir: root, startNow: false })
costGoal.totalDurationMs = 10
const costStop = controller.evolveStep(costGoal.id, { approve: true, patch: { criteria: [], provenance: { source: 'test', rationale: 'over budget' } } })
ok(costStop.ok === false && costStop.goal?.stopReason === 'duration_budget' && controller.snapshots(costGoal.id).length === 1, 'cost fuse stops evolution before a new generation')
const stagnantGoal = controller.create({ text: 'Stagnation stop', issueId: 'issue_spec_stagnant', completionConditions: ['done'], stopConditions: [], maxRuns: 2, maxDurationMs: 10000, noProgressCap: 2, workdir: root, startNow: false })
stagnantGoal.noProgress = 2
const stagnantStop = controller.evolveStep(stagnantGoal.id, { approve: true, patch: { criteria: [], provenance: { source: 'test', rationale: 'stagnant' } } })
ok(stagnantStop.ok === false && stagnantStop.goal?.stopReason === 'no_progress' && controller.snapshots(stagnantGoal.id).length === 1, 'stagnation fuse stops evolution before a new generation')
const customGateGoal = controller.create({ text: 'Custom gate', issueId: 'issue_spec_custom_gate', completionConditions: ['legacy fallback'], acceptanceCriteria: [{ id: 'custom', text: 'custom result passes' }], stopConditions: [], maxRuns: 2, maxDurationMs: 10000, workdir: root, startNow: false })
const customGateTask = tasks.at(-1)
customGateTask.status = 'done'
customGateTask.runId = 'run_custom_gate'
customGateTask.startedAt = customGateTask.createdAt
customGateTask.endedAt = customGateTask.createdAt + 10
customGateTask.result = JSON.stringify({ summary: 'custom evidence', completedConditions: ['custom result passes'], incompleteConditions: [], nextPlan: '', blockers: [] })
controller.onTaskChanged(customGateTask)
ok(controller.get(customGateGoal.id)?.status === 'completed' && controller.get(customGateGoal.id)?.acceptanceCriteria?.[0].status === 'passed', 'custom acceptance criteria drive checkpoint projection and the result gate')
const customSnapshot = controller.snapshots(customGateGoal.id)[0]
ok(customSnapshot?.generation === 1 && customSnapshot.outcomeGatePassed === true && customSnapshot.goalSnapshot?.status === 'completed' && customSnapshot.checkpoint?.runId === 'run_custom_gate', 'generation-1 snapshot is updated with passing checkpoint evidence for replay')

// A model can claim every condition while a deterministic host verifier rejects the evidence.
const verifierTasks = []
const verifierController = new GoalController(new GoalStore(path.join(outDir, 'goal-verifier-data')), {
  createTask: (input) => {
    const task = { id: `verifier_task_${verifierTasks.length + 1}`, ...input, status: 'queued', createdAt: Date.now(), eventCount: 0 }
    verifierTasks.push(task)
    return task
  },
  listTasks: () => verifierTasks,
  verifyAcceptance: (_goal, _task, _checkpoint) => [{ criterionId: 'artifact', passed: false, evidence: 'host check failed' }]
})
const verifierGoal = verifierController.create({
  text: 'Verifier conflict', issueId: 'issue_spec_verifier_conflict', completionConditions: ['artifact built'],
  acceptanceCriteria: [{ id: 'artifact', text: 'artifact built' }], stopConditions: [], maxRuns: 2,
  maxDurationMs: 10_000, workdir: root, startNow: false
})
const verifierTask = verifierTasks.at(-1)
verifierTask.status = 'done'
verifierTask.runId = 'run_verifier_conflict'
verifierTask.startedAt = verifierTask.createdAt
verifierTask.endedAt = verifierTask.createdAt + 10
verifierTask.result = JSON.stringify({ summary: 'model claims success', completedConditions: ['artifact built'], incompleteConditions: [], nextPlan: '', blockers: [] })
verifierController.onTaskChanged(verifierTask)
const verifierConflict = verifierController.get(verifierGoal.id)
ok(verifierConflict?.status !== 'completed' && verifierConflict?.acceptanceCriteria?.[0].status !== 'passed', 'deterministic verifier rejects conflicting model self-report (fail-closed)')

// 持久化：同目录重开 store，快照与回滚后的规格均还在
const reopened = new GoalStore(userData)
ok(reopened.snapshots(goal.id).length === 3, 'spec snapshots survive a store reload')
ok(reopened.get(goal.id)?.text === 'Ship the release' && reopened.get(goal.id)?.acceptanceCriteria?.length === 2, 'rolled-back goal spec survives a store reload')
ok(reopened.events(goal.id).some((event) => event.text === 'goal.spec.applied') && reopened.events(goal.id).some((event) => event.text === 'goal.spec.rollback'), 'Goal specification decisions and evidence are replayable from the durable Goal EventLog')

// IPC 边界校验
ok(parseGoalEvolve({}).patch === undefined, 'parseGoalEvolve tolerates a probe call without patch')
let threw = false
try { parseGoalEvolve({ patch: { criteria: [], provenance: { source: 's' } } }) } catch { threw = true }
ok(threw, 'parseGoalEvolve rejects patches without rationale')
threw = false
try { parseGoalEvolve({ patch: { criteria: [{ action: 'delete', criterionId: 'ac_0' }], provenance: { source: 's', rationale: 'r' } } }) } catch { threw = true }
ok(threw, 'parseGoalEvolve rejects unknown criterion actions')
threw = false
try { parseGoalEvolve({ unknown: true }) } catch { threw = true }
ok(threw, 'parseGoalEvolve rejects unknown top-level fields')
const parsed = parseGoalEvolve({ approve: true, patch: { text: 't', criteria: [{ action: 'add', text: 'n' }], provenance: { source: 'user', rationale: 'r' } } })
ok(parsed.approve === true && parsed.patch?.criteria[0].action === 'add' && parsed.patch?.provenance.rationale === 'r', 'parseGoalEvolve passes a valid patch through')
const approval = { requestId: 'approval_1', goalId: goal.id, specGeneration: 3, workVersion: controller.snapshots(goal.id).at(-1).id, approvedAt: Date.now(), actor: 'user' }
const parsedApproval = parseGoalEvolve({ approve: true, approvalSnapshot: approval, patch: { criteria: [], provenance: { source: 'user', rationale: 'approved' } } })
ok(parsedApproval.approvalSnapshot?.requestId === 'approval_1' && parsedApproval.approvalSnapshot?.goalId === goal.id, 'parseGoalEvolve preserves the independent approval snapshot')
threw = false
try { parseGoalEvolve({ approvalSnapshot: { ...approval, specGeneration: 0 } }) } catch { threw = true }
ok(threw, 'parseGoalEvolve rejects invalid approval generations')
const noApproval = controller.evolve(goal.id, { approve: true, patch: { criteria: [], provenance: { source: 'user', rationale: 'legacy' } } })
ok(noApproval.ok === true, 'legacy in-process approve=true remains compatible')
const staleApproval = controller.evolve(goal.id, { approve: true, approvalSnapshot: { ...approval, specGeneration: 99 }, patch: { criteria: [], provenance: { source: 'user', rationale: 'stale' } } })
ok(staleApproval.ok === false && controller.decisions(goal.id).some((decision) => decision.reason.includes('stale')), 'stale approval snapshots are rejected and durably recorded')

console.log(failed ? `\n${failed} check(s) failed` : '\nAll goal spec evolution checks passed')
process.exit(failed ? 1 : 0)
