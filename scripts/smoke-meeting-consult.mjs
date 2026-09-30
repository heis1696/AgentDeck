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

const [{ AgentSessionRegistry, OFFICE_TASK_KEY_V2_PREFIX }, { TaskStore }, { TaskService }, { TaskRunner }, delegate, prompts] = await Promise.all([
  bundle('src/main/agent-sessions.ts', 'agent-sessions.cjs'),
  bundle('src/main/store.ts', 'store.cjs'),
  bundle('src/main/task-service.ts', 'task-service.cjs'),
  bundle('src/main/runner.ts', 'runner.cjs'),
  bundle('src/main/delegate.ts', 'delegate.cjs'),
  bundle('src/main/prompts/index.ts', 'prompts.cjs')
])

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const check = (condition, label) => {
  console.log(`  ${condition ? 'OK' : 'FAIL'} ${label}`)
  if (!condition) process.exitCode = 1
}

check(delegate.parseConsults('<consult reason="why" to="Beta">question</consult>').length === 1, 'consult parser accepts attributes in any order')
check(delegate.parseConsults('<consult>not a call</consult><consult to="Beta">real</consult>').length === 1, 'consult parser rejects phantom calls without to')
check(delegate.stripConsults('before <consult to="Beta">question</consult> after') === 'before  after', 'consult markers are stripped from displayed text')

// —— 吞标记回归（对齐案情一形态）：残缺 consult 不得吞掉其后真实咨询 ——
{
  const brokenThenReal = '<consult to="Beta" reason="示例">忘写闭合的引用示例'
  const swallowText = `${brokenThenReal}<consult to="Beta2">real question</consult>`
  const parsed = delegate.parseConsults(swallowText)
  check(parsed.length === 1 && parsed[0].to === 'Beta2' && parsed[0].prompt === 'real question',
    'broken consult open cannot swallow the following real consult (sentinelized body)')
  check(delegate.stripConsults(swallowText).includes('忘写闭合的引用示例'), 'broken consult text stays visible in display (strip is same-source)')
  const broken = delegate.findUnmatchedConsultOpens(swallowText)
  check(broken.length === 1 && broken[0].to === 'Beta' && broken[0].embedded === true, 'broken consult open is detected with the embedded flag')
  check(delegate.unmatchedConsultOpenReason(broken[0]).includes('按字面独立受理') && !delegate.unmatchedConsultOpenReason(broken[0]).includes('已应答'),
    'embedded consult reason states literal acceptance without asserting an answer')
  const plainBroken = delegate.findUnmatchedConsultOpens('<consult to="Gamma">忘写闭合，后方再无任何标记')
  check(plainBroken.length === 1 && !delegate.unmatchedConsultOpenReason(plainBroken[0]).includes('按字面'), 'plain broken consult keeps the non-embedded wording')
}

const consultBlock = prompts.buildDelegationBlock(
  { id: 'ag_alpha', name: 'Alpha', backend: 'zcode', role: '队长', subordinates: ['ag_member'] },
  [
    { id: 'ag_alpha', name: 'Alpha', backend: 'zcode', role: '队长', subordinates: ['ag_member'] },
    { id: 'ag_beta', name: 'Beta', backend: 'claude', role: '队长', subordinates: ['ag_n'] },
    { id: 'ag_dsh', name: 'DshCap', backend: 'dsh', role: '队长', subordinates: [] },
    { id: 'ag_member', name: 'Member', backend: 'claude' }
  ]
)
check(consultBlock.includes('<consult'), 'delegation block teaches <consult> usage')
check(consultBlock.includes('可咨询的队长') && consultBlock.includes('Beta'), 'consult roster lists captain peers')
check(!consultBlock.slice(consultBlock.indexOf('可咨询的队长')).includes('DshCap'), 'consult roster excludes dsh captains')

const behavior = { starts: [], sends: [], active: 0, maxActive: 0 }
// 复用门禁（hot.7/hot.8）要求会话声明 turnScoped 且回调带回合戳，否则回灌追问
// 一律走 resume 重建而不是同连接 send——fixture 必须跟上契约，send 才会被观测到。
const makeSession = (agent, events) => ({
  sessionId: `${agent}-session`,
  turnScoped: true,
  async send(content, turn) {
    behavior.sends.push({ agent, content })
    behavior.active++
    behavior.maxActive = Math.max(behavior.maxActive, behavior.active)
    await sleep(10)
    behavior.active--
    const text = agent === 'beta' ? 'beta-opinion' : 'source-finished'
    events.onEvent({ ts: Date.now(), kind: 'final', text }, turn)
    events.onTurnEnd({ ok: true, response: text }, turn)
  },
  async stop() {},
  async close() {}
})

const backend = {
  id: 'fake-consult',
  label: 'Fake consult',
  supportsResume: true, // 对齐真实适配器：恢复能力声明
  async probe() { return { ok: true, detail: 'fake' } },
  async start({ prompt, events, turn }) {
    const agent = prompt.includes('Beta') || prompt.includes('beta') ? 'beta' : 'alpha'
    behavior.starts.push({ agent, prompt })
    const session = makeSession(agent, events)
    setTimeout(() => {
      const response = agent === 'alpha' && prompt.includes('source-task')
        ? '<consult to="Beta" reason="need evidence">Please inspect the relevant behavior.</consult>'
        : `${agent}-office-ready`
      events.onEvent({ ts: Date.now(), kind: 'final', text: response }, turn)
      events.onTurnEnd({ ok: true, response }, turn)
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
check(store.list().filter((task) => task.dedupeKey === OFFICE_TASK_KEY_V2_PREFIX + 'beta').length === 1, 'consult creates one target office task')
check(behavior.sends.some((item) => item.agent === 'beta' && item.content.includes('Please inspect')), 'target office receives the consultation prompt')
check(behavior.maxActive === 1, 'consult path preserves single-flight provider turns')

await runner.shutdown()

// —— 残缺 consult 具名回执（管线级）：有效咨询照常应答，残缺单时间线留痕不断言内嵌已应答 ——
{
  const receiptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-consult-receipt-'))
  const receiptBackend = {
    id: 'fake-consult-receipt',
    label: 'Fake consult receipt',
    supportsResume: true,
    async probe() { return { ok: true, detail: 'fake' } },
    async start({ prompt, events, turn }) {
      const emit = (content, stamp) => {
        const text = content.includes('咨询回复') ? 'done after consult'
          : '<consult to="Ghost">broken example missing close\n<consult to="Beta">real question</consult>'
        events.onEvent({ ts: Date.now(), kind: 'final', text }, stamp)
        events.onTurnEnd({ ok: true, response: text }, stamp)
      }
      setTimeout(() => emit(prompt, turn), 3)
      return { sessionId: 'receipt-session', turnScoped: true, async send(content, stamp) { await sleep(3); emit(content, stamp) }, async stop() {}, async close() {} }
    }
  }
  const receiptStore = new TaskStore(receiptDir)
  const receiptRunner = new TaskRunner(receiptStore, new Map([[receiptBackend.id, receiptBackend]]), () => ({ concurrency: 1, mode: 'yolo', notify: false }))
  receiptRunner.attachTeam(() => agents)
  const consulted = []
  receiptRunner.attachConsult(async ({ call }) => {
    consulted.push(call.to)
    return 'beta answer'
  })
  const receiptTask = receiptStore.create({ title: 'receipt source', prompt: 'consult with broken marker', workdir: '', backend: receiptBackend.id, agentId: 'alpha' })
  receiptRunner.enqueue(receiptTask)
  for (let i = 0; i < 300 && receiptStore.get(receiptTask.id)?.status !== 'done'; i++) await sleep(10)
  check(receiptStore.get(receiptTask.id)?.status === 'done', 'receipt fixture leader completes')
  check(consulted.length === 1 && consulted[0] === 'Beta', 'the real consult is still answered (broken one did not swallow it)')
  const timeline = receiptStore.readEvents(receiptTask.id).filter((event) => event.kind === 'status' && event.text?.includes('consult 标记残缺'))
  check(timeline.length === 1 && timeline[0].text.includes('to="Ghost"') && timeline[0].text.includes('按字面独立受理'),
    `the broken consult is receipted exactly once with conservative wording (${JSON.stringify(timeline.map((e) => e.text))})`)
  check(!timeline.some((event) => event.text.includes('已应答')), 'the receipt never asserts the embedded call was answered')
  await receiptRunner.shutdown()
  fs.rmSync(receiptDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
}

// —— 咨询回合不得发起只读调查（P2 反例）：办公室会话身份同时承载「会议发言」与「咨询应答」，
// 拿身份当放行条件会让顾问把咨询当会议、真发出 investigate。放行面由发起侧显式标注（meetingTurn）。
{
  const scopeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-consult-scope-'))
  const investigated = []
  // 办公室会话在**任何**回合都回 investigate 标记；只有 meetingTurn 回合才该被受理
  const scopeBackend = {
    id: 'fake-consult-scope',
    label: 'Fake consult scope',
    supportsResume: true,
    async probe() { return { ok: true, detail: 'fake' } },
    async start({ events, turn }) {
      const respond = (text, t) => {
        events.onEvent({ ts: Date.now(), kind: 'final', text }, t)
        events.onTurnEnd({ ok: true, response: text }, t)
      }
      const session = {
        sessionId: 'scope-session', turnScoped: true,
        async send(_content, t) {
          await sleep(5)
          respond('<investigate to="Member" reason="evidence">read src/a.ts:4</investigate>', t)
        },
        async stop() {}, async close() {}
      }
      setTimeout(() => respond('office-ready', turn), 5)
      return session
    }
  }
  const scopeStore = new TaskStore(scopeDir)
  const scopeService = new TaskService({ store: scopeStore })
  const scopeRunner = new TaskRunner(scopeStore, new Map([[scopeBackend.id, scopeBackend]]), () => ({ concurrency: 2, workerConcurrency: 2, mode: 'yolo', notify: false }))
  const scopeAgents = [
    { id: 'lead', name: 'Lead', backend: scopeBackend.id, role: '队长', subordinates: ['member'] },
    { id: 'member', name: 'Member', backend: scopeBackend.id, role: '工程师' }
  ]
  scopeRunner.attachTeam(() => scopeAgents)
  scopeRunner.attachInvestigate(async ({ call }) => { investigated.push(call.to); return 'investigated' })
  const scopeRegistry = new AgentSessionRegistry({ store: scopeStore, taskService: scopeService, runner: scopeRunner, getAgents: () => scopeAgents, waitPollMs: 5, waitTimeoutMs: 2_000 })

  // ① 咨询应答回合（不带 meetingTurn）：调查必须被拒，且时间线具名留痕
  const consultTurn = await scopeRegistry.followUp('lead', '请给意见', { collectFinal: true })
  check(consultTurn.ok, '咨询应答回合正常完成')
  check(investigated.length === 0, 'P2 反例：咨询应答回合不发起只读调查')
  const officeTaskId = scopeRegistry.get('lead')?.id ?? ''
  const notes = scopeStore.readEvents(officeTaskId).filter((event) => event.kind === 'status' && event.text?.includes('调查标记'))
  check(notes.length >= 1 && notes[0].text.includes('咨询应答'), `P2：被拒的调查在时间线具名留痕（${JSON.stringify(notes.map((e) => e.text))}）`)
  check(!consultTurn.finalText?.includes('<investigate'), 'P2：被拒的标记从展示文本剥离')

  // ② 会议发言回合（带 meetingTurn）：调查照常受理（会议能力不被误伤）
  const before = investigated.length
  const meetingTurn = await scopeRegistry.followUp('lead', '会议发言', { collectFinal: true, meetingTurn: true })
  check(meetingTurn.ok, '会议发言回合正常完成')
  check(investigated.length === before + 1 && investigated[before] === 'Member', 'P2 对照：会议发言回合的只读调查照常受理')

  // ③ 强制综合等显式关闭调查的会议回合（meetingTurn=false）：提示词说「不要发起调查」，运行时同口径
  const beforeForced = investigated.length
  const forced = await scopeRegistry.followUp('lead', '强制综合', { collectFinal: true, meetingTurn: false })
  check(forced.ok, '会议收束回合正常完成')
  check(investigated.length === beforeForced, 'P2：显式关闭调查的会议回合（强制综合）不发起调查')
  await scopeRunner.shutdown()
  fs.rmSync(scopeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
}

if (process.exitCode) process.exit(1)
console.log('\n✅ MEETING CONSULT SMOKE PASSED')
