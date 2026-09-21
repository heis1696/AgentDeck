// dsh ACP 适配器冒烟：fake ACP server（NDJSON JSON-RPC）驱动，不依赖真实 dsh/API key。
// 覆盖：握手/建会话、agent_message_chunk→text 事件流、多回合续聊、
// request_permission→onPermission 桥接、session/cancel 取消、close 杀进程、
// 启动期失败抛 AcpBootError（供 headless 回退）。
import { build } from 'esbuild'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-dsh-acp-'))
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
    if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'fake-acp' }, agentCapabilities: {} } })
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

console.log('\n✅ DSH ACP SMOKE PASSED')
