import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-meeting-public-ipc-'))
const handlers = new Map()
globalThis.meetingPublicIpcHandlers = handlers
let count = 0
const check = (condition, label) => {
  count++
  console.log(`  ${condition ? 'OK' : 'FAIL'} ${label}`)
  if (!condition) process.exitCode = 1
}
const rejects = (callback) => { try { callback(); return false } catch { return true } }
try {
  const outfile = path.join(temporary, 'ipc.cjs')
  await build({ entryPoints: [path.resolve('src/main/ipc/meetings.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', plugins: [{ name: 'fixture-electron', setup(plugin) {
    plugin.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture-electron' }))
    plugin.onLoad({ filter: /.*/, namespace: 'fixture-electron' }, () => ({ contents: 'export const ipcMain = { handle: (channel, handler) => globalThis.meetingPublicIpcHandlers.set(channel, handler) }', loader: 'js' }))
  } }] })
  const { parseMeetingTurnQuery, registerMeetingIpc } = await import(pathToFileURL(outfile).href)
  check(Object.keys(parseMeetingTurnQuery(undefined)).length === 0, 'missing optional query becomes a default page')
  const query = { afterSequence: 0, afterVersion: 7, limit: 2, cursor: 'cursor' }
  check(JSON.stringify(parseMeetingTurnQuery(query)) === JSON.stringify(query), 'validated query preserves the incremental and pagination parameters')
  for (const input of [null, [], 'query', { body: true }, { afterVersion: -1 }, { afterVersion: 1.5 }, { afterSequence: Number.MAX_SAFE_INTEGER + 1 }, { limit: 0 }, { limit: 501 }, { limit: NaN }, { cursor: '' }, { cursor: 7 }, { cursor: 'x'.repeat(2049) }]) {
    check(rejects(() => parseMeetingTurnQuery(input)), `invalid public-query shape rejected: ${JSON.stringify(input)?.slice(0, 80)}`)
  }
  const calls = []
  const page = { meetingId: 'meeting_fixture', turns: [], latestVersion: 9, hasMore: false }
  const controller = {
    readTurns: (...args) => { calls.push(['read', ...args]); return page },
    getTurn: (...args) => { calls.push(['detail', ...args]); return null },
    memberExecutions: (...args) => { calls.push(['member', ...args]); return null },
    retryMirrors: (...args) => { calls.push(['mirror', ...args]); return { ok: false, error: 'retained mirror failure', meeting: { body: 'must not broadcast' } } }
  }
  registerMeetingIpc({ meetingController: controller, getWindow: () => null })
  check(handlers.get('meetings:read-turns')(null, 'meeting_fixture', { afterVersion: 7, limit: 2 }) === page && calls.at(-1)[2].afterVersion === 7, 'public page route forwards the validated version query and returned watermark')
  check(handlers.get('meetings:get-turn')(null, 'meeting_fixture', 'speech_fixture') === null && calls.at(-1).join() === 'detail,meeting_fixture,speech_fixture', 'detail route keeps both meeting and source-turn identity')
  check(handlers.get('meetings:member-executions')(null, 'meeting_fixture', 'alpha') === null && calls.at(-1).join() === 'member,meeting_fixture,alpha', 'member execution route forwards meeting-scoped identity')
  const mirrorResult = handlers.get('meetings:retry-mirrors')(null, 'meeting_fixture')
  check(mirrorResult.ok === false && mirrorResult.error === 'retained mirror failure' && !('meeting' in mirrorResult), 'mirror retry returns honest status without broadcasting authority bodies')
  check(rejects(() => handlers.get('meetings:read-turns')(null, 7, {})), 'page route rejects a non-string meeting id')
  check(rejects(() => handlers.get('meetings:get-turn')(null, 'meeting_fixture', '')), 'detail route rejects an empty turn id')
  check(rejects(() => handlers.get('meetings:member-executions')(null, 'meeting_fixture', null)), 'member route rejects an invalid agent id')
  console.log(`${process.exitCode ? 'FAIL' : 'PASS'} public meeting IPC: ${count} checks`)
} finally {
  delete globalThis.meetingPublicIpcHandlers
  const resolved = path.resolve(temporary)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('agentdeck-meeting-public-ipc-')) throw new Error('unsafe fixture cleanup')
  fs.rmSync(resolved, { recursive: true, force: true })
}
