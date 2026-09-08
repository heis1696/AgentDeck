import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
const root = path.resolve(import.meta.dirname, '..')
const outfile = path.join(root, 'out', 'smoke-taskflow.cjs')
await build({ entryPoints: [path.join(root, 'src/shared/taskflow.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
const { canTransition, validateMove, isTerminalTaskStatus, canRetry, taskStatusToIssueStatus, taskStatusToRunStatus, executionRecordFromTask } = await import(pathToFileURL(outfile).href)
let failed = 0
const ok = (condition, label) => { console.log(`  ${condition ? '✓' : '✗'} ${label}`); if (!condition) failed++ }
ok(canTransition('queued', 'running', 'runner'), 'runner starts queued task')
ok(canTransition('running', 'done', 'runner'), 'runner completes running task')
ok(!canTransition('cancelled', 'done', 'runner'), 'runner cannot revive cancelled task')
ok(validateMove('queued', 'running').ok, 'UI can start queued task')
ok(!validateMove('running', 'done').ok, 'UI cannot overwrite active execution')
ok(validateMove('done', 'queued').ok, 'UI can retry terminal task')
ok(!validateMove('done', 'running').ok, 'UI cannot jump terminal task to running')
ok(isTerminalTaskStatus('failed') && !isTerminalTaskStatus('running'), 'terminal status set is centralized')
ok(canRetry('cancelled') && !canRetry('queued'), 'retry rule is centralized')
ok(taskStatusToIssueStatus('done') === 'in_review', 'Issue status derives from task status')
ok(taskStatusToRunStatus('failed') === 'error', 'Run status derives from task status')
const record = executionRecordFromTask({ id: 't_record', issueId: 'iss_record', title: 'x', prompt: 'p', workdir: '', backend: 'zcode', status: 'done', createdAt: 1, endedAt: 3, eventCount: 2 })
ok(record.id === 'legacy_t_record_1' && record.issueId === 'iss_record' && record.status === 'completed', 'Task maps to explicit ExecutionRecord boundary')
if (failed) process.exitCode = 1
else console.log('\n✓ TASKFLOW SMOKE PASSED')
