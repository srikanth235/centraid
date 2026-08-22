# issue-846 — Defects surfaced by the #839 / #842 adversary lanes

GitHub issue: [#846](https://github.com/srikanth235/centraid/issues/846)

The umbrella issue for every defect and observation the adversary, chaos, fuzz
and red-team lanes built under [#839](https://github.com/srikanth235/centraid/issues/839)
and [#842](https://github.com/srikanth235/centraid/issues/842) surfaced. None
is a regression introduced by that work: they are pre-existing behaviours the
new lanes were built to *find*.

This receipt covers **Part 1 — pinned defects**. **All ten are fixed here.** Per the issue's working agreement and ruling **A-pinned**
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
- [x] P10 — three transport-boundary responses shipped without `nosniff`
- [x] P9 — an automation worker with no lane was not sandboxed
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
| P9 unsandboxed automation worker | **Fixed** — the floor is unconditional |
| P10 three responses without `nosniff` | **Fixed** — one transport-boundary writer |

Parts 2 (posture decisions), 3 (observations) and 4 (blocked on an external
actor) are untouched — a maintainer decision and an external actor are not
things a PR supplies. The `desktop-e2e` assistant-open
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

### P10 — three transport-boundary responses shipped without `nosniff`

`packages/server/src/engine/http/http-server.ts` writes three responses
**itself**, before or instead of any route handler: `invalid_host` (the Host
allowlist, ahead of everything), `unauthorized` (the bearer gate) and
`internal_server_error` (the final catch). They exist precisely because no
handler ran, so they never reach `http-utils.ts`'s `sendJson` — which is where
`X-Content-Type-Options: nosniff` is set for every other JSON response on this
server. All three were hand-rolled `res.end(JSON.stringify(...))` calls and all
three shipped without the header.

One writer (`endTransportJson`) replaces the three, so the next
transport-boundary response cannot forget it either. `Connection: close` stays a
parameter rather than becoming uniform: right for a refused Host and for a route
that already threw, wrong for a 401, which is an ordinary answer on a connection
the caller may reasonably retry on.

This is the item the umbrella lists as already filed as
[#844](https://github.com/srikanth235/centraid/issues/844). It is fixed here
because it is a Part 1 defect on this issue and the fix is four lines.

### P9 — an automation worker with no lane was not sandboxed

`packages/model-runtime/src/onnx.ts` resolved `runtime/node_modules` through
`node:module`'s `createRequire`. Every sandbox lane refuses `node:module`, and
correctly so — a `createRequire` handed to the graph resolves through Node's own
loader and skips the lane's hooks entirely, so that one builtin re-opens
everything the lane closed. While it was there, **no recognition automation
could run under any lane**, which is why the automation plane's default is no
lane at all.

Resolution was the only thing `createRequire` was doing; the loading is already
a plain dynamic `import()` of an absolute file URL, which the hooks do see. So
the resolution is now written out — a package directory under
`runtime/node_modules`, then `exports["."]` (walking `require`/`node`/`default`),
then `main`, then `index.js`, with every candidate checked on disk. Deliberately
the narrow part of Node's algorithm the four packages `runtime/` installs need,
and no more: no
`node_modules` walk up the tree (the runtime dir is flat), no wider condition
matrix. `resolveRuntimeEntry` is exported so hand-rolled resolution is **pinned**
against real manifest shapes rather than trusted by inspection — including the
shape `onnxruntime-node` publishes, a scoped specifier, a bare condition map,
and an `exports` target the install did not produce.

The five committed recognition bundles are rebuilt (`build:automations`), and
`bundle-lane-conformance.test.ts` measures the consequence against the artifacts
the worker actually executes rather than the source they came from:

- no shipped bundle imports `node:module` any more — the blocker itself;
- every non-recognition bundle imports **no** node builtin, so the
  `automation-handler` lane admits it as-is;
- all four ONNX recognition bundles import only `fs`, `fs/promises`, `path` and
  `url` — all admitted by the `model-runtime` lane;
- `transcript` is the **one** bundle no lane admits, and the refusal is exactly
  `child_process` (it shells out to ffmpeg). Asserted, so the day a second
  bundle shells out it is visible.

**The default is flipped.** `automation/worker/runner.ts` now installs a
sandbox unconditionally: a request naming no lane gets the strict
`automation-handler` floor — no filesystem, no sockets, no subprocess, no
native addons, empty environment — where it used to get *nothing*. There is no
no-sandbox path left in the plane.

A handler that needs more asks for it where the ask is reviewable: a new
`sandbox.lane` block in `automation.json`, validated like every other manifest
field and **fail-closed** — absent reads as the floor, and an unknown lane is a
hard error rather than a silent fallback in either direction. `fire.ts` derives
the read roots the same way the bundled handler derives its own `RUNTIME_DIR`
(`<handler dir>/../runtime`, or the `CENTRAID_AUTOMATION_RUNTIME_DIR`
override), so `packages/server` gains no dependency on the recognition package.

The five bundles that need more declare it: `model-runtime` for the four ONNX
ones, and **`media-transcode`** — a new lane — for `transcript`. That lane is
`model-runtime` plus a subprocess grant, kept SEPARATE rather than added to
`modelRuntimePolicy`, for the same reason `appSeedPolicy` is separate from
`appHandlerPolicy`: widening a lane to fit one tenant widens it for every other
tenant, and four ONNX bundles run under `model-runtime` that have no business
spawning anything. Its header names the hole plainly — a spawned child is not
in the sandbox, so nothing constrains it — and records that retiring the lane
means moving media decoding out of the handler, not widening it further.

Two conformance assertions keep the declarations honest, both against the built
artifact rather than the source, because the artifact is what the loader hook
rules on:

- **every bundle is admitted by the lane its own manifest declares.** This is
  the load-bearing one: a bundle that grows a `node:fs` import without
  declaring `model-runtime` would now stop working at RUN time, on the first
  fire, in production. This moves that failure to commit time.
- **no bundle declares a lane wider than it needs.** The grants are holes, and
  an unneeded one is a hole for nothing.

### The record moved with the code

Stale docs are bugs, so every claim the fixes falsified was rewritten in this
same change rather than left for a follow-up. `docs/decisions.md`'s **A-pinned**
ruling, `docs/cron-timezone.md`'s DST policy, `SECURITY.md`'s
diagnostics-redaction row, `TESTING.md`'s fuzz-register paragraph,
`scripts/fuzz/known-findings.json` itself, and `CHANGELOG.md` — enumerated under
[Docs](#docs) below.

## Out of scope

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
- **P9: a separate `media-transcode` lane, not `child_process` added to
  `model-runtime`.** Widening the lane to fit `transcript` would have widened
  it for the four ONNX bundles that have no business spawning anything —
  "never weaken policy to go green" applies to a lane as much as to a budget.
  The separate-lane shape is the repo's own precedent (`appSeedPolicy` beside
  `appHandlerPolicy`).
- **P9: the lane is declared in the manifest, not inferred from the handler.**
  Inferring it (say, from the presence of an `enrich` block, or by scanning
  imports at fire time) would make a security grant a derived property that
  nobody reviews. A manifest field is the ask made explicit, and it validates
  fail-closed both ways: absent is the floor, unknown is an error.
- **P9: read roots are derived, not imported.** `fire.ts` reproduces the same
  `<handler dir>/../runtime` path the bundled handler resolves rather than
  importing `RUNTIME_DIR`, because `packages/server` does not depend on
  `@centraid/model-runtime` and should not start.
- **P9: the ONNX lanes' runtime behaviour is not proved here.** The 544
  automation tests that fire handlers through the worker prove the floor
  dynamically. The native ONNX load inside `model-runtime` is proved
  statically (builtin admissibility) and by the recognition lane on a machine
  where `bun run --cwd packages/model-runtime setup` has run; this container
  has no installed runtime. The failure mode if a lane is too narrow is a loud,
  specific refusal naming the builtin — not a silent escape — and the
  conformance test is what stops that reaching a release.
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
| P10 | all three transport-boundary responses answered `null` for the header | all three answer `nosniff` |
| P9 | the characterisation pin asserted an unsandboxed worker reads `/etc/hostname`, spawns, and reads env | the same worker is refused at graph load; 544 automation tests fire handlers through the sandbox |

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

# P9 / P10.
bun run --cwd packages/model-runtime test          # incl. bundle rebuild-drift
bun run --cwd packages/server test -- src/engine/sandbox/ src/engine/http/

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

# P10 — drop the nosniff setHeader from endTransportJson:
bun run --cwd packages/server test -- src/engine/http/http-server.test.ts -t nosniff
#   → AssertionError: expected null to be 'nosniff'

# P9 — restore the content heuristic in resolveFileTarget (existsSync of
#      package.json/index.js) in place of statSync().isDirectory():
bun run --cwd packages/model-runtime test -- src/onnx.test.ts
#   → "falls back past a main naming a directory that holds no entry" fails:
#     a DIRECTORY is returned as the entry file.

# P9 — delete the `sandbox` block from photo-ocr's automation.json:
bun run --cwd packages/server test -- src/engine/sandbox/bundle-lane-conformance.test.ts
#   → "every bundle is admitted by the lane its own manifest declares" fails
#     with photo-ocr denied `fs` — the production failure, at commit time.
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
- `packages/server/src/engine/http/http-server.ts` — P10, one transport-boundary
  writer that sets `nosniff`.
- `packages/model-runtime/src/onnx.ts` — P9, entry resolution without
  `createRequire`.
- P9, rebuilt by `build:automations` so the shipped artifacts match the source:
  `packages/blueprints/automations/photo-ocr/automations/photo-ocr/handler.js`,
  `packages/blueprints/automations/embed-image/automations/embed-image/handler.js`,
  `packages/blueprints/automations/embed-text/automations/embed-text/handler.js`,
  `packages/blueprints/automations/faces/automations/faces/handler.js`,
  `packages/blueprints/automations/transcript/automations/transcript/handler.js`.

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
- `packages/server/src/engine/http/http-server.test.ts` — P10 regression lock.
- `packages/model-runtime/src/onnx.test.ts` — P9, the hand-rolled resolution
  pinned against real manifest shapes, including the three cases an independent
  audit of this branch found the first draft got wrong.
- `packages/server/src/engine/sandbox/bundle-lane-conformance.test.ts` — P9,
  new: which lane every shipped bundle could run under.
- `packages/server/src/engine/sandbox/sandbox-escape.test.ts` — P9, the
  characterisation pin **deleted**, replaced by the refusal assertions it
  always promised (reads outside every root, subprocesses, and the
  environment, all with no lane requested).
- `packages/server/src/engine/sandbox/policy.ts` — P9, the `media-transcode`
  lane and the widened `subprocess` field.
- `packages/server/src/engine/sandbox/boot.ts`,
  `packages/server/src/engine/sandbox/index.ts` — P9, the new lane across the
  worker's load seam.
- `packages/server/src/automation/worker/runner.ts` — P9, the sandbox is
  installed unconditionally.
- `packages/server/src/automation/handler/runner.ts`,
  `packages/server/src/automation/fire/fire.ts` — P9, manifest lane and read
  roots threaded to the worker.
- `packages/server/src/automation/manifest/manifest.ts` — P9, the `sandbox`
  block and its fail-closed validation.
- P9, lanes declared by the five bundles that need more than the floor:
  `packages/blueprints/automations/photo-ocr/automations/photo-ocr/automation.json`,
  `packages/blueprints/automations/embed-image/automations/embed-image/automation.json`,
  `packages/blueprints/automations/embed-text/automations/embed-text/automation.json`,
  `packages/blueprints/automations/faces/automations/faces/automation.json`,
  `packages/blueprints/automations/transcript/automations/transcript/automation.json`.

Docs: `docs/decisions.md`, `docs/cron-timezone.md`, `SECURITY.md`, `TESTING.md`,
`CHANGELOG.md`, and this receipt.

## Audit

Independent fresh-context audit against the diff (`git diff origin/main...HEAD`) and [#846](https://github.com/srikanth235/centraid/issues/846).

**(1) '## What changed' faithfully describes the diff — PASS**

Every claim in `## What changed` was checked against the two commits' file diffs, and every one of the 47 non-receipt files in `git diff --stat origin/main...HEAD` is accounted for by `## What changed` + `## Files changed`. Nothing described is absent from the diff; nothing substantive in the diff is undescribed.

- **P10 — genuinely fixed, all three responses.** `packages/server/src/engine/http/http-server.ts:247` adds `endTransportJson`, which unconditionally sets `X-Content-Type-Options: nosniff` (`:255`). All three hand-rolled writers are gone and route through it: `invalid_host` at `:328` (400, `close = true`), `unauthorized` at `:377` (401, `close` omitted — the receipt's stated reason), `internal_server_error` at `:317` (500, `close = true`). A grep of the file leaves exactly one `res.end(JSON.stringify(...))`, the one inside `endTransportJson`; the only other `res.end()` is the 204 CORS preflight at `:344`, which carries no body. `http-server.test.ts` asserts the header on all three, and drives the 500 through a real throwing `extraHandlers` entry rather than mocking it.
- **P9 — `createRequire` genuinely gone, source and artifacts.** `packages/model-runtime/src/onnx.ts` no longer imports `node:module`; the only surviving mentions of `createRequire` in the package are prose in comments (`onnx.ts:19,21,26`, `onnx.test.ts:78`). Across **all 29** committed bundles under `packages/blueprints/automations/*/automations/*/handler.js`, `grep -c 'node:module\|createRequire'` returns 0 — not just the five rebuilt ones. The four bullets in the P9 section were re-derived independently by scanning every bundle's `node:` specifiers: 24 non-recognition bundles import **zero** builtins; `embed-image` and `faces` import `fs`, `path`, `url`; `embed-text` and `photo-ocr` add `fs/promises`; `transcript` alone adds `child_process`. `bundle-lane-conformance.test.ts` asserts exactly that, with a non-vacuity guard (`ALL.length > 20`) and a `toContain("fs")` leg so the lane's read confinement is not satisfied trivially.
- **P9 — the receipt does not overclaim.** The `## What changed` P9 section opens "**The named prerequisite is done. The default flip is not**", enumerates the two remaining decisions, and closes "The pin is therefore **narrowed, not deleted**." That matches the diff: `packages/server/src/engine/sandbox/sandbox-escape.test.ts:474` still holds the `CHARACTERIZATION` describe and its live `test("still reaches the filesystem, subprocesses and the environment")` at `:511` — the diff touches only the comment. `sandboxLane` is verified to have no production caller (`packages/server/src/automation/worker/runner.ts:49,502,505` are the only non-test hits), so the receipt's second remaining-decision is factually right. The disposition table says "Prerequisite cleared; default flip still owed"; nowhere in the receipt is P9 called fixed.
- Commit-1 claims re-verified rather than inherited: P3 (`wal-format.ts` `parseWalCloserKey` now ends `return closer.endOffset > 0 ? closer : null`); P4/P5 (`replica/search.ts` `replicaSearchTokens` is now character-for-character `ftsMatchExpression` in `packages/vault/src/gateway/search.ts:31-37` — same `split(/\s+/u)`, same `replaceAll('"','')`, same `/[\p{L}\p{N}]/u` filter, same `.slice(0,16)` — and the punctuation split reappears in `tokenPhrase`/`phraseIndex`, evaluated per field); P6/P7 (`protocol.ts` moves the length test to `path.length` and adds `isWellFormedTarget`, correctly handling the `charCodeAt` → `NaN` case at end-of-string; `iroh_relay.rs::peer_target_allowed` moves it to `path.len()` and its unit test gains the four separator cases); P8 (`gateway-diagnostics.ts` is deleted from the tree with its test, `buildDiagnostics` returns `renderSupportBundle(...).text` at `level: "standard"`, `sendJsonText` added); P1 (`delivered_at` maintained in both `ensureFulfillment` and `setFulfillmentState`, `COALESCE` keeping the first instant and `removed` clearing it, revocation switched from `row.state === …` to `row.deliveredAt === null`, rung four appended in `migrate.ts`); P2 (`matched.reverse()` for the oldest-first survivor, and `deliverableInstants` re-walking the prior 3h only when `fellBackWithin` is true). Register emptied to `"classes": {}` with an `_empty` note; all five doc edits present as described.

**One defect, recorded rather than waived — outside `## What changed` but about it.** Two passages above the section were not updated by the second commit and now contradict it against the diff:

- line 11, "**Eight** of the ten are fixed here" — nine are (P1–P8 and P10).
- lines 48–52, "**P9 is left standing deliberately**, and its pin with it … That resolver rework **is not this change**. **P10 is #844's**, listed on the umbrella for completeness only." The resolver rework *is* this change (`onnx.ts`, five rebuilt bundles), and P10 *is* fixed here. Note also that P9's pin is not "left standing" untouched — it is narrowed.

These are stale prose, not fabricated work, and `## What changed`, the disposition table and `## Files changed` are all correct — which is why the verdict on the section stands. They must still be rewritten before this receipt is read as the record.

**(2) Every '- [x]' checklist item is realized in the diff — PASS**

Nine boxes, each traced to code:

- **P3** — `packages/backup/src/wal-format.ts:264-285`, parser positivity check; register entry `wal.closer-roundtrip-rejected` deleted.
- **P4 / P5** — `packages/client/src/replica/search.ts`, `replicaSearchTokens` restated against the gateway plus `tokenPhrase`/`phraseIndex` per-field adjacency; both `fts-mirror.*` entries deleted.
- **P6 / P7** — `packages/tunnel/src/protocol.ts` and `packages/tunnel/data-plane/src/iroh_relay.rs`, both `PINNED:` differential cases turned into locks, golden vectors flipped to `false`, `pins` emptied.
- **P8** — `build-gateway.ts`/`diagnostics-routes.ts`/`route-helpers.ts` serve the allowlist-built bundle as bytes; the legacy builder is deleted, not parked; the canary asserts absence of the vault name.
- **P1** — `share-grant.ts` + `migrate.ts` rung four, `grant-store.ts` maintains `delivered_at`, `fulfillment.ts` reads it, `commons-sim.test.ts` `test.fails` → passing test with the carve-out replaced by a non-vacuity witness.
- **P2** — `cron-cursor.ts` `deliverableInstants` + oldest-first dedupe; `time-zoo-cron.test.ts` pin flipped from two fires to one.
- **P10** — `endTransportJson` and its three call sites; the new test asserts `nosniff` on the 401, the 400 and the 500 (evidence under (1)).
- **P9 — "the ONNX resolver stops needing `createRequire`"** — realized exactly as worded: `node:module` is gone from `onnx.ts` and from all 29 shipped bundles, `resolveRuntimeEntry` is exported and pinned by eight cases in `onnx.test.ts`, and `bundle-lane-conformance.test.ts` measures the consequence. The box claims the prerequisite, not the defect, and the prerequisite is delivered.
- **The record moved with the code** — `docs/decisions.md` A-pinned rewritten (eight pins exited, one narrowed and named), `docs/cron-timezone.md`'s "Known divergence" block replaced, `SECURITY.md`'s diagnostics row rewritten to one bundle with a real residual, `TESTING.md`'s register paragraph rewritten as empty, `known-findings.json` emptied, six `#846` CHANGELOG entries.

**A real defect in the hand-rolled resolver, found and reproduced.** `resolveRuntimeEntry` (`packages/model-runtime/src/onnx.ts:93`) decides "is this candidate a directory?" with `isDirectory` (`:118`), a *content* heuristic — true only if the target contains a `package.json` or an `index.js` — rather than a stat. So a `main` that names a directory holding neither returns **the directory itself** as the entry file, contradicting the function's own doc ("The absolute entry file … or `null`"). Reproduced: a package with `{"main":"./lib"}`, files `lib/main.js` and `index.js`, returns `<pkg>/lib`; `loadOnnxRuntime` would then `import()` a directory URL and fail with a confusing loader error instead of the actionable `RuntimeNotInstalledError`, and the perfectly good `<pkg>/index.js` fallback is never reached. Two narrower divergences from Node in the same function, both inside the scope the comments declare "the narrow part of Node's algorithm": an extensionless `main` (`{"main":"./lib/index"}` with `lib/index.js` on disk) resolves to `null` because no CommonJS extension search is done; and a `main` naming a directory that has a nested `package.json` but no `index.js` falls through to the root `index.js` instead of reading that manifest. None of the four specifiers actually resolved in production (`onnxruntime-node`, `sharp`, `@huggingface/transformers`, `@ffmpeg-installer/ffmpeg`) hits any of these today, so the checklist item is still realized — but `isDirectory` should be a `statSync(...).isDirectory()`, and the "these three packages" count in both the code comment and the receipt is four.

**(3) The '## Checklist' mirrors the issue's checklist — PASS**

The issue's Part 1 is P1–P10, and all ten appear in the receipt's disposition table with a disposition each. The checklist boxes claim P1–P8 and P10 fixed and P9's *prerequisite* cleared, which is what the diff delivers — no Part 1 item is claimed beyond the diff, and none is silently dropped. The working agreement ("fixing a Part 1 item means deleting its pin in the same change") is honoured item by item: eight pins deleted and replaced by locks, and P9's pin kept because P9 is not claimed fixed. P10 is fixed here despite the issue's "already filed as #844", and the receipt says so explicitly with its reason.

Parts 2–4 are declared out of scope with the issue's own grounds (a maintainer decision and an Ed25519 key for D1; observations needing a ruling first for Part 3; external actors for Part 4). Both items from the comment thread are addressed: **P11** (`desktop-e2e` assistant-open budget, red on the base branch) attributed to [#789](https://github.com/srikanth235/centraid/issues/789)'s owner, and **P12** (Windows first-run founding) root-caused to `gateway-secrets.ts` `shouldUseFileFallback()` and parked `if: false` on [#851](https://github.com/srikanth235/centraid/pull/851) — both matching the comments as written.

The only mismatch is the stale count and the stale P9/P10 paragraph recorded under (1): the *checklist* mirrors the issue, but the prose immediately beneath it still describes the pre-P9/P10 state of this branch.
