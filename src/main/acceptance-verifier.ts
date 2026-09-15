import fs from 'node:fs'
import path from 'node:path'
import type { Goal, Task } from '../shared/types'
import type { GoalAcceptanceEvidence, GoalAcceptanceVerifierResult } from './goal-controller'

/**
 * Conservative host-side acceptance checks. Criteria opt in with an explicit
 * machine prefix; natural-language criteria return null and retain the legacy
 * compatibility path until a verifier is supplied for them.
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
      const inside = target === path.resolve(root) || target.startsWith(`${path.resolve(root)}${path.sep}`)
      const passed = inside && fs.existsSync(target)
      evidence.push({ criterionId: criterion.id, passed, evidence: passed ? `exists: ${path.relative(root, target)}` : `missing: ${fileMatch[1].trim()}` })
      continue
    }
    if (diffMatch) {
      const wanted = diffMatch[1].trim()
      const diff = task.gitDiff ?? ''
      evidence.push({ criterionId: criterion.id, passed: !!wanted && diff.includes(wanted), evidence: `gitDiff contains ${JSON.stringify(wanted)}` })
      continue
    }
    // Natural-language criteria are not safe to infer from model prose.
    // Keep them explicitly failed until a host verifier rule is supplied.
    evidence.push({ criterionId: criterion.id, passed: false, evidence: 'no deterministic host verifier rule' })
  }
  return evidence
}
