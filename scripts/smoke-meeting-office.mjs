import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-office-bundles-'))
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-office-data-'))
const bundle = async (source, name) => {
  const outfile = path.join(bundleDir, name)
  await build({ entryPoints: [path.join(root, source)], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['electron'] })
  return import(pathToFileURL(outfile).href)
}

const [{ AgentSessionRegistry }, { TaskStore }, { TaskService }, { TaskRunner }] = await Promise.all([
  bundle('src/main/agent-sessions.ts', 'agent-sessions.cjs'),
  bundle('src/main/store.ts', 'store.cjs'),
  bundle('src/main/task-service.ts', 'task-service.cjs'),
  bundle('src/main/runner.ts', 'runner.cjs')
])

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const check = (condition, label) => {
  console.log(`  ${condition ? 'OK' : 'FAIL'} ${label}`)
  if (!condition) process.exitCode = 1
}

let sends = 0
let starts = 0
let activeSends = 0
let maxActiveSends = 0
let serial = 0
let notifications = 0
const backend = {
  id: 'fake-office',
  label: 'Fake office',
  async probe() { return { ok: true, detail: 'fake' } },
  async start({ events }) {
    starts++
    const sessionId = 'office-session'
    const finish = (text) => {
      events.onEvent({ ts: Date.now(), kind: 'final', text })
      events.onTurnEnd({ ok: true, response: text })
    }
    setTimeout(() => finish('office-ready'), 5)
    return {
      sessionId,
      async send() {
        sends++
        activeSends++
        maxActiveSends = Math.max(maxActiveSends, activeSends)
        const n = ++serial
        await sleep(25)
        activeSends--
        finish(`reply-${n}`)
      },
      async stop() {},
      async close() {}
    }
  }
}

const store = new TaskStore(dataDir)
const service = new TaskService({ store })
const runner = new TaskRunner(store, new Map([[backend.id, backend]]), () => ({ concurrency: 2, workerConcurrency: 2, mode: 'yolo', notify: true }), undefined, { notify: () => { notifications++ } })
const agents = [
  { id: 'leader', name: 'Leader', backend: backend.id, role: '队长', systemPrompt: '负责协调。' },
  { id: 'dsh', name: 'DeepSeek', backend: 'dsh' }
]
runner.attachTeam(() => agents)

const registry = new AgentSessionRegistry({ store, taskService: service, runner, getAgents: () => agents, waitPollMs: 5, waitTimeoutMs: 2_000 })
const first = await registry.ensure('leader')
check(first.status === 'done', 'office task bootstrap reaches done')
check(first.suppressIssue === true && first.dedupeKey === 'office_leader', 'office task is suppressed and durably deduped')

const again = await registry.ensure('leader')
check(again.id === first.id, 'repeated ensure reuses one office task')

const [a, b] = await Promise.all([registry.followUp('leader', 'one'), registry.followUp('leader', 'two')])
check(a.ok && b.ok, 'concurrent office follow-ups both complete')
check(maxActiveSends === 1, 'same-agent office follow-ups are serialized')
check(starts === 1 && sends === 2, 'one bootstrap start plus two follow-up sends')
check(notifications === 0, 'suppressIssue office task emits no notifications')

const restartedStore = new TaskStore(dataDir)
const restartedRegistry = new AgentSessionRegistry({ store: restartedStore, taskService: new TaskService({ store: restartedStore }), runner, getAgents: () => agents, waitPollMs: 5, waitTimeoutMs: 100 })
// The durable lookup check uses a fresh service/store pair; no new task should be created.
const persisted = restartedRegistry.get('leader')
check(persisted?.id === first.id, 'office mapping survives registry/store restart')

try {
  await registry.ensure('dsh')
  check(false, 'DSH office enrollment is rejected')
} catch (error) {
  check(String(error).includes('DeepSeek'), 'DSH office enrollment is rejected')
}

await runner.shutdown()
if (process.exitCode) process.exit(1)
console.log('\n✅ MEETING OFFICE SMOKE PASSED')
