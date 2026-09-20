import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(import.meta.dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-board-retention-'))
const now = Date.now()
const DAY = 86_400_000
let store
try {
  for (const [source, name] of [['src/main/store.ts', 'store'], ['src/main/issue-store.ts', 'issues'], ['src/main/task-service.ts', 'service'], ['src/main/retention.ts', 'retention'], ['src/main/event-log.ts', 'log'], ['src/renderer/src/components/BoardView.tsx', 'board']]) {
    await build({ entryPoints: [path.join(root, source)], outfile: path.join(temp, `${name}.cjs`), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
  }
  globalThis.window = { agentdeck: {} }
  const load = (name) => import(pathToFileURL(path.join(temp, `${name}.cjs`)).href)
  const [{ TaskStore }, { IssueStore }, { TaskService }, { sweepExpiredIssues }, { EventLog }, board] = await Promise.all(['store', 'issues', 'service', 'retention', 'log', 'board'].map(load))
  const data = path.join(temp, 'data')
  store = new TaskStore(data)
  const fixtureIssues = new IssueStore(data)
  const fresh = new Set()
  const make = (title, status = 'done', options = {}) => {
    const { age = 40, ...fields } = options
    const task = store.create({ title, prompt: title, backend: 'fake', workdir: '', ...fields })
    store.update(task.id, { status, createdAt: now - age * DAY, startedAt: now - age * DAY, endedAt: status === 'done' || status === 'failed' || status === 'cancelled' ? now - age * DAY + 1000 : undefined })
    if (age < 30) fresh.add(fields.issueId ?? `iss_${task.id}`)
    store.appendEvent(task.id, { ts: now - age * DAY, kind: 'status', text: title })
    return store.get(task.id)
  }
  const expired = make('expired done')
  const failed = make('expired failed', 'failed')
  const cancelled = make('expired cancelled', 'cancelled')
  const running = make('old running', 'running')
  const parked = make('old parked', 'queued', { parked: true })
  const queued = make('old queued', 'queued')
  const recent = make('recent done', 'done', { age: 2 })
  const orphan = make('run-only orphan', 'done', { suppressIssue: true, parentTaskId: 'missing-parent' })
  const freshOrphan = make('fresh orphan worker', 'done', { age: 1, parentTaskId: 'missing-parent' })
  const activeGoal = make('protected goal')
  const activeMeeting = make('protected meeting')
  const leader = make('expired leader')
  const child = make('expired child', 'done', { parentTaskId: leader.id })
  const grandchild = make('expired grandchild', 'failed', { parentTaskId: child.id })
  const blockedLeader = make('leader with running child')
  const busyChild = make('running child', 'running', { parentTaskId: blockedLeader.id })
  const freshLeader = make('leader with fresh child')
  const freshChild = make('fresh child', 'done', { parentTaskId: freshLeader.id, age: 2 })
  const protectedLeader = make('leader with protected child')
  const protectedChild = make('goal child', 'done', { parentTaskId: protectedLeader.id })
  const sharedDone = make('shared old done', 'done', { issueId: 'iss_shared' })
  const sharedParked = make('shared parked', 'queued', { issueId: 'iss_shared', parked: true })
  const race = make('changes during forget')
  // Run-only descendants (suppressIssue: automation output / investigation
  // workers) never get an Issue projection, so ownership plus the parentTaskId
  // cascade is the only paper trail retention can follow.
  const runOnlyLeader = make('expired run-only leader')
  const runOnlyWorker = make('expired run-only worker', 'done', { suppressIssue: true, parentTaskId: runOnlyLeader.id })
  const runOnlyHelper = make('expired run-only helper', 'failed', { suppressIssue: true, parentTaskId: runOnlyWorker.id })
  const freshRunOnlyLeader = make('leader with fresh run-only child')
  const freshRunOnlyChild = make('fresh run-only child', 'done', { age: 2, suppressIssue: true, parentTaskId: freshRunOnlyLeader.id })
  const busyRunOnlyLeader = make('leader with running run-only child')
  const busyRunOnlyChild = make('running run-only child', 'running', { suppressIssue: true, parentTaskId: busyRunOnlyLeader.id })
  const goalRunOnlyLeader = make('leader with goal-protected run-only child')
  const goalRunOnlyChild = make('goal-protected run-only child', 'done', { suppressIssue: true, parentTaskId: goalRunOnlyLeader.id })
  const meetingRunOnlyLeader = make('leader with meeting-protected run-only child')
  const meetingRunOnlyChild = make('meeting-protected run-only child', 'failed', { suppressIssue: true, parentTaskId: meetingRunOnlyLeader.id })
  const runOnlyRoot = make('run-only automation root', 'done', { suppressIssue: true })
  fixtureIssues.sync(store.list())
  fixtureIssues.addComment(`iss_${expired.id}`, 'old comment')
  store.flush()
  const issueFile = path.join(data, 'issues', 'index.json')
  const persisted = JSON.parse(fs.readFileSync(issueFile, 'utf8'))
  for (const issue of persisted.issues) issue.updatedAt = now - (fresh.has(issue.id) ? 2 : 40) * DAY
  fs.writeFileSync(issueFile, JSON.stringify(persisted))
  const issues = new IssueStore(data)
  const service = new TaskService({ store, issueStore: issues })
  const forgotten = []
  const published = []
  const logFile = path.join(data, 'issues', 'retention.jsonl')
  const deps = {
    store, issueStore: issues, taskService: service, now: () => now,
    activeGoalIssueIds: () => new Set([`iss_${activeGoal.id}`, `iss_${protectedChild.id}`, `iss_${goalRunOnlyLeader.id}`]),
    activeMeetingIssueIds: () => new Set([`iss_${activeMeeting.id}`, `iss_${meetingRunOnlyLeader.id}`]),
    forget: async (id) => { forgotten.push(id); if (id === race.id) store.update(id, { status: 'running' }) },
    onTaskDeleted: (id) => published.push(id), eventLog: new EventLog(logFile)
  }
  const report = await sweepExpiredIssues(deps)
  for (const task of [expired, failed, cancelled, leader, child, grandchild]) {
    assert.equal(store.get(task.id), undefined, `${task.title} deleted`)
    assert.equal(issues.get(`iss_${task.id}`), undefined, 'projection removed')
    assert.equal(fs.existsSync(path.join(data, 'tasks', task.id)), false, 'task directory and events removed')
    assert.ok(forgotten.includes(task.id) && published.includes(task.id), 'runner cleanup and deletion notification')
  }
  // 无 Issue 的 run-only 子孙本身没有保留时钟：只有「明确挂在父任务下 + 自身也过期 + 终态」
  // 才随父级联一起清理；清理它们要连目录、runner 状态、删除通知与 Issue 一起收口。
  for (const task of [runOnlyLeader, runOnlyWorker, runOnlyHelper]) {
    assert.equal(store.get(task.id), undefined, `${task.title} deleted with its parent cascade`)
    assert.equal(fs.existsSync(path.join(data, 'tasks', task.id)), false, 'run-only task directory and events removed')
    assert.ok(forgotten.includes(task.id) && published.includes(task.id), 'run-only runner cleanup and deletion notification')
  }
  assert.equal(issues.get(`iss_${runOnlyLeader.id}`), undefined, 'cascade owner Issue removed with its run-only descendants')
  assert.equal(issues.get(`iss_${runOnlyWorker.id}`), undefined, 'run-only descendants project no Issue')
  for (const task of [running, parked, queued, recent, orphan, freshOrphan, activeGoal, activeMeeting, blockedLeader, busyChild, freshLeader, freshChild, protectedLeader, protectedChild, sharedDone, sharedParked, race, freshRunOnlyLeader, freshRunOnlyChild, busyRunOnlyLeader, busyRunOnlyChild, goalRunOnlyLeader, goalRunOnlyChild, meetingRunOnlyLeader, meetingRunOnlyChild, runOnlyRoot]) assert.ok(store.get(task.id), `${task.title} preserved`)
  assert.equal(report.deletedTasks, 9, 'six Issue cards plus three run-only descendants')
  assert.equal(report.deletedIssues, 7, 'run-only descendants contribute no Issue')
  assert.ok(report.deletedComments > 0 && report.deletedRuns > 0)
  assert.deepEqual(issues.comments(`iss_${expired.id}`), [])
  assert.deepEqual(issues.runs(`iss_${expired.id}`), [])
  issues.sync(store.list())
  assert.equal(issues.get(`iss_${expired.id}`), undefined, 'sync does not resurrect Issue')
  assert.equal(new IssueStore(data).get(`iss_${expired.id}`), undefined, 'deletion is durable')
  assert.equal(new IssueStore(data).get(`iss_${runOnlyLeader.id}`), undefined, 'run-only cascade deletion is durable')
  assert.equal(JSON.parse(fs.readFileSync(logFile, 'utf8').trim()).data.deletedTasks, 9, 'event-log audit')
  assert.equal((await sweepExpiredIssues(deps)).deletedTasks, 0, 'second sweep idempotent')
  assert.equal(store.get(runOnlyWorker.id), undefined, 'run-only descendants stay deleted')
  await assert.rejects(() => sweepExpiredIssues(deps, 0), /positive/)
  // 近期子孙只是拖住级联，不是永久豁免：等它自己也过期后，父任务连同子孙必须一起被清理。
  const aged = { ...deps, now: () => now + 60 * DAY }
  const agedReport = await sweepExpiredIssues(aged)
  for (const task of [freshRunOnlyLeader, freshRunOnlyChild, recent, freshLeader, freshChild, freshOrphan]) assert.equal(store.get(task.id), undefined, `${task.title} swept once it expired itself`)
  assert.equal(agedReport.deletedTasks, 6, 'aged sweep: recent + issue-bearing fresh cards + the fresh run-only cascade')
  assert.equal(agedReport.deletedIssues, 5)
  for (const task of [orphan, runOnlyRoot, activeGoal, activeMeeting, protectedLeader, protectedChild, goalRunOnlyLeader, goalRunOnlyChild, meetingRunOnlyLeader, meetingRunOnlyChild, blockedLeader, busyChild, busyRunOnlyLeader, busyRunOnlyChild, sharedDone, sharedParked, race]) assert.ok(store.get(task.id), `${task.title} never swept while unreachable, running or protected`)
  console.log('PASS retention: terminal/age/cascade/logs/protection/orphans/run-only descendants/race/restart/idempotence')

  const task = (id, extra = {}) => ({ id, title: id, prompt: id, backend: 'fake', status: 'done', createdAt: now, eventCount: 0, workdir: '', ...extra })
  const issue = (id, taskId) => ({ id, taskId, identifier: id, status: 'done', updatedAt: now, createdBy: 'user' })
  const tree = board.buildBoardTree([task('old', { issueId: 'iss_leader' }), task('latest', { issueId: 'iss_leader', trigger: 'handoff' }), task('worker', { parentTaskId: 'old' }), task('orphan', { parentTaskId: 'deleted' })], [issue('iss_leader', 'latest'), issue('iss_worker', 'worker'), issue('iss_orphan', 'orphan')])
  assert.equal(tree.roots.length, 1)
  assert.equal(tree.roots[0].task.id, 'latest')
  assert.equal(tree.roots[0].children[0].task.id, 'worker', 'historical leader aliases latest Issue card')
  assert.equal(tree.orphans[0].task.id, 'orphan')
  const cycle = board.buildBoardTree([task('a', { parentTaskId: 'b' }), task('b', { parentTaskId: 'a' })], [])
  assert.equal(cycle.orphans.length, 2, 'cycles cannot recurse')
  const empty = new Set()
  assert.equal(board.boardCardKind(task('n'), undefined, empty, empty), 'normal')
  assert.equal(board.boardCardKind(task('d', { parentTaskId: 'p' }), undefined, empty, empty), 'delegate')
  assert.equal(board.boardCardKind(task('h', { trigger: 'handoff' }), undefined, empty, empty), 'handoff')
  assert.equal(board.boardCardKind(task('g', { goalId: 'g' }), undefined, empty, empty), 'goal')
  assert.equal(board.boardCardKind(task('m'), issue('m', 'm'), empty, new Set(['m'])), 'meeting')
  // 单日视图：跨天归属按本地时区 0 点切（23:59 归当天，次日 00:01 归明天）
  const todayFloor = board.boardDayFloor(now)
  const lateTonight = new Date(todayFloor).setHours(23, 59, 0, 0)
  const nextMorning = new Date(todayFloor).setHours(24, 1, 0, 0)
  assert.equal(board.boardDayFloor(lateTonight), todayFloor)
  assert.notEqual(board.boardDayFloor(nextMorning), todayFloor, '次日 00:01 归明天')
  assert.ok(board.onBoardDay(lateTonight, todayFloor) && !board.onBoardDay(nextMorning, todayFloor), '跨天归属唯一')
  assert.equal(board.formatBoardDay(todayFloor, todayFloor), `今天·${new Date(now).getMonth() + 1}月${new Date(now).getDate()}日`)
  assert.ok(board.formatBoardDay(new Date(todayFloor).setFullYear(new Date(todayFloor).getFullYear() - 1), todayFloor).startsWith('20'), '跨年补年份')
  // 日期下拉：只列有卡片的日期（空日期不列），去重降序；超龄受保护日期保留
  const stamps = [lateTonight, nextMorning, now - 40 * DAY]
  const options = board.boardDayOptions(stamps)
  assert.equal(options.length, 3, '三个时间戳分属三天')
  assert.deepEqual(options, [...options].sort((a, b) => b - a), '下拉按日期降序')
  assert.ok(options.every((floor) => stamps.some((ts) => board.onBoardDay(ts, floor))), '下拉只列有卡片的日期')
  assert.equal(board.boardDayOptions([lateTonight, lateTonight + 1]).length, 1, '同日时间戳去重')
  assert.ok(options.includes(board.boardDayFloor(now - 40 * DAY)), '超龄受保护日期仍在下拉')
  // 导航：› 钳在今天不越界，‹ 向旧不受限
  assert.equal(board.shiftBoardDay(todayFloor, 1, todayFloor), todayFloor, '› 在今天停住')
  assert.equal(board.shiftBoardDay(todayFloor - 3 * DAY, 1, todayFloor), todayFloor - 2 * DAY, '› 单步前进')
  assert.equal(board.shiftBoardDay(todayFloor, -1, todayFloor), todayFloor - DAY, '‹ 向旧不受限')
  // 超龄受保护卡：按 updatedAt 归入对应日期、选中即可见；该日节头出现唯一的「将自动清理」角标
  const overAgeFloor = board.boardDayFloor(now - 40 * DAY)
  assert.ok(board.onBoardDay(now - 40 * DAY, overAgeFloor), '超龄卡归属其 updatedAt 当日')
  assert.ok(board.isOverAgeDay(overAgeFloor, todayFloor), '越过 30 天保留窗的日期出现角标')
  assert.ok(!board.isOverAgeDay(todayFloor, todayFloor) && !board.isOverAgeDay(todayFloor - 5 * DAY, todayFloor), '窗内日期无角标')
  // 改动徽标：有 gitStat 才有数据，无则次行跳过
  assert.deepEqual(board.boardDiffStat('a.ts | 2 +-\nb.ts | 3 +\n2 files changed, 4 insertions(+), 1 deletion(-)'), { files: 2, plus: 4, minus: 1 })
  assert.equal(board.boardDiffStat(undefined), undefined)
  assert.equal(board.boardDiffStat(''), undefined)
  console.log('PASS board: five type classes, single-day filter/day-nav/over-age protection/diff badge, child folding, historical leader alias, orphan/cycle grouping')
} finally {
  store?.flush()
  delete globalThis.window
  fs.rmSync(temp, { recursive: true, force: true })
}
