import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
globalThis.window = { agentdeck: {} }
const outfile = path.join(root, 'out/smoke-worker-rounds.cjs')
await build({ stdin: { contents: [
  "export { buildWorkerRounds } from './src/renderer/src/components/task/workerRounds'",
  "export { buildTurns } from './src/renderer/src/hooks/turnModel'",
  "export { WorkerOverview } from './src/renderer/src/components/task/WorkerOverview'",
  "export { GitSummary } from './src/renderer/src/components/task/GitSummary'"
].join('\n'), resolveDir: root, loader: 'tsx' }, outfile, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime', 'lucide-react'] })
const { buildWorkerRounds, buildTurns, WorkerOverview, GitSummary } = await import(pathToFileURL(outfile).href)
const event = (seq, ts, kind) => ({ seq, ts, kind, text: `event-${seq}` })
const events = [event(1, 1000, 'user'), event(2, 1100, 'final'), event(3, 2000, 'user'), event(4, 2500, 'text'), event(5, 3000, 'user'), event(6, 3100, 'final')]
const task = (id, createdAt, status, extra = {}) => ({ id, createdAt, status, title: id, prompt: id, workdir: 'C:/fixture', backend: 'zcode', eventCount: 0, workerIndex: 99, ...extra })
const workers = [task('early', 500, 'done'), task('one', 1200, 'done'), task('two', 1800, 'failed'), task('three', 2100, 'running'), task('four', 2200, 'queued'), task('five', 2300, 'queued', { parked: true }), task('six', 3300, 'cancelled')]
const turns = buildTurns(events, 'prompt')
const rounds = buildWorkerRounds(workers, turns, events)
assert.deepEqual(rounds.map((round) => round.label), ['回合 3', '回合 2', '回合 1', '未分类记录'])
assert.deepEqual(rounds[1].active.map((worker) => worker.id), ['three'])
assert.deepEqual(rounds[1].queued.map((worker) => worker.id), ['four'])
assert.deepEqual(rounds[1].parked.map((worker) => worker.id), ['five'])
assert.equal(rounds[2].ended.length, 2)
assert.equal(rounds[0].ended[0].id, 'six')
assert.equal(new Set(rounds.flatMap((round) => round.workers.map((worker) => worker.id))).size, workers.length)
assert.equal(buildWorkerRounds(workers, [], [])[0].workers.length, workers.length)
assert.equal(buildWorkerRounds(workers, [], [])[0].unclassified, true)
assert.equal(buildWorkerRounds([...workers, workers[0]], turns, events).flatMap((round) => round.workers).length, workers.length)

const completed = workers.map((worker) => ({ ...worker, status: 'done' }))
const endedRounds = buildWorkerRounds(completed, turns, events)
assert(endedRounds.every((round) => round.active.length + round.queued.length + round.parked.length === 0))
const dom = new JSDOM(renderToStaticMarkup(createElement(WorkerOverview, { rounds: endedRounds, onOpen() {} })))
assert.equal(dom.window.document.querySelectorAll('.worker-round-ended [data-worker-id]').length, workers.length)
assert.equal(dom.window.document.querySelectorAll('.worker-round-active').length, 0)
assert(dom.window.document.querySelector('.worker-round-ended').open)
dom.window.close()

const missing = events.map((item) => item.seq === 3 ? { ...item, ts: 0 } : item)
assert(buildWorkerRounds([task('uncertain', 1500, 'done')], buildTurns(missing), missing)[0].unclassified, 'Missing boundaries cannot extend the preceding round')
const tied = [event(1, 1000, 'user'), event(2, 1000, 'user')]
assert(buildWorkerRounds([task('tie', 1000, 'done')], buildTurns(tied), tied)[0].unclassified)
assert.equal(buildWorkerRounds([task('after-tie', 1100, 'done')], buildTurns(tied), tied)[0].label, '回合 2')
const backwards = [event(1, 2000, 'user'), event(2, 1000, 'user')]
assert(buildWorkerRounds([task('clock-change', 2500, 'done')], buildTurns(backwards), backwards)[0].unclassified)

const patch = 'diff --git a/test.ts b/test.ts\n--- a/test.ts\n+++ b/test.ts\n@@ -1 +1 @@\n-old\n+new\n'
for (const [status, extra, expected] of [
  ['running', {}, 'executing'], ['queued', { parked: true }, 'executing'], ['done', {}, 'unavailable'],
  ['done', { gitDiff: null, gitStat: null }, 'unavailable'],
  ['done', { gitDiff: '', gitStat: '' }, 'unavailable'], ['done', { gitDiff: patch }, 'available'],
  ['running', { gitDiff: patch }, 'available'], ['done', { gitStat: 'test.ts | 1 +' }, 'available']
]) {
  const page = new JSDOM(renderToStaticMarkup(createElement(GitSummary, { task: task('git', 1000, status, extra) })))
  const pane = page.window.document.querySelector('.git-pane')
  assert.equal(pane.dataset.snapshotState, expected)
  if (expected === 'unavailable' || expected === 'executing') assert(!pane.textContent.includes('无改动'))
  if (status === 'queued') assert(pane.textContent.includes('等待执行'))
  if (extra.gitDiff) assert(page.window.document.querySelector('.diff-file'))
  page.window.close()
}
console.log('WORKER ROUND SMOKE PASSED: turn grouping, final completion, unknown boundaries, duplicate ids, clock ambiguity and Git snapshot states')
