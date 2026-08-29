// Claude Code 适配器（一次性进程模型）
// 无头：claude -p <prompt> --output-format stream-json --verbose --dangerously-skip-permissions
// 事件：system/init(session_id) → assistant(text|tool_use) → user(tool_result) → result(终态+费用)
// 续聊：--resume <sessionId>
import type { AgentBackend, BackendSession, BackendSessionEvents } from './types'
import type { TaskEvent } from '../../shared/types'
import { runCliJsonl, toolEvent } from './cli-common'
import { resolveCli, probeCli } from './cli-locator'

export function createClaudeBackend(): AgentBackend {
  let live: { kill: () => void } | null = null

  /** 跑一次（新会话或 resume）；resolve 于回合终态（result 事件或进程退出） */
  const runOnce = (
    prompt: string,
    workdir: string,
    resumeSessionId: string | undefined,
    events: BackendSessionEvents
  ): Promise<{ sessionId: string; response: string; ok: boolean; error?: string }> => {
    const emit = (e: Omit<TaskEvent, 'seq' | 'ts'>) => events.onEvent({ ...e, ts: Date.now() })
    const resolved = resolveCli('claude')
    if (!resolved) return Promise.reject(new Error('PATH 上找不到 claude'))
    const args = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--max-turns', '80',
      ...(resumeSessionId ? ['--resume', resumeSessionId] : [])
    ]
    let sessionId = resumeSessionId ?? ''
    let sessionIdResolve: (sid: string) => void = () => {}
    const sessionIdReady = new Promise<string>((r) => (sessionIdResolve = r))
    let settled = false
    let settle!: (v: { sessionId: string; response: string; ok: boolean; error?: string }) => void
    const done = new Promise<{ sessionId: string; response: string; ok: boolean; error?: string }>((r) => (settle = r))
    const finish = (ok: boolean, response: string, error?: string) => {
      if (settled) return
      settled = true
      events.onTurnEnd({ response, ok, error })
      settle({ sessionId, response, ok, error })
    }

    const runner = runCliJsonl({
      command: resolved.command,
      prefixArgs: resolved.prefixArgs,
      args,
      cwd: workdir,
      onLine: (j) => {
        if (j.type === 'system' && j.subtype === 'init') {
          sessionId = j.session_id ?? sessionId
          sessionIdResolve(sessionId)
          emit({ kind: 'status', text: `claude ${j.model ?? ''}` })
        } else if (j.type === 'assistant' && Array.isArray(j.message?.content)) {
          for (const part of j.message.content) {
            if (part.type === 'text' && part.text) {
              emit({ kind: 'text', text: part.text })
            } else if (part.type === 'tool_use') {
              let toolArgs = ''
              try {
                toolArgs = JSON.stringify(part.input).slice(0, 200)
              } catch {}
              emit(toolEvent('started', part.name, { args: toolArgs }))
            }
          }
        } else if (j.type === 'user' && Array.isArray(j.message?.content)) {
          for (const part of j.message.content) {
            if (part.type === 'tool_result') {
              const preview = typeof part.content === 'string'
                ? part.content.slice(0, 300)
                : Array.isArray(part.content)
                  ? part.content.filter((c: any) => c.type === 'text').map((c: any) => String(c.text)).join('\n').slice(0, 300)
                  : ''
              emit(toolEvent('result', '', { ok: !part.is_error, preview }))
            }
          }
        } else if (j.type === 'result') {
          const response = String(j.result ?? '')
          emit({
            kind: 'usage',
            data: { costUsd: j.total_cost_usd, numTurns: j.num_turns, ...j.usage }
          })
          emit({ kind: 'final', text: response })
          finish(!j.is_error, response, j.is_error ? response : undefined)
        }
      }
    })
    live = runner
    events.onLaunch?.({ stop: () => runner.kill() })

    void runner.exited.then((exitInfo) => {
      live = null
      if (!settled) {
        finish(
          exitInfo.code === 0,
          '',
          `claude 退出 code=${exitInfo.code}${exitInfo.stderrTail ? ': ' + exitInfo.stderrTail.slice(0, 200) : ''}`
        )
      }
    })
    // init 30 秒没到也给个占位（后续 resume 用真实 id 或退化为新会话）
    setTimeout(() => sessionIdResolve(sessionId || `unknown_${Date.now()}`), 30000)
    return done.then(async (r) => ({ ...r, sessionId: (await sessionIdReady) || r.sessionId }))
  }

  return {
    id: 'claude',
    label: 'Claude Code',
    async probe() {
      const p = await probeCli('claude')
      return p.ok ? { ok: true, detail: `claude ${p.version}` } : { ok: false, detail: p.error ?? '未安装' }
    },
    async start({ prompt, workdir, events, resumeSessionId }) {
      const dir = workdir || process.cwd()
      const first = runOnce(prompt, dir, resumeSessionId, events)
      const sidPromise = first.then((r) => r.sessionId).catch(() => '')
      // start() 在回合结束后才 resolve 与 zcode 语义不同——但接口允许：
      // session.send 的续聊发生在 start resolve 之后，天然串行。
      const r = await first
      if (!r.ok && r.error) throw new Error(r.error)
      const sid = r.sessionId
      const session: BackendSession = {
        sessionId: sid,
        async send(content) {
          const res = await runOnce(content, dir, sid, events)
          if (!res.ok) throw new Error(res.error || '回合失败')
        },
        async stop() {
          live?.kill()
        },
        async close() {
          live?.kill()
        }
      }
      void sidPromise
      return session
    }
  }
}
