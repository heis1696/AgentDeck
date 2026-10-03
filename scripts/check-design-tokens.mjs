#!/usr/bin/env node
// 设计令牌可执行化检查：把 DESIGN-SYSTEM-V2.md 的「无硬编码色值 / 字阶只用令牌」从文档变成机器门禁。
//
// 规则（违例 → exit 1）：
//   [color-hardcoded]   硬编码色值：#hex / rgb() / rgba() / hsl() / hsla()
//   [font-size-raw-px]  非令牌 font-size 裸 px（CSS 声明；组件内 fontSize 数字/px 一并覆盖）
// 扫描面：src/renderer/src/**/*.css（含 polish/*.css 与 styles.css）+ src/renderer/src/**/*.{ts,tsx}
// 白名单：tokens.css 自身、transparent / 全透明（alpha=0）色值、0 长度值、含 var() 的令牌值、
//         --font-mono / --mono 规则块（代码与 diff 视图按固定 px 排版）、行内 design-ok 注释豁免。
//
// 用法：
//   node scripts/check-design-tokens.mjs                  # 全量检查（现状有违例 → exit 1）
//   node scripts/check-design-tokens.mjs --baseline       # 生成/刷新基线快照（过渡台账）
//   node scripts/check-design-tokens.mjs --check-baseline # 只报「基线之外的新增」（过渡门禁）
//   node scripts/check-design-tokens.mjs --json           # 机器可读输出（配合 --check-baseline）
//
// 基线不是永久豁免：它是「存量违例台账」，只允许缩小。还清后重跑 --baseline 收缩；
// 约定与规则清单见 docs/ARCHITECTURE.md §14。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lineOfAt, lineStarts, maskCss, maskTs } from './lib/source-mask.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const abs = (rel) => join(root, rel);
const rel_ = (p) => relative(root, p).split('\\').join('/');

const SCAN_ROOT = 'src/renderer/src';
const BASELINE_FILE = 'scripts/baselines/design-tokens.baseline.json';
// 令牌权威来源（唯一允许写死色值的文件）
const TOKEN_FILE = 'src/renderer/src/tokens.css';
// 规格点名的核心扫描面：缺失即视为检查器坏了
const REQUIRED_FILES = [TOKEN_FILE, 'src/renderer/src/styles.css'];
// 扫描下限护栏（继承 graph-index 的教训：空扫描不得静默 exit 0）
const MIN_FILES = 60;
const MIN_POLISH_CSS = 8;
const LINE_CLIP = 160;

const RULES = {
  'color-hardcoded': '硬编码色值（#hex / rgb() / rgba() / hsl() / hsla()）——改用 tokens.css 令牌',
  'font-size-raw-px': '非令牌 font-size 裸 px——改用 var(--text-micro/caption/label/body/title-sm/title)',
};

// ---------------------------------------------------------------- 文件收集

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function collectTargets() {
  const files = walk(abs(SCAN_ROOT))
    .map(rel_)
    .filter((f) => /\.(css|ts|tsx)$/.test(f))
    .sort();
  const css = files.filter((f) => f.endsWith('.css'));
  const code = files.filter((f) => !f.endsWith('.css'));
  const polish = css.filter((f) => f.startsWith(`${SCAN_ROOT}/polish/`));
  return { files, css, code, polish };
}

// ---------------------------------------------------------------- 文本预处理

/** CSS 里 { ... } 配对块，用于 --font-mono 规则块级豁免 */
function cssBlocks(text) {
  const stack = [];
  const blocks = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '{') stack.push(i);
    else if (text[i] === '}') {
      const s = stack.pop();
      if (s !== undefined) blocks.push([s, i]);
    }
  }
  return blocks;
}

function innermostBlock(blocks, offset) {
  let best = null;
  for (const b of blocks) {
    if (b[0] < offset && offset < b[1] && (!best || b[1] - b[0] < best[1] - best[0])) best = b;
  }
  return best;
}

const MONO_RE = /var\(\s*--(?:font-)?mono\s*\)/;

// ---------------------------------------------------------------- 色值判定

const HEX_RE = /#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z_-])/g;
const FUNC_COLOR_RE = /\b(rgba?|hsla?)\(\s*([^()]*)\)/g;

/** 全透明 / 0 值豁免：rgba(0,0,0,0)、#rrggbb00、args 里引用了令牌 */
function colorIsExempt(raw, fn, args) {
  if (raw.length === 9 && raw.slice(7).toLowerCase() === '00') return true; // #rrggbbaa，alpha=00
  if (fn && args) {
    if (/var\(/.test(args)) return true;
    const parts = args.split(/[,/]/).map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 4) {
      const alpha = parts[3];
      if (/^0*\.?0+%?$/.test(alpha)) return true;
    }
  }
  return false;
}

const isUrlFragment = (text, idx) => /url\(\s*$/.test(text.slice(Math.max(0, idx - 32), idx));

// ---------------------------------------------------------------- 违例行采集

function pushHit(list, { rule, file, line, text, match, note }) {
  list.push({ rule, file, line, text: text.trim().replace(/\s+/g, ' ').slice(0, LINE_CLIP), match, note });
}

function scanCss(file, list) {
  const raw = readFileSync(abs(file), 'utf8');
  const lines = raw.split(/\r?\n/);
  const text = maskCss(raw);
  const starts = lineStarts(text);
  const blocks = cssBlocks(text);
  const lineText = (n) => lines[n - 1] || '';
  const exemptLine = (n) => lineText(n).includes('design-ok');

  HEX_RE.lastIndex = 0;
  let m;
  while ((m = HEX_RE.exec(text))) {
    const line = lineOfAt(starts, m.index);
    if (exemptLine(line) || isUrlFragment(text, m.index) || colorIsExempt(m[0])) continue;
    pushHit(list, { rule: 'color-hardcoded', file, line, text: lineText(line), match: m[0] });
  }

  FUNC_COLOR_RE.lastIndex = 0;
  while ((m = FUNC_COLOR_RE.exec(text))) {
    const line = lineOfAt(starts, m.index);
    if (exemptLine(line) || colorIsExempt(m[0], m[1], m[2])) continue;
    pushHit(list, { rule: 'color-hardcoded', file, line, text: lineText(line), match: m[0].replace(/\s+/g, ' ') });
  }

  const FS_RE = /(?:^|[;{\s])font-size\s*:\s*([^;}]+)/g;
  FS_RE.lastIndex = 0;
  while ((m = FS_RE.exec(text))) {
    const value = m[1].trim();
    const line = lineOfAt(starts, m.index + m[0].length - m[1].length);
    if (exemptLine(line)) continue;
    if (/var\(/.test(value)) continue; // 令牌引用（含带兜底值的 var(--text-title, 16px)）
    if (!/\d*\.?\d+px\b/.test(value)) continue; // 只管裸 px
    if (/^(?:0*\.?0+)px$/.test(value)) continue; // 0 值豁免
    const block = innermostBlock(blocks, m.index);
    if (block && MONO_RE.test(text.slice(block[0], block[1] + 1))) continue; // --font-mono 规则块
    pushHit(list, { rule: 'font-size-raw-px', file, line, text: lineText(line), match: `font-size: ${value}` });
  }
}

function scanCode(file, list) {
  const raw = readFileSync(abs(file), 'utf8');
  const lines = raw.split(/\r?\n/);
  const { masked, inString } = maskTs(raw);
  const starts = lineStarts(masked);
  const lineText = (n) => lines[n - 1] || '';
  const exemptLine = (n) => lineText(n).includes('design-ok');

  HEX_RE.lastIndex = 0;
  let m;
  while ((m = HEX_RE.exec(masked))) {
    if (!inString[m.index]) continue; // JSX 正文里的 #FF00FF 是说明文字，不是样式
    const line = lineOfAt(starts, m.index);
    if (exemptLine(line) || isUrlFragment(masked, m.index) || colorIsExempt(m[0])) continue;
    pushHit(list, { rule: 'color-hardcoded', file, line, text: lineText(line), match: m[0] });
  }

  FUNC_COLOR_RE.lastIndex = 0;
  while ((m = FUNC_COLOR_RE.exec(masked))) {
    if (!inString[m.index]) continue;
    const line = lineOfAt(starts, m.index);
    if (exemptLine(line) || colorIsExempt(m[0], m[1], m[2])) continue;
    pushHit(list, { rule: 'color-hardcoded', file, line, text: lineText(line), match: m[0].replace(/\s+/g, ' ') });
  }

  // 组件内联字号：fontSize: 13 / fontSize: '13px'（React 里裸数字即 px）
  const FS_RE = /fontSize\s*:\s*([^,;}\n]+)/g;
  FS_RE.lastIndex = 0;
  while ((m = FS_RE.exec(masked))) {
    const value = m[1].trim();
    const line = lineOfAt(starts, m.index);
    if (exemptLine(line)) continue;
    if (/var\(/.test(value)) continue;
    const bareNumber = /^\d+(?:\.\d+)?$/.test(value); // fontSize: 13
    const px = /\d*\.?\d+px\b/.test(value); // fontSize: '13px'
    if (!bareNumber && !px) continue;
    if (px && /^(?:['"`])?0*\.?0+px(?:['"`])?$/.test(value)) continue; // 0 值豁免
    pushHit(list, { rule: 'font-size-raw-px', file, line, text: lineText(line), match: `fontSize: ${value}` });
  }
}

// ---------------------------------------------------------------- 基线

const keyOf = (hit, occurrence) =>
  createHash('sha1').update(`${hit.rule}\0${hit.file}\0${hit.match}\0${occurrence}`).digest('hex').slice(0, 16);

function withKeys(hits) {
  const seen = new Map();
  return hits.map((hit) => {
    const base = `${hit.rule}\0${hit.file}\0${hit.match}`;
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    return { ...hit, key: keyOf(hit, n) };
  });
}

function sortHits(hits) {
  return hits.slice().sort((a, b) => (a.file === b.file ? a.line - b.line || a.rule.localeCompare(b.rule) : a.file.localeCompare(b.file)));
}

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
  const byRule = {};
  for (const hit of hits) byRule[hit.rule] = (byRule[hit.rule] || 0) + 1;
  const entries = hits.map((h) => ({ key: h.key, rule: h.rule, file: h.file, line: h.line, match: h.match, text: h.text }));
  const payload = {
    version: 1,
    generator: 'scripts/check-design-tokens.mjs',
    note: '过渡台账：只允许缩小。还清后重跑 --baseline 收缩；不是永久豁免。约定见 docs/ARCHITECTURE.md §14。',
    scope: [`${SCAN_ROOT}/**/*.css`, `${SCAN_ROOT}/**/*.{ts,tsx}`],
    whitelist: [TOKEN_FILE, 'transparent / alpha=0', '0 值', 'var() 令牌值', '--font-mono / --mono 规则块', 'design-ok 行内注释'],
    rules: RULES,
    generatedAt: new Date().toISOString(),
    summary: { files: stats.files, scanned: stats.files - 1, css: stats.css, code: stats.code, violations: hits.length, byRule },
    entries,
  };
  mkdirSync(dirname(abs(BASELINE_FILE)), { recursive: true });
  writeFileSync(abs(BASELINE_FILE), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  const before = previous ? previous.entries.length : null;
  const delta = before === null ? '（首次生成）' : `（上一版 ${before} 条 → ${before - entries.length >= 0 ? '还清' : '新增'} ${Math.abs(before - entries.length)} 条）`;
  console.log(`✓ 基线已写入 ${BASELINE_FILE}：${entries.length} 条${delta}`);
  console.log('  基线是过渡台账，不是永久豁免——新违例一律当场修，存量按批次还清后重跑 --baseline 收缩。');
}

// ---------------------------------------------------------------- 主流程

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

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(2);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('用法：node scripts/check-design-tokens.mjs [--baseline | --check-baseline] [--json]');
    return;
  }

  const { files, css, code, polish } = collectTargets();
  const missing = REQUIRED_FILES.filter((f) => !existsSync(abs(f)));
  if (missing.length) {
    console.error(`✗ 规格点名的扫描目标缺失：${missing.join('、')}（检查器或仓库结构已变）`);
    process.exitCode = 1;
    return;
  }
  if (files.length < MIN_FILES || polish.length < MIN_POLISH_CSS) {
    console.error(`✗ 扫描面异常收缩：命中 ${files.length} 文件（下限 ${MIN_FILES}）、polish/*.css ${polish.length}（下限 ${MIN_POLISH_CSS}）——拒绝以空扫描静默通过`);
    process.exitCode = 1;
    return;
  }

  const raw = [];
  for (const file of files) {
    if (file === TOKEN_FILE) continue; // 令牌唯一权威来源，白名单
    if (file.endsWith('.css')) scanCss(file, raw);
    else scanCode(file, raw);
  }
  const hits = withKeys(sortHits(raw));
  const stats = { files: files.length, css: css.length, code: code.length };

  if (opts.mode === 'baseline') {
    writeBaseline(hits, stats, readBaseline());
    return;
  }

  const byRule = {};
  for (const hit of hits) byRule[hit.rule] = (byRule[hit.rule] || 0) + 1;
  const scanned = files.length - 1;
  const show = (h) => `✗ [${h.rule}] ${h.file}:${h.line}  ${h.match}  ·  ${h.text}`;

  if (opts.mode === 'check-baseline') {
    const baseline = readBaseline();
    if (!baseline) {
      console.error(`✗ 基线不存在（${BASELINE_FILE}）——先跑 node scripts/check-design-tokens.mjs --baseline`);
      process.exitCode = 1;
      return;
    }
    const known = new Set(baseline.entries.map((e) => e.key));
    const fresh = hits.filter((h) => !known.has(h.key));
    const current = new Set(hits.map((h) => h.key));
    const repaid = baseline.entries.filter((e) => !current.has(e.key));
    if (opts.json) {
      console.log(JSON.stringify({ mode: 'check-baseline', files: scanned, baseline: baseline.entries.length, newViolations: fresh, repaid }, null, 2));
    } else {
      console.log(`设计令牌检查（--check-baseline）：扫描 ${scanned} 文件，基线 ${baseline.entries.length} 条`);
      for (const h of fresh) console.log(show(h));
      if (fresh.length) console.log(`\n✗ 基线之外新增 ${fresh.length} 处违例（基线 ${baseline.entries.length} 条 / 现存 ${hits.length} 条）`);
      else console.log(`✓ 无新增违例（现存 ${hits.length} 条，全部在基线台账内）`);
      if (repaid.length) console.log(`ℹ 已还清 ${repaid.length} 条，基线可收缩：重跑 node scripts/check-design-tokens.mjs --baseline`);
    }
    if (fresh.length) process.exitCode = 1;
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify({ mode: 'check', ...stats, scanned, byRule, violations: hits }, null, 2));
  } else {
    console.log(`设计令牌检查：扫描 ${scanned} 文件（CSS ${css.length - 1} / TS·TSX ${code.length}），白名单跳过 ${TOKEN_FILE}`);
    for (const h of hits) console.log(show(h));
    if (hits.length) {
      const detail = Object.entries(byRule).map(([r, n]) => `${r} ${n}`).join(' / ');
      console.log(`\n✗ ${hits.length} 处违例（${detail}）`);
      console.log('  过渡期可用 --baseline 记台账、--check-baseline 只报新增；基线只许缩小，约定见 docs/ARCHITECTURE.md §14。');
    } else {
      console.log('✓ 无违例：CSS/组件内无硬编码色值，字阶全部走令牌。');
    }
  }
  if (hits.length) process.exitCode = 1;
}

main();
