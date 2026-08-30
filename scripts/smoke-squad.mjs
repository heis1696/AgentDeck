// Squad 编排冒烟：假后端 + 真实 git worktree/merge
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { execSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')

// 打包 squad（连带 store/git），runner 单独打（它 import squad 类型）
await build({
  entryPoints: [path.join(root, 'src/main/squad.ts')],
  outfile: path.join(root, 'out', 'smoke-squad-core.cjs'),
  bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['electron']
})
await build({
  entryPoints: [path.join(root, 'src/main/runner.ts')],
  outfile: path.join(root, 'out', 'smoke-squad-runner.cjs'),
  bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['electron']
})
const { SquadRunner, parsePlan } = await import(pathToFileURL(path.join(root, 'out/smoke-squad-core.cjs')).href)
const { TaskRunner } = await import(pathToFileURL(path.join(root, 'out/smoke-squad-runner.cjs')).href)
const { TaskStore } = await import(pathToFileURL(path.join(root, 'out/smoke-store.cjs')).href)

// ---- 临时 git 仓库 ----
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-repo-'))
fs.writeFileSync(path.join(repo, 'a.txt'), 'module A v1\n')
fs.writeFileSync(path.join(repo, 'b.txt'), 'module B v1\n')
execSync('git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init', { cwd: repo })

// ---- 假后端：领队两回合（计划JSON/汇总），worker 各自回合 ----
function makeBackend() {
  let leaderTurns = 0
  const sessions = new Set()
  return {
    id: 'fake',
    label: 'Fake',
    async probe() { return { ok: true, detail: '' } },
    async start({ prompt, events, resumeSessionId }) {
      const sessionId = 'sess_' + Math.random().toString(36).slice(2, 8)
      sessions.add(sessionId)
      const isLeaderPrompt = prompt.includes('领队（leader）') || prompt.includes('最终综合报告')
      const isSynth = prompt.includes('最终综合报告')
      setTimeout(() => {
        let response = ''
        if (isSynth) response = '## 协同报告\n两个子任务均完成。'
        else if (isLeaderPrompt) {
          leaderTurns++
          response = leaderTurns === 1
            ? '```json\n{"analysis":"拆两个","subtasks":[{"title":"改A","prompt":"把 a.txt 改成 v2"},{"title":"改B","prompt":"把 b.txt 改成 v2"}]}\n```'
            : '```json\n{"subtasks":[{"title":"改A","prompt":"把 a.txt 改成 v2"}]}\n```'
        } else {
          // worker：真的改文件
          const m = prompt.match(/(a|b)\.txt/)
          if (m) {
            const f = path.join(process.env.WORKER_CWD ?? '.', m[0])
            try { fs.writeFileSync(f, `${m[0]} v2 by worker\n`) } catch {}
          }
          response = `完成: ${prompt.slice(0, 30)}`
        }
        events.onEvent({ ts: Date.now(), kind: 'text', text: response })
        events.onEvent({ ts: Date.now(), kind: 'final', text: response })
        events.onTurnEnd({ response, ok: true })
      }, 30)
      return {
        sessionId,
        async send(content) {
          const reply = content.includes('最终综合报告') ? '## 协同报告\n两个子任务均完成。' : '追问回复'
          setTimeout(() => {
            events.onEvent({ ts: Date.now(), kind: 'final', text: reply })
            events.onTurnEnd({ response: reply, ok: true })
          }, 30)
          await new Promise((r) => setTimeout(r, 60))
        },
        async stop() {},
        async close() { sessions.delete(sessionId) }
      }
    }
  }
}

// worker 的 cwd 由 workdir 决定，假后端里通过进程 env 传递不方便；直接在 start 里读 cwd 参数
// —— 改造：把 workdir 传给 fake 的方式是 start({workdir})，上面已含；改用闭包记录

const assert = (cond, msg) => {
  if (!cond) { console.error('❌', msg); process.exit(1) }
  console.log('  ✓', msg)
}

// ---- 重写 fake start 以真实写文件 ----
const backend = makeBackend()
const origStart = backend.start.bind(backend)
backend.start = async ({ prompt, workdir, events, resumeSessionId, mode }) => {
  if (!prompt.includes('领队（leader）') && !prompt.includes('最终综合报告')) {
    // worker：在 workdir 里真改文件
    setTimeout(() => {
      const m = prompt.match(/(a|b)\.txt/)
      let response = `完成: ${prompt.slice(0, 30)}`
      if (m) {
        fs.writeFileSync(path.join(workdir, m[0]), `${m[0]} v2 by worker\n`)
        response = `已修改 ${m[0]}`
      }
      events.onEvent({ ts: Date.now(), kind: 'final', text: response })
      events.onTurnEnd({ response, ok: true })
    }, 40)
    return { sessionId: 'sess_w_' + Math.random().toString(36).slice(2, 6), async send() {}, async stop() {}, async close() {} }
  }
  return origStart({ prompt, workdir, events, resumeSessionId, mode })
}

// ---- 跑 ----
const tmpStore = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-store-'))
const store = new TaskStore(tmpStore)
const backends = new Map([[backend.id, backend]])
const runner = new TaskRunner(store, backends, () => ({ concurrency: 1, mode: 'yolo', notify: false, squadMaxWorkers: 3 }))
const pushTask = () => {}
const pushEvent = () => {}
const squad = new SquadRunner({ store, runner, backends, getAgents: () => [], opts: () => ({ concurrency: 1, mode: 'yolo', notify: false, squadMaxWorkers: 3 }), pushTask, pushEvent })
runner.attachSquad(squad)

console.log('[1] parsePlan 容错')
assert(parsePlan('前置噪音 ```json\n{"subtasks":[{"title":"t","prompt":"p"}]}\n``` 后置').subtasks.length === 1, 'fence 提取')
assert(parsePlan('{"analysis":"x","subtasks":[{"title":"a","prompt":"b"},{"title":"c","prompt":"d"}]}').subtasks.length === 2, '裸 JSON')
assert(parsePlan('完全不是JSON') === null, '垃圾输入返回 null')

console.log('[2] squad 编排（真实 git 仓库）')
const leader = store.create({ title: '改两个文件', prompt: '升级 a 和 b', workdir: repo, backend: 'fake', mode: 'squad', squad: { phase: 'planning', maxWorkers: 3 } })
runner.enqueue(leader)
// 等编排结束（领队 done）
const deadline = Date.now() + 30000
while (Date.now() < deadline) {
  const t = store.get(leader.id)
  if (t && (t.status === 'done' || t.status === 'failed')) break
  await new Promise((r) => setTimeout(r, 200))
}
const finalLeader = store.get(leader.id)
assert(finalLeader.status === 'done', `领队 done（实际 ${finalLeader.status}${finalLeader.error ? ' · ' + finalLeader.error : ''}）`)
const workers = store.list().filter((t) => t.parentTaskId === leader.id)
assert(workers.length === 2, `两个 worker（实际 ${workers.length}）`)
assert(workers.every((w) => w.status === 'done'), 'worker 全部 done')
assert(finalLeader.squad?.phase === 'done', 'squad phase done')
assert(!!finalLeader.squad?.integrationBranch, `集成分支: ${finalLeader.squad?.integrationBranch}`)
assert((finalLeader.result ?? '').includes('协同报告'), '汇总报告落盘')
assert(!!finalLeader.gitStat, `集成分支 diff stat: ${(finalLeader.gitStat ?? '').split('\n')[0]}`)

console.log('[3] 集成分支内容验证')
const ib = finalLeader.squad.integrationBranch
const content = execSync(`git show ${ib}:a.txt`, { cwd: repo, encoding: 'utf8' }).trim()
assert(content.includes('v2 by worker'), `a.txt 已合入集成分支: ${content}`)
const mainA = fs.readFileSync(path.join(repo, 'a.txt'), 'utf8').trim()
assert(mainA === 'module A v1', `用户工作区未被改动（${mainA}）`)

console.log('\n✅ SQUAD SMOKE PASSED')
process.exit(0)
