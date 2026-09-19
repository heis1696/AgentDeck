#!/usr/bin/env node
// 生成代码地图的可视化产物并在浏览器打开：
//   deps-3d.html  3D 力导向「星图」（3d-force-graph，节点可拖拽旋转缩放，默认打开）
//   deps.html     dependency-cruiser 官方交互页（平面版备选）
//   deps.md       deps.mmd 的 mermaid 代码块壳，供 GitHub 页内渲染
//   deps.mmd/.json 原始机读图，同步刷新
// 以上 html 均为按需产物（gitignore 不入库），入库的是 mmd/json/md。
// 用法：npm run graph:view          生成并打开 3D 星图
//       npm run graph:view -- --no-open   只生成不打开
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const graphDir = resolve(root, 'docs/graph');

// 注意：--no-save 装的包会被下一次 npm install prune 掉，
// 因此 depcruise 与 3d-force-graph 必须捆绑安装，缺一补二
if (
  !existsSync(resolve(root, 'node_modules/dependency-cruiser/package.json')) ||
  !existsSync(resolve(root, 'node_modules/3d-force-graph/package.json'))
) {
  execSync('npm install --no-save --no-audit --no-fund dependency-cruiser@18 3d-force-graph', { cwd: root, stdio: 'inherit' });
}

const run = (outputType) => execSync(
  `npx dependency-cruiser src --include-only "^src" --output-type ${outputType} --no-config`,
  { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024, shell: true },
);

// ── 平面交互页（depcruise 官方 HTML）──
writeFileSync(resolve(graphDir, 'deps.html'), run('html'));
if (statSync(resolve(graphDir, 'deps.html')).size < 200_000) {
  console.error('✗ deps.html 疑似空图（typescript 解析器未激活，见 docs/graph/README.md 的坑位记录）');
  process.exit(1);
}

// ── 机读图同步刷新 ──
const jsonRaw = run('json');
writeFileSync(resolve(graphDir, 'deps.json'), jsonRaw);
const mmd = run('mermaid').toString('utf8').trimEnd();
writeFileSync(resolve(graphDir, 'deps.mmd'), mmd + '\n');
writeFileSync(resolve(graphDir, 'deps.md'), [
  '# 全量依赖图（mermaid 壳）',
  '',
  '> 由 `npm run graph:view` 从 `deps.mmd` 包装生成。节点数已接近 GitHub 页内 mermaid 的渲染上限，',
  '> 页内渲染失败时改用 `npm run graph:view` 看 3D 星图或平面交互版。',
  '',
  '```mermaid',
  mmd,
  '```',
  '',
].join('\n'));

// ── 3D 力导向星图 ──
const depJson = JSON.parse(jsonRaw);
const GROUP_COLORS = [
  [/^src\/preload\//, 'preload（IPC 桥）', '#f7b955'],
  [/^src\/shared\//, 'shared（契约）', '#9d8cff'],
  [/\.css$/, '样式', '#546e7a'],
  [/^src\/renderer\//, 'renderer（界面）', '#4fc3f7'],
  [/^src\/main\/ipc\//, 'main/ipc（通道层）', '#69f0ae'],
  [/^src\/main\/backends\//, 'main/backends（CLI 适配）', '#ff8a65'],
  [/^src\/main\/hot\//, 'main/hot（热更）', '#ff5252'],
  [/^src\/main\/sidecar(?=[./-])/, 'sidecar（侧车）', '#ffd54f'],
  [/^src\/main\/prompts\//, 'main/prompts（提示词）', '#ff80ab'],
  [/^src\/main\//, 'main（编排核心）', '#b0bec5'],
];
const classify = (id) => {
  for (const [re, name, color] of GROUP_COLORS) if (re.test(id)) return { name, color };
  return { name: '其他', color: '#78909c' };
};

const inDegree = new Map();
const links = [];
for (const m of depJson.modules) {
  for (const d of m.dependencies || []) {
    if (!d.resolved || d.couldNotResolve) continue;
    links.push({ source: m.source, target: d.resolved });
    inDegree.set(d.resolved, (inDegree.get(d.resolved) || 0) + 1);
  }
}
const nodes = depJson.modules.map((m) => {
  const g = classify(m.source);
  const deg = inDegree.get(m.source) || 0;
  return { id: m.source, group: g.name, color: g.color, in: deg, out: (m.dependencies || []).length, size: 1 + Math.min(deg, 12) * 0.5 };
});
const groupCounts = new Map(nodes.map((n) => [n.group, 0]));
for (const n of nodes) groupCounts.set(n.group, groupCounts.get(n.group) + 1);
const groups = [...new Map(nodes.map((n) => [n.group, n.color])).entries()]
  .map(([name, color]) => ({ name, color, count: groupCounts.get(name) }))
  .sort((a, b) => b.count - a.count);

const lib = readFileSync(resolve(root, 'node_modules/3d-force-graph/dist/3d-force-graph.min.js'), 'utf8');
const html3d = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<title>AgentDeck 依赖星图（3D）</title>
<style>
  html,body{margin:0;height:100%;background:#05060a;overflow:hidden;font-family:system-ui,'Segoe UI','Microsoft YaHei',sans-serif}
  #graph{width:100vw;height:100vh}
  #panel{position:fixed;top:12px;left:12px;background:rgba(10,14,22,.85);backdrop-filter:blur(6px);border:1px solid rgba(120,150,200,.25);border-radius:10px;padding:12px 14px;color:#cfe3ff;font-size:12px;max-width:300px}
  #panel h1{font-size:14px;margin:0 0 8px;color:#fff;font-weight:600}
  #panel input{width:100%;box-sizing:border-box;padding:5px 8px;border-radius:6px;border:1px solid rgba(120,150,200,.4);background:#0b1220;color:#fff;font-size:12px;outline:none}
  .lg{display:flex;align-items:center;gap:6px;margin:3px 0}
  .dot{width:9px;height:9px;border-radius:50%;flex:none}
  .hint{margin-top:8px;color:#7a93b5;line-height:1.6}
</style>
</head>
<body>
<div id="graph"></div>
<div id="panel">
  <h1>AgentDeck 依赖星图 <span id="cnt" style="color:#7a93b5;font-weight:400"></span></h1>
  <input id="q" placeholder="搜索模块名，回车聚焦…"/>
  <div id="legend" style="margin-top:8px"></div>
  <div class="hint">左键拖拽=旋转 · 滚轮=缩放 · 右键拖拽=平移<br/>点击节点=高亮它的依赖关系 · 点空白=取消<br/>节点越大=被依赖越多</div>
</div>
<script>${lib}</script>
<script>
var DATA = ${JSON.stringify({ nodes, links, groups })};
var ADJ = {};
DATA.links.forEach(function (l) {
  (ADJ[l.source] = ADJ[l.source] || []).push(l.target);
  (ADJ[l.target] = ADJ[l.target] || []).push(l.source);
});
document.getElementById('cnt').textContent = DATA.nodes.length + ' 节点 / ' + DATA.links.length + ' 边';
document.getElementById('legend').innerHTML = DATA.groups.map(function (g) {
  return '<div class="lg"><span class="dot" style="background:' + g.color + '"></span>' + g.name + ' <span style="color:#7a93b5">' + g.count + '</span></div>';
}).join('');

var sel = null;
var isAdj = function (id) { return sel && ADJ[sel] && ADJ[sel].indexOf(id) >= 0; };
var litLink = function (l) { return sel && (l.source.id === sel || l.target.id === sel); };

var Graph = ForceGraph3D()(document.getElementById('graph'))
  .graphData(DATA)
  .backgroundColor('#05060a')
  .nodeLabel(function (n) {
    return '<div style="font-size:12px"><b>' + n.id + '</b><br/>' + n.out + ' 出边 / ' + n.in + ' 入边 · ' + n.group + '</div>';
  })
  .nodeVal('size')
  .nodeColor(function (n) { return sel && n.id !== sel && !isAdj(n.id) ? '#1d2a3d' : n.color; })
  .nodeOpacity(0.95)
  .linkLabel(function (l) { return l.source.id + ' → ' + l.target.id; })
  .linkColor(function (l) { return litLink(l) ? '#ffd54f' : 'rgba(120,160,220,0.13)'; })
  .linkWidth(function (l) { return litLink(l) ? 1.4 : 0.35; })
  .linkDirectionalArrowLength(2.6)
  .linkDirectionalArrowRelPos(0.92)
  .linkDirectionalParticles(function (l) { return litLink(l) ? 2 : 0; })
  .linkDirectionalParticleWidth(1.4)
  .linkDirectionalParticleSpeed(0.006)
  .onNodeClick(function (n) {
    sel = sel === n.id ? null : n.id;
    if (sel) { Graph.centerAt(n.x, n.y, n.z, 600); Graph.zoom(7, 600); }
    refresh();
  })
  .onBackgroundClick(function () { sel = null; refresh(); });

function refresh() {
  Graph.nodeColor(Graph.nodeColor())
    .linkColor(Graph.linkColor())
    .linkWidth(Graph.linkWidth())
    .linkDirectionalParticles(Graph.linkDirectionalParticles());
}

document.getElementById('q').addEventListener('keydown', function (e) {
  if (e.key !== 'Enter') return;
  var q = e.target.value.trim().toLowerCase();
  if (!q) return;
  var hit = DATA.nodes.find(function (n) { return n.id.toLowerCase().indexOf(q) >= 0; });
  if (hit) {
    sel = hit.id;
    if (hit.x !== undefined) { Graph.centerAt(hit.x, hit.y, hit.z, 600); Graph.zoom(7, 600); }
    refresh();
  } else {
    e.target.style.borderColor = '#ff5252';
    setTimeout(function () { e.target.style.borderColor = ''; }, 600);
  }
});
</script>
</body>
</html>
`;
const html3dPath = resolve(graphDir, 'deps-3d.html');
writeFileSync(html3dPath, html3d);
const kb = (p) => Math.round(statSync(p).size / 1024);
console.log(`✓ deps-3d.html（${kb(html3dPath)}KB 3D 星图）+ deps.html（${kb(resolve(graphDir, 'deps.html'))}KB 平面版）+ deps.mmd/deps.json/deps.md 已刷新 → docs/graph/`);
console.log(`✓ ${nodes.length} 模块 / ${links.length} 边，分组 ${groups.length} 类`);

if (!process.argv.includes('--no-open')) {
  const target = process.argv.includes('--flat') ? resolve(graphDir, 'deps.html') : html3dPath;
  const open =
    process.platform === 'win32' ? `start "" "${target}"`
    : process.platform === 'darwin' ? `open "${target}"`
    : `xdg-open "${target}"`;
  execSync(open, { shell: true, stdio: 'ignore' });
  console.log('✓ 已在默认浏览器打开' + (process.argv.includes('--flat') ? ' 平面版' : ' 3D 星图'));
}
