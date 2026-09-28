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

/** 用变异产物跑场景脚本：exit 0 = 断言全绿（红证失败）；exit 3 = 断言变红（红证成立） */
async function runScenario(tree, scenarioScript) {
  const runnerOut = path.join(tree, 'out-runner.cjs')
  const storeOut = path.join(tree, 'out-store.cjs')
  const handoffOut = path.join(tree, 'out-handoff.cjs')
  await bundle(tree, 'src/main/runner.ts', runnerOut)
  await bundle(tree, 'src/main/store.ts', storeOut)
  await bundle(tree, 'src/main/handoff.ts', handoffOut)
  const scriptFile = path.join(tree, 'scenario.cjs')
  fs.writeFileSync(scriptFile, scenarioScript
    .replace('__MUT_RUNNER__', JSON.stringify(runnerOut))
    .replace('__MUT_STORE__', JSON.stringify(storeOut))
    .replace('__MUT_HANDOFF__', JSON.stringify(handoffOut)))
  try {
    const stdout = execFileSync('node', [scriptFile], { encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] })
    return { red: false, output: stdout }
  } catch (error) {
    return { red: error.status === 3, output: (error.stdout ?? '') + (error.stderr ?? '') }
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
          setTimeout(() => runner.enqueue(child), 0)
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
        find: "      const bound = await setWorktreeOwner(worktree.path, child.id)\n      if (!bound) {\n        return this.closeSpawnedChild(taskId, child, call, expected, 'worktree 归属绑定失败', taskId)\n      }",
        replace: "      const bound = await setWorktreeOwner(worktree.path, child.id)\n      if (!bound) {\n        await this.cancel(child.id)\n        return null\n      }"
      }
    ],
    scenario: RED1
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
    scenario: RED2
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
    scenario: RED4
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
    scenario: RED5
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
    scenario: RED6
  }
]

console.log('变异红测：每项修复回退为旧行为后，同一行为断言必须变红\n')
let failed = 0
for (const item of MUTATIONS) {
  console.log('== ' + item.name)
  try {
    const tree = mutatedTree(item.mutations)
    const result = await runScenario(tree, item.scenario)
    if (result.red) {
      const firstRed = result.output.split('\n').find((line) => line.includes('RED:')) ?? ''
      console.log('  ✓ 红证成立：旧代码下断言失败 — ' + firstRed.replace('RED:', '').trim())
    } else {
      console.error(result.output)
      console.error('  ❌ 红证失败：旧代码下断言竟然全绿（变异未触达该行为）')
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
