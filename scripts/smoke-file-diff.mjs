// 编辑详情「单文件 git 权威 diff」冒烟：临时 git 仓库造八场景，断言 numstat 数与 diff 形态。
// 八场景：未修改 / 已修改未暂存 / 已暂存 / 混合 / 二进制 / 新文件 / 删除文件 / 非仓库
// 另加：文件不存在、无工作目录、路径逃逸、未跟踪大文件截断、中文文件名、反斜杠归一化
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const outfile = path.join(root, 'out', 'smoke-file-diff.cjs')
await build({ entryPoints: [path.join(root, 'src/main/git.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
const { fileDiff, fileDiffFailure, normalizeRepoFilePath, FILE_DIFF_MAX_CHARS } = await import(pathToFileURL(outfile).href)

const assert = (cond, label) => { if (!cond) throw new Error(label) }
const eq = (actual, expected, label) => {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
const count = (text, marker) => text.split(marker).length - 1

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-filediff-'))
const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-filediff-plain-'))
const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
const write = (rel, text) => {
  const abs = path.join(dir, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}
/** 用 git 自己的 numstat 交叉验证 ± 行数（二进制 '-' 不可数、未跟踪文件不在 diff 视野 → 返回 null） */
const gitNumstat = (file) => {
  const rows = [
    ...git('diff', '--numstat', '--', file).trim().split('\n'),
    ...git('diff', '--cached', '--numstat', '--', file).trim().split('\n')
  ].filter(Boolean)
  if (!rows.length || rows.some((row) => row.startsWith('-\t'))) return null
  return rows.reduce((acc, row) => {
    const [added, removed] = row.split('\t')
    return { additions: acc.additions + Number(added), deletions: acc.deletions + Number(removed) }
  }, { additions: 0, deletions: 0 })
}

git('init', '-b', 'main')
git('config', 'user.email', 'smoke@example.com')
git('config', 'user.name', 'Smoke')
// 关掉换行转换：CRLF 归一化会凭空造出全文件差异，让 numstat 断言失去意义
git('config', 'core.autocrlf', 'false')
git('config', 'core.safecrlf', 'false')

const base = 'one\ntwo\nthree\n'
for (const file of ['clean.txt', 'mod.txt', 'staged.txt', 'mixed.txt', 'del.txt', 'sub/inner.txt', '中文 目录/文件.txt']) write(file, base)
fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0x0a]))
git('add', '.')
git('commit', '-m', 'base')

// 场景 2：已修改未暂存
fs.appendFileSync(path.join(dir, 'mod.txt'), 'four\n')
// 场景 3：已暂存
fs.appendFileSync(path.join(dir, 'staged.txt'), 'four\n')
git('add', 'staged.txt')
// 场景 4：混合（一段已暂存 + 一段未暂存，同一文件）
fs.appendFileSync(path.join(dir, 'mixed.txt'), 'four\n')
git('add', 'mixed.txt')
fs.appendFileSync(path.join(dir, 'mixed.txt'), 'five\n')
// 场景 5：二进制（追加字节，git 判为 binary）
fs.appendFileSync(path.join(dir, 'bin.dat'), Buffer.from([0x10, 0x00, 0x20]))
// 场景 6：新文件（未跟踪，git diff 视野外）
write('new.txt', 'n1\nn2\n')
// 场景 7：删除已跟踪文件（未暂存）
fs.rmSync(path.join(dir, 'del.txt'))
// 附加：反斜杠路径 + 中文路径
fs.appendFileSync(path.join(dir, 'sub/inner.txt'), 'four\n')
fs.appendFileSync(path.join(dir, '中文 目录/文件.txt'), 'four\n')

/** 断言一次 fileDiff 的完整形状；expected.cross=false 跳过 git numstat 交叉验证（未跟踪文件） */
const expectDiff = async (file, expected, label) => {
  const result = await fileDiff(dir, file)
  assert(result.ok, `${label}: expected ok, got ${result.code} ${result.error}`)
  eq(result.file, expected.file ?? file, `${label}: file`)
  eq(result.additions, expected.additions, `${label}: additions`)
  eq(result.deletions, expected.deletions, `${label}: deletions`)
  eq(result.binary, expected.binary === true, `${label}: binary`)
  eq(result.truncated, expected.truncated === true, `${label}: truncated`)
  if (expected.note === undefined) eq(result.note, undefined, `${label}: note should be absent`)
  else eq(result.note, expected.note, `${label}: note`)
  for (const marker of expected.includes ?? []) assert(result.diff.includes(marker), `${label}: diff missing ${JSON.stringify(marker)}`)
  for (const marker of expected.excludes ?? []) assert(!result.diff.includes(marker), `${label}: diff should not contain ${JSON.stringify(marker)}`)
  if (expected.exact !== undefined) eq(result.diff, expected.exact, `${label}: diff text`)
  if (expected.cross !== false) {
    const cross = gitNumstat(file)
    if (cross) {
      eq(result.additions, cross.additions, `${label}: additions vs git numstat`)
      eq(result.deletions, cross.deletions, `${label}: deletions vs git numstat`)
    }
  }
  return result
}

const failDiff = async (target, file, code, label) => {
  const result = await fileDiff(target, file)
  assert(!result.ok, `${label}: expected failure, got ok`)
  eq(result.code, code, `${label}: code`)
  assert(typeof result.error === 'string' && result.error.length > 0, `${label}: error message`)
  eq(result.diff, '', `${label}: failed result must not carry diff text`)
  return result
}

// 场景 1：未修改（存在但无改动 → note:'clean'，渲染层回退事件快照）
const clean = await expectDiff('clean.txt', { additions: 0, deletions: 0, note: 'clean', exact: '' }, 'clean file')
assert(clean.ok && clean.note === 'clean', 'clean file: note')

// 场景 2：已修改未暂存（工作区 vs 索引）
const modified = await expectDiff('mod.txt', {
  additions: 1, deletions: 0, includes: ['diff --git a/mod.txt b/mod.txt', '@@ -1,3 +1,4 @@', '+four']
}, 'unstaged modification')
assert(modified.diff.endsWith('\n'), 'unstaged modification: diff should keep git trailing newline')
eq(count(modified.diff, 'diff --git '), 1, 'unstaged modification: single section')

// 场景 3：已暂存（索引 vs HEAD）
await expectDiff('staged.txt', {
  additions: 1, deletions: 0, includes: ['diff --git a/staged.txt b/staged.txt', '@@ -1,3 +1,4 @@', '+four']
}, 'staged modification')

// 场景 4：混合 —— 两段 hunks 按序拼接（未暂存在前、已暂存在后），计数为两段之和
const mixed = await expectDiff('mixed.txt', {
  additions: 2, deletions: 0, includes: ['@@ -2,3 +2,4 @@', '+five', '@@ -1,3 +1,4 @@', '+four']
}, 'mixed staged + unstaged')
eq(count(mixed.diff, 'diff --git a/mixed.txt b/mixed.txt'), 2, 'mixed: two concatenated sections')
assert(mixed.diff.indexOf('+five') < mixed.diff.indexOf('+four'), 'mixed: unstaged section must come first')

// 场景 5：二进制（git 不给 +/- 行数，diff 不带文本）
await expectDiff('bin.dat', { additions: 0, deletions: 0, binary: true, exact: '' }, 'binary file')

// 场景 6：新文件（未跟踪 → --no-index 整文件新增；git 自身的 diff 看不到它）
await expectDiff('new.txt', {
  additions: 2, deletions: 0, cross: false,
  includes: ['new file mode', '--- /dev/null', '+++ b/new.txt', '@@ -0,0 +1,2 @@', '+n1', '+n2']
}, 'untracked new file')

// 场景 7：删除文件（未暂存删除 → 整文件删除）
await expectDiff('del.txt', {
  additions: 0, deletions: 3,
  includes: ['deleted file mode', '--- a/del.txt', '+++ /dev/null', '-one', '-two', '-three']
}, 'deleted file')

// 场景 8：非仓库（工作目录存在但不是 git 仓库）
await failDiff(plain, 'x.txt', 'not-a-repo', 'non-repo dir')

// 附加：文件不存在 / 无工作目录 / 路径逃逸 / 反斜杠与中文文件名 / 大文件截断
await failDiff(dir, 'no-such-file.txt', 'file-missing', 'missing file')
await failDiff('', 'mod.txt', 'no-workdir', 'empty workdir')
await failDiff(path.join(dir, 'no-such-dir'), 'mod.txt', 'no-workdir', 'missing workdir')
await failDiff(dir, '../outside.txt', 'bad-request', 'parent escape')
await failDiff(dir, '/etc/passwd', 'bad-request', 'absolute path')
await failDiff(dir, 'C:/Windows/system32/drivers/etc/hosts', 'bad-request', 'drive letter path')
await failDiff(dir, 'sub/../../outside.txt', 'bad-request', 'nested escape')
await failDiff(dir, '', 'bad-request', 'empty file path')

await expectDiff('sub\\inner.txt', { file: 'sub/inner.txt', additions: 1, deletions: 0, includes: ['+four'] }, 'backslash path')
await expectDiff('中文 目录/文件.txt', { additions: 1, deletions: 0, includes: ['中文 目录/文件.txt', '+four'] }, 'non-ascii path')

eq(normalizeRepoFilePath('a\\b\\c.txt'), 'a/b/c.txt', 'normalize backslashes')
eq(normalizeRepoFilePath('./a//b.txt'), 'a/b.txt', 'normalize duplicate separators')
eq(normalizeRepoFilePath('a/../b.txt'), null, 'normalize rejects ..')
eq(normalizeRepoFilePath('C:\\abs.txt'), null, 'normalize rejects drive letter')
eq(normalizeRepoFilePath('/abs.txt'), null, 'normalize rejects absolute path')
eq(FILE_DIFF_MAX_CHARS, 256 * 1024, 'diff cap is 256KB')

// 截断：未跟踪大文件（>256KB diff）→ 计数仍为全量，文本按行截断
const bigLines = 3000
write('big.txt', Array.from({ length: bigLines }, (_, i) => `line-${i}-${'x'.repeat(180)}`).join('\n') + '\n')
const big = await expectDiff('big.txt', { additions: bigLines, deletions: 0, truncated: true, cross: false }, 'truncated big file')
assert(big.diff.length <= FILE_DIFF_MAX_CHARS, `truncated big file: diff length ${big.diff.length} exceeds cap`)
assert(big.diff.endsWith('\n'), 'truncated big file: must cut on a line boundary')
assert(/\+line-\d+-x+\n$/.test(big.diff), 'truncated big file: last line must be a complete added line')
assert(big.diff.split('\n').every((line) => line === '' || line.startsWith('+') || line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('@@')), 'truncated big file: no half line')

// 失败形状统一：字段齐全，渲染层不必处理 reject
const failure = fileDiffFailure('x.txt', 'git-failed', 'boom')
eq(Object.keys(failure).sort().join(','), 'additions,binary,code,deletions,diff,error,file,ok,truncated', 'failure shape keys')

fs.rmSync(plain, { recursive: true, force: true })
fs.rmSync(dir, { recursive: true, force: true })
console.log('✓ 八场景：未修改 / 未暂存 / 已暂存 / 混合 / 二进制 / 新文件 / 删除 / 非仓库')
console.log('✓ 计数与 git numstat 一致；截断只截文本；错误码分流；中文与反斜杠路径')
console.log('✅ FILE DIFF SMOKE PASSED')
