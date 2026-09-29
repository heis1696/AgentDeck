#!/usr/bin/env node
// CodeGraph 语义索引刷新（替代退役的 dependency-cruiser 管线，见 docs/graph/README.md）：
//   用 tree-sitter 语义图索引 src/（函数/类/导入/调用链），one-shot「先索引 → 跑一次图查询 → 退出」。
// 用法：npm run graph:index
// 说明：--workspace 直接指 src/（与旧管线 depcruise src 同口径，索引计数即 src 文件数；
//       目录聚合摘要 get_module_summary 在本版引擎返回全 0，故以索引器日志行为护栏数据源，
//       引擎版本随 package-lock 固定，日志格式稳定）。内置排除 node_modules 等 47 目录，
//       本仓库私有目录（.agentdeck-worktrees 等）显式 --exclude 兜底。
// 护栏（继承旧管线教训：空图静默 exit 0）：src/ 文件数 < 150 或符号数为 0 → 非零退出并报数。
// 降级：默认 --embedding-model static（免 ONNX 免内存门禁）；启动失败或报内存门禁时
//       自动降级重跑一次 --graph-only（纯结构兜底），输出注明当前模式。
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkgBin = resolve(root, 'node_modules/@astudioplus/codegraph-mcp/bin');

// 引擎 exe 由 postinstall（或 npx codegraph-mcp-fetch-engine）落在包 bin/ 目录
const engine = process.env.CODEGRAPH_SERVER_PATH
  || join(pkgBin, readdirSync(pkgBin).find((f) => new RegExp(`^codegraph-server-.*${process.platform === 'win32' ? '\\.exe' : '$'}`).test(f)) || '');
if (!existsSync(engine)) {
  console.error('✗ CodeGraph 引擎未找到（' + pkgBin + '）——先跑 npx codegraph-mcp-fetch-engine 重试下载');
  process.exit(1);
}

// 不经 shell、纯 args 数组传参，规避 Windows 引号地狱；JSON 原样作为一个 argv 元素
const baseArgs = [
  '--workspace', 'src',
  '--exclude', '.agentdeck-worktrees', '--exclude', '.agentdeck-reports',
  '--exclude', 'out', '--exclude', 'dist', '--exclude', 'release', '--exclude', 'teardown',
  '--run-tool', 'codegraph_find_entry_points', '--tool-args', '{}',
];

// 解析索引器日志行（输出带 ANSI 色码，先剥掉）：文件数来自 "Indexed N files"，
// 符号数 static 模式取 "generation (N symbols)"，graph-only 模式用持久化的节点数兜底
const countOf = (text) => {
  const t = text.replaceAll(/\x1b\[[0-9;]*m/g, '');
  const files = t.match(/Indexed (\d+) files/)?.[1];
  const nodes = t.match(/Persist(?:ing|ed) (\d+) nodes/)?.[1];
  const e = t.match(/nodes,? (?:and )?(\d+) edges/);
  const edges = e?.[1];
  const symbols = t.match(/\((\d+) symbols\)/)?.[1];
  return { files: +files || 0, nodes: +nodes || 0, edges: +edges || 0, symbols: symbols === undefined ? null : +symbols };
};

// 门禁/降级信号：只匹配引擎明确的降级措辞——MemoryManager 例行日志同样满篇 "memory"，
// 宽松正则会把健康运行误判成门禁（每次都白跑一遍 graph-only）
const MEMORY_GATE = /memory manager not initialized|embeddings? (?:are )?disabled|insufficient memory|model load(?:ing)? (?:failed|skipped)/i;
const run = (graphOnly) => spawnSync(engine, graphOnly ? [...baseArgs, '--graph-only'] : [...baseArgs, '--embedding-model', 'static'], {
  cwd: root, encoding: 'utf8', timeout: 10 * 60_000, maxBuffer: 64 * 1024 * 1024,
  env: { ...process.env, CODEGRAPH_TELEMETRY: 'off' },
});

const started = Date.now();
let mode = 'static（免 ONNX）';
let r = run(false);
let stats = countOf((r.stdout || '') + (r.stderr || ''));
// 门禁信号独立判定：出现即重跑 graph-only，不以 files===0 短路——门禁可能落在
// 已记部分文件之后，半残索引不配进护栏；未知失败措辞的兜底交给最终计数护栏
const staticFailed = r.error || r.status !== 0 || MEMORY_GATE.test(r.stderr || '');
if (staticFailed) {
  console.error('⚠ static 模式失败（' + (r.error?.message || `exit ${r.status}`) + '），自动降级 --graph-only 纯结构兜底…');
  mode = 'graph-only（纯结构兜底）';
  r = run(true);
  stats = countOf((r.stdout || '') + (r.stderr || ''));
}
const seconds = ((Date.now() - started) / 1000).toFixed(1);

if (r.error || r.status !== 0) {
  console.error(`✗ 索引失败（${mode}，exit ${r.status ?? r.error?.code}）：${(r.stderr || '').slice(-800)}`);
  process.exit(1);
}
// 护栏：空图/残图不允许静默通过——文件数 <150 或一个符号都没索引到即失败并报数
const symbolCount = stats.symbols ?? stats.nodes;
if (stats.files < 150 || symbolCount === 0) {
  console.error(`✗ 代码图护栏不过：src 文件数 ${stats.files}（要求 ≥150）、符号数 ${symbolCount}（要求 >0）——疑似空图，拒绝静默通过`);
  process.exit(1);
}

const symbolLabel = stats.symbols === null ? `${stats.nodes} 节点（符号代理口径）` : `${stats.symbols} 符号`;
console.log(`✓ CodeGraph 语义索引就绪：${stats.files} 个 src 文件 / ${symbolLabel}（${stats.nodes} 节点 / ${stats.edges} 边）/ 模式 ${mode} / 耗时 ${seconds}s`);
console.log('MCP 查询：npx codegraph-mcp（接入方式见 docs/graph/README.md）');
