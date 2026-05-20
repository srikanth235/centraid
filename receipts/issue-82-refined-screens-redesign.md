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
- [ ] Step 4 — Builder B1–B6
- [ ] Step 5 — Settings monolith split (C)
- [ ] Step 6 — App view copilot (D)
- [ ] Step 7 — Per-app settings tabbed popover (E)
- [ ] Step 8 — ⌘K command palette (F)

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

## Out of scope

- The DS v0.5 token + chrome-primitive layer (already landed).
- Mobile-side adoption of the new screens (desktop renderer only).
- The Automations scheduler (lands with §E3) — the page currently
  shows an empty state only.
- A dedicated `createdAt` field. The §A3 "NEW" badge keys off
  `updatedAt` as a recency proxy, so a republish inside 24h re-shows
  NEW. A precise `createdAt` would need plumbing through the publish
  flow — deferred.

## Verification

- `bun --filter @centraid/design-tokens run typecheck` — clean
- `turbo run typecheck --filter=@centraid/desktop` — clean
- `turbo run build --filter=@centraid/desktop` — clean
- `oxlint` on the changed renderer files — clean
- Visual verification in a running Electron window is pending — the
  desktop app needs a gateway/runtime backend; recommend a manual
  `bun run dev:desktop` smoke test.
