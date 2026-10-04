// git 快照与委派 worktree 支持
import { execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FileDiffErrorCode, FileDiffResult, WorkspaceGitSummary } from '../shared/contracts'
import type { Task, TaskGitSnapshot, WorktreeCleanupStatus, WorktreeInfo } from '../shared/types'
import { currentProcessIdentity, processOwnerState } from './persistence'

export interface GitCommandResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number | null
  /** 超时击杀特征（execFile 的 killed/SIGTERM，或树杀通道的定时器触发）。
   *  调用方（createWorktree 等）凭它判失败，绝不允许落入「目录像合法就当成功」的容错。 */
  timedOut?: boolean
}

export interface WorktreeCreateResult {
  path: string
  branch: string
  metadata: WorktreeInfo
  /** worktree add 实际采用的超时（ms）——规模自适应档位的观测出口（smoke/UI 说明用） */
  addTimeoutMs?: number
  /** 规模估计的文件数（缓存命中/注入时一并带回；计数失败缺省时不带） */
  fileCount?: number
  /** true = 从复用池换基线获得（秒级，未走全量 worktree add）——观测出口，语义无差别 */
  pooled?: boolean
  /** 稀疏检出结果观测面（调用方落时间线注记用）；无此字段 = 未声明稀疏，全量原行为 */
  sparse?: WorktreeSparseOutcome
}

/** 稀疏检出（docs/WORKTREE-BIG-REPO-PERF.md §6）：applied = cone 范围生效；
 *  fallback = 回落全量（reason 供时间线注记——含被拒目录/失败原因，不静默、不拒单） */
export interface WorktreeSparseOutcome {
  status: 'applied' | 'fallback'
  /** applied 时：生效的目录前缀列表 */
  dirs?: string[]
  /** fallback 时：回落原因 */
  reason?: string
}

export interface WorktreeCleanupResult {
  ok: boolean
  status: WorktreeCleanupStatus
  path: string
  branch?: string
  reason?: string
  /** 部分成功残留清单（目录已回收但分支/git 注册仍在）：调用方据此记时间线事件，不静默 */
  residue?: string[]
}

export interface WorktreePruneResult {
  repoDir: string
  scanned: number
  removed: string[]
  retained: Array<{ name: string; reason: string }>
  failed: Array<{ name: string; reason: string; ownerTaskId?: string }>
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

/** 树杀通道自身的二次 deadline：taskkill 挂死/事件不齐时强制收口——超时路径已判败，
 *  绝不允许因「击杀通道自己 pending」把整条派单链挂住。 */
const TREE_KILL_DEADLINE_MS = 3000
/** 树杀完成（或通道收口）后给 child close 事件的宽限：窗口内正常退出按真实退出码收场，
 *  窗口外（击杀失败存活）强制按超时判败返回。 */
const TREE_KILL_CLOSE_GRACE_MS = 500

/** 进程树击杀（仅长超时命令的超时路径启用）。根因注释：那台 8.2 万文件 Unity 仓上，
 *  `git worktree add` 完整检出要 5-6 分钟，固定 60s 超时只杀 git 父进程，checkout 子进程
 *  （git reset --hard）成孤儿继续写 index——持有 .git/worktrees/<n>/index.lock 的正是它，
 *  由此引发「回放 cherry-pick 撞活锁→拒单→回收残肢→重派 branch already exists」的锁连环。
 *  win32 用 taskkill /PID <pid> /T /F 按进程树强杀（git.exe 的 reset/checkout 子进程一并带走）；
 *  posix 置独立进程组（spawn detached），超时对整组 SIGTERM，3s 后升级 SIGKILL。
 *  Promise 限时必 resolve：taskkill 通道以 close/exit 为完成信号（非零退出也算完成——
 *  树杀失败下文仍按超时判败，不在此阻塞），error（taskkill 缺失）兜底单杀，3s deadline
 *  强制收口；posix 在 SIGKILL 升级点 resolve。任何路径都不 pending。 */
function killProcessTree(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    const pid = child.pid
    if (!pid) {
      try { child.kill('SIGKILL') } catch { /* 已退出 */ }
      resolve()
      return
    }
    let done = false
    const finish = () => { if (!done) { done = true; clearTimeout(deadline); resolve() } }
    const deadline = setTimeout(finish, TREE_KILL_DEADLINE_MS)
    deadline.unref?.()
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      // close/exit 任一即完成（非零退出也算）；taskkill 缺失/失败时兜底单杀——聊胜于无
      killer.on('close', finish)
      killer.on('exit', finish)
      killer.on('error', () => { try { child.kill('SIGKILL') } catch { /* 已退出 */ } finish() })
    } else {
      try { process.kill(-pid, 'SIGTERM') } catch { try { child.kill('SIGTERM') } catch { /* 已退出 */ } }
      const escalate = setTimeout(() => {
        try { process.kill(-pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { /* 已退出 */ } }
        finish()
      }, TREE_KILL_DEADLINE_MS)
      escalate.unref?.()
    }
  })
}

/** 树杀通道的 spawn 实现：无 maxBuffer 上限（大仓 ls-files 全量输出装得下），超时整树击杀。
 *  仅 killTree 调用方使用；普通短命令继续走 execFile（行为零变化）。 */
function runGitTreeKilled(workdir: string, args: string[], timeout: number, env?: NodeJS.ProcessEnv): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', workdir, ...args], {
      windowsHide: true,
      env,
      // posix：独立进程组，超时可整组击杀；win32 靠 taskkill /T 按树杀
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let timer: NodeJS.Timeout | undefined
    let forced: NodeJS.Timeout | undefined
    const finish = (ok: boolean, code: number | null) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (forced) clearTimeout(forced)
      resolve({
        ok,
        stdout,
        stderr: stderr || (timedOut ? `git 命令超时（${timeout}ms），已发起进程树击杀` : ''),
        code,
        timedOut
      })
    }
    if (timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true
        void killProcessTree(child).then(() => {
          // 二次 deadline：树杀通道限时收口后 child 仍可能因击杀失败而存活（close 永不来）
          // ——强制 finish，超时路径绝不 pending（否则派单链整条挂死）
          forced = setTimeout(() => finish(false, null), TREE_KILL_CLOSE_GRACE_MS)
          forced.unref?.()
        })
      }, timeout)
    }
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    child.on('error', (err) => {
      timedOut = false
      if (timer) clearTimeout(timer)
      if (settled) return
      settled = true
      resolve({ ok: false, stdout, stderr: String(err), code: -1, timedOut })
    })
    child.on('close', (code) => finish(!timedOut && code === 0, timedOut ? null : code))
  })
}

/** Preserve process exit status and stderr. Empty stdout is a valid result.
 *  killTree（默认 false，仅 worktree add 等长超时命令启用）：超时路径走 spawn+进程树击杀——
 *  只杀 git 父进程会让 checkout 孤儿继续持锁，是那台机锁连环的根因（见 killProcessTree）。 */
export function runGit(workdir: string, args: string[], timeout = 15000, env?: NodeJS.ProcessEnv, killTree = false): Promise<GitCommandResult> {
  const gitEnv = env ?? repoProbeEnv()
  if (killTree) return runGitTreeKilled(workdir, args, timeout, gitEnv)
  return new Promise((resolve) => {
    execFile('git', ['-C', workdir, ...args], { timeout, windowsHide: true, env: gitEnv }, (err, stdout, stderr) => {
      const error = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null
      const timedOut = !!error && (error.killed === true || error.signal === 'SIGTERM')
      resolve({
        ok: !error,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? '') || (error ? String(error.message ?? error) : ''),
        code: !error ? 0 : typeof error.code === 'number' ? error.code : -1,
        timedOut
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

/** 工作区 git 概览（渲染契约 workspace:gitSummary）：三次轻量探测合成一张状态卡。
 *  派单页与任务详情用它回答「这个目录现在长什么样」——分支/领先落后/未提交计数/最近提交。
 *  非仓库、git 失败一律 ok:false 带码，绝不抛：UI 显示灰态而不是报错。
 *  porcelain v1 双字符 XY 解析：'??' 未跟踪；X 非 = 暂存改动；Y 非 = 未暂存改动。 */
export async function workspaceGitSummary(workdir: string): Promise<WorkspaceGitSummary> {
  const inside = await runGit(workdir, ['rev-parse', '--is-inside-work-tree'], 10_000)
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    return { ok: false, code: 'not-a-repo', error: '该目录不是 git 仓库' }
  }
  const status = await runGit(workdir, ['status', '--porcelain=v1', '-b', '--untracked-files=normal'], 15_000)
  if (!status.ok) return { ok: false, code: 'git-failed', error: gitError(status) }
  let branch: string | undefined
  let ahead: number | undefined
  let behind: number | undefined
  let staged = 0
  let unstaged = 0
  let untracked = 0
  for (const line of status.stdout.split('\n')) {
    if (line.startsWith('## ')) {
      const header = line.slice(3)
      const track = /\[(?:ahead (\d+))?(?:,\s*)?(?:behind (\d+))?\]/.exec(header)
      branch = header.split('...')[0].replace(/\s*\[.*$/, '').trim() || undefined
      ahead = track?.[1] ? Number(track[1]) : undefined
      behind = track?.[2] ? Number(track[2]) : undefined
      continue
    }
    if (line.length < 2) continue
    const x = line[0]
    const y = line[1]
    if (x === '?' && y === '?') { untracked++; continue }
    if (x !== ' ') staged++
    if (y !== ' ') unstaged++
  }
  let lastCommit: WorkspaceGitSummary['lastCommit']
  const log = await runGit(workdir, ['log', '-1', '--format=%h%x1f%s%x1f%cr'], 10_000)
  if (log.ok && log.stdout.trim()) {
    const [hash, subject, when] = log.stdout.trim().split('\x1f')
    lastCommit = { hash: hash ?? '', subject: subject ?? '', when: when ?? '' }
  }
  return { ok: true, branch, ahead, behind, staged, unstaged, untracked, lastCommit }
}

/** git 并发写冲突指纹：index 文件锁存在或另一 git 进程持有（回放/对齐按此重试而非立即拒单） */
export const GIT_LOCK_ERROR_RE = /index\.lock|Another git process/i

export function isGitLockError(result: GitCommandResult): boolean {
  return GIT_LOCK_ERROR_RE.test(`${result.stderr}\n${result.stdout}`)
}

const lockRetryDelayMs = (): number => 400 + Math.floor(Math.random() * 501)

/** 撞锁退避重试（共 3 次尝试，间隔 400-900ms 抖动）；耗尽仍锁死则原样返回失败结果 */
async function runGitWithLockRetry(workdir: string, args: string[], timeout = 15000, env?: NodeJS.ProcessEnv, killTree = false): Promise<GitCommandResult> {
  let result = await runGit(workdir, args, timeout, env, killTree)
  for (let attempt = 0; !result.ok && attempt < 2 && isGitLockError(result); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, lockRetryDelayMs()))
    result = await runGit(workdir, args, timeout, env, killTree)
  }
  return result
}

/** 锁冲突耗尽时的拒单文案后缀（非锁失败返回空串） */
function lockConflictSuffix(result: GitCommandResult): string {
  return isGitLockError(result) ? '—— 领队 git 并发写冲突，请稍后重派' : ''
}

/** 子 worktree 陈锁阈值：index.lock mtime 距今超过该值视为陈锁（残留竞态）而非活锁 */
const CHILD_STALE_LOCK_MS = 5000

/** 会劫持 git 仓库解析的定向环境变量：GIT_DIR 指向其他仓库会让 -C 解析到错误目标。
 *  默认 Git 命令与探测先剥离继承值；显式 env 仍支持回放流程的私有 GIT_INDEX_FILE。 */
const GIT_REPO_REDIRECT_ENV_KEYS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CEILING_DIRECTORIES', 'GIT_NAMESPACE'] as const

function repoProbeEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const probe: NodeJS.ProcessEnv = { ...(env ?? process.env) }
  for (const key of GIT_REPO_REDIRECT_ENV_KEYS) delete probe[key]
  return probe
}

/** 子 worktree 陈锁清除：rev-parse --git-path index.lock 定位锁路径（沿用调用方 env，
 *  与触发锁错的解析一致），仅当 mtime 距今超过 5s 才删除（返回是否删除成功）。安全前提：
 *  子 worktree 由本流程刚创建、子 agent 尚未启动、无并发写者，此刻仍在的锁只可能是建树
 *  竞态残留（进程被杀/崩溃遗留），删除不会伤害任何真实写者；领队 workdir 侧的锁一律不删
 *  ——可能属于用户真实 git 进程，只走既有退避重试。
 *  容器校验（防误删领队/主仓锁）：解析出的锁路径必须落在该子 worktree 自己的 gitdir 容器
 *  内——用剥离定向变量的干净 env 重新发现子 worktree 的真实 gitdir（即
 *  <主仓>/.git/worktrees/<子名>/）作容器前缀，路径归属判定走 isWithin（含 .. 逃逸与
 *  路径段边界，裸 startsWith 会放行 <子名>-eviltwin 这类前缀同名目录）。不在容器内
 *  （如 env 污染 GIT_DIR 指向主仓导致解析到主仓 .git/index.lock）一律拒绝删除、按重试
 *  耗尽收场——那把锁可能属于用户真实 git 进程，删了会砸掉领队侧并发写。 */
async function breakStaleChildIndexLock(childWorkdir: string, env?: NodeJS.ProcessEnv): Promise<boolean> {
  const resolved = await runGit(childWorkdir, ['rev-parse', '--git-path', 'index.lock'], 15000, env)
  const rel = resolved.ok ? resolved.stdout.trim() : ''
  if (!rel) return false
  const lockPath = path.isAbsolute(rel) ? rel : path.join(childWorkdir, rel)
  const probe = await runGit(childWorkdir, ['rev-parse', '--absolute-git-dir'], 15000, repoProbeEnv(env))
  const container = probe.ok ? path.resolve(probe.stdout.trim()) : ''
  if (!container || !isWithin(container, lockPath)) return false
  try {
    if (Date.now() - fs.statSync(lockPath).mtimeMs <= CHILD_STALE_LOCK_MS) return false
    fs.unlinkSync(lockPath)
    return true
  } catch {
    return false
  }
}

/** 子侧应用段专用（replayLeaderBaseline 的 cherry-pick/reset/status 三步）：
 *  既有撞锁退避重试之外，重试耗尽仍是锁错时检查子 worktree 的 index.lock——
 *  陈锁（mtime>5s 且锁路径落在子 worktree 自己的 gitdir 容器内）则删除后追加最后一次
 *  尝试；锁新鲜（真活锁）、锁路径越出容器（env 污染兜底，防误删领队/主仓锁）或删除失败
 *  一律按重试耗尽处理，原样返回失败结果（不无限制加时）。 */
async function runChildApplyGit(childWorkdir: string, args: string[], timeout = 15000, env?: NodeJS.ProcessEnv): Promise<GitCommandResult> {
  let result = await runGitWithLockRetry(childWorkdir, args, timeout, env)
  if (!result.ok && isGitLockError(result) && (await breakStaleChildIndexLock(childWorkdir, env))) {
    result = await runGit(childWorkdir, args, timeout, env)
  }
  return result
}

async function rollbackChildReplay(childWorkdir: string, childBaseSha: string, env: NodeJS.ProcessEnv): Promise<{ ok: boolean; reason: string }> {
  await runChildApplyGit(childWorkdir, ['reset', '--hard', childBaseSha], 30000, env)
  const [head, indexTree, baseTree, status] = await Promise.all([
    runGitWithLockRetry(childWorkdir, ['rev-parse', 'HEAD'], 15000, env),
    runGitWithLockRetry(childWorkdir, ['write-tree'], 30000, env),
    runGitWithLockRetry(childWorkdir, ['rev-parse', `${childBaseSha}^{tree}`], 15000, env),
    runChildApplyGit(childWorkdir, ['status', '--porcelain', '--untracked-files=all'], 15000, env)
  ])
  const problems: string[] = []
  if (!head.ok || head.stdout.trim() !== childBaseSha) problems.push(`HEAD 未回到子基线：${head.ok ? head.stdout.trim() : gitError(head)}`)
  if (!indexTree.ok || !baseTree.ok || indexTree.stdout.trim() !== baseTree.stdout.trim()) {
    problems.push(`index 未恢复到子基线：${!indexTree.ok ? gitError(indexTree) : !baseTree.ok ? gitError(baseTree) : 'tree 不匹配'}`)
  }
  if (!status.ok || status.stdout.trim()) problems.push(`worktree 状态未恢复干净：${status.ok ? status.stdout.trim() : gitError(status)}`)
  return problems.length
    ? { ok: false, reason: `子 worktree 回滚失败或无法核验：${problems.join('；')}` }
    : { ok: true, reason: '子 worktree HEAD、index 与工作区均已核验回到子基线' }
}

export type GitRepositoryProbeResult =
  | { status: 'repo' }
  | { status: 'not-repo'; reason?: string }
  | { status: 'error'; reason: string }

export async function probeGitRepository(workdir: string): Promise<GitRepositoryProbeResult> {
  if (!workdir) return { status: 'not-repo', reason: 'workspace not configured' }
  let result: GitCommandResult
  try {
    result = await runGit(workdir, ['rev-parse', '--is-inside-work-tree'], 15000, repoProbeEnv())
  } catch (error) {
    return { status: 'error', reason: error instanceof Error ? error.message : String(error) }
  }
  if (!result.ok) {
    const detail = `${result.stderr}\n${result.stdout}`
    if (result.code === 128 && /not a git repository/i.test(detail)) {
      const marker = gitMarkerForPath(workdir)
      if (marker) {
        return { status: 'error', reason: marker.reason ?? `Git metadata exists at ${marker.path}, but Git rejected the workspace` }
      }
      return { status: 'not-repo', reason: 'workspace is not a Git worktree' }
    }
    return { status: 'error', reason: gitError(result) }
  }
  const inside = result.stdout.trim()
  if (inside === 'true') return { status: 'repo' }
  if (inside === 'false') return { status: 'not-repo', reason: 'workspace is not a Git worktree' }
  return { status: 'error', reason: `unexpected Git repository probe response: ${inside || '(empty)'}` }
}

function gitMarkerForPath(workdir: string): { path: string; reason?: string } | undefined {
  let directory: string
  try { directory = path.resolve(workdir) }
  catch (error) { return { path: workdir, reason: error instanceof Error ? error.message : String(error) } }
  while (true) {
    const markerPath = path.join(directory, '.git')
    let marker: fs.Stats
    try { marker = fs.lstatSync(markerPath) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return { path: markerPath, reason: `could not inspect Git metadata at ${markerPath}: ${String(error)}` }
      }
      const parent = path.dirname(directory)
      if (parent === directory) return undefined
      directory = parent
      continue
    }
    if (marker.isFile()) {
      let pointer: string
      try { pointer = fs.readFileSync(markerPath, 'utf8') }
      catch (error) { return { path: markerPath, reason: `could not read Git pointer ${markerPath}: ${String(error)}` } }
      const match = /^gitdir:\s*(.+?)\s*$/im.exec(pointer)
      if (!match) return { path: markerPath, reason: `invalid Git pointer at ${markerPath}` }
      const target = path.resolve(directory, match[1])
      try {
        if (!fs.statSync(target).isDirectory()) return { path: markerPath, reason: `Git pointer at ${markerPath} does not target a directory` }
      } catch { return { path: markerPath, reason: `Git pointer at ${markerPath} targets a missing directory` } }
    }
    return { path: markerPath }
  }
}

export async function isGitRepo(workdir: string): Promise<boolean> {
  return (await probeGitRepository(workdir)).status === 'repo'
}

export async function probeCurrentBranch(workdir: string): Promise<{ ok: true; branch: string } | { ok: false; reason: string }> {
  if (!workdir) return { ok: false, reason: 'workspace not configured' }
  let result: GitCommandResult
  try {
    result = await runGit(workdir, ['rev-parse', '--abbrev-ref', 'HEAD'], 15000, repoProbeEnv())
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  if (!result.ok) return { ok: false, reason: gitError(result) }
  return { ok: true, branch: result.stdout.trim() }
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
    // 根目录等值按别名折叠判定：别名写法恰好等于根目录时 isWithin 会因 relative==='' 漏判，
    // 裸 === 又大小写敏感——merge 脚手架的在跑任务会被误放行给清扫（误拒保留）
    return sameWorktreePath(resolved, root) || isWithin(root, resolved)
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
  const result = await probeCurrentBranch(workdir)
  return result.ok ? result.branch : ''
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
  const probe = await probeGitRepository(workdir)
  if (probe.status === 'error') {
    return { available: false, reason: `Could not verify Git workspace isolation; refusing shared-workspace dispatch: ${probe.reason}` }
  }
  if (probe.status === 'not-repo') return { available: false, reason: 'Workspace is not a Git worktree; using the shared workspace' }
  const common = await runGit(workdir, ['rev-parse', '--git-common-dir'])
  if (!common.ok || !common.stdout.trim()) {
    return { available: false, reason: `Could not resolve Git workspace root; refusing shared-workspace dispatch: ${gitError(common)}` }
  }
  return { available: true, repoDir: path.dirname(commonGitDir(workdir, common.stdout.trim())) }
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

interface RegisteredWorktree {
  path: string
  registrationPath: string
  head?: string
  branch?: string
}

function listManagedWorktreeRegistrations(repoDir: string, gitDir: string): Map<string, RegisteredWorktree> {
  const result = new Map<string, RegisteredWorktree>()
  const registrationsDir = path.join(gitDir, 'worktrees')
  let entries: fs.Dirent[] = []
  try { entries = fs.readdirSync(registrationsDir, { withFileTypes: true }) } catch { return result }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const registrationPath = path.join(registrationsDir, entry.name)
    try {
      const gitFile = path.resolve(registrationPath, fs.readFileSync(path.join(registrationPath, 'gitdir'), 'utf8').trim())
      if (path.basename(gitFile).toLowerCase() !== '.git') continue
      const worktreePath = path.dirname(gitFile)
      if (!isWithin(managedRoot(repoDir), worktreePath)) continue
      let head: string | undefined
      try { head = fs.readFileSync(path.join(registrationPath, 'HEAD'), 'utf8').trim() } catch {}
      const branch = head ? /^ref: refs\/heads\/(.+)$/.exec(head)?.[1] : undefined
      result.set(path.basename(worktreePath), { path: worktreePath, registrationPath, ...(head !== undefined ? { head } : {}), ...(branch ? { branch } : {}) })
    } catch {}
  }
  return result
}

/** 按 worktree 路径查 Git 注册表：键名匹配与路径键同一套别名折叠（win32），
 *  别名写法的树名段在注册表按字面量键查不到会让世代核验误判「注册不在案」。
 *  登记查找前置规范化：basename 先吃原始串会把 `..`/`.` 段别名写法算成「..」之类
 *  的伪树名（注册表按伪树名查不到登记，世代核验误判「注册不在案」，别名路径走不到
 *  detach 守卫，「no longer detached」拒收落空）——先按路径键同款 resolve 折叠别名
 *  再取树名，别名写法与标准路径同因走到同一条拒收路径。 */
function registeredWorktreeForPath(registrations: Map<string, RegisteredWorktree>, wtPath: string): RegisteredWorktree | undefined {
  const name = path.basename(path.resolve(wtPath))
  if (process.platform !== 'win32') return registrations.get(name)
  const folded = name.toLowerCase()
  for (const [key, value] of registrations) if (key.toLowerCase() === folded) return value
  return undefined
}

function writeMetadata(metadata: WorktreeInfo) {
  const file = metadataFile(metadata.repoDir, path.basename(metadata.path))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(metadata, null, 2))
  fs.renameSync(tmp, file)
}

function removeMetadata(repoDir: string, name: string) {
  try { fs.rmSync(metadataFile(repoDir, name), { force: true }) } catch {}
}

function readMetadataFile(file: string): WorktreeInfo | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<WorktreeInfo>
    if (typeof value.ownerTaskId !== 'string' || typeof value.repoDir !== 'string' || typeof value.path !== 'string'
      || typeof value.branch !== 'string' || typeof value.baseSha !== 'string' || typeof value.createdAt !== 'number'
      || !['active', 'removed', 'retained', 'failed', 'pooled'].includes(value.cleanupStatus ?? '')) return null
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

const WORKTREE_GENERATION_FILE = 'agentdeck-generation'

/** 路径键统一规范化：与 sameWorktreePath 同一套等价判定（resolve + Windows 大小写折叠）。
 *  锁键/池键/池成员检查必须与路径等价判定同源——否则同一棵树按大小写/盘符别名两种
 *  写法会拿到两把锁、两份池登记，互斥失效、池成员检查漏命中（fix：路径键专项）。
 *  导出给 store/delegate/runner/ipc 等模块复用：路径键与等价判定全库只此一份实现。 */
export function worktreePathKey(candidate: string): string {
  const resolved = path.resolve(candidate)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** Windows 路径别名（大小写/盘符拼写差异）下的同一路径等价判定；POSIX 退化为字面量相等。 */
export function sameWorktreePath(left: string, right: string): boolean {
  return worktreePathKey(left) === worktreePathKey(right)
}

/** 路径集合按 worktreePathKey 折叠去重：同一目录的别名写法只留一个元素，且保留首个
 *  解析写法供真实文件系统调用（POSIX 上退化为 resolve 去重，行为不变）。启动/手动
 *  清扫的仓库集合等遍历入口共用：否则同一仓库的别名写法会重复清扫、并发重扫同一现场。 */
export function uniquePathsByKey(dirs: Iterable<string | undefined | null>): string[] {
  const unique = new Map<string, string>()
  for (const dir of dirs) {
    if (!dir) continue
    const resolved = path.resolve(dir)
    const key = worktreePathKey(resolved)
    if (!unique.has(key)) unique.set(key, resolved)
  }
  return [...unique.values()]
}

/** 托管 merge 脚手架的树名标记：临时合并目录 `.agentdeck-merge-*` 与其 detach 变体
 *  `.agentdeck-merge-detach-*`。树名标记判断按平台路径语义识别——win32 目录名大小写
 *  不敏感，同一棵脚手架以别名写法（大小写差异）报进核验/清扫时，字面量 startsWith
 *  判不中：detach 守卫（重挂分支的树必须拒绝回收）与 crashLeftover 强制回收豁免会
 *  全部落空。非 win32 目录名大小写敏感，别名写法即另一棵树，维持精确比较。 */
const MERGE_SCAFFOLD_MARKER = '.agentdeck-merge-'
const MERGE_DETACH_SCAFFOLD_MARKER = '.agentdeck-merge-detach-'

function hasMergeScaffoldMarker(treeName: string, marker: typeof MERGE_SCAFFOLD_MARKER | typeof MERGE_DETACH_SCAFFOLD_MARKER): boolean {
  return process.platform === 'win32' ? treeName.toLowerCase().startsWith(marker) : treeName.startsWith(marker)
}

function worktreeAdminDir(wtPath: string, commonDir: string): string | null {
  const worktreesDir = path.join(commonDir, 'worktrees')
  try {
    const pointer = fs.readFileSync(path.join(wtPath, '.git'), 'utf8')
    const match = /^gitdir:\s*(.+?)\s*$/im.exec(pointer)
    if (match) {
      const adminDir = path.resolve(wtPath, match[1])
      if (isWithin(worktreesDir, adminDir)) return adminDir
    }
  } catch {}
  try {
    for (const entry of fs.readdirSync(worktreesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const adminDir = path.join(worktreesDir, entry.name)
      const registeredGitFile = path.resolve(adminDir, fs.readFileSync(path.join(adminDir, 'gitdir'), 'utf8').trim())
      if (sameWorktreePath(registeredGitFile, path.join(wtPath, '.git'))) return adminDir
    }
  } catch {}
  return null
}

function readWorktreeGeneration(wtPath: string, commonDir: string): string | null {
  const adminDir = worktreeAdminDir(wtPath, commonDir)
  if (!adminDir) return null
  try { return fs.readFileSync(path.join(adminDir, WORKTREE_GENERATION_FILE), 'utf8').trim() || null }
  catch { return null }
}

function writeWorktreeGeneration(wtPath: string, commonDir: string): string | null {
  const adminDir = worktreeAdminDir(wtPath, commonDir)
  if (!adminDir) return null
  const generationId = randomUUID()
  try {
    fs.writeFileSync(path.join(adminDir, WORKTREE_GENERATION_FILE), `${generationId}\n`, { flag: 'wx' })
    return generationId
  } catch {
    return null
  }
}

async function verifyWorktreeGeneration(
  repoDir: string,
  wtPath: string,
  generationId: string,
  expectedBranch?: string
): Promise<string | null> {
  // 入口前置规范化：`..`/`.` 段别名写法不先 resolve，.git 指针会指去错误层级、树名
  // 标记判定（detach 守卫）会拿到伪树名——先折叠成规范写法，登记查找/守卫/指针核验
  // 全吃同一份（与 registeredWorktreeForPath 的自规范化互为两道防线）
  wtPath = path.resolve(wtPath)
  const common = await runGit(repoDir, ['rev-parse', '--git-common-dir'])
  if (!common.ok || !common.stdout.trim()) return 'Git worktree registration could not be verified'
  const commonDir = commonGitDir(repoDir, common.stdout.trim())
  const registrations = listManagedWorktreeRegistrations(repoDir, commonDir)
  const registration = registeredWorktreeForPath(registrations, wtPath)
  if (!registration || !sameWorktreePath(registration.path, wtPath)) return 'current Git worktree registration could not be found'
  let pointer: string
  try {
    const gitFile = path.join(wtPath, '.git')
    if (!fs.lstatSync(gitFile).isFile()) return 'current worktree .git pointer is missing or invalid'
    pointer = fs.readFileSync(gitFile, 'utf8')
  } catch {
    return 'current worktree .git pointer is missing or invalid'
  }
  const match = /^gitdir:\s*(.+?)\s*$/im.exec(pointer)
  if (!match) return 'current worktree .git pointer is missing or invalid'
  const adminDir = path.resolve(wtPath, match[1])
  if (!isWithin(path.join(commonDir, 'worktrees'), adminDir)) return 'current worktree .git pointer is outside its common-dir'
  if (!fs.existsSync(adminDir)) return 'current Git worktree registration metadata could not be verified'
  if (!sameWorktreePath(adminDir, registration.registrationPath)) return 'current Git worktree registration metadata does not match its common-dir entry'
  const detachedHead = !!registration.head && /^[0-9a-f]{40,64}$/i.test(registration.head)
  const attachedHead = !!registration.head && /^ref: refs\/heads\/.+/.test(registration.head) && !!registration.branch
  if (!detachedHead && !attachedHead) return 'current Git worktree registration is incomplete (missing HEAD)'
  if (attachedHead && !(await branchExists(repoDir, registration.branch!))) return 'current Git worktree registration is incomplete (missing HEAD target)'
  // 树名取自解析后的真实路径：同树别名写法（`x\..` 片段等）折叠到同一目录名后再判
  // 标记——basename 吃原始写法时，别名拼写的 detach 守卫会落空，重挂的脚手架被连
  // 目录强删；win32 大小写折叠仍由 hasMergeScaffoldMarker 按平台语义处理
  if (hasMergeScaffoldMarker(path.basename(path.resolve(wtPath)), MERGE_DETACH_SCAFFOLD_MARKER)) {
    if (!detachedHead) return 'detached merge worktree is no longer detached'
  } else if (expectedBranch && registration.branch !== expectedBranch) {
    return 'current Git worktree branch does not match its metadata'
  }
  let actualGenerationId: string
  try { actualGenerationId = fs.readFileSync(path.join(adminDir, WORKTREE_GENERATION_FILE), 'utf8').trim() }
  catch { return 'current Git worktree generation marker is missing' }
  if (!actualGenerationId) return 'current Git worktree generation marker is missing'
  if (actualGenerationId !== generationId) return 'current Git worktree belongs to a different generation'
  return null
}

/** Git 注册在案判定（与 verifyWorktreeGeneration 同一折叠查找语义）：缺目录补清的
 *  证据门槛用——注册已被 prune 移除的旧记录视为不可核验。 */
async function managedWorktreeRegistrationPresent(repoDir: string, wtDir: string): Promise<boolean> {
  const common = await runGit(repoDir, ['rev-parse', '--git-common-dir'])
  if (!common.ok || !common.stdout.trim()) return false
  const commonDir = commonGitDir(repoDir, common.stdout.trim())
  const registrations = listManagedWorktreeRegistrations(repoDir, commonDir)
  return !!registeredWorktreeForPath(registrations, path.resolve(wtDir))
}

async function registerWorktreeGeneration(repoDir: string, wtPath: string): Promise<string | null> {  const common = await runGit(repoDir, ['rev-parse', '--git-common-dir'])
  if (!common.ok || !common.stdout.trim()) return null
  return writeWorktreeGeneration(wtPath, commonGitDir(repoDir, common.stdout.trim()))
}

async function currentWorktreeGeneration(repoDir: string, wtPath: string): Promise<string | null> {
  const common = await runGit(repoDir, ['rev-parse', '--git-common-dir'])
  if (!common.ok || !common.stdout.trim()) return null
  return readWorktreeGeneration(wtPath, commonGitDir(repoDir, common.stdout.trim()))
}

// ---- worktree add 超时自适应（规模档位） ----

/** worktree add 超时自适应：完整 checkout 耗时随仓库规模线性放大——那台 8.2 万文件 Unity 仓
 *  完整检出要 5-6 分钟，磁盘争用（并行建树/Unity 编辑器同跑）下更久，实测 9 分钟档位仍会被
 *  击穿成 locked=initializing 残尸。60s 基线 + 每 1 万文件 +90s（8 万文件 ≈ 13 分钟），上限
 *  封顶 30 分钟。createWorktree 与集成/合并链路的建树共用；其他 git 调用不动。 */
export const WORKTREE_ADD_BASE_TIMEOUT_MS = 60_000
export const WORKTREE_ADD_TIMEOUT_PER_10K_FILES_MS = 90_000
export const WORKTREE_ADD_MAX_TIMEOUT_MS = 30 * 60_000
/** 每仓库文件计数缓存 TTL：派单重试/连续派单不重复 ls-files 数一遍 */
export const WORKTREE_FILE_COUNT_TTL_MS = 10 * 60_000

export function worktreeAddTimeoutFor(fileCount: number): number {
  // 每**满** 1 万文件加一档（floor）：几十个文件的小仓不吃 90s 额外加档，维持基线
  const tiers = Math.floor(Math.max(0, fileCount) / 10_000)
  return Math.min(WORKTREE_ADD_BASE_TIMEOUT_MS + tiers * WORKTREE_ADD_TIMEOUT_PER_10K_FILES_MS, WORKTREE_ADD_MAX_TIMEOUT_MS)
}

// ---- worktree 检出并行化（大仓建树提速） ----

/** 检出并行 worker 配置（git checkout.workers）：worktree add 内部检出、池化复用的
 *  switch/reset 差异重写同走 unpack_trees 并行通道，海量小文件仓（Unity 8 万文件）收益
 *  最明显。默认按 CPU 取保守档（≥2 才启用：8 核→2、16 核→4，封顶 4），机械盘/网络盘
 *  可能负优化——AGENTDECK_CHECKOUT_WORKERS=<n> 显式覆盖（≤1 或非法值 = 关闭，回退 git
 *  顺序检出）。超时树杀不受影响：checkout--worker 是 git 子进程，taskkill /T 按树可达。 */
export const WORKTREE_CHECKOUT_WORKERS_ENV = 'AGENTDECK_CHECKOUT_WORKERS'

export function checkoutWorkersArgs(cpus = os.cpus().length, env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[WORKTREE_CHECKOUT_WORKERS_ENV]
  const workers = raw === undefined ? Math.min(4, Math.floor(cpus / 4)) : Number.parseInt(raw, 10)
  return Number.isFinite(workers) && workers > 1 ? ['-c', `checkout.workers=${workers}`] : []
}

const worktreeFileCountCache = new Map<string, { count: number; at: number }>()

/** 测试/故障排查出口：清空每仓计数缓存 */
export function clearWorktreeFileCountCache(): void {
  worktreeFileCountCache.clear()
}

/** 建树体量估计：ls-files 计数（已跟踪 + 可回放未跟踪，即 ignore 掉的依赖目录不计）。
 *  调用目录先经 repositoryRoot() 归一到仓库根：领队 workdir 可能指在仓库子目录上，
 *  ls-files 从子目录数只见子目录文件 → 低估 → 60s 基线撞大仓超时（子目录调用与根调用
 *  必须同值）。走树杀通道：execFile 默认 1MB maxBuffer 装不下大仓全量 ls-files 输出。
 *  计数全失败返回 null（调用方回落 60s 基线，不缓存失败值）；仅未跟踪盘点失败按已跟踪计。 */
export async function estimateWorktreeFileCount(workdir: string): Promise<number | null> {
  const root = (await repositoryRoot(workdir)) ?? workdir
  const [tracked, untracked] = await Promise.all([
    runGitWithLockRetry(root, ['ls-files', '-z'], 30_000, undefined, true),
    runGitWithLockRetry(root, ['ls-files', '--others', '--exclude-standard', '-z'], 30_000, undefined, true)
  ])
  if (!tracked.ok) return null
  const count = (result: GitCommandResult) => result.stdout.split('\0').filter(Boolean).length
  return count(tracked) + (untracked.ok ? count(untracked) : 0)
}

/** 解析 worktree add 超时：TTL 内吃缓存，否则计数并缓存（注入的估计器同样走缓存，供 smoke 断言）。
 *  计数起点与缓存键都先归一到仓库根：否则子目录调用的低值会以根为键缓存 10 分钟，
 *  重派继续撞超时——归一后子目录调用与根调用同键同值。缓存键再走 worktreePathKey
 *  折叠别名：同一仓库按别名写法调用必须命中同一份缓存，绝不重复计数。 */
async function planWorktreeAddTimeout(repoRoot: string, countFrom: string, injected?: (repoRoot: string) => Promise<number>): Promise<{ timeoutMs: number; fileCount?: number }> {
  const root = (await repositoryRoot(countFrom || repoRoot)) ?? path.resolve(repoRoot)
  const key = worktreePathKey(root)
  const now = Date.now()
  const hit = worktreeFileCountCache.get(key)
  if (hit && now - hit.at < WORKTREE_FILE_COUNT_TTL_MS) return { timeoutMs: worktreeAddTimeoutFor(hit.count), fileCount: hit.count }
  const count = injected ? await injected(path.resolve(root)) : await estimateWorktreeFileCount(root)
  if (count === null) return { timeoutMs: worktreeAddTimeoutFor(0) }
  worktreeFileCountCache.set(key, { count, at: now })
  return { timeoutMs: worktreeAddTimeoutFor(count), fileCount: count }
}

export interface WorktreeCreateOptions {
  /** 调用方注入的仓库文件数估计（smoke 断言/特殊调用）；缺省走 ls-files 实测 + TTL 缓存 */
  estimateFileCount?: (repoRoot: string) => Promise<number>
  /** 强制指定 worktree add 超时（ms），跳过规模估计——测试与紧急止损用 */
  addTimeoutMs?: number
  /** 无法核验归属的失败现场时间线出口（runner 接 store.noteWorktreeCleanupFailure） */
  onCleanupResidue?: (failure: { name: string; reason: string; ownerTaskId?: string }) => void
  /** 取池未命中原因出口（归池可观测性）：池内有条目但全部不可复用、或池空，逐次带回
   *  具名原因（runner 落时间线注记，让「这次为什么没省时间」可查） */
  onPoolMiss?: (reason: string) => void
  runAddForTest?: (run: () => Promise<GitCommandResult>) => Promise<GitCommandResult>
  /** 稀疏检出的目录前缀列表（cone 模式，`/` 分隔）：§6.2 三步建树（add --no-checkout →
   *  set --cone → checkout）。任一目录在基线中不存在、或设置/检出失败 → 回落全量并在结果
   *  sparse 字段附原因（调用方落注记），绝不因稀疏问题拒单；缺省 = 全量，行为零变化 */
  sparseDirs?: string[]
}

/** Residue inventory observed after a failed worktree add. */
interface WorktreeAddResidueResult {
  directoryRemoved: boolean
  registrationPruned: boolean
  branchDeleted: boolean
  /** 部分失败残留清单（含残留分支名）：随拒单文案/时间线落盘，不静默 */
  residue: string[]
}

/** Failed-add residue inventory: failure alone does not prove ownership.
 *  Potential directory, registration, and branch residues are inspected only.
 *  "branch already exists"这类秒败里既存分支/目录是外部资产，删了会夷平别人现场、
 *  还会让内置重试意外成功改变派单语义）。全部 best-effort，失败不掩盖主失败原因，
 *  但不再静默——失败步骤进 residue 供时间线/拒单文案可见。 */
function pathEntryExists(candidate: string): boolean {
  try { fs.lstatSync(candidate); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT' }
}

async function inspectWorktreeAddResidue(repoDir: string, gitDir: string, wtPath: string, branch: string, includeBranch: boolean, includeDirectory = true): Promise<WorktreeAddResidueResult> {
  const residue: string[] = []
  // Failed add has no durable ownership proof; retain every possible residue.
  let directoryRemoved = true
  if (includeDirectory) {
    directoryRemoved = !pathEntryExists(wtPath)
    if (!directoryRemoved) residue.push(`目录 ${wtPath}（留待启动清扫兜底）`)
  }
  const registrationPath = path.join(gitDir, 'worktrees', path.basename(wtPath))
  const registrationPruned = !pathEntryExists(registrationPath)
  if (!registrationPruned) residue.push(`git 注册 ${registrationPath}`)
  let branchDeleted = true
  if (includeBranch && (await branchExists(repoDir, branch))) {
    branchDeleted = false
    residue.push(`分支 ${branch}`)
  }
  return { directoryRemoved, registrationPruned, branchDeleted, residue }
}

/** 「目录确已就绪」核验（吞错封死的容错窄门）：合法仓库 + 检出在预期分支 + 无 index.lock 残留。
 *  目录看着像 worktree 但锁还在（孤儿/竞态写手）时绝不放行——放行了，子 agent 的基线回放
 *  就会撞上仍在刷新的 index.lock 活锁（那台机锁连环的第二环）。 */
// ---- worktree 池化复用（大仓派单提速） ----

/** 每仓库池容量。8 万文件级 Unity 仓全量 checkout 要 4-6 分钟；池化后派单只重写基线间
 *  差异文件（秒级）。容量 2 覆盖「同任务并行双队员」常态，第三个起现建，避免长尾占盘。 */
export const WORKTREE_POOL_MAX_PER_REPO = 2
/** 池条目的 owner 标记（非真实任务 id）：元数据/清扫据此识别池资产 */
export const WORKTREE_POOL_OWNER = '.agentdeck-pool'

/** 进程内池：仓库规范键 → (树路径规范键 → 树真实路径)。会话级资产——重启即空，
 *  留盘池条目由启动清扫按 WORKTREE_POOL_OWNER 归属回收，不依赖任务册记录。
 *  双层键与 worktreePathKey 同源规范化：别名写法读写同一份登记。 */
const worktreePoolByRepo = new Map<string, Map<string, string>>()
const worktreePathLocks = new Map<string, Promise<void>>()

/** 测试出口：路径锁计数探针（并发夹具证明别名路径写法串行化的观测面）。
 *  'acquire' 在锁真正到手后发出，'release' 在临界区退出时发出——键为规范化路径键。 */
export type WorktreePathLockProbe = (event: 'acquire' | 'release', key: string) => void
let worktreePathLockProbe: WorktreePathLockProbe | undefined

export function setWorktreePathLockProbeForTest(probe?: WorktreePathLockProbe): void {
  worktreePathLockProbe = probe
}

async function withWorktreePathLock<T>(wtPath: string, operation: () => Promise<T>): Promise<T> {
  const key = worktreePathKey(wtPath)
  const previous = worktreePathLocks.get(key)
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  worktreePathLocks.set(key, current)
  if (previous) await previous
  try {
    worktreePathLockProbe?.('acquire', key)
    return await operation()
  } finally {
    worktreePathLockProbe?.('release', key)
    release()
    if (worktreePathLocks.get(key) === current) worktreePathLocks.delete(key)
  }
}

/** 仓库级归池锁（见 releaseWorktreeToPool）：串行化同仓并发归还的容量判定与登记。
 *  键为仓库根规范化路径键（与路径等价判定同源）。实现与 withWorktreePathLock 同构。 */
const repoRepoolLocks = new Map<string, Promise<void>>()

async function withRepoRepoolLock<T>(repoRoot: string, operation: () => Promise<T>): Promise<T> {
  const key = worktreePathKey(repoRoot)
  const previous = repoRepoolLocks.get(key)
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  repoRepoolLocks.set(key, current)
  if (previous) await previous
  try { return await operation() }
  finally {
    release()
    if (repoRepoolLocks.get(key) === current) repoRepoolLocks.delete(key)
  }
}

function poolFor(repoRoot: string): Map<string, string> {
  const key = worktreePathKey(repoRoot)
  let pool = worktreePoolByRepo.get(key)
  if (!pool) {
    pool = new Map<string, string>()
    worktreePoolByRepo.set(key, pool)
  }
  return pool
}

/** 测试出口：清空进程内池 */
export function clearWorktreePool(): void {
  worktreePoolByRepo.clear()
}

/** 测试出口：指定仓库当前池内条目快照（只读，树真实路径）——并发归池容量守卫的观测面。
 *  仓库参数按规范化键查找：别名写法命中的是同一个池。 */
export function worktreePoolEntriesForTest(repoDir: string): string[] {
  const pool = worktreePoolByRepo.get(worktreePathKey(repoDir))
  return pool ? [...pool.values()] : []
}

/** 树当前是否为活跃池条目（进程内池登记为准，路径键折叠别名）：delegate 集成段判断
 *  「子单终态已提前归池」的权威依据——登记先于 store 落盘，store 里的 cleanupStatus
 *  可能带着崩溃窗的滞后，池登记本身就是 releaseWorktreeToPool 的同一事实源。 */
export function worktreeInPool(repoDir: string, wtDir: string): boolean {
  const pool = worktreePoolByRepo.get(worktreePathKey(repoDir))
  return !!pool && pool.has(worktreePathKey(wtDir))
}

/** 树当前 sidecar 元数据登记的 owner 任务 id（缺失/非托管路径返回 null）：delegate 集成段
 *  判断「这棵树仍归属本单」用——归池前移后子单的 workdir 可能已指向被后续派单复用的树
 *  （池复用改写 owner），此时对本单的任何落盘/回收动作都必须让位。 */
export async function worktreeOwnerTaskId(wtDir: string): Promise<string | null> {
  const resolved = await resolveManagedWorktree(wtDir)
  return resolved?.metadata?.ownerTaskId ?? null
}

/** 归还入池：detach HEAD（同提交零文件重写，解除分支检出占用——否则调用方随后的
 *  分支删除会被 "used by worktree" 拒绝）。分支删除不在此做：归调用方决策（集成完成
 *  路径自行 deleteBranch 并跟踪失败；集成分支等保留分支不受影响）→ 元数据改挂池
 *  owner 并登记路径。目录与 git 注册保留。任何一步失败返回 false，调用方回落常规
 *  移除路径——归池是加速捷径，不改变回收语义。
 *  容量判定（check-then-add）整体持仓库级归池锁：同仓不同树的并发 reclaim(repool)
 *  各自只持自己的路径锁，若 check 不在仓级互斥，三棵并发归还都会在彼此 detach 的
 *  await 窗口里读到 pool.size < 上限而全部入池，击穿 WORKTREE_POOL_MAX_PER_REPO。
 *  锁序恒为 worktree 路径锁 → 仓库归池锁（本锁只在已持路径锁的 reclaim 上下文获取，
 *  持锁期间不再等任何路径锁；acquire 侧的 pool.delete 只缩不涨，不参与本锁），
 *  无反向等待不成死锁环。失败路径（容量满/detach 失败/元数据写失败）都不登记池条目
 *  ——无预占即无需回滚，不占死容量，后续归还与复用照常。 */
async function releaseWorktreeToPool(repoDir: string, wtDir: string, branch: string, metadata?: WorktreeInfo | null): Promise<boolean> {
  const root = path.resolve(repoDir)
  return withRepoRepoolLock(root, async () => {
    // 稀疏树入池（二期）：生效范围已记录在元数据（sparseDirs）才可入池——池条目记录稀疏
    // 范围，复用侧按范围匹配（同范围秒级换基线/异范围重设增量物化）；范围未知的稀疏树
    // （一期遗留/异常路径形态）一律不入池走常规回收（一期护栏保留为兜底）
    const sparse = await isSparseWorktree(wtDir)
    if (sparse && !metadata?.sparseDirs?.length) return false
    const pool = poolFor(root)
    if (pool.size >= WORKTREE_POOL_MAX_PER_REPO || pool.has(worktreePathKey(wtDir)) || !metadata?.generationId) return false
    const detached = await runGit(wtDir, ['switch', '--detach'], 30000)
    if (!detached.ok) return false
    try {
      writeMetadata({
        ownerTaskId: WORKTREE_POOL_OWNER,
        poolProcess: currentProcessIdentity(),
        generationId: metadata.generationId,
        repoDir: root,
        path: wtDir,
        branch,
        baseSha: metadata?.baseSha ?? '',
        createdAt: Date.now(),
        cleanupStatus: 'pooled',
        cleanupReason: 'idle in worktree pool awaiting reuse',
        // 稀疏生效范围随条目入池（复用侧范围匹配的唯一依据）
        ...(sparse && metadata.sparseDirs?.length ? { sparseDirs: metadata.sparseDirs } : {})
      })
    } catch { return false }
    pool.set(worktreePathKey(wtDir), wtDir)
    return true
  })
}

/** 池损坏条目脱池留痕：代际校验失败（或元数据缺世代）的原目录不再静默出池——
 *  sidecar 元数据改挂 failed + 待人工处置原因（重启清扫按既有 pooled-owner 流程
 *  识别，failed 记录随 failed 清单上报并附处置记录），目录与注册一律不动
 *  （fail-closed 保留现场，绝不代人工强删）；时间线出口即时通知派单方
 *  （noteOwnerTaskId = 触发复用的请求方任务，损坏发生在它的派单路径上）。 */
async function retainUnverifiablePoolEntry(
  root: string,
  wtPath: string,
  metadata: WorktreeInfo | null,
  problem: string,
  noteOwnerTaskId: string | undefined,
  notify?: (failure: { name: string; reason: string; ownerTaskId?: string }) => void
): Promise<void> {
  const reason = `池条目复用时代际校验失败脱池待人工处置：${problem}；目录与注册保留现场`
  if (metadata) {
    try { updateMetadata(metadata, { cleanupStatus: 'failed', cleanupReason: reason }) } catch { /* 标记失败不掩盖主失败，时间线照发 */ }
  }
  try { notify?.({ name: path.basename(wtPath), reason: `${reason}（仓库 ${root}）`, ownerTaskId: noteOwnerTaskId }) } catch { /* 出口失败不掩盖主流程 */ }
}

/** 稀疏范围等价（池条目匹配用）：分隔符与首尾斜杠归一后按集合比较（顺序无关）。
 *  parseSparseAttr 已在协议层归一，这里兜底同一语义，防元数据手改形态漏匹配。 */
function sameSparseDirs(a: readonly string[], b: readonly string[]): boolean {
  const key = (dirs: readonly string[]) => [...dirs]
    .map((d) => d.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .sort()
    .join('\n')
  return key(a) === key(b)
}

/** 池条目当前 cone 清单（`sparse-checkout list`，cone 模式逐目录一行）；读取失败返回 null
 *  ——调用方按「实际 cone 未知」处理（重设到请求范围）。 */
async function sparseCheckoutList(wtPath: string): Promise<string[] | null> {
  const list = await runGit(wtPath, ['sparse-checkout', 'list'], 15000)
  if (!list.ok) return null
  return list.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
}

/** 从池里取一棵复用：clean -ffdx（保留系统目录）→ switch -c <新分支> <基线>（只重写差异文件）
 *  → status 自洽核验（脏则 reset --hard 兜底一次）。任何一步失败都逐出该条目并返回 null，
 *  调用方回落全量 worktree add——池永远是加速捷径而非正确性依赖，复用失败不改变派单语义。
 *  switch/reset 沿用建树的规模自适应超时与进程树击杀通道（病态大差异下同样受控）。
 *  代际校验失败的条目走 retainUnverifiablePoolEntry 留痕后返回 null，不参与复用。
 *  onPoolMiss（归池可观测性）：池空/条目逐出都带具名原因回传，供调用方落时间线。
 *  稀疏感知（二期）：requestedSparseDirs 声明本单范围——同范围条目秒级 switch -c 换基线
 *  （cone 原样生效）；范围漂移/异范围条目换基线后 `sparse-checkout set` 重设并增量物化
 *  （秒-分钟级）；稀疏↔全量永不混用（全量条目不交稀疏单、稀疏条目不交全量单，范围未知
 *  的稀疏条目按一期护栏逐出）。 */
async function acquirePooledWorktree(
  repoDir: string,
  name: string,
  branch: string,
  baseSha: string,
  ownerTaskId: string,
  timeoutMs: number,
  notifyUnverifiable?: (failure: { name: string; reason: string; ownerTaskId?: string }) => void,
  onPoolMiss?: (reason: string) => void,
  requestedSparseDirs?: readonly string[]
): Promise<WorktreeCreateResult | null> {
  const root = path.resolve(repoDir)
  const sparseRequest = !!requestedSparseDirs?.length
  const pool = worktreePoolByRepo.get(worktreePathKey(root))
  if (!pool || !pool.size) {
    onPoolMiss?.('池内无空闲树')
    return null
  }
  const misses: string[] = []
  for (const wtPath of [...pool.values()]) {
    const reused = await withWorktreePathLock(wtPath, async () => {
      if (!pool.has(worktreePathKey(wtPath))) return null
      pool.delete(worktreePathKey(wtPath))
      const poolMetadata = readMetadataFile(metadataFile(root, path.basename(wtPath)))
      const generationId = poolMetadata?.generationId
      if (!generationId) {
        await retainUnverifiablePoolEntry(root, wtPath, poolMetadata ?? null, '池条目元数据缺世代标记', ownerTaskId, notifyUnverifiable)
        misses.push(`${path.basename(wtPath)} 元数据缺世代标记`)
        return null
      }
      const generationProblem = await verifyWorktreeGeneration(root, wtPath, generationId)
      if (generationProblem) {
        await retainUnverifiablePoolEntry(root, wtPath, poolMetadata ?? null, generationProblem, ownerTaskId, notifyUnverifiable)
        misses.push(`${path.basename(wtPath)} 代际校验失败`)
        return null
      }
      const evict = async (deleteRequestedBranch = false) => {
        // 项1（丢工作根治）：逐出只回收目录与 Git 注册，绝不删分支——池条目 sidecar 的
        // branch 字段挂着上一任务的成果分支（终态已归池、待集成分支合并），按池元数据
        // deleteBranch=把别人待集成的成果一起删掉。「分支确认无主待集成」的判定并不存在
        // （池元数据不追踪集成状态），故一律保留分支；托管分支随后续 tasks:delete 回收
        // 契约兜底。deleteRequestedBranch（本次 switch -c 刚建、零独有提交的请求分支）
        // 照旧补删：它属于本次失败的复用尝试，留着只会让重派撞 already exists。
        await reclaimWorktreeUnlocked(wtPath, { force: true, expectedGenerationId: generationId }).catch(() => {})
        if (deleteRequestedBranch) await deleteBranchWithRetry(root, branch)
      }
      if (!(await isGitRepo(wtPath))) { await evict(); misses.push(`${path.basename(wtPath)} 非 Git 仓库`); return null }
      // 稀疏感知匹配：稀疏↔全量永不混用（一期双侧护栏保留为兜底——范围未知的稀疏条目
      // 无论请求形态都逐出，绝不沿用未知范围物化）
      const entrySparse = await isSparseWorktree(wtPath)
      const entryDirs = poolMetadata?.sparseDirs?.length ? poolMetadata.sparseDirs : undefined
      if (!sparseRequest) {
        if (entrySparse) {
          await evict()
          misses.push(`${path.basename(wtPath)} 带稀疏配置（${entryDirs ? `范围 ${entryDirs.join('、')}` : '范围未知'}，本单全量——稀疏↔全量不混用）`)
          return null
        }
      } else if (!entrySparse || !entryDirs) {
        await evict()
        misses.push(`${path.basename(wtPath)} ${entrySparse ? '稀疏范围未记录' : '为全量树'}，本单声明稀疏（稀疏↔全量不混用）`)
        return null
      }
      // 项5：清理豁免只保托管资产（managedAssetPathspecExcludes）——上一任务的
      // .agentdeck-reports 内容随 clean -x 离场，不随树泄入新子单
      const cleaned = await runGit(wtPath, ['clean', '-ffd', '-x', '--', ...managedAssetPathspecExcludes()], 60000)
      if (!cleaned.ok) { await evict(); misses.push(`${path.basename(wtPath)} 清理失败`); return null }
      // 报告目录本身清后重建保约定（目录在、内容空）；清建失败不阻塞复用——报告
      // 写入侧按需建目录，路径上的旧内容已由 clean 带走
      try {
        fs.rmSync(path.join(wtPath, REPORTS_DIR_NAME), { recursive: true, force: true })
        fs.mkdirSync(path.join(wtPath, REPORTS_DIR_NAME), { recursive: true })
      } catch { /* 非阻塞：clean 已兜底带走旧内容 */ }
      const switched = await runGit(wtPath, [...checkoutWorkersArgs(), 'switch', '-c', branch, baseSha], timeoutMs, undefined, true)
      if (!switched.ok) { await evict(); misses.push(`${path.basename(wtPath)} 换基线失败`); return null }
      // 稀疏条目：换基线后 cone 对表请求范围——异范围复用/范围外漂移都在此重设
      // （sparse-checkout set 语义是整体替换+增量物化：只写新增目录、只删移除目录）
      if (sparseRequest) {
        const current = await sparseCheckoutList(wtPath)
        if (!current || !sameSparseDirs(current, requestedSparseDirs!)) {
          const set = await runGit(wtPath, ['sparse-checkout', 'set', '--cone', '--', ...requestedSparseDirs!], 60000)
          if (!set.ok) { await evict(); misses.push(`${path.basename(wtPath)} 稀疏范围重设失败`); return null }
        }
      }
      let settled = await runGit(wtPath, ['status', '--porcelain'], 30000)
      if (!settled.ok || settled.stdout.trim()) {
        await runGit(wtPath, [...checkoutWorkersArgs(), 'reset', '--hard', baseSha], timeoutMs, undefined, true)
        settled = await runGit(wtPath, ['status', '--porcelain'], 30000)
        if (!settled.ok || settled.stdout.trim()) { await evict(true); misses.push(`${path.basename(wtPath)} 换基线后状态不自洽`); return null }
      }
      const metadata: WorktreeInfo = {
        ownerTaskId,
        generationId,
        repoDir: root,
        path: wtPath,
        branch,
        baseSha,
        createdAt: Date.now(),
        cleanupStatus: 'active',
        // 稀疏复用的生效范围落进新任务的元数据（§7.2 扩圈提示/回放并集据此发射）
        ...(sparseRequest ? { sparseDirs: [...requestedSparseDirs!] } : {})
      }
      try { writeMetadata(metadata) } catch { await evict(true); misses.push(`${path.basename(wtPath)} 元数据写入失败`); return null }
      return {
        path: wtPath,
        branch,
        metadata,
        pooled: true,
        ...(sparseRequest ? { sparse: { status: 'applied' as const, dirs: [...requestedSparseDirs!] } } : {})
      }
    })
    if (reused) return reused
  }
  onPoolMiss?.(`池内 ${misses.length} 条均不可复用：${misses.join('；')}`)
  return null
}

// ---- worktree 稀疏检出（大仓建树提速：范围交队长界定，§6.2 三步） ----

/** 稀疏目录存在性校验：cone 模式对不存在的目录**静默接受**（实测 exit 0），圈错目录会被
 *  吞掉只建出半棵树——设稀疏范围前必须对基线树逐个核验。只认目录（tree 对象），路径
 *  指到文件同样拒。任一目录不存在 → 整单回落全量（§6.1），由调用方落注记，绝不拒单。 */
async function validateSparseDirs(repoDir: string, baseSha: string, dirs: string[]): Promise<{ ok: true; dirs: string[] } | { ok: false; reason: string }> {
  const rejected: string[] = []
  for (const dir of dirs) {
    const probe = await runGit(repoDir, ['cat-file', '-t', `${baseSha}:${dir}`], 30000)
    if (!probe.ok || probe.stdout.trim() !== 'tree') rejected.push(dir)
  }
  if (!rejected.length) return { ok: true, dirs }
  return { ok: false, reason: `稀疏检出目录在基线中不存在或不是目录（${rejected.join('、')}）` }
}

/** worktree 是否启用了稀疏检出：core.sparseCheckout 按 worktree 隔离存于 config.worktree，
 *  config 读取即探测、不碰 index。池化复用的安全闸——稀疏树换基线（switch/reset）会沿用
 *  旧稀疏配置物化出新基线的子集，交给全量单=缺文件、交给异范围稀疏单=错误范围。 */
async function isSparseWorktree(wtPath: string): Promise<boolean> {
  const probe = await runGit(wtPath, ['config', '--bool', 'core.sparseCheckout'], 15000)
  return probe.ok && probe.stdout.trim() === 'true'
}

/** §6.2 三步的后两步：cone 模式设稀疏范围 → 正常检出（照常注入 checkout.workers）。
 *  任一步失败 → 回落全量：sparse-checkout disable 恢复全目录物化，reset --hard 兜底；
 *  回落也失败时 recovered=false，调用方按建树失败清残肢。 */
async function runSparseCheckoutSteps(wtPath: string, dirs: string[], checkoutTimeoutMs: number): Promise<{ ok: true } | { ok: false; recovered: boolean; reason: string }> {
  const set = await runGit(wtPath, ['sparse-checkout', 'set', '--cone', '--', ...dirs], 60000)
  let checkout: GitCommandResult | null = null
  if (set.ok) {
    checkout = await runGit(wtPath, [...checkoutWorkersArgs(), 'checkout'], checkoutTimeoutMs, undefined, true)
    if (!checkout.timedOut && checkout.ok) return { ok: true }
  }
  const reason = !set.ok
    ? `git sparse-checkout set 失败：${(set.stderr || set.stdout).trim().slice(0, 300) || `exit ${set.code}`}`
    : `稀疏检出${checkout!.timedOut ? `超时（${Math.round(checkoutTimeoutMs / 1000)}s）` : '失败'}：${(checkout!.stderr || checkout!.stdout).trim().slice(0, 300) || `exit ${checkout!.code}`}`
  await runGit(wtPath, ['sparse-checkout', 'disable'], 60000)
  const recoveredRun = await runGit(wtPath, [...checkoutWorkersArgs(), 'reset', '--hard'], checkoutTimeoutMs, undefined, true)
  return { ok: false, recovered: !recoveredRun.timedOut && recoveredRun.ok, reason }
}

/** 为 worker 创建隔离 worktree（含独立分支）；失败返回 null（调用方 fail-closed 拒单，
 *  不再降级共享工作区——降级会让队员在旧基线上白写、并行队员互相踩）。onError（可选）
 *  逐次带回失败现场的 git 错误细节，供具名拒单文案使用。
 *  worktree add 走规模自适应超时 + 进程树击杀（worktreeAddTimeoutFor/killProcessTree）；
 *  超时（killed/SIGTERM）一律判失败并就地清残肢，绝不走「目录像合法 worktree 就当成功」容错
 *  任一失败时，归属无法核验的目录/注册/分支均保留并具名报告。 */
async function createWorktreeUnlocked(
  repoDir: string,
  name: string,
  baseBranch?: string,
  ownerTaskId = '',
  onError?: (message: string) => void,
  options: WorktreeCreateOptions = {}
): Promise<WorktreeCreateResult | null> {
  const fail = (message: string) => { try { onError?.(message) } catch {} }
  if (!(await isGitRepo(repoDir)) || !validWorktreeName(name)) { fail(`非 git 仓库或 worktree 名非法（${name}）`); return null }
  const branch = `agentdeck/${name}`
  const gcd = (await git(repoDir, ['rev-parse', '--git-common-dir'])).trim()
  const gitDir = commonGitDir(repoDir, gcd)
  const root = path.dirname(gitDir)
  const worktreeDir = managedRoot(root)
  const wtPath = path.join(worktreeDir, name)
  if (!isWithin(worktreeDir, wtPath)) { fail(`worktree 路径越界（${wtPath}）`); return null }
  const baseSha = (await git(repoDir, ['rev-parse', baseBranch || 'HEAD'])).trim()
  if (!baseSha) { fail(`无法解析基线 ${baseBranch || 'HEAD'} 的提交`); return null }
  fs.mkdirSync(worktreeDir, { recursive: true })
  // 归属前置盘点：失败清理只回收本次尝试自己创建的资产。既存同名分支/目录是外部资产
  // （用户残留、预置分支、上一轮现场），删了等于替别人清场，且会让内置重试从"秒败拒单"
  // 变成"意外建树成功"——派单语义被静默改写（锁专项③回归的教训）
  const branchPreexisting = await branchExists(repoDir, branch)
  const dirPreexisting = pathEntryExists(wtPath)
  const rejectOccupiedTarget = (branchExistsNow: boolean, directoryExistsNow: boolean) => {
    if (!branchExistsNow && !directoryExistsNow) return false
    fail(branchExistsNow ? `托管分支已存在（${branch}）` : `worktree 目录已存在（${wtPath}）`)
    return true
  }
  if (rejectOccupiedTarget(branchPreexisting, dirPreexisting)) {
    return null
  }
  const planned = options.addTimeoutMs !== undefined
    ? { timeoutMs: options.addTimeoutMs, fileCount: undefined as number | undefined }
    : await planWorktreeAddTimeout(root, repoDir, options.estimateFileCount)
  if (rejectOccupiedTarget(await branchExists(repoDir, branch), pathEntryExists(wtPath))) return null
  // 建树成功的收尾尾段（系统目录排除/代际/元数据/结果装配）：全量 add 与稀疏三步共用同一出口
  const finalizeCreatedWorktree = async (extra: { sparse?: WorktreeSparseOutcome; sparseDirs?: string[] } = {}): Promise<WorktreeCreateResult | null> => {
    // 把 worktree 目录从主仓库状态里排除，避免污染主目录的 status
    appendGitExcludes(gitDir, SYSTEM_SIDECAR_DIRS)
    const generationId = writeWorktreeGeneration(wtPath, gitDir)
    if (!generationId) {
      fail('worktree Git 注册代际标记写入失败')
      await runGit(root, ['worktree', 'remove', '--force', wtPath], 30000)
      await deleteBranch(root, branch)
      return null
    }
    const metadata: WorktreeInfo = {
      ownerTaskId,
      generationId,
      repoDir: root,
      path: wtPath,
      branch,
      baseSha,
      createdAt: Date.now(),
      cleanupStatus: 'active',
      // 稀疏生效范围落进元数据（回落全量不记）：子单失败回灌的扩圈提示据此发射（§7.2）
      ...(extra.sparseDirs?.length ? { sparseDirs: extra.sparseDirs } : {})
    }
    try { writeMetadata(metadata) } catch (e) {
      // Do not report a successful isolated worktree whose ownership metadata
      // could not be persisted. Best-effort rollback prevents an untracked
      // managed branch from leaking into the repository.
      fail(`worktree 元数据写入失败: ${e instanceof Error ? e.message : String(e)}`)
      await runGit(root, ['worktree', 'remove', '--force', wtPath], 30000)
      await deleteBranch(root, branch)
      return null
    }
    return {
      path: wtPath,
      branch,
      metadata,
      addTimeoutMs: planned.timeoutMs,
      ...(planned.fileCount !== undefined ? { fileCount: planned.fileCount } : {}),
      ...(extra.sparse ? { sparse: extra.sparse } : {})
    }
  }
  // 稀疏检出一批（§6.2 三步）：目录校验失败即整单回落全量——照常走下方池化+全量 add 原路径，
  // 只多一条结果观测面；校验通过则先试池（二期稀疏范围感知匹配：同范围条目秒级换基线/
  // 异范围重设增量物化/稀疏↔全量不混用），池未命中才走 add --no-checkout → set --cone →
  // checkout 新建，与全量 add 同超时档位、同残肢清理通道
  let sparseOutcome: WorktreeSparseOutcome | undefined
  if (options.sparseDirs?.length) {
    const check = await validateSparseDirs(repoDir, baseSha, options.sparseDirs)
    if (check.ok) {
      const pooledSparse = await acquirePooledWorktree(root, name, branch, baseSha, ownerTaskId, planned.timeoutMs, options.onCleanupResidue, options.onPoolMiss, check.dirs)
      // 池复用结果自带 sparse=applied 与元数据 sparseDirs（acquire 写入），回灌/回放链路无差别
      if (pooledSparse) return pooledSparse
      const runSparseAdd = () => runGit(repoDir, [...checkoutWorkersArgs(), 'worktree', 'add', '--no-checkout', '-b', branch, wtPath, ...(baseBranch ? [baseBranch] : [])], planned.timeoutMs, undefined, true)
      const sparseAdded = options.runAddForTest ? await options.runAddForTest(runSparseAdd) : await runSparseAdd()
      if (sparseAdded.timedOut || !sparseAdded.ok) {
        // 超时绝不当成功 / 失败按归属清残肢：与全量 add 同一盘点与上报通道（--no-checkout
        // 只建元数据，但失败现场仍可能留下目录/注册/分支）
        const cleaned = await inspectWorktreeAddResidue(repoDir, gitDir, wtPath, branch, !branchPreexisting, !dirPreexisting)
        if (cleaned.residue.length) {
          try { options.onCleanupResidue?.({ name, reason: `稀疏建树${sparseAdded.timedOut ? '超时' : '失败'}后归属无法核验，保留现场：${cleaned.residue.join('、')}`, ownerTaskId }) } catch { /* 时间线出口失败不掩盖主失败 */ }
        }
        const detail = (sparseAdded.stderr || sparseAdded.stdout).trim().slice(0, 300) || `git worktree add --no-checkout exit ${sparseAdded.code}`
        fail(sparseAdded.timedOut
          ? `git worktree add --no-checkout 超时（${Math.round(planned.timeoutMs / 1000)}s）${cleaned.residue.length ? `；归属无法核验，现场保留：${cleaned.residue.join('、')}` : '；未发现可确认归属的残留，未执行清理'}；请重派`
          : `${detail}${cleaned.residue.length ? `；归属无法核验，现场保留：${cleaned.residue.join('、')}` : ''}`)
        return null
      }
      const sparseRun = await runSparseCheckoutSteps(wtPath, check.dirs, planned.timeoutMs)
      if (!sparseRun.ok && !sparseRun.recovered) {
        // 三步连回落全量都不成：add 已成功，目录/分支/注册确属本次尝试，按归属清残肢
        const cleaned = await inspectWorktreeAddResidue(repoDir, gitDir, wtPath, branch, !branchPreexisting, !dirPreexisting)
        if (cleaned.residue.length) {
          try { options.onCleanupResidue?.({ name, reason: `稀疏检出失败且回落全量失败，保留现场：${cleaned.residue.join('、')}`, ownerTaskId }) } catch { /* 时间线出口失败不掩盖主失败 */ }
        }
        fail(`稀疏检出失败且回落全量失败：${sparseRun.reason}${cleaned.residue.length ? `；归属无法核验，现场保留：${cleaned.residue.join('、')}` : ''}`)
        return null
      }
      // 回落成功（recovered）时树已物化全量，语义等价全量 add；applied 时 cone 范围生效
      return finalizeCreatedWorktree({
        sparse: sparseRun.ok ? { status: 'applied', dirs: check.dirs } : { status: 'fallback', reason: sparseRun.reason },
        ...(sparseRun.ok ? { sparseDirs: check.dirs } : {})
      })
    }
    sparseOutcome = { status: 'fallback', reason: check.reason }
  }
  // 池化复用先行：同仓池里有空闲 worktree 就换基线复用（只重写差异文件），全量 add 兜底；
  // 未命中带原因回传（归池可观测性，runner 落时间线注记）
  const pooled = await acquirePooledWorktree(root, name, branch, baseSha, ownerTaskId, planned.timeoutMs, options.onCleanupResidue, options.onPoolMiss)
  if (pooled) return sparseOutcome ? { ...pooled, sparse: sparseOutcome } : pooled
  if (rejectOccupiedTarget(await branchExists(repoDir, branch), pathEntryExists(wtPath))) return null
  const runAdd = () => runGit(repoDir, [...checkoutWorkersArgs(), 'worktree', 'add', '-b', branch, wtPath, ...(baseBranch ? [baseBranch] : [])], planned.timeoutMs, undefined, true)
  const out = options.runAddForTest ? await options.runAddForTest(runAdd) : await runAdd()
  if (out.timedOut) {
    // 超时绝不当成功：树杀前的 checkout 可能写了一半，孤儿残留的 index.lock 会卡死后续
    // 回放。超时意味着本方已进入托管路径施工，按残肢清理以避免重派撞 already exists。
    const cleaned = await inspectWorktreeAddResidue(repoDir, gitDir, wtPath, branch, !branchPreexisting, !dirPreexisting)
    if (cleaned.residue.length) {
      // 清理部分失败不再静默：残留清单（含分支名）走 noteWorktreeCleanupFailure 记 owner
      // 时间线；拒单文案只报实情，绝不谎称「残肢已清理」——重派 already exists 时查得到现场
      try { options.onCleanupResidue?.({ name, reason: `建树超时后归属无法核验，保留现场：${cleaned.residue.join('、')}`, ownerTaskId }) } catch { /* 时间线出口失败不掩盖主失败 */ }
    }
    const cleanupNote = cleaned.residue.length
      ? `；归属无法核验，现场保留：${cleaned.residue.join('、')}`
      : '；未发现可确认归属的残留，未执行清理'
    fail(`git worktree add 超时（${Math.round(planned.timeoutMs / 1000)}s）${cleanupNote}；请重派`)
    return null
  }
  if (!out.ok) {
    // 非超时失败按归属清残肢：本方中途报错（长路径/磁盘/文件占用）时分支/目录是本次尝试
    // 创建的残肢，与超时路径同一清理通道；"already exists"秒败则什么都没建——既存资产
    // （用户残留/预置分支）不是本次的残肢，清了会让内置重试意外建树成功，静默改写派单
    // 语义（锁专项③回归的教训，smoke-worktree-lifecycle 固化该守卫）
    const cleaned = await inspectWorktreeAddResidue(repoDir, gitDir, wtPath, branch, !branchPreexisting, !dirPreexisting)
    if (cleaned.residue.length) {
      try { options.onCleanupResidue?.({ name, reason: `建树失败后归属无法核验，保留现场：${cleaned.residue.join('、')}`, ownerTaskId }) } catch { /* 时间线出口失败不掩盖主失败 */ }
    }
    const detail = (out.stderr || out.stdout).trim().slice(0, 300) || `git worktree add exit ${out.code}`
    fail(`${detail}${cleaned.residue.length ? `；归属无法核验，现场保留：${cleaned.residue.join('、')}` : ''}`)
    return null
  }
  return finalizeCreatedWorktree(sparseOutcome ? { sparse: sparseOutcome } : {})
}

export async function createWorktree(
  repoDir: string,
  name: string,
  baseBranch?: string,
  ownerTaskId = '',
  onError?: (message: string) => void,
  options: WorktreeCreateOptions = {}
): Promise<WorktreeCreateResult | null> {
  if (!(await isGitRepo(repoDir)) || !validWorktreeName(name)) {
    return createWorktreeUnlocked(repoDir, name, baseBranch, ownerTaskId, onError, options)
  }
  const gcd = (await git(repoDir, ['rev-parse', '--git-common-dir'])).trim()
  const root = path.dirname(commonGitDir(repoDir, gcd))
  const targetPath = path.join(managedRoot(root), name)
  return withWorktreePathLock(targetPath, () => createWorktreeUnlocked(repoDir, name, baseBranch, ownerTaskId, onError, options))
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
  // 集成建树与 worker 建树同一规模档位：8 万文件仓 60s 固定超时必被检出击穿（残尸现场
  // 见 locked=initializing + index.lock），小仓维持 60s 基线不变
  const planned = await planWorktreeAddTimeout(root, root)
  const added = await runGit(root, [...checkoutWorkersArgs(), 'worktree', 'add', wtPath, branch], planned.timeoutMs, undefined, true)
  if (added.timedOut) {
    // 与 createWorktree 同一吞错封死：超时绝不当成功；集成分支绝不删（集成结果都在分支上）。
    // 清理部分失败留 console 现场（此路径无时间线出口），不静默。
    const cleaned = await inspectWorktreeAddResidue(root, gitDir, wtPath, branch, false)
    if (cleaned.residue.length) console.warn(`[git] 集成 worktree 超时后归属无法核验，保留现场（${wtPath}）：${cleaned.residue.join('、')}`)
    return null
  }
  if (!added.ok) {
    const retained = await inspectWorktreeAddResidue(root, gitDir, wtPath, branch, false)
    if (retained.residue.length) console.warn(`[git] 集成 worktree 建立失败，归属无法核验，保留现场（${wtPath}）：${retained.residue.join('、')}`)
    return null
  }
  // 把 worktree 目录从主仓库状态里排除，避免污染主目录的 status（与 createWorktree 同一约定）
  appendGitExcludes(gitDir, SYSTEM_SIDECAR_DIRS)
  const generationId = writeWorktreeGeneration(wtPath, gitDir)
  if (!generationId) {
    await runGit(root, ['worktree', 'remove', '--force', wtPath], 30000)
    return null
  }
  const metadata: WorktreeInfo = {
    ownerTaskId,
    generationId,
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

/** commitAll 的可观测形态：failed 把「git 操作层失败」从「无改动」（committed/failed 双
 *  false）里分离出来并带原因——调用方据此落具名时间线注记与报告标记，绝不静默丢成果。 */
export interface CommitAllResult {
  /** true = 有改动且提交成功 */
  committed: boolean
  /** true = 提交尝试失败（非仓库/status 盘点/add/暂存/commit 任一步 git 失败）；false 且 committed=false = 无可提交改动 */
  failed: boolean
  /** failed 时的失败原因（时间线注记/报告标记文案） */
  reason: string
}

/** 把 workdir 里所有改动（含未跟踪）提交到当前分支；agent 身份。
 *  稀疏树必须 `add -A --sparse`：cone 外的队员成果会被 skip-worktree 位拦下——git 2.49
 *  实测不带该旗标整个 add 以 exit 1 拒收（范围内改动也一起进不了提交，调用方再无视
 *  返回值就是「队员写出 scope 外文件 → 成果全丢」）；`--sparse` 全收且不扩 cone
 *  （sparse-checkout list 复验不变）。非稀疏树不加旗标，行为与旧版逐字节一致。 */
export async function commitAllDetailed(workdir: string, message: string): Promise<CommitAllResult> {
  if (!(await isGitRepo(workdir))) return { committed: false, failed: true, reason: 'not a git repository' }
  // 三态彻底化：status 盘点走可检查退出状态的结果通道——git() 失败返空串在旧写法里
  // 与「无改动」不可区分（索引锁竞争/磁盘故障被静默当成零改动跳过提交=成果滞留现场），
  // 盘点失败一律归入 failed 三态带原因上报，绝不冒充「无可提交改动」
  const statusProbe = await runGit(workdir, ['status', '--porcelain'])
  if (!statusProbe.ok) return { committed: false, failed: true, reason: gitError(statusProbe) }
  if (!statusProbe.stdout.trim()) return { committed: false, failed: false, reason: '' }
  const sparse = await isSparseWorktree(workdir)
  // 排除常见生成物（worker 运行时产生的缓存/构建产物）；此 git 不支持 :! 简写，用长格式
  const added = await runGit(workdir, ['add', '-A', ...(sparse ? ['--sparse'] : []), '--', '.', ':(exclude)__pycache__', ':(exclude)*.pyc', ':(exclude)node_modules', ':(exclude)dist', ':(exclude)build'])
  if (!added.ok) return { committed: false, failed: true, reason: gitError(added) }
  const staged = await runGit(workdir, ['diff', '--cached', '--name-only'])
  if (!staged.ok) return { committed: false, failed: true, reason: gitError(staged) }
  if (!staged.stdout.trim()) return { committed: false, failed: false, reason: '' }
  const committed = await runGit(workdir, [...AGENT_GIT_IDENTITY, 'commit', '-m', message], 30000)
  if (!committed.ok) return { committed: false, failed: true, reason: gitError(committed) }
  return { committed: true, failed: false, reason: '' }
}

/** 把 workdir 里所有改动（含未跟踪）提交到当前分支；agent 身份；无改动返回 false。
 *  布尔形态供既有消费方（smoke 直连契约冻结）；需要区分失败原因的调用方走 commitAllDetailed。 */
export async function commitAll(workdir: string, message: string): Promise<boolean> {
  return (await commitAllDetailed(workdir, message)).committed
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

/** 报告副本 GC（挂线一/二共用）：按任务 id 清掉对应副本文件；幂等，缺失忽略。返回删除的绝对路径。
 *  仓库集合按 uniquePathsByKey 折叠去重：同一仓库的别名写法不重复遍历、不重复删除。 */
export function deleteReportCopies(repoDirs: readonly (string | undefined | null)[], taskIds: readonly string[]): string[] {
  const removed: string[] = []
  for (const root of uniquePathsByKey(repoDirs)) {
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
  /** 计入体量闸的新增 blob 总字节（未跟踪文件及发生变化的原暂存新增文件） */
  bytes: number
  reason: string
}

export interface BaselineReplayTestHooks {
  postSoftResetStatusResult?: (result: GitCommandResult) => GitCommandResult
}

export interface BaselineReplayOptions {
  /** 子单稀疏检出的生效范围（cone 目录前缀；调用方仅在建树侧 applied 时传入）：
   *  §6.3 关键点——范围外路径在稀疏树里带 skip-worktree 位，回放增量触达时 cherry-pick
   *  会留「index 已改、工作树未物化」暗坑；回放前把增量触达目录与范围取并集重设 cone。
   *  缺省（全量单）不进并集路径，行为零变化。 */
  sparseDirs?: string[]
}

/** §6.3 回放并集：增量触达路径里稀疏范围未覆盖的部分，取所在目录（cone 目录前缀）补进
 *  范围——返回并集后的完整 cone 清单（sparse-checkout set 语义是整体替换，必须传全量）；
 *  全部已覆盖时返回 undefined（不重设）。覆盖判定：根文件 cone 恒物化；路径在范围目录内、
 *  或所在目录是某范围目录的祖先（cone 模式把祖先目录的直接文件恒物化）都算已覆盖。 */
function sparseUnionDirs(changedRelPaths: Iterable<string>, sparseDirs: string[]): string[] | undefined {
  const additions = new Set<string>()
  for (const rel of changedRelPaths) {
    const cut = rel.lastIndexOf('/')
    if (cut < 0) continue
    const dir = rel.slice(0, cut)
    if (sparseDirs.some((d) => dir === d || dir.startsWith(`${d}/`) || d.startsWith(`${dir}/`))) continue
    additions.add(dir)
  }
  if (!additions.size) return undefined
  return [...new Set([...sparseDirs, ...additions])]
}

const replayRefused = (reason: string): BaselineReplayResult => ({ status: 'refused', commitSha: '', files: 0, bytes: 0, reason })
const replaySkipped = (reason: string): BaselineReplayResult => ({ status: 'skipped', commitSha: '', files: 0, bytes: 0, reason })

function splitUntracked(stdout: string): string[] {
  return stdout.split('\0').filter(Boolean).filter((rel) => !SYSTEM_SIDECAR_DIRS.some((dir) => rel === dir || rel.startsWith(`${dir}/`) || rel.startsWith(`${dir}\\`)))
}

function replayParentIssue(workdir: string, rel: string, allowMissing: boolean): string | undefined {
  const components = rel.split('/')
  if (components.some((component) => !component || component === '.' || component === '..')) return `回放路径格式异常（${rel}），拒绝回放`
  let parent = workdir
  for (const component of components.slice(0, -1)) {
    parent = path.join(parent, component)
    let info: fs.Stats
    try { info = fs.lstatSync(parent) }
    catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      return `无法核验回放路径父目录（${rel}），拒绝回放`
    }
    if (info.isSymbolicLink()) return `回放增量含软链父目录（${rel}），拒绝回放`
    if (!info.isDirectory()) return `回放路径父级不是目录（${rel}），拒绝回放`
  }
  return undefined
}

function pathspecExcludes(): string[] {
  // glob 形态：直接点名被忽略目录本身会触发 git 的 ignored-paths 报错（exit 1），
  // glob 深度形态不会——与 multica 的 snapshot excludes 同一写法
  return SYSTEM_SIDECAR_DIRS.flatMap((dir) => [`:(exclude,glob)**/${dir}/**`])
}

/** 池复用清理的 pathspec 豁免只保托管资产（.agentdeck-worktrees 嵌套托管树）——
 *  报告目录（.agentdeck-reports）不豁免：换基线复用即换任务，上一任务的报告内容
 *  必须随 clean -x 离场（目录本身由复用路径清后重建保约定），旧任务文件不得泄入
 *  新子单目录。 */
function managedAssetPathspecExcludes(): string[] {
  return SYSTEM_SIDECAR_DIRS.filter((dir) => dir !== REPORTS_DIR_NAME).flatMap((dir) => [`:(exclude,glob)**/${dir}/**`])
}

function gitBlobSizes(workdir: string, objectIds: string[], env: NodeJS.ProcessEnv): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    const child = execFile('git', ['-C', workdir, 'cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
      { timeout: 30000, windowsHide: true, env }, (error, stdout, stderr) => {
        resolve({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? error?.message ?? ''), code: !error ? 0 : typeof error.code === 'number' ? error.code : -1 })
      })
    child.stdin?.on('error', () => {})
    child.stdin?.end(`${objectIds.join('\n')}\n`)
  })
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
 * 拒单文案指明「领队 git 并发写冲突，请稍后重派」。子侧应用段另有陈锁清除：
 * 重试耗尽仍是锁错时，子 worktree 的 index.lock（rev-parse --git-path 定位）mtime
 * 距今超 5s 视为建树竞态残留（子 worktree 刚建、agent 未启动、无并发写者），删锁后
 * 追加最后一次尝试；锁新鲜、锁路径越出子 worktree 自己的 gitdir 容器（env 污染
 * GIT_DIR 指向主仓时会解析到主仓锁——容器校验防误删领队/主仓锁）或删除失败按重试
 * 耗尽处理；领队侧锁一律不删。
 *
 * 回放提交即子分支起始提交（子分支 tip = 回放提交）：此后 digest/集成都以它为基线，
 * 领队的改动不算子产出、不进子 git 小节。失败一律 refused + 具名原因，由调用方拒建单。
 * 体量闸先行：未跟踪文件数 >2000、总体积 >200MiB 或含软链 → 拒（gitignore 掉的依赖
 * 目录本就不在增量里；子单需要完整依赖时领队应先提交 lockfile——文档写明的边界）。
 * 未跟踪盘点（ls-files）超时即拒单：大仓盘点限时 15s（含锁退避重试），宁可拒建单
 * 回灌原因让领队改派，也不拿残缺增量当基线静默回放。
 * 稀疏单（options.sparseDirs，§6.3 关键点）：回放清单与稀疏范围取并集——子树 cone 外
 * 路径带 skip-worktree 位，cherry-pick 触达时留下「index 已改、工作树未物化」暗坑；
 * 回放前把增量触达目录补进 cone 再应用，并集重设失败回落全量（加速捷径不是正确性
 * 依赖），连回落都失败才拒单；回放后再逐路径核验物化，缺一件即拒单回滚，绝不交一棵
 * 「index 有、文件无」的树给子 agent。
 */
export async function replayLeaderBaseline(leaderWorkdir: string, childWorkdir: string, childBaseSha: string, testHooks?: BaselineReplayTestHooks, options?: BaselineReplayOptions): Promise<BaselineReplayResult> {
  if (!leaderWorkdir || !childWorkdir || !childBaseSha) return replayRefused('回放前置缺失：workdir 或子基线为空')
  // 全程禁 opportunistic index 锁：只读盘点在领队侧 index.lock 存在时也照常执行
  const lockEnv: NodeJS.ProcessEnv = { ...repoProbeEnv(), GIT_OPTIONAL_LOCKS: '0' }
  // 体量闸先行（只读）：未跟踪清单 + 已跟踪改动一次盘明，零增量直接走零开销路径；
  // 未跟踪盘点（ls-files）超时即拒单——不拿残缺清单当基线回放
  const [list, quiet, trackedNames, originalDiff] = await Promise.all([
    runGitWithLockRetry(leaderWorkdir, ['ls-files', '--others', '--exclude-standard', '-z'], 15000, lockEnv),
    runGitWithLockRetry(leaderWorkdir, ['diff', '--quiet', 'HEAD'], 15000, lockEnv),
    runGitWithLockRetry(leaderWorkdir, ['diff', '--name-only', '-z', 'HEAD'], 15000, lockEnv),
    runGitWithLockRetry(leaderWorkdir, ['diff', '--cached', '--raw', '--no-renames', '--no-abbrev', '-z', 'HEAD'], 15000, lockEnv)
  ])
  if (!list.ok) return replayRefused(`无法盘点领队未跟踪文件：${gitError(list)}${lockConflictSuffix(list)}`)
  if (!quiet.ok && quiet.code !== 1) return replayRefused(`无法对比领队工作区与 HEAD：${gitError(quiet)}${lockConflictSuffix(quiet)}`)
  if (!trackedNames.ok) return replayRefused(`无法列出领队已跟踪改动：${gitError(trackedNames)}${lockConflictSuffix(trackedNames)}`)
  if (!originalDiff.ok) return replayRefused(`无法核验领队原有暂存文件：${gitError(originalDiff)}${lockConflictSuffix(originalDiff)}`)
  const untracked = splitUntracked(list.stdout)
  const trackedPaths = trackedNames.stdout.split('\0').filter(Boolean)
  const trackedCount = trackedPaths.length
  const originalEntries = originalDiff.stdout.split('\0')
  if (originalEntries.pop() !== '') return replayRefused('领队原有暂存清单不完整，拒绝回放')
  const originalStaged = new Map<string, string>()
  const originalTracked = new Map<string, { mode: string; oid: string; status: string }>()
  for (let index = 0; index < originalEntries.length; index += 2) {
    const match = /^:([0-7]{6}) ([0-7]{6}) [0-9a-f]+ ([0-9a-f]+) ([A-Z])$/.exec(originalEntries[index] ?? '')
    const rel = originalEntries[index + 1]
    if (!match || !rel || originalStaged.has(rel) || originalTracked.has(rel)) return replayRefused('领队原有暂存清单格式异常，拒绝回放')
    if (match[4] === 'A' && match[1] === '000000') originalStaged.set(rel, match[3])
    else if (match[1] !== '000000' && ['M', 'D', 'T'].includes(match[4])) originalTracked.set(rel, { mode: match[2], oid: match[3], status: match[4] })
    else return replayRefused(`领队原有暂存状态不支持安全回放（${rel}），拒绝回放`)
  }
  for (const rel of new Set([...trackedPaths, ...originalTracked.keys()])) {
    const issue = replayParentIssue(leaderWorkdir, rel, true)
    if (issue) return replayRefused(issue)
  }
  for (const rel of originalStaged.keys()) {
    const issue = replayParentIssue(leaderWorkdir, rel, false)
    if (issue) return replayRefused(issue)
    try { fs.lstatSync(path.join(leaderWorkdir, rel)) }
    catch { return replayRefused(`原有暂存新增文件在采集前消失（${rel}），拒绝回放，请重派`) }
  }
  if (!trackedCount && !untracked.length && !originalStaged.size && !originalTracked.size) {
    const cachedQuiet = await runGitWithLockRetry(leaderWorkdir, ['diff', '--cached', '--quiet', 'HEAD'], 15000, lockEnv)
    if (!cachedQuiet.ok && cachedQuiet.code !== 1) return replayRefused(`无法核验领队暂存状态：${gitError(cachedQuiet)}${lockConflictSuffix(cachedQuiet)}`)
    if (!cachedQuiet.ok) return replayRefused('领队暂存增量与工作区不一致，拒绝跳过回放，请检查暂存文件后重派')
    return replaySkipped('领队无未提交增量，子单零开销跳过回放')
  }

  // lstat 体量闸：只针对未跟踪部分（已跟踪改动体量天然受仓库约束）
  let files = 0
  let bytes = 0
  const symlinks: string[] = []
  const symlinkParentCache = new Map<string, boolean>()
  for (const rel of untracked) {
    let parent = leaderWorkdir
    let hasSymlinkParent = false
    const components = rel.split('/')
    for (const component of components.slice(0, -1)) {
      parent = path.join(parent, component)
      let isSymlink = symlinkParentCache.get(parent)
      if (isSymlink === undefined) {
        try { isSymlink = fs.lstatSync(parent).isSymbolicLink() }
        catch { return replayRefused(`无法核验未跟踪路径的父目录（${rel}），拒绝回放`) }
        symlinkParentCache.set(parent, isSymlink)
      }
      if (isSymlink) { hasSymlinkParent = true; break }
    }
    if (hasSymlinkParent) { symlinks.push(rel); continue }
    let info: fs.Stats
    try { info = fs.lstatSync(path.join(leaderWorkdir, rel)) }
    catch { return replayRefused(`无法核验未跟踪文件（${rel}），拒绝回放`) }
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
      const indexPath = await runGit(leaderWorkdir, ['rev-parse', '--git-path', 'index'], 15000, lockEnv)
      const rel = indexPath.ok ? indexPath.stdout.trim() : ''
      if (rel) {
        const src = path.isAbsolute(rel) ? rel : path.join(leaderWorkdir, rel)
        fs.copyFileSync(src, tmpIndex)
        seeded = true
      }
    } catch {}
    for (const rel of new Set([...trackedPaths, ...originalTracked.keys()])) {
      const issue = replayParentIssue(leaderWorkdir, rel, true)
      if (issue) return replayRefused(issue)
    }
    for (const rel of originalStaged.keys()) {
      const issue = replayParentIssue(leaderWorkdir, rel, false)
      if (issue) return replayRefused(issue)
      try { fs.lstatSync(path.join(leaderWorkdir, rel)) }
      catch { return replayRefused(`原有暂存新增文件在采集期间消失（${rel}），拒绝回放，请重派`) }
    }
    let added = await runGitWithLockRetry(leaderWorkdir, addArgs, 60000, env)
    if (!added.ok && seeded) {
      const rebuilt = await runGitWithLockRetry(leaderWorkdir, ['read-tree', head], 30000, env)
      if (rebuilt.ok) added = await runGitWithLockRetry(leaderWorkdir, addArgs, 60000, env)
    }
    if (!added.ok) return replayRefused(`私有 index 采集失败：${gitError(added)}${lockConflictSuffix(added)}`)
    const changed = await runGitWithLockRetry(leaderWorkdir, ['diff', '--cached', '--raw', '--no-renames', '--no-abbrev', '-z', 'HEAD'], 30000, env)
    if (!changed.ok) return replayRefused(`无法核验实际回放路径：${gitError(changed)}${lockConflictSuffix(changed)}`)
    const changedEntries = changed.stdout.split('\0')
    if (changedEntries.pop() !== '') return replayRefused('实际回放路径清单不完整，拒绝回放')
    const changedPaths = new Map<string, { mode: string; oid: string; status: string }>()
    for (let index = 0; index < changedEntries.length; index += 2) {
      const match = /^:[0-7]{6} ([0-7]{6}) [0-9a-f]+ ([0-9a-f]+) ([A-Z])$/.exec(changedEntries[index] ?? '')
      const rel = changedEntries[index + 1]
      if (!match || !rel || changedPaths.has(rel)) return replayRefused('实际回放路径清单格式异常，拒绝回放')
      changedPaths.set(rel, { mode: match[1], oid: match[2], status: match[3] })
      const issue = replayParentIssue(leaderWorkdir, rel, match[3] === 'D')
      if (issue) return replayRefused(issue)
    }
    for (const [rel, original] of originalTracked) {
      const actual = changedPaths.get(rel)
      if (!actual || actual.mode !== original.mode || actual.oid !== original.oid || actual.status !== original.status) {
        return replayRefused(`领队原有暂存已跟踪改动与工作区不一致（${rel}），拒绝回放——请检查暂存文件后重派`)
      }
    }
    const staged = await runGitWithLockRetry(leaderWorkdir, ['diff', '--cached', '--raw', '--diff-filter=A', '--no-renames', '--no-abbrev', '-z', 'HEAD'], 30000, env)
    if (!staged.ok) return replayRefused(`无法核验实际暂存文件：${gitError(staged)}${lockConflictSuffix(staged)}`)
    const entries = staged.stdout.split('\0')
    if (entries.pop() !== '') return replayRefused('实际暂存清单不完整，拒绝回放')
    const untrackedPaths = new Set(untracked)
    const stagedUntrackedPaths = new Set<string>()
    const stagedForLimit: string[] = []
    const stagedPaths = new Set<string>()
    for (let index = 0; index < entries.length; index += 2) {
      const match = /^:000000 ([0-7]{6}) [0-9a-f]+ ([0-9a-f]+) A$/.exec(entries[index] ?? '')
      const rel = entries[index + 1]
      if (!match || !rel) return replayRefused('实际暂存清单格式异常，拒绝回放')
      if (stagedPaths.has(rel)) return replayRefused('实际暂存清单含重复路径，拒绝回放')
      stagedPaths.add(rel)
      if (match[1] !== '100644' && match[1] !== '100755') return replayRefused(`实际暂存增量含软链或非普通文件（${rel}），拒绝回放`)
      let parent = leaderWorkdir
      try {
        for (const component of rel.split('/').slice(0, -1)) {
          parent = path.join(parent, component)
          if (fs.lstatSync(parent).isSymbolicLink()) return replayRefused(`回放增量含软链父目录（${rel}），拒绝回放`)
        }
        if (!fs.lstatSync(path.join(leaderWorkdir, rel)).isFile()) return replayRefused(`暂存后文件类型变化（${rel}），拒绝回放`)
      } catch { return replayRefused(`暂存后无法核验未跟踪文件（${rel}），拒绝回放`) }
      const originalOid = originalStaged.get(rel)
      if (originalOid !== undefined) {
        if (originalOid !== match[2]) stagedForLimit.push(match[2])
        continue
      }
      if (!untrackedPaths.has(rel)) return replayRefused(`盘点后新增未跟踪文件（${rel}），拒绝回放，请重派`)
      stagedUntrackedPaths.add(rel)
      stagedForLimit.push(match[2])
    }
    for (const rel of originalStaged.keys()) {
      if (!stagedPaths.has(rel)) return replayRefused(`原有暂存新增文件在采集期间消失（${rel}），拒绝回放，请重派`)
    }
    if (stagedUntrackedPaths.size !== untracked.length || untracked.some((rel) => !stagedUntrackedPaths.has(rel))) {
      return replayRefused('盘点后未跟踪文件发生变化，拒绝回放，请重派')
    }
    files = stagedUntrackedPaths.size
    bytes = 0
    if (stagedForLimit.length) {
      const sizes = await gitBlobSizes(leaderWorkdir, stagedForLimit, env)
      if (!sizes.ok) return replayRefused(`无法核验实际暂存体积：${gitError(sizes)}`)
      const lines = sizes.stdout.trimEnd().split('\n')
      if (lines.length !== stagedForLimit.length) return replayRefused('实际暂存体积清单不完整，拒绝回放')
      for (let index = 0; index < lines.length; index++) {
        const match = /^([0-9a-f]+) blob (\d+)$/.exec(lines[index].trim())
        if (!match || match[1] !== stagedForLimit[index]) return replayRefused('实际暂存对象类型或体积异常，拒绝回放')
        const blobBytes = Number(match[2])
        if (!Number.isSafeInteger(blobBytes)) return replayRefused('实际暂存对象体积超出可核验范围，拒绝回放')
        bytes += blobBytes
        if (stagedForLimit.length > REPLAY_MAX_FILES || bytes > REPLAY_MAX_BYTES) {
          return replayRefused(`回放增量超限：实际暂存新增 ${stagedForLimit.length} 个文件 / ${Math.ceil(bytes / 1024 / 1024)}MiB（上限 ${REPLAY_MAX_FILES} 个 / ${REPLAY_MAX_BYTES / 1024 / 1024}MiB）——请 gitignore 或先提交`)
        }
      }
    }
    const treeResult = await runGitWithLockRetry(leaderWorkdir, ['write-tree'], 60000, env)
    const tree = treeResult.stdout.trim()
    if (!treeResult.ok || !tree) return replayRefused(`write-tree 未产出树对象：${gitError(treeResult)}${lockConflictSuffix(treeResult)}`)
    const committed = await runGitWithLockRetry(leaderWorkdir, [...AGENT_GIT_IDENTITY, 'commit-tree', tree, '-p', childBaseSha, '-m', 'agentdeck: 领队未提交基线回放（子单以本提交为基线）'], 30000, env)
    if (!committed.ok) return replayRefused(`commit-tree 失败：${gitError(committed)}${lockConflictSuffix(committed)}`)
    const replaySha = committed.stdout.trim()
    if (!replaySha) return replayRefused('commit-tree 未产出提交')

    // §6.3 回放并集（稀疏单）：回放前把增量触达目录补进 cone。树已全量（建树侧回落/
    // 池化全量）时无 skip-worktree 暗坑，不进并集路径；重设失败回落全量（disable 恢复
    // 全目录物化），连回落都失败才拒单——加速捷径不是正确性依赖。
    let sparseReplayVerified = false
    if (options?.sparseDirs?.length) {
      const sparseProbe = await runGit(childWorkdir, ['config', '--bool', 'core.sparseCheckout'], 15000, lockEnv)
      if (sparseProbe.ok && sparseProbe.stdout.trim() === 'true') {
        sparseReplayVerified = true
        const union = sparseUnionDirs(changedPaths.keys(), options.sparseDirs)
        if (union) {
          const set = await runGit(childWorkdir, ['sparse-checkout', 'set', '--cone', '--', ...union], 60000, lockEnv)
          if (!set.ok) {
            const disable = await runGit(childWorkdir, ['sparse-checkout', 'disable'], 60000, lockEnv)
            if (!disable.ok) return replayRefused(`回放前稀疏范围并集重设失败且无法回落全量：${gitError(set)}`)
            sparseReplayVerified = false
          }
        }
      }
    }

    // 子 worktree 应用：parent==子基线 ⇒ cherry-pick 就是精确增量；--quit 清理 sequencer 残留，
    // reset --soft 把子分支推进到回放提交（index/worktree 已与该树一致，status 归零）。
    // 三步走 runChildApplyGit：撞锁退避重试耗尽时子侧陈锁（mtime>5s）先删再加试一次
    const pick = await runChildApplyGit(childWorkdir, ['cherry-pick', '--no-commit', replaySha], 60000, lockEnv)
    if (!pick.ok) {
      await runGit(childWorkdir, ['cherry-pick', '--abort'], 15000, lockEnv)
      return replayRefused(`子单回放应用失败：${gitError(pick)}${lockConflictSuffix(pick)}`)
    }
    await runGit(childWorkdir, ['cherry-pick', '--quit'], 15000, lockEnv)
    const soft = await runChildApplyGit(childWorkdir, ['reset', '--soft', replaySha], 30000, lockEnv)
    if (!soft.ok) {
      const rollback = await rollbackChildReplay(childWorkdir, childBaseSha, lockEnv)
      return replayRefused(`子分支推进到回放提交失败：${gitError(soft)}${lockConflictSuffix(soft)}；${rollback.reason}`)
    }
    const status = await runChildApplyGit(childWorkdir, ['status', '--porcelain'], 15000, lockEnv)
    const clean = testHooks?.postSoftResetStatusResult?.(status) ?? status
    if (!clean.ok || clean.stdout.trim()) {
      const cause = clean.ok
        ? '回放后子 worktree 状态不自洽（status 非空）'
        : `回放后无法核验子 worktree 状态：${gitError(clean)}${lockConflictSuffix(clean)}`
      const rollback = await rollbackChildReplay(childWorkdir, childBaseSha, lockEnv)
      return replayRefused(`${cause}；${rollback.reason}`)
    }
    // 稀疏单回放后的物化核验（§6.3 暗坑的最后一道闸）：并集应让每个非删除路径真实落在
    // 工作树里；git 版本行为差异若仍把路径按 skip-worktree 藏起来，宁可拒单回滚也不交
    // 「index 有、文件无」的树给子 agent（status 因 skip-worktree 位看不出来，只能逐路径验）
    if (sparseReplayVerified) {
      for (const [rel, info] of changedPaths) {
        if (info.status === 'D') continue
        if (!pathEntryExists(path.join(childWorkdir, rel))) {
          const rollback = await rollbackChildReplay(childWorkdir, childBaseSha, lockEnv)
          return replayRefused(`回放后增量路径未物化（${rel}，稀疏范围并集未生效）；${rollback.reason}`)
        }
      }
    }
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
  // 标记段切分与路径键同一套别名等价判定（win32 折叠大小写后定位，切片仍用原始写法）：
  // 否则全路径别名（托管目录标记段大小写不同）会在切分处误判「不在托管目录内」，
  // 让锁/池已收口的别名写法在入口处漏液
  const probe = process.platform === 'win32' ? absolute.toLowerCase() : absolute
  const normalized = `${probe}${path.sep}`
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

/** 回收原子性（fix4）：失败步骤重试一次——Windows 句柄滞后/瞬时 EBUSY 的窗口期常是秒级，
 *  重试仍败才交残留清单上报（调用方记时间线），不再静默。 */
const CLEANUP_RETRY_DELAY_MS = 500

async function deleteBranchWithRetry(workdir: string, name: string): Promise<boolean> {
  if (await deleteBranch(workdir, name)) return true
  await new Promise((resolve) => setTimeout(resolve, CLEANUP_RETRY_DELAY_MS))
  return deleteBranch(workdir, name)
}

/** Reclaim an isolated worktree with structured fail-closed status.
 *  repool: true 时（且非 force、工作区干净、管理分支）优先归还复用池而非移除——
 *  目录与 git 注册保留、子分支删除、元数据挂池标记，下一次派单换基线秒级复用。 */
export async function reclaimWorktree(
  wtDir: string,
  options: { force?: boolean; deleteBranch?: boolean; repool?: boolean; expectedOwnerTaskId?: string; expectedGenerationId?: string; beforeReclaim?: (wtDir: string) => Promise<boolean> } = {}
): Promise<WorktreeCleanupResult> {
  return withWorktreePathLock(wtDir, () => reclaimWorktreeUnlocked(wtDir, options))
}

async function reclaimWorktreeUnlocked(
  wtDir: string,
  options: { force?: boolean; deleteBranch?: boolean; repool?: boolean; expectedOwnerTaskId?: string; expectedGenerationId?: string; beforeReclaim?: (wtDir: string) => Promise<boolean> } = {},
  allowVerifiedMergeScaffold = false
): Promise<WorktreeCleanupResult> {
  const resolved = await resolveManagedWorktree(wtDir)
  if (!resolved) return { ok: false, status: 'failed', path: wtDir, reason: 'path is outside .agentdeck-worktrees' }
  const { repoDir, name, metadata } = resolved
  if (!metadata) {
    const missingSidecar = !fs.existsSync(metadataFile(repoDir, name))
    if (!allowVerifiedMergeScaffold || !missingSidecar || !hasMergeScaffoldMarker(name, MERGE_SCAFFOLD_MARKER) || !options.expectedGenerationId) {
      return { ok: false, status: 'retained', path: wtDir, reason: 'worktree owner metadata is missing or invalid' }
    }
  } else if (!metadata.ownerTaskId.trim() || !metadata.branch.trim()
    || !sameWorktreePath(metadata.repoDir, repoDir)
    || !sameWorktreePath(metadata.path, wtDir)) {
    return { ok: false, status: 'retained', path: wtDir, reason: 'worktree owner metadata is missing or invalid' }
  }
  if (options.expectedOwnerTaskId !== undefined && metadata?.ownerTaskId !== options.expectedOwnerTaskId) {
    return { ok: false, status: 'retained', path: wtDir, reason: 'worktree ownership changed' }
  }
  if (metadata && !metadata.generationId) {
    return { ok: false, status: 'retained', path: wtDir, reason: 'legacy worktree metadata has no generation identity' }
  }
  if (options.expectedGenerationId && metadata?.generationId && options.expectedGenerationId !== metadata.generationId) {
    return { ok: false, status: 'retained', path: wtDir, reason: 'worktree generation metadata changed' }
  }
  const expectedGenerationId = options.expectedGenerationId ?? metadata?.generationId
  // 项4：目录已被外力清掉（崩溃竞态/手工删除）时不因代际核验失败跳过分支处理——
  // 核验盘的是目录内的 .git 指针/admin 标记，目录不在则必败，托管分支会因此永久
  // 滞留（重派撞 already exists 连环的源头之一）。归属证据已由前置检查把门（元数据
  // repoDir/path 严格一致 + expectedOwnerTaskId/expectedGenerationId 匹配 + 池活跃
  // 拒收），盘面代际核验只对「目录还在的树」做；目录不在时走下方受检 prune +
  // 调用方决策的分支删除（集成/非托管分支照旧不动），不强删、可核验、留审计。
  if (expectedGenerationId && fs.existsSync(wtDir)) {
    const generationMismatch = await verifyWorktreeGeneration(
      repoDir,
      wtDir,
      expectedGenerationId,
      metadata?.cleanupStatus === 'pooled' ? undefined : metadata?.branch || undefined
    )
    if (generationMismatch) return { ok: false, status: 'retained', path: wtDir, reason: generationMismatch }
  }
  if (metadata?.ownerTaskId === WORKTREE_POOL_OWNER && worktreePoolByRepo.get(worktreePathKey(repoDir))?.has(worktreePathKey(wtDir))) {
    return { ok: false, status: 'retained', path: wtDir, reason: 'worktree is active in the reuse pool' }
  }
  // Legacy worktrees predate the sidecar but use the deterministic managed
  // branch name, so they can still be reclaimed without touching user refs.
  const branch = metadata?.branch || `${MANAGED_BRANCH_PREFIX}${name}`
  // 残留清单：目录已回收但 git 注册/分支仍在的部分成功残肢，随结果上报不静默
  const residue: string[] = []
  if (metadata?.manualKeep) {
    try { updateMetadata(metadata, { cleanupStatus: 'retained', cleanupReason: 'manual keep requested' }) } catch {}
    return { ok: false, status: 'retained', path: wtDir, branch, reason: 'manual keep requested' }
  }
  if (options.beforeReclaim) {
    let released = false
    try { released = await options.beforeReclaim(wtDir) } catch {}
    if (!released) {
      const reason = 'backend session is still active or could not be released; worktree retained'
      try { if (metadata) updateMetadata(metadata, { cleanupStatus: 'failed', cleanupReason: reason }) } catch {}
      return { ok: false, status: 'failed', path: wtDir, branch, reason }
    }
  }
  // 项4 证据门槛：目录不在时的补清以 Git 注册仍在案为界——sidecar 独证不足（注册
  // 已被此前 prune 移除的旧记录无法核验树曾在案，同名分支可能是外置资产），保留
  // 分支并按 failed 持续报告；注册在案（可核验）才走下方受检 prune + 分支补清。
  if (expectedGenerationId && !fs.existsSync(wtDir)) {
    const registrationPresent = await managedWorktreeRegistrationPresent(repoDir, wtDir)
    if (!registrationPresent) {
      return { ok: false, status: 'failed', path: wtDir, branch, reason: `current Git worktree registration could not be found${branch ? `; branch ${branch} retained` : ''}` }
    }
  }
  if (fs.existsSync(wtDir)) {
    const cleanliness = await worktreeDirty(wtDir)
    if (!options.force && !cleanliness.ok) {
      try { if (metadata) updateMetadata(metadata, { cleanupStatus: 'failed', cleanupReason: 'could not determine worktree status' }) } catch {}
      return { ok: false, status: 'failed', path: wtDir, branch, reason: 'could not determine worktree status' }
    }
    if (!options.force && cleanliness.dirty) {
      try { if (metadata) updateMetadata(metadata, { cleanupStatus: 'retained', cleanupReason: 'uncommitted changes' }) } catch {}
      return { ok: false, status: 'retained', path: wtDir, branch, reason: 'uncommitted changes' }
    }
    // 归池优先（仅限非 force 且干净的管理分支 worktree）：detach + 删分支 + 挂池标记，
    // 目录与注册留给下一次派单换基线复用；归还失败回落常规移除路径，回收语义不变
    if (options.repool && !options.force && cleanliness.ok && !cleanliness.dirty && branch.startsWith(MANAGED_BRANCH_PREFIX)) {
      if (await releaseWorktreeToPool(repoDir, wtDir, branch, metadata)) {
        return { ok: true, status: 'pooled', path: wtDir, branch, reason: 'returned to worktree pool for reuse' }
      }
    }
  }
  if (!fs.existsSync(wtDir)) {
    // 目录已被外力清掉（崩溃竞态/手工删除）：prune 从顺手一带变为受检步骤——
    // 失败即 .git/worktrees/<name> 注册残留，重试一次仍败进残留清单
    let pruned = await runGit(repoDir, ['worktree', 'prune'], 15000)
    if (!pruned.ok) {
      await new Promise((resolve) => setTimeout(resolve, CLEANUP_RETRY_DELAY_MS))
      pruned = await runGit(repoDir, ['worktree', 'prune'], 15000)
    }
    if (!pruned.ok) residue.push(`git 注册 ${path.join(repoDir, '.git', 'worktrees', name)}`)
  } else {
    const removeArgs = ['worktree', 'remove', ...(options.force ? ['--force'] : []), wtDir]
    let removed = await runGit(repoDir, removeArgs, 30000)
    if (!removed.ok) {
      await new Promise((resolve) => setTimeout(resolve, CLEANUP_RETRY_DELAY_MS))
      removed = await runGit(repoDir, removeArgs, 30000)
    }
    if (!removed.ok) {
      const reason = gitError(removed)
      if (metadata) updateMetadata(metadata, { cleanupStatus: 'failed', cleanupReason: reason })
      return { ok: false, status: 'failed', path: wtDir, branch, reason }
    }
  }
  if (options.deleteBranch && branch && branch.startsWith(MANAGED_BRANCH_PREFIX)) {
    const present = await branchExists(repoDir, branch)
    const deleted = !present || await deleteBranchWithRetry(repoDir, branch)
    if (!deleted) residue.push(`分支 ${branch}`)
  }
  if (residue.length) {
    const reason = `worktree 目录已回收但存在残留：${residue.join('、')}`
    try { if (metadata) updateMetadata(metadata, { cleanupStatus: 'retained', cleanupReason: reason }) } catch {}
    return { ok: false, status: 'retained', path: wtDir, branch, reason, residue }
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

/** 改绑核验的任务侧证据（全部取自任务登记，绝不拿磁盘现场自证）。 */
export interface WorktreeOwnerExpectation {
  /** 任务登记里固化的世代 id——缺失即拒绝核实（同名删树重建后旧残单不得凭磁盘自证翻面） */
  generationId?: string
  /** 出生时的磁盘 owner（建单时挂在领队名下）；绑定-翻面之间崩溃的恢复重入按目标 owner 放行 */
  ownerTaskId?: string
  /** 出生分支——池化复用会换分支，世代不变，靠它挡「旧任务携原世代认领换branch后的树」 */
  branch?: string
}

/**
 * 磁盘归属核实+改绑（建单门禁翻面前的唯一绑定出口）。核验+写入整体持同一路径锁
 * （与池化复用/回收的临界区互斥，池化复用给新任务不能插进核验与写入之间）。
 * 全部条件过才允许改绑：
 * ① 任务侧独立证据齐备——世代/出生 owner/出生分支三项都取自任务登记；缺任一即
 *    拒绝核实（世代绝不退回 sidecar 元数据自带值自证：同名删树重建后磁盘是棵
 *    陌生新树，自证等于替别人认领）；
 * ② 目录存在——被外力清掉的目录（崩溃竞态/手工删除）一律 false，不认「元数据还在」；
 * ③ 身份对应——sidecar 元数据的 repoDir/path 与目标路径一致（同名不同位的登记不认），
 *    且元数据世代与任务证据世代严格相等；
 * ④ 树处于可绑定状态——未归池（owner 非池标记、状态非 pooled、不在进程内池登记）、
 *    磁盘 owner 恰为出生 owner（正常建单交接）或已是目标 owner（绑定-翻面之间崩溃
 *    的恢复重入）；池化复用已把树交给新任务时，旧任务携原世代调用必须 false 且
 *    新 owner 不被改写；
 * ⑤ Git 注册在案+分支一致+世代一致——verifyWorktreeGeneration 盘 .git 指针、admin
 *    目录、Git 注册表，分支以任务证据为准（不用元数据自带分支自证）。
 * 任一步不满足返回 false（fail-closed）：调用方保持门禁走具名终态，绝不把子单
 * 派发到不存在/不属于自己的树上。
 */
export async function setWorktreeOwner(wtDir: string, ownerTaskId: string, expected: WorktreeOwnerExpectation = {}): Promise<boolean> {
  if (!ownerTaskId.trim()) return false
  const generationId = expected.generationId?.trim()
  if (!generationId) return false
  const expectedOwner = expected.ownerTaskId?.trim()
  if (!expectedOwner) return false
  const expectedBranch = expected.branch?.trim()
  if (!expectedBranch) return false
  return withWorktreePathLock(wtDir, async () => {
    if (!fs.existsSync(wtDir)) return false
    const resolved = await resolveManagedWorktree(wtDir)
    if (!resolved?.metadata) return false
    const { repoDir, metadata } = resolved
    if (!sameWorktreePath(metadata.repoDir, repoDir) || !sameWorktreePath(metadata.path, wtDir)) return false
    if (!metadata.generationId || metadata.generationId !== generationId) return false
    if (metadata.ownerTaskId === WORKTREE_POOL_OWNER || metadata.cleanupStatus === 'pooled') return false
    if (worktreePoolByRepo.get(worktreePathKey(repoDir))?.has(worktreePathKey(wtDir))) return false
    if (metadata.ownerTaskId !== expectedOwner && metadata.ownerTaskId !== ownerTaskId.trim()) return false
    if (await verifyWorktreeGeneration(repoDir, wtDir, generationId, expectedBranch)) return false
    try { updateMetadata(metadata, { ownerTaskId: ownerTaskId.trim() }) } catch { return false }
    return true
  })
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
export async function removeWorktree(wtDir: string, expectedOwnerTaskId?: string, beforeReclaim?: (wtDir: string) => Promise<boolean>): Promise<boolean> {
  const result = await reclaimWorktree(wtDir, { deleteBranch: true, beforeReclaim, ...(expectedOwnerTaskId !== undefined ? { expectedOwnerTaskId } : {}) })
  return result.ok
}

/** 删除分支（best-effort）。用 -D：跨 worktree 场景 -d 的"是否已合并"判定不可靠，由调用方保证内容已合入集成分支。 */
export async function deleteBranch(workdir: string, name: string): Promise<boolean> {
  if (!workdir || !name) return false
  return (await runGit(workdir, ['branch', '-D', name], 15000)).ok
}

/** 清扫带可靠 owner metadata 的遗留 worktree。缺失归属的目录或 Git 注册仅报告并保留；
 *  keepTask 第二参传入该目录的 owner metadata：续链集成 worktree 的保留判定需要它。 */
export async function pruneWorktrees(
  repoDir: string,
  keepTask: (taskId: string, worktree?: WorktreeInfo) => boolean = () => false,
  options: { maxAgeMs?: number; now?: number; claimWorktree?: (taskId: string, mergeWorktree: boolean) => WorktreePruneLease | undefined; beforeReclaim?: (wtDir: string) => Promise<boolean> } = {}
): Promise<WorktreePruneResult> {
  const root = await repositoryRoot(repoDir)
  const result: WorktreePruneResult = { repoDir: root ?? repoDir, scanned: 0, removed: [], retained: [], failed: [] }
  if (!root) return result
  const worktreeDir = managedRoot(root)
  let entries: fs.Dirent[] = []
  try { entries = fs.readdirSync(worktreeDir, { withFileTypes: true }) } catch {}
  const names = new Set(entries.filter((entry) => entry.isDirectory() && entry.name !== WORKTREE_METADATA_DIR).map((entry) => entry.name))
  for (const metadata of listWorktreeMetadata(root)) names.add(path.basename(metadata.path))
  const common = await runGit(root, ['rev-parse', '--git-common-dir'])
  const gitDir = common.ok && common.stdout.trim() ? commonGitDir(root, common.stdout.trim()) : ''
  const registrations = gitDir ? listManagedWorktreeRegistrations(root, gitDir) : new Map<string, RegisteredWorktree>()
  for (const name of registrations.keys()) names.add(name)
  const now = options.now ?? Date.now()
  const maxAgeMs = Math.max(0, options.maxAgeMs ?? DEFAULT_WORKTREE_MAX_AGE_MS)
  // 遍历按路径键去重：磁盘目录（真实写法）与 sidecar/Git 注册表记录的别名写法是同一棵树，
  // 折叠后重复计数会把同一现场扫两遍（第二遍因第一遍已收场误报「元数据缺失」）
  const scannedKeys = new Set<string>()
  for (const name of names) {
    const scanKey = worktreePathKey(path.join(worktreeDir, name))
    if (scannedKeys.has(scanKey)) continue
    scannedKeys.add(scanKey)
    const wtPath = path.join(worktreeDir, name)
    const sidecarPath = metadataFile(root, name)
    let metadata = readMetadataFile(sidecarPath)
    const hasOwnerMetadata = !!metadata
    let verifiedMergeScaffold = false
    result.scanned++
    // 登记查找与世代核验同一套折叠语义（registeredWorktreeForPath）：磁盘目录名与
    // Git 注册表键仅大小写不同（别名写法落盘的 gitdir）时，字面量键取不到登记——
    // merge 脚手架的分支归属、失败证据里的注册路径/分支全都跟着丢失
    const registration = registeredWorktreeForPath(registrations, wtPath)
    if (!metadata && !fs.existsSync(sidecarPath) && hasMergeScaffoldMarker(name, MERGE_SCAFFOLD_MARKER)) {
      const generationId = await currentWorktreeGeneration(root, wtPath)
      if (generationId && !await verifyWorktreeGeneration(root, wtPath, generationId, registration?.branch)) {
        const stat = (() => { try { return fs.statSync(wtPath) } catch { return null } })()
        metadata = {
          ownerTaskId: name,
          generationId,
          repoDir: root,
          path: wtPath,
          branch: registration?.branch ?? '',
          baseSha: '',
          createdAt: stat?.birthtimeMs ?? stat?.mtimeMs ?? now,
          cleanupStatus: 'active'
        }
        verifiedMergeScaffold = true
      }
    }
    const reliableMetadata = metadata
      // 元数据 repoDir/path 与现场的一致性按别名折叠判定：另一进程按别名写法落盘的
      // 元数据不得被误判「不匹配」而拒绝清扫（漏回收），也不得放过真正错位的登记
      && sameWorktreePath(metadata.repoDir, root)
      && sameWorktreePath(metadata.path, wtPath)
      && !!metadata.ownerTaskId.trim()
    if (!metadata || !reliableMetadata) {
      // 项8：无主空树残骸回收——三方归属证据全空（无 sidecar 元数据、无 Git 注册）
      // 且目录本身为空：识别为建树中断残骸回收。rmdir 只接受空目录，天然不误删
      // 有内容的树；有任何证据（注册/分支/元数据错位）的现场仍走下方 failed 清单
      // 保留（证据清单可见），绝不凭「看起来没主」动有内容的树。
      const ownerlessEmpty = !metadata && !registration && (() => {
        try { return fs.existsSync(wtPath) && fs.readdirSync(wtPath).length === 0 } catch { return false }
      })()
      if (ownerlessEmpty) {
        try { fs.rmdirSync(wtPath); result.removed.push(name); continue } catch { /* rmdir 失败（竞态占用等）落回 failed 清单 */ }
      }
      const registeredBranchExists = registration?.branch ? await branchExists(root, registration.branch) : false
      const evidence = [
        fs.existsSync(wtPath) ? `目录 ${wtPath}` : '',
        registration ? `git 注册 ${registration.registrationPath}${registration.head ? '' : ' (missing HEAD)'}` : '',
        registeredBranchExists ? `分支 ${registration?.branch}` : ''
      ].filter(Boolean).join('；')
      result.failed.push({
        name,
        reason: `owner 元数据缺失或不匹配，现场保留且未尝试清理${evidence ? `：${evidence}` : ''}`
      })
      continue
    }
    // merge 临时目录（.agentdeck-merge-* / .agentdeck-merge-detach-*）是施工脚手架非成果载体：
    // 集成结果都落在分支上，owner 存续（哪怕在册且检出同一集成分支）不构成保留理由——
    // crashLeftover 判定先于 keepTask，直接进回收流程（租约照拿，拿不到 retain 待下轮）；
    // isIntegrationBranch 守卫照旧：只删目录与侧车，集成分支仅删任务的显式路径可带走。
    const crashLeftover = hasMergeScaffoldMarker(name, MERGE_SCAFFOLD_MARKER)
    const owner = metadata.ownerTaskId
    const pooledEntry = metadata?.ownerTaskId === WORKTREE_POOL_OWNER
    if (pooledEntry && worktreePoolByRepo.get(worktreePathKey(root))?.has(worktreePathKey(wtPath))) {
      result.retained.push({ name, reason: 'worktree is active in the reuse pool' })
      continue
    }
    if (pooledEntry && processOwnerState(metadata?.poolProcess) !== 'dead') {
      result.retained.push({ name, reason: 'pool owner process is live or cannot be verified dead' })
      continue
    }
    if (!crashLeftover && owner && owner !== WORKTREE_POOL_OWNER && keepTask(owner, metadata ?? undefined)) {
      result.retained.push({ name, reason: 'owner task or Git operation is still active' })
      continue
    }
    if (metadata?.cleanupStatus === 'removed' && !fs.existsSync(wtPath)
      && metadata.branch.startsWith(MANAGED_BRANCH_PREFIX) && !(await branchExists(root, metadata.branch))) {
      if (registration) {
        result.failed.push({ name, reason: `worktree directory and branch are gone but Git registration remains: ${registration.registrationPath}`, ...(owner && owner !== name ? { ownerTaskId: owner } : {}) })
      }
      continue
    }
    if (!metadata.generationId) {
      result.failed.push({ name, reason: 'legacy worktree metadata has no generation identity', ...(owner && owner !== name ? { ownerTaskId: owner } : {}) })
      continue
    }
    const generationMismatch = await verifyWorktreeGeneration(
      root,
      wtPath,
      metadata.generationId,
      metadata.cleanupStatus === 'pooled' ? undefined : metadata.branch || undefined
    )
    // 项4：目录已消失的条目不再被盘面代际核验失败拦在 failed 清单外——核验依赖
    // 目录内指针/标记，目录不在必败；放行到下游（removed 状态的既有收场流程 /
    // reclaimWorktreeUnlocked 的受检 prune + 证据核验分支删除）。目录还在的树
    // 照旧 fail-closed。
    if (generationMismatch && fs.existsSync(wtPath)) {
      // 池损坏条目的脱池留痕（retainUnverifiablePoolEntry 标记的 failed 记录）随清扫
      // 上报一并可见：重启清扫可凭处置记录识别「这是复用时代际校验失败脱池的现场」
      const recordedDisposal = metadata.cleanupStatus === 'failed' && metadata.cleanupReason
        ? `；处置记录：${metadata.cleanupReason}`
        : ''
      const reason = `${generationMismatch}${metadata.branch ? `; branch ${metadata.branch} retained` : ''}${recordedDisposal}`
      result.failed.push({ name, reason, ...(owner && owner !== name ? { ownerTaskId: owner } : {}) })
      continue
    }
    if (metadata?.cleanupStatus === 'removed' && !fs.existsSync(wtPath)) {
      const lease = pooledEntry ? undefined : options.claimWorktree?.(owner, hasMergeScaffoldMarker(name, MERGE_SCAFFOLD_MARKER))
      if (!lease && !pooledEntry) {
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
        } else if (metadata.branch.startsWith(MANAGED_BRANCH_PREFIX) && await deleteBranchWithRetry(root, metadata.branch)) {
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
    if (!crashLeftover && maxAgeMs > 0 && now - createdAt < maxAgeMs) {
      result.retained.push({ name, reason: 'within retention window' })
      continue
    }
    const lease = pooledEntry ? undefined : options.claimWorktree?.(owner, crashLeftover)
    if (!lease && !pooledEntry) {
      result.retained.push({ name, reason: 'cleanup ownership could not be established' })
      continue
    }
    try {
      // 集成分支对清扫路径只减目录、不减分支（isIntegrationBranch 守卫）：
      // 集成结果在分支上，目录只是检出；删任务的显式路径才允许连分支一起删。
      // 施工脚手架对脏判定豁免（force）：租约已确保无在途 Git 操作、仓库任务全部终态，
      // 崩溃残留的冲突/半成品状态不构成保留理由。
      const reclaimOptions = {
        ...(crashLeftover ? { force: true } : {}),
        deleteBranch: !verifiedMergeScaffold && !isIntegrationBranch(metadata?.branch),
        ...(hasOwnerMetadata ? { expectedOwnerTaskId: metadata.ownerTaskId } : {}),
        expectedGenerationId: metadata.generationId,
        beforeReclaim: options.beforeReclaim
      }
      const reclaimed = verifiedMergeScaffold
        ? await withWorktreePathLock(wtPath, () => reclaimWorktreeUnlocked(wtPath, reclaimOptions, true))
        : await reclaimWorktree(wtPath, reclaimOptions)
      if (reclaimed.ok) result.removed.push(name)
      else if (reclaimed.residue?.length) {
        // 部分成功（目录已回收、分支/注册残留）映射进 failed：启动清扫的接线
        // （index.ts/system.ts → noteWorktreeCleanupFailure）据此把残留记上时间线，
        // 不再混进 retained 静默——这是「重派 branch already exists」连环的可见化出口。
        result.failed.push({ name, reason: reclaimed.reason ?? 'partial cleanup', ...(owner && owner !== name ? { ownerTaskId: owner } : {}) })
      }
      else if (reclaimed.status === 'retained') result.retained.push({ name, reason: reclaimed.reason ?? 'retained by policy' })
      else result.failed.push({ name, reason: reclaimed.reason ?? 'cleanup failed', ...(owner && owner !== name ? { ownerTaskId: owner } : {}) })
    } finally {
      lease?.release()
    }
  }
  return result
}

/** Startup wrapper（maxAgeMs 默认 0）：返回完整报告而非仅 removed 名单——启动清扫据此把
 *  回收失败（含 merge 尸体占用）记上时间线，不再静默丢弃。 */
export async function sweepWorktrees(
  repoDir: string,
  keepTask: (taskId: string, worktree?: WorktreeInfo) => boolean,
  options: { maxAgeMs?: number; now?: number; claimWorktree?: (taskId: string, mergeWorktree: boolean) => WorktreePruneLease | undefined; beforeReclaim?: (wtDir: string) => Promise<boolean> } = {}
): Promise<WorktreePruneResult> {
  // Ownerless worktrees remain fail-closed even when clean; callers receive them in failed.
  return pruneWorktrees(repoDir, keepTask, {
    ...options,
    maxAgeMs: options.maxAgeMs ?? 0
  })
}

/** Structured merge implementation. The legacy helper above remains private for compatibility during migration. */
export async function mergeBranchInto(
  repoDir: string,
  targetBranch: string,
  sourceBranch: string
): Promise<{ ok: boolean; conflict: boolean; message: string; cleanupWarning?: string }> {
  const root = await repositoryRoot(repoDir)
  if (!root) return { ok: false, conflict: false, message: 'cannot resolve merge repository root' }
  const exists = await runGit(root, ['rev-parse', '--verify', targetBranch])
  if (!exists.ok || !exists.stdout.trim()) {
    const created = await runGit(root, ['branch', targetBranch], 30000)
    if (!created.ok) return { ok: false, conflict: false, message: `cannot create integration branch ${targetBranch}: ${gitError(created)}` }
  }
  const tmpName = `.agentdeck-merge-${Date.now().toString(36)}`
  const wtPath = path.join(managedRoot(root), tmpName)
  fs.mkdirSync(managedRoot(root), { recursive: true })
  // 合并建树与 worker 建树同一规模档位（60s 固定超时在大仓必被检出击穿）
  const planned = await planWorktreeAddTimeout(root, repoDir)
  const added = await runGit(root, [...checkoutWorkersArgs(), 'worktree', 'add', wtPath, targetBranch], planned.timeoutMs, undefined, true)
  if (!added.ok) return { ok: false, conflict: false, message: `cannot create merge worktree: ${gitError(added)}` }
  const generationId = await registerWorktreeGeneration(root, wtPath)
  if (!generationId) {
    await runGit(root, ['worktree', 'remove', '--force', wtPath], 30000)
    return { ok: false, conflict: false, message: 'cannot mark merge worktree generation' }
  }
  try {
    writeMetadata({
      ownerTaskId: tmpName,
      generationId,
      repoDir: root,
      path: wtPath,
      branch: targetBranch,
      baseSha: (await branchHead(root, targetBranch)) ?? '',
      createdAt: Date.now(),
      cleanupStatus: 'active'
    })
  } catch (error) {
    const removed = await runGit(root, ['worktree', 'remove', '--force', wtPath], 30000)
    const message = `cannot persist merge worktree ownership metadata: ${error instanceof Error ? error.message : String(error)}`
    return { ok: false, conflict: false, message, ...(!removed.ok ? { cleanupWarning: `${tmpName}: ${gitError(removed)}` } : {}) }
  }
  // finally 兜不住（目录被占用等）→ 留痕不静默：目录名+原因进返回值（调用方记时间线），
  // 同时 console.warn 留现场；尸体由下轮启动清扫的 crashLeftover 通道兜底回收。
  let cleanupWarning: string | undefined
  const withWarning = <T extends { ok: boolean; conflict: boolean; message: string }>(result: T): T =>
    cleanupWarning ? { ...result, cleanupWarning } : result
  let outcome = { ok: false, conflict: false, message: 'merge did not complete' }
  try {
    const merged = await runGit(wtPath, [...AGENT_GIT_IDENTITY, 'merge', '--no-ff', '-m', `merge ${sourceBranch} into ${targetBranch}`, sourceBranch], 60000)
    const detail = `${merged.stderr}\n${merged.stdout}`.trim()
    const conflict = /conflict|automatic merge failed/i.test(detail)
    if (conflict) {
      await runGit(wtPath, ['merge', '--abort'], 30000)
      outcome = { ok: false, conflict: true, message: `merge conflict: ${detail.slice(0, 400)}` }
    } else if (!merged.ok) {
      outcome = { ok: false, conflict: false, message: detail.slice(0, 400) || `git exit ${merged.code ?? 'unknown'}` }
    } else {
      outcome = { ok: true, conflict: false, message: '' }
    }
  } finally {
    const removed = await runGit(root, ['worktree', 'remove', '--force', wtPath], 30000)
    if (removed.ok) removeMetadata(root, tmpName)
    if (!removed.ok && fs.existsSync(wtPath)) {
      cleanupWarning = `${tmpName}: ${gitError(removed)}`
      console.warn(`[git] merge 临时 worktree 清理失败（保留现场，待下轮清扫兜底）：${tmpName} — ${gitError(removed)}`)
    }
  }
  return withWarning(outcome)
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
): Promise<{ ok: boolean; conflict: boolean; message: string; cleanupWarning?: string }> {
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
  // 根目录归属按别名折叠判定：别名写法的 gitDir 恰为仓库 .git 时 isWithin 因 relative==='' 漏判、
  // 裸 === 大小写敏感——原位合并会被误拒
  const repoGitDir = path.resolve(repoDir, '.git')
  if (!(sameWorktreePath(gitDir, repoGitDir) || isWithin(repoGitDir, gitDir))) {
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
): Promise<{ ok: boolean; conflict: boolean; message: string; cleanupWarning?: string }> {
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
  // 合并建树与 worker 建树同一规模档位（60s 固定超时在大仓必被检出击穿）
  const planned = await planWorktreeAddTimeout(repoDir, repoDir)
  const added = await runGit(repoDir, [...checkoutWorkersArgs(), 'worktree', 'add', '--detach', wtPath, head], planned.timeoutMs, undefined, true)
  if (!added.ok) return refuse(`cannot create detached merge worktree: ${gitError(added)}`)
  const generationId = await registerWorktreeGeneration(repoDir, wtPath)
  if (!generationId) {
    const removed = await runGit(repoDir, ['worktree', 'remove', '--force', wtPath], 30000)
    return { ...refuse('cannot mark detached merge worktree generation'), ...(!removed.ok ? { cleanupWarning: `${tmpName}: ${gitError(removed)}` } : {}) }
  }
  try {
    writeMetadata({
      ownerTaskId: tmpName,
      generationId,
      repoDir,
      path: wtPath,
      branch,
      baseSha: head,
      createdAt: Date.now(),
      cleanupStatus: 'active'
    })
  } catch (error) {
    const removed = await runGit(repoDir, ['worktree', 'remove', '--force', wtPath], 30000)
    const message = `cannot persist detached merge worktree ownership metadata: ${error instanceof Error ? error.message : String(error)}`
    return { ...refuse(message), ...(!removed.ok ? { cleanupWarning: `${tmpName}: ${gitError(removed)}` } : {}) }
  }
  // finally 兜不住（目录被占用等）→ 留痕不静默：目录名+原因进返回值（调用方记时间线），
  // 同时 console.warn 留现场；尸体由下轮启动清扫的 crashLeftover 通道兜底回收。
  let cleanupWarning: string | undefined
  const withWarning = <T extends { ok: boolean; conflict: boolean; message: string }>(result: T): T =>
    cleanupWarning ? { ...result, cleanupWarning } : result
  let outcome = { ok: false, conflict: false, message: 'merge did not complete' }
  let mergedOk = false
  try {
    const merged = await runGit(wtPath, [...AGENT_GIT_IDENTITY, 'merge', '--no-ff', '-m', `merge ${sourceBranch} into ${branch} (detached)`, sourceBranch], 60000)
    const detail = `${merged.stderr}\n${merged.stdout}`.trim()
    const conflict = /conflict|automatic merge failed/i.test(detail)
    if (conflict) {
      await runGit(wtPath, ['merge', '--abort'], 30000)
      outcome = { ok: false, conflict: true, message: `merge conflict: ${detail.slice(0, 400)}` }
    } else if (!merged.ok) {
      outcome = { ok: false, conflict: false, message: detail.slice(0, 400) || `git exit ${merged.code ?? 'unknown'}` }
    } else {
      const mergedHead = await branchHead(wtPath, 'HEAD')
      if (!mergedHead) {
        outcome = { ok: false, conflict: false, message: 'detached merge produced no head' }
      } else {
        const moved = await runGit(repoDir, ['update-ref', `refs/heads/${branch}`, mergedHead], 15000)
        if (!moved.ok) outcome = { ok: false, conflict: false, message: `update-ref failed: ${gitError(moved)}` }
        else mergedOk = true
      }
    }
  } finally {
    const removed = await runGit(repoDir, ['worktree', 'remove', '--force', wtPath], 30000)
    if (removed.ok) removeMetadata(repoDir, tmpName)
    if (!removed.ok && fs.existsSync(wtPath)) {
      cleanupWarning = `${tmpName}: ${gitError(removed)}`
      console.warn(`[git] merge 临时 worktree 清理失败（保留现场，待下轮清扫兜底）：${tmpName} — ${gitError(removed)}`)
    }
  }
  if (!mergedOk) return withWarning(outcome)
  // 回指后托管副本停在旧提交（index 陈旧形态）：幻影暂存守卫下对齐干净副本
  const realigned = await realignCleanWorktreeToHead(wtDir)
  if (!realigned.ok) {
    return withWarning({ ok: false, conflict: false, message: `merged into ${branch} via detached worktree, but managed copy realignment failed: ${realigned.reason ?? 'unknown'}` })
  }
  return withWarning({ ok: true, conflict: false, message: '' })
}
