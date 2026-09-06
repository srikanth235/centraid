# Issue #996 — one vault, every seat: full replicas, a session-captured log, and the ontology bridge under it

Umbrella receipt. One receipt for the whole umbrella; each wave appends its own section below and never edits a section above it.

## Checklist

- [x] **Wave 0a — rulings and drift rows**: R1–R25 with their supersession pointers, the ten drift rows ONT-22…ONT-31 and the new _reader-side drift_ category, the two wrong sentences corrected, and open questions 1, 2, 6, 9, 10, 11, 12 and 13 settled
- [ ] **Wave 0b — schema**: the revision occurrence with the wrapper's current-revision pointer and `recordRevision`'s edges deleted; the representation row beside byte-only `core_content_item`; `core_transaction.external_id` without the global `UNIQUE`; the typed occurrence key and one `tz` spelling; the primary-identifier partial index, interval CHECK and issuer column; concept-identity columns; the decoded-body-text side table; deletion roles declared beside references. No epoch bump here
- [ ] **Wave 0c — domain operations**: one invariant boundary with Atlas inside it and non-empty pre/postconditions; content write as one operation; acyclic task hierarchy; `complete` / `reopen` shared by People, Tasks and automations with series identity and inherited `about`; the occurrence adapter every reader consumes; temporal validation at every entry point; `tagNotation` replaced by concept identity; `accountFor` and the publisher probe re-keyed; the declared read-set wired into the intent conflict checker; each operation's offline declaration
- [ ] **Wave 0d — queries and contracts**: `(party, currency)` balances, group results in the group's currency, the explicit valuation type with its unavailable state, the Money output type, and settlements, obligations and exports on the same helpers
- [ ] **Wave 0e — evidence and the cross-boundary tier**: machine tags and document classification linked to their derivation and input revision; the thirteen scenarios promoted to a package fixture with a command→query round-trip test per shared concept across two app surfaces; purge behaviour tested per deletion role
- [ ] **Wave 1 — the log and the seat**: `replica_log` with session capture and in-transaction reconstruction, the sanitised snapshot with its canary test, the applier and cursor, the epoch gate, retention; the one `schema_epoch` bump for W0b and W1; replay-and-diff convergence is the gate from here on
- [ ] **Wave 2 — intents over the new plane**: `row_version` on every mutable table, the declared read-set conflict check, durable outcomes carrying `commit_seq`, the overlay cleared in the transaction that carries the commit, dependency edges and predecessor references
- [ ] **Wave 3 — the phone**: expo-sqlite replaces op-sqlite with sessions, SQLCipher and FTS; the measured device rows exist before any irreversible deletion
- [ ] **Wave 4 — one handler, plain SQL, paged**: keyset pagination and runtime `LIMIT` for all eight apps, wide-column side tables, plan snapshots as review diffs, work-counter gates
- [ ] **Wave 5 — the store deletions**: the read-plan compiler, census probes, deferred values, text ceilings, `replica_row` and `replica_change` go, after W3's device evidence
- [ ] **Wave 6 — Locker v0**: the key plane, enrollment handing `K`, the per-seat unlock boundary demonstrated on each seat, Locker on the PWA, then the permit / sealed-registry / `authenticate` deletions
- [ ] **Wave 7 — sharing as a closure predicate**: the explicit member set, the three outputs (enter / update / leave), derived-rows-never-project, and the composer deleted only after the predicate serves every live subscription on the golden `issue-929` vault
- [ ] **Wave 8 — the authority-plane diet**: the `device` principal, companion surfaces and enrollment UI, the tiers, `share_fulfillment`, `access_app`, `share_authority_use` and `share_access_receipts`
- [ ] **Wave 9 — bytes and the seat's own state**: the custody two-state copy on both seats with verified custody, the purge acknowledgement per seat, and re-bootstrap that preserves the seat's own state through the cutover sequence
- [ ] **Wave 10 — the ledger**: the device rung and the `mobile/*` / `desktop/*` rows in `tests/journeys.json`, every number with provenance
- [ ] **Close pass**: `docs/mobile-offline.md`, `docs/client-keying.md`, `docs/protocol.md` (the idempotency window's number), `SECURITY.md`, the glossary and the `docs/traps/` entry for the seat rules; the drift rows ONT-22…ONT-31 closed on landed mechanisms

Ticked by wave 0a: **box 1 only**. Every other box needs code, and none of the drift rows above is closed by this slice — they are filed **open**, each naming the sub-wave that closes it.

## What changed

Wave 0a is docs-only, and what it lands is **Wave 0a — rulings and drift rows**: R1–R25 with their supersession pointers, the ten drift rows ONT-22…ONT-31 and the new _reader-side drift_ category, the two wrong sentences corrected, and open questions 1, 2, 6, 9, 10, 11, 12 and 13 settled — with `internal-doc-links` and `doc-integrity` green on the tree it lands against. It records the rulings #996 makes as current state, so no later wave is built over a guess, and it files the ontology audit's ten findings as register rows before any of them is fixed.

- **`docs/decisions.md`** — new section `## One vault, every seat (#996)`, placed after `## Sharing as subscription (#929)` and before `## Related docs`: the re-judgement that opens it (per-app shapes existed to minimise a replica to an app's consent grant, and #928 deleted the grant; the mounted reader was built for a cross-owner case #929 removed), the "every seat holds the vault / a subscriber is a seat with a predicate" statement, and **twenty-five rulings R1–R25** as one table of `Id | Current decision`, in the issue's numbering and wording, compressed where the issue is verbose. The rows that carry a tail a later wave depends on keep it verbatim in substance: **R6**'s "a member's own offline chain passes the equality check through predecessor references the gateway resolves (R23), never through a looser check", and **R19**'s cutover sequence (prepare beside; briefly pause mutation admission and applier / upload state changes; transfer the seat-owned state; drain and close the handles; the recoverable switch; reconstruct pending projections; resume). Below the table, the v0 stance — one `schema_epoch` bump for W0b and W1 taken when W1 merges, and device evidence before irreversible deletion.
- **`docs/decisions.md`** — `### Questions settled with the rulings (#996)`: the eight open questions the issue marks "settle in 0a" written as dated decisions, **OQ-1** (the audit and ledger bands ship), **OQ-2** (rows minus FTS on Safari, full on Chromium, by a storage-estimate probe), **OQ-6** (no travelling egress answer; the alternative rejected for v0 and why), **OQ-9** (a caption is a derived row; the owner may promote one to the title with one action), **OQ-10** (a local PIN or passphrase wrapping `K`, WebAuthn where the platform can gate the key, session lock and timeout), **OQ-11** (unbounded for authored edits with an owner-triggered size-based prune), **OQ-12** (a proposed-match row the owner accepts, never automatic), **OQ-13** (outcomes retained not shorter than the log's retention floor and never pruned while a device's cursor is behind them, and the recovery behaviour: an unknown or expired outcome for a `sending` intent **parks** with that reason for the member to decide). Each OQ id is cited from the R row it belongs to, so the two tables cross-reference rather than repeat. The five questions that are measurements or code enumerations (the big-batch threshold, desktop reads, Node 24's SQLite, `vault_links.permissions_json`, `share_authority_use`) are named as answered by the wave that makes them.
- **`docs/decisions.md`** — ten rows added to `## Superseded decision pointers`: #406 / #417's consent-shaped device replicas, #883 D1's mounted multi-vault reader (with the read-plan compiler, order census and refusal grammar), SB-replica-sync's phone half, the custody triple and the origin / custodian / viewer seat contract (**restated**), AP-apps-declare (**restated**), AP-principals / AP-attenuations / AP-companion-projection, AP-locker-boundary, and #916's ONT-revisions, ONT-currency and ONT-recur (**restated as reader-enforced**). Each points at the #996 row that replaces it and names what of the old ruling survives. No older row's text is rewritten.
- **`docs/decisions.md:116`** — the founding sentence said founding creates `Shared` **and** `Personal`, contradicting `glossary.md:68` and `build-gateway.ts:921`, which creates one marked-default `Personal`. Corrected to say founding creates `Personal` and that `Shared` is an ordinary vault an owner may create later; the rest of the paragraph is untouched.
- **`ARCHITECTURE.md:212`** — the replica paragraph still carried the rationale #928 deleted: shapes as "existing app consent grants ∩ the device's trust tier". Corrected to the mechanism that is in the tree — a shape is a static function of the installed app's build-time entity manifest and the sealed-column registry, column-minimized, with no evaluator, no purpose and no grant join (`packages/server/src/routes/replica-shape.ts:1-5`). The issue cites this sentence as `ARCHITECTURE.md:206`; on `6a1b16715` it is line 212.
- **`docs/vault-ontology.md`** — a new register category, **reader-side drift against a landed ruling**, defined in one paragraph where the register's standings are defined: a ruling the storage layer enforces while a reader ignores it, reads a column the writer does not write, or aggregates away what the column was added to carry — it looks fixed from the DDL and from the schema tests, and a storage ruling is not enforced until a reader test holds it.
- **`docs/vault-ontology.md`** — ten drift rows, one per finding of the ontology audit, all **open** and each naming the sub-wave that closes it: **ONT-22** the second document-history graph (0b, reader-side), **ONT-23** Tally's party-only balance map (0d, reader-side), **ONT-24** the globally unique `external_id` and the display-name account match (0b/0c), **ONT-25** `original_start_local` versus `original_start` and `tz` versus `time_zone` (0b/0c, reader-side), **ONT-26** Atlas's empty semantic pre/postconditions (0c), **ONT-27** two completions of one `schedule_task` row and a series with no identity (0c), **ONT-28** `media_type` on the hash-deduped content row, which is also where the generated-caption-in-`title` finding is fixed (0b), **ONT-29** `tagNotation` collapsing `猫` / `犬` / `कुत्ता` / `बिल्ली` to one concept (0b/0c), **ONT-30** the non-partial primary-identifier index (0b), **ONT-31** `due_at: "banana"` and `rrule: "garbage"` accepted (0c). Each row carries the audit's evidence as `file:line` and points at the R row that rules it.
- **`receipts/issue-996-one-vault-every-seat.md`** — this file, created as the umbrella receipt with the wave list 0a–0e and 1–10 plus the close pass as its checklist.

## Out of scope

Every code change #996 names: the schema bridge (0b), the domain-operation layer (0c), the Tally contracts (0d), the evidence tier and the scenario fixture (0e), and waves 1–10. The close-pass docs are deliberately untouched here — `docs/mobile-offline.md`, `docs/client-keying.md`, `docs/protocol.md`, `SECURITY.md`, `docs/glossary.md` and the `docs/traps/` entry for the seat rules describe mechanisms that have not landed, and rewriting them now would state code that does not exist. No test, ledger, budget, allowlist or lint config was touched, and no drift row was closed.

## Decisions

- **OQ ids, not folded rows.** The brief allowed either naming the settled questions `OQ-1 … OQ-13` or folding each into its R row. They are their own table, because six of the eight are answers *about* a ruling rather than clauses *of* one (the rejected alternative in OQ-6, the recovery behaviour in OQ-13), and folding them would have buried the rejected option inside a ruling's prose. Each R row cites its OQ id inline, so neither table stands alone.
- **The version triple is not in any ruling.** Pre-wave check P1 corrected the issue's `node:sqlite` SQLite version (3.50.2 on the pinned Node 24.4.1, not the body's 3.51.2). No ruling or drift row written here cites a SQLite build version — R16 rules only that the gateway stays on Node because Bun has no session API — so the correction needed no doc edit. The triple lands where a measurement belongs: the pre-wave results section of this receipt.
- **`ARCHITECTURE.md`'s line number.** The issue cites the wrong sentence at `ARCHITECTURE.md:206`; on `6a1b16715` it is line 212. The sentence is the one the issue quotes, so it was corrected in place and the discrepancy is recorded rather than silently absorbed.
- **The commit subject carries the anchor where the gate reads it.** The brief's message spelled the issue as a Conventional Commits scope, `docs(#996): …`; `commit-message-format` requires a **trailing** `(#N)` and a subject under 100 characters, which the repo's own log follows. The subject is the brief's text with the anchor moved to the end — `docs: one vault, every seat — rulings R1–R25, settled questions, drift rows ONT-22…31 (#996)`, 98 bytes (the gate counts bytes, and three of the subject's punctuation marks are three bytes each, so the range had to shorten by one repetition of `ONT-`) — and the body and both trailers are verbatim. The gate was not touched.
- **One contradiction flagged, not resolved.** OQ-1's proposed answer ("only credential and gateway-machinery tables are private") is written as proposed, and the one table in the tree that does not obviously fit it is flagged for R3's private-table list to rule on: `automation_state.value_json` (`packages/vault/src/schema/ledger.ts:268`) is opaque handler-written state whose contents no schema constrains, so whether it may ship to a seat is a per-table call the list must make rather than a band-level one. Nothing in this slice resolves it.

## Verification

```sh
bash .governance/run.sh                 # internal-doc-links + doc-integrity green
bun run format:check
```

## Audit

**PASS**

- **`## What changed` against the diff.** PASS. `git diff --name-only` is exactly the four files the wave 0a brief names — `ARCHITECTURE.md`, `docs/decisions.md`, `docs/vault-ontology.md` and this receipt — and each is named with what changed in it. The `docs/decisions.md` diff is one new `## One vault, every seat (#996)` section with a 25-row ruling table and an 8-row OQ table, ten appended `## Superseded decision pointers` rows and one rewritten line 116; `docs/vault-ontology.md` is one new category paragraph and ten appended register rows; `ARCHITECTURE.md` is one sentence. No file in the diff is unnamed, and no section claims a change the diff does not carry.
- **Each `- [x]` against the diff.** PASS. One box is ticked — wave 0a — and each of its clauses is realized: R1–R25 and the ten pointers are in the diff, ONT-22…ONT-31 and the *reader-side drift* paragraph are in the diff, both wrong sentences are corrected, the eight open questions are ruled, and the two gates ran green on this tree (tails in `## Wave 0a` below). Every other box is `- [ ]` and needs no crosswalk.
- **The `## Checklist` against the issue's execution plan.** PASS. The checklist mirrors #996's wave list — 0a–0e, waves 1–10 and the close pass — in the issue's order, with each row's text taken from that wave's own description. It is a wave checklist rather than the issue's acceptance list because #996's acceptance criteria are per-wave gates that this receipt's later sections carry; no acceptance criterion is dropped, and the close-pass row names the docs the issue's Scope holds for it.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-09-06 | claude-code | 60f9e86b-149f-5fc9-84c0-f2160b6b6f3c |

## Wave 0a — rulings, drift rows, and the two corrected sentences

Docs only. Four files, no code, no test, no gate config.

| File | Change | Lines |
| --- | --- | --- |
| `docs/decisions.md` | `## One vault, every seat (#996)` at L838 (R1–R25 table, the OQ-1…OQ-13 table), ten `## Superseded decision pointers` rows at L82–L91, the founding sentence at L116 | +65 −1 |
| `docs/vault-ontology.md` | the *reader-side drift* category paragraph at L111, rows ONT-22…ONT-31 at L145–L154 | +12 −0 |
| `ARCHITECTURE.md` | the replica-shape rationale at L212 | +1 −1 |
| `receipts/issue-996-one-vault-every-seat.md` | this receipt | new |

What each corrected sentence now says, against the tree that makes it true:

- `docs/decisions.md:116` — founding creates one marked-default `Personal` vault; `Shared` is an ordinary vault an owner may create later. `packages/server/src/serve/build-gateway.ts:921` creates `Personal` alone, and `docs/glossary.md:68` already said so; the contradiction was in this file.
- `ARCHITECTURE.md:212` — a replica shape is a static function of the app's build-time entity manifest and the sealed-column registry, with no evaluator, no purpose and no grant join. `packages/server/src/routes/replica-shape.ts:1-5` states the same thing in its header; the deleted clause was #928's, not the tree's.

**Pre-wave check P4, recorded here because R3 is written against it.** The private (never-shipped) set measured on the golden vault is **28 tables** — 5 credential/key, 15 gateway-job, 8 peer-link — plus `replica_change` truncated to its cursor, with column-level exclusions `access_device.public_key` / `sync_cursor`, `access_agent.enrollment_key` and the Locker sealed columns. `agent_command_invocation` is **not** in it and cannot be: `access_receipt`, `agent_invocation_check`, `agent_evidence`, `agent_explanation` and `core_entity_revision.invocation_id` all key into it, so excluding it would break the referential property R3 asserts on the seat. R3 and OQ-1 are written with that clause.

**Pre-wave check P1, recorded here because a ruling would otherwise carry a stale number.** The gateway's `node:sqlite` on the pinned Node 24.4.1 bundles SQLite **3.50.2**, not the 3.51.2 the issue body states; the seat builds are op-sqlite 3.51.3 (phone) and sqlite-wasm 3.53.0 (web). The rest of the session-extension spike holds on Node 24 unchanged — no flags argument, the capture-side filter ignored, integer-only `onConflict`, no changegroup. No ruling text depends on the number.

**Gates**, run on this tree:

```sh
bash .governance/run.sh                 # 23/23 directives; internal-doc-links and doc-integrity green
bun run format:check                    # clean on the four files
```
