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
- No product implementation changes have been made in this phase.
