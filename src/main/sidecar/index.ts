/** Public sidecar surface. Kept in a directory so future RPC methods can be
 * split without changing imports used by the Electron shell or smoke tests. */
export * from '../sidecar'
export * from '../sidecar-server'
export {
  SIDECAR_PROTOCOL,
  assertSidecarVersion,
  makeSidecarError,
  makeSidecarRequest,
  makeSidecarResponse,
  parseSidecarRequest
} from './protocol'
export type { SidecarMethod, SidecarRequest, SidecarResponse, SidecarHealth, SidecarStateFile, SidecarStateSnapshot } from './protocol'
