import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-meeting-history-'))
let total = 0
const failures = []
const check = (condition, label) => {
  total++
  console.log(`  ${condition ? 'OK' : 'FAIL'} ${label}`)
  if (!condition) {
    process.exitCode = 1
    failures.push(label)
  }
}

try {
  const outfile = path.join(temporary, 'meeting-context.cjs')
  await build({ entryPoints: [path.join(root, 'src/main/meeting-context.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
  const { assembleMeetingContext, chairTurnIds, publicTurns, publicVersion } = await import(pathToFileURL(outfile).href)
  const storeOut = path.join(temporary, 'meeting-store.cjs')
  await build({ entryPoints: [path.join(root, 'src/main/meeting-store.ts')], outfile: storeOut, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
  const { MeetingStore } = await import(pathToFileURL(storeOut).href)
  const meeting = {
    id: 'meeting_history_fixture', topic: 'History assembly fixture', round: 3,
    minutes: [{ round: 2, decisions: [], objections: [], actionItems: [], openQuestions: [], provenance: 'consensus:advisory' }]
  }
  const makeFixture = (details) => {
    const byId = new Map(details.map((turn) => [turn.id, turn]))
    const index = details.map(({ body, bodyError, ...turn }) => turn)
    const store = {
      turns: (meetingId) => meetingId === meeting.id ? index.map((turn) => ({ ...turn })) : [],
      getTurn: (meetingId, turnId) => meetingId === meeting.id && byId.has(turnId) ? { ...byId.get(turnId) } : null
    }
    return { store, details, byId }
  }
  const makeTurn = (id, sequence, body, overrides = {}) => ({
    id, meetingId: meeting.id, round: 3, phase: 'challenge', purpose: 'speech', agentId: 'member',
    officeTaskId: '', status: 'done', sequence, publicVersion: sequence, body,
    speaker: { name: 'Fixture member', role: 'critic', platform: 'smoke' }, ...overrides
  })
  const packetOf = (text) => {
    const marker = text.indexOf('\n> ')
    if (marker < 0 || !text.endsWith('\n')) throw new Error('Unable to locate serialized meeting packet')
    return JSON.parse(text.slice(marker + 3, -1))
  }

  console.log('\n[1000-turn long-history assembly]')
  const benchmarkDetails = []
  for (let index = 0; index < 1000; index++) {
    const id = `turn_${String(index).padStart(4, '0')}`
    const segment = `turn-${index}|quote="|slash=\\|zh=\u4e2d\u6587|emoji=\ud83d\ude42|line\nnext\tend\u0000`
    const body = segment.repeat(Math.ceil(4096 / segment.length))
    const overrides = index === 996 ? { purpose: 'chair', agentId: 'user' }
      : index === 997 ? { phase: 'report' }
        : index === 998 ? { phase: 'defense' }
          : index === 999 ? { phase: 'synthesis' }
            : {}
    benchmarkDetails.push(makeTurn(id, index + 1, body, overrides))
  }
  const failedTurn = makeTurn('failed_high_version', 1001, undefined, { status: 'failed', publicVersion: 9001, sequence: 1001 })
  const fixture = makeFixture([...benchmarkDetails.slice().reverse(), failedTurn])
  const sourceIds = benchmarkDetails.map((turn) => turn.id)
  const objections = [
    { id: 'open', text: 'Unresolved', ref: 'fixture', raisedBy: 'member', priority: 'high', resolved: false, sourceTurnId: sourceIds[0], replyTurnId: sourceIds[1] },
    { id: 'closed', text: 'Resolved', ref: 'fixture', raisedBy: 'member', priority: 'normal', resolved: true, sourceTurnId: sourceIds[2] }
  ]
  const draft = { version: 'draft-confirmation-8', envelope: { decisions: ['pending \u786e\u8ba4'], objections: [], actionItems: [], openQuestions: [] } }
  const originalBodies = new Map(benchmarkDetails.map((turn) => [turn.id, turn.body]))
  const inputBodyCodeUnits = benchmarkDetails.reduce((sum, turn) => sum + turn.body.length, 0)
  const fullPacketCounts = []
  const elapsed = []
  let baseline
  let benchmarkPacket
  for (let iteration = 0; iteration < 4; iteration++) {
    const nativeStringify = JSON.stringify
    let packetStringifies = 0
    JSON.stringify = function (value, replacer, space) {
      if (value && typeof value === 'object' && value.schemaVersion === 1 && Array.isArray(value.history)) packetStringifies++
      return nativeStringify.call(JSON, value, replacer, space)
    }
    const started = performance.now()
    let result
    try {
      result = assembleMeetingContext(fixture.store, meeting, objections, draft)
    } finally {
      elapsed.push(performance.now() - started)
      JSON.stringify = nativeStringify
    }
    fullPacketCounts.push(packetStringifies)
    if (!baseline) {
      baseline = result
      benchmarkPacket = packetOf(result.text)
    } else {
      check(result.text === baseline.text, `iteration ${iteration + 1} reproduces identical context`)
      check(JSON.stringify(result.delivery) === JSON.stringify(baseline.delivery), `iteration ${iteration + 1} reproduces identical audit metadata`)
    }
  }

  const protectedIds = [sourceIds[0], sourceIds[1], 'turn_0996', 'turn_0997', 'turn_0998', 'turn_0999']
  const data = path.join(temporary, 'real-store')
  const bodies = path.join(data, 'meetings/bodies', meeting.id)
  fs.mkdirSync(bodies, { recursive: true })
  const indexed = fixture.details.map(({ body, ...turn }) => ({ ...turn, version: turn.sequence, bodyVersion: body === undefined ? undefined : turn.sequence }))
  for (const turn of fixture.details) if (turn.body !== undefined) fs.writeFileSync(path.join(bodies, turn.id + '.json'), JSON.stringify({ schemaVersion: 1, meetingId: meeting.id, turnId: turn.id, body: turn.body, bodyVersion: turn.sequence, updatedAt: 1 }))
  fs.writeFileSync(path.join(data, 'meetings/index.json'), JSON.stringify({ schemaVersion: 1, meetings: [{ ...meeting, turnVersion: 1001, publicVersion: 9001 }], turns: indexed }))
  const realStore = new MeetingStore(data)
  const realStarted = performance.now()
  const realContext = assembleMeetingContext(realStore, meeting, objections, draft)
  const realElapsedMs = performance.now() - realStarted
  check(realContext.text === baseline.text, 'real filesystem-backed store assembles the same 1000-turn public packet')
  let page = realStore.readTurns(meeting.id, { limit: 200 })
  const pagedIds = page.turns.map((turn) => turn.id)
  let pages = 1
  while (page.hasMore) {
    page = realStore.readTurns(meeting.id, { limit: 200, cursor: page.nextCursor })
    pagedIds.push(...page.turns.map((turn) => turn.id))
    pages++
  }
  check(pagedIds.length === 1001 && new Set(pagedIds).size === 1001 && pages === 6, 'fixed-watermark real-store pagination includes every indexed turn exactly once')
  const indexBytes = JSON.stringify(realStore.turns(meeting.id)).length
  check(!JSON.stringify(realStore.list()).includes('quote=') && indexBytes < inputBodyCodeUnits / 8, 'list and broadcast metadata exclude multi-megabyte authoritative bodies')
  const boundedStarted = performance.now()
  const defaultContext = assembleMeetingContext(realStore, meeting, objections, draft)
  check(defaultContext.text.length > 4_000_000 && defaultContext.delivery.sourceTurnIds.length === 1000, 'default assembly permits all multi-megabyte history and retains complete source audit')
  check(defaultContext.text === baseline.text && defaultContext.delivery.compression.keptLength === defaultContext.delivery.compression.originalLength, 'default path has no hidden character target or automatic truncation')
  console.log(JSON.stringify({ realStoreAssemblyMs: realElapsedMs, defaultAssemblyMs: performance.now() - boundedStarted, indexBytes, inputBodyCodeUnits, pages }))
  const historyById = new Map(benchmarkPacket.history.map((turn) => [turn.id, turn]))
  check(baseline.text.length === baseline.delivery.compression.originalLength, 'the entire original packet is delivered without a host character limit')
  check(baseline.delivery.sourceTurnIds.length === 1000 && baseline.delivery.sourceTurnIds.every((id, index) => id === sourceIds[index]), 'source IDs include all done turns in stable sequence order')
  check(baseline.delivery.publicVersion === 9001 && publicVersion(fixture.store, meeting.id) === 9001, 'one public version includes the maximum version across indexed turns')
  check(baseline.delivery.chairTurnIds.length === 1 && baseline.delivery.chairTurnIds[0] === 'turn_0996' && chairTurnIds(fixture.store, meeting.id).join() === 'turn_0996', 'chair IDs remain available and stable')
  check(publicTurns(fixture.store, meeting.id).length === 1000, 'publicTurns remains an available complete export')
  check(protectedIds.every((id) => historyById.get(id)?.body === originalBodies.get(id)), 'chair, latest report/defense/synthesis, and unresolved objection turns stay complete')
  check(protectedIds.every((id) => !baseline.delivery.compressions.some((entry) => entry.source === id) && !baseline.delivery.omittedTurnIds.includes(id)), 'protected turns never enter compression or omission audit')
  check(baseline.text.includes(draft.version) && baseline.text.includes(draft.envelope.decisions[0]), 'pending confirmation draft remains in the assembled context')
  check(baseline.delivery.compressions.length === 0 && baseline.delivery.omittedTurnIds.length === 0, 'long-history assembly neither excerpts nor omits any public turn')
  check(benchmarkDetails.every((turn) => fixture.byId.get(turn.id).body === originalBodies.get(turn.id)), 'assembly never mutates stored source bodies')

  const compressionBySource = new Map(baseline.delivery.compressions.map((entry) => [entry.source, entry]))
  const auditConsistent = benchmarkDetails.every((turn) => historyById.get(turn.id)?.representation === 'complete' && historyById.get(turn.id)?.body === originalBodies.get(turn.id))
  check(auditConsistent, 'all 1000 bodies, including old non-protected turns, are complete in the actual serialized payload')
  check(fullPacketCounts.every((count) => count === 1), 'each assembly serializes the full packet once without a quadratic truncation loop')

  console.log('\n[escaping, missing-body, and overflow compatibility]')
  const specialBody = 'quote=" backslash=\\ newline\n tab\t nul\u0000 unicode=\u4e2d\u6587\ud83d\ude42'
  const specialFixture = makeFixture([makeTurn('special_chair', 1, specialBody, { purpose: 'chair', agentId: 'user' })])
  const special = assembleMeetingContext(specialFixture.store, meeting, [])
  check(packetOf(special.text).history[0].body === specialBody, 'JSON escapes and Unicode round-trip without changing the source body')

  const missingFixture = makeFixture([makeTurn('missing_public_body', 1, undefined)])
  let missingRejected = false
  try { assembleMeetingContext(missingFixture.store, meeting, []) } catch { missingRejected = true }
  check(missingRejected, 'a public version with unavailable body fails explicitly instead of fabricating text')

  const legacyFixture = makeFixture([makeTurn('legacy_without_body', 1, undefined, { publicVersion: undefined, summary: 'legacy index summary' })])
  const legacy = packetOf(assembleMeetingContext(legacyFixture.store, meeting, []).text).history[0]
  check(legacy.bodyAvailable === false && legacy.historicalSummary === 'legacy index summary', 'legacy records without bodies retain only their explicit historical summary')

  const overflowFixture = makeFixture([
    makeTurn('protected_chair_overflow', 1, 'chair-protected-'.repeat(100), { purpose: 'chair', agentId: 'user' }),
    makeTurn('protected_latest_overflow', 2, 'latest-protected-'.repeat(100), { phase: 'report' })
  ])
  const overflowContext = assembleMeetingContext(overflowFixture.store, meeting, [])
  check(overflowContext.text.includes('chair-protected-'.repeat(100)) && overflowContext.text.includes('latest-protected-'.repeat(100)), 'protected material remains complete with no host context limit')
  check(overflowContext.delivery.protectedTurnIds.includes('protected_chair_overflow') && overflowContext.delivery.protectedTurnIds.includes('protected_latest_overflow') && overflowContext.delivery.omittedTurnIds.length === 0, 'overflow audit preserves protected IDs without silently omitting them')

  const sortedTimes = elapsed.slice(1).sort((first, second) => first - second)
  const medianMs = sortedTimes[Math.floor(sortedTimes.length / 2)]
  console.log(`\nMETRICS ${JSON.stringify({ iterations: elapsed.length, measuredIterations: sortedTimes.length, sourceTurns: benchmarkDetails.length, sourceBodyCodeUnits: inputBodyCodeUnits, originalContextChars: baseline.delivery.compression.originalLength, finalContextChars: baseline.text.length, compressedTurns: compressionBySource.size, omittedTurns: baseline.delivery.omittedTurnIds.length, fullPacketStringifiesPerAssembly: fullPacketCounts[0], medianMs: Number(medianMs.toFixed(2)) })}`)
} finally {
  fs.rmSync(temporary, { recursive: true, force: true })
}

console.log(`\n${total - failures.length}/${total} checks passed`)
if (failures.length) console.error(`Failed: ${failures.join('; ')}`)
