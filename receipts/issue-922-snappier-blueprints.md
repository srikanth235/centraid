# Issue #922 — snappier blueprint apps: replica, gateway and mobile hot paths

Umbrella receipt for [#922](https://github.com/srikanth235/centraid/issues/922). Slices append one `## <wave><slice> — <title>` section each; nothing above a new section is rewritten.

## Checklist

**Part 0**
- [ ] No read on any seat truncates silently: the replica read plan and the gateway read report `truncated` when the default cap fills, undeclared unbounded reads are refused at the kit boundary, and the honesty grammar renders the truncation (test per layer)
- [ ] A text value above the old 64 KB ceiling is either present on the device or visibly absent; no client stores an oversized list it never reads (the decision in open question 7 recorded)

**Part A**
- [ ] A change committed on the gateway reaches a subscribed device's replica in one SSE frame with no `/changes` pull on the happy path; catch-up still pulls and the convergence suites pass; the losing side of the doorbell/payload contradiction is deleted
- [ ] Projections per commit per household ≤ 1 for identically-authorized devices; `buildReplicaShapes` statement preparations per projection ≈ 0 after warm-up (met through #928's static composition; numbers from #927)
- [ ] `readReplicaRow` issues no `PRAGMA` and no uncached prepare on the change path
- [ ] 40 offline edits converge on reconnect in ≤ 2 batch round trips, in order; the pending badge clears on the server's answer, not on the feed's echo (#927 converge journey before/after, web and phone)

**Part B**
- [ ] A handler invocation's remaining reads commit once (`readBatch`) off the read path, with every grantee/agent/reveal receipt still written in the same chain; strace fsync-per-read measured before/after under both profiles
- [ ] Blueprint handlers run precompiled; no esbuild hook on the app-handler path; per-call `fs.stat`s gone
- [ ] Workers are reused across clean runs and terminated only on timeout/error/limit; the pool size has one source and constrained hosts keep ≥1 warm worker; #842 W4.1 ref-search p95 under composition re-measured and budgeted
- [ ] A lone write commits without waiting the group-commit window; the window opens only under concurrency (test on the queue)
- [ ] Durable commits per offline intent measured before/after; each surviving transaction is named with the crash property it protects
- [ ] Standard-profile benchmark exists with provenance; fsync per offline intent recorded; `storageFsyncMs` feeds the window/sync choice
- [ ] Audit-band bytes/read and WAL size are gated numbers; a size-based checkpoint exists

**Part C**
- [ ] An empty outbox costs zero IDB work per read; a non-empty one costs one memory lookup
- [ ] Ordered replica reads use an index (measured on the 50k fixture: the QUALITY.md item closed)
- [ ] Bootstrap statements per row ≤ 3 with a driver statement cache; the replica store runs `synchronous=NORMAL` on every seat with the outbox at FULL; before/after cold-bootstrap time in the receipt
- [ ] A replica session survives 30 s idle and closes on hide/memory pressure; desktop tap-to-app-view reduced against #927's warm-switch journey

**Part D**
- [ ] One write on any of the eight apps causes ≤ 1 screen re-read on the same seat (counter-verified); the user's own overlay re-read has no debounce/coalesce window; the 50 ms pending poll is gone
- [ ] A cold bootstrap does not re-run live queries per page, and fetches page N+1 while applying page N

**Part E**
- [ ] A first-launch bootstrap page and a 40-edit reconnect apply without freezing the JS thread (frame sampler on device via #927's device rung; the store core runs off the JS thread)
- [ ] No `useReplicaQuery` read is unbounded; People/Agenda pass the scale lane at 5,000 rows
- [ ] One entity change re-runs only the reads that depend on it; Photos does not reparse the library per change
- [ ] The five capped roster/drive/ledger surfaces are virtualised on one kit primitive
- [ ] Cold start has a ceiling with provenance; navigators are lazy; a first mount opens local replica files before any network request completes (#927 cold-open journey, online and airplane mode, within the same budget)
- [ ] **Tally on the phone reads balances from the replica** through the imported balance module; `tally-gateway.ts`'s read RPCs and the stale clock are deleted; a balance-parity test holds phone vs web on the same rows; the Tally home renders complete balances in airplane mode; the Tally carve-outs in `docs/mobile-offline.md` and `blueprint-seats.md` are reverted and the ruling superseded in `docs/decisions.md`
- [ ] **Locker's list, shelves and search on the phone read the replica**; `reveal`/`authenticate`/permits/secret-bearing writes are unchanged and still online-only; a test asserts no sealed column name appears in any `locker.item` replica shape; `ONLINE_ONLY_ACTIONS` is unchanged
- [ ] The Metro-loadable `queries/*.ts` decision is recorded, adopted or refused with its reason; if adopted, at least Tally runs the web query handler on the phone and its projection fork is deleted

**Part F**
- [ ] F1/F3/F5 landed in wave 1 with provenance and folded into #927's trace and ledger when those land; F2/F4 closed as superseded
- [ ] Every fix above carries a before/after number (wave-1 instruments, then the #927 ledger); budgets tightened where wins landed, never widened

## What changed

Wave 1, rulings slice — **documentation only**. No code file is touched, so no acceptance box is ticked: a ruling recorded ahead of its code wave is not by itself a satisfied acceptance criterion. The one Part-F clause this slice realizes is the **"F2/F4 closed as superseded"** half of the first Part-F box; its other half (F1/F3/F5 landed with provenance) belongs to the sibling instrument slices, so the box stays unticked until they land.

- `docs/decisions.md` — new section **`## Snappier blueprint apps (#922)`**, placed immediately before `## Related docs`, carrying:
  - a rulings table with nine ids — `SB-payload` (SSE payload frame wins; the doorbell-only pull-on-every-nudge path is deleted in wave 3; property: one hop from commit to a subscribed device), `SB-text` (per-entity declared text ceiling, text rides in full, only blob/binary stays deferred; property: a note the phone cannot show offline defeats the replica), `SB-pool` (`CONSTRAINED_WORKER_POOL_SIZE = 1` in `packages/server/src/engine/handlers/worker-pool.ts` is the single source; the `conserve` preset's `workerPoolSize: 0` and the `build-gateway.ts` boot override are deleted in wave 2), `SB-reuse` (fresh realm per run inside a reused thread; the property #404 buys is the thread boundary plus a hard timeout), `SB-tally` (the "one balance engine" ruling superseded — the engine is the pure module pair the web query handlers already import, which the phone imports directly from wave 4 (E7); until then the phone reaches the fold only through the gateway RPC this ruling supersedes), `SB-replica-sync` (ruled per seat: the wasm replica store runs `synchronous=NORMAL` unconditionally in wave 3, its outbox being IndexedDB and outside the pragma, while the mobile replica store stays `synchronous=FULL` until B4's fsync-per-offline-intent measurement on a phone justifies a change, with WAL + `NORMAL` plus a `FULL` bracket on outbox transactions as the preferred mechanism and the `journal_mode=DELETE` second-reader seam re-judged first), `SB-session` (replica sessions live as long as the tab/window, closing on hide or memory pressure), `SB-instrument` (F1 absorbed into #927's gateway trace slice; F2/F4 closed as superseded; F3/F5 plus #927's work counters are the interim), and `SB-loader` left **explicitly open** for the wave-1 Metro-loader spike to adopt or refuse with its reason. Every row names the property it keeps or the finding it files, and the wave that lands the code.
  - the full **re-judged register** of 2026-09-03 reproduced as a `Seam | Ruling cited | Property that depends on it now | Verdict` table.
- `docs/decisions.md` — six new rows in the existing `## Superseded decision pointers` table, each naming #922 and its replacement: Tally's "one balance engine" as a reason the phone reads from the gateway (#873/#883, carried in `docs/mobile-offline.md`); the #599 30-second replica-session idle close; the doorbell-only client change feed; the `conserve` preset's `workerPoolSize: 0` (#528); "a handler worker is disposed after every run" as the operative reading of #404; and `synchronous=FULL` **as applied to the client replica store** — stated explicitly as *not* touching #456's ruling, which is about the vault.
- `docs/decisions.md` — one sentence appended to the second paragraph of `## Performance and Rust byte plane`: the five evidence-gated designs take their gate from #927's journey ledger when it lands, with #922 wave 1's instruments as the interim. The paragraph is otherwise unchanged.
- `docs/mobile-offline.md` — a forward-stated note at the Tally read carve-out: superseded by `SB-tally` (#922), reverts in #922 wave 4. The carve-out text itself is **kept**, because the code has not moved and the paragraph still describes the shipped seat.
- `receipts/issue-922-snappier-blueprints.md` — this file, created as the umbrella receipt with the issue's acceptance criteria mirrored verbatim.

## Out of scope

- Every code file in the umbrella. This slice writes rulings; waves 2–5 land them.
- `docs/blueprint-seats.md` — its Tally seat row reverts with the E7 code in wave 4, not ahead of it.
- `ARCHITECTURE.md` — its performance section is wave 5's docs sweep.
- Ruling (i), the Metro-loadable `queries/*.ts` entry: recorded as `SB-loader` and deliberately left open for the wave-1 spike.
- `## Audit` — added by the root's fresh-context verifier, never by the author.

## Verification

```sh
bun run format
bun run lint
bun run lint:product
bash .governance/run.sh
bun run check:push
```

Docs-only slice: no package suite or typecheck lane is in scope (no `packages/**` or `apps/**` file changed). The link graph is the substantive gate — `internal-doc-links` runs at pre-commit and resolves the new `#snappier-blueprint-apps-922`, `#performance-and-rust-byte-plane`, `mobile-offline.md`, `blueprint-seats.md` and `decisions.md` targets.

## Decisions

- **Placement.** The contract asked for the new section immediately before `## One authority plane (#928)` if present on the base, else before `## Related docs`. #928's section is not on `origin/main` yet, so the section sits immediately before `## Related docs`.
- **Nothing ticked.** The issue's acceptance boxes are outcomes of code waves; a recorded ruling satisfies none of them on its own. The single clause this slice does realize — Part F's "F2/F4 closed as superseded" — is named in `## What changed` rather than used to tick a box whose other half is unmet.
- **The Tally carve-out text stays.** Deleting it now would make `docs/mobile-offline.md` describe a seat that does not exist yet; the forward-stated supersession note keeps the doc current in both directions until wave 4.
- **`SB-loader` is a row, not an omission.** Leaving the Metro-loader question out of the table would have let a later wave inherit it as an undecided default. It is recorded as open with the spike that closes it and the consequence of each answer.

### Fix after audit

The verifier's `## Audit` below is REFUTED on two findings; both are fixed in the follow-up commit, and the audit text itself is left untouched as the record of what was found.

1. **`SB-tally` claimed the post-wave-4 state as current.** "The pure module pair `tally-balance.ts` / `tally-simplify.ts` **that both seats already import**" is false today: `apps/mobile/src` imports neither module, and the only importers are the web query handlers (`packages/blueprints/apps/tally/queries/{dashboard,friend,group}.ts`). Reworded in all four places the phrase appeared — `docs/decisions.md`'s `SB-tally` row, its superseded-pointer row, `docs/mobile-offline.md`'s forward note, and this receipt's `## What changed` — to "the pure module pair the web query handlers already import, which the phone imports directly from wave 4 (E7); until then the phone reaches the fold only through the gateway RPC this ruling supersedes." The ruling is unchanged; only its tense is.
2. **`SB-replica-sync` ruled over a premise that holds on neither seat.** "The intent outbox stays `FULL`" assumed the outbox is a store of its own. On **mobile** its tables live in the same file on the same connection as the replica store (`apps/mobile/src/lib/replica/sqlite-intent-store.ts`, pragmas set on that one handle in `packages/client/src/replica/store-core.ts`) and `synchronous` is per-connection, so the two halves could not both hold; on **web/desktop** the outbox is IndexedDB (`packages/client/src/replica/intent-store.ts`), where "`FULL`" names nothing. The first fix recorded a per-transaction `PRAGMA synchronous=FULL` bracket on the shared connection; **that mechanism is superseded by item 3 below** — the property it kept (**a member's write is fsynced before the enqueue returns while replica page applies are not**) and the web/desktop scoping (the ruling covers the wasm replica store only) carry over unchanged. The same clarification is stated once beneath the re-judged register, so a reader does not inherit the issue's "separate store" wording as the design; the register row itself is left verbatim, since it is a faithful reproduction and not the ruling.
3. **Amendment after the verifier's PASS: the pragma bracket fell, and so did the file split that replaced it.** The verifier raised, and the root accepted, that `synchronous=NORMAL` under `journal_mode=DELETE` is a **rollback journal** — a power loss can corrupt the file, not merely drop the last commits — so with the mobile outbox in the same file a per-transaction `FULL` bracket could not protect it whatever the pragma said. The first answer was to split the outbox into its own file at `FULL`. **That was itself ruled before the number existed**, which is the mistake this umbrella's own invariant forbids: a schema/file migration on the phone was being adopted to buy a saving nobody had measured, when under a rollback journal the saving is **one fsync per transaction** and E1 (the store core off the JS thread) is the responsiveness win. The maintainer-approved final form of `SB-replica-sync` is therefore per seat, with only one seat unconditional — recorded in the row and mirrored in the note under the register:
   - **web/desktop** — the wasm replica store runs `synchronous=NORMAL` (derived, rebootstrappable; the outbox is IndexedDB and outside this pragma); **wave 3 (C2), unconditional**;
   - **mobile** — the replica store **stays `synchronous=FULL` today**, and any change is **conditional on B4's fsync-per-offline-intent measurement on a phone**. If the number justifies it, the preferred mechanism is **WAL + `NORMAL` for the replica with each outbox transaction bracketed at `FULL`** — under WAL, `NORMAL` can lose the last commits but cannot corrupt, so the bracket is sound and the outbox keeps its file. That needs the seam "the attached second reader depends on `journal_mode=DELETE`" (`store-core.ts:1006`) re-judged — **a citation, not a property** — as C2's first task. Only if that dependency proves real does the outbox move to its own SQLite file and connection at `FULL`, with a one-shot lossless migration of existing outbox rows (red-first) and the Android backup rules and storage accounting updated.

   Either way C2 lands a power-loss case in the convergence suite proving no acknowledged outbox write is lost and a corrupted replica file re-bootstraps. The property is unchanged throughout: **a member's write is fsynced before the enqueue returns; replica page applies are not.** The superseded-pointer row for the replica's `synchronous=FULL` is updated to the same per-seat wording so the two entries cannot disagree. Both audit blocks are left untouched, including the passage in the second one that verified the now-superseded bracket against the code — it is the record of what was checked at that SHA.

## Audit

Verdict: PASS

Re-verified at head `8e9156571` (second pass). Both first-pass findings are fixed at the four sites each touched; the register is untouched; all gates re-run. One risk raised below for the root, not a finding.

2026-09-03 — Amendment at `0a5e5b8ce` re-checked: the risk raised below is answered by a file split rather than the pragma bracket, and the verdict stands. `SB-replica-sync` and the note under the register now both rule that the mobile intent outbox moves to its own SQLite file on its own connection at `synchronous=FULL` while the replica stays `journal_mode=DELETE` at `NORMAL`, a corrupted replica file being detected on open and re-bootstrapped rather than repaired, landed by wave 3 (C2) with a power-loss case in the convergence suite; the bracket mechanism is gone from the docs entirely (`grep -n bracket docs/decisions.md docs/mobile-offline.md` → no hit) and survives only in this receipt as the record of what superseded it. The cited code facts are right: `apps/mobile/src/lib/replica/sqlite-intent-store.ts:68-70` is the comment placing the outbox tables inside the shared replica database, and `native-session.ts:1130` is "Store and intent outbox share ONE driver handle". The delta is exactly `+5/−4` over two files (`git diff bf0781870..0a5e5b8ce --stat`) — the `SB-replica-sync` row, the register note and three receipt lines; no register row, no other ruling and no other doc moved. Gates: `bun run format` clean (empty `git status --porcelain`), `bash .governance/run.sh` → `internal-doc-links` and `doc-integrity` green, 21 pass with only the known pre-existing `repo-hygiene` red (#930).

Second pass — what was re-checked:

- **"both seats already import" is gone from every live site.** `grep -rn "both seats already import\|both seats import" docs/ receipts/ ARCHITECTURE.md README.md` returns only this receipt's own audit and fix narrative quoting the old phrase, plus an unrelated 2026 receipt (`receipts/issue-903-…:788`). `docs/decisions.md:670` (`SB-tally`), `docs/decisions.md:71` (pointer), `docs/mobile-offline.md:116` and this receipt's `## What changed` all now read "the pure module pair the web query handlers already import, which the phone imports directly from wave 4 (E7); until then the phone reaches the fold only through the gateway RPC this ruling supersedes."
- **`SB-replica-sync`'s mechanism matches the code it cites.** Mobile shared connection confirmed: `apps/mobile/src/lib/replica/native-session.ts:1130` — "Store and intent outbox share ONE driver handle" — with `NativeReplicaStore.create(options.driver, …)` and `SqliteIntentStore.create(options.driver)` at lines 1138-1142, and `sqlite-intent-store.ts:68-70` placing the outbox tables inside the shared replica database. Pragmas set on that one handle: `packages/client/src/replica/store-core.ts:296-298` (`foreign_keys=ON`, `journal_mode=DELETE`, `synchronous=FULL`). Web/desktop outbox is IndexedDB: `packages/client/src/replica/intent-store.ts:31,37` (`IDBDatabase`, `IDBFactory = indexedDB`). The `NORMAL` default with `PRAGMA synchronous=FULL` bracketing each outbox transaction before `BEGIN` and back to `NORMAL` after `COMMIT` is legal on a shared connection (the pragma is per-connection and takes effect between transactions), and `sqlite-intent-store.ts:350-360`'s synchronous `BEGIN IMMEDIATE` guard gives it a single place to sit.
- **The re-judged register is still verbatim.** All 18 rows re-diffed cell-for-cell against #922's body: the same three benign deviations as the first pass (two dropped `file:line` suffixes, one self-reference rendered as an in-doc anchor) and nothing else. No row was edited to absorb the correction; the clarification sits as a labelled paragraph immediately under the table, naming the ruling as the design and the register row as the reproduction.

Raised for the root — not blocking, and not a misstatement of current code:

- `docs/decisions.md:672` (`SB-replica-sync`) rules `synchronous=NORMAL` on a replica that is also `journal_mode=DELETE` (`store-core.ts:297`), i.e. a rollback journal rather than WAL. The rationale given — "lost commits are re-pulled from the cursor" — is the WAL guarantee; under a rollback journal, `NORMAL` admits a small chance of **database corruption**, not merely lost commits, on power loss. Because the mobile outbox shares that one file, a corrupting replica commit would take the durable outbox with it, which the per-transaction `FULL` bracket does not prevent. Today's code is `FULL`, so nothing is broken now. Question for the owner before wave 3 (C2) implements it: keep `DELETE` and accept the window, move the replica to WAL where `NORMAL` means only lost commits (the second op-sqlite reader handle is what `DELETE` protects — `store-core.ts:1006` — so this is a real trade), or give the outbox its own file. Recommendation: name the answer in `SB-replica-sync` and add a power-loss case to C2's convergence suite, since B4's "fsyncs per offline intent" measurement does not probe it.

Gates re-run at `8e9156571`:

- `bun run format` → clean; `git status --porcelain` shows only this receipt.
- root `bun run lint` (oxlint, `--deny-warnings`) → pass.
- `bash .governance/run.sh` → 21 pass, 1 fail: `repo-hygiene` (`packages/blueprints/apps/locker/queries.test.ts` 638 > 625 lines — known pre-existing, #930). `internal-doc-links`, `doc-integrity` and `receipt-per-issue` all green.
- Still docs-only: the diff touches no `packages/**` or `apps/**` file, so no package suite or typecheck lane applies.

### First pass (REFUTED — both findings fixed at `8e9156571`)

Findings:

1. `docs/decisions.md:670` (`SB-tally`), `docs/decisions.md:71` (superseded pointer) and `docs/mobile-offline.md:116` → each states as current fact that the balance engine is "the pure module pair `tally-balance.ts` / `tally-simplify.ts` that both seats **already import**". The phone imports neither: `grep -rn "tally-balance\|tally-simplify\|tallyGroupNet\|simplifyDebts" apps/mobile/src` returns nothing, and the only importers are the web query handlers (`packages/blueprints/apps/tally/queries/{dashboard,friend}.ts` → `tally-balance.ts`, `queries/group.ts` → `tally-simplify.ts`). The phone reaches the fold only by a gateway RPC — which is exactly the carve-out this ruling supersedes, so the sentence asserts the post-wave-4 state as though it had landed and undercuts the ruling's own premise. Fix: state what is true now and name the wave — e.g. "the pure module pair the web query handlers already import, which the phone imports directly from wave 4 (E7)". The same wording is repeated in this receipt's `## What changed` (line 55) and needs the same correction.

2. `docs/decisions.md:672` (`SB-replica-sync`) → "The client replica store runs `synchronous=NORMAL` on every seat. The intent outbox stays `FULL`." is ruled over a premise that does not hold on either seat. On mobile the outbox tables live in the **same** database file and on the same connection as the replica store (`apps/mobile/src/lib/replica/sqlite-intent-store.ts:68-70`, "Its tables are its own inside the shared replica database"; `packages/client/src/replica/store-core.ts:297-298` sets `journal_mode=DELETE` and `synchronous=FULL` for that one handle), and `synchronous` is a per-connection pragma — so the two halves of the ruling cannot both hold as written without a per-transaction pragma switch or a file split. On web the outbox is IndexedDB (`packages/client/src/replica/intent-store.ts`), where "stays `FULL`" names nothing. The register row copied from the issue ("the outbox that must survive a crash is a separate store") carries the same false premise, but as a verbatim reproduction it is not the defect — the new ruling is. Fix: `SB-replica-sync` should say how the outbox keeps its durability under a `NORMAL` replica handle (per-transaction pragma, or a separate outbox file) on mobile, and that the web outbox is IndexedDB and outside this pragma entirely, so wave 3 (C2) does not inherit an unimplementable sentence.

Verified clean (no finding):

- Diff ↔ receipt: the diff is exactly `docs/decisions.md` (+47/-1), `docs/mobile-offline.md` (+2), the new receipt; `## What changed` names all three and every one of the three `docs/decisions.md` edits (new section, six superseded-pointer rows, one appended sentence in `## Performance and Rust byte plane`). No file outside the slice contract's path list is touched; no code file is touched.
- `## Checklist` mirrors the issue's acceptance criteria **verbatim** — 36 non-blank lines diffed line-by-line against #922's `### Acceptance criteria` after HTML-entity unescaping, zero differences, Part 0/A/B/C/D/E/F all present in order. `grep -c '\- \[x\]'` = 0, so nothing is ticked.
- Re-judged register: all 18 rows of the issue's "Re-judged 2026-09-03" table are reproduced in order; every Seam, Ruling-cited, Property and Verdict cell compared cell-for-cell. Only three differences, none of them a lost property or an altered verdict: `worker-pool.ts:64-65` → `worker-pool.ts`, `build-gateway.ts:731` → `build-gateway.ts`, `store-core.ts:1006` dropped (stale-prone line numbers), and the self-reference `docs/decisions.md § Performance` rendered as the in-doc anchor.
- The three answers are recorded as decisions, not proposals: `SB-payload` "**The SSE `change` frame carries the projected batch and the client applies it**" (OQ5), `SB-text` "**Deferred text is a per-entity declared ceiling, and text rides in full**" (OQ7), `SB-reuse` "**A handler worker is a reused thread that gets a fresh realm per run**" (OQ2). No "proposed" / "to be decided" survives in any of the eight decided rows. `SB-instrument` records F1 absorbed into #927's trace and F2/F4 closed. `SB-loader` is "**Open.**" with verdict "Undecided." and names the spike — no row decides it.
- Every ruling names its landing wave, and the section preamble states that the code has not moved. Wave assignments check out against #922's execution plan: 0b → wave 1, B3 → wave 2, A1/C2 → wave 3, C6/E7 → wave 4.
- Code facts asserted by the new rulings verified against the tree: `CONSTRAINED_WORKER_POOL_SIZE = 1` (`packages/server/src/engine/handlers/worker-pool.ts:65`), `workerPoolSize: 0` on the `conserve` preset (`packages/server/src/serve/hardware-profile.ts:84`), the boot override (`packages/server/src/serve/build-gateway.ts:732`), `journal_mode=DELETE` + the second op-sqlite reader handle (`packages/client/src/replica/store-core.ts:297,1006`, `apps/mobile/src/lib/replica/op-sqlite-driver.ts:20`).
- Superseded pointers: six rows, each naming #922 and its `SB-*` replacement. Three name an origin issue (#873/#883, #599, #528, #404); the doorbell feed and the replica's `synchronous=FULL` have no origin ruling to name — confirmed, the replica pragma is code-only with no decision entry. Only the Tally row links the `#snappier-blueprint-apps-922` anchor, which matches the table's existing mixed convention and `internal-doc-links` passes.
- Placement: the new section sits immediately before `## Related docs`; `## One authority plane (#928)` is absent from `origin/main`, as the receipt's `## Decisions` states.

Gates run:

- `bun run format` → clean; `git status --porcelain` and `git diff --stat` empty afterwards.
- root `bun run lint` (oxlint, `--deny-warnings`) → pass.
- `bash .governance/run.sh` → 20 pass, 2 fail: `receipt-per-issue` (this `## Audit` missing, fixed by this commit) and `repo-hygiene` (`packages/blueprints/apps/locker/queries.test.ts` 638 > 625 lines — known pre-existing, #930). `internal-doc-links`, `doc-integrity`, `required-docs`, `format-check`, `lint-check` all pass, so every new anchor and link resolves.
- `bun run lint:product` → 37/39; the two reds are `test:ratchet` and `lint:ledgers`, both "unknown predecessor schema-migration-corpus" — known pre-existing (#930), and this diff touches no ledger.
- No package suite or typecheck lane run: the diff contains no `packages/**` or `apps/**` file.

Falsification attempts:

- "The register is reproduced in full with no altered verdict." Attacked by machine diff of all 18 rows × 4 cells against the issue body pulled fresh from GitHub. It held.
- "Nothing claims code has landed." Attacked by checking each ruling's asserted present-tense code state against the tree. It broke on `SB-tally`'s "both seats already import" (finding 1) and on `SB-replica-sync`'s separate-outbox premise (finding 2).

## Session

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-09-03 | claude-code | 60f9e86b-149f-5fc9-84c0-f2160b6b6f3c |
