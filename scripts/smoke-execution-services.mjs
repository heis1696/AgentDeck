import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
await build({ entryPoints: [path.join(root, 'src/main/executor.ts'), path.join(root, 'src/main/retry-policy.ts')], outdir: path.join(root, 'out', 'execution-services'), bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
const executorModule = await import(pathToFileURL(path.join(root, 'out', 'execution-services', 'executor.js')).href)
const retryModule = await import(pathToFileURL(path.join(root, 'out', 'execution-services', 'retry-policy.js')).href)
const { Executor } = executorModule.default ?? executorModule
const { decideRetry } = retryModule.default ?? retryModule

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
  console.log(`  OK ${message}`)
}

const retry = decideRetry({ attempt: 0, sessionId: 'session-1', backend: 'codex' }, { code: 'rate_limit', title: 'Rate limited', hint: '', retryable: true })
assert(retry.retry && retry.attempt === 1 && !retry.freshSession, 'first rate-limit retry resumes the captured session')
assert(decideRetry({ attempt: 1, sessionId: 'session-1', backend: 'codex' }, { code: 'timeout', title: 'Timeout', hint: '', retryable: true }).freshSession, 'second retry starts a fresh session')
assert(!decideRetry({ attempt: 0, backend: 'codex' }, { code: 'provider_auth', title: 'Auth', hint: '', retryable: false }).retry, 'non-retryable failures stop')

let lateClosed = false
let accept = true
const executor = new Executor()
const starting = new Promise((resolve) => setTimeout(() => resolve({ sessionId: 'late', send: async () => {}, stop: async () => {}, close: async () => { lateClosed = true } }), 30))
const timeout = new Promise((resolve) => setTimeout(() => { accept = false; resolve({ ok: false, response: '', error: 'timeout' }) }, 5))
try { await executor.start(() => starting, timeout, () => accept) } catch {}
await new Promise((resolve) => setTimeout(resolve, 50))
assert(lateClosed, 'late session is closed after the start race is abandoned')

console.log('\nEXECUTION SERVICES SMOKE PASSED')
