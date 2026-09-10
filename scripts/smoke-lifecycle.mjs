// 生命周期/事件门冒烟（TurnLifecycle + EventGate 端到端时序回归）。
// runner 内的生命周期语义：turnGen 代际闸 + 空转看门狗 + pendingResume 门；
// 事件门：makeEvents 的 active()（任务 running 且代际匹配才放行落盘/推进）。
// 场景对应验收清单：看门狗超时→自动重试→旧会话迟到终态、resume 续聊迟到终态、
// 取消后延迟事件与迟到 sessionId、看门狗下并发会话隔离、启动挂死后迟到 reject、
// 取消竞速不误报「失败」通知。
process.env.AGENTDECK_TURN_IDLE_MS = '300'
process.env.AGENTDECK_RETRY_DELAY_MS = '0'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const root = path.resolve(import.meta.dirname, '..')
for (const [src, out] of [
  ['src/main/runner.ts', 'out/sl-runner.cjs'],
  ['src/main/store.ts', 'out/sl-store.cjs']
]) {
  await build({ entryPoints: [path.join(root, src)], outfile: path.join(root, out), bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['electron'] })
}
const { TaskRunner } = await import(pathToFileURL(path.join(root, 'out/sl-runner.cjs')).href)
const { TaskStore } = await import(pathToFileURL(path.join(root, 'out/sl-store.cjs')).href)

const assert = (cond, msg) => { if (!cond) { console.error('❌ ASSERT FAIL:', msg); process.exit(1) } console.log('  ✓', msg) }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
/** 轮询直到 cond 成立或超时（返回最终值） */
async function until(fn, ms = 8000) {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > ms) return v
    await wait(25)
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-lifecycle-'))
const store = new TaskStore(tmp)

// ---- 场景 1：看门狗超时 → 自动重试（续会话）→ 旧会话迟到终态不得污染新回合 ----
// 第一条命：会话建立后首回合静默挂死 → 看门狗判败；stop 拦不住的 provider（现实中的
// 僵尸回合）在重试回合进行中吐出迟到 final/onTurnEnd/onSessionId。
// 注：首回合（含重试/resume 的首回合）由 backend.start 的 prompt 自驱，session.send 只用于追问。
const reiEmitters = []
const reiResumes = []
const reincarnating = {
  id: 'reincarnating', label: 'Reincarnating',
  async probe() { return { ok: true, detail: '' } },
  async start({ events, resumeSessionId }) {
    const n = reiEmitters.push(events)
    reiResumes.push(resumeSessionId ?? null)
    if (n === 1) {
      return { sessionId: 's_gen1', async send() { /* 静默：无事件无心跳无终态 */ }, async stop() {}, async close() {} }
    }
    // 重试命：60ms 后旧会话迟到事件 + 本回合正常终态（迟到者先到）
    setTimeout(() => {
      reiEmitters[0].onEvent({ ts: Date.now(), kind: 'final', text: 'STALE' })
      reiEmitters[0].onTurnEnd({ response: 'STALE', ok: true })
      reiEmitters[0].onSessionId?.('sess_evil')
      events.onEvent({ ts: Date.now(), kind: 'final', text: 'R2' })
      events.onTurnEnd({ response: 'R2', ok: true })
    }, 60)
    return { sessionId: 's_gen2', async send() {}, async stop() {}, async close() {} }
  }
}
const reiNotes = []
const runner1 = new TaskRunner(store, new Map([['reincarnating', reincarnating]]), () => ({ concurrency: 1, mode: 'yolo', notify: true }), undefined, {
  notify: (task, what) => reiNotes.push(`${what}:${task.id}`)
})
const t1 = store.create({ title: '重生任务', prompt: 'p1', workdir: '', backend: 'reincarnating' })
runner1.enqueue(t1)
const done1 = await until(() => ['done', 'failed', 'cancelled'].includes(store.get(t1.id)?.status))
assert(done1 && store.get(t1.id).status === 'done', `看门狗判败后自动重试至 done (got ${store.get(t1.id)?.status})`)
assert(store.get(t1.id).result === 'R2', `结果来自重试回合而非迟到终态 (got ${store.get(t1.id)?.result})`)
assert(reiResumes[1] === 's_gen1', '重试沿用失败前持久化的 session id（续会话）')
assert(store.get(t1.id).sessionId === 's_gen2', `迟到 onSessionId 未覆盖当前会话 (got ${store.get(t1.id)?.sessionId})`)
assert(!store.readEvents(t1.id).some((e) => (e.text ?? '').includes('STALE')), '迟到终态 final 未落盘')
assert(reiNotes.filter((n) => n.startsWith('完成:')).length === 1 && reiNotes.at(-1)?.startsWith('完成:'), `重试成功以「完成」收尾且无迟到失败通知 (${reiNotes.join(',')})`)
const retried = store.readEvents(t1.id).some((e) => e.kind === 'status' && (e.text ?? '').includes('自动重试 1/2'))
assert(retried, '事件流留有自动重试记录')

// ---- 场景 2：续聊 resume 路径的迟到终态（旧 emitter → pendingResume 门）----
// 首回合静默挂死判败（attempt 预置打满关掉自动重试），followUp 走 resume 重建；
// 重建回合进行中旧会话吐迟到终态——sendTurn 的等待只能由本回合终态裁决。
const ghostEmitters = []
const ghostResumes = []
const ghost = {
  id: 'ghost', label: 'Ghost',
  async probe() { return { ok: true, detail: '' } },
  async start({ events, resumeSessionId }) {
    ghostEmitters.push(events)
    if (ghostEmitters.length === 1) {
      return { sessionId: 's_ghost1', async send() { /* 首回合静默挂死 */ }, async stop() {}, async close() {} }
    }
    ghostResumes.push(resumeSessionId ?? null)
    // 续聊 resume：start 自驱回合；100ms 时旧会话迟到终态先到，本回合终态随后
    setTimeout(() => {
      ghostEmitters[0].onTurnEnd({ response: 'STALE-FU', ok: true })
      events.onEvent({ ts: Date.now(), kind: 'final', text: 'FU-OK' })
      events.onTurnEnd({ response: 'FU-OK', ok: true })
    }, 100)
    return { sessionId: 's_ghost2', async send() {}, async stop() {}, async close() {} }
  }
}
const runner2 = new TaskRunner(store, new Map([['ghost', ghost]]), () => ({ concurrency: 1, mode: 'yolo', notify: false }))
const t2 = store.create({ title: '幽灵任务', prompt: 'p2', workdir: '', backend: 'ghost' })
store.update(t2.id, { attempt: 2 })
runner2.enqueue(t2)
await until(() => store.get(t2.id)?.status === 'failed')
assert((store.get(t2.id).error ?? '').includes('回合超时'), '静默首回合按空转判败')
const fu = await runner2.followUp(t2.id, '还在吗')
await until(() => store.get(t2.id)?.status === 'done')
assert(fu.ok, '续聊 resume 成功')
assert(store.get(t2.id).result === 'FU-OK', `续聊结果来自本回合而非迟到终态 (got ${store.get(t2.id)?.result})`)
assert(ghostResumes[0] === 's_ghost1', '续聊按持久化 session id 重建会话')
assert(store.get(t2.id).sessionId === 's_ghost2', '续聊后登记新会话 id')
assert(!store.readEvents(t2.id).some((e) => (e.text ?? '').includes('STALE')), '续聊回合未吸收迟到终态')

// ---- 场景 3：取消后延迟事件全被事件门挡下 + 取消不误报「失败」通知 ----
const lingEmitters = []
const lingering = {
  id: 'lingering', label: 'Lingering',
  async probe() { return { ok: true, detail: '' } },
  async start({ events }) {
    lingEmitters.push(events)
    // 首回合挂死，但取消后仍会短暂外溢的迟到事件流（真实 provider 的收尾抖动）
    setTimeout(() => events.onEvent({ ts: Date.now(), kind: 'text', text: 'stray-delta' }), 150)
    setTimeout(() => events.onSessionId?.('sess_evil'), 180)
    setTimeout(() => {
      events.onEvent({ ts: Date.now(), kind: 'final', text: 'STRAY RESULT' })
      events.onTurnEnd({ response: 'STRAY RESULT', ok: true })
    }, 210)
    return { sessionId: 's_live', async send() { await new Promise((r) => setTimeout(r, 10000)) }, async stop() {}, async close() {} }
  }
}
const lingNotes = []
const runner3 = new TaskRunner(store, new Map([['lingering', lingering]]), () => ({ concurrency: 1, mode: 'yolo', notify: true }), undefined, {
  notify: (task, what) => lingNotes.push(what)
})
const t3 = store.create({ title: '徘徊任务', prompt: 'p3', workdir: '', backend: 'lingering' })
runner3.enqueue(t3)
await until(() => store.get(t3.id)?.sessionId === 's_live')
const c3 = await runner3.cancel(t3.id)
await wait(400)
assert(c3.ok && store.get(t3.id).status === 'cancelled', '运行中任务取消保持 cancelled')
const evs3 = store.readEvents(t3.id)
assert(!evs3.some((e) => (e.text ?? '').includes('stray-delta') || (e.text ?? '').includes('STRAY RESULT')), '取消后的迟到 text/final 事件未落盘')
assert(store.get(t3.id).sessionId === 's_live', `取消后的迟到 onSessionId 未覆盖会话 (got ${store.get(t3.id)?.sessionId})`)
assert(lingNotes.length === 0, `取消竞速不弹「失败/完成」通知 (${lingNotes.join(',')})`)
const count3 = evs3.length
await wait(150)
assert(store.readEvents(t3.id).length === count3, '取消后事件数不再增长')

// ---- 场景 4：看门狗下的并发会话隔离（A 静默超时，B 心跳续命照常完成）----
const mixedEmitters = {}
const mixedStop = []
const mixed = {
  id: 'mixed', label: 'Mixed',
  async probe() { return { ok: true, detail: '' } },
  async start({ prompt, events }) {
    const name = prompt.includes('silent-a') ? 'a' : 'b'
    mixedEmitters[name] = events
    if (name === 'a') {
      // 首回合静默挂死 → 看门狗判败
      return { sessionId: 's_a', async send() {}, async stop() { mixedStop.push('a') }, async close() {} }
    }
    // B 首回合心跳续命后正常收尾
    const beats = setInterval(() => events.onHeartbeat?.(), 60)
    setTimeout(() => {
      clearInterval(beats)
      events.onEvent({ ts: Date.now(), kind: 'final', text: 'B-DONE' })
      events.onTurnEnd({ response: 'B-DONE', ok: true })
    }, 500)
    return { sessionId: 's_b', async send() {}, async stop() { mixedStop.push('b') }, async close() {} }
  }
}
const runner4 = new TaskRunner(store, new Map([['mixed', mixed]]), () => ({ concurrency: 2, mode: 'yolo', notify: false }))
const t4a = store.create({ title: '并发A', prompt: 'silent-a', workdir: '', backend: 'mixed' })
store.update(t4a.id, { attempt: 2 })
const t4b = store.create({ title: '并发B', prompt: 'busy-b', workdir: '', backend: 'mixed' })
runner4.enqueue(t4a)
runner4.enqueue(t4b)
await until(() => store.get(t4a.id)?.status === 'failed' && store.get(t4b.id)?.status === 'done')
assert(store.get(t4a.id).status === 'failed' && (store.get(t4a.id).error ?? '').includes('回合超时'), '并发 A 静默回合超时判败')
assert(store.get(t4b.id).status === 'done' && store.get(t4b.id).result === 'B-DONE', '并发 B 心跳续命照常完成且结果完整')
assert(mixedStop.includes('a') && !mixedStop.includes('b'), '超时只停 A 的会话，不波及 B')
mixedEmitters.b.onEvent({ ts: Date.now(), kind: 'text', text: 'post-done-noise' })
const countB = store.readEvents(t4b.id).length
await wait(120)
assert(store.readEvents(t4b.id).length === countB && !store.readEvents(t4b.id).some((e) => (e.text ?? '').includes('post-done-noise')), '终态后迟到的 text 事件被事件门丢弃')

// ---- 场景 5：启动挂死 → 看门狗先判败；迟到的启动失败不得改写终态或崩溃 ----
const lateReject = { stopped: false }
const lateslow = {
  id: 'lateslow', label: 'LateSlow',
  async probe() { return { ok: true, detail: '' } },
  async start({ events }) {
    events.onLaunch?.({ stop: () => { lateReject.stopped = true } })
    return new Promise((_, reject) => setTimeout(() => reject(new Error('late boot failure')), 700))
  }
}
const slowNotes = []
const runner5 = new TaskRunner(store, new Map([['lateslow', lateslow]]), () => ({ concurrency: 1, mode: 'yolo', notify: true }), undefined, {
  notify: (task, what) => slowNotes.push(what)
})
const t5 = store.create({ title: '晚败任务', prompt: 'p5', workdir: '', backend: 'lateslow' })
store.update(t5.id, { attempt: 2 })
runner5.enqueue(t5)
await until(() => store.get(t5.id)?.status === 'failed')
assert((store.get(t5.id).error ?? '').includes('回合超时'), '启动挂死由看门狗按超时裁决')
assert(lateReject.stopped, '看门狗触发启动停止句柄')
assert(slowNotes.filter((n) => n === '失败').length === 1, `真实失败恰好弹一次「失败」通知 (${slowNotes.join(',')})`)
await wait(500)
assert(store.get(t5.id).status === 'failed' && (store.get(t5.id).error ?? '').includes('回合超时'), '迟到的启动 reject 未改写终态')

await runner1.shutdown()
await runner2.shutdown()
await runner3.shutdown()
await runner4.shutdown()
await runner5.shutdown()
console.log('\n✅ LIFECYCLE SMOKE PASSED')
process.exit(0)
