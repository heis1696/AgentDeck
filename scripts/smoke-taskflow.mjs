import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
const root = path.resolve(import.meta.dirname, '..')
const outfile = path.join(root, 'out', 'smoke-taskflow.cjs')
await build({ entryPoints: [path.join(root, 'src/shared/taskflow.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
const { canTransition, validateMove } = await import(pathToFileURL(outfile).href)
let failed = 0
const ok = (condition, label) => { console.log(`  ${condition ? '✓' : '✗'} ${label}`); if (!condition) failed++ }
ok(canTransition('queued', 'running', 'runner'), 'runner starts queued task')
ok(canTransition('running', 'done', 'runner'), 'runner completes running task')
ok(!canTransition('cancelled', 'done', 'runner'), 'runner cannot revive cancelled task')
ok(validateMove('queued', 'running').ok, 'UI can start queued task')
ok(!validateMove('running', 'done').ok, 'UI cannot overwrite active execution')
ok(validateMove('done', 'queued').ok, 'UI can retry terminal task')
ok(!validateMove('done', 'running').ok, 'UI cannot jump terminal task to running')
if (failed) process.exitCode = 1
else console.log('\n✓ TASKFLOW SMOKE PASSED')
