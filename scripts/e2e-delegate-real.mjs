// 真实自发委派 e2e：zcode 领队 + claude/codex 队员，不指定派发——领队自行判断
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { execSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
for (const [src, out] of [
  ['src/main/runner.ts', 'out/dr-runner.cjs'],
  ['src/main/store.ts', 'out/dr-store.cjs'],
  ['src/main/backends/zcode.ts', 'out/dr-zcode.cjs'],
  ['src/main/backends/claude.ts', 'out/dr-claude.cjs'],
  ['src/main/backends/opencode.ts', 'out/dr-opencode.cjs']
]) {
  await build({ entryPoints: [path.join(root, src)], outfile: path.join(root, out), bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['electron'] })
}
const { TaskRunner } = await import(pathToFileURL(path.join(root, 'out/dr-runner.cjs')).href)
const { TaskStore } = await import(pathToFileURL(path.join(root, 'out/dr-store.cjs')).href)
const { createZcodeBackend } = await import(pathToFileURL(path.join(root, 'out/dr-zcode.cjs')).href)
const { createClaudeBackend } = await import(pathToFileURL(path.join(root, 'out/dr-claude.cjs')).href)
const { createOpencodeBackend } = await import(pathToFileURL(path.join(root, 'out/dr-opencode.cjs')).href)

// git 仓库
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'realdele-'))
fs.writeFileSync(path.join(repo, 'utils.py'), 'def add(a, b):\n    return a + b\n')
fs.writeFileSync(path.join(repo, 'NOTES.md'), '# 说明\n\n（待写）\n')
execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm init', { cwd: repo })

const team = [
  { id: 'L1', name: 'ZetCode', backend: 'zcode', role: '领队', systemPrompt: '你是开发领队。可并行的专业工作优先派给队员。', subordinates: ['W1', 'W2'] },
  { id: 'W1', name: 'Claude', backend: 'claude', role: '工程师', systemPrompt: '你是资深工程师。' },
  { id: 'W2', name: 'OpenCode', backend: 'opencode', role: '工程师', systemPrompt: '你是文档工程师。' }
]

const tmpStore = fs.mkdtempSync(path.join(os.tmpdir(), 'realdele-store-'))
const store = new TaskStore(tmpStore)
const backends = new Map([
  ['zcode', createZcodeBackend(() => ({ nodePath: '', zcodePath: '' }))],
  ['claude', createClaudeBackend()],
  ['opencode', createOpencodeBackend()]
])
const runner = new TaskRunner(store, backends, () => ({ concurrency: 1, mode: 'yolo', notify: false, workerConcurrency: 3 }))
runner.attachTeam(() => team)

console.log('创建任务（不指定派发，看领队自发决策）…')
const leader = store.create({
  title: '升级工具并补文档',
  prompt: '给 utils.py 的 add 加中文 docstring 并新增 multiply 函数；同时在 NOTES.md 写这两个函数的使用说明。',
  workdir: repo,
  backend: 'zcode',
  agentId: 'L1'
})
runner.enqueue(leader)

const t0 = Date.now()
let last = ''
while (Date.now() - t0 < 15 * 60 * 1000) {
  const t = store.get(leader.id)
  const kids = store.list().filter((x) => x.parentTaskId === leader.id).length
  const s = `${t.status} kids=${kids}`
  if (s !== last) { console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${s}`); last = s }
  if (t.status === 'done' || t.status === 'failed') break
  await new Promise((r) => setTimeout(r, 2500))
}

const fin = store.get(leader.id)
console.log('\n===== 结果 =====')
console.log('领队:', fin.status, fin.error ?? '')
const kids = store.list().filter((t) => t.parentTaskId === leader.id)
for (const k of kids) {
  const who = team.find((a) => a.id === k.agentId)?.name ?? k.backend
  console.log(`子任务 [${who}/${k.backend}]: ${k.title.slice(0, 40)} → ${k.status} (${k.eventCount} 事件)`)
}
if (!kids.length) console.log('（领队未派发——自己干完了；这也合法）')
console.log('最终结果前150字:', (fin.result ?? '').slice(0, 150).replace(/\n/g, ' '))
console.log('集成:', fin.integration?.note ?? '(无子任务改动)')
console.log('diff stat:', (fin.gitStat ?? '').split('\n')[0])

if (fin.integration?.branch) {
  const ib = fin.integration.branch
  try {
    const py = execSync(`git show ${ib}:utils.py`, { cwd: repo, encoding: 'utf8' })
    console.log('utils.py docstring:', /"""/.test(py), '| multiply:', py.includes('multiply'))
    const md = execSync(`git show ${ib}:NOTES.md`, { cwd: repo, encoding: 'utf8' })
    console.log('NOTES.md 使用说明:', md.includes('multiply') || md.length > 40)
    console.log('用户工作区未动:', fs.readFileSync(path.join(repo, 'utils.py'), 'utf8').trim() === 'def add(a, b):\n    return a + b')
  } catch (e) { console.log('集成验证失败:', String(e).slice(0, 120)) }
}
process.exit(fin.status === 'done' ? 0 : 1)
