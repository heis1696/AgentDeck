// 真实 squad e2e：真 GLM 领队规划 + 真实 worker 会话改代码 + git 集成
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { execSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
for (const [src, out] of [
  ['src/main/squad.ts', 'out/e2e-squad-core.cjs'],
  ['src/main/runner.ts', 'out/e2e-squad-runner.cjs'],
  ['src/main/store.ts', 'out/e2e-squad-store.cjs'],
  ['src/main/backends/zcode.ts', 'out/e2e-squad-zcode.cjs']
]) {
  await build({ entryPoints: [path.join(root, src)], outfile: path.join(root, out), bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['electron'] })
}
const { SquadRunner } = await import(pathToFileURL(path.join(root, 'out/e2e-squad-core.cjs')).href)
const { TaskRunner } = await import(pathToFileURL(path.join(root, 'out/e2e-squad-runner.cjs')).href)
const { TaskStore } = await import(pathToFileURL(path.join(root, 'out/e2e-squad-store.cjs')).href)
const { createZcodeBackend } = await import(pathToFileURL(path.join(root, 'out/e2e-squad-zcode.cjs')).href)

// 临时 git 仓库：一个小工具库
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-real-'))
fs.writeFileSync(path.join(repo, 'string_utils.py'), 'def greet(name):\n    return "hi " + name\n\ndef shout(s):\n    return s.upper()\n')
fs.writeFileSync(path.join(repo, 'math_utils.py'), 'def add(a, b):\n    return a + b\n')
fs.writeFileSync(path.join(repo, 'README.md'), '# utils\n\n小工具库。\n')
execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm init', { cwd: repo })

const tmpStore = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-real-store-'))
const store = new TaskStore(tmpStore)
const zcode = createZcodeBackend(() => ({ nodePath: '', zcodePath: '' }))
const backends = new Map([[zcode.id, zcode]])
const runner = new TaskRunner(store, backends, () => ({ concurrency: 1, mode: 'yolo', notify: false, squadMaxWorkers: 2 }))
const squad = new SquadRunner({ store, runner, backends, opts: () => ({ concurrency: 1, mode: 'yolo', notify: false, squadMaxWorkers: 2 }), pushTask: () => {}, pushEvent: () => {} })
runner.attachSquad(squad)

console.log('创建真实协同任务（升级 string_utils + math_utils + README）…')
const leader = store.create({
  title: '升级工具库',
  prompt: '升级这个 Python 小工具库：给 string_utils.py 的两个函数加上中文 docstring 并新增一个 capitalize_words 函数；给 math_utils.py 新增 multiply 函数；README.md 补一段函数清单。各子任务避免改同一个文件。',
  workdir: repo,
  backend: 'zcode',
  mode: 'squad',
  squad: { phase: 'planning', maxWorkers: 2 }
})
runner.enqueue(leader)

const t0 = Date.now()
let lastPhase = ''
while (Date.now() - t0 < 15 * 60 * 1000) {
  const t = store.get(leader.id)
  const phase = `${t.status}:${t.squad?.phase ?? '-'}`
  if (phase !== lastPhase) {
    console.log(`[${Math.round((Date.now() - t0) / 1000)}s] 领队 ${phase}`)
    lastPhase = phase
  }
  if (t.status === 'done' || t.status === 'failed') break
  await new Promise((r) => setTimeout(r, 2000))
}

const fin = store.get(leader.id)
console.log('\n===== 结果 =====')
console.log('领队状态:', fin.status, fin.error ?? '')
const workers = store.list().filter((t) => t.parentTaskId === leader.id)
for (const w of workers) {
  console.log(`worker ${w.workerIndex}: ${w.title} → ${w.status} (${w.eventCount} 事件) ${(w.result ?? '').slice(0, 60).replace(/\n/g, ' ')}`)
}
console.log('汇总报告前200字:', (fin.result ?? '').slice(0, 200).replace(/\n/g, ' '))
console.log('集成:', fin.squad?.integrationNote ?? '(无)')
console.log('总 diff stat:', fin.gitStat ?? '(无)')

// 验证集成分支内容
if (fin.squad?.integrationBranch) {
  const ib = fin.squad.integrationBranch
  try {
    const su = execSync(`git show ${ib}:string_utils.py`, { cwd: repo, encoding: 'utf8' })
    console.log('\n集成分支 string_utils.py 是否含 docstring:', /"""/.test(su))
    console.log('集成分支是否含 capitalize_words:', su.includes('capitalize_words'))
    const mu = execSync(`git show ${ib}:math_utils.py`, { cwd: repo, encoding: 'utf8' })
    console.log('集成分支是否含 multiply:', mu.includes('multiply'))
    const worktreeUntouched = fs.readFileSync(path.join(repo, 'string_utils.py'), 'utf8')
    console.log('用户工作区未被改动:', !/"""/.test(worktreeUntouched))
  } catch (e) {
    console.log('集成分支验证失败:', String(e).slice(0, 150))
  }
}
process.exit(fin.status === 'done' ? 0 : 1)
