// 渲染层数据增量更新回归：广播全量对象直落位（稳态零 list 拉取）、读期间更新/删除缓冲重放、
// 旧快照盖不掉新广播、读失败不丢广播、单飞+尾随读。esbuild 直连 src/renderer/src/data-store.ts。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(import.meta.dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-renderer-data-'))
let fetchCalls
try {
  await build({ entryPoints: [path.join(root, 'src/renderer/src/data-store.ts')], outfile: path.join(temp, 'data-store.cjs'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
  const { createDeltaList } = await import(pathToFileURL(path.join(temp, 'data-store.cjs')).href)

  const task = (id, status = 'queued', extra = {}) => ({ id, title: id, prompt: id, backend: 'fake', status, createdAt: 1, eventCount: 0, workdir: '', ...extra })
  const tick = () => new Promise((resolve) => setImmediate(resolve))
  const gated = () => { let release; const promise = new Promise((resolve) => { release = resolve }); return { promise, release } }

  // —— 场景 1：首次装载 = 恰好一次全量拉取，快照落位并通知 ——
  fetchCalls = 0
  let notified = 0
  let snapshot = [task('a', 'running'), task('b')]
  const store = createDeltaList((item) => item.id)
  store.subscribe(() => { notified++ })
  const first = await store.read(async () => { fetchCalls++; return snapshot })
  assert.equal(fetchCalls, 1, '首次装载只拉取一次')
  assert.equal(first.length, 2)
  assert.equal(store.get().length, 2)
  assert.equal(notified, 1, '快照落地恰好通知一次')

  // —— 场景 2：事件突发零拉取（旧实现：每次广播全量重拉一次/订阅读者）——
  for (let i = 0; i < 50; i++) store.upsert(task(`burst_${i}`, i % 2 ? 'running' : 'queued'))
  for (let i = 0; i < 5; i++) store.remove(`burst_${i}`)
  store.upsert(task('a', 'done'))
  store.remove('missing-id')
  assert.equal(fetchCalls, 1, '55 次增量广播零额外拉取（旧实现每广播每订阅者 1 次全量）')
  assert.equal(store.get().length, 47, '突发后 47 条：初始 2 + 新增 50 − 删除 5')
  assert.equal(store.get().find((item) => item.id === 'a').status, 'done', '广播覆盖同 id 旧条目')
  assert.ok(notified > 1, '每次实际变更都通知')

  // —— 场景 3：读期间更新/删除缓冲重放——旧快照盖不掉新广播 ——
  const gate = gated()
  snapshot = [task('a', 'done'), task('b'), task('c'), task('gone')]
  const slowRead = store.read(async () => { fetchCalls++; await gate.promise; return snapshot })
  await tick()
  store.upsert(task('a', 'failed'))      // 读期间状态跳变：快照里还是 done
  store.remove('gone')                   // 读期间删除：快照里还在
  store.upsert(task('fresh', 'running')) // 读期间新建：快照里没有
  gate.release()
  const merged = await slowRead
  assert.equal(fetchCalls, 2)
  assert.equal(merged.find((item) => item.id === 'a').status, 'failed', '旧快照不覆盖读期间的新广播')
  assert.ok(!merged.some((item) => item.id === 'gone'), '读期间的删除在快照重放后生效')
  assert.ok(merged.some((item) => item.id === 'fresh'), '读期间的新建不因快照而丢失')

  // —— 场景 4：读失败不丢读期间的广播，且保留既有快照 ——
  const gate2 = gated()
  const failing = store.read(async () => { fetchCalls++; await gate2.promise; throw new Error('bridge down') })
  await tick()
  store.upsert(task('a', 'cancelled'))
  store.upsert(task('also-fresh', 'queued'))
  gate2.release()
  await assert.rejects(() => failing, /bridge down/, '失败如实上抛给调用方（错误恢复横幅用）')
  assert.equal(store.get().find((item) => item.id === 'a').status, 'cancelled', '读失败后缓冲广播已落位')
  assert.ok(store.get().some((item) => item.id === 'also-fresh'), '读失败不丢读期间新建')
  assert.ok(store.get().some((item) => item.id === 'fresh'), '上次成功快照保留')

  // —— 场景 5：单调序号最新读获胜——显式刷新不被在途旧读阻塞，旧快照整份作废 ——
  // versionedRead 同步捕获调用时刻的版本号：R1 在 v2 发起且慢（挂载旧读），R2 在 v3 发起且快（创建后的显式刷新）。
  let snapshotVersion = 2
  const versionedRead = async (delayMs) => { fetchCalls++; const v = snapshotVersion; await new Promise((resolve) => setTimeout(resolve, delayMs)); return [task(`v${v}`)] }
  const slowGate = gated()
  const r1 = store.read(async () => { fetchCalls++; await slowGate.promise; return [task(`v${snapshotVersion}`)] })
  snapshotVersion = 3
  const r2 = store.read(() => versionedRead(1)) // R1 在途：R2 立即发起取代之，绝不排队等旧读
  const v2 = await r2
  assert.equal(v2[0].id, 'v3', '显式刷新立即拿到新快照（草稿创建后的导航不被事件风暴里的在途读阻塞）')
  slowGate.release()
  const discarded = await r1
  assert.equal(discarded, null, '先发后至的旧快照整份作废（返回 null，不碰状态）')
  assert.equal(store.get()[0].id, 'v3')

  // —— 场景 6：被取代的旧读不碰缓冲——最新读落地后的增量直落位，不困在缓冲里 ——
  const gateR = gated()
  const zombie = store.read(async () => { fetchCalls++; await gateR.promise; return [task('stale-snapshot')] })
  await tick()
  const latest = await store.read(async () => { fetchCalls++; return [task('latest')] }) // 取代 zombie
  assert.equal(latest[0].id, 'latest')
  store.upsert(task('after-latest', 'running')) // zombie 还在途：但缓冲已移交完毕，增量必须直落位
  gateR.release()
  await zombie
  assert.equal(store.get().length, 2, 'zombie 的旧快照不落地')
  assert.ok(store.get().some((item) => item.id === 'after-latest'), '最新读之后的增量不被旧读困在缓冲')

  // —— 场景 7：读持续失败时，最新读如实上抛、被取代的读静默让位，不循环放大 ——
  let failures = 0
  const alwaysFails = async () => { fetchCalls++; failures++; throw new Error('down') }
  const r3 = store.read(alwaysFails)
  const r4 = store.read(alwaysFails)
  const results = await Promise.allSettled([r3, r4])
  assert.equal(failures, 2, '两次请求两次真实尝试，不重试放大也不死循环')
  const rejected = results.filter((item) => item.status === 'rejected')
  assert.equal(rejected.length, 1, '只有最新读上报失败（旧读静默让位）')
  assert.equal(results.find((item) => item.status === 'fulfilled').value, null, '被取代的读返回 null')
  assert.ok(store.get().some((item) => item.id === 'after-latest'), '读失败保留上次成功快照')

  console.log('PASS renderer-data: 首载 1 次拉取；55 次突发广播 0 次额外拉取（旧实现每广播每订阅者 1 次全量，稳态委托运行每跳变 3 次全量 IPC）；读期间更新/删除/新建经缓冲重放，旧快照不覆盖新广播；读失败不丢广播且保留旧快照；单调序号最新读获胜、显式刷新不等旧读、被取代读不碰缓冲；失败如实上报不循环放大')
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}
