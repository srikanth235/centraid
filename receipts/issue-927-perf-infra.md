# issue-927 — perf and scale infrastructure reimagined

Umbrella receipt for [#927](https://github.com/srikanth235/centraid/issues/927). One receipt for the whole umbrella; each slice appends one `## <wave><slice> — <title>` section with its own evidence and audit. The checklist below mirrors the issue's acceptance criteria and is ticked only by the root, from the evidence in the appended sections.

## Checklist

- [x] A developer can run one command that opens each of the eight apps against the golden vault and prints a span waterfall against the last baseline taken on that machine, in under a minute for in-process journeys
- [x] The per-PR perf gate is a work-counter comparison: deterministic, no retry step, no history required; a seeded extra statement or fsync on a hot path fails it on the first run
- [x] The candidate rung runs paired candidate/PR journeys and fails a seeded 20% slow-down with a stated confidence on its first run, with no 30-sample warm-up
- [x] One ledger keyed `surface × journey × volume × hardware` replaces the five budget files, the rig register and the query-count file; every entry names its spans and its consumer; no rig reads the old files
- [ ] The nine journeys have `measured` entries at year-3 volume on web, desktop and gateway, and on a real Android and iOS device for the mobile rows; `"volume": "empty"` appears in no journey entry
- [x] Perf history lives in the gh-pages test-report beside the candidate history; nothing perf-related is stored in an actions cache
- [x] The device rung exists as a lane; the parked mobile lanes are unparked onto it or deleted with the reason recorded
- [x] `docs/decisions.md` § Performance names the journey ledger as the gate for the five evidence-gated designs
- [x] Every #922 receipt from its wave 2 onward cites before/after numbers from this ledger

## What changed

Nothing yet at the umbrella level — the first slice's changes are in its own section below. This heading exists because `receipt-per-issue` requires it on the file that creates the receipt; every subsequent slice appends rather than rewrites.

**Close pass (#927).** The five boxes the close pass ticked, each quoted so `receipt-per-issue`'s crosswalk can read it, with the landed evidence beside it. Nothing above this paragraph is rewritten.

- **The per-PR perf gate is a work-counter comparison: deterministic, no retry step, no history required; a seeded extra statement or fsync on a hot path fails it on the first run** — `scripts/ci/work-counter-gate.mjs` compares the product's own integers against `scripts/ci/work-counters.expected.json`; `.github/workflows/ci.yml` runs `bun run test:perf:counters` with the `strace` install and the retry-once wrapper deleted; both seeds (an extra `SELECT 1`, an extra autocommit barrier) failed on the first run — see `## w1-gate`.
- **The candidate rung runs paired candidate/PR journeys and fails a seeded 20% slow-down with a stated confidence on its first run, with no 30-sample warm-up** — `scripts/ci/paired-journeys.mjs` at rung 3 in `candidate.yml`; a seeded 26 ms (20%) regression read `regressed`, +28.4 ms = 23.3%, 95% CI [18.9, 38.6] ms against a 12.2 ms tolerance, 14 paired rounds, first run — see `## w2 paired runner`.
- **The device rung exists as a lane; the parked mobile lanes are unparked onto it or deleted with the reason recorded** — `.github/workflows/e2e.yml` carries `device-rung-gate`, `device-rung-android`, `device-rung-ios` and `device-rung-gateway-pi` at rung 5, each secret-gated and skipped-not-failed, with `tests/quarantine.json` holding the three parked lanes and their reasons; the #870 parks on `mobile-e2e-android` / `mobile-e2e-ios` are deleted, the reason recorded in `PS-device-rung` — see `## H3`.
- **`docs/decisions.md` § Performance names the journey ledger as the gate for the five evidence-gated designs** — § Performance and Rust byte plane now names `tests/journeys.json` as the gate in the present tense and states what an entry must carry before one of the five is adopted; `PS-evidence-gate`'s "Lands in" cell reads `landed`.
- **Every #922 receipt from its wave 2 onward cites before/after numbers from this ledger** — backfilled as `## Ledger citations (close pass)` in `receipts/issue-922-snappier-blueprints.md`, one row per wave-2-and-later section mapping its number to the ledger entry key it is stated against, or naming the counter/instrument where no ledger entry covers it.

Two more boxes tick in the follow-up commit, one of them after its own text was amended:

- **A developer can run one command that opens each of the eight apps against the golden vault and prints a span waterfall against the last baseline taken on that machine, in under a minute for in-process journeys** — the box read "against the last candidate baseline"; **the box moved, not the command**, on the maintainer's ruling. `scripts/perf/app-waterfall.mjs`'s baseline is machine-local by design and the header argues why: a number from a CI runner is not a number about this laptop, and a developer asking "did my change make Photos slower" is asking about the machine in front of them. `--save` writes the baseline; every later run prints the difference beside the journey's own tolerance from `tests/journeys.json` — the same comparison the candidate rung makes between two trees, done between two runs. Eight apps, one gateway, 4.3 s of measurement and 9.2 s wall against the one-minute cap (`## w2 paired runner`).
- **Perf history lives in the gh-pages test-report beside the candidate history; nothing perf-related is stored in an actions cache** — the last one is deleted: `.github/workflows/soak-weekly.yml`'s "Save evidence for the nightly health report" step `actions/cache/save`d `artifacts/scale/` under `soak-weekly-<os>-<run_id>`, a key **nothing restored**. `grep -rn "actions/cache" .github/workflows/*.yml` no longer names a perf or scale path. The evidence itself is unaffected: the same `artifacts/` tree still rides `actions/upload-artifact` on the step above, and `write-evidence.mjs` still writes the lane's row for the gh-pages report.

**Close follow-up (#927), ledger hygiene.** Quoted for the crosswalk; the verdict is `## Follow-up — #927 close (ledger hygiene)` at the end of this receipt.

- **One ledger keyed `surface × journey × volume × hardware` replaces the five budget files, the rig register and the query-count file; every entry names its spans and its consumer; no rig reads the old files** — the eighteen entries that still carried `consumers: []` now each name a real reader; three of them are additionally marked `_folded_into` a sibling that owns the same fact, with the reason beside the marker. `bun run lint:journey-ledger` is green and its own message is the claim: "every entry names its volume, hardware, spans and consumers".

## Out of scope

Named here once for the whole umbrella, from the issue's Scope § Out:

- Any product hot-path change — that is [#922](https://github.com/srikanth235/centraid/issues/922).
- Telemetry egress of any kind. Traces never leave the owner's machine.
- New product surface: the developer waterfall command is a dev tool, not a screen.
- Rewriting Maestro/Playwright flows that already exist beyond pointing them at the golden vault and the ledger.

## Verification

Per slice, in the appended sections; each carries the exact commands and their outcomes. The gates every slice of this umbrella exits on:

```sh
bun run format
bun run lint
bun run --cwd packages/<pkg> test
bun run --cwd packages/<pkg> typecheck
bun run check:push
bun run check:pr
```

## Decisions

Per slice, in the appended sections.

## Audit

Verdict: PASS — for the slices audited so far. One verdict per slice, written by a
fresh-context verifier under the slice's own `### Audit` sub-heading; the evidence for each lives
there. Slices audited: **w1-core — PASS**, under `## w1-core`. The umbrella verdict
over the acceptance criteria is the root's, once the waves close.

## w1-core — the trace and work-counter contract

The shared, dependency-free contract that every emitter (gateway, web/desktop client, mobile) and every consumer (journey rigs, the ledger, the developer waterfall command) imports, landed alone so the three seat slices can be written in parallel against one type. No emitters in this slice: no gateway, client or mobile code is touched.

### What changed, file by file

- **`packages/core/src/protocol/trace.ts` (new)** — the whole contract, zero runtime deps and no `node:` imports (`packages/core` is consumed from source by React Native):
  - `TRACE_FORMAT_VERSION = 1`.
  - `TraceId`, `TraceIdFactory`, `webCryptoTraceIdFactory`, `mintTraceId(factory?)`, `traceIdOfIntent(intentId)`. For a write the trace id **is** the replica intent id — the same `string` shape `packages/client/src/replica/types.ts` and `packages/vault/src/replica/intents.ts` already use — so the outbox row and the waterfall join without a lookup table. Reads mint one at the seat through the repo's existing generator seam (`globalThis.crypto.randomUUID`, injectable because Hermes has neither `crypto.randomUUID` nor `crypto.subtle`, exactly as `ReplicaIdFactory` in `packages/client/src/replica/digest.ts`). No `Math.random` anywhere.
  - `TRACE_HOPS` / `TraceHop` — the closed nine: `seat | tunnel | gateway | handler | sqlite | commit | sse | apply | render`. `TRACE_SEATS` / `TraceSeat` — `mobile | web | desktop | gateway`. `TRACE_JOURNEYS` / `JourneyId` — the nine journeys of the issue's P5 table.
  - `TraceSpan` — `{ traceId, spanId, parentSpanId?, hop, name, seat, startMs, endMs, attrs? }`, timestamps monotonic-clock milliseconds as numbers, `attrs` a flat `Record<string, string | number | boolean>` (`TraceAttrs`) because a nested attr is not queryable from a budget expression.
  - `WORK_COUNTER_KEYS` / `WorkCounterKey` / `WorkCounters` — exactly nine integer keys (`statements`, `rowsScanned`, `fsyncs`, `bytesRead`, `bytesWritten`, `workerSpawns`, `httpRoundTrips`, `invalidations`, `reReads`), all defaulting to 0, with pure `zeroCounters()`, `addCounters(a, b)` and `diffCounters(before, after)`. One shape serves both the per-trace counters (on the root span) and the per-process running total.
  - `TraceRecord` — `{ root, spans, counters, journey? }`, `spans` carrying every span including the root.
  - `validateTraceRecord(unknown): TraceRecord` — strict: it throws on an unknown hop, seat or journey, a non-integer or negative or unknown counter, `endMs < startMs`, an empty id, a non-flat attr, a root with a `parentSpanId`, a root absent from `spans`, a duplicate `spanId`, a span from another trace, a `root` that disagrees field-by-field (attrs included) with its own entry in `spans`, an unknown parent, and any span not reachable from the root (which is how a detached parent cycle is caught).
  - `waterfall(record)` — pure, ordering spans by start, nesting by parent and offsetting from the root: `{ name, hop, offsetMs, durationMs, depth }[]`. The developer command and the rigs both render from this one function.
  - `TraceSamplingPolicy`, `TRACE_SAMPLING_OFF`, `shouldSample(policy, counterValue)` — emission is off by default and sampled deterministically in the action counter (so two runs of the same rig sample the same actions and a waterfall diff is comparable). The always-on half is the integer counters.
- **`packages/core/src/protocol/trace.test.ts` (new)** — 45 tests: the vocabulary is the closed nine/four/nine; the validator accepts a well-formed record (structurally cloned first, so the parse is over foreign data rather than the fixture's own objects) and a minimal one, and rejects each of 26 malformed classes; two fast-check properties over `@centraid/test-kit/fast-check` (`addCounters` associative with `zeroCounters()` as identity; `diffCounters` inverts `addCounters` on a running total) plus the backwards-counter refusal; `waterfall` nesting on a three-hop fixture with a sibling, its spanId tie-break and a lone root; `shouldSample` always true at `sampleEvery: 1`, always false while disabled (both under fast-check), one-in-N determinism, and the four argument refusals.
- **`packages/core/src/protocol/index.ts`** — the barrel re-exports the contract. `version.ts` is untouched: nothing here changes a wire shape, so no protocol version bump.
- **`docs/logs.md`** — new section "Traces and work counters (#927)": the trace store is sovereign and local-only, lives under the vault's diagnostics, is purged with the vault, and is never egressed; spans are off by default and sampled while the integer work counters are always on; the trace id is the intent id for a write; and `centraid-gateway trace last` is named as the developer entry point for the last tap's waterfall, marked "lands in #927 w1-gateway".
- **`receipts/issue-927-perf-infra.md`** — this file, created by this slice.

### Numbers

No before/after performance number: this slice adds no code to any hot path. Its measurable claim is coverage, and `packages/core/src/protocol/**` carries a 98 lines / 96 branches floor in `tests/floors.json` that must not be diluted.

| Metric | Before | After | Provenance |
| --- | --- | --- | --- |
| `trace.ts` statements / branches / functions / lines | n/a (new file) | 100% / 100% / 100% / 100% (144/144, 93/93, 23/23, 136/136) | `node ../../node_modules/vitest/vitest.mjs run --coverage --coverage.reporter=text --coverage.include='src/protocol/trace.ts' src/protocol/trace.test.ts` from `packages/core`, host Linux 6.18 x64 / 4 cores / 15 GB, 2026-09-03 |
| `@centraid/core` suite | 246 tests, 16 files | 291 tests, 17 files | `bun run --cwd packages/core test` on the same host |

The new file is above the `packages/core/src/protocol/**` floor on both axes, so the floor is untouched — no ratchet moved, no `approvedDeviation` needed.

### Deleted

Nothing. This slice is additive by construction: the machinery #927 deletes (the actions-cache history, the 30-sample drift rule, the 3× catastrophe rule, the retry-once step, `client-query-counts.json`, the serial-pool requirement) belongs to waves 2 and 5, and nothing in the repo is superseded by a type contract alone.

### Decisions

1. **The parser is strict, against `docs/protocol.md` C1's "parse always succeeds".** C1 governs the wire between two hosts that may run different versions; a trace record is written by one process and read on the same machine, so no such skew exists. The concrete property the strictness buys: an unknown hop, seat or journey means an emitter is out of step with the ledger, and a budget query over a vocabulary that silently accepts new members would report a missing hop as a fast hop. This is named in the file header so a later reader does not "fix" it toward tolerance.
2. **`diffCounters` throws when a counter goes backwards** rather than clamping to zero. Counters only climb within a process, so a negative delta means the two reads straddled a reset — precisely the case the merge rung must not average into a passing number.
3. **`traceIdOfIntent` is an identity function and is kept anyway.** The property it buys is grep-ability: a write path that mints its own id is visible in review as the absence of this call, and the alternative (a comment asking emitters to reuse `intentId`) is not checkable.
4. **`validateTraceRecord` requires every span to be reachable from the root.** A span has at most one parent, so a detached island or a parent cycle is exactly the set the walk cannot reach; one rule covers both, and `waterfall` can then be a plain DFS with no cycle guard on the hot path.
5. **Sampling is deterministic in an action counter, not random.** Randomness would make two runs of the same rig sample different actions, which is what makes a waterfall diff meaningless. `shouldSample` is therefore a pure `counterValue % sampleEvery === 0` behind an `enabled` gate whose shipped default (`TRACE_SAMPLING_OFF`) is off.

6. **A `root` that disagrees with its own entry in `spans` is rejected, not reconciled.** Found by the verifier: the first version accepted the disagreement and silently returned the `spans` copy. `root` and that entry are the same span written twice, and consumers read whichever copy is nearer — `waterfall` offsets from `record.root` while rendering the `spans` copy — so two copies that disagree produce a different waterfall depending on which field was read. `assertRootAgreesWithSpans` compares `traceId`, `parentSpanId`, `hop`, `name`, `seat`, `startMs`, `endMs` and an order-independent attrs signature, and names the disagreeing field in the message. Picking a winner would have buried an emitter bug in a number.

No ruling was re-judged in this slice — it introduces a contract rather than keeping an existing seam. The rulings #927 re-judges (#659 R2/R4, #873, #456, #532) are owned by waves 2 and 5.

### Verification

```
$ bun run format
Finished in 5806ms on 5353 files using 4 threads.

$ bun run lint
(green)

$ bun run --cwd packages/core test
Test Files  17 passed (17)
     Tests  291 passed (291)

$ bun run --cwd packages/core typecheck
tsc -p tsconfig.test.json --noEmit  (green)

$ bun run --cwd packages/core build
tsc -p tsconfig.json  (green)

$ cd packages/core && node ../../node_modules/vitest/vitest.mjs run --coverage \
    --coverage.reporter=text --coverage.include='src/protocol/trace.ts' \
    src/protocol/trace.test.ts
Statements   : 100% ( 144/144 )
Branches     : 100% ( 93/93 )
Functions    : 100% ( 23/23 )
Lines        : 100% ( 136/136 )

$ bun run check:push
✗ 15/17 gates passed — design:gallery, lint:product (test:ratchet + lint:ledgers)
  Both reproduce on a clean origin/main checkout; see "Pre-existing reds" below.
```

### Pre-existing reds, reproduced on `origin/main`

Neither is caused by this slice — the diff touches no ledger, no floor and no
rendering path — and both were reproduced on the root checkout sitting on
`origin/main` (cf616a09) with a clean working tree:

```
$ git log --oneline -1
cf616a09 refactor(vault)!: close the v0 ontology — one file, one baseline, entity supertype, access plane (#916)
$ git status --short
(clean)
$ node scripts/check-ledgers.mjs
check-ledgers: the ledgers may only tighten (base origin/main)
  - tests/floors.json#minimumTests: flow replacement names unknown predecessor "schema-migration-corpus"
$ bun run design:gallery
Executable doesn't exist … npx playwright install
```

1. **`test:ratchet` / `lint:ledgers`** — `tests/floors.json#minimumTests` carries a `replacesMinimumTestsFlow` entry naming a predecessor flow, `schema-migration-corpus`, that no longer exists in the ledger. The check validates head's own mapping, so it fails on every branch cut from `main` regardless of diff. Not fixed here: `tests/floors.json` is outside this slice's contract, and repairing a rename mapping needs the owning issue's intent. Filed to the root.
2. **`design:gallery`** — Playwright browsers are not installed in this container. Environment, not code; already recorded as container-only red in `receipts/issue-905-*.md`.
3. **`repo-hygiene` (pre-push)** — `packages/blueprints/apps/locker/queries.test.ts` is 638 lines against a 625-line limit, on `origin/main` and untouched here. Splitting that suite is not this slice's contract; filed to the root.

Nothing was weakened to go green: no floor moved, no `approvedDeviation` extended, no allowlist touched.

### Claims an auditor should attack

Not an audit — the author's own list, left here so the root's fresh-context verifier has claims to attack rather than reconstruct. The verdict itself belongs to that verifier and is written by it, not by this slice.

- Every number in this section is reproducible from the commands in Verification. The counts were checked mechanically, not asserted: 45 tests (`vitest --reporter=verbose`), 26 malformed classes in the `it.each` table, 100% of 144 statements / 93 branches / 23 functions / 136 lines on `trace.ts`, and `check:diff-coverage` reports 100.0% (260/260) over the diff.
- The weakest claim is "no `deliberate` seam without a property". The six entries under Decisions each name one, but decision 3 (`traceIdOfIntent` as an identity function) is the one to push on: the property is review-time grep-ability, which is real but weaker than a runtime property. If the root disagrees, the fix is to delete the function and put the rule in the emitter slices' review checklist instead — nothing else in the contract depends on it.
- The strict parser is a deliberate departure from `docs/protocol.md` C1, argued in the file header and in Decisions 1. If a trace record ever becomes something one machine sends to another, that argument dies with it, and the parser must change in the same slice.
- Three gates are red, all reproduced on a clean `origin/main` checkout — transcript in "Pre-existing reds" above. Nothing was weakened to go green; no floor, budget, allowlist or ratchet is touched by this diff.
- Scope: `git diff origin/main --stat` is exactly the five files this slice's contract names. `packages/core/src/protocol/version.ts` is untouched, so no wire version moved.

### Verifier findings, fixed

Both findings the verifier raised below were fixed after its verdict; its text is left exactly as written.

1. **Miscount in this section.** The `it.each` table held 24 rejection cases, not the 23 claimed (the single-line first row was missed by the count). Every mechanical number in this section was then re-derived rather than adjusted: 45 tests, 26 rejection cases, 144/93/23/136 coverage, 291 tests in `@centraid/core`, 260/260 diff coverage.
2. **`validateTraceRecord` accepted a self-contradicting record.** A `root` that disagreed with its same-`spanId` entry in `spans` (e.g. root `hop: "seat"`, the `spans` copy `hop: "render"`) was accepted and the `spans` copy returned silently. `assertRootAgreesWithSpans` in `packages/core/src/protocol/trace.ts` now rejects it and names the disagreeing field; two rejection cases were added (a scalar field and an attrs disagreement), taking the table from 24 to 26 with `trace.ts` still at 100% coverage. Rationale in Decisions 6.

### Audit

Verdict: PASS

Written by the root's fresh-context verifier, which saw only the diff, this receipt and
issue #927. Not self-authored by this slice.

Verified:

- **Scope** — `git diff origin/main...HEAD --name-only` is exactly the five files the
  slice contract names (`docs/logs.md`, `packages/core/src/protocol/{trace.ts,trace.test.ts,index.ts}`,
  this receipt). `packages/core/src/protocol/version.ts` is untouched: no protocol version bump.
  Every changed file is named in the section above.
- **Checklist ↔ issue** — the nine `## Checklist` lines are byte-identical to #927's
  acceptance criteria (`diff` against the issue body: no output). All nine remain unticked,
  correct for a wave-1 contract slice.
- **Vocabulary ↔ issue** — nine hops (`seat…render`) match P1's hop list; four seats match
  the surfaces P1/P5 name; nine journeys match P5's table row for row; nine counter keys match
  P2's list (`bytesRead`/`bytesWritten` being P2's "bytes read and written").
- **Constraints** — no `Math.random`, no `Date.now`, no `node:` import and no runtime dependency
  in `trace.ts` or its test (grep, exit 1). `TraceId` is the intent id's exact shape: intent ids
  are plain `crypto.randomUUID()` strings with no prefix (`packages/client/src/replica/{digest.ts,intents.ts}`,
  `apps/mobile/src/lib/replica/mobile-intent-id.ts`), so `traceIdOfIntent` correctly does not
  transform and `mintTraceId`'s default factory mints the same shape. The injectable
  `TraceIdFactory` mirrors the repo's existing `ReplicaIdFactory` seam for Hermes.
- **Numbers reproduced on this host** (Linux 6.18 x64): 43 tests in `trace.test.ts`;
  100% statements 133/133, branches 87/87, functions 20/20, lines 126/126 from the receipt's own
  coverage command; `@centraid/core` 289 tests / 17 files. `tests/floors.json#coverage` still
  carries `packages/core/src/protocol/**` at 98 lines / 96 branches, unchanged by this diff —
  no floor, budget, allowlist or ratchet is touched, no `approvedDeviation` claimed.
- **Property tests** — re-ran the `addCounters` / `diffCounters` / `shouldSample` properties out
  of `packages/core/dist` under five fresh seeds (1, 7, 123456, 987654321, and a clock-derived one)
  at 500 runs each: all green, so the committed seeds are not load-bearing.
  `expect.requireAssertions` is on for this package via `nodeProject`
  (`packages/test-kit/src/vitest.ts`) and the suite passes, so every test asserts.

Gates run (all from the worktree):

```sh
bun run format                       # clean; git status --short empty afterwards
bun run lint                         # green
bun run --cwd packages/core test     # 17 files, 289 tests passed
bun run --cwd packages/core typecheck# green
bun run --cwd packages/core build    # green
bun run --cwd apps/mobile typecheck  # green (consumes core from src)
bun run --cwd packages/client typecheck # green
bash .governance/run.sh              # 21/22 — only the pre-existing repo-hygiene
                                     # file-size red on packages/blueprints/apps/locker/
                                     # queries.test.ts (638 > 625), present on origin/main
                                     # and untouched by this diff
```

Findings — none blocking; three the root should carry forward:

1. `receipts/issue-927-perf-infra.md` (this section's parent, "43 tests … rejects each of 23
   malformed classes") → the `it.each` table has **24** rejection cases, not 23
   (`vitest list src/protocol/trace.test.ts | grep -c 'rejects '` → 24). The count understates
   the work; fix is the digit.
2. `packages/core/src/protocol/trace.ts:283` `validateTraceRecord` accepts a record whose `root`
   object disagrees with the same-`spanId` entry inside `spans` (verified: a root with
   `hop: "seat"` and a spans copy with `hop: "render"` parses, and the spans copy silently wins).
   The returned record is self-consistent, so nothing downstream breaks, but a strict parser that
   rejects "a root absent from `spans`" should also reject a root that contradicts it — an
   emitter writing two different roots is exactly the bug class this parser exists to catch.
   Fix: compare the parsed `root` to `byId.get(root.spanId)` field by field and throw on mismatch.
3. `packages/core/src/protocol/trace.ts:150` `diffCounters` throwing on a backwards counter is the
   right contract **for a consumer** (a rig or the merge rung must not average a straddled reset
   into a passing number) but is a hazard for the emitter slices: on a hot path a throw turns a
   diagnostic anomaly into a user-visible failure, and a fresh worker or a per-request counter reset
   makes a backwards delta reachable. Not a defect in this slice; the w1-gateway/client/mobile
   contracts should state that emitters call `diffCounters` off the product path or behind a guard.

Judged and not findings:

- `traceIdOfIntent` as an identity function: it costs nothing, is covered, and does buy a
  greppable call site, but it buys no runtime or type property today because `TraceId` is a bare
  `string` alias. If it stays, brand `TraceId` so the two id-producing functions become the only
  way to make one; that is a strictly better version of the same argument. Keeping it as-is is
  acceptable.
- `globalThis.crypto.randomUUID` on Hermes: `mintTraceId(factory?)` defaults to WebCrypto and takes
  an injected factory, identical to `IntentQueue`'s `webCryptoIdFactory` default, and the header
  says why. No polyfill is required by this package; the mobile emitter slice must pass
  `nativeReplicaIdFactory` (expo-crypto), as `native-hash.ts` already does.
- `docs/logs.md` `centraid-gateway trace last`: worded as a forward pointer
  ("_Lands in #927 w1-gateway_ — … the command and the store that backs it arrive with the gateway
  emitter slice"), so it is not a claim that the command exists. It would read less ambiguously with
  the marker leading the paragraph rather than closing it.
- The strict-parser departure from `docs/protocol.md` C1 names a concrete property (a closed
  vocabulary, so a budget query cannot read a missing hop as a fast hop) at the seam itself, not a
  bare citation.
- The three red gates (`lint:ledgers`/`test:ratchet`, `design:gallery`, `repo-hygiene` file-size)
  reproduce on `origin/main` and are outside this slice's contract; nothing was weakened to go green.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-09-05 | claude-code | 60f9e86b-149f-5fc9-84c0-f2160b6b6f3c |

## w1c — golden year-3 vault and golden phone replica

### What changed, file by file

- **`packages/test-kit/src/year3-vault.ts`** — `YEAR3_FIXTURE_VERSION` 1 → 2.
  Adds `Year3Distributions` (the declared shape of the owner's third year) and
  `YEAR3_DISTRIBUTIONS`: notes with a `longNoteShare` over the replica's 64 KiB
  value ceiling, `eventDays`, `automations`, `mountedVaults`, `grantees` /
  `granteeCircles`, `receiptDays`, `replicaRows`, `dailyPathPhotos`. Adds
  `goldenYear3Profile()` (the named golden artifact: the year-3 profile with
  the daily-path photo count and the distributions attached) and
  `year3FixtureCacheRoot()` (the ONE place the cache is named). `seedYear3Vault`
  gains an opt-in `counts.distributions` branch that seeds notes (bodies as
  base64 `data:` URIs on `core_content_item`, exactly as `schema/fts.ts`
  requires), three calendar years of `core_event`, 50,000 `schedule_task` rows,
  200 automations' `automation_state` + `automation_trigger_cursor`, a circle
  and its `tally_group`, grantee `share_party_vault_binding` +
  `share_authority` rows (view over `media.asset`, one circle-principal edit
  over `tally.group`), and a year of chained `access_receipt` rows. Plants the
  two search needles (`YEAR3_CONTACT_NEEDLE`, `YEAR3_NOTE_NEEDLE`) in the
  fixture itself so no rig writes to the artifact it measures.
- **`packages/test-kit/src/year3-shape.ts`** (new) — types and constants only:
  `Year3Distributions`, `Year3VaultProfile`, `Year3Sqlite`,
  `Year3VaultTarget`, `Year3SeedCounts`, `YEAR3_DISTRIBUTIONS` and the two
  search needles. Re-exported in full by `year3-vault.ts`, so `./year3-vault`
  remains the one public subpath.
- **`packages/test-kit/src/year3-distributions.ts`** (new) — the distribution
  half of the seeder, split out of `year3-vault.ts` so no file is a god file:
  `seedYear3Distributions`, `longNoteBody`, `NOTE_WORDS`, `Year3SeedContext`.
  Same statements, same behaviour, one import seam.
- **`packages/test-kit/src/year3-replica.ts`** (new) — the golden phone
  replica: `buildYear3ReplicaSnapshot` walks the vault's own
  `readReplicaRows` and assembles the bootstrap snapshot a phone receives,
  deriving the shape catalog from the reader's answer rather than a hand-written
  column list; `year3PendingIntents` builds the converge journey's outbox at
  N ∈ {1, 10, 40} through the phone's own canonical payload hash;
  `year3ReplicaCacheKey` content-addresses a replica off the vault's key.
- **`packages/test-kit/src/year3-vault.test.ts`** (new) — distributions present
  in a real bootstrapped file, seed determinism, the plain profile carrying no
  distributions, cache-key coverage, cache hit/miss and schema-bump
  invalidation.
- **`packages/test-kit/src/year3-replica.test.ts`** (new) — per-entity row
  counts equal to `snapshot.ts`'s own read, the long bodies landing in the
  DEFERRED half and absent from `values`, the ceiling, outbox determinism at
  all three volumes, cache-key separation.
- **`packages/test-kit/package.json`** — `./year3-replica` export.
- **`tests/helpers/factories.ts`** — `goldenYear3Vault()` (materialize or
  reuse, plus the four companion vaults of the five-vault footprint) and
  `goldenYear3Replica({ pendingIntents })` (real `ReplicaSqliteStore.bootstrap`
  over `NodeSqliteDriver`, the phone's `SqliteIntentStore` for the outbox,
  `VACUUM INTO` for the on-disk artifact). `createTestVault`'s dynamic import
  is aliased so the new static imports do not shadow it.
- **`tests/scale/large-vault.scale.test.ts`** — mounts the golden vault. Its
  inline seeding (1,000 notes, 1,096 events, two needles patched in by UPDATE
  after the copy) is deleted; all four assertions are unchanged.
- **`tests/scale/replica-bootstrap.scale.test.ts`** — gains three additive
  `test.each` cases that materialize the golden phone replica at N = 1, 10, 40
  and reopen it. The two existing tests are untouched.
- **`tests/scale/photos-timeline.scale.test.ts`**, **`tests/scale/restore-10gib.scale.test.ts`**
  — one expression each: `cacheRoot` now comes from `year3FixtureCacheRoot()`
  rather than an inlined `process.env.CENTRAID_YEAR3_CACHE_DIR ?? …`. Profiles,
  seeds and assertions untouched.
- **`tests/experience-budgets/README.md`** — the year-3 table gains a **golden
  artifact** column naming the fixture field per row, plus rows for calendar
  events, grantees, audit receipts and pending intents. No ceiling changed.

### Numbers

Host: this session's container, Linux 4 cores / 15 GB, node 22, `/tmp` scratch.
Volume: `goldenYear3Profile()`.

| Measurement | Value | Command |
| --- | --- | --- |
| Golden vault build, cold | 20.3 s (test body), 25.0 s wall | `bun run test:scale -- tests/scale/large-vault.scale.test.ts` (empty cache) |
| Golden vault mount, warm | 0.43 s (test body), 4.9 s wall | same command, second run |
| `vault.db` on disk | 106,217,472 B (101.3 MiB) | `ls -la <cache>/vault.db` |
| Golden fixture directory | 126 MB (vault + 4 companions) | `du -sh` |
| `replica.db` on disk | 33,304,576 / 33,312,768 / 33,325,056 B (N = 1 / 10 / 40) | `ls -la <cache>/*/replica.db` |
| Golden replica build, cold, all three N | 34.0 s (test body) | `bun run test:scale -- tests/scale/replica-bootstrap.scale.test.ts` |

Row counts in the built artifact (`SELECT COUNT(*)` on the cached `vault.db`):

| Dimension | Rows |
| --- | --- |
| `core_party` | 5,001 (5,000 + the bootstrapped owner) |
| `media_asset` | 10,000 |
| `core_content_item` | 11,000 |
| `knowledge_note` | 1,000 |
| note bodies > 64 KiB | 30 (3.0% — the declared `longNoteShare`) |
| `core_event` | 1,096 |
| `schedule_task` | 50,000 |
| `access_receipt` | 365, spanning 2025-01-01 → 2025-12-31 |
| `share_party_vault_binding` (live) | 12 |
| `share_authority` | 14 (12 view + 1 circle edit + 1 bootstrap device) |
| `social_circle` | 1 |
| `automation_state` | 200 |
| `core_tag` | 200 |
| `replica_change` | 78,376 |
| Golden replica rows | 50,000 |

**`vault.db` size is a sample, not a constant.** This run measured
106,217,472 B; the verifier measured 106,258,432 B and 106,299,392 B across
two further builds of the same profile at the same seed. The artifact is
row-identical but NOT byte-reproducible, because `bootstrapVault` mints
`uuidv7` owner/vault/device ids and several schema DEFAULTs are wall-clock —
vault behaviour tracked as #935, not kit nondeterminism.
`year3-vault.test.ts` claims exactly the row-identical scope and no more.
Quote the size as "about 101 MiB", never as an exact figure.

There is no before/after here to compare: this slice adds a fixture, it does
not change a hot path. The numbers above are the artifact's own cost, recorded
so wave 3 can state what mounting it costs a journey rig.

### What was deleted

- `tests/scale/large-vault.scale.test.ts`'s inline corpus — 1,000 notes with
  their content items, 1,096 `core_event` rows, and the two `UPDATE`s that
  patched search needles into a fixture after it was copied. Replaced by the
  golden vault's own declared dimensions and its planted needles.
- The `artifacts/year3-cache` SHAPE inside rig bodies: the env-var-or-temp-dir
  dance is now `year3FixtureCacheRoot()`, one function, defaulting to the
  host's scratch dir so a second local run is warm. All four rigs that
  materialize a year-3 fixture call it — `large-vault` and `replica-bootstrap`
  through `goldenYear3Vault`, and `photos-timeline` and `restore-10gib`
  directly (mounting-only change; their assertions and profiles are
  untouched). No rig body inlines `process.env.CENTRAID_YEAR3_CACHE_DIR ?? …`
  any more; the only remaining literal `artifacts/year3-cache` in the tree is
  in `.github/workflows/e2e.yml`, which #927 w2 owns.

### Decisions

1. **The distributions are opt-in on the seeder, not on the plain profile.**
   `year3VaultProfile()` deliberately returns `distributions: undefined`;
   `goldenYear3Profile()` attaches them. `photos-timeline` and `restore-10gib`
   spread the plain profile for one axis, and silently giving them a year of
   receipts and 50,000 tasks would change what those rigs measure without
   anyone deciding to. A rig opts into year-3 distribution by mounting the
   golden vault.
2. **The golden vault's photo count is the DAILY-PATH 10,000, not the library
   90,000.** The golden vault is what a journey opens, and a journey reads the
   daily path. The 90,000-asset library stays the plain profile's number, owned
   by the two rigs that measure the library itself.
3. **`replicaRows` is seeded as `schedule.task`.** That is the shape the two
   rigs owning the "50,000 replica rows on a phone" dimension already walk. The
   daily-path corpus alone yields ~27,000 mirrorable rows; padding it with
   photos nobody declared would have been inventing a number, and declaring the
   phone volume unmet would have left the golden replica short of its own
   declaration.
4. **The share rows are MIRRORED, not imported.** `@centraid/test-kit`
   deliberately does not depend on `@centraid/vault` (the vault devDepends on
   the kit), so `createShareGrant` and `bindPartyToVault` cannot be called from
   the seeder. Each block names the writer it mirrors, and the kit's own suite
   runs those statements against a real bootstrapped schema — which is what
   catches a mirror going stale. Ids are deterministic where the commands mint
   a `uuidv7`: an id is opaque, and a fixture that is not reproducible is not
   an artifact.
5. **The kit's suites import the vault and the client by PATH.** A package
   import would close a dependency cycle. This adds no dependency edge and no
   type dependency.

### Re-judged rulings

- **`year3FixtureCacheKey` carries the schema ladder length (#883/#915
  lineage).** Kept, and the property is concrete for the product as it is now:
  the fixture IS a vault on disk, and a cached directory built before a
  migration rung, opened by post-rung code, is the failure that ruling was
  written from. The version bump to 2 rides the same key, so the distributions
  change invalidates every cached directory without a manual purge.
- **`multi-vault-footprint.scale.test.ts`'s "row volume is deliberately
  bootstrap-only".** Re-judged and KEPT, with the property named: the pragmas
  under test are reservations made at open time and are exact regardless of row
  count, so seeding the golden vault into all five mounts would add minutes of
  build time and change no measured value. The golden artifact still carries
  the dimension (`mountedVaults`, and `goldenYear3Vault().companionDirs`
  materializes the four companions) so a wave-3 journey rig that DOES read from
  five mounts has them.

### Findings and handoffs

1. **`.github/workflows/e2e.yml` still names `artifacts/year3-cache`** (lines
   ~1439, ~1450, ~1515, ~1527) as the `CENTRAID_YEAR3_CACHE_DIR` value and the
   cached path. Workflows are #927 w2's, so this slice left them alone; the env
   var is still honoured by `year3FixtureCacheRoot()`, so CI is unaffected. w2
   should retire the literal path along with the rest of the actions-cache
   shape the issue deletes.
2. **`replica-reconnect.scale.test.ts` and `replica-bootstrap.scale.test.ts`'s
   gateway test cannot be converted by mounting alone.** Both seed their
   50,000 rows into a LIVE gateway plane (`serve()` / `openVaultPlane`) and
   pin their assertions to that plane's grant scope and cursor arithmetic;
   mounting a pre-built vault into a gateway data dir is a journey-rig change,
   which is #927 w3's. The golden vault now carries the rows they would need
   (50,000 `schedule.task`, ids `year3-NNNNNN` — the scheme `replica-reconnect`
   already walks), so w3's conversion is a mount rather than a reseed.
3. **`mobile-reconnect-to-fresh.scale.test.ts` drives
   `createNativeReplicaSession` against an in-memory corpus fixture**, not a
   replica file. Pointing it at the golden replica is a rewrite of how the
   session is opened, again w3's.
4. **`photos-timeline.scale.test.ts` is red at the base**: it inserts
   `media_asset.favorite`, a column #916 deleted. Reproduced on a clean tree.
   Nothing in this slice touches it beyond the one-expression cache-root
   conversion; whoever finishes #916's fallout, or #927 w3 when it rewrites
   the rig, owns the fix.
5. **`large-vault`'s 30 s seed budget has ~6 s of headroom on a cold golden
   build** on this host, and none under CPU contention. Not widened. See the
   verification note above for the two ways out; both are the root's or w2's
   to choose.
6. **`openVaultDb` writes its identity key to `<parent-of-vault-dir>/keys/`**,
   so materializing a fixture leaves an orphaned `<tmpname>.identity` pair in
   the cache root after the atomic rename. Pre-existing for every year-3 rig
   today and harmless (the seal key is explicit and the copy regenerates its
   identity on open), but it means the cache root accumulates dead key files.
   Not owned by this slice; recorded for whoever owns `schema/vault-identity.ts`.

### Verification

First pass, before the audit. It is recorded as run and is superseded by the
re-run under `#### Fix after audit` below; `bash .governance/run.sh` is missing
from it, which is finding 6 of that section.

```sh
# in /home/user/centraid-wt/claude/927-w1c-golden-vault
bun run format                                   # 5354 files, clean
bun run lint                                     # oxlint --deny-warnings, clean
bun run lint:vault-sql                           # ok — 489 refs / 4241 files / 42 allow-listed
bun run --cwd packages/test-kit test             # 5 files, 76 tests passed
bun run --cwd packages/test-kit typecheck        # clean
bun run --cwd packages/vault test                # unchanged package, green
bun run --cwd packages/vault typecheck           # clean
bun run typecheck                                # root, clean
bun run lint:product                             # clean
bun run test:scale -- tests/scale/large-vault.scale.test.ts
#   cold: 1 passed, 24.35 s (fixture build 20.3 s)
#   warm: 1 passed,  4.26 s (fixture mount 0.43 s)
bun run test:scale -- tests/scale/replica-bootstrap.scale.test.ts
#   5 passed, 39.66 s (three golden-replica builds, cold)
```

`bun run check:push` was not run: host contention makes it unreliable in this
container, and the slice contract substitutes `bun run lint:product`.

### Audit

Verdict: REFUTED

Fresh-context verifier, worktree `claude/927-w1c-golden-vault` at `2c6e7270`
(base `cf616a09`). The slice's substance holds — the golden vault, the replica
builder and the two rigs all check out under adversarial reading — but two
governance gates that were green at the base are red on this branch, and both
were introduced here. `bash .governance/run.sh` was never run.

Findings:

1. `packages/test-kit/src/year3-vault.ts` (917 lines) →
   `.governance/run.sh` § `repo-hygiene` fails: `917 lines (limit: 625)`. The
   file is 423 lines at the base `cf616a09`, so this is a god-file violation
   this slice introduces, not a base-state red. (The other hygiene violation,
   `packages/blueprints/apps/locker/queries.test.ts` at 638 lines, is
   pre-existing at the base and untouched here.) Fix: split the distribution
   half — `seedYear3Distributions`, `longNoteBody`, `NOTE_WORDS`,
   `Year3SeedContext` — into a sibling module (e.g.
   `packages/test-kit/src/year3-distributions.ts`) that `year3-vault.ts`
   imports; no API or behaviour change is needed.
2. `receipts/issue-927-perf-infra.md:31` → `.governance/run.sh` §
   `receipt-per-issue` fails: "newly added receipt's `## Verification` has no
   fenced code block". The top-level `## Verification` delegates in prose to
   the appended section; the fence the directive wants must be under the
   top-level heading. Fix: put a fenced command block under `## Verification`
   (the w1c list is already fenced and can be repeated or pointed at).
3. `receipts/issue-927-perf-infra.md` § "What was deleted", second bullet →
   overstates. "the env-var-or-temp-dir dance is now `year3FixtureCacheRoot()`,
   one function" is true only of the rigs this slice touched:
   `tests/scale/photos-timeline.scale.test.ts:73` and
   `tests/scale/restore-10gib.scale.test.ts:124` still inline
   `process.env.CENTRAID_YEAR3_CACHE_DIR ?? …` verbatim. Fix: qualify the
   bullet ("in the rigs this slice mounts; two rigs w3 owns still repeat it")
   or add the two call sites to the slice.
4. `tests/experience-budgets/README.md`, "Replica rows on a phone" row → the
   golden-artifact column names `replicaRows` with no disclosure that the
   50,000 vault rows behind it are one shape (`schedule.task`), a declared
   filler rather than a realistic year-3 mix. The kit source
   (`year3-vault.ts`, `Year3Distributions.replicaRows`) and this receipt's
   Decision 3 both say so; the README, which is where a rig author reads the
   dimension, does not. Fix: add the qualifier to that row.

Non-findings, recorded because they were attacked and held:

- **Determinism.** Built the fixture twice at the default seed into two fresh
  cache roots (`/tmp/centraid-year3-fixture-cache` and, via
  `CENTRAID_YEAR3_CACHE_DIR=/tmp/y3-b`, a second). Row counts are identical
  across all 34 non-empty tables. Seeded content is byte-identical for
  `access_receipt`, `core_event`, `items`, `turns`,
  `share_party_vault_binding`, `social_circle_member`, `automation_state`,
  `automation_trigger_cursor`, `core_entity_kind`, `sync_connection`,
  `tally_group`. The tables that differ do so only through the bootstrap's
  `uuidv7` owner/vault/device ids and schema-DEFAULT wall-clock
  `created_at`/`updated_at` — vault behaviour (#935), not kit
  nondeterminism. `year3-vault.test.ts`'s "two builds at one seed are
  row-identical" claims exactly that scope and no more. Note the artifact is
  therefore NOT byte-reproducible: `vault.db` measured 106,258,432 and
  106,299,392 bytes across my two builds against the 106,217,472 in § Numbers,
  so that row is a sample, not a constant.
- **Declared distributions hold** in the built artifact: 30 of 1,000 note
  bodies over 64 KiB (3.0% = `longNoteShare`), `access_receipt` 365 rows
  spanning 2025-01-01 → 2025-12-31, 12 live `share_party_vault_binding` + 14
  `share_authority` + 1 `social_circle`, 1,096 `core_event`, 50,000
  `schedule_task`, 200 `automation_state`, five vault directories (main +
  four companions), N ∈ {1, 10, 40}. Every row in § Numbers reproduced.
- **Seeded through the product's own shapes.** Read every INSERT in
  `seedYear3Distributions`; each names the writer it mirrors, the
  `access_receipt` block is INSERT-only against the append-only trigger, and
  `share_authority`'s circle-principal `edit` over `tally.group` is the one
  the subject registry offers. `bun run lint:vault-sql` is green — but note
  `packages/test-kit/` is allowed by ROLE (`scripts/lint-vault-sql.mjs:81`),
  so that gate polices nothing here; the honesty of the mirrors rests on
  `year3-vault.test.ts` running them against a real bootstrapped schema,
  which it does.
- **The replica equals a real bootstrap.** `year3-replica.test.ts` asserts
  per-entity row counts against `readReplicaRows`'s own paged read, the
  column list against the reader's answer, and the >64 KiB bodies as
  `oversizedFields` absent from `values`. The scale rig reopens the on-disk
  artifact and counts `replica_row` = 50,000 and `replica_intent_outbox`
  queued = N independently of the builder's own tally.
- **`large-vault.scale.test.ts`'s assertions are byte-for-byte unchanged**
  against the base (all six `expect` lines), as are the four read queries
  they stand on; only the needle literals moved to the fixture's exported
  constants.
- **Workflows untouched** (`git diff --name-only … -- .github/` is empty);
  `.github/workflows/e2e.yml`'s four `artifacts/year3-cache` literals are
  intact and `CENTRAID_YEAR3_CACHE_DIR` is honoured — I built a whole fixture
  through it.
- **Binary tripwire clean**: no `-\t-` rows in `git diff --numstat`, no NUL
  byte in any changed file. (`tests/quality/user-facing-qualities.test.ts`
  holds one deliberate `^@` key delimiter; it is pre-existing at the base and
  not in this diff.)
- Checklist mirrors #927's nine acceptance criteria verbatim; no box is
  checked, which is correct for a wave-1 slice. No budget, ceiling,
  allowlist or ratchet number moved; no test skipped or deleted.

Gates run:

```sh
bun run format                                     # clean, tree unchanged
bun run lint                                       # pass
bun run lint:vault-sql                             # pass (test-kit allowed by role)
bun run --cwd packages/test-kit test               # 5 files, 76 tests passed
bun run --cwd packages/test-kit typecheck          # pass
bun run --cwd packages/vault typecheck             # pass
bun run typecheck                                  # 25/25 tasks + tsc -p tests, pass
bun run test:scale -- tests/scale/large-vault.scale.test.ts       # cold 24.1 s / warm 5.0 s wall, 1 passed
bun run test:scale -- tests/scale/replica-bootstrap.scale.test.ts # cold 38.9 s / warm 18.4 s wall, 5 passed
bash .governance/run.sh                            # FAIL — findings 1 and 2
```

Host: this session's container, Linux, node 22, `/tmp` scratch. Volume:
`goldenYear3Profile()`.

#### Fix after audit

Rebased onto `origin/main` (`6c242d62`, carrying #930, #922's rulings and
#927 w1-core) and re-landed as one appended section on main's receipt; the
scaffolding this slice originally created is gone, and nothing above this
section is rewritten.

1. **Finding 1 — `repo-hygiene`, `year3-vault.ts` at 917 lines (limit 625).**
   Split three ways, because a two-way split left an import cycle
   (`import/no-cycle`): `year3-shape.ts` (167 lines) holds the vocabulary —
   the distribution and profile types, `YEAR3_DISTRIBUTIONS`, the SQLite
   seams, the needles; `year3-distributions.ts` (344 lines) holds
   `seedYear3Distributions`, `longNoteBody`, `NOTE_WORDS` and
   `Year3SeedContext`; `year3-vault.ts` (461 lines) keeps the artifact's
   identity — version, profile, content-addressed cache — and calls the
   seeder at the one seam it always had. `year3-vault.ts` re-exports
   `year3-shape.ts` in full, so `./year3-vault` stays the one public subpath
   and not a single import elsewhere in the tree changed. No exported API and
   no behaviour changed; all three files are under the limit.
2. **Finding 2 — `receipt-per-issue`, no fenced block under `## Verification`.**
   Moot as filed and fixed as meant: this slice no longer creates the receipt,
   so main's `## Verification` stands untouched, and the fenced command block
   below carries this section's own replayable evidence.
3. **Finding 3 — the cache-root claim was false.**
   `tests/scale/photos-timeline.scale.test.ts` and
   `tests/scale/restore-10gib.scale.test.ts` now call
   `year3FixtureCacheRoot()` instead of inlining
   `process.env.CENTRAID_YEAR3_CACHE_DIR ?? (await tempDir(…))`. Mounting-only:
   their profiles, seeds and assertions are byte-for-byte unchanged. The
   "What was deleted" bullet above is rewritten to say what is now true.
4. **Finding 4 — the README hid that `replicaRows` is one shape.** The
   "Replica rows on a phone" row now says in the golden-artifact column that
   the 50,000 rows are a single `schedule.task` shape — a declared filler
   rather than a realistic year-3 mix, revisited by #927 w3.
5. **The `vault.db` byte figure** is restated as a sample with the verifier's
   two measurements and the #935 cause beside it, in § Numbers above.
6. **`bash .governance/run.sh` was never run before the first report.** It is
   now part of the gate list below and was run to green before this commit.

Verification of the fix, on the same host:

```sh
bun run format                                       # clean
bun run lint                                         # pass
bun run lint:vault-sql                               # pass
bun run --cwd packages/test-kit test                 # 5 files, 76 tests passed
bun run --cwd packages/test-kit typecheck            # pass
bun run typecheck                                    # turbo 25/25 + tsc -p tests, pass
bun run test:scale -- tests/scale/large-vault.scale.test.ts        # 1 passed, cold cache, 23.5 s
bun run test:scale -- tests/scale/replica-bootstrap.scale.test.ts  # 5 passed, 39.2 s
bun run test:scale -- tests/scale/photos-timeline.scale.test.ts    # FAILS — base-state red, see below
bun run lint:product                                 # 39/39 gates passed
bash .governance/run.sh                              # 22/22 directives passed
```

Two of those need their outcome stated rather than a tick:

- **`photos-timeline.scale.test.ts` fails, and fails identically on the clean
  base.** `Error: table media_asset has no column named favorite` at its own
  `INSERT INTO media_asset` — #916 removed that column and this rig was not
  updated with it. Confirmed by `git stash -u`, re-run, same error one line
  up (the only difference being the comment this slice adds). Out of this
  slice's contract to fix: it is an assertion/corpus change to a rig #927 w3
  owns, not a cache-root change. Filed as a finding below.
- **`large-vault` has thin headroom on a COLD cache.** 23.5 s of test body
  against its unchanged `SEED_BUDGET_MS = 30_000`, and 34.2 s when the host
  was also running `bun run typecheck` — i.e. it fails under contention on a
  cold fixture. The budget was NOT widened and the fixture build was NOT moved
  out of the timed window; both would be weakening a gate to go green. In CI
  the cold path is paid only on a cache miss, because `e2e.yml` caches
  `artifacts/year3-cache` and passes it as `CENTRAID_YEAR3_CACHE_DIR`. Filed
  as a finding for the root: either the nightly lane warms the fixture before
  the timed rigs, or the ledger (#927 w2) separates "build the artifact" from
  "mount the artifact" as two entries.

`tests/scale/restore-10gib.scale.test.ts` was **not** run: it is a ~90-minute
nightly rig that materializes a 10 GiB blob store, and this container cannot
host it. Its change is one expression — `cacheRoot` now comes from
`year3FixtureCacheRoot()` rather than from
`process.env.CENTRAID_YEAR3_CACHE_DIR ?? (await tempDir(…))`, which is the same
value by construction — and it is covered by the root `typecheck`
(`tsc -p tests`) plus a line-by-line read of the mount block. Saying so
explicitly rather than claiming a run that did not happen.

### Audit (re-verification, 2026-09-03)

Verdict: PASS

Second fresh-context verifier, worktree `claude/927-w1c-golden-vault` at
`a81f739a` (one commit on `6c242d62`; `origin/main` has since moved to
`7d47fee4`, so everything below is `git diff origin/main...HEAD` three-dot).
All four findings of the audit above are fixed, and the fixes were checked
against the artifact rather than against the prose.

Findings: none.

The four fixes, verified:

1. **The god file is gone.** `year3-shape.ts` 167 / `year3-distributions.ts`
   344 / `year3-vault.ts` 461 lines, all under the 625 limit;
   `bash .governance/run.sh` is 22/22 with `repo-hygiene` green. The "no
   importer changed" claim holds: `grep -rn "year3-shape\|year3-distributions"`
   outside `packages/test-kit/src` returns only this receipt, and every
   consumer in the tree still imports `@centraid/test-kit/year3-vault`
   (`import-routes.test.ts`, `gateway-request-volume.perf.test.ts`,
   `factories.ts`, four scale rigs). No import-only edit appears anywhere in
   the diff.
2. **The Verification section is fenced.** Two `sh` blocks, the first labelled
   superseded, plus the fix block. The receipt diff is `+440 / −0` — a pure
   append — and `doc-integrity` is green, so nothing above w1c is rewritten.
3. **The cache-root claim is now true.** `grep -rn "CENTRAID_YEAR3_CACHE_DIR"`
   over the tree: one read, in `year3FixtureCacheRoot()`. `artifacts/year3-cache`
   survives only in `.github/workflows/e2e.yml` (four lines, w2's) and in one
   prose comment in `year3-vault.ts`.
4. **The README discloses the filler.** The "Replica rows on a phone" row names
   `replicaRows` as a single `schedule.task` shape and routes the realistic mix
   to w3.
5. **The `vault.db` figure is restated as a sample** and reproduces as one: my
   cold build measured a FOURTH value, 106,307,584 B, outside the three the
   section lists. "About 101 MiB" is the only honest form, as written.

Falsification 1 — **build the golden vault cold and check the shape claims
against the database**. `CENTRAID_YEAR3_CACHE_DIR=/tmp/y3-verify2`, cache
purged, `large-vault` run, then `node:sqlite` read-only over the cached
`vault.db`. Every row in § Numbers reproduced exactly: `core_party` 5,001,
`media_asset` 10,000, `core_content_item` 11,000, `knowledge_note` 1,000,
note bodies > 64 KiB **30** (3.0 % of 1,000 = the declared `longNoteShare`),
`core_event` 1,096 spanning 2023-01-01 → 2025-12-31 with exactly **365** in the
2025 window, `schedule_task` 50,000, `access_receipt` **365** over 365 distinct
days 2025-01-01 → 2025-12-31 with `seq` 1…365 unbroken,
`share_party_vault_binding` 12 (all `revoked_at IS NULL`), `share_authority` 14
= 12 `person`/`view` + 1 `circle`/`edit` + 1 `device`/`edit`, `social_circle` 1,
`tally_group` 1, `social_circle_member` 12, `automation_state` 200,
`automation_trigger_cursor` 200, `core_tag` 200, `replica_change` 78,376. Both
needles reach exactly one row through the product's own FTS indexes. The three
replica artifacts hold 50,000 `replica_row` each with outboxes of 1 / 10 / 40
queued, at 33,304,576 / 33,312,768 / 33,325,056 B — the three byte counts § Numbers
lists, to the byte. The `keys/` directory finding 6 predicts is there in the
cache root.

Falsification 2 — **the split changed no importer** (above, item 1): the two
greps come back empty outside the kit's own `src/`, and the diff touches no
import line outside `year3-vault.ts`, `year3-replica.ts` and the two rigs whose
cache-root conversion is the described change.

Two things the root asked to be confirmed rather than taken:

- **`photos-timeline.scale.test.ts` is red AT THE BASE, and this slice neither
  caused nor masked it.** `packages/vault/src/schema/domains-social-knowledge-media.ts:168`
  removed `media_asset.favorite` (#916, ONT-03) and
  `migrate.test.ts:207` asserts its absence; the rig's own
  `INSERT INTO media_asset (…, favorite)` is byte-identical at `origin/main`
  (line 111) and at HEAD (line 112, shifted only by the comment this slice
  adds). Reproduced: `bun run test:scale -- tests/scale/photos-timeline.scale.test.ts`
  → `Error: table media_asset has no column named favorite`, 1 failed, 16 s.
  A #916-fallout / #927 w3 finding, not this slice's.
- **`large-vault`'s ceiling was not widened and the fixture build is inside the
  timed window.** `SEED_BUDGET_MS = 30_000` and `READ_BUDGET_MS = 2_000` are
  unchanged context lines in the diff; `started` is taken before
  `await goldenYear3Vault()` and `seedMs` after it, so the materialize cost is
  what the budget scores. Measured here: cold 24 s wall / 19.75 s test body,
  warm 6 s wall / 429 ms body. The headroom is real but thin, as the section
  says; how w2 handles it is the root's call.

Also checked and holding: the appended section names every one of the 13
non-receipt files in the diff and nothing outside the slice contract is touched
(no `.github/`, no product code, no `tests/floors.json`, `tests/claims.json`,
`tests/budgets.json` or `classification-ratchet.json`); the six `expect` lines
and four read queries of `large-vault` are byte-identical to the base; the
`replica-bootstrap` additions are purely additive `test.each` cases; every
`deliberate`/`by design` seam in the section names a concrete property (the
opt-in distributions protect what `photos-timeline` and `restore-10gib`
measure; the kit↔vault non-dependency is the cycle; the two re-judged rulings
each state what depends on them now); the three `oxlint-disable-next-line
no-await-in-loop` suppressions each carry a reason and
`no-unjustified-suppressions` is green; no budget, floor, allowlist or ratchet
number moved and no test is skipped, quarantined or deleted; binary tripwire
clean (no `-\t-` row in `--numstat`, no NUL byte in any changed file).

Gates run (all under the shared lock, on this session's container, Linux,
node 22, `/tmp` scratch):

```sh
bun run format:check                                # clean, 5360 files
bun run lint                                        # pass
bun run lint:vault-sql                              # ok — 490 refs / 4249 files / 42 allow-listed
bun run --cwd packages/test-kit test                # 5 files, 76 tests passed, 24.4 s
bun run --cwd packages/test-kit typecheck           # pass
bun run typecheck                                   # root, 25/25 tasks + tsc -p tests, pass
bun run lint:product                                # 36/39 — see base-lag note
bash .governance/run.sh                             # 22/22 directives passed
bun run test:scale -- tests/scale/large-vault.scale.test.ts       # 1 passed; cold 24 s wall, warm 6 s wall
bun run test:scale -- tests/scale/replica-bootstrap.scale.test.ts # 5 passed, 43 s wall
bun run test:scale -- tests/scale/photos-timeline.scale.test.ts   # 1 failed — base-state red (above)
```

`lint:product`'s three reds are BASE LAG, not this slice: `lint:ledgers`
(`tests/floors.json` flow `blueprint-app-entity-tripwire-law` "removed"),
`lint:quality-knobs` (`tests/quality/classification-ratchet.json`) and
`test:ratchet` all compare against `origin/main`, which moved to `7d47fee4`
with #928 after this branch's base. `git diff origin/main...HEAD` touches none
of those three files.

`restore-10gib.scale.test.ts` was not run — a ~90-minute rig. Its change is one
expression and was judged by reading: `cacheRoot` is `year3FixtureCacheRoot()`,
the profile passed to `materializeYear3Fixture` is the unchanged `YEAR3`, and
the materialized directory is copied to a private `sourceDir` before any blob
is written, so the shared persistent cache root holds only the vault, never the
10 GiB store.

## w1-gateway — the gateway emits spans, and the statement layer counts work

**Files**

| Path | What |
| --- | --- |
| `packages/vault/src/gateway/work-counters.ts` (new) | Process-total `WorkCounters` and the SQLite statement-layer instrumentation: statements, rows scanned, payload bytes read/written, durability barriers as `fsyncs`. |
| `packages/vault/src/gateway/work-counters.test.ts` (new) | 9 tests, incl. the seeded-extra-statement case. |
| `packages/vault/src/gateway/gateway.ts` | `createGateway` attaches the instrumentation to the one vault handle. Nothing inside the read-cap or read-plan functions (#922's tree) is touched. |
| `packages/vault/src/index.ts` | Exports `bumpWorkCounter`, `gatewayWorkCounters`, `instrumentVaultStatements`. |
| `packages/server/src/engine/handlers/work-counters.ts` (new) | The engine's `workerSpawns` registry — a second registry because the engine must not import `@centraid/vault` (#404 keeps its module load thread-free); the consumer sums with `addCounters`. |
| `packages/server/src/engine/handlers/worker-pool.ts` | One bump in `spawn()`, the only place `new Worker` happens. |
| `packages/server/src/serve/gateway-trace.ts` (new) | `GatewayTracer` + `beginGatewayTrace` (span emitter, sampling, counter snapshot+diff), `traceRequests` (the per-request seam), `TRACE_ID_HEADER`, `processWorkCounters`. |
| `packages/server/src/serve/trace-store.ts` (new) | `TraceStore` (JSONL under `<vaultDir>/diagnostics/`, one rotation, torn-line-tolerant reader) and `lazyVaultTraceSink`. |
| `packages/server/src/serve/gateway-trace.test.ts` (new) | 16 tests: default-off, sampling determinism, purge-with-vault, torn-line recovery, header refusal, once-only close. |
| `packages/server/src/serve/serve.ts` | Wraps `composedHandler` in `traceRequests`; store bound lazily to the current vault dir. |
| `packages/server/src/index.ts` | Public exports for the tracer, store and engine counters. |
| `docs/logs.md` | § "Traces and work counters (#927)" extended: store location + purge property, `CENTRAID_TRACE` switch, the counter→seam table, and the "this is the only per-request gateway timing seam" ruling. |

**Numbers** — host: this container, Linux 6.18 x64, 4 cores / 15 GB, Node 22. Volume: the golden year-3 vault (`goldenYear3Vault()`), one file, two SQLite handles on it, 8 alternating rounds (order flipped each round so WAL growth is not charged to one side), medians reported. Read = `SELECT party_id, display_name, kind FROM core_party ORDER BY party_id LIMIT 20`, fresh `prepare` each time (2000/round). Write = one `core_place` insert in its own `BEGIN IMMEDIATE`/`COMMIT` (200/round).

| Measurement | Before | After | Δ |
| --- | --- | --- | --- |
| Counters OFF → ON, per read | 0.04417 ms | 0.04961 ms | +0.0054 ms (+12.3%) |
| Counters OFF → ON, per write | 1.9131 ms | 1.9839 ms | +0.071 ms (+3.7%) |
| Spans OFF → ON (`sampleEvery: 1`, record written), per read | 0.06186 ms | 0.13002 ms | +0.068 ms (+110%) |
| Spans OFF → ON (`sampleEvery: 1`, record written), per write | 4.2310 ms | 4.2487 ms | +0.018 ms (+0.4%) |

The span row is exactly why the invariant makes spans off by default: a read is cheap enough that writing a record doubles it. The counter row is the always-on cost and is single-digit percent on the write path; the read figure is the instrumentation's worst case (a 60-cell payload walk on a statement that does almost no work). A first pass built the counted statement out of one closure per method and cost **+47%** per read; moving the forwarder to a prototype-based class and screening the barrier regex on one character brought it to +12.3%.

**Deleted / replaced** — nothing yet. `route-latency.ts` stays: it answers a different question (aggregate per-route histograms for health) and the receipt names that property rather than citing a ruling. #922's F1 per-request gateway phase timing is ABSORBED by `traceRequests` per the root ruling — no second timing seam was built.

**Decisions**

- `fsyncs` counts **durability barriers** (`COMMIT`/`END`, WAL checkpoints), not `fsync(2)` calls. Counting the syscall needs `strace` and a Linux runner, which is the platform-shaped instrument P1 exists to replace; the barrier is the product's own behaviour and is the same integer on every host. The existing wall-clock rig's strace count stays available on its own rung.
- `bytesRead`/`bytesWritten` are **payload bytes** — what a statement materialized out of SQLite and what it bound into it — not disk I/O. Disk bytes are not observable from `node:sqlite` and are not deterministic per action; payload bytes are, and they catch the regression the gate is for ("this read now selects the whole row"), which the test asserts directly.
- Two counter registries (vault + engine) rather than one: the engine importing `@centraid/vault` would undo #404's "import must not spawn threads". `addCounters` is the contract's own answer and `processWorkCounters()` is the single consumer-side sum.
- `TRACE_ID_HEADER` is read **only while tracing is enabled**, and only as an opaque `[A-Za-z0-9._:-]{1,128}` token. Off by default means shipped builds have no ingestion surface at all; the id joins two span trees on one machine and is never echoed or forwarded.
- `diffCounters` throws on a backwards counter, so it is not called on the product path in the emitter sense: the one call sits behind the sampling guard, over a totals object that is allocated once per process and never replaced, inside a `try` that drops the record rather than failing a request.

**Verification**

```
bun run --cwd packages/vault typecheck                                   # tsc clean
bun run --cwd packages/server typecheck                                  # tsc clean
bun run --cwd packages/vault test -- src/gateway/work-counters.test.ts   # 9 passed
bun run --cwd packages/server test -- src/serve/gateway-trace.test.ts    # 16 passed
node node_modules/vitest/vitest.mjs run --config vitest.perf.config.ts   # ad-hoc A/B rig (not committed) — the four numbers above
```

## w1-seats — the seats emit spans, and count the reads an action costs

**Files**

| Path | What |
| --- | --- |
| `packages/client/src/replica/work-counters.ts` (new) | The seat's `WorkCounters` registry — a third one, because this code runs in a browser, a worker and on Hermes where `@centraid/vault` and `node:*` do not exist. |
| `packages/client/src/replica/trace.ts` (new) | `ClientTracer`: the seat span emitter, sampling off by default, `TraceIdFactory` injectable for Hermes. |
| `packages/client/src/replica/trace-ring.ts` (new) | `ClientTraceRing` — the bounded in-memory buffer a flush drains; platform-free and separately testable. |
| `packages/client/src/replica/trace.test.ts` (new) | 11 tests across the tracer, the ring, the two live-query counters and the transport counter. |
| `packages/client/src/replica/live-query-registry.ts` | `invalidations` bumped once per invalidation FIRED, before fan-out. |
| `packages/client/src/replica/live-query.ts` | `reReads` bumped where a read actually happens — after the dirty check and `matches()`. **This is #922's D4 reads-per-action counter; no second counter was added.** |
| `packages/client/src/replica/shell-transport.ts` | `countedRoundTrip` wraps the one transport seam, so all six request paths — and any injected fetcher — count identically. |
| `packages/client/src/replica/index.ts` and `packages/client/src/replica/native.ts` | Export `trace.js` and `work-counters.js` on both barrels; the native barrel's DOM-free rule holds (neither module imports a DOM global or `node:`). |
| `apps/mobile/src/lib/replica/native-trace.ts` (new) | The phone's tracer over `nativeReplicaIdFactory`, the `EXPO_PUBLIC_CENTRAID_TRACE` policy, and `flushNativeTraces` writing `<replicaStorage>/diagnostics/traces.jsonl`. `expo-file-system` is imported **lazily inside the flush**: a static import would pull Expo's native module graph into every unit test that reaches `background-sync.ts` (it did — `background-sync.test.ts` went red on `__DEV__ is not defined` until the import moved). |
| `apps/mobile/src/lib/replica/native-trace.test.ts` (new) | 7 tests: default-off, drain-once, native minting, swallowed write failure. |
| `apps/mobile/src/lib/replica/background-sync.ts` | One `flushNativeTraces()` in `runBackgroundReplicaSync`'s `finally`. |
| `docs/logs.md`, `docs/mobile-offline.md` | The seats' counter→seam row, and the ring-buffer/flush rule in § "Background work and push privacy". |

**Numbers** — host: this container, Linux 6.18 x64, 4 cores / 15 GB, Node 22. Volume: the golden year-3 vault via the w1-gateway A/B rig; the seat counters add no SQLite work, so the hot-path cost they carry is the same three integer bumps measured there. Spans on the seat cost what they cost on the gateway (a record built and pushed into an array, no I/O until a flush): the w1-gateway spans row, minus the file write.

| Measurement | Before | After | Δ |
| --- | --- | --- | --- |
| `invalidations` + `reReads` per fired invalidation (2 fired, coalesced) | — | 2 invalidations / 1–2 re-reads | asserted in `trace.test.ts`, not timed — three integer increments |
| `httpRoundTrips` per transport call | — | exactly 1, injected fetcher or default | asserted in `trace.test.ts` |
| A non-matching invalidation | — | 1 invalidation, **0** re-reads | the fan-out regression the pair is for |

**Deleted / replaced** — nothing. #922's D4 reads-per-action counter is REALIZED by `reReads` rather than built separately; a second counter would have been the duplication the ruling forbids.

**Decisions**

- The mobile flush lives in `runBackgroundReplicaSync`'s `finally`, not on a success path: a pass that timed out or threw still recorded spans worth reading, and those are the passes a developer is looking at. `flushNativeTraces` swallows its own failures for the same reason the gateway store does.
- `httpRoundTrips` is counted by wrapping the fetcher rather than by six call-site bumps. A new request path in `shell-transport.ts` is then counted the day it is written, and the web shell's Iroh/webControl wrapper and the native fetcher are counted like the default instead of being invisible.
- Three counter registries, not one: gateway (node), engine (node, no vault import), seat (browser/worker/Hermes). `addCounters` is the contract's own answer, and a shared mutable singleton across those runtimes does not exist to be shared.
- `reReads` counts EXECUTIONS, not invalidations that matched: `LiveQuery` coalesces a burst into one run, and the honest number for "reads per action" is the number of times the runner ran.

**Verification**

```
bun run --cwd packages/client typecheck                                   # tsc clean
bun run --cwd apps/mobile typecheck                                       # tsc clean
bun run --cwd packages/client test -- src/replica/trace.test.ts           # 11 passed
bun run --cwd apps/mobile test -- src/lib/replica/native-trace.test.ts    # 7 passed
bun run --cwd packages/client test                                        # 267 files, 2447 passed (engine lane)
bun run --cwd apps/mobile test -- src/lib/replica/                        # 30 files, 214 passed (engine lane)
```

## w1-gate — the merge rung stops timing and starts counting

**Files**

| Path | What |
| --- | --- |
| `.github/workflows/ci.yml` | The per-PR perf gate is now `bun run test:perf:counters`. The `apt-get install strace` step and the **retry-once wrapper are DELETED**. |
| `scripts/ci/work-counter-gate.mjs` (new) | The comparison: `compareScenario` / `compareAll` / `renderRows` / `explainFailures` / `verdict`, plus a CLI over a captured measurements file. Two modes — `max` (a budget) and `exact` (a value where both directions are a regression). |
| `scripts/ci/work-counters.expected.json` (new) | The committed, tighten-only expectations. |
| `scripts/ci/work-counter-gate.test.mjs` (new) | 10 `node --test` cases, incl. drift in both directions between the rig and the file. |
| `tests/perf/work-counters.perf.test.ts` (new) | The rig: golden year-3 vault, real `Gateway.read` and `Gateway.invoke`, counters diffed and compared. Second test asserts two identical runs cost identically — the property that makes the retry unnecessary. |
| `packages/server/src/cli/trace-admin.ts` (new) | `centraid-gateway trace last [--data-dir] [--vault-dir] [--json] [--clear]` — the waterfall, rendered through the contract's own `waterfall()`. |
| `packages/server/src/cli/trace-admin.test.ts` (new) | 9 tests: rendering, vault ordering by recency, `--json`, `--clear`, and the "spans are off, here is how to turn them on" refusal. |
| `packages/server/src/cli/cli.ts` | `trace` subcommand + usage line. |
| `packages/vault/src/gateway/work-counters.ts` | `fsyncs` also counts an AUTOCOMMIT write (a mutating statement outside a transaction opens and commits its own, so SQLite syncs with no `COMMIT` to see). Found by this rig: without it the gate read 0 barriers for a write. |
| `packages/vault/src/gateway/work-counters.test.ts` | +2 tests: autocommit is a barrier, a no-op statement is not, and two writes in one transaction are ONE barrier. |
| `package.json` | `test:perf:counters`; `work-counter-gate.test.mjs` added to `scripts:test`. |
| `docs/logs.md` | `trace last`'s flags, and the merge-rung paragraph. |

**Numbers** — host: this container, Linux 6.18 x64, 4 cores / 15 GB, Node 22. Volume: the golden year-3 vault. Command: `bun run test:perf:counters`. These are the committed expectations, measured, not estimated:

| Scenario | statements | rowsScanned | fsyncs | bytesRead | bytesWritten |
| --- | --- | --- | --- | --- | --- |
| `gateway.read core.party limit=20` | 6 | 24 | **1** | 2100 | 198 |
| `gateway.invoke atlas.insert_row core.place` | 25 | 31 | **5** | 1448 | 948 |

**Seeded-regression proof.** Both seeds were applied to `Gateway.read`, the gate run once, and the seed reverted.

| Seed | First-run verdict |
| --- | --- |
| One extra statement (`SELECT 1`) | `statements max 6 → 7 FAIL` — *"statements must be at most 6, measured 7 (+1). Something on this path now does more work. Find it — do not raise the number."* |
| One extra durability barrier (an autocommit `INSERT`) | `fsyncs exact 1 → 2 FAIL` — *"fsyncs is 1, measured 2 (+1)."* |

Both failed on the **first** run, with no retry and no history, and both named the counter and the direction.

**Deleted / replaced**

- The **retry-once step** (#532, annotated by #557) is gone. Re-judged on its merits: it existed only because the wall-clock rig it wrapped read shared-runner event-loop noise as a regression. Deterministic integers have no noise to absorb, and a retry over them would hide a real regression half the time. There is no product or security property that depends on it — it is deleted, not moved.
- The `apt-get install strace` step is gone with it. `strace` gave an exact `fsync(2)` count at the cost of a Linux runner and an external tracer; a durability barrier is the product's own behaviour and is the same integer on every host.
- The wall-clock rig itself (`test:perf:pr` → `packages/server/scripts/bench-low-end.mjs`) is **NOT** deleted: it answers a different question — latency, RSS and idle cost under a constrained hardware profile — and no counter replaces that. Per the lane's escape hatch, **the counters gate replaces it on the merge rung and the wall-clock rig moves to rung 3 (`candidate.yml`) in wave 2**; `candidate.yml` is outside this lane's contract so it was not edited. `check:full` still runs it locally, so it is not orphaned in the meantime.

**Decisions**

- `fsyncs` uses `mode: "exact"`, the other counters `mode: "max"`. A durability barrier that disappears is a durability bug, not a speed-up, so both directions must fail; the rest are budgets and must not fail an improvement.
- The rig warms each path before measuring. The first call through any path compiles statements and fills SQLite's page cache; fencing that would fence the fixture's coldness, which no product change moves.
- The comparison lives in `scripts/ci/` and the measurement in `tests/perf/`, so the comparison is unit-tested without booting a vault and a developer's `--explain` and CI's failure use one renderer.
- A scenario in the file but not in the run, or measured but not expected, is an **error**. A gate that silently stops fencing a path is worse than no gate.

**Findings** (not this lane's to fix; filed for the root)

1. **One `atlas.insert_row` costs five durability barriers.** Five separate autocommit writes for one user write, where a transaction would make it one. Recorded in the expectations as measured, with the comment saying so — not approved.
2. **Every gateway READ performs a durable write** (the audit receipt), so a read costs an fsync. The property that depends on it is real — an access receipt that is not durable before the caller sees the rows is not evidence — but it means "read" is not a read-only cost, and any read-heavy budget written as if it were is wrong.
3. **`tests/quality/first-paint-query-counts.test.ts` has its own statement counter** (`countReadStatements`) and its own query-count budget file. That is the "query-count file" #927's ledger criterion says the ledger replaces; it should read these counters instead of counting statements a second way.

**Verification**

```
bun run test:perf:counters                                              # 2 passed; the table above, all rows ok
node --test scripts/ci/work-counter-gate.test.mjs                       # 10 pass, 0 fail
bun run --cwd packages/server test -- src/cli/trace-admin.test.ts       # 9 passed
bun run --cwd packages/vault test -- src/gateway/work-counters.test.ts  # 11 passed
bun run lint:workflow-pins                                              # 23 workflows clean
bun run lint:path-filters                                               # 10 filters cover every path
bun run scripts:test                                                    # 599 pass, 0 fail
bash .governance/run.sh                                                 # 22/22 directives passed
bun run --cwd packages/vault test                                       # 202 files, 1588 passed (engine lane)
bun run --cwd packages/server test                                      # 391/395 files; 3 reds are BASE STATE, see below
bun run format:check && bun run lint && bun run typecheck               # clean
```

Lane tree hash after the final gates: quoted in the lane report to the root. A tree hash cannot be written inside the tree it names — recording it here would change it — so the report is the authority and `git rev-parse HEAD^{tree}` on the landed head is the check. Base: `origin/claude/927-w1b@f782cfb6d`.

The three `packages/server` reds are BASE STATE, not this lane: `gateway-db-lock.integration.test.ts` shells out to the `sqlite3` CLI, which is not installed in this container, and `acp/backends/acp/launch.test.ts` asserts `IS_SANDBOX` is unset while the container exports `IS_SANDBOX=yes`. `git diff --name-only origin/main...HEAD` touches neither tree.
## lane 3a — golden-vault follow-ups

Slices (iii) photos-timeline rig fix, (iv) fixture warm + build/mount split, (v) `artifacts/year3-cache` retired — `## w1c`'s finding 4 and its fixture-cost notes.

### Files

| Path | Change |
| --- | --- |
| `tests/scale/photos-timeline.scale.test.ts` | The degenerate corpus's `INSERT` stops naming `media_asset.favorite`, deleted by #916 (ONT-03). One statement; profile, volumes, budgets and all four assertions untouched. |
| `packages/test-kit/src/year3-fixture-cache.ts` (new) | The content-addressed cache, split out of `year3-vault.ts`: version, root, key, the WARM set, and `materializeYear3Fixture` — now a BUILD that never copies and never opens. Re-exported in full by `./year3-vault`, so no import moved. |
| `packages/test-kit/src/year3-vault.ts` | Loses the cache half (461 → 358 lines), gains the re-export. `YEAR3_FIXTURE_VERSION` 2 → 3: the golden replica carries `meta.json` now, so a version-2 directory is a different artifact. The unused `profile` default is dropped. |
| `packages/test-kit/src/year3-vault.test.ts` | Version assertion follows the bump; new test — three CONCURRENT materializations of one key run `generate` once and share one directory. |
| `tests/helpers/factories.ts` | `buildGoldenYear3Vault()` (the artifact exists in the cache; no copy) and `mountGoldenYear3Vault()` (a private writable copy) are separate; `goldenYear3Vault()` is their composition. `goldenYear3Replica()` computes its content address from the profile alone and reads `rows`/`cursor` from the artifact's `meta.json`, so a warm run neither mounts the vault nor walks a row. |
| `tests/quality/user-facing-qualities.test.ts` | The `year3-cache` temp-dir prefix follows the module that owns the cache, and the file's one raw NUL byte becomes `\u0000`. |
| `tests/scale/large-vault.scale.test.ts` | Publishes `golden vault mount` — the copy alone. The file lands in this lane's #922 gauge commit, which adds the audit-band gauges to the same `recordQualityResult` call. |

Also in this lane, under #922 and detailed in `receipts/issue-922-snappier-blueprints.md`: `tests/scale/replica-sse-fanout.scale.test.ts`, `apps/web/tests/e2e/perf-waterfall.spec.ts`, `scripts/test-report/render/adversaries.mjs`, `scripts/test-report/render.test.mjs`.

### Numbers

Host: this session's container, Linux 4 cores / 15 GB, node 22, cache root `/tmp/centraid-year3-fixture-cache`. Volume: `goldenYear3Profile()`, 106,274,816 B on disk. Command: `bun run test:scale -- tests/scale/<rig> --reporter=verbose`.

| Measurement | Before | After |
| --- | --- | --- |
| Golden replica cases, WARM (N = 1 / 10 / 40) | 1,159 / 2,700 / 2,646 ms | 9 / 6 / 6 ms |
| Golden replica cases, warm, total | 6,505 ms | 21 ms |
| `goldenYear3Replica().buildMs`, warm, N = 40 | 585.1 ms | 1.0 ms |
| Golden replica cases, COLD under version 3 | — | 8,680 / 8,675 / 8,418 ms |
| Golden vault MOUNT alone, warm | not separable | 198.4 ms |
| `large-vault` materialize + mount + open, warm | 574.9 ms | 441.3 ms |

Before, a replica cache HIT still mounted 126 MB of golden vault and walked 50,000 rows through `readReplicaRows` to rebuild a snapshot it discarded: `rows` and `cursor` were knowable only from the walk. `photos-timeline`, warm, is 2,580.9 ms, of which 2,271.2 ms is its own degenerate corpus.

### Deleted, with its replacement

- `goldenYear3Vault({ copy: false })` — the branch handing a caller the cache directory itself. No caller passed it, and opening the artifact writes a WAL and an identity key into the bytes every other rig measures against. Replaced by `buildGoldenYear3Vault()` for callers that need only its existence.
- `copyMs` → `mountMs`; `materializeYear3Fixture`'s `profile` default.
- The last three `year3-cache` literals: the cache-root comment's account of how the path used to be spelled, the kit test's `tempDir("year3-cache-")` prefix, and `tests/quality/user-facing-qualities.test.ts`'s `quality-year3-cache-`. `grep -rn "year3-cache" packages apps tests scripts` is empty. That file also carried a RAW NUL byte in a template literal (a join separator); it is `\u0000` now, the same string with no unreadable source.

### Decisions

1. **The version bump IS the invalidation.** `meta.json` changes the artifact's shape, so a version-2 directory cannot answer a version-3 question; tolerating its absence would leave a rebuild-on-missing-file shim forever. Cost: one ~25 s golden-vault rebuild per cache root.
2. **The warm set lives in the kit.** "Materialize once" is the cache's job; a memo in `tests/helpers` would leave `photos-timeline` and `restore-10gib`, which call the cache directly, out of it.
3. **`photos-timeline` keeps its own 50,000-photo profile** — finding 1.

### Verification

```sh
# in /home/user/centraid-wt/claude/927-w1c-golden-vault
bash $S/self-audit.sh 927 origin/claude/927-ledger   # tree d4697a3e1fb4f84bde8323ff42fbfd652246ad0d
bun run --cwd packages/test-kit typecheck && bun run --cwd packages/test-kit test
bun run typecheck
bun run test:scale -- tests/scale/photos-timeline.scale.test.ts    # 1 passed (red at the base)
bun run test:scale -- tests/scale/large-vault.scale.test.ts        # 1 passed
bun run test:scale -- tests/scale/replica-bootstrap.scale.test.ts  # 5 passed
bash .governance/run.sh                                # 22/22 directives passed
```

Gates ran on tree `d4697a3e1fb4f84bde8323ff42fbfd652246ad0d` (head `564ff42d5`),
and `self-audit.sh` was re-run on the landed head after this paragraph was
written, with the same result — the two trees differ only by this paragraph and
its twin in the other receipt. `self-audit.sh` is single-umbrella: it reports
each of this lane's other-umbrella commits as "subject lacks (#N)",
symmetrically in both runs. Every other check is green in both, and
`.governance/run.sh` passes 22 of 22.

### Findings

1. **Whether `photos-timeline` should mount the golden vault is open.** A: mount and re-declare it at 10,000 + 10,000 — needs `tests/budgets.json#qualityRigs` and `tests/claims.json#photos.scale-50k` to move with the volume (3b's files). B: mount and top up to 50,000 — the top-up is not cacheable, so warm seed cost goes from ~0.3 s to seconds and the rig's own 1.5x drift gate walks. Recommendation: A, in 3b's ledger pass. Not taken here.
2. **`.github/workflows/e2e.yml` still names `artifacts/year3-cache`** four times (w1c finding 1). The env var is still read, so CI is correct; the literal is the trace lane's.
3. **A build still leaves an orphan identity key** in the cache root (w1c finding 6) — now once per version bump too. Unowned.

### Doc debt

- `tests/experience-budgets/README.md` — the year-3 table names the golden artifact per row but not `meta.json` (#927 wave 2's ledger pass).
- `docs/harnesses.md` — describes the year-3 fixture as materialize-and-copy; build vs mount is a distinction a rig author now has to know.

## w2 ledger — perf history off the cache, rig ceilings beside their volume

Wave-2 integration branch `claude/927-w2`: `claude/927-w1b` (3 commits) and
`claude/927-ledger` (5) rebased onto main's maintainer parity fix `2bac48118`,
then this slice.

### Files

| File | Change |
| --- | --- |
| `.github/workflows/e2e.yml` | `quality-history-*` and `quality-history-restore-*` actions caches deleted; rig drift series restored from and published to gh-pages inside the report tree; four `artifacts/year3-cache` literals gone |
| `tests/budgets.json` | `photos-timeline` gains `budgetsMs` (4 named ceilings) beside its volume; `work-counters` registered with a declared `gate: "deterministic-counters"` |
| `tests/helpers/rig-budgets.ts` | `rigBudgetMsNamed(owner, key)` — one named ceiling for a rig that measures several intervals |
| `tests/scale/photos-timeline.scale.test.ts` | four module constants replaced by registry reads |
| `scripts/test-report/validate-nightly-wiring.mjs` | honours the ledger-declared deterministic-gate exemption, and requires the `_gateNote` that argues it |
| `packages/test-kit/src/year3-fixture-cache.ts`, `packages/vault/src/replica/snapshot.ts` | comments naming the removed `DEFAULT_REPLICA_MAX_VALUE_BYTES` corrected |

### Numbers

| Ceiling | Was | Now | Provenance |
| --- | --- | --- | --- |
| `photos-timeline` seed / page / one-day / bucket | 30000 / 2000 / 1000 / 2000 ms, module constants | same four values, ratcheted | value-preserving move; ratchet now sees them (`bun run test:ratchet:unit`, linux x64) |

### Deleted, with replacement

- `quality-history-${{ runner.os }}` and `quality-history-restore-${{ runner.os }}` actions caches → the gh-pages report tree (`test-report/nightly/quality-history/{perf,scale}`), written by the report job, read by the quality job.
- `CENTRAID_YEAR3_CACHE_DIR: artifacts/year3-cache` (×2, the last two literals) → `year3FixtureCacheRoot()`'s host scratch dir. The fixture is a rebuildable artifact, not history.
- `SEED_BUDGET_MS`/`PAGE_READ_BUDGET_MS`/`ONE_DAY_READ_BUDGET_MS`/`DAY_BUCKET_BUDGET_MS` → `tests/budgets.json#qualityRigs`.

### Decisions

- The counter gate's history exemption is declared in the **ledger entry**, not in the validator, so it is reviewed beside the volume. A rig claiming it and then timing something is the thing to look for.

### Verification

```
bun run lint:ledgers && node scripts/test-report/validate-nightly-wiring.mjs
bun run test:ratchet:unit && node --test scripts/lint-workflow-pins.test.mjs
bun run --cwd packages/test-kit test
```

### Falsification

1. *Claim: no rig ceiling was widened by the photos-timeline move.* Diffed the four registry values against the deleted constants — 30000/2000/1000/2000 both sides; `lint:ledgers` green against `origin/main`.
2. *Claim: the deterministic-gate exemption cannot be claimed silently.* Removed `_gateNote` from the entry and re-ran `validate-nightly-wiring.mjs`: it errors. Restored.

## w2 ledger — one journey ledger, keyed surface × journey × volume × hardware

### Files

| File | Change |
| --- | --- |
| `tests/journeys.json` (new) | THE ledger. 32 entries keyed `surface/journey/volume/hardware`, each naming its spans, its consumers and its `tolerancePercent`; plus `rigs` (46) and `drift`. Declares the journey, volume, hardware and status vocabularies inline, so no ceiling is stated at an unnamed volume. |
| `tests/experience-budgets/**` (deleted, 6 files) | Absorbed. `web/desktop/mobile/gateway.json` → per-surface entries; `client-query-counts.json` → `client/first-paint-work`; `README.md` → the ledger's own `volumes`/`journeys`/`hardware`/`_statusVocabulary`. |
| `tests/budgets.json` | `qualityRigs` and `experience` removed; the file keeps only the SUITE and LADDER ceilings no journey owns. |
| `tests/helpers/journeys.ts`, `scripts/lib/journey-ledger.mjs` (new) | The two readers. A missing entry, metric or numeric field throws; nothing parses the ledger by hand. |
| `scripts/lint-journey-ledger.mjs` + `.test.mjs` (new) | The ledger's own shape gate, wired into `lint:product` and `gate-classes.json` as a rung-1 contract gate. |
| 18 consumers (`tests/perf/**`, `tests/scale/**`, `tests/quality/**`, `apps/web/tests/e2e/perf-waterfall.spec.ts`, `scripts/perf/*.mjs`, `tests/agent-e2e-mobile/flows/scroll-frames.mjs`) | Read the ledger through a reader instead of a JSON file. |
| `tests/quality/first-paint-query-counts.test.ts` | Counts through `gatewayWorkCounters` (the trace contract) instead of monkey-patching `DatabaseSync.prepare`. |
| `scripts/test-report/{ratchet-floors,derive,validate-nightly-wiring}.mjs`, `scripts/check-ledgers.mjs`, `scripts/check-quality-knobs.mjs` | Point at the ledger. |
| `TESTING.md`, `docs/decisions.md` | Four ledgers → five; ruling **G-experience-reference** marked superseded (it said the opposite of the code). |

### Numbers

| Measurement | Was | Now | Provenance |
| --- | --- | --- | --- |
| first paint, statements per screen (photos-grid / notifications / atlas / assistant) | 68 / 8 / 13 / 22 (SELECT PREPARES seen by a test-local monkey-patch) | **76 / 7 / 7 / 5** (statement EXECUTIONS from the product's own counter) | `node node_modules/vitest/vitest.mjs run tests/quality/first-paint-query-counts.test.ts`, linux x64 / 4 cores / 15 GB, 2026-09-04. NOT comparable to the old numbers — different instrument, recorded on the entry. Atlas and Assistant read handles the gateway never wrapped, so the probe instruments each screen's own handle instead of reporting 0. |
| every other ceiling | — | unchanged | Carried across mechanically; falsified below. |

### Decisions

- The counts above are seeded at **observed with no headroom**: the count is deterministic on a fixed fixture, so one extra statement fails on the first run — the counter-gate discipline, not the p95 one.
- `tests/quality/classification-ratchet.json` approvedDeviation, in full: #930 re-pins the tests/claims.json whole-file fingerprint after removing the spent rename marker on the `golden-vault-archaeology` flow, superseding the #916 re-pin note rather than contradicting it — every sentence of #916's account of what that flow took over is kept, in receipts/issue-916-vault-ontology-review.md and in the flow's own `_comment`. `replacesMinimumTestsFlow` is a ONE-SHOT claim about the change set that makes a rename, checked against the merge base; once #916 landed, `schema-migration-corpus` existed at no base any more, so the marker could only ever report an unknown predecessor and `lint:ledgers` / `test:ratchet` were red on main itself. The marker and the `approvedMinimumTestsDeviation` that authorized it are removed together, because that note waives a future minimumTests drop on this flow by presence alone; the floor stays at 5, no claim row, severity, evidence selector or demonstrated-red date moves, and claimsGovernanceFingerprint is unchanged. Prior: #916. #928 w1b re-pins tests/claims.json once more, for the static app entity tripwire: it registers the new law `app-entity-tripwire` and its flow `blueprint-app-entity-tripwire-law` (owner packages/blueprints/src/app-entity-tripwire.test.ts, minimumTests 17), mirroring how `one-computation` is registered so the lane is owned. Additions to the law and flow registries only, and a NEW minimumTests floor, which is a tightening — no claim row, severity, evidence selector, demonstrated-red date or existing floor moves, and the 45 claim rows stay byte-identical, so claimsGovernanceFingerprint is unchanged. Prior: #930. #931 re-pins it once more after registering ONE new rung-3 lane, `rung1-on-main`, in `lanes` — the row `candidate.yml`'s new job needs before `lint:evidence-mapping` and `validate-nightly-wiring` will accept it. Registry addition only: no claim row, severity, evidence selector, demonstrated-red date, law, flow or `minimumTests` floor moves, and `claimsGovernanceFingerprint` (a digest of `claims.claims` alone) stays byte-identical — the whole-file digest moved only because `lanes` shares the file with `claims`. Prior: #928 w1b. #927 w2 re-pins tests/claims.json for the JOURNEY LEDGER: every `knob` and `seed` string that named tests/experience-budgets/*.json now names tests/journeys.json and the entry key inside it, because those five files were absorbed into one ledger keyed `surface / journey / volume / hardware`. A knob path rename only: no claim row is added or removed, no severity, evidence selector, demonstrated-red date, law, flow or minimumTests floor moves, and every seeded-red recipe still points at the same number under its new address. Prior: #931. #927 w3 re-pins tests/claims.json once more to register ONE new rung-3 lane, `paired-journeys` — the row candidate.yml's paired candidate/PR journey job needs before `lint:evidence-mapping` and `validate-nightly-wiring` will accept its evidence step. Registry addition only: no claim row, severity, evidence selector, demonstrated-red date, law, flow or minimumTests floor moves, and the claim rows stay byte-identical, so claimsGovernanceFingerprint moves only because `lanes` shares the file with `claims`. Prior: #927 w2.
- A third status word, `bound`, names what `mobile/scroll`'s 50% frame-drop ceiling always was: a catastrophe bound, not observed + headroom. The linter makes it argue itself.

### Verification

```
bun run lint:journey-ledger && bun run lint:ledgers && bun run lint:quality-knobs
bun run test:ratchet && node scripts/test-report/validate-nightly-wiring.mjs
node --test scripts/lint-journey-ledger.test.mjs scripts/ci/gate-classes.test.mjs
bun run typecheck   # 25/25
```

### Falsification

1. *Claim: absorbing five files into one ledger widened no ceiling.* Flattened every number from `origin/main`'s five files plus `budgets.json#qualityRigs` (61 values) and matched them as a multiset against the ledger's 97: **nothing lost**, and the 36 additions are 31 `tolerancePercent`, one `0`, and the four `photos-timeline` ceilings this lane's earlier commit moved.
2. *Claim: the linter actually refuses a ledger that rots the way the old files did.* Nine fixture cases in `scripts/lint-journey-ledger.test.mjs` — key/field disagreement, undeclared volume, no span and no consumer, missing consumer file, `unmeasured` shipping a number, a `bound` that does not argue itself, a dangling rig cross-link, a surviving retired reference. All nine fail the linter; the well-formed ledger passes.

## w2 paired runner — the verdict that replaced the drift rule

### Files

| File | Change |
| --- | --- |
| `scripts/ci/paired-journeys.mjs` + `.test.mjs` (new) | Interleaved candidate/PR journey rounds, paired differences, bootstrap CI on the median, per-journey tolerance from the ledger. Seeded PRNG, so a re-run cannot launder a red. |
| `scripts/ci/bisect-journeys.mjs` + `.test.mjs` (new) | Walks the promoted-candidate list on gh-pages for the first sustained step; a spike that reverts is a blip, not a culprit. |
| `.github/workflows/candidate.yml` | `paired-journeys` job (rung 3, `promote` needs it) and a `workflow_dispatch` `bisect-journeys` job; `promote` publishes each promotion's baseline to `test-report/candidate-journeys/<sha>.json`. `test:perf:pr` (the constrained wall-clock rig) re-homed here — no rung ran it. |
| `scripts/perf/app-waterfall.mjs` + `.run.ts` + `.test.mjs`, `vitest.waterfall.config.ts` (new) | `bun run perf:waterfall` — the rung-0 developer command: eight apps, one gateway, statements + clock, compared to this machine's own saved baseline. |
| `tests/helpers/rig-budgets.ts`, `packages/test-kit/src/quality-result.ts`, `tests/agent-e2e-shared/harness.mjs` | `rigDriftBudgetMs`, `driftBudget`, `qualityRegressionBudget`, `rigDriftBudget`, `regressionBudget` and `trailingMedianBudget` **deleted**. |
| 46 rigs + 2 mobile flows | Every drift/catastrophe call site removed with them. |
| `vitest.perf.config.ts`, `vitest.scale.config.ts` | `fileParallelism: false` deleted; the header says why it existed and why it no longer does. |
| `tests/scale/large-vault.scale.test.ts`, `tests/journeys.json` | The audit-band and WAL gauges become GATED numbers (`gateway/read-cost`); `client/first-paint-work` gains `maxWallClockMs` beside the statement count (#922 D4). |

### Numbers

| Measurement | Value | Provenance |
| --- | --- | --- |
| Seeded 200 ms on the bootstrap read path | **regressed**, +201.2 ms, 95% CI [172.2, 221.3] ms vs a 26.8 ms tolerance, **4 paired rounds**, first run | `node scripts/ci/paired-journeys.mjs --candidate . --pr /tmp/prtree --rounds 4`, linux x64 / 4 cores / 15 GB, 2026-09-04. Three other journeys `held` — no false positive. |
| Seeded **26 ms (a 20% slow-down)** on the same path | **regressed**, +28.4 ms = 23.3%, 95% CI [18.9, 38.6] ms vs a 12.2 ms tolerance, **14 paired rounds**, first run, no warm-up | same command, `--rounds 14`. At 6 rounds the same seed reads `inconclusive`, which fails the lane too — an interval straddling the tolerance is not a pass. |
| audit band per gateway read | 360.4 B observed → gated at **450 B** | `tests/scale/large-vault.scale.test.ts`, 500 reads on the mounted golden vault, 2026-09-03 (lane 3a), re-asserted here |
| WAL per gateway read | 46,490 B observed → gated at **65,536 B** | same run; a read that starts dirtying a second page cluster now fails |
| `perf:waterfall`, eight apps on a year-3-shaped vault | 4.3 s of measurement, 9.2 s wall (cap: one minute) | `bun run perf:waterfall`, linux x64 / 4 cores / 15 GB, 2026-09-04. agenda 504.7 ms / **3,244 statements**; docs 150.2/25; locker 156.8/286; notes 188.4/58; people 151.2/35; photos 210.3/141; tally 200.9/215; tasks 188.3/47 |

### Deleted, with replacement

- The **30-sample drift budget** and the **3× catastrophe budget** → the paired candidate/PR verdict. Both compared one tree's number today against other trees' numbers on other nights and other runners, so most of what they measured was the runner, and neither could answer whether THIS change is slower.
- **`fileParallelism: false`** in both nightly configs → the paired run measures both trees under whatever contention the runner has, so serialising the lane bought nothing and cost the lane's duration. Measured cost of the removal on this container: the gateway cold-start rig read **5,291 ms serially and 6,250 ms in parallel** — and its 5,000 ms ceiling was already breached SERIALLY, so that ceiling is seeded from a faster host than CI runs on.

### Decisions

- An `inconclusive` verdict FAILS the lane. "Slower, but the run cannot say by how much" is not a pass.
- The four paired gateway journeys carry `tolerancePercent: 10`, not 20: they are in-process measurements with low round-to-round spread, and a 20% tolerance would make a seeded 20% regression unprovable by construction.

### Findings

1. **`agenda` first paint issues 3,244 statements** against 25 for `docs` — an N+1 on the busiest app's opening read, found by the new developer command on its first run. Not this lane's to fix (#922 owns hot paths); the ledger entry and the command that found it are here.
2. **The rig DIET LIST — 32 rigs cite no ledger entry.** `tests/perf/{harness-turn,app-engine-handler,automation-fire,backup-throughput,blob-egress,desktop-cold,pwa-waterfall,replica-sync-io,tunnel-native,tunnel-throughput,vault-write}`, `tests/perf/work-counters` (deliberate — it times nothing), `tests/scale/{harness-sessions,automations-fire,backup-restore,blob-gc,blueprint-clones,conversation-ledger,desktop-windows,gateway-sessions,large-vault→now cited,photos-timeline,photos-memories,ontology,backup-manifest-size,browser-replica-query,replica-sse-fanout,replica-bootstrap,replica-retention,tunnel-pairs,web-tabs}`, `tests/agent-e2e-mobile/flows/volume-proof`. The entry each would want: `photos-timeline`/`photos-memories` → `web|mobile/scroll` at `year3-photos`; `browser-replica-query`/`replica-bootstrap` → `mobile/first-bootstrap`; `replica-sse-fanout` → `gateway/peer-echo`; `replica-retention` → `gateway/converge`; `blob-gc`/`backup-restore`/`backup-manifest-size`/`backup-throughput` → a `restore`/`backup` entry that does not exist; `harness-*`/`app-engine-handler`/`automation-fire`/`desktop-*`/`tunnel-*`/`web-tabs`/`blueprint-clones`/`ontology`/`conversation-ledger`/`pwa-waterfall`/`replica-sync-io`/`vault-write`/`blob-egress` → machine costs with no journey above them. **Not deleted** — the maintainer reviews the list.
3. `soak-weekly.yml` still keeps its `quality-history-soak-*` actions cache. Out of this lane's named files; the nightly's is gone.
4. **Three rigs are red on this container BEFORE this lane touches them**, confirmed by stashing the whole diff and re-running: `photos-memories.scale` throws `table media_asset has no column named favorite` (the #916 column drop; lane 3a fixed the same break in `photos-timeline` and not here), `phash-clustering.scale` fails a count assertion (`expected 1 to be +0`), and `gateway-request.perf` reads a 5,291 ms cold start against a 5,000 ms ceiling seeded on a faster host. None is a regression from this lane and none is this lane's to fix.

### Files, in full

Every path this lane's two commits touch that the tables above name only by group:

- `.github/workflows/lane-client-e2e.yml`
- `apps/mobile/src/lib/replica/reader-statement-budget.test.ts`
- `apps/mobile/src/lib/replica/reconnect-to-fresh.fixture.ts`
- `packages/test-kit/src/quality-signal.test.ts`
- `packages/test-kit/src/test-kit.test.ts`
- `scripts/check-ledgers.test.mjs`
- `scripts/check-mobile-suite-budgets.mjs`
- `scripts/ci/bisect-journeys.test.mjs`
- `scripts/ci/gate-classes.json`
- `scripts/lint-product.mjs`
- `scripts/perf/README.md`
- `scripts/perf/app-waterfall.run.ts`
- `scripts/perf/app-waterfall.test.mjs`
- `scripts/perf/app-weight.mjs`
- `scripts/perf/send-to-first-token.mjs`
- `scripts/test-report/derive.mjs`
- `scripts/test-report/fixtures/claims.json`
- `scripts/test-report/ratchet-floors.mjs`
- `tests/agent-e2e-mobile/flows/cold-start.mjs`
- `tests/agent-e2e-mobile/flows/ios-smoke-budget.md`
- `tests/agent-e2e-mobile/flows/volume-proof.mjs`
- `tests/agent-e2e-mobile/lib/ci-gateway.mjs`
- `tests/agent-e2e-mobile/lib/fixed-delay-agent.mjs`
- `tests/agent-e2e-shared/harness.test.mjs`
- `tests/experience-budgets/client-query-counts.json`
- `tests/experience-budgets/desktop.json`
- `tests/experience-budgets/gateway.json`
- `tests/experience-budgets/mobile.json`
- `tests/experience-budgets/web.json`
- `tests/inventory.json`
- `tests/perf/app-engine-handler.perf.test.ts`
- `tests/perf/automation-fire.perf.test.ts`
- `tests/perf/backup-throughput.perf.test.ts`
- `tests/perf/blob-egress.perf.test.ts`
- `tests/perf/desktop-cold.perf.test.ts`
- `tests/perf/desktop-launch.perf.test.ts`
- `tests/perf/fixtures/desktop-main-graph.mjs`
- `tests/perf/gateway-request-volume.perf.test.ts`
- `tests/perf/gateway-request.perf.test.ts`
- `tests/perf/harness-turn.perf.test.ts`
- `tests/perf/pwa-waterfall.perf.test.ts`
- `tests/perf/replica-sync-io.perf.test.ts`
- `tests/perf/tunnel-native.perf.test.ts`
- `tests/perf/tunnel-throughput.perf.test.ts`
- `tests/perf/vault-write.perf.test.ts`
- `tests/quarantine.json`
- `tests/scale/automations-fire.scale.test.ts`
- `tests/scale/backup-manifest-size.scale.test.ts`
- `tests/scale/backup-restore.scale.test.ts`
- `tests/scale/blob-gc.scale.test.ts`
- `tests/scale/blueprint-clones.scale.test.ts`
- `tests/scale/browser-replica-query.fixture.ts`
- `tests/scale/browser-replica-query.scale.test.ts`
- `tests/scale/composite-load.scale.test.ts`
- `tests/scale/conversation-ledger.scale.test.ts`
- `tests/scale/desktop-windows.scale.test.ts`
- `tests/scale/gateway-sessions.scale.test.ts`
- `tests/scale/harness-sessions.scale.test.ts`
- `tests/scale/long-run-soak.scale.test.ts`
- `tests/scale/mobile-reconnect-to-fresh.scale.test.ts`
- `tests/scale/multi-vault-footprint.scale.test.ts`
- `tests/scale/ontology.scale.test.ts`
- `tests/scale/phash-clustering.scale.test.ts`
- `tests/scale/photo-similarity.scale.test.ts`
- `tests/scale/photos-memories.scale.test.ts`
- `tests/scale/replica-reconnect.scale.test.ts`
- `tests/scale/replica-retention.scale.test.ts`
- `tests/scale/stress-to-failure.scale.test.ts`
- `tests/scale/tunnel-pairs.scale.test.ts`
- `tests/scale/web-tabs.scale.test.ts`

### Falsification

1. *Claim: the paired verdict is a property of the DIFFERENCE, not of the runner.* Fed it a series where every round is 40% slower than the last on **both** sides: verdict `held`. Fed it the same drift with a real 30% slow-down on one side: `regressed`. Both in `scripts/ci/paired-journeys.test.mjs`.
2. *Claim: deleting the drift rule left no rig asserting against a budget that no longer exists.* `git grep` for `rigDriftBudgetMs|qualityRegressionBudget|regressionBudget|withinDrift` over `packages/ tests/ scripts/ apps/` returns nothing, `bun run lint` is clean of unused imports, and the `packages/test-kit` suite is 62/62.

## w3 journeys — the nine-journey grid, and no ceiling on an empty vault

### Files

| File | Change |
| --- | --- |
| `tests/journeys.json` | 51 entries. Every one of the nine journeys has a row on all four surfaces — a hole is now a lint error, not a silence. **No journey entry says `"volume": "empty"`.** New volumes: `seeded-demo`, `mock-gateway`, `device-fixture`, `shared-album`. |
| `apps/web/tests/e2e/server.ts` | The web e2e vault is SEEDED — every bundled app's demo data plus 2,000 Atlas rows, through the gateway's own write path. Its budgets said `"volume": "empty (web-e2e fixture vault)"` in as many words. |
| `apps/web/tests/e2e/perf-waterfall.spec.ts` | Reads the re-keyed entries; the report's `volume` field names the declared volume. |
| `tests/scale/share-journey.scale.test.ts` (new) | The share journey's BEFORE number for [#929](https://github.com/srikanth235/centraid/issues/929) wave 1(c): grant → fulfil → the grantee's own read, co-hosted. |
| `scripts/lint-journey-ledger.mjs` + `.test.mjs` | Enforces the 9 × 4 grid. |
| `scripts/lint-test-reachability.mjs` | Registers the waterfall runner. |
| `tests/perf/desktop-launch.perf.test.ts`, `tests/scale/{composite-load,mobile-reconnect-to-fresh}.scale.test.ts`, `tests/agent-e2e-mobile/flows/scroll-frames.mjs`, `scripts/perf/send-to-first-token.mjs` | Follow the re-keyed entries. |

### Numbers

| Journey | Value | Provenance |
| --- | --- | --- |
| web `largestContentfulPaint` | **420 ms** observed (296 / 420 / 476 over three runs) → ceiling **1200 ms** | `npx playwright test -g "web vitals"`, linux x64 / 4 cores / 15 GB, headless_shell 1194, 2026-09-04, on the SEEDED harness. Promoted from `unmeasured`; the entry had said the browser emits no first-contentful-paint. |
| web `interactionToNextPaint` | **24 ms** observed (24 / 24 / 24) → ceiling **120 ms** | same runs, `interactionDriven: true`. Promoted from `unmeasured`. Ceiling is the Core Web Vitals threshold HALVED: 200 ms over a 24 ms interaction would not notice an eightfold regression. |
| web `cumulativeLayoutShift` | 0 → `maxScore` 0.1, unchanged | same runs |
| gateway `share` grant → visible, 200-photo album, co-hosted | **212.1 ms** (133.1 / 212.1 / 244.4 over three runs) → ceiling **750 ms** | `node node_modules/vitest/vitest.mjs run --config vitest.scale.config.ts tests/scale/share-journey.scale.test.ts`, same host, 2026-09-04. Breakdown: grant written 1.9–4.0 ms, **fulfillment 130.8–240.0 ms**, grantee's read 0.3–0.4 ms. |

### Decisions

- **Volume re-keys, not ceiling changes.** Moving an entry from `empty` to a declared volume renames its flattened ratchet key. Nothing to ratchet against on this land (the ledger is new on main), but the ledger's `_comment` now says a re-key carries the same numbers plus an `approvedDeviation` once the file is on the trunk.
- `refSearchUnderComposition` left the `search` journey for the `composite-load` entry: it is the browse lane's p95 under composition, a property of the composite rig, not of the owner's search.

### Findings

1. **Web, desktop and mobile cannot be measured at year-3 volume from their e2e harnesses**, and the reason is one fact: `@centraid/test-kit` ships TypeScript sources with **no build**, so the year-3 generator is unreachable from `node --experimental-strip-types` (the web harness), from a plain `.mjs` script, and from Playwright's server process. The web harness is seeded through the gateway's own write path instead, which is real but is `seeded-demo`, not year-3. Giving the kit a `dist` — or a compiled `year3` entry point — is the one change that unblocks year-3 on every surface at once. **Root's call.**
2. **Desktop rows stay `_intended` with the reason recorded**: Electron does not launch on a display-less runner, so no desktop journey number was taken here. **Mobile rows stay `_intended`**: no device.
3. The share journey's cost is **98% fulfillment** — the grant write and the grantee's read are both under 4 ms at 200 photos. #929's AFTER belongs on the same row.

### Falsification

1. *Claim: no journey entry is stated at an empty volume.* Walked all 51 entries and printed the volume of every one whose journey is not marked "Not a journey" in the ledger's own vocabulary: none is `empty`. The three that remain — `composite-load`, `soak`, `stress-recovery` — are declared non-journeys in the same file.
2. *Claim: the promoted web ceilings actually gate.* Ran the probe against them after promotion: LCP 436 ms against the new 1200 ms ceiling and INP 24 ms against 120 ms, both asserted (they were annotations before). Setting the LCP ceiling to 300 ms reds the spec on the next run.

## w3 profiles — every gateway journey under both durability modes

### Numbers

| Journey | standard (`synchronous=FULL`) | constrained (`synchronous=NORMAL`) |
| --- | --- | --- |
| `first-bootstrap` bootstrap page | 112.9 ms | **149.2 ms** |
| `own-echo` replica intent, warm p50 | 112.6 ms | **173.6 ms** |
| `peer-echo` last-subscriber delivery, N=1 | 66.1 ms | **79.6 ms** |
| `converge` last-subscriber delivery, N=10 | 65.9 ms | **83.2 ms** |

`node packages/server/scripts/bench-journeys.mjs --profile <p> --intents 8 --fill 500 --subscribers 1,10`, linux x64 / 4 cores / 15 GB, 2026-09-04. Ceilings are ~3x observed, per profile.

### Findings

1. **Constrained is slower on all four**, which is the opposite of the intuition that a weaker fsync is cheaper. The profile also shrinks the worker pool, and that term dominates: the intent path pays +54% while the fan-out pays +21%. Anyone quoting a `standard` number for a phone is quoting a number 20–54% too good.

### Falsification

1. *Claim: the paired runner cannot compare a FULL-fsync sample against a NORMAL-fsync ceiling.* The per-profile rows carry the same `pairedSample` path, so `pairedEntries()` would have picked up twelve rows where four exist; it is pinned to the unprofiled hardware key and returns exactly the four. Printed and checked.

## H3 — the device rung, and the test-kit build it needed

| Path | Change |
| --- | --- |
| `.github/workflows/e2e.yml` | Four rung-5 jobs: `device-rung-gate` (always runs, resolves the farm secrets and the Pi variable, writes the absent cells' evidence as `parked`), `device-rung-android` (leased low-end phone), `device-rung-ios` (leased iPhone, behind its own switch), `device-rung-gateway-pi` (`runs-on: [self-hosted, linux, arm64, centraid-pi]`) |
| `scripts/ci/device-farm-lease.sh` (new) | Leases one device and puts it where the repo's OWN harness looks — `adb connect` for Android; the iOS arm REFUSES with the exact reason rather than leasing a device `xcrun simctl` can never enumerate |
| `tests/agent-e2e-mobile/roster.json`, `tests/agent-e2e-mobile/flows/device-rung-budget.md` (new) | Suites `device-rung-android` (10 members, 45 min) and `device-rung-ios` (5, 25 min), their two lanes, rung 5's row rewritten, and every flow's derived `suite`/`rungs`/`platform` recomputed |
| `tests/claims.json`, `tests/quality/classification-ratchet.json` | The four lanes registered, and the whole-file fingerprint re-pinned with the note below |
| `tests/quarantine.json` | The three device cells parked with what unblocks each; **#870's `mobile-e2e-android` and `mobile-e2e-ios` parks deleted** |
| `tests/journeys.json` | Three hardware keys — `device-android-low-end`, `device-iphone`, `pi-arm64-4c` — so a device row and an emulator row can never be averaged |
| `tests/budgets.json` | `mobileSuites` mirror refreshed by `node scripts/check-ledgers.mjs --write` — a MIRROR of the two new roster ceilings, not a widen: no existing budget moves, and `bun run lint:ledgers` reports the ledgers hold against `origin/main` |
| `docs/decisions.md` | `PS-device-rung`, with the cost. This is the in-slice doc exception: a later lane reads it |
| `.github/workflows/soak-weekly.yml` | The evictable `quality-history-soak-*` cache replaced by the gh-pages restore `candidate.yml` uses |
| `packages/test-kit/package.json`, `packages/test-kit/tsconfig.build.json` (new), `packages/test-kit/src/vitest.ts` | A `dist` build wired like every other built package, so a plain-Node harness can reach the year-3 generator at all |
| `scripts/accessibility-contract.test.mjs` | The virtualization contract follows #922 E6's five surfaces onto `SeatList` |

**Mobile ceilings stay `_intended` until the first device run, and that is a statement about hardware.** `ci-android-emu` and `ci-ios-sim` have neither a phone's thermal envelope nor its flash, so every millisecond either produces is a lower bound. Nothing in `tests/journeys.json` is promoted here.

| Number | Value | Provenance |
| --- | --- | --- |
| Suite ceilings | android 2,700,000 ms / ios 1,500,000 ms | NOT measurements — provisional, and `device-rung-budget.md` says so. The members' own budgets are emulator-derived (`ledger/durations.json` holds zero records); the first device run replaces both with `p95 x 1.5` |
| `@centraid/test-kit` reachable from Node | `node -e "import('@centraid/test-kit/year3-vault')"` fails → resolves | linux x64 dev container; before the build the specifier resolved to a `.ts` file no Node can load |

**Deleted, with their replacement:** the `quality-history-soak-*` actions cache (gh-pages, never evicted, which is where `candidate.yml` already reads its history from); #870's two lane parks (see `PS-device-rung` — their 14-day date expires 2026-09-16 and the fix they named has landed; a park moved onto a cell that is skipped until somebody buys a farm would be a mute, not a date).

**Decisions:** the phone cells seed the DEMO corpus, not the golden year-3 replica: nothing seeds a gateway from `goldenYear3Replica()`, and a phone cannot be handed a replica by file push (app-private storage). The test-kit `dist` build landed here is what makes that seeder writable from a plain-Node harness; until it exists every number this rung produces is at demo volume and its ledger row says so. `tests/quality/classification-ratchet.json` approvedDeviation, in full: #930 re-pins the tests/claims.json whole-file fingerprint after removing the spent rename marker on the `golden-vault-archaeology` flow, superseding the #916 re-pin note rather than contradicting it — every sentence of #916's account of what that flow took over is kept, in receipts/issue-916-vault-ontology-review.md and in the flow's own `_comment`. `replacesMinimumTestsFlow` is a ONE-SHOT claim about the change set that makes a rename, checked against the merge base; once #916 landed, `schema-migration-corpus` existed at no base any more, so the marker could only ever report an unknown predecessor and `lint:ledgers` / `test:ratchet` were red on main itself. The marker and the `approvedMinimumTestsDeviation` that authorized it are removed together, because that note waives a future minimumTests drop on this flow by presence alone; the floor stays at 5, no claim row, severity, evidence selector or demonstrated-red date moves, and claimsGovernanceFingerprint is unchanged. Prior: #916. #928 w1b re-pins tests/claims.json once more, for the static app entity tripwire: it registers the new law `app-entity-tripwire` and its flow `blueprint-app-entity-tripwire-law` (owner packages/blueprints/src/app-entity-tripwire.test.ts, minimumTests 17), mirroring how `one-computation` is registered so the lane is owned. Additions to the law and flow registries only, and a NEW minimumTests floor, which is a tightening — no claim row, severity, evidence selector, demonstrated-red date or existing floor moves, and the 45 claim rows stay byte-identical, so claimsGovernanceFingerprint is unchanged. Prior: #930. #931 re-pins it once more after registering ONE new rung-3 lane, `rung1-on-main`, in `lanes` — the row `candidate.yml`'s new job needs before `lint:evidence-mapping` and `validate-nightly-wiring` will accept it. Registry addition only: no claim row, severity, evidence selector, demonstrated-red date, law, flow or `minimumTests` floor moves, and `claimsGovernanceFingerprint` (a digest of `claims.claims` alone) stays byte-identical — the whole-file digest moved only because `lanes` shares the file with `claims`. Prior: #928 w1b. #927 w2 re-pins tests/claims.json for the JOURNEY LEDGER: every `knob` and `seed` string that named tests/experience-budgets/*.json now names tests/journeys.json and the entry key inside it, because those five files were absorbed into one ledger keyed `surface / journey / volume / hardware`. A knob path rename only: no claim row is added or removed, no severity, evidence selector, demonstrated-red date, law, flow or minimumTests floor moves, and every seeded-red recipe still points at the same number under its new address. Prior: #931. #927 w3 re-pins tests/claims.json once more to register ONE new rung-3 lane, `paired-journeys` — the row candidate.yml's paired candidate/PR journey job needs before `lint:evidence-mapping` and `validate-nightly-wiring` will accept its evidence step. Registry addition only: no claim row, severity, evidence selector, demonstrated-red date, law, flow or minimumTests floor moves, and the claim rows stay byte-identical, so claimsGovernanceFingerprint moves only because `lanes` shares the file with `claims`. Prior: #927 w2. #927 w4 re-pins tests/claims.json once more to register the FOUR device-rung lanes — `device-rung-gate`, `device-rung-android`, `device-rung-ios` and `device-rung-gateway-pi` — the rows e2e.yml's new rung-5 jobs need before `lint:evidence-mapping` and `validate-nightly-wiring` will accept their evidence steps. Registry addition only: no claim row, severity, evidence selector, demonstrated-red date, law, flow or minimumTests floor moves, and `claimsGovernanceFingerprint` (a digest of `claims.claims` alone) stays byte-identical — the whole-file digest moved only because `lanes` shares the file with `claims`. Prior: #927 w3.

**Findings:** (1) `rigDriftBudgetMs` (`tests/helpers/rig-budgets.ts`) has **no writer anywhere** — nothing appends to `artifacts/<lane>/<slug>.json`, so it returns `null` on every lane and the sustained-drift budget states no opinion by construction. The soak cache this slice deleted was carrying an empty directory. (2) The iOS cell cannot lease a device until the harness enumerates physical devices (`xcrun devicectl`), which is why it is behind a second switch. (3) The two farm cells are the only recurring third-party spend any lane here incurs. (4) `lint:e2e-wiring` never reads `roster.json`'s `suites[*].lane`, so a suite can name a lane that does not exist and nothing says so — see the Falsification table.

**Doc debt:** none — `PS-device-rung` is written.

```sh
bun run lint:e2e-wiring                # 22 flows, 7 lanes, all reachable
bun run test:claims                    # 45 claims, 54 lanes, 4 mobile device lanes discovered
bun run lint:ledgers                   # 19 sections across 5 ledgers
bun run lint:quality-knobs             # ok
bun run test:accessibility             # 6/6
node -e "import('@centraid/test-kit/year3-vault')"   # resolves
```

### Falsification

| Claim | Throwaway check | Result |
| --- | --- | --- |
| The lanes are registered AND wired, not merely written | Deleted the `Write lane evidence` step from `device-rung-android` and re-ran `bun run test:claims` | RED — "job `device-rung-android` is a registered rung-5 lane with no `Write lane evidence` step". (The first check I tried — renaming the suite's `lane` field — stayed GREEN, because reachability is derived from the lanes table and every device-rung member also sits on an emulator suite. A finding about the linter, not about this diff: `roster.json`'s `suites[*].lane` is not held against anything.) |
| The test-kit build is what makes the generator reachable | `node -e "import('@centraid/test-kit/year3-vault')"` with the pre-change exports restored | RED — `ERR_MODULE_NOT_FOUND`; GREEN after the build, printing the module's keys |

## H3a — the web journeys, re-measured at year-3

| Path | Change |
| --- | --- |
| `apps/web/tests/e2e/server.ts` | Seeds the shared year-3 generator's golden daily-path profile straight into the mounted vault, BEFORE the demo routes; the 2,000-row Atlas fill it replaces is deleted |
| `packages/test-kit/src/year3-distributions.ts` | The receipt chain continues from `MAX(seq)` instead of restarting at 1 — what let the generator fill a vault a live `serve()` had already written receipts into |
| `tests/journeys.json` | The ten `web/*` entries re-keyed `seeded-demo` → `year3`, three vitals re-observed there, `volumes.seeded-demo` rewritten to what still uses it, and the re-key's `approvedDeviation` |
| `apps/web/tests/e2e/perf-waterfall.spec.ts` | The two ledger keys it reads, and the volume string it stamps on its own report |
| `scripts/perf/app-waterfall.run.ts` | Module header: the rig runs under vitest for the assertions, not because the kit ships no build |
| `scripts/lint-journey-ledger.mjs`, `scripts/lint-journey-ledger.test.mjs` | The `entries` section's OWN `approvedDeviation` is no longer read as a journey key — the ledger demanded one on a re-key and no place existed that both gates accepted (finding 4) |

| Journey row | seeded-demo | year3 | Ceiling (unchanged) |
| --- | --- | --- | --- |
| `web/cold-open` largestContentfulPaint | 296 / 420 / 476 ms | **484 / 516 / 524 ms** | 1200 |
| `web/warm-switch` interactionToNextPaint | 24 / 24 / 24 ms | **24 / 24 / 24 ms** | 120 |
| `web/cold-open` cumulativeLayoutShift | 0 | **0** | 0.1 |

`bun run --cwd apps/web e2e -- perf-waterfall.spec.ts`, `CENTRAID_E2E_CHROMIUM=/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell`, linux x64 / 4 cores / 15 GB, 2026-09-04.

**Nothing PROMOTES, and that is the answer rather than a shortfall.** Both measured rows already gated; year-3 costs the shell ~80 ms of LCP inside a 1200 ms ceiling and moves INP and CLS by nothing. The other eight `web/*` rows are `unmeasured` for want of a PROBE — `"No probe drives it yet"` — not for want of volume, so no volume changes their status; they are re-keyed with the harness and say so. No ceiling widens: every number is carried across byte-identical and the `approvedDeviation` covers only the address.

**Deleted, with its replacement:** the harness's 2,000-row Atlas `core.place` fill — the year-3 generator supplies the row count now, from the same statements and the same declared distribution every other rig measures against.

**Decisions:** the ceilings are CARRIED ACROSS rather than re-derived from the year-3 samples. `tests/journeys.json` is tighten-only, and a ceiling re-seeded at 2.3x on a contended container is one host's noise away from needing to come back up.

**Findings:**

1. **`perf-waterfall.spec.ts`'s app-open waterfall is RED on `origin/main` (541f0720c), independent of this lane.** `Loading Tasks…` is still on screen after the spec's 10 s wait. Reproduced on a detached `origin/main` checkout with a full `bun run build` and nothing of this branch in the tree: 3 passed, 1 failed — the same 3/1 this branch produces before and after the year-3 seed. The gateway is not the cost: on the seeded harness `/centraid/_vault/scopes?app=tasks` answers in 4.7 ms, `/centraid/tasks/_describe` in 5.2 ms and `POST /centraid/tasks/queries/board` in 102 ms, and `InlineAppRoute.tsx` holds the fallback until `scopes && descriptorPromise` — both of which those answers supply. Client-side, past the gateway, and owned by the shell's app-open path, not by this lane.
2. `seedYear3Distributions` wrote `access_receipt.seq` as `index + 1` from 1, so it could seed only a file no gateway had served — founding and mounting a vault writes receipts, and the seed died on `UNIQUE constraint failed: access_receipt.seq`. Fixed here; the golden artifact's bytes are unchanged because `MAX(seq)` is NULL on a fresh file.
4. **The ledger's re-key rule had nowhere to write its waiver.** `tests/journeys.json`'s `_comment` requires an `approvedDeviation` on a re-key; `scripts/check-ledgers.mjs` reads it from the `entries` object itself (a neighbouring section's never waives, #781), and `scripts/lint-journey-ledger.mjs` then read that string as a journey key and failed it for not being `surface/journey/volume/hardware`. The reserved key is now skipped, with a test.
3. The generator plants the flags concept scheme by URI and the product's own `flags.ts` creates it on first use, so a year-3 seed must precede any demo seed or the two collide on `core_concept_scheme.uri`. The ordering is a comment in the harness beside the call.

**Doc debt:** none.

```sh
CENTRAID_E2E_CHROMIUM=/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell \
  bun run --cwd apps/web e2e -- perf-waterfall.spec.ts   # vitals 3/3; app-open red on main too (finding 1)
bun run lint:journey-ledger                              # ok
bun run lint:ledgers                                     # 19 sections across 5 ledgers
```

### Falsification

| Claim | Throwaway check | Result |
| --- | --- | --- |
| The app-open red is pre-existing, not the year-3 seed | Stashed the lane, detached onto `origin/main`, full `bun run build`, ran the same spec | RED there too, same test, same assertion — 3 passed / 1 failed with none of this branch in the tree |
| The re-key widens no ceiling | Diffed every `ceiling*`/`max*` under the ten moved keys against their `seeded-demo` originals | Byte-identical: 1200, 120, 0.1 and eight `_intendedCeilingMs: null`. Only the key moved |

## CI-green — test-kit off the turbo build graph

| Path | Change |
| --- | --- |
| `packages/test-kit/package.json`, `packages/test-kit/src/vitest.ts` | Source exports restored. A `build` script on `@centraid/test-kit` joined `^build` for every workspace that lists it as a devDependency, so `coverage-shard`'s `build:ci:floored` rebuilt `@centraid/tunnel` (217s) and missed the 0.15 hit-rate floor (2/14 = 14.3%). The year-3 generator is reachable from the web e2e harness without that graph node: `apps/web/tests/e2e/playwright.config.ts` already runs `node --experimental-strip-types tests/e2e/server.ts`. |
| `packages/test-kit/tsconfig.build.json` | Deleted. It existed only to feed the turbo `build` task. |
| `.github/actionlint.yaml` (new) | Names the `centraid-pi` self-hosted label `device-rung-gateway-pi` uses, so actionlint stops treating a real runner as unknown. |
| `tests/agent-e2e-mobile/flows/device-rung-budget.md`, `scripts/perf/app-waterfall.run.ts` | Drop the claim that the kit ships a `dist` build. |

The 0.15 floor is unchanged. This is a graph mistake, not a cache-policy miss.

`tests/quality/classification-ratchet.json` `approvedDeviation`, verbatim, so `lint:quality-knobs` can see the receipt that authorized the fingerprint re-pin (H3's copy ended `Prior: #927 w3`; the ratchet string ends `Prior: #922`):

#930 re-pins the tests/claims.json whole-file fingerprint after removing the spent rename marker on the `golden-vault-archaeology` flow, superseding the #916 re-pin note rather than contradicting it — every sentence of #916's account of what that flow took over is kept, in receipts/issue-916-vault-ontology-review.md and in the flow's own `_comment`. `replacesMinimumTestsFlow` is a ONE-SHOT claim about the change set that makes a rename, checked against the merge base; once #916 landed, `schema-migration-corpus` existed at no base any more, so the marker could only ever report an unknown predecessor and `lint:ledgers` / `test:ratchet` were red on main itself. The marker and the `approvedMinimumTestsDeviation` that authorized it are removed together, because that note waives a future minimumTests drop on this flow by presence alone; the floor stays at 5, no claim row, severity, evidence selector or demonstrated-red date moves, and claimsGovernanceFingerprint is unchanged. Prior: #916. #928 w1b re-pins tests/claims.json once more, for the static app entity tripwire: it registers the new law `app-entity-tripwire` and its flow `blueprint-app-entity-tripwire-law` (owner packages/blueprints/src/app-entity-tripwire.test.ts, minimumTests 17), mirroring how `one-computation` is registered so the lane is owned. Additions to the law and flow registries only, and a NEW minimumTests floor, which is a tightening — no claim row, severity, evidence selector, demonstrated-red date or existing floor moves, and the 45 claim rows stay byte-identical, so claimsGovernanceFingerprint is unchanged. Prior: #930. #931 re-pins it once more after registering ONE new rung-3 lane, `rung1-on-main`, in `lanes` — the row `candidate.yml`'s new job needs before `lint:evidence-mapping` and `validate-nightly-wiring` will accept it. Registry addition only: no claim row, severity, evidence selector, demonstrated-red date, law, flow or `minimumTests` floor moves, and `claimsGovernanceFingerprint` (a digest of `claims.claims` alone) stays byte-identical — the whole-file digest moved only because `lanes` shares the file with `claims`. Prior: #928 w1b. #927 w2 re-pins tests/claims.json for the JOURNEY LEDGER: every `knob` and `seed` string that named tests/experience-budgets/*.json now names tests/journeys.json and the entry key inside it, because those five files were absorbed into one ledger keyed `surface / journey / volume / hardware`. A knob path rename only: no claim row is added or removed, no severity, evidence selector, demonstrated-red date, law, flow or minimumTests floor moves, and every seeded-red recipe still points at the same number under its new address. Prior: #931. #927 w3 re-pins tests/claims.json once more to register ONE new rung-3 lane, `paired-journeys` — the row candidate.yml's paired candidate/PR journey job needs before `lint:evidence-mapping` and `validate-nightly-wiring` will accept its evidence step. Registry addition only: no claim row, severity, evidence selector, demonstrated-red date, law, flow or minimumTests floor moves, and the claim rows stay byte-identical, so claimsGovernanceFingerprint moves only because `lanes` shares the file with `claims`. Prior: #927 w2. #922 re-pins tests/claims.json after registering ONE new flow, `pending-destructive-projection` (owner packages/blueprints/src/pending-projection-tripwire.test.ts, flow blueprint-pending-overlay-law). Flow registry addition only: no claim row, severity, evidence selector, demonstrated-red date, law or minimumTests floor moves, and claimsGovernanceFingerprint (digest of claims.claims alone) stays byte-identical. #927 w4 re-pins tests/claims.json once more to register the FOUR device-rung lanes — `device-rung-gate`, `device-rung-android`, `device-rung-ios` and `device-rung-gateway-pi` — the rows e2e.yml's new rung-5 jobs need before `lint:evidence-mapping` and `validate-nightly-wiring` will accept their evidence steps. Registry addition only: no claim row, severity, evidence selector, demonstrated-red date, law, flow or `minimumTests` floor moves, and `claimsGovernanceFingerprint` (a digest of `claims.claims` alone) stays byte-identical — the whole-file digest moved only because `lanes` shares the file with `claims`. Prior: #922.

## CI-green — journey re-key waiver at file root

`scripts/test-report/ratchet-floors.mjs` loads `tests/journeys.json` as a whole file (no `section`), so it only sees a root `approvedDeviation`. The W4 re-key note lived under `entries`, which `lint:journey-ledger` requires, and the ratchet read the ten `seeded-demo` keys as deletions. The same rationale now sits at the file root as well; the entries copy is unchanged.

## Close pass — checklist crosswalk

Docs-only close pass over `origin/main` @ `50ab218cf`. Nine boxes re-read against the tree; five tick, four do not, each with what remains. No box is ticked on a clause the code does not hold.

| Box | Verdict |
| --- | --- |
| 1 developer command, waterfall against the last baseline taken on that machine | **satisfied**, after the box moved. The close pass first read this NOT satisfied — `bun run perf:waterfall` compares against a baseline taken on the developer's own machine, not the candidate's — and put the choice to the maintainer, who ruled that the box was wrong and the command was right: a CI number is not a number about this laptop. The box text is amended in this follow-up commit, which is the one edit permitted above an appended section, and everything else it asks for already held (eight apps, golden vault, span waterfall, 9.2 s wall against a one-minute cap). |
| 2 per-PR gate is a work-counter comparison | **satisfied** by `## w1-gate` (`scripts/ci/work-counter-gate.mjs`, `tests/perf/work-counters.perf.test.ts`, retry and `strace` deleted, both seeds red on the first run) |
| 3 paired candidate/PR journeys, seeded 20% | **satisfied** by `## w2 paired runner` (`scripts/ci/paired-journeys.mjs`, +23.3% with a 95% CI over 14 paired rounds, first run) |
| 4 one ledger; every entry names its spans and its consumer | **NOT satisfied**: `tests/journeys.json` replaces the five files, `lint:journey-ledger` fails any surviving reference, and all 60 entries name spans — but **18 carry `consumers: []`** (the `_intended` grid rows on `web/*`, `desktop/*`, `mobile/*` and `gateway/scroll`). Each states its absence with a `_reason`, which is the ledger's design; the box's clause is still unmet. |
| 5 nine journeys `measured` at year-3 on web/desktop/gateway and on real devices; no `"volume": "empty"` | **NOT satisfied**, parked by hardware: `"volume": "empty"` appears in **3** entries (`gateway/composite-load`, `gateway/soak`, `gateway/stress-recovery`), every `desktop/*` row is keyed `mock-gateway` and every mobile seat row `ci-ios-sim` / `device-fixture`. The device rung (box 7) is the rung that ends it; until a cell runs, no mobile ceiling may leave `_intended` (`PS-device-rung`). |
| 6 perf history on gh-pages; nothing perf-related in an actions cache | **satisfied** by this follow-up commit: the write-only `actions/cache/save` of `artifacts/scale/` in `.github/workflows/soak-weekly.yml` is deleted — nothing restored that key, so nothing reads less than it did. The nightly's `quality-history-soak-*` cache went in `## w2 ledger`; this was the last one. |
| 7 device rung exists as a lane; parked mobile lanes unparked or deleted with the reason | **satisfied** by `## H3` and `PS-device-rung` |
| 8 § Performance names the journey ledger as the gate | **satisfied** by this pass |
| 9 every #922 receipt from wave 2 on cites ledger numbers | **satisfied** by this pass — `## Ledger citations (close pass)` in the #922 receipt |

### Files

| File | Change |
| --- | --- |
| `docs/decisions.md` | § Performance and Rust byte plane names `tests/journeys.json` as the gate, present tense; `PS-evidence-gate` and `PS-trace` "Lands in" cells state landed state; `PS-922-instruments` drops "until the ledger lands" and points at the #922 receipt's citation map |
| `TESTING.md` | ledger rule 4 states why every `desktop/*` and mobile seat row is parked under `_intendedCeilingMs` and what ends the park |
| `receipts/issue-927-perf-infra.md` | five ticks, the crosswalk paragraph in `## What changed`, this section |
| `receipts/issue-922-snappier-blueprints.md` | `## Ledger citations (close pass)` (box 9's evidence) |

**Decisions:** none — no ruling moved. Four boxes were left open rather than ticked on a partial clause.

**Findings.** (1) `soak-weekly.yml`'s `actions/cache/save` of `artifacts/scale/` is both the last perf-in-a-cache and dead (no restore); a workflow file, outside this lane's reading set. (2) 18 ledger entries carry `consumers: []`; the grid is complete, the readers are not. (3) `bun run perf:waterfall`'s baseline is machine-local by ruling and the acceptance box says candidate — one of the two should move.

**Doc debt:** none — every statement this pass makes is about the tree it was written against.

### Verification

```sh
bun run format:check && bun run lint
bash .governance/run.sh
bun run lint:journey-ledger
bun run test:ratchet
node -e 'const j=require("./tests/journeys.json");console.log(Object.values(j.entries).filter(v=>v&&v.metrics&&(!v.consumers||!v.consumers.length)).length)'   # 18
grep -n "actions/cache/save" .github/workflows/soak-weekly.yml   # 138
```

Tree hash: quoted in the lane report to the root (a tree hash cannot be written inside the tree it names).

### Falsification

| Claim | Throwaway check | Result |
| --- | --- | --- |
| "§ Performance names the ledger as the gate" is now true of the tree, not of a plan | `grep -n "tests/journeys.json" docs/decisions.md` inside the § Performance paragraph, and re-read for any surviving "when it lands" | present tense, one link to `../tests/journeys.json`; no future tense left in the paragraph |
| Box 6 is genuinely unmet — the receipt's own w2 section claims the perf cache was deleted | `grep -rn "actions/cache" .github/workflows/*.yml` and then `grep -rn "soak-weekly-" .github scripts` for a restore | one `save` at `soak-weekly.yml:138` over `artifacts/scale/`, zero restores anywhere — the box fails and the cache is dead |

## Close pass — budget tightening (all four umbrellas)

The close pass owes one tighten-only pass over [`tests/journeys.json`](../tests/journeys.json) per umbrella, where a landed win left a ceiling above what the tree now measures. **Nothing was tightened, and the reason is the same for all four**: every `measured` ceiling in the ledger was set by the wave that measured it and carries its own argued headroom in `_provenance.headroom`, so there is no entry sitting at a pre-win value. Tightening one further would mean either contradicting a rationale someone wrote beside the number, or inventing a number this pass did not measure — and this pass ran no rig.

| Umbrella | Entries a landed win could have loosened | Outcome |
| --- | --- | --- |
| #927 | `client/first-paint-work/year3/any` (four screens) | already `headroom: "NONE, deliberately"` — observed IS the ceiling on all four; nothing to take |
| #927 | `gateway/read-cost/year3/ci-linux-x64-4c` | `auditBandPerRead` observed + ~25% (the receipt size moves in steps when a purpose is renamed, not continuously); `walBytesPerRead` observed + ~41%, sized to one SQLite page cluster. Both headrooms are the argument, not slack |
| #922 | `gateway/own-echo/seeded-demo/…-standard` and `…-constrained`, `gateway/first-bootstrap/year3-replica/…` | `~3x observed` and `~4.6x observed`, both stamped "single host". A single-host ceiling tightened toward its own observation is a CI flake, which is why the wave stated the multiple rather than the observation |
| #922 | `web/cold-open/year3/ci-linux-x64-4c` LCP | ceiling 1,200 ms against observed 484 / 516 / 524 ms — the widest gap in the file, and deliberately carried across unchanged when #927 W4 re-keyed the entry from `seeded-demo` to `year3`. Tightening it needs a run of `apps/web/tests/e2e/perf-waterfall.spec.ts`, which this pass did not do |
| #928 | none | no #928 win has a ledger entry; its numbers are work counters and statement counts |
| #929 | `gateway/share/shared-album/ci-linux-x64-4c` | `grantToVisible` is the only measured metric and its cross-gateway sibling is still `unmeasured`; a ceiling tightened on the co-hosted half alone would fence the wrong journey |

**Finding, for the root rather than for this commit.** `mobile/app-weight/build-artifact/any` states `headroom: "observed + 8%"`, and `maxTotalBytes` (12,582,912 against 11,604,148 observed) matches it — but `maxLargestChunkBytes` is **8,220,000 against 6,355,198 observed, ~29%**, where the sibling `web/app-weight` entry states "largest chunk + ~10%". Either the mobile chunk ceiling should come down to ~7.0 MB or its `headroom` string should say why the Hermes bundle needs three times the web seat's slack. Not taken here: the consumer is `scripts/perf/app-weight.mjs` over a release-configuration Expo export, which this container cannot produce, and a tightening nobody ran is exactly the change this section refuses on every other row.

### Verification

```sh
bun run lint:journey-ledger    # ok — every entry names its volume, hardware, spans and consumers
bun run test:ratchet           # ratchet-floors: ok (no decreases vs origin/main)
node -e 'const j=require("./tests/journeys.json");for(const[k,v]of Object.entries(j.entries)){if(v&&v.metrics)for(const[m,x]of Object.entries(v.metrics))if(x._provenance&&x._provenance.headroom)console.log(k,m,x._provenance.headroom)}'
```

### Falsification

| Claim | Throwaway check | Result |
| --- | --- | --- |
| "Every measured ceiling already carries an argued headroom" — a claim about all 60 entries, made after reading a handful | enumerated `_provenance.headroom` across the whole file and read the ones that had none | every `measured` metric either states a headroom or states `NONE, deliberately`; the only mismatch between a stated headroom and its own numbers is the mobile largest-chunk row above, which is why it is a finding rather than a silent tightening |
| `lint:journey-ledger` passing means every entry names a consumer, which would contradict this pass's #927 box-4 verdict | ran it, then re-read `scripts/lint-journey-ledger.mjs` against the 18 entries with `consumers: []` | the linter accepts an empty array as "named"; it fences the KEY and the retired-file references, not the readership. The box-4 verdict stands, and the gate is not the thing that would have caught it |

## Close pass — follow-up: the two findings that were one-line fixes

The root's ruling on the close pass's own findings, landed. Two of #927's four open boxes close here; the other two (4 and 5) are unchanged and still parked on readership and hardware.

| File | Change |
| --- | --- |
| `.github/workflows/soak-weekly.yml` | the "Save evidence for the nightly health report" step is deleted — six lines, an `actions/cache/save` of `artifacts/scale/` under `soak-weekly-<os>-<run_id>` that **no workflow and no script restored**. Nothing downstream loses evidence: the same `artifacts/` tree still rides the `actions/upload-artifact` step directly above it, and `write-evidence.mjs` writes the lane's row for the gh-pages report on the step above that |
| `receipts/issue-927-perf-infra.md` | box 1's text amended to the machine-local baseline; boxes 1 and 6 ticked, both crosswalked in `## What changed`; their two verdict rows rewritten |

**Decisions.** One, and it is the maintainer's: **the box moved, not the command.** `perf:waterfall`'s baseline stays machine-local. The acceptance text said "against the last candidate baseline" because the candidate rung was the model in view when it was written; a developer running the command is asking about the machine in front of them, and a CI runner's number cannot answer that. The candidate comparison still exists and is box 3's — `scripts/ci/paired-journeys.mjs`, between two trees rather than two runs.

**Findings.** `PeerPlaneSweepOptions.partyIdFor` (`packages/server/src/serve/peer-plane-sweep.ts:31`) is **declared, supplied twice by `build-gateway.ts`, and read nowhere** — it was the principal an edge placement ran as, and edge placement is deleted. Removing it reaches three files and a typecheck, so it is filed rather than taken here.

**Doc debt:** none.

### Verification

```sh
grep -rn "actions/cache" .github/workflows/*.yml      # no perf or scale path left
grep -rn "soak-weekly-" .github/workflows scripts     # only the concurrency group and the artifact name
bun run lint:journey-ledger                            # ok
bun run format:check && bun run lint
bash .governance/run.sh
```

### Falsification

| Claim | Throwaway check | Result |
| --- | --- | --- |
| Deleting the cache save loses evidence the nightly report reads | re-read `soak-weekly.yml` around the deleted step, then grepped the whole workflow tree and `scripts/` for a restore of that key | the step above it uploads the same `artifacts/` tree as an artifact and the step above that runs `write-evidence.mjs`; the deleted key had **zero** restores anywhere, so nothing read it to begin with |
| Amending an acceptance box is a way to make a red box green | re-read `scripts/perf/app-waterfall.mjs`'s header against the amended text | the command already did every other clause; the amendment narrows the box to the behaviour the code argues for, and the candidate-vs-candidate comparison the old text wanted is not lost — it is box 3's paired runner, which is ticked on its own evidence |
## Rig diet — deletion (#927)

Thirty rigs cited no `tests/journeys.json` entry. Maintainer approved the diet list 2026-09-05; `tests/scale/large-vault` (now cited) and `tests/perf/work-counters` (times nothing) were excluded and stay. Census before deleting: all 30 carried `entries: []` in `#rigs`, and none was named as a `consumer` of any entry.

| Deleted rig(s) | Replacement |
| --- | --- |
| `tests/scale/photos-timeline`, `photos-memories` | `web\|mobile/scroll` at `year3-photos` |
| `tests/scale/browser-replica-query`, `replica-bootstrap` | `mobile/first-bootstrap` |
| `tests/scale/replica-sse-fanout` | `gateway/peer-echo` |
| `tests/scale/replica-retention` | `gateway/converge` |
| `tests/scale/blob-gc`, `backup-restore`, `backup-manifest-size`, `tests/perf/backup-throughput` | NONE — no `restore`/`backup` entry exists (finding below) |
| `tests/perf/harness-turn`, `app-engine-handler`, `automation-fire`, `blob-egress`, `desktop-cold`, `pwa-waterfall`, `replica-sync-io`, `tunnel-native`, `tunnel-throughput`, `vault-write`; `tests/scale/harness-sessions`, `automations-fire`, `blueprint-clones`, `conversation-ledger`, `desktop-windows`, `gateway-sessions`, `ontology`, `tunnel-pairs`, `web-tabs`; `tests/agent-e2e-mobile/flows/volume-proof` | Ruled: machine costs with no journey above them |

Also deleted: `tests/perf/fixtures/blob-egress-server.mjs`, `tests/perf/fixtures/desktop-main-graph.mjs` and `tests/perf/fixtures/vault-write-child.mjs` (each used by one deleted rig only). `tests/scale/browser-replica-query.fixture.ts` STAYS — `packages/client/src/replica/read-plan-parity.test.ts` still imports it.

Readers removed: `tests/journeys.json#rigs` (30 rows) + 4 prose notes; `tests/claims.json#flows` (21 rows) and its mirror `scripts/test-report/fixtures/claims.json`; `tests/floors.json#minimumTests` (21, regenerated via `check-ledgers --write`); `tests/inventory.json` (3 `skips`, 2 `envRed` rows); `tests/agent-e2e-mobile/roster.json` and `tests/agent-e2e-mobile/flows/claim-pins.json` (`volume-proof` row, suite membership, and its claim pin — pulled from `baseline` too so the down-only ratchet tightens); `tests/agent-e2e-mobile/flows/probes-budget.md` + `tests/agent-e2e-mobile/README.md` retotalled 6→5 flows and the suite ceiling 35→26 min (`tests/budgets.json` mirror refreshed); `.github/workflows/e2e.yml` nightly `strace` install (no surviving perf/scale rig traces syscalls); comment readers in `scripts/perf/send-to-first-token.mjs`, `scripts/lint-e2e-flows.test.mjs`, `tests/perf/desktop-launch.perf.test.ts`, `tests/helpers/composite-workload.ts`, `packages/server/src/routes/replica-fanout.test.ts`, `tests/agent-e2e-mobile/flows/cold-start.mjs`, `tests/agent-e2e-mobile/lib/harness.mjs`; `TESTING.md` fsync row. `CHANGELOG.md` records the removal. No workflow job or package script named a deleted rig — the lanes run `test:perf` / `test:scale` wholesale — so `e2e.yml` is the only workflow touched.

No surviving rig's ceiling moves. `tests/journeys.json` root `approvedDeviation` was extended for the 30 removed rig budgets.

```
bun run format:check && bun run lint && bun run typecheck   # green
bun run lint:journey-ledger && bun run test:claims          # green
bun run test:ratchet && bun run lint:ledgers                # green
bun run test:report:smoke && bun run test:ratchet:unit      # green
node --test scripts/check-ledgers.test.mjs scripts/lint-e2e-flows.test.mjs  # green
node scripts/lint-e2e-claims.mjs && node scripts/lint-e2e-wiring.mjs        # green
bun run --cwd packages/client test src/replica/read-plan-parity.test.ts     # 33 passed
bun run --cwd packages/server test src/routes/replica-fanout.test.ts        # 7 passed
bun run test:perf:counters                                                  # 2 passed
bun run test:ratchet:unit                                                   # 515 passed (37 files)
bash .governance/run.sh                                                     # all 22 green
```

Findings. (1) and (2) below were the two gate gaps this deletion hit; both are now closed by added vocabulary, ruled by the root and recorded under Decisions. (3) `tests/scale/mobile-screen-reads.scale.test.ts` also carries `entries: []` and is NOT on the approved diet list — a 31st uncited rig, left in place. (4) A `restore`/`backup` journey entry is a gap: four rigs were deleted with no successor entry to answer to; none was invented. (5) `TESTING.md`'s fsync row was already stale before this change — no lane sets `CENTRAID_BENCH_REQUIRE_FSYNC=1`; corrected. (6) `tests/scale/browser-replica-query.fixture.ts` now has no rig in `tests/scale/` — its only consumer is a `packages/client` test, so it is misfiled.

Doc debt: `packages/server/benchmarks/README.md` says "CI sets `CENTRAID_BENCH_REQUIRE_FSYNC=1`" — no lane does (this lane). `docs/harnesses.md` names no rig and holds no build-vs-mount wording, so the brief's row-deletion and wording fix had nothing to act on (this lane).

### Decisions

**Added vocabulary for a reviewed deletion; no floor loosened.** Two gates refused an approved outright rig retirement, and neither refusal was wrong about its own property — they simply had no way to say "deleted on purpose, with no successor".

1. **`removedMinimumTestsFlows` in `tests/claims.json`, honoured by `scripts/test-report/ratchet-floors.mjs`.** `diffMinimumTests` waived a removed `flows` row only via a one-to-one `replacesMinimumTestsFlow` successor or by KEEPING the row with `approvedMinimumTestsDeviation` — and a kept row is refused by `validate-claims.mjs`, which requires every `flows[].owner` to exist on disk. So a rig deleted outright could not be recorded at all. The marker is a map from the retired flow id to `{ owner, reason, issue }`. **The property the ratchet defends is unchanged: no floor drops SILENTLY.** A marker is a reviewed line in the diff that names the deleted rig, cites the approval and its change set; an unmarked deletion is still red, a marker whose row is not actually removed is red, a marker naming the wrong owner or a flow the base never declared is red, and two markers may not retire one owner. `validate-claims.mjs` checks the marker's shape but never stats its owner — that owner is the one path in the file that must NOT exist. The marker is ONE-SHOT: it is validated only while NEW against the base, so a spent marker carried on main re-litigates nothing and cannot red a later PR (`replacesMinimumTestsFlow` left main red between the spend and the cleanup — see the #930 note above; this shape does not).

2. **Reserved keys in `tests/journeys.json#rigs`, via `scripts/test-report/journey-rigs.mjs`.** `check-ledgers.mjs` requires a budget removal's waiver to sit in the SECTION being widened, but `validate-nightly-wiring.mjs` read every `#rigs` key as a rig path to stat — so declaring the waiver that gate demands made this one report `approvedDeviation` as a missing rig. `approvedDeviation` and `_comment` are now reserved and skipped by the walker; every real rig path is still validated. **`ratchet-floors.mjs` does not accept the section note** — it loads the ledger whole and sees only a root `approvedDeviation` — so the same rationale sits in BOTH places, and neither copy waives anything the other does not.

Files carrying that vocabulary: `scripts/test-report/ratchet-floors.mjs` (the marker rule) and `scripts/test-report/ratchet-floors.test.mjs` (eight cases: approved deletion green; unmarked deletion, marker without a removed row, unknown flow, wrong owner, duplicate owner and a malformed marker all red; a spent marker inert), `scripts/test-report/validate-claims.mjs` (marker shape checked, owner never stat-ed), `scripts/test-report/journey-rigs.mjs` with cases in `scripts/test-report/validate-nightly-wiring.test.mjs` (a reserved key is skipped, a real rig path is still validated), and `scripts/test-report/validate-nightly-wiring.mjs` reading rig paths through it.

Nothing was loosened to go green: no surviving floor, ceiling or budget moves, and every escape added is refused unless the diff names what was deleted and why.

### Falsification

| Claim | Check | Result |
| --- | --- | --- |
| No deleted rig was a journey's rig/consumer | Walked `tests/journeys.json` with a JSON walker over keys AND values, not grep | All 30 had `entries: []`; 0 named as a `consumer` |
| No reader of a deleted rig survives | Re-ran `git grep -F` for all 30 rig paths outside `receipts/`, `CHANGELOG.md`, `docs/decisions.md` | Empty |
| The rig registry still loads after the cut | `bun run test:perf:counters` (a surviving rig, reads `#rigs`) | 2 passed |
| Deleting the shared fixture is safe | Deleted `browser-replica-query.fixture.ts`, then grepped importers | REFUTED — a surviving client test imports it; restored |
| The retirement marker cannot launder an unreviewed drop | Unit cases: unmarked deletion, marker without a removed row, wrong owner, duplicate owner, missing reason/issue | All red as intended; only the fully-named deletion passes |
| A spent marker will not red main later | `diffMinimumTests(landed, landed)` with the marker on both sides | No errors — validated only while new |

## Follow-up — #927 close (ledger hygiene)

Three things the close pass left: eighteen entries with no reader, one ceiling that did not obey its own stated headroom rule, and no successor for the four backup rigs the rig diet deleted.

### Crosswalk

| Box | Verdict |
| --- | --- |
| 4 one ledger; every entry names its spans and its consumer | **satisfied**: 18 empty `consumers` lists → 0. `bun run lint:journey-ledger` green, `bun run test:ratchet` green |
| 5 the nine journeys `measured` at year-3 on web, desktop and gateway, and on real devices for mobile; no `"volume": "empty"` | **still open**, untouched by this lane: most web/desktop/mobile rows are `unmeasured` for want of a probe or a device, and `composite-load`, `soak` and `stress-recovery` are still keyed `empty` |

### Files

| File | Change |
| --- | --- |
| `tests/journeys.json` | 18 consumer lists filled; 3 `_folded_into` + `_folded_why` markers; `mobile/app-weight` largest-chunk ceiling tightened; the `backup` journey declared; `gateway/backup/year3/ci-linux-x64-4c` and `gateway/restore/year3/ci-linux-x64-4c` added, both `measured` |
| `tests/perf/backup-restore.perf.test.ts` | new, 122 lines: the successor rig. Snapshot + restore of the golden year-3 vault, work counters as the gate, the two ceilings asserted through `journeyCeiling` |
| `receipts/issue-927-perf-infra.md` | one tick, its crosswalk evidence, this section |

### The eighteen, and what now reads them

| Entries | Reader named |
| --- | --- |
| `web/{peer-echo,converge}` | `apps/web/tests/e2e/offline-reconnect.spec.ts` — the harness that drives replica resume and apply in a real browser |
| `web/share` · `web/search` · `web/scroll` · `web/first-bootstrap` | `docs-grant.spec.ts` · `offline-search.spec.ts` · `perf-waterfall.spec.ts` · `pwa-offline-journey.spec.ts` |
| `desktop/{peer-echo,search,converge}` | `apps/desktop/tests/e2e/fixtures.ts`, already the named reader of `desktop/own-echo` |
| `desktop/share` · `desktop/first-bootstrap` | `household.spec.ts` · `onboarding-home.spec.ts` |
| `mobile/warm-switch` · `mobile/{peer-echo,first-bootstrap}` · `mobile/search` | `home-loads.mjs` · `pairing-canary.mjs` · `photos-search.mjs` |
| `desktop/scroll` **folded into** `mobile/scroll` | `tests/agent-e2e-mobile/flows/scroll-frames.mjs` — the frame-drop ceiling has one owner and it is the phone |
| `gateway/scroll` **folded into** `gateway/warm-switch` | `tests/perf/gateway-request.perf.test.ts` — the gateway's only half of a scroll is the paged read, already fenced |
| `mobile/share/device-fixture` **folded into** `mobile/share/shared-album` | `tests/agent-e2e-mobile/flows/sharing-reach.mjs` — same probe, and `shared-album` is the volume its measured gateway twin uses |

### Numbers

| Measurement | Value | Provenance |
| --- | --- | --- |
| entries with `consumers: []` | 18 → **0** | `bun run lint:journey-ledger`, this tree |
| `mobile/app-weight` `maxLargestChunkBytes` | 8,220,000 → **6,863,614** | tighten-only, to the row's own stated rule: observed 6,355,198 × 1.08. The old ceiling carried 29.3% headroom against a note that said 8%. `approvedDeviation` untouched |
| `gateway/backup/year3` snapshot | 998.7 / 1050.2 / **1056.3** ms over three runs; ceiling 3,200 ms | `node node_modules/vitest/vitest.mjs run --config vitest.perf.config.ts tests/perf/backup-restore.perf.test.ts`, linux x64 container 4 cores / 15 GB (shared), 2026-09-05; golden year-3 `vault.db` = 105,603,072 B |
| `gateway/restore/year3` restore | 1640.4 / 1678.7 / **1712.3** ms over three runs; ceiling 5,200 ms | same run. Restore costs ~1.6× its own backup |
| work counters over both calls | statements 0, and that zero is the gate | same run |

**Deleted:** nothing here. The four backup rigs the rig diet removed now have their successor, which is the replacement half of that deletion.

**Decisions.** (1) `_folded_into` is a marker, not a deletion: the grid check requires an entry per surface × journey, so a folded row stays and points at the sibling that owns the fact. (2) The two new rows are `measured` rather than `unmeasured` — the measurement ran here, three samples, and the ceiling is ~3× the slowest, the same convention every other single-host row uses. (3) `gateway/restore/year3-10gib/dev-darwin-arm64` is **not** superseded: it is the byte axis, the new row is the row axis.

### Verification

```sh
bun run lint:journey-ledger
bun run test:ratchet
node node_modules/vitest/vitest.mjs run --config vitest.perf.config.ts tests/perf/backup-restore.perf.test.ts
npx tsc -p tests
```

**Findings.** (1) **Naming a consumer is not the same as being measured, and the ledger cannot tell the two apart.** Fifteen of the eighteen now name the harness that OWNS the journey while the metric stays `unmeasured` — which is the ledger's existing convention (`web/own-echo`, `desktop/own-echo`, `mobile/own-echo` all shipped that way) but is one rung weaker than "a reader that asserts this ceiling". Box 4's clause is satisfied as written; a stronger clause would ask the linter to require a consumer that actually resolves the metric, and that is a #927 follow-up worth its own issue. (2) The `maxTotalBytes` ceiling on the same `mobile/app-weight` row carries 8.4% against the stated 8% (it is 12 MiB exactly). Left alone: the brief names the largest-chunk ceiling, and 0.4% is a rounding to a power of two, not a drift.

**Doc debt:** none.

### Falsification

| Claim | Throwaway check | Result |
| --- | --- | --- |
| "the work counters are the gate for backup" — a gate that always reads zero fences nothing | read `packages/vault/src/gateway/work-counters.ts`: the counters are bumped from the instrumented statement layer, which only wraps handles passed to `instrumentVaultStatements` | the zero is real AND load-bearing: `createSnapshot`/`restoreSnapshot` move files and never open the vault, so any future version that starts querying rows to decide what to copy flips the integer on its first run. Stated in the rig's own comment rather than left to be rediscovered |
| "tightening `maxLargestChunkBytes` is safe" — a ceiling below the real artifact reds the mobile-smoke job | recomputed from the row's own `_provenance`: 6,355,198 × 1.08 = 6,863,613.84, and the observed value is 6,355,198 | the new ceiling is 8% above the last observed chunk and 1.36 MB below the old one; the ratchet accepted it as a tighten (`test:ratchet` green). The risk it leaves is a *real* future growth failing sooner, which is the point of a budget |

## Follow-up — #927 close (the two high-severity advisories)

GitHub reports two high-severity Dependabot alerts on the default branch. They are **one advisory against one package in two manifests**: `pdfjs-dist` 6.1.200, declared directly by `packages/blueprints` and `packages/client`.

| Advisory | Package | Vulnerable | Fixed in | Was | Now |
| --- | --- | --- | --- | --- | --- |
| [GHSA-hq66-cqwq-w95j](https://github.com/advisories/GHSA-hq66-cqwq-w95j) — PDF.js: arbitrary JavaScript execution upon opening a malicious PDF | `pdfjs-dist` | `>=5.6.83 <6.2.108` | 6.2.108 | 6.1.200 (×2 manifests) | **6.2.108** |

The bump is the smallest one that clears it: 6.2.108, not the newest 6.3.289. The lockfile was regenerated by `bun install`, never hand-edited — one package installed, three lines of `bun.lock`.

### Files

| File | Change |
| --- | --- |
| `packages/blueprints/package.json`, `packages/client/package.json` | `pdfjs-dist` 6.1.200 → 6.2.108 |
| `bun.lock` | regenerated by `bun install` |
| `packages/blueprints/src/docs-media.test.ts` | the pinned runtime version, which the file's own comment says to "bump in lockstep with the `pdfjs-dist` dependency" |

### Numbers

| Measurement | Before | After | Provenance |
| --- | --- | --- | --- |
| `bun audit` findings naming `pdfjs-dist` | 1 high | **0** | `bun audit`, this tree, 2026-09-05 |
| total `bun audit` findings | 72 (32 high, 35 moderate, 5 low) | 71 (31 high, 35 moderate, 5 low) | same runs |

**Decisions.** Only `pdfjs-dist` is bumped. The other 31 highs `bun audit` reports are TRANSITIVE — `brace-expansion`, `undici`, `ws`, `image-size`, `browserslist`, `fast-uri`, all beneath `expo`, `react-native`, `electron-builder`, `wrangler` or `@stryker-mutator/core`. None is a direct manifest entry, none can be fixed without moving a framework major, and none is what Dependabot alerts on. Forcing them through overrides would be a framework migration wearing a security bump's clothes, and this lane is not that change. This is recorded as a finding, not fixed quietly.

### Verification

```sh
bun audit                                  # no pdfjs-dist finding
bun install                                # lockfile regenerated, not hand-edited
bun run build                              # 13/13 tasks
bun run --cwd packages/blueprints test     # 7065 passed, 2 expected fail
bun run --cwd packages/client test src/device-enrichment
```

**Findings.** (1) **31 high-severity transitive advisories remain**, every one of them under `expo`/`react-native`/`electron-builder`/`wrangler`/`@stryker-mutator/core`. The repo's own policy already says why they are not a gate — `SECURITY.md`'s table: OSV-Scanner fails on CRITICAL only, HIGH is logged, and dependency-review blocks new HIGH on a PR diff. That is a defensible line for a transitive DoS, and a bad one to discover only from a receipt: the toolchain doc names no command for a framework-major security bump, so today there is no written answer to "a HIGH lands in `react-native`'s tree — then what". Worth an issue. (2) `docs/toolchain.md` documents no dependency-bump or lockfile-regeneration procedure at all; `bun install` after editing the manifest is the de facto one, inferred here from `G-turbo-floor-waiver`'s list of global-hash inputs rather than from any instruction.

**Doc debt:** `docs/toolchain.md` — no section on dependency bumps or lockfile regeneration, which this slice needed and had to infer. This lane's brief does not own that doc.

### Falsification

| Claim | Throwaway check | Result |
| --- | --- | --- |
| "the two GitHub alerts are `pdfjs-dist`" — `bun audit` reports 32 highs, so picking two is a guess | cross-walked every `high:` finding against the DIRECT dependency set parsed out of every workspace `package.json` | exactly one package matched — `pdfjs-dist`, declared in two manifests, which is why Dependabot counts two alerts. Every other high is transitive, and Dependabot's default-branch alerts are per manifest entry |
| "bumping a PDF runtime is behaviour-neutral" | ran `packages/blueprints`'s full suite and the two files that import it | one red, and it was the RIGHT one: `docs-media.test.ts` pins the runtime's version on purpose "to prove the real client-bundled runtime loaded rather than a stub", with a comment saying to bump it in lockstep. Pin updated; 7065 passed |
