// 队列重启恢复冒烟：硬切(<continue>)后继任务以 queued 落库，排队启动依赖事件
// （enqueue / 上一跑落幕触发 pump）。应用在窗口期重启后事件源全消失，任务永远滞留
// 排队——且非 parked 的排队任务在 UI 没有任何启动入口。本冒烟复现缺口并验证
// 启动对账恢复（与 src/main/index.ts 的启动对账循环保持同逻辑）。
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

// 看门狗短空转上限（必须在导入 runner 产物前设置：模块初始化时读取）
process.env.AGENTDECK_TURN_IDLE_MS = '3000'

const root = path.resolve(import.meta.dirname, '..')
for (const [src, out] of [
  ['src/main/runner.ts', 'out/sqr-runner.cjs'],
  ['src/main/store.ts', 'out/sqr-store.cjs']
]) {
  await build({ entryPoints: [path.join(root, src)], outfile: path.join(root, out), bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['electron'] })
}
const { TaskRunner } = await import(pathToFileURL(path.join(root, 'out/sqr-runner.cjs')).href)
const { TaskStore } = await import(pathToFileURL(path.join(root, 'out/sqr-store.cjs')).href)

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-queue-recovery-'))

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
  // 两类重启时正在执行的任务：日志尾部有 final（实际做完，状态没来得及落盘）/ 没有 final（真中断）
  const finished = store.create({ title: '中断有final', prompt: 'f', workdir: '', backend: 'fake' })
  store.appendEvent(finished.id, { ts: Date.now(), kind: 'final', text: '输出其实完成了' })
  store.update(finished.id, { status: 'running', startedAt: Date.now() })
  const interrupted = store.create({ title: '中断无final', prompt: 'n', workdir: '', backend: 'fake' })
  store.update(interrupted.id, { status: 'running', startedAt: Date.now() })
  // 多回合任务：上一回合的 final 之后又开始了新回合（有后续事件）——不得按旧 final 抢救成 done
  const staleFinal = store.create({ title: '中断旧final', prompt: 's', workdir: '', backend: 'fake' })
  store.appendEvent(staleFinal.id, { ts: Date.now(), kind: 'final', text: '上一回合的结果' })
  store.appendEvent(staleFinal.id, { ts: Date.now(), kind: 'user', text: '追问：继续' })
  store.update(staleFinal.id, { status: 'running', startedAt: Date.now() })
}

// ---- 阶段 2（重启后）：新 Runner 实例，计数器从零开始，队列纯事件驱动 ----
const store = new TaskStore(dir)
const runner = new TaskRunner(store, new Map([['fake', makeBackend()]]), () => ({ concurrency: 1, mode: 'auto', notify: false }))
const byTitle = (t) => store.list().find((item) => item.title === t)
const succ = byTitle('▶ 阶段2')

await sleep(400)
assert(succ?.status === 'queued', '重启后硬切后继任务保持 queued（复现缺口：无人再泵队列）')

// ---- 启动对账（镜像 src/main/index.ts 的恢复循环）----
// ① running 僵尸：store 加载迁移已把它们翻成 failed 并登记，对账按登记清单留痕/抢救。
//    不能按 status==='running' 过滤——轮到对账时早已被翻走，一条都匹配不到，
//    时间线就会永远死止在最后一刻（比如"⟳ 自动重试 1/2"）。
const drained = store.drainRestartInterrupted()
assert(drained.length === 3 && drained.every((t) => t.status === 'failed'), '加载迁移把僵尸 running 翻成 failed 并登记（drain 一次拿全）')
assert(store.drainRestartInterrupted().length === 0, 'drain 一次性（重复调用为空，不会重复留痕）')
for (const stale of drained) {
  const events = store.readEvents(stale.id)
  // 只有 final 是日志最后一个事件才抢救；旧回合 final 后还有新回合事件 = 后继回合被打断
  const lastEvent = events[events.length - 1]
  const lastFinal = lastEvent?.kind === 'final' && lastEvent.text ? lastEvent : undefined
  const note = store.appendEvent(stale.id, { ts: Date.now(), kind: 'status', text: lastFinal ? '对账：补记完成' : '对账：中断留痕' })
  if (note) runner.pushEvent(stale.id, note)
  store.update(stale.id, lastFinal ? { status: 'done', endedAt: lastFinal.ts, result: lastFinal.text } : { status: 'failed', endedAt: Date.now() })
}
const rescued = byTitle('中断有final')
assert(rescued?.status === 'done' && rescued.result === '输出其实完成了', '日志尾部有 final 的僵尸任务恢复为 done 并带回结果')
const lost = byTitle('中断无final')
assert(lost?.status === 'failed' && !!lost.error, '无 final 的僵尸任务保持 failed（错误信息保留「请重新运行」指引）')
assert(store.readEvents(lost.id).some((e) => e.kind === 'status' && e.text === '对账：中断留痕'), '中断任务时间线留有说明（不再死止于最后一次自动重试）')
const staleFinal = byTitle('中断旧final')
assert(staleFinal?.status === 'failed' && staleFinal.result === undefined, '旧回合 final 后有新回合事件：不按旧 final 抢救（后继回合真被打断）')

// ② queued 对账
for (const stale of store.list().filter((task) => task.status === 'queued' && !task.parked)) {
  if (stale.goalId || stale.parentTaskId) {
    const note = store.appendEvent(stale.id, { ts: Date.now(), kind: 'status', text: '启动对账：应用重启，排队任务挂起待确认（可手动启动）' })
    store.update(stale.id, { parked: true })
    if (note) runner.pushEvent(stale.id, note)
  } else {
    const note = store.appendEvent(stale.id, { ts: Date.now(), kind: 'status', text: '启动对账：恢复上次排队中的执行' })
    if (note) runner.pushEvent(stale.id, note)
    runner.enqueue(store.get(stale.id) ?? stale)
  }
}

assert(await until(() => store.get(succ.id)?.status === 'done'), '恢复入队后后继任务执行到 done')
assert(store.readEvents(succ.id).some((e) => e.kind === 'status' && e.text?.includes('启动对账')), '时间线留有恢复说明事件')
// goal/worker 挂起后 pump 永远跳过：等后继任务落幕再验一次（验证不是“暂缓”而是真不跑）
await sleep(400)
runner.enqueue(store.get(succ.id) ?? succ) // 制造一次 pump，模拟任意后续事件
await sleep(400)
assert(byTitle('goal阶段')?.status === 'queued' && byTitle('goal阶段')?.parked, 'goal 绑定的排队任务被挂起，后续 pump 不再扫走')
assert(byTitle('worker')?.status === 'queued' && byTitle('worker')?.parked, '委派 worker 排队任务被挂起（委派循环已死）')
assert(byTitle('parked')?.status === 'queued' && byTitle('parked')?.parked, 'parked 任务保持待启动')

console.log('\n✅ 队列重启恢复冒烟通过')
