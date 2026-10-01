// 渲染层数据增量更新回归：广播全量对象直落位（稳态零 list 拉取）、读期间更新/删除缓冲重放、
// 旧快照盖不掉新广播、读失败不丢广播、单飞+尾随读。esbuild 直连 src/renderer/src/data-store.ts。
// 第二段为**真实 hook 渲染回归**（React 18 + jsdom + 假桥，scripts/fixtures/renderer-data-harness.tsx）：
// 覆盖 createdAt 降序保持、首载事件突发恰一次全量、显式刷新立即取代、StrictMode 清理再装载
// 旧响应不碰新状态、真卸载作废在途读、失败后恢复——不只测纯辅助函数。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

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

  // —— 场景 8（审核修复）：compare 排序键——增量插入与 createdAt 更新保持降序不变量 ——
  fetchCalls = 0
  const ordered = createDeltaList((item) => item.id, (left, right) => right.createdAt - left.createdAt)
  await ordered.read(async () => { fetchCalls++; return [task('old1', 'queued', { createdAt: 30 }), task('old2', 'queued', { createdAt: 10 })] })
  assert.deepEqual(ordered.get().map((item) => item.id), ['old1', 'old2'])
  ordered.upsert(task('mid', 'queued', { createdAt: 20 })) // 新插入：落中间
  assert.deepEqual(ordered.get().map((item) => item.id), ['old1', 'mid', 'old2'], '增量插入按 createdAt 降序落位（不再尾插）')
  ordered.upsert(task('old2', 'queued', { createdAt: 40 })) // 更新抬升排序键：换位到队首
  assert.deepEqual(ordered.get().map((item) => item.id), ['old2', 'old1', 'mid'], 'createdAt 更新后重排，保持降序不变量')
  ordered.remove('mid')
  assert.deepEqual(ordered.get().map((item) => item.id), ['old2', 'old1'])
  assert.equal(fetchCalls, 1, '有序增量全程零额外拉取')

  // —— 场景 9（审核修复）：invalidateReads 作废在途读——卸载后旧响应整份作废 ——
  const gateI = gated()
  const doomed = ordered.read(async () => { fetchCalls++; await gateI.promise; return [task('ghost')] })
  await tick()
  ordered.upsert(task('buffered-before-invalidate', 'queued', { createdAt: 60 })) // 在途读期间广播 → 缓冲
  assert.equal(ordered.reading, true, 'reading 标记在途读')
  ordered.invalidateReads()
  assert.equal(ordered.reading, false, '作废后不再有在途读')
  assert.ok(!ordered.get().some((item) => item.id === 'buffered-before-invalidate'), '缓冲随作废一并清空（卸载语义：新装载会全量重读兜底）')
  ordered.upsert(task('during-doom', 'queued', { createdAt: 50 })) // 作废后增量直落位（不再进缓冲等一个已死的读）
  gateI.release()
  assert.equal(await doomed, null, '被作废的读返回 null，快照不落地')
  assert.ok(!ordered.get().some((item) => item.id === 'ghost'), '作废读的快照永不落地')
  assert.ok(ordered.get().some((item) => item.id === 'during-doom'), '作废后的增量直落位')

  console.log('PASS data-store 直连：首载 1 次拉取；55 次突发广播 0 次额外拉取（旧实现每广播每订阅者 1 次全量）；读期间更新/删除/新建经缓冲重放；读失败不丢广播且保留旧快照；单调序号最新读获胜、显式刷新不等旧读；compare 降序保持；invalidateReads 作废在途读')

  /* ================================================== 真实 hook 渲染回归段 */

  const sameTimestamp = createDeltaList((item) => item.id, (left, right) => right.createdAt - left.createdAt)
  await sameTimestamp.read(async () => [{ id: 'first', createdAt: 10 }, { id: 'second', createdAt: 10 }])
  sameTimestamp.upsert({ id: 'first', createdAt: 10, status: 'done' })
  assert.deepEqual(sameTimestamp.get().map((item) => item.id), ['first', 'second'], 'unchanged sort keys retain stable order')

  const dom = new JSDOM('<!doctype html><html><body><div id="probe-root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
  const { window } = dom
  globalThis.window = window
  globalThis.document = window.document
  globalThis.HTMLElement = window.HTMLElement
  globalThis.HTMLTextAreaElement = window.HTMLTextAreaElement
  globalThis.HTMLInputElement = window.HTMLInputElement
  globalThis.HTMLButtonElement = window.HTMLButtonElement
  globalThis.Node = window.Node
  globalThis.Element = window.Element
  globalThis.Event = window.Event
  globalThis.MouseEvent = window.MouseEvent
  globalThis.KeyboardEvent = window.KeyboardEvent
  globalThis.FocusEvent = window.FocusEvent
  globalThis.getComputedStyle = window.getComputedStyle.bind(window)
  globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window)
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window)
  globalThis.localStorage = window.localStorage
  try { Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true }) } catch { /* Node 自带 navigator 只读时忽略 */ }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (query) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false } })
  class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
  window.ResizeObserver = ResizeObserverStub
  globalThis.ResizeObserver = ResizeObserverStub

  const harnessOut = path.join(root, 'out', 'smoke-renderer-data-harness.cjs')
  await build({
    entryPoints: [path.join(root, 'scripts', 'fixtures', 'renderer-data-harness.tsx')],
    outfile: harnessOut,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
    logLevel: 'silent'
  })
  // 必须在 jsdom 全局就位后再 import：api.ts 的 bridge 常量在模块初始化时读 window.agentdeck
  const harness = await import(pathToFileURL(harnessOut).href)

  const container = window.document.getElementById('probe-root')
  const hookFailures = []
  const hookOk = (condition, label) => {
    console.log(`  ${condition ? '✓' : '✗'} ${label}`)
    if (!condition) { hookFailures.push(label); process.exitCode = 1 }
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  let reactRoot = null
  const mountProbe = async (name) => {
    await harness.act(async () => { reactRoot = harness.createRoot(container); reactRoot.render(harness.createElement(harness[name])) })
  }
  const unmountProbe = async () => {
    await harness.act(async () => { reactRoot.unmount(); reactRoot = null })
  }

  console.log('\n── hook 渲染：createdAt 降序保持（真实 useTasks + 假桥）')
  {
    harness.resetBridge()
    harness.setTaskSnapshot([harness.makeTask('old30', 30), harness.makeTask('old10', 10)])
    await mountProbe('TasksProbe')
    await harness.act(async () => { await sleep(30) })
    hookOk(harness.tasksProbeState.ready, '首载快照落地 ready')
    hookOk(harness.calls.taskList === 1, `首载恰一次全量（实际 ${harness.calls.taskList}）`)
    assert.deepEqual(harness.tasksProbeState.ids, ['old30', 'old10'])
    await harness.act(async () => { harness.emitTaskUpdated(harness.makeTask('new20', 20)); await sleep(10) })
    hookOk(harness.calls.taskList === 1, `新增任务增量插入零拉取（实际 ${harness.calls.taskList}）`)
    assert.deepEqual(harness.tasksProbeState.ids, ['old30', 'new20', 'old10'], '新任务按 createdAt 插到中间（不尾插）')
    await harness.act(async () => { harness.emitTaskUpdated(harness.makeTask('old10', 40)); await sleep(10) })
    hookOk(harness.calls.taskList === 1, `createdAt 更新重排零拉取（实际 ${harness.calls.taskList}）`)
    assert.deepEqual(harness.tasksProbeState.ids, ['old10', 'old30', 'new20'], 'createdAt 抬升后重排到队首，降序保持')
    await unmountProbe()
  }

  console.log('── hook 渲染：首载事件突发恰好一次全量（修复证据：未修复时逐条广播补读 → 21 次）')
  {
    harness.resetBridge()
    harness.scriptTaskList([{ delayMs: 60, snapshot: [harness.makeTask('seed', 5)] }])
    await mountProbe('TasksProbe')
    hookOk(harness.calls.taskList === 1, '首载读已发出（在途）')
    for (let i = 0; i < 20; i++) {
      await harness.act(async () => { harness.emitTaskUpdated(harness.makeTask(`burst_${i}`, 1000 + i)); await sleep(2) })
    }
    hookOk(harness.calls.taskList === 1, `20 条广播全部让位在途读，零补读（实际 ${harness.calls.taskList}）`)
    await harness.act(async () => { await sleep(100) })
    hookOk(harness.calls.taskList === 1, `首载全程恰好一次全量拉取（实际 ${harness.calls.taskList}）`)
    hookOk(harness.tasksProbeState.ready && harness.tasksProbeState.error === null, '快照+重放合并落地，无错误')
    assert.deepEqual(harness.tasksProbeState.ids, ['burst_19', 'burst_18', 'burst_17', 'burst_16', 'burst_15', 'burst_14', 'burst_13', 'burst_12', 'burst_11', 'burst_10', 'burst_9', 'burst_8', 'burst_7', 'burst_6', 'burst_5', 'burst_4', 'burst_3', 'burst_2', 'burst_1', 'burst_0', 'seed'], '读期间 20 条突发经缓冲重放合并进快照，降序保持')
    await unmountProbe()
  }

  console.log('── hook 渲染：显式 refresh 立即取代在途旧读')
  {
    harness.resetBridge()
    harness.scriptTaskList([{ delayMs: 200, snapshot: [harness.makeTask('stale', 1)] }, { delayMs: 10, snapshot: [harness.makeTask('fresh', 2)] }])
    await mountProbe('TasksProbe')
    let refreshed = null
    await harness.act(async () => { refreshed = harness.controls.refresh(); await sleep(30) })
    hookOk(harness.calls.taskList === 2, `显式刷新立即发起，不等在途旧读（实际 ${harness.calls.taskList}）`)
    assert.equal((await refreshed)[0].id, 'fresh', '显式刷新拿到新快照')
    await harness.act(async () => { await sleep(220) })
    assert.deepEqual(harness.tasksProbeState.ids, ['fresh'], '先发后至的旧快照整份作废')
    await unmountProbe()
  }

  console.log('── hook 渲染：StrictMode 清理再装载——旧装载响应不碰新装载状态')
  {
    harness.resetBridge()
    harness.scriptTaskList([{ delayMs: 60, snapshot: [harness.makeTask('ghost', 1)] }, { delayMs: 10, snapshot: [harness.makeTask('real', 2)] }])
    await mountProbe('StrictTasksProbe')
    await harness.act(async () => { await sleep(120) })
    hookOk(harness.calls.taskList === 2, `StrictMode 双装载两次真实读，第一次被清理作废（实际 ${harness.calls.taskList}）`)
    assert.deepEqual(harness.tasksProbeState.ids, ['real'], '新装载状态只含第二次读的快照')
    hookOk(!harness.tasksProbeState.ids.includes('ghost') && harness.tasksProbeState.error === null && harness.tasksProbeState.ready, '旧装载响应（ghost）未污染状态：无 ghost、无错误、ready')
    await unmountProbe()
  }

  console.log('── hook 渲染：真卸载作废在途读 + 卸载后重挂干净')
  {
    harness.resetBridge()
    harness.setTaskSnapshot([harness.makeTask('kept', 1)])
    await mountProbe('TasksProbe')
    await harness.act(async () => { await sleep(20) })
    assert.deepEqual(harness.tasksProbeState.ids, ['kept'])
    harness.scriptTaskList([{ delayMs: 80, snapshot: [harness.makeTask('late', 9)] }])
    let pending = null
    await harness.act(async () => { pending = harness.controls.refresh(); await sleep(5) })
    hookOk(harness.calls.taskList === 2, '卸载前在途读已发出')
    await unmountProbe()
    const landed = await pending
    hookOk(landed === null, '卸载作废在途读：响应整份作废返回 null（不落快照、不碰状态）')
    harness.setTaskSnapshot([harness.makeTask('kept', 1)])
    await mountProbe('TasksProbe')
    await harness.act(async () => { await sleep(20) })
    assert.deepEqual(harness.tasksProbeState.ids, ['kept'], '重挂后干净装载，无幽灵任务残留')
    await unmountProbe()
  }

  console.log('── hook 渲染：首载读失败 → 事件触发恢复（不循环放大）')
  {
    harness.resetBridge()
    harness.setTaskSnapshot([harness.makeTask('fixed', 50)])
    harness.scriptTaskList([{ delayMs: 20, error: 'bridge down' }, { delayMs: 10 }]) // 恢复读走实时快照（主进程此时已含全部广播任务）
    await mountProbe('TasksProbe')
    await harness.act(async () => { harness.emitTaskUpdated(harness.makeTask('during-fail', 60)); await sleep(40) })
    hookOk(harness.calls.taskList === 1 && harness.tasksProbeState.error === 'bridge down' && !harness.tasksProbeState.ready, `失败如实上报且不重试放大（实际 ${harness.calls.taskList} 次）`)
    assert.ok(harness.tasksProbeState.ids.includes('during-fail'), '读失败不丢读期间广播（缓冲直接落位）')
    await harness.act(async () => { harness.emitTaskUpdated(harness.makeTask('kick', 70)); await sleep(30) })
    hookOk(harness.calls.taskList === 2 && harness.tasksProbeState.error === null && harness.tasksProbeState.ready, `下一事件触发恰一次恢复读并清错（实际 ${harness.calls.taskList} 次）`)
    assert.deepEqual(harness.tasksProbeState.ids, ['kick', 'during-fail', 'fixed'], '恢复快照+重放合并，降序保持')
    await unmountProbe()
  }

  console.log('── hook 渲染：useIssues 广播增量落位（updatedAt 降序，稳态零拉取）')
  {
    harness.resetBridge()
    harness.setIssueSnapshot([harness.makeIssue('i_old', 't1', 10)])
    await mountProbe('IssuesProbe')
    await harness.act(async () => { await sleep(20) })
    hookOk(harness.calls.issueList === 1, `Issue 首载恰一次全量（实际 ${harness.calls.issueList}）`)
    assert.deepEqual(harness.issuesProbeState.ids, ['i_old'])
    await harness.act(async () => { harness.emitIssueUpdated(harness.makeIssue('i_new', 't2', 20)); await sleep(10) })
    assert.deepEqual(harness.issuesProbeState.ids, ['i_new', 'i_old'], 'Issue 增量按 updatedAt 降序插入')
    await harness.act(async () => { harness.emitIssueUpdated(null, 'i_new'); await sleep(10) })
    assert.deepEqual(harness.issuesProbeState.ids, ['i_old'], 'issue:null 广播删除条目')
    hookOk(harness.calls.issueList === 1, `两次 Issue 广播零额外拉取（实际 ${harness.calls.issueList}）`)
    await unmountProbe()
  }

  console.log('hook: parked creation during an older task snapshot')
  {
    harness.resetBridge()
    const known = harness.makeTask('known', 10)
    const parked = harness.makeTask('parked', 20)
    harness.setTaskSnapshot([known])
    harness.scriptTaskList([{ snapshot: [known], delayMs: 60 }])
    await mountProbe('TasksProbe')
    await harness.act(async () => {
      harness.setTaskSnapshot([parked, known])
      harness.emitIssueUpdated(harness.makeIssue('parked-issue', 'parked', 20))
      await sleep(20)
    })
    assert.equal(harness.calls.taskList, 1, 'unknown parked task waits for the in-flight snapshot')
    await harness.act(async () => { await sleep(80) })
    assert.equal(harness.calls.taskList, 2, 'missing parked task triggers exactly one follow-up read')
    assert.deepEqual(harness.tasksProbeState.ids, ['parked', 'known'])
    await unmountProbe()
  }

  console.log('hook: known Issue bursts during initial task load need no follow-up read')
  {
    harness.resetBridge()
    const known = harness.makeTask('known', 10)
    harness.scriptTaskList([{ snapshot: [known], delayMs: 40 }])
    await mountProbe('TasksProbe')
    await harness.act(async () => {
      for (let index = 0; index < 20; index++) harness.emitIssueUpdated(harness.makeIssue('known-issue', 'known', 20 + index))
      await sleep(60)
    })
    assert.equal(harness.calls.taskList, 1)
    assert.deepEqual(harness.tasksProbeState.ids, ['known'])
    await unmountProbe()
  }

  console.log('Board: latest read finishing first clears loading without waiting for the obsolete read')
  {
    harness.resetBridge()
    harness.scriptIssueList([{ snapshot: [], delayMs: 80 }, { snapshot: [], delayMs: 5 }])
    await mountProbe('BoardProbe')
    await harness.act(async () => {
      harness.emitTaskDeleted('obsolete-task')
      await sleep(30)
    })
    assert.equal(harness.calls.issueList, 2)
    assert.ok(!container.querySelector('.board-loading-state'))
    const settledHeading = container.querySelector('.board-toolbar-heading').textContent
    await harness.act(async () => { await sleep(80) })
    assert.equal(container.querySelector('.board-toolbar-heading').textContent, settledHeading)
    await unmountProbe()
  }

  fs.rmSync(harnessOut, { force: true })
  if (hookFailures.length > 0) throw new Error(`hook 渲染回归失败：${hookFailures.join('；')}`)
  console.log('PASS renderer-data hook 渲染：排序/首载突发（20 条广播 0 补读）/显式刷新立即取代/StrictMode 重挂隔离/真卸载作废在途读/失败恢复/useIssues 增量 全部通过')
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}
