// 变异红测：把本轮修复逐一回退为旧行为（字符串级变异到临时源码树），用与新代码
// 相同的行为断言跑「旧代码」，证明每条断言在旧代码下确实失败（红证）。
// 用法：node scripts/smoke-delegate-mutation.mjs（全部红证成立 exit 0）
import { build } from 'esbuild'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')

/** 复制整棵 src 到临时目录并对指定文件应用字符串变异（bundle 的相对导入在树内自洽） */
function mutatedTree(mutations) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mut-src-'))
  fs.cpSync(path.join(root, 'src'), path.join(dir, 'src'), { recursive: true })
  for (const mutation of mutations) {
    const target = path.join(dir, mutation.file)
    // 仓库工作副本是 CRLF；锚点统一按 LF 书写，先归一化再替换
    let src = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n')
    if (!src.includes(mutation.find)) throw new Error(`变异锚点未命中（${mutation.file}）：${mutation.find.slice(0, 60)}…`)
    src = src.replace(mutation.find, mutation.replace)
    fs.writeFileSync(target, src)
  }
  return dir
}

async function bundle(tree, srcFile, outfile) {
  await build({ entryPoints: [path.join(tree, srcFile)], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['electron'] })
}

/** 用变异产物跑场景脚本：红证成立的判定是「exit 3 且输出命中本红证预期的具名 RED: 断言」——
 *  只按退出码计红会把场景自身的意外崩溃误当红证；只认 RED: 而不校验预期标识，会让
 *  变异炸出的前置/无关断言被误认成红证（红证必须断言出它声称守卫的那条行为）。
 *  expectedRed 是该红证预期命中的断言文案片段。 */
async function runScenario(tree, scenarioScript, extraBundles = [], expectedRed = '') {
  const runnerOut = path.join(tree, 'out-runner.cjs')
  const storeOut = path.join(tree, 'out-store.cjs')
  const handoffOut = path.join(tree, 'out-handoff.cjs')
  await bundle(tree, 'src/main/runner.ts', runnerOut)
  await bundle(tree, 'src/main/store.ts', storeOut)
  await bundle(tree, 'src/main/handoff.ts', handoffOut)
  const replacements = [
    ['__MUT_RUNNER__', runnerOut],
    ['__MUT_STORE__', storeOut],
    ['__MUT_HANDOFF__', handoffOut]
  ]
  for (const [index, extra] of extraBundles.entries()) {
    const out = path.join(tree, `out-extra-${index}.cjs`)
    await bundle(tree, extra.src, out)
    replacements.push([`__MUT_${extra.var}__`, out])
  }
  const scriptFile = path.join(tree, 'scenario.cjs')
  fs.writeFileSync(scriptFile, replacements.reduce((acc, [placeholder, value]) => acc.split(placeholder).join(JSON.stringify(value)), scenarioScript))
  try {
    const stdout = execFileSync('node', [scriptFile], { encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] })
    return { red: false, asserted: false, matched: '', output: stdout }
  } catch (error) {
    const output = (error.stdout ?? '') + (error.stderr ?? '')
    const matched = output.split('\n').find((line) => line.includes('RED:') && (!expectedRed || line.includes(expectedRed))) ?? ''
    const asserted = error.status === 3 && !!matched
    return { red: asserted, asserted, matched, output }
  }
}

// ---- 场景共享骨架（CommonJS，在变异树里独立运行） ----
const PRELUDE = `
const path = require('path')
const fs = require('fs')
const os = require('os')
const { execFileSync } = require('child_process')
const { TaskRunner } = require(__MUT_RUNNER__)
const { TaskStore } = require(__MUT_STORE__)
const assert = (cond, msg) => { if (!cond) { console.error('RED:' + msg); process.exit(3) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const settle = (store, id, timeout = 30000) => new Promise((resolve) => {
  const t0 = Date.now()
  const tick = () => {
    const t = store.get(id)
    if (t.status === 'done' || t.status === 'failed' || Date.now() - t0 > timeout) return resolve(t)
    setTimeout(tick, 100)
  }
  tick()
})
function makeRepo(prefix) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'smoke@example.invalid')
  git('config', 'user.name', 'Smoke')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a v1\\n')
  fs.writeFileSync(path.join(repo, 'beta.txt'), 'beta v1\\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
  return { repo, git }
}
function makeLeader(step) {
  const sent = []
  return {
    sent, id: 'zcode', label: 'Boss',
    async probe() { return { ok: true, detail: '' } },
    async start({ events: rawEvents, turn }) {
      let activeTurn = turn
      const events = {
        onEvent: (event) => rawEvents.onEvent(event, activeTurn),
        onTurnEnd: (result) => rawEvents.onTurnEnd(result, activeTurn)
      }
      await Promise.resolve()
      step(0, { events, content: '' })
      return { sessionId: 'sess_lead', turnScoped: true, async send(content, nextTurn) { activeTurn = nextTurn; sent.push(content); step(sent.length, { events, content }) }, async stop() {}, async close() {} }
    }
  }
}
function emitTurn(events, response, delegateTags) {
  if (delegateTags) for (const tag of delegateTags) events.onEvent({ ts: Date.now(), kind: 'text', text: tag })
  events.onEvent({ ts: Date.now(), kind: 'final', text: response })
  events.onTurnEnd({ response, delegationText: delegateTags ? delegateTags.join('\\n') : undefined, ok: true })
}
function makeWorker(id, onStart) {
  return {
    id, label: id,
    async probe() { return { ok: true, detail: '' } },
    async start({ events, workdir }) {
      onStart?.({ workdir })
      setTimeout(() => {
        events.onEvent({ ts: Date.now(), kind: 'final', text: 'done ' + id })
        events.onTurnEnd({ response: 'done ' + id, ok: true })
      }, 30)
      return { sessionId: 'sess_w', async send() {}, async stop() {}, async close() {} }
    }
  }
}
`

// 红1｜建单门禁：旧代码下「绑定期间被领取 → 让位不撤销」断言必红
const RED1 = `
${PRELUDE}
async function main() {
  const { repo } = makeRepo('mut-r1-')
  const team = [
    { id: 'L1', name: 'Boss', backend: 'zcode', role: 'leader', systemPrompt: '', subordinates: ['W1'] },
    { id: 'W1', name: 'Alpha', backend: 'alpha', role: 'worker', systemPrompt: '' }
  ]
  const leader = makeLeader((n, { events, content }) => {
    if (n === 0) emitTurn(events, '派单。', ['<delegate to="Alpha">把 a.txt 改成 v2</delegate>'])
    else if (content.includes('队员执行结果汇报')) emitTurn(events, '最终总结：a.txt 已升级。')
    else emitTurn(events, '继续。')
  })
  const store = new TaskStore(fs.mkdtempSync(path.join(os.tmpdir(), 'mut-r1-store-')))
  let workerStarts = 0
  const alpha = { id: 'alpha', label: 'alpha', async probe() { return { ok: true, detail: '' } },
    async start({ events, workdir }) {
      workerStarts++
      setTimeout(() => {
        fs.writeFileSync(path.join(workdir, 'a.txt'), 'a v2 by Alpha\\n')
        events.onTurnEnd({ response: 'done alpha', ok: true })
      }, 80)
      return { sessionId: 'sess_w', async send() {}, async stop() {}, async close() {} }
    } }
  const runner = new TaskRunner(store, new Map([['zcode', leader], ['alpha', alpha]]),
    () => ({ concurrency: 1, mode: 'yolo', notify: false, workerConcurrency: 3 }))
  runner.attachTeam(() => team)
  const realCreate = store.create.bind(store)
  let injected = 0
  runner.attachTaskCreator((input) => {
    if (injected++ === 0) {
      const child = realCreate(input)
      const metadataJson = path.join(repo, '.agentdeck-worktrees', '.metadata', path.basename(input.worktree.path) + '.json')
      fs.rmSync(metadataJson, { force: true })
      setTimeout(() => { store.update(child.id, { dispatchHold: undefined }); runner.enqueue(child) }, 0)
      return child
    }
    return realCreate(input)
  })
  const task = store.create({ title: '绑定期间被领取', prompt: '处理 A', workdir: repo, backend: 'zcode', agentId: 'L1' })
  runner.enqueue(task)
  const fin = await settle(store, task.id)
  const children = store.list().filter((c) => c.parentTaskId === task.id)
  assert(fin.status === 'done', '领队 done（实际 ' + fin.status + '）')
  assert(children.length === 1 && children[0].status === 'done', '已被领取的子单让位后跑到终态，不被撤销（实际 ' + children.map((c) => c.status).join(',') + '）')
  assert(workerStarts === 1, '子单恰好执行一次（实际 ' + workerStarts + '）')
  assert(!leader.sent.some((c) => c.includes('没有被执行')), '让位不产生「本单未执行」误导拒单')
  console.log('SCENARIO-OK')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(3) })
`

// 红2｜cancelled 误合入：旧代码下「半成品零合入」断言必红
const RED2 = `
${PRELUDE}
async function main() {
  const { repo, git } = makeRepo('mut-r2-')
  const team = [
    { id: 'L1', name: 'Boss', backend: 'zcode', role: 'leader', systemPrompt: '', subordinates: ['W1', 'W2'] },
    { id: 'W1', name: 'Alpha', backend: 'alpha', role: 'worker', systemPrompt: '' },
    { id: 'W2', name: 'Beta', backend: 'beta', role: 'worker', systemPrompt: '' }
  ]
  const leader = makeLeader((n, { events, content }) => {
    if (n === 0) emitTurn(events, '先派 A。', ['<delegate to="Alpha">做 A</delegate>'])
    else if (content.includes('队员执行结果汇报') && !content.includes('预算收尾')) emitTurn(events, '继续推进。', ['<delegate to="Beta">做 B</delegate>'])
    else if (content.includes('预算收尾')) emitTurn(events, '最终总结：A 完成，B 被取消。')
    else emitTurn(events, '继续。')
  })
  const store = new TaskStore(fs.mkdtempSync(path.join(os.tmpdir(), 'mut-r2-store-')))
  const runner = new TaskRunner(store, new Map([
    ['zcode', leader],
    ['alpha', makeWorker('alpha', ({ workdir }) => fs.writeFileSync(path.join(workdir, 'a.txt'), 'a v2 by Alpha\\n'))],
    ['beta', { id: 'beta', label: 'beta', async probe() { return { ok: true, detail: '' } },
      async start({ workdir }) {
        fs.writeFileSync(path.join(workdir, 'beta.txt'), 'beta v2 半成品（未完成）\\n')
        return { sessionId: 'sess_hang', async send() {}, async stop() {}, async close() {} }
      } }]
  ]), () => ({ concurrency: 1, mode: 'yolo', notify: false, delegateMaxRounds: 1, workerConcurrency: 3 }))
  runner.attachTeam(() => team)
  const task = store.create({ title: '收编单取消', prompt: '处理', workdir: repo, backend: 'zcode', agentId: 'L1' })
  runner.enqueue(task)
  const t0 = Date.now()
  let beta
  while (Date.now() - t0 < 15000) {
    beta = store.list().find((t) => t.parentTaskId === task.id && t.backend === 'beta')
    if (beta && beta.status === 'running') break
    await sleep(50)
  }
  if (!beta) { console.error('RED:前置失败：Beta 未建单'); process.exit(3) }
  await runner.cancel(beta.id)
  const fin = await settle(store, task.id, 60000)
  assert(fin.status === 'done', '领队 done（实际 ' + fin.status + '）')
  const ib = fin.integration && fin.integration.branch
  assert(!!ib, '集成分支存在')
  let betaInBranch = ''
  try { betaInBranch = git('show', ib + ':beta.txt') } catch {}
  assert(!betaInBranch.includes('半成品'), 'cancelled 半成品零合入（集成分支 beta.txt 含半成品=' + betaInBranch.includes('半成品') + '）')
  console.log('SCENARIO-OK')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(3) })
`

// 红4｜嗅探暂停缓冲：旧代码下「长收尾流不持续占内存」断言必红
const RED4 = `
${PRELUDE}
async function main() {
  const team = [
    { id: 'L1', name: 'Boss', backend: 'zcode', role: 'leader', systemPrompt: '', subordinates: ['W1'] },
    { id: 'W1', name: 'Alpha', backend: 'alpha', role: 'worker', systemPrompt: '' }
  ]
  let snEvents = null
  const leader = { id: 'zcode', label: 'Boss', async probe() { return { ok: true, detail: '' } },
    async start({ events: rawEvents, turn }) {
      snEvents = { onEvent: (e) => rawEvents.onEvent(e, turn), onTurnEnd: (r) => rawEvents.onTurnEnd(r, turn) }
      setTimeout(() => {
        snEvents.onEvent({ ts: Date.now(), kind: 'text', text: '<delegate to="Alpha">' + 'x'.repeat(200 * 1024) + '</delegate>' })
      }, 20)
      return { sessionId: 'sess_sn', turnScoped: true, async send() {}, async stop() {}, async close() {} }
    } }
  const store = new TaskStore(fs.mkdtempSync(path.join(os.tmpdir(), 'mut-r4-store-')))
  const alpha = { id: 'alpha', label: 'alpha', async probe() { return { ok: true, detail: '' } },
    async start({ events }) {
      setTimeout(() => events.onTurnEnd({ response: 'done alpha', ok: true }), 30)
      return { sessionId: 'sess_w', async send() {}, async stop() {}, async close() {} }
    } }
  const runner = new TaskRunner(store, new Map([['zcode', leader], ['alpha', alpha]]),
    () => ({ concurrency: 1, mode: 'yolo', notify: false, workerConcurrency: 3 }))
  runner.attachTeam(() => team)
  const task = store.create({ title: '嗅探缓冲', prompt: '处理', backend: 'zcode', agentId: 'L1' })
  runner.enqueue(task)
  const t0 = Date.now()
  while (Date.now() - t0 < 15000) {
    if (store.list().some((t) => t.parentTaskId === task.id)) break
    await sleep(50)
  }
  if (!store.list().some((t) => t.parentTaskId === task.id)) { console.error('RED:前置失败：流式建单未发生'); process.exit(3) }
  runner.suspendDelegateSpawns(task.id)
  for (let i = 0; i < 40; i++) snEvents.onEvent({ ts: Date.now(), kind: 'text', text: '尾'.repeat(8 * 1024) })
  await sleep(500)
  const buffered = runner.sniffBufferChars(task.id)
  assert(buffered < 8 * 1024, '暂停态长收尾流不持续占内存（缓冲 ' + buffered + ' 字符）')
  console.log('SCENARIO-OK')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(3) })
`

// 红5｜收口撤销竞态：旧代码（无条件 cancel，不看撤销结果就回收）下「撤销落空让位零回收」断言必红
const RED5 = `
${PRELUDE}
async function main() {
  const { repo } = makeRepo('mut-r5-')
  const team = [
    { id: 'L1', name: 'Boss', backend: 'zcode', role: 'leader', systemPrompt: '', subordinates: ['W1'] },
    { id: 'W1', name: 'Alpha', backend: 'alpha', role: 'worker', systemPrompt: '' }
  ]
  const leader = makeLeader((n, { events, content }) => {
    if (n === 0) emitTurn(events, '派单。', ['<delegate to="Alpha">把 a.txt 改成 v2</delegate>'])
    else if (content.includes('队员执行结果汇报')) emitTurn(events, '最终总结：a.txt 已升级。')
    else emitTurn(events, '继续。')
  })
  const store = new TaskStore(fs.mkdtempSync(path.join(os.tmpdir(), 'mut-r5-store-')))
  let workerStarts = 0
  const alpha = { id: 'alpha', label: 'alpha', async probe() { return { ok: true, detail: '' } },
    async start({ events, workdir }) {
      workerStarts++
      setTimeout(() => {
        fs.writeFileSync(path.join(workdir, 'a.txt'), 'a v2 by Alpha\\n')
        events.onTurnEnd({ response: 'done alpha', ok: true })
      }, 80)
      return { sessionId: 'sess_w', async send() {}, async stop() {}, async close() {} }
    } }
  const runner = new TaskRunner(store, new Map([['zcode', leader], ['alpha', alpha]]),
    () => ({ concurrency: 1, mode: 'yolo', notify: false, workerConcurrency: 3 }))
  runner.attachTeam(() => team)
  const realCreate = store.create.bind(store)
  let injected = 0
  runner.attachTaskCreator((input) => {
    const child = realCreate(input)
    if (injected++ === 0) {
      const metadataJson = path.join(repo, '.agentdeck-worktrees', '.metadata', path.basename(input.worktree.path) + '.json')
      fs.rmSync(metadataJson, { force: true })
      const realUpdateIf = store.updateIf.bind(store)
      let armed = true
      store.updateIf = (id, expected, patch) => {
        if (armed && id === child.id && patch.status === 'cancelled') {
          armed = false
          const flipped = realUpdateIf(child.id, { status: 'queued', runId: child.runId, executionOwner: child.executionOwner, dispatchHold: true }, { dispatchHold: undefined })
          assert(!!flipped, '前置：竞态注入的翻面成立')
          runner.enqueue(flipped)
          const claimed = store.get(child.id)
          assert(claimed.status === 'running', '前置：撤销落库前已被领取（实际 ' + claimed.status + '）')
        }
        return realUpdateIf(id, expected, patch)
      }
    }
    return child
  })
  const task = store.create({ title: '收口撤销竞态', prompt: '处理 A', workdir: repo, backend: 'zcode', agentId: 'L1' })
  runner.enqueue(task)
  const fin = await settle(store, task.id)
  const children = store.list().filter((c) => c.parentTaskId === task.id)
  assert(fin.status === 'done', '领队 done（实际 ' + fin.status + '）')
  assert(children.length === 1 && children[0].status === 'done', '撤销落空后子单跑到终态，不被收口撤销（实际 ' + children.map((c) => c.status).join(',') + '）')
  assert(workerStarts === 1, '子单恰好执行一次（实际 ' + workerStarts + '）')
  assert(!!children[0].workdir && fs.existsSync(children[0].workdir), '让位后零回收：在用 worktree 原样保留')
  assert(!leader.sent.some((c) => c.includes('没有被执行')), '撤销落空不产生「本单未执行」误导拒单')
  console.log('SCENARIO-OK')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(3) })
`

// 红6｜holding 崩溃收场：旧代码（无 dispatchHold 单独收场）下「翻面派发/具名终态」断言必红
const RED6 = `
const path = require('path')
const fs = require('fs')
const os = require('os')
const { TaskStore } = require(__MUT_STORE__)
const { reconcileStartupTasks } = require(__MUT_HANDOFF__)
const assert = (cond, msg) => { if (!cond) { console.error('RED:' + msg); process.exit(3) } }
async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mut-r6-'))
  const store = new TaskStore(dir)
  const source = store.create({ title: '阶段1', prompt: 'x', workdir: '', backend: 'fake' })
  store.update(source.id, { status: 'done', endedAt: Date.now() })
  const holdingSub = store.create({ title: 'holding子单', prompt: 'h', workdir: '', backend: 'fake', parentTaskId: source.id, dispatchHold: true })
  const holdingTree = store.create({ title: 'holding有树', prompt: 't', workdir: path.join(dir, 'repo'), backend: 'fake', parentTaskId: source.id, dispatchHold: true,
    worktree: { ownerTaskId: 'lost', repoDir: path.join(dir, 'repo'), path: path.join(dir, 'missing-wt'), branch: 'b', baseSha: 's', createdAt: Date.now(), cleanupStatus: 'active' } })
  const enqueued = []
  const result = await reconcileStartupTasks({
    store,
    pushEvent: () => {},
    enqueue: (task) => enqueued.push(task.id),
    notifyTaskChanged: () => {},
    bindWorktreeOwner: (wtDir) => Promise.resolve(fs.existsSync(wtDir))
  })
  assert(result.holdingResumed && result.holdingResumed.length === 1, 'holding 收场二分：恢复派发 1 单（实际 ' + (result.holdingResumed ?? []).length + '）')
  assert(result.holdingTerminated && result.holdingTerminated.length === 1, 'holding 收场二分：具名终态 1 单（实际 ' + (result.holdingTerminated ?? []).length + '）')
  assert(enqueued.includes(holdingSub.id), '无树 holding 子单翻面后恢复派发')
  assert(store.get(holdingSub.id).dispatchHold === undefined && !store.get(holdingSub.id).parked, '恢复派发的子单门禁已释放、不挂起')
  assert(store.get(holdingTree.id).status === 'cancelled', '磁盘归属无法核实的子单转具名终态（实际 ' + store.get(holdingTree.id).status + '）')
  assert(store.readEvents(holdingTree.id).some((e) => (e.text ?? '').includes('启动对账') && (e.text ?? '').includes('现场保留')), '终态子单时间线留痕并给出现场处置提示')
  assert(!store.list().some((t) => t.dispatchHold === true && t.status === 'queued'), '不允许静默悬挂：没有 queued 持门禁的残留')
  console.log('SCENARIO-OK')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(3) })
`

// 红7｜磁盘归属核实真化：旧代码（找到元数据就改绑）下「目录被清的残单不翻面派发」断言必红
const RED7 = `
${PRELUDE}
const { createWorktree, setWorktreeOwner } = require(__MUT_GIT__)
const { reconcileStartupTasks } = require(__MUT_HANDOFF__)
async function main() {
  const { repo, git } = makeRepo('mut-r7-')
  const wt = await createWorktree(repo, 'mut-r7-wt', 'main', 'seed-owner')
  assert(!!wt, '前置：真实托管 worktree 建成')
  fs.rmSync(wt.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  const store = new TaskStore(fs.mkdtempSync(path.join(os.tmpdir(), 'mut-r7-store-')))
  const source = store.create({ title: '阶段1', prompt: 'x', workdir: '', backend: 'fake' })
  store.update(source.id, { status: 'done', endedAt: Date.now() })
  const child = store.create({ title: '坏树残单', prompt: 'x', workdir: wt.path, backend: 'fake', parentTaskId: source.id, dispatchHold: true,
    worktree: Object.assign({}, wt.metadata, { ownerTaskId: 'lost-owner' }) })
  const enqueued = []
  const result = await reconcileStartupTasks({
    store,
    pushEvent: () => {},
    enqueue: (task) => enqueued.push(task.id),
    notifyTaskChanged: () => {},
    bindWorktreeOwner: (wtDir, ownerTaskId, expected) => setWorktreeOwner(wtDir, ownerTaskId, expected)
  })
  assert(result.holdingTerminated.length === 1 && result.holdingResumed.length === 0,
    '目录被清的残单必须具名终态、不得翻面（实际 terminated=' + result.holdingTerminated.length + ', resumed=' + result.holdingResumed.length + '）')
  assert(enqueued.length === 0, '绝不把子单派发到已消失的树上（实际入队 ' + enqueued.length + ' 单）')
  const after = store.get(child.id)
  assert(after.status === 'cancelled' && after.dispatchHold === true, '门禁保持 + 具名终态（实际 ' + after.status + '）')
  assert(!!after.error && after.error.includes('磁盘归属无法核实'), '错误说明具名（实际：' + (after.error ?? '无') + '）')
  console.log('SCENARIO-OK')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(3) })
`

// 红8｜重跑僵尸根断：旧代码（无 retry 门禁拒绝、无 store 不变式）下「持门禁单重跑不产生 queued+hold」断言必红
const RED8 = `
const path = require('path')
const fs = require('fs')
const os = require('os')
const electron = require('electron')
const { TaskStore } = require(__MUT_STORE__)
const { registerTaskIpc } = require(__MUT_TASKS__)
const assert = (cond, msg) => { if (!cond) { console.error('RED:' + msg); process.exit(3) } }
async function main() {
  const store = new TaskStore(fs.mkdtempSync(path.join(os.tmpdir(), 'mut-r8-store-')))
  const parent = store.create({ title: '领队', prompt: 'x', workdir: '', backend: 'fake' })
  const gated = store.create({ title: '建单残单', prompt: 'x', workdir: '', backend: 'fake', parentTaskId: parent.id, dispatchHold: true })
  store.update(gated.id, { status: 'cancelled', endedAt: Date.now(), error: '应用重启时建单未完成，启动对账转取消' })
  const ctx = {
    store,
    issueStore: { sync: () => {} },
    getWindow: () => null,
    publishIssueUpdate: () => {},
    runner: {
      enqueue: () => {}, pushTask: () => {}, cancel: async () => ({ ok: true }),
      closeSession: async () => {}, forget: async () => {},
      followUp: async () => ({ ok: false }), resolvePermission: async () => ({ ok: false }),
      pendingPermissions: async () => []
    }
  }
  registerTaskIpc(ctx)
  const retry = await electron.handlers['tasks:retry'](null, gated.id)
  assert(retry.ok === false, '持门禁的单重跑被拒绝（实际 ' + JSON.stringify(retry) + '）')
  assert(/删除本单/.test(retry.error ?? ''), '拒绝带可行动提示（实际：' + (retry.error ?? '') + '）')
  const after = store.get(gated.id)
  assert(after.status === 'cancelled' && after.dispatchHold === true, '拒绝后单据原样保留（cancelled+门禁，实际 ' + after.status + '）')
  assert(store.updateIf(gated.id, { status: 'cancelled' }, { status: 'queued' }) === undefined, 'store 全库不变式：终态单更新回 queued 被落空拒绝')
  assert(store.list().every((t) => !(t.status === 'queued' && t.dispatchHold === true)), '场上不存在 queued+hold 组合')
  console.log('SCENARIO-OK')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(3) })
`

// 红9①｜核实异常按单捕获：旧代码（核实异常直接炸穿对账，无按单捕获）下
// 「单子单核实异常不中断对账 + 异常子单走具名失败路径 + 其余子单照常翻面」断言必红
const RED9_VERIFY = `
const path = require('path')
const fs = require('fs')
const os = require('os')
const { TaskStore } = require(__MUT_STORE__)
const { reconcileStartupTasks } = require(__MUT_HANDOFF__)
const assert = (cond, msg) => { if (!cond) { console.error('RED:' + msg); process.exit(3) } }
async function main() {
  const store = new TaskStore(fs.mkdtempSync(path.join(os.tmpdir(), 'mut-r9a-store-')))
  const source = store.create({ title: '阶段1', prompt: 'x', workdir: '', backend: 'fake' })
  store.update(source.id, { status: 'done', endedAt: Date.now() })
  const badChild = store.create({ title: '核实异常子单', prompt: 'x', workdir: 'wt-bad', backend: 'fake', parentTaskId: source.id, dispatchHold: true,
    worktree: { ownerTaskId: 'lost', repoDir: 'repo', path: 'wt-bad', branch: 'b', baseSha: 's', createdAt: Date.now(), cleanupStatus: 'active' } })
  const goodChild = store.create({ title: '无树子单', prompt: 'y', workdir: '', backend: 'fake', parentTaskId: source.id, dispatchHold: true })
  const enqueued = []
  let result
  try {
    result = await reconcileStartupTasks({
      store,
      pushEvent: () => {},
      enqueue: (task) => enqueued.push(task.id),
      notifyTaskChanged: () => {},
      bindWorktreeOwner: async (wtDir) => { if (wtDir === 'wt-bad') throw new Error('核实进程爆炸'); return true }
    })
  } catch (error) {
    console.error('RED:单个子单的核实异常炸掉整个启动对账（核实异常未按单捕获）：' + (error instanceof Error ? error.message : String(error)))
    process.exit(3)
  }
  assert(result.holdingTerminated.length === 1 && result.holdingResumed.length === 1,
    '对账整体走完：核实异常子单具名终态 1 单、无树子单照常翻面 1 单（实际 ' + result.holdingTerminated.length + '/' + result.holdingResumed.length + '）')
  const bad = store.get(badChild.id)
  assert(bad.status === 'cancelled' && bad.dispatchHold === true && (bad.error ?? '').includes('核实过程异常'),
    '核实异常子单按单捕获走具名失败路径（实际 ' + bad.status + '，错误：' + (bad.error ?? '无') + '）')
  assert(store.readEvents(badChild.id).some((e) => (e.text ?? '').includes('核实过程异常')), '核实异常在时间线具名留痕')
  const good = store.get(goodChild.id)
  assert(good.status === 'queued' && good.dispatchHold === undefined && enqueued.includes(goodChild.id),
    '单个子单的核实异常不拖累其余子单：无树子单照常翻面恢复派发（实际 ' + good.status + '）')
  assert(!store.list().some((t) => t.dispatchHold === true && t.status === 'queued'), '场上不存在 queued+hold 残留')
  console.log('SCENARIO-OK')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(3) })
`

// 红9①-b｜收场兜底按单捕获：旧代码（dispatchHold 子单收场写异常直接炸穿对账）下
// 「单子单落盘异常不拖垮对账、其余子单照常翻面、坏子单门禁原样保留」断言必红
const RED9_HOLD_WRITE = `
const path = require('path')
const fs = require('fs')
const os = require('os')
const { TaskStore } = require(__MUT_STORE__)
const { reconcileStartupTasks } = require(__MUT_HANDOFF__)
const assert = (cond, msg) => { if (!cond) { console.error('RED:' + msg); process.exit(3) } }
async function main() {
  const store = new TaskStore(fs.mkdtempSync(path.join(os.tmpdir(), 'mut-r9c-store-')))
  const source = store.create({ title: '阶段1', prompt: 'x', workdir: '', backend: 'fake' })
  store.update(source.id, { status: 'done', endedAt: Date.now() })
  const badChild = store.create({ title: '落盘异常子单', prompt: 'x', workdir: '', backend: 'fake', parentTaskId: source.id, dispatchHold: true })
  const goodChild = store.create({ title: '无树子单', prompt: 'y', workdir: '', backend: 'fake', parentTaskId: source.id, dispatchHold: true })
  // 只让坏子单的收场写抛异常（存储故障的最小夹具）：包裹 transaction 视图，坏单 update 即炸
  const realTransaction = store.transaction.bind(store)
  store.transaction = (fn) => realTransaction((tx) => {
    const realUpdate = tx.update.bind(tx)
    const wrapped = Object.create(tx)
    wrapped.update = (id, patch, expected) => {
      if (id === badChild.id) throw new Error('收场落盘爆炸')
      return realUpdate(id, patch, expected)
    }
    return fn(wrapped)
  })
  const enqueued = []
  let result
  try {
    result = await reconcileStartupTasks({
      store,
      pushEvent: () => {},
      enqueue: (task) => enqueued.push(task.id),
      notifyTaskChanged: () => {},
      bindWorktreeOwner: async () => true
    })
  } catch (error) {
    console.error('RED:单个子单的收场写异常炸掉整个启动对账（兜底按单捕获缺失）：' + (error instanceof Error ? error.message : String(error)))
    process.exit(3)
  }
  assert(result.holdingResumed.length === 1 && enqueued.includes(goodChild.id),
    '单子单落盘异常不拖垮对账：无树子单照常翻面入队（实际 resumed=' + result.holdingResumed.length + ', enqueued=' + enqueued.length + '）')
  const bad = store.get(badChild.id)
  assert(bad.status === 'queued' && bad.dispatchHold === true, '落盘失败的子单门禁原样保留待下轮对账（实际 ' + bad.status + '/hold=' + bad.dispatchHold + '）')
  console.log('SCENARIO-OK')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(3) })
`

// 红9②｜转投异常按单捕获：旧代码（转投异常直接炸穿对账）下「单领队转投异常不拖垮
// 其余领队，两个死领队都被接管」断言必红
const RED9_RELAY = `
const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawn } = require('child_process')
const { TaskStore } = require(__MUT_STORE__)
const { reconcileStartupTasks } = require(__MUT_HANDOFF__)
const { probeProcess } = require(__MUT_PERSISTENCE__)
const assert = (cond, msg) => { if (!cond) { console.error('RED:' + msg); process.exit(3) } }
async function deadOwner(token) {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true })
  let observed
  for (let i = 0; i < 120; i++) {
    observed = probeProcess(child.pid)
    if (observed.state === 'alive' && observed.instance) break
    await new Promise((r) => setTimeout(r, 50))
  }
  if (observed?.state !== 'alive' || !observed.instance) { child.kill(); throw new Error('cannot observe a dead execution identity') }
  child.kill()
  await new Promise((resolve) => child.on('exit', resolve))
  return { pid: child.pid, instance: observed.instance, token, leaseExpiresAt: Date.now() - 60000 }
}
async function main() {
  const store = new TaskStore(fs.mkdtempSync(path.join(os.tmpdir(), 'mut-r9b-store-')))
  const ownerA = await deadOwner('dead-a')
  const ownerB = await deadOwner('dead-b')
  const leaderA = store.create({ title: '中断领队A', prompt: 'a', workdir: '', backend: 'fake', issueId: 'iss_a' })
  const kidA = store.create({ title: '队员A', prompt: 'a1', workdir: '', backend: 'fake', parentTaskId: leaderA.id })
  store.update(kidA.id, { status: 'done', endedAt: Date.now(), result: 'A 的交付' })
  store.update(leaderA.id, { status: 'running', startedAt: Date.now(), runId: 'run_a', executionOwner: ownerA })
  const leaderB = store.create({ title: '中断领队B', prompt: 'b', workdir: '', backend: 'fake', issueId: 'iss_b' })
  const kidB = store.create({ title: '队员B', prompt: 'b1', workdir: '', backend: 'fake', parentTaskId: leaderB.id })
  store.update(kidB.id, { status: 'done', endedAt: Date.now(), result: 'B 的交付' })
  store.update(leaderB.id, { status: 'running', startedAt: Date.now(), runId: 'run_b', executionOwner: ownerB })
  let result
  try {
    result = await reconcileStartupTasks({
      store,
      pushEvent: () => {},
      enqueue: () => {},
      notifyTaskChanged: () => {},
      relayInterruptedLeader: (stale) => { if (stale.id === leaderA.id) throw new Error('转投通道爆炸') }
    })
  } catch (error) {
    console.error('RED:单个领队的转投异常炸掉整个启动对账（转投异常未按单捕获）：' + (error instanceof Error ? error.message : String(error)))
    process.exit(3)
  }
  const recoveredIds = result.recovered.map((task) => task.id)
  assert(recoveredIds.includes(leaderA.id) && recoveredIds.includes(leaderB.id),
    '转投异常按单捕获：领队A 的转投失败不拖垮对账，两个死领队都被接管（实际 ' + recoveredIds.length + ' 个）')
  console.log('SCENARIO-OK')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(3) })
`

// 红9③｜index 总兜底：旧代码（对账调用不包 try/catch）下「编译产物存在『启动对账失败』
// 降级路径」断言必红——启动对账跑在窗口/IPC 之前，绝不允许它把启动炸掉
const RED9_INDEX = `
const fs = require('fs')
const assert = (cond, msg) => { if (!cond) { console.error('RED:' + msg); process.exit(3) } }
function main() {
  const indexBundle = fs.readFileSync(__MUT_INDEX__, 'utf8')
  assert(indexBundle.includes('启动对账失败'),
    'index 总兜底在编译产物中存在：启动对账失败必须降级为「应用继续启动、遗留任务保留可手动处理」，不得让对账异常炸掉应用启动（编译产物中不存在「启动对账失败」降级路径）')
  console.log('SCENARIO-OK')
  process.exit(0)
}
main()
`

// 红10｜任务侧独立世代证据：旧代码（缺任务世代时退回磁盘元数据自证）下「同名删树重建后旧残单不翻面入队」断言必红
const RED10 = `
${PRELUDE}
const { createWorktree, setWorktreeOwner } = require(__MUT_GIT__)
const { reconcileStartupTasks } = require(__MUT_HANDOFF__)
async function main() {
  const { repo, git } = makeRepo('mut-r10-')
  const wtFirst = await createWorktree(repo, 'mut-r10-wt', 'main', 'seed-owner')
  assert(!!wtFirst, '前置：真实托管 worktree 建成')
  const firstGen = wtFirst.metadata.generationId
  // 同名删树重建：目录/Git 注册/sidecar/分支全清后按同名重建——磁盘是世代不同的新树，
  // sidecar 的 owner/分支/路径与旧登记完全一致（世代自证缺口正在这里）
  fs.rmSync(wtFirst.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  fs.rmSync(path.join(repo, '.git', 'worktrees', 'mut-r10-wt'), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  fs.rmSync(path.join(repo, '.agentdeck-worktrees', '.metadata', 'mut-r10-wt.json'), { force: true })
  git('worktree', 'prune')
  git('branch', '-D', 'agentdeck/mut-r10-wt')
  const wtSecond = await createWorktree(repo, 'mut-r10-wt', 'main', 'seed-owner')
  assert(!!wtSecond && wtSecond.path === wtFirst.path && wtSecond.metadata.generationId !== firstGen, '前置：同名重建得到同位不同世代的树')
  const store = new TaskStore(fs.mkdtempSync(path.join(os.tmpdir(), 'mut-r10-store-')))
  const source = store.create({ title: '阶段1', prompt: 'x', workdir: '', backend: 'fake' })
  store.update(source.id, { status: 'done', endedAt: Date.now() })
  // 旧版快照残单：登记不带世代，owner/分支/路径与重建后的磁盘完全一致
  const child = store.create({ title: '同名重建残单', prompt: 'x', workdir: wtSecond.path, backend: 'fake', parentTaskId: source.id, dispatchHold: true,
    worktree: Object.assign({}, wtFirst.metadata, { generationId: undefined }) })
  const enqueued = []
  const result = await reconcileStartupTasks({
    store,
    pushEvent: () => {},
    enqueue: (task) => enqueued.push(task.id),
    notifyTaskChanged: () => {},
    bindWorktreeOwner: (wtDir, ownerTaskId, expected) => setWorktreeOwner(wtDir, ownerTaskId, expected)
  })
  assert(result.holdingTerminated.length === 1 && result.holdingResumed.length === 0,
    '缺任务侧独立世代证据的旧残单必须具名终态、不得认领同名新树（实际 terminated=' + result.holdingTerminated.length + ', resumed=' + result.holdingResumed.length + '）')
  assert(enqueued.length === 0, '绝不把旧残单派发到重建后的陌生新树上（实际入队 ' + enqueued.length + ' 单）')
  const after = store.get(child.id)
  assert(after.status === 'cancelled' && after.dispatchHold === true, '门禁保持 + 具名终态（实际 ' + after.status + '）')
  console.log('SCENARIO-OK')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(3) })
`

// 红11①世代｜改绑世代相等守卫：旧代码（sidecar 登记世代只验在场不验与任务证据相等）
// 下「登记世代与任务证据分叉必须拒绝改绑」断言必红。夹具构造登记世代与磁盘世代标记
// 分叉的现场（sidecar 残旧/被改写）：磁盘世代标记=出生世代、世代之外的证据全部吻合，
// 世代相等守卫是唯一拦得住它的检查。
const RED11_GEN = `
${PRELUDE}
const { createWorktree, setWorktreeOwner } = require(__MUT_GIT__)
async function main() {
  const { repo } = makeRepo('mut-r11-gen-')
  const wt = await createWorktree(repo, 'mut-r11-gen', 'main', 'leader-1')
  assert(!!wt, '前置：托管树建成')
  // 登记世代分叉：sidecar 写成陌生世代，磁盘世代标记保持出生世代（世代之外证据全吻合）
  const sidecar = path.join(repo, '.agentdeck-worktrees', '.metadata', 'mut-r11-gen.json')
  const tampered = JSON.parse(fs.readFileSync(sidecar, 'utf8'))
  tampered.generationId = 'gen-tampered-not-the-birth-generation'
  fs.writeFileSync(sidecar, JSON.stringify(tampered, null, 2))
  const bound = await setWorktreeOwner(wt.path, 'child-1', { generationId: wt.metadata.generationId, ownerTaskId: 'leader-1', branch: wt.metadata.branch })
  assert(bound === false, '世代守卫：登记世代与任务证据不一致必须拒绝改绑（实际 ' + bound + '）')
  const after = JSON.parse(fs.readFileSync(sidecar, 'utf8'))
  assert(after.ownerTaskId === 'leader-1', '拒绝改绑后磁盘 owner 不被改写（实际 ' + after.ownerTaskId + '）')
  console.log('SCENARIO-OK')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(3) })
`

// 红11②owner｜改绑出生 owner 守卫：旧代码（不核对磁盘 owner 与出生/目标 owner）下
// 「陌生调用方凭吻合的世代+分支证据不能抢走他人树」断言必红。夹具走纯库内操作：
// 合法交接一次后，磁盘 owner 既非出生 owner 也非陌生认领方。
const RED11_OWNER = `
${PRELUDE}
const { createWorktree, setWorktreeOwner } = require(__MUT_GIT__)
async function main() {
  const { repo } = makeRepo('mut-r11-own-')
  const wt = await createWorktree(repo, 'mut-r11-own', 'main', 'leader-1')
  assert(!!wt, '前置：托管树建成')
  const birth = { generationId: wt.metadata.generationId, ownerTaskId: 'leader-1', branch: wt.metadata.branch }
  const legit = await setWorktreeOwner(wt.path, 'child-1', birth)
  assert(legit === true, '前置：出生 owner 交接成立')
  const stolen = await setWorktreeOwner(wt.path, 'child-2', birth)
  assert(stolen === false, 'owner 守卫：磁盘 owner 既非出生 owner 也非目标 owner 必须拒绝改绑（实际 ' + stolen + '）')
  const after = JSON.parse(fs.readFileSync(path.join(repo, '.agentdeck-worktrees', '.metadata', 'mut-r11-own.json'), 'utf8'))
  assert(after.ownerTaskId === 'child-1', '陌生认领被拒后磁盘 owner 不被改写（实际 ' + after.ownerTaskId + '）')
  console.log('SCENARIO-OK')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(3) })
`

// 红11③分支｜改绑出生分支守卫：旧代码（登记核实不比对出生分支）下「池化复用换分支后
// 旧任务携原世代+原出生 owner 认领换 branch 后的树必须拒绝」断言必红。夹具：同一领队
// 先后两次派单复用同一棵树（磁盘 owner 恰为出生 owner、世代保留）——分支守卫是唯一
// 拦得住旧任务认领的检查。
const RED11_BRANCH = `
${PRELUDE}
const { createWorktree, reclaimWorktree, setWorktreeOwner } = require(__MUT_GIT__)
async function main() {
  const { repo } = makeRepo('mut-r11-br-')
  const wtFirst = await createWorktree(repo, 'mut-r11-br', 'main', 'leader-1')
  assert(!!wtFirst, '前置：托管树建成')
  const birthBranch = wtFirst.metadata.branch
  const repooled = await reclaimWorktree(wtFirst.path, { repool: true, expectedOwnerTaskId: 'leader-1', expectedGenerationId: wtFirst.metadata.generationId })
  assert(repooled.ok === true && repooled.status === 'pooled', '前置：树归还复用池')
  const wtSecond = await createWorktree(repo, 'mut-r11-br-next', 'main', 'leader-1')
  assert(!!wtSecond && wtSecond.pooled === true && wtSecond.path === wtFirst.path, '前置：同一领队复用同一棵树')
  assert(wtSecond.metadata.generationId === wtFirst.metadata.generationId, '前置：世代保留（单靠世代无法排他）')
  assert(wtSecond.metadata.branch !== birthBranch, '前置：池化复用换分支')
  const claimed = await setWorktreeOwner(wtFirst.path, 'stale-child', { generationId: wtFirst.metadata.generationId, ownerTaskId: 'leader-1', branch: birthBranch })
  assert(claimed === false, '分支守卫：旧任务携原世代+原出生 owner 认领换 branch 后的树必须拒绝（实际 ' + claimed + '）')
  const after = JSON.parse(fs.readFileSync(path.join(repo, '.agentdeck-worktrees', '.metadata', 'mut-r11-br.json'), 'utf8'))
  assert(after.ownerTaskId === 'leader-1' && after.branch === wtSecond.metadata.branch, '复用现场的 owner/分支不被旧任务改写（实际 ' + after.ownerTaskId + ' / ' + after.branch + '）')
  console.log('SCENARIO-OK')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(3) })
`

// 红11④-a 可绑定｜pooled 状态守卫：旧代码（不核对 sidecar 的池 owner/pooled 状态）下
// 「sidecar 仍挂 pooled 的树不能被改绑抢走」断言必红。夹具构造崩溃窗口：进程内池登记
// 已丢（清空注册表），sidecar 却还挂着 pooled 且 owner 写回出生值——owner/世代/分支
// 证据全部吻合，pooled 状态守卫是唯一拦得住它的检查。
const RED11_POOL_STATUS = `
${PRELUDE}
const { createWorktree, reclaimWorktree, setWorktreeOwner, clearWorktreePool, worktreePoolEntriesForTest } = require(__MUT_GIT__)
async function main() {
  const { repo } = makeRepo('mut-r11-pa-')
  const wt = await createWorktree(repo, 'mut-r11-pa', 'main', 'leader-1')
  assert(!!wt, '前置：托管树建成')
  const generationId = wt.metadata.generationId
  const birthBranch = wt.metadata.branch
  const repooled = await reclaimWorktree(wt.path, { repool: true, expectedOwnerTaskId: 'leader-1', expectedGenerationId: generationId })
  assert(repooled.ok === true && repooled.status === 'pooled', '前置：树归还复用池（detach+池登记）')
  clearWorktreePool()
  assert(worktreePoolEntriesForTest(repo).length === 0, '前置：进程内池登记已清空（pooled 状态守卫是唯一拦截）')
  // 崩溃窗口分叉：注册表已丢，sidecar 仍挂 pooled；owner 写回出生 owner 以绕过 owner 守卫
  const sidecar = path.join(repo, '.agentdeck-worktrees', '.metadata', 'mut-r11-pa.json')
  const restored = JSON.parse(fs.readFileSync(sidecar, 'utf8'))
  restored.ownerTaskId = 'leader-1'
  fs.writeFileSync(sidecar, JSON.stringify(restored, null, 2))
  const git = (...args) => execFileSync('git', ['-C', wt.path, ...args], { encoding: 'utf8' })
  git('switch', birthBranch)
  const bound = await setWorktreeOwner(wt.path, 'child-1', { generationId, ownerTaskId: 'leader-1', branch: birthBranch })
  assert(bound === false, 'pooled 状态守卫：sidecar 仍挂 pooled（进程内池登记已不在）的树必须拒绝改绑（实际 ' + bound + '）')
  const after = JSON.parse(fs.readFileSync(sidecar, 'utf8'))
  assert(after.ownerTaskId === 'leader-1' && after.cleanupStatus === 'pooled', '拒绝改绑后 sidecar 的 owner/pooled 状态不被改写（实际 ' + after.ownerTaskId + '/' + after.cleanupStatus + '）')
  console.log('SCENARIO-OK')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(3) })
`

// 红11④-b 可绑定｜进程内池登记守卫：旧代码（不核对进程内池注册表）下「仍登记在池的树
// 不能被改绑抢走」断言必红。夹具走反向崩溃窗口：sidecar 已恢复出生模样（owner 写回 +
// cleanupStatus 翻回 active）、目录重挂出生分支，树却仍在进程内池注册表里——登记守卫
// 是唯一拦得住它的检查。
const RED11_POOL_REGISTRY = `
${PRELUDE}
const { createWorktree, reclaimWorktree, setWorktreeOwner, worktreePoolEntriesForTest } = require(__MUT_GIT__)
async function main() {
  const { repo } = makeRepo('mut-r11-pb-')
  const wt = await createWorktree(repo, 'mut-r11-pb', 'main', 'leader-1')
  assert(!!wt, '前置：托管树建成')
  const generationId = wt.metadata.generationId
  const birthBranch = wt.metadata.branch
  const repooled = await reclaimWorktree(wt.path, { repool: true, expectedOwnerTaskId: 'leader-1', expectedGenerationId: generationId })
  assert(repooled.ok === true && repooled.status === 'pooled', '前置：树归还复用池（detach+池登记）')
  assert(worktreePoolEntriesForTest(repo).length === 1, '前置：池注册表在案')
  // 反向崩溃窗口：sidecar 完全恢复出生模样，三证据全吻合——只有进程内池登记拦得住
  const sidecar = path.join(repo, '.agentdeck-worktrees', '.metadata', 'mut-r11-pb.json')
  const restored = JSON.parse(fs.readFileSync(sidecar, 'utf8'))
  restored.ownerTaskId = 'leader-1'
  restored.cleanupStatus = 'active'
  fs.writeFileSync(sidecar, JSON.stringify(restored, null, 2))
  const git = (...args) => execFileSync('git', ['-C', wt.path, ...args], { encoding: 'utf8' })
  git('switch', birthBranch)
  const bound = await setWorktreeOwner(wt.path, 'child-1', { generationId, ownerTaskId: 'leader-1', branch: birthBranch })
  assert(bound === false, '池登记守卫：树仍在进程内池注册表（sidecar 已翻回 active）时必须拒绝改绑（实际 ' + bound + '）')
  assert(worktreePoolEntriesForTest(repo).length === 1, '拒绝后池登记原样保留（实际 ' + worktreePoolEntriesForTest(repo).length + ' 条）')
  const after = JSON.parse(fs.readFileSync(sidecar, 'utf8'))
  assert(after.ownerTaskId === 'leader-1', '拒绝改绑后池树 owner 不被改写（实际 ' + after.ownerTaskId + '）')
  console.log('SCENARIO-OK')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(3) })
`

// 红12｜残缺登记不免检：旧代码（有 worktree 记录但 path 为空即按无树免检翻面）下「空 path 残单不进派发队列」断言必红
const RED12 = `
const path = require('path')
const fs = require('fs')
const os = require('os')
const { TaskStore } = require(__MUT_STORE__)
const { reconcileStartupTasks } = require(__MUT_HANDOFF__)
const assert = (cond, msg) => { if (!cond) { console.error('RED:' + msg); process.exit(3) } }
async function main() {
  const store = new TaskStore(fs.mkdtempSync(path.join(os.tmpdir(), 'mut-r12-store-')))
  const source = store.create({ title: '阶段1', prompt: 'x', workdir: '', backend: 'fake' })
  store.update(source.id, { status: 'done', endedAt: Date.now() })
  const broken = store.create({ title: '空路径残单', prompt: 'x', workdir: '', backend: 'fake', parentTaskId: source.id, dispatchHold: true,
    worktree: { ownerTaskId: 'lost', repoDir: 'repo', path: '', branch: 'b', baseSha: 's', createdAt: Date.now(), cleanupStatus: 'active' } })
  const noTree = store.create({ title: '无树子单', prompt: 'y', workdir: '', backend: 'fake', parentTaskId: source.id, dispatchHold: true })
  const enqueued = []
  const result = await reconcileStartupTasks({
    store,
    pushEvent: () => {},
    enqueue: (task) => enqueued.push(task.id),
    notifyTaskChanged: () => {},
    bindWorktreeOwner: async () => true
  })
  assert(result.holdingTerminated.length === 1 && result.holdingResumed.length === 1,
    '空路径残缺登记归具名终态、无树子单照常翻面（实际 ' + result.holdingTerminated.length + '/' + result.holdingResumed.length + '）')
  assert(!enqueued.includes(broken.id), '空路径残单不进派发队列')
  const after = store.get(broken.id)
  assert(after.status === 'cancelled' && after.dispatchHold === true && (after.error ?? '').includes('登记残缺'),
    '空路径残单具名终态并点明登记残缺（实际 ' + after.status + '，错误：' + (after.error ?? '无') + '）')
  assert(store.get(noTree.id).status === 'queued' && enqueued.includes(noTree.id), '无树子单不受牵连照常恢复派发')
  console.log('SCENARIO-OK')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(3) })
`

// 红13｜树名标记按平台折叠（detach 守卫）：旧代码（字面量 startsWith 吃原始写法）下
// 「重挂分支的 detach 脚手架按同树别名写法回收同样被拒、目录存活」断言必红——别名
// 拼写判不中树名标记会让 detach 守卫落空，重挂的树被连目录强删。别名用同树形态
//（x<sep>..<sep> 解析回原目录）：POSIX 目录名大小写敏感，大小写别名是另一棵树，
// 同树别名形态两平台通用
const RED13 = `
${PRELUDE}
const { reclaimWorktree } = require(__MUT_GIT__)
async function main() {
  const { repo, git } = makeRepo('mut-r13-')
  // mergeIntoManagedWorktreeDetached 的落盘形态：detach 脚手架 + 世代标记 + sidecar
  const scaffoldName = '.agentdeck-merge-detach-r13'
  const scaffoldBranch = 'agentdeck/task-r13-integrated'
  const scaffoldPath = path.join(repo, '.agentdeck-worktrees', scaffoldName)
  const aliasSpelling = scaffoldPath + path.sep + 'alias' + path.sep + '..'
  assert(path.resolve(aliasSpelling) === scaffoldPath && aliasSpelling !== scaffoldPath, '前置：别名写法解析回同树且拼写不同')
  git('branch', scaffoldBranch, 'main')
  execFileSync('git', ['-C', repo, 'worktree', 'add', '--detach', scaffoldPath, scaffoldBranch], { stdio: 'ignore' })
  const pointer = fs.readFileSync(path.join(scaffoldPath, '.git'), 'utf8')
  const gitdir = path.resolve(scaffoldPath, /^gitdir:\\s*(.+?)\\s*$/im.exec(pointer)[1])
  const generation = 'mut-r13-generation'
  fs.writeFileSync(path.join(gitdir, 'agentdeck-generation'), generation + '\\n')
  fs.mkdirSync(path.join(repo, '.agentdeck-worktrees', '.metadata'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.agentdeck-worktrees', '.metadata', scaffoldName + '.json'), JSON.stringify({
    ownerTaskId: scaffoldName, generationId: generation, repoDir: repo, path: scaffoldPath,
    branch: scaffoldBranch, baseSha: git('rev-parse', scaffoldBranch), createdAt: Date.now(), cleanupStatus: 'active'
  }))
  // 重挂分支：detach 树内检出集成分支（attached HEAD）——detach 守卫的唯一拦截对象
  git('-C', scaffoldPath, 'switch', scaffoldBranch)
  const canonicalRefused = await reclaimWorktree(scaffoldPath, { force: true, expectedOwnerTaskId: scaffoldName, expectedGenerationId: generation })
  assert(canonicalRefused.ok === false && canonicalRefused.status === 'retained' && (canonicalRefused.reason ?? '').includes('no longer detached'),
    '字面量写法拒绝重挂分支的 detach 脚手架（实际 ' + canonicalRefused.status + ': ' + (canonicalRefused.reason ?? '') + '）')
  assert(fs.existsSync(scaffoldPath), '字面量拒绝后目录存活')
  const aliasRefused = await reclaimWorktree(aliasSpelling, { force: true, expectedOwnerTaskId: scaffoldName, expectedGenerationId: generation })
  assert(aliasRefused.ok === false && aliasRefused.status === 'retained' && (aliasRefused.reason ?? '').includes('no longer detached'),
    '同树别名写法同样拒绝回收重挂分支的 detach 脚手架（实际 ' + aliasRefused.status + ': ' + (aliasRefused.reason ?? '') + '）')
  assert(fs.existsSync(scaffoldPath), '别名拒绝后目录必须存活（守卫落空会被连目录强删）')
  console.log('SCENARIO-OK')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(3) })
`

// 红14｜验收器盘符根：旧代码（根键无脑再拼第二个 sep）下「盘符根 workdir 界内目标
// 判界内且存在」断言必红——c:\\file 不以 c:\\\\ 为前缀，界内文件全被误判到界外
const RED14 = `
const path = require('path')
const fs = require('fs')
const os = require('os')
const { verifyAcceptance, isInsidePathKey } = require(__MUT_VERIFY__)
const assert = (cond, msg) => { if (!cond) { console.error('RED:' + msg); process.exit(3) } }
async function main() {
  const boundary = fs.mkdtempSync(path.join(os.tmpdir(), 'mut-r14-'))
  const rootWorkdir = path.parse(boundary).root
  const inside = verifyAcceptance(
    { workdir: rootWorkdir, acceptanceCriteria: [{ id: 'inside', text: 'path exists: ' + boundary, status: 'pending' }] },
    { workdir: rootWorkdir, gitDiff: '' }
  )
  assert(inside[0].passed === true, '盘符根 workdir 下界内目标必须判界内且存在（实际 passed=' + inside[0].passed + '）')
  // 界外：判定函数输出直断（可观测夹具，不依赖第二块盘——界外路径不必真实存在）。
  // 盘符根本就自带分隔符，变异（无脑拼第二个 sep）对该断言无感，红证由界内断言承担，
  // 界外断言守「归属判定不得越出根」的语义不被改坏；POSIX 文件系统根只有一个，无界外
  if (path.parse(rootWorkdir).root !== path.sep) {
    const otherRootProbe = rootWorkdir.toUpperCase() === 'C:\\\\' ? 'Q:\\\\mut-r14-out\\\\probe' : 'C:\\\\mut-r14-out\\\\probe'
    assert(isInsidePathKey(otherRootProbe, rootWorkdir) === false, '盘符根 workdir 下另一根的目标判定函数必须判界外（不依赖该路径真实存在）')
  }
  const otherDrive = 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((letter) => letter + ':\\\\').find((driveRoot) => driveRoot.toUpperCase() !== rootWorkdir.toUpperCase() && fs.existsSync(driveRoot))
  if (otherDrive) {
    const outside = verifyAcceptance(
      { workdir: rootWorkdir, acceptanceCriteria: [{ id: 'outside', text: 'path exists: ' + path.join(otherDrive, 'probe'), status: 'pending' }] },
      { workdir: rootWorkdir, gitDiff: '' }
    )
    assert(outside[0].passed === false, '盘符根 workdir 下另一块真实存在的盘必须判界外（不得越界放行）')
  }
  console.log('SCENARIO-OK')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(3) })
`

// 红15｜删单回收去重：旧代码（字面量 Map 键）下「同一棵树的双别名写法只回收一次、
// 保留首个原始写法与它自己的 owner」断言必红——字面量键会对同树发起两次并发回收
const RED15 = `
const path = require('path')
const fs = require('fs')
const os = require('os')
const electron = require('electron')
const { collectWorktreeReclaims } = require(__MUT_TASKS__)
const assert = (cond, msg) => { if (!cond) { console.error('RED:' + msg); process.exit(3) } }
const flip = (p) => {
  const sepIndex = p.indexOf(path.sep)
  const head = p.slice(0, sepIndex)
  const flipped = head[0] === head[0].toLowerCase() ? head[0].toUpperCase() + head.slice(1) : head[0].toLowerCase() + head.slice(1)
  return flipped + p.slice(sepIndex)
}
async function main() {
  const realPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mut-r15-')), '.agentdeck-worktrees', 'wt_c1')
  assert(collectWorktreeReclaims([{ id: 'a', workdir: realPath }, { id: 'b', workdir: realPath }]).length === 1, '基线：完全相同写法折叠成一条')
  if (process.platform === 'win32') {
    const aliasPath = flip(realPath)
    assert(aliasPath !== realPath && aliasPath.toLowerCase() === realPath.toLowerCase(), '前置：别名写法仅大小写不同')
    const deduped = collectWorktreeReclaims([
      { id: 'leader', workdir: '', worktree: { path: realPath, ownerTaskId: 'leader' } },
      { id: 'child', workdir: aliasPath }
    ])
    assert(deduped.length === 1, '同一棵树的双别名写法只回收一次（实际 ' + deduped.length + ' 条，字面量 Map 键会发两次并发回收）')
    assert(deduped[0].worktreePath === realPath && deduped[0].ownerTaskId === 'leader', '折叠保留首个原始写法与它自己的 owner（实际 ' + JSON.stringify(deduped[0]) + '）')
  }
  console.log('SCENARIO-OK')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(3) })
`

// 红16｜可执行路径比较按平台：旧代码（无条件精确比较的变异形态）下「win32 别名写法
// 判等」断言必红——别名 command 判不等会漏打 ELECTRON_RUN_AS_NODE 兜底
const RED16 = `
const path = require('path')
const { sameExecutablePath } = require(__MUT_CLICOMMON__)
const assert = (cond, msg) => { if (!cond) { console.error('RED:' + msg); process.exit(3) } }
const flip = (p) => {
  const sepIndex = p.indexOf(path.sep)
  const head = p.slice(0, sepIndex)
  const flipped = head[0] === head[0].toLowerCase() ? head[0].toUpperCase() + head.slice(1) : head[0].toLowerCase() + head.slice(1)
  return flipped + p.slice(sepIndex)
}
async function main() {
  if (process.platform !== 'win32') { console.log('SCENARIO-OK'); process.exit(0) }
  const alias = flip(process.execPath)
  assert(alias !== process.execPath, '前置：别名写法与真实写法不同')
  assert(sameExecutablePath(alias, process.execPath) === true, 'win32 下可执行路径别名写法必须判等（实际 false：ELECTRON_RUN_AS_NODE 兜底会漏打）')
  assert(sameExecutablePath(process.execPath, process.execPath) === true, '完全相同写法判等')
  console.log('SCENARIO-OK')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(3) })
`

const MUTATIONS = [
  {
    name: '红1｜建单门禁：旧代码（无 holding；绑定失败直接撤销）下「让位不撤销」断言必红',
    mutations: [
      {
        file: 'src/main/runner.ts',
        find: '      // 建单门禁：子单自创建起对调度器不可见（holding），归属绑定+登记核实三步全过才翻面入队\n      dispatchHold: true\n',
        replace: ''
      },
      {
        file: 'src/main/scheduler.ts',
        find: "task.status === 'queued' && !task.parked && !task.dispatchHold && task.gitOperation === undefined",
        replace: "task.status === 'queued' && !task.parked && task.gitOperation === undefined"
      },
      {
        file: 'src/main/runner.ts',
        find: "      const bound = await setWorktreeOwner(worktree.path, child.id, worktree)\n      if (!bound) {\n        return this.closeSpawnedChild(taskId, child, call, expected, 'worktree 归属绑定失败', taskId)\n      }",
        replace: "      const bound = await setWorktreeOwner(worktree.path, child.id, worktree)\n      if (!bound) {\n        await this.cancel(child.id)\n        return null\n      }"
      }
    ],
    scenario: RED1,
    expectedRed: '让位后跑到终态'
  },
  {
    name: '红2｜cancelled 误合入：旧代码（终态 commitAll 含 cancelled + 集成遍历不排除 cancelled）下「半成品零合入」断言必红',
    mutations: [
      {
        file: 'src/main/delegate.ts',
        find: "      if (!c?.worktree || !c.workdir || (c.status !== 'done' && c.status !== 'failed')) continue",
        replace: "      if (!c?.worktree || !c.workdir || (c.status !== 'done' && c.status !== 'failed' && c.status !== 'cancelled')) continue"
      },
      {
        file: 'src/main/delegate.ts',
        find: "          // cancelled 收编单只留终局回执：用户取消的半成品不进集成分支、现场不清理\n          //（恢复「cancelled 现场保持原样交人工」契约——不 merge、不 commitAll、不回收，\n          // 半成品改动以未提交状态留在其 worktree，交由保留判定与人工处理）。\n          if (c.status === 'cancelled') continue",
        replace: ''
      }
    ],
    scenario: RED2,
    expectedRed: '半成品零合入'
  },
  {
    name: '红4｜嗅探暂停缓冲：旧代码（suspended 早退不清缓冲）下「不持续占内存」断言必红',
    mutations: [
      {
        file: 'src/main/runner.ts',
        find: '    if (state.suspended) {\n      releaseSuspendedBuffer()\n      return\n    }',
        replace: '    if (state.suspended) return'
      }
    ],
    scenario: RED4,
    expectedRed: '不持续占内存'
  },
  {
    name: '红5｜收口撤销竞态：旧代码（无条件 cancel、不看撤销结果就 force 回收）下「撤销落空让位零回收」断言必红',
    mutations: [
      {
        file: 'src/main/runner.ts',
        find: '    const cancelled = this.store.updateIf(latest.id, { status: \'queued\', runId: latest.runId, executionOwner: latest.executionOwner, dispatchHold: true }, { status: \'cancelled\', endedAt: Date.now() })\n    if (!cancelled) {\n      const claimed = this.store.get(latest.id)\n      this.note(taskId, `⚠ ${why}，但子单「${claimed?.title ?? latest.title}」已被领取（${claimed?.status ?? \'已删除\'}）——让位交还当前执行，不撤销不回收`, expected)\n      return claimed ?? null\n    }\n    this.pushTask(latest.id)',
        replace: '    await this.cancel(child.id)'
      }
    ],
    scenario: RED5,
    expectedRed: '误导拒单'
  },
  {
    name: '红6｜holding 崩溃收场：旧代码（无 dispatchHold 单独收场，残单永久悬挂）下「翻面派发/具名终态」断言必红',
    mutations: [
      {
        file: 'src/main/handoff.ts',
        find: "  for (const stale of store.list().filter((task) => task.dispatchHold === true && task.status === 'queued')) {",
        replace: '  for (const stale of store.list().filter(() => false)) {'
      }
    ],
    scenario: RED6,
    expectedRed: '恢复派发 1 单'
  },
  {
    name: '红7｜磁盘归属核实真化：旧代码（找到元数据就改绑，不验目录/注册/世代）下「目录被清的残单不翻面派发」断言必红',
    mutations: [
      {
        file: 'src/main/git.ts',
        find: "  return withWorktreePathLock(wtDir, async () => {\n    if (!fs.existsSync(wtDir)) return false\n    const resolved = await resolveManagedWorktree(wtDir)\n    if (!resolved?.metadata) return false\n    const { repoDir, metadata } = resolved\n    if (!sameWorktreePath(metadata.repoDir, repoDir) || !sameWorktreePath(metadata.path, wtDir)) return false\n    if (!metadata.generationId || metadata.generationId !== generationId) return false\n    if (metadata.ownerTaskId === WORKTREE_POOL_OWNER || metadata.cleanupStatus === 'pooled') return false\n    if (worktreePoolByRepo.get(worktreePathKey(repoDir))?.has(worktreePathKey(wtDir))) return false\n    if (metadata.ownerTaskId !== expectedOwner && metadata.ownerTaskId !== ownerTaskId.trim()) return false\n    if (await verifyWorktreeGeneration(repoDir, wtDir, generationId, expectedBranch)) return false\n    try { updateMetadata(metadata, { ownerTaskId: ownerTaskId.trim() }) } catch { return false }\n    return true\n  })",
        replace: "  const resolved = await resolveManagedWorktree(wtDir)\n  if (!resolved?.metadata) return false\n  const { metadata } = resolved\n  try { updateMetadata(metadata, { ownerTaskId: ownerTaskId.trim() }) } catch { return false }\n  return true"
      }
    ],
    bundles: [{ src: 'src/main/git.ts', var: 'GIT' }],
    scenario: RED7,
    expectedRed: '不得翻面'
  },
  {
    name: '红8｜重跑僵尸根断：旧代码（retry 无门禁拒绝 + store 无全库不变式）下「持门禁单重跑不产生 queued+hold」断言必红',
    mutations: [
      {
        file: 'src/main/ipc/tasks.ts',
        find: "    // 重跑僵尸根断：持门禁的单（建单未完成，磁盘归属未核实）重跑回队即 queued+hold 僵尸\n    //（调度器永不可见）——拒绝原单重跑，给可行动提示；工作树核实后的重派由删单重派承担\n    if (task.dispatchHold === true) return { ok: false, error: '本单建单未完成（磁盘归属未核实），不能重新运行；请删除本单后重新委派' }",
        replace: ''
      },
      {
        file: 'src/main/store.ts',
        find: "          // 全库不变式：建单门禁（dispatchHold）只在建单时落一次（create 路径），此后任何\n          // 更新都不得把 queued+dispatchHold 组合「生产」出来——重跑/移动类补丁漏清门禁\n          // 造出的正是调度器永不可见、手动入口也领不动的僵尸。更新可以从该组合原样穿过\n          //（不触碰门禁的补丁），合成结果新出现该组合一律落空拒绝（与 updateIf 落空同规）。\n          const hasKey = (key: keyof Task) => Object.prototype.hasOwnProperty.call(patch, key)\n          const nextStatus = hasKey('status') ? patch.status : task.status\n          const nextHold = hasKey('dispatchHold') ? patch.dispatchHold : task.dispatchHold\n          if (nextStatus === 'queued' && nextHold === true && !(task.status === 'queued' && task.dispatchHold === true)) return undefined\n",
        replace: ''
      }
    ],
    bundles: [{ src: 'src/main/ipc/tasks.ts', var: 'TASKS' }],
    files: [
      ['node_modules/electron/index.js', "module.exports = {\n  handlers: {},\n  ipcMain: { handle: (channel, fn) => { module.exports.handlers[channel] = fn } },\n  BrowserWindow: { getAllWindows: () => [] }\n}\n"]
    ],
    scenario: RED8,
    expectedRed: '重跑被拒绝'
  },
  {
    // 单守卫变异①：内层「核实异常按单捕获」catch（核实异常→具名终态，不中断对账）
    name: '红9①-a｜核实异常按单捕获（内层守卫）：旧代码（核实异常炸穿收场、落进外层兜底）下「核实异常子单具名失败路径+其余子单照常翻面」断言必红',
    mutations: [
      {
        file: 'src/main/handoff.ts',
        find: "        } else {\n          try {\n            const bound = deps.bindWorktreeOwner\n              ? await deps.bindWorktreeOwner(stale.worktree.path, stale.id, stale.worktree)\n              : false\n            if (!bound) unverifiable = 'worktree 磁盘归属无法核实（目录缺失、Git 注册不在案或任务侧世代/归属/分支证据不符）'\n          } catch (error) {\n            unverifiable = `worktree 磁盘归属核实过程异常（${error instanceof Error ? error.message : String(error)}）`\n          }\n        }",
        replace: "        } else {\n          const bound = deps.bindWorktreeOwner\n            ? await deps.bindWorktreeOwner(stale.worktree.path, stale.id, stale.worktree)\n            : false\n          if (!bound) unverifiable = 'worktree 磁盘归属无法核实（目录缺失、Git 注册不在案或任务侧世代/归属/分支证据不符）'\n        }"
      }
    ],
    bundles: [{ src: 'src/main/persistence.ts', var: 'PERSISTENCE' }],
    scenario: RED9_VERIFY,
    expectedRed: '对账整体走完'
  },
  {
    // 单守卫变异②：外层「收场兜底按单捕获」try/catch（落盘异常→跳过该单继续对账）。
    // try{→{ 与 catch 块删除两处文本是同一守卫的两半（拆任何一半都是语法残肢），
    // 合并为这一枚单守卫变异。
    name: '红9①-b｜收场兜底按单捕获（外层守卫）：旧代码（dispatchHold 子单收场写异常直接炸穿对账）下「落盘异常子单不拖垮对账、其余子单照常翻面」断言必红',
    mutations: [
      {
        file: 'src/main/handoff.ts',
        find: '    try {\n      const captured: TaskExpectation = { ...taskIdentity(stale), parked: stale.parked, dispatchHold: true }',
        replace: '    {\n      const captured: TaskExpectation = { ...taskIdentity(stale), parked: stale.parked, dispatchHold: true }'
      },
      {
        file: 'src/main/handoff.ts',
        find: "    } catch (error) {\n      // 兜底按单捕获：这笔收场写不进去（存储异常等）只留日志继续对账其余子单，\n      // 门禁原样保留——绝不让单个子单的异常把整个启动对账炸掉\n      console.error('[startup-reconcile] dispatchHold 子单收场异常，跳过该单继续对账', stale.id, error)\n    }\n  }",
        replace: '    }\n  }'
      }
    ],
    bundles: [{ src: 'src/main/persistence.ts', var: 'PERSISTENCE' }],
    scenario: RED9_HOLD_WRITE,
    expectedRed: '收场写异常'
  },
  {
    name: '红9②｜转投异常按单捕获：旧代码（转投异常直接炸穿对账）下「单领队转投异常不拖垮其余领队，两个死领队都被接管」断言必红',
    mutations: [
      {
        file: 'src/main/handoff.ts',
        find: "    if (stale.issueId && kids.length) {\n      // 转投失败只属于这一个领队的收场：按单捕获留日志，不拖垮整个启动对账\n      try { deps.relayInterruptedLeader?.(stale, kids) } catch (error) {\n        console.error('[startup-reconcile] 中断领队的队员报告转投失败', stale.id, error)\n      }\n    }",
        replace: "    if (stale.issueId && kids.length) {\n      deps.relayInterruptedLeader?.(stale, kids)\n    }"
      }
    ],
    bundles: [{ src: 'src/main/persistence.ts', var: 'PERSISTENCE' }],
    scenario: RED9_RELAY,
    expectedRed: '转投异常'
  },
  {
    name: '红9③｜index 总兜底：旧代码（对账调用不包 try/catch）下「编译产物存在『启动对账失败』降级路径」断言必红',
    mutations: [
      {
        file: 'src/main/index.ts',
        find: '  try {\n    await reconcileStartupTasks({',
        replace: '  await reconcileStartupTasks({'
      },
      {
        file: 'src/main/index.ts',
        find: "  } catch (error) {\n    console.error('[startup] 启动对账失败（应用继续启动，遗留任务保留可手动处理）', error)\n  }",
        replace: ''
      }
    ],
    bundles: [{ src: 'src/main/index.ts', var: 'INDEX' }],
    scenario: RED9_INDEX,
    expectedRed: '启动对账失败'
  },
  {
    name: '红10｜任务侧独立世代证据：旧代码（缺任务世代时退回磁盘元数据自证）下「同名删树重建后旧残单不翻面入队」断言必红',
    mutations: [
      {
        file: 'src/main/git.ts',
        find: '  const generationId = expected.generationId?.trim()\n  if (!generationId) return false',
        replace: '  const generationId = expected.generationId?.trim()'
      },
      {
        file: 'src/main/git.ts',
        find: '    if (!metadata.generationId || metadata.generationId !== generationId) return false',
        replace: '    if (generationId && metadata.generationId !== generationId) return false'
      },
      {
        file: 'src/main/git.ts',
        find: '    if (await verifyWorktreeGeneration(repoDir, wtDir, generationId, expectedBranch)) return false',
        replace: '    if (await verifyWorktreeGeneration(repoDir, wtDir, generationId || metadata.generationId, expectedBranch)) return false'
      }
    ],
    bundles: [{ src: 'src/main/git.ts', var: 'GIT' }],
    scenario: RED10,
    expectedRed: '不得认领同名新树'
  },
  {
    name: '红11①世代｜改绑世代相等守卫：旧代码（sidecar 登记世代只验在场不验与任务证据相等）下「登记世代分叉仍改绑」断言必红',
    mutations: [
      {
        file: 'src/main/git.ts',
        find: '    if (!metadata.generationId || metadata.generationId !== generationId) return false',
        replace: '    if (!metadata.generationId) return false'
      }
    ],
    bundles: [{ src: 'src/main/git.ts', var: 'GIT' }],
    scenario: RED11_GEN,
    expectedRed: '不一致必须拒绝改绑'
  },
  {
    name: '红11②owner｜改绑出生 owner 守卫：旧代码（不核对磁盘 owner 与出生/目标 owner）下「陌生调用方抢走他人树」断言必红',
    mutations: [
      {
        file: 'src/main/git.ts',
        find: '    if (metadata.ownerTaskId !== expectedOwner && metadata.ownerTaskId !== ownerTaskId.trim()) return false',
        replace: ''
      }
    ],
    bundles: [{ src: 'src/main/git.ts', var: 'GIT' }],
    scenario: RED11_OWNER,
    expectedRed: '也非目标 owner 必须拒绝改绑'
  },
  {
    name: '红11④-a 可绑定｜pooled 状态守卫：旧代码（不核对 sidecar 的池 owner/pooled 状态）下「sidecar 仍挂 pooled 的树被改绑抢走」断言必红',
    mutations: [
      {
        file: 'src/main/git.ts',
        find: "    if (metadata.ownerTaskId === WORKTREE_POOL_OWNER || metadata.cleanupStatus === 'pooled') return false\n",
        replace: ''
      }
    ],
    bundles: [{ src: 'src/main/git.ts', var: 'GIT' }],
    scenario: RED11_POOL_STATUS,
    expectedRed: '必须拒绝改绑'
  },
  {
    name: '红11④-b 可绑定｜进程内池登记守卫：旧代码（不核对进程内池注册表）下「仍登记在池的树被改绑抢走」断言必红',
    mutations: [
      {
        file: 'src/main/git.ts',
        find: "    if (worktreePoolByRepo.get(worktreePathKey(repoDir))?.has(worktreePathKey(wtDir))) return false\n",
        replace: ''
      }
    ],
    bundles: [{ src: 'src/main/git.ts', var: 'GIT' }],
    scenario: RED11_POOL_REGISTRY,
    expectedRed: '必须拒绝改绑'
  },
  {
    name: '红11③分支｜改绑出生分支守卫：旧代码（登记核实不比对出生分支）下「池化复用换分支后旧任务携原世代认领」断言必红',
    mutations: [
      {
        file: 'src/main/git.ts',
        find: '    if (await verifyWorktreeGeneration(repoDir, wtDir, generationId, expectedBranch)) return false',
        replace: '    if (await verifyWorktreeGeneration(repoDir, wtDir, generationId)) return false'
      }
    ],
    bundles: [{ src: 'src/main/git.ts', var: 'GIT' }],
    scenario: RED11_BRANCH,
    expectedRed: '换 branch 后的树必须拒绝'
  },
  {
    name: '红12｜残缺登记不免检：旧代码（无 worktree 记录即免检翻面）下「空 path 残单不进派发队列」断言必红',
    mutations: [
      {
        file: 'src/main/handoff.ts',
        find: "      if (stale.worktree) {\n        // 残缺登记不免检：有 worktree 记录但 path 为空 = 身份证据残缺，归「无法核实」\n        // 具名终态——绝不因「看起来没有路径要核」就按无树子单翻面派发\n        if (!stale.worktree.path) {\n          unverifiable = 'worktree 登记残缺（路径为空），磁盘归属无法核实'\n        } else {",
        replace: '      if (stale.worktree?.path) {\n        {'
      }
    ],
    scenario: RED12,
    expectedRed: '空路径残缺登记归具名终态'
  },
  {
    name: '红13｜树名标记按平台折叠（detach 守卫）：旧代码（字面量 startsWith 吃原始写法）下「重挂分支的 detach 脚手架按同树别名写法回收同样被拒、目录存活」断言必红',
    mutations: [
      {
        file: 'src/main/git.ts',
        find: "  if (hasMergeScaffoldMarker(path.basename(path.resolve(wtPath)), MERGE_DETACH_SCAFFOLD_MARKER)) {",
        replace: "  if (path.basename(wtPath).startsWith('.agentdeck-merge-detach-')) {"
      }
    ],
    bundles: [{ src: 'src/main/git.ts', var: 'GIT' }],
    scenario: RED13,
    expectedRed: '同树别名写法同样拒绝回收'
  },
  {
    name: '红14｜验收器盘符根：旧代码（根键无脑再拼第二个 sep）下「盘符根 workdir 界内目标判界内且存在」断言必红',
    mutations: [
      {
        file: 'src/main/acceptance-verifier.ts',
        find: "  const rootPrefix = rootKey.endsWith(path.sep) ? rootKey : `${rootKey}${path.sep}`",
        replace: "  const rootPrefix = `${rootKey}${path.sep}`"
      }
    ],
    bundles: [{ src: 'src/main/acceptance-verifier.ts', var: 'VERIFY' }],
    scenario: RED14,
    expectedRed: '盘符根 workdir 下界内目标必须判界内且存在'
  },
  {
    name: '红15｜删单回收去重：旧代码（字面量 Map 键）下「同一棵树的双别名写法只回收一次、保留首个原始写法与 owner」断言必红',
    mutations: [
      {
        file: 'src/main/ipc/tasks.ts',
        find: "    const key = worktreePathKey(worktreePath)",
        replace: "    const key = worktreePath"
      }
    ],
    bundles: [{ src: 'src/main/ipc/tasks.ts', var: 'TASKS' }],
    files: [
      ['node_modules/electron/index.js', "module.exports = {\n  handlers: {},\n  ipcMain: { handle: (channel, fn) => { module.exports.handlers[channel] = fn } },\n  BrowserWindow: { getAllWindows: () => [] }\n}\n"]
    ],
    scenario: RED15,
    expectedRed: '只回收一次',
    // 平台不适配不构成红证：别名折叠去重仅 win32 适用，POSIX 字面量精确比较即正确行为
    platforms: ['win32'],
    skipReason: '别名折叠去重仅 win32 适用；POSIX 目录名大小写敏感，字面量键去重即正确行为'
  },
  {
    name: '红16｜可执行路径比较按平台：旧代码（不分平台精确比较）下「win32 别名写法判等」断言必红',
    mutations: [
      {
        file: 'src/main/backends/cli-common.ts',
        find: "  return process.platform === 'win32' ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase() : resolvedLeft === resolvedRight",
        replace: "  return resolvedLeft === resolvedRight"
      }
    ],
    bundles: [{ src: 'src/main/backends/cli-common.ts', var: 'CLICOMMON' }],
    scenario: RED16,
    expectedRed: 'win32 下可执行路径别名写法必须判等',
    // 平台不适配不构成红证：可执行路径别名折叠仅 win32 适用，POSIX 精确比较即正确行为
    platforms: ['win32'],
    skipReason: '可执行路径别名折叠仅 win32 适用；POSIX 文件系统大小写敏感，精确比较即正确行为'
  }
]

console.log('变异红测：每项修复回退为旧行为后，同一行为断言必须变红\n')
let failed = 0
for (const item of MUTATIONS) {
  // 平台不适配的红证显式跳过（带理由）：该平台语义上不存在旧病（如 POSIX 目录名
  // 大小写敏感，别名折叠本就不适用），不计入 expectedRed 要求
  if (item.platforms && !item.platforms.includes(process.platform)) {
    console.log(`== ${item.name}\n   SKIP（平台不适配：${item.skipReason}）——不计入红证`)
    continue
  }
  console.log('== ' + item.name)
  try {
    const tree = mutatedTree(item.mutations)
    for (const [relPath, content] of item.files ?? []) {
      const target = path.join(tree, relPath)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, content)
    }
    const result = await runScenario(tree, item.scenario, item.bundles ?? [], item.expectedRed)
    if (result.red) {
      console.log('  ✓ 红证成立：旧代码下预期断言失败 — ' + result.matched.replace('RED:', '').trim())
    } else if (result.output.split('\n').some((line) => line.includes('RED:'))) {
      console.error(result.output)
      console.error(`  ❌ 红证失败：场景变红了，但命中的不是本红证预期的断言（预期片段：${item.expectedRed}）——前置/无关断言误红不算红证`)
      failed++
    } else if (result.output.includes('SCENARIO-OK')) {
      console.error(result.output)
      console.error('  ❌ 红证失败：旧代码下断言竟然全绿（变异未触达该行为）')
      failed++
    } else {
      console.error(result.output)
      console.error('  ❌ 红证失败：场景异常退出且没有任何具名 RED: 断言命中（意外崩溃不算红证）')
      failed++
    }
  } catch (error) {
    console.error('  ❌ 红证执行异常：' + (error.message ?? String(error)))
    failed++
  }
}
if (failed) {
  console.error(`\n${failed} 个红证未成立`)
  process.exit(1)
}
console.log('\n✅ 全部变异红证成立：旧代码下断言确实失败，本轮修复真实生效')
process.exit(0)
