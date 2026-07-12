# issue-382 — rethink onboarding + switcher around (gateway, vault), with SSH host support

GitHub issue: [#382](https://github.com/srikanth235/centraid/issues/382)

Follow-up to #376/#289. Onboarding and "add gateway" each handled only
one connect scenario, gateway/vault management was split between the
switcher and Settings, there was no connectivity test when a user
supplied a gateway, and there was no way to reach a gateway host over
SSH — pairing required manually SSHing in, running the CLI, and pasting
the ticket by hand. This rebuilds onboarding and the switcher around a
shared connect wizard covering all three connect scenarios (this
device, existing gateway, over SSH), moves (gateway, vault) management
entirely into the switcher, scopes Settings to the active pair, and
adds a connectivity test that runs whenever the user supplies gateway
coordinates.

## Checklist

- [x] Gateway CLI JSON output and status subcommand
- [x] SSH admin channel to the gateway host
- [x] Gateway connectivity test (handshake ladder)
- [x] Shared ConnectFlow wizard for onboarding and switcher
- [x] Grouped (gateway, vault) switcher as the home of pair management
- [x] Settings scoped to the active vault
- [x] Real-Electron E2E coverage

## What changed

### Gateway CLI JSON output and status subcommand

- `packages/gateway/src/cli/json-cli.ts` (new): shared `--json` error
  contract (`jsonFail`/`runJson`/`CliJsonError`) so every JSON-capable
  subcommand emits a single JSON line on success and `{ok:false, error,
  message}` with a non-zero exit on failure, without disturbing the
  existing human-readable output path.
- `packages/gateway/src/cli/device-admin.ts`: `pair --json` emits
  `{ok, ticket, vaultId, vaultName, expiresAt}`.
- `packages/gateway/src/cli/vault-admin.ts`: `vault list --json` and
  `vault create --json` emit `{ok, vaults:[...]}` / `{ok, vaultId,
  name}`.
- `packages/gateway/src/cli/status-admin.ts` (new): new `status
  [--json]` subcommand — service-supervision status (reuses
  `service-admin.ts`) plus a data-dir summary (existence, endpoint
  identity, vault count). No HTTP liveness probe: `serve()` never
  persists its bound host/port to disk, so a liveness check would have
  to guess a port — omitted rather than guessed.
- `packages/gateway/src/cli/cli.ts`: usage text and dispatch table
  updated for `status` and the new `--json` flags.
- `packages/gateway/src/cli/service-admin.ts`: additive
  `queryServiceStatus` export reused by `status-admin.ts`.

### SSH admin channel to the gateway host

- `apps/desktop/src/main/ssh-host-core.ts` (new): pure core — builds
  the `ssh -o BatchMode=yes -o ConnectTimeout=8 -o
  StrictHostKeyChecking=accept-new <destination> -- <remote command>`
  argv from a whitelisted, properly quoted command set, validates
  destination format (rejects shell metacharacters), and parses
  JSON-or-ticket output from the remote CLI (tolerant of leading MOTD
  noise — scans for the last valid JSON line). Maps failures to stable
  codes (`ssh_unreachable`, `ssh_auth`, `cli_not_found`, `daemon_error`,
  `bad_output`).
- `apps/desktop/src/main/ssh-host.ts` (new): impure spawn wrapper —
  `spawn(sshBin, args)` with an `AbortSignal` timeout, following the
  spawn patterns already used for coding-agent CLIs in
  `packages/agent-runtime`. `sshBin` defaults to `ssh`, overridable via
  `CENTRAID_SSH_BIN` (the E2E seam — no real network SSH is exercised
  in this repo's test rig). Remote CLI path defaults to
  `centraid-gateway`, overridable per profile.
- `apps/desktop/src/main/gateway-ssh-connect.ts` (new):
  `sshConnectGateway`/`sshEnrollIntoVault` — optionally `vault create
  --json` over SSH, then `pair --vault <id> --json` over SSH, then
  redeems the returned ticket through the EXISTING iroh
  `redeemGatewayPairing` path (`apps/desktop/src/main/gateway-pairing.ts`)
  so the device-key-equals-dial-key invariant and profile
  creation/reuse/active-switch logic are 100% reused rather than
  duplicated.
- `apps/desktop/src/main/gateway-store.ts`: `GatewayProfile` gains an
  optional `ssh?: { destination; dataDir?; remoteCli? }` block
  (persisted in `profile.json`, no secrets) plus an `updateGatewaySsh`
  updater, so later admin operations (e.g. creating a vault from the
  switcher) know a gateway is SSH-capable.
- `apps/desktop/src/main/ipc.ts`: `VAULTS_CREATE` now routes over SSH
  (create + enroll via the same helper as the connect flow) for a
  gateway whose profile carries an `ssh` block, while a plain remote
  gateway keeps the existing "run `centraid-gateway vault …` over SSH"
  refusal. `VAULTS_DELETE` stays local-only (symmetric SSH delete
  wasn't in this issue's CLI scope).

### Gateway connectivity test (handshake ladder)

- `apps/desktop/src/main/gateway-connectivity-core.ts` (new): pure
  fold logic building a staged `ConnectivityReport` — per-input-kind
  stage sets (`url`: reach → identify → auth → vaults; `ticket`: decode
  only; `ssh`: ssh → cli → daemon → vaults; `gateway`: resolves the
  profile then runs the `url` stages).
- `apps/desktop/src/main/gateway-connectivity.ts` (new): impure
  orchestrator wiring the report core to the previously-orphaned
  `handshakeGateway` (`apps/desktop/src/main/version-handshake.ts` —
  hits `/centraid/_gateway/info`, checks version/schema-epoch
  compatibility) and `fetchGatewayVaults`, plus the new `ssh-host`
  probes for the `ssh` stage set. Never throws — every failure is a
  failed stage with an actionable detail, not an exception.
  `assertDirectUrlAllowed` is applied to `url` inputs so a disallowed
  plain-HTTP target fails the `reach` stage with its existing guardrail
  message instead of throwing.
- `apps/desktop/src/main/version-handshake.ts`: `GatewayInfo` gains an
  optional `instanceId` field, threaded through from
  `/centraid/_gateway/info`.

### Shared ConnectFlow wizard for onboarding and switcher

- `apps/desktop/src/renderer/react/shell/routes/connectFlow-core.ts`
  (new): pure state machine — `method → details → test → vault →
  committing → done | error` — covering all three connect scenarios
  (this device / existing gateway via ticket-or-URL / over SSH).
- `apps/desktop/src/renderer/react/shell/routes/connectFlowIO.ts`
  (new): impure IO layer calling `testGatewayConnection` /
  `redeemGatewayPairing` / `addGateway` / `sshConnectGateway`, reusing
  `gatewayModals.ts`'s existing `connectGateway()` for the ticket/URL
  paths rather than duplicating them.
- `apps/desktop/src/renderer/react/shell/routes/HandshakeLadder.tsx`
  (new, + `.module.css`): renders a `ConnectivityReport` as a vertical
  staged checklist with staggered reveals and a drawing rail,
  `prefers-reduced-motion`-guarded.
- `apps/desktop/src/renderer/react/shell/routes/ConnectFlow.tsx` (new,
  + `.module.css`): the wizard itself — method cards (tileFinish
  gradients), effects orchestrating the test/vault/commit steps, and the
  outer step switch. The 'details' step's two per-method panels and the
  'vault' step are split into
  `apps/desktop/src/renderer/react/shell/routes/ConnectFlowDetailsStep.tsx`
  and `ConnectFlowVaultStep.tsx` (new) purely to keep `ConnectFlow.tsx`
  under the repo's 500-line file-size cap — pure presentation, no logic
  beyond what `ConnectFlow.tsx`'s effects already orchestrate.
- `apps/desktop/src/renderer/react/shell/routes/ConnectFlowModal.tsx`
  (new): the switcher's "Add gateway" dialog wrapper around
  `ConnectFlow` with `methods={['gateway','ssh']}` (no "This Mac" —
  it's always already registered). Replaces the deleted `GatewayModal`.
- Deleted: `GatewayModal.tsx`/`.test.tsx` and
  `GatewayPairingForm.tsx`/`.test.tsx`/`.module.css` — fully absorbed
  into `ConnectFlow`.

### Grouped (gateway, vault) switcher as the home of pair management

- `apps/desktop/src/renderer/react/shell/flatVaultSwitcher-core.ts`:
  added `GroupedSwitcherGateway`/`buildGroupedRows` — one header row
  per gateway (label, transport badge including `'SSH'`, status) with
  nested, sorted vault rows and a `canCreateVault` capability flag
  (true for local and SSH-capable gateways). The prior flat-row
  functions (`buildFlatRows`/`sortFlatRows`/`buildSortedFlatRows`) are
  now dead — superseded by the grouped model — and were removed along
  with their tests; `applyFetchOutcome`/`GatewayVaultCache` and the
  selection helpers (`resolveSelection`/`applySelection`) are unchanged
  and still shared.
- `apps/desktop/src/renderer/react/shell/flatVaultSwitcherRegistry.ts`:
  added `openGroupedVaultRegistry`/`getCachedGroupedRows`/
  `refreshGroupedGateway`; the flat-specific `openFlatVaultRegistry`/
  `getCachedFlatRows` were removed (dead alongside the flat core
  functions above) while `fetchGateways`/`refreshOneGateway` stay
  shared.
- `apps/desktop/src/renderer/react/shell/vaultSwitcher.ts` (+
  `.module.css`): full grouped-rendering rewrite — per-gateway status
  rail, nested vault rows, a "+ New space…" action (gated by
  `canCreateVault`), and an overflow menu (Test connection… / Rename…
  / Remove — Remove hidden for `'local'`); footer "Add gateway…" opens
  `ConnectFlowModal`. The old "Manage spaces" delegation to Settings is
  gone — the switcher now owns management directly.
- `apps/desktop/src/renderer/react/shell/routes/RenameGatewayModal.tsx`
  and `TestConnectionModal.tsx` (new, + tests): the switcher's overflow
  actions — rename via the existing `renameGateway` IPC, and a
  standalone connectivity-test dialog reusing `HandshakeLadder` against
  `testGatewayConnection({kind:'gateway', gatewayId})`.
- `apps/desktop/src/renderer/react/shell/App.tsx`: wires the grouped
  registry and the four new action modals (ConnectFlow/Rename/Test
  Connection/confirm-remove) into the switcher popover's callbacks.
- **Bug found and fixed during E2E**: the overflow menu ("Test
  connection…"/"Rename…"/"Remove") opened `contextMenu.ts` on top of
  the still-open switcher popover, whose transparent scrim sat above
  it in z-index and swallowed every click, making the menu completely
  unusable. Every other switcher action already closed the popover
  first; this one didn't — fixed in `vaultSwitcher.ts`'s `moreBtn`
  handler by calling `closeVaultSwitcher()` before opening the menu.

### Settings scoped to the active vault

- `apps/desktop/src/renderer/react/screens/SettingsSpaceScreen.tsx`
  (new): replaces the deleted `SettingsProfilesScreen.tsx` — edits
  ONLY the active vault (name/icon/color/blurb/delete where allowed);
  no cross-vault list, no gateway "Connections" group.
- `apps/desktop/src/renderer/react/shell/routes/SettingsRoute.tsx`:
  nav updated from "Spaces" to "Space", pointed at the new screen.
- `apps/desktop/src/renderer/react/shell/routes/settingsAccountData.ts`:
  `loadProfilesData` replaced by `loadActiveSpaceData`.
- `apps/desktop/src/renderer/react/shell/routes/spaceModals.ts`: dead
  `loadSpaceInitial` (cross-vault list loader) dropped; create/save/
  delete helpers unchanged and reused by the new Space page and the
  switcher's "+ New space" action.
- `apps/desktop/src/renderer/react/boot.tsx`: `onComplete` now writes
  `displayName`/`avatarColor` to whichever gateway `ConnectFlow`
  actually connected during onboarding, instead of always writing to
  the `'local'` profile (a latent bug from the #376 onboarding step —
  connecting to a remote gateway in onboarding never recorded the
  chosen name/color anywhere).
- `apps/desktop/src/renderer/react/screens/OnboardingScreen.tsx` (+
  `.module.css`): now two steps — identity (name+color, unchanged) →
  "Where does your data live?" method cards, embedding `ConnectFlow`.
  "This Mac" auto-commits near-instantly (no details/test step needed
  for the always-already-registered embedded gateway).

### Real-Electron E2E coverage

- `apps/desktop/tests/e2e-live/flows-shell-v2-01-onboarding.mjs`:
  rewritten for the 2-step onboarding flow; the display-name
  persistence check now reads `gateways/local/profile.json` directly
  (the actual ground truth for the bug fix above), since `displayName`
  has no remaining UI surface after the Settings→Spaces removal.
- `apps/desktop/tests/e2e-live/flows-shell-v2-02-vaults-settings.mjs`:
  rewritten to create/switch/delete a space through the switcher's
  "+New space"/vault-row/overflow-menu actions instead of the deleted
  Settings→Spaces "Add profile" UI; added coverage for editing the
  active vault in Settings→Space and for the switcher's "Test
  connection…"/"Rename…" actions.
- `apps/desktop/tests/e2e-live/flows-shell-v2-05-ssh-connect.mjs`
  (new): drives a real second `centraid-gateway serve` process plus a
  `CENTRAID_SSH_BIN` stub that execs the real CLI locally in place of
  network SSH — full handshake ladder (ssh/cli/daemon/vaults, all real
  subprocess calls) through the switcher's "Over SSH" ConnectFlow path,
  creating a new space over SSH and landing on it as the active pair.
- `apps/desktop/tests/e2e-live/flows-shell-v2-06-url-connect.mjs`
  (new): same real second-gateway trick exercising the "Existing
  gateway" URL path — a wrong port fails the `reach` stage with an
  actionable message, the correct URL + admin bearer token passes all
  four stages.
- `apps/desktop/tests/e2e-live/driver.mjs`: `launchApp()` gained an
  `env` option so a flow can inject `CENTRAID_SSH_BIN` (and future
  SSH-adjacent env) into the launched Electron process.
- `apps/desktop/tests/e2e-live/verify-08-vault-switch-pins.mjs` and
  `flows-shell-03-search-star-settings.mjs`: fixed stale
  Settings→Spaces / "Add profile" references to match the new UI
  (`'Space'` nav label, switcher-driven space creation).
- **Bug found and fixed during E2E**: deleting the *active* vault via
  `VAULTS_DELETE` never broadcast `VAULT_CHANGED`, so the switcher/
  sidebar kept showing the just-deleted space until an unrelated event
  happened to refresh it — every other vault-mutating IPC handler
  already broadcasts on change; this one didn't. Fixed in
  `apps/desktop/src/main/ipc.ts`'s `VAULTS_DELETE` handler by
  capturing the new active vault id from `setActiveVaultId(undefined)`
  and calling `broadcastVaultChanged(next)` after the delete.

### Files

New:
- `packages/gateway/src/cli/json-cli.ts`
- `packages/gateway/src/cli/status-admin.ts`
- `packages/gateway/src/cli/status-admin.test.ts`
- `apps/desktop/src/main/ssh-host-core.ts`
- `apps/desktop/src/main/ssh-host-core.test.ts`
- `apps/desktop/src/main/ssh-host.ts`
- `apps/desktop/src/main/gateway-connectivity-core.ts`
- `apps/desktop/src/main/gateway-connectivity-core.test.ts`
- `apps/desktop/src/main/gateway-connectivity.ts`
- `apps/desktop/src/main/gateway-ssh-connect.ts`
- `apps/desktop/src/renderer/react/shell/routes/connectFlow-core.ts`
- `apps/desktop/src/renderer/react/shell/routes/connectFlow-core.test.ts`
- `apps/desktop/src/renderer/react/shell/routes/connectFlowIO.ts`
- `apps/desktop/src/renderer/react/shell/routes/HandshakeLadder.tsx`
- `apps/desktop/src/renderer/react/shell/routes/HandshakeLadder.module.css`
- `apps/desktop/src/renderer/react/shell/routes/ConnectFlow.tsx`
- `apps/desktop/src/renderer/react/shell/routes/ConnectFlow.module.css`
- `apps/desktop/src/renderer/react/shell/routes/ConnectFlowDetailsStep.tsx`
- `apps/desktop/src/renderer/react/shell/routes/ConnectFlowVaultStep.tsx`
- `apps/desktop/src/renderer/react/shell/routes/ConnectFlow.test.tsx`
- `apps/desktop/src/renderer/react/shell/routes/ConnectFlowModal.tsx`
- `apps/desktop/src/renderer/react/shell/routes/RenameGatewayModal.tsx`
- `apps/desktop/src/renderer/react/shell/routes/RenameGatewayModal.test.tsx`
- `apps/desktop/src/renderer/react/shell/routes/TestConnectionModal.tsx`
- `apps/desktop/src/renderer/react/shell/routes/TestConnectionModal.test.tsx`
- `apps/desktop/src/renderer/react/screens/SettingsSpaceScreen.tsx`
- `apps/desktop/tests/e2e-live/flows-shell-v2-05-ssh-connect.mjs`
- `apps/desktop/tests/e2e-live/flows-shell-v2-06-url-connect.mjs`
- `receipts/issue-382-onboarding-gateway-vault-switch.md` (this receipt)

Modified:
- `packages/gateway/src/cli/cli.ts`
- `packages/gateway/src/cli/device-admin.ts`
- `packages/gateway/src/cli/vault-admin.ts`
- `packages/gateway/src/cli/service-admin.ts`
- `packages/gateway/src/cli/admin.test.ts`
- `apps/desktop/src/main/gateway-store.ts`
- `apps/desktop/src/main/ipc.ts`
- `apps/desktop/src/main/version-handshake.ts`
- `apps/desktop/src/preload.ts`
- `apps/desktop/src/renderer/centraid-api.d.ts`
- `apps/desktop/src/renderer/react/boot.tsx`
- `apps/desktop/src/renderer/react/screen-contracts.ts`
- `apps/desktop/src/renderer/react/screens/OnboardingScreen.tsx`
- `apps/desktop/src/renderer/react/screens/OnboardingScreen.test.tsx`
- `apps/desktop/src/renderer/react/screens/OnboardingScreen.module.css`
- `apps/desktop/src/renderer/react/shell/App.tsx`
- `apps/desktop/src/renderer/react/shell/flatVaultSwitcher-core.ts`
- `apps/desktop/src/renderer/react/shell/flatVaultSwitcher-core.test.ts`
- `apps/desktop/src/renderer/react/shell/flatVaultSwitcherRegistry.ts`
- `apps/desktop/src/renderer/react/shell/flatVaultSwitcherRegistry.test.ts`
- `apps/desktop/src/renderer/react/shell/vaultSwitcher.ts`
- `apps/desktop/src/renderer/react/shell/vaultSwitcher.module.css`
- `apps/desktop/src/renderer/react/shell/vaultSwitcher.test.ts`
- `apps/desktop/src/renderer/react/shell/routes/SettingsRoute.tsx`
- `apps/desktop/src/renderer/react/shell/routes/settingsAccountData.ts`
- `apps/desktop/src/renderer/react/shell/routes/spaceModals.ts`
- `apps/desktop/src/renderer/react/shell/routes/spaceModals.test.ts`
- `apps/desktop/tests/e2e-live/driver.mjs`
- `apps/desktop/tests/e2e-live/flows-shell-v2-01-onboarding.mjs`
- `apps/desktop/tests/e2e-live/flows-shell-v2-02-vaults-settings.mjs`
- `apps/desktop/tests/e2e-live/verify-08-vault-switch-pins.mjs`
- `apps/desktop/tests/e2e-live/flows-shell-03-search-star-settings.mjs`

Deleted:
- `apps/desktop/src/renderer/react/screens/SettingsProfilesScreen.tsx`
- `apps/desktop/src/renderer/react/screens/SettingsProfilesScreen.test.tsx`
- `apps/desktop/src/renderer/react/screens/SettingsProfilesScreen.module.css`
- `apps/desktop/src/renderer/react/shell/routes/GatewayModal.tsx`
- `apps/desktop/src/renderer/react/shell/routes/GatewayModal.test.tsx`
- `apps/desktop/src/renderer/react/shell/routes/GatewayPairingForm.tsx`
- `apps/desktop/src/renderer/react/shell/routes/GatewayPairingForm.test.tsx`
- `apps/desktop/src/renderer/react/shell/routes/GatewayPairingForm.module.css`

## Decisions

- **SSH is an admin channel in v0, not a transport tier.** SSH shells
  out to the system `ssh` binary to drive the gateway CLI remotely
  (probe status, list/create vaults, mint a pairing ticket), then
  redeems that ticket through the existing iroh path — the ongoing
  data-plane connection is iroh, not an SSH tunnel. An `ssh -N -L`
  port-forward as a fourth `GatewayTransport` tier (so the ongoing
  connection itself rides SSH) is a natural follow-up but out of scope
  here; the guardrail comment in `transport.ts` already namechecks
  that pattern for a future implementer.
- **Shelling to the system `ssh` binary, not an SSH library.** Inherits
  the user's `~/.ssh/config`, agent, `ProxyJump`, and known_hosts for
  free, and matches the existing precedent of shelling to OS binaries
  (`launchctl`/`systemctl` in `service-admin.ts`) rather than
  reimplementing protocol handling in-process.
- **SSH-routed vault creation flips the active (gateway, vault)
  atomically**, unlike local creation which does not auto-activate.
  This is intentional, not an inconsistency: enrollment via a pairing
  ticket is how a remote device gains access to a vault at all, so the
  enroll-and-activate step that `redeemGatewayPairing` already performs
  is the correct behavior here too.
- **`status` never attempts an HTTP liveness probe.** `serve()` does
  not persist its bound host/port anywhere on disk (confirmed by
  reading the daemon layout), so a liveness check would have to guess a
  port. Omitted rather than guessed; the CLI reports service-supervision
  status and data-dir/endpoint identity only.
- **Old flat-switcher core/registry functions were removed, not kept
  alongside the grouped ones.** They became dead code the moment the
  grouped switcher shipped (verified via grep against
  `apps/desktop/src/renderer/react/shell/App.tsx`, the only production
  consumer) — leaving unused, tested-but-unreachable code in a redesign
  PR would be sloppy rather than a defensible compatibility shim.
- **`displayName` has no remaining UI surface post-redesign.** It used
  to show in the deleted Settings→Spaces "Connections" gateway row;
  nothing replaces that surface. The onboarding bug fix (write to the
  connected gateway, not always `'local'`) is still correct and worth
  keeping — a future issue can decide where, if anywhere, the name
  should be shown.

## Out of scope

- `ssh -N -L` port-forward as a `GatewayTransport` tier (SSH stays an
  admin/bootstrap channel; ongoing traffic rides iroh).
- Real network SSH authentication (host keys, passwords, 2FA) — the
  E2E rig exercises the SSH code path via a `CENTRAID_SSH_BIN` local-exec
  stub, not a real SSH server.
- `vault delete --json` / SSH-routed `VAULTS_DELETE` (delete stays
  local-only; only create was extended to route over SSH).
- A UI surface for the person's chosen display name (see Decisions).
- Sidebar head live-refresh after a Settings→Space edit (pre-existing
  gap, not a regression of this redesign — flagged as a follow-up task
  rather than fixed inline).
- Attention badges, version-mismatch rows, and MRU ordering in the
  switcher (#289 §7 tail, already deferred by #376).

## Verification

Full desktop + gateway package suites, typecheck, and lint on the
combined diff, then a real-Electron E2E pass (including two live
gateway processes: the embedded local one and a spawned standalone
`centraid-gateway serve`) with every screenshot read as ground truth.

```
bunx vitest run src/main src/renderer/react   # apps/desktop
  → 97 files, 788 tests passed

bunx vitest run packages/gateway
  → 72 files, 498 passed | 2 skipped (darwin-only / tsx-not-found), 1 flaky
    (apps-store-routes rollback test — passes in isolation, unrelated to
    this change set, reproduces the same way on an unrelated file when
    run in parallel on main)

bun run --filter '@centraid/desktop' typecheck   → exit 0
bun run --filter '@centraid/gateway' typecheck   → exit 0

bunx oxlint apps/desktop/src/main apps/desktop/src/renderer/react \
  apps/desktop/src/preload.ts apps/desktop/src/renderer/centraid-api.d.ts \
  packages/gateway/src/cli
  → 8 pre-existing errors, all in untouched SettingsStorageScreen.tsx /
    StorageCard.test.tsx (storage feature, matches the known-red
    baseline on main), zero in any file this change set touches

bunx oxfmt --check <58 touched/new files>   → all correctly formatted
```

Real Electron (`_electron.launch()`, Playwright, fresh userData,
screenshots read back): 2-step onboarding (identity → method cards,
"This Mac" auto-commits) verified end to end including persistence
across relaunch; switcher-driven space create/switch/delete/rename/
test-connection all verified working (two real bugs found and fixed in
the process — see What changed); a real second standalone
`centraid-gateway serve` process paired over the "Over SSH" ConnectFlow
path via a `CENTRAID_SSH_BIN` local-exec stub, full handshake ladder
passing, new space created over SSH, switcher correctly showing two
gateways with the new one active; the same second gateway paired over
the "Existing gateway" URL path — wrong port fails the `reach` stage
with an actionable message, correct URL + admin token passes all four
stages and completes; Settings→Space confirmed scoped to only the
active vault with no cross-vault list or gateway management remaining.

## Audit

PASS — fresh-context audit against `git status --short` (tracked +
untracked), `gh issue view 382`, this receipt, and the live working
tree. All 7 checklist items are realized in the diff: `--json`/`status`
land in `packages/gateway/src/cli/{json-cli,status-admin,device-admin,
vault-admin,cli}.ts`; the SSH admin channel exists as
`apps/desktop/src/main/{ssh-host-core,ssh-host,gateway-ssh-connect}.ts`
and is wired into `ipc.ts`'s `VAULTS_CREATE`; the connectivity test
exists as `gateway-connectivity-core.ts`/`gateway-connectivity.ts` and
reuses `version-handshake.ts`'s `handshakeGateway` exactly as claimed;
`ConnectFlow.tsx`/`connectFlow-core.ts`/`ConnectFlowModal.tsx` are
present, imported by both `OnboardingScreen.tsx` and the switcher path
via `App.tsx`; `flatVaultSwitcher-core.ts` contains
`GroupedSwitcherGateway`/`buildGroupedRows` and no longer exports
`buildFlatRows`/`sortFlatRows`/`buildSortedFlatRows` (confirmed
removed); `SettingsSpaceScreen.tsx` exists and
`SettingsProfilesScreen.tsx` is deleted; the two new E2E flows
(`flows-shell-v2-05-ssh-connect.mjs`,
`flows-shell-v2-06-url-connect.mjs`) are present and reference a real
second `centraid-gateway serve` invocation and a `CENTRAID_SSH_BIN`
override, not a mocked gateway. File coverage: every path in this
receipt's New/Modified/Deleted lists matches `git status --short`
exactly (self-referential receipt line excluded); no phantom entries,
no omissions. The two E2E-discovered bugs (VAULTS_DELETE missing
broadcast, switcher overflow-menu z-index/scrim trap) are both
described in What changed with the exact fix location and both are
present in the diff at `apps/desktop/src/main/ipc.ts`'s `VAULTS_DELETE`
handler and `apps/desktop/src/renderer/react/shell/vaultSwitcher.ts`'s
`moreBtn` handler respectively. Deferred/out-of-scope items (SSH as a
transport tier, real network SSH auth, SSH-routed delete, displayName
UI surface, sidebar live-refresh, switcher attention badges/MRU) are
honestly listed under Out of scope rather than silently dropped. No
implementation defects found.

## Steering

PASS — session ran as an orchestrator delegating to background sonnet
subagents (three parallel exploration agents, then a backend
implementation agent and a renderer implementation agent working
concurrently against a frozen IPC contract, then a real-Electron E2E
verification-and-fix agent) with no operator interrupts or corrections
after the initial task assignment. The one user turn between
assignment and this receipt was a `/model` slash-command switching the
interactive session's model (a tooling/UI action, not a steering
instruction to the agent) plus routine background-task completion
notifications.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs
| claude-code-f4f73ee6-029-1783848429-1 | claude-code | f4f73ee6-029f-44a0-a236-a5a8a9810504 | #382 | claude-sonnet-5 | 44340 | 1025223 | 25813707 | 207503 | 1277066 | 14.8343 | 44340 | 1025223 | 25813707 | 207503 | feat(gateway,desktop): SSH admin channel + gateway connectivity test (#382)Adds  |
| claude-code-f4f73ee6-029-1783848576-1 | claude-code | f4f73ee6-029f-44a0-a236-a5a8a9810504 | #382 | claude-sonnet-5 | 9093 | 27526 | 8970767 | 12272 | 48891 | 3.0058 | 53433 | 1052749 | 34784474 | 219775 | feat(gateway,desktop): SSH admin channel + gateway connectivity test (#382)Adds  |
| claude-code-f4f73ee6-029-1783848633-1 | claude-code | f4f73ee6-029f-44a0-a236-a5a8a9810504 | #382 | claude-sonnet-5 | 8 | 8236 | 1081388 | 4426 | 12670 | 0.4217 | 53441 | 1060985 | 35865862 | 224201 | feat(desktop): unify onboarding + switcher around (gateway, vault) (#382)Onboard |
| claude-code-f4f73ee6-029-1783848915-1 | claude-code | f4f73ee6-029f-44a0-a236-a5a8a9810504 | #382 | claude-sonnet-5 | 14761 | 92741 | 16017862 | 28252 | 135754 | 5.6212 | 68202 | 1153726 | 51883724 | 252453 | feat(desktop): unify onboarding + switcher around (gateway, vault) (#382)Onboard |
| claude-code-f4f73ee6-029-1783848976-1 | claude-code | f4f73ee6-029f-44a0-a236-a5a8a9810504 | #382 | claude-sonnet-5 | 604 | 8808 | 2907126 | 2917 | 12329 | 0.9507 | 68806 | 1162534 | 54790850 | 255370 | feat(desktop): unify onboarding + switcher around (gateway, vault) (#382)Onboard |
| claude-code-f4f73ee6-029-1783849019-1 | claude-code | f4f73ee6-029f-44a0-a236-a5a8a9810504 | #382 | claude-sonnet-5 | 8182 | 12256 | 1305474 | 1434 | 21872 | 0.4837 | 76988 | 1174790 | 56096324 | 256804 | test(desktop): real-Electron E2E for the (gateway, vault) redesign (#382)Rewrite |
