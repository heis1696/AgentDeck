# Persistence Audit and Proposed Repair

Status: implementation, focused regression checks, and final read-only review
are complete. Review findings were resolved. Main-worktree changes remain
uncommitted; no production data migration, deployment or task restart was run.
The separate delayed-flush error handling fix is implemented and covered by
`scripts/smoke-event-log.mjs`.

## Confirmed Defects

| Priority | Trigger | Result | Code |
| --- | --- | --- | --- |
| P1 | Two TaskStore instances load the same index; one creates a task and the other updates an older task | The newly created task disappears from the index | `src/main/store.ts`, `saveIndex` |
| P1 | One instance deletes a task; another updates its cached copy | The deleted task reappears in the index without its task directory | `src/main/store.ts`, `delete` / `update` |
| P1 | One IssueStore adds a comment; another updates metadata from an older snapshot | The comment disappears | `src/main/issue-store.ts`, `save` |
| P1 | Sidecar reconnect claims every persisted running task without verifying its execution owner | An active task can be changed back to queued | `src/main/sidecar.ts`, `reconnect`; `src/main/sidecar-server.ts`, `claimOrphanTasks` |

The first three cases were reproduced against the combined working-tree build
using temporary data only. Results: task count 1 instead of 2; deleted task
resurrected; comment count 0 instead of 1. The takeover defect is confirmed by
the call path; its repair needs an execution-owner regression test.

Production has both writers: `src/main/index.ts` constructs TaskStore and
TaskRunner for desktop IPC, while `src/main/sidecar-runtime.ts` constructs
another pair and `src/main/sidecar-server.ts` exposes mutating task RPCs.
IssueStore is duplicated as well. Existing sidecar smoke exercises one writer
at a time and does not establish safety with both writers alive.

## Proposed Scope

Preserve the current JSON format and desktop/sidecar API surface. Introduce
serialized storage transactions and explicit execution ownership. A file lock
alone cannot prevent stale lifecycle callbacks or mistaken orphan claims.

1. Share the proven EventLog process-lock semantics: process identity, bounded
   waiting, dead-owner recovery, and distinct temporary files. Make every task
   mutation read the latest index inside the lock with `recoverRunning:false`.
2. Apply operations to the latest state, not entire cached records. Perform
   dedupe lookup and creation in the same transaction. Missing records cannot
   be recreated by update, event append, truncate, or delayed flush.
3. Make lifecycle mutations conditional on the expected status, run ID, and
   execution owner. Only a successful queued-to-running claim may launch a
   backend. Metadata updates preserve unrelated fields.
4. Record execution ownership with a recoverable process identity and lease.
   Reconnect preserves live and unknown owners; takeover requires evidence that
   the original process identity is dead and a successful conditional claim.
   Lease expiry alone is never proof of death. Route orphan index changes
   through TaskStore.
5. Apply the same transaction discipline to IssueStore. Preserve human comments,
   workflow overrides, metadata, and other Runs during projection updates.
   Explicit retention deletes cannot be undone by stale task projections.
6. Keep task snapshots derived from the authoritative index. Preserve pending
   writes on failure; write, sync, and atomically replace durable index files.
   Retry interrupted projections idempotently from committed tasks.

This crosses storage, scheduling, recovery, and retention boundaries. It should
be reviewed and delivered as a separate repair stage, rather than hidden inside
the update-source validation fix. No production data migration or running-task
restart should be performed automatically by the repair workflow.

## Implementation Contract

- All TaskStore and IssueStore mutations for one data directory share one
  storage transaction lock outside task directories. Inside it, read current
  durable JSON and apply the operation to that state; cached whole records are
  never the write source. Transaction callbacks are synchronous.
- Lock order is storage transaction, then per-file EventLog lock. EventLog
  operations must not acquire the storage transaction lock in reverse order.
  Projection reads committed Task data while holding the storage lock.
- Lock and execution identities include PID and OS process start identity.
  A missing or unreadable identity stays unknown. A reused PID is distinguished
  from its former process. Lock waits are bounded; age is not permission to
  remove a live or unknown owner's lock.
- Publish locks as nonempty directories with unique owner filenames. Recovery
  and release remove only the observed ownership token, then use nonrecursive
  rmdir; an old reaper must never remove a successor's nonempty lock. Nested
  storage operations require an explicit active transaction token, and reverse
  EventLog-to-storage acquisition fails immediately.
- Shared helpers live in `src/main/persistence.ts`: `withStorageTransaction`
  uses `<userDataDir>/.storage.lock`; `readJsonFile` treats only ENOENT as an
  initial state; `atomicWriteJson` uses unique temporary files and fsync before
  replacement. Public store methods acquire the transaction; private locked
  operations use current state without reacquiring it. Only explicit nested
  composition passes the active `TransactionToken`.
- A lifecycle write checks expected status, run ID and execution owner inside
  the transaction. A backend starts only after its conditional claim commits.
  Startup reconciliation and sidecar recovery use the same ownership checks.
- Each provider turn has an immutable `BackendTurnStamp`. Built-in adapters
  return that stamp on every event, terminal, heartbeat, permission and session
  callback. Unknown or closed turn IDs are discarded. An adapter that does not
  declare `turnScoped` may run one isolated turn; every later turn closes the
  connection and resumes from its session ID, so timing is never used as proof
  that an unmarked callback belongs to the newest Run.
- Asynchronous Git integration first reserves the parent and all reported child
  snapshots in one TaskStore transaction. Optional `gitOperation` metadata binds
  a unique operation token to its process identity. A child is matched by status,
  run ID, owner, attempt, phase, start stamp and work version, including legacy
  records. Retry, execution claims and deletion are refused until Git settles;
  cancellation may mark a running parent terminal but cannot release the reserve.
  Filesystem side effects run outside the storage lock, with the reservation
  retained until `finally`; failed release writes are retried automatically.
  Startup and manual cleanup use the inverse reservation before deleting a
  worktree or branch. Terminal children remain protected while any ancestor is
  active; cleanup and integration therefore cannot both pass their checks.
  A reservation left by a host whose exact PID/start identity is proven dead is
  released conditionally by token during startup. Live owners, unreadable or
  malformed identities, and lease age remain fail-closed; PID reuse cannot
  impersonate the former operation owner.
- The TaskStore contract is `claimRun(id, expected, runId, owner, patch?)`,
  `updateIf(id, expected, patch)`, `matches(id, expected)`, and
  `appendEvent(id, event, expected?)`. Expected fields include status, run ID
  and `executionOwner`; owner comparison uses PID, OS instance and runner token,
  never lease time. `createExecutionOwner()` creates an owner reference.
  `recoverDeadRuns('queued' | 'failed', ids?)` probes death outside the lock,
  then conditionally commits the exact observed run once. Ordinary reads never
  recover or rewrite running tasks.
- Task terminal snapshots are retained in optional `pendingIssueProjections`
  until IssueStore commits their run/report projection and acknowledges them.
  A later run cannot erase an unprojected earlier terminal result. Projection
  retries read committed data and deletion tombstones, not cached whole records.
  Legacy records without a run ID use the same attempt-based identity as the
  execution projection, so separate unprojected attempts remain separate Runs.
- Derived snapshot writes and task-directory deletions are recorded in optional
  `pendingTaskSnapshots` / `pendingTaskDeletes` in the same index commit as the
  mutation. A new TaskStore retries these records; acknowledgement follows the
  successful file operation. Deletion validation commits before runner cleanup,
  so a rejected retention sweep cannot stop a replacement execution.
  Event-only appends retain batching: startup detects differences against the
  authoritative JSONL and schedules index/snapshot repair, including when the
  writer exited before its flush timer. Explicit flush failure also retains an
  automatic retry; an acknowledgement failure cannot discard durable work.
- Keep the existing JSON envelopes and public methods. Add only backward
  compatible optional metadata needed for ownership and deletion protection.
  Explicit deletion must survive delayed writes and projection replay.
- Write replacement files under unique names, fsync before rename, and keep
  failed operations or derived snapshots eligible for retry. Task index data
  is authoritative; Issue projection failures must not erase committed tasks.
- Verification uses temporary data and fake backends, including real child
  processes for contention and crash recovery. No test may mutate production
  data, take over a production run or restart the running application.

## Acceptance

### Lock Upgrade Boundary

The directory lock protocol must not run concurrently with an old binary that
still publishes single-file locks. This is an offline upgrade boundary, not a
live migration: let running tasks finish, then stop old desktop and sidecar
writers normally before loading the new build. The repair workflow does not
stop those processes or clear production locks automatically.

An old regular-file `events.jsonl.lock` is retained and reported as a lock
timeout. With all old writers stopped, an operator can read its JSON `pid` and
`instance`, compare that identity with the OS process start identity, and remove
that one regular file only after confirming the former holder is dead. Unknown
or corrupt identities require explicit operator investigation; lock age is
never evidence of death. Do not use recursive lock deletion or mix protocols.

Windows is the packaged target. Strong identity probing also exists for Linux;
other platforms reject ownership-sensitive writes until a strong identity
provider is implemented. Promise-returning transaction callbacks are rejected
by TypeScript, and native async callbacks are rejected before invocation. The
synchronous API is not a sandbox for untyped callbacks that schedule arbitrary
background work.

### Regression Gates

- Two live instances and two real processes create/update independent tasks
  without losing records or unrelated fields.
- Concurrent creation with one dedupe key produces one task and one projection.
- A stale run cannot finish a newer run; only one process launches a queued task.
- Delete versus update/append/flush never revives an index entry or directory.
- Write/sync/rename failures leave valid prior data and retain retry state.
- Dead writers release recoverable locks; PID reuse cannot impersonate an owner.
- Reconnect after the old 30-second timeout preserves active execution; a dead
  execution is claimed once.
- Comments and human metadata survive concurrent projections and restart.
- Failed Issue projection is repaired once from committed Task data; explicit
  deletion remains deleted.
- Run `npm run typecheck`, `npm run build`, `npm run smoke:stage6`, execution,
  lifecycle, sidecar, retention, and new concurrency tests. Refresh the dependency
  graph if shared persistence modules change the source structure.

## Verification Record (2026-09-21)

The integrated working tree passed `typecheck`, `build`, `smoke:stage6`,
`smoke`, `smoke:execution-services`, `smoke:lifecycle`, `smoke:sidecar`,
`smoke:board-retention`, and `smoke:worktrees`. The standard stage-6 gate now
also runs the lock, persistence, run-ownership, ownership-repair, and Issue
persistence suites plus turn-identity and real-Git ownership tests, including
real Node child processes and the 30-second live-owner regression.

Additional focused checks passed: `smoke:continue`, `smoke:flow`,
`smoke:queue-recovery`, `smoke:delegate`, `smoke:delegate-reject`,
`smoke:permission`, `smoke:goal-guards`, `smoke:retry`, `smoke:task-service`,
`smoke:ipc-validation`, and `smoke:turn-lifecycle`. `smoke:resume` additionally
passed against an installed Zcode adapter using a separate prompt-only test
session, which the test closed afterward. The zcode result confirms that
connection isolation retains conversation context through `sessionId` resume.
Production-composition fixtures also verify per-turn DSH ACP stamps, OpenCode
Server detach/resume without DELETE, one transferred local-server lease, dead
Git-operation recovery with PID-reuse detection, and fail-closed worktree
pruning when no durable cleanup claim is supplied.

`docs/graph/deps.json` and `deps.mmd` were regenerated with the equivalent
dependency-cruiser CLI using isolated tooling (186 modules, including the shared
persistence module and new runtime import edges). This avoids reinstalling
dependencies used by the running application. `git diff --check` passed.

No complete `smoke:all` result is claimed: the earlier full run stopped at a
real Claude HTTP 403, and the full suite was not rerun for this repair. The
reported incomplete Electron installation also leaves the hot-transaction
environment check outside this verification result. Final review remains
read-only; no main-worktree commit or deployment has been made.

## Other Recorded Gap

`skills.searchOnline`, `skills.installOnline`, and `skills.openExternal` exist in
the public contract and preload but have no matching main-process handlers.
No current renderer caller was found. Implementing an online catalog or removing
public APIs needs a separate scope decision; neither is part of this repair.
