import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-meeting-public-store-'))
const outfile = path.join(temporary, 'meeting-store.cjs')
await build({ entryPoints: [path.join(root, 'src/main/meeting-store.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
const { MeetingStore } = await import(pathToFileURL(outfile).href)

let total = 0
const check = (condition, label) => {
  total++
  console.log(`  ${condition ? 'OK' : 'FAIL'} ${label}`)
  if (!condition) process.exitCode = 1
}
const scenario = (label) => console.log(`\n[${label}]`)

const longBody = Array.from({ length: 400 }, (_, line) => `公共正文第 ${line + 1} 行：${'讨论内容'.repeat(12)}`).join('\n')
const longBodyTail = longBody.slice(-160)
const oversizedSource = '压缩来源标签'.padEnd(300, '源')

function makeTurn(overrides = {}) {
  return {
    id: `turn_${Math.random().toString(36).slice(2, 10)}`,
    meetingId: 'unknown',
    round: 1,
    phase: 'report',
    agentId: 'alpha',
    officeTaskId: 'office_alpha',
    status: 'speaking',
    ...overrides
  }
}

try {
  // ---------- 场景 A：占位、原记录更新、独立正文、投递元数据、幂等重放 ----------
  scenario('placeholder, in-place update, separate body, delivery, idempotent replay')
  const dirA = path.join(temporary, 'data-a')
  const storeA = new MeetingStore(dirA)
  const meetingA = storeA.create({ issueId: 'iss_a', topic: '公开发言事实源', participants: [{ agentId: 'alpha', role: 'reporter' }] })
  const placeholder = makeTurn({ meetingId: meetingA.id, phase: 'report', status: 'speaking', startedAt: 1_000 })
  const stored = storeA.appendTurn(placeholder)
  check(storeA.turns(meetingA.id).length === 1 && stored.status === 'speaking' && stored.summary === undefined, 'named placeholder is queryable right after speech starts')
  const page0 = storeA.readTurns(meetingA.id)
  check(page0.turns.length === 1 && page0.turns[0].sequence === 1 && page0.turns[0].version === 1 && page0.latestVersion === 1, 'first placeholder carries sequence 1 / version 1 and meeting watermark 1')

  const updated = storeA.updateTurn(meetingA.id, placeholder.id, {
    status: 'done',
    summary: '结论摘要',
    endedAt: 2_000,
    purpose: 'speech',
    speaker: { name: '阿尔法队长', role: '队长·前端', platform: 'codex' },
    runId: 'run_exec_1',
    executionTurnId: 'exec_turn_9',
    contextVersion: 7,
    executionEpoch: 2,
    error: undefined,
    mirror: { state: 'published', attempts: 1, commentId: 'c_1' },
    delivery: {
      publicVersion: 7,
      sourceTurnIds: Array.from({ length: 501 }, (_, index) => `turn_src_${index}`),
      chairTurnIds: ['turn_chair_1'],
      compression: { source: oversizedSource, originalLength: 48_000, keptLength: 12_000 }
    }
  }, longBody)
  check(!!updated && storeA.turns(meetingA.id).length === 1, 'completion updates the original placeholder record instead of appending a duplicate bubble')
  const detail = storeA.getTurn(meetingA.id, placeholder.id)
  check(!!detail && detail.body === longBody && detail.body.includes(longBodyTail) && detail.body.length > 4000, 'speech longer than legacy 1000/4000-char truncation is fully readable via getTurn')
  check(!!detail && detail.version === 2 && detail.sequence === 1 && storeA.readTurns(meetingA.id).latestVersion === 2, 'in-place update bumps version but keeps the stable sequence')
  check(!!detail && detail.speaker?.name === '阿尔法队长' && detail.speaker?.platform === 'codex' && detail.runId === 'run_exec_1' && detail.executionTurnId === 'exec_turn_9' && detail.contextVersion === 7 && detail.executionEpoch === 2, 'speaker snapshot, run/execution-turn ids, context version and epoch persist on the detail')
  check(!!detail && detail.purpose === 'speech' && detail.mirror?.state === 'published', 'purpose and mirror status persist on the detail')

  const indexRaw = fs.readFileSync(path.join(dirA, 'meetings', 'index.json'), 'utf8')
  check(!indexRaw.includes('公共正文第') && indexRaw.includes('结论摘要'), 'full body never enters the on-disk overall index; only the summary does')
  check(!!detail && detail.delivery?.publicVersion === 7 && detail.delivery.sourceTurnIds?.length === 501 && detail.delivery.chairTurnIds?.length === 1, 'delivery sourceTurnIds remain complete in the independent detail')
  check(!!detail && detail.delivery?.compression?.originalLength === 48_000 && detail.delivery.compression.keptLength === 12_000 && detail.delivery.compression.source === oversizedSource, 'compression source and lengths remain complete outside the overall index')
  check(!indexRaw.includes(oversizedSource), 'oversized compression source text does not enter the overall index')

  const replayed = storeA.appendTurn({ ...placeholder, status: 'done', summary: '结论摘要', endedAt: 2_000, sequence: 99, version: 99 })
  check(storeA.turns(meetingA.id).length === 1 && replayed.version === 2 && storeA.readTurns(meetingA.id).latestVersion === 2, 'identical replay with same turn id is idempotent: no duplicate, no version bump, stored sequence kept')
  const evolved = storeA.appendTurn({ ...placeholder, status: 'failed', error: 'provider exited mid-speech' })
  check(storeA.turns(meetingA.id).length === 1 && evolved.status === 'failed' && evolved.error === 'provider exited mid-speech' && evolved.version === 3, 'replay with evolved content merges into the same record and bumps the version')
  check(storeA.appendTurn({ ...placeholder, status: 'failed', error: 'provider exited mid-speech' }).version === 3, 'replaying the evolved record again is a no-op')

  const cleared = storeA.updateTurn(meetingA.id, placeholder.id, { status: 'speaking', error: undefined, endedAt: undefined })
  check(!!cleared && cleared.status === 'speaking' && cleared.error === undefined && cleared.endedAt === undefined && cleared.version === 4, 'explicit undefined patch clears error/endedAt fields')

  check(storeA.deleteTurnBody(meetingA.id, placeholder.id) === true, 'deleteTurnBody removes the stored body')
  const afterDelete = storeA.getTurn(meetingA.id, placeholder.id)
  check(afterDelete?.body === undefined && afterDelete?.summary === '结论摘要' && afterDelete?.version === 5, 'after body deletion the record keeps its summary, never fakes a body, and the removal is versioned')
  check(storeA.deleteTurnBody(meetingA.id, placeholder.id) === false, 'deleting an already-removed body returns false')
  const mutatedCopy = storeA.getTurn(meetingA.id, placeholder.id)
  mutatedCopy.summary = 'hacked'
  check(storeA.getTurn(meetingA.id, placeholder.id)?.summary === '结论摘要', 'returned details are copies; mutating them cannot corrupt the store')

  // ---------- 场景 B：分页、游标、版本增量 ----------
  scenario('pagination, cursor and version increments')
  const dirB = path.join(temporary, 'data-b')
  const storeB = new MeetingStore(dirB)
  const meetingB = storeB.create({ issueId: 'iss_b', topic: '分页', participants: [{ agentId: 'beta', role: 'critic' }] })
  for (let index = 1; index <= 10; index++) storeB.appendTurn(makeTurn({ meetingId: meetingB.id, round: index, status: 'done', summary: `发言 ${index}` }))

  const page1 = storeB.readTurns(meetingB.id, { limit: 3 })
  check(page1.turns.length === 3 && page1.turns.map((turn) => turn.sequence).join(',') === '1,2,3' && page1.hasMore && !!page1.nextCursor, 'first page returns limit turns in sequence order with a cursor')
  const page2 = storeB.readTurns(meetingB.id, { cursor: page1.nextCursor, limit: 3 })
  check(page2.turns.map((turn) => turn.sequence).join(',') === '4,5,6' && page2.hasMore, 'cursor continues from the last returned sequence')
  const page4 = storeB.readTurns(meetingB.id, { cursor: storeB.readTurns(meetingB.id, { afterSequence: 6, limit: 3 }).nextCursor, limit: 3 })
  check(page4.turns.map((turn) => turn.sequence).join(',') === '10' && !page4.hasMore && page4.nextCursor === undefined, 'final page has no continuation')
  check(storeB.readTurns(meetingB.id, { limit: 0 }).turns.length === 1 && storeB.readTurns(meetingB.id, { limit: -5 }).turns.length === 1, 'invalid limits clamp instead of returning empty pages')
  check(storeB.readTurns(meetingB.id, { limit: 99_999 }).turns.length === 10, 'oversized limits are capped but still return the whole short timeline')
  check(storeB.readTurns(meetingB.id, { afterSequence: 5 }).turns.map((turn) => turn.sequence).join(',') === '6,7,8,9,10', 'afterSequence keyset filter works without cursor')
  check(storeB.readTurns(meetingB.id, { afterSequence: 9, cursor: page1.nextCursor, limit: 3 }).turns.map((turn) => turn.sequence).join(',') === '4,5,6', 'an explicit cursor takes precedence over a conflicting afterSequence')
  const empty = storeB.readTurns('meeting_missing')
  check(empty.turns.length === 0 && empty.latestVersion === 0 && !empty.hasMore, 'unknown meeting yields an empty page with watermark 0')
  let malformedCursor = false
  try { storeB.readTurns(meetingB.id, { cursor: 'not-a-cursor!!' }) } catch { malformedCursor = true }
  check(malformedCursor, 'malformed cursor is rejected')
  let foreignCursor = false
  try { storeB.readTurns(meetingB.id, { cursor: Buffer.from(JSON.stringify({ v: 99, afterSequence: 1 }), 'utf8').toString('base64url') }) } catch { foreignCursor = true }
  check(foreignCursor, 'cursor from a foreign cursor version is rejected')

  const beforeIncrement = storeB.readTurns(meetingB.id)
  storeB.updateTurn(meetingB.id, page1.turns[2].id, { summary: '发言 3（修订）' })
  const increment = storeB.readTurns(meetingB.id, { afterVersion: beforeIncrement.latestVersion })
  check(increment.turns.length === 1 && increment.turns[0].summary === '发言 3（修订）' && increment.latestVersion === beforeIncrement.latestVersion + 1, 'afterVersion returns only records changed since the watermark')

  // ---------- 场景 C：旧 schema 兼容，缺正文不冒充 ----------
  scenario('legacy schema compatibility')
  const dirC = path.join(temporary, 'data-c', 'meetings')
  fs.mkdirSync(dirC, { recursive: true })
  fs.writeFileSync(path.join(dirC, 'index.json'), JSON.stringify({
    schemaVersion: 1,
    meetings: [{ id: 'meeting_legacy', issueId: 'iss_old', topic: '历史会议', participants: [], status: 'concluded', round: 2, maxRounds: 6, maxInnerTurns: 3, maxDurationMs: 3_600_000, minutes: [], noProgress: 0, noProgressCap: 2, failures: 0, pendingChairNotes: [], createdAt: 1, updatedAt: 2 }],
    turns: [
      { id: 'turn_old_2', meetingId: 'meeting_legacy', round: 2, phase: 'synthesis', agentId: 'old_gamma', officeTaskId: 'office_old', status: 'done', summary: '旧综合摘要' },
      { id: 'turn_old_1', meetingId: 'meeting_legacy', round: 1, phase: 'report', agentId: 'old_alpha', officeTaskId: 'office_old', status: 'done', summary: '旧汇报摘要' }
    ]
  }))
  const storeC = new MeetingStore(path.join(temporary, 'data-c'))
  const legacyPage = storeC.readTurns('meeting_legacy')
  check(legacyPage.turns.length === 2 && legacyPage.turns.every((turn) => turn.body === undefined), 'legacy turns load without a body')
  check(legacyPage.turns[0].summary === '旧汇报摘要' && legacyPage.turns[0].body === undefined, 'legacy summary is not passed off as a full body')
  check(legacyPage.turns.map((turn) => turn.id).join(',') === 'turn_old_1,turn_old_2', 'legacy turns keep the legacy round-then-id ordering')
  check(legacyPage.turns.every((turn) => turn.sequence === undefined && turn.version === undefined) && legacyPage.latestVersion === 0, 'legacy records keep optional new fields unset with watermark 0')
  check(storeC.readTurns('meeting_legacy', { afterSequence: 0 }).turns.length === 0 && storeC.readTurns('meeting_legacy', { afterVersion: 0 }).turns.length === 0, 'legacy records are excluded from sequence/version increments')
  const afterLegacy = storeC.appendTurn(makeTurn({ meetingId: 'meeting_legacy', status: 'done', summary: '新发言' }))
  check(afterLegacy.sequence === 1 && afterLegacy.version === 1, 'new turns into a legacy meeting start sequence/version at 1')
  check(storeC.readTurns('meeting_legacy').turns.map((turn) => turn.id).join(',') === 'turn_old_1,turn_old_2,' + afterLegacy.id, 'new turns sort after legacy records')
  check(storeC.getTurn('meeting_legacy', 'turn_missing') === null && storeC.getTurn('meeting_other', 'turn_old_1') === null, 'getTurn returns null for missing turns and mismatched meetings')

  // ---------- 场景 D：重启、故障恢复、安全路径 ----------
  scenario('restart, failure recovery and safe paths')
  const dirD = path.join(temporary, 'data-d')
  const storeD1 = new MeetingStore(dirD)
  const meetingD = storeD1.create({ issueId: 'iss_d', topic: '重启与恢复', participants: [{ agentId: 'gamma', role: 'designer' }] })
  const turnD = storeD1.appendTurn(makeTurn({ meetingId: meetingD.id, status: 'speaking' }))
  storeD1.updateTurn(meetingD.id, turnD.id, { status: 'done', summary: '重启前摘要' }, '重启前完整正文')
  const watermarkBefore = storeD1.readTurns(meetingD.id).latestVersion

  const storeD2 = new MeetingStore(dirD)
  check(storeD2.get(meetingD.id)?.topic === '重启与恢复' && storeD2.turns(meetingD.id).length === 1, 'restart reloads meetings and turn index')
  const restoredTurn = storeD2.getTurn(meetingD.id, turnD.id)
  check(restoredTurn?.body === '重启前完整正文' && restoredTurn?.sequence === 1 && restoredTurn?.version === watermarkBefore, 'restart preserves stored bodies, sequence and version')
  const continued = storeD2.appendTurn(makeTurn({ meetingId: meetingD.id, status: 'speaking' }))
  check(continued.sequence === 2 && continued.version === watermarkBefore + 1, 'sequence/version allocation continues after restart')

  fs.writeFileSync(path.join(dirD, 'meetings', 'index.json'), '{corrupted')
  const storeD3 = new MeetingStore(dirD)
  check(storeD3.get(meetingD.id)?.topic === '重启与恢复' && storeD3.turns(meetingD.id).length === 2, 'corrupt primary index recovers from the last-good backup')
  check(JSON.parse(fs.readFileSync(path.join(dirD, 'meetings', 'index.json'), 'utf8')).meetings.length === 1, 'recovery rewrites a valid primary index')
  check(storeD3.getTurn(meetingD.id, turnD.id)?.body === '重启前完整正文', 'bodies survive index recovery')

  const bodiesDir = path.join(dirD, 'meetings', 'bodies')
  fs.writeFileSync(path.join(bodiesDir, meetingD.id, 'turn_orphan.json'), '{"schemaVersion":1,"body":"孤儿正文"}')
  fs.writeFileSync(path.join(bodiesDir, meetingD.id, `${turnD.id}.json.tmp`), '{"partial":true}')
  fs.mkdirSync(path.join(bodiesDir, 'meeting_ghost'))
  fs.writeFileSync(path.join(bodiesDir, 'meeting_ghost', 'turn_ghost.json'), '{}')
  const storeD4 = new MeetingStore(dirD)
  check(storeD4.getTurn(meetingD.id, turnD.id)?.body === '重启前完整正文', 'orphan reclaim keeps committed bodies')
  check(!fs.existsSync(path.join(bodiesDir, meetingD.id, 'turn_orphan.json')) && !fs.existsSync(path.join(bodiesDir, 'meeting_ghost')) && !fs.existsSync(path.join(bodiesDir, meetingD.id, `${turnD.id}.json.tmp`)), 'orphan bodies, ghost meeting dirs and temp leftovers are reclaimed on load')

  const bodyTarget = storeD4.appendTurn(makeTurn({ meetingId: meetingD.id, status: 'speaking' }))
  const watermarkBeforeFailure = storeD4.readTurns(meetingD.id).latestVersion
  fs.mkdirSync(path.join(bodiesDir, meetingD.id, `${bodyTarget.id}.json`))
  let bodyWriteFailed = false
  try { storeD4.updateTurn(meetingD.id, bodyTarget.id, { summary: '不应提交' }, '不应写入的正文') } catch { bodyWriteFailed = true }
  check(bodyWriteFailed, 'unwritable body path makes updateTurn fail loudly')
  check(storeD4.getTurn(meetingD.id, bodyTarget.id)?.summary === undefined && storeD4.getTurn(meetingD.id, bodyTarget.id)?.status === 'speaking', 'failed body write leaves the record untouched')
  check(storeD4.getTurn(meetingD.id, turnD.id)?.body === '重启前完整正文', 'unrelated stored bodies stay intact after a failed body write')
  check(storeD4.readTurns(meetingD.id).latestVersion === watermarkBeforeFailure, 'failed body write does not advance the version watermark')
  fs.rmSync(path.join(bodiesDir, meetingD.id, `${bodyTarget.id}.json`), { recursive: true, force: true })
  check(storeD4.updateTurn(meetingD.id, bodyTarget.id, { summary: '重试摘要' }, '重试正文')?.summary === '重试摘要', 'updateTurn succeeds once the body path is writable again')

  const blocker = path.join(dirD, 'meetings', 'index.json.tmp')
  fs.mkdirSync(blocker)
  const beforeBlocked = storeD4.getTurn(meetingD.id, turnD.id)
  let indexWriteFailed = false
  try { storeD4.updateTurn(meetingD.id, turnD.id, { summary: '索引失败摘要' }, '索引失败正文') } catch { indexWriteFailed = true }
  check(indexWriteFailed, 'failed index commit makes updateTurn fail loudly')
  const afterBlocked = storeD4.getTurn(meetingD.id, turnD.id)
  check(afterBlocked?.summary === beforeBlocked.summary && afterBlocked?.body === beforeBlocked.body, 'failed index commit rolls back memory and restores the previous body')
  fs.rmSync(blocker, { recursive: true, force: true })
  check(storeD4.updateTurn(meetingD.id, turnD.id, { summary: '恢复后摘要' }, '恢复后正文')?.body === '恢复后正文', 'updateTurn succeeds after the index path is unblocked')

  fs.mkdirSync(blocker)
  let appendRolledBack = false
  try { storeD4.appendTurn(makeTurn({ meetingId: meetingD.id, status: 'speaking' })) } catch { appendRolledBack = true }
  fs.rmSync(blocker, { recursive: true, force: true })
  check(appendRolledBack && storeD4.turns(meetingD.id).length === 3, 'failed appendTurn leaves no half-added turn')

  check(storeD4.getTurn(meetingD.id, '../escape') === null && storeD4.updateTurn(meetingD.id, '../escape', { status: 'done' }, 'evil') === null, 'path-like turn ids never resolve')
  check(storeD4.deleteTurnBody(meetingD.id, '../../outside') === false && storeD4.getTurn('../outside', 'turn_x') === null, 'path-like meeting ids never resolve')
  check(!fs.existsSync(path.join(dirD, 'escape')) && !fs.existsSync(path.join(dirD, 'outside')), 'no files were written outside the meeting storage root')

  const safeTarget = storeD4.appendTurn(makeTurn({ meetingId: meetingD.id, status: 'speaking' }))
  storeD4.updateTurn(meetingD.id, safeTarget.id, { status: 'done', summary: '待删除正文' }, '将删除的正文')
  check(storeD4.deleteTurnBody(meetingD.id, safeTarget.id) === true && storeD4.getTurn(meetingD.id, safeTarget.id)?.body === undefined, 'explicit body deletion leaves the index record readable')
  check(storeD4.delete(meetingD.id) === true && storeD4.readTurns(meetingD.id).turns.length === 0 && !fs.existsSync(path.join(bodiesDir, meetingD.id)), 'meeting deletion removes the index records and the whole body directory')
  check(storeD4.delete(meetingD.id) === false, 'repeated meeting deletion is a no-op')

  // ---------- 场景 E：会议级 API 回归（list/get/update/appendMinutes/reload） ----------
  scenario('legacy meeting-level API regression')
  check(storeD4.list().length === 0 && storeA.get(meetingA.id)?.topic === '公开发言事实源', 'list/get keep legacy semantics')
  check(storeA.update(meetingA.id, { blockedReason: '测试' })?.blockedReason === '测试', 'update keeps legacy semantics')
  check(storeA.appendMinutes(meetingA.id, { round: 1, decisions: [], objections: [], actionItems: [], openQuestions: [], provenance: 'consensus:advisory' })?.minutes.length === 1, 'appendMinutes keeps legacy semantics')
  storeA.reload()
  const reloaded = storeA.getTurn(meetingA.id, placeholder.id)
  check(reloaded?.status === 'speaking' && reloaded?.sequence === 1 && reloaded?.version === 5, 'reload keeps detail records readable with stable sequence/version')

  scenario('durable body commit, atomic journal, damaged journal and paginated catch-up')
  const edgeDir = path.join(temporary, 'journal-edges')
  const edgeStore = new MeetingStore(edgeDir)
  const edgeMeeting = edgeStore.create({ issueId: 'iss_journal', topic: 'durability', participants: [{ agentId: 'alpha', role: 'reporter' }] })
  const edgeTurn = edgeStore.appendTurn(makeTurn({ id: 'turn_journal', meetingId: edgeMeeting.id }))
  const journal = path.join(edgeDir, 'meetings', 'body-pending.json')
  const originalRemove = fs.rmSync
  try {
    fs.rmSync = (target, ...args) => {
      if (String(target) === journal) throw Object.assign(new Error('injected cleanup EPERM'), { code: 'EPERM' })
      return originalRemove(target, ...args)
    }
    edgeStore.updateTurn(edgeMeeting.id, edgeTurn.id, { status: 'done' }, 'committed full body')
    edgeStore.updateTurn(edgeMeeting.id, edgeTurn.id, { mirror: { state: 'published' } })
    check(fs.existsSync(journal) && edgeStore.getTurn(edgeMeeting.id, edgeTurn.id)?.body === 'committed full body', 'post-commit cleanup failure does not fail or undo a committed speech')
  } finally { fs.rmSync = originalRemove }
  let edgeReloaded = new MeetingStore(edgeDir)
  check(edgeReloaded.getTurn(edgeMeeting.id, edgeTurn.id)?.body === 'committed full body' && edgeReloaded.getTurn(edgeMeeting.id, edgeTurn.id)?.status === 'done', 'later metadata version does not make recovery roll back a committed body')
  check(!fs.existsSync(journal), 'restart retries deferred committed-journal cleanup')
  fs.writeFileSync(journal, '{"meetingId":')
  edgeReloaded = new MeetingStore(edgeDir)
  check(edgeReloaded.getTurn(edgeMeeting.id, edgeTurn.id)?.body === 'committed full body', 'a malformed recovery journal never blocks valid meeting storage')
  check(fs.readdirSync(path.dirname(journal)).some((name) => name.startsWith('body-pending.json.invalid-')), 'damaged journal is quarantined rather than silently discarded')
  const bodyFile = path.join(edgeDir, 'meetings', 'bodies', edgeMeeting.id, `${edgeTurn.id}.json`)
  const previous = JSON.parse(fs.readFileSync(bodyFile, 'utf8'))
  const futureVersion = edgeReloaded.getTurn(edgeMeeting.id, edgeTurn.id).version + 1
  fs.writeFileSync(journal, JSON.stringify({ meetingId: edgeMeeting.id, turnId: edgeTurn.id, version: futureVersion, previous }))
  fs.writeFileSync(bodyFile, JSON.stringify({ ...previous, body: 'uncommitted new body', bodyVersion: futureVersion }))
  edgeReloaded = new MeetingStore(edgeDir)
  check(edgeReloaded.getTurn(edgeMeeting.id, edgeTurn.id)?.body === 'committed full body', 'crash between body replacement and index commit restores the previous committed detail')
  const rename = fs.renameSync
  try {
    fs.renameSync = (source, target) => {
      if (String(target) === journal) throw Object.assign(new Error('journal publication rejected'), { code: 'EPERM' })
      return rename(source, target)
    }
    let rejected = false
    try { edgeReloaded.updateTurn(edgeMeeting.id, edgeTurn.id, {}, 'must not replace body') } catch { rejected = true }
    check(rejected && edgeReloaded.getTurn(edgeMeeting.id, edgeTurn.id)?.body === 'committed full body', 'failed atomic journal publication leaves body and index untouched')
  } finally { fs.renameSync = rename }
  fs.writeFileSync(`${journal}.tmp`, '{"meetingId":')
  edgeReloaded = new MeetingStore(edgeDir)
  check(edgeReloaded.getTurn(edgeMeeting.id, edgeTurn.id)?.body === 'committed full body', 'partial unpublished journal temp is harmless on restart')
  const deltaDir = path.join(temporary, 'delta-edges')
  const deltaStore = new MeetingStore(deltaDir)
  const deltaMeeting = deltaStore.create({ issueId: 'iss_delta', topic: 'delta', participants: [{ agentId: 'alpha', role: 'reporter' }] })
  const deltaTurns = [1, 2, 3].map((index) => deltaStore.appendTurn(makeTurn({ id: `delta_${index}`, meetingId: deltaMeeting.id })))
  const firstPage = deltaStore.readTurns(deltaMeeting.id, { limit: 1 })
  deltaStore.updateTurn(deltaMeeting.id, deltaTurns[0].id, { status: 'done' }, 'late completion')
  const nextPage = deltaStore.readTurns(deltaMeeting.id, { cursor: firstPage.nextCursor, limit: 2 })
  const changed = deltaStore.readTurns(deltaMeeting.id, { afterVersion: firstPage.latestVersion })
  check(nextPage.latestVersion === firstPage.latestVersion && nextPage.turns.length === 2 && !nextPage.hasMore, 'paginated snapshot watermark stays fixed while an already-read turn changes')
  check(changed.turns.length === 1 && changed.turns[0].id === deltaTurns[0].id && changed.turns[0].body === 'late completion', 'new version delta catches an updated old sequence instead of losing it')
  const legacyDir = path.join(temporary, 'legacy-page-edges')
  fs.mkdirSync(path.join(legacyDir, 'meetings'), { recursive: true })
  fs.writeFileSync(path.join(legacyDir, 'meetings', 'index.json'), JSON.stringify({ schemaVersion: 1, meetings: [deltaMeeting], turns: [1, 2, 3].map((index) => makeTurn({ id: `legacy_${index}`, meetingId: deltaMeeting.id })) }))
  const legacyPageStore = new MeetingStore(legacyDir)
  const legacyFirst = legacyPageStore.readTurns(deltaMeeting.id, { limit: 1 })
  const legacyRest = legacyPageStore.readTurns(deltaMeeting.id, { cursor: legacyFirst.nextCursor, limit: 2 })
  check(legacyFirst.turns.length + legacyRest.turns.length === 3 && !legacyRest.hasMore, 'legacy sequence-zero ties paginate without dropping later historical turns')
  let crossMeetingRejected = false
  try { legacyPageStore.readTurns('other_meeting', { cursor: legacyFirst.nextCursor }) } catch { crossMeetingRejected = true }
  check(crossMeetingRejected, 'cursor cannot be replayed against a different meeting')
  check(!fs.readFileSync(path.join(dirA, 'meetings', 'index.json'), 'utf8').includes('turn_src_500'), 'complete delivery source range stays outside the hot index')

  if (process.exitCode) throw new Error('meeting public store regression failed')
  console.log(`\nPASS meeting public store: ${total} checks across placeholder updates, idempotent replay, pagination, increments, legacy records, restart, failure recovery and safe paths`)
} finally {
  const cleanupPath = path.resolve(temporary)
  if (path.dirname(cleanupPath) !== path.resolve(os.tmpdir()) || !path.basename(cleanupPath).startsWith('agentdeck-meeting-public-store-')) throw new Error('unsafe temporary cleanup path')
  fs.rmSync(cleanupPath, { recursive: true, force: true })
}
