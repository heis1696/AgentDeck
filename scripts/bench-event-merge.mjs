// Compare source implementations in memory; timings are evidence, not test thresholds.
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import path from 'node:path'
import assert from 'node:assert/strict'

const root = path.resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
const { outputFiles } = await build({ entryPoints: [path.join(root, 'src/renderer/src/hooks/eventMerge.ts')], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' })
const module = { exports: {} }
new Function('module', 'exports', 'require', outputFiles[0].text)(module, module.exports, require)
const optimized = module.exports.mergeTaskEvents
const reference = (current, incoming) => {
  if (!incoming.length) return current
  const bySeq = new Map()
  for (const event of current) bySeq.set(event.seq, event)
  for (const event of incoming) bySeq.set(event.seq, event)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}
const event = (seq) => ({ seq, ts: seq, kind: 'tool', text: 'read_file', data: { phase: 'result', ok: true } })
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
for (const size of [1000, 10000]) {
  const baseline = Array.from({ length: size }, (_, i) => event(i))
  const samples = { reference: [], optimized: [] }
  for (let repeat = 0; repeat < 7; repeat++) {
    for (const [name, merge] of Object.entries({ reference, optimized })) {
      let events = baseline
      const start = performance.now()
      for (let i = 0; i < 500; i++) events = merge(events, [event(size + i)])
      const elapsed = performance.now() - start
      assert.equal(events.length, size + 500)
      assert.equal(events[events.length - 1].seq, size + 499)
      if (repeat > 0) samples[name].push(elapsed)
    }
  }
  console.log(JSON.stringify({ existingEvents: size, appends: 500, warmedRuns: 6, referenceMedianMs: +median(samples.reference).toFixed(2), optimizedMedianMs: +median(samples.optimized).toFixed(2), speedup: +(median(samples.reference) / median(samples.optimized)).toFixed(2), excludes: 'turn reconstruction, React, Markdown and IPC' }))
}
