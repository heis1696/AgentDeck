// dsh 回合预算测试：dsh headless 运行期零输出（无法触发任何续命事件），
// 验证其看门狗按专属总预算裁决，而不是被通用「10 分钟无输出」空闲阈值误杀；
// 同时回归看门狗所有权：超时后的零延迟自动重试不得丢掉后继回合的看门狗（否则永久 running）
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

// 必须在导入 runner 产物前设置（模块初始化时读取）：
// 通用空闲阈值 300ms；dsh 专属预算 800ms——静默的 dsh 若仍走空闲语义会在 300ms 被误杀
process.env.AGENTDECK_TURN_IDLE_MS = '300'
process.env.AGENTDECK_DSH_TURN_MS = '800'

const root = path.resolve(import.meta.dirname, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-dsh-budget-'))

const outfile = path.join(root, 'out', 'smoke-dsh-budget.cjs')
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
  outfile: path.join(root, 'out', 'smoke-dsh-budget-store.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['electron']
})
const { TaskStore } = await import(pathToFileURL(path.join(root, 'out', 'smoke-dsh-budget-store.cjs')).href)

const store = new TaskStore(tmp)

// 静默假后端：模拟 dsh headless——首回合永不产出事件也永不 resolve，看门狗只能靠 stop 硬杀
function makeSilentBackend(id) {
  const state = { stops: 0 }
  return {
    id,
    label: 'Silent ' + id,
    state,
    async probe() { return { ok: true, detail: id } },
    async start({ events }) {
      events.onEvent({ ts: Date.now(), kind: 'status', text: id + ' started' })
      return {
        sessionId: `sess_${id}`,
        async send() { await new Promise(() => {}) },
        async stop() { state.stops++ },
        async close() { state.stops++ }
      }
    }
  }
}
const dsh = makeSilentBackend('dsh')
const other = makeSilentBackend('other')
const runner = new TaskRunner(
  store,
  new Map([[dsh.id, dsh], [other.id, other]]),
  () => ({ concurrency: 2, mode: 'yolo', notify: false })
)

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const assert = (cond, msg) => {
  if (!cond) {
    console.error('❌ ASSERT FAIL:', msg)
    process.exit(1)
  }
  console.log('  ✓', msg)
}

// 同起两个静默任务：other 按 300ms 空闲阈值判败并重试，dsh 必须撑过 800ms 专属预算
const tOther = store.create({ title: '静默对照', prompt: 'silent', workdir: '', backend: 'other' })
const tDsh = store.create({ title: 'dsh 静默', prompt: 'silent', workdir: '', backend: 'dsh' })
runner.enqueue(tOther)
runner.enqueue(tDsh)

await wait(600)
const o = store.get(tOther.id)
const d = store.get(tDsh.id)
assert(o.attempt >= 1 || o.status === 'failed', `对照后端已按通用空闲阈值判败/重试 (attempt=${o.attempt} status=${o.status})`)
assert(d.status === 'running' && (d.attempt ?? 0) === 0, `dsh 撑过空闲阈值未被误杀 (status=${d.status} attempt=${d.attempt})`)

// 重试上限 2 次 × 800ms 预算 ≈ 2.4s，留裕量后两者都应收敛到 failed
await wait(4200)
const oEnd = store.get(tOther.id)
const dEnd = store.get(tDsh.id)
assert(oEnd.status === 'failed' && (oEnd.error ?? '').includes('回合超时'), `对照后端收敛为回合超时失败 (status=${oEnd.status})`)
assert(dEnd.status === 'failed' && (dEnd.error ?? '').includes('回合超时'), `dsh 按专属预算收敛为回合超时失败 (status=${dEnd.status})`)
assert(oEnd.attempt === 2 && dEnd.attempt === 2, `两者都完整走完重试链，未在看门狗交接中卡死 (other=${oEnd.attempt} dsh=${dEnd.attempt})`)
assert(dsh.state.stops > 0 && other.state.stops > 0, '静默会话的停止句柄被调用（挂死进程可被硬杀）')

console.log('\n✅ DSH BUDGET SMOKE PASSED')
