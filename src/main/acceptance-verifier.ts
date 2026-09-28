import fs from 'node:fs'
import path from 'node:path'
import type { Goal, Task } from '../shared/types'
import { currentGitChanges } from '../shared/git-snapshot'
import { worktreePathKey } from './git'
import type { GoalAcceptanceEvidence, GoalAcceptanceVerifierResult } from './goal-controller'

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
      // 根目录归属与 git.ts 的路径键同一套别名折叠（win32 大小写/盘符拼写差异）：
      // workdir 与目标按不同别名写法登记时，字面量 === / startsWith 会把仓库内文件
      // 误判到界外；折叠后根等值与界内前缀同源判定，目录边界照旧（非根前缀不误包含）
      const targetKey = worktreePathKey(target)
      const rootKey = worktreePathKey(root)
      const inside = targetKey === rootKey || targetKey.startsWith(`${rootKey}${path.sep}`)
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
