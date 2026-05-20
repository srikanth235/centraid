# issue-82 — Refined Screens redesign

GitHub issue: [#82](https://github.com/srikanth235/centraid/issues/82)

Applies the **Refined Screens** handover (`ds-update/Handover - Refined
Screens.md`) — the product redesign that sits on top of design-system
v0.5. The DS v0.5 token layer (lighter blue-tinted dark ramp with
`--bg-l`, sidebar tokens, chrome primitives `.cd-window` / `.cd-tb-btn`
/ `.cd-sb-item` / `.cd-status`) already landed in prior work; this issue
applies the screen-level redesign, landed as one commit per step.

## Checklist

- [x] design-tokens — refined-screen icons + Send glyph fix
- [x] Step 2 — Sidebar restructure (G2/G3)
- [x] Step 3 — Home redesign (A1/A2/A3)
- [x] Step 4 — Builder B1–B6
- [x] Step 5 — Settings monolith split (C)
- [x] Step 6 — App view copilot (D)
- [x] Step 7 — Per-app settings tabbed popover (E)
- [x] Step 8 — ⌘K command palette (F)

## What changed

**design-tokens — refined-screen icons + Send glyph fix.** The redesign
introduces a command palette, a Discover destination, the Builder pane
toolbar, and a rebuilt Cloud surface — all needing glyphs absent from
the shared icon set. Added `Refresh`, `Copy`, `Star`, `Compass`,
`Bolt`, `Globe`, `Phone`, `Tablet`, `Monitor`, and `Command` to
`packages/design-tokens/icons.ts` (the single source of truth for
desktop + mobile). The `Send` icon — previously a plain right-arrow
visually identical to the forward-nav glyph, flagged in §B2 of the
handover — was replaced with a proper paper-plane.

**Step 2 — Sidebar restructure (G2/G3).** `chrome.ts buildSidebar` was
rebuilt around the refined information architecture: an accent-tinted
`Build new` entry plus `Search` at the top; a `Pages` section with
`Home` / `Discover` / `Starred` / `Automations`; the live `Apps` list;
and `Settings` pinned to the bottom carrying a `live` status pill
(`.cd-status[data-tone="live"]`) in place of the old Local/Remote tag.
The standalone disabled `Plugins` row was dropped and `Automations`
graduated from a disabled stub into a Pages destination (§E3). The app
matching `activeId` now expands into `App`/`Cloud` children bound by an
indented hairline rule (§G2) — `expandedApp()` plus the new
`.cd-sb-folder-children` styling. `sbItem` gained `accent` and
`trailing` slots. The `ChromeBuildSidebarOpts` contract added
`activePage` / `activeSurface` / `onDiscover` / `onStarred` /
`onAutomations` / `onAppSurface` and dropped the now-unused
`runtimeMode`. `app.ts` added `discover` / `starred` / `automations`
`ShellRoute` kinds with back/forward support and three destination
pages — Discover renders the template gallery (which §A3 removes from
Home), Starred and Automations ship list/empty states pending later
steps. `buildHomeSidebar` was generalised to take an `{ page, appId,
surface }` descriptor; `window.Centraid` exposes `openDiscover` /
`openStarred` / `openAutomations` so the builder's sidebar routes
through the shell.

**Step 3 — Home redesign (A1/A2/A3).** `renderHomeAsync` now branches
into two layouts by app count. The Day-1 home (§A1, 0–2 apps) keeps the
centred composer hero — its placeholder rotates through five example
prompts every 6s and pauses once the user types — and adds a tabbed
discovery shelf (`buildTabbedShelf`): Templates (the live gallery),
Examples (six seed prompts that drop into the builder), and Recently
viewed (`home.recent`, tracked in `openApp`). The loaded home (§A2, 3+
apps) demotes the composer to an ambient pinned `BuildPill` — a slim
360px bar that expands into a full composer card on click — then leads
with a `Starred` section and an `All apps` grid of slightly smaller
tiles, closing on a quiet "Discover templates" footer. The old
`renderHomeAppsEmptyState` card and its `.cd-apps-empty*` CSS were
removed (the shelf does that job now). App tiles became the
`RefinedAppTile` (§A3): a vertical card with a 40px icon, a
hover-revealed star that toggles `home.starred`, the static blurb, and
a state-aware bottom strip — `DRAFT`, `NEW` only for the first 24h
(`isRecentlyCreated`), otherwise `opened <relative time>`. `wireComposer`
factors the shared textarea/submit wiring; `registerCleanup` chains the
rotating-placeholder timer onto the page teardown.

**Step 4 — Builder B1–B6.** The Builder was assessed against all six
sub-items; this commit lands §B4 and records the state of the rest:

- §B4 (skeleton preview) — *implemented.* `renderPreview`'s "Nothing to
  preview yet" paragraph is replaced by a shimmering skeleton phone
  (`buildPreviewSkeleton`): a status bar with `9:41` + battery glyph, a
  title/sub/card stack, a 28-cell calendar grid, and list rows, each
  animated by the new `skel-shimmer` keyframes. A floating
  `Building · preview refreshes on save` pill sits on the device wall.
- §B1 (single titlebar) — *already in place.* A prior Builder refactor
  removed the full-width `cd-app-strip`; identity lives in the chat
  pane header and view-context controls ride in the window chrome row.
- §B2 (single agent stream) — *already largely in place.* The live
  Builder consolidates progress into tool-group pills + thinking blocks
  and updates status rows in place (`updateMessage`) rather than
  stacking a new chip per step. The literal "3 grey chips" the handover
  describes is from the design demo, not the live code.
- §B3 (pane toolbar) — *conflict, deferred.* The handover wants the URL
  bar + viewport + Preview/Code toggle in a right-pane toolbar; the
  live Builder deliberately moved these into the window chrome row
  (`titlebarCenter`) in a recent refactor. Per the handover's own note,
  this conflict is flagged rather than silently reverted.
- §B5 (editable code workspace) and §B6 (Cloud rebuild) — *deferred.*
  Each is a substantial standalone feature (an in-pane editor with
  tabs/diff; a Cloud hero + activity feed). Tracked for follow-up.

**Step 5 — Settings monolith split (C).** §C1 is implemented:
`renderSettingsAsync` no longer appends every `drawerGroup` into one
continuous scroll. Seven page hosts now exist (`appearance`, `layout`,
`workspace`, `providers`, `inference`, `runtime`, `sync`) and each
group-builder appends into its own host — Theme → Appearance, Layout +
App tiles → Layout, Chat → Workspace, AI providers → AI providers,
Custom inference endpoint → Inference endpoint, Runtime → Where apps
run, plus a placeholder Sync & backups page. An inner-sidebar shell
(`.cd-settings-shell`) renders a sectioned page nav (Workspace /
Models / Runtime) beside a content pane that shows exactly one page at
a time, so no single view mixes cosmetic and credential controls.
§C3 (provider state badges) is partly in place — the AI providers page
already renders per-provider credential status rows. §C2 (Appearance
live-preview tile) and §C4 (per-page save-footer / auto-saved caps)
are deferred polish; the inference and runtime pages keep their
existing Save/Test buttons.

**Step 6 — App view copilot (D).** §D4 is implemented: the App-view
titlebar's floating Edit sparkle is replaced by a `Use` / `Build`
segmented switch (`.cd-mode-switch`) — `Use` is the running app
(active), `Build` returns to the builder. The rename matters per §G4:
"Edit" read like editing a list row. §D2 is completed: the copilot
panel was already collapsed by default with a FAB, so this pass turned
the bare glyph FAB into a labelled `Ask <app>` pill carrying a `⌘J`
hint, and wired `⌘J` as a global toggle (registered on mount, removed
on teardown). §D3 (collapse the copilot's three header icons into a ⋯
overflow) and §D1 (coordinated "Try these starters" empty state across
the running app + copilot) are deferred — the copilot already collapses
to a FAB so the 340px-always-on problem the handover flags is solved.

**Step 7 — Per-app settings tabbed popover (E).** `openAppSettings`
previously stacked Preferences, Automations and Manage (Delete
included) in one flat list. §E1: the popover now has three tabs —
Appearance (per-app knobs), Automations, Manage — each showing one
pane at a time. §E2: an `Auto-saved` mono-caps marker sits in the
header next to the close button (the popover saves on change, so
there's no Save button). The Automations pane gains an
`Open Automations →` link that graduates to the top-level Automations
destination (§E3, wired in Step 2). §E1 Manage: Rename / Share /
Reveal stay as a menu, and Delete moved into a bordered `Danger zone`
whose button arms a confirmation step ("Click again to delete") before
it fires.

**Step 8 — ⌘K command palette (F).** A new `openCommandPalette` surface
in `app.ts`: a 640px card over a dimmed, 6px-blurred backdrop, with an
auto-focused input. Results group into Build (always — "Build "<query>""
seeds the builder, or opens the new-app sheet when empty), Apps · N
(matching user apps + drafts, or recents pre-query), Templates · N
(matching the live gallery) and Settings (the seven page labels).
Up/Down move an accent-railed highlight, Enter runs the active row,
Escape or a backdrop click closes. It opens from a global `⌘K`
(registered on the document) and from the sidebar `Search` row, which
is now wired — `buildHomeSidebar` passes `onSearch`, and the builder's
sidebar routes through the new `window.Centraid.openSearch`.

## Out of scope

- The DS v0.5 token + chrome-primitive layer (already landed).
- Mobile-side adoption of the new screens (desktop renderer only).
- The Automations scheduler (lands with §E3) — the page currently
  shows an empty state only.
- A dedicated `createdAt` field. The §A3 "NEW" badge keys off
  `updatedAt` as a recency proxy, so a republish inside 24h re-shows
  NEW. A precise `createdAt` would need plumbing through the publish
  flow — deferred.
- Builder §B5 (editable code workspace) and §B6 (Cloud rebuild) —
  larger standalone features deferred from this pass; §B3 (pane
  toolbar) is a flagged conflict with a recent live-repo refactor.

## Verification

- `bun --filter @centraid/design-tokens run typecheck` — clean
- `turbo run typecheck --filter=@centraid/desktop` — clean
- `turbo run build --filter=@centraid/desktop` — clean
- `oxlint` on the changed renderer files — clean
- Visual verification in a running Electron window is pending — the
  desktop app needs a gateway/runtime backend; recommend a manual
  `bun run dev:desktop` smoke test.
