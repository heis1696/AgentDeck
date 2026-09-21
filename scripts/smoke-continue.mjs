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
assert(parseContinue('讨论正文提到 <continue start="auto">示例</continue> 后面还有内容。').length === 0, 'parseContinue：非末尾 + 简报分量不足（讨论复述）不构成接力意图')
assert(parseContinue('结尾标记 <continue start=auto>简报</continue>')[0]?.start === 'parked', 'parseContinue：无引号写法 fail-safe 按 parked')
assert(parseContinue('<continue></continue>').length === 0, 'parseContinue：空简报拒绝')
const markStream = '收尾。<continue start="auto">下一阶段：UI 施工</continue>'
const markFull = '收尾。（思考内容，不含标记）'
assert(parseContinue(markFull).length === 0 && parseContinueMerged(markFull, markStream)?.brief.includes('UI 施工'), '多源解析：标记只在流式来源也能找回（Phase 0 教训）')
assert(!stripContinue('完成。<continue start="auto">X</continue>').includes('<continue'), 'stripContinue 剥标记')
// ---- 0.21.1 硬切复活矩阵：兜底通道 + 防复述 + 缺省语义对齐 ----
// 兜底：标记后跟客套收尾（末尾锚定失守的实测形态），显式 auto → 救回
const loose = parseContinue('成果汇报…<continue start="auto">阶段2：按 docs/CONSTRUCTION-PLAN.md §5 施工后端适配与 Git 错误模型</continue>\n\n以上，若有问题随时找我。')[0]
assert(loose?.start === 'auto' && loose?.loose === true && loose.brief.includes('后端适配'), '兜底：标记后跟收尾语，显式 auto 仍触发（loose 留痕）')
// 兜底：同形态但缺省 start → 不触发（兜底通道只认显式 auto，防复述误触）
assert(parseContinue('成果…<continue>阶段2：继续</continue>\n\n以上。').length === 0, '兜底：非末尾 + 缺省 start 不触发')
// 兜底：非末尾 + 显式 parked → 不触发（parked 没有兜底资格，必须末尾锚定）
assert(parseContinue('成果…<continue start="parked">阶段2：继续</continue>\n\n以上。').length === 0, '兜底：非末尾 parked 不触发')
// 防复述：逐字引用协议示例（带显式 auto）→ 拒绝
assert(parseContinue('协议示例：<continue start="auto">阶段2：按 docs/plan.md §3 实现模型选择 UI；阶段1 已完成数据管道（commit 09a47a4，src/main/presets.ts）；验收：两个不同模型的 agent 并发执行成功</continue>').length === 0, '防复述：协议示例同文简报拒绝（非末尾）')
assert(parseContinue('示例收尾：<continue start="auto">阶段2：按 docs/plan.md §3 实现模型选择 UI；阶段1 已完成数据管道（commit 09a47a4，src/main/presets.ts）；验收：两个不同模型的 agent 并发执行成功</continue>').length === 0, '防复述：示例同文简报拒绝（即便在末尾）')
// 围栏包裹：显式 auto 的完整标记在代码块里且块是全文结尾 → 末尾锚定被 ``` 挡住，兜底救回
const fenced = parseContinue('结果：\n```\n<continue start="auto">阶段2：按 docs/plan.md §3 完成模型选择 UI 与数据管道施工</continue>\n```')[0]
assert(fenced?.start === 'auto' && fenced?.loose === true, '兜底：围栏包裹的显式 auto 标记救回')
// 未闭合：只有起始标记 → 不触发（配合 runner 的可观测留痕）
assert(parseContinue('我打算输出 <continue start="auto">简报但忘了闭合').length === 0, '未闭合标记不触发')

// ---- e2e 场景 A：领队带 subordinates，最终回合在委派循环后输出 continue（parked） ----
const tmpStore = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-store-'))
const store = new TaskStore(tmpStore)

function continueBackend(tag, firstText, secondText) {
  return {
    id: tag, label: tag,
    async probe() { return { ok: true, detail: '' } },
    async start({ events, turn }) {
      let activeTurn = turn
      setTimeout(() => {
        events.onEvent({ ts: Date.now(), kind: 'final', text: firstText }, activeTurn)
        events.onTurnEnd({ response: firstText, ok: true }, activeTurn)
      }, 30)
      return {
        sessionId: 's_' + tag + Math.random().toString(36).slice(2, 5),
        turnScoped: true,
        async send(content, nextTurn) {
          activeTurn = nextTurn
          setTimeout(() => {
            events.onEvent({ ts: Date.now(), kind: 'final', text: secondText }, activeTurn)
            events.onTurnEnd({ response: secondText, ok: true }, activeTurn)
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
for (let i = 0; i < 100 && store.get(dSucc.id)?.status !== 'done'; i++) await new Promise((resolve) => setTimeout(resolve, 20))
assert(store.get(dSucc.id)?.status === 'done', '续聊产生的后继在前序收尾后恢复调度，不滞留 queued')
// D3：UI 追问（wait:false）——IPC 开跑即返回，不锁整轮；后台回合照常完成
const runnerD3 = new TaskRunner(store, new Map([['lead', continueBackend('lead', '首轮完成。', '追问回答完成。')]]), () => ({ concurrency: 1, mode: 'yolo', notify: false, workerConcurrency: 2 }), () => {})
runnerD3.attachTeam(() => team)
const d3 = store.create({ title: '阶段一 D3', prompt: '干活', workdir: '', backend: 'lead', agentId: 'L', issueId: 'iss_D3' })
runnerD3.enqueue(d3)
const t6 = Date.now()
while (Date.now() - t6 < 15000 && store.get(d3.id)?.status !== 'done') await new Promise((r) => setTimeout(r, 100))
assert(store.get(d3.id)?.status === 'done', '场景 D3：首轮 done')
const fu3 = await runnerD3.followUp(d3.id, '追问一下', { wait: false })
assert(fu3.ok, '场景 D3：wait:false 追问即收 { ok: true }')
assert(store.get(d3.id)?.status === 'running', '场景 D3：IPC 返回时任务已 running（停止按钮不再被 busy 锁死）')
const t7 = Date.now()
while (Date.now() - t7 < 15000 && store.get(d3.id)?.status !== 'done') await new Promise((r) => setTimeout(r, 100))
assert(store.get(d3.id)?.status === 'done' && store.get(d3.id).result.includes('追问回答完成'), '场景 D3：后台回合照常完成')
// ---- 场景 E：硬切复活——非末尾标记兜底 + 未闭合标记可观测留痕 ----
// E1：agent 在标记后补了客套收尾（实测高频形态）→ 兜底通道建单，事件留痕 loose 提示
let eSucc = null
const runnerE = new TaskRunner(store, new Map([['lead', continueBackend('lead', '阶段1 完成。<continue start="auto">阶段2：按 docs/CONSTRUCTION-PLAN.md §5 施工后端适配；阶段1 已完成 shared 契约（src/shared/contracts.ts）；验收：typecheck 绿</continue>\n\n以上是本阶段汇报，有问题随时找我。', '')]]), () => ({ concurrency: 1, mode: 'yolo', notify: false, workerConcurrency: 2 }), () => {})
runnerE.attachTeam(() => team)
runnerE.attachContinue(({ sourceTaskId, issueId, brief }) => {
  eSucc = store.create({ title: '▶ ' + brief.slice(0, 20), prompt: brief, workdir: '', backend: 'lead', agentId: 'L', issueId, trigger: 'handoff', continuesFrom: sourceTaskId })
  return store.get(eSucc.id)
})
const e1 = store.create({ title: '阶段一 E1', prompt: '干活', workdir: '', backend: 'lead', agentId: 'L', issueId: 'iss_E1' })
runnerE.enqueue(e1)
const t8 = Date.now()
while (Date.now() - t8 < 15000 && store.get(e1.id)?.status !== 'done') await new Promise((r) => setTimeout(r, 100))
assert(store.get(e1.id)?.status === 'done', '场景 E1：任务 done')
assert(!!eSucc && eSucc.trigger === 'handoff', '场景 E1：非末尾标记（显式 auto）兜底建单成功')
const e1Events = store.readEvents(e1.id).map((ev) => ev.text ?? '').join('\n')
assert(e1Events.includes('不在回复末尾') && e1Events.includes('兜底解析'), '场景 E1：兜底触发有事件留痕')
assert(!store.get(e1.id).result.includes('<continue'), '场景 E1：标记不外漏')
// E2：只出现未闭合的标记字样 → 不建单，但留"检测到但未触发"的观测痕迹
let e2Created = false
const runnerE2 = new TaskRunner(store, new Map([['lead', continueBackend('lead', '完成。下一阶段我建议 <continue start="auto">先做管道，但本回合先不切会话', '')]]), () => ({ concurrency: 1, mode: 'yolo', notify: false, workerConcurrency: 2 }), () => {})
runnerE2.attachTeam(() => team)
runnerE2.attachContinue(() => { e2Created = true; return {} })
const e2 = store.create({ title: '阶段一 E2', prompt: '干活', workdir: '', backend: 'lead', agentId: 'L', issueId: 'iss_E2' })
runnerE2.enqueue(e2)
const t9 = Date.now()
while (Date.now() - t9 < 15000 && store.get(e2.id)?.status !== 'done') await new Promise((r) => setTimeout(r, 100))
assert(!e2Created, '场景 E2：未闭合标记不建单')
const e2Events = store.readEvents(e2.id).map((ev) => ev.text ?? '').join('\n')
assert(e2Events.includes('未构成有效接力'), '场景 E2：拒收留痕可观测（不再无声失败）')
// ---- 场景 F：接线回归可观测 + sidecar parked 可见性对齐 ----
// F1：attachContinue 未挂接 → 合法标记被剥除、无后继、事件留痕（处理器缺失不再无声死亡）
const runnerF = new TaskRunner(store, new Map([['lead', continueBackend('lead', '完成。<continue start="auto">阶段2：继续施工下一模块（方案 docs/plan.md §2）</continue>', '')]]), () => ({ concurrency: 1, mode: 'yolo', notify: false, workerConcurrency: 2 }), () => {})
runnerF.attachTeam(() => team)
const f1 = store.create({ title: '阶段一 F1', prompt: '干活', workdir: '', backend: 'lead', agentId: 'L', issueId: 'iss_F1' })
runnerF.enqueue(f1)
const tF = Date.now()
while (Date.now() - tF < 15000 && store.get(f1.id)?.status !== 'done') await new Promise((r) => setTimeout(r, 100))
assert(store.get(f1.id)?.status === 'done', '场景 F1：任务 done')
assert(!store.list().some((t) => t.issueId === 'iss_F1' && t.trigger === 'handoff'), '场景 F1：未挂处理器不创建后继')
assert(!store.get(f1.id).result.includes('<continue'), '场景 F1：标记不外漏')
const f1Events = store.readEvents(f1.id).map((ev) => ev.text ?? '').join('\n')
assert(f1Events.includes('阶段接力未生效'), '场景 F1：未挂处理器留痕可观测（接线回归不再无声）')
// F2：SidecarRuntime 的 attachContinue 接线——parked 后继落「等你启动」Issue 评论（对齐主进程 index.ts）
await build({ entryPoints: [path.join(root, 'src/main/sidecar-runtime.ts')], outfile: path.join(root, 'out/sc-sidecar-runtime.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['electron'] })
const { SidecarRuntime } = await import(pathToFileURL(path.join(root, 'out/sc-sidecar-runtime.cjs')).href)
const tmpSidecar = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-sidecar-'))
const runtime = new SidecarRuntime(tmpSidecar)
const srcF2 = runtime.taskService.createTask({ title: '阶段一 S', prompt: '干活', workdir: '', backend: 'zcode' }, 'manual')
const briefF2 = '阶段2：继续施工下一模块，方案见 docs/plan.md §2；阶段1 已完成脚手架；验收：typecheck 绿'
const f2Task = runtime.runner['onContinue']({ sourceTaskId: srcF2.id, issueId: srcF2.issueId, brief: briefF2, start: 'parked' })
assert(!!f2Task && f2Task.parked === true && f2Task.trigger === 'handoff' && f2Task.continuesFrom === srcF2.id, '场景 F2：sidecar parked 后继创建（同 Issue、指向前一阶段）')
assert(JSON.stringify(runtime.issueStore.comments(srcF2.issueId)).includes('阶段接力已备好'), '场景 F2：parked 可见性评论已落（与主进程对齐，不再隐形）')
const noticeCount = runtime.issueStore.comments(srcF2.issueId).length
const f2Replay = runtime.runner['onContinue']({ sourceTaskId: srcF2.id, issueId: srcF2.issueId, brief: briefF2, start: 'parked' })
assert(f2Replay?.id === f2Task.id, '场景 F2：同 source+brief 幂等复用（不重复建单）')
assert(runtime.issueStore.comments(srcF2.issueId).length === noticeCount, '相同请求立即重放不重复追加提醒')
const f2Reworded = runtime.runner['onContinue']({ sourceTaskId: srcF2.id, issueId: srcF2.issueId, brief: '阶段2：换种说法再次交接同一阶段', start: 'auto' })
assert(f2Reworded?.id === f2Task.id && f2Reworded.parked, '同来源改写简报仍复用后继，不自动解除停放')
assert(runtime.issueStore.comments(srcF2.issueId).length === noticeCount, '重复接力不重复写可见通知')

// Replays still repair legacy Goal metadata and publish the repaired projection.
const repairGoal = runtime.goalController.create({ text: 'repair legacy handoff', issueId: srcF2.issueId, completionConditions: ['complete'], stopConditions: [], maxRuns: 1, maxDurationMs: 60000, workdir: '', startNow: false })
runtime.store.update(srcF2.id, { goalId: repairGoal.id, phaseIndex: 0, status: 'running', runId: 'repair-source' })
let repairedNotifications = 0
const onRuntimeTask = runtime['onTaskChanged'].bind(runtime)
runtime['onTaskChanged'] = (task) => { if (task.id === f2Task.id && task.goalId === repairGoal.id && task.phaseIndex === 1) repairedNotifications++; onRuntimeTask(task) }
const replayMarker = `<continue start="auto">${briefF2}，更新简报</continue>`
runtime.runner['handleContinue'](srcF2.id, runtime.store.get(srcF2.id), [replayMarker], replayMarker)
assert(runtime.store.get(f2Task.id).goalId === repairGoal.id && runtime.store.get(f2Task.id).phaseIndex === 1 && repairedNotifications > 0, 'Runner 重放仍经 TaskService 修复旧后继，并通知 Goal 投影')
assert(runtime.store.get(f2Task.id).parked && runtime.issueStore.comments(srcF2.issueId).length === noticeCount, '旧后继修复不自动启动、不重复提醒')
runtime.store.update(f2Task.id, { goalId: undefined, phaseIndex: undefined })
runtime.store.update(srcF2.id, { status: 'done' })
runtime.runner['backends'].set('zcode', continueBackend('repair', 'complete', ''))
repairedNotifications = 0
assert((await runtime.runner.followUp(srcF2.id, '启动已备好的阶段', { relay: true })).ok, '人工接力复用旧后继')
for (let i = 0; i < 100 && runtime.store.get(f2Task.id)?.status !== 'done'; i++) await new Promise((resolve) => setTimeout(resolve, 20))
assert(runtime.store.get(f2Task.id).goalId === repairGoal.id && runtime.store.get(f2Task.id).phaseIndex === 1 && repairedNotifications > 0, '人工接力快捷入口也修复并发布 Goal 归属')

// Reproduce the production loop: reworded phase 2 must not create phase 2 again.
const repeatText = '只读核查完成，等待确认。<continue start="parked">阶段2待用户明确确认后实施：按 docs/BUG-AUDIT-PERSISTENCE.md 修复。补充本轮核查记录。</continue>'
const repeatRunner = new TaskRunner(store, new Map([['lead', continueBackend('repeat', repeatText, '')]]), () => ({ concurrency: 1, mode: 'yolo', notify: false }), () => {})
let repeatCreates = 0
repeatRunner.attachContinue(() => { repeatCreates++; return {} })
const repeatSource = store.create({ title: 'repeat phase', prompt: '阶段2：等待用户确认后，按 docs/BUG-AUDIT-PERSISTENCE.md 实施。', workdir: '', backend: 'lead', issueId: 'iss_repeat', continuesFrom: 'phase1', trigger: 'handoff' })
repeatRunner.enqueue(repeatSource)
for (let i = 0; i < 100 && store.get(repeatSource.id)?.status !== 'done'; i++) await new Promise((resolve) => setTimeout(resolve, 50))
assert(store.get(repeatSource.id)?.status === 'done' && repeatCreates === 0, '同阶段改写简报被拦截，不再生成下一张待确认任务')
assert(store.readEvents(repeatSource.id).some((event) => event.text?.includes('阶段接力已阻止')), '重复阶段拦截可观测')
assert(!store.get(repeatSource.id).result.includes('<continue'), '被拒绝的接力标记不会外漏')

// Normal phase advancement still creates exactly one successor per phase.
const chainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-chain-'))
const chainRuntime = new SidecarRuntime(chainDir)
const chainStore = chainRuntime.store
const chainService = chainRuntime.taskService
let launches = 0
const predecessorStates = []
const phaseBackend = {
  id: 'phase', label: 'phase', async probe() { return { ok: true, detail: '' } },
  async start({ prompt, events }) {
    launches++
    const current = chainStore.list().find((task) => task.status === 'running' && prompt.includes(task.prompt))
    if (current?.continuesFrom) {
      const persisted = JSON.parse(fs.readFileSync(path.join(chainDir, 'tasks/tasks.json'), 'utf8'))
      predecessorStates.push([chainStore.get(current.continuesFrom)?.status, persisted.tasks.find((task) => task.id === current.continuesFrom)?.status])
    }
    const result = prompt.includes('阶段3：最终验收') ? '验收完成' : prompt.includes('阶段2：实现功能')
      ? '阶段2已完成。<continue start="auto">阶段3：最终验收</continue>'
      : '阶段1已完成。<continue start="auto">阶段2：实现功能</continue>'
    setTimeout(() => { events.onEvent({ ts: Date.now(), kind: 'final', text: result }); events.onTurnEnd({ ok: true, response: result }) }, 10)
    return { sessionId: `phase-${launches}`, async send() {}, async stop() {}, async close() {} }
  }
}
const chainRunner = new TaskRunner(chainStore, new Map([['phase', phaseBackend]]), () => ({ concurrency: 2, mode: 'yolo', notify: false }), () => {})
const finalizeChain = chainRunner['finalizer'].finalizeDone.bind(chainRunner['finalizer'])
chainRunner['finalizer'].finalizeDone = async (...args) => {
  await new Promise((resolve) => setTimeout(resolve, 50))
  return finalizeChain(...args)
}
chainRunner.attachContinue((input) => { const next = chainService.createHandoffTask(input); if (next && !next.parked) chainRunner.enqueue(next); return next })
const chainFirst = chainService.createTask({ title: 'phase1', prompt: '阶段1：设计', backend: 'phase' })
chainRunner.enqueue(chainFirst)
for (let i = 0; i < 100 && (launches < 3 || chainStore.list().some((task) => task.status !== 'done')); i++) await new Promise((resolve) => setTimeout(resolve, 50))
assert(launches === 3 && chainStore.list().length === 3 && chainStore.list().every((task) => task.status === 'done'), '阶段1→2→3正常自动推进，每阶段只启动一次')
assert(predecessorStates.length === 2 && predecessorStates.every(([memory, disk]) => memory === 'done' && disk === 'done'), '并发2且前序延迟收尾：后继只能在前序终态落盘后启动')
await chainRunner.shutdown()
await chainRuntime.close()
await repeatRunner.shutdown()

for (const fault of ['event', 'terminal']) {
  const faultRuntime = new SidecarRuntime(fs.mkdtempSync(path.join(os.tmpdir(), 'sc-finalize-fault-')))
  const faultStore = faultRuntime.store
  const faultBackend = continueBackend('fault', '准备完成', '完成。<continue start="auto">阶段2：执行后继</continue>')
  const faultRunner = new TaskRunner(faultStore, new Map([['fault', faultBackend]]), () => ({ concurrency: 2, mode: 'ask', notify: false }), () => {})
  faultRunner.attachContinue((input) => { const next = faultRuntime.taskService.createHandoffTask(input); if (next && !next.parked) faultRunner.enqueue(next); return next })
  const source = faultRuntime.taskService.createTask({ title: fault, prompt: '阶段1：准备', backend: 'fault' })
  faultRunner.enqueue(source)
  for (let i = 0; i < 100 && faultStore.get(source.id)?.status !== 'done'; i++) await new Promise((resolve) => setTimeout(resolve, 20))
  let injected = false
  const update = faultStore.updateIf.bind(faultStore)
  const append = faultStore.appendEvent.bind(faultStore)
  faultStore.updateIf = (id, expected, patch) => {
    if (fault === 'terminal' && !injected && id === source.id && patch.status === 'done') { injected = true; throw new Error('injected terminal write failure') }
    return update(id, expected, patch)
  }
  faultStore.appendEvent = (id, event, expected) => {
    if (fault === 'event' && !injected && id === source.id && event.kind === 'status' && faultStore.list().some((task) => task.continuesFrom === source.id)) { injected = true; throw new Error('injected status event write failure') }
    return append(id, event, expected)
  }
  const failedTurn = await faultRunner.followUp(source.id, '进入下一阶段')
  const next = faultStore.list().find((task) => task.continuesFrom === source.id)
  for (let i = 0; i < 100 && next && faultStore.get(next.id)?.status !== 'done'; i++) await new Promise((resolve) => setTimeout(resolve, 20))
  assert(injected && !failedTurn.ok && faultStore.get(source.id).status === 'failed', `${fault} 故障：前序续聊正确进入失败终态`)
  assert(next && faultStore.get(next.id).status === 'done', `${fault} 故障：已创建后继在失败终态落盘后被唤醒，不永久排队`)
  await faultRunner.shutdown()
  await faultRuntime.close()
}
await runtime.close()
console.log('\n✅ CONTINUE SMOKE PASSED')
process.exit(0)
