# UI visual repair

## User correction and evidence

The user rejected the visual simplification before this task as well as the
inconsistent page titles that remained after the last iteration. This repair
supersedes the blanket removal of background identity in UI-UNIFICATION.md.
Preserve the existing interaction fixes and uncommitted work.

Commit cb8f071 removed the CSS background treatment in polish/page-shell.css.
The preceding implementation used psh-aurora, gradients and a dot pattern, not
a missing bitmap file. Recover depth and recognizable graphical texture without
restoring decorative gradient orbs, oversized heroes, or low-contrast text.

The current headers are structurally inconsistent: IssuesView uses a small span,
App's board wrapper repeats its title in a breadcrumb and toolbar, AgentsView
and UsageView use h2, WorkspaceView has a second large introduction, and
SettingsView places its page title inside the right-hand settings column.

## Shared Header Contract

Create ui/PageHeader.tsx with the following interface and markup:

```tsx
type PageHeaderProps = {
  title: React.ReactNode
  icon?: React.ReactNode
  count?: React.ReactNode
  actions?: React.ReactNode
  metadata?: React.ReactNode
}
// header.view-header[data-page-header]
//   div.view-header-main
//     div.view-header-heading
//       span.view-header-icon[aria-hidden] (optional)
//       h1.view-header-title (always present)
//       span.view-header-count (optional, including a zero count)
//     div.view-header-meta (optional, real context only)
//   div.view-header-actions (optional)
```

Use these hooks only; do not attach legacy page-header-bar/psh-header classes.
The shared component can import polish/page-header.css directly so the shared
header has one stylesheet and does not depend on a final override in main.tsx.

- Main title: 20px, weight 600, line-height 28px, letter-spacing 0.
- Section title: 16px, weight 600, line-height 24px. No viewport-scaled fonts.
- Header baseline: min-height 72px, padding 16px 24px, gap 16px. Standard
  single-row headers must have identical computed geometry across primary pages.
- Header title and icon remain aligned when actions wrap. Use a container query
  on main to put actions on a second row when needed; keep title type unchanged.
- Page gutters: 24px desktop, 16px when main is at most 760px wide. Align
  headers, filters, tab bars and the start of primary content to the same gutter.
- Background texture may be visible behind empty space and headers. It must not
  reduce text contrast or sit on top of controls. No generated runtime assets,
  external requests, gradient orbs, large marketing compositions or nested cards.

## Page Migration

| View | Main title | Required correction |
| --- | --- | --- |
| Issue | Issue | Replace issue-home-context with PageHeader; retain open tabs; make creation form unframed and its heading secondary. |
| Board | 看板 | Replace breadcrumb plus repeated title toolbar with one PageHeader; preserve search and filter/date actions. |
| Agents | Agent | Shared header; preserve every create/import/preset/forge action and dialogs outside contained scroll regions. |
| Automation | 自动化 | Shared header; remove the second promotional h1; retain the actual availability warning and scheduling actions. |
| Extensions | 扩展 | Shared header; shared-directory path is an action/context item, not a second arbitrary header layout. |
| Usage | 用量 | Shared header; keep range controls and refresh; keep KPI values distinct from page/section titles. |
| Settings | 设置 | Shared header above both settings navigation and body; .settings-layout wraps those two columns; active section gets a secondary h2. |
| Task detail | Actual task title | Keep a single task h1 at the shared page-title size, editable title and actions; breadcrumb/tab navigation remains subordinate context, not a repeated big title. |

Standalone RuntimeView may use PageHeader; embedded RuntimeView must not add a
second h1. Modal titles, Markdown headings and KPI typography are not page titles
and must not be caught by global heading overrides.

Remove obsolete explanatory page taglines and repeated greetings rather than
filling every header with descriptions. Keep useful status, validation, safety
and error messages. Preserve task routing, shortcuts, drafting, IPC and pet views.

## Ownership

- DeepSeek: PageHeader.tsx and renderer TSX page migration only. Own App.tsx,
  IssuesView, WorkspaceView, AgentsView, AutomationView, ExtensionsView, UsageView,
  SettingsView, RuntimeView and TaskDetail markup. No CSS or dependencies.
- Quick implementation agent: tokens.css, styles.css and polish/*.css; create
  polish/page-header.css for the exact contract above. Own graphical background,
  consistent gutters and titles, removal of obsolete header rules, unframed
  page sections and settings-layout rules. No TSX or dependency changes.
- Lead: integration, design documents, graph refresh if structure changes,
  representative-data screenshots and calculated header comparison.
- Independent reviewer: final review after integration, read-only.

## Acceptance

Use the actual renderer and all production CSS, isolated data and no real agent
execution. Capture all seven primary pages in both themes at 1440x900 and
980x560, plus detail with Dock and a long task title. Build a contact sheet or
side-by-side comparison; do not equate zero overflow with good visual design.

Assert one visible primary page h1, matching font/weight/line-height, matching
single-row header height, identical title/content alignment, reachable actions,
no overlap, and visible background treatment. Verify settings subsection heading
does not replace the main Settings heading. Retain screenshots for user review.

Required checks: typecheck, build, smoke:stage6, smoke:ui and Electron overlap
smoke. Report the preview URL and Electron bridge prerequisite accurately; do
not ship or overwrite the installed application as part of this repair.

## Integration Evidence

- Added PageHeader and migrated all seven primary pages. Settings now places
  its h1 above both columns and uses an h2 for the selected subsection.
- Painted the grid and route texture on the page surface itself. Removed the
  old psh-aurora nodes: a legacy positioning rule had turned them into 260px
  spacers above Agent and Usage content.
- Kept task metadata below its title, restored the visible rename action, and
  removed overflow clipping and the header stacking context around its popover.
- Dock activation now scrolls only its horizontal tab strip, preserving the
  parent task's vertical scroll position in stacked layouts.
- All seven root headers measure 72px high, 20px/600/28px type, with equal
  title offsets at both 1440x900 and 980x560. Main content no longer has a
  decorative spacer. Narrow layouts wrap real actions only when necessary.

`scripts/smoke-ui-visual.mjs` builds the actual renderer with Vite and injects
sample data through a fixture bridge. It uses Playwright with local Microsoft
Edge, without production data, Electron main-process APIs or agent execution.
The preview's settings use DEFAULT_SETTINGS and broadcast theme changes to all
subscribers. Dependencies for this optional check are isolated from the app:

```powershell
npm install --prefix out/visual-tools --no-save --package-lock=false --no-audit --no-fund playwright-core
node scripts/smoke-ui-visual.mjs
node scripts/smoke-ui-visual.mjs --serve
```

The screenshot pass covers 28 primary page/theme/size cases and 197 extra
layout/visibility assertions, plus detail, Dock and a long task title. Inspect
`gui-test-screenshots/visual-repair/headers.png`, `overview.png` and
`metrics.json`. These generated artifacts are locally retained and gitignored.
The preview server binds only to 127.0.0.1; VISUAL_PORT defaults to 4173.

Integration verification passed: typecheck, production build, smoke:stage6,
smoke:ui, smoke:ui:electron and git diff --check. The visual run recorded no
renderer exceptions. The dependency graph was refreshed to 177 modules.

## Boundary Review Follow-up

The independent review found gaps in the initial 122 checks. The visual script
now also tests information-popover bounds against `.detail-left` and the sidebar,
actual hit testing of every sidebar navigation button, eight long Dock tabs,
the entire selected tab row including its close button, Home/End navigation,
parent scroll preservation, and resizing an open popover to 980px.

The unchanged implementation fails these checks. The popover also overlaps the
sidebar at 1440px with a Dock open, not only in the 980px window. Reproduction
artifacts are retained under `gui-test-screenshots/visual-boundaries-before/`.

Follow-up file ownership:

- DeepSeek: `components/TaskDetail.tsx` and `ui/SideDock.tsx` only. Constrain the
  information popover to the actual detail-column bounds with measured inline
  positioning, and reveal the whole Dock tab row without scrolling ancestors.
  Preserve the interaction layer and focus contracts. No CSS or test edits.
- Quick implementation agent: `polish/page-header.css` and existing other
  `polish/*.css` only. Leave header-scoped rules in the component stylesheet;
  return canvas/gutter rules to page-shell, section type to foundation, Issue
  layout to issue-home, Settings to operations, and task header variants to
  detail. Preserve existing geometry, theme colors and cascade precedence.
- Lead: owns `scripts/smoke-ui-visual.mjs`, integration and final verification.

Acceptance: all previous page/title checks plus the new boundary checks pass in
both themes, with and without Dock at 1440x900 and 980x560. Popovers must stay
inside the detail column and visible viewport; sidebar hit targets remain free.
The active tab row and its close button must be entirely visible while parent
scrollTop remains unchanged. PageHeader's imported CSS must not style unrelated
page content. Do not alter app execution or IPC contracts.

### Resolved

Both fixes passed lead integration verification: the prior 26 failures now pass,
with 28 primary-page cases and 197 assertions overall, without renderer errors.
The popover uses measured column/viewport bounds and responds to resize and
scroll. Dock reveals the whole selected row, including the close button, while
focus navigation preserves the task's scroll position. The PageHeader stylesheet
now contains only selectors scoped to `header.view-header[data-page-header]`;
other rules live in their owning polish files.

Revalidated typecheck, production build, smoke:stage6, smoke:ui,
smoke:ui:electron and git diff --check. Updated screenshots are retained in
`gui-test-screenshots/visual-repair/`. The local preview at
`http://127.0.0.1:4173` serves the latest renderer with fixture data. No installed
application or production task data was changed.
