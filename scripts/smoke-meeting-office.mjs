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

const [{ AgentSessionRegistry, OFFICE_TASK_KEY_V2_PREFIX }, { TaskStore }, { TaskService }, { TaskRunner }] = await Promise.all([
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
  supportsResume: true, // 对齐真实适配器：恢复能力声明
  async probe() { return { ok: true, detail: 'fake' } },
  async start({ events, turn }) {
    starts++
    const sessionId = 'office-session'
    // 复用门禁（hot.7/hot.8）要求会话声明 turnScoped 且回调带回合戳，
    // 否则追问一律走 resume 重建而不是同连接 send——fixture 必须跟上契约。
    const finish = (text, stamp) => {
      events.onEvent({ ts: Date.now(), kind: 'final', text }, stamp)
      events.onTurnEnd({ ok: true, response: text }, stamp)
    }
    setTimeout(() => finish('office-ready', turn), 5)
    return {
      sessionId,
      turnScoped: true,
      async send(_content, nextTurn) {
        sends++
        activeSends++
        maxActiveSends = Math.max(maxActiveSends, activeSends)
        const n = ++serial
        await sleep(25)
        activeSends--
        finish(`reply-${n}`, nextTurn)
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
// 断言键的**归属**（该队长的键空间）而不是字面串：键形是实现细节，语义是「一位队长一张长期单」
check(first.suppressIssue === true && first.dedupeKey === OFFICE_TASK_KEY_V2_PREFIX + 'leader', 'office task is suppressed and durably deduped')

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
