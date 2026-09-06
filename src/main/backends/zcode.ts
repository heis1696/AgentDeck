// ZCode 后端适配器：spawn `zcode app-server --stdio`，讲 "ZCode Protocol"。
// 协议要点（逆向自 zcode.cjs 0.16.3，2026-08 实测）：
//   - 换行分隔 JSON。请求 {id,method,params}，响应 {id,result|error}，通知 {method,params}
//   - session/create 会先收到服务端请求 session/requestRuntimePreferences（必须应答扁平对象）
//   - session/subscribe {sessionId, deliveryKind:"desktop-continuous"} 开启事件推送
//   - session/send {sessionId, content} 派发提示词
//   - 事件流：session/event（含 model.streaming 文本增量、回合终态）、
//             state.updated（会话状态机）、v4/telemetry/event（turn.terminal 等）
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { TaskEvent } from '../../shared/types'
import type { AgentBackend, BackendSession, BackendSessionEvents } from './types'

const DEFAULT_MODEL = 'zai/glm-5.3'
const LITE_MODEL = 'zai/glm-4.7'

export function zcodeDefaultPaths(): string[] {
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    'D:\\Program Files',
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs')
  ].filter(Boolean) as string[]
  const out: string[] = []
  for (const root of roots) {
    for (const dir of ['ZCode', 'zcode']) {
      out.push(path.join(root, dir, 'resources', 'glm', 'zcode.cjs'))
    }
  }
  return out
}

/**
 * 解析运行 zcode.cjs 的 Node。
 * zcode.cjs 依赖 node:sqlite（Node ≥22.5），而 Electron 内置 Node 是 20.x，
 * 所以必须优先用系统 Node；找不到时退回 process.execPath（大概率会报
 * "No such built-in module: node:sqlite"，错误信息里会带这句提示）。
 */
export function resolveNodeRuntime(preferred?: string): { path: string; source: string } {
  if (preferred && fs.existsSync(preferred)) return { path: preferred, source: 'settings' }
  const isWin = process.platform === 'win32'
  const exe = isWin ? 'node.exe' : 'node'
  const dirs = (process.env.PATH ?? '').split(isWin ? ';' : ':')
  for (const dir of dirs) {
    if (!dir) continue
    const full = path.join(dir, exe)
    try {
      if (fs.existsSync(full)) return { path: full, source: 'PATH' }
    } catch {}
  }
  return { path: process.execPath, source: 'fallback-electron' }
}

export function findZcodeBundle(custom?: string): string | null {
  const candidates = custom ? [custom, ...zcodeDefaultPaths()] : zcodeDefaultPaths()
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p
    } catch {}
  }
  return null
}

/**
 * 确保 `~/.zcode/cli/config.json` 存在且带 model 配置（app-server 启动必需）。
 * 优先从 GUI 的 `~/.zcode/v2/config.json` 迁移登录态；已有有效配置则不动。
 */
export function ensureZcodeCliConfig(): { ok: boolean; detail: string } {
  const home = os.homedir()
  const cliConfigPath = path.join(home, '.zcode', 'cli', 'config.json')
  try {
    if (fs.existsSync(cliConfigPath)) {
      const cfg = JSON.parse(fs.readFileSync(cliConfigPath, 'utf8'))
      if (cfg?.model?.main) return { ok: true, detail: 'cli config 已存在' }
    }
  } catch {}
  // 从 v2（GUI 登录态）迁移
  try {
    const v2Path = path.join(home, '.zcode', 'v2', 'config.json')
    if (!fs.existsSync(v2Path)) return { ok: false, detail: '未找到 ~/.zcode/v2/config.json，请先在 ZCode 里登录' }
    const v2 = JSON.parse(fs.readFileSync(v2Path, 'utf8'))
    const providers = v2?.provider ?? {}
    // 优先 builtin:zai，其次任何启用且带 key 的 provider
    const ids = Object.keys(providers)
    ids.sort((a, b) => (a === 'builtin:zai' ? -1 : b === 'builtin:zai' ? 1 : 0))
    for (const id of ids) {
      const p = providers[id]
      const apiKey = p?.options?.apiKey
      if (!p?.enabled || !apiKey || !p?.baseURL && !p?.options?.baseURL) continue
      const providerId = id.replace(/^builtin:/, '')
      const baseURL = p.options.baseURL ?? p.baseURL
      // 模型目录：v2 里的模型表（键如 "GLM-5.3"）映射成小写 id → {name}
      // resume 会话时服务端按此目录校验历史模型，目录为空会报"模型已不可用"
      const models: Record<string, { name: string }> = {}
      for (const mk of Object.keys(p.models ?? {})) {
        models[mk.toLowerCase()] = { name: mk }
      }
      const modelIds = Object.keys(models)
      const preferred =
        modelIds.find((m) => m === 'glm-5.3') ?? modelIds[0] ?? 'glm-5.3'
      const cfg = {
        provider: {
          [providerId]: {
            kind: p.kind ?? 'anthropic',
            name: p.name ?? providerId,
            options: { apiKeyRequired: true, baseURL, apiKey },
            models
          }
        },
        model: {
          main: `${providerId}/${preferred}`,
          lite: `${providerId}/glm-4.7`
        }
      }
      fs.mkdirSync(path.dirname(cliConfigPath), { recursive: true })
      fs.writeFileSync(cliConfigPath, JSON.stringify(cfg, null, 2))
      return { ok: true, detail: `已从 ZCode 登录态生成配置（${providerId}/${preferred}）` }
    }
    return { ok: false, detail: 'ZCode 登录态中没有可用的 API key' }
  } catch (e) {
    return { ok: false, detail: `读取 ZCode 配置失败: ${e instanceof Error ? e.message : String(e)}` }
  }
}

interface WireMessage {
  id?: number | string
  method?: string
  params?: any
  result?: any
  error?: { code: number; message: string; data?: any }
}

class ZcodeConnection {
  private child: ChildProcess
  private nextId = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private buffer = ''
  private stderrTail = ''
  private handlers = new Set<(m: WireMessage) => void>()
  exited = false

  constructor(nodePath: string, zcodePath: string, cwd: string) {
    // ELECTRON_RUN_AS_NODE 仅在退回 electron.exe 充当 node 时需要；真 node.exe 忽略之
    const env: NodeJS.ProcessEnv = { ...process.env }
    if (path.resolve(nodePath).toLowerCase() === path.resolve(process.execPath).toLowerCase()) {
      env.ELECTRON_RUN_AS_NODE = '1'
    } else {
      delete env.ELECTRON_RUN_AS_NODE
    }
    this.child = spawn(
      nodePath,
      [zcodePath, 'app-server', '--stdio'],
      {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )
    this.child.stdout!.setEncoding('utf8')
    this.child.stdout!.on('data', (chunk: string) => {
      this.buffer += chunk
      let idx: number
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim()
        this.buffer = this.buffer.slice(idx + 1)
        if (!line) continue
        let msg: WireMessage
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        this.dispatch(msg)
      }
    })
    this.child.stderr!.on('data', (c: Buffer) => {
      const s = c.toString().trim()
      if (s) {
        // 保留 stderr 尾部，进程异常退出时随错误抛出（否则真实原因被吞）
        this.stderrTail = (this.stderrTail + '\n' + s).slice(-1500)
        console.warn('[zcode:stderr]', s.slice(0, 400))
      }
    })
    this.child.on('exit', (code) => {
      this.exited = true
      const detail = this.stderrTail.trim()
      const err = new Error(
        `zcode app-server 进程退出 (code ${code})${detail ? ': ' + detail : ''}`
      )
      for (const [, p] of this.pending) p.reject(err)
      this.pending.clear()
    })
  }

  private dispatch(msg: WireMessage) {
    const isResponse = msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)
    if (isResponse && typeof msg.id === 'number') {
      const p = this.pending.get(msg.id)
      if (p) {
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(msg.error.message))
        else p.resolve(msg.result)
        return
      }
    }
    for (const h of this.handlers) h(msg)
  }

  onMessage(h: (m: WireMessage) => void): () => void {
    this.handlers.add(h)
    return () => this.handlers.delete(h)
  }

  request<T = any>(method: string, params?: any): Promise<T> {
    if (this.exited) return Promise.reject(new Error('连接已关闭'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.child.stdin!.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }

  respond(id: number | string, result: unknown) {
    this.child.stdin!.write(JSON.stringify({ id, result }) + '\n')
  }

  kill() {
    try {
      this.child.kill()
    } catch {}
  }
}

/** 工具参数 JSON 压缩成一行短预览 */
function compactArgs(args?: string): string {
  if (!args) return ''
  try {
    const parsed = JSON.parse(args)
    const s = JSON.stringify(parsed)
    return s.length > 200 ? s.slice(0, 200) + '…' : s
  } catch {
    return args.slice(0, 200)
  }
}

/**
 * 从 cli config 构造 runtimeModel（provider registry 快照）。
 * resume 旧会话必须带：服务端用它重新解析会话的历史模型，否则 send 会报
 * ZCODE_RUNTIME_MODEL_UNAVAILABLE（"历史任务使用的模型已不可用"）。
 */
function buildRuntimeModelFromCliConfig(): Record<string, unknown> | null {
  try {
    const home = os.homedir()
    const cfg = JSON.parse(fs.readFileSync(path.join(home, '.zcode', 'cli', 'config.json'), 'utf8'))
    const mainRef = String(cfg?.model?.main ?? '')
    const [providerId, modelId] = mainRef.split('/')
    const prov = cfg?.provider?.[providerId]
    if (!prov || !modelId) return null
    const models = Object.entries(prov.models ?? {}).map(([id, m]: [string, any]) => ({
      modelId: id,
      ...(m?.name ? { label: m.name } : {})
    }))
    if (!models.some((m) => m.modelId === modelId)) {
      models.push({ modelId })
    }
    const provider: Record<string, unknown> = {
      providerId,
      kind: prov.kind ?? 'anthropic',
      ...(prov.name ? { label: prov.name } : {}),
      ...(prov.options?.baseURL ? { baseURL: prov.options.baseURL } : {}),
      apiKey: { source: 'inline', value: prov.options?.apiKey },
      apiKeyRequired: true,
      models
    }
    return {
      revision: '0',
      generatedAt: Date.now(),
      model: { providerId, modelId },
      provider
    }
  } catch {
    return null
  }
}

export function createZcodeBackend(getPaths: () => { nodePath: string; zcodePath: string }): AgentBackend {
  return {
    id: 'zcode',
    label: 'ZCode (GLM)',
    async probe() {
      const { zcodePath, nodePath } = getPaths()
      const bundle = findZcodeBundle(zcodePath || undefined)
      if (!bundle) return { ok: false, detail: '找不到 zcode.cjs（可在设置里手动指定路径）' }
      const node = resolveNodeRuntime(nodePath || undefined)
      const nodeNote =
        node.source === 'fallback-electron'
          ? '⚠ 未找到系统 Node（zcode 需要 Node ≥ 22.5），将退回内置运行时，可能失败'
          : `node: ${node.path}`
      const cfg = ensureZcodeCliConfig()
      if (!cfg.ok) return { ok: false, detail: `${cfg.detail} · ${nodeNote}` }
      return { ok: node.source !== 'fallback-electron', detail: `${bundle} · ${cfg.detail} · ${nodeNote}` }
    },
    async start({ prompt, workdir, mode, events, resumeSessionId }) {
      const { nodePath, zcodePath } = getPaths()
      const bundle = findZcodeBundle(zcodePath || undefined)
      if (!bundle) throw new Error('找不到 zcode.cjs')
      const cfgCheck = ensureZcodeCliConfig()
      if (!cfgCheck.ok) throw new Error(cfgCheck.detail)

      const cwd = workdir && fs.existsSync(workdir) ? workdir : os.tmpdir()
      const node = resolveNodeRuntime(nodePath || undefined)
      const conn = new ZcodeConnection(node.path, bundle, cwd)
      const emit = (e: Omit<TaskEvent, 'seq' | 'ts'>) => events.onEvent({ ...e, ts: Date.now() })

      let turnResolver: ((v: { response: string; ok: boolean; error?: string }) => void) | null = null
      let currentText = ''
      /** 最后一条 assistant 消息：自上一次工具活动以来累计的文本增量 */
      let lastSegment = ''
      let lastTurnEnd: { response: string; ok: boolean; error?: string } | null = null
      /** 流式看门狗：模型偶发无限生成循环（实测 10 分钟吐 1.5MB），超限强制停止 */
      let textOverflowed = false
      const TEXT_LIMIT = 300_000
      /** 工具参数流聚合：toolCallId → {name, args} */
      const toolInputs = new Map<string, { name: string; args: string }>()
      /** 会话 id 容器（事件处理器在赋值前注册，经此读取） */
      const sessionIdHolder = { value: '' }

      /** 压平空白后比较，容忍服务端拼接消息时的换行差异 */
      const squash = (s: string) => s.replace(/\s+/g, ' ').trim()
      const handleTurnEnd = (r: { response: string; ok: boolean; error?: string }) => {
        // 协议每回合会发两种终态（完整回合回复 + 最后一条消息），只取首个完整版
        if (lastTurnEnd) return
        // 首个终态的 response 是完整回合回复：包含本回合所有中间回复（已随 text 事件
        // 流式展示过）。只保留最后一条 assistant 消息，避免 UI 终段全量回显、
        // result 与委派回灌把中间回复再吃一遍上下文
        const full = r.response
        const lastMsg = squash(lastSegment)
        const response = lastMsg && (full === currentText || squash(full).endsWith(lastMsg)) ? lastSegment : full
        // 委派标记可能出现在任意中间消息里：解析用全量文本（服务端完整回复与流式累计中取更完整的）
        const scan = full.length >= currentText.length ? full : currentText
        const ended = { ...r, response, delegationText: scan || undefined }
        lastTurnEnd = ended
        emit({ kind: 'final', text: response || r.error || '' })
        if (turnResolver) {
          const res = turnResolver
          turnResolver = null
          res(ended)
        }
        events.onTurnEnd(ended)
      }

      conn.onMessage((m) => {
        // 服务端 → 客户端 请求
        if (m.method === 'session/requestRuntimePreferences' && m.id !== undefined) {
          conn.respond(m.id, {
            askUserQuestionAutoResolutionEnabled: true,
            nativeSearchEnhancementsEnabled: true,
            memoryEnabled: false,
            modelContextBudgetStrategy: 'preflight-v1'
          })
          return
        }
        if (m.method && m.id !== undefined && String(m.id).startsWith('server-')) {
          conn.respond(m.id, {})
          return
        }
        if (m.method === 'session/event' || m.method === 'session/event/v2') {
          const p = m.params ?? {}
          const type: string = p.type ?? ''
          const payload = p.payload ?? {}
          if (type === 'model.streaming') {
            const k: string = payload.kind ?? ''
            if (k === 'text_delta') {
              const delta = payload.delta ?? ''
              currentText += delta
              lastSegment += delta
              emit({ kind: 'text', text: delta })
              if (!textOverflowed && currentText.length > TEXT_LIMIT) {
                textOverflowed = true
                emit({ kind: 'status', text: `⚠ 输出超过 ${TEXT_LIMIT / 1000}KB，疑似模型生成循环，强制停止本回合` })
                conn.request("session/stop", { sessionId: sessionIdHolder.value }).catch(() => {})
                handleTurnEnd({
                  response: currentText.slice(0, TEXT_LIMIT),
                  ok: true,
                  error: undefined
                })
              }
            } else if (k === 'tool_input_start') {
              // 工具活动开始：此后的文本属于新的一条 assistant 消息
              lastSegment = ''
              toolInputs.set(payload.toolCallId, { name: payload.toolName ?? '', args: '' })
            } else if (k === 'tool_input_delta') {
              const ti = toolInputs.get(payload.toolCallId)
              if (ti) ti.args += payload.delta ?? ''
            }
            // tool_input_end / 其余 streaming 子类静默
          } else if (type === 'tool.updated') {
            const k: string = payload.kind ?? ''
            if (k === 'started') {
              lastSegment = ''
              const ti = toolInputs.get(payload.toolCallId)
              emit({
                kind: 'tool',
                text: payload.toolName ?? ti?.name ?? '',
                data: {
                  phase: 'started',
                  toolCallId: payload.toolCallId,
                  args: compactArgs(ti?.args)
                }
              })
            } else if (k === 'result') {
              lastSegment = ''
              const res = payload.result ?? {}
              const preview =
                typeof res.content === 'string'
                  ? res.content.slice(0, 400)
                  : typeof res.content === 'object' && res.content !== null
                    ? JSON.stringify(res.content).slice(0, 400)
                    : ''
              emit({
                kind: 'tool',
                text: payload.toolName ?? toolInputs.get(payload.toolCallId)?.name ?? '',
                data: {
                  phase: 'result',
                  toolCallId: payload.toolCallId,
                  ok: res.success !== false,
                  durationMs: payload.duration ?? res?.perf?.totalMs,
                  preview
                }
              })
            }
            // scheduled 阶段静默
          } else if (payload.response !== undefined && payload.usage !== undefined) {
            // 回合终态：payload 带 response + usage。
            // telemetry 的 turn.terminal 可能先到并已发过 usage/final，此时跳过，避免每回合双份用量
            const alreadyEnded = lastTurnEnd !== null
            handleTurnEnd({
              response: String(payload.response ?? ''),
              ok: payload.resultType !== 'error',
              error: payload.resultType === 'error' ? String(payload.response ?? '') : undefined
            })
            if (payload.usage && !alreadyEnded) {
              emit({ kind: 'usage', data: payload.usage })
            }
          } else if (type === 'checkpoint.created') {
            emit({ kind: 'status', text: 'checkpoint' })
          } else if (type === 'model.request.status') {
            emit({ kind: 'status', text: payload.status ?? '' })
          }
          // session.titleUpdated / session.updated / turn.started / streamRecovery.updated 等噪音静默
          return
        }
        if (m.method === 'state.updated') {
          const status = m.params?.patch?.status
          if (status) emit({ kind: 'status', text: `session:${status}` })
          return
        }
        if (m.method === 'v4/telemetry/event') {
          const kind: string = m.params?.kind ?? ''
          if (kind === 'turn.terminal') {
            // 备用终态信号：若尚未触发 handleTurnEnd
            if (!lastTurnEnd) {
              handleTurnEnd({
                response: currentText,
                ok: m.params?.status === 'success',
                error: m.params?.status === 'success' ? undefined : `turn ended: ${m.params?.status}`
              })
              // 只有在走备用路径时才补 usage（正常路径已由 session/event 发过）
              const u = m.params
              if (u && (u.tokenCount || u.durationMs)) {
                emit({ kind: 'usage', data: { tokenCount: u.tokenCount, durationMs: u.durationMs, toolCallCount: u.toolCallCount } })
              }
            }
          }
          // telemetry 的 model.request.status 与 session/event 重复，静默
          return
        }
        if (m.method === 'interaction/requestPermission' && m.id !== undefined) {
          const p = m.params ?? {}
          const options: Array<{ optionId: string; name: string; description?: string; response: { decision: string } }> =
            (p.options ?? []).map((o: any) => ({
              optionId: o.optionId,
              name: o.name ?? o.kind ?? '',
              description: o.description,
              response: o.response ?? { decision: 'allow' }
            }))
          const req = {
            requestId: m.id,
            toolName: p.toolName ?? '',
            reason: p.reason ?? '',
            riskLevel: p.riskLevel ?? '',
            input: p.input,
            options
          }
          const reqId = m.id
          if (events.onPermission) {
            emit({
              kind: 'status',
              text: `权限请求: ${req.toolName} (${req.riskLevel})`
            })
            events
              .onPermission(req)
              .then((choice) => {
                const chosen =
                  options.find((o) => o.optionId === choice.optionId) ??
                  options.find((o) => o.response.decision === choice.decision) ??
                  options[0]
                conn.respond(reqId, chosen?.response ?? { decision: 'deny' })
                emit({ kind: 'status', text: `权限已${chosen?.response.decision === 'deny' ? '拒绝' : '放行'}: ${req.toolName}` })
              })
              .catch(() => {
                conn.respond(reqId, { decision: 'deny' })
              })
          } else {
            // 无处理器（yolo 语义）自动放行
            conn.respond(m.id, options.find((o) => o.response.decision === 'allow')?.response ?? { decision: 'allow' })
            emit({ kind: 'status', text: `permission:auto-allowed: ${req.toolName}` })
          }
          return
        }
        // 其余通知忽略（process/resourceSample 等）
      })

      emit({ kind: 'status', text: 'starting app-server' })
      let sessionId: string
      if (resumeSessionId) {
        const runtimeModel = buildRuntimeModelFromCliConfig()
        const resumed = await conn.request<any>('session/resume', {
          sessionId: resumeSessionId,
          workspace: { workspaceKey: cwd, workspacePath: cwd },
          ...(runtimeModel ? { runtimeModel } : {})
        })
        sessionId = resumed?.session?.sessionId ?? resumeSessionId
        emit({ kind: 'status', text: runtimeModel ? '会话已恢复' : '会话已恢复（未带模型注册表）' })
      } else {
        const created = await conn.request<any>('session/create', {
          workspace: { workspaceKey: cwd, workspacePath: cwd },
          mode: mode || 'yolo'
        })
        sessionId = created?.session?.sessionId
      }
      if (!sessionId) throw new Error('会话创建/resume 未返回 sessionId')
      sessionIdHolder.value = sessionId
      await conn.request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' })
      currentText = ''
      lastSegment = ''
      lastTurnEnd = null
      textOverflowed = false
      await conn.request('session/send', { sessionId, content: prompt })

      const session: BackendSession = {
        sessionId,
        async send(content: string) {
          currentText = ''
          lastSegment = ''
          lastTurnEnd = null
          textOverflowed = false
          const p = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              turnResolver = null
              reject(new Error('等待回合结束超时（30 分钟）'))
            }, 30 * 60 * 1000)
            turnResolver = (r) => {
              clearTimeout(timer)
              r.ok ? resolve() : reject(new Error(r.error || '回合失败'))
            }
          })
          await conn.request('session/send', { sessionId, content })
          await p
        },
        async stop() {
          try {
            await conn.request('session/stop', { sessionId })
          } catch {}
        },
        async close() {
          try {
            await Promise.race([
              conn.request('session/close', { sessionId }),
              new Promise((r) => setTimeout(r, 1500))
            ])
          } catch {}
          conn.kill()
        }
      }
      return session
    }
  }
}

// 首条消息的回合等待由 start 的调用方（runner）通过 onTurnEnd 接收
export type { BackendSessionEvents }
