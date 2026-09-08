// 阶段接力冒烟（AGENT-PROFILES-PLAN Phase 5）：
// <continue> 硬切——同 issue 新 run、新会话，简报为唯一携带物。
// 覆盖：parked/auto 两种启动、多源解析（标记只在流式来源）、护栏（自继链上限、
// 委派子任务禁用）、标记不外漏、结果指向行。
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const root = path.resolve(import.meta.dirname, '..')
for (const [src, out] of [
  ['src/main/runner.ts', 'out/sc-runner.cjs'],
  ['src/main/store.ts', 'out/sc-store.cjs'],
  ['src/main/delegate.ts', 'out/sc-delegate.cjs']
]) {
  await build({ entryPoints: [path.join(root, src)], outfile: path.join(root, out), bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['electron'] })
}
const { TaskRunner } = await import(pathToFileURL(path.join(root, 'out/sc-runner.cjs')).href)
const { TaskStore } = await import(pathToFileURL(path.join(root, 'out/sc-store.cjs')).href)
const { parseContinue, parseContinueMerged, stripContinue } = await import(pathToFileURL(path.join(root, 'out/sc-delegate.cjs')).href)

const assert = (cond, msg) => { if (!cond) { console.error('❌', msg); process.exit(1) } console.log('  ✓', msg) }

// ---- 解析单测 ----
const c1 = parseContinue('<continue start="parked">Phase 2 简报</continue>')[0]
assert(c1?.start === 'parked' && c1.brief === 'Phase 2 简报', 'parseContinue：parked + 简报')
assert(parseContinue('<continue>缺省 start</continue>')[0]?.start === 'parked', 'parseContinue：start 缺省 → parked（防误切）')
assert(parseContinue('<continue start="parked">简报</continue>')[0]?.start === 'parked', 'parseContinue：显式 parked')
assert(parseContinue('讨论正文提到 <continue start="auto">示例</continue> 后面还有内容。').length === 0, 'parseContinue：非末尾标记不构成接力意图')
assert(parseContinue('结尾标记 <continue start=auto>简报</continue>')[0]?.start === 'parked', 'parseContinue：无引号写法 fail-safe 按 parked')
assert(parseContinue('<continue></continue>').length === 0, 'parseContinue：空简报拒绝')
const markStream = '收尾。<continue start="auto">下一阶段：UI 施工</continue>'
const markFull = '收尾。（思考内容，不含标记）'
assert(parseContinue(markFull).length === 0 && parseContinueMerged(markFull, markStream)?.brief.includes('UI 施工'), '多源解析：标记只在流式来源也能找回（Phase 0 教训）')
assert(!stripContinue('完成。<continue start="auto">X</continue>').includes('<continue'), 'stripContinue 剥标记')

// ---- e2e 场景 A：领队带 subordinates，最终回合在委派循环后输出 continue（parked） ----
const tmpStore = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-store-'))
const store = new TaskStore(tmpStore)

function continueBackend(tag, firstText, secondText) {
  return {
    id: tag, label: tag,
    async probe() { return { ok: true, detail: '' } },
    async start({ events }) {
      setTimeout(() => {
        events.onEvent({ ts: Date.now(), kind: 'final', text: firstText })
        events.onTurnEnd({ response: firstText, ok: true })
      }, 30)
      return {
        sessionId: 's_' + tag + Math.random().toString(36).slice(2, 5),
        async send(content) {
          setTimeout(() => {
            events.onEvent({ ts: Date.now(), kind: 'final', text: secondText })
            events.onTurnEnd({ response: secondText, ok: true })
          }, 30)
          await new Promise((r) => setTimeout(r, 40))
        },
        async stop() {}, async close() {}
      }
    }
  }
}

const team = [
  { id: 'L', name: 'Boss', backend: 'lead', role: '领队', systemPrompt: '', subordinates: [] },
  { id: 'W', name: 'Worker', backend: 'wrk', role: '工程师', systemPrompt: '' }
]
const created = []
const runner = new TaskRunner(store, new Map([
  ['lead', continueBackend('lead', '本阶段完成。<continue start="parked">下一阶段：UI 施工，方案 docs/plan.md，不改后端</continue>', '')],
  ['wrk', continueBackend('wrk', 'worker 干完。', '')]
]), () => ({ concurrency: 2, mode: 'yolo', notify: false, workerConcurrency: 2 }), () => {})
runner.attachTeam(() => team)
runner.attachContinue(({ sourceTaskId, issueId, brief, start }) => {
  const source = store.get(sourceTaskId)
  if (!source) return null
  const t = store.create({ title: '▶ ' + brief.split(/\r?\n/)[0].slice(0, 40), prompt: brief, workdir: source.workdir, backend: source.backend, agentId: source.agentId, issueId, trigger: 'handoff', continuesFrom: sourceTaskId, ...(start === 'parked' ? { parked: true } : {}) })
  created.push(t.id)
  return store.get(t.id)
})

// 场景 A：parked 接力（简报在委派循环之外的最终回合文本里）
const a = store.create({ title: '阶段一', prompt: '干活', workdir: '', backend: 'lead', agentId: 'L' })
store.update(a.id, { issueId: 'iss_A' })
runner.enqueue(store.get(a.id))
const t0 = Date.now()
while (Date.now() - t0 < 15000 && store.get(a.id)?.status !== 'done') await new Promise((r) => setTimeout(r, 100))
assert(store.get(a.id)?.status === 'done', '场景 A：任务 done')
assert(created.length === 1, `场景 A：创建了 1 个后继任务（${created.length}）`)
const succA = store.get(created[0])
assert(succA?.parked === true, '场景 A：parked 后继（未自动启动）')
assert(succA?.issueId === 'iss_A', '场景 A：同一 Issue')
assert(succA?.trigger === 'handoff', '场景 A：trigger=handoff')
assert(succA?.agentId === 'L' && succA?.backend === 'lead', '场景 A：继承 agent/platform')
assert(succA?.continuesFrom === a.id, '场景 A：continuesFrom 指向前一阶段')
assert(store.get(a.id).result.includes('阶段接力') && !store.get(a.id).result.includes('<continue'), '场景 A：结果含指向行、无标记外漏')

// 场景 B：auto 接力 + 自继链上限护栏
// 预置 8 个 handoff 任务把预算耗尽
for (let i = 0; i < 8; i++) {
  const t = store.create({ title: `h${i}`, prompt: 'x', workdir: '', backend: 'lead', agentId: 'L', issueId: 'iss_B', trigger: 'handoff' })
  created.push(t.id)
}
const autoText = '本阶段完成。<continue start="auto">下一阶段：继续推进</continue>'
const runnerB = new TaskRunner(store, new Map([['lead', continueBackend('lead', autoText, '')]]), () => ({ concurrency: 1, mode: 'yolo', notify: false, workerConcurrency: 2 }), () => {})
runnerB.attachTeam(() => team)
runnerB.attachContinue(({ sourceTaskId, issueId, brief, start }) => {
  const source = store.get(sourceTaskId)
  const t = store.create({ title: '▶ ' + brief.slice(0, 20), prompt: brief, workdir: source.workdir, backend: source.backend, agentId: source.agentId, issueId, trigger: 'handoff' })
  runnerB.enqueue(store.get(t.id))
  return store.get(t.id)
})
const b = store.create({ title: '阶段一 B', prompt: '干活', workdir: '', backend: 'lead', agentId: 'L' })
store.update(b.id, { issueId: 'iss_B' })
runnerB.enqueue(store.get(b.id))
const t1 = Date.now()
while (Date.now() - t1 < 15000 && store.get(b.id)?.status !== 'done') await new Promise((r) => setTimeout(r, 100))
assert(store.get(b.id)?.status === 'done', '场景 B：任务 done')
const events = store.readEvents(b.id).map((e) => e.text ?? '').join('\n')
assert(events.includes('阶段接力已达上限'), '场景 B：自继链 ≥8 被拒绝（事件留痕）')
assert(!store.list().some((t) => t.issueId === 'iss_B' && t.trigger === 'handoff' && t.title.startsWith('▶')), '场景 B：拒绝后未创建后继')

// 场景 C：委派子任务（parentTaskId）输出 continue —— 被忽略
const runnerC = new TaskRunner(store, new Map([['wrk', continueBackend('wrk', '子任务完成。<continue start="auto">想接力</continue>', '')]]), () => ({ concurrency: 1, mode: 'yolo', notify: false, workerConcurrency: 2 }), () => {})
runnerC.attachTeam(() => team)
runnerC.attachContinue(() => { created.push('SHOULD-NOT-CREATE'); return {} })
const c = store.create({ title: 'child', prompt: '干活', workdir: '', backend: 'wrk', agentId: 'W', parentTaskId: b.id })
runnerC.enqueue(c)
const t2 = Date.now()
while (Date.now() - t2 < 15000 && store.get(c.id)?.status !== 'done') await new Promise((r) => setTimeout(r, 100))
assert(store.get(c.id)?.status === 'done', '场景 C：worker done')
assert(!created.includes('SHOULD-NOT-CREATE'), '场景 C：worker 的 continue 被忽略')

console.log('\n✅ CONTINUE SMOKE PASSED')

// ---- 场景 D：接力触发面收窄 ----
// D1：自由追问里提到"下一阶段"（讨论方案）——不再按关键词猜测接力意图，上下文原地保留
const runnerD = new TaskRunner(store, new Map([['lead', continueBackend('lead', '本阶段完成。', '下一阶段可以先梳理验收清单，我建议…')]]), () => ({ concurrency: 1, mode: 'yolo', notify: false, workerConcurrency: 2 }), () => {})
runnerD.attachTeam(() => team)
let dSucc = null
runnerD.attachContinue(({ brief }) => {
  dSucc = store.create({ title: '▶ ' + brief.slice(0, 20), prompt: brief, workdir: '', backend: 'lead', agentId: 'L', issueId: 'iss_D', trigger: 'handoff' })
  runnerD.enqueue(store.get(dSucc.id))
  return store.get(dSucc.id)
})
const d = store.create({ title: '阶段一 D', prompt: '干活', workdir: '', backend: 'lead', agentId: 'L', issueId: 'iss_D' })
runnerD.enqueue(d)
const t3 = Date.now()
while (Date.now() - t3 < 15000 && store.get(d.id)?.status !== 'done') await new Promise((r) => setTimeout(r, 100))
assert(store.get(d.id)?.status === 'done', '场景 D1：首轮 done（无自发标记）')
const fu = await runnerD.followUp(d.id, '下一阶段的验收清单怎么定？')
assert(fu.ok, '场景 D1：自由追问成功')
await new Promise((r) => setTimeout(r, 300))
assert(!dSucc, '场景 D1：自由追问不触发接力（上下文不被硬切）')
// D2：按钮显式接力（relay）→ 注入 HANDOFF_CUE，agent 输出末尾标记 → auto 硬切
const runnerD2 = new TaskRunner(store, new Map([['lead', continueBackend('lead', '本阶段完成。', '好。<continue start="auto">阶段2：按 docs/plan.md 实施 UI；阶段1 已完成数据层（commit abc）；验收：构建通过</continue>')]]), () => ({ concurrency: 1, mode: 'yolo', notify: false, workerConcurrency: 2 }), () => {})
runnerD2.attachTeam(() => team)
runnerD2.attachContinue(({ sourceTaskId, issueId, brief, start }) => {
  dSucc = store.create({ title: '▶ ' + brief.slice(0, 20), prompt: brief, workdir: '', backend: 'lead', agentId: 'L', issueId, trigger: 'handoff', continuesFrom: sourceTaskId, ...(start === 'parked' ? { parked: true } : {}) })
  runnerD2.enqueue(store.get(dSucc.id))
  return store.get(dSucc.id)
})
const d2 = store.create({ title: '阶段一 D2', prompt: '干活', workdir: '', backend: 'lead', agentId: 'L', issueId: 'iss_D2' })
runnerD2.enqueue(d2)
const t4 = Date.now()
while (Date.now() - t4 < 15000 && store.get(d2.id)?.status !== 'done') await new Promise((r) => setTimeout(r, 100))
assert(store.get(d2.id)?.status === 'done', '场景 D2：首轮 done')
const fu2 = await runnerD2.followUp(d2.id, '执行下一阶段', { relay: true })
assert(fu2.ok, '场景 D2：按钮接力成功')
const t5 = Date.now()
while (Date.now() - t5 < 15000 && !dSucc) await new Promise((r) => setTimeout(r, 100))
assert(!!dSucc && dSucc.trigger === 'handoff' && !dSucc.parked, '场景 D2：按钮触发 auto 接力（后继已创建并启动）')
assert(dSucc.continuesFrom === d2.id && dSucc.issueId === 'iss_D2', '场景 D2：continuesFrom/issue 正确')
assert(!store.get(d2.id).result.includes('<continue'), '场景 D2：标记不外漏')
console.log('')
process.exit(0)
