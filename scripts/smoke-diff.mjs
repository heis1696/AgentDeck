// P3 DiffView 解析冒烟：unified diff → 文件分组/计数/行分类
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const root = path.resolve(import.meta.dirname, '..')
await build({
  entryPoints: [path.join(root, 'src/renderer/src/components/DiffView.tsx')],
  outfile: path.join(root, 'out', 'smoke-diff.cjs'),
  bundle: true, platform: 'node', format: 'cjs', target: 'node18', loader: { '.tsx': 'tsx' },
  external: ['electron', 'react', 'react/jsx-runtime']
})
const { parseDiff, DiffView } = await import(pathToFileURL(path.join(root, 'out', 'smoke-diff.cjs')).href)

let failed = 0
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) failed++ }

const sample = `diff --git a/src/app.ts b/src/app.ts
index 1234567..89abcde 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,5 @@
 import x
-const old = 1
+const neu = 2
+const added = 3
 context line
\\ No newline at end of file
diff --git a/bin/logo.png b/bin/logo.png
Binary files a/bin/logo.png and b/bin/logo.png differ
diff --git a/new.ts b/new.ts
new file mode 100644
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,1 @@
+hello`

const files = parseDiff(sample)
ok(files.length === 3, `3 个文件（got ${files.length}）`)
ok(files[0].name === 'src/app.ts', '文件名从 b/ 路径提取')
ok(files[0].adds === 2 && files[0].dels === 1, `+/- 计数（got ${files[0].adds}/${files[0].dels}）`)
ok(files[0].lines.some((l) => l.kind === 'hunk' && l.text.startsWith('@@')), 'hunk 行识别')
ok(files[0].lines.some((l) => l.kind === 'meta' && l.text.startsWith('\\\\') === false && l.text.includes('No newline')), '杂行归 meta')
ok(files[1].binary === true, '二进制文件标记')
ok(files[2].adds === 1 && files[2].dels === 0, '新文件计数')
ok(files.every((f) => f.lines.every((l) => !l.text.includes('+++ b/') || l.kind === 'file')), '+++ 不误判为 add')
ok(parseDiff('').length === 0, '空 diff → 空数组')

const oversized = ['diff --git a/large.ts b/large.ts', ...Array.from({ length: 3001 }, (_, index) => `+line-${index}`)].join('\n')
const largeHtml = renderToStaticMarkup(createElement(DiffView, { diff: oversized }))
ok(largeHtml.includes('large.ts') && largeHtml.includes('line-0'), 'Oversized first file retains its filename and visible changes')
ok((largeHtml.match(/class="dl /g) ?? []).length === 3000, 'Oversized first file renders exactly the 3000-line budget')
ok(largeHtml.includes('+3001') && largeHtml.includes('diff 过长') && !largeHtml.includes('无改动'), 'Truncated diff preserves full counts and never reports no changes')
const boundary = ['diff --git a/exact.ts b/exact.ts', ...Array.from({ length: 2999 }, (_, index) => `+exact-${index}`)].join('\n')
const exactHtml = renderToStaticMarkup(createElement(DiffView, { diff: boundary }))
ok(!exactHtml.includes('diff 过长'), 'Exactly 3000 lines are not reported as truncated')
const terminatedHtml = renderToStaticMarkup(createElement(DiffView, { diff: `${boundary}\n` }))
ok(!terminatedHtml.includes('diff 过长') && (terminatedHtml.match(/class="dl /g) ?? []).length === 3000, 'A trailing newline does not create a phantom diff line at the rendering limit')
const multiHtml = renderToStaticMarkup(createElement(DiffView, { diff: `diff --git a/small.ts b/small.ts\n+small\n${oversized}` }))
ok(multiHtml.includes('small.ts') && multiHtml.includes('large.ts') && (multiHtml.match(/class="dl /g) ?? []).length === 3000, 'Multi-file truncation keeps a partial final file within the shared budget')

if (failed) { console.error(`\\n❌ DIFF SMOKE FAILED (${failed})`); process.exit(1) }
console.log('\\n✅ DIFF SMOKE PASSED')
