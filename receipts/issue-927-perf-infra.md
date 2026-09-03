# issue-927 — perf and scale infrastructure reimagined

Umbrella receipt for [#927](https://github.com/srikanth235/centraid/issues/927). One receipt for the whole umbrella; each slice appends one `## <wave><slice> — <title>` section with its own evidence and audit. The checklist below mirrors the issue's acceptance criteria and is ticked only by the root, from the evidence in the appended sections.

## Checklist

- [ ] A developer can run one command that opens each of the eight apps against the golden vault and prints a span waterfall against the last candidate baseline, in under a minute for in-process journeys
- [ ] The per-PR perf gate is a work-counter comparison: deterministic, no retry step, no history required; a seeded extra statement or fsync on a hot path fails it on the first run
- [ ] The candidate rung runs paired candidate/PR journeys and fails a seeded 20% slow-down with a stated confidence on its first run, with no 30-sample warm-up
- [ ] One ledger keyed `surface × journey × volume × hardware` replaces the five budget files, the rig register and the query-count file; every entry names its spans and its consumer; no rig reads the old files
- [ ] The nine journeys have `measured` entries at year-3 volume on web, desktop and gateway, and on a real Android and iOS device for the mobile rows; `"volume": "empty"` appears in no journey entry
- [ ] Perf history lives in the gh-pages test-report beside the candidate history; nothing perf-related is stored in an actions cache
- [ ] The device rung exists as a lane; the parked mobile lanes are unparked onto it or deleted with the reason recorded
- [ ] `docs/decisions.md` § Performance names the journey ledger as the gate for the five evidence-gated designs
- [ ] Every #922 receipt from its wave 2 onward cites before/after numbers from this ledger

## What changed

Nothing yet at the umbrella level — the first slice's changes are in its own section below. This heading exists because `receipt-per-issue` requires it on the file that creates the receipt; every subsequent slice appends rather than rewrites.

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
| 2026-09-03 | claude-code | 60f9e86b-149f-5fc9-84c0-f2160b6b6f3c |
