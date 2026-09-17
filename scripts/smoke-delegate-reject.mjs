// 派单被拒回灌冒烟：领队派给名单外的目标（不存在的 / 队长）→ 拒单原因回灌 →
// 场景A 改派成功交付；场景B 回合末解析被拒后自行收尾；场景C 顽固重派时有界终止。
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const root = path.resolve(import.meta.dirname, '..')
for (const [src, out] of [
  ['src/main/runner.ts', 'out/sdr-runner.cjs'],
  ['src/main/store.ts', 'out/sdr-store.cjs'],
  ['src/main/delegate.ts', 'out/sdr-delegate.cjs']
]) {
  await build({ entryPoints: [path.join(root, src)], outfile: path.join(root, out), bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['electron'] })
}
const { TaskRunner } = await import(pathToFileURL(path.join(root, 'out/sdr-runner.cjs')).href)
const { TaskStore } = await import(pathToFileURL(path.join(root, 'out/sdr-store.cjs')).href)

const assert = (cond, msg) => { if (!cond) { console.error('❌', msg); process.exit(1) } console.log('  ✓', msg) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 等任务到终态 */
async function settle(store, id, timeout = 20000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const t = store.get(id)
    if (t.status === 'done' || t.status === 'failed') return t
    await sleep(100)
  }
  return store.get(id)
}

/** 领队假后端：脚本化每轮 send 的行为；streamTags=true 时标签走 text 事件（流式嗅探路径） */
function makeLeaderBackend(script) {
  const sent = []
  return {
    sent,
    id: 'zcode', label: 'Boss',
    async probe() { return { ok: true, detail: '' } },
    async start({ events }) {
      const sid = 'sess_lead'
      script.step(0, { events })
      return { sessionId: sid, async send(content) { sent.push(content); script.step(sent.length, { events, content }) }, async stop() {}, async close() {} }
    }
  }
}
/** 把 delegate 标签发给事件流：text 事件走流式嗅探，delegationText 走回合末解析 */
function emitTurn(events, response, delegateTags, { stream = true } = {}) {
  if (stream && delegateTags) {
    for (const tag of delegateTags) events.onEvent({ ts: Date.now(), kind: 'text', text: tag })
  }
  events.onEvent({ ts: Date.now(), kind: 'final', text: response })
  events.onTurnEnd({ response, delegationText: delegateTags ? delegateTags.join('\n') : undefined, ok: true })
}
function makeWorkerBackend(id) {
  return {
    id, label: id,
    async probe() { return { ok: true, detail: '' } },
    async start({ events }) {
      setTimeout(() => {
        events.onEvent({ ts: Date.now(), kind: 'final', text: `done ${id}` })
        events.onTurnEnd({ response: `done ${id}`, ok: true })
      }, 30)
      return { sessionId: 'sess_w', async send() {}, async stop() {}, async close() {} }
    }
  }
}
function harness(team, leaderBackend) {
  const tmpStore = fs.mkdtempSync(path.join(os.tmpdir(), 'sdr-store-'))
  const store = new TaskStore(tmpStore)
  const backends = new Map(team.map((a) => [a.backend, a.backend === 'zcode' ? leaderBackend : makeWorkerBackend(a.backend)]))
  const runner = new TaskRunner(store, backends, () => ({ concurrency: 1, mode: 'yolo', notify: false, workerConcurrency: 3 }))
  runner.attachTeam(() => team)
  return { store, runner }
}

// ================= 场景 A：流式派单全被拒 → 回灌 → 改派成功 =================
{
  const team = [
    { id: 'L1', name: 'Boss', backend: 'zcode', role: '领队', systemPrompt: '', subordinates: ['W1'] },
    { id: 'W1', name: 'Alpha', backend: 'alpha', role: '工程师', systemPrompt: '' },
    { id: 'C1', name: 'CaptainX', backend: 'capx', role: '队长', systemPrompt: '', subordinates: ['W2'] },
    { id: 'W2', name: 'Underling', backend: 'under', role: '工程师', systemPrompt: '' }
  ]
  const leader = makeLeaderBackend({
    step(n, { events: ev, content }) {
      if (n === 0) {
        // 首回合：流式派给「不存在的 Ghost」和「队长 CaptainX」——两条都该被拒
        emitTurn(ev, '已派两单，等回灌。', ['<delegate to="Ghost">做 X</delegate>', '<delegate to="CaptainX">做 Y</delegate>'])
      } else if (content.includes('没有被执行')) {
        // 收到拒单回灌 → 改派给名单内队员
        emitTurn(ev, '收到，改派 Alpha。', ['<delegate to="Alpha">把 a.txt 改成 v2</delegate>'])
      } else {
        emitTurn(ev, '全部完成，最终总结：a.txt 已升级。')
      }
    }
  })
  const { store, runner } = harness(team, leader)
  const t = store.create({ title: '改文件', prompt: '升级 a.txt', backend: 'zcode', agentId: 'L1' })
  runner.enqueue(t)
  const fin = await settle(store, t.id)

  assert(fin.status === 'done', `场景A 领队 done（${fin.status}${fin.error ? ' ' + fin.error : ''}）`)
  const children = store.list().filter((x) => x.parentTaskId === t.id)
  assert(children.length === 1 && children[0].backend === 'alpha', `改派后只建了 Alpha 一单（${children.length}）`)
  const feedback = leader.sent.find((c) => c.includes('没有被执行'))
  assert(!!feedback, '拒单原因回灌给了领队')
  assert(feedback.includes('to="Ghost"') && feedback.includes('不在你的队员名单里'), 'Ghost 的拒因在回灌里')
  assert(feedback.includes('它是队长') && feedback.includes('不能被派活'), 'CaptainX 的队长提示在回灌里')
  assert(feedback.includes('Alpha（alpha）'), '回灌带有效队员名单')
  const feedbackCount = leader.sent.filter((c) => c.includes('没有被执行')).length
  assert(feedbackCount === 1, `回灌恰好一次（${feedbackCount}）`)
  assert(!fin.result.includes('<delegate'), '最终结果不含 delegate 标记')
}

// ================= 场景 B：回合末解析被拒（无流式）→ 回灌后领队自行收尾 =================
{
  const team = [
    { id: 'L1', name: 'Boss', backend: 'zcode', role: '领队', systemPrompt: '', subordinates: ['W1'] },
    { id: 'W1', name: 'Alpha', backend: 'alpha', role: '工程师', systemPrompt: '' }
  ]
  const leader = makeLeaderBackend({
    step(n, { events: ev, content }) {
      if (n === 0) {
        // 不走 text 事件：标签只在回合末 delegationText 里（委派循环解析路径）
        emitTurn(ev, '这活派给幽灵。', ['<delegate to="Ghost">做 X</delegate>'], { stream: false })
      } else if (content.includes('没有被执行')) {
        emitTurn(ev, '无人可派，我自己做完了。最终结论：OK。')
      } else {
        emitTurn(ev, '继续。')
      }
    }
  })
  const { store, runner } = harness(team, leader)
  const t = store.create({ title: '干点活', prompt: '干点活', backend: 'zcode', agentId: 'L1' })
  runner.enqueue(t)
  const fin = await settle(store, t.id)

  assert(fin.status === 'done', `场景B 领队 done（${fin.status}${fin.error ? ' ' + fin.error : ''}）`)
  assert(store.list().filter((x) => x.parentTaskId === t.id).length === 0, '被拒派单没有建出子任务')
  assert(leader.sent.filter((c) => c.includes('没有被执行')).length === 1, '回灌一次')
  assert(fin.result.includes('我自己做完了'), '领队收尾输出成为最终结果')
}

// ================= 场景 C：顽固重派 → 回灌有界（≤2 次）后终止，不无限循环 =================
{
  const team = [
    { id: 'L1', name: 'Boss', backend: 'zcode', role: '领队', systemPrompt: '', subordinates: ['W1'] },
    { id: 'W1', name: 'Alpha', backend: 'alpha', role: '工程师', systemPrompt: '' }
  ]
  let roundNo = 0
  const leader = makeLeaderBackend({
    step(n, { events: ev, content }) {
      if (n === 0) {
        emitTurn(ev, '派单。', ['<delegate to="Ghost">做 X</delegate>'])
      } else if (content.includes('没有被执行')) {
        roundNo++
        // 每次都换一个新目标继续顽派（新 key 才会再次触发拒单记录）
        emitTurn(ev, `再派第 ${roundNo} 次。`, [`<delegate to="Ghost${roundNo}">做 X</delegate>`])
      } else {
        emitTurn(ev, '继续等待。')
      }
    }
  })
  const { store, runner } = harness(team, leader)
  const t = store.create({ title: '顽固派单', prompt: '干点活', backend: 'zcode', agentId: 'L1' })
  runner.enqueue(t)
  const fin = await settle(store, t.id, 30000)

  assert(fin.status === 'done', `场景C 领队终态 done（${fin.status}${fin.error ? ' ' + fin.error : ''}）`)
  assert(store.list().filter((x) => x.parentTaskId === t.id).length === 0, '顽派全程没有建出子任务')
  const feedbackCount = leader.sent.filter((c) => c.includes('没有被执行')).length
  assert(feedbackCount === 2, `回灌恰好 2 次后有界终止（${feedbackCount}）`)
}

console.log('\n✅ 派单被拒回灌冒烟全绿')
process.exit(0)
