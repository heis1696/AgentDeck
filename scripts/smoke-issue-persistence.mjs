// IssueStore persistence smoke: transactions, committed task projection,
// concurrent instances/processes, retry after write failure, and tombstones.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-issue-persistence-'))
const bundle = path.join(tempRoot, 'issue-store.cjs')
const worker = path.join(root, 'scripts', 'fixtures', 'issue-persistence-worker.mjs')

await build({
  entryPoints: [path.join(root, 'src/main/issue-store.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  logLevel: 'silent'
})

const { IssueStore } = await import(pathToFileURL(bundle).href)

function task(id, overrides = {}) {
  return {
    id,
    title: `Task ${id}`,
    prompt: `Prompt ${id}`,
    workdir: '',
    backend: 'fake',
    status: 'running',
    createdAt: 100,
    startedAt: 110,
    eventCount: 1,
    ...overrides
  }
}

function makeDir(name) {
  const dir = path.join(tempRoot, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function startWorker(dataDir, name) {
  const child = spawn(process.execPath, [worker, dataDir], {
    cwd: root,
    env: { ...process.env, AGENTDECK_ISSUE_PERSISTENCE_BUNDLE: bundle },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  const pending = new Map()
  let buffer = ''
  let nextId = 1
  let stderr = ''
  let readyResolve
  let readyReject
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
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
    readyReject(error)
    for (const callback of pending.values()) callback.reject(error)
    pending.clear()
  })
  const readyTimer = setTimeout(() => readyReject(new Error(`${name} readiness timed out`)), 10000)
  ready.finally(() => clearTimeout(readyTimer)).catch(() => {})
  return {
    child,
    ready,
    exited,
    request(op, fields = {}) {
      const id = `${name}-${nextId++}`
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${name} ${op} timed out`)) }, 10000)
        pending.set(id, {
          resolve: (value) => { clearTimeout(timer); resolve(value) },
          reject: (error) => { clearTimeout(timer); reject(error) }
        })
        child.stdin.write(`${JSON.stringify({ id, op, ...fields })}\n`)
      })
    },
    stop() {
      child.stdin.end()
      if (child.exitCode === null && child.signalCode === null) child.kill()
    }
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

try {
  console.log('[scenario] two IssueStore instances merge latest comments and metadata')
  {
    const dir = makeDir('instances')
    const first = new IssueStore(dir)
    const second = new IssueStore(dir)
    const initial = task('same', { issueId: 'iss_same' })
    first.sync([initial])
    const issueId = first.list()[0].id
    second.addComment(issueId, 'human comment')
    first.updateMetadata(issueId, { priority: 'high', labels: ['manual-review'] })
    first.updateWorkflow(issueId, 'blocked')
    const next = task('retry', { issueId, createdAt: 200, runId: 'run-2', status: 'done', endedAt: 210, result: 'second run' })
    first.sync([initial, next])
    const reloaded = new IssueStore(dir)
    const issue = reloaded.get(issueId)
    assert.equal(reloaded.comments(issueId).some((item) => item.content === 'human comment'), true)
    assert.equal(issue?.priority, 'high')
    assert.deepEqual(issue?.labels, ['manual-review'])
    assert.equal(issue?.status, 'blocked')
    assert.equal(issue?.statusOverride, 'blocked')
    assert.equal(reloaded.runs(issueId).length, 2)
    console.log('  PASS same-process instances preserve comments, human fields, and other runs')
  }

  console.log('[scenario] structured task fingerprint distinguishes delimiter-shaped changes')
  {
    const dir = makeDir('structured-fingerprint')
    const store = new IssueStore(dir)
    const first = task('collision', {
      issueId: 'iss_collision',
      title: 'title',
      prompt: 'prompt\u001fshift'
    })
    const second = task('collision', {
      issueId: 'iss_collision',
      title: 'title\u001fprompt',
      prompt: 'shift'
    })
    store.sync([first])
    store.sync([second])
    const issue = store.get('iss_collision')
    assert.equal(issue?.title, second.title)
    assert.equal(issue?.description, second.prompt)
    console.log('  PASS complete structured fingerprint avoids control-character collisions')
  }

  console.log('[scenario] legacy reports are claimed once and same-run reports are corrected')
  {
    const dir = makeDir('report-identity')
    const firstRun = task('legacy-run', {
      issueId: 'iss_reports',
      status: 'done',
      runId: 'run-one',
      endedAt: 120,
      result: 'same output'
    })
    const store = new IssueStore(dir)
    store.sync([firstRun])
    const file = path.join(dir, 'issues', 'index.json')
    const legacy = JSON.parse(fs.readFileSync(file, 'utf8'))
    const reportId = legacy.comments[0].id
    legacy.comments[0].reactions = ['reviewed']
    delete legacy.comments[0].runId
    fs.writeFileSync(file, JSON.stringify(legacy))

    const reloaded = new IssueStore(dir)
    const human = reloaded.addComment('iss_reports', 'human annotation')
    reloaded.sync([firstRun])
    const reports = () => reloaded.comments('iss_reports').filter((comment) => comment.author.type === 'agent')
    let comments = reports()
    assert.equal(comments.length, 1)
    assert.equal(comments[0].runId, 'run-one')

    const secondRun = task('retry-run', {
      issueId: 'iss_reports',
      createdAt: 200,
      status: 'done',
      runId: 'run-two',
      endedAt: 220,
      result: 'same output'
    })
    reloaded.sync([firstRun, secondRun])
    comments = reports()
    assert.equal(comments.filter((item) => item.content === 'same output').length, 2)
    assert.deepEqual(new Set(comments.map((item) => item.runId)), new Set(['run-one', 'run-two']))

    const corrected = { ...firstRun, result: 'corrected output', endedAt: 230 }
    reloaded.sync([corrected, secondRun])
    comments = reports()
    assert.equal(comments.filter((item) => item.runId === 'run-one').length, 1)
    assert.equal(comments.find((item) => item.runId === 'run-one')?.content, 'corrected output')
    assert.equal(comments.find((item) => item.runId === 'run-two')?.content, 'same output')
    const amended = comments.find((item) => item.runId === 'run-one')
    assert.equal(amended.id, reportId)
    assert.deepEqual(amended.reactions, ['reviewed'])
    assert.equal(reloaded.comments('iss_reports').find((item) => item.id === human.id)?.content, 'human annotation')
    reloaded.sync([{ ...firstRun, status: 'queued', result: undefined }, secondRun])
    assert.equal(reports().find((item) => item.runId === 'run-one')?.content, 'corrected output', 'nonterminal projection preserves the previous report')
    reloaded.sync([{ ...corrected, result: '' }, secondRun])
    assert.equal(reports().find((item) => item.runId === 'run-one')?.content, '', 'an explicitly cleared terminal result does not leave the old report')
    console.log('  PASS legacy ownership is single-run and same-run reports update in place')
  }

  console.log('[scenario] ambiguous legacy reports are preserved')
  {
    const dir = makeDir('ambiguous-legacy-report')
    const terminal = task('ambiguous', {
      issueId: 'iss_ambiguous',
      agentId: 'agent-a',
      status: 'done',
      runId: 'run-ambiguous',
      endedAt: 100,
      result: 'same legacy output'
    })
    const store = new IssueStore(dir)
    store.sync([terminal])
    const file = path.join(dir, 'issues', 'index.json')
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'))
    const legacy = { ...persisted.comments[0] }
    delete legacy.runId
    persisted.comments[0] = legacy
    persisted.comments.push({ ...legacy, id: 'com_ambiguous_copy' })
    fs.writeFileSync(file, JSON.stringify(persisted))
    const reloaded = new IssueStore(dir)
    reloaded.sync([terminal])
    const reports = reloaded.comments('iss_ambiguous').filter((item) => item.author.type === 'agent')
    assert.equal(reports.filter((item) => item.runId === undefined).length, 2)
    assert.equal(reports.filter((item) => item.runId === 'run-ambiguous').length, 1)
    console.log('  PASS ambiguous legacy candidates retain their original comments')
  }

  console.log('[scenario] legacy retry attempt changes create a distinct Run')
  {
    const store = new IssueStore(makeDir('attempt-fingerprint'))
    const first = task('attempt', { status: 'done', result: 'same result', attempt: 1 })
    store.sync([first])
    store.sync([{ ...first, attempt: 2 }])
    assert.deepEqual(new Set(store.runs('iss_attempt').map((run) => run.id)), new Set(['legacy_attempt_1', 'legacy_attempt_2']))
    assert.equal(store.comments('iss_attempt').length, 2)
  }

  console.log('[scenario] committed Task index wins over a stale caller snapshot')
  {
    const dir = makeDir('committed-index')
    const committed = task('committed', { issueId: 'iss_committed', title: 'committed title', prompt: 'committed prompt', status: 'done', runId: 'run-committed', endedAt: 130, result: 'committed result' })
    fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'tasks', 'tasks.json'), JSON.stringify({ schemaVersion: 1, tasks: [committed] }))
    const stale = task('stale', { issueId: 'iss_committed', title: 'stale title', prompt: 'stale prompt', status: 'running' })
    const store = new IssueStore(dir)
    store.sync([stale])
    const issue = store.get('iss_committed')
    assert.equal(issue?.title, 'committed title')
    assert.equal(issue?.description, 'committed prompt')
    assert.equal(store.runForTask('committed')?.id, 'run-committed')
    console.log('  PASS projection reads committed Task index content inside the transaction')
  }

  console.log('[scenario] two real processes merge independent projections and comments')
  {
    const dir = makeDir('processes')
    const a = task('process-a', { issueId: 'iss_process_a' })
    const b = task('process-b', { issueId: 'iss_process_b', createdAt: 101 })
    await withWorkers(dir, async ([first, second]) => {
      await Promise.all([first.request('sync', { tasks: [a] }), second.request('sync', { tasks: [b] })])
      const issues = new IssueStore(dir).list()
      assert.equal(issues.length, 2)
      assert.deepEqual(new Set(issues.map((item) => item.id)), new Set(['iss_process_a', 'iss_process_b']))
    })
    const issueId = new IssueStore(dir).list()[0].id
    await withWorkers(dir, async ([first, second]) => {
      await Promise.all([
        first.request('comment', { issueId, content: 'comment from process A' }),
        second.request('comment', { issueId, content: 'comment from process B' })
      ])
    })
    const comments = new IssueStore(dir).comments(issueId).map((item) => item.content)
    assert.deepEqual(new Set(comments), new Set(['comment from process A', 'comment from process B']))
    console.log('  PASS real child processes serialize without losing independent writes')
  }

  console.log('[scenario] failed projection write remains retryable')
  {
    const dir = makeDir('retry')
    const store = new IssueStore(dir)
    const initial = task('retry-task', { issueId: 'iss_retry', status: 'queued' })
    store.sync([initial])
    const terminal = task('retry-task', { issueId: 'iss_retry', status: 'done', runId: 'run-retry', endedAt: 200, result: 'retry succeeded' })
    const originalRename = fs.renameSync
    let injected = true
    fs.renameSync = (source, destination, ...args) => {
      if (injected && destination === path.join(dir, 'issues', 'index.json')) {
        injected = false
        throw new Error('injected projection rename failure')
      }
      return originalRename(source, destination, ...args)
    }
    try {
      assert.throws(() => store.sync([terminal]), /injected projection rename failure/)
    } finally {
      fs.renameSync = originalRename
    }
    store.sync([terminal])
    assert.equal(store.get('iss_retry')?.status, 'in_review')
    assert.equal(store.runForTask('retry-task')?.id, 'run-retry')
    console.log('  PASS projection fingerprint advances only after a successful write')
  }

  console.log('[scenario] explicit deletion survives stale projection replay')
  {
    const dir = makeDir('delete')
    const taskToDelete = task('deleted', { issueId: 'iss_deleted', runId: 'run-deleted' })
    const store = new IssueStore(dir)
    store.sync([taskToDelete])
    assert.equal(store.deleteIssue('iss_deleted'), true)
    store.sync([taskToDelete])
    const reloaded = new IssueStore(dir)
    assert.equal(reloaded.get('iss_deleted'), undefined)
    const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'issues', 'index.json'), 'utf8'))
    assert.equal(persisted.deletedIssueIds.includes('iss_deleted'), true)
    console.log('  PASS deletion tombstone prevents stale task projection resurrection')
  }

  console.log('SMOKE ISSUE PERSISTENCE PASSED')
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
