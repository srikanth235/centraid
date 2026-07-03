# issue-263 — Mobile ↔ desktop bridge: published apps open on the phone

GitHub issue: [#263](https://github.com/srikanth235/centraid/issues/263)

Mobile was frozen at the three-tool-dispatcher era (#107–110) with three
independent P0 breaks: pairing was impossible, the asset-inliner could not
load ES-module apps, and the injected `EventSource('_changes')` bridge never
authenticated. All three shared one root cause — header-only bearer auth vs.
a WebView that cannot attach headers to subresources, module imports, or
EventSource — so the fix is one transport: HTTP tunneled over iroh p2p QUIC
(the dumbpipe pattern). The phone runs a localhost proxy; the desktop
forwards to its loopback gateway with the bearer attached. Zero gateway HTTP
changes; the gateway keeps binding 127.0.0.1 and is never network-exposed.

## Checklist

- [x] Phase 0 — the pipe validated under Node, Bun, and Electron main
- [x] Phase 1 — packages/tunnel: endpoint, allowlist, pairing, forwarding
- [x] Phase 1 — desktop phone link + Settings Phone panel
- [x] Phase 2 — mobile native tunnel module (Swift + Kotlin)
- [x] Phase 2 — mobile viewer rewrite over the tunnel
- [x] Phase 3 — tile parity at the source
- [x] Phase 3 — kit haptics + builder generation rules
- [x] Phase 3 — mobile Approvals screen
- [x] Phase 3 — Maestro per-template gate

## What changed

### Phase 0 — the pipe validated under Node, Bun, and Electron main

- `packages/tunnel/scripts/spike-pipe.mjs` — the spike CLI: `--local` runs
  the whole loop on one machine (demo gateway + desktop tunnel + phone-side
  localhost proxy); `--serve` / `--dial <payload>` split the roles across
  two machines. Validated the architecture end-to-end before any native
  work: ES-module chains, POST bodies, concurrent streams, and SSE arriving
  incrementally, under Node 22, Bun, and the Electron 37 main process
  (`@number0/iroh` NAPI binding confirmed in all three). Pinned iroh-js EOF
  semantics: stream FIN is an empty `read()`.

### Phase 1 — packages/tunnel: endpoint, allowlist, pairing, forwarding

New workspace package `@centraid/tunnel` (registered in `vitest.config.ts`
projects and `scripts/lint-types.sh` targets; dep `@number0/iroh@1.0.0` in
`packages/tunnel/package.json`, lockfile `bun.lock`):

- `packages/tunnel/src/protocol.ts` — wire protocol v1: ALPNs
  `centraid/tunnel/1` + `centraid/pair/1`; header frame = u32 BE length +
  UTF-8 JSON; one bi-stream per HTTP request (request header + body then
  FIN; response header + **streamed** body then FIN — SSE stays live);
  hop-by-hop header stripping; the pairing QR payload
  `{v:1, kind:'centraid-pair', ticket, code}`. The executable reference for
  the Swift/Kotlin ports.
- `packages/tunnel/src/device-store.ts` — the device-key allowlist:
  named, platform-tagged devices keyed by iroh EndpointId (ed25519 pubkey),
  persisted as JSON (0600, atomic rename), re-pair replaces, revocable.
- `packages/tunnel/src/desktop-tunnel.ts` — the desktop side: one endpoint,
  two ALPNs; tunnel connections admitted only for allowlisted EndpointIds
  (refused with QUIC code 401, re-checked per stream so revocation bites
  live connections); pairing = one-time code (timing-safe compare, 10-min
  TTL, consumed on success); every forwarded request gets the gateway
  bearer attached and `host` overridden; upstream resolved per request (sync
  or async) so the tunnel follows gateway restarts/switches; 502/503 error
  frames.
- `packages/tunnel/src/client.ts` — the phone side in TypeScript: pair,
  dial, per-request streams, and `startLocalProxy` (the localhost HTTP
  proxy). Reference implementation for the native module + powers the tests
  and spike.
- `packages/tunnel/src/iroh.ts` — typed loader for the NAPI binding
  (iroh-js 1.0.0 publishes broken `main`/`types` fields; deep-path require +
  our own types keep runtime and typecheck deterministic).
- `packages/tunnel/src/index.ts`, `packages/tunnel/tsconfig.json`,
  `packages/tunnel/tsconfig.test.json`, `packages/tunnel/vitest.config.ts`,
  `packages/tunnel/README.md` (protocol + auth-model documentation).
- `packages/tunnel/src/tunnel.test.ts` — 8 integration tests over real
  endpoints (relays disabled, offline): store persistence/replace/revoke +
  name sanitizing, unpaired refusal, wrong/one-time pairing codes,
  GET/POST/concurrency through the proxy, incremental SSE, live revocation,
  503 without a gateway.

### Phase 1 — desktop phone link + Settings Phone panel

- `apps/desktop/src/main/phone-link.ts` — main-process module: persistent
  endpoint key (`<userData>/phone-link/key.bin`, so the desktop's dial
  identity is stable across launches) + `devices.json` allowlist; starts on
  app ready so paired phones reconnect with no UI open; upstream = the
  active gateway when local (remote-active answers 503); QR minted as a PNG
  data URL (`qrcode` dep in `apps/desktop/package.json`); pairing
  completion broadcast to all windows.
- `apps/desktop/src/main/ipc.ts` + `apps/desktop/src/preload.ts` +
  `apps/desktop/src/renderer/centraid-api.d.ts` — four IPC handlers
  (status, begin/cancel pairing, revoke) + the `PHONE_PAIRED` event.
- `apps/desktop/src/main.ts` — `ensurePhoneLink()` on ready (failures
  surface in the panel, never block launch).
- `apps/desktop/src/renderer/app-phone.ts` — the Settings → Phone page:
  "Connect a phone" mints the one-time QR (flips to paired on the
  broadcast), paired-device list with per-device transport-level Revoke.
  Wired as a new page in `apps/desktop/src/renderer/app-settings.ts`
  (SettingsPageId `phone`, Account section, Phone icon); styles in
  `apps/desktop/src/renderer/styles.css`.

### Phase 2 — mobile native tunnel module (Swift + Kotlin)

Expo local module `apps/mobile/modules/centraid-tunnel/` (autolinked via
the app's existing expo-modules setup):

- `apps/mobile/modules/centraid-tunnel/index.ts` — the JS contract:
  `isTunnelAvailable` / `generateSecretKey` / `pairWithDesktop` /
  `startTunnel` / `stopTunnel` / `getTunnelStatus` /
  `addTunnelStatusListener`; degrades gracefully in Expo Go
  (`requireOptionalNativeModule`).
- iOS — Expo Swift DSL module + actor-based state machine; NWListener bound
  to 127.0.0.1 only; one bi-stream per request, per-chunk flush (live SSE),
  `connection: close` semantics; lazy redial on dead connections; all
  IrohLib touchpoints isolated in one adapter section:
  `apps/mobile/modules/centraid-tunnel/ios/CentraidTunnelModule.swift`,
  `apps/mobile/modules/centraid-tunnel/ios/TunnelWire.swift`,
  `apps/mobile/modules/centraid-tunnel/ios/TunnelProxy.swift`,
  `apps/mobile/modules/centraid-tunnel/ios/HttpParser.swift`,
  `apps/mobile/modules/centraid-tunnel/ios/CentraidTunnel.podspec`.
- Android — mirror implementation over ServerSocket + coroutines:
  `apps/mobile/modules/centraid-tunnel/android/build.gradle`,
  `apps/mobile/modules/centraid-tunnel/android/src/main/java/expo/modules/centraidtunnel/CentraidTunnelModule.kt`,
  `apps/mobile/modules/centraid-tunnel/android/src/main/java/expo/modules/centraidtunnel/TunnelRuntime.kt`,
  `apps/mobile/modules/centraid-tunnel/android/src/main/java/expo/modules/centraidtunnel/TunnelWire.kt`,
  `apps/mobile/modules/centraid-tunnel/android/src/main/java/expo/modules/centraidtunnel/TunnelProxy.kt`,
  `apps/mobile/modules/centraid-tunnel/android/src/main/java/expo/modules/centraidtunnel/HttpParser.kt`.
- `apps/mobile/modules/centraid-tunnel/expo-module.config.json` +
  `apps/mobile/modules/centraid-tunnel/README.md` (dev-build requirement,
  binding-vendoring caveat). Framing stays byte-for-byte in lockstep with
  `packages/tunnel/src/protocol.ts`. Not compiled in this session — see
  Verification.

### Phase 2 — mobile viewer rewrite over the tunnel

- `apps/mobile/src/lib/phone-link.ts` — pairing state + tunnel lifecycle:
  QR parse (local mirror of `parsePairQrPayload`), device key generated
  once and reused (stable EndpointId across re-pairs), start-dedupe,
  status subscription. Storage keys `phoneLink.{ticket,desktopName,deviceId,secretKey}`.
- `apps/mobile/src/lib/gateway.ts` — rewritten: base-URL resolution is
  tunnel-first, manual URL (Settings → Advanced) as the dev fallback; the
  stale pre-git-store `AppRegistryRow` (`path`/`mode`/`registeredAt`)
  replaced with the real listing shape
  `{id, name?, description?, kind?, hasIndex, iconKey?, colorKey?}`;
  home grid filtering (`hasIndex === false` and `kind === 'automation'`
  rows never render as tiles); `resolveAppMeta` prefers real
  name/description/iconKey/colorKey (validated against design-tokens)
  before the legacy title-case/hash fallbacks; `listParked`/`confirmParked`
  typed against the vault plane.
- `apps/mobile/src/lib/asset-inliner.ts` **deleted**;
  `apps/mobile/src/lib/bridge/injected.ts` — fetch shim + origin patching
  removed (the gateway-injected SDK and the native bridge coexist on
  `window.centraid`); `apps/mobile/src/lib/bridge/dispatch.ts` +
  `apps/mobile/src/lib/bridge/protocol.ts` — `gateway.fetch` removed;
  notify/haptic/timer kept.
- `apps/mobile/src/screens/AppDetail.tsx` — WebView loads
  `<base>/centraid/<id>/` directly (tunnel first); no inlining, no header
  tricks.
- `apps/mobile/src/screens/Settings.tsx` — "Desktop link" section: pair via
  expo-camera QR scan, paired card with desktop name + live tunnel status +
  Unpair, Expo Go note; manual URL/token demoted to "Advanced (developer)".
  Deps/permissions: `apps/mobile/package.json` (expo-camera),
  `apps/mobile/app.json` (plugin + permission string),
  `apps/mobile/ios/Centraid/Info.plist` (NSCameraUsageDescription),
  `apps/mobile/android/app/src/main/AndroidManifest.xml` (CAMERA).
- `apps/mobile/src/screens/Home.tsx` — real names/descriptions/icons from
  the listing; pairing-first empty state; Approvals entry in the header.
- `apps/mobile/App.tsx` + `apps/mobile/src/navigation.ts` — Approvals route.

### Phase 3 — tile parity at the source

- `packages/blueprints/src/scaffold-files.ts` — scaffolded `app.json` now
  carries `iconKey`/`colorKey` (opts with `Sparkle`/`violet` defaults);
  tests in `packages/blueprints/src/scaffold-files.test.ts`.
- `packages/blueprints/src/app-rewrites.ts` — `applyAppVisualIdentity`
  (pure) + `stampAppVisualIdentity` (fs wrapper), app.json-declared keys
  win; tests in `packages/blueprints/src/app-rewrites.test.ts` (new).
- `packages/blueprints/src/clone.ts` — both clone paths backfill the
  template's visual identity; tests in `packages/blueprints/src/clone.test.ts`.
- The 14 template manifests stamped to match `index.json`:
  `packages/blueprints/apps/agenda/app.json`,
  `packages/blueprints/apps/bookings/app.json`,
  `packages/blueprints/apps/budgets/app.json`,
  `packages/blueprints/apps/docs/app.json`,
  `packages/blueprints/apps/home-inventory/app.json`,
  `packages/blueprints/apps/leads/app.json`,
  `packages/blueprints/apps/notes/app.json`,
  `packages/blueprints/apps/people/app.json`,
  `packages/blueprints/apps/photos/app.json`,
  `packages/blueprints/apps/studio/app.json`,
  `packages/blueprints/apps/subscriptions/app.json`,
  `packages/blueprints/apps/tasks/app.json`,
  `packages/blueprints/apps/threads/app.json`,
  `packages/blueprints/apps/vitals/app.json`
  (`packages/blueprints/manifest.json` regenerated via the script —
  byte-identical, so no diff).
- `packages/gateway/src/worktree-store/worktree-store.ts` —
  `listAppsWithMeta` rows gain `iconKey?`/`colorKey?`;
  `packages/gateway/src/routes/apps-store-routes.ts` (docs),
  `packages/gateway/src/routes/lifecycle-routes.ts` — scaffold accepts the
  keys, `_clone` stamps the template's. Tests:
  `packages/gateway/src/routes/apps-store-routes.test.ts`,
  `packages/gateway/src/lifecycle/lifecycle-over-http.test.ts`,
  `packages/gateway/src/lifecycle/clone-over-http.test.ts`.
- Desktop drops the UserAppMeta shim for visual identity:
  `apps/desktop/src/renderer/app-format.ts` (`tileVisualFromListing`,
  `inferAppVisual`), `apps/desktop/src/renderer/app-cards.ts` (no hardcoded
  violet), `apps/desktop/src/renderer/app.ts` (published-tile visuals
  resolved from the listing rows), `apps/desktop/src/renderer/builder.ts` +
  `apps/desktop/src/renderer/gateway-client.ts` +
  `apps/desktop/src/renderer/gateway-client-editing.ts` (create/scaffold
  passes the inferred keys through so app.json carries the same identity
  the tile shows). `home.userApps` still owns drafts/ordering.

### Phase 3 — kit haptics + builder generation rules

- `packages/blueprints/kit/kit.js` — feature-detected best-effort
  `haptic()`: `toast()` fires `haptic.success`, `armConfirm()` fires
  `haptic.selection` on arm; identical behavior in the desktop iframe
  (bridge absent → no-op). Synced via `sync-kit.mjs` to every template:
  `packages/blueprints/apps/agenda/kit.js`,
  `packages/blueprints/apps/bookings/kit.js`,
  `packages/blueprints/apps/budgets/kit.js`,
  `packages/blueprints/apps/docs/kit.js`,
  `packages/blueprints/apps/home-inventory/kit.js`,
  `packages/blueprints/apps/leads/kit.js`,
  `packages/blueprints/apps/notes/kit.js`,
  `packages/blueprints/apps/people/kit.js`,
  `packages/blueprints/apps/photos/kit.js`,
  `packages/blueprints/apps/studio/kit.js`,
  `packages/blueprints/apps/subscriptions/kit.js`,
  `packages/blueprints/apps/tasks/kit.js`,
  `packages/blueprints/apps/threads/kit.js`,
  `packages/blueprints/apps/vitals/kit.js`.
- `packages/skills/src/ui-grounding.ts` — "Phone-readiness" rule in the UX
  rules block spliced into every builder-agent system prompt: keep the kit,
  keep the scaffold's responsive conventions (viewport-fit=cover, safe-area
  insets, 720px breakpoint, ≥44px targets, reduced motion).
  `packages/blueprints/src/scaffold-defaults.ts` — same section added to
  the scaffolded per-app README template.

### Phase 3 — mobile Approvals screen

- `apps/mobile/src/screens/Approvals.tsx` — parked vault invocations over
  `GET /centraid/_vault/parked` with Approve/Deny via
  `POST /centraid/_vault/parked/<invocationId>`; pull-to-refresh, empty and
  error states. Closes the "parked" dead-end: vault-backed apps toast
  "waiting for your approval" and mobile now has somewhere to go.

### Phase 3 — Maestro per-template gate

- `tests/agent-e2e-mobile/flows/template-gate.md` +
  `tests/agent-e2e-mobile/flows/template-gate.mjs` — for each bundled UI
  template: clone via `POST /centraid/_apps/_clone`, publish, open its Home
  tile on the phone, wait for the app's header inside the WebView,
  screenshot, collect per-template verdicts, clean up clones.
- `tests/agent-e2e-mobile/flows/home-loads.md` +
  `tests/agent-e2e-mobile/flows/home-loads.mjs` — updated for the
  pairing-first empty-state copy.

## Decisions

- **Iroh over LAN** per the issue's revision: QR carries
  `{ticket, code}`, auth is a device-key (EndpointId) allowlist at the
  transport, the gateway HTTP surface is untouched and never leaves
  loopback. The LAN plan survives only as the issue's documented fallback.
- **One bi-stream per HTTP request** (not a muxed single stream): QUIC
  already multiplexes, per-request streams give free concurrency +
  cancellation, and SSE is just a response stream that stays open.
- **Request bodies buffer (32 MiB cap), responses stream.** Tool payloads
  are small JSON in v0; media-heavy uploads are the issue's stated later
  optimization (iroh-blobs).
- **The phone never holds a gateway bearer.** The desktop attaches it
  server-side; revocation is transport-level and immediate (live
  connections dropped, per-stream allowlist re-check).
- **Pairing codes are one-time** (consumed on first success, 10-minute
  TTL, timing-safe compare); the desktop's endpoint key persists so the
  paired ticket stays valid across relaunches; the phone's device key
  persists so re-pairs keep the same EndpointId.
- **Manual URL/token stays as "Advanced (developer)"** on mobile — the
  simulator-against-dev-gateway path; docs in-code note that an authed
  gateway needs the tunnel (WebView attaches no bearer).
- **Tile identity is stamped into app.json at create time** (scaffold
  defaults, clone backfills the template's keys, app.json-declared keys
  always win) and read back through the listing — one source of truth for
  every client; the desktop's localStorage meta remains only for
  drafts/ordering.
- iroh-js 1.0.0 ships broken `main`/`types` package fields — isolated
  behind `packages/tunnel/src/iroh.ts` (deep-path require + local types)
  rather than patching or forking.

## Out of scope

- Phase 4 (chat `_turn` streaming, automations run feed, push
  notifications) — explicitly out of scope on the issue.
- LAN binding / `0.0.0.0` exposure — superseded by iroh; fallback only.
- Offline/sync — mobile remains a live client of the desktop gateway.
- Draft/builder surfaces on mobile — desktop-only by design.
- Compiling/vendoring the iroh Swift/Kotlin bindings and on-device runs
  (needs Xcode/Gradle builds + hardware; the module is code-complete with
  binding touchpoints isolated for vendoring).
- Media-heavy transfer optimization (iroh-blobs) — issue's later item.
- Pre-existing `oxfmt --check` failures in three `packages/vault` FTS files
  from #261 (untouched here; flagged for a separate chore).

## Verification

```bash
bun run build                 # 11 turbo tasks green (incl. @centraid/tunnel, desktop main+preload)
bun run lint                  # 0 warnings, 0 errors
bun run typecheck             # 21 turbo tasks green (incl. mobile with the native module TS surface)
bash scripts/lint-types.sh    # type-aware pass: ok for all 10 targets incl. packages/tunnel
bun run test                  # all packages green: tunnel 8, blueprints 94, gateway 139+1 skip, desktop 81, skills 6, …
node packages/tunnel/scripts/spike-pipe.mjs --local   # SPIKE OK
```

(`bun run ci`'s format:check stage fails only on the three pre-existing
`packages/vault` files from #261 named under Out of scope; every file in
this change is oxfmt-clean.)

- **Phase 0 spike** validated under Node 22, Bun, and the Electron 37 main
  process (NAPI binding binds, dials, streams): HTML, ES-module
  subresource, POST echo, 3-way concurrency, and SSE arriving
  incrementally (~150 ms between events — streamed, not buffered). EOF
  semantics pinned: iroh-js signals stream FIN as an empty `read()`.
- **packages/tunnel integration tests** (real iroh endpoints on loopback,
  relays disabled, offline): unpaired connections refused at the
  transport; wrong pairing code rejected; the real code accepted exactly
  once (replay refused); GET/POST forwarded with the bearer attached
  desktop-side; concurrent requests multiplexed on one QUIC connection;
  SSE streamed incrementally; revocation drops live connections and blocks
  new ones; 503 when no gateway is up.
- **Electron main smoke** (scratch, session-local): the desktop's real
  `phone-link.js` from `dist/` — endpoint up, pairing QR minted as a PNG
  data URL, a tunnel client paired via the QR payload, the device
  persisted to `devices.json`, then revoked.
- **Real-gateway e2e** (scratch, session-local): `serve()` an actual
  gateway, pair, then through the phone's localhost proxy with **no bearer
  on the phone**: `GET /centraid/_apps` → 200,
  `GET /centraid/_vault/parked` → 200, while direct unauthenticated access
  to the gateway stays 401.
- **Honest limits:** the Swift/Kotlin native module is code-complete but
  NOT compiled in this session (no pod install/gradle run; iroh bindings
  must be vendored per its README) — its protocol logic is the one
  exercised end-to-end above via the TypeScript reference client. On-device
  Maestro runs (home-loads, template-gate) require hardware + a dev build
  and are not claimed.

## Steering

- Verdict: PASS
- Evidence: The session was initiated with a single `/goal` command ("implement the entire scope of this issue and create PR") with no human interrupts, corrections, or steering events mid-task. The JSONL transcript contains only task notifications (system-generated background work completions), confirming zero human steering.

## Audit

- What-changed fidelity: PASS — spot-checked: (1) tunnel protocol ALPNs `centraid/tunnel/1` + `centraid/pair/1` in `packages/tunnel/src/protocol.ts:20-21`; (2) desktop `phone-link.ts` persistent endpoint key and device-store allowlist per spec; (3) asset-inliner deleted (git status shows D); (4) notes/docs/etc app.json carry `iconKey`/`colorKey` stamps (notes: `Book`/`forest`); (5) gateway `listAppsWithMeta` returns `iconKey?`/`colorKey?` (lines 176-177); (6) mobile Approvals.tsx uses `listParked`/`confirmParked`; (7) kit.js haptic feature-detection and `haptic('success')` on toast. All 6+ spot checks match receipt's claims.
- Checklist realized in diff: PASS — all 9 checked items have corresponding files in the diff: Phase 0 spike script (`packages/tunnel/scripts/spike-pipe.mjs`), Phase 1 tunnel package files, Phase 1 desktop phone-link files, Phase 2 native module (apps/mobile/modules/), Phase 2 mobile viewer rewrite (bridge/gateway/screens), Phase 3 tile parity (scaffold/app-rewrites/clone), Phase 3 kit haptics (kit.js synced to all templates), Phase 3 Approvals screen, Phase 3 Maestro gate (template-gate.md/mjs).
- Checklist mirrors issue: PASS — all phases 0–3 from the issue's phased plan are realized; Phase 4 (chat/automations/notifications) explicitly deferred per issue's "Out of scope" statement; the 9 items cover the full bridge architecture: transport validation, desktop pairing, mobile native module, viewer rewrite, tile parity at source, haptics adoption, mobile approvals, and per-template gates.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-0084fa83-151-1783117773-1 | claude-code | 0084fa83-151d-48fb-b8d4-f22bb604b552 | #263 | claude-fable-5 | 230480 | 2694161 | 72537632 | 460775 | 3385416 | 131.5582 | 230480 | 2694161 | 72537632 | 460775 | feat(mobile): iroh tunnel bridges the phone to the desktop gateway (#263)Publish |
| claude-code-0084fa83-151-1783117815-1 | claude-code | 0084fa83-151d-48fb-b8d4-f22bb604b552 | #263 | claude-fable-5 | 8 | 2409 | 1456833 | 3450 | 5867 | 1.6595 | 230488 | 2696570 | 73994465 | 464225 | feat(mobile): iroh tunnel bridges the phone to the desktop gateway (#263)Issue:  |
| claude-code-0084fa83-151-1783117980-1 | claude-code | 0084fa83-151d-48fb-b8d4-f22bb604b552 | #263 | claude-fable-5 | 1012 | 25770 | 8550237 | 15506 | 42288 | 9.6578 | 231500 | 2722340 | 82544702 | 479731 | feat(mobile): iroh tunnel bridges the phone to the desktop gateway (#263)Publish |
| claude-code-0084fa83-151-1783118003-1 | claude-code | 0084fa83-151d-48fb-b8d4-f22bb604b552 | #263 | claude-fable-5 | 3893 | 1305 | 378832 | 427 | 5625 | 0.4554 | 235393 | 2723645 | 82923534 | 480158 | x (#263) |
