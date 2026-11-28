// Antigravity CLI (agy) 适配器确定性离线冒烟（假 CLI 垫片注入临时 PATH，零网络/零密钥依赖）：
// 覆盖：resolveAgy/probe、agy models 解析、--input-format stream-json 走 stdin（含 46K 超长载荷）、
// --model 与 --effort 冲突规避、init/step_update(tool+text)/result 映射、重复 ACTIVE 去重、
// --resume 跨轮不重复累计 usage、BackendTurnStamp 隔离、ERROR 终态与 stop 进程树终止。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-agy-smoke-'))
const bundleOut = path.join(root, 'out', 'smoke-agy.cjs')
await build({
  entryPoints: [path.join(root, 'src/main/backends/agy.ts')],
  outfile: bundleOut,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  logLevel: 'silent'
})
const {
  createAgyBackend,
  listAgyModels,
  parseAgyModelsOutput,
  hasExplicitEffort
} = await import(pathToFileURL(bundleOut).href)

let failures = 0
const ok = (cond, label) => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`)
  if (!cond) failures++
}

// === 1. 纯函数断言 ===
console.log('纯函数校验：')
const parsedModels = parseAgyModelsOutput([
  'Fetching available models...',
  'gemini-4-neon-high\tGemini 4 Neon (High)',
  'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'gemini-4-neon-high\tGemini 4 Neon (High)',
  '',
  'Note: ignored line'
].join('\n'))
ok(
  parsedModels.length === 2 && parsedModels[0] === 'gemini-4-neon-high' && parsedModels[1] === 'gemini-3.8-flash-low',
  'parseAgyModelsOutput 提取去重模型 slug 并忽略提示行'
)
ok(hasExplicitEffort('gemini-3.8-flash-low') === true, 'hasExplicitEffort 识别 -low 后缀')
ok(hasExplicitEffort('Gemini 4 Neon (XHigh)') === true, 'hasExplicitEffort 识别 (XHigh) 后缀')
ok(hasExplicitEffort('gemini-4-neon') === false, 'hasExplicitEffort 放行无档位基名')

// === 2. 构造假 agy CLI 垫片（走与 npm 全局安装一致的 .cmd / bin 布局） ===
const fakeBinDir = path.join(tmpRoot, 'bin')
const fakePkgDir = path.join(fakeBinDir, 'node_modules', 'fake-agy')
fs.mkdirSync(fakePkgDir, { recursive: true })
const fakeScript = path.join(fakePkgDir, 'cli.js')
fs.writeFileSync(fakeScript, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
if (args.includes('--version')) {
  process.stdout.write('1.5.18\\n')
  process.exit(0)
}
if (args[0] === 'models') {
  process.stderr.write('Fetching available models...\\n')
  process.stdout.write('gemini-4-neon-high\\tGemini 4 Neon (High)\\ngemini-3.8-flash-low\\tGemini 3.8 Flash (Low)\\n')
  process.exit(0)
}
let rawStdin = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => { rawStdin += c })
process.stdin.on('end', () => {
  const line = rawStdin.trim().split(/\\r?\\n/).filter(Boolean)[0] || ''
  let msg = null
  try { msg = JSON.parse(line) } catch {}
  const content = msg && msg.message && typeof msg.message.content === 'string' ? msg.message.content : ''
  const logFile = process.env.FAKE_AGY_LOG
  if (logFile) {
    const addDirIdx = args.indexOf('--add-dir')
    const addDir = addDirIdx >= 0 ? args[addDirIdx + 1] : null
    let mcpConfig = null
    let hostRule = null
    if (addDir) {
      try { mcpConfig = JSON.parse(fs.readFileSync(addDir + '/.agents/mcp_config.json', 'utf8')) } catch {}
      try { hostRule = fs.readFileSync(addDir + '/.agents/rules/agentdeck-host.md', 'utf8') } catch {}
    }
    fs.appendFileSync(logFile, JSON.stringify({ args, event: msg && msg.event, contentLen: content.length, contentHead: content.slice(0, 24), addDir, mcpConfig, hostRule }) + '\\n')
  }
  const resumeIdx = args.indexOf('--resume')
  const resumed = resumeIdx >= 0 ? args[resumeIdx + 1] : ''
  const modelIdx = args.indexOf('--model')
  const model = modelIdx >= 0 ? args[modelIdx + 1] : 'gemini-4-neon-high'
  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n')

  if (content.startsWith('TRIGGER_ERROR')) {
    emit({
      event: 'result',
      result: {
        conversation_id: '',
        status: 'ERROR',
        response: '',
        error: 'invalid model selection (--model "bad" --effort ""): model bad is not recognized as a known model',
        duration_seconds: 0,
        num_turns: 0,
        usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 }
      }
    })
    process.exit(1)
  }

  if (content.startsWith('HANG_FOREVER')) {
    emit({ event: 'init', conversation_id: 'conv-hang-1', init: { model, cwd: process.cwd() } })
    setInterval(() => {}, 1000)
    return
  }

  const cid = resumed || 'conv-smoke-001'
  emit({ event: 'init', conversation_id: cid, init: { model, cwd: process.cwd() } })
  if (!resumed) {
    emit({ event: 'step_update', step_update: { conversation_id: cid, step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: '先查文件 <delegate to="Codex">ok</delegate>' } })
    emit({ event: 'step_update', step_update: { conversation_id: cid, step_index: 1, state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 1000, output_tokens: 40, thinking_tokens: 5, cache_read_tokens: 200, total_tokens: 1040 } } })
    const editParams = { file_path: 'src/demo.ts', old_string: 'const a = 1', new_string: 'const a = 2\\nconst b = 3' }
    emit({ event: 'step_update', step_update: { conversation_id: cid, step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'edit_file', tool_info: { name: 'edit_file', parameters: editParams } } })
    emit({ event: 'step_update', step_update: { conversation_id: cid, step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'edit_file', tool_info: { name: 'edit_file', parameters: editParams } } })
    emit({ event: 'step_update', step_update: { conversation_id: cid, step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'edit_file', duration_seconds: 0.125, tool_info: { name: 'edit_file', parameters: editParams, output: 'edited' } } })
    emit({ event: 'step_update', step_update: { conversation_id: cid, step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'pineapple' } })
    emit({ event: 'step_update', step_update: { conversation_id: cid, step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: '\\n', usage: { input_tokens: 200, output_tokens: 10, thinking_tokens: 0, cache_read_tokens: 100, total_tokens: 210 } } })
    emit({
      event: 'result',
      result: {
        conversation_id: cid,
        status: 'SUCCESS',
        response: 'pineapple\\n',
        duration_seconds: 1.5,
        num_turns: 1,
        usage: { input_tokens: 1200, output_tokens: 50, thinking_tokens: 5, cache_read_tokens: 300, total_tokens: 1250 }
      }
    })
  } else {
    emit({ event: 'step_update', step_update: { conversation_id: cid, step_index: 4, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'mango' } })
    emit({ event: 'step_update', step_update: { conversation_id: cid, step_index: 4, state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 300, output_tokens: 20, thinking_tokens: 0, cache_read_tokens: 500, total_tokens: 320 } } })
    emit({
      event: 'result',
      result: {
        conversation_id: cid,
        status: 'SUCCESS',
        response: 'mango\\n',
        duration_seconds: 40.2,
        num_turns: 2,
        usage: { input_tokens: 1500, output_tokens: 70, thinking_tokens: 5, cache_read_tokens: 800, total_tokens: 1570 }
      }
    })
  }
  process.exit(0)
})
`, 'utf8')

if (process.platform === 'win32') {
  fs.writeFileSync(path.join(fakeBinDir, 'agy.cmd'), `@ECHO OFF\r\nnode "%~dp0\\node_modules\\fake-agy\\cli.js" %*\r\n`, 'utf8')
} else {
  const shim = path.join(fakeBinDir, 'agy')
  fs.writeFileSync(shim, `#!/bin/sh\nexec node "${fakeScript}" "$@"\n`, { mode: 0o755 })
}

const origPath = process.env.PATH
const origFallback = process.env.AGENTDECK_AGY_DISABLE_FALLBACK
const logFile = path.join(tmpRoot, 'invocations.jsonl')
process.env.FAKE_AGY_LOG = logFile
process.env.PATH = `${fakeBinDir}${path.delimiter}${origPath ?? ''}`

const readLogs = () => fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))

try {
  const backend = createAgyBackend()
  console.log('探测与模型目录：')
  ok(backend.id === 'agy' && backend.label === 'Antigravity' && backend.supportsResume === true, 'backend 元数据与 supportsResume=true')
  const probe = await backend.probe()
  ok(probe.ok && probe.detail === 'agy 1.5.18', `probe 识别版本号 (${probe.detail})`)
  const catalog = await listAgyModels()
  ok(catalog.models.length === 2 && catalog.models[0] === 'gemini-4-neon-high', 'listAgyModels 在线解析模型列表')

  console.log('首轮 + 续聊 + 超长 stdin + 防重复计费：')
  const recorded = []
  const turnEnds = []
  const sessionIds = []
  let heartbeats = 0
  const turn1 = { seq: 1, id: 'turn-1' }
  const turn2 = { seq: 2, id: 'turn-2' }
  const hugePrompt = 'HEAD_' + 'x'.repeat(46_100)
  const session = await backend.start({
    prompt: hugePrompt,
    workdir: tmpRoot,
    mode: 'yolo',
    model: 'gemini-4-neon',
    thinking: 'max',
    turn: turn1,
    events: {
      onEvent: (e, t) => recorded.push({ e, t }),
      onHeartbeat: (t) => { if (t?.id) heartbeats++ },
      onSessionId: (sid, t) => sessionIds.push({ sid, t }),
      onTurnEnd: (r, t) => turnEnds.push({ r, t })
    }
  })

  ok(session.sessionId === 'conv-smoke-001' && session.turnScoped === true, '返回 conversation_id 且声明 turnScoped=true')
  ok(sessionIds.length === 1 && sessionIds[0].sid === 'conv-smoke-001' && sessionIds[0].t?.id === 'turn-1', 'onSessionId 首帧上报且绑定 turn-1')
  ok(heartbeats > 0, `onHeartbeat 持续续命 (${heartbeats} 次)`)

  const toolStarts = recorded.filter((x) => x.e.kind === 'tool' && x.e.data?.phase === 'started')
  const toolResults = recorded.filter((x) => x.e.kind === 'tool' && x.e.data?.phase === 'result')
  ok(toolStarts.length === 1, '重复 ACTIVE 工具步骤去重，只发 1 次 started')
  ok(toolResults.length === 1 && toolResults[0].e.data?.ok === true && toolResults[0].e.data?.durationMs === 125, '工具 result 携带 ok 与 durationMs')
  ok(toolResults[0].e.data?.edit?.file === 'src/demo.ts' && toolResults[0].e.data?.edit?.additions === 2 && toolResults[0].e.data?.edit?.deletions === 1, 'edit_file 解析出 edit-meta (+2 -1)')

  const usage1 = recorded.find((x) => x.e.kind === 'usage' && x.t?.id === 'turn-1')?.e.data
  ok(usage1?.inputTokens === 1200 && usage1?.outputTokens === 50 && usage1?.totalTokens === 1250, '首轮 usage 按 DONE 步骤汇总 (1200/50/1250)')
  ok(turnEnds[0]?.r.delegationText?.includes('<delegate to="Codex">') && turnEnds[0]?.r.response === 'pineapple\n', 'delegationText 保留中间发言，response 取最终回复')

  // 续聊第二轮：验证 --resume 与单轮增量 usage（不是累计 1570！）
  await session.send('follow up', turn2)
  const usage2 = recorded.find((x) => x.e.kind === 'usage' && x.t?.id === 'turn-2')?.e.data
  ok(usage2?.inputTokens === 300 && usage2?.outputTokens === 20 && usage2?.totalTokens === 320, '续聊 usage 只计本轮增量 (320)，不把累计 1570 重复入账')
  ok(turnEnds[1]?.t?.id === 'turn-2' && turnEnds[1]?.r.response === 'mango\n', '续聊 onTurnEnd 绑定 turn-2 并返回新回复')
  await session.close()

  const logs = readLogs()
  ok(logs[0].event === 'user' && logs[0].contentLen === hugePrompt.length, '46K 超长 prompt 通过 stdin NDJSON 完整送达')
  ok(logs[0].args.includes('--model') && logs[0].args.includes('gemini-4-neon') && logs[0].args.includes('--effort') && logs[0].args.includes('xhigh'), '基名模型 + max 思考映射到 --effort xhigh')
  ok(!logs[0].args.includes('--add-dir'), '未传 systemPrompt/mcpEndpoint 时不挂载多余 --add-dir')
  ok(logs[1].args.includes('--resume') && logs[1].args.includes('conv-smoke-001'), '续聊透传 --resume <conversation_id>')

  console.log('MCP + 原生系统规则（--add-dir overlay）注入与清理：')
  ok(backend.systemPromptMode === 'native' && backend.delegationTransport === 'mcp', 'agy 声明 systemPromptMode=native + delegationTransport=mcp')
  const mcpSession = await backend.start({
    prompt: 'mcp turn 1',
    workdir: tmpRoot,
    mode: 'yolo',
    systemPrompt: '你是运行在 AgentDeck 平台中的领队。',
    mcpEndpoint: { serverName: 'agentdeck', url: 'http://127.0.0.1:43210/mcp', token: 'tok_agy_secret' },
    events: { onEvent: () => {}, onTurnEnd: () => {} }
  })
  await mcpSession.send('mcp turn 2')
  await mcpSession.close()
  const allLogsAfterMcp = readLogs()
  const mcpLog1 = allLogsAfterMcp[allLogsAfterMcp.length - 2]
  const mcpLog2 = allLogsAfterMcp[allLogsAfterMcp.length - 1]
  const srv1 = mcpLog1?.mcpConfig?.mcpServers?.agentdeck
  const srv2 = mcpLog2?.mcpConfig?.mcpServers?.agentdeck
  ok(
    !!mcpLog1?.addDir
    && srv1?.serverUrl === 'http://127.0.0.1:43210/mcp'
    && srv1?.headers?.Authorization === 'Bearer tok_agy_secret'
    && srv1?.tools?.agentdeck_context?.eager === true
    && srv1?.tools?.agentdeck_dispatch_worker?.eager === true,
    '首轮通过 --add-dir 注入 .agents/mcp_config.json（serverUrl + Bearer + eager 工具）'
  )
  ok(
    typeof mcpLog1?.hostRule === 'string'
    && mcpLog1.hostRule.includes('trigger: always_on')
    && mcpLog1.hostRule.includes('AgentDeck 平台中的领队'),
    '首轮注入 .agents/rules/agentdeck-host.md（always_on 原生规则）'
  )
  ok(
    !!mcpLog2?.addDir
    && mcpLog2.addDir !== mcpLog1.addDir
    && srv2?.serverUrl === 'http://127.0.0.1:43210/mcp'
    && typeof mcpLog2?.hostRule === 'string' && mcpLog2.hostRule.includes('trigger: always_on'),
    '续聊 --resume 回合同样注入独立 overlay（MCP 配置 + always_on 规则）'
  )
  ok(!fs.existsSync(mcpLog1.addDir) && !fs.existsSync(mcpLog2.addDir), '回合退出后自动清理临时 overlay 目录，零残留')

  console.log('自带档位后缀模型冲突规避 + 错误与中止：')
  const conflictSession = await backend.start({
    prompt: 'check conflict',
    workdir: tmpRoot,
    mode: 'yolo',
    model: 'gemini-3.8-flash-low',
    thinking: 'high',
    events: { onEvent: () => {}, onTurnEnd: () => {} }
  })
  await conflictSession.close()
  const conflictLog = readLogs().at(-1)
  ok(conflictLog.args.includes('gemini-3.8-flash-low') && !conflictLog.args.includes('--effort'), '模型名已含 -low 时省略 --effort 避免冲突报错')

  let errMsg = ''
  try {
    await backend.start({
      prompt: 'TRIGGER_ERROR',
      workdir: tmpRoot,
      mode: 'yolo',
      events: { onEvent: () => {}, onTurnEnd: () => {} }
    })
  } catch (e) {
    errMsg = e instanceof Error ? e.message : String(e)
  }
  ok(errMsg.includes('invalid model selection'), `ERROR 终态原样抛出可读错误 (${errMsg.slice(0, 40)})`)

  // 启动后立刻取消挂死进程
  let launchHandle = null
  const hangPromise = backend.start({
    prompt: 'HANG_FOREVER',
    workdir: tmpRoot,
    mode: 'yolo',
    events: {
      onLaunch: (h) => { launchHandle = h },
      onEvent: (e) => { if (e.kind === 'status') void launchHandle?.stop() },
      onTurnEnd: () => {}
    }
  }).then(() => ({ ok: true }), (e) => ({ ok: false, error: String(e) }))
  const hangRes = await Promise.race([
    hangPromise,
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 5000))
  ])
  ok(!hangRes.timeout && hangRes.ok === false, 'onLaunch.stop 能在回合完成前干净终止挂死子进程')

  // 缺 CLI 时优雅降级
  process.env.PATH = ''
  process.env.AGENTDECK_AGY_DISABLE_FALLBACK = '1'
  const missingProbe = await backend.probe()
  const missingModels = await listAgyModels()
  ok(!missingProbe.ok && missingModels.models.length === 0, '未安装 agy 时 probe 返回 offline 且模型目录为空')
} finally {
  process.env.PATH = origPath
  if (origFallback === undefined) delete process.env.AGENTDECK_AGY_DISABLE_FALLBACK
  else process.env.AGENTDECK_AGY_DISABLE_FALLBACK = origFallback
  delete process.env.FAKE_AGY_LOG
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}

if (failures) {
  console.error(`\n❌ AGY SMOKE FAILED (${failures})`)
  process.exit(1)
}
console.log('\n✅ AGY SMOKE PASSED')
