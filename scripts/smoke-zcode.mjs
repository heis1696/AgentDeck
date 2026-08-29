// 冒烟测试：不经 GUI 直接验证 zcode adapter 全链路
// 用 esbuild 把 adapter 打成 CJS 再跑（adapter 是纯 Node 代码，无 electron 依赖）
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

const root = path.resolve(import.meta.dirname, '..')
const outfile = path.join(root, 'out', 'smoke-zcode.cjs')

await build({
  entryPoints: [path.join(root, 'src/main/backends/zcode.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['electron']
})

const mod = await import(pathToFileURL(outfile).href)
const { createZcodeBackend } = mod

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-smoke-'))
const backend = createZcodeBackend(() => ({ nodePath: process.execPath, zcodePath: '' }))

console.log('[1] probe...')
const probe = await backend.probe()
console.log('   ', probe)
if (!probe.ok) {
  console.error('PROBE FAILED — 先确认 ZCode 已登录且 cli config 已生成')
  process.exit(1)
}

console.log('[2] start + first turn...')
const events = []
const turnEnd = new Promise((resolve) => {
  let resolved = false
  backend
    .start({
      prompt: '只回复两个字:好的',
      workdir,
      mode: 'yolo',
      events: {
        onEvent: (e) => {
          events.push(e)
          if (e.kind === 'text' || e.kind === 'usage') process.stdout.write(`    [${e.kind}] ${JSON.stringify(e.text ?? (e.data && (e.data.totalTokens ?? e.data.tokenCount)) ?? '').slice(0, 80)}\n`)
        },
        onTurnEnd: (r) => {
          if (!resolved) { resolved = true; resolve(r) }
        }
      }
    })
    .then((s) => {
      console.log('    sessionId:', s.sessionId)
      globalThis.__session = s
    })
    .catch((e) => {
      if (!resolved) { resolved = true; resolve({ ok: false, response: '', error: String(e) }) }
    })
})

const timeout = new Promise((r) => setTimeout(() => r({ ok: false, response: '', error: 'timeout 120s' }), 120000))
const r = await Promise.race([turnEnd, timeout])
console.log('[3] turn end:', JSON.stringify(r).slice(0, 300))

if (globalThis.__session) {
  console.log('[4] closing session...')
  await globalThis.__session.close()
}

const textEvents = events.filter((e) => e.kind === 'text').map((e) => e.text).join('')
console.log('[5] aggregated text:', JSON.stringify(textEvents))
console.log('[6] event count:', events.length)

if (r.ok && textEvents.includes('好的')) {
  console.log('✅ SMOKE PASSED')
  process.exit(0)
} else {
  console.log('❌ SMOKE FAILED')
  process.exit(1)
}
