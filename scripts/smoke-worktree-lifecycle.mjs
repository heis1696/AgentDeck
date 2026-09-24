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
  const unclaimed = await pruneWorktrees(dir, () => false, { maxAgeMs: 0 })
  check(unclaimed.retained.some((item) => item.name === 'orphan_task_c1') && fs.existsSync(orphan.path), 'prune without a durable claim is fail-closed')
  const testClaim = () => ({ release() {} })
  const prune = await pruneWorktrees(dir, () => false, { maxAgeMs: 0, claimWorktree: testClaim })
  check(prune.removed.includes('orphan_task_c1'), 'prune removes old orphan worktree')
  check(prune.failed.length === 0, 'prune reports no false success or cleanup failure')
  const second = await pruneWorktrees(dir, () => false, { maxAgeMs: 0, claimWorktree: testClaim })
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

  // ---- worktree 池化复用：完成归池 → 下次派单换基线秒级复用 → 启动清扫兜底回收 ----
  fs.writeFileSync(path.join(dir, 'feature.txt'), 'advanced baseline\n')
  git('add', '.')
  git('commit', '-qm', 'advance base')
  const advancedSha = git('rev-parse', 'main')

  const first = await createWorktree(dir, 'pool_task_a_c1', 'main', 'pool_task_a')
  check(!!first && first.pooled !== true, 'pool empty: dispatch builds a full worktree')
  const released = await reclaimWorktree(first.path, { repool: true })
  check(released.ok && released.status === 'pooled', 'clean completion returns worktree to the pool')
  check(fs.existsSync(first.path), 'pooled worktree directory is retained for reuse')
  check(git('-C', first.path, 'rev-parse', '--abbrev-ref', 'HEAD') === 'HEAD', 'pooled entry is detached: branch deletion stays with the caller')
  check(listWorktreeMetadata(dir).some((item) => item.path === first.path && item.cleanupStatus === 'pooled'), 'pooled metadata is auditable')

  const reused = await createWorktree(dir, 'pool_task_b_c1', 'main', 'pool_task_b')
  check(!!reused && reused.pooled === true, 'next dispatch reuses the pooled worktree')
  check(reused.path === first.path, 'reuse hands back the same directory')
  check(reused.metadata.baseSha === advancedSha, 'reuse re-bases to the requested baseline')
  check(reused.metadata.branch === 'agentdeck/pool_task_b_c1', 'reuse carries the new dispatch branch')
  check(git('-C', reused.path, 'status', '--porcelain') === '', 'reused worktree is clean at the new baseline')
  check(fs.readFileSync(path.join(reused.path, 'feature.txt'), 'utf8').includes('advanced'), 'reused files reflect the advanced baseline')

  const sweepPooled = await pruneWorktrees(dir, () => false, { maxAgeMs: 0, claimWorktree: testClaim })
  check(sweepPooled.removed.includes('pool_task_a_c1'), 'startup sweep reclaims idle pool entries (session-scoped pool)')
  console.log('\nWORKTREE LIFECYCLE SMOKE PASSED')
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}
