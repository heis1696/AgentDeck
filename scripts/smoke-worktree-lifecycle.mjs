import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const outfile = path.join(root, 'out', 'smoke-worktree-lifecycle.cjs')
await build({ entryPoints: [path.join(root, 'src/main/git.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
const { createWorktree, listWorktreeMetadata, reclaimWorktree, pruneWorktrees, setWorktreeManualKeep, branchExists, worktreeAvailability, removeWorktree, clearWorktreePool, clearWorktreeFileCountCache } = await import(pathToFileURL(outfile).href)

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
  check(!!created.metadata.generationId, 'metadata records the registered worktree generation')
  check(listWorktreeMetadata(dir).some((item) => item.path === created.path && item.cleanupStatus === 'active'), 'metadata sidecar is readable')

  fs.writeFileSync(path.join(created.path, 'dirty.txt'), 'keep me\n')
  const dirty = await reclaimWorktree(created.path, { expectedOwnerTaskId: created.metadata.ownerTaskId })
  check(!dirty.ok && dirty.status === 'retained', 'dirty worktree is retained fail-closed')
  check(fs.existsSync(created.path), 'dirty worktree remains available for inspection')

  const marked = await setWorktreeManualKeep(created.path)
  check(marked, 'manual keep marker persists')
  const manual = await reclaimWorktree(created.path, { expectedOwnerTaskId: created.metadata.ownerTaskId })
  check(!manual.ok && manual.status === 'retained' && manual.reason.includes('manual'), 'manual keep blocks reclamation')

  git('-C', created.path, 'status')
  execFileSync('git', ['-C', created.path, 'clean', '-fd'])
  check(await setWorktreeManualKeep(created.path, false), 'manual keep marker can be cleared')
  const removed = await reclaimWorktree(created.path, { deleteBranch: true, expectedOwnerTaskId: created.metadata.ownerTaskId })
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

  const externalName = 'external_clean_c1'
  const externalBranch = `agentdeck/${externalName}`
  const externalPath = path.join(dir, '.agentdeck-worktrees', externalName)
  execFileSync('git', ['-C', dir, 'worktree', 'add', '-b', externalBranch, externalPath, 'main'], { stdio: 'ignore' })
  const externalSweep = await pruneWorktrees(dir, () => false, { maxAgeMs: 0, claimWorktree: testClaim })
  const externalFailure = externalSweep.failed.find((item) => item.name === externalName)
  check(!!externalFailure && externalFailure.reason.includes('owner 元数据'), 'clean external tree without owner marker is reported as unowned residue')
  check(fs.existsSync(externalPath) && await branchExists(dir, externalBranch), 'prune preserves the clean external tree and branch without owner metadata')
  execFileSync('git', ['-C', dir, 'worktree', 'remove', '--force', externalPath], { stdio: 'ignore' })
  git('branch', '-D', externalBranch)

  const missingMetadata = await createWorktree(dir, 'missing_metadata_c1', 'main', 'missing_metadata_owner')
  const missingMetadataFile = path.join(dir, '.agentdeck-worktrees', '.metadata', 'missing_metadata_c1.json')
  fs.rmSync(missingMetadataFile, { force: true })
  const missingMetadataCleanup = await reclaimWorktree(missingMetadata.path, {
    force: true,
    deleteBranch: true,
    expectedOwnerTaskId: 'missing_metadata_owner'
  })
  check(!missingMetadataCleanup.ok && missingMetadataCleanup.status === 'retained', 'direct reclaim fails closed when owner metadata is missing')
  check(fs.existsSync(missingMetadata.path) && await branchExists(dir, missingMetadata.branch), 'missing owner metadata preserves the worktree directory and branch')
  execFileSync('git', ['-C', dir, 'worktree', 'remove', '--force', missingMetadata.path], { stdio: 'ignore' })
  git('branch', '-D', missingMetadata.branch)

  const oldTree = await createWorktree(dir, 'owner_old_c1', 'main', 'owner_old')
  const oldTreeRemoved = await reclaimWorktree(oldTree.path, { deleteBranch: true, expectedOwnerTaskId: oldTree.metadata.ownerTaskId })
  check(oldTreeRemoved.ok && oldTreeRemoved.status === 'removed', 'old-generation fixture is reclaimed')
  git('branch', oldTree.branch, 'main')
  execFileSync('git', ['-C', dir, 'worktree', 'add', oldTree.path, oldTree.branch], { stdio: 'ignore' })
  fs.writeFileSync(path.join(oldTree.path, 'external-owner.txt'), 'external generation\n')
  const externalAfterRemoved = await pruneWorktrees(dir, () => false, { maxAgeMs: 0, claimWorktree: testClaim })
  check(externalAfterRemoved.failed.some((item) => item.name === 'owner_old_c1' && item.reason.includes('generation')), 'removed metadata cannot authorize cleanup of a recreated same-name generation')
  check(fs.existsSync(path.join(oldTree.path, 'external-owner.txt')) && await branchExists(dir, oldTree.branch), 'external same-name tree and branch survive startup sweep')
  execFileSync('git', ['-C', dir, 'worktree', 'remove', '--force', oldTree.path], { stdio: 'ignore' })
  git('branch', '-D', oldTree.branch)

  const missingPointer = await createWorktree(dir, 'missing_pointer_c1', 'main', 'missing_pointer_owner')
  const missingPointerText = fs.readFileSync(path.join(missingPointer.path, '.git'), 'utf8')
  const missingPointerAdmin = path.resolve(missingPointer.path, /^gitdir:\s*(.+?)\s*$/im.exec(missingPointerText)[1])
  fs.rmSync(missingPointer.path, { recursive: true, force: true })
  fs.mkdirSync(missingPointer.path)
  fs.writeFileSync(path.join(missingPointer.path, 'external-owner.txt'), 'not a Git worktree\n')
  check(fs.existsSync(missingPointerAdmin), 'replaced worktree fixture retains the original Git registration')
  const pointerCleanup = await reclaimWorktree(missingPointer.path, {
    force: true,
    deleteBranch: true,
    expectedOwnerTaskId: missingPointer.metadata.ownerTaskId
  })
  check(!pointerCleanup.ok && pointerCleanup.status === 'retained' && pointerCleanup.reason.includes('.git pointer'), 'direct cleanup rejects an old registration without the current .git pointer')
  const pointerSweep = await pruneWorktrees(dir, () => false, { maxAgeMs: 0, claimWorktree: testClaim })
  check(pointerSweep.failed.some((item) => item.name === 'missing_pointer_c1' && item.reason.includes('.git pointer')), 'sweep reports a missing worktree pointer instead of using the old registration')
  check(fs.existsSync(path.join(missingPointer.path, 'external-owner.txt')) && await branchExists(dir, missingPointer.branch), 'missing pointer preserves the replacement directory and branch')
  fs.rmSync(missingPointer.path, { recursive: true, force: true })
  git('worktree', 'prune')
  git('branch', '-D', missingPointer.branch)

  const activeTree = await createWorktree(dir, 'owner_active_old_c1', 'main', 'owner_active_old')
  execFileSync('git', ['-C', dir, 'worktree', 'remove', '--force', activeTree.path], { stdio: 'ignore' })
  git('branch', '-D', activeTree.branch)
  execFileSync('git', ['-C', dir, 'worktree', 'add', '-b', activeTree.branch, activeTree.path, 'main'], { stdio: 'ignore' })
  fs.writeFileSync(path.join(activeTree.path, 'external-owner.txt'), 'new active-name generation\n')
  const activeDirectCleanup = await reclaimWorktree(activeTree.path, { deleteBranch: true, expectedOwnerTaskId: activeTree.metadata.ownerTaskId })
  check(!activeDirectCleanup.ok && activeDirectCleanup.status === 'retained' && activeDirectCleanup.reason.includes('generation'), 'direct cleanup rejects an unverifiable replacement generation')
  const externalAfterActive = await pruneWorktrees(dir, () => false, { maxAgeMs: 0, claimWorktree: testClaim })
  check(externalAfterActive.failed.some((item) => item.name === 'owner_active_old_c1' && item.reason.includes('generation')), 'active metadata cannot authorize cleanup of a recreated same-name generation')
  check(fs.existsSync(path.join(activeTree.path, 'external-owner.txt')) && await branchExists(dir, activeTree.branch), 'new active-name tree and branch survive startup sweep')
  execFileSync('git', ['-C', dir, 'worktree', 'remove', '--force', activeTree.path], { stdio: 'ignore' })
  git('branch', '-D', activeTree.branch)

  const legacyTree = await createWorktree(dir, 'legacy_task_c1', 'main', 'legacy_task')
  const legacyMetadataFile = path.join(dir, '.agentdeck-worktrees', '.metadata', 'legacy_task_c1.json')
  const legacyMetadata = JSON.parse(fs.readFileSync(legacyMetadataFile, 'utf8'))
  delete legacyMetadata.generationId
  fs.writeFileSync(legacyMetadataFile, JSON.stringify(legacyMetadata))
  const legacySweep = await pruneWorktrees(dir, () => false, { maxAgeMs: 0, claimWorktree: testClaim })
  check(legacySweep.failed.some((item) => item.name === 'legacy_task_c1' && item.reason.includes('legacy')), 'legacy metadata without a generation identity is reported and retained')
  check(fs.existsSync(legacyTree.path), 'legacy metadata cannot authorize automatic worktree removal')

  const incomplete = await createWorktree(dir, 'missing_head_c1', 'main', 'missing_head')
  const gitdirPointer = fs.readFileSync(path.join(incomplete.path, '.git'), 'utf8')
  const gitdir = path.resolve(incomplete.path, /^gitdir:\s*(.+?)\s*$/im.exec(gitdirPointer)[1])
  const headFile = path.join(gitdir, 'HEAD')
  const headBackup = path.join(gitdir, 'HEAD.smoke-backup')
  fs.renameSync(headFile, headBackup)
  try {
    const incompleteSweep = await pruneWorktrees(dir, () => false, { maxAgeMs: 0, claimWorktree: testClaim })
    check(incompleteSweep.failed.some((item) => item.name === 'missing_head_c1' && item.reason.includes('HEAD')), 'registration missing HEAD is reported and retained')
    check(fs.existsSync(incomplete.path), 'incomplete Git registration is never removed')
  } finally {
    fs.renameSync(headBackup, headFile)
  }
  const completeHeadSweep = await pruneWorktrees(dir, () => false, { maxAgeMs: 0, claimWorktree: testClaim })
  check(completeHeadSweep.removed.includes('missing_head_c1'), 'worktree becomes sweepable after its complete registration is restored')

  const mergeName = '.agentdeck-merge-smoke'
  const mergePath = path.join(dir, '.agentdeck-worktrees', mergeName)
  execFileSync('git', ['-C', dir, 'worktree', 'add', '--detach', mergePath, 'main'], { stdio: 'ignore' })
  const mergeGitdirPointer = fs.readFileSync(path.join(mergePath, '.git'), 'utf8')
  const mergeGitdir = path.resolve(mergePath, /^gitdir:\s*(.+?)\s*$/im.exec(mergeGitdirPointer)[1])
  fs.writeFileSync(path.join(mergeGitdir, 'agentdeck-generation'), 'smoke-merge-generation\n')
  const mergeSweep = await pruneWorktrees(dir, () => false, { maxAgeMs: 0, claimWorktree: testClaim })
  check(mergeSweep.removed.includes(mergeName), 'verified interrupted merge worktree is swept without an owner sidecar')
  check(!fs.existsSync(mergePath), 'merge cleanup removes the registered temporary tree')

  const detachedName = '.agentdeck-merge-detach-smoke'
  const detachedBranch = 'agentdeck/task-merge-detach-smoke'
  const detachedPath = path.join(dir, '.agentdeck-worktrees', detachedName)
  git('branch', detachedBranch, 'main')
  execFileSync('git', ['-C', dir, 'worktree', 'add', '--detach', detachedPath, detachedBranch], { stdio: 'ignore' })
  const detachedPointer = fs.readFileSync(path.join(detachedPath, '.git'), 'utf8')
  const detachedGitdir = path.resolve(detachedPath, /^gitdir:\s*(.+?)\s*$/im.exec(detachedPointer)[1])
  const detachedGeneration = 'smoke-detached-generation'
  fs.writeFileSync(path.join(detachedGitdir, 'agentdeck-generation'), `${detachedGeneration}\n`)
  const detachedSidecar = path.join(dir, '.agentdeck-worktrees', '.metadata', `${detachedName}.json`)
  const detachedMetadata = {
    ownerTaskId: detachedName,
    generationId: detachedGeneration,
    repoDir: dir,
    path: detachedPath,
    branch: detachedBranch,
    baseSha: git('rev-parse', detachedBranch),
    createdAt: Date.now(),
    cleanupStatus: 'active'
  }
  fs.writeFileSync(detachedSidecar, JSON.stringify({ ...detachedMetadata, generationId: 'wrong-generation' }))
  const wrongGenerationSweep = await pruneWorktrees(dir, () => false, { maxAgeMs: 0, claimWorktree: testClaim })
  check(wrongGenerationSweep.failed.some((item) => item.name === detachedName && item.reason.includes('generation')), 'detached merge with wrong generation is retained')
  check(fs.existsSync(detachedPath), 'wrong-generation detached merge tree survives')
  fs.writeFileSync(detachedSidecar, JSON.stringify(detachedMetadata))
  git('-C', detachedPath, 'switch', detachedBranch)
  const attachedSweep = await pruneWorktrees(dir, () => false, { maxAgeMs: 0, claimWorktree: testClaim })
  check(attachedSweep.failed.some((item) => item.name === detachedName && item.reason.includes('no longer detached')), 'reattached merge tree is retained')
  check(fs.existsSync(detachedPath), 'reattached merge tree survives')
  git('-C', detachedPath, 'switch', '--detach', detachedBranch)
  const detachedSweep = await pruneWorktrees(dir, () => false, { maxAgeMs: 0, claimWorktree: testClaim })
  check(detachedSweep.removed.includes(detachedName), 'verified detached merge residue is swept')
  check(!fs.existsSync(detachedPath) && !fs.existsSync(detachedGitdir), 'detached merge tree and registration are removed')
  check(await branchExists(dir, detachedBranch), 'detached merge cleanup preserves the integration branch')

  const registrationOnly = await createWorktree(dir, 'registration_only_c1', 'main', 'registration_only_owner')
  git('-C', registrationOnly.path, 'switch', '--detach', 'main')
  const registrationOnlyMetadataFile = path.join(dir, '.agentdeck-worktrees', '.metadata', 'registration_only_c1.json')
  const registrationOnlyMetadata = JSON.parse(fs.readFileSync(registrationOnlyMetadataFile, 'utf8'))
  registrationOnlyMetadata.cleanupStatus = 'removed'
  fs.writeFileSync(registrationOnlyMetadataFile, JSON.stringify(registrationOnlyMetadata))
  fs.rmSync(registrationOnly.path, { recursive: true, force: true })
  git('branch', '-D', registrationOnly.branch)
  const registrationOnlySweep = await pruneWorktrees(dir, () => false, { maxAgeMs: 0, claimWorktree: testClaim })
  check(registrationOnlySweep.failed.some((item) => item.name === 'registration_only_c1' && item.reason.includes('Git registration remains')), 'removed sidecar reports a registration-only residue')
  check(!registrationOnlySweep.removed.includes('registration_only_c1'), 'registration-only residue is not reported as silently removed')

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
  fs.writeFileSync(path.join(dir, '.gitignore'), '*.ignored\n')
  fs.writeFileSync(path.join(dir, 'feature.txt'), 'advanced baseline\n')
  git('add', '.')
  git('commit', '-qm', 'advance base and ignore generated files')
  const advancedSha = git('rev-parse', 'main')

  const first = await createWorktree(dir, 'pool_task_a_c1', 'main', 'pool_task_a')
  check(!!first && first.pooled !== true, 'pool empty: dispatch builds a full worktree')
  fs.writeFileSync(path.join(first.path, 'cross-task.ignored'), 'must not leak\n')
  fs.mkdirSync(path.join(first.path, '.agentdeck-reports'), { recursive: true })
  fs.writeFileSync(path.join(first.path, '.agentdeck-reports', 'retained.txt'), 'system sidecar\n')
  const released = await reclaimWorktree(first.path, { repool: true, expectedOwnerTaskId: first.metadata.ownerTaskId })
  check(released.ok && released.status === 'pooled', 'clean completion returns worktree to the pool')
  check(fs.existsSync(first.path), 'pooled worktree directory is retained for reuse')
  check(git('-C', first.path, 'rev-parse', '--abbrev-ref', 'HEAD') === 'HEAD', 'pooled entry is detached: branch deletion stays with the caller')
  check(listWorktreeMetadata(dir).some((item) => item.path === first.path && item.cleanupStatus === 'pooled'), 'pooled metadata is auditable')
  check(!await removeWorktree(first.path, 'pool_task_a'), 'deleted task cannot reclaim its former pooled worktree')
  check(fs.existsSync(first.path), 'old-task cleanup leaves the idle pool entry available')

  git('branch', 'agentdeck/foreign_task_c1')
  git('switch', 'agentdeck/foreign_task_c1')
  fs.writeFileSync(path.join(dir, 'foreign.txt'), 'preserve this commit\n')
  git('add', 'foreign.txt')
  git('commit', '-qm', 'foreign branch tip')
  const foreignSha = git('rev-parse', 'HEAD')
  git('switch', 'main')
  const foreignWithPool = await createWorktree(dir, 'foreign_task_c1', 'main', 'foreign_owner')
  check(!foreignWithPool && await branchExists(dir, 'agentdeck/foreign_task_c1'), 'pre-existing branch is rejected without consuming the pool')
  check(git('rev-parse', 'agentdeck/foreign_task_c1') === foreignSha, 'pre-existing branch tip is never reset during pool reuse')
  check(fs.existsSync(first.path) && listWorktreeMetadata(dir).some((item) => item.path === first.path && item.cleanupStatus === 'pooled'), 'branch collision preserves the pooled tree')
  git('branch', '-D', 'agentdeck/foreign_task_c1')

  const lateBranch = 'agentdeck/late_collision_c1'
  let lateBranchSha = ''
  clearWorktreeFileCountCache()
  const lateCollision = await createWorktree(dir, 'late_collision_c1', 'main', 'late_owner', undefined, {
    estimateFileCount: async () => {
      git('switch', '-c', lateBranch)
      fs.writeFileSync(path.join(dir, 'late-branch.txt'), 'external branch tip\n')
      git('add', 'late-branch.txt')
      git('commit', '-qm', 'late external branch')
      lateBranchSha = git('rev-parse', 'HEAD')
      git('switch', 'main')
      return 1
    }
  })
  check(!lateCollision && await branchExists(dir, lateBranch), 'branch created during timeout planning is rejected before reuse')
  check(git('rev-parse', lateBranch) === lateBranchSha, 'branch created during planning keeps its original tip')
  check(fs.existsSync(first.path), 'late branch collision does not consume the pool')
  git('branch', '-D', lateBranch)

  const preexistingPath = path.join(dir, '.agentdeck-worktrees', 'preexisting_task_c1')
  fs.mkdirSync(preexistingPath, { recursive: true })
  fs.writeFileSync(path.join(preexistingPath, 'external.txt'), 'external tree\n')
  const preexistingTree = await createWorktree(dir, 'preexisting_task_c1', 'main', 'preexisting_owner')
  check(!preexistingTree && fs.readFileSync(path.join(preexistingPath, 'external.txt'), 'utf8').includes('external'), 'pre-existing worktree directory is never taken over')
  check(fs.existsSync(first.path), 'directory collision leaves the pooled tree intact')
  fs.rmSync(preexistingPath, { recursive: true, force: true })

  const reused = await createWorktree(dir, 'pool_task_b_c1', 'main', 'pool_task_b')
  check(!!reused && reused.pooled === true, 'next dispatch reuses the pooled worktree')
  check(reused.path === first.path, 'reuse hands back the same directory')
  check(reused.metadata.baseSha === advancedSha, 'reuse re-bases to the requested baseline')
  check(reused.metadata.branch === 'agentdeck/pool_task_b_c1', 'reuse carries the new dispatch branch')
  check(git('-C', reused.path, 'status', '--porcelain') === '', 'reused worktree is clean at the new baseline')
  check(fs.readFileSync(path.join(reused.path, 'feature.txt'), 'utf8').includes('advanced'), 'reused files reflect the advanced baseline')
  check(!fs.existsSync(path.join(reused.path, 'cross-task.ignored')), 'ignored files from the previous task are removed on reuse')
  check(fs.readFileSync(path.join(reused.path, '.agentdeck-reports', 'retained.txt'), 'utf8').includes('system sidecar'), 'system sidecars survive ignored-file cleanup')
  check(!await removeWorktree(reused.path, 'pool_task_a'), 'old task cannot delete a pooled tree after reassignment')
  check(fs.existsSync(reused.path) && await branchExists(dir, 'agentdeck/pool_task_b_c1'), 'new owner tree and branch survive stale cleanup')

  const repooled = await reclaimWorktree(reused.path, { repool: true, expectedOwnerTaskId: reused.metadata.ownerTaskId })
  check(repooled.ok && repooled.status === 'pooled', 'new owner can return its tree to the pool')
  clearWorktreePool()
  const livePool = await pruneWorktrees(dir, () => false, { maxAgeMs: 0, claimWorktree: () => undefined })
  check(livePool.retained.some((item) => item.name === 'pool_task_a_c1'), 'another process cannot sweep a live pool owner')
  const pooledMetadata = listWorktreeMetadata(dir).find((item) => item.path === reused.path)
  const pooledMetadataFile = path.join(dir, '.agentdeck-worktrees', '.metadata', `${path.basename(reused.path)}.json`)
  fs.writeFileSync(pooledMetadataFile, JSON.stringify({ ...pooledMetadata, poolProcess: { ...pooledMetadata.poolProcess, pid: 2147483647 } }))
  const sweepPooled = await pruneWorktrees(dir, () => false, { maxAgeMs: 0, claimWorktree: () => undefined })
  check(sweepPooled.removed.includes('pool_task_a_c1'), 'startup sweep reclaims stale pool entries without a task claim')
  check(!fs.existsSync(reused.path), 'startup pool cleanup removes the stale worktree directory')

  for (const [name, timedOut] of [['raced_non_timeout_c1', false], ['raced_timeout_c1', true]]) {
    const branch = `agentdeck/${name}`
    const racedPath = path.join(dir, '.agentdeck-worktrees', name)
    let originalTip = ''
    let errorMessage = ''
    let residueMessage = ''
    const raced = await createWorktree(dir, name, 'main', `owner_${name}`, (message) => { errorMessage = message }, {
      addTimeoutMs: timedOut ? 1 : undefined,
      runAddForTest: async (run) => {
        execFileSync('git', ['-C', dir, 'worktree', 'add', '-b', branch, racedPath, 'main'])
        fs.writeFileSync(path.join(racedPath, 'external-owner.txt'), `owned externally: ${name}\n`)
        originalTip = execFileSync('git', ['-C', racedPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
        if (timedOut) return { ok: false, stdout: '', stderr: 'injected timeout', code: null, timedOut: true }
        return run()
      },
      onCleanupResidue: ({ reason }) => { residueMessage = reason }
    })
    check(!raced, `${timedOut ? 'timeout' : 'non-timeout'} add race refuses a concurrently claimed target`)
    check(fs.existsSync(path.join(racedPath, 'external-owner.txt')), `${timedOut ? 'timeout' : 'non-timeout'} race preserves the external worktree`)
    check(git('rev-parse', branch) === originalTip, `${timedOut ? 'timeout' : 'non-timeout'} race preserves the external branch tip`)
    check(!fs.existsSync(path.join(dir, '.agentdeck-worktrees', '.metadata', `${name}.json`)), 'failed add never assigns ownership metadata to a raced worktree')
    check(errorMessage.includes(racedPath) && errorMessage.includes(branch), 'failed add names retained directory and branch')
    check(residueMessage.includes(racedPath) && residueMessage.includes(branch), 'failed add records unverified residue with owner context')
  }

  // 失败清理按归属回收：既存同名分支（用户残留/预置）不是本次尝试的残肢——秒败拒单后
  // 原样存活，绝不替外部资产清场；清了会让内置重试"意外建树成功"，静默改写派单语义
  git('branch', 'agentdeck/foreign_task_c1')
  const foreign = await createWorktree(dir, 'foreign_task_c1', 'main', 'foreign_owner')
  check(!foreign, 'pre-existing branch: worktree add fails closed')
  check(await branchExists(dir, 'agentdeck/foreign_task_c1'), 'pre-existing branch survives failed attempts untouched')
  check(!fs.existsSync(path.join(dir, '.agentdeck-worktrees', 'foreign_task_c1')), 'fast-fail path leaves no directory behind')
  git('branch', '-D', 'agentdeck/foreign_task_c1')
  console.log('\nWORKTREE LIFECYCLE SMOKE PASSED')
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}
