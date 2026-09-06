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
