// OpenCode 适配器（一次性进程模型）
// 无头：opencode run --format json --dangerously-skip-permissions --dir <workdir> <prompt>
// 事件：step_start/tool_use/step_finish/text（sessionID 全程携带）；回合结束 = 进程退出
// 续聊：-s <sessionId>
import type { AgentBackend, BackendSession, BackendSessionEvents } from './types'
import type { TaskEvent } from '../../shared/types'
import { isJsonObject, jsonObject, jsonString, runCliJsonl, toolEvent, killProcessTree } from './cli-common'
import { resolveCli, probeCli, type ResolvedCli } from './cli-locator'
import { createOpencodeServerBackend, OpencodeServerClient, OpencodeServerVersionError, OpencodeServerUnavailableError, type FetchLike } from './opencode-server'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'

interface SidecarState {
  url: string
  child: ChildProcess
  users: number
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()) })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (!port) throw new Error('could not allocate OpenCode server port')
  return port
}

export interface OpencodeBackendOptions {
  serverUrl?: string
  required?: boolean
  cliOnly?: boolean
  skipVersionProbe?: boolean
  fetch?: FetchLike
}

export function createOpencodeBackend(config: OpencodeBackendOptions = {}): AgentBackend {

  const runOnce = (
    prompt: string,
    workdir: string,
    resumeSessionId: string | undefined,
    events: BackendSessionEvents,
    model?: string,
    /** 本会话当前进程句柄落点：stop/close 只杀自己会话的进程，多任务并发不再串杀/漏杀 */
    onSpawn?: (runner: { kill: () => void | Promise<unknown> }) => void
  ): Promise<{ sessionId: string; response: string; ok: boolean; error?: string }> => {
    const emit = (e: Omit<TaskEvent, 'seq' | 'ts'>) => events.onEvent({ ...e, ts: Date.now() })
    const resolved = resolveCli('opencode')
    if (!resolved) return Promise.reject(new Error('PATH 上找不到 opencode'))
    const args = [
      'run',
      '--format', 'json',
      '--dangerously-skip-permissions',
      ...(model ? ['--model', model] : []),
      ...(workdir ? ['--dir', workdir] : []),
      ...(resumeSessionId ? ['-s', resumeSessionId] : []),
      prompt
    ]
    let sessionId = resumeSessionId ?? ''
    let finalText = ''
    /** text part 快照去重：同一 part 的更新只补发增长增量，跨 part 全量发 */
    let textPartId = ''
    let textShown = ''
    let settled = false
    let settle!: (v: { sessionId: string; response: string; ok: boolean; error?: string }) => void
    const done = new Promise<{ sessionId: string; response: string; ok: boolean; error?: string }>((r) => (settle = r))
    const finish = (ok: boolean, response: string, error?: string) => {
      if (settled) return
      settled = true
      // final 只在回合终态发一次；中间文本走 text 事件流式展示
      if (response) emit({ kind: 'final', text: response })
      events.onTurnEnd({ response, ok, error })
      settle({ sessionId, response, ok, error })
    }

    const runner = runCliJsonl({
      command: resolved.command,
      prefixArgs: resolved.prefixArgs,
      args,
      cwd: workdir || process.cwd(),
      onLine: (obj) => {
        if (!isJsonObject(obj)) return
        const j = obj
        events.onHeartbeat?.() // 进程有任何输出即进展（含未映射成事件的行）：看门狗续命
        if (!sessionId && j.sessionID) {
          sessionId = jsonString(j.sessionID)
          events.onSessionId?.(sessionId)
          emit({ kind: 'status', text: `opencode ${sessionId.slice(0, 10)}…` })
        }
        const part = jsonObject(j.part)
        if (j.type === 'tool_use') {
          const stateObject = jsonObject(part.state)
          const state = jsonString(stateObject.status)
          const name = jsonString(part.tool)
          if (state === 'running' || state === 'pending') {
            emit(toolEvent('started', name, { args: jsonString(part.title).slice(0, 200) }))
          } else {
            emit(toolEvent('result', name, { ok: state !== 'error', preview: jsonString(stateObject.output, jsonString(part.title)).slice(0, 300) }))
          }
        } else if (j.type === 'text' && part.text) {
          // 最后一条 text 即最终回复；中间 text 走 text 事件流式展示
          const text = jsonString(part.text)
          finalText = text
          const pid = jsonString(part.id)
          if (pid && pid === textPartId) {
            // 同一 part 的增长快照：只补发增量，避免整段重复成泡
            if (text.length > textShown.length && text.startsWith(textShown)) {
              emit({ kind: 'text', text: text.slice(textShown.length) })
            }
          } else {
            emit({ kind: 'text', text })
            textPartId = pid
          }
          textShown = text
        }
      }
    })
    onSpawn?.(runner)
    events.onLaunch?.({ stop: () => runner.kill() })
    void runner.exited.then((exitInfo) => {
      if (!settled) {
        finish(
          exitInfo.code === 0 && !!finalText,
          finalText,
          exitInfo.code === 0 && !finalText
            ? 'opencode 无文本输出'
            : `opencode 退出 code=${exitInfo.code}${exitInfo.stderrTail ? ': ' + exitInfo.stderrTail.slice(0, 200) : ''}`
        )
      }
    })
    return done
  }

  const cliBackend: AgentBackend = {
    id: 'opencode',
    label: 'OpenCode',
    async probe() {
      const p = await probeCli('opencode')
      return p.ok ? { ok: true, detail: `opencode ${p.version}` } : { ok: false, detail: p.error ?? '未安装' }
    },
    async start({ prompt, workdir, events, resumeSessionId, model }) {
      let own: { kill: () => void } | null = null
      const runTurn = (turnPrompt: string, resumeId?: string) =>
        runOnce(turnPrompt, workdir, resumeId, events, model, (r) => { own = r })
      const r = await runTurn(prompt, resumeSessionId)
      if (!r.ok && r.error) throw new Error(r.error)
      const sid = r.sessionId
      return {
        sessionId: sid,
        async send(content) {
          const res = await runTurn(content, sid)
          if (!res.ok) throw new Error(res.error || '回合失败')
        },
        async stop() {
          await Promise.resolve(own?.kill())
        },
        async close() {
          await Promise.resolve(own?.kill())
        }
      }
    }
  }

  // Server mode is the preferred transport. A user-provided URL avoids a
  // second process; otherwise a local `opencode serve` is started lazily.
  // The old JSONL adapter remains the explicit fallback for unavailable
  // servers, preserving historical Task/Run records and CLI behavior.
  const configuredUrl = (config.serverUrl ?? process.env.AGENTDECK_OPENCODE_SERVER_URL ?? process.env.OPENCODE_SERVER_URL ?? '').trim()
  const required = config.required ?? /^(1|true|required)$/i.test(process.env.AGENTDECK_OPENCODE_SERVER_REQUIRED || '')
  const disabled = config.cliOnly ?? /^(1|true|cli)$/i.test(process.env.AGENTDECK_OPENCODE_CLI_ONLY || '')
  const skipVersionProbe = config.skipVersionProbe ?? /^(1|true)$/i.test(process.env.AGENTDECK_OPENCODE_SERVER_SKIP_VERSION || '')
  let sidecar: SidecarState | undefined
  let sidecarStarting: Promise<SidecarState> | undefined

  const stopSidecar = async () => {
    const current = sidecar
    if (!current) return
    sidecar = undefined
    try { await killProcessTree(current.child) } catch {}
  }
  const startSidecar = async (): Promise<SidecarState> => {
    const resolved: ResolvedCli | null = resolveCli('opencode')
    if (!resolved) throw new OpencodeServerUnavailableError('PATH 上找不到 opencode')
    const port = await freePort()
    const child = spawn(resolved.command, [...resolved.prefixArgs, 'serve', '--port', String(port), '--hostname', '127.0.0.1', '--pure'], {
      cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    })
    child.stdout?.on('data', () => {})
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-1000) })
    const state: SidecarState = { url: `http://127.0.0.1:${port}`, child, users: 0 }
    const client = new OpencodeServerClient({ baseUrl: state.url, skipVersionProbe, requestTimeoutMs: 1_000, ...(config.fetch ? { fetch: config.fetch } : {}) })
    let last = ''
    try {
      for (let attempt = 0; attempt < 50; attempt++) {
        if (child.exitCode !== null) break
        try {
          const result = await client.version()
          if (result.ok) {
            // `/global/health` becomes available just before all session
            // routes are ready on some Bun builds. Let the listener finish
            // registering those routes before the first create request.
            await new Promise((resolve) => setTimeout(resolve, 250))
            return state
          }
          last = result.error
        } catch (error) {
          if (error instanceof OpencodeServerVersionError) throw error
          last = error instanceof Error ? error.message : String(error)
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw new OpencodeServerUnavailableError(`OpenCode server failed to start: ${last || stderr || 'timeout'}`)
    } catch (error) {
      try { await killProcessTree(child) } catch {}
      throw error
    }
  }
  const ensureServer = async (): Promise<SidecarState | { url: string; child?: undefined; users: number }> => {
    if (configuredUrl) return { url: configuredUrl, users: 0 }
    if (sidecar) return sidecar
    if (!sidecarStarting) sidecarStarting = startSidecar().then((value) => { sidecar = value; return value }).finally(() => { sidecarStarting = undefined })
    return sidecarStarting
  }
  const releaseSidecar = async (state: SidecarState | { url: string; child?: undefined; users: number }) => {
    if (!state.child || state !== sidecar) return
    state.users = Math.max(0, state.users - 1)
    if (state.users === 0) await stopSidecar()
  }

  return {
    ...cliBackend,
    async probe() {
      if (disabled) return cliBackend.probe()
      let checked: SidecarState | { url: string; child?: undefined; users: number } | undefined
      try {
        checked = await ensureServer()
        const server = await createOpencodeServerBackend({ baseUrl: checked.url, skipVersionProbe, ...(config.fetch ? { fetch: config.fetch } : {}) }).probe()
        if (server.ok || required) return server
      } catch (error) {
        if (error instanceof OpencodeServerVersionError || required) return { ok: false, detail: error instanceof Error ? error.message : String(error) }
      } finally {
        if (checked?.child && checked.users === 0) await stopSidecar()
      }
      const cli = await cliBackend.probe()
      return cli.ok ? { ...cli, detail: `${cli.detail}; OpenCode server unavailable (using CLI fallback)` } : cli
    },
    async start(options) {
      if (disabled) return cliBackend.start(options)
      try {
        const state = await ensureServer()
        if (state.child) state.users++
        let session
        try {
          session = await createOpencodeServerBackend({ baseUrl: state.url, skipVersionProbe, ...(config.fetch ? { fetch: config.fetch } : {}) }).start(options)
        } catch (error) {
          if (state.child) await releaseSidecar(state)
          throw error
        }
        let released = false
        const close = session.close
        session.close = async () => {
          if (released) return
          released = true
          try { await close() } finally { await releaseSidecar(state) }
        }
        return session
      } catch (error) {
        if (sidecar && sidecar.users === 0) await stopSidecar()
        if (required || error instanceof OpencodeServerVersionError) throw error
        // Keep the old adapter as a deliberate fallback for an unavailable
        // sidecar. The original error remains diagnostic in probe output.
        return cliBackend.start(options)
      }
    }
  }
}
