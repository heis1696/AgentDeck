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
const [{ MeetingController, stripMeetingTags }, { MeetingStore }, { AgentSessionRegistry }, { TaskStore }, { TaskService }, { TaskRunner }] = await Promise.all([
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
  async start({ prompt, events, turn }) {
    let activeTurn = turn
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
        events.onTurnEnd({ ok: false, response: '', error: 'provider hard error' }, activeTurn)
        return
      }
      events.onEvent({ ts: Date.now(), kind: 'final', text: response }, activeTurn)
      events.onTurnEnd({ ok: true, response }, activeTurn)
    }, 5)
    const emit = (content) => {
      const responseFor = (value) => {
        if (agent === 'alpha') {
          if (value.includes('答辩轮')) {
            return mode === 'budget'
              ? '{"decisions":[],"objections":[{"text":"needs proof","ref":"src/a.ts:4","resolved":false}],"actionItems":[],"openQuestions":["evidence pending"]}\n<stance verdict="disagree" grounds="cannot verify"/>'
              : '{"decisions":["adjust"],"objections":[{"text":"needs proof","ref":"src/a.ts:4","resolved":true,"resolution":"verified"}],"actionItems":[],"openQuestions":[]}\n<stance verdict="agree" grounds="addressed"/>'
          }
          return '<stance verdict="agree" grounds="report ready"/>'
        }
        if (agent === 'beta') {
          return mode === 'hard-error' ? null : mode === 'budget'
            ? '<objection ref="src/a.ts:4" priority="high">needs proof</objection>\n<stance verdict="disagree" grounds="not enough"/>'
            : '<stance verdict="agree" grounds="looks good"/>'
        }
        if (value.includes('综合轮')) {
          return '{"decisions":["ship"],"objections":[],"actionItems":[{"title":"run release checks","owner":"Alpha","acceptance":["checks pass"]}],"openQuestions":[]}\n<stance verdict="agree" grounds="accepted"/>'
        }
        return mode === 'budget'
          ? '{"decisions":["hold"],"objections":[{"text":"needs proof","ref":"src/a.ts:4","resolved":false}],"actionItems":[],"openQuestions":["prove it"]}\n<stance verdict="agree" grounds="partial"/>'
          : '{"decisions":["ship"],"objections":[],"actionItems":[{"title":"run release checks","owner":"Alpha","acceptance":["checks pass"]}],"openQuestions":[]}\n<stance verdict="agree" grounds="accepted"/>'
      }
      const response = responseFor(content)
      if (response === null) return events.onTurnEnd({ ok: false, response: '', error: 'provider hard error' }, activeTurn)
      events.onEvent({ ts: Date.now(), kind: 'final', text: response }, activeTurn)
      events.onTurnEnd({ ok: true, response }, activeTurn)
    }
    return {
      sessionId,
      turnScoped: true,
      async send(content, nextTurn) { activeTurn = nextTurn; if (content.includes('强制综合')) synthesisCalls++; phaseCalls.push({ agent, prompt: content }); await sleep(3); emit(content) },
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
  const mirrored = []
  const controller = new MeetingController({ store: meetingStore, offices, getAgents: () => agents, taskService, startTask: (taskId) => { const task = taskStore.get(taskId); if (task?.status === 'queued') taskStore.update(taskId, { parked: undefined }) }, issueExists: () => true, cancelTask: (taskId) => runner.terminateTask(taskId), addIssueComment: (issueId, content, authorId) => { mirrored.push({ issueId, content, authorId }) }, now: Date.now })
  runner.attachMeetingGuard((task) => controller.canRunTask(task))
  return { data, taskStore, taskService, runner, offices, controller, meetingStore, agents, mirrored }
}

const fixture = await makeFixture()
const meeting = fixture.controller.create({ issueId: 'iss_1', topic: 'release decision', participants: [
  { agentId: 'alpha', role: 'reporter' }, { agentId: 'beta', role: 'critic' }, { agentId: 'gamma', role: 'designer' }
], maxRounds: 1 })
const result = await fixture.controller.start(meeting.id)
check(result.ok && result.meeting?.status === 'concluded', 'all explicit agree + valid envelope concludes meeting')
check(result.meeting?.stopReason === 'converged', 'concluded meeting records converged stopReason')
check(result.meeting?.minutes.length === 1, 'concluded meeting persists one round minutes')
check(fixture.meetingStore.turns(meeting.id).filter((turn) => turn.agentId !== 'meeting').length === 6, 'meeting persists discussion and fresh final confirmation turns')
const action = result.meeting?.minutes.at(-1)?.actionItems[0]
check(action && action.taskId === undefined, 'unapproved action items never materialize tasks')
check(!fixture.taskStore.list().some((task) => task.prompt.includes('run release checks')), 'no action task exists before approval')
const approved = fixture.controller.approveAction(meeting.id, 0, 'approved')
const approvedTaskId = fixture.controller.get(meeting.id)?.minutes.at(-1)?.actionItems[0]?.taskId
const approvedTask = approvedTaskId ? fixture.taskStore.get(approvedTaskId) : undefined
check(approved.ok && !!approvedTask && approvedTask.status === 'queued' && approvedTask.parked !== true, 'approval creates and releases the independent action task')
check(!!approvedTask && approvedTask.issueId !== 'iss_1' && approvedTask.trigger === 'meeting', 'approved action task owns an independent issue with meeting provenance')
const memberTasks = fixture.taskStore.list().filter((task) => task.meetingId === meeting.id)
check(memberTasks.length === 3 && memberTasks.every((task) => task.status === 'done' && !!task.result), 'member session results survive the natural-end terminateTask sweep')
check(fixture.runner.sessionCount() === 0, 'natural conclusion closes idle member sessions through terminateTask')
const meetingComments = fixture.mirrored.filter((row) => row.issueId === 'iss_1')
check(meetingComments.length >= 3, 'every speech mirrors to the issue timeline')
check(['alpha', 'beta', 'gamma'].every((id) => meetingComments.some((row) => row.authorId === id)), 'mirrored comments carry speaker author ids')
check(meetingComments.some((row) => row.content.includes('轮/汇报')) && meetingComments.some((row) => row.content.includes('轮/质疑')) && meetingComments.some((row) => row.content.includes('轮/综合')), 'mirrored comments label meeting, round and phase')
check(phaseCalls.some((call) => call.agent === 'gamma' && call.prompt.includes('综合轮')), 'designer synthesis turn finalizes minutes')

mode = 'budget'
const budgetMeeting = fixture.controller.create({ issueId: 'iss_2', topic: 'blocked decision', participants: [
  { agentId: 'alpha', role: 'reporter' }, { agentId: 'beta', role: 'critic' }, { agentId: 'gamma', role: 'designer' }
], maxRounds: 1 })
const budgetResult = await fixture.controller.start(budgetMeeting.id)
check(budgetResult.ok && budgetResult.meeting?.status === 'waiting_user', 'budget exhaustion waits for user after synthesis')
check(budgetResult.meeting?.stopReason === 'budget', 'budget stopReason is distinct from converged')
check(budgetResult.meeting?.minutes.at(-1)?.objections.some((objection) => !objection.resolved), 'forced synthesis keeps unresolved objections explicit')
check(synthesisCalls >= 1, 'budget path runs a real synthesis turn before waiting')

check(fixture.mirrored.filter((row) => row.issueId === 'iss_2').some((row) => row.content.includes('轮/答辩')), 'defense speeches mirror with phase label')
check(phaseCalls.some((call) => call.agent === 'alpha' && call.prompt.includes('答辩轮')), 'defense turn is answered by the challenged reporter, not the designer')

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

check(phaseCalls.some((call) => call.agent === 'alpha' && call.prompt.includes('汇报轮') && !call.prompt.includes('<investigate')), 'report prompt does not teach <investigate> to a reporter without subordinates')
check(phaseCalls.some((call) => call.agent === 'beta' && call.prompt.includes('质疑轮') && call.prompt.includes('<investigate') && call.prompt.includes('可调查的队员：Gamma')), 'challenge prompt teaches <investigate> with the critic\'s own investigators')
check(phaseCalls.some((call) => call.prompt.includes('强制综合') && call.prompt.includes('会议优先') && call.prompt.includes('"actionItems"') && !call.prompt.includes('<investigate')), 'forced synthesis asserts meeting precedence, full envelope schema and no investigation')
check(phaseCalls.some((call) => call.prompt.includes('质疑轮') && call.prompt.includes('<stance verdict=')), 'challenge prompt shows stance tag syntax')
check(phaseCalls.some((call) => call.prompt.includes('答辩轮') && call.prompt.includes('"decisions"') && call.prompt.includes('"actionItems"')), 'defense prompt teaches envelope schema')
check(phaseCalls.some((call) => call.prompt.includes('会议优先')), 'meeting prompts assert protocol precedence over delegation protocol')

const agree = (grounds = 'verified') => `<stance verdict="agree" grounds="${grounds}"/>`
const disagree = (grounds = 'still blocked') => `<stance verdict="disagree" grounds="${grounds}"/>`
const objection = (ref = 'proposal:1', text = 'needs independent evidence') => `<objection ref="${ref}" priority="high">${text}</objection>`
const minutesText = (overrides = {}) => JSON.stringify({ decisions: ['revised decision'], objections: [], actionItems: [], openQuestions: [], ...overrides })
const proposal = { text: 'needs independent evidence', ref: 'proposal:1', resolved: true, resolution: 'defense evidence v2' }
const defaults = ({ phase }) => phase === '综合轮' || phase === 'forced'
  ? `${minutesText()}\n${agree()}`
  : agree()
const runDiscussion = async (respond, options = {}) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-discussion-data-'))
  const store = new MeetingStore(data)
  const agents = ['alpha', 'beta', 'gamma', 'delta'].map((id) => ({ id, name: id.toUpperCase(), backend: 'fake-dialogue', role: '队长' }))
  const calls = []
  const comments = []
  const actionTasks = []
  const controller = new MeetingController({
    store,
    getAgents: () => agents,
    offices: {
      get: (agentId) => ({ id: `office_${agentId}` }),
      followUp: async (agentId, prompt, opts) => {
        const marker = prompt.match(/【系统·会议·第 (\d+) 轮\/([^】]+)】/)
        const call = { agentId, prompt, opts, round: Number(marker?.[1] ?? 0), persistedRound: store.get(opts.meetingId)?.round, phase: marker?.[2] ?? 'forced' }
        calls.push(call)
        return { ok: true, finalText: await respond(call, calls) }
      }
    },
    taskService: { createTask: (input) => { actionTasks.push(input); return { id: `action_${actionTasks.length}` } } },
    addIssueComment: (issueId, content, authorId) => comments.push({ issueId, content, authorId })
  })
  const meeting = controller.create({
    issueId: 'dialogue', topic: 'discussion must be two-way', maxRounds: 1, maxInnerTurns: 2,
    participants: [{ agentId: 'alpha', role: 'reporter' }, { agentId: 'beta', role: 'critic' }, { agentId: 'gamma', role: 'designer' }],
    ...options
  })
  const result = await controller.start(meeting.id)
  return { result, calls, comments, actionTasks, turns: store.turns(meeting.id) }
}

const dialogue = await runDiscussion((call) => {
  if (call.phase === '汇报轮') return `original proposal v1\n${agree()}`
  if (call.agentId === 'beta' && call.phase === '质疑轮') return `${objection()}\n${disagree()}`
  if (call.phase === '答辩轮') return `revised proposal v2\n${minutesText({ objections: [proposal] })}\n${agree()}`
  return defaults(call)
})
check(dialogue.result.meeting?.status === 'concluded', 'critic-confirmed defense converges within the same round')
check(dialogue.result.meeting?.minutes[0].objections[0]?.resolved === true, 'only the objection author confirms the defense resolution')
check(dialogue.calls.some((call) => call.agentId === 'gamma' && call.phase === '质疑轮' && call.prompt.includes('needs independent evidence')), 'later participants see earlier criticism, not just the original report')
check(dialogue.calls.some((call) => call.agentId === 'beta' && call.phase === '质疑轮·答辩复核' && call.prompt.includes('revised proposal v2') && call.prompt.includes('defense evidence v2')), 'critic receives the actual defense and revised proposal for recheck')
check(dialogue.calls.some((call) => call.phase === '综合轮' && call.prompt.includes('original proposal v1') && call.prompt.includes('revised proposal v2') && call.prompt.includes('\"resolved\":true')), 'designer sees the full discussion and confirmed resolution')
check(dialogue.calls.filter((call) => call.phase === '质疑轮·最终纪要确认').length === 2, 'other participants explicitly ratify the final minutes')
check(dialogue.comments.some((comment) => comment.authorId === 'beta' && comment.content.includes('needs independent evidence') && comment.content.includes('proposal:1')), 'issue timeline preserves objection text and its reference')
check(dialogue.calls.every((call) => call.opts.collectFinal === true && call.opts.meetingTurn === (call.phase !== 'forced')), 'discussion turns preserve office collection and investigation gates')
const visibleObjection = stripMeetingTags(`${objection()}\n${disagree()}`)
check(visibleObjection.includes('needs independent evidence') && visibleObjection.includes('proposal:1') && !visibleObjection.includes('<objection') && !visibleObjection.includes('<stance'), 'tag stripping removes protocol syntax without deleting the criticism')

const selfSigned = await runDiscussion((call) => {
  if (call.agentId === 'beta') return `${objection()}\n${disagree()}`
  if (call.phase === '答辩轮') return `${minutesText({ objections: [proposal] })}\n${agree()}`
  return defaults(call)
}, { maxInnerTurns: 1 })
check(selfSigned.result.meeting?.status === 'waiting_user', 'reporter resolved=true cannot conclude over a critic disagreement')
check(selfSigned.result.meeting?.minutes[0].objections[0]?.resolved === false, 'unconfirmed resolution stays unresolved even at the inner-turn budget boundary')
check(selfSigned.calls.some((call) => call.phase === '质疑轮·答辩复核'), 'last allowed defense still receives a critic recheck')
check(selfSigned.result.meeting?.minutes.at(-1)?.objections.some((row) => row.raisedBy === 'beta' && row.ref === 'proposal:1' && !row.resolved), 'empty forced synthesis cannot erase an existing objection or its author')
check(!selfSigned.calls.some((call) => call.phase === '综合轮'), 'normal synthesis is blocked until critics confirm their objections')

const rejectedMinutes = await runDiscussion((call) => {
  if (call.phase === '综合轮') return `${minutesText({ actionItems: [{ title: 'unreviewed work', owner: 'ALPHA', acceptance: ['passes'] }] })}\n${agree()}`
  if (call.agentId === 'beta' && call.phase === '质疑轮·最终纪要确认') return `${objection('minutes:action', 'action was never discussed')}\n${disagree()}`
  return defaults(call)
})
check(rejectedMinutes.result.meeting?.status === 'waiting_user', 'initial agreement is not reused as approval of different final minutes')
check(rejectedMinutes.actionTasks.length === 0, 'unratified final minutes never materialize action tasks')
check(rejectedMinutes.result.meeting?.minutes.at(-1)?.objections.some((row) => row.text === 'action was never discussed'), 'final-minute objections remain visible after forced synthesis')

const missingVote = await runDiscussion((call) => call.agentId === 'beta' && call.phase === '质疑轮·最终纪要确认'
  ? 'no explicit final stance'
  : defaults(call))
check(missingVote.result.meeting?.status === 'waiting_user', 'missing final stance cannot borrow a participant earlier agree')

const missingSynthesis = await runDiscussion((call) => {
  if (call.agentId === 'beta' && call.phase === '质疑轮') return `${objection()}\n${disagree()}`
  if (call.phase === '答辩轮') return `${minutesText({ objections: [proposal] })}\n${agree()}`
  if (call.phase === '综合轮') return agree('no actual minutes')
  return defaults(call)
})
check(missingSynthesis.result.meeting?.status === 'waiting_user', 'invalid final synthesis cannot silently fall back to a defense envelope')

const followThrough = await runDiscussion((call) => {
  if (call.agentId === 'beta' && call.phase === '质疑轮·最终纪要确认' && call.round === 1) return `${objection('minutes:1', 'final plan needs revision')}\n${disagree()}`
  return defaults(call)
}, { maxRounds: 2 })
check(followThrough.result.meeting?.status === 'concluded' && followThrough.result.meeting.round === 2, 'final feedback can be addressed and ratified in a later round')
check(followThrough.calls.filter((call) => call.round === 2).every((call) => call.persistedRound === 2), 'round two is persisted before its report and review dispatches, not only after completion')
check(followThrough.calls.some((call) => call.phase === '汇报轮' && call.round === 2 && call.prompt.includes('final plan needs revision') && call.prompt.includes('上一轮纪要')), 'next-round reporter receives the actual prior minutes and dissent')
check(followThrough.calls.some((call) => call.agentId === 'beta' && call.phase === '质疑轮' && call.round === 2 && call.prompt.includes('final plan needs revision')), 'unresolved objections survive the round boundary until author confirmation')

const untaggedDissent = await runDiscussion((call) => call.agentId === 'beta' && call.phase === '质疑轮·最终纪要确认' && call.round === 1
  ? disagree('unapproved final action')
  : defaults(call), { maxRounds: 2 })
check(untaggedDissent.result.meeting?.status === 'concluded' && untaggedDissent.calls.some((call) => call.phase === '汇报轮' && call.round === 2 && call.prompt.includes('unapproved final action')), 'disagreement grounds without objection tags survive into the next round')

const designerDissent = await runDiscussion((call) => call.phase === '综合轮' && call.round === 1
  ? `${minutesText({ objections: [{ text: 'design feasibility missing', ref: 'design:1', resolved: true }] })}\n${agree()}`
  : defaults(call), { maxRounds: 2 })
check(designerDissent.result.meeting?.status === 'concluded' && designerDissent.result.meeting.round === 2, 'new synthesis objections require a later author review even if the designer self-marks resolved')
check(designerDissent.calls.some((call) => call.agentId === 'gamma' && call.phase === '质疑轮' && call.round === 2 && call.prompt.includes('design feasibility missing')), 'designer can review its own carried objection after the reporter revises the plan')

const sharedObjections = [1, 2, 3].map((number) => ({ text: `shared concern ${number}`, ref: `proposal:${number}`, resolved: true, resolution: `response ${number}` }))
const multipleCritics = await runDiscussion((call) => {
  if ((call.agentId === 'beta' && call.phase === '质疑轮') || call.agentId === 'delta') return `${sharedObjections.map((row) => objection(row.ref, row.text)).join('\n')}\n${disagree()}`
  if (call.phase === '答辩轮') return `${minutesText({ objections: sharedObjections })}\n${agree()}`
  return defaults(call)
}, {
  maxInnerTurns: 1,
  participants: [{ agentId: 'alpha', role: 'reporter' }, { agentId: 'beta', role: 'critic' }, { agentId: 'delta', role: 'critic' }, { agentId: 'gamma', role: 'designer' }]
})
const multipleRows = multipleCritics.result.meeting?.minutes[0].objections ?? []
check(multipleRows.length === 6, 'per-speaker objection limits do not discard another critic identical objections')
check(multipleRows.filter((row) => row.raisedBy === 'beta').every((row) => row.resolved) && multipleRows.filter((row) => row.raisedBy === 'delta').every((row) => !row.resolved), 'one critic cannot confirm another critic identical objections')
check(multipleCritics.result.meeting?.minutes.at(-1)?.objections.filter((row) => row.raisedBy === 'delta').length === 3, 'forced synthesis preserves all unconfirmed critic objections')

const abstained = await runDiscussion((call) => {
  if (call.agentId === 'beta' && call.phase === '质疑轮') return '<stance verdict="abstain" grounds="missing rollout data"/>'
  if (call.phase === '答辩轮') return `rollout data supplied\n${minutesText()}\n${agree()}`
  return defaults(call)
})
check(abstained.result.meeting?.status === 'concluded' && abstained.calls.some((call) => call.phase === '答辩轮' && call.prompt.includes('missing rollout data')), 'abstentions without objection tags still get a response and recheck')

const contradictoryReview = await runDiscussion((call) => {
  if (call.agentId === 'beta') return `${objection()}\n${call.phase === '质疑轮·答辩复核' ? agree() : disagree()}`
  if (call.phase === '答辩轮') return `${minutesText({ objections: [proposal] })}\n${agree()}`
  return defaults(call)
}, { maxInnerTurns: 1 })
check(contradictoryReview.result.meeting?.status === 'waiting_user' && contradictoryReview.result.meeting.minutes[0].objections[0]?.resolved === false, 'agree combined with an active objection is not accepted as resolution confirmation')

const reopened = await runDiscussion((call) => {
  if (call.agentId === 'beta' && (call.phase === '质疑轮' || call.phase === '质疑轮·最终纪要确认')) return `${objection()}\n${disagree()}`
  if (call.phase === '答辩轮') return `${minutesText({ objections: [proposal] })}\n${agree()}`
  return defaults(call)
})
check(reopened.result.meeting?.minutes[0].objections.length === 1 && reopened.result.meeting.minutes[0].objections[0]?.resolved === false, 'a critic can reopen the same objection after seeing final minutes without duplicate rows')

const twoParticipants = await runDiscussion(defaults, { participants: [{ agentId: 'alpha', role: 'reporter' }, { agentId: 'gamma', role: 'designer' }] })
check(twoParticipants.result.meeting?.status === 'concluded' && twoParticipants.calls.some((call) => call.agentId === 'gamma' && call.phase === '质疑轮'), 'designer joins the discussion even when there is no dedicated critic')

await fixture.runner.shutdown()
if (process.exitCode) process.exit(1)
console.log('\n✅ MEETING SMOKE PASSED')
