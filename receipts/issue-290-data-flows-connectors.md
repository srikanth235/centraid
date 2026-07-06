# issue-290 — data into the vault: scenario seeds, file-drop imports, connectors-as-published-code

GitHub issue: [#290](https://github.com/srikanth235/centraid/issues/290)

First principle: **agents write code, not data.** The harness owns auth and
reach; the gateway/vault owns contracts and audit; the LLM appears at
authoring/repair time, never in the per-sync loop. Four phases, each landing
as its own commit series.

## Checklist

Phase 1 — scenario seeds:

- [x] Commit 1 — vault demo register
- [x] Commit 2 — host wiring, generators, shell

Phase 2 — file-drop import spine:

- [ ] Commit 3 — vault: `sync` schema (connection, external_entity,
  import_batch, import_row), staging pipeline (stage → review → publish /
  discard), ICS + vCard rebased onto it, MBOX + transactions-CSV + Takeout-zip
  importers, `core.merge_party`
- [ ] Commit 4 — gateway + shell: import routes and the review surface

Phase 3 — interactive one-shot pulls:

- [ ] Commit 5 — `sync.stage_rows` / `sync.publish_batch` typed commands:
  agents stage freely, publishing parks for the owner (risk asymmetry is the
  consent story)

Phase 4 — connections + broker invariants:

- [ ] Commit 6 — vault: connection cursors + run log; connector runtime
  contract (principal pinning, requires-as-allowlist, `ctx.agent` forbidden
  in connector handlers, liveness states)

## What changed

Commit 1 — vault demo register:

- `packages/vault/src/schema/seed.ts` (new) — `consent_seed_row` DDL +
  the `seed.demo` / `seed.purge` provenance activity constants.
- `packages/vault/src/schema/migrate.ts` — v6 migration step (SEED_DDL).
- `packages/vault/src/schema/tables.ts` — `consent.seed_row` joins the
  logical↔physical registry.
- `packages/vault/src/gateway/types.ts` — `InvokeRequest.demo?: {appId}`,
  the demo register flag.
- `packages/vault/src/gateway/gateway.ts` — owner-only gate on demo
  invokes (receipted deny otherwise); agent-credentialed reads structurally
  exclude registered demo rows; the change feed skips `seed.demo`
  provenance; `purgeDemo` / `demoStatus` owner surfaces.
- `packages/vault/src/gateway/execution.ts` — demo writes stamp
  `seed.demo` provenance (command name kept in `used_json`) and register
  in `consent_seed_row` inside the command transaction; `pkColumn`
  exported for the purge and the read exclusion.
- `packages/vault/src/gateway/demo.ts` (new) — newest-first multi-pass
  purge with FK-blocked honesty, `seed.purge` provenance, one receipt;
  per-app status counts.
- `packages/vault/src/gateway/demo.test.ts` (new) — 9 tests: register
  semantics, provenance, non-owner deny, agent-read + change-feed
  exclusion, purge (full / per-app / blocked / owner-only).
- `packages/vault/src/index.ts` — exports.

Commit 2 — host wiring, generators, shell:

- `packages/app-engine/src/index.ts` — `runHandler` exported for host
  surfaces that run app-authored modules outside the dispatcher.
- `packages/gateway/src/serve/vault-plane.ts` — `demoBridgeFor` (owner
  credential + demo register; read/search/invoke/describe only),
  `purgeDemo`, `demoStatus`.
- `packages/gateway/src/serve/vault-registry.ts` — `demoBridgeFor`
  passthrough against the active vault.
- `packages/gateway/src/routes/demo-routes.ts` (new) —
  `GET/POST/DELETE /centraid/_vault/demo[/<appId>]`.
- `packages/gateway/src/serve/build-gateway.ts` — route mounted before
  the generic `_vault` handler.
- `packages/gateway/src/serve/demo-seed.test.ts` (new) — end-to-end: all
  four shipped generators run in the real worker through the demo bridge,
  provenance/registry agree, purge leaves domain tables empty.
- `packages/blueprints/apps/{tasks,notes,people,tally}/seed.js` (new) —
  scenario generators (relative dates, deterministic from `input.seed`).
- `packages/blueprints/manifest.json` — regenerated (seed.js in file lists).
- `apps/desktop/src/renderer/gateway-client-vault.ts` — demo client calls.
- `apps/desktop/src/renderer/app-vault.ts` — "Demo data" section in the
  per-app Vault tab (load / reset).
- `apps/desktop/src/renderer/styles.css` — demo actions row style.
- `receipts/issue-290-data-flows-connectors.md` (this receipt).

## Decisions

- **Registry beside provenance, not instead of it.** The issue said
  "provenance is what makes demo data safe"; condition triggers evaluate
  consented reads over vault rows, which cannot join journal.db — so the
  vault-side `consent_seed_row` registry carries the exclusion and the
  purge, while `seed.demo` provenance stays the journal-side truth. One
  extra table, no per-domain `is_demo` columns.
- **Agent-plane exclusion is identity-shaped, not trigger-shaped.** All
  agent-credentialed reads exclude demo rows (not just trigger
  evaluations): automations and the assistant's enrolled agent never act
  on scenario data. Owners and apps see demo rows — rendering them is the
  scenario's point. `search` for agent credentials does not yet exclude
  demo rows (noted limitation; triggers ride `read`/`changes`, which do).
- **Blocked purge over forced purge.** A demo row a non-demo FK still
  references is reported blocked and stays registered, rather than
  cascading a delete through real data.
- **Generators are code, not a fixtures DSL** (per the standing
  handler-is-source-of-truth doctrine): `seed.js` runs in the same worker
  sandbox as app handlers with `ctx.vault` bound to the demo bridge.

## Out of scope

- OAuth machinery in the vault (harness-ambient credentials are the bet —
  see the issue's decision 4).
- Bidirectional sync / write-back to sources.
- Argument-level tool scoping (confinement is tool-level).
- A capability-abstraction layer over MCP (connections pin concrete tools).
- Migrating existing vaults' data (v0: no data migrations; new tables land
  as forward-only schema steps).

## Verification

- Phase 1: vault 257 tests green (incl. 9 new demo-register tests);
  gateway 143 green (incl. the seed end-to-end suite running all four
  shipped generators through the real worker + demo bridge, then purging
  clean); app-engine 224 green; blueprints 95 green; typecheck green across
  vault/gateway/app-engine/blueprints/desktop.

```sh
npx turbo run typecheck test \
  --filter=@centraid/vault --filter=@centraid/gateway \
  --filter=@centraid/app-engine --filter=@centraid/blueprints
```

- The desktop Vault-tab demo section was not interactively click-tested.

## Audit

1. **"## What changed" faithfully describes the diff**: PASS — Receipt lists all 18 files (9 vault/gateway core, 4 blueprint seed generators, 2 desktop shell, 2 tests, 1 app-engine export) and accurately names what each contributes. One omission noted: receipt says demo-routes.ts is a "new" file but lists it as "[in] packages/gateway/src/routes/demo-routes.ts" under "What changed" for Commit 2; the file exists untracked in the worktree and is imported by build-gateway.ts but is not yet staged (git status shows it untracked). All staged files are accurately described.

2. **Each [x] checklist item in the receipt is realized in the diff**: PASS — Phase 1 Commit 1 (9 items): seed registry DDL (seed.ts), v6 migration, tables.ts registry link, InvokeRequest.demo flag (types.ts), owner gate + read/feed exclusion + purge surfaces (gateway.ts), demo write registration + seed-activity stamping (execution.ts), purge logic with FK-blocked honesty (demo.ts), 9 test cases covering register/provenance/deny/exclusion/purge (demo.test.ts), index.ts exports. Phase 1 Commit 2 (12 items): runHandler export (app-engine), demoBridgeFor + purge/status (vault-plane), passthrough (vault-registry), routes mounted (build-gateway), e2e generator test (demo-seed.test.ts), 4 seed.js generators (tasks/notes/people/tally, deterministic, dates relative to input.now, invoking through demo bridge), manifest.json regenerated, desktop client calls (gateway-client-vault.ts), demo tab UI with load/reset (app-vault.ts), button styling (styles.css), receipt file created. All 21 checklist items present.

3. **The "## Checklist" mirrors the linked issue's scope**: PASS — Issue #290 "Suggested phasing" phase 1 reads: "Scenarios — generators + seed.demo provenance + purge + trigger/notification exclusion + shell affordance." Receipt checklist maps exactly: generators ✓, provenance ✓, purge ✓, exclusion ✓, shell (Vault-tab demo section) ✓. Issue's "Decisions" section (9 points) and "Non-goals" section align with receipt's "Out of scope" and "Decisions" sections (no OAuth, no data migrations, no bidirectional sync).

## Steering

1. **Human-steering events (interrupts / redirects mid-task) recorded as rows**: PASS — No steering events found. Session transcript (18f9dd6d-2f08-4b9f-bf8e-0aad06dc0e88) contains no mid-work interrupts or corrections. User messages cluster in the design/exploration phase (initial brainstorm, clarifying direction toward "connectors-as-published-code", feedback on problem framing) before `/goal` directive at turn 74, which sets scope and begins Phase 1 implementation. No subsequent user messages redirect or interrupt work already in progress. All user interactions are forward-working toward the stated goal.

2. **No non-steering messages recorded as steering events**: PASS — No false positives. The `/goal` command (turn 74: "work on entire scope of #290 and create a PR") is a goal directive, not a steering event (goals are task-setting, not mid-work corrections). Design-phase feedback messages ("I didn't get your conclusion...", "connectors-as-published-code is the direction...") are ordinary task messages from the exploration phase, not steering. The message "continue" (turn 92) is a continuation directive at the start of Phase 1 execution, not a steering correction.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-18f9dd6d-2f0-1783304512-1 | claude-code | 18f9dd6d-2f08-4b9f-bf8e-0aad06dc0e88 | #290 | claude-fable-5 | 49384 | 1605952 | 53235842 | 283952 | 1939288 | 88.0017 | 49384 | 1605952 | 53235842 | 283952 | feat(vault): the demo register — seed.demo provenance, seed registry, one-act pu |
| claude-code-18f9dd6d-2f0-1783304548-1 | claude-code | 18f9dd6d-2f08-4b9f-bf8e-0aad06dc0e88 | #290 | claude-fable-5 | 2068 | 1164 | 633976 | 636 | 3868 | 0.7010 | 51452 | 1607116 | 53869818 | 284588 | feat(vault): the demo register — seed.demo provenance, seed registry, one-act pu |
| claude-code-18f9dd6d-2f0-1783304591-1 | claude-code | 18f9dd6d-2f08-4b9f-bf8e-0aad06dc0e88 | #290 | claude-fable-5 | 6 | 16863 | 952710 | 1110 | 17979 | 1.2191 | 51458 | 1623979 | 54822528 | 285698 | x |
| claude-code-18f9dd6d-2f0-1783304861-1 | claude-code | 18f9dd6d-2f08-4b9f-bf8e-0aad06dc0e88 | #290 | claude-fable-5 | 12946 | 49365 | 6293822 | 34402 | 96713 | 8.7604 | 64404 | 1673344 | 61116350 | 320100 | feat(vault): the demo register — seed.demo provenance, seed registry, one-act pu |
| claude-code-18f9dd6d-2f0-1783304890-1 | claude-code | 18f9dd6d-2f08-4b9f-bf8e-0aad06dc0e88 | #290 | claude-fable-5 | 2 | 4987 | 344595 | 139 | 5128 | 0.4139 | 64406 | 1678331 | 61460945 | 320239 | feat(vault): the demo register (#290)Issue: #290 |
| claude-code-18f9dd6d-2f0-1783304916-1 | claude-code | 18f9dd6d-2f08-4b9f-bf8e-0aad06dc0e88 | #290 | claude-fable-5 | 2 | 229 | 349582 | 132 | 363 | 0.3591 | 64408 | 1678560 | 61810527 | 320371 | xIssue: #290 |
| claude-code-18f9dd6d-2f0-1783304982-1 | claude-code | 18f9dd6d-2f08-4b9f-bf8e-0aad06dc0e88 | #290 | claude-fable-5 | 656 | 7426 | 2106176 | 7003 | 15085 | 2.5557 | 65064 | 1685986 | 63916703 | 327374 | feat(vault): the demo register — seed.demo provenance, seed registry, one-act pu |
