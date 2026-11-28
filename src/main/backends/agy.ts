// Antigravity CLI (agy) 适配器（一次性进程模型）
// 无头：agy --input-format stream-json --output-format stream-json --dangerously-skip-permissions
// prompt 走 stdin NDJSON（{"event":"user","message":{"content":"..."}}）：
//   实测 agy -p 只接命令行参数不读管道，走 --input-format stream-json 既免去 Windows
//   CreateProcess 32767 字符上限（ENAMETOOLONG），又能按 EOF 干净退出单回合进程。
// 事件：init(conversation_id) → step_update(agent_response|tool) → result(status+response+累计usage)
// 续聊：--resume <conversationId>（与 --conversation 等价）
// 用量：result.usage 是整段会话累计值，续聊时会重复算前轮；本轮真实用量由各 DONE step_update.usage 汇总。
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentBackend, BackendMcpEndpoint, BackendSession, BackendSessionEvents, BackendTurnResult, BackendTurnStamp } from './types'
import { bindTurn } from './types'
import type { TaskEvent, ThinkingLevel, ToolEditMeta } from '../../shared/types'
import { isJsonObject, jsonNumber, jsonObject, jsonString, runCliJsonl, toolEvent, type CliJsonlRunner } from './cli-common'
import { parseEditMeta, stringifyToolArgs } from './edit-meta'
import { resolveCli, type ResolvedCli } from './cli-locator'
import { AGENTDECK_MCP_TOOLS } from '../mcp-delegation-server'

/** Antigravity 单条 rule 文件上限 24,000 字节；留出 frontmatter 余量确保不被静默截断 */
const AGY_RULE_BODY_MAX_BYTES = 20_000

function trimUtf8Bytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const suffix = '\n…（宿主指令已按 agy 单条规则字节上限截断，请调用 agentdeck_context 获取完整实时状态）'
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix, 'utf8'))
  let end = Math.min(text.length, budget)
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > budget) {
    end -= Math.max(1, Math.ceil((Buffer.byteLength(text.slice(0, end), 'utf8') - budget) / 3))
  }
  return text.slice(0, end) + suffix
}

/**
 * 为单回合 agy 进程构造独立临时 overlay 目录（经 `--add-dir` 挂载，零污染用户工作区）：
 * - `.agents/mcp_config.json`：按会话注入 AgentDeck Streamable HTTP MCP 端点与 Bearer Token，
 *   全部 AgentDeck 内部工具设 `eager: true`，免去懒加载额外读盘回合；
 * - `.agents/rules/agentdeck-host.md`：`trigger: always_on` 规则，随每轮系统规则层注入，免疫自动压缩。
 */
function createAgyOverlayDir(systemPrompt?: string, mcpEndpoint?: BackendMcpEndpoint): string | undefined {
  const hasPrompt = !!systemPrompt?.trim()
  if (!hasPrompt && !mcpEndpoint) return undefined
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-agy-ctx-'))
  try {
    const agentsDir = path.join(dir, '.agents')
    fs.mkdirSync(agentsDir, { recursive: true })
    if (mcpEndpoint) {
      const eagerTools: Record<string, { eager: true }> = {}
      for (const toolName of Object.values(AGENTDECK_MCP_TOOLS)) {
        eagerTools[toolName] = { eager: true }
      }
      fs.writeFileSync(
        path.join(agentsDir, 'mcp_config.json'),
        JSON.stringify({
          mcpServers: {
            [mcpEndpoint.serverName]: {
              serverUrl: mcpEndpoint.url,
              headers: { Authorization: `Bearer ${mcpEndpoint.token}` },
              tools: eagerTools
            }
          }
        }, null, 2),
        'utf8'
      )
    }
    if (hasPrompt) {
      const rulesDir = path.join(agentsDir, 'rules')
      fs.mkdirSync(rulesDir, { recursive: true })
      const body = trimUtf8Bytes(systemPrompt!.trim(), AGY_RULE_BODY_MAX_BYTES)
      const content = [
        '---',
        'trigger: always_on',
        'description: "AgentDeck host platform framing, role boundaries, and collaboration contract"',
        '---',
        '',
        body,
        ''
      ].join('\n')
      fs.writeFileSync(path.join(rulesDir, 'agentdeck-host.md'), content, 'utf8')
    }
    return dir
  } catch (err) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
    throw err
  }
}

/** 思考档位 → agy --effort 原生档（实测默认旗舰系列无 max 档，最高为 xhigh；off 落最低档 low） */
const EFFORT_LEVEL: Record<ThinkingLevel, string> = {
  off: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'xhigh'
}

/** 模型名是否已自带思考档位后缀（如 gemini-3.8-flash-low / Gemini 4 Neon (High)）：
 *  实测 agy 收到自带档位的 --model 与不同的 --effort 会直接报 conflicts with --effort 失败。 */
export function hasExplicitEffort(model: string): boolean {
  return /(?:-(?:low|medium|high|xhigh|max)|\s*\((?:low|medium|high|xhigh|max)\))$/i.test(model.trim())
}

/**
 * 解析 agy 可执行文件：优先 PATH（支持测试伪装与常规安装），
 * 找不到时兜底检查官方安装脚本默认落点（Windows: %LOCALAPPDATA%\agy\bin\agy.exe；
 * POSIX: ~/.local/bin/agy），避免 Electron 先于安装启动、未继承新 PATH 时误报未安装。
 */
export function resolveAgy(options?: { disableFallback?: boolean }): ResolvedCli | null {
  const onPath = resolveCli('agy')
  if (onPath) return onPath
  if (options?.disableFallback || process.env.AGENTDECK_AGY_DISABLE_FALLBACK === '1') return null
  const candidate = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'agy', 'bin', 'agy.exe')
    : path.join(os.homedir(), '.local', 'bin', 'agy')
  try {
    if (fs.existsSync(candidate)) return { command: candidate, prefixArgs: [], origin: candidate }
  } catch {}
  return null
}

/** 解析 `agy models` 的 stdout（每行 `<slug>\t<Display Name>`）为去重后的模型 slug 列表 */
export function parseAgyModelsOutput(stdout: string): string[] {
  const seen = new Set<string>()
  const models: string[] = []
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const slug = line.split('\t')[0]?.trim() ?? ''
    if (!slug || /\s/.test(slug) || slug.endsWith(':')) continue
    if (seen.has(slug)) continue
    seen.add(slug)
    models.push(slug)
  }
  return models
}

/** 在线拉取 agy 可用模型目录（失败静默返回空表，不阻断 Agent 表单编辑） */
export function listAgyModels(): Promise<{ models: string[] }> {
  return new Promise((resolve) => {
    const resolved = resolveAgy()
    if (!resolved) return resolve({ models: [] })
    execFile(resolved.command, [...resolved.prefixArgs, 'models'], { timeout: 15_000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve({ models: [] })
      resolve({ models: parseAgyModelsOutput(stdout) })
    })
  })
}

interface StepUsageTotals {
  inputTokens: number
  outputTokens: number
  thinkingTokens: number
  cacheReadTokens: number
  totalTokens: number
}

function extractStepUsage(raw: Record<string, unknown>): StepUsageTotals | null {
  const inputTokens = jsonNumber(raw.input_tokens)
  const outputTokens = jsonNumber(raw.output_tokens)
  const thinkingTokens = jsonNumber(raw.thinking_tokens) ?? 0
  const cacheReadTokens = jsonNumber(raw.cache_read_tokens) ?? 0
  const totalTokens = jsonNumber(raw.total_tokens)
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return null
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    thinkingTokens,
    cacheReadTokens,
    totalTokens: totalTokens ?? ((inputTokens ?? 0) + (outputTokens ?? 0))
  }
}

export function createAgyBackend(): AgentBackend {
  const runOnce = (
    prompt: string,
    workdir: string,
    resumeSessionId: string | undefined,
    events: BackendSessionEvents,
    model?: string,
    thinking?: ThinkingLevel,
    /** 本会话当前进程句柄落点：stop/close 只杀自己会话的进程，多任务并发不再串杀/漏杀 */
    onSpawn?: (runner: Pick<CliJsonlRunner, 'kill'>) => void,
    systemPrompt?: string,
    mcpEndpoint?: BackendMcpEndpoint
  ): Promise<{ sessionId: string } & BackendTurnResult> => {
    const emit = (e: Omit<TaskEvent, 'seq' | 'ts'>) => events.onEvent({ ...e, ts: Date.now() })
    const resolved = resolveAgy()
    if (!resolved) return Promise.reject(new Error('PATH 或默认安装路径上找不到 agy'))
    let overlayDir: string | undefined
    const cleanupOverlay = () => {
      if (!overlayDir) return
      const target = overlayDir
      overlayDir = undefined
      try { fs.rmSync(target, { recursive: true, force: true }) } catch {}
    }
    try {
      overlayDir = createAgyOverlayDir(systemPrompt, mcpEndpoint)
    } catch (err) {
      cleanupOverlay()
      return Promise.reject(err instanceof Error ? err : new Error(String(err)))
    }
    const trimmedModel = model?.trim() || ''
    const effort = thinking && (!trimmedModel || !hasExplicitEffort(trimmedModel)) ? EFFORT_LEVEL[thinking] : undefined
    const args = [
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
      ...(overlayDir ? ['--add-dir', overlayDir] : []),
      ...(trimmedModel ? ['--model', trimmedModel] : []),
      ...(effort ? ['--effort', effort] : []),
      ...(resumeSessionId ? ['--resume', resumeSessionId] : [])
    ]
    const stdinPayload = JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n'

    const turnStartedAt = Date.now()
    let sessionId = resumeSessionId ?? ''
    let emittedSessionId = ''
    const noteSessionId = (candidate: string) => {
      const next = candidate.trim()
      if (!next) return
      sessionId = next
      if (emittedSessionId !== next) {
        emittedSessionId = next
        events.onSessionId?.(next)
      }
    }

    /** 工具步骤状态去重：同一 step_index 可能收到多条 ACTIVE 或重复 DONE */
    const startedTools = new Map<number, { name: string; edit: ToolEditMeta | null }>()
    const completedTools = new Set<number>()
    /** 按 step_index 聚合本轮每个 agent_response 的文本，供 delegationText 扫描全轮中间发言 */
    const agentStepTexts = new Map<number, string>()
    let anonymousStepSeq = -1
    /** 按 step_index 去重记录本轮 DONE 步骤的增量用量（避免 result.usage 跨轮累计导致重复计费） */
    const stepUsages = new Map<number, StepUsageTotals>()

    let settled = false
    let settle!: (v: { sessionId: string } & BackendTurnResult) => void
    const done = new Promise<{ sessionId: string } & BackendTurnResult>((r) => (settle = r))
    const finish = (ok: boolean, response: string, error?: string, delegationText?: string, tokenCount?: number) => {
      if (settled) return
      settled = true
      const durationMs = Math.max(0, Date.now() - turnStartedAt)
      const payload: BackendTurnResult = {
        response,
        ok,
        ...(error ? { error } : {}),
        ...(tokenCount !== undefined ? { tokenCount } : {}),
        durationMs,
        ...(delegationText ? { delegationText } : {})
      }
      events.onTurnEnd(payload)
      settle({ sessionId, ...payload })
    }

    const runner = runCliJsonl({
      command: resolved.command,
      prefixArgs: resolved.prefixArgs,
      args,
      cwd: workdir,
      stdin: stdinPayload,
      onLine: (obj) => {
        if (!isJsonObject(obj)) return
        const j = obj
        events.onHeartbeat?.() // 进程有任何协议行输出即进展：看门狗续命
        const eventType = jsonString(j.event)

        if (eventType === 'init') {
          const init = jsonObject(j.init)
          noteSessionId(jsonString(j.conversation_id) || jsonString(init.conversation_id))
          const activeModel = jsonString(init.model)
          emit({ kind: 'status', text: activeModel ? `agy ${activeModel}` : `agy ${sessionId.slice(0, 8)}…` })
          return
        }

        if (eventType === 'step_update') {
          const su = jsonObject(j.step_update)
          if (!sessionId) noteSessionId(jsonString(su.conversation_id))
          const stepIndex = jsonNumber(su.step_index)
          const stepType = jsonString(su.step_type)
          const state = jsonString(su.state).toUpperCase()

          if (stepType === 'agent_response') {
            const delta = jsonString(su.text_delta)
            if (delta) {
              const key = stepIndex ?? anonymousStepSeq--
              agentStepTexts.set(key, (agentStepTexts.get(key) ?? '') + delta)
              emit({ kind: 'text', text: delta })
            }
            if (state === 'DONE' && isJsonObject(su.usage)) {
              const usage = extractStepUsage(su.usage)
              if (usage) stepUsages.set(stepIndex ?? stepUsages.size, usage)
            }
            return
          }

          if (stepType === 'tool' || stepType === 'tool_call') {
            const info = jsonObject(su.tool_info)
            const name = jsonString(su.tool_name) || jsonString(info.name) || 'tool'
            const rawParams = info.parameters ?? info.arguments
            const isTerminal = state === 'DONE' || state === 'ERROR' || state === 'FAILED' || state === 'CANCELED' || state === 'CANCELLED'

            if (stepIndex === undefined || !startedTools.has(stepIndex)) {
              const rawArgs = stringifyToolArgs(rawParams)
              const edit = parseEditMeta(name, rawArgs)
              if (stepIndex !== undefined) startedTools.set(stepIndex, { name, edit })
              emit(toolEvent('started', name, { args: rawArgs.slice(0, 200) }, edit))
            }

            if (isTerminal && (stepIndex === undefined || !completedTools.has(stepIndex))) {
              if (stepIndex !== undefined) completedTools.add(stepIndex)
              const prev = stepIndex !== undefined ? startedTools.get(stepIndex) : undefined
              const edit = prev?.edit ?? parseEditMeta(name, stringifyToolArgs(rawParams))
              const errText = jsonString(info.error) || jsonString(su.error)
              const outText = typeof info.output === 'string' ? info.output : stringifyToolArgs(info.output)
              const ok = state === 'DONE' && !errText && info.is_error !== true
              const preview = (errText || outText).slice(0, 300)
              const durationSec = jsonNumber(su.duration_seconds)
              emit(toolEvent(
                'result',
                prev?.name || name,
                { ok, preview, ...(durationSec !== undefined ? { durationMs: Math.round(durationSec * 1000) } : {}) },
                edit
              ))
            }
          }
          return
        }

        if (eventType === 'result') {
          const res = isJsonObject(j.result) ? j.result : j
          noteSessionId(jsonString(res.conversation_id) || jsonString(j.conversation_id))
          const status = jsonString(res.status).toUpperCase()
          const ok = status === 'SUCCESS' || status === 'OK'
          const streamedSteps = [...agentStepTexts.values()].map((s) => s.trim()).filter(Boolean)
          const response = jsonString(res.response) || (streamedSteps.length ? streamedSteps[streamedSteps.length - 1] : '')
          const delegationText = streamedSteps.length ? streamedSteps.join('\n') : (response || undefined)
          const durationMs = Math.max(0, Date.now() - turnStartedAt)

          let totalTokens: number | undefined
          if (stepUsages.size > 0) {
            let inputTokens = 0
            let outputTokens = 0
            let thinkingTokens = 0
            let cacheReadTokens = 0
            let sumTotal = 0
            for (const u of stepUsages.values()) {
              inputTokens += u.inputTokens
              outputTokens += u.outputTokens
              thinkingTokens += u.thinkingTokens
              cacheReadTokens += u.cacheReadTokens
              sumTotal += u.totalTokens
            }
            totalTokens = sumTotal
            emit({ kind: 'usage', data: { inputTokens, outputTokens, totalTokens: sumTotal, thinkingTokens, cacheReadTokens, durationMs } })
          } else if (!resumeSessionId && isJsonObject(res.usage)) {
            const fallback = extractStepUsage(res.usage)
            if (fallback && (fallback.totalTokens > 0 || fallback.inputTokens > 0 || fallback.outputTokens > 0)) {
              totalTokens = fallback.totalTokens
              emit({ kind: 'usage', data: { ...fallback, durationMs } })
            }
          }

          if (ok && response) emit({ kind: 'final', text: response })
          const error = ok ? undefined : (jsonString(res.error) || response || `agy 回合失败 (${status || 'ERROR'})`)
          finish(ok, response, error, delegationText, totalTokens)
        }
      }
    })

    onSpawn?.(runner)
    events.onLaunch?.({ stop: () => runner.kill() })

    void runner.exited.then((exitInfo) => {
      cleanupOverlay()
      if (!settled) {
        const streamedSteps = [...agentStepTexts.values()].map((s) => s.trim()).filter(Boolean)
        const fallbackText = streamedSteps.length ? streamedSteps[streamedSteps.length - 1] : ''
        const ok = exitInfo.code === 0 && !!fallbackText
        if (ok) emit({ kind: 'final', text: fallbackText })
        finish(
          ok,
          fallbackText,
          ok
            ? undefined
            : exitInfo.code === 0
              ? 'agy 无文本输出'
              : `agy 退出 code=${exitInfo.code}${exitInfo.stderrTail ? ': ' + exitInfo.stderrTail.slice(0, 200) : ''}`,
          streamedSteps.length ? streamedSteps.join('\n') : undefined
        )
      }
    })
    return done
  }

  return {
    id: 'agy',
    label: 'Antigravity',
    thinkingSwitchMode: 'per-turn',
    systemPromptMode: 'native',
    delegationTransport: 'mcp',
    // resumeSessionId 走 `agy --resume <conversationId>`：每回合独立进程按 provider 落盘会话恢复
    supportsResume: true,
    async probe() {
      const resolved = resolveAgy()
      if (!resolved) return { ok: false, detail: 'PATH 或默认安装路径上找不到 agy' }
      return new Promise((resolve) => {
        execFile(resolved.command, [...resolved.prefixArgs, '--version'], { timeout: 15_000, windowsHide: true }, (err, stdout) => {
          if (err) return resolve({ ok: false, detail: String(err.message).slice(0, 120) })
          const ver = stdout.trim().split('\n')[0]?.slice(0, 60) ?? ''
          resolve({ ok: true, detail: ver ? `agy ${ver}` : 'agy' })
        })
      })
    },
    async start({ prompt, workdir, events: rawEvents, resumeSessionId, model, thinking, systemPrompt, mcpEndpoint, turn }) {
      const dir = workdir || process.cwd()
      let own: Pick<CliJsonlRunner, 'kill'> | null = null
      // 一次性 CLI：每个回合一个进程；回合身份随进程绑定，被杀旧进程的迟到回调带旧身份。
      const runTurn = (turnPrompt: string, resumeId?: string, turnStamp?: BackendTurnStamp, turnThinking?: ThinkingLevel) =>
        runOnce(turnPrompt, dir, resumeId, bindTurn(rawEvents, turnStamp), model, turnThinking ?? thinking, (r) => { own = r }, systemPrompt, mcpEndpoint)
      const r = await runTurn(prompt, resumeSessionId, turn)
      if (!r.ok && r.error) throw new Error(r.error)
      const sid = r.sessionId
      const session: BackendSession = {
        sessionId: sid,
        turnScoped: true,
        async send(content, turnStamp, opts) {
          const res = await runTurn(content, sid, turnStamp, opts?.thinking)
          if (!res.ok) throw new Error(res.error || '回合失败')
        },
        async stop() {
          await Promise.resolve(own?.kill())
        },
        async close() {
          const result = await own?.kill()
          if (result && !result.ok) throw new Error(result.error || 'Antigravity process cleanup failed')
        }
      }
      return session
    }
  }
}
