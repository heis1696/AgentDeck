import type { PermissionRequest } from '../../shared/contracts'
import type { TaskEvent } from '../../shared/types'
import type { AgentBackend, BackendSession, BackendSessionEvents } from './types'

type RecordValue = Record<string, unknown>
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
const LIVE_TYPES = new Set(['text.delta', 'reasoning.delta', 'tool.input.delta', 'compaction.delta'])

function record(value: unknown): RecordValue { return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {} }
function stringValue(value: unknown, fallback = ''): string { return typeof value === 'string' ? value : fallback }
function numberValue(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined }
function parseJson(text: string): unknown { try { return JSON.parse(text) } catch { return undefined } }
function responseJson(response: Response, timeoutMs = 15_000): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<unknown>((_, reject) => { timer = setTimeout(() => reject(new OpencodeServerUnavailableError('OpenCode response timed out')), timeoutMs) })
  const body = response.text().then((text) => text ? parseJson(text) : undefined)
  return Promise.race([body, timeout]).finally(() => { if (timer) clearTimeout(timer) })
}
function payloadOf(value: RecordValue): RecordValue { return record(value.properties ?? value.payload ?? value.data ?? value) }
function eventType(value: RecordValue): string { return stringValue(value.type ?? value.event ?? value.name) }
function eventSession(value: RecordValue, payload: RecordValue): string { return stringValue(value.sessionID ?? value.sessionId ?? payload.sessionID ?? payload.sessionId) }
function eventSequence(value: RecordValue, payload: RecordValue): number | undefined { return numberValue(value.seq) ?? numberValue(value.sequence) ?? numberValue(payload.seq) ?? numberValue(payload.sequence) }

export class OpencodeServerVersionError extends Error {
  constructor(message: string) { super(message); this.name = 'OpencodeServerVersionError' }
}
export class OpencodeServerUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = 'OpencodeServerUnavailableError' }
}
export function validateOpencodeVersion(version: string): string {
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(version.trim())
  if (!match) throw new OpencodeServerVersionError(`Unrecognised OpenCode server version: ${version || '(empty)'}`)
  if (Number(match[1]) !== 1) throw new OpencodeServerVersionError(`Unsupported OpenCode server version: ${version}`)
  return version.trim()
}

export interface OpencodeServerClientOptions {
  baseUrl: string
  fetch?: FetchLike
  directory?: string
  skipVersionProbe?: boolean
  requestTimeoutMs?: number
}

/** REST/SSE client for OpenCode. Current endpoint names are used first, with
 * compatibility fallbacks for the short-lived server protocol. */
export class OpencodeServerClient {
  readonly baseUrl: string
  private readonly fetchFn: FetchLike
  private readonly directory?: string
  private readonly requestTimeoutMs: number
  private streamMode: 'global' | 'session' = 'global'
  constructor(options: OpencodeServerClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.fetchFn = options.fetch ?? fetch
    this.directory = options.directory
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000
  }
  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    if (!headers.has('accept')) headers.set('accept', 'application/json')
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
    if (this.directory) headers.set('x-opencode-directory', this.directory)
    const request = this.fetchFn(new URL(path, this.baseUrl), { ...init, headers })
    // Health/command calls must not leave a TaskRunner blocked forever while
    // a sidecar is half-started. SSE is intentionally excluded because its
    // response remains open until the caller aborts it.
    if (headers.get('accept') === 'text/event-stream') return request
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<Response>((_, reject) => { timer = setTimeout(() => reject(new OpencodeServerUnavailableError(`OpenCode request timed out: ${path}`)), this.requestTimeoutMs) })
    try { return await Promise.race([request, timeout]) } finally { if (timer) clearTimeout(timer) }
  }
  private query(path: string, directory?: string): string { return directory ? `${path}${path.includes('?') ? '&' : '?'}directory=${encodeURIComponent(directory)}` : path }
  async version(): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
    let lastError = ''
    for (const path of ['/global/health', '/health', '/version']) {
      try {
        const response = await this.request(path)
        const value = record(await responseJson(response, this.requestTimeoutMs))
        if (!response.ok) { lastError = `${path} HTTP ${response.status}`; continue }
        const data = record(value.data)
        const raw = stringValue(value.version ?? data.version ?? value.opencodeVersion)
        if (!raw) { lastError = `${path} returned no version`; continue }
        return { ok: true, version: validateOpencodeVersion(raw) }
      } catch (error) {
        if (error instanceof OpencodeServerVersionError) throw error
        lastError = error instanceof Error ? error.message : String(error)
      }
    }
    return { ok: false, error: `OpenCode server version probe failed: ${lastError || 'unknown error'}` }
  }
  private async json(path: string, method: string, body?: unknown): Promise<unknown> {
    let response: Response
    try { response = await this.request(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }) }
    catch (error) { throw new OpencodeServerUnavailableError(error instanceof Error ? error.message : String(error)) }
    const value = await responseJson(response, this.requestTimeoutMs)
    if (!response.ok) {
      const object = record(value)
      throw new Error(`OpenCode ${method} ${path} failed: ${stringValue(object.message ?? object.error, `HTTP ${response.status}`)}`)
    }
    return value
  }
  async createSession(directory = this.directory || process.cwd(), model?: string): Promise<string> {
    const body: RecordValue = {}
    const parsed = model?.includes('/') ? model.split('/', 2) : undefined
    if (parsed) body.model = { providerID: parsed[0], id: parsed[1] }
    let value: RecordValue
    try { value = record(await this.json(`/session?directory=${encodeURIComponent(directory)}`, 'POST', body)) }
    catch (error) {
      if (!String(error).includes('HTTP 404')) throw error
      value = record(await this.json('/session/create', 'POST', { ...body, directory }))
    }
    const data = record(value.data)
    const session = record(value.session)
    const result = record(value.result)
    const id = stringValue(value.id ?? value.sessionID ?? value.sessionId ?? data.id ?? data.sessionID ?? data.sessionId ?? session.id ?? session.sessionID ?? session.sessionId ?? result.id ?? result.sessionID ?? result.sessionId)
    if (!id) throw new Error('OpenCode server returned no session id')
    return id
  }
  async prompt(sessionId: string, directoryOrText: string, textOrModel?: string, model?: string): Promise<void> {
    // Keep the original client shape `(sessionId, text, model?)` available to
    // callers while the backend uses `(sessionId, directory, text, model)`.
    const legacy = arguments.length < 4
    const directory = legacy ? (this.directory || process.cwd()) : directoryOrText
    const text = legacy ? directoryOrText : (textOrModel ?? '')
    if (legacy) model = textOrModel
    const body: RecordValue = { parts: [{ type: 'text', text }] }
    const parsed = model?.includes('/') ? model.split('/', 2) : undefined
    if (parsed) body.model = { providerID: parsed[0], modelID: parsed[1] }
    const base = `/session/${encodeURIComponent(sessionId)}`
    try { await this.json(this.query(`${base}/prompt_async`, directory), 'POST', body) }
    catch (error) { if (!String(error).includes('HTTP 404')) throw error; await this.json(this.query(`${base}/prompt`, directory), 'POST', body) }
  }
  async interrupt(sessionId: string, directory = this.directory || process.cwd()): Promise<void> {
    const base = `/session/${encodeURIComponent(sessionId)}`
    try { await this.json(this.query(`${base}/abort`, directory), 'POST') }
    catch (error) { if (!String(error).includes('HTTP 404')) throw error; await this.json(this.query(`${base}/interrupt`, directory), 'POST') }
  }
  async close(sessionId: string, directory = this.directory || process.cwd()): Promise<void> {
    const path = this.query(`/session/${encodeURIComponent(sessionId)}`, directory)
    try { await this.json(path, 'DELETE') }
    catch (error) { if (!String(error).includes('HTTP 404')) throw error; await this.json(this.query(`/session/${encodeURIComponent(sessionId)}/close`, directory), 'POST') }
  }
  async messages(sessionId: string, directory = this.directory || process.cwd()): Promise<unknown[]> {
    const value = await this.json(this.query(`/session/${encodeURIComponent(sessionId)}/message`, directory), 'GET')
    return Array.isArray(value) ? value : Array.isArray(record(value).data) ? record(value).data as unknown[] : []
  }
  async permissionReply(requestId: string | number, decision: 'allow' | 'deny', directory = this.directory || process.cwd(), replyOverride?: 'once' | 'always' | 'reject'): Promise<void> {
    const id = encodeURIComponent(String(requestId))
    const reply = replyOverride ?? (decision === 'allow' ? 'once' : 'reject')
    try {
      await this.json(this.query(`/permission/${id}/reply`, directory), 'POST', { reply, message: decision === 'allow' ? 'Allowed by AgentDeck' : 'Denied by AgentDeck' })
    } catch (error) {
      if (!String(error).includes('HTTP 404')) throw error
      await this.json(this.query(`/permission/${id}`, directory), 'POST', { response: decision })
    }
  }
  async stream(sessionId: string, after: number, directory: string, signal: AbortSignal, onEvent: (value: unknown) => Promise<void> | void): Promise<void>
  async stream(sessionId: string, after: number, signal: AbortSignal, onEvent: (value: unknown) => Promise<void> | void): Promise<void>
  async stream(sessionId: string, after: number, directoryOrSignal: string | AbortSignal, signalOrHandler: AbortSignal | ((value: unknown) => Promise<void> | void), maybeHandler?: (value: unknown) => Promise<void> | void): Promise<void> {
    const legacy = typeof directoryOrSignal !== 'string'
    const directory = legacy ? (this.directory || process.cwd()) : directoryOrSignal
    const signal = (legacy ? directoryOrSignal : signalOrHandler) as AbortSignal
    const onEvent = (legacy ? signalOrHandler : maybeHandler) as (value: unknown) => Promise<void> | void
    const cursor = Math.max(0, Math.floor(after))
    const globalPath = this.query(`/event?after=${cursor}`, directory)
    const sessionPath = this.query(`/session/${encodeURIComponent(sessionId)}/event?after=${cursor}`, directory)
    const paths = this.streamMode === 'session' ? [sessionPath, globalPath] : [globalPath, sessionPath]
    let response: Response | undefined
    let chosen = 0
    for (const path of paths) {
      const candidate = await this.request(path, { headers: { accept: 'text/event-stream' }, signal })
      if (candidate.ok) { response = candidate; break }
      if (candidate.status !== 404) throw new Error(`OpenCode SSE failed: HTTP ${candidate.status}`)
      chosen++
    }
    if (!response) throw new Error('OpenCode SSE endpoint unavailable')
    this.streamMode = chosen === 1 ? 'session' : 'global'
    if (!response.body) throw new Error('OpenCode SSE response has no body')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let dataLines: string[] = []
    const dispatch = async () => { if (!dataLines.length) return; const value = parseJson(dataLines.join('\n')); dataLines = []; if (value !== undefined) await onEvent(value) }
    try {
      while (!signal.aborted) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        let newline = -1
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, '')
          buffer = buffer.slice(newline + 1)
          if (!line) { await dispatch(); continue }
          if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
        }
      }
      if (buffer.startsWith('data:')) dataLines.push(buffer.slice(5).trimStart())
      await dispatch()
    } finally { try { await reader.cancel() } catch {} }
  }
}

function permissionRequest(payload: RecordValue): PermissionRequest | null {
  const requestId = payload.id ?? payload.requestID ?? payload.requestId
  if (typeof requestId !== 'string' && typeof requestId !== 'number') return null
  const metadata = record(payload.metadata)
  const options = Array.isArray(payload.options) ? payload.options.map((item, index) => {
    const option = record(item)
    const optionId = stringValue(option.optionId ?? option.id, index === 0 ? 'allow' : 'deny')
    const decision = stringValue(record(option.response).decision ?? option.decision, optionId === 'allow' ? 'allow' : 'deny')
    return { optionId, name: stringValue(option.name ?? option.label, optionId), ...(stringValue(option.description) ? { description: stringValue(option.description) } : {}), response: { decision } }
  }) : []
  if (!options.length) options.push({ optionId: 'allow', name: 'Allow', response: { decision: 'allow' } }, { optionId: 'deny', name: 'Deny', response: { decision: 'deny' } })
  return { requestId, toolName: stringValue(payload.toolName ?? payload.permission ?? payload.tool ?? metadata.tool, 'opencode'), reason: stringValue(payload.reason ?? payload.description ?? metadata.description, 'OpenCode requested permission'), riskLevel: stringValue(payload.riskLevel ?? payload.risk ?? payload.permission, 'unknown'), input: payload.input ?? metadata, options }
}
function usageData(payload: RecordValue): { total?: number; data: RecordValue } {
  const tokens = record(payload.tokens)
  const input = numberValue(tokens.input) ?? numberValue(payload.inputTokens)
  const output = numberValue(tokens.output) ?? numberValue(payload.outputTokens)
  const reasoning = numberValue(tokens.reasoning) ?? numberValue(payload.reasoningTokens)
  const total = numberValue(tokens.total) ?? numberValue(payload.totalTokens) ?? (input !== undefined || output !== undefined || reasoning !== undefined ? (input ?? 0) + (output ?? 0) + (reasoning ?? 0) : undefined)
  const cost = numberValue(payload.cost) ?? numberValue(payload.costUsd)
  const time = record(payload.time)
  const durationMs = numberValue(payload.durationMs) ?? (numberValue(time.end) !== undefined && numberValue(time.start) !== undefined ? (numberValue(time.end)! - numberValue(time.start)!) : undefined)
  return { total, data: { ...payload, ...(input !== undefined || output !== undefined || reasoning !== undefined || total !== undefined ? { inputTokens: input, outputTokens: output, reasoningTokens: reasoning, totalTokens: total } : {}), ...(cost !== undefined ? { costUsd: cost } : {}), ...(durationMs !== undefined ? { durationMs } : {}) } }
}

export interface OpencodeServerBackendOptions extends OpencodeServerClientOptions { required?: boolean }

export function createOpencodeServerBackend(options: OpencodeServerBackendOptions): AgentBackend {
  return {
    id: 'opencode', label: 'OpenCode',
    async probe() {
      try {
        const result = await new OpencodeServerClient(options).version()
        return result.ok ? { ok: true, detail: `OpenCode server ${result.version}` } : { ok: false, detail: result.error }
      } catch (error) { return { ok: false, detail: error instanceof Error ? error.message : String(error) } }
    },
    async start({ prompt, workdir, mode, events, resumeSessionId, model }) {
      const directory = workdir || options.directory || process.cwd()
      const client = new OpencodeServerClient({ ...options, directory, requestTimeoutMs: options.requestTimeoutMs ?? 5_000 })
      if (!options.skipVersionProbe) {
        const result = await client.version()
        if (!result.ok) throw new OpencodeServerUnavailableError(result.error)
      }
      const sessionId = resumeSessionId || await client.createSession(directory, model)
      events.onSessionId?.(sessionId)
      const abort = new AbortController()
      let closed = false
      let cursor = 0
      let active: { startedAt: number; text: Map<string, string>; reasoning: Map<string, string>; tokens?: number; resolve: (r: { ok: boolean; response: string; error?: string; tokenCount?: number; durationMs?: number }) => void; ended: boolean } | undefined
      const seen = new Set<string>()
      const emit = (event: Omit<TaskEvent, 'seq' | 'ts'>) => events.onEvent({ ...event, ts: Date.now() })
      const finish = (ok: boolean, error?: string, responseOverride?: string) => {
        const turn = active
        if (!turn || turn.ended) return
        turn.ended = true; active = undefined
        const explicit = [...turn.text.entries()].filter(([id, value]) => id !== '__stream' && value).map(([, value]) => value)
        const allText = explicit.join('\n').trim()
        const response = responseOverride ?? (explicit.length ? explicit[explicit.length - 1].trim() : (turn.text.get('__stream') ?? '').trim())
        if (response) emit({ kind: 'final', type: 'text.ended', durability: 'durable', durable: true, text: response })
        const durationMs = Date.now() - turn.startedAt
        events.onTurnEnd({ ok, response, error, tokenCount: turn.tokens, durationMs, delegationText: allText && allText !== response ? allText : undefined })
        turn.resolve({ ok, response, error, tokenCount: turn.tokens, durationMs })
      }
      const handleEvent = async (value: unknown) => {
        const raw = record(value); const type = eventType(raw); const payload = payloadOf(raw); const sid = eventSession(raw, payload)
        const seq = eventSequence(raw, payload)
        cursor = Math.max(cursor, seq ?? cursor + 1)
        if (sid && sid !== sessionId) return
        events.onHeartbeat?.()
        const id = stringValue(raw.id ?? payload.eventId)
        if (id) { if (seen.has(id)) return; seen.add(id); if (seen.size > 5000) seen.delete(seen.values().next().value as string) }
        if (type === 'server.connected') return
        if (type === 'permission.asked' || type === 'permission.ask') {
          const request = permissionRequest(payload); if (!request) return
          const choice = mode === 'yolo'
            ? { decision: 'allow' as const }
            : await events.onPermission?.(request) ?? { decision: 'deny' as const }
          const selected = request.options.find((option) => option.optionId === choice.optionId)
          const selectedReply = selected?.response.decision === 'always' ? 'always' : selected?.response.decision === 'reject' ? 'reject' : undefined
          try { await client.permissionReply(request.requestId, choice.decision, directory, selectedReply) } catch (error) { emit({ kind: 'error', type: 'permission.error', durability: 'durable', durable: true, text: error instanceof Error ? error.message : String(error) }) }
          return
        }
        if (type === 'message.part.delta') {
          const field = stringValue(payload.field).toLowerCase(); const delta = stringValue(payload.delta); if (!delta) return
          const mapped = field.includes('reason') ? 'reasoning.delta' : field.includes('compaction') ? 'compaction.delta' : field.includes('input') || field.includes('tool') ? 'tool.input.delta' : 'text.delta'
          if (mapped === 'text.delta' && active) active.text.set('__stream', (active.text.get('__stream') ?? '') + delta)
          emit({ kind: 'text', type: mapped, durability: 'live', durable: false, text: delta, data: payload }); return
        }
        if (type === 'message.updated' && Array.isArray(payload.parts)) {
          for (const part of payload.parts) await handleEvent({ id: `part:${stringValue(record(part).id)}`, type: 'message.part.updated', properties: { sessionID: sessionId, part } })
          return
        }
        const part = record(payload.part ?? raw.part); const partType = stringValue(part.type)
        if (type === 'message.part.updated' || type === 'message.part' || (type === 'message.part.delta' && Object.keys(part).length)) {
          if (partType === 'text' && typeof part.text === 'string') {
            const id = stringValue(part.id, `text-${active?.text.size ?? 0}`); const previous = active?.text.get(id) ?? ''; active?.text.set(id, part.text)
            if (part.text.length > previous.length && part.text.startsWith(previous)) emit({ kind: 'text', type: 'text.delta', durability: 'live', durable: false, text: part.text.slice(previous.length) })
            else if (part.text !== previous) emit({ kind: 'text', type: 'text.delta', durability: 'live', durable: false, text: part.text })
          } else if (partType === 'reasoning' && typeof part.text === 'string') {
            const id = stringValue(part.id, `reasoning-${active?.reasoning.size ?? 0}`)
            const previous = active?.reasoning.get(id) ?? ''
            active?.reasoning.set(id, part.text)
            const delta = part.text.startsWith(previous) ? part.text.slice(previous.length) : part.text
            if (delta) emit({ kind: 'text', type: 'reasoning.delta', durability: 'live', durable: false, text: delta, data: { reasoning: true } })
          }
          else if (partType === 'tool') {
            const state = record(part.state); const status = stringValue(state.status ?? part.status); const name = stringValue(part.tool ?? part.name, 'tool')
            if (status === 'pending' || status === 'running') emit({ kind: 'tool', type: 'tool.started', text: name, data: { phase: 'started', args: state.input ?? part.input } })
            else if (status === 'completed' || status === 'error') emit({ kind: 'tool', type: status === 'error' ? 'tool.error' : 'tool.result', durability: 'durable', durable: true, text: name, data: { phase: 'result', ok: status !== 'error', output: state.output ?? state.error } })
          } else if (partType === 'step-finish' || partType === 'step_finish') {
            const usage = usageData(part); if (usage.total !== undefined && active) active.tokens = usage.total; emit({ kind: 'usage', type: 'step-finish', durability: 'durable', durable: true, data: usage.data })
          } else if (partType === 'subtask' || partType === 'agent') emit({ kind: 'status', type: 'agent.fork', durability: 'durable', durable: true, text: stringValue(part.agent ?? part.name), data: part })
          return
        }
        if (type === 'session.next.reasoning.delta') { emit({ kind: 'text', type: 'reasoning.delta', durability: 'live', durable: false, text: stringValue(payload.delta), data: payload }); return }
        if (type === 'session.next.text.delta') { const delta = stringValue(payload.delta); if (delta) { if (active) active.text.set('__stream', (active.text.get('__stream') ?? '') + delta); emit({ kind: 'text', type: 'text.delta', durability: 'live', durable: false, text: delta, data: payload }) }; return }
        if (type === 'session.next.tool.input.delta' || type === 'session.next.compaction.delta') { emit({ kind: 'text', type: type.endsWith('compaction.delta') ? 'compaction.delta' : 'tool.input.delta', durability: 'live', durable: false, text: stringValue(payload.delta ?? payload.text), data: payload }); return }
        if (type === 'session.next.step.ended' || type === 'step-finish' || type === 'step_finish') { const usage = usageData(payload); if (usage.total !== undefined && active) active.tokens = usage.total; emit({ kind: 'usage', type, durability: 'durable', durable: true, data: usage.data }); return }
        if (type === 'session.error' || type === 'error' || type === 'session.next.step.failed') {
          const errorObject = record(payload.error); const errorData = record(errorObject.data)
          const message = stringValue(payload.message ?? errorObject.message ?? errorData.message ?? errorData.error ?? payload.error, 'OpenCode session error')
          emit({ kind: 'error', type: 'session.error', durability: 'durable', durable: true, text: message, data: payload }); finish(false, message); return
        }
        if (type.includes('compaction')) { const delta = stringValue(payload.delta ?? payload.text); if (type.endsWith('.delta')) emit({ kind: 'text', type: 'compaction.delta', durability: 'live', durable: false, text: delta, data: payload }); else emit({ kind: 'status', type, durability: 'durable', durable: true, text: stringValue(payload.reason ?? payload.message), data: payload }); return }
        if (type === 'session.created' && (payload.parentID || payload.parentId || record(payload.info).parentID)) { emit({ kind: 'status', type: 'session.fork', durability: 'durable', durable: true, text: stringValue(payload.id ?? payload.sessionID ?? record(payload.info).id), data: payload }); return }
        if (type === 'session.fork' || type === 'session.forked' || type === 'fork') { emit({ kind: 'status', type: 'session.fork', durability: 'durable', durable: true, text: stringValue(payload.childID ?? payload.sessionID), data: payload }); return }
        const status = stringValue(payload.status ?? record(payload.status).type)
        if (type === 'session.idle' || (type === 'session.status' && ['idle', 'completed', 'done'].includes(status))) {
          // OpenCode can briefly become idle between tool-call steps. Treat
          // an empty idle as provisional and wait for the assistant text (or
          // a subsequent idle) so a tool-only intermediate message is not a
          // false durable turn completion.
          const hasResponse = !!active && ([...active.text.values()].some((value) => !!value))
          if (hasResponse) finish(true)
          return
        }
        if (type) emit({ kind: 'raw', type, rawKind: type, durability: LIVE_TYPES.has(type) ? 'live' : 'durable', durable: !LIVE_TYPES.has(type), data: payload })
      }
      const stream = (async () => {
        let failures = 0
        while (!abort.signal.aborted && !closed) {
          try { await client.stream(sessionId, cursor, directory, abort.signal, handleEvent); failures = 0; if (!abort.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 1_000)) }
          catch (error) {
            if (abort.signal.aborted || closed) break
            failures++; if (failures >= 5 && active) finish(false, error instanceof Error ? error.message : String(error)); await new Promise((resolve) => setTimeout(resolve, Math.min(1000, failures * 100)))
          }
        }
      })()
      // A few OpenCode builds keep the global SSE connection alive but do not
      // publish message events. Polling is deliberately a read-side safety
      // net; discovered parts go through handleEvent, so replay/idempotency
      // and durable/live classification remain identical.
      const poll = (async () => {
        const delivered = new Map<string, string>()
        while (!abort.signal.aborted && !closed) {
          try {
            // Session ids are globally addressable. Prefer an unscoped read:
            // some versions pin sessions to the server project and block or
            // ignore a mismatching directory query on the message endpoint.
            let messages = await client.messages(sessionId, '')
            if (!messages.length && directory) messages = await client.messages(sessionId, directory)
            const turn = active
            if (turn) {
              let latestCompleted: string | undefined
              let latestCreated = -Infinity
              for (const item of messages) {
                const message = record(item)
                const info = record(message.info ?? message)
                if (stringValue(info.role) !== 'assistant') continue
                const created = numberValue(info.time && record(info.time).created)
                if (created !== undefined && created + 1000 < turn.startedAt) continue
                const parts = Array.isArray(message.parts) ? message.parts : []
                const hasText = parts.some((part) => stringValue(record(part).type) === 'text' && !!stringValue(record(part).text))
                if (hasText && info.time && record(info.time).completed !== undefined && (created ?? 0) >= latestCreated) { latestCreated = created ?? 0; latestCompleted = stringValue(info.id) }
                for (const part of parts) {
                  const id = stringValue(record(part).id)
                  if (!id) continue
                  let signature = ''
                  try { signature = JSON.stringify(part) } catch { signature = String(record(part).type) }
                  if (delivered.get(id) === signature) continue
                  delivered.set(id, signature)
                  await handleEvent({ id: `poll:${id}`, type: 'message.part.updated', properties: { sessionID: sessionId, part } })
                }
              }
              if (latestCompleted) await handleEvent({ id: `poll:idle:${latestCompleted}`, type: 'session.idle', properties: { sessionID: sessionId } })
            }
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
      })()
      const runTurn = async (content: string) => {
        if (closed) throw new Error('OpenCode session is closed')
        const result = new Promise<{ ok: boolean; response: string; error?: string; tokenCount?: number; durationMs?: number }>((resolve) => { active = { startedAt: Date.now(), text: new Map(), reasoning: new Map(), resolve, ended: false } })
        try { await client.prompt(sessionId, directory, content, model) }
        catch (error) { active?.resolve({ ok: false, response: '', error: error instanceof Error ? error.message : String(error) }); active = undefined; return result }
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<{ ok: boolean; response: string; error: string }>((resolve) => { timer = setTimeout(() => { finish(false, 'OpenCode session prompt timed out'); resolve({ ok: false, response: '', error: 'OpenCode session prompt timed out' }) }, 10 * 60 * 1000) })
        try { return await Promise.race([result, timeout]) } finally { if (timer) clearTimeout(timer) }
      }
      events.onLaunch?.({ stop: () => client.interrupt(sessionId, directory) })
      const first = await runTurn(prompt)
      if (!first.ok) { abort.abort(); throw new Error(first.error || 'OpenCode server turn failed') }
      const session: BackendSession = {
        sessionId,
        async send(content) { const result = await runTurn(content); if (!result.ok) throw new Error(result.error || 'OpenCode server turn failed') },
        async stop() { try { await client.interrupt(sessionId, directory) } catch {} finally { finish(false, 'OpenCode session interrupted') } },
        async close() { if (closed) return; if (active) finish(false, 'OpenCode session closed'); closed = true; abort.abort(); await client.close(sessionId, directory).catch(() => {}); await Promise.race([Promise.allSettled([stream, poll]), new Promise((resolve) => setTimeout(resolve, 1000))]) }
      }
      return session
    }
  }
}
