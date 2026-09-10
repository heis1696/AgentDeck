// OpenAI Codex 适配器（一次性进程模型）
// 无头：codex exec --json --dangerously-bypass-approvals-and-sandbox <prompt>
// 事件：thread.started(id) → item.started/completed(command_execution|mcp_tool_call|agent_message) → turn.completed
// 续聊：codex exec resume <id> --json ...
// 注意：Windows 下 workspace-write 沙箱会废掉命令执行，必须 bypass（实测 exit -1）
import type { AgentBackend, BackendSession, BackendSessionEvents, BackendTurnResult } from './types'
import type { TaskEvent } from '../../shared/types'
import { isJsonObject, jsonObject, jsonString, runCliJsonl, toolEvent } from './cli-common'
import { resolveCli, probeCli } from './cli-locator'

export function createCodexBackend(): AgentBackend {
  const runOnce = (
    prompt: string,
    workdir: string,
    resumeSessionId: string | undefined,
    events: BackendSessionEvents,
    model?: string,
    /** 本会话当前进程句柄落点：stop/close 只杀自己会话的进程，多任务并发不再串杀/漏杀 */
    onSpawn?: (runner: { kill: () => void | Promise<unknown> }) => void
  ): Promise<{ sessionId: string } & BackendTurnResult> => {
    const emit = (e: Omit<TaskEvent, 'seq' | 'ts'>) => events.onEvent({ ...e, ts: Date.now() })
    const resolved = resolveCli('codex')
    if (!resolved) return Promise.reject(new Error('PATH 上找不到 codex'))
    const common = ['--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check']
    const modelArgs = model ? ['-m', model] : []
    const args = resumeSessionId
      ? ['exec', 'resume', resumeSessionId, ...modelArgs, ...common, prompt]
      : ['exec', ...modelArgs, ...common, prompt]
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
      onLine: (obj) => {
        if (!isJsonObject(obj)) return
        const j = obj
        events.onHeartbeat?.() // 进程有任何输出即进展（含未映射成事件的行）：看门狗续命
        if (j.type === 'thread.started') {
          sessionId = jsonString(j.thread_id, sessionId)
          if (sessionId) events.onSessionId?.(sessionId)
          emit({ kind: 'status', text: `codex ${sessionId.slice(0, 8)}…` })
        } else if (j.type === 'item.started') {
          const it = jsonObject(j.item)
          const name = it.type === 'command_execution' ? 'Bash' : it.type === 'mcp_tool_call' ? jsonString(it.name, 'mcp') : ''
          if (name) {
            const itemId = jsonString(it.id)
            if (itemId) itemNames.set(itemId, name)
            const args = jsonString(it.type === 'command_execution' ? it.command : it.arguments).slice(0, 200)
            emit(toolEvent('started', name, { args }))
          }
        } else if (j.type === 'item.completed') {
          const it = jsonObject(j.item)
          if (it.type === 'agent_message') {
            finalText = jsonString(it.text)
            if (finalText) messageTexts.push(finalText)
            emit({ kind: 'text', text: finalText })
          } else if (it.type === 'command_execution' || it.type === 'mcp_tool_call') {
            const name = itemNames.get(jsonString(it.id)) ?? (it.type === 'command_execution' ? 'Bash' : 'mcp')
            emit(
              toolEvent('result', name, {
                ok: it.status !== 'failed' && it.exit_code !== -1,
                preview: jsonString(it.aggregated_output, jsonString(it.output)).slice(0, 300)
              })
            )
          }
        } else if (j.type === 'turn.completed') {
          if (isJsonObject(j.usage)) emit({ kind: 'usage', data: j.usage })
          finish(true, finalText)
        } else if (j.type === 'turn.failed') {
          finish(false, finalText, jsonString(jsonObject(j.error).message, 'codex 回合失败'))
        } else if (j.type === 'error') {
          emit({ kind: 'error', text: jsonString(j.message).slice(0, 200) })
        }
      }
    })
    onSpawn?.(runner)
    events.onLaunch?.({ stop: () => runner.kill() })
    void runner.exited.then((exitInfo) => {
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
    async start({ prompt, workdir, events, resumeSessionId, model }) {
      const dir = workdir || process.cwd()
      let own: { kill: () => void } | null = null
      const runTurn = (turnPrompt: string, resumeId?: string) =>
        runOnce(turnPrompt, dir, resumeId, events, model, (r) => { own = r })
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
}
