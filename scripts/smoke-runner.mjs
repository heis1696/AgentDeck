// runner 状态机测试：假后端驱动 queued→running→done / 续聊 / 取消
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

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
      emitter.onEvent({ ts: Date.now(), kind: 'text', text: `[followup:${content}]` })
      behavior.followupCount++
      setTimeout(() => {
        emitter.onEvent({ ts: Date.now(), kind: 'usage', data: { tokenCount: 600, durationMs: 1500 } })
        emitter.onEvent({ ts: Date.now(), kind: 'final', text: '追问回复' })
        emitter.onTurnEnd({ response: '追问回复', ok: true })
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

await runner.shutdown()
console.log('\n✅ RUNNER SMOKE PASSED')
process.exit(0)
