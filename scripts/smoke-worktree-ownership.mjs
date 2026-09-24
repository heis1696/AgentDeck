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
      export const ipcMain = {
        handle: (name, handler) => globalThis.__worktreeHandlers.set(name, handler),
        on: () => {}
      }
      export const BrowserWindow = { getAllWindows: () => [] }
      export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
      export const Notification = { isSupported: () => false }
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
const [{ TaskStore }, { createExecutionOwner, currentProcessIdentity }, git, { runDelegationLoop }, { registerTaskIpc }, { registerSystemIpc }] = await Promise.all([
  load('src/main/store.ts', 'store'), load('src/main/persistence.ts', 'persistence'),
  load('src/main/git.ts', 'git'), load('src/main/delegate.ts', 'delegate', [gatePlugin]),
  load('src/main/ipc/tasks.ts', 'ipc-tasks', [electronStub]),
  load('src/main/ipc/system.ts', 'ipc-system', [electronStub])
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
    // M1 终态即落盘：循环在等待终态解析后先对队员 worktree 跑一次 commitAll（无 Git
    // operation 持有）——gate 只拦集成期（operation 已认领）的那次调用
    let gateCalls = 0
    globalThis.__gitGate = async (at) => {
      if (at === stage) {
        gateCalls++
        if (stage === 'commitAll' && gateCalls === 1) return
        entered(); await resume
      }
    }
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
  // M1 终态即落盘：已交付改动在终态解析时即提交（先于任何替换写），替换写永远不会被收编
  assert.notEqual(runGit(f.worktree.path, 'rev-parse', 'HEAD'), base, 'the terminal delivery is committed at terminal time')
  assert.equal(runGit(f.worktree.path, 'log', '-1', '--format=%s'), 'agentdeck: child', 'the terminal commit is the child delivery commit')
  assert.equal(runGit(f.worktree.path, 'show', 'HEAD:result.txt'), 'delivered', 'the terminal commit captured the delivered content')
  assert.equal(fs.readFileSync(path.join(f.worktree.path, 'result.txt'), 'utf8'), 'replacement in progress\n')
  assert.equal(await git.branchExists(f.repo, 'agentdeck/task-' + f.parent.id), false, 'the old report cannot merge the replacement work')
  assert.equal(f.store.get(f.child.id).gitOperation, undefined)
  f.store.flush()
  f.peer.flush()
  console.log('PASS terminal-time commit captures the delivery; a retried child replacement is never integrated')

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

  // cancelled 子单的现场原样保留：终态即落盘对 cancelled 例外，清扫不得代替删任务的
  // 显式路径收走现场——目录与分支都留，否则「保留现场」只活到下次重启。
  const cancelled = await fixture('cancelled-keep')
  cancelled.peer.updateIf(cancelled.parent.id, identity(cancelled.peer.get(cancelled.parent.id)), { status: 'done', endedAt: Date.now() })
  const cancelledChildDone = cancelled.peer.get(cancelled.child.id)
  assert.equal(git.shouldKeepTaskWorktree(cancelled.peer.list(), cancelled.repo, cancelled.child.id), false, 'control: a done child under a done parent stays reclaimable')
  cancelled.peer.updateIf(cancelledChildDone.id, identity(cancelledChildDone), { status: 'cancelled' })
  // 现场先落盘成干净副本：排除「脏目录保留」的旧通道，让断言只考验 cancelled 规则本身
  const cancelledMeta = git.listWorktreeMetadata(cancelled.repo).find((item) => item.ownerTaskId === cancelled.child.id)
  assert.ok(cancelledMeta, 'the cancelled child worktree carries owner metadata')
  runGit(cancelledMeta.path, 'add', '-A')
  runGit(cancelledMeta.path, 'commit', '-qm', 'cancelled scene committed')
  assert.equal(git.shouldKeepTaskWorktree(cancelled.peer.list(), cancelled.repo, cancelled.child.id, cancelledMeta), true, 'a cancelled child keeps its worktree scene')
  const cancelledSweep = await git.pruneWorktrees(cancelled.repo, (owner, worktree) => git.shouldKeepTaskWorktree(cancelled.peer.list(), cancelled.repo, owner, worktree), {
    maxAgeMs: 0,
    claimWorktree: (owner) => {
      const claim = cancelled.peer.claimWorktreeCleanup(cancelled.repo, owner, false)
      return claim ? { release: () => cancelled.peer.releaseGitOperation(claim) } : undefined
    }
  })
  assert.ok(fs.existsSync(cancelledMeta.path) && cancelledSweep.retained.some((item) => item.name === path.basename(cancelledMeta.path)), 'the sweep retains the cancelled scene (directory included)')
  assert.equal(await git.branchExists(cancelled.repo, cancelledMeta.branch), true, 'the sweep never deletes the cancelled child branch')
  // 删任务的显式路径统一回收：目录与分支一起带走
  registerTaskIpc({ store: cancelled.peer, runner: { pushTask() {} }, issueStore: { sync() {}, syncEventually() {} }, getWindow: () => null })
  const cancelledDelete = await globalThis.__worktreeHandlers.get('tasks:delete')(null, cancelled.child.id)
  assert.ok(cancelledDelete.ok, 'explicit deletion of the cancelled child succeeds')
  const cancelledDeadline = Date.now() + 8000
  while (Date.now() < cancelledDeadline && (fs.existsSync(cancelledMeta.path) || await git.branchExists(cancelled.repo, cancelledMeta.branch))) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.ok(!fs.existsSync(cancelledMeta.path), 'explicit deletion reclaims the cancelled worktree directory')
  assert.equal(await git.branchExists(cancelled.repo, cancelledMeta.branch), false, 'explicit deletion takes the cancelled child branch with it')
  cancelled.store.flush()
  cancelled.peer.flush()
  console.log('PASS cancelled child worktree: sweep keeps directory and branch, explicit deletion reclaims both')

  // 续链集成 worktree 的保留判定：领队（含 done）的 integration worktree 持有未合并的
  // 集成结果，任务存在期间清扫不回收；任务删除后回归既有清扫渠道。
  const chain = await fixture('chain-keep')
  await chain.execute()
  const chainParentDone = chain.peer.get(chain.parent.id)
  chain.peer.updateIf(chainParentDone.id, identity(chainParentDone), { status: 'done', endedAt: Date.now() })
  const chainWtPath = chain.peer.get(chain.parent.id).workdir
  assert.ok(chainWtPath && chainWtPath.includes('.agentdeck-worktrees'), 'the integration switched the leader workdir to a managed worktree')
  const chainMeta = git.listWorktreeMetadata(chain.repo).find((item) => item.path === chainWtPath)
  assert.ok(chainMeta && chainMeta.branch === 'agentdeck/task-' + chain.parent.id, 'the integration worktree is registered with owner metadata')
  assert.equal(git.shouldKeepTaskWorktree(chain.peer.list(), chain.repo, chain.parent.id, chainMeta), true, 'a done leader keeps its integration worktree (unmerged result)')
  assert.equal(git.shouldKeepTaskWorktree(chain.peer.list(), chain.repo, chain.parent.id), false, 'without metadata the legacy keep answer stays false')
  const chainSweep = await git.pruneWorktrees(chain.repo, (owner, worktree) => git.shouldKeepTaskWorktree(chain.peer.list(), chain.repo, owner, worktree), { maxAgeMs: 0 })
  assert.ok(fs.existsSync(chainWtPath) && chainSweep.retained.some((item) => item.name === `task-${chain.parent.id}-integrated`), 'the sweep retains the integration worktree while the leader task exists')
  // M1：保留判定只按 owner.integration.branch 认归属——领队 workdir 被改绑/解绑（放弃窗口、
  // 用户改目录）都不构成清扫回收集成分支的理由
  chain.peer.updateIf(chain.parent.id, identity(chain.peer.get(chain.parent.id)), { workdir: chain.repo })
  assert.equal(git.shouldKeepTaskWorktree(chain.peer.list(), chain.repo, chain.parent.id, chainMeta), true, 'keep matches by integration.branch alone: a repointed workdir does not release the result')
  const chainSweepRepointed = await git.pruneWorktrees(chain.repo, (owner, worktree) => git.shouldKeepTaskWorktree(chain.peer.list(), chain.repo, owner, worktree), { maxAgeMs: 0 })
  assert.ok(fs.existsSync(chainWtPath) && chainSweepRepointed.retained.some((item) => item.name === `task-${chain.parent.id}-integrated`), 'the sweep still retains the integration worktree after the workdir moved away')
  assert.equal(await git.branchExists(chain.repo, 'agentdeck/task-' + chain.parent.id), true, 'the integration branch survives the abandon window')

  // m3：mergeIntoManagedWorktree 前置校验——脏目录 / 归属不符都拒绝并明示，不静默合并
  fs.writeFileSync(path.join(chainWtPath, 'dirty.txt'), '领队未提交的本地改动\n')
  const dirtyRefused = await git.mergeIntoManagedWorktree(chainWtPath, 'main', chain.parent.id)
  assert.equal(dirtyRefused.ok, false, 'm3: a dirty managed worktree refuses the in-place merge')
  assert.match(dirtyRefused.message, /uncommitted changes/, 'm3: the refusal names the uncommitted changes')
  const foreignRefused = await git.mergeIntoManagedWorktree(chainWtPath, 'main', 'task-someone-else')
  assert.equal(foreignRefused.ok, false, 'm3: a foreign owner refuses the in-place merge')
  assert.match(foreignRefused.message, /owner/, 'm3: the refusal names the ownership mismatch')
  fs.unlinkSync(path.join(chainWtPath, 'dirty.txt'))
  const cleanMerged = await git.mergeIntoManagedWorktree(chainWtPath, 'main', chain.parent.id)
  assert.equal(cleanMerged.ok, true, 'm3: a clean owned managed worktree accepts the in-place merge')

  // 块四：临时 worktree 通道（--detach 双检出 + update-ref 回指）+ 幻影暂存守卫（先红：通道与守卫均为新函数）
  {
    const fbRepo = path.join(temp, 'detach-fb', 'repo')
    fs.mkdirSync(fbRepo, { recursive: true })
    runGit(fbRepo, 'init', '-q', '-b', 'main')
    runGit(fbRepo, 'config', 'user.email', 'smoke@example.com')
    runGit(fbRepo, 'config', 'user.name', 'AgentDeck Smoke')
    fs.writeFileSync(path.join(fbRepo, 'f.txt'), 'f v1\n')
    runGit(fbRepo, 'add', '.')
    runGit(fbRepo, 'commit', '-qm', 'base')
    const ibFb = 'agentdeck/task-detachfb'
    runGit(fbRepo, 'branch', ibFb)
    const wtFb = await git.createWorktreeAtBranch(fbRepo, 'task-detachfb-integrated', ibFb, 'task-detachfb')
    assert.ok(wtFb, '块四：集成托管 worktree 创建')
    // 源分支：f.txt v2（主检出上切出、提交、切回，不动托管 worktree）
    runGit(fbRepo, 'checkout', '-b', 'agentdeck/src2')
    fs.writeFileSync(path.join(fbRepo, 'f.txt'), 'f v2\n')
    runGit(fbRepo, 'add', '.')
    runGit(fbRepo, 'commit', '-qm', 'f v2')
    runGit(fbRepo, 'checkout', 'main')
    // 就地通道因托管副本脏被拒（commitAll 后仍不干净的退路场景）→ 临时 worktree 通道接棒
    fs.writeFileSync(path.join(wtFb.path, 'leader-local.txt'), '领队未提交交付\n')
    const inPlace = await git.mergeIntoManagedWorktree(wtFb.path, 'agentdeck/src2', 'task-detachfb')
    assert.equal(inPlace.ok, false, '块四：就地合并被拒（托管副本脏）')
    const fb = await git.mergeIntoManagedWorktreeDetached(wtFb.path, 'agentdeck/src2', 'task-detachfb')
    assert.equal(fb.ok, false, '块四：真脏在场时退回通道 fail-closed（合并已回指但副本拒绝对齐）')
    assert.match(fb.message, /realignment failed/, '块四：fail-closed 文案说明对齐失败')
    // 清掉真脏（对齐 delegate 真实时序：commitAll 之后才退回），临时通道完整走通
    fs.unlinkSync(path.join(wtFb.path, 'leader-local.txt'))
    const fb2 = await git.mergeIntoManagedWorktreeDetached(wtFb.path, 'agentdeck/src2', 'task-detachfb')
    assert.equal(fb2.ok, true, `块四：临时 worktree 通道合入成功（${fb2.message}）`)
    assert.equal(runGit(fbRepo, 'show', ibFb + ':f.txt'), 'f v2', '块四：update-ref 回指后分支内容=f v2')
    const leftoverTmp = fs.readdirSync(path.join(fbRepo, '.agentdeck-worktrees')).filter((name) => name.startsWith('.agentdeck-merge-detach-'))
    assert.deepEqual(leftoverTmp, [], '块四：临时 detach worktree 用后即清')
    const statusFb = runGit(wtFb.path, 'status', '--porcelain', '--untracked-files=all')
    assert.equal(statusFb, '', `块四：退回路后 worktree 干净（${JSON.stringify(statusFb)}）`)
    assert.equal(fs.readFileSync(path.join(wtFb.path, 'f.txt'), 'utf8').trim(), 'f v2', '块四：对齐后托管副本内容更新到 v2')
    // 下一轮 commitAll 不回滚已合入改动：干净副本零改动、分支 HEAD 不动、f.txt 保持 v2
    const headBeforeCommit = runGit(fbRepo, 'rev-parse', ibFb)
    assert.equal(await git.commitAll(wtFb.path, 'agentdeck: 下一轮领队提交'), false, '块四：对齐后的干净副本 commitAll 零改动')
    assert.equal(runGit(fbRepo, 'rev-parse', ibFb), headBeforeCommit, '块四：下一轮 commitAll 不回滚已合入改动（分支 HEAD 不动）')
    assert.equal(runGit(fbRepo, 'show', ibFb + ':f.txt'), 'f v2', '块四：f.txt 保持 v2（不回滚到 v1）')
    // headSha 观测链自洽
    const sumFb = await git.branchDiffSummary(fbRepo, 'main', ibFb)
    assert.equal(sumFb.snapshot.headSha, runGit(fbRepo, 'rev-parse', ibFb), '块四：branchDiffSummary headSha 观测=分支实际 HEAD')
    // 幻影暂存守卫 fail-closed 面：未跟踪 / 工作副本列 = 真脏拒绝对齐
    fs.writeFileSync(path.join(wtFb.path, 'real-dirty.txt'), 'x\n')
    const refuseUntracked = await git.realignCleanWorktreeToHead(wtFb.path)
    assert.equal(refuseUntracked.ok, false, '块四：未跟踪文件=真脏 fail-closed')
    assert.match(refuseUntracked.reason, /fail-closed/, '块四：fail-closed 具名原因')
    fs.unlinkSync(path.join(wtFb.path, 'real-dirty.txt'))
    fs.writeFileSync(path.join(wtFb.path, 'f.txt'), 'f v3 本地未落盘\n')
    const refuseWt = await git.realignCleanWorktreeToHead(wtFb.path)
    assert.equal(refuseWt.ok, false, '块四：工作副本列改动=真脏 fail-closed')
    // 用 git 还原（autocrlf 下 checkout 产物与手写 LF 字节不同，手写会被 git 判真脏）
    execFileSync('git', ['-C', wtFb.path, 'checkout', '--', 'f.txt'], { stdio: 'ignore' })
    assert.equal((await git.realignCleanWorktreeToHead(wtFb.path)).ok, true, '块四：真脏清除后对齐恢复')
    // index 陈旧形态（仅暂存列，update-ref 回指后的自然产物）→ 照常 reset --hard 对齐
    runGit(fbRepo, 'checkout', '-b', 'agentdeck/src3')
    fs.writeFileSync(path.join(fbRepo, 'f2.txt'), 'f2 v1\n')
    runGit(fbRepo, 'add', '.')
    runGit(fbRepo, 'commit', '-qm', 'f2 v1')
    runGit(fbRepo, 'checkout', 'main')
    const src3Head = runGit(fbRepo, 'rev-parse', 'agentdeck/src3')
    runGit(fbRepo, 'update-ref', `refs/heads/${ibFb}`, src3Head)
    const staleStatus = runGit(wtFb.path, 'status', '--porcelain', '--untracked-files=all')
    assert.ok(staleStatus.trim() !== '', '块四：update-ref 回指后副本呈现暂存列形态')
    assert.ok(staleStatus.split('\n').filter(Boolean).every((line) => line[0] !== '?' && line[1] === ' '), `块四：残余脏仅在暂存列（${JSON.stringify(staleStatus)}）`)
    const realignStale = await git.realignCleanWorktreeToHead(wtFb.path)
    assert.equal(realignStale.ok, true, `块四：index 陈旧（仅暂存列）照常对齐（${realignStale.reason ?? ''}）`)
    assert.equal(runGit(wtFb.path, 'rev-parse', 'HEAD'), src3Head, '块四：对齐后副本 HEAD=回指目标')
    assert.equal(fs.readFileSync(path.join(wtFb.path, 'f2.txt'), 'utf8').trim(), 'f2 v1', '块四：对齐带回回指内容')
    console.log('PASS detached fallback channel + phantom-staging realign guard')
  }

  // M1：清扫路径绝不删集成分支——即使 owner 记录已删除（借 repo 内其他任务的 claim 回收目录）
  chain.peer.delete(chain.parent.id)
  const orphanSweep = await git.pruneWorktrees(chain.repo, (owner, worktree) => git.shouldKeepTaskWorktree(chain.peer.list(), chain.repo, owner, worktree), {
    maxAgeMs: 0,
    claimWorktree: (owner) => {
      const claim = chain.peer.claimWorktreeCleanup(chain.repo, owner, true)
      return claim ? { release: () => chain.peer.releaseGitOperation(claim) } : undefined
    }
  })
  assert.ok(!fs.existsSync(chainWtPath) && orphanSweep.removed.includes(`task-${chain.parent.id}-integrated`), 'the sweep reclaims the orphaned integration worktree directory')
  assert.equal(await git.branchExists(chain.repo, 'agentdeck/task-' + chain.parent.id), true, 'the sweep never deletes an integration branch — only explicit task deletion may')
  chain.store.flush()
  chain.peer.flush()
  console.log('PASS chain continuation worktree: kept by integration.branch alone, sweep keeps the branch, explicit delete reclaims it')

  // ── merge 尸体清扫：crashLeftover 优先于 owner keep + 失败可见 ──
  // 现场实证：merge 临时目录（.agentdeck-merge-*）检出集成分支且带 owner 侧车时，
  // keepTask 判定先于 crashLeftover 判定——owner 在册（哪怕早已终态）就把施工脚手架
  // 当成果载体 retain 永不回收。修后：尸体直接进回收流程（租约照拿），集成分支守卫照旧。
  {
    const corpse = await fixture('merge-corpse-sweep')
    const leaderId = corpse.parent.id
    const ib = 'agentdeck/task-' + leaderId
    const markDone = () => {
      const current = corpse.peer.get(leaderId)
      corpse.peer.updateIf(leaderId, identity(current), { status: 'done', endedAt: Date.now() })
    }
    markDone()
    const latest = () => corpse.peer.get(leaderId)
    corpse.peer.updateIf(leaderId, identity(latest()), { integration: { branch: ib } })
    runGit(corpse.repo, 'branch', ib, 'main')
    fs.mkdirSync(path.join(corpse.repo, '.agentdeck-worktrees'), { recursive: true })
    const writeCorpseMetadata = (name, wtPath, branch) => {
      const metaDir = path.join(corpse.repo, '.agentdeck-worktrees', '.metadata')
      fs.mkdirSync(metaDir, { recursive: true })
      fs.writeFileSync(path.join(metaDir, `${name}.json`), JSON.stringify({
        ownerTaskId: leaderId, repoDir: corpse.repo, path: wtPath, branch,
        baseSha: runGit(corpse.repo, 'rev-parse', 'main'), createdAt: Date.now() - 86400000, cleanupStatus: 'active'
      }))
    }
    const pruneWithLease = () => git.pruneWorktrees(corpse.repo, (owner, worktree) => git.shouldKeepTaskWorktree(corpse.peer.list(), corpse.repo, owner, worktree), {
      maxAgeMs: 0,
      claimWorktree: (owner, merge) => {
        const claim = corpse.peer.claimWorktreeCleanup(corpse.repo, owner, merge)
        return claim ? { release: () => corpse.peer.releaseGitOperation(claim) } : undefined
      }
    })
    // ① owner 任务在册 + 尸体检出集成分支 → 清扫回收目录，集成分支保留
    const corpse1Name = `.agentdeck-merge-corpse1-${Date.now().toString(36)}`
    const corpse1Path = path.join(corpse.repo, '.agentdeck-worktrees', corpse1Name)
    runGit(corpse.repo, 'worktree', 'add', corpse1Path, ib)
    writeCorpseMetadata(corpse1Name, corpse1Path, ib)
    const sweep1 = await pruneWithLease()
    assert.ok(!fs.existsSync(corpse1Path) && sweep1.removed.includes(corpse1Name), '① merge 尸体（owner 在册+检出集成分支）被清扫回收目录')
    assert.equal(await git.branchExists(corpse.repo, ib), true, '① 集成分支保留（清扫只减目录与侧车）')
    // ① 尸体检出普通 agentdeck/ 子分支 → 按既有守卫连分支删
    const sideBranch = `agentdeck/corpse-side-${Date.now().toString(36)}`
    runGit(corpse.repo, 'branch', sideBranch, 'main')
    const corpse2Name = `.agentdeck-merge-corpse2-${Date.now().toString(36)}`
    const corpse2Path = path.join(corpse.repo, '.agentdeck-worktrees', corpse2Name)
    runGit(corpse.repo, 'worktree', 'add', corpse2Path, sideBranch)
    writeCorpseMetadata(corpse2Name, corpse2Path, sideBranch)
    const sweep2 = await pruneWithLease()
    assert.ok(!fs.existsSync(corpse2Path) && sweep2.removed.includes(corpse2Name), '① 检出普通 agentdeck/ 子分支的尸体连目录回收')
    assert.equal(await git.branchExists(corpse.repo, sideBranch), false, '① 普通托管分支按既有守卫随尸体一并删除')
    // ② 租约不可用 → retain 且 reason 含 ownership（留待下轮）
    const corpse3Name = `.agentdeck-merge-corpse3-${Date.now().toString(36)}`
    const corpse3Path = path.join(corpse.repo, '.agentdeck-worktrees', corpse3Name)
    runGit(corpse.repo, 'worktree', 'add', corpse3Path, ib)
    writeCorpseMetadata(corpse3Name, corpse3Path, ib)
    const sweep3 = await git.pruneWorktrees(corpse.repo, (owner, worktree) => git.shouldKeepTaskWorktree(corpse.peer.list(), corpse.repo, owner, worktree), {
      maxAgeMs: 0,
      claimWorktree: () => undefined
    })
    const retainedEntry = sweep3.retained.find((item) => item.name === corpse3Name)
    assert.ok(retainedEntry && fs.existsSync(corpse3Path), '② 租约不可用 → 尸体 retain 待下轮')
    assert.match(retainedEntry.reason, /ownership/, '② retain 原因含 ownership')
    // ③ reclaim 失败（Windows 句柄占用/断开 gitdir 链接）→ failed 项 + 时间线事件可见
    const corpse4Name = `.agentdeck-merge-corpse4-${Date.now().toString(36)}`
    const corpse4Path = path.join(corpse.repo, '.agentdeck-worktrees', corpse4Name)
    runGit(corpse.repo, 'worktree', 'add', '--detach', corpse4Path, 'main')
    writeCorpseMetadata(corpse4Name, corpse4Path, ib)
    const occupied = fs.openSync(path.join(corpse4Path, 'occupied.txt'), 'w')
    fs.writeFileSync(path.join(corpse4Path, 'occupied.txt'), '外部程序占用的文件\n')
    fs.rmSync(path.join(corpse4Path, '.git'))
    registerSystemIpc({ store: corpse.peer, settings: { worktreeMaxAgeDays: 30 }, getWindow: () => null })
    const report = await globalThis.__worktreeHandlers.get('worktrees:prune')()
    assert.ok(report.failed.some((item) => item.name === corpse4Name), '③ reclaim 失败计入 failed（不再静默）')
    const eventsFile = path.join(corpse.data, 'tasks', leaderId, 'events.jsonl')
    assert.ok(fs.existsSync(eventsFile), '③ 失败事件落 owner 任务时间线')
    const noteLine = fs.readFileSync(eventsFile, 'utf8').split('\n').find((line) => line.includes(corpse4Name))
    assert.ok(noteLine, '③ 事件含目录名')
    const noteEvent = JSON.parse(noteLine)
    assert.equal(noteEvent.data.worktreeCleanupFailed.name, corpse4Name, '③ 事件记录目录名')
    assert.ok(noteEvent.data.worktreeCleanupFailed.reason, '③ 事件记录失败原因')
    assert.match(noteEvent.text, /外部程序/, '③ 文案带占用排查提示')
    fs.closeSync(occupied)
    corpse.store.flush()
    corpse.peer.flush()
    console.log('PASS merge corpse sweep: crashLeftover beats owner keep, ownership retain names the lease, failed cleanup lands on the timeline')
  }

  // 显式删除路径（tasks:delete → removeWorktree）才允许带走集成分支
  const chain2 = await fixture('chain-explicit-delete')
  await chain2.execute()
  const chain2WtPath = chain2.peer.get(chain2.parent.id).workdir
  assert.ok(chain2WtPath && chain2WtPath.includes('.agentdeck-worktrees'), 'the second fixture switched its leader workdir too')
  chain2.peer.updateIf(chain2.parent.id, identity(chain2.peer.get(chain2.parent.id)), { status: 'done', endedAt: Date.now() })
  // 块三 GC 挂线一（先红：基线删任务不清副本）：tasks:delete 连带清理主仓库根报告副本；在册任务副本保留
  const keeperChain2 = chain2.store.create({ title: 'keeper', prompt: 'x', workdir: chain2.repo, backend: 'fake' })
  const reportsDirChain2 = path.join(chain2.repo, '.agentdeck-reports')
  fs.mkdirSync(reportsDirChain2, { recursive: true })
  fs.writeFileSync(path.join(reportsDirChain2, `${chain2.parent.id}.md`), 'parent 全文\n')
  fs.writeFileSync(path.join(reportsDirChain2, `${keeperChain2.id}.md`), 'keeper 全文\n')
  registerTaskIpc({ store: chain2.peer, runner: { pushTask() {} }, issueStore: { sync() {}, syncEventually() {} }, getWindow: () => null })
  const deleteResult = await globalThis.__worktreeHandlers.get('tasks:delete')(null, chain2.parent.id)
  assert.ok(deleteResult.ok, 'explicit task deletion succeeds')
  // removeWorktree 是删除处理器里的 fire-and-forget：轮询到目录与分支都消失
  const explicitDeadline = Date.now() + 8000
  while (Date.now() < explicitDeadline && (fs.existsSync(chain2WtPath) || await git.branchExists(chain2.repo, 'agentdeck/task-' + chain2.parent.id))) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.ok(!fs.existsSync(chain2WtPath), 'explicit deletion reclaims the integration worktree')
  assert.equal(await git.branchExists(chain2.repo, 'agentdeck/task-' + chain2.parent.id), false, 'explicit deletion takes the integration branch with it')
  assert.equal(fs.existsSync(path.join(reportsDirChain2, `${chain2.parent.id}.md`)), false, '块三挂线一：删任务连带清理其报告副本')
  assert.equal(fs.existsSync(path.join(reportsDirChain2, `${chain2.child.id}.md`)), false, '块三挂线一：子单报告副本一并清理（fixture 循环写入的副本）')
  assert.equal(fs.existsSync(path.join(reportsDirChain2, `${keeperChain2.id}.md`)), true, '块三挂线一：在册任务的副本保留')
  fs.unlinkSync(path.join(reportsDirChain2, `${keeperChain2.id}.md`))
  chain2.store.flush()
  chain2.peer.flush()
  console.log('PASS explicit task deletion takes the integration branch with it')

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
