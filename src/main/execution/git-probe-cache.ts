// Git 工作区探测缓存：成功/非仓库结果带缓存，临时探测错误不缓存；测试探针出口。
// 自 runner.ts 原样搬迁（批次 1，零行为变化）：探测缓存与测试探针按归属设计收拢为本模块
// 私有状态（原为 TaskRunner 实例字段，探测本身是确定性的文件系统检查，缓存粒度变化无语义差）。
import { probeGitRepository, worktreePathKey, type GitRepositoryProbeResult } from '../git'

/** 测试探针出口：观测 Git 工作区探测缓存的命中/未命中（同一目录按别名写法调用必须
 *  命中同一缓存键——事件序 hit 前必有且仅有一次 miss）。 */
export type GitRepositoryProbeCacheEvent = 'hit' | 'miss'
let gitRepositoryProbeCacheProbe: ((event: GitRepositoryProbeCacheEvent) => void) | undefined
export function setGitRepositoryProbeCacheProbeForTest(listener: ((event: GitRepositoryProbeCacheEvent) => void) | undefined): void {
  gitRepositoryProbeCacheProbe = listener
}

const gitUsableCache = new Map<string, GitRepositoryProbeResult>()

/** Git 工作区探测（成功/非仓库带缓存；临时探测错误不缓存）。
 *  缓存键与 git.ts 的路径键同源折叠：同一目录按别名写法（大小写/盘符差异）调用
 *  必须命中同一份缓存，绝不重复探测。 */
export async function gitRepositoryProbe(dir: string): Promise<GitRepositoryProbeResult> {
  const key = worktreePathKey(dir)
  const cached = gitUsableCache.get(key)
  if (cached) {
    gitRepositoryProbeCacheProbe?.('hit')
    return cached
  }
  gitRepositoryProbeCacheProbe?.('miss')
  const probe = await probeGitRepository(dir)
  if (probe.status !== 'error') gitUsableCache.set(key, probe)
  return probe
}
