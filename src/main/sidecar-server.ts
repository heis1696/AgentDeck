import fs from 'node:fs'
import { prepareManualTaskStart, taskIdentity } from './handoff'
import { atomicWriteJson } from './persistence'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { SIDECAR_PROTOCOL_VERSION } from './sidecar'
import { SIDECAR_PROTOCOL } from './sidecar/protocol'
import { EventLog } from './event-log'
import type { ExecutionOwner, TaskEvent, TaskStatus } from '../shared/types'
import type { TaskExpectation } from './store'
import { SidecarRuntime } from './sidecar-runtime'

type JsonRecord = Record<string, unknown>
function record(value: unknown): JsonRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {} }
function processAlive(pid: unknown) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}
function json(res: http.ServerResponse, status: number, value: unknown) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' })
  res.end(body)
}
function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 2 * 1024 * 1024) { reject(new Error('request too large')); req.destroy() } else chunks.push(chunk) })
    req.on('end', () => {
      if (!chunks.length) return resolve(undefined)
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(new Error('invalid JSON')) }
    })
    req.on('error', reject)
  })
}

export interface SidecarServerOptions {
  port: number
  token: string
  userDataDir: string
  instanceId?: string
}

export interface SidecarServer {
  server: http.Server
  instanceId: string
  close: () => Promise<void>
  ready: Promise<number>
}

function auth(req: http.IncomingMessage, token: string) {
  const supplied = String(req.headers['x-agentdeck-token'] || '')
    || (String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''))
  const left = Buffer.from(supplied)
  const right = Buffer.from(token)
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right)
}

function loadArray(file: string, key?: string): unknown[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    if (Array.isArray(parsed)) return parsed
    if (key && parsed && typeof parsed === 'object' && Array.isArray((parsed as JsonRecord)[key])) return (parsed as JsonRecord)[key] as unknown[]
  } catch {}
  return []
}

/** Reused per-file EventLog instances. Building one parses the whole JSONL,
 * so recreating it per request turns a large-log read into a multi-second full
 * re-read that starves the sidecar's single thread. Task logs are read and
 * written through the TaskStore, which keeps its own per-task instances; this
 * cache covers the remaining direct reads (the goal event stream). The
 * watermark freshness check in EventLog keeps reused instances correct, and
 * the LRU cap bounds memory when a userData dir holds many logs. */
const eventLogCache = new Map<string, EventLog>()
const EVENT_LOG_CACHE_LIMIT = 16

function sharedEventLog(file: string): EventLog {
  const existing = eventLogCache.get(file)
  if (existing) {
    // Re-insert to keep the map in least-recently-used order.
    eventLogCache.delete(file)
    eventLogCache.set(file, existing)
    return existing
  }
  const log = new EventLog(file)
  eventLogCache.set(file, log)
  if (eventLogCache.size > EVENT_LOG_CACHE_LIMIT) {
    const oldest = eventLogCache.keys().next().value
    if (oldest !== undefined) eventLogCache.delete(oldest)
  }
  return log
}

function durableState(userDataDir: string) {
  // TaskStore keeps its versioned index under userData/tasks/tasks.json.
  // Accept the old flat path as a compatibility fallback for early builds.
  const rawTasks = loadArray(path.join(userDataDir, 'tasks', 'tasks.json'), 'tasks')
    .concat(loadArray(path.join(userDataDir, 'tasks.json'), 'tasks'))
  const tasksById = new Map<string, unknown>()
  for (const task of rawTasks) {
    const id = typeof record(task).id === 'string' ? String(record(task).id) : ''
    if (id) tasksById.set(id, task)
  }
  const tasks = tasksById.size ? [...tasksById.values()] : rawTasks
  const issuesDocument = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(userDataDir, 'issues', 'index.json'), 'utf8')) as JsonRecord } catch { return {} }
  })()
  const issues = Array.isArray(issuesDocument.issues) ? issuesDocument.issues : []
  const runs = Array.isArray(issuesDocument.runs) ? issuesDocument.runs : []
  const comments = Array.isArray(issuesDocument.comments) ? issuesDocument.comments : []
  const goals = loadArray(path.join(userDataDir, 'goals', 'index.json'), 'goals')
  const goalDocument = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(userDataDir, 'goals', 'index.json'), 'utf8')) as JsonRecord } catch { return {} }
  })()
  const checkpoints = Array.isArray(goalDocument.checkpoints) ? goalDocument.checkpoints : []
  const specSnapshots = Array.isArray(goalDocument.specSnapshots) ? goalDocument.specSnapshots : []
  const specDecisions = Array.isArray(goalDocument.specDecisions) ? goalDocument.specDecisions : []
  const specApprovals = Array.isArray(goalDocument.specApprovals) ? goalDocument.specApprovals : []
  const goalEvents = sharedEventLog(path.join(userDataDir, 'goals', 'events.jsonl')).read()
  const orphanRuns = tasks.filter((task) => record(task).status === 'running')
  return { tasks, issues, runs, comments, goals, checkpoints, specSnapshots, specDecisions, specApprovals, goalEvents, orphanRuns }
}

/**
 * Start the standalone business process. It is intentionally dependency-free
 * so electron-vite can bundle it and node can run it during recovery tests.
 */
export function startSidecarServer(options: SidecarServerOptions): SidecarServer {
  if (!options.token) throw new Error('sidecar token is required')
  const instanceId = options.instanceId || crypto.randomUUID()
  const startedAt = Date.now()
  const runtime = new SidecarRuntime(options.userDataDir)
  let closing = false
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      // Reject non-loopback proxy requests. Host is checked in addition to the
      // bind address because a local proxy can otherwise forward arbitrary hosts.
      const remote = req.socket.remoteAddress || ''
      if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') return json(res, 403, { error: 'loopback only' })
      const host = String(req.headers.host || '').toLowerCase()
      if (host && !host.startsWith('127.0.0.1:') && !host.startsWith('localhost:') && !host.startsWith('[::1]:')) return json(res, 403, { error: 'invalid host' })
      const origin = String(req.headers.origin || '')
      if (origin && !/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(origin)) return json(res, 403, { error: 'invalid origin' })
      if ((url.pathname === '/health' || url.pathname === '/global/health') && req.method === 'GET') {
        // Health is usable by a local supervisor before it has loaded the
        // state file. If a caller supplies a token, however, reject an
        // incorrect bearer instead of silently treating it as a probe.
        if ((req.headers['x-agentdeck-token'] !== undefined || req.headers.authorization !== undefined) && !auth(req, options.token)) {
          return json(res, 401, { error: 'invalid sidecar token' })
        }
        return json(res, 200, healthPayload())
      }
      if (!auth(req, options.token)) return json(res, 401, { error: 'invalid sidecar token' })
      if (url.pathname === '/handshake' && (req.method === 'POST' || req.method === 'GET')) {
        const body = req.method === 'GET' ? {} : record(await readBody(req))
        const requestedVersion = body.protocolVersion ?? Number(req.headers['x-agentdeck-protocol'])
        if (requestedVersion !== undefined && requestedVersion !== SIDECAR_PROTOCOL_VERSION) return json(res, 409, { error: 'sidecar protocol version mismatch', protocolVersion: SIDECAR_PROTOCOL_VERSION })
        if (req.method === 'POST' && body.instanceToken !== options.token) return json(res, 401, { error: 'invalid sidecar token' })
        const state = durableState(options.userDataDir)
        return json(res, 200, { ok: true, protocol: SIDECAR_PROTOCOL, version: SIDECAR_PROTOCOL_VERSION, protocolVersion: SIDECAR_PROTOCOL_VERSION, instanceId, pid: process.pid, startedAt, port: (() => { const address = server.address(); return typeof address === 'object' && address ? address.port : options.port })(), orphanRuns: state.orphanRuns })
      }
      if (url.pathname === '/shutdown' && req.method === 'POST') {
        json(res, 200, { ok: true })
        closing = true
        setImmediate(() => void close())
        return
      }
      if (url.pathname !== '/rpc' || req.method !== 'POST') return json(res, 404, { error: 'not found' })
      const body = record(await readBody(req))
      const requestVersion = body.version ?? body.protocolVersion ?? (req.headers['x-agentdeck-protocol'] === undefined ? undefined : Number(req.headers['x-agentdeck-protocol']))
      if (requestVersion !== undefined && requestVersion !== SIDECAR_PROTOCOL_VERSION) return json(res, 409, { id: body.id, error: 'sidecar protocol version mismatch', protocolVersion: SIDECAR_PROTOCOL_VERSION })
      if (body.protocol !== undefined && body.protocol !== SIDECAR_PROTOCOL) return json(res, 409, { id: body.id, error: 'sidecar protocol mismatch', protocol: SIDECAR_PROTOCOL, version: SIDECAR_PROTOCOL_VERSION })
      const method = typeof body.method === 'string' ? body.method : ''
      const params = record(body.params)
      let result: unknown
      if (method === 'health') {
        result = healthPayload()
      } else if (method === 'state.sync') {
        const state = { ...durableState(options.userDataDir), ...runtime.state() }
        result = { protocol: SIDECAR_PROTOCOL, version: SIDECAR_PROTOCOL_VERSION, protocolVersion: SIDECAR_PROTOCOL_VERSION, instanceId, generatedAt: Date.now(), sidecar: { ...healthPayload(), orphanRuns: state.orphanRuns }, ...state }
      } else if (method === 'tasks.list') {
        result = runtime.state().tasks
      } else if (method === 'tasks.get') {
        result = typeof params.id === 'string' ? runtime.state().tasks.find((task) => task.id === params.id) ?? null : null
      } else if (method === 'tasks.create') {
        runtime.refreshIfIdle()
        const input = record(params.input)
        const trigger = typeof params.trigger === 'string' ? params.trigger : undefined
        result = runtime.taskService.createTask(input as never, trigger as never)
      } else if (method === 'issues.create') {
        runtime.refreshIfIdle()
        const rawInput = record(params.input)
        const input = {
          ...rawInput,
          // The Issue API calls this field description; TaskService keeps the
          // compatibility name prompt internally.
          prompt: rawInput.prompt ?? rawInput.description
        }
        const trigger = typeof params.trigger === 'string' ? params.trigger : undefined
        // Preserve the Issue-returning creation contract across the sidecar
        // boundary. The runtime returns a derived stable view when the
        // projection write is temporarily unavailable.
        result = runtime.createIssue(input as never, trigger as never)
      } else if (method === 'tasks.start') {
        if (typeof params.id !== 'string') throw new Error('task id is required')
        // Same captured-identity preparation as the desktop start button and
        // drag-to-running entry: only a still-queued record may be unparked,
        // and a state change made meanwhile is never overwritten.
        const started = prepareManualTaskStart(runtime.store, params.id)
        if (!started) throw new Error('task is not queued')
        runtime.start()
        runtime.runner.enqueue(started)
        result = runtime.store.get(started.id) ?? started
      } else if (method === 'tasks.cancel') {
        if (typeof params.id !== 'string') throw new Error('task id is required')
        result = await runtime.runner.cancel(params.id)
      } else if (method === 'tasks.retry') {
        if (typeof params.id !== 'string') throw new Error('task id is required')
        const task = runtime.store.get(params.id)
        if (!task || task.status === 'running' || task.status === 'queued') throw new Error('task cannot be retried')
        const captured = taskIdentity(task)
        // Validate first, clean up second: the conditional requeue is the only
        // proof the observed run still owns the record. Cleanup of a rejected
        // retry must not touch a replacement run's session.
        const requeued = runtime.store.updateIf(task.id, captured, { status: 'queued', error: undefined, failure: undefined, result: undefined, sessionId: undefined, attempt: undefined, runId: undefined, executionOwner: undefined })
        if (!requeued) throw new Error('task state changed; retry aborted')
        await runtime.runner.closeSession(task.id, { runId: task.runId, executionOwner: task.executionOwner })
        runtime.start()
        runtime.runner.enqueue(requeued)
        result = { ok: true }
      } else if (method === 'tasks.followup') {
        if (typeof params.id !== 'string' || typeof params.content !== 'string') throw new Error('task id and content are required')
        result = await runtime.runner.followUp(params.id, params.content, params.options as { relay?: boolean } | undefined)
      } else if (method === 'events.replay' || method === 'events.read') {
        const taskId = typeof params.taskId === 'string' ? params.taskId : ''
        if (!taskId) throw new Error('taskId is required')
        // Reads go through the owner of the durable index: a deleted task has
        // no record, so its removed log cannot be served back.
        result = runtime.store.readEvents(taskId, typeof params.afterSeq === 'number' ? params.afterSeq : 0)
      } else if (method === 'events.append') {
        const taskId = typeof params.taskId === 'string' ? params.taskId : ''
        if (!taskId || params.event === undefined) throw new Error('taskId and event are required')
        // Task events are appended by the store, under the storage transaction
        // and only for a Task that still exists. A deleted Task therefore
        // cannot have its log file (or its directory) recreated.
        //
        // The authorization uses the run identity the caller captured when it
        // produced the event. Reading the latest record here would let a stale
        // event ride on whatever run currently owns the task, so a missing
        // identity only matches a record that has none (queued/legacy).
        const expectation = record(params.expected)
        const runId = typeof expectation.runId === 'string'
          ? expectation.runId
          : (typeof params.runId === 'string' ? params.runId : undefined)
        const executionOwner = (expectation.executionOwner ?? params.executionOwner) as ExecutionOwner | undefined
        const status = expectation.status ?? params.status
        const expected: TaskExpectation = {
          ...(status !== undefined ? { status: status as TaskStatus | TaskStatus[] } : {}),
          runId,
          executionOwner
        }
        const event = runtime.store.appendEvent(taskId, record(params.event) as Omit<TaskEvent, 'seq'>, expected)
        if (!event) throw new Error('task does not exist, or the captured run identity no longer owns it')
        result = event
      } else if (method === 'runs.takeover' || method === 'runs.claim') {
        const file = path.join(options.userDataDir, 'sidecar-orphans.json')
        const now = Date.now()
        const prior = (() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) as JsonRecord } catch { return {} } })()
        const priorLease = typeof prior.leaseExpiresAt === 'number' ? prior.leaseExpiresAt : 0
        // A sidecar lease only defers to a peer that is still alive. It is not
        // evidence of death, so it can never be the reason a run changes hands.
        const peerLeaseActive = priorLease > now && (prior.instanceId === instanceId || processAlive(prior.pid))
        const candidates = runtime.store.list()
          .filter((task) => task.status === 'running')
          .map((task) => task.runId || task.id)
          .filter(Boolean)
        // Takeover itself is the store's ownership-checked recovery: only an
        // execution owner proven dead outside the lock is claimed, and the
        // exact observed run is committed conditionally, once.
        const adopted = peerLeaseActive ? [] : runtime.takeoverRuns(candidates).map((task) => task.runId || task.id)
        const takeover = {
          protocolVersion: SIDECAR_PROTOCOL_VERSION,
          instanceId,
          pid: process.pid,
          claimedAt: now,
          leaseExpiresAt: now + 30_000,
          runIds: adopted
        }
        // Publishing the lease must not collide with a peer that is taking
        // over at the same time: a shared temporary path let one writer's
        // rename lose the other's file (ENOENT). Unique names plus fsync and
        // atomic replacement keep both the lease and its reader consistent.
        atomicWriteJson(file, takeover)
        result = { adopted, orphanRuns: durableState(options.userDataDir).orphanRuns, lease: takeover }
      } else {
        return json(res, 404, { protocol: SIDECAR_PROTOCOL, version: SIDECAR_PROTOCOL_VERSION, id: body.id, ok: false, error: { code: 'unknown_method', message: `unknown sidecar method: ${method}` } })
      }
      return json(res, 200, { protocol: SIDECAR_PROTOCOL, version: SIDECAR_PROTOCOL_VERSION, id: body.id, ok: true, result })
    } catch (error) {
      return json(res, 400, { protocol: SIDECAR_PROTOCOL, version: SIDECAR_PROTOCOL_VERSION, ok: false, error: { code: 'invalid_request', message: error instanceof Error ? error.message : String(error) } })
    }
  })
  const healthPayload = () => {
    const address = server.address()
    return {
      ok: true,
      protocol: SIDECAR_PROTOCOL,
      version: SIDECAR_PROTOCOL_VERSION,
      protocolVersion: SIDECAR_PROTOCOL_VERSION,
      status: closing ? 'stopping' : 'ready',
      instanceId,
      pid: process.pid,
      port: typeof address === 'object' && address ? address.port : options.port,
      startedAt,
      uptimeMs: Date.now() - startedAt,
      orphanRuns: durableState(options.userDataDir).orphanRuns
    }
  }
  const close = () => new Promise<void>((resolve) => {
    const finish = () => { void runtime.close().finally(resolve) }
    if (closing && !server.listening) return finish()
    server.close(finish)
  })
  const ready = new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.once('listening', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : options.port)
    })
  })
  server.listen(options.port, '127.0.0.1')
  return { server, instanceId, close, ready }
}

function cliOptions(): SidecarServerOptions | null {
  const port = Number(process.env.AGENTDECK_SIDECAR_PORT)
  const token = process.env.AGENTDECK_SIDECAR_TOKEN || ''
  const userDataDir = process.env.AGENTDECK_SIDECAR_USER_DATA || ''
  if (!port || !token || !userDataDir) return null
  return { port, token, userDataDir, instanceId: process.env.AGENTDECK_SIDECAR_INSTANCE }
}

if (process.env.AGENTDECK_SIDECAR_PORT) {
  const options = cliOptions()
  if (!options) process.exitCode = 64
  else {
    const service = startSidecarServer(options)
    const shutdown = () => { void service.close().finally(() => process.exit(0)) }
    process.once('SIGTERM', shutdown)
    process.once('SIGINT', shutdown)
  }
}
