# Business Brain Sidecar

The Electron main process owns the window, notifications, permission UI, and
the sidecar lifecycle. A standalone Node process exposes a loopback-only HTTP
RPC surface for durable task, issue, goal, run, and event projections.

## Lifecycle

`SidecarManager` persists `userData/sidecar-state.json` with protocol version,
port, instance token, instance id, and pid. Startup first probes that port and
token, then starts the bundled `sidecar-server.js` when adoption fails. The
manager retries the handshake after a child crash and keeps queued RPC calls
until `state.sync` has completed. Shutdown sends `/shutdown` before terminating
the child as a last resort.

## Contract

All requests are loopback-only. `/health` is a liveness probe; `/handshake`,
`/rpc`, and `/shutdown` require the `x-agentdeck-token` bearer. RPC envelopes
carry `protocol: "agentdeck.business-brain"` and `version: 1` (omitting these
fields remains accepted for compatibility, while mismatches fail closed).

Implemented methods are `health`, `state.sync`, `events.read`/
`events.replay`, `events.append`, and `runs.claim`/`runs.takeover`. Event
appends use a monotonic durable sequence and fsync before acknowledging. The
takeover operation records running orphan run ids in
`userData/sidecar-orphans.json`; Task/Run/Goal ownership remains unchanged.

Renderer IPC exposes only status and sync operations. The instance token is
never sent to the renderer. Existing task IPC, `TaskRunner`, `PermissionBroker`,
and CLI backends remain the compatibility execution path.
