# Issue #1014 — replication, offline, sharing and the engine around them

Umbrella receipt. One receipt for the whole umbrella; each wave appends its own section below and never edits a section above it.

The umbrella is [#1014](https://github.com/srikanth235/centraid/issues/1014): thirty findings from an adversarial run against the shipped product on two simulators and a real gateway, plus 152 findings from a full read of the engine underneath it. Four of the run's findings lose the member's data with no outage and no user error; Part II adds roughly forty more silent-loss items. Fifteen structural gaps sit under the set — no liveness owner, an advisory client-guessed OCC check, no per-seat causal order, a replica and an outbox sharing one lifecycle, no unified post-commit hook, five parallel queues, two logs, mechanisms built and never wired, identity by mutable value, one connection with two owners, durable claims held in memory, security that contradicts its own documents, no poison handling, partial OCC, and UI driven off the wrong signal.

## Checklist

- [x] **Wave 0r — rulings, receipt and changelog**: the twelve **R-1014** rulings recorded in [docs/decisions.md](../docs/decisions.md#replication-offline-and-sharing-1014) as provisional, the deliberate non-goals, the owner question **Q-1014-1**, the two supersession pointers, this receipt, and the changelog line
- [ ] **Wave 0a — the gateway log**: `replica_change` retired as a transport, `readReplicaLog` transactional, `abandonReplicaCommit` on every rollback path, the epoch bump's floor derived from `replica_log`, `COLUMN_NAMES` invalidated on schema change, `replicatedTablesOf` an allow-list with a golden test
- [ ] **Wave 0b — unbracketed writers**: `notices.ts`, the `gateway.ts` sweep, `execution.ts` post-rollback bookkeeping, `gateway/ext.ts` DDL and the `gateway-db.ts` worker connection brought inside `beginReplicaCommit`/`endReplicaCommit`, plus the law rule that proves it
- [ ] **Wave 0c — checked identity**: the snapshot head carrying its vault id and refused before the destination is touched, `seat_state` written with the install, `LAST_BASE` per gateway, no `manual` seat path, the feed cursor derived from `applied_seq`
- [ ] **Wave 0d — the wiring gate**: every exported mechanism in the G8 list wired or deleted, and the gate listing zero uncalled mechanisms in the four named directories
- [ ] **Wave 1 — the outbox cannot be destroyed**: carry-over staged durably before the swap, deferred spans back-filled, one connection owner per file with a lease, `needs_blobs_json` populated, placement's receipt in the domain write's transaction, revocation exporting or holding the outbox
- [ ] **Wave A — delivery**: the feed plus a watchdog and periodic pull, the applier's change sink wired on native, the rebootstrap latch reset, `device_checkpoints`, per-device SSE fairness
- [ ] **Wave B — settlement**: `commitSeq` carried on both sides of the wire, the overlay cleared after COMMIT, the mirror invalidated on raw deletes, the peer door deduping `parked`/`denied`
- [ ] **Wave C — the guard**: base versions on chained writes and deletes, `row_version` on every replicated table with a canary, monotonic across delete and re-insert, idempotency scoped to the seat's durable identity, an intent-level commit gate
- [ ] **Wave D — sharing**: provenance buffered in the batch and flushed post-COMMIT, doorbells driven by actual writes, epoch change resetting the subscription, the blob door streaming under a size cap, a chaos lane for the peer wire
- [ ] **Wave E — ingest and the phone's queues**: follow-ups honouring `target_vault_id`, dedupe keyed per vault, Import sending the vault header, failed items surfaced and retryable, staged bytes held by pending intents
- [ ] **Wave F — automations and pipelines**: per-element retry and dead-letter, per-target failure counters in health, bounded `notReady` park, connector dedupe before publish, a listing sanity bound before reconcile deletes, and B10's derived-data removal from the replicated set
- [ ] **Wave S — security posture**: the seat file keyed and revoke rotating, kit verification per owner scope, the erase gate per vault, the passphrase floor, handoff tickets bound to device and vault and single use, and SECURITY.md matching the code
- [ ] **Wave G — surfaces, copy and docs**: freshness from applied rows, honest coverage, a refusing state, other-vault pending counts, the refusal mark, "Add another phone", and every T-list doc row corrected
- [ ] **Close pass**: the QUALITY.md entries this umbrella closes struck through with their PR, the wiring docket emptied, and the live adversarial re-run on the same instruments as Part I

Ticked by wave 0r: **box 1 only**. Every other box needs code, and no acceptance criterion of the issue is met by this slice.

## What changed

Wave 0r is docs-only and lands the **registry** half of the umbrella: the rulings the execution plan requires before wave 0a may start, the receipt every later wave appends to, and the changelog line the umbrella is findable by.

- **[`docs/decisions.md`](../docs/decisions.md#replication-offline-and-sharing-1014)** — a new section `## Replication, offline and sharing (#1014)`, placed after `## Governance as a constitution (#1005)` and before `## Related docs`. It carries the twelve rulings **R-1014-1 … R-1014-12** as one `Id | Current decision | Why` table, each naming the wave that lands it; a `### Deliberate non-goals (#1014)` list taken from the issue's `Out:` set; and a `### Open questions for the owner (#1014)` table with **Q-1014-1**. The lead paragraph states, in bold, that every ruling is **provisional** — adopted from the issue's own recommendation with no owner reading — and that confirming or reversing them is a release blocker rather than a follow-up.
- **[`docs/decisions.md`](../docs/decisions.md#superseded-decision-pointers)** — two rows added to `## Superseded decision pointers`. The first supersedes **#922 G5's refused-overlay half** in part: the overlay stays, and the row it draws now carries a visible refusal mark. The second restates [#996](https://github.com/srikanth235/centraid/issues/996)'s "`replica_change` is replaced, not merely re-shaped" with the wave that executes it — the ruling was right and the tense was not, because both logs are live in the tree. No existing row's text is rewritten, and `docs/decisions.md:86` is left as it stands with the pointer carrying the correction.
- **[`CHANGELOG.md`](../CHANGELOG.md)** — one entry under `## [Unreleased]` → `### Fixed`, citing [#1014](https://github.com/srikanth235/centraid/issues/1014) and summarising the umbrella in the member's terms: delivery, settlement, the conflict guard, multi-vault identity, the sharing relay, ingest, the pipelines, the security posture and the surfaces. Later waves add no further changelog line; this one is the umbrella's entry.
- **`receipts/issue-1014-replication-offline-sharing.md`** — this file, created as the umbrella receipt with the wave list `0r`, `0a`–`0d`, `1`, `A`–`G`, `S` and the close pass as its checklist.
- **[`QUALITY.md`](../QUALITY.md)** — deliberately unchanged. Its four open entries under [#996](https://github.com/srikanth235/centraid/issues/996) are the same defects this umbrella carries as R25, R15, R1 and R18/R23/R24; the tracker's format strikes an entry through when the fix lands with its PR, and nothing has landed. Opening a fifth entry for work that already has an umbrella issue would be a second register of the same facts.

## Out of scope

Every code change [#1014](https://github.com/srikanth235/centraid/issues/1014) names — waves 0a, 0b, 0c, 0d, 1, A, B, C, D, E, F, S and G. The close-pass documents are deliberately untouched here: [ARCHITECTURE.md](../ARCHITECTURE.md), [SECURITY.md](../SECURITY.md), [docs/mobile-offline.md](../docs/mobile-offline.md), [docs/protocol.md](../docs/protocol.md), [docs/vault-ontology.md](../docs/vault-ontology.md), [docs/recovery/](../docs/recovery/backup-restore.md), [docs/traps/](../docs/traps/README.md) and [TESTING.md](../TESTING.md) describe mechanisms these rulings change but no wave has landed, and correcting them now would state code that does not exist. No test, ledger, budget, allowlist or lint config was touched, and no acceptance box is ticked.

## Decisions

- **R-1014-1** (#1014 open question 1, G7) — one log: `replica_change` is retired as a transport, the SSE feed and the OCC lookup move onto `replica_log`, `floor_seq` gets one owner, and the trigger log is deleted under `v0-no-legacy` in wave 0a.
- **R-1014-2** (#1014 open question 2, R26, re-judging #922 G5) — a refused intent keeps its overlay and the row is **marked** refused on every surface that draws it; the pending-changes sheet is surfaced from Home.
- **R-1014-3** (#1014 open question 3, R14) — member-facing screens name no gateway host, transport or sync-engine state outside Settings, Devices, Backup health and Onboarding.
- **R-1014-4** (#1014 open question 4, M3) — a guest vault gets a second device through the guest's own phone; the `owner_only` refusal at the landlord door stays.
- **R-1014-5** (#1014 open question 5, B10) — derived data leaves the replicated set in wave F; per-commit log coalescing is its own proposal.
- **R-1014-6** (#1014 open question 6, G8) — the wiring gate is a law rule over exports with zero non-test importers, with a docket row per pending item, empty at close.
- **R-1014-7** (#1014 open question 7, X2) — the seat file is keyed with the Locker key door and revoke rotates the key; a new key-management design is out, and V13's recall gap is a recorded drift.
- **R-1014-8** (#1014 open question 8, X3, G14) — the audit and ledger bands stay on the seat for v0 and SECURITY.md is corrected; receipt detail and command outputs are stripped from what replicates now.
- **R-1014-9** (#1014 open question 9, B9) — the backfill class is declared on the recipe, never inferred; per-occurrence automations run once per missed occurrence.
- **R-1014-10** (#1014 open question 10, S2) — a link between two vaults on one gateway takes a local path; same-gateway links are not modelled as something other than a link.
- **R-1014-11** (#1014 R25, G9) — seat identity is `(gatewayId, vaultId)` with no `manual` fallback; a snapshot carries its vault id and a mismatch is refused before the destination is touched.
- **R-1014-12** (#1014, the 1 ↔ S seam) — one revocation policy on both hosts: the unsent outbox is exported or held before a purge, and the gateway keeps the idempotency ledger across re-enrolment.
- **Provisional, and said so in the document.** The brief's alternative was to hold twelve waves for an owner who is not available in this run. A wave built over an unrecorded guess is worse than one built over a recorded provisional ruling, so each row states that it adopts #1014's recommendation, and **Q-1014-1** puts the confirmation in front of the owner as a release blocker rather than as a note.
- **Line 86 is not rewritten.** [#996](https://github.com/srikanth235/centraid/issues/996)'s sentence about `replica_change` being replaced is a ruling that stands; only its tense was wrong. Editing it in place would erase the evidence that the retirement was ruled once and never executed, which is exactly what R-1014-1 exists to finish, so the correction is a supersession pointer.
- **Twelve rulings, not ten.** #1014 lists ten open questions; **R-1014-11** (seat identity, R25/G9) and **R-1014-12** (the revocation policy on the 1 ↔ S seam) are rulings the execution plan's seam list requires before waves 0c, 1 and S can be planned against each other, and neither is answered anywhere else.
- **QUALITY.md gains nothing.** Its four open entries are this umbrella's R25, R15, R1 and R18/R23/R24 already; the format closes an entry with the PR that fixes it, and a docs-only slice fixes none of them.

## Verification

This lane's commit was made from `b0c1949c`, one commit behind `main`, and the branch is integrated with `main` after the fact. `main`'s tip at the time (`af9ceac6`) carries a 102-character subject — GitHub's squash merge appended a second `(#1012)` to an already-full one — and the law's range falls back to `HEAD~1..HEAD` when a branch tip equals the trunk, so the hook door on a first lane commit judged **that** commit rather than this change, with no edit to this change able to answer it. Branching one commit earlier put the well-formed `b0c1949c` in the fallback range, so every rule ran against this change and nothing was waived, skipped or bypassed.

Every command below was run at the worktree root on this commit's tree.

```sh
bun run format:check          # PASS — "All matched files use the correct format", exit 0
bun run check:push:static     # PASS — 4/4 gates green: format:check, lint, turbo:lint, typecheck:affected
node .governance/law/run.mjs --door window --range b0c1949c..HEAD
                              # PASS — law (window door): 10 rule(s), no findings, exit 0
```

`check:push:static` needs `bun run build` first even on a docs-only tree: its `typecheck:affected` member ends in `tsc -p tests`, which resolves `@centraid/*` through `dist`. Without the build it fails with ~250 `TS2307 Cannot find module` errors that have nothing to do with the change.

## Audit

**PASS**

- **`## What changed` against the diff.** PASS. `git diff --name-only b0c1949c..HEAD` is exactly the three files this section names — `CHANGELOG.md`, `docs/decisions.md` and this receipt. The `docs/decisions.md` diff is one new `## Replication, offline and sharing (#1014)` section (a 12-row ruling table, a 5-item non-goals list, a 1-row open-questions table) plus two appended `## Superseded decision pointers` rows; `CHANGELOG.md` is one bullet under `## [Unreleased]` → `### Fixed`. No file in the diff is unnamed, and no bullet claims a change the diff does not carry. No existing line of `docs/decisions.md` is rewritten — the diff adds lines only.
- **Each `- [x]` against the diff.** PASS. One box is ticked, wave 0r, and each of its clauses is realized in the diff: the twelve rulings, the non-goals, **Q-1014-1**, the two supersession pointers, this receipt and the changelog line. Every other box is `- [ ]`, needs code, and needs no crosswalk.
- **The `## Checklist` against the issue's execution plan.** PASS. The rows mirror [#1014](https://github.com/srikanth235/centraid/issues/1014)'s wave list — 0a, 0b, 0c, 0d, 1, A, B, C, D, E, F, S, G — in the issue's order and with each row's text taken from that wave's own description, preceded by this docs slice and closed by the close pass. It is a wave checklist rather than the issue's acceptance list because those criteria are per-wave gates the later sections carry; none is dropped.
- **The `## Decisions` rulings against `docs/decisions.md`.** PASS. Each of **R-1014-1 … R-1014-12** appears in both files with the same substance, and each cites `#1014` in its own line, which is what `doctrine-citation` reads. `registry-completeness` is satisfied in both directions: the receipt records rulings and `docs/decisions.md` carries lines citing #1014; the change lands and `CHANGELOG.md` carries a line citing #1014.
- **Claims against commands.** PASS. Every line in `## Verification` was run on this tree and is quoted with its result in the lane report; no gate, ledger, budget, allowlist or lint config was touched, and no test was skipped, quarantined or deleted.

## Lane 0a — the gateway log: one floor, a live seat hold, and the capture's edges

Wave 0a's box is **not** ticked. Six of its seven clauses landed; the headline one — `replica_change` retired as a transport — did not, and `## Not done, and why` below says what stopped it. The lane's findings are **G1, G2, G3, G6, G9, G13, G15, G20, G21, G25, V1, T1, T3, T7, T9**.

### What changed

Three commits on `lane/1014-0a`, all made after merging the umbrella branch at `5ac727e8`.

- **`9b5b1261` — `fix(vault): replicated tables are an allow-list, not a deny-list (#1014)`** (G13). `packages/vault/src/schema/private-tables.ts` gains `REPLICATED_TABLE_NAMES` (109 names), `isReplicatedTable` (ext bands by their `ext_` / `extdraft_` prefix) and `unclassifiedTables`; `replicatedTablesOf` intersects the file's tables with that list instead of subtracting the private one, so a table added to the schema now replicates NOWHERE by default rather than EVERYWHERE. `packages/vault/src/schema/private-tables.test.ts` adds four golden cases, including a planted `zz_unclassified` table that must be caught. `packages/vault/src/index.ts` exports the two new predicates; [`ARCHITECTURE.md`](../ARCHITECTURE.md) describes two closed lists rather than one.
- **`b3f15178` — `fix(replica): one floor per log, each derived from its own (#1014)`** (G1, G2, G3, G6, G7/T1, G15, G20, G21, G25, V1, T9, T7). Rung eight (`REPLICA_FLOOR_SPLIT_DDL` in `packages/vault/src/schema/replica.ts`, listed in `packages/vault/src/schema/migrate.ts`) adds `replica_meta.change_floor_seq` and `access_device_secret.sync_cursor_at`, moves an existing file's floor into the trigger log's column and re-derives `floor_seq` from the rows `replica_log` actually still holds. `packages/vault/src/replica/change-log.ts` reads and writes only `change_floor_seq`, and `bumpReplicaEpochInTransaction` derives each floor from its own log. `packages/vault/src/replica/log.ts` gains `inReadTransaction` (re-entrant, used by both readers), `recordSeatCursor`, `REPLICA_SEAT_HOLD_DAYS = 14`, a `lowestSeatCursor` that counts only devices seen inside that bound, `watchReplicaTable`, a `schema_version`-keyed `COLUMN_NAMES`, and a defer threshold that measures raw image bytes as well as rows. `packages/server/src/serve/vault-plane.ts:2118` calls `pruneReplicaLog` in the sweep; `packages/server/src/routes/seat-routes.ts` records the cursor the device sent, best-effort, after the page is served. `packages/vault/src/gateway/execution.ts` and `packages/vault/src/gateway/gateway.ts` abandon the capture on their full-rollback paths (never on a `ROLLBACK TO`, which would drop the enclosing transaction's rows); `packages/vault/src/gateway/ext.ts` declares each new ext physical to the open capture. `packages/vault/src/replica/seat-snapshot.ts` reads its epoch, schema epoch and floor from the COPY. Tests: `packages/vault/src/replica/log-retention.test.ts` (+7 cases), `packages/vault/src/schema/migrate.test.ts` and `packages/server/src/engine/stores/gateway-db.test.ts` moved to eight rungs.
- **`ec814221` — `fix(replica): the opaque conflict check fails closed (#1014)`** (G9, T3, T9-doc). `packages/vault/src/replica/snapshot.ts` gains `replicaRowIdsOf`; `packages/server/src/routes/replica-intent-shape.ts` takes its opaque-key candidates from the entity's own table and no longer has a "no candidates ⇒ skip the check" branch. `packages/server/src/routes/replica-intent-route.test.ts` adds the pruned-log conflict case; `packages/vault/src/replica/log-capture-edges.test.ts` is new (G3, G15, G20, G21); `packages/vault/src/replica/seat-snapshot.test.ts` adds the artifact's own cursor (T7). Docs: [`docs/vault-ontology.md`](../docs/vault-ontology.md) replication row rewritten (T3), [`docs/mobile-offline.md`](../docs/mobile-offline.md) retention-pinning sentence corrected (T9).

### Verification

**PASS**, with three inherited reds named below. Every command was run at `/home/user/wt-0a` on `ec814221`'s tree, after `bun run build`.

```sh
bun run --cwd packages/vault typecheck            # PASS (exit 0)
bun run --cwd packages/server typecheck           # PASS (exit 0)
bun run --cwd packages/client typecheck           # PASS (exit 0)
bun run --cwd packages/vault test                 # PASS — 214 files, 1799 passed, 2 skipped
bun run --cwd packages/server test                # 3 failed / 3523 passed — all three inherited (below)
bun run test:integration:mobile                   # 2 failed / 68 passed — inherited (below)
bun run format && bun run check:push:static       # PASS — 4/4 gates in 86.0s
node .governance/law/run.mjs                      # 0 errors; 1 warning, cross-lane (below)
```

Lane-specific exits:

```sh
grep -rn "pruneReplicaLog(" packages/server/src --include=*.ts | grep -v test
# → packages/server/src/serve/vault-plane.ts:2118 — the sweep call site. PASS
grep -rn "replica_change" packages apps tests --include=*.ts --include=*.tsx | grep -v dist/ | wc -l
# → 94. FAIL against the brief's "only historical comments" — the transport is not retired.
```

Red-first evidence, each produced by reverting only the fix in the working tree and restoring it:

- G1/G2 — with `pruneReplicaChanges` writing `floor_seq` again and the epoch bump deriving it from `sqlite_sequence`, the three `two logs, two floors` cases fail: `expected 6 to be +0`, `expected 6 to be 12`, `expected 9 to be less than or equal to 4`. With the fix: green.
- G9 — with the candidates read from `replica_change` and the empty-set `continue` restored, `still checks opaque row versions after the change log is pruned` fails. With the fix: green.
- G15 — with `COLUMN_NAMES` not keyed on `schema_version`, `a delete image keeps its column names after the schema changes` fails with `expected [ 'reps', 'set_id' ] to strictly equal [ 'note', 'set_id' ]` — the mislabelled delete image, exactly as G15 describes. With the fix: green.

Inherited reds, with the evidence they are not this lane's:

- `packages/server/src/serve/gateway-db-lock.integration.test.ts` — `command -v sqlite3` finds nothing on this machine and the test spawns `sqlite3`.
- `packages/server/src/acp/backends/acp/launch.test.ts` (two cases) — the ambient environment has `IS_SANDBOX=yes`; the test asserts `"1"` and `undefined`.
- `tests/integration-mobile/stale.integration.test.ts` — reproduced on the umbrella tip `5ac727e8` with this lane's `packages/` checked out to `5ac727e8` and rebuilt: three cases fail there (`locker`, `people`, `photos`) with the same `the stale signal never clears` assertion.
- `node .governance/law/run.mjs` reports one warning, `estate-separation`, over the WHOLE range: it pairs lane 0b's `.governance/packs/.../bracketed-replica-writes/*` with every lane's product code. None of this lane's three commits touches a law-estate path (`git show --name-only` on each, filtered to the estate list, is empty); the split-or-waive decision belongs to whoever raises the pull request.

### Not done, and why

- **`replica_change` is not retired as a transport (G7/T2, R-1014-1).** The SSE feed is not a port away from `replica_log` but a redesign. `packages/server/src/routes/replica-projection.ts` decides a row's SHAPE MEMBERSHIP AT THE CLIENT'S CURSOR from `first.priorOp` / `first.priorOldValuesJson` (`:417-429`) and its shape-control verdict from `oldValuesJson` (`:264-286`) — the state BEFORE a change. `replica_log` stores only the new image (and the old image for deletes), so there is no equivalent to read: closing that gap means deciding, and testing, a new membership rule for a wire contract the shipped phone depends on. Attempting it alongside this lane's eleven other findings would have put an untested rewrite of the feed under the same commit as the loss fixes. **What did land against it**: the OCC candidate lookup no longer reads the trigger log at all, and the two floors no longer collide, which removes the loop and the silent staleness that made "two logs" a data-loss bug rather than a duplication.
- **`currentRowVersion`'s `MAX(seq) FROM replica_change` fallback (G8) stands**, at `packages/server/src/routes/replica-intent-shape.ts:346`, with its twins at `packages/server/src/routes/peer-replica-intent-route.ts:287` and `packages/vault/src/replica/snapshot.ts:236` (composite keys and rows with no `row_version`). Both halves of the check must read the SAME units, and the seat half is in shipped mobile code; changing the unit on the gateway alone would conflict every offline edit of such a row. It belongs with the transport retirement.
- **`docs/decisions.md` untouched.** Lane 0r owns the supersession pointer for `docs/decisions.md:86` and has landed it. **`docs/protocol.md` untouched**: `grep -n "replica_log\|replica_change\|seat log" docs/protocol.md` returns nothing, so it names neither log and has no drift for this lane to correct.
- **G3's crash could not be reproduced on this SQLite build.** A top-level `ROLLBACK` with the capture left open did not make the next `captureReplicaCommit` throw `reads back as missing`, so the test that landed guards the invariant ("after a rollback the next commit's log carries that commit and nothing else") rather than asserting a failure this build does not exhibit. The call sites were still added: `abandonReplicaCommit` is the declared contract and had zero production callers.

### Found, not mine

- `packages/vault/src/replica/change-log.ts:1085-1092` — `pruneReplicaChanges` deletes by `epoch <> ?` while `packages/server/src/doctor/integrity-checks.ts:282-287` reports foreign-epoch rows as an integrity fault. With the two floors now separate, a doctor pass between an epoch bump and the next sweep will report a fault that is merely un-swept. Wave 0d or the doctor's owner.
- `packages/vault/src/schema/entity-refs.ts:175` and `packages/vault/src/schema/local-tables.ts:77` name `replica_change` as a registered carrier and an unregistered table respectively; both entries go with the transport.
- `tests/integration-mobile/stale.integration.test.ts` — the inherited red above is a real signal, not flake: which apps fail moves between runs, but the count does not go to zero. Something on the umbrella tip leaves log rows past a seat's cursor after a completed pull. Lane 0b or wave A.

### Docs touched

[`ARCHITECTURE.md`](../ARCHITECTURE.md) (the two closed lists), [`docs/vault-ontology.md`](../docs/vault-ontology.md) (the replication enforced-commitment row, T3), [`docs/mobile-offline.md`](../docs/mobile-offline.md) (retention pinning is implemented and bounded, T9).
