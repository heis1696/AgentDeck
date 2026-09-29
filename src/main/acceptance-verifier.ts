import fs from 'node:fs'
import path from 'node:path'
import type { Goal, Task } from '../shared/types'
import { currentGitChanges } from '../shared/git-snapshot'
import { worktreePathKey } from './git'
import type { GoalAcceptanceEvidence, GoalAcceptanceVerifierResult } from './goal-controller'

/** 路径键界内判定：目标键与根键等值，或落在根前缀之下。归属与 git.ts 的路径键同一套
 *  别名折叠（win32 大小写/盘符拼写差异）；盘符根（C:\）与文件系统根（/）的路径键自带
 *  分隔符，根前缀只在缺分隔符时补——无脑再拼第二个 sep 会把界内目标判到界外（c:\file
 *  不以 c:\\ 为前缀）。纯键逻辑，不触碰文件系统：验收器归属与冒烟的边界守卫直断共用。 */
export function isInsidePathKey(target: string, root: string): boolean {
  const targetKey = worktreePathKey(target)
  const rootKey = worktreePathKey(root)
  const rootPrefix = rootKey.endsWith(path.sep) ? rootKey : `${rootKey}${path.sep}`
  return targetKey === rootKey || targetKey.startsWith(rootPrefix)
}

/**
 * Conservative host-side acceptance checks. Criteria opt in with an explicit
 * machine prefix; natural-language criteria return null and retain the legacy
 * compatibility path until a verifier is supplied for them.
 *
 * `git diff contains:` trusts only a snapshot whose provenance matches the
 * execution being verified and whose state is `available`. A diff left behind
 * by another Run, another phase, or legacy data without provenance is stale
 * evidence and must not certify acceptance.
 */
export function verifyAcceptance(goal: Goal, task: Task): GoalAcceptanceVerifierResult {
  const criteria = goal.acceptanceCriteria ?? []
  const root = task.workdir || goal.workdir || process.cwd()
  const evidence: GoalAcceptanceEvidence[] = []
  for (const criterion of criteria) {
    const fileMatch = criterion.text.match(/^\s*(?:file|path)\s+exists\s*:\s*(.+?)\s*$/i)
    const diffMatch = criterion.text.match(/^\s*git\s+diff\s+contains\s*:\s*(.+?)\s*$/i)
    if (fileMatch) {
      const target = path.resolve(root, fileMatch[1].trim())
      const inside = isInsidePathKey(target, root)
      const passed = inside && fs.existsSync(target)
      evidence.push({ criterionId: criterion.id, passed, evidence: passed ? `exists: ${path.relative(root, target)}` : `missing: ${fileMatch[1].trim()}` })
      continue
    }
    if (diffMatch) {
      const wanted = diffMatch[1].trim()
      const changes = currentGitChanges(task)
      const passed = !!wanted && !!changes && changes.diff.includes(wanted)
      evidence.push({
        criterionId: criterion.id,
        passed,
        evidence: changes
          ? `gitDiff ${passed ? 'contains' : 'does not contain'} ${JSON.stringify(wanted)}`
          : 'no available Git snapshot for the current run: diff rejected as evidence'
      })
      continue
    }
    // Natural-language criteria are not safe to infer from model prose.
    // Keep them explicitly failed until a host verifier rule is supplied.
    evidence.push({ criterionId: criterion.id, passed: false, evidence: 'no deterministic host verifier rule' })
  }
  return evidence
}
