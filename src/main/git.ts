// git 快照与委派 worktree 支持
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { WorktreeCleanupStatus, WorktreeInfo } from '../shared/types'

export interface GitCommandResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number | null
}

export interface WorktreeCreateResult {
  path: string
  branch: string
  metadata: WorktreeInfo
}

export interface WorktreeCleanupResult {
  ok: boolean
  status: WorktreeCleanupStatus
  path: string
  branch?: string
  reason?: string
}

export interface WorktreePruneResult {
  repoDir: string
  scanned: number
  removed: string[]
  retained: Array<{ name: string; reason: string }>
  failed: Array<{ name: string; reason: string }>
}

const DEFAULT_WORKTREE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const WORKTREE_METADATA_DIR = '.metadata'
const MANAGED_BRANCH_PREFIX = 'agentdeck/'

/** Preserve process exit status and stderr. Empty stdout is a valid result. */
export function runGit(workdir: string, args: string[], timeout = 15000): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    execFile('git', ['-C', workdir, ...args], { timeout, windowsHide: true }, (err, stdout, stderr) => {
      const error = err as NodeJS.ErrnoException | null
      resolve({
        ok: !error,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? '') || (error ? String(error.message ?? error) : ''),
        code: !error ? 0 : typeof error.code === 'number' ? error.code : -1
      })
    })
  })
}

async function git(workdir: string, args: string[], timeout = 15000): Promise<string> {
  const result = await runGit(workdir, args, timeout)
  return result.ok ? result.stdout : ''
}

function gitError(result: GitCommandResult): string {
  const detail = (result.stderr || result.stdout).trim()
  return `git exit ${result.code ?? 'unknown'}${detail ? `: ${detail.slice(0, 500)}` : ''}`
}

export async function isGitRepo(workdir: string): Promise<boolean> {
  if (!workdir) return false
  const out = await git(workdir, ['rev-parse', '--is-inside-work-tree'])
  return out.trim() === 'true'
}

/** 分支是否存在（二层委派集成时探测子任务的集成分支） */
export async function branchExists(workdir: string, name: string): Promise<boolean> {
  if (!workdir || !name) return false
  // rev-parse --verify --quiet：存在 → 输出哈希；不存在 → 空输出
  return (await git(workdir, ['rev-parse', '--verify', '--quiet', name])).trim() !== ''
}

export async function snapshotGitAfter(
  workdir: string
): Promise<{ diff: string; stat: string }> {
  if (!workdir) return { diff: '', stat: '' }
  const isRepo = await isGitRepo(workdir)
  if (!isRepo) return { diff: '', stat: '' }
  const [stat, diff] = await Promise.all([
    git(workdir, ['diff', '--stat']),
    git(workdir, ['diff'])
  ])
  const untracked = await git(workdir, ['ls-files', '--others', '--exclude-standard'])
  const untrackedBlock = untracked
    ? '\n# 未跟踪文件:\n' + untracked
        .split('\n')
        .filter(Boolean)
        .map((f) => `+ ${f}`)
        .join('\n')
    : ''
  return {
    diff: (diff + untrackedBlock).trim().slice(0, 200_000),
    stat: (stat.trim() + (untracked ? `\n未跟踪: ${untracked.split('\n').filter(Boolean).length} 个文件` : '')).trim()
  }
}

// ---- Squad worktree 支持 ----

function gitFail(workdir: string, args: string[]): Promise<{ ok: false; stderr: string }> {
  return new Promise((resolve) => {
    execFile('git', ['-C', workdir, ...args], { timeout: 30000, windowsHide: true }, (err, _out, stderr) => {
      resolve({ ok: false as const, stderr: (stderr || String(err)).slice(0, 500) })
    })
  })
}

/** 当前分支名；detached 时返回空 */
export async function currentBranch(workdir: string): Promise<string> {
  const out = await git(workdir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return out.trim()
}

function commonGitDir(repoDir: string, gcd?: string) {
  return gcd ? path.resolve(repoDir, gcd) : path.join(repoDir, '.git')
}

async function repositoryRoot(repoDir: string): Promise<string | null> {
  if (!(await isGitRepo(repoDir))) return null
  const gcd = (await git(repoDir, ['rev-parse', '--git-common-dir'])).trim()
  return path.dirname(commonGitDir(repoDir, gcd))
}

/** Capability probe used by callers that need an explicit non-Git downgrade. */
export async function worktreeAvailability(workdir: string): Promise<{ available: boolean; repoDir?: string; reason?: string }> {
  if (!workdir) return { available: false, reason: 'No workspace configured; using the shared process workspace' }
  const repoDir = await repositoryRoot(workdir)
  return repoDir
    ? { available: true, repoDir }
    : { available: false, reason: 'Workspace is not a Git worktree; using the shared workspace' }
}

function managedRoot(repoDir: string) {
  return path.join(repoDir, '.agentdeck-worktrees')
}

function metadataRoot(repoDir: string) {
  return path.join(managedRoot(repoDir), WORKTREE_METADATA_DIR)
}

function metadataFile(repoDir: string, name: string) {
  return path.join(metadataRoot(repoDir), `${name}.json`)
}

function isWithin(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function validWorktreeName(name: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && name !== WORKTREE_METADATA_DIR
}

function writeMetadata(metadata: WorktreeInfo) {
  const file = metadataFile(metadata.repoDir, path.basename(metadata.path))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(metadata, null, 2))
  fs.renameSync(tmp, file)
}

function readMetadataFile(file: string): WorktreeInfo | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<WorktreeInfo>
    if (typeof value.ownerTaskId !== 'string' || typeof value.repoDir !== 'string' || typeof value.path !== 'string'
      || typeof value.branch !== 'string' || typeof value.baseSha !== 'string' || typeof value.createdAt !== 'number'
      || !['active', 'removed', 'retained', 'failed'].includes(value.cleanupStatus ?? '')) return null
    return value as WorktreeInfo
  } catch {
    return null
  }
}

export function listWorktreeMetadata(repoDir: string): WorktreeInfo[] {
  const root = metadataRoot(repoDir)
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => readMetadataFile(path.join(root, entry.name)))
      .filter((item): item is WorktreeInfo => !!item)
  } catch {
    return []
  }
}

function updateMetadata(metadata: WorktreeInfo, patch: Partial<WorktreeInfo>) {
  const next = { ...metadata, ...patch }
  try { writeMetadata(next) } catch {}
  return next
}

/** 为 worker 创建隔离 worktree（含独立分支）；失败返回 null（回退共享目录）
 *  worktree 一律放在主仓库根的 .agentdeck-worktrees 下——从 worktree 再开（二层委派）也归位主仓库，
 *  避免嵌套进父级工作树污染其 status；exclude 也写进主 gitdir（worktree 间共享）。 */
export async function createWorktree(
  repoDir: string,
  name: string,
  baseBranch?: string,
  ownerTaskId = ''
): Promise<WorktreeCreateResult | null> {
  if (!(await isGitRepo(repoDir)) || !validWorktreeName(name)) return null
  const branch = `agentdeck/${name}`
  const gcd = (await git(repoDir, ['rev-parse', '--git-common-dir'])).trim()
  const gitDir = commonGitDir(repoDir, gcd)
  const root = path.dirname(gitDir)
  const worktreeDir = managedRoot(root)
  const wtPath = path.join(worktreeDir, name)
  if (!isWithin(worktreeDir, wtPath)) return null
  const baseSha = (await git(repoDir, ['rev-parse', baseBranch || 'HEAD'])).trim()
  if (!baseSha) return null
  fs.mkdirSync(worktreeDir, { recursive: true })
  const out = await runGit(repoDir, ['worktree', 'add', '-b', branch, wtPath, ...(baseBranch ? [baseBranch] : [])], 60000)
  if (!out.ok && !(await isGitRepo(wtPath))) return null
  // 把 worktree 目录从主仓库状态里排除，避免污染主目录的 status
  const excludeFile = path.join(gitDir, 'info', 'exclude')
  try {
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true })
    const cur = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf8') : ''
    if (!cur.includes('.agentdeck-worktrees/')) {
      fs.appendFileSync(excludeFile, '\n.agentdeck-worktrees/\n')
    }
  } catch {}
  const metadata: WorktreeInfo = {
    ownerTaskId,
    repoDir: root,
    path: wtPath,
    branch,
    baseSha,
    createdAt: Date.now(),
    cleanupStatus: 'active'
  }
  try { writeMetadata(metadata) } catch {}
  return { path: wtPath, branch, metadata }
}

/** 把 workdir 里所有改动（含未跟踪）提交到当前分支；agent 身份；无改动返回 false */
export async function commitAll(workdir: string, message: string): Promise<boolean> {
  if (!(await isGitRepo(workdir))) return false
  const status = await git(workdir, ['status', '--porcelain'])
  if (!status.trim()) return false
  // 排除常见生成物（worker 运行时产生的缓存/构建产物）；此 git 不支持 :! 简写，用长格式
  const added = await runGit(workdir, ['add', '-A', '--', '.', ':(exclude)__pycache__', ':(exclude)*.pyc', ':(exclude)node_modules', ':(exclude)dist', ':(exclude)build'])
  if (!added.ok) return false
  const staged = await runGit(workdir, ['diff', '--cached', '--name-only'])
  if (!staged.ok || !staged.stdout.trim()) return false
  const committed = await runGit(workdir, ['-c', 'user.email=agentdeck@local', '-c', 'user.name=AgentDeck Worker', 'commit', '-m', message], 30000)
  return committed.ok
}

/** 在 repoDir 上把 sourceBranch merge 进 targetBranch（fast-forward 优先，不切换用户分支：用 worktree 上的 merge）
 *  返回 {ok, conflict, message} */
async function mergeBranchIntoLegacy(
  repoDir: string,
  targetBranch: string,
  sourceBranch: string
): Promise<{ ok: boolean; conflict: boolean; message: string }> {
  // 确保 target 分支存在（从当前 HEAD 建）
  const exists = await runGit(repoDir, ['rev-parse', '--verify', targetBranch])
  if (!exists.ok || !exists.stdout.trim()) {
    const created = await runGit(repoDir, ['branch', targetBranch], 30000)
    if (!created) return { ok: false, conflict: false, message: `无法创建集成分支 ${targetBranch}` }
  }
  // 在临时 worktree 中执行 merge，不动用户工作区
  const tmpName = `.agentdeck-merge-${Date.now().toString(36)}`
  const wtPath = path.join(repoDir, '.agentdeck-worktrees', tmpName)
  const added = await new Promise<boolean>((resolve) => {
    execFile(
      'git',
      ['-C', repoDir, 'worktree', 'add', wtPath, targetBranch],
      { timeout: 60000, windowsHide: true },
      (err) => resolve(!err)
    )
  })
  if (!added) return { ok: false, conflict: false, message: '无法创建合并用 worktree' }
  try {
    const merged = await new Promise<{ ok: boolean; conflict: boolean; stderr: string }>((resolve) => {
      execFile(
        'git',
        ['-C', wtPath, 'merge', '--no-ff', '-m', `merge ${sourceBranch} into ${targetBranch}`, sourceBranch],
        { timeout: 60000, windowsHide: true },
        (err, _out, stderr) => {
          const s = (stderr || '') + String(err ?? '')
          resolve({ ok: !err, conflict: /conflict/i.test(s), stderr: s.slice(0, 400) })
        }
      )
    })
    if (merged.conflict) {
      await git(wtPath, ['merge', '--abort'])
      return { ok: false, conflict: true, message: `合并 ${sourceBranch} 时有冲突，已中止` }
    }
    if (!merged.ok) return { ok: false, conflict: false, message: merged.stderr || 'merge 失败' }
    return { ok: true, conflict: false, message: '' }
  } finally {
    await new Promise<void>((resolve) => {
      execFile('git', ['-C', repoDir, 'worktree', 'remove', '--force', wtPath], { timeout: 30000, windowsHide: true }, () => resolve())
    })
  }
}

/** 集成分支 vs 基线分支的总 diff（leader 任务展示用） */
export async function branchDiffSummary(
  repoDir: string,
  baseBranch: string,
  integrationBranch: string
): Promise<{ diff: string; stat: string }> {
  const [stat, diff] = await Promise.all([
    git(repoDir, ['diff', '--stat', `${baseBranch}...${integrationBranch}`]),
    git(repoDir, ['diff', `${baseBranch}...${integrationBranch}`])
  ])
  return { diff: diff.slice(0, 200_000), stat: stat.trim().slice(0, 10_000) }
}

function metadataForPath(repoDir: string, wtDir: string) {
  const name = path.basename(path.resolve(wtDir))
  const metadata = readMetadataFile(metadataFile(repoDir, name))
  return { name, metadata }
}

async function resolveManagedWorktree(wtDir: string): Promise<{ repoDir: string; name: string; metadata: WorktreeInfo | null } | null> {
  if (!wtDir) return null
  const absolute = path.resolve(wtDir)
  const marker = `${path.sep}.agentdeck-worktrees${path.sep}`
  const normalized = `${absolute}${path.sep}`
  const markerIndex = normalized.indexOf(marker)
  if (markerIndex < 0) return null
  const root = absolute.slice(0, markerIndex)
  const managed = path.join(root, '.agentdeck-worktrees')
  if (!isWithin(managed, absolute)) return null
  const relative = path.relative(managed, absolute)
  if (relative === WORKTREE_METADATA_DIR || relative.startsWith(`${WORKTREE_METADATA_DIR}${path.sep}`)) return null
  const repoDir = await repositoryRoot(root) ?? root
  const { name, metadata } = metadataForPath(repoDir, absolute)
  return { repoDir, name, metadata }
}

async function worktreeDirty(wtDir: string) {
  if (!fs.existsSync(wtDir)) return false
  const result = await runGit(wtDir, ['status', '--porcelain', '--untracked-files=all'], 15000)
  return result.ok && !!result.stdout.trim()
}

/** Reclaim an isolated worktree with structured fail-closed status. */
export async function reclaimWorktree(
  wtDir: string,
  options: { force?: boolean; deleteBranch?: boolean } = {}
): Promise<WorktreeCleanupResult> {
  const resolved = await resolveManagedWorktree(wtDir)
  if (!resolved) return { ok: false, status: 'failed', path: wtDir, reason: 'path is outside .agentdeck-worktrees' }
  const { repoDir, name, metadata } = resolved
  // Legacy worktrees predate the sidecar but use the deterministic managed
  // branch name, so they can still be reclaimed without touching user refs.
  const branch = metadata?.branch || `${MANAGED_BRANCH_PREFIX}${name}`
  if (metadata?.manualKeep) {
    updateMetadata(metadata, { cleanupStatus: 'retained', cleanupReason: 'manual keep requested' })
    return { ok: false, status: 'retained', path: wtDir, branch, reason: 'manual keep requested' }
  }
  if (!options.force && await worktreeDirty(wtDir)) {
    if (metadata) updateMetadata(metadata, { cleanupStatus: 'retained', cleanupReason: 'uncommitted changes' })
    return { ok: false, status: 'retained', path: wtDir, branch, reason: 'uncommitted changes' }
  }
  if (!fs.existsSync(wtDir)) {
    await runGit(repoDir, ['worktree', 'prune'], 15000)
  } else {
    const removed = await runGit(repoDir, ['worktree', 'remove', ...(options.force ? ['--force'] : []), wtDir], 30000)
    if (!removed.ok) {
      const reason = gitError(removed)
      if (metadata) updateMetadata(metadata, { cleanupStatus: 'failed', cleanupReason: reason })
      return { ok: false, status: 'failed', path: wtDir, branch, reason }
    }
  }
  if (options.deleteBranch && branch && branch.startsWith(MANAGED_BRANCH_PREFIX)) {
    const present = await branchExists(repoDir, branch)
    const deleted = !present || await deleteBranch(repoDir, branch)
    if (!deleted) {
      const reason = `worktree removed but branch ${branch} could not be deleted`
      if (metadata) updateMetadata(metadata, { cleanupStatus: 'retained', cleanupReason: reason })
      return { ok: false, status: 'retained', path: wtDir, branch, reason }
    }
  }
  if (metadata) updateMetadata(metadata, { cleanupStatus: 'removed', cleanedAt: Date.now(), cleanupReason: undefined })
  return { ok: true, status: 'removed', path: wtDir, branch }
}

/** Persist a user-visible keep marker without touching the worktree itself. */
export async function setWorktreeManualKeep(wtDir: string, manualKeep = true): Promise<boolean> {
  const resolved = await resolveManagedWorktree(wtDir)
  if (!resolved?.metadata) return false
  updateMetadata(resolved.metadata, {
    manualKeep,
    cleanupStatus: manualKeep ? 'retained' : resolved.metadata.cleanupStatus,
    cleanupReason: manualKeep ? 'manual keep requested' : undefined
  })
  return true
}

/** Rebind metadata after a TaskStore allocates the child task id. */
export async function setWorktreeOwner(wtDir: string, ownerTaskId: string): Promise<boolean> {
  if (!ownerTaskId.trim()) return false
  const resolved = await resolveManagedWorktree(wtDir)
  if (!resolved?.metadata) return false
  updateMetadata(resolved.metadata, { ownerTaskId: ownerTaskId.trim() })
  return true
}

/** Update cleanup provenance when a secondary branch operation fails. */
export async function markWorktreeCleanup(
  wtDir: string,
  cleanupStatus: WorktreeCleanupStatus,
  cleanupReason?: string
): Promise<boolean> {
  const resolved = await resolveManagedWorktree(wtDir)
  if (!resolved?.metadata) return false
  updateMetadata(resolved.metadata, {
    cleanupStatus,
    cleanupReason,
    ...(cleanupStatus === 'removed' ? { cleanedAt: Date.now() } : {})
  })
  return true
}

/** Backward-compatible boolean wrapper. It is fail-closed for dirty/manual-kept trees. */
export async function removeWorktree(wtDir: string): Promise<boolean> {
  const result = await reclaimWorktree(wtDir, { deleteBranch: true })
  return result.ok
}

/** 删除分支（best-effort）。用 -D：跨 worktree 场景 -d 的"是否已合并"判定不可靠，由调用方保证内容已合入集成分支。 */
export async function deleteBranch(workdir: string, name: string): Promise<boolean> {
  if (!workdir || !name) return false
  return (await runGit(workdir, ['branch', '-D', name], 15000)).ok
}

/** 启动清扫：回收上次会话遗留的 worktree——合并临时目录（.agentdeck-merge-*，其 finally 兜不住进程被杀）
 *  和已不存在任务的委派目录（<taskId>_c<N>）。任务仍在的目录不动：可能存有未提交改动，
 *  交给任务删除钩子或人工处理。返回回收的目录名列表。 */
export async function pruneWorktrees(
  repoDir: string,
  keepTask: (taskId: string) => boolean = () => false,
  options: { maxAgeMs?: number; now?: number } = {}
): Promise<WorktreePruneResult> {
  const root = await repositoryRoot(repoDir)
  const result: WorktreePruneResult = { repoDir: root ?? repoDir, scanned: 0, removed: [], retained: [], failed: [] }
  if (!root) return result
  await runGit(root, ['worktree', 'prune'], 15000)
  const worktreeDir = managedRoot(root)
  let entries: fs.Dirent[] = []
  try { entries = fs.readdirSync(worktreeDir, { withFileTypes: true }) } catch {}
  const names = new Set(entries.filter((entry) => entry.isDirectory() && entry.name !== WORKTREE_METADATA_DIR).map((entry) => entry.name))
  for (const metadata of listWorktreeMetadata(root)) names.add(path.basename(metadata.path))
  const now = options.now ?? Date.now()
  const maxAgeMs = Math.max(0, options.maxAgeMs ?? DEFAULT_WORKTREE_MAX_AGE_MS)
  for (const name of names) {
    const wtPath = path.join(worktreeDir, name)
    const metadata = readMetadataFile(metadataFile(root, name))
    if (metadata?.cleanupStatus === 'removed' && !fs.existsSync(wtPath)) {
      if (metadata.branch.startsWith(MANAGED_BRANCH_PREFIX) && !(await branchExists(root, metadata.branch))) {
        // Already fully reclaimed; retain the sidecar as an audit record.
        continue
      }
      if (metadata.branch.startsWith(MANAGED_BRANCH_PREFIX) && await deleteBranch(root, metadata.branch)) {
        result.removed.push(name)
      } else {
        result.retained.push({ name, reason: 'worktree already removed; managed branch retained' })
      }
      continue
    }
    result.scanned++
    const owner = metadata?.ownerTaskId || name.replace(/_c\d+$/, '')
    if (owner && keepTask(owner)) {
      result.retained.push({ name, reason: 'owner task still exists' })
      continue
    }
    if (metadata?.manualKeep) {
      result.retained.push({ name, reason: 'manual keep requested' })
      continue
    }
    const stat = (() => { try { return fs.statSync(wtPath) } catch { return null } })()
    const createdAt = metadata?.createdAt ?? stat?.birthtimeMs ?? stat?.mtimeMs ?? now
    const crashLeftover = name.startsWith('.agentdeck-merge-')
    if (!crashLeftover && maxAgeMs > 0 && now - createdAt < maxAgeMs) {
      result.retained.push({ name, reason: 'within retention window' })
      continue
    }
    const reclaimed = await reclaimWorktree(wtPath, { deleteBranch: true })
    if (reclaimed.ok) result.removed.push(name)
    else if (reclaimed.status === 'retained') result.retained.push({ name, reason: reclaimed.reason ?? 'retained by policy' })
    else result.failed.push({ name, reason: reclaimed.reason ?? 'cleanup failed' })
  }
  return result
}

/** Startup compatibility wrapper returning only removed directory names. */
export async function sweepWorktrees(
  repoDir: string,
  keepTask: (taskId: string) => boolean,
  options: { maxAgeMs?: number; now?: number } = {}
): Promise<string[]> {
  // Preserve the legacy startup behavior: ownerless clean worktrees are
  // removed immediately, while dirty/manual-kept trees remain fail-closed.
  const result = await pruneWorktrees(repoDir, keepTask, {
    ...options,
    maxAgeMs: options.maxAgeMs ?? 0
  })
  return result.removed
}

/** Descriptive aliases for callers that use singular cleanup/prune terminology. */
export const cleanupWorktree = reclaimWorktree
export const pruneWorktree = pruneWorktrees

/** Structured merge implementation. The legacy helper above remains private for compatibility during migration. */
export async function mergeBranchInto(
  repoDir: string,
  targetBranch: string,
  sourceBranch: string
): Promise<{ ok: boolean; conflict: boolean; message: string }> {
  const exists = await runGit(repoDir, ['rev-parse', '--verify', targetBranch])
  if (!exists.ok || !exists.stdout.trim()) {
    const created = await runGit(repoDir, ['branch', targetBranch], 30000)
    if (!created.ok) return { ok: false, conflict: false, message: `cannot create integration branch ${targetBranch}: ${gitError(created)}` }
  }
  const tmpName = `.agentdeck-merge-${Date.now().toString(36)}`
  const wtPath = path.join(repoDir, '.agentdeck-worktrees', tmpName)
  const added = await runGit(repoDir, ['worktree', 'add', wtPath, targetBranch], 60000)
  if (!added.ok) return { ok: false, conflict: false, message: `cannot create merge worktree: ${gitError(added)}` }
  try {
    const merged = await runGit(wtPath, ['merge', '--no-ff', '-m', `merge ${sourceBranch} into ${targetBranch}`, sourceBranch], 60000)
    const detail = `${merged.stderr}\n${merged.stdout}`.trim()
    const conflict = /conflict|automatic merge failed/i.test(detail)
    if (conflict) {
      await runGit(wtPath, ['merge', '--abort'], 30000)
      return { ok: false, conflict: true, message: `merge conflict: ${detail.slice(0, 400)}` }
    }
    if (!merged.ok) return { ok: false, conflict: false, message: detail.slice(0, 400) || `git exit ${merged.code ?? 'unknown'}` }
    return { ok: true, conflict: false, message: '' }
  } finally {
    await runGit(repoDir, ['worktree', 'remove', '--force', wtPath], 30000)
  }
}
