// 检查脚本共用的源码遮罩工具（node stdlib，无依赖）。
//
// 为什么抽成模块：`check-design-tokens.mjs` 与 `architecture-check.mjs` 都要在
// 「注释不算代码、字符串与非字符串分语境」的前提下扫源码。把同一份状态机复制两份，
// 必然随改随漂；而检查器的漂移就是静默盲区——正是本批「规范可执行化」要消灭的东西。
//
// 约定：遮罩只做等长替换（保留 \n），因此遮罩文本上的偏移量与原文逐字符对齐，
// 行号、列号可以直接回报给用户。仓库已有 scripts 之间互相 import 的先例
// （smoke-*.mjs ← scripts/fixtures/*.mjs），本模块同属脚本侧工具。

/** CSS 块注释 → 等长空格（保留换行，偏移不失真）。
 *  注意 out 用 split('')（UTF-16 单元）而不是 [...text]（码点）：emoji 等增补平面字符
 *  会让码点数 < text.length，等长遮罩的偏移对齐约定就破了——行号列号会整体错位。 */
export function maskCss(text) {
  const out = text.split('');
  let i = 0;
  while (i < text.length) {
    if (text[i] === '/' && text[i + 1] === '*') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] !== '\n') out[i] = ' ';
        i += 1;
      }
      if (i < text.length) {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
      }
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/**
 * TS/TSX/JS 词法遮罩：注释抹平，同时标出每个字符是否落在字符串/模板字面量内。
 * - `masked`：注释替换为空格，其余原样（含字符串），偏移与原文对齐
 * - `inString[i]`：第 i 个字符是否属于字符串/模板字面量（含定界符与转义序列）
 */
export function maskTs(text) {
  // 同 maskCss：UTF-16 单元数组，保证 out/inString 与 text 逐单元对齐（emoji 不再错位）
  const out = text.split('');
  const inString = new Array(text.length).fill(false);
  const stack = []; // 模板字面量 ${} 的嵌套栈
  let mode = 'code';
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (mode === 'code') {
      if (c === '/' && n === '/') { out[i] = ' '; out[i + 1] = ' '; mode = 'line'; i += 2; continue; }
      if (c === '/' && n === '*') { out[i] = ' '; out[i + 1] = ' '; mode = 'block'; i += 2; continue; }
      if (c === "'") { mode = 'sq'; inString[i] = true; i += 1; continue; }
      if (c === '"') { mode = 'dq'; inString[i] = true; i += 1; continue; }
      if (c === '`') { mode = 'tpl'; inString[i] = true; i += 1; continue; }
      if (c === '{') { depth += 1; i += 1; continue; }
      if (c === '}') {
        if (depth === 0 && stack.length) { stack.pop(); mode = 'tpl'; } else { depth -= 1; }
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (mode === 'line') {
      if (c === '\n') mode = 'code';
      else out[i] = ' ';
      i += 1;
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && n === '/') { out[i] = ' '; out[i + 1] = ' '; mode = 'code'; i += 2; continue; }
      if (c !== '\n') out[i] = ' ';
      i += 1;
      continue;
    }
    // 字符串族：单引号 / 双引号 / 模板
    inString[i] = true;
    if (c === '\\') { inString[i + 1] = true; i += 2; continue; }
    if (mode === 'sq' && c === "'") { mode = 'code'; i += 1; continue; }
    if (mode === 'dq' && c === '"') { mode = 'code'; i += 1; continue; }
    if (mode === 'tpl') {
      if (c === '`') { mode = 'code'; i += 1; continue; }
      if (c === '$' && n === '{') {
        stack.push('tpl');
        mode = 'code';
        depth = 0;
        inString[i] = true;
        inString[i + 1] = true;
        i += 2;
        continue;
      }
    }
    i += 1;
  }
  return { masked: out.join(''), inString };
}

/** 每一行起始偏移（供 offset → 行号换算） */
export function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

/** 二分查 offset 所在行号（1 基） */
export function lineOfAt(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** JSONC-lite：剥掉 JSON 里的注释（tsconfig.json 允许注释），字符串内的 // 不动 */
export function parseJsonc(text) {
  let out = '';
  let mode = 'code';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (mode === 'code') {
      if (c === '"') { mode = 'sq'; out += c; i += 1; continue; }
      if (c === '/' && n === '/') { mode = 'line'; i += 2; continue; }
      if (c === '/' && n === '*') { mode = 'block'; i += 2; continue; }
      out += c;
      i += 1;
      continue;
    }
    if (mode === 'line') { if (c === '\n') { mode = 'code'; out += c; } i += 1; continue; }
    if (mode === 'block') { if (c === '*' && n === '/') { mode = 'code'; i += 2; continue; } i += 1; continue; }
    out += c;
    if (c === '\\') { out += text[i + 1] ?? ''; i += 2; continue; }
    if (c === '"') mode = 'code';
    i += 1;
  }
  return JSON.parse(out);
}
