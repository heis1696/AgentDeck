// 回合身份回归（假后端 / 协议 fixture，不启动任何真实 CLI）
//
// 覆盖：普通 follow-up 开始之后，上一回合的迟到终态（成功/失败两种）、普通事件、
// sessionId、权限请求、心跳，以及未知回合 id，都不得裁决 / 污染 / 续命新回合；
// 标题回合与委派回灌回合同样受保护；声明了回合身份的连接可以继续复用，没有可靠
// 标识的连接在归属不可信时改为关连接、按 sessionId 重建（隔离 + 恢复）。
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

// 空转看门狗预算必须早于 runner 产物导入（模块初始化时读取）。
// 400ms 足够覆盖正常断言的往返，又能在心跳场景里快速证伪“旧回合心跳续命”。
process.env.AGENTDECK_TURN_IDLE_MS = '400'
// 标题回合硬预算：用它制造“回合没收终态就被放弃”的隔离场景
process.env.AGENTDECK_RETITLE_MS = '150'

const root = path.resolve(import.meta.dirname, '..')

const outfile = path.join(root, 'out', 'smoke-turn-identity-runner.cjs')
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

await build({
  entryPoints: [path.join(root, 'src/main/store.ts')],
  outfile: path.join(root, 'out', 'smoke-turn-identity-store.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['electron']
})
const { TaskStore } = await import(pathToFileURL(path.join(root, 'out', 'smoke-turn-identity-store.cjs')).href)

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(pred, label, ms = 6000) {
  const t0 = Date.now()
  for (;;) {
    const value = pred()
    if (value) return value
    if (Date.now() - t0 > ms) throw new Error(`until 超时: ${label}`)
    await wait(10)
  }
}
const assert = (cond, msg) => {
  if (!cond) {
    console.error('ASSERT FAIL:', msg)
    process.exit(1)
  }
  console.log('  ok', msg)
}

/**
 * 协议 fixture 假后端：会话把 `start` / `send` 收到的回合身份原样回传（turnScoped），
 * 或完全不回传（老式适配器）。回合何时结束由测试脚本决定，便于精确构造“迟到回调”。
 */
function makeFixtureBackend(id, options = {}) {
  const state = { starts: [], sessions: [], sends: [] }
  const sendWaiters = []
  const notifySend = (entry) => {
    for (let i = sendWaiters.length - 1; i >= 0; i--) {
      if (sendWaiters[i].index !== entry.index) continue
      const waiter = sendWaiters[i]
      sendWaiters.splice(i, 1)
      waiter.resolve(entry)
    }
  }
  const waitForSend = (index) => {
    const existing = state.sends[index]
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve) => sendWaiters.push({ index, resolve }))
  }
  const backend = {
    id,
    label: id,
    async probe() { return { ok: true, detail: '' } },
    async start({ prompt, events, turn, resumeSessionId }) {
      const sessionId = `${id}_sess_${state.starts.length + 1}`
      const session = {
        sessionId,
        ...(options.scoped === false ? {} : { turnScoped: true }),
        closed: false,
        stopped: false,
        turns: [],
        firstTurn: turn,
        async send(content, turnStamp) {
          const entry = { content, turn: turnStamp, index: state.sends.length }
          state.sends.push(entry)
          session.turns.push(entry)
          notifySend(entry)
          options.onSend?.(session, entry)
        },
        async stop() { session.stopped = true },
        async close() { session.closed = true }
      }
      // 会话级通道：fixture 用**显式回合身份**发射，模拟协议回传（老式适配器则不回传）
      session.emitAs = (stamp, e) => events.onEvent({ ts: Date.now(), ...e }, stamp)
      session.endAs = (stamp, r) => events.onTurnEnd(r, stamp)
      session.heartbeatAs = (stamp) => events.onHeartbeat?.(stamp)
      session.sessionIdAs = (stamp, sid) => events.onSessionId?.(sid, stamp)
      session.permissionAs = (stamp, req) => events.onPermission?.(req, stamp) ?? Promise.resolve({ decision: 'deny' })
      state.sessions.push(session)
      state.starts.push({ sessionId, resumeSessionId, turn, prompt })
      if (options.onStart) options.onStart(session, { prompt, turn, resumeSessionId })
      else setTimeout(() => session.endAs(turn, { ok: true, response: options.firstResponse ?? 'first-answer' }), 20)
      return session
    }
  }
  return { backend, state, waitForSend }
}

const newStore = (label) => new TaskStore(fs.mkdtempSync(path.join(os.tmpdir(), `agentdeck-turn-id-${label}-`)))
const permission = (requestId) => ({
  requestId,
  toolName: 'write',
  reason: requestId,
  riskLevel: 'low',
  input: '',
  options: [{ optionId: 'allow', name: 'allow', response: { decision: 'allow' } }]
})

// =====================================================================================
// A. 声明了回合身份的连接：follow-up 期间旧回合的迟到回合一概无效
// =====================================================================================
console.log('\n[A] 旧回合迟到回调不影响 follow-up')
{
  const fx = makeFixtureBackend('scoped-a')
  const store = newStore('a')
  const runner = new TaskRunner(store, new Map([[fx.backend.id, fx.backend]]), () => ({ concurrency: 1, mode: 'yolo', notify: false }))
  const task = store.create({ title: '回合身份', prompt: '第一回合', backend: fx.backend.id })
  runner.enqueue(task)
  await until(() => store.get(task.id)?.status === 'done', '首回合完成')
  assert(store.get(task.id).result === 'first-answer', '首回合结果正确')

  const session = fx.state.sessions[0]
  const stale = fx.state.starts[0].turn
  const fu = await runner.followUp(task.id, '再看看', { wait: false })
  const current = (await fx.waitForSend(0)).turn
  assert(fu.ok, 'follow-up 已受理（wait:false 后台跑）')
  assert(!!stale && !!current && stale.id !== current.id, 'follow-up 拿到新的回合身份')

  // ---- 上一回合的迟到回调：终态（两种）、事件、sessionId、心跳、权限、未知身份
  session.endAs(stale, { ok: true, response: 'LATE-OK' })
  session.endAs(stale, { ok: false, response: '', error: 'LATE-FAIL' })
  session.emitAs(stale, { kind: 'final', text: 'LATE-FINAL' })
  session.emitAs(stale, { kind: 'text', text: 'LATE-TEXT' })
  session.sessionIdAs(stale, 'hijacked-session')
  session.heartbeatAs(stale)
  session.endAs({ seq: 999, id: 'turn_unknown_999' }, { ok: true, response: 'UNKNOWN-STAMP' })
  void session.permissionAs(stale, permission('perm_stale'))
  await wait(40)

  const during = store.get(task.id)
  assert(during.status === 'running', `旧回合迟到终态不结束新回合 (got ${during.status})`)
  assert(during.sessionId !== 'hijacked-session', `旧回合迟到 sessionId 不覆盖会话 (got ${during.sessionId})`)
  const events = store.readEvents(task.id).map((e) => e.text ?? '').join('\n')
  assert(!events.includes('LATE-'), '旧回合迟到事件不落盘')
  assert(!runner.pendingPermissions(task.id).some((p) => p.requestId === 'perm_stale'), '旧回合迟到权限请求不进 broker')

  // ---- 正对照：当前回合的权限请求照常到达并可裁决
  const currentPermission = session.permissionAs(current, permission('perm_current'))
  await until(() => runner.pendingPermissions(task.id).some((p) => p.requestId === 'perm_current'), '当前回合权限请求到达')
  runner.resolvePermission('perm_current', 'allow', 'allow')
  await currentPermission

  // ---- 只有新回合自己的终态能收尾
  session.endAs(current, { ok: true, response: 'SECOND-ANSWER' })
  await until(() => store.get(task.id)?.status === 'done', '新回合正常收尾')
  assert(store.get(task.id).result === 'SECOND-ANSWER', `新回合结果 (got ${store.get(task.id).result})`)
  await runner.shutdown()
}

// =====================================================================================
// B. 旧回合心跳不得给新回合续命（新回合该超时还是超时）
// =====================================================================================
console.log('\n[B] 旧回合心跳不续命新回合')
{
  const fx = makeFixtureBackend('scoped-b')
  const store = newStore('b')
  const runner = new TaskRunner(store, new Map([[fx.backend.id, fx.backend]]), () => ({ concurrency: 1, mode: 'yolo', notify: false }))
  const task = store.create({ title: '心跳', prompt: '第一回合', backend: fx.backend.id })
  runner.enqueue(task)
  await until(() => store.get(task.id)?.status === 'done', '首回合完成')

  const session = fx.state.sessions[0]
  const stale = fx.state.starts[0].turn
  const beats = setInterval(() => session.heartbeatAs(stale), 40)
  const fu = await runner.followUp(task.id, '沉默回合')
  clearInterval(beats)
  assert(!fu.ok, '沉默回合判败')
  assert((store.get(task.id).error ?? '').includes('回合超时'), `超时原因来自本回合空转 (got ${store.get(task.id).error})`)
  assert(session.stopped, '超时后会话被停')
  await runner.shutdown()
}

// =====================================================================================
// C. 标题回合：旧回合迟到且内容不同的终态也不能顶掉标题
// =====================================================================================
console.log('\n[C] 标题回合不被旧回合迟到终态顶掉')
{
  const fx = makeFixtureBackend('scoped-title')
  const store = newStore('c')
  const runner = new TaskRunner(store, new Map([[fx.backend.id, fx.backend]]), () => ({ concurrency: 1, mode: 'yolo', notify: false }))
  const task = store.create({ title: '原始标题', prompt: '帮我看看', backend: fx.backend.id, titleAuto: true })
  runner.enqueue(task)
  const titleSend = await fx.waitForSend(0)
  const session = fx.state.sessions[0]
  const stale = fx.state.starts[0].turn
  assert(titleSend.content.includes('标题'), '隐藏标题回合已开始')

  // 内容与首回合终态不同 → 内容去重挡不住，只能靠回合身份
  session.endAs(stale, { ok: true, response: 'STALE-OLD-TURN' })
  await wait(30)
  assert(store.get(task.id).title === '原始标题', '旧回合迟到终态不改标题')

  session.endAs(titleSend.turn, { ok: true, response: '清晰标题' })
  await until(() => store.get(task.id)?.status === 'done', '标题任务完成')
  assert(store.get(task.id).title === '清晰标题', `标题由本回合终态决定 (got ${store.get(task.id).title})`)
  const logged = store.readEvents(task.id).map((e) => e.text ?? '').join('\n')
  assert(!logged.includes('STALE') && !logged.includes('清晰标题'), '标题回合与旧回合的事件都保持静默')
  await runner.shutdown()
}

// =====================================================================================
// D. 委派回灌：回灌回合不被上一回合的迟到终态顶掉
// =====================================================================================
console.log('\n[D] 委派回灌回合不被旧回合终态顶掉')
{
  const leader = makeFixtureBackend('boss', { firstResponse: '领队就绪' })
  const worker = makeFixtureBackend('worker', { firstResponse: 'worker 完成' })
  const store = newStore('d')
  const runner = new TaskRunner(store, new Map([['boss', leader.backend], ['worker', worker.backend]]), () => ({ concurrency: 1, mode: 'yolo', notify: false, workerConcurrency: 2 }))
  const team = [
    { id: 'L', name: 'Boss', backend: 'boss', role: '领队', systemPrompt: '', subordinates: ['W'] },
    { id: 'W', name: 'Alpha', backend: 'worker', role: '工程师', systemPrompt: '' }
  ]
  runner.attachTeam(() => team)

  const task = store.create({ title: '领队', prompt: '派活', backend: 'boss', agentId: 'L' })
  runner.enqueue(task)
  await until(() => store.get(task.id)?.status === 'done', '领队首回合完成')

  const session = leader.state.sessions[0]
  const fu = await runner.followUp(task.id, '追问派工', { wait: false })
  assert(fu.ok, '追问已受理')
  const dispatchTurn = await leader.waitForSend(0)
  // 这一回合派一个队员：委派循环建单 → 等队员完成 → 在同一会话回灌
  session.endAs(dispatchTurn.turn, {
    ok: true,
    response: '我会在队员完成后汇总。',
    delegationText: '<delegate to="Alpha">复查 a.txt</delegate>'
  })

  const reflowTurn = await leader.waitForSend(1)
  assert(reflowTurn.index === 1, '委派循环在同一会话发起回灌回合')
  assert(reflowTurn.turn.id !== dispatchTurn.turn.id, '回灌回合同样拿到新的回合身份')

  // 回灌进行中：派单回合的迟到终态不得顶掉它
  session.endAs(dispatchTurn.turn, { ok: true, response: 'STALE-DISPATCH' })
  session.emitAs(dispatchTurn.turn, { kind: 'final', text: 'STALE-DISPATCH-EVENT' })
  await wait(30)
  assert(store.get(task.id).status === 'running', '回灌期间任务仍在运行')

  session.endAs(reflowTurn.turn, { ok: true, response: '两个队员都完成了。最终总结：a.txt 已升级。' })
  await until(() => store.get(task.id)?.status === 'done', '领队回灌后收尾')
  const finished = store.get(task.id)
  assert(finished.result.includes('最终总结'), `回灌结果生效 (got ${finished.result.slice(0, 40)})`)
  assert(!finished.result.includes('STALE-DISPATCH'), '旧回合迟到终态没有污染回灌结果')
  assert(store.list().filter((t) => t.parentTaskId === task.id).length === 1, '委派子任务只建一个')
  assert(!store.readEvents(task.id).some((e) => (e.text ?? '').includes('STALE-DISPATCH-EVENT')), '旧回合迟到事件不落盘')
  await runner.shutdown()
}

// =====================================================================================
// E. 没有回合标识的老式连接：首回合兼容，后续一律隔离重建
// =====================================================================================
console.log('\n[E] 无回合标识：首回合兼容，后续隔离重建')
{
  // E1 老式连接无法证明迟到回调来自哪一回合，所以正常追问也重建。
  const legacy = makeFixtureBackend('legacy', {
    scoped: false,
    firstResponse: 'legacy first',
    onSend: (session, entry) => setTimeout(() => session.endAs(undefined, { ok: true, response: `legacy follow ${entry.index + 1}` }), 20)
  })
  const store = newStore('e1')
  const runner = new TaskRunner(store, new Map([['legacy', legacy.backend]]), () => ({ concurrency: 1, mode: 'yolo', notify: false }))
  const task = store.create({ title: '老后端', prompt: '第一回合', backend: 'legacy' })
  runner.enqueue(task)
  await until(() => store.get(task.id)?.status === 'done', '老后端首回合完成')
  const firstSession = legacy.state.sessions[0]
  const follow = await runner.followUp(task.id, '追问')
  assert(follow.ok && store.get(task.id).result === 'legacy first', '老后端追问在隔离连接完成')
  assert(legacy.state.starts.length === 2 && legacy.state.sends.length === 0, '老后端未复用无回合标识的连接')
  assert(legacy.state.starts[1].resumeSessionId === firstSession.sessionId && firstSession.closed, '老后端按原 sessionId 重建并关闭旧连接')
  await runner.shutdown()

  // E2 归属不可信（回合没有终态就被放弃）→ 关连接、按 sessionId 重建
  const legacy2 = makeFixtureBackend('legacy2', {
    scoped: false,
    // 首回合完成；隔离重建的标题回合故意不收尾，追问回合由测试显式裁决。
    onStart: (session, entry) => {
      if (!entry.prompt.includes('重起一个简短标题') && !entry.prompt.includes('重建后再问')) {
        setTimeout(() => session.endAs(undefined, { ok: true, response: 'legacy2 first' }), 20)
      }
    }
  })
  const store2 = newStore('e2')
  const runner2 = new TaskRunner(store2, new Map([['legacy2', legacy2.backend]]), () => ({ concurrency: 1, mode: 'yolo', notify: false }))
  const task2 = store2.create({ title: '原始终端标题', prompt: '第一回合', backend: 'legacy2', titleAuto: true })
  runner2.enqueue(task2)
  await until(() => store2.get(task2.id)?.status === 'done', '标题预算耗尽后任务仍收尾')
  const firstLegacySession = legacy2.state.sessions[0]
  const staleSession = legacy2.state.sessions[1]
  assert(store2.get(task2.id).title === '原始终端标题', '超时的标题回合不改标题')
  assert(firstLegacySession.closed === true, '标题回合先隔离关闭首连接')

  // 迟到回调落在被放弃的回合上：不再被采纳
  staleSession.emitAs(undefined, { kind: 'final', text: 'ABANDONED-TURN-EVENT' })
  staleSession.endAs(undefined, { ok: true, response: 'ABANDONED-TURN-END' })
  await wait(20)
  assert(store2.get(task2.id).status === 'done' && !store2.readEvents(task2.id).some((e) => (e.text ?? '').includes('ABANDONED-TURN')), '被放弃回合的迟到回调不被采纳')

  // 旧连接上只剩"被放弃的标题回合"那一次 send；接下来的追问不得再往它发东西
  const sendsBeforeRebuild = legacy2.state.sends.length
  assert(sendsBeforeRebuild === 0, '无身份连接不承载标题续回合')
  const rebuild = runner2.followUp(task2.id, '重建后再问', { collectFinal: true })
  await until(() => legacy2.state.starts.length === 3, '追问触发隔离重建（新连接）', 4000)
  const rebuilt = legacy2.state.starts[2]
  assert(rebuilt.resumeSessionId === staleSession.sessionId, `重建续用原会话 id (got ${rebuilt.resumeSessionId})`)
  assert(staleSession.closed === true, '旧连接被关闭')
  legacy2.state.sessions[2].endAs(undefined, { ok: true, response: 'rebuilt answer' })
  const rebuiltResult = await rebuild
  assert(rebuiltResult.ok && rebuiltResult.finalText === 'rebuilt answer', `隔离重建后的追问结果 (got ${rebuiltResult.finalText})`)
  assert(legacy2.state.sends.length === sendsBeforeRebuild, '旧连接不再被复用发送')
  await runner2.shutdown()
}

console.log('\nTURN IDENTITY SMOKE PASSED')
process.exit(0)
