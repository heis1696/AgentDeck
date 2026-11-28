// Renderer Markdown 渲染冒烟：协议标记卡片化与「内容不丢失」回归。
// 真实事故：未闭合 / 缺 to 的协议标记漏进 ReactMarkdown（未启用 rehype-raw，
// CommonMark HTML block 一路吞到空行）→ 正文整段消失；且非贪婪幻影配对会把
// 后方真实派单的闭合标签认领过来，连卡片带正文一起吞掉。
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const root = path.resolve(import.meta.dirname, '..')
const outfile = path.join(root, 'out', 'smoke-markdown.cjs')
await build({
  entryPoints: [path.join(root, 'src/renderer/src/components/Markdown.tsx')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  jsx: 'automatic',
  external: ['react', 'react-dom']
})
const { Markdown, DelegateCard, ContinueCard, RoundChip, ReviewChip, ConsultCard, InvestigateCard } = await import(pathToFileURL(outfile).href)
const render = (text) => renderToStaticMarkup(React.createElement(Markdown, { text }))
const ok = (condition, label) => {
  console.log(`  ${condition ? '✓' : '✗'} ${label}`)
  if (!condition) process.exitCode = 1
}
const has = (html, needle) => html.includes(needle)

// 普通 Markdown 照常渲染
ok(has(render('# 标题\n\n正文 **加粗**'), '正文'), 'plain markdown renders')

// 完整派单 → 委派卡片 + 周围正文保留
const closed = render('开工前说明\n<delegate to="zcode" reason="并行">实现 A</delegate>\n收尾说明')
ok(has(closed, 'delegate-card') && has(closed, '实现 A') && has(closed, '开工前说明') && has(closed, '收尾说明'), 'closed delegate becomes a card with surrounding prose')

// 未闭合标记 + 后方真实派单：两张卡片，中间/后方内容不丢（幻影吞单回归）
const unclosed = render('开头\n<delegate to="alice">这段被截断\n\n中间正文必须可见\n<delegate to="bob">真实派单 B</delegate>\n结尾')
ok(unclosed.split('delegate-card-head').length - 1 === 2, 'unclosed + real delegate produce two cards')
ok(has(unclosed, '这段被截断') && has(unclosed, '中间正文必须可见') && has(unclosed, '真实派单 B') && has(unclosed, '结尾'), 'content around markers survives (no phantom swallow)')
ok(has(unclosed, '未闭合'), 'truncated marker is labeled')

// 缺 to 的成对标记 → 降级卡片，不漏原始标签
const noTo = render('<delegate>没有目标</delegate>\n正文保留')
ok(has(noTo, 'delegate-card') && !has(noTo, '&lt;delegate') && has(noTo, '正文保留'), 'delegate without to falls back to card, no raw tag leak')

// 游离闭合标签被吞掉，前后正文保留
const stray = render('前文\n</delegate>\n后文')
ok(!has(stray, '&lt;/delegate') && has(stray, '前文') && has(stray, '后文'), 'stray closing tag is swallowed')

// round 漏写自闭合斜杠 → 仍渲染自评芯片
ok(has(render('<round outcome="action" reason="ok">'), 'round-chip'), 'round without slash still renders as chip')

// 围栏代码块里的普通 HTML 标签原样可见（不随协议扫描被吞）
const fenced = render('```\n<div>hello</div>\n```')
ok(has(fenced.replace(/&lt;/g, '<').replace(/&gt;/g, '>'), '<div>hello</div>'), 'html inside fenced code stays visible')

// 空文本不崩
ok(render('') === '<div class="md"></div>', 'empty text renders empty container')

// MCP 通道直接复用的独立协议卡片/芯片导出渲染正确
const mcpCardHtml = renderToStaticMarkup(React.createElement(React.Fragment, null,
  React.createElement(DelegateCard, { to: 'Claude', reason: '实现', prompt: '完整派单正文' }),
  React.createElement(ContinueCard, { start: 'auto', brief: '阶段交接简报' }),
  React.createElement(RoundChip, { outcome: 'action', reason: '已派单' }),
  React.createElement(ReviewChip, { of: '#1', verdict: 'pass', note: '验证通过' }),
  React.createElement(ConsultCard, { to: 'Codex', reason: '架构对齐', prompt: '确认接口边界' }),
  React.createElement(InvestigateCard, { to: 'ZCode', reason: '只读排查', prompt: '检查日志路径' })
))
ok(
  has(mcpCardHtml, 'delegate-card')
  && has(mcpCardHtml, 'continue-card')
  && has(mcpCardHtml, 'round-chip')
  && has(mcpCardHtml, 'review-chip')
  && has(mcpCardHtml, 'delegate-card-consult')
  && has(mcpCardHtml, 'delegate-card-investigate')
  && has(mcpCardHtml, '完整派单正文')
  && has(mcpCardHtml, '阶段交接简报'),
  'standalone protocol cards/chips render for MCP action timeline'
)

if (!process.exitCode) console.log('\n✅ MARKDOWN SMOKE PASSED')
