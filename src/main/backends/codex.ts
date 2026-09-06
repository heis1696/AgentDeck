// OpenAI Codex 适配器（一次性进程模型）
// 无头：codex exec --json --dangerously-bypass-approvals-and-sandbox <prompt>
// 事件：thread.started(id) → item.started/completed(command_execution|mcp_tool_call|agent_message) → turn.completed
// 续聊：codex exec resume <id> --json ...
// 注意：Windows 下 workspace-write 沙箱会废掉命令执行，必须 bypass（实测 exit -1）
import type { AgentBackend, BackendSession, BackendSessionEvents, BackendTurnResult } from './types'
import type { TaskEvent } from '../../shared/types'
import { runCliJsonl, toolEvent } from './cli-common'
import { resolveCli, probeCli } from './cli-locator'

export function createCodexBackend(): AgentBackend {
  let live: { kill: () => void } | null = null

  const runOnce = (
    prompt: string,
    workdir: string,
    resumeSessionId: string | undefined,
    events: BackendSessionEvents
  ): Promise<{ sessionId: string } & BackendTurnResult> => {
    const emit = (e: Omit<TaskEvent, 'seq' | 'ts'>) => events.onEvent({ ...e, ts: Date.now() })
    const resolved = resolveCli('codex')
    if (!resolved) return Promise.reject(new Error('PATH 上找不到 codex'))
    const common = ['--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check']
    const args = resumeSessionId
      ? ['exec', 'resume', resumeSessionId, ...common, prompt]
      : ['exec', ...common, prompt]
    let sessionId = resumeSessionId ?? ''
    let finalText = ''
    // Codex can emit multiple agent_message items in one turn. Keep all of
    // them for protocol parsing while retaining the last one as the display
    // response.
    const messageTexts: string[] = []
    let settled = false
    let settle!: (v: { sessionId: string } & BackendTurnResult) => void
    const done = new Promise<{ sessionId: string } & BackendTurnResult>((r) => (settle = r))
    const finish = (ok: boolean, response: string, error?: string) => {
      if (settled) return
      settled = true
      // final 只在回合终态发一次：每条 agent_message 一个会把回合在 UI 里拆成多个假回合
      if (response) emit({ kind: 'final', text: response })
      const delegationText = messageTexts.join('\n')
      events.onTurnEnd({ response, ok, error, delegationText })
      settle({ sessionId, response, ok, error, delegationText })
    }
    const itemNames = new Map<string, string>()

    const runner = runCliJsonl({
      command: resolved.command,
      prefixArgs: resolved.prefixArgs,
      args,
      cwd: workdir,
      onLine: (j) => {
        if (j.type === 'thread.started') {
          sessionId = j.thread_id ?? sessionId
          emit({ kind: 'status', text: `codex ${sessionId.slice(0, 8)}…` })
        } else if (j.type === 'item.started') {
          const it = j.item ?? {}
          const name = it.type === 'command_execution' ? 'Bash' : it.type === 'mcp_tool_call' ? String(it.name ?? 'mcp') : ''
          if (name) {
            itemNames.set(it.id, name)
            const args = it.type === 'command_execution' ? String(it.command ?? '').slice(0, 200) : String(it.arguments ?? '').slice(0, 200)
            emit(toolEvent('started', name, { args }))
          }
        } else if (j.type === 'item.completed') {
          const it = j.item ?? {}
          if (it.type === 'agent_message') {
            finalText = String(it.text ?? '')
            if (finalText) messageTexts.push(finalText)
            emit({ kind: 'text', text: finalText })
          } else if (it.type === 'command_execution' || it.type === 'mcp_tool_call') {
            const name = itemNames.get(it.id) ?? (it.type === 'command_execution' ? 'Bash' : 'mcp')
            emit(
              toolEvent('result', name, {
                ok: it.status !== 'failed' && it.exit_code !== -1,
                preview: String(it.aggregated_output ?? it.output ?? '').slice(0, 300)
              })
            )
          }
        } else if (j.type === 'turn.completed') {
          if (j.usage) emit({ kind: 'usage', data: j.usage })
          finish(true, finalText)
        } else if (j.type === 'turn.failed') {
          finish(false, finalText, String(j.error?.message ?? 'codex 回合失败'))
        } else if (j.type === 'error') {
          emit({ kind: 'error', text: String(j.message ?? '').slice(0, 200) })
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
          finalText,
          `codex 退出 code=${exitInfo.code}${exitInfo.stderrTail ? ': ' + exitInfo.stderrTail.slice(0, 200) : ''}`
        )
      }
    })
    return done
  }

  return {
    id: 'codex',
    label: 'Codex',
    async probe() {
      const p = await probeCli('codex')
      return p.ok ? { ok: true, detail: `codex ${p.version}` } : { ok: false, detail: p.error ?? '未安装' }
    },
    async start({ prompt, workdir, events, resumeSessionId }) {
      const dir = workdir || process.cwd()
      const r = await runOnce(prompt, dir, resumeSessionId, events)
      if (!r.ok && r.error) throw new Error(r.error)
      const sid = r.sessionId
      return {
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
    }
  }
}
