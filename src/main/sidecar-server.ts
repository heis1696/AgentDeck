import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { SIDECAR_PROTOCOL_VERSION } from './sidecar'
import { SIDECAR_PROTOCOL } from './sidecar/protocol'

type JsonRecord = Record<string, unknown>
let liveSequence = 0

function record(value: unknown): JsonRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {} }
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
  const orphanRuns = tasks.filter((task) => record(task).status === 'running')
  return { tasks, issues, runs, comments, notifications, goals, checkpoints, orphanRuns }
}

function readEvents(userDataDir: string, taskId: string, afterSeq = 0) {
  const file = eventFile(userDataDir, taskId)
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try {
        const event = JSON.parse(line) as JsonRecord
        return typeof event.seq === 'number' && event.seq > afterSeq ? [event] : []
      } catch { return [] }
    })
  } catch { return [] }
}

function eventFile(userDataDir: string, taskId: string) {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(taskId)) throw new Error('invalid taskId')
  const root = path.resolve(userDataDir, 'tasks')
  const file = path.resolve(root, taskId, 'events.jsonl')
  if (!file.startsWith(`${root}${path.sep}`)) throw new Error('invalid taskId')
  return file
}

function appendEvent(userDataDir: string, taskId: string, input: unknown) {
  const file = eventFile(userDataDir, taskId)
  const event = record(input)
  const lines = (() => { try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean) } catch { return [] } })()
  const prior = lines.flatMap((line) => { try { return [JSON.parse(line) as JsonRecord] } catch { return [] } })
  const identity = typeof event.eventId === 'string' ? event.eventId : typeof event.id === 'string' ? event.id : ''
  if (identity) {
    const duplicate = prior.find((candidate) => candidate.eventId === identity || candidate.id === identity)
    if (duplicate) return duplicate
  }
  const maxSeq = prior.reduce((max, candidate) => typeof candidate.seq === 'number' && Number.isFinite(candidate.seq) ? Math.max(max, candidate.seq) : max, 0)
  const live = event.durability === 'live' || event.durable === false
  if (live) {
    const liveSeq = maxSeq + (++liveSequence / 1_000_000)
    return { ...event, seq: liveSeq, ts: typeof event.ts === 'number' ? event.ts : Date.now(), v: 1, version: 1, durability: 'live', durable: false }
  }
  const normalized = { ...event, seq: maxSeq + 1, ts: typeof event.ts === 'number' ? event.ts : Date.now(), v: 1, version: 1, durability: 'durable', durable: { aggregate: 'task', seq: maxSeq + 1, version: 1 } }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const fd = fs.openSync(file, 'a')
  try { fs.writeSync(fd, JSON.stringify(normalized) + '\n', undefined, 'utf8'); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  return normalized
}

/** Start the standalone business process. It is intentionally dependency-free
 * so electron-vite can bundle it and node can run it during recovery tests. */
export function startSidecarServer(options: SidecarServerOptions): SidecarServer {
  if (!options.token) throw new Error('sidecar token is required')
  const instanceId = options.instanceId || crypto.randomUUID()
  const startedAt = Date.now()
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
        const state = durableState(options.userDataDir)
        result = { protocol: SIDECAR_PROTOCOL, version: SIDECAR_PROTOCOL_VERSION, protocolVersion: SIDECAR_PROTOCOL_VERSION, instanceId, generatedAt: Date.now(), sidecar: { ...healthPayload(), orphanRuns: state.orphanRuns }, ...state }
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
        const takeover = { protocolVersion: SIDECAR_PROTOCOL_VERSION, instanceId, claimedAt: Date.now(), runIds: state.orphanRuns.map((task) => record(task).runId || record(task).id).filter(Boolean) }
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(`${file}.tmp`, JSON.stringify(takeover, null, 2), 'utf8')
        fs.renameSync(`${file}.tmp`, file)
        result = { adopted: takeover.runIds, orphanRuns: state.orphanRuns }
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
    if (closing && !server.listening) return resolve()
    server.close(() => resolve())
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
