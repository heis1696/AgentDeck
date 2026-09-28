// 队列重启恢复冒烟：硬切(<continue>)后继任务以 queued 落库，排队启动依赖事件
// （enqueue / 上一跑落幕触发 pump）。应用在窗口期重启后事件源全消失，任务永远滞留
// 排队——且非 parked 的排队任务在 UI 没有任何启动入口。本冒烟复现缺口并验证
// 启动对账恢复：running 崩溃/queued/holding 全部夹具经**同一次**真实
// reconcileStartupTasks 单次调用断言（与 src/main/index.ts 同一实现，无镜像代码）。
//
// 重启后的 running 只有在**执行身份被证实已死**时才是僵尸：活跃或身份不可读的记录
// 一律保留。接管统一走 store.recoverDeadRuns（锁外探活 + 锁内按捕获身份条件提交），
// 且对账的每一笔写入都带上捕获的身份，绝不覆盖期间出现的替换运行。
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

// 看门狗短空转上限（必须在导入 runner 产物前设置：模块初始化时读取）
process.env.AGENTDECK_TURN_IDLE_MS = '3000'

const root = path.resolve(import.meta.dirname, '..')
for (const [src, out] of [
  ['src/main/runner.ts', 'out/sqr-runner.cjs'],
  ['src/main/store.ts', 'out/sqr-store.cjs'],
  ['src/main/persistence.ts', 'out/sqr-persistence.cjs'],
  ['src/main/git.ts', 'out/sqr-git.cjs'],
  ['src/main/handoff.ts', 'out/sqr-handoff.cjs']
]) {
  await build({ entryPoints: [path.join(root, src)], outfile: path.join(root, out), bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['electron'] })
}
const { TaskRunner } = await import(pathToFileURL(path.join(root, 'out/sqr-runner.cjs')).href)
const { TaskStore } = await import(pathToFileURL(path.join(root, 'out/sqr-store.cjs')).href)
const { probeProcess, processOwnerState, currentProcessIdentity } = await import(pathToFileURL(path.join(root, 'out/sqr-persistence.cjs')).href)
const { createWorktree, reclaimWorktree, setWorktreeOwner } = await import(pathToFileURL(path.join(root, 'out/sqr-git.cjs')).href)
const { reconcileStartupTasks } = await import(pathToFileURL(path.join(root, 'out/sqr-handoff.cjs')).href)

const assert = (cond, msg) => { if (!cond) { console.error('❌', msg); process.exit(1) } console.log('  ✓', msg) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 5000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (fn()) return true; await sleep(50) }
  return fn()
}

function makeBackend() {
  return {
    id: 'fake', label: 'Fake',
    async probe() { return { ok: true, detail: 'fake' } },
    async start({ events }) {
      setTimeout(() => {
        events.onEvent({ ts: Date.now(), kind: 'final', text: '阶段完成' })
        events.onTurnEnd({ response: '阶段完成', ok: true })
      }, 30)
      return {
        sessionId: 'sess_' + Math.random().toString(36).slice(2, 8),
        async send() {}, async stop() {}, async close() {}
      }
    }
  }
}

/** Real, provably dead execution identity: observe a live child, then stop it. */
async function deadExecutionOwner() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true })
  let observed
  for (let i = 0; i < 120; i++) {
    observed = probeProcess(child.pid)
    if (observed.state === 'alive' && observed.instance) break
    await sleep(50)
  }
  if (observed?.state !== 'alive' || !observed.instance) {
    child.kill()
    throw new Error(`cannot observe a strong child process identity on ${process.platform}: ${JSON.stringify(observed)}`)
  }
  child.kill()
  await new Promise((resolve) => child.on('exit', resolve))
  const owner = { pid: child.pid, instance: observed.instance, token: 'dead-worker-token', leaseExpiresAt: Date.now() - 60000 }
  if (processOwnerState(owner) !== 'dead') throw new Error('the stopped child is not proven dead; refusing to build the fixture')
  return owner
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-queue-recovery-'))
const deadOwner = await deadExecutionOwner()
const liveOwner = { ...currentProcessIdentity(), token: 'live-owner-token', leaseExpiresAt: Date.now() - 60000 }
// 真实托管 worktree 夹具（phase 1 建，phase 2 断言）：健康树 + 四种坏树（目录被清/
// Git 注册被摘/世代标记被篡改/任务世代错标）+ 同名删树重建树（世代证据专项）
const wtrepo = path.join(dir, 'wtrepo')
let wtHealthy, wtVanished, wtUnregistered, wtTampered, wtGenflag, wtRebuiltFirst

// ---- 阶段 1（重启前）：硬切后继任务以 queued 落库但不入队执行，随后应用退出 ----
{
  const store = new TaskStore(dir)
  const source = store.create({ title: '阶段1', prompt: '做阶段1', workdir: '', backend: 'fake', trigger: 'assignment', issueId: 'iss_x' })
  store.update(source.id, { status: 'done', endedAt: Date.now(), result: '阶段1完成' })
  // createHandoffTask 的产物：trigger=handoff、continuesFrom、非 parked、无 goalId/parentTaskId
  store.create({ title: '▶ 阶段2', prompt: '做阶段2', workdir: '', backend: 'fake', trigger: 'handoff', issueId: 'iss_x', continuesFrom: source.id })
  // 三类不应被自动恢复的遗留排队任务
  store.create({ title: 'goal阶段', prompt: 'g', workdir: '', backend: 'fake', issueId: 'iss_g', goalId: 'goal_1' })
  store.create({ title: 'worker', prompt: 'w', workdir: '', backend: 'fake', parentTaskId: source.id })
  store.create({ title: 'parked', prompt: 'p', workdir: '', backend: 'fake', parked: true })
  // 翻面前崩溃的 dispatchHold 子单（建单流程在翻面前被重启打断）：
  // ① 无树 holding → 磁盘核实免检，翻面恢复派发并跑通；
  // ② 带死路径 worktree 的 holding → 磁盘归属无法核实，转具名终态+处置提示；
  // ③ 旧快照 parked+holding → 同样翻面恢复（parked 一并释放，不再「可启动却领不动」）
  store.create({ title: 'holding子单', prompt: 'h', workdir: '', backend: 'fake', parentTaskId: source.id, dispatchHold: true })
  store.create({
    title: 'holding有树', prompt: 't', workdir: path.join(dir, 'repo'), backend: 'fake', parentTaskId: source.id, dispatchHold: true,
    worktree: { ownerTaskId: 'lost-owner', repoDir: path.join(dir, 'repo'), path: path.join(dir, 'missing-worktree'), branch: 'agentdeck/missing', baseSha: 'deadbeef', createdAt: Date.now(), cleanupStatus: 'active' }
  })
  store.create({ title: 'holding挂起', prompt: 'q', workdir: '', backend: 'fake', parentTaskId: source.id, dispatchHold: true, parked: true })
  // —— 真实托管 worktree 夹具（磁盘归属三步核实的正/反两面）：正 = 健康树翻面派发；
  // 反 = 目录被清 / Git 注册被摘 / 世代标记被篡改 / 任务世代错标，四种坏树一律具名终态 ——
  fs.mkdirSync(wtrepo, { recursive: true })
  const wgit = (...args) => execFileSync('git', ['-C', wtrepo, ...args], { encoding: 'utf8' })
  wgit('init', '-q', '-b', 'main')
  wgit('config', 'user.email', 'smoke@example.invalid')
  wgit('config', 'user.name', 'Smoke')
  fs.writeFileSync(path.join(wtrepo, 'base.txt'), 'base\n')
  wgit('add', '-A')
  wgit('commit', '-qm', 'init')
  const mkManagedWorktree = async (name) => {
    const wt = await createWorktree(wtrepo, name, 'main', 'seed-owner')
    if (!wt) throw new Error(`fixture worktree ${name} could not be created`)
    return wt
  }
  wtHealthy = await mkManagedWorktree('qr-healthy')
  wtVanished = await mkManagedWorktree('qr-vanished')
  wtUnregistered = await mkManagedWorktree('qr-unregistered')
  wtTampered = await mkManagedWorktree('qr-tampered')
  wtGenflag = await mkManagedWorktree('qr-genflag')
  fs.rmSync(wtVanished.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  fs.rmSync(path.join(wtrepo, '.git', 'worktrees', 'qr-unregistered'), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  fs.writeFileSync(path.join(wtrepo, '.git', 'worktrees', 'qr-tampered', 'agentdeck-generation'), 'tampered-generation\n')
  // 证据里的 owner 一律取磁盘出生 owner（建单时挂在领队名下）——与新契约的 owner 核对一致
  const worktreeFixture = (wt, generationId) => ({
    ...wt.metadata, ...(generationId ? { generationId } : {})
  })
  // 同名删树重建复现（任务侧独立世代证据专项）：残单登记**不带世代**（旧版快照），
  // owner/分支/路径与重建后的磁盘完全一致；随后目录/Git 注册/sidecar 全清并按同名重建——
  // 磁盘是棵世代不同的新树，sidecar 元数据却与登记严丝合缝。旧代码退回元数据世代自证，
  // 旧残单就能认领陌生新树翻面入队；新代码缺任务侧独立证据一律拒绝核实。
  wtRebuiltFirst = await mkManagedWorktree('qr-rebuilt')
  const rebuiltLegacyGen = wtRebuiltFirst.metadata.generationId
  fs.rmSync(wtRebuiltFirst.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  fs.rmSync(path.join(wtrepo, '.git', 'worktrees', 'qr-rebuilt'), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  fs.rmSync(path.join(wtrepo, '.agentdeck-worktrees', '.metadata', 'qr-rebuilt.json'), { force: true })
  execFileSync('git', ['-C', wtrepo, 'worktree', 'prune'], { encoding: 'utf8' })
  execFileSync('git', ['-C', wtrepo, 'branch', '-D', 'agentdeck/qr-rebuilt'], { encoding: 'utf8' })
  const wtRebuiltSecond = await mkManagedWorktree('qr-rebuilt')
  if (wtRebuiltSecond.metadata.generationId === rebuiltLegacyGen) throw new Error('fixture rebuild did not mint a fresh generation')
  if (wtRebuiltSecond.path !== wtRebuiltFirst.path) throw new Error('fixture rebuild changed the managed path')
  store.create({ title: 'holding好树', prompt: 'wt-good', workdir: wtHealthy.path, backend: 'fake', parentTaskId: source.id, dispatchHold: true, worktree: worktreeFixture(wtHealthy) })
  store.create({ title: 'holding树没目录', prompt: 'wt-gone', workdir: wtVanished.path, backend: 'fake', parentTaskId: source.id, dispatchHold: true, worktree: worktreeFixture(wtVanished) })
  store.create({ title: 'holding注册被摘', prompt: 'wt-unreg', workdir: wtUnregistered.path, backend: 'fake', parentTaskId: source.id, dispatchHold: true, worktree: worktreeFixture(wtUnregistered) })
  store.create({ title: 'holding世代被篡改', prompt: 'wt-tamper', workdir: wtTampered.path, backend: 'fake', parentTaskId: source.id, dispatchHold: true, worktree: worktreeFixture(wtTampered) })
  store.create({ title: 'holding世代错标', prompt: 'wt-flag', workdir: wtGenflag.path, backend: 'fake', parentTaskId: source.id, dispatchHold: true, worktree: worktreeFixture(wtGenflag, 'wrong-generation') })
  store.create({ title: 'holding同名重建', prompt: 'wt-rebuilt', workdir: wtRebuiltSecond.path, backend: 'fake', parentTaskId: source.id, dispatchHold: true,
    worktree: { ...wtRebuiltFirst.metadata, generationId: undefined } })
  // 残缺登记（有 worktree 记录但 path 为空）：归「无法核实」具名终态，绝不按无树子单翻面
  store.create({ title: 'holding空路径', prompt: 'wt-empty', workdir: '', backend: 'fake', parentTaskId: source.id, dispatchHold: true,
    worktree: { ownerTaskId: 'lost-owner', repoDir: path.join(dir, 'repo'), path: '', branch: 'agentdeck/qr-empty', baseSha: 'deadbeef', createdAt: Date.now(), cleanupStatus: 'active' } })
  // 重启时正在执行的任务（①）：执行身份已死——日志尾部有 final（实际做完，状态没来得及
  // 落盘）/ 没有 final（真中断）/ 旧回合 final 后又有新回合事件（后继回合被打断）
  const finished = store.create({ title: '中断有final', prompt: 'f', workdir: '', backend: 'fake' })
  store.appendEvent(finished.id, { ts: Date.now(), kind: 'final', text: '输出其实完成了' })
  const interrupted = store.create({ title: '中断无final', prompt: 'n', workdir: '', backend: 'fake' })
  const staleFinal = store.create({ title: '中断旧final', prompt: 's', workdir: '', backend: 'fake' })
  store.appendEvent(staleFinal.id, { ts: Date.now(), kind: 'final', text: '上一回合的结果' })
  store.appendEvent(staleFinal.id, { ts: Date.now(), kind: 'user', text: '追问：继续' })
  for (const [task, runId] of [[finished, 'run_finished'], [interrupted, 'run_interrupted'], [staleFinal, 'run_stale_final']]) {
    store.update(task.id, { status: 'running', startedAt: Date.now(), runId, executionOwner: deadOwner })
  }
  // ② 身份未知的 running：没有执行归属，租约更像过期——绝不能被当成死亡证据接管
  const unknown = store.create({ title: '未知身份运行中', prompt: 'u', workdir: '', backend: 'fake' })
  store.update(unknown.id, { status: 'running', startedAt: Date.now(), runId: 'run_unknown_identity' })
  // ③ 租约已过期但进程仍然活着：租约过期不是死亡证据
  const live = store.create({ title: '活跃运行中', prompt: 'l', workdir: '', backend: 'fake' })
  store.update(live.id, { status: 'running', startedAt: Date.now(), runId: 'run_live_owner', executionOwner: liveOwner })
}

// ---- 阶段 2（重启后）：新 Runner 实例，计数器从零开始，队列纯事件驱动 ----
const store = new TaskStore(dir)
const runner = new TaskRunner(store, new Map([['fake', makeBackend()]]), () => ({ concurrency: 1, mode: 'auto', notify: false }))
const byTitle = (t) => store.list().find((item) => item.title === t)
const succ = byTitle('▶ 阶段2')

await sleep(400)
assert(succ?.status === 'queued', '重启后硬切后继任务保持 queued（复现缺口：无人再泵队列）')

// ---- 启动对账：全部夹具经同一次真实 reconcileStartupTasks 单次调用断言 ----
// （src/main/handoff.ts，与 index.ts 同一实现；无任何镜像对账代码）
// ① 单点行为（证据取自任务登记，缺任一即拒绝；健康树不进本探针——它留给下方对账正例）：
const probe = await createWorktree(wtrepo, 'qr-probe', 'main', 'seed-owner')
if (!probe) throw new Error('fixture probe worktree could not be created')
const probeEvidence = () => ({ generationId: probe.metadata.generationId, ownerTaskId: 'seed-owner', branch: probe.metadata.branch })
assert(await setWorktreeOwner(probe.path, 'probe-owner', probeEvidence()) === true, '健康托管树：目录+注册+世代+owner+分支全证据核实通过，允许改绑')
assert(await setWorktreeOwner(probe.path, 'probe-owner') === false, '缺任务侧世代证据：拒绝核实（绝不退回磁盘元数据世代自证）')
assert(await setWorktreeOwner(probe.path, 'probe-owner', { generationId: ' ', ownerTaskId: 'seed-owner', branch: probe.metadata.branch }) === false, '世代证据为空白：拒绝核实')
assert(await setWorktreeOwner(probe.path, 'probe-owner', { ...probeEvidence(), ownerTaskId: '' }) === false, '缺出生 owner 证据：拒绝核实')
assert(await setWorktreeOwner(probe.path, 'probe-owner', { ...probeEvidence(), branch: 'agentdeck/qr-wrong-branch' }) === false, '分支证据与磁盘注册不符：拒绝改绑')
assert(await setWorktreeOwner(probe.path, 'probe-owner', probeEvidence()) === true, '已绑定目标的恢复重入（磁盘 owner=目标 owner）放行：绑定-翻面间崩溃可恢复')
assert(await setWorktreeOwner(wtVanished.path, 'probe-owner', { generationId: wtVanished.metadata.generationId, ownerTaskId: 'seed-owner', branch: wtVanished.metadata.branch }) === false, '目录已被清：核实拒绝（不认「元数据还在就改绑」）')
assert(await setWorktreeOwner(wtUnregistered.path, 'probe-owner', { generationId: wtUnregistered.metadata.generationId, ownerTaskId: 'seed-owner', branch: wtUnregistered.metadata.branch }) === false, 'Git 注册被摘：核实拒绝')
assert(await setWorktreeOwner(wtTampered.path, 'probe-owner', { generationId: wtTampered.metadata.generationId, ownerTaskId: 'seed-owner', branch: wtTampered.metadata.branch }) === false, '世代标记被篡改：核实拒绝')
assert(await setWorktreeOwner(wtGenflag.path, 'probe-owner', { generationId: 'wrong-generation', ownerTaskId: 'seed-owner', branch: wtGenflag.metadata.branch }) === false, '任务世代与树不符：核实拒绝')
// ①′ 池化复用防旧世代认领：树归还复用池 → 复用给新任务（世代保留、owner/分支已换）→
// 旧任务携原世代改绑必须失败，且新 owner 不被改写
const wtPool = await createWorktree(wtrepo, 'qr-pool', 'main', 'seed-owner')
if (!wtPool) throw new Error('fixture pool worktree could not be created')
const repooled = await reclaimWorktree(wtPool.path, { repool: true, expectedOwnerTaskId: 'seed-owner', expectedGenerationId: wtPool.metadata.generationId })
assert(repooled.ok === true && repooled.status === 'pooled', '前置：干净托管树归还复用池')
const reused = await createWorktree(wtrepo, 'qr-pool-next', 'main', 'next-owner')
assert(!!reused && reused.pooled === true && reused.path === wtPool.path, '前置：池化复用把同一棵树换基线交给新任务')
assert(reused.metadata.generationId === wtPool.metadata.generationId, '前置：池化复用保留原世代（世代单证因此不足以排他）')
assert(await setWorktreeOwner(wtPool.path, 'old-owner', { generationId: wtPool.metadata.generationId, ownerTaskId: 'seed-owner', branch: wtPool.metadata.branch }) === false,
  '池化复用给新任务后，旧任务携原世代+原出生证据调用：返回 false')
const pooledMeta = JSON.parse(fs.readFileSync(path.join(wtrepo, '.agentdeck-worktrees', '.metadata', 'qr-pool.json'), 'utf8'))
assert(pooledMeta.ownerTaskId === 'next-owner' && pooledMeta.branch === 'agentdeck/qr-pool-next', '池化复用后新 owner 不被旧任务改写（磁盘元数据核验）')
// ② 单次调用收场全部夹具：running 僵尸接管 + queued 两路 + holding 磁盘核实二分
const reconcileDeps = () => ({
  store,
  pushEvent: (taskId, event) => runner.pushEvent(taskId, event),
  enqueue: (task) => runner.enqueue(task),
  notifyTaskChanged: () => {},
  bindWorktreeOwner: (wtDir, ownerTaskId, expected) => setWorktreeOwner(wtDir, ownerTaskId, expected)
})
const reconcileResult = await reconcileStartupTasks(reconcileDeps())
const recoveredTitles = reconcileResult.recovered.map((task) => task.title)
assert(reconcileResult.recovered.length === 3 && reconcileResult.recovered.every((task) => task.status === 'running'),
  `三种 running 崩溃夹具经同一次真实对账接管（返回接管前捕获身份：${recoveredTitles.join('、')}）`)
const rescued = byTitle('中断有final')
assert(rescued?.status === 'done' && rescued.result === '输出其实完成了', '日志尾部有 final 的僵尸任务恢复为 done 并带回结果')
const lost = byTitle('中断无final')
assert(lost?.status === 'failed' && !!lost.error, '无 final 的僵尸任务保持 failed（错误信息保留「请重新运行」指引）')
assert(store.readEvents(lost.id).some((e) => e.kind === 'status' && e.text?.includes('启动对账') && e.text?.includes('自动标记为失败')), '中断任务时间线留有说明（不再死止于最后一次自动重试）')
const staleFinal = byTitle('中断旧final')
assert(staleFinal?.status === 'failed' && staleFinal.result === undefined, '旧回合 final 后有新回合事件：不按旧 final 抢救（后继回合真被打断）')
// 捕获身份必须挡住陈旧对账：替换运行上的对账写入不得生效
assert(store.updateIf(lost.id, { status: 'failed', runId: 'run_replaced', executionOwner: deadOwner }, { result: '陈旧对账写入' }) === undefined, '陈旧 runId 的对账写入被拒绝')
assert(store.get(lost.id).result === undefined, '陈旧对账没有污染记录')
const unknown = byTitle('未知身份运行中')
assert(unknown?.status === 'running' && unknown.runId === 'run_unknown_identity' && unknown.executionOwner === undefined, '身份未知的 running 不被接管（租约过期不是死亡证据）')
const live = byTitle('活跃运行中')
assert(live?.status === 'running' && live.runId === 'run_live_owner', '租约已过期但进程仍活着的 running 不被接管')

// —— 翻面前崩溃的 dispatchHold 子单：要么恢复派发跑通、要么具名终态可见，不允许静默悬挂 ——
const holdingSub = byTitle('holding子单')
const holdingTree = byTitle('holding有树')
const holdingParked = byTitle('holding挂起')
const holdingGoodTree = byTitle('holding好树')
const holdingVanished = byTitle('holding树没目录')
const holdingUnregistered = byTitle('holding注册被摘')
const holdingTampered = byTitle('holding世代被篡改')
const holdingGenflag = byTitle('holding世代错标')
const holdingRebuilt = byTitle('holding同名重建')
const holdingEmptyPath = byTitle('holding空路径')
assert(holdingSub && holdingTree && holdingParked && holdingGoodTree && holdingVanished && holdingUnregistered && holdingTampered && holdingGenflag && holdingRebuilt && holdingEmptyPath,
  '前置：十类 holding 子单夹具均已建单落盘')
assert(reconcileResult.holdingResumed.length === 3 && reconcileResult.holdingTerminated.length === 7,
  `holding 收场二分：恢复派发 ${reconcileResult.holdingResumed.length} 单、具名终态 ${reconcileResult.holdingTerminated.length} 单`)
assert(await until(() => store.get(holdingSub.id)?.status === 'done'), '无树 holding 子单翻面恢复派发并跑通到 done')
assert(store.get(holdingSub.id).dispatchHold === undefined, '恢复派发的 holding 子单门禁已释放（不再对调度器隐身）')
assert(store.readEvents(holdingSub.id).some((e) => e.kind === 'status' && e.text?.includes('恢复派发')), '恢复派发动作在时间线留痕')
assert(await until(() => store.get(holdingGoodTree.id)?.status === 'done') && store.get(holdingGoodTree.id).dispatchHold === undefined,
  '健康托管树的 holding 子单三步核实通过：翻面恢复派发并跑通到 done')
assert(holdingTree.status === 'cancelled' && !!holdingTree.error, '磁盘归属无法核实的 holding 子单转具名终态（cancelled+错误说明）')
assert(holdingTree.dispatchHold === true && !holdingTree.parked, '终态子单不挂起：不出现「可手动启动」却领不动的假入口')
assert(store.readEvents(holdingTree.id).some((e) => e.kind === 'status' && e.text?.includes('启动对账') && e.text?.includes('现场保留')), '终态子单时间线留痕并给出现场处置提示')
for (const [task, why] of [[holdingVanished, '目录已被清'], [holdingUnregistered, 'Git 注册被摘'], [holdingTampered, '世代标记被篡改'], [holdingGenflag, '任务世代错标']]) {
  assert(task.status === 'cancelled' && !!task.error && task.dispatchHold === true,
    `坏树 holding 子单（${why}）保持门禁转具名终态，绝不翻面派发到坏树上（实际 ${task.status}）`)
  assert(store.readEvents(task.id).some((e) => e.kind === 'status' && e.text?.includes('启动对账')), `坏树子单（${why}）时间线留痕`)
}
// 同名删树重建：登记不带世代（旧版快照），磁盘是 owner/分支/路径完全一致的陌生新树——
// 缺任务侧独立世代证据必须拒绝核实，旧残单绝不认领新树翻面入队
assert(holdingRebuilt.status === 'cancelled' && holdingRebuilt.dispatchHold === true && (holdingRebuilt.error ?? '').includes('磁盘归属无法核实'),
  `同名重建残单（登记缺世代证据）保持门禁转具名终态，不翻面入队（实际 ${holdingRebuilt.status}）`)
assert(store.readEvents(holdingRebuilt.id).some((e) => e.kind === 'status' && e.text?.includes('启动对账') && e.text?.includes('现场保留')),
  '同名重建残单时间线留痕并给出现场处置提示')
assert(!reconcileResult.holdingResumed.some((task) => task.id === holdingRebuilt.id) && holdingRebuilt.status !== 'queued',
  '同名重建残单不在恢复派发名单、不入派发队列')
// 残缺登记（有 worktree 但 path 为空）：归「无法核实」具名终态，绝不按无树子单翻面
assert(holdingEmptyPath.status === 'cancelled' && holdingEmptyPath.dispatchHold === true && (holdingEmptyPath.error ?? '').includes('登记残缺'),
  `空路径残缺登记子单保持门禁转具名终态（实际 ${holdingEmptyPath.status}，错误：${holdingEmptyPath.error ?? '无'}）`)
assert(!reconcileResult.holdingResumed.some((task) => task.id === holdingEmptyPath.id),
  '空路径残缺登记子单不进派发队列（holdingResumed 不含它）')
assert(await until(() => store.get(holdingParked.id)?.status === 'done') && store.get(holdingParked.id).parked === undefined, '旧快照 parked+holding 悬挂单同样翻面恢复（parked 一并释放）')
assert(store.list().every((t) => !(t.dispatchHold === true && t.status === 'queued')), '不允许静默悬挂：场上不存在 queued 且持门禁的子单（parked 与否皆否）')

assert(await until(() => store.get(succ.id)?.status === 'done'), '恢复入队后后继任务执行到 done')
assert(store.readEvents(succ.id).some((e) => e.kind === 'status' && e.text?.includes('启动对账')), '时间线留有恢复说明事件')
assert(byTitle('未知身份运行中')?.status === 'running', '排队对账不会顺带接管身份未知的运行')
// goal/worker 挂起后 pump 永远跳过：等后继任务落幕再验一次（验证不是“暂缓”而是真不跑）
await sleep(400)
runner.enqueue(store.get(succ.id) ?? succ) // 制造一次 pump，模拟任意后续事件
await sleep(400)
assert(byTitle('goal阶段')?.status === 'queued' && byTitle('goal阶段')?.parked, 'goal 绑定的排队任务被挂起，后续 pump 不再扫走')
assert(byTitle('worker')?.status === 'queued' && byTitle('worker')?.parked, '委派 worker 排队任务被挂起（委派循环已死）')
assert(byTitle('parked')?.status === 'queued' && byTitle('parked')?.parked, 'parked 任务保持待启动')
assert(byTitle('holding有树')?.status === 'cancelled', '具名终态的 holding 子单不被后续 pump 复活或扫走')

// ---- 幂等：同样单次真实调用再跑一遍，全部收场为空（死运行只认领一次、queued/holding 不二次处置）----
const second = await reconcileStartupTasks(reconcileDeps())
assert(second.recovered.length === 0 && second.queued.length === 0 && second.holdingResumed.length === 0 && second.holdingTerminated.length === 0,
  `对账幂等：再次单次调用零收场（recovered=${second.recovered.length}, queued=${second.queued.length}, resumed=${second.holdingResumed.length}, terminated=${second.holdingTerminated.length}）`)

console.log('\n✅ 队列重启恢复冒烟通过')
