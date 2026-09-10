import type { BackendSession } from './backends/types'
import type { TaskStatus } from '../shared/types'
import { isTerminalTaskStatus } from '../shared/taskflow'

/**
 * A small, dependency-free gate for callbacks emitted by an agent backend.
 *
 * Backends are allowed to emit callbacks after `stop()`/`close()` resolves (and
 * some providers emit them after a new session has already been started).  A
 * callback is accepted only when it still belongs to the current generation,
 * task status and session owner.  Keeping this decision in one object makes it
 * difficult for a new callback path to accidentally bypass the lifecycle.
 */
export interface EventGateState {
  status: TaskStatus
  generation: number
  sessionOwner?: string
  titleMode: boolean
  pendingResume: boolean
}

export interface EventGateToken {
  readonly generation: number
  readonly sessionOwner?: string
}

export interface EventGateAcceptOptions {
  /** Event kind is intentionally structural to keep this module backend-free. */
  kind?: string
  /** Terminal callbacks (onTurnEnd/onSessionEnd) are checked separately. */
  terminal?: boolean
  /** Optional owner check for callers that do not keep a token. */
  sessionOwner?: string
}

const TITLE_SAFE_EVENTS = new Set(['error'])

function awaitCleanup(action: () => Promise<unknown> | void, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    timer = setTimeout(finish, timeoutMs)
    Promise.resolve().then(action).then(finish, finish)
  })
}

export class EventGate {
  private stateValue: EventGateState

  constructor(initial: Partial<EventGateState> = {}) {
    this.stateValue = {
      status: initial.status ?? 'queued',
      generation: initial.generation ?? 0,
      sessionOwner: initial.sessionOwner,
      titleMode: initial.titleMode ?? false,
      pendingResume: initial.pendingResume ?? false
    }
  }

  get state(): EventGateState {
    return { ...this.stateValue }
  }

  get generation() {
    return this.stateValue.generation
  }

  /** Start a new turn and return an immutable token for its callbacks. */
  begin(options: Partial<Pick<EventGateState, 'sessionOwner' | 'titleMode' | 'pendingResume'>> = {}): EventGateToken {
    this.stateValue = {
      ...this.stateValue,
      generation: this.stateValue.generation + 1,
      status: 'running',
      sessionOwner: options.sessionOwner,
      titleMode: options.titleMode ?? false,
      pendingResume: options.pendingResume ?? false
    }
    return this.token()
  }

  /** Alias useful to code that calls a turn an execution attempt. */
  beginTurn(options: Partial<Pick<EventGateState, 'sessionOwner' | 'titleMode' | 'pendingResume'>> = {}) {
    return this.begin(options)
  }

  token(): EventGateToken {
    const { generation, sessionOwner } = this.stateValue
    return Object.freeze({ generation, sessionOwner })
  }

  /** Invalidate all previously issued tokens without changing task status. */
  invalidate() {
    this.stateValue = { ...this.stateValue, generation: this.stateValue.generation + 1 }
    return this.stateValue.generation
  }

  bump() {
    return this.invalidate()
  }

  setStatus(status: TaskStatus) {
    this.stateValue = { ...this.stateValue, status }
  }

  setSessionOwner(sessionOwner?: string) {
    this.stateValue = { ...this.stateValue, sessionOwner }
  }

  setTitleMode(titleMode: boolean) {
    this.stateValue = { ...this.stateValue, titleMode }
  }

  setPendingResume(pendingResume: boolean) {
    this.stateValue = { ...this.stateValue, pendingResume }
  }

  /**
   * The single production decision point for backend events.  Terminal task
   * states reject every event, including old final/error callbacks.
   */
  accepts(token?: EventGateToken, options: EventGateAcceptOptions = {}): boolean {
    const state = this.stateValue
    if (isTerminalTaskStatus(state.status) || state.status !== 'running') return false
    if (token && token.generation !== state.generation) return false
    const owner = options.sessionOwner ?? token?.sessionOwner
    if (owner !== undefined && state.sessionOwner !== undefined && owner !== state.sessionOwner) return false
    // A token without an owner is allowed during synchronous startup, before
    // the provider has announced its session id. Generation still fences old
    // turns, while an explicit owner fences replaced sessions.
    // Title-mode events are hidden from the durable transcript by the runner,
    // but the terminal callback must still be admitted so the title request
    // can settle. Only ordinary event persistence is filtered here.
    if (state.titleMode && !options.terminal && options.kind && !TITLE_SAFE_EVENTS.has(options.kind)) return false
    // `pendingResume` is a state marker, not a requirement for initial turns;
    // callers use terminal=true to make the marker explicit when needed.
    if (options.terminal && state.pendingResume && !token) return false
    return true
  }

  canAccept(token?: EventGateToken, options?: EventGateAcceptOptions) {
    return this.accepts(token, options)
  }

  accept(token?: EventGateToken, options?: EventGateAcceptOptions) {
    return this.accepts(token, options)
  }

  acceptEvent(token?: EventGateToken, options?: EventGateAcceptOptions) {
    return this.accepts(token, options)
  }

  isCurrent(token?: EventGateToken) {
    return this.accepts(token)
  }

  snapshot() {
    return this.state
  }
}

export interface TurnLifecycleOptions {
  taskId?: string
  initialStatus?: TaskStatus
}

export interface TurnHandle extends EventGateToken {
  readonly taskId?: string
  readonly cancel: () => Promise<void>
}

interface OwnedSession {
  owner: string
  session: BackendSession
}

/**
 * Coordinates the mutable pieces surrounding one task's turns.  The runner
 * can continue persisting the compatibility Task while this object owns the
 * in-memory lifecycle boundaries (generation, owner, pending resume and late
 * session cleanup).
 */
export class TurnLifecycle {
  readonly taskId?: string
  readonly gate: EventGate
  private sessionValue?: OwnedSession
  private launchStop?: () => void | Promise<unknown>
  private pending = new Map<number, (value: unknown) => void>()

  constructor(options: TurnLifecycleOptions = {}) {
    this.taskId = options.taskId
    this.gate = new EventGate({ status: options.initialStatus ?? 'queued' })
  }

  get generation() {
    return this.gate.generation
  }

  get status() {
    return this.gate.state.status
  }

  get sessionOwner() {
    return this.gate.state.sessionOwner
  }

  get session() {
    return this.sessionValue?.session
  }

  get pendingResume() {
    return this.gate.state.pendingResume
  }

  begin(options: Partial<Pick<EventGateState, 'sessionOwner' | 'titleMode' | 'pendingResume'>> = {}): TurnHandle {
    // A task owns one in-flight turn. Invalidate any abandoned waiter before
    // opening the next generation so it cannot be resolved by a late event.
    for (const resolve of this.pending.values()) resolve(undefined)
    this.pending.clear()
    const token = this.gate.begin(options)
    return {
      ...token,
      taskId: this.taskId,
      cancel: () => this.cancel()
    }
  }

  beginTurn(options: Partial<Pick<EventGateState, 'sessionOwner' | 'titleMode' | 'pendingResume'>> = {}) {
    return this.begin(options)
  }

  start(options: Partial<Pick<EventGateState, 'sessionOwner' | 'titleMode' | 'pendingResume'>> = {}) {
    return this.begin(options)
  }

  setStatus(status: TaskStatus) {
    this.gate.setStatus(status)
  }

  setTitleMode(enabled: boolean) {
    this.gate.setTitleMode(enabled)
  }

  setPendingResume(enabled: boolean) {
    this.gate.setPendingResume(enabled)
  }

  registerResume<T = unknown>(token: EventGateToken, resolve: (value: T) => void) {
    if (!this.gate.accepts(token)) return () => {}
    if (this.pending.has(token.generation)) return () => {}
    this.gate.setPendingResume(true)
    this.pending.set(token.generation, resolve as (value: unknown) => void)
    return () => {
      this.pending.delete(token.generation)
      if (![...this.pending.keys()].length) this.gate.setPendingResume(false)
    }
  }

  resolveResume<T = unknown>(token: EventGateToken, value: T) {
    if (!this.gate.accepts(token, { terminal: true })) return false
    const resolve = this.pending.get(token.generation)
    if (!resolve) return false
    this.pending.delete(token.generation)
    this.gate.setPendingResume(false)
    resolve(value)
    return true
  }

  registerLaunch(stop: () => void | Promise<unknown>) {
    this.launchStop = stop
  }

  /** Attach a session only if the turn is still current; otherwise close it. */
  async attachSession(token: EventGateToken, session: BackendSession, owner = session.sessionId): Promise<boolean> {
    if (!this.gate.accepts(token)) {
      await awaitCleanup(() => session.close())
      return false
    }
    const previous = this.sessionValue
    this.sessionValue = { owner, session }
    this.gate.setSessionOwner(owner)
    if (previous && previous.session !== session) {
      await awaitCleanup(() => previous.session.stop())
      await awaitCleanup(() => previous.session.close())
    }
    return true
  }

  admitSession(token: EventGateToken, session: BackendSession, owner = session.sessionId) {
    return this.attachSession(token, session, owner)
  }

  claimSession(token: EventGateToken, session: BackendSession, owner = session.sessionId) {
    return this.attachSession(token, session, owner)
  }

  accepts(token?: EventGateToken, options?: EventGateAcceptOptions) {
    return this.gate.accepts(token, options)
  }

  accept(token?: EventGateToken, options?: EventGateAcceptOptions) {
    return this.gate.accepts(token, options)
  }

  invalidate() {
    return this.gate.invalidate()
  }

  /** Cancel is idempotent and awaits both provider stop and close. */
  async cancel(status: TaskStatus = 'cancelled') {
    this.gate.invalidate()
    this.gate.setStatus(status)
    this.gate.setSessionOwner(undefined)
    this.gate.setPendingResume(false)
    for (const resolve of this.pending.values()) resolve(undefined)
    this.pending.clear()
    try { await Promise.resolve(this.launchStop?.()) } catch {}
    this.launchStop = undefined
    const owned = this.sessionValue
    this.sessionValue = undefined
    if (owned) {
      await awaitCleanup(() => owned.session.stop())
      await awaitCleanup(() => owned.session.close())
    }
  }

  async timeout() {
    await this.cancel('failed')
  }

  dispose() {
    this.gate.invalidate()
    // Disposal is an in-memory terminal boundary. The durable Task status is
    // owned by TaskRunner and is not changed here, but callbacks must not be
    // admitted again if a caller accidentally retains this object.
    this.gate.setStatus('cancelled')
    this.gate.setSessionOwner(undefined)
    this.gate.setPendingResume(false)
    this.pending.clear()
    this.launchStop = undefined
    this.sessionValue = undefined
  }
}
