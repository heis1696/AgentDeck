// P1 失败分类冒烟：classifyFailure 规则断言 + runner 失败落库 task.failure
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const root = path.resolve(import.meta.dirname, '..')
await build({
  entryPoints: [path.join(root, 'src/main/failure.ts')],
  outfile: path.join(root, 'out', 'smoke-failure.cjs'),
  bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['electron']
})
const { classifyFailure } = await import(pathToFileURL(path.join(root, 'out', 'smoke-failure.cjs')).href)

let failed = 0
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) failed++ }

console.log('分类规则：')
const cases = [
  ['spawn ENOENT claude', 'cli_missing'],
  ['PATH 上找不到 codex', 'cli_missing'],
  ['未知后端: foo', 'cli_missing'],
  ['zcode app-server 进程退出 (code 1): Error: ZCODE_RUNTIME_MODEL_UNAVAILABLE', 'protocol_config'],
  ['HTTP 401 Unauthorized', 'provider_auth'],
  ['402 Payment Required: insufficient balance', 'provider_quota'],
  ['Error: 429 Too Many Requests', 'rate_limit'],
  ['等待回合结束超时（30 分钟）', 'timeout'],
  ['resume 超时（120s）', 'timeout'],
  ['输出超过 300KB，疑似模型生成循环，强制停止本回合', 'output_limit'],
  ['model error: maximum context length exceeded', 'context_overflow'],
  ['codex exec failed: exit code -1 (sandbox)', 'sandbox'],
  ['claude 进程退出 (code 2): panic: crash', 'process_crash'],
  ['完全无法识别的错误', 'unknown']
]
for (const [err, code] of cases) {
  const r = classifyFailure({ error: err })
  ok(r.code === code, `${err.slice(0, 28).padEnd(30)} → ${r.code}${r.code === code ? '' : `（期望 ${code}）`}`)
}
ok(classifyFailure({ error: 'Error: 429 rate limit' }).retryable === true, 'rate_limit 标记可重试')
ok(classifyFailure({ error: 'HTTP 401' }).retryable === false, 'provider_auth 不重试')
ok(!!classifyFailure({ error: 'x' }).hint && !!classifyFailure({ error: 'x' }).title, 'unknown 也有 title/hint')

// runner 层：假后端抛带特征错误 → task.failure 落库
console.log('runner 接线：')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-failure-'))
await build({
  entryPoints: [path.join(root, 'src/main/runner.ts')],
  outfile: path.join(root, 'out', 'smoke-runner.cjs'),
  bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['electron']
})
await build({
  entryPoints: [path.join(root, 'src/main/store.ts')],
  outfile: path.join(root, 'out', 'smoke-store.cjs'),
  bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['electron']
})
const { TaskRunner } = await import(pathToFileURL(path.join(root, 'out', 'smoke-runner.cjs')).href)
const { TaskStore } = await import(pathToFileURL(path.join(root, 'out', 'smoke-store.cjs')).href)
const store = new TaskStore(tmp)
const badBackend = {
  id: 'bad',
  label: 'bad',
  probe: async () => ({ ok: true, detail: '' }),
  start: () => new Promise((_res, rej) => setTimeout(() => rej(new Error('spawn ENOENT No such file')), 30))
}
const runner = new TaskRunner(store, new Map([[badBackend.id, badBackend]]), () => ({ concurrency: 1, mode: 'yolo', notify: false }))
const t = store.create({ title: '失败分类', prompt: 'p', workdir: '', backend: 'bad' })
runner.enqueue(t)
const t0 = Date.now()
while (Date.now() - t0 < 5000) {
  const cur = store.get(t.id)
  if (cur && cur.status !== 'queued' && cur.status !== 'running') break
  await new Promise((r) => setTimeout(r, 50))
}
const fin = store.get(t.id)
ok(fin.status === 'failed', '任务终态 failed')
ok(fin.failure?.code === 'cli_missing', `failure.code = ${fin.failure?.code}（期望 cli_missing）`)
ok(!!fin.failure?.hint, 'failure.hint 已落库')
ok(!!fin.error?.includes('ENOENT'), '原始错误保留在 error')

if (failed) { console.error(`\n❌ FAILURE SMOKE FAILED (${failed})`); process.exit(1) }
console.log('\n✅ FAILURE SMOKE PASSED')
