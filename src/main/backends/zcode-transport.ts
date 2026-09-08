import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { isJsonObject, killProcessTree, type JsonValue } from './cli-common'

export interface ZcodeWireMessage {
  id?: number | string
  method?: string
  params?: JsonValue
  result?: JsonValue
  error?: { code: number; message: string; data?: JsonValue }
}

function parseWireMessage(value: unknown): ZcodeWireMessage | null {
  if (!isJsonObject(value)) return null
  const id = typeof value.id === 'number' || typeof value.id === 'string' ? value.id : undefined
  const method = typeof value.method === 'string' ? value.method : undefined
  const error = isJsonObject(value.error) && typeof value.error.code === 'number' && typeof value.error.message === 'string'
    ? { code: value.error.code, message: value.error.message, ...(value.error.data !== undefined ? { data: value.error.data } : {}) }
    : undefined
  return { ...(id !== undefined ? { id } : {}), ...(method ? { method } : {}), ...(value.params !== undefined ? { params: value.params } : {}), ...(value.result !== undefined ? { result: value.result } : {}), ...(error ? { error } : {}) }
}

export class ZcodeConnection {
  private readonly child: ChildProcess
  private nextId = 1
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private buffer = ''
  private stderrTail = ''
  private handlers = new Set<(message: ZcodeWireMessage) => void>()
  exited = false

  constructor(nodePath: string, zcodePath: string, cwd: string) {
    const env: NodeJS.ProcessEnv = { ...process.env }
    if (path.resolve(nodePath).toLowerCase() === path.resolve(process.execPath).toLowerCase()) env.ELECTRON_RUN_AS_NODE = '1'
    else delete env.ELECTRON_RUN_AS_NODE
    this.child = spawn(nodePath, [zcodePath, 'app-server', '--stdio'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.child.stdout!.setEncoding('utf8')
    this.child.stdout!.on('data', (chunk: string) => {
      this.buffer += chunk
      let index: number
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index).trim()
        this.buffer = this.buffer.slice(index + 1)
        if (!line) continue
        try {
          const message = parseWireMessage(JSON.parse(line) as unknown)
          if (message) this.dispatch(message)
        } catch { /* malformed protocol line */ }
      }
    })
    this.child.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (!text) return
      this.stderrTail = `${this.stderrTail}\n${text}`.slice(-1500)
      console.warn('[zcode:stderr]', text.slice(0, 400))
    })
    const finish = (code: number | null, detailOverride?: string) => {
      if (this.exited) return
      this.exited = true
      const detail = detailOverride ?? this.stderrTail.trim()
      const error = new Error(`zcode app-server 进程退出 (code ${code})${detail ? `: ${detail}` : ''}`)
      for (const pending of this.pending.values()) pending.reject(error)
      this.pending.clear()
      for (const handler of [...this.handlers]) handler({ method: 'zcode.exit', params: { code, stderr: detail.slice(-400) } })
    }
    this.child.on('exit', (code) => finish(code))
    this.child.on('error', (error) => finish(-1, error.message))
  }

  private dispatch(message: ZcodeWireMessage) {
    if (typeof message.id === 'number' && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id)
      if (pending) {
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(message.error.message))
        else pending.resolve(message.result)
        return
      }
    }
    for (const handler of this.handlers) handler(message)
  }

  onMessage(handler: (message: ZcodeWireMessage) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.exited) return Promise.reject(new Error('连接已关闭'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject })
      this.child.stdin!.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  }

  respond(id: number | string, result: unknown) {
    this.child.stdin!.write(`${JSON.stringify({ id, result })}\n`)
  }

  kill() {
    killProcessTree(this.child)
  }
}
