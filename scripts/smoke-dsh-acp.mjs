// dsh ACP 适配器冒烟：fake ACP server（NDJSON JSON-RPC）驱动，不依赖真实 dsh/API key。
// 覆盖：握手/建会话、agent_message_chunk→text 事件流、多回合续聊、
// request_permission→onPermission 桥接、session/cancel 取消、close 杀进程、
// 启动期失败抛 AcpBootError（供 headless 回退）、思考强度→AGENTDECK_DSH_* env 参数化；
// 凭证代差桥接（~/.dsh 凭证被 0.2.x 迁成 version-1 结构时同步老格式投影）：文档判定、
// 投影同步幂等、ACP 组合与 headless --patch 改指、key 不进子进程环境。
import { build } from 'esbuild'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-dsh-acp-'))
// 凭证桥接的缺省判定读 $DSH_HOME/.credentials.yaml：指到空目录，开发机的真实凭证不进冒烟；
// 「key 不进子进程环境」的断言也不得被开发机自己导出的 key 误伤
process.env.DSH_HOME = path.join(tmp, 'dsh-home-empty')
delete process.env.DEEPSEEK_API_KEY
const outfile = path.join(root, 'out', 'smoke-dsh-acp.cjs')
await build({ entryPoints: [path.join(root, 'src/main/backends/dsh-acp.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
const { startDshAcpSession, AcpBootError } = await import(pathToFileURL(outfile).href)
const backendOutfile = path.join(root, 'out', 'smoke-dsh-backend.cjs')
await build({ entryPoints: [path.join(root, 'src/main/backends/dsh.ts')], outfile: backendOutfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
const { createDshBackend } = await import(pathToFileURL(backendOutfile).href)

// ---- fake ACP server ----
const fakeServer = path.join(tmp, 'fake-acp.mjs')
fs.writeFileSync(fakeServer, `
import fs from 'node:fs'
let sessionCount = 0
let turnCount = 0
const permissionLog = []
let permissionWaiter = null
let pendingPrompt = null
let buf = ''
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
const update = (sid, text) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } })
const finishPrompt = (msg, text) => {
  turnCount++
  update(msg.params.sessionId, '第一段')
  update(msg.params.sessionId, 'chunk2-' + turnCount + (text.includes('HANG') ? '' : ''))
  send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
  pendingPrompt = null
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => {
  buf += c
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
    if (!line) continue
    const msg = JSON.parse(line)
    if (msg.method === 'initialize') {
      // 思考强度 env 探针：落盘 initialize 时所见（agentdeck 传入的组合 env）
      try { fs.writeFileSync(process.argv[3] + '.envlog', JSON.stringify({ thinking: process.env.AGENTDECK_DSH_THINKING ?? null, effort: process.env.AGENTDECK_DSH_EFFORT ?? null, apiKey: process.env.DEEPSEEK_API_KEY ?? null })) } catch {}
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'fake-acp' }, agentCapabilities: {} } })
    }
    else if (msg.method === 'session/new') { sessionCount++; send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'fake-sess-' + sessionCount } }) }
    else if (msg.method === 'session/prompt') {
      const text = (msg.params.prompt ?? []).map((b) => b.text).join('')
      if (text.includes('HANG')) { pendingPrompt = msg; return } // 挂住等 cancel
      if (text.includes('PERMISSION')) {
        pendingPrompt = msg
        send({ jsonrpc: '2.0', id: 9001, method: 'session/request_permission', params: { sessionId: msg.params.sessionId, toolCall: { toolCallId: 'call-1' }, options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }] } })
        permissionWaiter = () => finishPrompt(msg, text)
        return
      }
      finishPrompt(msg, text)
    }
    else if (msg.method === 'session/cancel') {
      if (pendingPrompt) { const p = pendingPrompt; pendingPrompt = null; send({ jsonrpc: '2.0', id: p.id, result: { stopReason: 'cancelled' } }) }
    }
    else if (msg.id === 9001 && !msg.method) { permissionLog.push(msg.result); try { fs.writeFileSync(process.argv[3] + '.permlog', JSON.stringify(permissionLog)) } catch {} const w = permissionWaiter; permissionWaiter = null; w?.() }
  }
})
// 权限选择日志：收到即写（taskkill /F 强杀不跑 exit 钩子）
`)
const permissionLogPath = path.join(tmp, 'examples', 'acp-agent', 'agentdeck.cordis.yml.permlog')
const compositionPath = path.join(tmp, 'examples', 'acp-agent', 'agentdeck.cordis.yml')
const envLogPath = path.join(tmp, 'examples', 'acp-agent', 'agentdeck.cordis.yml.envlog')

const events = []
const heartbeats = { n: 0 }
const turnEnds = []
const permissions = []
let launchHandle = null
const recorder = {
  onEvent: (e) => events.push(e),
  onHeartbeat: () => { heartbeats.n++ },
  onTurnEnd: (r) => turnEnds.push(r),
  onPermission: async (req) => { permissions.push(req); return { decision: 'allow', optionId: 'allow-once' } },
  onLaunch: (h) => { launchHandle = h },
  onSessionId: () => {}
}

const assert = (cond, msg) => {
  if (!cond) {
    console.error('❌ ASSERT FAIL:', msg)
    process.exit(1)
  }
  console.log('  ✓', msg)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- 1) 正常路径：握手 + 首回合 + 事件流 ----
const session = await startDshAcpSession({
  prompt: '你好',
  workdir: tmp,
  mode: 'yolo',
  events: recorder,
  acp: { node: process.execPath, bin: fakeServer, repoRoot: tmp }
})
assert(session.sessionId === 'fake-sess-1', 'session/new 返回 sessionId（fake-sess-1）')
assert(launchHandle && typeof launchHandle.stop === 'function', '启动即注册停止句柄（启动窗口期可取消）')
const texts1 = events.filter((e) => e.kind === 'text').map((e) => e.text)
assert(JSON.stringify(texts1) === JSON.stringify(['第一段', 'chunk2-1']), `agent_message_chunk 逐条转 text 事件 (${texts1.join('|')})`)
assert(events.some((e) => e.kind === 'final' && e.text === 'chunk2-1'), 'final 事件 = 最后一条 committed 消息')
assert(turnEnds.at(-1)?.ok && turnEnds.at(-1)?.response === 'chunk2-1', '首回合 onTurnEnd ok')
assert(heartbeats.n >= 2, '每条协议通知都触发心跳（看门狗续命）')

// ---- 2) 续聊：同 session 第二回合 ----
events.length = 0
await session.send('再次提问')
const texts2 = events.filter((e) => e.kind === 'text').map((e) => e.text)
assert(texts2.length === 2 && texts2[1] === 'chunk2-2', `send() 同会话续聊生效 (${texts2.join('|')})`)

// ---- 3) 权限桥接：request_permission → onPermission → 选择回传 ----
events.length = 0
const permTurn = session.send('PERMISSION 场景').then(() => 'resolved').catch((e) => 'rejected:' + e.message)
await wait(300)
assert(permissions.length === 1, 'session/request_permission 路由到 onPermission')
assert(permissions[0].options.length === 2 && permissions[0].options[0].optionId === 'allow-once', '权限选项映射（allow-once/reject-once）')
const permResult = await permTurn
assert(permResult === 'resolved', `权限回合在放行后正常完成 (${permResult})`)

// ---- 4) stop：session/cancel → cancelled 终态 ----
const hangTurn = session.send('HANG 场景').then(() => 'resolved').catch((e) => 'rejected:' + e.message)
await wait(200)
await session.stop()
const hangResult = await hangTurn
assert(hangResult.startsWith('rejected'), `挂起回合被取消后按失败收场 (${hangResult})`)
assert((turnEnds.at(-1)?.error ?? '').includes('取消'), '取消回合 onTurnEnd 带取消语义')

// ---- 5) close：进程被杀 ----
await session.close()
await wait(300)
// 进程树已杀：再 send 立即以进程退出收场（不再永悬）
const afterClose = await session.send('不应到达').then(() => 'resolved').catch((e) => 'rejected:' + String(e.message).slice(0, 40))
assert(afterClose.startsWith('rejected'), `会话关闭后 send 立即失败 (${afterClose})`)

// ---- 6) 启动期失败 → AcpBootError（headless 回退依据） ----
const crashServer = path.join(tmp, 'crash-acp.mjs')
fs.writeFileSync(crashServer, 'process.exit(3)\n')
let bootError = null
try {
  await startDshAcpSession({
    prompt: 'x', workdir: tmp, mode: 'yolo',
    events: { onEvent: () => {}, onHeartbeat: () => {}, onTurnEnd: () => {} },
    acp: { node: process.execPath, bin: crashServer, repoRoot: tmp }
  })
} catch (e) { bootError = e }
assert(bootError instanceof AcpBootError && /code=3/.test(bootError.message), `进程早退抛 AcpBootError (${bootError?.message?.slice(0, 60)})`)

// ---- 7) 服务端收到的权限选择 ----
const permLog = JSON.parse(fs.readFileSync(permissionLogPath, 'utf8'))
assert(JSON.stringify(permLog) === JSON.stringify([{ outcome: { outcome: 'selected', optionId: 'allow-once' } }]), '权限选择按 ACP outcome 格式回传服务端')

// ---- 7.5) 组合模板参数化：llm-deepseek 思考档位经 !!js 读 AGENTDECK_DSH_* env ----
const composition = fs.readFileSync(compositionPath, 'utf8')
assert(composition.includes(`thinking: !!js "process.env.AGENTDECK_DSH_THINKING ?? 'enabled'"`), '组合模板 thinking 行参数化（默认 enabled）')
assert(composition.includes(`reasoningEffort: !!js "process.env.AGENTDECK_DSH_EFFORT ?? 'max'"`), '组合模板 reasoningEffort 行参数化（默认 max）')

// ---- 7.6) 思考强度 → AGENTDECK_DSH_* env 注入（fake server 在 initialize 落盘所见 env） ----
const bootWithThinking = async (thinking) => {
  const s = await startDshAcpSession({
    prompt: 'thinking probe', workdir: tmp, mode: 'yolo', ...(thinking ? { thinking } : {}),
    events: { onEvent: () => {}, onHeartbeat: () => {}, onTurnEnd: () => {} },
    acp: { node: process.execPath, bin: fakeServer, repoRoot: tmp }
  })
  const seen = JSON.parse(fs.readFileSync(envLogPath, 'utf8'))
  await s.close()
  return seen
}
const seenDefault = JSON.stringify({ thinking: null, effort: null, apiKey: null })
assert(JSON.stringify(await bootWithThinking(undefined)) === seenDefault, 'thinking 未设：不注入 env（模板默认 enabled/max）')
assert(JSON.stringify(await bootWithThinking('off')) === JSON.stringify({ thinking: 'disabled', effort: null, apiKey: null }), 'thinking=off：AGENTDECK_DSH_THINKING=disabled（不注 effort）')
assert(JSON.stringify(await bootWithThinking('low')) === JSON.stringify({ thinking: 'enabled', effort: 'low', apiKey: null }), 'thinking=low：enabled + AGENTDECK_DSH_EFFORT=low')

// ---- 8) Production composition: dsh.ts must not bind ACP twice to turn #1 ----
const fakeRepo = path.join(tmp, 'deepseek-harness')
const productionBin = path.join(fakeRepo, 'packages', 'examples', 'acp-demo', 'lib', 'bin.js')
fs.mkdirSync(path.dirname(productionBin), { recursive: true })
fs.copyFileSync(fakeServer, productionBin)
const productionEvents = []
const productionTurns = []
const dsh = createDshBackend(() => ({ dshPath: path.join(fakeRepo, 'apps', 'cli', 'lib', 'bin.js') }))
const turn1 = { seq: 1, id: 'dsh-production-turn-1' }
const turn2 = { seq: 2, id: 'dsh-production-turn-2' }
const productionSession = await dsh.start({
  prompt: 'production first', workdir: tmp, mode: 'yolo', turn: turn1,
  events: {
    onEvent: (event, turn) => productionEvents.push({ event, turn }),
    onTurnEnd: (result, turn) => productionTurns.push({ result, turn }),
    onHeartbeat: () => {}, onSessionId: () => {}
  }
})
await productionSession.send('production second', turn2)
assert(productionSession.turnScoped === true, 'production DSH ACP declares its proven prompt boundary')
assert(productionTurns[0]?.turn?.id === turn1.id && productionTurns[1]?.turn?.id === turn2.id, 'production DSH ACP reports each terminal with its own stamp')
assert(productionEvents.some((item) => item.event.kind === 'final' && item.turn?.id === turn2.id), 'production second-turn events do not fall back to the first stamp')
await productionSession.close()

// ---- 9) 凭证代差桥接：文档判定 ----
const credentialsOutfile = path.join(root, 'out', 'smoke-dsh-credentials.cjs')
await build({ entryPoints: [path.join(root, 'src/main/backends/dsh-credentials.ts')], outfile: credentialsOutfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
const { parseDshCredentialsDocument, syncDshCredentialsBridge, resolveDshCredentialsBridge, dshCredentialsRedirectYaml } = await import(pathToFileURL(credentialsOutfile).href)

const flat = parseDshCredentialsDocument('# 托管文档\nDEEPSEEK_API_KEY: sk-flat  # 行尾注释\nOPENAI_API_KEY: \'it\'\'s\'\n')
assert(!flat.versioned && flat.refs.DEEPSEEK_API_KEY === 'sk-flat' && flat.refs.OPENAI_API_KEY === "it's", '扁平文档（0.1.x 布局）：不桥接，顶层条目即凭证引用（行尾注释与单引号转义）')
const versioned = parseDshCredentialsDocument([
  'version: 1',
  'refs:',
  '  DEEPSEEK_API_KEY: "sk-new"',
  'records:',
  '  client-connection/browser-session:',
  '    kind: grant',
  '    payload:',
  '      version: 1',
  '      DEEPSEEK_API_KEY: nested-not-a-ref',
  ''
].join('\n'))
assert(versioned.versioned && JSON.stringify(versioned.refs) === JSON.stringify({ DEEPSEEK_API_KEY: 'sk-new' }), 'version-1 文档（桌面版迁移后的结构）：必须桥接，只取 refs 直属条目')
const odd = parseDshCredentialsDocument('timeout: 30\nDEEPSEEK_API_KEY: sk-odd\n')
assert(odd.versioned && odd.refs.DEEPSEEK_API_KEY === 'sk-odd' && !('timeout' in odd.refs), '扁平文档混入数字条目（老插件同样读不了）：桥接，非字符串条目不进投影')

// ---- 9.1) 投影同步：扁平布局 / 幂等 / 被迁移后仍判已同步 / 轮换 / 清空 ----
const bridgeDir = path.join(tmp, 'bridge')
const bridge = syncDshCredentialsBridge(versioned.refs, bridgeDir)
const readProjection = () => parseDshCredentialsDocument(fs.readFileSync(bridge.documentPath, 'utf8'))
const projectionText = fs.readFileSync(bridge.documentPath, 'utf8')
assert(!/^refs:|^records:/m.test(projectionText) && readProjection().refs.DEEPSEEK_API_KEY === 'sk-new', '投影是 0.1.x 可读的扁平布局，值原样还原')
const patchText = fs.readFileSync(bridge.patchPath, 'utf8')
assert(patchText.includes("- id: credentials\n  name: '@deepseek-ai/dsh-credentials-local'\n  config:\n    path: \"" + bridge.documentPath.replace(/\\/g, '/') + "\"\n    watch: false"), 'headless 覆盖层：credentials 行改指投影')
const mtime = () => fs.statSync(bridge.documentPath).mtimeMs
const writtenAt = mtime()
await wait(30)
syncDshCredentialsBridge(versioned.refs, bridgeDir)
assert(mtime() === writtenAt, '同步幂等：引用没变不重写投影')
// 0.2.x 的 dsh 若读到这份扁平投影会把它原地迁成 version-1：值没变，照样算已同步
fs.writeFileSync(bridge.documentPath, 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: "sk-new"\n')
const migratedAt = mtime()
await wait(30)
syncDshCredentialsBridge(versioned.refs, bridgeDir)
assert(mtime() === migratedAt, '投影被迁成 version-1 后值不变：不反复重写')
syncDshCredentialsBridge({ DEEPSEEK_API_KEY: 'sk-rotated' }, bridgeDir)
assert(readProjection().refs.DEEPSEEK_API_KEY === 'sk-rotated', 'key 轮换：投影跟着重写')
const emptied = syncDshCredentialsBridge({}, bridgeDir)
assert(!fs.existsSync(emptied.documentPath) && fs.existsSync(emptied.patchPath), '引用清空：投影删除（不残留已移除的 key），覆盖层保留')
assert(dshCredentialsRedirectYaml('  ', "C:\\o'dd\\p.yaml") === '  config:\n    path: "C:/o\'dd/p.yaml"\n    watch: false\n', 'config 行：path 归一为正斜杠，缩进随调用方（ACP 组合与覆盖层共用）')

// ---- 9.2) 判定：缺失 / 老格式不干预，新格式桥接到注入目录 ----
const dshHome = path.join(tmp, 'dsh-home')
const resolveAt = () => resolveDshCredentialsBridge({ dshHome, dir: path.join(tmp, 'bridge-resolve') })
assert(resolveAt() === null, '凭证文档不存在：不干预')
fs.mkdirSync(dshHome, { recursive: true })
fs.writeFileSync(path.join(dshHome, '.credentials.yaml'), 'DEEPSEEK_API_KEY: sk-flat\n')
assert(resolveAt() === null, '老格式凭证文档：不干预（dsh 自己读 ~/.dsh）')
fs.writeFileSync(path.join(dshHome, '.credentials.yaml'), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: "sk-new"\n')
const resolved = resolveAt()
assert(resolved?.documentPath === path.join(tmp, 'bridge-resolve', 'dsh-credentials.yaml'), '新格式凭证文档：桥接，投影落在注入的目录')

// ---- 9.3) ACP 组合：桥接 → credentials 行指向投影；不桥接 → 无重定向；两种情况 key 都不进子进程环境 ----
const compositionFor = async (credentials) => {
  const s = await startDshAcpSession({
    prompt: 'credentials probe', workdir: tmp, mode: 'yolo', credentials,
    events: { onEvent: () => {}, onHeartbeat: () => {}, onTurnEnd: () => {} },
    acp: { node: process.execPath, bin: fakeServer, repoRoot: tmp }
  })
  const text = fs.readFileSync(compositionPath, 'utf8')
  const env = JSON.parse(fs.readFileSync(envLogPath, 'utf8'))
  await s.close()
  return { text, env }
}
const bridged = await compositionFor(resolved)
const redirect = '  config:\n    path: "' + resolved.documentPath.replace(/\\/g, '/') + "\"\n    watch: false\n"
assert(bridged.text.includes("name: '@deepseek-ai/dsh-credentials-local'\n" + redirect + '\n- id: sandbox'), '桥接：ACP 组合的 credentials 行 config 指向投影（列表项内缩进，条目间空行保留）')
assert(bridged.env.apiKey === null, '桥接只改 path：key 不进子进程环境（dsh 的托管文档不落 process.env）')
const legacy = await compositionFor(null)
assert(legacy.text === bridged.text.replace(redirect, ''), '不桥接：ACP 组合与桥接版只差插入的 config 块（默认路径文本不变）')
assert(!bridged.text.includes('__AGENTDECK_DSH_CREDENTIALS_CONFIG__') && !legacy.text.includes('__AGENTDECK_DSH_CREDENTIALS_CONFIG__'), '占位标记两种情况下都被替换干净')
const auto = await compositionFor(undefined)
assert(!auto.text.includes('dsh-credentials.yaml'), '缺省判定：$DSH_HOME 下没有凭证文档 → 不桥接')

// ---- 9.4) headless 回退：桥接 → --patch 覆盖层进 argv；不桥接 → argv 与桥接前逐项一致 ----
// 假仓库只带一个启动即退的 ACP 组件：dshPath 派生根最先匹配，任何机器上都确定走 headless 回退。
// 假 CLI 把 argv 打成一行合法 JSON——顺带钉住「回复恰是合法 JSON 行不得被 JSONL 解析吞掉」
const headlessRepo = path.join(tmp, 'deepseek-harness')
fs.mkdirSync(path.join(headlessRepo, 'packages', 'examples', 'acp-demo', 'lib'), { recursive: true })
fs.copyFileSync(crashServer, path.join(headlessRepo, 'packages', 'examples', 'acp-demo', 'lib', 'bin.js'))
const fakeCli = path.join(headlessRepo, 'apps', 'cli', 'lib', 'bin.js')
fs.mkdirSync(path.dirname(fakeCli), { recursive: true })
fs.writeFileSync(fakeCli, 'console.log(JSON.stringify(process.argv.slice(2)))\n')
const headlessArgv = async (resolveCredentials) => {
  const ends = []
  const s = await createDshBackend(() => ({ dshPath: fakeCli }), resolveCredentials).start({
    prompt: 'PROMPT', workdir: tmp, mode: 'yolo',
    events: { onEvent: () => {}, onHeartbeat: () => {}, onTurnEnd: (r) => ends.push(r) }
  })
  await s.close()
  assert(ends.at(-1)?.ok, 'headless 回退回合正常收场')
  return JSON.parse(ends.at(-1).response)
}
assert(JSON.stringify(await headlessArgv(() => resolved)) === JSON.stringify(['--profile', 'headless', '--patch', resolved.patchPath, 'PROMPT']), 'headless 桥接：--patch 覆盖层插在 profile 与任务文本之间')
assert(JSON.stringify(await headlessArgv(() => null)) === JSON.stringify(['--profile', 'headless', 'PROMPT']), 'headless 不桥接：argv 与桥接前逐项一致')

console.log('\n✅ DSH ACP SMOKE PASSED')
