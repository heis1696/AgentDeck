import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'

/** Versioned protocol shared by the Electron shell and the business sidecar. */
export const SIDECAR_PROTOCOL_VERSION = 1 as const
export const SIDECAR_STATE_FILE = 'sidecar-state.json'

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
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, file)
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
  private child: ChildProcess | null = null
  private ownsSidecar = false
  private state: SidecarState | null = null
  private orphanRuns: string[] = []
  private startPromise: Promise<SidecarSnapshot> | null = null
  private status: SidecarStatus = 'stopped'
  private readonly listeners = new Set<StatusListener>()
  private readonly rpcQueue: Array<{ method: string; params: unknown; resolve: (value: unknown) => void; reject: (error: unknown) => void }> = []

  constructor(options: SidecarManagerOptions) {
    this.options = { requestTimeoutMs: 2_000, ...options }
    this.stateFile = path.join(options.userDataDir, SIDECAR_STATE_FILE)
  }

  onStatus(listener: StatusListener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get snapshot(): SidecarSnapshot | null {
    if (!this.state) return null
    return { ...this.state, status: this.status, url: this.url(), orphanRuns: [...this.orphanRuns] }
  }

  get currentStatus(): SidecarStatus { return this.status }

  private emit(orphanRuns: string[] = []) {
    if (!this.state) return
    const snapshot: SidecarSnapshot = { ...this.state, status: this.status, url: this.url(), orphanRuns }
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
      this.status = 'ready'
      const orphans = (handshake.orphanRuns ?? []).map((run) => String(run.runId ?? run.id ?? '')).filter(Boolean)
      this.orphanRuns = orphans
      this.emit(orphans)
      return { ...this.state, url: this.url(), orphanRuns: orphans }
    } catch (error) {
      // A reachable process speaking another protocol is an invariant
      // violation, not a stale port. Fail loudly so we do not silently attach
      // to an incompatible local service.
      if (error instanceof SidecarProtocolError && error.status === 409) {
        this.state = prior
        throw error
      }
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

  async start(): Promise<SidecarSnapshot> {
    if (this.state && this.status === 'ready') return this.snapshot!
    if (this.startPromise) return this.startPromise
    this.startPromise = this.startInternal().finally(() => { this.startPromise = null })
    return this.startPromise
  }

  private async startInternal(): Promise<SidecarSnapshot> {
    this.setStatus('starting')
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
    // Drain child output so a verbose provider cannot block its own IPC loop
    // on a full inherited pipe. Diagnostics stay in the sidecar log stream.
    child.stdout?.on('data', () => {})
    child.stderr?.on('data', () => {})
    child.once('exit', () => {
      if (this.child === child) {
        this.child = null
        if (this.status !== 'stopping') {
          this.setStatus('reconnecting')
          // A sidecar crash must not require an Electron restart. Reconnect in
          // the background; queued renderer calls are flushed in order once
          // the authoritative state sync has completed.
          void this.start().then(async () => {
            await this.sync()
            await this.recoverOrphans()
            await this.flushRpcQueue()
          }).catch((error) => this.rejectRpcQueue(error))
        }
      }
    })
    this.state = { protocolVersion: SIDECAR_PROTOCOL_VERSION, port, token, instanceId, startedAt: Date.now(), status: 'starting', ...(child.pid ? { pid: child.pid } : {}) }
    writeJson(this.stateFile, this.persistedState())
    let lastError = ''
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        const ready = await this.probe(port, token)
        if (ready) {
          writeJson(this.stateFile, this.persistedState())
          return ready
        }
      } catch (error) { lastError = error instanceof Error ? error.message : String(error) }
      await new Promise((resolve) => setTimeout(resolve, 50 + Math.min(250, attempt * 10)))
    }
    this.setStatus('degraded')
    const failedChild = this.child
    this.child = null
    this.ownsSidecar = false
    if (failedChild && failedChild.exitCode === null) {
      try { failedChild.kill() } catch {}
    }
    throw new SidecarProtocolError(`Sidecar failed to start${lastError ? `: ${lastError}` : ''}`, 503)
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
      void this.start().then(async () => { await this.sync(); await this.recoverOrphans(); await this.flushRpcQueue() }).catch((error) => this.rejectRpcQueue(error))
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

  async appendEvent<T = unknown>(taskId: string, event: unknown): Promise<T> {
    return this.rpc<T>('events.append', { taskId, event })
  }

  /** Re-establish the process and perform the state barrier used by renderer
   * reconnects. */
  async reconnect(): Promise<SidecarSnapshot> {
    const snapshot = await this.start()
    await this.sync()
    await this.recoverOrphans()
    await this.flushRpcQueue()
    return snapshot
  }

  async recoverOrphans() {
    return this.rpc<{ adopted: string[]; orphanRuns: unknown[] }>('runs.takeover')
  }

  async claimOrphans() { return this.recoverOrphans() }

  async stop() {
    if (!this.state) return
    const previous = this.state
    this.setStatus('stopping')
    if (this.ownsSidecar) {
      try { await this.request('/shutdown', { method: 'POST', body: '{}' , headers: { 'content-type': 'application/json' } }) } catch {}
    }
    const child = this.child
    if (child && child.exitCode === null) {
      try { child.kill() } catch {}
      await new Promise<void>((resolve) => { const timer = setTimeout(resolve, 500); child.once('exit', () => { clearTimeout(timer); resolve() }) })
    }
    this.child = null
    this.ownsSidecar = false
    this.state = null
    this.orphanRuns = []
    this.rejectRpcQueue(new SidecarProtocolError('Sidecar stopped', 503))
    this.setStatus('stopped')
    for (const listener of this.listeners) {
      try { listener({ ...previous, status: 'stopped', url: '', orphanRuns: [] }) } catch {}
    }
  }
}
