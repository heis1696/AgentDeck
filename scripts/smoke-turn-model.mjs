// Renderer event-merge smoke: exercise the pure turn model without Electron.
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const outfile = path.join(root, 'out', 'smoke-turn-model.cjs')
const mergeOutfile = path.join(root, 'out', 'smoke-event-merge.cjs')
await build({
  entryPoints: [path.join(root, 'src/renderer/src/hooks/turnModel.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['react']
})
await build({
  entryPoints: [path.join(root, 'src/renderer/src/hooks/eventMerge.ts')],
  outfile: mergeOutfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18'
})
const { buildTurns } = await import(pathToFileURL(outfile).href)
const { mergeTaskEvents } = await import(pathToFileURL(mergeOutfile).href)
const ok = (condition, label) => {
  console.log(`  ${condition ? '✓' : '✗'} ${label}`)
  if (!condition) process.exitCode = 1
}
const event = (seq, kind, text, data) => ({ seq, ts: seq, kind, ...(text === undefined ? {} : { text }), ...(data === undefined ? {} : { data }) })

const merged = mergeTaskEvents([event(2, 'text', 'old'), event(1, 'user', 'first')], [event(2, 'text', 'new'), event(3, 'final', 'done')])
ok(merged.map((item) => item.seq).join(',') === '1,2,3' && merged[1].text === 'new', 'live events replace duplicate seq and remain ordered')

const turns = buildTurns([
  event(1, 'user', '首轮任务'),
  event(2, 'text', '流式 '),
  event(3, 'text', '回复'),
  event(4, 'tool', 'read_file', { phase: 'started' }),
  event(5, 'tool', 'read_file', { phase: 'result', ok: true }),
  event(6, 'usage', undefined, { inputTokens: 10, outputTokens: 5 }),
  event(7, 'final', '流式 回复'),
  event(8, 'user', '追问'),
  event(9, 'text', '第二轮'),
  event(10, 'final', '第二轮')
], 'fallback prompt')
ok(turns.length === 2, 'user events split independent turns')
ok(turns[0].items.filter((item) => item.type === 'work').length === 1, 'tool events merge into one work block')
ok(turns[0].items.filter((item) => item.type === 'final').length === 1, 'final matching streamed text is not duplicated')
ok(turns[0].usage?.inputTokens === 10 && turns[0].usage?.outputTokens === 5, 'usage event is attached to its turn')
ok(turns[1].items.some((item) => item.type === 'final' && item.text === '第二轮'), 'later final response is preserved')

const implicit = buildTurns([event(1, 'text', 'a'), event(2, 'final', 'b')], 'implicit')
ok(implicit.length === 1 && implicit[0].userText === 'implicit', 'prompt fills an event stream without user marker')
if (!process.exitCode) console.log('\n✅ TURN MODEL SMOKE PASSED')
