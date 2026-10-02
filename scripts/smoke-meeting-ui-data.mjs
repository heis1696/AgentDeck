import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(import.meta.dirname, '..')
const outfile = path.join(root, 'out/smoke-meeting-ui-data.cjs')
await build({
  stdin: { contents: [
    "export * from './src/renderer/src/hooks/meetingTurnsController'",
    "export * from './src/renderer/src/components/meeting/meetingViewState'"
  ].join('\n'), resolveDir: root, loader: 'ts' },
  outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent'
})
const { MeetingTurnsController, mergeMeetingTurns, meetingRootId, meetingPresentation, meetingForNavigation, meetingNavigationCatalog, currentMeetingSpeech } = await import(pathToFileURL(outfile).href)
let passed = 0
const check = (title, verify) => { verify(); passed++; console.log(`PASS ${title}`) }
const turn = (id, sequence, version, body = id) => ({ id, sequence, version, body, meetingId: 'meeting_data', agentId: 'agent_a', phase: 'report', round: 1, status: 'done', officeTaskId: 'member_a', purpose: 'speech' })
const pages = []
const calls = []
const source = { readTurns: async (id, query) => { calls.push({ id, query }); const next = pages.shift(); if (next instanceof Error) throw next; if (!next) throw new Error('Unexpected read'); return typeof next === 'function' ? next() : next } }
const page = (turns, latestVersion, extra = {}) => ({ meetingId: 'meeting_data', turns, latestVersion, hasMore: false, ...extra })
const updates = []
const controller = new MeetingTurnsController('meeting_data', source, (snapshot) => updates.push(snapshot))
pages.push(page([turn('old_a', 0, 0)], 2, { hasMore: true, nextCursor: 'second' }), page([turn('current', 4, 2)], 2))
await controller.refresh()
check('初次全量分页保留历史版本零正文', () => assert.deepEqual(controller.getSnapshot().turns.map((item) => item.id), ['old_a', 'current']))
check('初始分页无任何版本或序号下界', () => {
  assert.equal(calls.length, 2)
  assert.equal(calls[1].query.cursor, 'second')
  assert.ok(calls.every(({ query }) => query.afterVersion === undefined && query.afterSequence === undefined))
})
check('全量完成后才提交固定水位', () => {
  assert.equal(controller.getSnapshot().latestVersion, 2)
  assert.ok(!updates.some((snapshot) => snapshot.turns.length === 1))
})
pages.push(page([turn('old_a', 0, 3, 'updated old body')], 3))
await controller.refresh()
check('旧序号更新按稳定 ID 覆盖不重复追加', () => {
  assert.equal(controller.getSnapshot().turns.length, 2)
  assert.equal(controller.getSnapshot().turns[0].body, 'updated old body')
})
check('增量不能携带旧序号下界', () => {
  assert.equal(calls.at(-1).query.afterVersion, 2)
  assert.ok(!Object.hasOwn(calls.at(-1).query, 'afterSequence'))
})
check('晚到的低版本发言不能覆盖高版本正文', () => assert.equal(mergeMeetingTurns(controller.getSnapshot().turns, [turn('old_a', 0, 1, 'stale')])[0].body, 'updated old body'))
pages.push(page([turn('partial', 5, 4)], 4, { hasMore: true, nextCursor: 'broken' }), new Error('second page failed'))
await controller.refresh()
check('后页失败保留原记录和水位而非半份快照', () => {
  assert.equal(controller.getSnapshot().latestVersion, 3)
  assert.equal(controller.getSnapshot().turns.length, 2)
  assert.equal(controller.getSnapshot().error, 'second page failed')
})
pages.push(page([turn('retry', 5, 4)], 4))
await controller.refresh()
check('失败后的重试仍从成功水位开始', () => {
  assert.equal(calls.at(-1).query.afterVersion, 3)
  assert.equal(controller.getSnapshot().latestVersion, 4)
  assert.equal(controller.getSnapshot().error, null)
})
let release
pages.push(() => new Promise((resolve) => { release = resolve }), page([turn('late', 6, 6)], 6))
const first = controller.refresh()
await Promise.resolve()
const queued = controller.refresh()
release(page([], 5))
await Promise.all([first, queued])
check('在途更新合并为后续增量不会丢失', () => {
  assert.equal(controller.getSnapshot().latestVersion, 6)
  assert.equal(calls.at(-1).query.afterVersion, 5)
  assert.ok(controller.getSnapshot().turns.some((item) => item.id === 'late'))
})
pages.push(page([turn('wrong', 7, 7)], 7, { meetingId: 'other_meeting' }))
await controller.refresh()
check('跨会议分页拒绝且保留旧水位', () => {
  assert.equal(controller.getSnapshot().latestVersion, 6)
  assert.ok(controller.getSnapshot().error.includes('当前会议'))
})
pages.push(page([], 7, { hasMore: true }))
await controller.refresh()
check('缺少后续游标不能冒充全量完成', () => assert.ok(controller.getSnapshot().error.includes('游标')))
pages.push(page([], 7, { hasMore: true, nextCursor: 'same' }), page([], 7, { hasMore: true, nextCursor: 'same' }))
await controller.refresh()
check('重复游标有界失败不无限翻页', () => assert.ok(controller.getSnapshot().error.includes('重复')))
pages.push(page([], 7, { hasMore: true, nextCursor: 'drifting' }), page([], 8))
await controller.refresh()
check('分页水位漂移不落地', () => assert.ok(controller.getSnapshot().error.includes('水位发生变化')))
pages.push(page([], 5))
await controller.refresh()
check('成功水位不能回退', () => assert.ok(controller.getSnapshot().error.includes('不能回退')))
pages.push(() => new Promise((resolve) => { release = resolve }))
const disposedRead = controller.refresh()
await Promise.resolve()
const beforeDispose = updates.length
controller.dispose()
release(page([turn('disposed', 8, 9)], 9))
await disposedRead
check('卸载后的迟到结果不通知组件也不复活记录', () => {
  assert.equal(updates.length, beforeDispose)
  assert.equal(controller.getSnapshot().latestVersion, 6)
})
const meeting = { id: 'meeting_data', issueId: 'issue_data', containerTaskId: 'container', ownsIssue: true, status: 'active', participants: [], currentTurn: { agentId: 'agent_a' }, createdAt: 1, updatedAt: 1 }
const tasks = [{ id: 'container', issueId: 'issue_data', meetingId: meeting.id, meetingTaskRole: 'container' }, { id: 'member_a', meetingId: meeting.id, meetingTaskRole: 'member' }, { id: 'office_independent', officeAgentId: 'agent_a' }]
check('容器、Issue 与稳定会议标识进入同一会议', () => {
  for (const id of ['container', 'issue_data', meetingRootId(meeting.id), meeting.id]) assert.equal(meetingForNavigation(id, tasks, [meeting]), meeting)
})
check('缺少容器任务仍按稳定 Issue 查看会议', () => assert.equal(meetingForNavigation('issue_data', [], [meeting]), meeting))
check('普通 Issue 中附加的非专属会议不劫持原任务页', () => assert.equal(meetingForNavigation('container', [{ id: 'container', issueId: 'issue_data' }], [{ ...meeting, ownsIssue: false }]), null))
check('独立咨询办公室不归入会议导航', () => assert.equal(meetingNavigationCatalog(tasks, [meeting], []).find((item) => item.id === 'office_independent').viewRootId, undefined))
check('会议内部执行在导航目录中隐藏但保留其可观测记录', () => {
  const member = meetingNavigationCatalog(tasks, [meeting], []).find((item) => item.id === 'member_a')
  assert.equal(member.hidden, true)
  assert.equal(member.viewRootId, meetingRootId(meeting.id))
})
check('停止失败优先于容器取消终态', () => assert.equal(meetingPresentation({ ...meeting, status: 'cancelled', stopState: 'failed' }).label, '停止受阻'))
check('停止中不显示停止成功', () => assert.equal(meetingPresentation({ ...meeting, status: 'cancelled', stopState: 'stopping' }).label, '正在停止'))
check('旧历史取消不伪造整场退出证明', () => assert.equal(meetingPresentation({ ...meeting, status: 'cancelled' }).label, '历史已取消'))
check('只有正式在途发言才能驱动跟随', () => {
  const speech = { ...turn('speaking', 9, 9), status: 'speaking' }
  assert.equal(currentMeetingSpeech(meeting, [speech]), speech)
  assert.equal(currentMeetingSpeech(meeting, [{ ...speech, purpose: 'chair' }]), null)
  assert.equal(currentMeetingSpeech({ ...meeting, stopState: 'stopping' }, [speech]), null)
})
console.log(`MEETING UI DATA SMOKE PASSED: ${passed} checks`)
