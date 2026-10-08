// smoke-goal-concurrency.mjs：GoalStore 双写者（主进程 + sidecar）并发/失效回归
// 复现口径：两个 GoalStore 实例指向同一 userDataDir，等价于主进程与 sidecar 的
// 共享文件关系（src/main/index.ts 与 src/main/sidecar-runtime.ts 各构造一个）。
// 要求：A 创建 → B 可观察；A、B 各自写入后两份数据都不丢（无丢失更新）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-goal-concurrency-'))
const storeBundle = path.join(outDir, 'goal-store.cjs')
await build({
  entryPoints: [path.join(root, 'src/main/goal-store.ts')],
  outfile: storeBundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18'
})
const { GoalStore } = await import(pathToFileURL(storeBundle).href)

let failed = 0
const ok = (condition, label) => {
  console.log(`  ${condition ? 'OK' : 'FAIL'} ${label}`)
  if (!condition) failed++
}

const baseInput = (text) => ({
  issueId: `iss_${text.replace(/\s+/g, '_').toLowerCase()}`,
  text,
  completionConditions: ['never'],
  stopConditions: [],
  maxRuns: 3,
  maxDurationMs: 60_000,
  workdir: outDir
})

// === 场景 1：A 创建 → B 必须能观察到（读路径身份失效）===
{
  const dir = path.join(outDir, 'observe')
  const a = new GoalStore(dir)
  const b = new GoalStore(dir) // 与 sidecar 同构：在 A 写入之前就已构造并装载
  const goal = a.create(baseInput('observe me'))
  ok(typeof b.get(goal.id) === 'object' && b.get(goal.id)?.text === 'observe me', 'B observes a goal created by A after construction (get)')
  ok(b.list().some((item) => item.id === goal.id), 'B observes a goal created by A after construction (list)')
}

// === 场景 2：A、B 各自创建 → 两份数据都不丢（丢更新复现）===
{
  const dir = path.join(outDir, 'no-loss')
  const a = new GoalStore(dir)
  const b = new GoalStore(dir)
  const fromA = a.create(baseInput('written by A'))
  const fromB = b.create(baseInput('written by B'))
  // 双向对账：磁盘上两份都在，且两个实例刷新后都能看到对方
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'goals', 'index.json'), 'utf8'))
  ok(onDisk.goals.some((g) => g.id === fromA.id), 'A goal survives B concurrent create (on disk)')
  ok(onDisk.goals.some((g) => g.id === fromB.id), 'B goal survives A concurrent create (on disk)')
  ok(a.get(fromB.id)?.text === 'written by B', 'A re-observes B goal (identity invalidation)')
  ok(b.get(fromA.id)?.text === 'written by A', 'B re-observes A goal (identity invalidation)')
}

// === 场景 3：A 创建、B 更新 → 补丁不丢且 A 可见（写路径锁内重载→变更→提交）===
{
  const dir = path.join(outDir, 'patch')
  const a = new GoalStore(dir)
  const goal = a.create(baseInput('patch target'))
  const b = new GoalStore(dir)
  const patched = b.update(goal.id, { status: 'active', blockCount: 2 })
  ok(!!patched && patched.status === 'active' && patched.blockCount === 2, 'B patches a goal it has not seen (stale-instance update lands)')
  ok(a.get(goal.id)?.status === 'active', 'A observes B patch after invalidation')
  // 反向：A 再更新不得覆盖掉 B 的补丁
  a.update(goal.id, { runCount: 1 })
  const final = b.get(goal.id)
  ok(final?.status === 'active' && final?.blockCount === 2 && final?.runCount === 1, 'A follow-up update preserves B patch (no lost update)')
}

// === 场景 4：runs/checkpoints 双写互不覆盖 ===
{
  const dir = path.join(outDir, 'runs')
  const a = new GoalStore(dir)
  const goal = a.create(baseInput('runs target'))
  const b = new GoalStore(dir)
  a.upsertRun({ id: 'run_a1', goalId: goal.id, phaseIndex: 0, issueId: goal.issueId, taskId: 'task_a', trigger: 'goal', prompt: 'p', transcriptEventCount: 0, status: 'completed' })
  b.upsertRun({ id: 'run_b1', goalId: goal.id, phaseIndex: 1, issueId: goal.issueId, taskId: 'task_b', trigger: 'goal', prompt: 'p', transcriptEventCount: 0, status: 'completed' })
  b.addCheckpoint({ goalId: goal.id, runId: 'run_b1', phaseIndex: 1, summary: 'phase 1', completedConditions: [], incompleteConditions: [], nextPlan: '', blockers: [] })
  const runIds = a.runs(goal.id).map((run) => run.id).sort()
  ok(runIds.join(',') === 'run_a1,run_b1', 'runs from both writers coexist')
  ok(a.checkpoints(goal.id).length === 1, 'checkpoint written by B survives A reads')
}

// === 场景 N：快照代数分配必须原子（锁外读算会撞代）===
// 历史缺陷：调用方在锁外 snapshots() 读 max、再另起一次锁写快照，两个 writer
// 并发时各自读到同一 max，快照撞成同一 generation。现由 GoalStore 在写事务锁内分配。
// 注意：被拒提案（只有 decision 无 snapshot）**复用**当前代数属既有契约，不在本场景。
{
  const dir = path.join(outDir, 'generation')
  const a = new GoalStore(dir)
  const b = new GoalStore(dir)
  const goal = a.create(baseInput('generation race'))

  const snapshotInput = (text) => ({
    goalId: goal.id, text, acceptanceCriteria: [], completionConditions: ['x'], stopConditions: [], outcomeGatePassed: false, decision: 'applied'
  })
  const decisionInput = (reason) => ({ goalId: goal.id, decision: 'applied', reason })

  // 两个 writer 各自提交快照：显式传入同一（陈旧的）generation，模拟锁外读算撞代
  const sa = a.commitSpecEvolution({ goalId: goal.id, goalPatch: { text: 'A' }, snapshot: { ...snapshotInput('A'), generation: 2 }, decision: { ...decisionInput('A'), generation: 2 } })
  const sb = b.commitSpecEvolution({ goalId: goal.id, goalPatch: { text: 'B' }, snapshot: { ...snapshotInput('B'), generation: 2 }, decision: { ...decisionInput('B'), generation: 2 } })

  const gens = [sa?.generation, sb?.generation].sort((x, y) => x - y)
  ok(new Set(gens).size === gens.length, 'concurrent snapshots get distinct generations (no allocation race)')
  const persisted = a.snapshots(goal.id).map((s) => s.generation)
  ok(new Set(persisted).size === persisted.length, 'persisted snapshot generations are unique')
  ok(a.nextSpecGeneration(goal.id) > Math.max(...persisted), 'next allocation exceeds every recorded snapshot generation')
}

fs.rmSync(outDir, { recursive: true, force: true })
if (failed) process.exitCode = 1
else console.log('\n✅ GOAL CONCURRENCY SMOKE PASSED')
