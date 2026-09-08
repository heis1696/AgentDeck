// 冒烟测试：委派协议升级（对照 CHANGELOG Unreleased）
// 覆盖：幻影吞单防护（裸标记字样不吞真实派单）、<round> 评估标记解析/剥除、
//       <continue> 多行简报正则修复、多源去重回归。纯函数断言，无需假服务器。
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const outfile = path.join(root, 'out', 'smoke-round.cjs')
await build({
  entryPoints: [path.join(root, 'src/main/delegate.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['electron']
})
const d = await import(pathToFileURL(outfile).href)

let failed = 0
const check = (name, cond, detail) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : ` (got ${JSON.stringify(detail)})`}`)
  if (!cond) failed++
}

console.log('— 幻影吞单防护（开标签必须带 to 才构成匹配）—')
{
  // 裸开标签自闭合（代码块演示）：真实派单不受影响
  const t = '示例如下：<delegate>演示用裸标签</delegate>\n正式派单：<delegate to="Y">任务B</delegate>'
  const calls = d.parseDelegates(t)
  check('裸标签自闭合不产生派单、真实派单保留', calls.length === 1 && calls[0].to === 'Y' && calls[0].prompt === '任务B', calls)

  // 裸开标签缺闭合、后随真实派单：旧正则会吞掉真实派单的闭合标签 → 丢单
  const t2 = '我提一下语法 <delegate> 它成对出现\n正式派单：<delegate to="Y">任务B</delegate>'
  const calls2 = d.parseDelegates(t2)
  check('裸标签缺闭合不吞后方真实派单', calls2.length === 1 && calls2[0].to === 'Y' && calls2[0].prompt === '任务B', calls2)

  // 正文裸闭合字样在真实派单之前：不产生幻影配对
  const t3 = '正文提到 </delegate> 闭合字样\n<delegate to="Y">任务B</delegate>'
  const calls3 = d.parseDelegates(t3)
  check('裸闭合字样不产生幻影配对', calls3.length === 1 && calls3[0].prompt === '任务B', calls3)

  // 属性顺序任意 + reason 提取
  const t4 = '<delegate reason="并行提速" to="Z">任务C</delegate>'
  const calls4 = d.parseDelegates(t4)
  check('属性顺序任意、reason 提取', calls4.length === 1 && calls4[0].to === 'Z' && calls4[0].reason === '并行提速', calls4)

  // strip 同规则：剥真实派单但保留裸字样后的正文
  const s = d.stripDelegates(t2)
  check('strip 只剥真实派单、正文保留', s.includes('正式派单：') && s.includes('它成对出现') && !s.includes('任务B'), s)
}

console.log('— <round> 评估标记 —')
{
  const r1 = '评估先行\n<round outcome="action" reason="队员已回报，继续推进"/>'
  const notes = d.parseRoundNotes(r1)
  check('自闭合 round 解析', notes.length === 1 && notes[0].outcome === 'action' && notes[0].reason === '队员已回报，继续推进', notes)
  check('strip 剥除干净', d.stripRoundNotes(r1) === '评估先行', d.stripRoundNotes(r1))

  check('无 outcome 跳过', d.parseRoundNotes('<round reason="缺值"/>').length === 0)
  check('非自闭合不匹配', d.parseRoundNotes('<round outcome="x">非自闭合</round>').length === 0)

  const r2 = '<round outcome="failed" reason="a"/>\n<round outcome="no_action" reason="b"/>'
  const notes2 = d.parseRoundNotes(r2)
  check('多个 round 共存、outcome 三值', notes2.length === 2 && notes2[1].outcome === 'no_action', notes2)

  // finalText 路径：round 与 delegate 组合剥除
  const mixed = '<round outcome="action" reason="派发后收尾"/>\n先派发：<delegate to="Y">任务B</delegate>'
  const out = d.stripRoundNotes(d.stripDelegates(mixed))
  check('round+delegate 组合剥除', out === '先派发：', out)
}

console.log('— <continue> 多行简报（正则修复回归）—')
{
  const c = '<continue start="parked">第一行\n\n第二行 简报内容</continue>'
  const conts = d.parseContinue(c)
  check('多行简报解析（旧 [sS]*? 必失败）', conts.length === 1 && conts[0].brief.includes('第二行') && conts[0].start === 'parked', conts)
  check('缺省 start 视为 parked（防误切）', d.parseContinue('<continue>简报</continue>')[0].start === 'parked')
  check('strip 剥除', d.stripContinue(c) === '', d.stripContinue(c))
}

console.log('— 多源解析去重回归 —')
{
  const marker = '<delegate to="Y">任务B</delegate>'
  const merged = d.parseDelegatesMerged(`前文 ${marker}`, `后文 ${marker} 尾巴`, '无关文本')
  check('重叠来源去重为单派单', merged.length === 1 && merged[0].to === 'Y', merged)
}

try { fs.rmSync } catch {}
if (failed) {
  console.error(`✗ ROUND SMOKE FAILED (${failed})`)
  process.exit(1)
}
console.log('✅ ROUND SMOKE PASSED')
process.exit(0)
