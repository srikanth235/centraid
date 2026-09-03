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
- [ ] Bootstrap statements per row ≤ 3 with a driver statement cache; the wasm replica store runs `synchronous=NORMAL` on web and desktop (the outbox is IndexedDB, outside the pragma); on mobile the replica stays `FULL` unless B4's phone fsync-per-offline-intent number justifies WAL + `NORMAL` with `FULL`-bracketed outbox transactions (the `journal_mode=DELETE` second-reader seam re-judged first; a separate outbox file only if that seam proves real), with a power-loss case proving no acknowledged outbox write is lost; before/after cold-bootstrap time in the receipt (amended 2026-09-03 per SB-replica-sync)
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

   Either way C2 lands a power-loss case in the convergence suite proving no acknowledged outbox write is lost and a corrupted replica file re-bootstraps. The property is unchanged throughout: **a member's write is fsynced before the enqueue returns; replica page applies are not.** The superseded-pointer row for the replica's `synchronous=FULL` is updated to the same per-seat wording so the two entries cannot disagree. Both audit blocks are left untouched, including the passage in the second one that verified the now-superseded bracket against the code — it is the record of what was checked at that SHA. **The root amended #922's Part C acceptance box on GitHub to the same per-seat wording, and this receipt's `## Checklist` mirrors the amended box verbatim**, so the issue and `SB-replica-sync` cannot disagree; the box stays unticked, as no code has moved.

## Audit

Verdict: PASS

Re-verified at head `8e9156571` (second pass). Both first-pass findings are fixed at the four sites each touched; the register is untouched; all gates re-run. One risk raised below for the root, not a finding.

2026-09-03 — Amendment at `0a5e5b8ce` re-checked: the risk raised below is answered by a file split rather than the pragma bracket, and the verdict stands. `SB-replica-sync` and the note under the register now both rule that the mobile intent outbox moves to its own SQLite file on its own connection at `synchronous=FULL` while the replica stays `journal_mode=DELETE` at `NORMAL`, a corrupted replica file being detected on open and re-bootstrapped rather than repaired, landed by wave 3 (C2) with a power-loss case in the convergence suite; the bracket mechanism is gone from the docs entirely (`grep -n bracket docs/decisions.md docs/mobile-offline.md` → no hit) and survives only in this receipt as the record of what superseded it. The cited code facts are right: `apps/mobile/src/lib/replica/sqlite-intent-store.ts:68-70` is the comment placing the outbox tables inside the shared replica database, and `native-session.ts:1130` is "Store and intent outbox share ONE driver handle". The delta is exactly `+5/−4` over two files (`git diff bf0781870..0a5e5b8ce --stat`) — the `SB-replica-sync` row, the register note and three receipt lines; no register row, no other ruling and no other doc moved. Gates: `bun run format` clean (empty `git status --porcelain`), `bash .governance/run.sh` → `internal-doc-links` and `doc-integrity` green, 21 pass with only the known pre-existing `repo-hygiene` red (#930).

2026-09-03 — Final form at `d062448aa` re-checked; the verdict stands. All three sites now say the same thing and none contradicts another: the `SB-replica-sync` row, the note under the register, and the `synchronous=FULL` superseded-pointer row each rule **web/desktop wasm store `NORMAL` unconditionally in wave 3 (C2)** with its outbox in IndexedDB and outside the pragma, and **mobile staying `FULL` today**, any change gated on B4's fsync-per-offline-intent measurement on a phone; WAL + `NORMAL` with `FULL`-bracketed outbox transactions is named as the preferred mechanism, conditional on re-judging the `store-core.ts:1006` `journal_mode=DELETE` second-reader seam as a citation rather than a property (C2's first task), with the file split as the fallback only if that dependency proves real, and a power-loss case in C2 either way. The WAL reasoning is sound — under WAL, `NORMAL` can lose the last commits but cannot corrupt, which is what makes the bracket work there and did not under the rollback journal. Residue greps are clean: `on every seat` and `outbox stays FULL` no longer occur anywhere in the ruling — the only hits are pre-existing unrelated rows (`docs/decisions.md:230,411`), this receipt's verbatim `## Checklist` copy of #922's acceptance text, and the historical audit/fix passages that quote the superseded wording; `same connection` has no hit in `docs/decisions.md`. Delta is `+9/−5` over two files, touching only the pointer row, the `SB-replica-sync` row, the register note and two receipt hunks — no register row and no other ruling moved. Gates: `bun run format` clean (empty `git status --porcelain`), `bash .governance/run.sh` → `internal-doc-links` and `doc-integrity` green, 21 pass with only the known pre-existing `repo-hygiene` red (#930). One upstream follow-up for the root, not a defect here: #922's own Part C acceptance box still reads "the replica store runs `synchronous=NORMAL` on every seat with the outbox at FULL", which the final ruling supersedes for mobile — the receipt's checklist must stay a verbatim mirror, so the issue text is what needs the amendment.

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

## w1 Metro-loader spike — ADOPT

Wave-1 ruling (i): **can the phone run the SAME blueprint query handler web runs
(`packages/blueprints/apps/<app>/queries/*.ts`, executed on web by `runInlineQuery` over
the replica session) over the native replica session, loaded by Metro?**

**It can, and no bundler change is needed.** The root ruled **ADOPT**, with two
preconditions this slice's evidence produced: (a) ONE ctx builder, shared through a
DOM-free `@centraid/client` export subpath that the React Native seat consumes from
`src`, with `apps/mobile/src/lib/replica/inline-query-ctx.native.ts` **deleted in that
same E3/E7 slice** — never two builders side by side; (b) rows handed to a handler carry
no `__centraid*` provenance keys, stripped at the adapter, because provenance is a
mounted-read-plane concern and not part of the handler contract. Both are E7's first
line. `SB-loader` is recorded by the root in `docs/decisions.md`, not here.

This slice is a **spike**: nothing in product code imports the adapter, and no projection
fork is deleted. It exists to make the ruling answerable with numbers.

#### w1(i) — the Metro-loadable `queries/*.ts` spike

A **spike**, not product wiring: it answers one question with evidence so the root can
record ruling (i). Nothing in the product imports the new adapter; E7 owns the wiring.

- `packages/blueprints/apps/inline-types.ts` — **not changed**, after being changed and
  reverted. The spike added an `InlineQueryEntry` type there (the query half of an inline
  app with no React DOM `Root`, which `InlineAppModule` satisfies structurally); every
  path under `packages/blueprints/apps/` that is not a test file counts as user-facing to
  `check:ui-receipt`, whose only exit is a screenshot emitted by a changed e2e harness. A
  types-only addition that no code imports has no screen to photograph, so the choice was
  a fabricated UI receipt, a weakened gate, or dropping the edit. Dropped — the contract
  it states is stated in prose below and E7 declares it beside the real entry file it
  actually exports, where a UI receipt is honest. The spike loses no evidence: the export,
  the parity test and the recommendation stand without it.
- `apps/mobile/src/lib/replica/inline-query-ctx.native.ts` — **new**. The `ctx` the phone
  supplies to a blueprint query handler: `vault.read`/`vault.search` over the mounted
  replica session, the shared `@centraid/core/time` engine, an `ONLINE_ONLY` guard for
  oversized/undisclosed fields, and every write or gateway-only verb rejecting. The
  `handler-contract` read-only rule is kept by construction, not by trusting the handler.
- `apps/mobile/src/lib/replica/inline-query-ctx.native.test.ts` — **new**. The
  balance-parity oracle: Tally's `packages/blueprints/apps/tally/queries/dashboard.ts` —
  the same module file the web seat imports — runs unmodified against a seeded
  node-sqlite replica through `MultiVaultReplicaReader`, and its output is compared to
  the same handler over the same rows through a plain row-array ctx.
- `apps/mobile/metro.config.js` — **unchanged, deliberately**. See the finding below: no
  resolver change is needed. `packages/blueprints/package.json` exports are **unchanged**
  too — `"./apps/tally/*": "./apps/tally/*.ts"` already resolves
  `@centraid/blueprints/apps/tally/queries/dashboard`.
- `receipts/issue-922-snappier-blueprints.md` — this file.

#### The finding that changes the question

**The issue's premise — "the only real blocker is that Metro cannot load `queries/*.ts`"
— is stale.** Metro loads them today, with no configuration change:

- `apps/mobile` already imports blueprint TypeScript sources
  (`@centraid/blueprints/apps/_shared/*`, 20+ sites under `src/kit/share`), so
  `watchFolders`, `nodeModulesPaths` and the package-exports resolver already reach
  `packages/blueprints`.
- `apps/mobile/tsconfig.json` already sets `allowImportingTsExtensions` **and** already
  includes `packages/blueprints/types/centraid.d.ts`, so the ambient `HandlerCtx` /
  `HandlerArgs` globals a handler references by bare name are in the mobile program.
- No `queries/*.ts` module in any of the eight apps imports a node builtin. Across all of
  them the only non-relative runtime imports are `@centraid/design`, `tldts` (one Locker
  module) and `@centraid/core/time` — and mobile already bundles the first and third.
- What is *actually* unloadable is `app-inline.tsx`, which pairs the queries with a React
  DOM `Root`. That is the entry problem `InlineQueryEntry` names, and it is a file, not a
  bundler limitation.

Measured, not argued: a Metro export with `queries/dashboard.ts` in the app graph
**succeeds** (below).

### Recommendation — **ADOPT**

The phone can run the same handler web runs, over the native replica session, loaded by
Metro. Adopt the loader; E7 then deletes each app's projection fork instead of maintaining
it. The blockers are real but small, and none of them is Metro.

**Blockers, and the fix for each:**

1. **One ctx builder, not two.** `packages/client/src/react/blueprints/inlineQueryCtx.ts`
   is already seat-neutral at runtime (its only runtime imports are `@centraid/core/time`
   and blueprints' `pending-overlay`; the replica imports are type-only), but
   `@centraid/client` publishes **no export subpath that reaches it**, so no seat outside
   that package can import it. Importing it by source path pulls the package's DOM
   sources into the mobile TypeScript program and fails `bun run --cwd apps/mobile
   typecheck` (measured — see Verification). *Fix:* publish it as a client subpath (or
   move it to a seat-neutral module) and **delete `inline-query-ctx.native.ts` in the same
   slice** — never keep two builders. Until then this spike's adapter is the only way the
   phone can run a handler, and it is a duplicate, which is why it must not be wired into
   product code as-is.
2. **Mounted provenance leaks into handler output.** The phone's mounted read plane
   decorates every row with `__centraidScopeId` / `__centraidScopeLabel` /
   `__centraidCanWrite` (and the plural forms); the web replica session does not. A
   handler that spreads a whole row — Tally's `recurring` does — therefore emits those
   keys on the phone. Everything derived is identical (asserted). *Fix:* E7 decides once,
   for all eight apps — the native ctx strips provenance before the handler sees it, or
   the seats expect it and the web ctx grows the same fields. The parity test pins the
   difference so the decision cannot be made by accident.
3. **`ctx.time` must be the same engine.** It already is: the adapter passes the same five
   `@centraid/core/time` functions the web builder passes, and `@centraid/core` already
   ships a `react-native` condition pointing at source. No work; named so it is not
   re-litigated.
4. **The pending-overlay carry is not in the adapter.** The web builder carries pending
   row identity across product-field projections (`carryPendingRows`). The spike adapter
   does not, because copying that logic is exactly the duplication blocker 1 forbids. It
   comes free once blocker 1 is fixed. No app can be cut over before then.
5. **Per-app ctx surface: nothing missing.** Across all eight apps the queries use
   `ctx.vault.read` (208), `search` (9), `authenticate` (5), `invoke` (4), `reveal` (3),
   `resolve` (2) and `ctx.time` (5). `resolve` (notes/`library.ts`, tasks/`board.ts`)
   already returns `{ cards: [] }` on the web inline path and does the same here.
   `authenticate` / `invoke` / `reveal` appear **only** in Locker's six sealed-half
   modules, which stay online-only by design — E7 moves Locker's list half only. So there
   is no handler that needs a `ctx` feature the native session cannot supply.
6. **Hermes.** `toSorted` is used by queries in agenda, docs, locker, notes, people and
   tasks. `apps/mobile/polyfills/array-to-sorted.js` already installs it before app code
   via `getPolyfills`, and `bun run lint:hermes-surface` — which walks the real mobile
   import graph — is green with the handler reachable. Nothing to do; recorded because
   the gate is what makes it safe to pull six more apps' queries into the bundle.
7. **Bundle weight is not a blocker but is not free.** +31,494 B (+0.39 %) of Hermes
   bytecode for one app's dashboard chain. Eight apps' full query sets will cost more;
   E8's lazy navigators and `perf:app-weight`'s tighten-only ceiling are the control.
   `tests/experience-budgets/mobile.json` must be re-measured, never widened, as apps
   cut over.
8. **No new workspace package (#801) and no `packages/blueprints` boundary change.** The
   export map already resolves `queries/*`; nothing was added.

**What ADOPT buys, in the issue's own terms:** the ~2.5k-line per-app projection fork
(`people-model.ts`, `docs-projection*.ts`, `notes-model.ts`, `timeline-model.ts`,
`useTasks`) becomes deletable app by app, the 1,000-row drift it carries goes with it,
and Tally's seven gateway RPCs and 10-minute stale clock are replaced by a local read
that runs in the low tens of milliseconds at today's ledger size (11.1 ms median at
N=40 on this host — the measured number, not a rounder claim).

**If the root refuses instead**, the alternative is the parity oracle this slice already
committed: keep the fork and hold it honest with
`apps/mobile/src/lib/replica/inline-query-ctx.native.test.ts`'s comparison against the
blueprint handler on the same rows. That is strictly worse — it pays for two derivations
forever — but it is now available either way.

### Out of scope

- No projection fork deleted; `tally-store.ts` / `tally-gateway.ts` and every product
  screen untouched (E7 owns them).
- No `docs/decisions.md` edit — the root records SB-loader from this recommendation.
- No `docs/mobile-offline.md` / `docs/blueprint-seats.md` change; no workflow changes.
- `apps/mobile/metro.config.js` and `packages/blueprints/package.json` deliberately
  unchanged: the spike established that neither needs an edit.

### Verification

Host: 4 cores / 15 GB, Node 22 (repo pins 24.4.1 — local warning only).
Volume where stated: one mounted scope, node-sqlite replica driver.

```
# Metro export — BASELINE (clean tree)
$ cd apps/mobile && bunx expo export --platform android --output-dir /tmp/mx-baseline --clear
Android Bundled 106826ms apps/mobile/index.ts (2681 modules)   exit 0
_expo/static/js/android/index-*.hbc = 8,012,753 B

# Metro export — WITH `queries/dashboard.ts` + the native adapter in the app graph
# (a temporary `spike-probe.ts` imported from index.ts, reverted after measuring;
#  metro.config.js NOT modified)
$ cd apps/mobile && bunx expo export --platform android --output-dir /tmp/mx-spike --clear
Android Bundled 143361ms apps/mobile/index.ts (2685 modules)   exit 0
_expo/static/js/android/index-*.hbc = 8,044,247 B
=> +4 modules, +31,494 B (+0.39%) of Hermes bytecode

# Handler execution over the node-sqlite driver, median of 7 runs
#   40 expenses / 160 splits / 40 payers   : 11.1 ms  (9.6,9.8,10.1,11.1,14.5,15.4,16.1)
#   2000 expenses / 8000 splits / 8000 pyrs: 188.2 ms (154.0,164.4,172.4,188.2,267.6,304.5,531.6)
# (the 2000 case is the query's own declared window; timing measured with a
#  throwaway variant of the committed test, not committed — timings are not
#  assertions. The gateway path it would replace is a tunnel RTT plus a cold
#  worker spawn per tap, which this host cannot measure: structural, per #922.)

# The stronger oracle, run once and NOT committed: the same fixture compared
# against the WEB builder itself, imported by source path.
$ bun run --cwd apps/mobile test -- src/lib/replica/inline-query-ctx.native.test.ts
  Test Files  1 passed (1)   Tests  2 passed (2)
  # `expect(native).toStrictEqual(web)` green with
  # `runInlineQuery` from packages/client/src/react/blueprints/inlineQueryCtx.ts.
$ bun run --cwd apps/mobile typecheck
  ../../packages/client/src/gateway-client-core.ts(65,40): error TS2551 ... (8 errors)
  # => the source-path import is not committable; blocker 1 above.

# Committed gates
$ bun run format                                    # 5353 files, clean
$ bun run lint                                      # green
$ bun run --cwd apps/mobile test                    # 272 files, 2357 tests passed
$ bun run --cwd apps/mobile typecheck               # green
$ bun run --cwd packages/blueprints test            # 207 files, 6588 passed | 2 expected fail
$ bun run --cwd packages/blueprints typecheck       # green
$ bun run lint:engine-conformance                   # ok
$ bun run check:reachability                        # ok (356 capabilities, 21 module globs)
$ bun run --cwd packages/blueprints test -- src/one-computation.test.ts   # 7 passed
$ bun run lint:hermes-surface
  ok — 807 modules reachable from the mobile bundle, none calling an Array method Hermes lacks
$ bun run lint:product                              # 39/39 (rebased onto origin/main
                                                    # after #930 and PR #936 merged;
                                                    # baseline is also 39/39)
$ bash .governance/run.sh                           # all 22 directives passed
                                                    # (doc-integrity green on the append)
```

### Decisions

- **`apps/mobile/metro.config.js` was not edited.** The contract expected a resolver or
  `watchFolders` change; the export proves none is needed. Editing it to satisfy the
  contract's shape would have added configuration with no property depending on it.
- **`packages/blueprints/package.json` was not edited.** `"./apps/tally/*"` already
  resolves the `queries/` subpath; adding an explicit entry would be redundant surface.
- **The parity oracle's reference side is a row-array ctx, not the web builder.** The web
  builder was used first and the assertion passed (recorded above verbatim), but
  committing that import breaks `apps/mobile typecheck`. The committed test states the
  substitution in its header rather than quietly weakening the claim.
- **Provenance is compared with `__centraid*` stripped**, and the difference is asserted
  explicitly rather than normalised away, so the E7 decision in blocker 2 is forced into
  the open.
- **The `InlineQueryEntry` type was dropped rather than shipped past `check:ui-receipt`.**
  See `#### w1(i)` above. The contract it would have stated, recorded here so E7 does not
  rediscover it: *an entry exporting `{ appId, queries: Record<string, InlineQueryModule> }`
  and nothing else — the query half of an inline app without its `Root`.* `app-inline.tsx`
  cannot be that entry, because it pairs the queries with a React DOM `Root` and a
  React Native bundle must not reach it. This is the whole "Metro cannot load" problem,
  and it is an entry-file problem, not a bundler one.
- **`apps/mobile/metro.config.js` was in the slice contract's file list and was not
  touched.** Reported to the root rather than edited: the export is the evidence that no
  resolver, `watchFolders` or exports-map change is required.

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-09-03 | claude-code | 60f9e86b-149f-5fc9-84c0-f2160b6b6f3c |

### Audit

Verdict: PASS

Fresh-context verifier (handed only the worktree, the branch, the receipt and issue
#922). Checked against `origin/main` = `e2f277da3`.

**Verified**

- Diff is exactly three files, all named in the appended section:
  `apps/mobile/src/lib/replica/inline-query-ctx.native.ts` (+238),
  `apps/mobile/src/lib/replica/inline-query-ctx.native.test.ts` (+568), this receipt
  (+234). No file outside the slice contract; `apps/mobile/metro.config.js`,
  `packages/blueprints/apps/inline-types.ts` and `packages/blueprints/package.json` are
  untouched, as the section states. No binary hunks (`git diff --numstat`), no NUL bytes
  (`grep -lP '\x00'` over the three files: no match).
- Receipt is an append: `origin/main`'s 31,677 bytes are an exact byte-prefix of the
  branch's 46,855 (`head -c 31677 … | cmp`). No `## Checklist` line is ticked — the file
  contains zero `- [x]` items, so rule 3's crosswalk has nothing to satisfy and nothing
  above the appended section is rewritten.
- Both preconditions the root attached to ADOPT are the appended section's first
  paragraph: (a) one ctx builder behind a DOM-free `@centraid/client` subpath consumed
  from `src`, with `inline-query-ctx.native.ts` deleted in the same E3/E7 slice; (b) no
  `__centraid*` provenance on rows handed to a handler, stripped at the adapter. Both are
  named as "E7's first line".
- Blocker 1's premise checked independently: `packages/client/package.json` publishes 21
  subpaths and none reaches `src/react/blueprints/inlineQueryCtx.ts`.
- No widened budget, allowlist or ratchet; no test skipped, quarantined or deleted; no
  lint/config change. `tests/experience-budgets/mobile.json` untouched.

**Falsification attempts**

1. *"The parity test runs the same `queries/dashboard.ts` the web seat imports."* Holds.
   `packages/blueprints/apps/tally/app-inline.tsx:12` imports `./queries/dashboard.ts`;
   the test imports `../../../../../packages/blueprints/apps/tally/queries/dashboard.ts`,
   which resolves to that same file — not a copy. The provenance difference is asserted
   positively (`native.recurring[0].__centraidScopeId === "personal"`), not normalised
   away. Non-vacuous: mutating the adapter's `vault.read` to drop one row
   (`result.rows.slice(1)`) turns both tests red; reverted, tree clean.
2. *"+31 KB, exit 0."* Reproduced here, not just re-read. `expo export --platform android
   --clear` on this branch: baseline 2,682 modules / 8,024,743 B `.hbc`, exit 0; with a
   throwaway `spike-probe-verify.ts` importing `@centraid/blueprints/apps/tally/queries/
   dashboard` + `runNativeInlineQuery` from `index.ts`, 2,686 modules / 8,056,801 B, exit
   0 — **+4 modules, +32,058 B (+0.399 %)** with `metro.config.js` unmodified. Absolute
   byte totals differ from the receipt's (its baseline was a different tree; main has
   advanced), the delta matches. Probe removed; tree clean.
3. Bonus: the uncommitted "8 errors" claim was reproduced exactly. A throwaway module
   importing `inlineQueryCtx.ts` by source path makes `bun run --cwd apps/mobile
   typecheck` emit 8 errors, the first being
   `packages/client/src/gateway-client-core.ts(65,40): error TS2551` — the line the
   receipt quotes.

**Gates run** (this worktree, 4 cores, Node 22 vs pinned 24)

```
bun run format:check                      # clean, 5357 files
bun run lint                              # green
bun run --cwd apps/mobile typecheck       # green
bun run --cwd apps/mobile test            # 272 files, 2357 passed
bun run --cwd packages/blueprints typecheck  # green
bun run --cwd packages/blueprints test    # 207 files, 6588 passed | 2 expected fail
bun run lint:product                      # 39/39
bash .governance/run.sh                   # 22/22 directives
```

**Noted, not blocking**

- "a local read that runs in single-digit milliseconds at today's ledger size" overstates
  this receipt's own number: the recorded N=40 median is 11.1 ms. The recommendation does
  not turn on it (the path it replaces is a tunnel RTT plus a cold worker spawn), but the
  prose should read "low tens of milliseconds".
- The N=40 / N=2000 timings carry host and volume but their harness is an uncommitted
  variant, so they are unreproducible here. The receipt says so and does not assert them;
  recorded as the limit of that evidence.
- The first full `packages/blueprints test` run exited 1 with two unhandled errors from a
  `setInterval` in `src/photos-selection-bar.test.ts` firing after teardown. A second run
  was clean (exit 0) and the file passes standalone on `origin/main` and here; the diff
  touches no blueprints source. Flake, unrelated to this slice.
- `packages/blueprints` gains 4 dynamic tests (6584 → 6588) because
  `app-manifest-reads.test.ts` and `no-inference-client.test.ts` enumerate
  `apps/mobile/src`; all four pass. Not scope creep — no blueprints file changed.
- `docs/decisions.md` still records `SB-loader` as **Open**. Correct for this slice (the
  edit is out of scope and the root's); flagged so it is not forgotten.

## 0a — no silent truncation, on any seat, at any layer

The 1,000-row default window is KEPT as a bound (#262); what is deleted is its silence. Every clause of the acceptance criterion holds: No read on any seat truncates silently: the replica read plan and the gateway read report `truncated` when the default cap fills, undeclared unbounded reads are refused at the kit boundary, and the honesty grammar renders the truncation (test per layer).

The mechanism is one probe row. Both engines now fetch `limit + 1` and drop the extra before answering. A row count alone cannot tell a window that FILLED apart from a set that merely ends there, so a `rows.length === limit` test would announce "there is more" to a member whose library is exactly 1,000 rows — an over-report is as dishonest as a missing one. The probe answers exactly, and costs exactly one row per read.

*The replica layer*

- `packages/client/src/replica/read-plan.ts` — `ReplicaReadPlan` gains `limit` (the window applied) and `limitDefaulted` (whether it came from `REPLICA_DEFAULT_LOCAL_ROWS` or the request); `plannedLimit` returns both; the statement binds `limit + 1`. New exports: `trimReplicaPage(rows, plan)` → `{ rows, truncated }`, the one place the probe is dropped; `UnboundedReplicaReadError` (`code: "UNBOUNDED_READ"`, carrying `entity`); and `assertBoundedReplicaRead(request)`, the one boundary rule both seats call so neither can drift. The bound's VALUE is unchanged.
- `packages/client/src/replica/types.ts` — `ReplicaReadRequest` gains `acceptTruncation?: boolean`. New `ReplicaTruncation` (`truncated?`, `appliedLimit?`), extended by `ReplicaReadWireResult` and `ReplicaReadResult`. Additive and absent when nothing was cut off.
- `packages/client/src/replica/store-core.ts` — `read()` routes the planned rows through `trimReplicaPage` and reports `truncated`/`appliedLimit`. (Two lines plus the trim; the read function only.)
- `packages/client/src/replica/worker-client.ts` — the guarded `read()` carries `truncated`/`appliedLimit` across the worker hop, so the shell sees what the worker saw.
- `apps/mobile/src/lib/replica/multi-vault-reader.ts` — `runPlan` returns a `ReplicaPage` instead of raw rows; the mounted read reports `truncated` when the statement's window filled OR when dedupe/badge composition left more rows than the caller asked for.

*The gateway layer*

- `packages/vault/src/gateway/types.ts` — `GATEWAY_DEFAULT_READ_ROWS` (1000) and `GATEWAY_MAX_READ_ROWS` (10_000) replace the two inline literals; `ReadRequest` accepts `acceptTruncation` so ONE query module can be handed to both the gateway and the replica; `ReadResult` gains `truncated?`/`appliedLimit?`.
- `packages/vault/src/gateway/gateway.ts` — `read()` only: the clamp reads the two named constants, the statement selects `LIMIT ${limit + 1}`, the probe is sliced off, and the result carries `truncated`/`appliedLimit`. The access receipt's `rowCount` still counts the rows the caller got, never the probe. Nothing else in the file is restructured.

*The kit boundary — a refusal, on both seats*

- `packages/client/src/react/blueprints/inlineQueryCtx.ts` — `ctx.vault.read` (which is what every web `queries/*.ts` and therefore `window.centraid.read` reaches the replica through) calls `assertBoundedReplicaRead` BEFORE the read, so a silently capped page never exists, and posts the truncation line when one comes back.
- `packages/client/src/react/blueprints/centraid-inline.ts` — `UNBOUNDED_READ` is deliberately kept out of `FALLBACK_CODES`: falling back online would answer the refused read from the gateway, capped at the same 1,000 rows and just as silently. Documented at the set.
- `apps/mobile/src/kit/hooks/useReplicaQuery.ts` — the same rule on the phone. The refusal is STATE (`error`), not a throw: every consumer already renders `error`, while an exception would blank the screen instead of naming the entity and the fix. A truncated answer posts the line and is exposed structurally.
- `apps/mobile/src/kit/hooks/replica-query-state.ts` — `ReplicaQueryState` gains `truncated`, `appliedLimit`, `truncationNotice`; `combineReplicaQueryStates` folds them conservatively (one truncated part truncates the composed screen; the notice shown names the smallest window in play).

*The honesty grammar — one phrase, both seats*

- `packages/blueprints/apps/_shared/shared-copy.ts` — `truncatedListNotice(appliedLimit)` → `Showing the newest 1,000; more not loaded`. One clause, matching the StatusLine budget in DESIGN.md § Copy and the register of the neighbouring `replicaCoverageRow` line; no banned filler, no reassurance, no action (there is nothing to tap). It lands on the one feedback channel (`@centraid/client/status-channel`), which is the single surface both the phone's `StatusLine.tsx` and the shell's render — so no per-app screen was touched.
- `packages/blueprints/types/centraid.d.ts` — `VaultReadRequest` gains `acceptTruncation`, `VaultReadResult` gains `truncated`/`appliedLimit`, so the shared handler contract types the flag on both hosts.

*Making the existing debt greppable instead of invisible*

`acceptTruncation: true` was added to every call site that is unbounded TODAY, and to nothing else, so no shipped screen changes behaviour in this slice. 223 flag additions across production files: 138 `ctx.vault.read` sites in 32 web query files (people 43, agenda 18, photos 16, notes 16, docs 16, tasks 12, locker 10, tally 7) and 85 `useReplicaQuery` sites in 22 mobile files. That list is E2's work order.

*Keeping the existing gate sighted*

`tests/quality/user-facing-qualities.test.ts` — `acceptTruncation` is added to `REPLICA_REQUEST_KEYS`. The P3 walk skips any object whose top-level keys are not all request vocabulary; without this entry a request carrying the flag would stop looking like a request and the gate would go blind on exactly the reads the flag marks as debt. The gate's strictness is unchanged: `acceptTruncation` does not make a read bounded, and all five existing waivers in `tests/quality/unbounded-query-waivers.json` still match.

*Tests, one per layer*

- `packages/client/src/replica/read-plan-truncation.test.ts` — default cap fills → `truncated` with the applied limit; under cap → absent; a set of EXACTLY the cap → absent (the over-report case); an explicit window that fills → that window; the plan binds `limit + 1` and names its own window; and the boundary rule refuses / admits.
- `packages/vault/src/gateway/read-truncation.test.ts` — the same three cases at the gateway, plus the receipt's `rowCount` excluding the probe.
- `packages/client/src/react/blueprints/inline-read-truncation.test.ts` — the web seat: unbounded → typed refusal before the session is touched, naming the entity and both fixes; `acceptTruncation` → allowed and the truncation spoken; `limit` → allowed; a clean read stays quiet.
- `apps/mobile/src/kit/hooks/useReplicaQuery.truncation.test.tsx` — the phone seat, the same three cases through the real hook, plus a RENDERING test that mounts the phone's `StatusLine` and asserts the phrase on screen.
- `packages/client/src/replica/read-plan-parity.test.ts` — the two sabotage runs now trim the probe with `trimReplicaPage` so they still judge the page a caller would see; parity itself is untouched and green.
- `apps/mobile/src/screens/home/home-tile-reads.test.ts` — the "nothing is fetched only to be discarded" assertions now read `limit + 1` and say why: exactly one probe row, and no more.
- `packages/client/src/react/blueprints/inlineQueryCtx.test.ts` and `centraid-inline-scopes.test.ts` — their in-test query stubs declare the flag, because the boundary they exercise is now real.
- `apps/web/tests/e2e/tasks.spec.ts` — ONE added `test()`: 21 open tasks written through the app's own rail, the real `board` query asked for a window of 20 through `window.centraid.read`, the phrase read off the frame's status line, and the `artifacts/e2e/ui-impact/issue-922-web-truncation-status.png` frame emitted. It runs in CI like every other case in the file; nothing is skipped.
- `apps/web/tests/e2e/playwright.config.ts` — an optional `CENTRAID_E2E_CHROMIUM` executable-path override under `use.launchOptions`. Unset, which is the case in CI where the workflow installs the matching browser, it changes nothing; set, it lets a dev container whose Chromium build number differs from the pinned Playwright's actually launch one. This is the same fix shape [#931](https://github.com/srikanth235/centraid/issues/931) item 3 needs, kept minimal here so that issue can adopt it rather than invent a second one. The file is not in `toolchain-config-protection`'s pattern list, but the commit carries the `allow-toolchain-config` line anyway so the change is greppable with every other toolchain edit.

*Docs*

- `docs/mobile-offline.md` — the bound and the honesty rule as current state: the probe row and its one-row cost, `truncated`/`appliedLimit`, why truncation is not `coverage`, the phrase, and the kit refusal with its no-online-fallback rule.
- `apps/web/tests/e2e/playwright.config.ts`
- `apps/web/tests/e2e/tasks.spec.ts`
- `docs/protocol.md` — `truncated`, `appliedLimit` and `acceptTruncation` recorded beside `coverage` in the replica-specific additive fields. All three are optional additive fields an older reader ignores, so the protocol version does not bump.

### Numbers

0a's "before" is the count of reads that were silently capped and are now explicit. Provenance: static scan of the worktree at this commit (a paren-balanced walk of each `ctx.vault.read(` / `useReplicaQuery(` argument, `limit:` absent), cross-checked against the applied diff.

| Seat | Call sites | Previously silently capped (now explicit) |
| --- | --- | --- |
| Web `packages/blueprints/apps/*/queries/*.ts` | 208 `ctx.vault.read` | **138** — people 43, agenda 18, photos 16, notes 16, docs 16, tasks 12, locker 10, tally 7 |
| Phone `apps/mobile/src/**` | 122 `useReplicaQuery` | **85** — photos 40 across 14 screens, people 21, notes 8, docs 6, `screens/Scan` 5, `screens/Capture` 3, agenda 1, tasks 1 |

The 14 remaining phone sites that the syntactic scan flags are false positives, verified by hand: the hook's own definition, and Home's thirteen tile reads, whose request constants in `home-tile-reads.ts` already declare a `limit` the scan cannot see through the indirection.

The cost bought: **+1 row fetched per read**, at every layer, forever. Measured structurally, not by clock: `home-tile-reads.test.ts` asserts each tile's statement returns exactly `limit + 1` rows and one `LIMIT ?`, so the over-fetch is bounded at one and pinned by a test rather than by review. No hot-path timing changed hands in this slice; there is nothing here for #927's ledger to hold yet.

### Out of scope for 0a

- 0b (deferred text) — `packages/vault/src/replica/snapshot.ts`, `replica-shape.ts` and the `oversizedFields` path are its slice, not this one.
- E2 (a declared window per hook) — this slice makes the debt explicit and counts it; it does not window anything. The 223 flagged sites above are E2's work order.
- E6 (virtualisation) — the truncation line is on the shared status channel today because that is the one surface both seats already render, with no per-app screen touched. **The persistent per-list placement is E6's**, on its list primitive; the root ruled that split, and `ReplicaQueryState.truncationNotice` is already there for it to render.
- **The phone's direct-`session.read` bypass is E2's.** The refusal lives in `useReplicaQuery`, so a screen calling `session.read` straight through `multi-vault-session.read` (`apps/mobile/src/lib/replica/native-session.ts`) is not refused. One such caller exists today — `apps/mobile/src/apps/photos/timeline-engine.ts`, already bounded at 100,000 — so nothing is unbounded through it now. Moving the guard down to the session is routed to E2's contract.
- The gateway's other functions; `gateway.ts` is touched only inside `read()`'s clamp and result shaping, because another slice instruments that file next.
- `coverage` semantics beyond surfacing truncation beside them; the two stay distinct facts.
- Any change to the bound's VALUE, on either layer.

### Decisions

- **The probe row rather than a full-page test.** `rows.length === limit` needs no SQL change but lies on a set of exactly `limit` rows, and "showing the newest 1,000 of more" when there is no more is the same class of wrong screen 0a exists to delete. `limit + 1` is exact. The cost is one row per read, bounded by a test.
- **Refusal is state on the phone, a throw on the web.** The two seats differ because their consumers do: `useReplicaQuery` already surfaces `error` and a throw inside a hook blanks the screen; a blueprint query's caller already catches, and a rejected promise is what carries the code. The RULE is one function (`assertBoundedReplicaRead`) so the two cannot drift.
- **`UNBOUNDED_READ` does not fall back online.** Every other replica refusal code does, because the gateway can genuinely answer it. This one it cannot: the gateway applies the same 1,000-row default, so falling back would answer the refused read just as silently, over the network. It is a bug in the calling query and reaches the app.
- **Two files were touched outside the slice contract's globs, and one gate.** The contract's globs cover `packages/client/src/replica/**` and `apps/mobile/src/lib/replica/**`, so `store-core.ts`, `worker-client.ts`, `search.ts`, `multi-vault-reader.ts` and `multi-vault-session.ts` are all INSIDE it — an earlier draft of this bullet counted them as outside and over-reported. Genuinely outside: `packages/blueprints/types/centraid.d.ts`, the shared handler contract the 138 web flag additions must typecheck against, and `tests/quality/user-facing-qualities.test.ts`, the gate covered in its own bullet below. `apps/web/tests/e2e/tasks.spec.ts` and `playwright.config.ts` were added on the root's instruction, not on this slice's own initiative. All reported rather than left silent.
- **One gate edit, which tightens nothing and loosens nothing.** `REPLICA_REQUEST_KEYS` gains `acceptTruncation`. Without it the P3 unbounded-read walk stops recognising a flagged request as a request and skips it — the gate would go blind on the reads the flag marks. `acceptTruncation` still does not count as a bound, and the waiver file is unchanged.
- **No "deliberate" seam kept.** The one ruling this slice re-judged is the register's `1,000-row silent default cap, both layers`. Bounding keeps a named property — a phone's frame budget and the mounted reader's page cost both depend on it, and `home-tile-reads.test.ts` pins that dependence. Silence had no dependent and is deleted.

### Verification

Run from the worktree root, serially, on this branch rebased onto `origin/main` at [#930](https://github.com/srikanth235/centraid/issues/930) + the wave-1 rulings commit.

```sh
bun run format
bun run lint
bun run --cwd packages/client test        # 266 files, 2432 tests
bun run --cwd packages/client typecheck
bun run --cwd packages/vault test         # 201 files, 1576 tests
bun run --cwd packages/vault typecheck
bun run --cwd packages/vault build
bun run --cwd packages/blueprints test    # 207 files, 6588 tests
bun run --cwd packages/blueprints typecheck
bun run --cwd apps/mobile test            # 272 files, 2359 tests
bun run --cwd apps/mobile typecheck
bun run build
bun run test:qualities                    # 10 files, 60 tests (U-ratchets, P3 unbounded-read gate)
bun run check:push
bun run check:ui-receipt

# the web e2e case, with the local browser fallback this slice added
CENTRAID_E2E_CHROMIUM=/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell \
  bun run --cwd apps/web e2e -- tasks.spec.ts   # 2 passed (57.6s); the new case 33.4s
bun run --cwd apps/web typecheck
```

**Demonstrated red.** The web case was run against a seeded defect before it was trusted: `trimReplicaPage`'s verdict was forced to `false` (`rows.length > plan.limit && plan.limit < 0`), `packages/client` and `apps/web` rebuilt so the browser actually served it, and the case failed on the missing line while the neighbouring board journey stayed green — so it is the phrase it fails on, not the app. Restored, rebuilt, green again at the counts above.

`bash .governance/run.sh` passes all 22 directives; `bun run lint:product` passes **39/39** product gates in 3.1 s, `check:ui-receipt` and `lint:ledgers` / `test:ratchet` included. Before the rebase those three were red — the first because this slice had no screenshot yet, the other two because #930's ledger fix had not landed; the first is fixed here, the other two by #930.

`design:gallery` is the one gate still red on this host, and it is environmental: the pinned Playwright looks for a Chromium build number that is not the one installed (`Executable doesn't exist at /opt/pw-browsers/chromium_headless_shell-1234/...`, while `chromium_headless_shell-1194` is present). It fails the same way on a clean `origin/main` checkout. The `CENTRAID_E2E_CHROMIUM` override this slice adds is the fix shape for it; wiring the gallery lane through the same override is [#931](https://github.com/srikanth235/centraid/issues/931) item 3's, not this slice's.

An earlier `check:push` run showed timeouts in `apps/mobile`'s RNTL tier, three `packages/vault` suites and `tests/quality/kill-mid-write.integration.test.ts`. All were 30–70 s host-contention timeouts, not assertion failures, from two gate runs racing on a 4-core host; every one of those suites is green on a serial re-run (counts above).

The four new suites, named per layer:

```sh
bun run --cwd packages/client test -- read-plan-truncation
bun run --cwd packages/vault test -- read-truncation
bun run --cwd packages/client test -- inline-read-truncation
bun run --cwd apps/mobile test -- useReplicaQuery.truncation
```

The before-number is reproducible as a static scan:

```sh
# call sites whose request object declares no `limit:`
grep -ro "acceptTruncation: true" packages/blueprints/apps/*/queries/*.ts | wc -l   # 138
grep -rlo "acceptTruncation: true" apps/mobile/src --include=*.ts --include=*.tsx \
  | grep -v "\.test\." | xargs grep -o "acceptTruncation: true" | wc -l           # 85
```

Files changed in this slice:

- `apps/mobile/src/apps/agenda/useAgenda.ts`
- `apps/mobile/src/apps/docs/useDocs.ts`
- `apps/mobile/src/apps/docs/useVersionChain.ts`
- `apps/mobile/src/apps/notes/useNotes.ts`
- `apps/mobile/src/apps/people/usePeople.ts`
- `apps/mobile/src/apps/photos/AlbumDetail.tsx`
- `apps/mobile/src/apps/photos/FaceReview.tsx`
- `apps/mobile/src/apps/photos/MemoriesView.tsx`
- `apps/mobile/src/apps/photos/PhotoLightbox.tsx`
- `apps/mobile/src/apps/photos/PhotoPicker.tsx`
- `apps/mobile/src/apps/photos/PhotoStateView.tsx`
- `apps/mobile/src/apps/photos/PhotosCollectionsView.tsx`
- `apps/mobile/src/apps/photos/PhotosHome.tsx`
- `apps/mobile/src/apps/photos/PhotosLibrary.tsx`
- `apps/mobile/src/apps/photos/PhotosPeopleView.tsx`
- `apps/mobile/src/apps/photos/PhotosSearch.tsx`
- `apps/mobile/src/apps/photos/PlaceDetail.tsx`
- `apps/mobile/src/apps/photos/PlacesMap.tsx`
- `apps/mobile/src/apps/photos/PlacesView.tsx`
- `apps/mobile/src/apps/tasks/useTasks.ts`
- `apps/mobile/src/kit/hooks/replica-query-state.ts`
- `apps/mobile/src/kit/hooks/useReplicaQuery.truncation.test.tsx`
- `apps/mobile/src/kit/hooks/useReplicaQuery.ts`
- `apps/mobile/src/lib/replica/multi-vault-reader.ts`
- `apps/mobile/src/screens/Capture.tsx`
- `apps/mobile/src/screens/Scan.tsx`
- `apps/mobile/src/screens/home/home-tile-reads.test.ts`
- `docs/mobile-offline.md`
- `docs/protocol.md`
- `packages/blueprints/apps/_shared/shared-copy.ts`
- `packages/blueprints/apps/agenda/queries/day-context.ts`
- `packages/blueprints/apps/agenda/queries/parties.ts`
- `packages/blueprints/apps/agenda/queries/search.ts`
- `packages/blueprints/apps/agenda/queries/upcoming.ts`
- `packages/blueprints/apps/docs/queries/_shared.ts`
- `packages/blueprints/apps/docs/queries/activity.ts`
- `packages/blueprints/apps/docs/queries/drive.ts`
- `packages/blueprints/apps/docs/queries/history.ts`
- `packages/blueprints/apps/docs/queries/search.ts`
- `packages/blueprints/apps/locker/queries/item-sidecars.ts`
- `packages/blueprints/apps/locker/queries/item.ts`
- `packages/blueprints/apps/locker/queries/items.ts`
- `packages/blueprints/apps/notes/queries/history.ts`
- `packages/blueprints/apps/notes/queries/library.ts`
- `packages/blueprints/apps/notes/queries/search.ts`
- `packages/blueprints/apps/people/queries/dashboard.ts`
- `packages/blueprints/apps/people/queries/journal.ts`
- `packages/blueprints/apps/people/queries/people.ts`
- `packages/blueprints/apps/people/queries/person.ts`
- `packages/blueprints/apps/people/queries/search.ts`
- `packages/blueprints/apps/people/queries/trash.ts`
- `packages/blueprints/apps/photos/queries/_shared.ts`
- `packages/blueprints/apps/photos/queries/duplicates.ts`
- `packages/blueprints/apps/photos/queries/enrichment-status.ts`
- `packages/blueprints/apps/photos/queries/face-queue.ts`
- `packages/blueprints/apps/photos/queries/library.ts`
- `packages/blueprints/apps/photos/queries/people.ts`
- `packages/blueprints/apps/photos/queries/search.ts`
- `packages/blueprints/apps/photos/queries/storage.ts`
- `packages/blueprints/apps/tally/queries/dashboard.ts`
- `packages/blueprints/apps/tasks/queries/board.ts`
- `packages/blueprints/apps/tasks/queries/search.ts`
- `packages/blueprints/types/centraid.d.ts`
- `packages/client/src/react/blueprints/centraid-inline-scopes.test.ts`
- `packages/client/src/react/blueprints/centraid-inline.ts`
- `packages/client/src/react/blueprints/inline-read-truncation.test.ts`
- `packages/client/src/react/blueprints/inlineQueryCtx.test.ts`
- `packages/client/src/react/blueprints/inlineQueryCtx.ts`
- `packages/client/src/replica/read-plan-parity.test.ts`
- `packages/client/src/replica/read-plan-truncation.test.ts`
- `packages/client/src/replica/read-plan.ts`
- `packages/client/src/replica/store-core.ts`
- `packages/client/src/replica/types.ts`
- `packages/client/src/replica/worker-client.ts`
- `packages/vault/src/gateway/gateway.ts`
- `packages/vault/src/gateway/read-truncation.test.ts`
- `packages/vault/src/gateway/types.ts`
- `tests/quality/user-facing-qualities.test.ts`

### Audit

Verdict: PASS

Adjudicated by a fresh-context verifier sub-agent against the worktree at `f77acd1f5`, handed only the diff, the receipt and the issue.

**Diff ↔ receipt.** `git diff origin/main...HEAD --stat` is 81 files; every non-receipt path appears verbatim in the appended section's file list (checked mechanically, path-by-path). Nothing in the diff is undescribed and nothing described is absent. `git diff --numstat origin/main...HEAD` shows no binary (`- -`) rows. `origin/main`'s copy of this receipt is a byte-exact prefix of the branch's copy (31,677 bytes, `cmp`), so the append rewrote nothing above it.

**Acceptance criterion, clause by clause (issue #922 Part 0 box 1).**
- *Replica read plan reports `truncated` when the default cap fills* — `read-plan.ts` binds `limit + 1`; `trimReplicaPage` is the only place the probe is dropped; both consumers (`store-core.ts`, `multi-vault-reader.ts`) route through it. `read-plan-truncation.test.ts` drives a real `ReplicaSqliteStore` over real SQLite for all three cases, including the exactly-at-cap case that a naive `rows.length === limit` would over-report.
- *Gateway read reports `truncated`* — `gateway.ts` `read()` selects `LIMIT ${limit + 1}`, slices the probe, and the access receipt's `rowCount` counts the delivered rows only.
- *Undeclared unbounded reads are refused* — verified at RUNTIME, not only by test (see falsification 2 below).
- *Truncation is visible on the surface* — re-ran the e2e case here and re-generated `artifacts/e2e/ui-impact/issue-922-web-truncation-status.png`; the frame's status line reads `Showing the newest 20; more not loaded` under the real board query.

**Numbers re-derived independently.** A balanced-paren walk of every `ctx.vault.read(` argument across `packages/blueprints/apps/*/queries/*.ts` gives 208 call sites, 138 carrying `acceptTruncation: true`, and **0** carrying both `acceptTruncation` and a top-level `limit` — so the flag was added only where a read was unbounded. The same walk over `apps/mobile/src` non-test files gives 121 `useReplicaQuery` calls, 85 flagged, and 13 unflagged-and-unwindowed, all of which are Home's tile reads whose constants in `home-tile-reads.ts` each declare a `limit` (checked). No shipped call site can reach the refusal.

**Policy.** No budget, ratchet, allowlist or floor widened; `tests/quality/unbounded-query-waivers.json` is untouched. The one gate edit (`REPLICA_REQUEST_KEYS` gains `acceptTruncation`) can only turn `keys.every(...)` from false to true, i.e. it makes the P3 walk scan strictly more objects; `bun run test:qualities -- user-facing-qualities` is green (15 tests). The `CENTRAID_E2E_CHROMIUM` override is a spread guarded on the env var: unset — the CI case — the config is byte-identical to before. Both new "deliberate" seams (`UNBOUNDED_READ` excluded from `FALLBACK_CODES`; refusal as state on the phone, rejection on the web) name the concrete property they protect.

**Gates run here** (each package suite under the shared host lock):

```sh
bun run format:check                       # all 5357 files formatted
bun run lint                               # clean
bun run lint:product                       # 39/39 in 5.7s
bun run --cwd packages/{core,vault,client,blueprints} build
bun run --cwd packages/client typecheck    # clean
bun run --cwd packages/vault typecheck     # clean
bun run --cwd packages/blueprints typecheck
bun run --cwd packages/core typecheck
bun run --cwd apps/mobile typecheck        # clean
bun run --cwd apps/web typecheck           # clean
bun run --cwd packages/client test         # 266 files, 2432 passed
bun run --cwd packages/vault test          # 201 files, 1574 passed | 2 skipped
bun run --cwd packages/blueprints test     # 207 files, 6586 passed | 2 expected fail
bun run --cwd apps/mobile test             # 272 files, 2359 passed
bun run test:qualities -- user-facing-qualities   # 15 passed
bash .governance/run.sh                    # 22/22 directives
CENTRAID_E2E_CHROMIUM=/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell \
  bun run --cwd apps/web e2e -- tasks.spec.ts     # 2 passed (24.7s)
```

**Falsification attempts.**
1. *A read path that still caps by default without reporting it.* Grepped every default limit under `packages/client/src`, `packages/vault/src/gateway`, `apps/mobile/src/lib/replica` and the mobile hooks. Two survivors: `query.ts`'s `request.limit ?? 1000` is `evaluateReplicaRead`, which has no production caller (it is the parity oracle only); `store-core.ts`'s FTS `search` still defaults to 100 and clamps to 1,000 with no `truncated` on `ReplicaSearchWireResult` — a distinct RPC from the two the criterion names, recorded as an observation below rather than a defect in this slice. Every read path named by the criterion reports.
2. *The refusal is only a test fixture.* Built the real inline ctx (`buildInlineCtx`) over a counting session stub and issued `ctx.vault.read({ entity: "schedule.task", purpose })`. It rejected with `UnboundedReplicaReadError` / `code: "UNBOUNDED_READ"` / `entity: "schedule.task"`, naming both fixes, with **`session.read` call count 0** — the refusal precedes the read. The same ctx answered `acceptTruncation: true` and `limit: 5` normally. Enforced at runtime.

**Observations for the root (none blocking).**
- The replica FTS `search` path (`packages/client/src/replica/store-core.ts`) truncates at its own default without a `truncated` field. Outside this criterion's two named layers, but it is a read on a seat, so it should be routed to a later slice or explicitly ruled out rather than left unnamed.
- `multi-vault-reader.ts`'s truncation verdict (`page.truncated || rows.length > requested`, covering the dedupe-collapse case) is new logic with no direct test; the phone-hook suite stubs the session. The logic reads correct on both the badge-risk and dedupe-rerun branches.
- The web's online-fallback path (`gatewayRead` in `centraid-inline.ts`) does not surface a gateway `truncated` onto the status line; the signal exists at the API but has no consumer there yet.
- The demonstrated-red run for the e2e case is recorded with its seed and outcome; it was not re-executed here (it needs a source edit plus a client/web/server rebuild). The case's green run and its screenshot were reproduced.
- Bookkeeping: the Decisions bullet says "three files were touched outside the slice contract's list", but `store-core.ts` and `multi-vault-reader.ts` are both inside it, and a fourth outside file (`tests/quality/user-facing-qualities.test.ts`) is disclosed in its own bullet instead. Every outside-list edit is disclosed somewhere; only the count is off.

### Verifier follow-ups

Three gaps the fresh-context verifier found, closed in one commit on top of its audit. Nothing above this sub-heading is rewritten, the audit text included.

1. **The replica FTS `search` path had kept the silence the read path lost.** It defaulted to 100 and clamped to 1,000 with no signal at all. `packages/client/src/replica/search.ts` now names those two bounds (`REPLICA_DEFAULT_SEARCH_ROWS`, `REPLICA_MAX_SEARCH_ROWS`) beside the grammar they bound — a bound nobody can name is one nobody can report — and `store-core.search` fetches one probe past the window on the same rule as the read plan, drops it, and answers with `truncated` + `appliedLimit`. The existing `+ relevant.length` over-fetch already covers overlay-removed hits, so the probe survives a pending edit. `ReplicaSearchWireResult` / `ReplicaSearchResult` extend `ReplicaTruncation` (`searchWire` is a pass-through, so the worker hop needed nothing), `ReplicaSearchRequest` accepts `acceptTruncation`, and the mounted reader's federated FTS does the same over its ranked union. Rendered from the two places every search on each seat passes through: `inlineQueryCtx`'s `vault.search` on the web, and `MultiVaultReplicaSession.search` on the phone — one line for all three phone search screens, none of which was touched.
2. **The online-fallback path now speaks.** `gatewayRead` posts the notice when the answer carries `truncated` + `appliedLimit`. The gateway's own `read()` has reported truncation to its caller since the first commit — the caller is the query handler, which already receives it over the `vault-plane` bridge — so what was missing was only the rendering. The remaining half is the app-query response aggregating its handler's reads into that signal, which is `packages/server` work outside this slice's lanes: filed for the root rather than faked here, and the client is ready for it.
3. **The mounted reader's verdict has a direct case.** `mounted read truncation` in `multi-vault-reader.test.ts` covers both halves of `page.truncated || rows.length > requested` against real SQLite, with the short-page case beside them so a verdict that simply returned `true` fails. The second half needed a fixture no store-level test can build: `core.content_item` carries `sha256`, so its limit is never pushed into SQLite and badge composition — not the statement's probe — is what leaves more rows than the caller asked for.

Numbers for the search signal: the replica FTS default window is **100** rows (`REPLICA_DEFAULT_SEARCH_ROWS`), clamped at **1,000** (`REPLICA_MAX_SEARCH_ROWS`); the mounted federated search uses the same two. Cost, as on the read path, is **+1 row fetched per search**. Phone search call sites now covered by one render site: **3** (`NotesPowerbox.tsx`, `DocsSearchView.tsx`, `screens/home/blueprint-search.ts`), none of them edited.

Files this follow-up changed: `packages/client/src/replica/search.ts`, `packages/client/src/replica/store-core.ts`, `packages/client/src/replica/types.ts`, `packages/client/src/replica/read-plan-truncation.test.ts`, `packages/client/src/react/blueprints/inlineQueryCtx.ts`, `packages/client/src/react/blueprints/centraid-inline.ts`, `apps/mobile/src/lib/replica/multi-vault-reader.ts`, `apps/mobile/src/lib/replica/multi-vault-reader.test.ts`, `apps/mobile/src/lib/replica/multi-vault-session.ts`, `receipts/issue-922-snappier-blueprints.md`.

### Sonar duplication

SonarCloud failed the wave PR at **8.5 % duplicated new code** against a 3 % ceiling. Part of that is the Metro adapter, which its own de-duplication commit removes; this paragraph accounts for the part that is 0a's.

The cause is honest and worth stating plainly: the `core.concept` + `core.concept_scheme` pair was already copy-pasted into eight query handlers across Docs, Notes and People before this issue touched them. Adding `acceptTruncation: true` to each copy rewrote those lines, so an old duplication became *new* duplicated code — Sonar is right about the shape, and the flag is what made it visible. Two smaller repeats came with the same sweep: five whole-entity request literals restated across fourteen Photos screens, and one reader-construction block inside this slice's own new test.

Three extractions, no behaviour change anywhere — same entities, same `acceptTruncation`, same purpose, and the reads stay SEPARATE so each keeps its own truncation verdict and the honesty line still fires per read:

- `packages/blueprints/apps/_shared/taxonomy-reads.ts` — `conceptTaxonomyReads(vault, purpose)` returns the two promises unawaited, so each of the eight call sites — `docs/queries/{drive,history,search}.ts`, `notes/queries/history.ts`, `people/queries/{dashboard,people,person,search}.ts` — keeps them inside the `Promise.all` its destructuring already expects, in the same position.
- `apps/mobile/src/apps/photos/photo-entity-reads.ts` — the five request literals as module constants (`PHOTO_ENTITY_READS`), replacing 34 `useMemo(() => ({ … }), [])` hooks across 14 Photos screens whose only job was to give a constant a stable identity. A module constant is as stable as an identity gets, so `useReplicaQuery`'s effect keys on it exactly as before.
- `apps/mobile/src/lib/replica/multi-vault-reader.test.ts` — one local `mount()` helper for the mounted plane the three new truncation cases each built inline.

The two `history.ts` handlers took the pair in the opposite order (`[schemes, concepts]`); their destructuring is flipped to the helper's order rather than the helper gaining a second shape.

Measured with the same scan the root ran, over the wave diff's ADDED source lines (`git diff --unified=0 e2f277da3..HEAD`, whitespace-normalised, identical blocks of ≥ 8 lines, `.ts`/`.tsx` only):

| | added source lines | duplicated | share |
| --- | --- | --- | --- |
| before (`abdb176ab`) | 2,499 | 157 | **6.3 %** |
| after | 2,489 | 27 | **1.1 %** |

The residual 27 lines are the scan's own artifact, not an extractable block: a run of eight consecutive `acceptTruncation: true,` lines, one per read, inside three handlers whose `Promise.all` happens to open that many reads in a row (`tasks/board.ts`, `people/person.ts`, `notes/library.ts`). The reads around them are all different entities with different filters; only the flag line repeats, and a line-based scan cannot tell that apart from a copied block. Nothing to extract, and E2 deletes those lines outright when each read declares its own window.

**Second pass, against a repo-wide estimator.** The line-local scan above was too kind: Sonar scores a new line as duplicated when its block matches ANYTHING in the repo at that head, old code included. Re-measured that way — 8-line normalised windows over the added lines, each looked up in an index of every tracked `.ts`/`.tsx`/`.mjs`/`.js` file at the wave head, windows under 120 characters ignored — `fd3948e6b` reads **160 of 2,489 added lines (6.4 %)**, which tracks the 6.8 % Sonar reported. 110 of those belong to the Metro adapter (`inline-query-ctx.native.ts` 99, its test 11), which its own de-duplication commit removes. The 50 that were 0a's were both preamble, not logic:

| file | before | after | what it matched |
| --- | --- | --- | --- |
| `packages/vault/src/gateway/read-truncation.test.ts` | 31 | 0 | the nine-line import block and the `beforeEach` that bootstraps a vault, wraps it in a gateway and mints the owner credential — shared verbatim with `read-batch.test.ts:9`, `read-order.test.ts:17`, `locker-sidecar-reveal.test.ts:19` |
| `apps/mobile/src/kit/hooks/useReplicaQuery.truncation.test.tsx` | 19 | 0 | the four-factory `vi.mock` host-stub preamble every DOM-stub-tier test repeats — `DocRow.test.tsx:12`, `DocsCapabilities.test.tsx:15`, `LockerExportView.test.tsx:30`, `Automations.test.tsx:43` |
| **0a total** | **50** | **0** | |

Two more extractions, no behaviour change and no assertion touched:

- `packages/vault/src/gateway/owner-vault.test-fixtures.ts` — `openOwnerVault()` returns `{ db, gateway, boot, owner }`, the opening four gateway suites had each written out. The repo's convention for exactly this is a `*.test-fixtures.ts` module (`store-core.test-fixtures.ts`); the three older suites keep their copies, which are old code and are not this change set's to rewrite.
- The mobile test's host mocks now call one lazy `hosts()` import instead of restating four factories. `vi.mock` is hoisted, so the shared module is reached from INSIDE each factory rather than passed as one — a hoisted call cannot reference an import that has not been evaluated yet.

Residual after both passes: **110 of 2,524 added lines (4.4 %)** repo-wide, and every one of them is the Metro adapter's — `inline-query-ctx.native.ts` 99, its test 11 — which leave with that slice's own de-duplication commit. **0a's own share is 0.**

The consecutive `acceptTruncation: true,` runs the first pass counted do not register under this measure: a window of eight identical single-property lines is under the 120-character floor, which is the more Sonar-like reading — an eight-line block that carries almost no tokens is not a copied block. Nothing was extracted for them, and E2 deletes those lines outright when each read declares its own window.


### Audit — re-verification, 2026-09-03

Verdict: PASS

Scope: the three commits that landed on the wave branch after the audit above — `abdb176ab` (search + gateway-fallback signal), `fd3948e6b` (taxonomy and Photos read declarations), `4b3d64c64` (owner-vault test fixture, host-stub preamble). Same fresh-context verifier, same adversarial default. `git diff --numstat` shows no binary rows in any of the three; every changed path is named in this receipt; the file is still a byte-exact 31,677-byte prefix extension of `origin/main`'s copy.

**Follow-up 1 — search.** `store-core.search` fetches `limit + 1 + relevant.length (+1 opaque)` and answers `overlaid.length > limit`. Verified the verdict cannot over-report: the extra `relevant.length` term only ever surfaces hits that genuinely exist, so a true set of exactly `limit` fills the window without claiming more. The mounted federated search applies the same rule over its ranked union (`ranked.length > limit` after dedupe). Rendered once per seat — `inlineQueryCtx.vault.search`, `MultiVaultReplicaSession.search`.

**Follow-up 2 — gateway fallback.** `gatewayRead` posts the notice only when the answer itself carries `truncated` + a numeric `appliedLimit`. The receipt is honest that the app-query envelope does not yet aggregate its handler's reads into that signal: read the server side and confirmed there is no aggregation, so today the branch is reachable only for a handler that forwards the fields. Filed, not faked — as claimed.

**Follow-up 3 — mounted reader.** Three cases against real SQLite, including the short-page case that makes an unconditional verdict fail.

**Taxonomy extraction.** Read all eight call sites. Six spread `...conceptTaxonomyReads(ctx.vault, purpose)` into the exact positions the two inline reads occupied, in the helper's own order (`core.concept`, then `core.concept_scheme`). The two `history.ts` handlers held the pair in the opposite order and had their destructuring flipped to `[concepts, schemes]`; the positional mapping is correct in both, and downstream `findSchemeConcept(schemes, concepts, …)` still receives each entity in its own argument. Same entities, same `purpose`, same `acceptTruncation`, promises still created eagerly and still awaited inside the caller's own `Promise.all`.

**Photos constants.** `PHOTO_ENTITY_READS` is referenced 34 times across 14 screens, every one of them as a bare argument — no spread, no mutation, and no code path anywhere mutates a read request (`readMounted` copies it into `planRequest`). A module constant is stable across mounts as well as across renders, so `useReplicaQuery`'s effect and `useCallback` keys re-run no more often than the per-component `useMemo` did, and never less correctly; `coalesceWork` is created per hook instance and keys on its closure, not on the request, so sharing one object across screens cannot collide. `check:ui-receipt` passes for a structural reason, not a semantic one — the gate is satisfied by the receipt's `## User impact` + `First-run:` note + a screenshot whose emitter (`apps/web/tests/e2e/tasks.spec.ts`) is in the changed set — so it is the reading above, not that gate, that establishes the 14-file Photos touch leaves the frame unchanged.

**Test-fixture extractions (`4b3d64c64`).** `openOwnerVault()` preserves the original `ownerName = "Priya"` default and no assertion moved; the mobile host stubs now reach one lazy `hosts()` import from inside each hoisted `vi.mock` factory, which the suite proves resolves in order.

**Numbers re-derived.** Ran the receipt's own first-pass scan (`git diff --unified=0 e2f277da3..`, whitespace-normalised, identical ≥ 8-line blocks, `.ts`/`.tsx`): **157 → 27** duplicated lines and **1.1 %** after, matching exactly; the sole residual block is eight consecutive added `acceptTruncation: true,` lines occurring in `notes/library.ts`, `people/person.ts` and `tasks/board.ts` — precisely the three handlers named, and nothing extractable. A repo-wide second-pass reproduction attributes every residual duplicated line to the Metro adapter (`inline-query-ctx.native.ts` + its test) and scores both of 0a's own files at **0**, as claimed. Added-line denominators differ from the receipt's (2,388/2,375 against 2,499/2,489; 6.6 % against 6.3 % before), so the *shares* are estimator-dependent while the duplicated-line counts and the attribution are not.

**Gates run at `4b3d64c64`** (package suites under the shared host lock):

```sh
bun run format:check                       # clean, 5364 files
bun run lint                               # clean
bun run --cwd packages/client build
bun run --cwd packages/client test         # 266 files, 2436 passed (+4 search cases)
bun run --cwd packages/client typecheck
bun run --cwd packages/vault test          # 201 files, 1574 passed | 2 skipped
bun run --cwd packages/vault typecheck
bun run --cwd packages/blueprints test     # 207 files, 6594 passed | 2 expected fail
bun run --cwd packages/blueprints typecheck
bun run --cwd apps/mobile test -- useReplicaQuery multi-vault photos home-tile-reads   # 61 files, 662 passed
bun run --cwd apps/mobile typecheck
bash .governance/run.sh                    # 22/22 directives
```

`lint:product` is 36/39: `test:ratchet`, `lint:ledgers` and `lint:quality-knobs` are red. Verified as base lag rather than accepted as such — all three compare against `origin/main` (`dccf9e609`), the flow they name (`blueprint-app-entity-tripwire-law`) is present in main's `tests/floors.json` and absent from the branch's merge-base `e2f277da3`, and the branch edits none of `tests/floors.json`, `tests/claims.json` or `tests/quality/classification-ratchet.json`. They clear on the wave's rebase.

**Falsification attempts.**
1. *The search verdict is not actually discriminating.* Forced it to `true` unconditionally in a throwaway edit: `a page under the cap is not truncated` and `a set of exactly the cap fills the window without hiding a hit` both failed (`expected true to be undefined`); restored, 11/11 green. The over-report case is genuinely guarded.
2. *The mounted-reader dedupe case is really just the statement probe.* Reduced the verdict to `page.truncated` alone: the badge-composition case failed while the statement case and the short-page case stayed green. Confirmed by the plan — `core.content_item` carries `sha256`, so with two vaults `badgeRisk` is true and the plan runs at `REPLICA_MAX_LOCAL_ROWS`; the probe cannot fire on three rows, and only `rows.length > requested` can produce the verdict. Restored, 13/13 green.
3. *The two flipped `history.ts` destructurings are swapped.* No handler-level test executes either file, so the suite could not answer this. Drove both handlers directly with a stub vault whose `revises` relation resolves only when `schemes` and `concepts` arrive in their own arguments: both returned a 2-version chain. Seeding the swap into `notes/queries/history.ts` dropped it to 1 while `docs` stayed at 2, so the probe is sharp and both handlers are correct as landed. Throwaway deleted; tree clean.

**Findings for the root (none blocking).**
- `packages/blueprints/apps/_shared/taxonomy-reads.ts:4` and the `### Sonar duplication` section above ("six query handlers", "each of the six call sites") say **six**; the helper is adopted at **eight** — `docs/queries/{drive,history,search}.ts`, `notes/queries/history.ts`, `people/queries/{dashboard,people,person,search}.ts`. Fix: say eight in both the docstring and the section.
- `abdb176ab`'s waiver reason states "nothing above the new sub-heading is rewritten, the audit text included", but the `## Decisions` bullet — which is above it — was rewritten in that same commit (three files → four). The append-only property against `origin/main` still holds because the whole 0a section sits below main's copy; it is the reason line that does not describe its diff.
- That rewritten bullet now over-reports in the other direction: `packages/client/src/replica/worker-client.ts`, `packages/client/src/replica/search.ts` (both under `packages/client/src/replica/**`) and `apps/mobile/src/lib/replica/multi-vault-session.ts` (under `apps/mobile/src/lib/replica/**`) are all inside the slice contract's globs. Genuinely outside it are only `packages/blueprints/types/centraid.d.ts` and `tests/quality/user-facing-qualities.test.ts`.
- No handler-level test exercises `docs/queries/history.ts` or `notes/queries/history.ts`, so the refactor's one real risk is carried by review rather than by the suite. A single case per handler asserting a two-version chain would pin it.
- `ReplicaSearchRequest.acceptTruncation` is declared and typed but read nowhere: search is never refused, by design. Either wire a refusal or drop the field, so the type does not promise a boundary that does not exist.
- `apps/mobile/src/lib/replica/multi-vault-reader.ts:450` clamps `limit + 1 + displacing` to `MAX_SEARCH_FETCH_ROWS` (10,000). With `limit` capped at 1,000, a `displacing` of 8,999 or more swallows the probe and under-reports truncation. Unreachable in practice today; worth a comment or a floor.

### Re-verification follow-ups

The second audit passed and named five bookkeeping or coverage gaps plus one unreachable finding. All closed in one commit; the audit text above is untouched.

- **Eight, not six.** `taxonomy-reads.ts`'s docstring and the `### Sonar duplication` text said six handlers; the helper is adopted at eight — `docs/queries/{drive,history,search}.ts`, `notes/queries/history.ts`, `people/queries/{dashboard,people,person,search}.ts`. Both corrected, and the section now names all eight.
- **The outside-contract set was over-reported.** The contract's globs cover `packages/client/src/replica/**` and `apps/mobile/src/lib/replica/**`, so `worker-client.ts`, `search.ts` and `multi-vault-session.ts` are inside it, not outside. Only `packages/blueprints/types/centraid.d.ts` and the `tests/quality/user-facing-qualities.test.ts` gate are genuinely outside. The `## Decisions` bullet is corrected.
- **`ReplicaSearchRequest.acceptTruncation` is DELETED.** It was declared and read nowhere, and it could not honestly be wired: `acceptTruncation` exists so a READ that declares no window can still be admitted at the kit boundary, and a search always has one — 100 by default, 1,000 at the ceiling — so there is no undeclared case for it to admit. A field nothing reads is a promise nothing keeps. No caller passed it (the ambient `VaultSearchRequest` never carried it either), so the deletion is type-only; a comment in its place says why the asymmetry with `ReplicaReadRequest` is deliberate.
- **The flipped destructuring is pinned.** `docs/queries/history.ts` and `notes/queries/history.ts` take the pair as `[concepts, schemes]` where they used to take `[schemes, concepts]`; a swap is invisible to a typecheck because both are row arrays, and invisible to any assertion about a document or note with no prior version. `docs/queries/history.test.ts` and `notes/queries/history.test.ts` each drive the handler over a stub vault whose `revises` relation resolves ONLY when schemes and concepts land in their own arguments, and assert a 2-version chain. Both were run against a deliberately swapped destructuring first and failed on exactly that assertion, with the anti-vacuity case (no relations scheme → 1 version) staying green beside them.
- **Finding 6 recorded, no code.** `store-core.search` clamps `fetchLimit` at `MAX_SEARCH_FETCH_ROWS`, so at `displacing ≥ 8,999` pending indexed mutations on one entity the clamp could swallow the truncation probe and under-report. It is unreachable today: the clamp is 10,000, the largest window is 1,000, and the outbox would need nine thousand pending edits to the same entity's indexed columns for the sum to reach it — at which point the search already refuses with `the pending search overlay exceeds the local bounded work limit`. Noted rather than guarded, because a guard for an unreachable state is a branch no test can honestly cover.


## User impact

**One new line, and one refusal a member will never see.** Nothing a shipped screen shows changes in this slice except this: when a list is cut short by its window, the seat now says so on its one status line — `Showing the newest 1,000; more not loaded` — instead of drawing a shorter list that looks complete. That is the whole visible surface. A member with fewer than a thousand contacts, notes or photographs in any one entity sees nothing new at all, because nothing was ever hidden from them.

The case it fixes is the one the member cannot detect: a 5,000-contact roster drew 1,000 rows and said nothing, so counting the screen gave the wrong answer and searching it missed people who exist. The line does not fix the missing rows — E2 and E6 do that — but it stops the screen from lying about them, which is the part that has to land first.

The refusal is a developer-facing guard, not a member-facing state: every read that exists today declares `acceptTruncation: true`, so no shipped screen can reach it. It fires only on a read a future change adds without declaring a window, and it names the entity and both fixes.

**First-run: unchanged.** A new vault has no entity anywhere near a thousand rows, so no window fills, `truncated` is absent on every read, and no line is drawn. Day one looks exactly as it did.

**Evidence:** `artifacts/e2e/ui-impact/issue-922-web-truncation-status.png`, published by `apps/web/tests/e2e/tasks.spec.ts`. That case seeds 21 open tasks through the app's own write rail against the real harness gateway, asks the real `board` query for a window of 20 through `window.centraid.read`, and reads the phrase off the frame's one status line before capturing the frame. Twenty-one against twenty is the smallest honest way to fill a window end to end: the board clamps its open read to a floor of 20, and a thousand real writes would be a fixture this slice has no reason to add. The same phrase is asserted on the phone by `apps/mobile/src/kit/hooks/useReplicaQuery.truncation.test.tsx`, which mounts the real `StatusLine` over the render host and reads the text off it.
## w1b(i) — F3/B4: the standard-profile run and the journey benchmark

The low-end gate measured `atlas.insert` + `vault.status` under `constrained` only. The paths every blueprint app actually pays for — a replica intent, a handler worker, an SSE projection, a bootstrap page — had no instrument, and the desktop profile (`synchronous=FULL`) was never run. Both are fixed here. Nothing is gated: `low-end-budgets.json` is byte-identical, no ceiling moved in either direction.

- `packages/server/scripts/bench-support.mjs` (new) — the measurement primitives both benchmarks share: `argReader`, `percentile`/`latencySummary`, `ratePerHour`, `readProcIo`, `resourceCounters`, `directoryBytes`, `quietLogger`, `markTraceEpoch`, `fsyncCallsIn`, `straceAvailable`, `hostRecord`, and `resolvedProfileFrom` (reads the gateway's own resolved class/sync/pool out of the `hardware-profile` health component instead of re-deriving them).
- `packages/server/scripts/bench-low-end.mjs` — its eleven local copies of those helpers are **deleted** and imported; the gate's workload, epochs, budget checks and report schema are untouched (`-107` lines). Verified by re-running it: same schema, same checks, 0 failures.
- `packages/server/scripts/bench-journeys.mjs` (new, 450 lines) — seeds every bundled blueprint's demo profile plus `--fill` rows through the real write path (a direct SQLite insert skips the journal sequence the replica cursor derives from, so it cannot stand in for volume), then measures a bootstrap page, `--intents` replica intents over HTTP, handler-worker cold vs warm, and an SSE fan-out at `--subscribers 1,10,40`. Fsyncs per intent come from a second intent-only run under `strace -f` bracketed by trace-epoch markers — the same method, and now the same code, as the gate's fsync-per-write.
- `packages/server/scripts/bench-support.test.ts` (new) + `packages/server/vitest.config.ts` — the helpers' contract (flag spellings, percentile boundaries, empty-sample zeros, split-syscall counting, missing markers, profile parsing) is a test; the include list widens from the one named scripts test to `scripts/**/*.test.ts`.
- `packages/server/package.json` — `perf:journeys[:standard|:constrained]` and `perf:low-end:standard`.
- `packages/server/benchmarks/README.md` + `packages/server/benchmarks/results/issue-922-{low-end,journeys}-{standard,constrained}.json` — the four published runs and their provenance.

### Numbers

Provenance for every row: 2026-09-03, linux x64, 4 vCPU / 15 GiB shared container, Node 22.22.2, fresh auto-founded vault, gateway driven over loopback HTTP by `scripts/bench-journeys.mjs`; replica volume 2,936 rows / 1.36 MB (seven demo profiles + 2,000 filled `core.place` rows). Commands in the block below.

| Number | standard (`FULL`) | constrained (`NORMAL`) |
| --- | --: | --: |
| `atlas.insert` p50 / p99 (low-end workload, 120 writes) | 26.65 / 45.19 ms | 25.32 / 44.54 ms |
| fsync per `atlas.insert` write (strace) | 0.375 | 0 |
| bytes written per write | 105,745 | 101,820 |
| replica intent, warm p50 / p99 (19 samples) | 171.0 / 190.0 ms | 223.1 / 404.6 ms |
| first intent after boot (cold worker) | 198.1 ms | 231.3 ms |
| resolved `workerPoolSize` | 2 | 0 |
| **fsync per offline intent (strace)** | **3.05** | **0** |
| bootstrap page, 2,936 rows / 1.36 MB | 316 ms (0.108 ms/row) | 268 ms (0.091 ms/row) |
| commit → last subscriber p50, N=1 / N=10 | 168.2 / 121.6 ms | 129.3 / 133.6 ms |
| commit → last subscriber p50, N=40 (32 admitted) | 129.7 ms | 157.3 ms |
| boot `storageFsyncMs` | 0.69 ms | 0.93 ms |

`storageFsyncMs` is recorded as an **input**, not a curiosity: at 0.69–0.93 ms it is about a tenth of the 8 ms group-commit window, so on this host B7's amortisation window costs roughly ten fsyncs' worth of latency to save at most one. B4's other half — the profile's sync choice — now has its price: `FULL` costs 3.05 fsyncs per offline intent where `NORMAL` costs 0, at 171 ms vs 223 ms per intent warm (the pool, not the pragma, dominates). No window and no pragma is changed here; those are waves 2/3.

The intent path is measured **single only**. One intent per HTTP round trip is what the drain does today and the batch endpoint is wave 3 (A6); the report says so in a field rather than leaving the absence to read as a zero.

### Findings

- **An SSE fan-out of 40 is refused.** `SSE_MAX_SUBSCRIBERS = 32` (`packages/server/src/routes/sse-cap.ts`) is global to the change stream, so 8 of the golden household's 40 replicas get `503 sse_capacity` with `Retry-After: 5`. The benchmark records `admitted`/`refused`/`refusalError` rather than failing. #922's Part A acceptance criterion "projections per commit per household ≤ 1" is stated at N = 40, which this gateway cannot currently seat; the cap is owned by neither this slice nor wave 2's file list, so it is filed here for the root.
- The fan-out numbers do **not** yet show a per-subscriber projection cost (N = 10 is no slower than N = 1 at this volume). That is a measurement limit, not evidence against A2: the counter that would show it is #927's work counter on `hub.project()`, and this instrument only sees wall clock at the last subscriber.

### Verification

```sh
bun run format                                   # clean
bun run lint                                     # pass (oxlint --deny-warnings)
bun run --cwd packages/server typecheck          # pass
bun run --cwd packages/server test -- scripts/bench-support.test.ts   # 7 passed
node packages/server/scripts/bench-low-end.mjs --requests 8 --idle-ms 2000   # gate re-run after the refactor: 0 failures
cd packages/server && CENTRAID_HARDWARE_PROFILE=standard node scripts/bench-low-end.mjs --output benchmarks/results/issue-922-low-end-standard.json
cd packages/server && CENTRAID_HARDWARE_PROFILE=constrained node scripts/bench-low-end.mjs --output benchmarks/results/issue-922-low-end-constrained.json
cd packages/server && node scripts/bench-journeys.mjs --profile standard --output benchmarks/results/issue-922-journeys-standard.json
cd packages/server && node scripts/bench-journeys.mjs --profile constrained --output benchmarks/results/issue-922-journeys-constrained.json
bash .governance/run.sh
```

### Decisions

- **A second script, not a bigger gate.** Adding the journeys to `bench-low-end.mjs` would have changed the denominators its budgets are stated over (fsync *per write*), which is a budget change by accident. The two share `bench-support.mjs` instead, and the duplicated helpers are deleted rather than left beside it.
- **Volume comes from the demo seeds plus filled rows, not `@centraid/test-kit/year3-vault`.** That fixture is a TypeScript module and these are `node` `.mjs` scripts; seeding through the gateway's own write path also keeps the journal sequence the replica cursor is derived from, which a direct SQLite insert would skip. The row count and its composition are stated with every number.
- **`no-await-in-loop` disabled per line, with the reason.** Serialisation *is* the measurement: one intent per round trip, one commit per fan-out sample. Twelve `oxlint-disable-next-line` comments each name why, matching the repo's existing pattern in `peer-commons-client.ts`.

## w1 Metro-loader spike — ctx-core de-duplication

**Amends the `## w1 Metro-loader spike — ADOPT` section above, which is left byte-for-byte
as it landed.** Where that section says both ADOPT preconditions are E7's first line, read
instead: **(a) — one shared ctx builder, this spike's native adapter deleted — is DONE, in
wave 1, below. Only (b) (no `__centraid*` provenance on rows handed to a handler) remains
for E7.** This is the Metro adapter half of the duplication 0a's `### Sonar duplication`
paragraph above attributes to "the Metro adapter, which its own de-duplication commit
removes"; that commit is this one.


SonarCloud failed the wave PR's quality gate: **27.6 % duplicated lines on new code**,
ceiling 3 %. The duplicate was the spike's own second ctx builder — the very thing
precondition (a) says must go — so (a) was done here rather than deferred to E7. A bot
finding is a bug report; deletion with replacement is the fix.

**The shared module.** `packages/client/src/replica/inline-query-ctx-core.ts` (new) now
holds everything both seats had in common: `guardedRow` (the unavailable/oversized row
proxy), `receiptIdFor`, `inlineReadsFor` (the session → rows wiring), `buildInlineCtxCore`
(the verb surface: `resolve` → `{ cards: [] }`, every write and gateway-only verb an
`ONLINE_ONLY` effect), `runInlineQueryCore`, and `ctx.time`. It lives under `replica/`,
not `react/blueprints/`, and is DOM-free by construction — that is what lets it be
re-exported through `@centraid/client/replica/native` (added to `native.ts`; also to the
browser `index.ts` barrel), the subpath React Native already consumes from source. It
pulls in no `window` type, so it does not drag `gateway-client-core.ts` into a Metro
bundle — the 8-error path this receipt documented above.

**What moved, and what stayed seat-side.** The web `inlineQueryCtx.ts` and the native
adapter are now thin callers. Each keeps exactly one thing: **what one row becomes.** The
shell threads its pending-row provenance symbol onto the row and carries that identity
across product-field projections afterwards (`pendingMarker`, `carriedPendingMarker`,
`carryPendingRows` — blueprint-overlay logic with no native counterpart yet, so it stays
in `react/blueprints/`); the phone does not. Nothing else is seat-specific, and nothing is
left duplicated.

**Two further duplicates deleted while there.** (1) `ctx.time` was being assembled
identically by each seat; the core imports `@centraid/core/time` itself, so "both seats
run the same civil-time engine" is now a fact of the module graph rather than a convention
two files must keep agreeing on. (2) The spike had hand-rolled an online-only guard —
`createOnlineGuard` / `InlineOnlineGuard` / a local `OnlineOnlyError` — while
`packages/client/src/replica/online-only-guard.ts` has owned exactly that (sticky
first-reason `mark()`, `required`, `assertLocal()`, the identical message string) all
along. The hand-rolled one is deleted; both seats and `inlineQueryCtx.test.ts` now use
`OnlineOnlyGuard`. That was a **third** copy the Sonar finding surfaced, and the web
builder had been carrying it since before this slice.

**Before/after, same block scan** (python `difflib.SequenceMatcher` over the two files,
matching blocks ≥ 8 lines; `scripts` not involved — reproduced in the fenced block below):

| pair | before (`61973cef5`) | after |
| --- | --- | --- |
| native adapter ↔ web `inlineQueryCtx.ts` | 6 blocks, **93 of 238 lines (39.1 %)** | **0 blocks, 0 lines (0.0 %)** |
| native adapter ↔ shared core | — (core did not exist) | **0 blocks, 0 lines** |
| web `inlineQueryCtx.ts` ↔ shared core | — | **0 blocks, 0 lines** |

The adapter shrank 238 → 81 lines and `inlineQueryCtx.ts` 294 → 173. The six blocks the
root named (native 26-33, 70-79, 97-135, 176-192, 195-204, 228-236) are all gone: the
first is the time import, the second the guard, the third `guardedRow`, the fourth and
fifth the verb surface and ctx assembly, the sixth the runner — every one of them now
exists once, in the core.

Sonar's ratio is over *new* code and includes the new core file, which no other file
duplicates; with zero identical blocks ≥ 8 lines anywhere among the three, the measured
duplication is 0 %, against the 3 % ceiling.

```
$ python3 dupscan.py          # difflib.SequenceMatcher, blocks >= 8 lines
BEFORE (at 61973cef5):
  native vs web: native=238 lines, web=294 lines, identical blocks>=8: 6,
                 duplicated native lines: 93 (39.1% of the file)
     native 26-33 = web 3-10 (8) | 70-79 = 52-61 (10) | 97-135 = 80-118 (39)
     native 176-192 = web 249-265 (17) | 195-204 = 267-276 (10) | 228-236 = 284-292 (9)
AFTER (working tree):
  native vs web:  native=81 lines, web=173 lines, identical blocks>=8: 0, 0 lines (0.0%)
  native vs core: identical blocks>=8: 0, 0 lines (0.0%)
  web vs core:    identical blocks>=8: 0, 0 lines (0.0%)

# Gates for the engine lane this now touches (all under scratchpad/gate.lock)
$ bun run --cwd packages/client build          # tsc -p tsconfig.build.json, clean
$ bun run --cwd packages/client typecheck      # clean
$ bun run --cwd packages/client test           # 264 files, 2420 tests passed
$ bun run --cwd packages/client test -- src/react/blueprints/
                                               # 8 files, 76 passed — the importers of
                                               # inlineQueryCtx.ts, incl. its own suite
$ bun run --cwd apps/mobile test               # 272 files, 2357 tests passed
$ bun run --cwd apps/mobile typecheck          # clean
$ bun run --cwd packages/blueprints typecheck  # clean
$ bun run format / bun run lint                # clean / green
$ bash .governance/run.sh                      # all 22 directives passed
$ bun run lint:product                         # 35/39 — NONE of the four is this diff's
                                               # work except one; see below
```

**`lint:product` after this commit, honestly.** Three of the four reds —
`test:ratchet`, `lint:ledgers`, `lint:quality-knobs` — fail on the **clean tree at this
branch's base** (`git stash -u && bun run lint:product`): `origin/main` moved to
`7d47fee4c` while this was in flight and #928's `9e130654a` renamed the
`blueprint-app-entity-tripwire-law` flow, so every ledger gate reads the flow as removed
relative to this older base. They clear when the wave branch rebases onto the newer main —
the root's call, not a slice's.

The fourth, `check:ui-receipt`, **is** caused by this commit and has no honest exit:
`validate-ui-receipt.mjs` treats every path under `packages/client/` as user-facing, and
its only way to pass is a screenshot emitted by a changed e2e harness. This diff is an
internal refactor of `src/replica/` and `src/react/blueprints/` engine code with no
surface change — there is no screen to photograph, and inventing a `## User impact` and a
`First-run:` note for a no-op would be a false receipt. Not worked around, not waived:
flagged for the root. The shape of the fix, if the root wants one, is the carve-out #930
already established for `packages/blueprints/apps/**` test files (`TEST_FILE_RE` in that
script) — a non-UI exclusion for the engine paths under `packages/client/src/replica/**` —
but widening a gate is never a slice's decision, so nothing here touches it.

Files in this commit: `packages/client/src/replica/inline-query-ctx-core.ts` (new),
`packages/client/src/replica/native.ts`, `packages/client/src/replica/index.ts`,
`packages/client/src/react/blueprints/inlineQueryCtx.ts`,
`packages/client/src/react/blueprints/inlineQueryCtx.test.ts`,
`apps/mobile/src/lib/replica/inline-query-ctx.native.ts`,
`receipts/issue-922-snappier-blueprints.md`.

Deleted, with its replacement: the spike's second ctx builder (93 lines of
`inline-query-ctx.native.ts`) → `inline-query-ctx-core.ts`; the hand-rolled inline guard
(`createOnlineGuard`, `InlineOnlineGuard`, the local `OnlineOnlyError`) → the existing
`OnlineOnlyGuard`; two per-seat `ctx.time` literals → one `INLINE_CTX_TIME` in the core.

One consequence worth naming for E7: because the phone now imports the same builder the
shell does, precondition (b) has exactly one place to land — `inlineReadsFor`'s row
callback in `inline-query-ctx.native.ts` — instead of two. The parity test's provenance
assertion is unchanged and still fails the moment that strip happens, which is the signal
E7 wants.

### 0a's truncation duties on the refactored shape

This commit rebased onto 0a, which had added two duties to the very read/search closures
the refactor moved: `assertBoundedReplicaRead(request)` before a read, and
`postStatus(truncatedListNotice(...))` after a read **and** after a search. Re-applied, not
re-implemented, and not duplicated:

- **`packages/client/src/react/blueprints/inlineQueryCtx.ts` still posts the notice** — the
  web thin caller, exactly where 0a put it, because the status channel is the shell's and a
  React Native screen has no status line to post to. `assertBoundedReplicaRead` stays there
  too: its value is that the refusal names the calling query's own file in the stack, which
  a shared module cannot do.
- **The core gained the seam, not the behaviour.** `inlineReadsFor` takes an optional
  `InlineReadHooks` (`beforeRead`, `beforeSearch`, `onResult`) and `InlineWireResult` now
  declares `truncated` / `appliedLimit`, so the seat can see a cut-off page without
  unwrapping the result a second time. The phone passes no hooks — 0a's mobile half already
  bounds and reports through `useReplicaQuery` and `MultiVaultReplicaSession`.
- 0a posted the notice from two hand-written blocks (one in `read`, one in `search`). On the
  hook it is **one** `onResult`, run on both paths — the same behaviour from one site, which
  is what "never a second copy" means here.

No 0a assertion was changed. `inlineQueryCtx.test.ts` merged cleanly (0a's
`acceptTruncation` setup edits and this refactor's `OnlineOnlyGuard` construction touch
different lines). 0a's `inline-read-truncation.test.ts` needed a **setup-only** edit —
3 insertions, 2 deletions, all of it `import { buildInlineCtx, createOnlineGuard }` →
`import { buildInlineCtx }` plus `OnlineOnlyGuard` beside it, and `createOnlineGuard()` →
`new OnlineOnlyGuard()` at the one construction site. Every one of its five cases asserts
exactly what 0a wrote. `read-plan-truncation.test.ts` (11 cases) is untouched and green,
and the Metro parity test is unchanged and green.

Files this commit changed on top of 0a:
`packages/client/src/replica/inline-query-ctx-core.ts` (new),
`packages/client/src/replica/native.ts`, `packages/client/src/replica/index.ts`,
`packages/client/src/react/blueprints/inlineQueryCtx.ts`,
`packages/client/src/react/blueprints/inlineQueryCtx.test.ts`,
`packages/client/src/react/blueprints/inline-read-truncation.test.ts`,
`apps/mobile/src/lib/replica/inline-query-ctx.native.ts`,
`receipts/issue-922-snappier-blueprints.md`.
