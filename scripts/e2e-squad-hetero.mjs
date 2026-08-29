// 真实异构协同 e2e：zcode 领队规划 → claude + codex 各执行子任务 → 集成分支
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { execSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
for (const [src, out] of [
  ['src/main/squad.ts', 'out/e2e2-squad.cjs'],
  ['src/main/runner.ts', 'out/e2e2-runner.cjs'],
  ['src/main/store.ts', 'out/e2e2-store.cjs'],
  ['src/main/backends/zcode.ts', 'out/e2e2-zcode.cjs'],
  ['src/main/backends/claude.ts', 'out/e2e2-claude.cjs'],
  ['src/main/backends/codex.ts', 'out/e2e2-codex.cjs']
]) {
  await build({ entryPoints: [path.join(root, src)], outfile: path.join(root, out), bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['electron'] })
}
const { SquadRunner } = await import(pathToFileURL(path.join(root, 'out/e2e2-squad.cjs')).href)
const { TaskRunner } = await import(pathToFileURL(path.join(root, 'out/e2e2-runner.cjs')).href)
const { TaskStore } = await import(pathToFileURL(path.join(root, 'out/e2e2-store.cjs')).href)
const { createZcodeBackend } = await import(pathToFileURL(path.join(root, 'out/e2e2-zcode.cjs')).href)
const { createClaudeBackend } = await import(pathToFileURL(path.join(root, 'out/e2e2-claude.cjs')).href)
const { createCodexBackend } = await import(pathToFileURL(path.join(root, 'out/e2e2-codex.cjs')).href)

// 临时 git 仓库
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hetero-'))
fs.writeFileSync(path.join(repo, 'py_utils.py'), 'def add(a, b):\n    return a + b\n')
fs.writeFileSync(path.join(repo, 'notes.md'), '# 笔记\n\n（空）\n')
execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm init', { cwd: repo })

const tmpStore = fs.mkdtempSync(path.join(os.tmpdir(), 'hetero-store-'))
const store = new TaskStore(tmpStore)
const backends = new Map([
  ['zcode', createZcodeBackend(() => ({ nodePath: '', zcodePath: '' }))],
  ['claude', createClaudeBackend()],
  ['codex', createCodexBackend()]
])
const agents = [
  { id: 'ag_zcode', name: 'ZetCode', backend: 'zcode', note: 'GLM 全能' },
  { id: 'ag_claude', name: 'Claude', backend: 'claude', note: '擅长写代码' },
  { id: 'ag_codex', name: 'Codex', backend: 'codex', note: '擅长文档' }
]
const runner = new TaskRunner(store, backends, () => ({ concurrency: 1, mode: 'yolo', notify: false, squadMaxWorkers: 3 }))
const squad = new SquadRunner({
  store, runner, backends,
  getAgents: () => agents,
  opts: () => ({ concurrency: 1, mode: 'yolo', notify: false, squadMaxWorkers: 3 }),
  pushTask: () => {},
  pushEvent: () => {}
})
runner.attachSquad(squad)

console.log('创建异构协同任务（zcode 领队；建议 Claude 改代码、Codex 写文档）…')
const leader = store.create({
  title: '异构升级',
  prompt: `升级这个小仓库，拆成两个子任务并明确指定执行队员：
1. 由 Claude 执行：给 py_utils.py 的 add 函数加中文 docstring，并新增 multiply 函数
2. 由 Codex 执行：在 notes.md 里写一段使用说明，列出 add 和 multiply 的用法`,
  workdir: repo,
  backend: 'zcode',
  agentId: 'ag_zcode',
  mode: 'squad',
  squad: { phase: 'planning', maxWorkers: 2 }
})
runner.enqueue(leader)

const t0 = Date.now()
let last = ''
while (Date.now() - t0 < 20 * 60 * 1000) {
  const t = store.get(leader.id)
  const s = `${t.status}:${t.squad?.phase ?? '-'}`
  if (s !== last) {
    console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${s}`)
    last = s
  }
  if (t.status === 'done' || t.status === 'failed') break
  await new Promise((r) => setTimeout(r, 3000))
}

const fin = store.get(leader.id)
console.log('\n===== 结果 =====')
console.log('领队:', fin.status, fin.error ?? '')
const workers = store.list().filter((t) => t.parentTaskId === leader.id)
for (const w of workers) {
  const who = agents.find((a) => a.id === w.agentId)?.name ?? w.backend
  console.log(`worker ${w.workerIndex} [${who}/${w.backend}]: ${w.title} → ${w.status} (${w.eventCount} 事件)`)
}
console.log('集成:', fin.squad?.integrationNote ?? '(无)')
console.log('diff stat:', (fin.gitStat ?? '').split('\n').slice(0, 4).join(' | '))

if (fin.squad?.integrationBranch) {
  const ib = fin.squad.integrationBranch
  try {
    const py = execSync(`git show ${ib}:py_utils.py`, { cwd: repo, encoding: 'utf8' })
    console.log('py_utils 有 docstring:', /"""/.test(py), '| 有 multiply:', py.includes('multiply'))
    const md = execSync(`git show ${ib}:notes.md`, { cwd: repo, encoding: 'utf8' })
    console.log('notes.md 有使用说明:', md.includes('multiply') || md.length > 30)
  } catch (e) {
    console.log('集成分支验证失败:', String(e).slice(0, 120))
  }
}
process.exit(fin.status === 'done' ? 0 : 1)
