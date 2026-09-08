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
git('init', '-b', 'main'); git('config', 'user.email', 'smoke@example.com'); git('config', 'user.name', 'Smoke')
fs.writeFileSync(path.join(dir, 'value.txt'), 'base\n'); git('add', '.'); git('commit', '-m', 'base')
git('checkout', '-b', 'source'); fs.writeFileSync(path.join(dir, 'value.txt'), 'source\n'); git('commit', '-am', 'source')
git('checkout', 'main'); fs.writeFileSync(path.join(dir, 'value.txt'), 'target\n'); git('commit', '-am', 'target')
fs.mkdirSync(path.join(dir, '.agentdeck-worktrees'), { recursive: true })
git('checkout', '-b', 'runner')
const bad = await runGit(dir, ['show', 'does-not-exist'])
if (bad.ok || bad.code === 0 || !bad.stderr) throw new Error('git failure did not preserve stderr/code')
const merged = await mergeBranchInto(dir, 'main', 'source')
if (merged.ok || !merged.conflict || !merged.message.includes('conflict')) throw new Error('merge conflict was not structured')
console.log('✓ process failure and merge conflict')
console.log('✅ GIT ERROR SMOKE PASSED')
