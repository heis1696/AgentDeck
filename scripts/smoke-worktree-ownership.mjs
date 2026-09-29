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
// 回收调用计数插件：tasks:delete 处理器 bundle 内嵌自己的 git 副本，路径锁探针跨
// bundle 不可见——但 globalThis 计数可见。包装 removeWorktree 直接数「删单对同一棵树
// 发起了几次回收调用」，恰好一次的语义由端到端直接计数钉死
const reclaimCountPlugin = {
  name: 'count-remove-worktree',
  setup(builder) {
    builder.onResolve({ filter: /^(\.\/|\.\.\/)git$/ }, () => ({ path: 'git-count', namespace: 'git-count' }))
    builder.onResolve({ filter: /.*/, namespace: 'git-count' }, () => ({ path: gitSource, namespace: 'file' }))
    builder.onLoad({ filter: /.*/, namespace: 'git-count' }, () => ({
      loader: 'js',
      contents: `import * as real from ${JSON.stringify(gitSource)};
        export * from ${JSON.stringify(gitSource)};
        export async function removeWorktree(...args) {
          globalThis.__removeWorktreeCalls = (globalThis.__removeWorktreeCalls ?? 0) + 1
          return real.removeWorktree(...args)
        }`
    }))
  }
}
const [{ TaskStore }, { createExecutionOwner, currentProcessIdentity }, git, { runDelegationLoop }, ipcTasks, { registerSystemIpc }] = await Promise.all([
  load('src/main/store.ts', 'store'), load('src/main/persistence.ts', 'persistence'),
  load('src/main/git.ts', 'git'), load('src/main/delegate.ts', 'delegate', [gatePlugin]),
  load('src/main/ipc/tasks.ts', 'ipc-tasks', [electronStub, reclaimCountPlugin]),
  load('src/main/ipc/system.ts', 'ipc-system', [electronStub])
])
const { registerTaskIpc, collectWorktreeReclaims } = ipcTasks
const identity = (task) => ({ status: task.status, runId: task.runId, executionOwner: task.executionOwner, attempt: task.attempt })
const runGit = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true }).trim()
// Windows 路径别名写法：翻转首段（盘符/根段）大小写——与真实写法指同一目录
const flipCase = (p) => {
  const sep = p.indexOf(path.sep)
  const head = sep === -1 ? p : p.slice(0, sep)
  const flipped = head[0] === head[0].toLowerCase() ? head[0].toUpperCase() + head.slice(1) : head[0].toLowerCase() + head.slice(1)
  return sep === -1 ? flipped : flipped + p.slice(sep)
}

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
      const mergePointer = fs.readFileSync(path.join(mergePath, '.git'), 'utf8')
      const mergeGitdir = path.resolve(mergePath, /^gitdir:\s*(.+?)\s*$/im.exec(mergePointer)[1])
      fs.writeFileSync(path.join(mergeGitdir, 'agentdeck-generation'), `smoke-${mergeName}\n`)
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
    const directMergeCleanup = await git.reclaimWorktree(f.mergePath)
    assert.ok(!directMergeCleanup.ok && fs.existsSync(f.mergePath), 'direct reclaim cannot bypass merge-scaffold startup verification')
    const mergeSweep = await git.pruneWorktrees(f.repo, (owner) => git.shouldKeepTaskWorktree(f.peer.list(), f.repo, owner), {
      maxAgeMs: 0,
      claimWorktree: () => ({ release() {} })
    })
    assert.ok(mergeSweep.removed.includes(path.basename(f.mergePath)) && !fs.existsSync(f.mergePath), 'verified merge scaffold is reclaimable through startup sweep after release')
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

  // 别名租约覆盖面（fix：清理租约路径别名收口）：mergeWorktree 租约的仓库任务选取
  // 与 git.ts 的 worktreePathKey 同源折叠——在跑任务按别名写法（大小写差异）登记
  // workdir/worktree.repoDir 时租约必须照样覆盖它；漏覆盖会在仓库仍有在跑任务时
  // 误发租约，清扫就能动到活任务的现场。
  if (process.platform === 'win32') {
    const aliasLease = await fixture('alias-lease')
    const aliasRepo = flipCase(aliasLease.repo)
    assert.notEqual(aliasRepo, aliasLease.repo, '前置：别名写法与真实写法不同')
    assert.equal(aliasRepo.toLowerCase(), aliasLease.repo.toLowerCase(), '前置：别名写法仅大小写不同')
    const leaseParent = aliasLease.peer.get(aliasLease.parent.id)
    aliasLease.peer.updateIf(leaseParent.id, identity(leaseParent), { status: 'done', endedAt: Date.now() })
    // 在跑任务一：workdir 恰为仓库根本身的别名写法（根等值分支）
    const runningRoot = aliasLease.store.create({ title: 'alias running root', prompt: 'work', workdir: aliasRepo, backend: 'fake', agentId: 'runner_root' })
    aliasLease.store.claimRun(runningRoot.id, { status: 'queued' }, 'run_alias_root', createExecutionOwner())
    aliasLease.store.update(runningRoot.id, { status: 'running', startedAt: Date.now(), worktree: { ...aliasLease.worktree.metadata, ownerTaskId: runningRoot.id, repoDir: aliasRepo, path: aliasRepo } })
    // 在跑任务二：workdir 为仓库内子目录的别名写法（startsWith 包含分支）
    const aliasSub = path.join(aliasRepo, '.agentdeck-worktrees', 'alias_lease_sub_c1')
    const runningSub = aliasLease.store.create({ title: 'alias running sub', prompt: 'work', workdir: aliasSub, backend: 'fake', agentId: 'runner_sub' })
    aliasLease.store.claimRun(runningSub.id, { status: 'queued' }, 'run_alias_sub', createExecutionOwner())
    aliasLease.store.update(runningSub.id, { status: 'running', startedAt: Date.now() })
    const leaseDuringAliasRunning = aliasLease.peer.claimWorktreeCleanup(aliasLease.repo, '.agentdeck-merge-alias-lease', true)
    assert.equal(leaseDuringAliasRunning, undefined, '别名租约覆盖：在跑任务按别名写法登记时 mergeWorktree 租约必须拒发（仓库仍有在跑任务）')
    assert.equal(aliasLease.peer.get(aliasLease.parent.id).gitOperation, undefined, '租约拒发是整体落空：终态任务也不残留 Git 预约')
    // 对照组：别名在跑任务全部终态后，租约恢复发放——拒发确因别名在跑任务被租约覆盖
    aliasLease.peer.update(runningRoot.id, { status: 'done', endedAt: Date.now() })
    aliasLease.peer.update(runningSub.id, { status: 'done', endedAt: Date.now() })
    const leaseAfterAliasDone = aliasLease.peer.claimWorktreeCleanup(aliasLease.repo, '.agentdeck-merge-alias-lease', true)
    assert.ok(leaseAfterAliasDone, '别名在跑任务终态后租约恢复发放（对照：拒发不是夹具坏了）')
    aliasLease.peer.releaseGitOperation(leaseAfterAliasDone)
    aliasLease.store.flush()
    aliasLease.peer.flush()
    console.log('PASS alias lease coverage: running tasks recorded under alias spellings are covered by the cleanup lease')
  }

  // 根键租约覆盖面（fix：租约盘符根）：仓库根为盘符根/文件系统根时根键自带分隔符，
  // rootKey+sep 双分隔符前缀（c:\\）匹配不到根下任务键（c:\ws）——根下在跑任务漏出
  // 覆盖面会在仓库仍有在跑任务时误发租约，清扫就能动到活任务的现场。根前缀只在缺
  // 分隔符时补（与 acceptance-verifier 的根前缀规则同一套）
  {
    const rootLease = await fixture('root-lease')
    const driveRoot = path.parse(rootLease.repo).root
    const rootLeaseParent = rootLease.peer.get(rootLease.parent.id)
    rootLease.peer.updateIf(rootLeaseParent.id, identity(rootLeaseParent), { status: 'done', endedAt: Date.now() })
    // 在跑任务登记在根下子目录（非根等值，考验 startsWith 包含分支）；夹具仓库本身
    // 也在根下，其终态领队/子单照常被覆盖进目标集
    const underRoot = path.join(driveRoot, 'root_lease_ws_c1')
    const runningUnderRoot = rootLease.store.create({ title: 'running under root', prompt: 'work', workdir: underRoot, backend: 'fake', agentId: 'runner_under_root' })
    rootLease.store.claimRun(runningUnderRoot.id, { status: 'queued' }, 'run_under_root', createExecutionOwner())
    rootLease.store.update(runningUnderRoot.id, { status: 'running', startedAt: Date.now() })
    const leaseDuringRootRunning = rootLease.peer.claimWorktreeCleanup(driveRoot, '.agentdeck-root-lease', true)
    assert.equal(leaseDuringRootRunning, undefined, '根键租约覆盖：盘符根/文件系统根下在跑任务必须被租约覆盖（拒发）')
    assert.equal(rootLease.peer.get(rootLease.parent.id).gitOperation, undefined, '租约拒发是整体落空：终态任务也不残留 Git 预约')
    // 对照组：根下在跑任务终态后租约恢复发放——拒发确因根下在跑任务被覆盖
    rootLease.peer.update(runningUnderRoot.id, { status: 'done', endedAt: Date.now() })
    const leaseAfterRootDone = rootLease.peer.claimWorktreeCleanup(driveRoot, '.agentdeck-root-lease', true)
    assert.ok(leaseAfterRootDone, '根下在跑任务终态后租约恢复发放（对照：拒发不是夹具坏了）')
    rootLease.peer.releaseGitOperation(leaseAfterRootDone)
    rootLease.store.flush()
    rootLease.peer.flush()
    console.log('PASS root-key lease coverage: running tasks directly under the drive/filesystem root are covered by the cleanup lease')
  }

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
      const pointer = fs.readFileSync(path.join(wtPath, '.git'), 'utf8')
      const gitdir = path.resolve(wtPath, /^gitdir:\s*(.+?)\s*$/im.exec(pointer)[1])
      const generationId = `smoke-${name}`
      fs.writeFileSync(path.join(gitdir, 'agentdeck-generation'), `${generationId}\n`)
      fs.writeFileSync(path.join(metaDir, `${name}.json`), JSON.stringify({
        ownerTaskId: leaderId, generationId, repoDir: corpse.repo, path: wtPath, branch,
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

  // 清扫状态同步按别名折叠配对（fix：worktrees:prune 的任务↔sidecar 配对）：
  // 任务登记的 worktree.path 与 sidecar 元数据写法不同（大小写别名）时，字面量 ===
  // 配不上对，清扫后的状态同步漏更新——渲染层会一直显示过期状态。
  if (process.platform === 'win32') {
    const syncAlias = await fixture('sweep-sync-alias')
    const syncChild = syncAlias.peer.get(syncAlias.child.id)
    assert.ok(syncChild.worktree?.path, '前置：子单带 worktree 登记')
    const aliasWorktreePath = flipCase(syncChild.worktree.path)
    assert.notEqual(aliasWorktreePath, syncChild.worktree.path, '前置：别名写法与真实写法不同')
    // 任务登记写成别名 + 过期的 removed 状态；磁盘 sidecar 实为 active（领队还在跑，清扫保留现场）
    syncAlias.peer.update(syncChild.id, { worktree: { ...syncChild.worktree, path: aliasWorktreePath, cleanupStatus: 'removed' } })
    registerSystemIpc({ store: syncAlias.peer, settings: { worktreeMaxAgeDays: 30 }, getWindow: () => null })
    const syncReport = await globalThis.__worktreeHandlers.get('worktrees:prune')()
    assert.ok(syncReport, '前置：清扫完成')
    const synced = syncAlias.peer.get(syncChild.id)
    assert.equal(synced.worktree.cleanupStatus, 'active', '别名配对：状态同步把别名写法的任务登记对上 sidecar（过期 removed 被纠正为 active）')
    assert.equal(synced.worktree.path, syncChild.worktree.path, '同步写入的是 sidecar 的真实写法')
    assert.ok(fs.existsSync(syncChild.worktree.path), '别名配对的同步不误动现场：在跑领队的子单树保留')
    syncAlias.store.flush()
    syncAlias.peer.flush()
    console.log('PASS sweep status sync pairs task records with sidecar metadata across alias spellings')
  }

  // 删单回收去重（collectWorktreeReclaims）：领队/子单各按一种写法登记同一棵树时只回收
  // 一次；去重键按路径键折叠，文件调用保留首个原始写法与它自己的 owner。字面量 Map 键
  // 会对同一棵树发起两次并发 removeWorktree（同树双删互踩）。
  {
    const dedupeTree = await fixture('delete-reclaim-dedupe')
    const realPath = dedupeTree.worktree.path
    const aliasRealPath = process.platform === 'win32' ? flipCase(realPath) : realPath
    // 平台无关基线：两棵不同的树各回收一次；完全相同写法只回收一次
    const distinct = collectWorktreeReclaims([
      { id: 't1', workdir: '', worktree: { path: realPath, ownerTaskId: 't1' } },
      { id: 't2', workdir: path.join(dedupeTree.repo, 'elsewhere'), worktree: undefined }
    ])
    assert.equal(distinct.length, 2, '基线：两棵不同的树各保留一条回收项')
    assert.equal(collectWorktreeReclaims([{ id: 't1', workdir: '', worktree: { path: realPath, ownerTaskId: 't1' } }, { id: 't2', workdir: realPath }]).length, 1, '基线：完全相同写法折叠成一条')
    if (process.platform === 'win32') {
      assert.notEqual(aliasRealPath, realPath, '前置：别名写法与真实写法不同')
      const deduped = collectWorktreeReclaims([
        { id: 'leader', workdir: '', worktree: { path: realPath, ownerTaskId: 'leader' } },
        { id: 'child', workdir: aliasRealPath }
      ])
      assert.equal(deduped.length, 1, '别名去重：同一棵树的双别名写法只回收一次')
      assert.equal(deduped[0].worktreePath, realPath, '别名去重保留首个原始写法供真实文件调用')
      assert.equal(deduped[0].ownerTaskId, 'leader', '别名去重保留首条自己的 owner')
      console.log('PASS delete reclaim list folds alias spellings into a single reclaim entry')
    }
    dedupeTree.store.flush()
    dedupeTree.peer.flush()
  }
  // 端到端：tasks:delete 对「领队真实写法 + 子单别名写法」的同一棵树照常收场——
  // 「恰好一次」的语义由 collectWorktreeReclaims 的折叠去重单测钉死（处理器 bundle
  // 内嵌自己的 git 副本，路径锁探针跨 bundle 不可见），这里证端到端接线不回归
  if (process.platform === 'win32') {
    const e2eTree = await fixture('delete-reclaim-alias-e2e')
    await e2eTree.execute()
    const e2eLeader = e2eTree.peer.get(e2eTree.parent.id)
    e2eTree.peer.updateIf(e2eLeader.id, identity(e2eLeader), { status: 'done', endedAt: Date.now() })
    const e2eWtPath = e2eLeader.worktree.path
    const e2eBranch = e2eLeader.worktree.branch
    const e2eChild = e2eTree.peer.get(e2eTree.child.id)
    // 子单的 workdir 改写成同一棵集成树的别名写法（无 worktree 登记，走 workdir 通道）
    e2eTree.peer.update(e2eChild.id, { workdir: flipCase(e2eWtPath), worktree: undefined })
    registerTaskIpc({ store: e2eTree.peer, runner: { pushTask() {} }, issueStore: { sync() {}, syncEventually() {} }, getWindow: () => null })
    // 恰好一次直接计数：处理器 bundle 的 removeWorktree 经计数插件包装（globalThis
    // 跨 bundle 可见），折叠去重失效会对同一棵树发起两次并发回收，计数翻倍即红
    globalThis.__removeWorktreeCalls = 0
    const e2eDelete = await globalThis.__worktreeHandlers.get('tasks:delete')(null, e2eTree.parent.id)
    assert.ok(e2eDelete.ok, '端到端：双别名删单成功')
    const deadline = Date.now() + 8000
    while (Date.now() < deadline && (fs.existsSync(e2eWtPath) || await git.branchExists(e2eTree.repo, e2eBranch))) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.ok(!fs.existsSync(e2eWtPath), '端到端：双别名删单把同一棵树收场')
    assert.equal(await git.branchExists(e2eTree.repo, e2eBranch), false, '端到端：托管分支一并删除')
    assert.equal(globalThis.__removeWorktreeCalls, 1, `端到端：同一棵树恰好发起一次回收调用（实际 ${globalThis.__removeWorktreeCalls} 次，双别名去重失效会翻倍）`)
    e2eTree.store.flush()
    e2eTree.peer.flush()
    console.log('PASS tasks:delete reclaims an alias-referenced tree end to end')
  }

  // 手动清扫直断：worktrees:prune 处理器的仓库集合按路径键折叠——领队/子单各按一种
  // 写法登记同一仓库时只扫一次（scanned 恰等于折叠预言机，去重失效会对同一现场扫两遍）
  if (process.platform === 'win32') {
    const manualSweep = await fixture('manual-sweep-alias-repo')
    await manualSweep.execute()
    const manualLeader = manualSweep.peer.get(manualSweep.parent.id)
    manualSweep.peer.updateIf(manualLeader.id, identity(manualLeader), { status: 'done', endedAt: Date.now() })
    // 领队登记真实仓库写法（worktree.repoDir），另造一单按别名写法登记同一仓库（workdir）
    const aliasRepoSpelling = flipCase(manualSweep.repo)
    const extraRunner = manualSweep.peer.create({ title: 'alias repo viewer', prompt: 'work', workdir: aliasRepoSpelling, backend: 'fake', agentId: 'viewer' })
    manualSweep.peer.update(extraRunner.id, { status: 'done', endedAt: Date.now() })
    // 拆掉续链保留判定（integration.branch 在册即保留集成树）：让断言只考验「别名仓库
    // 集合去重 + 终态任务树回收」，不被续链保留规则截住
    manualSweep.peer.update(manualLeader.id, { integration: undefined })
    registerSystemIpc({ store: manualSweep.peer, settings: { worktreeMaxAgeDays: 0 }, getWindow: () => null })
    // 扫描数预言机：磁盘目录 + sidecar + Git 注册表三源并集按路径键折叠后的元素数
    const manualManagedDir = path.join(manualSweep.repo, '.agentdeck-worktrees')
    const manualDiskTrees = fs.readdirSync(manualManagedDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== '.metadata')
      .map((entry) => path.join(manualManagedDir, entry.name))
    const manualRegistrationTrees = (() => {
      try {
        return fs.readdirSync(path.join(manualSweep.repo, '.git', 'worktrees'), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => path.dirname(fs.readFileSync(path.join(manualSweep.repo, '.git', 'worktrees', entry.name, 'gitdir'), 'utf8').trim()))
      } catch { return [] }
    })()
    const manualOracle = new Set([
      ...manualDiskTrees,
      ...manualRegistrationTrees,
      ...git.listWorktreeMetadata(manualSweep.repo).map((item) => item.path)
    ].map((candidate) => path.resolve(candidate).toLowerCase())).size
    const manualReport = await globalThis.__worktreeHandlers.get('worktrees:prune')()
    assert.equal(manualReport.scanned, manualOracle, `手动清扫：同一仓库的别名写法只扫一次（scanned=${manualReport.scanned}，预言机=${manualOracle}，去重失效会翻倍）`)
    assert.ok(manualReport.removed.includes(path.basename(manualLeader.worktree.path)), '手动清扫：终态领队的集成树照常回收')
    assert.ok(!fs.existsSync(manualLeader.worktree.path), '手动清扫：目录收场')
    manualSweep.store.flush()
    manualSweep.peer.flush()
    console.log('PASS manual sweep folds alias repo spellings into a single scan')
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
