import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const outfile = path.join(root, 'out', 'smoke-cli-common.cjs')
await build({ entryPoints: [path.join(root, 'src/main/backends/cli-common.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
const { runCliJsonl } = await import(pathToFileURL(outfile).href)

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
console.log('✅ CLI ERROR SMOKE PASSED')
