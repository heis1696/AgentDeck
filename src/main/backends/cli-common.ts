// 一次性 CLI 进程的公共基座：spawn + JSONL 行解析 + 看门狗 + 进程清理
// 适用于 claude / codex / opencode（zcode 是常驻服务，单独实现）
import { spawn, type ChildProcess } from 'node:child_process'
import type { TaskEvent } from '../../shared/types'

export interface CliJsonlRunner {
  child: ChildProcess
  /** 进程退出（含被杀）；stderrTail 供错误信息 */
  exited: Promise<{ code: number | null; stderrTail: string }>
  kill: () => void
}

export function runCliJsonl(opts: {
  command: string
  prefixArgs: string[]
  args: string[]
  cwd: string
  onLine: (obj: any, raw: string) => void
  onRaw?: (line: string) => void
  /** 无输出超时（默认 10 分钟） */
  idleTimeoutMs?: number
  /** 总输出上限（默认 5MB，防退化循环） */
  maxTotalBytes?: number
}): CliJsonlRunner {
  const child = spawn(opts.command, [...opts.prefixArgs, ...opts.args], {
    cwd: opts.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  let stderrTail = ''
  let total = 0
  let buffer = ''
  let killed = false
  const idleTimer = setTimeout(() => {
    killed = true
    child.kill()
  }, opts.idleTimeoutMs ?? 10 * 60 * 1000)

  child.stdout!.setEncoding('utf8')
  child.stdout!.on('data', (chunk: string) => {
    clearTimeout(idleTimer)
    if (!killed) idleTimer.refresh()
    total += chunk.length
    if (total > (opts.maxTotalBytes ?? 5 * 1024 * 1024)) {
      killed = true
      child.kill()
      return
    }
    buffer += chunk
    let idx: number
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line) continue
      try {
        opts.onLine(JSON.parse(line), line)
      } catch {
        opts.onRaw?.(line)
      }
    }
  })
  child.stderr!.on('data', (c: Buffer) => {
    stderrTail = (stderrTail + c.toString()).slice(-1500)
  })

  const exited = new Promise<{ code: number | null; stderrTail: string }>((resolve) => {
    child.on('exit', (code) => {
      clearTimeout(idleTimer)
      resolve({ code, stderrTail: stderrTail.trim() })
    })
    child.on('error', (err) => {
      clearTimeout(idleTimer)
      resolve({ code: -1, stderrTail: String(err) })
    })
  })

  return {
    child,
    exited,
    kill() {
      killed = true
      try {
        child.kill()
      } catch {}
    }
  }
}

/** 工具调用事件构造助手 */
export function toolEvent(phase: 'started' | 'result', name: string, data: Record<string, unknown>): Omit<TaskEvent, 'seq' | 'ts'> {
  return { kind: 'tool', text: name, data: { phase, ...data } }
}
