# AgentDeck UI unification

## Objective and scope

Unify the existing desktop workbench and provide one typed entry point for shared UI interactions. Preserve the Issue, board, task detail, Agent, automation, extensions, usage and settings workflows. Keep task execution in the existing renderer task-service and typed bridge. No changes to main-process orchestration, IPC contracts or backend adapters are needed.

The current app has a token file plus multiple generations of CSS overrides. Global interactions are split between App callbacks, module-level toast/confirm handlers, synthetic keyboard events and window CustomEvents. The SideDock -> WorkerPane -> TurnTimeline -> SideDock runtime cycle must be removed as part of the interaction work.

## Design decisions

- Context: a compact desktop tool for scanning task state and repeatedly creating, opening and following work. Target laptop/desktop viewing distance; quiet, legible, operational styling.
- Surfaces: neutral graphite in dark mode and white/cool neutral gray in light mode. Avoid blue-tinted dark surfaces dominating the interface. Preserve the existing teal identity with restrained accents, accompanied by amber queue, green success, red error and neutral cancelled states. Special category colors must be named tokens.
- Typography: local Segoe UI / Microsoft YaHei UI for UI text, Cascadia Code / Consolas for code and IDs. Body 14px, controls 13px, supporting text 12px, dense metadata 11px, section titles 16px, page titles 18px. No viewport-scaled type; letter spacing 0.
- Spacing: shared 4/8/12/16/20/24/32px tokens. Consistent page headers, toolbars, form rows and list density across all primary views.
- Shape: control radius 6px, repeated-item cards/dialogs at most 8px. Full-width or unframed page sections. Nested child tasks read as rows inside a task, not cards inside cards.
- Elevation: flat page surfaces and restrained borders; shadows for menus, dialogs and true floating windows only. Remove decorative aurora/glow/gradient washes and hover translation from operational surfaces.
- Motion: 120-180ms color/border/opacity feedback; respect reduced motion. Persistent status should not require a pulsing card or glow.
- Assets: reuse the existing brand/application assets and lucide-react icons. No decorative stock imagery or replacement logo. The separate desktop-pet scene retains its own assets and styles.
- States: consistent hover, selected, focus-visible, disabled, pending, empty and error treatments. Color must not be the only state signal.
- Layout: verify at 1440x900, 1280x800 and Electron's minimum 980x560; additionally inspect a narrow browser viewport for graceful scrolling/wrapping. Long titles, paths and localized labels must not overlap controls. Keep tool dimensions stable.

## Interaction architecture

Use a standalone `src/renderer/src/ui/interaction-center.ts` module (plus focused React hooks/host modules where needed). It must not import views or rendered UI components. Export typed commands and types through this entry point; UI hosts subscribe and render. Prefer an explicit store/subscription or registration mechanism over synthetic DOM events.

Shared responsibilities:

1. Navigation commands, task/tab selection and closure, settings section, command palette and new-task composer focus. Every trigger (sidebar, palette, keyboard and bridge focus events) must call the same action path. Event subscriptions must observe current tasks, avoiding stale closures.
2. Notifications and asynchronous confirmations. Existing names may be compatibility re-exports, but consumers should import commands from the center. Pending confirmations must settle on completion, cancellation and host teardown; concurrent requests must have a documented policy. Toast lifetimes must not leak timers or disappear merely because a host mounts later.
3. Typed dock open/update/close commands and dock data types. Opening a worker from another view must survive host mounting without a 60ms timeout. Preserve root-task routing, tab limit, broken/cyclic-parent fallback and two-stage file-diff updates. Do not leak stale dock requests to unrelated tasks; closed items must not reopen when an asynchronous diff completes.
4. Shared layer behavior for dialogs/popovers where appropriate: topmost Escape handling, outside-pointer dismissal, initial focus, focus containment for modal dialogs, and focus return to a connected trigger. Global shortcuts must respect editable/contenteditable elements, composition and active modal layers. Local form values and feature-specific business state stay local.

Do not turn the center into a second domain-service layer. Task start/stop/retry/permission operations retain existing semantics. Preserve public exports consumed by smoke scripts; check scripts and docs/graph/INVENTORY.md before deleting symbols.

## Work ownership

- Visual implementation: `src/renderer/src/tokens.css`, `styles.css`, `polish/*.css` only. Consolidate overlapping declarations in place; avoid appending another broad override layer. Add missing tokens to tokens.css and replace component hardcoded design values with their semantic tokens. No TSX changes in this workstream.
- Interaction implementation: renderer TS/TSX and new focused `scripts/smoke-ui-*.mjs` only; no CSS or package metadata changes. Migrate existing callers, implement shared behavior and add meaningful regression coverage for delivery/lifecycle/routing/focus risks. Keep existing class names so visual work can proceed independently.
- Lead integration: asset hookup or residual markup adjustments, documentation, graph generation, integrated verification and screenshots after both streams return.
- Review: read-only review of final combined changes, ordered by severity with file references and concrete reproduction paths.

Existing unrelated work must be preserved: `docs/features/desktop-pet.md`, `scripts/pet-pack.mjs`, `scripts/smoke-pet-pack.mjs`, `src/renderer/src/pet/PetStage.tsx`, `src/shared/pet.ts`. Do not edit or revert these files for this task.

## Acceptance

- Required: `npm run typecheck`, `npm run build`, `npm run smoke:stage6` and the added UI regression smoke. Run `npm run graph:deps` after structural changes; update relevant human graph notes to describe the new interaction entry point.
- Interaction walk: sidebar/palette/keyboard navigation, composer focus after switching view, task and worker opening, task/tab deletion, dock update/close, confirmation accept/cancel/Escape/focus return, toast dismissal, menu keyboard navigation, and theme switching.
- Visual walk: all primary views in both themes; task detail plus dock; menus/dialogs; long text and minimum window dimensions; no renderer console errors.
- GUI validation should use an isolated user-data directory via `AGENTDECK_USER_DATA_DIR`; do not create/start real agent tasks or modify production data. Existing `scripts/cdp-walk.mjs` can help; Playwright screenshots are also suitable.
- Start a local preview/dev server for the delivered UI and report its URL with any Electron bridge prerequisite. Record what was actually verified and any remaining limitations.

## Status

- Repository and UI entry-point inspection complete.
- Visual tokens and all eight polish sections are implemented; minimum-window dock layout and focus restoration fixes are integrated.
- `npm run smoke:ui` runs the interaction-center and React DOM focus suites, using the normal jsdom devDependency. The command is also included in `smoke:all`.
- Independent review found remaining work: refresh the task catalog after draft creation; reconcile deferred task/dock routing when the catalog arrives; align visual and logical layer order; allow application shortcuts through nonmodal windows; guard local Enter handlers during IME composition. These remain acceptance blockers until fixed and verified.

## Review Follow-up Ownership

The integrated baseline contains the visual work, minimum-window layout fix, interaction center, focus restoration fix and standard `smoke:ui` command. Main-branch assistant settings/generation changes are preserved. The lead reran build, stage6 (including typecheck), UI smoke and an isolated Electron check: 980px dock right edge is 980px; Agent modal Escape returns focus to its trigger; no renderer exceptions.

- Task catalog/navigation: own `api.ts`, `App.tsx`, `components/WorkspaceView.tsx`, `ui/interaction-center.ts`, `scripts/smoke-ui-interaction-center.mjs` and a separate new draft/catalog integration test. Fix draft-created tasks becoming visible before navigation, refresh response races, initially unavailable catalog routing and dock migration without invalidating live handles or reviving closed entries. Fix global shortcuts to consult `interactionLayers.topModal()` rather than blocking on all windows/popovers.
- Layers/IME: own `ui/interaction-layer.ts`, `hooks/useInteractionLayer.ts`, rendered UI hosts/components other than App/WorkspaceView, `scripts/smoke-ui-focus.mjs`, its fixtures and any necessary layer-specific CSS only. Align pointer/focus/visual stacking; protect local Enter/Escape/arrow handlers during composition, using the existing `isComposingKey(event.nativeEvent)` helper from the center. Preserve focus restoration fixes and support nested layers without input leaking to lower windows.
- Shared contract already supplied: `LayerStack.topModal(): LayerRecord | null` returns the highest modal even when a popover is above it. `isComposingKey({ isComposing?, keyCode? }): boolean` is the shared IME guard. The two workstreams must preserve these exports; no further joint file edits are needed.
- Lead owns package scripts/dependencies, docs/graph generation and final integrated verification. New tests may be added by either workstream; report their commands for standard-suite registration. Do not revert existing integration changes or assistant-window routes.
