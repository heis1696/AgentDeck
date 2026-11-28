// MCP 委派与平台认知专项冒烟（纯本地、不调外部模型 API）：
// 覆盖：Streamable HTTP 握手/鉴权/DELETE 保活、动态 tools/list 与角色隔离、
// 同步拒单回合内自纠、正文 XML 零误触、超长报告分页 agentdeck_read_report、
// agentdeck_submit_review / agentdeck_record_round / agentdeck_handoff_phase、
// 常驻会话 followUp Token 闲置拒绝与重绑、逃生开关 AGENTDECK_DELEGATION_TRANSPORT=prompt、
// 权限自动放行与 Host Framing 渲染卫生。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const bundleDir = path.join(root, 'out', 'smoke-mcp-delegation')
fs.mkdirSync(bundleDir, { recursive: true })
const bundle = async (source, name) => {
  const outfile = path.join(bundleDir, name)
  await build({
    entryPoints: [path.join(root, source)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['electron'],
    logLevel: 'silent'
  })
  return import(pathToFileURL(outfile).href)
}

const [{ TaskStore }, { TaskRunner }, mcpMod, promptsMod, { createClaudeBackend }, { createCodexBackend }, { createZcodeBackend }] = await Promise.all([
  bundle('src/main/store.ts', 'store.cjs'),
  bundle('src/main/runner.ts', 'runner.cjs'),
  bundle('src/main/mcp-delegation-server.ts', 'mcp-server.cjs'),
  bundle('src/main/prompts/index.ts', 'prompts.cjs'),
  bundle('src/main/backends/claude.ts', 'claude.cjs'),
  bundle('src/main/backends/codex.ts', 'codex.cjs'),
  bundle('src/main/backends/zcode.ts', 'zcode.cjs')
])

let failures = 0
const check = (cond, label) => {
  console.log(`  ${cond ? 'OK' : 'FAIL'} ${label}`)
  if (!cond) failures++
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForStatus(store, taskId, statuses, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const task = store.get(taskId)
    if (task && statuses.includes(task.status)) return task
    await wait(30)
  }
  throw new Error(`timeout waiting for ${taskId} to reach ${statuses.join('/')}, current=${store.get(taskId)?.status}`)
}

async function mcpPost(endpoint, body, tokenOverride) {
  const res = await fetch(endpoint.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(tokenOverride === null ? {} : { Authorization: `Bearer ${tokenOverride ?? endpoint.token}` })
    },
    body: JSON.stringify(body)
  })
  const text = await res.text()
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null }
}

async function mcpCall(endpoint, name, args = {}, id = 10) {
  const res = await mcpPost(endpoint, {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args }
  })
  const rawText = res.json?.result?.content?.[0]?.text
  return {
    httpStatus: res.status,
    isError: res.json?.result?.isError === true,
    payload: rawText ? JSON.parse(rawText) : res.json
  }
}

// ================= 1. 后端能力声明与工具识别 =================
console.log('1. 后端能力声明与内部工具识别：')
{
  const claude = createClaudeBackend()
  const codex = createCodexBackend()
  const zcode = createZcodeBackend(() => ({ nodePath: '', zcodePath: '' }))
  check(claude.systemPromptMode === 'native' && claude.delegationTransport === 'mcp', 'claude 声明 systemPromptMode=native + delegationTransport=mcp')
  check(codex.systemPromptMode === 'native' && codex.delegationTransport === 'mcp', 'codex 声明 systemPromptMode=native + delegationTransport=mcp')
  check(zcode.systemPromptMode === 'fallback' && zcode.delegationTransport === 'mcp', 'zcode 声明 systemPromptMode=fallback + delegationTransport=mcp')
  check(mcpMod.isAgentDeckMcpToolName('agentdeck_dispatch_worker'), '裸内部工具名识别')
  check(mcpMod.isAgentDeckMcpToolName('mcp__agentdeck__agentdeck_dispatch_worker'), 'Claude 前缀内部工具名识别')
  check(mcpMod.isAgentDeckMcpToolName('agentdeck:agentdeck_context'), '冒号前缀内部工具名识别')
  check(!mcpMod.isAgentDeckMcpToolName('Bash') && !mcpMod.isAgentDeckMcpToolName('mcp__github__list_issues'), '普通外部工具不误判为内部工具')
}

// ================= 2. Host Framing 与 MCP 文案渲染卫生 =================
console.log('2. Host Framing 与 MCP 文案卫生：')
{
  const lead = { id: 'ag_l', name: 'Lead', backend: 'claude', role: '领队', systemPrompt: '你是架构领队。', subordinates: ['ag_w1', 'ag_w2'] }
  const w1 = { id: 'ag_w1', name: 'Worker1', backend: 'codex', role: '后端工程师', note: '擅长状态机' }
  const w2 = { id: 'ag_w2', name: 'Worker2', backend: 'zcode', role: '审码员', sharedWorkspace: true }
  const peer = { id: 'ag_p', name: 'PeerCap', backend: 'claude', role: '队长', subordinates: [] }
  const team = [lead, w1, w2, peer]

  const framing = promptsMod.buildHostFraming({
    agent: lead, team, roleKind: 'leader', workspaceKind: 'main-workspace', transport: 'mcp', canHandoff: true, maxRounds: 6
  })
  check(framing.includes('AgentDeck') && framing.includes('原生工具') && framing.includes('agentdeck_context'), 'Host Framing 明确平台定位、原生能力分工与抗压缩自查工具')
  check(framing.includes('agentdeck_dispatch_worker') && framing.includes('Worker1') && framing.includes('PeerCap'), 'Host Framing MCP 段含队员与咨询队长')
  check(!framing.includes('<delegate') && !framing.includes('<continue'), 'MCP 模式 Host Framing 零 XML 协议标记')

  const mcpBlock = promptsMod.buildMcpDelegationBlock(lead, team)
  check(mcpBlock.includes('agentdeck_dispatch_worker') && mcpBlock.includes('agentdeck_consult_captain') && !mcpBlock.includes('<delegate'), 'MCP 派发块零 XML 标记')
  check(!promptsMod.MCP_CONTINUE_BLOCK.includes('<continue') && promptsMod.MCP_CONTINUE_BLOCK.includes('agentdeck_handoff_phase'), 'MCP 接力块零 XML 标记')
  const anchor = promptsMod.buildTurnAnchor({ agentName: 'Lead', roleLabel: '领队', transport: 'mcp', remainingRounds: 4, subordinates: [w1, w2], activeReportSeqs: [1, 2] })
  check(anchor.includes('【AgentDeck 状态锚点】') && anchor.includes('剩余委派轮数：4') && anchor.includes('#1、#2'), '防压缩状态锚点格式完整')
  const fb = promptsMod.buildMcpReportFeedback('### 队员 Worker1 的结果（done，单号 #1）\nok', '', { anchor })
  check(fb.startsWith(promptsMod.REPORT_PROMPT_HEADER) && fb.includes('agentdeck_submit_review') && !fb.includes('<review of=') && fb.endsWith(anchor), 'MCP 回灌报告头/审核工具指引/尾部锚点齐备')
}

// ================= 3. 端到端 MCP 委派闭环（协议握手 + 同步拒单自纠 + 分页读报告 + 审核 + 评估 + 接力 + 常驻重绑） =================
console.log('3. 端到端 MCP 委派闭环：')
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-mcp-smoke-'))
  const store = new TaskStore(tmpDir)
  const leadAgent = { id: 'ag_lead', name: 'Lead', backend: 'mcpfake', role: '领队', systemPrompt: '你是技术领队。', subordinates: ['ag_w1', 'ag_w2'] }
  const w1Agent = { id: 'ag_w1', name: 'Worker1', backend: 'workerfake', role: '开发工程师', note: '主攻后端' }
  const w2Agent = { id: 'ag_w2', name: 'Worker2', backend: 'workerfake', role: '只读审码', sharedWorkspace: true }
  const peerAgent = { id: 'ag_peer', name: 'PeerCap', backend: 'workerfake', role: '队长', subordinates: [] }
  const team = [leadAgent, w1Agent, w2Agent, peerAgent]

  const reviewsApplied = []
  const handoffsCreated = []
  const longWorkerReport = `长报告开头：完成重构。\n${'细节行-0123456789\n'.repeat(180)}长报告结尾：全部验收通过。`
  const captured = {
    firstSystemPrompt: '',
    firstUserPrompt: '',
    firstEndpoint: null,
    round2Feedback: '',
    turnCount: 0,
    followUpContextOk: false,
    idleCallRejected: false,
    proseXmlIgnored: false
  }

  const mcpLeaderBackend = {
    id: 'mcpfake',
    label: 'McpFake',
    supportsResume: true,
    systemPromptMode: 'native',
    delegationTransport: 'mcp',
    async probe() { return { ok: true, detail: 'mcpfake' } },
    async start({ prompt, systemPrompt, mcpEndpoint, events, turn }) {
      captured.firstSystemPrompt = systemPrompt ?? ''
      captured.firstUserPrompt = prompt
      captured.firstEndpoint = mcpEndpoint ?? null

      // 验证 HTTP 方法/鉴权/握手/通知/DELETE 行为
      const getRes = await fetch(mcpEndpoint.url, { method: 'GET' })
      check(getRes.status === 405, 'GET /mcp 返回 405 Method Not Allowed')
      const noAuth = await mcpPost(mcpEndpoint, { jsonrpc: '2.0', id: 1, method: 'ping' }, null)
      check(noAuth.status === 401, '无 Bearer Token 返回 401')
      const badAuth = await mcpPost(mcpEndpoint, { jsonrpc: '2.0', id: 1, method: 'ping' }, 'wrong-token')
      check(badAuth.status === 401, '错误 Bearer Token 返回 401')

      const initRes = await mcpPost(mcpEndpoint, {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'smoke', version: '1.0' } }
      })
      check(initRes.status === 200 && initRes.json.result.protocolVersion === '2026-07-28', 'initialize 协商返回 protocolVersion=2026-07-28')
      check(initRes.json.result.instructions.includes('AgentDeck') && initRes.json.result.instructions.includes('你是技术领队'), 'initialize.instructions 携带平台认知与人设')

      const notifRes = await mcpPost(mcpEndpoint, { jsonrpc: '2.0', method: 'notifications/initialized' })
      check(notifRes.status === 202, 'notifications/initialized 返回 202 Accepted')

      // 模拟一次性 CLI 单回合后发 DELETE：不提前吊销同一 Run 的 Token
      const delRes = await fetch(mcpEndpoint.url, { method: 'DELETE', headers: { Authorization: `Bearer ${mcpEndpoint.token}` } })
      check(delRes.status === 200, 'DELETE /mcp 返回 200 且保活当前 Run Token')

      const list1 = await mcpPost(mcpEndpoint, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
      const names1 = list1.json.result.tools.map((t) => t.name)
      const dispatchSchema = list1.json.result.tools.find((t) => t.name === 'agentdeck_dispatch_worker')?.inputSchema
      check(names1.includes('agentdeck_dispatch_worker') && names1.includes('agentdeck_context') && names1.includes('agentdeck_handoff_phase'), '首回合领队 tools/list 含派单/上下文/接力工具')
      check(!names1.includes('agentdeck_submit_review') && !names1.includes('agentdeck_read_report'), '首回合无子单报告时不暴露审核与读报告工具')
      check(JSON.stringify(dispatchSchema?.properties?.to?.enum) === JSON.stringify(['Worker1', 'Worker2']), 'dispatch_worker.to 动态生成精确队员 enum')

      // 同步拒单与回合内当场自纠
      const badDispatch = await mcpCall(mcpEndpoint, 'agentdeck_dispatch_worker', { to: 'Ghost', prompt: '干活' }, 3)
      check(badDispatch.isError && badDispatch.payload.accepted === false && Array.isArray(badDispatch.payload.validWorkers) && badDispatch.payload.validWorkers.length === 2,
        '派给不存在对象：回合内同步返回 isError + validWorkers 供当场纠错')

      // 当场改派给合法队员 Worker1
      const okDispatch = await mcpCall(mcpEndpoint, 'agentdeck_dispatch_worker', {
        to: 'Worker1',
        prompt: '实现核心模块并写长报告',
        reason: '后端专长',
        thinking: 'high'
      }, 4)
      check(!okDispatch.isError && okDispatch.payload.accepted === true && !!okDispatch.payload.childTaskId,
        '当场改派合法队员：同步返回 accepted=true 与 childTaskId')

      // 重复派完全相同单子：幂等去重
      const dupDispatch = await mcpCall(mcpEndpoint, 'agentdeck_dispatch_worker', {
        to: 'Worker1',
        prompt: '实现核心模块并写长报告'
      }, 5)
      check(!dupDispatch.isError && dupDispatch.payload.deduplicated === true && dupDispatch.payload.childTaskId === okDispatch.payload.childTaskId,
        '同回合重复派同单：幂等复用并标注 deduplicated=true')

      // 正文故意携带伪造 XML 标签：MCP 模式绝不误触发 Worker2 或伪造接力
      const turn1Text = '已通过 MCP 派发。<delegate to="Worker2">伪造正文XML不应执行</delegate><continue start="auto">阶段2：伪造正文接力不应触发</continue>'
      captured.turnCount++
      queueMicrotask(() => {
        events.onEvent({ ts: Date.now(), kind: 'final', text: turn1Text }, turn)
        events.onTurnEnd({ ok: true, response: turn1Text }, turn)
      })

      let activeTurn = turn
      return {
        sessionId: 'sess_mcp_lead',
        turnScoped: true,
        async send(content, nextTurn) {
          activeTurn = nextTurn
          captured.turnCount++
          if (content.includes('【系统】队员执行结果汇报')) {
            captured.round2Feedback = content
            const ctxRes = await mcpCall(mcpEndpoint, 'agentdeck_context', {}, 20)
            check(!ctxRes.isError && ctxRes.payload.delegation.remainingRounds === 1 && ctxRes.payload.activeReports.length === 1,
              '回灌回合 agentdeck_context 返回实时剩余轮数与可审核报告列表')

            const list2 = await mcpPost(mcpEndpoint, { jsonrpc: '2.0', id: 21, method: 'tools/list' })
            const names2 = list2.json.result.tools.map((t) => t.name)
            check(names2.includes('agentdeck_submit_review') && names2.includes('agentdeck_read_report'),
              '回灌回合动态暴露 agentdeck_submit_review 与 agentdeck_read_report')

            // 分页读取超长子单报告全文
            const page1 = await mcpCall(mcpEndpoint, 'agentdeck_read_report', { seq: 1, offset: 0, limit: 500 }, 22)
            const page2 = await mcpCall(mcpEndpoint, 'agentdeck_read_report', { seq: 1, offset: page1.payload.nextOffset, limit: 5000 }, 23)
            check(!page1.isError && page1.payload.hasMore === true && page1.payload.content.startsWith('长报告开头'), 'agentdeck_read_report 首页分页正确')
            check(!page2.isError && page2.payload.hasMore === false && page2.payload.content.includes('长报告结尾：全部验收通过'), 'agentdeck_read_report 尾页读到完整全文')

            // 提交审核 + 记录评估 + 登记阶段接力
            const rev = await mcpCall(mcpEndpoint, 'agentdeck_submit_review', { seq: 1, verdict: 'pass', note: '报告完整验收通过' }, 24)
            check(!rev.isError && rev.payload.ok === true && rev.payload.verdict === 'pass', 'agentdeck_submit_review 实时落看板审核')
            const rnd = await mcpCall(mcpEndpoint, 'agentdeck_record_round', { outcome: 'no_action', reason: '全部子单已通过审核' }, 25)
            check(!rnd.isError && rnd.payload.ok === true, 'agentdeck_record_round 记录评估')
            const hand = await mcpCall(mcpEndpoint, 'agentdeck_handoff_phase', { start: 'parked', brief: '阶段2：补齐剩余文档与测试验收' }, 26)
            check(!hand.isError && hand.payload.accepted === true && hand.payload.start === 'parked', 'agentdeck_handoff_phase 登记阶段接力')

            const doneText = '本阶段已全部完成，停在阶段1等待你启动阶段2。'
            queueMicrotask(() => {
              events.onEvent({ ts: Date.now(), kind: 'final', text: doneText }, activeTurn)
              events.onTurnEnd({ ok: true, response: doneText }, activeTurn)
            })
            return
          }
          // followUp 追问回合：验证原 Token 重绑后立刻可用
          const fuCtx = await mcpCall(mcpEndpoint, 'agentdeck_context', {}, 30)
          captured.followUpContextOk = !fuCtx.isError && fuCtx.payload.platform === 'AgentDeck'
          queueMicrotask(() => {
            events.onEvent({ ts: Date.now(), kind: 'final', text: '追问完成' }, activeTurn)
            events.onTurnEnd({ ok: true, response: '追问完成' }, activeTurn)
          })
        },
        async stop() {},
        async close() {}
      }
    }
  }

  const workerBackend = {
    id: 'workerfake',
    label: 'WorkerFake',
    supportsResume: true,
    async probe() { return { ok: true, detail: 'workerfake' } },
    async start({ prompt, events, turn }) {
      queueMicrotask(() => {
        events.onEvent({ ts: Date.now(), kind: 'final', text: longWorkerReport }, turn)
        events.onTurnEnd({ ok: true, response: longWorkerReport }, turn)
      })
      return { sessionId: 'sess_w', turnScoped: true, async send() {}, async stop() {}, async close() {} }
    }
  }

  const runner = new TaskRunner(
    store,
    new Map([['mcpfake', mcpLeaderBackend], ['workerfake', workerBackend]]),
    () => ({ concurrency: 2, workerConcurrency: 2, mode: 'yolo', notify: false, delegateMaxRounds: 2 })
  )
  runner.attachTeam(() => team)
  runner.attachIssueOps({
    reviewStatus: (childId, verdict, note) => { reviewsApplied.push({ childId, verdict, note }) }
  })
  runner.attachContinue((input) => {
    handoffsCreated.push(input)
    return { id: 'handoff_next' }
  })

  // 验证内部 MCP 工具权限自动放行（不进 permissionBroker 挂起）
  const autoPerm = await runner.askPermission('t_any', {
    requestId: 'r1',
    toolName: 'mcp__agentdeck__agentdeck_dispatch_worker',
    reason: 'tool call',
    riskLevel: 'low',
    input: {},
    options: [{ optionId: 'allow-once', name: 'Allow', response: { decision: 'allow' } }]
  })
  check(autoPerm.decision === 'allow' && autoPerm.optionId === 'allow-once', 'runner.askPermission 自动放行 AgentDeck 内部 MCP 工具')

  const leaderTask = store.create({
    title: '领队 MCP 闭环',
    prompt: '完成模块 A 升级',
    workdir: '',
    backend: 'mcpfake',
    agentId: 'ag_lead',
    issueId: 'iss_mcp_1'
  })
  runner.enqueue(leaderTask)
  const finished = await waitForStatus(store, leaderTask.id, ['done', 'failed'])

  check(finished.status === 'done', `领队任务正常完成（status=${finished.status}, error=${finished.error ?? ''}）`)
  check(captured.firstSystemPrompt.includes('AgentDeck') && captured.firstSystemPrompt.includes('原生工具'), '原生 systemPromptMode 后端经 systemPrompt 收到 Host Framing')
  check(!captured.firstUserPrompt.includes('<delegate') && !captured.firstUserPrompt.includes('<continue'), 'MCP 模式首条用户消息无 XML 派发/接力标记墙')
  const children = store.list().filter((t) => t.parentTaskId === leaderTask.id)
  check(children.length === 1 && children[0].agentId === 'ag_w1' && children[0].thinking === 'high', '仅建了合法 MCP 派单 Worker1（thinking=high），正文伪造 XML 零误触')
  check(captured.round2Feedback.includes('agentdeck_submit_review') && captured.round2Feedback.includes('【AgentDeck 状态锚点】') && !captured.round2Feedback.includes('<review of='),
    '回灌消息采用 MCP 模板且带防压缩状态锚点')
  check(reviewsApplied.length === 1 && reviewsApplied[0].verdict === 'pass' && reviewsApplied[0].childId === children[0].id,
    'MCP 审核结论实时生效且未丢失')
  check(handoffsCreated.length === 1 && handoffsCreated[0].start === 'parked' && handoffsCreated[0].brief.includes('阶段2'),
    'MCP 阶段接力生效且未受正文伪造 <continue> 干扰')
  check(captured.turnCount === 2, `仅跑 2 个回合（无冗余拒单回灌回合，实跑 ${captured.turnCount} 轮）`)

  // 闲置期调用原 Token 必须被拒绝
  const idleCall = await mcpCall(captured.firstEndpoint, 'agentdeck_context', {}, 29)
  check(idleCall.isError, '任务终态闲置期拒绝旧 Token 工具调用')

  // 常驻会话 followUp 重绑：复用同一 Token 恢复可用
  const fu = await runner.followUp(leaderTask.id, '再查一次上下文', { collectFinal: true })
  check(fu.ok && captured.followUpContextOk, '常驻会话 followUp 复用原 Token 重绑并成功调 agentdeck_context')

  // ================= 4. 办公室会话边界 + 预算耗尽撤工具 + 逃生开关 =================
  console.log('4. 办公室边界、预算耗尽与逃生开关：')

  // 4a. 办公室会话（普通咨询 vs 会议发言回合动态放行 agentdeck_investigate）
  let officeEndpoint = null
  const officeBackend = {
    id: 'mcpoffice',
    label: 'McpOffice',
    supportsResume: true,
    systemPromptMode: 'native',
    delegationTransport: 'mcp',
    async probe() { return { ok: true, detail: 'mcpoffice' } },
    async start({ mcpEndpoint, events, turn }) {
      officeEndpoint = mcpEndpoint
      const list = await mcpPost(mcpEndpoint, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
      const names = list.json.result.tools.map((t) => t.name)
      check(names.length === 1 && names[0] === 'agentdeck_context', `办公室首回合仅暴露 agentdeck_context（实际：${names.join(',')}）`)
      const badDisp = await mcpCall(mcpEndpoint, 'agentdeck_dispatch_worker', { to: 'Worker1', prompt: '越界' }, 2)
      check(badDisp.isError, '办公室会话直接调 agentdeck_dispatch_worker 被拒')
      queueMicrotask(() => {
        events.onEvent({ ts: Date.now(), kind: 'final', text: '办公室就绪' }, turn)
        events.onTurnEnd({ ok: true, response: '办公室就绪' }, turn)
      })
      return {
        sessionId: 'sess_office',
        turnScoped: true,
        async send(_c, nextTurn) {
          const l = await mcpPost(mcpEndpoint, { jsonrpc: '2.0', id: 3, method: 'tools/list' })
          const ns = l.json.result.tools.map((t) => t.name)
          queueMicrotask(() => {
            events.onEvent({ ts: Date.now(), kind: 'final', text: ns.join(',') }, nextTurn)
            events.onTurnEnd({ ok: true, response: ns.join(',') }, nextTurn)
          })
        },
        async stop() {},
        async close() {}
      }
    }
  }
  const officeRunner = new TaskRunner(
    store,
    new Map([['mcpoffice', officeBackend]]),
    () => ({ concurrency: 2, mode: 'yolo', notify: false })
  )
  officeRunner.attachTeam(() => team)
  officeRunner.attachInvestigate(async () => 'ok')
  const officeTask = store.create({
    title: 'Lead·办公室',
    prompt: '办公室引导',
    workdir: '',
    backend: 'mcpoffice',
    agentId: 'ag_lead',
    suppressIssue: true,
    officeAgentId: 'ag_lead'
  })
  officeRunner.enqueue(officeTask)
  await waitForStatus(store, officeTask.id, ['done', 'failed'])
  const meetingFu = await officeRunner.followUp(officeTask.id, '会议汇报', { collectFinal: true, meetingTurn: true })
  check(meetingFu.ok && (meetingFu.finalText ?? '').includes('agentdeck_investigate') && !(meetingFu.finalText ?? '').includes('agentdeck_dispatch_worker'),
    '办公室会议回合动态暴露 agentdeck_investigate 且绝不暴露 dispatch_worker')
  const consultFu = await officeRunner.followUp(officeTask.id, '咨询请求', { collectFinal: true, meetingTurn: false })
  check(consultFu.ok && !(consultFu.finalText ?? '').includes('agentdeck_investigate'),
    '办公室非会议（咨询）回合自动隐去 agentdeck_investigate')

  // 4b. 逃生开关 AGENTDECK_DELEGATION_TRANSPORT=prompt
  let escapeSawMcp = true
  let escapeSawXml = false
  const escapeBackend = {
    id: 'escapefake',
    label: 'EscapeFake',
    supportsResume: true,
    systemPromptMode: 'native',
    delegationTransport: 'mcp',
    async probe() { return { ok: true, detail: 'escapefake' } },
    async start({ prompt, mcpEndpoint, events, turn }) {
      escapeSawMcp = !!mcpEndpoint
      escapeSawXml = prompt.includes('<delegate')
      queueMicrotask(() => {
        events.onEvent({ ts: Date.now(), kind: 'final', text: 'ok' }, turn)
        events.onTurnEnd({ ok: true, response: 'ok' }, turn)
      })
      return { sessionId: 'sess_esc', turnScoped: true, async send() {}, async stop() {}, async close() {} }
    }
  }
  const prevOverride = process.env.AGENTDECK_DELEGATION_TRANSPORT
  process.env.AGENTDECK_DELEGATION_TRANSPORT = 'prompt'
  const escapeRunner = new TaskRunner(
    store,
    new Map([['escapefake', escapeBackend]]),
    () => ({ concurrency: 2, mode: 'yolo', notify: false })
  )
  escapeRunner.attachTeam(() => team)
  const escTask = store.create({ title: '逃生开关验证', prompt: '测试', workdir: '', backend: 'escapefake', agentId: 'ag_lead' })
  escapeRunner.enqueue(escTask)
  await waitForStatus(store, escTask.id, ['done', 'failed'])
  if (prevOverride === undefined) delete process.env.AGENTDECK_DELEGATION_TRANSPORT
  else process.env.AGENTDECK_DELEGATION_TRANSPORT = prevOverride
  check(!escapeSawMcp && escapeSawXml, 'AGENTDECK_DELEGATION_TRANSPORT=prompt 强制回退 Prompt XML 通道且不注入 mcpEndpoint')

  await runner.shutdown()
  await officeRunner.shutdown()
  await escapeRunner.shutdown()
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

if (failures > 0) {
  console.log(`\n❌ MCP DELEGATION SMOKE FAILED（${failures} 项）`)
  process.exit(1)
}
console.log('\n✅ MCP DELEGATION SMOKE PASSED')
