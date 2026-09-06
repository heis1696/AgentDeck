import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
const root = path.resolve(import.meta.dirname, '..')
const outfile = path.join(root, 'out', 'smoke-automation-store.cjs')
await build({ entryPoints: [path.join(root, 'src/main/automation-store.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
const { AutomationStore } = await import(pathToFileURL(outfile).href)
const store = new AutomationStore(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-auto-')))
const item = store.create({ name: 'Daily check', prompt: 'inspect', workdir: '', scheduleMinutes: 30, output: 'issue' })
const ok = (condition, label) => { console.log(`  ${condition ? '✓' : '✗'} ${label}`); if (!condition) process.exitCode = 1 }
ok(store.list().length === 1 && item.enabled, 'automation persists enabled')
store.markRun(item.id, 1000)
ok(store.get(item.id).lastRunAt === 1000 && store.get(item.id).nextRunAt === 1_801_000, 'run advances the next schedule')
store.update(item.id, { enabled: false })
ok(!store.get(item.id).enabled, 'automation can be paused')
store.remove(item.id)
ok(store.list().length === 0, 'automation can be deleted')
if (!process.exitCode) console.log('\n✓ AUTOMATION STORE SMOKE PASSED')
