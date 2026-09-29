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

const [{ TaskRunner }, { TaskStore }, { TaskService }, { parseInvestigates, stripInvestigates, findUnmatchedInvestigateOpens, unmatchedInvestigateOpenReason }] = await Promise.all([
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

// —— 吞标记回归（对齐案情一形态）：残缺 investigate 不得吞掉其后真实调查 ——
{
  const brokenThenReal = '<investigate to="Beta" reason="示例">忘写闭合的引用示例'
  const swallowText = `${brokenThenReal}<investigate to="Beta2">real target</investigate>`
  const parsed = parseInvestigates(swallowText)
  check(parsed.length === 1 && parsed[0].to === 'Beta2' && parsed[0].prompt === 'real target',
    'broken investigate open cannot swallow the following real investigate (sentinelized body)')
  check(stripInvestigates(swallowText).includes('忘写闭合的引用示例'), 'broken investigate text stays visible in display (strip is same-source)')
  const broken = findUnmatchedInvestigateOpens(swallowText)
  check(broken.length === 1 && broken[0].to === 'Beta' && broken[0].embedded === true, 'broken investigate open is detected with the embedded flag')
  check(unmatchedInvestigateOpenReason(broken[0]).includes('按字面独立受理') && !unmatchedInvestigateOpenReason(broken[0]).includes('已应答'),
    'embedded investigate reason states literal acceptance without asserting an answer')
  const plainBroken = findUnmatchedInvestigateOpens('<investigate to="Gamma">忘写闭合，后方再无任何标记')
  check(plainBroken.length === 1 && !unmatchedInvestigateOpenReason(plainBroken[0]).includes('按字面'), 'plain broken investigate keeps the non-embedded wording')
}

let childTask
const backend = {
  id: 'fake-investigate',
  label: 'Fake investigate',
  supportsResume: true, // 对齐真实适配器：恢复能力声明（追问/回灌经 turnScoped 连接直续）
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
check((done?.roundsUsed ?? 0) >= 1, 'investigation consumes the parent delegation budget')
check(child?.suppressIssue === true && child?.trigger === 'meeting', 'investigation child is silent and marked meeting trigger')
check(child?.worktree === undefined && child?.workdir === '', 'investigation child has no worktree and reads shared workspace')

await runner.shutdown()

// —— 残缺 investigate 具名回执（管线级）：有效调查照常受理，残缺单时间线留痕 ——
{
  const receiptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-investigate-receipt-'))
  const receiptBackend = {
    id: 'fake-investigate-receipt',
    label: 'Fake investigate receipt',
    supportsResume: true,
    async probe() { return { ok: true, detail: 'fake' } },
    async start({ prompt, events, turn }) {
      const emit = (content, stamp) => {
        const text = content.includes('调查结果') ? 'done after investigation'
          : '<investigate to="Ghost">broken example missing close\n<investigate to="Beta">read src/a.ts</investigate>'
        events.onEvent({ ts: Date.now(), kind: 'final', text }, stamp)
        events.onTurnEnd({ ok: true, response: text }, stamp)
      }
      setTimeout(() => emit(prompt, turn), 3)
      return { sessionId: 'receipt-session', turnScoped: true, async send(content, stamp) { await sleep(3); emit(content, stamp) }, async stop() {}, async close() {} }
    }
  }
  const receiptStore = new TaskStore(receiptDir)
  const receiptRunner = new TaskRunner(receiptStore, new Map([[receiptBackend.id, receiptBackend]]), () => ({ concurrency: 1, mode: 'yolo', notify: false }))
  receiptRunner.attachTeam(() => team)
  const investigated = []
  receiptRunner.attachInvestigate(async ({ call }) => {
    investigated.push(call.to)
    return 'found: 42'
  })
  const receiptTask = receiptStore.create({ title: 'receipt leader', prompt: 'investigate with broken marker', workdir: '', backend: receiptBackend.id, agentId: 'alpha' })
  receiptRunner.enqueue(receiptTask)
  for (let i = 0; i < 300 && receiptStore.get(receiptTask.id)?.status !== 'done'; i++) await sleep(10)
  check(receiptStore.get(receiptTask.id)?.status === 'done', 'receipt fixture leader completes')
  check(investigated.length === 1 && investigated[0] === 'Beta', 'the real investigate is still served (broken one did not swallow it)')
  const timeline = receiptStore.readEvents(receiptTask.id).filter((event) => event.kind === 'status' && event.text?.includes('investigate 标记残缺'))
  check(timeline.length === 1 && timeline[0].text.includes('to="Ghost"') && timeline[0].text.includes('按字面独立受理'),
    `the broken investigate is receipted exactly once with conservative wording (${JSON.stringify(timeline.map((e) => e.text))})`)
  check(receiptStore.get(receiptTask.id)?.result === 'done after investigation', 'investigation result is re-injected and leader continues')
  await receiptRunner.shutdown()
  fs.rmSync(receiptDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
}

if (process.exitCode) process.exit(1)
console.log('\n✅ MEETING INVESTIGATE SMOKE PASSED')
