import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const outfile = path.join(root, 'out', 'smoke-cli-common.cjs')
await build({ entryPoints: [path.join(root, 'src/main/backends/cli-common.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
const { runCliJsonl, sameExecutablePath } = await import(pathToFileURL(outfile).href)

const run = (code) => new Promise((resolve) => {
  const lines = []; const raw = []
  const runner = runCliJsonl({ command: process.execPath, prefixArgs: [], args: ['-e', code], cwd: root, idleTimeoutMs: 5000, onLine: (obj) => lines.push(obj), onRaw: (line) => raw.push(line) })
  runner.exited.then((result) => resolve({ result, lines, raw }))
})

const failed = await run("console.error('boom'); process.exit(7)")
if (failed.result.code !== 7 || !failed.result.stderrTail.includes('boom')) throw new Error('non-zero exit was not preserved')
const malformed = await run("process.stdout.write('{bad-json}\\n')")
if (malformed.result.parseErrors !== 1 || malformed.raw.length !== 1) throw new Error('JSON parse failure was not surfaced')
const empty = await run('process.exit(0)')
if (empty.result.code !== 0 || empty.result.stdoutBytes !== 0 || empty.result.lineCount !== 0) throw new Error('empty output result is incorrect')
console.log('✓ non-zero exit, JSON parse failure and empty output')

// stdin 投喂：超长 prompt 不再走 argv（Windows CreateProcess 32767 字符命令行上限，
// 会议上下文随轮次膨胀到 46K 时 claude/codex spawn ENAMETOOLONG 实战）。含一例
// 超限载荷——argv 版在 win32 必炸，stdin 版必须原样送达。
const readStdin = "let d='';process.stdin.setEncoding('utf8').on('data',c=>d+=c).on('end',()=>{process.stdout.write(JSON.stringify({len:d.length,head:d.slice(0,6)}))+'\\n'})"
const small = await new Promise((resolve) => {
  const lines = []
  const runner = runCliJsonl({ command: process.execPath, prefixArgs: [], args: ['-e', readStdin], cwd: root, stdin: 'secret', idleTimeoutMs: 5000, onLine: (obj) => lines.push(obj) })
  runner.exited.then((result) => resolve({ result, lines }))
})
if (small.result.code !== 0 || small.lines[0]?.len !== 6 || small.lines[0]?.head !== 'secret') throw new Error('stdin payload was not delivered intact')
const hugePayload = 'x'.repeat(46_116)
const huge = await new Promise((resolve) => {
  const lines = []
  const runner = runCliJsonl({ command: process.execPath, prefixArgs: [], args: ['-e', readStdin], cwd: root, stdin: hugePayload, idleTimeoutMs: 5000, onLine: (obj) => lines.push(obj) })
  runner.exited.then((result) => resolve({ result, lines }))
})
if (huge.result.code !== 0 || huge.lines[0]?.len !== hugePayload.length) throw new Error('oversized (46K) stdin payload failed — the ENAMETOOLONG class is not fixed')
console.log('✓ stdin delivery intact, including a 46K payload beyond the Windows argv limit')

// 可执行路径等值判定两形态：大小写不敏感平台（win32）折叠——同一可执行文件的别名
// 写法（大小写差异）判等，ELECTRON_RUN_AS_NODE 兜底不漏打；大小写敏感平台精确比较。
// 别名构造按平台通用：POSIX 绝对路径的首段是空串（/usr/...），从根分隔符后的第一个
// 非空段翻起——首段直接翻会让 head[0] 为 undefined 抛错（空-首段）
const flipFirstSegment = (candidate) => {
  const segments = candidate.split(path.sep)
  const index = segments.findIndex((segment) => segment !== '')
  if (index === -1) return candidate
  const segment = segments[index]
  segments[index] = segment[0] === segment[0].toLowerCase() ? segment[0].toUpperCase() + segment.slice(1) : segment[0].toLowerCase() + segment.slice(1)
  return segments.join(path.sep)
}
const aliasExecPath = flipFirstSegment(process.execPath)
const platformAware = (platform, fn) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: platform })
  try { return fn() } finally { Object.defineProperty(process, 'platform', descriptor) }
}
if (platformAware('win32', () => sameExecutablePath(aliasExecPath, process.execPath)) !== true) throw new Error('case-insensitive platform must fold alias executable spellings')
if (platformAware('win32', () => sameExecutablePath(process.execPath, process.execPath)) !== true) throw new Error('identical spellings must compare equal on any platform')
if (platformAware('win32', () => sameExecutablePath(path.join(path.dirname(process.execPath), 'definitely-not-the-same'), process.execPath)) !== false) throw new Error('distinct executables must not compare equal on a case-insensitive platform')
if (platformAware('linux', () => sameExecutablePath(aliasExecPath, process.execPath)) !== false) throw new Error('case-sensitive platform must compare alias spellings exactly (a case alias is a different file)')
if (platformAware('linux', () => sameExecutablePath(process.execPath, process.execPath)) !== true) throw new Error('identical spellings must compare equal on a case-sensitive platform')
console.log('✓ executable path equality folds alias spellings on win32 and compares exactly on case-sensitive platforms')
console.log('✅ CLI ERROR SMOKE PASSED')
