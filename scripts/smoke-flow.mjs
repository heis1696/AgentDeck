// 0.13.0 功能包冒烟：交接备注注入 / parked 暂不启动 / tasks:start
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
const { TaskRunner } = await import(pathToFileURL(path.join(root, 'out/smoke-runner.cjs')).href)
const { TaskStore } = await import(pathToFileURL(path.join(root, 'out/smoke-store.cjs')).href)

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) failed++ }

// 假后端：记录收到的 prompt
let lastPrompt = ''
const backend = {
  id: 'fake', label: 'fake',
  probe: async () => ({ ok: true, detail: '' }),
  start: ({ prompt, events }) => {
    lastPrompt = prompt
    setTimeout(() => {
      events.onEvent({ ts: Date.now(), kind: 'final', text: 'ok' })
      events.onTurnEnd({ response: 'ok', ok: true })
    }, 30)
    return Promise.resolve({ sessionId: 's1', send: async () => {}, stop: async () => {}, close: async () => {} })
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-flow-'))
const store = new TaskStore(tmp)
const runner = new TaskRunner(store, new Map([[backend.id, backend]]), () => ({ concurrency: 1, mode: 'yolo', notify: false }))

console.log('交接备注注入：')
const t1 = store.create({ title: '带备注', prompt: '主体任务', workdir: '', backend: 'fake', handoff: '优先改登录页，别动设置页' })
runner.enqueue(t1)
const t0 = Date.now()
while (Date.now() - t0 < 5000 && store.get(t1.id).status === 'running') await wait(50)
ok(lastPrompt.includes('主体任务'), '主体 prompt 送达')
ok(lastPrompt.includes('交接备注') && lastPrompt.includes('优先改登录页'), '交接备注注入 prompt')

console.log('parked 暂不启动：')
const t2 = store.create({ title: '暂不启动', prompt: 'p2', workdir: '', backend: 'fake', parked: true })
ok(store.get(t2.id).status === 'queued' && store.get(t2.id).parked === true, '创建即 queued+parked')
runner.enqueue(t2) // 模拟其它任务触发泵
await wait(300)
ok(store.get(t2.id).status === 'queued', 'parked 不被泵启动')
ok(store.list().filter((t) => t.status === 'queued' && !t.parked).length === 0, '泵跳过 parked 任务')

console.log('手动开始：')
store.update(t2.id, { parked: undefined })
runner.enqueue(store.get(t2.id))
const t0b = Date.now()
while (Date.now() - t0b < 5000 && store.get(t2.id).status === 'running') await wait(50)
ok(store.get(t2.id).status === 'done', `手动开始后执行完成（got ${store.get(t2.id).status}）`)

if (failed) { console.error(`\n❌ FLOW SMOKE FAILED (${failed})`); process.exit(1) }
console.log('\n✅ FLOW SMOKE PASSED')
