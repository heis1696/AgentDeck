import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const outfile = path.join(root, 'out', 'smoke-git.cjs')
await build({ entryPoints: [path.join(root, 'src/main/git.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
const { runGit, mergeBranchInto } = await import(pathToFileURL(outfile).href)
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
console.log('✅ GIT ERROR SMOKE PASSED')
