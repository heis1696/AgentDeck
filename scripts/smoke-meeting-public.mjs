// 公开发言事实源专项（阶段2）：会议公开快照的版本/来源一致性、跨轮质疑稳定ID、
// 用户插话落盘与重新确认、压缩账本与显式超限、Issue 镜像去重、取消交错与 resume 闸门。
// 独立运行：node scripts/smoke-meeting-public.mjs（未注册进 package.json，由领队决定是否接入 smoke:all）。
// 只新增本文件，不改 src/package.json/既有测试；全部使用临时 fixture，不访问生产数据。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-meeting-public-'))
const bundle = async (source, name) => {
  const outfile = path.join(temporary, `${name}.cjs`)
  await build({ entryPoints: [path.join(root, source)], outfile, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
  return import(pathToFileURL(outfile).href)
}
const [{ MeetingController }, { MeetingStore }, { assembleMeetingContext }, { TaskStore }, { TaskService }, { IssueStore }, { TaskRunner }, { AgentSessionRegistry }] = await Promise.all([
  bundle('src/main/meeting-controller.ts', 'controller'), bundle('src/main/meeting-store.ts', 'meetings'),
  bundle('src/main/meeting-context.ts', 'context'), bundle('src/main/store.ts', 'tasks'),
  bundle('src/main/task-service.ts', 'service'), bundle('src/main/issue-store.ts', 'issues'),
  bundle('src/main/runner.ts', 'runner'), bundle('src/main/agent-sessions.ts', 'registry')
])

let total = 0
const failures = []
const check = (condition, label) => {
  total++
  console.log(`  ${condition ? 'OK' : 'FAIL'} ${label}`)
  if (!condition) { process.exitCode = 1; failures.push(label) }
}
const scenario = (label) => console.log(`\n[${label}]`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const waitFor = async (predicate, label, timeoutMs = 4_000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() > deadline) throw new Error(`fixture deadline exceeded: ${label}`)
    await sleep(5)
  }
}
const defer = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
const agree = (grounds = 'verified') => `<stance verdict="agree" grounds="${grounds}"/>`
const disagree = (grounds = 'blocked') => `<stance verdict="disagree" grounds="${grounds}"/>`
const env = (overrides = {}) => '```json\n' + JSON.stringify({ decisions: [], objections: [], actionItems: [], openQuestions: [], ...overrides }) + '\n```'
const objTag = (id, ref, text) => `<objection${id ? ` id="${id}"` : ''} ref="${ref}" priority="high">${text}</objection>`
const classify = (content) => {
  // 强制综合提示词不带「第 N 轮」标记，回退到公共上下文包里的 round
  const round = Number(content.match(/【系统·会议·第 (\d+) 轮\//)?.[1] ?? content.match(/"round":(\d+)/)?.[1] ?? 0)
  if (content.includes('【系统·会议·强制综合】')) return { round, phase: 'forced' }
  if (content.includes('质疑轮·最终纪要确认')) return { round, phase: 'confirm' }
  if (content.includes('质疑轮·答辩复核')) return { round, phase: 'recheck' }
  if (content.includes('/质疑轮】')) return { round, phase: 'challenge' }
  if (content.includes('/答辩轮】')) return { round, phase: 'defense' }
  if (content.includes('/综合轮】')) return { round, phase: 'synthesis' }
  if (content.includes('/汇报轮】')) return { round, phase: 'report' }
  return { round, phase: 'unknown' }
}
const lastTurn = (store, meetingId) => store.turns(meetingId).reduce((best, turn) => ((turn.sequence ?? 0) > (best?.sequence ?? -1) ? turn : best), null)
const speechDone = (store, meetingId) => store.turns(meetingId).filter((turn) => turn.status === 'done' && turn.purpose !== 'minutes')
/** delivery/正文只在详情读取（getTurn/readTurns）里，索引记录不带 */
const turnDetails = (store, meetingId) => store.readTurns(meetingId, { limit: 500 }).turns
const stableIdOf = (content) => /"objections":\[\{"id":"(obj_[A-Za-z0-9-]+)"/.exec(content)?.[1] ?? ''

// 各场景共用替身：三个队长挂不同后端；followUp 在进入时记录具名占位，
// 必须调用 onExecution 并当场核对回写身份（runId/执行回合/会话任务/投递状态）。
function makeFixture(label, { respond, gates = {}, contextLimit, cancelTask, addIssueComment, issueExists, issueId, maxRounds, maxInnerTurns } = {}) {
  const directory = path.join(temporary, label)
  fs.mkdirSync(directory, { recursive: true })
  const store = new MeetingStore(directory)
  const agents = [
    { id: 'alpha', name: '阿尔法·Codex', backend: 'codex-fake', role: '队长·汇报' },
    { id: 'beta', name: '贝塔·Claude', backend: 'claude-fake', role: '队长·质疑' },
    { id: 'gamma', name: '伽马·Gemini', backend: 'gemini-fake', role: '队长·设计' }
  ]
  const calls = []
  const sends = []
  const identityChecks = []
  const cancelCalls = []
  const offices = {
    get: (agentId, meetingId) => ({ id: `office_${meetingId}_${agentId}`, meetingId, meetingTaskRole: 'member' }),
    followUp: async (agentId, content, opts) => {
      const call = { agentId, ...classify(content), content }
      const meetingId = opts.meetingId
      const placeholder = lastTurn(store, meetingId)
      call.placeholderId = placeholder?.id
      call.placeholderStatus = placeholder?.status
      call.placeholderSpeaker = placeholder?.speaker?.name ?? ''
      sends.push(call)
      // 派发立即发生（onExecution 先于 gate）：挂起的是已在执行的回合，与真实运行一致
      const identity = { taskId: `member_${meetingId}_${agentId}`, runId: `run_${sends.length}`, turnId: `exec_${sends.length}` }
      opts.onExecution?.(identity)
      const during = store.getTurn(meetingId, placeholder.id)
      identityChecks.push(!!during && during.status === 'speaking' && during.sessionTaskId === identity.taskId
        && during.runId === identity.runId && during.executionTurnId === identity.turnId && during.deliveryState === 'dispatched')
      const gate = gates[`${agentId}:${call.phase}:${call.round}`]
      if (gate) await gate.promise
      calls.push(call)
      const text = respond(call)
      call.response = text
      if (text === null) return { ok: false, error: 'backend crashed' }
      return { ok: true, finalText: text }
    }
  }
  const controller = new MeetingController({
    store, offices, getAgents: () => agents,
    issueExists: issueExists ?? (() => true),
    addIssueComment: addIssueComment ?? (() => {}),
    cancelTask: cancelTask ?? (async (taskId) => { cancelCalls.push(taskId); return { ok: true } }),
    stopTimeoutMs: 200, ...(contextLimit ? { contextLimit } : {})
  })
  const meeting = controller.create({
    issueId: issueId ?? `iss_${label}`, topic: `公开发言事实源·${label}`, maxRounds: maxRounds ?? 1, ...(maxInnerTurns ? { maxInnerTurns } : {}),
    participants: [{ agentId: 'alpha', role: 'reporter' }, { agentId: 'beta', role: 'critic' }, { agentId: 'gamma', role: 'designer' }]
  })
  return { label, directory, store, controller, meeting, agents, calls, sends, identityChecks, cancelCalls, gates }
}

try {
  // ---------- 场景 A：不同后端同一公共快照；具名占位与 Run/执行回合链接；超长正文尾部可读 ----------
  scenario('cross-backend snapshot identity, named placeholders, execution links, long body tail')
  const longReport = '汇报正文头部。' + '公开讨论细节保持完整可读。'.repeat(330) + 'REPORT_TAIL_尾部完整可读'
  const converged = (call) => {
    if (call.phase === 'report') return `${longReport}\n${agree('report ready')}`
    if (call.phase === 'synthesis') return `${env({ decisions: ['ship A'] })}\n${agree('accepted')}`
    if (call.phase === 'forced') return env({ decisions: ['hold'] })
    return agree()
  }
  const a = makeFixture('a-cross-backend', { respond: converged })
  const resultA = await a.controller.start(a.meeting.id)
  check(resultA.ok && resultA.meeting?.status === 'concluded', 'three different backends converge on the shared public snapshot')
  check(a.identityChecks.length === 6 && a.identityChecks.every(Boolean), 'every speech dispatch calls onExecution once and the turn records the exact identity (sessionTaskId/runId/executionTurnId/dispatched)')
  check(a.sends[0].placeholderStatus === 'pending' && a.sends[0].placeholderSpeaker === '阿尔法·Codex', 'a named pending placeholder exists before the provider is invoked')
  const reportTurnA = a.store.getTurn(a.meeting.id, a.sends[0].placeholderId)
  check(!!reportTurnA && reportTurnA.status === 'done' && reportTurnA.body.length > 4000 && reportTurnA.body.includes('REPORT_TAIL_尾部完整可读'), 'speech body longer than the legacy 1000/4000 limits stays fully readable including its tail')
  check(!!reportTurnA && reportTurnA.summary.length <= 500 && !reportTurnA.summary.includes('REPORT_TAIL_尾部完整可读'), 'index summary stays within 500 chars and never passes for the full body')
  const speechA = turnDetails(a.store, a.meeting.id).filter((turn) => turn.status === 'done' && turn.purpose !== 'minutes').sort((x, y) => (x.sequence ?? 0) - (y.sequence ?? 0))
  check(speechA.length === 6 && speechA.every((turn) => turn.contextVersion === turn.delivery?.publicVersion), 'each turn records the public version it was served as its context version')
  let appendOnly = true
  let previous = []
  for (const turn of speechA) {
    const sources = turn.delivery?.sourceTurnIds ?? []
    if (sources.length < previous.length || !previous.every((id, index) => sources[index] === id)) appendOnly = false
    previous = sources
  }
  check(appendOnly && speechA.at(-1).delivery.sourceTurnIds.length === 5, 'sequential speeches only append new facts to sourceTurnIds (growth is not inconsistency)')
  const snapshotState = () => assembleMeetingContext(a.store, a.controller.get(a.meeting.id), a.controller.get(a.meeting.id).objections ?? [])
  const snap1 = snapshotState()
  const snap2 = snapshotState()
  check(snap1.text === snap2.text && snap1.delivery.publicVersion === snap2.delivery.publicVersion
    && snap1.delivery.sourceTurnIds.join() === snap2.delivery.sourceTurnIds.join(),
  'assembling the same public snapshot twice yields byte-identical text, version and sources (host-side packets are backend-independent)')
  const confirmationsA = resultA.meeting.minutes[0].confirmations ?? []
  check(confirmationsA.length === 3 && confirmationsA.every((row) => row.verdict === 'agree'), 'all three backends ratify the final minutes')
  check(new Set(confirmationsA.map((row) => row.minutesVersion)).size === 1 && !!confirmationsA[0].minutesVersion, 'every backend confirms the same content-derived minutes version for the same draft')

  // ---------- 场景 B：质疑跨轮稳定 ID 无碰撞，原提出者可否决 ----------
  scenario('cross-round objection stable id without collision, original raiser veto')
  const b = makeFixture('b-stable-objection', {
    maxRounds: 2, maxInnerTurns: 1,
    respond: (call) => {
      if (call.agentId === 'beta' && call.phase === 'challenge' && call.round === 1) return `${objTag('', 'spec:1', 'needs evidence')}\n${disagree('not evidenced')}`
      if (call.agentId === 'beta' && call.phase === 'recheck' && call.round === 1) return `${objTag('', 'spec:1', 'needs evidence')}\n${disagree('still not evidenced')}`
      if (call.agentId === 'beta' && call.phase === 'challenge' && call.round === 2) return `${objTag(stableIdOf(call.content), 'spec:1', 'needs evidence')}\n${disagree('verifying revision')}`
      if (call.phase === 'defense') return `${env({ objections: [{ id: stableIdOf(call.content), text: 'needs evidence', ref: 'spec:1', resolved: true, resolution: `evidence v${call.round}` }] })}\n${agree('addressed')}`
      if (call.phase === 'synthesis') return `${env({ decisions: ['ship B'] })}\n${agree('accepted')}`
      if (call.phase === 'forced') return env()
      return agree()
    }
  })
  const resultB = await b.controller.start(b.meeting.id)
  check(resultB.ok && resultB.meeting?.status === 'concluded' && resultB.meeting.round === 2, 'meeting needs the second round to settle the objection')
  const rowR1 = resultB.meeting.minutes[0].objections[0]
  check(!!rowR1 && /^obj_/.test(rowR1.id) && rowR1.resolved === false, 'defense resolved=true alone cannot close the objection: the original raiser vetoed it in round 1')
  const stableId = rowR1.id
  const rowR2 = resultB.meeting.minutes[1].objections
  check(rowR2.length === 1 && rowR2[0].id === stableId && rowR2[0].resolved === true, 'round-2 re-raised objection keeps the same stable id on a single row and closes only after the raiser agrees')
  const challengeB2 = b.calls.find((call) => call.agentId === 'beta' && call.phase === 'challenge' && call.round === 2)
  check(!!challengeB2 && challengeB2.content.includes(stableId), 'the public ledger exposes the stable id so the raiser can re-raise the same row')
  const liveLedger = resultB.meeting.objections ?? []
  check(liveLedger.length === 1 && liveLedger[0].id === stableId, 'the re-raise updated the existing ledger row instead of registering a colliding duplicate')

  // ---------- 场景 C：末行畸形 stance 不能借用前文 agree ----------
  scenario('malformed last-line stance cannot borrow an earlier agree')
  const c = makeFixture('c-malformed-stance', {
    respond: (call) => {
      if (call.agentId === 'beta' && call.phase === 'confirm') return '讨论方向认可\n<stance verdict="agree" grounds="looks fine'
      if (call.phase === 'synthesis') return `${env({ decisions: ['ship C'] })}\n${agree('accepted')}`
      if (call.phase === 'forced') return env()
      return agree()
    }
  })
  const resultC = await c.controller.start(c.meeting.id)
  check(resultC.ok && resultC.meeting?.status === 'waiting_user' && resultC.meeting?.stopReason === 'budget', 'a truncated final stance prevents conclusion')
  check(c.calls.some((call) => call.agentId === 'beta' && call.phase === 'challenge' && `${call.response}`.trimEnd().endsWith(agree())), 'beta had an earlier well-formed agree in the challenge phase')
  const confirmationsC = resultC.meeting.minutes[0].confirmations ?? []
  check(confirmationsC.find((row) => row.agentId === 'beta')?.verdict === 'invalid', 'the malformed confirmation is recorded as invalid instead of borrowing the earlier agree')
  check(confirmationsC.find((row) => row.agentId === 'alpha')?.verdict === 'agree', 'other members keep their own valid confirmations')

  // ---------- 场景 D：多份 JSON 纪要歧义不能结论 ----------
  scenario('ambiguous multiple minutes JSON cannot conclude')
  const d = makeFixture('d-ambiguous-json', {
    respond: (call) => {
      if (call.phase === 'synthesis') return `${env({ decisions: ['A稿'] })}\n${env({ decisions: ['B稿'] })}\n${agree('pick one')}`
      if (call.phase === 'forced') return env({ decisions: ['forced'] })
      return agree()
    }
  })
  const resultD = await d.controller.start(d.meeting.id)
  check(resultD.ok && resultD.meeting?.status === 'waiting_user' && resultD.meeting?.stopReason === 'budget', 'two valid minutes drafts block conclusion instead of picking one')
  check(resultD.meeting.minutes[0].decisions.length === 0 && resultD.meeting.minutes[0].version === undefined, 'no envelope or draft version is adopted from the ambiguous output')
  check((resultD.meeting.minutes[0].confirmations ?? []).length === 0, 'no confirmation is recorded for an ambiguous synthesis')
  check(d.calls.some((call) => call.phase === 'forced'), 'the meeting falls through to an explicit forced synthesis')

  // ---------- 场景 E：拒绝/缺席/格式错误/执行失败均非同意 ----------
  scenario('rejection, absence, bad format and execution failure are not consent')
  const expectation = (fixture, result, betaVerdict, label) => {
    const confirmations = result.meeting?.minutes[0]?.confirmations ?? []
    check(result.ok && result.meeting?.status === 'waiting_user' && result.meeting?.stopReason === 'budget', label)
    check((confirmations.find((row) => row.agentId === 'beta')?.verdict ?? 'missing') === betaVerdict, `${label}: beta confirmation verdict is ${betaVerdict}`)
    check(confirmations.find((row) => row.agentId === 'alpha')?.verdict === 'agree', `${label}: alpha's own valid confirmation never speaks for beta`)
  }
  const e1 = makeFixture('e1-reject', { respond: (call) => call.agentId === 'beta' && call.phase === 'confirm' ? `cannot accept\n${disagree('missing rollout safety')}` : call.phase === 'synthesis' ? `${env({ decisions: ['ship E'] })}\n${agree()}` : call.phase === 'forced' ? env() : agree() })
  expectation(e1, await e1.controller.start(e1.meeting.id), 'disagree', 'explicit rejection keeps the meeting open')
  const e2 = makeFixture('e2-absent', { respond: (call) => call.agentId === 'beta' && call.phase === 'confirm' ? 'noted, thanks.' : call.phase === 'synthesis' ? `${env({ decisions: ['ship E'] })}\n${agree()}` : call.phase === 'forced' ? env() : agree() })
  expectation(e2, await e2.controller.start(e2.meeting.id), 'invalid', 'a response without any stance counts as absence, not consent')
  const e3 = makeFixture('e3-bad-format', { respond: (call) => call.agentId === 'beta' && call.phase === 'confirm' ? '<stance verdict="approved" grounds="fine"/>' : call.phase === 'synthesis' ? `${env({ decisions: ['ship E'] })}\n${agree()}` : call.phase === 'forced' ? env() : agree() })
  expectation(e3, await e3.controller.start(e3.meeting.id), 'invalid', 'a stance with an out-of-enum verdict is a format error, not consent')
  const e4 = makeFixture('e4-failure', { respond: (call) => call.agentId === 'beta' && call.phase === 'confirm' ? null : call.phase === 'synthesis' ? `${env({ decisions: ['ship E'] })}\n${agree()}` : agree() })
  const resultE4 = await e4.controller.start(e4.meeting.id)
  check(!resultE4.ok && resultE4.meeting?.status === 'failed' && /backend crashed/.test(resultE4.error ?? ''), 'a hard member execution failure fails the meeting instead of concluding')
  check(resultE4.meeting?.minutes.length === 0, 'a failed round never produces minutes')
  const failedTurnE4 = e4.store.turns(e4.meeting.id).find((turn) => turn.agentId === 'beta' && turn.purpose === 'confirmation')
  check(failedTurnE4?.status === 'failed' && !!failedTurnE4.error, 'the failed confirmation turn records its failure explicitly')

  // ---------- 场景 F：在途插话立即落盘，旧请求不被标记为已接收 ----------
  scenario('interjection during an in-flight speech persists immediately')
  const f = makeFixture('f-interject-flight', { gates: { 'alpha:report:1': defer() }, respond: converged })
  const startedF = f.controller.start(f.meeting.id)
  await waitFor(() => f.sends.length === 1, 'first speech in flight')
  const chairNoteF = '用户插话：先补齐风险清单再谈结论'
  const interjectedF = f.controller.interject(f.meeting.id, chairNoteF)
  check(interjectedF.ok, 'interjection is accepted while a speech is in flight')
  const chairF = f.store.turns(f.meeting.id).find((turn) => turn.purpose === 'chair')
  const chairDetailF = f.store.getTurn(f.meeting.id, chairF.id)
  check(chairDetailF.status === 'done' && chairDetailF.body === chairNoteF && (f.controller.get(f.meeting.id).publicVersion ?? 0) >= 1, 'the chair note is durably persisted with full body and bumps the public version immediately')
  const inFlightF = f.store.getTurn(f.meeting.id, f.sends[0].placeholderId)
  check(inFlightF.deliveryState === 'dispatched' && inFlightF.contextVersion === 0 && !inFlightF.delivery.chairTurnIds.includes(chairF.id), 'the in-flight request keeps its old snapshot: not marked accepted and honest that it never received the note')
  check(f.controller.get(f.meeting.id).currentTurn?.agentId === 'alpha', 'the current speaker stays visible during the flight')
  f.gates['alpha:report:1'].resolve()
  const resultF = await startedF
  check(resultF.ok && resultF.meeting?.status === 'concluded', 'the meeting still converges after the interjection')
  const confirmTurnsF = turnDetails(f.store, f.meeting.id).filter((turn) => turn.purpose === 'confirmation' && turn.status === 'done')
  check(confirmTurnsF.length >= 2 && confirmTurnsF.every((turn) => turn.delivery.chairTurnIds.includes(chairF.id)), 'every member ratifies only on a version that actually includes the chair note')
  check((resultF.meeting.minutes[0].confirmations ?? []).every((row) => row.chairTurnIds.includes(chairF.id)), 'recorded confirmations carry the chair turn id')

  // ---------- 场景 G：最后确认时插话，旧确认全部失效并重新接收实际版本 ----------
  scenario('interjection at final confirmation invalidates every prior confirmation')
  const g = makeFixture('g-interject-confirm', { gates: { 'beta:confirm:1': defer() }, respond: converged })
  const startedG = g.controller.start(g.meeting.id)
  await waitFor(() => g.sends.some((send) => send.agentId === 'beta' && send.phase === 'confirm'), 'beta confirmation in flight')
  const chairNoteG = '用户插话：纪要里写明交付日期'
  const interjectedG = g.controller.interject(g.meeting.id, chairNoteG)
  const chairG = g.store.turns(g.meeting.id).find((turn) => turn.purpose === 'chair')
  check(interjectedG.ok && g.store.getTurn(g.meeting.id, chairG.id).body === chairNoteG, 'the chair note lands durably while a confirmation is pending')
  const betaInFlight = g.store.getTurn(g.meeting.id, g.sends.at(-1).placeholderId)
  check(betaInFlight.deliveryState === 'dispatched' && !betaInFlight.delivery.chairTurnIds.includes(chairG.id), 'the pending confirmation keeps its pre-note snapshot and is not marked received')
  g.gates['beta:confirm:1'].resolve()
  const resultG = await startedG
  check(resultG.ok && resultG.meeting?.status === 'concluded' && resultG.meeting.round === 1, 'the meeting concludes only after re-confirmation, within the same round')
  const confirmsOf = (agentId) => turnDetails(g.store, g.meeting.id).filter((turn) => turn.purpose === 'confirmation' && turn.agentId === agentId).sort((x, y) => (x.sequence ?? 0) - (y.sequence ?? 0))
  const beta1 = confirmsOf('beta')[0]
  const beta2 = confirmsOf('beta').at(-1)
  check(confirmsOf('beta').length === 2 && confirmsOf('alpha').length === 2 && confirmsOf('gamma').length === 1, 'the draft revision re-requests confirmation from every member')
  check(!beta1.delivery.chairTurnIds.includes(chairG.id) && beta2.delivery.chairTurnIds.includes(chairG.id) && beta1.minutesVersion !== beta2.minutesVersion, 'beta re-receives the actual chair-inclusive version under a new minutes version')
  check(g.store.getTurn(g.meeting.id, beta1.id).delivery.chairTurnIds.length === 0, 'the superseded confirmation record is never rewritten to claim it saw the note')
  const confirmationsG = resultG.meeting.minutes[0].confirmations ?? []
  check(confirmationsG.length === 3 && confirmationsG.every((row) => row.verdict === 'agree' && row.chairTurnIds.includes(chairG.id) && row.minutesVersion === beta2.minutesVersion), 'final minutes carry only post-note confirmations sharing one version')

  // ---------- 场景 H：真实 IssueStore 镜像：失败重试按 sourceTurnId 去重 ----------
  scenario('mirror to a real IssueStore dedupes retries by sourceTurnId')
  const hDir = path.join(temporary, 'h-mirror')
  const tasksH = new TaskStore(hDir)
  const issuesH = new IssueStore(hDir)
  const serviceH = new TaskService({ store: tasksH, issueStore: issuesH })
  const containerH = serviceH.createTask({ title: 'meeting container', prompt: 'discuss', workdir: hDir, startNow: false })
  issuesH.sync(tasksH.list())
  const issueH = issuesH.get(containerH.issueId)
  let mirrorFailures = 0
  const h = makeFixture('h-mirror', {
    issueId: issueH.id,
    issueExists: (id) => !!issuesH.get(id),
    addIssueComment: (issueId, content, authorId, meetingId, sourceTurnId) => {
      if (mirrorFailures === 0) { mirrorFailures++; throw new Error('mirror transport down') }
      return issuesH.addComment(issueId, content, { type: 'agent', id: authorId }, { meetingId, sourceTurnId })
    },
    respond: converged
  })
  const resultH = await h.controller.start(h.meeting.id)
  check(resultH.ok && resultH.meeting?.status === 'concluded', 'mirror failure does not derail the meeting')
  const reportTurnH = h.store.getTurn(h.meeting.id, h.sends[0].placeholderId)
  check(mirrorFailures === 1 && reportTurnH.mirror?.state === 'failed' && reportTurnH.mirror.attempts === 1 && /mirror transport/.test(reportTurnH.mirror.lastError ?? ''), 'the first mirror failure is recorded on the turn with its error')
  check(!!reportTurnH.body && reportTurnH.body.length > 0, 'the authoritative body stays readable while its mirror is failed')
  check(h.controller.retryMirrors(h.meeting.id).ok && h.store.getTurn(h.meeting.id, reportTurnH.id).mirror?.state === 'published' && h.store.getTurn(h.meeting.id, reportTurnH.id).mirror?.attempts === 2, 'retryMirrors publishes the failed mirror with an incremented attempt count')
  const meetingComments = () => issuesH.comments(issueH.id).filter((comment) => comment.meetingId === h.meeting.id)
  check(meetingComments().filter((comment) => comment.sourceTurnId === reportTurnH.id).length === 1, 'the retried mirror leaves exactly one comment for the source turn')
  const commentCountAfterRetry = meetingComments().length
  h.controller.retryMirrors(h.meeting.id)
  check(meetingComments().length === commentCountAfterRetry, 'retrying again never duplicates already published mirrors')
  const duplicated = issuesH.addComment(issueH.id, 'different text same source', { type: 'user', id: 'user' }, { meetingId: h.meeting.id, sourceTurnId: reportTurnH.id })
  check(duplicated && duplicated.sourceTurnId === reportTurnH.id && meetingComments().length === commentCountAfterRetry, 'the IssueStore itself dedupes by meetingId+sourceTurnId')
  const publishedTurns = h.store.turns(h.meeting.id).filter((turn) => turn.status === 'done' && turn.purpose !== 'minutes' && turn.mirror?.state === 'published')
  const grouped = new Map()
  for (const comment of meetingComments()) grouped.set(comment.sourceTurnId, (grouped.get(comment.sourceTurnId) ?? 0) + 1)
  check(meetingComments().length === publishedTurns.length + 1 && [...grouped.values()].every((count) => count === 1), 'every published turn mirrors exactly once (speeches plus the minutes record)')
  check(meetingComments().some((comment) => comment.content.includes('【会议·第 1 轮/汇报】') && comment.author?.id === 'alpha'), 'mirror comments keep the phase label and the speaker author')
  tasksH.flush()
  issuesH.close()

  // ---------- 场景 I：强制综合返回与取消交错不复活 ----------
  scenario('late forced-synthesis result cannot revive a cancelled meeting')
  const i = makeFixture('i-cancel-interleave', {
    gates: { 'gamma:forced:1': defer() },
    respond: (call) => call.agentId === 'beta' && call.phase === 'confirm' ? `want another direction\n${disagree('plan is premature')}` : call.phase === 'synthesis' ? `${env({ decisions: ['ship I'] })}\n${agree()}` : call.phase === 'forced' ? env({ decisions: ['forced I'] }) : agree()
  })
  const startedI = i.controller.start(i.meeting.id)
  await waitFor(() => i.sends.some((send) => send.phase === 'forced'), 'forced synthesis in flight')
  const cancellingI = i.controller.cancel(i.meeting.id)
  const cancelResultI = await cancellingI
  check(cancelResultI.ok === false && i.controller.get(i.meeting.id).status === 'cancelled' && i.controller.get(i.meeting.id).stopState === 'failed', 'cancelling while the run is parked reports the unconfirmed exit instead of pretending success')
  check(i.cancelCalls.length === 3, 'stop swept every member execution')
  i.gates['gamma:forced:1'].resolve()
  const resultI = await startedI
  const finalI = i.controller.get(i.meeting.id)
  check(resultI.meeting?.status === 'cancelled' && finalI.status === 'cancelled', 'the late forced-synthesis return leaves the meeting cancelled (no revival)')
  check(finalI.minutes.length === 1 && !finalI.minutes[0].summary?.startsWith('强制综合'), 'no forced minutes were appended after cancellation')
  check(i.store.turns(i.meeting.id).every((turn) => turn.purpose !== 'minutes'), 'no minutes record is published after cancellation')
  const cancelledTurns = i.store.turns(i.meeting.id).filter((turn) => turn.status === 'cancelled')
  check(cancelledTurns.length === 1 && cancelledTurns[0].mirror?.state === 'skipped' && speechDone(i.store, i.meeting.id).length === 6, 'the interrupted forced turn is marked cancelled and skipped, done speeches untouched')

  // ---------- 场景 J：stopState 未解除时 resume 不得先改 active ----------
  scenario('resume refuses while stopState is set and never flips status first')
  const j = makeFixture('j-resume-guard', {
    cancelTask: async () => ({ ok: false, error: 'exit unconfirmed' }),
    respond: (call) => call.agentId === 'beta' && call.phase === 'confirm' ? `cannot agree\n${disagree('needs data')}` : call.phase === 'synthesis' ? `${env({ decisions: ['ship J'] })}\n${agree()}` : call.phase === 'forced' ? env() : agree()
  })
  const resultJ = await j.controller.start(j.meeting.id)
  check(!resultJ.ok && /exit unconfirmed/.test(resultJ.error ?? ''), 'an unconfirmed member exit fails the start sweep visibly')
  const midJ = j.controller.get(j.meeting.id)
  check(midJ.status === 'waiting_user' && midJ.stopState === 'failed', 'the meeting stays waiting_user with a durable failed stop state')
  const resumeJ = await j.controller.resume(j.meeting.id)
  check(!resumeJ.ok && j.controller.get(j.meeting.id).status === 'waiting_user' && j.controller.get(j.meeting.id).stopState === 'failed', 'resume is refused while stopState is set and the status was never flipped to active')
  check(j.sends.length === 7, 'no member execution was started by the refused resume')

  // ---------- 场景 L：第二轮收到最新完整答辩，而不是初始 500 字摘要 ----------
  scenario('round 2 receives the latest full defense, not the initial 500-char summary')
  const defenseBodyL = '答辩正文起始。' + '答辩论证保持完整。'.repeat(90) + 'TAIL_OF_DEFENSE_答辩尾部完整'
  const l = makeFixture('l-round2-full-defense', {
    maxRounds: 2,
    respond: (call) => {
      if (call.agentId === 'beta' && call.phase === 'challenge' && call.round === 1) return `${objTag('', 'spec:9', 'needs numbers')}\n${disagree('no data')}`
      if (call.phase === 'defense' && call.round === 1) return `${defenseBodyL}\n${env({ decisions: ['R1共识'], objections: [{ text: 'needs numbers', ref: 'spec:9', resolved: true, resolution: 'numbers attached' }] })}\n${agree('addressed')}`
      if (call.agentId === 'beta' && call.phase === 'recheck' && call.round === 1) return agree('numbers ok')
      if (call.phase === 'synthesis') return `${env({ decisions: [`R${call.round}共识`] })}\n${agree()}`
      if (call.phase === 'forced') return env()
      if (call.agentId === 'beta' && call.phase === 'confirm' && call.round === 1) return disagree('want revisions first')
      return agree()
    }
  })
  const resultL = await l.controller.start(l.meeting.id)
  check(resultL.ok && resultL.meeting?.status === 'concluded' && resultL.meeting.round === 2 && resultL.meeting.minutes.length === 2, 'the meeting reaches and settles round 2')
  const defenseTurnL = l.store.turns(l.meeting.id).find((turn) => turn.phase === 'defense' && turn.round === 1)
  const defenseDetailL = defenseTurnL ? l.store.getTurn(l.meeting.id, defenseTurnL.id) : null
  check(!!defenseDetailL && defenseDetailL.body?.startsWith(defenseBodyL) && defenseDetailL.summary.length <= 500 && !defenseDetailL.summary.includes('TAIL_OF_DEFENSE_答辩尾部完整'), 'the defense body is stored in full while its index summary stays truncated')
  const round2Report = l.calls.find((call) => call.phase === 'report' && call.round === 2)
  check(!!round2Report && round2Report.content.includes(defenseBodyL) && round2Report.content.includes('TAIL_OF_DEFENSE_答辩尾部完整'), 'the round-2 reporter packet embeds the complete round-1 defense including its tail beyond 500 chars')
  check(!!round2Report && round2Report.content.includes('R1共识'), 'the round-2 packet also carries the round-1 minutes decisions')

  // ---------- 场景 M1：压缩旧历史有来源账本；保护内容不截断；仍超限显式失败 ----------
  scenario('compression ledger, protected content and explicit overflow failure')
  const storeM1 = new MeetingStore(path.join(temporary, 'm1-context'))
  const meetingM1 = storeM1.create({ issueId: 'iss_m1', topic: '压缩账本', participants: [{ agentId: 'alpha', role: 'reporter' }] })
  const phasesM1 = ['challenge', 'challenge', 'defense', 'challenge', 'report', 'challenge', 'synthesis', 'challenge', 'report', 'challenge', 'challenge', 'defense', 'report', 'synthesis']
  const bodiesM1 = []
  for (let index = 0; index < 14; index++) {
    const id = `turn_m1_${String(index).padStart(2, '0')}`
    const body = `M1第${index}段。` + '需要完整保留的讨论内容'.repeat(180)
    bodiesM1.push(body)
    storeM1.appendTurn({ id, meetingId: meetingM1.id, round: 1, phase: phasesM1[index], purpose: index === 10 ? 'chair' : 'speech', agentId: index === 10 ? 'user' : (index % 2 ? 'beta' : 'alpha'), officeTaskId: '', status: 'pending', speaker: { name: `成员${index}`, role: '队长', platform: `backend-${index % 3}` }, executionEpoch: 1 })
    storeM1.updateTurn(meetingM1.id, id, { status: 'done', publicVersion: index + 1, summary: body.slice(0, 100) }, body)
  }
  const objectionM1 = { id: 'obj_m1', text: '未决质疑正文', ref: 'doc:spec', raisedBy: 'beta', targetAgentId: 'alpha', priority: 'high', resolved: false, sourceTurnId: 'turn_m1_00', replyTurnId: 'turn_m1_02' }
  const draftM1 = { version: 'draft_v_m1', envelope: { decisions: ['M1共识'], objections: [], actionItems: [], openQuestions: [] } }
  const assembleM1 = (limit) => assembleMeetingContext(storeM1, meetingM1, [objectionM1], draftM1, limit)
  const originalLengthM1 = assembleM1(10_000_000).delivery.compression.originalLength
  const limitM1 = Math.ceil(originalLengthM1 * 0.8)
  const packed1 = assembleM1(limitM1)
  const packed2 = assembleM1(limitM1)
  check(packed1.text === packed2.text && packed1.delivery.publicVersion === packed2.delivery.publicVersion, 'compressed assembly is deterministic for the same snapshot')
  check(packed1.text.length <= limitM1 && packed1.delivery.compressions.length >= 1, 'history is compressed under the limit with a non-empty source ledger')
  const protectedIdsM1 = ['turn_m1_00', 'turn_m1_02', 'turn_m1_10', 'turn_m1_11', 'turn_m1_12', 'turn_m1_13']
  check(protectedIdsM1.every((id) => packed1.text.includes(bodiesM1[Number(id.slice(-2))])), 'chair note, unresolved-objection source/reply and latest report/defense/synthesis keep their full bodies')
  check(!packed1.delivery.compressions.some((entry) => protectedIdsM1.includes(entry.source)) && packed1.delivery.omittedTurnIds.every((id) => !protectedIdsM1.includes(id)), 'the ledger never lists a protected turn as compressed or omitted')
  check(packed1.text.includes('draft_v_m1') && packed1.text.includes('M1共识'), 'the pending-confirmation draft survives compression intact')
  check(packed1.delivery.chairTurnIds.includes('turn_m1_10') && packed1.delivery.publicVersion === 14, 'delivery metadata keeps the chair id and snapshot version')
  const ledgerEntryM1 = packed1.delivery.compressions[0]
  const ledgerBodyM1 = bodiesM1[Number(ledgerEntryM1.source.slice(-2))]
  check(ledgerEntryM1.originalLength === ledgerBodyM1.length && ledgerEntryM1.keptLength > 0 && ledgerEntryM1.keptLength < ledgerEntryM1.originalLength, 'ledger entries record true original and kept lengths')
  check(packed1.text.includes(ledgerBodyM1.slice(0, 256)) && packed1.text.includes(ledgerBodyM1.slice(-256)) && packed1.text.includes('[宿主摘录；完整原文按发言ID读取]'), 'compressed entries keep head+tail excerpts with a pointer to the full source, never a silent front-truncation')
  check(storeM1.getTurn(meetingM1.id, 'turn_m1_05').body === bodiesM1[5], 'compression never rewrites the authoritative stored body')
  let overflowM1 = null
  try { assembleM1(900) } catch (error) { overflowM1 = error }
  check(!!overflowM1 && /公共上下文超限/.test(overflowM1.message) && overflowM1.message.includes('turn_m1_10'), 'when protected content alone exceeds the limit the assembly fails loudly and names the protected turns')
  storeM1.appendTurn({ id: 'turn_m1_host_minutes', meetingId: meetingM1.id, round: 1, phase: 'synthesis', purpose: 'minutes', agentId: 'meeting', officeTaskId: '', status: 'pending' })
  storeM1.updateTurn(meetingM1.id, 'turn_m1_host_minutes', { status: 'done', publicVersion: 15 }, JSON.stringify(draftM1.envelope))
  const afterMinutesM1 = assembleM1(limitM1)
  check(afterMinutesM1.delivery.protectedTurnIds.includes('turn_m1_13'), 'publishing host minutes never displaces the latest formal synthesis from protection')
  check(afterMinutesM1.text.includes(bodiesM1[13]) && afterMinutesM1.delivery.sourceTurnIds.includes('turn_m1_host_minutes'), 'the next round can still receive full synthesis and the separate canonical minutes fact')
  check(!afterMinutesM1.delivery.compressions.some((entry) => entry.source === 'turn_m1_13') && !afterMinutesM1.delivery.omittedTurnIds.includes('turn_m1_13'), 'a later host minute cannot make the latest synthesis eligible for excerpting or omission')

  // ---------- 场景 M2：控制器上下文超限：显式失败，不发出请求 ----------
  scenario('controller-level context overflow fails explicitly before dispatch')
  const m2 = makeFixture('m2-overflow', { contextLimit: 8_000, respond: converged })
  m2.store.appendTurn({ id: 'turn_chair_big', meetingId: m2.meeting.id, round: 1, phase: 'challenge', purpose: 'chair', agentId: 'user', officeTaskId: '', status: 'pending', speaker: { name: '用户', role: '主席', platform: 'user' }, executionEpoch: 1 })
  m2.store.updateTurn(m2.meeting.id, 'turn_chair_big', { status: 'done', publicVersion: 1, summary: '超长用户要求' }, '用户要求正文。' + '必须完整保留的用户指示'.repeat(1700))
  const resultM2 = await m2.controller.start(m2.meeting.id)
  check(!resultM2.ok && resultM2.meeting?.status === 'failed' && /公共上下文超限/.test(resultM2.meeting?.blockedReason ?? ''), 'the meeting fails with an explicit overflow reason instead of silently truncating')
  check((resultM2.meeting?.blockedReason ?? '').includes('turn_chair_big'), 'the failure names the protected turn that could not be dropped')
  check(m2.sends.length === 0, 'no provider request was dispatched under an unsendable context')
  const failedTurnM2 = m2.store.turns(m2.meeting.id).find((turn) => turn.agentId === 'alpha')
  check(failedTurnM2?.status === 'failed' && failedTurnM2.deliveryState === 'failed', 'the blocked speech turn records the delivery failure')
  const failedDeliveryM2 = m2.store.getTurn(m2.meeting.id, failedTurnM2.id)?.delivery
  check(failedDeliveryM2?.publicVersion === 1 && failedDeliveryM2.sourceTurnIds.includes('turn_chair_big'), 'overflow keeps the actual attempted public version and source range')
  check(failedDeliveryM2?.protectedTurnIds.includes('turn_chair_big') && failedDeliveryM2.compression.originalLength > 8000, 'overflow persists the protected source and true input size audit')
  check(!failedDeliveryM2?.attempts?.length && !failedTurnM2.deliveredAt, 'blocked input never claims an actual dispatch')

  scenario('minutes revision invalidates earlier confirmations and returns the uniquely accepted draft')
  let revisedOnce = false
  const revision = makeFixture('n-minutes-revision', { respond: (call) => {
    if (call.phase === 'synthesis') return `${env({ decisions: ['old decision'] })}\n${agree()}`
    if (call.phase === 'confirm' && call.agentId === 'beta' && !revisedOnce) {
      revisedOnce = true
      return `${env({ decisions: ['new accepted decision'] })}\n${agree('revised')}`
    }
    return agree()
  } })
  const revisedResult = await revision.controller.start(revision.meeting.id)
  const revisedMinutes = revisedResult.meeting?.minutes[0]
  check(revisedResult.meeting?.status === 'concluded' && revisedMinutes?.decisions.join() === 'new accepted decision', 'host saves the revised draft instead of the previously confirmed old JSON')
  const revisionVotes = turnDetails(revision.store, revision.meeting.id).filter((turn) => turn.purpose === 'confirmation')
  const reporterVotes = revisionVotes.filter((turn) => turn.agentId === 'alpha')
  check(reporterVotes.length === 2 && reporterVotes[0].minutesVersion !== reporterVotes[1].minutesVersion, 'an earlier explicit reporter agree is invalidated and requested again after another member edits minutes')
  check(revisedMinutes.confirmations.length === 3 && revisedMinutes.confirmations.every((vote) => vote.minutesVersion === revisedMinutes.version && vote.verdict === 'agree'), 'all three final confirmations bind the same revised content version')
  check(revision.calls.some((call) => call.agentId === 'gamma' && call.phase === 'confirm' && call.content.includes('new accepted decision')), 'the original synthesizer also receives and confirms another member revised minutes')
  check(reporterVotes[0].body && reporterVotes[0].minutesVersion !== revisedMinutes.version, 'superseded confirmation remains an immutable audit record, not an overwritten bubble')

  scenario('failed send followed by successful resume records every attempt and the successful final turn')
  const reconnectDir = path.join(temporary, 'o-reconnect')
  const reconnectTasks = new TaskStore(reconnectDir)
  const reconnectService = new TaskService({ store: reconnectTasks })
  let failNextSend = true
  const backendTurns = []
  const reconnectBackend = {
    id: 'reconnect-fake', label: 'Reconnect fixture', supportsResume: true,
    async start({ prompt, events, turn, resumeSessionId }) {
      backendTurns.push({ turnId: turn.id, resume: !!resumeSessionId })
      const respond = (content, stamp) => {
        const text = content.includes('/综合轮】') ? `${env({ decisions: ['resumed consensus'] })}\n${agree()}` : agree('resumed')
        setTimeout(() => {
          events.onEvent({ kind: 'text', text: 'HOST_EXECUTION_AUDIT', execution: { runId: 'forged-run', turnId: 'forged-turn' } }, stamp)
          events.onTurnEnd({ ok: true, response: text }, stamp)
        }, 2)
      }
      respond(prompt, turn)
      return { sessionId: 'reconnect-provider-session', turnScoped: true,
        async send(content, stamp) {
          backendTurns.push({ turnId: stamp.id, resume: false })
          if (failNextSend) { failNextSend = false; throw new Error('EPIPE: broken pipe') }
          respond(content, stamp)
        }, async stop() {}, async close() {} }
    }
  }
  const reconnectAgents = [{ id: 'alpha', name: 'Alpha', backend: reconnectBackend.id, role: '队长' }, { id: 'gamma', name: 'Gamma', backend: reconnectBackend.id, role: '队长' }]
  const reconnectRunner = new TaskRunner(reconnectTasks, new Map([[reconnectBackend.id, reconnectBackend]]), () => ({ concurrency: 2, workerConcurrency: 2, mode: 'yolo', notify: false, maxRetryAttempts: 0 }))
  reconnectRunner.attachTeam(() => reconnectAgents)
  const reconnectOffices = new AgentSessionRegistry({ store: reconnectTasks, taskService: reconnectService, runner: reconnectRunner, getAgents: () => reconnectAgents, waitPollMs: 2 })
  const reconnectStore = new MeetingStore(reconnectDir)
  const reconnectController = new MeetingController({ store: reconnectStore, offices: reconnectOffices, getAgents: () => reconnectAgents, taskStore: reconnectTasks, issueExists: () => true, cancelTask: (taskId) => reconnectRunner.terminateTask(taskId) })
  reconnectRunner.attachMeetingGuard((task) => reconnectController.canRunTask(task))
  const reconnectMeeting = reconnectController.create({ issueId: 'iss_reconnect', topic: 'reconnect', maxRounds: 1, participants: [{ agentId: 'alpha', role: 'reporter' }, { agentId: 'gamma', role: 'designer' }] })
  try {
    const reconnectResult = await reconnectController.start(reconnectMeeting.id)
    const resumedSpeech = turnDetails(reconnectStore, reconnectMeeting.id).find((turn) => turn.phase === 'report')
    const attempts = resumedSpeech?.delivery?.attempts ?? []
    check(reconnectResult.meeting?.status === 'concluded' && resumedSpeech?.status === 'done', 'a dead provider connection can reconnect and still complete the same named speech')
    check(attempts.length === 2 && attempts[0].turnId !== attempts[1].turnId && attempts[0].runId === attempts[1].runId, 'delivery audit preserves both failed send and successful resume attempts under the same Run')
    check(resumedSpeech.executionTurnId === attempts.at(-1)?.turnId && backendTurns.some((entry) => entry.resume && entry.turnId === resumedSpeech.executionTurnId), 'formal body links the successful resumed execution turn, never just the failed first attempt')
    check(attempts.every((attempt) => attempt.taskId === resumedSpeech.sessionTaskId && Number.isFinite(attempt.dispatchedAt)), 'every dispatch attempt carries exact member-task and timestamp provenance')
    const executionEvents = reconnectTasks.readEvents(resumedSpeech.sessionTaskId).filter((event) => event.text === 'HOST_EXECUTION_AUDIT')
    check(executionEvents.length > 1 && executionEvents.every((event) => event.execution?.runId && event.execution.runId !== 'forged-run' && backendTurns.some((turn) => turn.turnId === event.execution?.turnId)), 'runner overwrites forged backend execution stamps with immutable host Run/Turn identities')
    const speechEvents = executionEvents.filter((event) => event.execution?.turnId === resumedSpeech.executionTurnId)
    check(speechEvents.length === 1 && speechEvents[0].execution.runId === resumedSpeech.runId && executionEvents.some((event) => event.execution.turnId !== resumedSpeech.executionTurnId), 'reconnected speech logs remain precisely scoped apart from warmup and other turns')
  } finally {
    reconnectOffices.dispose()
    await reconnectRunner.shutdown()
  }

  if (process.exitCode) {
    console.log(`\nFAILED meeting public smoke: ${failures.length}/${total} checks failed`)
    for (const failure of failures) console.log(`  - ${failure}`)
    process.exit(1)
  }
  console.log(`\n✅ MEETING PUBLIC SMOKE PASSED: ${total} checks`)
} finally {
  const cleanupPath = path.resolve(temporary)
  if (path.dirname(cleanupPath) !== path.resolve(os.tmpdir()) || !path.basename(cleanupPath).startsWith('agentdeck-meeting-public-')) throw new Error('unsafe temporary cleanup path')
  fs.rmSync(cleanupPath, { recursive: true, force: true })
}
