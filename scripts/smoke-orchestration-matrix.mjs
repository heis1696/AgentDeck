// Stage 1 orchestration matrix: durable snapshots for Goal/delegate/retry/
// handoff/cancellation interactions. Every scenario owns an isolated fake
// backend, Task/Issue/Goal stores, and temporary Git repository.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-matrix-bundles-'))

for (const [source, output] of [
  ['src/main/runner.ts', 'runner.cjs'],
  ['src/main/store.ts', 'store.cjs'],
  ['src/main/goal-controller.ts', 'goal-controller.cjs'],
  ['src/main/goal-store.ts', 'goal-store.cjs'],
  ['src/main/issue-store.ts', 'issue-store.cjs'],
  ['src/main/task-service.ts', 'task-service.cjs']
]) {
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

const { TaskRunner } = await import(pathToFileURL(path.join(bundleDir, 'runner.cjs')).href)
const { TaskStore } = await import(pathToFileURL(path.join(bundleDir, 'store.cjs')).href)
const { GoalController } = await import(pathToFileURL(path.join(bundleDir, 'goal-controller.cjs')).href)
const { GoalStore } = await import(pathToFileURL(path.join(bundleDir, 'goal-store.cjs')).href)
const { IssueStore } = await import(pathToFileURL(path.join(bundleDir, 'issue-store.cjs')).href)
const { TaskService } = await import(pathToFileURL(path.join(bundleDir, 'task-service.cjs')).href)

// Keep retry scenarios immediate and deterministic. retry-policy reads this
// value when it schedules a retry, so no production setting is changed.
process.env.AGENTDECK_RETRY_DELAY_MS = '0'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(read, timeoutMs = 20_000, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = read()
    if (value) return value
    await wait(intervalMs)
  }
  return read()
}

async function waitForTerminal(store, taskId, timeoutMs = 20_000) {
  return waitFor(() => {
    const task = store.get(taskId)
    return task && task.status !== 'queued' && task.status !== 'running' ? task : null
  }, timeoutMs)
}

function initRepo(dir) {
  const repo = path.join(dir, 'repo')
  fs.mkdirSync(repo, { recursive: true })
  fs.writeFileSync(path.join(repo, 'README.txt'), 'baseline\n')
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=matrix@local', '-c', 'user.name=Matrix', 'commit', '-qm', 'baseline'], { cwd: repo })
  return repo
}

function scriptedBackend(id, plan) {
  const stats = { starts: [], sends: [], stops: 0, closes: 0 }
  let startIndex = 0
  let sessionIndex = 0
  const getStart = () => plan.starts[Math.min(startIndex++, plan.starts.length - 1)]
  const getSend = () => plan.sends[Math.min(stats.sends.length, plan.sends.length - 1)] ?? { response: 'ok' }

  const backend = {
    id,
    label: id,
    async probe() { return { ok: true, detail: '' } },
    start({ events, resumeSessionId }) {
      const step = getStart() ?? { response: 'ok' }
      stats.starts.push({ resumeSessionId, step })
      if (step.fail) {
        if (step.sessionId) events.onSessionId?.(step.sessionId)
        return new Promise((resolve, reject) => {
          setTimeout(() => reject(new Error(step.fail)), step.delayMs ?? 20)
        })
      }

      const sessionId = step.sessionId ?? `${id}-session-${++sessionIndex}`
      const session = {
        sessionId,
        async send(content) {
          const sendStep = getSend()
          stats.sends.push({ content, step: sendStep })
          await new Promise((resolve) => setTimeout(resolve, sendStep.delayMs ?? 15))
          for (const chunk of sendStep.streamChunks ?? []) events.onEvent({ ts: Date.now(), kind: 'text', text: chunk })
          if (sendStep.emitFinal !== false) events.onEvent({ ts: Date.now(), kind: 'final', text: sendStep.response ?? '' })
          events.onTurnEnd({
            response: sendStep.response ?? '',
            delegationText: sendStep.delegationText,
            ok: sendStep.ok !== false,
            ...(sendStep.error ? { error: sendStep.error } : {})
          })
        },
        async stop() { stats.stops++ },
        async close() { stats.closes++ }
      }

      setTimeout(() => {
        for (const chunk of step.streamChunks ?? []) events.onEvent({ ts: Date.now(), kind: 'text', text: chunk })
        if (step.emitFinal !== false) events.onEvent({ ts: Date.now(), kind: 'final', text: step.response ?? '' })
        events.onTurnEnd({
          response: step.response ?? '',
          delegationText: step.delegationText,
          ok: step.ok !== false,
          ...(step.error ? { error: step.error } : {})
        })
      }, step.delayMs ?? 20)
      return Promise.resolve(session)
    }
  }
  backend.stats = stats
  return backend
}

// workerBackend needs to write before its final event. Keep that behavior in
// a small wrapper so the regular scripted backend remains useful for leaders.
function writingWorkerBackend(id, fileName, content, delayMs = 25) {
  const backend = {
    id,
    label: id,
    async probe() { return { ok: true, detail: '' } },
    start({ workdir, events }) {
      const session = { sessionId: `${id}-session-${Math.random().toString(36).slice(2, 7)}`, async send() {}, async stop() {}, async close() {} }
      setTimeout(() => {
        fs.writeFileSync(path.join(workdir, fileName), content)
        events.onEvent({ ts: Date.now(), kind: 'final', text: `worker ${id} complete` })
        events.onTurnEnd({ response: `worker ${id} complete`, ok: true })
      }, delayMs)
      return Promise.resolve(session)
    }
  }
  return backend
}

function makeHarness({ team, backends, concurrency = 1, workerConcurrency = 2 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-matrix-scene-'))
  const repo = initRepo(dir)
  const data = path.join(dir, 'data')
  const store = new TaskStore(data)
  const issueStore = new IssueStore(data)
  const goalStore = new GoalStore(data)
  const taskService = new TaskService({
    store,
    issueStore,
    getAgent: (agentId) => team.find((agent) => agent.id === agentId)
  })
  const taskEvents = []
  const taskUpdates = []
  const reviewEvents = []
  const finalizedIssues = []
  let controller

  const sync = (task) => {
    issueStore.sync(store.list())
    controller?.onTaskChanged(task)
  }
  const runner = new TaskRunner(
    store,
    new Map(backends.map((backend) => [backend.id, backend])),
    () => ({ concurrency, workerConcurrency, mode: 'yolo', notify: false }),
    sync,
    {
      send: (channel, payload) => {
        if (channel === 'task:event') taskEvents.push(payload)
        if (channel === 'task:updated') taskUpdates.push(payload)
      }
    }
  )
  runner.attachTeam(() => team)
  runner.attachTaskCreator(taskService)
  runner.attachIssueOps({
    reviewStatus: (childId, verdict, note) => {
      reviewEvents.push({ childId, verdict, note })
      const child = store.get(childId)
      const childIssue = issueStore.get(child?.issueId ?? `iss_${childId}`)
      if (childIssue) issueStore.updateWorkflow(childIssue.id, verdict === 'pass' ? 'done' : 'blocked')
    }
  })

  const createTask = (input, trigger = 'assignment') => taskService.createTask(input, trigger)

  runner.attachContinue(({ sourceTaskId, issueId, brief, start }) => {
    const source = store.get(sourceTaskId)
    if (!source) return null
    const task = taskService.createHandoffTask({ sourceTaskId, issueId, brief, start })
    if (task && start !== 'parked' && task.status === 'queued') runner.enqueue(task)
    return task
  })

  controller = new GoalController(goalStore, {
    createTask: (input) => createTask({
      title: input.title,
      prompt: input.prompt,
      workdir: input.workdir,
      backend: input.backend,
      agentId: input.agentId,
      issueId: input.issueId,
      goalId: input.goalId,
      phaseIndex: input.phaseIndex,
      startNow: input.startNow
    }, input.trigger),
    enqueueTask: (task) => runner.enqueue(task),
    startTask: (task) => { store.update(task.id, { parked: undefined }); return store.get(task.id) },
    cancelTask: (taskId) => runner.cancel(taskId),
    listTasks: () => store.list(),
    continueTask: (taskId, content) => runner.followUp(taskId, content),
    finalizeIssue: (issueId) => {
      finalizedIssues.push(issueId)
      issueStore.updateWorkflow(issueId, 'done')
    }
  })

  return {
    dir,
    repo,
    store,
    issueStore,
    goalStore,
    taskService,
    controller,
    runner,
    taskEvents,
    taskUpdates,
    reviewEvents,
    finalizedIssues,
    createTask,
    cleanup: async () => {
      await runner.shutdown()
      store.flush()
      await wait(20)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

let failed = 0
function check(label, condition, detail = '') {
  const suffix = condition || !detail ? '' : ` (got ${detail})`
  console.log(`  ${condition ? 'OK' : 'FAIL'} ${label}${suffix}`)
  if (!condition) failed++
}

async function scenarioGoalDelegate() {
  console.log('\n[1] Goal x delegate: child completion, review, and Goal continuation')
  const tag = '<delegate to="Worker" reason="parallel file change">update worker.txt</delegate>'
  const leader = scriptedBackend('leader', {
    starts: [{ response: 'delegation started', delegationText: tag, streamChunks: [tag] }],
    sends: [
      { response: '<review of="#1" verdict="pass" note="worker verified"/>\n{"summary":"worker reviewed","completedConditions":[],"incompleteConditions":["release ready"],"nextPlan":"run final verification","blockers":[]}' },
      { response: '{"summary":"release ready","completedConditions":["release ready"],"incompleteConditions":[],"nextPlan":"","blockers":[]}' }
    ]
  })
  const worker = writingWorkerBackend('worker', 'worker.txt', 'worker change\n')
  const team = [
    { id: 'leader-agent', name: 'Leader', backend: 'leader', role: 'leader', systemPrompt: '', subordinates: ['worker-agent'] },
    { id: 'worker-agent', name: 'Worker', backend: 'worker', role: 'worker', systemPrompt: '' }
  ]
  const h = makeHarness({ team, backends: [leader, worker], concurrency: 1, workerConcurrency: 2 })
  try {
    const goal = h.controller.create({
      text: 'Ship delegated change', issueId: 'iss_matrix_delegate', completionConditions: ['release ready'], stopConditions: [],
      maxRuns: 3, maxDurationMs: 60_000, workdir: h.repo, agentId: 'leader-agent', backend: 'leader', startNow: true
    })
    const parent = await waitFor(() => h.store.list().find((task) => task.goalId === goal.id))
    const child = await waitFor(() => h.store.list().find((task) => task.parentTaskId === parent?.id))
    const doneChild = child ? await waitForTerminal(h.store, child.id) : null
    await waitFor(() => h.controller.get(goal.id)?.status === 'completed')
    const finalParent = h.store.get(parent?.id)
    const issue = h.issueStore.get(goal.issueId)
    const goalRuns = h.controller.runs(goal.id)
    check('leader reaches done after delegated Goal continuation', finalParent?.status === 'done', finalParent?.status)
    check('one delegated child reaches done', !!doneChild && doneChild.status === 'done', doneChild?.status)
    check('child review is applied as pass', h.reviewEvents.some((event) => event.childId === child?.id && event.verdict === 'pass'))
    check('child Issue projection records review completion', child ? h.issueStore.get(child.issueId ?? `iss_${child.id}`)?.status === 'done' : false)
    check('Goal completes and emits a checkpoint', h.controller.get(goal.id)?.status === 'completed' && h.controller.checkpoints(goal.id).length >= 1)
    check('Goal continuation creates a second run without changing issue ownership', goalRuns.length >= 2 && goalRuns.every((run) => run.issueId === goal.issueId && run.goalId === goal.id))
    check('Issue is finalized after Goal completion', issue?.status === 'done' && h.finalizedIssues.includes(goal.issueId), issue?.status)
    const integrated = finalParent?.integration?.branch
      ? (() => {
        try { return execFileSync('git', ['show', `${finalParent.integration.branch}:worker.txt`], { cwd: h.repo, encoding: 'utf8' }) } catch { return '' }
      })()
      : ''
    check('integration branch contains worker diff', !!finalParent?.integration?.branch && integrated.includes('worker change'))
    check('merged worker worktree is reclaimed', child?.workdir ? !fs.existsSync(child.workdir) : false)
    check('parent event log records orchestration state', h.store.readEvents(parent.id).some((event) => event.kind === 'status'))
  } finally {
    await h.cleanup()
  }
}

async function scenarioRetryGoal() {
  console.log('\n[2] retry x Goal: provider retry is bounded and not double-counted')
  const flaky = scriptedBackend('flaky', {
    starts: [
      { fail: 'Error: 429 Too Many Requests', sessionId: 'retry-session', delayMs: 20 },
      { response: '{"summary":"release ready","completedConditions":["release ready"],"incompleteConditions":[],"nextPlan":"","blockers":[]}' }
    ],
    sends: []
  })
  const team = [{ id: 'retry-agent', name: 'Retry agent', backend: 'flaky', role: 'worker', systemPrompt: '' }]
  const h = makeHarness({ team, backends: [flaky] })
  try {
    const goal = h.controller.create({
      text: 'Retry release', issueId: 'iss_matrix_retry', completionConditions: ['release ready'], stopConditions: [],
      maxRuns: 3, maxDurationMs: 60_000, workdir: h.repo, agentId: 'retry-agent', backend: 'flaky', startNow: true
    })
    await waitFor(() => h.controller.get(goal.id)?.status === 'completed', 20_000)
    const task = h.store.list().find((item) => item.goalId === goal.id)
    const retryEvents = task ? h.store.readEvents(task.id).filter((event) => event.kind === 'status' && /自动重试|auto.?retry/i.test(event.text ?? '')) : []
    const runs = h.controller.runs(goal.id)
    check('Goal completes after one transient retry', h.controller.get(goal.id)?.status === 'completed')
    check('runner performs exactly two starts', flaky.stats.starts.length === 2, String(flaky.stats.starts.length))
    check('retry resumes the preserved provider session', flaky.stats.starts[1]?.resumeSessionId === 'retry-session')
    check('attempt is exactly one and no Goal failure is accumulated', task?.attempt === 1 && !h.controller.get(goal.id)?.failures)
    check('one retry event is recorded', retryEvents.length === 1, String(retryEvents.length))
    check('failed and successful executions stay in one Goal/Issue history', runs.length >= 2 && runs.every((run) => run.goalId === goal.id && run.issueId === goal.issueId))
    check('retry path leaves one durable checkpoint', h.controller.checkpoints(goal.id).length === 1)
  } finally {
    await h.cleanup()
  }
}

async function scenarioContinueGoal() {
  console.log('\n[3] continue handoff x Goal: same Issue and Goal own the next phase')
  const sourceResponse = 'phase one complete; the next stage is prepared\n<continue start="auto">Phase 2: verify the release\nPlan: docs/plan.md\nAcceptance: release verification</continue>'
  const handoffResponse = '{"summary":"phase two complete","completedConditions":["phase one complete","phase two complete"],"incompleteConditions":[],"nextPlan":"","blockers":[]}'
  const leader = scriptedBackend('handoff-agent', { starts: [{ response: sourceResponse }, { response: handoffResponse }], sends: [] })
  const team = [{ id: 'handoff-agent-id', name: 'Handoff agent', backend: 'handoff-agent', role: 'worker', systemPrompt: '' }]
  // Exercise the production attachContinue path through the unified task
  // service. The handoff must retain Issue/source links and Goal phase data.
  const h = makeHarness({ team, backends: [leader] })
  try {
    const goal = h.controller.create({
      text: 'Two phase release', issueId: 'iss_matrix_handoff', completionConditions: ['phase one complete', 'phase two complete'], stopConditions: [],
      maxRuns: 3, maxDurationMs: 60_000, workdir: h.repo, agentId: 'handoff-agent-id', backend: 'handoff-agent', startNow: true
    })
    const source = await waitFor(() => h.store.list().find((task) => task.goalId === goal.id && !task.continuesFrom))
    const handoff = await waitFor(() => h.store.list().find((task) => task.continuesFrom === source?.id))
    const doneHandoff = handoff ? await waitForTerminal(h.store, handoff.id) : null
    await waitFor(() => h.controller.get(goal.id)?.status === 'completed')
    const issueRuns = h.issueStore.runs(goal.issueId)
    const goalRuns = h.controller.runs(goal.id)
    const replay = h.taskService.createHandoffTask({ sourceTaskId: source.id, issueId: goal.issueId, brief: sourceResponse.match(/<continue[\s\S]*?>([\s\S]*?)<\/continue>/i)?.[1] ?? '', start: 'auto' })
    check('handoff task completes', doneHandoff?.status === 'done', doneHandoff?.status)
    check('handoff keeps Issue/source links and Goal phase metadata', handoff?.issueId === goal.issueId && handoff.goalId === goal.id && handoff.phaseIndex === (source?.phaseIndex ?? 0) + 1 && handoff.continuesFrom === source?.id)
    check('handoff is explicitly marked as a handoff run', handoff?.trigger === 'handoff')
    check('Issue projection has both phase executions', issueRuns.some((run) => run.taskId === source?.id) && issueRuns.some((run) => run.taskId === handoff?.id))
    check('Goal projection adopts the handoff run', goalRuns.some((run) => run.taskId === handoff?.id) && goalRuns.some((run) => run.taskId === source?.id))
    check('Goal completes from the linked handoff snapshot', h.controller.get(goal.id)?.status === 'completed')
    check('continue marker is stripped from the source result', !h.store.get(source.id).result.includes('<continue'))
    check('Goal completion remains durable after handoff replay', h.controller.get(goal.id)?.status === 'completed')
    check('replaying the same handoff request reuses one Task/Run', replay?.id === handoff.id && h.issueStore.runs(goal.issueId).filter((run) => run.taskId === handoff.id).length === 1)
  } finally {
    await h.cleanup()
  }
}

async function scenarioCancelEarlyDispatch() {
  console.log('\n[4] cancel x early delegate: cancellation wins over late stream events')
  const tag = '<delegate to="Worker" reason="cancel test">prepare cancel.txt</delegate>'
  const leader = scriptedBackend('cancel-leader', {
    starts: [{ response: 'late leader result', streamChunks: [tag], delayMs: 1_000 }],
    sends: []
  })
  const worker = writingWorkerBackend('cancel-worker', 'cancel.txt', 'late worker write\n', 1_200)
  const team = [
    { id: 'cancel-leader-id', name: 'Cancel leader', backend: 'cancel-leader', role: 'leader', systemPrompt: '', subordinates: ['cancel-worker-id'] },
    { id: 'cancel-worker-id', name: 'Worker', backend: 'cancel-worker', role: 'worker', systemPrompt: '' }
  ]
  const h = makeHarness({ team, backends: [leader, worker], concurrency: 1, workerConcurrency: 2 })
  try {
    const goal = h.controller.create({
      text: 'Cancel delegated run', issueId: 'iss_matrix_cancel', completionConditions: ['never'], stopConditions: [],
      maxRuns: 3, maxDurationMs: 60_000, workdir: h.repo, agentId: 'cancel-leader-id', backend: 'cancel-leader', startNow: true
    })
    const parent = await waitFor(() => h.store.list().find((task) => task.goalId === goal.id))
    const child = await waitFor(() => h.store.list().find((task) => task.parentTaskId === parent?.id), 10_000)
    check('streaming delegate creates an early child before cancellation', !!child)
    check('leader is still running before cancellation', h.store.get(parent.id)?.status === 'running', h.store.get(parent.id)?.status)
    const cancelResult = h.controller.cancel(goal.id)
    check('Goal cancellation is accepted while leader is running', cancelResult.ok)
    await waitFor(() => h.store.get(parent.id)?.status === 'cancelled')
    await waitFor(() => child && h.store.get(child.id)?.status === 'cancelled')
    const finalCountAtCancel = h.store.readEvents(parent.id).filter((event) => event.kind === 'final').length
    await wait(1_350)
    const parentEvents = h.store.readEvents(parent.id)
    check('leader remains cancelled after late final event', h.store.get(parent.id)?.status === 'cancelled')
    check('early child remains cancelled after its late completion', child ? h.store.get(child.id)?.status === 'cancelled' : false)
    check('cancelled Goal is not resurrected by task callbacks', h.controller.get(goal.id)?.status === 'cancelled')
    check('late leader final event is rejected by the event gate', parentEvents.filter((event) => event.kind === 'final').length === finalCountAtCancel)
    check('no duplicate child appears after cancellation', h.store.list().filter((task) => task.parentTaskId === parent.id).length === 1)
    await h.runner.shutdown()
    check('shutdown releases all in-memory sessions', h.runner.sessionCount() === 0)
  } finally {
    // cleanup is idempotent enough for the explicit shutdown above.
    await h.cleanup()
  }
}

async function scenarioDuplicateDelegate() {
  console.log('\n[5] duplicate delegate: stream, replay, and evaluation text create one child')
  const tag = '<delegate to="Worker" reason="single logical request">update duplicate.txt</delegate>'
  const leader = scriptedBackend('duplicate-leader', {
    starts: [{ response: `${tag}\nleader waiting`, delegationText: `${tag}\n${tag}`, streamChunks: [tag] }],
    sends: [{ response: `${tag}\n<review of="#1" verdict="pass" note="same request"/>\n${tag}\nleader complete`, delegationText: `${tag}\n${tag}` }]
  })
  const worker = writingWorkerBackend('duplicate-worker', 'duplicate.txt', 'one child only\n')
  const team = [
    { id: 'duplicate-leader-id', name: 'Duplicate leader', backend: 'duplicate-leader', role: 'leader', systemPrompt: '', subordinates: ['duplicate-worker-id'] },
    { id: 'duplicate-worker-id', name: 'Worker', backend: 'duplicate-worker', role: 'worker', systemPrompt: '' }
  ]
  const h = makeHarness({ team, backends: [leader, worker], concurrency: 1, workerConcurrency: 2 })
  try {
    const task = h.createTask({ title: 'Duplicate delegate parent', prompt: 'run duplicate delegate matrix', workdir: h.repo, backend: 'duplicate-leader', agentId: 'duplicate-leader-id', issueId: 'iss_matrix_duplicate' })
    h.runner.enqueue(task)
    await waitForTerminal(h.store, task.id)
    const children = h.store.list().filter((item) => item.parentTaskId === task.id)
    const child = children[0]
    if (child) await waitForTerminal(h.store, child.id)
    const parentEvents = h.store.readEvents(task.id)
    check('parent completes after duplicate replay/evaluation text', h.store.get(task.id)?.status === 'done')
    check('all duplicate sources produce one child task', children.length === 1, String(children.length))
    check('the one child completes and is integrated', child?.status === 'done' && h.store.get(task.id)?.integration?.branch)
    check('seenKeys leaves one accepted-delegate event', parentEvents.filter((event) => event.kind === 'status' && (event.text ?? '').includes('update duplicate.txt')).length === 1)
    check('repeated delegate markup does not leak into final result', !h.store.get(task.id).result.includes('<delegate'))
    check('duplicate scenario has durable status events', parentEvents.some((event) => event.kind === 'status'))
  } finally {
    await h.cleanup()
  }
}

try {
  await scenarioGoalDelegate()
  await scenarioRetryGoal()
  await scenarioContinueGoal()
  await scenarioCancelEarlyDispatch()
  await scenarioDuplicateDelegate()
} finally {
  fs.rmSync(bundleDir, { recursive: true, force: true })
}

if (failed) {
  console.error(`\nORCHESTRATION MATRIX FAILED (${failed})`)
  process.exit(1)
} else {
  console.log('\nORCHESTRATION MATRIX PASSED (5 scenarios)')
  process.exit(0)
}
