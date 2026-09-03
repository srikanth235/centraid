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
