# issue-252 — Duaility personal-ontology vault: package, gateway integration, and projection blueprints

Anchors [#252](https://github.com/srikanth235/centraid/issues/252). The Duaility ontology becomes a real package (`@centraid/vault`), the Centraid app host gains a consent-checked door into it (`ctx.vault`), and the product surfaces from the ontology's §01 projection band ship as first-class blueprints.

## Checklist
- [x] Implement `@centraid/vault`: 11-schema ontology + consent gateway + schedule/social/finance/health command packs
- [x] P1 — mount the vault plane in the gateway off `GatewayPaths.vaultDir`
- [x] P2 — enroll live apps as `consent.app` rows and cascade on uninstall
- [x] P3 — add the `ctx.vault` handler primitive over the worker RPC channel
- [x] P4 — owner-approved grants via the manifest vault block and `/_vault` routes
- [x] P5 — teach the builder surface the `ctx.vault` primitive
- [x] P6 — run the vault standing duties on the gateway clock
- [x] Ship the §01 projection band as first-class blueprints (ten apps)
- [x] Document the integration as §12 in the ontology page

## What changed

- **Implement `@centraid/vault`: 11-schema ontology + consent gateway + schedule/social/finance/health command packs.** New package under `packages/vault` — the full logical model as STRICT SQLite DDL across two files (`vault.db` model + `journal.db` append-only audit), the five-stage gateway (`src/gateway/`: identity → consent → contract → execution → evidence), the eight standing duties, ICS/vCard ingest, export/portability, and fifteen typed commands across the four foundation domains (`src/commands/schedule.ts`, `social.ts`, `finance.ts`, `health.ts`). `src/host.ts` adds the host-integration helpers (idempotent bootstrap-or-recover, app enrollment by name, grant listing) an embedding process needs. UUIDv7 minting moved to the `uuid` package (`src/ids.ts`).
- **P1 — mount the vault plane in the gateway off `GatewayPaths.vaultDir`.** `packages/gateway/src/serve/vault-plane.ts` opens the vault pair, bootstraps the owner idempotently, registers the four domain packs, runs the sweep clock, and checkpoints + closes on stop. `packages/gateway/src/paths.ts` gains the optional `vaultDir` slot; `build-gateway.ts` constructs the plane and exposes it on `BuiltGateway.vault`. Absent `vaultDir`, no plane mounts and `ctx.vault` fails closed.
- **P2 — enroll live apps as `consent.app` rows and cascade on uninstall.** Every app-live path in `build-gateway.ts` enrolls the app; deregistration revokes its grants (views invalidated, parked invocations dropped, appext file deleted) and retires the identity row. Signing keys stay host-side.
- **P3 — add the `ctx.vault` handler primitive over the worker RPC channel.** `packages/app-engine/src/worker/runner.ts` gains a `vault` proxy posting `{type:'vault'}` messages beside `db`; `handler-runner.ts` answers them through a host-injected `VaultBridge` (`packages/app-engine/src/handlers/vault-bridge.ts`), which app-engine defines but does not implement — keeping app-engine engine-agnostic. The gateway implements the bridge in `vault-plane.ts`, resolving the running app to its credential per call so consent is enforced host-side. Threaded through `runtime.ts` and `dispatcher.ts` via `vaultFor`.
- **P4 — owner-approved grants via the manifest vault block and `/_vault` routes.** `packages/app-engine/src/registry/manifest.ts` adds a validated `vault` block (`purpose`, `why?`, `scopes[]`); `packages/gateway/src/routes/vault-routes.ts` serves the owner consent surface (`/centraid/_vault/*`: status, apps, grant approve/revoke, parked list/confirm). Deny-by-default until the owner approves.
- **P5 — teach the builder surface the `ctx.vault` primitive.** `packages/app-engine/src/handlers/build-extra-prompt.ts` renders a Personal-vault section documenting `ctx.vault` only when the manifest declares vault access.
- **P6 — run the vault standing duties on the gateway clock.** The plane's sweep joins the gateway lifecycle (`start()`), and checkpoint runs on `stop()`.
- **Ship the §01 projection band as first-class blueprints (ten apps).** `packages/blueprints/apps/{agenda,vitals,budgets,tasks,people,threads,notes,photos,home-inventory,studio}` — each a pure projection (no private tables, no migrations, every row via `ctx.vault`, actions declaring `writes: []`). The four foundation domains read and act; the other four ship read-only. `packages/blueprints/index.json` + regenerated `manifest.json` list them; `packages/blueprints/src/app-manifests.test.ts` validates every bundled `app.json` against the runtime validator.
- **Document the integration as §12 in the ontology page.** `duaility-ontology.html` gains the §12 "Centraid integration" section (seam, concept mapping, six phases, decisions, projection band).

## Out of scope
- Real request-signature crypto — identity stays v0 key-equality; upgrading touches only `vault/src/gateway/identity.ts`.
- Desktop UI for grant approval and parked-invocation confirmation (the `/_vault` HTTP surface exists; no renderer yet).
- Typed command packs for the knowledge / media / home / business domains — their four blueprints (`notes`, `photos`, `home-inventory`, `studio`) ship read-only until those packs land.
- OFX / IMAP ingest adapters, materialized-view refresh, and export artifact byte-custody.

## Decisions
- **One atomic commit, not a per-phase split.** The governance kit's model is one-issue → one-PR → one-receipt, and `commit-issue-receipt-match` requires every commit to touch its receipt; splitting would force an incrementally-built receipt to satisfy the full shape + sub-agent audit at each pre-commit. Since the PR squash-merges to a single trunk commit regardless, one commit is the low-risk choice. This trades against the usual "focused commits" preference deliberately.
- **Consent model = manifest-declared scopes + explicit owner approval; both data planes kept.** The two gating decisions from §12 were resolved to the recommended options — an app declares requested scopes and the owner approves them (deny-by-default), and apps keep their private `data.sqlite` while the vault holds the canon (R09 verbatim, no migration).
- **`ctx.vault` actions declare `writes: []`.** They perform no writes to the app's own `data.sqlite` (the canon lives in the vault), so the honest value for `actions-declare-table-writes` is the empty array — the change-stream feed for the app's local tables has nothing to invalidate.
- **`dispatcher.ts` takes a file-size waiver.** Threading the `ctx.vault` bridge pushed it from 494 to 504 lines; waived rather than split, with the helper-module split tracked as follow-up. `runtime.ts` and `build-gateway.ts` already carried waivers.
- **UUIDv7 switched to the `uuid` package** — its `v7()` is monotonic within a millisecond, fixing same-millisecond receipt-ordering flake the hand-rolled minter had.

## Verification
All three touched packages plus blueprints are green — tests, typecheck, build, lint, format:

```sh
cd packages/vault      && bun run test && bun run typecheck && bun run build   # 66 tests
cd packages/app-engine && bun run test && bun run typecheck                     # 318 tests
cd packages/gateway    && bun run test && bun run typecheck                     # 128 tests (+1 skip)
cd packages/blueprints && bun run build:manifest && bun run test               # 75 tests
bun run lint && bun run format:check
```

Key end-to-end proofs live in `packages/gateway/src/serve/vault-plane.test.ts`: an enrolled-but-ungranted app gets a receipted consent deny; owner approval opens reads; an app `propose_event` parks and the owner confirm releases it into `core_event`; a real handler file crosses worker → bridge → vault with the write receipted to the app; and the plane recovers the same identity + grants across a restart. `packages/blueprints/src/app-manifests.test.ts` gates every bundled blueprint through the runtime manifest validator and asserts the ten projections carry vault blocks with no private tables or migrations.

## Audit

A fresh-context sub-agent was handed only the staged diff, this receipt, and `gh issue view 252` and asked adversarially whether (a) `## What changed` faithfully describes the diff, (b) each `- [x]` item is realized, and (c) the `## Checklist` mirrors the issue.

**Verdict: PASS**

(a) What-changed is substantiated: `packages/gateway/src/serve/vault-plane.ts` opens the two SQLite files via `openVaultDb`, bootstraps via `ensureVaultBootstrapped`, and exposes `bridgeFor(appId)`; `packages/app-engine/src/worker/runner.ts` adds a genuine second RPC channel (`type:'vault'`/`'vault-reply'`, separate id space beside `db`); `vault-bridge.ts` is a neutral contract with zero imports and no `@centraid/vault` reference beyond one doc comment — the gateway implements it, keeping app-engine engine-agnostic; all ten blueprint apps exist with a `vault` block and every action declares `writes: []`; `duaility-ontology.html` carries the §12 section with its nav anchor. (b) Every `- [x]` item is realized in the diff — P2 enroll/revoke wiring in `build-gateway.ts`, P4's `/centraid/_vault/*` routes and the validated `ManifestVaultBlock`, P5's manifest-guarded `renderVaultBlock`, and `app-manifests.test.ts` gating projections through `validateAppManifest`. (c) The `## Checklist` is byte-for-byte identical to the issue's checklist, and the file-coverage block matches `git diff --cached --name-only` exactly (no fabricated paths).

## File coverage

All paths in this change set:

```text
bun.lock
duaility-ontology.html
packages/app-engine/src/handlers/build-extra-prompt.ts
packages/app-engine/src/handlers/dispatcher.ts
packages/app-engine/src/handlers/handler-runner.ts
packages/app-engine/src/handlers/vault-bridge.test.ts
packages/app-engine/src/handlers/vault-bridge.ts
packages/app-engine/src/index.ts
packages/app-engine/src/registry/manifest.ts
packages/app-engine/src/runtime.ts
packages/app-engine/src/worker/runner.ts
packages/blueprints/apps/agenda/actions/propose.js
packages/blueprints/apps/agenda/actions/reschedule.js
packages/blueprints/apps/agenda/actions/rsvp.js
packages/blueprints/apps/agenda/app.css
packages/blueprints/apps/agenda/app.js
packages/blueprints/apps/agenda/app.json
packages/blueprints/apps/agenda/index.html
packages/blueprints/apps/agenda/package.json
packages/blueprints/apps/agenda/queries/upcoming.js
packages/blueprints/apps/agenda/wall.css
packages/blueprints/apps/budgets/actions/categorize.js
packages/blueprints/apps/budgets/actions/flag.js
packages/blueprints/apps/budgets/actions/set-budget.js
packages/blueprints/apps/budgets/app.css
packages/blueprints/apps/budgets/app.js
packages/blueprints/apps/budgets/app.json
packages/blueprints/apps/budgets/index.html
packages/blueprints/apps/budgets/package.json
packages/blueprints/apps/budgets/queries/overview.js
packages/blueprints/apps/budgets/wall.css
packages/blueprints/apps/home-inventory/app.css
packages/blueprints/apps/home-inventory/app.js
packages/blueprints/apps/home-inventory/app.json
packages/blueprints/apps/home-inventory/index.html
packages/blueprints/apps/home-inventory/package.json
packages/blueprints/apps/home-inventory/queries/inventory.js
packages/blueprints/apps/home-inventory/wall.css
packages/blueprints/apps/notes/app.css
packages/blueprints/apps/notes/app.js
packages/blueprints/apps/notes/app.json
packages/blueprints/apps/notes/index.html
packages/blueprints/apps/notes/package.json
packages/blueprints/apps/notes/queries/library.js
packages/blueprints/apps/notes/wall.css
packages/blueprints/apps/people/actions/update-card.js
packages/blueprints/apps/people/app.css
packages/blueprints/apps/people/app.js
packages/blueprints/apps/people/app.json
packages/blueprints/apps/people/index.html
packages/blueprints/apps/people/package.json
packages/blueprints/apps/people/queries/directory.js
packages/blueprints/apps/people/wall.css
packages/blueprints/apps/photos/app.css
packages/blueprints/apps/photos/app.js
packages/blueprints/apps/photos/app.json
packages/blueprints/apps/photos/index.html
packages/blueprints/apps/photos/package.json
packages/blueprints/apps/photos/queries/library.js
packages/blueprints/apps/photos/wall.css
packages/blueprints/apps/studio/app.css
packages/blueprints/apps/studio/app.js
packages/blueprints/apps/studio/app.json
packages/blueprints/apps/studio/index.html
packages/blueprints/apps/studio/package.json
packages/blueprints/apps/studio/queries/studio.js
packages/blueprints/apps/studio/wall.css
packages/blueprints/apps/tasks/app.css
packages/blueprints/apps/tasks/app.js
packages/blueprints/apps/tasks/app.json
packages/blueprints/apps/tasks/index.html
packages/blueprints/apps/tasks/package.json
packages/blueprints/apps/tasks/queries/list.js
packages/blueprints/apps/tasks/wall.css
packages/blueprints/apps/threads/actions/draft.js
packages/blueprints/apps/threads/actions/send.js
packages/blueprints/apps/threads/app.css
packages/blueprints/apps/threads/app.js
packages/blueprints/apps/threads/app.json
packages/blueprints/apps/threads/index.html
packages/blueprints/apps/threads/package.json
packages/blueprints/apps/threads/queries/inbox.js
packages/blueprints/apps/threads/queries/thread.js
packages/blueprints/apps/threads/wall.css
packages/blueprints/apps/vitals/actions/log.js
packages/blueprints/apps/vitals/actions/trends.js
packages/blueprints/apps/vitals/app.css
packages/blueprints/apps/vitals/app.js
packages/blueprints/apps/vitals/app.json
packages/blueprints/apps/vitals/index.html
packages/blueprints/apps/vitals/package.json
packages/blueprints/apps/vitals/queries/readings.js
packages/blueprints/apps/vitals/wall.css
packages/blueprints/index.json
packages/blueprints/manifest.json
packages/blueprints/package.json
packages/blueprints/src/app-manifests.test.ts
packages/gateway/package.json
packages/gateway/src/index.ts
packages/gateway/src/paths.ts
packages/gateway/src/routes/vault-routes.ts
packages/gateway/src/serve/build-gateway.test.ts
packages/gateway/src/serve/build-gateway.ts
packages/gateway/src/serve/vault-plane.test.ts
packages/gateway/src/serve/vault-plane.ts
packages/vault/README.md
packages/vault/package.json
packages/vault/src/bootstrap.ts
packages/vault/src/commands/finance.test.ts
packages/vault/src/commands/finance.ts
packages/vault/src/commands/health.test.ts
packages/vault/src/commands/health.ts
packages/vault/src/commands/schedule.ts
packages/vault/src/commands/social.test.ts
packages/vault/src/commands/social.ts
packages/vault/src/db.ts
packages/vault/src/gateway/consent.ts
packages/vault/src/gateway/contract.ts
packages/vault/src/gateway/custody.ts
packages/vault/src/gateway/duties.test.ts
packages/vault/src/gateway/duties.ts
packages/vault/src/gateway/evidence.ts
packages/vault/src/gateway/execution.ts
packages/vault/src/gateway/filters.ts
packages/vault/src/gateway/gateway.test.ts
packages/vault/src/gateway/gateway.ts
packages/vault/src/gateway/identity.ts
packages/vault/src/gateway/json-schema.ts
packages/vault/src/gateway/portability.test.ts
packages/vault/src/gateway/portability.ts
packages/vault/src/gateway/types.ts
packages/vault/src/gateway/views.ts
packages/vault/src/host.test.ts
packages/vault/src/host.ts
packages/vault/src/ids.ts
packages/vault/src/index.ts
packages/vault/src/ingest/ics.ts
packages/vault/src/ingest/import.ts
packages/vault/src/ingest/ingest.test.ts
packages/vault/src/ingest/vcard.ts
packages/vault/src/schema/agent.ts
packages/vault/src/schema/consent.ts
packages/vault/src/schema/core.ts
packages/vault/src/schema/domains-health-finance-schedule.ts
packages/vault/src/schema/domains-home-business.ts
packages/vault/src/schema/domains-social-knowledge-media.ts
packages/vault/src/schema/journal.ts
packages/vault/src/schema/migrate.test.ts
packages/vault/src/schema/migrate.ts
packages/vault/src/schema/tables.ts
packages/vault/tsconfig.json
packages/vault/tsconfig.test.json
packages/vault/vitest.config.ts
```

## Steering

One steering event was identified and recorded: at line 934, the user interrupted a brainstorming summary with "wait...this is only brainstorming approach, let's create another section in duaility ontoloyg html page with all releant dtails". This redirected the agent from generic planning to concrete implementation (creating the §12 Centraid integration section in the ontology). The interrupt marker at line 935 confirms the user aborted the prior response mid-flow.

**Verdict: PASS**

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-a50bcaa1-149-1783005633-1 | claude-code | a50bcaa1-1499-42fb-9f31-01f41b07bf1e | #252 | claude-opus-4-8 | 415789 | 13927301 | 200346629 | 1368271 | 15711361 | 223.5047 | 415789 | 13927301 | 200346629 | 1368271 | feat(vault): Duaility personal-ontology vault, gateway integration, and projecti |
| claude-code-a50bcaa1-149-1783005920-1 | claude-code | a50bcaa1-1499-42fb-9f31-01f41b07bf1e | #252 | claude-opus-4-8 | 10529 | 75939 | 5515453 | 19566 | 106034 | 3.7741 | 426318 | 14003240 | 205862082 | 1387837 | feat(vault): Duaility personal-ontology vault, gateway integration, and projecti |
| claude-code-a50bcaa1-149-1783005957-1 | claude-code | a50bcaa1-1499-42fb-9f31-01f41b07bf1e | #252 | claude-opus-4-8 | 6 | 5274 | 1306116 | 3258 | 8538 | 0.7675 | 426324 | 14008514 | 207168198 | 1391095 | feat(vault): Duaility personal-ontology vault, gateway integration, and projecti |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-94c439a7-1751490000-1 | 94c439a7-4588-4b2e-ba72-111e52dbaebd | #252 | interrupt | structural | Stop brainstorming, create ontology section with vault-gateway integration details |  | 934 | 2026-07-02T09:13:53.743Z |
