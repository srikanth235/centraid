# Issue #657 — Pre-v0 purge

## Checklist

- [x] Collapse the vault schema migration ladder to one composed pre-release rung; omit `people_merge` from the base schema.
- [x] Remove obsolete vault repair functions and the one-shot mobile storage/link migrations.
- [x] Make the gateway handshake capabilities complete and required; remove the retired schema-epoch compatibility surface.
- [x] Remove the desktop monitor `/info` liveness fallback and the mobile legacy pending-upload wording.
- [x] Remove the journal-archive full-VACUUM fallback while retaining open-time conversion for pre-#438 journal files.
- [x] Delete unused automation, Sidebar, Insights, and cursor-engine compatibility APIs.
- [x] Retire the stale desktop live smoke harness and document the live-adapter smoke cadence.
- [x] Narrow Knip’s root test scope and fix secure-storage error swallowing.

## What changed

This pre-v0 cleanup leaves one vault schema migration rung, with the current tables composed directly into the base schema and no `people_merge` table. The gateway protocol now exposes one required capabilities map alongside the protocol version; schema-epoch aliases, handshake fallbacks, and desktop `/info` probing are gone. Mobile secure storage no longer performs AsyncStorage migration or hides read/write failures.

Deprecated runtime/UI aliases and unused automation APIs were deleted. Archive reclamation now uses incremental mode only; the vault open path still converts any pre-#438 journal files before archival, which protects old files without preserving an archive-time legacy-file fallback. No committed vault data or fixtures require the removed fallback.

The implementation covers these checked slices:

- Collapse the vault schema migration ladder to one composed pre-release rung; omit `people_merge` from the base schema.
- Remove obsolete vault repair functions and the one-shot mobile storage/link migrations.
- Make the gateway handshake capabilities complete and required; remove the retired schema-epoch compatibility surface.
- Remove the desktop monitor `/info` liveness fallback and the mobile legacy pending-upload wording.
- Remove the journal-archive full-VACUUM fallback while retaining open-time conversion for pre-#438 journal files.
- Delete unused automation, Sidebar, Insights, and cursor-engine compatibility APIs.
- Retire the stale desktop live smoke harness and document the live-adapter smoke cadence.
- Narrow Knip’s root test scope and fix secure-storage error swallowing.

### Changed files

The affected files are listed here so the receipt stays aligned with the complete diff:

```text
TESTING.md
apps/desktop/src/main/gateway-connectivity-core.test.ts
apps/desktop/src/main/gateway-connectivity-core.ts
apps/desktop/src/main/gateway-monitor-core.test.ts
apps/desktop/src/main/gateway-monitor-core.ts
apps/desktop/src/main/gateway-monitor-probe.ts
apps/desktop/src/main/gateway-monitor-version-skew.test.ts
apps/desktop/src/main/gateway-monitor.ts
apps/desktop/src/main/gateway-outage-log-core.test.ts
apps/desktop/src/main/gateway-outage-log-core.ts
apps/desktop/src/main/version-handshake.test.ts
apps/desktop/src/main/version-handshake.ts
apps/desktop/tests/e2e-live/README.md
apps/desktop/tests/e2e-live/driver.mjs
apps/desktop/tests/e2e-live/iframe-probe.mjs
apps/desktop/tests/e2e-live/smoke.mjs
apps/desktop/tests/e2e/README.md
apps/mobile/src/lib/replica/mobile-gateway-compatibility.integration.test.ts
apps/mobile/src/lib/replica/mobile-gateway-compatibility.test.ts
apps/mobile/src/lib/secure-storage.test.ts
apps/mobile/src/lib/secure-storage.ts
apps/mobile/src/lib/vault-links.ts
apps/mobile/src/screens/PhoneStorage.tsx
apps/web/src/iroh-transport.ts
apps/web/tests/e2e/perf-waterfall.spec.ts
docs/protocol.md
knip.json
packages/design/src/kit.test.ts
packages/app-engine/src/conversation/archive/engine.ts
packages/app-engine/src/conversation/archive/prune.ts
packages/app-engine/src/conversation/archive/types.ts
packages/app-engine/src/conversation/store.ts
packages/app-engine/src/insights/index.ts
packages/automation/src/fire/cursor-engine-support.test.ts
packages/automation/src/fire/cursor-engine-support.ts
packages/automation/src/fire/cursor-engine.ts
packages/cli/src/cli.contract.test.ts
packages/cli/src/cli.integration.test.ts
packages/cli/src/cli.ts
packages/cli/src/client.test.ts
packages/client/src/centraid-api.d.ts
packages/client/src/gateway-client-contract-fixtures.ts
packages/client/src/react/screens/GatewayScreen.test.tsx
packages/client/src/react/screens/GatewayScreen.tsx
packages/client/src/react/shell/App.tsx
packages/client/src/react/shell/Sidebar.tsx
packages/client/src/react/shell/navModel.ts
packages/client/src/react/shell/routes/AutomationViewRoute.test.tsx
packages/client/src/react/shell/routes/TestConnectionModal.test.tsx
packages/client/src/react/shell/routes/connectFlow-core.ts
packages/client/src/react/shell/sidebarApps.test.ts
packages/client/src/react/shell/sidebarApps.ts
packages/client/src/version-handshake.test.ts
packages/client/src/version-handshake.ts
packages/gateway/src/cli/endpoint-host.ts
packages/gateway/src/index.ts
packages/gateway/src/serve/gateway-diagnostics.test.ts
packages/gateway/src/serve/gateway-diagnostics.ts
packages/gateway/src/serve/serve.test.ts
packages/gateway/src/version.ts
packages/protocol/README.md
packages/protocol/src/capabilities.test.ts
packages/protocol/src/capabilities.ts
packages/protocol/src/handshake-direct.test.ts
packages/protocol/src/handshake-properties.test.ts
packages/protocol/src/handshake.test.ts
packages/protocol/src/handshake.ts
packages/protocol/src/index.ts
packages/protocol/src/version.ts
packages/tunnel/fixtures/wire-golden.json
packages/tunnel/src/gateway-endpoint.test.ts
packages/tunnel/src/gateway-endpoint.ts
packages/tunnel/src/wire-conformance.contract.test.ts
packages/vault/src/journal-archive.ts
packages/vault/src/schema/drop-people-merge.ts
packages/vault/src/schema/migrate-notifications.test.ts
packages/vault/src/schema/migrate.test.ts
packages/vault/src/schema/migrate.ts
packages/vault/src/schema/notifications.ts
packages/vault/src/schema/tables.ts
packages/vault/src/schema/time-organize.ts
receipts/issue-657-pre-v0-purge.md
scripts/gateway-package/probe.test.mjs
scripts/perf/README.md
tests/agent-e2e-pairing/flows/device-pairing-lifecycle.mjs
tests/onboarding-scenarios.md
```

## Out of scope

- Replica/device-plane schema cursors remain because they are storage and replication protocol state, not gateway handshake compatibility fields.
- Boundary-crossing relative imports remain unchanged.
- The external live-adapter smoke was documented but not run locally because it requires external agent CLIs and credentials.

## Verification

- `bun install --frozen-lockfile`
- `bun run build`
- `bun run typecheck`
- `bun run knip`
- Focused protocol, vault, archive, automation, CLI, client, tunnel, desktop, and mobile test suites
- `bun run test:affected` — 27 tasks passed, including 1,268 gateway, 1,737 client, 1,075 vault, and 378 mobile tests
- `bun run check:push` — all 25 gates passed
- `bun run check:pr` — passed; diff coverage 93.4% (57/61)
- PR CI follow-up: `packages/design/src/kit.test.ts` covers `KIT_DIR` so the post-#677 `packages/design/src/**` line floor (98%) stays met on verify (was 97.04%).

```sh
bun run check:pr
```

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019fbce6-9df-1785586537-1 | codex | 019fbce6-9dfd-72a1-844c-68143b22ea09 | #657 | gpt-5.6-luna | 1205661 | 0 | 64240384 | 115596 | 1321257 | 20.8082 | 1205661 | 0 | 64240384 | 115596 | chore(repo): purge pre-v0 compatibility cruft (#657) |
| codex-019fbce6-9df-1785586828-1 | codex | 019fbce6-9dfd-72a1-844c-68143b22ea09 | #657 | gpt-5.6-luna | 49085 | 0 | 1045760 | 3589 | 52674 | 0.4380 | 1254746 | 0 | 65286144 | 119185 | chore(repo): purge pre-v0 compatibility cruft (#657) |
| codex-019fbce6-9df-1785586961-1 | codex | 019fbce6-9dfd-72a1-844c-68143b22ea09 | #657 | gpt-5.6-luna | 21972 | 0 | 800256 | 4212 | 26184 | 0.3182 | 1276718 | 0 | 66086400 | 123397 | chore(repo): purge pre-v0 compatibility cruft (#657) |

### Steering table

| steering-key | agent | session | issue | ordinal | timestamp | kind | note |
| --- | --- | --- | --- | --- | --- | --- | --- |
| steer-019fbce6-9dfd-1 | codex | 019fbce6-9dfd-72a1-844c-68143b22ea09 | #657 | 1 | 2026-08-01T10:50:07.104Z | user request | Full-scope issue #657 + PR request; not a routine task continuation. |

## Decisions

- None. The receipt follows the issue scope directly: one pre-v0 purge, one diff, one checklist, and one verification bundle.

## Audit

Fresh-context attestation against the current diff, this receipt, and `gh issue view #657`.

| Check | Verdict | Notes |
| --- | --- | --- |
| What changed faithfully describes the diff | PASS | The narrative matches the staged purge: vault migration collapse, protocol capability hardening, desktop monitor fallback removal, mobile legacy migration cleanup, archive fallback removal, deprecated surface deletion, e2e/live harness deletion, Knip narrowing, and secure-storage error handling are all present in the diff. |
| Each checked item is realized in the diff | PASS | Every checked checklist item is represented in the diff: the ladder collapse and repair deletions, protocol/schema-epoch removal and required capabilities, desktop `/info` fallback removal, mobile shims and copy cleanup, archive fallback simplification, deprecated APIs deletion, e2e-live/cadence/Knip cleanup, and secure-storage error-swallow fix. |
| Checklist mirrors issue #657 | PASS | The receipt checklist mirrors the issue’s execution slices and preserves the same scope ordering, including the borderline journal-archive decision and the later cleanup slices. |

Verdict: PASS / PASS / PASS.

## Steering

Fresh-context attestation against the session transcript and the `Accounting → Steering` row.

| Check | Verdict | Notes |
| --- | --- | --- |
| Every genuine human-steering event is recorded in Accounting → Steering | PASS | One genuine steering event was recorded: the scope-expansion correction at `2026-08-01T10:50:07.104Z`, where the user redirected the work from the earlier ontology-review framing to the full scope of issue #657 and asked for a PR. |
| No non-steering message is recorded as steering | PASS | The single ledger row is a true steering event; ordinary task continuation and tool feedback were not recorded as steering. |

Verdict: PASS / PASS.
