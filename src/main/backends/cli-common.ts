// 一次性 CLI 进程的公共基座：spawn + JSONL 行解析 + 看门狗 + 进程清理
// 适用于 claude / codex / opencode（zcode 是常驻服务，单独实现）
import { spawn, type ChildProcess } from 'node:child_process'
import type { TaskEvent } from '../../shared/types'

export type JsonPrimitive = string | number | boolean | null
/** Parsed JSON is intentionally unknown at the transport boundary; adapters validate fields. */
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export function isJsonObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Kill a CLI and every tool process it spawned. */
export function killProcessTree(child: ChildProcess) {
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      child.kill('SIGKILL')
    }
  } catch {}
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
  kill: () => void
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
}): CliJsonlRunner {
  const child = spawn(opts.command, [...opts.prefixArgs, ...opts.args], {
    cwd: opts.cwd,
    ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  let stderrTail = ''
  let total = 0
  let buffer = ''
  let killed = false
  let lineCount = 0
  let parseErrors = 0
  /** 杀整棵进程树：CLI 会再起自己的子进程（shell/工具进程），只 kill 直接子进程会留下
   *  继续打 API 的孤儿（429 残留来源之一）。Windows 用 taskkill /T /F 走 PID 树。 */
  const killTree = () => {
    killed = true
    killProcessTree(child)
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
      killTree()
    }
  }
}

/** 工具调用事件构造助手 */
export function toolEvent(phase: 'started' | 'result', name: string, data: Record<string, unknown>): Omit<TaskEvent, 'seq' | 'ts'> {
  return { kind: 'tool', text: name, data: { phase, ...data } }
}
