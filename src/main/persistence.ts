import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { types } from 'node:util'
import type { ExecutionOwner } from '../shared/types'

export interface ProcessIdentity {
  pid: number
  /** OS process creation identity, not a lease or an application timestamp. */
  instance: string
}

export type ProcessObservation = { state: 'alive' | 'dead' | 'unknown'; instance?: string }
export type ProcessProbe = (pid: number) => ProcessObservation
export type OwnerState = 'live' | 'dead' | 'unknown'
type LockKind = 'storage' | 'event'

export interface TransactionToken {
  readonly path: string
  readonly kind: LockKind
  readonly nonce: string
}

export type SynchronousAction<T, C = TransactionToken> = ((context: C) => T) & (T extends PromiseLike<unknown> ? never : unknown)

export function assertSynchronousAction(action: Function): void {
  if (types.isAsyncFunction(action) || Object.prototype.toString.call(action) === '[object AsyncFunction]') {
    throw new Error('Storage transactions must be synchronous')
  }
}

export function assertTransactionToken(token: TransactionToken): void {
  if (context.stack.at(-1)?.token !== token) throw new Error('Transaction token is no longer active')
}

type LockFrame = { token: TransactionToken }
type PersistenceContext = { stack: LockFrame[]; own?: ProcessIdentity }
const contextKey = Symbol.for('agentdeck.persistence.context.v1')
const globals = globalThis as typeof globalThis & { [contextKey]?: PersistenceContext }
const context = globals[contextKey] ??= { stack: [] }
const pause = new Int32Array(new SharedArrayBuffer(4))

function errorCode(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }

export function probeProcess(pid: number): ProcessObservation {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: 'unknown' }
  try { process.kill(pid, 0) }
  catch (error) { return { state: errorCode(error) === 'ESRCH' ? 'dead' : 'unknown' } }
  if (pid === process.pid && context.own) return { state: 'alive', instance: context.own.instance }
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      if (fields[0] === 'Z' || fields[0] === 'X') return { state: 'dead' }
      const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
      if (!boot || !/^\d+$/.test(fields[19] ?? '')) return { state: 'unknown' }
      return { state: 'alive', instance: `${boot}:${fields[19]}` }
    }
    if (process.platform === 'win32') {
      const instance = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `[Console]::Write((Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks)`], {
        encoding: 'utf8', windowsHide: true, timeout: pid === process.pid ? 2000 : 750, stdio: ['ignore', 'pipe', 'ignore']
      }).trim()
      return /^\d+$/.test(instance) ? { state: 'alive', instance } : { state: 'unknown' }
    }
    // A coarse ps timestamp cannot distinguish rapid PID reuse.
    return { state: 'unknown' }
  } catch {
    try { process.kill(pid, 0) }
    catch (error) { if (errorCode(error) === 'ESRCH') return { state: 'dead' } }
    return { state: 'unknown' }
  }
}

export function currentProcessIdentity(): ProcessIdentity {
  if (context.own) return { ...context.own }
  const observed = probeProcess(process.pid)
  if (observed.state !== 'alive' || !observed.instance) throw new Error(`Cannot determine strong process identity on ${process.platform}`)
  context.own = { pid: process.pid, instance: observed.instance }
  return { ...context.own }
}

export function createExecutionOwner(): ExecutionOwner {
  return { ...currentProcessIdentity(), token: randomUUID(), leaseExpiresAt: Date.now() + 30000 }
}

export function processOwnerState(owner: unknown, probe: ProcessProbe = probeProcess): OwnerState {
  if (!record(owner) || !Number.isSafeInteger(owner.pid) || Number(owner.pid) <= 0 || typeof owner.instance !== 'string' || !owner.instance) return 'unknown'
  const validIdentity = (instance: string) => process.platform === 'win32'
    ? /^[1-9]\d{16,18}$/.test(instance)
    : process.platform === 'linux' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d+$/i.test(instance)
  if (!validIdentity(owner.instance)) return 'unknown'
  let observed: ProcessObservation
  try { observed = probe(Number(owner.pid)) } catch { return 'unknown' }
  if (observed.state === 'dead') return 'dead'
  if (observed.state !== 'alive' || !observed.instance || !validIdentity(observed.instance)) return 'unknown'
  return observed.instance === owner.instance ? 'live' : 'dead'
}

function removeEmptyDirectory(dir: string) {
  try { fs.rmdirSync(dir) }
  catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(errorCode(error) ?? '')) throw error }
}

/** Never remove a directory recursively: a successor may already own it. */
function releaseOwner(dir: string, ownerFile: string) {
  try { fs.unlinkSync(path.join(dir, ownerFile)) }
  catch (error) { if (errorCode(error) !== 'ENOENT') throw error }
  removeEmptyDirectory(dir)
}

export interface FileLockOptions {
  kind?: LockKind
  timeoutMs?: number
  token?: TransactionToken
  probe?: ProcessProbe
}

/** Nonempty-directory publication and token-specific removal avoid stale-lock ABA. */
export function withFileLock<T>(lockPath: string, action: SynchronousAction<T>, options: FileLockOptions = {}): T {
  assertSynchronousAction(action)
  const kind = options.kind ?? 'storage'
  const top = context.stack.at(-1)?.token
  if (top?.kind === 'event' && kind === 'storage') throw new Error('Lock order violation: event -> storage')
  fs.mkdirSync(path.dirname(path.resolve(lockPath)), { recursive: true })
  const absolute = path.join(fs.realpathSync(path.dirname(path.resolve(lockPath))), path.basename(lockPath))
  const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute
  const held = context.stack.find((frame) => frame.token.path === key)
  if (held) {
    if (options.token !== held.token || top !== held.token) throw new Error(`Explicit transaction token required for reentry: ${absolute}`)
    const result = action(held.token)
    if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('Storage transactions must be synchronous')
    return result
  }
  if (options.token) throw new Error('Transaction token is not active for this lock')
  if (top && top.kind === kind) throw new Error(`Nested ${kind} locks are not allowed`)

  const identity = currentProcessIdentity()
  const nonce = randomUUID()
  const candidate = `${absolute}.${process.pid}.${nonce}.candidate`
  const ownerFile = `owner-${nonce}.json`
  const token: TransactionToken = Object.freeze({ path: key, kind, nonce })
  let acquired = false
  let entered = false
  fs.mkdirSync(candidate, { mode: 0o700 })
  try {
    fs.writeFileSync(path.join(candidate, ownerFile), JSON.stringify({ ...identity, nonce }), { flag: 'wx', mode: 0o600 })
    const started = performance.now()
    let lastOwnerState: OwnerState = 'unknown'
    for (;;) {
      if (performance.now() - started >= (options.timeoutMs ?? 1000)) {
        throw new Error(`Timed out acquiring ${kind} lock: ${absolute} (owner ${lastOwnerState}; inspect ownership before manual cleanup)`)
      }
      // Windows rename may replace a regular file with a directory. Legacy
      // file locks are a different protocol and must never be overwritten.
      try {
        const target = fs.lstatSync(absolute)
        if (!target.isDirectory() || target.isSymbolicLink()) {
          Atomics.wait(pause, 0, 0, 5)
          continue
        }
      } catch (error) { if (errorCode(error) !== 'ENOENT') throw error }
      try {
        fs.renameSync(candidate, absolute)
        acquired = true
        break
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES', 'EISDIR', 'ENOTDIR'].includes(errorCode(error) ?? '')) throw error
        try {
          const names = fs.readdirSync(absolute)
          if (names.length === 0) {
            // No valid holder can publish an empty directory.
            removeEmptyDirectory(absolute)
            continue
          }
          if (names.length === 1 && /^owner-[0-9a-f-]{36}\.json$/.test(names[0])) {
            const ownerPath = path.join(absolute, names[0])
            let owner: unknown
            try { owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8')) } catch {}
            if (record(owner) && owner.nonce === names[0].slice(6, -5)) {
              // Avoid an OS subprocess during ordinary short fsync contention.
              if (owner.pid === process.pid || performance.now() - started >= 50 || options.probe) {
                lastOwnerState = processOwnerState(owner, options.probe)
                if (lastOwnerState === 'dead') {
                  releaseOwner(absolute, names[0])
                  continue
                }
              }
            }
          }
        } catch (probeError) {
          if (errorCode(probeError) === 'ENOENT') continue
          // Legacy file locks and unrecognizable metadata fail closed.
          if (!['ENOTDIR', 'EISDIR', 'EACCES', 'EPERM', 'ENOTEMPTY', 'EEXIST'].includes(errorCode(probeError) ?? '')) throw probeError
        }
        Atomics.wait(pause, 0, 0, 5)
      }
    }
    context.stack.push({ token })
    entered = true
    const result = action(token)
    if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('Storage transactions must be synchronous')
    return result
  } finally {
    if (entered) context.stack.pop()
    if (acquired) releaseOwner(absolute, ownerFile)
    else releaseOwner(candidate, ownerFile)
  }
}

export function withStorageTransaction<T>(userDataDir: string, action: SynchronousAction<T>, token?: TransactionToken): T {
  return withFileLock<T>(path.join(userDataDir, '.storage.lock'), action, { kind: 'storage', token })
}

/** Missing data is an initial state; corrupt JSON and access errors are not. */
export function readJsonFile<T>(file: string, fallback: T): T {
  let text: string
  try { text = fs.readFileSync(file, 'utf8') }
  catch (error) { if (errorCode(error) === 'ENOENT') return fallback; throw error }
  return JSON.parse(text) as T
}

/** The destination remains valid when write, fsync or rename fails. */
export function atomicWriteJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    const fd = fs.openSync(temporary, 'r+')
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    fs.renameSync(temporary, file)
  } finally {
    try { fs.unlinkSync(temporary) } catch (error) { if (errorCode(error) !== 'ENOENT') throw error }
  }
}
