// 冒烟测试：zcode 终态「完整回合回复」去重（final 只保留最后一条 assistant 消息）
// 用假 app-server 模拟协议时序，不发真实请求：
//   回合内 text(回复一) → tool → text(回复二) → 终态 response=完整回合回复
// 断言：final 事件与 onTurnEnd.response 都只含「回复二」
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

const root = path.resolve(import.meta.dirname, '..')

// ---- 假 zcode app-server：stdin 收 JSONL 请求，stdout 按脚本回放事件 ----
const serverScript = path.join(os.tmpdir(), `fake-zcode-server-${Date.now()}.mjs`)
fs.writeFileSync(serverScript, `
import readline from 'node:readline'
const rl = readline.createInterface({ input: process.stdin })
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n')
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line) } catch { return }
  if (msg.id !== undefined && msg.method) {
    const results = {
      'session/create': { session: { sessionId: 'fake-s1' } },
      'session/subscribe': {},
      'session/send': {},
      'session/stop': {},
      'session/close': {}
    }
    send({ id: msg.id, result: results[msg.method] ?? {} })
    if (msg.method === 'session/send') replay()
  }
})
function replay() {
  const event = (type, payload) => send({ method: 'session/event', params: { type, payload } })
  event('model.streaming', { kind: 'text_delta', delta: '第一段中间回复。' })
  event('model.streaming', { kind: 'tool_input_start', toolCallId: 't1', toolName: 'Bash' })
  event('tool.updated', { kind: 'started', toolCallId: 't1', toolName: 'Bash' })
  event('tool.updated', { kind: 'result', toolCallId: 't1', toolName: 'Bash', result: { success: true, content: 'ok' } })
  event('model.streaming', { kind: 'text_delta', delta: '第二段最终汇报。' })
  // 终态：response 为完整回合回复（两条消息拼接），usage 附带
  event('turn.completed', { response: '第一段中间回复。\\n\\n第二段最终汇报。', usage: { tokenCount: 100 }, resultType: 'success' })
}
`)

// ---- 打包真实 adapter 并驱动 ----
const outfile = path.join(root, 'out', 'smoke-final-dedup.cjs')
await build({
  entryPoints: [path.join(root, 'src/main/backends/zcode.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['electron']
})
const { createZcodeBackend } = await import(pathToFileURL(outfile).href)

const backend = createZcodeBackend(() => ({ nodePath: process.execPath, zcodePath: serverScript }))
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-dedup-'))
const events = []
let sessionHolder = null
const turnEnd = new Promise((resolve) => {
  let settled = false
  backend.start({
    prompt: '测试',
    workdir,
    mode: 'yolo',
    events: {
      onEvent: (e) => events.push(e),
      onTurnEnd: (r) => { if (!settled) { settled = true; resolve(r) } }
    }
  }).then((s) => { sessionHolder = s }).catch((e) => { if (!settled) { settled = true; resolve({ ok: false, response: '', error: String(e) }) } })
})

const r = await Promise.race([
  turnEnd,
  new Promise((res) => setTimeout(() => res({ ok: false, error: '超时：假服务器未触发终态' }), 15000))
])

let failed = 0
const check = (name, cond, detail) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : ` (got ${JSON.stringify(detail)})`}`)
  if (!cond) failed++
}

const finalEvent = events.find((e) => e.kind === 'final')
check('回合 ok', r.ok === true, r)
check('终态只含最后一条消息', r.response === '第二段最终汇报。', r.response)
check('final 事件只含最后一条消息', finalEvent?.text === '第二段最终汇报。', finalEvent?.text)
check('中间回复仍随 text 事件流式展示', events.filter((e) => e.kind === 'text').map((e) => e.text).join('') === '第一段中间回复。第二段最终汇报。', events.filter((e) => e.kind === 'text'))

try { await sessionHolder?.close() } catch {}
try { fs.rmSync(serverScript) } catch {}
try { fs.rmSync(workdir, { recursive: true, force: true }) } catch {}
if (failed) {
  console.error(`✗ FINAL-DEDUP SMOKE FAILED (${failed})`)
  process.exit(1)
}
console.log('✅ FINAL-DEDUP SMOKE PASSED')
process.exit(0)
