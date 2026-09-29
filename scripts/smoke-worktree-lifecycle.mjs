import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const outfile = path.join(root, 'out', 'smoke-worktree-lifecycle.cjs')
await build({ entryPoints: [path.join(root, 'src/main/git.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
const { createWorktree, createWorktreeAtBranch, listWorktreeMetadata, reclaimWorktree, pruneWorktrees, setWorktreeManualKeep, setWorktreeOwner, branchExists, worktreeAvailability, removeWorktree, clearWorktreePool, clearWorktreeFileCountCache, WORKTREE_POOL_MAX_PER_REPO, WORKTREE_POOL_OWNER, worktreePoolEntriesForTest, setWorktreePathLockProbeForTest, uniquePathsByKey, sweepWorktrees } = await import(pathToFileURL(outfile).href)

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

  // ---- 别名写法拒绝回收（win32）：重挂分支的 detach 脚手架按别名树名回收必须同样被拒。
  // 复现场景：mergeIntoManagedWorktreeDetached 建的 .agentdeck-merge-detach-* 带 sidecar，
  // 崩溃残留被重挂回分支；回收再以别名写法报进来时，字面量 startsWith 判不中 detach
  // 守卫，会把重挂的树连目录一起强删——别名写法必须同样拒绝、目录存活。----
  if (process.platform === 'win32') {
    const aliasDetachName = '.agentdeck-merge-detach-alias-smoke'
    const aliasDetachBranch = 'agentdeck/task-merge-detach-alias-smoke'
    const aliasDetachPath = path.join(dir, '.agentdeck-worktrees', aliasDetachName)
    const aliasDetachSpelling = path.join(dir, '.agentdeck-worktrees', '.AGENTDECK-MERGE-DETACH-ALIAS-SMOKE')
    check(aliasDetachSpelling.toLowerCase() === aliasDetachPath.toLowerCase() && aliasDetachSpelling !== aliasDetachPath, '前置：别名树名写法与真实写法同目录不同拼写')
    git('branch', aliasDetachBranch, 'main')
    execFileSync('git', ['-C', dir, 'worktree', 'add', '--detach', aliasDetachPath, aliasDetachBranch], { stdio: 'ignore' })
    const aliasDetachPointer = fs.readFileSync(path.join(aliasDetachPath, '.git'), 'utf8')
    const aliasDetachGitdir = path.resolve(aliasDetachPath, /^gitdir:\s*(.+?)\s*$/im.exec(aliasDetachPointer)[1])
    const aliasDetachGeneration = 'smoke-detached-alias-generation'
    fs.writeFileSync(path.join(aliasDetachGitdir, 'agentdeck-generation'), `${aliasDetachGeneration}\n`)
    fs.writeFileSync(path.join(dir, '.agentdeck-worktrees', '.metadata', `${aliasDetachName}.json`), JSON.stringify({
      ownerTaskId: aliasDetachName,
      generationId: aliasDetachGeneration,
      repoDir: dir,
      path: aliasDetachPath,
      branch: aliasDetachBranch,
      baseSha: git('rev-parse', aliasDetachBranch),
      createdAt: Date.now(),
      cleanupStatus: 'active'
    }))
    // 重挂分支：detach 树内检出集成分支（attached HEAD）——detach 守卫的唯一拦截对象
    git('-C', aliasDetachPath, 'switch', aliasDetachBranch)
    const canonicalRefused = await reclaimWorktree(aliasDetachPath, { force: true, expectedOwnerTaskId: aliasDetachName, expectedGenerationId: aliasDetachGeneration })
    check(!canonicalRefused.ok && canonicalRefused.status === 'retained' && (canonicalRefused.reason ?? '').includes('no longer detached'),
      `lowercase spelling refuses a reattached merge tree (got ${canonicalRefused.status}: ${canonicalRefused.reason ?? ''})`)
    check(fs.existsSync(aliasDetachPath), 'lowercase refusal keeps the reattached merge tree alive')
    const aliasRefused = await reclaimWorktree(aliasDetachSpelling, { force: true, expectedOwnerTaskId: aliasDetachName, expectedGenerationId: aliasDetachGeneration })
    check(!aliasRefused.ok && aliasRefused.status === 'retained' && (aliasRefused.reason ?? '').includes('no longer detached'),
      `alias spelling equally refuses a reattached merge tree (got ${aliasRefused.status}: ${aliasRefused.reason ?? ''})`)
    check(fs.existsSync(aliasDetachPath), 'alias refusal keeps the reattached merge tree alive')
    // 收场：拆掉重挂恢复 detach，下一轮清扫照常兜走，不影响后续夹具
    git('-C', aliasDetachPath, 'switch', '--detach', aliasDetachBranch)
    const aliasDetachSweep = await pruneWorktrees(dir, () => false, { maxAgeMs: 0, claimWorktree: testClaim })
    check(aliasDetachSweep.removed.some((name) => name.toLowerCase() === aliasDetachName), 're-detached alias fixture tree is swept by the next round')
    check(!fs.existsSync(aliasDetachPath), 'alias fixture tree is fully reclaimed after re-detach')
  }

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

  // ---- D3b｜Git 注册路径与磁盘目录大小写不同（win32）：gitdir 以别名写法落盘时，
  // 清扫的注册表折叠查找（registeredWorktreeForPath）必须照样命中——「目录与分支都没了
  // 但 Git 注册残留」的具名上报依赖它，字面量键会静默漏报成无事发生。----
  if (process.platform === 'win32') {
    const aliasReg = await createWorktree(dir, 'alias_registration_c1', 'main', 'alias_registration_owner')
    git('-C', aliasReg.path, 'switch', '--detach', 'main')
    const aliasRegMetadataFile = path.join(dir, '.agentdeck-worktrees', '.metadata', 'alias_registration_c1.json')
    const aliasRegMetadata = JSON.parse(fs.readFileSync(aliasRegMetadataFile, 'utf8'))
    aliasRegMetadata.cleanupStatus = 'removed'
    fs.writeFileSync(aliasRegMetadataFile, JSON.stringify(aliasRegMetadata))
    // 注册的 gitdir 内容改写成别名落盘形态：登记的 worktree 路径与磁盘目录仅大小写不同
    const aliasRegGitdirFile = path.join(dir, '.git', 'worktrees', 'alias_registration_c1', 'gitdir')
    const aliasRegGitdir = fs.readFileSync(aliasRegGitdirFile, 'utf8')
    fs.writeFileSync(aliasRegGitdirFile, aliasRegGitdir.replace(/alias_registration_c1\.git\s*$/i, 'ALIAS_REGISTRATION_C1.git\n'))
    fs.rmSync(aliasReg.path, { recursive: true, force: true })
    git('branch', '-D', aliasReg.branch)
    const aliasRegSweep = await pruneWorktrees(dir, () => false, { maxAgeMs: 0, claimWorktree: testClaim })
    check(aliasRegSweep.failed.some((item) => item.name === 'alias_registration_c1' && item.reason.includes('Git registration remains')),
      'registration keyed under an alias-cased path is still found by the folded sweep lookup')
  }

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
  // 项5：报告目录不再豁免复用清理——旧任务报告文件不进新子单目录，目录本身保留（空）
  check(!fs.existsSync(path.join(reused.path, '.agentdeck-reports', 'retained.txt')), 'previous task report files do not leak into the reused tree')
  const reusedReportsDir = path.join(reused.path, '.agentdeck-reports')
  check(fs.existsSync(reusedReportsDir) && fs.readdirSync(reusedReportsDir).length === 0, 'report directory itself is preserved empty for the new task')
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

  // —— 池损坏条目脱池留痕：代际校验失败不再静默出池 ——
  // 元数据挂 failed+待人工处置、时间线出口即时通知派单方、目录保留现场（fail-closed），
  // 重启清扫按处置记录识别；后续派单回落全量 add 不被损坏条目阻塞。
  {
    const corrupt = await createWorktree(dir, 'pool_corrupt_a_c1', 'main', 'pool_corrupt_a')
    check(!!corrupt, 'corrupt fixture: full add builds the tree')
    const releasedCorrupt = await reclaimWorktree(corrupt.path, { repool: true, expectedOwnerTaskId: corrupt.metadata.ownerTaskId })
    check(releasedCorrupt.ok && releasedCorrupt.status === 'pooled', 'corrupt fixture: clean completion pools the tree')
    fs.rmSync(path.join(corrupt.path, '.git')) // 注入损坏：.git 指针缺失 → 代际核验必败（同名删树重建/外部篡改形态）
    let corruptionNote = null
    const afterCorruption = await createWorktree(dir, 'pool_corrupt_b_c1', 'main', 'pool_corrupt_b', undefined, {
      onCleanupResidue: (failure) => { corruptionNote = failure }
    })
    check(!!afterCorruption && afterCorruption.pooled !== true, 'corrupt pool entry does not block the dispatch (full add fallback)')
    check(fs.existsSync(corrupt.path), 'corrupt pool entry directory is preserved (fail-closed, no forced removal)')
    const corruptMetadata = listWorktreeMetadata(dir).find((item) => item.path === corrupt.path)
    check(corruptMetadata?.cleanupStatus === 'failed' && (corruptMetadata?.cleanupReason ?? '').includes('待人工处置'),
      'corrupt pool entry metadata is marked failed with a manual-disposal reason')
    check(!!corruptionNote && corruptionNote.name === 'pool_corrupt_a_c1' && corruptionNote.reason.includes('待人工处置') && corruptionNote.ownerTaskId === 'pool_corrupt_b',
      'timeline note fired for the dispatch that hit the corruption')
    const corruptMetadataFile = path.join(dir, '.agentdeck-worktrees', '.metadata', `${path.basename(corrupt.path)}.json`)
    const staleCorrupt = JSON.parse(fs.readFileSync(corruptMetadataFile, 'utf8'))
    fs.writeFileSync(corruptMetadataFile, JSON.stringify({ ...staleCorrupt, poolProcess: { ...staleCorrupt.poolProcess, pid: 2147483647 } }))
    const corruptSweep = await pruneWorktrees(dir, () => false, { maxAgeMs: 0, claimWorktree: () => undefined })
    check(corruptSweep.failed.some((item) => item.name === 'pool_corrupt_a_c1' && item.reason.includes('处置记录') && item.reason.includes('待人工处置')),
      'restart sweep identifies the evicted pool entry via its recorded disposal reason')
    check(fs.existsSync(corrupt.path), 'restart sweep keeps the unverifiable scene (no forced removal)')
  }

  // —— 缺目录分支补清：目录被外力清掉时代际核验必败（指针在目录里），托管分支不因此滞留 ——
  // 归属证据齐备（可靠元数据 + 世代标记 + 托管分支）时核验补清：prune 注册 + 删托管分支；
  // 集成分支绝不由清扫带走（只清注册侧），有主树（keepTask/租约/owner 证据）照旧把门。
  {
    const vanished = await createWorktree(dir, 'vanished_task_c1', 'main', 'vanished_owner')
    check(!!vanished, 'vanished fixture: tree built')
    const vanishedBranch = vanished.metadata.branch
    fs.rmSync(vanished.path, { recursive: true, force: true })
    check(!fs.existsSync(vanished.path) && await branchExists(dir, vanishedBranch), 'vanished fixture: directory gone, managed branch retained')
    const vanishedSweep = await pruneWorktrees(dir, () => false, { maxAgeMs: 0, claimWorktree: testClaim })
    check(vanishedSweep.removed.includes('vanished_task_c1'), 'missing-dir tree is sweepable via evidence-backed cleanup')
    check(!await branchExists(dir, vanishedBranch), 'missing-dir managed branch is cleaned up (verified supplementary cleanup)')
    const vanishedAudit = listWorktreeMetadata(dir).find((item) => item.path === vanished.path)
    check(vanishedAudit?.cleanupStatus === 'removed', 'missing-dir cleanup leaves a removed audit record')
    git('branch', 'agentdeck/task-integral')
    const integral = await createWorktreeAtBranch(dir, 'integral_tree_c1', 'agentdeck/task-integral', 'integral_owner')
    check(!!integral, 'integration fixture: tree built at existing branch')
    fs.rmSync(integral.path, { recursive: true, force: true })
    const integralSweep = await pruneWorktrees(dir, () => false, { maxAgeMs: 0, claimWorktree: testClaim })
    check(await branchExists(dir, 'agentdeck/task-integral'), 'missing-dir integration branch is never deleted by the sweep')
    check(integralSweep.removed.includes('integral_tree_c1'), 'missing-dir integration tree side is still reclaimed (registration pruned)')
    git('branch', '-D', 'agentdeck/task-integral')
  }

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

  // ---- 并发归池容量守卫：同仓不同树并发 reclaim(repool=true) 最多入池
  // WORKTREE_POOL_MAX_PER_REPO 棵，多余树回落常规回收；每仓容量判定由仓库级归池锁互斥 ----
  clearWorktreePool()
  check(worktreePoolEntriesForTest(dir).length === 0, 'pool starts empty for the concurrent repool capacity regression')
  const capTrees = []
  for (const name of ['pool_cap_c1', 'pool_cap_c2', 'pool_cap_c3']) {
    const tree = await createWorktree(dir, name, 'main', `owner_${name}`)
    check(!!tree?.metadata?.generationId, `${name} fixture created with generation identity`)
    capTrees.push(tree)
  }
  const capResults = await Promise.all(capTrees.map((tree) => reclaimWorktree(tree.path, {
    repool: true,
    deleteBranch: true,
    expectedOwnerTaskId: tree.metadata.ownerTaskId,
    expectedGenerationId: tree.metadata.generationId
  })))
  const capPooled = capResults.filter((item) => item.ok && item.status === 'pooled')
  const capRemoved = capResults.filter((item) => item.ok && item.status === 'removed')
  check(capPooled.length === WORKTREE_POOL_MAX_PER_REPO, `three simultaneous returns pool exactly ${WORKTREE_POOL_MAX_PER_REPO} trees (capacity race guarded)`)
  check(capRemoved.length === capTrees.length - WORKTREE_POOL_MAX_PER_REPO, 'excess concurrent tree falls back to normal reclamation')
  const capPoolPaths = worktreePoolEntriesForTest(dir)
  check(capPoolPaths.length === WORKTREE_POOL_MAX_PER_REPO && capPooled.every((item) => capPoolPaths.includes(item.path)), 'in-process pool holds exactly the pooled winners')
  for (const item of capPooled) {
    check(fs.existsSync(item.path) && listWorktreeMetadata(dir).some((meta) => meta.path === item.path && meta.cleanupStatus === 'pooled'), `${path.basename(item.path)} keeps its directory with a pooled sidecar`)
  }
  for (const item of capRemoved) {
    check(!fs.existsSync(item.path) && !await branchExists(dir, item.branch), `${path.basename(item.path)} excess tree is reclaimed with its branch`)
  }
  // 容量已满时的后续归还：探针树走 createWorktreeAtBranch 造出（该路径不取池），顺序归还被容量拒收
  git('branch', 'agentdeck/pool_cap_probe_c1', 'main')
  const capProbe = await createWorktreeAtBranch(dir, 'pool_cap_probe_c1', 'agentdeck/pool_cap_probe_c1', 'owner_pool_cap_probe')
  check(!!capProbe && capProbe.pooled !== true && worktreePoolEntriesForTest(dir).length === WORKTREE_POOL_MAX_PER_REPO, 'capacity probe tree is built without consuming the pool')
  const capProbeOut = await reclaimWorktree(capProbe.path, {
    repool: true,
    deleteBranch: true,
    expectedOwnerTaskId: capProbe.metadata.ownerTaskId,
    expectedGenerationId: capProbe.metadata.generationId
  })
  check(capProbeOut.ok && capProbeOut.status === 'removed', 'repool at full capacity is refused and reclaimed')
  check(worktreePoolEntriesForTest(dir).length === WORKTREE_POOL_MAX_PER_REPO, 'capacity refusal leaves the pooled winners untouched')

  // 归池失败不占死容量：陈旧 HEAD.lock 卡死 detach 步骤 → 该树回落常规回收，池内不留幽灵
  // 条目，空出的容量立即可被下一次派单复用
  clearWorktreePool()
  const failTree = await createWorktree(dir, 'pool_fail_c1', 'main', 'owner_pool_fail_c1')
  check(!!failTree, 'repool failure fixture created')
  const failPointer = fs.readFileSync(path.join(failTree.path, '.git'), 'utf8')
  const failGitdir = path.resolve(failTree.path, /^gitdir:\s*(.+?)\s*$/im.exec(failPointer)[1])
  fs.writeFileSync(path.join(failGitdir, 'HEAD.lock'), '')
  const failPeer = await createWorktree(dir, 'pool_fail_c2', 'main', 'owner_pool_fail_c2')
  check(!!failPeer && failPeer.path !== failTree.path, 'repool failure peer created')
  const [failOut, peerOut] = await Promise.all([
    reclaimWorktree(failTree.path, {
      repool: true,
      deleteBranch: true,
      expectedOwnerTaskId: failTree.metadata.ownerTaskId,
      expectedGenerationId: failTree.metadata.generationId
    }),
    reclaimWorktree(failPeer.path, {
      repool: true,
      deleteBranch: true,
      expectedOwnerTaskId: failPeer.metadata.ownerTaskId,
      expectedGenerationId: failPeer.metadata.generationId
    })
  ])
  check(failOut.ok && failOut.status === 'removed', 'failed repool falls back to normal reclamation')
  check(!fs.existsSync(failTree.path) && !await branchExists(dir, failTree.branch), 'failed repool tree is reclaimed with its branch')
  check(peerOut.ok && peerOut.status === 'pooled', 'healthy tree still pools beside the failed repool')
  const failPoolPaths = worktreePoolEntriesForTest(dir)
  check(failPoolPaths.length === 1 && failPoolPaths[0] === failPeer.path, 'failed repool never occupies a pool slot')
  const failReuse = await createWorktree(dir, 'pool_fail_c3', 'main', 'owner_pool_fail_c3')
  check(!!failReuse && failReuse.pooled === true && failReuse.path === failPeer.path, 'freed capacity is reusable by the next dispatch')
  const failRepool = await reclaimWorktree(failReuse.path, {
    repool: true,
    expectedOwnerTaskId: failReuse.metadata.ownerTaskId,
    expectedGenerationId: failReuse.metadata.generationId
  })
  check(failRepool.ok && failRepool.status === 'pooled', 'reuse cycle keeps repooling after a failure')

  // ---- 大小写别名并发专项（fix：路径键统一规范化）：同一棵树按别名写法必须同锁、
  // 同池登记、池成员检查别名命中。夹具 A/B/C 翻仓库前缀段大小写；夹具 D 扩展到
  // 全路径别名——托管目录标记段（.agentdeck-worktrees）与树名段一并变体，证明入口
  // 切分、Git 注册表查找、锁、池、池成员检查、清扫命中对整条路径的别名写法全成立。----
  if (process.platform === 'win32') {
    clearWorktreePool()
    const aliasPrefix = (candidate) => {
      const markerIndex = candidate.toLowerCase().indexOf(`${path.sep}.agentdeck-worktrees${path.sep}`)
      return markerIndex > 0 ? candidate.slice(0, markerIndex).toUpperCase() + candidate.slice(markerIndex) : null
    }
    const aliasRepo = dir[0] === dir[0].toLowerCase() ? dir[0].toUpperCase() + dir.slice(1).toUpperCase() : dir[0].toLowerCase() + dir.slice(1).toUpperCase()
    check(aliasRepo.toUpperCase() === dir.toUpperCase() && aliasRepo !== dir, 'alias repo spelling differs only in case')

    // 夹具A｜别名路径的两个改绑调用方串行化：核验+写入临界区必须互斥（计数探针），
    // 且两种写法算出同一把规范锁键
    const aliasTree = await createWorktree(dir, 'alias_case_c1', 'main', 'alias_leader')
    check(!!aliasTree, 'alias fixture tree created')
    const aliasTreePath = aliasPrefix(aliasTree.path)
    check(!!aliasTreePath && aliasTreePath !== aliasTree.path, 'alias tree spelling differs from the real path')
    const lockProbe = () => {
      const acquireKeys = new Set()
      const liveByKey = new Map()
      let maxLiveByKey = 0
      setWorktreePathLockProbeForTest((event, key) => {
        if (event === 'acquire') {
          acquireKeys.add(key)
          const live = (liveByKey.get(key) ?? 0) + 1
          liveByKey.set(key, live)
          maxLiveByKey = Math.max(maxLiveByKey, live)
        } else {
          liveByKey.set(key, (liveByKey.get(key) ?? 1) - 1)
        }
      })
      return { acquireKeys, result: () => ({ acquireKeys, maxLiveByKey }) }
    }
    const probeA = lockProbe()
    try {
      const birth = { generationId: aliasTree.metadata.generationId, ownerTaskId: 'alias_leader', branch: aliasTree.metadata.branch }
      const [bindReal, bindAlias] = await Promise.all([
        setWorktreeOwner(aliasTree.path, 'alias_child_a', birth),
        setWorktreeOwner(aliasTreePath, 'alias_child_b', birth)
      ])
      check(bindReal === true && bindAlias === false, 'first alias caller binds, the serialized second is refused (owner already handed over)')
      const { acquireKeys, maxLiveByKey } = probeA.result()
      check(acquireKeys.size === 1, `both alias spellings take the same canonical lock key (${acquireKeys.size} distinct)`)
      check(maxLiveByKey === 1, `verify+write critical sections never overlap across alias spellings (max live = ${maxLiveByKey})`)
    } finally {
      setWorktreePathLockProbeForTest(undefined)
    }

    // 夹具B｜池复用临界区 与 核验+写入 互斥：树在池中，复用方（真实路径）与旧任务改绑
    // 方（别名路径）并发——两把写法必须进同一把锁，复用给新任务不能插进核验与写入之间
    const poolSource = await createWorktree(dir, 'alias_pool_c1', 'main', 'alias_pool_leader')
    check(!!poolSource, 'pool alias fixture tree created')
    const repooledOnce = await reclaimWorktree(poolSource.path, { repool: true, expectedOwnerTaskId: 'alias_pool_leader', expectedGenerationId: poolSource.metadata.generationId })
    check(repooledOnce.ok && repooledOnce.status === 'pooled', 'pool alias fixture tree repooled')
    check(worktreePoolEntriesForTest(aliasRepo).length === 1, 'pool lookup via alias repo spelling hits the same in-process pool')
    const probeB = lockProbe()
    let reuse
    try {
      const [reuseResult, staleBind] = await Promise.all([
        createWorktree(dir, 'alias_pool_c2', 'main', 'alias_pool_leader'),
        setWorktreeOwner(aliasPrefix(poolSource.path), 'alias_stale_child', {
          generationId: poolSource.metadata.generationId,
          ownerTaskId: 'alias_pool_leader',
          branch: poolSource.metadata.branch
        })
      ])
      reuse = reuseResult
      check(!!reuse && reuse.pooled === true && reuse.path === poolSource.path, 'pooled tree is reused while a stale alias bind is in flight')
      check(staleBind === false, 'stale birth-evidence bind via alias spelling is refused in every interleaving')
      const { acquireKeys, maxLiveByKey } = probeB.result()
      const pooledKey = path.resolve(poolSource.path).toLowerCase()
      check(acquireKeys.has(pooledKey) && acquireKeys.size === 2, `reuse and alias bind serialize on one canonical pool-tree key (${acquireKeys.size} distinct)`)
      check(maxLiveByKey === 1, `pool-reuse critical section and verify+write never overlap (max live = ${maxLiveByKey})`)
    } finally {
      setWorktreePathLockProbeForTest(undefined)
    }

    // 夹具C｜池成员检查用别名路径必须命中：在池的树绝不被别名回收，也绝不重复登记
    const repoolAgain = await reclaimWorktree(poolSource.path, { repool: true, expectedOwnerTaskId: reuse.metadata.ownerTaskId, expectedGenerationId: reuse.metadata.generationId })
    check(repoolAgain.ok && repoolAgain.status === 'pooled', 'alias fixture tree repooled again after the reuse race')
    const aliasPooledPath = aliasPrefix(poolSource.path)
    const aliasReclaim = await reclaimWorktree(aliasPooledPath, { repool: true, expectedOwnerTaskId: WORKTREE_POOL_OWNER, expectedGenerationId: poolSource.metadata.generationId })
    check(aliasReclaim.ok === false && aliasReclaim.status === 'retained' && (aliasReclaim.reason ?? '').includes('active in the reuse pool'),
      `pool member check hits via alias spelling (got ${aliasReclaim.status}: ${aliasReclaim.reason ?? ''})`)
    check(worktreePoolEntriesForTest(dir).length === 1, 'alias reclaim attempt registers no duplicate pool entry')
    check(fs.existsSync(poolSource.path), 'pooled tree survives the alias reclaim attempt')

    // 夹具D｜全路径别名（仓库前缀段+托管目录标记段+树名段三段全变体）：入口切分
    // （resolveManagedWorktree 标记定位）、世代核验的 Git 注册表查找、路径锁、池登记、
    // 池成员检查、清扫元数据配对与遍历去重，整链路对整条路径的别名写法成立
    const fullAliasSpelling = (realPath) => {
      const markerIndex = realPath.toLowerCase().indexOf(`${path.sep}.agentdeck-worktrees${path.sep}`)
      if (markerIndex <= 0) return null
      const markerEnd = markerIndex + `${path.sep}.agentdeck-worktrees${path.sep}`.length
      const flip = (segment) => (segment !== segment.toLowerCase() ? segment.toLowerCase() : segment.toUpperCase())
      return flip(realPath.slice(0, markerIndex)) + path.sep + flip('.agentdeck-worktrees') + path.sep + flip(realPath.slice(markerEnd))
    }
    const fullTree = await createWorktree(dir, 'alias_full_c1', 'main', 'alias_full_leader')
    check(!!fullTree, 'full-alias fixture tree created')
    const fullAliasPath = fullAliasSpelling(fullTree.path)
    check(!!fullAliasPath && fullAliasPath !== fullTree.path && fullAliasPath.toLowerCase() === fullTree.path.toLowerCase(),
      'full alias spelling differs in every managed segment only by case')

    // D1｜干净树经全路径别名直接回收：入口切分+注册表折叠查找+世代核验+锁全链路命中
    const fullAliasRemoved = await reclaimWorktree(fullAliasPath, { deleteBranch: true, expectedOwnerTaskId: fullTree.metadata.ownerTaskId })
    check(fullAliasRemoved.ok && fullAliasRemoved.status === 'removed' && !fs.existsSync(fullTree.path),
      `clean tree is reclaimed through its full alias spelling (got ${fullAliasRemoved.status}: ${fullAliasRemoved.reason ?? ''})`)
    check(!await branchExists(dir, fullTree.branch), 'full alias reclamation deletes the managed branch')

    // D2｜改绑核实+写入与归池都接受全路径别名；池成员检查对别名回收尝试照样命中
    const poolFullTree = await createWorktree(dir, 'alias_full_pool_c1', 'main', 'alias_full_pool_leader')
    check(!!poolFullTree, 'full-alias pool fixture tree created')
    const poolFullAliasPath = fullAliasSpelling(poolFullTree.path)
    const birthBindViaAlias = await setWorktreeOwner(poolFullAliasPath, 'alias_full_child', {
      generationId: poolFullTree.metadata.generationId,
      ownerTaskId: 'alias_full_pool_leader',
      branch: poolFullTree.metadata.branch
    })
    check(birthBindViaAlias === true, 'verify+write succeeds through the full alias spelling (folded registration lookup)')
    const repoolViaAlias = await reclaimWorktree(poolFullAliasPath, { repool: true, expectedOwnerTaskId: 'alias_full_child', expectedGenerationId: poolFullTree.metadata.generationId })
    check(repoolViaAlias.ok && repoolViaAlias.status === 'pooled', 'tree repools through its full alias spelling')
    const memberProbeViaAlias = await reclaimWorktree(poolFullAliasPath, { repool: true, expectedOwnerTaskId: WORKTREE_POOL_OWNER, expectedGenerationId: poolFullTree.metadata.generationId })
    check(memberProbeViaAlias.ok === false && memberProbeViaAlias.status === 'retained' && (memberProbeViaAlias.reason ?? '').includes('active in the reuse pool'),
      `pool membership check hits via full alias spelling (got ${memberProbeViaAlias.status}: ${memberProbeViaAlias.reason ?? ''})`)
    check(worktreePoolEntriesForTest(dir).length === 1, 'full-alias reclaim attempt registers no duplicate pool entry')
    check(fs.existsSync(poolFullTree.path), 'pooled tree survives the full-alias reclaim attempt')

    // D3｜清扫命中：sidecar 按全路径别名写法落盘（repoDir/path 三段全变体）时，清扫
    // 必须照样认定为可靠元数据并回收陈旧池条目；同树别名写法不重复扫描、不误报。
    // 扫描计数/removed/failed 全按路径键折叠比对：别名条目二次扫描或以别名名字记账
    // 都会被抓住（字面量比对会被别名名字骗过）
    clearWorktreePool()
    const sweepRoots = uniquePathsByKey([dir, aliasRepo])
    check(sweepRoots.length === 1 && sweepRoots[0] === path.resolve(dir),
      'sweep repo set folds alias repo spellings into one sweep root and keeps the first spelling')
    const sweepTree = await createWorktree(dir, 'alias_full_sweep_c1', 'main', 'alias_full_sweep_leader')
    check(!!sweepTree && sweepTree.pooled !== true, 'full-alias sweep fixture tree created (full build, not pool reuse)')
    const sweepRepooled = await reclaimWorktree(sweepTree.path, { repool: true, expectedOwnerTaskId: 'alias_full_sweep_leader', expectedGenerationId: sweepTree.metadata.generationId })
    check(sweepRepooled.ok && sweepRepooled.status === 'pooled', 'sweep fixture tree repooled')
    // 池注册表清空 → 池条目成陈旧；sidecar 改写成别名落盘形态 + 陈旧池进程
    clearWorktreePool()
    const sweepSidecar = path.join(dir, '.agentdeck-worktrees', '.metadata', 'alias_full_sweep_c1.json')
    const sweepMeta = JSON.parse(fs.readFileSync(sweepSidecar, 'utf8'))
    sweepMeta.repoDir = aliasRepo
    sweepMeta.path = fullAliasSpelling(sweepMeta.path)
    sweepMeta.poolProcess = { ...sweepMeta.poolProcess, pid: 2147483647 }
    fs.writeFileSync(sweepSidecar, JSON.stringify(sweepMeta))
    // 扫描数预言机：磁盘目录 + sidecar + Git 注册表三个来源的并集按路径键折叠后的
    // 元素数。别名树名（sidecar 的 ALIAS_FULL_SWEEP_C1 / 注册表与磁盘的 alias_full_sweep_c1）
    // 必须折叠成一次扫描——遍历去重失效时 scanned 会多出一枚别名条目
    const managedDir = path.join(dir, '.agentdeck-worktrees')
    const diskTreePaths = fs.readdirSync(managedDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== '.metadata')
      .map((entry) => path.join(managedDir, entry.name))
    const registrationTreePaths = (() => {
      try {
        return fs.readdirSync(path.join(dir, '.git', 'worktrees'), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => path.dirname(fs.readFileSync(path.join(dir, '.git', 'worktrees', entry.name, 'gitdir'), 'utf8').trim()))
      } catch { return [] }
    })()
    const distinctScanKeys = new Set([...diskTreePaths, ...listWorktreeMetadata(dir).map((item) => item.path), ...registrationTreePaths]
      .map((candidate) => path.resolve(candidate).toLowerCase()))
    const sweepAlias = await pruneWorktrees(aliasRepo, () => false, { maxAgeMs: 0, claimWorktree: () => undefined })
    check(sweepAlias.scanned === distinctScanKeys.size,
      `alias entries are scanned exactly once (scanned=${sweepAlias.scanned}, folded distinct=${distinctScanKeys.size})`)
    check(sweepAlias.removed.some((name) => name.toLowerCase() === 'alias_full_sweep_c1'), 'startup sweep honors alias-spelled sidecar metadata and reclaims the stale pooled tree')
    check(sweepAlias.failed.every((item) => item.name.toLowerCase() !== 'alias_full_sweep_c1'), 'alias-spelled sidecar is not misreported as unowned residue')
    check(!fs.existsSync(sweepTree.path), 'alias sidecar sweep removes the stale worktree directory')
    // 回收后 sidecar 按设计保留为审计记录（与 pooled metadata is auditable 同一语义）：
    // 「恰好消费一次」按路径键折叠判定——同名折叠的 sidecar 文件与记录各只有一份
    // （别名迭代若重复处理/重复落盘会多出第二份），且它就是本轮回收的 removed 审计记录
    const sweepSidecarFiles = fs.readdirSync(path.join(dir, '.agentdeck-worktrees', '.metadata')).filter((file) => file.toLowerCase() === 'alias_full_sweep_c1.json')
    const sweepAudit = listWorktreeMetadata(dir).filter((item) => path.basename(item.path).toLowerCase() === 'alias_full_sweep_c1')
    check(sweepSidecarFiles.length === 1 && sweepAudit.length === 1 && sweepAudit[0].cleanupStatus === 'removed',
      `alias sidecar is processed exactly once: a single removal audit record remains (files=${sweepSidecarFiles.length}, records=${sweepAudit.length}, status=${sweepAudit[0]?.cleanupStatus})`)

    // 启动清扫直断：index.ts 启动清扫循环体就是 sweepWorktrees——别名写法仓库根直连
    // 启动清扫必须照常回收陈旧树（不只经 uniquePathsByKey/清理仓库集合 helper 间接覆盖）
    clearWorktreePool()
    const startupAliasTree = await createWorktree(dir, 'startup_alias_sweep_c1', 'main', 'startup_alias_sweep_leader')
    check(!!startupAliasTree && startupAliasTree.pooled !== true, 'startup sweep alias fixture tree created')
    const startupSweep = await sweepWorktrees(aliasRepo, () => false, { claimWorktree: testClaim })
    check(startupSweep.removed.includes('startup_alias_sweep_c1'), 'startup sweep reclaims a stale tree driven through the alias repo spelling')
    check(!fs.existsSync(startupAliasTree.path), 'startup sweep through the alias repo spelling removes the directory')
  } else {
    console.log('  SKIP 大小写别名并发专项（非 win32 平台，路径等价判定退化为字面量比较）')
  }
  console.log('\nWORKTREE LIFECYCLE SMOKE PASSED')
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}
