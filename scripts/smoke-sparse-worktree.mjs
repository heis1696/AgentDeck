// 稀疏检出第一批（协议 + 建树 + 回落，最小闭环）冒烟：docs/WORKTREE-BIG-REPO-PERF.md §6.1-§6.4/§7.3
// ① 协议解析：sparse 属性逗号分隔、/ 与 \ 归一、空值=未声明、通配符/越界段=invalid、缺省零变化
// ② 建树三步：合法范围 → worktree add --no-checkout → sparse-checkout set --cone → checkout，
//    工作树只物化声明目录（cone 模式根文件恒在）；代际/元数据/分支照常
// ③ 回落全量：目录在基线中不存在（cone 对不存在目录静默接受，必须自查）→ 整单回落全量，
//    结果 sparse.status='fallback' 附原因（含被拒目录），绝不拒单、树全量物化
// ④ 缺省零变化：不带 sparseDirs 的建树结果无 sparse 字段、全量物化、池化行为原样
// ⑤ 池化范围矩阵（二期）：范围在案的稀疏树照常入池（元数据记录范围）；范围未知不入池
//    （一期护栏兜底）；同范围秒级 switch -c 换基线复用；异范围重设 sparse+增量物化；
//    稀疏↔全量双向永不混用；复用失败（index.lock 卡死换基线）逐出回落全量稀疏建树；
//    ⑤g 逐出不丢成果——旧单有独有提交经逐出后成果分支保留、集成照常取得全部成果
// ⑥ runner 端到端：派单 sparse 属性 → 时间线注记可见（生效/回落含被拒目录/格式非法含通配符），
//    四单全部建成（不拒单），子单工作树物化范围与声明一致，范围外成果进集成分支（P0）
// ⑦ 回放并集（§6.3 关键点，第二批）：稀疏范围外有未提交改动也被回放——增量触达目录补进
//    cone 后 cherry-pick，范围外改动在工作树真实物化、子分支推进到回放提交、status 自洽；
//    无关目录照常不物化；全量树（未带范围）回放行为零变化
// ⑧ commitAll 稀疏全收（P0）：队员写出 scope 外文件 + 范围内改动，commitAllDetailed 一并
//    提交（旧代码 add -A 在稀疏树整批 exit 1 拒收=成果全丢且调用方无视返回值）；cone 不扩
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-sparse-worktree-'))
const load = async (file, name) => {
  const outfile = path.join(temp, name + '.cjs')
  await build({ entryPoints: [path.join(root, file)], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['electron'], logLevel: 'silent' })
  return import(pathToFileURL(outfile).href)
}
const [git, delegate, { TaskRunner }, { TaskStore }] = await Promise.all([
  load('src/main/git.ts', 'git'),
  load('src/main/delegate.ts', 'delegate'),
  load('src/main/runner.ts', 'runner'),
  load('src/main/store.ts', 'store')
])
const { parseSparseAttr, parseDelegates } = delegate
const { createWorktree, reclaimWorktree, clearWorktreePool, clearWorktreeFileCountCache, worktreePoolEntriesForTest, replayLeaderBaseline, commitAllDetailed, branchExists, mergeBranchInto } = git

const makeRepo = (name) => {
  const dir = path.join(temp, name, 'repo')
  for (const sub of ['client/Assets/GameMain', 'excel-tool', 'docs', 'server']) fs.mkdirSync(path.join(dir, sub), { recursive: true })
  fs.writeFileSync(path.join(dir, 'root.txt'), 'root\n')
  fs.writeFileSync(path.join(dir, 'client/Assets/GameMain/a.txt'), 'a\n')
  fs.writeFileSync(path.join(dir, 'excel-tool/b.txt'), 'b\n')
  fs.writeFileSync(path.join(dir, 'docs/d.txt'), 'd\n')
  fs.writeFileSync(path.join(dir, 'server/s.txt'), 's\n')
  const g = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true }).trim()
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 'smoke@example.com')
  g('config', 'user.name', 'AgentDeck Smoke')
  g('add', '.')
  g('commit', '-qm', 'base')
  return { dir, g }
}

/** 工作树物化清单（排除 .git 指针文件）：目录带尾 /，排序后整树对照 */
const listTree = (wtPath) => {
  const out = []
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(wtPath, rel), { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const child = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) { out.push(`${child}/`); walk(child) } else out.push(child)
    }
  }
  walk('')
  return out.sort()
}
const hasAll = (list, wanted) => wanted.every((item) => list.includes(item))
const hasNone = (list, banned) => banned.every((item) => !list.includes(item))
const FULL_TREE = ['client/', 'client/Assets/', 'client/Assets/GameMain/', 'client/Assets/GameMain/a.txt', 'excel-tool/', 'excel-tool/b.txt', 'docs/', 'docs/d.txt', 'server/', 'server/s.txt', 'root.txt']

try {
  // ---- ① 协议解析：parseSparseAttr + parseDelegates ----
  assert.deepEqual(parseSparseAttr(undefined), { kind: 'undeclared' }, '缺省属性 = 未声明（全量零变化）')
  assert.deepEqual(parseSparseAttr(''), { kind: 'undeclared' }, '空值 = 未声明')
  assert.deepEqual(parseSparseAttr('   '), { kind: 'undeclared' }, '全空白 = 未声明')
  assert.deepEqual(parseSparseAttr(','), { kind: 'undeclared' }, '纯逗号 = 未声明')
  assert.deepEqual(parseSparseAttr('.'), { kind: 'undeclared' }, '根目录点号归一后为空 = 未声明（语义即全量）')
  assert.deepEqual(parseSparseAttr('client\\Assets\\GameMain, excel-tool/'), { kind: 'dirs', dirs: ['client/Assets/GameMain', 'excel-tool'] }, '反斜杠归一为 /、空白修剪、尾斜杠剥离')
  assert.deepEqual(parseSparseAttr('./client, /server'), { kind: 'dirs', dirs: ['client', 'server'] }, '剥 ./ 前缀与首部 /')
  assert.deepEqual(parseSparseAttr('a,a,b'), { kind: 'dirs', dirs: ['a', 'b'] }, '重复目录去重保序')
  assert.equal(parseSparseAttr('assets/*.png').kind, 'invalid', '通配符 * 判非法')
  assert.equal(parseSparseAttr('src/[abc]').kind, 'invalid', '通配符 [] 判非法')
  assert.ok(parseSparseAttr('a?b').reason.includes('通配符'), 'invalid 文案点名通配符（供时间线注记）')
  assert.equal(parseSparseAttr('../escape').kind, 'invalid', '越界 .. 段判非法')
  assert.deepEqual(parseDelegates('<delegate to="X" sparse="client,excel-tool">指令</delegate>')[0].sparse, 'client,excel-tool', 'parseDelegates 带出 sparse 原始值')
  assert.equal(parseDelegates('<delegate to="X">指令</delegate>')[0].sparse, undefined, '缺省 sparse 属性不产生字段（零变化）')
  assert.equal(parseDelegates('<delegate to="X" sparse="">指令</delegate>')[0].sparse, '', '空值保真带出，由 parseSparseAttr 判未声明')
  assert.equal(parseDelegates('<delegate sparse="client" reason="r" to=X>指令</delegate>')[0].sparse, 'client', '属性顺序任意')
  console.log('  OK ① 协议解析：归一/去重/空值未声明/通配符与越界非法/缺省零变化')

  // ---- ② 建树三步：合法稀疏范围 ----
  const applied = makeRepo('applied')
  const sparseWt = await createWorktree(applied.dir, 'task_sparse_c1', 'main', 'task_sparse', undefined, { sparseDirs: ['client/Assets/GameMain', 'excel-tool'] })
  assert.ok(sparseWt, '合法稀疏范围建成 worktree（不拒单）')
  assert.equal(sparseWt.sparse?.status, 'applied', '结果观测面 sparse.status=applied')
  assert.deepEqual(sparseWt.sparse?.dirs, ['client/Assets/GameMain', 'excel-tool'], '结果带回生效目录')
  const sparseList = listTree(sparseWt.path)
  assert.ok(hasAll(sparseList, ['client/', 'client/Assets/', 'client/Assets/GameMain/', 'client/Assets/GameMain/a.txt', 'excel-tool/', 'excel-tool/b.txt', 'root.txt']), `声明目录物化（cone 根文件恒在）：${JSON.stringify(sparseList)}`)
  assert.ok(hasNone(sparseList, ['docs/', 'docs/d.txt', 'server/', 'server/s.txt']), '未声明目录不物化')
  assert.equal(applied.g('-C', sparseWt.path, 'status', '--porcelain'), '', '稀疏树 status 自洽')
  assert.equal(applied.g('-C', sparseWt.path, 'config', '--bool', 'core.sparseCheckout'), 'true', '稀疏配置按 worktree 生效')
  assert.equal(sparseWt.branch, 'agentdeck/task_sparse_c1', '托管分支照常建立')
  assert.ok(fs.existsSync(path.join(applied.dir, '.agentdeck-worktrees', '.metadata', 'task_sparse_c1.json')), '归属元数据照常落盘')
  console.log('  OK ② 建树三步：cone 范围生效，工作树只物化声明目录（+根文件），登记链路原样')

  // ---- ③ 回落全量：目录不存在（含混合合法目录）----
  const fallback = makeRepo('fallback')
  const fallbackWt = await createWorktree(fallback.dir, 'task_fall_c1', 'main', 'task_fall', undefined, { sparseDirs: ['client/Assets/GameMain', 'no-such-dir'] })
  assert.ok(fallbackWt, '含不存在目录的整单回落全量建树（绝不拒单）')
  assert.equal(fallbackWt.sparse?.status, 'fallback', '结果观测面 sparse.status=fallback')
  assert.ok(fallbackWt.sparse?.reason?.includes('no-such-dir'), `回落原因含被拒目录：${fallbackWt.sparse?.reason}`)
  assert.ok(hasAll(listTree(fallbackWt.path), FULL_TREE), `回落全量后整树物化：${JSON.stringify(listTree(fallbackWt.path))}`)
  assert.equal(fallback.g('-C', fallbackWt.path, 'status', '--porcelain'), '', '回落树 status 自洽')
  // 通配符在协议层就被 parseSparseAttr 拦下（runner 注记回落，见 ⑥），到不了建树层；
  // 此处对照：指向文件的路径同样按「不是目录」拒并回落
  const blobWt = await createWorktree(fallback.dir, 'task_fall_c2', 'main', 'task_fall', undefined, { sparseDirs: ['root.txt'] })
  assert.equal(blobWt.sparse?.status, 'fallback', '目录指向文件同样回落全量')
  assert.ok(blobWt.sparse?.reason?.includes('root.txt'), '回落原因含被拒路径')
  console.log('  OK ③ 回落全量：不存在目录/指向文件 → 整单回落 + 原因可见（含被拒目录），不拒单')

  // ---- ④ 缺省零变化：不带 sparseDirs ----
  const plain = makeRepo('plain')
  const plainWt = await createWorktree(plain.dir, 'task_plain_c1', 'main', 'task_plain')
  assert.ok(plainWt && plainWt.sparse === undefined, '缺省建树结果无 sparse 字段（行为与今天完全一致）')
  assert.ok(hasAll(listTree(plainWt.path), FULL_TREE), '缺省建树全量物化')
  console.log('  OK ④ 缺省零变化：无 sparse 字段、全量物化')

  // ---- ⑤ 池化范围矩阵（二期）----
  // ⑤a 范围在案的稀疏树照常入池：元数据记录生效范围（复用侧匹配的唯一依据）
  const sparseOwner = makeRepo('pool-sparse-owner')
  const sparseTree = await createWorktree(sparseOwner.dir, 'task_pools_c1', 'main', 'pool_owner_a', undefined, { sparseDirs: ['client/Assets/GameMain'] })
  assert.equal(sparseTree.sparse?.status, 'applied', '⑤a 前置：稀疏树建成')
  const sparseRelease = await reclaimWorktree(sparseTree.path, { repool: true, expectedOwnerTaskId: 'pool_owner_a' })
  assert.equal(sparseRelease.status, 'pooled', '稀疏树（范围在案）照常入池（二期）')
  assert.deepEqual(worktreePoolEntriesForTest(sparseOwner.dir), [sparseTree.path], '池内恰一条稀疏条目')
  const pooledSparseMeta = JSON.parse(fs.readFileSync(path.join(sparseOwner.dir, '.agentdeck-worktrees', '.metadata', 'task_pools_c1.json'), 'utf8'))
  assert.deepEqual(pooledSparseMeta.sparseDirs, ['client/Assets/GameMain'], '池条目元数据记录稀疏范围')
  // ⑤a2 范围未知的稀疏树拒绝入池（一期护栏保留为兜底）：剥掉元数据 sparseDirs 再归还。
  // 独立仓库夹具——同仓第二棵树会命中池的异范围复用（正是 ⑤e 的语义），不构成本案
  const unknownOwner = makeRepo('pool-unknown')
  const unknownTree = await createWorktree(unknownOwner.dir, 'task_pools_u1', 'main', 'pool_owner_u', undefined, { sparseDirs: ['excel-tool'] })
  assert.equal(unknownTree.sparse?.status, 'applied', '⑤a2 前置：稀疏树建成')
  const unknownMetaFile = path.join(unknownOwner.dir, '.agentdeck-worktrees', '.metadata', 'task_pools_u1.json')
  const unknownMeta = JSON.parse(fs.readFileSync(unknownMetaFile, 'utf8'))
  delete unknownMeta.sparseDirs
  fs.writeFileSync(unknownMetaFile, JSON.stringify(unknownMeta))
  const unknownRelease = await reclaimWorktree(unknownTree.path, { repool: true, expectedOwnerTaskId: 'pool_owner_u' })
  assert.notEqual(unknownRelease.status, 'pooled', '范围未知的稀疏树拒绝入池（一期护栏兜底）')
  assert.ok(!fs.existsSync(unknownTree.path), '范围未知的稀疏树按常规回收移除')
  assert.deepEqual(worktreePoolEntriesForTest(sparseOwner.dir), [sparseTree.path], '护栏兜底不影响他仓池容量')
  // ⑤d 同范围秒级复用：基线推进后同范围派单 → 取池换基线，cone 原样生效、新基线文件物化
  fs.writeFileSync(path.join(sparseOwner.dir, 'client', 'Assets', 'GameMain', 'new-base.txt'), 'advanced baseline\n')
  sparseOwner.g('add', '.')
  sparseOwner.g('commit', '-qm', 'advance baseline')
  const advancedSha = sparseOwner.g('rev-parse', 'main')
  const reusedSparse = await createWorktree(sparseOwner.dir, 'task_pools_c2', 'main', 'pool_owner_b2', undefined, { sparseDirs: ['client/Assets/GameMain'] })
  assert.equal(reusedSparse.pooled, true, '同范围稀疏派单取池复用（秒级换基线）')
  assert.equal(reusedSparse.path, sparseTree.path, '复用同一目录')
  assert.equal(reusedSparse.metadata.baseSha, advancedSha, '复用换到新基线')
  assert.equal(reusedSparse.sparse?.status, 'applied', '复用结果带 applied 观测面')
  assert.deepEqual(reusedSparse.metadata.sparseDirs, ['client/Assets/GameMain'], '复用元数据记录生效范围')
  const reuseList = listTree(reusedSparse.path)
  assert.ok(hasAll(reuseList, ['client/', 'client/Assets/', 'client/Assets/GameMain/', 'client/Assets/GameMain/a.txt', 'client/Assets/GameMain/new-base.txt', 'root.txt']), `同范围复用按新基线物化：${JSON.stringify(reuseList)}`)
  assert.ok(hasNone(reuseList, ['docs/', 'server/', 'excel-tool/']), '复用不扩 cone')
  assert.equal(sparseOwner.g('-C', reusedSparse.path, 'status', '--porcelain'), '', '复用后 status 自洽')
  // ⑤e 异范围重设：归还后换范围派单 → cone 重设 + 增量物化（新范围进、旧范围退）
  const reRelease = await reclaimWorktree(reusedSparse.path, { repool: true, expectedOwnerTaskId: 'pool_owner_b2' })
  assert.equal(reRelease.status, 'pooled', '⑤e 前置：复用树再次入池')
  const switchedRange = await createWorktree(sparseOwner.dir, 'task_pools_c3', 'main', 'pool_owner_c3', undefined, { sparseDirs: ['docs', 'excel-tool'] })
  assert.equal(switchedRange.pooled, true, '异范围稀疏派单取池复用（重设+增量物化）')
  assert.equal(switchedRange.path, sparseTree.path, '仍是同一棵树')
  assert.deepEqual(switchedRange.sparse?.dirs, ['docs', 'excel-tool'], '结果观测面带新范围')
  const switchList = listTree(switchedRange.path)
  assert.ok(hasAll(switchList, ['docs/', 'docs/d.txt', 'excel-tool/', 'excel-tool/b.txt', 'root.txt']), `异范围重设物化新范围：${JSON.stringify(switchList)}`)
  assert.ok(hasNone(switchList, ['client/', 'server/']), '旧范围目录已随重设退场')
  assert.equal(sparseOwner.g('-C', switchedRange.path, 'status', '--porcelain'), '', '重设后 status 自洽')
  clearWorktreePool()
  console.log('  OK ⑤a/a2/d/e 池化范围矩阵：范围在案入池+范围未知兜底+同范围秒级复用+异范围重设增量物化')
  // ⑤b 复用侧逐出：池条目带稀疏配置但范围未知（外部遗留/异常路径入池形态）→ 复用时逐出，
  //    回落全量 add——一期护栏保留为兜底
  const legacyOwner = makeRepo('pool-legacy')
  const pooledFull = await createWorktree(legacyOwner.dir, 'task_pool_c1', 'main', 'pool_owner_b')
  const repooled = await reclaimWorktree(pooledFull.path, { repool: true, expectedOwnerTaskId: 'pool_owner_b' })
  assert.equal(repooled.status, 'pooled', '⑤b 前置：全量树照常入池')
  legacyOwner.g('-C', pooledFull.path, 'sparse-checkout', 'set', '--cone', '--', 'client')
  const afterLegacy = await createWorktree(legacyOwner.dir, 'task_pool_c2', 'main', 'pool_owner_c')
  assert.ok(afterLegacy && afterLegacy.pooled !== true, '带稀疏配置但范围未知的池条目不被复用（回落全量 add 新树）')
  assert.notEqual(afterLegacy.path, pooledFull.path, '复用走的是全新目录')
  assert.deepEqual(worktreePoolEntriesForTest(legacyOwner.dir), [], '稀疏池条目已逐出')
  assert.ok(!fs.existsSync(pooledFull.path), '逐出条目按归属回收')
  assert.ok(hasAll(listTree(afterLegacy.path), FULL_TREE), '新树全量物化（不带错误范围）')
  // ⑤c 稀疏↔全量双向隔离（永不混用）
  // ⑤c1 稀疏派单不取全量条目
  const skipOwner = makeRepo('pool-skip')
  const poolable = await createWorktree(skipOwner.dir, 'task_skip_c1', 'main', 'pool_owner_d')
  await reclaimWorktree(poolable.path, { repool: true, expectedOwnerTaskId: 'pool_owner_d' })
  assert.equal(worktreePoolEntriesForTest(skipOwner.dir).length, 1, '⑤c1 前置：池内有一条空闲全量树')
  const sparseSkip = await createWorktree(skipOwner.dir, 'task_skip_c2', 'main', 'pool_owner_e', undefined, { sparseDirs: ['excel-tool'] })
  assert.ok(sparseSkip && sparseSkip.pooled !== true, '稀疏派单不取全量条目（宁建新树）')
  assert.equal(sparseSkip.sparse?.status, 'applied', '稀疏新树范围生效')
  assert.ok(hasNone(listTree(sparseSkip.path), ['docs/', 'server/']), '新树按声明范围物化')
  // ⑤c2 全量派单不取稀疏条目（范围在案也逐出——绝不把部分物化的树当全量交出去）
  const isoOwner = makeRepo('pool-iso')
  const isoSparse = await createWorktree(isoOwner.dir, 'task_iso_c1', 'main', 'iso_owner_a', undefined, { sparseDirs: ['client/Assets/GameMain'] })
  await reclaimWorktree(isoSparse.path, { repool: true, expectedOwnerTaskId: 'iso_owner_a' })
  assert.equal(worktreePoolEntriesForTest(isoOwner.dir).length, 1, '⑤c2 前置：池内一条稀疏条目（范围在案）')
  const fullTake = await createWorktree(isoOwner.dir, 'task_iso_c2', 'main', 'iso_owner_b')
  assert.ok(fullTake && fullTake.pooled !== true, '全量派单不取稀疏条目（逐出回落全量 add）')
  assert.notEqual(fullTake.path, isoSparse.path, '全量新树走全新目录')
  assert.deepEqual(worktreePoolEntriesForTest(isoOwner.dir), [], '稀疏条目已逐出')
  assert.ok(!fs.existsSync(isoSparse.path), '逐出条目按归属回收')
  assert.ok(hasAll(listTree(fullTake.path), FULL_TREE), '全量新树整树物化')
  console.log('  OK ⑤b/c 池化隔离：范围未知逐出兜底 + 稀疏↔全量双向不混用')
  // ⑤f 复用失败回落全量建树（正确性地板）：index.lock 卡死换基线 → 逐出回落新建稀疏树
  const failOwner = makeRepo('pool-fail')
  const failSparse = await createWorktree(failOwner.dir, 'task_pf_c1', 'main', 'pf_owner_a', undefined, { sparseDirs: ['client/Assets/GameMain'] })
  await reclaimWorktree(failSparse.path, { repool: true, expectedOwnerTaskId: 'pf_owner_a' })
  assert.equal(worktreePoolEntriesForTest(failOwner.dir).length, 1, '⑤f 前置：稀疏条目入池')
  const failPointer = fs.readFileSync(path.join(failSparse.path, '.git'), 'utf8')
  const failGitdir = path.resolve(failSparse.path, /^gitdir:\s*(.+?)\s*$/im.exec(failPointer)[1])
  fs.writeFileSync(path.join(failGitdir, 'index.lock'), '')
  const failReuse = await createWorktree(failOwner.dir, 'task_pf_c2', 'main', 'pf_owner_b', undefined, { sparseDirs: ['client/Assets/GameMain'] })
  assert.ok(failReuse && failReuse.pooled !== true, '复用失败回落全量稀疏建树（不走坏条目）')
  assert.notEqual(failReuse.path, failSparse.path, '回落走全新目录')
  assert.equal(failReuse.sparse?.status, 'applied', '回落新树范围照常生效')
  assert.ok(hasAll(listTree(failReuse.path), ['client/', 'client/Assets/', 'client/Assets/GameMain/', 'client/Assets/GameMain/a.txt', 'root.txt']), '回落新树按声明范围物化')
  assert.ok(hasNone(listTree(failReuse.path), ['docs/', 'server/']), '回落新树不物化范围外目录')
  assert.deepEqual(worktreePoolEntriesForTest(failOwner.dir), [], '失败条目已逐出（不占容量）')
  clearWorktreePool()
  clearWorktreeFileCountCache()
  console.log('  OK ⑤f 复用失败回落：正确性地板不变（全量稀疏建树照常生效）')
  // ⑤g 逐出不丢成果（丢工作根治）：旧单有独有提交 → 异类型派单触发逐出 → 旧单集成
  // 仍取得全部成果。逐出（稀疏×全量互斥/复用失败等全部 evict 调用点）只回收目录与
  // 注册，绝不删池条目 sidecar 挂着的旧成果分支——旧子单终态已归池、分支待集成；
  // 托管分支随 tasks:delete 回收契约兜底
  const nolossOwner = makeRepo('pool-noloss')
  const oldTree = await createWorktree(nolossOwner.dir, 'task_nl_c1', 'main', 'nl_owner_a', undefined, { sparseDirs: ['client/Assets/GameMain'] })
  assert.equal(oldTree.sparse?.status, 'applied', '⑤g 前置：旧单稀疏树建成')
  fs.mkdirSync(path.join(oldTree.path, 'client', 'Assets', 'GameMain'), { recursive: true })
  fs.writeFileSync(path.join(oldTree.path, 'client', 'Assets', 'GameMain', 'old-result.txt'), '旧单独有成果\n')
  const oldLanded = await commitAllDetailed(oldTree.path, 'agentdeck: 旧单成果')
  assert.equal(oldLanded.committed, true, '⑤g 前置：旧单成果落盘（分支独有提交）')
  const oldBranch = oldTree.branch
  const oldTip = nolossOwner.g('rev-parse', oldBranch)
  const repooledOld = await reclaimWorktree(oldTree.path, { repool: true, expectedOwnerTaskId: 'nl_owner_a' })
  assert.equal(repooledOld.status, 'pooled', '⑤g 前置：旧单树带成果分支入池（终态归池、成果待集成）')
  const evictor = await createWorktree(nolossOwner.dir, 'task_nl_c2', 'main', 'nl_owner_b')
  assert.ok(evictor && evictor.pooled !== true, '⑤g：异类型派单（全量）不取稀疏条目——触发逐出回落全量建树')
  assert.notEqual(evictor.path, oldTree.path, '⑤g：逐出走全新目录')
  assert.ok(!fs.existsSync(oldTree.path), '⑤g：逐出条目目录照常回收')
  assert.deepEqual(worktreePoolEntriesForTest(nolossOwner.dir), [], '⑤g：池条目已出池（不占容量）')
  assert.equal(await branchExists(nolossOwner.dir, oldBranch), true, '⑤g：逐出后旧成果分支保留（逐出绝不 deleteBranch）')
  assert.equal(nolossOwner.g('rev-parse', oldBranch), oldTip, '⑤g：旧分支 tip 不动（独有提交一个不少）')
  const nolossMerged = await mergeBranchInto(nolossOwner.dir, 'agentdeck/task-nl-integ', oldBranch)
  assert.equal(nolossMerged.ok, true, `⑤g：旧成果分支照常合入集成分支（${nolossMerged.message}）`)
  assert.equal(nolossOwner.g('show', 'agentdeck/task-nl-integ:client/Assets/GameMain/old-result.txt'), '旧单独有成果', '⑤g：旧单集成仍取得全部成果')
  clearWorktreePool()
  clearWorktreeFileCountCache()
  console.log('  OK ⑤g 逐出不丢成果：旧单独有提交经逐出后分支保留、集成照常取得全部成果')

  // ---- ⑥ runner 端到端：注记可见 + 不拒单 + 子单范围正确 ----
  // 集成完成后子树会被回收，物化范围断言必须在树存活窗口内做：worker 收工受测试闸控制，
  // 四棵树全部建成并核验完才放行收工，之后再看领队 done
  const e2e = makeRepo('e2e')
  const team = [
    { id: 'L1', name: 'Boss', backend: 'zcode', role: '领队', systemPrompt: '', subordinates: ['W1', 'W2', 'W3', 'W4'] },
    { id: 'W1', name: 'Alpha', backend: 'alpha', role: '工程师', systemPrompt: '' },
    { id: 'W2', name: 'Beta', backend: 'beta', role: '工程师', systemPrompt: '' },
    { id: 'W3', name: 'Gamma', backend: 'gamma', role: '工程师', systemPrompt: '' },
    { id: 'W4', name: 'Delta', backend: 'delta', role: '工程师', systemPrompt: '' }
  ]
  let releaseWorkers
  const workersGate = new Promise((resolve) => { releaseWorkers = resolve })
  const makeWorkerBackend = (tag) => ({
    id: tag.toLowerCase(),
    label: tag,
    async probe() { return { ok: true, detail: '' } },
    async start({ workdir, events }) {
      setTimeout(async () => {
        // Alpha 写声明范围内的文件 + 一个 scope 外文件（P0 案形：cone 外目录不物化，队员
        // 自建目录直写——旧代码 commitAll 的 add -A 在稀疏树整批拒收，成果全丢）；
        // 其余写根文件（cone 模式根文件恒物化，全量树自不待言）
        try {
          if (tag === 'Alpha') {
            fs.writeFileSync(path.join(workdir, 'client', 'Assets', 'GameMain', 'alpha.txt'), `by ${tag}\n`)
            fs.mkdirSync(path.join(workdir, 'client', 'Assets', 'Art'), { recursive: true })
            fs.writeFileSync(path.join(workdir, 'client', 'Assets', 'Art', 'rogue.txt'), `out-of-scope by ${tag}\n`)
          } else fs.writeFileSync(path.join(workdir, `${tag.toLowerCase()}.txt`), `by ${tag}\n`)
        } catch { /* 写失败也回话：断言面看工作树物化与时间线注记 */ }
        await workersGate
        const response = `done ${tag}`
        events.onEvent({ ts: Date.now(), kind: 'final', text: response })
        events.onTurnEnd({ response, ok: true })
      }, 30)
      return { sessionId: `sess_${tag}`, async send() {}, async stop() {}, async close() {} }
    }
  })
  const leaderBackend = {
    id: 'zcode',
    label: 'ZetCode',
    async probe() { return { ok: true, detail: '' } },
    async start({ events }) {
      const text = [
        '拆四单：',
        '<delegate to="Alpha" sparse="client/Assets/GameMain,excel-tool">在声明范围内补 alpha.txt</delegate>',
        '<delegate to="Beta" sparse="assets/*.png">处理贴图清单</delegate>',
        '<delegate to="Gamma" sparse="client/Assets/GameMain,no-such-dir">补 gamma 场景说明</delegate>',
        '<delegate to="Delta">写 delta.txt 记录环境</delegate>'
      ].join('\n')
      setTimeout(() => {
        events.onEvent({ ts: Date.now(), kind: 'final', text })
        events.onTurnEnd({ response: '已派四单。', delegationText: text, ok: true })
      }, 20)
      return {
        sessionId: 'sess_lead',
        async send(content) {
          setTimeout(() => {
            const text = String(content).includes('结果汇报') ? '四单都完成了。任务结束。' : '继续等待'
            events.onEvent({ ts: Date.now(), kind: 'final', text })
            events.onTurnEnd({ response: text, ok: true })
          }, 20)
        },
        async stop() {}, async close() {}
      }
    }
  }
  const store = new TaskStore(path.join(temp, 'store-data'))
  const backends = new Map([
    ['zcode', leaderBackend],
    ['alpha', makeWorkerBackend('Alpha')],
    ['beta', makeWorkerBackend('Beta')],
    ['gamma', makeWorkerBackend('Gamma')],
    ['delta', makeWorkerBackend('Delta')]
  ])
  const runner = new TaskRunner(store, backends, () => ({ concurrency: 1, mode: 'yolo', notify: false, workerConcurrency: 4 }))
  runner.attachTeam(() => team)
  const leader = store.create({ title: '稀疏派单', prompt: '拆四单验证稀疏检出', workdir: e2e.dir, backend: 'zcode', agentId: 'L1' })
  runner.enqueue(leader)
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  let children = []
  const tTrees = Date.now()
  while (Date.now() - tTrees < 30000) {
    children = store.list().filter((c) => c.parentTaskId === leader.id)
    if (children.length === 4 && children.every((c) => c.worktree?.path && fs.existsSync(c.worktree.path))) break
    await wait(100)
  }
  assert.equal(children.length, 4, `四单全部建成（不拒单，实际 ${children.length}）`)
  assert.ok(children.every((c) => c.worktree?.path && fs.existsSync(c.worktree.path)), '四棵子树全部就位')
  const byBackend = Object.fromEntries(children.map((c) => [c.backend, c]))
  const alphaList = listTree(byBackend.alpha.workdir)
  assert.ok(hasAll(alphaList, ['client/', 'client/Assets/GameMain/', 'client/Assets/GameMain/a.txt', 'client/Assets/GameMain/alpha.txt', 'excel-tool/']), `Alpha 树物化声明范围：${JSON.stringify(alphaList)}`)
  assert.ok(hasNone(alphaList, ['docs/', 'server/']), 'Alpha 树未声明目录不物化')
  for (const tag of ['beta', 'gamma', 'delta']) {
    const list = listTree(byBackend[tag].workdir)
    assert.ok(hasAll(list, FULL_TREE), `${tag} 树全量物化（回落或全量）：${JSON.stringify(list.slice(0, 6))}…`)
  }
  const timeline = store.readEvents(leader.id).map((e) => e.text ?? '').join('\n')
  assert.ok(timeline.includes('稀疏检出生效') && timeline.includes('client/Assets/GameMain') && timeline.includes('excel-tool'), '生效注记可见（含声明目录）')
  assert.ok(timeline.includes('回落全量') && timeline.includes('no-such-dir'), `回落注记可见且含被拒目录`)
  assert.ok(timeline.includes('sparse 属性格式非法') && timeline.includes('通配符'), '格式非法注记可见（通配符）')
  // 树存活窗口内的断言全部通过，放行 worker 收工 → 回灌 → 领队收尾
  releaseWorkers()
  const tDone = Date.now()
  while (Date.now() - tDone < 30000) {
    if (['done', 'failed'].includes(store.get(leader.id).status)) break
    await wait(150)
  }
  const fin = store.get(leader.id)
  assert.equal(fin.status, 'done', `领队 done（${fin.status}${fin.error ? ' ' + fin.error : ''}）`)
  // P0 管线级断言：范围外成果经终态 commitAll（--sparse）落盘 → 随分支合并进集成分支
  const integBranch = fin.integration?.branch ?? ''
  assert.ok(integBranch, '⑥ P0 前置：集成分支已产出')
  const integTree = e2e.g('ls-tree', '-r', '--name-only', integBranch)
  assert.ok(integTree.includes('client/Assets/GameMain/alpha.txt'), '⑥ P0：范围内成果进集成分支')
  assert.ok(integTree.includes('client/Assets/Art/rogue.txt'), `⑥ P0：范围外成果经 --sparse 落盘后进集成分支（实际 ls-tree：${integTree.split('\n').filter((f) => f.includes('Art') || f.includes('rogue')).join('、') || '无'}）`)
  console.log('  OK ⑥ runner 端到端：四单全建成、子树范围与声明一致、生效/回落/格式非法注记全部落时间线、范围外成果进集成分支（P0）')

  // ---- ⑦ 回放并集（§6.3 关键点）：稀疏范围外有未提交改动也被回放 ----
  // 领队在范围外改已跟踪文件 + 在新目录塞未跟踪文件 + 在范围内也改一份 → 回放前把增量
  // 触达目录补进 cone：三处改动全部落进子树工作树（内容逐字对照），无关目录照常不物化，
  // 子分支推进到回放提交、status 自洽。对照：不带范围的回放（全量树）行为零变化。
  const replayUnion = makeRepo('replay-union')
  const replayWt = await createWorktree(replayUnion.dir, 'task_replay_c1', 'main', 'task_replay', undefined, { sparseDirs: ['client/Assets/GameMain'] })
  assert.equal(replayWt.sparse?.status, 'applied', '⑦ 前置：稀疏树建成')
  const replayBase = JSON.parse(fs.readFileSync(path.join(replayUnion.dir, '.agentdeck-worktrees', '.metadata', 'task_replay_c1.json'), 'utf8')).baseSha
  fs.writeFileSync(path.join(replayUnion.dir, 'docs', 'd.txt'), 'd v2 领队未提交\n')
  fs.mkdirSync(path.join(replayUnion.dir, 'notes'), { recursive: true })
  fs.writeFileSync(path.join(replayUnion.dir, 'notes', 'new.txt'), '范围外新目录的未跟踪文件\n')
  fs.writeFileSync(path.join(replayUnion.dir, 'client', 'Assets', 'GameMain', 'a.txt'), 'a v2 领队未提交\n')
  const replayed = await replayLeaderBaseline(replayUnion.dir, replayWt.path, replayBase, undefined, { sparseDirs: ['client/Assets/GameMain'] })
  assert.equal(replayed.status, 'applied', `⑦ 范围外增量回放成功（${replayed.status}: ${replayed.reason}）`)
  assert.equal(replayed.files, 3, `⑦ 回放文件数含范围外改动（${replayed.files}）`)
  const replayList = listTree(replayWt.path)
  assert.ok(hasAll(replayList, ['docs/', 'notes/', 'notes/new.txt', 'client/Assets/GameMain/a.txt']), `⑦ 增量触达目录已补进 cone：${JSON.stringify(replayList)}`)
  assert.ok(hasNone(replayList, ['server/', 'excel-tool/']), '⑦ 并集不扩大到无关目录')
  // 内容对照按 LF 归一：全局 core.autocrlf=true 的机器上检出会把 LF 转成 CRLF（环境差异，非本批语义）
  const lf = (rel) => fs.readFileSync(path.join(replayWt.path, ...rel.split('/')), 'utf8').replace(/\r\n/g, '\n')
  assert.equal(lf('docs/d.txt'), 'd v2 领队未提交\n', '⑦ 范围外已跟踪改动内容落树')
  assert.equal(lf('notes/new.txt'), '范围外新目录的未跟踪文件\n', '⑦ 范围外新目录未跟踪文件落树')
  assert.equal(lf('client/Assets/GameMain/a.txt'), 'a v2 领队未提交\n', '⑦ 范围内改动照常回放')
  const inChild = (...args) => execFileSync('git', ['-C', replayWt.path, ...args], { encoding: 'utf8', windowsHide: true }).trim()
  assert.equal(inChild('status', '--porcelain'), '', '⑦ 回放后 status 自洽（无 skip-worktree 暗坑）')
  assert.equal(inChild('rev-list', '--count', `${replayBase}..HEAD`), '1', '⑦ 子分支推进到回放提交')
  assert.equal(replayed.commitSha, inChild('rev-parse', 'HEAD'), '⑦ 回放提交即子分支 tip')
  // 对照组：同样的范围外增量，回放调用不带范围（全量树/回落树形态）→ 行为零变化照常 applied
  const plainReplay = makeRepo('replay-plain')
  const plainWt2 = await createWorktree(plainReplay.dir, 'task_replay_p1', 'main', 'task_replay_p')
  assert.ok(plainWt2 && plainWt2.sparse === undefined, '⑦ 对照组前置：全量树无 sparse 字段')
  const plainBase = JSON.parse(fs.readFileSync(path.join(plainReplay.dir, '.agentdeck-worktrees', '.metadata', 'task_replay_p1.json'), 'utf8')).baseSha
  fs.writeFileSync(path.join(plainReplay.dir, 'docs', 'd.txt'), 'd v2 领队未提交\n')
  const plainApplied = await replayLeaderBaseline(plainReplay.dir, plainWt2.path, plainBase)
  assert.equal(plainApplied.status, 'applied', `⑦ 不带范围的回放照常 applied（${plainApplied.reason}）`)
  assert.equal(fs.readFileSync(path.join(plainWt2.path, 'docs', 'd.txt'), 'utf8').replace(/\r\n/g, '\n'), 'd v2 领队未提交\n', '⑦ 不带范围的回放行为零变化')
  console.log('  OK ⑦ 回放并集：范围外未提交改动也被回放且真实物化（含新目录），无关目录不物化，全量对照零变化')

  // ---- ⑧ commitAll 稀疏全收（P0）：scope 外成果 + 范围内改动一并提交，cone 不扩 ----
  // 旧代码形态（变异红19 固化）：add -A 不带 --sparse 在稀疏树整批 exit 1 拒收——范围内
  // 改动也进不了提交，调用方再无视返回值就是「队员写出 scope 外文件 → 成果全丢」。
  const p0 = makeRepo('p0-commit')
  const p0Wt = await createWorktree(p0.dir, 'task_p0_c1', 'main', 'task_p0', undefined, { sparseDirs: ['client/Assets/GameMain'] })
  assert.equal(p0Wt.sparse?.status, 'applied', '⑧ 前置：稀疏树建成')
  fs.writeFileSync(path.join(p0Wt.path, 'client', 'Assets', 'GameMain', 'a.txt'), 'a v2 队员改动\n')
  fs.mkdirSync(path.join(p0Wt.path, 'server', 'legacy'), { recursive: true })
  fs.writeFileSync(path.join(p0Wt.path, 'server', 'legacy', 'rogue.txt'), 'scope 外成果\n')
  const landed = await commitAllDetailed(p0Wt.path, 'agentdeck: p0 成果')
  assert.equal(landed.committed, true, `⑧ 落盘成功（failed=${landed.failed}${landed.reason ? '：' + landed.reason : ''}）`)
  const p0Tree = p0.g('ls-tree', '-r', '--name-only', p0Wt.branch)
  assert.ok(p0Tree.includes('client/Assets/GameMain/a.txt'), '⑧ 范围内改动已提交')
  assert.ok(p0Tree.includes('server/legacy/rogue.txt'), '⑧ scope 外成果已提交（旧代码整批丢失）')
  assert.equal(p0.g('-C', p0Wt.path, 'status', '--porcelain'), '', '⑧ 提交后 status 自洽')
  const p0Cone = execFileSync('git', ['-C', p0Wt.path, 'sparse-checkout', 'list'], { encoding: 'utf8' }).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  assert.ok(!p0Cone.some((d) => d === 'server' || d.startsWith('server/')), `⑧ cone 不扩（list=${p0Cone.join('、')}）`)
  // 对照组：全量树 commitAllDetailed 行为零变化（干净副本无改动 → committed=false 且非失败）
  const p0Plain = await createWorktree(p0.dir, 'task_p0_c2', 'main', 'task_p0_b')
  const plainLanded = await commitAllDetailed(p0Plain.path, 'agentdeck: 空改动')
  assert.equal(plainLanded.committed, false, '⑧ 对照：干净全量树无可提交改动')
  assert.equal(plainLanded.failed, false, '⑧ 对照：无改动不算失败（与旧 commitAll false 语义一致）')
  console.log('  OK ⑧ commitAll 稀疏全收：scope 外成果+范围内改动一并提交、cone 不扩、全量对照零变化')

  console.log('\nSPARSE WORKTREE SMOKE PASSED')
} finally {
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 })
}
