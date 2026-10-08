import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(import.meta.dirname, '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-worktree-sessions-'))
const bundle = path.join(temporary, 'sessions.cjs')
await build({
  stdin: {
    contents: "export { TaskRunner } from './src/main/runner'; export { TaskStore } from './src/main/store'; export * from './src/main/git'; export { createZcodeBackend } from './src/main/backends/zcode'; export { killProcessTree } from './src/main/backends/cli-common'",
    resolveDir: root,
    loader: 'ts'
  },
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['electron']
})
const { TaskRunner, TaskStore, createWorktree, reclaimWorktree, pruneWorktrees, clearWorktreePool, branchExists, createZcodeBackend, killProcessTree, worktreeOwnerTaskId } = await import(pathToFileURL(bundle).href)
const runners = []
const stores = []
const processes = []
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
async function until(check, milliseconds = 15_000) {
  const deadline = Date.now() + milliseconds
  while (!check()) {
    assert(Date.now() < deadline, 'fixture did not settle in time')
    await wait(20)
  }
}
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
function repository(name) {
  const directory = path.join(temporary, name)
  fs.mkdirSync(directory)
  const git = (...args) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'smoke@example.com')
  git('config', 'user.name', 'AgentDeck Smoke')
  fs.writeFileSync(path.join(directory, 'base.txt'), 'base\n')
  git('add', '.')
  git('commit', '-qm', 'base')
  return directory
}
function runnerFor(store, backends) {
  const runner = new TaskRunner(store, new Map(backends.map((backend) => [backend.id, backend])), () => ({ concurrency: 1, workerConcurrency: 2, mode: 'yolo', notify: false, maxRetryAttempts: 0 }))
  runners.push(runner)
  stores.push(store)
  return runner
}
async function isolatedTask(store, directory, backend) {
  const task = store.create({ title: backend, titleAuto: false, prompt: 'fixture', backend, workdir: directory })
  const worktree = await createWorktree(directory, `${task.id}_c1`, 'main', task.id)
  assert(worktree)
  return { task: store.update(task.id, { workdir: worktree.path, worktree: worktree.metadata }), worktree }
}
try {
  const fakeChild = new EventEmitter()
  Object.assign(fakeChild, { pid: undefined, killed: false, exitCode: null, signalCode: null, kill: () => true })
  const exiting = killProcessTree(fakeChild)
  let resolved = false
  void exiting.then(() => { resolved = true })
  fakeChild.exitCode = 0
  fakeChild.emit('exit', 0)
  await wait(20)
  assert.equal(resolved, false, 'exit alone must not report released stdio handles')
  fakeChild.emit('close', 0)
  assert.equal((await exiting).ok, true)
  assert.equal(fakeChild.listenerCount('close'), 0)
  assert.equal(fakeChild.listenerCount('error'), 0)
  console.log('PASS process cleanup waits for close, not exit, and removes listeners')

  const directory = repository('real-zcode')
  const marker = path.join(temporary, 'process.json')
  const requests = path.join(temporary, 'requests.jsonl')
  const fixture = path.join(temporary, 'zcode.mjs')
  const source = fs.readFileSync(path.join(root, 'scripts/fixtures/fake-zcode-app-server.mjs'), 'utf8')
  fs.writeFileSync(fixture, `import fs from 'node:fs'\nfs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, cwd: process.cwd() }))\n${source}\nrl.on('line', (line) => fs.appendFileSync(${JSON.stringify(requests)}, line + '\\n'))\n`)
  const store = new TaskStore(path.join(temporary, 'zcode-store'))
  const backend = createZcodeBackend(() => ({ nodePath: process.execPath, zcodePath: fixture }))
  const runner = runnerFor(store, [backend])
  const { task, worktree } = await isolatedTask(store, directory, backend.id)
  runner.enqueue(task)
  await until(() => store.get(task.id)?.status === 'done')
  const firstProcess = JSON.parse(fs.readFileSync(marker, 'utf8'))
  assert.equal(firstProcess.cwd.toLowerCase(), worktree.path.toLowerCase())
  assert(alive(firstProcess.pid), 'completed provider session reproduces the retained process')
  if (process.platform === 'win32') {
    const probe = `${worktree.path}-rename-probe`
    let occupied = false
    try { fs.renameSync(worktree.path, probe); fs.renameSync(probe, worktree.path) } catch (error) {
      if (fs.existsSync(probe)) fs.renameSync(probe, worktree.path)
      assert(['EPERM', 'EACCES', 'EBUSY'].includes(error.code))
      occupied = true
    }
    assert(occupied, 'Windows cwd handle locks the completed task worktree')
  }
  assert.equal(await runner.releaseWorktreeSessions(worktree.path), true)
  assert(!alive(firstProcess.pid))
  assert.equal(store.get(task.id).sessionId, 'sess_fake_zcode')
  assert.equal((await runner.followUp(task.id, 'resume fixture')).ok, true)
  await until(() => store.get(task.id)?.status === 'done')
  const secondProcess = JSON.parse(fs.readFileSync(marker, 'utf8'))
  assert.notEqual(secondProcess.pid, firstProcess.pid)
  const messages = fs.readFileSync(requests, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert(messages.some((message) => message.method === 'session/resume'))
  assert(!messages.some((message) => message.method === 'session/close'), 'detach must not destroy the resumable provider session')
  const swept = await pruneWorktrees(directory, () => false, {
    maxAgeMs: 0,
    claimWorktree: (owner, merge) => {
      const claim = store.claimWorktreeCleanup(directory, owner, merge)
      return claim ? { release: () => store.releaseGitOperation(claim) } : undefined
    },
    beforeReclaim: (workdir) => runner.releaseWorktreeSessions(workdir)
  })
  assert(swept.removed.includes(path.basename(worktree.path)))
  assert.equal(swept.failed.length, 0)
  assert(!fs.existsSync(worktree.path) && !alive(secondProcess.pid))
  console.log('PASS real Windows cwd lock, resumable detach, follow-up and leased manual sweep')

  const failureDirectory = repository('failed-release')
  const failureStore = new TaskStore(path.join(temporary, 'failure-store'))
  let rejectClose = true
  let releaseClose
  let closeCalls = 0
  const failureBackend = {
    id: 'failed-release', label: 'fixture', supportsResume: true,
    async probe() { return { ok: true, detail: 'fixture' } },
    async start({ events, turn }) {
      setTimeout(() => events.onTurnEnd({ ok: true, response: 'done' }, turn), 10)
      return {
        sessionId: 'failed-release', turnScoped: true,
        async send() {}, async stop() {},
        async close() {
          closeCalls++
          if (rejectClose) throw new Error('fixture cleanup failure')
          await new Promise((resolve) => { releaseClose = resolve })
        }
      }
    }
  }
  const failureRunner = runnerFor(failureStore, [failureBackend])
  const failed = await isolatedTask(failureStore, failureDirectory, failureBackend.id)
  failureRunner.enqueue(failed.task)
  await until(() => failureStore.get(failed.task.id)?.status === 'done')
  await failureRunner.closeSession(failed.task.id)
  assert.equal(failureRunner.sessionCount(), 0, 'retired sessions remain tracked after leaving the active session map')
  const releaseOptions = { repool: true, expectedOwnerTaskId: failed.task.id, beforeReclaim: (workdir) => failureRunner.releaseWorktreeSessions(workdir) }
  const blocked = await reclaimWorktree(failed.worktree.path, releaseOptions)
  assert.equal(blocked.ok, false)
  assert.equal(blocked.status, 'failed')
  assert.match(blocked.reason, /session/)
  assert(fs.existsSync(failed.worktree.path))
  assert(await branchExists(failureDirectory, failed.worktree.branch))
  rejectClose = false
  const retry = reclaimWorktree(failed.worktree.path, releaseOptions)
  await until(() => !!releaseClose)
  const concurrent = failureRunner.releaseWorktreeSessions(failed.worktree.path)
  await wait(30)
  assert.equal(closeCalls, 3, 'retry and concurrent callers share one release')
  assert(fs.existsSync(failed.worktree.path), 'no pooling or deletion before release settles')
  releaseClose()
  assert.equal(await concurrent, true)
  assert.equal((await retry).status, 'pooled')
  console.log('PASS failed cleanup preserves directory and branch; retry waits and coalesces')

  const activeTask = failureStore.create({ title: 'active', prompt: 'fixture', backend: failureBackend.id, workdir: failureDirectory })
  let finishActive
  const activeBackend = { ...failureBackend, id: 'active', async start({ events, turn }) {
    finishActive = () => events.onTurnEnd({ ok: true, response: 'done' }, turn)
    const session = { sessionId: 'active', turnScoped: true, async send() {}, async stop() {}, async close() {} }
    return session
  } }
  const activeRunner = runnerFor(failureStore, [activeBackend])
  const runningTask = failureStore.update(activeTask.id, { backend: 'active' })
  activeRunner.enqueue(runningTask)
  await until(() => failureStore.get(activeTask.id)?.sessionId === 'active')
  assert.equal(await activeRunner.releaseWorktreeSessions(failureDirectory), false)
  assert.equal(failureStore.get(activeTask.id).status, 'running')
  finishActive()
  await until(() => failureStore.get(activeTask.id)?.status === 'done')
  assert.equal(await activeRunner.releaseWorktreeSessions(failureDirectory), true)
  console.log('PASS running task sessions cannot be released by cleanup')

  // F1 回归（docs/plan/runner-decomposition.md §8）：releaseWorktreeSessions 摘 runner
  // 侧登记时必须对 TurnLifecycle 对称 detachSession（对齐 closeSession 既有语义）。
  // 缺口后果：已 detach 保留的 provider 会话仍挂在 lifecycle.sessionValue 上，替换 Run
  // 的 followUp 走 resume 重建、attachSession 时会把旧会话当 previous 清扫（stop+close），
  // detach 保留语义被抵消——本轮断言：旧会话零 stop、零 close。
  const f1Directory = repository('f1-replace')
  const f1Store = new TaskStore(path.join(temporary, 'f1-store'))
  const f1Touched = { first: { stop: 0, close: 0 }, second: { stop: 0, close: 0 } }
  const f1Backend = {
    id: 'f1', label: 'fixture', supportsResume: true,
    async probe() { return { ok: true, detail: 'fixture' } },
    async start({ resumeSessionId, events, turn }) {
      const fresh = !resumeSessionId
      setTimeout(() => events.onTurnEnd({ ok: true, response: fresh ? 'done' : 'replacement complete' }, turn), 10)
      const which = fresh ? 'first' : 'second'
      return {
        sessionId: fresh ? 'f1-one' : 'f1-two',
        turnScoped: true,
        async send() {},
        async stop() { f1Touched[which].stop++ },
        async close() { f1Touched[which].close++ },
        async detach() {}
      }
    }
  }
  const f1Runner = runnerFor(f1Store, [f1Backend])
  const f1 = await isolatedTask(f1Store, f1Directory, f1Backend.id)
  f1Runner.enqueue(f1.task)
  await until(() => f1Store.get(f1.task.id)?.status === 'done')
  assert.equal(f1Store.get(f1.task.id).sessionId, 'f1-one')
  assert.equal(await f1Runner.releaseWorktreeSessions(f1.worktree.path), true)
  assert.equal(f1Runner.sessionCount(), 0, 'release removes the runner-side registration')
  assert.equal((await f1Runner.followUp(f1.task.id, 'replacement')).ok, true)
  await until(() => f1Store.get(f1.task.id)?.status === 'done')
  // attachSession 的 previous 清扫是 void 异步：给「误扫」留出确定性发生的时间窗
  await wait(150)
  assert.equal(f1Touched.first.stop, 0, 'detached-preserved session must not be stopped by the replacement attach')
  assert.equal(f1Touched.first.close, 0, 'detached-preserved session must not be closed by the replacement attach')
  assert.equal(f1Store.get(f1.task.id).sessionId, 'f1-two')
  console.log('PASS replacement run session survives the previous release (F1 symmetric detach)')

  clearWorktreePool()
  const delegateDirectory = repository('delegation')
  const delegateStore = new TaskStore(path.join(temporary, 'delegate-store'))
  let summarized = false
  let detached = false
  let workerDirectory
  let workerId
  const worker = {
    id: 'worker', label: 'fixture', supportsResume: true,
    async probe() { return { ok: true, detail: 'fixture' } },
    async start({ workdir, events, turn }) {
      workerDirectory = workdir
      fs.writeFileSync(path.join(workdir, 'delivery.txt'), 'delivery\n')
      setTimeout(() => events.onTurnEnd({ ok: true, response: 'long report '.repeat(300) }, turn), 10)
      return {
        sessionId: 'worker', turnScoped: true, async stop() {}, async close() {},
        async send(content, stamp) {
          workerId = delegateStore.list().find((item) => item.parentTaskId)?.id
          assert.equal(await worktreeOwnerTaskId(workdir), workerId, 'summary runs before worktree is pooled or reused')
          assert.equal(execFileSync('git', ['-C', workdir, 'branch', '--show-current'], { encoding: 'utf8' }).trim(), delegateStore.get(workerId).worktree.branch)
          summarized = true
          events.onTurnEnd({ ok: true, response: 'compact summary' }, stamp)
        },
        async detach() { assert(summarized); await wait(30); detached = true }
      }
    }
  }
  const leader = {
    id: 'leader', label: 'fixture', supportsResume: true,
    async probe() { return { ok: true, detail: 'fixture' } },
    async start({ events, turn }) {
      const delegation = '<' + 'delegate to="Worker" summary>fixture<' + '/delegate>'
      setTimeout(() => events.onTurnEnd({ ok: true, response: delegation }, turn), 10)
      return {
        sessionId: 'leader', turnScoped: true, async stop() {}, async close() {},
        async send(content, stamp) {
          assert(summarized && detached, 'leader feedback follows summary and process release')
          assert(content.includes('compact summary') && content.includes('delivery.txt'))
          assert.equal(delegateStore.get(workerId).worktree.cleanupStatus, 'pooled')
          assert(fs.existsSync(workerDirectory))
          events.onTurnEnd({ ok: true, response: 'complete' }, stamp)
        }
      }
    }
  }
  const delegateRunner = runnerFor(delegateStore, [leader, worker])
  delegateRunner.attachTeam(() => [
    { id: 'leader-agent', name: 'Leader', backend: 'leader', role: '队长', subordinates: ['worker-agent'] },
    { id: 'worker-agent', name: 'Worker', backend: 'worker', role: '工程师' }
  ])
  const leaderTask = delegateStore.create({ title: 'delegation', titleAuto: false, prompt: 'fixture', workdir: delegateDirectory, backend: 'leader', agentId: 'leader-agent' })
  delegateRunner.enqueue(leaderTask)
  await until(() => ['done', 'failed'].includes(delegateStore.get(leaderTask.id)?.status), 30_000)
  assert.equal(delegateStore.get(leaderTask.id).status, 'done', delegateStore.get(leaderTask.id).error)
  assert(summarized && detached)
  assert.equal(delegateStore.get(workerId).gitOperation, undefined)
  console.log('PASS summary and report precede detach and pooling; next round receives a released tree')

  if (process.platform === 'win32') {
    for (let index = 0; index < 5; index++) {
      const finishing = spawn(process.execPath, ['-e', "process.stdin.once('data', () => process.exit(0)); process.stdout.write('ready')"], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      processes.push(finishing)
      await new Promise((resolve) => finishing.stdout.once('data', resolve))
      finishing.stdin.end('exit')
      const settled = await killProcessTree(finishing)
      if (!settled.ok) {
        assert(Number.isInteger(settled.code) && settled.code !== 0)
        assert.equal(settled.error, `taskkill exited ${settled.code}`)
      } else assert.equal(settled.error, undefined)
      assert(finishing.stdout.destroyed && finishing.stderr.destroyed)
    }
    console.log('PASS natural exit racing Windows taskkill waits for closed handles and never hides a failed taskkill')
    const descendantMarker = path.join(temporary, 'descendant.txt')
    const descendant = path.join(temporary, 'descendant.mjs')
    fs.writeFileSync(descendant, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(descendantMarker)}, String(process.pid)); setInterval(() => {}, 1000)`)
    const child = spawn(process.execPath, ['-e', `require('node:child_process').spawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: 'inherit', windowsHide: true }); setInterval(() => {}, 1000)`], { cwd: directory, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    processes.push(child)
    await until(() => fs.existsSync(descendantMarker))
    const descendantPid = Number(fs.readFileSync(descendantMarker, 'utf8'))
    const killed = await killProcessTree(child)
    assert.equal(killed.ok, true, killed.error)
    await until(() => !alive(descendantPid))
    assert(child.stdout.destroyed && child.stderr.destroyed)
    assert.equal((await killProcessTree(child)).ok, true, 'already closed process cleanup is idempotent')
    console.log('PASS Windows process-tree cleanup releases child and descendant handles')
  }
} finally {
  for (const runner of runners) await runner.shutdown()
  for (const child of processes) await killProcessTree(child)
  for (const store of stores) store.flush()
  clearWorktreePool()
  assert(path.resolve(temporary).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`))
  fs.rmSync(temporary, { recursive: true, force: true })
}
console.log('PASS worktree session cleanup')
