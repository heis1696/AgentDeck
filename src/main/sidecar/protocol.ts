/** Wire contract for local Electron <-> business sidecar communication. */
export { SIDECAR_PROTOCOL_VERSION } from '../sidecar'
export type {
  SidecarState,
  SidecarSnapshot,
  SidecarSyncState,
  SidecarStatus,
  SidecarManagerOptions
} from '../sidecar'
import type { SidecarStatus } from '../sidecar'

export interface SidecarRpcRequest {
  protocol?: string
  version?: number
  id: string
  method: string
  params?: unknown
}

export interface SidecarRpcResponse<T = unknown> {
  protocol?: string
  version?: number
  ok?: boolean
  id?: string
  result?: T
  error?: string
}

/** Stable protocol name used by the versioned RPC envelope. */
export const SIDECAR_PROTOCOL = 'agentdeck.business-brain' as const
export type SidecarMethod = string
export interface SidecarRequest<T = unknown> {
  protocol: typeof SIDECAR_PROTOCOL
  version: number
  id: string
  method: SidecarMethod
  params?: T
}
export interface SidecarResponse<T = unknown> {
  protocol: typeof SIDECAR_PROTOCOL
  version: number
  id: string
  ok: boolean
  result?: T
  error?: { code: string; message: string; details?: unknown }
}
export interface SidecarHealth {
  ok: true
  protocol: typeof SIDECAR_PROTOCOL
  version: number
  status: SidecarStatus
  pid: number
  port: number
  instanceToken?: string
  startedAt: number
  uptimeMs: number
}
export interface SidecarStateFile {
  schemaVersion: 1
  protocol: typeof SIDECAR_PROTOCOL
  port: number
  instanceToken: string
  pid?: number
  startedAt?: number
}
export interface SidecarStateSnapshot {
  tasks: unknown[]
  issues: unknown[]
  goals?: unknown[]
  generatedAt: number
  sidecar: SidecarHealth
}

export class SidecarRpcProtocolError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message)
    this.name = 'SidecarRpcProtocolError'
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
export function parseSidecarRequest(value: unknown): SidecarRequest {
  const input = object(value)
  if (input.protocol !== SIDECAR_PROTOCOL) throw new SidecarRpcProtocolError('protocol_mismatch', 'Unsupported sidecar protocol', input.protocol)
  if (typeof input.version !== 'number' || !Number.isInteger(input.version)) throw new SidecarRpcProtocolError('invalid_version', 'RPC version must be an integer')
  if (typeof input.id !== 'string' || !input.id) throw new SidecarRpcProtocolError('invalid_id', 'RPC request id is required')
  if (typeof input.method !== 'string' || !input.method) throw new SidecarRpcProtocolError('invalid_method', 'RPC method is required')
  return input as unknown as SidecarRequest
}
export function assertSidecarVersion(version: number) {
  if (version !== 1) throw new SidecarRpcProtocolError('version_mismatch', `Unsupported sidecar protocol version: ${version}`, { expected: 1, received: version })
}
export function makeSidecarRequest<T>(method: SidecarMethod, params?: T, id = `rpc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`): SidecarRequest<T> {
  return { protocol: SIDECAR_PROTOCOL, version: 1, id, method, ...(params === undefined ? {} : { params }) }
}
export function makeSidecarResponse<T>(id: string, result: T): SidecarResponse<T> {
  return { protocol: SIDECAR_PROTOCOL, version: 1, id, ok: true, result }
}
export function makeSidecarError(id: string, error: { code: string; message: string; details?: unknown }): SidecarResponse {
  return { protocol: SIDECAR_PROTOCOL, version: 1, id, ok: false, error }
}

export interface SidecarHandshakeRequest {
  protocolVersion: number
  instanceToken: string
}

export interface SidecarHandshakeResponse {
  ok: boolean
  protocolVersion: number
  instanceId: string
  orphanRuns: unknown[]
}
