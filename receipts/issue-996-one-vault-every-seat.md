# Issue #996 — one vault, every seat: full replicas, a session-captured log, and the ontology bridge under it

Umbrella receipt. One receipt for the whole umbrella; each wave appends its own section below and never edits a section above it.

## Checklist

- [x] **Wave 0a — rulings and drift rows**: R1–R25 with their supersession pointers, the ten drift rows ONT-22…ONT-31 and the new _reader-side drift_ category, the two wrong sentences corrected, and open questions 1, 2, 6, 9, 10, 11, 12 and 13 settled
- [x] **Wave 0b — schema**: the revision occurrence with the wrapper's current-revision pointer and `recordRevision`'s edges deleted; the representation row beside byte-only `core_content_item`; `core_transaction.external_id` without the global `UNIQUE`; the typed occurrence key and one `tz` spelling; the primary-identifier partial index, interval CHECK and issuer column; concept-identity columns; the decoded-body-text side table; deletion roles declared beside references. No epoch bump here
- [x] **Wave 0c — domain operations**: one invariant boundary with Atlas inside it and non-empty pre/postconditions; content write as one operation; acyclic task hierarchy; `complete` / `reopen` shared by People, Tasks and automations with series identity and inherited `about`; the occurrence adapter every reader consumes; temporal validation at every entry point; `tagNotation` replaced by concept identity; `accountFor` and the publisher probe re-keyed; the declared read-set wired into the intent conflict checker; each operation's offline declaration
- [x] **Wave 0d — queries and contracts**: `(party, currency)` balances, group results in the group's currency, the explicit valuation type with its unavailable state, the Money output type, and settlements, obligations and exports on the same helpers
- [x] **Wave 0e — evidence and the cross-boundary tier**: machine tags and document classification linked to their derivation and input revision; the thirteen scenarios promoted to a package fixture with a command→query round-trip test per shared concept across two app surfaces; purge behaviour tested per deletion role
- [x] **Wave 1 — the log and the seat**: `replica_log` with session capture and in-transaction reconstruction, the sanitised snapshot with its canary test, the applier and cursor, the epoch gate, retention; the one `schema_epoch` bump for W0b and W1; replay-and-diff convergence is the gate from here on
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

Wave 0b lands across four commits, and what it lands is **Wave 0b — schema**: the revision occurrence with the wrapper's current-revision pointer and `recordRevision`'s edges deleted; the representation row beside byte-only `core_content_item`; `core_transaction.external_id` without the global `UNIQUE`; the typed occurrence key and one `tz` spelling; the primary-identifier partial index, interval CHECK and issuer column; concept-identity columns; the decoded-body-text side table; deletion roles declared beside references. No epoch bump here. Each clause, in the section that carries it: the revision occurrence and the decoded-body-text side table in `## Wave 0b — history and representation`; the representation row beside byte-only `core_content_item` in `## Wave 0b — the representation split`; the external-id, concept-identity and identifier-interval work in `## Wave 0b — schema`. Two clauses moved by ruling rather than being done here — the occurrence key has no schema work and goes to 0c, and deletion roles ride 0e — both recorded in `## Decisions — wave 0b (second half)`.

Wave 0c lands in one commit, and what it lands is **Wave 0c — domain operations**: one invariant boundary with Atlas inside it and non-empty pre/postconditions; content write as one operation; acyclic task hierarchy; `complete` / `reopen` shared by People, Tasks and automations with series identity and inherited `about`; the occurrence adapter every reader consumes; temporal validation at every entry point; `tagNotation` replaced by concept identity; `accountFor` and the publisher probe re-keyed; the declared read-set wired into the intent conflict checker; each operation's offline declaration. The surface, the scenarios, the site accounting and the gate tails are in `## Wave 0c — domain operations` below.

Wave 0d lands in one commit, and what it lands is **Wave 0d — queries and contracts**: `(party, currency)` balances, group results in the group's currency, the explicit valuation type with its unavailable state, the Money output type, and settlements, obligations and exports on the same helpers. The surface, the scenarios, the site accounting and the gate tails are in `## Wave 0d — queries and contracts` below.

Wave 0e lands in one commit, and what it lands is **Wave 0e — evidence and the cross-boundary tier**: machine tags and document classification linked to their derivation and input revision; the thirteen scenarios promoted to a package fixture with a command→query round-trip test per shared concept across two app surfaces; purge behaviour tested per deletion role. The surface, the scenarios, the files, the gate tails and one carried-in fix are in `## Wave 0e — evidence and the fixture` below.

Wave 1 lands across six commits, and what it lands is **Wave 1 — the log and the seat**: `replica_log` with session capture and in-transaction reconstruction, the sanitised snapshot with its canary test, the applier and cursor, the epoch gate, retention; the one `schema_epoch` bump for W0b and W1; replay-and-diff convergence is the gate from here on. Each clause, in the section that carries it: the schema plane and the single epoch bump in `## Wave 1 — schema and epoch`; session capture, the decoder and the applier with its cursor and epoch gate in `## Wave 1 — capture and decoder`; the sanitised snapshot and its canary in `## Wave 1 — snapshot, doors, capability`; retention, the producer bound and the deferral flag in `## Wave 1 — retention and the producer bound`; the two doors that serve the file and the log, plus the retirement of `vault_content_text`, in `## Wave 1 — the doors, and the function-free index`; and the durable outcome contract in `## Wave 1 — the outcome contract (R23–R25)`. The wave's full file list is `## Wave 1 — every file the wave touched` plus the per-commit lists in the last two sections.

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
