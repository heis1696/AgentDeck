#!/usr/bin/env node
// 架构边界可执行化检查（起步版）：把 src/ 三域（main / preload / renderer）的依赖方向从约定变成机器门禁。
//
// 规则（违例 → exit 1）：
//   [renderer-imports-main]      renderer 不得 import src/main/** 内部
//   [renderer-imports-preload]   renderer 不得 import src/preload/** 内部
//   [preload-imports-renderer]   preload 不得 import src/renderer/**
//   [main-imports-renderer]      main 不得 import src/renderer/**
//   [renderer-imports-electron]  renderer 不得 require/import electron（只经 preload 暴露的 window.agentdeck）
//   [import-unresolved]          依赖解析不了（相对路径写错 / 别名未建模 / 依赖没声明）——解析不了 = 检查有盲区
//   [alias-not-modeled]          electron.vite.config.ts 里有 resolve.alias，但 tsconfig paths 未建模（同上）
//
// import 解析覆盖：相对路径（含目录 index 与各类扩展名）、tsconfig.json paths 别名、本仓内建别名
// （shared/*、@shared/*、@/*）、Node 内建、package.json 声明的依赖。别名不建模则越界检查必然漏——
// 这是 ZCode architecture-check 的教训，故把「解析不到」本身也做成违例而不是静默跳过。
//
// 用法：
//   node scripts/architecture-check.mjs                  # 全量检查（现状有违例 → exit 1）
//   node scripts/architecture-check.mjs --baseline       # 生成/刷新基线快照（过渡台账）
//   node scripts/architecture-check.mjs --check-baseline # 只报「基线之外的新增」（过渡门禁）
//   node scripts/architecture-check.mjs --json           # 机器可读输出
//
// 基线不是永久豁免：存量越界按批次还清后重跑 --baseline 收缩；约定见 docs/ARCHITECTURE.md §14。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lineOfAt, lineStarts, maskTs, parseJsonc } from './lib/source-mask.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const abs = (rel) => join(root, rel);
const rel_ = (p) => relative(root, p).split('\\').join('/');

const SCAN_ROOT = 'src';
const BASELINE_FILE = 'scripts/baselines/architecture.baseline.json';
const DOMAINS = ['main', 'preload', 'renderer', 'shared'];
// 扫描下限护栏（继承 graph-index 的教训：空扫描不得静默 exit 0）
const MIN_MODULES = 150;
const LINE_CLIP = 160;

const RULES = {
  'renderer-imports-main': 'renderer 不得依赖主进程模块（src/main/**）——跨进程只走 preload 桥（window.agentdeck）',
  'renderer-imports-preload': 'renderer 不得依赖 preload 模块（src/preload/**）——共享契约类型一律从 src/shared 取',
  'preload-imports-renderer': 'preload 不得依赖渲染层（src/renderer/**）',
  'main-imports-renderer': 'main 不得依赖渲染层（src/renderer/**）——渲染资源应落在 src/shared 或主进程自有资产目录',
  'renderer-imports-electron': 'renderer 不得直接引入 electron（require 与 import 皆禁）——只经 preload 的 window.agentdeck',
  'import-unresolved': 'import 无法解析（相对路径/别名/依赖缺失）——解析不到就等于该依赖没被检查',
  'alias-not-modeled': 'vite 配了 resolve.alias 但 tsconfig paths 未建模——别名不建模则依赖方向检查有盲区',
};

// ---------------------------------------------------------------- 扫描目标

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const MODULE_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css'];

const domainOf = (rel) => (rel.match(new RegExp(`^${SCAN_ROOT}/(${DOMAINS.join('|')})(?:/|$)`)) || [])[1] || 'other';

function collectModules() {
  return walk(abs(SCAN_ROOT)).map(rel_).filter((f) => MODULE_RE.test(f)).sort();
}

// ---------------------------------------------------------------- 依赖解析

function resolveFile(base) {
  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const ext of EXTENSIONS) {
    const p = base + ext;
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  for (const ext of EXTENSIONS) {
    const p = join(base, `index${ext}`);
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

/** 别名表：tsconfig.json paths（本仓当前为空，一旦有人加就自动纳入）+ 本仓内建约定 */
function loadAliases() {
  const table = [
    { prefix: 'shared/', target: `${SCAN_ROOT}/shared/`, source: 'builtin' },
    { prefix: '@shared/', target: `${SCAN_ROOT}/shared/`, source: 'builtin' },
    { prefix: '@/', target: `${SCAN_ROOT}/renderer/src/`, source: 'builtin' },
  ];
  const tsconfigPath = abs('tsconfig.json');
  let paths = {};
  if (existsSync(tsconfigPath)) {
    try {
      const co = parseJsonc(readFileSync(tsconfigPath, 'utf8')).compilerOptions || {};
      const baseUrl = String(co.baseUrl || '.').replace(/^\.\//, '').replace(/\/+$/, '');
      for (const [key, targets] of Object.entries(co.paths || {})) {
        const prefix = key.endsWith('/*') ? key.slice(0, -1) : key;
        for (const t of [].concat(targets)) {
          const target = String(t).replace(/\/\*$/, '/');
          table.push({ prefix, target: baseUrl && baseUrl !== '.' ? `${baseUrl}/${target}` : target, source: 'tsconfig.paths' });
        }
      }
      paths = co.paths || {};
    } catch (err) {
      console.error(`✗ tsconfig.json 解析失败：${err.message}`);
      process.exit(1);
    }
  }
  return { table, hasPaths: Object.keys(paths).length > 0 };
}

const stripQuery = (spec) => spec.replace(/[?#].*$/, '');

function packageNameOf(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function declaredDependencies() {
  const pkg = JSON.parse(readFileSync(abs('package.json'), 'utf8'));
  const names = new Set();
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const name of Object.keys(pkg[field] || {})) names.add(name);
  }
  return names;
}

const isBuiltin = (spec) => spec.startsWith('node:') || builtinModules.includes(spec);

// ---------------------------------------------------------------- import 提取

const SPECIFIER_RES = [
  // import x from '...' / import '...' / export * from '...' / import type {…} from '...'
  /(?:^|[\s;{}()=,>])(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\sfrom\s+)?['"]([^'"]+)['"]/g,
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // require('...')
  /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // import('...')
];

function extractSpecifiers(masked, inString) {
  const found = [];
  for (const re of SPECIFIER_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(masked))) {
      // 关键字本身落在字符串/模板里的一律不算依赖（例如模板字面量里贴了一段示例代码）
      if (inString[m.index]) continue;
      found.push({ spec: m[1], index: m.index + m[0].indexOf(m[1]) });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

// ---------------------------------------------------------------- 违例行采集

function scanModule(file, ctx, list) {
  const raw = readFileSync(abs(file), 'utf8');
  const lines = raw.split(/\r?\n/);
  const { masked, inString } = maskTs(raw);
  const starts = lineStarts(masked);
  const from = domainOf(file);
  const seen = new Set();
  const specifiers = extractSpecifiers(masked, inString);

  for (const { spec, index } of specifiers) {
    const line = lineOfAt(starts, index);
    const bare = stripQuery(spec);
    let target = null; // 解析到的文件（仓库相对路径）
    let kind = 'external';

    if (bare.startsWith('.')) {
      const hit = resolveFile(resolve(dirname(abs(file)), bare));
      if (hit) { target = rel_(hit); kind = 'relative'; }
      else kind = 'unresolved-relative';
    } else if (/^(?:https?|data|file):/.test(bare) || bare.startsWith('#')) {
      kind = 'url'; // 远程/内联 URL 与 package imports（#…）：不是仓库内依赖，不参与方向判定
    } else if (isBuiltin(bare)) {
      kind = 'builtin';
    } else {
      const alias = ctx.aliases.find((a) => bare.startsWith(a.prefix));
      if (alias) {
        const hit = resolveFile(abs(alias.target + bare.slice(alias.prefix.length)));
        if (hit) { target = rel_(hit); kind = 'alias'; }
        else kind = 'unresolved-alias';
      } else if (ctx.packages.has(packageNameOf(bare))) {
        kind = 'package';
      } else {
        kind = 'unknown-package';
      }
    }

    const push = (rule, note) => {
      const dedupe = `${rule}\0${line}\0${bare}`;
      if (seen.has(dedupe)) return;
      seen.add(dedupe);
      list.push({
        rule,
        file,
        line,
        spec: bare,
        note,
        text: (lines[line - 1] || '').trim().replace(/\s+/g, ' ').slice(0, LINE_CLIP),
      });
    };

    const to = target ? domainOf(target) : 'other';
    if (from === 'renderer' && to === 'main') push('renderer-imports-main', `命中 ${target}`);
    if (from === 'renderer' && to === 'preload') push('renderer-imports-preload', `命中 ${target}`);
    if (from === 'preload' && to === 'renderer') push('preload-imports-renderer', `命中 ${target}`);
    if (from === 'main' && to === 'renderer') push('main-imports-renderer', `命中 ${target}`);
    if (from === 'renderer' && (bare === 'electron' || bare.startsWith('electron/'))) {
      push('renderer-imports-electron', '渲染层应只依赖 preload 桥');
    }
    if (kind === 'unresolved-relative') push('import-unresolved', '相对路径解析不到文件');
    else if (kind === 'unresolved-alias') push('import-unresolved', '别名解析不到文件（别名表见 tsconfig.json paths 与本脚本内建表）');
    else if (kind === 'unknown-package') push('import-unresolved', '既非 Node 内建、也非 package.json 声明依赖、也不匹配任何别名');
  }
  return specifiers.length;
}

/** vite 配了 alias 却不在 tsconfig 建模 → 依赖检查有盲区，必须显式失败 */
function checkViteAlias(ctx, list) {
  const cfg = 'electron.vite.config.ts';
  if (!existsSync(abs(cfg))) return;
  const raw = readFileSync(abs(cfg), 'utf8');
  const { masked } = maskTs(raw);
  const m = /\balias\s*:/.exec(masked);
  if (!m || ctx.hasPaths) return;
  const line = lineOfAt(lineStarts(masked), m.index);
  list.push({
    rule: 'alias-not-modeled',
    file: cfg,
    line,
    spec: 'resolve.alias',
    note: '请把该别名同步进 tsconfig.json compilerOptions.paths',
    text: (raw.split(/\r?\n/)[line - 1] || '').trim().slice(0, LINE_CLIP),
  });
}

// ---------------------------------------------------------------- 基线

const keyOf = (hit, occurrence) =>
  createHash('sha1').update(`${hit.rule}\0${hit.file}\0${hit.spec}\0${occurrence}`).digest('hex').slice(0, 16);

function withKeys(hits) {
  const seen = new Map();
  return hits.map((hit) => {
    const base = `${hit.rule}\0${hit.file}\0${hit.spec}`;
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    return { ...hit, key: keyOf(hit, n) };
  });
}

const sortHits = (hits) =>
  hits.slice().sort((a, b) => (a.file === b.file ? a.line - b.line || a.rule.localeCompare(b.rule) : a.file.localeCompare(b.file)));

function readBaseline() {
  if (!existsSync(abs(BASELINE_FILE))) return null;
  try {
    return JSON.parse(readFileSync(abs(BASELINE_FILE), 'utf8'));
  } catch (err) {
    console.error(`✗ 基线文件损坏（${BASELINE_FILE}）：${err.message}`);
    process.exit(1);
  }
}

function writeBaseline(hits, stats, previous) {
  // 配置级盲区（别名没建模）不得进基线：基线是「存量代码债」台账，不是「检查器暂时看不见」的遮羞布
  const configBlindSpots = hits.filter((h) => h.rule === 'alias-not-modeled');
  if (configBlindSpots.length) {
    console.error('✗ 拒绝写入基线：alias-not-modeled 属检查器配置盲区，必须先同步别名建模，不能记进台账当豁免');
    for (const h of configBlindSpots) console.error(`  ${h.file}:${h.line}  ${h.note}`);
    process.exit(1);
  }
  const byRule = {};
  for (const hit of hits) byRule[hit.rule] = (byRule[hit.rule] || 0) + 1;
  const entries = hits.map((h) => ({ key: h.key, rule: h.rule, file: h.file, line: h.line, spec: h.spec, note: h.note, text: h.text }));
  const payload = {
    version: 1,
    generator: 'scripts/architecture-check.mjs',
    note: '过渡台账：只允许缩小。还清后重跑 --baseline 收缩；不是永久豁免。约定见 docs/ARCHITECTURE.md §14。',
    scope: [`${SCAN_ROOT}/{main,preload,renderer,shared}/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}`],
    rules: RULES,
    generatedAt: new Date().toISOString(),
    summary: { modules: stats.modules, edges: stats.edges, violations: hits.length, byRule },
    entries,
  };
  mkdirSync(dirname(abs(BASELINE_FILE)), { recursive: true });
  writeFileSync(abs(BASELINE_FILE), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  const before = previous ? previous.entries.length : null;
  const delta = before === null ? '（首次生成）' : `（上一版 ${before} 条 → ${before - entries.length >= 0 ? '还清' : '新增'} ${Math.abs(before - entries.length)} 条）`;
  console.log(`✓ 基线已写入 ${BASELINE_FILE}：${entries.length} 条${delta}`);
  console.log('  基线是过渡台账，不是永久豁免——新越界一律当场修，存量按批次还清后重跑 --baseline 收缩。');
}

// ---------------------------------------------------------------- 主流程

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { mode: 'check', json: false, help: false };
  for (const arg of argv) {
    if (arg === '--baseline') {
      if (opts.mode === 'check-baseline') return fail(`${arg} 与 --check-baseline 互斥`);
      opts.mode = 'baseline';
    } else if (arg === '--check-baseline') {
      if (opts.mode === 'baseline') return fail(`${arg} 与 --baseline 互斥`);
      opts.mode = 'check-baseline';
    } else if (arg === '--json') opts.json = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else return fail(`未知参数：${arg}`);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('用法：node scripts/architecture-check.mjs [--baseline | --check-baseline] [--json]');
    return;
  }

  const modules = collectModules();
  const byDomain = {};
  for (const f of modules) byDomain[domainOf(f)] = (byDomain[domainOf(f)] || 0) + 1;
  const missing = DOMAINS.filter((d) => !byDomain[d]);
  if (missing.length) {
    console.error(`✗ 域目录缺失或为空：${missing.map((d) => `${SCAN_ROOT}/${d}`).join('、')}（仓库结构已变，三域依赖方向无从判定）`);
    process.exitCode = 1;
    return;
  }
  if (modules.length < MIN_MODULES) {
    console.error(`✗ 扫描面异常收缩：命中 ${modules.length} 个模块（下限 ${MIN_MODULES}）——拒绝以空扫描静默通过`);
    process.exitCode = 1;
    return;
  }

  const { table: aliases, hasPaths } = loadAliases();
  const ctx = { aliases, hasPaths, packages: declaredDependencies() };

  const raw = [];
  let edges = 0;
  for (const file of modules) edges += scanModule(file, ctx, raw);
  checkViteAlias(ctx, raw);

  const hits = withKeys(sortHits(raw));
  const stats = { modules: modules.length, edges };

  if (opts.mode === 'baseline') {
    writeBaseline(hits, stats, readBaseline());
    return;
  }

  const byRule = {};
  for (const hit of hits) byRule[hit.rule] = (byRule[hit.rule] || 0) + 1;
  const show = (h) => `✗ [${h.rule}] ${h.file}:${h.line}  ${h.spec}  ·  ${h.note}`;

  if (opts.mode === 'check-baseline') {
    const baseline = readBaseline();
    if (!baseline) {
      console.error(`✗ 基线不存在（${BASELINE_FILE}）——先跑 node scripts/architecture-check.mjs --baseline`);
      process.exitCode = 1;
      return;
    }
    const known = new Set(baseline.entries.map((e) => e.key));
    const fresh = hits.filter((h) => !known.has(h.key));
    const current = new Set(hits.map((h) => h.key));
    const repaid = baseline.entries.filter((e) => !current.has(e.key));
    if (opts.json) {
      console.log(JSON.stringify({ mode: 'check-baseline', modules: modules.length, baseline: baseline.entries.length, newViolations: fresh, repaid }, null, 2));
    } else {
      console.log(`架构边界检查（--check-baseline）：扫描 ${modules.length} 个模块，基线 ${baseline.entries.length} 条`);
      for (const h of fresh) console.log(show(h));
      if (fresh.length) console.log(`\n✗ 基线之外新增 ${fresh.length} 处越界（基线 ${baseline.entries.length} 条 / 现存 ${hits.length} 条）`);
      else console.log(`✓ 无新增越界（现存 ${hits.length} 条，全部在基线台账内）`);
      if (repaid.length) console.log(`ℹ 已还清 ${repaid.length} 条，基线可收缩：重跑 node scripts/architecture-check.mjs --baseline`);
    }
    if (fresh.length) process.exitCode = 1;
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify({ mode: 'check', ...stats, byDomain, byRule, violations: hits }, null, 2));
  } else {
    const domainText = DOMAINS.map((d) => `${d} ${byDomain[d]}`).join(' / ');
    console.log(`架构边界检查：扫描 ${SCAN_ROOT}/ ${modules.length} 个模块（${domainText}），解析 ${edges} 条依赖（别名表 ${aliases.length} 条）`);
    for (const h of hits) console.log(show(h));
    if (hits.length) {
      const detail = Object.entries(byRule).map(([r, n]) => `${r} ${n}`).join(' / ');
      console.log(`\n✗ ${hits.length} 处越界（${detail}）`);
      console.log('  过渡期可用 --baseline 记台账、--check-baseline 只报新增；基线只许缩小，约定见 docs/ARCHITECTURE.md §14。');
    } else {
      console.log('✓ 无越界：renderer/preload/main 依赖方向与 electron 引入面全部合规。');
    }
  }
  if (hits.length) process.exitCode = 1;
}

main();
