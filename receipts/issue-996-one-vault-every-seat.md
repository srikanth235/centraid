# Issue #996 — one vault, every seat: full replicas, a session-captured log, and the ontology bridge under it

Umbrella receipt. One receipt for the whole umbrella; each wave appends its own section below and never edits a section above it.

## Checklist

- [x] **Wave 0a — rulings and drift rows**: R1–R25 with their supersession pointers, the ten drift rows ONT-22…ONT-31 and the new _reader-side drift_ category, the two wrong sentences corrected, and open questions 1, 2, 6, 9, 10, 11, 12 and 13 settled
- [x] **Wave 0b — schema**: the revision occurrence with the wrapper's current-revision pointer and `recordRevision`'s edges deleted; the representation row beside byte-only `core_content_item`; `core_transaction.external_id` without the global `UNIQUE`; the typed occurrence key and one `tz` spelling; the primary-identifier partial index, interval CHECK and issuer column; concept-identity columns; the decoded-body-text side table; deletion roles declared beside references. No epoch bump here
- [x] **Wave 0c — domain operations**: one invariant boundary with Atlas inside it and non-empty pre/postconditions; content write as one operation; acyclic task hierarchy; `complete` / `reopen` shared by People, Tasks and automations with series identity and inherited `about`; the occurrence adapter every reader consumes; temporal validation at every entry point; `tagNotation` replaced by concept identity; `accountFor` and the publisher probe re-keyed; the declared read-set wired into the intent conflict checker; each operation's offline declaration
- [x] **Wave 0d — queries and contracts**: `(party, currency)` balances, group results in the group's currency, the explicit valuation type with its unavailable state, the Money output type, and settlements, obligations and exports on the same helpers
- [x] **Wave 0e — evidence and the cross-boundary tier**: machine tags and document classification linked to their derivation and input revision; the thirteen scenarios promoted to a package fixture with a command→query round-trip test per shared concept across two app surfaces; purge behaviour tested per deletion role
- [x] **Wave 1 — the log and the seat**: `replica_log` with session capture and in-transaction reconstruction, the sanitised snapshot with its canary test, the applier and cursor, the epoch gate, retention; the one `schema_epoch` bump for W0b and W1; replay-and-diff convergence is the gate from here on
- [x] **Wave 2 — intents over the new plane**: `row_version` on every mutable table, the declared read-set conflict check, durable outcomes carrying `commit_seq`, the overlay cleared in the transaction that carries the commit, dependency edges and predecessor references
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

Wave 0b lands across four commits, and what it lands is **Wave 0b — schema**: the revision occurrence with the wrapper's current-revision pointer and `recordRevision`'s edges deleted; the representation row beside byte-only `core_content_item`; `core_transaction.external_id` without the global `UNIQUE`; the typed occurrence key and one `tz` spelling; the primary-identifier partial index, interval CHECK and issuer column; concept-identity columns; the decoded-body-text side table; deletion roles declared beside references. No epoch bump here. Each clause, in the section that carries it: the revision occurrence and the decoded-body-text side table in `## Wave 0b — history and representation`; the representation row beside byte-only `core_content_item` in `## Wave 0b — the representation split`; the external-id, concept-identity and identifier-interval work in `## Wave 0b — schema`. Two clauses moved by ruling rather than being done here — the occurrence key has no schema work and goes to 0c, and deletion roles ride 0e — both recorded in `## Decisions — wave 0b (second half)`.

Wave 0c lands in one commit, and what it lands is **Wave 0c — domain operations**: one invariant boundary with Atlas inside it and non-empty pre/postconditions; content write as one operation; acyclic task hierarchy; `complete` / `reopen` shared by People, Tasks and automations with series identity and inherited `about`; the occurrence adapter every reader consumes; temporal validation at every entry point; `tagNotation` replaced by concept identity; `accountFor` and the publisher probe re-keyed; the declared read-set wired into the intent conflict checker; each operation's offline declaration. The surface, the scenarios, the site accounting and the gate tails are in `## Wave 0c — domain operations` below.

Wave 0d lands in one commit, and what it lands is **Wave 0d — queries and contracts**: `(party, currency)` balances, group results in the group's currency, the explicit valuation type with its unavailable state, the Money output type, and settlements, obligations and exports on the same helpers. The surface, the scenarios, the site accounting and the gate tails are in `## Wave 0d — queries and contracts` below.

Wave 0e lands in one commit, and what it lands is **Wave 0e — evidence and the cross-boundary tier**: machine tags and document classification linked to their derivation and input revision; the thirteen scenarios promoted to a package fixture with a command→query round-trip test per shared concept across two app surfaces; purge behaviour tested per deletion role. The surface, the scenarios, the files, the gate tails and one carried-in fix are in `## Wave 0e — evidence and the fixture` below.

Wave 1 lands across six commits, and what it lands is **Wave 1 — the log and the seat**: `replica_log` with session capture and in-transaction reconstruction, the sanitised snapshot with its canary test, the applier and cursor, the epoch gate, retention; the one `schema_epoch` bump for W0b and W1; replay-and-diff convergence is the gate from here on. Each clause, in the section that carries it: the schema plane and the single epoch bump in `## Wave 1 — schema and epoch`; session capture, the decoder and the applier with its cursor and epoch gate in `## Wave 1 — capture and decoder`; the sanitised snapshot and its canary in `## Wave 1 — snapshot, doors, capability`; retention, the producer bound and the deferral flag in `## Wave 1 — retention and the producer bound`; the two doors that serve the file and the log, plus the retirement of `vault_content_text`, in `## Wave 1 — the doors, and the function-free index`; and the durable outcome contract in `## Wave 1 — the outcome contract (R23–R25)`. The wave's full file list is `## Wave 1 — every file the wave touched` plus the per-commit lists in the last two sections.

Wave 2 lands across four commits, and what it lands is **Wave 2 — intents over the new plane**: `row_version` on every mutable table, the declared read-set conflict check, durable outcomes carrying `commit_seq`, the overlay cleared in the transaction that carries the commit, dependency edges and predecessor references. The first three clauses landed on the gateway in waves 0b and 1 (the column and its touch trigger, the checker over the operation's declared read-set, and `replica_intent_outcome.commit_seq` / `produced_json`); this wave is the seat's half of the last two and the thing that makes the third mean something on a device. Each clause, in the section that carries it: the applier that gives a seat rows to compare a version against, and the bootstrap that gives it the file, in `## Wave 2 — the applier and the bootstrap`; the seat's own state, its bytes and the watermark that replaces per-read `coverage`, in `## Wave 2 — bytes, seat state, and the fixture that had to stop being a slice`; the dependency edges derived from minted ids, the predecessor references, and the overlay cleared at `commit_seq` inside the transaction that advances the cursor, in `## Wave 2 — the outbox chain`; and the flag, the browser host and the measurements in `## Wave 2 — the web seat, behind the flag`. Every file the wave touched is listed per commit in those four sections.

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
| 2026-09-07 | claude-code | 60f9e86b-149f-5fc9-84c0-f2160b6b6f3c |

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

## Pre-wave checks

#996's execution plan gates wave 1 behind five measurements. All five ran **2026-09-06** against the golden vault `packages/vault/tests/golden/issue-929/vault.db.gz` — gunzipped copy 106,233,856 B, 12,968 pages @ 8 KiB, 260 tables (108 `fts_*`), 590 triggers, 407 indexes, freelist 0; the original was never mutated and no repo file was edited by any probe. Runtime is Node 22.22.2 / `node:sqlite` except where P1 names Node 24.4.1. The probe scripts live in the root agent's scratchpad, not in the repo: `p1-node24.mjs` + `p1-extra.mjs` (P1), `p2-wire.mjs` + `p2-chunk.mjs` (P2), `p4-sanitise.mjs` + `p4-control.mjs` (P4), `p5-reconstruct.mjs` + `p5-e2.mjs` + `csparse.mjs` (P5); P3 is a read of the tree and cites `file:line` only.

### P1 — the bundled SQLite and the session surface on the pinned Node

The pin resolves to Node 24.4.1 everywhere (`.node-version:1`, `package.json:199-201`, the gate at `scripts/ci/node-version.mjs:21-46` registered at `scripts/ci/gate-classes.json:88`, CI install at `.github/actions/setup/action.yml:96-98`, release lane at `.github/workflows/lane-release-gateway-npm.yml:93-95`). The official 24.4.1 tarball was fetched to the scratchpad and probed beside the box's 22.22.2.

| Row | Node 22.22.2 | Node 24.4.1 | Same? |
| --- | --- | --- | --- |
| `sqlite_version()` | 3.51.2 | **3.50.2** | **no — 24 is older** |
| compile options (49 each) | `ENABLE_SESSION`, `ENABLE_PREUPDATE_HOOK`, `ENABLE_FTS5`, `THREADSAFE=1` | identical | yes |
| module keys / `constants` (8 `SQLITE_CHANGESET_*`) | present | identical | yes |
| `DatabaseSync` + session prototypes, `db.backup`, `patchset()` | present | identical | yes |
| `createSession({filter})` | accepted, **silently ignored** (excluded row still shipped) | same | yes |
| `applyChangeset({filter})` | honoured | honoured | yes |
| `applyChangeset({onConflict})` | arity 1, arg is a plain integer | identical | yes |
| `applyChangeset` flags / `invert` / `fkNoAction` / `noSavepoint` | accepted, **no effect** | identical | yes |
| `changegroup` export | absent | absent | yes |
| changeset bytes for one identical INSERT | 20 B | byte-identical | yes |
| `packages/server` `src/serve/gateway-db.test.ts` (forks pool, `packages/test-kit/src/vitest.ts:34-37`) | 7 passed, 0 FAIL | 7 passed, 0 FAIL | yes |

**Verdict: SQLite 3.50.2 on Node 24.4.1; no ruling changes.** The two probe logs differ in 2 lines, both banner. Every spike finding the rulings lean on reproduces: no flags argument, capture-side `filter` ignored (so R5/W1's one-session-per-replicated-table stays mandatory), integer-only `onConflict`, no `changegroup`. Open question 12 closes at **3.50.2**.

### P2 — compressed wire size of a 10k-row commit (open question 3)

Per commit: one session per table, decode to R5 JSON inside the capturing transaction, `replica_change` and `fts_*` excluded; each log was then parsed and applied to a second golden copy and every touched table came out byte-identical to the gateway (per-table `quote()` digest). "changeset (excl.)" is the like-for-like table-filtered changeset.

| Commit | log rows | JSON raw | JSON gzip-6 | JSON brotli-5 | B/row gzip-6 | changeset (excl.) gzip-6 | decode | apply |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a) 10k UPDATEs on `media_asset` | 10,000 | 6,949,101 | **184,753** | 126,238 | 18.5 | 108,434 | 404 ms | 233 ms |
| b) 10k INSERTs into `core_content_item` | 20,000 | 5,957,791 | **209,282** | 141,584 | 10.5 | 197,763 | 489 ms | 212 ms |
| c) 10k DELETEs from `schedule_task` | 20,000 | 1,220,001 | **56,387** | 40,700 | 2.8 | 182,709 | 269 ms | 98 ms |

Readings: a 10k-row commit is 55–210 KB gzipped, so a threshold must be denominated in **compressed bytes, never rows** (6.6× spread). JSON is not a wire penalty against a filtered changeset (updates 1.7× worse, inserts within 6%, deletes 3.2× better); the spike's "5× win" compared JSON to the *unfiltered* changeset, of which `replica_change` alone is 81% / 29% / 67% of raw bytes. gzip-6 by default, brotli-5 where advertised (14–60 ms, 25–32% better); **never brotli-11 on the producer path** (2.2–19.5 s per commit for 12–36%). Keep column names as keys: positional arrays cut raw bytes 38–72% but only 4–11% of gzip-6. Statements ≠ log rows — the entity triggers produced 2 log rows per statement in b and c.

**Proposed answers to open question 3, to be confirmed against a model-upgrade batch in W1** (not yet ruled): **defer band 512 KB – 2 MB compressed, recommended 1 MB** on one unattended cellular catch-up span (≈55,000 log rows worst case, ≈360,000 best); **producer bound N = 2,000 decoded log rows per commit** — ≤1.4 MB `rows_json`, ≈38 KB gzip-6, under 4% of the 1 MB budget so no single commit can straddle the threshold, and chunking to 2,000 costs only +0.7…+1.6% total gzip-6 versus one 10k commit (500 costs +2.2…+6.8%, 250 costs +7.9…+13%).

### P3 — does any backup path already carry `keys/`?

| Path | Entry point | What is copied | `keys/`? |
| --- | --- | --- | --- |
| Offsite snapshot engine (`backup run`) | `packages/server/src/backup/backup-sources.ts:128-177` | `vault.db` base clone, `blobs/sha256/**`, `apps.bundle` | **no** (file header `backup-sources.ts:1-4`) |
| WAL shipping | `packages/vault/src/wal-shipper.ts`, `packages/backup/src/wal-format.ts:35` | `vault.db` base + WAL segments | **no** |
| `backup kit --out` | `packages/server/src/backup/backup-recovery-kit.ts:9-40` | keyring + per target `<vaultId>.sealkey`, `<vaultId>.identity`, password-wrapped | **the only carrier** |
| Portable bundle export | `packages/vault/src/gateway/portable-export.ts:209-306`, `portable-custody.ts:25-44` | rows, adapters, content; DEK only under a passphrase | **DEK only** |
| `gateway.backup(cred, dest)` | `packages/vault/src/gateway/custody.ts:56-75` | `vault.backup.db` + blobs | **no** |

`keys/` appears in **zero** `SourceEntry` producers; `backup-sources.ts` is the only assembler and lists three kinds (`db`, `blob`, `git-bundle`). The store itself is six file kinds under `<dataDir>/keys/` (`packages/server/src/cli/paths.ts:26-44`), each a `CENTRAID-KEY-V1` envelope wrapped by a protector held outside `dataDir` (`packages/vault/src/schema/key-store.ts:106-200`, `packages/server/src/cli/key-store.ts:108-130`). **Verdict: `keys/` is deliberately outside every backup; key material rides only in the password-wrapped recovery kit** (`SECURITY.md:37`). W6 must therefore extend the **kit only** — mint `K` as `<dataDir>/keys/<vaultId>.lockerkey` on the `sealKeyFileFor` / `identityKeyFileFor` pattern (`packages/vault/src/schema/sealed.ts:287-293`, `packages/vault/src/schema/vault-identity.ts:48-56`), add a **list** of locker key files to `RecoveryKitTarget` (`backup-recovery-kit.ts:9-23`) so rotation's `K` and `K′` both ride, import them back at `packages/server/src/backup/recover.ts:296-320`, refuse a restore of locker ciphertext without its key with a named reason mirroring `packages/server/src/backup/backup-service.ts:1246-1256` and extend `packages/vault/src/restore-check.ts` with a locker verdict, and rule explicitly whether `portable-custody.ts` carries locker keys or marks locker secrets ciphertext-only. **Finding for W6 (not fixed here):** the two erase paths disagree — `packages/server/src/routes/vault-routes.ts:261-267` destroys `.sealkey`, `.identity` and `.identity.pub`, while the crash-resume path `packages/server/src/serve/erase-recovery.ts:51` destroys **only** `.sealkey`, leaving the identity seed behind after a crashed erase.

### P4 — snapshot sanitisation on the golden vault

The private list measures **28 tables** — 5 credential/key, 15 gateway-job, 8 peer-link — plus `replica_change` (78,376 rows) **truncated**, `replica_meta` kept as the cursor. **Correction the probe forced:** `agent_command_invocation` was first classified private and cannot be — `access_receipt`, `agent_invocation_check`, `agent_evidence`, `agent_explanation` and `core_entity_revision` all FK into it. With it replicated, replicated→private FK references across the golden schema = **0** and `PRAGMA foreign_key_check` over the sanitised snapshot returns 0 violations in 75 ms. 28/28 private canaries planted and read back, plus one FTS canary in `locker_item.title`; all 29 are findable in the pre-sanitisation bytes. No private table is FTS-indexed today (all 18 `fts_*` sit over replicated tables), so that assertion is currently unreachable by construction and is kept for the next `fts_` over a private column.

| # | Pipeline | private canaries in bytes | size (B) | freelist | integrity | drops | total ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | DROP, `secure_delete=OFF`, final `VACUUM` | **0** | 64,495,616 | 0 | ok | 28 | 1,267 |
| B | DROP, `secure_delete=ON`, final `VACUUM` | **0** | 64,495,616 | 0 | ok | 230 | 1,449 |
| C | B + drop the 18 `fts_*` vtabs | **0** | 52,510,720 | 0 | ok | 349 | 1,440 |
| D | `DELETE FROM` instead of DROP, `secure_delete=ON`, final `VACUUM` | **0** | 65,216,512 | 0 | ok | 225 | 1,391 |
| E | DROP, `secure_delete=OFF`, **no final `VACUUM`** | **10 found** | 101,187,584 | 4,360 | — | — | — |
| F | DROP, `secure_delete=ON`, **no final `VACUUM`** | **0** | 101,187,584 | 4,360 | — | — | — |

E is the proof R4 asks for: ten credential/peer-link canaries survive in 4,360 freed pages while `sqlite_schema` already reads clean. A or F is individually sufficient; keep both (B) — `secure_delete` costs +202 ms in the drop step only, the final `VACUUM` reclaims 37 MB (−36%). D leaves all 28 private tables and 58 index objects in `sqlite_schema`, so the reason to keep DROP is **schema surface, not residue**. A/B/D retain exactly 57 triggers, all `fts_*` sync, and 0 trigger/view/index references a private table. C is **not free**: the 57 retained FTS triggers survive the vtab drop and then fail (`no such table: main.fts_locker_item` on the first `INSERT INTO locker_item`), so C needs seat-side FTS DDL + `'rebuild'` before the applier's first write, against a 12.0 MB saving. Writer blocking during `VACUUM INTO` (20 s of concurrent writes at ~2 ms each): **7,550 writes committed, 0 errors, 2 blocked >50 ms, max latency 179 ms**; the copy itself took 547 ms under load vs 476–557 ms idle. **Verdict: build W1's snapshot as variant B.**

### P5 — reconstructing a full row image from an UPDATE changeset

`node:sqlite` exposes no changeset iterator, so the v1 wire format was parsed directly (`csparse.mjs`, cross-checked against a known 3-statement changeset); each change's row was read by the changeset's own pk columns from the same connection, still inside the capturing transaction, then verified after `COMMIT`. **Post-commit verification: 12 ok, 0 fail, 3 cases emitted no change.**

| Case | What the session emits | Decoder emits |
| --- | --- | --- |
| A single-column UPDATE, 13-col row | one `UPDATE`, 11 of 13 columns undefined | `update` + full image |
| B two UPDATEs, same row | one collapsed `UPDATE` | one `update` + full image |
| C UPDATE of a pk column | `DELETE`(old pk) + `INSERT`(new pk) | delete + insert |
| D INSERT then UPDATE | one `INSERT` with the **final** values | `insert` + full image |
| E UPDATE then DELETE | one `DELETE` with the pre-transaction row | `delete` |
| F DELETE then INSERT, same pk | one `UPDATE` | `update` + full image |
| F2 INSERT then DELETE, same pk | **0 B, no change** | nothing |
| G AFTER UPDATE trigger writing the same row | one `UPDATE` carrying both columns | one `update` + full image |
| H `ON DELETE CASCADE` into a child | `DELETE(indirect=1)` with the complete old row | `delete` for both |
| I / I2 no-op UPDATE (`SET a=a`) | **0 B, nothing recorded** | nothing |
| J composite pk, non-pk column | `UPDATE`, both pk columns in old | `update` + full image |
| J2 composite pk, one pk component updated | `INSERT` + `DELETE` | insert + delete |

Decoder rules W1 must implement: **one row per `(table, pk)` per commit** — collapse is the session's, and intra-commit statement order is unrecoverable (changes are grouped by table then pk, not by time); **a pk change is never an update on the wire** — `DELETE`(old) + `INSERT`(new), including for an `INTEGER PRIMARY KEY` rowid alias; **a no-op update and an insert-then-delete are not recorded at all**; carry the **indirect flag** through so trigger/cascade rows stay distinguishable; **reconstruct per session immediately after `session.changeset()`**, before any further statement in the transaction — with one session per included table and the read deferred to just before `COMMIT`, session 1's update reads NO ROW and the decoder would emit an update for a deleted row (a post-commit read is unsafe for the same reason); read the full row by the changeset's own pk flag bytes and never trust the change's own values; fail loudly if an insert/update read returns no row, and fail loudly on a table with no declared PRIMARY KEY, which is **silently not tracked** (the golden vault has 0 such tables and 0 `WITHOUT ROWID` user tables). Timing on a 10k-row UPDATE commit (all triggers dropped, changeset 917,817 B): statement 29.9 ms, `changeset()` 25.5 ms, **JS parse 379.8 ms**, per-pk reads 122.0 ms, batched `IN (…)` reads 92.2 ms — batching wins 1.33× but the parse, an artifact of the missing native iterator, is the bottleneck; reconstruction adds ~0.9–1.2 ms per 100 rows.

### Consequences for the plan

- **The version triple in the issue body is wrong.** It is **3.50.2** (gateway) / **3.51.3** (op-sqlite phone) / **3.53.0** (sqlite-wasm web); the gateway is the oldest, not the middle. W1's oracle and wire tests must read "3.50 and 3.53", and the wire-compat matrix must add the untested pairs **3.50.2 ↔ 3.51.3** and **3.50.2 ↔ 3.53.0** — the spike only ever exercised 3.51.2 ↔ 3.53.0. No ruling text carries the number, so nothing in `docs/decisions.md` changes.
- **`agent_command_invocation` is replicated**, not private, and `docs/decisions.md:850` (R3) is already written with that clause.
- **The `fts_*` drop is a separate decision for W1**, not part of R4's pipeline: it saves 12.0 MB but leaves 57 retained triggers pointing at tables that no longer exist, so it is only correct with a mandatory seat-side FTS DDL + rebuild bootstrap step before the first apply.
- **The erase-path asymmetry is a finding for W6** (`packages/server/src/serve/erase-recovery.ts:51` versus `packages/server/src/routes/vault-routes.ts:261-267`), filed here, not fixed here.
- **One report contradicts a landed ruling, flagged not fixed.** `docs/decisions.md:860` (R13) says "the recovery kit **and the backup** carry every live key file". P3 measures that no backup path copies `keys/`, and `SECURITY.md:37` states that exclusion as a deliberate security boundary. W6 must either amend R13's clause to the kit alone or rule the backup change against `SECURITY.md`; this slice records the conflict and changes neither.

## Wave 0b — schema

The ontology bridge's schema half. Three of the six schema items land whole, red-first, plus the decoded-body-text side table and the migration machinery a re-cut needs. **The 0b checklist box above stays unticked**: it names eight clauses and four of them are not in this diff (see `## Decisions — wave 0b`), and a ticked box whose clauses are not realized is exactly what the crosswalk exists to prevent.

### What landed

| # | Item | Shape | Rung |
| --- | --- | --- | --- |
| 5 | **Identifier interval** (R20(e)) | `core_party_identifier` re-cut: `issuer` column, table CHECK `valid_to >= valid_from`, `idx_party_identifier_primary` narrowed to `is_primary = 1 AND valid_to IS NULL`, live value index keyed `(scheme, COALESCE(issuer,''), value)` | six |
| 6 | **Concept identity** (R20(d)) | `core_concept` gains `stable_id`, `normalized_key`, `pref_label_lang` with two partial UNIQUE indexes; `ensureConcept` selects on the Unicode-preserving key and the slug gets a collision suffix | six |
| 3 | **Source-scoped external ids** (R20(c)) | `core_transaction` re-cut without the global `UNIQUE` on `external_id`, plus a partial index on it; the transaction publisher's global probe is deleted | seven |
| — | **Decoded body text** (R4 / R8) | `core_content_text`, a 1:1 replicated projection of `core.content_item` — schema only, no triggers (wave 1 owns those) | eight, and the baseline |

Files, by path:

| File | What |
| --- | --- |
| `packages/vault/src/schema/core-rungs.ts` | **new** — the three re-cut/ALTER DDL exports and `CONTENT_TEXT_DDL`. `packages/vault/src/schema/core.ts` is rung one and is **not** touched: it stays the shape v0 shipped |
| `packages/vault/src/schema/migrate.ts` | the `VaultMigration` type, `applyRung`, and rungs six–eight; `CONTENT_TEXT_DDL` added to the composed baseline |
| `packages/vault/src/schema/migrate.test.ts` | eight rungs and `user_version` 8; `core_content_text` in the fresh-file table list; the rung-five test sliced at rung five so it does not run a re-cut against an empty file; two hard-coded `5`s replaced by `VAULT_MIGRATIONS.length` |
| `packages/vault/src/schema/baseline-fixture.ts` | rung one is always a plain DDL string, now that a rung need not be |
| `packages/vault/src/schema/entity-catalog.ts` | `core.content_text` registered as a projection of `core.content_item`, with its label and blurb |
| `packages/vault/src/schema/fts.ts` | `ftsSyncTriggersFor(entity)`, and `entityDdl` refactored onto it so the trigger text has one source |
| `packages/vault/src/ingest/enrich-publishers.ts` | `conceptKey`, `ensureConcept` re-keyed with its migrate-on-touch fallback, `freeNotation`, the tag probe |
| `packages/vault/src/ingest/enrich-publishers.test.ts` | the two concept-identity scenarios |
| `packages/vault/src/ingest/publishers.ts` | the transaction publisher's global `external_id` probe deleted |
| `packages/vault/src/schema/party-identifier-interval.test.ts` | **new** — four identifier scenarios |
| `packages/vault/src/ingest/source-scoped-external-id.test.ts` | **new** — the Bank A / Bank B pair |
| `scripts/docs-site/src/content/ontology-body.html` | §03 for `core.party_identifier`, `core.concept`, `core.transaction` and the new `core.content_text`, plus the two gateway-duty sentences that still said `external_id` was unique |
| `receipts/issue-996-one-vault-every-seat.md` | this section |

**No `schema_epoch` bump.** `REPLICA_SCHEMA_EPOCH` is untouched; W1 takes the one bump for 0b and itself. `PRAGMA user_version` goes 5 → 8 (three rungs), which is the file's shape ladder and a different number.

### How a shape change reaches an existing file, since this is the first wave to need all three forms

`golden-vault.test.ts` compares a migrated golden's `sqlite_master` text with a **freshly built** vault's, object by object. That is what decides the form:

- **A new column** is `ALTER TABLE … ADD COLUMN` **in the rung and NOT in the baseline**. SQLite appends the column to the stored text, so a fresh file and a migrated one end byte-identical *because both get it from the rung*. Adding it to the baseline as well is what would break the comparison.
- **A new table** is stated in the baseline **and** re-stated by the rung with `IF NOT EXISTS` — the same two-place shape rung five uses for the #928 ask tables — because the baseline is what the shape tests (`ontology-shape.test.ts`, `baseline-fixture.ts`) read.
- **A removed constraint** is SQLite's twelve-step re-cut, and needs two pragmas the ladder did not have. `migrate.ts` gains `VaultMigration = string | { recut: string }`: a `recut` rung runs with `foreign_keys = OFF` (set outside the transaction, because that pragma is a **no-op inside one**) and `legacy_alter_table = ON` (so the RENAME does not rewrite the child tables' `REFERENCES` clauses to the temporary name), and `PRAGMA foreign_key_check` runs inside the transaction before the COMMIT — a rebuild that leaves a child pointing at nothing rolls back instead of reaching a file. Measured on a scratch db first: without `legacy_alter_table` the child's stored DDL becomes `REFERENCES "parent_old"(id)` and `foreign_key_check` reports the violation; with it, the child's text is untouched and the check is empty.

A re-cut also takes the base table's triggers down with it while the fts5 shadow and its rows survive, so `fts.ts` gains `ftsSyncTriggersFor(entity)` — the three sync triggers and nothing else, emitted by the **same generator** `entityDdl` uses, because a hand-typed copy would be a second spelling of one contract. `entityDdl` now calls it, so there is one source for the trigger text.

### Scenarios, each red before the change

| Scenario | Where | Red without | Green with |
| --- | --- | --- | --- |
| An end-dated primary does not block a new primary | `party-identifier-interval.test.ts` | UNIQUE violation on `idx_party_identifier_primary` | ✓ |
| Two live primaries for one (party, scheme) still refused | same | (guard — passes both ways) | ✓ |
| An inverted interval is refused | same | stored happily | ✓ |
| The same short handle in two issuers is two identities | same | column does not exist | ✓ |
| 猫, 犬, कुत्ता and बिल्ली are four concepts | `enrich-publishers.test.ts` | all four slug to `untitled`, one concept | ✓ |
| The same label still selects one concept | same | (guard) | ✓ |
| Bank A and Bank B may both import `ref-1` | `source-scoped-external-id.test.ts` | second import merges into the first | ✓ |
| Re-importing the same source is idempotent | same | (guard — the sync map, unchanged) | ✓ |

Red-first evidence: with rung six commented out, `party-identifier-interval.test.ts` is **3 failed / 1 passed**; with `publishers.ts` and `migrate.ts` stashed, `source-scoped-external-id.test.ts` is **1 failed / 1 passed**. Both restored immediately.

### Gates

```sh
bun run --cwd packages/vault test        # 193 files, 1576 passed, 2 skipped, 0 FAIL
bun run --cwd packages/vault typecheck   # clean
bun run --cwd packages/blueprints typecheck && bun run --cwd packages/core typecheck
bun run --cwd packages/server typecheck  && bun run --cwd packages/client typecheck
bun run lint                             # 0 findings
bun run format:check                     # all matched files formatted
bash .governance/run.sh                  # 22/22
```

`golden-vault.test.ts` is green on `packages/vault/tests/golden/issue-929/vault.db.gz` **without re-freezing it**: every frozen row survives all three rungs, the migrated file's schema text equals a fresh build's object for object, `vault doctor` is clean, and `PRAGMA foreign_key_check` over the re-cut file is empty.

### Seams handed to wave 0c (`file:line` lists in the root agent's scratchpad, `w0b-seams.txt`)

- **Document history over `core_link`** — 28 non-test sites in 7 files: `packages/vault/src/commands/revisions.ts` (whole file), `documents.ts:33,675,804,927`, `knowledge.ts:20,266,846`, `gateway/duties.ts:148,779`, `packages/blueprints/apps/docs/queries/history.ts:15,60,64,69,82`, `apps/notes/version-chain.ts:33,56`, `apps/mobile/src/apps/docs/docs-versions.ts:8,60,65,72,76`. Plus the `restore_document_version` **postcondition** at `documents.ts:894-910`, which asserts the `revises` link exists — a reader of the second graph inside the command that writes it.
- **`external_id` read without a connection scope** — after this wave, none in the ontology: the only remaining unscoped reads are `packages/server/src/automation/worker/runner.ts:369` and `routes/import-routes.ts:320`, both over `outbox_item` / staging rows rather than `core_transaction`. `accountFor`'s display-name match (`packages/vault/src/ingest/publishers.ts:490-497`) is **0c's**, per the issue's own wave split.
- **`original_start` / `time_zone`** — 47 non-test sites; the schema is already correct (see Decisions), so every one is a reader or a command input name: `packages/vault/src/commands/tally-organize.ts` ×11, `schedule-organize.ts` ×5, `packages/blueprints/apps/agenda/{edits,types}.ts` ×5, `agenda/queries/upcoming.ts:65,256,258,286,287,291,296,344`, `apps/tally/{types,schedule-model,writes,pending-projection,compose-states-kit}.ts` ×7, `tally/queries/dashboard.ts:90,814,820`, `tally/components/Recurring.tsx:109`, `apps/mobile/src/apps/agenda/{AgendaEventEditor.tsx:145,188,useAgenda.ts:112}`, `apps/tally/TallyRecurringScreen.tsx:88`, `screens/home/useSpringboardTiles.ts:292`.
- **`core_content_item.title` and `media_type`** — 10 non-test sites name the title column directly; `media_type` has **251 non-test sites** and `core_content_item` is named by **117 files**. The FTS spec for `core.content_item` indexes `title` (`packages/vault/src/schema/fts.ts:76-83`), which is the caption surface the representation split moves.

## Decisions — wave 0b

- **The 0b box is left unticked, and four of its eight clauses are not in this diff.** What landed is listed above. What did not, and why, measured rather than asserted:
  - **The revision occurrence (item 1).** Bounded but large: 28 non-test call sites across 7 files spanning `packages/vault`, `packages/blueprints` and `apps/mobile`, plus the `restore_document_version` postcondition and the Notes and Docs history readers on two surfaces. The schema half is cheap — `ALTER TABLE … ADD COLUMN` for `core_entity_revision.content_id` / `parent_revision_id` and the wrapper pointers — and the writer/reader half is a slice of its own. Landing the schema without the readers would leave TWO history mechanisms rather than one, which is the finding ONT-22 already files. Recommend re-slicing as **0b-2**, schema and all seven files in one commit.
  - **The representation split (item 2).** Out of reach for one commit and not close: `media_type` has 251 non-test sites, `core_content_item` is named by 117 files, and the column the split removes from that table (`title`) is indexed by its own FTS spec, so the change lands in the search index, the replica shapes, eight app manifests and both mobile seats at once. Recommend **0b-3** as its own wave with its own gate, ordered before wave 4 rewrites the handlers.
  - **Deletion roles beside references (R22).** Not attempted: it is a declaration over every FK in the model, and its shape (a column annotation, a registry map, or a census) is not settled by R22's sentence. Recommend it rides 0e, where the purge-behaviour-per-role tests live.
- **Item 4 (the occurrence key and the `tz` spelling) has NO schema work left, and the brief's premise is contradicted by the tree.** The brief asks for "the typed occurrence key column set … and one `tz` column name across `time-organize.ts`". Both already hold on `main`: the exception is keyed `(target_type, target_id, original_start_local, scope)` and carries `recurrence_semantics` (`packages/vault/src/schema/time-organize.ts:72-104`), `tally_recurring_expense` spells its zone `tz` (`time-organize.ts:168-169`), and `ontology-rules.test.ts:182,197` already asserts that `time_zone` and `original_start` are absent from the schema. ONT-25 is therefore **entirely reader-side** — 47 sites, listed above, every one of them a query or a command input name reading a column that does not exist — which is exactly what the *reader-side drift* category wave 0a introduced was for. Written as found; not resolved here.
- **"The publisher probes the pair" is realized by DELETING the probe, not by adding a lookup.** `stageCandidates` already consults `sync_external_entity (connection_id, external_id)` — the authoritative key — **before** any publisher probe (`packages/vault/src/ingest/staging.ts:170-210`), and the publisher's probe ran only on a miss. A miss on the pair means this connection has not imported this id, so the honest disposition is `create`; a second lookup inside the publisher would be a duplicate spelling of the check that already happened. The global probe is gone and idempotency is unchanged, which the second scenario holds.
- **"The migration carrying existing mappings forward from the sync map" was a no-op, and that is the right answer.** `sync_external_entity` already holds every `(connection_id, external_id) → row` mapping and is untouched by the re-cut; `core_transaction.external_id` keeps its values. There is nothing to carry forward, so rung seven carries nothing.
- **The live identifier index changed shape, deliberately.** `core_party_identifier_live_idx` becomes `(scheme, COALESCE(issuer,''), value)`. Folding NULL to the empty string is what keeps the pre-#996 property exact — two rows with the same scheme and value and no issuer still collide — while letting two issuers hold the same short handle. A bare `(scheme, issuer, value)` would not: SQLite treats NULLs as distinct in a UNIQUE index, so every existing identity fork would have become legal.
- **`ensureConcept` backfills `normalized_key` on touch, and rung six does not.** NFKC is not a SQLite function, so a rung cannot compute the key for rows minted before this wave. The rung leaves them NULL (both new indexes are partial) and `ensureConcept` falls back to the slug ONCE, verifies the label agrees, and stamps the key. A rung that guessed the value would be worse than one that admits it cannot.

## Wave 0b — R13 corrected

`docs/decisions.md` R13 said "the recovery kit **and the backup** carry every live key file". The tree keeps long-lived key material out of every snapshot by construction (`packages/server/src/backup/backup-sources.ts:1-4` — "Long-lived keys never enter a snapshot"), and `SECURITY.md:37` names the on-disk `keys/` directory as being *outside* backup. The clause now says what holds: the passphrase-wrapped **recovery kit** carries every live key file — `K`, and `K′` while a rotation is in flight — and the backup snapshot never does. One sentence changed; the rest of R13 is untouched.

## Wave 0b — history and representation

The second half of the ontology bridge's schema wave, under the owner ruling recorded below: **pre-1.0, legacy carries no weight** — the baseline is edited in place and the golden corpus is re-frozen in the same slice, with no rungs, no re-cut machinery and no carry-forward. **Item 1 (the revision occurrence) lands whole. Item 2 (the representation split) does not** — see `## Decisions — wave 0b (second half)`. The 0b checklist box therefore stays unticked.

### The ladder is one baseline again

`b22cc7188` added rungs six to eight, a `VaultMigration = string | { recut }` extension to `migrate.ts`, and `schema/core-rungs.ts`. All of it is folded back here: `packages/vault/src/schema/migrate.ts` is its pre-`b22cc7188` shape plus one line (`CONTENT_TEXT_DDL` in the composed baseline), `core-rungs.ts` is deleted, `baseline-fixture.ts` and `migrate.test.ts` are reverted, and every #996 shape now lives in the module that owns the table:

| Table | Shape, now stated in the baseline | Module |
| --- | --- | --- |
| `core_party_identifier` | `issuer`, the forward-running interval CHECK, the live value index keyed `(scheme, COALESCE(issuer,''), value)`, the primary index partial on `is_primary = 1 AND valid_to IS NULL` | `schema/core.ts` |
| `core_concept` | `stable_id`, `normalized_key`, `pref_label_lang` and their two partial UNIQUE indexes | `schema/core.ts` |
| `core_transaction` | no global `UNIQUE` on `external_id`; a partial index on it instead | `schema/core.ts` |
| `core_content_text` | the decoded-body-text side table | `schema/core.ts` |
| `core_entity_revision` | `content_id`, `parent_revision_id`, both `ON DELETE SET NULL`, and their two partial indexes | `schema/entity-revisions.ts` |
| `core_document` | `current_revision_id` + its index | `schema/core.ts` |
| `knowledge_note` | `current_revision_id` + its index | `schema/domains-social-knowledge-media.ts` |

`VAULT_MIGRATIONS` is five rungs again and a fresh vault stamps `PRAGMA user_version = 5`, which `schema/migrate.test.ts` asserts unchanged from before `b22cc7188`. The corpus at `packages/vault/tests/golden/issue-929` is re-frozen with `bun run golden-vault:freeze -- --label issue-929` — 67 tables, 273 rows, schema v5, ontology 1.0 — and `golden-vault.test.ts` is green on it across all four cases.

### Item 1 — a revision is an occurrence, not a content id (ONT-22, R20(a))

`core_entity_revision` is the one history, and the second graph is gone. An **occurrence** is a row there whose `operation` is `'revise'`: it names the content that became current at that moment and the occurrence before it; the wrapper points at the newest. Every other row is the engine's pre-mutation capture snapshot, bounded by the entity's declared retention — an occurrence is not (**OQ-11**), which `gateway/revision-capture.ts` now enforces by pruning only `operation <> 'revise'`.

`commands/revisions.ts` is rewritten: `recordRevision` and the `revises` concept lookup are gone; `recordBodyRevision`, `currentRevisionOf`, `revisionChainOf` and the typed `ForeignRevisionError` replace them. `bootstrap.ts` no longer seeds the `revises` relation at all — nothing writes the edge it named, and dormant DDL is a finding (#916, ONT-06).

All five write sites and every reader moved in this slice; none keeps the link graph alive:

| Site | Was | Is |
| --- | --- | --- |
| `commands/documents.ts` — `add_document`, `edit_document`, `replace_document_content`, `restore_document_version` | `recordRevision(new, old)`; a recursive `core_link` CTE in `target_in_chain`; a postcondition asserting the `revises` link | an occurrence per body change including the first; a recursive walk over `parent_revision_id`; a postcondition on the wrapper's own newest occurrence |
| `commands/knowledge.ts` — `add_note`, `edit_note`, `restore_note_version` | the same three | the same three, over `knowledge_note.current_revision_id` |
| `gateway/duties.ts` — the purge sweep | a BFS over live `revises` edges, plus `ownedByAnotherLiveDocument` walking the shared graph | one recursive CTE per document's own chain; the "is this page another live document's" question is now asked of that document's occurrences, which is the point — two documents with identical bytes no longer purge each other's pages |
| `blob/read.ts` — the serve door | a recursive walk from the requested page toward newer edges | one indexed lookup on `core_entity_revision.content_id` |
| `blueprints/apps/docs/queries/history.ts` | resolve the `revises` concept out of `core.concept` + `core.concept_scheme`, then one `core.link` read PER STEP | one `core.entity_revision` read, walked in memory |
| `blueprints/apps/notes/queries/history.ts` | the same, per step | the shared `noteVersionChain` walk |
| `packages/blueprints/apps/notes/version-chain.ts` (and `version-chain.test.ts`, deleted with the shape it tested) | a link-edge index keyed by content | the occurrence walk, now shared by the web query AND the phone so both seats read one spelling |
| `apps/mobile/src/apps/docs/{docs-versions,useVersionChain}.ts` | `core.link` + `core.concept` + `core.concept_scheme` replica reads and a concept resolution | one `core.entity_revision` read |
| `apps/mobile/src/apps/notes/{useNotes,useNoteVersions,NotesHistory,notes-model}.ts` | `chainRows: { links, concepts, schemes }` | `chainRows: { revisions }`, and the note projection carries `currentRevisionId` |
| `gateway/assistant-context.ts` | told the assistant history was a `revises` chain | tells it what is true |

Both manifests declare the entity they now read — `packages/blueprints/apps/docs/app.json` and `packages/blueprints/apps/notes/app.json` gain a `core.entity_revision` read scope, and `packages/blueprints/src/app-manifest-reads.test.ts`'s matrix names it. The static tripwire is what caught the omission, twice.

### Scenarios (`packages/vault/src/commands/revision-occurrence.test.ts`, red-first)

| Scenario | Before | After |
| --- | --- | --- |
| Two documents with identical bytes keep separate histories | one shared chain — the bytes dedupe, and the edge out of them was in both | A's edit is A's; B still reads one version |
| A→B→A→B is four occurrences, in order | three, and the fourth edge was refused by `core_link_live_edge_idx` | `[a, b, a, b]`, two content ids and four versions |
| Restoring another document's revision is refused | accepted — "is this content in the chain" was asked of a shared graph | refused; the document's own earlier version still restores |
| No `revises` link, and no `revises` concept, survives an edit | the edge and the seeded concept | zero of each |

`documents.test.ts` and `knowledge.test.ts` keep their older assertions, re-cut onto occurrences — including the one that used to document the finding out loud ("a content-id walk can only show one node once, so the convenience chain collapses"), which is now the assertion that it does not.

### Every file this commit touches

- `apps/mobile/src/apps/docs/DocumentRead.tsx`
- `apps/mobile/src/apps/docs/DocumentVersions.tsx`
- `apps/mobile/src/apps/docs/docs-versions.test.ts`
- `apps/mobile/src/apps/docs/docs-versions.ts`
- `apps/mobile/src/apps/docs/useVersionChain.ts`
- `apps/mobile/src/apps/notes/NotesHistory.test.tsx`
- `apps/mobile/src/apps/notes/NotesHistory.tsx`
- `apps/mobile/src/apps/notes/notes-model.ts`
- `apps/mobile/src/apps/notes/useNoteVersions.ts`
- `apps/mobile/src/apps/notes/useNotes.ts`
- `packages/blueprints/apps/docs/app.json`
- `packages/blueprints/apps/docs/queries/history.test.ts`
- `packages/blueprints/apps/docs/queries/history.ts`
- `packages/blueprints/apps/notes/app.json`
- `packages/blueprints/apps/notes/queries/history.test.ts`
- `packages/blueprints/apps/notes/queries/history.ts`
- `packages/blueprints/apps/notes/version-chain.test.ts`
- `packages/blueprints/apps/notes/version-chain.ts`
- `packages/blueprints/src/app-manifest-reads.test.ts`
- `packages/vault/src/blob/read.ts`
- `packages/vault/src/bootstrap.ts`
- `packages/vault/src/commands/documents.test.ts`
- `packages/vault/src/commands/documents.ts`
- `packages/vault/src/commands/knowledge.test.ts`
- `packages/vault/src/commands/knowledge.ts`
- `packages/vault/src/commands/revision-occurrence.test.ts`
- `packages/vault/src/commands/revisions.ts`
- `packages/vault/src/gateway/assistant-context.ts`
- `packages/vault/src/gateway/duties.ts`
- `packages/vault/src/gateway/revision-capture.ts`
- `packages/vault/src/schema/baseline-fixture.ts`
- `packages/vault/src/schema/core-rungs.ts`
- `packages/vault/src/schema/core.ts`
- `packages/vault/src/schema/domains-social-knowledge-media.ts`
- `packages/vault/src/schema/entity-revisions.ts`
- `packages/vault/src/schema/migrate.test.ts`
- `packages/vault/src/schema/migrate.ts`
- `packages/vault/tests/golden/issue-929/manifest.json`
- `packages/vault/tests/golden/issue-929/vault.db.gz`
- `scripts/docs-site/src/content/ontology-body.html`

`schema/migrate.ts`, `schema/migrate.test.ts` and `schema/baseline-fixture.ts` are reverted to their pre-`b22cc7188` shape (plus one baseline line for `CONTENT_TEXT_DDL`); `schema/core-rungs.ts` and `apps/notes/version-chain.test.ts` are deleted; `commands/revision-occurrence.test.ts` is new; the two golden files are re-frozen; `ontology-body.html` re-orders §03 for `core.document`, `core.concept`, `core.entity_revision` and `knowledge.note` to the baseline's own column order.

### Gates

```sh
bun run --cwd packages/vault test        # 194 files, 1580 passed, 2 skipped, 0 FAIL
bun run --cwd packages/blueprints test   # 0 FAIL
bun run --cwd apps/mobile test -- src/apps/docs src/apps/notes   # 19 files, 148 passed
bun run --cwd packages/{vault,blueprints,core,server,client} typecheck && bun run --cwd apps/mobile typecheck
bun run lint && bun run format:check
bash .governance/run.sh
bun run golden-vault:freeze -- --label issue-929   # 67 tables, 273 rows, schema v5
```

## Decisions — wave 0b (second half)

- **The owner's ruling, recorded: pre-1.0, legacy carries no weight.** Baseline DDL changes in place and the corpus is re-frozen in the same slice; no migration rungs, no re-cut machinery, no data carry-forward, no compatibility paths. This is the repo's own **ONT-ladder** rule for this era ([vault-ontology.md](../docs/vault-ontology.md) — "Pre-1.0, no release since the freeze"), and it retires the rung/re-cut machinery `b22cc7188` added, in this commit.
- **The ONT-ladder rule's pre-proof could not be performed, and that is a property of the change, not a skipped step.** The rule asks that the OLD corpus first be shown to open, migrate forward, keep every row and be doctor-clean, with only the DDL-equality case red. It does not open: `core_content_text` is a NEW TABLE in the baseline, `refreshReplicaTriggers` is generated from the entity registry, and it fails with `no such table: main.core_content_text` before any assertion runs. A frozen file cannot receive a new baseline table without a rung — which is exactly the machinery the ruling removes. Recorded rather than worked around; the corpus is re-frozen and the gate is green on the corpus this slice froze.
- **Item 2, the representation split, is NOT in this commit.** It is the third time it has been scoped and the second time it has not fitted; the measured reason has not changed and the no-legacy ruling does not shrink it. `core_content_item.media_type` is read at **53 non-test sites across 29 files**, and the removal is not mechanical at three of them: the FTS specs for `core.content_item`, `knowledge.note` and `core.document` call `vault_content_text(c.media_type, c.content_uri)` inside GENERATED triggers, so dropping the column re-cuts the search index for three entities in the same change that moves the caption surface off `core_content_item.title` — and W1 is already scheduled to retire `vault_content_text` for `core_content_text`. Doing both at once is the right sequencing and it is a wave, not the tail of one. What a follow-up slice needs, in order: (a) `core_content_representation(representation_id, content_id, owner_type, owner_id, media_type, charset, interpretation)` with `UNIQUE(owner_type, owner_id)`; (b) `media_asset.title` for the authored title the caption was overwriting; (c) one resolver in `packages/vault` every query calls, so the change is one spelling; (d) writers `blob/{mint,promote,preflight,preview}.ts`, `commands/{documents,media,attachments}.ts`, `ingest/{publishers,enrich-publishers,stage-file}.ts`; (e) the three FTS specs and `schema/blob.ts`'s document override; (f) the wire-type sites, which keep `media_type` on the row and are populated at the query boundary — `blueprints/apps/docs/{filters,format,print}.ts`, its six components, `apps/mobile/src/apps/docs/{docs-projection,document-read-model,docs-export,DocumentViewer,DocumentRead,DocumentProperties}.tsx`.
- **Deletion roles ride 0e** (root ruling, accepted), with the deletion-by-role purge scenarios.
- **Item 4, the occurrence key, has no schema work** (root ruling, accepted): the columns and the `tz` spelling are already right on `main`, `ontology-rules.test.ts:182,197` already asserts it, and ONT-25's 47 sites are all reader-side. It goes to 0c.
- **An occurrence at CREATION, not only at edit.** R20(a) says a revision is an occurrence; a document's original body is a version, so `add_document` and `add_note` write the first one. Without it the oldest version would have had to be inferred from the absence of a parent, and "A→B→A→B is four occurrences" would have been three.
- **The three new foreign keys are `ON DELETE SET NULL`, and the first one had to be.** `core_entity_revision.content_id` was written `RESTRICT` first and the purge sweep went red: a foreign key from history refused to let an owner reclaim their own document's bytes. An occurrence survives its content as the record that there WAS a version there.

## Wave 0b — the representation split

The last item of the schema wave, and the one that had been scoped three times without fitting (`## Decisions — wave 0b (second half)`). It lands whole here, under the same owner ruling: **pre-1.0, legacy carries no weight** — the baseline DDL is edited in place, the golden corpus is re-frozen in the same slice, no rungs, no compatibility views, no carry-forward. `core_content_item.media_type` and `core_content_item.title` do not survive as columns.

### The shape

| Table | What changed |
| --- | --- |
| `core_content_item` | **Bytes alone**: `media_type` and `title` are gone. `content_uri`, `sha256` (UNIQUE), `byte_size`, `language`, creator, origin device, the trash pair and the timestamps stay. |
| `core_content_representation` | **New entity** (`core.content_representation`): `representation_id` PK, `content_id` FK (`ON DELETE CASCADE`), the polymorphic owner `(owner_type, owner_id)` as a composite FK into `core_entity` (`ON DELETE CASCADE`) with `UNIQUE (owner_type, owner_id)`, `media_type NOT NULL`, `charset`, `interpretation`, `created_at`/`updated_at`. Deliberately **not** in `CONTENT_REFERENCES`: it dies with its owner and never keeps bytes alive on its own. |
| `media_asset` | Gains `title` — the owner's **authored** title, which a generated caption used to overwrite on the shared byte row. |

An **entity**, not a projection, because a generated caption is a derived row **keyed to the representation** (OQ-9) and `knowledge_annotation.target_*` is a composite FK into `core_entity`: a caption cannot point at something the supertype does not know.

### The one resolver

`packages/vault/src/schema/representation.ts` is the single spelling: `mediaTypeSql(ownerTypeExpr, ownerIdExpr)` and `contentMediaTypeSql(contentIdExpr)` for SQL, `mediaTypeOfOwner` / `mediaTypeForContent` / `representationIdOf` for TypeScript, and `setRepresentation` as the one writer (idempotent on `(owner_type, owner_id)`). `contentMediaTypeSql` is the answer for a caller with **no owner in hand** — the read door, the enrichment backlog, custody routing — and it is deterministic (oldest representation by `created_at`, then id), not arbitrary.

`UNCLAIMED_OWNER_TYPE = "core.content_item"` is the sanctioned owner for bytes no wrapper claims yet. It is not ONT-28 returning: a document, note or asset that arrives later gets its **own** row and reads the bytes its own way.

### FTS

`vault_content_text` itself is untouched (W1 retires it for `core_content_text`). What changed is where its first argument comes from:

- `valueExpr`'s `content` kind now decodes with `mediaTypeSql('<spec.entity>', new."<idColumn>")` — so `knowledge.note` and `social.message` decode by **their own** reading, and `schema/blob.ts`'s `DOCUMENT_BODY` does the same for `core.document`.
- The `core.content_item` spec's `title` is a new `expr` column kind (`OWNED_TITLE_SQL`) over the **owning asset's** authored title, with `foldsIn: ["media.asset"]` so a grant must consent to that entity too. `media_asset`'s own AI/AU/AD triggers keep the content item's index in step with a rename.
- The dead `self-content` kind — declared, used by no spec, and unimplementable once bytes lost their media type — is deleted.
- **Ordering fix, found red**: a representation is written **after** its wrapper (the owner row must exist first), so the wrapper's `_ai` had already run with nothing to decode by, and a fresh note's body was unsearchable. `ftsRefreshStatement` (generated from the same spec) plus two triggers on `core_content_representation` put the index back in step the moment the reading lands.

### Scenarios

`packages/vault/src/schema/representation-split.test.ts` — four, all through real commands and read back the way a screen reads them:

| Scenario | Claim held |
| --- | --- |
| One byte row, two documents | `add_document` twice over identical bytes as `text/html` then `text/plain`: **one** `core_content_item` row, `deduped: 1`, and two readings — `text/html` and `text/plain`. `core_content_item` has no `media_type` column at all. |
| A note and a document over one sha | The note keeps `text/html`, the document `text/plain`, over the same `content_id`. This is `contentItemFor`'s old bug: the first writer's format won for everyone. |
| Caption → derived row → promote | A staged `knowledge.annotation` caption lands on the **representation**, the owner's typed `media_asset.title` survives it, a re-caption replaces the derived row and still does not touch the title, and `media.promote_caption` (OQ-9's one tap) copies the caption into the authored title while the derived row stays. |
| Mint → read door | `resolveServableBlob` serves `image/png` from the representation and the wrapper's title; re-typing the asset's reading changes what the door serves and leaves the bytes alone. |

### Captions, and "derived rows never project"

`ingest/enrich-publishers.ts`'s annotation publisher **redirects** a caption aimed at an asset, document, note or attachment onto that owner's representation (`captionTarget`), so the one-caption-per-(author, target) replace rule still holds and `knowledge.annotation`'s own FTS index still finds it. `media.promote_caption` is the only path from a caption to an authored title, and it is an owner action with the owner's name on it.

The filing publisher's rename proposal now renames a **wrapper** — `core_document.title` where the content has a document, `media_asset.title` where it has an asset — because bytes have no title for it to reach past the wrapper into. A **remote content stub** (a connector listing a Drive file) now mints the `core.document` wrapper it always described, with its own representation; it used to be a bare content item carrying the source's title and media type on the byte row, which is exactly ONT-28's shape.

### Site accounting

The 53 non-test `media_type` sites, one of three ways:

- **Moved to the resolver — 23 files** (`schema/representation.ts` is the 24th, the resolver itself): `blob/{mint,promote,preflight,preview,read,store-routing}.ts`, `commands/{attachments,documents,knowledge,media,outbox,social,tally}.ts`, `enrich/leases.ts`, `gateway/{cards,portable-adapters}.ts`, `ingest/{enrich-publishers,publishers}.ts`, `schema/{blob,fts}.ts`, `share/{placement-fixture,project-closure,read-closure}.ts`. `gateway/assistant-context.ts` is prose and says the new shape.
- **Wire boundary — 17 files** keep a `media_type` FIELD, populated at the query boundary through one shared reader: `packages/blueprints/apps/_shared/representation-reads.ts` (`readRepresentations` → `byOwner` / `byContent`), used by `docs/queries/{drive,history,search}.ts`, `photos/queries/{library,search,duplicates}.ts`, `notes/queries/{library,search,history}.ts`, `agenda/queries/{upcoming,search}.ts`, `tasks/queries/{board,search}.ts`, `tally/queries/dashboard.ts`, `locker/queries/item-sidecars.ts`; and on the seat `apps/mobile/src/apps/docs/{docs-projection,docs-versions}.ts` with `useDocs.ts` / `useVersionChain.ts` reading the new replica entity.
- **Listed, with a reason — 5 surfaces** that were never `core_content_item.media_type` and are untouched: `blob_staging.media_type` (what the upload said on arrival), `core_content_derivative.media_type` (the variant's own type), `blob_transfer.media_type` (transfer state), the ACP wire's `mimeType` (`server/src/acp/multimodal.ts`, `docs/harnesses.md` — ACP's field name, not ours), and the mobile upload outbox's own `media_type` column (`apps/mobile/src/lib/upload/store.ts`, a seat-local queue, not the vault).

Downstream consequences worth naming: the closure's `ContentItemRow` keeps `media_type` as a **wire field** (read at the boundary, written back as the audience's own representation) and loses `title`, which moves to `MediaAssetRow`; `subscription-delta.ts` excludes `media_type` from the content item's field comparison because there is no column to compare against; and eight replica shape ids moved because seven app manifests gained a `core.content_representation` read scope (`replica-shape-parity.test.ts` re-frozen).

### Files

**Vault schema** — `schema/core.ts` (byte-only content item + `CONTENT_REPRESENTATION_DDL`), `schema/representation.ts` (new), `schema/domains-social-knowledge-media.ts` (`media_asset.title`), `schema/entity-catalog.ts`, `schema/fts.ts`, `schema/blob.ts`, `schema/representation-split.test.ts` (new).
**Vault ingest, split out of `enrich-publishers.ts`** — `ingest/caption-target.ts` (where a generated caption hangs), `ingest/content-item-publisher.ts` (filing, renames and the remote listing), `ingest/concept-writes.ts` (the shared find-or-mint, extracted to break the import cycle the split would otherwise have made). All three are moves plus the change this commit makes, not new behaviour; `index.ts` re-points `tagNotation` at its new home.
**Vault writers/readers** — `blob/{mint,promote,preflight,preview,read,store-routing}.ts`, `commands/{attachments,documents,knowledge,media,outbox,people,social,tally}.ts`, `enrich/leases.ts`, `gateway/{assistant-context,cards,execution,portable-adapters,types}.ts`, `ingest/{enrich-publishers,publishers}.ts`, `share/{closure,container-routing,placement-fixture,project-closure,read-closure,subscription-delta}.ts`.
**Blueprints** — `apps/_shared/representation-reads.ts` (new), the sixteen query handlers above, `apps/locker/{types.ts,components/ItemSidecars.tsx}` (an attachment row is named by its role, since bytes have no title), seven `app.json` manifests (read scope + the `writes` arrays of the eleven actions that mint a representation), `src/app-entity-tripwire.ts`.
**Mobile** — `apps/docs/{docs-projection,docs-versions,useDocs,useVersionChain}.ts`.
**Server** — `src/lifecycle/automation-anchor-scopes.ts` (an anchor decodes by its source row's reading).
**Docs and evidence** — `docs/vault-ontology.md` (ONT-28 **closed**), `scripts/docs-site/src/content/ontology-body.html`, `scripts/golden-vault/build.mjs`, and the re-frozen `packages/vault/tests/golden/issue-929/`. `packages/blueprints/manifest.json` carries one line that is not this commit's work: `e03345d6c` deleted `apps/notes/version-chain.test.ts` without re-running `build:manifest`, and the generated file still named it. Regenerated here rather than left stale, and named rather than folded in silently.

### Gates

```sh
bun run --filter @centraid/vault test        # 195 files, 1583 passed, 2 skipped, 1 pre-existing FAIL
bun run --filter @centraid/blueprints test   # 212 files, 7064 passed, 2 expected fail, 0 FAIL
npx vitest run --root apps/mobile src/apps/docs src/apps/notes src/apps/photos  # 74 files, 761 passed
bun run --filter @centraid/server test       # 387 files, 3452 passed, 3 pre-existing FAIL (sandbox/root and a missing sqlite3 binary)
bun run --filter @centraid/vault typecheck && bun run --filter @centraid/blueprints typecheck
bun run --filter @centraid/core typecheck && bun run --filter @centraid/server typecheck
bun run --filter @centraid/client typecheck && bun run --filter @centraid/mobile typecheck   # all 0
bun run lint && bun run format:check         # clean
bash .governance/run.sh                      # 22/22
bun run --filter @centraid/vault build && bun run golden-vault:freeze -- --label issue-929   # 67 tables, 289 rows, schema v5
```

The one red vault test — `party-identifier-interval.test.ts > an end-dated primary does not block a new primary for the same scheme` — is **pre-existing**: it fails identically on this tree with every change stashed. It is `b22cc7188`'s, not this commit's, and is left for the lane rather than fixed silently here.

## Decisions — wave 0b (the representation split)

- **A representation is an ENTITY, and it had to be.** The obvious cheap shape is a projection keyed by `(owner_type, owner_id)`, with no `core_entity` membership to maintain. It cannot work: OQ-9 says a generated caption is a derived row **keyed to the representation**, and `knowledge_annotation` targets `core_entity(entity_type, entity_id)`. A caption cannot point at a row the supertype does not know, so the representation carries its own id and its own membership.
- **A representation is not a renter of the bytes.** It is deliberately absent from `CONTENT_REFERENCES`. Adding it would have made every reading keep a content item alive past its owner's delete — a lifetime the owned-child role (R22) already says belongs to the owner.
- **Where an unwrapped byte row's reading lives, and why that is not ONT-28 returning.** `UNCLAIMED_OWNER_TYPE` lets a content row own its own reading until a wrapper arrives (a staged blob, a connector stub). The defect ONT-28 named was that a LATER owner inherited the FIRST import's answer; here a later document, note or asset gets its own row. The content-keyed resolver is used only where no owner is in hand, and it is deterministic rather than "whichever row SQLite returns".
- **A remote connector listing now mints a document.** It had no wrapper, so under R20(b) it had nowhere to put the source's title — which is the same sentence as "it was storing an interpretation on bytes". Making it the `core.document` it already described is the smaller change, not the larger one: the sync map still keys on the content id, and `ENRICH_CLASS_OF` is untouched.
- **A filing proposal renames a wrapper; it is still owner-reviewed.** `core.content_item` filing stays in the `filing` enrich class, which defaults to staged-for-review and only auto-publishes under standing consent (`sync.set_connection_trust`). The change is the TARGET, not the trust: `core_document.title` or `media_asset.title`, never a title on bytes.
- **Photos search over a GENERATED caption now goes through `knowledge.annotation`, not `fts_core_content_item`.** The content item's index folds in the owning asset's AUTHORED title and its extracted text/transcript; a machine's caption is indexed under its own entity, which is where a derived row belongs. Named here rather than left as a quiet behaviour change; the Photos search handler is untouched and a caption is still findable.
- **An attachment has no title, and `core.attach` lost its `title` input.** The option wrote `core_content_item.title`. An attachment is bytes pinned to a row — what a file is CALLED belongs to a wrapper, and an attachment is not one. The archive's filename now lands on `media_asset.title` for an imported photo (where it always did, via `promoteStagedBlob`'s `original_name` fallback) and nowhere else.
- **`promoteStagedBlob` returns the staging band's reading, never the deduped row's.** Both it and `mintContentFromDataUri` used to read the media type back off the row they had just deduped against — which IS the ONT-28 defect, in the two functions every claiming command calls. They now answer with what THIS arrival declared, and the claiming command writes it onto its own representation.

## Wave 0c prelude — the identifier-interval scenario's clock

`packages/vault/src/schema/party-identifier-interval.test.ts > an end-dated primary does not block a new primary for the same scheme` was red on `d96172c40` and named pre-existing by the wave 0b sections above. Root-caused here before the lane opened.

**It is not the index.** The hypothesis on the way in was that `e03345d6c`'s fold of `b22cc7188`'s migration rungs back into the baseline had lost the primary-preference partial index or the interval CHECK. Both survived intact — `sqlite_master` on a freshly bootstrapped vault reports `CREATE UNIQUE INDEX idx_party_identifier_primary ON core_party_identifier(party_id, scheme) WHERE is_primary = 1 AND valid_to IS NULL` and the table-level `CHECK (valid_to IS NULL OR valid_to >= valid_from)`, exactly as `packages/vault/src/schema/core.ts:103-110` writes them. No DDL changed in this commit, so the golden corpus is not re-frozen.

**It is the scenario's clock.** The failing assertion was the retirement, not the replacement: `atlas.update_row` returned `failed` with `CHECK constraint failed: valid_to IS NULL OR valid_to >= valid_from`. `core.add_party` stamps `valid_from` from the gateway's wall clock (`packages/vault/src/commands/parties.ts:127-137`, `ctx.now`), while the file retired the row at a fixed `2026-09-06T10:00:00.000Z`. R20(e)'s own invariant — an interval runs forward — then refuses the update for every run that starts after 10:00Z on that day, which is why the file was green when `b22cc7188` was authored and red for every run since. A fixed hour of a fixed day is a time bomb, not a fixture. The scenario now retires at `Date.now() + 60_000`: one instant, shared by every assertion in the file, always at or after the one the register minted.

### Verification

```sh
bun run --filter @centraid/vault test src/schema/party-identifier-interval.test.ts   # 4 passed
bun run --filter @centraid/vault test                                                # 195 files, 1584 passed, 2 skipped, 0 failed
```

The vault suite has no red test left on this tree; the "1 pre-existing FAIL" line in the three wave 0b sections above is closed by this commit.

### Files of d96172c40 not named above

`d96172c40`'s wave 0b section lists its surface by directory glob; `receipt-per-issue`'s file-coverage rule matches paths, so these are named verbatim. Append-only, no claim beyond "this commit touched them":

- `apps/mobile/src/apps/docs/docs-projection.test.ts`
- `apps/mobile/src/apps/docs/docs-projection.ts`
- `apps/mobile/src/apps/docs/useDocs.ts`
- `packages/blueprints/apps/agenda/app.json`
- `packages/blueprints/apps/agenda/queries/search.ts`
- `packages/blueprints/apps/agenda/queries/upcoming.ts`
- `packages/blueprints/apps/docs/queries/drive.ts`
- `packages/blueprints/apps/docs/queries/search.ts`
- `packages/blueprints/apps/locker/app.json`
- `packages/blueprints/apps/locker/components/ItemSidecars.tsx`
- `packages/blueprints/apps/locker/item-sections.test.tsx`
- `packages/blueprints/apps/locker/queries/item-sidecars.ts`
- `packages/blueprints/apps/locker/types.ts`
- `packages/blueprints/apps/notes/queries/library.ts`
- `packages/blueprints/apps/notes/queries/search.ts`
- `packages/blueprints/apps/people/app.json`
- `packages/blueprints/apps/photos/app.json`
- `packages/blueprints/apps/photos/queries/duplicates.ts`
- `packages/blueprints/apps/photos/queries/library.ts`
- `packages/blueprints/apps/photos/queries/search.ts`
- `packages/blueprints/apps/tally/app.json`
- `packages/blueprints/apps/tally/queries/dashboard.ts`
- `packages/blueprints/apps/tasks/app.json`
- `packages/blueprints/apps/tasks/queries/board.ts`
- `packages/blueprints/apps/tasks/queries/search.ts`
- `packages/blueprints/src/app-entity-tripwire.test.ts`
- `packages/blueprints/src/app-entity-tripwire.ts`
- `packages/server/src/brief/daily-brief.test.ts`
- `packages/server/src/lifecycle/automation-anchor-scopes.ts`
- `packages/server/src/routes/device-work-routes.test.ts`
- `packages/server/src/routes/grant-routes.test.ts`
- `packages/server/src/routes/placement-routes.test.ts`
- `packages/server/src/routes/replica-projection.test.ts`
- `packages/server/src/routes/replica-shape-parity.test.ts`
- `packages/server/src/routes/replica-shape.test.ts`
- `packages/server/src/routes/storage-routes.test.ts`
- `packages/server/src/serve/grant-fulfillment.test.ts`
- `packages/server/src/serve/manifest-scope-denial.sweep.test.ts`
- `packages/server/src/serve/peer-give.test-fixtures.ts`
- `packages/server/src/serve/peer-transport-remote.test.ts`
- `packages/server/src/serve/protocol-join-lane.test.ts`
- `packages/server/src/serve/share-subscription-peer.test-fixtures.ts`
- `packages/server/src/serve/vault-plane-blob-sweep.test.ts`
- `packages/test-kit/src/year3-vault.ts`
- `packages/vault/src/blob/cache-headroom.test.ts`
- `packages/vault/src/blob/cache.test.ts`
- `packages/vault/src/blob/custody-rollup.test.ts`
- `packages/vault/src/blob/flow.test.ts`
- `packages/vault/src/blob/mint.ts`
- `packages/vault/src/blob/preflight.ts`
- `packages/vault/src/blob/preview.test.ts`
- `packages/vault/src/blob/preview.ts`
- `packages/vault/src/blob/promote.ts`
- `packages/vault/src/blob/read.test.ts`
- `packages/vault/src/blob/store-routing.ts`
- `packages/vault/src/commands/attachments.test.ts`
- `packages/vault/src/commands/attachments.ts`
- `packages/vault/src/commands/inline-body-guard.test.ts`
- `packages/vault/src/commands/media.test.ts`
- `packages/vault/src/commands/media.ts`
- `packages/vault/src/commands/outbox.test.ts`
- `packages/vault/src/commands/outbox.ts`
- `packages/vault/src/commands/people.ts`
- `packages/vault/src/commands/social.test.ts`
- `packages/vault/src/commands/social.ts`
- `packages/vault/src/commands/sync.test.ts`
- `packages/vault/src/commands/tally.ts`
- `packages/vault/src/enrich/clusters.test.ts`
- `packages/vault/src/enrich/derivation.test.ts`
- `packages/vault/src/enrich/enrich.test.ts`
- `packages/vault/src/enrich/leases.test.ts`
- `packages/vault/src/enrich/leases.ts`
- `packages/vault/src/gateway/cards.ts`
- `packages/vault/src/gateway/duties.test.ts`
- `packages/vault/src/gateway/execution.ts`
- `packages/vault/src/gateway/gateway.contract.test.ts`
- `packages/vault/src/gateway/portability.test.ts`
- `packages/vault/src/gateway/portable-adapters.ts`
- `packages/vault/src/gateway/portable-export.test.ts`
- `packages/vault/src/gateway/read-truncation.test.ts`
- `packages/vault/src/gateway/search.test.ts`
- `packages/vault/src/gateway/types.ts`
- `packages/vault/src/grant/fulfillment-edit.test.ts`
- `packages/vault/src/grant/fulfillment.test-fixtures.ts`
- `packages/vault/src/grant/fulfillment.test.ts`
- `packages/vault/src/index.ts`
- `packages/vault/src/ingest/caption-target.ts`
- `packages/vault/src/ingest/concept-writes.ts`
- `packages/vault/src/ingest/content-item-publisher.ts`
- `packages/vault/src/ingest/mbox-attachments.test.ts`
- `packages/vault/src/ingest/staging.test.ts`
- `packages/vault/src/ingest/takeout-photos.test.ts`
- `packages/vault/src/replica/value-policy.test.ts`
- `packages/vault/src/schema/blob.ts`
- `packages/vault/src/share/closure-confinement.contract.test.ts`
- `packages/vault/src/share/closure-split.test.ts`
- `packages/vault/src/share/closure.ts`
- `packages/vault/src/share/container-routing.ts`
- `packages/vault/src/share/household.test.ts`
- `packages/vault/src/share/placement-fixture.ts`
- `packages/vault/src/share/placement.test.ts`
- `packages/vault/src/share/project-closure.ts`
- `packages/vault/src/share/read-closure.ts`
- `packages/vault/src/share/subscription-delta.ts`
- `packages/vault/src/share/subscription-sim-plane.test-fixtures.ts`
- `packages/vault/src/share/subscription-sim.test-fixtures.ts`
- `packages/vault/src/share/subscription.test.ts`

## Wave 0c — domain operations

One invariant boundary. Before this wave a domain command, an importer and the row editor each enforced a **different subset** of the model: `people.add_important_date` refused February 31 in its input schema and `atlas.insert_row` wrote it; `schedule.add_task` checked that a parent was open and top-level and neither of them noticed a task naming itself; nothing anywhere refused `due_at: "banana"`. That is ONT-26's finding, and it is not "a check is missing" — it is "there is no one place the model lives".

### The shape

`packages/vault/src/operations/` is that place. An operation is the answer to *what does it mean to write this row*, with four parts: **preconditions** over the proposed row image, **postconditions** checked inside the invocation transaction, the **read-set** it consulted to decide (R6/R23), and its **offline declaration** (R25) as data. A condition returns `null` when it holds and an owner-facing SENTENCE when it does not — the sentence is what a member reads and what the writer matrix compares across writers.

Six operations: `schedule.task.write`, `schedule.task.complete`, `schedule.task.reopen`, `core.content_item.write`, `people.important_date.write`, `atlas.row.write`. None has an empty condition set, and `declarations.test.ts` fails when one does.

**Atlas is inside the boundary.** Its `SHARED.preconditions` were `[]`; they are now `operationConditions("atlas.row.write", …)`, whose one condition dispatches on the table the request names and runs `assertCanonicalWrite` — the same code a typed command runs. A SQL `ConditionSpec` could not have said any of it, because Atlas's table is an input, so `CommandDefinition.preconditions` gained a second variant: an `OperationConditionSpec` carrying a predicate. A predicate does not survive `JSON.stringify`, so `agent_command.preconditions_json` is now the registry's RECORD of which conditions a command declares and the registered definition is what RUNS them (`gateway/execution.ts`, `gateway/contract.ts`, `gateway/gateway.ts`).

**Simple invariants are schema, so they hold for every writer by construction** (R21) — including the seat's local apply in W9, which no TypeScript boundary will be able to reach: `schedule_task.due_at` must read as a time (`datetime()` plus a round-trip on the date part, because `date()` NORMALISES February 31 rather than refusing it), `parent_task_id <> task_id`, `people_important_date.month_day` must be a real day of a real month, `core_content_item.sha256` must be sixty-four hex characters, and three triggers: `schedule_task_hierarchy_is_acyclic` (the recursive walk a CHECK cannot do), `schedule_task_section_agrees_with_project` (insert and update), `core_content_item_hash_follows_bytes`.

**Two new columns**, and the golden corpus re-frozen for them: `schedule_task.series_id` (a recurring task's stable series identity — the head carries its own id, every occurrence carries the head's, ONT-27) and `core_event.rrule_support` (an imported rule outside the expander's subset is RETAINED and marked, never stored as executable, ONT-31).

**Completion is one operation** (`operations/task-lifecycle.ts`). `people.toggle_task` is **deleted**, not kept beside its replacement: People calls `people.complete_task` / `people.reopen_task`, Tasks calls `schedule.set_task_status`, both land in `completeTask` / `reopenTask` / `cancelTask`, and the successor of a recurring task re-asserts the completed occurrence's live `core_link` rows — so a recurring "call Mum" is still about Mum. The blueprint action `people.action.toggle-task` becomes `complete-task` and `reopen-task`.

**The occurrence key is one typed value** (`packages/core/src/time/occurrence.ts`), and it is the only place the stored column is named. Two defects met here. The readers spelled the column `original_start` and the zone `time_zone` — neither is a column of anything — so every lookup read `undefined`. And underneath that, `applyRecurrenceExceptions` matched on `instance.originalStart`, which for a ZONED series is the resolved UTC instant while the exception is stored as the series-local WALL CLOCK: two different strings for every zoned series on earth, so even a correctly-spelled skip would have matched nothing. The matcher now takes the wall clock; `occurrenceWallStart` in both organize commands derives its search window from `occurrenceSearchWindow` rather than `Date.parse` (a wall clock read as an instant is read in the HOST's zone, which is how the writer and the reader disagreed outside UTC); and every reader — `apps/agenda/queries/upcoming.ts`, `apps/mobile/.../useAgenda.ts`, the home tile, Tally's dashboard — consumes `occurrenceExceptionsOf` / `overrideAt` / `recurrenceExceptionsOf`, mounted on `ctx.time` for the gateway worker and for the seat's inline ctx alike.

**Temporal meaning is validated at the boundary** (`packages/core/src/time/temporal.ts`): four readings named once — instant, floating local datetime, local date, yearless month-day — with the calendar checked, not just the shape.

**A concept is selected by its key and nothing else.** Wave 0b added `normalized_key` and left a fallback onto the ASCII slug; 0c removes the fallback, because a slug that maps 猫, 犬, कुत्ता and बिल्ली all to `untitled` cannot be consulted without reopening the collapse it was added to end. `tagNotation` is gone from the package surface; the slug is `conceptNotation`, display notation only.

**An account is not selected by its label.** `accountFor` matched `(owner_party_id, name)`, so two banks' "Savings" were one account and every transaction from the second landed on the first. It now selects on `core_account.external_ref` — a source-scoped identifier the importer STATES: `owner:<name>` when the member said which account these rows are, `file:<path>` otherwise, which is the provenance of the rows rather than a claim about what they are called.

**The declared read-set is part of the admission.** `missingReadSetVersions` in `replica-intent-shape.ts` compares an intent's `baseVersions` against the read-set of the operation it names; a set short of it is refused with `replica_intent_read_set_incomplete` rather than settled against versions nobody observed. An intent that names no operation is unchanged — the seat begins naming one in W2, and the gate is already here.

### Scenarios

| # | Scenario | Where | Reads through |
| --- | --- | --- | --- |
| 1 | Self-parent task, refused identically by command, automation and the row editor | `operations/writer-matrix.test.ts` | the gateway's outcome + reason |
| 2 | A hierarchy loop of two, refused | `operations/writer-matrix.test.ts` | the same |
| 3 | `due_at: "banana"`, refused identically by three writers | `operations/writer-matrix.test.ts` | the same |
| 4 | February 31 as a due date, refused identically by three writers | `operations/writer-matrix.test.ts` | the same |
| 5 | `rrule: "garbage"`, refused identically by three writers | `operations/writer-matrix.test.ts` | the same |
| 6 | An imported unsupported rule is RETAINED with `rrule_support = 'unsupported'` | `operations/writer-matrix.test.ts` | the stored row |
| 7 | A section of another project, refused by the organize command and the row editor | `operations/writer-matrix.test.ts` | the same |
| 8 | A zeroed hash over unchanged bytes, refused; a non-hash refused by the column | `operations/writer-matrix.test.ts` | the same |
| 9 | February 31 as an anniversary refused, February 29 accepted, by every writer | `operations/writer-matrix.test.ts` | the same |
| 10 | Create, skip day two, query — UTC, a non-UTC zone, a DST boundary, floating, all-day | `operations/behaviour-scenarios.test.ts` | the occurrence adapter |
| 11 | The same five, read through the real Agenda query handler | `blueprints/src/query-handlers-996.test.ts` | `apps/agenda/queries/upcoming.ts` |
| 12 | People-complete-then-Tasks-complete is ONE completion | `operations/behaviour-scenarios.test.ts` | the stored status and stamp |
| 13 | A recurring person task rolls over once, and the successor is still about the person | `operations/behaviour-scenarios.test.ts` | `core_link` + `series_id` |
| 14 | Reopening is not completing, and both are idempotent | `operations/behaviour-scenarios.test.ts` | the stored status |
| 15 | Every operation declares conditions, writes, a read-set and an offline contract | `operations/declarations.test.ts` | the registry |
| 16 | An intent short of its operation's read-set is named, not admitted | `server/src/routes/replica-intent-read-set.test.ts` | the gate function |

### Site accounting

- `original_start\b` and `time_zone` outside the adapter: **0** in code. The four remaining hits are prose — the adapter's own header (2), the `TimeApi` doc comment (1), the two `ontology-rules.test.ts` assertions that the columns do NOT exist (2), and two `time-organize.ts` DDL comments quoting #916's ruling.
- SEAM 3's 47 sites: the two organize writers and their command inputs renamed to `original_start_local`; Tally's template field renamed `tz`; the four readers (web agenda, phone agenda, home tile, Tally dashboard) routed through the adapter; `apps/mobile/src/kit/schedule/recurrence.ts`'s private copy of "which override is in force" deleted for `overrideAt`.
- `tagNotation`: **0** references outside two prose comments.
- Domain operations: 6, each with ≥1 precondition and ≥1 postcondition.
- Blueprint actions on People: 28 → 29 (`toggle-task` → `complete-task` + `reopen-task`).
- Shape ids reshaped: 4 of 8 (agenda, notes, people, tasks), re-pinned in `replica-shape-parity.test.ts` with the reason.

### Files

**The operation layer (new)** — `packages/vault/src/operations/behaviour-scenarios.test.ts`, `packages/vault/src/operations/canonical-write.ts`, `packages/vault/src/operations/content-write.ts`, `packages/vault/src/operations/declarations.test.ts`, `packages/vault/src/operations/important-date-write.ts`, `packages/vault/src/operations/index.ts`, `packages/vault/src/operations/registry.ts`, `packages/vault/src/operations/task-lifecycle.ts`, `packages/vault/src/operations/task-write.ts`, `packages/vault/src/operations/types.ts`, `packages/vault/src/operations/writer-matrix.test.ts`.

**Core time — the adapter and the parser (new + matcher)** — `packages/core/src/time/index.ts`, `packages/core/src/time/occurrence.ts`, `packages/core/src/time/recurrence.test.ts`, `packages/core/src/time/recurrence.ts`, `packages/core/src/time/temporal.ts`.

**The gateway's contract stage** — `packages/vault/src/gateway/contract.ts`, `packages/vault/src/gateway/duties.test.ts`, `packages/vault/src/gateway/execution.test.ts`, `packages/vault/src/gateway/execution.ts`, `packages/vault/src/gateway/gateway.contract.test.ts`, `packages/vault/src/gateway/gateway.ts`, `packages/vault/src/gateway/portability.test.ts`, `packages/vault/src/gateway/read-truncation.test.ts`, `packages/vault/src/gateway/search.test.ts`, `packages/vault/src/gateway/types.ts`.

**Vault commands** — `packages/vault/src/commands/atlas.ts`, `packages/vault/src/commands/inline-body-guard.test.ts`, `packages/vault/src/commands/organize-domains.test.ts`, `packages/vault/src/commands/people-dates.test.ts`, `packages/vault/src/commands/people.test.ts`, `packages/vault/src/commands/people.ts`, `packages/vault/src/commands/schedule-organize.test.ts`, `packages/vault/src/commands/schedule-organize.ts`, `packages/vault/src/commands/schedule-projects.ts`, `packages/vault/src/commands/social.test.ts`, `packages/vault/src/commands/tally-organize.ts`, `packages/vault/src/commands/tasks.ts`.

**Vault ingest** — `packages/vault/src/ingest/concept-writes.ts`, `packages/vault/src/ingest/enrich-publishers.test.ts`, `packages/vault/src/ingest/enrich-publishers.ts`, `packages/vault/src/ingest/payload-schemas.test.ts`, `packages/vault/src/ingest/payload-schemas.ts`, `packages/vault/src/ingest/publishers.ts`, `packages/vault/src/ingest/stage-file.ts`.

**Vault schema and the re-frozen golden corpus** — `packages/vault/src/schema/core.ts`, `packages/vault/src/schema/domains-people.ts`, `packages/vault/src/schema/domains-schedule.ts`, `packages/vault/src/schema/time-organize.ts`, `packages/vault/tests/golden/issue-929/manifest.json`, `packages/vault/tests/golden/issue-929/vault.db.gz`.

**Vault, other** — `packages/vault/src/blob/read.test.ts`, `packages/vault/src/enrich/clusters.test.ts`, `packages/vault/src/enrich/derivation.test.ts`, `packages/vault/src/enrich/leases.test.ts`, `packages/vault/src/grant/fulfillment-edit.test.ts`, `packages/vault/src/index.ts`.

**Server** — `packages/server/src/engine/worker/runner.ts`, `packages/server/src/routes/replica-intent-read-set.test.ts`, `packages/server/src/routes/replica-intent-route.ts`, `packages/server/src/routes/replica-intent-shape.ts`, `packages/server/src/routes/replica-shape-parity.test.ts`.

**Blueprints** — `packages/blueprints/apps/agenda/app.json`, `packages/blueprints/apps/agenda/edits.test.ts`, `packages/blueprints/apps/agenda/edits.ts`, `packages/blueprints/apps/agenda/logic.test.ts`, `packages/blueprints/apps/agenda/queries/upcoming.ts`, `packages/blueprints/apps/agenda/types.ts`, `packages/blueprints/apps/people/actions/complete-task.ts`, `packages/blueprints/apps/people/actions/reopen-task.ts`, `packages/blueprints/apps/people/app.json`, `packages/blueprints/apps/people/pending-projection.ts`, `packages/blueprints/apps/tally/app.json`, `packages/blueprints/apps/tally/components/Recurring.tsx`, `packages/blueprints/apps/tally/compose-states-kit.ts`, `packages/blueprints/apps/tally/pending-projection.ts`, `packages/blueprints/apps/tally/queries/dashboard.ts`, `packages/blueprints/apps/tally/schedule-model.test.ts`, `packages/blueprints/apps/tally/schedule-model.ts`, `packages/blueprints/apps/tally/types.ts`, `packages/blueprints/apps/tally/writes.test.ts`, `packages/blueprints/apps/tally/writes.ts`, `packages/blueprints/manifest.json`, `packages/blueprints/src/handler-reachability.test.ts`, `packages/blueprints/src/pending-projection-tripwire.test.ts`, `packages/blueprints/src/query-handlers.test.ts`, `packages/blueprints/types/centraid.d.ts`.

**Client and mobile** — `apps/mobile/src/apps/agenda/AgendaEventEditor.tsx`, `apps/mobile/src/apps/agenda/useAgenda.ts`, `apps/mobile/src/apps/tally/TallyRecurringScreen.tsx`, `apps/mobile/src/kit/schedule/recurrence.ts`, `apps/mobile/src/lib/replica/tally-ledger.test-fixtures.ts`, `apps/mobile/src/screens/home/useSpringboardTiles.ts`, `packages/client/src/replica/inline-query-ctx-core.ts`.

**Test kit** — `packages/test-kit/package.json`, `packages/test-kit/src/fixture-sha.ts`, `packages/test-kit/src/year3-distributions.ts`.

**Docs and the published ontology** — `docs/vault-ontology.md`, `scripts/docs-site/src/content/ontology-body.html`.

### Gates

```sh
bun run --filter @centraid/vault test          # 198 files, 1610 passed, 2 skipped, 0 failed
bun run --filter @centraid/blueprints test     # 212 files, 7076 passed, 2 expected fail, 0 failed
npx vitest run --root apps/mobile src/apps/agenda src/apps/tasks src/apps/people \
  src/apps/tally src/screens/home src/kit/schedule src/lib/replica   # 74 files, 602 passed
bun run --filter @centraid/core test           # src/time: 7 files, 182 passed
bun run --filter @centraid/test-kit test       # 5 files, 62 passed
bun run --filter @centraid/server test         # 388 files, 3462 passed, 3 pre-existing FAIL
bun run --filter @centraid/vault typecheck && bun run --filter @centraid/blueprints typecheck
bun run --filter @centraid/core typecheck && bun run --filter @centraid/server typecheck
bun run --filter @centraid/client typecheck && bun run --filter @centraid/mobile typecheck   # all 0
bun run lint && bun run format:check           # clean
bash .governance/run.sh                        # 22/22
bun run --filter @centraid/vault build && bun run golden-vault:freeze -- --label issue-929
                                               # 67 tables, 289 rows, schema v5
```

The three red server tests are **environment, not this change**: `acp/backends/acp/launch.test.ts` ×2 (root / IS_SANDBOX) and `serve/gateway-db-lock.integration.test.ts` (no `sqlite3` binary). They fail identically on an untouched tree.

### Two red suites that were not this wave's, fixed here rather than left

- **`packages/test-kit`** was red on `d96172c40`: `year3-distributions.ts` still inserted `core_content_item.media_type` and `title`, which wave 0b removed. Notes now get a `core_content_representation` row like every other owner. Left standing it also blocked the golden re-freeze this wave needs.
- **`packages/blueprints/src/query-handlers.test.ts`**'s photo-caption projection expected `title` on the content row, also removed by 0b. The fixture now puts the authored title on `media_asset`, which is where the grid reads it.

### Decisions — wave 0c

- **The matcher's key changed, and that is the ONT-25 fix, not a side effect.** `applyRecurrenceExceptions` matched on the resolved instant; exceptions are stored as the series-local wall clock. Renaming the readers' column alone would have left every zoned skip still matching nothing. One core test that keyed a zoned series on instants is restated in wall clocks — the contract it asserts is unchanged, its vocabulary is.
- **`people.add_important_date`'s input pattern was NARROWED, deliberately.** It spelled out the length of every month — one writer's private copy of the calendar, which is exactly why Atlas could write February 31 while the command refused it. The schema now says only "two digits, a hyphen, two digits"; whether the day exists is the operation's answer, so both writers give the same sentence. `people-dates.test.ts` splits into the malformed case (still a schema violation) and the impossible-day case (now the operation's).
- **The gateway evaluates the LIVE conditions, not the registry row.** A domain-operation predicate cannot be serialised, so `preconditions_json` became a record and the registered definition became the contract. Two `execution.test.ts` fixtures that registered a command with `preconditions: []` while the DB row carried specs now carry the same specs in both places, which is what a real registration does.
- **`atlas.row.write` is `online-only`, and says why.** A row editor names its table at request time, so its conflict scope cannot be declared ahead of the request and no seat can promise the refusals it will meet. R25's explicit *unavailable*, not a queue.
- **The task-write conditions run FIRST in `schedule.add_task`.** When both the command's own contract and the model have something to say, the member should read the model's sentence ("a task cannot be its own parent"), not the command's narrower one ("that parent is not open and top-level").
- **A cross-source account match is not built.** `accountFor` stops inferring identity from a display label, which is R20(c)'s deletion; the *proposal* half — a reviewable match the owner accepts (**OQ-12**) — has no surface and is not attempted here. Two imports of the same real account under different provenance are two accounts until that surface exists. **Flagged for the owner.**
- **`schedule_task.rrule_support` was not added.** ONT-31's retain-with-a-state half applies to IMPORTED rules; nothing imports tasks with rules, and every task writer refuses an unsupported rule outright. `core_event` gained the column because the `.ics` importer is a real writer of provider rules. Adding a second unread column would be the drift this wave exists to end.
- **ONT-30 is closed here.** Wave 0b landed the mechanism and left the row open because its scenario was red; the prelude commit above showed the index and the CHECK were intact and the scenario's clock was not. ONT-22 is left as wave 0b's to close.


## Review sweep — subsystems that assumed the slice

The sweep's six findings were re-judged against the code; three are assigned to waves 1–4, three are not taken as filed, per the verdict table.

Read-only sweep of `claude/checkout-remote-main-70f7lb` @ f64226ae2 against #996's Scope (issue L110–131), waves 1–10 (L160–171) and `docs/decisions.md:838–940` (R1–R25).
Status key: **W_n_** = retired by that wave · **partial** = named but something is missed · **unnamed** = the issue never mentions it.

| # | Subsystem | Files | Old-model assumption | #996 status | Recommendation |
| --- | --- | --- | --- | --- | --- |
| **a. partial rows / masks / ceilings** ||||||
| a1 | Replica value policy | `packages/vault/src/replica/value-policy.ts:17-50` | A replicated text value has a weight ceiling and lazy (byte) columns because the slice could not carry them | **unnamed** (W5 deletes `replica_row`, not this) | Delete in W5 with `snapshot.ts`'s per-page policy call; nothing on a full seat weighs a value before shipping it |
| a2 | Per-entity ceiling declarations | `packages/vault/src/schema/entity-declaration.ts:66-160` (`DEFAULT_REPLICA_TEXT_CEILING_BYTES`, `replicaValues`, `lazyColumns`), the `replicaValues` entries in `schema/entity-catalog.ts` | A ceiling is a "promise about the table" only because a device got a subset | **partial** — W0b touches `entity-declaration.ts` for the representation split, never for these fields | Delete the `replicaValues` field and every catalog entry in W5; R8's side tables replace it structurally |
| a3 | Structural column deny-list | `packages/vault/src/replica/unavailable-columns.ts:19-29` | Some columns a replica never sees at all | **partial** (W5 deletes "`unavailable-columns.ts`'s masking half") | Split as the issue says, but check the surviving half: on a seat the only exclusion left is R3's private-table list, which is a table list, not a column list |
| a4 | Read-plan compiler + census probes | `packages/client/src/replica/read-plan.ts:155-341`, `read-plan-clauses.ts`, `read-plan-parity*.ts`, `read-plan-refusals.test.ts`, `read-plan-truncation.test.ts`, `order-census.test.ts` | A seat cannot compare a value the canonical vault could, so a clause compiles to a verdict and escalates online | **W5** (R9) | Delete whole in W5 together with the declarative `vault.read` request |
| a5 | Deferred / oversized values on the wire | `packages/client/src/replica/types.ts:218-245` (`oversizedFields`), `query.ts:22,347`, `deferred-values.test.ts`, `apps/mobile/src/kit/hooks/useReplicaQuery.ts:82-91` | A row arrives with holes | **W5** ("deferred values") | Delete; `replicaFieldUnavailable` and the mobile hook's caller sites go with it |
| a6 | "Not on this device" copy | `packages/blueprints/apps/_shared/shared-copy.ts:70`, 6 call sites | A field can be missing on a full copy | **unnamed** | Delete in W5 — with a whole vault this string can only lie |
| a7 | Truncation flags | `packages/blueprints/types/centraid.d.ts:73,81,83`, `packages/client/src/replica/types.ts:228-245`, ~200 `acceptTruncation` hits across 65 files (`apps/people/queries/person.ts` 15, `apps/tasks/queries/board.ts` 10, `apps/notes/queries/library.ts` 9) | A read may be cut short and must say so | **W4** (R8), explicitly rewritten as paged handlers | Follow W4; the tripwire it adds is what stops flag-by-flag conversion |
| **b. shapes, scopes-as-holdings, trust tiers** ||||||
| b1 | Shape composition + parity pins | `packages/server/src/routes/replica-shape.ts:481` (`buildReplicaShapes`), `replica-shape.test.ts`, `replica-grant-shape.test.ts`, `replica-shape-parity.test.ts:1-12` (eight ids pinned from a deleted builder) | Eight per-app shapes decide what a device holds | **W5** (device half) → **W7** (`buildReplicaShapes` and the origin door) | Delete on that order; `replica-shape-parity.test.ts` is dead the moment the device half goes and must not be re-pinned |
| b2 | Declared-scope register | `packages/server/src/routes/replica-declared-scopes.ts:1-25` | An app's `vault.scopes` composes its replica shape | **W5/W7** by consequence, **unnamed** by name | Delete with b1; it has no other consumer |
| b3 | `app.json#vault.scopes` (13–41 scopes × 8 apps) + build-time tripwire | `packages/blueprints/apps/*/app.json`, `packages/blueprints/src/app-entity-tripwire.ts:1-25`, `app-entity-tripwire.filters.json`, `app-manifest-reads.test.ts` | Minimisation moved to build time when #928 deleted the runtime evaluator | **W4** — plan snapshots "replace the manifest's `vault.scopes` and `app-entity-tripwire.ts` as review diffs" | Delete in W4; `app-manifest-reads.test.ts` is **unnamed** and enforces the same scope attribution — retire it in the same commit |
| b4 | Companion surfaces + `device_surface_projection` | `packages/vault/src/grant/companion-surfaces.ts:1-20`, `packages/server/src/serve/enrollment-store.ts:347,364,395`, `companion-grants.ts`, `serve/companion-access.ts` | A device is confined to a set of surfaces | **W8** (R11/R17) | Delete in W8 |
| b5 | Device trust tiers | `packages/vault/src/grant/device-trust.ts:12-30` (`full`/`readonly`/`revoked`, `DEVICE_TRUST_SCALAR_SQL`) | A tier decides what a device may hold | **W8** | Delete; R11 makes enrollment full trust |
| b6 | `device` as a principal kind | `packages/vault/src/schema/authority.ts:103,143`, `NON_ENTITY_PRINCIPAL_KINDS` at `:40` | A device is a grantee | **W8** (CHECK → four values, three kinds) | Follow W8; `ontology-shape.test.ts` is the gate |
| b7 | `grant_profile_json` | 6 doc-only hits, no code | Consent profile per device | **W8** (R11) | Already gone from code; close the doc rows at the close pass |
| **c. coverage / truncation / online fallback** ||||||
| c1 | Per-read `coverage` | `packages/client/src/replica/types.ts:241,249,258,267,287`, `store-core.ts:386-397,871,1105`, `sqlite-worker.ts:164-172`, `worker-client.ts:168`, `shell-session.ts:254-259`, `apps/mobile/src/kit/hooks/replica-query-state.ts:21-123` | "Does this device hold the whole library yet" is a per-read answer | **W2** (R8) — replaced by the seat watermark | Follow W2; `replica-query-state.ts`'s conservative fold of many coverages is **unnamed** and must go with it |
| c2 | Online-only escalation plane | `packages/client/src/replica/{errors,online-only-guard,online-only-error,query,search-refused-error}.ts`, `react/blueprints/inlineQueryCtx.ts:138,192`, `centraid-inline.ts:197,771,782` | A read the slice cannot serve reruns at the gateway | **partial** — W5 deletes the read plan, but the guard/error plane and the inline `onlineOnly` option are not named | Keep only the *deliberate* online-only set (Locker rotation, cross-owner share — issue L266); delete the read-derived half in W5 |
| c3 | Multi-part coverage compose on the phone | `apps/mobile/src/kit/hooks/replica-query-state.ts:99-123` | A screen composes several partial reads | **unnamed** | Delete in W3 with the mount plane |
| **d. the mount plane** ||||||
| d1 | Multi-vault reader | `apps/mobile/src/lib/replica/multi-vault-reader.ts` (999 lines), `multi-vault-session.ts`, `mounted-read-plan*.test.ts` | One phone reads several owners' vault slices at once | **W3** | Delete in W3 |
| d2 | Mounted-read scoping + degradations | `apps/mobile/src/lib/replica/mounted-read-scoping.ts:49-61`, `multi-vault-reader.ts:303-322` (`content-hash-badges`, `dedupe-collapse`) | Cross-vault reads degrade | **W3** | Delete in W3 |
| d3 | `MAX_MULTIPLEX_REPLICA_SCOPES = 4` | `packages/core/src/protocol/routes.ts:51`, `index.ts:21`, `packages/server/src/routes/multiplex-replica-routes.ts:3,300-303`, `apps/mobile/src/lib/replica/offline-budgets.ts:2` | Four vaults multiplexed on one connection | **W3** | Delete the cap; R12 keeps one *multiplexed connection*, not a scope cap |
| d4 | Multiplex replica routes | `packages/server/src/routes/multiplex-replica-routes.ts` (352 lines) | The gateway serves N shaped mounts per request | **partial** — W3 deletes the *client* mount plane; the route is not named | Delete server-side in W5 with the shaped device door, or W3 if no reader survives |
| **e. gateway-only read paths** ||||||
| e1 | Assistant context | `packages/vault/src/gateway/assistant-context.ts:1-25` | Only the gateway holds the whole schema and all rows | **unnamed** | **Keep gateway-side**: it is built from the live file per turn and feeds an egress-gated model — but W0b's revision split already edited its prose (`:29`), so keep it in the wave that changes the schema |
| e2 | Card resolver | `packages/vault/src/gateway/cards.ts:1-20`, `gateway/gateway.ts:83`, `index.ts:746` | Apps display foreign entities "without read scope on them" | **unnamed** | Delete the first-party path in W4 — a seat holding the whole vault joins to the far end in SQL; keep only the automation-clamped path if `evaluateAccess` still has an automation caller |
| e3 | Gateway read window + truncation | `packages/vault/src/gateway/types.ts` `GATEWAY_DEFAULT_READ_ROWS`, `read-truncation.test.ts:1-6`, `read-batch.test.ts`, `read-order.test.ts` | The gateway's 1,000-row default window must announce a cut | **partial** — R8 gives the *handler host* one measured ceiling; the gateway's own default window is not named | Rethink: the gateway is one more seat running the same paged handlers, so this window should become the same keyset page in W4, not a second policy |
| e4 | Field-masked gateway search | `packages/vault/src/gateway/search.ts:1-12,108-135`, `gateway/access.ts:27,87-116` | A grant field mask hides indexed columns | **unnamed** | **Keep**: the mask now comes only from `identity.scopeClamp` — R17's automation execution clamp — which is authz, not holdings |
| e5 | Portability / export | `packages/vault/src/gateway/portability.ts:68,214`, `portable-export.ts`, `portable-sealed-custody.ts` | Only the gateway can read every row | **unnamed** | **Keep gateway-side** for v0 (private tables + sealed custody), but say so; a seat could export the replicated half |
| e6 | Daily brief | `packages/server/src/brief/daily-brief.ts` | Composed at the gateway because the phone lacked rows | **unnamed** | Rethink in W4: it is a cross-app read that can run on the seat, unless its enrichment/egress step keeps it at the gateway |
| e7 | ACP `vault_sql` | `packages/server/src/acp/vault-sql-tool.ts:1-14` | Owner-credentialed SQL only the gateway can run | **unnamed** | **Keep**: the harness is an egress class under R17, so its reads stay on the gateway |
| **f. per-device state** ||||||
| f1 | `access_device.sync_cursor` | `packages/vault/src/schema/access.ts:79`, `bootstrap.ts:181` | One cursor per device over a shaped stream | **partial** — W1 splits `access_device`/`access_agent`, but the cursor column's meaning (shaped delta position) is not restated | Restate the column as the seat's log `seq` in W1, or move it to the private sibling; a replicated cursor is now a seat's own state |
| f2 | `replica_meta` / `replica_change` / `replica_intent_outcome` | `packages/vault/src/schema/replica.ts:17-138` (`REPLICA_SCHEMA_EPOCH = 1`) | Gateway-side per-device change fan-out | **W1** (the log replaces it) + one epoch bump | Delete `replica_change` in W1; `replica_intent_outcome` survives as R24's outcome table |
| f3 | Client `replica_row` / `payload_json` store | `packages/client/src/replica/store-core.ts:262-351,689-1045,1212-1438` (1,870 lines) | A JSON row bag with a synthetic key and per-order census indexes | **W5** | Delete in W5 after W2's real-table store proves out |
| f4 | Blob custody CHECK, five values | `packages/vault/src/schema/blob.ts:361` (`pending-offsite`,`local-only`,`replicated`,`remote-only`,`missing`), `blob/custody-state.ts`, `doctor.ts:115-143` | Five machine states over a slice's byte custody | **partial** — W3/W4 reduce the *copy* to two states; the CHECK is **unnamed** | Rethink: R7's owner-facing answer is two states + a cache bit, so decide in W3 whether the column collapses or stays a five-state machine behind a two-state read |
| f5 | Client custody arithmetic | `packages/client/src/react/screens/vault-custody.ts:11-45` (`holdsReplica` = `rememberDevice`) | A device may or may not hold a copy | **partial** — W4 reduces web custody copy | Rewrite, don't reduce: under R1 every seat holds the vault, so "N machines hold a full copy" is now "N seats" and the `rememberDevice` predicate has no meaning |
| f6 | Backup verdict | `apps/mobile/src/kit/transfer/backup-verdict.ts:1-25` | The device queue, not the custody rollup, is the verdict | **W3** (named in the wave's file list) | **Keep the rule**, retarget it: R7 says the gateway CAS's verified sha is the durability answer, so `complete` must mean verified-at-gateway, not queue-empty |
| f7 | `restore-check.ts` + seal key custody | `packages/vault/src/restore-check.ts:1-20`, `schema/sealed.ts` | Sealed-artifact custody per restored pair | **W6** (`sealed.ts` deleted last) | Rewrite `restore-check` to Locker's `keys/` custody in W6; the issue names `sealed.ts` but not this reader |
| **g. protocol flags and ledger rows** ||||||
| g1 | `multiVaultReplica` + `crossVaultPlacements` capability flags | `packages/core/src/protocol/capabilities.ts:14-15,28-29,53-54`, `packages/server/src/serve/build-gateway.ts:3636-3637`, `apps/mobile/src/lib/replica/mobile-gateway-compatibility-core.ts:56-62` | The mount plane and cross-vault placements are negotiable features | **unnamed** | See Finding F1 |
| g2 | Share shape namespace | `packages/core/src/protocol/replica-subscription.ts:51-75` (`SHARE_SHAPE_SIGIL`, `shareShapeId`), `packages/vault/src/schema/subscription.ts:34` (`structure_digest`) | A subscription is a grant-keyed *shape* | **W7** (`shape_id` → `authority_id`; `structure_digest` superseded by the member set) | Delete the sigil and the namespace-collision guard in W7 |
| g3 | Journey ledger rows with a slice premise | `tests/journeys.json:26-27` (`year3-replica` "50,000 replica rows", `year3-household` "5 mounted vaults"), `:233-244` (`mobile/search` consumer `multi-vault-reader.test.ts`), `:292-297` (`gateway/converge` probe: "shape rebuild") | The measured unit is a shaped slice on a mounted plane | **partial** — W10 re-measures `mobile/*` and `desktop/*`; the volume definitions and the `gateway/*` probes are **unnamed** | Redefine `year3-replica` as whole-vault rows and retire `year3-household` in W3; re-word the `gateway/converge` probe in W1 |
| **h. tests and fixtures that encode the old model** ||||||
| h1 | Shape parity + digests | `packages/server/src/routes/replica-shape-parity.test.ts`, `replica-shape.test.ts`, `replica-grant-shape.test.ts` | Eight shape ids are truth | **W5/W7** | Delete, never re-pin (see b1) |
| h2 | Read-plan suites | `packages/client/src/replica/{read-plan-parity,read-plan-refusals,read-plan-truncation,order-census,search-parity}.test.ts` | Escalation and census are the contract | **W5** | Delete in W5; `search-parity` becomes W1's FTS query-parity test |
| h3 | Mounted-read suites | `apps/mobile/src/lib/replica/{mounted-read-plan,mounted-read-plan.pushdown,multi-vault-session,multi-vault-reader,reader-statement-budget}.test.ts` | Mounted reads are a contract | **W3** | Delete in W3 |
| h4 | Golden snapshot FTS exclusion | `packages/vault/src/golden-snapshot.ts`, `packages/vault/tests/golden/golden-snapshot.ts` (`NOT LIKE '%_fts%'` vs real `fts_*` names) | The manifest silently includes 52 FTS tables | **W1** (the issue already names the fix) | Fix in W1 as written |
| h5 | `year3-replica` test-kit fixture | `packages/test-kit/src/year3-replica.ts:14` ("`replica_row` would agree with itself and with nothing else") | Volume is generated as shaped replica rows | **unnamed** | Regenerate as a whole-vault fixture in W2, before the seat store's parity tests depend on it |

Row counts: 39 rows — **retired by a named wave 18** · **partial 9** · **unnamed 12** (of which 3 are Keep).

### Findings

**F1 — Two gateway capability flags outlive the plane they describe, and the phone refuses to connect without them.** `multiVaultReplica` and `crossVaultPlacements` (`packages/core/src/protocol/capabilities.ts:14-15`) are structural, non-optional keys in `GatewayCapabilities`, and `supportsMobileOfflineGateway` (`apps/mobile/src/lib/replica/mobile-gateway-compatibility-core.ts:56-62`) hard-fails the compatibility wall when either is false — so W3 cannot delete the mount plane without deciding what these two words mean afterwards. R12 keeps multi-vault per owner but as N files with one open for reads, which is not what `multiVaultReplica` announces, and `crossVaultPlacements` has no successor at all in R1–R25. Rule that both keys are removed in W3 under the same epoch bump as the mount plane, and that the compatibility wall gates on the new snapshot/log-tail doors instead — a capability map that advertises a deleted mechanism is worse than no map.

**F2 — The gateway's own 1,000-row read window is a second pagination policy, and R8 only names the handler host's.** `GATEWAY_DEFAULT_READ_ROWS` and the truncation announcement it drives (`packages/vault/src/gateway/read-truncation.test.ts:1-6`) exist because the gateway was the fallback reader for what a slice lacked; under R9 the gateway runs the same `queries/*.ts` as every seat. Leaving it means a handler is paged on a seat and windowed-then-truncated on the gateway, which is exactly the divergence the paging parity tests are supposed to forbid. Rule that W4 makes the gateway read path a consumer of the same keyset page, and that `truncated`/`appliedLimit` leave the gateway result type in the same commit they leave the seat's.

**F3 — Custody has five machine states, a five-value CHECK, and a two-state ruling that only touches copy.** `blob_custody_state.custody_state` is CHECK-constrained to five values (`packages/vault/src/schema/blob.ts:361`), `doctor.ts:115-143` asserts an invariant over them, and W3/W4 reduce only "the custody copy" to two states. A CHECK is a commitment; leaving five values under a two-state reading means the third, fourth and fifth are unread state nothing constrains — the mechanical-sweep failure mode CLAUDE.md names. Rule that W3 decides the column explicitly: either collapse the CHECK to the states R7 admits (with `blob_presence` carrying the seat dimension) or keep five and write down, table by table, which reader each remaining value serves.

**F4 — `holdsReplica` survives R1's deletion of the question it answers.** `packages/client/src/react/screens/vault-custody.ts:11-45` reports "N machines hold a full copy" from `rememberDevice`, the bit the "Keep an offline copy" switch writes; under R1 every enrolled seat holds the vault, so the switch, the predicate and the two-number custody line are all answering a question that no longer has two answers. W4's "web custody copy reduced to two states" reduces the wrong axis. Rule that W2 deletes `rememberDevice`, `holdsReplica` and the offline-copy setting, and that the custody line becomes the seat watermark (how current each seat is), which is the fact R1 leaves worth showing.

**F5 — The year-3 fixture and two ledger volumes are defined in slice units.** `packages/test-kit/src/year3-replica.ts:14` generates `replica_row` rows, and `tests/journeys.json:26-27` defines `year3-replica` as "50,000 replica rows on a phone" and `year3-household` as "5 mounted vaults = 10 SQLite handles". W2's parity tests and W3's device exit rows both measure against these, so a fixture still shaped like a slice would let a wave exit green on the wrong volume. Rule that W2 regenerates the fixture as a whole `vault.db` before any seat-store parity test cites it, retires `year3-household`, and re-words the `gateway/converge` probe's "shape rebuild" span (`tests/journeys.json:297`) in W1.

**F6 — `app-manifest-reads.test.ts` enforces scope attribution that W4 deletes the manifest half of.** W4 replaces `vault.scopes` and `app-entity-tripwire.ts` with plan snapshots, but the sibling test that fixes *attribution by named scope* (`packages/blueprints/src/app-manifest-reads.test.ts`, cited as the source of that rule at `app-entity-tripwire.ts:17-21`) is not named anywhere in the issue. Left standing it will fail against a manifest with no `scopes` key, and the cheap fix is to weaken it. Rule that it is deleted in the same W4 commit as the tripwire, with the plan snapshot as the sole review diff.

### Keep

- **`packages/vault/src/gateway/search.ts:108-135` + `gateway/access.ts:27,87-116` — the field mask.** It looks like the slice's mask but its only source is `identity.scopeClamp`, the automation execution clamp R17 keeps. It is authz over a principal, not a statement about what a seat holds. Rename it if anything, don't delete it.
- **`packages/server/src/acp/vault-sql-tool.ts` — owner-credentialed SQL at the gateway.** The harness is an egress class under R17 and its reads are gated by the enrichment gate; running it on a seat would put an egress principal inside the file. Stays gateway-side for a real reason.
- **`packages/vault/src/gateway/assistant-context.ts` — the schema map.** Built per turn from the live file so it cannot drift, and consumed by a model behind the egress gate. Not a slice workaround; W0b only needs to keep its ontology prose current (it already edited `:29` for the revision occurrence).
- **`packages/vault/src/gateway/portability.ts` + `portable-sealed-custody.ts` — export.** Reads private tables and sealed custody, which R3 keeps off every seat. A seat-side export of the replicated half is a later proposal, not a #996 deletion.
- **`packages/blueprints/src/no-inference-client.test.ts` — the provider-SDK tripwire.** Reads like an old-model manifest sweep but it enforces the enrichment doctrine (#712), which R1–R25 do not touch.
- **`apps/mobile/src/kit/transfer/backup-verdict.ts` — "verdict from the durable queue, never the rollup".** The rule survives #712 intact; only its terminal condition changes, per R7's verified-at-gateway definition (see f6).

### Verdicts after re-judging each finding against the code

| Finding | Verdict | What the code says |
|---|---|---|
| F1 capability flags | **stands** | `build-gateway.ts:3636-3637` always sends both `true`; `mobile-gateway-compatibility-core.ts:56-62` returns `update-gateway` when either is false; no other non-test reader. After W3 the words describe nothing; W3 replaces them with the new-door capability W1 adds. |
| F2 gateway read window | **does not stand as written** | `gateway.ts:600-640`: `gateway.read` is the generic entity/where/limit read with the R17 field mask, the demo exclusion for `identity.kind === "agent"`, and the probe-row truncation; its callers are `vault-plane.ts`, `vault-picker.ts`, `import-routes.ts`, `automation-anchor-scopes.ts`, the ACP prompt — automations and the server, not app screens. W4 moves app handlers off it; the window stays for the callers that remain. |
| F3 custody CHECK | **rejected** | The five states are the gateway's byte custody against the remote CAS: written by `blob/direct-transfers.ts:185-462` and `blob/preflight.ts:51-84`, read by `custody-rollup.ts`, `direct-transfers.ts:78`, `custody-proven.ts`. Nothing about a seat's slice; R7's "two-state copy" is the seat's byte copy, a different column. |
| F4 offline-copy switch | **modify, not delete** | `SettingsVaultScreen.tsx:321` is the browser's choice between holding an encrypted replica and holding nothing; server carries `rememberDevice` into replica access (`replica-routes.ts:947,1112`). R9 keeps a remote-only client, so a shared browser still needs the switch. Only the census record count on the custody line goes (W5 deletes census); the seat watermark replaces it. |
| F5 year-3 replica fixture | **stands, reworded** | `year3-replica.ts:1-40` builds the phone file through `readReplicaRows` + `ReplicaSqliteStore.bootstrap` into `replica_row` and forbids a hand-built replica; W2 rewires it to snapshot copy + log tail and keeps the 1/10/40 intent volumes; `year3-household` retires with the mount plane. |
| F6 manifest-attribution test | **stands** | `app-manifest-reads.test.ts:1-8` fixes read scopes as the pool the gateway turns into consent grants and shapes (#883); it is deleted in the W4 commit that deletes `vault.scopes` and the tripwire. |

## Wave 0d — queries and contracts

USD 100 + EUR 100 read as USD 200. `pairwise` folded minor units into a map keyed by **party alone** and the dashboard labelled the sum with the vault's base currency, so a friend you owed EUR 100 and USD 100 appeared, on the app's most-read screen, to be owed 200 of a money nobody had. The vault had carried the currency on `tally_group`, `tally_settlement`, `tally_obligation` and `tally_expense.settlement_currency` since [#916](https://github.com/srikanth235/centraid/issues/916); every one of those columns was read past.

### The shape

**`Money` is the fix, and it is a type rather than a check** (`packages/core/src/money/index.ts`, exported as `@centraid/core/money`). An amount carries its currency; `addMoney` on a mismatch **throws** rather than producing a third number; a position that spans currencies is a `MoneyBag` — at most one amount per currency, sorted, zeros dropped — and there is no operation that collapses one into a scalar.

**A single figure over several currencies is a `Valuation`**, which either carries the rates that produced it or reads `unavailable` with its components and the currencies it spans. There is no rate plane in the product (a later proposal), so today's honest answer for a mixed position is `unavailable` — and the type makes that answer impossible to skip. `netValuation` subtracts two valuations over their COMPONENTS and values once, so "unavailable minus unavailable" cannot quietly become a number.

**The output contract moved, and every consumer moved with it — by compiler error, not by grep.** `FriendSummary.net_minor` → `balances: Money[]`; `NetPart.net_minor` → `net: Money`; `GroupSummary.owner_net_minor` → `owner_net: Money`; `GroupMember.net_minor` → `net: Money`; `Transfer.amount_minor` → `amount: Money`; `TallyDashboard.owe_total_minor` / `owed_total_minor` → `owe` / `owed: Valuation`. That is R22's "a shared Money type in the query output contract makes a bare amount unrenderable as a balance", and it is what turned 134 call sites across 26 files into a list the compiler produced.

**A group is one ledger, in one money.** `tallyGroupNet` stays a minor-unit fold — every expense and settlement in a group agrees with `tally_group.currency` by DDL — and its result is labelled with that currency at every output. `tallySimplification` and `minimalTransfers` take the group's currency, so a proposed payment carries the money it is in. The export is on the same helpers: it used to ship the vault's BASE currency on a group's own ledger, in a file that outlives the app.

**The formatters grew Money-typed figures** (`format.ts`): `moneyFigure`, `moneyNetFigure`, `moneyTone`, `bagFigure` (several amounts joined, never summed), `bagTone`, `bagSubLabel`, `valuationFigure`, `valuationTone`. The `(minor, currency)` pair survives for the leaves that render a stored amount; a BALANCE cannot reach them any more.

### Scenarios

| # | Scenario | Where | Reads through |
| --- | --- | --- | --- |
| 1 | Adding two currencies throws instead of returning a third number | `packages/core/src/money/money.test.ts` | `addMoney` |
| 2 | A position folds per currency, drops zeros, sorts, and negates entrywise | `money.test.ts` | `moneyBag` / `addBags` / `negateBag` |
| 3 | A single-currency position values with **no** rate, because none was used | `money.test.ts` | `valuate` |
| 4 | Two currencies with no rate source value as `unavailable`, with components | `money.test.ts` | `valuate` |
| 5 | Two currencies WITH a rate value to one figure, naming the rate | `money.test.ts` | `valuate` |
| 6 | **USD 100 + EUR 100 returns two balances, and nothing is 20 000** | `packages/blueprints/src/query-handlers-996.test.ts` | `apps/tally/queries/dashboard.ts` |
| 7 | The hero says `unavailable` rather than adding EUR to USD | `query-handlers-996.test.ts` | the same handler |
| 8 | Each group answers in its own money | `query-handlers-996.test.ts` | the same handler |

### Site accounting

- `net_minor`, `owner_net_minor`, `owe_total_minor`, `owed_total_minor` in code: **0** (134 sites across 26 files before; the two remaining hits are a comment in `types.ts` and a comment in `query-handlers.test.ts` describing what was there).
- Output fields carrying a bare balance: **0**. Six type fields became `Money` or `Valuation`.
- Files touched: 38, of which 12 are fixtures the type change reached.

### Files

**Core — the Money type (new)** — `packages/core/package.json`, `packages/core/src/money/index.ts`, `packages/core/src/money/money.test.ts`.

**Tally's balance engine and output contract** — `packages/blueprints/apps/tally/format.ts`, `packages/blueprints/apps/tally/queries/dashboard.ts`, `packages/blueprints/apps/tally/queries/export.ts`, `packages/blueprints/apps/tally/queries/friend.ts`, `packages/blueprints/apps/tally/queries/group-departed.test.ts`, `packages/blueprints/apps/tally/queries/group.ts`, `packages/blueprints/apps/tally/types.ts`, `packages/blueprints/src/tally-simplify.test.ts`, `packages/blueprints/src/tally-simplify.ts`.

**Tally's web surfaces and fixtures** — `packages/blueprints/src/query-handlers-996.test.ts`, `packages/blueprints/src/query-handler-ctx.test-fixtures.ts`, `packages/blueprints/apps/tally/app.json`, `packages/blueprints/apps/tally/components/Ledgers.tsx`, `packages/blueprints/apps/tally/components/Route.tsx`, `packages/blueprints/apps/tally/components/Screens.tsx`, `packages/blueprints/apps/tally/components/Settle.tsx`, `packages/blueprints/apps/tally/compose-states-kit.ts`, `packages/blueprints/apps/tally/compose-states-v17.test.tsx`, `packages/blueprints/apps/tally/export-file.test.ts`, `packages/blueprints/apps/tally/ledger-reads.ts`, `packages/blueprints/apps/tally/states.test.tsx`, `packages/blueprints/src/query-handlers.test.ts`.

**Tally on the phone** — `apps/mobile/src/apps/tally/BalancesView.test.tsx`, `apps/mobile/src/apps/tally/BalancesView.tsx`, `apps/mobile/src/apps/tally/GroupsView.tsx`, `apps/mobile/src/apps/tally/PendingRestartJourney.test.tsx`, `apps/mobile/src/apps/tally/TallyFriendScreen.tsx`, `apps/mobile/src/apps/tally/TallyGroupScreen.tsx`, `apps/mobile/src/apps/tally/TallyHome.test.tsx`, `apps/mobile/src/apps/tally/TallyHome.tsx`, `apps/mobile/src/apps/tally/TallyParts.tsx`, `apps/mobile/src/apps/tally/TallySettleScreen.tsx`, `apps/mobile/src/apps/tally/tally-airplane.test.ts`, `apps/mobile/src/apps/tally/tally-store.test.ts`, `apps/mobile/src/apps/tally/tally-store.ts`, `apps/mobile/src/lib/replica/inline-query-ctx.native.test.ts`.

**Docs** — `docs/vault-ontology.md`.

### Gates

```sh
bun run --filter @centraid/core test           # 19 files, 302 passed (money: 6)
bun run --filter @centraid/blueprints test     # 212 files, 7079 passed, 2 expected fail
npx vitest run --root apps/mobile              # 286 files, 2438 passed
bun run --filter @centraid/vault test          # 198 files, 1610 passed, 2 skipped
bun run --filter @centraid/client test         # 2478 tests, 1 pre-existing FAIL (below)
bun run --filter @centraid/core typecheck && bun run --filter @centraid/blueprints typecheck
bun run --filter @centraid/client typecheck && bun run --filter @centraid/mobile typecheck
bun run --filter @centraid/vault typecheck && bun run --filter @centraid/server typecheck  # all 0
bun run lint && bun run format:check           # clean
bash .governance/run.sh                        # 22/22
```

### A red client test that is wave 0b's, diagnosed and handed back

`packages/client/src/replica/search-parity.test.ts > core.content_item names a live FTS entity and carries its columns` fails on `d96172c40` with every change here stashed. The representation split made `core_content_item`'s indexed `title` an EXPRESSION over the owning asset (`OWNED_TITLE_SQL`), and the parity scanner counts only `kind: "column"` entries — so the vault side now reports no direct columns while `REPLICA_LOCAL_SEARCH` still names `title`.

Removing the entry was tried and **reverted**: ten `sqlite-store` / `store-core` tests search `core.content_item` by title on the seat, and they would need to search `media.asset` instead — which is not in the vault's FTS registry at all (it `foldsIn` to the content item's index). Making a seat search a folded-in entity is a Photos-side design decision, not a rename, so it belongs with W4's Photos work rather than being bodged from here. Left exactly as red as it was found, with the analysis, rather than made worse or papered over. **Flagged for the owner.**

### Decisions — wave 0d

- **`tallyGroupNet` was NOT made currency-aware inside.** A group is one ledger in one money by DDL (a trigger holds a grouped settlement to its group's currency), so the fold is sound as minor units and only its RESULT needed labelling. Making it return a bag would have implied a group can hold two currencies, which the schema forbids — a type is a claim, and that claim would be false.
- **`valuate` with one currency is `valued`, not a special case.** Nothing was converted, so no rate was used, and the answer carries an empty `rates` list. The alternative — `unavailable` whenever a rate plane is absent — would have made the ordinary single-currency vault unable to show its own total.
- **The reminder still takes ONE amount.** `nudgeWrite` writes `as_of_minor` on `tally_nudge`, a stored column this wave does not touch; the surface passes the first currency in the friend's position. A reminder about a two-currency position is a real product question and is not answered here. **Flagged for the owner.**
- **`Transfer.amount` moved, `expense.amount_minor` did not.** A stored fact keeps its column shape — the row carries `settlement_currency` beside it and W4 rewrites these handlers. What moved is every field that is a BALANCE: a derived figure with no currency of its own until someone labels it, which is exactly where ONT-23 lived.
- **Nothing here changes a stored column, so the golden corpus is not re-frozen.** 0d is reader-side by construction; the currencies it reads have been in the DDL since #916.
- **`query-handlers.test.ts` was SPLIT, not waived.** Both of this wave's reader tests landed there and pushed it past the repo's 625-line file limit. The `ctx` builder moved to `query-handler-ctx.test-fixtures.ts` — one builder, so two suites cannot disagree about what a handler is handed — and the #996 blocks moved to `query-handlers-996.test.ts`. Naming a waiver instead would have been the cheap fix the directive exists to refuse.

## Wave 0e — evidence and the fixture

One commit. Machine claims gain their evidence and stop overwriting each other, deletion gains a role beside every reference onto a person or a content item, and the thirteen scenarios stop being thirteen tests and become a **scripted fixture** another package can replay.

### The shape

- **A claim carries its evidence.** `core_tag` gains `derivation_id` → `enrich_derivation` and `input_revision_id` → `core_entity_revision`, both `ON DELETE SET NULL`, with a table CHECK that an owner-asserted tag cites neither: a member's tag is not a model's output and may not borrow one's provenance.
- **Competing claims are representable.** The table-level `UNIQUE (target_type, target_id, concept_id)` is gone — it made two engine profiles disagreeing *unrepresentable*, because the second claim silently replaced the first. In its place, two partial unique indexes that keep every uniqueness still true: `core_tag_owner_assertion_idx` (one OWNER assertion per target and concept) and `core_tag_machine_assertion_idx` on `COALESCE(derivation_id, '')` (one machine assertion per DERIVATION, so a re-run replaces its own row and nobody else's).
- **The preferred claim is derived, never stored.** `packages/vault/src/enrich/assertions.ts` computes it the way `preferredDerivation` computes its own: the owner first, then the profile the caller's policy points at, then the built-in engines, then a stable tie-break on profile name and id. Confidence does **not** order the list — a higher number from a profile the member did not choose is a different engine's opinion, not a better answer. No column anywhere says "this is the one".
- **The publisher writes the link and probes narrowly.** `enrich-publishers.ts`'s tag payload carries `derivation_id` / `input_revision_id`, the update path `COALESCE`s them, and the probe narrows on `COALESCE(t.derivation_id, '') = COALESCE(?, '')`, so a second profile's claim is a create rather than an update.
- **Deletion is declared by relationship role.** `packages/vault/src/schema/deletion-roles.ts` declares **56** references onto `core_party` and `core_content_item` as one of five roles — owned child (4), derived (3), attribution (6), participation (22), durable record (21) — each with its reason in prose and its `ON DELETE` rule fixed by the role (`ROLE_ON_DELETE`). A declaration may name the SWEEP rather than the key as what carries it out, and says so; that is the one case where the key's own rule is free. `derived` exists to tell rebuildable output apart from an owned child: both cascade, and only one of them can be regenerated.
- **The thirteen scenarios are a fixture.** `packages/vault/tests/fixtures/ontology-scenarios/` is a builder that runs the real commands and the real import path against a fresh vault and hands back every claim **already read through the path a surface reads it through**. It is exported as `@centraid/vault/tests/ontology-scenarios`, so W1's convergence run replays it from another package without importing anything of the vault's internals.

### Scenarios

Thirteen, all against ONE vault in this order, each naming the drift row it reproduces and the two app surfaces its command→query round trip crosses. The full table with the surfaces is `packages/vault/tests/fixtures/ontology-scenarios/README.md`.

| # | Scenario | Reproduces | Wave |
| --- | --- | --- | --- |
| 1 | An end-dated primary does not block its replacement | ONT-30 | 0b |
| 2 | The same short handle in two issuers is two identities | ONT-30 | 0b |
| 3 | 猫, 犬, कुत्ता and बिल्ली are four concepts | ONT-29 | 0b |
| 4 | Bank A and Bank B may both import `ref-1` | ONT-24 | 0b |
| 5 | Two documents with identical bytes keep separate histories | ONT-22 | 0b |
| 6 | One byte row, two documents, two readings | ONT-28 | 0b |
| 7 | Create, skip day two, query — under five readings of one wall clock | ONT-25 | 0c |
| 8 | Completing from People and then from Tasks is one completion | ONT-27 | 0c |
| 9 | A recurring person task rolls over once, and keeps its links | ONT-27 | 0c |
| 10 | The same impossible task, refused by the command and by the row editor | ONT-26 | 0c |
| 11 | USD 100 + EUR 100 is two balances, and nothing is 200 | ONT-23 | 0d |
| 12 | Competing machine claims, and the owner's assertion above them | R22 | 0e |
| 13 | One purge, and each role behaves as its declaration says | R22 | 0e |

The count is thirteen. Beside them, this wave's own suites: `deletion-roles.test.ts` (4 census cases + 4 behavioural purges, one per role) and `assertions.test.ts` (6, all written through the real publisher and read through `competingAssertions` / `preferredAssertion`).

### Site accounting

- `DELETION_ROLES`: **56** declarations; every live FK onto a roled parent is declared and every declaration names a live key, both held by the census tests rather than by a comment.
- `UNIQUE (target_type, target_id, concept_id)` on `core_tag` in code: **0** (the one remaining hit is the comment recording that it is gone).
- The scripted fixture: **13** scenarios, **52** assertions in the vault suite, one replay comparison.

### Files

- `packages/vault/src/schema/core.ts` — `core_tag`'s two evidence columns, the owner-vs-machine CHECK, and the two partial unique indexes replacing the table-level `UNIQUE`.
- `packages/vault/src/schema/core-side-tables.ts` and `packages/vault/src/schema/migrate.ts` — `core.ts` passed the repo's 625-line limit with the `core_tag` change, so its two 1:1 SIDE TABLES (`core_link_anchor`, `core_content_text`) moved out whole, comments included, and `migrate.ts` imports them from there. Split rather than waived; no DDL text changed, which the golden corpus proves.
- `packages/vault/src/schema/deletion-roles.ts`, `packages/vault/src/schema/deletion-roles.test.ts` — the role census and its two halves (mechanical, behavioural).
- `packages/vault/src/enrich/assertions.ts`, `packages/vault/src/enrich/assertions.test.ts` — the derived preferred assertion.
- `packages/vault/src/ingest/enrich-publishers.ts` — the evidence link on write, and the per-derivation probe.
- `packages/vault/src/gateway/gateway.ts` — `invoke` accepts the deterministic id seed the execution stage has always supported and nothing reached.
- The fixture, all under `packages/vault/tests/fixtures/ontology-scenarios/`: `packages/vault/tests/fixtures/ontology-scenarios/README.md`, `packages/vault/tests/fixtures/ontology-scenarios/build.ts`, `packages/vault/tests/fixtures/ontology-scenarios/clock.ts`, `packages/vault/tests/fixtures/ontology-scenarios/types.ts`, `packages/vault/tests/fixtures/ontology-scenarios/identity.ts`, `packages/vault/tests/fixtures/ontology-scenarios/behaviour.ts`, `packages/vault/tests/fixtures/ontology-scenarios/money.ts`, `packages/vault/tests/fixtures/ontology-scenarios/evidence.ts`, `packages/vault/tests/fixtures/ontology-scenarios/index.ts`, `packages/vault/tests/fixtures/ontology-scenarios/ontology-scenarios.test.ts`.
- `packages/vault/package.json` — the `exports` map, adding `./tests/ontology-scenarios` beside `.` (the package had none; `.` keeps exactly the resolution it had).
- `packages/vault/vitest.config.ts`, `packages/vault/tsconfig.test.json` — `tests/**` joins the package's own `test` and `typecheck` scripts.
- `packages/vault/tests/golden/issue-929/manifest.json` and `packages/vault/tests/golden/issue-929/vault.db.gz` — re-frozen for the `core_tag` DDL change, per **ONT-ladder** (the old corpus opens, migrates, keeps every row and is doctor-clean first).
- `docs/vault-ontology.md` — three rows added to `## Commitments the code enforces`: the role census, the evidence link with its derived preference, and the reader-test rule with the fixture as its mechanism.
- `scripts/docs-site/src/content/ontology-body.html` — core.tag's two new columns on the published page.
- `packages/client/src/replica/search.ts`, `packages/client/src/replica/store-core.test-fixtures.ts`, `packages/client/src/replica/store-core.test.ts`, `packages/client/src/replica/sqlite-store.test.ts`, `packages/client/src/replica/store-core-storage-lifecycle.test.ts`, `apps/mobile/src/lib/replica/native-replica-store.test.ts` — the carried-in FTS fix below.

### The client FTS fix carried in this commit

`search-parity.test.ts` was red on the tree this wave started from: wave 0b's representation split made `fts.ts:115` index a content item's title as an expression over `media_asset`, and no replica shape ships that, while `REPLICA_LOCAL_SEARCH["core.content_item"]` still claimed `title` as an eager column. The entry is dropped and the photo FTS fixtures move to `knowledge.annotation.body_text`. It is a finished fix for a red this wave's own suite would otherwise carry, so it lands here rather than being left for W1.

### Gates

```sh
cd packages/vault && bunx vitest run       # 201 files, 1678 tests, 1675 passed, 2 skipped, 1 failed → golden DDL only
bun run golden-vault:freeze -- --label issue-929   # 67 tables, 289 rows, schema v5
cd packages/vault && bunx vitest run src/golden-vault.test.ts   # 5 passed
cd packages/client && bunx vitest run      # 273 files, 2478 passed
cd packages/blueprints && bunx vitest run  # 213 files, 7083 passed, 2 expected fail
cd packages/core && bunx vitest run        # 19 files, 302 passed
cd apps/mobile && bunx vitest run          # 286 files, 2438 passed
bun run lint && bun run format:check
bash .governance/run.sh
```

The one vault failure above is `golden-vault.test.ts`'s DDL-equality case, red between the `core_tag` change and the re-freeze; green after it, which is the second command's whole purpose. Every package's `typecheck` is green.

### Decisions — wave 0e

- **Offline photo TITLE search is unavailable on the old device store until W2.** The carried-in fix drops `core.content_item.title` from the replica's eager search columns because the vault indexes it as an expression over `media_asset` and no shape ships it. Accepted as a v0 interim rather than papered over: W2's seat builds the vault's own FTS from `fts.ts` over the whole file, and that is where the title comes back. Not fixed in the old store.
- **The fixture holds the global clock rather than gaining a seam.** The execution stage stamps every instant from `nowIso()`, and there is no clock dependency to inject. `installFixtureClock` proxies `Date` for the length of the build and restores it in a `finally`. The alternative — threading a clock through the gateway for a fixture's benefit — would have put a test seam in the write path.
- **Ids are reproducible; the bootstrap's are not.** `Gateway.invoke` now forwards the `deterministicIdSeed` the execution stage has supported since it was written and no caller could reach. Bootstrap ids stay UUIDv7 off the clock, so `fixture.digest` canonicalises identifiers to the order they first appear — the property a convergence test wants (same rows, same order, related the same way) rather than the stronger one nothing needs.
- **One vault for all thirteen, not thirteen vaults.** A scenario that only holds in a vault containing nothing else is not telling the truth about the product. The cost is two rules a new scenario must respect, both written in the README: each series takes its own week (`schedule.propose_event` refuses a busy overlap across calendars), and every read narrows to the rows its own scenario wrote. Three scenarios were wrong on exactly that when first written and were corrected, not loosened.
- **`derived` is a fifth role, beside R22's four.** R22 names owned child, attribution, participation and durable record, and also asks that "a parent-owned projection is told apart from rebuildable derived data" — which the four cannot express, since decoded text and a representation both cascade. `derived` is that distinction, declared rather than inferred.
- **The package gains an `exports` map.** `@centraid/vault` had none, so every subpath resolved by file path. Adding one to expose `./tests/ontology-scenarios` also closes the package's surface to everything else; `.` keeps exactly the resolution it had, and no consumer imports a subpath today.

## Wave 1 — schema and epoch

The seat's file is now describable: what a seat may hold is a **table list**, the key material two identity registers carried is **a table away** rather than a column exclusion, every mutable row carries the **version an intent's conflict check compares**, and the log the whole wave hangs off exists with its two numbers. The producer, the decoder and the deletion of `replica_change` are the next commit — this one is the shape they write into.

### The commit boundary moved by one, deliberately

The brief splits wave 1 as *(1) schema, delete `replica_change`, re-point the projector* then *(2) capture and decoder*. Taken literally that leaves an intermediate commit where the only writer of `replica_log` does not exist yet and the only reader has been re-pointed at an empty table — the projector's own tests would be asserting over nothing. The owner's standing ruling is the opposite: **old mechanisms are deleted in the commit their replacement lands**. So the boundary moved one step: this commit lands the schema plane and leaves `replica_change` untouched and green; the next lands capture, the decoder and the deletion together, which is the commit where `replica_log` actually has rows. Nothing is deferred and no rung is created — only the seam between two commits moved to where the replacement is real.

### What changed

- **The private-table list is data** — `packages/vault/src/schema/private-tables.ts` (new). Twenty-four declarations in three kinds (credential, gateway-job, peer-link), each with its reason in one clause, plus `replicatedTablesOf` and `replicatedReferencesToPrivate` — the property the list exists for, as a function.
- **`access_device` and `access_agent` are split** (R3) — `packages/vault/src/schema/access.ts:60-101`. The identity projection replicates so `core_content_item.origin_device_id` (`packages/vault/src/schema/core.ts:257`) and `media_asset.camera_device_id` (`packages/vault/src/schema/domains-social-knowledge-media.ts:167`) resolve on a seat; `access_device_secret(device_id, public_key, sync_cursor)` and `access_agent_secret(agent_id, enrollment_key)` hold the rest. **The private sibling references the replicated parent, never the other way round** — that direction is what keeps a seat's copy satisfying its own foreign keys. Callers moved: `packages/vault/src/bootstrap.ts:180-196,238-252`, `packages/vault/src/gateway/identity.ts:35-45,60-70`, `packages/vault/src/blob/content-keys.ts:74-140,180-190,227-240`, `packages/vault/src/host.ts:29-40,336-345,374-382,428-440`, `packages/vault/src/gateway/gateway.ts:2035`, `packages/server/src/serve/vault-plane.ts:1451`.
- **`row_version` on every mutable table** (R6) — 67 tables, added beside `updated_at` and bumped by the **same** touch trigger (`packages/vault/src/schema/updated-at.ts:16-58`). The trigger's WHEN guard moved from `updated_at` to `row_version`: it still terminates under recursive triggers, and it still lets an importer keep an explicit timestamp, but a writer that stamps `updated_at` by hand no longer skips the bump — which is exactly the writer a stale-base check must not miss. Three hand-written composite-key touch triggers in `packages/vault/src/schema/domains-tally.ts` folded into `touchUpdatedAt(table, [pk…])` rather than being copied a fourth time.
- **`replica_log` exists** (R5) — `packages/vault/src/schema/replica.ts:76-127`, with `commit_seq`, the two numbers `schema_epoch` and `ddl_version` as separate columns, the physical `"table"`, `pk_json` as a JSON array in declared key order, `row_json`, `indirect`, `producer` and `committed_at`; three indexes for the three reads (tail by seq, whole commits, latest image per key).
- **One `schema_epoch` bump for 0b and 1** — `REPLICA_SCHEMA_EPOCH` 1 → 2 (`packages/vault/src/schema/replica.ts:26`). Wave 0b deliberately carried none of its own.
- **The seat SQLite floor is written down** — `SEAT_SQLITE_FLOOR = "3.49.1"` (`packages/vault/src/schema/replica.ts:41-64`). The gateway is **not** the oldest build: gateway 3.50.2, browser 3.53.0, phone (expo-sqlite under SQLCipher) **3.49.1**. The comment names what that rules out (`concat` 3.44, `octet_length` 3.43, `unhex` 3.41, two-argument `json_valid` and `jsonb_*` 3.45) and what the plane is built from (`STRICT` 3.37, `ON CONFLICT DO UPDATE` 3.24, `RETURNING` 3.35, `->>` 3.38, `VACUUM INTO` 3.27). Nothing in this commit's DDL is newer than the floor.
- **Portable export carries the split siblings; a seat snapshot never will** — `packages/vault/src/gateway/portability.ts:50-68,110-116,296-303,330-345`. Two different questions: *private* names what must not reach a seat, and a portable export is the owner moving their own vault to their own next machine. Drop the device key out of it and §11's round-trip gate is what catches the loss — as it did.
- **Golden corpus re-frozen** — `packages/vault/tests/golden/issue-929/{vault.db.gz,manifest.json}`, 68 tables / 290 rows (was 67 / 289: `access_device_secret` and its row).
- **The ontology page follows the schema** — `scripts/docs-site/src/content/ontology-body.html`: `row_version` drawn on all 54 documented mutable tables, `enrollment_key` / `public_key` / `sync_cursor` removed from `access.agent` and `access.device` with both table blurbs saying where the material went and why the projection stays.

### The coordinator's golden-corpus note, checked and not acted on

> *"the 0b re-freezes dropped the year-3 share distributions — the re-frozen `issue-929` golden now has 0 `share_subscription` rows … versus 13 live grants before wave 0."*

**The premise does not hold, so the corpus was not widened.** `packages/vault/tests/golden/issue-929` has never carried those rows — not at `50ab218cf` (#929's own commit, before wave 0), not at `c8e113820`, not now. The manifest at both revisions reports no `share_subscription`, no `share_subscription_lineage`, no `media_asset`, no `core_collection`, no `core_tag`, one `share_authority`, 67 tables. Nothing was dropped.

The 13 grants are real, but they belong to a different artifact: `YEAR3_DISTRIBUTIONS` (`packages/test-kit/src/year3-shape.ts:103-116`) drives `seedYear3Vault`, which **generates** a year-3 vault at run time — `grantees: 12` plus `granteeCircles: 1` written by `packages/test-kit/src/year3-distributions.ts:255-300`. The frozen corpus is `scripts/golden-vault/build.mjs`'s deliberately narrow one, and its own header states the rule: *"A broader corpus is not a better gate; a corpus nobody can read the diff of is a worse one."*

**The guard asked for already exists, where it means something**: `packages/test-kit/src/year3-vault.test.ts:109-153` asserts `media_asset`, `core_party` and `knowledge_note` counts against the distributions, the grantee-authority count against `distributions.grantees` and the circle-principal count against `distributions.granteeCircles`. Adding count assertions to `golden-vault.test.ts` would have asserted the corpus contains rows the build script has never written — a gate that fails on the honest state of the tree.

### Gates

```
cd packages/vault && bun run test            # 201 files, 1676 passed, 2 skipped
cd packages/vault && bun run typecheck       # clean
cd packages/server && bun run test           # 388 files, 3462 passed, 3 expected fail, 7 skipped;
                                             #   3 failed: acp/launch ×2 + gateway-db-lock (environmental here)
bun run golden-vault:freeze -- --label issue-929   # 68 tables, 290 rows, schema v5 (ontology 1.0)
```

### Decisions — wave 1, schema and epoch

- **The private list is 24 tables, not P4's 28.** Six of P4's names (`outbox_grant`, `share_commons_cursor`, `share_commons_device_reach`, `share_commons_steward_contact`, `share_commons_verified`, `share_commons_replay`) do not exist in the schema this tree builds — P4 measured the *golden* vault, frozen before #929 retired the commons plane. Declaring names no live table carries would make the list unfalsifiable, which is the one thing a closed list must not be. Two names were added by the split (`access_device_secret`, `access_agent_secret`), so 28 − 6 + 2 = 24. Every name is asserted against the live schema by `private-tables.test.ts`, which also runs the property the list exists for.
- **The split's foreign key points from the private sibling to the replicated parent.** The other direction would have been the more obvious modelling — a device's identity row pointing at its key — and it is exactly the shape R3 forbids: a replicated table keying into a private one is what makes a seat's copy fail its own constraints.
- **The touch trigger bumps both, in one trigger.** A second trigger per table would be a second chance to forget one, and a `row_version` that is true for some writers and not others is worse than none: the conflict check would pass on a stale base rather than fail loudly.
- **`row_version` is on the private tables too.** It costs one column on rows no seat ever sees, and the alternative is a per-table exception list that a future split would have to remember — the rule "every table with `updated_at` has `row_version`" is checkable; "every table with `updated_at` except these" is not.

## Wave 1 — capture and decoder

The log has a producer. A commit is no longer something the schema reports through 288 triggers it has to keep regenerating; it is something SQLite already knows and the gateway now asks it for.

### What changed

- **The JSON type contract** — `packages/core/src/protocol/row-json.ts` (new, exported from `packages/core/src/protocol/index.ts`). BLOBs as base64, integers past 2^53 as decimal strings, SQL `NULL` as `null` and an absent column as an absent key. Base64 is written out by hand rather than borrowed: this package is dependency-free and the code runs on all three seats, where `Buffer` is Node's and `btoa` takes a binary string. `applyRowSql` and `deleteRowSql` live here too, so the statement a seat runs is stated once, beside the encoding it binds.
- **The changeset parser** — `packages/vault/src/replica/changeset.ts` (new). `node:sqlite` exposes `changeset()` and `applyChangeset()` and nothing between them — no `sqlite3changeset_start` — so the v1 wire format is parsed directly. Integers are read as `bigint`, not `Number`: the spike's parser used `Number(v)` and would have corrupted a rowid past 2^53 without saying so.
- **The capture and the decoder** — `packages/vault/src/replica/log.ts` (new). One session per replicated table, opened in `beginReplicaCommit` and decoded in `endReplicaCommit`, both **inside the caller's transaction**. One session per table is mandatory rather than tidy: P1 measured `createSession({ filter })` accepted and **silently ignored** on 3.50.2 and 3.51.2, so a single filtered session would carry the private tables it was told to skip.
- **The applier** — `packages/vault/src/replica/apply.ts` (new). It is here, in wave 1, because the convergence gate is not a claim anyone can check without one: replaying the rows with bespoke test SQL would prove nothing about the code a phone runs. `INSERT … ON CONFLICT DO UPDATE`, one transaction per commit with the cursor inside it, an epoch gate that refuses rather than skips, table order with foreign keys off.
- **The commit pair carries a producer** — `beginReplicaCommit(vault, { producer })`, `endReplicaCommit` returns what it captured, and `abandonReplicaCommit` drops the sessions on a rollback path. A rolled-back transaction's changes are undone in the file but not in the session watching them, so the drop is not optional.
- **`replicatedTablesOf` is cached on `PRAGMA schema_version`** — `packages/vault/src/schema/private-tables.ts`. The statement-cache gate (`change-log-statement-cache.test.ts`) caught the uncached version compiling a catalog scan on every warm pass; keying the cache on SQLite's own schema counter means an ext band's mid-session DDL invalidates it without a second notion of "the schema changed" that could disagree.
- **Three more private tables** — `blob_access`, `blob_orphan`, `blob_replica`: what THIS host has cached, first saw orphaned, and proved is also remote. Twenty-seven declarations now.

### Gates

```
cd packages/core   && bun run test   # 19 files, 302 passed
cd packages/vault  && bun run test   # 203 files, 1697 passed, 2 skipped
cd packages/server && bun run test   # 388 files, 3464 passed, 3 expected fail;
                                     #   3 failed: acp/launch x2 + gateway-db-lock (environmental here)
bun run check:push:static            # 4/4 gates
```

`log.test.ts` is the wave's gate, in three parts:

| Battery | Cases | What would be missed without it |
| --- | --- | --- |
| capture and decode | 6 | full image on an omitted-column update; a no-op update and an insert-then-delete recorded as changes; a delete without its old image; a cascade not carried as its own row; a pk change recorded as an update; a private table in the log |
| oracle | 5 | a decoder that is self-consistently wrong — every case applies the same commit as JSON rows through the real applier AND as the native changeset through `applyChangeset`, and requires the two copies equal, plus equal to the origin |
| convergence and atomicity | 6 | drift in a table the test did not name (the assertion is over **every** replicated table); FTS query parity; duplicate delivery; a crash mid-batch; a row from another epoch applied silently; a page ending mid-commit |

### Decisions — wave 1, capture and decoder

- **`core_entity` replicates now, and `core_entity_kind` with it.** Both were declared local in #916 because a replica re-derived them through the membership triggers. A seat runs **no triggers except FTS sync** (R4), so "re-derived on the seat" has no mechanism left — the rows have to travel. This is the first place where R1's *every seat holds the vault whole* actually overrides a #916 exclusion, and it is why the replicated set is computed as "the file's tables minus the private list" rather than read off `LOCAL_TABLES`.
- **The `beginReplicaCommit` / `endReplicaCommit` pair is now a contract, not a convenience.** `node:sqlite` exposes no commit hook, so there is no way to capture a transaction the pair does not bracket. Every canonical write path already brackets — twenty call sites — which is what made session capture possible at all. A write outside the pair is captured by the NEXT pair's sessions: it converges, but it lands with a later commit position and a producer that did not write it, so the pair is documented as required rather than left as an implicit habit.
- **The applier ships in wave 1 rather than wave 2.** It is seat code and W2 owns the seat, but a convergence gate without an applier is a test of the test. Splitting it would have meant writing the replay twice and gating on the copy that is not shipped.

## Wave 1 — snapshot, doors, capability

A seat bootstraps by being handed the file. What makes that safe is not what the copy contains but what has been physically removed from it — and the test for that reads the **bytes**, not the catalog.

### What changed

- **The sanitised snapshot builder** — `packages/vault/src/replica/seat-snapshot.ts` (new), P4 variant B: `VACUUM INTO` → `PRAGMA secure_delete = ON` on the copy → drop every trigger except FTS sync → drop every index and view naming a private table → drop the private tables → truncate the log leaving `floor_seq` as the seat's resume cursor → final `VACUUM`. The gateway's own file is only read: the whole sanitisation runs on the copy, so a failure part-way leaves a discardable artifact and nothing else.
- **`namesPrivateTable` strips SQL comments first.** The first run dropped `share_subscription`'s index because the table's DDL *explains* its relationship to a private neighbour in prose. Matching raw object text finds a private table in the commentary of an object that never reads it.
- **The canary test** — `packages/vault/src/replica/seat-snapshot.test.ts` (new), four cases. The private canary is planted in `access_device_secret` (a private table with a replicated parent — the split this list exists for), asserted **present** in an unsanitised `VACUUM INTO` copy first, then absent from the snapshot's bytes. `fileContains` deliberately does not open the file as a database, and carries a needle-length tail across chunk boundaries. The seat file is opened **raw** with `DatabaseSync` — no migration ladder, no app-defined SQL function, no trigger regeneration; a snapshot that needed any of those would not be a snapshot.
- **`golden-snapshot.ts`'s FTS exclusion, fixed** — `packages/vault/src/golden-snapshot.ts:58-70`. The pattern was `name NOT LIKE '%_fts%'`, where `_` is LIKE's **one-character wildcard**: it matches a name with a character *before* "fts", which no shadow table has. So the exclusion excluded nothing. The frozen manifest carried **51 FTS tables against 17 real ones** — 75% of the corpus manifest was index bytes. Now `NOT LIKE 'fts\_%' ESCAPE '\'`, and the re-frozen manifest is 17 tables.
- **The two seat doors and the key door** — `packages/core/src/protocol/routes.ts`: `vaultSeatSnapshot`, `vaultSeatLog`, `vaultSeatLockerKey` (contract only; W6 lands the key plane). The snapshot door is a **static file**, not an RPC: the artifact is hundreds of megabytes at year-3 scale and the phone will be interrupted, so range requests and an ETag are the transport's ordinary behaviour rather than a protocol feature.
- **The capability map** — `packages/core/src/protocol/capabilities.ts`: `seatReplica` and `seatLockerKey`, both optional, both defaulting **off**. They are two flags rather than one because a gateway can serve the whole file and hold no locker key, and a seat that conflates them tells a member "unreadable secret" where the truthful answer is "this vault has no locker". Both stay `false` until the commit that serves the doors — a capability that lies is worse than one that is absent.
- **Ledger row `gateway/snapshot/year3/ci-linux-x64-4c`** — `tests/journeys.json`, measured, with provenance. **Review F5**: the `gateway/converge` probe's span no longer says "shape rebuild"; what that named is the gateway reading `replica_log` from the seat's seq, and there is no per-app shape to rebuild.

### The measurement

| | year-3 corpus (106 MB, 12,968 pages @ 8 KiB, 260 tables, 590 triggers) |
| --- | --- |
| source | 106,233,856 B |
| snapshot | **64,569,344 B** (60.8%) |
| snapshot, gzip-6 | **9,145,212 B** (8.6% of source) |
| build | **2,261 / 2,326 ms** (2 runs) |
| private tables dropped | 25 |
| triggers + indexes + views dropped | 554 |

Cross-checks P4's variant B (64,495,616 B) to within 73,728 B — the size of the added `replica_log` table. The first run, taken before the log truncation landed, produced 99,549,184 B raw and 15,062,429 B gzipped: **the two log truncations are 33% of the file**, because the corpus carries 78,376 `replica_change` rows a seat has no reader for.

### Decisions — wave 1, snapshot and doors

- **The snapshot truncates BOTH logs.** `replica_change` is on its way out, but a file frozen before it goes still carries it, and on the year-3 corpus that is a third of the snapshot. The builder checks for the table rather than assuming it.
- **The FTS shadow tables stay.** Dropping them saves 12.0 MB and is not free: the 57 retained FTS sync triggers survive the drop and then fail on the seat's first write with `no such table: main.fts_…`. That trade needs a mandatory seat-side FTS DDL + `'rebuild'` bootstrap step before the first apply, and it is a decision with a mechanism attached — not a line in this pipeline.
- **The capability flags ship `false`.** They name doors the routes declare and the server does not yet serve (below). A seat gates on the flag, so shipping it `true` ahead of the handler would turn a clean "this gateway does not serve seats" into a 404 the seat has no vocabulary for.

### Not landed in this wave, and why

Stated plainly rather than left to be discovered:

- **`replica_change` and its 288 triggers are still in the tree**, and the old projector still reads them. The replacement is real — capture, decoder, applier and the convergence gate all land here — but re-pointing `packages/server/src/routes/replica-projection.ts` at `replica_log` is a change across ~50 files in three packages whose filtered-membership semantics (`old_values_json`, `prior_op`, the compaction-held entities, the shape-control verdict) do not map one-to-one onto full row images. Landing that half-done would have left the shaped route wrong in ways the current tests do not cover. **The two mechanisms coexisting is not a design and should not be read as one.**
- **The server handlers for the two doors.** The route names and the capability flags are in the contract; `packages/server/src/routes/replica-routes.ts` does not serve them yet.
- **`vault_content_text` is not retired.** The function-free FTS sync triggers over `core_content_text` need decoded text written at command time by ten `core_content_item` writers, and the decode cannot move into a trigger — the trigger would fire on a seat, where the function does not exist. Schema landed in 0b; the write path and the trigger change did not land here.
- **Commit 4 — retention, the producer bound, dependency-aware execution and the outcome contract (R23–R25)** — did not land.

## Wave 1 — retention and the producer bound

Two numbers, both measured, and a floor that replaces compaction.

### What changed

- **Retention, and no compaction** — `packages/vault/src/replica/log.ts`, `pruneReplicaLog`. The old change log folded superseded entries because a change entry was a POINTER — "row X changed" — and several of them for one row said nothing the last one did not. A log row is a full image, so folding buys nothing a truncation does not, and it cost a `prior_op` / `prior_old_values_json` pair on every row plus a scan that had to reason about filtered membership. What replaces it is a floor, and **two things the floor may not cross**: a commit edge (a seat resuming at the floor would get half a transaction) and a live seat's cursor (**OQ-13** — pruning past a seat converts a cheap tail into a forced re-bootstrap, silently, on the gateway's schedule rather than the member's). `lowestSeatCursor` reads `access_device_secret.sync_cursor`, which is exactly the gateway's own record of how far it has served each device.
- **The producer bound, confirmed at 2,000 rows** — `REPLICA_PRODUCER_MAX_ROWS`. P2's proposal stands: a 2,000-row commit is at most 1.4 MB of `row_json` and ≈38 KB gzip-6, under 4% of the threshold, so **a conforming producer cannot produce a deferrable commit by accident**. Chunking to 2,000 costs +0.7…+1.6% total compressed bytes against one 10,000-row commit; 500 costs +2.2…+6.8% and 250 costs +7.9…+13% — which is what makes 2,000 the knee rather than a round number.
- **The defer threshold, in compressed bytes** — `REPLICA_DEFER_THRESHOLD_BYTES = 1_000_000`, the middle of P2's measured 512 KB – 2 MB band. Never in rows: the same 10,000-row commit measures 55 KB, 209 KB or 184 KB gzipped depending on whether it is deletes, inserts or updates, a **6.6× spread**, so a row-denominated threshold defers a cheap commit and admits an expensive one.
- **The deferral flag on the log row** — `replica_log.deferred`, one verdict per commit carried on every row of it, because a commit is the unit a seat applies and therefore the unit a seat defers. **A conforming commit is never compressed to find out**: paying gzip on the write path to learn a number the bound already guarantees is the cost the bound exists to avoid, so the measurement runs only when a producer failed to chunk.
- **Ledger row `gateway/log-apply/1000-commits`** — measured, with provenance.

### The measurement

| | 1,000 commits × 5 statements = 10,000 log rows |
| --- | --- |
| capture | **2,532.8 ms** — 2.5 ms/commit for the whole session set, reproducing the pre-wave spike's ~2 ms |
| log read | **90.1 ms** |
| apply | **3,878.6 ms** — 2,578 rows/s, **258 commits/s** |

The rate is **transaction-bound, not row-bound**: 3.9 ms per commit against 0.39 ms per row, because R5 requires one transaction per commit with the cursor inside it and 1,000 commits is 1,000 durable boundaries. That is the price of the property — a seat that batches commits into one transaction is faster and cannot answer "which commits have I applied" after a crash. Five statements is a small commit; a bulk producer chunking to the 2,000-row bound pays the boundary once per 2,000 rows and lands far closer to the row rate.

### Gates

```
cd packages/vault && bunx vitest run src/replica   # 12 files, 79 passed
bunx vitest run --config vitest.quality.config.ts  # 60 tests, 4 failed — all four
                                                   #   pre-existing (0b removed
                                                   #   core_content_item.media_type;
                                                   #   backup-corpus-fixture.ts:83
                                                   #   still writes it). Identical
                                                   #   before and after this wave.
```

### Decisions — wave 1, retention

- **The floor keeps the commit it lands in, rather than trimming to it.** Both directions land on an edge; keeping the straddled commit means the floor moves less than asked, which errs toward serving a seat rather than toward reclaiming bytes. The opposite error is the expensive one.
- **A seat's cursor is a hold, not a hint.** `pruneReplicaLog` takes `holdAtOrAbove` and defaults it to the lowest seat cursor rather than making the caller remember. A retention sweep that has to be TOLD not to strand a phone will eventually be called by something that forgot.
- **`maxAgeMs` clamps at the epoch instead of throwing.** A caller passing a huge window means "never prune by age"; the first version produced `Invalid Date` and failed the sweep entirely, which is the wrong answer to a legible request.

## Wave 1 — every file the wave touched

One list, so `receipt-per-issue` has the whole change set and a reader has one place to see its shape. Fifty-nine files; the ten new ones are the plane itself.

**The log plane (new)**

- `packages/core/src/protocol/row-json.ts`
- `packages/vault/src/replica/apply.ts`
- `packages/vault/src/replica/changeset.ts`
- `packages/vault/src/replica/log-retention.test.ts`
- `packages/vault/src/replica/log.test.ts`
- `packages/vault/src/replica/log.ts`
- `packages/vault/src/replica/seat-snapshot.test.ts`
- `packages/vault/src/replica/seat-snapshot.ts`
- `packages/vault/src/schema/private-tables.test.ts`
- `packages/vault/src/schema/private-tables.ts`

**Schema — `row_version` on every touched table, and the DDL that carries it**

- `packages/vault/src/schema/authority.ts`
- `packages/vault/src/schema/blob-transfer.ts`
- `packages/vault/src/schema/blob.ts`
- `packages/vault/src/schema/core-side-tables.ts`
- `packages/vault/src/schema/core.ts`
- `packages/vault/src/schema/domains-locker.ts`
- `packages/vault/src/schema/domains-people.ts`
- `packages/vault/src/schema/domains-schedule.ts`
- `packages/vault/src/schema/domains-social-knowledge-media.ts`
- `packages/vault/src/schema/domains-tally.ts`
- `packages/vault/src/schema/enrich.ts`
- `packages/vault/src/schema/entity-revisions.ts`
- `packages/vault/src/schema/ext.ts`
- `packages/vault/src/schema/ontology-rules.test.ts`
- `packages/vault/src/schema/ontology-shape.test.ts`
- `packages/vault/src/schema/subscription.ts`
- `packages/vault/src/schema/sync.ts`
- `packages/vault/src/schema/time-organize.ts`

**Schema — the split, the list, the log table, the trigger**

- `packages/vault/src/schema/access.ts`
- `packages/vault/src/schema/local-tables.ts`
- `packages/vault/src/schema/replica.ts`
- `packages/vault/src/schema/updated-at.ts`

**Callers the split moved**

- `packages/client/src/react/shell/routes/automationThreadData.ts`
- `packages/server/src/serve/vault-plane.ts`
- `packages/vault/src/blob/content-keys.ts`
- `packages/vault/src/bootstrap.ts`
- `packages/vault/src/gateway/gateway.ts`
- `packages/vault/src/gateway/identity.ts`
- `packages/vault/src/gateway/portability.ts`
- `packages/vault/src/host.ts`
- `packages/vault/src/replica/unavailable-columns.ts`

**The commit pair, and the mechanism it still brackets**

- `packages/vault/src/replica/change-log.test.ts`
- `packages/vault/src/replica/change-log.ts`
- `packages/vault/src/replica/intents.test.ts`

**The protocol contract**

- `packages/core/src/protocol/capabilities.test.ts`
- `packages/core/src/protocol/capabilities.ts`
- `packages/core/src/protocol/index.ts`
- `packages/core/src/protocol/routes.ts`

**Corpus, manifest and the ledger**

- `packages/vault/src/golden-snapshot.ts`
- `packages/vault/tests/golden/issue-929/manifest.json`
- `packages/vault/tests/golden/issue-929/vault.db.gz`
- `tests/journeys.json`

**Tests and docs that follow the schema**

- `packages/server/src/routes/replica-shape-parity.test.ts`
- `packages/server/src/routes/replica-shape.test.ts`
- `packages/vault/src/index.ts`
- `packages/vault/src/schema/ontology-rules.test.ts`
- `packages/vault/src/schema/ontology-shape.test.ts`
- `scripts/docs-site/src/content/ontology-body.html`
- `tests/perf/work-counters.perf.test.ts`
- `tests/quality/first-paint-query-counts.test.ts`
- `tests/quality/user-facing-qualities.test.ts`


## Wave 1 — the doors, and the function-free index

A seat needs exactly two things from the gateway and nothing else: **the file, once, and the log, forever after**. Both are now served. And the search index stops being something only the gateway can maintain.

### The doors

- **`packages/server/src/routes/seat-routes.ts`** (new), mounted at `/centraid/_vault/seat` ahead of the shaped route's prefixes (`packages/server/src/serve/build-gateway.ts:3878`). Identity is resolved by the **same** `resolveReplicaAccess` the shaped route uses: a seat is an enrolled device, and there is no narrower principal these doors could consult — the question they answer is "is this an enrolled seat", never "which rows may it see".
- **The snapshot door is a static file, not an RPC.** At year-3 the artifact is ~64 MB, ~9 MB compressed, and the client is a phone on a train. An RPC would have to invent resumption, chunking and integrity; a file gets ranges, a strong ETag and conditional requests from the transport for free. The artifact is **immutable for its name** — it is a pure function of the log position it was taken at — so a second seat at the same seq gets the same bytes and the same ETag, and a resumed download survives a gateway restart rather than only a request. Built beside the destination and renamed in, so a reader arriving mid-build sees no artifact or a complete one, never a half file it will happily decompress.
- **Compressed on disk, served as those bytes.** Not `Content-Encoding: gzip` over the raw file: a byte range has to be a range over *what the client is downloading*, and content-coding quietly makes that untrue.
- **The log door serves whole commits.** `?since=&limit=`, bounded at 10,000, and the page carries the rest of its last commit whatever the limit says. A stale or ahead cursor is **409 `seat_rebootstrap_required`** naming the reason, the floor, the watermark and the snapshot route — start over said out loud, never a page that is silently short.
- **The epoch gate runs on every row, not only on the cursor.** The cursor check is about the request; the row check is about the answer. A row from another epoch stands for a schema the seat cannot apply, and applying one is a silent no-op rather than a visible failure — so the gateway refuses to be the one that shipped it (500 `seat_log_epoch_mismatch`).
- **The `K` door authenticates and then says it has nothing.** 404 `seat_locker_key_unavailable`, deliberately not the 404 an unrouted path gives: a seat has to tell "this gateway holds no locker key" from "this gateway is older than the door", and the two call for different answers on the phone. W6 fills it in.
- **Capabilities follow the handlers, not the names**: `seatReplica` flips to `true` in this commit — the one that serves the doors — and `seatLockerKey` stays `false`.

### `vault_content_text` is retired — 0 callers

- **The decode moved to write time**, in `setRepresentation` (`packages/vault/src/schema/representation.ts`), which #996's own representation split had already made **the one writer**. That is the right seam rather than a convenient one: a body's text is a function of the bytes *and* of what this owner says the bytes ARE (R20(b)), so it cannot be derived from the content row alone, and it changes exactly when the representation changes.
- **Before the representation row, not after.** The representation's own FTS trigger is what puts the index back in step once the reading lands, and it now reads `core_content_text` — so the text has to be there when it fires. Getting that order wrong is what the People-journal search case caught.
- **Two new triggers on `core_content_text`** (`packages/vault/src/schema/blob.ts`) with a new `ftsRefreshByContent` helper (`packages/vault/src/schema/fts.ts`). **These are for the seat**: the applier writes a commit's rows in TABLE order, so the text can land after the note or document that reads it, and a seat runs no DDL and no refresh pass of its own. `ftsRefreshStatement` keys on the entity's own id; this one finds the owners *from* the content, and fans out — one content item can be the body of several rows.
- **Every remaining caller followed the column**: `schema/blob.ts` (the document body expression), `commands/documents.ts:660` (the edit postcondition), `gateway/sql.ts` (a read connection now needs no application-defined function at all), `gateway/assistant-context.ts`, and three tests whose SQL is now the same plain SQL a seat runs.
- The registration itself is gone from `db.ts`, `schema/baseline-fixture.ts` and `gateway/sql.ts`. `contentText` survives as the decoder; nothing calls `db.function` for it.
- The last caller outside `packages/` was `tests/quality/backup-corpus-fixture.ts`, which registered the function on its own handle so the baseline's triggers would fire. It needs nothing now. The same file was carrying **two reds this umbrella had left there**, both fixed here rather than walked past: its seed still wrote `core_content_item.media_type` and `.title`, dropped by #996's representation split (R20(b)); and once it built again, the determinism case went red because `canonicalize` REWRITES clock-stamped rows and the freed pages keep the real wall-clock bytes as residue — identical rows, different files. A `VACUUM` before the checkpoint rebuilds the file so what is on disk is only what is in the tables. `bunx vitest run tests/quality/backup-archaeology.test.ts` — 3 passed.

### The decode is a declared write now, so eleven manifests say so

`declared-writes.conformance` caught it rather than a reviewer: an action that
writes a representation now writes `core_content_text` too — an INSERT when the
bytes decode, a DELETE when a re-typing takes the text away — and two notes
actions were driving a table their manifest did not name. The honest fix is the
declaration, never a looser gate, and it belongs to every action that reaches
`setRepresentation`, not only the two the corpus happens to drive:

- `packages/blueprints/apps/agenda/app.json` (`attach`)
- `packages/blueprints/apps/docs/app.json` (`upload`, `edit`, `replace`)
- `packages/blueprints/apps/notes/app.json` (`create-note`, `edit-note`, `attach`)
- `packages/blueprints/apps/people/app.json` (`add-journal-entry`)
- `packages/blueprints/apps/photos/app.json` (`upload`)
- `packages/blueprints/apps/tally/app.json` (`add-receipt-expense`)
- `packages/blueprints/apps/tasks/app.json` (`attach`)

### Every file this commit touches

- `packages/core/src/protocol/capabilities.ts` · `packages/core/src/protocol/capabilities.test.ts` — `seatReplica` flips true
- `packages/server/src/routes/seat-routes.ts` (new) · `packages/server/src/routes/seat-routes.test.ts` (new) — the three doors and their scenarios
- `packages/server/src/serve/build-gateway.ts` — mounted ahead of the shaped route's prefixes
- `packages/server/src/routes/route-security.ts` — the new prefix registered in `ROUTE_SECURITY_REGISTRY`, so the security sweep covers it
- `packages/vault/src/schema/representation.ts` — `indexContentText`, the write-time decode, and `CONTENT_TEXT_DECODER`
- `packages/vault/src/schema/content-text.ts` (new) — `contentText` lifted out of `fts.ts`: the index reads a column now, so the decoder is no longer an FTS concern (and `fts.ts` was over the repo-hygiene line)
- `packages/vault/src/schema/fts.ts` — `registerContentTextFn` deleted, `valueExpr` reads the column, `ftsRefreshByContent` added
- `packages/vault/src/schema/blob.ts` — the document body expression, and the two `core_content_text` triggers a seat needs
- `packages/vault/src/schema/core-side-tables.ts` — the table's comment now describes what shipped
- `packages/vault/src/db.ts` · `packages/vault/src/schema/baseline-fixture.ts` · `packages/vault/src/gateway/sql.ts` — the registration removed from all three connection paths
- `packages/vault/src/gateway/portable-adapters.ts` — follows the decoder to its new module
- `packages/vault/src/commands/documents.ts` — the edit postcondition reads `core_content_text`
- `packages/vault/src/gateway/assistant-context.ts` — the model is told to join the column, not call a function
- `packages/vault/src/index.ts` — the replica commit handles the door tests open a commit with
- `packages/vault/src/gateway/assistant-context.test.ts` · `packages/vault/src/gateway/search.test.ts` · `packages/vault/src/gateway/sql.test.ts` · `packages/vault/src/ingest/staging.test.ts` — SQL that is now the plain SQL a seat runs
- `packages/vault/tests/golden/issue-929/vault.db.gz` · `manifest.json` — re-frozen: the FTS trigger DDL changed, and the golden gate compares the frozen schema against the baseline's
- `tests/quality/backup-corpus-fixture.ts` — no function to register; the two reds above
- the seven `packages/blueprints/apps/*/app.json` manifests listed above

### Gates

```
cd packages/core       && bun run test        # 19 files, 302 passed
cd packages/vault      && bun run test        # 205 files, 1708 passed, 2 skipped
cd packages/blueprints && bun run test        # 213 files, 7083 passed
cd packages/server     && bun run test        # 389 files, 3479 passed; 3 files red, all environmental
bun run golden-vault:freeze -- --label issue-929   # 17 tables, 181 rows, schema v5
bun run check:push:static                     # stamped on the committed tree
```

The three red server files are environmental and unrelated to this commit:
`src/acp/backends/acp/launch.test.ts` (two cases, sandbox/root detection) and
`src/serve/gateway-db-lock.integration.test.ts` (needs a real `sqlite3` binary).

`seat-routes.test.ts` covers each door twice over: the fresh plane, and then **both corpora** — 0e's thirteen scenarios (`buildOntologyScenarios`) and the frozen golden `issue-929`, opened through the migration ladder the golden gate uses. On both, the log tail carries more than five distinct tables, the snapshot gunzips to a real SQLite file, `access_device_secret` is absent from its bytes, and **the snapshot's seq is exactly the log's watermark** — the identity that lets a seat bootstrap from the file and tail from the number beside it.

### Decisions — wave 1, the doors

- **A plane-shaped stand-in for the corpus tests.** Both corpora are BUILT vaults, and a `VaultPlane` bootstrap is exactly what would overwrite them. The doors read three things off a plane, so the test supplies those three — rather than teaching the fixture to accept a foreign vault, which would put a test seam in the plane.
- **The mock response is a real `Writable`.** The first version was an object with a `write` method; `stream.pipeline` waits for `finish`, which such an object never emits, so the test hung for thirty seconds instead of failing. Extending `Writable` also puts the door's backpressure path under test.
- **Single-range only.** Multipart ranges are legal HTTP, no seat needs them for a resumed download, and emitting them correctly is more surface than the feature is worth — so `parseByteRange` refuses them by name rather than answering one range and pretending.

## Wave 1 — the outcome contract (R23–R25)

An intent used to be answered and forgotten. Five things it never told anyone
are now durable: **where it landed**, **what it produced**, **what it was
waiting for**, **how long its answer is good for**, and **what to do when that
runs out**.

### Where it landed, and what landed

- **`commit_seq` and `produced` are stamped inside the canonical transaction**,
  at the GROUP-COMMIT boundary (`packages/vault/src/gateway/gateway.ts:369`,
  `stampReplicaOutcomeCommitsInTransaction`). That is the seam because the
  gateway batches invocations into one transaction: the log position and the
  produced set belong to the BATCH, and a stamp anywhere outside it could name
  a commit that rolled back, or the wrong one because a later write moved the
  watermark in between. `packages/vault/src/gateway/execution.ts:751` stamps
  the same way for a path that owns its own commit handle.
- **The set is read from the capture, never re-queried.** `produced` comes off
  the decoded images in `captureReplicaCommit` (`replica/log.ts`) — a second
  read against the tables could see a LATER commit's `row_version` and settle
  the intent against work it did not do.
- **Both doors, one stamp.** The device door and the member door both arrive as
  `invoke({ intentId })`, so an outcome that carries the position on one path
  and not the other cannot happen. The member door also now RECORDS an outcome
  before invoking (`peer-replica-intent-route.ts`) — it previously answered
  from the invoke result and kept nothing, so a lost acknowledgement had
  nothing to replay against and a retry re-executed.

### The conflict check is on the row's own column

`currentConflict` compared `MAX(seq)` over `replica_change` — the position of
the last projector entry that mentioned the row. That is a property of the
TRANSPORT: it moves when the log is pruned or the epoch is bumped, it does not
exist for a row the projector never covered, and **a seat holding `vault.db`
whole cannot compute it at all**. It now reads `row_version`
(`replica-intent-shape.ts`), which is on the row, bumped by the row's own touch
trigger, and means the same thing on the gateway and on the phone. Zero is "not
there, or never touched", and `row_version >= 1` by CHECK, so zero can never be
a live row's answer. The projector remains the fallback for the append-only
bands, which carry no such column and which no intent bases a write on.

### The chain is causal, and the gateway is what makes it so

- **`dependsOn` is part of the payload hash.** It decides WHEN an intent runs
  and which rows its placeholders resolve to, so an intent whose predecessors
  were rewritten in flight is a different intent. Omitted when empty, exactly
  as `baseVersions` is.
- **Three verdicts, not two** (`replicaDependencyVerdict`). *Waiting* releases
  on its own when the predecessor lands; *abandoned* never will, and naming the
  predecessor and its reason is the difference between a queue that drains and
  one that quietly stops. Both park — the intent is retained, so a retry of the
  predecessor releases it.
- **A chain park is a wait, not a verdict.** Every other parked outcome is an
  immutable dedupe hit because it waits on a PERSON; a dependency park waits on
  another INTENT and must re-enter dispatch, or the queue behind a slow
  predecessor never drains.
- **The dependency gate runs BEFORE the conflict check**, on purpose: a
  dependent's base versions describe rows its predecessor has not produced yet,
  so checking them first would report a conflict where the honest answer is
  "not yet".
- **Predecessor references resolve by plain equality**, from `produced_json`,
  never "the latest task". WHICH produced row is not guessed: a canonical
  commit writes the entity's row AND the supertype mirror AND sometimes a
  revision occurrence, so either the placeholder names its table
  (`{"$intent": id, "table": "schedule_task"}`) or exactly one row survives
  after the engine's own bookkeeping tables are set aside. Anything else is
  left UNRESOLVED so the command's precondition refuses loudly — silently
  substituting a guess is how a rename lands on the wrong row.

### The window, and the far edge of it

- `REPLICA_IDEMPOTENCY_WINDOW_DAYS = 30`, the same number as the log's
  retention floor (OQ-13). Deliberately equal: an outcome that outlived the log
  rows its `commit_seq` points into can no longer tell a seat where its own
  effect landed.
- **Never pruned while a seat is behind it.** `pruneReplicaIntentOutcomes`
  holds any outcome whose `commit_seq` is at or above a live device cursor —
  pruning it turns a pending badge that would have cleared into one that never
  does.
- **"I no longer know" is a real answer and the only safe one.** A retry past
  the window gets 409 `replica_intent_outcome_expired` with
  `recovery: "resubmit-as-new-intent"`; the same id with a DIFFERENT payload
  gets 409 `replica_intent_payload_mismatch`. Neither re-executes. The mismatch
  is a plain refusal rather than the non-oracle 202 the route gives a foreign
  id, because `readReplicaIntentOutcome` is device-scoped: the device is asking
  about its own intent, and there is no existence to leak.

### Every file this commit touches

- `packages/vault/src/schema/replica.ts` — `commit_seq`, `produced_json`, `depends_on`, `expires_at` on `replica_intent_outcome`
- `packages/vault/src/replica/log.ts` — `produced` on the capture result
- `packages/vault/src/replica/intents.ts` — the four columns on the outcome, the window's default, `seat: "intent"`
- `packages/vault/src/replica/intent-chain.ts` (new) — the stamps, the dependency verdict, the predecessor resolver, the expiry answer and the pruner. Split out rather than piled onto `intents.ts`, which owns the outcome ROW (admit, transition, read, list, delete): the two are separate readings of one table, and together they are a god-file — `repo-hygiene` said so at 772 lines
- `packages/vault/src/replica/intents.test.ts` — the window, the OQ-13 hold, the three verdicts
- `packages/vault/src/gateway/gateway.ts` · `packages/vault/src/gateway/execution.ts` — the stamp at the commit boundary
- `packages/vault/src/index.ts` — the new surface
- `packages/server/src/routes/replica-intent-shape.ts` — `row_version`, `parseDependsOn`, `dependsOn` in the hash
- `packages/server/src/routes/replica-intent-route.ts` — the gate, the substitution, the mismatch and expiry answers
- `packages/server/src/routes/peer-replica-intent-route.ts` — the member door's durable outcome
- `packages/server/src/routes/replica-projection.ts` — `commitSeq`, `produced`, `dependsOn` on the wire
- `packages/server/src/routes/replica-intent-chain.test.ts` (new) — the chain
- `packages/client/src/replica/types.ts` — the widened `waitingOn`
- `packages/vault/tests/golden/issue-929/vault.db.gz` · `manifest.json` — re-frozen for the four columns

### Gates

```
cd packages/vault  && bun run test    # 205 files, 1711 passed, 2 skipped
cd packages/server && bun run test    # 390 files, 3486 passed; 2 files red, environmental
cd packages/client && bun run test    # 273 files, 2478 passed
bun run golden-vault:freeze -- --label issue-929
bun run check:push:static
```

The red server files are the same two environmental ones named in the previous
section: `src/acp/backends/acp/launch.test.ts` and
`src/serve/gateway-db-lock.integration.test.ts`.

`replica-intent-chain.test.ts` runs the chain against the REAL commands, not a
stub — `commit_seq` and the produced set only exist inside a canonical
transaction, and the whole question is whether the substituted row id addresses
the row the create actually made. Six cases: the five-intent chain in order
with five distinct ascending commit positions and one task carrying every
final value; out-of-order arrival that parks and then releases; a denied create
whose dependents park naming it with nothing executed; another device's edit
between two dependents producing EXACTLY ONE conflict with the parked
dependents behind it; the lost acknowledgement replaying the retained outcome
with its `commitSeq` and refusing a changed payload; and an outcome past its
window answering unknown-recover without a second execution.

### Decisions — wave 1, the outcome contract

- **The stamp is at the group commit, not in `execution.ts` alone.** The first
  version stamped in `execution.ts` and silently did nothing: the batch owns
  the replica commit handle, so `endReplicaCommit` there returns `undefined`
  and there was no capture to read. Every outcome came back with no
  `commit_seq` and the chain test found it.
- **`waitingOn.seat` gains `"intent"`.** The existing seats are people and
  places (`owner`, `origin`, `gateway`); a chain wait is neither, and the label
  is the PREDECESSOR'S INTENT ID because that is the only name a seat can match
  against its own outbox — there is no vault id yet for a row the create has
  not made.
- **A one-line SQL comment cost a build.** `expires_at`'s comment used
  backticks inside a template literal; the schema is authored as a TS template,
  so it terminated the literal.

## Wave 7 — the closure predicate, the member set, and the three outputs

A share stops being a *composed shape* and becomes what R10 says it is: **the
same log under a closure predicate, with membership as explicit state**. This
commit lands the predicate, the state, and the three outputs the difference
between two member sets produces. The transport that ships is untouched and
green — `composeShareShape` still serves every subscription — because the
invariant this wave is written under is that the share transport is never
deleted before its replacement lands.

### The grant is the shape

`shape_id` is gone from both subscription tables; the key is `authority_id`,
and `share_authority` **is** the grant. The `@share:<grantId>` sigil was a
second name for one row — one the origin minted, the audience stored, and the
peer route parsed back into a grant before it could authorize anything — so
`share_subscription`'s primary key is now `(authority_id, audience_vault_id)`,
`share_subscription_lineage`'s is `(authority_id, target_type, target_id)`, and
the separate `grant_id` column and its index are deleted. The sigil survives
exactly where it is still a wire value (the subscriber query, the change
notice); `peer-replica-route.ts` maps it to the grant at the door.

### Membership, on the origin

`share_subscription_member(authority_id, table_name, pk, entered_seq)`, primary
key on the triple, plus `INDEX (table_name, pk)` for the reverse question —
"which live grants claim this row" — that the closure diff, the purge sweep and
every leave output all ask.

- **`table_name` and `pk` are the LOG's own key.** `pk` is `replica_log.pk_json`
  — the key values in declared order, JSON-encoded — so a member row and a log
  row join by string equality, and a composite key (a collection entry, a
  circle member, an expense split) needs no second column and no parsing.
- **`entered_seq` is why a reconnect after retention expiry is cheap.** A
  retained row KEEPS its `entered_seq` across a pass; only a genuinely
  re-entered row gets a new one. Without it a resent row cannot be told from
  one the audience has held since the subscription began, and the only safe
  answer would be a re-bootstrap.

### The three outputs, and where each one can come from

`diffShareClosure` (`packages/vault/src/share/closure-outputs.ts`) is read-only
over the origin and returns `enter` / `update` / `leave` plus the cursor they
stand for. `commitShareClosureDiff` is a separate call, so a caller may compute
the outputs, fail to deliver them, and retry against the same `before` set
rather than against an audience state it only assumed.

- **`enter` is the member-set diff, never the log.** Measured on this tree: an
  existing photograph added to a shared album writes **two** log rows — the
  collection entry and its supertype registration — and **four** rows enter the
  audience's copy (the entry, the asset, its content item, its representation).
  `closure-outputs.test.ts` asserts both numbers side by side, because that gap
  is the whole reason membership has to be stored.
- **`update` is the log's, coalesced by `(table, pk)`.** One
  `UPDATE media_asset` produces two log rows — the write and the
  `touch_updated_at` bump that follows it — so without the coalesce every field
  edit crosses the boundary twice.
- **`leave` is the diff in reverse, for rows that did not themselves change.**
  Removing a photograph from a shared album deletes one entry row and says
  nothing about the four rows the audience must now scrub. And purging a shared
  *member* revokes nothing — `core_entity_revoke_on_purge` keys on a grant's
  **subject** — so `leave` is the only thing that reaches the audience's copy in
  the member case.
- **A cursor below the floor or in another epoch is a `resend`, not a
  re-bootstrap**: every member goes out as an `enter`, and `entered_seq` makes
  that an upsert on rows the audience already holds.

### Derived rows never project — as a TABLE rule

`SHARE_DERIVED_TABLES` names `core_content_derivative` and `core_content_text`,
and `readShareClosure` no longer pools either. Excluding the table by name
rather than the rows by variant is what makes "no vault-private reference can
leak" a property of the schema instead of a property of a reviewer checking each
new variant. `project-closure.ts`'s `projectDerivatives` — the walk that wrote a
generated caption, an OCR pass, a transcript, an embedding and a thumbnail
**into the audience vault** — is deleted, and derived bytes leave the blob
manifest with it (three photographs are three blobs, never six).

What replaces it is `projection-ingest.ts`: a projected asset enqueues `thumb`,
`embedding` and `phash` as the RECIPIENT's own work, a projected document
enqueues `text` and `embedding`, and captions and faces stay unqueued because
they are consent-gated and a projection must never manufacture an owner's
consent. That is R18 in machinery rather than in prose.

### Decisions — wave 7, the predicate

- **The member set is derived from `readShareClosure`'s result, not from a
  second walk.** R10 makes the closure the snapshot builder for a new
  subscriber; deriving membership from the same walk is what makes the snapshot
  and the diff incapable of disagreeing. The predicate is then one rule applied
  to that result — physical table plus log key, minus the derived tables, plus
  the owners' representation rows.
- **A representation IS a member; a caption is not.** Under R20(b) the owner's
  reading of its bytes is authored metadata, so it enters and leaves with the
  row it describes; a generated caption is a `knowledge_annotation`, which the
  closure has never walked. The spike measured `core_content_representation` as
  the one table the predicate claims and the old transport flattened into a wire
  field; the member set makes it a row, which is what lets an `enter` carry it
  and a `leave` remove it.
- **Derived rows are excluded on the SAME-OWNER placement edge too.** A
  placement is the owner moving their own item between their own vaults, and
  the receiving vault has both the bytes and the same owner's egress answers,
  so it re-derives. Excluding derivatives only on the cross-owner edge would
  have kept the thumb on a placement at the price of making "no derived table
  in a closure" conditional — and a conditional structural property is one a
  reviewer has to check rather than one that holds. Four placement tests moved
  to the new rule rather than being exempted from it.
- **`structure_digest` is still on the table, and its deletion is the commit
  the audience starts applying the outputs.** It is superseded by the member
  set, not deleted without a successor (R10's own words); deleting it here would
  leave `planShareShapeIngest` — the only thing deciding re-projection today —
  with no answer at all for the two commits before its replacement is wired up.
  Same boundary rule as wave 1's schema commit: old mechanisms are deleted in
  the commit their replacement lands.

### Every file this commit touches

- `packages/vault/src/share/closure-members.ts` (new) — the predicate, the
  member key, the stored set and the reverse lookup
- `packages/vault/src/share/closure-outputs.ts` (new) — `diffShareClosure`,
  `commitShareClosureDiff`, the coalesce
- `packages/vault/src/share/closure-outputs.test.ts` (new) — the red-first
  derived-row case and the four output cases
- `packages/vault/src/share/year3-convergence.test.ts` (new) — the exit
  criterion over `seedYear3Vault`'s live grants, the spike's seeding promoted
  into a real fixture
- `packages/vault/src/schema/subscription.ts` — `authority_id` in both tables,
  `grant_id` and its index gone, `share_subscription_member` added
- `packages/vault/src/schema/entity-catalog.ts` · `entity-refs.ts` — the new
  table registered, the lineage note re-keyed
- `packages/vault/src/share/read-closure.ts` · `closure.ts` — derivatives leave
  the closure, `DerivativeRow` and `WireRows.derivatives` deleted
- `packages/vault/src/share/project-closure.ts` — `projectDerivatives` deleted,
  `ShareShapeClaim` → `ShareGrantClaim` keyed by `authorityId`
- `packages/vault/src/share/projection-ingest.ts` — the recipient's own
  enrichment, per target kind
- `packages/vault/src/share/subscription-store.ts` · `subscription-seat.ts` ·
  `subscription-delta.ts` · `subscription-frame.ts` · `subscription-transport.ts`
  — the rename, and the digest's derivative half
- `packages/vault/src/grant/fulfillment.ts` — `ShareShapeTransport.remove` takes
  the grant
- `packages/vault/src/index.ts` — the two new modules exported
- `packages/server/src/routes/peer-replica-route.ts` — the sigil resolved to a
  grant at the door
- `packages/blueprints/apps/docs/queries/_shared.ts` ·
  `apps/mobile/src/apps/docs/docs-projection-shares.ts` — the readers follow the
  column
- `packages/vault/src/share/placement-fixture.ts` — `seedAlbum`, `addToAlbum`,
  `inCommit`
- `packages/vault/src/share/{placement,placement-lifecycle,closure-split,closure-confinement.contract,subscription}.test.ts`
  · `subscription-sim-plane.test-fixtures.ts` ·
  `packages/vault/src/blob/local-orphan-sweep.test.ts` ·
  `packages/vault/src/gateway/portability.test.ts` ·
  `apps/mobile/src/apps/docs/docs-projection.test.ts` — the new rule and the new
  key
- `packages/server/src/routes/replica-shape-parity.test.ts` — the `docs` shape
  id re-pinned, and why: `docs` is the one bundled app whose replica shape spans
  the two subscription tables, so re-keying them to `authority_id` moves its
  digest and its devices re-bootstrap once. The other seven ids do not move,
  which is what the file is for.
- `packages/vault/tests/golden/issue-929/{vault.db.gz,manifest.json}` —
  re-frozen: the subscription DDL moved
- `scripts/docs-site/src/content/ontology-body.html` — the new table drawn, and
  the fulfilment walkthrough no longer says derivatives cross

### Gates

```
cd packages/vault      && bun run test        # 207 files, 1719 passed, 2 skipped
cd packages/blueprints && bun run test        # 213 files, 7083 passed
cd packages/server     && bun run test        # 390 files, 3484 passed; 3 files red,
                                              #   all environmental (acp/launch x2,
                                              #   gateway-db-lock needs a real sqlite3)
cd packages/vault      && bun run typecheck   # clean
cd packages/server     && bun run typecheck   # clean
cd packages/blueprints && bun run typecheck   # clean
cd packages/client     && bun run typecheck   # clean
cd packages/core       && bun run typecheck   # clean
cd apps/mobile         && bun run typecheck   # clean
bun run golden-vault:freeze -- --label issue-929   # 17 tables, 181 rows, schema v5
```

## Wave 7 — the tail door, the row applier, and what the sheet now says

The predicate has a transport. An origin door serves the three outputs since an
audience's cursor, the audience applies them AS ROWS re-keyed through lineage,
and both stand **beside** `composeShareShape` rather than in place of it — the
frame path goes in the next commit, once the convergence gate has passed
through this one.

### The origin's door

`packages/vault/src/share/subscription-tail.ts` — `composeShareTail` returns a
**pass**: the frame to send and the `settle` that makes the membership it
stands for durable. They are separate on purpose. Settling before the audience
has the rows would advance the origin's belief about what the audience holds
and silently drop the retry; and `settle` closes over the member set THIS pass
computed, so it can never record a set some later walk produced.

`packages/server/src/routes/peer-replica-route.ts` mounts it at
`/centraid/_peer/replica/tail` (`PEER_REPLICA_TAIL_PATH`, registered in
`packages/core/src/protocol/replica-subscription.ts` and routed in
`packages/server/src/routes/peer-plane.ts`), under the same link-pair admission
as every other door on the plane.

- **A cursor is a claim, not an acknowledgement.** The door compares the
  audience's `since` against `share_subscription.cursor_seq` — the ORIGIN's own
  record of what it last served that audience — and a mismatch answers a
  **resend** of every member rather than a diff against a membership the
  audience never received. That is the one failure a per-grant member set
  cannot infer for itself, and `entered_seq` is what makes the resend an upsert
  rather than a scrub.
- **A grant this door cannot serve says so.** A Locker item's sealed columns
  must be re-sealed under the AUDIENCE DEK, which needs both vault keys in one
  process; no row on a wire carries that, so the door answers `snapshot` and
  the subscriber takes the bootstrap door. Never answered wrongly.

### The audience's applier

`packages/vault/src/share/apply-outputs.ts` is the one place that knows how an
origin row becomes an audience row. A per-table registry gives, for each of the
23 tables a closure can carry: the logical entity, the columns that name
another row, the polymorphic `(type, id)` pairs, the cross-vault columns
written NULL, the columns re-pointed at the audience's own owner, and the
natural key the audience dedupes on.

- **Re-keyed through lineage.** The applier claims EVERY row it writes, not
  only the named items, so an `update` or a `leave` finds the audience's row
  even when the two ids differ. An id is decided in four steps and in this
  order: lineage; the row's natural key (`sha256`, an asset's content, an
  owner's one reading of its bytes); a row some live subscription ALREADY
  claims under the same origin id — which is what lets a second grant over one
  photograph land on the first grant's row; and only then the origin's id,
  reused, with `freeId` minting on a genuine collision. The third step is what
  keeps `freeId`'s peer-controlled-id warning honest: a local row of the
  audience's own is never adopted, only one a subscription already claims.
- **Local facts stay local.** `updated_at` and `row_version` are never copied
  (#916, ONT-08); the audience's own touch trigger stamps them.
- **Write order is a list, and `leave` is its exact reverse.** A referencing row
  is written after the row it names and deleted before it, because the
  audience's foreign keys are real.
- **Projected rows are read-only.** `forwardProjectedEdit` answers where an
  edit belongs — the origin vault, the ORIGIN's row id, and the version the
  audience holds it at — instead of writing. It is a question, not a second
  enforcement point: the audience holds no grant over the origin and the origin
  is the single writer of its own rows. What it prevents is a seat quietly
  writing a local edit the next `update` would erase without telling anyone.

`ingestShareTail` (`subscription-seat.ts`) is the seat door: one transaction,
one replica commit, the outputs applied, the cursor recorded. The seat can
ingest EITHER shape this wave — a frame through `ingestShareShape`, a tail
through here — which is the transport invariant written in code.

`packages/server/src/serve/share-subscriber.ts` pulls the tail first and falls
back to the bootstrap door when the origin says `snapshot`; `pullBlobs` now
takes a manifest rather than a closure, so both paths share it.

### What the share sheet says now

Two sentences that were true all along and unsaid, in
`packages/blueprints/apps/_shared/shared-copy.ts` and printed by the mobile
sheet's general-access block (`apps/mobile/src/kit/share/ShareSheet.tsx`):

- `SHARE_IS_A_COPY` — *"Ending a share removes their copy and stops updates.
  Anything they exported first stays theirs."* Copy, not lease (R10), said
  before the decision because it is the part a person cannot undo afterwards.
  It does not claim more than the product can do: revoke reaches the copy this
  product placed, and nothing else.
- `SHARE_ENRICHMENT_IS_THEIRS` — *"Their vault makes its own thumbnails, text
  and search for the copy, under their settings."* R18, so a sender does not
  assume their own egress answers travelled.
- `LEAVING_SHARED_VAULT` is added beside them for the two-owner case. **There is
  no leave surface in the product yet**, so the sentence has no render site and
  is not wired to one — writing UI for a mechanism that does not exist would be
  worse than an unrendered constant with the rule stated once.

### Decisions — wave 7, the transport

- **Membership is per grant; the per-audience question is the cursor.** The
  schema keys `share_subscription_member` by `authority_id` alone (a grant's
  closure is one closure however many audiences it reaches), so a second
  audience served against an already-settled membership would see an empty
  `enter`. The origin-side `share_subscription.cursor_seq` closes that: an
  audience whose cursor does not match what the origin last served it gets a
  resend. No second table, and the acknowledgement it leans on is the meaning
  `cursor_seq` already had.
- **`entity-catalog.ts` split rather than waived, and spread IN PLACE.** It
  reached 628 lines against the repo's 625 limit; the eight app-owned schemas
  moved to `entity-catalog-domains.ts` and `VAULT_ENTITIES` spreads them, so
  there is still exactly one place a table is added. Same seam earlier waves
  used for `core-side-tables.ts` and `content-text.ts`. The spread sits exactly
  where the declarations stood, because a replica shape id is a digest over the
  composed columns IN REGISTRY ORDER: spreading at the top of the object moved
  ALL EIGHT shipped shape ids, which `replica-shape-parity.test.ts` caught — a
  file split that re-bootstraps every device is not a refactor.
- **The tally table names in the predicate were wrong and are fixed.** Wave 7's
  first commit named `tally_recurring_exception`, `tally_receipt`,
  `tally_receipt_line` and `tally_receipt_line_allocation`; the read actually
  uses `schedule_recurrence_exception`, `core_attachment` (the `role='receipt'`
  row, #883), `tally_expense_line_item` and `tally_expense_line_allocation`.
  The year-3 corpus seeds no receipts and no recurring templates, so the arrays
  were empty and nothing threw — a grant over a real Tally group would have.
  Caught by writing the applier's registry against the read.

### Every file this commit touches

- `packages/vault/src/share/subscription-tail.ts` (new) — the origin door and
  its settle
- `packages/vault/src/share/apply-outputs.ts` (new) — the row applier, the
  registry, and `forwardProjectedEdit`
- `packages/vault/src/share/subscription-tail.test.ts` (new) — the contract's
  transition tests: album add and remove, a folder move, overlapping grants
  with one revoked, purge of a shared member, reconnect after retention
  expiry, and the read-only route
- `packages/vault/src/share/subscription-seat.ts` — `ingestShareTail`
- `packages/vault/src/share/closure-members.ts` — the four corrected table names
- `packages/vault/src/share/year3-convergence.test.ts` — the third test is the
  gate commit 3 waits on
- `packages/vault/src/schema/entity-catalog.ts` ·
  `packages/vault/src/schema/entity-catalog-domains.ts` (new) — the split
- `packages/vault/src/index.ts` — the door, the applier and `ingestShareTail`
  exported
- `packages/core/src/protocol/replica-subscription.ts` ·
  `packages/core/src/protocol/index.ts` — `PEER_REPLICA_TAIL_PATH`
- `packages/server/src/routes/peer-replica-route.ts` — `handlePeerReplicaTail`,
  `ingestPulledTail`, the `applied` outcome
- `packages/server/src/routes/peer-plane.ts` — the door routed
- `packages/server/src/serve/share-subscriber.ts` — `pullShareTail`, and
  `pullBlobs` over a manifest
- `packages/blueprints/apps/_shared/shared-copy.ts` ·
  `apps/mobile/src/kit/share/ShareSheet.tsx` — the sheet's three sentences

**Files of `14333bdd5` not named in its own section**, named here so the change
set is fully accounted for: `packages/vault/src/schema/entity-refs.ts` (the
lineage reference note re-keyed to `authority_id`),
`packages/vault/src/share/placement-lifecycle.test.ts` (the injected-failure
point moved off the deleted derivative write, and the thumb's bytes no longer
crossing), `packages/vault/src/share/subscription-frame.ts` (derivatives out of
`closureRowIds`), `packages/vault/src/share/subscription-seat.ts` (the
`authority_id` rename through ingest and purge) and
`packages/vault/src/share/subscription-transport.ts` (the loopback's removal
takes the grant).

### Gates

```
cd packages/vault  && bun run test      # 208 files, 1726 passed, 2 skipped
cd packages/server && bun run test      # 390 files, 3486 passed; the same 3
                                        #   environmental files (acp/launch x2,
                                        #   gateway-db-lock needs a real sqlite3)
cd packages/vault  && bun run typecheck # clean; server, core, client,
                                        #   blueprints and apps/mobile likewise
bash .governance/run.sh                 # 22/22 directives
bun run check:push:static               # stamped on the committed tree
```

The two-gateway suites — `share-subscription-peer.test.ts` and
`share-surface-queries.test.ts` — now run THROUGH the tail door: `pullShareShape`
tries `pullShareTail` first and falls back only on `snapshot`, so every subject
type they cover crosses as rows before it ever crosses as a frame.

## Wave 7 — the frame path is deleted

`composeShareShape` is gone, and with it the door that served it, the digest
that decided what an ingest wrote, and the host-memory cache that decided
whether to compose at all. The predicate transport is the only way a share
travels now. What replaced each thing is named beside it below, because R10's
own rule is that nothing here is deleted without a successor.

### What went, and what answers for it

| Deleted | Successor |
| --- | --- |
| `share/subscription-frame.ts` (`composeShareShape`, the frame, its row-version read) | `share/subscription-tail.ts` — the three outputs since a cursor |
| `share/subscription-delta.ts` (the structure digest, `FIELD_TABLES`, `planShareShapeIngest`, `applyShareShapeFields`) | `share/apply-outputs.ts` — the member-set diff says which rows moved, so nothing has to be guessed from a digest |
| `share_subscription.structure_digest` | `share_subscription_member`, per R10's "superseded by the member set, not deleted without a successor" |
| `ingestShareShape` | `ingestShareTail` |
| `PEER_REPLICA_BOOTSTRAP_PATH` and `handlePeerReplicaBootstrap` | `PEER_REPLICA_TAIL_PATH` — a subscriber with no cursor gets every member as an `enter`, which IS the closure snapshot |
| `GrantProjectionMemory` and the per-host digest cache | a pass whose three outputs are all empty, read from origin state rather than from a cache a restart empties |
| the frame's size ceiling and sealed-column check | `share/share-ceiling.ts`, which keeps both and moves the ceiling onto the CLOSURE |

### Three things the deletion nearly took with it, and did not

- **THE CEILING IS A PROPERTY OF THE GRANT, so it is judged once per pass and
  before any audience is consulted.** Measured on the closure, never on a
  pass's outputs: an audience that is merely up to date has empty outputs and
  would sail past a ceiling the grant has never been under. `assertShareCeiling`
  runs at the top of `startShareSubscription`, which is what keeps "an
  over-ceiling grant leaves no fulfillment row even when every peer is
  unreachable" true — a check inside the delivery loop skips exactly that case.
- **THE SEALED REGISTRY IS STILL A PIPELINE PROPERTY.** The frame checked one
  hard-coded table; `assertSealedColumnsStaySealed` now checks every row a pass
  carries, by entity, against `sealedColumnsOf`.
- **DIVERGENCE IS STILL ERASED (ruling G-view, #846).** The shape composer
  repaired an audience that had edited a projected row by re-reading and
  comparing everything, every pass — which is the cost this wave exists to
  remove, so the property had to be re-earned rather than inherited.
  `share_subscription_lineage.audience_row_version` records what this vault's
  row was AT when the applier wrote it; a claimed row whose version has moved
  past that was written on this side. The seat reports the count, holds its
  cursor back, and the origin answers with one resend IN THE SAME PASS, so the
  divergence is erased by the pass that found it. Two statements per claimed
  table per pass, never one per row. `subscription-sim.test.ts`'s seed 839001
  holds it, and it is what caught the loss.

### The performance regression this wave nearly shipped

`tests/scale/share-journey.scale.test.ts` measured **3,447 ms** against its
750 ms ceiling the first time the tail path drove it — 4.6x over. Three causes,
all found and fixed rather than accommodated by moving the ceiling:

1. **An upsert re-prepared per row.** `upsertFor` was written and then not
   called: `writeRow` still built the SQL inline. 965 ms of 1,070 in the row
   loop, and the row loop dropped to 160 ms once it was wired up — against the
   projector's 473 ms for the same 801-row closure.
2. **The membership write ran outside a transaction.** 801 inserts, 801
   implicit commits, 627 ms of fsyncs. `writeShareMembers` opens one.
3. **The schema was re-read per row.** `primaryKeyOf` runs `PRAGMA table_info`
   on every call and the applier asked three times per row; cached per table
   per connection, in `apply-outputs.ts` and `closure-members.ts` alike.

The ledger row `gateway/share/shared-album/ci-linux-x64-4c` carries the number
under `_closureTailProvenance`: **428.4 ms** (397.7 / 428.4 / 491.0 over three
runs), against #929's 232.2 ms. **The interval grew and the reason is named
rather than hidden**: a tail pass also writes the origin's membership, 801 rows
the frame path did not have, and that is exactly what makes every later pass a
diff — the second pass over an unmoved album is three empty outputs and no
writes at all, which the frame path could never reach. The 750 ms ceiling is
NOT re-seeded.

### Decisions — wave 7, the deletion

- **A Locker grant answers `unsupported`, and that is not a regression.** Its
  sealed columns must be re-sealed under the audience DEK, which needs both
  vault keys in one process; the frame path could not do it either — its ingest
  passed no keys and threw. The door now says so and names the reason. Locker
  sharing arrives with W6, which is where the key plane does.
- **One pass per audience, not one composition per grant.** The frame was
  audience-independent, so one composition could be re-stamped for everyone. A
  tail is the difference since ONE audience's cursor; re-stamping it onto
  another would hand the second a set of rows computed against a position it is
  not at. The cost is one closure walk per audience of a grant, over a roster
  that is a circle's members.
- **The origin records its own `share_subscription` row now.** `cursor_seq` on
  the origin side is what the tail door compares an audience's claimed cursor
  against, and what the next pass diffs from. It is the meaning the column
  already had — "the audience's acknowledgement" — finally written by the push
  path as well as the pull path.
- **`@share:` survives as a wire credential.** The grant IS the shape in both
  tables and in every store, but `judgeSubscriberCredential` and the change
  notice still carry a `shapeId`, and `isShareShapeId` still guards the device
  plane's namespace while `buildReplicaShapes` lives (W5's). The sigil is
  resolved to the grant at the door; deleting it is W5's protocol bump, not
  this one's.
- **Two tests were edited to write inside a replica commit rather than behind
  the log.** The `update` half of the three outputs is the LOG's, so an origin
  edit made outside a captured commit is one no subscription can see. That is a
  property of the transport, not a gap in it, and a test that edits behind the
  log is exercising a write the gateway cannot produce.

### Every file this commit touches

- **Deleted**: `packages/vault/src/share/subscription-frame.ts` ·
  `packages/vault/src/share/subscription-delta.ts`
- `packages/vault/src/share/share-ceiling.ts` (new) — the ceiling and the
  sealed check, kept off the frame
- `packages/vault/src/schema/subscription.ts` — `structure_digest` dropped,
  `audience_row_version` added to the lineage
- `packages/vault/src/share/subscription-store.ts` — the digest's reader and
  writer gone
- `packages/vault/src/share/subscription-seat.ts` — `ingestShareShape` gone; a
  diverged seat holds its cursor back
- `packages/vault/src/share/apply-outputs.ts` — the statement caches and the
  batched id questions; split at the size rule into
  `packages/vault/src/share/apply-registry.ts` (the per-table DATA, which
  changes when a table does), `packages/vault/src/share/apply-shape.ts` (what
  the applier needs to know about a table, read once per connection) and
  `packages/vault/src/share/apply-divergence.ts` (the G-view half)
- `packages/server/src/serve/share-subscription-sweep.ts` — the peer sweep
  reads the predicate transport's `applied` answer as a delivery, with the
  three outputs' counts as its work-counter reading
- `packages/vault/src/share/closure-outputs.ts` ·
  `packages/vault/src/share/closure-members.ts` · `packages/vault/src/share/sql.ts`
  — one prepare per table, one key read per table, one transaction for the
  membership write
- `packages/vault/src/share/subscription-tail.ts` — the ceiling and sealed
  check on the pass; `maxSizeBytes`
- `packages/vault/src/share/subscription-transport.ts` — the loopback delivers
  tails and reports divergence
- `packages/vault/src/grant/fulfillment.ts` — one pass per audience, the
  up-front ceiling, the same-pass resend, the origin-side subscription row, and
  the projection memory's deletion
- `packages/vault/src/index.ts` — the deleted exports removed, the new ones added
- `packages/core/src/protocol/replica-subscription.ts` ·
  `packages/core/src/protocol/index.ts` ·
  `packages/core/src/protocol/replica-subscription.test.ts` — the bootstrap path
  deleted, and the plane's path set is the tail door plus the three that stay
- `packages/server/src/routes/peer-replica-route.ts` — the bootstrap door and
  `ingestPulledShape` deleted; the blob door authorizes against the grant's own
  closure manifest
- `packages/server/src/routes/peer-plane.ts` — the bootstrap route unmounted
- `packages/server/src/serve/share-subscriber.ts` — `pullShareShape` deleted;
  `pullShareTail` is the pull
- `packages/server/src/serve/build-gateway.ts` ·
  `packages/server/src/serve/share-subscription-peer.test-fixtures.ts` — the
  seat's pull re-pointed
- `packages/server/src/serve/grant-fulfillment.ts` — the projection memory gone
- `packages/vault/src/share/subscription.test.ts` — rewritten onto the tail,
  keeping every work-counter claim
- `packages/vault/src/share/subscription-sim-plane.test-fixtures.ts` ·
  `packages/vault/src/grant/fulfillment.test.ts` ·
  `packages/vault/src/grant/fulfillment.roster.test.ts` ·
  `packages/vault/src/gateway/portability.test.ts` ·
  `packages/server/src/serve/grant-fulfillment.test.ts` ·
  `packages/server/src/serve/share-subscription-peer.test.ts` — the outputs'
  vocabulary, and edits made inside a replica commit
- `packages/server/src/routes/replica-shape-parity.test.ts` — `docs` re-pinned
  a second time: `structure_digest` left the subscription and the lineage
  gained a column, and `docs` is the one app whose shape spans those tables
- `tests/journeys.json` — `_closureTailProvenance` on the share journey
- `packages/vault/tests/golden/issue-929/{vault.db.gz,manifest.json}` —
  re-frozen: the subscription DDL moved again
## Wave 2 — the applier and the bootstrap

The gateway has served the file and the log since wave 1. This is the other end
of both: the seat that takes them.

### The wire, moved to where two programs can share it

`packages/core/src/protocol/seat-log.ts` (new) carries `SeatLogRowWire`,
`SeatLogPageWire`, `SeatRebootstrapRequiredWire`, `SeatSnapshotHead`, the three
snapshot header names and `SEAT_LOG_MAX_PAGE`. Wave 1's door hand-shaped this
JSON and the seat would have had to hand-parse it; `seat-routes.ts` now
declares the same three types on its answers, so the two ends compile against
one object instead of agreeing by comment. No behaviour changed on the door —
the diff is types and three header constants.

The wire is deliberately not the storage shape: `commit_seq` → `commitSeq`,
`pk_json` → `pk`, no per-row `epoch` (the page carries it once, and wave 1's
door refuses to ship a row that disagrees), and `indirect` / `deferred` omitted
when false. A seat reads millions of these on a catch-up.

### The applier, in four rules

`packages/client/src/replica/seat/applier.ts`:

1. **One commit, one transaction, cursor included.** `seat_state.applied_seq`
   moves in the same transaction as the rows it names, so a crash leaves a
   commit boundary the next attempt resumes from. This is why wave 1's log door
   never pages mid-commit — the two halves of that invariant are now both real.
2. **`INSERT … ON CONFLICT DO UPDATE`**, from wave 1's `applyRowSql`. Never
   REPLACE: it deletes first and fires delete triggers only under
   `recursive_triggers`, which on a seat — whose only surviving triggers are FTS
   sync — desynchronises the index from the rows it indexes, silently.
3. **Idempotent by seq.** A row at or below the cursor is dropped before it is
   bound. The test is a delete followed by the SAME page redelivered: "an upsert
   that happens to be harmless" is not harmless there, it resurrects the row.
4. **Foreign keys off** (`SEAT_OPEN_PRAGMAS`). A page can carry a child before
   the commit that carries its parent; enforcing here would reject rows the
   gateway accepted.

And one refusal: a row whose `schema_epoch` is not the file's is checked
**before the first transaction opens**, and refuses the page WHOLE. Applying
the rows in front of the drifted one and then stopping leaves the seat at a
cursor its file no longer matches — exactly the state re-bootstrap exists to
avoid. `SeatDriftError` carries `recovery: "rebootstrap"` rather than making
every caller infer it.

A metered seat (`deferOverThreshold`) skips a commit the gateway marked over
the byte threshold, records the FIRST such seq in `seat_state.deferred_from`
for wave 2's byte policy, and **still moves the cursor** — which is what keeps
the tail draining behind a span the seat declined to take.

### `seat_state`, and why the seat needs a table of its own

`packages/client/src/replica/seat/state.ts`. The snapshot already carries
`replica_meta` with the epoch and the position the file stands at, so this
restates none of it. What it holds is true of THIS seat and no other copy:
`applied_seq` / `applied_commit_seq`, `gateway_watermark` (the head as of the
last page — the seat-level watermark that replaces per-read `coverage`, R8),
`deferred_from`, and the additive `ddl_version`. Created after the snapshot
lands, so the gateway has no such table and cannot capture it back over itself.

### The bootstrap is a resumable download, and the room check comes first

`packages/client/src/replica/seat/bootstrap.ts`. Two seams — a
`SeatSnapshotTransport` and a `SeatBootstrapStaging` — because the resume logic
is the part that is actually subtle and it is tested once against a real
filesystem rather than three times against three mocks.

- **Resume is by byte range, pinned to the ETag.** The door's artifact is a
  pure function of its log position, so "the same file" is checkable. A staged
  prefix whose marker does not match is a DISCARD, never a resume: splicing two
  artifacts produces a database that gunzips and fails an integrity check hours
  later. A body that ends short of the declared size is refused rather than
  installed.
- **Room for both files, before the first byte.** A re-bootstrap holds the
  current file, the staged artifact and the expanded copy at once.
  `SEAT_SNAPSHOT_EXPANSION = 8` against a measured 7.1 (64.4 MB of SQLite to
  8.86 MB gzip-6 at year-3): the check has to be wrong in the safe direction.
  An absent `freeBytes` estimate is "the host will not say", never "no room" —
  refusing on it would make the seat unusable in every browser without
  `navigator.storage.estimate`.
- **FTS rebuilt after the copy.** The snapshot pipeline drops most of the
  schema out from under the shadow tables and then VACUUMs; the seat is the
  first process to write to the file. `rebuildSeatFtsIndexes` finds every fts5
  table from `sqlite_schema` — the seat has no entity registry — and re-derives
  it, so a broken index fails here instead of on the member's first search.

### The applier runs off the JS thread

`worker-core.ts` is the whole worker minus its host: `openDatabase`, `staging`
and `transport` are injected, so the browser (OPFS + sqlite-wasm, wave 2
commit 4) and the suites (`node:fs` + `node:sqlite`) run the SAME program. The
message boundary (`worker-protocol.ts`) is one message per PAGE, never per row
or per commit: per-row would spend more time in `postMessage` than in SQLite,
and per-commit would put the transaction boundary under the scheduler. Change
notices go the other way unsolicited — a seat also applies while nobody is
waiting on it.

`bootstrap` releases the handle BEFORE the install and reopens after: no host
lets a file be replaced under an open connection, and the one that tolerates it
keeps the deleted inode alive, so the seat would go on reading the file it just
replaced. There is a test for exactly that.

### The seat's driver is its own

`SeatSqliteDriver` binds `string | number | null | bigint | Uint8Array`. The
old store's union is the first three, which was right for a projection of
JSON-shaped rows; a seat holds `vault.db` whole, so BLOBs and integers past
2^53 are on its write path — `row-json.ts` exists for exactly those — and
widening the old union would push both types into every driver on three
platforms for a value none of them is handed today. `NodeSeatDriver` returns
plain objects because the other two do; a driver whose rows behave differently
from its siblings' is a difference every caller then has to know about.

### Same SQL, two files

`tests/quality/seat-replay-parity.test.ts` is the convergence gate, and it
lives in `tests/quality` because it is the one test that needs BOTH halves —
`@centraid/vault` to build and capture, `@centraid/client` to bootstrap and
apply — and neither package depends on the other, deliberately.

- **The 0e ontology fixture**: the sanitised snapshot through the real
  bootstrap, every comparable table compared row for row, then THREE real
  commits on the gateway (an insert, an update of a row the snapshot already
  carries, a delete), the tail applied, and parity asserted again. Then the
  same page a second time: 0 applied, every row counted duplicate, parity
  unchanged. The comparable set is read from the SEAT's own schema — the seat's
  tables ARE the gateway's minus the private ones, so asking the file is asking
  the thing the invariant is about.
- **The year-3 vault**: the declared phone volume, table for table.

### Two reds this wave found, both fixed here

- **The year-3 fixture cache was serving a pre-#996 artifact.**
  `year3FixtureCacheKey` mixes in `VAULT_MIGRATIONS.length`, and #996's waves 0b
  and 1 rewrote the BASELINE without adding a rung — a pre-1.0 vault is created
  from the baseline, not laddered up to it — so the key did not move and a
  directory built on 5 September was handed to code that could no longer open
  it (`core.content_representation is an entity with a composite primary key`).
  `YEAR3_FIXTURE_VERSION` is 4, which is the lever the file already documents
  for exactly this, and the comment on `year3FixtureCacheKey` now says what the
  ladder length does not cover.
- **Year-3 notes were not searchable.** Once the cache rebuilt,
  `year3-vault.test.ts`'s note needle found nothing: the seeder writes
  `core_content_item` and the representation row directly, and wave 1 moved the
  FTS decode to a `core_content_text` row that only `setRepresentation` writes.
  The seeder now writes that row too, before the note and its representation —
  the representation's own FTS trigger reads it. `test-kit` cannot CALL
  `setRepresentation`; it deliberately does not depend on the vault.

### The measurement

Golden year-3 vault, `node:sqlite`, this machine:

| | |
| --- | --- |
| gateway `vault.db` | 112,377,856 bytes |
| sanitised snapshot | 64,356,352 bytes |
| snapshot build (`VACUUM INTO`, sanitise, `VACUUM`) | 2,829 ms |
| artifact on the wire (gzip-6) | 8,861,481 bytes — a ratio of 7.26 |
| bootstrap: stage, gunzip, install, FTS rebuild, `seat_state` | 606 ms |
| entities in the seat file | 89,339 |

The apply rate on wasm is measured in this wave's web commit, where a wasm
handle exists.

### Every file this commit touches

- `packages/core/src/protocol/seat-log.ts` (new) · `packages/core/src/protocol/index.ts` — the wire both ends compile against
- `packages/server/src/routes/seat-routes.ts` — the door's answers are typed by it; the three header names are constants now
- `packages/client/src/replica/seat/applier.ts` (new) — the four rules and the drift gate
- `packages/client/src/replica/seat/bootstrap.ts` (new) — resume by range, the room check, the FTS rebuild
- `packages/client/src/replica/seat/state.ts` (new) — `seat_state` and its DDL
- `packages/client/src/replica/seat/driver.ts` (new) — `SeatSqliteDriver`, `SeatBindValue`, `SEAT_OPEN_PRAGMAS`
- `packages/client/src/replica/seat/worker-core.ts` (new) — the worker minus its host
- `packages/client/src/replica/seat/worker-protocol.ts` (new) — one message per page, and change notices the other way
- `packages/client/src/replica/seat/http-snapshot-transport.ts` (new) — `If-Range`, the ETag pin, the three headers
- `packages/client/src/replica/seat/node-seat-driver.ts` (new) — the desktop seat's handle, and the suites'
- `packages/client/src/replica/seat/node-staging.ts` (new) — the part file, its ETag marker, and the rename
- `packages/client/src/replica/seat/wasm-seat-driver.ts` (new) — the browser seat's write path
- `packages/client/src/replica/seat/seat-drift-error.ts` (new) — the refusal that names re-bootstrap
- `packages/client/src/replica/seat/seat-snapshot-moved-error.ts` (new) — a resume that is not the same file
- `packages/client/src/replica/seat/seat-bootstrap-no-room-error.ts` (new) — the room check's refusal
- `packages/client/src/replica/seat/seat-worker-not-open-error.ts` (new) — one class per file, the repo's rule
- `packages/client/src/replica/seat/index.ts` (new) · `packages/client/package.json` — the `@centraid/client/replica/seat` subpath; host-specific entries deliberately not re-exported
- `packages/client/src/replica/seat/applier.test.ts` (new) · `packages/client/src/replica/seat/bootstrap.test.ts` (new) · `packages/client/src/replica/seat/worker-core.test.ts` (new)
- `tests/quality/seat-replay-parity.test.ts` (new) — the convergence gate over both corpora
- `packages/test-kit/src/year3-fixture-cache.ts` · `year3-distributions.ts` · `year3-vault.test.ts` — the two reds above

### Gates

```
cd packages/vault  && bun run test                      # 208 files, 1726 passed
cd packages/server && bun run test                      # 390 files; only the 3
                                                        #   environmental files red
bunx vitest run --config vitest.scale.config.ts \
  tests/scale/share-journey.scale.test.ts               # green, 3 consecutive runs
bash .governance/run.sh                                 # 22/22 directives
bun run check:push:static                               # stamped on the committed tree
grep -r composeShareShape packages apps                 # empty
```
cd packages/core     && bun run test   # 19 files, 302 passed
cd packages/client   && bun run test   # 276 files, 2503 passed
cd packages/test-kit && bun run test   # 5 files, 62 passed
cd packages/server   && bun run test   # 390 files, 3486 passed; 2 files red, environmental
bunx vitest run --config vitest.quality.config.ts tests/quality/seat-replay-parity.test.ts   # 2 passed
bun run governance                     # 22 directives
bun run check:push:static              # 4/4, stamped on the committed tree
```

The two red server files are the same environmental pair wave 1 named:
`src/acp/backends/acp/launch.test.ts` (sandbox/root detection) and
`src/serve/gateway-db-lock.integration.test.ts` (needs a real `sqlite3`).

### Decisions — wave 2, applier and bootstrap

- **The drift gate refuses the page, not the row.** The first version stopped
  at the drifted row and kept what it had applied. That is a cursor that names
  a file the seat no longer has; refusing whole is the only state the next
  attempt can reason about.
- **A separate driver interface rather than a wider one.** The two stores live
  side by side until wave 5. Widening `ReplicaBindValue` reaches four drivers
  across three platforms for types the old store is never handed.
- **`node:sqlite` will not read an integer past 2^53 as a number**, which is
  the loss `{i: "…"}` exists to prevent — so the applier's wide-integer test
  reads the column back as TEXT and compares digits. The seat's READ path will
  meet this again in wave 4; the write path is proven here.
- **The room check counts the file being replaced.** Counting only the new one
  passes on a phone that then runs out of space during the swap, which is the
  failure the check exists to prevent.

## Wave 2 — bytes, seat state, and the fixture that had to stop being a slice

The applier and the bootstrap gave a seat the vault's ROWS. This commit is
about everything else it holds: the files it keeps, the work it has queued, how
current it is, and what survives a repair.

### Bytes: the thumb is a row, and only the files are negotiable

`packages/client/src/replica/seat/byte-policy.ts` answers one question per
blob — hold, cache, or fetch when someone looks — under one of three policies
(desktop everything; phone what it captured plus an LRU with pins; PWA on
demand). It **refuses to answer about a thumb**: a ~2 KB inline thumb is a row
in a 1:1 side table (R7's WhatsApp pattern), it arrives with every other row,
and a caller asking the byte policy about one has confused a row with a file —
answering politely lets that confusion reach a screen that waits on a fetch
which never needed to happen.

Two things override the policy and neither is a preference. A **pin** is an
instruction, and a cache that evicts what someone asked it to keep is a
surprise, not a cache. A **capture a pending intent needs** (R25) is the
member's own queued work: the gateway runs an attachment-dependent intent only
once those bytes are uploaded and verified, so evicting them makes the work
unsendable from the one seat that has it. `seatByteEvictable` states the
inverse as its own function, because the fetch path and the eviction path have
different callers and must not each re-derive the rule.

### `seat_blob_presence`, and why a purge is a handshake

`packages/client/src/replica/seat/blob-presence.ts`. One row per blob this seat
holds, on the seat's own file, outside the replicated schema — the gateway has
no such table, so a commit can never carry it back over the seat's own answer.

- **A seat's claim is never the durability answer** (R7). "Backed up" means the
  gateway's CAS holds the sha, verified. This table answers only "do I have it,
  and have I said so"; conflating the two is how a member deletes the last copy
  of a photo because three devices said yes.
- **The row survives the purge, and survives the acknowledgement.** A tombstone
  marks it and returns the bytes for the caller to delete; the row stays,
  because "I have forgotten about this blob" and "I never had it" must not be
  the same answer — without the acknowledgement the gateway cannot tell "every
  seat has dropped it" from "one seat has been offline for a month", and those
  call for opposite answers when the member asks whether the thing is gone.
- **Re-recording a condemned blob does not clear its tombstone.** A re-download
  of bytes the gateway purged is a bug to see, not a state to overwrite.
- **A tombstone beats a pin**, and the eviction candidate list excludes pins,
  captures and condemned rows IN SQL rather than filtering afterwards: a list
  that briefly contains a protected sha is a list someone eventually acts on.

### The storage probe (OQ-2), and the step wave 1 deferred

`packages/client/src/replica/seat/storage-probe.ts`. OQ-2 was settled as "rows
minus FTS on Safari, full on Chromium, decided by a storage-estimate probe at
bootstrap **rather than by a hard-coded browser check**", and this is the
probe: quota minus usage against the expanded file plus headroom (20%, floored
at 32 MB — a percentage of a small vault is not room for a WAL and a
re-bootstrap). An **absent** estimate answers `full`: refusing to hold the index
because a browser declined to guess would make every such browser a worse seat
for no measured reason. And it **refuses** rather than inventing a third
contents when even the rows do not fit — remote-only is a decision for the
member and the shell.

`reduceSeatToRowsMinusFts` drops the shadow tables **and the sync triggers
together**. That pairing is the whole point: wave 1 declined to drop the FTS
tables in the snapshot pipeline precisely because the 57 retained triggers then
fail on the seat's first write with `no such table: main.fts_…` — "a separate
decision with a seat-side rebuild step attached". This is that step, and the
test asserts the file still takes a write afterwards.

`seat_state` gains `contents`, written after the drop and never before: a file
that says `rows-minus-fts` while the tables are still there sends every search
to the gateway for nothing, and one that says `full` after the drop sends every
search into a table that is not there.

### The carry-over: before the swap, or the member's work is gone

`packages/client/src/replica/seat/carry-over.ts` and
`packages/client/src/replica/seat/outbox.ts`.

A re-bootstrap replaces the file with a copy of the gateway's — correct for
every row in it, and catastrophic for the three things the gateway has never
heard of: the queued intents, the blobs this seat holds, and the pins. So
`SeatWorkerCore.bootstrap` reads the carry-over out of the OLD file while it is
still the file, installs, and writes it into the new one. "After" is a window
in which a crash loses a queue that cannot be re-fetched from anywhere, unlike
every row in the file.

`created_order` is carried **verbatim**. Intents drain in the order they were
made (R23); a repair that renumbers them re-orders the member's work. It is an
explicit monotonic column rather than a timestamp because two intents made in
the same millisecond on a phone are ordinary, and a device clock decides
neither canonical nor local order.

An absent table is an empty carry-over, never an error: a first bootstrap has
no old file, and throwing there turns "nothing to save" into a failed repair.

### The seat watermark replaces per-read `coverage`

`packages/client/src/replica/seat/watermark.ts`. Two numbers and a flag: the
applied cursor (what this file contains), the gateway's head as of the last
page (what exists), and whether a deferred span is owed — which is **behind in
a different way**, because waiting will not fix it and the member has to be
told so rather than shown a distance that never shrinks.

`custodyLine` (`packages/client/src/react/screens/vault-custody.ts`) takes that
line instead of the census record count. Not a re-sourcing: under R1 every
enrolled seat holds the whole vault, so "how many records" is the same number
everywhere and says nothing about THIS machine — and census dies in wave 5
anyway. `holdsReplica` and the offline-copy switch **stay** (F4, re-judged):
R9 keeps a remote-only client and a shared browser still needs the choice.

### The golden replica stops being a slice (F5)

`packages/test-kit/src/year3-replica.ts` built its artifact by walking
per-app shapes with `readReplicaRows` into a `replica_row` projection. Under R1
that is the wrong volume, and W2's parity work and W3's device exit both
measure against it — a fixture shaped like a slice would let a wave exit green
on the wrong thing. It is now `buildYear3SeatReplica`: the gateway's sanitised
snapshot, installed through the real `bootstrapSeatFile`, with a tail of REAL
commits applied through `applySeatLogPage`, and the outbox in the seat's own
table. `YEAR3_REPLICA_ENTITIES`, `buildYear3ReplicaSnapshot`, the shape ids and
the row ceiling are gone with the slice.

**The rule is now an assertion, not a comment.** `assertYear3SeatNotHandBuilt`
fails at BUILD time on a file with too few tables or a cursor behind the
snapshot — a hand-built fixture agrees with itself, and would otherwise pass a
parity test that was only ever comparing it to itself.

`tests/journeys.json`: `year3-household` ("5 mounted vaults = 10 SQLite
handles") is retired — it named a MOUNT PLANE, and a volume in this ledger
names how much VAULT a measurement is taken over. Its only entry goes with it;
`tests/scale/multi-vault-footprint.scale.test.ts` keeps its rig row and loses
nothing, because its ceilings were always `DEFAULT_VAULT_FOOTPRINT` asserted in
the rig body rather than read from the ledger. `year3-replica` is redefined as
the whole vault. And `1000-commits` — the volume wave 1's `gateway/log-apply`
row names — is declared, which it was not: `journey-ledger` was red on this
branch before this commit.

### Two more reds fixed rather than walked past

- `packages/blueprints/apps/_shared/representation-reads.ts` carried **two raw
  NUL bytes** (wave 0b), which makes git classify the file as binary and every
  diff in it unreviewable. `\0` in the template literal is the same value.
  `scripts:test` was red on this branch before this commit.
- The wave-1 file list in this receipt named several files only by basename
  after a `·`, which `receipt-per-issue` cannot match. Every file is a full
  path now.

### Every file this commit touches

- `packages/client/src/replica/seat/byte-policy.ts` (new) — the three policies and the two overrides
- `packages/client/src/replica/seat/blob-presence.ts` (new) — the seat's byte ledger, tombstones, acknowledgement, the LRU's candidates
- `packages/client/src/replica/seat/storage-probe.ts` (new) — OQ-2's probe and the rows-minus-FTS reduction
- `packages/client/src/replica/seat/outbox.ts` (new) — `seat_outbox`, where the outbox shares the seat's file
- `packages/client/src/replica/seat/carry-over.ts` (new) — what survives a re-bootstrap, read before the swap
- `packages/client/src/replica/seat/watermark.ts` (new) — the seat-level number that replaces per-read `coverage`
- `packages/client/src/replica/seat/state.ts` — `contents`, and `setSeatContents`
- `packages/client/src/replica/seat/worker-core.ts` — the carry-over in the bootstrap sequence
- `packages/client/src/replica/seat/index.ts` — the new surface, and the barrel suppression the module now needs
- `packages/client/src/replica/seat/bytes.test.ts` (new) — the policy, the purge handshake, the probe, the reduction
- `packages/client/src/replica/seat/carry-over.test.ts` (new) — a re-bootstrap with a pending intent in the outbox; the watermark's copy
- `packages/client/src/react/screens/vault-custody.ts` · `packages/client/src/react/screens/vault-custody.test.ts` — the watermark clause
- `packages/client/src/react/screens/HouseholdScreen.tsx` · `packages/client/src/react/screens/HouseholdScreen.test.tsx` · `packages/client/src/react/shell/routes/HouseholdRoute.tsx` · `packages/client/src/react/shell/routes/VaultRoute.tsx` — `records` becomes `seatWatermark`
- `packages/test-kit/src/year3-replica.ts` · `packages/test-kit/src/year3-replica.test.ts` — the seat file, and the rule as an assertion
- `tests/helpers/factories.ts` — the golden replica built through the seat path
- `tests/journeys.json` — `year3-household` retired, `year3-replica` redefined, `1000-commits` declared
- `packages/blueprints/apps/_shared/representation-reads.ts` — the two NUL bytes

### Gates

```
cd packages/client     && bun run test   # 278 files, 2521 passed
cd packages/test-kit   && bun run test   # 5 files, 61 passed
cd packages/blueprints && bun run test   # 213 files, 7083 passed, 2 expected fail
bunx vitest run --config vitest.quality.config.ts tests/quality/seat-replay-parity.test.ts
node scripts/lint-journey-ledger.mjs     # ok
bun run scripts:test                     # 675 tests, 675 pass
bun run governance
bun run check:push:static                # stamped on the committed tree
```

### Decisions — wave 2, bytes and seat state

- **The seat's driver, not `ReplicaBindValue`, and the seat's own tables, not
  the old store's.** Pre-1.0 means no compatibility shims between the two
  stores; the old one is deleted in wave 5 and gets nothing from this commit.
- **`seat_outbox` lands here rather than with the chain.** The carry-over test
  the brief asks for needs a pending intent in the outbox, so the table is part
  of "seat state". The chain that drives it is the next commit.
- **The custody screen takes a `SeatWatermark`, not a string.** The copy is one
  function (`seatWatermarkLine`) so the deferred-span wording cannot drift
  between the roster row and the drill-in.
- **A rig may have no ledger entry.** Retiring a volume retires its entries; the
  footprint rig's ceilings never came from the ledger, so the honest record is
  an empty `entries` with a `_noEntries` note saying why — not a re-labelled
  volume that would keep the row alive by renaming it.

## Wave 2 — the outbox chain

Five intents queued in airplane mode, four of which name a row the first has
not made yet. This commit is the seat's half of making that work: the gateway
already decides WHEN each may run (wave 1's `replicaDependencyVerdict`) and
WHICH row a placeholder means (`resolvePredecessorReferences`); what was
missing is everything only the seat can know — what it queued, and how far it
has applied.

### The edges are derived, never declared and never guessed

`packages/client/src/replica/offline-chain.ts`. An edge exists when an intent's
input NAMES a row id another unsettled intent's projection MINTED. Both facts
are already in the outbox: `namedRowIds` reads the first, the optimistic
mutations are the second. An app declares nothing (R23) and nothing is inferred
from the shape of a value (R20).

- **Only upserts mint.** A delete names a row that already exists canonically,
  so a later intent naming it is not waiting for this one to MAKE it; an edge
  there would serialise two unrelated writes behind each other.
- **A revision is not a dependent of what it retires.** The first version of
  this made an intent depend on the intent it had just superseded — a chain
  that can never drain. `supersededByInput` reads the supersession markers the
  replacement already carries, and `mintedRowIndex` excludes them along with
  the intent's own id. `intents.contract.test.ts` caught it.
- **Only a SYNTHETIC id becomes a reference.** When an app supplies the row id,
  the create writes that id and every later intent may name it directly;
  substituting there would replace a correct value with an indirection. When
  the projection invented the id for display, the gateway has never seen it and
  never will, so the wire carries `{"$intent": …, "table": …}`.
- **The base set drops what a predecessor has not produced.** A row the create
  has not made has no version to observe, and inventing one — 0, or the
  projection's optimistic guess — is how a chain conflicts with itself on its
  own first run. R23 forbids seat-side rebasing for a reason the seat cannot
  see: three outboxes each rebasing locally is three rebases the gateway cannot
  tell from an observed version.

### `dependsOn` was in the server's hash and not in the seat's

Wave 1 put `dependsOn` into `expectedPayloadHash` on the gateway. The client's
`intentPayloadHash` did not have it, so every chained intent this commit
derives would have been refused for a mismatched id. Fixed here, with the
comment on each side naming the other. `postReplicaIntent` sends the field.

### The overlay clears at the commit, in the transaction that carries it

`executed` is the gateway's fact, not this seat's: the answer can arrive before
the rows. So an executed outcome carrying `commitSeq` parks the intent at
`awaiting-change` — the state the outbox already had for exactly this — and
`IntentQueue.settleAtCommitSeq` settles it when the applied cursor reaches the
position.

Where the outbox shares the seat's file, "when" is stronger than that:
`seatOverlayClearingHook` is handed to `applySeatLogPage` as
`onCommitInTransaction` and runs after the commit's rows and before COMMIT, so
the pending row and the canonical rows it was drawn over become visible in the
same instant. That is why the applier grew an in-transaction hook at all. Every
asynchronous alternative has a window, and a crash inside it leaves an overlay
nothing will clear.

`commitSeq` supersedes `answeredVersions` for a seat that holds the whole file:
one number against one number, instead of a per-row question a seat under R1
no longer needs to ask row by row. The old path stays for the shaped route
until wave 5 deletes it.

### `SeatIntentStore` — the third outbox, and the reason there is one

`packages/client/src/replica/seat/seat-intent-store.ts` satisfies the same
`IntentRecordStore` the memory and IndexedDB stores do, over `seat_outbox`.
Not a third implementation of the same thing: it is the one that shares a
DATABASE with the rows the intents are about, which is what makes the
transaction above expressible at all. The record is stored as JSON beside its
indexed columns — the columns are what the queue orders, filters and clears on;
the intent's shape belongs to the shared core and must not be re-columnised
here every time it grows a field.

### A 409 about one intent is not a 409 about the copy

Every 409 on the replica plane used to mean re-bootstrap. Two do not:
`replica_intent_outcome_expired` and `replica_intent_payload_mismatch` are
facts about one queued write, and answering them by replacing the whole vault
would throw away a copy to resolve a question about one task — and lose the
outbox's own decision doing it. `ReplicaIntentRecoveryError` carries
`chainRecoveryFromExpiredOutcome`'s answer instead: **recover**, mint a new
intent against a freshly observed base. Never a silent retry — the retained
outcome is what made a retry idempotent, and once it is gone a re-send could
duplicate a payment.

### The contract, over all three outboxes

`packages/client/src/replica/offline-chain.contract.test.ts` runs the same
scenarios against the in-memory, IndexedDB and SQLite outboxes — one contract,
not three suites, because the difference that matters (a store that can share a
transaction with the replica versus one that cannot) is exactly the difference
that would otherwise hide a divergence. 43 cases, including every scenario the
issue names: ordering; held dependents and their badge copy; predecessor
references; another writer's unrelated note still draining while the chain is
held; a lost acknowledgement replaying the retained outcome; acknowledgement
before delta and delta before acknowledgement converging; a rejected creation
abandoning its dependents by name with nothing sent; an accepted deletion
reconciling to absence; a restart rebuilding one completed task with the final
values from the outbox alone; an intent admitted during re-bootstrap
preparation; and a snapshot that already holds an unacknowledged intent
settling rather than re-running it.

### Every file this commit touches

- `packages/client/src/replica/offline-chain.ts` (new) — the whole seat-side chain
- `packages/client/src/replica/offline-chain.contract.test.ts` (new) — the contract, three backends
- `packages/client/src/replica/seat/seat-intent-store.ts` (new) — the outbox in the seat's file, and the in-transaction clear
- `packages/client/src/replica/replica-intent-recovery-error.ts` (new) — the 409 that is not a re-bootstrap
- `packages/client/src/replica/intents.ts` — the chain derived at admission; the queue delegates settlement
- `packages/client/src/replica/intent-settlement.ts` (new) — `applyIntentOutcomes`, `settleIntentsAtCommitSeq`, `settleAnsweredIntents`, split out at the source cap
- `packages/client/src/replica/payload-hash.ts` — `dependsOn` in the hash, matching the gateway
- `packages/client/src/replica/types.ts` — `dependsOn` and `commitSeq` on the intent and the outcome
- `packages/client/src/replica/shell-transport.ts` — `dependsOn` on the wire, `commitSeq` validated, the recovery 409
- `packages/client/src/replica/seat/applier.ts` — `onCommitInTransaction`
- `packages/client/src/replica/seat/outbox.ts` — the full state vocabulary, and `record_json`
- `packages/client/src/replica/seat/carry-over.ts` · `packages/client/src/replica/seat/carry-over.test.ts` — the record carried verbatim; the in-transaction clear under test
- `packages/client/src/replica/seat/index.ts` · `packages/client/src/replica/index.ts` — the new surface

### Gates

```
cd packages/client && bun run test   # 279 files, 2566 passed
cd apps/mobile     && bun run test   # 286 files, 2438 passed
bun run governance
bun run check:push:static            # stamped on the committed tree
```

### Decisions — wave 2, the outbox chain

- **The chain is derived at ADMISSION, not at send.** It has to be: it is part
  of the payload hash, so an intent whose edges were computed later would be a
  different intent than the one that was saved.
- **`mintedRowIndex` reads `store.list()` on every enqueue.** A scan per
  admission, not per read. It is the honest implementation of "derived from the
  outbox"; if it ever shows up in a measurement, the fix is an index in the
  store, not a cached guess in the caller.
- **The seat's SQLite outbox rather than the phone's.**
  `apps/mobile`'s `SqliteIntentStore` is the OLD store's outbox and is wave 3/5
  work; `SeatIntentStore` is the one #996's transaction argument needs, and it
  lives in `packages/client` so the contract test needs no cross-package
  import.
- **`awaiting-change` was already the right state.** R24's "executed with the
  commit still arriving" is the state the outbox has had since #929; only what
  it waits ON changed.
- **`intents.ts` split at the cap rather than waived.** The additions took it to
  678 lines against a 625 limit, and `repo-hygiene` said so. Settlement is the
  reading of an ANSWER against the queue's rows, which is a different concern
  from the queue's own state machine — the same split `intent-chain.ts` made on
  the gateway side in wave 1, for the same reason. The queue delegates; no
  behaviour moved with the text.

## Wave 2 — the web seat, behind the flag

The seat store lands BESIDE the old one. Wave 5 takes the device half; until
then a browser must be able to run either, so there is exactly one place that
answers "which store is this seat" and it defaults OFF — a flag that defaults
on is a migration with a switch bolted to it.

### The flag, and what it actually switches

`packages/client/src/replica/seat/flag.ts`. One reading, three sources, in
order: an explicit argument, then `?seatStore=1`, then what the browser
remembered. A host that has already decided must beat a query string a member
could have been handed in a link, and both must beat a preference held over
from a session nobody remembers. A browser with site data blocked throws on
`getItem`; that is not a vote for the new store.

**What the flag switches on in this wave is the FILE and the number that
describes it — not where a screen gets its rows.** That boundary is
deliberate and it is the plan's own: the read path (apps' queries as plain SQL
over real tables, paged) is wave 4's whole wave, and the old store is not
deleted until wave 5. So with the flag on, a browser bootstraps the seat file,
tails the log door, keeps `seat_state` current, and the custody line shows the
seat watermark; every app read still goes through today's coordinator. Turning
the flag on therefore cannot regress a screen, which is what makes "every
existing web e2e green with it on" a claim worth checking rather than a
tautology — and it is checked below.

### The browser's half of the seams

- `packages/client/src/replica/seat/opfs-staging.ts` — two OPFS surfaces, and
  they are not the same one. The part file is ordinary OPFS written with
  `keepExistingData` and an explicit position (a writable opened without it
  TRUNCATES, which on a resumed download throws the whole prefix away
  silently). The database lives in the SAH pool, which is not a directory to
  write into — so "install" is `importDb`, the pool's own way of taking a whole
  database, and the swap needs no rename. Gunzip is the browser's own
  `DecompressionStream`, so the seat carries no inflate into the bundle.
  `currentBytes` returns **0 on purpose**: in a browser the file being replaced
  is already inside `estimate().usage`, and counting it again would refuse
  bootstraps that fit.
- `packages/client/src/replica/seat/seat-worker.ts` — sqlite-wasm over the SAH
  pool, an OPFS staging directory, the door over `fetch`. A SECOND worker
  rather than ops on the old one: the two stores hold different files, and a
  member behind the flag has both on disk during wave 2.
- `packages/client/src/replica/seat/seat-worker-client.ts` — the main thread's
  end. A worker that dies rejects every pending call, or a crashed bootstrap
  leaves the shell awaiting a promise nothing will settle. A drift refusal is
  revived AS a drift refusal across the boundary: the shell's response to it is
  re-bootstrap, and an anonymous `Error` with the same message is one the shell
  would merely show.
- `packages/client/src/replica/seat/web-seat.ts` — the loop, with all three
  exits explicit: `hasMore` false is a FACT the page carries, not an inference
  from an empty answer; a 409 and a `SeatDriftError` are the same conclusion
  reached from the two ends, and both re-bootstrap **once** — a seat that kept
  trying would spend a member's data allowance on a 9 MB artifact it cannot
  use.

### The shell reads the seat

`packages/client/src/react/shell/useSeatWatermark.ts`, wired into
`VaultRoute`. It fails quiet by design: no OPFS, a gateway too old for the
doors, a member offline — all answer `undefined` and the custody line simply
omits the clause. A seat's currency is not something to throw an error about
on a settings screen. With the flag off it opens nothing at all, which the
test asserts: "off" must not mean "downloads a file and discards it".

### The same program on the browser's SQLite

`packages/client/src/replica/seat/wasm-apply.test.ts` runs the applier over
`@sqlite.org/sqlite-wasm` 3.53.0 — a real second build, not a mock — and
compares insert, update, delete and a BLOB against `node:sqlite` 3.50 answer
for answer. The drift refusal is checked there too. Three builds have to agree
and two of them exist in this suite; the third (`SEAT_SQLITE_FLOOR`, 3.49) is
wave 3's.

### The measurement

| | |
| --- | --- |
| apply, 1 row per commit (wasm 3.53) | 13,076 rows/s |
| apply, 5 rows per commit | 29,368 rows/s |
| apply, one commit of 10,000 | 51,839 rows/s |
| the same three on `node:sqlite` 3.50 | 20,628 / 40,101 / 50,589 rows/s |

It reproduces wave 1's gateway finding from the other side: the rate is
**transaction-bound, not row-bound**. A 4x spread over identical rows, entirely
from the 10,000 durable boundaries R5 requires. At the producer bound (2,000
rows per commit) a seat is well inside the upper figure. The browser build is
~1.6x slower at the worst shape and level at the best, which is wasm call
overhead per statement rather than anything about SQLite.

Both numbers are in `tests/journeys.json` with provenance:
`desktop/first-bootstrap/year3/ci-linux-x64-4c` (the install, 606 ms, and the
112 MB → 64 MB → 8.9 MB chain) and `web/log-apply/1000-commits/ci-linux-x64-4c`
(a FLOOR, not a ceiling — this metric gets worse by going down).

### The web e2e, with the flag on — and what this container could not do

`VITE_CENTRAID_SEAT_STORE=1` is the build-time lever that turns the flag on for
a whole run, so the e2e lane exercises it without every spec carrying a query
string.

**`bun run --cwd apps/web e2e` cannot run as written in this container**, for
two reasons that are both about the container and neither about this wave:

1. The harness's own `webServer` is `node --experimental-strip-types
   tests/e2e/server.ts`, and on **node 22.22.2** that cannot resolve
   `./year3-distributions.js` to its `.ts` sibling — the import has been there
   since #927 and the repo pins **node 24.4.1**, where it resolves. `bun` reads
   it fine but has no `node:sqlite`. Worked around by starting the same server
   under a resolve hook and pointing Playwright at it.
2. Playwright's pinned browser (`chromium_headless_shell-1234`) is absent; the
   container has 1194. `CENTRAID_E2E_CHROMIUM` is the config's own documented
   local fallback and is what the run used.

With those two worked around, the **full chromium suite runs, and the flag
changes nothing**: 30 passed / 20 failed with the flag ON, 30 passed / 20
failed with it OFF, and the two failure sets are **identical file for file and
test for test** (`diff` over both lists is empty). The 20 are this container's:
every one of them waits on `Loading <app>…` and times out, in an environment
that cannot start the harness's own server. In CI the lane that covers this is
`web-e2e` in `.github/workflows/e2e.yml` (and `web-e2e-cross-browser` for the
WebKit/Firefox tier), on the pinned node and the pinned browser.

### Every file this commit touches

- `packages/client/src/replica/seat/flag.ts` (new) — one reading, three sources, off by default
- `packages/client/src/replica/seat/opfs-staging.ts` (new) — the part file, the SAH pool, `importDb`
- `packages/client/src/replica/seat/seat-worker.ts` (new) — the browser host of the worker core
- `packages/client/src/replica/seat/seat-worker-client.ts` (new) — the main thread's end
- `packages/client/src/replica/seat/web-seat.ts` (new) — bootstrap, tail, and the three exits
- `packages/client/src/replica/seat/seat-rebootstrap-required-error.ts` (new) — the log door's 409
- `packages/client/src/replica/seat/web-seat.test.ts` (new) — the flag, and the loop over a real core
- `packages/client/src/replica/seat/wasm-apply.test.ts` (new) — 3.50 against 3.53, and the rate
- `packages/client/src/replica/seat/index.ts` — the new surface
- `packages/client/src/react/shell/useSeatWatermark.ts` (new) · `packages/client/src/react/shell/useSeatWatermark.test.tsx` (new) — the shell's one read of the seat
- `packages/client/src/react/shell/routes/VaultRoute.tsx` — the watermark reaches the custody line
- `apps/web/src/main.ts` · `apps/web/src/client-globals.d.ts` — the build-time lever
- `knip.json` — the seat's entry points
- `tests/journeys.json` — the two rows this wave owns, measured with provenance

### Gates

```
cd packages/client && bun run test    # 285 files, 2601 passed
cd apps/web        && bun run test
node scripts/lint-journey-ledger.mjs  # ok
bun run governance
bun run check:push:static             # stamped on the committed tree
apps/web e2e (chromium, flag ON vs OFF)  # 30 passed / 20 failed, identical sets
```

### Decisions — wave 2, the web seat

- **The flag governs the file, not the reads.** Wave 2's own scope list carries
  no read-path work; W4 owns the handlers and W5 the deletion. Wiring app reads
  to a store with no read compiler would have meant writing W4 inside W2 and
  calling it a flag.
- **A build-time lever rather than a per-spec query string.** The flag's own
  sources already include `?seatStore=1`; what the e2e needed was ONE switch
  for a whole run, and a `VITE_` variable is that without adding a fourth
  source to the flag.
- **The e2e was actually run, not reasoned about.** The comparison that matters
  is not "it passed" — it could not, here — but "the failure set is identical
  with the flag on and off", which is a claim this container CAN establish and
  which is the one the exit criterion is really about.

## Wave 6 — the key plane (R13)

Locker v0 begins where its boundary does. Until this commit a Locker secret was plaintext the **gateway** could produce: ciphertext at rest under the vault DEK, opened by the gateway on a permit the gateway itself minted after checking a verifier it also held. That is a boundary the holder of the process walks through. The key plane replaces it: one random `K` per vault, minted at **founding** into the gateway's `keys/` directory, secrets stored as `lk1:<base64(nonce‖ct‖tag)>` under AES-256-GCM with AAD `<rowId>‖<keyId>`, and `key_id` on the row saying which key opens it. The gateway holds `K` so it can serve it to an enrolled seat and rotate it — never so it can decrypt on a caller's behalf.

Four decisions this commit makes, each because the alternative was worse:

- **`locker_key` is private and `key_id` carries no foreign key.** The first draft registered `locker.key` as an ontology entity so the reference would be a real FK. That was wrong twice: a registered entity is a `core_entity` supertype member, which would have mutated the FROZEN rung-one baseline text (`core_entity_kind`'s generated INSERT list) and left every existing file without the new kind row; and an FK from replicated `locker_item` into it would have broken the one property `private-tables.ts` exists to keep. Which key a host holds is host custody — the `credential` class — and a seat never asks the file which key is live. It holds `K` and its id from the key door, and "may I open this row" is `row.key_id === my key id`.
- **The nonce rides inside the value's envelope, the key id is a row column.** `locker_item` has five secret columns; one nonce column could serve one of them. The key id is per ROW because rotation rewrites a row's secrets together, and it is stored as a column **as well as** bound into the AAD — so a ciphertext cannot be replayed under a key it was not sealed with, which a bare blob column would have permitted.
- **Founding, not first need.** #298 spent a ruling on what the seal key's lazy mint cost: a window in which "is this the right key" had no answer. The plane has no such window — `liveLockerKeyId` is non-null for the life of the vault, and a missing file is unambiguously custody loss rather than possibly a fresh vault.
- **Retire before insert, inside one transaction.** `locker_key_live_idx` is a partial unique index over the PREDICATE `retired_at IS NULL`, not over the column — SQLite treats NULLs as distinct, so indexing the column would have permitted any number of live rows. It is checked per statement, which is what forced the order and is why "two live keys" is unrepresentable rather than merely unlikely. The test that found this is the stale-`key_id` one.

### Rotation, and the crash between two stores

`keys/` and `vault.db` cannot commit together, so the ORDER is the guarantee: write `K′`; one transaction (retire, insert, re-encrypt every secret, bump every `key_id`); delete the old file. `locker-key-plane.test.ts` interrupts the first window with a fault-injection seam and reopens the vault: the database is untouched, the live key still opens every secret, and the sweep removes the orphan `K′` no row named. The second window is reproduced by putting the retired file back: the database is the sole authority, and the sweep needs no memory of where the crash happened. Ciphertext is never under two keys in either.

### The kit carries the keys; the snapshot never does

`recoveryKitTarget.lockerKeys` is a **list**, not a key. A rotation writes `K′` to disk before the vault names it, so a kit written in that window carrying only the live id restores ciphertext that stops opening the moment the rotation completes — the placebo restore in its sharpest form. `recover()` refuses a target with no Locker key file, with the reason, **before** adopting. Membership of that list is part of `recoveryKitFingerprint`; order is not.

### Files

- `packages/vault/src/gateway/locker-key-plane.ts` — the plane: founding, the wire form and AAD, `assertLiveLockerKeyId`, rotation, the sweep, the kit's key set
- `packages/vault/src/gateway/locker-key-plane.test.ts` — 10 tests, including both crash windows
- `packages/vault/src/schema/domains-locker.ts` — `LOCKER_KEY_DDL` (rung six)
- `packages/vault/src/schema/migrate.ts` · `migrate.test.ts` — rung six; `user_version` 5 → 6
- `packages/vault/src/schema/private-tables.ts` · `local-tables.ts` — `locker_key` declared, twice, for its two different readers
- `packages/vault/src/db.ts` — `lockerKey()` / `lockerCustody()` on `VaultDb`: founded on first ask, swept beside it, and re-resolved after a rotation
- `packages/vault/src/bootstrap.ts` — founding, where the vault is founded
- `packages/vault/src/index.ts` — the plane's exports
- `packages/server/src/routes/vault-routes.ts` · `packages/server/src/serve/erase-recovery.ts` — erase destroys `K` with the DEK, on both the direct and the crash-resumed path
- `packages/server/src/routes/replica-shape-parity.test.ts` — `locker`'s shape id, re-taken for `key_id`
- `packages/server/src/engine/stores/gateway-db.test.ts` — the ledger band's rung count
- `packages/server/src/backup/backup.integration.test.ts` — an adopt carries the Locker key files with the DEK
- `packages/backup/src/engine.ts` — `lockerKeys` on `RecoveryKitTarget`
- `packages/backup/src/recovery-kit.ts` — the reader validates every entry, and membership of the set enters `recoveryKitFingerprint`
- `packages/backup/src/recovery-kit.test.ts` — the set round-trips, order is not a capability difference, a half-carried set is
- `packages/server/src/backup/backup-recovery-kit.ts` — the kit fills it from custody
- `packages/server/src/backup/recover.ts` — restore refuses without a key file
- `docs/recovery/backup-restore.md` — the key `K` section, rung six, and the two new invariant rows
- `scripts/docs-site/src/content/ontology-body.html` — `key_id` on the three Locker tables
## Wave 3 — the driver swap: expo-sqlite, SQLCipher, and a floor of 3.49.1

op-sqlite is gone. The phone's SQLite is now expo-sqlite built against
SQLCipher, which is the decision that sets `SEAT_SQLITE_FLOOR`: the same
tarball vendors 3.50.3 and 3.49.1, and `useSQLCipher: true` picks the older
one. So the phone is the oldest engine in the system on purpose, and every byte
the gateway ships has to clear a floor that a build flag chose.

### The plugin block, and what each flag buys

`apps/mobile/app.config.ts`. `useSQLCipher: true` is the key decision above;
`enableFTS: true` is not optional for a seat, because the sanitised snapshot's
only surviving triggers are its FTS sync triggers and the bootstrap rebuilds
the index before the member's first search. `withSQLiteVecExtension` is set
**under `android:` only**: 57.0.2 ships `android/vec/<abi>/vec.so` and no
`vec.xcframework` at all, so asking for it on iOS points
`bundledExtensions["sqlite-vec"]` at a bundle that is not in the tarball. It is
not auto-loaded on either platform, so `probeSqliteVec` stays the gate.

The `"op-sqlite"` blocks leave both `package.json`s with the dependency, and
`op-sqlite-build-config.test.ts` — a test whose whole subject was that those
two blocks existed — goes with them.

### The key is the first statement, because there is no key option

`SQLiteOpenOptions` has no `encryptionKey`, and `grep -i "pragma key"` over the
module's Swift and Kotlin is empty. So `ExpoSqliteDriver.open` issues
`PRAGMA key = '…'` before anything else — before the store core's own PRAGMA
block, which is a write, and a write on an unkeyed handle against an encrypted
file is `SQLITE_NOTADB`. The passphrase is a single-quoted literal with the
quote doubled, because `PRAGMA key` is parsed before the statement is prepared
and takes no bound parameter. The key itself is the locker's (wave 6); absent,
the handle opens a plaintext file, which is what every suite here has.

### WAL, now that the two handles are not what they were

`driver.journalMode` was typed `"DELETE"` and the phone was the one seat that
had to say so — a per-vault writer and a gateway-scoped multi-ATTACH reader
shared one file, and rollback-journal locking is what made the reader's SHARED
lock and the writer's RESERVED lock interact the way the 5 s busy timeout
assumed. That reader is deleted in this wave's next commit. What remains is the
foreground writer and the background task, and WAL is the mode in which those
two do not stall each other; the type is a union now rather than one word.

expo caches connections BY DATABASE NAME, which is a sharper edge than
op-sqlite's: a second `openDatabaseSync` with the same name hands back the
SAME object, and `close()` on either closes both. Every second handle asks for
`useNewConnection: true`.

### `executeBatch` has no equivalent, and what survives that

op-sqlite's `executeBatch` was one native round trip for a whole write batch,
in one transaction, off the JS thread (#922 E1). expo has no such call, so
`runBatchAsync` is N `runAsync` calls inside one `withTransactionAsync`. The
property #922 E1 actually bought — the JS thread is free while the statements
land, so a first-launch bootstrap page does not freeze the app — survives that.
The constant does not, and `bootstrap-statement-budget.test.ts` is what keeps N
honest.

### The one thing expo-sqlite cannot do, and the rewrite for it

`SQLiteBindValue` is `string | number | null | boolean | Uint8Array |
ArrayBuffer`. Blobs cross the bridge; **a `bigint` does not cross it at all**,
and a `number` arrives on the native side as a Double
(`SQLiteModule.kt:401-405`, `SQLiteModule.swift:629-647`) — so even the number
path could not carry an integer past 2^53, which is precisely the value
`row-json.ts`'s `{i: "…"}` encoding exists to preserve. The seat's bind union
has `bigint` in it because a seat holds `vault.db` whole.

So `ExpoSeatDriver` binds the wide integer as its DECIMAL DIGITS and wraps the
placeholder that takes it in `CAST(? AS INTEGER)`. The cast of a text integer
is exact across the whole 64-bit range and is twenty releases older than the
floor. It is confined to the ONE placeholder that needs it — wrapping every
placeholder would change the affinity of every other column — which means the
rewrite has to count placeholders correctly, and therefore has to know where a
`?` is not one: inside a string literal, a doubled-quote literal, a quoted or
bracketed identifier, a line comment or a block comment. All six appear in the
seat's DDL and its FTS rebuild. A numbered parameter (`?1`) is REFUSED rather
than guessed at; the seat emits none, and guessing is how the wrong column gets
the wide integer.

The READ side of that seam is not solved here: `getAllSync` still materialises
an INTEGER column as a Double. Wave 4 owns the seat's read path and meets it
there, exactly as wave 2's applier note predicted.

### The 3.49.1 seat check (R-A2), and which half runs where

`seat-sqlite-floor.test.ts` is the half that can run on node, and it asserts
the DIALECT: `SEAT_STATE_DDL`, `SEAT_OPEN_PRAGMAS`, `applyRowSql` for a
composite key and a single key, and the statements `rebuildSeatFtsIndexes`
emits, each against a denylist of constructs that landed after 3.49 —
`concat`/`concat_ws` (3.44), `octet_length` (3.43), `unhex` (3.41), the
`jsonb_*` family and two-argument `json_valid` (3.45), `RIGHT`/`FULL JOIN`
(3.39). Every one of those compiles on the gateway's 3.50.2 and the browser's
3.53.0, which is why reading the SQL on this machine proves nothing without the
list. It also asserts the two flags that CAUSE the floor, from `app.config.ts`
itself, so the floor constant and the build that produces it cannot drift apart
silently.

The other half — that the sanitised snapshot's DDL actually OPENS, that a JSON
page applies and that the FTS rebuild returns, on a SQLCipher build — cannot
run in any node process. **It runs in CI's `mobile-device-gate`**, which
compiles the Android tree under `assembleRelease` and RUNS the artifact under
Maestro. `mobile-smoke` deliberately cannot answer it: that job compiles,
bundles and ratchets, and never executes the app. It is named here because the
brief named it, and re-judged: a citation is not a justification.

**Version set (R-A2): 3.50.2 gateway / 3.49.1 phone / 3.53.0 wasm.**

### iOS pods are NOT regenerated here, and that is a stated gap

`apps/mobile/ios/Podfile.lock` still carries `op-sqlite (17.1.3)` at :394,
:2778, :2989 and :3220 and has no `ExpoSQLite` pod. Regenerating it needs macOS
and `pod install`; this container has neither (`which pod` is empty), and
hand-writing a pod's spec checksum would be fabricating the one field the lock
exists to hold. The lock is regenerated from the Podfile and autolinking, so
`pod install` on macOS both drops op-sqlite and adds ExpoSQLite in one pass —
but **an iOS build before that pass will not link**. `ci:native-state` does not
catch this: `validatePodLock` checks Expo, React-Core, React-Core-prebuilt,
ReactNativeDependencies and the Hermes tag, and nothing else.

### Every file this commit touches

- `apps/mobile/app.config.ts` — the expo-sqlite plugin block and its three flags
- `apps/mobile/package.json` · `package.json` · `bun.lock` — `@op-engineering/op-sqlite` and both `"op-sqlite"` build blocks out, `expo-sqlite@~57.0.2` in
- `apps/mobile/src/lib/replica/op-sqlite-driver.ts` (deleted) · `apps/mobile/src/lib/replica/op-sqlite-driver.test.ts` (deleted) · `apps/mobile/src/lib/replica/op-sqlite-build-config.test.ts` (deleted)
- `apps/mobile/src/lib/replica/expo-sqlite-driver.ts` (new) · `apps/mobile/src/lib/replica/expo-sqlite-driver.test.ts` (new) — the old store's driver, `PRAGMA key` first, WAL, `useNewConnection`
- `apps/mobile/src/lib/replica/expo-seat-driver.ts` (new) · `apps/mobile/src/lib/replica/expo-seat-driver.test.ts` (new) — wave 2's `SeatSqliteDriver` on expo-sqlite, and `bindWideIntegers`
- `apps/mobile/src/lib/replica/seat-sqlite-floor.test.ts` (new) — the node half of the 3.49.1 check
- `apps/mobile/src/lib/replica/replica-fts5-error.ts` · `apps/mobile/src/lib/replica/replica-sqlite-vec-error.ts` — the remedy they name is the plugin block now, not a package.json key
- `apps/mobile/src/lib/replica/background-sync.ts` · `apps/mobile/src/lib/replica/background-sync.test.ts` · `apps/mobile/src/kit/replica/ReplicaProvider.tsx` · `apps/mobile/src/kit/replica/ReplicaProvider.test.tsx` · `apps/mobile/src/kit/replica/replica-mount.ts` · `apps/mobile/src/kit/replica/replica-mount.test.ts` · `apps/mobile/src/lib/upload/native-queue.ts` — the driver's new name and path
- `docs/photos/derived-ledger.md` — the mobile vector-support section now describes the plugin flag and iOS's absent `vec.xcframework`, and no longer links a deleted test
- `apps/mobile/src/test/native-device-seams.ts` — the RNTL tier's engine seam is `expo-sqlite`'s `openDatabaseSync` now
- `apps/mobile/native-fingerprints.json` — refreshed with `--write` after L1–L3 green: ios `9c407bb9…` → `959e6210…`, android `26aef20c…` → `05e919ba…`
- `packages/client/src/replica/store-core.ts` — `journalMode` widened to `"DELETE" | "WAL"`, and the comments that named op-sqlite
- `packages/client/src/replica/native.ts` — the seat store minus its hosts, so the phone composes it without dragging `Worker`, `navigator.storage` or the DOM into a React Native typecheck

### Gates

```
bunx vitest run packages/vault/src     # 208 files, 1685 passed, 2 skipped
bunx vitest run packages/backup/src    # 229 files, 2025 passed, 28 skipped (with vault)
bunx vitest run packages/server/src    # 381 files passed; 7 failed, all environmental
bun run check:push:static              # stamped on the committed tree
```

The seven: `IS_SANDBOX=yes` in this container where `acp/launch.test.ts` expects `1` (2); no `sqlite3` binary for `gateway-db-lock.integration.test.ts` (1); and a host disk at 98% (822 MB free), which `VaultBlobBackpressureError` and `ENOSPC` report in `recover.integration.test.ts`, `vault-plane-maintenance.test.ts` and `vault-registry-footprint.test.ts` (4). None touches the key plane; all seven fail the same way on the tree this commit was cut from.

### A decision the tests made, not the design

`K` is named for the vault's own id (`core_vault.vault_id`), never for `path.basename(vaultDir)`. The first draft used the directory name — the spelling `sealKeyFileFor` uses — and three suites said why that is wrong: `vault-registry.test.ts` copies a vault directory under a new name and expects the DUPLICATE-ID error, `backup.integration.test.ts` adopts a restored directory, and `seal-custody.test.ts` renames one. The DEK survives all three only because a vault that has never sealed may mint a fresh key; `K` has no such escape, so the name has to follow the vault. That in turn is why founding happens in `bootstrapVault` rather than at the top of `openVaultDb`: the id is not in the file until the vault exists.

## Wave 6 — enrollment hands `K`; the door serves it

Wave 1 declared `/_vault/seat/locker-key` and had it authenticate and then refuse, so a seat could tell "this gateway has no key plane" from "this gateway is older than the door". It serves now, and the shape of what it serves is the ruling.

**The principal is the device row.** `resolveReplicaAccess` — the same resolution the snapshot and log doors use — has already refused an unenrolled or revoked device by the time the handler runs, and that is the whole authorization question here: an enrolment covers the vault, and `K` opens the vault's Locker. There is no narrower principal to consult and no per-row question to ask.

**The pairing ticket does not carry `K`, and this is why.** The ticket is a base64url payload a camera reads off a screen. It is seen by whatever is pointed at that screen, it survives the glance in a photo roll, and it is validated **before any device exists to be the principal** — there is nothing yet to name, nothing to check a revocation tombstone against, nothing to refuse. A vault key handed out that way is handed to the room, and revoking the device afterwards reaches none of the copies. Fetching it afterwards costs one authenticated request and buys a principal the gateway can name. `seat-routes.test.ts` pins both halves: a revoked device is refused, and the ticket codec's payload is asserted key-shaped by its exact field set, so adding `K` to it would fail a test rather than pass a review.

**`Cache-Control: no-store`.** A proxy or a service worker holding `K` is a second copy of the key in a place nothing revokes.

**The seat's half keeps nothing.** `fetchLockerVaultKey` returns bytes and holds no module-level cache — a cache there would be a fourth copy of the key that no lock covers, and a test asserts two asks are two requests. It refuses an algorithm it does not implement rather than guessing, because decrypting under the wrong construction is silent where refusing is loud, and it refuses a key that is not 32 bytes. What the caller does with the bytes is the unlock boundary, and that is the next commit's subject, not this module's.

**The foreign-device receipt stamp.** A reveal receipt is a device intent the gateway stamps, and with the seat decrypting locally the receipt is the only record of who looked. So `replica-intent-route.ts` takes the device from `context.access.deviceId` and a body-supplied `deviceId` reaches nothing: the outcome row is the session's principal's, and the forged name resolves to no outcome at all. If the payload could name the device, "which seat revealed this secret" would be a claim rather than evidence — forgeable by the one party the trail exists to hold to account.

### Files

- `packages/core/src/protocol/seat-log.ts` · `packages/core/src/protocol/index.ts` — `SeatLockerKeyWire`; `keyId` is as load-bearing as `key`
- `packages/core/src/protocol/routes.ts` — the door's comment, now that it serves
- `packages/server/src/routes/seat-routes.ts` — the key door
- `packages/server/src/routes/seat-routes.test.ts` — served to the enrolled row, refused to the revoked one, and the ticket's field set
- `packages/client/src/locker/locker-key-door.ts` — the seat's half: fetch, refuse, keep nothing
- `packages/client/src/locker/locker-key-door.test.ts` — the refusals, and that two asks are two requests
- `packages/client/src/index.ts` — its export
- `packages/server/src/routes/replica-intent-attribution.test.ts` — the foreign-device stamp
bunx vitest run --root apps/mobile src/lib/replica src/kit/replica src/lib/upload
                                       # 56 files, 449 passed
bun run --cwd apps/mobile test         # 287 files, 2448 tests; 1 red
                                       #   (DocsHome.test.tsx, red on the base
                                       #    tree too — verified by stash)
bun run --cwd apps/mobile typecheck    # clean
bun run --cwd packages/client typecheck # clean
bun run check:mobile-native-state      # green after the --write refresh
bun run check:mobile-suite-budgets     # ok, 11 suites, tighten-only
bun run check:push:static              # 4/4, stamped on the committed tree
```

### Decisions — wave 3, the driver swap

- **`CAST(? AS INTEGER)` over binding the digits alone.** Column affinity would
  convert a text integer into an INTEGER column for free — but only where the
  column HAS integer affinity, and the seat writes BLOB- and ANY-affinity
  columns too, where the same bind would silently store text. The cast says
  what is meant at the one placeholder that means it.
- **The placeholder scan knows about literals and comments.** A simpler
  `split("?")` would wrap the wrong placeholder in exactly the statements that
  carry a `?` in a literal, and the failure mode is a wrong VALUE rather than
  an error. Six token kinds, one function, seven tests.
- **`withSQLiteVecExtension` under `android:` and not at the top level.** The
  top-level form is not "both platforms"; on iOS in 57.0.2 it is "look for a
  bundle that does not exist".
- **The iOS lock is left stale rather than hand-edited.** A lock with an
  invented checksum is worse than one that is honestly out of date, and
  `pod install` rewrites the whole file anyway. The gap is stated above rather
  than papered over.

## Wave 3 — the mount plane goes, and the outbox is the surface

A seat opens ONE file (R12). Everything below follows from that sentence, and
most of it is deletion: 5,583 lines of a plane that existed to answer a
question one open file cannot ask.

### What the reader actually was, and why commit 4 folded into this one

`MultiVaultReplicaReader` and `MultiVaultReplicaSession` were not only the read
plane. They also owned the **pending overlay** (`PendingChangeStatus`,
`pendingChanges`, `dismissPendingChange`), `share`, `pullScopes` / `status()` /
`revokeScope`, and the whole cross-vault **placement** outbox. Deleting the read
plane therefore deletes the machinery the sync-and-conflict surface stands on —
which was scheduled for this wave's LAST commit. Landing a stopgap outbox here
and replacing it two commits later would have meant writing that surface twice,
so the coordinator folded it: this commit publishes `NativeReplicaSession`
directly and reads the pending surface off wave 2's shared chain
(`offline-chain.ts` + `seat-intent-store.ts`).

### One open file, and the switcher over the rest

`ReplicaProvider.tsx` keys the mount on the `(gateway, vault)` PAIR. Switching
vaults IS the remount: the key moves, `built` no longer matches, and consumers
read `ready: false` before any read can land on a closing session — the
retraction the old code did by hand with a nonce and a one-attempt anti-spin
guard. `vaultScopes` (was `mountedScopes`) returns every vault the gateway
granted, UNSLICED, because what a member may switch to is bounded by the grant
and not by how many databases a reader could attach.

Revocation gets simpler in the same move: a vault this seat is not holding open
has no handle, so reclaiming it is a file deletion and nothing else.

### The row still says which vault, because eighteen screens ask

`lib/replica/vault-source.ts` keeps three of the six provenance columns —
`__centraidScopeId`, `__centraidScopeLabel`, `__centraidCanWrite` — and drops
the three ARRAY badges with the question they answered. `NativeReplicaSession`
stamps them on every row it returns, so `row-provenance.ts` and its eighteen
callers are unchanged. Moving "may I write here" to a context flag would have
made every one of those screens reach for a hook to answer a question about
data it already holds. The rowId is no longer prefixed with the vault: two
files could hand back the same row id, one cannot, and a prefixed id is one the
write path then has to strip back off.

### The pending surface, over one outbox

- `PendingChangeStatus` is `IntentState` and nothing more. It used to be that
  union PLUS the placement outbox's own `in-flight`, because the phone had two
  outboxes.
- `PendingChangeActions` lost `vaultId` and `kind` from all four verbs: the
  intent id alone addresses the row.
- `pendingChanges()` carries `heldBadge` — `chainHolds` + `chainBadgeCopy` from
  wave 2, computed ON THE SEAT because the badge has to be right in airplane
  mode, where the gateway's verdict does not exist and will not for hours. A
  held dependent draws "Waiting on an earlier change" instead of "waiting to
  send": nothing is wrong with it, and it releases when the change in front of
  it lands.
- `retained` replaces the `attempts !== undefined` tell for which rows may be
  retried or discarded; an attention remnant keeps only Dismiss.
- `pendingProjection()` exposes `reconstructPendingProjection` for the restart
  case commit 4's journey exercises.

### Placements go; a share is an HTTP call

`crossVaultPlacements` is deleted, so the placement plane goes with it: the
placement half of `placement-transport.ts`, the lightbox's Copy/Move-to-another-
vault sheet, `placementLine`'s six sentences and their test. What survives is
`commons-transport.ts` — three gateway calls with no outbox behind them — and
`ShareSheet` calls `postCommons` directly. A share is a predicate the gateway
compiles (wave 7), not something this phone queues, and it was never a session
verb for any reason other than the facade being where the code sat.

The lightbox's "Copy" is now only "keep this shared photo in my vault"; an item
with no commons offer has nothing to copy INTO, and says so.

### The wall gates on the doors it needs

`supportsMobileOfflineGateway` reads `seatReplica` instead of two words
describing a deleted mechanism (F1). The key is OPTIONAL on the wire, which is
exactly right: absence is what a gateway older than the doors says, and it
reads as off — the update wall, not a phone that mounts and then finds no file
to fetch.

### The protocol bump, and the one number that survives the cap

`GATEWAY_PROTOCOL_VERSION` / `GATEWAY_MIN_PROTOCOL_VERSION` → 4. Dropping two
REQUIRED keys from a structural capability map is a wire change either end
would otherwise read as malformed; the honest answer to a peer on the other
side is the update wall, not a shim that pretends a deleted mechanism is there.

`MAX_MULTIPLEX_REPLICA_SCOPES` → `MAX_REPLICA_FEED_MOUNTS`. It was one
agreement covering two budgets — the mounts a radio carries and the files the
phone attaches into one reader — and only the first still exists. It is kept
rather than dropped because an unbounded mount list is a subscription the
CALLER sizes and the gateway pays for.

### The tests that were about the plane, and what replaced them

`VaultReadPlane` (`lib/replica/vault-read-plane.ts`) is the seam the deleted
reader was for the lanes that hold a store and no session — the airplane-mode
journeys and the read-parity oracles. It adds two things to
`ReplicaSqliteStore`: the appId → shapeId resolution and the vault stamp.

- `home-tile-reads.test.ts` pinned "one composed statement whose UNION ALL arms
  are the attached vaults". One arm now, so what it pins is the claim that
  always mattered: the tile does not pay for the entity to draw its newest N.
  The fixture seeds 700 days into one file rather than 500 into each of four,
  because a page that ends where the window ends would otherwise pass for a
  page that filled it. The recording driver moved from `allAsync` to `all`: the
  seat's store is synchronous by construction.
- `mobile-screen-reads.scale.test.ts` seeds 10,000 rows in one file for the
  same reason — the window is 5,000, and two vaults of 5,000 used to be what
  made a filled page provable.
- `PendingRestartJourney.test.tsx` mounts what the provider now mounts, which
  is the session and nothing over it.
- `VaultsSwitcher.test.tsx`'s cap disclosure is gone with the cap.
- `pending-write-visibility.test.ts` needed a longer `waitFor`: the mounted
  reader projected a catalog-less intent AT READ TIME, so its row appeared the
  instant the catalog did. The seat draws its stored projection instead, which
  `backfillDeferredProjections` writes once page one lands — a durable
  transition on the outbox the drain is also working, so it can lose a race and
  be retried. The claim is that it arrives, not that it arrives first.
### The flags were inert on Android, and nothing here runs `expo prebuild`

`app.config.ts`'s plugin block is what a prebuild would READ; the committed
`android/` and `ios/` projects are what gets compiled, and no lane in this repo
regenerates them. `apps/mobile/android/gradle.properties` carried no
`expo.sqlite.*` key at all — so `useSQLCipher`, `enableFTS` and
`withSQLiteVecExtension` did nothing, and Android would have shipped the
vendored 3.50.3 with no SQLCipher and no fts5. The phone would have quietly
stopped being the 3.49.1 seat the whole floor is cut to fit, and commit 1's
`seat-sqlite-floor.test.ts` would still have passed, because it reads the
plugin block.

The three keys are in `gradle.properties` now, spelled exactly as
`withSQLite.js`'s `updateAndroidBuildPropertyIfNeeded` spells them, and
`seat-native-build-config.test.ts` holds them equal to the plugin block so they
cannot go inert again. It covers ANDROID only: `ios/Podfile.properties.json` is
the same three keys on the other side and belongs to the macOS CI slice, which
is the lane that can run `pod install` and prove the link — asserting a file
another branch is writing would fail on this one. **The iOS half is not covered
by any test on this branch.** The Android emulator gate's `assembleRelease` is
what proves SQLCipher actually links.

### One red this branch was carrying

`DocsHome.test.tsx`'s Shared-shelf fixture still wrote `shape_id` on the
`share.subscription` and `share.subscription_lineage` rows. Wave 7 re-keyed
both tables to `authority_id` (R10 — `share_subscription`'s primary key is
`(authority_id, audience_vault_id)` now), and `docs-projection-shares.ts:90`
reads `authority_id`, so every arrival read as unowned and the shelf drew
nothing. Commit 1's report called this pre-existing on the base tree; it is —
the base tree is this branch, and the merge of wave 7 is where it came in. The
fixture is fixed; the assertion is untouched.

### Every file this commit touches

The full list, one path per line, grouped by what happened to it.

**Deleted — the mount plane, the placement plane, and the tests that were about them:**

- `apps/mobile/src/apps/photos/placement-status-copy.test.ts`
- `apps/mobile/src/lib/replica/mounted-read-plan.pushdown.test.ts`
- `apps/mobile/src/lib/replica/mounted-read-plan.test.ts`
- `apps/mobile/src/lib/replica/mounted-read-scoping.ts`
- `apps/mobile/src/lib/replica/multi-vault-provenance.ts`
- `apps/mobile/src/lib/replica/multi-vault-read-parity.test.ts`
- `apps/mobile/src/lib/replica/multi-vault-reader.test.ts`
- `apps/mobile/src/lib/replica/multi-vault-reader.ts`
- `apps/mobile/src/lib/replica/multi-vault-session.test.ts`
- `apps/mobile/src/lib/replica/multi-vault-session.ts`
- `apps/mobile/src/lib/replica/placement-transport.test.ts`
- `apps/mobile/src/lib/replica/placement-transport.ts`
- `apps/mobile/src/lib/replica/reader-statement-budget.test.ts`
- `tests/quality/replica-scope-cap-parity.test.ts`

**New:**

- `apps/mobile/src/lib/replica/commons-transport.ts`
- `apps/mobile/src/lib/replica/seat-native-build-config.test.ts`
- `apps/mobile/src/lib/replica/vault-read-plane.ts`
- `apps/mobile/src/lib/replica/vault-source.ts`

**Changed:**

- `apps/desktop/tests/e2e/fixtures.ts`
- `apps/mobile/android/gradle.properties`
- `apps/mobile/native-fingerprints.json`
- `apps/mobile/src/apps/docs/DocsHome.test.tsx`
- `apps/mobile/src/apps/docs/docs-copy.ts`
- `apps/mobile/src/apps/docs/docs-projection.test.ts`
- `apps/mobile/src/apps/locker/locker-airplane.test.ts`
- `apps/mobile/src/apps/notes/NotesHome.tsx`
- `apps/mobile/src/apps/people/people-model.test.ts`
- `apps/mobile/src/apps/photos/AlbumDetail.tsx`
- `apps/mobile/src/apps/photos/PhotoLightbox.tsx`
- `apps/mobile/src/apps/photos/PhotoLightboxToolbar.tsx`
- `apps/mobile/src/apps/photos/photos-pending.test.ts`
- `apps/mobile/src/apps/photos/photos-vaults.ts`
- `apps/mobile/src/apps/tally/PendingRestartJourney.test.tsx`
- `apps/mobile/src/apps/tally/TallyHome.tsx`
- `apps/mobile/src/apps/tally/tally-airplane.test.ts`
- `apps/mobile/src/apps/tasks/TasksHome.test.tsx`
- `apps/mobile/src/apps/tasks/useTasks.ts`
- `apps/mobile/src/kit/replica/PendingChangesSheet.tsx`
- `apps/mobile/src/kit/replica/ReplicaProvider.test.tsx`
- `apps/mobile/src/kit/replica/ReplicaProvider.tsx`
- `apps/mobile/src/kit/replica/ReplicaStatusBar.test.tsx`
- `apps/mobile/src/kit/replica/pending-changes.ts`
- `apps/mobile/src/kit/replica/pending-copy.ts`
- `apps/mobile/src/kit/replica/replica-context.ts`
- `apps/mobile/src/kit/replica/replica-mount.test.ts`
- `apps/mobile/src/kit/replica/replica-mount.ts`
- `apps/mobile/src/kit/replica/row-provenance.test.ts`
- `apps/mobile/src/kit/replica/row-provenance.ts`
- `apps/mobile/src/kit/share/ShareSheet.test.tsx`
- `apps/mobile/src/kit/share/ShareSheet.tsx`
- `apps/mobile/src/lib/replica/background-scopes.ts`
- `apps/mobile/src/lib/replica/background-sync.test.ts`
- `apps/mobile/src/lib/replica/background-sync.ts`
- `apps/mobile/src/lib/replica/inline-query-ctx.native.test.ts`
- `apps/mobile/src/lib/replica/inline-query-ctx.native.ts`
- `apps/mobile/src/lib/replica/mobile-gateway-compatibility-core.ts`
- `apps/mobile/src/lib/replica/mobile-gateway-compatibility.integration.test.ts`
- `apps/mobile/src/lib/replica/mobile-gateway-compatibility.test.ts`
- `apps/mobile/src/lib/replica/mobile-gateway-skew.test.ts`
- `apps/mobile/src/lib/replica/native-session.ts`
- `apps/mobile/src/lib/replica/offline-budgets.ts`
- `apps/mobile/src/lib/replica/pending-write-visibility.test.ts`
- `apps/mobile/src/lib/upload/followup.test.ts`
- `apps/mobile/src/lib/upload/followup.ts`
- `apps/mobile/src/screens/home/VaultsSwitcher.test.tsx`
- `apps/mobile/src/screens/home/VaultsSwitcher.tsx`
- `apps/mobile/src/screens/home/home-tile-reads.test.ts`
- `docs/mobile-offline.md`
- `docs/protocol.md`
- `packages/cli/src/cli.contract.test.ts`
- `packages/client/src/gateway-client-contract-fixtures.ts`
- `packages/client/src/react/shell/routes/AutomationViewRoute.test.tsx`
- `packages/client/src/replica/native.ts`
- `packages/core/src/protocol/capabilities.test.ts`
- `packages/core/src/protocol/capabilities.ts`
- `packages/core/src/protocol/handshake.test.ts`
- `packages/core/src/protocol/index.ts`
- `packages/core/src/protocol/routes.ts`
- `packages/core/src/protocol/version.ts`
- `packages/server/src/routes/multiplex-replica-routes.ts`
- `packages/server/src/serve/build-gateway.ts`
- `receipts/issue-996-one-vault-every-seat.md`
- `scripts/fuzz/corpus/protocol-handshake/accepted.json`
- `scripts/fuzz/corpus/protocol-handshake/minimal.json`
- `scripts/fuzz/corpus/protocol-handshake/skewed.json`
- `tests/integration-mobile/locker-rows-parity.integration.test.ts`
- `tests/integration-mobile/tally-balance-parity.integration.test.ts`
- `tests/scale/mobile-screen-reads.scale.test.ts`

### Decisions — wave 3, the mount plane

- **Commit 4's outbox surface folded into commit 2, and the reason is the
  find.** The reader OWNED the pending overlay, so the plane could not be
  deleted without taking the sync-and-conflict surface with it. The choice was
  a stopgap that gets thrown away or one commit; the coordinator ruled one.
- **The row keeps its source stamp.** The alternative — `canWrite` as a context
  flag — is fewer moving parts in the abstract and eighteen screens reaching
  for a hook in practice.
- **`MAX_REPLICA_FEED_MOUNTS` is a rename, not a survival of the cap.** The cap
  bounded ATTACHed databases; this bounds one SSE subscription's mounts.
  Deleting it outright would have left the route sized by its caller.
- **A share routes through the ordinary HTTP call, not the session.** Wave 7
  made a share a predicate; it was a session verb only because the facade was
  where the code happened to sit.
## CI — iOS lock job

Wave 3 left `apps/mobile/ios/Podfile.lock` naming `op-sqlite` and carrying no
`ExpoSQLite`, and stated the gap rather than papering over it. Two things close
it here, and neither is a hand-edit of the lock.

**`.github/workflows/mobile-ios-lock.yml`** — `workflow_dispatch` only, one
`macos-26` job (the label `mobile-ios-smoke` already pins), `permissions:
contents: write`, concurrency per branch with `cancel-in-progress: false`. It
resolves `inputs.branch || github.ref_name` (a dispatch input default must be a
literal), checks that branch out at depth 1 with the default `GITHUB_TOKEN`,
runs `./.github/actions/setup` for Bun/Node 24.4.1/`bun install
--frozen-lockfile`, selects Xcode ≥ 26.4 and asserts the floor with
`ci:xcode` — both copied from candidate.yml — asserts CocoaPods is on the image
(no lane in this repo installs a gem), then `pod install --repo-update` in
`apps/mobile/ios`. `apps/mobile/ios` is committed, so there is no `expo
prebuild` step: prebuilding would regenerate a project this repo maintains by
hand. It then runs `ci:native-state --write`, commits `Podfile.lock` **and**
`native-fingerprints.json` by explicit path, and pushes to the resolved branch.
The ratchet travels with the lock because `pod install` moves the
@expo/fingerprint inputs — pushing the lock alone would trade a red L1 for a red
L4 — and `--write` is fail-closed on L1–L3, so the refresh can only land on a
lock the recipe checks already accept. The lock and the ratchet are uploaded as
`mobile-ios-podfile-lock` on every outcome, so a run that cannot push still
hands back the file.

**The validator gap.** `validatePodLock` compares five versions (Expo,
React-Core, React-Core-prebuilt, ReactNativeDependencies, the Hermes tag) and
neither half of this drift is a version, which is why the gate was green on a
lock that cannot link. `validateLockedNodeModulePods`
(`apps/mobile/scripts/verify-native-state-lib.mjs:193`) is the mechanical form
of both halves, read from the lock's own EXTERNAL SOURCES `:path:` entries: a
pod sourced from `node_modules/<pkg>` that `bun.lock` no longer resolves is red
(the op-sqlite half), and a dependency of `apps/mobile` whose installed package
declares `"apple"` or `"ios"` in `expo-module.config.json` but appears nowhere
in the pod lock is red (the ExpoSQLite half).
`discoverNodeModulePodPackages` (`apps/mobile/scripts/verify-native-state.mjs:158`)
supplies both sides.

Two things it does NOT do, and both were found by running it. It does not ask
`node_modules/` whether a package is present: `bun install --frozen-lockfile`
leaves `node_modules/@op-engineering/op-sqlite` behind as an unpruned leftover,
so a presence check over the directory tree is green on exactly the tree this
exists to red — `bun.lock` is the oracle instead. And it matches `"apple"` as
well as `"ios"` in the module config, because expo-sqlite 57.0.2 declares
`platforms: ["apple", "android", "devtools"]` and an `"ios"`-only match sees
nothing. It reads presence from the lockfile rather than package.json because
the pod lock legitimately sources transitive Expo packages nobody declares — 59
locked node_modules packages against 53 declared dependencies. Both errors carry
the existing `MACOS_POD_INSTALL` remediation, which now names a lane that can
act on it.

**This branch is red until the lane runs.** On the tree as committed,
`ci:native-state` L1 reports exactly two errors — op-sqlite locked and
unresolved, expo-sqlite autolinked and unlocked — so `check:mobile-native-state`
fails until `mobile-ios-lock` is dispatched on the branch and its commit lands.
That is the gap becoming a gate, and it is deliberate: the alternative is a
green gate over a lock no iOS build can link.

```
bunx vitest run --root apps/mobile scripts/verify-native-state.test.mjs
                                       # 1 file, 19 tests, green
bun run lint:workflow-pins             # 24 workflows clean
bun run lint:ci-egress                 # ok
bun run lint:path-filters              # ok
bun run format:check                   # clean
bun run --cwd apps/mobile typecheck    # clean
node apps/mobile/scripts/verify-native-state.mjs --status
                                       # L1 red x2 (the gate above), L2-L4 ok
bun run check:push:static              # stamped on the committed tree
```

### iOS sqlite-vec is built, not punted

The owner extended this slice: iOS gets sqlite-vec too. The facts, verified in
the installed tree — expo-sqlite 57.0.2 ships `android/vec/<abi>/vec.so` for
four ABIs and no `vec.xcframework`; `ios/ExpoSQLite.podspec:85-86` vendors
`vec.xcframework` and `:61-62` compiles Swift with `-DWITH_SQLITE_VEC`, both
gated on `expo.sqlite.withSQLiteVecExtension`; `ios/SQLiteModule.swift:32-40`
resolves the extension as
`Bundle(identifier: "sqlite-vec")?.path(forResource: "vec", ofType: "")` with
entry point `sqlite3_vec_init`. So the podspec already knows what to do with a
framework; the tarball simply has none. Wave 3 read that as "iOS has no
sqlite-vec"; it is really "iOS has no sqlite-vec *artifact*", and an artifact is
something a build makes.

- **`apps/mobile/scripts/build-sqlite-vec-ios.sh`** clones `asg017/sqlite-vec`
  at `v0.1.7-alpha.2` with submodules (the vendored `sqlite3ext.h`), compiles
  `sqlite-vec.c` with clang as a DYNAMIC library — the extension is dlopened by
  `sqlite3_load_extension`, so a static slice would be unloadable — for
  `iphoneos` arm64 and `iphonesimulator` arm64 + x86_64 against the
  `ios.deploymentTarget` the pods use (17.5, read from
  `ios/Podfile.properties.json`), lipos each platform's slices into a flat
  `vec.framework` whose binary is `vec` and whose `CFBundleIdentifier` is
  `sqlite-vec` (that pair is what makes the Swift lookup above resolve to
  `…/vec.framework/vec`), asserts `nm -gU` exports `_sqlite3_vec_init`, and
  packages both with `xcodebuild -create-xcframework` into
  `node_modules/expo-sqlite/ios/vec.xcframework`. macOS-only guard, every
  missing tool named, `.centraid-sqlite-vec-tag` makes it idempotent and
  `SQLITE_VEC_FORCE=1` overrides. The framework builders are called plainly
  rather than in a command substitution, so a failing slice exits the script
  instead of a subshell.
- **The tag is pinned to Expo's.** `scripts/sqlite-vec-version.test.mjs` reads
  the `TAG=` line out of the shell script and the version string out of
  `android/vec/arm64-v8a/vec.so` (the only place the tarball states what it
  bundled) and requires them equal — so an expo-sqlite bump that moves the
  Android `.so` reds a node test instead of silently giving two phones two
  different sqlite-vec versions.
- **`.github/workflows/mobile-ios-lock.yml`** builds the framework before
  `pod install`, then runs an unsigned Debug `iphonesimulator` `xcodebuild` over
  `Centraid.xcworkspace` — a lock is a resolution claim, and only a build proves
  the vendored slices link and `-DWITH_SQLITE_VEC` compiles — and uploads
  `vec.xcframework` beside the lock. The binary is never committed.
- **`apps/mobile/package.json`** gains `eas-build-post-install`, guarded on
  `EAS_BUILD_PLATFORM = ios`. **Deliberately `post-install`, not
  `pre-install`**: the script writes into `node_modules/expo-sqlite/ios/`, which
  does not exist before the install step, so a pre-install hook would fail loudly
  on every EAS iOS build. `post-install` runs after dependencies and before
  `pod install`, which is exactly the window the framework has to exist in.
- **`apps/mobile/app.config.ts`** now sets `withSQLiteVecExtension: true` at the
  top level, with the comment naming the script and why the framework is built
  rather than shipped.
  `apps/mobile/src/lib/replica/replica-sqlite-vec-error.ts` and
  `expo-sqlite-driver.ts`'s `probeSqliteVec` comment lose the "iOS has none"
  claim; the probe stays, because a shell built before the script ran opens fine
  and still has no `vec0`. `docs/photos/derived-ledger.md` says the same.

**A finding the owner should route.** The expo-sqlite plugin block never reaches
either committed native project. `apps/mobile/ios` and `apps/mobile/android` are
committed and nothing in this repo runs `expo prebuild` (`expo run:ios` skips it
when `ios/` exists, and `android-emulator-install.sh:118` says `assemble*` needs
no prebuild), so the plugin's properties are only written when someone
prebuilds. `ios/Podfile.properties.json` carried no `expo.sqlite.*` key at all
and `android/gradle.properties` still carries none — meaning wave 3's
`useSQLCipher: true` was inert on both platforms, and the phone would have
opened a plaintext file where the driver issues `PRAGMA key`. This commit writes
the three iOS keys (`enableFTS`, `useSQLCipher`, `withSQLiteVecExtension`) into
`ios/Podfile.properties.json`, because without them this slice's own `pod
install` would vendor nothing. **The Android half is left alone and reported**:
it needs `assembleRelease` to verify and belongs beside the Android lanes, not
inside an iOS-lock commit.

**Every file these two changes touch**

- `.github/workflows/mobile-ios-lock.yml` (new) — the dispatchable macOS lane
- `apps/mobile/scripts/build-sqlite-vec-ios.sh` (new) — the framework build
- `apps/mobile/scripts/sqlite-vec-version.test.mjs` (new) — the tag ↔ `.so` pin
- `apps/mobile/scripts/verify-native-state-lib.mjs` · `apps/mobile/scripts/verify-native-state.mjs` · `apps/mobile/scripts/verify-native-state.test.mjs` — `validateLockedNodeModulePods`, its discovery, and the fixture pair that reds the stale lock and greens the one `pod install` writes
- `apps/mobile/app.config.ts` — `withSQLiteVecExtension` for both platforms
- `apps/mobile/ios/Podfile.properties.json` — the three `expo.sqlite.*` keys the plugin would have written, without which this lane's `pod install` vendors nothing
- `apps/mobile/package.json` — the `eas-build-post-install` hook
- `apps/mobile/src/lib/replica/replica-sqlite-vec-error.ts` · `apps/mobile/src/lib/replica/expo-sqlite-driver.ts` — the remedy text and the probe comment lose "iOS has none"
- `docs/photos/derived-ledger.md` — the mobile vector-support section

```
bunx vitest run --root apps/mobile scripts/           # green
bun run lint:workflow-pins                            # 24 workflows clean
bash -n apps/mobile/scripts/build-sqlite-vec-ios.sh   # syntax ok
bun run check:push:static                             # stamped on the committed tree
```

Not verifiable on this machine, and stated as such: the framework build, the
xcframework packaging and the simulator link all need macOS. The first dispatch
of `mobile-ios-lock` is what turns them from a plan into evidence.

### The lock lane also runs on branch pushes

`workflow_dispatch` cannot reach a workflow that is not on the default branch —
GitHub answers 404 — so `mobile-ios-lock` could not be dispatched from the very
branch it exists to unblock. `.github/workflows/mobile-ios-lock.yml` now also
listens on `push` with `branches-ignore: [main]`, filtered to the inputs a lock
is a function of: `apps/mobile/ios/**`, `apps/mobile/package.json`,
`apps/mobile/app.config.ts`, `apps/mobile/scripts/build-sqlite-vec-ios.sh`,
`bun.lock` and the workflow file. Not `pull_request`: ci.yml is the only
workflow allowed on open-PR events (#557, `lint:workflow-pins` rule 5).
`workflow_dispatch` stays for the case where someone wants a rebuild without a
push.

`Podfile.lock` is under `apps/mobile/ios/**`, so the job's own commit-back
matches the filter. `if: github.actor != 'github-actions[bot]'` refuses it. The
idempotence downstream would already terminate the loop — the second run finds
nothing staged and skips the commit — but it would spend a macOS hour proving a
fixed point. Concurrency flips to `cancel-in-progress: true` for the same
reason a push trigger exists: several pushes can queue on one branch and only
the newest tree is worth resolving a lock against; the push is the last thing
the job does, and the artifact upload is `if: always()`, so a cancelled run
leaves the branch as it found it and still hands back what it built.

```
bun run lint:workflow-pins   # 24 workflows clean
bun run lint:ci-egress       # ok
bun run lint:path-filters    # ok
bun run format:check         # clean
bash .governance/run.sh      # 22/22
```

## CI fix — share reachability

`check:reachability` (#750's sharing-plane rule, `scripts/check-share-reachability.mjs`)
went red on PR #1002: two wave 7 capabilities had no production caller. The
rule's remedy is to wire the capability or remove it; `share-reachability.json`
is for documented exceptions and neither of these is one.

**`forwardProjectedEdit` — wired, because the hole it left is a data-loss bug.**
It shipped as a question nothing asked, so an `edit`-grant member editing a row
their vault holds through a subscription had it written LOCALLY, into a row the
origin owns, which the next pass's `update` overwrites without telling anyone.
R10 says a projected row is read-only in the audience vault and an edit is
forwarded to the origin, where it becomes an ordinary intent and comes back
through the share. That path now exists end to end:

- `packages/vault/src/share/apply-outputs.ts` — `ProjectedEditRoute` gains
  `entity`. The caller has to name the row's type in the envelope it sends, and
  re-deriving it from the id would be a second answer to a question lineage has
  already answered.
- `packages/server/src/serve/projected-edit.ts` (new) — `projectedEditTarget`
  asks lineage about every row the intent's DECLARED READ-SET names, and
  `forwardOverPeer` carries the intent to the origin as the member intent the
  origin's door (`peer-replica-intent-route.ts`) already verifies and executes.
  The envelope names the ORIGIN's id and `origin_row_version`, out of lineage:
  the audience's copy can be under a different id entirely (a deduped
  photograph, a colliding uuid), and the origin holds no row under that one.
  A refusal is a denial, not a retry — the origin judged the grant, the
  signature or the payload, and asking again would spin the outbox forever.
- `packages/server/src/routes/replica-intent-route.ts` — the branch sits BEFORE
  the chain verdict and the conflict check, because both are questions about
  THIS vault's rows: a projected row's local `row_version` is the applier's own
  stamp, not anything the member composed against, and the origin re-asks both
  against the copy that counts. The answer recorded is the ORIGIN's status,
  reason and `commit_seq`.
- `packages/vault/src/replica/intents.ts` — `RecordReplicaIntentOutcomeInput`
  gains `commitSeq`, `COALESCE`d on update. A local execution never passes it
  (`gateway/execution.ts` stamps it inside the canonical transaction, the only
  place that knows it); a forwarded one must, or the seat waits for a commit
  that never happened in the vault that owns the row.
- `packages/server/src/routes/replica-routes.ts`,
  `packages/server/src/serve/build-gateway.ts` — the host supplies the
  forwarder, exactly as it supplies `pullShape`: which link reaches the origin
  is the host's fact and the route never learns an address. No dial or no link
  is a fact about REACH, so the intent stays `sending` and is answered
  in-flight rather than written here.

Red-first: `packages/server/src/routes/replica-intent-projected.test.ts`, two
cases — the intent reaches the origin and settles with the origin's outcome and
`commit_seq` while the local dispatcher is never called, and an unreachable
origin leaves the row `sending` instead of landing the write locally. Both fail
on the wave 7 tree (verified by neutralising the branch: 2 failed).

**`shareGrantsClaimingRow` — deleted, because `closure-outputs.ts` already
derives leaves without it.** Its stated production use was the leave/purge path,
and that path does not need a reverse index: `diffShareClosure` computes `leave`
as `before ∖ after` over ONE grant's own member set, and which grants get a pass
is decided by the subject wake families in `grant/authority-registry.ts`, not by
row claims. `core_entity_revoke_on_purge` keying on the subject is exactly why
the per-grant diff is the answer — the grant survives the purge of a member and
keeps delivering, and each grant's own subtraction scrubs the audience's copy.
A second answerer over the same membership could only agree or be wrong.

Removed: the function and its comment (`packages/vault/src/share/closure-members.ts`,
replaced by a note saying why there is no reverse answerer) and its barrel
re-export (`packages/vault/src/index.ts`).

`share_subscription_member_row` (`packages/vault/src/schema/subscription.ts`)
existed for that one reader and now has none. It is dropped in the follow-up
commit below, not here.

Evidence for the deletion: `closure-outputs.test.ts`, "a purged shared row
leaves for EVERY grant whose member set held it" — two grants over one album,
the photograph purged by deleting its `core_entity` row, and each grant's pass
produces the `media_asset` leave and drops the member while the keeper stays.

```
bun run check:reachability        # ok (292 capabilities across 19 module globs)
### Why the vec build step failed, and what it does now

Run 34092275488 (job 101648094884, `macos-26`) reached `Build vec.xcframework`
and died in one second on `v0.1.7-alpha.2 vendored no sqlite3ext.h — the
submodule did not clone`. Everything before it — setup, Xcode 26.4 select, the
React Native / ExpoModulesJSI assert, the CocoaPods assert — passed, and the
guard did its job: it named the missing file rather than letting clang fail
later with something less legible.

The guard was right and the assumption behind it was wrong, in two ways.
`asg017/sqlite-vec` has **no `vendor/` directory and no submodules at all** —
its `scripts/vendor.sh` downloads a SQLite amalgamation into one at build time,
so `--recurse-submodules` had nothing to fetch. And `sqlite-vec.h` is
**generated** from `sqlite-vec.h.tmpl` by upstream's Makefile through
`envsubst`, which macOS runners do not carry; a clone alone cannot compile.

`build-sqlite-vec-ios.sh` now does both jobs itself. It renders the header with
six `sed` substitutions — `VERSION` from the tag's own `VERSION` file, `DATE`
and `SOURCE` from the cloned commit, so one tag always renders one header — and
asserts the result carries `v0.1.7-alpha.2`. For `sqlite3ext.h` it prefers the
platform SDKs' own copy (no network, and a header inside the sysroot is already
on the quoted-include path), falling back to the same pinned amalgamation
upstream's `vendor.sh` uses, with `SQLITE_EXTENSION_INIT1` asserted in whatever
it unzips. The log says which source it took.

**`node_modules/expo-sqlite/vendor/*/sqlite3.h` is deliberately not that
source**, though it sits right there and would need no network at all: Expo
renames the entire public API to `exsqlite3_*` in it, and stock extension source
does not compile against a renamed header (`unknown type name 'sqlite3_vtab';
did you mean 'exsqlite3_vtab'?`). The rename is invisible to a loadable
extension, which reaches SQLite through the `sqlite3_api_routines` pointer it is
handed rather than by linking symbols — so stock headers are both correct and
the only ones that work. Expo's Android `vec.so` is built from stock source the
same way.

Verified here as far as a Linux container can: the script's source-preparation
block was run verbatim against a real clone of the tag, and the `sqlite-vec.c`
it produced compiles clean and exports `sqlite3_vec_init`.

```
bash -n apps/mobile/scripts/build-sqlite-vec-ios.sh   # syntax ok
bunx vitest run --root apps/mobile scripts/sqlite-vec-version.test.mjs
cc -fPIC -shared -O2 -o vec.so <clone>/sqlite-vec.c   # 0 errors, exports sqlite3_vec_init
bun run lint:workflow-pins && bun run format:check
bash .governance/run.sh
```

The arch flags, the xcframework packaging and the simulator link still need
macOS; the next dispatch is what turns them into evidence.

## CI fix — duplication

SonarCloud's "Duplication on New Code" gate (≤ 3%) read 3.5% on the wave's PR.
The owner's per-file breakdown named two files as essentially the whole of it —
`packages/vault/src/schema/deletion-roles.ts` (504 duplicated lines, 82.2%) and
`packages/vault/src/schema/private-tables.ts` (137, 50.9%). Neither has a stale
twin anywhere in the tree: they are duplicates of THEMSELVES. Both were written
as one object literal per row, so fifty-six and twenty-eight times over the same
five lines said the same thing with a different string in them.

**A role is a property of the relationship, not of each row that stands in it.**
Both lists are now declared BY GROUP: the parent, the role, its `ON DELETE` rule
and who carries it out are stated once, and the references under them carry only
what is their own — which key it is, and the one line that says why. Same fifty-
six declarations, same census, same tests; `DELETION_ROLES` and `PRIVATE_TABLES`
are built from the groups so every consumer and both suites are untouched.
612 → 279 lines and 268 → 183 lines, and a group whose rule changes is now one
edit instead of a read of every row under it.

The rest was the waves writing the same block three times:

- **The snapshot door, served from memory** — `packages/test-kit/src/seat-snapshot-transport.ts`
  (new). The golden replica, the test-kit's own seat fixture and the parity run
  each spelled out the same `head`/`range` stub; `chunkBytes` is the one thing
  that differed, so it is the one thing a caller passes. Used by
  `tests/helpers/factories.ts`, `packages/test-kit/src/year3-replica.test.ts` and
  `tests/quality/seat-replay-parity.test.ts`.
- **The log row as the door serves it** — `seatLogRowWire` now lives beside the
  row in `packages/vault/src/replica/log.ts` and is exported from
  `packages/vault/src/index.ts`; `packages/server/src/routes/seat-routes.ts`,
  `tests/helpers/factories.ts` and `tests/quality/seat-replay-parity.test.ts`
  had a copy each.
- **One statement cache, two wasm drivers** —
  `packages/client/src/replica/wasm-statement-cache.ts` (new) is the bind/step/
  reset/keep-it loop both browser drivers were;
  `packages/client/src/replica/wasm-sqlite-driver.ts` and
  `packages/client/src/replica/seat/wasm-seat-driver.ts` now say only how large
  their handful of statements is.
- **One seat artifact for the seat suites** —
  `packages/client/src/replica/seat/seat-artifact.test-fixtures.ts` (new), used
  by `carry-over.test.ts`, `worker-core.test.ts` and `web-seat.test.ts`;
  `bootstrap.test.ts` gains an `opener` for the four copies of its `open` seam.
- **One spelling of a captured commit** —
  `packages/vault/src/replica/replica-log.test-fixtures.ts` (new): `capturedCommit`,
  `insertScheme`, `insertOwnerAndDevice`, `tableDigest`, used by
  `packages/vault/src/replica/log.test.ts`, `log-retention.test.ts`,
  `change-log.test.ts` and `seat-snapshot.test.ts`.
- **The presence row is shaped once** — `SEAT_BLOB_COLUMNS`, `SeatBlobSqlRow` and
  `seatBlobRow` are exported from `packages/client/src/replica/seat/blob-presence.ts`
  and read by `packages/client/src/replica/seat/carry-over.ts`, which had
  re-spelled the columns, the row type and the mapping.
- **Repeated blocks inside one file** —
  `packages/vault/src/operations/registry.ts` (`ref` and `taskCompletion` for the
  four read-sets and three postconditions),
  `packages/vault/src/schema/representation-split.test.ts` (`titledAsset`, and the
  caption rows built once),
  `packages/vault/src/commands/people.ts` (`TASK_ID_ONLY_INPUT`,
  `TASK_STATUS_OUTPUT`), and the successor-links postcondition People and Tasks
  both assert, now `SUCCESSOR_INHERITS_SERIES_LINKS_SQL` in
  `packages/vault/src/operations/task-lifecycle.ts` (exported through
  `packages/vault/src/operations/index.ts`, used by
  `packages/vault/src/commands/tasks.ts`).

No test and no assertion was removed to reduce lines, and the Sonar
configuration and its exclusions are untouched.

**`lint:types`** was red for one diagnostic unrelated to the above:
`packages/vault/src/ingest/enrich-publishers.test.ts` sorted a
`(string | null)[]` with a bare `toSorted()` (`require-array-sort-compare`).
Both sides of that comparison now sort by code unit through one explicit
comparator — a locale collation would order the two lists differently, and the
keys deliberately preserve their script.

### Numbers

Local estimator (8-line normalised windows over the diff's added lines against
every tracked file), `6a1b16715..worktree`:

```
before: added 32398  duplicated 892 (2.8%)
after:  added 31663  duplicated 449 (1.4%)
```

### Gates

```
bunx vitest run packages/server/src/routes/seat-routes.test.ts                    # 11 passed
bunx vitest run packages/server/src/routes/replica-intent-attribution.test.ts     # 5 passed
bunx vitest run packages/client/src/locker                                        # 5 passed
bun run check:push:static                                                         # stamped on the committed tree
bunx vitest run …                     # vault schema/replica/operations/commands, client seat, server seat-routes
bunx vitest run -c vitest.quality.config.ts tests/quality/seat-replay-parity.test.ts
bun run --filter @centraid/vault build
bun run lint && bun run format:check && bun run lint:types
bash .governance/run.sh
bun run check:push:static
```

## Wave 3 — bytes, custody, and a queue that says when it moved

Three of this commit's four subjects are one sentence from R7 taken seriously:
**"backed up" means the gateway's CAS holds the sha, verified; a seat's
presence claim is never by itself the durability answer.**

### Two states, plus a cache bit

`custody-durability.ts` (split out of `custody-status.ts`, see below) folds the
rollup's five custody states into the two a member can act on. Four of the five
say the same thing in four ways — the gateway's own disk has it (`local-only`),
the remote tier has it (`remote-only`), both do (`replicated`), both will and
the push is queued (`pending-offsite`) — and the Backup screen printed all four
as separate rows with separate sentences. `missing` is the one state that says
the bytes are in neither tier, and it is the only honest "not backed up".

`local-unproven` is NOT a sixth state and is no longer rendered: it counts SHAs
where the states count ITEMS (`custody-rollup.ts` says "never sum"), and it is
the arithmetic complement of `freeable` over the local set. `freeable` is the
cache bit — what this vault could RELEASE — which is a different question from
whether anything is at risk, and it now reads as one line rather than as a
sixth row in a column of durability.

### "Backup is complete" needed the gateway's half of the claim

`backupVerdict` returned `complete` for an empty, readable device queue. That
is this phone saying it has nothing left to send; it is not the gateway saying
it has the bytes. The verdict now takes the custody rollup and needs both, and
it gains a fifth answer for the case in between:

- `unverified` — the queue is empty and the rollup has not been read (offline,
  or a gateway that would not answer). Reading that as `complete` puts "Backup
  is complete" on screen on the strength of a claim nobody checked; reading it
  as `failing` calls a tunnel outage an integrity gap.
- `failing` with an empty queue — the phone sent everything it had and the
  bytes are in neither tier. Different title, different sentence: the member
  has to act somewhere other than this screen.

`custody-status.ts` split in two for it. The fold and the two states are pure;
the read is not — it reaches for `lib/gateway`, which reaches React Native, and
the verdict is tested on the node tier where that graph does not load. The
transport keeps the old module name and re-exports the arithmetic, so no caller
moved.

### The phone's byte policy is wave 2's rule, not a second copy of it

`planContentEviction` chose candidates by `!entry.pinned`. It now asks
`seatByteEvictable` — wave 2's function, the one the fetch path already uses —
so the two paths cannot drift. Three things survive the LRU and none is a
heuristic: a pin, a capture this phone made (it may be the only copy anywhere
until the gateway verifies it), and bytes a queued intent names (R25 — the
gateway executes an attachment-dependent intent only once those hashes are
verified, so evicting them makes the member's own work unsendable from the one
device that has it).

`capturedHere` and `referencedByPendingIntent` arrive through a
`ContentProtections` SEAM rather than a lookup the content store does: whether
this phone captured a content id is the upload queue's fact and whether a
queued intent needs its hash is the outbox's, and a store answering either from
its own filenames would be guessing. Absent, both read false — exactly today's
behaviour, pins and nothing else. **Wiring the two predicates is commit 4's**
("staged captures protected from eviction while pending work references them").

A `thumb` reaching the planner throws rather than being planned around: a
caller that put a replicated row in the file cache has confused two things, and
answering politely lets the confusion reach a screen.

### The upload poll is gone; the writer announces

The Photos timeline polled the upload queue's SQLite every 4 s while anything
was in flight and every 30 s when settled, because the queue had no way to say
it had moved. That is the shape wave 2 replaced everywhere else — the applier
sends its notices unsolicited and nobody asks it whether it has applied
anything lately.

`upload-notifications.ts` is the same idea for the device's own outbox, fired
from the only honest place: `UploadQueue.enqueue` and `.drain` are the two
calls that move a row. `drain` announces in a `finally`, because a pass that
threw part-way still moved rows and a badge left on the old answer is the
failure this replaces. The notice carries NO payload — the reader re-reads and
diffs its own signature, and a notice carrying rows would be a second, staler
copy of the answer.

Foregrounding stays a trigger and is not a poll in disguise: the background
pass drains in its own task and its notices do not reach a torn-down listener,
so the first thing a returning screen owes the member is one re-read.

### Both native projects, now that the iOS half is here

`seat-native-build-config.test.ts` covers `ios/Podfile.properties.json` as well
as `android/gradle.properties`, in the two forms the plugin writes (a gradle
`k=v` line, a JSON string). Commit 2 could only hold the Android half; the
merge of the macOS CI slice brought the iOS keys, so the test holds both.

### What this commit does NOT contain

**The Photos timeline is still `timeline-engine.ts`'s in-memory fold.** The
contract asks for it as keyset-paged SQL over the seat store with day and month
buckets as a `GROUP BY` over an indexed column. That is not here, and none of
the work above stands in for it: the merge-and-section path
(`timeline-model.ts`, `timeline-engine.ts`, `timeline-rows.ts`, ~1,100 lines
plus the 10k/50k scale fixtures) is untouched. It is the precondition for the
`mobile/scroll@year3-photos` and day-grouping device rows.

### The emulator gate's red — root-caused in the seat core, not here

CI `mobile-device-gate` run 34100138773 (head 39a0bfcf3 — wave 2's seat store
plus this wave's commit 1, without commit 2) reads fine and cannot write: a
note saved on the phone never appears in the phone's own list
(`tests/agent-e2e-mobile/flows/notes-library.mjs`, `notes-row-first`).

**The cause is in the shared seat core and belongs to the log lane.**
`SeatWorkerCore.apply` never passes `onCommitInTransaction` to
`applySeatLogPage`, so the overlay-clearing hook has no production caller at
all and an executed intent parks at `awaiting-change` for ever. The row is
written; nothing ever retires its overlay or admits it to the list. That is one
missing argument in `packages/client/src/replica/seat/worker-core.ts`, and it
is fixed on `w996/log`, not forked here — a mobile-side workaround would be a
second answer to a question the core already owns.

**My first reading of this was wrong and is recorded as wrong.** I judged it
"not the seat applier or the overlay core" on the argument that the phone does
not run the seat store at that head. The log lane read the code rather than the
wave plan and found the missing caller. The lesson is the cheap one: a claim
about which plane a failure is on is a claim about the code, and the wave plan
is not evidence for it.

### One ordering error of mine that the same gate would have caught

Commit 1 flipped `driver.journalMode` from `DELETE` to `WAL`. The DELETE
declaration existed for exactly one reason, which its own comment stated: a
per-vault writer and a gateway-scoped multi-ATTACH reader shared one file. That
reader is deleted in commit 2 — so commit 1 IN ISOLATION is the pair the
declaration was written to prevent, and 39a0bfcf3 is that isolation. The merged
head has both and is consistent.

It is not the notes failure (a two-connection ATTACH probe on `node:sqlite`
sees the committed row under both modes —
`…/scratchpad/wal-attach-probe.mjs`), and it should have been in commit 2 with
the deletion it depends on. So this commit makes the dependency structural
rather than commented: the driver module no longer exports ANY way to open a
second handle on a seat file — `openMountedReplicaReaderDriver` went with the
plane — and a test pins that the only remaining opener is
`openNativeReplicaDriver`. The unsafe pair now has no second half to assemble.

### Every file this commit touches

- `apps/mobile/src/lib/replica/expo-sqlite-driver.ts` — the dead second-handle opener goes; the WAL note says what it depends on
- `apps/mobile/src/lib/replica/expo-sqlite-driver.test.ts` — the structural pin
- `apps/mobile/src/kit/storage/custody-durability.ts` (new) — the fold and the two states, with no transport in it
- `apps/mobile/src/kit/storage/custody-durability.test.ts` (new)
- `apps/mobile/src/kit/storage/custody-status.ts` — the read, and nothing else
- `apps/mobile/src/kit/storage/custody-status.test.ts`
- `apps/mobile/src/kit/transfer/backup-verdict.ts` — `unverified`, and `complete` over the gateway's own answer
- `apps/mobile/src/kit/transfer/backup-verdict.test.ts`
- `apps/mobile/src/screens/BackupHealth.tsx` — the rollup reaches the verdict
- `apps/mobile/src/screens/BackupHealth.custody.tsx` — five rows become two, plus the cache line
- `apps/mobile/src/kit/fetch-gate/eviction.ts` — the LRU asks `seatByteEvictable`
- `apps/mobile/src/kit/fetch-gate/eviction.test.ts`
- `apps/mobile/src/kit/fetch-gate/content-store.ts` — `ContentProtections`, the seam commit 4 fills
- `apps/mobile/src/lib/upload/upload-notifications.ts` (new)
- `apps/mobile/src/lib/upload/upload-notifications.test.ts` (new)
- `apps/mobile/src/lib/upload/native-queue.ts` — `enqueue` and `drain` announce
- `apps/mobile/src/apps/photos/timeline-engine.ts` — the two timers go
- `apps/mobile/src/lib/replica/seat-native-build-config.test.ts` — the iOS half

### Decisions — wave 3, bytes and custody

- **`unverified` is a fifth verdict, not a silent `complete`.** The alternative
  is a screen that says "Backup is complete" whenever the gateway is out of
  reach, which is exactly when a member is least able to check.
- **`local-only` counts as backed up.** It reads as a warning and used to be
  drawn as one, but R7's sentence is about the gateway's CAS, and the gateway's
  own disk is that. Off-site replication is the gateway's question and has its
  own screen; conflating the two is what produced five rows in the first place.
- **The protections are a seam, not a lookup.** A content store that decided
  "this was captured here" from its own directory listing would be inventing a
  fact two other subsystems already hold.
- **The Photos timeline is named as missing rather than partially rewritten.**
  A keyset page over a bucket table this commit did not build would be a third
  path beside the two that exist.
### The header the extension is compiled against is the whole extension

Supersedes the SDK-header paragraph in "Why the vec build step failed" above:
that fallback ordering was wrong and run 34099041334 (job 101669007050) proved
it. The script took the "using the SDK's own sqlite3ext.h" branch and the arm64
link died with `Undefined symbols for architecture arm64` — `_sqlite3_bind_int`,
`_sqlite3_value_text`, `_sqlite3_vtab_in`, `_sqlite3_vtab_in_first`,
`_sqlite3_value_nochange`, `_sqlite3_vmprintf` and the rest.

`sqlite3ext.h` is not a declarations header. Under `SQLITE_EXTENSION_INIT1` it
`#define`s every `sqlite3_*` name to `sqlite3_api->…`, so a loadable extension
reaches the host through the routine struct the host hands it at init. Compiled
against a header where that block is not in effect, `sqlite-vec.c` calls the
symbols directly. That does not link — and linking would have been the worse
outcome: expo-sqlite loads this through `exsqlite3_load_extension`
(`node_modules/expo-sqlite/ios/SQLiteModule.swift:569-573`) against a SQLCipher
build whose entire API is renamed `exsqlite3_*`, so a direct `sqlite3_bind_int`
would bind against some other SQLite or nothing at all. Upstream's own release
workflow compiles with `-Ivendor/` for precisely this reason.

- `apps/mobile/scripts/build-sqlite-vec-ios.sh` — the SDK branch is deleted.
  There is one header source, always vendored, and the sanity check that it
  carries `SQLITE_EXTENSION_INIT1` stays.
- **The pin moves to 3.49.1** (`https://www.sqlite.org/2025/sqlite-amalgamation-3490100.zip`),
  which is `SEAT_SQLITE_FLOOR` in `packages/vault/src/schema/replica.ts:58` —
  the SQLCipher build the phone actually runs. The `sqlite3_api_routines` layout
  is defined by the host that fills it in, so an extension compiled at or below
  the host's version reads fields the host really wrote; above it, it would
  expect entries the host never filled. Upstream's 3.45.3 would also be safe;
  this pin says which host it is safe against.
- **A new guard makes this class of error self-naming.** After the export check,
  `nm -u` on each slice must show no `_sqlite3_` entry: every call must have been
  rewritten to `sqlite3_api->…`, and an undefined one means the header did not
  do it. Verified discriminating on Linux against the same clone — the correctly
  compiled shared object has 0 undefined `sqlite3_` symbols and one built with
  the redirect suppressed has 74, `sqlite3_bind_int` among them, which is the
  first symbol the runner named.

```
bash -n apps/mobile/scripts/build-sqlite-vec-ios.sh
nm -u good.so | grep -c sqlite3_    # 0
nm -u bad.so  | grep -c sqlite3_    # 74
bun run lint:workflow-pins && bun run format:check
bash .governance/run.sh
```

## CI fix — executed intents settle on both stores

The `verify` lane was red with 10 failures across
`tests/quality/network-chaos.integration.test.ts` and
`tests/quality/offline-reconnect.integration.test.ts`: after
`applyOutcomes([executed outcome])` the intent was still in `queue.pending()`,
`awaiting-change`, holding a `commitSeq`. Not a test problem — a product
regression, and the one the quality lane exists to catch.

Since wave 1 every executed answer carries `commit_seq`, and wave 2 taught
`packages/client/src/replica/intent-settlement.ts` to park the overlay at
`awaiting-change` until the seat's applied cursor reaches that number. That is
R24 and it is right for the SEAT store, whose outbox shares the seat's file and
whose applier calls `clearSeatOverlaysAtCommit` inside the transaction carrying
the commit. It is wrong for the OLD store — `packages/client/src/replica/intent-store.ts`
and `packages/client/src/replica/sqlite-store.ts`, still the shipped read path
on today's web and phone until wave 5 — which has no such cursor and nothing
that will ever call `settleAtCommitSeq`. There the pending badge stayed lit
forever on a write the gateway had already executed.

The fix asks whether a CURSOR WILL BE DRIVEN for this queue, defaulted from the
store — because that, not the answer, is what differs:

- `packages/client/src/replica/intent-record-store.ts` — `IntentRecordStore`
  gains `settlesByCommitSeq?: boolean`. Absent is the safe reading, so a store
  claims it only when it means it.
- `packages/client/src/replica/seat/seat-intent-store.ts` — `SeatIntentStore`
  declares it. No other store does, and none can.
- `packages/client/src/replica/intents.ts` — `IntentQueueOptions` gains
  `settlesByCommitSeq`, defaulting to the store's declaration. It is a fact
  about the WIRING: `packages/client/src/replica/offline-chain.contract.test.ts`
  drives `settleAtCommitSeq` by hand over all three outboxes, and that contract
  is about how the CHAIN behaves given a cursor — not about which hosts have
  one wired. Its `queueOver` helper opts in; not one of its assertions moved.
- `packages/client/src/replica/intent-settlement.ts` — the `commit_seq` branch
  is taken only when that flag is set. Everything else falls through to the
  #929 signals it already had: `answeredVersions` against `holdsVersion`, else
  the ordinary settle. R24's invariant — an executed answer clears its overlay
  in the transaction that carries its commit — is unchanged on the seat store,
  and the old store keeps the behaviour it shipped.

Red-first: `packages/client/src/replica/intent-settlement.test.ts`, three cases
over both store kinds — the seat store parks and is cleared by its cursor (and
not by an earlier one), the old store settles at once, and the old store still
waits on answered versions it does not hold. Two of the three fail on the tree
before this commit.

No test assertion was changed; both quality harnesses pass unmodified.

```
bunx vitest run -c vitest.quality.config.ts tests/quality/offline-reconnect.integration.test.ts \
                                            tests/quality/network-chaos.integration.test.ts   # 12 passed
bunx vitest run packages/client/src/replica/intent-settlement.test.ts \
                packages/client/src/replica/offline-chain.contract.test.ts                    # 46 passed
```

The other four `verify` failures in this lane — `work-counters.ts`'s
`core_content_item.media_type`, the `host-sync-bytes-per-pass` ledger row, the
three U4 copy strings, and a `recover.integration` ECONNRESET — are NOT in this
commit: they were moved to the end-of-PR CI pass.
## Wave 6 — the unlock boundary on each seat

R13 says the sentence this commit is built around: **storage is not authorization**. A non-extractable WebCrypto key stops export, not use by app code running on the page. Electron's `safeStorage` encrypts at rest and prompts for nothing. IndexedDB is readable by the origin that wrote it. Each of those makes `K` harder to carry away and none of them makes a person prove they are present — so shipping one as if it were a boundary is how the gateway's permit gets deleted in exchange for nothing.

**The phone already had the boundary; it was guarding the wrong thing.** `locker-device-auth.ts` held a device secret whose only job was to buy a permit, after which the gateway decrypted and sent back plaintext. The same store, under the same `requireAuthentication` / `WHEN_PASSCODE_SET_THIS_DEVICE_ONLY` options, now holds `K` — and the reveal happens on the device. The keychain will not return the item without Face ID, Touch ID or the passcode; the item does not exist on a device with no passcode and does not travel in a backup. Session cache with the gate's own five minutes, because a prompt per field is a prompt nobody reads, and `lockLocker()` rides `clearSecureCache()` so one gesture drops every decrypted credential the app holds rather than this one and whatever else remembered to listen.

**Desktop and PWA get one boundary, not two.** Per R-A3, Touch ID is deferred — `promptTouchID` needs a signed, entitled macOS build — so both seats get the `KNOWS` half: one local passphrase, PBKDF2-SHA-256 (600k rounds) over it, AES-GCM around `K`, and the wrapped blob is all that is ever at rest. `LockerSession` is shared; only the store differs — IndexedDB on the PWA, `safeStorage`-backed main-process storage on the desktop. The desktop bridge deliberately has no `getLockerVaultKey()`: the renderer unwraps, main never holds `K`, and a test asserts the interface's exact method set so adding one fails rather than passes review.

**The clock is checked, not scheduled.** A `setTimeout` in a backgrounded tab, a suspended Electron window or a React Native app in the background may fire minutes late or never, and a session that expires only when a timer says so is a session that does not expire. `unlocked` compares the clock on every ask; `key()` locks as a side effect of finding itself expired, so a caller cannot ask twice and get two answers.

**Nothing at rest is an oracle.** The wrapped blob carries no verifier: the only way to test a guess is to do the derivation, and salt and nonce are per wrap, so two enrolments of one vault are not comparable at rest either. A test asserts the blob's exact field set and that neither the passphrase nor the key appears in it.

**The two envelopes are held equal by test, not by care.** `locker-secret.ts` is a second implementation of `locker-key-plane.ts`'s wire form, which is the shape that drifts. So `locker-secret.test.ts` encrypts with the gateway's node:crypto and decrypts with the seat's WebCrypto, and then the other way, over the same AAD — including a non-ASCII secret, which is where a `TextEncoder`/`Buffer` mismatch would show.

**A stale `key_id` is refused with the message.** On the seat, before the intent is posted, where the plaintext is still in hand and "re-enter this secret" is an answer the owner can act on. `assertLiveLockerKeyId` in the vault is the gateway's own copy of the check, exported and tested; **its call site on the Locker write path is not wired yet** and lands with commit 4's rewrite of those commands.

### Files

- `packages/client/src/locker/locker-unlock.ts` — the passphrase wrap, `LockerSession`, the numbers carried over from the gate
- `packages/client/src/locker/locker-unlock.test.ts` — nothing at rest is an oracle; the clock is checked, not scheduled
- `packages/client/src/locker/locker-secret.ts` — local reveal, the AAD, the stale-`key_id` refusal
- `packages/client/src/locker/locker-secret.test.ts` — encrypt on one implementation, decrypt on the other, both ways
- `packages/client/src/locker/wrapped-key-store.ts` — IndexedDB for the PWA, the desktop bridge, a memory store for tests
- `packages/client/src/locker/wrapped-key-store.test.ts` — the bridge carries ciphertext, and has no way to ask main for `K`
- `packages/client/src/index.ts` — their exports
- `apps/mobile/src/apps/locker/locker-device-auth.ts` — `K` behind the OS prompt, the session cache, `lockLocker()`
- `apps/mobile/src/apps/locker/locker-device-auth.test.ts` — one prompt per session, another after the timeout, one gesture to drop it all
- `apps/desktop/src/main/gateway-secrets.ts` — `lockerWrappedKeys` beside `gatewayWrappingKeys`; the wrapped blob only, and no way to ask main for `K`

### Gates

```
bunx vitest run packages/client/src/locker                                  # 4 files, 23 passed
cd apps/mobile && bunx vitest run src/apps/locker/locker-device-auth.test.ts  # 9 passed
bunx tsc -p apps/desktop --noEmit                                           # clean
bun run check:push:static                                                   # stamped on the committed tree
```

### What this commit does NOT do

The Locker blueprint's screens still drive the gateway's permit flow: `app-root.tsx`, `session.ts`, `route-acts.ts` and `PermitGate.tsx` are unchanged, and `Lock.tsx` is not yet wired to `LockerSession`. The boundary is built, tested and demonstrated on each seat's code path — which is what the wave's ordering requires before the deletions — but the screens adopt it in commit 4, together with the permit's removal. Naming this here rather than letting the file list imply otherwise.

### Decisions — wave 6, what the gate deletion covers

| Id | Current decision |
| --- | --- |
| **W6-D1** | **`schema/sealed.ts` STAYS. R13 supersedes the Locker _gate_, not the §293 sealed-column class.** The wave's scope line reads "the sealed registry is deleted", and taken literally that would have deleted the column class with it. It must not: the gate had exactly one consumer and the class has three that the key plane does not touch. What goes is what `K` replaced — permits, the `authenticate` op, `locker-auth.ts`, `PermitGate.tsx`, `AuthPayload` and the permit screens — because no consumer of the gate survives a seat that decrypts locally. What stays is `SEALED_COLUMNS` and the machinery around it, because `sync.connection_credential`'s five broker-token columns, the ext band's per-app declared `sealed` lists, and the journal redaction / error-text scrub (`redactCommandInput`, `scrubSealedText`, `sealedHashToken`) each depend on it and none of them is a Locker reveal. Deleting the class to satisfy a scope line would have turned a gateway that must inject OAuth tokens into a gateway that stores them in the clear. The Locker entries in the registry stay too, for the redaction half: `key_id` and the `lk1:` ciphertext must still be hash-not-value in the append-only journal. Ruled by the coordinator on the finding raised at the close of wave 6 commit 3. |

## Wave 6 — the write path names its key, and the key files stop escaping

Two seams, both named at the close of the last commit, both closed here. No deletions: the gate deletion is still ahead, and this is the rule it will be deleted against.

### `assertLiveLockerKeyId` on the write path

`stampLockerKeyOnWrite` is called from `sealWrites` — the ONE chokepoint every writer passes (`gateway/execution.ts:162`) — so this is the engine's rule rather than each command's convention, which is the same reason the seal sweep lives there. Three cases:

- a row with no `lk1:` ciphertext joins the live key, so the next write has something to compare against rather than a NULL to interpret;
- a row whose ciphertext is under the live key is stored;
- a row whose ciphertext is under any other key is **refused** with "re-enter this secret".

The third is what it exists for: an offline seat's intent queued before a rotation and replayed after it. The gateway holds `K′` and the ciphertext is under `K` — and it will not decrypt on the caller's behalf even though it still could, because that is precisely the behaviour the key plane removed. The only repair is the owner typing the secret again, so that is what the message says.

**A NULL `key_id` beside ciphertext is a refusal, not a default.** Stamping the live id over ciphertext whose key nothing names would record a lie that surfaces only at the next reveal — the failure mode #298 spent a ruling on, in a new place. The seat runs the same check before it posts (`locker-secret.ts`), where the plaintext is still in hand; that one is a courtesy to the owner, this one is the rule.

### 118,214 key files in `/tmp`

A test-hygiene bug with a real security shape, found by the coordinator while the disk filled. `/tmp/keys` held **118,214 files** written by test runs — roughly 39k identity seeds, 39k public pins, 38k sealing keys and 1.5k Locker vault keys — real key material for vaults that stopped existing months ago, in a directory no test owned and no cleanup removed.

Nothing was wrong with the key code. `sealKeyFileFor` and `lockerKeyDirFor` both resolve `<dataRoot>/keys` from the vault directory's PARENT, deliberately outside the directory that export, backup and copy gestures move around — that is the property that makes a copied vault ciphertext-only, and it is correct. What was wrong is that `tempDir()` handed back a directory sitting DIRECTLY in the OS temp dir, so "the parent of the vault directory" was `/tmp`.

The fix is in `packages/test-kit/src/temp-dir.ts` and nowhere else: `mkdtemp` still makes the root, but the root is what is TRACKED and removed, and callers get a `work/` directory inside it. Key custody then resolves to `<root>/keys`, inside the tree the existing `afterAll` already owns, and a caller that removes the directory it was given still leaves nothing behind. **No call site changes**, which is what made this the fix rather than one of the alternatives: seven hundred suites cannot each be trusted to remember where their keys went, and a per-suite `afterEach` would have been the same bug waiting for the next suite to be written.

Measured, not assumed: `packages/server/src` end to end, 389 files, `/tmp/keys` delta **0** — before 118,244, after 118,244. Nothing in the repository reads `/tmp/keys` (`grep` finds only the comment in `temp-dir.ts` that explains it), so the directory is safe to delete.

### Files

- `packages/vault/src/gateway/locker-key-plane.ts` — `stampLockerKeyOnWrite`
- `packages/vault/src/gateway/locker-key-plane.test.ts` — the stamp, the stale refusal, the NULL refusal
- `packages/vault/src/gateway/execution.ts` — the call, at the chokepoint, before the seal sweep
- `packages/vault/src/index.ts` — the export
- `packages/test-kit/src/temp-dir.ts` — the tracked root, and the `work/` directory inside it

### Gates

```
bunx vitest run packages/vault/src     # 208 files, 1689 passed, 2 skipped
bunx vitest run packages/server/src    # 383 files passed; 5 failed, none this wave's
bun run governance < /dev/null         # 22/22
bun run check:push:static              # stamped on the committed tree
```

The five: `IS_SANDBOX=yes` where `acp/launch.test.ts` expects `1` (2), no `sqlite3` binary for `gateway-db-lock.integration.test.ts` (1), and two that arrived with the merge of the designated branch and fail identically with this commit's changes stashed — `replica-intent-projected.test.ts` (`route.entity` absent from the forwarded edit) and `protocol-join-lane.test.ts` (`judgeGatewayInfo` answering `ok: false`). Both belong to the wave that landed `projected-edit.ts`; raising them rather than absorbing them.

### Still ahead, and why the split

The gate deletion — permits, `PermitGate.tsx`, `AuthPayload`, the `authenticate` op and its four call sites, `locker-auth.ts`, `locker_auth_credential`, and `Lock.tsx` → `LockerSession` — is not in this commit. It is one change, not two: the blueprint's `queries/auth.ts` calls `ctx.vault.authenticate`, so deleting the op without replacing the screens leaves the app broken, and replacing the screens needs something that does not exist yet — **a way for blueprint code to reach `K`**. The blueprint reads through `window.centraid.read`; `LockerSession` holds `K` in `packages/client`; there is no bridge between them, and `gateway.reveal` still unseals server-side, which R13 says must stop. That bridge is a design decision about the app surface, not a mechanical deletion, and it is named here so the next slice starts from it rather than discovering it.
### The lock lane's commit-back, and what it may write

The lane works: run 34100134506 on 39a0bfcf3 pushed bcf17bd3f, and
`apps/mobile/ios/Podfile.lock` now carries `ExpoSQLite (57.0.2)` and no
op-sqlite. Two consequences of a job that pushes.

**The root fetches before every push.** `.github/workflows/mobile-ios-lock.yml`
commits back to the branch it read on every push that touches a native input, so
`claude/checkout-remote-main-70f7lb` can move under the root at any moment with
no local action. A push that did not fetch first is a non-fast-forward at best
and a lost lock at worst.

**The bot may not write `apps/mobile/native-fingerprints.json`.** CI rejected the
value it wrote — mobile-smoke on bcf17bd3f reported `ios native fingerprint
mismatch: committed be5176356574d46073d103d8d731aeb6914565bf, current
4cdab9719d86b91f5ffbc2267efd1523d38e9326`. The ios hash is platform-dependent,
proved rather than assumed: creating
`node_modules/expo-sqlite/ios/vec.xcframework` and recomputing moves it
(`4cdab9719d…` → `b20d5b4378…`). The macOS lane necessarily has that directory,
because it builds it, plus the `sqlite3.c`/`sqlite3.h` that
`ExpoSQLite.podspec`'s `vendor_sqlite_src!` copies into the same module during
`pod install`. A fingerprint computed after those exist can never equal one an
ubuntu checker reproduces. So the lane keeps running `ci:native-state --write` —
that is the fail-closed L1–L3 gate over what `pod install` just produced — and
`git add`s only `apps/mobile/ios/Podfile.lock`, leaving the refreshed
fingerprints on the runner's disk. The fingerprint belongs to whoever changes
native inputs, regenerated on Linux, which is how this merge resolved it:
`bun run --cwd apps/mobile ci:native-state --write` against the merged tree
produced ios `4cdab9719d…` / android `df5d7e6f6c…`, the exact value CI computed.

`bun run --cwd apps/mobile ci:versions` is not part of this: ci.yml:972-987 runs
it `continue-on-error: true` and `exit 0`, writing the Expo pin-skew list to the
step summary. It is advisory by construction and cannot fail `mobile-smoke`.

```
bun run --cwd apps/mobile ci:native-state --write   # regenerated on the merged tree
bun run --cwd apps/mobile ci:native-state           # green: lock, paths, both fingerprints
```

### The bot's commit is made governance-compliant

CI `governance` (run 34103181691) rejected bcf17bd3f:
`commit-issue-receipt-match — commit touches no receipts/issue-*.md`. Every
future commit-back would fail identically, so
`.github/workflows/mobile-ios-lock.yml`'s commit step now writes a body line
`governance: allow-commit-issue-receipt-match bot-regenerated lockfile; …`,
which is the escape the directive itself documents
(`.governance/packs/governance-kit/audit/directives/commit-issue-receipt-match/check.sh:29-33`,
reason required — a bare token does not waive). The alternative, having the bot
append prose to `receipts/issue-996-one-vault-every-seat.md`, is worse: a bot
writing into an append-only audit artifact is exactly what that artifact exists
to prevent. The directive itself is untouched.

The other body-reading directives were checked rather than assumed.
`commit-message-format` wants Conventional Commits plus an issue suffix, which
the subject `chore(mobile): regenerate ios/Podfile.lock for expo-sqlite (#996)`
already satisfies. `agent-session-identity` keys on a detected agent runtime and
skips a plain `git commit` on a runner. `toolchain-config-protection` reads the
body too, but only for commits touching protected paths, and this one touches
`apps/mobile/ios/Podfile.lock` alone.

**Proved, not reasoned.** A commit shaped exactly like the bot's — same subject,
same waiver body, no receipt in its diff — was made locally and
`bash .governance/run.sh` walked it: it raises no violation. The single
violation the run reports is bcf17bd3f itself, the already-pushed commit this
change prevents recurring; its body cannot be edited now that it is merged, so
it stays red on this branch's history until the branch is squashed or rewritten.
That is a call for whoever owns the branch, not something a lane commit should
paper over.

```
git commit --allow-empty -m "chore(mobile): regenerate ios/Podfile.lock for expo-sqlite (#996)" \
  -m "governance: allow-commit-issue-receipt-match bot-regenerated lockfile; …"
bash .governance/run.sh    # the simulated commit passes; only bcf17bd3f is flagged
bun run lint:workflow-pins # 24 workflows clean
bun run format:check       # clean

## CI fix — the phone's own note, before and after the echo

The emulator gate found it: a note saved on the phone never appeared in the
phone's Notes list on the new (seat) store. Two independent halves, both of
them capabilities that shipped with no production caller.

**The overlay was never cleared.** `packages/client/src/replica/seat/applier.ts`
has an `onCommitInTransaction` hook, and `seatOverlayClearingHook` /
`clearSeatOverlaysAtCommit` (`packages/client/src/replica/seat/seat-intent-store.ts`)
were written to be handed to it — but the only caller was
`packages/client/src/replica/seat/carry-over.test.ts`.
`SeatWorkerCore.apply` passed no hook, so an executed intent parked on its
`commit_seq` (R24) and nothing on the device ever reached it. Now
`packages/client/src/replica/seat/worker-core.ts` passes it, and the sink gains
`onOverlaysCleared` — a changed table is a re-read, a cleared intent is a badge
that goes, and the shell does different things with the two.

**The read did not compose the overlay at all.** The old store overlays every
read (`packages/client/src/replica/store-core.ts#overlay`); the seat's read was
raw SQL over the file, and the file is the GATEWAY's rows — so a write between
the save and the echo appeared nowhere, which is the visible half of the
symptom. New `packages/client/src/replica/seat/read-overlay.ts`:
`seatPendingMutations` reads the pending rows out of `seat_outbox` in the same
handle, `overlaySeatRows` draws them over the answer, and
`SeatWorkerQuery.overlay` (`packages/client/src/replica/seat/worker-protocol.ts`)
names the entity and the row-id column. Bounded by the MUTATIONS, not the
table, exactly as the old store is. A row that exists only in the outbox is
APPENDED rather than sorted into place: it is not in the file, so the SQL that
produced the answer never saw it, and it takes its place when the echo lands.
Absent `overlay` is the canonical read, and a count or a parity check must stay
that way.

Two supporting changes fall out: `SeatWorkerCore` creates `seat_outbox` when it
adopts a handle (`#adopt`) — a bootstrapped file is a copy of the gateway's and
has never heard of it, and every read now composes the outbox — and
`SeatWorkerCore.outbox()` hands back the queue's store over the same handle,
which is the sharing R24 rests on.

Red-first: `packages/client/src/replica/seat/worker-core.test.ts`, "shows the
member's own note before the echo, and the canonical row after it" — the note
is in the list before any page carries it, a page carrying a DIFFERENT commit
leaves the overlay standing, and the page carrying its `commit_seq` clears the
overlay and returns the file's own row. It fails on the tree before this commit.

```
bunx vitest run packages/client/src/replica/seat/worker-core.test.ts   # 8 passed
```

## Wave 3 — the timeline is a page, not a fold

A phone holding a year-3 vault cannot fold its media table in memory to draw
one screen. `sectionPhotoAssets` did exactly that: read `media.asset` whole,
group by local day in JavaScript, hand back every section. At the volume this
wave is cut to that is tens of thousands of rows to draw twenty, every time,
and no memoisation above it changes what SQLite was asked for.

`apps/mobile/src/apps/photos/timeline-page.ts` is the replacement, written
red-first against a seat-shaped fixture of 19,712 assets over three years.

### Keyset, and the measurement that changed the design

`LIMIT n OFFSET k` makes SQLite walk and discard `k` rows, so page 100 costs a
hundred pages. The key is `(captured_at, asset_id)` as a ROW VALUE —
`(a, b) < (?, ?)` — which SQLite turns into an index seek rather than the
`a < ? OR (a = ? AND b < ?)` an optimiser has to be talked into. Row values are
3.15, twenty releases under the floor.

**The first draft keyed on the local-day EXPRESSION** so that one index could
serve both the page and the month aggregate. `EXPLAIN QUERY PLAN` answered
`SCAN media_asset USING INDEX …`, not `SEARCH`: SQLite will not turn a
row-value range over an expression index into a seek, so every page walked the
index from the top. Measured on 60,000 rows
(`…/scratchpad/keyset-depth.mjs`): **33 µs at the newest page, 4,324 µs at the
oldest** — the offset cost this module exists to delete, wearing a
returned-row count that looked perfectly cheap. On plain columns the same query
is `SEARCH media_asset USING INDEX seat_media_timeline_idx (captured_at>? AND
(captured_at,asset_id)<(?,?))` and flat with depth: 59 µs / 15 µs / 60 µs at
depths 0, 30,000 and 60,000.

So there are TWO indexes, both the seat's own and both partial on the
timeline's exact predicate: the page seeks `seat_media_timeline_idx`, the
scrubber aggregates `seat_media_local_day_idx`, and neither pretends to be the
other. A returned-row assertion alone could not have seen this, which is why
the test asserts the PLAN as well.

### Buckets are a GROUP BY over an indexed expression, never a second table

`timelineBuckets` returns one row per month — 36 rows for three years, not
19,712 — because the aggregate walks the day index. A `timeline_day` rollup
table would be the other way to get that number and would be a second truth
about the same rows, kept in step by triggers the seat does not have and would
have to invent: the seat's only surviving triggers are FTS sync. **A seat may
add an INDEX to its own copy. It may not add a table.**

### The day is the capture-local one, and a page can split it

`captured_at` is a UTC instant and `tz_offset_min` is the zone the shutter
fired in (#419). A photo taken at 23:30 in Tokyo and one taken at the same
instant in London are different days to the people who took them. The day is
computed in SQL — `substr(datetime(captured_at, (coalesce(tz_offset_min,0) ||
' minutes')), 1, 10)`, `||` rather than `concat()` because `concat()` is 3.44
and the floor is 3.49.1 — so a section header cannot disagree with its rows.

Ordering by `captured_at` means two rows of one local day can be separated by a
row from another when the offsets differ: a flight, or a zone change. The
slicer folds those back together rather than emitting a second header for a day
already on screen, and there is a test for exactly that shape.

### What is still to come, and why it is not here

The Photos SCREENS still read `timeline-engine.ts`. That is deliberate rather
than unfinished: `timelinePage` takes a `SeatSqliteDriver`, and the phone does
not open a seat file until W4/W5 wires the seat store onto it. Pointing the
screen at this module now would mean pointing it at a store the phone has not
got. The mechanism, its indexes and its cost are proven here; the swap lands
with the store.

### One regression fixed beside it: the web seat's Tally totals

CI burn-in flagged `tally-balance-parity.integration.test.ts` failing 3/3:
`web.owe_total_minor + web.owed_total_minor` was `NaN` while `expense_count`
was 40 and `friends` had length 3.

**The read was right and the test's local type was three waves stale.** R22
removed `owe_total_minor` / `owed_total_minor` and `friends[].net_minor` from
the dashboard — a bare minor-unit integer cannot be rendered as a balance,
because a bag of USD 100 and EUR 100 has no single number — and the handler
returns `Valuation`s and per-currency `Money` bags. The test's own `Dashboard`
interface still declared the old fields, so the guard read
`undefined + undefined`.

It failed loudly only because `NaN > 0` is false. Written `>= 0` the same guard
would have passed over an empty payload indefinitely — the guard existed to
stop the comparison being vacuous and had itself become vacuous.

**And the second test in the file was worse, because it was green.** "Every
friend's net agrees" compared `friend.net_minor`, which the same ruling
removed: both seats returned `undefined`, `toStrictEqual` agreed about it, and
its own non-vacuity guard passed on `undefined !== 0`. It was agreement about
nothing, in the test whose whole job is to prove the two seats agree about
something — and only fixing the interface made the compiler say so. It compares
the per-currency `Money` bags now, and its guard asks for a non-zero amount
inside one. The interface
now matches what the query returns, the guard reads the `Valuation` the same
way `tally-airplane.test.ts` reads it, and the case the burn-in asked for is
pinned directly: `phone.owe`/`phone.owed` and the per-friend balance bags
compared to the web seat's by SHAPE, not by a total that a dropped currency
component or a bigint-versus-number driver difference would survive.

### Bundle weight

`bun run perf:app-weight -- --surface mobile` on this tree: **ios largest chunk
8,259,045 B, android 8,279,799 B** against the 8,220,000 B ceiling — already
over at `6654a6901` (8,257,168 / 8,278,154) and NOT raised here. This wave's
delta is +1,877 B ios / +1,645 B android, all of it commit 3's product code:
`custodyDurability` and `notifyUploadQueueChanged` are both in the Hermes
bundle. `seat_media_timeline_idx` is NOT — `timeline-page.ts` has no product
importer yet, so Metro drops it and this commit adds nothing.

Checked while in the import graph, as asked: **`apps/mobile` does not reach the
browser wasm driver through a client barrel.** Its only replica subpath is
`@centraid/client/replica/native`, and `native.ts` exports neither
`seat-worker.js` nor `sqlite-store.js` — the two paths to `wasm-seat-driver` /
`wasm-statement-cache`. There is no import to cut.

### Every file this commit touches

- `apps/mobile/src/apps/photos/timeline-page.ts` (new)
- `apps/mobile/src/apps/photos/timeline-page.test.ts` (new)
- `tests/integration-mobile/tally-balance-parity.integration.test.ts`

### Decisions — wave 3, the timeline page

- **Two indexes, not one.** One index led by the day expression would serve
  both queries and serve the page badly; the measurement above is the whole
  argument, and it is in the module's own comment so the next reader does not
  re-derive it.
- **The plan is asserted, not just the row count.** The failure that got
  through the row-count assertion was a full ordered index walk returning 41
  rows. A test that cannot see that is not holding the claim it says it is.
- **The screen is not switched over in this commit.** The seat store is not on
  the phone's read path until W4/W5; wiring a screen to a driver the phone does
  not open would be a third path beside the two that exist.

## Wave 3 — one OpenSSL, because SQLCipher is an OpenSSL consumer

Enabling `expo.sqlite.useSQLCipher` on Android (commit 3) broke the release
build: `:app:mergeReleaseNativeLibs` died on "2 files found with path
lib/x86_64/libcrypto.so". It built at `bcf17bd3f` and not after, and the cause
is mine.

### What actually collided

Both modules link OpenSSL from the SAME Maven artifact at DIFFERENT versions:

| module | declaration |
| --- | --- |
| `react-native-quick-crypto` | `implementation 'io.github.ronickg:openssl:3.6.2-1'` |
| `expo-sqlite` (only under `useSQLCipher`) | `compileOnly 'io.github.ronickg:openssl:3.3.2-1'` |

SQLCipher IS an OpenSSL consumer — expo-sqlite's Android build adds
`-DSQLCIPHER_CRYPTO_OPENSSL` when the flag is on — so turning encryption on
made it the second one in this app. Unforced, both resolve and both are
packaged.

### Option (1) was checked first and does not hold

Deleting `react-native-quick-crypto` would take its OpenSSL with it, and it is
the better answer where it is available. It is not available here, for two
reasons that are both about capability rather than taste:

- **Streaming SHA-256 over camera assets.** `native-digest.ts` builds an
  incremental hash (`createHash("sha256")`, `update`, `digestHex`) because the
  upload queue addresses multi-gigabyte videos by content. `expo-crypto` offers
  one-shot `digest`/`digestStringAsync` only; the equivalent is loading the
  whole asset into memory to hash it.
- **WebCrypto `subtle`.** `installQuickCrypto()` in `apps/mobile/index.ts`
  supplies Hermes with AES-GCM and HMAC. W6's unlock boundary is AES-256-GCM +
  PBKDF2 and `webCryptoUploadCrypto()` wants the same surface; Hermes has no
  WebCrypto and `expo-crypto` does not provide `subtle`.

So this is option (2): both consumers link ONE OpenSSL.

### The fix, and why it is not a `pickFirst`

`apps/mobile/android/build.gradle` forces
`io.github.ronickg:openssl:3.6.2-1` for every configuration. A `pickFirst` on
`libcrypto.so` would keep TWO OpenSSL builds in the tree and bind SQLCipher to
whichever the merger happened to reach first — and a SQLCipher linked against
an OpenSSL it was not compiled against is a silent data-corruption path, not a
packaging warning. Forcing resolves it before anything is packaged: one
library, and every consumer compiled against the headers of the one it gets.

**Newest wins, and the direction is the argument.** OpenSSL 3.x is ABI-stable
within its major line, so code compiled against 3.3 headers runs against the
3.6 library; the reverse is not guaranteed. The forced version is therefore the
newest any consumer asks for, and the test holds it to that rather than to a
literal.

### Red first, and it stays red for the next arrival

`seat-native-build-config.test.ts` grows three cases that read the real
dependency graph — every `node_modules/*/android/build.gradle` that names the
OpenSSL artifact:

- more than one consumer still exists, so the force is load-bearing rather than
  dead weight (if it ever drops to one, the test says to remove it);
- the app's `build.gradle` forces exactly one version, and it is the newest any
  consumer asks for — a third module wanting something newer fails here;
- neither gradle file answers this with a `pickFirst` on `libcrypto.so`.

The middle case was written first and failed on the missing force, which is how
the fix was arrived at rather than guessed.

### Not verified locally, and what would verify it

`./gradlew :app:mergeReleaseNativeLibs` cannot run in this container: there is
no Android SDK and Gradle cannot resolve its own plugins offline
(`org.gradle.toolchains.foojay-resolver-convention` is unresolvable). **The
proof is the emulator gate on the next push.** What IS established here is the
collision's cause, both declarations by file and version, and that one
resolution now covers both.

### Every file this commit touches

- `apps/mobile/android/build.gradle`
- `apps/mobile/src/lib/replica/seat-native-build-config.test.ts`
- `apps/mobile/native-fingerprints.json` — refreshed after the gradle change: android `df5d7e6f…` → `6a0bd966…`

### Decisions — wave 3, the OpenSSL collision

- **Force, not exclude, and not `pickFirst`.** The two symptom fixes leave two
  OpenSSLs in the artifact and make the pairing arbitrary. The failure mode
  they hide is corruption of an encrypted vault file, which is the one class of
  bug this wave can least afford to make quiet.
- **quick-crypto stays, and the reason is written down.** It is the only
  provider of a streaming hash and of WebCrypto `subtle` on Hermes. If either
  gains a platform provider, deleting it is the better fix and the first test
  case will point at it.

## Wave 6 — the wire golden catches up with a version bump it did not make

CI coverage-shard 2 on `6654a6901` failed `wire-conformance.contract.test.ts` — the golden-sync assertion plus the two `gatewayPairResponse` vectors. Regenerated here with the repo's own mechanism (`UPDATE_GOLDEN=1 vitest run wire-conformance`), and the diff read before it was accepted.

**The wire delta, in one line: `protocolVersion` 3 → 4 in the `gatewayPairResponse` vector, and nothing else.** No field was added or removed, no other vector moved, no ALPN and no cap changed, and `jsonByteLength` is unchanged at 212 because the value is one digit either way — the frame bytes differ in exactly one position. That is the whole diff, checked field by field rather than eyeballed.

**Attribution, corrected.** This was assigned to wave 6's commit 2 (`0c009c3da`, the key door) on the assumption that the pair response's shape had changed. It had not. `git show --name-only 0c009c3da` touches no file under `packages/tunnel`, no `version.ts` and nothing in the pair path; its only protocol change is a `SeatLockerKeyWire` **type** and a comment. The constant moved in **`32cf84e39` — "feat(mobile): the mount plane goes; the outbox is the surface (#996)"**, wave 3's commit, which bumped `GATEWAY_PROTOCOL_VERSION` from 3 to 4 without re-freezing the fixture that embeds it. The golden reads the constant rather than a literal precisely so a bump cannot pass unnoticed (#726 Finding 8), and it did its job — it just named the wrong wave.

**And therefore the version constant must NOT move again.** The rule asked about is satisfied: the pair response IS a wire-versioned frame, and its version DID move with the change that altered it. Bumping it here would be a second bump for one wire change — every N-1 client would meet the wall twice, and the second wall would stand for nothing. The fixture is what was behind, so the fixture is what moves.

**One more, not a failure.** `packages/server/src/serve/protocol-join-lane.test.ts` failed in the full-suite run and passes on its own (4/4, 63 s): it drives a real transport and was starved under parallel load. Recorded as a flake rather than fixed, because a timing ceiling raised to make a crowded machine green is a ceiling that no longer means anything.

### Files

- `packages/tunnel/fixtures/wire-golden.json` — the `gatewayPairResponse` vector's `json` and `frameBase64`, re-frozen at `protocolVersion` 4

### Gates

```
bunx vitest run packages/tunnel/src/wire-conformance.contract.test.ts   # 46 passed
bunx vitest run packages/server/src/serve/protocol-join-lane.test.ts    # 4 passed, alone
bun run governance < /dev/null
bun run check:push:static                                               # stamped on the committed tree
```

### Inherited, and not mine to fix

`bun run governance` now reports one `commit-issue-receipt-match` violation on **`bcf17bd3fe0a54fb494de659188e5ccf591509a0`** — the iOS lock bot's `Podfile.lock` / `native-fingerprints.json` push, which touches no `receipts/issue-*.md`. It arrived through the merge of the designated branch and is not a wave-6 commit; the directive's own escape hatch (`governance: allow-commit-issue-receipt-match <reason>` in the body) is the fix, and it belongs to whoever owns the bot. Raising it rather than working around it.

## Wave 6 — `window.centraid.locker`, the door the app talks to

The bridge the last section said did not exist. Ruled by the coordinator as **W6-D2** and recorded below; the blueprint's adoption and the gate's deletion follow it.

### Decisions

| Id | Current decision |
| --- | --- |
| **W6-D2** | **Blueprint code never holds `K`. The bridge is a shell kit door, `window.centraid.locker`, owned by `packages/client` and sitting on the kit surface beside `read`.** R13 puts the unseal on the seat; this says which part of the seat. The SHELL holds `K` behind the member's unlock, and an app gets the **plaintext of one row per receipt** — never the key. The reason is what an app surface can do with a key it can read: one `fetch` in a blueprint and the vault key is on someone else's server, with **no receipt recording it, because nothing was revealed**. Three methods and no fourth: `reveal({ rowId })` unseals locally and writes the reveal receipt through the same receipt/intent path `gateway.reveal` used, so the audit trail does not change shape; `state()` and `subscribeLock()` so screens render the shell's Lock surface instead of drawing their own. There is **no seal door and no `unlock()`** — writes stay intents carrying the secret over the tunnel and the gateway's `sealWrites` stamps the live key (`stampLockerKeyOnWrite`, `27628612e`), and a locked `reveal` returns a typed refusal rather than prompting, because a door that can raise the passphrase prompt is a door that can be used to phish it. Mobile gets the same door over the RN bridge, backed by commit 3's `K`-behind-biometrics path. What this ruling then licenses, and nothing more: the `authenticate` op and its four call sites, `queries/auth.ts`, `locker-auth.ts`, `PermitGate`, `AuthPayload`, the permit screens, and the `gateway.reveal` door go — the server never unseals a Locker row for a client again. Connector credentials are the sealed-column class under [W6-D1](#decisions--wave-6-what-the-gate-deletion-covers) and are untouched. |

### Two orderings the door keeps

**The receipt before the plaintext.** `gateway.reveal` wrote its journal row inside the transaction that produced the value. The boundary moved; the ordering must not. `recordReveal` is awaited after a successful decryption and **before** the values are returned, so a reveal whose receipt could not be written is a reveal that did not happen — with the gateway no longer decrypting, that receipt is the only record that anyone looked.

**Locked is an answer, not an exception.** `reveal` on a locked session reads nothing, records nothing, and returns `{ ok: false, reason: "locked" }`. The app renders the shell's lock surface; the member unlocks there. The door never prompts, so it cannot be borrowed to collect a passphrase.

The lock state is **polled, not pushed**: the thing that most often changes the answer is the clock, and nothing fires an event when a session expires. Two field reads a second, and only while something is subscribed.

Transports are injected — `readRow` and `recordReveal` — because the web shell, the Electron renderer and the React Native bridge reach the vault and the intent queue differently, and this module is the one piece all three must agree on. It owns the rule and none of the plumbing.

### Files

- `packages/client/src/locker/locker-kit-door.ts` — the door
- `packages/client/src/locker/locker-kit-door.test.ts` — plaintext without the key, locked answers without reading, receipt-before-plaintext, the stale-key refusal, the polled lock state
- `packages/client/src/index.ts` — its export
- `packages/blueprints/types/centraid.d.ts` — `locker?: CentraidLockerDoor` on `CentraidClient`, feature-detected, with the refusal and state types beside it

### Gates

```
bunx vitest run packages/client/src/locker   # 5 files, 30 passed
bunx tsc -p packages/client --noEmit          # clean
bun run governance < /dev/null
bun run check:push:static                     # stamped on the committed tree
## The dead index goes, and the golden corpus is re-frozen with it

The reachability commit left `share_subscription_member_row` standing and filed
it as a finding, on the reading that the frozen corpus carries the index and
removing it is therefore a migration rung. That reading is wrong under the
owner's pre-1.0 rulings: **there are no rungs and no compatibility paths before
1.0**, and a rung spent carrying a dead index forward is a rung spent making
the wrong thing survive.

So the index is deleted from the baseline DDL
(`packages/vault/src/schema/subscription.ts`), where a comment now says why
there is no index on `(table_name, pk)` at all, and the golden corpus is
re-frozen in the same commit through the repo's own tooling:

```
bun run golden-vault:freeze -- --label issue-929
  # froze issue-929 — 18 table(s), 182 row(s), schema v6 (ontology 1.0)
```

`packages/vault/tests/golden/issue-929/vault.db.gz` and its `manifest.json` are
the artefacts. `golden-vault.test.ts`'s schema gate now proves the CURRENT
baseline: the frozen file and a vault founded by today's code agree, which is
the whole point of that gate and what a corpus frozen before wave 7 could no
longer do. The row-id and digest churn in the manifest is the deterministic
seed re-running against the tree as it stands, not a rewrite of what the corpus
holds — the row and table counts are unchanged.

Recorded in [docs/decisions.md](../docs/decisions.md) under the #996 rulings,
beside the v0 stance it follows from.

```
bunx vitest run packages/vault/src/golden-vault.test.ts \
                packages/vault/src/schema/migrate.test.ts \
                packages/vault/src/share/closure-outputs.test.ts   # 31 passed
```

## Wave 3 — the pending projections still wrote a title the schema had moved

`bun run test:integration:mobile` was red on sixteen cases with
`ReplicaProtocolError: Unknown column "title" on core.content_item`, thrown by
`validateOptimisticMutation` before any write left the phone.

R20(b) moved the AUTHORED title off `core_content_item` onto the owning row —
`core.document.title`, `knowledge_note.title`, `media_asset.title` — because a
content row is keyed by its bytes: two assets sharing a sha shared one caption,
and a generated caption overwrote the owner's own words. The column is gone,
and so is `media_type`. Two pending projections still wrote both.

Both were writing it TWICE, which is what makes this the mirror the ruling
deleted rather than a rename anyone missed: `docs` already set
`core.document.title` two lines above, and `notes` already set the note's title
through `NOTE_FIELDS`. What the `core.content_item` upsert is FOR is minting
the row the document or note points at, so it exists in the overlay before the
gateway answers — and `content_id` is all that takes.

No compatibility path and no fallback: the column does not exist, and a
projection that wrote to it optimistically would have drawn a title on a row
that could never carry one.

### Verification

```
bun run test:integration:mobile   # 16 failures → 12; every `Unknown column
                                  # "title"` case green
```

### The twelve that remain are a different defect, and not this lane's

`conflict.integration.test.ts` fails for all eight apps on
`expect(actualVersion).toBeGreaterThan(expectedVersion)` with numbers two
orders of magnitude apart — `expected 2 to be greater than 432`,
`expected 3 to be greater than 447`. The two sides are not the same quantity.
`packages/server/src/routes/replica-intent-shape.ts:278-279` answers
`expectedVersion: base.version` beside `actualVersion: entityMax.seq ?? 0` — a
row version against a log sequence. The umbrella's own acceptance row says
"every mutable table has `row_version`, bumped by its touch trigger; **the
gateway's conflict check compares the column**", so the sequence is the wrong
side of that comparison. `locker`'s denied case (`conflict` where `denied` is
owed) and three `parked` cases are the rest. All of it is the gateway's intent
plane, not seats+apps, and it is reported rather than absorbed.

### Every file this commit touches

- `packages/blueprints/apps/docs/pending-projection.ts`
- `packages/blueprints/apps/notes/pending-projection.ts`

### Decisions — wave 3, the pending title

- **The content row keeps only its id.** Reaching for another column to carry
  the optimistic title — `content_uri`, a synthetic field — would rebuild the
  mirror under a different name. The owning row has the title; the overlay
  reads it there.

## Wave 3 — the queue survives the repair, and the bytes it needs survive the cache

Two rules that wave 2 wrote down and nothing enforced. Both were live defects
on this branch, and the tests that name them were red before the code moved.

### A seam nobody supplied answers `false`

`planContentEviction` has refused to evict bytes a queued intent needs since
wave 2, and `storedContentEntries` takes that answer as a callback so the byte
store cannot guess it from its own filenames. Nothing ever passed one:
`ensureOfflineContent` called the sweep as `enforceOfflineContentBudget(budget)`
with no second argument, so every entry read `referencedByPendingIntent: false`
and the LRU was free to delete the one copy of bytes the member's own queued
write is waiting on. The rule was a comment.

`kit/fetch-gate/protections.ts` is the registry the seam needed. A REGISTRY,
not an import, because the session imports the fetch gate to hand bytes to a
write and the reverse edge would close a cycle: the session registers when it
opens and withdraws when it closes, and an unregistered store protects pins and
nothing else — the behaviour before the policy landed, stated rather than
stumbled into.

`lib/replica/pending-content-refs.ts` is the supplier, and the outbox is its
only source: an intent's input NAMES the rows it is about (`namedRowIds`, the
same reading the chain derives its edges from), so the ids the unsettled outbox
names are the content this queue is still working on. Nothing is inferred from
a filename or the shape of a string, and an id stops being protected the moment
its intent settles. The set is a SNAPSHOT because it has to be — the eviction
sweep is synchronous and the outbox is not — so the seat pushes on every move
of the queue and the sweep reads the last push. A stale snapshot over-keeps for
one pass; it can never over-evict.

`capturedHere` stays unsupplied and that is deliberate, not an oversight: what
this phone captured lives in the upload queue's own staging (`localUri`, its
own database), never in the downloaded-original cache this sweep walks, so a
predicate here would answer a question about bytes that are not in the store.
The capture's protection is the byte policy's `hold` verdict, which is where a
capture's bytes actually are.

### A repair that drained straight through itself

`admissionDuringRebootstrap()` says the pair — admit, do not send — and
`flushIntents` did neither half. It claimed and posted intents during a
re-bootstrap, so an outcome could arrive to be reconciled against a copy about
to be replaced; and an AWAITED `write()` during one had no answer at all, since
its waiter was only ever settled by the drain that should not have run. The
member watching a repair they did not ask for got a spinner.

`#rebootstrapping` is set in `requireBootstrap` BEFORE the refetch is
scheduled — the window this closes is the one between deciding to replace the
copy and starting to — and cleared in the bootstrap's `finally`, which then
flushes. `flushIntents` settles waiters as queued with
`admissionDuringRebootstrap().reason` and returns. The write is saved, in as
many words, and sends after.

The outbox itself needed no change to survive the repair: it is its own table
in the shared file and `wipe()` clears the replica tables in place. The suite
pins that as an invariant rather than leaving it true by accident, over the
acceptance row's own chain — create, rename twice, due date, complete — with
`created_order` 1..5 and the five inputs verbatim. Renumbering a queue reorders
the member's work.

### Every file this commit touches

**New:**

- `apps/mobile/src/kit/fetch-gate/protections.ts`
- `apps/mobile/src/kit/fetch-gate/protections.test.ts`
- `apps/mobile/src/lib/replica/native-session-rebootstrap.test.ts`
- `apps/mobile/src/lib/replica/pending-content-refs.ts`

**Changed:**

- `apps/mobile/src/kit/fetch-gate/download.ts`
- `apps/mobile/src/lib/replica/native-session.ts`
- `docs/mobile-offline.md`
- `receipts/issue-996-one-vault-every-seat.md`

### Decisions — the hold and the protection

- **Admitted and held, never refused.** A repair the member did not ask for
  must not make "saved" untrue. The only correct pair is admit + hold, and the
  reason sentence is the module's, not a second wording on the phone.
- **The registry, not an import.** The session already imports the fetch gate;
  the supplier edge has to run the other way, and a session's answer must die
  with the session or it pins bytes nothing needs, forever.
- **`capturedHere` is left unsupplied on purpose.** Wiring a predicate over a
  store that does not hold captures would be a protection that reads true and
  guards nothing.

## Wave 3 — the chain's four clocks, and the words at the end of it

### The arc nothing joined up

Every piece of the offline chain had a home — the outbox in
`sqlite-intent-store.ts`, the edges and the badge in `offline-chain.ts`, the
states in `pendingChanges()`, the words in `kit/replica/pending-copy.ts` — and
nothing ran the ARC, which is where the seams are.
`offline-chain-journey.test.ts` runs it on one real file through the production
session: five changes with no radio, kill and relaunch, radio back, and a
second writer who got to the row first. It asserts the rows and their order off
the durable outbox after the relaunch, then the conflict on the HEAD of the
chain with both versions on it and the Retry/Discard the sheet offers for it.

`toPendingChanges` had to move to `pending-change-rows.ts` to make that
possible, and the split is worth stating: the mapper is pure, and it was
sitting behind `pending-changes.ts`'s `AppState` import, so asking "what would
the sheet draw" required React Native to be loadable. A journey that runs the
real session on node cannot ask that question through a device runtime.

### Four clocks, measured where they can be measured

`tests/scale/mobile-offline-chain.scale.test.ts` times one arc four times over,
on the production session and a real file:

| row (`.../none/ci-linux-x64-4c`) | observed | ceiling |
| --- | --- | --- |
| `mobile/durable-save` | 19.7 / 8.6 / 5.5 ms | 100 ms |
| `mobile/pending-render` | 0.7 / 0.6 / 0.6 ms | 25 ms |
| `mobile/restart-recovery` | 1.9 / 1.5 / 1.6 ms | 50 ms |
| `mobile/reconnect-drain` | 51.3 / 37.4 / 22.3 ms | 250 ms |

Every one is a LOWER BOUND and the ledger says so on each row: the gateway is
an in-process fetch double, `node:sqlite` on a container filesystem stands in
for flash, and nothing renders. The ceilings are ~5x the slowest of three
samples, on the precedent `mobile/converge` set, and are to be tightened once
nightly samples exist — never raised.

Two of the four needed their scope decided rather than assumed.
`durable-save` is the SLOWEST of the five writes, not their sum: the member
feels one tap, not a batch. `reconnect-drain` stops at ACKNOWLEDGEMENT, because
an executed intent's row clears when the applied cursor reaches its
`commit_seq` (R24) and that interval is `mobile/converge`'s — folding it in
would double-count it and hide which half moved.

### The device rung, named rather than implied

The four `.../device-fixture/ci-android-emu` rows are `unmeasured` with the
Android airplane flow as their probe. The flow drives ONE offline write today;
the chain, the second relaunch inside it and the second-writer conflict are
asserted on node and are NOT in the Maestro arc, because adding them costs
launches against that lane's 8-minute suite budget and nothing in this repo can
measure that cost without an emulator. `native-v0-resilience.md` now says
exactly what the device rung has to add. Evidence for those rows is the CI
`mobile-device-gate` emulator lane, not a phone on a desk.

### One stale row fixed on the way past

`mobile/search/year3-replica/dev-darwin-arm64` named
`apps/mobile/src/lib/replica/multi-vault-reader.test.ts` as its consumer — a
file wave 3 deleted with the mount plane — so `scripts/lint-journey-ledger.mjs`
was red on this branch. The consumer is now the surviving screen-read rig and
the metric is `projected` with a `_basis`: its numbers were observed against a
mechanism that no longer exists. The ceilings are KEPT, not raised — one open
file does strictly less work than four attached ones for the same page, so the
old number bounds the new one from above — and the row says it must return to
`measured` on a real seat-store run. `native-v0-resilience.md` named the same
deleted file and now names its successors.

### Every file this commit touches

**New:**

- `apps/mobile/src/kit/replica/pending-change-rows.ts`
- `apps/mobile/src/lib/replica/offline-chain-journey.test.ts`
- `tests/scale/mobile-offline-chain.scale.test.ts`

**Changed:**

- `apps/mobile/src/kit/replica/pending-changes.ts`
- `docs/mobile-offline.md`
- `receipts/issue-996-one-vault-every-seat.md`
- `tests/agent-e2e-mobile/flows/native-v0-resilience.md`
- `tests/journeys.json`

### Decisions — the chain's numbers

- **Four rows, not one.** A single "offline chain" ceiling would hide which of
  save, draw, relaunch and drain moved, which is the only thing a regression
  needs to say.
- **The seat-side rows are lower bounds and are labelled as such.** Promoting
  one to "the phone's number" is the exact move the ledger's own vocabulary
  exists to prevent.
- **The device rung stays a row, not a promise.** An `unmeasured` entry naming
  its probe and its missing steps is an answer; deleting the row would make the
  gap invisible.
