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
  - a rulings table with nine ids — `SB-payload` (SSE payload frame wins; the doorbell-only pull-on-every-nudge path is deleted in wave 3; property: one hop from commit to a subscribed device), `SB-text` (per-entity declared text ceiling, text rides in full, only blob/binary stays deferred; property: a note the phone cannot show offline defeats the replica), `SB-pool` (`CONSTRAINED_WORKER_POOL_SIZE = 1` in `packages/server/src/engine/handlers/worker-pool.ts` is the single source; the `conserve` preset's `workerPoolSize: 0` and the `build-gateway.ts` boot override are deleted in wave 2), `SB-reuse` (fresh realm per run inside a reused thread; the property #404 buys is the thread boundary plus a hard timeout), `SB-tally` (the "one balance engine" ruling superseded — the engine is the pure module pair both seats import), `SB-replica-sync` (replica at `synchronous=NORMAL` on every seat, outbox at `FULL`, `journal_mode=DELETE` held on the phone by the attached second op-sqlite reader handle and re-judged on web), `SB-session` (replica sessions live as long as the tab/window, closing on hide or memory pressure), `SB-instrument` (F1 absorbed into #927's gateway trace slice; F2/F4 closed as superseded; F3/F5 plus #927's work counters are the interim), and `SB-loader` left **explicitly open** for the wave-1 Metro-loader spike to adopt or refuse with its reason. Every row names the property it keeps or the finding it files, and the wave that lands the code.
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

## Session

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-09-03 | claude-code | 60f9e86b-149f-5fc9-84c0-f2160b6b6f3c |
