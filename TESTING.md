# Testing strategy

Centraid tests protect important product flows and invariants, not a test-file count. This document supersedes the product-shape assumptions from #212 and is the durable contract for the suite reorganized in #458 and rebuilt in #656.

## The axiom

This repo is written almost entirely by agents, and agents fail in predictable ways. They optimize for the green checkmark. They grade their own homework. They cannot see the whole suite, so they duplicate. They have no memory, so prose conventions decay. And the agent that writes the code writes the tests that _confirm_ it rather than tests that try to _falsify_ it.

This is not a hypothesis — the repo's own history demonstrates each mode. A probe sentinel was once left behind in a live assertion. Matrix cells were graded solid on the strength of prose. Owners of "solid" cells could skip themselves. Eight files hand-rolled a vault bootstrap that already existed in the test kit. `tests/quality-rig-budgets.json` drifted to describing 9 of 24 rigs while nothing in the repo actually read it.

Therefore:

> **Every quality claim is either computed by a machine or adversarially verified — never asserted by its author.**

Five principles follow, each with a mechanical consequence:

1. **Tests are the spec.** Contracts are the only statement of intent that survives context loss. The priority is more _named laws_, not more tests.
2. **Never trust a green from the author.** Mutation testing is the mechanical adversary: it asks whether a test would notice if the code changed. Line coverage proves execution; only mutation proves detection.
3. **Whatever is not mechanically enforced will regress.** Matrix grades are computed outputs, not typed-in inputs.
4. **Gates must be cheap and deterministic, or agents route around them.** Flakes are quarantined with an expiry — never deleted inline, never retried-in-place until green. Suite wall clock ratchets tighten-only.
5. **Make the right thing the only expressible thing.** Test-kit seams are enforced by lint; one-owner-per-law by a registry check, not by review.

The older working principles still hold and are now consequences rather than assertions: coverage of flows rather than a count of tests; one flow, one home, proven at the cheapest tier that can falsify it; runtime is a budget; duplication is visible; floors ratchet up, never down.

The machine-readable source of product-flow ownership is [`tests/matrix.json`](tests/matrix.json). `bun run test:matrix` verifies its surface/dimension references, owning paths, unique flow ids, and minimum contract sizes — and, since #656, **derives each cell's grade from evidence**. A new test either claims an unowned flow/cell or extends its existing owner.

## What the machine cannot check

The mechanisms below make dishonesty expensive, not impossible. These judgements have no gate, so this is where human scrutiny concentrates:

- **Whether a law is worth writing.** A registry entry proves a law has exactly one owner. It cannot tell you the law matters. A suite of true, trivial laws passes every gate here.
- **Whether a skip's reason is honest.** `tests/skips.json` forces every skip to cite an open issue and give a reason. Nothing checks that the reason is the _real_ reason, or that the issue is being worked.
- **Whether a journey covers what its name claims.** `minimumTests` counts tests; the computed grade checks that they ran. Neither reads the assertions. A journey named "pairing survives a network partition" that never partitions a network is green.
- **Whether a mutation-killing test asserts a law or an implementation detail.** Both raise the score. Only one survives a refactor.
- **Whether a deletion was a de-duplication or a loss.** #656 deleted a dozen restatements and _refused_ four more because the surviving owner turned out to be weaker. That call needed reading both tests, and no gate could have made it.

If you are reviewing agent-authored test work, spend your attention here and let the gates handle the rest.

## Runner and test taxonomy

[Vitest](https://vitest.dev) is the single unit/integration/contract runner. Every package extends one of the presets in [`packages/test-kit`](packages/test-kit), and every node preset explicitly uses the `forks` pool so `node:sqlite` and Worker threads are process-isolated. The node and jsdom presets also set **`expect.requireAssertions: true`** (#496 E5) so an assertion-free test fails; perf/scale configs opt out intentionally. The root [`vitest.config.ts`](vitest.config.ts) aggregates all projects for one v8 coverage result.

| Tier | Marker / location | Owns | Schedule |
| --- | --- | --- | --- |
| Unit / logic | `*.test.ts[x]` | one module's observable behaviour | per PR |
| React Native component | RNTL tests under `apps/mobile/src/**/*.test.tsx` | native roles/state, responder events, and component composition that jsdom cannot falsify | per PR |
| Integration | `*.integration.test.ts` | real SQLite, sockets, processes, or cross-component behaviour | per PR |
| Contract | `*.contract.test.ts` | named product law that refactors must preserve | per PR |
| Boot-the-artifact smoke | `scripts/gateway-package/smoke.mjs` (+ `--base-url` for containers) + path-filtered `gateway-package` workflow | "builds but doesn't start" (host binary **and** Docker image with `/data` volume) | **PR path-filtered** (gateway/protocol/Dockerfile/scripts) + manual `bun run gateway:package:smoke` |
| Desktop journey | `apps/desktop/tests/e2e/*.spec.ts` | real Electron-only assertions | **PR path-filtered** + full nightly |
| Web journey | `apps/web/tests/e2e/*.spec.ts` | real Chromium/PWA/network assertions | **PR path-filtered** + full nightly |
| Mobile journey | `tests/agent-e2e-mobile/flows/*.mjs` | native installed-app assertions | nightly + exploratory |
| Pairing journey | `tests/agent-e2e-pairing/flows/*.mjs` | daemon/CLI/device and relay ceremony | nightly + exploratory |
| Performance | `tests/perf/*.perf.test.ts` | hot-path budgets | nightly |
| Scale | `tests/scale/*.scale.test.ts` | correctness and duration at volume | nightly |
| Mutation | StrykerJS on 16 seeded engine packages | mutation-score floors | nightly (full) + per-PR diff-scoped |

### Opt-in live adapter smoke

`bun run --cwd packages/agent-runtime test:live-adapters` launches the configured external ACP adapters and is intentionally outside CI: it needs local CLI installs and credentials. Run it monthly and before releases or ACP adapter changes; ordinary PR validation uses the deterministic adapter tests instead.

### PR vs nightly (L1 / E2)

Decided in [#468](https://github.com/srikanth235/centraid/issues/468); cite [docs/decisions.md](docs/decisions.md).

| Lane | Runs |
| --- | --- |
| **Every PR** | Unit, integration, contract; matrix validation + **floors ratchet** via `check:pr`; **affected-package vitest** (`turbo run test --filter='[origin/main]'` — changed packages only, not the full dependent graph); **boot-the-artifact smoke** when the `client` filter triggers (includes `packages/gateway` + `packages/app-engine` paths — #496 E7); **path-filtered client e2e** (the `client-e2e` lane of `ci.yml` since #557) |
| **Path filters (client e2e)** | **Web** e2e when `apps/web`, `packages/client`, or service-worker files change; **desktop** e2e when `apps/desktop` changes; **boot-smoke** also when gateway/app-engine change. Shard to keep wall-clock roughly under ten minutes. |
| **Nightly** | Full cross-client suites, perf budgets, mobile (**iOS + Android home-loads**), pairing journeys, scale, **mutation (Stryker)** |
| **Weekly / release opt-in** | Real-weight enrichment goldens: pinned runtime + weights, capability handshake, OCR text, embedding cosine tolerance, face count/geometry, and licence pins. This lane is scheduled, manually dispatchable, and required after model/preprocessing changes; it never joins PR CI. |

**Promotion rule:** if a nightly-only area burns us **twice**, move it to PR-time.

### Nightly SLA (#496 E3)

Soft SLA (auto-issue, not a hard age gate):

1. A **scheduled** nightly that fails opens or updates a single tracking issue titled `[nightly] e2e lane red — tracking` with the Actions run URL and the report link. The report link is the **immutable dated slot** for that run (`test-report/nightly/runs/<date>-<runId>/`), not the `nightly/` alias — the alias is overwritten the next night, so an issue citing it would silently start describing a different run (#557).
2. **Expected response:** within **24 hours** or before the next scheduled run — triage, fix, or document a temporary waiver in the issue.
3. A job result of `cancelled` counts as red alongside `failure` (#557): a dead runner is not a pass. The condition reads `needs.*.result` in aggregate, so a job added to `needs:` is covered without editing a second list.
4. Branch `workflow_dispatch` runs **do not** publish to GitHub Pages (main-only guard on `publish-nightly-report`) so they cannot spuriously red the workflow with a Pages deploy error.
5. A **failed** `test-health-report` job still publishes (#557). The report's purpose is to show red, and the job fails on its own honesty exits _after_ writing the HTML — gating publish on success meant every honesty exit also suppressed the page that would have shown the failure. Only `cancelled` and `skipped` suppress the publish; `skipped` because single-lane dispatch skips the report job and publishing then would false-alarm "HTML missing".
6. Missing nightly HTML is **visible** (error annotation + tracking issue + a failed job), not a silent `::warning` only.
7. The scheduled `companion` lane in `extension-e2e.yml` and the weekly `backup-interop` lane both file their own tracking issues on the same terms.

### Floors ratchet (#496 E4, extended #532)

`tests/coverage-floors.json` values, matrix flow `minimumTests`, and `tests/mutation-floors.json` scores **move only upward**. Perf budget files (`apps/web/tests/e2e/perf-budgets.ts`, `packages/gateway/benchmarks/low-end-budgets.json`) are **tighten-only**: ceilings may drop freely; widening a ceiling or lowering a `min*` floor fails. CI and `bun run test:ratchet` / `check:pr` fail on any decrease/widen unless:

- top-level `approvedDeviation` on `coverage-floors.json` or `mutation-floors.json`,
- per-flow `approvedMinimumTestsDeviation` on the lowered flow, or
- `approvedDeviation` in the perf budget source when deliberately widening.

### Computed grades (#656 Layer 2)

A cell's `solid` / `partial` / `gap` is **derived from evidence**, not read from the JSON. `assessment` survives in `tests/matrix.json` only as a _declared expectation that the computation checks_: declaring above the computed ceiling is a hard error, and declaring below it needs a note. An agent may still type `solid` — the gate simply rejects it.

The ceiling is computed from, in order: the owner exists and declares tests (a zero-test owner is a `gap` at PR time, with no lane run needed); the owner has no inventoried skip site and no default-CI env gate; the cell has a flow with a met `minimumTests`; the declared owner owns one of the cell's flows and no backing file is _oversubscribed_ (the floors it owns exceed the tests it declares — this is what kills "one four-test file owns fifteen cells" as a class); a tier-appropriate adversary exists (a coverage-floor scope for unit/contract/integration, a registered rig budget for perf/scale); mutation score, where a seeded package below `_absoluteWeaknessBelow` can never back a `solid`; and finally fresh run evidence, which can only _lower_ a grade. Absent or stale evidence reports `unknown` — never health.

`solid` is therefore **uncomputable** for a cell whose owner can skip itself, whose flow has no `minimumTests`, or whose package is mutation-weak.

### Skip budget (#656 Layer 2)

Every `test.skip` / `describe.skipIf` / env gate is inventoried in [`tests/skips.json`](tests/skips.json) with an **open** issue and a reason. An uninventoried skip fails `check:pr`. The total is a **down-only** budget under `bun run test:ratchet`: removing a skip demands you tighten the budget, and adding one is a visible, reviewed edit. Keys are `<path>#<ordinal>`, so line drift is a warning rather than churn.

### Law registry (#656 Layer 4)

A named product law carries a machine-readable tag in its test title — `test("[law:backup-no-change] …")` — and is registered under `laws` in `tests/matrix.json` with a statement and its owning file. `bun run lint:law-registry` fails when a tag appears in more than one file (this is "one flow, one home" enforced at write time, which is what makes de-duplication _stick_), when a registered law has no tagged test, or when a tag names no registered law.

### Flake quarantine (#656 Layer 5)

A test that fails nondeterministically moves to [`tests/quarantine.json`](tests/quarantine.json) with an issue, a reason describing _how_ it flakes, and an expiry date. It is **never deleted inline** — that loses the coverage silently — and **never retried-in-place until green**, which converts a real defect into latency. While quarantined it is excluded from the required checks, so the lane stays trustworthy.

On expiry it either returns fixed or is deleted with a receipt. `bun run test:quarantine` (in `check:pr`) makes that stick: an expired entry is a hard failure, so the debt cannot be parked forever. The entry count is a down-only budget, because a quarantine list that only grows is a slow way of deleting a suite.

### Suite wall-clock ratchet (#656 Layer 5)

Every other gate here pushes one way — more tests, higher floors — so the cheapest way for an agent to look thorough was to flood the suite, and the bill arrived as PR latency nobody owned. [`tests/suite-wall-clock.json`](tests/suite-wall-clock.json) is the backpressure: the PR lane's total wall clock is a **tighten-only** ceiling, ratcheted like a perf budget. Adding tests means making something else faster, or widening the ceiling in a reviewed edit that records what the extra time buys.

It measures the sum of per-file durations from the vitest JSON report rather than the run's elapsed time, because elapsed time varies with host load and concurrency while the sum is the work the suite actually asked for. With no report present it prints "not measured" and exits 0 — a budget that could not be measured must never read as a budget that was met.

### Test-kit seams (#656 Layer 4)

The kit path is enforced, not merely recommended. In test files, oxlint bans raw `fs.mkdtemp*` (use `tempDir()` / `tempDirSync()`), `vi.useFakeTimers` / `vi.setSystemTime` / `vi.useRealTimers` (use `useFakeClock()`), and `Math.random()` (use `seededRandom()`). `bootstrappedVault()` exists so the shortest path to a vault fixture is also the correct one.

`Date.now()` is deliberately **not** banned: the defect worth catching is wall clock inside an assertion's expected value, and oxlint cannot express that shape. A blanket ban would touch 162 call sites that are overwhelmingly relative offsets, id suffixes, and elapsed measurement — it would buy a rename, not determinism.

### Skipped-gate honesty + partial → solid (#496 B2/B3)

- Env-gated **cell or flow owners** (`CENTRAID_*`, `CLAWGNITION_*`, whole-file `describe.skipIf` / early `t.skip`) cannot keep a `solid` or `partial` assessment — `bun run test:matrix` fails until the gate is removed or the assessment is demoted.
- Closing a QUALITY / matrix note item **must** promote the assessment and delete/update the note. `partial` is temporary evidence, not permanent furniture.

### Confidence map (#496 J1)

```
HIGH  vault/backup/replica contracts, handler isolation, web offline/PWA,
      pairing when nightly green, engine coverage floors, ENOSPC fault-inject,
      agent chat journey (fake-acp integration)
MED   desktop Playwright, mobile Maestro iOS + Android home-loads, perf/scale
      (generous), tunnel native when module present, multi-writer double-write
SOFT  desktop copilot UI e2e (blocked on #470), builder publish (punted v0),
      mobile on-device perf/scale (honest skip), nightly red → human action
```

Parent backlog: [#496](https://github.com/srikanth235/centraid/issues/496).

`TESTING.md` wins over any suite README that contradicts this split (**L3**).

Playwright alone owns desktop and web regression journeys. The mobile journey layer is the committed agent-driven flows under [`tests/agent-e2e-mobile/`](tests/agent-e2e-mobile); their device-driving substrate is **Maestro**, spawned by the harness ([`lib/harness.mjs`](tests/agent-e2e-mobile/lib/harness.mjs) `runMaestroChunk` runs `maestro --udid … test <flow.yaml>` per step) against an installed development app on a booted iOS Simulator or Android emulator. The `mobile-e2e` job in [`e2e.yml`](.github/workflows/e2e.yml) installs a pinned Maestro CLI and runs those flows nightly. There is no second native suite and no Detox suite. Desktop agent-driven flows were retired after their unique restart/persistence assertions moved to Electron Playwright.

React Native component tests use `@testing-library/react-native` 13 on the **same Vitest runner**. They are reserved for claims that need the RN accessibility/responder tree; pure transforms stay unit tests and recognizer/device integration stays Maestro. The renderer choice, measured cost, and mock boundary are recorded in [`docs/plans/photos-testing.md`](docs/plans/photos-testing.md). A component test over roughly 200ms must state what cheaper layer cannot falsify and should be consolidated with adjacent scenarios rather than spawning another cold renderer file.

### Photos scenario × layer contract (#716)

`U` is a pure/unit test, `C` is the RNTL/Vitest component file, and `E` is one named Maestro journey. A row owns one cheapest falsifying layer; `U + E` is intentional only where the claims differ (model arithmetic versus device gesture/runtime integration).

This table conforms to the reusable [app scenario × layer admission template](docs/plans/app-scenario-layer-template.md). The template is mandatory when an app graduates beyond sample data; it also records the pure-model-beside-the-view, handler-contract, structural-exclusion, north-star-journey, shared-profile, and per-app budget conventions. The Photos rows below remain the unchanged reference instance.

| Photos scenario | U | C | E | Owner / evidence |
| --- | --- | --- | --- | --- |
| drawer activity, hide timer, pinned summary grains | — | ✅ | ✅ | `PhotosHome.test.tsx`; `photos-library.mjs` owns recognizer-vs-sibling hit testing |
| scrub offset → month bubble | ✅ | ✅ | — | timeline-row/model units + native responder geometry |
| empty/loading skeleton geometry | ✅ | ✅ | — | skeleton row packing + rendered progress/grid geometry |
| Select word, role, disabled state | — | ✅ | ✅ | `PhotosSelectChip` semantics; select-write journey |
| search resting/no-hits and grouped album result | ✅ | ✅ | ✅ | search grouping units; no-hits component; `photos-search.mjs` |
| viewer mode chrome and filmstrip current item | ✅ | ✅ | ✅ | viewer models; top chrome/filmstrip component; `photos-viewer.mjs` |
| Collections shelves, empty/collapsed bodies, and menu commands | ✅ | ✅ | ✅ | collection model; shelf component; Photos device entry/drill-down |
| permission-refused behavior (empty-device takeover / seeded-vault continuity) | ✅ | ✅ | ✅ | access predicate/copy proves both branches; panel component and `photos-permissions.mjs` own the empty-vault takeover on a denied device grant |
| selection trash + restore write | ✅ | — | ✅ | write batch units; `photos-select-write.mjs` |

The five Photos device journeys use one gateway and paired profile and target **under eight minutes together per platform**. The denied-permission flow runs first against an explicitly purged vault; the next flow seeds the deterministic scenario for the remaining journeys through normal replica sync. The operational response to a budget breach lives beside them in [`photos-budget.md`](tests/agent-e2e-mobile/flows/photos-budget.md). Mobile offline write/reconnect replay remains a separate reliability journey because it requires host network control rather than a sixth Photos UI path; [#717](https://github.com/srikanth235/centraid/issues/717) owns that reliability contract.

## Five testing layers for the app axis (#725)

Eight apps do not imply eight copies of their shared machinery. The strategy mirrors the product architecture: **engines are tested once; apps are tested as deltas**.

### Layer 1 — engine law

Placement, custody, consent, triage, search, and enrichment each have one canonical matrix flow and named `[law:…]` ownership. Pure surfaces use property or contract tests and qualifying packages carry mutation seeds. An app joins an engine by passing its cell in `tests/matrix.json#appEngines`; it does not restate that engine's behavior in an app-local suite. Every pass cell points to the canonical conformance gate. Every structural non-applicability is a `skip` with a reason and the [seat-doctrine contract](docs/blueprint-seats.md#engine-contracts) citation, never a gap disguised as health.

The enrichment boundary law is especially strict: blueprint apps and automations enqueue consent-scoped `enrich_request` rows and read vault projections. `packages/gateway/src/enrich/service-client.ts` is the service's only product client; the conformance gate scans web, native, and automation source for a second client or direct provider SDK.

### Layer 2 — app delta

A graduating app completes the [scenario × layer template](docs/plans/app-scenario-layer-template.md). Each claim names its cheapest falsifying layer: `U` for a pure model beside the view, `C` for React Native component semantics, or `E` for one named platform journey. `U + E` is allowed only when the two layers prove different claims. Vault-facing actions also have handler contracts. Structural exclusions follow the seat doctrine and are recorded as matrix skips rather than tests of impossible UI.

Byte-bearing apps own one north-star journey per platform and one tighten-only budget file beside their flows. Record-only apps share one representative replica write/read/offline journey until an app gains a genuinely app-specific native integration. Journeys in one platform run reuse a seeded `@centraid/test-kit/year3-vault` profile; a destructive/exclusive-state journey runs first and explicitly reseeds. PR workflows path-filter app journeys by the changed app directory. The suite wall-clock ratchet remains the global backpressure.

### Layer 3 — ML evidence ladder

Each tier makes a different claim. A higher tier does not retroactively turn judgement into a deterministic gate.

| Tier | What runs | What it proves |
| --- | --- | --- |
| **PR** | Fake service fixtures plus pure tokenizer, CTC, NMS, DB postprocess, and geometry units | Wire conformance, sweep transaction invariants, consent gating, honest per-capability unavailability, and deterministic preprocessing/postprocessing without weights or native ML dependencies in the root install. |
| **Nightly** | Fake-service misbehaviours, scale rigs, and provenance/backfill selection properties | Volume correctness, drain invariants, and model-upgrade-as-backfill behavior. |
| **Weekly / release opt-in live** | `bun run --cwd tools/enrichment-service setup`, then `bun run test:enrich:live` over pinned real weights and committed goldens | Actual tensor layouts and preprocessing: exact capability/model handshake, exact OCR text with confidence/box tolerance, embedding cosine tolerance, face count/geometry tolerance, and lock/licence pin integrity. Run after model or preprocessing changes and before releases. |
| **Never a CI gate** | OCR recall, cluster purity, search relevance, and other model-quality judgements | Dogfood evidence, not product law. Findings belong to the D2 ritual in [`docs/photos-dogfood.md`](docs/photos-dogfood.md), not a pass/fail assertion. |

The weekly artifact has its own **eight-day freshness window** in the health report. An absent artifact renders grey/missing, never green; an artifact older than eight days renders stale. Scheduled failure or cancellation opens/updates the lane's tracking issue under the same response terms as the nightly SLA.

### Layer 4 — cost discipline

Per-app journey budgets are tighten-only and sit beside the flows they own, so an overrun has an addressable app owner. Pairing/import/seeding is paid once per platform through the shared profile. Exclusive-state flows run first and restore the deterministic seed for the remaining apps. PR-time path filtering runs an app's journey only when its app surface changes. A single mobile job remains the default until the global wall-clock budget demonstrates that sharding is warranted.

### Layer 5 — honest floors per app

A graduating app leaves the blended coverage floor and receives its own ratcheted scope. Photos is the first: `packages/blueprints/apps/photos/**` has a measured floor, while the remaining `_shared` and seven non-graduated app trees retain a separate blended scope. The blend shrinks as later graduation issues land; a well-tested app cannot subsidize another app forever. Any down-only reseed caused by splitting a denominator is an explicit approved deviation tied to the graduation issue.

Property-style checks follow the normal `*.test.ts` convention and say `property` in the suite name. `.spec.ts` is Playwright-only.

Timeouts come in two tiers. Node projects — the `node:sqlite` ones, which bootstrap real vault/daemon layouts and are therefore fsync-bound — get a 30s default from the shared `nodeProject` preset in [`packages/test-kit/src/vitest.ts`](packages/test-kit/src/vitest.ts); the measurements justifying that number are in the comment there. jsdom projects do no disk I/O and keep Vitest's tight 5s default. The budget is sized for hosted-runner **disk latency variance**, which was measured at up to ~10x between two runner instances executing the identical command — not for v8 coverage instrumentation, which is enabled in the per-PR `ci` lane too. Files slower still than the node default escalate locally with `vi.setConfig` (the gateway CLI suites use 60s); do not add a per-test `timeout` option that sits _below_ its file's budget.

## Product tiers and coverage gates

The deeply gated engine is vault, client replica, gateway, app-engine, automation, backup, blueprints (including its co-located app sources), design (tokens + the kit runtime), agent-runtime, plus pure libraries tunnel, protocol, and cli. Renderer screens and mobile UI are covered by extracted logic plus journeys, not by a whole-surface line percentage. `packages/client/src/replica/**` is gated independently from `packages/client/src/react/**` for that reason.

Floors live in [`tests/coverage-floors.json`](tests/coverage-floors.json) and are consumed directly by the root Vitest config. Floors are a conservative integer margin below the latest measured `bun run coverage` run (2026-08-08; 1,065 files / 11,719 tests):

| Scope | Measured lines / branches | Floor lines / branches |
| --- | --- | --- |
| repo-wide (`lines`) | 63.05 / — | **62** / — |
| `packages/vault/src/**` | 88.57 / 75.24 | **88** / **74** |
| `packages/backup/src/**` | 90.03 / 77.63 | **90** / **74** |
| `packages/blueprints/src/**` | 90.68 / 78.27 | **90** / **75** |
| `packages/blueprints/apps/photos/**` | 46.82 / 42.81 | **44** / **40** |
| `_shared` + non-graduated blueprint apps | 22.53 / 16.92 | **20** / **14** |
| `tools/enrichment-service/src/**` | 68.01 / 51.44 | **66** / **49** |
| `packages/design/kit/**` | 49.56 / 37.27 | **49** / **37** |
| `packages/design/src/**` | 99.03 / 71.42 | **98** / **70** |
| `packages/app-engine/src/**` | 85.45 / 74.44 | **84** / **73** |
| `packages/gateway/src/**` | 79.98 / 66.37 | **80** / **65** |
| `packages/time-engine/src/**` | 84.5 / 67.0 | **82** / **65** |
| `packages/client/src/replica/**` | 76.82 / 63.37 | **75** / **62** |
| `packages/client/src/react/**` | 67.58 / 56.31 | **65** / **54** |
| `packages/automation/src/**` | 84.36 / 77.52 | **82** / **75** |
| `packages/tunnel/src/**` | 72.06 / 52.24 | **70** / **51** |
| `packages/agent-runtime/src/**` | 86.4 / 76.29 | **84** / **75** |
| `packages/cli/src/**` | 84.50 / 82.85 | **83** / **81** |
| `packages/protocol/src/**` | 100.00 / 98.59 | **98** / **96** |
| `apps/oauth-worker/src/**` | 90.65 / 84.23 | **88** / **82** |

The #630 denominator expansion is an approved measurement deviation: the old 71% aggregate excluded 11,639 executable lines under `packages/blueprints/apps` and `packages/design/kit`. Issue #725 graduates Photos to its own scope; the remaining blend covers `_shared` and the seven apps without graduation tables yet. The split is measured on the complete 2026-08-08 run, with the down-only change from the old 17/12 blend documented in `tests/coverage-floors.json`. Real handler contracts and platform journeys own correctness while the line/branch floors ratchet upward from here. The enrichment-service floor is likewise seeded from that run; its live model lane is intentionally separate from PR coverage.

`bun run test` prints the active floors after package tests so the local loop never hides the CI contract; `bun run coverage` measures and enforces them. Floors move only upward (`bun run test:ratchet`).

### agent-runtime coverage strategy

`packages/agent-runtime` keeps a **high branch floor (~85%)**. The line floor sat at the 27%-era seed long after measured coverage cleared it; the 2026-07-31 audit (#656) found sustained 86.4% lines, so the floor now follows the standard ratchet policy (two points under sustained level ⇒ **84**) — the "dedicated coverage campaign" the old note demanded had already happened.

Do **not** lower any engine floor in this table without an explicit issue + receipt. Prefer new pure modules (like `safe-stdin-write`) with unit tests over expanding spawn-heavy turn drivers for coverage alone.

## Named invariant contracts

These suites encode product law and are cataloged by name. The matrix validator also records their current minimum test count so a contract cannot silently shrink in CI.

1. Vault consent gateway and journalled writes — `packages/vault/src/gateway/gateway.contract.test.ts`
2. Backup/restore round-trip and fencing — `packages/gateway/src/backup/backup-service.contract.test.ts`
3. Blob custody / CAS state machine — `packages/vault/src/blob/custody-proven.contract.test.ts`
4. Replica convergence, intent identity, and multi-writer admission — `packages/client/src/replica/intents.contract.test.ts` and `packages/client/src/replica/multi-writer.contract.test.ts`
5. Handler validation and worker isolation — `packages/app-engine/src/handlers/handler-runner.contract.test.ts`
6. Control/app/device session boundaries — `packages/gateway/src/serve/web-app-sessions.contract.test.ts`
7. Scheduler no-backfill semantics — `packages/automation/src/fire/scheduler-ledger.contract.test.ts`
8. Conversation digest → archive → custody-gated prune — `packages/app-engine/src/conversation/archive/archive.contract.test.ts`

Generated-state properties cover blob custody and replica intent idempotency. The replica admission contract owns the multi-tab/same-id writer race.

## Shared test infrastructure

`@centraid/test-kit` is a private, source-exported workspace package. Use it for:

- `tempDir()` / `tempDirSync()` with automatic test-file cleanup;
- `useFakeClock()` with automatic real-timer restoration — the leak it prevents is expensive, because fake timers left installed by a test that threw before its `afterEach` make the _rest of the file_ fail as timeouts rather than as the leak;
- `seededRandom()` for deterministic draws;
- `bootstrappedVault()`, plus bootstrapped `createTestVault()` and listener-free `buildTestGateway()`;
- node and jsdom+JSX+CSS-module Vitest presets;
- deterministic parties, photos, conversations, turns, and blob custody volume fixtures;
- perf/scale JSON result emission.

Do not add another local helper when the shared package already owns the seam — for `mkdtemp`, fake timers, and `Math.random` this is enforced by lint, not left to review (see [Test-kit seams](#test-kit-seams-656-layer-4)).

Deterministic automation fires need no mock: their handlers run in-process against the parent-side `ctx.vault` / `ctx.fetch` / `ctx.state` rails, and only `ctx.agent` reaches a provider. In tests that provider turn is faked through the ACP fake-agent fixture (`packages/agent-runtime/src/backends/acp/fake-acp-agent.mjs`), the same seam chat turns use — there is no automation-specific mock LLM (the `@centraid/mock-llm` package was removed with the `ctx.tool` rail).

## Lane schedule and commands

| Command / workflow | Contents |
| --- | --- |
| `bun run check:pr` | **Before every push:** format + oxlint + turbo lint + typecheck + lint:types + knip + lint:css + test:matrix + **test:ratchet** + **test:ratchet:unit** + **test:affected**. Superset of CI `static` (which omits `test:affected`; full vitest is on `verify`). Vitest alone is not a substitute. |
| `bun run check:full` | `check:pr` plus affected dependents, unified coverage, affected mutation/perf, and desktop/web e2e. Required before requesting merge when shared infrastructure changed. |
| `bun run test` | package unit + integration + contract tests; prints floors |
| `bun run test:affected` | vitest for packages changed since `origin/main` (`turbo --filter='[origin/main]'` — changed packages only; dependents stay on full CI `verify`) |
| `bun run test:affected:full` | vitest for changed packages **and dependents** (`turbo --filter='...[origin/main]'`) |
| `bun run test:ratchet` | coverage floors + `minimumTests` + mutation floors up-only, and perf budgets tighten-only, vs `origin/main` |
| `bun run test:ratchet:unit` | Unit tests for the ratchet / diff-coverage pure functions (`scripts/test-report/vitest.config.ts`) |
| `bun run test:diff-coverage` | changed instrumentable lines vs merge base must be ≥ **80%** covered (`coverage-final.json`); CI `verify` after `coverage` |
| `bun run test:mutation` | StrykerJS on all eight property-defended seeds (nightly); writes `artifacts/mutation/scores.json` |
| `bun run test:mutation:pr` | Per-PR: Stryker on **affected** seeds only + enforce mutation floors |
| `bun run test:perf:pr` | Per-PR: gateway low-end budget gate (also verify CI step) |
| `bun run coverage` | unified per-PR suite, v8 report, floor enforcement, Vitest JSON (`ci.yml` **verify** job) |
| `bun run test:matrix` | catalog/owner/contract validation (also inside `check:pr`) |
| `bun run test:perf` | hot-path budget tests; nightly only |
| `bun run test:scale` | deterministic volume tests; nightly only |
| `bun run test:report` | build `dist/test-report/index.html` (+ `summary.json` / `summary.md`) from available evidence |
| `.github/workflows/ci.yml` | parallel **static** + **verify**, required **check** aggregator (ruleset-required); **publish-report** on main only (Pages); Bun/Turbo/Cargo caches |
| `.github/workflows/e2e.yml` | desktop, web, mobile (iOS + Android home-loads), pairing, perf, scale, **mutation**, full report → **publish-nightly-report** on main only; red scheduled nightly → auto-issue |

### Test-health report (main + nightly)

Public HTML publishes only from **main** (per-merge `ci`) and the **nightly** e2e workflow — not from pull requests. Every `verify` / nightly report job still writes a Job Summary and uploads the `test-health-report` artifact for that run.

| Slot | URL |
| --- | --- |
| main | `https://srikanth235.github.io/centraid/test-report/main/` |
| Nightly (newest — **mutable**, moves every night) | `https://srikanth235.github.io/centraid/test-report/nightly/` |
| A specific nightly (**immutable**, HTML kept 30 deep) | `…/test-report/nightly/runs/<date>-<runId>/` |
| Landing | `https://srikanth235.github.io/centraid/` |

Cite the dated slot when linking a report from an issue or a PR; the `nightly/` alias is only correct for "whatever ran most recently". The full run series (never pruned, even after its HTML is) is `…/test-report/history/index.json`.

Performance and scale budgets use generous regression multipliers. A noisy budget is fixed or removed; it is never promoted to the per-PR loop. Lane results are JSON under `artifacts/perf` and `artifacts/scale`; the nightly workflow restores and appends their bounded cross-run history before the combined report is published. Coverage, desktop Playwright, web Playwright, performance, and scale commands stamp distinct lane-start markers: a cached result not refreshed by that invocation turns grey immediately. Vitest, Playwright, agent-e2e, performance, and scale evidence all carries a capture time and expires after 36 hours. This staleness signal exists because a nightly-only suite rots silently: #458 found the entire desktop Playwright suite red after the React/CSS-modules migrations — hard-coded selectors like `.cd-sb-item`, `.ctx-menu`, and `.modal-card` had all gone dead, exactly the #225-class silent rot — while the per-PR loop stayed green. Grey (or expired) evidence in the report is the standing guard against that class of drift.

The full nightly has a stricter contract than a PR/main report: **zero grey**. Every declared owner must emit matchable evidence, every lane must run, and an owner may not die silently. PR/main reports may remain grey because the nightly lanes deliberately do not run there. A matrix `skip` means structural N/A for the product; missing but valuable proof is a `gap` with a live tracking issue. `partial` means real evidence exists but the cell note names the precise depth still missing. Performance harnesses live in `tests/perf/`, scale rigs in `tests/scale/`, and both write `recordQualityResult` evidence whose `OWNER` matches `tests/matrix.json` exactly.

### Quality-dimension decisions (#587 D21)

- **Supply chain:** accepted as a cross-cutting gate, not a matrix column. The lockfile linter and dependency-review job already own it; duplicating the same result 15 times would imply per-surface evidence that does not exist.
- **Bundle/app weight:** accepted for a follow-up lane and tracking issue. Desktop, web, and mobile have materially different artifacts and need measured baselines before budgets can be honest.
- **Accessibility:** accepted for a follow-up lane and tracking issue. It belongs in the matrix because failures are surface-specific; the first work should establish web/desktop automated coverage and the mobile device path.

The report also consumes `QUALITY.md`'s `## Open` section so field-observed problems sit beside laboratory evidence instead of living in a separate, unseen ledger.

### Mobile liveness and native consistency (#587 E/F)

A green mobile unit lane proves correctness of the code paths it executes; it does **not** prove that Metro can transform/resolve the app or that either native project builds. Expo/React Native peer ranges can accept incompatible major Babel versions at install time. The required PR `mobile-smoke` job is the compensating control: it runs Expo's compatibility check as an advisory, then requires iOS and Android Metro exports plus compilation of the Android application and its native modules to succeed. `expo install --check` currently catches Expo's bundled-native-module version drift, but it does not model the Babel-core/runtime constraints that broke #565 or Kotlin members added by a new Expo Module base class. Metro catches the transform-time and resolve-time failures; the Kotlin compile catches native source/API collisions.

Dependabot continues to propose production major-version updates. Patch and minor updates stay grouped for noise control; each major arrives in its own PR so the test suite can identify precisely which upgrade works and which one breaks a compatibility contract. A failing gate is evidence about that proposed upgrade, not a policy that majors are forbidden.

The same job verifies the committed iOS Pod lock against resolved Expo and React Native, including `React-Core`, `React-Core-prebuilt`, `ReactNativeDependencies`, and Hermes; rejects machine/worktree-shaped native paths; and compares both platforms with `apps/mobile/native-fingerprints.json`. A native dependency, SDK, config-plugin, or generated-project change therefore requires an explicit fingerprint rebaseline after reviewing the native diff. The fingerprint hashes the Iroh tag and separate framework/Swift checksums in `CentraidTunnel.podspec`, not its git-ignored reconstructed framework and Swift binding; running CocoaPods must not change the same checkout's native input identity. It likewise hashes the app's maps configuration and the `react-native-maps` package, but not the package's `RNMapsDefines.h` marker that CocoaPods rewrites from those inputs.

The nightly iOS lane runs on `macos-26` and selects Xcode ≥26.4 before the build. Expo SDK 57's `expo-modules-jsi` declares `swift-tools-version: 6.2` and documents Xcode 26.4+ (Swift 6.3); `macos-15`'s default Xcode 16.4 satisfies React Native's 16.1 floor but fails the JSI xcframework step with exit 65 and an empty "Could not resolve package dependencies" footer (run 30417451436). `apps/mobile/scripts/check-xcode-minimum.mjs` takes the max of React Native's helper minimum and that ExpoModulesJSI floor so a future image roll that drops below 26.4 fails as an `infra-mismatch` before the cold build.

Android decisions mirror iOS where the artifact exists: Android uses the same fingerprint ratchet and path-safe `require.resolve` project configuration. There is no separately committed Android dependency-resolution lock equivalent to `Podfile.lock`, so F26 is structurally N/A there; Gradle resolves against the root Bun install, Metro smoke, and PR-time tunnel-module compile. The nightly Android toolchain remains separately pinned by its JDK/Gradle setup; unlike iOS, React Native exposes no single checked-in minimum-host-version contract to compare before Gradle configuration, so E24's explicit minimum-version preflight is iOS-only.

## Unified report

[`scripts/test-report`](scripts/test-report) ingests the matrix, Vitest JSON, `coverage/coverage-summary.json`, every Playwright JSON result, agent-e2e evidence, and perf/scale JSON. It emits one self-contained page at `dist/test-report/index.html` with:

- seven collapsed user-facing quality rows above the engineering heatmap. Each row shows one status light, its name, the weakest-link sentence, and `N/M gates`; expanding shows only gate status, name, and owner. Lane, cost, knob governance, and demonstrated-red date remain in the gate tooltip. Grey means no gate exists, never health;
- the clickable surface × quality-dimension heatmap first;
- canonical owners, tier, lane, last status, and runtime in the cell inspector;
- coverage versus floor, per-package wall clock, slowest ten files, and skip counts;
- perf/scale trends;
- grey missing or stale evidence instead of an absent lane.

PR CI uploads the report even when coverage fails. Nightly jobs upload surface evidence; the final job merges the latest pairing/relay artifact, reruns the full Vitest coverage suite, then publishes one report after performance and scale run. `bun run test:report:smoke` verifies the generator without requiring prior test artifacts.

The machine-readable qualities layer is `tests/matrix.json#qualities`. `bun run test:matrix` requires exactly seven rows and verifies every gate owner, knob, governance regime, and demonstrated-red date. `bun run lint:quality-knobs` rejects removed gates, widened first-paint query ceilings, and expanded copy/query waivers without `approvedDeviation`.

### Issue #679 lane and fixture decisions

- First-run remains **path-gated on PR and unconditional nightly**. Making desktop, web, and two native device journeys unconditional would exceed the tighten-only PR wall-clock budget; the quality row therefore renders partial when those lanes did not run, never green. Mobile offline writes and reconnect replay are defined product behaviour under the single-gateway topology in [`docs/mobile-offline.md`](docs/mobile-offline.md), so R2 is a testable reliability contract rather than a new product design.
- `@centraid/test-kit/year3-vault` owns the deterministic seed, multi-year/ledger/sealed/parked profile, and cache key used by quality and scale rigs. Byte-heavy owners materialize their own CAS payloads from that identity; never copy a live SQLite file into a cache. Regenerate by changing the explicit fixture version/seed and rerunning the owning rig, after reading [`docs/traps/wal-checkpoint.md`](docs/traps/wal-checkpoint.md).
- `bun run test:qualities` is the deterministic PR gate. Timing evidence remains in nightly perf/scale and uses the existing rig-drift and `tests/experience-budgets/` owners rather than a parallel budget file.

## The test convention

Every test in this repo follows these rules. They are objective enough for an agent to self-check and for review to enforce.

- **Behaviour over implementation.** Assert observable outcomes — return values, persisted state, emitted events — never that a private helper ran or a mock was called. If the refactor is behaviour-preserving, the test must still pass.
- **Real deps; fake only at the edges.** Use the real sqlite, real workers, real modules. Fake only what is non-deterministic or external: clock, network, fs randomness. The backend already does this; keep it the default.
- **One behaviour per test.** A test names a single behaviour and asserts it. No grab-bag tests that drift into asserting incidentals.
- **Assert outcomes, not mock calls.** `expect(result).toEqual(...)`, not `expect(mock).toHaveBeenCalled()`. A `toHaveBeenCalled` assertion is a smell — justify it or replace it with an outcome assertion.
- **Deterministic.** No real time (`Date.now()`/timers — inject or fake), no real randomness, no network. No committed `.only`. A test must pass on every run.
- **Clear failure output.** A failing test must say _what_ broke without a debugger. Prefer specific matchers and meaningful expected values over `toBeTruthy()`.

When in doubt, apply the adversarial check: _could the code be wrong and this test still pass?_ If yes, the test is not yet meaningful.

### ultracite vitest preset (#573)

The convention above is now mechanically enforced where it can be: as of #573 the repo lints test files with **ultracite's `vitest` oxlint preset**, on top of the `core` + `react` presets it already composed. Wiring and caveats:

- **It is spliced, not extended.** The preset delivers every rule through a single `overrides` entry, and an extended preset's overrides outrank the consumer's — so `extends: [vitest]` would leave no way to scope it. Its override is therefore spread into `overrides` in `oxlint.config.ts` verbatim (same rules, same `**/*.{test,spec}.*` glob); only the ordering is ours. This is what makes the two scoping decisions below expressible at all. Partial adoption is otherwise impossible: you cannot turn one of its rules off from the top-level `rules` block the way the core/react opinions are pinned.
- **Playwright e2e is out of scope.** The preset's glob also matches `apps/*/tests/e2e/**.spec.ts`, which are Playwright, not vitest. Left in scope, `prefer-importing-vitest-globals` autofixes a `from 'vitest'` import on top of the `@playwright/test` one and the files stop parsing. A later override turns the `vitest/*` rules off there. This is about which runner owns the file, not about opting out of a rule.
- **`prefer-to-be-truthy` / `prefer-to-be-falsy` are off.** They are the only two rules in the preset that contradict the convention above — `expect(x).toBe(true)` asserts `x` is exactly `true`, `toBeTruthy()` also passes for `1`, `'x'`, `[]`, `{}`. Autofixing them over this suite rewrote 1,117 `toBe(true)` and 720 `toBe(false)` into strictly weaker assertions, so they stay off and `toBe(true)` / `toBe(false)` remain the house style.
- **`prefer-strict-equal` rewrites were hand-reviewed.** The autofix converted 2,436 `toEqual` call sites to `toStrictEqual`, which additionally compares prototypes, `undefined`-valued keys, and array sparseness. Every test the rewrite broke was fixed by tightening the assertion, never by reverting the matcher.
- **Null-prototype rows.** `node:sqlite` returns rows as null-prototype objects, so `expect(stmt.get()).toStrictEqual({ … })` fails against an object literal even when every column matches. The house fix is to spread the actual — `expect({ ...stmt.get() }).toStrictEqual({ … })` — which compares the column data (the contract) without asserting the driver's choice of prototype, and keeps strictness over keys and values. Do not reach for `toEqual` here.
- **`prefer-called-with` autofixes are unsound.** It rewrites `expect(fn).toHaveBeenCalled()` to `expect(fn).toHaveBeenCalledWith()`, which asserts the mock was called with _zero_ arguments. Comply by naming the real arguments, which is what the rule is actually asking for — and what the convention above wants anyway.
- **`valid-expect` is configured with `maxArgs: 2`.** The rule defaults to jest's signature; vitest's `expect` takes an optional second argument, the message printed on failure — `expect(res.status, JSON.stringify(body)).toBe(400)`. Complying with the default would mean deleting those messages. Reach for that second argument when a bare boolean assertion would otherwise print nothing useful — comparing two ordered strings, say, where `toBeGreaterThan` cannot be used because it only accepts a number or bigint:

  ```ts
  expect(a > b, `${a} > ${b}`).toBe(true);
  ```

- **`prefer-import-in-mock` is a type upgrade, so expect fallout.** Rewriting `vi.mock('m', factory)` to `vi.mock(import('m'), factory)` makes vitest typecheck the factory against the real module. That caught 53 mock factories whose stand-ins did not match the module's real types (most often because `Parameters<typeof x>` captures only the _last_ overload of an overloaded export). Fix the factory rather than reverting the form; assert on the single offending property, never the whole module. Two further notes: drop any now- redundant `importOriginal<typeof import('m')>()` type argument, and be aware that the typed form pulls the target into the TS program — for a module outside the package's `rootDir` that breaks typecheck, which is why `packages/blueprints/src/photos-media.test.ts` carries the repo's one justified suppression of this rule.
- **`prefer-describe-function-title` can produce invalid code.** It swaps a string title for a same-named import without checking that the import is callable, so `describe('WAL_CAPTURE_ORDER', …)` became `describe(WAL_CAPTURE_ORDER, …)` — `describe` takes a string or a function, so that fails typecheck. Title such blocks in prose instead. Three sites hit this, and only `typecheck` catches it: the tests still _run_.

### Diff coverage (#532)

After `bun run coverage`, CI `verify` runs `bun run test:diff-coverage`. It intersects `git diff origin/main` added lines (instrumentable `packages/*` / `apps/*` / `tools/*` sources plus the co-located blueprint app/kit runtimes) with Istanbul/v8 `coverage/coverage-final.json`. Threshold is **80%** of changed instrumentable lines. Failures name uncovered hunks. Waive with a non-empty `approvedDeviation` in `tests/diff-coverage-deviation.json` (constitutional exception — temporary).

### Mutation testing (#532)

Nightly StrykerJS (`@stryker-mutator/vitest-runner`) on 16 property-defended core packages, including the enrichment service's tokenizer/CTC/NMS pure-math seed. The canonical seed list is [`scripts/mutation/seeds.mjs`](scripts/mutation/seeds.mjs); examples of its engine scopes include:

- `packages/vault` (custody)
- `packages/client/src/replica` (intents + payload-hash)
- `packages/automation` (scheduler ledger)
- `packages/backup` (AES-GCM seal + WAL address keys)
- `packages/blob-format` (CBSF directory codec)
- `packages/protocol` (handshake judge)
- `packages/tunnel` (wire frame / pair QR / sanitize)
- `packages/app-engine` (pricing cost formula)

Package-local Stryker configs (`stryker.config.mjs` + `vitest.mutation.config.ts`) mutate the property-defended modules; root pointers live under `tests/mutation/`. `bun run test:mutation` writes `artifacts/mutation/scores.json` for the test-health report. Floors live in `tests/mutation-floors.json` and ratchet up-only (measured 2026-07-23/24 — see file comment).

**Per-PR mutation** (`bun run test:mutation:pr` / CI job `mutation-pr`): runs Stryker only for seeds whose `watch` paths intersect `git diff origin/main...HEAD` (or all seeds when mutation infra / floors change), then **enforces** floors on measured packages. Unrelated PRs skip Stryker in ~1s. Nightly runs the full 16-seed lane.

**Per-PR perf** (`bun run test:perf:pr` / verify step): gateway low-end budget gate (`packages/gateway` `perf:low-end`, fsync-required on Linux). Perf budget _numbers_ also tighten-only via `test:ratchet`. Full `test:perf` / Playwright waterfall remains nightly.

### Property contracts (fast-check, #532)

`@centraid/test-kit/fast-check` re-exports a pinned `fast-check`. Core contracts use model-based / property tests across the load-bearing pure surfaces:

| Flow | Owner | `minimumTests` |
| --- | --- | --: |
| `blob-custody-properties` | vault custody-properties | **12** |
| `vault-json-schema-properties` | vault json-schema-properties | **7** |
| `commons-convergence-properties` | vault commons-convergence-properties | **3** |
| `replica-intent-properties` | client intent-idempotency-properties | **10** |
| `replica-payload-hash-properties` | client payload-hash-properties | **7** |
| `scheduler-no-backfill` | automation scheduler-ledger.contract | **23** |
| `backup-crypto-properties` | backup crypto-properties | **8** |
| `backup-wal-address-properties` | backup wal-address-properties | **7** |
| `blob-format-cbsf-properties` | blob-format cbsf-properties | **6** |
| `protocol-handshake-properties` | protocol handshake-properties | **9** |
| `tunnel-wire-properties` | tunnel wire-properties | **5** |
| `app-engine-cost-properties` | app-engine cost-properties | **7** |

### Coverage-scope reachability (#532)

Governance directive `coverage-scope-reachability` fails when a `packages/*`, `apps/*`, or `tools/*` source tree, or either co-located blueprint `apps` / `kit` runtime, has non-test executable source but no coverage floor, matrix owner, or intentional allowlist entry — so a new product surface cannot land invisible to every floor.

## Deliberately deferred

- Per-PR UI / scale / full Playwright perf waterfall (nightly only).
- Chasing 100% or testing trivial getters.
- Mutating whole large modules (WAL seal/replay, tunnel stream I/O, keyring I/O, React shells) — pure property-defended mutate sets only.

## Related

- [Issue #458](https://github.com/srikanth235/centraid/issues/458) — current product-shape audit and reorganization.
- [Issue #212](https://github.com/srikanth235/centraid/issues/212) — original runner and meaningful-coverage strategy.
