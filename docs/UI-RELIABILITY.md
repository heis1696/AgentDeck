# UI Reliability Follow-up

Baseline: 69e00d5. The user approved implementing all five findings. Preserve
the accepted visual design, execution semantics and IPC contracts. No deployment.

## Verified Failures

- A failed agents.list leaves an editable empty array. In the isolated fixture,
  saving a new agent submitted one entry while four agents actually existed.
  Both Agent and preset APIs persist complete arrays.
- A task A follow-up draft and history remain visible after switching to B.
- Palette arrow navigation selects commands below the visible list.
- Invalid tuning values silently revert on blur; goal/meeting requirements
  need field-adjacent feedback.
- Event merging rebuilds a Map and sorts every history for each event. Baseline
  median for 500 appends over 10,000 events: merge 274.5ms, merge plus turns
  379.5ms. These figures exclude React, Markdown and IPC.

## Ownership

Source paths in this section are relative to src/renderer/src.

- Lead: ui/Palette.tsx, hooks/eventMerge.ts, scripts/smoke-turn-model.mjs,
  new scripts/smoke-ui-palette.mjs and scripts/bench-event-merge.mjs. Own package
  test registration, final integration, visual verification and graph refresh.
  Also owns hooks/useInteractionLayer.ts: the focus trap must exclude native
  buttons carrying tabindex=-1, matching the Palette active-descendant model.
- DeepSeek: components/TaskDetail.tsx, hooks/usePromptHistory.ts; if necessary
  App.tsx, hooks/useTaskEvents.ts, hooks/useIssueDetails.ts and a focused task
  draft helper. Add separate scripts/smoke-ui-task-state.mjs and its own fixture.
  No CSS, Palette, eventMerge, package metadata or existing test edits.
- Quick implementation agent: components/AgentsView.tsx, AutomationView.tsx,
  UsageView.tsx, BoardView.tsx, SettingsView.tsx, WorkspaceView.tsx; api.ts for
  settings read/error/retry only; polish/foundation.css and relevant page styles.
  Add separate loading and validation tests/fixtures. No TaskDetail, App,
  Palette, eventMerge, package metadata or existing test edits.

Before editing, confirm the checkout contains src/ and package.json and HEAD
is 69e00d5. Do not use installation directories or asar-out. Preserve parallel
changes and the prior 197-check visual baseline.

## Behavioral Contract

- Distinguish initial loading, successful empty data and failure. Unknown counts
  remain absent; errors persist with retry. Refresh failures retain the last
  successful snapshot and clearly identify stale data.
- Gate full-list writes in handlers and UI until the relevant list is loaded.
  Cover create/import/generate/edit/remove flows for agents and presets. A
  rejected or pending read must never permit a partial replacement list.
- Handle out-of-order requests and unmounts. Usage range changes cannot accept
  stale responses. Rejected reads must not escape as unhandled promises.
- Preserve drafts independently for task A/B/A within the current app session.
  Remounting and losing drafts is not sufficient. History remains task-specific.
  Cancel transient title editing when changing tasks; old async work cannot
  update the new task's UI. No new persistent storage of unsent prompts required.
- Keep invalid numeric drafts editable, with nearby error text, aria-invalid
  and aria-describedby. Do not commit blank, fractional or out-of-range values.
  Valid corrections clear errors and commit once. Goal/meeting field feedback
  must preserve current create/start behavior.
- Palette arrows follow visual order, keep the selected item visible within
  the list, and leave focus in the input. Filtering, empty results, changed
  commands and IME composition remain safe.
- Optimize event merge without changing latest-value-per-seq semantics,
  ordering, input immutability or replay behavior. Use differential correctness
  tests and measured comparisons, not machine-specific timing assertions.
- Reuse current tokens, EmptyState, icons and feedback patterns. No dependency
  or unrelated visual redesign. Shared helpers require real reuse.

## Verification

Required: typecheck, build, smoke:stage6, smoke:ui and each new focused smoke.
Re-run the existing 28-page/197-check browser suite, add relevant failure-state
coverage and refresh the isolated preview. No real agent execution or production
configuration may be used in testing. Report actual outcomes and limitations.

## Lead Work Complete

Palette now reveals the active option by scrolling only its list, uses a
combobox/listbox relationship, follows grouped visual order, accepts keyword-only
matches and clamps selection when results shrink. Focus remains in the input;
the shared focus trap respects tabindex=-1. The new Palette DOM smoke passes,
as do typecheck and all prior UI smokes.

Event merging uses ordered append, single-event insertion/replacement and linear
ordered-batch merge paths, retaining the original Map/sort fallback for unordered
or duplicate input. 307 deterministic differential cases preserve old semantics
and input immutability; all turn-model regression cases pass. Same-process warmed
median for 500 appends over 10,000 events: reference 246.29ms, optimized 8.47ms.
At 1,000 events: reference 15.19ms, optimized 0.72ms. These are merge-only figures,
not an end-to-end rendering speedup. Reproduce with npm run bench:ui:events.

## Integrated Result

- Task drafts, history and busy state are isolated per task. A/B/A restores each
  draft during the current renderer session. Editing and floating panels are
  transient. A generation guard discards callbacks from retired sessions,
  including an old A callback after switching A/B/A. Event and Issue snapshots
  clear at the identity boundary; older asynchronous responses cannot cross it.
- Agent and preset reads expose loading/error/empty states and retry. Writes
  use the last successful snapshot, are gated in handlers and controls, and
  exclude duplicate pending submissions. Preset removal detaches only matching
  references while retaining all agents and unrelated preset bindings.
- Usage range responses are ordered; refresh failure retains and labels stale
  data. A failed initial read no longer renders zero totals. Settings retry is
  available, and broadcasts/writes invalidate older pending settings reads.
- Tuning inputs keep invalid drafts with linked field errors; valid correction
  saves once. Goal/meeting validation sits beside the relevant fields. Error
  text and borders win over legacy page styles and use the semantic error token.
- Palette navigation, keyword-only matching and ordered event-merge fast paths
  are integrated as described above. The accepted visual layout is preserved.

`npm run smoke:ui` now includes the Palette, task-state and reliability suites.
The reliability suite renders real Agent, Usage, Settings and Workspace views
with rejected/deferred reads and saves, rather than checking only helper output.
The task-state suite includes retired setter and A/B/A generation regressions.

Passed: typecheck, production build, smoke:stage6, smoke:ui, Electron overlap
smoke and git diff --check (including new files). Event merge passed 307
deterministic differential cases. Playwright verified 28 page/theme/size cases
and 206 assertions with no renderer exceptions; additional screenshots cover
Agent read failure, tuning validation, goal requirements and Palette scrolling.
Artifacts remain in gui-test-screenshots/visual-repair/; the isolated preview at
http://127.0.0.1:4173 serves the updated renderer. The dependency graph contains
178 modules. No installed application or production data was modified.

Unsent drafts are memory-only and do not survive renderer reload. History keeps
its existing task-specific localStorage keys. Draft slots live for the renderer
session; deleting a task does not currently reclaim its slot. This delivery is
in the worktree and has not been committed or pushed beyond baseline 69e00d5.
