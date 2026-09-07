// OpenCode 适配器（一次性进程模型）
// 无头：opencode run --format json --dangerously-skip-permissions --dir <workdir> <prompt>
// 事件：step_start/tool_use/step_finish/text（sessionID 全程携带）；回合结束 = 进程退出
// 续聊：-s <sessionId>
import type { AgentBackend, BackendSession, BackendSessionEvents } from './types'
import type { TaskEvent } from '../../shared/types'
import { runCliJsonl, toolEvent } from './cli-common'
import { resolveCli, probeCli } from './cli-locator'

export function createOpencodeBackend(): AgentBackend {
  let live: { kill: () => void } | null = null

  const runOnce = (
    prompt: string,
    workdir: string,
    resumeSessionId: string | undefined,
    events: BackendSessionEvents,
    model?: string
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
      onLine: (j) => {
        events.onHeartbeat?.() // 进程有任何输出即进展（含未映射成事件的行）：看门狗续命
        if (!sessionId && j.sessionID) {
          sessionId = String(j.sessionID)
          emit({ kind: 'status', text: `opencode ${sessionId.slice(0, 10)}…` })
        }
        const part = j.part ?? {}
        if (j.type === 'tool_use') {
          const state = part.state?.status ?? ''
          const name = String(part.tool ?? '')
          if (state === 'running' || state === 'pending') {
            emit(toolEvent('started', name, { args: String(part.title ?? '').slice(0, 200) }))
          } else {
            emit(toolEvent('result', name, { ok: state !== 'error', preview: String(part.state?.output ?? part.title ?? '').slice(0, 300) }))
          }
        } else if (j.type === 'text' && part.text) {
          // 最后一条 text 即最终回复；中间 text 走 text 事件流式展示
          const text = String(part.text)
          finalText = text
          const pid = part.id ? String(part.id) : ''
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
    live = runner
    events.onLaunch?.({ stop: () => runner.kill() })
    void runner.exited.then((exitInfo) => {
      live = null
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

  return {
    id: 'opencode',
    label: 'OpenCode',
    async probe() {
      const p = await probeCli('opencode')
      return p.ok ? { ok: true, detail: `opencode ${p.version}` } : { ok: false, detail: p.error ?? '未安装' }
    },
    async start({ prompt, workdir, events, resumeSessionId, model }) {
      const r = await runOnce(prompt, workdir, resumeSessionId, events, model)
      if (!r.ok && r.error) throw new Error(r.error)
      const sid = r.sessionId
      return {
        sessionId: sid,
        async send(content) {
          const res = await runOnce(content, workdir, sid, events, model)
          if (!res.ok) throw new Error(res.error || '回合失败')
        },
        async stop() {
          live?.kill()
        },
        async close() {
          live?.kill()
        }
      }
    }
  }
}
