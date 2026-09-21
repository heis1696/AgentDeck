// 0.13.0 功能包冒烟：交接备注注入 / parked 暂不启动 / tasks:start
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const root = path.resolve(import.meta.dirname, '..')
for (const [src, out] of [['runner', 'smoke-runner'], ['store', 'smoke-store'], ['handoff', 'smoke-handoff']]) {
  await build({
    entryPoints: [path.join(root, `src/main/${src}.ts`)],
    outfile: path.join(root, `out/${out}.cjs`),
    bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['electron']
  })
}
const { TaskRunner } = await import(pathToFileURL(path.join(root, 'out/smoke-runner.cjs')).href)
const { TaskStore } = await import(pathToFileURL(path.join(root, 'out/smoke-store.cjs')).href)
const { prepareManualTaskStart } = await import(pathToFileURL(path.join(root, 'out/smoke-handoff.cjs')).href)

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) failed++ }

// 假后端：记录收到的 prompt
let lastPrompt = ''
let lastStart
const backend = {
  id: 'fake', label: 'fake',
  probe: async () => ({ ok: true, detail: '' }),
  start: (options) => {
    const { prompt, events } = options
    lastStart = options
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
const runner = new TaskRunner(store, new Map([[backend.id, backend]]), () => ({ concurrency: 1, mode: 'ask', notify: false }))

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
runner.enqueue(prepareManualTaskStart(store, t2.id))
const t0b = Date.now()
while (Date.now() - t0b < 5000 && store.get(t2.id).status === 'running') await wait(50)
ok(store.get(t2.id).status === 'done', `手动开始后执行完成（got ${store.get(t2.id).status}）`)

const electronStub = {
  name: 'flow-electron-stub',
  setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'flow-electron' }))
    build.onLoad({ filter: /.*/, namespace: 'flow-electron' }, () => ({ loader: 'js', contents: `
      globalThis.__flowHandlers = new Map()
      export const ipcMain = { handle: (name, fn) => globalThis.__flowHandlers.set(name, fn) }
      export const BrowserWindow = { getAllWindows: () => [] }
    ` }))
  }
}
const ipcFile = path.join(root, 'out/smoke-flow-ipc.cjs')
await build({ entryPoints: [path.join(root, 'src/main/ipc/tasks.ts')], outfile: ipcFile, bundle: true, platform: 'node', format: 'cjs', target: 'node18', plugins: [electronStub] })
const { registerTaskIpc } = await import(pathToFileURL(ipcFile).href)
registerTaskIpc({ store, runner, issueStore: { sync() {} }, publishIssueUpdate() {}, getWindow: () => null })
const waitDone = async (id) => {
  for (let i = 0; i < 100 && !['done', 'failed'].includes(store.get(id)?.status); i++) await wait(20)
  ok(store.get(id)?.status === 'done', '启动回合执行完成')
}
const handoffTask = (prompt, parked = true) => store.create({ title: prompt, prompt, workdir: '', backend: 'fake', continuesFrom: t1.id, issueId: 'iss_flow', trigger: 'handoff', parked })
const confirmedCue = '【系统·手动启动确认】'
const buttonTask = handoffTask('阶段2：待用户明确确认后实施')
ok(globalThis.__flowHandlers.get('tasks:start')(null, buttonTask.id).ok, '真实 tasks:start 入口接受停放接力')
await waitDone(buttonTask.id)
ok(lastPrompt.includes(confirmedCue) && lastPrompt.includes('【系统·接力接收】'), '按钮启动将确认和当前阶段身份送入首回合')
ok(lastStart.mode === 'ask' && lastStart.connection === undefined, '手动确认不改变权限模式或伪造凭据')
ok(store.get(buttonTask.id).manualStartConfirmedAt > 0, '启动确认持久化到当前任务')
ok(!globalThis.__flowHandlers.get('tasks:start')(null, buttonTask.id).ok, '完成任务不能通过 start 再启动')

const movedTask = handoffTask('阶段3：拖动启动')
ok(globalThis.__flowHandlers.get('tasks:move')(null, movedTask.id, 'running').ok, '真实拖动入口可启动接力')
await waitDone(movedTask.id)
ok(lastPrompt.includes(confirmedCue) && store.get(movedTask.id).manualStartConfirmedAt > 0, '拖动和按钮传递相同确认')
const unparkedTask = handoffTask('阶段4：排队解卡', false)
ok(globalThis.__flowHandlers.get('tasks:start')(null, unparkedTask.id).ok, '保留非 parked 排队任务的手动解卡入口')
await waitDone(unparkedTask.id)

const autoTask = handoffTask('阶段5：自动接力', false)
runner.enqueue(autoTask)
await waitDone(autoTask.id)
ok(!lastPrompt.includes(confirmedCue) && !store.get(autoTask.id).manualStartConfirmedAt, '自动接力不伪造人工确认')
ok(lastPrompt.includes('【系统·接力接收】'), '自动接力仍知道自己正在接手当前阶段')
store.flush()
const reloaded = new TaskStore(tmp, { recoverRunning: false })
ok(reloaded.get(buttonTask.id).manualStartConfirmedAt === store.get(buttonTask.id).manualStartConfirmedAt, '人工确认跨重新加载保留且不传给下一阶段')

const relaySource = store.create({ title: 'old source', prompt: '阶段1：设计', workdir: '', backend: 'fake', issueId: 'iss_existing_relay' })
store.update(relaySource.id, { status: 'done' })
const relayNext = store.create({ title: 'existing next', prompt: '阶段2：待启动', workdir: '', backend: 'fake', issueId: relaySource.issueId, continuesFrom: relaySource.id, trigger: 'handoff', parked: true })
const beforeRelayCount = store.list().length
ok((await runner.followUp(relaySource.id, '执行下一阶段', { relay: true })).ok, '接力按钮复用已有后继，不依赖已丢失的前任会话')
await waitDone(relayNext.id)
ok(store.list().length === beforeRelayCount && lastPrompt.includes(confirmedCue), '接力按钮只启动已有后继并传入确认')

// Actual permission callbacks remain pending after manual start.
let permissionResult
const permissionBackend = {
  ...backend, id: 'permission',
  async start({ events }) {
    setTimeout(async () => {
      permissionResult = await events.onPermission({ requestId: 'flow-permission', toolName: 'write', reason: 'approval', riskLevel: 'high', options: [{ optionId: 'allow', name: 'Allow', response: { decision: 'allow' } }, { optionId: 'deny', name: 'Deny', response: { decision: 'deny' } }] })
      events.onTurnEnd({ ok: true, response: 'permission handled' })
    }, 20)
    return { sessionId: 'permission-flow', async send() {}, async stop() {}, async close() {} }
  }
}
const permissionRunner = new TaskRunner(store, new Map([['permission', permissionBackend]]), () => ({ concurrency: 1, mode: 'ask', notify: false }), () => {})
const permissionTask = store.create({ title: 'permission', prompt: 'permission', workdir: '', backend: 'permission', continuesFrom: t1.id, parked: true })
permissionRunner.enqueue(prepareManualTaskStart(store, permissionTask.id))
for (let i = 0; i < 100 && !permissionRunner.pendingPermissions(permissionTask.id).length; i++) await wait(20)
const pendingPermission = permissionRunner.pendingPermissions(permissionTask.id)[0]
ok(!!pendingPermission && permissionResult === undefined, '手动启动后工具权限仍等待独立决定')
if (pendingPermission) permissionRunner.resolvePermission(pendingPermission.requestId, 'deny', 'deny', pendingPermission.requestToken)
await waitDone(permissionTask.id)
ok(permissionResult?.decision === 'deny', '独立拒绝工具权限仍然生效')
await permissionRunner.shutdown()

// Exercise the real sidecar HTTP route with only its backend replaced.
globalThis.__flowSidecarBackend = { ...backend, id: 'zcode' }
const sidecarFile = path.join(root, 'out/smoke-flow-sidecar.cjs')
const fakeBackendPlugin = { name: 'flow-fake-backend', setup(build) {
  build.onResolve({ filter: /backends\/zcode$/ }, () => ({ path: 'zcode', namespace: 'flow-backend' }))
  build.onLoad({ filter: /.*/, namespace: 'flow-backend' }, () => ({ loader: 'js', contents: 'export const createZcodeBackend = () => globalThis.__flowSidecarBackend' }))
} }
await build({
  entryPoints: [path.join(root, 'src/main/sidecar-server.ts')], outfile: sidecarFile,
  bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['electron'],
  plugins: [fakeBackendPlugin]
})
const { startSidecarServer } = await import(pathToFileURL(sidecarFile).href)
const sidecarDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-flow-sidecar-'))
const server = startSidecarServer({ port: 0, token: 'flow-test', userDataDir: sidecarDir })
try {
  const port = await server.ready
  const rpc = async (method, params) => {
    const response = await fetch(`http://127.0.0.1:${port}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agentdeck-token': 'flow-test' }, body: JSON.stringify({ version: 1, method, params }) })
    const body = await response.json()
    if (!body.ok) throw new Error(JSON.stringify(body.error))
    return body.result
  }
  const sideTask = await rpc('tasks.create', { input: { title: 'sidecar phase', prompt: '阶段2：待确认', workdir: '', backend: 'zcode', continuesFrom: 'prior', startNow: false, manualStartConfirmedAt: 123 }, trigger: 'handoff' })
  ok(!sideTask.manualStartConfirmedAt, '创建 API 不接受伪造的人工启动确认')
  await rpc('tasks.start', { id: sideTask.id })
  let current
  for (let i = 0; i < 100; i++) { current = await rpc('tasks.get', { id: sideTask.id }); if (current.status === 'done') break; await wait(20) }
  ok(current.status === 'done' && current.manualStartConfirmedAt > 123 && lastPrompt.includes(confirmedCue), 'sidecar 启动入口同样持久化并注入人工确认')

  const runtimeFile = path.join(root, 'out/smoke-flow-goal-runtime.cjs')
  await build({ entryPoints: [path.join(root, 'src/main/sidecar-runtime.ts')], outfile: runtimeFile, bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['electron'], plugins: [fakeBackendPlugin] })
  const { SidecarRuntime } = await import(pathToFileURL(runtimeFile).href)
  const goalIpcFile = path.join(root, 'out/smoke-flow-goal-ipc.cjs')
  await build({ entryPoints: [path.join(root, 'src/main/ipc/goals.ts')], outfile: goalIpcFile, bundle: true, platform: 'node', format: 'cjs', target: 'node18', plugins: [electronStub] })
  const { registerGoalIpc } = await import(pathToFileURL(goalIpcFile).href)
  const goalInput = (issueId, startNow) => ({ text: 'start current phase', issueId, completionConditions: ['complete'], stopConditions: [], maxRuns: 1, maxDurationMs: 60000, workdir: '', backend: 'zcode', startNow })
  const waitGoalTask = async (runtime, id) => {
    for (let i = 0; i < 100 && runtime.store.get(id)?.status !== 'done'; i++) await wait(20)
    ok(runtime.store.get(id)?.status === 'done' && runtime.store.get(id)?.manualStartConfirmedAt > 0 && lastPrompt.includes(confirmedCue), 'Goal 人工启动确认传入真实首回合')
  }
  const goalData = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-flow-goals-'))
  let goalRuntime = new SidecarRuntime(goalData)
  try {
    const prior = goalRuntime.taskService.createTask({ title: 'previous', prompt: '阶段1：完成', backend: 'zcode', startNow: false })
    goalRuntime.store.update(prior.id, { status: 'done' })
    const successor = goalRuntime.taskService.createHandoffTask({ sourceTaskId: prior.id, issueId: prior.issueId, brief: '阶段2：待明确启动', start: 'parked' })
    registerGoalIpc({ goalController: goalRuntime.goalController })
    globalThis.__flowHandlers.get('goals:create')(null, goalInput(prior.issueId, true))
    await waitGoalTask(goalRuntime, successor.id)

    const draft = globalThis.__flowHandlers.get('goals:create')(null, goalInput('iss_goal_restart', false))
    const phase0 = goalRuntime.store.list().find((task) => task.goalId === draft.id)
    goalRuntime.store.update(phase0.id, { status: 'done' })
    const pendingPhase = goalRuntime.taskService.createHandoffTask({ sourceTaskId: phase0.id, issueId: draft.issueId, brief: '阶段2：重载后等待启动', start: 'parked' })
    ok(!pendingPhase.manualStartConfirmedAt, 'Goal 接力创建不继承或伪造人工确认')
    await goalRuntime.close()
    goalRuntime = new SidecarRuntime(goalData)
    registerGoalIpc({ goalController: goalRuntime.goalController })
    ok(globalThis.__flowHandlers.get('goals:start')(null, draft.id).ok, '真实 goals:start 启动重载后的停放接力')
    await waitGoalTask(goalRuntime, pendingPhase.id)
  } finally {
    await goalRuntime.close()
  }
} finally {
  await server.close()
  delete globalThis.__flowSidecarBackend
}
await runner.shutdown()

if (failed) { console.error(`\n❌ FLOW SMOKE FAILED (${failed})`); process.exit(1) }
console.log('\n✅ FLOW SMOKE PASSED')
