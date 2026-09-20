// Renderer event-merge smoke: exercise the pure turn model without Electron.
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'

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

const mergeReference = (current, incoming) => {
  if (!incoming.length) return current
  const bySeq = new Map()
  for (const item of [...current, ...incoming]) bySeq.set(item.seq, item)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}
const mergeCases = [
  [[], [event(3, 'text', 'a')]],
  [[event(1, 'text', 'a')], []],
  [[event(1, 'text', 'a')], [event(2, 'text', 'b'), event(3, 'text', 'c')]],
  [[event(1, 'text', 'a'), event(3, 'text', 'c')], [event(2, 'text', 'b')]],
  [[event(1, 'text', 'a'), event(3, 'text', 'c')], [event(3, 'text', 'new')]],
  [[event(1, 'text', 'a'), event(3, 'text', 'c')], [event(0, 'user', 'start'), event(3, 'final', 'replacement')]],
  [[event(2, 'text', 'a'), event(1, 'text', 'b'), event(2, 'text', 'c')], [event(2, 'text', 'd'), event(0, 'user', 'start'), event(2, 'final', 'last')]]
]
let seed = 1729
const random = (limit) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit }
for (let i = 0; i < 300; i++) {
  let current = Array.from({ length: random(80) }, (_, n) => event(random(100), 'text', `current-${n}`))
  let incoming = Array.from({ length: random(25) }, (_, n) => event(random(100), 'text', `incoming-${n}`))
  if (i % 3) current = mergeReference([], current)
  if (i % 2) incoming = mergeReference([], incoming)
  mergeCases.push([current, incoming])
}
for (const [current, incoming] of mergeCases) {
  const before = structuredClone([current, incoming])
  Object.freeze(current)
  Object.freeze(incoming)
  const result = mergeTaskEvents(current, incoming)
  assert.deepEqual(result, mergeReference(current, incoming))
  assert.deepEqual([current, incoming], before)
  if (!incoming.length) assert.equal(result, current)
}
ok(true, `${mergeCases.length} differential merges preserve ordering, replacement and input immutability`)

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

// 流式回复被中途 status 工作项切碎（真实事故 YOU-85：子任务在领队流式中提前接单，
// runner 发「⚡ 已接单」status 关闭了正在流式的气泡），终态只含最后一条消息全文：
// 之前的碎片必须被终态吸收，否则同一回复显示两遍。注意回合里必须有更早的中间消息，
// 否则整回合包含判断（fullFinal ⊇ fullStreamed）会先兜住、测不到该路径。
const split = buildTurns([
  event(1, 'user', '带队修 bug'),
  event(2, 'text', '先看结构。'),
  event(3, 'tool', 'Bash', { phase: 'started' }),
  event(4, 'tool', 'Bash', { phase: 'result', ok: true }),
  event(5, 'text', '根因定位完毕，现在派发修复：'),
  event(6, 'text', '<delegate to="zcode">实现补丁</delegate>'),
  event(7, 'status', '⚡ 已接单：ZCode ← 实现补丁'),
  event(8, 'text', ' <round outcome="action"/>'),
  event(9, 'final', '根因定位完毕，现在派发修复：<delegate to="zcode">实现补丁</delegate> <round outcome="action"/>')
], 'x')
ok(split[0].items.filter((item) => item.type === 'text' || item.type === 'final').length === 2, 'status-split fragments of the last message absorb into one final (no duplicate reply)')
ok(split[0].items.some((item) => item.type === 'final' && item.text.startsWith('根因定位完毕')), 'surviving bubble is the single final')
ok(split[0].items.some((item) => item.type === 'text' && item.text === '先看结构。'), 'earlier message bubble is preserved')
ok(split[0].items.some((item) => item.type === 'work' && item.work.some((workEvent) => workEvent.kind === 'status')), 'mid-stream status note survives as a work block')

// 终态不包含流式碎片（两段互不相干）：不得误吸收，宁可并存也不丢内容
const unrelated = buildTurns([
  event(1, 'user', '任务'),
  event(2, 'text', '流式残片'),
  event(3, 'status', '⚡ 已接单：X ← foo'),
  event(4, 'text', '尾段'),
  event(5, 'final', '终态是别的内容')
], 'x')
ok(unrelated[0].items.some((item) => item.type === 'text' && item.text === '流式残片'), 'fragments not contained in the final are kept')
ok(unrelated[0].items.some((item) => item.type === 'final' && item.text === '终态是别的内容'), 'unrelated final still lands once')

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
