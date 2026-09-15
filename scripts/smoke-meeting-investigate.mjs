import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-investigate-bundles-'))
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-investigate-data-'))
const bundle = async (source, name) => {
  const outfile = path.join(bundleDir, name)
  await build({ entryPoints: [path.join(root, source)], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['electron'] })
  return import(pathToFileURL(outfile).href)
}

const [{ TaskRunner }, { TaskStore }, { TaskService }, { parseInvestigates, stripInvestigates }] = await Promise.all([
  bundle('src/main/runner.ts', 'runner.cjs'),
  bundle('src/main/store.ts', 'store.cjs'),
  bundle('src/main/task-service.ts', 'task-service.cjs'),
  bundle('src/main/delegate.ts', 'delegate.cjs')
])

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const check = (condition, label) => {
  console.log(`  ${condition ? 'OK' : 'FAIL'} ${label}`)
  if (!condition) process.exitCode = 1
}

check(parseInvestigates('<investigate reason="evidence" to="Beta">read it</investigate>').length === 1, 'investigate parser accepts ordered attributes')
check(parseInvestigates('<investigate>phantom</investigate><investigate to="Beta">real</investigate>').length === 1, 'investigate parser rejects phantom calls')
check(stripInvestigates('before <investigate to="Beta">read it</investigate> after') === 'before  after', 'investigate marker is stripped')

let childTask
const backend = {
  id: 'fake-investigate',
  label: 'Fake investigate',
  async probe() { return { ok: true, detail: 'fake' } },
  async start({ prompt, events }) {
    const investigation = prompt.includes('只读调查')
    const initial = investigation ? 'verified fact: 42' : '<investigate to="Beta" reason="evidence">read src/a.ts:4</investigate>'
    const response = (content) => content.includes('调查结果') ? 'final answer after evidence' : initial
    const emit = (content) => {
      const text = response(content)
      events.onEvent({ ts: Date.now(), kind: 'final', text })
      events.onTurnEnd({ ok: true, response: text })
    }
    setTimeout(() => emit(prompt), 3)
    return { sessionId: investigation ? 'child-session' : 'leader-session', async send(content) { await sleep(3); emit(content) }, async stop() {}, async close() {} }
  }
}

const store = new TaskStore(dataDir)
const service = new TaskService({ store })
const runner = new TaskRunner(store, new Map([[backend.id, backend]]), () => ({ concurrency: 2, workerConcurrency: 2, mode: 'yolo', notify: false }))
const team = [
  { id: 'alpha', name: 'Alpha', backend: backend.id, role: '队长', subordinates: ['beta'] },
  { id: 'beta', name: 'Beta', backend: backend.id, role: '队员' }
]
runner.attachTeam(() => team)
runner.attachTaskService({ createChildTask: (input) => service.createChildTask(input) })
runner.attachInvestigate(async ({ sourceTaskId, call, depth }) => {
  if (depth >= 1) return '调查深度已达上限'
  childTask = await runner.spawnInvestigateChild(sourceTaskId, call)
  if (!childTask) return null
  for (;;) {
    const current = store.get(childTask.id)
    if (current?.status === 'done') return current.result ?? ''
    if (current?.status === 'failed' || current?.status === 'cancelled') return current.error ?? current.status
    await sleep(5)
  }
})
const leader = service.create({ title: 'leader', prompt: 'investigate this', workdir: '', backend: backend.id, agentId: 'alpha' })
runner.enqueue(leader)
for (let i = 0; i < 300 && store.get(leader.id)?.status !== 'done'; i++) await sleep(10)
const done = store.get(leader.id)
check(done?.status === 'done', `leader completes after investigate (got ${done?.status})`)
check(done?.result === 'final answer after evidence', 'investigation result is re-injected into leader session')
const child = childTask ? store.get(childTask.id) : undefined
check(child?.parentTaskId === leader.id, 'investigation child keeps parentTaskId for budget ancestry')
check(child?.suppressIssue === true && child?.trigger === 'meeting', 'investigation child is silent and marked meeting trigger')
check(child?.worktree === undefined && child?.workdir === '', 'investigation child has no worktree and reads shared workspace')

await runner.shutdown()
if (process.exitCode) process.exit(1)
console.log('\n✅ MEETING INVESTIGATE SMOKE PASSED')
