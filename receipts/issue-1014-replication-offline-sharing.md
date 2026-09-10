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
