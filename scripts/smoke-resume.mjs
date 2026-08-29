// resume 测试：会话 A 问一个问题 → 关闭连接 → 新连接 resume → 追问
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const outfile = path.join(root, 'out', 'resume-adapter.cjs')
await build({
  entryPoints: [path.join(root, 'src/main/backends/zcode.ts')],
  outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['electron']
})
const { createZcodeBackend } = await import(pathToFileURL(outfile).href)
const backend = createZcodeBackend(() => ({ nodePath: '', zcodePath: '' }))

function runTurn(prompt, resumeSessionId) {
  return new Promise((resolve, reject) => {
    let session
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    const timer = setTimeout(() => done({ error: 'timeout 90s' }), 90000)
    backend.start({
      prompt,
      workdir: path.join(root, 'tmp-tool-test'),
      mode: 'yolo',
      resumeSessionId,
      events: {
        onEvent: () => {},
        onTurnEnd: (r) => {
          clearTimeout(timer)
          done({ r, session })
        }
      }
    }).then((s) => { session = s }).catch((e) => { clearTimeout(timer); done({ error: String(e) }) })
  })
}

console.log('[1] 第一回合（新会话）')
const r1 = await runTurn('记住暗号：紫色河马。只回复:记住了', undefined)
if (r1.error) { console.error('FAIL:', r1.error); process.exit(1) }
console.log('    sessionId:', r1.session.sessionId, '→', JSON.stringify(r1.r.response).slice(0, 60))
console.log('[2] 关闭连接')
await r1.session.close()

console.log('[3] 新连接 resume 同一会话，追问暗号')
const r2 = await runTurn('暗号是什么？只回复暗号本身', r1.session.sessionId)
if (r2.error) { console.error('FAIL:', r2.error); process.exit(1) }
console.log('    回复:', JSON.stringify(r2.r.response).slice(0, 100))

const ok = /紫色|河马/.test(r2.r.response)
console.log('[4] 清理')
await r2.session.close().catch(() => {})
console.log(ok ? '✅ RESUME PASSED（会话上下文保留）' : '❌ RESUME FAILED（上下文丢失？回复见上）')
process.exit(ok ? 0 : 1)
