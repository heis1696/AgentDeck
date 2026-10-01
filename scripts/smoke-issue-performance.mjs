import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-issue-performance-'))
const bundle = path.join(tempRoot, 'issue-store.cjs')
let store

try {
  await build({
    entryPoints: [path.join(root, 'src/main/issue-store.ts')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    logLevel: 'silent'
  })

  const { IssueStore } = await import(pathToFileURL(bundle).href)
  const sampleCount = 2000
  const roots = Array.from({ length: sampleCount / 2 }, (_, index) => ({
    id: `root-${index}`,
    title: `Root ${index}`,
    prompt: `Root prompt ${index}`,
    workdir: '',
    backend: 'fake',
    status: 'done',
    createdAt: 1000 + index,
    startedAt: 1100 + index,
    endedAt: 1200 + index,
    eventCount: 2,
    issueId: `iss-root-${index}`,
    runId: `run-root-${index}`,
    result: `Root report ${index}`
  }))
  const children = roots.map((parent, index) => ({
    id: `child-${index}`,
    title: `Child ${index}`,
    prompt: `Child prompt ${index}`,
    workdir: '',
    backend: 'fake',
    status: 'done',
    createdAt: 3000 + index,
    startedAt: 3100 + index,
    endedAt: 3200 + index,
    eventCount: 2,
    issueId: `iss-child-${index}`,
    parentTaskId: parent.id,
    runId: `run-child-${index}`,
    result: `Child report ${index}`
  }))
  const tasks = [...roots, ...children]
  store = new IssueStore(path.join(tempRoot, 'data'))

  const originalFind = Array.prototype.find
  const originalFilter = Array.prototype.filter
  const originalMapGet = Map.prototype.get
  let arrayPredicateVisits = 0
  let indexedLookups = 0
  Array.prototype.find = function (predicate, thisArg) {
    return originalFind.call(this, function (...args) {
      arrayPredicateVisits++
      return predicate.apply(thisArg, args)
    })
  }
  Array.prototype.filter = function (predicate, thisArg) {
    return originalFilter.call(this, function (...args) {
      arrayPredicateVisits++
      return predicate.apply(thisArg, args)
    })
  }
  Map.prototype.get = function (key) {
    indexedLookups++
    return originalMapGet.call(this, key)
  }

  const startedAt = performance.now()
  try {
    store.sync(tasks)
  } finally {
    Array.prototype.find = originalFind
    Array.prototype.filter = originalFilter
    Map.prototype.get = originalMapGet
  }
  const elapsedMs = performance.now() - startedAt

  const issues = store.list()
  const linkedChildren = issues.filter((issue) => issue.parentIssueId).length
  assert.equal(issues.length, sampleCount)
  assert.equal(store.runs('iss-root-0').length, 1)
  assert.equal(store.comments('iss-child-0').length, 1)
  assert.equal(linkedChildren, sampleCount / 2)
  assert.equal(arrayPredicateVisits, 0, 'projection hot path should not scan entity arrays with find/filter')
  assert.ok(indexedLookups <= sampleCount * 25, `expected linear indexed lookups, got ${indexedLookups}`)

  console.log(`PASS ${sampleCount} tasks: ${arrayPredicateVisits} find/filter predicate visits, ${indexedLookups} Map.get lookups, ${linkedChildren} parent links, ${elapsedMs.toFixed(1)} ms`)
} finally {
  store?.close()
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
