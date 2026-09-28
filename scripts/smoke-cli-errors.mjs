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

// 可执行路径等值判定两形态：大小写不敏感平台（win32）折叠——同一可执行文件的别名
// 写法（大小写差异）判等，ELECTRON_RUN_AS_NODE 兜底不漏打；大小写敏感平台精确比较。
const flipFirstSegment = (candidate) => {
  const sepIndex = candidate.indexOf(path.sep)
  const head = sepIndex === -1 ? candidate : candidate.slice(0, sepIndex)
  const flipped = head[0] === head[0].toLowerCase() ? head[0].toUpperCase() + head.slice(1) : head[0].toLowerCase() + head.slice(1)
  return sepIndex === -1 ? flipped : flipped + candidate.slice(sepIndex)
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
