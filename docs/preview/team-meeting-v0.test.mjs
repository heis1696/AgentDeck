import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { JSDOM } from 'jsdom'

const html = await readFile(new URL('./team-meeting-v0.html', import.meta.url), 'utf8')
const script = await readFile(new URL('./team-meeting-v0.js', import.meta.url), 'utf8')
const dom = new JSDOM(html, { url: 'https://preview.invalid/meeting', runScripts: 'outside-only' })
const { window } = dom
window.structuredClone = structuredClone
window.agentdeck = new Proxy({}, { get() { throw new Error('预览禁止访问生产 bridge') } })
window.fetch = () => { throw new Error('预览禁止发起网络请求') }
window.eval(script)
await window.meetingV0.ready
const document = window.document
const byId = (id) => document.getElementById(id)
const tick = () => new Promise((resolve) => setImmediate(resolve))
let passed = 0
const check = (description, verify) => { verify(); passed += 1; console.log(`PASS ${description}`) }
const click = async (selector) => { document.querySelector(selector).click(); await tick() }
const change = async (id, value) => { byId(id).value = value; byId(id).dispatchEvent(new window.Event('change')); await tick() }
const follow = async (checked) => { byId('follow').checked = checked; byId('follow').dispatchEvent(new window.Event('change')); await tick() }

check('初始不自动打开侧栏', () => assert.equal(byId('dock').hidden, true))
check('全量读取到最后一页', () => assert.equal(document.querySelectorAll('.turn').length, 8))
check('初始化三页均不带版本或序号下界', () => {
  const calls = window.meetingV0.calls.filter((call) => call.method === 'readTurns')
  assert.equal(calls.length, 3)
  assert.ok(calls.every((call) => call.query.afterVersion === undefined && call.query.afterSequence === undefined))
  assert.ok(calls[1].query.cursor && calls[2].query.cursor)
})
check('水位在全量分页完成后提交', () => assert.equal(window.meetingV0.getState().latestVersion, 8))
check('公开实名与用户插话', () => {
  for (const name of ['ZetCode', 'Claude', 'Codex', '你']) assert.ok(byId('timeline').textContent.includes(name))
})
check('发言准备执行完成失败取消均可见', () => {
  for (const status of ['pending', 'speaking', 'done', 'failed', 'cancelled']) assert.ok(document.querySelector(`.turn[data-status="${status}"]`))
})
await click('[data-execution="speech_1"]')
check('点击旧发言定位确切 Task Run Turn', () => {
  assert.equal(window.meetingV0.getState().selection.turnId, 'speech_1')
  for (const id of ['task_reporter_session', 'run_reporter_1', 'execution_1']) assert.ok(byId('execution-detail').textContent.includes(id))
  assert.ok(!byId('execution-detail').textContent.includes('run_reporter_5'))
})
check('使用 getTurn 和 memberExecutions 而不是评论标题', () => {
  assert.ok(window.meetingV0.calls.some((call) => call.method === 'getTurn' && call.turnId === 'speech_1'))
  assert.ok(window.meetingV0.calls.some((call) => call.method === 'memberExecutions' && call.agentId === 'reporter'))
  assert.ok(!script.includes('comments.') && !script.includes('parseComment'))
})
await click('[data-execution="speech_7"]')
check('未建立执行的发言不回退到成员最新 Run', () => {
  assert.equal(window.meetingV0.getState().selection.turnId, 'speech_7')
  assert.ok(byId('execution-detail').textContent.includes('关联尚未完整'))
  assert.ok(!byId('execution-detail').textContent.includes('run_critic_4'))
})
await click('[data-execution="speech_1"]')
await click('#next-speaker')
check('其他成员发言不会抢走固定成员及旧发言', () => {
  assert.equal(window.meetingV0.getState().selection.agentId, 'reporter')
  assert.equal(window.meetingV0.getState().selection.turnId, 'speech_1')
  assert.equal(window.meetingV0.getState().selection.follow, false)
})
check('增量更新旧序号且不重复追加记录', () => {
  assert.ok(document.querySelector('[data-turn-id="speech_1"]').textContent.includes('已补充审计信息'))
  assert.equal(document.querySelectorAll('.turn').length, 8)
  assert.equal(window.meetingV0.getState().latestVersion, 11)
})
check('增量仅带版本下界，不附旧序号下界', () => {
  const calls = window.meetingV0.calls.filter((call) => call.method === 'readTurns' && call.query.afterVersion !== undefined)
  assert.equal(calls[0].query.afterVersion, 8)
  assert.ok(calls.every((call) => !Object.hasOwn(call.query, 'afterSequence')))
})
await follow(true)
check('显式跟随当前正式发言者', () => {
  assert.equal(window.meetingV0.getState().selection.agentId, 'critic')
  assert.equal(window.meetingV0.getState().selection.turnId, 'speech_7')
})
await click('#next-speaker')
check('跟随切换到下一位正式发言者', () => assert.equal(window.meetingV0.getState().selection.agentId, 'designer'))
check('内部调查只在成员侧栏展示', () => {
  assert.ok(byId('execution-detail').textContent.includes('task_designer_investigation'))
  assert.ok(!byId('timeline').textContent.includes('task_designer_investigation'))
})
await click('[data-execution="speech_4"]')
check('手动选择旧发言退出跟随', () => {
  assert.equal(window.meetingV0.getState().selection.follow, false)
  assert.equal(window.meetingV0.getState().selection.turnId, 'speech_4')
  assert.equal(byId('follow').checked, false)
})
await click('#close-dock')
check('关闭侧栏保留选择但不自动重开', () => {
  assert.equal(byId('dock').hidden, true)
  assert.equal(window.meetingV0.getState().selection.turnId, 'speech_4')
})
await click('#reopen')
check('重开恢复原成员和旧发言', () => {
  assert.equal(byId('dock').hidden, false)
  assert.equal(window.meetingV0.getState().selection.turnId, 'speech_4')
})
check('预览缓存按会议 root 隔离', () => assert.ok(window.sessionStorage.getItem('agentdeck:meeting-v0:meeting_preview_v0')))
document.querySelector('[data-member="reporter"]').click()
byId('close-dock').click()
await tick()
check('迟到读取不能重新打开已关闭侧栏', () => assert.equal(byId('dock').hidden, true))
await change('scenario', 'stopping')
check('停止中不能误报已停止', () => {
  assert.equal(byId('meeting-status').textContent, '正在停止')
  assert.ok(byId('meeting-state').textContent.includes('退出确认'))
  assert.equal(byId('delete').disabled, true)
})
await change('scenario', 'stop-failed')
check('停止受阻保留退出证明和删除屏障文案', () => {
  assert.equal(byId('meeting-status').textContent, '停止受阻')
  assert.ok(byId('meeting-state').textContent.includes('退出证明'))
  assert.equal(byId('delete').disabled, true)
})
await change('scenario', 'cancelled')
check('已停止强调全会议退出确认与咨询隔离', () => {
  assert.equal(byId('meeting-status').textContent, '已停止')
  assert.ok(byId('meeting-state').textContent.includes('独立咨询办公室'))
})
await change('scenario', 'failed')
check('执行失败不伪装停止成功', () => assert.ok(byId('meeting-state').textContent.includes('不代表进程退出已确认')))
await change('scenario', 'draft')
check('准备状态明确尚未正式发言', () => assert.ok(byId('meeting-state').textContent.includes('尚未开始正式发言')))
await change('scenario', 'concluded')
check('纪要展示同版本确认而非随意完成', () => assert.ok(byId('minutes-state').textContent.includes('同版本确认')))
await change('scenario', 'empty')
check('空态解释准备后的实名发言', () => assert.ok(byId('timeline').textContent.includes('第一位成员会实名')))
await change('scenario', 'read-error')
check('读取失败保留记录水位且不回退兼容评论', () => {
  assert.equal(document.querySelectorAll('.turn').length, 8)
  assert.equal(window.meetingV0.getState().latestVersion, 14)
  assert.ok(byId('timeline').textContent.includes('不降级读取兼容评论'))
})
await click('#theme')
check('浅色主题复用 html.light', () => assert.ok(document.documentElement.classList.contains('light')))
await click('#theme')
check('深色主题可恢复', () => assert.ok(!document.documentElement.classList.contains('light')))
check('停止删除发送与生产导航全部隔离', () => {
  assert.equal(byId('stop').disabled, true)
  assert.equal(byId('delete').disabled, true)
  assert.equal(document.querySelectorAll('a[href]').length, 0)
  assert.ok(document.querySelector('.composer button').disabled)
})
dom.window.close()
console.log(`会议 v0 预览：${passed} 项通过；仅夹具交互，不代表正式页面或真实平台验收。`)
