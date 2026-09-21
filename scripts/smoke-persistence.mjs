// Persistence smoke: isolated temp data, two in-process instances, and real
// child processes exercising the public TaskStore/TaskService/IssueStore APIs.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const worker = path.join(root, 'scripts', 'fixtures', 'persistence-worker.mjs')
const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-persistence-bundles-'))
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-persistence-'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const files = [
  ['src/main/store.ts', 'store.cjs'],
  ['src/main/issue-store.ts', 'issue-store.cjs'],
  ['src/main/task-service.ts', 'task-service.cjs'],
  ['src/main/persistence.ts', 'persistence.cjs']
]

let failed = 0
const check = (condition, label) => {
  console.log(`  ${condition ? 'OK' : 'FAIL'} ${label}`)
  if (!condition) failed++
}

async function loadBundles() {
  for (const [source, output] of files) {
    await build({
      entryPoints: [path.join(root, source)],
      outfile: path.join(bundleDir, output),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node18',
      external: ['electron']
    })
  }
  const [{ TaskStore }, { IssueStore }, { TaskService }] = await Promise.all([
    import(pathToFileURL(path.join(bundleDir, 'store.cjs')).href),
    import(pathToFileURL(path.join(bundleDir, 'issue-store.cjs')).href),
    import(pathToFileURL(path.join(bundleDir, 'task-service.cjs')).href)
  ])
  return { TaskStore, IssueStore, TaskService }
}

function makeDir(name) {
  const dir = path.join(dataRoot, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function startWorker(dataDir, name) {
  const child = spawn(process.execPath, [worker, dataDir], {
    cwd: root,
    env: { ...process.env, AGENTDECK_PERSISTENCE_BUNDLE_DIR: bundleDir },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  let buffer = ''
  let nextId = 1
  let readyResolve
  let readyReject
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const readyTimer = setTimeout(() => readyReject(new Error(`${name} readiness timed out`)), 15000)
  void ready.then(() => clearTimeout(readyTimer), () => clearTimeout(readyTimer))
  const pending = new Map()
  let stderr = ''
  let resolveExit
  const exited = new Promise((resolve) => { resolveExit = resolve })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      let message
      try { message = JSON.parse(line) } catch (error) {
        const invalid = new Error(`${name} emitted invalid JSON: ${line}`)
        readyReject(invalid)
        for (const callback of pending.values()) callback.reject(invalid)
        pending.clear()
        continue
      }
      if (message.ready) {
        readyResolve(message)
        continue
      }
      const callback = pending.get(message.id)
      if (!callback) continue
      pending.delete(message.id)
      if (message.error) callback.reject(new Error(message.error))
      else callback.resolve(message.value)
    }
  })
  child.once('error', (error) => {
    readyReject(error)
    for (const callback of pending.values()) callback.reject(error)
    pending.clear()
  })
  child.once('exit', (code, signal) => {
    const error = new Error(`${name} exited (${code ?? signal})${stderr ? `: ${stderr.trim()}` : ''}`)
    resolveExit()
    readyReject(error)
    for (const callback of pending.values()) callback.reject(error)
    pending.clear()
  })
  return {
    child,
    ready,
    request(op, fields = {}) {
      const id = `${name}-${nextId++}`
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${name} request ${op} timed out`)) }, 15000)
        pending.set(id, {
          resolve: (value) => { clearTimeout(timer); resolve(value) },
          reject: (error) => { clearTimeout(timer); reject(error) }
        })
        child.stdin.write(`${JSON.stringify({ id, op, ...fields })}\n`)
      })
    },
    stop() {
      child.stdin.end()
      if (!child.killed) child.kill()
    },
    exited
  }
}

async function withWorkers(dataDir, callback) {
  const workers = [startWorker(dataDir, 'worker-a'), startWorker(dataDir, 'worker-b')]
  try {
    await Promise.all(workers.map((item) => item.ready))
    return await callback(workers)
  } finally {
    for (const item of workers) item.stop()
    await Promise.all(workers.map((item) => item.exited))
  }
}

function fulfilledValues(results) {
  return results.map((result) => result.status === 'fulfilled' ? result.value : undefined)
}

function reportRejected(results, label) {
  for (const result of results) {
    if (result.status === 'rejected') console.log(`  INFO ${label}: ${result.reason?.message ?? result.reason}`)
  }
}

function seedTask(dataDir, TaskStore, TaskService, input = {}) {
  const store = new TaskStore(dataDir, { recoverRunning: false })
  const issueStore = new (loaded.IssueStore)(dataDir)
  const service = new TaskService({ store, issueStore })
  return service.create({
    title: input.title ?? 'seed task',
    prompt: input.prompt ?? 'seed prompt',
    workdir: '',
    backend: 'fake',
    ...input
  })
}

let loaded
try {
  loaded = await loadBundles()

  console.log('\n[scenario] two TaskStore instances preserve independent creates')
  {
    const dataDir = makeDir('same-instance-create')
    const first = new loaded.TaskStore(dataDir, { recoverRunning: false })
    const second = new loaded.TaskStore(dataDir, { recoverRunning: false })
    first.create({ title: 'instance A', prompt: 'a', workdir: '', backend: 'fake' })
    second.create({ title: 'instance B', prompt: 'b', workdir: '', backend: 'fake' })
    const final = new loaded.TaskStore(dataDir, { recoverRunning: false }).list()
    check(final.length === 2 && final.some((task) => task.title === 'instance A') && final.some((task) => task.title === 'instance B'), 'same-process creates are merged')
  }

  console.log('\n[scenario] two TaskStore instances preserve independent updates')
  {
    const dataDir = makeDir('same-instance-update')
    const seed = seedTask(dataDir, loaded.TaskStore, loaded.TaskService)
    const first = new loaded.TaskStore(dataDir, { recoverRunning: false })
    const second = new loaded.TaskStore(dataDir, { recoverRunning: false })
    first.update(seed.id, { title: 'updated title' })
    second.update(seed.id, { prompt: 'updated prompt' })
    const final = new loaded.TaskStore(dataDir, { recoverRunning: false }).get(seed.id)
    check(final?.title === 'updated title' && final.prompt === 'updated prompt', 'same-process updates are merged')
  }

  console.log('\n[scenario] real child processes preserve independent creates and updates')
  {
    const createDir = makeDir('dual-process-create')
    await withWorkers(createDir, async ([first, second]) => {
      const results = await Promise.allSettled([
        first.request('create', { input: { title: 'process A', prompt: 'a', workdir: '', backend: 'fake' } }),
        second.request('create', { input: { title: 'process B', prompt: 'b', workdir: '', backend: 'fake' } })
      ])
      const [a, b] = fulfilledValues(results)
      reportRejected(results, 'dual-process create error')
      check(results.every((result) => result.status === 'fulfilled'), 'dual-process create operations complete without persistence errors')
      const final = new loaded.TaskStore(createDir, { recoverRunning: false }).list()
      check(final.length === 2 && final.some((task) => task.title === 'process A') && final.some((task) => task.title === 'process B'), 'dual-process creates are merged')
      check(!!a?.id && !!b?.id && a.id !== b.id, 'independent process creates receive distinct task IDs')
    })

    const updateDir = makeDir('dual-process-update')
    const seed = seedTask(updateDir, loaded.TaskStore, loaded.TaskService)
    await withWorkers(updateDir, async ([first, second]) => {
      const results = await Promise.allSettled([
        first.request('update', { taskId: seed.id, patch: { title: 'process title' } }),
        second.request('update', { taskId: seed.id, patch: { prompt: 'process prompt' } })
      ])
      reportRejected(results, 'dual-process update error')
      check(results.every((result) => result.status === 'fulfilled'), 'dual-process update operations complete without persistence errors')
      const final = new loaded.TaskStore(updateDir, { recoverRunning: false }).get(seed.id)
      check(final?.title === 'process title' && final.prompt === 'process prompt', 'dual-process updates are merged')
    })
  }

  console.log('\n[scenario] delete followed by a stale update does not resurrect a task')
  {
    const dataDir = makeDir('delete-then-update')
    const seed = seedTask(dataDir, loaded.TaskStore, loaded.TaskService)
    await withWorkers(dataDir, async ([stale, deleter]) => {
      await stale.request('snapshot', { taskId: seed.id })
      await deleter.request('delete', { taskId: seed.id })
      await stale.request('update', { taskId: seed.id, patch: { title: 'must stay deleted' } })
      const final = new loaded.TaskStore(dataDir, { recoverRunning: false }).get(seed.id)
      check(!final, 'stale update cannot resurrect a deleted task')
    })
  }

  console.log('\n[scenario] the same dedupe key creates one task and one projection')
  {
    const dataDir = makeDir('dedupe')
    const input = { title: 'deduped', prompt: 'one request', workdir: '', backend: 'fake', dedupeKey: 'persistence-dedupe-key' }
    await withWorkers(dataDir, async ([first, second]) => {
      const results = await Promise.allSettled([
        first.request('create', { input }),
        second.request('create', { input: { ...input, title: 'replayed request' } })
      ])
      const [a, b] = fulfilledValues(results)
      reportRejected(results, 'dedupe error')
      check(results.every((result) => result.status === 'fulfilled'), 'concurrent dedupe operations complete without persistence errors')
      const tasks = new loaded.TaskStore(dataDir, { recoverRunning: false }).list().filter((task) => task.dedupeKey === input.dedupeKey)
      const issues = new loaded.IssueStore(dataDir).list()
      check(!!a?.id && a.id === b?.id, 'concurrent dedupe requests return one task identity')
      check(tasks.length === 1, 'concurrent dedupe requests persist one task')
      check(issues.length === 1 && issues[0].taskId === tasks[0]?.id, 'concurrent dedupe requests persist one Issue projection')
    })
  }

  console.log('\n[scenario] stale projection sync preserves comments and human fields')
  {
    const dataDir = makeDir('stale-projection')
    const seed = seedTask(dataDir, loaded.TaskStore, loaded.TaskService)
    await withWorkers(dataDir, async ([stale, editor]) => {
      const snapshot = await stale.request('snapshot', { taskId: seed.id })
      await editor.request('add-comment', { issueId: seed.issueId, content: 'human comment survives' })
      await editor.request('metadata', { issueId: seed.issueId, patch: { priority: 'high', labels: ['manual-review'] } })
      await editor.request('workflow', { issueId: seed.issueId, status: 'blocked' })
      // A late execution callback changes the derived status, forcing the
      // stale projection instance through its durable save path.
      await stale.request('project-stale', { task: { ...snapshot, status: 'running', runId: 'run_stale', startedAt: Date.now() } })
      const issue = new loaded.IssueStore(dataDir).get(seed.issueId)
      const comments = new loaded.IssueStore(dataDir).comments(seed.issueId)
      check(comments.some((comment) => comment.content === 'human comment survives'), 'stale projection keeps human comments')
      check(issue?.priority === 'high' && issue.labels.includes('manual-review'), 'stale projection keeps manual metadata')
      check(issue?.status === 'blocked' && issue.statusOverride === 'blocked', 'stale projection keeps manual workflow status')
    })
  }

  console.log('\n[scenario] execution claims are conditional and require death evidence for recovery')
  {
    const dataDir = makeDir('execution-claims')
    const seed = seedTask(dataDir, loaded.TaskStore, loaded.TaskService)
    const control = new loaded.TaskStore(dataDir, { recoverRunning: false })
    let winner
    await withWorkers(dataDir, async ([first, second]) => {
      const results = await Promise.all([first.request('claim', { taskId: seed.id, runId: 'run-a' }), second.request('claim', { taskId: seed.id, runId: 'run-b' })])
      const winners = results.filter(Boolean)
      check(winners.length === 1, 'two processes claim the queued task exactly once')
      winner = winners[0]
      control.update(seed.id, { executionOwner: { ...winner.executionOwner, leaseExpiresAt: Date.now() - 60000 } })
      check(control.recoverDeadRuns('queued').length === 0 && control.get(seed.id).status === 'running', 'an expired lease never takes over a live process')
      const staleOwner = { ...winner.executionOwner, token: 'different-runner-token' }
      check(control.updateIf(seed.id, { status: 'running', runId: winner.runId, executionOwner: staleOwner }, { status: 'done' }) === undefined, 'a stale owner cannot finish another execution even with the same run id')
      check(control.appendEvent(seed.id, { ts: Date.now(), kind: 'final', text: 'stale result' }, { runId: winner.runId, executionOwner: staleOwner }) === null, 'a stale owner cannot append execution events')
    })
    check(control.recoverDeadRuns('queued').length === 1 && control.recoverDeadRuns('queued').length === 0, 'a confirmed dead execution is recovered once')
    const unknown = control.create({ title: 'unknown', prompt: 'unknown', workdir: '', backend: 'fake' })
    control.update(unknown.id, { status: 'running', runId: 'unknown-owner' })
    check(control.recoverDeadRuns('queued').length === 0 && new loaded.TaskStore(dataDir).get(unknown.id).status === 'running', 'ownerless execution is not recovered by startup or takeover')
    control.flush()
  }

  console.log('\n[scenario] delete wins over stale append, truncate and delayed flush')
  {
    const dataDir = makeDir('delete-flush')
    const seed = seedTask(dataDir, loaded.TaskStore, loaded.TaskService)
    const stale = new loaded.TaskStore(dataDir)
    const deleter = new loaded.TaskStore(dataDir)
    stale.appendEvent(seed.id, { ts: 1, kind: 'status', text: 'pending snapshot' })
    deleter.delete(seed.id)
    check(stale.appendEvent(seed.id, { ts: 2, kind: 'status', text: 'must not revive' }) === null, 'deleted task rejects stale append')
    check(stale.truncateEvents(seed.id, 0) === false, 'deleted task rejects stale truncate')
    stale.flush()
    check(!stale.get(seed.id) && !fs.existsSync(path.join(dataDir, 'tasks', seed.id)), 'delayed flush does not recreate an entry or directory')
  }

  console.log('\n[scenario] restart repairs an append followed by immediate process exit')
  for (const interveningWrite of [false, true]) {
    const dataDir = makeDir('append-exit-' + interveningWrite)
    const seed = seedTask(dataDir, loaded.TaskStore, loaded.TaskService)
    const peer = new loaded.TaskStore(dataDir)
    const taskDir = path.join(dataDir, 'tasks', seed.id)
    const index = path.join(dataDir, 'tasks', 'tasks.json')
    const writer = startWorker(dataDir, 'append-exit-writer')
    try {
      await writer.ready
      try { await writer.request('append-exit', { taskId: seed.id }) }
      catch (error) { if (!error.message.includes('exited (0)')) throw error }
      await writer.exited
      check(writer.child.exitCode === 0, 'the append writer exited before the flush timer')
      check(fs.readFileSync(path.join(taskDir, 'events.jsonl'), 'utf8').trim().split('\n').length === 1, 'the event reached durable JSONL')
      check(JSON.parse(fs.readFileSync(index, 'utf8')).tasks[0].eventCount === 0, 'the crash window leaves the old index count')
      if (interveningWrite) peer.create({ title: 'unrelated', prompt: 'unrelated', workdir: '', backend: 'fake' })
      const restarted = new loaded.TaskStore(dataDir)
      const repaired = () => JSON.parse(fs.readFileSync(index, 'utf8')).tasks.find((task) => task.id === seed.id).eventCount === 1
        && JSON.parse(fs.readFileSync(path.join(taskDir, 'task.json'), 'utf8')).eventCount === 1
      const deadline = Date.now() + 3000
      while (!repaired() && Date.now() < deadline) await sleep(20)
      check(repaired(), interveningWrite ? 'an unrelated peer commit cannot hide the unflushed event' : 'constructor schedules index and snapshot repair without a manual flush')
      restarted.flush()
      peer.flush()
    } finally { writer.stop(); await writer.exited }
  }

  console.log('\n[scenario] snapshot and deletion retries survive writer exit')
  for (const fault of ['write', 'fsync', 'rename', 'delete']) {
    const dataDir = makeDir('restart-' + fault)
    const seed = seedTask(dataDir, loaded.TaskStore, loaded.TaskService)
    const taskDir = path.join(dataDir, 'tasks', seed.id)
    const index = path.join(dataDir, 'tasks', 'tasks.json')
    await withWorkers(dataDir, async ([writer]) => {
      if (fault === 'delete') await writer.request('fault-delete', { taskId: seed.id })
      else await writer.request('fault-snapshot', { taskId: seed.id, fault, patch: { title: 'committed ' + fault } })
      const document = JSON.parse(fs.readFileSync(index, 'utf8'))
      check((fault === 'delete' ? document.pendingTaskDeletes : document.pendingTaskSnapshots)?.includes(seed.id), fault + ': failed derived work is committed with the index')
      check(fs.existsSync(taskDir), fault + ': fault leaves the old task directory for restart recovery')
      if (fault !== 'delete') check(JSON.parse(fs.readFileSync(path.join(taskDir, 'task.json'), 'utf8')).title === seed.title, fault + ': the old snapshot remains valid')
    })
    const restarted = new loaded.TaskStore(dataDir)
    const deadline = Date.now() + 3000
    const repaired = () => fault === 'delete'
      ? !fs.existsSync(taskDir)
      : JSON.parse(fs.readFileSync(path.join(taskDir, 'task.json'), 'utf8')).title === 'committed ' + fault
    while (!repaired() && Date.now() < deadline) await sleep(20)
    check(repaired(), fault + ': a new instance repairs the derived file without the old in-memory queue')
    const acknowledged = JSON.parse(fs.readFileSync(index, 'utf8'))
    check(!acknowledged.pendingTaskSnapshots?.length && !acknowledged.pendingTaskDeletes?.length, fault + ': restart acknowledges completed work')
    restarted.flush()
  }

  console.log('\n[scenario] legacy terminal attempts survive delayed projection and restart')
  {
    const dataDir = makeDir('legacy-projection-outbox')
    const store = new loaded.TaskStore(dataDir)
    const item = store.create({ title: 'legacy outbox', prompt: 'go', workdir: '', backend: 'fake' })
    store.update(item.id, { status: 'failed', attempt: 1, error: 'first legacy error' })
    store.update(item.id, { status: 'queued', attempt: 2, error: undefined })
    store.update(item.id, { status: 'failed', error: 'second legacy error' })
    const reloaded = new loaded.IssueStore(dataDir)
    reloaded.sync(new loaded.TaskStore(dataDir).list())
    reloaded.sync(store.list())
    const issueId = 'iss_' + item.id
    check(reloaded.runs(issueId).length === 2, 'each unprojected legacy attempt survives restart')
    const comments = reloaded.comments(issueId)
    check(comments.length === 2 && comments.some((comment) => comment.content.includes('first legacy error')) && comments.some((comment) => comment.content.includes('second legacy error')), 'legacy projection retries retain one report per attempt')
    reloaded.close()
    store.flush()
  }

  console.log('\n[scenario] terminal projection survives failure, restart and a newer run')
  {
    const dataDir = makeDir('projection-outbox')
    const store = new loaded.TaskStore(dataDir)
    const issues = new loaded.IssueStore(dataDir)
    const service = new loaded.TaskService({ store, issueStore: issues })
    const item = service.create({ title: 'outbox', prompt: 'outbox', backend: 'fake' })
    const index = path.join(dataDir, 'tasks', 'tasks.json')
    const issueIndex = path.join(dataDir, 'issues', 'index.json')
    const rename = fs.renameSync
    const report = console.error
    const errors = []
    let reloaded
    try {
      console.error = (...args) => errors.push(args)
      store.update(item.id, { status: 'done', runId: 'outbox-r1', result: 'first terminal report', endedAt: Date.now() })
      fs.renameSync = (from, to) => { if (to === issueIndex) throw Object.assign(new Error('injected projection failure'), { code: 'EIO' }); return rename(from, to) }
      issues.syncEventually(store.list())
      store.update(item.id, { status: 'running', runId: 'outbox-r2', result: undefined, endedAt: undefined })
      check(JSON.parse(fs.readFileSync(index, 'utf8')).pendingIssueProjections?.some((task) => task.runId === 'outbox-r1'), 'committed terminal run remains durable while its Task advances')
      issues.close()
      fs.renameSync = rename
      reloaded = new loaded.IssueStore(dataDir)
      reloaded.sync(store.list())
      reloaded.sync(store.list())
      check(reloaded.runs(item.issueId).some((run) => run.id === 'outbox-r1' && run.status === 'completed') && reloaded.runs(item.issueId).some((run) => run.id === 'outbox-r2'), 'restart projects the older terminal run and the current run')
      check(reloaded.comments(item.issueId).filter((comment) => comment.content === 'first terminal report').length === 1, 'replayed terminal projection creates one report')
      check(!JSON.parse(fs.readFileSync(index, 'utf8')).pendingIssueProjections?.length, 'projection acknowledgement follows the Issue commit')

      store.update(item.id, { status: 'done', result: 'second terminal report', endedAt: Date.now() })
      fs.renameSync = (from, to) => { if (to === issueIndex) throw Object.assign(new Error('injected projection failure'), { code: 'EIO' }); return rename(from, to) }
      reloaded.syncEventually(store.list())
      fs.renameSync = rename
      const deadline = Date.now() + 3000
      while (!reloaded.comments(item.issueId).some((comment) => comment.content === 'second terminal report') && Date.now() < deadline) await sleep(20)
      check(reloaded.comments(item.issueId).filter((comment) => comment.content === 'second terminal report').length === 1, 'background retry repairs a failed projection once')
      check(errors.length === 2, 'projection errors are reported without failing the committed Task')
    } finally {
      fs.renameSync = rename
      console.error = report
      issues.close()
      reloaded?.close()
      store.flush()
    }
  }
} finally {
  try { fs.rmSync(bundleDir, { recursive: true, force: true }) } catch {}
  try { fs.rmSync(dataRoot, { recursive: true, force: true }) } catch {}
}

console.log('\nAcceptance after persistence fixes: all checks above must pass with two instances and real two-process races; stale updates cannot revive deleted tasks; one dedupe key must return one Task and one Issue; projection retries must retain comments, metadata, and workflow overrides.')
if (failed) {
  console.error(`SMOKE PERSISTENCE: ${failed} check(s) failed (current implementation reproduction)`)
  process.exitCode = 1
} else {
  console.log('SMOKE PERSISTENCE: all checks passed')
}
