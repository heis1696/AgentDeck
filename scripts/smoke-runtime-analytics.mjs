import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const root = path.resolve(import.meta.dirname, '..')
const outdir = path.join(root, 'out', 'smoke-runtime-analytics')
await build({ entryPoints: [path.join(root, 'src/main/analytics.ts'), path.join(root, 'src/main/runtime.ts')], outdir, entryNames: 'smoke-[name]', bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
const { buildAnalytics } = await import(pathToFileURL(path.join(outdir, 'smoke-analytics.js')).href)
const { probeRuntimes } = await import(pathToFileURL(path.join(outdir, 'smoke-runtime.js')).href)
const ok = (condition, label) => { console.log(`  ${condition ? '✓' : '✗'} ${label}`); if (!condition) process.exitCode = 1 }
const tasks = [
  { id: 'done', title: 'Done', prompt: 'x', workdir: '', backend: 'zcode', agentId: 'ag_z', status: 'done', createdAt: 100, startedAt: 110, endedAt: 160, eventCount: 2, usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, costUsd: 0.2, durationMs: 50, turns: 1 } },
  { id: 'failed', title: 'Failed', prompt: 'x', workdir: '', backend: 'claude', status: 'failed', createdAt: 200, endedAt: 260, eventCount: 1, failure: { code: 'rate_limit', title: 'Rate limit', hint: 'retry', retryable: true } },
  { id: 'old', title: 'Old', prompt: 'x', workdir: '', backend: 'zcode', status: 'cancelled', createdAt: 1, endedAt: 2, eventCount: 0 }
]
const summary = buildAnalytics(tasks, [{ id: 'ag_z', name: 'Zed', backend: 'zcode', color: '#fff' }], 50, 300)
ok(summary.totals.runs === 2 && summary.totals.completed === 1 && summary.totals.failed === 1, 'date-filtered usage totals')
ok(summary.totals.inputTokens === 10 && summary.errors[0]?.code === 'rate_limit', 'usage and failure aggregates')
const backends = [
  { id: 'ok', label: 'Healthy', probe: async () => ({ ok: true, detail: 'cli v1.2.3' }) },
  { id: 'bad', label: 'Missing', probe: async () => ({ ok: false, detail: 'not installed' }) }
]
const snapshots = await probeRuntimes(backends, [{ ...tasks[0], backend: 'ok', status: 'running' }], 100)
ok(snapshots.find((x) => x.id === 'ok')?.health === 'online' && snapshots.find((x) => x.id === 'ok')?.version === '1.2.3', 'runtime health and version snapshot')
ok(snapshots.find((x) => x.id === 'ok')?.activeTaskCount === 1 && snapshots.find((x) => x.id === 'bad')?.health === 'offline', 'runtime active task count and offline state')
if (!process.exitCode) console.log('\n✓ RUNTIME/ANALYTICS SMOKE PASSED')
fs.rmSync(outdir, { recursive: true, force: true })
