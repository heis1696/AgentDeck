// 稀疏检出第一批（协议 + 建树 + 回落，最小闭环）冒烟：docs/WORKTREE-BIG-REPO-PERF.md §6.1-§6.4/§7.3
// ① 协议解析：sparse 属性逗号分隔、/ 与 \ 归一、空值=未声明、通配符/越界段=invalid、缺省零变化
// ② 建树三步：合法范围 → worktree add --no-checkout → sparse-checkout set --cone → checkout，
//    工作树只物化声明目录（cone 模式根文件恒在）；代际/元数据/分支照常
// ③ 回落全量：目录在基线中不存在（cone 对不存在目录静默接受，必须自查）→ 整单回落全量，
//    结果 sparse.status='fallback' 附原因（含被拒目录），绝不拒单、树全量物化
// ④ 缺省零变化：不带 sparseDirs 的建树结果无 sparse 字段、全量物化、池化行为原样
// ⑤ 池化安全（一期不做范围匹配）：稀疏树不入池（走常规回收）；池条目带稀疏配置 → 复用侧
//    逐出回落全量 add；带稀疏范围的派单不进池复用（宁建新树，不复用出错误范围）
// ⑥ runner 端到端：派单 sparse 属性 → 时间线注记可见（生效/回落含被拒目录/格式非法含通配符），
//    四单全部建成（不拒单），子单工作树物化范围与声明一致
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
const { createWorktree, reclaimWorktree, clearWorktreePool, clearWorktreeFileCountCache, worktreePoolEntriesForTest } = git

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

  // ---- ⑤ 池化安全（一期无范围匹配：宁可重设/回落全量，不复用出错误范围）----
  // ⑤a 稀疏树不入池：归还时按 core.sparseCheckout 拒绝入池，走常规回收（删树）
  const sparseOwner = makeRepo('pool-sparse-owner')
  const sparseTree = await createWorktree(sparseOwner.dir, 'task_pools_c1', 'main', 'pool_owner_a', undefined, { sparseDirs: ['client/Assets/GameMain'] })
  assert.equal(sparseTree.sparse?.status, 'applied', '⑤a 前置：稀疏树建成')
  const sparseRelease = await reclaimWorktree(sparseTree.path, { repool: true, expectedOwnerTaskId: 'pool_owner_a' })
  assert.notEqual(sparseRelease.status, 'pooled', '稀疏树拒绝入池（走常规回收）')
  assert.ok(!fs.existsSync(sparseTree.path), '稀疏树已按常规回收移除')
  assert.deepEqual(worktreePoolEntriesForTest(sparseOwner.dir), [], '池内无稀疏条目')
  // ⑤b 复用侧逐出：池条目带稀疏配置（外部遗留/异常路径入池形态）→ 复用时逐出，回落全量 add
  const legacyOwner = makeRepo('pool-legacy')
  const pooledFull = await createWorktree(legacyOwner.dir, 'task_pool_c1', 'main', 'pool_owner_b')
  const repooled = await reclaimWorktree(pooledFull.path, { repool: true, expectedOwnerTaskId: 'pool_owner_b' })
  assert.equal(repooled.status, 'pooled', '⑤b 前置：全量树照常入池')
  legacyOwner.g('-C', pooledFull.path, 'sparse-checkout', 'set', '--cone', '--', 'client')
  const afterLegacy = await createWorktree(legacyOwner.dir, 'task_pool_c2', 'main', 'pool_owner_c')
  assert.ok(afterLegacy && afterLegacy.pooled !== true, '带稀疏配置的池条目不被复用（回落全量 add 新树）')
  assert.notEqual(afterLegacy.path, pooledFull.path, '复用走的是全新目录')
  assert.deepEqual(worktreePoolEntriesForTest(legacyOwner.dir), [], '稀疏池条目已逐出')
  assert.ok(!fs.existsSync(pooledFull.path), '逐出条目按归属回收')
  assert.ok(hasAll(listTree(afterLegacy.path), FULL_TREE), '新树全量物化（不带错误范围）')
  // ⑤c 带稀疏范围的派单不进池复用：池里有空闲全量树也跳过（一期不做范围匹配）
  const skipOwner = makeRepo('pool-skip')
  const poolable = await createWorktree(skipOwner.dir, 'task_skip_c1', 'main', 'pool_owner_d')
  await reclaimWorktree(poolable.path, { repool: true, expectedOwnerTaskId: 'pool_owner_d' })
  assert.equal(worktreePoolEntriesForTest(skipOwner.dir).length, 1, '⑤c 前置：池内有一条空闲全量树')
  const sparseSkip = await createWorktree(skipOwner.dir, 'task_skip_c2', 'main', 'pool_owner_e', undefined, { sparseDirs: ['excel-tool'] })
  assert.ok(sparseSkip && sparseSkip.pooled !== true, '稀疏派单不进池复用（宁建新树）')
  assert.equal(sparseSkip.sparse?.status, 'applied', '稀疏新树范围生效')
  assert.ok(hasNone(listTree(sparseSkip.path), ['docs/', 'server/']), '新树按声明范围物化')
  clearWorktreePool()
  clearWorktreeFileCountCache()
  console.log('  OK ⑤ 池化安全：稀疏树不入池、池条目带稀疏配置逐出、稀疏派单不进池')

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
        // Alpha 写声明范围内的文件；其余写根文件（cone 模式根文件恒物化，全量树自不待言）
        try {
          if (tag === 'Alpha') fs.writeFileSync(path.join(workdir, 'client', 'Assets', 'GameMain', 'alpha.txt'), `by ${tag}\n`)
          else fs.writeFileSync(path.join(workdir, `${tag.toLowerCase()}.txt`), `by ${tag}\n`)
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
  console.log('  OK ⑥ runner 端到端：四单全建成、子树范围与声明一致、生效/回落/格式非法注记全部落时间线')

  console.log('\nSPARSE WORKTREE SMOKE PASSED')
} finally {
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 })
}
