// git 快照与委派 worktree 支持
import { execFile } from 'node:child_process'
import path from 'node:path'

export interface GitCommandResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number | null
}

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

/** 为 worker 创建隔离 worktree（含独立分支）；失败返回 null（回退共享目录）
 *  worktree 一律放在主仓库根的 .agentdeck-worktrees 下——从 worktree 再开（二层委派）也归位主仓库，
 *  避免嵌套进父级工作树污染其 status；exclude 也写进主 gitdir（worktree 间共享）。 */
export async function createWorktree(
  repoDir: string,
  name: string,
  baseBranch?: string
): Promise<{ path: string; branch: string } | null> {
  if (!(await isGitRepo(repoDir))) return null
  const branch = `agentdeck/${name}`
  const gcd = (await git(repoDir, ['rev-parse', '--git-common-dir'])).trim()
  const gitDir = gcd ? path.resolve(repoDir, gcd) : path.join(repoDir, '.git')
  const root = path.dirname(gitDir)
  const wtPath = path.join(root, '.agentdeck-worktrees', name)
  const out = await runGit(repoDir, ['worktree', 'add', '-b', branch, wtPath, ...(baseBranch ? [baseBranch] : [])], 60000)
  if (!out.ok && !(await isGitRepo(wtPath))) return null
  // 把 worktree 目录从主仓库状态里排除，避免污染主目录的 status
  const excludeFile = path.join(gitDir, 'info', 'exclude')
  try {
    const fs = await import('node:fs')
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true })
    const cur = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf8') : ''
    if (!cur.includes('.agentdeck-worktrees/')) {
      fs.appendFileSync(excludeFile, '\n.agentdeck-worktrees/\n')
    }
  } catch {}
  return { path: wtPath, branch }
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
