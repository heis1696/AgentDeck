// DeepSeek Harness 的 ACP（Agent Client Protocol）常驻服务接入。
// dsh headless 一次性纯文本模式运行期零输出，看门狗只能靠固定预算兜底、
// UI 全程黑箱、且不支持续聊。ACP server 走 NDJSON JSON-RPC over stdio：
// committed assistant 消息以 session/update 实时推送（心跳+流式文本）、
// 同连接多 prompt 即续聊、session/request_permission 桥接权限确认。
// 协议限制：仅新建会话（无跨进程 resume）、工具活动不上协议（长工具静默期
// 仍靠 runner 的 dsh 固定回合预算兜底）。
// 组合配置内嵌为模板（源自 deepseek-harness examples/acp-agent/cordis.yml，
// 改动：凭证行接管 ~/.dsh/.credentials.yaml、Windows 用 pwsh 沙箱行、
// provider/model/会话落盘根经 AGENTDECK_DSH_* 环境变量参数化）。
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { TaskEvent } from '../../shared/types'
import type { PermissionRequest } from '../../shared/contracts'
import type { BackendSession, BackendSessionEvents, BackendTurnStamp } from './types'
import { bindTurn } from './types'
import { killProcessTree } from './cli-common'
import { findSystemNode } from './cli-locator'

/** ACP 组合 yml（运行期写入临时文件交给 dsh-acp-demo bin --config 加载）。
 *  `!!js` 表达式由 dsh 配置加载器在服务进程内求值，这里只保留字面文本。 */
const ACP_COMPOSITION = `# AgentDeck 的 dsh ACP 组合：基于 deepseek-harness examples/acp-agent/cordis.yml。
# stdout 只承载 JSON-RPC，诊断一律走 stderr；无日志行、无 HMR。
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    thinking: enabled
    reasoningEffort: max
    models:
      - id: deepseek-v4-flash
      - id: deepseek-v4-pro

# 凭证：托管文档 ~/.dsh/.credentials.yaml 优先，继承环境与 .env 兜底
# （否则每次启动都要外部注入 DEEPSEEK_API_KEY）。
- id: credentials
  name: '@deepseek-ai/dsh-credentials-local'

- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'

- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
  config:
    mode: !!js "process.env.DSH_PERMISSION_MODE ?? 'workspace-write'"
    workspaceRoot: !!js process.cwd()

- id: subprocess
  name: '@deepseek-ai/dsh-subprocess-local'

# shell 沙箱按平台分行（与 dsh-base 一致）：Windows 上 bash-sandbox 走
# Linux 服务隔离，会以 E_ACCESSDENIED 拒绝执行，必须换 pwsh 行。
- id: bash
  name: '@deepseek-ai/dsh-bash-sandbox'
  disabled: !!js process.platform === 'win32'
  config:
    timeoutMs: 60000

- id: pwsh
  name: '@deepseek-ai/dsh-pwsh-sandbox'
  disabled: !!js process.platform !== 'win32'

- id: approval
  name: '@deepseek-ai/dsh-user-approval'
  config:
    policy: !!js "(process.env.DSH_PERMISSION_MODE ?? 'workspace-write') === 'danger-full-access' ? 'never' : 'ask'"

- id: acp-agent
  name: '@deepseek-ai/dsh-acp-demo'
  config:
    provider: !!js "process.env.AGENTDECK_DSH_PROVIDER ?? 'deepseek-official'"
    model: !!js "process.env.AGENTDECK_DSH_MODEL ?? 'deepseek-v4-pro'"
    persistenceRoot: !!js "process.env.AGENTDECK_DSH_SESSIONS_ROOT ?? './.sessions'"
    persistenceCompression: zstd
    workspaceContext:
      maxBytes: 65536
    persona: |
      You are a coding assistant powered by the {{model}} model. Your working directory is {{cwd}}. Your bash tool runs under a file sandbox — a \`[sandbox: file access denied …]\` result is policy, not a command bug.

      Verify your work by running the code or tests. Keep answers brief and factual.

- id: token-meter
  name: '@deepseek-ai/dsh-token-meter'

- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  config:
    thresholdRatio: 0.8
    retainRatio: 0.08
    maxTokens: 8192
    compactionRetries: 1

- id: session-projection
  name: '@deepseek-ai/dsh-session-projection'

- id: fs-sandbox
  name: '@deepseek-ai/dsh-fs-sandbox'
  config:
    cwd: !!js process.cwd()

- id: fs-observation-policy
  name: '@deepseek-ai/dsh-fs-observation-policy'

- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'

- id: tool-todo
  name: '@deepseek-ai/dsh-tool-todo'
  config:
    allowParallelInProgress: true
`

export interface DshAcpBin {
  node: string
  /** dsh-acp-demo 的 bin.js（<repo>/packages/examples/acp-demo/lib/bin.js） */
  bin: string
  /** deepseek-harness 仓库根（组合配置与插件链接的落点） */
  repoRoot: string
}

/** 定位 ACP server 组件：优先 dshPath 设置指向的仓库，其次常规安装根扫描 */
export function findDshAcpBin(dshBinPath?: string): DshAcpBin & { repoRoot: string } | null {
  const roots: string[] = []
  if (dshBinPath) {
    // 设置页给的可能是 cli bin.js 或仓库根：向上归一到 deepseek-harness 根
    let dir = path.dirname(path.resolve(dshBinPath))
    for (let i = 0; i < 4; i++) {
      if (path.basename(dir).toLowerCase() === 'deepseek-harness') { roots.push(dir); break }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  for (const base of [process.env.DSH_HOME, 'D:\\Program Files', process.env.ProgramFiles ?? 'C:\\Program Files', path.join(os.homedir(), 'Projects'), os.homedir()]) {
    if (base) roots.push(path.join(base, 'deepseek-harness'))
  }
  const node = findSystemNode() ?? process.execPath
  for (const repoRoot of roots) {
    const bin = path.join(repoRoot, 'packages', 'examples', 'acp-demo', 'lib', 'bin.js')
    if (fs.existsSync(bin)) return { node, bin, repoRoot }
  }
  return null
}

/** 启动期失败（握手/建会话/进程早退）：dsh.ts 捕获后回退 headless */
export class AcpBootError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AcpBootError'
  }
}

/**
 * Windows 沙箱行自愈：组合配置引用 @deepseek-ai/dsh-pwsh-sandbox，但源码仓库的
 * examples 工作区（组合配置的解析锚）未链接它（demo 组合是 Linux 向的）。
 * 按需补一个 junction——与 pnpm 链接 workspace 包的方式一致，pnpm install
 * 会清掉、下次启动重建。失败不致命：boot 会给出缺包错误并回退 headless。
 */
function ensureWin32PwshLink(repoRoot: string) {
  if (process.platform !== 'win32') return
  const scope = path.join(repoRoot, 'examples', 'node_modules', '@deepseek-ai')
  const link = path.join(scope, 'dsh-pwsh-sandbox')
  if (fs.existsSync(link)) return
  const target = path.join(repoRoot, 'packages', 'shell', 'pwsh-sandbox')
  if (!fs.existsSync(path.join(target, 'package.json'))) return
  fs.mkdirSync(scope, { recursive: true })
  try {
    fs.symlinkSync(target, link, 'junction')
  } catch {
    // 无权限或被策略拦截：留给 boot 报缺包错误
  }
}

interface AcpTurn {
  texts: string[]
  resolve: (r: { ok: boolean; response: string; error?: string }) => void
}

interface JsonRpcMessage {
  jsonrpc?: string
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message: string }
}

/** NDJSON JSON-RPC 双向路由：响应按 id 分发、通知回调、服务端请求可应答 */
class AcpConnection {
  private child: ChildProcess
  private closed = false
  private exitPromise: Promise<{ code: number | null; stderrTail: string }> | undefined
  private nextId = 1
  private pending = new Map<number, { resolve: (v: { result?: unknown; error?: { message: string } }) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private buffer = ''
  private stderrTail = ''
  onNotification: (method: string, params: Record<string, unknown>) => void = () => {}
  onServerRequest: (id: number, method: string, params: Record<string, unknown>) => void = () => {}

  constructor(
    command: string,
    args: string[],
    cwd: string,
    env: Record<string, string>
  ) {
    this.child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.child.stdout!.setEncoding('utf8')
    this.child.stdout!.on('data', (chunk: string) => this.consume(chunk))
    this.child.stderr!.setEncoding('utf8')
    this.child.stderr!.on('data', (c: string) => { this.stderrTail = (this.stderrTail + c).slice(-1500) })
  }

  /** 进程退出（含被杀，单一缓存 promise 防监听堆积）；stderrTail 供错误信息 */
  get exited(): Promise<{ code: number | null; stderrTail: string }> {
    if (!this.exitPromise) {
      this.exitPromise = new Promise((resolve) => {
        this.child.once('exit', (code) => resolve({ code, stderrTail: this.stderrTail.trim() }))
        this.child.once('error', (err) => resolve({ code: -1, stderrTail: String(err) }))
      })
    }
    return this.exitPromise
  }

  private consume(chunk: string) {
    this.buffer += chunk
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (!line) continue
      let msg: JsonRpcMessage
      try { msg = JSON.parse(line) as JsonRpcMessage } catch { continue }
      if (typeof msg.id === 'number' && msg.method) {
        this.onServerRequest(msg.id, msg.method, (msg.params ?? {}) as Record<string, unknown>)
      } else if (typeof msg.id === 'number') {
        const waiter = this.pending.get(msg.id)
        if (waiter) {
          this.pending.delete(msg.id)
          clearTimeout(waiter.timer)
          if (msg.error) waiter.resolve({ error: msg.error })
          else waiter.resolve({ result: msg.result })
        }
      } else if (msg.method) {
        this.onNotification(msg.method, (msg.params ?? {}) as Record<string, unknown>)
      }
    }
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<{ result?: unknown; error?: { message: string } }> {
    if (this.closed) return Promise.reject(new Error('dsh ACP server 已关闭'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`dsh ACP ${method} 超时（${Math.round(timeoutMs / 1000)}s 无响应）`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: unknown) {
    if (this.closed) return
    this.write({ jsonrpc: '2.0', method, params })
  }

  respond(id: number, result: unknown) {
    this.write({ jsonrpc: '2.0', id, result })
  }

  private write(obj: unknown) {
    try { this.child.stdin!.write(JSON.stringify(obj) + '\n') } catch {}
  }

  async kill() {
    this.closed = true
    const error = new Error('dsh ACP server 已关闭')
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      this.pending.delete(id)
      pending.reject(error)
    }
    const result = await killProcessTree(this.child)
    // taskkill/kill terminates the process tree but Windows may keep the
    // parent-side stdio handles alive until explicitly destroyed. Close them
    // so a finished ACP smoke/application can actually drain its event loop.
    try { this.child.stdin?.destroy() } catch {}
    try { this.child.stdout?.destroy() } catch {}
    try { this.child.stderr?.destroy() } catch {}
    return result
  }
}

export interface DshAcpSessionOptions {
  prompt: string
  workdir: string
  mode: string
  model?: string
  events: BackendSessionEvents
  acp: DshAcpBin
  /** 首回合身份：本连接会把消息归属到它，并原样回传 */
  turn?: BackendTurnStamp
}

/**
 * 启动 ACP server 并跑通首回合，返回可续聊的 BackendSession。
 * 任何启动期（spawn/initialize/session/new）失败都抛 AcpBootError，
 * 调用方（dsh.ts）据此回退 headless 一次性模式。
 */
export async function startDshAcpSession(opts: DshAcpSessionOptions): Promise<BackendSession> {
  const { prompt, workdir, mode, model, events, acp, turn: firstTurn } = opts
  /**
   * 本连接"在飞回合"的发射通道：**每个回合一个不可变通道**（bindTurn 固定住身份），
   * 换回合只换指针、绝不改写既有通道。没有回合身份时退回会话级通道（老调用方零变化），
   * 归属由上层按"未标记回调"处理。
   */
  let active: BackendSessionEvents | undefined = firstTurn ? bindTurn(events, firstTurn) : events
  const channel = () => active
  const setTurn = (stamp?: BackendTurnStamp) => {
    active = stamp ? bindTurn(events, stamp) : events
  }
  const emit = (e: Omit<TaskEvent, 'seq' | 'ts'>) => channel()?.onEvent({ ...e, ts: Date.now() })

  // 组合配置必须落在 dsh 仓库的 examples 工作区内：loader 以 config 所在目录为
  // 锚向上解析 @deepseek-ai/* 插件包（examples/acp-agent 是唯一同时链接
  // acp-demo 与 llm/credentials 组件的锚点；系统 tmp 或仓库根都解析不到）。
  const configDir = path.join(acp.repoRoot, 'examples', 'acp-agent')
  const configPath = path.join(configDir, 'agentdeck.cordis.yml')
  try {
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(configPath, ACP_COMPOSITION, 'utf8')
    ensureWin32PwshLink(acp.repoRoot)
  } catch (e) {
    throw new AcpBootError(`无法在 dsh 仓库内准备 ACP 组合配置（${configPath}）：${e instanceof Error ? e.message : String(e)}`)
  }
  // 会话落盘默认走 ~/.agentdeck（对齐共享目录约定）
  const sessionsRoot = process.env.AGENTDECK_DSH_SESSIONS_ROOT
    ?? path.join(os.homedir(), '.agentdeck', 'dsh-sessions')
  fs.mkdirSync(sessionsRoot, { recursive: true })

  const env: Record<string, string> = {
    // electron 充当 node 时必须带此标记，否则按 GUI 应用启动不退出
    ...(acp.node === process.execPath ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    // yolo 全放行（与 claude --dangerously-skip-permissions 同语义）；其余模式走沙箱+审批
    DSH_PERMISSION_MODE: mode === 'yolo' ? 'danger-full-access' : 'workspace-write',
    AGENTDECK_DSH_SESSIONS_ROOT: sessionsRoot
  }
  if (model) {
    if (model.includes('/')) {
      env.AGENTDECK_DSH_PROVIDER = model.split('/')[0]
      env.AGENTDECK_DSH_MODEL = model.split('/')[1]
    } else {
      env.AGENTDECK_DSH_MODEL = model
    }
  }

  const conn = new AcpConnection(acp.node, [acp.bin, '--config', configPath], workdir || process.cwd(), env)

  // spawn 后立刻注册停止句柄：启动窗口期（握手最长 30s+30s）的取消/看门狗
  // 硬杀靠它，等会话建好再注册就会留杀不掉的孤儿进程
  events.onLaunch?.({ stop: () => conn.kill() })

  let turn: AcpTurn | undefined
  const settleTurn = (r: { ok: boolean; response: string; error?: string }) => {
    if (!turn) return
    const t = turn
    turn = undefined
    channel()?.onTurnEnd({ response: r.response, ok: r.ok, error: r.error })
    t.resolve(r)
  }

  conn.onNotification = (method, params) => {
    channel()?.onHeartbeat?.() // 任何协议消息都是进展：看门狗续命
    if (method !== 'session/update') return
    const update = (params.update ?? {}) as Record<string, unknown>
    if (update.sessionUpdate !== 'agent_message_chunk') return
    const content = (update.content ?? {}) as Record<string, unknown>
    if (content.type === 'text' && typeof content.text === 'string' && content.text) {
      turn?.texts.push(content.text)
      emit({ kind: 'text', text: content.text })
    }
  }

  conn.onServerRequest = (id, method, params) => {
    if (method !== 'session/request_permission') {
      conn.respond(id, { error: { code: -32601, message: `agentdeck 不支持 ${method}` } })
      return
    }
    void (async () => {
      const options = Array.isArray(params.options)
        ? (params.options as Record<string, unknown>[]).map((o) => {
            const optionId = typeof o.optionId === 'string' ? o.optionId : 'reject-once'
            const kind = typeof o.kind === 'string' ? o.kind : ''
            return {
              optionId,
              name: typeof o.name === 'string' ? o.name : optionId,
              allow: kind.startsWith('allow') || optionId.startsWith('allow')
            }
          })
        : []
      const toolCall = (params.toolCall ?? {}) as Record<string, unknown>
      const request: PermissionRequest = {
        requestId: `dsh_acp_${id}`,
        toolName: typeof toolCall.title === 'string' && toolCall.title ? toolCall.title : 'dsh 工具调用',
        reason: 'dsh 请求工具执行确认（ACP one-shot）',
        riskLevel: 'medium',
        input: typeof toolCall.toolCallId === 'string' ? toolCall.toolCallId : '',
        options: options.length
          ? options.map((o) => ({ optionId: o.optionId, name: o.name, response: { decision: (o.allow ? 'allow' : 'deny') as 'allow' | 'deny' } }))
          : [{ optionId: 'allow-once', name: 'Allow once', response: { decision: 'allow' as const } }]
      }
      const choice = channel()?.onPermission
        ? await channel()!.onPermission!(request).catch(() => ({ decision: 'deny' as const }))
        : { decision: 'allow' as const } // 未提供权限回调时自动放行（接口约定）
      const chosen = choice.decision === 'allow'
        ? (options.find((o) => o.allow && o.optionId === choice.optionId) ?? options.find((o) => o.allow))
        : undefined
      conn.respond(id, { outcome: { outcome: 'selected', optionId: chosen?.optionId ?? 'reject-once' } })
    })()
  }

  // 启动握手失败要让调用方回退 headless：进程早退同样算启动失败
  const bootExit = conn.exited.then((info) => {
    throw new AcpBootError(`dsh ACP server 退出 code=${info.code}${info.stderrTail ? ': ' + info.stderrTail.slice(0, 200) : ''}`)
  })
  const boot = (async () => {
    const init = await conn.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }
    }, 30_000)
    if (init.error) throw new AcpBootError(`dsh ACP initialize 失败: ${init.error.message}`)
    const created = await conn.request('session/new', {
      cwd: path.resolve(workdir || process.cwd()),
      mcpServers: []
    }, 30_000)
    if (created.error) throw new AcpBootError(`dsh ACP session/new 失败: ${created.error.message}`)
    const sessionId = (created.result as Record<string, unknown> | undefined)?.sessionId
    if (typeof sessionId !== 'string' || !sessionId) throw new AcpBootError('dsh ACP session/new 未返回 sessionId')
    return sessionId
  })()

  let sessionId: string
  try {
    sessionId = await Promise.race([boot, bootExit])
  } catch (e) {
    void conn.kill().catch(() => {})
    throw e
  }
  // 启动成功后进程退出不再构成"启动失败"：吞掉 bootExit 的迟到拒绝
  void bootExit.catch(() => {})
  channel()?.onSessionId?.(sessionId)
  emit({ kind: 'status', text: 'dsh ACP 会话就绪（流式事件/续聊）' })

  const runTurn = async (content: string, stamp?: BackendTurnStamp) => {
    // 新回合开新通道：旧通道连同它的身份一起作废，迟到消息带不回新回合
    setTurn(stamp)
    const result = new Promise<{ ok: boolean; response: string; error?: string }>((resolve) => {
      turn = { texts: [], resolve }
    })
    void conn.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: content }]
    }, 24 * 60 * 60 * 1000).then(
      (r) => {
        if (r.error) {
          settleTurn({ ok: false, response: '', error: `dsh ACP prompt 失败: ${r.error.message}` })
          return
        }
        const stopReason = (r.result as Record<string, unknown> | undefined)?.stopReason
        if (stopReason === 'cancelled') {
          settleTurn({ ok: false, response: '', error: '回合已取消' })
          return
        }
        const texts = turn?.texts ?? []
        const response = (texts.length ? texts[texts.length - 1] : '').trim()
        if (response) emit({ kind: 'final', text: response })
        settleTurn({ ok: !!response || stopReason !== 'max_tokens', response })
      },
      (e: unknown) => {
        settleTurn({ ok: false, response: '', error: e instanceof Error ? e.message : String(e) })
      }
    )
    const early = await Promise.race([
      result,
      // 进程中途退出：裁决进行中的回合，不再让 send 永悬
      conn.exited.then((info) => ({ __exit: true as const, ...info }))
    ])
    if ('__exit' in early) {
      settleTurn({ ok: false, response: '', error: `dsh ACP server 进程退出 code=${early.code}${early.stderrTail ? ': ' + early.stderrTail.slice(0, 200) : ''}` })
      return result
    }
    return early
  }

  const first = await runTurn(prompt, firstTurn)
  if (!first.ok && first.error) throw new Error(first.error)

  return {
    sessionId,
    // ACP's session/prompt response is the protocol turn boundary: the next
    // prompt is not sent until that response has settled all prior updates.
    turnScoped: true,
    async send(content, stamp) {
      const r = await runTurn(content, stamp)
      if (!r.ok && r.error) throw new Error(r.error)
    },
    async stop() {
      conn.notify('session/cancel', { sessionId })
    },
    async close() {
      settleTurn({ ok: false, response: '', error: '会话已关闭' })
      // 关闭即断开归属：之后连接上再冒出来的消息不再属于任何回合
      active = undefined
      await conn.kill()
    }
  }
}
