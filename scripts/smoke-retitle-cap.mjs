// 冒烟：标题回合硬预算（"任务都完成了还卡在运行中"回归）
// 首回合完成后 runner 会发一个隐藏的改标题回合（titleMode，事件不落日志）。
// 该回合一旦挂死（zcode 终态丢失实测挂满 30 分钟回合上限），任务就停在 running。
// 预算（AGENTDECK_RETITLE_MS）到点必须放弃标题、按原结果收尾 done。
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

// 必须在导入 runner 产物前设置：模块初始化时读取
process.env.AGENTDECK_RETITLE_MS = '400'
// 空转看门狗保持默认 10 分钟：证明收尾靠的是标题预算，不是看门狗误判
delete process.env.AGENTDECK_TURN_IDLE_MS

const root = path.resolve(import.meta.dirname, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-retitle-'))

const outfile = path.join(root, 'out', 'smoke-retitle-runner.cjs')
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
  outfile: path.join(root, 'out', 'smoke-retitle-store.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['electron']
})
const { TaskStore } = await import(pathToFileURL(path.join(root, 'out', 'smoke-retitle-store.cjs')).href)

const store = new TaskStore(tmp)
const assert = (cond, msg) => {
  if (!cond) {
    console.error('❌ ASSERT FAIL:', msg)
    process.exit(1)
  }
  console.log('  ✓', msg)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- 场景 1：标题回合挂死（不结束、不吐事件、不响应 stop 之外的任何东西）----
console.log('[1] 标题回合挂死 → 预算到点按原结果收尾...')
const hangState = { stops: 0, late: null }
const hangBackend = {
  id: 'hang',
  label: 'Hang',
  async probe() { return { ok: true, detail: '' } },
  async start({ events }) {
    hangState.events = events
    setTimeout(() => {
      events.onEvent({ ts: Date.now(), kind: 'final', text: 'done:真实工作成果' })
      events.onTurnEnd({ response: 'done:真实工作成果', ok: true })
    }, 30)
    return {
      sessionId: 'sess_hang',
      async send(content) {
        if (content.includes('重起一个简短标题')) return new Promise(() => {}) // 永不裁决
        return new Promise(() => {})
      },
      async stop() { hangState.stops++; return Promise.resolve() },
      async close() {}
    }
  }
}
const runner = new TaskRunner(store, new Map([[hangBackend.id, hangBackend]]), () => ({ concurrency: 1, mode: 'yolo', notify: false }))
const t1 = store.create({ title: '原始标题', prompt: '真实工作', workdir: '', backend: 'hang', titleAuto: true })
runner.enqueue(t1)
await wait(1500)
let cur = store.get(t1.id)
assert(cur.status === 'done', `任务收尾 done（预算 400ms，got ${cur.status}）`)
assert(cur.result === 'done:真实工作成果', '结果保留首回合成果')
assert(cur.title === '原始标题' && cur.titleAuto === true, '超时放弃改标题，原标题保留')
const evs1 = store.readEvents(t1.id)
assert(evs1.some((e) => e.kind === 'status' && (e.text ?? '').includes('标题生成超时')), '收尾原因留痕（status 事件）')
assert(hangState.stops >= 1, '已尝试停掉服务端标题回合')

// 迟到的标题终态（终态丢失后迟迟到达）必须被护栏拒绝，不再改动任务
const beforeCount = store.get(t1.id).eventCount
hangState.events.onEvent({ ts: Date.now(), kind: 'final', text: '迟到的标题' })
hangState.events.onTurnEnd({ response: '迟到的标题', ok: true })
await wait(200)
cur = store.get(t1.id)
assert(cur.status === 'done' && cur.title === '原始标题', '迟到终态被代数护栏拒绝')
assert(store.get(t1.id).eventCount === beforeCount, '迟到终态不落事件')

// ---- 场景 2：标题回合正常完成（回归：改动不破坏正常路径）----
console.log('[2] 标题回合正常完成 → 标题更新、正常收尾...')
const okBackend = {
  id: 'ok',
  label: 'Ok',
  async probe() { return { ok: true, detail: '' } },
  async start({ events }) {
    setTimeout(() => {
      events.onEvent({ ts: Date.now(), kind: 'final', text: 'done:正经结果' })
      events.onTurnEnd({ response: 'done:正经结果', ok: true })
    }, 30)
    return {
      sessionId: 'sess_ok',
      async send(content) {
        if (content.includes('重起一个简短标题')) {
          setTimeout(() => {
            events.onTurnEnd({ response: '全新标题', ok: true })
          }, 30)
          await wait(60)
          return
        }
        await wait(30)
      },
      async stop() {},
      async close() {}
    }
  }
}
const runner2 = new TaskRunner(store, new Map([[okBackend.id, okBackend]]), () => ({ concurrency: 1, mode: 'yolo', notify: false }))
const t2 = store.create({ title: '自动标题待重起', prompt: '干活', workdir: '', backend: 'ok', titleAuto: true })
runner2.enqueue(t2)
await wait(800)
cur = store.get(t2.id)
assert(cur.status === 'done', `正常收尾 done (got ${cur.status})`)
assert(cur.title === '全新标题' && cur.titleAuto === false, '正常标题回合仍生效')

console.log('✅ SMOKE PASSED')
