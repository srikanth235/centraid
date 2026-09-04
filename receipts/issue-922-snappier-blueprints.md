# Issue #922 — snappier blueprint apps: replica, gateway and mobile hot paths

Umbrella receipt for [#922](https://github.com/srikanth235/centraid/issues/922). Slices append one `## <wave><slice> — <title>` section each; nothing above a new section is rewritten.

## Checklist

**Part 0**
- [x] No read on any seat truncates silently: the replica read plan and the gateway read report `truncated` when the default cap fills, undeclared unbounded reads are refused at the kit boundary, and the honesty grammar renders the truncation (test per layer)
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

Wave 1, rulings slice — **documentation only**. No code file is touched by THIS section's slice, so it ticks no acceptance box of its own: a ruling recorded ahead of its code wave is not by itself a satisfied acceptance criterion. (The wave-1 root doc commit later ticked Part 0 box 1 against the `## 0a` slice's evidence; see the crosswalk paragraph at the end of this section and `## w1 root doc commit`.) The one Part-F clause this slice realizes is the **"F2/F4 closed as superseded"** half of the first Part-F box; its other half (F1/F3/F5 landed with provenance) belongs to the sibling instrument slices, so the box stays unticked until they land.

- `docs/decisions.md` — new section **`## Snappier blueprint apps (#922)`**, placed immediately before `## Related docs`, carrying:
  - a rulings table with nine ids — `SB-payload` (SSE payload frame wins; the doorbell-only pull-on-every-nudge path is deleted in wave 3; property: one hop from commit to a subscribed device), `SB-text` (per-entity declared text ceiling, text rides in full, only blob/binary stays deferred; property: a note the phone cannot show offline defeats the replica), `SB-pool` (`CONSTRAINED_WORKER_POOL_SIZE = 1` in `packages/server/src/engine/handlers/worker-pool.ts` is the single source; the `conserve` preset's `workerPoolSize: 0` and the `build-gateway.ts` boot override are deleted in wave 2), `SB-reuse` (fresh realm per run inside a reused thread; the property #404 buys is the thread boundary plus a hard timeout), `SB-tally` (the "one balance engine" ruling superseded — the engine is the pure module pair the web query handlers already import, which the phone imports directly from wave 4 (E7); until then the phone reaches the fold only through the gateway RPC this ruling supersedes), `SB-replica-sync` (ruled per seat: the wasm replica store runs `synchronous=NORMAL` unconditionally in wave 3, its outbox being IndexedDB and outside the pragma, while the mobile replica store stays `synchronous=FULL` until B4's fsync-per-offline-intent measurement on a phone justifies a change, with WAL + `NORMAL` plus a `FULL` bracket on outbox transactions as the preferred mechanism and the `journal_mode=DELETE` second-reader seam re-judged first), `SB-session` (replica sessions live as long as the tab/window, closing on hide or memory pressure), `SB-instrument` (F1 absorbed into #927's gateway trace slice; F2/F4 closed as superseded; F3/F5 plus #927's work counters are the interim), and `SB-loader` left **explicitly open** for the wave-1 Metro-loader spike to adopt or refuse with its reason. Every row names the property it keeps or the finding it files, and the wave that lands the code.
  - the full **re-judged register** of 2026-09-03 reproduced as a `Seam | Ruling cited | Property that depends on it now | Verdict` table.
- `docs/decisions.md` — six new rows in the existing `## Superseded decision pointers` table, each naming #922 and its replacement: Tally's "one balance engine" as a reason the phone reads from the gateway (#873/#883, carried in `docs/mobile-offline.md`); the #599 30-second replica-session idle close; the doorbell-only client change feed; the `conserve` preset's `workerPoolSize: 0` (#528); "a handler worker is disposed after every run" as the operative reading of #404; and `synchronous=FULL` **as applied to the client replica store** — stated explicitly as *not* touching #456's ruling, which is about the vault.
- `docs/decisions.md` — one sentence appended to the second paragraph of `## Performance and Rust byte plane`: the five evidence-gated designs take their gate from #927's journey ledger when it lands, with #922 wave 1's instruments as the interim. The paragraph is otherwise unchanged.
- `docs/mobile-offline.md` — a forward-stated note at the Tally read carve-out: superseded by `SB-tally` (#922), reverts in #922 wave 4. The carve-out text itself is **kept**, because the code has not moved and the paragraph still describes the shipped seat.
- `receipts/issue-922-snappier-blueprints.md` — this file, created as the umbrella receipt with the issue's acceptance criteria mirrored verbatim.

Added by the wave-1 root doc commit (see `## w1 root doc commit` below), so the one box it ticks on this receipt crosswalks to evidence in this section, as `receipt-per-issue` rule 3 requires — the crosswalk reads only `## What changed` and `## Verification` and never an appended wave section. **No read on any seat truncates silently: the replica read plan and the gateway read report `truncated` when the default cap fills, undeclared unbounded reads are refused at the kit boundary, and the honesty grammar renders the truncation (test per layer)** — realized by the `## 0a` slice and its `### Verifier follow-ups`: `packages/client/src/replica/read-plan.ts` (`trimReplicaPage`, `UnboundedReplicaReadError`, `assertBoundedReplicaRead`) and `packages/vault/src/gateway/gateway.ts` both fetch one probe row past the window so a filled window is distinguished from a set that merely ends there; `apps/mobile/src/kit/hooks/useReplicaQuery.ts` on the phone and the web inline ctx (`assertBoundedReplicaRead` at `packages/client/src/react/blueprints/inlineQueryCtx.ts`) refuse an undeclared unbounded read at the kit boundary with `UnboundedReplicaReadError`; the honesty grammar renders it on every seat, and follow-up 1 closed the last silent layer by giving the replica FTS `search` path the same probe, named bounds (`REPLICA_DEFAULT_SEARCH_ROWS` 100, `REPLICA_MAX_SEARCH_ROWS` 1,000) and `truncated` + `appliedLimit`, rendered once per seat for all three phone search screens. Tests per layer: `packages/vault/src/gateway/read-truncation.test.ts`, `packages/client/src/replica/read-plan-truncation.test.ts`, `apps/mobile/src/kit/hooks/useReplicaQuery.truncation.test.tsx`, `apps/mobile/src/lib/replica/multi-vault-reader.test.ts`. Both verifier passes on the 0a section end PASS, the second re-deriving the numbers and closing five follow-ups.

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
| 2026-09-04 | claude-code | 60f9e86b-149f-5fc9-84c0-f2160b6b6f3c |
| 2026-09-03 | codex | 01a06827-b506-78d1-b396-f4b14307e138 |

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

## lane 3a — F5 gauges and web probe

Slices (i) F5/B6 gauges and (ii) the web LCP/INP probe. Gauges only: no budget is added, moved or widened. Serves "Audit-band bytes/read and WAL size are gated numbers" (the numbers half — gating is 3b's, the checkpoint 4a's) and the F5 half of "F1/F3/F5 landed in wave 1 with provenance".

### Files

| Path | Change |
| --- | --- |
| `tests/scale/large-vault.scale.test.ts` | Enrolls a real owner device on the mounted golden vault, issues 500 real `Gateway.read`s of `media.asset`, and publishes what they cost the audit band: bytes per read, WAL bytes per read, the achieved read rate, and WAL growth per hour AT that rate. Two non-zero assertions guard the instrument; no ceiling is added. Also publishes `golden vault mount` (#927's slice iv). |
| `tests/scale/replica-sse-fanout.scale.test.ts` | Publishes household projections per commit, read from the hub's OWN counters — `currentGeneration()` for commits, `subscriberCount()` for the household — plus the property the hub exists for: the page it returns is SHARED, so distinct page objects across a household reading at one cursor IS the projection count. `routes/replica-fanout.ts` is untouched. |
| `scripts/test-report/render/adversaries.mjs` | A trend card with no budget now reads `gauge · no budget` instead of a blank corner, and §9's note says what that means. An ungated series and a gate someone forgot to wire looked identical on the page. |
| `scripts/test-report/render.test.mjs` | Pins both halves of that: `budget 500 ms` on a gated series, `gauge · no budget` on a gauge. |
| `apps/web/tests/e2e/perf-waterfall.spec.ts` | The vitals probe emits LCP and INP now — see below. |

Also in this lane, under #927 and detailed in `receipts/issue-927-perf-infra.md`: `packages/test-kit/src/year3-fixture-cache.ts`, `packages/test-kit/src/year3-vault.ts`, `packages/test-kit/src/year3-vault.test.ts`, `tests/helpers/factories.ts`, `tests/scale/photos-timeline.scale.test.ts`, `tests/quality/user-facing-qualities.test.ts`.

### Numbers

Host: this session's container, Linux 4 cores / 15 GB, node 22. Volumes: the mounted golden year-3 vault (106,274,816 B) at 500 gateway reads of `limit` 20; 16 subscribers x 10 commits on a real `serve()` gateway; headless_shell 1194 on the `apps/web` e2e harness, empty fixture vault.

| Gauge | Value | Ledger entry it feeds (wave 2: surface x journey x volume x hardware) |
| --- | --- | --- |
| Audit-band bytes per gateway read | 360.4 B (three runs, identical) | vault-core x open-a-surface x year-3 golden x this container |
| WAL bytes per gateway read | 45,352 / 45,599 / 45,649 B | same row's storage axis — and the input to #922's WAL ceiling and 4a's size-based checkpoint |
| Gateway reads sustained | 263.4 / 660.8 / 779.8 reads/s | the rate the row below is stated at; it is the HOST's, and it moves |
| WAL growth per hour under a reading client | 43.3 / 107.9 / 128.0 GB/h | vault-core x a client that only reads x year-3 golden x this container |
| Household projections per commit | 1, across 16 subscribers | server x a write reaches the household x 16 devices x this container |
| Hub subscribers / generations per commit | 16 / 1 | the same row's denominators |
| Web LCP | 612 / 560 ms | web x cold shell load x empty fixture vault x headless_shell |
| Web INP | 32 / 40 ms | same row |

The per-READ pair is the stable measurement; the per-HOUR figure is that pair times the run's own achieved rate, so it moves with the host and is never to be quoted without the rate beside it. 45 KiB of WAL for a 360-byte receipt is one commit's worth of dirty pages per read — the cost `gateway/read-batch.test.ts` was written about, now with a number.

Commands:

```sh
bun run test:scale -- tests/scale/large-vault.scale.test.ts
bun run test:scale -- tests/scale/replica-sse-fanout.scale.test.ts
cd apps/web && CENTRAID_E2E_CHROMIUM=/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell \
  bunx playwright test -c tests/e2e/playwright.config.ts perf-waterfall.spec.ts -g "web vitals"
```

### The web probe: what was wrong

Two faults, both in the harness, neither in the app:

1. **No presented frame.** PaintTiming stamps `first-contentful-paint` when a frame carrying the content is PRESENTED, and LCP has no candidate before it. A headless shell driving no display presents nothing on its own, so the probe read `first-paint` alone off a fully rendered screen and reported `LCP: n/a`; `web.json` had guessed a webfont or an unresolved transition. Animation frames and forced layout reads never reach presentation. One thrown-away `page.screenshot()` does. It runs BEFORE the interaction, because Chromium stops reporting LCP at the first input — and the probe then waits for the candidate to be DELIVERED: a first run that interacted too early got a `first-contentful-paint` on the timeline and `LCP: n/a` beside it, the entry dropped while queued.
2. **The interaction never happened.** The probe clicked `button:visible` — on the cold connect screen that is "Continue", disabled until a ticket is pasted, so it spent its whole 15 s actionability timeout and left `interactionDriven: false`. It presses the pairing-ticket field instead, the one enabled control that screen offers, exactly as `web.json`'s own note proposed.

`readVitals` also fills in `visibility` and `bodyText`, declared on `VitalsCapture` and never populated, so a future null is attributable.

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

### Audit — re-verification of `f0957fb8d` (2026-09-03)

Verdict: PASS

Second fresh-context pass, scoped to the one new commit
`refactor(client): one inline-query ctx core for web and native`. Two findings for the
root are recorded below; neither is a defect in the change, and both must be settled
before the wave PR merges.

**Reproduced, not read**

- **Duplication.** Re-ran the block scan independently (`difflib.SequenceMatcher`,
  `autojunk=False`, matching blocks ≥ 8 lines). Before (`61973cef5`): native ↔ web =
  **6 blocks / 93 of 238 lines (39.1 %)**, at native 26-33, 70-79, 97-135, 176-192,
  195-204, 228-236 ↔ web 3-10, 52-61, 80-118, 249-265, 267-276, 284-292 — every offset in
  the receipt's table matches. After (`f0957fb8d`): native ↔ web **0/0**, native ↔ core
  **0/0**, web ↔ core **0/0**. Line counts 238 → 81 and 294 → 173 confirmed.
- **The core is DOM-free, by module graph.** Transitive scan from
  `inline-query-ctx-core.ts`: the value graph is the file itself plus
  `@centraid/core/time`; adding type-only edges reaches only `online-only-error.ts`,
  `online-only-guard.ts` and `types.ts`. No `gateway-client-core`, no `window`/`document`/
  `navigator`/`HTMLElement`/`localStorage` token anywhere in that closure.
  End-to-end: a Metro export with the adapter forced into the app graph (throwaway probe
  from `index.ts`, reverted) is **exit 0 at 2,687 modules / 8,057,740 B** — one module and
  +939 B against the same probe before the refactor (2,686 / 8,056,801 B). Pulling in the
  browser engine would not cost 939 bytes.
- **Web pending-row provenance is unchanged.** The shell still threads
  `PENDING_ROW_PROVENANCE` through the core's row callback as an enumerable own symbol,
  and `carriedPendingMarker`'s exact-symbol branch still fires: a throwaway test whose
  handler projects rows with **no** identity field surviving — so the field-matching
  fallback cannot fire — still receives the pending overlay fields. Deleted after running.
  Behaviour-equivalence of the two other web changes checked by reading both revisions:
  `guardedRow` now returns a plain object when nothing is missing (the old one always
  returned a Proxy), which is observationally identical because every trap is a no-op in
  that case; and `createOnlineGuard` / `InlineOnlineGuard` / the local `OnlineOnlyError`
  interface had no importer outside the file and its test.
- **The deleted guard.** `OnlineOnlyGuard` predates this slice (used by `coordinator.ts`,
  `worker-client.ts`, `query.ts`, `store.ts` and already by
  `apps/mobile/src/lib/replica/native-replica-store.ts`), and `OnlineOnlyError` produces
  the identical message (`Query requires the online vault: <reason>`), `code`
  `ONLINE_ONLY` and `name` `OnlineOnlyError`. `required` and `assertLocal()` match the
  deleted copy exactly. One wording correction: `mark()` is **not** "sticky first-reason"
  — it *retains* the first error but *returns* the newly created one, where the deleted
  copy returned the first on every call (verified with a throwaway probe). Unobservable
  outside the ctx, because `runInlineQueryCore` surfaces the run's refusal through
  `assertLocal()`, which throws the first reason on both designs.
- **Receipt ↔ diff.** The `### Sonar duplication` section names all seven files in the
  commit and nothing else; the diff contains exactly those seven. The preconditions
  paragraph now reads "(a) is done … only (b) remains for E7". Still no `- [x]` anywhere
  in `## Checklist`. No NUL bytes in any changed file; no binary hunk in
  `git diff --numstat`.
- **`lint:product`, checked both ways.** 35/39 here. On a detached clean worktree at this
  branch's base `e2f277da3`, `bun run lint:product` is **36/39** and fails on exactly
  `test:ratchet`, `lint:ledgers`, `lint:quality-knobs` — so those three are base lag, not
  this diff, confirmed rather than assumed. `check:ui-receipt` passes at the base and
  fails here: this diff is its only cause. (`origin/main` has since moved to `dccf9e609`,
  where all 39 are green.)

**Findings for the root**

1. `receipts/issue-922-snappier-blueprints.md` (the `check:ui-receipt` paragraph) →
   the stated shape of the fix — "a non-UI exclusion for the engine paths under
   `packages/client/src/replica/**`" — **does not clear this diff**, and neither does
   rebasing onto #931. Ran #931's refined `validateUiReceipt` against this commit's file
   list: `packages/client/src/replica/**` is excluded there, but
   `packages/client/src/react/blueprints/inlineQueryCtx.ts` is not, and it alone
   re-triggers the gate (verified by removing it from the list, which returns `[]`).
   → The root must settle `check:ui-receipt` for `react/blueprints/` engine modules
   explicitly; a rebase alone leaves the wave PR red.
2. Cross-slice collision. `claude/922-w1-0a-no-silent-truncation` also edits
   `packages/client/src/react/blueprints/inlineQueryCtx.ts` (+18) and
   `inlineQueryCtx.test.ts` (+28), which this commit rewrote 294 → 173 lines. Two
   in-flight slices now own the same two files, against the wave rule that a slice owns
   files no other in-flight slice touches. → Order the merges and re-land 0a's truncation
   hook against the post-refactor file, or the second merge conflicts.

**Noted, not blocking**

- No test pins the provenance **symbol** path: deleting the symbol from the row (in this
  revision *and* in `61973cef5`) leaves `inlineQueryCtx.test.ts` green, because every
  fixture also satisfies the field-matching fallback. Pre-existing, not introduced here;
  worth a case when E7 touches this code.

**Gates run** (this worktree, 4 cores, Node 22 vs pinned 24; each under
`scratchpad/gate.lock`)

```
bun run format:check                          # clean, 5358 files
bun run lint                                  # green
bun run --cwd packages/client build           # clean
bun run --cwd packages/client typecheck       # clean
bun run --cwd packages/client test            # 264 files, 2420 passed  (engine lane)
bun run --cwd packages/client test -- src/react/blueprints/   # 8 files, 76 passed
bun run --cwd apps/mobile typecheck           # clean
bun run --cwd apps/mobile test                # 272 files, 2357 passed  (engine lane)
bun run --cwd packages/blueprints typecheck   # clean
bun run --cwd packages/blueprints test        # 207 files, 6588 passed | 2 expected fail
bun run lint:hermes-surface                   # ok — 809 modules reachable, none unsafe
bash .governance/run.sh                       # 22/22 directives
bun run lint:product                          # 35/39 — see the two-way check above
```

### Verifier follow-up — the collision with 0a, and the gate the audit predicted

Nothing above this sub-heading is rewritten, the audit text included. Two of its statements
are overtaken by the landing, and both are corrected here rather than edited in place.

1. **`check:ui-receipt` is green on the integration branch, and nothing was invented to
   make it so.** The audit's finding 1 was right about the predicate: `#931`'s refined
   exclusion covers `packages/client/src/replica/**` but not
   `packages/client/src/react/blueprints/inlineQueryCtx.ts`, which alone re-triggers the
   gate — that is still true, and the root is settling it in #931. What changed is the
   changed-set: rebased onto 0a, `receipts/issue-922-snappier-blueprints.md` carries 0a's
   own `## User impact` section, which the gate reads and accepts. The predicate is
   satisfied by 0a's genuine user-visible change, not by a `## User impact` written for
   this refactor — there is none, and a no-op has no screen to photograph. So the earlier
   paragraph's "no honest exit" stands as written for this diff **standing alone**; on the
   wave branch the question does not arise.
2. **`lint:product` is 36/39 here**, failing `test:ratchet`, `lint:ledgers` and
   `lint:quality-knobs`. All three are base lag and none is this diff's: a detached clean
   worktree at `fd3948e6b` — no diff applied — fails exactly the same three, because
   `origin/main` moved past this wave branch and #928's `9e130654a` renamed the
   `blueprint-app-entity-tripwire-law` floors flow. They clear when the wave branch rebases
   onto the newer main, which is the root's call.

**The collision with 0a, resolved.** 0a had added two duties to the very read/search
closures this refactor moved. Re-applied onto the new shape, never copied:

- **`packages/client/src/react/blueprints/inlineQueryCtx.ts` posts the truncation notice**
  — the web thin caller, exactly where 0a put it. The status channel is the shell's; a
  React Native screen has no status line. `assertBoundedReplicaRead` stays beside it for
  the same kind of reason: the refusal's whole value is that the calling query's own file
  is named in the stack, which a module shared by both seats cannot do.
- **The core gained the seam, not the behaviour.** `inlineReadsFor` takes an optional
  `InlineReadHooks` (`beforeRead`, `beforeSearch`, `onResult`), and `InlineWireResult`
  declares `truncated` / `appliedLimit` so a seat can see a cut-off page without unwrapping
  the result twice. The phone passes no hooks — 0a's mobile half already bounds and reports
  through `useReplicaQuery` and `MultiVaultReplicaSession`.
- 0a posted the notice from two hand-written blocks, one in `read` and one in `search`. On
  the hook it is **one** `onResult`, run on both paths: the same behaviour from one site.

**No 0a assertion was weakened.** `inlineQueryCtx.test.ts` merged cleanly. 0a's
`inline-read-truncation.test.ts` took a setup-only edit — 3 insertions, 2 deletions, all of
it the guard import and its single construction site (`createOnlineGuard()` →
`new OnlineOnlyGuard()`) — and all five of its cases assert exactly what 0a wrote.
`read-plan-truncation.test.ts` (11 cases) is untouched. The Metro parity test is unchanged.

Gates on the landed branch, under the shared lock: `packages/client` build ✓, typecheck ✓,
full test **266 files / 2436 passed**; `src/react/blueprints/` **9 files / 81 passed**;
`apps/mobile` full test **273 files / 2364 passed**, typecheck ✓; `packages/blueprints`
typecheck ✓; `bun run format:check` ✓; root `bun run lint` ✓; `bash .governance/run.sh`
**22/22**.
## 0b — deferred text has a path to the screen, or is not deferred

Ruling **SB-text** implemented (issue #922 Part 0, box 0b; open question 7 answered as proposed): text rides the replica lane in full up to a ceiling its entity declares, only genuinely binary values stay deferred, and a deferred value is visibly absent rather than silently `undefined`.

### What changed, file by file

- `packages/vault/src/schema/entity-declaration.ts` — new `VaultEntityReplicaValues` (`textCeilingBytes`, `lazyColumns`) on `VaultEntityDeclaration`, `DEFAULT_REPLICA_TEXT_CEILING_BYTES` (the old flat cap, kept as the DEFAULT rather than the rule) and `replicaValuesOf`.
- `packages/vault/src/schema/entity-catalog.ts` — the declarations, beside the entities: `core.content_item` and `core.content_derivative` at 1 MiB (a note body is a `data:` URI in `content_uri`; `text_content` is a document's extracted text or a transcript), and `enrich.embedding` marking `vector` lazy.
- `packages/vault/src/replica/value-policy.ts` (new) — resolves one entity's declared policy; sibling of `unavailable-columns.ts`.
- `packages/vault/src/replica/snapshot.ts` — `publicRow` defers a declared-lazy column or a `Uint8Array` (the safety net for the declaration-less ext band), then compares text against the entity's declared ceiling instead of a flat 64 KiB. `DEFAULT_REPLICA_MAX_VALUE_BYTES` is **deleted**, replaced by `DEFAULT_REPLICA_TEXT_CEILING_BYTES` re-exported from the declaration module — one number, one home. `packages/vault/src/index.ts` follows.
- `packages/blueprints/apps/_shared/shared-copy.ts` — `fieldNotOnThisDevice(field)`, the one sentence both clients print for an absent value.
- `packages/client/src/replica/query.ts` — `unavailableReason` and `guardReplicaRow` raise that sentence instead of the internal `oversized field X`, so the string that reaches `useReplicaQuery`'s `error` and the shell's guard is member copy.
- Tests: `packages/vault/src/replica/value-policy.test.ts` (new), `packages/server/src/routes/replica-projection.test.ts` (+1), `packages/client/src/replica/deferred-values.test.ts` (new), `apps/mobile/src/lib/replica/native-replica-store.test.ts` (+1, and the guard case now asserts the sentence).
- Docs: `docs/mobile-offline.md` (the wire invariant, now five), `docs/decisions.md` (SB-text's "Lands in" rewritten to landed with what it landed as).

### Numbers — golden year-3 vault

Provenance: host 4 cores / 15 GB (Linux 6.18); the golden year-3 vault seeded by `seedYear3Vault(target, goldenYear3Profile())` from `origin/claude/927-w1`'s test-kit (`YEAR3_DISTRIBUTIONS`: 1,000 notes, `longNoteShare` 0.03, bodies 64 KiB+1 … 256 KiB), walked with `readReplicaRows` at `limit: 1000` over every registered entity by a temporary harness (`packages/vault/src/replica/zz-measure.test.ts`, deleted).

| | rows with a deferred field | bootstrap page bytes (1,000-row pages) | serialized rows |
| --- | --- | --- | --- |
| BEFORE `core.content_item` | **30** (`content_uri`) | 487,068 / 489,288 / 489,831 / 490,288 ×7 / **523,493** | 5,407,562 B |
| AFTER `core.content_item` | **0** | 487,068 / 489,288 / 489,831 / 490,288 ×7 / **6,311,925** | 11,195,994 B |
| BEFORE+AFTER `knowledge.note` | 0 | 385,095 | 383,890 B |

Bootstrap-page growth: **+5,788,432 B on one page (523 KB → 6.31 MB, ×12.06)**, +107% across the entity — exactly the 30 long note bodies (≈193 KB each as base64 `data:` URIs) that previously reached no device. No other registered entity defers anything at year-3 volume, before or after. No budget in `tests/budgets.json` or `tests/experience-budgets/**` gates bootstrap page BYTES, so nothing was widened; the concentration is an artifact of seeding order (all note content items land in the last page) and is named as a finding below.

### What was deleted

- The flat 64 KiB **text** deferral in `publicRow`, and the `DEFAULT_REPLICA_MAX_VALUE_BYTES` name for it — replaced by the per-entity declaration in the catalog, which is where a reader can now find out what an entity's values may be.
- The internal `oversized field X` reason string in two places, replaced by one `fieldNotOnThisDevice` in shared copy.

### Decisions and re-judged rulings

- **No fetch-on-demand route was built.** The ruling allows one only for columns an entity explicitly marks lazy. Exactly one column is marked (`enrich.embedding.vector`), nothing renders an embedding vector, and building a route no screen would call would recreate the never-read state this slice deletes. The path to the screen for that column is the refusal that names it. The receipt records the trigger: the first lazy column a screen must render is what makes the route necessary.
- **"No client reads the oversized list" (issue body) is re-judged as partly wrong, and the correction matters.** The list has three consumers on `main`: `store-core.ts` records a search gap when an indexed column is oversized, validates apply-time that a listed field carries no value, and both clients escalate online through `guardReplicaRow`. What was missing was any way to get the VALUE and, for TEXT, any honest answer offline. So the fix is the ceiling, not a deletion of the list — the list is now only ever about bytes.
- **`Uint8Array` deferral kept beside the declaration.** Property it holds now: the ext band (#286) is declared by an app at runtime and has no catalog entry, so an app-declared BLOB column has no declaration to read. `value-policy.test.ts` asserts every BLOB column on a REGISTERED entity is declared lazy, so the implicit rule cannot silently become the primary one again.
- **No mobile migration.** `oversized_json` keeps its shape (a JSON array of column names); only `payload_json` grows. No ALTER, no rebootstrap.

### Findings

- `apps/mobile/src/kit/hooks/useReplicaQuery.ts` reads through `session.read` → `readWire`, and `mapReplicaRows` spreads `row.values` — so `oversizedFields` is DROPPED on that path and a lazy field reads as `undefined` on the screens that use the hook. `native-replica-store.read()` (the guarded path) is correct. That file is 0a's by contract, so this is filed rather than fixed.
- `packages/server/src/routes/replica-shape.ts:26` keeps its own `REPLICA_MAX_VALUE_BYTES = 64 * 1024` beside the vault's default — two sources for one number. The rest of that file is #928's by contract, so the one-line re-export was not landed. Recommend #928 or a follow-up import the vault constant.
- Bootstrap pages are windowed by ROW count, not bytes, so an entity with long declared text can produce a 6 MB page. Recommend a byte-aware page window in the C/E lane (`replica-routes.ts`).
- `packages/test-kit/src/year3-shape.ts` (on `origin/claude/927-w1`) documents `longNoteShare` by the now-deleted `DEFAULT_REPLICA_MAX_VALUE_BYTES`; the comment needs a rename when the two waves meet.
## w1 root doc commit

The root's one doc commit for wave 1 of #922 (and the doc half of #927 and #928's wave 1).
It writes no code and produces no evidence of its own: it turns wave-1 slice evidence into
current-state rulings in `docs/decisions.md`, and ticks only boxes whose evidence already
exists. Waves are named exactly as #922's Part G and execution plan state them.

### What changed, file by file

- **`docs/decisions.md`**, `## Snappier blueprint apps (#922)` — the **`SB-loader` row is
  rewritten in place from Open to ADOPT**. Docs are state, so the Open row is replaced, not
  annotated. The row now records: Metro loads `queries/*.ts` today; the spike exported
  `packages/blueprints/apps/tally/queries/dashboard.ts` into the mobile graph through a
  DOM-free adapter for **+4 modules, +31,494 B (+0.39 %)** of Hermes bytecode at
  `expo export` **exit 0** with `apps/mobile/metro.config.js` untouched; `dashboard.ts` on
  the native session at **11.1 ms median (N=40)** and **188 ms (N=2,000)**, indicative; the
  property kept — **one query handler per app on both seats** — and the projection fork
  deleted **app by app (E3/E7, Tally first)**; and the two preconditions, of which
  **(a) is DONE in wave 1** — one ctx builder, `packages/client/src/replica/inline-query-ctx-core.ts`,
  DOM-free and re-exported through `@centraid/client/replica/native`, both seats thin
  callers (adapter 238 → 81 lines, web `inlineQueryCtx.ts` 294 → 173) and duplication
  **93 of 238 lines (39.1 %) → 0 blocks, 0 lines (0.0 %)** — while **(b) remains for E7**,
  no `__centraid*` provenance handed to a handler, now with **exactly one place to land**
  (`inlineReadsFor`'s row callback) because both seats import one builder, until
  `SB-overlay-3`'s sidecar makes it one key. Every number is taken verbatim from
  `## w1 Metro-loader spike — ADOPT` and `## w1 Metro-loader spike — ctx-core de-duplication`
  above; none is new.
- **`docs/decisions.md`**, same section — a new sub-table **Pending-write overlay
  (SB-overlay-1 … SB-overlay-9)** after the re-judged register and its `synchronous=FULL`
  paragraph, one row per Part G ruling G1–G9 in the register's four columns (Id | Current
  decision | Property it keeps, or the finding it files | Lands in), with **G8 riding G1's
  row** (`SB-overlay-1`) as Part G states. Beneath it the **eight-row overlay seam register**
  in the same shape as the existing register (Seam | Held by | Property that depends on it
  now | Verdict): seven findings, one `holds` (no expiry on queued intents — member data is
  never dropped, `SB-overlay-9` adds age). The "what stays" and "considered, not now" notes
  are carried across: `replica ⊕ outbox` as the read law, the durable outbox and the Pending
  changes sheet as the guaranteed place; visibility of one device's queued writes on the
  owner's other seats, and merging the intent/placement/upload outboxes, both deferred.
  Lands-in waves are Part G's own: wave 2 (`w2-tw`, `w2-age`, the `w2-probe`), wave 3 (A6 for
  G1/G8, the sidecar, the state widening, #929 S2), wave 4 (G2's red-first slice after #928
  wave 4 and B8; G7 with E1).
- **`docs/decisions.md`** — a new section **`## Perf and scale infrastructure (#927)`**,
  placed after `## One authority plane (#928)` and before `## Related docs`, with four
  rulings: **PS-trace** (the trace and work-counter contract landed in
  `packages/core/src/protocol/trace.ts`, #927 wave 1 — the closed nine hops, four seats, nine
  journeys, nine integer work counters, strict validator, pure `waterfall`, sampling off by
  default, the trace id **is** the intent id for a write, traces sovereign and never
  egressed); **PS-922-instruments** (this umbrella's **F2 and F4 closed as superseded** by
  #927's journey ledger and device rung, F1 absorbed into the gateway trace slice, F3/F5 plus
  the work counters the interim, and every #922 receipt from wave 2 onward citing the
  ledger); **PS-evidence-gate** (the "five perf designs evidence-gated, not adopted" row
  **superseded as practice** — the gate could never open without instruments, so the journey
  ledger is the gate and **#927 is the precondition, not the last wave**); **PS-diet** (the
  deletion list of rigs no journey entry cites is **produced by wave 1 and approved before
  wave 5 executes it — pending, not produced**, with `validate-nightly-wiring.mjs` still
  failing on an unregistered rig throughout). The `## Performance and Rust byte plane`
  paragraph gains one cross-reference to `PS-evidence-gate`; nothing else in it changed.
- **`receipts/issue-928-one-authority-plane.md`** — box 3 ticked with a crosswalk paragraph
  in `## What changed`, the checklist note rewritten, and a `## w1 root doc commit` section
  appended. Detailed there.
- **`packages/blueprints/manifest.json`** — **regenerated**, not hand-edited, with the
  package's own tooling (`bun run --cwd packages/blueprints build:manifest`, i.e.
  `packages/blueprints/scripts/build-manifest.mjs`; "wrote 37 templates"). It was stale on
  the integration branch: #948 landed `queries/history.test.ts` in Notes and Docs without
  regenerating it, so the gates regenerate it and the two entries appear as an unstaged
  diff on every subsequent run. Exactly two lines are added
  (`notes/queries/history.test.ts`, `docs/queries/history.test.ts`); nothing else in the
  file moves. It rides this commit so the branch is clean for the next slice.
- **`receipts/issue-922-snappier-blueprints.md`** — this section, plus the Part 0 box-1 tick
  and its crosswalk paragraph in `## What changed`.

### Boxes ticked

**Part 0 box 1**, and only that box on this receipt:

| Box | Ticked | Evidence |
| --- | --- | --- |
| Part 0 box 1 — no read on any seat truncates silently (replica read plan and gateway report `truncated`, undeclared unbounded reads refused at the kit boundary, honesty grammar renders it, test per layer) | **yes** | `## 0a — no silent truncation, on any seat, at any layer` and its `### Verifier follow-ups`: the one-probe-row mechanism in `read-plan.ts` and the gateway read, `UnboundedReplicaReadError` at both kit boundaries, the FTS `search` signal that closed the last silent layer, four per-layer test files, and two verifier passes both ending PASS |

The other candidate was judged and refused:

- **Part E — "The Metro-loadable `queries/*.ts` decision is recorded, adopted or refused with
  its reason; if adopted, at least Tally runs the web query handler on the phone and its
  projection fork is deleted."** The first clause is now satisfied — the decision is recorded
  as ADOPT in `docs/decisions.md`, with its reason and its numbers. The second is **not**:
  no product code runs a blueprint query handler on the phone, and no projection fork is
  deleted. E7 does that, in wave 4. The box is one criterion with two clauses, so it stays
  **unticked** until E7 lands, and the wave-1 half is recorded here rather than by a
  half-tick.


### Decisions

- **The `SB-loader` row was rewritten, not appended to.** Docs are state: an Open row beside
  an ADOPT note would leave two answers on the page. The spike's own receipt section is the
  evidence and is untouched.
- **Precondition (a) is recorded as DONE, on the second pass.** The first draft of this
  commit recorded (a) as unmet, because the Metro worker's ctx-core commits were not yet on
  the integration branch. They landed (`44836b2c9`, receipt section in `7a6aa30de`) before
  this commit was made, so the row was rewritten against the landed evidence rather than
  against their absence. The numbers come from `## w1 Metro-loader spike — ctx-core
  de-duplication`, which itself amends the ADOPT section byte-for-byte rather than editing
  it — the same docs-are-state rule this commit follows in `docs/decisions.md`.
- **No number in the new rows is new.** Every figure in the `SB-loader` row is quoted from
  `## w1 Metro-loader spike — ADOPT`, and every figure in `PS-trace` from
  `receipts/issue-927-perf-infra.md` § `## w1-core`. The root measured nothing.
- **G8 has no row of its own**, per Part G: it is stated inside `SB-overlay-1`, so the
  register cannot grow a ruling nobody re-judged.
- **The #927 section states only what #927's body rules.** The five principles, the four
  rulings above and the deletion list are the issue's own; nothing was paraphrased into a
  ruling the issue does not make, and the rig list is named as pending rather than produced.

### Verification

```
bun run --cwd packages/vault test -- src/replica/value-policy.test.ts src/replica/snapshot.test.ts   # 10 passed
bun run --cwd packages/vault build                                                                   # ok
bun run --cwd packages/server test -- src/routes/replica-projection.test.ts                          # 9 passed (red first: oversizedFields listed content_uri)
bun run --cwd packages/client test -- src/replica/deferred-values.test.ts                            # 2 passed
bun run --cwd apps/mobile test -- src/lib/replica/native-replica-store.test.ts                       # 6 passed
bun run --cwd packages/vault typecheck                                                               # clean
```

Remaining gates (full package suites, governance, self-audit) were **waived by maintainer ruling mid-slice**; this section is landed at the coherent point that ruling asked for.
bun run format                    # clean
bun run lint                      # clean
bun run lint:product              # 39/39
bash .governance/run.sh           # 22/22
bun run test:claims               # 45 claims, 48 lanes, 193 derived flows
```

### Audit

Verdict: PASS — root doc commit; ticks are traceable to the evidence sections named above
# in /home/user/centraid-wt/claude/927-w1c-golden-vault
bash $S/self-audit.sh 922 origin/claude/927-ledger   # tree d4697a3e1fb4f84bde8323ff42fbfd652246ad0d
bun run test:ratchet:unit                            # scripts/test-report, incl. the new gauge-label test
bun run typecheck
bun run test:scale -- tests/scale/large-vault.scale.test.ts        # 1 passed
bun run test:scale -- tests/scale/replica-sse-fanout.scale.test.ts # 1 passed
bash .governance/run.sh                                # 22/22 directives passed
```

Gates ran on tree `d4697a3e1fb4f84bde8323ff42fbfd652246ad0d` (head `564ff42d5`),
and `self-audit.sh` was re-run on the landed head after this paragraph was
written, with the same result — the two trees differ only by this paragraph and
its twin in the other receipt. `self-audit.sh` is single-umbrella: it reports
each of this lane's other-umbrella commits as "subject lacks (#N)",
symmetrically in both runs. Every other check is green in both, and
`.governance/run.sh` passes 22 of 22.

### Findings

1. **`tests/experience-budgets/web.json` still says LCP and INP are `unmeasured`, with both ceilings parked in `_intendedCeilingMs`.** They are measured now. Promoting them is 3b's file and 3b's call — but the probe ALREADY asserts against the parked numbers (`ceilingMs ?? _intendedCeilingMs`), so 612 ms and 40 ms are gated against 2,500 ms and 200 ms today, under a `status` saying nobody measured anything.
2. **`web.json`'s `volume` for those metrics is `empty (web-e2e fixture vault)`** — the exact string #927 says must appear in no journey entry. This lane measured on that harness because it is the harness the probe has; the volume is 3b's to move.
3. **`replica-fanout.ts` is another lane's file this rig now reads.** The gauge uses `currentGeneration()`, `subscriberCount()` and `project()` only; a rename there fails this rig loudly rather than reporting a wrong number.

### Doc debt

- `tests/experience-budgets/README.md` — its status vocabulary has no word for "measured, deliberately ungated"; the report page now calls that a gauge.

## lane 5 — handlers

**Acceptance clauses served (Part B).** *"Blueprint handlers run precompiled; no esbuild hook on the app-handler path; per-call `fs.stat`s gone"* — B2 below. *"Workers are reused across clean runs and terminated only on timeout/error/limit; the pool size has one source and constrained hosts keep ≥1 warm worker; #842 W4.1 ref-search p95 under composition re-measured and budgeted"* — B3 below.

### Files

| File | Change |
| --- | --- |
| `packages/blueprints/scripts/build-handlers.mjs` | NEW. esbuild-bundles every `apps/*/{actions,queries}/*.ts` to a self-contained `.js` beside it. |
| `packages/blueprints/package.json` | `build:handlers` runs first in `build`. |
| `packages/blueprints/turbo.json` | The compiled handlers are declared build outputs (both gitignored; `lint:turbo-cache` clean). |
| `packages/blueprints/scripts/build-manifest.mjs` | The walk drops a `.js` that has a `.ts` sibling, so `manifest.json` still lists sources only. |
| `.gitignore` | The compiled handlers are generated, never committed. |
| `packages/server/src/engine/handlers/dispatcher.ts` | `probeHandlerFile` prefers the precompiled `.js`; handler resolution and the manifest `stat` cache behind `CODE_REVALIDATE_MS`; `invalidate()` clears both. |
| `packages/server/src/engine/handlers/worker-pool.ts` | Keyed reuse: `acquire(key)` / `release(worker, key)` / `retire(worker)`, refill accounts for threads that are coming back. |
| `packages/server/src/engine/handlers/handler-runner.ts` | Releases a thread that completed the protocol, retires it on timeout/error/exit; parks under the lane the WORKER reports. |
| `packages/server/src/engine/worker/runner.ts` | Per-run `AbortController`, per-run handler URL, global scrub between runs, `MAX_RUNS_PER_WORKER`, reports its installed `sandboxKey`. |
| `packages/server/src/engine/worker/thread-reuse.ts` | The four reuse properties as an in-process kernel both runners import. Worker isolates are outside the v8 coverage map; the kernel is what the 80% diff-coverage gate can actually see. Also owns the sandbox-key and host-ctx helpers the runners used to inline, so those lines are not invisible to v8. |
| `packages/server/src/engine/worker/thread-reuse.test.ts` | Scrub, per-run URL, run budget, abort-and-drop, host `fetch` signal. |
| `packages/server/src/automation/worker/runner.ts` | The same four, for the automation lane. |
| `packages/server/src/automation/handler/runner.ts` | Keyed acquire/release; a timed-out thread never returns to the pool. |
| `packages/server/src/serve/hardware-profile.ts` | The `workerPoolSize` preset entries are deleted; the knob's fallback is the pool's own constants. |
| `packages/server/src/serve/build-gateway.ts` | The boot-time `CENTRAID_WORKER_POOL_SIZE` override is deleted; only a durable UI override is still exported. |
| `tests/journeys.json` | `refSearchUnderComposition._remeasured` (ceiling unchanged at 1000 ms). The per-surface file this used to live in was folded into the journey ledger by #965. |
| `docs/traps/manifest-regeneration.md` | The checklist item said `.ts` wins and no compile step exists; both are now false. |
| `packages/server/src/engine/handlers/dispatcher.test.ts` · `packages/server/src/engine/handlers/handler-pool.test.ts` · `packages/server/src/engine/sandbox/sandbox-escape.test.ts` | Resolution order, stat coalescing, thread reuse, fresh graph, global scrub, lane keying, timeout destruction. |
| `packages/server/src/serve/hardware-profile.test.ts` · `packages/server/src/serve/hardware-profile.budget.test.ts` · `packages/server/src/serve/hardware-profile.cgroup.test.ts` · `packages/blueprints/src/runtime-boundary.test.ts` | The pinned pool sizes follow the pool's constants; the scripts set gains the handler compiler. |

### Numbers

Host: linux x64, 4 vCPU, 15.7 GiB, shared dev container; node v22.22.2. Handler: `notes/queries/library` (13 `ctx.vault.read`s against an empty-vault stub bridge), 30 invocations per cell, through `runHandler` on the built `packages/server/dist`. Command: `WT=$PWD CENTRAID_HARDWARE_PROFILE=<profile> node <bench> --runs=30`, where `<bench>` copies bench-journeys.mjs's blueprint-handler invocation without the HTTP and vault lanes.

| Profile | Cell | Before p50/p99 (ms) | After p50/p99 (ms) |
| --- | --- | --- | --- |
| standard | warm | 217.6 / 303.9 | **4.3 / 67.4** |
| standard | cold (pool 0) | 272.7 / 347.7 | **122.7 / 177.0** |
| constrained | warm | 273.9 / 333.7 | **3.8 / 56.8** |
| constrained | cold (pool 0) | 301.2 / 369.6 | **120.6 / 184.3** |

Constrained "before" is measured at `CENTRAID_WORKER_POOL_SIZE=0`, which is what the `conserve` preset exported at boot — the second source SB-pool deletes. Warm p99 is the first sample of each series (a keyless spare, so effectively cold); p50 is the steady state.

`fs.stat` calls per dispatch, counted by replacing `fs.promises.stat` and driving `Dispatcher.read` 12 times: **before 2, 2, 2, … (24 total); after 2, 0, 0, … (2 total)**. Command: `WT=$PWD node <count-stats> 12`.

#842 W4.1 ref-search p95 under composition, 3 runs of `tests/scale/composite-load.scale.test.ts`: **291.6 / 293.0 / 300.1 ms** against the unchanged 1000 ms ceiling (2026-08-28 band: 228.4 / 282.0 / 333.4). Unmoved — this lane is starved by the CPU the write lane takes, not by its own cost. The lane doing the taking did move: worst-lane (Notes create-note) p95 **828.1–1147.5 → 646.7–754.3 ms**.

Compiled output: 184 handlers, 500 KiB total, generated at build and never committed.

### Deleted / replaced

- `BUDGET_PRESETS.*.workerPoolSize` (all three) and the boot-time `process.env.CENTRAID_WORKER_POOL_SIZE` assignment in `build-gateway.ts` — replaced by `CONSTRAINED_WORKER_POOL_SIZE` / `DEFAULT_WORKER_POOL_SIZE` as the knob's own fallback. The pool is graded by class only now, so `performance` mode's 4 goes with the preset: 1 constrained, 2 standard, and a thread that comes back warm is worth more than a fourth cold spare.
- `WorkerPool.acquire()`'s single-use contract and the `worker.terminate()` in both parent runners' `finish` — replaced by `release`/`retire`.
- The `resolveHandlerFile` free function — replaced by `Dispatcher.resolveHandlerFile` over a cache plus `probeHandlerFile`.

### Decisions

- **The boot-time override is deleted for the DEFAULT, not for a member's own knob.** SB-pool names the whole `build-gateway.ts` assignment for deletion. `workerPoolSize` is also a shipped advanced resource knob (`packages/client/src/react/screens/ResourceAdvancedKnobs.tsx`) whose prefs value reaches the engine ONLY through that env export, and `formatHardwareProfileDetail` prints the resolved number. Deleting the line outright would have left a setting the UI shows and nothing reads. The export is therefore kept for `sources.workerPoolSize.source === "prefs"` alone; with the preset entries gone, the default has exactly one source and the two numbers can no longer disagree.
- **A run cap, because a fresh graph is not free.** Each run imports the handler under a per-run URL and Node's module registry never drops one, so a reused thread grows with its age. `MAX_RUNS_PER_WORKER = 64` retires a thread before `resourceLimits` would kill it mid-run and fail a member's request.
- **The worker reports the lane it installed.** The parent's seed/handler classification is only an acquire hint; the pool parks under the key the worker sends back, so a hint that ever diverged could cost a thread but could never leak a seed's filesystem grant into an ordinary handler's run.
- **Compiled handlers are generated, not committed.** Committing 184 esbuild bundles would have needed formatter and linter exclusions — repo-wide toolchain config this lane does not own — and would have put a build artifact in `files[]`, which `docs/traps/manifest-regeneration.md` bans. Generated + gitignored + declared as a turbo output matches `apps/web/public/centraid-worker-iroh.js`.

### Verification

```sh
bash $S/self-audit.sh 922 origin/claude/922-handlers   # gate tree 9731f8d9a950e6ef428afaf770e0a236b909ddb2; the landed tree differs from it by this line alone
bun run --cwd packages/server typecheck
bun run --cwd packages/server test
bun run --cwd packages/blueprints test
node node_modules/vitest/vitest.mjs run --config vitest.scale.config.ts tests/scale/composite-load.scale.test.ts
bash .governance/run.sh
```

Demonstrated red, both new isolation properties, seeded by reverting one line each:

- `scrubHandlerGlobals()` commented out → `sandbox-escape.test.ts` "no module state and no planted global survive into the next run" fails with `expected { seen: 1, stash: 2 } to strictly equal { seen: 1, stash: 1 }`.
- the per-run `?centraid-run=` URL reverted to the bare one → `handler-pool.test.ts` "a reused thread still gives every run a fresh handler graph and a clean global" fails with `expected { seen: 2, leak: 1, thread: 1 } to strictly equal { seen: 1, leak: 1, thread: 1 }`.

### Findings

- **`Dispatcher.invalidate()` has no caller anywhere in `packages/server/src`.** Its docstring says "Call when a version is activated", and nothing does; the mtime check was the only invalidation and is now the mtime check plus a 500 ms window. Publishing an app version writes into a STABLE `codeDir` (`worktree-store.ts#resolveActiveAppDir` returns `<activeMainDir>/apps/<id>`), so the cache cannot be dropped by key change either. Not fixed here — wiring the publish path to the dispatcher is a `serve/` seam this lane was not given.
- **Base drift in `packages/blueprints/manifest.json`.** `bun run build` regenerates it with two entries the checked-in copy lacks (`notes/queries/history.test.ts`, `docs/queries/history.test.ts`, both added by the branch's base commit `f782cfb6d`). Reverted rather than carried, per the wave's base-drift rule.
- **`compositeLoadFactor.ceilingWorstLaneP95Ms` (3500) is now loose** against an observed 646.7–754.3 ms. A tightening, not taken here: it is not this lane's budget and a flaky ceiling is worse than a loose one.
- **A pool full of one key never serves another.** `acquire` falls back to a fresh thread when no idle spare matches, and does not evict a mismatched spare to make room. Harmless while app seeds are rare and every automation lane is `automation-handler`, and visible the moment a household runs two lanes hot.
## lane 4a — commit path

Host for every number below: Linux 6.18.44 x86-64, 4 cores / 15 GB, container filesystem, `synchronous = FULL` unless a row says otherwise.

| file | change |
| --- | --- |
| `packages/server/src/routes/replica-intent-crash-replay.test.ts` | new: the commit path's crash boundaries, one case each |
| `packages/server/src/serve/group-commit-queue.ts` | idle queue commits on the next microtask; window sized from the measured fsync |
| `packages/server/src/serve/group-commit-queue.test.ts` | lone write, writes issued together, the window opening and closing again |
| `packages/server/src/serve/vault-plane.ts` | `storageFsyncMs` option feeding the window; fallback checkpoint reduced to one call |
| `packages/server/src/serve/vault-registry.ts` | passes `storageFsyncMs` to each plane |
| `packages/server/src/serve/build-gateway.ts` | passes the boot probe's `storageFsyncMs` to the registry |
| `packages/vault/src/db.ts` | `checkpointIfLargerThan`: the size test and a reader-safe PASSIVE checkpoint |
| `packages/vault/src/db.test.ts` | the threshold, the bound under a reading client, and why not TRUNCATE |
| `packages/vault/src/index.ts` | exports `VaultWalCheckpoint` |

**Deleted with replacement.** The `synchronous === "NORMAL" ? 8 : 5` group-commit window pair in `vault-plane.ts` — two numbers with no measurement behind either — replaced by `groupCommitWindowMs(storageFsyncMs)`. The inline `existsSync`/`statSync`/`gateway.checkpoint` block in the plane's WAL tick, replaced by `VaultDb.checkpointIfLargerThan`.

**Decisions.** B8's fold is refused with evidence rather than landed; see the verdict below.

### B8 — durable commits per offline intent

**Measured, not assumed.** The gate landed first: `packages/server/src/routes/replica-intent-crash-replay.test.ts` walks the offline-intent commit path boundary by boundary — crash before admission, crash after admission and before the canonical commit, crash after the canonical commit, and a clean commit redelivered — stopping the plane at each point, reopening the vault FROM DISK and resubmitting the same intent. Convergence is the assertion everywhere: one write, one terminal outcome, one receipt.

| number | before | after | provenance |
| --- | --- | --- | --- |
| durable commits (fsync+fdatasync) per offline intent | 3.00 | 3.00 (unchanged — see verdict) | `strace -f -e trace=fsync,fdatasync -c node <lane bench>` over `handleReplicaIntent` on a real `VaultPlane`, differenced at N=10/30/50 intents (527/587/647 calls) to cancel boot; Linux 6.18.44, 4 cores / 15 GB |

**Verdict: the B8 finding does not survive the code, and the fold is refused with reasons.** The ruling's "~4 durable commits per intent … the separate finalizations protect no crash property" is stale. Three commits are paid, and the invocation's own work is already **one** of them: `invokeBatchSettled` opens one `BEGIN IMMEDIATE` per arrival window, and the mutation, the `replica_invocation_commit` marker, the audit finalisation, the receipt row and the journal proof are savepoints inside it (#916). The other two are the intent-status protocol pair, and each is load-bearing:

- **Admission (`sending`), before dispatch.** The only durable carrier of the device-visible intent identity — device, app, action, payload hash — which no canonical transaction can reconstruct; the latch that makes a concurrent or redelivered duplicate conceal instead of dispatch; and the row a parked command transitions days later, which `transitionReplicaIntentOutcome` can only do to a row that exists.
- **The terminal outcome, after dispatch.** It is the **action's** outcome, not the invocation's: an action may span several canonical commits and may end contradicting one. `replica-intent-route.test.ts` › "a post-invoke denial is durable and does not re-dispatch on retry" pins exactly that — a durable `schedule_task` row and a `denied` intent. Publishing `executed` from inside the canonical transaction was implemented, and it failed that test plus "a later invocation finalization error replays the complete action exactly once"; both were kept, the fold was reverted.
- **The audit finalisation as a releasable savepoint, not a folded step, is a property too.** That second test pins a canonical write that is durable while its journal finalisation aborted, repaired on the next retry without re-entering the handler. Folding it into the mutation would turn that into a rollback of a write the member already made.

### B7 — the group-commit window opens only under concurrency

`GroupCommitQueue` no longer holds an arriving write when there is nothing in flight to share a commit with. An idle queue commits on the next **microtask**, which still gathers every write issued together without awaiting the last one into a single transaction at no added latency for any of them; the `windowMs` window is kept for the turn AFTER a batch larger than one has committed — concurrency observed, not assumed — and shuts again as soon as batches are back to one. `packages/server/src/serve/group-commit-queue.test.ts` pins both arms plus the closing.

The window's size is now the measured cost of the fsync it exists to share: `groupCommitWindowMs(storageFsyncMs)`, clamped to `[1, GROUP_COMMIT_MAX_WINDOW_MS]`, fed from the boot probe already published on `GatewayHardwareProfile.storageFsyncMs` (build-gateway → vault-registry → vault-plane). The `synchronous === "NORMAL" ? 8 : 5` pair it replaces was two numbers with no measurement behind either.

| number | before | after | provenance |
| --- | --- | --- | --- |
| lone write through the plane's queue, p50 | 12.29 ms | 7.33 ms | 200 sequential `plane.invoke("schedule.add_task")`, median of 3 runs (before 11.89/12.29/13.64, after 5.38/7.33/7.98); Linux 6.18.44, 4 cores / 15 GB, tmpfs-backed vault dir |
| one offline intent end to end, p50 | 14.59 ms | 9.33 ms | 50 intents through `handleReplicaIntent` on a real `VaultPlane`, median of 3 runs (before 14.52/14.59/15.44, after 9.14/9.33/10.25), same host |
| durable commits per offline intent | 3.00 | 3.00 | unchanged by B7 — the window never changed how many transactions a serial writer opens, only how long each waited |

### B6 — a size-based checkpoint that survives a reading client

`VaultDb.checkpointIfLargerThan(thresholdBytes)` in `packages/vault/src/db.ts` is the size test and the checkpoint in one place, independent of shipper state. It is **PASSIVE, never TRUNCATE**: with a client holding a read transaction, TRUNCATE does not merely fail — it blocks the gateway's own connection for the vault's 30 s `busy_timeout` and then changes nothing, while PASSIVE returns at once having backfilled every frame no reader still needs, so the WAL is reused rather than grown. `packages/vault/src/db.test.ts` pins the threshold, the bound under a reading client and that refusal. The vault-plane fallback is reduced to one call; when a shipper IS attached it stays the sole checkpointer (#408), and the 64 MiB fallback threshold stays the plane's to choose — gating it is lane 3b's.

| number | before | after | provenance |
| --- | --- | --- | --- |
| WAL bytes after 600 × 8 KiB writes with a client reading between rounds | 14.80 MB | 2.47 MB | `node` over `node:sqlite` with the vault's own pragmas (8 KiB pages, WAL, `wal_autocheckpoint=0`, `busy_timeout=30000`), 1 MiB threshold; same host |
| `wal_checkpoint` on the gateway's connection while a client holds a read transaction | 30,103.5 ms, `busy=1`, WAL unchanged (TRUNCATE) | 0.1 ms, `busy=0`, 901 frames backfilled (PASSIVE) | same script, 300 × 8 KiB writes before the call |

### Verification

```
bun run --cwd packages/vault test -- --run src/db.test.ts src/replica
bun run --cwd packages/server test -- --run src/serve/group-commit-queue.test.ts src/serve/vault-plane-wal.test.ts src/routes/replica-intent-route.test.ts src/routes/replica-intent-crash-replay.test.ts
bun run --cwd packages/vault typecheck && bun run --cwd packages/server typecheck
bun run --cwd packages/vault test && bun run --cwd packages/server test
bash .governance/run.sh
```

Full suites and governance ran green against tree `7156dad154a136f348b828a81d8704a0c0787705` (vault 1584 passed; server 3449 passed). Three server reds are this container, not the diff: `IS_SANDBOX=yes` is set in the environment (`acp/backends/acp/launch.test.ts`, two cases) and the `sqlite3` CLI is absent (`serve/gateway-db-lock.integration.test.ts`); no file in either is touched here.

Seeded reds, each run before its fix landed: dropping the journal-proof stamp fails three of the four crash-replay cases on an unfinished marker; making `checkpointIfLargerThan` skip the pragma grows the WAL 13.33 MB → 18.26 MB under the same workload and fails the bound.

**Findings.** (1) The B8 row in `docs/decisions.md` ("~4 durable commits per intent … no remaining crash property") is stale and should be superseded: the measured cost is 3, one of which is already the folded canonical transaction, and the other two are named above with the property each keeps. (2) `gateway.checkpoint` → `checkpointVault` is TRUNCATE on a connection with `busy_timeout = 30000`; any caller reaching it while a replica session reads stalls the gateway for 30 s. The fallback tick no longer does; the owner-facing `checkpoint` verb still can. (3) The intent-status pair could still share commits with the canonical writes if the route's two writes went through the group-commit queue — worth nothing until [#880](https://github.com/srikanth235/centraid/issues/880)'s one-intent-per-round-trip drain (A6) makes intents concurrent, so it is not landed here.

## Mega-lane A slice 1 — gateway plane 4b (A2/A4/A5 + dispatcher envelope)

| File | Change |
| --- | --- |
| `packages/vault/src/replica/snapshot.ts` | canonical entity shapes memoized per connection; `readReplicaRow`/`readReplicaRows` on cached statements; the snapshot's pinned epoch threaded to every row read |
| `packages/server/src/routes/replica-projection.ts` | projection made device-neutral: raw `replica.intent` entries ride the page as `intentEntries`, resolved by the new `applyReplicaIntentOutcomes` |
| `packages/server/src/routes/replica-fanout.ts` | `deviceId` removed from the memo key; the per-device outcome layer applied over the shared page |
| `packages/server/src/routes/replica-routes.ts` | the `/changes` pull layers outcomes on the same device-neutral projection |
| `packages/server/src/routes/replica-fanout.test.ts` | the deviceId divergence case replaced by the sharing claim it supersedes |
| `packages/server/src/engine/handlers/dispatcher.ts` | `recordTruncatedReads` aggregates every `ctx.vault.read` the gateway cut short into `ToolSuccessResult.truncatedReads` |

| Number | Before | After | Provenance |
| --- | --- | --- | --- |
| Prepared statements for 39 further identically-authorized devices, one commit generation | 390 | 0 | throwaway vitest in `packages/server/src/routes`, bootstrapped vault, `db.vault.prepare` counted across `hub.project` per device; container 4 cores / 15 GB |
| Projections per commit per household, N identically-authorized devices | N | 1 | same run; memo key no longer carries `deviceId` |
| `buildReplicaShapes` uncached prepares per projection (memo miss, warm) | 0 | 0 | same run, SQL texts captured: all 10 remaining come from `packages/vault/src/replica/change-log.ts` (9) and the grantee lookup (1) |
| `withReplicaSnapshot` + one `readReplicaRow` on the change path: prepares / `PRAGMA` | 4 / 1 | 2 / 0 | same run; the 2 remaining are the snapshot's own once-per-transaction log-state reads, not per row — `readReplicaRow` itself now issues 0 of each |

**SSE cap.** Not raised. `SSE_MAX_SUBSCRIBERS = 32` refuses an N=40 fan-out sample and no property of this change needs 40 concurrent subscribers, so the shipped claim is stated at **N = 32**: 31 further identically-authorized subscribers cost 0 projections and 0 prepared statements per commit. The measurement above ran 39 askers directly against the hub, above what the SSE plane will admit, which only makes the claim at 32 stronger.

**Deleted/replaced.** The per-device projection branch in `projectReplicaPage` is gone, replaced by `applyReplicaIntentOutcomes`; no second path remains. The fanout test's "a different `deviceId` is a different answer" case is deleted because this change makes it false — the structural claim (`batch.outcomes` absent and `intentEntries` unresolved on the shared page) plus the existing device-scoped outcome suites (`replica-routes.test.ts` "device-scoped outcomes through the snapshot cursor", `replica-intent-route.test.ts`) carry the correctness it stood for.

**Decisions.** Entity shapes are memoized for canonical entities only; the dynamic ext band may gain a table or column while the vault is open, so `parseExtLogical` entities keep re-reading `PRAGMA table_info`. Intent outcomes are read outside the projection's read transaction: outcome rows are keyed by (intent, device) and only move forward, so a later read returns a newer verdict, never an older one.

```
bun run --cwd packages/vault build && bun run --cwd packages/vault typecheck && bun run --cwd packages/server typecheck
bun run --cwd packages/vault test src/replica/snapshot.test.ts src/replica/change-log.test.ts
bun run --cwd packages/server test src/routes/replica-fanout.test.ts src/routes/replica-projection.test.ts src/routes/replica-routes.test.ts src/routes/replica-intent-route.test.ts src/routes/multiplex-replica-routes.test.ts src/engine/handlers/dispatcher.test.ts
```

**Findings.** (1) `currentReplicaLogState` and `readReplicaChanges` in `packages/vault/src/replica/change-log.ts` prepare uncached: 9 of the 10 statements a warm projection still compiles are theirs (`replica_meta` ×3, `MAX(seq)` ×3, the change window ×2, the presence probe ×1). Outside this lane's files; the same `prepared()` seam `snapshot.ts` now uses would take it to 0. (2) The grantee `SELECT DISTINCT` behind `buildReplicaShapes` is the tenth, and lives in `replica-grantees.ts`, which lane 1 owns.

**Doc debt.** `docs/decisions.md` SB-replica-sync (C2) describes the shared projection as keyed by authorization *and device*; it is now authorization-only with a per-device outcome layer — the row is not yet wrong about the product, but it under-describes the mechanism.

### Falsification
| Claim at risk | Throwaway check | Result |
| --- | --- | --- |
| A shared projection leaks one device's intent outcome to another | asserted on the memoized page itself that `batch.outcomes` is undefined and `intentEntries` is `[]`, then re-ran both device-scoped outcome suites | held — 43 route tests green, no outcome crosses devices |
| The memoized entity shape serves a stale column set after a schema change | ext entities excluded from the memo by `parseExtLogical`; re-ran `snapshot.test.ts` + `change-log.test.ts` (24 tests) and the ext-touching route suites | held — canonical shapes are fixed at open, ext still re-reads `PRAGMA table_info` every call |

## Mega-lane A slice 2 — wire (A1 payload frame)

| File | Change |
| --- | --- |
| `packages/server/src/routes/replica-routes.ts` | the SSE `change` frame carries `batch`, the page the hub already projected |
| `packages/client/src/vault-change-sse.ts` | `centraid:vault-batch` added to the platform-neutral message grammar; the batch stays opaque here |
| `packages/client/src/vault-change-feed.ts` | the batch is emitted BEFORE the per-entry nudges it covers |
| `apps/mobile/src/lib/replica/native-change-feed.ts` | the same emit on the React Native feed |
| `packages/client/src/replica/coordinator.ts` | a bounded pushed-batch queue; the feed sync applies the pushed batch for the current cursor and pulls only when there is none |
| `packages/client/src/replica/coordinator.test.ts` | one-hop apply with zero pulls, and the gap case that must still pull |

| Number | Before | After | Provenance |
| --- | --- | --- | --- |
| `/changes` pulls per change frame, happy path | 1 | 0 | `coordinator.test.ts` — the pre-existing "uses the shared feed as a pull trigger" case records one pulled cursor per nudge; the new "applies the batch the change frame carries" case asserts `pulls === 0` for the same commit |
| Projections per commit for a subscribed device | 2 | 1 | the pull re-projected the same window through `/changes`, outside the hub memo (slice 1's `applyReplicaIntentOutcomes` path); the frame reuses the hub's page |
| Round trips from commit to applied on a subscribed device | 2 (frame + pull) | 1 (frame) | same cases |

**Deleted/replaced.** The pull-on-every-nudge path is gone as the happy path — the losing side of the doorbell/payload contradiction (`SB-payload`). `pullChanges` itself is kept and still exercised: catch-up on `hasMore`, on reconnect, and on a cursor gap, with the gap case now asserted (a pushed batch whose `from` is not the local cursor is dropped and the pull runs). `changes` stays the doorbell on the frame so shape routing does not have to open the batch.

**Decisions.** No protocol-version bump: `batch` is an additive frame field a client that does not know it ignores, and `REPLICA_PROTOCOL_VERSION` fences the batch's own shape, which is unchanged. Bumping it would force every device to re-bootstrap for a strictly backward-compatible frame. The pushed-batch queue is capped at 32; past that the oldest are dropped and the pull path catches up, so a stalled applier cannot grow it without bound.

**Not reached in this slice.** A6 (the batched intent drain) and G1/G8 (pending-badge clearing on held row versions, `executed` carrying resulting row versions) are NOT in this diff — the lane's tool budget ran to the payload frame only. The 40-offline-edits and no-frame-in-which-a-row-is-neither-pending-nor-canonical boxes are therefore still open.

```
bun run --cwd packages/client typecheck && bun run --cwd packages/server typecheck && bun run --cwd apps/mobile typecheck
bun run --cwd packages/client test src/replica/coordinator.test.ts src/replica/convergence-properties.test.ts src/replica/app-convergence.contract.test.ts src/replica/multi-writer.contract.test.ts src/vault-change-feed.test.ts src/vault-change-sse.test.ts
bun run --cwd packages/server test src/routes/replica-routes.test.ts src/routes/replica-intent-route.test.ts
```

**Finding — the identity stamp fights `doc-integrity` on a date rollover.** The `agent-session-identity` pre-commit hook UPDATES the existing `date | harness | session` row in place when the same session commits on a later day. That row sits above the frozen prefix, so the trunk's copy of this receipt stops being a byte-prefix and every append-only audit fails on a line no author wrote. Restoring the date by hand does not survive: the hook re-stamps it on the next commit. Adding a second row for the new date would keep the prefix intact and is the fix, but it belongs to the hook, not to this lane.

### Falsification
| Claim at risk | Throwaway check | Result |
| --- | --- | --- |
| A pushed batch applied out of order or across a gap corrupts the replica | emitted a batch whose `from` is `epoch:7` at a replica sitting on `epoch:0` | held — the batch is dropped and `/changes` is pulled from `epoch:0`; `takePushedBatch` requires an exact `from` match and discards anything at or behind the cursor |
| The per-entry nudges that follow the batch re-trigger the pull it replaced | emitted the batch and then the `centraid:vault-change` for the same commit in the frame's own order | held — 0 pulls; the batch is consumed by the first feed-sync pass and the nudge's target is already reached |

## Mega-lane A slice 4 — overlay (G6 tripwire, G9 age, G2 probe, G5 states)

| File | Change |
| --- | --- |
| `packages/blueprints/src/pending-projection-tripwire.ts` + `.test.ts` | static tripwire: every destructive action projects a delete or a tombstone, or carries a written exclusion |
| `tests/claims.json` | law `pending-destructive-projection` registered to the tripwire test (a tightening) |
| `packages/blueprints/src/pending-parent-probe.test.ts` | the pending-parent child-write probe, as a measurement with a held number |
| `packages/blueprints/apps/_shared/pending-overlay.ts` | `pendingDelete`, `pendingTombstone`, `isPendingRowId`, `PENDING_OVERLAY_AGED_MS`, aged-badge copy, the two new verdicts |
| `packages/blueprints/apps/{docs,notes,locker,people,photos,tally}/pending-projection.ts` | 16 destructive actions fixed: 9 delete, 5 tombstone, 2 written exclusions |
| `packages/client/src/replica/{types,intents}.ts` | `conflict`, `conflict-base-missing`, `expired` are real intent states; `denied` carries a structured `denial` |
| `packages/client/src/replica/intent-verdict.ts` | the outcome-to-state policy and the structured denial, extracted so `intents.ts` stays under the file-size floor |
| `apps/mobile/src/lib/replica/{sqlite-intent-store,native-session,multi-vault-session}.ts`, `src/kit/replica/pending-copy.ts` | the same vocabulary on the phone, and member-facing words for it |

| Number | Before | After | Provenance |
| --- | --- | --- | --- |
| Destructive actions across the eight apps projecting neither a delete nor a tombstone | 16 | 0 | `pending-projection-tripwire.test.ts` against the real tree; the 16 are listed in the demonstrated red below |
| Destructive actions judged, by app (actions / destructive / delete / tombstone / excluded) | — | agenda 7/1/0/0/1 · docs 15/3/1/1/1 · locker 16/3/2/1/0 · notes 15/4/1/1/2 · people 28/3/1/0/2 · photos 18/5/2/1/2 · tally 21/3/1/1/1 · tasks 11/3/1/0/2 | asserted in the tripwire test, not printed, so a destructive action quietly becoming an exclusion moves a number |
| Pending-parent child-write edges (an action input that can carry a parent id a projection mints) | — | **66** — docs 11, notes 9, people 16, tally 20, tasks 10 | `pending-parent-probe.test.ts`, inline snapshot over the eight `app.json` + `pending-projection.ts` pairs |
| Outbox schema changes for the three new verdicts | — | 0 | `sqlite-intent-store.test.ts` compares `sqlite_master` DDL before and after storing all three; `state` is unconstrained TEXT, so this is a vocabulary widening, not a migration |

**Demonstrated red.** The tripwire's first run against the real tree failed with 16 findings, every one a real defect: docs `trash`, `delete-folder`; locker `trash-item`, `purge-item`, `remove-field`; notes `delete-notebook`, `delete-note`; people `trash-person`, `delete-list`; photos `delete-asset`, `purge-asset`, `delete-album`, `remove-from-album`; tally `delete-expense`, `remove-group-member`, `delete-group`. Each projected a plain patch, so the row stayed on screen while the delete was queued. Two further reds followed from the tripwire's own parsing — a comma inside a `//` comment split an entry, and `pendingTombstone` was not recognized as a tombstone — both fixed and both now covered.

**Deleted/replaced.** The "conflict is a wire outcome, not a persisted outbox state" collapse in `applyOutcomes` is gone, with its comment; so is the `intent.conflict ? "conflict" : intent.state` re-derivation in `decoratePendingMutation` and in the phone's attention list. `pendingItemAction` no longer serves locker's three destructive actions.

**Decisions.** Three exclusions are structural and written: people `trash-person` (the trashed row is `people.profile`, keyed by `profile_id`; the payload carries only `party_id`, and the `core.party` row this app overlays has no tombstone column), photos `remove-from-album` (`core.collection_entry`'s key is a surrogate `entry_id`), tally `remove-group-member` (the row is `social.circle_member`, which Tally's manifest does not scope). `cancel-event` is deliberately NOT destructive — it sets a status and the event stays on the calendar. `conflict-base-missing` is discardable but never retryable: a retry would re-create rather than reconcile.

## User impact
A destructive change now looks destructive the moment it is made: tapping delete, trash or purge removes the row (or greys it out via its tombstone) instead of leaving it in place wearing a badge, on all six apps that had the defect. A queued change older than 24 hours says which day it was saved on this device — and nothing about that number expires it; only the sentence changes. A conflict now says whether the row changed elsewhere or is gone altogether, and an expiry says it waited too long, instead of all three reading "could not apply".

First-run: nothing new appears on a first run — every change here is to what an existing pending row says and does, and a fresh vault has no pending rows.

```
bun run --cwd packages/blueprints typecheck && bun run --cwd packages/client typecheck && bun run --cwd apps/mobile typecheck
bun run --cwd packages/blueprints test
bun run --cwd packages/client test src/replica
bun run --cwd apps/mobile test src/lib/replica
```

**Findings.** (1) **G3 (the pending sidecar) is not in this diff and cannot be, from this lane's file set.** Rows carry nine `__centraid_pending_*` columns today; collapsing them to one key plus a per-result sidecar means changing `readPendingOverlay`'s signature, which is called from `packages/client/src/replica/query.ts`, `packages/client/src/react/blueprints/inlineQueryCtx.ts`, `packages/blueprints/apps/{agenda,tasks}/app-root.tsx`, `apps/tasks/components/TaskRow.tsx`, `apps/locker/{components/Rows.tsx,format.ts}`, `apps/tally/queries/dashboard.ts`, `apps/photos/components/FaceReview.tsx` and `apps/_shared/PendingWriteActions.tsx` — none of them in this brief, and a compatibility shim beside the old reader would be exactly the dual path the standards forbid. It wants its own slice. (2) People's `trash-person` is the one destructive action on the eight apps whose overlay cannot hide the row, because the app anchors pending state on `core.party` while the vault tombstones `people.profile`; closing it needs the profile id at enqueue time. (3) `check:ui-receipt` is expected to fire on this diff and demand a screenshot from a changed e2e harness; no screenshot is fabricated here — the `## User impact` and `First-run:` halves are above.

### Falsification
| Claim at risk | Throwaway check | Result |
| --- | --- | --- |
| The tripwire passes because it silently reads nothing, not because the apps are clean | asserted the scanned app list, a non-zero destructive total, and that every destructive action of every app is accounted for as delete + tombstone + excluded; then re-seeded a plain-patch destructive action, an exclusion with no reason, and an action the map never mentions | held — all three seed a finding, and the two parsing bugs that DID make it read nothing were both caught by the real tree, not by the synthetic cases |
| Widening the intent vocabulary breaks a phone that already holds queued writes | stored all three new verdicts through the real SQLite store and compared `sqlite_master`'s DDL for `replica_intent_outbox` before and after | held — byte-identical DDL; the column is unconstrained TEXT and nothing was rebuilt |

## Mega-lane A slice 3 — client engine (C1–C5 + E1)

| File | Change |
| --- | --- |
| `packages/client/src/replica/outbox-mirror.ts` + `.test.ts` | the overlay in memory: an empty outbox costs no IndexedDB work per read, and every non-read invalidates by default |
| `packages/client/src/replica/{intents,intent-verdict}.ts` | `pending()` reads the mirror; the state policy moved beside the verdict it belongs to |
| `packages/client/src/replica/store-core.ts` | per-seat `synchronous`; snapshot writes skip the guard and the two search deletes; `INSERT OR REPLACE` for the index entry; schema and order-census memos; the ordering index; off-thread `bootstrapPageAsync`/`applyChangesAsync` |
| `packages/client/src/replica/read-plan.ts` | the order guards leave the paging statement for their own census |
| `packages/client/src/replica/wasm-sqlite-driver.ts` | `synchronous=NORMAL` on web and desktop; a prepared-statement cache |
| `packages/client/src/replica/windowed-bootstrap.ts` | page N+1 is fetched while page N applies |
| `apps/mobile/src/lib/replica/{op-sqlite,node-sqlite}-driver.ts` | `runBatchAsync`: a write batch on the driver's own thread |
| `apps/mobile/src/lib/replica/{native-replica-store,multi-vault-reader}.ts` | the phone's heavy paths take the off-thread form; the mounted reader runs the order census too |
| `packages/blueprints/apps/tasks/app-root.tsx` | the completion waiter waits on the change push, not a 50 ms clock |

Also in this diff, by full path: `packages/client/src/replica/intents.ts`, `packages/client/src/replica/outbox-mirror.test.ts`, `packages/client/src/replica/store-core-storage-lifecycle.test.ts`, `packages/client/src/replica/windowed-bootstrap.test.ts`, `apps/mobile/src/lib/replica/node-sqlite-driver.ts`, `apps/mobile/src/lib/replica/bootstrap-statement-budget.test.ts`, `apps/mobile/src/lib/replica/ordered-read-plan.test.ts`, `apps/mobile/src/lib/replica/off-thread-apply.test.ts`, `apps/mobile/src/lib/replica/reader-statement-budget.test.ts`.

| Number | Before | After | Provenance |
| --- | --- | --- | --- |
| Outbox reads per replica read, empty outbox (after one warm-up) | 1 IndexedDB `list` (9 indexed `getAll`s) | 0 | `outbox-mirror.test.ts`, counting store calls |
| Bootstrap statements per row | 5.01 | 1.01 | `bootstrap-statement-budget.test.ts`, 500 rows through the store core on `node:sqlite` with a statement cache |
| Search-index deletes issued by a bootstrap | one per row | 0 | `store-core-storage-lifecycle.test.ts` |
| Warm ordered read, 50k-row library, `LIMIT 50` | 131 ms, `USE TEMP B-TREE FOR ORDER BY` | 1 ms, `SEARCH … USING INDEX replica_row_ord_…` with no temp b-tree | throwaway vitest over `ReplicaSqliteStore` on `node:sqlite`, 50 000 `knowledge.note` rows; container 4 cores / 15 GB. Cold read after a write is ~104 ms (the census, once per write batch) |
| Order-guard censuses per ordered read | 4 window aggregates inside the page | 1 statement, cached until the next write | `ordered-read-plan.test.ts`; `reader-statement-budget.test.ts` classifies it and holds the unchanged 148-statement cold-start ceiling |
| Longest JS-thread block, 5 000-row bootstrap page | 33 ms | 13 ms (statement recording only; SQLite runs off-thread) | throwaway sampler over `NativeReplicaStore`, sync driver vs `runBatchAsync` driver |
| Bootstrap pages fetched while a page applies | 0 | 1 | `windowed-bootstrap.test.ts` — page 2 applies with page 3's request already made |
| Screen re-reads per second while a repeating task settles | 20 | 0 (one per change push) | the 50 ms poll in `tasks/app-root.tsx` is deleted |

**Deleted/replaced.** The 50 ms pending poll and its `pause()`; the per-row version SELECT and the two search-index deletes on both bootstrap paths; the `DELETE`+`INSERT` pair for a search entry (one `INSERT OR REPLACE`); the `max(...) OVER ()` order guards in the paging statement; the per-row schema lookup. Three tests asserting the superseded shapes were rewritten to the stronger claim they supersede: the bootstrap's search deletes, the home tile's window columns, and the reader's statement shape.

**Decisions.** `synchronous=NORMAL` lands on the WASM seat only (ruling SB-replica-sync); mobile stays `FULL` because B4's phone fsync number does not exist yet, and the driver's absent declaration means `FULL` so a new driver gets the safe answer. The `journal_mode=DELETE` seam was re-judged as C2 asks: nothing depends on DELETE — `op-sqlite-driver.ts`'s own comment describes a reader's SHARED lock BLOCKING the writer under it, which is a cost of DELETE, not a property WAL would break — so the citation is not a justification, and the move to WAL stays gated on B4's number rather than on this seam. The ordering index is created lazily, on the writer's handle, capped at 64 (entity, column, direction, tie-break) combinations.

```
bun run --cwd packages/client typecheck && bun run --cwd packages/blueprints typecheck && bun run --cwd apps/mobile typecheck
bun run --cwd packages/client test
bun run --cwd packages/blueprints test
bun run --cwd apps/mobile test
```

**Findings.** (1) The order census is still one scan of the entity per write batch; the design that would remove it is two index probes (`ORDER BY <expr>` ASC and DESC, `LIMIT 1`) reading the type at each end of the ordering index, which is exact for the straddle guard because the index orders by type class. Not landed here: it changes what the guard PROVES, and that wants its own red-first slice. (2) `packages/blueprints/apps/tasks/app-root.tsx` and `apps/mobile/src/lib/replica/multi-vault-reader.ts` are outside this brief's file set; the first is where the named 50 ms poll lives, the second had to run the census or the mounted reader would have lost the escalation the paging statement used to carry. Both are declared here rather than left silent. (3) C4's "≤ 1 screen re-read per write, counter-verified" is NOT proven in this diff — the poll is gone and the push is the only trigger, but no counter test spans the eight apps' seats; it wants a harness this lane does not have.

### Falsification
| Claim at risk | Throwaway check | Result |
| --- | --- | --- |
| Skipping the version guard on a bootstrap write lets an older row overwrite a newer one | traced both bootstrap paths: single-shot clears every table first, and a windowed page replays the same rows at the same versions from the cursor its walk is pinned to; ran the bootstrap-walk, resume and convergence suites | held — 268 client and 276 mobile files green, including the resumed-walk cases |
| Moving the order guards out of the paging statement loses the escalation | ran the mounted-reader pushdown cases, which are the ones that escalate; they went RED first, which is how the missing census in `multi-vault-reader.ts` was found, and green after | held — the escalation is now proven on both readers, and a straddling value still refuses after the cache is warm |

**Full paths named for coverage** (this lane's brace-expanded rows above, spelled out): `packages/blueprints/apps/docs/pending-projection.ts`, `packages/blueprints/apps/notes/pending-projection.ts`, `packages/blueprints/apps/locker/pending-projection.ts`, `packages/blueprints/apps/people/pending-projection.ts`, `packages/blueprints/apps/photos/pending-projection.ts`, `packages/blueprints/apps/tally/pending-projection.ts`, `packages/blueprints/apps/_shared/pending-overlay.test.ts`, `packages/blueprints/apps/_shared/pending-overlay-presentation.test.ts`, `packages/blueprints/src/pending-projection-tripwire.test.ts`, `packages/client/src/replica/intents.contract.test.ts`, `apps/mobile/src/lib/replica/sqlite-intent-store.test.ts`, `apps/mobile/src/kit/replica/pending-copy.ts`.

## Mega-lane A slice 5 — G2 client-minted row ids (red-first)

| File | Change |
| --- | --- |
| `packages/client/src/replica/offline-parent-child.test.ts` | the red-first case: an offline child write on an offline-created parent |
| `packages/blueprints/apps/_shared/pending-overlay.ts` | `stablePendingRowId` mints a canonical UUIDv8 derived from (intent, suffix); a projection may declare `input` — the ids the write must carry; `isPendingRowId` and the `pending:` prefix are gone |
| `packages/blueprints/apps/tasks/pending-projection.ts` | `add`, `save-project`, `save-section` declare their minted id on the input, and `add` REUSES an id the write already carries |
| `packages/blueprints/apps/tasks/app.json`, `packages/blueprints/apps/tasks/actions/add.ts` | the action accepts and forwards `task_id` |
| `packages/vault/src/commands/tasks.ts` | `schedule.add_task` honours a seat-minted `task_id` and REFUSES one it already holds |
| `packages/client/src/react/blueprints/centraid-inline.ts`, `apps/mobile/src/lib/replica/native-session.ts` | both write doors merge the minted ids into the input they send |
| `packages/client/src/replica/{intents,coordinator,shell-session}.ts` | `pendingIntentForInput` asks the OUTBOX which queued intent minted the row a write names; `SYNTHETIC_PENDING_ROW` and the revision-identity probe are deleted |
| `packages/blueprints/apps/tasks/writes.ts`, `packages/blueprints/apps/_shared/{share-kit,grant-audiences}.ts` | `isPendingTaskId`, `landedTask` and `isPendingPartyId` are gone; the pending fact is the row's overlay on both seats |

| Number | Before | After | Provenance |
| --- | --- | --- | --- |
| Offline child writes landing on the parent the member saw | 0 (the child named `pending:<intent>:project`, which no row ever had) | 1 of 1 | `offline-parent-child.test.ts`, red then green (below) |
| Row-id spellings that mean "not yet real" | 1 (`pending:` + 3 predicates over it) | 0 | `grep -rn '"pending:' packages apps` finds only ordinary user text in tests |
| Pending-parent child-write edges | 66 | 67 | `pending-parent-probe.test.ts` — Tasks' `add` now accepts the id its own projection mints, which is the point of the count |
| Screen re-reads waiting for a completion to "land" | a 15 s wait loop | 0 | the waiter is deleted outright: the id is the row's id from the moment it is minted |

**Demonstrated red, then green.**

```
# RED — before the projection minted into the write:
bun run --cwd packages/client test src/replica/offline-parent-child.test.ts
#   × lands on reconnect naming the row the seat already showed
#     AssertionError: expected undefined to be 'pending:intent-project:project'
#   × the origin refuses a row id it already holds rather than merging into it
#     AssertionError: expected 'executed' to be 'denied'
# GREEN — after:
bun run --cwd packages/client test src/replica/offline-parent-child.test.ts   # 2 passed
bun run --cwd packages/vault test src/commands/tasks.test.ts                  # 21 passed
bun run --cwd packages/blueprints test && bun run --cwd packages/client test
bun run --cwd packages/vault test && bun run --cwd apps/mobile test
```

**Deleted/replaced.** `PENDING_ROW_ID_PREFIX` and the `pending:<intent>:<suffix>` grammar; `SYNTHETIC_PENDING_ROW`; `REVISION_IDENTITY_PROBE` and `pendingIntentIdFromInput`, replaced by `IntentQueue.pendingIntentForInput`, an outbox lookup by the row id the write names; `isPendingRowId`; `isPendingTaskId` and `landedTask` (title-matching a row whose id would never become canonical), replaced by `boardTask`, an id lookup; `isPendingPartyId`, replaced by the destination's own `pending` flag, which web now reads off the row's overlay exactly as native already did; the 15-second completion waiter in the Tasks seat, which existed only to wait for an id that no longer changes.

**Decisions.** Ids are UUIDv8 ("custom" per RFC 9562) derived deterministically from (intent id, suffix) — deterministic because a replayed intent must project the SAME row rather than a second one, canonical in shape because the column holds row ids. A revision reuses the id its predecessor minted rather than minting a new one, so a child write filed against the first is still correct after an edit. The origin REFUSES a duplicate rather than merging: a seat-minted id the vault already holds is a replay or a collision, never an instruction to overwrite.

## User impact
Work done on a plane holds together. Create a project and file a task in it with no signal, and on reconnect the task is in that project — before this, the task landed pointing at a project id that never existed. Completing a task you just added no longer waits up to fifteen seconds for the vault to "land" it, and no longer refuses with "This task has not landed yet": the row you are looking at is the row the vault will hold.

First-run: nothing new appears on a first run; every change here is to what an id means and when a queued row can be acted on.

**Findings.** (1) Only TASKS carries its minted ids through to the origin in this diff. The other seven apps mint canonical ids and show them, but their manifests and commands do not yet accept them, so their offline children still name a row the origin will not create: `notes` (note, body, notebook), `docs` (document, content, folder), `photos` (album), `tally` (expense, payer, split, settlement, party, friend), `people` (party, profile, list), `agenda` (event), `locker` (item). Each needs the same three edits — the projection's `input`, the manifest property, the command's honour-or-refuse — and the probe's 67 edges are the map. (2) `packages/vault/src/commands/tasks.ts`, `packages/blueprints/apps/tasks/{app.json,actions/add.ts}` and both write doors are outside this brief's file sets; the box names the behaviour they carry, so they are declared here rather than left silent.

### Falsification
| Claim at risk | Throwaway check | Result |
| --- | --- | --- |
| A seat that mints its own ids lets one device overwrite another's row | added the duplicate case to the vault suite: the second `add_task` with an id the vault already holds must not execute | held — the `task_id_is_free` precondition refuses it, and the first row is untouched |
| Deleting the `pending:` grammar loses the "this row is not real yet" signal the seats depend on | traced every reader of the grammar — Tasks' completion, Share's audience filter, the inline party guard — and moved each to the row's own overlay or to an id lookup; ran all four package suites | held — 212 blueprints, 269 client, 202 vault and 276 mobile files green, and Share still refuses to offer a person whose row is queued |

**Full paths named for coverage** (slice 5's brace-expanded rows, spelled out): `packages/blueprints/apps/_shared/share-kit.ts`, `packages/blueprints/apps/_shared/grant-audiences.ts`, `packages/blueprints/apps/_shared/grant-audiences.test.ts`, `packages/blueprints/apps/_shared/pending-overlay-law.test.ts`, `packages/blueprints/apps/tasks/writes.test.ts`, `packages/blueprints/src/share-kit.test.ts`, `packages/client/src/replica/shell-session.ts`, `packages/client/src/replica/shell-session.test.ts`, `packages/client/src/react/blueprints/centraid-inline.test.ts`, `packages/client/src/react/blueprints/inlineQueryCtx.test.ts`, `packages/vault/src/commands/tasks.test.ts`.

Also in slice 5: `packages/vault/src/commands/minted-id.ts` — the honour-or-refuse pair (input property + duplicate precondition) extracted so a creating command cannot declare one half without the other, and so the seven remaining apps have a seam to reach for.

### Audit
2026-09-04, fresh-context verifier, worktree at `7bbbb5687` / tree `48c8e9ad5d4155255221552230465be38be0b1c0`.

**Verdict: REFUTED.**

1. `packages/vault/src/commands/schedule-projects.ts:32,92` (`preconditions: []`) → this slice newly SENDS the minted `project_id`/`section_id` (`pending-projection.ts` `input:` + both write doors), and both commands take them into `INSERT … ON CONFLICT DO UPDATE` with no `mintedIdIsFree`. Two of Tasks' own three minted ids are honoured but never refused. Driven against the real gateway: a second `schedule.save_project` with the same id returns `executed` and the row's name becomes `OVERWRITTEN` — one row, merged. The section's **Decisions** ("The origin REFUSES a duplicate rather than merging") and `minted-id.ts`'s header ("a command that declares one without the other is the bug this module exists to make impossible to write by accident") assert a property these two do not have, and **Findings** names only the other seven apps. Fix: name the exclusion in Findings and beside the seam (both commands are also the EDIT path, so `mintedIdIsFree` as written cannot simply be added), or split create from edit.
2. `packages/vault/src/commands/minted-id.ts:19-22` → `MINTED_ID_PROPERTY` is `{type:"string",minLength:1}`, so the origin honours ANY non-empty string as a primary key. Against the real gateway, `schedule.add_task` executed and stored `task_id: "  "`, `task_id: "'; DROP TABLE schedule_task; --"` and a 5 000-character id verbatim (no injection — binding is parameterized — but the row id is now caller-controlled with no shape). The Decisions claim ids are "canonical in shape because the column holds row ids"; nothing enforces it, and this is the seam the seven remaining apps will copy. Fix: give the property a UUID `pattern` (and a `maxLength`), with a test.
3. Verification block quotes **no tree hash**, so the gate-trust rule does not apply and the suites were replayed in full (below).
4. `packages/blueprints/apps/tasks/app.json` → machine re-serialized: 115 changed lines for 4 of substance, and the em dash in `description` became a `\u2014` escape, leaving tasks the only one of the eight manifests with `\u` escapes and one-property-per-line objects. The section describes the file as "the action accepts and forwards `task_id`". Fix: restore the original formatting, keep only the `task_id` property.

**Verified.** Red-first reproduces exactly: reverting the slice's sources onto `1fdf32ba2` and keeping the new test gives `× lands on reconnect naming the row the seat already showed / expected undefined to be 'pending:intent-project:project'` and `× the origin refuses a row id it already holds / expected 'executed' to be 'denied'`; at `7bbbb5687`, 2 passed. The `pending:` grammar is gone from source — no `PENDING_ROW_ID_PREFIX`, `SYNTHETIC_PENDING_ROW`, `REVISION_IDENTITY_PROBE`, `pendingIntentIdFromInput`, `isPendingRowId`, `isPendingTaskId`, `isPendingPartyId` or `landedTask` outside receipts/CHANGELOG/`docs/decisions.md`; remaining `pending:` strings are inert test fixtures and prose. The seven-app gap is stated honestly. `IntentQueue.pendingIntentForInput`'s `store.list()` is bounded — settled intents are deleted from the store (`intent-store.ts:205`).

**Gates run** (this worktree, under `flock`). `.governance/run.sh` → 22/22 pass. `bun run typecheck` → pass. `bun run --cwd packages/blueprints test` → 212 files, 6643 passed. `bun run --cwd packages/client test` → 269 files, 2448 passed. `bun run --cwd packages/vault test` → 202 files, 1585 passed. `bun run --cwd apps/mobile test` → 276 files, 2380 passed. `self-audit.sh 922` reports one receipt-prefix FAIL that predates this slice (the pre-commit hook restamped the `### Identifiers` date at line 168 in `0940a7922`); slice 5's own receipt edit is a single append-only hunk and the `doc-integrity` directive passes.

## Mega-lane A slice 5 — verifier round 1 corrections

The audit at `44b5384f4` was right on all four counts. What changed, and what the earlier section claimed that was not true:

| Finding | Correction |
| --- | --- |
| `save_project`/`save_section` honour a minted id and never refuse a repeat | **The behaviour is correct and the claim was wrong.** Both commands are UPSERTS — one command makes the row and renames it — so a create and a rename arrive carrying the same id and are indistinguishable at the origin; `mintedIdIsFree` would refuse every rename. The exclusion is now written beside both commands and in `minted-id.ts`'s header, with the consequence stated plainly: a second save with the same id overwrites the row's fields. `packages/vault/src/commands/schedule-organize.test.ts` pins that (executed, renamed, still one row) so the difference from `add_task` is asserted, not assumed. |
| `MINTED_ID_PROPERTY` honoured any non-empty string as a primary key | `minLength`/`maxLength` 36 and a UUID `pattern` covering the seat's v8 and `ctx.newId()`'s v7. `tasks.test.ts` refuses whitespace, a SQL-shaped string, a 5,000-character id and a zero version nibble, and asserts the table is left empty. The refused-duplicate case now also asserts the first row is untouched. |
| No tree hash in the verification block | Quoted below, and in the report. |
| `app.json` machine re-serialized (115 lines, `\u` escapes) | Restored to the file's own style; the diff against `1fdf32ba2` is now the four-line `task_id` property and nothing else. |

**The claim, corrected.** Slice 5's Decisions said "the origin REFUSES a duplicate rather than merging". True of `schedule.add_task`, which is only ever a create. NOT true of `schedule.save_project` and `schedule.save_section`, which are upserts and deliberately merge. `minted-id.ts` now says which kind of command each half is for.

```
# The four suites and governance below ran against tree
# 2b004f3b6946ab8d906f2a4e03899ab1ca505db0, which is the tree of commit
# a41fb44cc exactly. Only this corrected hash was written after that run, so
# the landed tree differs from it by these four lines and nothing else.
bun run --cwd packages/vault test src/commands/tasks.test.ts            # 22 passed
bun run --cwd packages/vault test src/commands/schedule-organize.test.ts # 7 passed
bun run --cwd packages/vault test && bun run --cwd packages/blueprints test
bun run --cwd packages/client test && bun run --cwd apps/mobile test
bash .governance/run.sh
```

**Findings.** (1) **Splitting create from edit for `save_project`/`save_section` is not done here.** It is the change that would let those two refuse a duplicate minted id, and it needs a new action on the Tasks manifest plus a seat change — outside this fix's two files, and mega-lane E is working from this head on `claude/922-reads`. Named so it is not mistaken for an oversight. (2) The seven remaining apps still do not carry their minted ids to the origin; lane E owns generalising `minted-id.ts` to them, and `MINTED_ID_PROPERTY` now carries the shape they will inherit.

### Audit — round 2
2026-09-04, same verifier, worktree at `c7e30bcad` / tree `f0fb989e68e385e4ee7cabfce0e0dc90a4be619c`; delta re-checked is `976ceff47..c7e30bcad`.

**Verdict: PASS.**

- **Finding 1 (`save_project`/`save_section` never refuse) — resolved as documentation, and the reasoning holds.** Both commands are the rename path as well as the create path, and the id is the key the rename addresses, so `mintedIdIsFree` would refuse every rename; refusing would need a create/edit split. The exclusion is now stated at `schedule-projects.ts:10-20` and in `minted-id.ts`'s header with the overwrite consequence spelled out, `schedule-organize.test.ts:339-365` pins it (executed, renamed, one row), and the split is carried as an open finding rather than left implicit. `bun run --cwd packages/vault test src/commands/tasks.test.ts src/commands/schedule-organize.test.ts` → 2 files, 29 passed.
- **Finding 2 (any non-empty string was a primary key) — resolved, and enforcement verified against the real gateway.** `MINTED_ID_PROPERTY` is now 36/36 plus `UUID_PATTERN`. Throwaway probe: the four shapes I demonstrated in round 1 are refused, and so are five near misses — uppercase hex, variant nibble `c`, version `9`, a trailing space, an embedded space — each leaving `schedule_task` empty; the JSON-Schema `pattern` is genuinely applied, not ignored. The other half also holds: `stablePendingRowId` output for four suffixes is accepted end to end and echoed back as `output.task_id`, and 200 000 minted ids match the pattern with no rejection and no collision.
- **Finding 3 (no tree hash) — resolved.** The block quotes `2b004f3b6946ab8d906f2a4e03899ab1ca505db0`, which is commit `a41fb44cc`'s tree. That is one receipt-only commit behind the landed head, so I replayed rather than trusted: `.governance/run.sh` → 22/22, `bun run typecheck` → pass, and the touched suites above plus `offline-parent-child.test.ts` (2 passed) and `pending-overlay-law.test.ts` + `pending-parent-probe.test.ts` (28 passed), all on tree `f0fb989e6`.
- **Finding 4 (`app.json` re-serialized) — resolved.** `git diff 0697efb38 c7e30bcad -- packages/blueprints/apps/tasks/app.json` is the four-line `task_id` property and nothing else; the em dash is intact and the file carries no `\u` escapes.

**Two nits, not findings.** The correction section cites `1fdf32ba2` for the `app.json` comparison — a pre-rebase hash that is no longer on the branch (`0697efb38` now). The Tasks manifest keeps `task_id` at `minLength: 1` while the command enforces the UUID shape; the origin is the right enforcement point, so this is only worth knowing when lane E copies the seam to the other seven apps.
