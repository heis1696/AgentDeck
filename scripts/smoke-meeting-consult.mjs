import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-consult-bundles-'))
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-consult-data-'))
const bundle = async (source, name) => {
  const outfile = path.join(bundleDir, name)
  await build({ entryPoints: [path.join(root, source)], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['electron'] })
  return import(pathToFileURL(outfile).href)
}

const [{ AgentSessionRegistry }, { TaskStore }, { TaskService }, { TaskRunner }, delegate] = await Promise.all([
  bundle('src/main/agent-sessions.ts', 'agent-sessions.cjs'),
  bundle('src/main/store.ts', 'store.cjs'),
  bundle('src/main/task-service.ts', 'task-service.cjs'),
  bundle('src/main/runner.ts', 'runner.cjs'),
  bundle('src/main/delegate.ts', 'delegate.cjs')
])

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const check = (condition, label) => {
  console.log(`  ${condition ? 'OK' : 'FAIL'} ${label}`)
  if (!condition) process.exitCode = 1
}

check(delegate.parseConsults('<consult reason="why" to="Beta">question</consult>').length === 1, 'consult parser accepts attributes in any order')
check(delegate.parseConsults('<consult>not a call</consult><consult to="Beta">real</consult>').length === 1, 'consult parser rejects phantom calls without to')
check(delegate.stripConsults('before <consult to="Beta">question</consult> after') === 'before  after', 'consult markers are stripped from displayed text')

const behavior = { starts: [], sends: [], active: 0, maxActive: 0 }
const makeSession = (agent, events) => ({
  sessionId: `${agent}-session`,
  async send(content) {
    behavior.sends.push({ agent, content })
    behavior.active++
    behavior.maxActive = Math.max(behavior.maxActive, behavior.active)
    await sleep(10)
    behavior.active--
    const text = agent === 'beta' ? 'beta-opinion' : 'source-finished'
    events.onEvent({ ts: Date.now(), kind: 'final', text })
    events.onTurnEnd({ ok: true, response: text })
  },
  async stop() {},
  async close() {}
})

const backend = {
  id: 'fake-consult',
  label: 'Fake consult',
  async probe() { return { ok: true, detail: 'fake' } },
  async start({ prompt, events }) {
    const agent = prompt.includes('Beta') || prompt.includes('beta') ? 'beta' : 'alpha'
    behavior.starts.push({ agent, prompt })
    const session = makeSession(agent, events)
    setTimeout(() => {
      const response = agent === 'alpha' && prompt.includes('source-task')
        ? '<consult to="Beta" reason="need evidence">Please inspect the relevant behavior.</consult>'
        : `${agent}-office-ready`
      events.onEvent({ ts: Date.now(), kind: 'final', text: response })
      events.onTurnEnd({ ok: true, response })
    }, 5)
    return session
  }
}

const store = new TaskStore(dataDir)
const service = new TaskService({ store })
const runner = new TaskRunner(store, new Map([[backend.id, backend]]), () => ({ concurrency: 2, workerConcurrency: 2, mode: 'yolo', notify: false }))
const agents = [
  { id: 'alpha', name: 'Alpha', backend: backend.id, role: '队长' },
  { id: 'beta', name: 'Beta', backend: backend.id, role: '队长' }
]
runner.attachTeam(() => agents)
const registry = new AgentSessionRegistry({ store, taskService: service, runner, getAgents: () => agents, waitPollMs: 5, waitTimeoutMs: 2_000 })
runner.attachConsult(async ({ sourceTaskId, call, depth }) => {
  const source = store.get(sourceTaskId)
  const target = registry.resolve(call.to, source?.agentId)
  if (!target) return `未找到队长：${call.to}`
  if (depth >= 1) return '咨询深度已达上限；请自行判断。'
  const result = await registry.followUp(target.id, `【系统·咨询】Alpha 队长向你咨询\n${call.prompt}`, { collectFinal: true, consultDepth: depth + 1 })
  return result.ok ? result.finalText : `咨询失败：${result.error}`
})

const source = service.create({ title: 'source', prompt: 'source-task', workdir: '', backend: backend.id, agentId: 'alpha' })
runner.enqueue(source)
for (let i = 0; i < 100 && store.get(source.id)?.status === 'queued'; i++) await sleep(10)
for (let i = 0; i < 200 && store.get(source.id)?.status === 'running'; i++) await sleep(10)
const done = store.get(source.id)
check(done?.status === 'done', `consult source reaches done (got ${done?.status})`)
check(done?.result === 'source-finished', 'consult answer is re-injected and source continues')
check(store.list().filter((task) => task.dedupeKey === 'office_beta').length === 1, 'consult creates one target office task')
check(behavior.sends.some((item) => item.agent === 'beta' && item.content.includes('Please inspect')), 'target office receives the consultation prompt')
check(behavior.maxActive === 1, 'consult path preserves single-flight provider turns')

await runner.shutdown()
if (process.exitCode) process.exit(1)
console.log('\n✅ MEETING CONSULT SMOKE PASSED')
