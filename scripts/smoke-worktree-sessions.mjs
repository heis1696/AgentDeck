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
      assert.equal(settled.ok, true, settled.error)
      assert(finishing.stdout.destroyed && finishing.stderr.destroyed)
    }
    console.log('PASS natural exit racing Windows taskkill still waits for closed handles')
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
