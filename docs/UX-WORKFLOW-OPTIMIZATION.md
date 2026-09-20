# AgentDeck Workflow Usability Optimization

## Objective

Improve each functional area's information density and interaction flow from
the user's perspective. Keep the visual identity established by
`UI-VISUAL-REPAIR.md`, the shared PageHeader, semantic tokens, and existing
interaction infrastructure. This work is about finding, creating, following,
and managing work with less ambiguity and fewer unnecessary actions.

## Scope And Constraints

- Prefer renderer changes using existing bridge capabilities. Changes to
  orchestration, scheduling policy, IPC contracts, or execution semantics need
  a specific justification and separate review before implementation.
- Preserve current background treatment, theme support, typography, and page
  hierarchy. Do not repeat the earlier visual simplification.
- Prioritize primary content and frequent actions. Keep secondary information
  accessible through existing menus, tabs, and disclosure patterns.
- Distinguish empty, filtered-empty, loading, pending, error, and stale states.
- Opening or inspecting an item and executing a command must be understandable
  as separate user intentions. Audit existing behavior before changing it.
- Preserve all pre-existing working-tree changes. At intake, these include
  main-process execution/retention/git changes, their smoke coverage,
  `components/meeting/MeetingPanel.tsx`, and `hooks/useIssueDetails.ts`.
- Do not delete public exports consumed directly by smoke entry points.
- Use isolated sample data or an isolated Electron user-data directory for GUI
  validation. Do not run real agents, install extensions, or change real user
  settings merely to exercise the interface.

## Area Coverage

| User Journey | Functional Areas | Initial Audit Owner |
| --- | --- | --- |
| Find and create work | Navigation, workspace switcher, command search, Issue home, composer, board, open tabs | Quick implementation teammate |
| Follow work and act on results | Task detail, activity/turn views, worker/file dock, permissions, actions, Git diff, goals, meetings | Read-only review teammate |
| Configure and manage | Agents and API presets, automation, extensions and skills, usage, settings/runtime/updates, assistant settings | General teammate |
| Integrate and verify | Cross-area consistency, priorities, implementation boundaries, acceptance, screenshots, regression checks | Lead |

Each audit must cover every assigned area, even where no change is recommended.
Report the user goal, current friction, reproduction path or code evidence,
proposed behavior, risk, and a concrete acceptance check. Distinguish code-based
findings from interactions actually exercised in the GUI.

## Initial Evidence To Validate

These are candidates, not an approved implementation list:

- BoardView initializes its date filter to today and filters by updated time.
  Check whether earlier unfinished work is discoverable and whether search
  scope and empty-state recovery match user expectations.
- WorkspaceView displays every Agent with backend/model metadata before the
  prompt. Check scan cost and prompt/action reachability with a larger roster
  and at the minimum supported window size.
- App command-search task entries both open and start parked tasks. Check
  whether search labels communicate this consequence and whether inspection
  should have an explicit execution action instead.
- IssuesView currently shows opened tabs and the creation form. Check how a
  user returns to existing work after closing a tab or restarting the app.
- Board header and toolbar counts represent different collections. Check
  that counts and filters consistently describe the records being displayed.

## Delivery Sequence

1. Reviewed: navigation/composer/board and task-following audits are accepted.
   Management findings are useful, but the delivered report omitted Agents,
   Usage, and assistant settings; that audit requires a supplement.
2. Complete: the first implementation batches and product decisions are below.
3. In progress: implement independent renderer changes with explicit file
   ownership, then integrate shared navigation and styling changes.
4. Pending: independent read-only review, focused interaction checks, required
   gates, and visual inspection with representative sample data.

## Implementation Decisions

- Search results open tasks. Starting parked work remains an explicit command
  in its existing board/detail actions. This changes a misleading UI trigger,
  not the task start API or execution policy.
- The board starts with all retained dates. Date filtering still uses last
  update time, clearly named in its control. Search respects user-selected
  filters; it must show their scope and offer a one-action reset to all dates.
- Existing eight-tab retention is preserved for this batch. Recent task access
  and complete search provide recovery after a tab disappears or is closed.
- Meeting approval still starts the action task. Its UI must explicitly name
  this consequence and show assignee/acceptance context before confirmation.
- Permission choices must preserve the exact provider option and decision.
  A rejection must never fall back to an allow option. The lead owns this
  correctness fix and its backend review; do not redesign permission policy.
- No new automation scheduling/history engine, goal budget extension,
  pause/resume semantics, or update availability API is included.

## Batch A: Find And Create Work

Owner: quick implementation teammate.

Owned files: `src/renderer/src/App.tsx`,
`src/renderer/src/components/IssuesView.tsx`,
`src/renderer/src/components/WorkspaceView.tsx`,
`src/renderer/src/components/BoardView.tsx`,
`src/renderer/src/ui/Palette.tsx`,
`src/renderer/src/polish/issue-home.css`, and
`src/renderer/src/polish/board.css`. A focused new Agent picker component and
new workflow smoke/fixture files are allowed. Do not edit global CSS, package
scripts, TaskDetail, the interaction center, or management views.

1. Search the full task catalog before limiting displayed results. Support
   title, task/Issue ID and identifier, prompt, backend, directory, and status.
   Keep query-empty suggestions bounded and keyboard/IME behavior intact.
   Selecting a task only opens it, including parked tasks.
2. Add compact recent root-task rows to Issue home with real status, a clear
   open action, and access to all tasks. Preserve the composer focus workflow
   and opened tabs. Avoid a second large table or pushing the composer below
   a large recent-history block.
3. Replace the unbounded Agent button grid with a compact selected value and
   searchable, height-limited picker. Show name/role/backend, secondary model
   metadata, keyboard selection, empty/error handling, and focus return.
   Exclude Forge Agents from both options and default selection.
4. Apply the board decisions above, make counts describe their scope, remove
   the unrelated total-run count from the outer board header, and distinguish
   no records from no filter matches. Preserve all status columns and moves.
5. Make task creation commands explicit about starting versus parking while
   preserving existing task/goal/meeting creation and Enter/IME semantics.

Acceptance: more than 20 tasks across multiple dates remain searchable;
opening a draft never invokes start; a roster of 20 long-named Agents keeps
the form compact; selecting/clearing filters gives consistent counts and
recoverable empty states; existing draft/catalog and palette tests still pass.
Add a focused behavior smoke for these regressions and report its command.

## Batch B: Configure And Act With Feedback

Owner: general teammate.

Owned files: `src/renderer/src/components/SettingsView.tsx`,
`src/renderer/src/components/RuntimeView.tsx`,
`src/renderer/src/components/UpdatePanel.tsx`,
`src/renderer/src/components/AutomationView.tsx`, and only the corresponding
scoped selectors in `src/renderer/src/polish/operations.css` if needed.
New management smoke/fixture files are allowed. Do not edit App, api.ts,
ExtensionsView, global CSS, package scripts, or backend contracts.

1. Give runtime paths an explicit save action with dirty/pending/error state;
   preserve edits on failure. A detection action must await the needed save.
   All settings mutations must catch and display failure. Keep existing local
   setting patterns and do not create a second global settings store.
2. Runtime health must distinguish loading/error/empty/known snapshot, retain
   a successful snapshot on refresh failure, and offer retry. Unknown counts
   must not look like successfully probed zeroes. Show last successful probe.
3. Update checks must await saving the current feed draft. Enable apply only
   when the current snapshot reports an applicable update, prevent duplicate
   operations, and show a real no-update result after successful checks.
   Preserve existing rollback API; do not invent rollback availability.
4. Automation mutations need pending guards, caught errors, and confirmation
   for deletion. Failed create retains inputs; successful create closes once.
   A new blank form resets its configuration deliberately. Keep execution and
   scheduling semantics unchanged, including the existing availability notice.
5. Supply the missing audit conclusions for AgentsView, UsageView, and
   PetSettingsPage, plus the final prioritized management list. These three
   files are audit-only in this batch; do not trigger real generation.

Acceptance: duplicate clicks do not duplicate mutations; failed saves preserve
drafts and show recovery; failed initial probes do not show an empty healthy
system; check-after-feed-edit uses the new saved address; unavailable updates
cannot produce a false started toast; cancelling deletion does not call IPC.
Add a focused behavior smoke and report its command.

## Lead And Subsequent Work

The lead owns permission routing/state and backend regression checks, safe
follow-up drafts and state guards, complete worker-result access, large-diff
rendering, goal/meeting confirmation and read failure states, and integration.
The extension loading/filter/tab-persistence changes and any justified Agent,
Usage, or assistant changes will be assigned after the management supplement.
The reviewer will check implemented changes before final acceptance.

For independent worktrees, use the current committed implementation baseline.
Do not undo `ac91c39` task/event isolation fixes. Register new test commands and
refresh dependency graphs during lead integration to avoid shared-file edits.

## Integration Review And Follow-up

Batch A and B source was recovered from the shared worker checkout and
integrated into main at `7e54ea5`. Both batches passed stage6, build, existing
UI smoke, and their new behavior smoke on the combined tree. Earlier transient
type errors no longer reproduce. This is integration, not final acceptance.

The lead ran the real browser visual harness against isolated sample data:
28 page/theme/size cases, 206 assertions, zero renderer exceptions. Four
Issue-home content placement checks failed. Screenshots under the local ignored
`gui-test-screenshots/workflow-integration/` show the 980x560 prompt pushed
below the first viewport by six recent-task rows. Both batches require the
following corrections before their review can pass.

### A Follow-up Ownership

Quick implementation teammate owns Batch A files plus
`src/renderer/src/components/AgentsView.tsx` and scoped
`src/renderer/src/polish/team.css` rules for the next management improvement.

1. Keep the composer primary. Move recent tasks into the same scrolling flow
   after the composer or use a compact disclosure that does not reserve six
   rows above it. Remove the false "recently visited" description: the data is
   currently sorted by execution timestamps, not visit time. Avoid multiple
   rows for historical executions of the same Issue.
2. Agent-picker keyboard navigation must keep the active option visible in
   its scroll container, open on the currently selected Agent, and keep the
   popup within the viewport at 980x560 and narrow sizes. Give the search
   control correct combobox semantics. Preserve IME, Escape and focus return.
3. Complete the agreed explicit creation labels and all-dates empty-state
   distinctions. Reduce repeated date labels without hiding active scope.
4. Agents management: add lightweight name/role/backend filtering, distinguish
   no matches from no Agents, confirm Agent deletion, and confirm preset
   deletion with the number of affected Agents. Guard model-list requests and
   catch preset-id creation failures. Keep existing snapshot/write protection.
5. Verify the picker with 20 long-named Agents and browser geometry, not only
   DOM existence. Extend focused behavior smoke for these regression cases.

### B Follow-up Ownership

General teammate retains Batch B files and additionally owns
`src/renderer/src/components/ExtensionsView.tsx` and
`src/renderer/src/components/SkillsView.tsx`. No api.ts or backend edits.

1. An empty `available` snapshot proves only "no available update discovered".
   The updater silently catches individual channel check failures, so remove
   the unsupported "latest version" claim. Treat explicit failed/error
   snapshots as errors. Test error snapshots, not only thrown promises.
2. Feed blur-save and check-save currently bypass each other's pending guards.
   Serialize or coalesce them; preserve edits made while saving, and make a
   check use the exact draft submitted for that check. Invalidate conclusions
   and old update actions when the displayed feed changes. Deferred-promise
   tests must reproduce actual blur followed immediately by check.
3. Preserve runtime-path edits made during an earlier save; the settings
   broadcast must not overwrite a newer draft. Scope probe results to the
   saved paths and guard duplicate clean-path probes. Protect automation form
   dismissal/reopening while a create is pending so a late success cannot
   close a new form or discard an edited draft.
4. Extensions and skills: distinguish loading, first error, successful empty,
   and stale data for Skills/MCP/Hooks/plugins, with retry and blocked writes
   when the required directory is unknown. Keep the selected extension tab
   across ordinary navigation. Existing data must survive refresh failure.
   Use existing hooks/bridge; no new plugin capability or installation policy.
5. Extend focused management/extension smoke for these races and read states.

### Lead Progress

- Fixed oversized first-file diffs: preserve a partial file, complete supplied
  file counts, and a truncation notice. Added actual rendered-markup tests for
  oversized, exact-budget, and multi-file diffs.
- Fixed ZCode permission response selection so mismatched ids and timeouts
  cannot authorize an allow option; OpenCode transport also prioritizes denial
  over a conflicting override. Protocol fixtures verify rejection and explicit
  authorization scope without running a real agent.
- Fixed follow-up submission: guard running/queued tasks, retain drafts until
  accepted, preserve later edits, and record only accepted messages in history.
  Complete worker results are reachable and queue/parked counts are distinct.
- Remaining lead work: exact permission-option UI and response/error/lifetime
  state, goal/meeting consequence and read states, usage snapshot consistency,
  assistant settings reliability, final integration and visual acceptance.

## Accepted Follow-ups And Final Batches

The A/B follow-up source is integrated at `ed4420d`. Lead verification passed
typecheck, build, stage6, UI smoke and extension smoke. The real browser walk
now passes all 206 checks in 28 page/theme/viewport combinations; the separate
20-Agent picker and narrow-viewport walk passes 9 geometry/interaction checks.
Screenshots are in the local ignored `gui-test-screenshots/workflow-followup/`
and `gui-test-screenshots/workflow-batch-a-browser/` directories.

The independent review of the prior lead commit found three valid defects:
OpenCode mismatched/unknown allow ids, same-text draft ABA, and trailing-newline
diff counting. The lead fixed them and added corresponding regression cases,
including expanding and opening a previously hidden finished worker.

Permission implementation is now owned by the lead: broker timestamps,
resolution notifications, replacement tokens, optional pending snapshot IPC,
exact provider choices, failed-response retention, expiration and task-scoped
async handling. Worker panels expose the same pending tool approval. Existing
execution policy remains; no new sidecar permission transport is introduced.
Activity reads now distinguish failures from empty history, offer retry, and
show newest updates first; file-diff failures identify the fallback snapshot.

### Batch C: Goal And Meeting Actions

Owner: quick implementation teammate. Own only
`src/renderer/src/components/goal/GoalPanel.tsx`,
`src/renderer/src/components/goal/GoalCreateDialog.tsx`,
`src/renderer/src/components/meeting/MeetingPanel.tsx`,
`src/renderer/src/components/meeting/MeetingCard.tsx`, and scoped goal/meeting
selectors in `src/renderer/src/polish/detail.css` if required. Add separate
focused smoke/fixtures; do not edit TaskDetail, permission files, hooks, api.ts,
package scripts, main/shared execution code, or other batches.

- Distinguish initial loading, failed reads, known empty and stale goal/meeting
  data. Initial failure must not open a creation form or enable creation.
  Retry must recover and late responses must remain scoped to their Issue.
- Confirm goal/meeting cancellation with its actual effect on active tasks,
  continuation and retained records. Guard duplicate actions and catch errors.
  Preserve current pause/resume and start-IPC behavior; do not lock all meeting
  controls for the entire meeting while a start/resume promise remains pending.
- Show meeting action assignee and acceptance criteria. Explicitly label and
  confirm approval as approving AND starting the task. Reject must not start.
- Guard interjection both on click and Enter by status and pending state,
  respect IME, retain failed drafts, and do not erase newer edits on success.
- Show readable goal stop reasons and disable continue/retry when the existing
  controller will reject exhausted run/time budgets. Preserve `goalActions`
  public export and any smoke consumers; do not change budget policy.
- Verify failed reads/retry, cancelled confirmations, double clicks, waiting
  and concluded Enter, rejected interjection, and approval-to-start semantics
  using isolated bridge fixtures. Run required gates and existing UI smoke.

### Batch D: Usage And Assistant Settings

Owner: general teammate. Own `src/renderer/src/components/UsageView.tsx`,
`src/renderer/src/pet/PetSettingsPage.tsx`, and ONLY the `usePetState` hook in
`src/renderer/src/api.ts`; scoped rules in `pet/pet.css` or `polish/usage.css`
are allowed if necessary. Add dedicated smoke/fixtures. Do not edit shared
contracts, other api hooks, main-process pet behavior, execution code, package
scripts, or other batches. Preserve the existing assistant assets and style.

- Usage data and trend buckets must retain the range of their successful
  snapshot. Switching range must not relabel/rebucket old data as a new range.
  Handle deferred and failed reads explicitly, preserve stale data with its
  real scope, and retain newest-request protection.
- Correct success/failure text for zero runs, cancellations, pending work and
  partial successes. Remove the unsupported promise of a failure "to-do"
  queue; do not invent task links when aggregate data cannot identify tasks.
- Assistant state reads need loading/error/retry/stale states and protection
  against old reads overwriting broadcasts, while disabled remains a valid
  loaded state. Keep existing hook users working.
- Save persona only after acknowledgement, preserve failed/newer drafts
  (including same-text ABA), prevent duplicate submissions, and catch all
  settings mutation failures. Model draft must follow the selected preset
  without retaining a stale uncontrolled input.
- Generation start rejection must release busy and preserve configuration.
  Keep cost-bearing actions explicit; tests must stub generation and all real
  model/API calls. Do not generate or replace actual bitmap assets.
- Verify delayed saves, errors, retry, preset changes, range races and honest
  empty/cancelled counts. Run required gates and relevant UI smoke.

Final review remains read-only. No additional product areas or backend policy
changes should be added beyond these batches and corrections found in review.

### Current Lead Verification

Permission broker/UI tests cover exact provider scopes, failed and duplicate
answers, no-deny fallback, authoritative timestamps, expiry, request replacement
tokens, task switching, stale snapshots and renderer teardown. The shared UI
suite now includes extension and permission regressions. Runner, lifecycle,
sidecar and IPC validation passed after the additive approval API change.
The real-browser suite passes 210 checks with root and worker approval layouts
in both themes and the minimum window; local screenshots are under
`gui-test-screenshots/workflow-permissions/`. Dependency graph: 181 modules.

## Acceptance

- A user can find previous and active work, understand filter scope, and clear
  a no-results state without guessing which hidden condition is responsible.
- Creating work keeps the prompt, assignee, directory, and submission intent
  legible and reachable. Optional configuration does not dominate routine use.
- Task details prioritize present status and the next relevant action, with
  logs, worker output, and changes still reachable.
- Management screens support scan, selection, editing, cancellation, and
  recovery with clear pending/error feedback and no duplicate submissions.
- Preserve all existing capabilities and IME/focus/layer protections.
- Inspect light/dark themes at 1440x900, 1280x800, and 980x560; inspect a narrow
  viewport for wrapping and scrolling. No incoherent overlaps or unreachable
  actions with long titles/paths and larger lists.
- Run `npm run typecheck`, `npm run build`, `npm run smoke:stage6`, and
  `npm run smoke:ui`; add focused behavioral checks where the risk warrants it.
- Run relevant specialist suites if execution, delegation, sidecar, or
  worktree behavior changes. Refresh `npm run graph:deps` after source
  structure changes. Complete `git diff --check`.
- Use the existing isolated visual fixture in `scripts/smoke-ui-visual.mjs`
  where suitable. Report actual GUI coverage and any limitations accurately.

## Baseline

- 2026-09-20: repository map, existing visual contracts, primary renderer
  routes, and validation harnesses inspected.
- 2026-09-20: `npm run typecheck` passed on the intake working tree.
- Before dispatching implementation: build and stage6 (including typecheck)
  passed on `ac91c39`; the existing mixed static/dynamic git import warning
  remains. No new runtime behavior is included in this documentation commit.
- Audit conclusions so far are based on source inspection, not a new GUI run.
- At intake, no product implementation changes had been made; current progress
  and outstanding review items are recorded in the integration section above.
