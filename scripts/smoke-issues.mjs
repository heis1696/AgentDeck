import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const root = path.resolve(import.meta.dirname, '..')
const outfile = path.join(root, 'out', 'smoke-issue-store.cjs')
await build({ entryPoints: [path.join(root, 'src/main/issue-store.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
const { IssueStore } = await import(pathToFileURL(outfile).href)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-issues-'))
const store = new IssueStore(tmp)
const task = { id: 't_issue', title: 'Issue projection', prompt: 'ship it', workdir: '', backend: 'zcode', agentId: 'ag_zcode', status: 'done', createdAt: 1, startedAt: 2, endedAt: 3, result: 'Report is ready', eventCount: 4, usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, costUsd: 0, durationMs: 100, turns: 1 } }
store.sync([task])
const issue = store.list()[0]
const run = store.runs(issue.id)[0]
const notification = store.notifications()[0]
const comment = store.comments(issue.id)[0]
const ok = (condition, label) => { console.log(`  ${condition ? '✓' : '✗'} ${label}`); if (!condition) process.exitCode = 1 }
ok(issue.identifier === 'YOU-1' && issue.status === 'in_review', 'task becomes an issue')
ok(run?.status === 'completed' && run.transcriptEventCount === 4, 'completed run is projected')
ok(comment?.content === 'Report is ready' && notification?.kind === 'reported', 'result creates report and inbox notification')
const added = store.addComment(issue.id, 'A human follow-up')
ok(!!added && store.notifications().length === 2, 'comments create activity')
await import('node:fs/promises').then(({ access }) => access(path.join(tmp, 'issues', 'index.json')))
ok(true, 'projection is persisted')
const retryTask = { ...task, id: 't_retry', title: 'Retry history', runId: 'run_retry_a', startedAt: 4, endedAt: 5, result: 'first' }
store.sync([retryTask])
store.sync([{ ...retryTask, runId: 'run_retry_b', startedAt: 6, endedAt: 7, result: 'second' }])
ok(store.runs(store.list().find((item) => item.taskId === 't_retry').id).length === 2, 'retry creates a separate Run history entry')
const followUp = { ...task, id: 't_followup', issueId: issue.id, createdAt: 10, startedAt: 11, endedAt: 12, runId: 'run_followup', status: 'running', result: undefined }
store.sync([task, followUp])
ok(store.get(issue.id).status === 'in_progress' && store.runs(issue.id).length === 2, 'newer run owns issue status while prior run stays in history')
ok(store.get(issue.id).taskId === 't_followup', 'issue opens the latest execution record')
store.sync([{ ...task, issueId: issue.id }, { ...followUp, status: 'failed', error: '429 rate limit', endedAt: 13 }])
ok(store.comments(issue.id).some((item) => item.runId === 'run_followup' && item.content.includes('Agent execution error')), 'failed run creates a report with run association')
store.updateMetadata(issue.id, { priority: 'high', labels: ['review', 'review', 'code'] })
ok(store.get(issue.id).priority === 'high' && store.get(issue.id).labels.join(',') === 'review,code', 'issue metadata persists and normalizes')
store.updateWorkflow(issue.id, 'done')
store.sync([task])
ok(store.get(issue.id).status === 'done' && store.get(issue.id).statusOverride === 'done', 'human workflow status survives projection sync')

// 存量缺 id 数据：加载即补齐并持久化，taskId 关联不丢
const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-issues-legacy-'))
const legacyFile = path.join(legacyDir, 'issues', 'index.json')
fs.mkdirSync(path.join(legacyDir, 'issues'), { recursive: true })
fs.writeFileSync(legacyFile, JSON.stringify({ issues: [
  { identifier: 'YOU-1', title: 'Legacy no id', description: '', status: 'done', priority: 'none', labels: [], position: 1, createdBy: 'user', createdAt: 1, updatedAt: 1, taskId: 't_legacy' },
  { id: '', identifier: 'YOU-2', title: 'Legacy empty id', description: '', status: 'todo', priority: 'none', labels: [], position: 2, createdBy: 'user', createdAt: 2, updatedAt: 2, taskId: 't_legacy2' }
], runs: [], comments: [], notifications: [], nextIdentifier: 3 }))
const legacyStore = new IssueStore(legacyDir)
const backfilled = legacyStore.list()
const noIdIssue = backfilled.find((item) => item.taskId === 't_legacy')
const emptyIdIssue = backfilled.find((item) => item.taskId === 't_legacy2')
ok(backfilled.length === 2 && backfilled.every((item) => /^iss_.+$/.test(item.id)), 'missing/empty ids are backfilled on load')
ok(noIdIssue.id === 'iss_t_legacy' && emptyIdIssue.id === 'iss_t_legacy2', 'backfill follows the iss_<taskId> projection convention')
const onDisk = JSON.parse(fs.readFileSync(legacyFile, 'utf8'))
ok(onDisk.issues.length === 2 && onDisk.issues.every((item) => item.id === backfilled.find((issue) => issue.taskId === item.taskId).id), 'backfilled ids are persisted to disk')
const reloaded = new IssueStore(legacyDir)
ok(reloaded.get(noIdIssue.id)?.title === 'Legacy no id' && reloaded.get(emptyIdIssue.id)?.title === 'Legacy empty id', 'backfilled ids stay stable across reloads')
const legacyTask = { id: 't_legacy', title: 'Legacy no id', prompt: 'ship it', workdir: '', backend: 'zcode', agentId: 'ag_zcode', status: 'done', createdAt: 1, startedAt: 2, endedAt: 3, result: 'Report is ready', eventCount: 4, usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, costUsd: 0, durationMs: 100, turns: 1 } }
legacyStore.sync([legacyTask])
ok(legacyStore.list().length === 2 && legacyStore.get(noIdIssue.id).taskId === 't_legacy', 'existing issue is still found by taskId after backfill (no duplicate)')
legacyStore.sync([{ ...legacyTask, id: 't_followup', issueId: noIdIssue.id, createdAt: 10, startedAt: 11, endedAt: 12 }])
ok(legacyStore.list().length === 2 && legacyStore.get(noIdIssue.id).taskId === 't_followup', 'issue is found by backfilled id when task.issueId matches')

if (!process.exitCode) console.log('\n✓ ISSUE STORE SMOKE PASSED')
