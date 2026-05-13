# issue-26 — Port Bold/Atmospheric redesign to desktop

GitHub issue: [#26](https://github.com/srikanth235/centraid/issues/26)

## Checklist

- [x] Design tokens — Electric Blue accent + variants + semantic tokens
- [x] Design tokens — tunable dark ramp via `--bg-l`
- [x] Design tokens — sidebar surface tokens
- [x] Design tokens — `--icon-*` aliases
- [x] New file `apps/desktop/src/renderer/chrome.ts`
- [x] Codex-shaped sidebar with hybrid contents
- [x] Home rewrite — glass hero, atmospheric cards, status pills, templates strip
- [x] App view rewrite — floating Edit pill in titlebar
- [x] Builder chrome — chrome-only port (chat-with-tool-pills preserved)
- [x] Defaults flip — dark theme + gradient tile variant
- [x] Canonical icon → colour mapping with idempotent enforcement
- [x] `updatedAt` timestamp + "Edited X ago" meta line
- [x] `types.d.ts` extension

## What changed

**Design tokens — Electric Blue accent + variants + semantic tokens.** `packages/design-tokens/themes.ts` retires the legacy `#8B5CF6` purple in favour of `#4950F6` per the redesign brief. Adds `accentLight: #6B72FF`, `accentDeep: #2D34D9`, `accentMidnight: #1A1F8A`, `accentViolet: #7C5BD9` (the legacy purple, kept as sub-accent), plus `success: #5C8A4E` and `danger: #C44A4A`. `Theme` interface gains the six required fields; both `lightTheme` and `darkTheme` carry the same values today. `css.ts` emits `--accent`, `--accent-{deep,light,midnight,violet}`, `--success`, `--danger` in every theme block.

**Design tokens — tunable dark ramp via `--bg-l`.** Dark surfaces (`--bg`, `--bg-elev`, `--bg-sunken`, `--bg-app`) and the `--device-wall` gradient all derive from `hsl(222 11% calc(var(--bg-l) ± n%))` — change one var and the entire ramp re-tunes. Dark default `--bg-l: 18%`. Light theme keeps literal hex (its surfaces aren't HSL-based). `Theme.bgL` is optional; emitted only on dark.

**Design tokens — sidebar surface tokens.** `--sidebar-bg`, `--sidebar-blur`, `--sidebar-divider` added to both themes. Dark sidebar uses `hsl(222 11% calc(var(--bg-l) + 2%) / 0.65)` + `blur(28px) saturate(160%)`; light uses `rgba(255,255,255,0.65)` with the same blur. Used by the new `.cd-sidebar` chrome primitive.

**Design tokens — `--icon-*` aliases.** `css.ts` emits both `--c-rose` (legacy, used throughout renderer + mobile) and `--icon-rose` (matches the redesign spec's `02-chrome-components.css`). Same hex value; only the prefix differs. Cross-codebase portability without churning consumers.

**New file `apps/desktop/src/renderer/chrome.ts`.** Pure builder exposing `window.Chrome.buildWindow(opts)` and `window.Chrome.buildSidebar(opts)`. Inline icon set for chrome glyphs (sidebar, arrows, pencil, folder, plug, history, settings, search, plus, home, star, sparkle). `buildWindow` returns `{ root, setSidebarOpen }` — the setter flips `data-sidebar` so the grid animates 260px → 0 without rebuilding. Traffic-light spacer reserves 52px in whichever strip sits at the window's left edge so the real macOS controls (drawn by Electron at `{x:16, y:16}` because of `titleBarStyle: 'hiddenInset'`) land in clear air. Toolbar buttons (`.cd-tb-btn`) carry hover tooltips with `⌘B` / `⌘[` / `⌘]` / `⌘N` kbd chips.

**Codex-shaped sidebar with hybrid contents.** `buildSidebar` produces: workspace switcher (Personal · centraid.app), live `New app` / `Search` / `Settings`, visible-but-disabled `Plugins` / `Automations` / `Starred` / `Chats` placeholders so the design's information architecture is intact, plus live `Apps` and `Drafts` sections listing the user's tiles with mini icon + status dot. `app.ts` owns the data plumbing; the same builder serves Home and App view. Builder mounts a slimmed-down sidebar (workspace + Settings only) for parity.

**Home rewrite — glass hero, atmospheric cards, status pills, templates strip.** `renderHomeAsync` drops the legacy `.titlebar`/`.home` chrome and renders the cd-window shell instead. Main column carries the device-wall crosshatch backdrop (`has-wall` class) plus a centred 720px `cd-hero-prompt` ("What should we build?" + textarea + Build pill + four suggestion chips: Habit tracker, Daily journal, Pomodoro timer, Hydration). Cmd+Enter submits to `enterBuilder({initialPrompt})`. Below: a `Your apps` section using `cd-app-card` (glass background `color-mix(var(--bg-elev) 70%)`, halo glow tinted by app colour, top-right status pill via `.cd-status-corner`, "Edited X ago" meta line). Templates render as `cd-tmpl-card` horizontal cards.

**App view rewrite — floating Edit pill in titlebar.** `openApp` wraps the running app's iframe in cd-window. Titlebar right slot carries a glass `cd-brand-chip` (mini app icon + name) plus a `cd-edit-pill` (accent-coloured Sparkle + Edit). The running app fills the canvas — no breadcrumb, no internal app-topbar.

**Builder chrome — chrome-only port (chat-with-tool-pills preserved).** `builder.ts` mounts in cd-window; the old `.titlebar` (Centraid / Editing X breadcrumb) is gone. The new app-meta strip below the titlebar carries the back arrow + project icon + inline-editable name/description on the left, history toggle + chat-pane collapse + URL bar on the right. Titlebar right slot holds the Preview/Code/Cloud tabs (rewrapped as `.cd-tabs-pill`) + Share (ghost) + Publish (primary). The chat pane, right pane, preview iframe, code viewer, and cloud rows are untouched — no data-model changes, no preview/publish regressions.

**Defaults flip — dark theme + gradient tile variant.** `DEFAULT_PREFS` now sets `theme: 'dark'` and `tileVariant: 'gradient'` (155° vertical hue darkening per `tile.ts` `gradient` branch). `index.html` boots with `data-theme="dark"` to avoid a light-mode flash.

**Canonical icon → colour mapping with idempotent enforcement.** `CANONICAL_ICON_COLOR_KEY` (Todo→indigo, Habit→rose, Journal→amber, Pomodoro→forest, Water→teal, Plant→slate, Mood/Gift/Sparkle→violet, Spend→ochre) lifted from the design's `bold.jsx` APPS fixture. `colorForIcon(iconKey)` resolves to the hex via `ICON_PALETTE`. `inferAppMeta` and `hydrateDrafts` both use it instead of random selection. A 12-line idempotent block at boot walks `userApps` and overwrites `color` from `iconKey` if drifted — runs every launch, no-op once canonical. No versioned migration (intentional: simpler than `APPEARANCE_SCHEMA_VERSION` plumbing for a pre-launch app).

**`updatedAt` timestamp + "Edited X ago" meta line.** `UserAppMeta` gains an optional ISO timestamp. The same idempotent boot block backfills `Date.now()` if missing. `addUserApp` and `syncUserAppMeta` stamp on every create/republish/rename/description-edit. `relativeTime()` helper (mirrors `builder.ts:relativeWhen`) renders "just now / Xm ago / Xh ago / Xd ago" with a graceful "Recently" fallback. Drafts continue to show "Continue editing" instead — they have no published lineage yet.

**`types.d.ts` extension.** Adds `ChromeApi`, `ChromeBuildWindowOpts`, `ChromeBuildSidebarOpts`, `ChromeSidebarApp` for the new global. `UserAppMeta` gains `updatedAt?: string`. `Window.Chrome` exposes the builder so `app.ts` and `builder.ts` can share it without imports.

## Out of scope

- Replacing the Builder's chat-with-tool-pills with the design's 4-step "timeline of AI steps" (Loaded → Designed layout → Adding dividers → Polishing). Significant data-model change touching how agent events stream into the UI; user opted out (chrome-only).
- Wiring real data behind the sidebar's Plugins / Automations / Chats rows. They're placeholders today; the IA is visible for future work.
- A `preview/components-*.html` gallery in this repo. The design bundle has its own; we don't ship a separate design-system surface.
- Pruning the legacy `.titlebar`, `.home`, `.home-hero`, `.home-grid`, `.app-tile*`, `.app-topbar*` CSS that's now unused. Left in `styles.css` to avoid touching settings sheet / share dialog rules that still reference adjacent selectors. Can be cleaned in a follow-up.

## Verification

- `bun run typecheck` clean across all 10 packages.
- `bun run build` clean — 5 packages, desktop's `tsc` + preload bundle + asset copy all succeed.
- `bun run test` clean — 6 turbo tasks, full cache; 71 tests (`@centraid/openclaw-plugin` 70, `@centraid/agent-harness` 1).
- Smoke-tested `toCss()` output: dark block emits `--bg-l: 18%` followed by HSL surfaces; both themes emit `--accent-*`, `--success`, `--danger`, `--sidebar-*`; palette emits both `--c-*` and `--icon-*`.
- `dist/preload.cjs` confirmed to contain `#4950F6` and not `#8B5CF6`.
- Manual: home, app view, and builder all render under cd-window; sidebar toggles animate to 0; traffic lights + icons sit on the same horizontal line at y=22 of the 44px titlebar.
