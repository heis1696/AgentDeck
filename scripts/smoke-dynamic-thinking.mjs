// 动态思考强度端到端冒烟（无 Electron，纯 Node + 假后端）：
// 覆盖不变量 DT-1 ~ DT-9：
//   1. 静态档位解析（绝不把 'auto' 传入后端）与 IPC 校验白名单
//   2. <delegate>/<investigate>/<continue> 的 thinking 属性解析与非法值容错
//   3. 分诊师技能落盘/用户编辑保护、回复解析、HTTP 快通路 / CLI 兜底 / TriageBroker 取消 / Fail-open 兜底
//   4. 追问迟滞防抖（升档立即、1 档降保缓存、≥2 档降采纳）
//   5. TaskRunner：RouteThinkingNode 静默分诊、skipTriage 短路、领队 thinking 无条件覆写固定档队员、
//      隐藏辅助回合强制降档（retitle=off / summary=low）、followUp 热切/静默分诊/skipTriage 保原档、isIdle() 归零
//   6. 确定性升档安全网：瞬态失败二次重试升档、Goal 停滞升档、Doom Loop 放行升档、failed 子单思考注记
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-dynamic-thinking-'))
const outDir = path.join(tmpRoot, 'bundles')
fs.mkdirSync(outDir, { recursive: true })

const bundleSources = [
  ['src/shared/types.ts', 'types.cjs'],
  ['src/shared/triage.ts', 'triage-shared.cjs'],
  ['src/main/thinking-triage.ts', 'thinking-triage.cjs'],
  ['src/main/delegate.ts', 'delegate.cjs'],
  ['src/main/ipc-validation.ts', 'ipc-validation.cjs'],
  ['src/main/store.ts', 'store.cjs'],
  ['src/main/issue-store.ts', 'issue-store.cjs'],
  ['src/main/task-service.ts', 'task-service.cjs'],
  ['src/main/runner.ts', 'runner.cjs'],
  ['src/main/goal-store.ts', 'goal-store.cjs'],
  ['src/main/goal-controller.ts', 'goal-controller.cjs']
]

await Promise.all(bundleSources.map(([src, out]) => build({
  entryPoints: [path.join(root, src)],
  outfile: path.join(outDir, out),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['electron']
})))

const load = (name) => import(pathToFileURL(path.join(outDir, name)).href)
const [
  sharedTypes,
  triageShared,
  triageEngine,
  delegateMod,
  ipcVal,
  { TaskStore },
  { IssueStore },
  { TaskService },
  runnerMod,
  { GoalStore },
  { GoalController }
] = await Promise.all(bundleSources.map(([, out]) => load(out)))

const { TaskRunner, resolveStaticThinking } = runnerMod
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(pred, timeoutMs = 10000, stepMs = 20) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return true
    await sleep(stepMs)
  }
  return false
}

let failures = 0
const ok = (cond, label) => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`)
  if (!cond) { failures++; process.exitCode = 1 }
}
const section = (title) => console.log(`\n── ${title}`)

try {
  // ------------------------------------------------------------------ 1. DT-1 & IPC validation
  section('1. 静态档位解析（DT-1）与 IPC 校验')
  {
    ok(sharedTypes.isAgentThinking('auto') && !sharedTypes.isThinkingLevel('auto'), 'auto 属于 AgentThinking 但不属于后端 5 档 ThinkingLevel')
    ok(resolveStaticThinking({}, { thinking: 'auto' }) === undefined, 'resolveStaticThinking 绝不把 auto 透传给后端')
    ok(resolveStaticThinking({ thinking: 'high' }, { thinking: 'auto' }) === 'high', '任务显式档位优先于 auto')
    ok(resolveStaticThinking({ thinking: 'low' }, { thinking: 'max' }) === 'low', '任务显式档位无条件覆写 Agent 固定档位')
    ok(resolveStaticThinking({}, { thinking: 'medium' }) === 'medium', '无任务档位时沿用 Agent 固定档位')

    let rejectedAutoTask = false
    try { ipcVal.parseTaskCreate({ title: 't', prompt: 'p', workdir: '', thinking: 'auto' }) } catch { rejectedAutoTask = true }
    ok(rejectedAutoTask, 'parseTaskCreate 拒绝任务级 thinking="auto"')

    const validTask = ipcVal.parseTaskCreate({ title: 't', prompt: 'p', workdir: '', thinking: 'high', thinkingSource: 'user', thinkingReason: '手动', skipTriage: true })
    ok(validTask.thinking === 'high' && validTask.thinkingSource === 'user' && validTask.skipTriage === true, 'parseTaskCreate 放行合法 thinking 字段与 skipTriage')

    const parsedAgents = ipcVal.parseAgents([{ id: 'a1', name: 'Coder', backend: 'zcode', thinking: 'auto', color: '#4f8cff' }])
    ok(parsedAgents[0].thinking === 'auto', 'parseAgents 放行 Agent 级 thinking="auto"')

    const parsedAssess = ipcVal.parseTriageAssess({ requestId: 'req_1', prompt: 'hello', kind: 'followup', currentThinking: 'high' })
    ok(parsedAssess.requestId === 'req_1' && parsedAssess.kind === 'followup' && parsedAssess.currentThinking === 'high', 'parseTriageAssess 校验通过')
  }

  // ------------------------------------------------------------------ 2. Protocol thinking attr
  section('2. 协议标记 thinking 属性解析（delegate / investigate / continue）')
  {
    ok(delegateMod.parseThinkingAttr('HIGH').level === 'high', 'parseThinkingAttr 忽略大小写匹配 5 档')
    ok(delegateMod.parseThinkingAttr('').level === undefined && delegateMod.parseThinkingAttr('').invalid === undefined, 'parseThinkingAttr 空值视为未声明')
    ok(delegateMod.parseThinkingAttr('ultra').invalid === 'ultra', 'parseThinkingAttr 非法值记入 invalid 不抛异常')

    const dCalls = delegateMod.parseDelegates('<delegate to="W1" thinking="max" reason="复杂锁">查死锁</delegate>\n<delegate to="W2" thinking="turbo">写文档</delegate>')
    ok(dCalls.length === 2 && dCalls[0].thinking === 'max' && !dCalls[0].invalidThinking, 'parseDelegates 提取合法 thinking')
    ok(dCalls[1].thinking === undefined && dCalls[1].invalidThinking === 'turbo', 'parseDelegates 非法 thinking 降级留痕但不拒单')

    const iCalls = delegateMod.parseInvestigates('<investigate to="W1" thinking="low">查版本</investigate>')
    ok(iCalls.length === 1 && iCalls[0].thinking === 'low', 'parseInvestigates 提取 thinking')

    const cCalls = delegateMod.parseContinue('已完成阶段 1。\n<continue start="auto" thinking="high">阶段2：重构队列锁机制并补齐竞态测试</continue>')
    ok(cCalls.length === 1 && cCalls[0].thinking === 'high', 'parseContinue 提取 thinking')

    const failedBody = delegateMod.buildChildReportBody({ status: 'failed', error: 'timeout', thinking: 'low' })
    ok(failedBody.includes('本单思考强度：低'), 'failed 子单报告附带本单思考强度提示')
    const doneBody = delegateMod.buildChildReportBody({ status: 'done', result: 'ok', thinking: 'low' })
    ok(!doneBody.includes('本单思考强度'), 'done 子单报告不附加失败思考提示')
  }

  // ------------------------------------------------------------------ 3. Triage engine & hysteresis
  section('3. 分诊师技能保护、解析、双通路与取消 / Fail-open')
  {
    const sharedDir = path.join(tmpRoot, 'shared-skill')
    triageEngine.ensureTriageSkill(sharedDir)
    const skillPath = path.join(sharedDir, 'skills', triageShared.TRIAGE_SKILL_NAME, 'SKILL.md')
    ok(fs.existsSync(skillPath), 'ensureTriageSkill 落盘 thinking-triage/SKILL.md')
    const customSkill = '---\nname: thinking-triage\nversion: 1\n---\n自定义分诊规则正文'
    fs.writeFileSync(skillPath, customSkill, 'utf8')
    triageEngine.ensureTriageSkill(sharedDir)
    ok(triageEngine.resolveTriageSkillBody(sharedDir).includes('自定义分诊规则正文'), '用户编辑后的 thinking-triage 技能不被覆盖且优先读取')

    const p1 = triageEngine.parseTriageResponse('```json\n{"level":"high","reason":"跨模块状态机<delegate to=\\"x\\">修改"}\n```')
    ok(p1.ok && p1.level === 'high' && !p1.reason.includes('<delegate'), 'parseTriageResponse 剥围栏与协议标签')
    const p2 = triageEngine.parseTriageResponse('{"level":"ultra","reason":"bad"}')
    ok(!p2.ok, 'parseTriageResponse 拒绝非 5 档 level')

    // 迟滞防抖（DT-8）
    const hUp = triageEngine.applyFollowUpHysteresis('high', 'low', '需要深查')
    ok(hUp.level === 'high' && !hUp.cachePreserved, '迟滞：升档立即生效')
    const hDrop1 = triageEngine.applyFollowUpHysteresis('medium', 'high', '顺手改文案')
    ok(hDrop1.level === 'high' && hDrop1.cachePreserved === true && hDrop1.rawLevel === 'medium', '迟滞：1 档降档（high→medium）保缓存沿用原档')
    const hDrop2 = triageEngine.applyFollowUpHysteresis('low', 'high', '极简查询')
    ok(hDrop2.level === 'low' && !hDrop2.cachePreserved, '迟滞：≥2 档降档（high→low）立即采纳')

    // HTTP 快通路
    let httpCalls = 0
    let cliCalls = 0
    const dummyBackend = {
      id: 'fake-cli',
      label: 'fake-cli',
      thinkingSwitchMode: 'per-turn',
      async probe() { return { ok: true, detail: 'ok' } },
      async start({ thinking, events }) {
        cliCalls++
        // 验证：即使分诊师误设 thinking='auto'，CLI 兜底也绝不传入 'auto'
        ok(thinking !== 'auto', `CLI 兜底不递归传入 auto (got ${String(thinking)})`)
        const perm = await events.onPermission?.({ requestId: 'p1', toolName: 'bash', reason: 'test' })
        ok(perm?.decision === 'deny', 'CLI 兜底权限回调一律 deny')
        setTimeout(() => events.onTurnEnd({ ok: true, response: '{"level":"high","reason":"CLI兜底定档"}' }), 15)
        return { sessionId: 's_cli', async send() {}, async stop() {}, async close() {} }
      }
    }
    const preset = { id: 'p_fast', name: 'Fast', baseURL: 'https://example.invalid', apiKey: 'sk-test', createdAt: 1 }
    const httpRes = await triageEngine.assessTaskThinking({
      agents: [{ id: triageShared.TRIAGE_AGENT_ID, name: '分诊师', backend: 'fake-cli', presetId: 'p_fast', model: 'fast-mini', thinking: 'off' }],
      presets: [preset],
      backends: new Map([['fake-cli', dummyBackend]]),
      mode: 'yolo',
      sharedDir,
      chatCompletion: async (_p, _msgs, opts) => {
        httpCalls++
        ok(opts.model === 'fast-mini' && opts.maxTokens === 160, 'HTTP 快通路透传模型与 maxTokens')
        return '{"level":"low","reason":"单文件改文案"}'
      }
    }, { prompt: '把 README 里的错别字改一下', kind: 'task' })
    ok(httpRes.ok && httpRes.decision.via === 'preset-http' && httpRes.decision.level === 'low' && httpCalls === 1 && cliCalls === 0, 'HTTP 快通路命中并跳过 CLI 启动')

    // CLI 兜底通路（无预设 + 防自递归 auto）
    const cliRes = await triageEngine.assessTaskThinking({
      agents: [{ id: triageShared.TRIAGE_AGENT_ID, name: '分诊师', backend: 'fake-cli', thinking: 'auto' }],
      presets: [],
      backends: new Map([['fake-cli', dummyBackend]]),
      mode: 'yolo',
      sharedDir
    }, { prompt: '排查并发锁竞态', kind: 'task' })
    ok(cliRes.ok && cliRes.decision.via === 'backend-cli' && cliRes.decision.level === 'high' && cliCalls === 1, '无预设时自动回退 CLI 兜底通路')

    // TriageBroker 精确取消
    const broker = new triageEngine.TriageBroker()
    const slowPromise = broker.assess({
      agents: [{ id: triageShared.TRIAGE_AGENT_ID, name: '分诊师', backend: 'fake-cli', presetId: 'p_fast', model: 'fast-mini', thinking: 'off' }],
      presets: [preset],
      backends: new Map(),
      mode: 'yolo',
      sharedDir,
      chatCompletion: (_p, _m, opts) => new Promise((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }, { requestId: 'cancel_me', prompt: '慢请求', kind: 'task' })
    await sleep(10)
    const cancelled = broker.cancel('cancel_me')
    const cancelRes = await slowPromise
    ok(cancelled && !cancelRes.ok && cancelRes.cancelled === true && broker.activeCount === 0, 'TriageBroker.cancel 精确中止在飞请求且零泄漏')

    // Fail-open 兜底（非 JSON 输出）
    const badRes = await triageEngine.assessTaskThinking({
      agents: [{ id: triageShared.TRIAGE_AGENT_ID, name: '分诊师', backend: 'fake-cli', presetId: 'p_fast', model: 'fast-mini', thinking: 'off' }],
      presets: [preset],
      backends: new Map(),
      mode: 'yolo',
      sharedDir,
      chatCompletion: async () => '我不太确定，随便吧'
    }, { prompt: '测试异常输出', kind: 'task' })
    ok(!badRes.ok && badRes.fallback === 'medium', '非 JSON 输出 Fail-open 降级为 medium')
  }

  // ------------------------------------------------------------------ 4. TaskRunner RouteThinkingNode, skipTriage, followUp, hidden turns, delegate override
  section('4. TaskRunner：RouteThinkingNode / skipTriage / 领队覆写 / 热切 / 隐藏回合')
  {
    const dir = path.join(tmpRoot, 'runner-main')
    fs.mkdirSync(dir, { recursive: true })
    const store = new TaskStore(dir, { recoverRunning: false })
    const issueStore = new IssueStore(dir)
    const starts = []
    const sends = []

    const fakeBackend = {
      id: 'perturn-fake',
      label: 'PerTurn Fake',
      supportsResume: true,
      thinkingSwitchMode: 'per-turn',
      async probe() { return { ok: true, detail: 'ok' } },
      async start({ prompt, thinking, turn, events }) {
        starts.push({ prompt, thinking })
        const sessionId = `sess_${starts.length}`
        const isLeaderPrompt = prompt.includes('派活给队员')
        const reply = isLeaderPrompt
          ? '<delegate to="FixedWorker" thinking="max" reason="复杂并发">排查竞态</delegate>\n<delegate to="AutoWorker">改一行注释</delegate>'
          : '任务完成'
        setTimeout(() => {
          events.onEvent({ ts: Date.now(), kind: 'final', text: reply }, turn)
          events.onTurnEnd({ ok: true, response: reply }, turn)
        }, 15)
        return {
          sessionId,
          turnScoped: true,
          async send(content, stamp, opts) {
            sends.push({ sessionId, content, thinking: opts?.thinking })
            const resp = content.includes('简短标题') ? '简洁标题' : '续轮完成'
            setTimeout(() => {
              events.onEvent({ ts: Date.now(), kind: 'final', text: resp }, stamp)
              events.onTurnEnd({ ok: true, response: resp }, stamp)
            }, 15)
          },
          async stop() {},
          async close() {}
        }
      }
    }

    const team = [
      { id: 'ag_leader', name: 'Leader', backend: 'perturn-fake', thinking: 'medium', subordinates: ['ag_fixed', 'ag_auto'], color: '#4f8cff', role: '领队' },
      { id: 'ag_fixed', name: 'FixedWorker', backend: 'perturn-fake', thinking: 'low', color: '#22c55e', role: '工程师' },
      { id: 'ag_auto', name: 'AutoWorker', backend: 'perturn-fake', thinking: 'auto', color: '#06b6d4', role: '工程师' }
    ]
    const taskService = new TaskService({ store, issueStore, getAgent: (id) => team.find((a) => a.id === id) })
    const runner = new TaskRunner(store, new Map([[fakeBackend.id, fakeBackend]]), () => ({ concurrency: 4, workerConcurrency: 4, mode: 'yolo', notify: false }))
    runner.attachTeam(() => team)
    runner.attachTaskService(taskService)

    const triageCalls = []
    runner.attachTriage(async (input) => {
      triageCalls.push(input)
      if (input.kind === 'followup') {
        return { ok: true, decision: { level: 'high', reason: '追问升级排查', source: 'triage', via: 'preset-http', durationMs: 5 } }
      }
      return { ok: true, decision: { level: 'low', reason: '简单修改', source: 'triage', via: 'preset-http', durationMs: 5 } }
    })

    // 4a. auto 任务走 RouteThinkingNode 静默分诊 + titleAuto 隐藏回合强制 thinking='off'
    const tAuto = taskService.createTask({ title: 'auto-1', titleAuto: true, prompt: '帮我改个变量名', workdir: '', agentId: 'ag_auto', backend: 'perturn-fake' })
    runner.enqueue(tAuto)
    ok(await until(() => store.get(tAuto.id)?.status === 'done'), 'auto 任务走 RouteThinkingNode 正常完成')
    const savedAuto = store.get(tAuto.id)
    ok(savedAuto.thinking === 'low' && savedAuto.thinkingSource === 'triage', 'RouteThinkingNode 落盘分诊结果')
    ok(starts[0].thinking === 'low', 'backend.start 收到分诊后的 low 而非 auto')
    ok(sends.some((s) => s.content.includes('简短标题') && s.thinking === 'off'), 'retitleByAgent 隐藏回合强制 thinking="off"')
    ok(runner.isIdle(), 'RouteThinkingNode 执行完毕后 runner.isIdle() 归零')

    // 4b. skipTriage: true 严守用户跳过（零分诊调用）
    const callsBeforeSkip = triageCalls.length
    const tSkip = taskService.createTask({ title: 'skip-1', prompt: '跳过分诊测试', workdir: '', agentId: 'ag_auto', backend: 'perturn-fake', skipTriage: true })
    runner.enqueue(tSkip)
    ok(await until(() => store.get(tSkip.id)?.status === 'done'), 'skipTriage 任务正常完成')
    ok(triageCalls.length === callsBeforeSkip, 'skipTriage=true 绝不触发 RouteThinkingNode 分诊')
    ok(starts[starts.length - 1].thinking === undefined, 'skipTriage=true 走平台默认 undefined')

    // 4c. followUp：显式热切 / 后台静默分诊 / skipTriage 沿用原档 / sendChildSummaryTurn 强制 low
    const fExplicit = await runner.followUp(tAuto.id, '改用极致深入查一下', { thinking: 'max', thinkingSource: 'user', thinkingReason: '用户改档' })
    ok(fExplicit.ok && store.get(tAuto.id)?.thinking === 'max', 'followUp 显式 thinking 落盘并热切')
    ok(sends.some((s) => s.content.includes('改用极致') && s.thinking === 'max'), 'followUp 显式 thinking 透传至 session.send')

    const callsBeforeSilentFollow = triageCalls.length
    const fSilent = await runner.followUp(tAuto.id, '再排查一下竞态边界')
    ok(fSilent.ok && triageCalls.length === callsBeforeSilentFollow + 1 && triageCalls.at(-1).kind === 'followup' && triageCalls.at(-1).currentThinking === 'max', '后台无参 followUp 触发静默分诊并携带 currentThinking')
    ok(sends.some((s) => s.content.includes('再排查一下') && s.thinking === 'high'), '后台静默追问分诊结果透传至 session.send')

    const callsBeforeSkipFollow = triageCalls.length
    const fSkip = await runner.followUp(tAuto.id, '顺手改个标点', { skipTriage: true })
    ok(fSkip.ok && triageCalls.length === callsBeforeSkipFollow, 'followUp skipTriage=true 不触发静默分诊')
    ok(sends.some((s) => s.content.includes('顺手改个标点') && s.thinking === 'high'), 'followUp skipTriage=true 沿用任务当前档位（high）')

    const sumTurn = await runner.sendChildSummaryTurn(tAuto.id, '请总结')
    ok(!!sumTurn?.ok && sends.some((s) => s.content === '请总结' && s.thinking === 'low'), 'sendChildSummaryTurn 强制 thinking="low"')

    // 4d. 领队委派：显式 thinking="max" 无条件覆写固定 low 队员（零分诊）；省略 thinking 的 auto 队员走静默分诊
    const callsBeforeDelegate = triageCalls.length
    const tLeader = taskService.createTask({ title: 'leader-1', prompt: '派活给队员', workdir: '', agentId: 'ag_leader', backend: 'perturn-fake' })
    runner.enqueue(tLeader)
    ok(await until(() => store.get(tLeader.id)?.status === 'done', 12000), '领队委派任务正常完成')
    const children = store.list().filter((t) => t.parentTaskId === tLeader.id)
    const fixedChild = children.find((c) => c.agentId === 'ag_fixed')
    const autoChild = children.find((c) => c.agentId === 'ag_auto')
    ok(fixedChild?.thinking === 'max' && fixedChild?.thinkingSource === 'leader', 'DT-3：领队 <delegate thinking="max"> 无条件覆写固定 low 队员')
    ok(starts.some((s) => s.prompt.includes('排查竞态') && s.thinking === 'max'), 'DT-3：固定档队员实际以领队指派的 max 启动')
    ok(autoChild?.thinking === 'low' && autoChild?.thinkingSource === 'triage', '领队省略 thinking 的 auto 队员自动走 RouteThinkingNode 分诊')
    ok(triageCalls.length === callsBeforeDelegate + 1 && triageCalls.at(-1).kind === 'delegate', '领队覆写子单零分诊，仅省略 thinking 的 auto 子单调一次分诊')
    ok(runner.isIdle(), '委派全部结束后 runner.isIdle() 归零')

    await runner.shutdown()
  }

  // ------------------------------------------------------------------ 5. Escalation safety nets
  section('5. 确定性自动升档安全网（重试 / Goal 停滞 / Doom Loop）')
  {
    ok(triageShared.nextEscalatedThinkingLevel(undefined) === 'high'
      && triageShared.nextEscalatedThinkingLevel('off') === 'low'
      && triageShared.nextEscalatedThinkingLevel('low') === 'medium'
      && triageShared.nextEscalatedThinkingLevel('medium') === 'high'
      && triageShared.nextEscalatedThinkingLevel('high') === 'max'
      && triageShared.nextEscalatedThinkingLevel('max') === null, 'nextEscalatedThinkingLevel 阶梯正确')

    // 5a. 瞬态失败二次重试（freshSession）自动升档
    process.env.AGENTDECK_RETRY_DELAY_MS = '30'
    const retryDir = path.join(tmpRoot, 'retry-esc')
    fs.mkdirSync(retryDir, { recursive: true })
    const rStore = new TaskStore(retryDir, { recoverRunning: false })
    const observedThinking = []
    let attemptSeen = 0
    const flakyBackend = {
      id: 'flaky',
      label: 'Flaky',
      supportsResume: true,
      thinkingSwitchMode: 'per-turn',
      async probe() { return { ok: true, detail: 'ok' } },
      async start({ thinking, events }) {
        attemptSeen++
        observedThinking.push(thinking)
        setTimeout(() => {
          if (attemptSeen < 3) {
            events.onTurnEnd({ ok: false, response: '', error: '429 rate limit' })
          } else {
            events.onEvent({ ts: Date.now(), kind: 'final', text: 'recovered' })
            events.onTurnEnd({ ok: true, response: 'recovered' })
          }
        }, 15)
        return { sessionId: `flaky_${attemptSeen}`, async send() {}, async stop() {}, async close() {} }
      }
    }
    const rRunner = new TaskRunner(rStore, new Map([['flaky', flakyBackend]]), () => ({ concurrency: 2, mode: 'yolo', notify: false, maxRetryAttempts: 2, retryBackoffMs: 20 }))
    rRunner.attachTeam(() => [{ id: 'ag_auto', name: 'Auto', backend: 'flaky', thinking: 'auto', color: '#06b6d4' }])
    const tRetry = rStore.create({ title: 'retry-esc', prompt: 'test retry', workdir: '', backend: 'flaky', agentId: 'ag_auto', thinking: 'low', thinkingSource: 'triage' })
    rRunner.enqueue(tRetry)
    ok(await until(() => rStore.get(tRetry.id)?.status === 'done', 8000), '二次重试任务最终恢复完成')
    const afterRetry = rStore.get(tRetry.id)
    ok(observedThinking[0] === 'low' && observedThinking[1] === 'low' && observedThinking[2] === 'medium', `第 2 次新会话重试自动升档（observed: ${observedThinking.join('→')}）`)
    ok(afterRetry?.thinking === 'medium' && afterRetry?.thinkingSource === 'escalation', '重试升档落盘 thinkingSource="escalation"')
    await rRunner.shutdown()

    // 5b. Goal 停滞（noProgress >= 1）自动升档
    const goalDir = path.join(tmpRoot, 'goal-esc')
    fs.mkdirSync(goalDir, { recursive: true })
    const gStore = new GoalStore(goalDir)
    const tasksList = []
    const continueCalls = []
    const gc = new GoalController(gStore, {
      createTask: (input) => {
        const t = { id: `t_g_${tasksList.length + 1}`, title: input.title, prompt: input.prompt, workdir: '', backend: 'zcode', agentId: input.agentId, issueId: input.issueId, goalId: input.goalId, phaseIndex: input.phaseIndex, status: 'queued', createdAt: Date.now(), eventCount: 0, sessionId: 'sess_goal_1', thinking: input.thinking ?? 'low', thinkingSource: input.thinkingSource ?? 'triage' }
        tasksList.push(t)
        return t
      },
      listTasks: () => tasksList,
      isAutoThinking: (id) => id === 'ag_auto',
      continueTask: (taskId, content, opts) => { continueCalls.push({ taskId, content, opts }); return { ok: true } }
    })
    const goal = gc.create({ text: '修完测试', issueId: 'iss_g1', completionConditions: ['全部通过'], stopConditions: [], maxRuns: 5, maxDurationMs: 3600_000, workdir: '', agentId: 'ag_auto', startNow: true })
    const gTask = tasksList[0]
    // 第 1 轮输出不变（noProgress=0），第 2 轮同输出（noProgress=1）触发升档
    gTask.status = 'done'; gTask.runId = 'run_1'; gTask.result = '仍然失败：同错'
    gc.onTaskChanged({ ...gTask })
    await sleep(20)
    ok(continueCalls.length === 1 && !continueCalls[0].opts, 'Goal 首轮未停滞不触发升档')
    gTask.runId = 'run_2'; gTask.phaseIndex = 1
    gc.onTaskChanged({ ...gTask })
    await sleep(20)
    ok(continueCalls.length === 2 && continueCalls[1].opts?.thinking === 'medium' && continueCalls[1].opts?.thinkingSource === 'escalation', 'Goal 连续无进展（noProgress=1）续轮自动升档 low→medium')

    // 5c. Doom Loop 人工放行后自动升档并在下回合生效
    const doomDir = path.join(tmpRoot, 'doom-esc')
    fs.mkdirSync(doomDir, { recursive: true })
    const dStore = new TaskStore(doomDir, { recoverRunning: false })
    const doomSends = []
    let finishFirstTurn = null
    const doomBackend = {
      id: 'doom-fake',
      label: 'Doom Fake',
      supportsResume: true,
      thinkingSwitchMode: 'per-turn',
      async probe() { return { ok: true, detail: 'ok' } },
      async start({ turn, events }) {
        setTimeout(() => {
          events.onEvent({ ts: Date.now(), kind: 'tool', text: 'grep', data: { phase: 'started', args: 'foo' } }, turn)
          events.onEvent({ ts: Date.now(), kind: 'tool', text: 'grep', data: { phase: 'started', args: 'foo' } }, turn)
        }, 15)
        finishFirstTurn = () => {
          events.onEvent({ ts: Date.now(), kind: 'final', text: '首轮结束' }, turn)
          events.onTurnEnd({ ok: true, response: '首轮结束' }, turn)
        }
        return {
          sessionId: 'sess_doom',
          turnScoped: true,
          async send(content, stamp, opts) {
            doomSends.push({ content, thinking: opts?.thinking })
            setTimeout(() => {
              events.onEvent({ ts: Date.now(), kind: 'final', text: '升档后完成' }, stamp)
              events.onTurnEnd({ ok: true, response: '升档后完成' }, stamp)
            }, 15)
          },
          async stop() {},
          async close() {}
        }
      }
    }
    const permRequests = []
    const dRunner = new TaskRunner(dStore, new Map([['doom-fake', doomBackend]]), () => ({ concurrency: 2, mode: 'yolo', notify: false, doomLoopThreshold: 2 }), undefined, {
      send: (ch, payload) => { if (ch === 'task:permission') permRequests.push(payload) }
    })
    dRunner.attachTeam(() => [{ id: 'ag_auto', name: 'Auto', backend: 'doom-fake', thinking: 'auto', color: '#06b6d4' }])
    // 挂一个故意返回 'off' 的分诊器，验证 doom 升档不被静默分诊降回
    dRunner.attachTriage(async () => ({ ok: true, decision: { level: 'off', reason: '想降档', source: 'triage', via: 'preset-http', durationMs: 1 } }))
    const dTask = dStore.create({ title: 'doom-test', prompt: 'run', workdir: '', backend: 'doom-fake', agentId: 'ag_auto', goalId: 'goal_d1', thinking: 'low', thinkingSource: 'triage' })
    dRunner.enqueue(dTask)
    ok(await until(() => permRequests.length === 1, 5000), 'Doom Loop 触发人工审批请求')
    const req = permRequests[0].request
    dRunner.resolvePermission(req.requestId, 'allow', 'allow', req.requestToken)
    ok(await until(() => dStore.get(dTask.id)?.thinking === 'medium', 3000), 'Doom Loop 人工放行后任务自动升档 low→medium')
    ok(dStore.get(dTask.id)?.thinkingSource === 'escalation', 'Doom Loop 升档落盘 thinkingSource="escalation"')
    finishFirstTurn()
    ok(await until(() => dStore.get(dTask.id)?.status === 'done', 3000), 'Doom Loop 放行后首轮完成')
    const afterDoom = await dRunner.followUp(dTask.id, '继续排查')
    ok(afterDoom.ok && doomSends[0]?.thinking === 'medium', 'Doom Loop 升档在下回合生效且不被静默分诊降回')
    await dRunner.shutdown()
  }

  console.log(failures === 0 ? '\n✅ DYNAMIC THINKING SMOKE PASSED' : `\n❌ DYNAMIC THINKING SMOKE FAILED (${failures})`)
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}
process.exit(failures === 0 ? 0 : 1)
