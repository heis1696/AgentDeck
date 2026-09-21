// 小助理宿主冒烟（阶段 1 契约与批处理）：esbuild 直连 src/main/pet/host.ts + src/shared/pet.ts + pet-store.ts。
// 覆盖：契约事件假宿主收发、开关位关闭的边界丢弃语义（不转发不记忆）、合并窗行为（手动假时钟）、
// deck.queryBoard 行剥离、deck.createTask 草稿语义（startNow:false 钉死）、deck.annotateTask 独立通道、
// pet.json 开关位持久化。PetController 的 electron 侧装配不在直连面（ipc/pet.ts 惯例）。
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const root = path.resolve(import.meta.dirname, '..')

async function bundle(entry, name) {
  const outfile = path.join(root, 'out', name)
  await build({ entryPoints: [path.join(root, entry)], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['electron'] })
  return import(pathToFileURL(outfile).href)
}
const hostMod = await bundle('src/main/pet/host.ts', 'smoke-pet-host.cjs')
const shared = await bundle('src/shared/pet.ts', 'smoke-pet-host-shared.cjs')
const { PetStore } = await bundle('src/main/pet/pet-store.ts', 'smoke-pet-host-store.cjs')

const { PetHost, PetEventBatchWindow, timeoutScheduler, toPetBoardTaskRow, toPetHostDraftCreateInput } = hostMod
const { DEFAULT_PET_HOST_SWITCHES, normalizePetHostSwitches, petBatchFlushAt, petHostSwitchKeyFor, PET_HOST_BATCH_MAX_MS, PET_HOST_BATCH_QUIET_MS } = shared

let failed = 0
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) failed++ }

/** 手动假时钟：schedule/cancel 记账，setNow/advanceBy/advance 手动推进（fake timer，不睡真实时间） */
function makeFakeClock(startAt = 1_000_000) {
  const state = { now: startAt, pendingAt: null, scheduleCalls: 0, cancelCalls: 0, fire: null }
  const scheduler = {
    schedule(delayMs, cb) { state.scheduleCalls += 1; state.pendingAt = state.now + delayMs; state.fire = cb },
    cancel() { state.cancelCalls += 1; state.pendingAt = null; state.fire = null }
  }
  return {
    scheduler,
    now: () => state.now,
    pendingAt: () => state.pendingAt,
    stats: state,
    advanceBy(dt) { state.now += dt },
    advanceTo(t) {
      state.now = t
      const cb = state.fire
      state.fire = null
      state.pendingAt = null
      if (cb) cb()
    },
    advance() { if (state.fire) this.advanceTo(state.pendingAt) }
  }
}

/** 假宿主 deps：计数 buildBoardSummary，记录事件与工具调用 */
function makeHostDeps(overrides = {}) {
  const calls = { builder: 0, drafts: [], annotations: [], events: [] }
  const deps = {
    getSwitches: overrides.getSwitches ?? (() => DEFAULT_PET_HOST_SWITCHES),
    buildBoardSummary: () => { calls.builder += 1; return `摘要#${calls.builder}` },
    queryBoard: overrides.queryBoard ?? (() => []),
    createDraftTask: (input) => { calls.drafts.push(input); return { id: `task_${calls.drafts.length}`, title: input.title, status: 'queued' } },
    annotateIssue: (issueId, text) => { calls.annotations.push({ issueId, text }) },
    resolveTask: overrides.resolveTask ?? ((taskId) => ({ issueId: `iss_${taskId}` }))
  }
  return { deps, calls }
}

console.log('—— shared：开关位归一与合并窗公式（纯函数契约）——')
ok(normalizePetHostSwitches(undefined).taskRunning === true && normalizePetHostSwitches(null).boardSnapshot === true, '缺省归一 = 默认全开')
ok(Object.values(DEFAULT_PET_HOST_SWITCHES).every((v) => v === true), '默认开关位全开')
const partial = normalizePetHostSwitches({ taskDone: false, workflowMilestone: 'yes', bogus: 1 })
ok(partial.taskDone === false && partial.taskRunning === true && partial.workflowMilestone === true && partial.boardSnapshot === true && !('bogus' in partial), '部分开关覆盖 + 非法位回默认 + 未知键不收')
ok(petHostSwitchKeyFor('task.done') === 'taskDone' && petHostSwitchKeyFor('board.snapshot') === 'boardSnapshot' && petHostSwitchKeyFor('workflow.milestone') === 'workflowMilestone', '事件种类 → 开关位映射')
ok(petHostSwitchKeyFor('task.paused') === null, '契约外种类无开关位（emit 直接丢弃）')
ok(PET_HOST_BATCH_MAX_MS === 15_000 && PET_HOST_BATCH_QUIET_MS === 2_500, '合并窗常量 15s/2.5s')
ok(petBatchFlushAt(1_000_000, 1_000_000) === 1_002_500, '单事件到期 = at+2.5s（min 取静默端）')
ok(petBatchFlushAt(0, 20_000) === 15_000, '长批次到期被 firstAt+15s 封顶')
ok(petBatchFlushAt(1_000, 2_000) === 4_500, 'lastAt+2.5s < firstAt+15s 时取静默端')

console.log('—— PetHost：假宿主收发（契约事件流扇出）——')
{
  const { deps, calls } = makeHostDeps()
  const host = new PetHost(deps)
  const seen = []
  const unsubscribe = host.addListener((event) => seen.push(event.kind))
  host.emitTaskChanged({ id: 't1', title: '写文档', status: 'running' }, 100)
  ok(JSON.stringify(seen) === JSON.stringify(['task.running', 'board.snapshot']), 'running → task.running + board.snapshot')
  seen.length = 0
  host.emitTaskChanged({ id: 't1', title: '写文档', status: 'done' }, 200)
  ok(JSON.stringify(seen) === JSON.stringify(['task.done', 'board.snapshot']), 'done → task.done + board.snapshot')
  seen.length = 0
  host.emitTaskChanged({ id: 't1', title: '写文档', status: 'failed' }, 300)
  ok(JSON.stringify(seen) === JSON.stringify(['task.failed', 'board.snapshot']), 'failed → task.failed + board.snapshot')
  seen.length = 0
  host.emitTaskChanged({ id: 't1', title: '写文档', status: 'cancelled' }, 400)
  host.emitTaskChanged({ id: 't2', title: '排队件', status: 'queued' }, 500)
  ok(JSON.stringify(seen) === JSON.stringify(['board.snapshot', 'board.snapshot']), 'cancelled/queued 是契约外状态：只走 board.snapshot')
  const event = { kind: 'task.done', taskId: 't9', title: 'x', at: 1, detail: '附注' }
  let lastEvent = null
  host.addListener((e) => { lastEvent = e })
  host.emit(event)
  ok(seen.length === 3 && lastEvent && lastEvent.detail === '附注' && lastEvent.taskId === 't9', 'emit 直发契约事件可达（detail 透传）')
  unsubscribe()
  host.emitTaskChanged({ id: 't3', title: '退订后', status: 'done' }, 600)
  ok(seen.length === 3, '退订后不再收事件')
}
{
  const { deps } = makeHostDeps()
  const host = new PetHost(deps)
  let reached = 0
  host.addListener(() => { throw new Error('订阅者炸了') })
  host.addListener(() => { reached += 1 })
  host.emit({ kind: 'task.done', taskId: 't1', title: 'x', at: 1 })
  ok(reached === 1, '单个订阅者异常不拖垮扇出')
}
{
  const { deps } = makeHostDeps()
  const host = new PetHost(deps)
  let seen = 0
  host.addListener(() => { seen += 1 })
  host.emit({ kind: 'task.done', taskId: '', title: 'x', at: 1 })
  host.emit({ kind: 'task.done', taskId: 't1', title: 'x', at: Number.NaN })
  host.emit(null)
  host.emit({ kind: 'task.paused', taskId: 't1', title: 'x', at: 1 })
  ok(seen === 0, '空 taskId / 非法 at / 非事件 / 契约外种类一律边界丢弃')
}

console.log('—— 开关位闸门：关 = 边界直接丢弃（不转发不记忆）——')
{
  const switches = { ...DEFAULT_PET_HOST_SWITCHES, taskDone: false }
  const { deps, calls } = makeHostDeps({ getSwitches: () => switches })
  const host = new PetHost(deps)
  const seen = []
  host.addListener((event) => seen.push(event.kind))
  ok(host.getBoardSummary() === '摘要#1', '冷启动 {board_summary} 惰性现算（宏注入行为保持）')
  ok(calls.builder === 1, '惰性现算只调一次 builder')
  host.emitTaskChanged({ id: 't1', title: 'x', status: 'done' }, 100)
  ok(JSON.stringify(seen) === JSON.stringify(['board.snapshot']), 'taskDone 关：task.done 不转发，board.snapshot 照常')
  ok(calls.builder === 2 && host.getBoardSummary() === '摘要#2', 'snapshot 到达刷新快照缓存，读命中缓存不再调 builder')
  switches.boardSnapshot = false
  seen.length = 0
  host.emitTaskChanged({ id: 't1', title: 'x', status: 'running' }, 200)
  ok(JSON.stringify(seen) === JSON.stringify(['task.running']), 'boardSnapshot 关：快照不转发')
  ok(calls.builder === 2, 'boardSnapshot 关：快照不记忆（builder 未被快照触发）')
  host.getBoardSummary()
  ok(calls.builder === 2, '缓存仍在：宏读取不因丢弃而抖动')
}
{
  // 全关：事件流静默（不转发不记忆），但 deck.* 工具与宏读不受开关位影响
  const allOff = { taskRunning: false, taskDone: false, taskFailed: false, workflowMilestone: false, boardSnapshot: false }
  const { deps, calls } = makeHostDeps({ getSwitches: () => allOff })
  const host = new PetHost(deps)
  const seen = []
  host.addListener((event) => seen.push(event.kind))
  host.emitTaskChanged({ id: 't1', title: 'x', status: 'done' }, 100)
  ok(seen.length === 0 && calls.builder === 0, '全开关关闭：零转发零记忆')
  ok(typeof host.getBoardSummary() === 'string' && host.queryBoard !== undefined, '全关不影响宏读与工具可用性')
}
{
  const { deps } = makeHostDeps({ getSwitches: () => ({ taskRunning: 'yes' }) })
  const host = new PetHost(deps)
  const sw = host.switches()
  ok(sw.taskRunning === true && sw.taskDone === true, 'getSwitches 返回脏数据按归一化读（缺省位回默认开）')
}

console.log('—— 事件合并窗：单定时器重算 + 批量一次冲刷（假时钟）——')
{
  const clock = makeFakeClock()
  const flushed = []
  const win = new PetEventBatchWindow({ onFlush: (items) => flushed.push(items), now: clock.now, scheduler: clock.scheduler })
  win.push('a')
  ok(clock.stats.scheduleCalls === 1 && clock.pendingAt() === 1_002_500, '单事件 push：一个定时器，到期 at+2.5s')
  clock.advanceBy(1_000)
  win.push('b')
  ok(clock.stats.scheduleCalls === 2 && clock.stats.cancelCalls >= 1, '第二次 push：取消旧表重算（单定时器）')
  ok(clock.pendingAt() === 1_003_500, `到期重算 = min(firstAt+15s, lastAt+2.5s)（got ${clock.pendingAt()}）`)
  ok(flushed.length === 0, '未到点不冲刷')
  clock.advance()
  ok(flushed.length === 1 && JSON.stringify(flushed[0]) === JSON.stringify(['a', 'b']), '到点一次冲刷全批次（不是逐事件回调）')
  ok(win.pendingCount === 0 && clock.pendingAt() === null, '冲刷后批次清空、无残留定时器')
}
{
  // 长突发：每 2.4s 来一件，到期点随 lastAt 前移直到 firstAt+15s 封顶
  const clock = makeFakeClock()
  const flushed = []
  const win = new PetEventBatchWindow({ onFlush: (items) => flushed.push(items), now: clock.now, scheduler: clock.scheduler })
  for (let i = 0; i < 7; i++) {
    win.push(`job-${i}`)
    if (i < 6) clock.advanceBy(2_400)
  }
  ok(clock.pendingAt() === 1_015_000, `持续突发到期点封顶在 firstAt+15s（got ${clock.pendingAt()}）`)
  clock.advance()
  ok(flushed.length === 1 && flushed[0].length === 7 && flushed[0][6] === 'job-6', '15s 内的 7 件合成为一次冲刷')
}
{
  // 拖拽/聊天扣住：到点不冲，最后一次 release 立即冲出
  const clock = makeFakeClock()
  const flushed = []
  const win = new PetEventBatchWindow({ onFlush: (items) => flushed.push(items), now: clock.now, scheduler: clock.scheduler })
  win.push('a')
  win.hold()
  clock.advance()
  ok(flushed.length === 0 && win.pendingCount === 1, 'hold 中到点：扣住不冲')
  win.release()
  ok(flushed.length === 1 && flushed[0].length === 1, 'release 立即冲出被扣住的批次')
}
{
  const clock = makeFakeClock()
  const flushed = []
  const win = new PetEventBatchWindow({ onFlush: (items) => flushed.push(items), now: clock.now, scheduler: clock.scheduler })
  win.hold() // 聊天开
  win.push('a')
  clock.advanceBy(1_000)
  win.hold() // 拖拽开始（双扣）
  win.push('b')
  clock.advance()
  ok(flushed.length === 0, '双扣任一未松：不冲')
  win.release() // 拖拽结束
  ok(flushed.length === 0 && win.pendingCount === 2, '还剩聊天扣着：继续扣')
  clock.advanceBy(2_000)
  win.push('c') // 扣住期间新事件照收
  clock.advance()
  ok(flushed.length === 0 && win.pendingCount === 3, '扣住期间 push 照常入窗')
  win.release() // 聊天关
  ok(flushed.length === 1 && JSON.stringify(flushed[0]) === JSON.stringify(['a', 'b', 'c']), '最后一扣松开：立即一次冲出全批')
}
{
  const clock = makeFakeClock()
  let flushCount = 0
  const win = new PetEventBatchWindow({ onFlush: () => { flushCount += 1 }, now: clock.now, scheduler: clock.scheduler })
  win.push('a')
  win.flush()
  ok(flushCount === 1 && win.pendingCount === 0, '手动 flush 立即冲出')
  win.push('b')
  win.clear()
  clock.advance()
  ok(flushCount === 1, 'clear 后定时器失效、不再冲刷')
}

console.log('—— deck.queryBoard：store.list() 行剥离（prompt/workdir/密钥/日志正文不出现）——')
{
  const rawTask = {
    id: 'task_1', title: '有密钥的任务', prompt: 'sk-secret-abc\n密钥在 prompt 里', workdir: 'D:\\secret\\repo',
    backend: 'zcode', agentId: 'worker_a', status: 'done', createdAt: 111, endedAt: 222,
    result: '最终报告正文', error: '堆栈', gitDiff: 'diff --git', gitStat: ' 3 files',
    sessionId: 'sess_x', dedupeKey: 'dk_1', handoff: '交接备注', trigger: 'assignment',
    issueId: 'iss_task_1', eventCount: 42
  }
  const row = toPetBoardTaskRow(rawTask)
  ok(JSON.stringify(Object.keys(row)) === JSON.stringify(['id', 'title', 'status', 'agentId', 'backend', 'createdAt', 'endedAt']), '行字段 = 白名单（id/title/status/agentId/backend/createdAt/endedAt）')
  for (const forbidden of ['prompt', 'workdir', 'result', 'error', 'gitDiff', 'gitStat', 'sessionId', 'handoff', 'dedupeKey']) {
    ok(!(forbidden in row), `${forbidden} 不出现在看板行`)
  }
  ok(!JSON.stringify(row).includes('sk-secret'), '密钥串不随行外泄')
  const { deps, calls } = makeHostDeps({ queryBoard: () => [rawTask, { ...rawTask, id: 'task_2', agentId: undefined, endedAt: undefined }] })
  const host = new PetHost(deps)
  const rows = host.queryBoard()
  ok(rows.length === 2 && rows[0].id === 'task_1' && rows[1].agentId === '' && rows[0].endedAt === 222 && !('endedAt' in rows[1]), 'host.queryBoard 包 store.list() 并逐行剥离（可选字段缺省收敛）')
  ok(calls.drafts.length === 0, 'queryBoard 不触发任何写入')
}

console.log('—— deck.createTask：只建草稿（绝不触发 runner 执行）——')
{
  const input = toPetHostDraftCreateInput({ title: '  草稿任务  ', prompt: ' 内容\n ', workdir: 'D:\\repo', agentId: ' worker_a ' })
  ok(input.startNow === false, 'startNow 钉死 false（taskService 语义：parked 草稿，永不 enqueue）')
  ok(input.title === '草稿任务' && input.prompt === '内容', '标题/内容去首尾空白')
  ok(input.workdir === 'D:\\repo' && input.agentId === 'worker_a', 'workdir/agentId 透传并去空白')
  const bare = toPetHostDraftCreateInput({ title: 't', prompt: 'p' })
  ok(bare.startNow === false && bare.workdir === '' && !('agentId' in bare), '缺省 workdir 落空串、无 agentId 不产键')
  const { deps, calls } = makeHostDeps()
  const host = new PetHost(deps)
  const made = host.createTask({ title: ' 帮我建个草稿 ', prompt: ' 只起草，别跑 ' })
  ok(made.ok === true && made.parked === true && made.taskId === 'task_1', '草稿创建成功（parked 恒 true）')
  ok(calls.drafts.length === 1 && calls.drafts[0].title === '帮我建个草稿' && calls.drafts[0].prompt === '只起草，别跑', '落点收到的入参已归一')
  const rejected = host.createTask({ title: '   ', prompt: 'x' })
  const rejected2 = host.createTask({ title: 't', prompt: '' })
  ok(rejected.ok === false && !!rejected.reason && rejected2.ok === false, '空标题/空内容拒收')
  ok(calls.drafts.length === 1, '拒收路径不触达建任务落点')
  const boom = makeHostDeps()
  boom.deps.createDraftTask = () => { throw new Error('store 炸了') }
  const failedCall = new PetHost(boom.deps).createTask({ title: 't', prompt: 'p' })
  ok(failedCall.ok === false && failedCall.reason === 'store 炸了', '落点异常收拢为 ok:false + reason（不外抛）')
}

console.log('—— deck.annotateTask：独立批注通道（不走 @mention 评论路径）——')
{
  const { deps, calls } = makeHostDeps({ resolveTask: (taskId) => (taskId === 't1' ? { issueId: 'iss_1' } : { issueId: undefined }) })
  const host = new PetHost(deps)
  const r1 = host.annotateTask({ taskId: 't1', text: ' 宠物批注：这个任务的主人很棒 ' })
  ok(r1.ok === true && r1.issueId === 'iss_1', '按 taskId 反查 issueId 批注成功')
  ok(calls.annotations.length === 1 && calls.annotations[0].text === '宠物批注：这个任务的主人很棒', '批注原文直达 addComment 落点（不经 mention 解析）')
  ok(calls.drafts.length === 0, '批注不建任务、不触发执行（对比 issues:add-comment 的 @mention 坑）')
  const r2 = host.annotateTask({ taskId: 't404', text: 'x' })
  ok(r2.ok === true && r2.issueId === 'iss_t404', '反查不到 issueId 时按 iss_<taskId> 惯例兜底')
  const r3 = host.annotateTask({ issueId: 'iss_direct', text: '直达' })
  ok(r3.ok === true && r3.issueId === 'iss_direct' && calls.annotations[2].issueId === 'iss_direct' && calls.annotations[2].text === '直达', 'issueId 直达通道')
  const bad = host.annotateTask({ taskId: 't1', text: '   ' })
  const bad2 = host.annotateTask({ text: 'x' })
  ok(bad.ok === false && bad2.ok === false && !!bad2.reason, '空文本/无定位拒收')
  const boom = makeHostDeps()
  boom.deps.annotateIssue = () => { throw new Error('评论落点炸了') }
  const failedCall = new PetHost(boom.deps).annotateTask({ issueId: 'iss_1', text: 'x' })
  ok(failedCall.ok === false && failedCall.reason === '评论落点炸了', '落点异常收拢为 ok:false（不外抛）')
}

console.log('—— pet.json：开关位持久化（默认全开 + 脏数据容错）——')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-pet-host-'))
  const store = new PetStore(dir)
  ok(JSON.stringify(store.get().hostSwitches) === JSON.stringify(DEFAULT_PET_HOST_SWITCHES), '新配置开关位默认全开')
  store.setHostSwitches({ ...DEFAULT_PET_HOST_SWITCHES, taskDone: false, workflowMilestone: ' junk ' })
  const snap = store.get().hostSwitches
  ok(snap.taskDone === false && snap.workflowMilestone === true, '写入归一：非法位回默认开')
  const reopened = new PetStore(dir).get().hostSwitches
  ok(reopened.taskDone === false && reopened.taskRunning === true && reopened.boardSnapshot === true, '重开读取持久化开关位')
  const mutated = store.get()
  mutated.hostSwitches.taskDone = true
  ok(store.get().hostSwitches.taskDone === false, 'get() 返回开关位副本（外部改不动存储）')
  fs.writeFileSync(path.join(dir, 'pet.json'), JSON.stringify({ ...store.get(), hostSwitches: 'junk' }))
  ok(new PetStore(dir).get().hostSwitches.taskDone === true, '脏 hostSwitches 整体回默认全开')
  fs.writeFileSync(path.join(dir, 'pet.json'), '{corrupt!!!')
  ok(new PetStore(dir).get().hostSwitches.boardSnapshot === true, '坏文件回退默认（开关位不炸启动）')
}

if (failed) { console.error(`\n❌ PET HOST SMOKE FAILED (${failed})`); process.exit(1) }
console.log('\n✅ PET HOST SMOKE PASSED')
