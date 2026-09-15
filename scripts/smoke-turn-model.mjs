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

// 截断残影场景（真实事故：服务端流中途断流，终态补发完整全文）：
// 流式文本在 <delegate> 标签中途断掉，状态事件关闭气泡，终态带来闭合后的完整全文。
// 断言：残影气泡被收敛，只留一个含完整标记的终态气泡。
const partial = '审计完成 <delegate to="zcode" reason="r">单A</delegate> <delegate to="dsh" reason="r2">目标：视觉'
const full = '审计完成 <delegate to="zcode" reason="r">单A</delegate> <delegate to="dsh" reason="r2">目标：视觉层级与交互打磨</delegate>'
const truncated = buildTurns([
  event(1, 'user', '回灌'),
  event(2, 'tool', 'view', { phase: 'started' }),
  event(3, 'tool', 'view', { phase: 'result', ok: true }),
  event(4, 'text', partial),
  event(5, 'status', 'session:thinking'),
  event(6, 'final', full)
], 'x')
ok(truncated.length === 1, 'truncated stream stays in one turn')
ok(truncated[0].items.filter((item) => item.type === 'text' || item.type === 'final').length === 1, 'truncated partial bubble collapses into the final (no duplicate reply)')
ok(truncated[0].items.some((item) => item.type === 'final' && item.text === full), 'surviving bubble carries the complete final text')
ok(truncated[0].items.filter((item) => item.type === 'work').length === 2, 'work blocks around the bubble are preserved')

// 多消息回合：终态只含最后一条消息（zcode 语义），前一条消息的气泡必须保留
const multi = buildTurns([
  event(1, 'user', '任务'),
  event(2, 'text', '第一段中间回复'),
  event(3, 'tool', 'Bash', { phase: 'started' }),
  event(4, 'tool', 'Bash', { phase: 'result', ok: true }),
  event(5, 'text', '第二段最终汇报'),
  event(6, 'final', '第二段最终汇报')
], 'x')
ok(multi[0].items.filter((item) => item.type === 'text' || item.type === 'final').length === 2, 'last-message final keeps the earlier message bubble')
ok(multi[0].items.filter((item) => item.type === 'final').length === 1 && multi[0].items[0].type === 'text', 'last open text is promoted to the final')

// 空 final（zcode 以 response || error || '' 兜底发出）：已流式的正文必须保留，只收口
const blankFinal = buildTurns([
  event(1, 'user', '任务'),
  event(2, 'text', '这段回复必须留下'),
  event(3, 'final', '   ')
], 'x')
ok(blankFinal[0].items.some((item) => item.type === 'text' && item.closed && item.text === '这段回复必须留下'), 'blank final closes the streamed bubble instead of wiping it')
ok(!blankFinal[0].items.some((item) => item.type === 'final'), 'blank final does not create an empty final bubble')

// 复述去重：领队在回灌评估回合复述旧派单标记，展示层只保留首张卡片；新单不受影响
const restated = buildTurns([
  event(1, 'user', '带队'),
  event(2, 'text', '开工 <delegate to="zcode" reason="r">实现 A</delegate>'),
  event(3, 'final', '开工 <delegate to="zcode" reason="r">实现 A</delegate>'),
  event(4, 'text', '评估：单已交付 <delegate to="zcode" reason="r">实现 A</delegate>，另派 <delegate to="dsh" reason="n">实现 B</delegate>'),
  event(5, 'final', '评估：单已交付 <delegate to="zcode" reason="r">实现 A</delegate>，另派 <delegate to="dsh" reason="n">实现 B</delegate>')
], 'x')
const countMarker = (marker) => restated.flatMap((turn) => turn.items).filter((item) => item.type !== 'work').reduce((n, item) => n + item.text.split(marker).length - 1, 0)
ok(countMarker('<delegate to="zcode"') === 1, 'restated delegate marker is stripped (first occurrence kept)')
ok(countMarker('<delegate to="dsh"') === 1, 'fresh delegate marker in a later turn is preserved')
ok(restated[1].items.some((item) => item.type === 'final' && item.text.includes('评估：单已交付')), 'surrounding prose of a restated marker survives')
if (!process.exitCode) console.log('\n✅ TURN MODEL SMOKE PASSED')
