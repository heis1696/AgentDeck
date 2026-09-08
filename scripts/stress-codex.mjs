// codex 并发压力测试：阶梯拉起 N 个并发 `codex exec`，测账号实际能扛多少同时请求、
// 429 从哪一档开始出现、单请求延迟如何随并发劣化。
// 用法：node scripts/stress-codex.mjs [阶梯]   阶梯默认 1,2,4,8；命中 429 自动停止爬坡。
// 每档说明：同时发起 N 个请求（同一账号/密钥），prompt 极小，测的是并发配额不是吞吐。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const levels = (process.argv[2] ?? '1,2,4,8').split(',').map((n) => Math.max(1, Number(n) | 0)).filter(Boolean)
const PER_REQUEST_TIMEOUT_MS = 180_000
const PROMPT = 'Reply with exactly: OK'
const RATE_LIMIT_RE = /429|too many requests|rate.?limit|exceeded retry/i

const run1 = () => new Promise((resolve) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-stress-'))
  // shell:true 下 spawn 不做参数引用，prompt 必须整体加引号拼进单条命令（否则按空格切词报 unexpected argument）
  const cmd = 'codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox "Reply with exactly: OK"'
  const t0 = Date.now()
  const child = spawn(cmd, { cwd: dir, shell: process.platform === 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  let done = false
  const finish = (result) => {
    if (done) return
    done = true
    clearTimeout(timer)
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
    resolve({ ms: Date.now() - t0, ...result })
  }
  const timer = setTimeout(() => {
    try { child.pid && process.platform === 'win32'
      ? spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      : child.kill('SIGKILL') } catch {}
    finish({ ok: false, kind: 'timeout' })
  }, PER_REQUEST_TIMEOUT_MS)
  child.stdout.on('data', (c) => { out += c })
  child.stderr.on('data', (c) => { err += c })
  child.on('error', (e) => finish({ ok: false, kind: 'spawn', detail: String(e) }))
  child.on('exit', (code) => {
    const text = out + err
    if (RATE_LIMIT_RE.test(text)) return finish({ ok: false, kind: '429' })
    if (code !== 0) return finish({ ok: false, kind: `exit${code}`, detail: (err || out).slice(-200) })
    finish({ ok: true, kind: 'ok' })
  })
})

const fmtMs = (ms) => ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`

console.log(`codex 并发压测：阶梯 ${levels.join(' → ')}，每档同时发起 N 个请求\n`)
let stopped = false
for (const n of levels) {
  if (stopped) break
  process.stdout.write(`── 并发 ${n}：`)
  const results = await Promise.all(Array.from({ length: n }, () => run1()))
  const ok = results.filter((r) => r.ok)
  const r429 = results.filter((r) => r.kind === '429')
  const other = results.filter((r) => !r.ok && r.kind !== '429')
  const lat = ok.map((r) => r.ms)
  const stat = lat.length
    ? `ok 延迟 min/avg/max = ${fmtMs(Math.min(...lat))}/${fmtMs(Math.round(lat.reduce((a, b) => a + b, 0) / lat.length))}/${fmtMs(Math.max(...lat))}`
    : ''
  console.log(`ok ${ok.length}/${n}，429 ${r429.length}，其他失败 ${other.length} ${stat}`)
  for (const r of other) console.log(`   ✕ ${r.kind}${r.detail ? '：' + r.detail.split('\n')[0] : ''}`)
  if (r429.length) {
    stopped = true
    console.log(`   ⚠ 并发 ${n} 出现 429（退出码非 0 且命中限流文案）——已到账号并发阈值，停止爬坡`)
  }
}
console.log(stopped ? '\n结论：见上（首个出现 429 的前一档即可稳定并发）' : '\n结论：全部档位无 429，可用更高阶梯再测（node scripts/stress-codex.mjs 8,16,32）')
process.exit(0)
