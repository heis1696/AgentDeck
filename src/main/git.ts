// git 快照与委派 worktree 支持
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FileDiffErrorCode, FileDiffResult } from '../shared/contracts'
import type { Task, TaskGitSnapshot, WorktreeCleanupStatus, WorktreeInfo } from '../shared/types'

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
const AGENT_GIT_IDENTITY = ['-c', 'user.email=agentdeck@local', '-c', 'user.name=AgentDeck Worker'] as const

/** 运行时系统目录：领队/子单工作区里的委派 sidecar，回放与 status 视角都不该看见它们。
 *  统一走 info/exclude 忽略（不改 tracked 文件，零污染），代码里再做一层路径过滤兜底。 */
export const SYSTEM_SIDECAR_DIRS = ['.agentdeck-worktrees', '.agentdeck-reports'] as const

/** 把系统目录追加进 gitdir 的 info/exclude；幂等，只追加缺失项。
 *  判定按行拆分后整行精确匹配（子串判定会把 .agentdeck-reports-old 误认成
 *  .agentdeck-reports 已存在而跳过追加）；追加失败 warn 不静默。 */
function appendGitExcludes(gitDir: string, entries: readonly string[]) {
  const excludeFile = path.join(gitDir, 'info', 'exclude')
  try {
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true })
    const cur = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf8') : ''
    const lines = new Set(cur.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))
    const missing = entries.filter((entry) => !lines.has(`${entry}/`))
    if (missing.length) fs.appendFileSync(excludeFile, '\n' + missing.map((entry) => `${entry}/\n`).join(''))
  } catch (err) {
    console.warn(`[git] info/exclude 追加失败（${excludeFile}），系统目录可能污染 git status：`, err)
  }
}

/** 集成分支（agentdeck/task-<taskId>）持有用户尚未 merge 的唯一集成结果：
 *  启动清扫一律不得删除，只有删任务的显式回收路径（tasks:delete → removeWorktree）可以带走它。 */
export function isIntegrationBranch(name: string | undefined | null): boolean {
  return !!name && /^agentdeck\/task-[^/]+$/.test(name)
}

/** Preserve process exit status and stderr. Empty stdout is a valid result. */
export function runGit(workdir: string, args: string[], timeout = 15000, env?: NodeJS.ProcessEnv): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    execFile('git', ['-C', workdir, ...args], { timeout, windowsHide: true, env }, (err, stdout, stderr) => {
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

/** git 并发写冲突指纹：index 文件锁存在或另一 git 进程持有（回放/对齐按此重试而非立即拒单） */
export const GIT_LOCK_ERROR_RE = /index\.lock|Another git process/i

export function isGitLockError(result: GitCommandResult): boolean {
  return GIT_LOCK_ERROR_RE.test(`${result.stderr}\n${result.stdout}`)
}

const lockRetryDelayMs = (): number => 400 + Math.floor(Math.random() * 501)

/** 撞锁退避重试（共 3 次尝试，间隔 400-900ms 抖动）；耗尽仍锁死则原样返回失败结果 */
async function runGitWithLockRetry(workdir: string, args: string[], timeout = 15000, env?: NodeJS.ProcessEnv): Promise<GitCommandResult> {
  let result = await runGit(workdir, args, timeout, env)
  for (let attempt = 0; !result.ok && attempt < 2 && isGitLockError(result); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, lockRetryDelayMs()))
    result = await runGit(workdir, args, timeout, env)
  }
  return result
}

/** 锁冲突耗尽时的拒单文案后缀（非锁失败返回空串） */
function lockConflictSuffix(result: GitCommandResult): string {
  return isGitLockError(result) ? '—— 领队 git 并发写冲突，请稍后重派' : ''
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

/** 解析 ref（分支名/sha）到完整 sha；不存在返回空串（续链二次集成的本轮起点基线用） */
export async function branchHead(workdir: string, ref: string): Promise<string> {
  if (!workdir || !ref) return ''
  return (await git(workdir, ['rev-parse', '--verify', '--quiet', ref])).trim()
}

export interface GitSnapshotResult {
  diff: string
  stat: string
  snapshot: TaskGitSnapshot
}

export interface WorktreePruneLease { release(): void }

/** Preserve live task worktrees and every repository with an in-flight Git reservation.
 *  `worktree` 传入了待清理目录的 owner metadata（pruneWorktrees 注入）：续链集成 worktree
 *  （task-<id>-integrated 检出集成分支）持有用户尚未 merge 的唯一集成结果，owner 任务还在
 *  看板上就不算遗留目录——只按 owner.integration.branch 认归属，不要求 task.workdir 仍指向
 *  它（放弃窗口/用户改绑工作目录都不构成丢弃集成分支的理由；删除任务仍走连带回收）。
 *  owner 任务在册且终态 cancelled 的 worktree 同样保留（现场原样留待人工排查/删任务统一回收）。 */
export function shouldKeepTaskWorktree(
  tasks: readonly Task[],
  repoDir: string,
  ownerTaskId: string,
  worktree?: Pick<WorktreeInfo, 'path' | 'branch'>
): boolean {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const owner = tasks.find((task) => task.id === ownerTaskId)
  let related = owner
  const seen = new Set<string>()
  while (related && !seen.has(related.id)) {
    seen.add(related.id)
    if (related.status === 'queued' || related.status === 'running' || related.gitOperation !== undefined) return true
    related = related.parentTaskId ? byId.get(related.parentTaskId) : undefined
  }
  // cancelled 终态的现场原样保留（目录与分支都留）：终态即落盘对 cancelled 是例外，
  // 清扫若连分支一起收走，「保留现场」就只活到下次重启——回收统一走删任务的显式路径
  //（tasks:delete → removeWorktree 连目录带分支），清扫不得代替它。
  if (owner?.status === 'cancelled') return true
  if (owner && worktree && owner.integration?.branch && owner.integration.branch === worktree.branch) return true
  if (!ownerTaskId.startsWith('.agentdeck-merge-')) return false
  const root = path.resolve(repoDir)
  return tasks.some((task) => (task.status === 'queued' || task.status === 'running' || task.gitOperation !== undefined) && [task.worktree?.repoDir, task.workdir].some((candidate) => {
    if (!candidate) return false
    const resolved = path.resolve(candidate)
    return resolved === root || isWithin(root, resolved)
  }))
}

function snapshotFailure(scope: TaskGitSnapshot['scope'], state: 'error' | 'unavailable', reason: string): GitSnapshotResult {
  return { diff: '', stat: '', snapshot: { scope, state, reason, capturedAt: Date.now() } }
}

function snapshotSuccess(scope: TaskGitSnapshot['scope'], diff: string, stat: string): GitSnapshotResult {
  return {
    diff: diff.slice(0, 200_000),
    stat: stat.slice(0, 10_000),
    snapshot: {
      scope, state: diff.trim() || stat.trim() ? 'available' : 'clean', capturedAt: Date.now(),
      truncated: diff.length > 200_000 || stat.length > 10_000
    }
  }
}

export async function snapshotGitAfter(workdir: string): Promise<GitSnapshotResult> {
  if (!workdir) return snapshotFailure('workspace', 'unavailable', '此任务未绑定工作目录。')
  // Let Git resolve worktrees, ceilings and filesystem boundaries itself.
  // Fix only this probe's diagnostic language; do not change the host locale.
  const repo = await runGit(workdir, ['rev-parse', '--is-inside-work-tree'], 15000,
    { ...process.env, LC_ALL: 'C', LANG: 'C', LANGUAGE: 'C' })
  if (!repo.ok) {
    return repo.code === 128 && /^fatal: not a git repository \(or any\b/m.test(repo.stderr)
      ? snapshotFailure('workspace', 'unavailable', '工作目录不是 Git 仓库。')
      : snapshotFailure('workspace', 'error', gitError(repo))
  }
  if (repo.stdout.trim() !== 'true') return snapshotFailure('workspace', 'unavailable', '工作目录不是 Git 工作区。')
  // Include both index and working-tree changes, including an unborn HEAD.
  const [diff, stat, stagedDiff, stagedStat, untracked] = await Promise.all([
    runGit(workdir, ['diff', '--no-ext-diff', '--no-textconv']),
    runGit(workdir, ['diff', '--no-ext-diff', '--no-textconv', '--stat']),
    runGit(workdir, ['diff', '--cached', '--no-ext-diff', '--no-textconv']),
    runGit(workdir, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--stat']),
    runGit(workdir, ['ls-files', '--others', '--exclude-standard', '-z'])
  ])
  const failed = [diff, stat, stagedDiff, stagedStat, untracked].find((result) => !result.ok)
  if (failed) return snapshotFailure('workspace', 'error', gitError(failed))
  const paths = untracked.stdout.split('\0').filter(Boolean)
  const untrackedBlock = paths.length ? '# 未跟踪文件:\n' + paths.map((file) => `+ ${JSON.stringify(file)}`).join('\n') : ''
  return snapshotSuccess('workspace',
    [diff.stdout.trim(), stagedDiff.stdout.trim(), untrackedBlock].filter(Boolean).join('\n'),
    [stat.stdout.trim(), stagedStat.stdout.trim(), paths.length ? `未跟踪: ${paths.length} 个文件` : ''].filter(Boolean).join('\n'))
}

// ---- 单文件未提交 diff（编辑详情：渲染层右侧只读代码分页） ----

/** 展示用 diff 文本上限（字符，256KB）：超出按行截断并置 truncated；± 行数仍按全量 numstat 统计。 */
export const FILE_DIFF_MAX_CHARS = 256 * 1024

const FILE_DIFF_TIMEOUT_MS = 15000
/** core.quotepath=false：中文文件名不转义成 \346\226\207 八进制串，渲染层直接可读。
 *  --no-ext-diff：用户全局配置的外部 diff 驱动（difftastic 等）不劫持输出。 */
const FILE_DIFF_PREFIX = ['-c', 'core.quotepath=false'] as const
const FILE_DIFF_OPTS = ['--no-ext-diff', '--unified=3'] as const

/** 统一失败形状：渲染层永远拿到完整字段，不必处理 reject。 */
export function fileDiffFailure(file: string, code: FileDiffErrorCode, error: string): FileDiffResult {
  return { ok: false, file, additions: 0, deletions: 0, diff: '', binary: false, truncated: false, code, error }
}

function fileDiffClean(file: string): FileDiffResult {
  return { ok: true, file, additions: 0, deletions: 0, diff: '', binary: false, truncated: false, note: 'clean' }
}

/** 仓库相对路径归一化：反斜杠转正斜杠；拒绝绝对路径/盘符/`..` 逃逸。
 *  IPC 边界已校验一次，这里再兜一层（本函数也被非 IPC 调用方复用）。 */
export function normalizeRepoFilePath(file: string): string | null {
  const raw = String(file ?? '').trim().replace(/\\/g, '/')
  if (!raw || raw.includes('\0')) return null
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return null
  const segments: string[] = []
  for (const segment of raw.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') return null
    segments.push(segment)
  }
  return segments.length ? segments.join('/') : null
}

/** 解析 `--numstat`：`<+>\t<->\t<path>`；二进制行是 `-\t-`（行数不可数，只置 binary）。 */
function parseNumstat(stdout: string): { additions: number; deletions: number; binary: boolean; entries: number } {
  let additions = 0
  let deletions = 0
  let binary = false
  let entries = 0
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    entries++
    const [added, removed] = line.split('\t')
    if (added === '-' || removed === '-') { binary = true; continue }
    const plus = Number.parseInt(added ?? '', 10)
    const minus = Number.parseInt(removed ?? '', 10)
    if (Number.isInteger(plus)) additions += plus
    if (Number.isInteger(minus)) deletions += minus
  }
  return { additions, deletions, binary, entries }
}

function isBinaryDiff(text: string): boolean {
  return /(^|\n)Binary files /.test(text) || text.includes('GIT binary patch')
}

/** 多段 diff 按序拼接（未暂存在前、已暂存在后），每段补齐结尾换行。 */
function joinDiffSections(sections: string[]): string {
  return sections
    .filter((text) => text.trim() !== '')
    .map((text) => (text.endsWith('\n') ? text : `${text}\n`))
    .join('')
}

/** 超限按行截断（保留结尾换行，避免半行）。 */
function truncateDiff(text: string): { diff: string; truncated: boolean } {
  if (text.length <= FILE_DIFF_MAX_CHARS) return { diff: text, truncated: false }
  const head = text.slice(0, FILE_DIFF_MAX_CHARS)
  const boundary = head.lastIndexOf('\n')
  return { diff: boundary >= 0 ? head.slice(0, boundary + 1) : head, truncated: true }
}

/** 单文件未提交改动的统一 diff（git 权威，只读，不改索引）。
 *  - 未暂存段 `git diff --unified=3 -- <file>`：索引 → 工作区
 *  - 已暂存段 `git diff --cached --unified=3 -- <file>`：HEAD → 索引
 *  两段按序拼接（未跟踪新文件改走 `--no-index`，git 退出码 1 = 有差异，属正常）。
 *  失败一律返回 fileDiffFailure（带 code），不抛异常。 */
export async function fileDiff(workdir: string, file: string): Promise<FileDiffResult> {
  const relative = normalizeRepoFilePath(file)
  if (!relative) return fileDiffFailure(String(file ?? ''), 'bad-request', '文件路径必须是仓库相对路径')
  if (!workdir) return fileDiffFailure(relative, 'no-workdir', '任务没有绑定工作目录')
  let stat: fs.Stats | null = null
  try { stat = fs.statSync(workdir) } catch { stat = null }
  if (!stat?.isDirectory()) return fileDiffFailure(relative, 'no-workdir', `工作目录不存在或不是目录: ${workdir}`)
  if (!(await isGitRepo(workdir))) return fileDiffFailure(relative, 'not-a-repo', '工作目录不是 Git 仓库')

  const tracked = (await runGit(workdir, ['ls-files', '--error-unmatch', '--', relative], FILE_DIFF_TIMEOUT_MS)).ok
  if (!tracked) {
    let exists = false
    try { exists = fs.statSync(path.resolve(workdir, relative)).isFile() } catch { exists = false }
    if (!exists) return fileDiffFailure(relative, 'file-missing', `文件不存在: ${relative}`)
    // 未跟踪新文件不在 `git diff` 视野内：用 --no-index 对 /dev/null 生成「新增整文件」diff
    // （注意用相对路径，否则 git 会把绝对路径写进 +++ 头）
    const [text, numstat] = await Promise.all([
      runGit(workdir, [...FILE_DIFF_PREFIX, 'diff', '--no-index', ...FILE_DIFF_OPTS, '--', '/dev/null', relative], FILE_DIFF_TIMEOUT_MS),
      runGit(workdir, [...FILE_DIFF_PREFIX, 'diff', '--no-index', '--numstat', '--', '/dev/null', relative], FILE_DIFF_TIMEOUT_MS)
    ])
    const failed = [text, numstat].find((result) => !result.ok && result.code !== 1)
    if (failed) return fileDiffFailure(relative, 'git-failed', gitError(failed))
    const counts = parseNumstat(numstat.stdout)
    const binary = counts.binary || isBinaryDiff(text.stdout)
    const { diff, truncated } = truncateDiff(binary ? '' : joinDiffSections([text.stdout]))
    return { ok: true, file: relative, additions: counts.additions, deletions: counts.deletions, diff, binary, truncated }
  }

  const [unstaged, staged, unstagedStat, stagedStat] = await Promise.all([
    runGit(workdir, [...FILE_DIFF_PREFIX, 'diff', ...FILE_DIFF_OPTS, '--', relative], FILE_DIFF_TIMEOUT_MS),
    runGit(workdir, [...FILE_DIFF_PREFIX, 'diff', '--cached', ...FILE_DIFF_OPTS, '--', relative], FILE_DIFF_TIMEOUT_MS),
    // numstat 与 diff 分开取：截断只影响展示文本，± 行数始终是全量真值
    runGit(workdir, [...FILE_DIFF_PREFIX, 'diff', '--numstat', '--', relative], FILE_DIFF_TIMEOUT_MS),
    runGit(workdir, [...FILE_DIFF_PREFIX, 'diff', '--cached', '--numstat', '--', relative], FILE_DIFF_TIMEOUT_MS)
  ])
  const failed = [unstaged, staged, unstagedStat, stagedStat].find((result) => !result.ok)
  if (failed) return fileDiffFailure(relative, 'git-failed', gitError(failed))
  const unstagedCounts = parseNumstat(unstagedStat.stdout)
  const stagedCounts = parseNumstat(stagedStat.stdout)
  // 文件存在但没有未提交改动：交渲染层回退事件里的 +/- 参数快照
  if (unstagedCounts.entries + stagedCounts.entries === 0) return fileDiffClean(relative)
  const binary = unstagedCounts.binary || stagedCounts.binary || isBinaryDiff(unstaged.stdout) || isBinaryDiff(staged.stdout)
  const { diff, truncated } = truncateDiff(binary ? '' : joinDiffSections([unstaged.stdout, staged.stdout]))
  return {
    ok: true,
    file: relative,
    additions: unstagedCounts.additions + stagedCounts.additions,
    deletions: unstagedCounts.deletions + stagedCounts.deletions,
    diff,
    binary,
    truncated
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
  writeMetadata(next)
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
  appendGitExcludes(gitDir, SYSTEM_SIDECAR_DIRS)
  const metadata: WorktreeInfo = {
    ownerTaskId,
    repoDir: root,
    path: wtPath,
    branch,
    baseSha,
    createdAt: Date.now(),
    cleanupStatus: 'active'
  }
  try { writeMetadata(metadata) } catch {
    // Do not report a successful isolated worktree whose ownership metadata
    // could not be persisted. Best-effort rollback prevents an untracked
    // managed branch from leaking into the repository.
    await runGit(root, ['worktree', 'remove', '--force', wtPath], 30000)
    await deleteBranch(root, branch)
    return null
  }
  return { path: wtPath, branch, metadata }
}

/** 为领队创建检出**既有分支**（集成分支）的托管 worktree——不建新分支。
 *  与 createWorktree 同一登记/回收渠道（owner metadata + 删任务连带回收 + 启动清扫）；
 *  元数据写失败回滚 worktree 但**绝不删分支**：集成分支承载集成结果。
 *  同名目录已存在（上一轮集成建过）时，仅当它恰好检出目标分支才复用；失败返回 null。 */
export async function createWorktreeAtBranch(
  repoDir: string,
  name: string,
  branch: string,
  ownerTaskId = ''
): Promise<WorktreeCreateResult | null> {
  if (!(await isGitRepo(repoDir)) || !validWorktreeName(name) || !branch) return null
  const gcd = (await git(repoDir, ['rev-parse', '--git-common-dir'])).trim()
  const gitDir = commonGitDir(repoDir, gcd)
  const root = path.dirname(gitDir)
  const worktreeDir = managedRoot(root)
  const wtPath = path.join(worktreeDir, name)
  if (!isWithin(worktreeDir, wtPath)) return null
  const baseSha = (await git(root, ['rev-parse', '--verify', '--quiet', branch])).trim()
  if (!baseSha) return null
  fs.mkdirSync(worktreeDir, { recursive: true })
  const added = await runGit(root, ['worktree', 'add', wtPath, branch], 60000)
  if (!added.ok && (!(await isGitRepo(wtPath)) || (await currentBranch(wtPath)) !== branch)) return null
  // 把 worktree 目录从主仓库状态里排除，避免污染主目录的 status（与 createWorktree 同一约定）
  appendGitExcludes(gitDir, SYSTEM_SIDECAR_DIRS)
  const metadata: WorktreeInfo = {
    ownerTaskId,
    repoDir: root,
    path: wtPath,
    branch,
    baseSha,
    createdAt: Date.now(),
    cleanupStatus: 'active'
  }
  try { writeMetadata(metadata) } catch {
    await runGit(root, ['worktree', 'remove', '--force', wtPath], 30000)
    return null
  }
  return { path: wtPath, branch, metadata }
}

// ---- 队员终态回灌的改动摘录（只读；集成期 commitAll 在循环后才跑，反馈时全是未提交改动） ----

export interface WorktreeChangeDigest {
  ok: boolean
  branch: string
  /** diff 基线（worktree 创建点的 baseSha；缺失时退回 HEAD） */
  baseSha: string
  stat: string
  statTruncated: boolean
  /** `--name-status` 改动清单：A/M/D/R 逐文件一行，二进制文件也占一行——diff 摘录
   *  被文本改动挤掉时，二进制/删除等改动仍凭这份清单可见 */
  nameStatus: string
  nameStatusTruncated: boolean
  diff: string
  diffTruncated: boolean
  untracked: string[]
  untrackedTruncated: boolean
  reason?: string
}

export interface WorktreeChangeDigestBudgets {
  /** diff 摘要字符预算（超限按行截断并留标记） */
  diffChars: number
  /** 文件清单行数上限 */
  statLines: number
  /** 文件清单字符预算（超长路径的清单也要截） */
  statChars: number
  /** 未跟踪文件名数量上限 */
  untrackedNames: number
  /** name-status 清单行数上限（缺省 40） */
  nameStatusLines?: number
}

/** 对 worktree 基线 sha 做 `git diff`（覆盖已暂存+未暂存的已跟踪改动）并列出未跟踪文件。
 *  全程只读；任何 git 失败都降级为 ok:false——回灌绝不因摘录失败而阻塞。 */
export async function worktreeChangeDigest(
  wtDir: string,
  meta: Pick<WorktreeInfo, 'branch' | 'baseSha'>,
  budgets: WorktreeChangeDigestBudgets
): Promise<WorktreeChangeDigest> {
  const empty = (reason: string): WorktreeChangeDigest => ({
    ok: false, branch: meta?.branch ?? '', baseSha: meta?.baseSha ?? '',
    stat: '', statTruncated: false, nameStatus: '', nameStatusTruncated: false,
    diff: '', diffTruncated: false, untracked: [], untrackedTruncated: false, reason
  })
  if (!wtDir) return empty('no workdir')
  const baseRef = meta?.baseSha || 'HEAD'
  const [stat, diff, nameStatus, untracked] = await Promise.all([
    runGit(wtDir, ['diff', '--no-ext-diff', '--no-textconv', '--stat', baseRef]),
    runGit(wtDir, ['diff', '--no-ext-diff', '--no-textconv', baseRef]),
    runGit(wtDir, ['diff', '--no-ext-diff', '--no-textconv', '--name-status', baseRef]),
    runGit(wtDir, ['ls-files', '--others', '--exclude-standard', '-z'])
  ])
  if (!stat.ok || !diff.ok || !nameStatus.ok) return empty(gitError(!stat.ok ? stat : !diff.ok ? diff : nameStatus))
  const untrackedPaths = untracked.ok ? untracked.stdout.split('\0').filter(Boolean) : []
  const cutLines = (text: string, maxLines: number, maxChars: number): { text: string; truncated: boolean } => {
    const lines = text.replace(/\n$/, '').split('\n').filter((line) => line.trim() !== '')
    const kept: string[] = []
    let used = 0
    let truncated = false
    for (const line of lines) {
      if (kept.length >= maxLines || used + line.length + 1 > maxChars) {
        truncated = kept.length < lines.length
        break
      }
      kept.push(line)
      used += line.length + 1
    }
    return { text: kept.join('\n'), truncated }
  }
  const cutDiff = (text: string): { text: string; truncated: boolean } => {
    if (text.length <= budgets.diffChars) return { text: text.replace(/\n$/, ''), truncated: false }
    const head = text.slice(0, budgets.diffChars)
    const boundary = head.lastIndexOf('\n')
    return { text: (boundary > 0 ? head.slice(0, boundary) : head).replace(/\n$/, ''), truncated: true }
  }
  const statCut = cutLines(stat.stdout, budgets.statLines, budgets.statChars)
  const nameStatusCut = cutLines(nameStatus.stdout, budgets.nameStatusLines ?? 40, Number.MAX_SAFE_INTEGER)
  const diffCut = cutDiff(diff.stdout)
  return {
    ok: true,
    branch: meta?.branch ?? '',
    baseSha: baseRef,
    stat: statCut.text,
    statTruncated: statCut.truncated,
    nameStatus: nameStatusCut.text,
    nameStatusTruncated: nameStatusCut.truncated,
    diff: diffCut.text,
    diffTruncated: diffCut.truncated,
    untracked: untrackedPaths.slice(0, budgets.untrackedNames),
    untrackedTruncated: untrackedPaths.length > budgets.untrackedNames
  }
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
  const committed = await runGit(workdir, [...AGENT_GIT_IDENTITY, 'commit', '-m', message], 30000)
  return committed.ok
}

// ---- 队员报告全文副本（主仓库根 .agentdeck-reports/，摘要回灌之外的持久全文通道） ----

/** 报告副本目录名（统一落主仓库根；info/exclude 忽略，不污染 status） */
export const REPORTS_DIR_NAME = '.agentdeck-reports'

/** 主仓库根解析（worktree 内外一致；非仓库返回 null） */
export async function resolveRepositoryRoot(workdir: string): Promise<string | null> {
  if (!workdir) return null
  return repositoryRoot(workdir)
}

/** 把一份队员报告全文写进主仓库根的报告目录；返回副本绝对路径，失败返回 null（best-effort，
 *  绝不阻塞回灌主链路）。worktree 内写入同样归位主仓库根（git-common-dir 解析）——
 *  领队续链切到托管 worktree 后副本不再散落在随时可能被回收的 worktree 里。
 *  同名单被后到的终态覆盖，文件头自带 runId 防串轮。 */
export async function writeReportCopy(leaderWorkdir: string, childId: string, markdown: string): Promise<string | null> {
  if (!leaderWorkdir || !childId || !markdown.trim()) return null
  try {
    const root = (await repositoryRoot(leaderWorkdir)) ?? leaderWorkdir
    if (await isGitRepo(root)) {
      const gcd = (await git(root, ['rev-parse', '--git-common-dir'])).trim()
      if (gcd) appendGitExcludes(commonGitDir(root, gcd), SYSTEM_SIDECAR_DIRS)
    }
    const dir = path.join(root, REPORTS_DIR_NAME)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${childId}.md`)
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, markdown)
    fs.renameSync(tmp, file)
    return file
  } catch {
    return null
  }
}

/** 按领队 cwd 重算副本相对指引（worktree 内的领队拿到 `../.agentdeck-reports/<id>.md` 形态） */
export function reportCopyRelPath(leaderWorkdir: string, copyAbsPath: string): string {
  return path.relative(path.resolve(leaderWorkdir), path.resolve(copyAbsPath)).split(path.sep).join('/')
}

/** 报告副本 GC（挂线一/二共用）：按任务 id 清掉对应副本文件；幂等，缺失忽略。返回删除的绝对路径 */
export function deleteReportCopies(repoDirs: readonly (string | undefined | null)[], taskIds: readonly string[]): string[] {
  const removed: string[] = []
  for (const root of new Set(repoDirs.filter(Boolean).map((dir) => path.resolve(dir as string)))) {
    for (const id of taskIds) {
      const file = path.join(root, REPORTS_DIR_NAME, `${id}.md`)
      try { fs.unlinkSync(file); removed.push(file) } catch { /* 缺失或不可删：幂等跳过 */ }
    }
  }
  return removed
}

/** 报告副本 GC（挂线三：启动清扫）：孤儿副本（任务已不在册）删除，在册副本保留。
 *  repoDir 可以是主仓库根或任一 worktree（统一归位主仓库根解析）。 */
export async function sweepReportCopies(
  repoDir: string,
  keepTaskId: (taskId: string) => boolean
): Promise<{ removed: string[]; kept: number }> {
  const root = (await resolveRepositoryRoot(repoDir)) ?? repoDir
  const dir = path.join(root, REPORTS_DIR_NAME)
  let entries: fs.Dirent[] = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return { removed: [], kept: 0 } }
  const removed: string[] = []
  let kept = 0
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const id = entry.name.slice(0, -3)
    if (!id || keepTaskId(id)) { kept++; continue }
    try { fs.unlinkSync(path.join(dir, entry.name)); removed.push(entry.name) } catch { /* 不可删留下轮 */ }
  }
  return { removed, kept }
}

// ---- 子单基线回放（B：领队未提交增量进子单，multica「工作区即状态」不变量的移植） ----

/** 回放增量体量闸：文件数与总体积上限（对齐 multica 的 untracked replayable 检查） */
export const REPLAY_MAX_FILES = 2000
export const REPLAY_MAX_BYTES = 200 * 1024 * 1024

export interface BaselineReplayResult {
  /** applied = 已回放并改写子分支基线；skipped = 领队无未提交增量（零开销路径）；
   *  refused = 采集/应用失败或体量超限（调用方具名拒建单，不静默） */
  status: 'applied' | 'skipped' | 'refused'
  /** applied 时的回放提交（子分支新 tip，digest/集成以它为基线） */
  commitSha: string
  /** 回放增量文件数（已跟踪改动 + 未跟踪；UI 说明「含领队回放基线 N 文件」用） */
  files: number
  /** 未跟踪部分总字节（体量说明用） */
  bytes: number
  reason: string
}

const replayRefused = (reason: string): BaselineReplayResult => ({ status: 'refused', commitSha: '', files: 0, bytes: 0, reason })
const replaySkipped = (reason: string): BaselineReplayResult => ({ status: 'skipped', commitSha: '', files: 0, bytes: 0, reason })

function splitUntracked(stdout: string): string[] {
  return stdout.split('\0').filter(Boolean).filter((rel) => !SYSTEM_SIDECAR_DIRS.some((dir) => rel === dir || rel.startsWith(`${dir}/`) || rel.startsWith(`${dir}\\`)))
}

function pathspecExcludes(): string[] {
  // glob 形态：直接点名被忽略目录本身会触发 git 的 ignored-paths 报错（exit 1），
  // glob 深度形态不会——与 multica 的 snapshot excludes 同一写法
  return SYSTEM_SIDECAR_DIRS.flatMap((dir) => [`:(exclude,glob)**/${dir}/**`])
}

/**
 * 把领队工作区的未提交增量（已跟踪改动 + 未提交文件）回放进刚建好的子 worktree：
 * 私有临时 index（GIT_INDEX_FILE 指向副本）上 add -A → write-tree → commit-tree
 * （parent = 子基线 sha）→ 子 worktree cherry-pick --no-commit 应用 → reset --soft
 * 推进子分支到回放提交。全程不碰领队 index/工作区/refs，零 stash 零 reset 用户区。
 *
 * 锁加固：全部 git 调用注入 GIT_OPTIONAL_LOCKS=0（只读命令不再 opportunistic 拿
 * index 锁，领队侧持有 index.lock 时盘点照常），且任何步骤撞 index.lock /
 * Another git process 都退避重试（400-900ms 抖动 × 2）而非立即拒单；重试耗尽才拒，
 * 拒单文案指明「领队 git 并发写冲突，请稍后重派」。
 *
 * 回放提交即子分支起始提交（子分支 tip = 回放提交）：此后 digest/集成都以它为基线，
 * 领队的改动不算子产出、不进子 git 小节。失败一律 refused + 具名原因，由调用方拒建单。
 * 体量闸先行：未跟踪文件数 >2000、总体积 >200MiB 或含软链 → 拒（gitignore 掉的依赖
 * 目录本就不在增量里；子单需要完整依赖时领队应先提交 lockfile——文档写明的边界）。
 * 未跟踪盘点（ls-files）超时即拒单：大仓盘点限时 15s（含锁退避重试），宁可拒建单
 * 回灌原因让领队改派，也不拿残缺增量当基线静默回放。
 */
export async function replayLeaderBaseline(leaderWorkdir: string, childWorkdir: string, childBaseSha: string): Promise<BaselineReplayResult> {
  if (!leaderWorkdir || !childWorkdir || !childBaseSha) return replayRefused('回放前置缺失：workdir 或子基线为空')
  // 全程禁 opportunistic index 锁：只读盘点在领队侧 index.lock 存在时也照常执行
  const lockEnv: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
  // 体量闸先行（只读）：未跟踪清单 + 已跟踪改动一次盘明，零增量直接走零开销路径；
  // 未跟踪盘点（ls-files）超时即拒单——不拿残缺清单当基线回放
  const [list, quiet, trackedNames] = await Promise.all([
    runGitWithLockRetry(leaderWorkdir, ['ls-files', '--others', '--exclude-standard', '-z'], 15000, lockEnv),
    runGitWithLockRetry(leaderWorkdir, ['diff', '--quiet', 'HEAD'], 15000, lockEnv),
    runGitWithLockRetry(leaderWorkdir, ['diff', '--name-only', 'HEAD'], 15000, lockEnv)
  ])
  if (!list.ok) return replayRefused(`无法盘点领队未跟踪文件：${gitError(list)}${lockConflictSuffix(list)}`)
  if (!quiet.ok && quiet.code !== 1) return replayRefused(`无法对比领队工作区与 HEAD：${gitError(quiet)}${lockConflictSuffix(quiet)}`)
  if (!trackedNames.ok) return replayRefused(`无法列出领队已跟踪改动：${gitError(trackedNames)}${lockConflictSuffix(trackedNames)}`)
  const untracked = splitUntracked(list.stdout)
  const trackedCount = trackedNames.stdout.split('\n').filter((line) => line.trim() !== '').length
  if (!trackedCount && !untracked.length) return replaySkipped('领队无未提交增量，子单零开销跳过回放')

  // lstat 体量闸：只针对未跟踪部分（已跟踪改动体量天然受仓库约束）
  let files = 0
  let bytes = 0
  const symlinks: string[] = []
  for (const rel of untracked) {
    let info: fs.Stats
    try { info = fs.lstatSync(path.join(leaderWorkdir, rel)) } catch { continue }
    if (info.isSymbolicLink()) { symlinks.push(rel); continue }
    if (!info.isFile()) continue
    files++
    bytes += info.size
    if (files > REPLAY_MAX_FILES || bytes > REPLAY_MAX_BYTES) {
      return replayRefused(`回放增量超限：未跟踪 ${files} 个文件 / ${Math.ceil(bytes / 1024 / 1024)}MiB（上限 ${REPLAY_MAX_FILES} 个 / ${REPLAY_MAX_BYTES / 1024 / 1024}MiB）——请 gitignore 或先提交`)
    }
  }
  if (symlinks.length) {
    return replayRefused(`回放增量含软链（${symlinks[0]}${symlinks.length > 1 ? ` 等 ${symlinks.length} 个` : ''}），回放不追随软链——请 gitignore、先提交或将软链移出领队工作区后重派`)
  }

  // 私有 index 采集：副本播种失败不可怕，read-tree 重建只是冷缓存
  const headResult = await runGitWithLockRetry(leaderWorkdir, ['rev-parse', 'HEAD'], 15000, lockEnv)
  const head = headResult.ok ? headResult.stdout.trim() : ''
  if (!head) return replayRefused(`领队工作区无 HEAD（空仓库），无法回放${headResult.ok ? '' : `：${gitError(headResult)}${lockConflictSuffix(headResult)}`}`)
  const tmpIndex = path.join(os.tmpdir(), `agentdeck-replay-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.index`)
  const env: NodeJS.ProcessEnv = { ...lockEnv, GIT_INDEX_FILE: tmpIndex }
  const addArgs = ['add', '-A', '--', '.', ...pathspecExcludes()]
  try {
    let seeded = false
    try {
      const rel = (await git(leaderWorkdir, ['rev-parse', '--git-path', 'index'])).trim()
      if (rel) {
        const src = path.isAbsolute(rel) ? rel : path.join(leaderWorkdir, rel)
        fs.copyFileSync(src, tmpIndex)
        seeded = true
      }
    } catch {}
    let added = await runGitWithLockRetry(leaderWorkdir, addArgs, 60000, env)
    if (!added.ok && seeded) {
      const rebuilt = await runGitWithLockRetry(leaderWorkdir, ['read-tree', head], 30000, env)
      if (rebuilt.ok) added = await runGitWithLockRetry(leaderWorkdir, addArgs, 60000, env)
    }
    if (!added.ok) return replayRefused(`私有 index 采集失败：${gitError(added)}${lockConflictSuffix(added)}`)
    const treeResult = await runGitWithLockRetry(leaderWorkdir, ['write-tree'], 60000, env)
    const tree = treeResult.stdout.trim()
    if (!treeResult.ok || !tree) return replayRefused(`write-tree 未产出树对象：${gitError(treeResult)}${lockConflictSuffix(treeResult)}`)
    const committed = await runGitWithLockRetry(leaderWorkdir, [...AGENT_GIT_IDENTITY, 'commit-tree', tree, '-p', childBaseSha, '-m', 'agentdeck: 领队未提交基线回放（子单以本提交为基线）'], 30000, env)
    if (!committed.ok) return replayRefused(`commit-tree 失败：${gitError(committed)}${lockConflictSuffix(committed)}`)
    const replaySha = committed.stdout.trim()
    if (!replaySha) return replayRefused('commit-tree 未产出提交')

    // 子 worktree 应用：parent==子基线 ⇒ cherry-pick 就是精确增量；--quit 清理 sequencer 残留，
    // reset --soft 把子分支推进到回放提交（index/worktree 已与该树一致，status 归零）
    const pick = await runGitWithLockRetry(childWorkdir, ['cherry-pick', '--no-commit', replaySha], 60000, lockEnv)
    if (!pick.ok) {
      await runGit(childWorkdir, ['cherry-pick', '--abort'], 15000, lockEnv)
      return replayRefused(`子单回放应用失败：${gitError(pick)}${lockConflictSuffix(pick)}`)
    }
    await runGit(childWorkdir, ['cherry-pick', '--quit'], 15000, lockEnv)
    const soft = await runGitWithLockRetry(childWorkdir, ['reset', '--soft', replaySha], 30000, lockEnv)
    if (!soft.ok) {
      await runGit(childWorkdir, ['reset', '--hard', childBaseSha], 30000, lockEnv)
      return replayRefused(`子分支推进到回放提交失败：${gitError(soft)}${lockConflictSuffix(soft)}`)
    }
    const clean = await runGitWithLockRetry(childWorkdir, ['status', '--porcelain'], 15000, lockEnv)
    if (clean.ok && clean.stdout.trim()) {
      await runGit(childWorkdir, ['reset', '--hard', childBaseSha], 30000, lockEnv)
      return replayRefused('回放后子 worktree 状态不自洽（status 非空），已回滚')
    }
    if (!clean.ok) return replayRefused(`回放后无法核验子 worktree 状态：${gitError(clean)}${lockConflictSuffix(clean)}`)
    // 子 worktree 元数据的 baseSha 同步改写：digest/集成的基线指向回放提交（防双算）
    const resolved = await resolveManagedWorktree(childWorkdir)
    if (resolved?.metadata) {
      try { updateMetadata(resolved.metadata, { baseSha: replaySha }) } catch {}
    }
    return { status: 'applied', commitSha: replaySha, files: trackedCount + files, bytes, reason: '' }
  } finally {
    try { fs.unlinkSync(tmpIndex) } catch {}
  }
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
): Promise<GitSnapshotResult> {
  const [stat, diff, head] = await Promise.all([
    runGit(repoDir, ['diff', '--no-ext-diff', '--no-textconv', '--stat', `${baseBranch}...${integrationBranch}`]),
    runGit(repoDir, ['diff', '--no-ext-diff', '--no-textconv', `${baseBranch}...${integrationBranch}`]),
    branchHead(repoDir, integrationBranch)
  ])
  const failed = [stat, diff].find((result) => !result.ok)
  if (failed) return snapshotFailure('integration', 'error', gitError(failed))
  const result = snapshotSuccess('integration', diff.stdout, stat.stdout.trim())
  // 记录采集时点的分支 HEAD：finalizer 据此直接观测「集成分支没动」，不从工作副本干净推断
  result.snapshot.headSha = head || undefined
  return result
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
  if (!fs.existsSync(wtDir)) return { ok: true, dirty: false }
  const result = await runGit(wtDir, ['status', '--porcelain', '--untracked-files=all'], 15000)
  if (!result.ok) return { ok: false, dirty: false }
  return { ok: true, dirty: !!result.stdout.trim() }
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
    try { updateMetadata(metadata, { cleanupStatus: 'retained', cleanupReason: 'manual keep requested' }) } catch {}
    return { ok: false, status: 'retained', path: wtDir, branch, reason: 'manual keep requested' }
  }
  const cleanliness = await worktreeDirty(wtDir)
  if (!options.force && !cleanliness.ok) {
    try { if (metadata) updateMetadata(metadata, { cleanupStatus: 'failed', cleanupReason: 'could not determine worktree status' }) } catch {}
    return { ok: false, status: 'failed', path: wtDir, branch, reason: 'could not determine worktree status' }
  }
  if (!options.force && cleanliness.dirty) {
    try { if (metadata) updateMetadata(metadata, { cleanupStatus: 'retained', cleanupReason: 'uncommitted changes' }) } catch {}
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
      try { if (metadata) updateMetadata(metadata, { cleanupStatus: 'retained', cleanupReason: reason }) } catch {}
      return { ok: false, status: 'retained', path: wtDir, branch, reason }
    }
  }
  try { if (metadata) updateMetadata(metadata, { cleanupStatus: 'removed', cleanedAt: Date.now(), cleanupReason: undefined }) } catch {
    return { ok: false, status: 'failed', path: wtDir, branch, reason: 'cleanup metadata could not be persisted' }
  }
  return { ok: true, status: 'removed', path: wtDir, branch }
}

/** Persist a user-visible keep marker without touching the worktree itself. */
export async function setWorktreeManualKeep(wtDir: string, manualKeep = true): Promise<boolean> {
  const resolved = await resolveManagedWorktree(wtDir)
  if (!resolved?.metadata) return false
  try {
    updateMetadata(resolved.metadata, {
      manualKeep,
      cleanupStatus: manualKeep ? 'retained' : resolved.metadata.cleanupStatus,
      cleanupReason: manualKeep ? 'manual keep requested' : undefined
    })
  } catch { return false }
  return true
}

/** Rebind metadata after a TaskStore allocates the child task id. */
export async function setWorktreeOwner(wtDir: string, ownerTaskId: string): Promise<boolean> {
  if (!ownerTaskId.trim()) return false
  const resolved = await resolveManagedWorktree(wtDir)
  if (!resolved?.metadata) return false
  try { updateMetadata(resolved.metadata, { ownerTaskId: ownerTaskId.trim() }) } catch { return false }
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
  try {
    updateMetadata(resolved.metadata, {
      cleanupStatus,
      cleanupReason,
      ...(cleanupStatus === 'removed' ? { cleanedAt: Date.now() } : {})
    })
  } catch { return false }
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
 *  交给任务删除钩子或人工处理。返回回收的目录名列表。
 *  keepTask 第二参传入该目录的 owner metadata（若有）：续链集成 worktree 的保留判定需要它。 */
export async function pruneWorktrees(
  repoDir: string,
  keepTask: (taskId: string, worktree?: WorktreeInfo) => boolean = () => false,
  options: { maxAgeMs?: number; now?: number; claimWorktree?: (taskId: string, mergeWorktree: boolean) => WorktreePruneLease | undefined } = {}
): Promise<WorktreePruneResult> {
  const root = await repositoryRoot(repoDir)
  const result: WorktreePruneResult = { repoDir: root ?? repoDir, scanned: 0, removed: [], retained: [], failed: [] }
  if (!root) return result
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
    result.scanned++
    const owner = metadata?.ownerTaskId || name.replace(/_c\d+$/, '')
    if (owner && keepTask(owner, metadata ?? undefined)) {
      result.retained.push({ name, reason: 'owner task or Git operation is still active' })
      continue
    }
    if (metadata?.cleanupStatus === 'removed' && !fs.existsSync(wtPath)) {
      const lease = options.claimWorktree?.(owner, name.startsWith('.agentdeck-merge-'))
      if (!lease) {
        result.retained.push({ name, reason: 'cleanup ownership could not be established' })
        continue
      }
      try {
        if (metadata.branch.startsWith(MANAGED_BRANCH_PREFIX) && !(await branchExists(root, metadata.branch))) {
          // Already fully reclaimed; retain the sidecar as an audit record.
          continue
        }
        if (isIntegrationBranch(metadata.branch)) {
          // 清扫路径禁止删集成分支：它持有用户尚未 merge 的集成结果，只有删任务的
          // 显式回收路径可以带走它（分支还在，侧车记录也随之保留作审计凭据）。
          result.retained.push({ name, reason: 'integration branch is only deletable via explicit task deletion' })
        } else if (metadata.branch.startsWith(MANAGED_BRANCH_PREFIX) && await deleteBranch(root, metadata.branch)) {
          result.removed.push(name)
        } else {
          result.retained.push({ name, reason: 'worktree already removed; managed branch retained' })
        }
      } finally {
        lease?.release()
      }
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
    const lease = options.claimWorktree?.(owner, crashLeftover)
    if (!lease) {
      result.retained.push({ name, reason: 'cleanup ownership could not be established' })
      continue
    }
    try {
      // 集成分支对清扫路径只减目录、不减分支（isIntegrationBranch 守卫）：
      // 集成结果在分支上，目录只是检出；删任务的显式路径才允许连分支一起删。
      const reclaimed = await reclaimWorktree(wtPath, { deleteBranch: !isIntegrationBranch(metadata?.branch) })
      if (reclaimed.ok) result.removed.push(name)
      else if (reclaimed.status === 'retained') result.retained.push({ name, reason: reclaimed.reason ?? 'retained by policy' })
      else result.failed.push({ name, reason: reclaimed.reason ?? 'cleanup failed' })
    } finally {
      lease?.release()
    }
  }
  return result
}

/** Startup compatibility wrapper returning only removed directory names. */
export async function sweepWorktrees(
  repoDir: string,
  keepTask: (taskId: string, worktree?: WorktreeInfo) => boolean,
  options: { maxAgeMs?: number; now?: number; claimWorktree?: (taskId: string, mergeWorktree: boolean) => WorktreePruneLease | undefined } = {}
): Promise<string[]> {
  // Preserve the legacy startup behavior: ownerless clean worktrees are
  // removed immediately, while dirty/manual-kept trees remain fail-closed.
  const result = await pruneWorktrees(repoDir, keepTask, {
    ...options,
    maxAgeMs: options.maxAgeMs ?? 0
  })
  return result.removed
}

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
    const merged = await runGit(wtPath, [...AGENT_GIT_IDENTITY, 'merge', '--no-ff', '-m', `merge ${sourceBranch} into ${targetBranch}`, sourceBranch], 60000)
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

/** 就地把 sourceBranch merge 进托管 worktree 当前检出的分支（续链二次集成：
 *  领队 worktree 已检出集成分支，临时 worktree 再检出同一分支会被 git 拒绝）。
 *  只接受 `.agentdeck-worktrees` 下的托管目录——绝不就地改用户工作副本。
 *  前置校验（fail-closed，问题显式回报而非静默合并）：
 *  ① owner metadata 存在且（传入 expectedOwner 时）归属一致，目录的 git-common-dir
 *    确实落在声称的主仓库下——防外来仓库伪装托管路径；
 *  ② status --porcelain 干净——领队留在托管 worktree 的未提交改动不该被卷进合并。
 *  冲突即 abort，返回形状与 mergeBranchInto 一致。 */
export async function mergeIntoManagedWorktree(
  wtDir: string,
  sourceBranch: string,
  expectedOwner = ''
): Promise<{ ok: boolean; conflict: boolean; message: string }> {
  const refuse = (message: string) => ({ ok: false, conflict: false, message })
  const resolved = await resolveManagedWorktree(wtDir)
  if (!resolved) return refuse('refusing in-place merge outside .agentdeck-worktrees')
  const { repoDir, metadata } = resolved
  if (!metadata) return refuse('refusing in-place merge: worktree has no owner metadata')
  if (expectedOwner && metadata.ownerTaskId !== expectedOwner) {
    return refuse(`refusing in-place merge: worktree owner ${metadata.ownerTaskId} does not match ${expectedOwner}`)
  }
  const gcd = await runGit(wtDir, ['rev-parse', '--git-common-dir'], 15000)
  if (!gcd.ok) return refuse(`refusing in-place merge: cannot resolve git dir: ${gitError(gcd)}`)
  const gitDir = path.resolve(wtDir, gcd.stdout.trim())
  if (!(gitDir === path.resolve(repoDir, '.git') || isWithin(path.resolve(repoDir, '.git'), gitDir))) {
    return refuse(`refusing in-place merge: worktree does not belong to ${repoDir}`)
  }
  const cleanliness = await worktreeDirty(wtDir)
  if (!cleanliness.ok) return refuse('refusing in-place merge: could not determine worktree status')
  if (cleanliness.dirty) {
    return refuse('refusing in-place merge: managed worktree has uncommitted changes (commit or clean first); scene preserved')
  }
  const merged = await runGit(wtDir, [...AGENT_GIT_IDENTITY, 'merge', '--no-ff', '-m', `merge ${sourceBranch} (chain continuation)`, sourceBranch], 60000)
  const detail = `${merged.stderr}\n${merged.stdout}`.trim()
  const conflict = /conflict|automatic merge failed/i.test(detail)
  if (conflict) {
    await runGit(wtDir, ['merge', '--abort'], 30000)
    return { ok: false, conflict: true, message: `merge conflict: ${detail.slice(0, 400)}` }
  }
  if (!merged.ok) return { ok: false, conflict: false, message: detail.slice(0, 400) || `git exit ${merged.code ?? 'unknown'}` }
  return { ok: true, conflict: false, message: '' }
}

/** porcelain 脏列分类：?? 或工作副本列（第二列）有改动 = 真脏；仅暂存列（第一列）= index 陈旧形态 */
function classifyPorcelainDirt(stdout: string): { stagedOnly: boolean; realDirty: boolean } {
  let stagedOnly = false
  let realDirty = false
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    const x = line[0]
    const y = line[1]
    if (x === '?' && y === '?') { realDirty = true; continue }
    if (y && y !== ' ') { realDirty = true; continue }
    if (x && x !== ' ') stagedOnly = true
  }
  return { stagedOnly, realDirty }
}

/**
 * 幻影暂存守卫下的干净副本对齐：把托管 worktree 的 index/工作副本对齐到其检出分支当前 HEAD。
 * 判脏后先 `update-index --refresh` 再重判——刷新成功且残余脏仅在暂存列（index 陈旧，
 * 典型如 update-ref 回指后分支前进而副本停在旧提交）照常 `reset --hard` 对齐；
 * 未跟踪或工作副本列有改动 = 领队真实未落盘改动，fail-closed 拒绝对齐；
 * refresh 撞 index.lock（并发）按锁退避重试（400-900ms 抖动 × 2），耗尽 fail-closed。
 */
export async function realignCleanWorktreeToHead(wtDir: string): Promise<{ ok: boolean; reason?: string }> {
  if (!wtDir || !fs.existsSync(wtDir)) return { ok: false, reason: 'worktree directory missing' }
  const statusOnce = async () => runGit(wtDir, ['status', '--porcelain', '--untracked-files=all'], 15000)
  let status = await statusOnce()
  if (!status.ok) return { ok: false, reason: 'could not determine worktree status' }
  if (!status.stdout.trim()) return { ok: true }
  // 幻影暂存守卫：先刷新 index 的 stat 缓存再重判，stat 陈旧造成的幻影暂存就地消解
  const refreshed = await runGitWithLockRetry(wtDir, ['update-index', '--refresh'], 15000)
  if (!refreshed.ok) return { ok: false, reason: `index refresh failed: ${gitError(refreshed)}` }
  status = await statusOnce()
  if (!status.ok) return { ok: false, reason: 'could not re-determine worktree status' }
  if (!status.stdout.trim()) return { ok: true }
  const { stagedOnly, realDirty } = classifyPorcelainDirt(status.stdout)
  if (realDirty || !stagedOnly) {
    return { ok: false, reason: 'worktree has real uncommitted changes (fail-closed); scene preserved' }
  }
  const reset = await runGitWithLockRetry(wtDir, ['reset', '--hard', 'HEAD'], 30000)
  if (!reset.ok) return { ok: false, reason: `reset failed: ${gitError(reset)}` }
  const verify = await statusOnce()
  if (!verify.ok || verify.stdout.trim()) return { ok: false, reason: 'worktree not clean after realignment' }
  return { ok: true }
}

/**
 * 临时 worktree 通道（同分支双检出）：托管 worktree 已检出集成分支、就地合并又被拒
 * （非冲突）时的退路——临时 worktree 以 `--detach` 检出分支当前提交（绕开 git 的
 * 同分支单检出限制），merge 后 `update-ref` 把分支指回合并结果，最后按幻影暂存守卫
 * （realignCleanWorktreeToHead）把托管副本对齐到新 HEAD。
 * 归属校验与 mergeIntoManagedWorktree 同源；冲突即 abort；合并已落在分支上但对齐失败时
 * 返回 ok:false 并说明（分支结果保留，现场 fail-closed 留给排查）。
 */
export async function mergeIntoManagedWorktreeDetached(
  wtDir: string,
  sourceBranch: string,
  expectedOwner = ''
): Promise<{ ok: boolean; conflict: boolean; message: string }> {
  const refuse = (message: string) => ({ ok: false, conflict: false, message })
  const resolved = await resolveManagedWorktree(wtDir)
  if (!resolved) return refuse('refusing detached merge outside .agentdeck-worktrees')
  const { repoDir, metadata } = resolved
  if (!metadata) return refuse('refusing detached merge: worktree has no owner metadata')
  if (expectedOwner && metadata.ownerTaskId !== expectedOwner) {
    return refuse(`refusing detached merge: worktree owner ${metadata.ownerTaskId} does not match ${expectedOwner}`)
  }
  const branch = metadata.branch
  if (!branch) return refuse('refusing detached merge: no branch in owner metadata')
  const head = await branchHead(repoDir, branch)
  if (!head) return refuse(`refusing detached merge: branch ${branch} has no head`)
  const tmpName = `.agentdeck-merge-detach-${Date.now().toString(36)}`
  const wtPath = path.join(managedRoot(repoDir), tmpName)
  const added = await runGit(repoDir, ['worktree', 'add', '--detach', wtPath, head], 60000)
  if (!added.ok) return refuse(`cannot create detached merge worktree: ${gitError(added)}`)
  try {
    const merged = await runGit(wtPath, [...AGENT_GIT_IDENTITY, 'merge', '--no-ff', '-m', `merge ${sourceBranch} into ${branch} (detached)`, sourceBranch], 60000)
    const detail = `${merged.stderr}\n${merged.stdout}`.trim()
    const conflict = /conflict|automatic merge failed/i.test(detail)
    if (conflict) {
      await runGit(wtPath, ['merge', '--abort'], 30000)
      return { ok: false, conflict: true, message: `merge conflict: ${detail.slice(0, 400)}` }
    }
    if (!merged.ok) return { ok: false, conflict: false, message: detail.slice(0, 400) || `git exit ${merged.code ?? 'unknown'}` }
    const mergedHead = await branchHead(wtPath, 'HEAD')
    if (!mergedHead) return { ok: false, conflict: false, message: 'detached merge produced no head' }
    const moved = await runGit(repoDir, ['update-ref', `refs/heads/${branch}`, mergedHead], 15000)
    if (!moved.ok) return { ok: false, conflict: false, message: `update-ref failed: ${gitError(moved)}` }
  } finally {
    await runGit(repoDir, ['worktree', 'remove', '--force', wtPath], 30000)
  }
  // 回指后托管副本停在旧提交（index 陈旧形态）：幻影暂存守卫下对齐干净副本
  const realigned = await realignCleanWorktreeToHead(wtDir)
  if (!realigned.ok) {
    return { ok: false, conflict: false, message: `merged into ${branch} via detached worktree, but managed copy realignment failed: ${realigned.reason ?? 'unknown'}` }
  }
  return { ok: true, conflict: false, message: '' }
}
