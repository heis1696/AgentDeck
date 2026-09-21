import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(import.meta.dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-git-ownership-'))
const gitSource = path.join(root, 'src/main/git.ts')
const electronStub = {
  name: 'electron-stub',
  setup(builder) {
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-stub' }))
    builder.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => ({ loader: 'js', contents: `
      globalThis.__worktreeHandlers = new Map()
      export const ipcMain = { handle: (name, handler) => globalThis.__worktreeHandlers.set(name, handler) }
      export const BrowserWindow = { getAllWindows: () => [] }
    ` }))
  }
}
const gatePlugin = {
  name: 'pause-real-git',
  setup(builder) {
    builder.onResolve({ filter: /^\.\/git$/ }, (args) => args.importer.endsWith('delegate.ts') ? { path: 'git', namespace: 'git-gate' } : undefined)
    builder.onResolve({ filter: /.*/, namespace: 'git-gate' }, () => ({ path: gitSource, namespace: 'file' }))
    builder.onLoad({ filter: /.*/, namespace: 'git-gate' }, () => ({
      loader: 'js',
      contents: `import * as real from ${JSON.stringify(gitSource)};
        export * from ${JSON.stringify(gitSource)};
        export async function commitAll(...args) { await globalThis.__gitGate?.('commitAll'); return real.commitAll(...args) }
        export async function reclaimWorktree(...args) { await globalThis.__gitGate?.('reclaimWorktree'); return real.reclaimWorktree(...args) }`
    }))
  }
}
const load = async (file, name, plugins = []) => {
  const outfile = path.join(temp, name + '.cjs')
  await build({ entryPoints: [path.join(root, file)], outfile, bundle: true, platform: 'node', format: 'cjs', plugins, external: plugins.includes(electronStub) ? [] : ['electron'], logLevel: 'silent' })
  return import(pathToFileURL(outfile).href)
}
const [{ TaskStore }, { createExecutionOwner, currentProcessIdentity }, git, { runDelegationLoop }, { registerTaskIpc }] = await Promise.all([
  load('src/main/store.ts', 'store'), load('src/main/persistence.ts', 'persistence'),
  load('src/main/git.ts', 'git'), load('src/main/delegate.ts', 'delegate', [gatePlugin]),
  load('src/main/ipc/tasks.ts', 'ipc-tasks', [electronStub])
])
const identity = (task) => ({ status: task.status, runId: task.runId, executionOwner: task.executionOwner, attempt: task.attempt })
const runGit = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true }).trim()

async function fixture(name) {
  const repo = path.join(temp, name, 'repo')
  const data = path.join(temp, name, 'data')
  fs.mkdirSync(repo, { recursive: true })
  runGit(repo, 'init', '-q', '-b', 'main')
  runGit(repo, 'config', 'user.email', 'smoke@example.com')
  runGit(repo, 'config', 'user.name', 'AgentDeck Smoke')
  fs.writeFileSync(path.join(repo, 'result.txt'), 'base\n')
  runGit(repo, 'add', '.')
  runGit(repo, 'commit', '-qm', 'base')
  const store = new TaskStore(data)
  const parent = store.create({ title: 'parent', prompt: 'integrate', workdir: repo, backend: 'fake', agentId: 'lead' })
  store.claimRun(parent.id, { status: 'queued' }, 'run_parent', createExecutionOwner())
  const child = store.create({ title: 'child', prompt: 'work', workdir: repo, backend: 'fake', agentId: 'worker', parentTaskId: parent.id })
  const worktree = await git.createWorktree(repo, parent.id + '_c1', 'main', child.id)
  assert.ok(worktree)
  fs.writeFileSync(path.join(worktree.path, 'result.txt'), 'delivered\n')
  store.update(child.id, { status: 'done', attempt: 1, result: 'delivered', workdir: worktree.path, worktree: worktree.metadata })
  let delivered = false
  const call = { to: 'Worker', prompt: 'work' }
  const runner = {
    async takeEarlySpawns() {
      const entries = delivered ? [] : [{ call, childId: child.id }]
      delivered = true
      return { entries, seenKeys: new Set(['Worker\nwork']) }
    },
    takeDelegateRejections: () => [],
    async sendTurn() { return { ok: true, response: 'finished' } }
  }
  const execute = () => runDelegationLoop(parent.id, {}, { ok: true, response: '' }, identity(store.get(parent.id)), {
    store, runner,
    getTeam: () => [{ id: 'lead', name: 'Lead', backend: 'fake', subordinates: ['worker'] }, { id: 'worker', name: 'Worker', backend: 'fake' }],
    opts: () => ({ mode: 'yolo', notify: false, maxParallel: 1 }),
    pushTask() {}, pushEvent() {}
  })
  return { store, peer: new TaskStore(data), repo, data, parent, child, worktree, runner, execute }
}

try {
  for (const stage of ['commitAll', 'reclaimWorktree']) {
    const f = await fixture(stage)
    let entered
    let release
    const paused = new Promise((resolve) => { entered = resolve })
    const resume = new Promise((resolve) => { release = resolve })
    globalThis.__gitGate = async (at) => { if (at === stage) { entered(); await resume } }
    const integration = f.execute()
    let timer
    try {
      await Promise.race([paused, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Git gate did not open')), 10000) })])
      const parent = f.peer.get(f.parent.id)
      const child = f.peer.get(f.child.id)
      assert.ok(parent.gitOperation?.token)
      assert.equal(child.gitOperation?.token, parent.gitOperation.token)
      assert.equal(new TaskStore(f.data).get(child.id).gitOperation.token, child.gitOperation.token, 'operation ownership survives a fresh Store')
      assert.equal(f.peer.updateIf(child.id, identity(child), { status: 'queued', attempt: 2 }), undefined, 'retry cannot requeue during Git work')
      assert.equal(f.peer.claimRun(child.id, identity(child), 'new-run', createExecutionOwner()), undefined, 'follow-up cannot claim during Git work')
      assert.equal(f.peer.deleteIf(child.id, identity(child)), false, 'deletion cannot remove the workspace owner')
      const workVersion = parent.workVersion
      assert.equal(f.peer.update(parent.id, { title: 'renamed during Git' }), undefined, 'content edits cannot change workVersion during Git work')
      assert.equal(f.peer.get(parent.id).workVersion, workVersion, 'rejected edit leaves the captured workVersion stable')
      registerTaskIpc({ store: f.peer, runner: { pushTask() {} }, issueStore: { sync() {}, syncEventually() {} }, getWindow: () => null })
      assert.equal(globalThis.__worktreeHandlers.get('tasks:rename')(null, parent.id, 'IPC rename during Git'), null, 'IPC rename reports the Git reservation conflict')
      assert.ok(fs.existsSync(f.worktree.path), 'the reserved worktree is still present at the operation boundary')
      const mergeName = `.agentdeck-merge-protected-${stage}`
      const mergePath = path.join(f.repo, '.agentdeck-worktrees', mergeName)
      runGit(f.repo, 'worktree', 'add', '--detach', mergePath, 'main')
      const pruned = await git.pruneWorktrees(f.repo, (owner) => git.shouldKeepTaskWorktree(f.peer.list(), f.repo, owner), { maxAgeMs: 0 })
      assert.ok(fs.existsSync(mergePath) && pruned.retained.some((item) => item.name === mergeName), 'cleanup preserves merge worktrees while an operation is reserved')
      f.mergePath = mergePath
    } finally {
      clearTimeout(timer)
      release()
      await integration
      delete globalThis.__gitGate
    }
    assert.equal(f.store.get(f.parent.id).gitOperation, undefined)
    assert.equal(f.store.get(f.child.id).gitOperation, undefined)
    assert.equal(runGit(f.repo, 'show', 'agentdeck/task-' + f.parent.id + ':result.txt'), 'delivered', 'the integration contains the reported child work')
    assert.ok((await git.reclaimWorktree(f.mergePath)).ok, 'the protected merge worktree is reclaimable after release')
    assert.ok(f.peer.updateIf(f.child.id, identity(f.peer.get(f.child.id)), { status: 'queued', attempt: 2 }), 'retry is accepted after Git work settles')
    f.store.flush()
    f.peer.flush()
    console.log('PASS real Git ' + stage + ': retry, start and delete wait for the captured operation')
  }

  const f = await fixture('stale-legacy-report')
  const base = runGit(f.worktree.path, 'rev-parse', 'HEAD')
  f.runner.sendTurn = async () => {
    f.peer.update(f.child.id, { status: 'done', attempt: 2, result: 'replacement' })
    fs.writeFileSync(path.join(f.worktree.path, 'result.txt'), 'replacement in progress\n')
    return { ok: true, response: 'finished' }
  }
  await f.execute()
  assert.equal(runGit(f.worktree.path, 'rev-parse', 'HEAD'), base, 'the old report cannot commit the replacement workspace')
  assert.equal(fs.readFileSync(path.join(f.worktree.path, 'result.txt'), 'utf8'), 'replacement in progress\n')
  assert.equal(await git.branchExists(f.repo, 'agentdeck/task-' + f.parent.id), false, 'the old report cannot merge the replacement work')
  assert.equal(f.store.get(f.child.id).gitOperation, undefined)
  f.store.flush()
  f.peer.flush()
  console.log('PASS legacy status/attempt identity rejects integration of a retried child')

  const releasing = await fixture('release-retry')
  const operation = releasing.store.claimGitOperation([
    { id: releasing.parent.id, expected: identity(releasing.store.get(releasing.parent.id)) },
    { id: releasing.child.id, expected: identity(releasing.store.get(releasing.child.id)) }
  ])
  assert.ok(operation)
  const parentBeforeCancel = releasing.peer.get(releasing.parent.id)
  assert.ok(releasing.peer.updateIf(parentBeforeCancel.id, identity(parentBeforeCancel), { status: 'cancelled' }), 'cancellation remains available while Git settles')
  assert.ok(releasing.peer.get(parentBeforeCancel.id).gitOperation, 'cancellation does not release a running Git operation')
  assert.equal(releasing.peer.claimRun(parentBeforeCancel.id, { status: 'cancelled' }, 'retry-before-release', createExecutionOwner()), undefined)
  const rename = fs.renameSync
  let releaseFailures = 3
  const failureTimes = []
  fs.renameSync = (from, to) => {
    if (to === path.join(releasing.data, 'tasks', 'tasks.json') && releaseFailures-- > 0) {
      failureTimes.push(Date.now())
      throw new Error('injected Git release failure')
    }
    return rename(from, to)
  }
  try {
    assert.throws(() => releasing.store.releaseGitOperation(operation), /injected Git release failure/)
    assert.ok(releasing.peer.get(releasing.child.id).gitOperation, 'failed release keeps the durable reservation')
    const releaseDeadline = Date.now() + 6000
    while (releasing.peer.get(releasing.child.id).gitOperation && Date.now() < releaseDeadline) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(releasing.peer.get(releasing.child.id).gitOperation, undefined, 'failed release automatically retries')
    assert.equal(releasing.peer.get(releasing.parent.id).gitOperation, undefined)
    assert.equal(failureTimes.length, 3)
    assert.ok(failureTimes[1] - failureTimes[0] >= 180 && failureTimes[2] - failureTimes[1] >= 380, 'release retry uses increasing backoff')
  } finally { fs.renameSync = rename }
  releasing.store.flush()
  releasing.peer.flush()
  console.log('PASS cancellation retains Git ownership until release, including release-write retries')

  const cleanup = await fixture('cleanup-first')
  const activeChild = cleanup.peer.get(cleanup.child.id)
  assert.equal(git.shouldKeepTaskWorktree(cleanup.peer.list(), cleanup.repo, activeChild.id), true, 'terminal child is retained while its parent Run is active')
  const activeParent = cleanup.peer.get(cleanup.parent.id)
  cleanup.peer.updateIf(activeParent.id, identity(activeParent), { status: 'done', endedAt: Date.now() })
  const cleanupClaim = cleanup.peer.claimWorktreeCleanup(cleanup.repo, cleanup.child.id, false)
  assert.ok(cleanupClaim, 'cleanup atomically reserves the terminal child and parent chain')
  assert.equal(cleanup.store.claimRun(cleanup.parent.id, { status: 'done' }, 'race-after-clean-check', createExecutionOwner()), undefined, 'parent cannot restart after cleanup passed its keep check')
  assert.equal(cleanup.store.claimGitOperation([
    { id: cleanup.parent.id, expected: identity(cleanup.store.get(cleanup.parent.id)) },
    { id: cleanup.child.id, expected: identity(cleanup.store.get(cleanup.child.id)) }
  ]), undefined, 'integration cannot claim after cleanup ownership commits')
  cleanup.peer.releaseGitOperation(cleanupClaim)
  const mergeClaim = cleanup.peer.claimWorktreeCleanup(cleanup.repo, '.agentdeck-merge-orphan', true)
  assert.ok(mergeClaim, 'merge-worktree cleanup reserves every terminal task in the repository')
  assert.equal(cleanup.store.claimRun(cleanup.parent.id, { status: 'done' }, 'race-with-merge-cleanup', createExecutionOwner()), undefined)
  cleanup.peer.releaseGitOperation(mergeClaim)
  cleanup.store.flush()
  cleanup.peer.flush()
  console.log('PASS cleanup-first ordering is mutually exclusive with restart and integration')

  const deadData = path.join(temp, 'dead-operation', 'data')
  const deadStore = new TaskStore(deadData)
  const deadTasks = ['parent', 'child'].map((title) => {
    const task = deadStore.create({ title, prompt: title, workdir: '', backend: 'fake' })
    return deadStore.update(task.id, { status: 'done', endedAt: Date.now() })
  })
  const worker = spawnSync(process.execPath, [
    path.join(root, 'scripts', 'fixtures', 'git-operation-worker.mjs'), deadData,
    path.join(temp, 'store.cjs'), ...deadTasks.map((task) => task.id)
  ], { encoding: 'utf8', windowsHide: true })
  assert.equal(worker.status, 0, worker.stderr)
  const deadClaim = JSON.parse(worker.stdout)
  assert.ok(deadClaim.token && deadStore.get(deadTasks[0].id).gitOperation?.token === deadClaim.token, 'real child process persists the Git reservation')
  const recoveryStore = new TaskStore(deadData)
  assert.equal(recoveryStore.recoverDeadGitOperations().length, 2, 'confirmed dead Git owner releases every matching task once')
  assert.equal(recoveryStore.recoverDeadGitOperations().length, 0, 'dead Git reservation recovery is idempotent')
  assert.ok(deadTasks.every((task) => !recoveryStore.get(task.id).gitOperation))

  const liveTask = recoveryStore.create({ title: 'live operation', prompt: 'live', workdir: '', backend: 'fake' })
  const liveOwner = { ...currentProcessIdentity(), token: 'live-git-operation' }
  recoveryStore.update(liveTask.id, { status: 'done', gitOperation: { token: 'live-token', owner: liveOwner, createdAt: Date.now() } })
  const unknownTask = recoveryStore.create({ title: 'unknown operation', prompt: 'unknown', workdir: '', backend: 'fake' })
  recoveryStore.update(unknownTask.id, { status: 'done', gitOperation: { token: 'unknown-token', owner: { pid: process.pid, instance: '', token: 'unknown' }, createdAt: Date.now() } })
  const reusedTask = recoveryStore.create({ title: 'reused pid operation', prompt: 'reused', workdir: '', backend: 'fake' })
  const reusedInstance = process.platform === 'win32'
    ? (BigInt(liveOwner.instance) + 1n).toString()
    : liveOwner.instance.replace(/:\d+$/, (value) => ':' + (BigInt(value.slice(1)) + 1n))
  recoveryStore.update(reusedTask.id, { status: 'done', gitOperation: { token: 'reused-token', owner: { ...liveOwner, instance: reusedInstance, token: 'reused' }, createdAt: Date.now() } })
  assert.equal(recoveryStore.recoverDeadGitOperations().length, 1, 'PID reuse is positive death evidence for the old Git owner')
  assert.ok(recoveryStore.get(liveTask.id).gitOperation && recoveryStore.get(unknownTask.id).gitOperation, 'live and unknown Git owners remain fail-closed')
  recoveryStore.flush()
  console.log('PASS dead Git owner recovery, PID reuse, and live/unknown preservation')
} finally {
  delete globalThis.__gitGate
  fs.rmSync(temp, { recursive: true, force: true })
}
