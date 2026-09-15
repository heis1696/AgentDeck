// 冒烟：zcode adapter 的回合终态裁决
// [1] 0.16.x 服务端的 turn.terminal 事实形状（payload 无 response/usage）必须被识别，
//     否则回合在 send 侧挂到上限、任务卡在 running（生产实测：标题回合挂 30 分钟+）
// [2] send 请求的 ack 丢失时，回合上限必须能裁决并上抛——不许永久悬挂
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

const root = path.resolve(import.meta.dirname, '..')

// send-ack-hang 场景依赖回合上限兜底：缩到 700ms（send 内部读取，运行时生效）
process.env.AGENTDECK_TURN_CAP_MS = '700'

const outfile = path.join(root, 'out', 'smoke-zcode-protocol.cjs')
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

const fixture = path.join(root, 'scripts', 'fixtures', 'fake-zcode-app-server.mjs')
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-zproto-'))
const assert = (cond, msg) => {
  if (!cond) {
    console.error('❌ ASSERT FAIL:', msg)
    process.exit(1)
  }
  console.log('  ✓', msg)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- [1] 新终态形状 ----
console.log('[1] turn.terminal 事实形状（0.16.x，无 response/usage 字段）...')
{
  process.env.FAKE_SCENARIO = 'terminal-new-shape'
  const backend = createZcodeBackend(() => ({ nodePath: process.execPath, zcodePath: fixture }))
  const events = []
  let session
  const turnEnd = new Promise((resolve) => {
    let done = false
    backend.start({
      prompt: 'hi',
      workdir,
      mode: 'yolo',
      events: {
        onEvent: (e) => events.push(e),
        onTurnEnd: (r) => { if (!done) { done = true; resolve(r) } }
      }
    }).then((s) => { session = s }).catch((e) => { if (!done) { done = true; resolve({ ok: false, error: String(e) }) } })
  })
  const r = await Promise.race([turnEnd, wait(5000).then(() => ({ ok: false, error: 'first-turn timeout' }))])
  assert(r.ok, `首回合以新形状收尾 (got ${JSON.stringify(r).slice(0, 120)})`)
  assert((r.response ?? '').includes('仿真回复文本'), '终态 response 取流式累计文本')
  assert(events.some((e) => e.kind === 'usage' && e.data?.tokenCount === 42), 'usage 从 tokenCount 派生')
  assert(typeof session?.send === 'function', '会话已建立')
  await session.send('第二轮')
  assert(true, '第二回合（同形状）正常返回，不再挂到回合上限')
  await session.close()
}

// ---- [2] ack 丢失 → 回合上限裁决上抛 ----
console.log('[2] send 请求 ack 丢失（响应帧丢失）...')
{
  process.env.FAKE_SCENARIO = 'send-ack-hang'
  const backend = createZcodeBackend(() => ({ nodePath: process.execPath, zcodePath: fixture }))
  let session
  const turnEnd = new Promise((resolve) => {
    let done = false
    backend.start({
      prompt: 'hi',
      workdir,
      mode: 'yolo',
      events: {
        onEvent: () => {},
        onTurnEnd: (r) => { if (!done) { done = true; resolve(r) } }
      }
    }).then((s) => { session = s }).catch((e) => { if (!done) { done = true; resolve({ ok: false, error: String(e) }) } })
  })
  const r = await Promise.race([turnEnd, wait(5000).then(() => ({ ok: false, error: 'first-turn timeout' }))])
  assert(r.ok, '首回合正常收尾')
  const started = Date.now()
  let failed = null
  try {
    await Promise.race([
      session.send('这回合的 ack 永远不来'),
      wait(8000).then(() => { throw new Error('send 悬挂超过 8s（旧实现会永久悬挂）') })
    ])
  } catch (e) {
    failed = e
  }
  assert(!!failed, `send 以失败收场（${Math.round(Date.now() - started)}ms）`)
  assert(/超时/.test(String(failed?.message ?? '')), `失败原因是回合上限裁决 (got ${String(failed?.message).slice(0, 60)})`)
  await session.close()
}

console.log('✅ SMOKE PASSED')
