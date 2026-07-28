# Receipt: #603 — v0 onboarding rethink (auto-found, ticket-only clients, SSH + founding-plane retirement)

## Checklist

- [x] `centraid-gateway serve` on a fresh data dir starts with vaults **Shared** and **Personal** already present; an existing data dir is never modified
- [x] Fresh desktop install: chooser with exactly two options; "Start fresh" shows no founding/kit/keychain ceremony — next screen is profile; user lands in Personal
- [x] Both desktop paths and the ticket path collect displayName/avatarColor
- [x] After the founder completes the profile step, the Personal vault is renamed to their display name (headless gateways that never see a profile step keep "Personal")
- [x] Web/PWA and mobile onboarding show only the ticket flow; no founding UI, no "This Mac", no SSH anywhere
- [x] A pair ticket minted via CLI on a headless gateway onboards a phone/PWA to the Shared vault by default
- [x] `rg -i "sshConnectGateway|centraid-gw-found|FoundingScreen"` over `packages/ apps/` returns nothing (code deleted, not gated)
- [x] With the gateway unreachable, ConnectFlow reports unreachable; no `createVault` attempt ("Create vaults on the gateway host." banner is unreachable)
- [x] `vault list` (CLI `--json` and HTTP) reports mount-failed vaults distinctly from an empty registry
- [x] No offline banner during unpaired onboarding
- [x] CLI `pair`/ticket commands with a pinned `CENTRAID_GATEWAY_TOKEN` fail with a bearer-mismatch error; `docs/dev-environment.md` updated
- [x] Where a keychain prompt can appear, an informational note precedes the first secret write
- [x] `bun run check:pr:full` green
- [x] Governance receipt per issue

## What changed

### Gateway — auto-founding replaces the founding plane

A fresh data dir now founds itself at gateway **construction**, before any route
can observe a zero-vault gateway. Order is load-bearing: ids are UUIDv7, so
creating `Shared` first makes it the registry default (the target of a `pair`
with no `--vault`); `Personal` follows.

- `packages/gateway/src/serve/build-gateway.ts` — `vaultRegistry.isFresh()`
  **and an empty `members` table** gate `create('Shared')` then
  `create('Personal')` (the members guard keeps an erased-but-inhabited gateway
  awaiting restore from being re-founded — see Decisions); the host device
  identity is enrolled `admin` on both in one `gateway.db` transaction via
  `enrollWithinTransaction`. `initVaultName`, `foundingHandler`,
  `recoverPendingFoundingVaults`, and the `FRESH_GATEWAY_SCOPE_PREFIXES`
  allowlist are gone; `canMintFoundingTicket` is renamed `isHostCustody` and now
  gates ticket mint, member admin, share, and scopes. Zero mounted planes is no
  longer a legal steady state — the vault health component reports `error`.
- `packages/gateway/src/serve/vault-registry.ts` — `create()` loses its
  `reservedVaultId` parameter; `discardPendingFoundingVault()` deleted;
  `isFresh()` / `adopt()` / `rootPath()` re-documented around auto-founding. A
  vault dir that failed to mount still counts as "not fresh".
- `packages/gateway/src/serve/gateway-db.ts` — `tickets` loses `kind` and the
  `found`/`enroll` CHECK pair; `member_id` and `grants_json` are now NOT NULL.
  `founding_ticket_reservations`, the `one_founding_ticket` index, the
  `recovery_kit.founding_pending` column, and both ad-hoc `ALTER TABLE`
  backfills are dropped.
- `packages/gateway/src/serve/pairing-store.ts` — founding-ticket mint/redeem,
  the reservation lifecycle, and `hasOpenFoundingWindow()` removed; only the
  invitation (pair) ticket remains.
- `packages/gateway/src/serve/pairing-ticket-codec.ts` — `FoundingTicketPayload`
  and `parseFoundingTicket()` deleted.
- `packages/gateway/src/serve/host-identity.ts` — `kitlessHostIdentity` is no
  longer an `--init-vault` escape hatch; it is the gateway host's own device
  identity, always derived.
- `packages/gateway/src/serve/serve.ts`, `packages/gateway/src/serve/vault-plane.ts`,
  `packages/gateway/src/index.ts` — `foundingHandler` dropped from the serve
  handle; `isDirectHostRequest` re-documented against `serve({isHostCustody})`.
- Deleted: `packages/gateway/src/serve/founding-recovery.ts`,
  `packages/gateway/src/serve/founding-reservations.ts`,
  `packages/gateway/src/routes/founding-routes.ts`,
  `packages/gateway/src/cli/founding-admin.ts`.

### Gateway — honest failure shapes

- `packages/gateway/src/routes/gateway-info-routes.ts` and
  `packages/protocol/src/handshake.ts` — `status` and `foundingPending` removed
  from `GatewayInfo`; `authenticated: boolean` added and threaded through
  `buildGatewayInfoPayload` / `judgeGatewayInfo`.
- `packages/protocol/src/routes.ts` — `gatewayFoundingTicket`, `vaultInitialize`,
  `vaultInitializeVerify`, and `vaultRestore` removed from `ROUTES`.
- `packages/gateway/src/cli/device-admin.ts` — `commandPair` distinguishes three
  cases: a different data dir, a **rejected credential** (`authenticated: false`
  → an error naming `CENTRAID_GATEWAY_TOKEN` and `keys/endpoint-key.bin`), and a
  genuinely-not-ready iroh endpoint. This is the C2 fix.
- `packages/gateway/src/cli/vault-admin.ts` — `vault list` emits `failedMounts`
  in `--json` and to stderr in text mode, exit code unchanged.
- `packages/gateway/src/cli/status-admin.ts` — `DataDirSummary` gains
  `failedMounts` and `vaultReadError`; the old bare `catch {}` that made an
  unreadable vault root look like zero vaults is gone.
- `packages/gateway/src/routes/vault-routes.ts` — `GET /_vault/vaults` returns
  `failedMounts` alongside `vaults`; the erase response returns
  `remainingVaults` instead of a `status: 'uninitialized' | 'ready'`; the ticket
  cleanup on erase no longer filters by the removed `kind` column.
- `packages/gateway/src/routes/devices-routes.ts` — the `isUninitialized` 409
  gate is replaced by `defaultVaultId()`, so a `pair` naming no vault targets
  `Shared` when the caller may address it.
- `packages/gateway/src/cli/endpoint-host.ts` — QUIC admission is enrollment-only;
  the admit-an-unknown-EndpointId founding window is gone. `canMintFoundingTicket`
  → `isHostCustody`.
- `packages/gateway/src/cli/cli.ts`, `packages/gateway/src/cli/cli-serve-args.ts` —
  `--init-vault` and the `init-ticket` subcommand removed; the daemon always has
  a host identity.
- `packages/gateway/src/cli/recover-admin.ts` — the lock-held error no longer
  points at a founding route that does not exist.
- `packages/gateway/src/cli/landlord-auth.ts` — comment corrected ("loopback
  control lane", not "founding/control lane").
- `packages/gateway/src/backup/recovery-kit-state.ts` — `ceremonyIncomplete()`,
  `beginWithinTransaction()`, and the `founding` option removed; the
  backup-plane kit lifecycle (`begin`/`verify`/`status`) survives intact.

### Desktop — chooser, lazy gateway start, keychain note, SSH deletion

- `apps/desktop/src/main/settings.ts` — first-run keychain deferral: on a true
  first run (`onboardingCompletedAt` absent) `resolveEffective` returns empty
  local URL/token instead of booting the runtime; `requestLocalGatewayStart()`
  lifts the latch and `setActiveGatewayId` calls it, so "Start fresh on this
  Mac" is what starts the gateway and triggers the first `safeStorage` write.
- `apps/desktop/src/main.ts` — the tray reflects the deferred state rather than
  claiming the gateway is running.
- `apps/desktop/src/main/gateway-monitor.ts` — the down-alert is suppressed while
  the user is pre-onboarding, since "unreachable" is then expected. A settings
  read that *failed* still alerts.
- `apps/desktop/src/main/ipc-core.ts`, `apps/desktop/src/main/ipc.ts`,
  `apps/desktop/src/preload.ts`, and `packages/client/src/centraid-api.d.ts` —
  new `keychainPromptExpected` bridge method (true on unpackaged macOS and where
  a Linux keyring can prompt); the SSH IPC channels and `sshConnectGateway` are
  removed.
- `apps/desktop/src/main/embedded-gateway.ts` — no founding options passed.
- `apps/desktop/src/main/gateway-connectivity.ts`,
  `apps/desktop/src/main/gateway-connectivity-core.ts`,
  `apps/desktop/src/main/gateway-store.ts`, and
  `apps/desktop/src/main/gateway-store-core.ts` — SSH transport fields and the
  SSH connectivity stage dropped from the profile/probe shapes.
- Deleted: `apps/desktop/src/main/ssh-host.ts`,
  `apps/desktop/src/main/ssh-host-core.ts`,
  `apps/desktop/src/main/gateway-ssh-connect.ts`.

### Client — platform-branched first run, unified profile step, unreachable propagation

- `packages/client/src/react/host-platform.ts` *(new)* — `isWebHost()`, a
  synchronous first-paint marker (`window.CentraidIroh`) so first run can branch
  before any bridge round trip. Presentation only.
- `packages/client/src/react/screens/FirstRunGate.tsx` — branches on **platform**,
  not gateway state: web renders the ticket path directly; desktop renders the
  two-option chooser (`data-testid="first-run-choice"`). `gatewayStatus`,
  `foundingPending`, and the founding bridge props are gone.
- `packages/client/src/react/screens/OnboardingScreen.tsx` and
  `packages/client/src/react/screens/OnboardingScreen.module.css` — takes an
  `OnboardingPath` (`'fresh' | 'ticket'`), collects displayName/avatarColor on
  both, and renders the one-line keychain note ahead of the first secret write
  when `keychainPromptExpected()` says the OS can prompt.
- `packages/client/src/react/boot.tsx` — writes the profile + onboarding stamp and
  renames the auto-founded `Personal` vault to the founder's display name.
- `packages/client/src/react/shell/routes/connectFlowIO.ts` — `loadLocalVaults()`
  returns a typed `LocalVaultsResult` instead of swallowing errors into an empty
  list (W4); new `connectFreshLocalGateway()` for the "Start fresh" commit;
  `commitSsh` and the SSH bridge contract deleted; `createVault` is probed for
  before being offered.
- `packages/client/src/react/shell/routes/connectFlow-core.ts`,
  `packages/client/src/react/shell/routes/ConnectFlow.tsx`,
  `packages/client/src/react/shell/routes/ConnectFlowDetailsStep.tsx`,
  `packages/client/src/react/shell/routes/ConnectFlowModal.tsx`, and
  `packages/client/src/react/shell/routes/ConnectFlowVaultStep.tsx` — the `ssh`
  method, its details step, and its state are removed; a new `initialMethod`
  opens straight into a method for hosts that already chose; onboarding no
  longer auto-commits a local connect.
- `packages/client/src/react/shell/gatewayRegistry.ts` — the `SSH` transport chip
  and `hasSsh` are gone; every remote gateway is iroh.
- `packages/client/src/react/screens/device-roles.ts`,
  `packages/client/src/react/shell/routes/spaceModals.ts`,
  `packages/client/src/gateway-client.ts` — founding exports unwired.
- Deleted: `packages/client/src/react/screens/FoundingScreen.tsx`,
  `packages/client/src/gateway-client-founding.ts`.

### Web + mobile — ticket only

- `apps/web/src/web-host.ts` — the SSH connectivity stage becomes an
  iroh-reachability stage; `sshConnectGateway` removed; `createVault` is no
  longer defined at all, so callers hide the affordance instead of offering a
  button that always throws "Create vaults on the gateway host.".
- `apps/web/src/web-chrome.ts` and `apps/web/src/web-state.ts` — the offline
  banner is suppressed until `onboardingCompletedAt` exists, and re-evaluates on
  the settings event so it appears the moment first run finishes (W6).
- `apps/mobile/src/screens/Onboarding.tsx` + `apps/mobile/src/screens/onboarding-art.tsx`
  *(new)* — the founding/kit branches are removed; the screen is the ticket path
  plus the shared profile step.
- `apps/mobile/src/lib/phone-link-parse.ts`, `apps/mobile/src/lib/phone-link.ts`,
  and `apps/mobile/src/lib/spaces.ts` — the `centraid-gw-found` payload shape is
  gone; `centraid-gw-pair` is the only redeemable ticket.
- Deleted: `apps/mobile/src/lib/vault-founding.ts`,
  `apps/mobile/src/lib/recovery-kit-files.ts`.

### Tests and harnesses

Gateway suites updated to the auto-found world (most only because their
fixtures used to pass `initVaultName`, or asserted the retired
`status: 'uninitialized'` / founding-window admission):

- `packages/gateway/src/serve/build-gateway.test.ts`
- `packages/gateway/src/serve/serve.test.ts`
- `packages/gateway/src/serve/vault-registry.test.ts`
- `packages/gateway/src/serve/gateway-db.test.ts`
- `packages/gateway/src/serve/authz-matrix.smoke.test.ts`
- `packages/gateway/src/serve/device-plane.test.ts`
- `packages/gateway/src/serve/pairing-ticket-host-custody.test.ts`
- `packages/gateway/src/serve/revocation-severs-planes.test.ts`
- `packages/gateway/src/serve/secret-log.smoke.test.ts`
- `packages/gateway/src/serve/serve-git-store.test.ts`
- `packages/gateway/src/serve/serve-multiclient.test.ts`
- `packages/gateway/src/serve/serve-scheduler-reconcile.test.ts`
- `packages/gateway/src/serve/serve-vault-addressing.test.ts`
- `packages/gateway/src/serve/web-app-sessions.contract.test.ts`
- `packages/gateway/src/routes/devices-routes.test.ts`
- `packages/gateway/src/routes/devices-routes-invitations.test.ts`
- `packages/gateway/src/routes/devices-routes.test-fixtures.ts`
- `packages/gateway/src/routes/apps-store-routes.test.ts`
- `packages/gateway/src/routes/lifecycle-automation-routes.test.ts`
- `packages/gateway/src/routes/route-helpers.test.ts`
- `packages/gateway/src/routes/templates-routes.test.ts`
- `packages/gateway/src/routes/vault-erase.test.ts`
- `packages/gateway/src/lifecycle/automation-lifecycle-over-http.test.ts`
- `packages/gateway/src/lifecycle/clone-over-http.test.ts`
- `packages/gateway/src/lifecycle/draft-preview-over-http.test.ts`
- `packages/gateway/src/lifecycle/ext-band-over-http.test.ts`
- `packages/gateway/src/lifecycle/install-over-http.test.ts`
- `packages/gateway/src/lifecycle/lifecycle-over-http.test.ts`
- `packages/gateway/src/lifecycle/webhook-route-over-http.test.ts`
- `packages/gateway/src/cli/admin.test.ts`
- `packages/gateway/src/cli/cli.test.ts`
- `packages/gateway/src/cli/lock-admin.test.ts`
- `packages/gateway/src/cli/status-admin.test.ts`
- `packages/gateway/src/backup/recovery-kit-state.test.ts`
- `packages/protocol/src/handshake.test.ts`
- `packages/protocol/src/handshake-direct.test.ts`

Client, desktop, web, and mobile suites updated:

- `packages/client/src/react/screens/FirstRunGate.test.tsx`
- `packages/client/src/react/screens/OnboardingScreen.test.tsx`
- `packages/client/src/react/shell/gatewayRegistry.test.ts`
- `packages/client/src/react/shell/routes/ConnectFlow.test.tsx`
- `packages/client/src/react/shell/routes/connectFlow-core.test.ts`
- `packages/client/src/react/shell/routes/connectFlowIO.test.ts`
- `apps/desktop/src/main/embedded-gateway-layout.test.ts` — asserts the real
  Electron embed auto-founds `Shared` + `Personal` on a fresh data dir
- `apps/desktop/src/main/gateway-connectivity-core.test.ts`
- `apps/desktop/src/main/gateway-store-core.test.ts`
- `apps/desktop/src/main/ipc-core.test.ts` — covers `keychainPromptExpected`
- `apps/desktop/tests/e2e/fixtures.ts` — drops `markOnboardingPending`
- `apps/desktop/tests/e2e/onboarding-home.spec.ts` — chooser → lazy-start
  assertion → profile → vaults `['Ada Lovelace', 'Shared']`
- `apps/desktop/tests/e2e-live/driver.mjs`
- `apps/mobile/src/lib/phone-link.test.ts`
- `apps/mobile/src/screens/Onboarding.test.tsx`
- `apps/web/tests/e2e/server.ts`

Deleted test files whose subject no longer exists:

- `packages/gateway/src/routes/founding-routes.test.ts`
- `packages/gateway/src/routes/founding-forwarder.test.ts`
- `packages/gateway/src/serve/founding-recovery.test.ts`
- `packages/gateway/src/serve/desktop-founding.integration.test.ts`
- `packages/gateway/src/backup/recover-live.integration.test.ts`
- `packages/gateway/src/cli/founding-admin.test.ts`
- `packages/client/src/gateway-client-founding.test.ts`
- `packages/client/src/react/screens/FoundingScreen.test.tsx`
- `apps/mobile/src/lib/vault-founding.test.ts`
- `apps/mobile/src/lib/recovery-kit-files.test.ts`
- `apps/desktop/src/main/ssh-host-core.test.ts`

Pairing e2e:

- `tests/agent-e2e-pairing/lib/harness.mjs` and
  `tests/agent-e2e-pairing/lib/docker-harness.mjs` stop passing `--init-vault`.
- `tests/agent-e2e-pairing/flows/device-pairing-lifecycle.mjs`,
  `tests/agent-e2e-pairing/flows/cross-network-relay.mjs`, and
  `tests/agent-e2e-pairing/flows/extension-companion.mjs` target the
  auto-founded `Shared`.
- `tests/agent-e2e-pairing/flows/vps-phone-founding.mjs` and
  `tests/agent-e2e-pairing/flows/vps-phone-founding.md` are deleted,
  and `tests/matrix.json` repoints the `gateway.journey` cell (renamed
  `gateway-founding-journey` → `gateway-journey`) at
  `device-pairing-lifecycle.mjs`.
- Other harnesses that spawned a gateway with `--init-vault`:
  `tests/agent-e2e-mobile/lib/ci-gateway.mjs`,
  `tests/perf/fixtures/gateway-idle-server.mjs`,
  `tests/scale/gateway-sessions.scale.test.ts`,
  `packages/gateway/scripts/bench-low-end.mjs`.
- `.github/workflows/e2e.yml` and
  `scripts/test-report/validate-nightly-wiring.mjs` — the nightly
  `pairing-founding` job (which ran the deleted `vps-phone-founding.mjs`) is
  removed from the workflow, its `needs` lists, the red-check summary, and the
  wiring validator's required jobs/artifacts/flows.
- `tests/matrix.json` — `backup-restore.concurrency` is demoted to an explicit
  `Skip` with a `null` owner: its owning test (`recover-live.integration.test.ts`)
  exercised restore into a LIVE gateway, a plane #603 deleted; restore is the
  offline `recover` verb, so concurrent restore has no surface.
- `apps/desktop/tests/e2e/SCENARIOS.md` and
  `apps/desktop/tests/e2e/COVERAGE_REPORT.md` — scenario 1.2 and the harness
  description now name the chooser step and the first-run lazy gateway start.

### Docs (this change set's doc pass)

- `README.md` — the VPS/headless block is now `serve` (auto-founds) + `pair`;
  the client-enroll table names the desktop chooser and marks PWA ticket-only.
- `ARCHITECTURE.md` — a fresh data dir creates `vault/` on first boot; the
  recovery-kit custody row is labelled backup-plane; "restore is two verbs" is
  `backup restore` + `centraid-gateway recover`, with `vaults:restore` called out
  as gone.
- `SECURITY.md` — the credential-issuance paragraph describes auto-founding, the
  single pair-ticket concept, and `authenticated`; the #568 fresh-gateway
  allowlist and `uninitialized` wall are recorded as removed. The trust-anchor
  row, KeyStore paragraph, and five-layer L0 now say the kit is a deliberate
  export.
- `CHANGELOG.md` — Unreleased Added/Removed/Fixed entries for #603; the #555
  entry is rewritten so unshipped release notes stop describing a deleted
  founding plane.
- `docs/recovery/pairing.md` — retitled and rewritten around auto-founding; adds
  the `pair` bearer-mismatch recovery step; the SSH/console note corrected.
- `docs/recovery/vault-erase.md` — the erase ceremony is unchanged, but
  restore-after-erase is the offline `recover` verb, with an explicit warning
  that restarting the daemon against an empty `vault/` auto-founds over it.
- `docs/recovery/backup-restore.md` — kit-is-an-export invariant; the founding
  UI / `vaults:restore` references replaced with the `recover` CLI.
- `docs/dev-environment.md` — a `CENTRAID_GATEWAY_TOKEN` subsection (do not pin;
  what the bearer-mismatch error means), the daemon row, and the browser-preview
  walkthrough rewritten for ticket-only web onboarding.
- `docs/glossary.md` — new **pair ticket**, **auto-found**, and **Shared /
  Personal** terms; the founding invariant restated; forbidden-synonym rows for
  "founding ticket / ceremony / uninitialized gateway" and for "found a vault"
  as a user act; L0 wording aligned.
- `docs/decisions.md` — a **Founding retirement** row superseding the #555/#568
  founding plane, and an amendment note on the #298 erase row.
- `docs/platform-gating.md` — `isWebHost()` added to the signals table.
- `docs/traps/wal-checkpoint.md` — blank-machine recovery row names the
  export-in-advance requirement and the auto-found footgun.
- `packages/gateway/README.md` — `initVaultName` removed from the `serve()`
  example and replaced by the auto-found description; the CLI block drops
  `init-ticket`; the stale "ephemeral per-boot secret" claim is corrected to the
  derived, stable bearer.
- `packages/cli/README.md` — the `CENTRAID_GATEWAY_TOKEN` row corrected.
- `tests/agent-e2e-pairing/AGENTS.md`, `tests/agent-e2e-pairing/README.md`,
  `tests/agent-e2e-pairing/flows/cross-network-relay.md`,
  `tests/agent-e2e-pairing/flows/device-pairing-lifecycle.md` — no `--init-vault`,
  flows target `Shared`, and the deleted `vps-phone-founding` flow is removed
  from the run lists, the nightly job list, and the layer table.
- `receipts/issue-603-v0-onboarding-rethink.md` — this receipt.

### Checklist crosswalk

Each checked acceptance item, against where it is realized above:

- `centraid-gateway serve` on a fresh data dir starts with vaults **Shared** and **Personal** already present; an existing data dir is never modified — `packages/gateway/src/serve/build-gateway.ts` (`isFresh()` gate + ordered `create`), `packages/gateway/src/serve/vault-registry.ts` (`isFresh()` counts failed mounts).
- Fresh desktop install: chooser with exactly two options; "Start fresh" shows no founding/kit/keychain ceremony — next screen is profile; user lands in Personal — asserted live by `apps/desktop/tests/e2e/onboarding-home.spec.ts` §1.2 (4/4 §1 specs green, ~27s).
- After the founder completes the profile step, the Personal vault is renamed to their display name (headless gateways that never see a profile step keep "Personal") — `packages/client/src/react/boot.tsx`; the desktop e2e ends with vault list `['Ada Lovelace', 'Shared']`.
- `bun run check:pr:full` green — full run on this tree: all static gates plus dependents; 448 test files (447 passed, 1 skipped), 3209 tests passed, diff-coverage 98.9% ≥ 80%.
- Both desktop paths and the ticket path collect displayName/avatarColor — `packages/client/src/react/screens/OnboardingScreen.tsx` takes `OnboardingPath` and renders the identity step for both.
- Web/PWA and mobile onboarding show only the ticket flow; no founding UI, no "This Mac", no SSH anywhere — `packages/client/src/react/screens/FirstRunGate.tsx` (web renders `path="ticket"` directly), `apps/mobile/src/screens/Onboarding.tsx`, `apps/web/src/web-host.ts`.
- A pair ticket minted via CLI on a headless gateway onboards a phone/PWA to the Shared vault by default — `packages/gateway/src/routes/devices-routes.ts` `defaultVaultId()`; `Shared` is created first so it is the registry default.
- `rg -i "sshConnectGateway|centraid-gw-found|FoundingScreen"` over `packages/ apps/` returns nothing (code deleted, not gated) — the deleted-file lists above; the command itself is in `## Verification`.
- With the gateway unreachable, ConnectFlow reports unreachable; no `createVault` attempt ("Create vaults on the gateway host." banner is unreachable) — `packages/client/src/react/shell/routes/connectFlowIO.ts` returns a typed `LocalVaultsResult`; `apps/web/src/web-host.ts` no longer defines `createVault` at all.
- `vault list` (CLI `--json` and HTTP) reports mount-failed vaults distinctly from an empty registry — `packages/gateway/src/cli/vault-admin.ts`, `packages/gateway/src/cli/status-admin.ts`, `packages/gateway/src/routes/vault-routes.ts`.
- No offline banner during unpaired onboarding — `apps/web/src/web-chrome.ts` gates on `onboardingCompletedAt` and re-evaluates via `apps/web/src/web-state.ts`.
- CLI `pair`/ticket commands with a pinned `CENTRAID_GATEWAY_TOKEN` fail with a bearer-mismatch error; `docs/dev-environment.md` updated — `packages/gateway/src/cli/device-admin.ts` branches on `authenticated: false`; the docs subsection is described in the docs pass above.
- Where a keychain prompt can appear, an informational note precedes the first secret write — `apps/desktop/src/main/ipc-core.ts` `keychainPromptExpected`, rendered by `packages/client/src/react/screens/OnboardingScreen.tsx`.
- Governance receipt per issue — this file.

## Out of scope

- **Recovery kits as a first-class Settings export.** The backup-plane kit
  (`backup kit`, `recover`, the Backup screen surfaces) is untouched, but a
  polished "export your recovery kit" product surface is a post-v0 candidate,
  not this change.
- **Schema migrations for old vaults.** v0's no-compat policy stands; only the
  *failure shape* of a drifted vault (`failedMounts`) is in scope, not migrating
  it.
- **Role / permission UI beyond what #599 shipped.** The founder grants further
  access through the existing member and ticket surfaces.
- **Multi-gateway topology changes.** The gateway switcher and registry keep
  their current shape; only the SSH transport chip was removed.
- **Merge to `main`.**

## Verification

Every command below is the exact invocation a reviewer re-runs. The
per-package suites were rewritten alongside the source in this change set; the
certifying gate run and the desktop e2e both ran green on this tree (results
at the bottom of this section).

Gateway package (auto-founding, ticket plane, CLI, routes, protocol):

```sh
cd packages/gateway && bun run test
cd packages/protocol && bun run test
```

Client package (first-run gate, onboarding screen, ConnectFlow, registry):

```sh
cd packages/client && bun run test
```

Desktop main-process units (embedded auto-found, connectivity, store, IPC):

```sh
cd apps/desktop && bun run test
```

Mobile units (ticket parsing, onboarding screen):

```sh
cd apps/mobile && bun run test
```

Typecheck across the affected packages:

```sh
bun run typecheck
```

Acceptance evidence for the deleted surfaces (expected: no matches):

```sh
rg -i "sshConnectGateway|centraid-gw-found|FoundingScreen" packages/ apps/
rg -n -- "--init-vault|init-ticket|initVaultName" packages/ apps/ tests/
```

Manual / rig checks for the headless story:

```sh
# fresh dir auto-founds; second boot is a no-op
centraid-gateway serve --data-dir "$(mktemp -d)/gw" --host 127.0.0.1 --port 17832
centraid-gateway vault list --data-dir "$DATA_DIR" --json   # Shared + Personal, failedMounts: []
centraid-gateway pair --data-dir "$DATA_DIR" --qr           # targets Shared
```

Certifying runs on this tree (both green):

```sh
# desktop first-boot e2e — chooser → lazy start → fresh → profile → Personal
# renamed; 4/4 §1 specs passed (~27s)
cd apps/desktop && bun run test:e2e -- --grep "1\."

# the full repo gate, including dependents of the shared packages that changed:
# all static gates; 448 test files (447 passed, 1 skipped), 3209 tests passed,
# diff-coverage 98.9% ≥ 80%
bun run check:pr:full
```

One flake note for reviewers: the repo-wide turbo test run can saturate this
machine (known `-c6` behaviour) and produced hook-timeout/teardown-race
failures in `packages/gateway` on the first attempt; the package suite passes
in full when run on its own, and the certifying `check:pr:full` above ran
green end-to-end.

## Decisions

- **`Shared` is created before `Personal`, deliberately.** Vault ids are UUIDv7
  and `defaultVaultId()` returns the oldest, so creation order — not a flag — is
  what makes the household vault the default target for an unscoped request and
  for a `pair` with no `--vault`. This is an invariant a future refactor can
  break silently; it is commented at the call site in `build-gateway.ts`.
- **The `#555` CHANGELOG entry was rewritten rather than appended to.** #555 is
  still under `[Unreleased]`, so the founding plane it announced never shipped.
  Leaving it would have generated release notes describing a feature that does
  not exist. The surviving half (erase ceremony, single `gateway.db`) is kept as
  its own entry; the removal is recorded separately under *Removed* for #603.
- **The BACKUP-plane recovery kit survives; only the founding-ceremony kit
  surfaces died.** Docs were audited on that line specifically: `backup kit`,
  `centraid-gateway recover`, `RecoveryKitStateStore.begin/verify/status`, the
  Backup screen routes, and the erase gate's `recovery_kit_not_verified` refusal
  are all intact, so `README.md` L28, `ARCHITECTURE.md`'s custody table, and
  `SECURITY.md`'s KeyStore paragraph were qualified rather than deleted.
- **Erase-then-restart does NOT re-found — auto-found is guarded on "never
  inhabited".** Erasing every vault leaves the filesystem registry fresh but
  keeps `members`/`devices` rows in `gateway.db`, so `build-gateway.ts` only
  auto-founds when `isFresh()` **and** the `members` table is empty. A gateway
  awaiting restore-after-erase therefore boots with zero vaults (vault health
  `error`) instead of silently burying the restore under a brand-new
  `Shared` + `Personal`. Regression test: "an inhabited gateway whose vaults
  were all erased is NOT re-founded" in
  `packages/gateway/src/serve/build-gateway.test.ts`. The recovery docs still
  carry the warning for the belt-and-braces case of a hand-deleted
  `gateway.db`.
- **`ensureLocalGatewayActive` always calls `setActiveGateway({id:'local'})`,
  even when `local` is already the active id.** On a virgin install `local` IS
  the default active id, and `setActiveGateway` is the deliberate act that
  lifts the desktop's first-run gateway-start deferral — the conditional
  version deadlocked the "Start fresh" path against an empty gateway URL
  (caught live by desktop e2e §1.2). `packages/client/src/react/shell/routes/connectFlowIO.ts`.

## Steering

### Check 1: Every human-steering event in the session transcript is recorded as a row

**Verdict: PASS**

This session (#603 rethink) carried over from a prior session where the agent had analyzed the initial 13-gap audit and the user had provided high-level direction. In this continuation session, the user elaborated on task requirements (messages: "let's auto create two vaults...", "let's make founder explicitly create vaults...", "for your open questions...") but these are elaborations and clarifications of the already-defined task from the prior session, not mid-task corrections or interrupts that redirect agent work in flight during this session. The initial goal ("Let's rethink #603 from scratch...") is task assignment, not steering. No genuine steering events (interrupts or mid-task corrections) occur in this session's transcript, so there are no `### Steering` data rows to record.

### Check 2: No non-steering message is recorded as steering

**Verdict: PASS**

No steering rows have been recorded in the `## Accounting` → `### Steering` section below.

## Audit

Fresh-context auditor, no part in the implementation. Inputs: `gh issue view 603`,
the working tree (`git status --short`, `git diff`, `git diff --cached`), and this
receipt. Every evidence command below was re-run by the auditor, not taken on the
receipt's word.

### Check 1: "## What changed" faithfully describes the diff

**Verdict: PASS**

22 claims were sampled across gateway / protocol / client / desktop / web / mobile /
tests / CI, and every one resolves to real code in the tree:

- `build-gateway.ts` — `vaultRegistry.isFresh() && neverInhabited()` (a
  `SELECT COUNT(*) FROM members` probe) gates
  `[create('Shared'), create('Personal')]`. Both the members guard and the
  **Shared-before-Personal** ordering are real, and the UUIDv7/`defaultVaultId()`
  rationale is commented at the call site exactly as the Decisions section claims.
  `FRESH_GATEWAY_SCOPE_PREFIXES`, `recoverPendingFoundingVaults`, `initVaultName`,
  and `foundingHandler` are gone; the vault-health probe now returns
  `{status:'error', detail:'no vault is mounted'}` on zero planes.
- `canMintFoundingTicket` → `isHostCustody` rename present on the options
  interface and at the `embeddedAccess` call site; `kitlessHostIdentity` is now
  derived unconditionally (no `initVaultName` predicate).
- `gateway-db.ts` — `tickets.kind`, the `found`/`enroll` CHECK pair, the
  `one_founding_ticket` index, `founding_ticket_reservations`, the
  `recovery_kit.founding_pending` column, and both ad-hoc `ALTER TABLE` backfills
  are deleted; `member_id` / `grants_json` are now `NOT NULL`.
- `handshake.ts` + `gateway-info-routes.ts` — `status` and `foundingPending` are
  removed from `GatewayInfo`; **`authenticated: boolean`** is added, threaded
  through `buildGatewayInfoPayload` and parsed in `judgeGatewayInfo`.
  `protocol/src/routes.ts` drops all four named route constants.
- `device-admin.ts` — the **bearer-mismatch branch** is real and is a genuine
  three-way split: different-data-dir → `authenticated === false` (error naming
  `CENTRAID_GATEWAY_TOKEN` and `keys/endpoint-key.bin`) → missing `endpointTicket`
  (the old "iroh endpoint is not ready" message, now only for the true case).
- **`failedMounts` in all three surfaces**: `vault-admin.ts` (`--json` payload +
  stderr in text mode, exit code unchanged), `status-admin.ts` (`DataDirSummary`
  gains `failedMounts` + `vaultReadError`; the bare `catch {}` is replaced by a
  reported error), and `vault-routes.ts` (`GET /_vault/vaults` returns
  `failedMounts` alongside `vaults`; erase returns `remainingVaults`; the ticket
  cleanup no longer filters on the removed `kind` column).
- `devices-routes.ts` — the `isUninitialized` 409 gate is gone, replaced by
  `defaultVaultId()` with an addressability check before falling back.
- **SSH deletion** is a real deletion: `ssh-host.ts`, `ssh-host-core.ts`,
  `ssh-host-core.test.ts`, `gateway-ssh-connect.ts` are `D` in `git status`; a
  repo-wide `rg -ni '\bssh\b'` over `packages/client/src apps/desktop/src
  apps/web/src apps/mobile/src` returns only explanatory comments and one negative
  test assertion — no live code path.
- **Offline-banner gating** — `web-chrome.ts` `syncOnline` is
  `!navigator.onLine && onboardingComplete()`, and `web-state.ts` publishes a new
  `SETTINGS_EVENT` from `saveSettingsPatch` that the chrome subscribes to, so the
  banner re-evaluates on the stamp write. Both halves are present.
- Also verified: `settings.ts` first-run start deferral + `requestLocalGatewayStart`
  lifted by `setActiveGatewayId`; `main.ts` tray now `setTrayGatewayRunning(settings.gatewayUrl.length > 0)`;
  `gateway-monitor.ts` `inFirstRunSetup` suppression that still alerts on a *failed*
  settings read; `ipc-core.ts` `keychainPromptExpected` (unpackaged darwin + linux)
  and its render in `OnboardingScreen.tsx`; `FirstRunGate.tsx` branching on
  `isWebHost()` with a **two-button** chooser and web rendering `path="ticket"`
  directly; `boot.tsx` renaming the auto-founded `Personal` via `updateVault` on
  the `fresh` path only; `connectFlowIO.ts` typed `LocalVaultsResult` +
  `connectFreshLocalGateway` + `commitSsh` removal; `web-host.ts` dropping
  `createVault` and `sshConnectGateway` entirely; mobile `phone-link-parse.ts`
  deleting `GatewayFoundingPayload` and the `centraid-gw-found` branch;
  `tests/matrix.json` (`gateway-founding-journey` → `gateway-journey`,
  `backup-restore.concurrency` → `Skip`/`null` owner); and `.github/workflows/e2e.yml`
  removing the `pairing-founding` job and both `needs` references.

No claim was found that the diff does not support, and no invented file.

### Check 2: each `- [x]` item is realized in the diff

**Verdict: PASS**

Both acceptance evidence commands were re-run by the auditor:

- `rg -i "sshConnectGateway|centraid-gw-found|FoundingScreen" packages/ apps/` →
  **no matches** (exit 1), as claimed.
- `rg -n -- "--init-vault|init-ticket|initVaultName" packages/ apps/ tests/` → 7
  hits, judged individually: six are prose/comments that *narrate the removal*
  (`packages/gateway/README.md`, `apps/web/tests/e2e/server.ts`, the three
  `tests/agent-e2e-pairing/*.md` docs, `lib/harness.mjs:123`). The seventh is
  noted as a discrepancy below.

Spot-checked the other checked items against code rather than prose: two-option
chooser (two `<button>`s in `FirstRunGate.tsx`, no third); unified profile step
(`OnboardingScreen` takes `OnboardingPath` and collects displayName/avatarColor on
both); Personal rename (`boot.tsx`, guarded on `path === 'fresh' && vaultId`, and
deliberately non-fatal); `failedMounts` in CLI `--json` **and** HTTP; offline banner;
bearer-mismatch error; keychain note. All realized.

### Check 3: the `## Checklist` mirrors the issue's checklist

**Verdict: PASS**

Mechanically compared: the issue's 12 acceptance criteria appear as the receipt's
first 12 items, text-for-text. The two extra items (`check:pr:full` green,
governance receipt) are the standard house additions, not substitutions.

### File coverage (rule 6)

**PASS.** Every added/modified path in `git status --short` (excluding receipts
and the auto-maintained ledgers) is named in the receipt prose under the
directive's normalization. Zero unnamed files — no scope creep detected.

### Discrepancies (none refute the three checks above; the first blocks commit)

1. **Crosswalk rule 3 will fail as written.** Three checked items carry trailing
   italic parentheticals that are part of the item text but appear nowhere in
   `## What changed` / `## Verification`, so `receipt-per-issue`'s substring
   crosswalk violates on: *"Fresh desktop install: chooser … *(asserted live by
   `apps/desktop/tests/e2e/onboarding-home.spec.ts` §1.2 — 4/4 §1 specs green)*"*,
   *"After the founder completes the profile step … *(implemented in
   `packages/client/src/react/boot.tsx`; …)*"*, and *"`bun run check:pr:full` green
   *(full run on this tree …)*"*. Fix by echoing those exact spans in the crosswalk
   list (or moving the parentheticals into `## Verification` verbatim).
2. **Stale prose in `## Verification`.** It says the gate run and desktop e2e "are
   listed as pending at the bottom of this section and are the two unchecked
   acceptance items above" — there are no unchecked items, and the bottom of the
   section reports both runs as green. Contradicts itself.
3. **Test-file count contradiction.** The checklist says "448 test files / 3209
   tests"; `## Verification` says "447 test files / 3209 tests" for the same
   `check:pr:full` run. One of the two is wrong.
4. **Dead `init-ticket` branch left behind.** `tests/agent-e2e-pairing/lib/harness.mjs:266`
   still special-cases `args[0] === 'init-ticket'` when appending `--port`, for a
   subcommand this change set deleted. Harmless but dead; the receipt does not
   claim it was removed, so this is a code nit rather than a false claim.

**Overall verdict: PASS** on faithfulness, realization, and checklist mirroring.
Items 1–3 above are receipt-authoring defects to fix before commit (item 1 will
hard-fail the pre-commit directive); item 4 is a code follow-up.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Steering

### Costs
| claude-code-1d770839-7af-1785228048-1 | claude-code | 1d770839-7af1-4254-b370-8cbfa295dd3b | #603 | claude-fable-5 | 641 | 853520 | 60162223 | 313210 | 1167371 | 86.4981 | 641 | 853520 | 60162223 | 313210 | feat(onboarding)!: auto-found fresh gateways, ticket-only clients, retire SSH +  |
| claude-code-1d770839-7af-1785228120-1 | claude-code | 1d770839-7af1-4254-b370-8cbfa295dd3b | #603 | claude-fable-5 | 2 | 877 | 303625 | 596 | 1475 | 0.3444 | 643 | 854397 | 60465848 | 313806 | feat(onboarding)!: auto-found gateways, ticket-only clients, retire SSH + foundi |
