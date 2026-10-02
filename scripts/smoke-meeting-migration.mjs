// 阶段4专项：旧会议数据安全幂等迁移与兼容（docs/plan/team-meeting-issue-v2.md §3、§8、§9阶段4、§13、§15）
// 覆盖：历史 sequence/version/publicVersion=0 初始化、未知 schema 拒写、升级前备份不可覆盖、
// 迁移失败可重入、缺正文不以 summary 冒充、YOU-384 缺容器与四条隐藏调查脱敏夹具、
// 旧共享办公室不归属不删除、回退数据兼容。全部使用临时夹具，不触碰生产数据。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-meeting-migration-'))
const outfile = path.join(temporary, 'meeting-store.cjs')
await build({ entryPoints: [path.join(root, 'src/main/meeting-store.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
const { MeetingStore, MeetingIndexSchemaError } = await import(pathToFileURL(outfile).href)

let total = 0
const check = (condition, label) => {
  total++
  console.log(`  ${condition ? 'OK' : 'FAIL'} ${label}`)
  if (!condition) process.exitCode = 1
}
const scenario = (label) => console.log(`\n[${label}]`)

const meetingDirOf = (dataDir) => path.join(dataDir, 'meetings')
const indexFileOf = (dataDir) => path.join(meetingDirOf(dataDir), 'index.json')
const preMigrationFileOf = (dataDir) => path.join(meetingDirOf(dataDir), 'index.pre-migration.json')
const bodiesRootOf = (dataDir) => path.join(meetingDirOf(dataDir), 'bodies')
const readBytes = (file) => fs.readFileSync(file, 'utf8')

// 脱敏旧形态：schemaVersion 1、会议缺 publicVersion/turnVersion、发言缺 sequence/version/publicVersion，
// 只有 summary 没有正文；所有 id 均为本专项夹具 id，不指向任何真实任务或会议
const legacyMeeting = (overrides = {}) => ({
  id: 'meeting_fix_legacy', issueId: 'iss_fix_legacy', topic: '历史会议夹具',
  participants: [{ agentId: 'captain_a', role: 'reporter', officeTaskId: 'office_fix_captain_a' }],
  status: 'cancelled', round: 2, maxRounds: 6, maxInnerTurns: 3, maxDurationMs: 3_600_000,
  minutes: [], noProgress: 0, noProgressCap: 2, failures: 1, pendingChairNotes: [],
  createdAt: 1_000, updatedAt: 2_000, ...overrides
})
const legacyTurn = (overrides = {}) => ({
  id: `turn_fix_${Math.random().toString(36).slice(2, 8)}`, meetingId: 'meeting_fix_legacy', round: 1, phase: 'report',
  agentId: 'captain_a', officeTaskId: 'office_fix_captain_a', status: 'done',
  summary: '历史发言摘要（无完整正文）', ...overrides
})
const writeIndex = (dataDir, document) => {
  fs.mkdirSync(meetingDirOf(dataDir), { recursive: true })
  fs.writeFileSync(indexFileOf(dataDir), JSON.stringify(document))
}

try {
  // ---------- 场景 A：历史水位 0 初始化（会议级物化，发言级读侧 0） ----------
  scenario('legacy watermarks initialize to an explicit zero baseline')
  const dirA = path.join(temporary, 'data-a')
  const fixtureA = {
    schemaVersion: 1,
    meetings: [legacyMeeting()],
    turns: [
      legacyTurn({ id: 'turn_fix_old_2', round: 2, phase: 'synthesis', summary: '旧综合摘要' }),
      legacyTurn({ id: 'turn_fix_old_1', round: 1, phase: 'report', summary: '旧汇报摘要' })
    ]
  }
  writeIndex(dirA, fixtureA)
  const rawBeforeA = readBytes(indexFileOf(dirA))
  const storeA = new MeetingStore(dirA)
  const meetingA = storeA.get('meeting_fix_legacy')
  check(meetingA !== null && meetingA.publicVersion === 0 && meetingA.turnVersion === 0, 'legacy meeting gains explicit publicVersion/turnVersion zero instead of undefined')
  check(meetingA.containerTaskId === undefined && !('sessionTaskId' in meetingA), 'migration adds watermark fields only, no ownership or attribution fields')
  const legacyPage = storeA.readTurns('meeting_fix_legacy')
  check(legacyPage.turns.map((turn) => turn.id).join(',') === 'turn_fix_old_1,turn_fix_old_2', 'legacy turns keep the round-then-id ordering at sequence zero')
  check(legacyPage.turns.every((turn) => turn.sequence === undefined && turn.version === undefined && turn.publicVersion === undefined), 'turn-level sequence/version/publicVersion stay unset; zero is the read-side default')
  check(legacyPage.latestVersion === 0 && storeA.readTurns('meeting_fix_legacy', { afterVersion: 0 }).turns.length === 0, 'legacy history sits at watermark 0 and produces no phantom increments')
  check(legacyPage.turns.every((turn) => turn.body === undefined && turn.bodyError === undefined), 'missing legacy bodies are never impersonated by their summaries')
  check(legacyPage.turns.find((turn) => turn.id === 'turn_fix_old_1')?.summary === '旧汇报摘要' && legacyPage.turns.find((turn) => turn.id === 'turn_fix_old_2')?.summary === '旧综合摘要', 'legacy summaries remain stored as summaries, not as bodies')
  check(!fs.existsSync(path.join(bodiesRootOf(dirA), 'meeting_fix_legacy')), 'migration writes no body files for legacy turns')

  const appended = storeA.appendTurn({ id: 'turn_fix_new', meetingId: 'meeting_fix_legacy', round: 3, phase: 'defense', agentId: 'captain_a', officeTaskId: 'office_fix_captain_a', status: 'done', summary: '升级后新发言' })
  check(appended.sequence === 1 && appended.version === 1, 'post-adoption turns continue at sequence/version 1 above the zero baseline')
  const increment = storeA.readTurns('meeting_fix_legacy', { afterVersion: 0 })
  check(increment.turns.length === 1 && increment.turns[0].id === 'turn_fix_new' && increment.latestVersion === 1, 'version increments return exactly the post-baseline change')
  check(storeA.readTurns('meeting_fix_legacy').turns.map((turn) => turn.id).join(',') === 'turn_fix_old_1,turn_fix_old_2,turn_fix_new', 'full read orders legacy zero-sequence history before new turns')

  const migratedRaw = JSON.parse(readBytes(indexFileOf(dirA)))
  check(migratedRaw.schemaVersion === 1 && migratedRaw.meetings[0].publicVersion === 0 && migratedRaw.meetings[0].turnVersion === 0, 'migrated index persists explicit zero watermarks at schema 1')
  check(['turn_fix_old_1', 'turn_fix_old_2'].every((id) => {
    const turn = migratedRaw.turns.find((entry) => entry.id === id)
    return !!turn && !('sequence' in turn) && !('version' in turn) && !('publicVersion' in turn)
  }), 'persisted legacy turns were not rewritten with materialized sequence/version')

  // ---------- 场景 B：升级前备份一次写入、永不覆盖 ----------
  scenario('pre-migration backup is written once and never overwritten')
  check(fs.existsSync(preMigrationFileOf(dirA)) && readBytes(preMigrationFileOf(dirA)) === rawBeforeA, 'first adoption backs up the original legacy bytes')
  storeA.updateTurn('meeting_fix_legacy', 'turn_fix_new', { summary: '升级后修订' }, '升级后完整正文')
  check(readBytes(preMigrationFileOf(dirA)) === rawBeforeA, 'normal saves never rewrite the pre-migration backup')
  storeA.reload()
  check(readBytes(preMigrationFileOf(dirA)) === rawBeforeA && storeA.getTurn('meeting_fix_legacy', 'turn_fix_new')?.body === '升级后完整正文', 'reload and subsequent data keep the backup untouched')

  const dirB = path.join(temporary, 'data-b')
  writeIndex(dirB, { schemaVersion: 1, meetings: [legacyMeeting()], turns: [legacyTurn()] })
  fs.writeFileSync(preMigrationFileOf(dirB), JSON.stringify({ ...fixtureA, sentinel: true }))
  const storeB = new MeetingStore(dirB)
  check(JSON.parse(readBytes(preMigrationFileOf(dirB))).sentinel === true, 'an existing pre-migration backup is never overwritten by a later migration')
  check(storeB.get('meeting_fix_legacy')?.publicVersion === 0, 'migration still completes when a backup already exists')

  // ---------- 场景 C：迁移失败可重入 ----------
  scenario('migration failure is deferred and re-entrant')
  const dirC = path.join(temporary, 'data-c')
  const fixtureC = { schemaVersion: 1, meetings: [legacyMeeting()], turns: [legacyTurn()] }
  writeIndex(dirC, fixtureC)
  const rawBeforeC = readBytes(indexFileOf(dirC))
  fs.mkdirSync(path.join(meetingDirOf(dirC), 'index.json.tmp'))
  let deferredConstructorThrew = false
  let storeC
  try { storeC = new MeetingStore(dirC) } catch { deferredConstructorThrew = true }
  check(!deferredConstructorThrew, 'a blocked migration write does not make the store unusable')
  check(storeC.get('meeting_fix_legacy')?.publicVersion === undefined, 'deferred migration keeps read-side zero defaults in memory')
  check(readBytes(indexFileOf(dirC)) === rawBeforeC, 'a failed migration write leaves the legacy index bytes untouched')
  check(readBytes(preMigrationFileOf(dirC)) === rawBeforeC, 'the backup is secured before the first migration write attempt')
  fs.rmSync(path.join(meetingDirOf(dirC), 'index.json.tmp'), { recursive: true, force: true })
  storeC.reload()
  check(storeC.get('meeting_fix_legacy')?.publicVersion === 0 && storeC.get('meeting_fix_legacy')?.turnVersion === 0, 'migration completes on re-entry after the blocker is removed')
  check(readBytes(preMigrationFileOf(dirC)) === rawBeforeC, 're-entry does not duplicate or overwrite the backup')

  const dirC2 = path.join(temporary, 'data-c2')
  writeIndex(dirC2, { schemaVersion: 1, meetings: [legacyMeeting()], turns: [legacyTurn()] })
  const rawBeforeC2 = readBytes(indexFileOf(dirC2))
  const originalCopy = fs.copyFileSync
  fs.copyFileSync = (source, target, ...args) => {
    if (String(target).startsWith(preMigrationFileOf(dirC2) + '.')) {
      fs.writeFileSync(target, '{partial')
      throw Object.assign(new Error('injected backup failure'), { code: 'EPERM' })
    }
    return originalCopy(source, target, ...args)
  }
  let backupFailureThrew = false
  let storeC2
  try { storeC2 = new MeetingStore(dirC2) } catch { backupFailureThrew = true }
  fs.copyFileSync = originalCopy
  check(!backupFailureThrew, 'a failed pre-migration backup does not make the store unusable')
  check(storeC2.get('meeting_fix_legacy')?.publicVersion === undefined && readBytes(indexFileOf(dirC2)) === rawBeforeC2, 'backup failure is fail-closed: no migration and no rewrite before the backup exists')
  check(!fs.existsSync(preMigrationFileOf(dirC2)), 'no partial backup is left behind by a failed backup')
  let unsafeWriteError
  try { storeC2.update('meeting_fix_legacy', { topic: 'unsafe write' }) } catch (error) { unsafeWriteError = error }
  check(unsafeWriteError && readBytes(indexFileOf(dirC2)) === rawBeforeC2, 'backup failure makes mutations fail closed, not merely initialization')
  check(storeC2.get('meeting_fix_legacy')?.topic === legacyMeeting().topic, 'blocked mutations roll back in-memory data')
  storeC2.reload()
  check(storeC2.get('meeting_fix_legacy')?.publicVersion === 0 && readBytes(preMigrationFileOf(dirC2)) === rawBeforeC2, 'retry after backup failure migrates once with the correct backup')

  // ---------- 场景 D：未知 schema 拒写 ----------
  scenario('unknown schema versions are refused without any write')
  const dirD = path.join(temporary, 'data-d')
  fs.mkdirSync(meetingDirOf(dirD), { recursive: true })
  const futureIndex = JSON.stringify({ schemaVersion: 2, meetings: [{ id: 'meeting_fix_future', topic: '更新版本写入的数据' }], turns: [] })
  fs.writeFileSync(indexFileOf(dirD), futureIndex)
  const staleBackup = JSON.stringify({ schemaVersion: 1, meetings: [], turns: [] })
  fs.writeFileSync(path.join(meetingDirOf(dirD), 'index.json.bak'), staleBackup)
  let schemaError = null
  try { new MeetingStore(dirD) } catch (error) { schemaError = error }
  check(schemaError instanceof MeetingIndexSchemaError && schemaError.foundVersion === 2, 'a higher schema version is rejected with the dedicated schema error')
  check(readBytes(indexFileOf(dirD)) === futureIndex, 'the unknown-schema index is never rewritten')
  check(readBytes(path.join(meetingDirOf(dirD), 'index.json.bak')) === staleBackup, 'a stale schema-1 backup never self-heals over newer data')
  check(!fs.existsSync(preMigrationFileOf(dirD)), 'no pre-migration backup is created for rejected data')

  const dirD2 = path.join(temporary, 'data-d2')
  writeIndex(dirD2, { schemaVersion: 1, meetings: [legacyMeeting()], turns: [legacyTurn()] })
  const storeD2 = new MeetingStore(dirD2)
  fs.writeFileSync(indexFileOf(dirD2), futureIndex)
  let reloadError = null
  try { storeD2.reload() } catch (error) { reloadError = error }
  check(reloadError instanceof MeetingIndexSchemaError, 'reload refuses a runtime-swapped unknown-schema index')
  check(storeD2.get('meeting_fix_legacy')?.topic === '历史会议夹具' && storeD2.turns('meeting_fix_legacy').length === 1, 'a failed reload keeps the previous in-memory state instead of an empty store')

  const dirD3 = path.join(temporary, 'data-d3')
  let blockedReloadWrite
  try { storeD2.update('meeting_fix_legacy', { topic: 'unsafe overwrite' }) } catch (error) { blockedReloadWrite = error }
  check(blockedReloadWrite instanceof MeetingIndexSchemaError && readBytes(indexFileOf(dirD2)) === futureIndex, 'failed reload also blocks subsequent writes over the unknown schema')
  writeIndex(dirD2, { schemaVersion: 1, meetings: [legacyMeeting()], turns: [legacyTurn({ version: 9, publicVersion: 4 })] })
  let blockedBodyWrite
  try { storeD2.updateTurn('meeting_fix_legacy', storeD2.turns('meeting_fix_legacy')[0].id, { summary: 'unsafe' }, 'unsafe body') } catch (error) { blockedBodyWrite = error }
  check(blockedBodyWrite instanceof MeetingIndexSchemaError && !fs.existsSync(path.join(meetingDirOf(dirD2), 'body-pending.json')), 'read-only mode blocks body transactions before creating a journal or body')
  storeD2.reload()
  check(storeD2.get('meeting_fix_legacy')?.publicVersion === 4 && storeD2.get('meeting_fix_legacy')?.turnVersion === 9, 'partially upgraded indexes derive missing meeting watermarks from authoritative turns')
  writeIndex(dirD3, { schemaVersion: 1, meetings: [legacyMeeting({ topic: '备份内容' })], turns: [] })
  fs.copyFileSync(indexFileOf(dirD3), path.join(meetingDirOf(dirD3), 'index.json.bak'))
  fs.writeFileSync(indexFileOf(dirD3), '{corrupted')
  const storeD3 = new MeetingStore(dirD3)
  check(storeD3.get('meeting_fix_legacy')?.topic === '备份内容', 'genuinely corrupted indexes still self-heal from the schema-1 backup')

  // ---------- 场景 E：YOU-384 脱敏夹具：缺容器历史可读、不复活、不扩散删除 ----------
  scenario('YOU-384 desensitized fixture: missing container stays readable')
  const dirE = path.join(temporary, 'data-e')
  const meetingYou384 = legacyMeeting({ id: 'meeting_fix_you384', issueId: 'iss_fix_you384', containerTaskId: 't_fix_missing_container', topic: '历史会议（容器任务已缺失）' })
  const turnYou384a = legacyTurn({ id: 'turn_fix_you384_1', meetingId: 'meeting_fix_you384', round: 1, summary: '缺失容器会议的历史发言一' })
  const turnYou384b = legacyTurn({ id: 'turn_fix_you384_2', meetingId: 'meeting_fix_you384', round: 2, phase: 'synthesis', summary: '缺失容器会议的历史发言二' })
  writeIndex(dirE, { schemaVersion: 1, meetings: [meetingYou384], turns: [turnYou384a, turnYou384b] })
  const storeE = new MeetingStore(dirE)
  const loadedYou384 = storeE.get('meeting_fix_you384')
  check(loadedYou384 !== null && loadedYou384.containerTaskId === 't_fix_missing_container', 'a historical meeting with a missing container task loads with its reference preserved verbatim')
  check(loadedYou384.publicVersion === 0 && loadedYou384.turnVersion === 0, 'the missing-container meeting still receives the explicit zero watermarks')
  const you384Page = storeE.readTurns('meeting_fix_you384')
  check(you384Page.turns.length === 2 && you384Page.turns.every((turn) => turn.body === undefined && turn.officeTaskId === 'office_fix_captain_a'), 'its legacy turns stay readable without bodies and keep the shared-office reference')
  let resurrected = false
  try { storeE.appendTurn({ id: 'turn_fix_you384_new', meetingId: 'meeting_fix_you384', round: 3, phase: 'defense', agentId: 'captain_a', officeTaskId: 'office_fix_captain_a', status: 'done', summary: '新发言' }) } catch { resurrected = true }
  check(!resurrected && storeE.turns('meeting_fix_you384').length === 3, 'the store keeps accepting new meeting records; a missing container never blocks storage')
  const bodiesEntriesE = fs.existsSync(bodiesRootOf(dirE)) ? fs.readdirSync(bodiesRootOf(dirE)) : []
  check(!bodiesEntriesE.includes('t_fix_missing_container') && !bodiesEntriesE.includes('office_fix_captain_a'), 'container and office ids never become meeting storage keys')
  check(storeE.delete('meeting_fix_you384') === true && storeE.get('meeting_fix_you384') === null, 'deleting the historical meeting removes its own records')
  const bodiesAfterE = fs.existsSync(bodiesRootOf(dirE)) ? fs.readdirSync(bodiesRootOf(dirE)) : []
  check(!bodiesAfterE.includes('t_fix_missing_container') && !bodiesAfterE.includes('office_fix_captain_a') && !bodiesAfterE.includes('meeting_fix_you384'), 'deletion scope covers only meeting-owned storage, never container or office history')

  // ---------- 场景 F：四条隐藏调查 + 旧共享办公室：逐字保留、不归属、不连带删除 ----------
  scenario('four hidden investigations and the shared office: preserved verbatim, never attributed or deleted')
  const dirF = path.join(temporary, 'data-f')
  const investigationIds = ['t_fix_inv_1', 't_fix_inv_2', 't_fix_inv_3', 't_fix_inv_4']
  const investigationTurns = investigationIds.map((taskId, index) => legacyTurn({
    id: `turn_fix_inv_${index + 1}`, meetingId: 'meeting_fix_inv', round: 1, agentId: `captain_${index}`,
    sessionTaskId: taskId, officeTaskId: 'office_fix_captain_a', summary: `内部调查 ${index + 1}（历史隐藏任务）`
  }))
  const meetingInv = legacyMeeting({ id: 'meeting_fix_inv', issueId: 'iss_fix_inv', topic: '含历史内部调查的会议' })
  const meetingOther = legacyMeeting({ id: 'meeting_fix_other', issueId: 'iss_fix_other', topic: '同办公室的另一场旧会议' })
  const turnOther = legacyTurn({ id: 'turn_fix_other_1', meetingId: 'meeting_fix_other', summary: '另一场会议的共享办公室历史' })
  const fixtureFTurns = [...investigationTurns, turnOther]
  writeIndex(dirF, { schemaVersion: 1, meetings: [meetingInv, meetingOther], turns: fixtureFTurns })
  const rawBeforeF = readBytes(indexFileOf(dirF))
  const storeF = new MeetingStore(dirF)
  for (const fixtureTurn of investigationTurns) {
    const stored = storeF.getTurn('meeting_fix_inv', fixtureTurn.id)
    check(!!stored && JSON.stringify({ ...stored, body: undefined, bodyError: undefined }) === JSON.stringify({ ...fixtureTurn, body: undefined, bodyError: undefined }), `investigation record ${fixtureTurn.sessionTaskId} is preserved verbatim with no new fields`)
  }
  const storedInvestigation = storeF.getTurn('meeting_fix_inv', investigationTurns[0].id)
  check(!!storedInvestigation && Object.keys(storedInvestigation).every((key) => ['body', 'bodyError', 'delivery'].includes(key) || Object.prototype.hasOwnProperty.call(investigationTurns[0], key)), 'stored investigation records gain no ownership or visibility fields beyond the legacy shape')
  const migratedInv = storeF.get('meeting_fix_inv')
  const originalKeys = Object.keys(meetingInv)
  check(migratedInv !== null && Object.keys(migratedInv).every((key) => originalKeys.includes(key) || key === 'publicVersion' || key === 'turnVersion'), 'the migrated meeting gains no field beyond the two watermark fields')
  check(investigationIds.every((taskId) => !fs.existsSync(path.join(bodiesRootOf(dirF), taskId))) && !fs.existsSync(path.join(bodiesRootOf(dirF), 'office_fix_captain_a')), 'investigation and office ids never become storage directories')
  check(readBytes(preMigrationFileOf(dirF)) === rawBeforeF, 'the shared mixed-meeting index is backed up before migration')
  check(storeF.delete('meeting_fix_other') === true, 'a second old meeting sharing the office can be deleted independently')
  check(storeF.turns('meeting_fix_inv').length === 4 && storeF.get('meeting_fix_other') === null, 'deleting one meeting leaves the shared-office history of the other intact')
  check(investigationIds.every((taskId) => !fs.existsSync(path.join(bodiesRootOf(dirF), taskId))), 'cross-meeting deletion never touches investigation-keyed storage')

  // ---------- 场景 G：回退兼容 ----------
  scenario('rollback compatibility of the migrated index')
  const rolledBack = JSON.parse(readBytes(indexFileOf(dirF)))
  check(rolledBack.schemaVersion === 1 && Array.isArray(rolledBack.meetings) && Array.isArray(rolledBack.turns), 'migrated indexes stay parseable schema-1 documents an older build can read')
  check(rolledBack.meetings.every((meeting) => meeting.publicVersion === 0 && meeting.turnVersion === 0), 'explicit zero watermarks are additive optional fields')
  const backupDocument = JSON.parse(readBytes(preMigrationFileOf(dirF)))
  check(backupDocument.schemaVersion === 1 && backupDocument.meetings.length === 2 && backupDocument.turns.length === 5, 'the pre-migration backup preserves the exact pre-upgrade document for rollback')
  const fresh = new MeetingStore(path.join(temporary, 'fresh'))
  fresh.create({ issueId: 'iss_fresh', topic: '新安装', participants: [{ agentId: 'captain_a', role: 'reporter' }] })
  check(!fs.existsSync(preMigrationFileOf(path.join(temporary, 'fresh'))), 'fresh installs never create a pre-migration backup')

  if (process.exitCode) throw new Error('meeting migration regression failed')
  console.log(`\nPASS meeting migration: ${total} checks across watermark initialization, one-time backup, re-entrant failures, unknown-schema refusal, missing-body semantics, YOU-384 and hidden-investigation fixtures, shared-office isolation and rollback compatibility`)
} finally {
  const cleanupPath = path.resolve(temporary)
  if (path.dirname(cleanupPath) !== path.resolve(os.tmpdir()) || !path.basename(cleanupPath).startsWith('agentdeck-meeting-migration-')) throw new Error('unsafe temporary cleanup path')
  fs.rmSync(cleanupPath, { recursive: true, force: true })
}
