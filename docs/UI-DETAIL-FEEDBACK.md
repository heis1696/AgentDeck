# Issue Detail And Settings Feedback

## User Feedback

This follow-up addresses the five reported problems without replacing the
established visual identity: overlapping sticky user bubbles, obscured detail
background, an oversized and ungrouped worker list, weak detail-view hierarchy
and disabled Git access, and outdated settings controls with oversized hit areas.

## Confirmed Causes

- `polish/detail.css` explicitly makes user bubbles sticky at `top: 6px` with
  `z-index: 5`. Remove this effect; bubbles must scroll with their turn.
- The shared canvas is present on `.detail-page`, but `.detail` and
  `.detail-main` paint opaque shell backgrounds over it. Restore transparent
  reading surfaces while preserving readable bubbles, menus and controls.
- `TaskDetail.tsx` displays the first three finished workers in the main list
  when no workers are active. All terminal workers must instead be categorized
  as ended, including the last workers that finish.
- `TaskDetail.tsx` defaults to activity and disables Git when `gitDiff` and
  `gitStat` are absent. Missing execution snapshots do not justify disabling
  access to the Git view.
- A real Chromium probe at 1280x800 measured the theme button as 36px high
  inside a roughly 61px `label`. Clicking 8px above the visible button opened
  the menu. Correct label/trigger semantics as well as control appearance.

## Decisions

- Execution records become the default primary view. Keep Git as a primary,
  always-enabled view. Activity and result remain available through compact
  secondary controls; do not delete historical data or existing capabilities.
- The worker list opens in the existing FloatWindow above the main content.
  Keep only a compact icon/summary trigger in existing chrome, with no permanent
  worker list consuming content height. Opening/closing it must not move or
  resize the reading viewport. Reuse Escape, focus return, collapse and drag.
- Group workers by the SAME conversation turns shown in execution records.
  Use `buildTurns`/`Turn.firstSeq` and authoritative event timestamps, together
  with child creation times. `workerIndex` is a global display index, not a
  round number; `roundsUsed` is the leader's aggregate, not a child-round key.
  Do not guess rounds from child ordering or parse localized status prose.
  Unavailable/ambiguous historical boundaries need an explicitly unclassified
  group so records remain reachable. Do not change backend execution metadata
  or scheduling in this feedback batch.
- Each round distinguishes active/queued/parked work from ended work; done,
  failed and cancelled all belong to ended. Status transitions update counts
  and categories without losing records or changing the user's open task.
- Git must distinguish executing/no collected snapshot, no recorded changes,
  and available snapshots. A current workspace diff is different from an
  execution-end snapshot; never label absence of a snapshot as proof of a
  clean repository. Preserve copy and file inspection capabilities.
- Settings controls use existing semantic tokens and icon conventions, with
  consistent input/button/select geometry, focus, hover, error and pending
  states. The visible button boundary must match its mouse hit area. Ordinary
  labels may focus inputs or toggle checkboxes, but blank form-label space
  must not activate a custom dropdown button.

## Ownership

### A: Detail Interaction

Quick implementation teammate owns `src/renderer/src/components/TaskDetail.tsx`,
`src/renderer/src/components/task/GitSummary.tsx`, a focused new worker-window
component and grouping helper under `src/renderer/src/components/task/`, and
necessary focused smoke/fixture files. Existing UI smoke changes are allowed
only where they assert the deliberately replaced tab/worker behavior. Preserve
public smoke-consumed exports and use the existing task service and UI center.
Do not edit CSS, main/shared execution code, settings components, package
scripts or the shared visual harness.

Deliver default execution records, compact secondary activity/result access,
always-clickable Git with honest empty states, and the grouped floating worker
list. Keep stable hooks for lead styling: `.worker-overview-trigger`,
`.worker-overview`, `.worker-round`, `.worker-round-head`, `.worker-round-active`,
`.worker-round-ended`, `.worker-overview-row`. Use FloatWindow with a sensible
constrained width; pass existing task/turn/event state instead of fetching
every worker's event log merely to group it.

Acceptance: two or more turns with mixed states, no event history, live
completion including the final worker, all-ended groups, no duplicate/missing
workers, click-through to the selected worker's existing detail/Dock, task
switch isolation, default log view, and Git access with and without snapshots.

### B: Settings Controls

General teammate owns `src/renderer/src/components/SettingsView.tsx`,
`src/renderer/src/components/UpdatePanel.tsx`,
`src/renderer/src/components/RuntimeView.tsx`, and settings-scoped rules in
`src/renderer/src/polish/operations.css`. Add a dedicated control behavior and
browser hit-testing smoke/fixture. No global button override, no changes to
main-process validation, and no edits to `scripts/smoke-ui-management.mjs`.
Prefer fixing SettingsView field/label markup over changing shared Menu
behavior; report any shared-component requirement before extending ownership.

Cover general, runtime, updates, tuning and storage. Preserve all recently
fixed save queues, draft protection, error handling and write guards. Keep
input labels accessible using explicit associations when replacing wrapper
labels around dropdown buttons. Buttons should use relevant existing icons
and consistent height; numeric fields, sliders and toggles should remain
appropriate to their value types.

Acceptance: actual Chromium coordinate clicks immediately outside the visible
dropdown/button must not trigger it; visible center/edge clicks do. Include
keyboard operation and disabled controls, both themes and 1440x900/980x560.
Preserve save/detection ordering and settings behavior with focused smoke.

### Lead

Lead owns `polish/detail.css`, `polish/page-shell.css` if required, final worker
and secondary-view styling, the shared browser harness, package test registration,
documentation, integration and verification. Sticky removal and transparent
detail surfaces have already been applied before delegation.

## Validation And Working Tree

- Required: typecheck, build, stage6, UI smoke and new focused behavior checks.
- Browser checks must exercise long multi-turn scrolling, real hit targets,
  background visibility through reading surfaces, worker open/close geometry,
  live worker completion and all Settings sections. Use isolated sample data.
- Refresh dependency graphs if new renderer modules are added. Do not start
  real agents or change production settings while testing.
- Preserve the intake WIP: `src/main/ipc-validation.ts`,
  `scripts/smoke-ipc-validation.mjs`, `scripts/smoke-ui-management.mjs`.
  These are independent update-feed validation changes and are not owned here.
- Additional concurrent WIP appeared during inspection:
  `src/main/hot/updater.ts`, `scripts/smoke-hot-updater.mjs`, and
  `scripts/smoke-hot-transaction.mjs`. Preserve these as well.
- Initial browser tooling under `out/visual-tools` was missing and has been
  restored locally without changing application dependencies. An isolated
  fixture preview is running at `http://127.0.0.1:4175` for integration work.

## Initial Fix Verification

- Removed sticky user-bubble styling and uncovered the shared detail canvas.
- Build, stage6 (including typecheck), and whitespace validation passed.
- Rebuilt real-browser fixture: 239 checks passed across 28 main page/theme/
  viewport cases, with no renderer exceptions. User-bubble position changes by
  the complete 180px scroll delta; detail/content backgrounds are transparent.
- Screenshots: local ignored `gui-test-screenshots/detail-feedback-base/`.
  Worker/navigation and settings changes are still pending the parallel work.

## Integration Progress

- The settings implementation is accepted after a root-checkout rerun of its
  browser suite: 356 checks, 20 section/theme/viewport combinations, no renderer
  errors. Label activation no longer enlarges custom dropdown hit areas.
- The detail teammate stopped after an upstream HTTP 502. Partial components
  were recovered from the worker checkout; the lead completed the implementation
  and tests. The recovered source is also recorded in worker commit `e23f484`.
- Worker lists now live only in FloatWindow, with a trigger in existing metadata
  chrome. Groups match execution-record turns, newest first, with active/waiting
  rows and per-round ended disclosures. Every terminal worker is categorized as
  ended, including the last completion. Selecting output closes the overview.
- Timestamp boundaries are exact firstSeq matches. Missing intervals, ambiguous
  equal timestamps, earlier records and backwards clocks remain explicitly
  unclassified. Worker ids are unique; workerIndex is displayed without the
  previous extra increment and is never used as a turn number.
- Execution records and Git are primary text tabs. Activity and result remain
  accessible as secondary icon tabs with labels, tooltips, focus and shortcuts.
  Git availability no longer depends on a stored snapshot; absent, empty and
  available snapshots have distinct states. Old focus assertions were updated
  to test continued Git access and focus across task changes.
- The combined main browser walk passes 283 checks, including live completion,
  turn grouping, worker output navigation, absent Git snapshots, normal bubble
  scrolling and unchanged reading geometry when the worker window opens.
  Screenshots: local ignored `gui-test-screenshots/detail-feedback-integrated/`.
- `scripts/smoke-worker-rounds.mjs` covers grouping, timestamp gaps/ambiguity,
  duplicate ids, final completion and Git snapshot states. It is registered in
  `smoke:ui`; the Settings coordinate suite is registered in `smoke:ui:browser`.
- Further concurrent persistence-audit changes in main/store, runner, issues and
  their tests are outside this UI task. UpdatePanel also has a concurrent logic
  patch: the lead applied only progress markup and keeps that logic intact.
- Combined typecheck, build, stage6 and the complete UI command pass. The draft
  and workflow jsdom harnesses now provide ResizeObserver because the default
  execution view mounts its minimap immediately. Real browser geometry remains
  verified separately, including the 180px bubble-scroll assertion.
- Dependency graphs are refreshed to 183 modules. The remaining step is an
  independent read-only review of these completed UI changes and their tests.
