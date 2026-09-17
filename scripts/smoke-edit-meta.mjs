// 冒烟：agent 工具事件（kind:'tool'）的编辑元数据 data.edit
// [1] parseEditMeta 用例矩阵：Write / Edit / MultiEdit / apply_patch / 坏 JSON / 超限截断 / 非编辑工具 null
// [2] cli-common 的 toolEvent 助手透传 data.edit（不改变原有 data 字段）
// [3] zcode 端到端：edit 元数据必须算自 tool_input_delta 累积的**原始**入参
//     （事件里的 args 是 compactToolArgs 压过的 200 字预览，用它算不出全文和行数）
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

const root = path.resolve(import.meta.dirname, '..')
const outDir = path.join(root, 'out')
const assert = (cond, msg) => {
  if (!cond) {
    console.error('❌ ASSERT FAIL:', msg)
    process.exit(1)
  }
  console.log('  ✓', msg)
}
const eq = (actual, expected, msg) => {
  if (actual !== expected) {
    console.error('❌ ASSERT FAIL:', `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`)
    process.exit(1)
  }
  console.log('  ✓', msg)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

for (const [src, out] of [
  ['src/main/backends/edit-meta.ts', 'smoke-edit-meta.cjs'],
  ['src/main/backends/cli-common.ts', 'smoke-edit-meta-cli-common.cjs'],
  ['src/main/backends/zcode.ts', 'smoke-edit-meta-zcode.cjs']
]) {
  await build({
    entryPoints: [path.join(root, src)],
    outfile: path.join(outDir, out),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['electron']
  })
}
const { parseEditMeta, countEditLines, stringifyToolArgs } = await import(pathToFileURL(path.join(outDir, 'smoke-edit-meta.cjs')).href)
const { toolEvent } = await import(pathToFileURL(path.join(outDir, 'smoke-edit-meta-cli-common.cjs')).href)

// ───────────────────────── [1] 解析矩阵 ─────────────────────────
console.log('[1] parseEditMeta 用例矩阵...')
{
  console.log(' · Write / NotebookEdit 类')
  const content = 'line1\nline2\nline3\n'
  const write = parseEditMeta('Write', JSON.stringify({ file_path: 'src/a.ts', content }))
  eq(write?.file, 'src/a.ts', 'Write: file')
  eq(write?.additions, 3, 'Write: additions = 内容行数（结尾换行不算新行）')
  eq(write?.deletions, 0, 'Write: deletions = 0')
  eq(write?.content, content, 'Write: content 原文保留')
  assert(!('oldString' in write) && !('newString' in write), 'Write: 不产出 oldString/newString')
  assert(write.truncated === undefined, 'Write: 未超限时不置 truncated')

  const nb = parseEditMeta('NotebookEdit', JSON.stringify({ notebook_path: 'nb/analysis.ipynb', new_source: 'x = 1\ny = 2' }))
  eq(nb?.file, 'nb/analysis.ipynb', 'NotebookEdit: file 取 notebook_path')
  eq(nb?.additions, 2, 'NotebookEdit: additions = new_source 行数')

  const empty = parseEditMeta('Write', JSON.stringify({ file_path: 'empty.txt', content: '' }))
  eq(empty?.additions, 0, 'Write: 空文件 additions = 0')
  eq(empty?.content, '', 'Write: 空文件 content = 空串')

  console.log(' · Edit / str_replace 类')
  const edit = parseEditMeta('Edit', JSON.stringify({ file_path: 'src/b.ts', old_string: 'a\nb', new_string: 'a\nb\nc' }))
  eq(edit?.file, 'src/b.ts', 'Edit: file')
  eq(edit?.deletions, 2, 'Edit: deletions = old 行数')
  eq(edit?.additions, 3, 'Edit: additions = new 行数')
  eq(edit?.oldString, 'a\nb', 'Edit: oldString 保留')
  eq(edit?.newString, 'a\nb\nc', 'Edit: newString 保留')
  assert(!('content' in edit), 'Edit: 不产出 content（避免与 Write 语义混淆）')

  const pureDelete = parseEditMeta('Edit', JSON.stringify({ file_path: 'src/b.ts', old_string: 'gone\nline', new_string: '' }))
  eq(pureDelete?.additions, 0, 'Edit: 纯删除 additions = 0')
  eq(pureDelete?.deletions, 2, 'Edit: 纯删除 deletions = 2')

  const mcp = parseEditMeta('mcp__filesystem__edit_file', JSON.stringify({ path: 'src/c.ts', oldText: 'x', newText: 'y\nz' }))
  eq(mcp?.file, 'src/c.ts', 'MCP 命名（mcp__fs__edit_file）按 Edit 类分派')
  eq(mcp?.additions, 2, 'MCP: additions = 2')
  eq(mcp?.deletions, 1, 'MCP: deletions = 1')

  const strReplace = parseEditMeta('str_replace_editor', JSON.stringify({ command: 'str_replace', path: 'src/d.ts', old_str: 'one', new_str: 'two\nthree' }))
  eq(strReplace?.additions, 2, 'str_replace_editor: additions = 2')

  console.log(' · MultiEdit 类')
  const multi = parseEditMeta(
    'MultiEdit',
    JSON.stringify({
      file_path: 'src/e.ts',
      edits: [
        { old_string: 'a', new_string: 'a\nb' },
        { old_string: 'x\ny', new_string: 'z' }
      ]
    })
  )
  eq(multi?.file, 'src/e.ts', 'MultiEdit: file')
  eq(multi?.additions, 3, 'MultiEdit: additions 逐项累加（2 + 1）')
  eq(multi?.deletions, 3, 'MultiEdit: deletions 逐项累加（1 + 2）')
  eq(multi?.newString, 'a\nb\nz', 'MultiEdit: newString 多段拼接')

  console.log(' · apply_patch / diff 类（patch 文本为权威）')
  const codexPatch = [
    '*** Begin Patch',
    '*** Update File: src/f.ts',
    '@@',
    ' context',
    '-old line',
    '+new line 1',
    '+new line 2',
    '*** End Patch'
  ].join('\n')
  const patched = parseEditMeta('apply_patch', codexPatch)
  eq(patched?.file, 'src/f.ts', 'apply_patch: file 取 patch 头（*** Update File:）')
  eq(patched?.additions, 2, 'apply_patch: additions 按 patch 文本统计')
  eq(patched?.deletions, 1, 'apply_patch: deletions 按 patch 文本统计')

  const unified = ['--- a/src/g.ts', '+++ b/src/g.ts', '@@ -1 +1,2 @@', '-x', '+y', '+z'].join('\n')
  const unifiedMeta = parseEditMeta('apply_patch', unified)
  eq(unifiedMeta?.file, 'src/g.ts', 'unified diff: file 取 +++ 头（去掉 b/ 前缀）')
  eq(unifiedMeta?.additions, 2, 'unified diff: additions = 2')
  eq(unifiedMeta?.deletions, 1, 'unified diff: deletions = 1')

  // codex 的 apply_patch 走 Bash（原始命令文本，非 JSON）：靠 patch 特征兜底
  const codexBash = "apply_patch <<'PATCH'\n" + codexPatch + '\nPATCH\n'
  const bashPatch = parseEditMeta('Bash', JSON.stringify({ command: codexBash }))
  eq(bashPatch?.file, 'src/f.ts', 'codex Bash apply_patch: 兜底识别 patch 文本')
  eq(bashPatch?.additions, 2, 'codex Bash apply_patch: additions = 2')

  const rawCommand = "apply_patch <<'PATCH'\n" + codexPatch + '\nPATCH\n'
  eq(parseEditMeta('Bash', rawCommand)?.additions, 2, 'codex Bash（原始命令文本，非 JSON）同样识别')

  const gitDiff = ['diff --git a/src/h.ts b/src/h.ts', 'index 111..222 100644', '--- a/src/h.ts', '+++ b/src/h.ts', '@@ -1,2 +1 @@', '-a', '-b', '+c'].join('\n')
  const gitMeta = parseEditMeta('apply_patch', gitDiff)
  eq(gitMeta?.file, 'src/h.ts', 'git diff: 文件头正确解析')
  eq(gitMeta?.additions, 1, 'git diff: additions = 1（+++ 头不算）')
  eq(gitMeta?.deletions, 2, 'git diff: deletions = 2（--- 头不算）')

  console.log(' · 坏 JSON / 畸形入参 → null（绝不 throw）')
  eq(parseEditMeta('Write', '{"file_path":"src/a.ts","content":'), null, '截断的 JSON → null')
  eq(parseEditMeta('Edit', ''), null, '空入参 → null')
  eq(parseEditMeta('Edit', undefined), null, 'args 为 undefined → null')
  eq(parseEditMeta('Edit', null), null, 'args 为 null → null')
  eq(parseEditMeta('Edit', 'not json at all'), null, '非 JSON 文本 → null')
  eq(parseEditMeta('Write', '{"file_path":'), null, '半个对象 → null')
  eq(parseEditMeta('Write', '[]'), null, 'JSON 数组 → null')
  eq(parseEditMeta('', '{"file_path":"a","content":"x"}'), null, '工具名为空 → null')
  eq(parseEditMeta(null, null), null, '入参全空 → null（不抛）')
  eq(parseEditMeta('apply_patch', '*** Begin Patch\n+orphan\n*** End Patch'), null, 'patch 无文件头 → null（file 是必需字段）')
  eq(parseEditMeta('Edit', JSON.stringify({ file_path: 'a.ts', old_string: '', new_string: '' })), null, 'old/new 都空 → null')
  eq(parseEditMeta('Write', JSON.stringify({ file_path: 'a.ts', content: { nested: true } })), null, 'content 不是字符串 → null')
  eq(parseEditMeta('Edit', JSON.stringify({ old_string: 'a', new_string: 'b' })), null, 'Edit 缺 file → null')

  console.log(' · 非编辑工具 → null')
  eq(parseEditMeta('Read', JSON.stringify({ file_path: 'src/a.ts' })), null, 'Read → null')
  eq(parseEditMeta('Grep', JSON.stringify({ pattern: 'foo', path: 'src', output_mode: 'content' })), null, 'Grep → null')
  eq(parseEditMeta('Bash', JSON.stringify({ command: 'ls -la', description: 'list' })), null, 'Bash{ls} → null')
  eq(parseEditMeta('Glob', JSON.stringify({ pattern: '**/*.ts' })), null, 'Glob → null')
  eq(parseEditMeta('WebFetch', JSON.stringify({ url: 'https://example.com', content: 'x' })), null, 'WebFetch → null')
  eq(parseEditMeta('TodoWrite', JSON.stringify({ todos: [{ content: 'x', status: 'pending' }] })), null, 'TodoWrite → null')
  eq(parseEditMeta('Task', JSON.stringify({ file_path: 'a.ts', content: 'b' })), null, '未识别工具不做 file+content 兜底 → null')
  eq(parseEditMeta('Bash', JSON.stringify({ command: "echo '+not a patch' > f.txt" })), null, 'Bash 里的 +/- 文本没有 patch 特征 → null')

  console.log(' · 64KB 截断（行数仍按全文）')
  eq(countEditLines('a\nb\n'), 2, 'countEditLines: 结尾换行不算新行')
  eq(countEditLines('a\n\n'), 2, 'countEditLines: 中间空行算一行')
  eq(countEditLines(''), 0, 'countEditLines: 空串 0 行')
  eq(countEditLines('\n'), 1, 'countEditLines: 单个换行 = 1 个空行')
  eq(countEditLines('a\r\nb'), 2, 'countEditLines: CRLF 归一')

  const LIMIT = 64 * 1024
  const exact = parseEditMeta('Write', JSON.stringify({ file_path: 'exact.txt', content: 'a'.repeat(LIMIT) }))
  eq(exact?.content?.length, LIMIT, `刚好 ${LIMIT} 字符不截断`)
  assert(exact.truncated === undefined, '刚好到上限不置 truncated')

  const overContent = 'a'.repeat(LIMIT + 1)
  const over = parseEditMeta('Write', JSON.stringify({ file_path: 'over.txt', content: overContent }))
  eq(over?.content?.length, LIMIT, `超 1 字符 → content 截到 ${LIMIT}`)
  assert(over.truncated === true, '超限 → truncated = true')
  eq(over?.additions, 1, '超限时 additions 仍按全文行数')

  const manyLines = Array.from({ length: 2000 }, (_, i) => `line-${String(i).padStart(4, '0')}-${'x'.repeat(30)}`).join('\n')
  assert(manyLines.length > LIMIT, `构造的多行内容超限（${manyLines.length} 字符）`)
  const bigWrite = parseEditMeta('Write', JSON.stringify({ file_path: 'big.txt', content: manyLines }))
  eq(bigWrite?.additions, 2000, '超限时行数按全文统计（2000 行）')
  eq(bigWrite?.content?.length, LIMIT, '超限 content 截到上限')
  assert(manyLines.startsWith(bigWrite.content), 'content 是原文前缀（截断不破坏内容）')
  assert(bigWrite.truncated === true, '超限 → truncated = true')

  const bigEdit = parseEditMeta(
    'Edit',
    JSON.stringify({ file_path: 'big2.txt', old_string: 'o'.repeat(LIMIT + 10) + '\nsecond', new_string: 'n'.repeat(LIMIT + 10) + '\nsecond' })
  )
  eq(bigEdit?.oldString?.length, LIMIT, 'Edit: oldString 截到上限')
  eq(bigEdit?.newString?.length, LIMIT, 'Edit: newString 截到上限')
  eq(bigEdit?.deletions, 2, 'Edit: 超限时 deletions 按全文行数')
  eq(bigEdit?.additions, 2, 'Edit: 超限时 additions 按全文行数')
  assert(bigEdit.truncated === true, 'Edit 超限 → truncated = true')

  const bigMulti = parseEditMeta(
    'MultiEdit',
    JSON.stringify({ file_path: 'big3.txt', edits: [{ old_string: 'a', new_string: 'x'.repeat(LIMIT) }, { old_string: 'b', new_string: 'y'.repeat(LIMIT) }] })
  )
  eq(bigMulti?.newString?.length, LIMIT, 'MultiEdit: 拼接后的 newString 也受上限约束')
  assert(bigMulti.truncated === true, 'MultiEdit 超限 → truncated = true')

  assert(stringifyToolArgs({ a: 1 }) === '{"a":1}', 'stringifyToolArgs: 对象序列化')
  assert(stringifyToolArgs(undefined) === '' && stringifyToolArgs(null) === '', 'stringifyToolArgs: 空值 → 空串')
}

// ───────────────────────── [2] toolEvent 透传 ─────────────────────────
console.log('[2] cli-common toolEvent 透传 data.edit...')
{
  const edit = { file: 'src/a.ts', additions: 3, deletions: 1 }
  const started = toolEvent('started', 'Write', { args: '{"file_path":"src/a.ts"}' }, edit)
  eq(started.kind, 'tool', 'toolEvent: kind = tool')
  eq(started.text, 'Write', 'toolEvent: text = 工具名')
  eq(started.data.phase, 'started', 'toolEvent: data.phase 保留')
  eq(started.data.args, '{"file_path":"src/a.ts"}', 'toolEvent: data.args 保留')
  eq(started.data.edit, edit, 'toolEvent: data.edit 透传')

  const none = toolEvent('result', 'Read', { ok: true, preview: 'x' }, null)
  assert(!('edit' in none.data), 'toolEvent: 无编辑元数据时不挂 edit 字段')
  eq(none.data.ok, true, 'toolEvent: 原有字段不受影响')

  const noArg = toolEvent('result', 'Read', { ok: true })
  assert(!('edit' in noArg.data), 'toolEvent: 省略第 4 参不挂 edit 字段')
}

// ───────────────────────── [3] zcode 端到端 ─────────────────────────
console.log('[3] zcode 端到端：原始累积入参 → data.edit...')
{
  const { createZcodeBackend } = await import(pathToFileURL(path.join(outDir, 'smoke-edit-meta-zcode.cjs')).href)
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-editmeta-'))
  // start() 会做 provider config 存在性检查：给个占位文件，别让它去动全局 zcode 缓存
  fs.mkdirSync(path.join(fixtureDir, 'provider'), { recursive: true })
  fs.writeFileSync(path.join(fixtureDir, 'provider', 'zcode-builtin.json'), '{}')
  const serverPath = path.join(fixtureDir, 'fake-zcode-tool-events.mjs')
  // eslint-disable-next-line no-useless-concat
  fs.writeFileSync(serverPath, [
    "import readline from 'node:readline'",
    'const rl = readline.createInterface({ input: process.stdin })',
    "const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n')",
    "const WRITE_CONTENT = Array.from({ length: 120 }, (_, i) => 'line ' + i + ' ' + 'x'.repeat(12)).join('\\n')",
    "const writeArgs = JSON.stringify({ file_path: 'src/demo.ts', content: WRITE_CONTENT })",
    "const ev = (type, payload) => write({ method: 'session/event', params: { type, payload } })",
    'function emitToolEvents() {',
    "  ev('model.streaming', { kind: 'tool_input_start', toolCallId: 'tc_write', toolName: 'Write' })",
    '  for (let i = 0; i < writeArgs.length; i += 40) {',
    "    ev('model.streaming', { kind: 'tool_input_delta', toolCallId: 'tc_write', delta: writeArgs.slice(i, i + 40) })",
    '  }',
    "  ev('tool.updated', { kind: 'started', toolCallId: 'tc_write', toolName: 'Write' })",
    "  ev('tool.updated', { kind: 'result', toolCallId: 'tc_write', toolName: 'Write', duration: 7, result: { success: true, content: 'wrote src/demo.ts' } })",
    "  ev('tool.updated', { kind: 'started', toolCallId: 'tc_bash', toolName: 'Bash' })",
    "  ev('tool.updated', { kind: 'result', toolCallId: 'tc_bash', toolName: 'Bash', result: { success: true, content: 'ok' } })",
    "  ev('model.streaming', { kind: 'text_delta', delta: 'done' })",
    "  ev('turn.completed', { kind: 'turn.terminal', status: 'success', resultType: 'finish', durationMs: 5, tokenCount: 1, toolCallCount: 2 })",
    '}',
    "rl.on('line', (line) => {",
    '  let msg',
    '  try { msg = JSON.parse(line) } catch { return }',
    '  if (msg.id === undefined) return',
    '  switch (msg.method) {',
    "    case 'session/create': write({ id: msg.id, result: { session: { sessionId: 'sess_edit_meta' } } }); break",
    "    case 'session/resume': write({ id: msg.id, result: { session: { sessionId: String((msg.params && msg.params.sessionId) || 'sess_edit_meta') } } }); break",
    "    case 'session/subscribe': write({ id: msg.id, result: {} }); break",
    "    case 'session/send': write({ id: msg.id, result: {} }); setTimeout(emitToolEvents, 20); break",
    "    case 'session/stop': write({ id: msg.id, result: {} }); break",
    "    case 'session/close': write({ id: msg.id, result: {} }); break",
    '    default: write({ id: msg.id, result: {} })',
    '  }',
    '})',
    ''
  ].join('\n'))

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-editmeta-wd-'))
  const events = []
  const backend = createZcodeBackend(() => ({ nodePath: process.execPath, zcodePath: serverPath }))
  let session = null
  let startError = null
  let endTurn = () => {}
  const turnEnded = new Promise((resolve) => { endTurn = resolve })
  backend
    .start({
      prompt: 'hi',
      workdir,
      mode: 'yolo',
      events: {
        onEvent: (e) => events.push(e),
        onTurnEnd: (r) => endTurn(r)
      }
    })
    .then((s) => { session = s }, (e) => { startError = e instanceof Error ? e : new Error(String(e)) })
  await wait(1500) // start 只等 ack，不等回合终态

  if (startError) {
    // 本机没有 zcode 登录态/provider 配置时属于环境缺失，不算回归；其余失败一律挂掉
    if (/zcode|provider|config|登录|未找到|ENOENT|EACCES/i.test(startError.message)) {
      console.log('  ⚠ SKIP zcode 端到端：本机 zcode 环境不可用 —', startError.message.slice(0, 140))
    } else {
      assert(false, `zcode start 意外失败: ${startError.message}`)
    }
  } else {
    const r = await Promise.race([turnEnded, wait(8000).then(() => null)])
    assert(r && r.ok, `zcode 首回合正常收尾 (got ${JSON.stringify(r).slice(0, 120)})`)

    const toolEvents = events.filter((e) => e.kind === 'tool')
    const writeStarted = toolEvents.find((e) => e.data?.phase === 'started' && e.text === 'Write')
    assert(!!writeStarted, 'zcode: Write started 事件到达')
    const edit = writeStarted.data.edit
    assert(!!edit, 'zcode: Write started 带 data.edit')
    eq(edit.file, 'src/demo.ts', 'zcode: edit.file')
    eq(edit.additions, 120, 'zcode: edit.additions = 全文 120 行')
    eq(edit.deletions, 0, 'zcode: edit.deletions = 0')
    assert(typeof edit.content === 'string' && edit.content.startsWith('line 0 '), 'zcode: content 来自原始累积串')
    assert(edit.content.length > 200, `zcode: content 是全文而非 200 字预览（${edit.content.length} 字符）`)
    assert(
      String(writeStarted.data.args).length <= 201 && writeStarted.data.args !== edit.content,
      'zcode: data.args 仍是压缩预览（未被 edit 元数据改动）'
    )

    const writeResult = toolEvents.find((e) => e.data?.phase === 'result' && e.text === 'Write')
    eq(writeResult?.data?.edit?.additions, 120, 'zcode: result 事件同样带 data.edit')

    const bashStarted = toolEvents.find((e) => e.text === 'Bash' && e.data?.phase === 'started')
    assert(!!bashStarted && !bashStarted.data.edit, 'zcode: 非编辑工具（Bash）不带 data.edit')
    await session.close()
  }
  fs.rmSync(fixtureDir, { recursive: true, force: true })
  fs.rmSync(workdir, { recursive: true, force: true })
}

console.log('✅ SMOKE PASSED')
