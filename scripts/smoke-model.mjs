// 委派截获回归（AGENT-PROFILES-PLAN Phase 0）：
// 真实事故（2026-09-07，任务 t_mtq13pd1_xy5y6t）：zcode 回合终态全文（含未流式的
// 思考内容）比流式累计更长却不含中间消息里的 <delegate> 标记，旧逻辑按"长度取长"
// 二选一丢弃了含标记来源 → 委派静默失效（roundsUsed=0、无子任务）。
// 修复：zcode.ts mergeTurnTexts 两源并集 + delegate.ts parseDelegatesMerged 多源去重。
// Phase 1 将在本文件扩展 buildRuntimeModelFromCliConfig（agent 级模型覆盖）用例。
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
for (const [src, out] of [
  ['src/main/delegate.ts', 'out/sm-delegate.cjs'],
  ['src/main/backends/zcode.ts', 'out/sm-zcode.cjs']
]) {
  await build({ entryPoints: [path.join(root, src)], outfile: path.join(root, out), bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
}
const { parseDelegates, parseDelegatesMerged } = await import(pathToFileURL(path.join(root, 'out/sm-delegate.cjs')).href)
const { mergeTurnTexts } = await import(pathToFileURL(path.join(root, 'out/sm-zcode.cjs')).href)

const assert = (cond, msg) => { if (!cond) { console.error('❌', msg); process.exit(1) } console.log('  ✓', msg) }

// ---- mergeTurnTexts：两源关系三分支 ----
assert(mergeTurnTexts('abc', '') === 'abc', 'mergeTurnTexts：流式为空取终态全文')
assert(mergeTurnTexts('abc', 'b') === 'abc', 'mergeTurnTexts：终态包含流式取终态')
assert(mergeTurnTexts('b', 'abc') === 'abc', 'mergeTurnTexts：流式包含终态取流式')

// ---- 事故重建：终态更长（思考内容撑长）但不含标记；标记只在流式累计里 ----
const streamed = '我先派两个队员。\n<delegate to="DeepSeek" reason="调研">分析 cc-switch</delegate>\n<delegate to="Claude">梳理 UI 改造点</delegate>\n\n两个子任务已派出，等结果。'
const lastMessage = '两个子任务已派出，等结果。'
const full = `（思考：需要并行调研，先拆两块……）${'（此段不流式展示，仅存在于终态）'.repeat(40)}\n${lastMessage}`
assert(full.length > streamed.length, '前置：终态全文确实更长（旧逻辑会选中它）')
assert(parseDelegates(full).length === 0, '前置：旧口径（只看终态全文）解析为 0 —— 事故根因')
const scan = mergeTurnTexts(full, streamed)
assert(scan.includes('<delegate'), 'mergeTurnTexts：互不包含时拼接，标记不再丢失')
const calls = parseDelegatesMerged(scan, lastMessage)
assert(calls.length === 2, `并集多源解析找回两个委派（${calls.length}）`)
assert(calls[0].to === 'DeepSeek' && calls[0].reason === '调研' && calls[0].prompt.includes('cc-switch'), '第一个委派完整（to/reason/prompt）')
assert(calls[1].to === 'Claude' && calls[1].reason === undefined, '第二个委派 reason 可省略')

// ---- 去重与边界 ----
assert(parseDelegatesMerged(streamed, streamed).length === 2, '同一标记出现在多个来源只计一次')
assert(parseDelegatesMerged('', 'x <delegate to="甲">A</delegate> y').length === 1, '空来源安全')
assert(parseDelegatesMerged().length === 0, '无来源返回空')
assert(parseDelegates(streamed).length === 2, 'parseDelegates 单源行为不变')

// ---- 正常路径不受影响：终态 ≈ 流式（互相包含）时不拼接、不重复 ----
const normal = '正文。<delegate to="甲">A</delegate>'
assert(mergeTurnTexts(normal, normal) === normal, '两源相同直接返回，不翻倍')
assert(mergeTurnTexts('甲。\n\n乙。', '甲。乙。') === '甲。\n\n乙。', '互含（空白不敏感）取终态全文——保真消息分隔（final-dedup 契约）')
assert(mergeTurnTexts('', streamed) === streamed, '终态为空守卫：返回流式累计')

console.log('\n✅ DELEGATION INTERCEPTION SMOKE PASSED')
process.exit(0)
