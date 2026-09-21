import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const root = path.resolve(import.meta.dirname, '..')
const outfile = path.join(root, 'out', 'smoke-issue-store.cjs')
const taskStoreOutfile = path.join(root, 'out', 'smoke-issue-task-store.cjs')
await build({ entryPoints: [path.join(root, 'src/main/issue-store.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
await build({ entryPoints: [path.join(root, 'src/main/store.ts')], outfile: taskStoreOutfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
const { IssueStore } = await import(pathToFileURL(outfile).href)
const { TaskStore } = await import(pathToFileURL(taskStoreOutfile).href)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-issues-'))
const store = new IssueStore(tmp)
const task = { id: 't_issue', title: 'Issue projection', prompt: 'ship it', workdir: '', backend: 'zcode', agentId: 'ag_zcode', status: 'done', createdAt: 1, startedAt: 2, endedAt: 3, result: 'Report is ready', eventCount: 4, usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, costUsd: 0, durationMs: 100, turns: 1 } }
store.sync([task])
const issue = store.list()[0]
const run = store.runs(issue.id)[0]
const comment = store.comments(issue.id)[0]
const ok = (condition, label) => { console.log(`  ${condition ? '✓' : '✗'} ${label}`); if (!condition) process.exitCode = 1 }
ok(issue.identifier === 'YOU-1' && issue.status === 'in_review', 'task becomes an issue')
ok(run?.status === 'completed' && run.transcriptEventCount === 4, 'completed run is projected')
ok(comment?.content === 'Report is ready', 'result creates a report comment')
const added = store.addComment(issue.id, 'A human follow-up')
ok(!!added && store.comments(issue.id).length === 2, 'comments create activity')
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

/* -------- issues:update 合并落盘：状态与元数据同批提交时两样都要存（专项回归） -------- */
const mergeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-issues-merge-'))
const mergeStore = new IssueStore(mergeDir)
mergeStore.sync([{ ...task, id: 't_merge', title: 'Merge metadata' }])
const mergeIssue = mergeStore.list()[0]
const merged = mergeStore.update(mergeIssue.id, { status: 'in_progress', priority: 'urgent', labels: [' bug ', 'bug', 'ui'], dueDate: 1_700_000_000_000 })
ok(!!merged && merged.status === 'in_progress' && merged.statusOverride === 'in_progress', '同批提交：工作流状态落盘')
ok(merged.priority === 'urgent' && merged.labels.join(',') === 'bug,ui', '同批提交：priority 落盘、labels 归一化去重')
ok(merged.dueDate === 1_700_000_000_000, '同批提交：dueDate 落盘')
const mergeReloaded = new IssueStore(mergeDir).get(mergeIssue.id)
ok(mergeReloaded.status === 'in_progress' && mergeReloaded.statusOverride === 'in_progress', '同批提交的状态跨重启持久（statusOverride 不被投影覆盖）')
ok(mergeReloaded.priority === 'urgent' && mergeReloaded.labels.join(',') === 'bug,ui' && mergeReloaded.dueDate === 1_700_000_000_000, '同批提交的元数据跨重启持久')
const metaOnly = mergeStore.update(mergeIssue.id, { priority: 'low', labels: [] })
ok(metaOnly.status === 'in_progress' && metaOnly.priority === 'low' && metaOnly.labels.length === 0, '仅元数据更新：保留状态并支持清空 labels')
const statusOnly = mergeStore.update(mergeIssue.id, { status: 'done' })
ok(statusOnly.status === 'done' && statusOnly.statusOverride === 'done' && statusOnly.priority === 'low' && statusOnly.dueDate === 1_700_000_000_000, '仅状态更新：保留 priority/dueDate')
ok(mergeStore.update(mergeIssue.id, { dueDate: 0 }).dueDate === undefined, 'dueDate=0 清除截止日期')
const issueIds = mergeStore.list().map((item) => item.id).join(',')
ok(mergeStore.update('iss_missing', { status: 'done', priority: 'high', labels: ['x'], dueDate: 1 }) === null, '未知 Issue 返回 null')
ok(mergeStore.list().map((item) => item.id).join(',') === issueIds, '未知 Issue 更新不产生副作用')
ok(mergeStore.updateMetadata('iss_missing', { priority: 'high' }) === null && mergeStore.updateWorkflow('iss_missing', 'done') === null, '既有单字段入口对未知 Issue 同样返回 null')

/* -------- issues:update IPC handler：electron 打桩注册，验证同批提交真的走合并路径 -------- */
const electronStub = {
  name: 'electron-ipc-stub',
  setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-stub' }))
    build.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => ({
      contents: [
        'const handlers = new Map()',
        'globalThis.__agentdeckIpcHandlers = handlers',
        'export const ipcMain = {',
        '  handle: (channel, handler) => { handlers.set(channel, handler) },',
        '  removeHandler: (channel) => { handlers.delete(channel) }',
        '}'
      ].join('\n'),
      loader: 'js'
    }))
  }
}
const ipcOutfile = path.join(root, 'out', 'smoke-issue-ipc.cjs')
await build({ entryPoints: [path.join(root, 'src/main/ipc/issues.ts')], outfile: ipcOutfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18', logLevel: 'silent', plugins: [electronStub] })
const { registerIssueIpc } = await import(pathToFileURL(ipcOutfile).href)
const broadcasts = []
registerIssueIpc({ issueStore: mergeStore, getWindow: () => ({ webContents: { send: (channel, payload) => broadcasts.push({ channel, payload }) } }) })
const updateHandler = globalThis.__agentdeckIpcHandlers.get('issues:update')
ok(typeof updateHandler === 'function', 'issues:update handler 已注册')
const handlerIssue = updateHandler(null, mergeIssue.id, { status: 'in_review', priority: 'medium', labels: ['api', ' api '], dueDate: 42 })
ok(handlerIssue?.status === 'in_review' && handlerIssue.priority === 'medium' && handlerIssue.labels.join(',') === 'api' && handlerIssue.dueDate === 42, 'handler 同批提交：状态与元数据都落盘')
const handlerPersisted = new IssueStore(mergeDir).get(mergeIssue.id)
ok(handlerPersisted.status === 'in_review' && handlerPersisted.priority === 'medium' && handlerPersisted.labels.join(',') === 'api' && handlerPersisted.dueDate === 42, 'handler 合并结果跨重启持久')
ok(broadcasts.length === 1 && broadcasts[0].channel === 'issues:updated' && broadcasts[0].payload.issueId === mergeIssue.id && broadcasts[0].payload.issue.priority === 'medium', 'handler 广播合并后的 Issue')
ok(updateHandler(null, 'iss_missing', { status: 'done', priority: 'high', labels: ['x'], dueDate: 1 }) === null, 'handler 未知 Issue 返回 null')
ok(broadcasts.length === 1, 'handler 未知 Issue 不广播')

/* -------- issues:create projection fault: real IPC + committed Task + retry -------- */
const createDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-issues-create-'))
const createStore = new TaskStore(createDir)
const createIssueStore = new IssueStore(createDir)
const createBroadcasts = []
let createCount = 0
let projectionFault = true
const createIssueFile = path.join(createDir, 'issues', 'index.json')
const originalRename = fs.renameSync
fs.renameSync = (source, destination, ...args) => {
  if (projectionFault && destination === createIssueFile) throw new Error('injected IPC projection rename failure')
  return originalRename(source, destination, ...args)
}
const createTask = (input) => {
  const key = input.requestId || input.idempotencyKey
  const existing = key && createStore.list().find((item) => item.dedupeKey === key)
  if (existing) return existing
  createCount++
  const created = createStore.create({ title: input.title.trim(), prompt: input.prompt.trim(), workdir: input.workdir || '', backend: input.backend || 'fake', trigger: input.trigger || 'assignment', ...(key ? { dedupeKey: key } : {}) })
  return createStore.update(created.id, { issueId: `iss_${created.id}` })
}
registerIssueIpc({
  issueStore: createIssueStore,
  getWindow: () => ({ webContents: { send: (channel, payload) => createBroadcasts.push({ channel, payload }) } }),
  createTask,
  publishIssueUpdate: (task) => {
    createIssueStore.syncTaskEventually(task)
    createBroadcasts.push({ channel: 'issues:updated', payload: { taskId: task.id, issueId: task.issueId || `iss_${task.id}`, issue: createIssueStore.issueForTask(task) } })
  },
  runner: { enqueue: () => {} },
  agents: []
})
const createHandler = globalThis.__agentdeckIpcHandlers.get('issues:create')
const pendingIssue = createHandler(null, { title: 'IPC projection fault', description: 'already committed', startNow: false, requestId: 'ipc-once' })
fs.renameSync = originalRename
projectionFault = false
ok(pendingIssue?.id === `iss_${createStore.list()[0]?.id}` && pendingIssue?.taskId === createStore.list()[0]?.id, 'issues:create returns a stable derived Issue after projection failure')
ok(createBroadcasts.some((item) => item.channel === 'issues:updated' && item.payload.issue?.id === pendingIssue.id), 'failed projection still broadcasts the derived Issue')
await new Promise((resolve) => setTimeout(resolve, 350))
ok(!!new IssueStore(createDir).get(pendingIssue.id), 'background projection retry restores the durable Issue')
const sameIssue = createHandler(null, { title: 'IPC projection fault', description: 'already committed', startNow: false, requestId: 'ipc-once' })
ok(createCount === 1 && sameIssue.id === pendingIssue.id && new IssueStore(createDir).list().length === 1, 'idempotent issues:create does not create a second Task or Issue')

if (!process.exitCode) console.log('\n✓ ISSUE STORE SMOKE PASSED')
