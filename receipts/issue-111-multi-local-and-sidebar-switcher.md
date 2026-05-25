# issue-111 — Multi-local gateways + sidebar-head gateway switcher

GitHub issue: [#111](https://github.com/srikanth235/centraid/issues/111)

Follow-up to #109. That issue ruled out multiple local gateways ("one
machine = one local runtime") but the abstraction it shipped already
treats `GatewayProfile` uniformly across local + remote — uniform
record shape, per-id path helpers, per-id keychain slots. The only
thing pinning "one local" was `local-runtime.ts` (module-level
singletons + hardcoded `LOCAL_GATEWAY_ID`). #111 finishes the multi-
gateway picture by lifting that ceiling AND promoting the switcher
from Settings → Runtime to a sidebar-head row + ⌘⇧G popover.

The primordial `'local'` gateway stays. It's auto-created on boot,
labelled "My computer", and cannot be removed. Additional local
gateways are pure UUID-id profiles created via the popover's "New
local workspace" affordance. Switching to a different local starts
its in-process HTTP runtime on demand and tears down the previously
active local's HTTP server so we don't accumulate dormant ports
across switches. The OS scheduler is unaffected — automations shell
the CLI against per-gateway DB paths baked into each scheduler entry
at register time, so a non-active local's automations keep firing.

## Checklist

- [x] Local-runtime keyed by gatewayId
- [x] Per-gateway info provider in gateway-store
- [x] Shutdown stale local runtimes on switch
- [x] addLocalGateway in gateway-store
- [x] removeGateway relaxed for non-primordial locals
- [x] Per-gateway analytics-provider cache in ipc.ts
- [x] GATEWAYS_ADD_LOCAL IPC + preload + API decl
- [x] Sidebar-head switcher row
- [x] Gateway switcher popover
- [x] Cmd-Shift-G keyboard shortcut
- [x] Settings panel collapsed to deep-link

## What changed

### Local-runtime keyed by gatewayId

`apps/desktop/src/main/local-runtime.ts` — the four module-level
singletons (`handle`, `starting`, `_automationHost`, plus the
implicit "the local gateway" assumption baked into every function
signature) become `Map<gatewayId, …>`. Every exported function takes
`gatewayId`: `ensureLocalRuntime`, `localRuntimeAppsDir`,
`localRuntimeAnalyticsDb`, `localRuntimeAutomationHost`,
`localRuntimeCodexHomeBaseDir`, `localRuntimeGatewayDb`.

### Per-gateway info provider in gateway-store

The `setLocalRuntimeInfoProvider` callback in `gateway-store.ts`
changes signature from `() => info` to
`(gatewayId: string) => info | undefined`. Local-runtime registers
the provider once on module first use with a closure that reads the
handles map at lookup time, so spinning up a second local doesn't
require re-registering. `resolveGateway()` passes the profile's id
through.

### Shutdown stale local runtimes on switch

New `shutdownAllLocalRuntimesExcept(activeId)` in `local-runtime.ts`
is called by the `GATEWAYS_SET_ACTIVE` handler in `ipc.ts` after
the pointer flips. Only the active local's runtime stays up;
OS-scheduled automations from other locals keep firing because the
scheduler shells the CLI against per-gateway DB paths baked into each
scheduler entry at register time.

### addLocalGateway in gateway-store

`addLocalGateway({ label })` in `gateway-store.ts` mints a UUID,
writes `profile.json` with `kind: 'local'`, creates the per-gateway
`workspace/` and `apps/` dirs. Doesn't start the runtime —
`ensureLocalRuntime(id)` does that on first activation. The
primordial `'local'` gateway is still auto-created on boot; this
function is purely additive.

### removeGateway relaxed for non-primordial locals

`removeGateway()` in `gateway-store.ts` relaxes its old "no local
gateway can be removed" rule to "the primordial `'local'` cannot be
removed" — additional locals (UUID-id, created via `addLocalGateway`)
can be removed freely. Best-effort token clear is a no-op for local
ids (they have no keychain entry).

### Per-gateway analytics-provider cache in ipc.ts

The previous module-local `getAnalyticsProvider()` cache in `ipc.ts`
pinned the FIRST analytics DB it saw, which broke silently across
switches. It's now a per-gateway `Map<gatewayId, DatabaseProvider>`
and the four call sites (`AUTOMATIONS_RUN_NOW`, `AUTOMATIONS_DELETE`,
`AUTOMATIONS_LIST_RUNS`, `AUTOMATIONS_PIN_RUN`, `INSIGHTS_SUMMARY`)
each load settings and pass `settings.activeGatewayId` through. Same
treatment for every `localRuntime*()` call site.

### GATEWAYS_ADD_LOCAL IPC + preload + API decl

New `Channel.GATEWAYS_ADD_LOCAL` in `ipc.ts` with a handler that
wraps `addLocalGateway()`. `apps/desktop/src/preload.ts` adds the
matching bridge; `centraid-api.d.ts` adds the typed entry on
`CentraidApi`. The previously single `removeGateway` doc-comment is
updated to reflect the new "primordial-only" refusal rule.

### Sidebar-head switcher row

`chrome.ts` adds new `gatewayLocal` / `gatewayRemote` Glyph entries
(filled square for local in success-green, hollow-with-dot square
for remote in accent) and renders a new row at the top of the
sidebar above "Build new" when the caller passes a `gateway`
summary in `SidebarOpts`. The row carries a kind glyph in a tinted
tile, the label, a mono-caps kind tag (LOCAL / REMOTE), and a
chevron-down meta. A 1px divider below it separates gateway-scope
from page-scope. `types.d.ts` grows `ChromeSidebarGateway`,
`ChromeGatewayProfile`, `ChromeGatewaySwitcherOpts`, and
`onOpenGatewaySwitcher` on `ChromeBuildSidebarOpts`.

### Gateway switcher popover

`window.Chrome.openGatewaySwitcher(opts)` in `chrome.ts` builds a
popover anchored to the row's bottom edge. The popover reuses
`cd-sb-section` mono-caps headers and `cd-sb-item`-shaped profile
rows so it reads as a vertical extension of the sidebar, not a
floating tooltip. Each section header has a `+` that reveals an
inline form (single name input for local; label/url/token for
remote). Each profile row hover-reveals rename (pencil) and remove
(trash) buttons; the primordial `'local'` hides remove. Active
rows wear an `● ACTIVE` mono-caps pill; hovering an active row
overlays the action cluster on top of the pill so rename remains
reachable. Styles live in `styles.css` under `.cd-sb-gw-*` and
`.cd-gw-pop-*`.

### Cmd-Shift-G keyboard shortcut

`app.ts` adds a `⌘⇧G` (`Cmd`/`Ctrl`+`Shift`+`G`) keydown handler
that opens the switcher. It anchors to the sidebar row's screen
rect when present, falling back to a top-left point so the
shortcut keeps working when the sidebar is collapsed.

### Settings panel collapsed to deep-link

The previous Settings → Runtime gateway panel (~180 lines of inline
list + rename inputs + add form across two `drawerGroup`s)
collapses to a single `drawerGroup('Gateways', …)` with a short
note and one "Open gateway switcher" button. The button reuses the
same `openGatewaySwitcher(anchor)` helper the sidebar row and
keyboard shortcut use, so there's exactly one lifecycle UI.

## Out of scope

- "Show me runs across all my gateways" Insights view — analytics
  stay scoped to the active gateway, same as #109.
- Cross-local automation discovery in the UI; automations remain
  scoped to the active local even though OS-scheduled fires from
  other locals still write to their own per-gateway DB.
- Auto-activation when adding a new local workspace — the popover
  closes after create; the user re-opens it to switch.
- Per-gateway icon / avatar / theme. v0 has just a label.
- Renderer-side automated tests for the switcher popover. The
  `apps/desktop` package has only Playwright e2e; adding `node:test`
  infra for renderer-side interaction tests is its own work.

## Verification

Local pipeline green:

- `bun run typecheck` — 16 turbo tasks, no errors.
- `bun run build` — clean.
- `bun run test` — 32/32 pass (builder-harness suite; the modules
  touched here are exercised end-to-end at boot and don't have unit
  tests of their own).
- `bun run format:check` — clean.

Manual smoke (deferred to a follow-up session in a fresh worktree):

1. Boot a fresh desktop install. Confirm the sidebar shows a new
   head row above "Build new" with the filled kind mark, "My
   computer" label, and LOCAL tag.
2. Click the row. Popover opens with LOCAL and REMOTE sections.
   The "My computer" row shows ● ACTIVE.
3. Click `+` on LOCAL, type "Scratch", press Enter. New row
   appears under LOCAL on re-open.
4. Activate "Scratch". Sidebar head row updates; apps list flips
   to the new (empty) workspace.
5. Add a remote via `+` on REMOTE. Hover its row → trash button
   appears. Remove it. Confirm dialog → row disappears.
6. Confirm the primordial "My computer" row has NO trash button
   (only rename).
7. Inline-rename "My computer" via the pencil. Sidebar head row
   label updates after save.
8. Press ⌘⇧G with sidebar collapsed. Popover still opens at
   top-left.
9. Settings → Runtime → "Open gateway switcher" → same popover
   opens.

## Aesthetic notes

The head row is deliberately understated — no accent tint, no bold
weight, just the kind mark + label + small mono-caps kind tag. Its
*position* (above Build new) carries the weight, not visual
loudness. This is a context selector, not a destination.

Kind marks read as a paired vocabulary the way `sidebarOpen` /
`sidebarClosed` do — same square hull, different interior — so the
eye registers the kind change without re-parsing the icon. Local
wears `--success` (green) and remote wears `--accent`; the tile
background is a low-opacity wash of the same color so the mark
reads against a tinted chip, not a plain neutral square.

The popover deliberately reuses sidebar primitives: section headers
in mono-caps, profile rows shaped like `cd-sb-item`, the ACTIVE
tag is a regular `cd-status` pill. The only popover-specific
primitives are the elevation envelope, the hover-revealed action
cluster, and the inline add-forms.
