// P4 自动重试冒烟：瞬态失败自动重跑、非瞬态不重试、上限 2 次
// 429 属 rate_limit → 生产默认退避 60s；测试置 0 立即重试
process.env.AGENTDECK_RETRY_DELAY_MS = '0'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const root = path.resolve(import.meta.dirname, '..')
for (const [src, out] of [['runner', 'smoke-runner'], ['store', 'smoke-store']]) {
  await build({
    entryPoints: [path.join(root, `src/main/${src}.ts`)],
    outfile: path.join(root, `out/${out}.cjs`),
    bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['electron']
  })
}
const runnerModule = await import(pathToFileURL(path.join(root, 'out/smoke-runner.cjs')).href)
const storeModule = await import(pathToFileURL(path.join(root, 'out/smoke-store.cjs')).href)
const { TaskRunner } = runnerModule.default ?? runnerModule
const { TaskStore } = storeModule.default ?? storeModule

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(store, id, ms = 15000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const t = store.get(id)
    if (t && t.status !== 'queued' && t.status !== 'running') return t
    await wait(50)
  }
  return store.get(id)
}

/** 可编程假后端：按脚本依次决定每轮 start 的命运 */
function makeBackend(id, script) {
  let i = 0
  const resumes = []
  return {
    id,
    label: id,
    probe: async () => ({ ok: true, detail: '' }),
    start: ({ events, resumeSessionId }) =>
      new Promise((resolve, reject) => {
        resumes.push(resumeSessionId)
        const step = script[Math.min(i++, script.length - 1)]
        setTimeout(() => {
          events.onSessionId?.(`s_${id}`)
          if (step.fail) return reject(new Error(step.fail))
          events.onEvent({ ts: Date.now(), kind: 'final', text: step.ok })
          events.onTurnEnd({ response: step.ok, ok: true })
          resolve({
            sessionId: `s_${id}`,
            send: async () => {},
            stop: async () => {},
            close: async () => {}
          })
        }, 30)
      }),
    getResumes: () => resumes
  }
}

let failed = 0
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) failed++ }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-retry-'))
const store = new TaskStore(tmp)

// 用例 1：首轮 429（可重试）→ 第二轮成功
const flaky = makeBackend('flaky', [{ fail: 'Error: 429 Too Many Requests' }, { ok: '第二次成了' }])
const r1 = new TaskRunner(store, new Map([[flaky.id, flaky]]), () => ({ concurrency: 1, mode: 'yolo', notify: false }))
const t1 = store.create({ title: '瞬态失败', prompt: 'p', workdir: '', backend: 'flaky' })
r1.enqueue(t1)
const f1 = await waitFor(store, t1.id)
ok(f1.status === 'done', `429 后自动重试至 done（got ${f1.status}）`)
ok(f1.attempt === 1, `attempt = 1（got ${f1.attempt}）`)
ok(f1.result === '第二次成了', '结果来自第二轮')
ok(flaky.getResumes()[1] === 's_flaky', '首次 429 后使用失败前持久化的 session id 续跑')
ok(store.readEvents(t1.id).some((e) => e.kind === 'status' && e.text.includes('自动重试 1/2') && e.text.includes('续会话')), '事件流留有重试记录（失败前取得 session → 续会话）')

// 用例 2：401（不可重试）→ 直接 failed
const auth = makeBackend('auth', [{ fail: 'HTTP 401 Unauthorized' }, { ok: '不该出现' }])
const r2 = new TaskRunner(store, new Map([[auth.id, auth]]), () => ({ concurrency: 1, mode: 'yolo', notify: false }))
const t2 = store.create({ title: '凭证失败', prompt: 'p', workdir: '', backend: 'auth' })
r2.enqueue(t2)
const f2 = await waitFor(store, t2.id)
ok(f2.status === 'failed' && f2.failure?.code === 'provider_auth', '401 → failed + provider_auth')
ok(!f2.attempt, '不自动重试')

// 用例 3：恒 429 → 重试打满 2 次后终态 failed
const dead = makeBackend('dead', [{ fail: 'Error: 429 rate limit' }])
const r3 = new TaskRunner(store, new Map([[dead.id, dead]]), () => ({ concurrency: 1, mode: 'yolo', notify: false }))
const t3 = store.create({ title: '持续限流', prompt: 'p', workdir: '', backend: 'dead' })
r3.enqueue(t3)
const f3 = await waitFor(store, t3.id, 30000)
ok(f3.status === 'failed', `打满上限后 failed（got ${f3.status}）`)
ok(f3.attempt === 2, `attempt = 2（got ${f3.attempt}）`)
const retries3 = store.readEvents(t3.id).filter((e) => e.kind === 'status' && e.text.includes('自动重试'))
ok(retries3.length === 2, `事件流两条重试记录（got ${retries3.length}）`)

// 用例 4：429 退避窗口内可以取消，定时器不能复活任务。
process.env.AGENTDECK_RETRY_DELAY_MS = '250'
const cancellable = makeBackend('cancellable', [{ fail: 'Error: 429 Too Many Requests' }, { ok: '不应执行' }])
const r4 = new TaskRunner(store, new Map([[cancellable.id, cancellable]]), () => ({ concurrency: 1, mode: 'yolo', notify: false }))
const t4 = store.create({ title: '退避取消', prompt: 'p', workdir: '', backend: 'cancellable' })
r4.enqueue(t4)
await wait(80)
const c4 = await r4.cancel(t4.id)
await wait(350)
ok(c4.ok && store.get(t4.id).status === 'cancelled', '退避中的自动重试可取消且保持 cancelled')
ok(cancellable.getResumes().length === 1, '取消后退避定时器未再次启动 provider')

await Promise.all([r1.shutdown(), r2.shutdown(), r3.shutdown(), r4.shutdown()])

if (failed) { console.error(`\n❌ RETRY SMOKE FAILED (${failed})`); process.exit(1) }
console.log('\n✅ RETRY SMOKE PASSED')
