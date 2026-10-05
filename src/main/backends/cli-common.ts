// 一次性 CLI 进程的公共基座：spawn + JSONL 行解析 + 看门狗 + 进程清理
// 适用于 claude / codex / opencode（zcode 是常驻服务，单独实现）
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import type { TaskEvent, ToolEditMeta } from '../../shared/types'

export type JsonPrimitive = string | number | boolean | null
/** Parsed JSON is intentionally unknown at the transport boundary; adapters validate fields. */
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export function isJsonObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export interface KillProcessResult {
  ok: boolean
  code?: number | null
  error?: string
}

/** Kill a CLI and every tool process it spawned, returning when the kill
 * request has completed. The bounded wait keeps shutdown observable without
 * hanging forever on a provider that ignores termination. */
const processTreeKills = new WeakMap<ChildProcess, Promise<KillProcessResult>>()

export function killProcessTree(child: ChildProcess): Promise<KillProcessResult> {
  const existing = processTreeKills.get(child)
  if (existing) return existing
  const pending = new Promise<KillProcessResult>((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    let killer: ChildProcess | undefined
    let childClosed = false
    let killCompleted = true
    let killError: KillProcessResult | undefined
    const finish = (result: KillProcessResult) => {
      if (settled) return
      settled = true
      // 杀失败但根进程已可验证地退出（exitCode/signalCode 已落）：无可杀即已杀灭。
      // 一次性 CLI 的回合结果先于进程退出到达，紧接的终止会让 taskkill 撞上
      // 「进程刚死」窗口（实战 128/255 均见）；根已死时 /T 也够不着任何后代，
      // 报失败只会让会议停止收不了口，不带来任何额外清理。
      const rootGone = child.exitCode !== null || child.signalCode !== null
      if (timer) clearTimeout(timer)
      child.removeListener('close', onClose)
      child.removeListener('error', onError)
      killer?.removeListener('error', onError)
      killer?.removeListener('close', onKillClose)
      resolve(!result.ok && rootGone ? { ok: true, code: child.exitCode } : result)
    }
    const complete = () => {
      if (childClosed && killCompleted) finish(killError ?? { ok: true, code: child.exitCode })
    }
    const onClose = () => { childClosed = true; complete() }
    const onKillClose = (code: number | null) => {
      if (code !== 0) killError = { ok: false, code, error: `taskkill exited ${code}` }
      killCompleted = true
      complete()
    }
    const onError = (error: Error) => finish({ ok: false, error: error.message })
    const exited = child.exitCode !== null || child.signalCode !== null
    if (exited) {
      killCompleted = true
      if ((!child.stdin || child.stdin.destroyed) && (!child.stdout || child.stdout.destroyed) && (!child.stderr || child.stderr.destroyed)) {
        finish({ ok: true, code: child.exitCode })
        return
      }
    }
    timer = setTimeout(() => finish(killError ?? { ok: false, error: 'process kill timed out' }), 2_000)
    child.once('close', onClose)
    child.once('error', onError)
    try {
      if (exited) return
      if (process.platform === 'win32' && child.pid) {
        killCompleted = false
        killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        killer.once('error', onError)
        killer.once('close', onKillClose)
      } else if (!child.killed && !child.kill('SIGKILL')) {
        finish({ ok: false, error: 'process kill was rejected' })
      }
    } catch (error) {
      finish({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })
  processTreeKills.set(child, pending)
  void pending.then((result) => {
    if (!result.ok && processTreeKills.get(child) === pending) processTreeKills.delete(child)
  })
  return pending
}

export function jsonObject(value: unknown): JsonObject {
  return isJsonObject(value) ? value : {}
}

export function jsonString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

export function jsonNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export interface CliJsonlRunner {
  child: ChildProcess
  /** 进程退出（含被杀）；stderrTail 供错误信息 */
  exited: Promise<{
    code: number | null
    signal?: NodeJS.Signals | null
    stderrTail: string
    stdoutBytes: number
    lineCount: number
    parseErrors: number
  }>
  kill: () => Promise<KillProcessResult>
}

/** 可执行路径等值判定：win32 路径大小写不敏感，同一可执行文件的别名写法（大小写
 *  差异）必须判等——否则 command 以别名写法登记时漏判「command 即 electron 本体」，
 *  漏打 ELECTRON_RUN_AS_NODE 兜底、打包版把自己再启动一遍。大小写敏感平台（posix
 *  文件名大小写即身份）精确比较。 */
export function sameExecutablePath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left)
  const resolvedRight = path.resolve(right)
  return process.platform === 'win32' ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase() : resolvedLeft === resolvedRight
}

export function runCliJsonl(opts: {
  command: string
  prefixArgs: string[]
  args: string[]
  cwd: string
  onLine: (obj: unknown, raw: string) => void
  onRaw?: (line: string) => void
  /** 无输出超时（默认 10 分钟） */
  idleTimeoutMs?: number
  /** 总输出上限（默认 5MB，防退化循环） */
  maxTotalBytes?: number
  /** 附加环境变量（默认继承主进程 env） */
  env?: Record<string, string>
  /** 投喂到子进程 stdin 的载荷（写完即关）。超长 prompt 必须走这里：
   *  argv 版在 Windows 撞 CreateProcess 32767 字符命令行上限（spawn ENAMETOOLONG）。 */
  stdin?: string
}): CliJsonlRunner {
  // 兜底场景 command = process.execPath（electron 充当 node，见 cli-locator）：
  // 不带 ELECTRON_RUN_AS_NODE 打包版会忽略脚本参数把自己再启动一遍
  const env: NodeJS.ProcessEnv = opts.env ? { ...process.env, ...opts.env } : { ...process.env }
  if (process.versions.electron && sameExecutablePath(opts.command, process.execPath)) {
    env.ELECTRON_RUN_AS_NODE = '1'
  }
  const child = spawn(opts.command, [...opts.prefixArgs, ...opts.args], {
    cwd: opts.cwd,
    env,
    stdio: [opts.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  if (opts.stdin !== undefined && child.stdin) {
    // CLI 早退时 stdin 端会断（EPIPE）：错误吞掉——进程退出/看门狗路径已能给出具名失败
    child.stdin.on('error', () => {})
    child.stdin.end(opts.stdin)
  }
  let stderrTail = ''
  let total = 0
  let buffer = ''
  let killed = false
  let lineCount = 0
  let parseErrors = 0
  let killPromise: Promise<KillProcessResult> | undefined
  /** 杀整棵进程树：CLI 会再起自己的子进程（shell/工具进程），只 kill 直接子进程会留下
   *  继续打 API 的孤儿（429 残留来源之一）。Windows 用 taskkill /T /F 走 PID 树。 */
  const killTree = () => {
    killed = true
    if (!killPromise) {
      const pending = killProcessTree(child)
      killPromise = pending
      void pending.then((result) => {
        if (!result.ok && killPromise === pending) killPromise = undefined
      })
    }
    return killPromise
  }
  const idleTimer = setTimeout(() => {
    killTree()
  }, opts.idleTimeoutMs ?? 10 * 60 * 1000)

  child.stdout!.setEncoding('utf8')
  child.stdout!.on('data', (chunk: string) => {
    clearTimeout(idleTimer)
    if (!killed) idleTimer.refresh()
    total += chunk.length
    if (total > (opts.maxTotalBytes ?? 5 * 1024 * 1024)) {
      killTree()
      return
    }
    buffer += chunk
    let idx: number
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line) continue
      lineCount++
      try {
        opts.onLine(JSON.parse(line), line)
      } catch {
        parseErrors++
        opts.onRaw?.(line)
      }
    }
  })
  child.stderr!.on('data', (c: Buffer) => {
    stderrTail = (stderrTail + c.toString()).slice(-1500)
  })

  const exited = new Promise<CliJsonlRunner['exited'] extends Promise<infer T> ? T : never>((resolve) => {
    child.on('exit', (code, signal) => {
      clearTimeout(idleTimer)
      const trailing = buffer.trim()
      if (trailing) {
        lineCount++
        try {
          opts.onLine(JSON.parse(trailing), trailing)
        } catch {
          parseErrors++
          opts.onRaw?.(trailing)
        }
      }
      resolve({ code, signal, stderrTail: stderrTail.trim(), stdoutBytes: total, lineCount, parseErrors })
    })
    child.on('error', (err) => {
      clearTimeout(idleTimer)
      resolve({ code: -1, signal: null, stderrTail: String(err), stdoutBytes: total, lineCount, parseErrors })
    })
  })

  return {
    child,
    exited,
    kill() {
      return killTree()
    }
  }
}

/** 工具调用事件构造助手 */
export function toolEvent(
  phase: 'started' | 'result',
  name: string,
  data: Record<string, unknown>,
  /** 可选编辑元数据（edit-meta.ts 的 parseEditMeta 产出）：附到 data.edit 供渲染层做 file +N -M 角标 */
  edit?: ToolEditMeta | null
): Omit<TaskEvent, 'seq' | 'ts'> {
  return { kind: 'tool', text: name, data: { phase, ...data, ...(edit ? { edit } : {}) } }
}
