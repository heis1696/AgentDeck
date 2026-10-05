import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-office-bundles-'))
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-office-data-'))
const bundle = async (source, name) => {
  const outfile = path.join(bundleDir, name)
  await build({ entryPoints: [path.join(root, source)], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['electron'] })
  return import(pathToFileURL(outfile).href)
}

const [{ AgentSessionRegistry, OFFICE_TASK_KEY_V2_PREFIX, officeMeetingTaskKeyCandidates }, { TaskStore }, { TaskService }, { TaskRunner }] = await Promise.all([
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
const expectReject = async (promise, label, needle = '取消') => {
  try {
    await promise
    check(false, `${label}（预期被拒绝，但正常返回了）`)
  } catch (error) {
    check(String(error).includes(needle), label)
  }
}
const waitUntil = async (predicate, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitUntil 超时')
    await sleep(5)
  }
}

let sends = 0
let starts = 0
let activeSends = 0
let maxActiveSends = 0
let serial = 0
let notifications = 0
const startLog = []          // 每次 backend.start 的工作目录与会话 id（会话/目录隔离断言用）
const followUpOptsLog = []   // runner 收到的回合协议键（内部范围不得透传断言用）
let bootstrapHold = null     // { promise, resolve }：暂扣下一次 bootstrap 首回合（取消传播断言用）
const holdNextBootstrap = () => {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  bootstrapHold = { promise, resolve }
  return () => resolve()
}
const backend = {
  id: 'fake-office',
  label: 'Fake office',
  supportsResume: true, // 对齐真实适配器：恢复能力声明
  async probe() { return { ok: true, detail: 'fake' } },
  async start({ workdir, events, turn }) {
    starts++
    const sessionId = `office-session-${starts}`
    startLog.push({ workdir, sessionId })
    if (bootstrapHold) {
      const held = bootstrapHold
      bootstrapHold = null
      await held.promise
    }
    // 复用门禁（hot.7/hot.8）要求会话声明 turnScoped 且回调带回合戳，
    // 否则追问一律走 resume 重建而不是同连接 send——fixture 必须跟上契约。
    const finish = (text, stamp) => {
      events.onEvent({ ts: Date.now(), kind: 'final', text }, stamp)
      events.onTurnEnd({ ok: true, response: text }, stamp)
    }
    setTimeout(() => finish('office-ready', turn), 5)
    return {
      sessionId,
      turnScoped: true,
      async send(_content, nextTurn) {
        sends++
        activeSends++
        maxActiveSends = Math.max(maxActiveSends, activeSends)
        const n = ++serial
        await sleep(25)
        activeSends--
        finish(`reply-${n}`, nextTurn)
      },
      async stop() {},
      async close() {}
    }
  }
}

const store = new TaskStore(dataDir)
const service = new TaskService({ store })
const runner = new TaskRunner(store, new Map([[backend.id, backend]]), () => ({ concurrency: 2, workerConcurrency: 2, mode: 'yolo', notify: true }), undefined, { notify: () => { notifications++ } })
const agents = [
  { id: 'leader', name: 'Leader', backend: backend.id, role: '队长', systemPrompt: '负责协调。' },
  { id: 'dsh', name: 'DeepSeek', backend: 'dsh' }
]
runner.attachTeam(() => agents)

// 注册表拿到的是 runner 代理：记录它传给 runner 回合协议的键，
// meetingId/workdir/signal 这类内部范围漏进协议即失败。
const runnerProxy = {
  enqueue: (task) => runner.enqueue(task),
  followUp: (taskId, content, opts) => {
    followUpOptsLog.push(Object.keys(opts ?? {}).sort())
    return runner.followUp(taskId, content, opts)
  }
}

const registry = new AgentSessionRegistry({ store, taskService: service, runner: runnerProxy, getAgents: () => agents, waitPollMs: 5, waitTimeoutMs: 2_000 })
const first = await registry.ensure('leader')
check(first.status === 'done', 'office task bootstrap reaches done')
// 断言键的**归属**（该队长的键空间）而不是字面串：键形是实现细节，语义是「一位队长一张长期单」
check(first.suppressIssue === true && first.dedupeKey === OFFICE_TASK_KEY_V2_PREFIX + 'leader', 'office task is suppressed and durably deduped')

const again = await registry.ensure('leader')
check(again.id === first.id, 'repeated ensure reuses one office task')

const [a, b] = await Promise.all([registry.followUp('leader', 'one'), registry.followUp('leader', 'two')])
check(a.ok && b.ok, 'concurrent office follow-ups both complete')
check(maxActiveSends === 1, 'same-agent office follow-ups are serialized')
check(starts === 1 && sends === 2, 'one bootstrap start plus two follow-up sends')
check(notifications === 0, 'suppressIssue office task emits no notifications')

const restartedStore = new TaskStore(dataDir)
const restartedRegistry = new AgentSessionRegistry({ store: restartedStore, taskService: new TaskService({ store: restartedStore }), runner, getAgents: () => agents, waitPollMs: 5, waitTimeoutMs: 100 })
// The durable lookup check uses a fresh service/store pair; no new task should be created.
const persisted = restartedRegistry.get('leader')
check(persisted?.id === first.id, 'office mapping survives registry/store restart')

try {
  await registry.ensure('dsh')
  check(false, 'DSH office enrollment is rejected')
} catch (error) {
  check(String(error).includes('DeepSeek'), 'DSH office enrollment is rejected')
}

// ===== 阶段1：会议成员会话隔离 =====
const workdirOf = (name) => {
  const dir = path.join(dataDir, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
const workdirA = workdirOf('meeting-a')
const workdirB = workdirOf('meeting-b')

const memberA = await registry.ensure('leader', { meetingId: 'mtg_AAA', workdir: workdirA })
check(memberA.status === 'done', 'meeting member session bootstrap reaches done')
check(memberA.id !== first.id, 'meeting member session is not the shared office task')
check(memberA.meetingId === 'mtg_AAA' && memberA.meetingTaskRole === 'member', 'member task carries meeting scope and member role')
check(memberA.suppressIssue === true && memberA.officeAgentId === 'leader', 'member task stays suppressed and keeps the office protocol marker')
check(!memberA.parentTaskId, 'member task has no parentTaskId (meeting ownership decoupled from execution parentage)')
check(memberA.workdir === workdirA, 'member task is bound to its meeting workdir')
check(memberA.dedupeKey === officeMeetingTaskKeyCandidates('mtg_AAA', 'leader')[0], 'member task key carries meeting and member identity')

const memberA2 = await registry.ensure('leader', { meetingId: 'mtg_AAA', workdir: workdirA })
check(memberA2.id === memberA.id, 'repeated ensure reuses one member task per meeting+agent')

const memberB = await registry.ensure('leader', { meetingId: 'mtg_BBB', workdir: workdirB })
check(memberB.id !== memberA.id && memberB.id !== first.id, 'a second meeting gets its own member session')
check(memberB.meetingId === 'mtg_BBB' && memberB.workdir === workdirB, 'the second meeting keeps its own scope and workdir')

// 会话与目录互不串：三个范围各一次独立 bootstrap，会话 id 与工作目录一一对应
check(new Set([first.sessionId, memberA.sessionId, memberB.sessionId]).size === 3, 'office and both meetings run on distinct backend sessions')
check(starts === 3 && startLog.filter((e) => e.workdir === workdirA).length === 1 && startLog.filter((e) => e.workdir === workdirB).length === 1, 'each scope bootstrapped exactly once in its own workdir')

// 查询边界：办公室查询绝不能返回会议成员会话；会议查询只认自己的成员会话
check(registry.get('leader')?.id === first.id, 'ordinary office lookup never returns a meeting member session')
check(registry.get('leader', 'mtg_AAA')?.id === memberA.id && registry.get('leader', 'mtg_BBB')?.id === memberB.id, 'meeting-scoped lookup returns that meeting\'s own member session')
check(registry.get('leader', 'mtg_MISSING') === null, 'lookup for an unknown meeting returns null')

// 回合路由：taskId 回执指明发言落在哪张会话上
const consultReply = await registry.followUp('leader', '咨询', { collectFinal: true })
const replyA = await registry.followUp('leader', '会议A发言', { meetingId: 'mtg_AAA', collectFinal: true })
const replyB = await registry.followUp('leader', '会议B发言', { meetingId: 'mtg_BBB', collectFinal: true })
check(consultReply.ok && consultReply.taskId === first.id, 'office follow-up lands on the shared office task')
check(replyA.ok && replyA.taskId === memberA.id, 'meeting A follow-up lands on meeting A session')
check(replyB.ok && replyB.taskId === memberB.id, 'meeting B follow-up lands on meeting B session')

// 内部范围绝不透传给 runner 回合协议
const allowedProtocolKeys = new Set(['collectFinal', 'consultDepth', 'meetingTurn'])
check(followUpOptsLog.length >= 5 && followUpOptsLog.every((keys) => keys.every((k) => allowedProtocolKeys.has(k))), 'runner protocol only ever sees turn options (no meetingId/workdir/signal)')

// ===== 占键防伪：用户任务抢注会议成员键，注册表必须绕开并另建 =====
const occKey = officeMeetingTaskKeyCandidates('mtg_OCC', 'leader')[0]
const squatter = service.createTask({ title: '抢键用户任务', prompt: '干活', backend: backend.id, agentId: 'leader', requestId: occKey, startNow: false })
check(service.deduped(occKey)?.id === squatter.id, '占键前提成立：用户任务确实抢注了会议成员键')
check(registry.get('leader', 'mtg_OCC') === null, 'occupied meeting key is never returned as a member session')
const occupied = await registry.ensure('leader', { meetingId: 'mtg_OCC' })
check(occupied.id !== squatter.id, 'ensure does not reuse the squatter record')
check(occupied.dedupeKey === officeMeetingTaskKeyCandidates('mtg_OCC', 'leader')[1], 'ensure falls back to the next free key candidate')
check(occupied.meetingTaskRole === 'member' && occupied.officeAgentId === 'leader' && occupied.status === 'done', 'the fallback session is a genuine, bootstrapped member session')
const squatterNow = store.get(squatter.id)
check(squatterNow?.officeAgentId === undefined && squatterNow?.meetingId === undefined && squatterNow?.dedupeKey === occKey, 'squatter record left untouched (no officeAgentId/meetingId written, key kept)')
check(registry.get('leader', 'mtg_OCC')?.id === occupied.id, 'member session at the fallback key is reusable via meeting lookup')

// ===== 取消传播：排队、bootstrap、回合前后的 AbortSignal =====
// ① 预先中止：建单/入队/发送什么都不发生
const preAborted = new AbortController()
preAborted.abort()
const preCounts = { starts, sends }
await expectReject(registry.ensure('leader', { meetingId: 'mtg_PRE', signal: preAborted.signal }), 'pre-aborted ensure rejects without doing anything')
await expectReject(registry.followUp('leader', 'x', { meetingId: 'mtg_PRE', signal: preAborted.signal }), 'pre-aborted follow-up rejects immediately')
check(starts === preCounts.starts && sends === preCounts.sends && !store.list().some((t) => t.meetingId === 'mtg_PRE'), 'pre-aborted requests create and send nothing')

// ② bootstrap 首回合等待期间中止：不发后续回合，取消不能恢复会话
const workdirC = workdirOf('meeting-cancel')
const releaseBootstrap = holdNextBootstrap()
const abortInBootstrap = new AbortController()
const pendingTurn = registry.followUp('leader', '会被取消的发言', { meetingId: 'mtg_CANCEL', workdir: workdirC, signal: abortInBootstrap.signal })
await waitUntil(() => startLog.some((e) => e.workdir === workdirC))
abortInBootstrap.abort()
await expectReject(pendingTurn, 'abort during bootstrap wait rejects the turn without sending')
const sendsAtAbort = sends
releaseBootstrap()
await waitUntil(() => store.list().find((t) => t.meetingId === 'mtg_CANCEL')?.status === 'done')
check(sends === sendsAtAbort, 'cancelled turn never sends after bootstrap (no accidental session resume)')
const resumed = await registry.followUp('leader', '重新发言', { meetingId: 'mtg_CANCEL' })
check(resumed.ok && resumed.taskId === store.list().find((t) => t.meetingId === 'mtg_CANCEL')?.id, 'only an explicit new request resumes the session after cancel')

// ③ 排队取锁期间中止：轮到它时直接取消，不发送，也不卡死会话锁
const busy = registry.followUp('leader', '占锁回合', { meetingId: 'mtg_OCC' })
const abortInQueue = new AbortController()
const queuedTurn = registry.followUp('leader', '排队后被取消', { meetingId: 'mtg_OCC', signal: abortInQueue.signal })
abortInQueue.abort()
await expectReject(queuedTurn, 'abort while queued on the session lock rejects without sending')
check((await busy).ok, 'the turn holding the lock completes normally')
check((await registry.followUp('leader', '取消后的新回合', { meetingId: 'mtg_OCC' })).ok, 'session lock is not stuck after a queued cancellation')

// ④ 发送期间中止：晚到的成功不作数（取消后的旧结果不能成为有效发言）
const abortInFlight = new AbortController()
const sendsBeforeFlight = sends
const inFlightTurn = registry.followUp('leader', '发送期间取消', { meetingId: 'mtg_AAA', signal: abortInFlight.signal })
await waitUntil(() => sends >= sendsBeforeFlight + 1)
abortInFlight.abort()
await expectReject(inFlightTurn, 'abort during an in-flight send discards the result')

// 持久化：会议成员映射与办公室一样跨重启可查
const persistedMember = restartedRegistry.get('leader', 'mtg_AAA')
check(persistedMember?.id === memberA.id, 'meeting member mapping survives registry/store restart')

check(notifications === 0, 'suppressed office and member tasks emit no notifications')

console.log('--- member bootstrap failure re-bootstraps instead of bricking the session ---')
{
  // 审码判官 P1：成员首回合在 sessionId 落库前失败 → ensure 把终态单当已完成初始化 →
  // followUp 被「无会话可恢复」永久拒绝，会议重试永远起不来。修复：终态且无 sessionId
  // 的会话单重新引导（同任务身份、新会话）；有 sessionId 的终态单绝不走重建路径。
  let bootFails = true
  let bootStarts = 0
  const bootBackend = {
    id: 'fake-boot',
    label: 'Fake boot',
    supportsResume: true,
    async probe() { return { ok: true, detail: 'fake' } },
    async start({ events, turn }) {
      bootStarts++
      if (bootFails) throw new Error('bootstrap backend down')
      setTimeout(() => {
        events.onEvent({ ts: Date.now(), kind: 'final', text: 'boot-ready' }, turn)
        events.onTurnEnd({ ok: true, response: 'boot-ready' }, turn)
      }, 5)
      return {
        sessionId: `boot-session-${bootStarts}`,
        turnScoped: true,
        async send(_content, nextTurn) {
          events.onEvent({ ts: Date.now(), kind: 'final', text: 'boot-reply' }, nextTurn)
          events.onTurnEnd({ ok: true, response: 'boot-reply' }, nextTurn)
        },
        async stop() {},
        async close() {}
      }
    }
  }
  const bootRunner = new TaskRunner(store, new Map([[bootBackend.id, bootBackend]]), () => ({ concurrency: 1, workerConcurrency: 1, mode: 'yolo', notify: false }))
  const bootAgents = [{ id: 'booter', name: 'Booter', backend: bootBackend.id, role: '队长' }]
  const bootRegistry = new AgentSessionRegistry({ store, taskService: service, runner: bootRunner, getAgents: () => bootAgents, waitPollMs: 5, waitTimeoutMs: 5_000 })
  const failed = await bootRegistry.ensure('booter', { meetingId: 'mtg_BOOT' })
  check(failed.status === 'failed' && !failed.sessionId, 'failed bootstrap leaves a terminal member task without a session')
  bootFails = false
  const recovered = await bootRegistry.ensure('booter', { meetingId: 'mtg_BOOT' })
  check(bootStarts === 2 && recovered.status === 'done' && !!recovered.sessionId, 'terminal member without a session re-bootstraps on the next ensure')
  const spoke = await bootRegistry.followUp('booter', '重建后的发言', { meetingId: 'mtg_BOOT', collectFinal: true })
  check(spoke.ok && spoke.finalText === 'boot-reply', 'follow-up works after the re-bootstrap')
  await bootRunner.shutdown()
}

await runner.shutdown()
if (process.exitCode) process.exit(1)
console.log('\n✅ MEETING OFFICE SMOKE PASSED')
