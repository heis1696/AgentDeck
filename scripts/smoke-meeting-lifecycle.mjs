import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-meeting-lifecycle-'))
const bundle = async (source, name) => {
  const outfile = path.join(temporary, `${name}.cjs`)
  await build({ entryPoints: [path.join(root, source)], outfile, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
  return import(pathToFileURL(outfile).href)
}
const [{ MeetingController }, { MeetingStore }, { TaskStore }, { TaskService }, { IssueStore }] = await Promise.all([
  bundle('src/main/meeting-controller.ts', 'controller'), bundle('src/main/meeting-store.ts', 'meetings'),
  bundle('src/main/store.ts', 'tasks'), bundle('src/main/task-service.ts', 'service'), bundle('src/main/issue-store.ts', 'issues')
])
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
const check = (condition, label) => {
  console.log(`  ${condition ? 'OK' : 'FAIL'} ${label}`)
  if (!condition) process.exitCode = 1
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return
    await sleep(5)
  }
  throw new Error('fixture deadline exceeded')
}
const fixtures = []

function fixture(ownsIssue = true) {
  const directory = fs.mkdtempSync(path.join(temporary, 'data-'))
  const tasks = new TaskStore(directory)
  const issues = new IssueStore(directory)
  const service = new TaskService({ store: tasks, issueStore: issues })
  const container = service.createTask({ title: 'meeting', prompt: 'discuss', workdir: directory, startNow: false })
  issues.sync(tasks.list())
  const issue = issues.get(container.issueId)
  const state = { directory, tasks, issues, service, container, issue, sends: [], stopped: [], deleted: [], failStop: false, stopGate: null, failAfterTasks: false, pending: new Map() }
  const agents = ['alpha', 'beta', 'gamma'].map((id) => ({ id, name: id, backend: 'fake', role: '队长' }))
  const offices = {
    get(agentId, meetingId) { return tasks.list().find((task) => task.officeAgentId === agentId && task.meetingId === meetingId) ?? null },
    async followUp(agentId, content, options) {
      const member = offices.get(agentId, options.meetingId) ?? service.createTask({
        title: `${agentId} member`, prompt: 'office', workdir: options.workdir,
        agentId, officeAgentId: agentId, suppressIssue: true, meetingId: options.meetingId, meetingTaskRole: 'member'
      })
      tasks.update(member.id, { status: 'running' })
      const pending = deferred()
      state.pending.set(member.id, pending)
      state.sends.push({ agentId, content, options, taskId: member.id })
      return pending.promise
    }
  }
  const options = {
    offices, getAgents: () => agents, taskService: service, taskStore: tasks, stopTimeoutMs: 100,
    issueExists: (id) => !!issues.get(id), getIssueTask: () => tasks.get(container.id), isFreshIssue: () => ownsIssue,
    addIssueComment: (id, content, authorId, meetingId) => issues.addComment(id, content, { type: 'agent', id: authorId }, { meetingId }),
    async cancelTask(taskId) {
      state.stopped.push(taskId)
      if (state.failStop) return { ok: false, error: 'provider exit unconfirmed' }
      if (state.stopGate) await state.stopGate.promise
      const task = tasks.get(taskId)
      if (task && ['queued', 'running'].includes(task.status)) tasks.update(taskId, { status: 'cancelled' })
      state.pending.get(taskId)?.resolve({ ok: true, finalText: 'late public response\n<stance verdict="agree" grounds="old"/>', taskId })
      return { ok: true }
    },
    async deleteTaskData(meeting, owned) {
      const deleted = await service.deleteTerminalCascade(owned.map((task) => task.id), () => {}, (current) => current.every((task) => task.meetingId === meeting.id))
      if (!deleted) return { ok: false, error: 'ownership changed' }
      state.deleted.push(...deleted)
      if (state.failAfterTasks) { state.failAfterTasks = false; throw new Error('crash after task deletion') }
      return { ok: true }
    },
    deleteMeetingComments: (meetingId) => issues.deleteMeetingComments(meetingId),
    deleteIssue: (id) => issues.deleteIssue(id)
  }
  state.store = new MeetingStore(directory)
  state.controller = new MeetingController({ ...options, store: state.store })
  state.recover = () => {
    state.store = new MeetingStore(directory)
    state.controller = new MeetingController({ ...options, store: state.store })
    state.controller.recover()
  }
  state.meeting = state.controller.create({ issueId: issue.id, topic: 'lifecycle', participants: [
    { agentId: 'alpha', role: 'reporter' }, { agentId: 'beta', role: 'critic' }, { agentId: 'gamma', role: 'designer' }
  ] })
  fixtures.push(state)
  return state
}

try {
  const stopped = fixture()
  const ordinary = stopped.service.createTask({ title: 'ordinary assignment', prompt: 'work', issueId: stopped.issue.id })
  check(stopped.tasks.get(stopped.container.id).meetingTaskRole === 'container', 'fresh issue is a meeting-owned container')
  check(!stopped.controller.canRunTask(ordinary) && !stopped.controller.canRunTask(stopped.tasks.get(stopped.container.id)), 'ordinary assignment and container cannot execute on the meeting issue')
  const running = stopped.controller.start(stopped.meeting.id)
  await waitFor(() => stopped.sends.length === 1)
  const duplicate = await stopped.controller.start(stopped.meeting.id)
  check(duplicate.ok && stopped.sends.length === 1, 'duplicate start does not send twice')
  const member = stopped.tasks.get(stopped.sends[0].taskId)
  const child = stopped.service.createChildTask({ parentTaskId: member.id, title: 'investigation', prompt: 'read', backend: 'fake' })
  check(child.meetingId === stopped.meeting.id && child.meetingTaskRole === 'investigation' && child.suppressIssue, 'investigation inherits trusted meeting ownership and remains internal')
  check(!member.parentTaskId && stopped.sends[0].options.workdir === stopped.directory, 'member parentage stays independent and workdir comes from the meeting')
  stopped.stopGate = deferred()
  const stopping = stopped.controller.cancel(stopped.meeting.id)
  check(stopped.controller.get(stopped.meeting.id).stopState === 'stopping', 'stop intent is persisted synchronously before provider awaits')
  check(!stopped.controller.canRunTask(member) && !stopped.controller.canRunTask(child), 'stop intent immediately fences new member and investigation execution')
  stopped.stopGate.resolve()
  const outcome = await stopping
  await running
  check(outcome.ok && stopped.sends.length === 1, 'stop drains the run without scheduling the next speaker')
  check(stopped.issues.comments(stopped.issue.id).length === 0, 'late public response cannot publish a comment')
  check(stopped.controller.get(stopped.meeting.id).currentTurn === undefined, 'stopped meeting clears its active speaker')
  check((await stopped.controller.cancel(stopped.meeting.id)).ok, 'repeated stop is idempotent')

  const failed = fixture()
  const pendingRun = failed.controller.start(failed.meeting.id)
  await waitFor(() => failed.sends.length === 1)
  failed.failStop = true
  const failedDeletion = await failed.controller.delete(failed.meeting.id)
  check(!failedDeletion.ok && failed.controller.get(failed.meeting.id).stopState === 'failed', 'unconfirmed provider exit is a visible stop failure')
  check(failed.tasks.get(failed.container.id) && failed.tasks.get(failed.sends[0].taskId) && failed.issues.get(failed.issue.id), 'failed termination retains task and issue evidence')
  check(failed.deleted.length === 0, 'deletion never runs before confirmed termination')
  failed.failStop = false
  check((await failed.controller.delete(failed.meeting.id)).ok, 'failed deletion can retry after provider exit is confirmed')
  await pendingRun
  check(!failed.issues.get(failed.issue.id) && !failed.tasks.get(failed.container.id) && !failed.controller.get(failed.meeting.id), 'successful delete removes owned issue, container and meeting')
  check((await failed.controller.delete(failed.meeting.id)).ok, 'repeated deletion is idempotent')
  failed.issues.sync(failed.tasks.list())
  check(!failed.issues.get(failed.issue.id), 'issue tombstone prevents projection resurrection')

  const isolated = fixture(false)
  const consultation = isolated.service.createTask({ title: 'consult', prompt: 'office', officeAgentId: 'alpha', suppressIssue: true })
  isolated.tasks.update(consultation.id, { status: 'done', result: 'consultation history' })
  const foreign = isolated.service.createTask({ title: 'another meeting', prompt: 'office', meetingId: 'other', meetingTaskRole: 'member', suppressIssue: true })
  isolated.tasks.update(foreign.id, { status: 'done', result: 'other history' })
  isolated.issues.addComment(isolated.issue.id, 'unrelated existing history')
  isolated.issues.addComment(isolated.issue.id, 'meeting mirror', { type: 'agent', id: 'alpha' }, { meetingId: isolated.meeting.id })
  const isolatedRun = isolated.controller.start(isolated.meeting.id)
  await waitFor(() => isolated.sends.length === 1)
  check((await isolated.controller.delete(isolated.meeting.id)).ok, 'attached meeting deletes its own internal records')
  await isolatedRun
  check(isolated.issues.get(isolated.issue.id) && isolated.tasks.get(isolated.container.id), 'attached issue and ordinary task history are retained')
  check(isolated.issues.comments(isolated.issue.id).map((comment) => comment.content).join() === 'unrelated existing history', 'only comments with trusted meeting provenance are removed')
  check(isolated.tasks.get(consultation.id).result === 'consultation history' && !isolated.stopped.includes(consultation.id), 'consultation office is neither stopped nor deleted')
  check(isolated.tasks.get(foreign.id).result === 'other history' && !isolated.stopped.includes(foreign.id), 'another meeting remains untouched')

  const interrupted = fixture()
  const interruptedRun = interrupted.controller.start(interrupted.meeting.id)
  await waitFor(() => interrupted.sends.length === 1)
  interrupted.failAfterTasks = true
  const interruptedDelete = await interrupted.controller.delete(interrupted.meeting.id)
  await interruptedRun
  check(!interruptedDelete.ok && interrupted.controller.get(interrupted.meeting.id).deleting, 'partial deletion retains a durable recovery marker')
  check(!interrupted.tasks.get(interrupted.container.id) && interrupted.issues.get(interrupted.issue.id), 'partial deletion fixture reproduces the missing-container issue')
  interrupted.recover()
  await waitFor(() => !interrupted.controller.get(interrupted.meeting.id))
  check(!interrupted.issues.get(interrupted.issue.id), 'restart continues deletion without restoring a container task')
  check(interrupted.sends.length === 1, 'deletion recovery never starts a replacement execution')

  if (process.exitCode) throw new Error('meeting lifecycle regression failed')
  console.log('PASS meeting lifecycle: ownership, early fencing, late results, isolation, failure retry and deletion recovery')
} finally {
  for (const state of fixtures) { state.issues.close(); state.tasks.flush() }
  const cleanupPath = path.resolve(temporary)
  if (path.dirname(cleanupPath) !== path.resolve(os.tmpdir()) || !path.basename(cleanupPath).startsWith('agentdeck-meeting-lifecycle-')) throw new Error('unsafe temporary cleanup path')
  fs.rmSync(cleanupPath, { recursive: true, force: true })
}
