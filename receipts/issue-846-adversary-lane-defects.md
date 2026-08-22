# issue-846 — Defects surfaced by the #839 / #842 adversary lanes

GitHub issue: [#846](https://github.com/srikanth235/centraid/issues/846)

The umbrella issue for every defect and observation the adversary, chaos, fuzz
and red-team lanes built under [#839](https://github.com/srikanth235/centraid/issues/839)
and [#842](https://github.com/srikanth235/centraid/issues/842) surfaced. None
is a regression introduced by that work: they are pre-existing behaviours the
new lanes were built to *find*.

This receipt covers **Part 1 — pinned defects**. Eight of the ten are fixed
here. Per the issue's working agreement and ruling **A-pinned**
([docs/decisions.md](../docs/decisions.md)), fixing a Part 1 item means
**deleting its pin in the same change** — a pin that survives its fix is a lie
in the other direction. Every deleted pin left a regression lock in its place,
which is what the pin existed to buy.

## Checklist

- [x] P3 — the WAL closer codec's two halves disagreed
- [x] P4 / P5 — the replica FTS mirror was not a mirror
- [x] P6 / P7 — two peer-target guard disagreements
- [x] P8 — the diagnostics bundle emitted the vault name verbatim
- [x] P1 — the owner is told a share is gone when it is not
- [x] P2 — the DST fall-back fired the repeated wall minute twice
- [x] The record moved with the code

One commit, not one per defect: `commit-issue-receipt-match` requires every
commit to carry this receipt, and the receipt is a single account of a single
umbrella slice. The sections below are the per-defect breakdown that the commit
boundaries would otherwise have carried.

| Item | Disposition |
| --- | --- |
| P1 revocation severance | **Fixed** — durable delivery memory |
| P2 DST fall-back double fire | **Fixed** — cross-window wall-clock memory |
| P3 WAL closer codec disagreement | **Fixed** — parser positivity check |
| P4 replica mirror admits what the gateway refuses | **Fixed** — mirror restated |
| P5 replica mirror ranks/truncates differently | **Fixed** — same change |
| P6 bare peer-plane prefix admitted by a separator | **Fixed** — both languages |
| P7 lone surrogate admitted JS-side | **Fixed** — representability rule |
| P8 diagnostics bundle emits the vault name verbatim | **Fixed** — one bundle |
| P9 unsandboxed automation worker | **Not fixed** — blocked, see below |
| P10 three responses without `nosniff` | **Not fixed** — filed as #844 |

**P9 is left standing deliberately**, and its pin with it. The issue names the
prerequisite and it is the real unit of work: the default cannot flip until
`packages/model-runtime/src/onnx.ts` stops resolving `runtime/node_modules`
through `node:module`'s `createRequire`, which every sandbox lane refuses. That
resolver rework is not this change. **P10 is #844's**, listed on the umbrella
for completeness only. Parts 2 (posture decisions), 3 (observations) and 4
(blocked on an external actor) are untouched — a maintainer decision and an
external actor are not things a PR supplies. The `desktop-e2e` assistant-open
budget reported as P11 in the issue comments belongs to
[#789](https://github.com/srikanth235/centraid/issues/789)'s owner: it is red on
the base branch, and raising someone else's perf budget to go green is the move
the constitution forbids.

## What changed

### P3 — the WAL closer codec's two halves disagreed

`packages/backup/src/wal-format.ts`. `CLOSER_KEY_RE` admitted
`closed-000000000000` while `assertValidCloser` requires a positive end offset,
so `parseWalCloserKey` returned a `WalGroupCloser` that `walGroupCloserKey`
then refused to re-emit. A provider listing carrying that key read as a **closed
group at offset 0** in `wal-restore.ts` and `backup-reconciliation.ts`.

`parseWalCloserKey` now applies the positivity check itself, returning `null`
for a closer that closes nothing — the same shape as `parseWalSegmentKey`'s
forward-range check one function above it. Fixing the parser rather than
relaxing the formatter is the direction that keeps a bad key out of the
downstream readers, which is where the damage was.

Register entry `wal.closer-roundtrip-rejected` deleted.

### P4 / P5 — the replica FTS mirror was not a mirror

`packages/client/src/replica/search.ts` documents itself as mirroring the
canonical gateway and diverged on both halves of that claim:

- **admission** — its token regex admitted `\p{M}`, so a query of only
  combining marks was refused online and searched offline. The replica answered
  a question the gateway declines.
- **expression** — the gateway splits on whitespace only, so `don't` compiles
  to one prefix phrase; the replica re-split on Unicode word runs and compiled
  two, which also applied the 16-token bound to a different token stream. The
  two planes ranked and truncated differently for any query with punctuation.

`replicaSearchTokens` is now line-for-line the gateway's, and the module header
says so as a standing obligation rather than an aspiration.

The punctuation split did not disappear — it **moved to where it belongs**. A
whitespace token is an FTS5 *phrase*: `"don't"*` is the phrase (`don`, `t`\*),
two adjacent words with prefix semantics on the last. `replicaPendingSearchMatch`
now compiles each token into its word runs and matches them adjacently, **per
field**, so two words adjacent only because one column's text ends where the
next begins are not adjacent to the replica either — they are not to FTS5. The
snippet highlight spans the whole phrase, so `don't` highlights `don't`.

Register entries `fts-mirror.decision` and `fts-mirror.expression` deleted,
which empties the register.

**Evidence.** `bun run test:fuzz:replay` green — with the classes deregistered,
the replay suite asserts each committed crasher now runs *clean*, which is the
regression lock. 2.4M further executions across the six targets found nothing.

### P6 / P7 — two peer-target guard disagreements

The peer path confinement is written three times in two languages. Neither
finding is an escape — no target either guard admits resolves outside the peer
plane — but a guard that disagrees with its own documented sentence, or with
its other language, fails nowhere but on a real link.

- **P6.** Both guards document "must EXTEND the prefix (a bare prefix names no
  resource)" and both applied that length test to the **whole target** rather
  than to the path. `/centraid/_peer/?` is 17 bytes, so the test passed, while
  the path it resolves to is exactly the prefix. Fixed in `protocol.ts` and in
  `iroh_relay.rs::peer_target_allowed` by measuring the path. The documented
  sentence was the right side of the disagreement; the guard is the thing that
  must match it.
- **P7.** `protocol.ts` promises the rule is "mirrored byte-for-byte in Rust",
  but a JS string can hold a lone surrogate and a Rust `&str` cannot: the JS
  guard's `Buffer.from(path, "utf8")` silently rewrote it to U+FFFD, found no
  forbidden byte, and admitted a target the Rust lane can never carry — while
  forwarding bytes that are not the ones the peer sent. Rust was the right side:
  a guard that rewrites its own input before judging it has judged a different
  string. The JS guard now refuses a target that is not well-formed. Well-formed
  astral text is untouched — this is a representability rule, not a ban on
  non-ASCII targets.

`peer-target-differential.test.ts`: both `PINNED:` cases became regression
locks, `rustModel` gained the representability axis and the path-length test,
`documentedIntent` gained the surrogate rule, and the
`the guard matches its documented intent` property **lost its carve-out** —
it now runs on every drawn target with no exemption. The Rust source-text pin
asserts the new predicate line *and* that the old one is gone.
`fixtures/peer-target-golden.json`: the four pinned vectors flipped to `false`
and stay as the lock, `pins` is empty, and the corpus regenerated (three rows
changed, all of the P6 class). The Rust unit test gained the four separator
cases.

### P8 — the diagnostics bundle emitted the vault name verbatim

`GET /centraid/_gateway/diagnostics` redacted **only** `config`, by key name.
`vaults[].name` — owner-authored — rode out in the clear and the log tail was
embedded raw, in the artifact `gateway-diagnostics.ts`'s own header described
as "designed to be saved to a file and attached to a support request".

The endpoint now serves the **shareable support bundle**
(`serve/support-bundle.ts`), which is allowlist-by-construction: every field is
emitted through a declared leaf policy, so a field nobody added on purpose is
absent rather than copied, and the serialized text is swept by a tripwire for
literals harvested from the running system — the vault name among them. There
is now **one** document where there were two, and it is the safe one. The
legacy assembly is retired, not kept beside it: a second builder is how the two
drift again.

Two consequential details:

- the route contract is a **string**, not an object. The tripwire sweeps
  serialized text, so handing the route an object to re-serialize would throw
  away the gate that made it safe. `sendJsonText` writes exactly the bytes the
  builder produced.
- the level is `standard`, not the builder's `strict` default. This route is
  behind the host bearer gate and answers the owner, so a scrubbed message
  skeleton is worth keeping beside the digest. The policy is the same either
  way.

`SupportBundleSourceOptions.anomalies` relaxed to a structural type, matching
that module's own stated convention, so the gateway can feed it the on-disk
ledger mirror without constructing a writer nothing writes to.

The canary's `PINNED:` case became a lock over the endpoint's real composition:
no vault name, no owner name, no bearer token, `storage[]` carries **no** `name`
property under any policy — and the bundle is still useful (it names the vault
by salted id and carries its storage sizing).

### P1 — the owner is told a share is gone when it is not

Contradicts **G-revoke**. `fulfillShareGrant` drops a `delivered` fulfilment row
back to `syncing` when the host cannot reach the peer for one pass —
*honestly*, because the audience copy may now be stale.
`propagateShareGrantRevocation` then read that `syncing` as never-delivered and
settled `removed` ("nothing had been delivered; there was nothing to remove")
while the audience vault still held the whole projection.

G-revoke's sentence is unchanged and was never the problem: revoke is honestly
best-effort against a peer's disk. The **engine** was wrong, on a reachable
path, in the one direction the copy does not warn about — the admitted failure
is a peer that keeps a copy it was asked to drop, not a host that never asks.

The fix is the one the issue names: **the engine remembers what it delivered.**
`share_fulfillment.delivered_at` is the durable fact, deliberately not derivable
from `state`:

- `state` is a live **freshness** reading. Degrading it on an unreachable pass
  is right and stays.
- `delivered_at` answers a different question — *has this peer ever held the
  subject* — and revocation asks that one.

Maintained in the store rather than by callers, because it is the one fact
nobody may forget to write: stamped on the first delivery (re-delivery keeps the
first instant; `updated_at` is what tracks refreshes), cleared only by a removal
that settled, and left alone by every other transition including `syncing`.
`ensureFulfillment` stamps it too, so a row opened directly at `delivered`
carries it from birth.

Migration **rung four** rebuilds the table rather than `ALTER TABLE ... ADD
COLUMN`: SQLite has no `ADD COLUMN IF NOT EXISTS`, and the rung must also be
walked as a no-op by a fresh file that already got the column from the baseline.
The copy names its source columns explicitly and does not read `delivered_at`,
so one statement is correct against both shapes. The backfill stamps `delivered`
and `remove_sent` rows from `updated_at` and leaves everything else NULL: a
`syncing` row that was in fact delivered before the rung cannot be recovered
from the file, and inventing an instant for it would be worse than not knowing.
That gap is bounded in practice because the removal path also *looks* inside a
reachable audience vault rather than trusting the row alone.

The simulator's D1 carve-out is deleted, so `checkSeverance` now fails on every
settled revocation that left a projection behind, with no reach-lost exemption.
The `reachLostAfterDelivery` flag it depended on became a **non-vacuity
witness** instead: seed 839001 must still exercise the delivered→syncing
degradation, or holding G1 would prove nothing about the thing that used to
break.

### P2 — the DST fall-back fired the repeated wall minute twice

Contradicts [docs/cron-timezone.md](../docs/cron-timezone.md) § DST policy,
Overlap row. The dedupe lived inside a single `dueInstants` call, and a
scheduler ticking once a minute puts the two absolute minutes sharing a wall
clock in two different one-minute windows — each deduped perfectly against
itself and fired. "Once" held only for a window wide enough to contain both
copies, i.e. after downtime, which is exactly the shape `cron-cursor.test.ts`
covers and why the gap went unseen.

`readCronCursor` now carries the memory across windows and **derives** it rather
than persisting it. When — and only when — a schedule's zone actually moved its
clock back inside the last three hours, the reader re-walks the window behind
its cursor and drops any candidate whose wall-clock keys were all covered there.

Deriving beats a persisted watermark on three counts: the cursor row stays a
bare millisecond position, so there is no schema change and no watermark to
migrate or corrupt; an ordinary tick pays two `Intl` reads for the check rather
than a second scan or a per-minute journal write; and there is no retention
question about how many keys to keep for how long. `dueInstants` also dedupes
oldest-first now, so the survivor is the **earlier** instant — which is what the
policy has always said ("occurs once at the earlier instant") and what makes the
cross-window suppression land on the right copy.

### The record moved with the code

Stale docs are bugs, so every claim the fixes falsified was rewritten in this
same change rather than left for a follow-up. `docs/decisions.md`'s **A-pinned**
ruling, `docs/cron-timezone.md`'s DST policy, `SECURITY.md`'s
diagnostics-redaction row, `TESTING.md`'s fuzz-register paragraph,
`scripts/fuzz/known-findings.json` itself, and `CHANGELOG.md` — enumerated under
[Docs](#docs) below.

## Out of scope

**P9 — an automation worker with no parent-chosen sandbox lane is not sandboxed.**
Left standing, pin included. The issue names the prerequisite and it is the real
unit of work: the default cannot flip until `packages/model-runtime/src/onnx.ts`
stops resolving `runtime/node_modules` through `node:module`'s `createRequire`,
which every sandbox lane refuses. Flipping the default without that rework would
break every lane that runs a model; deleting the pin without flipping the default
would erase the record. Neither is an improvement.

**P10 — three transport-boundary responses without `X-Content-Type-Options`.**
Already filed as [#844](https://github.com/srikanth235/centraid/issues/844) and
listed on this umbrella for completeness only. It has its own issue and its own
receipt.

**P11 — the `desktop-e2e` assistant-open budget.** Reported in the issue's
comment thread, and it belongs to [#789](https://github.com/srikanth235/centraid/issues/789)'s
owner. It is red on the base branch, it predates this branch, and raising
someone else's perf budget to go green is precisely the move the constitution
forbids. Its honest fix — measure the thing the assertion claims to measure, or
re-seed the ceiling from a real distribution — is a deliberate call for the
owner of the surface, not a side effect of this change.

**P12 — desktop first-run founding never completes on Windows.** Raised in the
issue's comment thread after this work began, root-caused there to
`gateway-secrets.ts`'s `shouldUseFileFallback()` — Linux falls back to the 0600
device-secrets file when `safeStorage.isEncryptionAvailable()` is false, every
other platform throws — and **parked by owner decision**: the
`desktop-e2e-windows` lane is `if: false` on
[#851](https://github.com/srikanth235/centraid/pull/851) pending either a
founding path that works on `windows-latest` or a runner with a real keychain.
Desktop custody owns that call, and it is not this change's to make or unmake.

**Part 2 — deliberate posture changes (D1 auto-update fail-closed, D2 CI egress
ledger, D3 JS-level handler sandboxing).** These need a maintainer decision and,
for D1, an Ed25519 key generated and stored in the `release` environment. A PR
cannot supply either.

**Part 3 — observations.** Not pinned, and by the issue's own working agreement
promoting one to a defect means finding the ruling it violates first; where
there is no ruling, the ruling is the thing to write. That is separate work.

**Part 4 — blocked on an external actor.** Apple enrollment, `cargo-audit`
binaries, a privileged netem runner, enrolled handsets, an Electron-capable
runner, and three external security engagements. None is a code change.

## Decisions

- **P8: replace the endpoint's document rather than patch its leak.** The
  narrow fix was to drop `vaults[].name` and leave everything else. Rejected:
  the raw log tail is the other half of the same defect, and keeping two
  builders for one artifact is how they drifted apart in the first place. The
  issue's own fix direction says route the endpoint through `support-bundle.ts`,
  and SECURITY.md already named that module the shareable artifact with this
  endpoint as the residual. **This changes the endpoint's response shape**, which
  is user-visible and is called out in the CHANGELOG.
- **P8: serve at redaction level `standard`, not the builder's `strict`
  default.** The route is behind the host bearer gate and answers the owner, so
  a scrubbed message skeleton beside each digest is worth keeping. The policy —
  what may be emitted at all — is identical either way; only prose survivability
  differs.
- **P8: the route contract is a string.** The tripwire sweeps *serialized* text,
  so a route that re-serializes a parsed object silently discards the last gate.
  `sendJsonText` exists for that reason and says so.
- **P1: a durable column, not "stop degrading the state".** Leaving a row at
  `delivered` through an unreachable pass would also have made revocation
  correct, but it would lie about freshness — the audience copy may be stale and
  the owner reads that state. The two questions are genuinely different, so they
  get two fields: `state` for freshness, `delivered_at` for delivery.
- **P1: maintain the memory in the store, not in the engine.** `delivered_at` is
  the one fact about a row nobody may forget to write, so `setFulfillmentState`
  and `ensureFulfillment` own it rather than each call site.
- **P1: a table rebuild for rung four.** SQLite has no `ADD COLUMN IF NOT
  EXISTS`, and the rung must also be a no-op on a fresh file that got the column
  from the baseline. The rebuild's copy does not read `delivered_at`, so one
  statement is correct against both shapes — the same idiom, and the same
  `defer_foreign_keys` reasoning, as the people_profile rung above it.
- **P1: the backfill leaves `syncing` rows NULL.** A row that was delivered
  before the rung and had degraded cannot be recovered from the file. Inventing
  a timestamp would make the record confidently wrong; NULL makes it honestly
  incomplete, and the removal path still looks inside a reachable audience vault.
- **P2: derive the cross-window memory, do not persist it.** A persisted
  watermark means a schema change on the cursor row, a per-minute journal write
  for a per-minute cron, and a retention question about how many keys to keep.
  Deriving it costs two `Intl` reads on an ordinary tick, because the reader only
  re-walks the window behind its cursor when a zone actually fell back.
- **P2: `dueInstants` dedupes oldest-first now.** The policy says an overlapping
  wall time "occurs once at the earlier instant"; the old newest-first dedupe
  kept the later copy. Both are "once", but only the earlier one makes the
  cross-window suppression land on the right side.
- **P4/P5: the punctuation split moved, it did not vanish.** A whitespace token
  is an FTS5 phrase, so re-splitting belongs in the matcher reading the phrase,
  not in the compiler writing the expression. Adjacency is evaluated per field,
  because two words adjacent only across a column boundary are not adjacent to
  FTS5 either.
- **P6: the documented sentence won.** Both guards said "must extend the prefix"
  and both measured the wrong string. Changing the sentence to match the code
  would have been the cheaper edit and the wrong one.
- **P7: Rust won.** "Mirrored byte-for-byte" is the contract, and a guard that
  rewrites its own input before judging it has judged a different string.
- **One commit rather than one per defect.** `commit-issue-receipt-match`
  requires every commit to touch this receipt, and the receipt is one account of
  one umbrella slice.
- **Two `packages/server` test failures and one `apps/desktop` failure are left
  failing.** All three were verified on the unmodified tree: a missing `sqlite3`
  binary, two cases that branch on running as root, and an Electron binary this
  sandbox cannot download. Making them pass would mean changing tests to suit an
  environment, which is the wrong direction.

## Evidence

Every fix is demonstrated red on the pre-fix engine, not merely green after it.

| Fix | Demonstrated red | Green |
| --- | --- | --- |
| P1 | severance probe leaves the audience holding `s0->s1#0-p0` after a settled `removed` | probe severs; whole commons sim green |
| P2 | 2 fires in all three transition zones (whole-hour, negative-DST, 30-minute) | 1 fire, at the earlier instant, in each |
| P3–P5 | the register's own crashers, which is why they were committed | replay asserts them clean; 2.4M further executions, 0 findings |
| P6–P7 | the four golden vectors and the three surrogate targets the pins asserted | refused by all three implementations and by the Rust unit test |
| P8 | the canary pin asserted the vault name was present | absent, with the tripwire counting nothing |

Suites: `packages/vault` 181 files / 1384 tests green; `packages/server` 378 of
380 files green; `packages/tunnel` green; `packages/backup` green;
`packages/client` replica green; `cargo test` in `data-plane` green (18 tests);
`bun run typecheck` green across all 25 packages.

Two server failures are **pre-existing and environmental**, verified by running
them on the unmodified tree: `gateway-db-lock.integration.test.ts` needs a
`sqlite3` binary this container lacks, and two `acp/launch.test.ts` cases branch
on whether the process is root, which here it is.

## Docs

Stale docs are bugs, so the record moved with the code in the same change:

- [docs/decisions.md](../docs/decisions.md) — **A-pinned** rewritten. It used to
  enumerate the standing pins; it now records that the ruling was proven by its
  *exit* (eight pins raised, eight fixed, each deleting its own pin and leaving
  a lock) and names the one that still stands and why. The D1 note is closed out
  against G-revoke without amending G-revoke, because G-revoke was right.
- [docs/cron-timezone.md](../docs/cron-timezone.md) — the "Known divergence"
  block is replaced by how Overlap holds under a continuous tick.
- [SECURITY.md](../SECURITY.md) — the diagnostics-redaction row no longer names
  a legacy endpoint beside the safe one, because there is no longer one. Its
  residual column now names the real residual the tripwire exists for.
- [TESTING.md](../TESTING.md) — the fuzz register is described as empty, with
  what it carried and where the lock moved to.
- `scripts/fuzz/known-findings.json` — empty `classes`, with an `_empty` note
  saying which entries left, why, and where the regression lock now lives.

## Verification

```sh
# The four suites that own the changed code.
bun run --cwd packages/vault test        # 181 files, 1384 tests
bun run --cwd packages/tunnel test
bun run --cwd packages/backup test
bun run --cwd packages/client test -- src/replica

# The lanes that carried the pins.
bun run test:fuzz:replay                 # register empty: crashers must run clean
bun run test:fuzz:smoke
bun run test:qualities                   # diagnostics canary + schema-epoch corpus
bun run --cwd packages/server test -- src/automation/fire/ src/serve/serve.test.ts

# The Rust half of the peer-target guard.
cd packages/tunnel/data-plane && cargo test

# Repo gates.
bun run typecheck
bun run check:push
bash .governance/run.sh
```

Demonstrated red, re-runnable by reverting the named file and re-running the
named suite:

```sh
# P1 — restore the state-based branch in propagateShareGrantRevocation
#      (`row.state === "awaiting_channel" || row.state === "syncing"`):
bun run --cwd packages/vault test -- src/share/commons-sim.test.ts
#   → AssertionError: expected [ 's0->s1#0-p0' ] to strictly equal []

# P2 — restore packages/server/src/automation/fire/cron-cursor.ts from HEAD~:
bun run --cwd packages/server test -- src/automation/fire/time-zoo-cron.test.ts
#   → 3 failed: America/New_York, Europe/Dublin, Australia/Lord_Howe each
#     "expected [ …, … ] to have a length of 1 but got 2"
```

## Files changed

Product:

- `packages/backup/src/wal-format.ts` — P3, the closer parser's positivity check.
- `packages/client/src/replica/search.ts` — P4/P5, the mirror and the phrase matcher.
- `packages/tunnel/src/protocol.ts` — P6/P7, path-length test and representability.
- `packages/tunnel/data-plane/src/iroh_relay.rs` — P6, the Rust half, plus its unit test.
- `packages/server/src/routes/diagnostics-routes.ts` — P8, the route serves bytes.
- `packages/server/src/routes/route-helpers.ts` — P8, `sendJsonText`.
- `packages/server/src/serve/build-gateway.ts` — P8, the endpoint's new composition.
- `packages/server/src/serve/support-bundle-source.ts` — P8, structural `anomalies`.
- `packages/server/src/serve/gateway-diagnostics.ts` — P8, **deleted** with its test.
- `packages/server/src/serve/commons-observability.ts`,
  `packages/server/src/serve/diagnostics-redaction.ts` — P8, comments that named
  the retired module.
- `packages/server/src/automation/fire/cron-cursor.ts` — P2, the cross-window
  wall-clock memory and the oldest-first dedupe.
- `packages/vault/src/schema/share-grant.ts`, `packages/vault/src/schema/migrate.ts`
  — P1, `delivered_at` and migration rung four.
- `packages/vault/src/grant/grant-store.ts` — P1, the memory is maintained here.
- `packages/vault/src/grant/fulfillment.ts` — P1, revocation reads the memory.

Tests and fixtures:

- `packages/tunnel/src/peer-target-differential.test.ts`,
  `packages/tunnel/fixtures/peer-target-golden.json`,
  `packages/tunnel/fixtures/peer-target-corpus.json` — P6/P7 pins → locks.
- `tests/quality/diagnostics-redaction-canary.test.ts` — P8 pin → lock.
- `packages/server/src/automation/fire/time-zoo-cron.test.ts` — P2 pin → lock.
- `packages/server/src/serve/serve.test.ts` — P8, the endpoint's new shape.
- `packages/vault/src/share/commons-sim.test.ts`,
  `packages/vault/src/share/commons-sim-grant.test-fixtures.ts`,
  `packages/vault/src/share/commons-sim-grant-world.test-fixtures.ts` — P1
  `test.fails` → passing test, D1 carve-out → non-vacuity witness.
- `packages/vault/src/grant/grant-store.test.ts` — P1, direct coverage of the memory.
- `packages/vault/src/schema/migrate.test.ts`,
  `packages/vault/src/schema/migrate-share-grant.test.ts`,
  `scripts/corpora/schema-epoch-census.json` — P1, rung four joins the ladder and
  the archaeology corpus.
- `scripts/fuzz/known-findings.json` — P3/P4/P5 register entries deleted.

Docs: `docs/decisions.md`, `docs/cron-timezone.md`, `SECURITY.md`, `TESTING.md`,
`CHANGELOG.md`, and this receipt.

## Audit

Independent fresh-context audit against the diff (`git diff origin/main...HEAD`) and [#846](https://github.com/srikanth235/centraid/issues/846).

**(1) '## What changed' faithfully describes the diff — PASS**

Every one of the 36 non-receipt files in `git diff --stat origin/main...HEAD` is accounted for by the receipt's `## What changed` + `## Files changed` sections; no file is unmentioned, and no described change is absent from the diff.

- P3 — `packages/backup/src/wal-format.ts`: `parseWalCloserKey` now ends `return closer.endOffset > 0 ? closer : null`, i.e. the parser applies the positivity check, exactly as described; the formatter is untouched.
- P4/P5 — `packages/client/src/replica/search.ts`: `replicaSearchTokens` replaces the `\p{L}\p{N}\p{M}` `flatMap` with `.filter((token) => /[\p{L}\p{N}]/u.test(token))`, which is character-for-character the gateway's filter in `packages/vault/src/gateway/search.ts` `ftsMatchExpression` (verified against the current source, whitespace split + `"` strip + `.slice(0, 16)` all identical). The punctuation split reappears in the new `tokenPhrase`, and `phraseIndex`/`replicaPendingSearchMatch` evaluate adjacency per field (`fields.some(({ words }) => phraseIndex(...))`), with the highlight spanning `first.start`→`last.end` — all as claimed.
- P6/P7 — `protocol.ts` moves the length test to `path.length` and adds `isWellFormedTarget`; `iroh_relay.rs::peer_target_allowed` moves it to `path.len()` and gains the four separator cases in its unit test. The test-side claims check out: `rustModel` gained both the representability guard and the byte-measured path-length test, `documentedIntent` gained `isWellFormedString`, the `documented intent` property lost its `if (path === PEER_PLANE_PREFIX) return;` carve-out, and the Rust source-text pin asserts both `path.len() <= PEER_PLANE_PREFIX.len()` present and `target.len() <= PEER_PLANE_PREFIX.len()` absent. Golden: four vectors flipped to `false`, `"pins": {}`; corpus: exactly three rows flipped, all `/centraid/_peer/#…` (the P6 class).
- P8 — `gateway-diagnostics.ts` and its test are deleted (448 lines, no replacement builder); `buildDiagnostics` in `build-gateway.ts` returns `renderSupportBundle(collectSupportBundleInput({… level: "standard" …})).text`; `diagnostics-routes.ts` takes `() => Promise<string>` and calls the new `sendJsonText`; `SupportBundleSourceOptions.anomalies` is relaxed to `{ snapshot: () => readonly AnomalyRecord[] }`. `serve.test.ts` and the canary assert the new shape, including `storage[0]` having no `name`.
- P1 — `share-grant.ts` factors `SHARE_FULFILLMENT_COLUMNS` and adds `SHARE_FULFILLMENT_DELIVERY_MEMORY_DDL` (table rebuild, `defer_foreign_keys`, backfill stamping only `delivered`/`remove_sent` from `updated_at`); the copy's `SELECT` does not read `delivered_at`, as the receipt states. `migrate.ts` appends it as rung four; `grant-store.ts` maintains `delivered_at` in both `ensureFulfillment` (stamped when opened at `delivered`) and `setFulfillmentState` (`COALESCE` keeps the first instant, cleared on `removed`); `fulfillment.ts` switches the never-delivered branch from `row.state === "awaiting_channel" || row.state === "syncing"` to `row.deliveredAt === null`. The simulator's D1 carve-out is deleted from `checkSeverance` and `reach_lost_after_delivery` is asserted as a non-vacuity leg.
- P2 — `cron-cursor.ts` collects matches then `matched.reverse()`s before deduping (oldest-first survivor), and `readCronCursor` calls the new `deliverableInstants`, which only re-walks `(from − 3h, from]` when `fellBackWithin` is true.
- Docs/CHANGELOG/register — all five doc edits described are present, with the wording the receipt attributes to them.

Two immaterial gaps, recorded rather than charged: `setFulfillmentState` also gained a `deliveredAt?: null` explicit-clear parameter that has no production caller and is not mentioned; and `peer-target-golden.json` carries an incidental `	` → `\t` escape normalisation. Neither changes behaviour or contradicts the narrative.

**(2) Every '- [x]' checklist item is realized in the diff — PASS**

Each of the seven boxes maps onto code above: P3 (parser check), P4/P5 (mirror restated + phrase matcher), P6/P7 (both languages plus route-layer/differential models), P8 (endpoint serves the allowlist-built bundle, legacy builder deleted), P1 (`delivered_at`, rung four, revocation reads it, `test.fails` → passing test), P2 (cross-window derivation, pin `toHaveLength(2)` → `toHaveLength(1)` at the earlier instant), and the docs/register/CHANGELOG/receipt box (`docs/decisions.md` A-pinned rewritten, `docs/cron-timezone.md` divergence block replaced, `SECURITY.md` residual column rewritten, `TESTING.md` register described as empty, `scripts/fuzz/known-findings.json` `classes: {}` with `_empty`, five CHANGELOG entries). The claimed pin deletions are real deletions, each replaced by an assertion of the fixed behaviour rather than by removal — verified for all eight pins named.

**(3) The '## Checklist' mirrors the issue's checklist — PASS**

The issue's Part 1 is P1–P10. The checklist covers P1–P8 as fixed and the disposition table lists all ten with P9 **Not fixed** (issue itself names the `onnx.ts`/`createRequire` prerequisite as "the real unit of work") and P10 **Not fixed — filed as #844** (the issue says "Already filed as #844; listed here for completeness"). No Part 1 item is claimed that the diff does not deliver, and none is silently dropped. Parts 2–4 are declared out of scope with the issue's own reasons (maintainer decision / Ed25519 key in the `release` environment / external actors), matching the issue text. P11 from the comment thread is addressed and correctly attributed to #789.

One noted asymmetry, short of a refutation: the comment thread also carries **P12** (desktop first-run founding on Windows, root-caused to `gateway-secrets.ts` `shouldUseFileFallback`, lane parked `if: false` on #851), which the receipt never mentions even though it does address P11 from the same thread. P12 is neither a Part 1 pinned defect nor in this diff's scope, and it is handled on #851, so the checklist itself still mirrors the issue's Part 1 faithfully — but a line disclaiming it would close the gap.
