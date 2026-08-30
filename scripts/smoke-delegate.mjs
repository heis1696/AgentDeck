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
        events.onTurnEnd({ response: text, ok: true })
      }, 30)
      return {
        sessionId: sid,
        async send(content) {
          // 第二回合：收到结果汇报 → 收尾（不再派发）
          setTimeout(() => {
            const text = content.includes('结果汇报')
              ? '两个队员都完成了。任务结束，最终总结：a.txt 和 b.txt 已升级。'
              : '继续等待'
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

console.log('\n✅ DELEGATION SMOKE PASSED')
process.exit(0)
