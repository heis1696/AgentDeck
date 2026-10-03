// Issue 管线状态机冒烟：框架单元电池 + runner 集成回归。
//
// 单元部分直接消费 src/main/pipeline/issue-pipeline.ts 的导出（受附录 A 公共 API
// 保护）；集成部分验证 runner 的 isIdle/准入/终点收口已单点委托管线——历史上
// sessions、retiredProviderSessions 两次把全结束看板永久判忙，此冒烟把「idle
// 不变式」钉在框架层：任务结束后合法存活的常态结构性不在账本内。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-pipeline-bundles-'))
const bundle = async (source, name) => {
  const outfile = path.join(bundleDir, name)
  await build({ entryPoints: [path.join(root, source)], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['electron'] })
  return import(pathToFileURL(outfile).href)
}
const [{ IssuePipeline }, { FlowEngine }, { StartNode, RunningNode, FinalizeNode, standardFlow }, { TaskRunner }, { TaskStore }, { TaskService }] = await Promise.all([
  bundle('src/main/pipeline/issue-pipeline.ts', 'pipeline.cjs'),
  bundle('src/main/pipeline/flow.ts', 'flow.cjs'),
  bundle('src/main/pipeline/nodes.ts', 'nodes.cjs'),
  bundle('src/main/runner.ts', 'runner.cjs'),
  bundle('src/main/store.ts', 'store.cjs'),
  bundle('src/main/task-service.ts', 'service.cjs')
])

const check = (condition, label) => {
  console.log(`  ${condition ? 'OK' : 'FAIL'} ${label}`)
  if (!condition) process.exitCode = 1
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const waitFor = async (predicate, label, timeoutMs = 4_000) => {
  for (let i = 0; i < timeoutMs / 5; i++) {
    if (predicate()) return
    await sleep(5)
  }
  throw new Error(`waitFor timeout: ${label}`)
}
const deferred = () => {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

// ---- 单元：变体解析 ----
{
  const tasks = new Map()
  const pipeline = new IssuePipeline({
    probe: { list: () => [...tasks.values()], get: (id) => tasks.get(id) },
    variants: [
      { id: 'meeting-member', match: (t) => !!t.meetingId && t.meetingTaskRole !== 'container' },
      { id: 'meeting-container', match: (t) => t.meetingTaskRole === 'container' },
      { id: 'relay', match: (t) => t.trigger === 'handoff' }
    ]
  })
  const member = { id: 'm1', status: 'running', meetingId: 'mt1', meetingTaskRole: 'member' }
  const container = { id: 'c1', status: 'queued', meetingId: 'mt1', meetingTaskRole: 'container' }
  const relay = { id: 'r1', status: 'queued', trigger: 'handoff' }
  const plain = { id: 'p1', status: 'running' }
  check(pipeline.resolveVariant(member).id === 'meeting-member', 'variant: 会议成员解析到 meeting-member')
  check(pipeline.resolveVariant(container).id === 'meeting-container', 'variant: 会议容器解析到 meeting-container')
  check(pipeline.resolveVariant(relay).id === 'relay', 'variant: 硬切后继解析到 relay')
  check(pipeline.resolveVariant(plain).id === 'task', 'variant: 普通任务落到缺省 task 变体')
}

// ---- 单元：在途账本 ----
{
  const pipeline = new IssuePipeline({ probe: { list: () => [], get: () => undefined } })
  pipeline.begin('t1:launch')
  pipeline.begin('t1:terminate')
  pipeline.begin('t2:late-cleanup')
  check(pipeline.ledgerSize() === 3 && pipeline.has('t1:launch'), 'ledger: 登记 3 条在途操作')
  check(pipeline.end('t2:late-cleanup') && !pipeline.has('t2:late-cleanup'), 'ledger: 单条结束可作泄漏探针')
  check(pipeline.end('t2:late-cleanup') === false, 'ledger: 重复结束返回 false')
  check(pipeline.endScope('t1') === 2 && pipeline.ledgerSize() === 0, 'ledger: settle/drop 按任务前缀清账')
}

// ---- 单元：idle 不变式（历史两次翻车的结构性防线）----
{
  const tasks = new Map()
  const sessionsLike = new Map()          // 「合法存活的常态」：不登记、不挂源
  const transient = { size: 0 }
  const pipeline = new IssuePipeline({ probe: { list: () => [...tasks.values()], get: (id) => tasks.get(id) }, sources: [{ label: 'transient', size: () => transient.size }] })
  tasks.set('a', { id: 'a', status: 'running' })
  check(!pipeline.isIdle(), 'idle: running 任务即忙')
  tasks.set('a', { id: 'a', status: 'done' })
  sessionsLike.set('a', { sessionId: 's1' })
  check(pipeline.isIdle(), 'idle: 全终态 + 未登记的常态存活（活会话）不影响空闲')
  pipeline.begin('a:some-op')
  check(!pipeline.isIdle(), 'idle: 在途账未清即忙（新机制必须走账本）')
  pipeline.end('a:some-op')
  transient.size = 1
  check(!pipeline.isIdle(), 'idle: 适配源非零即忙（迁移期既有 Map 语义保留）')
  transient.size = 0
  check(pipeline.isIdle() && pipeline.busySources().length === 0, 'idle: 空闲时 busySources 为空')
  pipeline.begin('b:op')
  transient.size = 2
  const busy = pipeline.busySources()
  check(busy.some((s) => s.label === 'ledger' && s.size === 1) && busy.some((s) => s.label === 'transient' && s.size === 2), 'busySources: 具名定位谁在忙')
}

// ---- 单元：settle 终点处理 ----
{
  const tasks = new Map()
  const settled = []
  const pipeline = new IssuePipeline({
    probe: { list: () => [...tasks.values()], get: (id) => tasks.get(id) },
    variants: [{
      id: 'v', match: () => true,
      onSettle: (task, outcome, context) => {
        settled.push({ id: task.id, outcome, actor: context.actor, reason: context.reason })
        if (task.id === 'boom') throw new Error('hook exploded')
      }
    }]
  })
  tasks.set('a', { id: 'a', status: 'running' })
  pipeline.begin('a:turn')
  const ok = await pipeline.settle('a', 'done', { actor: 'runner', reason: 'unit' })
  check(ok.ok && settled.length === 1 && settled[0].outcome === 'done' && settled[0].actor === 'runner', 'settle: running→done 触发变体钩子（带 actor/reason）')
  check(pipeline.ledgerSize() === 0, 'settle: 收尾清空该任务在途账')
  check(pipeline.journalSnapshot().some((e) => e.taskId === 'a' && e.from === 'running' && e.to === 'done' && e.variant === 'v'), 'journal: 迁移入流水账（from/to/变体）')
  // 落库由调用方完成——模拟状态已落
  tasks.set('a', { id: 'a', status: 'done' })
  const replay = await pipeline.settle('a', 'done', { actor: 'runner' })
  check(replay.ok && settled.length === 1, 'settle: 同终态幂等重放不重复跑钩子')
  const rewrite = await pipeline.settle('a', 'failed', { actor: 'runner' })
  check(!rewrite.ok && /拒绝改写/.test(rewrite.error), 'settle: 已终态拒绝改写为其它终态')
  tasks.set('q', { id: 'q', status: 'queued' })
  const illegal = await pipeline.settle('q', 'done', { actor: 'runner' })
  check(!illegal.ok && /非法迁移/.test(illegal.error), 'settle: 迁移合法性只认 taskflow 矩阵（queued→done 拒绝）')
  tasks.set('boom', { id: 'boom', status: 'running' })
  pipeline.begin('boom:op')
  const hookFailure = await pipeline.settle('boom', 'failed', { actor: 'runner' })
  check(hookFailure.ok && /hook exploded/.test(hookFailure.error ?? ''), 'settle: 钩子抛错收集为 warning 不阻断收尾')
  check(pipeline.ledgerSize() === 0, 'settle: 钩子失败也在途账照清')
  pipeline.drop('boom')
  check(pipeline.journalSnapshot().some((e) => e.taskId === 'boom' && e.to === 'removed'), 'drop: 任务移除记 removed')
}

// ---- 集成：runner 单点委托 ----
function makeHarness() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-pipeline-data-'))
  const store = new TaskStore(data)
  const service = new TaskService({ store })
  let seq = 0
  const log = { stops: [], closes: [] }
  const cfg = { startGate: null }
  const backend = {
    id: 'fake-pipeline', label: 'Fake', supportsResume: true,
    async probe() { return { ok: true, detail: 'fake' } },
    async start({ prompt, events, turn }) {
      const id = `s${++seq}`
      events.onLaunch?.({ stop: async () => {} })
      if (cfg.startGate) await cfg.startGate.promise
      setTimeout(() => {
        events.onEvent({ ts: Date.now(), kind: 'final', text: 'worker turn done' }, turn)
        events.onTurnEnd({ ok: true, response: 'worker turn done' }, turn)
      }, 5)
      return { sessionId: id, turnScoped: true, async send() {}, async stop() { log.stops.push(id) }, async close() { log.closes.push(id) } }
    }
  }
  const runner = new TaskRunner(store, new Map([[backend.id, backend]]), () => ({ concurrency: 4, workerConcurrency: 4, mode: 'yolo', notify: false }))
  const createTask = (patch = {}) => service.createTask({ title: patch.title ?? 'task', prompt: patch.prompt ?? 'do things', backend: backend.id, ...patch })
  return { data, store, service, runner, log, cfg, createTask }
}

{
  const h = makeHarness()
  const plain = h.createTask()
  h.runner.enqueue(h.store.get(plain.id))
  await waitFor(() => h.store.get(plain.id)?.status === 'done', 'plain done')
  const member = h.createTask({ meetingId: 'mt-x', meetingTaskRole: 'member', suppressIssue: true })
  check(h.runner.pipeline.resolveVariant(h.store.get(member.id)).id === 'meeting-member', 'runner: 会议成员经管线解析变体')
  check(h.runner.pipeline.resolveVariant(h.store.get(plain.id)).id === 'task', 'runner: 普通任务经管线解析缺省变体')
  check(h.runner.isIdle() && h.runner.pipeline.isIdle() && h.runner.sessionCount() === 1, 'runner: done 任务常驻活会话下 isIdle 单点成立')
  check(h.runner.pipeline.busySources().length === 0, 'runner: 空闲时管线无具名在途源')

  // 终点收口：done 落库后管线流水账应有对应记录（finalizer→onTerminal→settle）
  await waitFor(() => h.runner.pipeline.journalSnapshot().some((e) => e.taskId === plain.id && e.to === 'done' && e.variant === 'task'), 'journal done')
  check(true, 'runner: done 终点经管线 settle 入流水账（finalizer onTerminal 端口）')

  // 会议守卫经管线横切准入生效（行为保持）
  let fenceOn = false
  h.runner.attachMeetingGuard(() => !fenceOn)
  check(h.runner.pipeline.admits(h.store.get(member.id)), 'runner: 守卫放行时管线准入通过')
  fenceOn = true
  check(!h.runner.pipeline.admits(h.store.get(member.id)), 'runner: 会议停止屏障经管线准入拦截')
  fenceOn = false

  // failed/terminated 终点收口——直接走 runner 的终止路径验证 cancelled 幂等补记
  const second = h.createTask()
  h.runner.enqueue(h.store.get(second.id))
  await waitFor(() => h.store.get(second.id)?.status === 'done', 'second done')
  const stopped = await h.runner.terminateTask(second.id)
  check(stopped.ok, 'runner: 终止成功')
  await waitFor(() => h.runner.pipeline.journalSnapshot().some((e) => e.taskId === second.id && e.to === 'done' && /termination verified/.test(e.detail ?? '')), 'journal terminated')
  check(h.runner.pipeline.journalSnapshot().filter((e) => e.taskId === second.id && /termination verified/.test(e.detail ?? '')).length === 1, 'runner: 终止验证后幂等补记（不重复）')

  // automation 式横切源：挂上即忙、摘掉即闲（index.ts 的迁移模式）
  h.runner.pipeline.addSource({ label: 'automation', size: () => 1 })
  check(!h.runner.isIdle(), 'runner: 横切在途源（automation 迁移模式）挂入即忙')
  await h.runner.shutdown()
}

// ---- 单元：执行流 FlowEngine（实际运行 node 化）----
{
  const pipeline = new IssuePipeline({ probe: { list: () => [], get: () => undefined } })
  const engine = new FlowEngine((key) => pipeline.begin(key), (key) => pipeline.end(key))
  const seen = []
  const gate = deferred()

  // 节点在途账：enter 期间可见、退出即清（结构性防泄漏）
  const gated = {
    id: 'gated',
    async enter() { seen.push('gated-enter'); await gate.promise },
    exit() { seen.push('gated-exit') }
  }
  const runningFlow = engine.run('t1', [gated], {}, { flowId: 'f-gated' })
  await waitFor(() => pipeline.has('t1:node:gated') && engine.activeFlows().some((f) => f.flowId === 'f-gated' && f.stoppedAt === 'gated'), 'gated node in flight')
  check(true, 'flow: 节点执行期间在途账可见 + activeFlows 停靠节点可观测')
  gate.resolve()
  check((await runningFlow).ok && !pipeline.has('t1:node:gated'), 'flow: 节点退出即在途账清零')

  // enter 抛错 → exit 仍执行、账清、结果带 failedNode
  let exitRan = false
  const boom = {
    id: 'boom',
    enter() { throw new Error('enter exploded') },
    exit() { exitRan = true }
  }
  const after = { id: 'after', enter() { seen.push('after-should-not-run') } }
  const failed = await engine.run('t2', [boom, after], {})
  check(!failed.ok && failed.failedNode === 'boom' && /enter exploded/.test(failed.error ?? ''), 'flow: enter 抛错 → 流终止并归因 failedNode')
  check(exitRan && !seen.includes('after-should-not-run') && pipeline.ledgerSize() === 0, 'flow: 抛错路径 exit 照跑、后续节点不再进入、账清')

  // exit 抛错不吞 enter 错；enter 成功时 exit 错升为流错
  const exitBoom = { id: 'x', enter() {}, exit() { throw new Error('exit exploded') } }
  const r2 = await engine.run('t3', [exitBoom], {})
  check(!r2.ok && /exit exploded/.test(r2.error ?? ''), 'flow: exit 抛错计入流结果')

  // 协作中断：节点边界停止
  const slow = { id: 'slow', async enter() { await sleep(30) } }
  const tail = { id: 'tail', enter() { seen.push('tail-enter') } }
  const interruptible = engine.run('t4', [slow, tail], {}, { flowId: 'f-int' })
  engine.interrupt('f-int', '用户停止')
  const r3 = await interruptible
  check(r3.interrupted && !r3.ok && !seen.includes('tail-enter'), 'flow: interrupt 在节点边界截停后续节点')

  // 并发流：两任务同时跑、state 袋互不串、节点实例复用
  const g1 = deferred()
  const g2 = deferred()
  const sharedNode = {
    id: 'shared',
    async enter(ctx) { await (ctx.taskId === 't5' ? g1 : g2).promise; ctx.state.touched = ctx.taskId }
  }
  const f1 = engine.run('t5', [sharedNode], {}, { flowId: 'f1' })
  const f2 = engine.run('t6', [sharedNode], {}, { flowId: 'f2' })
  await waitFor(() => engine.activeFlows().length === 2, 'two active flows')
  check(true, 'flow: 同一节点实例被两条流并发复用，active 表可见')
  g1.resolve()
  g2.resolve()
  const [r1v, r2v] = await Promise.all([f1, f2])
  check(r1v.ok && r2v.ok && pipeline.ledgerSize() === 0, 'flow: 并发流各自完成且在途账归零')
}

// ---- 单元：标准节点库（端口驱动复用）----
{
  const calls = []
  const ports = {
    start: async () => { calls.push('start') },
    runTurn: async () => { calls.push('runTurn') },
    finalize: async () => { calls.push('finalize') }
  }
  const pipeline = new IssuePipeline({ probe: { list: () => [], get: () => undefined } })
  const engine = new FlowEngine((key) => pipeline.begin(key), (key) => pipeline.end(key))
  const flow = standardFlow(ports)
  check(flow.map((n) => n.id).join('>') === 'start>running>finalize', 'nodes: 标准节点表 start→running→finalize')
  const result = await engine.run('t7', flow, {})
  check(result.ok && calls.join('>') === 'start>runTurn>finalize', 'nodes: 端口按节点序注入执行')
  const partial = await engine.run('t8', [new StartNode(ports), new RunningNode(ports)], {})
  check(partial.ok, 'nodes: 节点表可裁剪组合（缺省端口自动跳过）')
  const finalizeOnly = new FinalizeNode(ports)
  check(finalizeOnly.id === 'finalize', 'nodes: 节点类可单独实例化')
}

// ---- 集成：隔离回合走执行流（真实路径节点化实证）----
{
  const h = makeHarness()
  const task = h.createTask()
  h.runner.enqueue(h.store.get(task.id))
  await waitFor(() => h.store.get(task.id)?.status === 'done', 'isolated base done')
  const done = h.store.get(task.id)
  // 模拟执行中 + 归属不可信的旧会话：直调 startIsolatedTurn（冒烟惯例访问私有面）
  h.store.update(task.id, { status: 'running' })
  const session = h.runner.sessions.get(task.id)
  session.turnScoped = false
  const claim = { taskId: task.id, runId: done.runId, owner: done.executionOwner }
  // 真实路径里 beginRun 会把 claim 登记进 claims；直调须补上，否则回合回调归属校验不过
  h.runner.claims.set(task.id, claim)
  h.cfg.startGate = deferred()
  const inFlight = Promise.resolve(h.runner.startIsolatedTurn(task.id, '隔离回合', claim))
  await waitFor(() => h.runner.pipeline.busySources().some((s) => s.label === 'ledger')
    && h.runner.pipeline.ledgerEntries().includes(`${task.id}:node:start`), 'isolated flow node in ledger')
  const active = h.runner.flowEngine.activeFlows()
  check(active.some((f) => f.taskId === task.id && f.stoppedAt === 'start'), 'isolated: 执行流停在 start 节点（启动竞态在途可观测）')
  h.cfg.startGate.resolve()
  const r = await inFlight
  check(r.ok === true && r.response === 'worker turn done', 'isolated: 隔离回合经 Start→Running 节点流完成并返回回合结果')
  check(h.runner.pipeline.ledgerSize() === 0 && h.runner.flowEngine.activeFlows().length === 0, 'isolated: 流结束后节点在途账与 active 表归零')
  check(h.runner.launchHandles.size === 0, 'isolated: 流级收尾端口清启动句柄（原 finally 语义保留）')
  await h.runner.shutdown()
}

// ---- 单元：首次收尾跑钩子 / 重复收尾跳过 / reopen 重置（落库后补收口语义）----
{
  const tasks = new Map()
  const variantHooks = []
  const globalHooks = []
  const pipeline = new IssuePipeline({
    probe: { list: () => [...tasks.values()], get: (id) => tasks.get(id) },
    variants: [{ id: 'v', match: () => true, onSettle: (task, outcome, ctx) => { variantHooks.push(`${task.id}:${outcome}:${ctx.source ?? '-'}`) } }],
    settleHooks: [(task, outcome, ctx) => { globalHooks.push(`${task.id}:${outcome}:${ctx.source ?? '-'}`) }]
  })
  // 落库后补收口（生产常态）：任务已 done，首次 settle 仍要跑钩子
  tasks.set('a', { id: 'a', status: 'done' })
  const first = await pipeline.settle('a', 'done', { actor: 'runner', source: 'finalize' })
  check(first.ok && variantHooks.length === 1 && globalHooks.length === 1 && variantHooks[0] === 'a:done:finalize', 'settle: 落库后首次收尾照常执行变体与横切钩子（带 source）')
  await pipeline.settle('a', 'done', { actor: 'runner', source: 'terminate' })
  check(variantHooks.length === 1 && globalHooks.length === 1, 'settle: 同终态重复收尾只补记账不再跑钩子')
  pipeline.reopen('a')
  await pipeline.settle('a', 'done', { actor: 'runner', source: 'finalize' })
  check(variantHooks.length === 2 && globalHooks.length === 2, 'settle: reopen（重跑）后再次终态照常收尾')
  const rejected = await pipeline.settle('a', 'cancelled', { actor: 'runner', source: 'cancel' })
  check(!rejected.ok && /拒绝改写/.test(rejected.error), 'settle: 终态互斥仍拒绝改写')
  // 横切钩子抛错收集为 warning
  const boom = new IssuePipeline({
    probe: { list: () => [...tasks.values()], get: (id) => tasks.get(id) },
    settleHooks: [() => { throw new Error('hook boom') }]
  })
  tasks.set('b', { id: 'b', status: 'failed' })
  const warned = await boom.settle('b', 'failed', { actor: 'runner' })
  check(warned.ok && /hook boom/.test(warned.error ?? ''), 'settle: 横切钩子失败收集为 warning 不阻断')
}

// ---- 集成：主执行路径 run() 走 Start→Running→Finalize 节点流 ----
{
  const h = makeHarness()
  const task = h.createTask()
  h.cfg.startGate = deferred()
  h.runner.enqueue(h.store.get(task.id))
  await waitFor(() => h.runner.pipeline.ledgerEntries().includes(`${task.id}:node:start`), 'run flow start node in ledger')
  check(h.runner.flowEngine.activeFlows().some((f) => f.taskId === task.id && f.stoppedAt === 'start'), 'run: 主路径执行流停靠 start 节点可观测')
  h.cfg.startGate.resolve()
  await waitFor(() => h.store.get(task.id)?.status === 'done', 'run gated task done')
  check(h.store.get(task.id).status === 'done' && h.runner.pipeline.ledgerSize() === 0, 'run: 主路径经节点流完成，在途账归零')
  check(h.runner.pipeline.journalSnapshot().some((e) => e.taskId === task.id && e.to === 'done'), 'run: 主路径终态入管线流水账')
  await h.runner.shutdown()
}

// ---- 集成：级联取消经统一终点处理（取消源钩子停子单）----
{
  const h = makeHarness()
  const parent = h.createTask({ title: '领队' })
  const childA = h.createTask({ title: '子单A', parentTaskId: parent.id })
  const childB = h.createTask({ title: '子单B', parentTaskId: parent.id })
  check(h.store.get(childA.id).parentTaskId === parent.id && h.runner.pipeline.resolveVariant(h.store.get(childA.id)).id === 'delegate-child', 'cascade: 子派单解析到 delegate-child 变体')
  const stopped = await h.runner.cancel(parent.id)
  check(stopped.ok && h.store.get(parent.id).status === 'cancelled', 'cascade: 排队领队取消成功')
  await waitFor(() => h.store.get(childA.id)?.status === 'cancelled' && h.store.get(childB.id)?.status === 'cancelled', 'children cancelled')
  check(true, 'cascade: 运行中/排队的子任务经取消源收尾钩子一并停止')
  await waitFor(() => h.runner.pipeline.journalSnapshot().some((e) => e.taskId === parent.id && e.to === 'cancelled'), 'parent journal')
  check(h.runner.pipeline.journalSnapshot().every((e) => e.to !== 'removed'), 'cascade: 收尾只销账不移除任务')
  await h.runner.shutdown()
}

if (process.exitCode) throw new Error('issue pipeline regression failed')
console.log('\n✅ ISSUE PIPELINE SMOKE PASSED')
