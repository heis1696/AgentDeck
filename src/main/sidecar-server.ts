import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { SIDECAR_PROTOCOL_VERSION } from './sidecar'
import { SIDECAR_PROTOCOL } from './sidecar/protocol'
import { EventLog } from './event-log'
import type { TaskEvent } from '../shared/types'
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
  const notifications = Array.isArray(issuesDocument.notifications) ? issuesDocument.notifications : []
  const goals = loadArray(path.join(userDataDir, 'goals', 'index.json'), 'goals')
  const goalDocument = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(userDataDir, 'goals', 'index.json'), 'utf8')) as JsonRecord } catch { return {} }
  })()
  const checkpoints = Array.isArray(goalDocument.checkpoints) ? goalDocument.checkpoints : []
  const specSnapshots = Array.isArray(goalDocument.specSnapshots) ? goalDocument.specSnapshots : []
  const specDecisions = Array.isArray(goalDocument.specDecisions) ? goalDocument.specDecisions : []
  const specApprovals = Array.isArray(goalDocument.specApprovals) ? goalDocument.specApprovals : []
  const goalEvents = new EventLog(path.join(userDataDir, 'goals', 'events.jsonl')).read()
  const orphanRuns = tasks.filter((task) => record(task).status === 'running')
  return { tasks, issues, runs, comments, notifications, goals, checkpoints, specSnapshots, specDecisions, specApprovals, goalEvents, orphanRuns }
}

function readEvents(userDataDir: string, taskId: string, afterSeq = 0) {
  return new EventLog(eventFile(userDataDir, taskId)).read(afterSeq)
}

function eventFile(userDataDir: string, taskId: string) {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(taskId)) throw new Error('invalid taskId')
  const root = path.resolve(userDataDir, 'tasks')
  const file = path.resolve(root, taskId, 'events.jsonl')
  if (!file.startsWith(`${root}${path.sep}`)) throw new Error('invalid taskId')
  return file
}

function appendEvent(userDataDir: string, taskId: string, input: unknown) {
  return new EventLog(eventFile(userDataDir, taskId)).append(record(input) as Omit<TaskEvent, 'seq'>)
}

/** Convert claimed stale executions back into runnable durable tasks. The
 * operation is idempotent: only tasks still marked `running` are changed. */
function claimOrphanTasks(userDataDir: string, runIds: readonly string[], owner: string) {
  const file = path.join(userDataDir, 'tasks', 'tasks.json')
  let document: JsonRecord
  try { document = JSON.parse(fs.readFileSync(file, 'utf8')) as JsonRecord } catch { return [] }
  if (!Array.isArray(document.tasks)) return []
  const wanted = new Set(runIds)
  const adopted: string[] = []
  const adoptedTaskIds: string[] = []
  for (const task of document.tasks) {
    const value = record(task)
    const id = String(value.id || '')
    const runId = String(value.runId || '')
    if (value.status !== 'running' || (!wanted.has(id) && !wanted.has(runId))) continue
    value.status = 'queued'
    delete value.startedAt
    delete value.endedAt
    delete value.runId
    value.error = `Orphan run adopted by sidecar ${owner}; queued for resume`
    adopted.push(runId || id)
    if (id) adoptedTaskIds.push(id)
  }
  if (!adopted.length) return []
  for (const taskId of adoptedTaskIds) {
    appendEvent(userDataDir, taskId, {
      eventId: `orphan-claim:${owner}:${taskId}`,
      kind: 'status',
      text: `orphan run claimed by sidecar ${owner}`,
      data: { orphanClaim: owner }
    })
    const task = document.tasks.find((entry) => String(record(entry).id || '') === taskId)
    if (task) record(task).eventCount = new EventLog(eventFile(userDataDir, taskId)).count()
  }
  const tmp = `${file}.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(document, null, 2), 'utf8')
  fs.renameSync(tmp, file)
  return adopted
}

/** Start the standalone business process. It is intentionally dependency-free
 * so electron-vite can bundle it and node can run it during recovery tests. */
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
      } else if (method === 'tasks.start') {
        const task = typeof params.id === 'string' ? runtime.store.get(params.id) : null
        if (!task || task.status !== 'queued') throw new Error('task is not queued')
        runtime.store.update(task.id, { parked: undefined })
        runtime.start()
        runtime.runner.enqueue(runtime.store.get(task.id)!)
        result = runtime.store.get(task.id)
      } else if (method === 'tasks.cancel') {
        if (typeof params.id !== 'string') throw new Error('task id is required')
        result = await runtime.runner.cancel(params.id)
      } else if (method === 'tasks.retry') {
        if (typeof params.id !== 'string') throw new Error('task id is required')
        const task = runtime.store.get(params.id)
        if (!task || task.status === 'running' || task.status === 'queued') throw new Error('task cannot be retried')
        await runtime.runner.closeSession(task.id)
        runtime.store.update(task.id, { status: 'queued', error: undefined, failure: undefined, result: undefined, sessionId: undefined, attempt: undefined, runId: undefined })
        runtime.start()
        runtime.runner.enqueue(runtime.store.get(task.id)!)
        result = { ok: true }
      } else if (method === 'tasks.followup') {
        if (typeof params.id !== 'string' || typeof params.content !== 'string') throw new Error('task id and content are required')
        result = await runtime.runner.followUp(params.id, params.content, params.options as { relay?: boolean } | undefined)
      } else if (method === 'events.replay' || method === 'events.read') {
        const taskId = typeof params.taskId === 'string' ? params.taskId : ''
        if (!taskId) throw new Error('taskId is required')
        result = readEvents(options.userDataDir, taskId, typeof params.afterSeq === 'number' ? params.afterSeq : 0)
      } else if (method === 'events.append') {
        const taskId = typeof params.taskId === 'string' ? params.taskId : ''
        if (!taskId || params.event === undefined) throw new Error('taskId and event are required')
        result = appendEvent(options.userDataDir, taskId, params.event)
      } else if (method === 'runs.takeover' || method === 'runs.claim') {
        const state = durableState(options.userDataDir)
        const file = path.join(options.userDataDir, 'sidecar-orphans.json')
        const now = Date.now()
        const prior = (() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) as JsonRecord } catch { return {} } })()
        const priorLease = typeof prior.leaseExpiresAt === 'number' ? prior.leaseExpiresAt : 0
        const leaseActive = priorLease > now && (prior.instanceId === instanceId || processAlive(prior.pid))
        const candidates = state.orphanRuns.map((task) => String(record(task).runId || record(task).id || '')).filter(Boolean)
        // A live lease prevents two sidecars from both claiming the same run.
        // Expired leases are safely replaced and remain auditable on disk.
        const runIds = leaseActive && Array.isArray(prior.runIds) ? [] : candidates
        const takeover = {
          protocolVersion: SIDECAR_PROTOCOL_VERSION,
          instanceId,
          pid: process.pid,
          claimedAt: now,
          leaseExpiresAt: now + 30_000,
          runIds
        }
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(`${file}.tmp`, JSON.stringify(takeover, null, 2), 'utf8')
        fs.renameSync(`${file}.tmp`, file)
        const adopted = runIds.length ? claimOrphanTasks(options.userDataDir, runIds, instanceId) : []
        if (adopted.length) runtime.refreshAfterTakeover()
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
