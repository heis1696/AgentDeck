// 工作区 git 概览冒烟：workspaceGitSummary（主进程函数，真 git fixture）+ WorkspaceGitCard 渲染态。
// 验收口径（吸收 ZCode 工作区上下文头）：分支/领先落后/三类未提交计数/最近提交；
// 非仓库 ok:false 不抛；UI 对非仓库显示灰态、对空目录静默。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'

const root = path.resolve(import.meta.dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-workspace-git-'))
const repo = path.join(temp, 'repo')
const nonRepo = path.join(temp, 'not-a-repo')
fs.mkdirSync(repo)
fs.mkdirSync(nonRepo)
process.env.GIT_CONFIG_GLOBAL = path.join(temp, 'empty-global-config')
process.env.GIT_CONFIG_NOSYSTEM = '1'
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
const commit = (cwd, message) => git(cwd, '-c', 'user.email=smoke@example.com', '-c', 'user.name=Smoke', 'commit', '-m', message)

// UI 侧纯视图直测（WorkspaceGitCardView 不含取数 effect，SSR 可渲染）；取数壳的 IPC 走主进程函数侧覆盖
// api.ts 模块加载即读 window.agentdeck（View 纯净，但同文件 import 了 bridge）——与 smoke-git-snapshot 同款最小桩
globalThis.window = { agentdeck: {} }

const outfile = path.join(root, 'out/smoke-workspace-git.cjs')
await build({
  stdin: {
    contents: [
      "export { workspaceGitSummary } from './src/main/git'",
      "export { WorkspaceGitCardView } from './src/renderer/src/components/WorkspaceGitCard'"
    ].join('\n'),
    resolveDir: root,
    loader: 'tsx'
  },
  outfile, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic',
  external: ['electron', 'react', 'react/jsx-runtime', 'lucide-react']
})
const { workspaceGitSummary, WorkspaceGitCardView } = await import(pathToFileURL(outfile).href)

const renderCard = (summary) => {
  const html = renderToStaticMarkup(createElement(WorkspaceGitCardView, { summary, onRefresh: () => {}, onOpen: () => {} }))
  return new JSDOM(`<body>${html}</body>`).window.document.body
}

try {
  // —— 主进程函数：真仓库三类未提交计数 ——
  git(repo, 'init', '-b', 'main')
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'base\n')
  git(repo, 'add', '.')
  commit(repo, 'base')
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'modified\n')          // 未暂存
  fs.writeFileSync(path.join(repo, 'staged.txt'), 'staged\n')             // 暂存
  git(repo, 'add', 'staged.txt')
  fs.writeFileSync(path.join(repo, 'fresh.txt'), 'untracked\n')           // 未跟踪
  fs.writeFileSync(path.join(repo, 'fresh2.txt'), 'untracked\n')
  const dirty = await workspaceGitSummary(repo)
  assert.equal(dirty.ok, true)
  assert.equal(dirty.branch, 'main')
  assert.equal(dirty.staged, 1, `暂存计数（got ${dirty.staged}）`)
  assert.equal(dirty.unstaged, 1, `未暂存计数（got ${dirty.unstaged}）`)
  assert.equal(dirty.untracked, 2, `未跟踪计数（got ${dirty.untracked}）`)
  assert.equal(dirty.lastCommit.subject, 'base')
  assert(dirty.lastCommit.hash.length >= 7 && /second|minute|hour|day/.test(dirty.lastCommit.when), `最近提交哈希与相对时间（got ${dirty.lastCommit.when}）`)

  // —— 干净仓库 ——
  git(repo, 'add', '.')
  git(repo, '-c', 'user.email=smoke@example.com', '-c', 'user.name=Smoke', 'commit', '-m', 'clean state')
  const clean = await workspaceGitSummary(repo)
  assert.equal(clean.ok, true)
  assert.equal((clean.staged ?? 0) + (clean.unstaged ?? 0) + (clean.untracked ?? 0), 0, '干净工作区计数全零')

  // —— 领先/落后（clone + 双向分叉）——
  const upstream = path.join(temp, 'upstream.git')
  execFileSync('git', ['init', '--bare', '-b', 'main', upstream], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  git(repo, 'remote', 'add', 'origin', upstream)
  git(repo, 'push', '-u', 'origin', 'main')
  const clone = path.join(temp, 'clone')
  execFileSync('git', ['clone', upstream, clone], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'remote moves on\n')
  git(repo, 'add', '.')
  commit(repo, 'remote ahead')
  git(repo, 'push', 'origin', 'main')
  fs.writeFileSync(path.join(clone, 'tracked.txt'), 'local moves too\n')
  git(clone, 'add', '.')
  commit(clone, 'local ahead')
  git(clone, 'fetch', 'origin')
  const diverged = await workspaceGitSummary(clone)
  assert.equal(diverged.ahead, 1, `领先计数（got ${diverged.ahead}）`)
  assert.equal(diverged.behind, 1, `落后计数（got ${diverged.behind}）`)

  // —— 非仓库与空目录 ——
  const notRepo = await workspaceGitSummary(nonRepo)
  assert.equal(notRepo.ok, false)
  assert.equal(notRepo.code, 'not-a-repo', '非仓库返回 not-a-repo 灰态码，不抛')
  const unbornDir = path.join(temp, 'unborn')
  fs.mkdirSync(unbornDir)
  git(unbornDir, 'init', '-b', 'main')
  fs.writeFileSync(path.join(unbornDir, 'x.txt'), 'x\n')
  git(unbornDir, 'add', '.')
  const unborn = await workspaceGitSummary(unbornDir)
  assert.equal(unborn.ok, true, '空仓库（无 HEAD）仍是仓库')
  assert.equal(unborn.staged, 1, '无 HEAD 时暂存计数照常')
  assert.equal(unborn.lastCommit, undefined, '无最近提交时 lastCommit 缺省')

  // —— UI：正常态 / 非仓库灰态 / 其他失败态静默 ——
  const card = renderCard({ ok: true, branch: 'main', staged: 1, unstaged: 1, untracked: 2, ahead: 1, lastCommit: { hash: 'abc1234', subject: '最近提交', when: '2 hours ago' } })
  assert(card.querySelector('.workspace-git-card[data-ok]'), '正常态渲染状态卡')
  assert(card.textContent.includes('main') && card.textContent.includes('4 处未提交'), '分支与合计未提交数可见')
  assert(card.querySelector('.wg-sync'), '领先徽章渲染')
  assert(card.querySelector('[aria-label="刷新工作区状态"]'), '刷新入口存在')
  const muted = renderCard({ ok: false, code: 'not-a-repo', error: '该目录不是 git 仓库' })
  assert.equal(muted.querySelector('.workspace-git-card.is-muted')?.getAttribute('data-code'), 'not-a-repo', '非仓库渲染灰态提示')
  assert(muted.textContent.includes('仍可派单'), '灰态文案不吓退派单')
  assert.equal(renderCard({ ok: false, code: 'git-failed', error: 'boom' }).children.length, 0, '探测失败静默（不渲染任何东西）')

  console.log('✅ WORKSPACE GIT SMOKE PASSED: 计数/领先落后/非仓库/空仓库/干净态 + UI 三态渲染全过')
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}
