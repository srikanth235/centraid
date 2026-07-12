# issue-376 — gateway URL in onboarding/UI + per-vault enrollment enforced on the HTTP bearer surface

GitHub issue: [#376](https://github.com/srikanth235/centraid/issues/376)

Follow-up to #289 / PR #291. The (gateway, vault) addressing model landed
server-side, but the client never surfaced it — onboarding assumed the
embedded local gateway, no UI could add a remote gateway, the switcher
was vault-only — and the enrollment ACL gated only the iroh transport:
on the shared-bearer HTTP surface, any token holder could open any vault
on the gateway by setting `x-centraid-vault`.

## Checklist

- [x] Per-device HTTP tokens and pluggable bearer authorization
- [x] HTTP pairing redemption route
- [x] Enrollment enforcement on the HTTP bearer surface
- [x] Desktop pairing redemption and per-gateway vault listing
- [x] Add gateway flow in Settings connections
- [x] Onboarding gateway step
- [x] Flat (gateway, vault) switcher

## What changed

### Per-device HTTP tokens and pluggable bearer authorization

- `packages/gateway/src/serve/device-token-store.ts` (new):
  `DeviceTokenStore` — `cdt_<tokenId>.<secret>` bearer tokens, sha256
  hash at rest in `device-tokens.json`, one token per device key
  (re-mint invalidates the prior), `authorize()` / `revokeForDeviceKey()`
  / `list()`, same reload-on-mtime cross-process contract as
  `EnrollmentStore` / `PairingTicketStore`.
- `packages/app-engine/src/http/http-server.ts`: new `authorizeBearer`
  option — `(bearer) => {plane:'admin'} | {plane:'device', deviceKey} |
  undefined`. Absent, the original single-token equality check is
  unchanged byte-for-byte. Any client-supplied `x-centraid-authed-device`
  header is deleted unconditionally before auth; the server re-stamps it
  only on a device-plane match, so the header is unforgeable.
  `AUTHED_DEVICE_HEADER` exported from `packages/app-engine/src/index.ts`.
- `packages/gateway/src/cli/cli.ts`: `commandServe` builds
  `authorizeBearer` (shared daemon token → admin plane via timing-safe
  compare, else `DeviceTokenStore.authorize()` → device plane) and passes
  it plus `devicePairing` into `serve()`.
  `packages/gateway/src/cli/paths.ts` adds `deviceTokensFile`;
  `packages/gateway/src/cli/endpoint-host.ts`'s `makeDaemonDevicePlane`
  opens the token store alongside enrollments and tickets.
- `packages/gateway/src/cli/device-admin.ts`: `devices revoke` cascades —
  a device key left with zero enrollments also loses its HTTP token.
- `packages/gateway/src/cli/token.ts` and
  `packages/gateway/src/serve/vault-context.ts` doc updates: shared token
  = admin/landlord plane; device tokens = tenant plane.

### HTTP pairing redemption route

- `packages/gateway/src/routes/pair-routes.ts` (new):
  `POST /centraid/_gateway/pair` — the HTTP twin of the iroh
  `centraid/gw-pair/1` ceremony for `direct`-transport devices that
  cannot dial QUIC. Body `{ticket, deviceLabel, platform?}` → decode +
  `PairingTicketStore.redeem()` (one-time burn + TTL) → enroll a
  synthetic `http:<uuid>` device key → mint a device token → 200
  `{ok, deviceToken, deviceKey, vaultId, vaultName}`. Every redemption
  failure answers 403 `ticket_invalid` (no oracle for why); only a
  malformed body gets 400. Registered via `publicPaths` (no bearer) in
  `packages/gateway/src/serve/serve.ts`, only when the daemon passes
  `devicePairing` — the desktop-embedded `serve()` neither mounts the
  route nor accepts device tokens.

### Enrollment enforcement on the HTTP bearer surface

- `packages/gateway/src/serve/build-gateway.ts`: `composedHandler` now
  resolves the request's device key as `deviceAccess.deviceKeyFor(req) ??
  AUTHED_DEVICE_HEADER`, so an HTTP device-token caller flows through the
  exact same enrollment-scoped vault resolution and 403s
  (`device_not_enrolled` / `vault_not_enrolled`) as an iroh-proved one.
  The iroh proof-header path is untouched and takes precedence. Stale
  "no device key = every vault" comments rewritten. The existing
  `visibleVaults()` filter in `GET /_vault/vaults` and the `PATCH`
  guard in `packages/gateway/src/routes/vault-routes.ts` now bind for
  device-token callers with no further change (file untouched).
- The admin plane is unchanged: the shared daemon token (and the
  desktop's per-launch embedded token) remains implicitly enrolled in
  every vault — landlord-ness stays a property of box access (#289 §5).

### Desktop pairing redemption and per-gateway vault listing

- `apps/desktop/src/main/gateway-pairing-core.ts` (new): pure core —
  `decodePairingTicket` (lockstep mirror of the
  `{v:1, kind:'centraid-gw-pair', gw, t, s, vaultName, exp}` wire format
  in `packages/gateway/src/serve/pairing-store.ts`, same convention as
  mobile's `parsePairQr`), expiry check, iroh/HTTP response folding to a
  stable error-code union, and profile-reuse lookup.
- `apps/desktop/src/main/gateway-pairing.ts` (new):
  `redeemGatewayPairing({ticket, label?, mode?, url?})`. Default iroh
  path dials `centraid/gw-pair/1` via `@centraid/tunnel` using the SAME
  persistent device key the data-plane dialer uses
  (`apps/desktop/src/main/iroh-dialer.ts` exports the previously-private
  key mint as `ensureIrohDeviceKey`; the key is pre-minted for the
  not-yet-persisted gateway id, and `profile.json` is written only on
  success). HTTP path POSTs the new pair route and stores the returned
  device token via keychain. Iroh profiles deliberately store no token —
  the QUIC handshake is the credential; the gateway endpoint stamps its
  own internal bearer upstream.
- `apps/desktop/src/main/gateway-vaults-core.ts` +
  `apps/desktop/src/main/gateway-vaults.ts` (new):
  `listGatewayVaults(gatewayId)` resolves ANY registered profile
  (local handle / direct URL / iroh proxy) without touching the active
  gateway, GETs `/centraid/_vault/vaults` with a ~3s abort timeout, and
  folds to `{ok, vaults} | {ok:false, error}`.
- `apps/desktop/src/main/gateway-store.ts`: `AddGatewayInput` gains an
  optional pre-minted `id` (pairing needs the id before the profile
  exists). `apps/desktop/src/main/ipc.ts`: new `GATEWAY_PAIR_REDEEM`
  (runs the same teardown/invalidation/broadcast sequence as
  `GATEWAYS_SET_ACTIVE` on success) and `GATEWAYS_LIST_VAULTS`;
  `apps/desktop/src/preload.ts` +
  `apps/desktop/src/renderer/centraid-api.d.ts` expose
  `redeemGatewayPairing` / `listGatewayVaults` with types.

### Add gateway flow in Settings connections

- `apps/desktop/src/renderer/react/shell/routes/gatewayModals.ts` (new):
  `connectGateway()` handles three credential shapes — ticket (iroh),
  ticket+URL (HTTP redemption), URL+bearer token (admin/direct) — and
  `friendlyGatewayError()` maps stable error codes to human copy. Never
  throws.
- `apps/desktop/src/renderer/react/shell/routes/GatewayPairingForm.tsx`
  (new, + `GatewayPairingForm.module.css`): the shared ticket-paste form
  (ticket + optional label; collapsible "Connect by URL" advanced section
  with a ticket/token toggle), owning the connecting/error lifecycle.
- `apps/desktop/src/renderer/react/shell/routes/GatewayModal.tsx` (new):
  the "Add gateway" modal reusing `SpaceModal.module.css` chrome.
- `apps/desktop/src/renderer/react/screens/SettingsProfilesScreen.tsx` +
  `apps/desktop/src/renderer/react/screen-contracts.ts`
  (`onAddConnection`, additive) +
  `apps/desktop/src/renderer/react/shell/routes/SettingsRoute.tsx`:
  "Add gateway" button under Connections; on success the modal closes,
  a toast shows, and the existing gateway/vault-changed broadcasts drive
  the shell re-scope.

### Onboarding gateway step

- `apps/desktop/src/renderer/react/screens/OnboardingScreen.tsx`
  (+ `.module.css`): the default name+color path is behaviorally
  unchanged; a low-key "Already have a gateway running? Connect
  instead →" action swaps in the shared `GatewayPairingForm` (wrapped in
  a forced-dark token host to match the onboarding design). On success
  onboarding completes with the remote (gateway, vault) already active,
  falling back to the connected vault's name when no display name was
  typed. `boot.tsx` needed no changes.

### Flat (gateway, vault) switcher

- `apps/desktop/src/renderer/react/shell/flatVaultSwitcher-core.ts`
  (new): pure merge/sort/selection core — active pair first, then the
  active gateway's other vaults, then other gateways alphabetically;
  unreachable gateways fold to one disabled row (offline / auth-failed /
  loading); cross-gateway selection awaits `setActiveGateway` before
  `setActiveVault`.
- `apps/desktop/src/renderer/react/shell/flatVaultSwitcherRegistry.ts`
  (new): session-lived stale-while-revalidate cache — reopen paints
  instantly from cache, `listGatewayVaults` refreshes concurrently per
  gateway and streams row updates into the open popover.
- `apps/desktop/src/renderer/react/shell/vaultSwitcher.ts` (+
  `vaultSwitcher.module.css`): now IO-free, renders flat
  (gateway, vault) rows — vault name + gateway label as secondary text —
  with `updateVaultSwitcherRows()` for in-place refresh; fixed a latent
  select-after-close callback capture bug.
- `apps/desktop/src/renderer/react/shell/useActiveVault.ts`: exposes
  `activeGatewayId` / `activeGatewayLabel` / `activeGatewayKind`;
  `apps/desktop/src/renderer/react/shell/App.tsx` wires the popover to
  the registry and adds a minimal ambient gateway hint to the sidebar
  head subtitle when the active gateway is remote.

### Files

New:
- `packages/gateway/src/serve/device-token-store.ts`
- `packages/gateway/src/serve/device-token-store.test.ts`
- `packages/gateway/src/serve/serve-device-tokens.test.ts`
- `packages/gateway/src/routes/pair-routes.ts`
- `apps/desktop/src/main/gateway-pairing-core.ts`
- `apps/desktop/src/main/gateway-pairing-core.test.ts`
- `apps/desktop/src/main/gateway-pairing.ts`
- `apps/desktop/src/main/gateway-vaults-core.ts`
- `apps/desktop/src/main/gateway-vaults-core.test.ts`
- `apps/desktop/src/main/gateway-vaults.ts`
- `apps/desktop/src/renderer/react/shell/routes/gatewayModals.ts`
- `apps/desktop/src/renderer/react/shell/routes/gatewayModals.test.ts`
- `apps/desktop/src/renderer/react/shell/routes/GatewayPairingForm.tsx`
- `apps/desktop/src/renderer/react/shell/routes/GatewayPairingForm.test.tsx`
- `apps/desktop/src/renderer/react/shell/routes/GatewayPairingForm.module.css`
- `apps/desktop/src/renderer/react/shell/routes/GatewayModal.tsx`
- `apps/desktop/src/renderer/react/shell/routes/GatewayModal.test.tsx`
- `apps/desktop/src/renderer/react/shell/flatVaultSwitcher-core.ts`
- `apps/desktop/src/renderer/react/shell/flatVaultSwitcher-core.test.ts`
- `apps/desktop/src/renderer/react/shell/flatVaultSwitcherRegistry.ts`
- `apps/desktop/src/renderer/react/shell/flatVaultSwitcherRegistry.test.ts`
- `receipts/issue-376-gateway-vault-onboarding-enforcement.md` (this receipt)

Modified:
- `packages/app-engine/src/http/http-server.ts`
- `packages/app-engine/src/http/http-server.test.ts`
- `packages/app-engine/src/index.ts`
- `packages/gateway/src/cli/admin.test.ts`
- `packages/gateway/src/cli/cli.ts`
- `packages/gateway/src/cli/device-admin.ts`
- `packages/gateway/src/cli/endpoint-host.ts`
- `packages/gateway/src/cli/paths.ts`
- `packages/gateway/src/cli/token.ts`
- `packages/gateway/src/serve/build-gateway.ts`
- `packages/gateway/src/serve/serve.ts`
- `packages/gateway/src/serve/vault-context.ts`
- `apps/desktop/src/main/gateway-store.ts`
- `apps/desktop/src/main/ipc.ts`
- `apps/desktop/src/main/iroh-dialer.ts`
- `apps/desktop/src/preload.ts`
- `apps/desktop/src/renderer/centraid-api.d.ts`
- `apps/desktop/src/renderer/react/screen-contracts.ts`
- `apps/desktop/src/renderer/react/screens/OnboardingScreen.tsx`
- `apps/desktop/src/renderer/react/screens/OnboardingScreen.test.tsx`
- `apps/desktop/src/renderer/react/screens/OnboardingScreen.module.css`
- `apps/desktop/src/renderer/react/screens/SettingsProfilesScreen.tsx`
- `apps/desktop/src/renderer/react/screens/SettingsProfilesScreen.test.tsx`
- `apps/desktop/src/renderer/react/shell/App.tsx`
- `apps/desktop/src/renderer/react/shell/routes/SettingsRoute.tsx`
- `apps/desktop/src/renderer/react/shell/useActiveVault.ts`
- `apps/desktop/src/renderer/react/shell/useActiveVault.test.tsx`
- `apps/desktop/src/renderer/react/shell/vaultSwitcher.ts`
- `apps/desktop/src/renderer/react/shell/vaultSwitcher.test.ts`
- `apps/desktop/src/renderer/react/shell/vaultSwitcher.module.css`

## Decisions

- **Redemption failures never say why.** The HTTP pair route answers 403
  `ticket_invalid` for bad secret / unknown / burned / expired alike,
  matching `PairingTicketStore.redeem()`'s existing no-oracle design.
  Client-side expiry pre-check gives the friendly "expired" copy locally.
- **Shared token stays landlord.** Holders of the daemon's `token.bin`
  (shell access) or the desktop's embedded per-launch token remain
  implicitly enrolled in every vault, per #289 §5 — tenants get pairing
  tickets and device-scoped credentials, never the shared token.
- **Iroh profiles store no bearer.** The QUIC handshake is the
  credential; the gateway endpoint stamps its own internal token
  upstream. Only HTTP-redeemed (`direct`) profiles persist a device
  token, keychain-encrypted.
- **One pairing form, two surfaces.** Settings modal and onboarding share
  `GatewayPairingForm`, so lifecycle/copy cannot drift.
- **No MRU persistence for the switcher.** No usable recency signal
  exists renderer-side; sort is active pair → active gateway's vaults →
  other gateways alphabetically. Attention badges and version-mismatch
  rows from #289 §7 stay deferred.
- **`DeviceTokenRow.lastUsedAt`** is typed but not populated — updating
  it would cost a disk write per request; future refinement.

## Out of scope

- Phone-link tunnel device identity: paired phones still ride the
  desktop's shared embedded token to the LOCAL gateway (landlord's own
  box, single-owner semantics). Stamping per-phone device keys there is
  a follow-up.
- Attention badges, version-mismatch rows, and MRU ordering in the flat
  switcher (#289 §7 tail).
- QR rendering for pairing tickets (paste-only today), rate limiting on
  the public pair route beyond one-time-burn + TTL + high-entropy secret.
- Vault export/move between gateways (#289 non-goal, unchanged).

## Verification

Full monorepo suite, typecheck, and lint on the combined diff, then two
real-rig passes (per-vault confinement against a spawned daemon; real
Electron UI including a live iroh pairing loop).

```
bunx vitest run                    → 305 passed | 1 failed | 1 skipped (307 files); 2695 tests passed
                                     sole failure = @centraid/blueprints tokens-sync staleness gate,
                                     reproduced identically on the main checkout (pre-existing, no
                                     blueprint/token files in this change set)
bun run typecheck                  → 22/22 tasks green
bun run lint                       → 22 pre-existing errors, none in change-set files (identical on main);
                                     oxlint + oxfmt clean on every touched file
```

Live daemon confinement (real `centraid-gateway serve` process, two
vaults "alice"/"bob", ticket minted via `pair --vault alice`, redeemed
over bare HTTP): 200 with `cdt_` device token; device token sees only
alice in `GET /_vault/vaults`; `x-centraid-vault: <bob>` → 403
`vault_not_enrolled`; PATCH on bob → 404 (masked) without header, 403
with; forged `x-centraid-authed-device` stripped (confinement held both
directions); ticket re-redemption → 403 `ticket_invalid`;
`devices.json` / `device-tokens.json` each gained exactly one row with
the secret stored hashed; admin token still sees and addresses all
vaults; bogus/missing bearer → 401.

Real Electron (Playwright `_electron.launch()`, fresh userData, all
screenshots read back): onboarding shows the "Connect instead" gateway
step with friendly inline errors on a garbage ticket; Settings →
Connections "Add gateway" modal opens/errors/cancels cleanly; flat
switcher lists vault + gateway-label rows and switches with the
checkmark following; full remote loop — real standalone daemon, real
`pair --vault` ticket pasted into the modal — redeemed over iroh in
1.4s, active pair switched to the remote vault (sidebar hint shows the
remote gateway label), and the switcher then listed pairs from both
gateways. Zero renderer console errors across all runs.

## Audit

PASS — fresh-context audit against `git status --short` (tracked + untracked), `gh issue view 376`, the receipt, and the live working tree; all 7 checklist items are realized in the diff and the issue's full 4-part plan (per-device tokens/pluggable bearer, desktop pairing redemption + vault listing, Settings + onboarding add-gateway flow, flat switcher) is covered, with deferred scope (phone-link per-device identity, attention badges/version-mismatch/MRU, QR rendering, cross-gateway vault export) honestly listed under Out of scope. Evidence: (1) file coverage exact — scripted diff of `git status --short` (51 files, tracked+untracked, receipt excluded) against the receipt's New+Modified Files lists (51 entries, excluding the self-referential "(this receipt)" line) shows zero omissions and zero phantom entries; (2) load-bearing claims spot-checked directly in source: `packages/app-engine/src/http/http-server.ts:81/104/189-208` — `authorizeBearer` option exists exactly as described, `delete req.headers[AUTHED_DEVICE_HEADER]` runs unconditionally before auth on every request, re-stamped only on a `plane:'device'` match, and the `else` branch preserves the original `timingSafeEqual` check byte-for-byte when `authorizeBearer` is absent; `packages/gateway/src/serve/build-gateway.ts:1683` resolves `options.deviceAccess?.deviceKeyFor(req) ?? authedDeviceKey` exactly as claimed; `packages/gateway/src/routes/pair-routes.ts` returns 403 `ticket_invalid` uniformly for bad-secret/unknown/burned/expired (4 call sites) and 400 only for malformed bodies; `packages/gateway/src/serve/device-token-store.ts:53-54/157` hashes secrets with `crypto.createHash('sha256')` and compares the hash, never the raw secret, at rest; `apps/desktop/src/main/iroh-dialer.ts` exports `ensureIrohDeviceKey`, consumed by both `iroh-dialer.ts` itself and the new `gateway-pairing.ts:101`, confirming shared device-key reuse; `GatewayPairingForm` is imported and rendered by both `OnboardingScreen.tsx:232` and `GatewayModal.tsx:63`; `flatVaultSwitcher-core.ts:245-247` awaits `setActiveGateway` before calling `setActiveVault`, matching the claimed cross-gateway ordering; IPC channel names `GATEWAY_PAIR_REDEEM`/`GATEWAYS_LIST_VAULTS` and `publicPaths` gating on `devicePairing` in `serve.ts:82` also match the receipt's description; (3) all six referenced test files run clean: `packages/gateway/src/serve/{serve-device-tokens,device-token-store}.test.ts` + `packages/app-engine/src/http/http-server.test.ts` → 3 files, 22 tests passed; `apps/desktop` `{gateway-pairing-core,flatVaultSwitcher-core,routes/gatewayModals}.test.ts` → 3 files, 59 tests passed; zero failures across both runs. No implementation defects found.

## Steering

PASS: Session 85cdf3d7-8857-4298-ae6a-5ed2ad24a40a contains 59 total user-type entries. Of these: 1 is human-authored prose (the initial task prompt at 2026-07-12T05:30:35, "I don't see any concept of using adding gateway url during onboarding..."), and 58 are machine-generated — 48 tool results (origin null, array-type content) and 10 task-notification system messages (origin "task-notification"). Zero steering events detected: no human interrupts, corrections, or mid-task redirections after the initial task assignment. The agent executed the delegated work through background subagents without requiring operator course correction.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-85cdf3d7-885-1783837708-1 | claude-code | 85cdf3d7-8857-4298-ae6a-5ed2ad24a40a | #376 | claude-fable-5 | 75690 | 623597 | 12536110 | 170504 | 869791 | 29.6132 | 75690 | 623597 | 12536110 | 170504 | feat(gateway,app-engine): per-device tokens enforce vault enrollment over HTTP ( |
