import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-meeting-bundles-'))
const bundle = async (source, name) => {
  const outfile = path.join(bundleDir, name)
  await build({ entryPoints: [path.join(root, source)], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['electron'] })
  return import(pathToFileURL(outfile).href)
}
const [{ MeetingController }, { MeetingStore }, { AgentSessionRegistry }, { TaskStore }, { TaskService }, { TaskRunner }] = await Promise.all([
  bundle('src/main/meeting-controller.ts', 'meeting-controller.cjs'),
  bundle('src/main/meeting-store.ts', 'meeting-store.cjs'),
  bundle('src/main/agent-sessions.ts', 'agent-sessions.cjs'),
  bundle('src/main/store.ts', 'store.cjs'),
  bundle('src/main/task-service.ts', 'task-service.cjs'),
  bundle('src/main/runner.ts', 'runner.cjs')
])

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const check = (condition, label) => {
  console.log(`  ${condition ? 'OK' : 'FAIL'} ${label}`)
  if (!condition) process.exitCode = 1
}

let phaseCalls = []
let synthesisCalls = 0
let mode = 'converged'
const backend = {
  id: 'fake-meeting',
  label: 'Fake meeting',
  async probe() { return { ok: true, detail: 'fake' } },
  async start({ prompt, events }) {
    const agent = prompt.includes('Beta') ? 'beta' : prompt.includes('Gamma') ? 'gamma' : 'alpha'
    const sessionId = `${agent}-session`
    const response = agent === 'alpha'
      ? '<stance verdict="agree" grounds="report ready"/>'
      : agent === 'beta'
        ? mode === 'hard-error' ? null : mode === 'budget'
          ? '<objection ref="src/a.ts:4" priority="high">needs proof</objection>\n<stance verdict="disagree" grounds="not enough"/>'
          : '<stance verdict="agree" grounds="looks good"/>'
        : mode === 'budget'
          ? '{"decisions":["hold"],"objections":[{"text":"needs proof","ref":"src/a.ts:4","resolved":false}],"actionItems":[],"openQuestions":["prove it"]}\n<stance verdict="agree" grounds="partial"/>'
          : '{"decisions":["ship"],"objections":[],"actionItems":[{"title":"run release checks","owner":"Alpha","acceptance":["checks pass"]}],"openQuestions":[]}\n<stance verdict="agree" grounds="accepted"/>'
    phaseCalls.push({ agent, prompt })
    setTimeout(() => {
      if (response === null) {
        events.onTurnEnd({ ok: false, response: '', error: 'provider hard error' })
        return
      }
      events.onEvent({ ts: Date.now(), kind: 'final', text: response })
      events.onTurnEnd({ ok: true, response })
    }, 5)
    const emit = (content) => {
      const responseFor = (value) => {
        if (agent === 'alpha') return '<stance verdict="agree" grounds="report ready"/>'
        if (agent === 'beta') return mode === 'hard-error' ? null : mode === 'budget'
          ? '<objection ref="src/a.ts:4" priority="high">needs proof</objection>\n<stance verdict="disagree" grounds="not enough"/>'
          : '<stance verdict="agree" grounds="looks good"/>'
        return mode === 'budget'
          ? '{"decisions":["hold"],"objections":[{"text":"needs proof","ref":"src/a.ts:4","resolved":false}],"actionItems":[],"openQuestions":["prove it"]}\n<stance verdict="agree" grounds="partial"/>'
          : '{"decisions":["ship"],"objections":[],"actionItems":[{"title":"run release checks","owner":"Alpha","acceptance":["checks pass"]}],"openQuestions":[]}\n<stance verdict="agree" grounds="accepted"/>'
      }
      const response = responseFor(content)
      if (response === null) return events.onTurnEnd({ ok: false, response: '', error: 'provider hard error' })
      events.onEvent({ ts: Date.now(), kind: 'final', text: response })
      events.onTurnEnd({ ok: true, response })
    }
    return {
      sessionId,
      async send(content) { if (content.includes('强制综合')) synthesisCalls++; phaseCalls.push({ agent, prompt: content }); await sleep(3); emit(content) },
      async stop() {},
      async close() {}
    }
  }
}

async function makeFixture() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-meeting-data-'))
  const taskStore = new TaskStore(data)
  const taskService = new TaskService({ store: taskStore })
  const runner = new TaskRunner(taskStore, new Map([[backend.id, backend]]), () => ({ concurrency: 3, workerConcurrency: 3, mode: 'yolo', notify: false }))
  const agents = [
    { id: 'alpha', name: 'Alpha', backend: backend.id, role: '队长' },
    { id: 'beta', name: 'Beta', backend: backend.id, role: '队长', subordinates: ['gamma'] },
    { id: 'gamma', name: 'Gamma', backend: backend.id, role: '队长' }
  ]
  runner.attachTeam(() => agents)
  const offices = new AgentSessionRegistry({ store: taskStore, taskService, runner, getAgents: () => agents, waitPollMs: 5, waitTimeoutMs: 2_000 })
  const meetingStore = new MeetingStore(data)
  const controller = new MeetingController({ store: meetingStore, offices, getAgents: () => agents, taskService, startTask: (taskId) => { const task = taskStore.get(taskId); if (task?.status === 'queued') taskStore.update(taskId, { parked: undefined }) }, issueExists: () => true, now: Date.now })
  return { data, taskStore, taskService, runner, offices, controller, meetingStore, agents }
}

const fixture = await makeFixture()
const meeting = fixture.controller.create({ issueId: 'iss_1', topic: 'release decision', participants: [
  { agentId: 'alpha', role: 'reporter' }, { agentId: 'beta', role: 'critic' }, { agentId: 'gamma', role: 'designer' }
], maxRounds: 1 })
const result = await fixture.controller.start(meeting.id)
check(result.ok && result.meeting?.status === 'concluded', 'all explicit agree + valid envelope concludes meeting')
check(result.meeting?.stopReason === 'converged', 'concluded meeting records converged stopReason')
check(result.meeting?.minutes.length === 1, 'concluded meeting persists one round minutes')
check(fixture.meetingStore.turns(meeting.id).length === 3, 'meeting persists one turn per participant')
const action = result.meeting?.minutes.at(-1)?.actionItems[0]
const actionTask = action?.taskId ? fixture.taskStore.get(action.taskId) : undefined
check(actionTask?.parked === true && actionTask.status === 'queued', 'conclusion materializes parked action task')
const approved = fixture.controller.approveAction(meeting.id, 0, 'approved')
const approvedTask = action?.taskId ? fixture.taskStore.get(action.taskId) : undefined
check(approved.ok && approvedTask?.parked !== true, 'approval releases action task from parked gate')

mode = 'budget'
const budgetMeeting = fixture.controller.create({ issueId: 'iss_2', topic: 'blocked decision', participants: [
  { agentId: 'alpha', role: 'reporter' }, { agentId: 'beta', role: 'critic' }, { agentId: 'gamma', role: 'designer' }
], maxRounds: 1 })
const budgetResult = await fixture.controller.start(budgetMeeting.id)
check(budgetResult.ok && budgetResult.meeting?.status === 'waiting_user', 'budget exhaustion waits for user after synthesis')
check(budgetResult.meeting?.stopReason === 'budget', 'budget stopReason is distinct from converged')
check(budgetResult.meeting?.minutes.at(-1)?.objections.some((objection) => !objection.resolved), 'forced synthesis keeps unresolved objections explicit')
check(synthesisCalls >= 1, 'budget path runs a real synthesis turn before waiting')

mode = 'hard-error'
const failedMeeting = fixture.controller.create({ issueId: 'iss_3', topic: 'provider failure', participants: [
  { agentId: 'alpha', role: 'reporter' }, { agentId: 'beta', role: 'critic' }, { agentId: 'gamma', role: 'designer' }
], maxRounds: 1 })
const failedResult = await fixture.controller.start(failedMeeting.id)
check(!failedResult.ok && failedResult.meeting?.status === 'failed', 'hard participant error fails meeting immediately')

const recoverStore = new MeetingStore(fixture.data)
const recoverController = new MeetingController({ store: recoverStore, offices: fixture.offices, getAgents: () => fixture.agents })
recoverStore.update(meeting.id, { status: 'active' })
const recovered = recoverController.recover()
check(recovered.some((item) => item.id === meeting.id && item.status === 'waiting_user'), 'active meeting recovers to waiting_user')

check(phaseCalls.some((call) => call.prompt.includes('汇报轮') && call.prompt.includes('<investigate')), 'report prompt teaches <investigate>')
check(phaseCalls.some((call) => call.prompt.includes('质疑轮') && call.prompt.includes('<investigate')), 'challenge prompt teaches <investigate>')

await fixture.runner.shutdown()
if (process.exitCode) process.exit(1)
console.log('\n✅ MEETING SMOKE PASSED')
