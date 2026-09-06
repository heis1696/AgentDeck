// runner 状态机测试：假后端驱动 queued→running→done / 续聊 / 取消 / 看门狗
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

// 看门狗用短空转上限（必须在导入 runner 产物前设置：模块初始化时读取）
process.env.AGENTDECK_TURN_IDLE_MS = '300'

const root = path.resolve(import.meta.dirname, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-runner-'))

// 打包 store + runner 到一个 CJS
const outfile = path.join(root, 'out', 'smoke-runner.cjs')
await build({
  entryPoints: [path.join(root, 'src/main/runner.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['electron']
})
const { TaskRunner } = await import(pathToFileURL(outfile).href)
// store 单独打一份（每次重建，避免旧缓存）
await build({
  entryPoints: [path.join(root, 'src/main/store.ts')],
  outfile: path.join(root, 'out', 'smoke-store.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['electron']
})
const { TaskStore } = await import(pathToFileURL(path.join(root, 'out', 'smoke-store.cjs')).href)

const store = new TaskStore(tmp)

// ---- 假后端 ----
function makeFakeBackend() {
  /** @type {any} */
  let session
  const makeSession = (emitter, behavior) => ({
    sessionId: 'sess_fake_' + Math.random().toString(36).slice(2, 8),
    async send(content) {
      const isTitleTurn = content.includes('重起一个简短标题')
      emitter.onEvent({ ts: Date.now(), kind: 'text', text: `[followup:${content}]` })
      behavior.followupCount++
      setTimeout(() => {
        emitter.onEvent({ ts: Date.now(), kind: 'usage', data: { tokenCount: 600, durationMs: 1500 } })
        emitter.onEvent({ ts: Date.now(), kind: 'final', text: isTitleTurn ? '修复登录超时问题' : '追问回复' })
        emitter.onTurnEnd({ response: isTitleTurn ? '修复登录超时问题' : '追问回复', ok: true })
      }, 30)
      await new Promise((r) => setTimeout(r, 60))
    },
    async stop() { behavior.stopped = true },
    async close() { behavior.closed = true }
  })
  return {
    id: 'fake',
    label: 'Fake',
    async probe() { return { ok: true, detail: 'fake' } },
    async start({ prompt, events }) {
      const behavior = { followupCount: 0, stopped: false, closed: false }
      session = makeSession(events, behavior)
      // 异步完成首回合
      setTimeout(() => {
        events.onEvent({ ts: Date.now(), kind: 'text', text: '流式片段' })
        events.onEvent({ ts: Date.now(), kind: 'usage', data: { input_tokens: 1200, output_tokens: 300, total_cost_usd: 0.012 } })
        events.onEvent({ ts: Date.now(), kind: 'final', text: `done:${prompt}` })
        events.onTurnEnd({ response: `done:${prompt}`, ok: true })
      }, 50)
      session.__behavior = behavior
      return session
    },
    getBehavior: () => session?.__behavior
  }
}

const backend = makeFakeBackend()
const backends = new Map([[backend.id, backend]])
const runner = new TaskRunner(store, backends, () => ({ concurrency: 1, mode: 'yolo', notify: false }))

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const assert = (cond, msg) => {
  if (!cond) {
    console.error('❌ ASSERT FAIL:', msg)
    process.exit(1)
  }
  console.log('  ✓', msg)
}

// 1. 正常完成
const t1 = store.create({ title: '任务1', prompt: 'hello', workdir: '', backend: 'fake' })
runner.enqueue(t1)
await wait(300)
let cur = store.get(t1.id)
assert(cur.status === 'done', `任务1 done (got ${cur.status})`)
assert(cur.result === 'done:hello', '任务1 result 正确')
assert(cur.eventCount >= 2, `任务1 事件落盘 (${cur.eventCount})`)
const evs = store.readEvents(t1.id)
assert(evs.some((e) => e.kind === 'final' && e.text === 'done:hello'), '事件文件可读回')

// 1b. 自动标题：titleAuto 任务首轮完成后由 agent 重起标题（隐藏回合，不进对话流）
const t1b = store.create({ title: '把这个问题修复一下把这个问题修复一下把这个问题', prompt: '把这个问题修复一下', workdir: '', backend: 'fake', titleAuto: true })
runner.enqueue(t1b)
await wait(400)
cur = store.get(t1b.id)
assert(cur.status === 'done', `标题任务 done (got ${cur.status})`)
assert(cur.title === '修复登录超时问题', `自动重起标题 (got ${cur.title})`)
assert(!cur.titleAuto, '重起后 titleAuto 失效')
const evs1b = store.readEvents(t1b.id)
assert(!evs1b.some((e) => e.kind === 'text' && (e.text ?? '').includes('重起一个简短标题')), '标题回合的指令不进对话流')
assert(!evs1b.some((e) => e.kind === 'final' && e.text === '修复登录超时问题'), '标题回合的回复不进对话流')
assert(evs1b.some((e) => e.kind === 'final' && e.text === 'done:把这个问题修复一下'), '首个 final 保留')

// 2. 续聊
const fu = await runner.followUp(t1.id, '再看看')
await wait(150)
cur = store.get(t1.id)
assert(fu.ok, '续聊返回 ok')
assert(cur.status === 'done', `续聊后 done (got ${cur.status})`)
assert(cur.result === '追问回复', `续聊结果 (got ${cur.result})`)
assert(backend.getBehavior().followupCount === 1, '后端收到追问')

// 2b. 用量聚合：首回合 claude 形状 + 追问 zcode 形状 → Task.usage 累计
const u = cur.usage
assert(!!u, 'usage 已聚合落库')
assert(u.inputTokens === 1200 && u.outputTokens === 300, `input/output 累计 (got ${u?.inputTokens}/${u?.outputTokens})`)
assert(u.totalTokens === 600, `多态 totalTokens 累计 (got ${u?.totalTokens})`)
assert(Math.abs(u.costUsd - 0.012) < 1e-9, `cost 累计 (got ${u?.costUsd})`)
assert(u.durationMs === 1500 && u.turns === 2, `时长/回合数 (got ${u?.durationMs}/${u?.turns})`)

// 3. 排队 + 取消排队
const t2 = store.create({ title: '任务2', prompt: 'world', workdir: '', backend: 'fake' })
// t1 已结束，队列空闲，t2 会立即开跑；直接造一个排队态来测取消排队
const t3 = store.create({ title: '任务3', prompt: 'queued', workdir: '', backend: 'fake' })
store.update(t3.id, { status: 'queued' })
const c3 = await runner.cancel(t3.id)
assert(c3.ok && store.get(t3.id).status === 'cancelled', '排队任务可取消')

// 4. 失败路径
const failBackend = {
  id: 'failer',
  label: 'Failer',
  async probe() { return { ok: true, detail: '' } },
  async start() { throw new Error('boom') }
}
const runner2 = new TaskRunner(store, new Map([[failBackend.id, failBackend]]), () => ({ concurrency: 1, mode: 'yolo', notify: false }))
const t4 = store.create({ title: '任务4', prompt: 'x', workdir: '', backend: 'failer' })
runner2.enqueue(t4)
await wait(150)
assert(store.get(t4.id).status === 'failed', '后端启动失败 → failed')
assert(store.get(t4.id).error === 'boom', '错误信息记录')

// 5. 删除
store.delete(t4.id)
assert(!store.get(t4.id), '任务删除')

// ---- 看门狗（空转上限 300ms）----
// 6. 静默回合（无事件无心跳）→ 超时判败、会话被停、失败可操作
const slowState = { stopped: false }
const slowBackend = {
  id: 'slow',
  label: 'Slow',
  async probe() { return { ok: true, detail: '' } },
  async start() {
    return {
      sessionId: 'sess_slow',
      async send() { /* 静默：既不吐事件也不结束回合 */ },
      async stop() { slowState.stopped = true },
      async close() {}
    }
  }
}
// 心跳后端：整轮不发任何事件，只发线级心跳，超过空转上限后正常收尾
const hbBackend = {
  id: 'hb',
  label: 'HB',
  async probe() { return { ok: true, detail: '' } },
  async start({ events }) {
    const beats = setInterval(() => events.onHeartbeat?.(), 80)
    setTimeout(() => {
      clearInterval(beats)
      events.onEvent({ ts: Date.now(), kind: 'final', text: '沉默但活着' })
      events.onTurnEnd({ response: '沉默但活着', ok: true })
    }, 600)
    return { sessionId: 'sess_hb', async send() {}, async stop() {}, async close() {} }
  }
}
// 挂死后端：backend.start 永不返回，但注册了启动停止句柄
const hangState = { stopped: false }
const hangBackend = {
  id: 'hang',
  label: 'Hang',
  async probe() { return { ok: true, detail: '' } },
  async start({ events }) {
    events.onLaunch?.({ stop: () => { hangState.stopped = true } })
    return new Promise(() => {})
  }
}
const runner3 = new TaskRunner(store, new Map([
  ['slow', slowBackend], ['hb', hbBackend], ['hang', hangBackend], ['fake', backend]
]), () => ({ concurrency: 1, mode: 'yolo', notify: false }))

// 预置 attempt=2 关掉自动重试，让断言只看单次看门狗裁决
const t5 = store.create({ title: '任务5', prompt: 'silence', workdir: '', backend: 'slow' })
store.update(t5.id, { attempt: 2 })
runner3.enqueue(t5)
await wait(500)
cur = store.get(t5.id)
assert(cur.status === 'failed', `静默回合超时判败 (got ${cur.status})`)
assert((cur.error ?? '').includes('回合超时'), '超时错误信息')
assert(cur.failure?.code === 'timeout', `失败分类 timeout (got ${cur.failure?.code})`)
assert(slowState.stopped, '超时后会话被停')

// 失败后仍可操作：追问不会被"任务正在运行"挡住（resume 重建同样受看门狗护送，最终回到 failed）
const fu5 = await runner3.followUp(t5.id, '还在吗')
await wait(100)
assert(!fu5.ok && !(fu5.error ?? '').includes('任务正在运行'), `失败后追问不被运行态卡死 (got ${fu5.error})`)
assert(store.get(t5.id).status === 'failed', '追问超时后回到 failed（终态可操作）')

// 7. 心跳续命：静默但有线级活动的回合不被误杀
const t6 = store.create({ title: '任务6', prompt: 'thinking', workdir: '', backend: 'hb' })
store.update(t6.id, { attempt: 2 })
runner3.enqueue(t6)
await wait(900)
cur = store.get(t6.id)
assert(cur.status === 'done', `心跳续命回合完成 (got ${cur.status})`)
assert(cur.result === '沉默但活着', '心跳回合结果正确')

// 8. backend.start 挂死 → 看门狗判败 + 硬杀启动句柄 + 并发槽释放（后续任务照常执行）
const t7 = store.create({ title: '任务7', prompt: 'hang', workdir: '', backend: 'hang' })
store.update(t7.id, { attempt: 2 })
runner3.enqueue(t7)
await wait(500)
cur = store.get(t7.id)
assert(cur.status === 'failed', `启动挂死判败 (got ${cur.status})`)
assert((cur.error ?? '').includes('回合超时'), '启动挂死按超时上报')
assert(hangState.stopped, '启动停止句柄被调用（挂起进程可被杀）')
// 槽位释放证明：同 runner（concurrency=1）的下一个任务能正常跑完
const t8 = store.create({ title: '任务8', prompt: 'after-hang', workdir: '', backend: 'fake' })
runner3.enqueue(t8)
await wait(400)
cur = store.get(t8.id)
assert(cur.status === 'done', `挂死判败后并发槽已释放，后续任务可执行 (got ${cur.status})`)

await runner.shutdown()
await runner3.shutdown()
console.log('\n✅ RUNNER SMOKE PASSED')
process.exit(0)
