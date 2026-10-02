import crypto from 'node:crypto'
import fs from 'node:fs'
import { atomicWriteJson } from './persistence'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import type { ExecutionOwner, TaskStatus } from '../shared/types'

/** Versioned protocol shared by the Electron shell and the business sidecar. */
export const SIDECAR_PROTOCOL_VERSION = 1 as const
export const SIDECAR_STATE_FILE = 'sidecar-state.json'
export const SIDECAR_DIAGNOSTIC_FILE = 'sidecar-diagnostics.json'

export const SIDECAR_DIAGNOSTIC_LIMIT = 20
export const SIDECAR_DIAGNOSTIC_LINE_LIMIT = 200
export const SIDECAR_STDERR_TAIL_LINES = 4
const SIDECAR_STDERR_PARTIAL_LIMIT = 800

export type SidecarDiagnosticSource = 'spawn' | 'exit' | 'stderr'

export interface SidecarDiagnostic {
  at: number
  source: SidecarDiagnosticSource
  code?: string
  message?: string
}

export type SidecarStatus = 'stopped' | 'starting' | 'ready' | 'degraded' | 'reconnecting' | 'stopping'

export interface SidecarState {
  protocolVersion: typeof SIDECAR_PROTOCOL_VERSION
  port: number
  token: string
  instanceId: string
  pid?: number
  startedAt: number
  status: SidecarStatus
}

export interface SidecarSnapshot extends SidecarState {
  url: string
  orphanRuns: string[]
  diagnostics?: SidecarDiagnostic[]
}

export interface SidecarSyncState {
  protocolVersion: number
  instanceId: string
  generatedAt: number
  tasks: unknown[]
  issues: unknown[]
  goals: unknown[]
  runs?: unknown[]
  checkpoints?: unknown[]
  specSnapshots?: unknown[]
  specDecisions?: unknown[]
  specApprovals?: unknown[]
  goalEvents?: unknown[]
  orphanRuns: unknown[]
}

export interface SidecarManagerOptions {
  userDataDir: string
  /** Bundled server path. Defaults to the electron-vite output next to this file. */
  entrypoint?: string
  /** Port used on a fresh install; persisted ports are always preferred. */
  preferredPort?: number
  requestTimeoutMs?: number
  nodePath?: string
  /** Tests and embedders may provide a custom process launcher. */
  spawn?: typeof spawn
}

type StatusListener = (snapshot: SidecarSnapshot) => void

interface PersistedState {
  schemaVersion?: number
  protocol?: string
  version?: number
  protocolVersion?: number
  port?: number
  token?: string
  instanceToken?: string
  instanceId?: string
  pid?: number
  startedAt?: number
}

function randomToken() { return crypto.randomBytes(32).toString('hex') }

function readJson(file: string): PersistedState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as PersistedState
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch { return null }
}

function writeJson(file: string, value: unknown) {
  atomicWriteJson(file, value)
  try { fs.chmodSync(file, 0o600) } catch {}
}

async function freePort(host = '127.0.0.1'): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (!port) throw new Error('Unable to allocate sidecar port')
  return port
}

function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, host, () => server.close(() => resolve(true)))
  })
}

export class SidecarProtocolError extends Error {
  readonly status: number
  constructor(message: string, status = 502) { super(message); this.name = 'SidecarProtocolError'; this.status = status }
}

/**
 * Owns one loopback business process. The manager never stores task state in
 * memory: it only performs authenticated RPC and asks the sidecar to replay
 * the durable files. This makes renderer disconnects and Electron restarts
 * independent from execution lifetime.
 */
export class SidecarManager {
  private readonly options: Required<Pick<SidecarManagerOptions, 'userDataDir' | 'requestTimeoutMs'>> & SidecarManagerOptions
  private readonly stateFile: string
  private readonly diagnosticFile: string
  private child: ChildProcess | null = null
  private ownsSidecar = false
  private cleanupPending = false
  private state: SidecarState | null = null
  private orphanRuns: string[] = []
  private readonly diagnostics: SidecarDiagnostic[] = []
  private startPromise: Promise<SidecarSnapshot> | null = null
  private status: SidecarStatus = 'stopped'
  /** probe 失败（非 409）的末次原因：probe 内部吞错返回 null，启动终败的末条错误靠它补记 */
  private lastProbeError = ''
  private readonly listeners = new Set<StatusListener>()
  private readonly rpcQueue: Array<{ method: string; params: unknown; resolve: (value: unknown) => void; reject: (error: unknown) => void }> = []

  constructor(options: SidecarManagerOptions) {
    // Must exceed the slowest events.read full replay of the largest task log:
    // a short timeout aborts the RPC, the manager kills and re-spawns the
    // sidecar, and the renderer retry immediately re-blocks the fresh instance.
    this.options = { requestTimeoutMs: 30_000, ...options }
    this.stateFile = path.join(options.userDataDir, SIDECAR_STATE_FILE)
    this.diagnosticFile = path.join(options.userDataDir, SIDECAR_DIAGNOSTIC_FILE)
    try {
      const saved: unknown = JSON.parse(fs.readFileSync(this.diagnosticFile, 'utf8'))
      if (Array.isArray(saved)) for (const entry of saved.slice(-SIDECAR_DIAGNOSTIC_LIMIT)) {
        if (entry && Number.isFinite(entry.at) && (entry.source === 'spawn' || entry.source === 'exit')) {
          this.diagnostics.push({ at: entry.at, source: entry.source, ...(typeof entry.code === 'string' && /^[a-zA-Z0-9:_-]{1,32}$/.test(entry.code) ? { code: entry.code } : {}) })
        }
      }
    } catch {}
  }

  onStatus(listener: StatusListener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get snapshot(): SidecarSnapshot | null {
    if (!this.state) return null
    return { ...this.state, status: this.status, url: this.url(), orphanRuns: [...this.orphanRuns], diagnostics: [...this.diagnostics] }
  }

  get currentStatus(): SidecarStatus { return this.status }

  private emit(orphanRuns: string[] = []) {
    if (!this.state) return
    const snapshot: SidecarSnapshot = { ...this.state, status: this.status, url: this.url(), orphanRuns, diagnostics: [...this.diagnostics] }
    for (const listener of this.listeners) {
      try { listener(snapshot) } catch { /* status observers are isolated from lifecycle */ }
    }
  }

  private setStatus(status: SidecarStatus, orphanRuns: string[] = []) {
    this.status = status
    this.emit(orphanRuns)
  }

  private url() { return this.state ? `http://127.0.0.1:${this.state.port}` : '' }

  private async request<T>(route: string, init: RequestInit = {}): Promise<T> {
    const state = this.state
    if (!state) throw new SidecarProtocolError('Sidecar is not started', 503)
    const headers = new Headers(init.headers)
    headers.set('x-agentdeck-token', state.token)
    headers.set('x-agentdeck-protocol', String(SIDECAR_PROTOCOL_VERSION))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.options.requestTimeoutMs)
    try {
      const response = await fetch(new URL(route, this.url()), { ...init, headers, signal: controller.signal })
      const text = await response.text()
      let value: unknown
      try { value = text ? JSON.parse(text) : undefined } catch { value = text }
      if (!response.ok) {
        const message = value && typeof value === 'object' && 'error' in value ? String((value as { error: unknown }).error) : `HTTP ${response.status}`
        throw new SidecarProtocolError(message, response.status)
      }
      return value as T
    } catch (error) {
      if (error instanceof SidecarProtocolError) throw error
      throw new SidecarProtocolError(error instanceof Error ? error.message : String(error), 503)
    } finally { clearTimeout(timer) }
  }

  private async probe(port: number, token: string): Promise<SidecarSnapshot | null> {
    const prior = this.state
    this.state = { protocolVersion: SIDECAR_PROTOCOL_VERSION, port, token, instanceId: '', startedAt: 0, status: this.status }
    try {
      const handshake = await this.request<{ protocolVersion: number; instanceId: string; pid?: number; startedAt?: number; orphanRuns?: Array<{ id?: string; runId?: string }> }>('/handshake', {
        method: 'POST', body: JSON.stringify({ protocolVersion: SIDECAR_PROTOCOL_VERSION, instanceToken: token }), headers: { 'content-type': 'application/json' }
      })
      if (handshake.protocolVersion !== SIDECAR_PROTOCOL_VERSION || !handshake.instanceId) throw new SidecarProtocolError('Sidecar handshake version mismatch', 409)
      this.state = {
        protocolVersion: SIDECAR_PROTOCOL_VERSION,
        port,
        token,
        instanceId: handshake.instanceId,
        startedAt: handshake.startedAt ?? prior?.startedAt ?? Date.now(),
        status: 'ready',
        ...(handshake.pid || prior?.pid ? { pid: handshake.pid ?? prior?.pid } : {})
      }
      // Internal RPC may proceed after the handshake. The ready notification
      // is intentionally deferred until reconnect() completes state sync.
      this.status = 'ready'
      const orphans = (handshake.orphanRuns ?? []).map((run) => String(run.runId ?? run.id ?? '')).filter(Boolean)
      this.orphanRuns = orphans
      return { ...this.state, url: this.url(), orphanRuns: orphans, diagnostics: [...this.diagnostics] }
    } catch (error) {
      // A reachable process speaking another protocol is an invariant
      // violation, not a stale port. Fail loudly so we do not silently attach
      // to an incompatible local service.
      if (error instanceof SidecarProtocolError && error.status === 409) {
        this.state = prior
        throw error
      }
      this.lastProbeError = error instanceof Error ? error.message : String(error)
      this.state = prior
      return null
    }
  }

  private loadPersisted(): PersistedState | null {
    const value = readJson(this.stateFile)
    const version = value?.protocolVersion ?? value?.version
    const token = value?.token ?? value?.instanceToken
    if (!value || (value.schemaVersion !== undefined && value.schemaVersion !== 1) || version !== SIDECAR_PROTOCOL_VERSION || !Number.isInteger(value.port) || value.port! <= 0 || typeof token !== 'string' || !token) return null
    value.token = token
    return value
  }

  private recordDiagnostic(entry: SidecarDiagnostic) {
    this.diagnostics.push(entry)
    if (this.diagnostics.length > SIDECAR_DIAGNOSTIC_LIMIT) this.diagnostics.splice(0, this.diagnostics.length - SIDECAR_DIAGNOSTIC_LIMIT)
    if (entry.source === 'stderr') return
    const safe = this.diagnostics.filter((item) => item.source !== 'stderr').map((item) => ({
      at: item.at,
      source: item.source,
      ...(item.code && /^[a-zA-Z0-9:_-]{1,32}$/.test(item.code) ? { code: item.code } : {})
    }))
    try { writeJson(this.diagnosticFile, safe) } catch {}
  }

  private attachDiagnostics(child: ChildProcess, token: string, onGone: (evidence: string) => void) {
    const clamp = (line: string) => {
      const redacted = token ? line.split(token).join('[redacted]') : line
      return redacted.length > SIDECAR_DIAGNOSTIC_LINE_LIMIT ? `${redacted.slice(0, SIDECAR_DIAGNOSTIC_LINE_LIMIT - 1)}…` : redacted
    }
    const note = (source: SidecarDiagnosticSource, code?: string, message?: string) =>
      this.recordDiagnostic({ at: Date.now(), source, ...(code ? { code } : {}), ...(message ? { message } : {}) })
    child.stdout?.on('data', () => {})
    let tail: string[] = []
    let partial = ''
    const stderr = child.stderr
    if (stderr) {
      stderr.setEncoding('utf8')
      stderr.on('data', (chunk: string) => {
        const lines = (partial + chunk).split(/\r?\n/)
        partial = lines.pop() ?? ''
        if (partial.length > SIDECAR_STDERR_PARTIAL_LIMIT) partial = partial.slice(-SIDECAR_STDERR_PARTIAL_LIMIT)
        for (const line of lines) {
          if (!line.trim()) continue
          tail.push(clamp(line))
          if (tail.length > SIDECAR_STDERR_TAIL_LINES) tail.splice(0, tail.length - SIDECAR_STDERR_TAIL_LINES)
        }
      })
    }
    let crash = false
    let crashCode: string | undefined
    let crashEvidence = ''
    child.once('error', (error) => {
      const evidence = `spawn failed: ${clamp(error instanceof Error ? error.message : String(error))}`
      onGone(evidence)
      if (this.status !== 'stopping') note('spawn', (error as NodeJS.ErrnoException).code ?? 'spawn_error', evidence)
    })
    child.once('exit', (code, signal) => {
      // 末条错误的落盘/转发在 close 收口：exit 只记证据，stderr tail 到 close 才完整，
      // 折入 exit 备注的 message（内存快照转发给 UI；文件按既有契约只存 code 元数据）
      crash = this.status !== 'stopping'
      crashCode = signal ? `signal:${signal}` : `code:${code ?? 'unknown'}`
      crashEvidence = signal ? `killed by signal ${signal}` : `exited with code ${code ?? 'unknown'}`
      onGone(crashEvidence)
    })
    child.once('close', () => {
      if (crash) {
        const lastStderrLine = tail.at(-1)
        note('exit', crashCode, [crashEvidence, lastStderrLine].filter(Boolean).join(' — ').slice(0, SIDECAR_DIAGNOSTIC_LINE_LIMIT) || undefined)
        for (const line of tail) note('stderr', undefined, line)
      }
      tail = []
      partial = ''
    })
  }

  async start(): Promise<SidecarSnapshot> {
    if (this.startPromise) return this.startPromise
    if (this.state && this.status === 'ready') return this.snapshot!
    this.startPromise = this.startInternal().finally(() => { this.startPromise = null })
    return this.startPromise
  }

  private async startInternal(): Promise<SidecarSnapshot> {
    if (this.cleanupPending) await this.stop()
    this.setStatus('starting')
    const retainedChild = this.child
    const retainedState = this.state
    if (retainedChild) {
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          if (retainedChild.exitCode !== null || retainedChild.signalCode !== null) break
          if (!retainedState) throw new SidecarProtocolError('Live sidecar handle has no connection state', 503)
          const ready = await this.probe(retainedState.port, retainedState.token)
          if (ready) {
            if (ready.instanceId !== retainedState.instanceId || (retainedChild.pid && ready.pid !== retainedChild.pid)) {
              this.state = retainedState
              throw new SidecarProtocolError('Owned sidecar identity mismatch', 409)
            }
            writeJson(this.stateFile, this.persistedState())
            return ready
          }
          if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 50))
        }
        if (retainedChild.exitCode === null && retainedChild.signalCode === null) {
          throw new SidecarProtocolError('Sidecar is unreachable but exit was not confirmed; process handle retained', 503)
        }
        if (this.child === retainedChild) this.child = null
        this.ownsSidecar = false
      } catch (error) {
        this.setStatus('degraded')
        throw error
      }
    }
    const persisted = this.loadPersisted()
    if (persisted) {
      try {
        const adopted = await this.probe(persisted.port!, persisted.token!)
        if (adopted) {
          this.ownsSidecar = false
          writeJson(this.stateFile, this.persistedState())
          return adopted
        }
      } catch (error) {
        this.setStatus('degraded')
        throw error
      }
    }
    const persistedPort = persisted?.port && await isPortFree(persisted.port) ? persisted.port : 0
    const preferredPort = this.options.preferredPort && await isPortFree(this.options.preferredPort) ? this.options.preferredPort : 0
    const port = persistedPort || preferredPort || await freePort()
    const token = persisted?.token || randomToken()
    const instanceId = crypto.randomUUID()
    const entrypoint = this.options.entrypoint || path.join(__dirname, 'sidecar-server.js')
    const launcher = this.options.spawn || spawn
    const node = this.options.nodePath || process.env.AGENTDECK_NODE_PATH || process.execPath
    const env = { ...process.env, AGENTDECK_SIDECAR_TOKEN: token, AGENTDECK_SIDECAR_PORT: String(port), AGENTDECK_SIDECAR_USER_DATA: this.options.userDataDir, AGENTDECK_SIDECAR_INSTANCE: instanceId, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }
    const child = launcher(node, [entrypoint], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    this.child = child
    this.ownsSidecar = true
    let bootFailure: string | null = null
    let initializing = true
    this.attachDiagnostics(child, token, (evidence) => { bootFailure = evidence })
    child.once('exit', () => {
      if (this.child === child) {
        this.child = null
        if (!initializing && this.status !== 'stopping') {
          this.setStatus('reconnecting')
          // A sidecar crash must not require an Electron restart. Reconnect in
          // the background; queued renderer calls are flushed in order once
          // the authoritative state sync has completed.
          void this.reconnect().catch((error) => this.rejectRpcQueue(error))
        }
      }
    })
    this.state = { protocolVersion: SIDECAR_PROTOCOL_VERSION, port, token, instanceId, startedAt: Date.now(), status: 'starting', ...(child.pid ? { pid: child.pid } : {}) }
    let lastError = ''
    let persistenceFailed = false
    try { writeJson(this.stateFile, this.persistedState()) }
    catch (error) { persistenceFailed = true; lastError = error instanceof Error ? error.message : String(error) }
    for (let attempt = 0; !persistenceFailed && attempt < 50; attempt++) {
      if (bootFailure) break
      try {
        const ready = await this.probe(port, token)
        if (ready) {
          writeJson(this.stateFile, this.persistedState())
          initializing = false
          return ready
        }
      } catch (error) { lastError = error instanceof Error ? error.message : String(error) }
      await new Promise((resolve) => setTimeout(resolve, 50 + Math.min(250, attempt * 10)))
    }
    this.setStatus('stopping')
    const exited = await this.terminateChild(child)
    this.cleanupPending = !exited
    if (exited) {
      if (this.child === child) this.child = null
      this.ownsSidecar = false
    }
    this.setStatus('degraded')
    // probe 内部吞错返回 null（ECONNREFUSED 等）不进 lastError——末条错误从 lastProbeError 补
    const detail = [bootFailure, lastError || this.lastProbeError].filter(Boolean).join('; ')
    // 末条错误补记（漏记末条错误的收口）：启动终败的原因此前只进抛出异常——挂死
    // 不退出的子进程连 exit 诊断都没有，重启后无据可查。这里以 boot_failed 记进
    // 诊断环（message 随快照转发给 UI，文件按既有契约只落 code 元数据），token
    // 沿用诊断通道的同款折叠脱敏。
    if (detail) {
      const token = this.state?.token
      const redacted = token ? detail.split(token).join('[redacted]') : detail
      this.recordDiagnostic({ at: Date.now(), source: 'spawn', code: 'boot_failed', message: redacted.slice(0, SIDECAR_DIAGNOSTIC_LINE_LIMIT) })
    }
    throw new SidecarProtocolError(`Sidecar failed to start${detail ? `: ${detail}` : ''}`, 503)
  }

  private persistedState() {
    if (!this.state) return null
    return {
      schemaVersion: 1,
      ...this.state,
      protocol: 'agentdeck.business-brain',
      version: SIDECAR_PROTOCOL_VERSION,
      instanceToken: this.state.token
    }
  }

  async health() {
    await this.start()
    return this.request<{ ok: boolean; protocolVersion: number; instanceId: string; orphanRuns: unknown[] }>('/health')
  }

  async rpc<T = unknown>(method: string, params?: unknown): Promise<T> {
    if ((method === 'tasks.create' || method === 'issues.create') && params && typeof params === 'object' && !Array.isArray(params)) {
      const request = params as Record<string, unknown>
      const input = request.input
      if (input && typeof input === 'object' && !Array.isArray(input)) {
        const creation = input as Record<string, unknown>
        if (![creation.dedupeKey, creation.requestId, creation.idempotencyKey].some((value) => typeof value === 'string' && value.trim())) {
          params = { ...request, input: { ...creation, requestId: `sidecar:${crypto.randomUUID()}` } }
        }
      }
    }
    if (!this.state || this.status !== 'ready') {
      return this.enqueueRpc<T>(method, params)
    }
    try {
      return await this.callRpc<T>(method, params)
    } catch (error) {
      // A child can disappear between the status check and the request. Keep
      // the renderer command for the reconnect barrier instead of surfacing a
      // transient ECONNRESET as a permanent command failure.
      if (error instanceof SidecarProtocolError && error.status === 503 && (this.status as SidecarStatus) !== 'stopping') {
        this.setStatus('reconnecting')
        return this.enqueueRpc<T>(method, params)
      }
      throw error
    }
  }

  private enqueueRpc<T>(method: string, params?: unknown): Promise<T> {
    if (this.rpcQueue.length >= 100) throw new SidecarProtocolError('Sidecar reconnect queue is full', 429)
    return new Promise<T>((resolve, reject) => {
      this.rpcQueue.push({ method, params, resolve: resolve as (value: unknown) => void, reject })
      void this.reconnect().catch((error) => this.rejectRpcQueue(error))
    })
  }

  private async callRpc<T>(method: string, params?: unknown): Promise<T> {
    const id = crypto.randomUUID()
    const result = await this.request<{ protocol?: string; version?: number; id?: string; ok?: boolean; result?: T; error?: string | { message?: string; code?: string } }>('/rpc', { method: 'POST', body: JSON.stringify({ protocol: 'agentdeck.business-brain', version: SIDECAR_PROTOCOL_VERSION, id, method, params }) , headers: { 'content-type': 'application/json' } })
    if (result.protocol !== undefined && result.protocol !== 'agentdeck.business-brain') throw new SidecarProtocolError('Sidecar RPC protocol mismatch', 409)
    if (result.version !== undefined && result.version !== SIDECAR_PROTOCOL_VERSION) throw new SidecarProtocolError('Sidecar RPC version mismatch', 409)
    if (result.id !== undefined && result.id !== id) throw new SidecarProtocolError('Sidecar RPC response id mismatch', 502)
    if (result.ok === false || ('error' in result && result.error)) {
      const detail = typeof result.error === 'string' ? result.error : result.error?.message || result.error?.code || 'Sidecar RPC failed'
      throw new SidecarProtocolError(detail, 500)
    }
    return result?.result as T
  }

  private async flushRpcQueue() {
    if (this.status !== 'ready' || !this.rpcQueue.length) return
    const pending = this.rpcQueue.splice(0)
    for (const item of pending) {
      try { item.resolve(await this.callRpc(item.method, item.params)) }
      catch (error) { item.reject(error) }
    }
  }

  private rejectRpcQueue(error: unknown) {
    const pending = this.rpcQueue.splice(0)
    for (const item of pending) item.reject(error)
  }

  async sync(): Promise<SidecarSyncState> { return this.rpc<SidecarSyncState>('state.sync') }

  async readEvents<T = unknown>(taskId: string, afterSeq = 0): Promise<T[]> {
    return this.rpc<T[]>('events.read', { taskId, afterSeq })
  }

  async appendEvent<T = unknown>(
    taskId: string,
    event: unknown,
    /** Identity captured by the caller before it produced the event. Without
     *  it the append only matches a record with no run identity at all, so an
     *  old event can never be authorized by whatever run is latest. */
    expected?: { runId?: string; executionOwner?: ExecutionOwner; status?: TaskStatus | TaskStatus[] }
  ): Promise<T> {
    return this.rpc<T>('events.append', { taskId, event, ...(expected ? { expected } : {}) })
  }

  /** Re-establish the process and perform the state barrier used by renderer
   * reconnects. */
  async reconnect(): Promise<SidecarSnapshot> {
    const snapshot = await this.start()
    await this.sync()
    await this.recoverOrphans()
    await this.flushRpcQueue()
    this.setStatus('ready')
    this.emit(this.orphanRuns)
    return { ...snapshot, status: 'ready', orphanRuns: [...this.orphanRuns], diagnostics: [...this.diagnostics] }
  }

  async recoverOrphans() {
    const result = await this.rpc<{ adopted: string[]; orphanRuns: unknown[] }>('runs.takeover')
    this.orphanRuns = (result.orphanRuns ?? []).map((run) => {
      if (run && typeof run === 'object') {
        const value = run as { runId?: unknown; id?: unknown }
        return String(value.runId ?? value.id ?? '')
      }
      return String(run ?? '')
    }).filter(Boolean)
    return result
  }

  async claimOrphans() { return this.recoverOrphans() }

  private async terminateChild(child: ChildProcess): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return true
    return new Promise<boolean>((resolve) => {
      const finish = (exited: boolean) => {
        clearTimeout(timer)
        child.removeListener('exit', onExit)
        resolve(exited)
      }
      const onExit = () => finish(true)
      const timer = setTimeout(() => finish(false), 1000)
      child.once('exit', onExit)
      try { child.kill() } catch {}
      if (child.exitCode !== null || child.signalCode !== null) finish(true)
    })
  }

  async stop() {
    if (!this.state) return
    const previous = this.state
    this.setStatus('stopping')
    if (this.ownsSidecar) {
      try { await this.request('/shutdown', { method: 'POST', body: '{}' , headers: { 'content-type': 'application/json' } }) } catch {}
    }
    const child = this.child
    if (child && !await this.terminateChild(child)) {
      this.cleanupPending = true
      this.setStatus('degraded')
      throw new SidecarProtocolError('Sidecar exit was not confirmed; process handle retained', 503)
    }
    this.child = null
    this.ownsSidecar = false
    this.cleanupPending = false
    this.state = null
    this.orphanRuns = []
    this.rejectRpcQueue(new SidecarProtocolError('Sidecar stopped', 503))
    this.setStatus('stopped')
    for (const listener of this.listeners) {
      try { listener({ ...previous, status: 'stopped', url: '', orphanRuns: [], diagnostics: [...this.diagnostics] }) } catch {}
    }
  }
}
