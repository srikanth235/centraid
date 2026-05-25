# issue-113 — Multi-profile UX: per-profile display name + avatar, cross-singleton audit, isolation harness

GitHub issue: [#113](https://github.com/srikanth235/centraid/issues/113)

Follow-up to #111+#112. Those issues shipped multi-local-gateway
plumbing (1:1:1 mapping between desktop profile.json, gateway tree,
and the gateway DB's `users` row) and a sidebar-head switcher. #113
finishes the multi-profile framing: profiles gain user-visible
metadata (`displayName`, `avatarColor`), the switcher renders an
avatar disc instead of a kind glyph, user-facing strings rename from
"gateway" to "profile", a cross-singleton audit covers the rest of
`runtime-core` for the same shape of bug that #111 caught in the
analytics-provider cache, and an isolation test harness locks the
audit in.

The audit found one definite leak: `chat-routes.ts` held a
module-level `windowLocks` Map keyed by `${appId}::${windowId}` with
no gateway scoping. Two profiles installing the same template app
would have collided on the same lock and serialised across users.
The map is now owned by the `Runtime` instance and threaded through
`ChatRouteContext`, which makes the scoping per-gateway by
construction.

v0 simplification per the user's note: no profile.json migration —
fields default at read time (`displayName ??= label`, `avatarColor ??=`
deterministic palette pick by id) so existing profiles round-trip
without any code that touches the file in place.

## Checklist

- [x] Cross-singleton audit of `runtime-core` + `openclaw-plugin`
- [x] Fix `windowLocks` cross-gateway leak in `chat-routes.ts`
- [x] Cross-runtime isolation test harness — would fail before #113
- [x] `displayName` + `avatarColor` fields on `GatewayProfile`
- [x] Read-time defaults so existing profiles round-trip
- [x] `updateProfileMetadata` IPC + preload + API decl
- [x] `addLocalGateway` / `addGateway` accept optional metadata
- [x] Sidebar-head row renders avatar disc + displayName
- [x] Switcher popover rows render avatar disc + displayName
- [x] Add-profile form has a color picker (8 swatches)
- [x] Inline rename edits `displayName`, not `label`
- [x] UX rename pass: gateway → profile in user-facing strings

## What changed

### Cross-singleton audit of `runtime-core` + `openclaw-plugin`

Swept `packages/runtime-core/src/` and `packages/openclaw-plugin/src/`
for module-level state that survives a gateway switch. Categories
checked: caches (`Map<string, …>` at module scope), prepared-statement
holders, change buses, codex-home env mutations, in-memory registries.

Findings:

- **Leak:** `chat-routes.ts:98` — `const windowLocks = new Map<…>()`
  at module scope. Keyed by `${appId}::${windowId}` with no gateway
  scoping. Two profiles installing the same template app
  (same `appId`) would share a single lock and serialise chat
  turns across profiles. Fixed (see below).
- **Safe (immutable constants):** `automation-manifest-output.ts`
  (`ALLOWED_PROP_TYPES`), `run-query.ts` (`READ_KEYWORDS`),
  `security.ts` (`STATIC_EXT_ALLOWLIST`, `RESERVED_FILENAMES`,
  `RESERVED_DIRS`), `upload.ts` (`UPLOAD_EXT_ALLOWLIST`,
  `FORBIDDEN_FILES`) — all `const … = new Set([…])` with no gateway
  state.
- **Safe (validator cache):** `manifest.ts:185, 199` — `let sharedAjv`
  / `let manifestValidator`. The Ajv validator caches compiled
  schemas, which are gateway-agnostic.
- **Safe (per-instance):** `change-bus.ts:67` listeners,
  `chat-history.ts:135` per-app cache, `registry.ts:16` cache,
  `user-store.ts:47-48` lazy db handle, `upload-lock.ts` closure
  via `runtime.ts:225` constructor — all instance-level on
  `Runtime` / `Registry` / `ChatHistoryStore` / `UserStore` /
  `ChangeBus`, which are constructed once per gateway.
- **Safe (gateway-keyed):** `automations-host.ts` worker map keyed
  by `(gatewayId, automationId)`, `gateway-store.ts:83`
  `localRuntimeInfo` closure keyed by gatewayId.

Only the chat-routes leak warranted a fix.

### Fix `windowLocks` cross-gateway leak in `chat-routes.ts`

`packages/runtime-core/src/chat-routes.ts` — drop the module-level
`windowLocks` Map; `withWindowLock` now takes the map as a
parameter. `ChatRouteContext` grows a `windowLocks: Map<…>` field
that the call site reads (`handlePostTurn` passes `ctx.windowLocks`).

`packages/runtime-core/src/runtime.ts` — `Runtime` owns
`private readonly chatWindowLocks: Map<string, Promise<void>>` and
threads it into `chatRouteContext()`. Per-instance = per-gateway by
construction.

### Cross-runtime isolation test harness — would fail before #113

`packages/runtime-core/src/chat-routes.test.ts` — new test:
*"windowLocks are per-runtime — two runtimes sharing appId+windowId
do not cross-block (#113)"*. Spins up two `Runtime`s, A and B, each
with their own HTTP server and apps dir. A's chat runner hangs on a
controlled promise; B's resolves instantly. Both register the same
`appId` ('demo') and receive a POST with the same `windowId` ('w1').
B's response is awaited with a 2s timeout — pre-#113 the module-level
map would queue B behind A and the timeout fires; post-#113 the
locks are per-runtime and B completes immediately. Verified by
temporarily reverting the fix on this branch — the test failed with
exactly the expected error message.

### `displayName` + `avatarColor` fields on `GatewayProfile`

`apps/desktop/src/main/gateway-store.ts` — `GatewayProfile` interface
grows two optional fields. New `AVATAR_PALETTE` (8 colors picked for
AA contrast on the dark sidebar) plus `defaultAvatarColor(id)`
(FNV-1a 32-bit hash → palette index, deterministic across launches
so a profile that never sets a color always renders the same one).

### Read-time defaults so existing profiles round-trip

`readProfile` threads `displayName ??= label` and `avatarColor ??=
defaultAvatarColor(id)` so callers always see populated fields. v0
ships no migration — older profile.json files written by #109/#111
parse transparently, just without persisted metadata until the user
edits.

### `addLocalGateway` / `addGateway` accept optional metadata

Both factory functions now take optional `displayName` and
`avatarColor` inputs. `displayName` falls back to `label` when blank
or absent; `avatarColor` falls back to the deterministic palette
pick when blank/invalid (`isValidAvatarColor` enforces `#RRGGBB`).
`AddGatewayInput` interface extended; the local-add input grows the
same shape.

### `updateProfileMetadata` IPC + preload + API decl

`apps/desktop/src/main/gateway-store.ts` exports
`updateProfileMetadata(id, patch)` — patches `displayName` and/or
`avatarColor` in place; rejects invalid colors with
`'invalid_input'`; treats empty `displayName` as a reset to the
label-derived default. The label itself is immutable post-creation
through this path (renameGateway still covers explicit label
changes for callers that want them).

`apps/desktop/src/main/ipc.ts` — new `GATEWAYS_UPDATE_METADATA` IPC
channel; handler calls `updateProfileMetadata` and broadcasts the
gateway-changed event so the sidebar re-renders.
`broadcastGatewayChanged` payload grows `activeProfileDisplayName`
+ `activeProfileAvatarColor` fields. The two `addGateway` and
`addLocalGateway` handlers accept the new optional fields.

`apps/desktop/src/main/settings.ts` — `DesktopSettings` interface
grows `activeProfileDisplayName` + `activeProfileAvatarColor`,
derived in `resolveEffective` from the active gateway's profile.

`apps/desktop/src/preload.ts` — `updateProfileMetadata` bridge;
`addLocalGateway` / `addGateway` accept the new optional fields;
`onGatewayChanged` callback type carries the new payload fields.

`apps/desktop/src/renderer/centraid-api.d.ts` —
`CentraidSettings.activeProfileDisplayName` +
`activeProfileAvatarColor`; `CentraidGatewayProfile.displayName` +
`avatarColor` (typed non-optional because read-time defaults always
populate them); `addGateway` / `addLocalGateway` /
`updateProfileMetadata` shapes added; `onGatewayChanged` payload
shape updated.

### Sidebar-head row renders avatar disc + displayName

`apps/desktop/src/renderer/chrome.ts` — new `profileAvatar(displayName,
avatarColor, size)` helper draws a colored disc with 1–2 initials
from the display name. Replaces `Glyph.gatewayLocal()` /
`Glyph.gatewayRemote()` in the sidebar-head row. Kind classification
(local vs remote) is preserved in the trailing `kindPill` so the
user still has a kind affordance — it just moves from icon to text.
`SidebarOpts.gateway` extended with `activeDisplayName` +
`activeAvatarColor`; the app.ts `currentGateway` cache reads them
off `getSettings()`'s new derived fields.

`apps/desktop/src/renderer/styles.css` — new `.cd-gw-avatar` rule:
flex inline disc, inline-styled background from `avatarColor`,
white-on-color initials at ~50% font size, subtle inset shadow so
the disc reads as a tile even when the color is close to the
background.

### Switcher popover rows render avatar disc + displayName

Same `profileAvatar` helper is reused in the popover at 18px (vs
20px in the sidebar). Each row's label span renders
`p.displayName`, not `p.label`. `SwitcherOpts.profiles[number]`
grows `displayName` + `avatarColor`; app.ts maps both off
`CentraidGatewayProfile`. Empty-state copy renames from
"workspaces"/"remote gateways yet" to "profiles".

### Add-profile form has a color picker (8 swatches)

`buildColorPicker(initial)` factory shared between the add-local
and add-remote forms — emits a row of 8 round swatches matching
the gateway-store palette. Initial selection is randomised so two
adds in a row don't both start on the same color. Selected swatch
gets a 2px ring (drawn via `box-shadow`) and a slight scale on
hover. The submit handler reads the current pick and threads it
into the new `onAddLocal({ label, avatarColor })` /
`onAddRemote({ label, url, token, avatarColor })` signatures.
CSS: `.cd-gw-pop-colors` row + `.cd-gw-pop-swatch` disc.

### Inline rename edits `displayName`, not `label`

The switcher's inline rename input now displays + edits
`p.displayName` (the user-visible name). `onRename` callback's
parameter renamed `nextDisplayName`; app.ts wires it to
`updateProfileMetadata({ id, displayName })` instead of
`renameGateway({ id, label })`. The technical `label` is treated
as a stable creation-time string post-create — users only ever
see/edit `displayName`. `ChromeGatewaySwitcherOpts` in
`types.d.ts` updated to match.

### UX rename pass: gateway → profile in user-facing strings

Code identifiers stay (`gatewayId`, `GatewayProfile`, `gateways:add`
IPC, `cd-sb-gw-row` CSS class…). User-facing strings only:

- Sidebar-head aria-label: "Active gateway:" → "Active profile:".
- Switcher "+" aria-labels: "New local workspace" → "Add local
  profile", "Add remote gateway" → "Add remote profile".
- Form headers: "NEW LOCAL WORKSPACE" → "NEW LOCAL PROFILE", "ADD
  REMOTE GATEWAY" → "ADD REMOTE PROFILE".
- Placeholders: "Workspace name" / "Label (e.g. Centraid Cloud)" →
  "Profile name" / "Profile name (e.g. Centraid Cloud)".
- Empty state: "No additional workspaces" / "No remote gateways yet"
  → "No additional profiles" / "No remote profiles yet".
- Remove-confirm: "Remove local workspace …" / "Remove gateway …" →
  "Remove profile …".
- Toasts: "Local workspace X created" / "Gateway X added" / "Gateway
  removed" / "Switched to <label>" → "Profile X created" / "Profile
  X added" / "Profile removed" / "Switched to <displayName>".
- Settings panel: `drawerGroup('Gateways', …)` → "Profiles"; button
  "Open gateway switcher" → "Open profile switcher"; note copy
  rewritten.
- `gateway-store.ts` error message: "The primordial local gateway
  cannot be removed." → "The default local profile cannot be
  removed."

## Out of scope

- Concurrent foreground local runtimes. Today: sequential
  (`shutdownAllLocalRuntimesExcept` runs on switch). Automations
  keep firing via the OS scheduler regardless — that's enough for v0.
- Crash isolation via child-process-per-runtime.
- `display_name` column on the gateway DB's `users` table. v0 keeps
  displayName in `profile.json` only — no migration, runtime never
  needs the name.
- profile.json migration. v0, read-time defaults handle the existing
  shape transparently.
- Sharing apps across profiles. Each profile has its own apps tree;
  installing the same template into two profiles produces two
  unrelated copies.

## Verification

- `bun run --cwd packages/runtime-core test` → 330/330 pass (the new
  isolation test is #35).
- Reverted the windowLocks fix locally to confirm the test catches
  the regression: failed with "B timed out — windowLocks leaked
  across runtimes". Restored, all tests pass again.
- `bun run --cwd apps/desktop typecheck` → clean across all three
  commits in this series.
- `bun run test` (turbo) → 6 packages pass; the 12 pre-existing
  agent-runtime failures reproduce on `origin/main` and are
  unrelated to #113.
