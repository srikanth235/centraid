# issue-289 — (gateway, vault) is the address: device enrollment, per-request vault resolution, iroh transport

GitHub issue: [#289](https://github.com/srikanth235/centraid/issues/289)

The forcing scenarios: a VPS gateway with one owner (today's remote story
sends one shared bearer in cleartext), a family landlord gateway (any
token-holder can flip the active vault for everyone and delete a sibling's
vault), and one device switching among several vaults (today a switch
re-roots every other client's session). Successor to the auth/multi-user
seam #280 deliberately deferred.

## Checklist

- [x] Commit 1 (tunnel) — gateway iroh endpoint + ticket pairing ALPN
- [x] Commit 2 (gateway) — per-request vault resolution; the active pointer dies
- [x] Commit 3 (gateway) — device enrollment ACL + pairing tickets + admin CLI + daemon endpoint
- [x] Commit 4 (desktop) — transport tiers, iroh dialer, version handshake
- [x] Commit 5 (desktop) — flat (gateway, vault) switcher, keyed state, identity strip

## What changed

### Commit 1 (tunnel) — gateway iroh endpoint + ticket pairing ALPN

- `gateway-endpoint.ts` (new): `startGatewayEndpoint()` binds an iroh
  endpoint speaking `centraid/tunnel/1` (the exact HTTP-over-bi-stream
  protocol the phone tunnel speaks) + `centraid/gw-pair/1` (ticket
  redemption). Policy is injected: `authorize(endpointId)` gates every
  connection AND every stream (revocation lands on live connections),
  `pair(request, endpointId)` redeems tickets, `requestHeaders(endpointId)`
  stamps the QUIC-proved device identity into each forwarded request —
  client-supplied copies of those headers are stripped first, so a device
  cannot impersonate another.
- `client.ts`: `TunnelClient.pairGateway()` dials the new ALPN with
  `{ticketId, secret, deviceName, platform}` and returns the enrollment +
  version-handshake material.
- Pins: `gateway-endpoint.test.ts` — unenrolled refusal, one-time ticket
  redemption with handshake payload, identity stamping + spoof stripping,
  live-connection revocation. Offline (relays disabled), same as the
  existing tunnel battery.
- Files: `packages/tunnel/src/gateway-endpoint.ts` (new),
  `packages/tunnel/src/gateway-endpoint.test.ts` (new),
  `packages/tunnel/src/client.ts`, `packages/tunnel/src/index.ts`,
  `receipts/issue-289-gateway-vault-addressing.md` (this receipt).

### Commit 2 (gateway) — per-request vault resolution; the active pointer dies

- `vault-context.ts` (new): an `AsyncLocalStorage` request scope
  `{vaultId, deviceKey?}` + the `x-centraid-vault` header constant + the
  `DeviceAccess` seam (device key extraction + enrollment lookup). The
  scope is how the request's vault reaches every provider callback
  (`appsDir()`, transcripts, `ctx.vault` bridges, owner routes) without
  threading a vault id through each signature.
- `VaultRegistry`: `vaults.json {active}`, `setActive()`,
  `settleActivation()`, `setActivationHook()`, `active()`,
  `activeWorkspace()` are DELETED. The registry is a warm map of mounted
  planes keyed by vaultId; `current()` resolves from the ambient context
  (fallback: the default vault — oldest, UUIDv7 order — for unscoped
  callers only). `get()` rescans the root on miss, so a vault created by
  the admin CLI mounts on first request without a restart. `delete()`
  protects the LAST vault (was: the active vault); `VaultInfo.active` is
  gone — the client owns its pointer.
- `buildGateway()`: `composedHandler` now owns the whole request — resolve
  the vault (device enrollment set scopes what it may address; the header
  picks within it; no header → sole enrollment, or the default vault for
  shared-bearer transports; unknown vault → loud 404; non-enrolled → 403)
  and run the chain inside `runWithVaultContext`. One cron scheduler PER
  VAULT (every vault's automations fire, not just the one a client looks
  at), each fire/evaluate wrapped in its vault's scope; reconcile is
  coalesced per vault. `start()` mounts EVERY vault's workspace.
  `activeAppsStore()` → `appsStore()` (request-scoped); new
  `syncApps(vaultId?)` replaces the tests' `settleActivation()` gesture for
  out-of-band store seeding. An injected test `scheduler` becomes the
  default vault's.
- `serve()`: mounts `composedHandler` as the single post-auth handler
  (conversation/prefs routes ride inside it so the vault scope wraps them);
  `ownerIdProvider` plumbing is gone.
- `vault-routes.ts`: POST/DELETE `/_vault/vaults` answer 405 `admin_plane`
  — vault create/delete are landlord acts on the box (CLI over SSH), so no
  route exists for a family member's device to delete a sibling's vault.
  PATCH keeps rename/presentation and loses `active: true`. `GET /vaults`
  filters to the calling device's enrollments (a family member sees one
  vault and no evidence of others); `?vault=` is gone — the header is the
  only addressing gesture. `GET /status` answers for the request's vault.
- `gateway-info-routes.ts` + `version.ts` (new): `GET /centraid/_gateway/info`
  → `{version, schemaEpoch}` — the version handshake surface (v0 policy:
  exact-match or refuse, enforced client-side).
- `openclaw-plugin`: `activeWorkspace()` → `currentWorkspace()` (its
  webhook fire rides the default vault — the plugin host is single-vault).
- Pins: rewritten `vault-registry.test.ts` (no pointer file; last-vault
  guard; per-context `current()`; concurrent two-vault bridge calls;
  out-of-band CLI create mounts on miss; 405 admin plane over HTTP) + new
  `serve-vault-addressing.test.ts` (two clients ride two vaults
  concurrently with disjoint app worlds and no server-side switch; unknown
  header 404s; device confinement: implied vault, 403 outside enrollment,
  filtered list).
- Files: `packages/gateway/src/serve/vault-context.ts` (new),
  `packages/gateway/src/serve/vault-registry.ts`,
  `packages/gateway/src/serve/build-gateway.ts`,
  `packages/gateway/src/serve/serve.ts`,
  `packages/gateway/src/routes/vault-routes.ts`,
  `packages/gateway/src/routes/gateway-info-routes.ts` (new),
  `packages/gateway/src/version.ts` (new),
  `packages/gateway/src/index.ts`,
  `packages/gateway/src/runs/assistant-conversation-runner.ts`,
  `packages/gateway/src/routes/assistant-routes.ts`,
  `packages/openclaw-plugin/src/index.ts`; tests:
  `packages/gateway/src/serve/vault-registry.test.ts`,
  `packages/gateway/src/serve/serve-vault-addressing.test.ts` (new),
  `packages/gateway/src/serve/build-gateway.test.ts`,
  `packages/gateway/src/serve/serve.test.ts`,
  `packages/gateway/src/serve/serve-git-store.test.ts`,
  `packages/gateway/src/serve/serve-multiclient.test.ts`,
  `packages/gateway/src/serve/vault-plane.test.ts`,
  `packages/gateway/src/routes/assistant-routes.test.ts`,
  `packages/gateway/src/lifecycle/draft-preview-over-http.test.ts`,
  `packages/gateway/src/lifecycle/ext-band-over-http.test.ts`,
  `packages/gateway/src/lifecycle/lifecycle-over-http.test.ts`.

### Commit 3 (gateway) — device enrollment ACL + pairing tickets + admin CLI + daemon endpoint

- `enrollment-store.ts` (new): `devices.json` — one row per (device key,
  vault): `{enrollmentId, endpointId, vaultId, label, platform?, addedAt}`.
  Multi-vault access = multiple rows; revoke by row or by key ("lost
  laptop"); mode 0600, atomic replace, reload-on-mtime so the admin CLI
  (separate process) and the daemon see each other's writes live.
- `pairing-store.ts` (new): `pairing-tickets.json` — one-time tickets
  holding only the secret's SHA-256 + TTL. `redeem()` burns the ticket on
  ANY attempt with the right id (a guessed-secret retry dies on try one)
  and is timing-safe. `encodePairingTicket()`/`parsePairingTicket()` define
  the pasteable one-line token: `{v, kind, gw: <iroh EndpointTicket>, t, s,
  vaultName, exp}` base64url — the ticket PINS the gateway identity, no TOFU.
- CLI admin plane (issue decision 5): `centraid-gateway vault
  list|create|rename|delete`, `centraid-gateway pair --vault <name-or-id>
  [--ttl-minutes n]` (prints the pasteable ticket; requires the daemon to
  have minted its endpoint identity), `centraid-gateway devices
  list|add|revoke`. All operate on `--data-dir` files directly — guarded by
  shell access, never HTTP.
- `endpoint-host.ts` (new): glues the tunnel's gateway endpoint to the
  daemon — persistent `endpoint-key.bin` (EndpointId = the gateway's
  permanent identity), enrollment-gated admission, ticket redemption →
  enrollment + `{version, schemaEpoch}` handshake in the pair response, and
  the device-identity forwarding contract: each tunneled request carries
  `x-centraid-device` + a per-boot `x-centraid-device-proof` only the
  daemon process knows, so the HTTP layer trusts the QUIC-proved identity
  and a plain bearer-holder cannot stamp one. Writes `endpoint.json`
  (id + dial ticket) for the `pair` CLI. Endpoint failure degrades to
  HTTP-only serving (config `endpoint: false` opts out).
- `cli.ts serve`: constructs the device plane before `serve()` (its
  `deviceAccess` joins every request), binds the endpoint after the HTTP
  listener, closes it on shutdown.
- Pins: `device-plane.test.ts` — enrollment rows (multi-vault, re-enroll
  refresh, revoke-by-row/key), cross-process visibility via mtime reload,
  ticket one-time/burn/TTL semantics, pasteable-token round-trip.
- Files: `packages/gateway/src/serve/enrollment-store.ts` (new),
  `packages/gateway/src/serve/pairing-store.ts` (new),
  `packages/gateway/src/serve/device-plane.test.ts` (new),
  `packages/gateway/src/cli/cli.ts`, `packages/gateway/src/cli/config.ts`,
  `packages/gateway/src/cli/paths.ts`,
  `packages/gateway/src/cli/vault-admin.ts` (new),
  `packages/gateway/src/cli/device-admin.ts` (new),
  `packages/gateway/src/cli/endpoint-host.ts` (new),
  `packages/gateway/package.json` (adds the `@centraid/tunnel` dep),
  `bun.lock`.

### Commit 4 (desktop) — transport tiers, iroh dialer, version handshake

- `transport.ts` (new): `GatewayProfile.transport` (`local` | `iroh` |
  `direct`) + `resolveTransport()` (derives it from kind + endpointId for
  pre-#289 profiles) + the plain-HTTP guardrail `assertDirectUrlAllowed()`
  — refuses `http://` to a public host (loopback / RFC1918 / LAN / `.local`
  stay allowed, the `ssh -L` path). `gateway-store.ts` carries
  `transport`/`endpointTicket`/`endpointId`, and `addGateway` accepts a
  `direct` URL (guardrailed) OR an iroh `endpointTicket`, not both.
- `iroh-dialer.ts` (new): reuses `@centraid/tunnel`'s `createTunnelClient`
  + `startLocalProxy` to dial a remote iroh gateway and expose a loopback
  `http://127.0.0.1:<port>` base URL, so `gateway-client-core` +
  auth-injector stay transport-blind. A stable per-profile device key
  (`iroh-device-key.bin`) makes the EndpointId match what the gateway
  enrolled; `resolveGateway` returns the proxy URL for iroh profiles.
  Dialers are torn down on gateway switch/remove.
- `version-handshake.ts` (new): pins `EXPECTED_GATEWAY_VERSION` /
  `EXPECTED_SCHEMA_EPOCH` (mirror `packages/gateway/src/version.ts`) and
  `judgeGatewayInfo()` / `handshakeGateway()` — exact-match-or-refuse, so a
  skewed VPS daemon is caught on connect.
- Pins: `transport.test.ts` (derive + private-host classification + the
  guardrail), `version-handshake.test.ts` (exact-match, mismatch,
  malformed, unreachable).
- Files: `apps/desktop/src/main/transport.ts` (new),
  `apps/desktop/src/main/transport.test.ts` (new),
  `apps/desktop/src/main/iroh-dialer.ts` (new),
  `apps/desktop/src/main/version-handshake.ts` (new),
  `apps/desktop/src/main/version-handshake.test.ts` (new),
  `apps/desktop/src/main/gateway-store.ts`.

### Commit 5 (desktop) — flat (gateway, vault) switcher, keyed state, identity strip

The flat switcher already lists vaults + connections and its head is the
ambient identity strip (vault name + color); this commit makes switching a
client-side pointer flip and keys the active-vault state by gateway.

- The active vault is CLIENT state now (#289): `activeVaultByGateway`
  (keyed by gateway id) in `PersistedSettings`, surfaced as
  `DesktopSettings.activeVaultId`; `setActiveVaultId()` is a pure pointer
  flip, carried through `mergePersistedSettings` so an unrelated save never
  wipes it.
- Every request carries `x-centraid-vault`: the renderer's `doFetch`
  stamps it from the cached auth (one choke point), the three main-side
  HTTP clients (conversation / prefs / apps-store) add it to their cached
  headers, and the auth-injector adds it to iframed-app requests. New IPCs
  `VAULTS_SET_ACTIVE` (+ `VAULT_CHANGED` broadcast) and vault
  create/delete (`VAULTS_CREATE`/`VAULTS_DELETE`, LOCAL gateway only — the
  desktop is its own landlord via the in-process registry; remote rejects
  with a "run the CLI over SSH" message). `getGatewayAuth` returns `vaultId`.
- The renderer switch is client-side: `switchProfile` (and the ⌘1…9
  shortcut) call `setActiveVault` — no `PATCH {active:true}`, no gateway
  teardown, editing sessions preserved (the keyed-state invariant). A vault
  flip drops only the auth caches (not app sessions) and re-scopes Home;
  the ambient identity strip (the sidebar switcher head — vault name +
  color from `core_vault`) already reflects it. `VaultStatus`/
  `VaultListEntry` drop the server `active` flag; the switcher compares
  `vaultId` against `getGatewayAuth().vaultId`.
- Pins: `settings-merge.test.ts` gains vault-map cases (carry-through,
  wholesale replace, empty-drop).
- Files: `apps/desktop/src/main/settings.ts`,
  `apps/desktop/src/main/settings-merge.ts`,
  `apps/desktop/src/main/settings-merge.test.ts`,
  `apps/desktop/src/main/ipc.ts`,
  `apps/desktop/src/main/local-gateway.ts`,
  `apps/desktop/src/main/auth-injector.ts`,
  `apps/desktop/src/main/conversation-history-client.ts`,
  `apps/desktop/src/main/user-prefs-client.ts`,
  `apps/desktop/src/main/apps-store-client.ts`,
  `apps/desktop/src/preload.ts`,
  `apps/desktop/src/renderer/centraid-api.d.ts`,
  `apps/desktop/src/renderer/gateway-client-core.ts`,
  `apps/desktop/src/renderer/gateway-client-vault.ts`,
  `apps/desktop/src/renderer/app.ts`,
  `apps/desktop/src/renderer/app-settings.ts`,
  `apps/desktop/src/renderer/app-vault.ts`.

## Decisions

- **AsyncLocalStorage over signature threading.** The request's vault
  reaches ~12 provider callbacks (`appsDir()`, transcripts provider,
  `ctx.vault` bridges, owner-id provider, scheduler paths). Threading a
  vaultId through every signature would have rewritten app-engine's
  `Runtime`/`Dispatcher` contracts; an ambient `AsyncLocalStorage` scope
  established once per request (and explicitly per scheduled fire) keeps
  the #280 provider seams intact. The registry's `current()` falls back to
  the default (oldest) vault ONLY outside a scoped request — shared-bearer
  clients that never send the header keep working.
- **Eager mount, no LRU (yet).** The issue sketches "mount on first
  request, LRU-evict idle"; the pre-#289 registry already mounted every
  plane eagerly (their sweeps are standing duties), so this lands the map
  + per-request resolution and leaves eviction as a follow-up — see Out of
  scope.
- **Injected test scheduler = the default vault's.** `BuildGatewayOptions.
  scheduler` (a test seam) used to be THE scheduler; with one scheduler
  per vault it now backs the default vault and other vaults get their own
  `InProcessScheduler`s — the least-surprise reading for every existing
  test.
- **`?vault=` query param removed** rather than kept alongside the header:
  two addressing gestures is one too many, and the query param would have
  needed its own enrollment check. The header is set centrally by the
  client core (phase 4), so routes never re-derive it.
- **405 (`admin_plane`), not 404, for vault create/delete over HTTP** — a
  stale client should learn the surface moved, not conclude the route never
  existed.
- **Device-identity trust via a per-boot proof header** rather than a
  second listener: the iroh forwarder and the HTTP layer share one secret
  in process memory; a bearer-holder on the HTTP surface cannot stamp
  `x-centraid-device` because it cannot produce the proof. Simpler than
  binding a second loopback socket per transport, and it keeps the phone
  tunnel's "gateway needs zero HTTP changes" property.
- **Gateway pairing gets its own ALPN (`centraid/gw-pair/1`)** instead of
  overloading the phone-pair ALPN: the payloads differ (ticket id + secret
  vs QR code) and the phone ceremony must keep working unchanged.
- **Desktop vault switch bounces Home rather than surgically re-rendering.**
  The keyed-state invariant that matters — editing sessions + the gateway
  connection survive a vault flip — holds (only the auth caches drop). A
  Home re-scope after the flip refetches the app grid for the new vault;
  full per-(gateway,vault) view-state buckets (last-open app, scroll,
  drafts) are a later refinement, noted in Out of scope.
- **Vault CRUD is client-driven ONLY for the local gateway.** The desktop
  is the in-process landlord for its own gateway, so create/delete run
  against the embedded registry (mirroring the CLI); a remote gateway
  rejects with a pointer at the server CLI — the bright admin/owner split
  the issue drew.
- **The iroh dialer resolves to a loopback proxy** (reusing the phone
  tunnel's `startLocalProxy`) so the whole HTTP client + auth-injector stay
  transport-blind — a URL is a URL. No new fetch abstraction, no
  per-transport branching in the renderer.

## Out of scope

- **LRU eviction of idle vault workspaces** — the registry already mounted
  every vault eagerly pre-#289 (planes carry standing-duty sweeps); the
  map-keyed shape is in, eviction can layer on when memory pressure is
  real. Noted in the issue as "mount on first request, LRU-evict idle".
- **Vault delete while the daemon is serving that vault** — the admin CLI
  deletes the directory out from under mounted planes; safest with the
  daemon stopped. v0 stance documented in the CLI header.
- **SSH transport as code** — per the issue, docs-only (`ssh -L` against a
  loopback daemon works via `direct` today); an embedded SSH dialer is a
  possible later profile type.
- **Phone pairs directly with a gateway endpoint** — the primitive now
  exists (same ALPN family), but the mobile client rewrite is not in this
  issue's phasing; phones keep riding the desktop phone-link.
- **Vault export/move between gateways** — the issue names it the natural
  NEXT issue.
- **Quotas/resource isolation, window-per-vault UI** — deferred per issue.
- **Per-(gateway,vault) client view-state buckets** (last-open app, scroll,
  draft focus) — the keyed active-vault POINTER lands (state that must be
  keyed to stay correct); richer per-bucket view state is a later layer
  that the keyed pointer makes possible.
- **End-to-end iroh dialer against a live remote daemon** — the wire
  (`@centraid/tunnel`) has its own offline battery and the daemon endpoint
  + desktop dialer are wired and typechecked, but a two-machine QUIC round
  trip is not part of the unit battery; it needs a live gateway endpoint to
  exercise. The "Add iroh gateway" UI affordance (paste a pairing ticket,
  redeem via `pairGateway`) is scaffolded in the store/IPC layer; the
  Settings form control for it is a follow-up.
- **No data migrations** (standing v0 rule): `vaults.json {active}` and
  bearer-token remote profiles are abandoned in place; dev setups re-pair.

## Verification

Full battery, all green:

```sh
bun run typecheck && bun run test && bun run lint && bun run format:check && bun run lint:types
```

- `bun run typecheck` — 21/21 turbo tasks green (all packages incl.
  desktop + mobile).
- `bun run test` — gateway: 27 test files / 149 tests green (incl. new
  `serve-vault-addressing.test.ts`, `device-plane.test.ts`, rewritten
  `vault-registry.test.ts`); tunnel: 2 files / 12 tests green (incl. new
  `gateway-endpoint.test.ts` — real iroh endpoints on loopback, relays
  disabled); desktop: 7 files / 91 tests green (incl. new `transport.test.ts`,
  `version-handshake.test.ts` + `settings-merge.test.ts` vault-map cases);
  app-engine 224, vault 248, automation 132, agent-runtime 68, blueprints
  95, openclaw-plugin 10, skills 6 — all green. (One earlier full-battery
  run flaked two pre-existing git-heavy `worktree-store` tests under
  parallel load; both pass standalone and in a gateway-suite rerun.)
- `bun run lint` (oxlint 0 errors) + `bun run format:check` (oxfmt clean)
  + `bun run lint:types` (all packages ok).

## Audit

**Verdict (commit 1):** PASS

1. **"What changed" faithfulness**: The Commit 1 section accurately describes the staged diff. New files `gateway-endpoint.ts` (287 lines) and `gateway-endpoint.test.ts` (185 lines) implement the endpoint, pairing ALPN, and authorization contract. `client.ts` adds `TunnelClient.pairGateway()` method with dual-ALPN exports. `index.ts` exports the new types and function. The receipt's bulleted changes match the diff's content and structure.

2. **Checklist item realization**: The single ticked item `[x] Commit 1 (tunnel)` is fully realized. The diff proves: gateway endpoint speaks two ALPNs (`centraid/tunnel/1` + `centraid/gw-pair/1`), ticket redemption is implemented (`pair` callback), device-identity headers are injected, authorization gates connections and streams, `pairGateway()` dials the pairing ALPN with the correct request/response types, and the test battery covers all four proof points (unenrolled refusal, ticket redemption + handshake, identity stamping + spoof stripping, live revocation).

3. **Checklist mirrors issue phasing**: The receipt's 5-item checklist mirrors issue #289's "Suggested phasing" exactly: (1) vault resolution, (2) device registry + tickets, (3) iroh endpoint, (4) transport tiers + handshake, (5) client switcher. Four future commits are correctly marked unticked `- [ ]`, following the established multi-commit receipt convention. The issue phasing is faithfully represented.

**Verdict (commits 2–5):** PASS

1. **"What changed" faithfulness**: All four sections accurately describe their diffs. Spot-checks confirm: vault-context + composedHandler vault resolution with 403/404 (commit 2); enrollment-store one-row-per-(key,vault), pairing-store with SHA-256+TTL, endpoint-host device-identity forwarding (commit 3); transport.ts guardrail refusing plain http:// to public hosts, iroh-dialer reusing tunnel client (commit 4); activeVaultByGateway keyed-by-gateway in PersistedSettings, renderer switch calls setActiveVault not PATCH (commit 5).

2. **Checklist realization**: All ticked items confirmed: AsyncLocalStorage vault context, vault-registry keyed workspaces with no active pointer, 405 admin plane for vault CRUD, version handshake, enrollment rows, pairing tickets, CLI admin commands, endpoint host, transport tiers + guardrail, iroh dialer, keyed active-vault state, x-centraid-vault header stamping, vault-map test cases.

3. **Phasing fidelity**: The 5-commit sequence maps faithfully to issue #289's 4-phase "Suggested phasing": phase 1 vault resolution (commit 2), phase 2 device registry (commit 3), phase 3 iroh endpoint + desktop dialer (commits 1+4), phase 4 client switcher (commit 5). The split of phase 3 across two commits is justified by package boundaries.

## Steering

**Verdict (commit 1):** PASS

The session ran autonomously from a single `/goal` directive (enqueued 2026-07-05T18:28:23.284Z: "work on the entire scope of issue #289 and create PR"). The transcript contains 166 total message entries; filtering for user-initiated content yields only the initial goal command. No mid-task interrupts, corrections, or redirects were recorded. The agent executed the entire scope without human steering, consistent with a single well-scoped `/goal` task. Zero steering rows are appended to the ledger below.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-a8d0b6fa-89f-1783278745-1 | claude-code | a8d0b6fa-89f8-4877-ba09-5eef76327dd5 | #289 | claude-opus-4-8 | 159119 | 1025828 | 65353131 | 425221 | 1610168 | 50.5141 | 159119 | 1025828 | 65353131 | 425221 | feat(tunnel): gateway iroh endpoint + one-time ticket pairing ALPN (#289)The gat |
| claude-code-a8d0b6fa-89f-1783278830-1 | claude-code | a8d0b6fa-89f8-4877-ba09-5eef76327dd5 | #289 | claude-opus-4-8 | 854 | 6019 | 3474219 | 8423 | 15296 | 1.9896 | 159973 | 1031847 | 68827350 | 433644 | feat(gateway): per-request vault resolution — the active-vault pointer dies (#28 |
| claude-code-a8d0b6fa-89f-1783278877-1 | claude-code | a8d0b6fa-89f8-4877-ba09-5eef76327dd5 | #289 | claude-opus-4-8 | 7450 | 6652 | 1406604 | 1459 | 15561 | 0.8186 | 167423 | 1038499 | 70233954 | 435103 | feat(gateway): device enrollment ACL + pairing tickets + admin CLI + iroh daemon |
| claude-code-a8d0b6fa-89f-1783280108-1 | claude-code | a8d0b6fa-89f8-4877-ba09-5eef76327dd5 | #289 | claude-opus-4-8 | 29233 | 568043 | 72534828 | 120775 | 718051 | 42.9832 | 196656 | 1606542 | 142768782 | 555878 | feat(desktop): transport tiers, iroh dialer, version handshake (#289)A gateway p |
| claude-code-a8d0b6fa-89f-1783280160-1 | claude-code | a8d0b6fa-89f8-4877-ba09-5eef76327dd5 | #289 | claude-opus-4-8 | 7726 | 7110 | 2949845 | 2209 | 17045 | 1.6132 | 204382 | 1613652 | 145718627 | 558087 | feat(desktop): vault addressing, client-side switch, keyed active-vault (#289)Th |
| claude-code-a8d0b6fa-89f-1783280183-1 | claude-code | a8d0b6fa-89f8-4877-ba09-5eef76327dd5 | #289 | claude-opus-4-8 | 7440 | 1212 | 989998 | 424 | 9076 | 0.5504 | 211822 | 1614864 | 146708625 | 558511 | feat(desktop): vault addressing, client-side switch, keyed active-vault (#289)Is |
| claude-code-a8d0b6fa-89f-1783280250-1 | claude-code | a8d0b6fa-89f8-4877-ba09-5eef76327dd5 | #289 | claude-opus-4-8 | 290 | 18178 | 3494995 | 5458 | 23926 | 1.9990 | 212112 | 1633042 | 150203620 | 563969 | feat(desktop): flat (gateway, vault) switcher, keyed state, identity strip (#289 |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
