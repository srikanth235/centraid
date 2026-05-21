# issue-88 — Add the Insights usage-analytics page

GitHub issue: [#88](https://github.com/srikanth235/centraid/issues/88)

The desktop shell had no surface for usage analytics. This adds an
**Insights** page to the sidebar Pages section (between Home and
Discover) — a token-consumption / spend dashboard modelled on n8n- and
Vercel-style analytics screens.

## Checklist

- [x] Sidebar — add Insights item with an Activity icon
- [x] Routing — insights ShellRoute, nav stack, openInsights
- [x] Page — KPI strip, chart, by-app table, by-model and activity panels
- [x] CSS — cd-ins styles and narrow-window fallback

## What changed

**Sidebar — add Insights item with an Activity icon.** `chrome.ts
buildSidebar` renders an Insights `sbItem` after Home, using the new
`Activity` line-chart icon. `SidebarPage` (in `chrome.ts` and
`types.d.ts`) gains an `insights` member, and the `onInsights` handler
is threaded through `ChromeBuildSidebarOpts`. `Activity`, `ChevronDown`,
and `Coin` icons were added to `@centraid/design-tokens`.

**Routing — insights ShellRoute, nav stack, openInsights.** The
`ShellRoute` union in `app.ts` gains an `insights` member; `applyRoute`,
`routeKey`, and `recordRoute` handle it so back/forward navigation
works. `buildHomeSidebar` passes `onInsights: renderInsights`, and
`window.openInsights` is exposed on the `CentraidRoot` API.

**Page — KPI strip, chart, by-app table, by-model and activity panels.**
`renderInsights()` builds a KPI strip (tokens, spend, forecast, apps
touched, generations), a daily-consumption panel with an inline SVG
line chart + peak marker, a by-app table with 14-day SVG sparklines /
mix bars / delta chips, and by-model and recent-activity panels. The
shell has no usage-metering backend yet, so the figures are a
representative synthetic snapshot — the layout is built to bind to real
data later.

**CSS — cd-ins styles and narrow-window fallback.** A `.cd-ins-*` block
in `styles.css` styles the header, KPI cards, panels, chart, table, and
lists, plus a `max-width: 1080px` media query that stacks the KPI strip
and two-column grid on narrow windows.

This commit also folds in earlier session work: app-view routing for
sidebar app rows, left-aligned app-view title, `ArrowRight` composer
icon, rich home-shelf empty states, a touching-highlight spacing fix,
the n8n-style Automations executions master/detail view, a
`runAutomationNow` manual-trigger label fix, and the codex `ctx.agent`
dispatcher fixes (flags, stdin-hang, output-schema normalization).

## Out of scope

- A real usage-metering backend (tracked by #61 telemetry store).
- Mobile renderer (desktop only).
- Wiring the filter chips — they render as display-only for now.

## Verification

- `tsc -p apps/desktop/tsconfig.json` — clean.
- `oxfmt` — clean on changed files.
- Visual check in a running Electron window: the Insights page renders
  the header, KPI strip, chart, and all four panels; the sidebar item
  highlights when active.
