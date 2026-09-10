import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const outfile = path.join(root, 'out', 'smoke-worktree-lifecycle.cjs')
await build({ entryPoints: [path.join(root, 'src/main/git.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
const { createWorktree, listWorktreeMetadata, reclaimWorktree, pruneWorktrees, setWorktreeManualKeep, branchExists, worktreeAvailability } = await import(pathToFileURL(outfile).href)

const check = (condition, message) => {
  if (!condition) throw new Error(message)
  console.log(`  OK ${message}`)
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-worktree-lifecycle-'))
const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
try {
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'smoke@example.com')
  git('config', 'user.name', 'AgentDeck Smoke')
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n')
  git('add', '.')
  git('commit', '-qm', 'base')
  const baseSha = git('rev-parse', 'main')

  const created = await createWorktree(dir, 'task_owner_c1', 'main', 'task_owner')
  check(!!created?.metadata, 'worktree creation returns durable metadata')
  check(created.metadata.ownerTaskId === 'task_owner', 'metadata records owner task')
  check(created.metadata.baseSha === baseSha, 'metadata records immutable base SHA')
  check(created.metadata.branch === 'agentdeck/task_owner_c1', 'metadata records managed branch')
  check(listWorktreeMetadata(dir).some((item) => item.path === created.path && item.cleanupStatus === 'active'), 'metadata sidecar is readable')

  fs.writeFileSync(path.join(created.path, 'dirty.txt'), 'keep me\n')
  const dirty = await reclaimWorktree(created.path)
  check(!dirty.ok && dirty.status === 'retained', 'dirty worktree is retained fail-closed')
  check(fs.existsSync(created.path), 'dirty worktree remains available for inspection')

  const marked = await setWorktreeManualKeep(created.path)
  check(marked, 'manual keep marker persists')
  const manual = await reclaimWorktree(created.path)
  check(!manual.ok && manual.status === 'retained' && manual.reason.includes('manual'), 'manual keep blocks reclamation')

  git('-C', created.path, 'status')
  execFileSync('git', ['-C', created.path, 'clean', '-fd'])
  check(await setWorktreeManualKeep(created.path, false), 'manual keep marker can be cleared')
  const removed = await reclaimWorktree(created.path, { deleteBranch: true })
  check(removed.ok && removed.status === 'removed', 'clean worktree is reclaimed')
  check(!fs.existsSync(created.path), 'reclaimed worktree directory is gone')
  check(!await branchExists(dir, created.branch), 'managed temporary branch is deleted with reclamation')

  const orphan = await createWorktree(dir, 'orphan_task_c1', 'main', 'missing_task')
  check(!!orphan, 'orphan fixture worktree created')
  const prune = await pruneWorktrees(dir, () => false, { maxAgeMs: 0 })
  check(prune.removed.includes('orphan_task_c1'), 'prune removes old orphan worktree')
  check(prune.failed.length === 0, 'prune reports no false success or cleanup failure')
  const second = await pruneWorktrees(dir, () => false, { maxAgeMs: 0 })
  check(second.removed.length === 0 && second.failed.length === 0, 'prune is idempotent')
  const unsafe = await reclaimWorktree(dir)
  check(!unsafe.ok && unsafe.status === 'failed', 'real repository path is never treated as a managed worktree')
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-plain-workspace-'))
  try {
    const availability = await worktreeAvailability(plain)
    check(!availability.available && !!availability.reason, 'non-Git workspace reports an explicit downgrade reason')
  } finally {
    fs.rmSync(plain, { recursive: true, force: true })
  }
  console.log('\nWORKTREE LIFECYCLE SMOKE PASSED')
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}
