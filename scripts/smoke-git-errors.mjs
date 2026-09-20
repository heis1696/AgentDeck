import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const outfile = path.join(root, 'out', 'smoke-git.cjs')
await build({ entryPoints: [path.join(root, 'src/main/git.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
const { runGit, mergeBranchInto, snapshotGitAfter } = await import(pathToFileURL(outfile).href)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-git-'))
const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
process.env.GIT_CONFIG_GLOBAL = path.join(dir, 'empty-global-config')
process.env.GIT_CONFIG_NOSYSTEM = '1'
const commitArgs = ['-c', 'user.email=smoke@example.com', '-c', 'user.name=Smoke']
git('init', '-b', 'main')
fs.writeFileSync(path.join(dir, 'value.txt'), 'base\n'); git('add', '.'); git(...commitArgs, 'commit', '-m', 'base')
git('checkout', '-b', 'source'); fs.writeFileSync(path.join(dir, 'value.txt'), 'source\n'); git(...commitArgs, 'commit', '-am', 'source')
git('checkout', 'main'); fs.writeFileSync(path.join(dir, 'value.txt'), 'target\n'); git(...commitArgs, 'commit', '-am', 'target')
fs.mkdirSync(path.join(dir, '.agentdeck-worktrees'), { recursive: true })
git('checkout', '-b', 'runner')
const bad = await runGit(dir, ['show', 'does-not-exist'])
if (bad.ok || bad.code === 0 || !bad.stderr) throw new Error('git failure did not preserve stderr/code')
const merged = await mergeBranchInto(dir, 'main', 'source')
if (merged.ok || !merged.conflict || !merged.message.includes('conflict')) throw new Error('merge conflict was not structured')
git('checkout', 'main')
git('checkout', '-b', 'source-success')
fs.writeFileSync(path.join(dir, 'merged.txt'), 'merged under isolated config\n')
git('add', 'merged.txt'); git(...commitArgs, 'commit', '-m', 'source success')
git('checkout', 'runner')
const successful = await mergeBranchInto(dir, 'main', 'source-success')
if (!successful.ok || successful.conflict) throw new Error(`isolated-config merge failed: ${successful.message}`)
if (git('show', 'main:merged.txt') !== 'merged under isolated config\n') throw new Error('successful merge did not update integration branch')
const leftoverMergeWorktrees = fs.readdirSync(path.join(dir, '.agentdeck-worktrees')).filter((name) => name.startsWith('.agentdeck-merge-'))
if (leftoverMergeWorktrees.length !== 0) throw new Error(`successful merge worktree was not reclaimed: ${leftoverMergeWorktrees.join(', ')}`)
console.log('✓ process failure and merge conflict')

// Repository discovery stays with Git; only the probe's diagnostic locale is fixed.
const gitAt = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-nongit-'))
const nested = path.join(dir, 'nested')
fs.mkdirSync(nested, { recursive: true })
const ceilingRepo = path.join(nonGit, 'repo')
const ceilingChild = path.join(ceilingRepo, 'child')
fs.mkdirSync(ceilingChild, { recursive: true })
gitAt(ceilingRepo, 'init', '-q', '-b', 'main')
const environment = Object.fromEntries(['LC_ALL', 'LANG', 'LANGUAGE', 'GIT_DIR', 'GIT_CEILING_DIRECTORIES', 'PATH'].map((key) => [key, process.env[key]]))
try {
  delete process.env.GIT_DIR
  delete process.env.GIT_CEILING_DIRECTORIES
  process.env.LC_ALL = 'zh_CN.UTF-8'
  process.env.LANG = 'zh_CN.UTF-8'
  process.env.LANGUAGE = 'zh_CN'
  const unavailable = await snapshotGitAfter(nonGit)
  if (unavailable.snapshot.state !== 'unavailable' || !unavailable.snapshot.reason.includes('不是 Git 仓库')) {
    throw new Error(`non-Git directory was not downgraded under a localized locale: ${unavailable.snapshot.state} ${unavailable.snapshot.reason}`)
  }
  if ((await snapshotGitAfter(nested)).snapshot.state === 'unavailable') {
    throw new Error('a directory inside a repository was misclassified as non-Git')
  }
  // 路径不存在（或显式 GIT_DIR 指错）是真错误，不是「没有仓库」
  if ((await snapshotGitAfter(path.join(nonGit, 'missing'))).snapshot.state !== 'error') throw new Error('missing path was treated as a non-Git directory')
  process.env.GIT_DIR = path.join(nonGit, 'nowhere')
  if ((await snapshotGitAfter(nonGit)).snapshot.state !== 'error') throw new Error('invalid explicit GIT_DIR was treated as an ordinary non-Git directory')
  delete process.env.GIT_DIR
  // ceiling 与 git 的发现边界一致
  process.env.GIT_CEILING_DIRECTORIES = ceilingRepo
  if ((await snapshotGitAfter(ceilingChild)).snapshot.state !== 'unavailable') {
    throw new Error('ceiling directory was searched for a repository')
  }
  process.env.GIT_CEILING_DIRECTORIES = nonGit
  if ((await snapshotGitAfter(ceilingChild)).snapshot.state !== 'clean') {
    throw new Error('repository below the ceiling was not discovered')
  }
  if (process.env.LC_ALL !== 'zh_CN.UTF-8' || process.env.LANGUAGE !== 'zh_CN') throw new Error('probe changed the host locale')
  process.env.PATH = ''
  if ((await snapshotGitAfter(nonGit)).snapshot.state !== 'error') throw new Error('Git startup failure was mistaken for a non-Git directory')
} finally {
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}
const tempRelative = path.relative(os.tmpdir(), nonGit)
if (!tempRelative.startsWith('agentdeck-nongit-') || tempRelative.includes(path.sep)) throw new Error('Unexpected temporary directory')
fs.rmSync(nonGit, { recursive: true, force: true })
console.log('✓ non-Git detection ignores localized diagnostics')
console.log('✅ GIT ERROR SMOKE PASSED')
