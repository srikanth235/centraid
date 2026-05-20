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
- [x] Follow-up B2/B3 — Builder pane toolbar
- [x] Follow-up B5 — Builder editable code workspace
- [x] Follow-up B6 — Cloud Overview hero + activity feed
- [x] Follow-up C2/C3/C4 — Settings preview, badges, save markers
- [x] Follow-up D1/D3 — copilot starters, overflow, createdAt

## What changed

**2026-05-20 — Builder pixel-fidelity pass.** Relocated the Builder
project identity into the window titlebar to match the refined
`RefinedBuilder` artboard. The in-pane `builder-pane-header` row was
removed; `chrome.ts` gained a `titlebarLead` slot that lands the
app-identity lockup in `.cd-tl-nav` hugging the back/forward arrows,
while history / more / Publish ride the trailing edge via
`titlebarRight`. The lockup is a soft ink-washed pill with a gradient
app-icon tile (`tileFinish`), the editable project name, and a compact
uppercase-mono status badge with a pulsing dot (`cd-pulse`); the chat
pane now has no header. The primary action is `Publish` with the
Share/upload glyph in both new-build and update modes. The chat-pane
`⌘\` toggle was retained. Right-pane toolbar: the device switcher and
the Preview/Code toggle became icon-only, and both segmented clusters
moved from full pills to 7px rounded-rect tracks with 5px inner items.
Sidebar `Chats` section header gained a `+` action (wired to the
new-chat fallback). Composer: placeholder unified to `Describe a
change…`, the open-project-folder button removed (attach only), and the
`Today` date divider now carries the start time (`Today · HH:MM`). The
preview skeleton phone was repainted to the proposal's light device —
light-gradient screen, dark status-bar text, light-grey shimmer blocks,
28px radius, deeper layered shadow. Verified via Electron screenshots
against `03-builder` / `04-builder-code`.

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

**Follow-up B2/B3 — Builder pane toolbar.** §B3 (previously a flagged
conflict) is now implemented: the Preview/Code toggle, the preview URL
pill, and the viewport device pill move out of the window chrome row
into a dedicated right-pane toolbar (`rb-toolbar`) that sits directly
above the canvas — the layout the handover specifies. The new URL pill
(`rb-url`) shows a sync-state dot (live / local / building), the
trimmed preview URL in monospace, and a reload button; `renderPreview`
keeps the text + dot in sync and stamps the full URL on the pill's
`title`. `rb-toolbar[data-tab]` gates the preview-only controls so the
URL + device pills hide on the Code surface. The mode toggle is now
Preview/Code only — Cloud graduates to a sidebar destination (§G2):
the expanded active app's `Cloud` child switches the right pane to the
Cloud surface via `onAppSurface`, and the builder passes
`activeSurface: 'cloud'`. The window chrome's `titlebarCenter` slot is
dropped, and the now-dead `builder-tl-center` / `urlbar-slot` CSS is
removed. §B2 (single agent stream) needed no change — the live Builder
already consolidates progress into in-place tool-group pills + thinking
blocks rather than stacking a chip per step.

**Follow-up B5 — Builder editable code workspace.** The Code surface is
no longer read-only. `renderCode` is rebuilt around an editable editor:
a transparent `<textarea>` stacked over a tokenized `<pre>` (`code-edit-*`)
so typing stays live while keeping syntax colour, with a synced
line-number gutter and Tab→two-spaces / ⌘S handling. Open files become
tabs (`code-tabs`) carrying a dirty dot; the file tree gains a matching
dirty marker. The file head shows an `Unsaved` badge, a per-file
**Save** (⌘S), a **Diff** toggle, and a `⋯` overflow menu carrying
`Save all (N)`, `Revert this file`, and `Open project folder`. The Diff
view renders a unified LCS line diff of the buffer against its last
saved state. Edit buffers, open tabs, and the active file are hoisted
out of `renderCode` so unsaved edits survive `renderRight()` re-renders
(peeking at Preview and back); clean buffers re-sync to disk so agent
rewrites are picked up. Persistence rides a new `writeProjectFile`
helper in `@centraid/builder-harness` (path-traversal guarded, text
extensions only) exposed over a `PROJECTS_WRITE_FILE` IPC channel.

**Follow-up B6 — Cloud Overview hero + activity feed.** The Cloud
surface's rail (Active sections + a "Coming soon" group) and section
panels were already rebuilt in earlier work; this pass completes §B6's
remaining Overview asks. The live deployment URL is promoted out of the
stat grid into a full-width **hero strip** (`cloud-hero`) — status dot,
eyebrow, mono URL, Copy button — so it reads as the headline fact
rather than one card among many. The stat grid is trimmed to four
tiles (Versions, Tables, Schema version, Gateway). Below it a new
**activity feed** (`cloud-feed`) renders the version history as a
chronological deploy log: newest publish first, the active version
flagged, each row showing file count, byte size, and relative time.

**Follow-up C2/C3/C4 — Settings preview, badges, save markers.** §C2:
the Appearance page gains a live-preview tile (`ap-preview`) — a
miniature window mockup with mini app-tiles, an accent button, and
skeleton text — that re-renders on every appearance change via a new
`onAppearanceApplied` hook fired from `applyPrefs`, so tile-variant and
accent choices land on a representative surface. §C3: each AI-provider
row now carries a state badge (`provider-badge`) — `Preferred` /
`Connected` / `Standby` / `Not found` — so status doesn't depend on
reading the subtitle prose. §C4: the settings inner-shell renders a
per-page header; pages whose controls persist on change (Appearance,
Layout, Workspace) carry an `Auto-saved` marker, while the credential
pages (Inference endpoint, Where apps run) keep their explicit
Save/Test buttons and get no marker.

**Follow-up D1/D3 — copilot starters, overflow, createdAt.** §D1: the
app-view copilot's empty state leads with a "Try these starters" block
— four tappable prompt chips (`app-chat-starter`) that drop into the
composer, so a fresh copilot pane is never a blank box. §D3: the
copilot header's New-chat and Chat-history icons collapse into a `⋯`
overflow menu (`app-chat-overflow-menu`), leaving a calm header of
title · ⋯ · ×; the back affordance still appears on its own in history
view. Separately, `UserAppMeta` gains a real immutable `createdAt`
stamp — set once when an app first lands on home, backfilled from
`updatedAt` for older apps — and the §A3 "NEW" badge now keys off it
(`isRecentlyCreated(createdAt)`) so a republish inside 24h no longer
re-shows NEW.

**Pixel-match Home screens + type-token sync (2026-05-20).** A
fidelity pass that takes the structurally-faithful Home screens to a
pixel match of the refined proposal artboards. `styles.css :root` gains
the full `--t-*` type scale and `--tracking-*` tokens copied from the
design-system `tokens.css`, so the screen CSS references `var(--t-*)`
exactly as the design source does. Day-1 home (`renderDay1Home` /
`buildHomeHero`) now opens with an accent-`NEW` announcement pill, a
44px `--t-display-1` heading, and the `Day1Composer` card — an
18px-radius bg-elev surface with an accent-glow shadow, the descriptive
placeholder, and the full toolbar row (`+` attach, `✦ Build ⌄` mode
pill, mic, `⌘↵` keycap, circular dark send). `buildTabbedShelf` was
rebuilt as `HomeShelf`: pill-style segmented tabs (My apps / Starred /
Templates) each with a zero-padded count badge, a `Browse all →` button
pushed right, and a 6-column `RefinedAppTile` grid; the separate "Your
apps" section above the shelf was removed so apps live only in the
shelf. Loaded home (`renderLoadedHome`) gains an eyebrow date +
`Your apps.` heading with the `BuildPill` floated right; `SectionBar`
renders a zero-padded mono count and a `Sort · recent` chip on "All
apps". `renderAppCard` matches `RefinedAppTile` — 12px-padded tile,
gradient icon with a corner status dot, hover-revealed star in the top
row, 2-line clamped blurb, and a state-aware mono foot strip
(NEW/DRAFT label · timestamp). `chrome.ts buildSidebar` drops the
`Automations` Pages item, folds drafts into the `Apps` list, and labels
section headers `Apps · N` / `Chats · N` with a hover-revealed `+`.
Verified by Electron screenshots against the proposal artboards.

**Pixel-match Builder screens (2026-05-20).** A fidelity pass taking the
Builder Preview, Code, and Cloud surfaces to a pixel match of the
refined proposal artboards (`RefinedBuilder` / `RefinedBuilderCode` /
`RefinedBuilderCloud`). Chat pane (`RBChat`): the assistant turn drops
its monospace `builder` author chip for flat prose led by a 22px
sparkle avatar (`msg-ai-avatar`); user messages become tinted accent
pills (`16%` fill, `28%` border) instead of solid-accent bubbles; the
scroll body is now a flex column with an 18px message gap. The composer
follow-ups move under a "Suggested next moves" mono-caps eyebrow
(`prompt-starters-group`) rather than an inline `✦ Try` label, and the
composer toolbar gains a `⌘↵` keycap (`chat-input-kbd`) beside a 30px
send button; the attach control uses a proper paperclip glyph. The
right-pane toolbar (`rb-toolbar`) is reordered to mirror `RBPaneToolbar`
— URL pill at the leading edge, then a spacer, the viewport device
pill, an open-in-new-tab button (`rb-toolbar-share`), and the
Preview/Code toggle trailing; the URL pill is retuned to a 24px
6px-radius bg-elev pill. Code workspace: file tabs switch from a
top-border to a bottom-border accent underline with bolded active
labels; tree group headers (`code-tree-group-head`) gain a trailing
mono file count; and a new bottom status strip (`code-status`) renders
`N lines · KB · autosaving · line L col C · LANG` with a live
caret-position readout wired off the editor textarea's selection.
Cloud: stat-tile values jump to a 24px display weight on a faint
`ink 3%` tile fill, and the gateway/loading values are pinned
`nowrap` so "Reachable" / "Loading…" no longer wrap. Verified by
Electron screenshots against the three proposal artboards.

**Pixel-match Settings + command palette (2026-05-20).** A fidelity pass
taking the Settings screen and the ⌘K command palette to a pixel match
of the refined proposal artboards (`RefinedSettingsV2` /
`RefinedSearch`). Command palette (`openCommandPalette`): the input
becomes a row with a leading search glyph and a trailing `esc` chip; a
footer hint bar (`cd-palette-footer`) was added — navigate ↑↓ / open ↵ /
open in new window ⌘↵ / esc close. Result groups are now Build / Apps /
Chats / Settings: Build leads with an accent-chip primary action ("Build
<query>" or "Build a new app") plus a "Browse templates" row, each
carrying a per-row `↵` kbd hint; Apps rows render the gradient app-icon
tile (`cd-palette-row-tile`) with a right-aligned mono timestamp; a new
Chats group surfaces recent builder conversations; Settings rows carry a
one-line blurb. The card was retuned to a 16px radius over a 78%-`--bg`
6px-blur backdrop. Settings (`renderSettingsAsync`): the inner shell is
rebuilt as a two-column `main` grid — a 232px category nav beside an
independently scrolling content pane. The nav (`cd-settings-nav`) rides
a faint ink wash with a `Settings / Personal` header, grouped sections
(Workspace / Models / Runtime) where each item is an icon + label +
optional mono hint, and a `v0.5.2` footer. Each page opens with a
`PageHead` — a 26px display title (auto-saved marker inline where
applicable) above a 13.5px subtitle line. `drawerGroup` became the
proposal `Sec` (a plain bold heading above a hairline-topped body);
`drawerRowH` is the `Row` two-column grid (label + hint left, control
right, with a `full` stacked variant). Within Settings the segmented
control renders as the inline bordered `Seg`, `cd-switch` as the 34×20
accent `Tog`, and `makeSwatches` as labelled accent-swatch cards
(Electric / Violet / Teal / Ochre / Rose). The Appearance Mode control
gains an Auto option (resolves the OS `prefers-color-scheme` one-shot —
no new persisted state); the App-tiles treatment + a 4-up live preview
grid (`ap-preview`) moved onto the Appearance page; the inference page
was split into Provider / Connection / Credentials sections. All
settings persistence, theme application, provider config, and palette
search/keyboard handling were preserved. Verified by Electron
screenshots against the proposal artboards.

**Pixel-match App view + per-app settings popover (2026-05-20).** A
fidelity pass taking the App view (running app + copilot, expanded and
collapsed) and the per-app settings popover to a pixel match of the
refined proposal artboards (`RefinedAppView` / `CopilotExpanded` /
`CopilotCollapsed` / `RefinedAppSettingsPopover`). Copilot
(`app-chat.ts`): the collapsed FAB is retuned to the proposal's quiet
glass pill — a sparkle in a 22px accent-tinted disc, the `Ask <app>`
label, and a `⌘J` keycap. The expanded panel becomes a floating inset
glass card (14px-inset, 16px radius, soft-card halo, no hard outline)
that slides in from the canvas edge; its header reads `Copilot` beside
a 24px sparkle avatar with a mono `scoped · <app>.app` sub-context line
(which now also carries the active chat title in place of the old
title-text swap), and the close affordance becomes a chevron Minimize.
The empty state leads with an intro card — a `Chat with your <app>
data.` headline, an explainer, and pill-shaped starter chips — followed
by a lazily-hydrated `Recent chats` list (real gateway sessions, click
to resume). The composer is a single card: the textarea over a toolbar
row with a paperclip, a `⌘↵` keycap, and a 26px accent send button.
Titlebar (`openApp`): the brand chip becomes the proposal identity
lockup — a gradient app-icon tile + name + a `live` success chip — and
a `⋯` More button joins the gear after the Use/Build switch; the switch
itself is retuned to the 28px pill shape. Popover (`openAppSettings`):
the card matches `RefinedAppSettingsPopover` — 340px wide, soft-card
radius 16, a header with a 32px gradient icon tile + name + `APP
SETTINGS` eyebrow + close (the `Auto-saved` marker was dropped), and a
segmented tab pill carrying glyphs plus a live count badge on
Automations. The Appearance pane drops the `Preferences` heading and
renders Font/Width/Corners as compact label-left segmented-right grid
rows with the App-color swatches hairline-separated below; the Manage
tab's rows gain 28px icon tiles + a sub-line, and the Danger zone's
Delete is a destructive icon-tiled row that reveals a `click to
confirm` pill when armed. All copilot agent wiring, message rendering,
starters, history, knob persistence, automations, and rename/delete
behavior were preserved. Verified by Electron screenshots against the
three proposal artboards.

## Out of scope

- The DS v0.5 token + chrome-primitive layer (already landed).
- Mobile-side adoption of the new screens (desktop renderer only).
- The Automations scheduler (lands with §E3) — the page currently
  shows an empty state only.
- Mobile parity for any of the rebuilt desktop screens.

## Verification

- `turbo run typecheck build --filter=@centraid/desktop
  --filter=@centraid/builder-harness --filter=@centraid/design-tokens`
  — clean
- `oxlint` on the changed renderer / main / harness files — clean
- `oxfmt` applied to all changed `.ts` / `.css` files
- Visual verification in a running Electron window is pending — the
  desktop app needs a gateway/runtime backend; recommend a manual
  `bun run dev:desktop` smoke test, exercising the Builder pane
  toolbar, the editable Code workspace (edit → Save → Diff), the Cloud
  Overview, Settings pages, and the app-view copilot.
