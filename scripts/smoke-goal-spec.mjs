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

let failed = 0
const ok = (condition, label) => {
  console.log(`  ${condition ? 'OK' : 'FAIL'} ${label}`)
  if (!condition) failed++
}

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-goal-spec-data-'))
const tasks = []
const controller = new GoalController(new GoalStore(userData), {
  createTask: (input) => {
    const task = { id: `task_${tasks.length + 1}`, ...input, status: 'queued', createdAt: Date.now(), eventCount: 0, sessionId: 'session_1' }
    tasks.push(task)
    return task
  },
  listTasks: () => tasks,
  continueTask: () => ({ ok: true })
})
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

// 无补丁 / 未批准 → 拒绝且无副作用
ok(controller.evolve(goal.id, {}).ok === false, 'evolve without patch is rejected')
ok(controller.evolve(goal.id, { patch: { criteria: [], provenance: { source: 'user', rationale: 'test' } } }).ok === false, 'evolve without approval is rejected')
ok(controller.snapshots(goal.id).length === 1, 'rejected evolve leaves no snapshot')

// 应用补丁：改文本 + 修订 ac_0 + 保留 ac_1 + 新增标准
const evolved = controller.evolve(goal.id, {
  approve: true,
  outcomeGatePassed: true,
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
ok(evolved.snapshot?.generation === 2 && evolved.snapshot?.decision === 'applied' && evolved.snapshot?.outcomeGatePassed === true, 'applied evolve records a generation-2 snapshot with gate outcome')

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

// 持久化：同目录重开 store，快照与回滚后的规格均还在
const reopened = new GoalStore(userData)
ok(reopened.snapshots(goal.id).length === 3, 'spec snapshots survive a store reload')
ok(reopened.get(goal.id)?.text === 'Ship the release' && reopened.get(goal.id)?.acceptanceCriteria?.length === 2, 'rolled-back goal spec survives a store reload')

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

console.log(failed ? `\n${failed} check(s) failed` : '\nAll goal spec evolution checks passed')
process.exit(failed ? 1 : 0)
