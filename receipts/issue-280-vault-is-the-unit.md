# issue-280 — the vault is the unit: gateway central state moves into vaults, profiles collapse onto vaults

GitHub issue: [#280](https://github.com/srikanth235/centraid/issues/280)

The forcing scenario: each family member has their own vault on one shared
gateway, and each builds their own apps. Anything central at the gateway
either leaks across those vaults or fails to travel with an export. This
receipt tracks the full four-phase landing.

## Checklist

- [x] Commit 1 (app-engine) — transcripts per vault, identity collapse
- [x] Commit 2 (automation + agent-runtime) — the fire spine over the vault ledger
- [x] Commit 3 (gateway + vault + hosts) — apps per vault
- [x] Commit 4 (desktop) — profiles are vaults

## What changed

### Commit 1 (app-engine) — transcripts per vault, identity collapse

- `TRANSCRIPTS_MIGRATIONS` replaces `RUNTIME_MIGRATIONS` + `ANALYTICS_MIGRATIONS`:
  one per-vault `transcripts.db` holds `conversations` / `turns` / `items` /
  `attachments` / `automation_state` **and** `run_summary`. The central
  `analytics.sqlite` is gone — a per-vault rollup can never aggregate across
  vaults. `AnalyticsStore`/`InsightsStore` re-prepare when the provider's
  handle changes (the gateway wires "the ACTIVE vault's transcripts.db").
- `identity.sqlite` (users + user_prefs) is deleted. The vault owner IS the
  user: `conversations.user_id` carries `core_vault.owner_party_id`, and
  `GET /_centraid-user/id` answers with the active vault's owner party id.
  Device prefs (runner choice, binPath, theme) live in a plain `prefs.json`
  (`PrefsStore`, same `/_centraid-user` wire surface).
- `VaultWorkspace` / `WorkspaceProvider` (new seam): the per-vault world —
  `appsDir`, `transcripts` provider, `transcriptsDbFile`, `runnerSessionDir`,
  `ownerPartyId` — typed in app-engine, resolved by the gateway per call.
- `ConversationHistoryStore` fronts ONE vault-scoped ledger; app scoping is
  the `app_id` column, enforced at the facade (`ownedMeta`) so a cross-app
  conversation-id lookup reads as not-found — the isolation the per-app file
  boundary used to give. A conversation binds to its vault at creation; a
  mid-turn vault switch fails closed (`recordTurn` → undefined).
- `Runtime`/`Dispatcher` accept `appsDir` (and session dir) as providers and
  keep one `Registry` per resolved dir, so a vault switch re-roots the whole
  app surface without reconstructing the runtime. `BlobStore` root is a
  provider — attachment bytes are vault-scoped and export with the vault.

### Commit 2 (automation + agent-runtime) — the fire spine over the vault ledger

- The automation fire spine (`runFire`), condition/data trigger cursors, and
  `agent-runtime`'s `runAutomation` take `transcriptsDbFile`: every fire's run
  ledger + KV cursors are the vault's `transcripts.db` (per-app `runtime.sqlite`
  is gone). Run-id → per-app-file resolution is removed — one ledger per vault.

### Commit 3 (gateway + vault + hosts) — apps per vault

- `GatewayPaths` is vault-first: `vaultDir` (required) + `prefsFile` +
  catalog/template slots. `appsDir` / `identityDb` / `analyticsDb` /
  `conversationRunnerSessionDir` / `appsStoreRoot` / `lazyStoreInit` are gone.
- Each `VaultPlane` exposes its `workspace` (transcripts provider included,
  closed with the plane) and `codeStoreRoot` (`<vault>/code`). `buildGateway`
  builds a per-vault host bundle lazily (WorktreeStore + draft resolver +
  unified chat runner + apps-store/lifecycle/automations route handlers),
  cached by vault id; the active one resolves per request. The route modules
  themselves are unchanged.
- Vault switch is a first-class re-root: `VaultRegistry.settleActivation()`
  runs the gateway's activation hook (registry load + `main` sync + enroll +
  scheduler reconcile) and the `PATCH …/vaults/<id> {active:true}` route
  awaits it before responding.
- Enrollment matches ownership: `enrollApp`/`enrollAutomationAgent`/`revokeApp`
  act on the ACTIVE vault only — `consent_app` now governs the vault's own
  apps (the per-vault-enrollment-of-a-global-object oddity dissolves).
- The automation fire spine (`runFire`), condition/data trigger cursors, and
  the automations routes take `transcriptsDbFile`; run-id → per-app-file
  resolution is gone (one ledger per vault).
- `core_vault.settings_json` gains presentation (`color`/`icon`/`blurb`) with
  owner ops (`readVaultPresentation`/`updateVaultPresentation`), surfaced on
  `GET /_vault/vaults` and settable via PATCH.
- Hosts: the daemon layout is `prefs.json` + `model-catalog.json` +
  `token.bin` + `vault/`; the OpenClaw plugin mounts `centraid-vault/` +
  `centraid-prefs.json` and resolves fire-time paths from the active
  workspace. Blueprints stay gateway-level seeds instantiated INTO a vault
  (templates routes unchanged).

### Commit 4 (desktop) — profiles are vaults

- The switcher, manage page, add/edit modal, delete dialog, and ⌘1…⌘9 all
  operate on VAULTS via `/_vault/vaults`; presentation reads/writes
  `core_vault.settings_json`. The renderer's `profiles.meta` localStorage is
  deleted — a space's identity travels with a vault export.
- Gateways demote to Connections: the dropdown lists other endpoints under a
  divider; Settings → Spaces carries a Connections group (connect / remove).
  `GATEWAYS_ADD_LOCAL` (additional local workspaces) is removed — a second
  space is a second vault. Settings → Vaults page is superseded by Spaces.
- Onboarding names the first vault (and keeps stamping the local profile's
  `displayName`, which remains the onboarding-done signal).
- Desktop paths follow: `prefs.json` replaces `identity.sqlite`/`analytics.sqlite`,
  the code store resolves through the ACTIVE vault
  (`vault/<activeVaultId>/code`, read via `vaults.json`) for reveal-in-Finder
  and builder session dirs.

## Out of scope

- **No data migrations** (standing v0 rule): existing central DBs, per-app
  `runtime.sqlite` files, and pre-#280 code stores are abandoned in place;
  dev gateways/vaults need recreation.
- **Per-vault device auth**: `token.bin` remains transport admission for the
  whole gateway; "which vaults may this device open" (`consent_device`-gated)
  is the documented end state, deferred per the issue.
- **Remote-connection add/edit UI**: there was no renderer surface for adding
  remote gateways before this change and none is added; Connections offers
  connect/remove over the existing IPC.
- **Multi-vault app sharing / blueprint instantiation UX** beyond the
  existing template flow.

## Decisions

- **`run_summary` as a table in `transcripts.db`, not a fourth file.** The
  issue left this open ("likely just a table"). Chosen because it shares the
  ledger's derived/append-heavy growth profile and keeps the per-vault
  directory to three SQLite files; the rebuild path becomes a same-file scan.
- **App scoping enforced at the facade, not the store.** Moving from one file
  per app to one file per vault dropped the isolation the file boundary gave.
  Rather than push `appId` into every store method, `ConversationHistoryStore`
  gained an `ownedMeta(appId, id)` gate — a cross-app conversation-id lookup
  reads as not-found. Trade-off: the raw `ConversationStore` is not itself
  app-isolated, but it is runtime-owned and never handed to app code.
- **`Runtime` keeps one `Registry` per resolved apps-dir** (a small cache)
  rather than rebuilding the runtime on vault switch. Simpler than tearing
  down and reconstructing the whole object graph; the caches are bounded by
  the number of vaults touched in a session.
- **Per-vault host bundles are built lazily and cached by vault id**, and a
  failed build is evicted so the next request retries. This keeps a switch to
  a never-visited vault cheap and avoids poisoning the cache on a transient
  git failure.
- **Additional-local-gateways (`GATEWAYS_ADD_LOCAL`) removed rather than
  repurposed.** Under vault-first a second space is a second vault, so the
  feature is redundant; keeping it would have offered two overlapping "new
  space" paths. The primordial local connection stays.
- **`vault-plane.ts` carries a file-size waiver.** The workspace/presentation
  accessors tipped it past the cap; the substantive split (bridge executors
  into a sibling module) is deferred and noted in the waiver comment.
- **Onboarding still stamps the local profile's `displayName`.** That on-disk
  field remains the "onboarding done" signal, so it is written alongside the
  new first-vault naming rather than replaced.

## Files changed

Phase 1+2 (app-engine — transcripts ledger + identity collapse):
`packages/app-engine/src/stores/gateway-db.ts`,
`packages/app-engine/src/stores/gateway-db.test.ts`,
`packages/app-engine/src/stores/prefs-store.ts` (new),
`packages/app-engine/src/stores/vault-workspace.ts` (new),
`packages/app-engine/src/stores/user-store.ts` (deleted),
`packages/app-engine/src/stores/user-store.test.ts` (deleted),
`packages/app-engine/src/insights/analytics-db.ts` (deleted),
`packages/app-engine/src/insights/analytics-store.ts`,
`packages/app-engine/src/insights/analytics-store.test.ts`,
`packages/app-engine/src/insights/insights-store.ts`,
`packages/app-engine/src/insights/insights-store.test.ts`,
`packages/app-engine/src/insights/index.ts`,
`packages/app-engine/src/conversation/history.ts`,
`packages/app-engine/src/conversation/history.test.ts`,
`packages/app-engine/src/conversation/store.ts`,
`packages/app-engine/src/conversation/store.test.ts`,
`packages/app-engine/src/conversation/store-sql.ts`,
`packages/app-engine/src/data/blob-store.ts`,
`packages/app-engine/src/handlers/dispatcher.ts`,
`packages/app-engine/src/runtime.ts`,
`packages/app-engine/src/http/http-server.ts`,
`packages/app-engine/src/index.ts`.

Phase 2 (automation + agent-runtime — fire spine over the vault ledger):
`packages/automation/src/fire/fire.ts`,
`packages/automation/src/fire/fire.test.ts`,
`packages/automation/src/fire/fire-vault.test.ts`,
`packages/automation/src/fire/condition.ts`,
`packages/automation/src/fire/condition.test.ts`,
`packages/agent-runtime/src/automation/run-automation.ts`.

Phase 3 (gateway + vault + hosts — per-vault workspaces):
`packages/gateway/src/paths.ts`,
`packages/gateway/src/serve/build-gateway.ts`,
`packages/gateway/src/serve/build-gateway.test.ts`,
`packages/gateway/src/serve/serve.ts`,
`packages/gateway/src/serve/serve.test.ts`,
`packages/gateway/src/serve/serve-git-store.test.ts`,
`packages/gateway/src/serve/serve-multiclient.test.ts`,
`packages/gateway/src/serve/serve-scheduler-reconcile.test.ts`,
`packages/gateway/src/serve/vault-plane.ts`,
`packages/gateway/src/serve/vault-registry.ts`,
`packages/gateway/src/routes/vault-routes.ts`,
`packages/gateway/src/routes/automations-routes.ts`,
`packages/gateway/src/routes/automations-routes.test.ts`,
`packages/gateway/src/routes/apps-store-routes.test.ts`,
`packages/gateway/src/routes/templates-routes.test.ts`,
`packages/gateway/src/runs/run-events-sse.test.ts`,
`packages/gateway/src/cli/cli.ts`,
`packages/gateway/src/cli/cli.test.ts`,
`packages/gateway/src/cli/paths.ts`,
`packages/gateway/src/cli/runner-prefs.ts`,
`packages/gateway/src/lifecycle/automation-lifecycle-over-http.test.ts`,
`packages/gateway/src/lifecycle/clone-over-http.test.ts`,
`packages/gateway/src/lifecycle/draft-preview-over-http.test.ts`,
`packages/gateway/src/lifecycle/lifecycle-over-http.test.ts`,
`packages/gateway/src/lifecycle/publish-migrations-over-http.test.ts`,
`packages/gateway/src/lifecycle/seed-draft-data-over-http.test.ts`,
`packages/vault/src/host.ts`,
`packages/vault/src/index.ts`,
`packages/openclaw-plugin/src/index.ts`,
`packages/openclaw-plugin/src/lib/openclaw-fire.ts`.

Phase 4 (desktop — profiles are vaults):
`apps/desktop/src/main/gateway-paths.ts`,
`apps/desktop/src/main/local-gateway.ts`,
`apps/desktop/src/main/gateway-store.ts`,
`apps/desktop/src/main/app-sessions.ts`,
`apps/desktop/src/main/settings.ts`,
`apps/desktop/src/main/ipc.ts`,
`apps/desktop/src/preload.ts`,
`apps/desktop/src/renderer/app.ts`,
`apps/desktop/src/renderer/app-settings.ts`,
`apps/desktop/src/renderer/app-shell-context.ts`,
`apps/desktop/src/renderer/profiles.ts`,
`apps/desktop/src/renderer/gateway-client-vault.ts`,
`apps/desktop/src/renderer/types.d.ts`,
`apps/desktop/src/renderer/centraid-api.d.ts`,
`apps/desktop/src/renderer/app-vaults.ts` (deleted).

## Verification

Full battery, all green:

```sh
bun run typecheck && bun run test && bun run lint && bun run format:check && bun run lint:types
```

- `bun run typecheck` — 21/21 turbo tasks green (all packages incl. desktop
  + mobile).
- `bun run test` — full suite green: app-engine 304, gateway 25 files,
  vault 24 files, automation 15 files, agent-runtime 12 files, desktop,
  blueprints, tunnel, skills, openclaw-plugin (21/21 turbo tasks).
- `bun run lint` (oxlint, 0 errors) + `bun run format:check` (oxfmt clean) +
  `bun run lint:types` (all packages ok).
- Behavioral pins added/updated: transcripts schema (single file incl.
  `run_summary`, CASCADE chains, CHECK enums), cross-app conversation-id
  isolation in the shared ledger, code store materialized inside the active
  vault dir, `/_centraid-user/id` = owner party id, vault-registry recovery
  across rebuilds, seeding an app through the active vault's store +
  `settleActivation()` registry sync.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-77c1b781-428-1783186106-1 | claude-code | 77c1b781-428e-4a47-b2d5-ebf99e544c0a | #280 | claude-fable-5 | 93462 | 1463381 | 114939908 | 487271 | 2044114 | 158.5303 | 93462 | 1463381 | 114939908 | 487271 | feat(app-engine): one per-vault transcripts ledger; the identity DB dies (#280)T |
| claude-code-77c1b781-428-1783186160-1 | claude-code | 77c1b781-428e-4a47-b2d5-ebf99e544c0a | #280 | claude-fable-5 | 7216 | 7792 | 2626445 | 2485 | 17493 | 2.9203 | 100678 | 1471173 | 117566353 | 489756 | feat(app-engine): one per-vault transcripts ledger; the identity DB dies (#280)T |
| claude-code-77c1b781-428-1783186543-1 | claude-code | 77c1b781-428e-4a47-b2d5-ebf99e544c0a | #280 | claude-opus-4-8 | 18 | 1368237 | 3254676 | 7199 | 1375454 | 10.3589 | 100696 | 2839410 | 120821029 | 496955 | feat(app-engine): one per-vault transcripts ledger; the identity DB dies (#280)T |
| claude-code-77c1b781-428-1783186578-1 | claude-code | 77c1b781-428e-4a47-b2d5-ebf99e544c0a | #280 | claude-opus-4-8 | 291 | 3953 | 1912661 | 817 | 5061 | 1.0029 | 100987 | 2843363 | 122733690 | 497772 | wip commit 1 test |
| claude-code-77c1b781-428-1783186701-1 | claude-code | 77c1b781-428e-4a47-b2d5-ebf99e544c0a | #280 | claude-opus-4-8 | 879 | 36576 | 7310922 | 12985 | 50440 | 4.2131 | 101866 | 2879939 | 130044612 | 510757 | feat(app-engine): one per-vault transcripts ledger; the identity DB dies (#280)T |
| claude-code-77c1b781-428-1783186725-1 | claude-code | 77c1b781-428e-4a47-b2d5-ebf99e544c0a | #280 | claude-opus-4-8 | 3586 | 1019 | 495030 | 118 | 4723 | 0.2748 | 105452 | 2880958 | 130539642 | 510875 | wip |
| claude-code-77c1b781-428-1783186748-1 | claude-code | 77c1b781-428e-4a47-b2d5-ebf99e544c0a | #280 | claude-opus-4-8 | 2 | 3760 | 496049 | 131 | 3893 | 0.2748 | 105454 | 2884718 | 131035691 | 511006 | wip |
| claude-code-77c1b781-428-1783186840-1 | claude-code | 77c1b781-428e-4a47-b2d5-ebf99e544c0a | #280 | claude-opus-4-8 | 303 | 10684 | 5026665 | 9788 | 20775 | 2.8263 | 105757 | 2895402 | 136062356 | 520794 | feat(app-engine): one per-vault transcripts ledger; the identity DB dies (#280)T |
| claude-code-77c1b781-428-1783186872-1 | claude-code | 77c1b781-428e-4a47-b2d5-ebf99e544c0a | #280 | claude-opus-4-8 | 7140 | 2830 | 1011606 | 910 | 10880 | 0.5819 | 112897 | 2898232 | 137073962 | 521704 | feat(automation): fire the run ledger into the vault's transcripts.db (#280)The  |

## Steering

### Steering events

| check | verdict | evidence |
| --- | --- | --- |
| every human-steering event is recorded as a row | PASS | No steering events occurred: user messages 0–4 were pre-goal design-discussion clarifications that shaped the ISSUE content (not the implementation); the `/goal` directive at message 5 set the task and the agent ran it to completion with no mid-task interrupt or correction. Nothing to record. |
| no non-steering message recorded as steering | PASS | The `### Steering events` table is empty (no rows), so no ordinary task message or tool denial is misclassified as steering. |

No steering events recorded. All user messages (0–4) were pre-goal design-discussion clarifications about the architecture and requirements; no mid-task interrupts or corrections occurred after the `/goal` directive at message 5.

| type | timestamp | reason |
| --- | --- | --- |
| — | — | — |

## Audit

### Audit checks

| check | verdict | evidence |
| --- | --- | --- |
| "What changed" accurately describes diff | PASS | All 4 phases documented with accurate focus (TRANSCRIPTS_MIGRATIONS combining conversations + run_summary; identity.sqlite → prefs.json + VaultWorkspace seam; per-vault runtime apps-dir + registry; desktop profiles → vaults + localStorage removal) |
| Commit 1 (app-engine) checklist items realized | PASS | prefs-store.ts added; user-store.ts deleted; vault-workspace.ts added; TRANSCRIPTS_MIGRATIONS schema combines conversations + run_summary; Runtime.ts accepts dynamic appsDir provider |
| Commit 2 (automation) checklist items realized | PASS | automation files modified (fire.ts, condition.ts, fire-vault.test.ts); agent-runtime run-automation.ts updated; fire spine wired to vault's transcripts.db |
| Commit 3 (gateway + vault + hosts) checklist items realized | PASS | GatewayPaths vault-first (vaultDir required, appsDir/identityDb/analyticsDb removed); build-gateway.ts refactored to per-vault bundles; vault-plane.ts, vault-registry.ts, paths.ts, openclaw-plugin updated |
| Commit 4 (desktop) checklist items realized | PASS | profiles.ts localStorage profiles.meta code removed; app-vaults.ts deleted; presentation persists in core_vault.settings_json (via PATCH /_vault/vaults); gateways demoted to connections |
| Checklist mirrors issue #280 phasing | PASS | Issue phases 1–4 (transcripts per vault, identity collapse, apps per vault, profiles are vaults) align with receipt commits 1–4; Commit 1 bundles phases 1+2 per task organization |
