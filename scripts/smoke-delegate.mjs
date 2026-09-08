// 委派循环冒烟：假后端领队（第1轮派2个，第2轮收尾）+ 真实 git worktree/集成
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { execSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
for (const [src, out] of [
  ['src/main/runner.ts', 'out/sd-runner.cjs'],
  ['src/main/store.ts', 'out/sd-store.cjs'],
  ['src/main/delegate.ts', 'out/sd-delegate.cjs']
]) {
  await build({ entryPoints: [path.join(root, src)], outfile: path.join(root, out), bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['electron'] })
}
const { TaskRunner } = await import(pathToFileURL(path.join(root, 'out/sd-runner.cjs')).href)
const { TaskStore } = await import(pathToFileURL(path.join(root, 'out/sd-store.cjs')).href)
const { parseDelegates, stripDelegates } = await import(pathToFileURL(path.join(root, 'out/sd-delegate.cjs')).href)

// ---- 假后端：领队 zcode 风格（send 续聊），worker claude 风格 ----
function makeLeaderBackend() {
  return {
    id: 'zcode',
    label: 'ZetCode',
    async probe() { return { ok: true, detail: '' } },
    async start({ prompt, events }) {
      const sid = 'sess_lead_' + Math.random().toString(36).slice(2, 6)
      // 首回合：派两个
      setTimeout(() => {
        const text = '我先派两个队员分头改文件。\n<delegate to="Alpha">把 a.txt 改成 v2</delegate>\n<delegate to="Beta">把 b.txt 改成 v2</delegate>'
        events.onEvent({ ts: Date.now(), kind: 'final', text })
        // Simulate Codex: the dispatch appears in an earlier agent_message,
        // while the last display message is only a summary.
        events.onTurnEnd({ response: '我会在队员完成后汇总。', delegationText: text, ok: true })
      }, 30)
      return {
        sessionId: sid,
        async send(content) {
          // 第二回合：收到结果汇报 → 收尾（不再派发）
          setTimeout(() => {
            const followup = '追问派工'
            const text = content === followup
              ? '追问已拆分。<delegate to="Alpha">复查 a.txt</delegate>'
              : content.includes('结果汇报')
                ? '两个队员都完成了。任务结束，最终总结：a.txt 和 b.txt 已升级。'
                : '继续等待'
            events.onEvent({ ts: Date.now(), kind: 'final', text })
            events.onTurnEnd({
              response: content === followup ? '追问将由队员处理。' : text,
              delegationText: content === followup ? text : undefined,
              ok: true
            })
          }, 30)
          await new Promise((r) => setTimeout(r, 50))
        },
        async stop() {}, async close() {}
      }
    }
  }
}
function makeWorkerBackend(tag) {
  return {
    id: tag,
    label: tag,
    async probe() { return { ok: true, detail: '' } },
    async start({ prompt, workdir, events }) {
      setTimeout(() => {
        const m = prompt.match(/(a|b)\.txt/)
        let response = `done ${tag}`
        if (m) {
          fs.writeFileSync(path.join(workdir, m[0]), `${m[0]} v2 by ${tag}\n`)
          response = `已修改 ${m[0]}`
        }
        events.onEvent({ ts: Date.now(), kind: 'final', text: response })
        events.onTurnEnd({ response, ok: true })
      }, 40)
      return { sessionId: 'sess_w', async send() {}, async stop() {}, async close() {} }
    }
  }
}

// ---- git 仓库 ----
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dele-repo-'))
fs.writeFileSync(path.join(repo, 'a.txt'), 'a v1\n')
fs.writeFileSync(path.join(repo, 'b.txt'), 'b v1\n')
execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm init', { cwd: repo })

// ---- 队伍 ----
const team = [
  { id: 'L1', name: 'Boss', backend: 'zcode', role: '领队', systemPrompt: '你是领队。', subordinates: ['W1', 'W2'] },
  { id: 'W1', name: 'Alpha', backend: 'alpha', role: '工程师', systemPrompt: '' },
  { id: 'W2', name: 'Beta', backend: 'beta', role: '工程师', systemPrompt: '' }
]

const tmpStore = fs.mkdtempSync(path.join(os.tmpdir(), 'dele-store-'))
const store = new TaskStore(tmpStore)
const backends = new Map([
  ['zcode', makeLeaderBackend()],
  ['alpha', makeWorkerBackend('Alpha')],
  ['beta', makeWorkerBackend('Beta')]
])
const runner = new TaskRunner(store, backends, () => ({ concurrency: 1, mode: 'yolo', notify: false, workerConcurrency: 3 }))
runner.attachTeam(() => team)

const assert = (cond, msg) => { if (!cond) { console.error('❌', msg); process.exit(1) } console.log('  ✓', msg) }

// parseDelegates 单测
assert(parseDelegates('x <delegate to="甲">任务A</delegate> y <delegate to="乙">任务B</delegate>').length === 2, 'parseDelegates 提取两个')
assert(stripDelegates('前<delegate to="甲">A</delegate>后') === '前后', 'stripDelegates 剥离标记')
// reason 属性（0.7.0）：属性顺序任意、可省略
const withReason = parseDelegates('<delegate to="甲" reason="前端专长">改 UI</delegate>')[0]
assert(withReason.reason === '前端专长' && withReason.to === '甲' && withReason.prompt === '改 UI', 'reason 属性提取')
const reversed = parseDelegates('<delegate reason="调研在行" to="乙">查资料</delegate>')[0]
assert(reversed.to === '乙' && reversed.reason === '调研在行', '属性顺序任意')
assert(parseDelegates('<delegate to="甲">无理由</delegate>')[0].reason === undefined, 'reason 可省略')
assert(stripDelegates('前<delegate to="甲" reason="x">A</delegate>后') === '前后', 'stripDelegates 兼容带 reason 的标记')

// 主流程
const leader = store.create({ title: '升级两文件', prompt: '升级 a 和 b', workdir: repo, backend: 'zcode', agentId: 'L1' })
runner.enqueue(leader)
const t0 = Date.now()
while (Date.now() - t0 < 20000) {
  const t = store.get(leader.id)
  if (t.status === 'done' || t.status === 'failed') break
  await new Promise((r) => setTimeout(r, 150))
}
const fin = store.get(leader.id)
assert(fin.status === 'done', `领队 done（${fin.status}${fin.error ? ' ' + fin.error : ''}）`)
const children = store.list().filter((t) => t.parentTaskId === leader.id)
assert(children.length === 2, `两个子任务（${children.length}）`)
assert(children.some((c) => c.backend === 'alpha') && children.some((c) => c.backend === 'beta'), '子任务路由到各自队员平台')
assert(!fin.result.includes('<delegate'), '最终结果不含 delegate 标记')
assert(fin.result.includes('最终总结'), '最终结果为领队收尾输出')
// git 集成
assert(!!fin.integration?.branch, `集成分支 ${fin.integration?.branch}`)
const ib = fin.integration.branch
assert(execSync(`git show ${ib}:a.txt`, { cwd: repo, encoding: 'utf8' }).includes('by Alpha'), 'a.txt 由 Alpha 合入')
assert(execSync(`git show ${ib}:b.txt`, { cwd: repo, encoding: 'utf8' }).includes('by Beta'), 'b.txt 由 Beta 合入')
assert(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8').trim() === 'a v1', '用户工作区未动')

// Follow-up turns must use the same delegation path as the initial turn.
const follow = await runner.followUp(leader.id, '追问派工')
assert(follow.ok, '追问回合成功')
assert(store.list().filter((t) => t.parentTaskId === leader.id).length === 3, '追问中的 delegate 也创建子任务')

// ================= 场景 B：二层委派 + 防环 + 递归集成（0.7.0） =================
const repo2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dele2-repo-'))
fs.writeFileSync(path.join(repo2, 'c.txt'), 'c v1\n')
execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm init', { cwd: repo2 })

const team2 = [
  { id: 'T', name: 'Top', backend: 'top', role: '总领队', systemPrompt: '', subordinates: ['M'] },
  { id: 'M', name: 'Mid', backend: 'mid', role: '子领队', systemPrompt: '', subordinates: ['G'] },
  // 恶意配置：Gamma 试图把活派回 Top（应被防环闸拒绝）
  { id: 'G', name: 'Gamma', backend: 'gamma', role: '队员', systemPrompt: '', subordinates: ['T'] }
]

function delegatingBackend(id, firstText, finishText) {
  return {
    id, label: id,
    async probe() { return { ok: true, detail: '' } },
    async start({ events }) {
      setTimeout(() => {
        events.onEvent({ ts: Date.now(), kind: 'final', text: firstText })
        events.onTurnEnd({ response: firstText, ok: true })
      }, 30)
      return {
        sessionId: 's_' + id,
        async send(content) {
          setTimeout(() => {
            const text = content.includes('结果汇报') ? finishText : '继续等待'
            events.onEvent({ ts: Date.now(), kind: 'final', text })
            events.onTurnEnd({ response: text, ok: true })
          }, 30)
          await new Promise((r) => setTimeout(r, 50))
        },
        async stop() {}, async close() {}
      }
    }
  }
}
const gammaBackend = {
  id: 'gamma', label: 'gamma',
  async probe() { return { ok: true, detail: '' } },
  async start({ prompt, workdir, events }) {
    setTimeout(() => {
      const m = prompt.match(/c\.txt/)
      if (m) fs.writeFileSync(path.join(workdir, m[0]), 'c v2 by Gamma\n')
      // 干完活后试图把活派回 Top（防环闸应拒绝，然后以正文收尾）
      const text = '我改完了 c.txt。<delegate to="Top" reason="试图回派">你来收尾</delegate>'
      events.onEvent({ ts: Date.now(), kind: 'final', text })
      events.onTurnEnd({ response: text, ok: true })
    }, 40)
    return { sessionId: 's_gamma', async send() {}, async stop() {}, async close() {} }
  }
}

const backends2 = new Map([
  ['top', delegatingBackend('top',
    '派给子领队。<delegate to="Mid" reason="需要二级统筹">把 c.txt 升级到 v2</delegate>',
    '最终总结：全链完成。')],
  ['mid', delegatingBackend('mid',
    '下派给队员。<delegate to="Gamma" reason="具体改文件">把 c.txt 改成 v2 by Gamma</delegate>',
    '子队完成。')],
  ['gamma', gammaBackend]
])
const runner2 = new TaskRunner(store, backends2, () => ({ concurrency: 1, mode: 'yolo', notify: false, workerConcurrency: 3 }))
runner2.attachTeam(() => team2)

const top = store.create({ title: '二层委派', prompt: '升级 c', workdir: repo2, backend: 'top', agentId: 'T' })
runner2.enqueue(top)
const tB = Date.now()
while (Date.now() - tB < 40000) {
  const t = store.get(top.id)
  if (t.status === 'done' || t.status === 'failed') break
  await new Promise((r) => setTimeout(r, 200))
}
const finTop = store.get(top.id)
assert(finTop.status === 'done', `顶层 done（${finTop.status}${finTop.error ? ' ' + finTop.error : ''}）`)
const midTask = store.list().find((t) => t.parentTaskId === top.id)
assert(!!midTask && midTask.agentId === 'M', '一层：Mid 子任务存在')
const gammaTask = store.list().find((t) => t.parentTaskId === midTask.id)
assert(!!gammaTask && gammaTask.agentId === 'G', '二层：Gamma 孙任务存在')
assert(gammaTask.status === 'done', 'Gamma done（回派被拒后正常收尾）')
const gammaEvents = store.readEvents(gammaTask.id).map((e) => e.text ?? '').join('\n')
assert(gammaEvents.includes('拒绝派给 Top'), '防环闸拒绝了回派（事件留痕）')
assert(!store.list().some((t) => t.agentId === 'T' && t.id !== top.id), '没有产生回到 Top 的环任务')
assert(midTask.roundsUsed === 1 && gammaTask.roundsUsed === 1, `轮数记账（mid=${midTask.roundsUsed} gamma=${gammaTask.roundsUsed}）`)
// 递归集成：Gamma 的改动应一路合到顶层的集成分支
const ib2 = finTop.integration?.branch
assert(!!ib2, `顶层集成分支 ${ib2 ?? '无'}`)
if (ib2) {
  assert(execSync(`git show ${ib2}:c.txt`, { cwd: repo2, encoding: 'utf8' }).includes('by Gamma'), 'Gamma 改动经 Mid 递归合入顶层集成分支')
}
assert(fs.readFileSync(path.join(repo2, 'c.txt'), 'utf8').trim() === 'c v1', '用户工作区未动（二层同理）')

// ================= 场景 C：流式提前建单（闭合标签即建单；回灌仍只在回合末；不重复建单） =================
const repo3 = fs.mkdtempSync(path.join(os.tmpdir(), 'dele3-repo-'))
fs.writeFileSync(path.join(repo3, 'd.txt'), 'd v1\n')
execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm init', { cwd: repo3 })

const team3 = [
  { id: 'L3', name: 'Boss3', backend: 'stream', role: '领队', systemPrompt: '', subordinates: ['S1'] },
  { id: 'S1', name: 'Solo', backend: 'solo', role: '队员', systemPrompt: '' }
]
const sentToLeader = []
const streamLeader = {
  id: 'stream', label: 'stream',
  async probe() { return { ok: true, detail: '' } },
  async start({ events }) {
    setTimeout(() => {
      // 流式：闭合的 delegate 标签先随 text 事件到达（此刻就应提前建单），领队回合故意拖 2.5s 才结束
      events.onEvent({ ts: Date.now(), kind: 'text', text: '派活。\n<delegate to="Solo">把 d.txt 改成 v2</delegate>' })
      setTimeout(() => {
        events.onTurnEnd({ response: '已派活，等队员结果。', ok: true })
      }, 2500)
    }, 30)
    return {
      sessionId: 's_stream',
      async send(content) {
        sentToLeader.push(content)
        events.onEvent({ ts: Date.now(), kind: 'final', text: '全部完成。' })
        events.onTurnEnd({ response: '全部完成。最终总结：d.txt 已升级。', ok: true })
      },
      async stop() {}, async close() {}
    }
  }
}
const soloBackend = {
  id: 'solo', label: 'solo',
  async probe() { return { ok: true, detail: '' } },
  async start({ prompt, workdir, events }) {
    setTimeout(() => {
      fs.writeFileSync(path.join(workdir, 'd.txt'), 'd v2 by Solo\n')
      const response = '已修改 d.txt'
      events.onEvent({ ts: Date.now(), kind: 'final', text: response })
      events.onTurnEnd({ response, ok: true })
    }, 60)
    return { sessionId: 's_solo', async send() {}, async stop() {}, async close() {} }
  }
}
const runner3 = new TaskRunner(store, new Map([['stream', streamLeader], ['solo', soloBackend]]), () => ({ concurrency: 1, mode: 'yolo', notify: false, workerConcurrency: 2 }))
runner3.attachTeam(() => team3)
const streamTask = store.create({ title: '流式派单', prompt: '升级 d', workdir: repo3, backend: 'stream', agentId: 'L3' })
runner3.enqueue(streamTask)
const tC = Date.now()
while (Date.now() - tC < 30000) {
  const t = store.get(streamTask.id)
  if (t.status === 'done' || t.status === 'failed') break
  await new Promise((r) => setTimeout(r, 100))
}
const finC = store.get(streamTask.id)
assert(finC.status === 'done', `场景 C：领队 done（${finC.status}${finC.error ? ' ' + finC.error : ''}）`)
const earlyChildren = store.list().filter((t) => t.parentTaskId === streamTask.id)
assert(earlyChildren.length === 1, `场景 C：提前建单且不重复（${earlyChildren.length} 个子任务）`)
assert(earlyChildren[0]?.status === 'done', '场景 C：提前单已跑完')
assert(sentToLeader.some((c) => c.includes('队员 Solo 的结果')), '场景 C：结果仍在回合末回灌给领队')
assert(execSync(`git show ${finC.integration?.branch}:d.txt`, { cwd: repo3, encoding: 'utf8' }).includes('by Solo'), '场景 C：提前单改动照常合入集成分支')

console.log('\n✅ DELEGATION SMOKE PASSED')
process.exit(0)
