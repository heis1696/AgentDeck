// worktree 建树超时连环根治的断言面（背景：8.2 万文件 Unity 仓，60s 固定超时只杀 git 父进程，
// checkout 孤儿继续持有 index.lock → 回放撞活锁拒单 → 回收残肢 → 重派 branch already exists）：
// ① 超时自适应：worktree add 按 ls-files 计数放大超时（60s 基线 + 每 1 万文件 +60s，封顶 15 分钟），每仓 TTL 缓存
// ①b 计数归一：子目录调用与根调用同值同键（repositoryRoot 归一后计数/缓存），消除子目录低估+低值缓存回退面
// ② 既存 worktree/branch 拒绝接管；本次 checkout 超时绝不误报成功且清除自建残肢
// ③ 进程树击杀：win32 taskkill /PID <pid> /T /F 参数断言级 + 真实孤儿 hook 对照（旧病可复现、树杀后不复发）
// ③c 树杀失败不阻塞：taskkill 非零退出且目标不死 → close/exit+二次 deadline 收口，限时返回不 pending
// ④ 回收原子性与可见：失败步骤重试一次，残留清单（分支名/注册路径）随结果上报并经
//    noteWorktreeCleanupFailure 落时间线；目录回收不回滚；启动清扫兜底能清「目录已删+注册/分支残留」
// ④b 已存在分支保持原样；本次超时清理分支失败则残留进入拒单和时间线
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-worktree-timeout-'))
const gitSource = path.join(root, 'src/main/git.ts')

// child_process 垫片包：只劫持「git worktree add」（伪装慢子进程，永不自行退出）与
// taskkill（记录参数、并回收对应假子进程）；其余 git 调用直通真实 child_process，
// 保证超时清理路径（worktree remove/prune/branch -D）在垫片包里仍然真实工作。
// globalThis.__cpShimTaskkill = 'nonzero' 时 taskkill 打桩为非零退出且不杀 victim
// （树杀失败形态：child close 永不来，调用方必须限时返回而非 pending）。
const cpShimPlugin = {
  name: 'cp-shim',
  setup(builder) {
    builder.onResolve({ filter: /^node:child_process$/ }, (args) => ({ path: 'cp-shim', namespace: 'cp-shim' }))
    builder.onLoad({ filter: /.*/, namespace: 'cp-shim' }, () => ({ loader: 'js', contents: `
      const real = require('child_process')
      const { EventEmitter } = require('events')
      const calls = { spawn: [] }
      globalThis.__cpShim = calls
      const fakes = new Map()
      const isWorktreeAdd = (file, args) => file === 'git' && args[0] === '-C' && args.includes('worktree') && args.includes('add')
      // posix 进程组击杀走 process.kill(-pid)，包一层让假子进程也能「被杀」；真实 pid 原样透传
      const realKill = process.kill.bind(process)
      process.kill = (pid, sig) => {
        const fake = fakes.get(Number(pid))
        if (fake) { fakes.delete(Number(pid)); if (!fake.__closed) { fake.__closed = true; setTimeout(() => fake.emit('close', null, 'SIGKILL'), 10) } return 0 }
        return realKill(pid, sig)
      }
      const shimSpawn = (file, args, opts) => {
        if (file === 'taskkill') {
          calls.spawn.push([file, args])
          const killer = new EventEmitter()
          killer.pid = 999_999
          setImmediate(() => {
            if (globalThis.__cpShimTaskkill !== 'nonzero') {
              const victim = fakes.get(Number(args[1]))
              if (victim) {
                fakes.delete(Number(args[1]))
                if (!victim.__closed) { victim.__closed = true; setTimeout(() => victim.emit('close', null, 'SIGTERM'), 10) }
              }
            }
            // 非零退出也算通道完成；nonzero 模式 victim 不死（close 永不来）
            killer.emit('close', globalThis.__cpShimTaskkill === 'nonzero' ? 128 : 0)
          })
          return killer
        }
        if (isWorktreeAdd(file, args)) {
          if (globalThis.__cpShimCheckoutOnAdd) {
            real.execFileSync(file, args, { stdio: 'ignore' })
            globalThis.__cpShimAfterAdd?.()
          }
          const slow = new EventEmitter()
          slow.pid = 4242
          slow.stdout = new EventEmitter()
          slow.stderr = new EventEmitter()
          fakes.set(slow.pid, slow)
          return slow
        }
        return real.spawn(file, args, opts)
      }
      module.exports = { ...real, spawn: shimSpawn }
    ` }))
  }
}

const load = async (file, name, plugins = []) => {
  const outfile = path.join(temp, name + '.cjs')
  await build({ entryPoints: [path.join(root, file)], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18', plugins, external: plugins.length ? ['child_process', 'node:child_process'] : [], logLevel: 'silent' })
  return import(pathToFileURL(outfile).href)
}

const [git, gitShim, { TaskStore }] = await Promise.all([
  load('src/main/git.ts', 'git-clean'),
  load('src/main/git.ts', 'git-shim', [cpShimPlugin]),
  load('src/main/store.ts', 'store')
])

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const makeRepo = (name) => {
  const dir = path.join(temp, name, 'repo')
  fs.mkdirSync(dir, { recursive: true })
  const g = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true }).trim()
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 'smoke@example.com')
  g('config', 'user.name', 'AgentDeck Smoke')
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n')
  g('add', '.')
  g('commit', '-qm', 'base')
  return { dir, g }
}

try {
  // ---- ① 超时自适应：规模档位 + 真实计数（已跟踪+可回放未跟踪）+ 每仓 TTL 缓存 ----
  assert.equal(git.worktreeAddTimeoutFor(0), 60_000, '小仓/计数失败档位维持 60s 基线')
  assert.equal(git.worktreeAddTimeoutFor(9_999), 60_000, '不足 1 万文件不加档')
  assert.equal(git.worktreeAddTimeoutFor(10_000), 120_000, '每 1 万文件 +60s')
  assert.equal(git.worktreeAddTimeoutFor(80_000), 540_000, '8 万文件 ≈ 9 分钟（那台 Unity 机的实测体量）')
  assert.equal(git.worktreeAddTimeoutFor(10_000_000), 900_000, '上限封顶 15 分钟')
  assert.ok(git.WORKTREE_FILE_COUNT_TTL_MS > 0 && git.WORKTREE_FILE_COUNT_TTL_MS <= 15 * 60_000, '计数缓存 TTL 有界')

  const counted = makeRepo('counted')
  for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(counted.dir, `t${i}.txt`), 'x')
  counted.g('add', '.')
  counted.g('commit', '-qm', 'bulk')
  for (let i = 0; i < 7; i++) fs.writeFileSync(path.join(counted.dir, `u${i}.txt`), 'x')
  assert.equal(await git.estimateWorktreeFileCount(counted.dir), 13 + 7, 'ls-files 计数含已跟踪+未跟踪')

  git.clearWorktreeFileCountCache()
  const big = makeRepo('big')
  const bigResult = await git.createWorktree(big.dir, 'task_big_c1', 'main', 'task_big', undefined, { estimateFileCount: async () => 80_000 })
  assert.ok(bigResult, '大仓注入计数下照常建成（真实 add 远快于档位超时）')
  assert.equal(bigResult.addTimeoutMs, 540_000, 'createWorktree 大仓档位按规模放大')
  const cachedResult = await git.createWorktree(big.dir, 'task_big_c2', 'main', 'task_big', undefined, { estimateFileCount: async () => 0 })
  assert.equal(cachedResult.addTimeoutMs, 540_000, 'TTL 内复用每仓缓存计数（注入不同值也吃缓存）')
  git.clearWorktreeFileCountCache()
  const smallResult = await git.createWorktree(big.dir, 'task_big_c3', 'main', 'task_big', undefined, { estimateFileCount: async () => 0 })
  assert.equal(smallResult.addTimeoutMs, 60_000, '清缓存后小计数回到 60s 档')
  git.clearWorktreeFileCountCache()
  const tiny = makeRepo('tiny')
  const tinyResult = await git.createWorktree(tiny.dir, 'task_tiny_c1', 'main', 'task_tiny')
  assert.equal(tinyResult.addTimeoutMs, 60_000, '小仓真实计数维持 60s 档')
  console.log('  OK ① 超时自适应：档位/计数/TTL 缓存')

  // ---- ①b 计数归一：子目录调用与根调用同值同键（否则子目录低估 → 60s 基线撞大仓超时，
  //      低值还以根为键缓存 10 分钟，重派继续撞） ----
  const nested = makeRepo('nested')
  for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(nested.dir, `r${i}.txt`), 'x')
  fs.mkdirSync(path.join(nested.dir, 'deep'), { recursive: true })
  for (let i = 0; i < 12; i++) { fs.writeFileSync(path.join(nested.dir, 'deep', `d${i}.txt`), 'x') }
  nested.g('add', '.')
  nested.g('commit', '-qm', 'nested')
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(nested.dir, 'deep', `u${i}.txt`), 'x')
  const nestedRoot = nested.dir
  const nestedDeep = path.join(nested.dir, 'deep')
  assert.equal(await git.estimateWorktreeFileCount(nestedRoot), 23 + 5, '根调用计数 = 已跟踪 23（含夹具 base.txt）+ 未跟踪 5')
  assert.equal(await git.estimateWorktreeFileCount(nestedDeep), 28, '子目录调用归一到仓库根，与根调用同值（旧路径只数到 17）')
  git.clearWorktreeFileCountCache()
  const injectedKeys = []
  const subSeeded = await git.createWorktree(nestedDeep, 'task_nz_c1', 'main', 'task_nz', undefined, {
    estimateFileCount: async (key) => { injectedKeys.push(key); return 80_000 }
  })
  assert.equal(subSeeded.addTimeoutMs, 540_000, '子目录调用按整仓规模放大超时')
  assert.equal(subSeeded.fileCount, 80_000, '子目录调用带回归一后的整仓计数')
  assert.equal(injectedKeys.length, 1, '子目录调用注入估计器恰好一次')
  assert.equal(injectedKeys[0], path.resolve(nestedRoot), '缓存键 = 归一后的仓库根（非调用子目录）')
  let poisoned = false
  const rootCached = await git.createWorktree(nestedRoot, 'task_nz_c2', 'main', 'task_nz', undefined, {
    estimateFileCount: async () => { poisoned = true; return 0 }
  })
  assert.equal(poisoned, false, '根调用命中子目录调用播种的缓存（同键）')
  assert.equal(rootCached.addTimeoutMs, 540_000, '根调用复用整仓档位，不被子目录低值覆盖')
  git.clearWorktreeFileCountCache()
  console.log('  OK ①b 计数归一：子目录与根同值同键，低值缓存回退面消除')

  // ---- ② 既存树不接管：同名 worktree 与分支已存在时必须快拒绝且保持原样 ----
  const swallow = makeRepo('swallow')
  const wtPath = path.join(swallow.dir, '.agentdeck-worktrees', 'task_sw_c1')
  fs.mkdirSync(path.dirname(wtPath), { recursive: true })
  swallow.g('worktree', 'add', '-b', 'agentdeck/task_sw_c1', wtPath, 'main')
  let swallowError = ''
  const refused = await gitShim.createWorktree(swallow.dir, 'task_sw_c1', 'main', 'task_sw', (m) => { swallowError = m }, { addTimeoutMs: 400 })
  assert.equal(refused, null, '既存 worktree 不得被误认为本次超时残肢')
  assert.ok(/已存在/.test(swallowError), `失败原因说明既存资产冲突：${swallowError}`)
  assert.ok(fs.existsSync(wtPath), '拒绝接管后既存 worktree 目录保持不变')
  assert.equal(swallow.g('rev-parse', '--verify', 'agentdeck/task_sw_c1'), swallow.g('rev-parse', 'main'), '拒绝接管后既存分支保持原 tip')
  console.log('  OK ② 既存 worktree 与分支不被超时清理路径接管或删除')

  const newCheckout = makeRepo('new-checkout')
  const newCheckoutPath = path.join(newCheckout.dir, '.agentdeck-worktrees', 'task_new_c1')
  let timedOutError = ''
  globalThis.__cpShimCheckoutOnAdd = true
  try {
    const timedOut = await gitShim.createWorktree(newCheckout.dir, 'task_new_c1', 'main', 'task_new', (message) => { timedOutError = message }, { addTimeoutMs: 400 })
    assert.equal(timedOut, null, '本次 checkout 虽已就绪但 add 超时仍不得误报成功')
  } finally {
    globalThis.__cpShimCheckoutOnAdd = false
  }
  assert.match(timedOutError, /超时/, '本次 checkout 超时应明确报告失败')
  assert.match(timedOutError, /残肢已清理/, '全清时才报告残肢已清理')
  assert.ok(!fs.existsSync(newCheckoutPath), '本次失败的 worktree 目录被回收')
  assert.throws(() => newCheckout.g('rev-parse', '--verify', '--quiet', 'agentdeck/task_new_c1'), '本次失败创建的分支被回收')

  // ---- ③ 进程树击杀 ----
  // ③a win32 taskkill 命令构造（参数断言级）
  gitShim.clearWorktreeFileCountCache?.()
  const killArgs = makeRepo('killargs')
  const slow = await gitShim.runGit(killArgs.dir, ['worktree', 'add', '-b', 'agentdeck/slow', path.join(temp, 'never-created')], 250, undefined, true)
  assert.equal(slow.timedOut, true, '树杀通道超时带显式标记')
  const taskkill = globalThis.__cpShim.spawn.find(([file]) => file === 'taskkill')
  assert.ok(taskkill, '超时后发起 taskkill')
  assert.deepEqual(taskkill[1], ['/pid', '4242', '/T', '/F'], `taskkill 整树强杀参数：${JSON.stringify(taskkill?.[1])}`)
  console.log('  OK ③a taskkill /PID <pid> /T /F 命令构造正确')

  // ③b 真实孤儿对照：post-checkout 钩子 sleep+touch——旧路径（只杀父进程）标记必现，
  // 树杀路径（taskkill /T 连钩子子进程一起带走）标记绝不出现
  const orphan = makeRepo('orphan')
  orphan.g('branch', 'side')
  fs.writeFileSync(path.join(orphan.dir, 'second.txt'), '2\n')
  orphan.g('add', '.')
  orphan.g('commit', '-qm', 'second')
  const hookPath = path.join(orphan.dir, '.git', 'hooks', 'post-checkout')
  fs.writeFileSync(hookPath, '#!/bin/sh\nsleep 6\ntouch orphan-marker.txt\n')
  fs.chmodSync(hookPath, 0o755)
  const markerPath = path.join(orphan.dir, 'orphan-marker.txt')
  const control = await git.runGit(orphan.dir, ['checkout', 'side'], 1200)
  assert.equal(control.timedOut, true, 'execFile 路径超时也带 killed/SIGTERM 特征')
  await wait(8000)
  assert.ok(fs.existsSync(markerPath), '对照组：旧行为只杀 git 父进程，钩子孤儿确实存活（旧病可复现）')
  fs.rmSync(markerPath)
  const killed = await git.runGit(orphan.dir, ['checkout', 'main'], 1200, undefined, true)
  assert.equal(killed.timedOut, true, '树杀通道真实超时')
  await wait(8000)
  assert.ok(!fs.existsSync(markerPath), '树杀后钩子孤儿已清（标记未出现）——孤儿 checkout 持锁的根因就此封死')
  console.log('  OK ③b 真实进程树击杀：孤儿 hook 对照组复现旧病，树杀组无孤儿')

  // ③c 树杀失败不阻塞：taskkill 非零退出且 victim 不死（close 永不来）→ 命令限时返回不 pending
  //（旧路径只依赖 child close，树杀失败 = 整条派单链挂死在永不触发的 close 上）
  globalThis.__cpShimTaskkill = 'nonzero'
  gitShim.clearWorktreeFileCountCache?.()
  const sticky = makeRepo('sticky')
  const pendStart = Date.now()
  const pendRace = await Promise.race([
    gitShim.runGit(sticky.dir, ['worktree', 'add', '-b', 'agentdeck/sticky', path.join(temp, 'never-created-2')], 300, undefined, true),
    wait(8000).then(() => null)
  ])
  const pendElapsed = Date.now() - pendStart
  assert.ok(pendRace, `taskkill 非零退出且目标不死时命令限时返回（${pendElapsed}ms 内未 pending）`)
  assert.equal(pendRace.timedOut, true, '树杀失败路径仍带超时判败标记')
  assert.ok(pendElapsed < 8000, `返回有界（实际 ${pendElapsed}ms，deadline+宽限 ≈ 3.5s 内）`)
  globalThis.__cpShimTaskkill = ''
  console.log('  OK ③c 树杀失败不阻塞：taskkill 非零退出 → close/exit+deadline 收口，限时返回')

  // ---- ④ 回收原子性与可见：分支删除失败 → 重试一次 → 残留清单上报 → 时间线落盘；目录回收不回滚 ----
  const store = new TaskStore(path.join(temp, 'store-data'))
  const form2 = makeRepo('form2')
  const created2 = await git.createWorktree(form2.dir, 'task_f2_c1', 'main', 'task_f2')
  assert.ok(created2, '兜底形态夹具 worktree 建成')
  // 构造「目录已删 + .git/worktrees 注册 + 分支残留」形态：目录被外力（崩溃竞态）清掉
  fs.rmSync(created2.path, { recursive: true, force: true })
  const refLock = path.join(form2.dir, '.git', 'refs', 'heads', 'agentdeck', 'task_f2_c1.lock')
  fs.mkdirSync(path.dirname(refLock), { recursive: true })
  fs.writeFileSync(refLock, '')
  const partial = await git.reclaimWorktree(created2.path, { deleteBranch: true })
  assert.equal(partial.ok, false, '部分成功不再按成功上报')
  assert.equal(partial.status, 'retained', '部分成功状态 retained（分支残留待兜底）')
  assert.ok(partial.residue?.some((r) => r.includes('agentdeck/task_f2_c1')), `残留清单含分支名：${JSON.stringify(partial.residue)}`)
  assert.ok(!fs.existsSync(created2.path), '目录回收不回滚')
  assert.ok(form2.g('rev-parse', '--verify', '--quiet', 'agentdeck/task_f2_c1') !== '', '分支确实残留（锁住 refs 模拟删除失败）')

  // 生产链路：pruneWorktrees 把部分成功映射进 failed → noteWorktreeCleanupFailure 落时间线（含分支名）
  const sweepLocked = await git.pruneWorktrees(form2.dir, () => false, { maxAgeMs: 0, claimWorktree: () => ({ release() {} }) })
  assert.equal(sweepLocked.removed.length, 0, '分支删除仍失败时不假报成功')
  assert.equal(sweepLocked.failed.length, 1, '部分成功进 failed（触发时间线接线）')
  assert.ok(sweepLocked.failed[0].reason.includes('agentdeck/task_f2_c1'), `failed 原因含残留分支名：${sweepLocked.failed[0].reason}`)
  const owner = store.create({ title: 'owner', prompt: 'p', workdir: form2.dir, backend: 'fake', agentId: 'lead' })
  store.noteWorktreeCleanupFailure(form2.dir, { name: sweepLocked.failed[0].name, reason: sweepLocked.failed[0].reason, ownerTaskId: owner.id })
  const events = store.readEvents(owner.id).map((e) => e.text ?? '').join('\n')
  assert.ok(events.includes('task_f2_c1') && events.includes('agentdeck/task_f2_c1'), '时间线事件落盘含残留目录名与分支名')

  // 解锁后启动清扫兜底：目录已删 + 注册 prune + 分支删除一并收干净
  fs.rmSync(refLock)
  const sweep = await git.pruneWorktrees(form2.dir, () => false, { maxAgeMs: 0, claimWorktree: () => ({ release() {} }) })
  assert.ok(sweep.removed.includes('task_f2_c1'), '启动清扫兜底回收「目录已删+注册+分支残留」形态')
  assert.ok(!fs.existsSync(path.join(form2.dir, '.git', 'worktrees', 'task_f2_c1')), '注册残留已 prune')
  assert.throws(() => form2.g('rev-parse', '--verify', '--quiet', 'agentdeck/task_f2_c1'), '兜底后分支已删（重派不再 branch already exists）')
  console.log('  OK ④ 回收部分失败：重试+残留清单+时间线落盘，清扫兜底收干净')

  // ---- ④b 既存分支受 refs 锁时拒绝接管；不得删分支或将其误报为本次残留 ----
  const form3 = makeRepo('form3')
  form3.g('branch', 'agentdeck/task_g3_c1', 'main')
  const originalG3Sha = form3.g('rev-parse', 'agentdeck/task_g3_c1')
  const refLockG3 = path.join(form3.dir, '.git', 'refs', 'heads', 'agentdeck', 'task_g3_c1.lock')
  fs.mkdirSync(path.dirname(refLockG3), { recursive: true })
  fs.writeFileSync(refLockG3, '')
  let g3Error = ''
  let cleanupReported = false
  const g3Refused = await gitShim.createWorktree(form3.dir, 'task_g3_c1', 'main', 'owner-g3', (m) => { g3Error = m }, {
    addTimeoutMs: 400,
    onCleanupResidue: () => { cleanupReported = true }
  })
  assert.equal(g3Refused, null, '既存分支冲突必须拒绝')
  assert.ok(/已存在/.test(g3Error), `拒绝原因说明既存资产冲突：${g3Error}`)
  assert.equal(cleanupReported, false, '既存分支不作为本次残留上报')
  assert.equal(form3.g('rev-parse', 'agentdeck/task_g3_c1'), originalG3Sha, 'refs 锁下既存分支 tip 仍保持原样')
  fs.rmSync(refLockG3)
  assert.ok(await git.deleteBranch(form3.dir, 'agentdeck/task_g3_c1'), '解锁后夹具分支可正常删除')
  console.log('  OK ④b refs 锁下的既存分支不被拒单清理路径删除或重置')

  const timedOutPartialRepo = makeRepo('partial-timeout')
  const partialOwner = store.create({ title: 'partial-timeout', prompt: 'p', workdir: timedOutPartialRepo.dir, backend: 'fake', agentId: 'lead' })
  const partialBranch = 'agentdeck/task_partial_c1'
  const partialLock = path.join(timedOutPartialRepo.dir, '.git', 'refs', 'heads', 'agentdeck', 'task_partial_c1.lock')
  let partialError = ''
  globalThis.__cpShimCheckoutOnAdd = true
  globalThis.__cpShimAfterAdd = () => {
    fs.mkdirSync(path.dirname(partialLock), { recursive: true })
    fs.writeFileSync(partialLock, '')
  }
  try {
    const partialResult = await gitShim.createWorktree(timedOutPartialRepo.dir, 'task_partial_c1', 'main', partialOwner.id, (message) => { partialError = message }, {
      addTimeoutMs: 400,
      onCleanupResidue: (failure) => store.noteWorktreeCleanupFailure(timedOutPartialRepo.dir, failure)
    })
    assert.equal(partialResult, null, '部分清理仍须按超时拒单')
  } finally {
    globalThis.__cpShimCheckoutOnAdd = false
    globalThis.__cpShimAfterAdd = undefined
  }
  assert.match(partialError, /残肢未全清/, '清理有残留时不得谎报全清')
  assert.ok(partialError.includes(partialBranch), '拒单说明包括残留分支')
  assert.ok(store.readEvents(partialOwner.id).some((event) => event.text?.includes(partialBranch)), '清理残留记录进 owner 时间线')
  fs.rmSync(partialLock)
  assert.ok(await git.deleteBranch(timedOutPartialRepo.dir, partialBranch), '解锁后残留分支可清理')

  console.log('\nWORKTREE TIMEOUT SMOKE PASSED')
} finally {
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 })
}
