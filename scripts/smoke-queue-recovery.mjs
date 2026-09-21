// 队列重启恢复冒烟：硬切(<continue>)后继任务以 queued 落库，排队启动依赖事件
// （enqueue / 上一跑落幕触发 pump）。应用在窗口期重启后事件源全消失，任务永远滞留
// 排队——且非 parked 的排队任务在 UI 没有任何启动入口。本冒烟复现缺口并验证
// 启动对账恢复（与 src/main/index.ts 的启动对账循环保持同逻辑）。
//
// 重启后的 running 只有在**执行身份被证实已死**时才是僵尸：活跃或身份不可读的记录
// 一律保留。接管统一走 store.recoverDeadRuns（锁外探活 + 锁内按捕获身份条件提交），
// 且对账的每一笔写入都带上捕获的身份，绝不覆盖期间出现的替换运行。
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

// 看门狗短空转上限（必须在导入 runner 产物前设置：模块初始化时读取）
process.env.AGENTDECK_TURN_IDLE_MS = '3000'

const root = path.resolve(import.meta.dirname, '..')
for (const [src, out] of [
  ['src/main/runner.ts', 'out/sqr-runner.cjs'],
  ['src/main/store.ts', 'out/sqr-store.cjs'],
  ['src/main/persistence.ts', 'out/sqr-persistence.cjs']
]) {
  await build({ entryPoints: [path.join(root, src)], outfile: path.join(root, out), bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['electron'] })
}
const { TaskRunner } = await import(pathToFileURL(path.join(root, 'out/sqr-runner.cjs')).href)
const { TaskStore } = await import(pathToFileURL(path.join(root, 'out/sqr-store.cjs')).href)
const { probeProcess, processOwnerState, currentProcessIdentity } = await import(pathToFileURL(path.join(root, 'out/sqr-persistence.cjs')).href)

const assert = (cond, msg) => { if (!cond) { console.error('❌', msg); process.exit(1) } console.log('  ✓', msg) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 5000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (fn()) return true; await sleep(50) }
  return fn()
}

function makeBackend() {
  return {
    id: 'fake', label: 'Fake',
    async probe() { return { ok: true, detail: 'fake' } },
    async start({ events }) {
      setTimeout(() => {
        events.onEvent({ ts: Date.now(), kind: 'final', text: '阶段完成' })
        events.onTurnEnd({ response: '阶段完成', ok: true })
      }, 30)
      return {
        sessionId: 'sess_' + Math.random().toString(36).slice(2, 8),
        async send() {}, async stop() {}, async close() {}
      }
    }
  }
}

/** Real, provably dead execution identity: observe a live child, then stop it. */
async function deadExecutionOwner() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true })
  let observed
  for (let i = 0; i < 120; i++) {
    observed = probeProcess(child.pid)
    if (observed.state === 'alive' && observed.instance) break
    await sleep(50)
  }
  if (observed?.state !== 'alive' || !observed.instance) {
    child.kill()
    throw new Error(`cannot observe a strong child process identity on ${process.platform}: ${JSON.stringify(observed)}`)
  }
  child.kill()
  await new Promise((resolve) => child.on('exit', resolve))
  const owner = { pid: child.pid, instance: observed.instance, token: 'dead-worker-token', leaseExpiresAt: Date.now() - 60000 }
  if (processOwnerState(owner) !== 'dead') throw new Error('the stopped child is not proven dead; refusing to build the fixture')
  return owner
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-queue-recovery-'))
const deadOwner = await deadExecutionOwner()
const liveOwner = { ...currentProcessIdentity(), token: 'live-owner-token', leaseExpiresAt: Date.now() - 60000 }

// ---- 阶段 1（重启前）：硬切后继任务以 queued 落库但不入队执行，随后应用退出 ----
{
  const store = new TaskStore(dir)
  const source = store.create({ title: '阶段1', prompt: '做阶段1', workdir: '', backend: 'fake', trigger: 'assignment', issueId: 'iss_x' })
  store.update(source.id, { status: 'done', endedAt: Date.now(), result: '阶段1完成' })
  // createHandoffTask 的产物：trigger=handoff、continuesFrom、非 parked、无 goalId/parentTaskId
  store.create({ title: '▶ 阶段2', prompt: '做阶段2', workdir: '', backend: 'fake', trigger: 'handoff', issueId: 'iss_x', continuesFrom: source.id })
  // 三类不应被自动恢复的遗留排队任务
  store.create({ title: 'goal阶段', prompt: 'g', workdir: '', backend: 'fake', issueId: 'iss_g', goalId: 'goal_1' })
  store.create({ title: 'worker', prompt: 'w', workdir: '', backend: 'fake', parentTaskId: source.id })
  store.create({ title: 'parked', prompt: 'p', workdir: '', backend: 'fake', parked: true })
  // 重启时正在执行的任务（①）：执行身份已死——日志尾部有 final（实际做完，状态没来得及
  // 落盘）/ 没有 final（真中断）/ 旧回合 final 后又有新回合事件（后继回合被打断）
  const finished = store.create({ title: '中断有final', prompt: 'f', workdir: '', backend: 'fake' })
  store.appendEvent(finished.id, { ts: Date.now(), kind: 'final', text: '输出其实完成了' })
  const interrupted = store.create({ title: '中断无final', prompt: 'n', workdir: '', backend: 'fake' })
  const staleFinal = store.create({ title: '中断旧final', prompt: 's', workdir: '', backend: 'fake' })
  store.appendEvent(staleFinal.id, { ts: Date.now(), kind: 'final', text: '上一回合的结果' })
  store.appendEvent(staleFinal.id, { ts: Date.now(), kind: 'user', text: '追问：继续' })
  for (const [task, runId] of [[finished, 'run_finished'], [interrupted, 'run_interrupted'], [staleFinal, 'run_stale_final']]) {
    store.update(task.id, { status: 'running', startedAt: Date.now(), runId, executionOwner: deadOwner })
  }
  // ② 身份未知的 running：没有执行归属，租约更像过期——绝不能被当成死亡证据接管
  const unknown = store.create({ title: '未知身份运行中', prompt: 'u', workdir: '', backend: 'fake' })
  store.update(unknown.id, { status: 'running', startedAt: Date.now(), runId: 'run_unknown_identity' })
  // ③ 租约已过期但进程仍然活着：租约过期不是死亡证据
  const live = store.create({ title: '活跃运行中', prompt: 'l', workdir: '', backend: 'fake' })
  store.update(live.id, { status: 'running', startedAt: Date.now(), runId: 'run_live_owner', executionOwner: liveOwner })
}

// ---- 阶段 2（重启后）：新 Runner 实例，计数器从零开始，队列纯事件驱动 ----
const store = new TaskStore(dir)
const runner = new TaskRunner(store, new Map([['fake', makeBackend()]]), () => ({ concurrency: 1, mode: 'auto', notify: false }))
const byTitle = (t) => store.list().find((item) => item.title === t)
const succ = byTitle('▶ 阶段2')

await sleep(400)
assert(succ?.status === 'queued', '重启后硬切后继任务保持 queued（复现缺口：无人再泵队列）')

// ---- 启动对账（镜像 src/main/index.ts 的恢复循环）----
// ① running 僵尸：只有执行身份被证实已死的运行才由 recoverDeadRuns 接管；接管本身会往
//    时间线追加恢复事件，所以先记下接管前的日志尾部，再按捕获身份条件落对账结论。
//    不能按 status==='running' 过滤接管结果——返回的是接管前的捕获身份。
const startupTails = new Map(store.list()
  .filter((task) => task.status === 'running')
  .map((task) => [task.id, store.readEvents(task.id)]))
const deadRuns = store.recoverDeadRuns('failed')
assert(deadRuns.length === 3 && deadRuns.every((t) => t.status === 'running'), '只有死执行身份的运行被接管（返回的是接管前捕获的身份）')
assert(store.recoverDeadRuns('failed').length === 0, '死运行只认领一次（第二次接管为空）')
for (const stale of deadRuns) {
  const events = startupTails.get(stale.id) ?? []
  // 只有 final 是日志最后一个事件才抢救；旧回合 final 后还有新回合事件 = 后继回合被打断
  const lastEvent = events[events.length - 1]
  const lastFinal = lastEvent?.kind === 'final' && lastEvent.text ? lastEvent : undefined
  const captured = { status: 'failed', runId: stale.runId, executionOwner: stale.executionOwner }
  const note = store.appendEvent(stale.id, { ts: Date.now(), kind: 'status', text: lastFinal ? '对账：补记完成' : '对账：中断留痕' }, captured)
  if (note) runner.pushEvent(stale.id, note)
  store.updateIf(stale.id, captured, lastFinal
    ? { status: 'done', endedAt: lastFinal.ts, result: lastFinal.text, error: undefined }
    : { status: 'failed', endedAt: Date.now(), error: '应用重启导致任务中断，请重新运行' })
}
const rescued = byTitle('中断有final')
assert(rescued?.status === 'done' && rescued.result === '输出其实完成了', '日志尾部有 final 的僵尸任务恢复为 done 并带回结果')
const lost = byTitle('中断无final')
assert(lost?.status === 'failed' && !!lost.error, '无 final 的僵尸任务保持 failed（错误信息保留「请重新运行」指引）')
assert(store.readEvents(lost.id).some((e) => e.kind === 'status' && e.text === '对账：中断留痕'), '中断任务时间线留有说明（不再死止于最后一次自动重试）')
const staleFinal = byTitle('中断旧final')
assert(staleFinal?.status === 'failed' && staleFinal.result === undefined, '旧回合 final 后有新回合事件：不按旧 final 抢救（后继回合真被打断）')
// 捕获身份必须挡住陈旧对账：替换运行上的对账写入不得生效
assert(store.updateIf(lost.id, { status: 'failed', runId: 'run_replaced', executionOwner: deadOwner }, { result: '陈旧对账写入' }) === undefined, '陈旧 runId 的对账写入被拒绝')
assert(store.get(lost.id).result === undefined, '陈旧对账没有污染记录')
const unknown = byTitle('未知身份运行中')
assert(unknown?.status === 'running' && unknown.runId === 'run_unknown_identity' && unknown.executionOwner === undefined, '身份未知的 running 不被接管（租约过期不是死亡证据）')
const live = byTitle('活跃运行中')
assert(live?.status === 'running' && live.runId === 'run_live_owner', '租约已过期但进程仍活着的 running 不被接管')

// ② queued 对账
for (const stale of store.list().filter((task) => task.status === 'queued' && !task.parked)) {
  const captured = { status: 'queued', runId: stale.runId, executionOwner: stale.executionOwner }
  if (stale.goalId || stale.parentTaskId) {
    const note = store.appendEvent(stale.id, { ts: Date.now(), kind: 'status', text: '启动对账：应用重启，排队任务挂起待确认（可手动启动）' }, captured)
    store.updateIf(stale.id, captured, { parked: true })
    if (note) runner.pushEvent(stale.id, note)
  } else {
    const note = store.appendEvent(stale.id, { ts: Date.now(), kind: 'status', text: '启动对账：恢复上次排队中的执行' }, captured)
    if (note) runner.pushEvent(stale.id, note)
    runner.enqueue(store.get(stale.id) ?? stale)
  }
}

assert(await until(() => store.get(succ.id)?.status === 'done'), '恢复入队后后继任务执行到 done')
assert(store.readEvents(succ.id).some((e) => e.kind === 'status' && e.text?.includes('启动对账')), '时间线留有恢复说明事件')
assert(byTitle('未知身份运行中')?.status === 'running', '排队对账不会顺带接管身份未知的运行')
// goal/worker 挂起后 pump 永远跳过：等后继任务落幕再验一次（验证不是“暂缓”而是真不跑）
await sleep(400)
runner.enqueue(store.get(succ.id) ?? succ) // 制造一次 pump，模拟任意后续事件
await sleep(400)
assert(byTitle('goal阶段')?.status === 'queued' && byTitle('goal阶段')?.parked, 'goal 绑定的排队任务被挂起，后续 pump 不再扫走')
assert(byTitle('worker')?.status === 'queued' && byTitle('worker')?.parked, '委派 worker 排队任务被挂起（委派循环已死）')
assert(byTitle('parked')?.status === 'queued' && byTitle('parked')?.parked, 'parked 任务保持待启动')

console.log('\n✅ 队列重启恢复冒烟通过')
