# issue-679 — Failing-capable user-facing quality gates

GitHub issue: [#679](https://github.com/srikanth235/centraid/issues/679)

## Checklist

- [x] A1 — seven-quality report layer, gate mapping, weakest-link summaries, and partial/blocked states
- [x] A2 — deterministic shared year-3 vault/ledger/sealed fixture with content-addressed atomic caching
- [x] A3 — demonstrated-red dates in the matrix and seeded-red evidence below
- [x] A4 — tighten-only budgets plus receipt-approved allowlist, waiver, and classification ratchets
- [x] A5 — enumerable MCP tool, automation trigger, route-security, and expected-health registries
- [x] A6 — open nightly restore/export failures block release preparation
- [x] T1 — one HTTP erase → recover-admin blank-machine recovery flow
- [x] T2 — side-effect declarations fail closed; real confirm-gated write parks before mutation
- [x] T3 — every sealed column and leak/enforcement surface is enumerated and sentinel-scanned
- [x] T4 — gateway boot refuses an HTTP route prefix without auth and vault-scope classification
- [x] R1 — reusable four-point real-process SIGKILL/reopen harness
- [x] R2 — two offline writers survive dropped/reset reconnects and converge without duplicates
- [x] R3 — every production health component is registry-enumerated and induced unhealthy
- [x] P1 — per-core-route p95 and gateway cold-start nightly rig budgets
- [x] P2 — real year-3 first-paint SQL/HTTP counts for Photos, Notifications, Atlas, and Assistant
- [x] P3 — bounded authored growth queries plus a hard runtime agent-SQL row cap
- [x] U1 — desktop/web first-run remain PR path-gated and nightly-required; broken mobile evidence is explicitly blocked, never green
- [x] U2 — exact known-bad user copy literals with a governed allowlist
- [x] U3 — UI receipts cross-check screenshot paths against changed e2e emitters
- [x] F1 — runners, MCP tools, and automation triggers persist through real conversation/turn/item tables
- [x] F2 — test-mode inference pricing fails at the shared runtime resolution seam
- [x] F3 — SQL-enumerated confirmation capabilities all map to Notifications rows
- [x] L1 — HTTP export → full portable import into fresh bootstrap → restart → HTTP re-export hash parity
- [x] L2 — schema fingerprint requires the canonical portable export owner to move with schema changes

## What changed

The nightly report now leads with the seven qualities users experience and derives each light from assertion-level evidence, not merely a passing owner file. The matrix records each gate's lane, cost, knob, governance, red date, owner, evidence selector, weakest link, and blocker. Release preparation checks the restore/export nightly issue state before shipping.

The executable layer consolidates classification registries and builds deterministic tests around real product seams: HTTP erase plus the recovery CLI; portable HTTP import/export; boot-time route registration; real SQLite screen-query counting; consent parking and conversation-ledger persistence; health induction; offline convergence; model-pricing resolution; schema/export ratchets; and gateway-process SIGKILL recovery. The shared year-3 fixture now carries multi-year rows, conversations/turns/items, sealed sentinels, and parked-action metadata, and its cache protocol checkpoints before atomic publication.

Checklist crosswalk (the labels are repeated verbatim so the governance check and a human reviewer can map every completed claim to this implementation record):

- A1 — seven-quality report layer, gate mapping, weakest-link summaries, and partial/blocked states — implemented by the quality report generator and matrix contract.
- A2 — deterministic shared year-3 vault/ledger/sealed fixture with content-addressed atomic caching — implemented by the shared test-kit fixture.
- A3 — demonstrated-red dates in the matrix and seeded-red evidence below — implemented by the structured replay ledger and the table below.
- A4 — tighten-only budgets plus receipt-approved allowlist, waiver, and classification ratchets — implemented by the quality-knob checker and governed JSON ratchets.
- A5 — enumerable MCP tool, automation trigger, route-security, and expected-health registries — implemented at the production dispatch and registration seams.
- A6 — open nightly restore/export failures block release preparation — implemented by the nightly blocker queried from release preparation.
- T1 — one HTTP erase → recover-admin blank-machine recovery flow — covered by the product recovery integration test.
- T2 — side-effect declarations fail closed; real confirm-gated write parks before mutation — covered by manifest classification and consent-ledger assertions.
- T3 — every sealed column and leak/enforcement surface is enumerated and sentinel-scanned — covered across real storage, log, SSE, replica, export, FTS, and runner surfaces.
- T4 — gateway boot refuses an HTTP route prefix without auth and vault-scope classification — enforced by the route-security registry.
- R1 — reusable four-point real-process SIGKILL/reopen harness — implemented by the child-process fixture and integration test.
- R2 — two offline writers survive dropped/reset reconnects and converge without duplicates — exercised through PWA IndexedDB and mobile SQLite queues over the replica HTTP route.
- R3 — every production health component is registry-enumerated and induced unhealthy — enforced by the expected-health registry drill.
- P1 — per-core-route p95 and gateway cold-start nightly rig budgets — implemented by identity-specific nightly performance assertions.
- P2 — real year-3 first-paint SQL/HTTP counts for Photos, Notifications, Atlas, and Assistant — measured at the real SQL and HTTP boundaries.
- P3 — bounded authored growth queries plus a hard runtime agent-SQL row cap — enforced by static enumeration and the vault SQL ceiling.
- U1 — desktop/web first-run remain PR path-gated and nightly-required; broken mobile evidence is explicitly blocked, never green — encoded in the matrix and workflow lanes.
- U2 — exact known-bad user copy literals with a governed allowlist — enforced by the literal scanner and allowlist ratchet.
- U3 — UI receipts cross-check screenshot paths against changed e2e emitters — enforced by the receipt validator.
- F1 — runners, MCP tools, and automation triggers persist through real conversation/turn/item tables — covered by the dedicated ledger assertion.
- F2 — test-mode inference pricing fails at the shared runtime resolution seam — enforced in model pricing resolution.
- F3 — SQL-enumerated confirmation capabilities all map to Notifications rows — enforced by the approval-rendering coverage assertion.
- L1 — HTTP export → full portable import into fresh bootstrap → restart → HTTP re-export hash parity — exercised by the portability integration path.
- L2 — schema fingerprint requires the canonical portable export owner to move with schema changes — enforced by the schema/export ratchet.

## Decisions

- First-run stays path-gated on pull requests and unconditional nightly. A lane that did not execute is partial evidence; the currently broken native mobile flow is explicitly blocked in the matrix instead of being represented as green.
- Offline queue/reconnect is established product behaviour under `docs/mobile-offline.md`, so R2 tests convergence rather than inventing new semantics.
- Timing gates remain nightly and rig-drift aware; deterministic query counts and registry/ratchet checks gate pull requests.
- Portable replacement is allowed only on a genuinely fresh bootstrap. A target with user growth rows is rejected even when the caller supplies `replaceFreshVault: true`.
- UI evidence is not a hand-attached image: the receipt path must be named by a changed e2e harness that emits a screenshot under `artifacts/e2e/ui-impact/`.
- `packages/gateway/src/backup/recover.integration.test.ts`, `packages/gateway/src/serve/health-registry.ts`, and `tests/quality/user-facing-qualities.test.ts` retain cohesive, issue-scoped file-size waivers: each is a single completeness/security contract with a shared fixture or state machine, and splitting it would weaken the one-pass enumeration argument.

## Demonstrated red

Every gate has a structured replay record in `tests/matrix.json`: the exact repo command, the seeded violation, and the observed failure signature. Matrix validation rejects a missing field, a missing gate, or an orphan record; the A1/A3/A4 gate additionally requires an exact one-to-one gate/record set. The replay evidence recorded on 2026-08-01 is:

| Gate | Seeded violation and red signature |
| --- | --- |
| T1 | Corrupt recovery-kit integrity; product restore rejects before swapping the vault. |
| T2 | Attempt a confirm-gated Locker purge; the protected row remains while the invocation is `proposed`. |
| T3 | Put a unique plaintext sentinel in every sealed column; any occurrence fails with the actual artifact surface name. |
| T4 | Register `/centraid/_new-surface` without metadata; gateway boot coverage throws. |
| A6 | Return an open restore/export nightly-failure issue; release preparation exits non-zero. |
| F2 | Resolve an unknown model in strict test mode; pricing throws instead of recording zero cost. |
| C1 | Remove a gate owner and corrupt matrix data; matrix validation rejects the fixture. |
| R1 | SIGKILL at every named subsystem point; the harness requires the signal and recovery invariants. |
| R2 | Drop the offline send and reset first reconnect; only the retry crosses real HTTP and duplicate replay must not add rows. |
| R3 | Replace every expected production probe with its induced failure; every component must report `error`. |
| P1 | Lower a named route/cold-start ceiling below serial p95; the identity-specific budget fails. |
| P2 | Lower per-screen SQL/HTTP ceilings; the screen and exceeded observed counter are reported. |
| P3 | Add an unbounded growth-table query without waiver; static enumeration fails while runtime SQL remains capped. |
| U1-desktop | Prevent fresh onboarding from reaching Home; the required Home assertion/screenshot step fails. |
| U1-web | Withhold first-run pairing/control; the first usable PWA assertion fails. |
| U1-mobile | Run the documented broken native onboarding flows; G2/G8/G9/G13/G14 remain red/blocked, never green. |
| U2 | Add a forbidden user-facing ledger synonym outside the allowlist; the exact file/literal is rejected. |
| U3 | Name a screenshot with no changed e2e emitter; receipt validation reports the missing emitter. |
| F1 | Omit a registered runner, tool, or trigger origin from the ledger; its registry identity fails coverage. |
| F3 | Add a confirmation capability beyond rendered approvals; SQL-enumerated and rendered sets diverge. |
| L1 | Tamper with/incompletely reimport the archive; the HTTP round trip rejects before committing the fresh target. |
| L2 | Change the schema fingerprint without moving the export owner; the schema/export ratchet exits non-zero. |

P2's first seeded ceilings (`3/4/3/4`) failed at measured SQL identities `61/8/123/22`; P3 initially found the unbounded Agenda event projection; U3's missing-emitter fixture, T4's unclassified route, F2's unknown model, and R1's four live SIGKILLs are retained executable red seeds rather than prose-only claims.

## Final-audit remediation

The first fresh audit refused PASS. Its concrete gaps were fixed in this tree: the full qualities payload now has an explicit waiver-gated fingerprint; automation parsing dispatches directly from `AUTOMATION_TRIGGER_REGISTRY`; shipped app actions declare `actionSideEffect` plus per-action confirmation and are checked to use the consent-recording vault seam; T3 captures real runtime logs, assistant SSE, replica snapshots, and the outbound runner payload; R2 sends PWA IndexedDB and mobile SQLite queues through the actual replica-intent HTTP route; P2 observes real HTTP boundaries; and F1 selects its dedicated ledger assertion.

## User impact

Users gain release-blocking evidence for restore/export safety, consent-before-write, sealed-data containment, reconnect recovery, responsiveness, first-run, agent legibility, and long-term portability. The only copy change replaces the stale mobile “Spaces” label with canonical “Vaults.”

First-run: desktop and web behaviour is unchanged; desktop first-run now emits the evidence screenshot used by this receipt. Mobile first-run remains explicitly blocked evidence until its existing native flow is runnable, so the report cannot overstate coverage.

![Desktop first-run home evidence](artifacts/e2e/ui-impact/issue-679-first-run-home.png)

## File coverage

- Governance/docs/workflows: `.github/workflows/e2e.yml`, `CONSTITUTION.md`, `TESTING.md`, `docs/glossary.md`, `package.json`, `tests/onboarding-scenarios.md`, `tests/skips.json`, `vitest.config.ts`, `vitest.quality.config.ts`.
- Product paths: `apps/desktop/tests/e2e/onboarding-home.spec.ts`, `apps/mobile/src/screens/Onboarding.tsx`, `packages/agent-runtime/src/backends/acp/vault-mcp-server.ts`, `packages/app-engine/src/model-pricing.ts`, `packages/app-engine/src/model-pricing.test.ts`, `packages/app-engine/src/registry/manifest.ts`, `packages/automation/src/manifest/manifest.ts`, `packages/blueprints/apps/agenda/app.json`, `packages/blueprints/apps/docs/app.json`, `packages/blueprints/apps/locker/app.json`, `packages/blueprints/apps/notes/app.json`, `packages/blueprints/apps/people/app.json`, `packages/blueprints/apps/photos/app.json`, `packages/blueprints/apps/tally/app.json`, `packages/blueprints/apps/tasks/app.json`, `packages/blueprints/apps/agenda/queries/upcoming.ts`, `packages/client/src/react/boot.test.tsx`, `packages/client/src/replica/app-convergence.contract.test.ts`.
- Gateway/vault paths: `packages/gateway/src/backup/recover.integration.test.ts`, `packages/gateway/src/routes/import-routes.ts`, `packages/gateway/src/routes/import-routes.test.ts`, `packages/gateway/src/routes/route-security.ts`, `packages/gateway/src/serve/build-gateway.ts`, `packages/gateway/src/serve/health-registry.ts`, `packages/vault/src/gateway/portability.ts`, `packages/vault/src/gateway/portable-export.ts`, `packages/vault/src/gateway/sql.ts`, `packages/vault/src/gateway/sql.test.ts`, `packages/vault/src/index.ts`, `packages/vault/src/schema/sealed.ts`.
- Shared fixture: `packages/test-kit/package.json`, `packages/test-kit/src/year3-vault.ts`.
- Gate scripts: `scripts/check-quality-knobs.mjs`, `scripts/check-schema-export-ratchet.mjs`, `scripts/release/nightly-quality-blockers.mjs`, `scripts/release/prepare.mjs`, `scripts/release/publish-guards.test.mjs`, `scripts/test-report/generate.mjs`, `scripts/test-report/validate-matrix.mjs`, `scripts/validate-ui-receipt.mjs`, `scripts/validate-ui-receipt.test.mjs`.
- Gate data/tests: `tests/experience-budgets/client-query-counts.json`, `tests/experience-budgets/gateway.json`, `tests/matrix.json`, `tests/matrix.schema.json`, `tests/perf/gateway-request.perf.test.ts`, `tests/quality/classification-ratchet.json`, `tests/quality/copy-allowlist.json`, `tests/quality/fault-points.ts`, `tests/quality/first-paint-query-counts.test.ts`, `tests/quality/fixtures/kill-mid-write-child.mjs`, `tests/quality/fixtures/kill-mid-write-child.ts`, `tests/quality/kill-mid-write.integration.test.ts`, `tests/quality/offline-reconnect.integration.test.ts`, `tests/quality/unbounded-query-waivers.json`, `tests/quality/user-facing-qualities.test.ts`, `tests/scale/large-vault.scale.test.ts`, `tests/scale/restore-10gib.scale.test.ts`, `tests/schema-export-fingerprint.json`.
- Receipt: `receipts/issue-679-user-facing-quality-gates.md`.

## Out of scope

- No backup engine redesign or new durability mechanism; this issue closes only the specified residual product-path and gate gaps.
- No new follow-up issues were created. The explicit mobile evidence blocker stays visible in this issue's matrix rather than being deferred elsewhere.

## Verification

```sh
bun run test:qualities
bun run test:affected
bun run --cwd apps/desktop test:e2e -- onboarding-home.spec.ts -g '1.2'
test -s artifacts/e2e/ui-impact/issue-679-first-run-home.png
bun run check:pr
bun run check:full
```

## Audit

PASS — the fresh-context re-audit after remediation found no remaining stop-ship gap against #679. The first audit's eight concrete refusals are addressed in the `Final-audit remediation` section above.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019fbe3d-6c4-1785615228-1 | codex | 019fbe3d-6c48-7e73-9c1a-8cff7fa1d9ed | #679 | gpt-5.6-sol | 1990764 | 0 | 129378560 | 251872 | 2242636 | 41.0996 | 1990764 | 0 | 129378560 | 251872 | feat: add user-facing failing quality gates (#679) |
| codex-019fbe3d-6c4-1785615434-1 | codex | 019fbe3d-6c48-7e73-9c1a-8cff7fa1d9ed | #679 | gpt-5.6-sol | 54354 | 0 | 550144 | 4425 | 58779 | 0.3398 | 2045118 | 0 | 129928704 | 256297 | feat: add user-facing failing quality gates (#679) |
| codex-019fbe3d-6c4-1785615493-1 | codex | 019fbe3d-6c48-7e73-9c1a-8cff7fa1d9ed | #679 | gpt-5.6-sol | 1899 | 0 | 102912 | 231 | 2130 | 0.0339 | 2047017 | 0 | 130031616 | 256528 | feat: add user-facing failing quality gates (#679) -m governance: allow-toolchai |
| codex-019fbe3d-6c4-1785615765-1 | codex | 019fbe3d-6c48-7e73-9c1a-8cff7fa1d9ed | #679 | gpt-5.6-sol | 33235 | 0 | 635904 | 1350 | 34585 | 0.2623 | 2080252 | 0 | 130667520 | 257878 | feat: add user-facing failing quality gates (#679) -m governance: allow-toolchai |
| codex-019fbe3d-6c4-1785647649-1 | codex | 019fbe3d-6c48-7e73-9c1a-8cff7fa1d9ed | #679 | gpt-5.6-luna | 168943 | 0 | 2011904 | 10352 | 179295 | 1.0806 | 2249195 | 0 | 132679424 | 268230 | fix: reduce SonarCloud duplication in quality registries (#679) |
| codex-019fbe3d-6c4-1785648704-1 | codex | 019fbe3d-6c48-7e73-9c1a-8cff7fa1d9ed | #679 | gpt-5.6-luna | 83794 | 0 | 6413312 | 9732 | 93526 | 1.9588 | 2332989 | 0 | 139092736 | 277962 | fix: remove remaining route registry duplication (#679) |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | ---: | ---: |

## Steering

PASS — The transcript contains one human message, the initial task request, and no interrupts or mid-task redirects/corrections. It therefore contains zero steering events; the empty `### Steering` ledger records no non-steering messages.
